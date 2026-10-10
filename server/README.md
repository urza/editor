# vrtti sync server

A thin sync backend for the vrtti editor. ASP.NET Core minimal API on .NET 10, SQLite,
raw SQL. The server is content-agnostic. It stores opaque content and an opaque `meta`
object, and it never looks inside them.

Every push appends a revision row. The newest row of a document is the current version.
See `architecture.md`, sections 3 and 13.5.

## Run it locally

```sh
export VRTTI_TOKEN=$(openssl rand -hex 32)
dotnet run --project Vrtti.Server
```

The database goes to `./data/vrtti.db`. The directory is created if it is missing.

Tests:

```sh
dotnet test
```

## Run it in Docker

Every push to `main` that touches `server/` builds the image and publishes it to GitHub
Container Registry as `ghcr.io/urza/vrtti-server`. The workflow is
`.github/workflows/server-image.yml`. It runs `dotnet test` first, so `latest` only ever
points at a commit whose tests passed. Tags:

- `latest` - the newest build of `main`.
- `sha-<short commit>` - one exact build, for a rollback or a pin.

The image is multi-arch, `linux/amd64` and `linux/arm64`, so the same tag runs on a
normal VPS and on an ARM box.

Generate the token once and keep it; the app needs the same value.

```sh
export VRTTI_TOKEN=$(openssl rand -hex 32); echo "$VRTTI_TOKEN"
docker run -d --name vrtti \
  --restart unless-stopped \
  -p 8080:8080 \
  -v vrtti-data:/data \
  -e VRTTI_TOKEN \
  -e VRTTI_ORIGINS=https://urza.github.io \
  ghcr.io/urza/vrtti-server:latest
```

A new GHCR package starts private. Open the package page on GitHub once and set the
visibility to public, or log the host in before the pull:

```sh
echo "$GHCR_TOKEN" | docker login ghcr.io -u urza --password-stdin
```

`GHCR_TOKEN` is a personal access token with the `read:packages` scope.

Update to a newer build. The named volume keeps the database, so the new container finds
the same documents:

```sh
docker pull ghcr.io/urza/vrtti-server:latest
docker rm -f vrtti
# then the same docker run command again
```

To build the image yourself instead of pulling it, from the repository root:

```sh
docker build -t vrtti-server server/
```

## HTTPS

The server speaks plain HTTP. TLS is the reverse proxy's job. A Caddyfile:

```
sync.example.com {
	reverse_proxy localhost:8080
}
```

## Environment

| Variable        | Default                   | Meaning                                     |
| --------------- | ------------------------- | ------------------------------------------- |
| `VRTTI_TOKEN`   | none, required            | The bearer token. The server refuses to start without it. |
| `VRTTI_DB`      | `./data/vrtti.db`         | Path of the SQLite file.                    |
| `VRTTI_ORIGINS` | `https://urza.github.io`  | Comma-separated list of allowed CORS origins. |
| `ASPNETCORE_URLS` | Kestrel's default       | Listening address, for example `http://+:8080`. |

Generate a token with `openssl rand -hex 32`. One static token serves the single user.

## Endpoints

All paths need `Authorization: Bearer <token>`, except health. Request bodies are
limited to 10 MB.

| Method   | Path                              | Result                                                |
| -------- | --------------------------------- | ----------------------------------------------------- |
| `GET`    | `/api/health`                     | `{ ok: true }`. No token needed.                      |
| `GET`    | `/api/changes?since=&limit=&spaces=` | `{ changes, next, more }`. Newest revision per document with `seq > since`. `since` defaults to 0, `limit` to 200, capped at 500. `spaces` filters by space, see below. |
| `GET`    | `/api/spaces`                     | `[{ space, count }]`, ordered by name. See Spaces.    |
| `POST`   | `/api/docs/{id}/revisions`        | 201 `{ rev, seq }`. 409 `{ current }` when `baseRev` is a number and is not the current revision. |
| `GET`    | `/api/docs/{id}`                  | The current revision, or 404.                         |
| `GET`    | `/api/docs/{id}/revisions`        | History, newest first, without content.               |
| `GET`    | `/api/docs/{id}/revisions/{rev}`  | One revision, or 404.                                 |
| `DELETE` | `/api/docs/{id}/revisions?below=` | `{ purged }`. Removes revisions below `below`. The newest one always stays. |

Push body:

```json
{
  "baseRev": 3,
  "kind": "text",
  "content": "…",
  "meta": { "title": "Notes", "lang": "markdown" },
  "deviceId": "…",
  "clientTime": 1700000000000,
  "space": "personal"
}
```

`space` is optional. A missing or null `space` means `personal`.

`kind` is `text`, `deleted` or `detached`. `baseRev: null` means "attach without a
claim" and always appends. `deleted` tells other devices to remove their copy;
`detached` means the document left sync and the local copies stay.

Purge exists for the conversion of a plaintext document to an encrypted one. The old
revisions still hold the readable text, so the client purges them after the first
encrypted push.

A change row (from `/api/changes`, `/api/docs/{id}` and one revision) has the fields
`docId`, `rev`, `seq`, `kind`, `content`, `meta`, `deviceId`, `clientTime`,
`serverTime` and `space`.

## Spaces

A space is a named bucket. Every row has one, and the space of a document's newest row
is the space of the document. A push with another space moves the document; the table
stays append-only. See `architecture.md`, section 25.

- Names are 1 to 32 characters from `A-Z a-z 0-9 - _`. Any other name is a 400
  `{ error: "space must be 1-32 letters, digits, - or _" }`, on a push and on each item
  of `spaces=`. A new name makes a new space; nothing registers it.
- `spaces=a,b` on `/api/changes` returns only documents whose newest row is in one of
  those spaces. A document that moved out of them is left out. Items are trimmed and
  empty items are ignored. Absent or empty means every space.
- `GET /api/spaces` counts, per space, the documents whose newest row is `text`. A
  document whose newest row is `deleted` or `detached` does not count.
- `keyring` holds the keyring record. The server treats it as any other space; the
  client reserves it.

The filter is a subscription, not access control. The one token can still ask for every
space.

## Migration

The server migrates the database at start, with no manual step. A database from before
spaces gets the `space` column: existing rows become `personal`, and rows whose meta has
`"kind": "keyring"` become `keyring`. Then the `revisions_space` index is created. A
second start finds the column and changes nothing.

## Paging

`next` is the largest `seq` in the page, or the `since` you sent when the page is empty.
Call again with `since = next` while `more` is true. The cursor never skips a document:
every returned row is a document's newest row, so a document left out of the page has
its newest `seq` above the cursor and appears in a later page. The `spaces` filter
keeps this true, because it drops whole documents and never an older row.
