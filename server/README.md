# vrtti sync server

A thin sync backend for the vrtti editor. ASP.NET Core minimal API on .NET 10, SQLite,
raw SQL. The server stores age-encrypted content and a small `meta` object. It cannot
read a note: it only checks that the content is an age file and that `meta` holds no
readable fields.

One exception, and only when the user asks for it: the command "Add diacritics (vllm)"
sends paragraphs of a note to `POST /api/model/diacritics`, and the server passes them to
the user's language model (see "Language model" below). The text is never stored or
logged. This also holds for an encrypted note: the user starts the command, so the
user decides.

Every push appends a revision row. The newest row of a document is the current version.
Each device has its own token, and a space is a list of devices. See `architecture.md`,
sections 3, 13.5 and 27.

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

Generate the token once and keep it; the first device types the same value. Other
devices join with a code.

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
| `VRTTI_TOKEN`   | none, required            | The server token. It only registers a device. The server refuses to start without it. |
| `VRTTI_DB`      | `./data/vrtti.db`         | Path of the SQLite file.                    |
| `VRTTI_ORIGINS` | `https://urza.github.io`  | Comma-separated list of allowed CORS origins. |
| `ASPNETCORE_URLS` | Kestrel's default       | Listening address, for example `http://+:8080`. |
| `VRTTI_MODEL_URL` | none                    | Base URL of an OpenAI-compatible API (vLLM), for example `http://10.0.0.5:8000/v1`. Without it the server has no model. |
| `VRTTI_MODEL_NAME` | `default`              | The model name for the chat request. |
| `VRTTI_MODEL_KEY` | none                    | A bearer key for the model API, if it needs one. |

Generate a token with `openssl rand -hex 32`.

## Tokens

- The **server token** (`VRTTI_TOKEN`) does one thing: `POST /api/devices`, which
  registers the first device. Any other request with it is a 401
  `{ error: "a device token is required" }`.
- A **device token** is a random secret that a device makes for itself. The server
  stores only its lowercase hex SHA-256 (`tokenHash`) and finds the device from it.
  Every other request carries `Authorization: Bearer <device token>`, and the device id
  of a pushed row comes from it.
- A device joins with a join code (see Joins) and never needs the server token.

## Endpoints

All paths need a device token, except health, version, `POST /api/devices` (server
token) and `POST /api/joins/redeem` (no token). Request bodies are limited to 10 MB.

| Method   | Path                              | Result                                                |
| -------- | --------------------------------- | ----------------------------------------------------- |
| `GET`    | `/api/health`                     | `{ ok: true }`. No token needed.                      |
| `GET`    | `/api/version`                    | `{ build: 202610171403 }`. The UTC minute of the build, `yyyyMMddHHmm`. No token needed. Compare it with your last build to see that a deploy took. |
| `POST`   | `/api/devices`                    | Server token. `{ id, tokenHash }`, 201. 409 when the id or hash is taken. 403 with a device token. |
| `POST`   | `/api/devices/successor`          | `{ id, tokenHash }`, 201. Registers the successor of the caller, at most one. 409 on a second one. |
| `GET`    | `/api/changes?since=&limit=&spaces=` | `{ changes, next, more }`. See Changes.            |
| `GET`    | `/api/spaces`                     | `[{ space, count, logSeq }]`: the caller's spaces, ordered by name. |
| `GET`    | `/api/spaces/{name}/log?since=`   | `[{ seq, entry }]`, members only (else 403).          |
| `POST`   | `/api/spaces/{name}/log`          | `{ entry }`, 201 `{ seq }`. See Space log.            |
| `GET`    | `/api/spaces/unclaimed`           | Names of spaces with rows and no member. Only for a device registered with the server token. |
| `POST`   | `/api/spaces/{name}/claim`        | `{ entry }`: the `create` of an unclaimed space. Same rule as the list above. |
| `POST`   | `/api/joins`                      | `{ slot, verifier, spaces }`, 201. See Joins.         |
| `POST`   | `/api/joins/redeem`               | No token. `{ slot, verifier, deviceId, tokenHash, entry, proof }`, 201. |
| `GET`    | `/api/joins`                      | `[{ slot, spaces, deviceId, entry, proof }]`: the caller's used joins that wait for a reply. |
| `POST`   | `/api/joins/{slot}/reply`         | `{ reply, mac }`, 204. From the member that made the join. |
| `GET`    | `/api/joins/{slot}/reply`         | `{ reply, mac }` for the device that joined; both null while it waits. |
| `GET`    | `/api/introductions`              | `[{ device, by, replaces, sig }]`: the whole device directory, for every device. See Device directory. |
| `POST`   | `/api/introductions`              | `{ device, by, replaces, sig }`, 201, or 200 for a pair the server has (no change). See Device directory. |
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
  "content": "-----BEGIN AGE ENCRYPTED FILE-----\n…",
  "meta": { "enc": { "preset": "space", "spaceSeq": 4 }, "sealed": "-----BEGIN AGE ENCRYPTED FILE-----\n…" },
  "clientTime": 1700000000000,
  "space": "personal"
}
```

`space` is required. `kind` is `text`, `deleted` or `detached`. `baseRev: null` means
"attach without a claim" and always appends. `deleted` tells other devices to remove
their copy; `detached` means the document left sync and the local copies stay.

The server refuses plain text with a 400, for each document but the keyring record:

- the content of a `text` row starts with `-----BEGIN AGE ENCRYPTED FILE-----`;
  a tombstone has no content, or age content;
- `meta` is an object with no keys but `kind`, `enc` and `sealed`;
- `meta.sealed` is an armored age file too.

Purge exists for the conversion of a plaintext document to an encrypted one. The old
revisions still hold the readable text, so the client purges them after the first
encrypted push.

A change row (from `/api/changes`, `/api/docs/{id}` and one revision) has the fields
`docId`, `rev`, `seq`, `kind`, `content`, `meta`, `deviceId`, `clientTime`,
`serverTime` and `space`.

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

## Access

A device reads and writes the spaces of which it is a member, and the `keyring` space.

- `GET /api/changes` without `spaces=` means all of the caller's spaces. A name in
  `spaces=` that is not one of them is a 403.
- `GET /api/docs/{id}`, the history and one revision are 404 when the current space of
  the note is not one of the caller's. The history leaves out revisions of spaces of
  which the caller is not a member.
- A push, a tombstone and a purge need a membership of the current space of the note
  (else 404). A push to a space of which the caller is not a member is a 403, so a move
  needs both spaces.
- `keyring` holds two documents, `keyring` and `shared-settings`, and they live nowhere
  else (else 400). They have no tombstone. Every device writes this space, a removed one
  too, so any other document there would reach each device as a note.
  - `keyring` is the list of devices. The plain-text check skips it.
  - `shared-settings` holds the settings that all devices of the user share (the changed
    spellcheck rules and the user's own words). It is an armored age file, encrypted by
    the client for the devices it knows, and the plain-text check applies to it.

## Changes

`/api/changes` returns the newest revision of each document whose key is above `since`.
`since` defaults to 0, `limit` to 200, capped at 500. A document is in the result when
its newest row is in one of the asked spaces (key: the `seq` of that row), or when a row
moved it out of one of them (key: the `seq` of the last such move). In the second case
the caller learns where the note went; when it is not a member of the new space, the
row comes without `content` and without `meta.sealed`. The `seq` of a returned row is
its key.

## Space log

A space is a list of devices. The list follows from a numbered log of signed entries;
the server stores each entry as the exact text it gets.

```json
{ "seq": 2, "prev": "<sha256 hex of entry 1>", "op": "add", "space": "personal",
  "device": "<entry key>", "by": "<entry key>", "sig": "…" }
