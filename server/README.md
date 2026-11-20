# vrtti sync server

A thin sync backend for the vrtti editor. ASP.NET Core minimal API on .NET 10, SQLite,
raw SQL. The server is content-agnostic. It stores opaque content and an opaque `meta`
object, and it never looks inside them.

One exception, and only when the user asks for it: the command "Add diacritics (vllm)"
sends paragraphs of a note to `POST /api/model/diacritics`, and the server passes them to
the user's language model (see "Language model" below). The text is never stored or
logged. This also holds for an encrypted note: the user starts the command, so the
user decides.

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
| `VRTTI_MODEL_URL` | none                    | Base URL of an OpenAI-compatible API (vLLM), for example `http://10.0.0.5:8000/v1`. Without it the server has no model. |
| `VRTTI_MODEL_NAME` | `default`              | The model name for the chat request. |
| `VRTTI_MODEL_KEY` | none                    | A bearer key for the model API, if it needs one. |

Generate a token with `openssl rand -hex 32`. One static token serves the single user.

## Endpoints

All paths need `Authorization: Bearer <token>`, except health and version. Request bodies are
limited to 10 MB.

| Method   | Path                              | Result                                                |
| -------- | --------------------------------- | ----------------------------------------------------- |
| `GET`    | `/api/health`                     | `{ ok: true }`. No token needed.                      |
| `GET`    | `/api/version`                    | `{ build: 202610171403 }`. The UTC minute of the build, `yyyyMMddHHmm`. No token needed. Compare it with your last build to see that a deploy took. |
| `GET`    | `/api/changes?since=&limit=&spaces=` | `{ changes, next, more }`. Newest revision per document with `seq > since`. `since` defaults to 0, `limit` to 200, capped at 500. `spaces` filters by space, see below. |
| `GET`    | `/api/spaces`                     | `[{ space, count }]`, ordered by name. See Spaces.    |
| `POST`   | `/api/docs/{id}/revisions`        | 201 `{ rev, seq }`. 409 `{ current }` when `baseRev` is a number and is not the current revision. |
| `GET`    | `/api/docs/{id}`                  | The current revision, or 404.                         |
| `GET`    | `/api/docs/{id}/revisions`        | History, newest first, without content.               |
| `GET`    | `/api/docs/{id}/revisions/{rev}`  | One revision, or 404.                                 |
| `DELETE` | `/api/docs/{id}/revisions?below=` | `{ purged }`. Removes revisions below `below`. The newest one always stays. |
| `GET`    | `/api/model`                      | `{ diacritics: false }` without `VRTTI_MODEL_URL`. With it: `{ diacritics: true, name, state, served, why }`, where `state` is `answers`, `not answering` or `name not served` (a live check, see "Language model"). |
| `POST`   | `/api/model/diacritics`           | Body `{ text }`, one paragraph of at most 20,000 characters. 200 `{ text }` with the answer of the model. 404 without a model, 413 above the limit, 502 when the model fails or takes more than 30 seconds. |

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

## Language model

With `VRTTI_MODEL_URL` set, the server offers "Add diacritics (vllm)" to the app. For
each paragraph it makes one chat request with temperature 0 and a fixed Czech
instruction: add the missing diacritics and change nothing else. The instruction is in
`Vrtti.Server/Model.cs`; a caller can not send another one, so the endpoint can not be used
as a general door to the model. The app sends up to 16 paragraphs at the same time, and
vLLM batches them. The app checks each answer again and keeps only words that differ by
diacritics alone. Thinking output (`<think>…</think>`) is removed, and the request asks
Qwen-style templates not to think (`chat_template_kwargs`).

The server checks the model at its start and writes the result to the log, so
`docker logs vrtti-server` shows a wrong `VRTTI_MODEL_URL` or `VRTTI_MODEL_NAME` right
after `docker run`. The check asks vLLM for `GET /v1/models` (3-second timeout) and
looks for the name. `GET /api/model` runs the same check live, at most once per 30
seconds, and the app shows the result in Settings › Editor › Model. The log gets a new
line when the result changes.

```
2026-11-20 12:03:07 info: Vrtti.Server.DiacriticsModel[0] model check: http://10.0.0.5:8000/v1/ answers, "Qwen3-8B" is served (12 ms)
2026-11-20 12:03:07 warn: Vrtti.Server.DiacriticsModel[0] model check: http://10.0.0.5:8000/v1/ answers, but it does not serve "qwen3"; it serves "Qwen/Qwen3-8B"
```

Each paragraph of "Add diacritics (vllm)" gives two log lines: "asked" when it arrives,
and the result when the device got the answer. The app sends its device name (from the
keyring, else the start of its device id), a run id for one command, and the paragraph
number in the headers `X-Vrtti-Device`, `X-Vrtti-Run` and `X-Vrtti-Part`. The lines
hold counts, times and states only, never text of a note or of the answer.

```
info: ... diacritics run 7f3a from Pixel: paragraph 1/3 asked, 412 characters
info: ... diacritics run 7f3a paragraph 1/3: model 200 in 1.12 s, same length, 31 letters changed, relayed
warn: ... diacritics run 7f3a paragraph 3/3: no model answer in 30 s, 502 relayed
warn: ... diacritics run 91c0 paragraph 1/1: the device left after 0.80 s, not relayed
```

"other length" in place of "same length" means that the model broke the format; the app
then keeps its local result for that paragraph. The log has one line per entry with the
time. ASP.NET Core requests and outgoing HTTP calls log warnings only.

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
