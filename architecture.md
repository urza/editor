# vrtti architecture

Status: agreed 2026-09-01, before implementation. This is the reference for the real app.
The PoC in `poc/` is the seed. See `motivation.txt` for goals and `poc-plan.md` for PoC scope.

## 1. Core storage model

Every open document is a buffer record in IndexedDB, on every platform.
A buffer can link to zero or more persistence targets.
A target is a disk file, a disk folder entry, or a server document.

Consequences:

- Autosave, crash recovery, and close-without-prompts work everywhere, unchanged from the PoC.
- Disk writes and server pushes are write-behind steps after the IndexedDB write.
  A network failure or a denied file permission never loses text.
- One code path serves PC and phone. The phone simply has no disk target.

For a file-backed buffer, disk is the source of truth.
The IndexedDB copy is a journal and a cache.
On load, the app re-reads the disk file and compares timestamps.

### Write pipeline

Each stage is independent. A failure in a later stage never loses data,
because the earlier stage already holds the text.

```
editor (plaintext, in memory)
  -> codec           encrypt, only for docs with `enc` (section 5)
  -> record          in-memory Map, content is now opaque bytes/text
  -> IndexedDB       debounced ~300 ms, durable on tx complete
  -> disk            write-behind, only if a file link exists
  -> sync outbox     mark dirty, push when online (section 3)
```

Everything below the codec treats content as opaque. This rule is load-bearing:
it is what makes encryption and sync orthogonal to storage.

## 2. Desktop: real files (File System Access API)

- Individual files and folders come from `showOpenFilePicker` and `showDirectoryPicker`.
  Desktop Chrome and Edge only. The whole module sits behind feature detection.
- Handles are stored in IndexedDB. An installed PWA on Chrome 122+ keeps the
  permission across restarts ("allow on every visit"), so folders reopen on launch.
- External changes: check `lastModified` on window focus and on a slow interval.
  Clean buffer: reload silently. Dirty buffer: fork a conflict buffer, no dialogs.
  `FileSystemObserver` can replace polling when it is stable.
- An opened folder becomes a sidebar group.

Implementation decisions (2026-09-01, step 2 build):

- Ships as two units: individual files first, folder sections second.
- IndexedDB v2 migration adds the `handles` store: `{ id, kind: 'file'|'directory',
  handle, name, addedAt }`. Handles are structured-cloneable and live there;
  a runtime map id -> handle is loaded at start.
- Buffer dirty-vs-disk test is timestamps, no hashing: `updatedAt` vs the
  `file.lastSyncAt` set on every successful disk read or write.
- Disk write-behind: a second debounce (~1 s) after the IndexedDB write.
  A disk failure shows in the save indicator; the text is safe in IndexedDB.
- Silent reload on clean external change goes through a store "replace" path,
  so the editor view gets the new text as one dispatched change.
- Conflict fork: the local text becomes a new scratch buffer with a first
  line "conflict copy of <name>", then the disk version loads. No dialogs.
- Reconnect: handles whose permission is "prompt" show a reconnect row;
  the permission request runs on that click (a user gesture is required).
- UI entry points (mouse-first): "file" and "folder" open buttons under the
  big "+", a save-to-disk statusbar button for scratch buffers. All hidden
  when the File System Access API is absent (Firefox, phones).
- Folder section: lazy tree. Top-level entries listed; subdirectories expand
  on click and list on demand. Directories first, then files, A-Z. Closing a
  folder removes the section; buffers opened from it stay open.
- FSA entry points are called as window.* at invocation time, so tests can
  stub the pickers with OPFS handles (real FileSystemHandle objects).

## 3. Sync

One flat document namespace for the single user. No per-device buckets.
The device id is metadata on revisions, for history display only.

Server model, Dropbox-like and thin:

- Each document has a stable UUID, created with the buffer.
- Each push creates a revision row: docId, revision number, content, deviceId,
  timestamp, deleted flag. The table is append-only. "Current" is the newest revision.
  This gives version history for free. Deletion is a tombstone revision.
- The client keeps a sync cursor and an outbox of dirty docIds in IndexedDB.
  It pulls changes since the cursor, then pushes.
  Triggers: app start, window focus, coming online, slow timer. Polling is enough.
- Conflict rule: if a pull brings a newer revision while the local buffer is dirty,
  the incoming version becomes current. The local text forks into a conflict buffer.
  Nothing is lost, nothing prompts.

Backend: ASP.NET Core minimal API plus SQLite. Endpoints:

- pull changes since cursor
- push revision
- get document
- list history
- purge revisions of one doc (needed when a doc converts to encrypted, section 5)

The server is content-agnostic: opaque content plus metadata. It never inspects text.

Scope: scratch buffers sync first. File-backed and folder-backed docs stay
device-local by default, with an opt-in "also sync this" flag later.
The docId is global and the disk link is per-device, so the model supports this.