```

- `op` is `create`, `add`, `remove` or `color`. An entry key is the device entry as
  lines, `vrtti-device`, id, name, recipient, sign key, added time; the server reads the
  id from its second line.
- `prev` is the lowercase hex SHA-256 of the previous entry's text, `null` for seq 1.
- The server checks: `by` is the caller; the caller is a member (for `create`: the name
  has no log and no rows, and `device` is the caller); `seq` and `prev` follow the last
  entry (else 409, and the client pulls the log and tries again); an added device is
  registered and not yet a member; a removed one is a member; the last member cannot
  remove itself (409). Then it writes the entry and the member row in one transaction.
- The server does not check `sig`. The clients do, and they decide who is a member.
- `keyring` cannot be created.

## Joins

A member makes a 10-character code, for example `K7MQ2-XWD4P`. The first 3 characters
are the slot, a public id; the server never sees the rest.

1. The member sends `{ slot, verifier, spaces }`. It must be a member of each space. A
   slot that still serves another join is a 409, and the member draws a new code.
2. The new device sends the slot, the verifier from the typed code, its device entry,
   its token hash and a proof. A wrong verifier is a 403 and counts; after 5 wrong ones,
   or after 10 minutes, the join is gone (404). A correct one registers the device.
3. The member finds the used join in `GET /api/joins`, checks the proof, adds the device
   to the spaces, and posts its reply.
4. The new device reads the reply from `GET /api/joins/{slot}/reply`.

A join may give no space (`spaces: []`): the device joins the server only.

## Device directory

One list of introductions: device `by` vouches for device `device` (both entry keys).
The clients sign and check each entry; the server does not check signatures. An entry
gives no space.

- Every registered device reads all entries.
- A device writes only as itself: the device id in `by` must be the caller (else 403).
  The device id in `device` must be a registered device (else 400).
- `device` and `by` are at most 4096 characters, `sig` at most 256 (else 400).
- An entry for a pair the server has changes nothing: the first entry stays.

## Migration

The server migrates the database at start, with no manual step.

1. A database from before spaces gets the `space` column: existing rows become
   `personal`, and rows whose meta has `"kind": "keyring"` become `keyring`.
2. A database from before device spaces gets the `prev_space` column, and the old
   readable fields `title`, `lang`, `langSource` and `spellOff` leave the `meta` of each row. The rows
   and their history stay.
3. The tables `devices`, `members`, `space_log`, `joins` and `introductions`, and the
   indexes, are created when they are missing.

A second start finds the columns and changes nothing. After the upgrade no space has a
member: the first device registers with the server token and claims the old spaces.

## Paging

`next` is the largest `seq` in the page, or the `since` you sent when the page is empty.
Call again with `since = next` while `more` is true. The cursor never skips a document:
the rows are ordered by key, keys are distinct and only grow, so a document left out of
the page has its key above the cursor and appears in a later page. A document that moved
away keeps the `seq` of the move as its key: later rows in its new space must not put it
behind a page of other rows, past the cursor of the next call.