## 4. Phone

Primary phone is iPhone (decided). Everything must also work on Android.
iOS Safari is the most restrictive target, so it sets the baseline:
install via Add to Home Screen, no File System Access, aggressive storage eviction.
Android Chrome then gets the same features or more, never less.

Buffers live in IndexedDB with `navigator.storage.persist()`.
Sync doubles as the backup, so browser eviction is an inconvenience, not a disaster.

## 5. Encryption (age)

Optional, per document. Uses the real age format via typage
(official TypeScript implementation, vendored as an ES module, no WASM, no npm at runtime).

### Format and interop

- Encrypted content is standard age ciphertext everywhere:
  in memory records, IndexedDB, on disk, and on the server.
- File-backed secret docs are written as standard `.age` files.
  The age CLI can decrypt them. The app recognizes `.age` files in opened folders.
  The app is never a data prison.

### Identities and recipients

- Each device generates one X25519 identity at setup.
  The public key is the device recipient. A synced plaintext keyring doc lists
  all device public keys with friendly names. Public keys are not secret.
- The private identity never leaves its device. It is itself age-encrypted to a
  passphrase (scrypt). Unlock once per session. IndexedDB alone never holds a
  usable private key.
- **Master recovery identity** (decided): generated once at setup, kept offline
  (paper or password manager), added to every recipient set by default.
  This is non-optional; it is the answer to a lost device.
- Recipient sets per doc. Start with presets (decided): "all devices" and
  "this device only". Per-device picking comes later.
- A device outside the recipient set still stores and syncs the ciphertext.
  It is a courier and shows a locked row.

### Codec placement

Encryption is a codec stage between editor and record (see pipeline, section 1).
Plaintext exists only in the live editor state while the doc is open and unlocked.
Autosave encrypts on each debounced save. age wraps a fresh file key per encryption.
Storage, FSA, sync, and server are unchanged and byte-agnostic.

### Metadata that stays plaintext (accepted, decided)

Doc existence, docId, size, timestamps, device ids, revision counts.
An encrypted doc has an explicit plaintext label with a lock icon,
because the first-line-derived title is unreadable when locked.
Search and spellcheck only see currently unlocked docs.

### Locking (decided: manual lock only)

- One "unlock" command asks the passphrase, decrypts the device identity into memory.
- Manual "lock" command. No auto-lock timeout for now.
- On lock, drop cached editor states of encrypted docs (this drops their undo
  history; acceptable and necessary).
- Opening a locked doc triggers the unlock prompt first. No other dialogs.

### Prototype findings (2026-09-01, see crypto-proto/REPORT.md)

The plan above is validated end to end in `crypto-proto/`. Key facts:

- typage (`age-encryption@0.3.1`) vendors as pure ESM: 67 files, ~895 KB,
  six import-map entries, no bundler, no WASM. Pin the noble/scure deps
  EXACTLY (hashes and curves both 2.0.1): an import map is flat, npm's
  nested-duplicate trick does not exist here, so "latest" can break at runtime.
  Vendor from registry tarballs; jsdelivr's +esm build phones home and breaks
  offline. `crypto-proto/vendor.sh` is the reproducible recipe.
- Interop with the real age CLI (v1.3.2) is proven in both directions,
  armored and binary. The scrypt-wrapped device identity is itself a standard
  age file, so `age -d -i wrapped.age note.age` restores data with the CLI
  alone. That is the recovery story, keep it.
- Performance: encrypt+decrypt is ~1 ms at 100 KB with 3 recipients. The
  autosave debounce is safe by two orders of magnitude. The ONE slow path is
  scrypt at unlock (~600 ms desktop, worse on phone) and it is synchronous:
  the unlock step must run in a Web Worker.
- The unlocked identity lives as a non-extractable X25519 CryptoKey
  (RFC 8410 PKCS#8 prefix; typage accepts CryptoKey identities directly).
  Lock then leaves nothing in the JS heap. Unlock transiently handles the
  identity string; a CryptoKey is structured-cloneable, so nothing may ever
  write it to IndexedDB. Browsers without WebCrypto X25519 fall back to the
  string identity (works, weaker hygiene). Test a real iPhone in step 3a.
- Metadata fix: `enc` stores a PRESET ID, never the resolved recipient list.
  An age header deliberately hides who can decrypt; writing the list into
  record metadata would hand the server exactly that. Presets resolve to
  recipients via the keyring at encrypt time.
- Sync client note: age wraps a fresh file key per encryption, so ciphertext
  changes on every save even when the text did not. Any future "skip write if
  unchanged" optimisation must compare plaintext, not ciphertext.

### Interplay with sync

- Conflict forks work on ciphertext without keys. LWW and history are unchanged.
- Converting a plaintext doc to encrypted must purge its prior server revisions
  (the purge endpoint), or old plaintext history defeats the purpose.
- Removing a lost device: delete its public key from the keyring, re-encrypt
  affected docs from any authorized device, purge old revisions when it matters.

## 6. Frontend structure

Frameworkless, native ES modules, no npm at runtime. Vendored deps via `tools/vendor.py`.
One-way data flow: UI dispatches commands, commands mutate the store,
the store emits events, UI modules re-render their own DOM region.

```
app/js/
  main.js              bootstrap only: create store, mount UI, start sync
  model/
    docs.js            document store: in-memory Map + EventTarget, all mutations here
    codec.js           encrypt/decrypt stage between editor and record
    capabilities.js    feature detection (FSA, persist, ...)
  commands/
    registry.js        id -> { title, run, keys }
  crypto/
    age.js             vendored typage wrapper
    keyring.js         device identity, unlock state, known recipients
  storage/
    idb.js             working store (grows from poc/js/store.js)
    fsa.js             desktop file/folder targets, loaded only when supported
  sync/
    client.js          cursor, outbox, push/pull engine
  editor/
    editor.js          CodeMirror wrapper, per-buffer state cache
  ui/
    sidebar.js  statusbar.js  palette.js  shortcuts.js
server/
  (ASP.NET Core minimal API + SQLite)
```

- The command registry is the backbone. Shortcuts, sidebar buttons, and the future
  command palette all dispatch the same command ids.
- Types without npm: JSDoc annotations plus `// @ts-check`. Editors check them
  through tsserver, zero build tooling.
- IndexedDB gets separate object stores: buffers, handles, sync state, settings.
  Versioned migrations start from the PoC v1 schema.

## 7. Data shapes

Buffer record:

```
{
  id, content, closed, createdAt, updatedAt,
  kind: 'scratch' | 'file',
  file?: { handleId, path, lastSyncedMtime },
  sync?: { rev, baseRev, dirty, deleted },
  enc?:  { v: 1, preset, label },   // preset id, never the recipient list (§5)
  group, order
}
```

The `enc` field is reserved in the first schema migration, before the feature ships.
`group` and `order` serve manual sidebar ordering and grouping.

Server revision row:

```
{ docId, rev, content, deviceId, timestamp, deleted }
```

## 8. Build order

1. Refactor the PoC into the module layout, with the command registry.
   No new features, same behavior.
2. Desktop files and folders: FSA module, stored handles, external change detection.
3. a) Keyring and codec (crypto lands before sync, the server must never see a
      secret in plaintext, not even once).
   b) Backend and sync engine for scratch buffers, plus a simple history view.
4. Sync opt-in for file-backed docs, then optional layers:
   spellcheck (Harper + Hunspell), LLM (vLLM), Twemoji.

## 9. Sidebar organization (future, factored in now)

The sidebar becomes a list of **sections**, each with a heading and rows.
Planned sections, top to bottom: Favorites, Open (scratch buffers), one
section per opened folder, Recent (collapsed disclosure, exists today).
A future `model/sidebar.js` computes the sections from records plus settings;
`ui/sidebar.js` only renders them. The Recent disclosure is the first section
of this kind, so the pattern already exists in miniature.

- **Manual order**: `order` is a fractional rank (float). Drag-drop assigns
  the midpoint of the two neighbors, so one record changes per drop.
  Renormalize all ranks in one pass when midpoints exhaust float precision.
  On first use, existing records get `order = createdAt`. The rank applies to
  scratch buffers; folder sections sort by filename instead.
- **Star/favorite**: `starred: boolean` on the record. Starred docs show in
  the Favorites section (and stay in their own section too).
- **Age grouping**: a sidebar view mode, derived from `updatedAt` at render
  time (Today, This week, This month, Older). Never stored per record;
  toggling the mode must not write anything.
- **Open folder**: a folder section can hold hundreds of rows. Rendering
  stays plain replaceChildren until it measurably lags; virtualize only then.

### Language auto-detection (agreed 2026-09-01)

Paste JSON, see JSON colors; paste markdown, see markdown. Rules:

- File-backed buffers: the file extension decides (md, js/ts, html, css, json).
- Scratch buffers: content sniffing, conservative on purpose. Trimmed text
  starting with `{` or `[` that JSON.parse accepts is JSON. Text starting
  with `<!doctype` or `<html` is HTML. Everything else stays Markdown, which
  already colors fenced code blocks.
- Detection runs when a buffer opens and after a paste. Never per keystroke.
- The result is stored on the record as `lang`, so it sticks across restarts.
  A "set syntax" command can override it by hand later.
- The editor holds the language in a CodeMirror Compartment, so the mode
  switches live without rebuilding the state. `@codemirror/lang-json` joins
  the vendored set.

### Settings panel (agreed 2026-09-01)

The UI stays minimal on both PC and phone. One "settings" button sits pinned
at the bottom of the sidebar. It opens a plain DOM overlay that covers the
editor area (the whole app on narrow screens). Escape or a close button
dismisses it. No modal library, no routing.

- `ui/settings.js` renders the panel from a declarative list of setting items;
  mutations still go through commands, never directly from the panel.
- Planned sections: Editor (spellcheck, emoji), Storage (persistence state),
  Sync (server URL and token, when sync ships), Security (keys, lock),
  About (build stamp, vendored licenses, the Twemoji CC-BY attribution).
- Storage: localStorage per device for now. A `settings` IndexedDB store (and
  later sync for the sharable subset) arrives with the sync phase.
- Buttons that need instant reach (new buffer, save indicator, update) stay
  outside the panel; the panel is for the rest, so chrome stays sparse.

## 10. Twemoji plan (agreed 2026-09-01)

Goal: render color emoji (Twemoji SVGs) in the editor instead of platform
glyphs, fully offline, no CDN.

- Assets: the full SVG set from the maintained jdecked/twemoji fork, pinned
  version, vendored under `vendor/twemoji/svg/`. CC-BY 4.0; attribution goes
  in VENDOR.md. Fetched via registry.npmjs.org or GitHub tarball, whichever
  the sandbox network allows.
- Rendering: a CodeMirror ViewPlugin with MatchDecorator. Emoji sequences
  become replace decorations with an `<img>` widget pointing at the vendored
  SVG. Own matcher built on Unicode property escapes (Extended_Pictographic,
  ZWJ sequences, skin tones, flags, keycaps). Filename mapping follows the
  twemoji rule: hyphen-joined lowercase hex codepoints, `fe0f` stripped when
  the sequence has no ZWJ.
- Fallback: on img error (missing or not-yet-cached asset), the widget swaps
  to the plain text glyph. The document text itself is never modified.
- Service worker: the ~3,700 SVGs are NOT precached. `sw.js` gains a
  cache-on-first-use path for `vendor/twemoji/`; seen emojis work offline.
- Always on for now; a toggle command can come later.

## 11. Harper spellcheck plan (agreed 2026-09-01)

Goal: offline English spelling and grammar checking with quick fixes,
better than Sublime's. Czech comes later via Hunspell (section 8 item 4).

- Engine: Harper via its WASM build, vendored from npm (`harper.js`, or the
  lower-level `harper-wasm` if the wrapper assumes a bundler). WASM loads
  from an explicit vendored URL, native ESM only. The WASM binary IS
  precached, spellcheck must work offline.
- Editor integration: vendor `@codemirror/lint`, pinned compatible with the
  in-tree CodeMirror versions. A `linter()` source maps Harper lints to
  diagnostics: spelling as "warning" with a dotted underline, style hints as
  "info". Harper suggestions become diagnostic actions (one-click fixes).
- Offsets: verify Harper span semantics against CodeMirror UTF-16 offsets
  with an astral-plane test (emoji before a misspelling). Convert if needed.
- Lazy: the engine loads on first lint (dynamic import), not at startup.
- Toggle: command `spell.toggle`, persisted per device, default on, plus a
  small statusbar indicator button. Runs on the main thread with a lint
  debounce; a worker only if typing measurably lags.
- Custom dictionary ("add word") comes later, with sync in mind.

## 12. Decision log

Decided (2026-09-01):

- IndexedDB is the working store everywhere; disk and server are mirrors.
- One shared sync namespace, no per-device buckets. LWW plus append-only history.
- Real age format via typage. Per-device X25519 identities, passphrase-protected.
- Master recovery identity, offline, default recipient on everything.
- Recipient presets first ("all devices", "this device only"); per-device later.
- Plaintext labels on encrypted docs: accepted metadata leak.
- Manual lock only, no auto-lock timeout.
- Crypto codec ships before sync goes live.
- Primary phone is iPhone; Android must work too. iOS Safari sets the PWA baseline.
- Server auth: single static bearer token over HTTPS.
- Scratch-only sync first; file-backed docs get an opt-in sync flag later.
- JSDoc types with `// @ts-check`, no TypeScript files, no build step.
- Sidebar future (section 9): section-based sidebar, fractional `order` rank,
  `starred` flag, age grouping derived at render time, never stored.
- Twemoji per section 10: vendored SVGs, CM widget decorations,
  runtime-cached (not precached), text fallback on missing asset.
- Harper per section 11: vendored WASM (precached), @codemirror/lint
  integration with quick fixes, lazy load, default on with toggle.
- Settings: one bottom-of-sidebar button opens an overlay panel over the
  editor (section 9). Declarative items, commands do the mutations.

Open: none.
