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

Sync is optional. The app works fully offline with no server configured.
The sync module stays inert until a server URL and token exist. It never
blocks on the network and never shows a login wall.

One flat document namespace for the single user. No per-device buckets.
The namespace is shared; the membership is not (decided 2026-09-02).
A doc enters the namespace only when a device attaches a server target to it
(section 1). Doc ids are global UUIDs, so a doc can enter late without a rename.
The device id is metadata on revisions, for history display only.

Server model, Dropbox-like and thin:

- Each document has a stable UUID, created with the buffer.
- Each push creates a revision row: docId, revision number, content, deviceId,
  timestamp, tombstone kind. The table is append-only. "Current" is the newest revision.
  This gives version history for free.
- Tombstones have two kinds. `deleted`: other devices remove their copy.
  `detached`: the doc left sync; other devices keep their copy as a local doc.
  "Stop syncing" is not "delete", and nothing is lost.
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

### What syncs

Nothing syncs unless the doc has a server target. Three ways set that flag:

- Per doc: one toggle on the doc. This is the base operation and ships first.
- Per folder: a toggle on the folder entry. New docs in the folder inherit it.
  The server also stores the path relative to the folder root, or the other
  device sees a flat pile and cannot rebuild the tree. The disk link stays
  per device. Second phase.
- Per device: a setting "new docs sync by default", plus a one-shot command
  "sync all current docs". Both only set the per-doc flag in bulk.

Defaults: off on desktop, on for phones (section 4). Most desktop docs are
temporary scratch; they should not appear on the other devices.

Sync and encryption stay orthogonal (section 5). But the server is untrusted,
so the dialog that turns sync on for a plaintext doc offers encryption in the
same step. Plaintext on the server is a choice, not an accident.

## 4. Phone

Primary phone is iPhone (decided). Everything must also work on Android.
iOS Safari is the most restrictive target, so it sets the baseline:
install via Add to Home Screen, no File System Access, aggressive storage eviction.
Android Chrome then gets the same features or more, never less.

Buffers live in IndexedDB with `navigator.storage.persist()`.
Sync doubles as the backup, so browser eviction is an inconvenience, not a disaster.
Phones therefore default "new docs sync by default" to on (section 3), because
no disk file backs them. A phone with no server configured still works fully;
it shows a persistent "no backup" hint instead.

Two layout rules come from the first real iPhone session (2026-09-09) and must
survive later CSS work; both carry their reason in app.css at the rule:

- Every text field is 16px under 700px. Below that size iOS Safari zooms the
  page in on focus and never zooms back out, so the page stays wider than the
  screen. The fix is the font size, never a `maximum-scale` lock, which would
  take pinch zoom away from the user.
- A settings row wraps, and long values (62-character age keys) take their own
  line. Without the wrap the label column collapsed to zero width and the two
  texts drew on top of each other.

Confirmed on the device the same day: Czech and English spellcheck run
together, and encryption uses the WebCrypto CryptoKey path (section 5).

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
  string identity (works, weaker hygiene). Tested on a real iPhone
  2026-09-09: iOS Safari reports "unlocked (CryptoKey)", so the phone takes
  the CryptoKey path and the fallback stays for older engines only. Setup
  and unlock felt immediate there, so scrypt is no problem on the phone;
  the worker stays, because a synchronous 600 ms would still block paint.
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
    workspace.js       workspace records, this window's identity, ownership (§14)
    channel.js         BroadcastChannel between windows, typed messages (§14.2)
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
  kind: 'scratch' | 'file' | 'keyring',
  title?,                            // user label; the plaintext name of an encrypted doc
  lang?, langSource?,
  file?: { handleId, name, path, lastSyncAt },
  sync?: { rev, dirty, tombstone?: 'deleted' | 'detached', purge?: true },
  enc?:  { v: 1, preset: 'all-devices' | 'this-device' },  // never the recipient list (§5)
  group, order
}
```

Field notes (revised 2026-09-02, see section 13):

- `title` is the one plaintext label. The sidebar rename (row menu) writes it,
  and encryption reads it. Encrypting asks the user for it (prefilled with the
  first line), because the label is stored unencrypted, on the server too. It
  is never derived behind the user's back; an empty label leaves the row
  reading "encrypted".
- `sync.rev` is the last server revision this record agreed with (0 = never
  pushed). `sync.dirty` means local changes wait for a push. A tombstone is a
  pending push of that kind. `purge` asks the push loop to delete older server
  revisions after the next successful push (encrypt conversion, section 5).
- `kind: 'keyring'` marks the one hidden record that carries the device list
  (section 13.3). The sidebar never shows it.
- `group` and `order` serve manual sidebar ordering and grouping (section 9).
- `closed` is gone since workspaces (section 14, unit 14.1). Membership in a
  workspace `tabs` list is the single truth for "open"; a buffer in no
  workspace is in Recent.

Server revision row:

```
{ docId, rev, seq, kind: 'text' | 'deleted' | 'detached',
  content, meta, deviceId, clientTime, serverTime }
```

`seq` is the global append counter and the pull cursor. `meta` is an opaque
JSON object the client owns: `{ title, lang, langSource, enc, kind }`.

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

### Where a file is (2026-09-22, shipped)

The user wants the full path on hover, as Sublime shows on a tab. A page
cannot have it: the File System Access API hands over a handle with a name
and no location, on purpose. What is known is shown: a file row and the
status bar title carry "On disk: <folder>/<path>" for a file opened from a
folder (the folder's name now leads `file.path`), or the file name for a
picker-opened file; a folder heading says its name and that the full path
is not available to the page. The native disk backend (goose patterns §4)
knows real paths and will replace these. The window title is
"<buffer> (<folder path>) — vrtti", set on the document and, in the shell,
on the native window through the core window API, so the taskbar button
says what is on screen. The icon was redrawn the same day: the four lines
and the caret on a rounded square with a gradient, one SVG source in
`app/icons/icon.svg` for the PWA and the desktop icon set. On 2026-09-23
the user rejected that drawing and picked the caret alone from nine
ideas; the four candidates kept (caret, whirl, whirl on orange, loop)
live in `design/icons/` and `design/icons/build.sh <name>` regenerates
every icon file from one of them.

### Recent (user decision, 2026-09-24, shipped)

The sidebar stays simple; the only organization change for now is what
Recent does.

- **Pinned above settings.** `#recent` is a block of its own under the
  scroller, next to the settings button, not the last section of the
  lists: the heading is always in the same place, whatever the tabs and
  folders above it take. Expanded, the list scrolls inside the block,
  capped at half the sidebar, so the Open list stays in view.
- **Closed unless opened.** The disclosure starts closed in every window
  and nothing stores the state (the old `vrtti.recentCollapsed` key is
  gone). A click opens it for the window's lifetime.
- **An empty document never reaches Recent.** Empty means a scratch
  buffer with no text (whitespace counts as none), no user title, not
  encrypted. Closing one deletes the record; a synced one that the server
  holds goes as a `deleted` tombstone and is removed once the push lands,
  hidden from Recent meanwhile, and a newer text from another device
  brings it back as that text instead of a conflict copy. The same rule
  runs once at start over every closed record (the rows that piled up
  before the rule existed) and over the tabs of a dissolved workspace
  (the untouched first buffer of a folder window). Nothing sweeps on
  other workspace changes: a buffer another window has persisted but not
  tabbed yet would look closed and empty for a moment.

### Sidebar collapse (agreed 2026-09-02, shipped)

`ui/shell.js` owns one piece of state, "is the sidebar showing", and two
layouts read it. The breakpoint is 700px, the one the settings panel uses.

- Wide: the sidebar stays docked. Collapsed means zero width, and the editor
  takes the space back. The resizer hides with it.
- Narrow: the sidebar is a drawer over the editor, with a scrim behind it.
  A 220px column on a 360px screen leaves no editor, so it must not push.
  The drawer closes itself when a row opens a document, when "+" makes one,
  and before the settings panel opens (the panel is below it in z-order).
- Two hamburger buttons, one look: `#sidebar-toggle` in the sidebar header,
  `#sidebar-open` floating in a 30px strip the editor reserves while it shows.
  The strip is reserved, not overlaid, or the button covers the line numbers.
- Command `sidebar.toggle` (Alt+B) and `sidebar.autoclose`, which is the
  drawer rule above and a no-op on a PC.
- The default is open when wide, closed when narrow. Only a wide-screen
  toggle persists (`vrtti.sidebarOpen`): a phone must start on the editor,
  never behind a drawer it left open yesterday.
- The CSS defaults match those defaults with no state class present, so the
  first paint is already right and the mount causes no flash.
- A collapsed sidebar is `inert`, so Tab cannot reach rows nobody can see.

### Row menu (agreed 2026-09-02, shipped)

Each buffer row carries a "⋯" button, the claude.ai pattern. `ui/menu.js` is
the popup: one menu at a time, rendered into `document.body` at fixed
coordinates, because `#sidebar-scroll` would clip a menu built inside a row.
Escape, an outside click, a scroll, or a resize closes it; arrows walk it.

Items: Rename, "Use first line" on a renamed scratch buffer, Sync, Encrypt,
then Close or Reopen. Sync and Encrypt are listed and **disabled** until
sections 3 and 5 ship. A toggle that says "encrypted" while nothing encrypts
would be the one lie this app cannot afford; an empty menu slot is honest.

Rename is inline, in the row. Enter commits, Escape cancels, blur commits.
The list stops redrawing while a rename runs, or a keystroke in the editor
would delete the input box.

- Scratch buffer: writes `title` (section 7). Empty clears it, and the first
  line takes over again. `titleOf()` prefers `title` over everything.
- File buffer: renames the file on disk with `FileSystemFileHandle.move()`,
  Chromium only. Elsewhere the item is absent, never disabled: a rename that
  cannot touch the disk would leave the sidebar and the file disagreeing.
  The record follows the file (`file.name`, `file.path`, the handle record),
  the language is re-detected from the new extension as "auto", and every
  open folder section re-lists.
- Touch: "⋯" never hides where there is no hover, and the row's "×" hides
  instead. The menu carries Close, and two small targets side by side on a
  phone are two chances to close the wrong buffer.

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

### Text size (agreed 2026-09-13, shipped)

Two independent sizes, both device-local, both in the Appearance section of
the settings panel. Browser zoom is the thing they replace, and it cannot do
this: it scales the document and the chrome together.

- **Editor text size**, 9-32 px. Writes `--editor-font-size` on `:root`. The
  CodeMirror theme reads that variable instead of a literal
  (`editor/editor.js`), so a change is one style write. CodeMirror is never
  reconfigured, and the text, the selection and the undo history survive it.
  Twemoji widgets are already sized in `em`, so they follow for free.
- **Interface text size**, 70-200 %. Writes `--ui-scale` on `:root`. Every
  size in `app.css` is `calc(Npx * var(--ui-scale))`, so one number turns the
  whole chrome. Boxes scale with the type they hold (row heights, the sidebar
  width fallback, the drawer, the menu, the tree indent), or a bigger label
  would clip inside a fixed row.
- `app.css` carries a named type scale for this: `--ui-xs/sm/md/base` for
  words, `--ui-icon/icon-lg/plus` for glyphs. px steps, not rem: the editor is
  exactly the thing that must not follow the root em.
- `ui/textsize.js` owns both keys in localStorage and registers
  `view.editorFontSize` and `view.uiScale`. An inline script in the head of
  `index.html` replays the stored values before the first paint, because a
  module script is deferred and the app would otherwise flash at the default
  size. That script is the only other reader of the two keys.
- The phone input floor stays: `max(16px, var(--ui-base))`, so a smaller
  interface scale can never drop a field under the size at which iOS Safari
  zooms the page in.
- No keyboard shortcut. Ctrl and Cmd belong to the browser, and Alt is spent
  on the chords that already exist.

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

### Czech via Hunspell, per paragraph (agreed 2026-09-08, shipped)

- Engine: Hunspell compiled to wasm (`hunspell-wasm`, vendored, main
  thread) with the `dictionary-cs` word list. Lazy: the dictionary loads on
  the first Czech paragraph, so an English-only user never fetches it.
- Language detection is natural-language detection, separate from the
  syntax detection of §9 and living in `editor/textlang.js`. Unit: the
  paragraph (a blank-line separated block), because notes mix languages. The
  signals, strongest first: letters that exist in Czech and not in English
  (count double), function words of either language (words common to both,
  like "a", "to", "on", "my", count for nobody), and word-initial consonant
  clusters English never uses ("ml-", "zv-", "kt-") for Czech typed without
  diacritics. A paragraph with no signal inherits the document's verdict; a
  document with none is English. Nothing is stored: detection runs inside
  the lint pass, which is already debounced.
- Routing: Harper lints the document with the Czech paragraphs blanked to
  spaces (same length, same line breaks, so offsets need no mapping and
  Harper keeps its context). Hunspell gets the Czech paragraphs tokenized in
  the app, with inline code, URLs, emails, link targets, HTML tags, acronyms
  and digit-glued tokens skipped. Fenced code blocks reach neither engine.
- Suggestions are the expensive call (up to 55 ms a word), so they are cached
  per word and computed under a 60 ms budget per pass; the rest fill in idle
  time and the pass re-runs. A pasted page of Czech never freezes the editor.
- One toggle for both languages (`spell.toggle`, the statusbar button, the
  settings row). The statusbar label shows what the pass found in the active
  buffer: "cs", "en", "cs+en". A manual per-document language override and a
  custom dictionary are later work.

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
- Sync is optional; the app is fully functional with no server configured.
- Sync is per document, as a server target (decided 2026-09-02, replaces
  "scratch-only sync first"). Default off on desktop, on for phones.
  Folder and device switches set the flag in bulk; folder sync is a later phase.
- Sidebar collapse: one state, two layouts (docked and drawer), 700px
  breakpoint. The stored preference is a wide-screen one; a phone always
  starts on the editor (decided 2026-09-02).
- Row menu on every buffer row. Sync and encryption appear there disabled
  until their engines ship, rather than as flags nothing acts on
  (decided 2026-09-02).
- Rename writes `title` for a scratch buffer and moves the real file for a
  file-backed one. Where the browser cannot move a file, the app offers no
  rename at all (decided 2026-09-02).
- Tombstones have two kinds, delete and detach.
- JSDoc types with `// @ts-check`, no TypeScript files, no build step.
- Sidebar future (section 9): section-based sidebar, fractional `order` rank,
  `starred` flag, age grouping derived at render time, never stored.
- Twemoji per section 10: vendored SVGs, CM widget decorations,
  runtime-cached (not precached), text fallback on missing asset.
- Harper per section 11: vendored WASM (precached), @codemirror/lint
  integration with quick fixes, lazy load, default on with toggle.
- Settings: one bottom-of-sidebar button opens an overlay panel over the
  editor (section 9). Declarative items, commands do the mutations.

- Step 3 build plan (2026-09-02, section 13): the age vendor tree uses
  rewritten relative imports, no import map, because workers ignore import
  maps and unlock must run in a worker. The device list is a hidden synced
  record of kind `keyring`, merged by union, never forked. Conflict copies
  never sync by themselves. `.age` files from disk are read in both age
  encodings and written back armored. Encrypting a file-backed doc, folder
  sync, and device removal are later phases.
- Shipped 2026-09-02: units 1 to 4 of section 13 are on main. Review
  decisions on the way: the plaintext label of an encrypted doc is asked for
  at encrypt time (prefilled with the first line, may be empty), never
  derived, because it is stored unencrypted on the server; a LockedError
  while the keyring is unlocked is the courier case and never re-prompts;
  a remote tombstone never removes a record without a sync target; a freshly
  attached record (rev 0) ignores tombstones; one device id for keyring and
  sync (model/device.js).

- Text size (2026-09-13, §9): two device-local settings, one for the editor
  document and one for the interface, rather than one number or browser zoom.
  Both are CSS custom properties on `:root`; the chrome multiplies a single
  `--ui-scale` and the editor theme reads `--editor-font-size`. Never synced:
  a phone and a desktop monitor want different numbers.

- Czech spellcheck (2026-09-08, §11): Hunspell in wasm next to Harper,
  language decided per paragraph by `editor/textlang.js`, never stored;
  Harper sees the document with Czech paragraphs blanked, so offsets are
  shared; one toggle for both languages; the Czech dictionary loads lazily.

- Workspaces (2026-09-21, §14): every window is a workspace with its own
  ordered tabs, active buffer, and folders. One buffer and one folder live
  in exactly one workspace; opening a doc elsewhere focuses the owning
  window. Closing a secondary window dissolves its workspace to Recent;
  quitting keeps all workspaces, and the wrapper restores them. The
  workspace store never syncs. Window identity is the URL (`?ws=`).
  Membership in `tabs` replaces the `closed` flag (v4 migration).
  Prerequisite fixes ship with it: sync leader via `navigator.locks`,
  `BroadcastChannel` updates, `versionchange` handling.

- Desktop shell, unit 1 (2026-09-21, §15): the Tauri scaffold with the three
  chords as native menu accelerators, forwarded to the page as DOM events.
  Ctrl+S saves to file: flush both debounces, or open the picker for a
  buffer that has no file. The page never imports Tauri. Bundle identifier
  `io.github.urza.vrtti`, fixed. Builds come from CI, unsigned, at the
  `desktop-latest` prerelease.

Open: none.

## 13. Step 3 build plan: crypto and sync (2026-09-02)

This section turns sections 3, 5, and 7 into build units. Each unit is one
agent brief, one review, one Playwright gate, one push. Units 1 and 3 have no
shared files and run in parallel. Units 2 and 4 wait for the sidebar work
(collapse and row menu) because they touch the same files.

### 13.1 Vendoring typage (unit 1)

Import maps apply to the window only. A dedicated worker ignores them, and
the unlock step must run in a worker (section 5, prototype findings). So the
age family is vendored with its bare specifiers rewritten to relative paths
at vendor time, and the import map gets no entries for it.

- New script `app/tools/vendor_age.py`, a port of `crypto-proto/vendor.sh`
  with the same pins (age-encryption 0.3.1, @noble/hashes 2.0.1,
  @noble/curves 2.0.1, @noble/ciphers 2.4.0, @noble/post-quantum 0.5.4,
  @scure/base 2.4.0) and the same flat-tree reason in a comment.
- Output under `app/vendor/<package>/`, same layout as the other vendored
  packages: `app/vendor/@noble/hashes/sha2.js`, `app/vendor/@scure/base/index.js`,
  `app/vendor/age-encryption/index.js` (typage's `dist/` flattened).
- Rewrite rule, applied to every `import`/`export ... from` in the tree:
  `@noble/hashes/sha2.js` becomes the relative path from the importing file
  to `app/vendor/@noble/hashes/sha2.js`. An extensionless subpath such as
  `@noble/hashes/sha2` gets `.js`. A package root (`@scure/base`,
  `age-encryption`) maps to that package's `index.js`. After the rewrite no
  bare specifier may remain in the tree; the script asserts it.
- `app/tools/check_imports.py` already resolves relative imports and must
  pass. `gen_sw.py` precaches everything under `app/vendor/` by default, so
  all 67 files land in the precache with no edit.
- Pins go into `versions.json` (merged, not overwritten) and `VENDOR.md`
  (BSD-3-Clause for typage, MIT for noble and scure).

### 13.2 Crypto modules (unit 1)

Ports of `crypto-proto/js/age.js`, `codec.js`, `keyring.js` with these changes:

- `app/js/crypto/age.js` imports `../../vendor/age-encryption/index.js` by
  relative path. It is the only file that names typage.
- `app/js/crypto/unlock.worker.js`, a module worker with two jobs:
  `wrap { identity, passphrase, workFactor }` returns armored ciphertext, and
  `unwrap { wrapped, passphrase }` returns the identity string. The caller
  creates a fresh worker per job and terminates it when the job ends, so the
  passphrase and the identity string die with the worker. If `Worker` is
  missing or fails, the same functions run on the main thread.
- `app/js/crypto/keyring.js` stores `StoredKeyring` in the IndexedDB
  `settings` store under key `keyring`. Peer devices come from the keyring
  record (13.3), not from localStorage. `recipientsFor(preset)` resolves
  `this-device` to own + recovery and `all-devices` to every device in the
  keyring record + recovery. Unlock imports the identity as a non-extractable
  CryptoKey where WebCrypto has X25519 (Chrome and Safari 17+ do), else keeps
  the string.
- `app/js/model/codec.js`: `encode(text, enc, keyring)` and
  `decode(content, enc, keyring)`. `enc` carries the preset only; the codec
  resolves recipients through the keyring at encrypt time. `LockedError` is
  the one signal for "locked" and for "this device is not a recipient".
- IndexedDB v3 migration: new store `settings` (`keyPath: "key"`, records
  `{ key, value }`) with `getSetting`, `putSetting`, `deleteSetting`. Typedefs
  gain `enc`, `sync`, `title`, and the `keyring` kind (section 7).
- Commands: `crypto.setup`, `crypto.unlock`, `crypto.lock`. Settings panel
  gains the Security section: state row, device name, device key, recovery
  key, setup/unlock/lock actions. `ui/dialog.js` provides the passphrase
  prompt, the one-time recovery key display with a copy button and an
  "I wrote it down" confirmation, and a preset chooser. Native `<dialog>`,
  no library.
- Setup on a device that already sees a keyring record (pulled by sync) reuses
  its recovery recipients and adds itself. Setup with no keyring record
  generates the recovery identity. Two devices set up before sync therefore
  hold two recovery recipients; the merge keeps both, and every recipient
  set includes all of them. Either paper key restores everything.

### 13.3 Keyring record

The device list is one hidden buffer record, `id: "keyring"`,
`kind: "keyring"`, JSON content:

```
{ v: 1, devices: [{ id, name, recipient, addedAt }], recovery: [recipient] }
```

It syncs like any other record once sync is configured and the keyring is set
up. It is the only record with a merge rule: on a pull conflict the store
unions devices and recovery recipients instead of forking, and re-pushes when
the union differs from the incoming version. Without sync the record is local
and holds one device. The sidebar, Recent, and search filter it out by kind.

### 13.4 Codec in the store (unit 2)

- The record keeps ciphertext. The store holds decoded text for unlocked
  encrypted docs in an in-memory map, cleared on lock. `updateContent`
  compares against that map for encrypted docs.
- Encoding happens in the persist step (the 300 ms debounce), not per
  keystroke. `sync.dirty` is set in the same step, after the codec, never in
  `updateContent`, so a push always reads the ciphertext that matches.
- `store.textOf(id)` returns a string for plaintext docs and a Promise for
  encrypted ones. The editor shows a locked placeholder state while decoding
  and dispatches `crypto.unlock` on `LockedError`. After unlock the store
  emits `unlock`; the editor re-activates the current doc.
- `crypto.lock` clears the plaintext map and emits `lock`; the editor drops
  the cached states of encrypted docs and shows the placeholder for the
  active one.
- Commands `doc.encrypt` (preset chooser, requires unlock, asks for the
  plaintext label prefilled with the first line, sets `enc`, re-encodes, sets
  `sync.purge` when synced) and `doc.decrypt` (keeps the label). This round they apply to scratch docs only.
  Encrypting a file-backed doc (rename to `.age` on disk) is a later unit.
- `.age` files opened from disk: `readFile` gains a bytes path. Armored text
  stays as is; binary age gets armored into the record. The doc gets
  `enc: { v: 1, preset: "all-devices" }` and decodes on open. Writes go back
  armored. The age CLI reads both encodings, so nothing is lost.
- Sidebar rows of encrypted docs show a lock mark and the `title`.

### 13.5 Server (unit 3)

`server/Vrtti.Server`, ASP.NET Core minimal API on .NET 10, raw
`Microsoft.Data.Sqlite`, no EF. `server/Vrtti.Server.Tests` with xunit and
`WebApplicationFactory`. `server/Dockerfile`, `server/README.md`.

Config by environment: `VRTTI_TOKEN` (required), `VRTTI_DB` (default
`./data/vrtti.db`), `VRTTI_ORIGINS` (comma list, default
`https://urza.github.io`). HTTPS is the reverse proxy's job.

Schema, WAL mode:

```
revisions(seq INTEGER PRIMARY KEY AUTOINCREMENT, doc_id TEXT NOT NULL,
          rev INTEGER NOT NULL, kind TEXT NOT NULL, content TEXT, meta TEXT,
          device_id TEXT NOT NULL, client_time INTEGER NOT NULL,
          server_time INTEGER NOT NULL, UNIQUE(doc_id, rev))
index revisions_doc(doc_id, seq)
```

Endpoints under `/api`, bearer token on all but health, constant-time compare,
CORS allows the configured origins with the Authorization header:

- `GET /health` -> `{ ok: true }`.
- `GET /changes?since=<seq>&limit=<n, max 500>` -> `{ changes, next, more }`.
  Returns the newest revision per doc among rows with `seq > since`, ordered
  by seq. `next` is the largest seq returned. Paging by `next` is correct
  because a doc whose newest row is beyond the page is still beyond `next`.
- `POST /docs/{id}/revisions` body
  `{ baseRev, kind, content, meta, deviceId, clientTime }` -> 201
  `{ rev, seq }`. When `baseRev` is a number and differs from the current rev,
  409 with `{ current }`. `baseRev: null` means "attach without a claim" and
  always appends. One `BEGIN IMMEDIATE` transaction per push.
- `GET /docs/{id}` -> current revision, 404 when unknown.
- `GET /docs/{id}/revisions` -> metadata list, newest first, no content.
- `GET /docs/{id}/revisions/{rev}` -> one full revision.
- `DELETE /docs/{id}/revisions?below=<rev>` -> `{ purged }`.

Purge only removes rows with lower seq than the newest, so no cursor moves
backward. Body limit 10 MB. `meta` is stored as JSON text and returned as a
JSON object.

### 13.6 Sync client (unit 4)

`app/js/sync/client.js`, inert until `sync.config` `{ url, token }` exists in
the settings store. `sync.deviceId` is minted once. `sync.cursor` is the seq.

- `syncNow()` is single-flight: pull, then push. A request during a run
  queues one more run.
- Triggers: after `store.start()`, `visibilitychange` to visible, `online`,
  a 60 s timer, and a 2 s debounce after any store `change` that leaves a
  dirty synced record.
- Pull applies each change through `store.applyRemote(change)`:
  - `rev <= sync.rev`: skip (own echo).
  - local dirty: `forkConflict` first, then adopt. Conflict copies never get
    a sync target by themselves.
  - local record without `sync` (detached earlier): re-attach; fork the local
    copy when its content differs from the incoming one.
  - no local record: create a scratch record from the change, open, synced.
  - `deleted`: fork when dirty, then delete locally. `detached`: drop `sync`.
  - kind `keyring`: union merge (13.3).
  - Adopting sets content, meta, `sync = { rev, dirty: false }`, `updatedAt`,
    emits `replace` when the doc is live and `change` always, and triggers the
    disk write-behind for file-backed docs.
- Push walks records with `sync.dirty`. Body `baseRev: sync.rev` (null on
  first attach). 201 sets `rev` and clears `dirty`; a tombstone push then
  drops `sync`. 409 feeds `current` into `applyRemote`. After a push of a
  record with `purge`, call the purge endpoint with `below: rev` and clear it.
- age wraps a fresh file key per save, so ciphertext differs on every push
  even when the text did not change. No "skip if unchanged" by bytes, ever.
- Status events `{ state: 'off' | 'idle' | 'syncing' | 'error' | 'offline',
  message, lastSyncAt }` drive a statusbar element; click runs `sync.now`.
- Commands: `doc.sync.on`, `doc.sync.off` (pushes a `detached` tombstone),
  `sync.now`, `sync.all` (attach every open doc), `doc.history`.
- Settings Sync section: server URL and token as text rows (the panel gains a
  `text` item kind, password style for the token), status row, "Test
  connection", "New docs sync by default" (unset means the platform default:
  on when `(pointer: coarse)` matches and the File System Access API is
  absent), "Sync all current docs", "Sync now".
- New docs get `sync` at creation when the default is on.
- History: `doc.history` opens a dialog listing revisions (time, device, size,
  kind); "open as copy" creates a scratch buffer from that revision, decoded
  through the codec when encrypted.
- The service worker must not touch cross-origin requests; verify in unit 4.

## 14. Workspaces: the multi-window model (agreed 2026-09-21)

The desktop wrapper (desktop-wrapper.md) brings real multi-window. Each
window must carry its own context, like a Sublime Text window: its own tabs,
its own active buffer, its own opened folders, and later its own
search-in-files scope. The context object is called a **workspace**. The
model lives in the app, not in the wrapper, because every window shares one
IndexedDB origin.

Workspace record, in a new object store:

```
{ id, tabs: [bufferId...], activeId, folderIds: [...], createdAt }
```

The record buys three things beyond multi-window:

- `tabs` is a real ordered list. Today "open" order is `createdAt` and
  cannot change.
- `activeId` replaces the global localStorage key `vrtti.activeBuffer`,
  which today is one pointer for the whole origin.
- Folders become workspace property. Search in files then has a natural
  scope: the workspace tabs plus its folders.

### Rules

- **One buffer lives in exactly one workspace.** Opening a doc that is open
  in another workspace focuses that window instead. This keeps the write
  pipeline single-writer: only the owning window runs the IndexedDB and
  disk debounces for a buffer. Most of the multi-instance danger (section
  "Coordination" below) disappears with this one rule.
- A folder also lives in exactly one workspace.
- The buffer pool stays global. Recent shows the closed buffers of all
  workspaces. Membership in a workspace `tabs` list is the single truth for
  "open"; the `closed` flag on the buffer record is dropped.
- Closing a secondary window dissolves its workspace: the tabs go to
  Recent, the record is deleted. Nothing is lost and nothing prompts.
  Quitting the app is different: all workspace records stay, and the
  wrapper reopens one window per workspace at the next launch.
- The main workspace is never dissolved. It is the window the taskbar icon
  opens, and it holds the scratch buffers, as the single window does today.
- Workspace records never sync. This follows the existing per-device rule
  by omission (`closed`, `file`, `sync.*`), and folder paths are
  machine-specific anyway.
- A doc that arrives from sync opens in the main workspace, as today.

### Window identity

The page reads `?ws=<id>` at boot. No parameter means the main workspace.
The wrapper opens each window at its workspace URL. This is the goose
pattern (desktop-wrapper-goose-patterns.md, sections 2 and 10): window
identity is the URL, and per-window state needs no IPC round-trip.

A plain browser tab with `?ws=` is a window too. The whole model builds and
tests in the browser, with Playwright driving two tabs, before any Tauri
work. Without the wrapper, only the main workspace opens by itself; the
others wait for their windows.

### Coordination (prerequisite, absent today)

Two views on the origin corrupt each other today: whole-record puts from
stale in-memory Maps, a conflict-copy storm from doubled disk debounces,
and two sync clients clobbering one cursor. The workspace unit must ship
these fixes with the model:

- The ownership rule above gives every buffer one writer.
- Exactly one window runs the sync client, elected with `navigator.locks`.
  When that window closes, another takes the lock and continues.
- Windows announce record and workspace changes on a `BroadcastChannel`.
  Each window patches its in-memory Map from the message instead of
  re-reading the store. Keyring, settings, and Recent changes travel the
  same channel.
- `openDb` gets `versionchange` and `onblocked` handlers, so a schema
  upgrade survives open windows (today the connection is cached forever).

### Migration (IndexedDB v4)

- Create the `workspaces` store and one main workspace.
- Buffers with `closed: false` become the main workspace `tabs`, ordered by
  `createdAt`. The `closed` field is removed from buffer records.
- `vrtti.activeBuffer` from localStorage seeds the main `activeId`, then
  the key is deleted.
- Existing directory handles attach to the main workspace `folderIds`.

### Naming

The model and the command ids say workspace: `workspace.new`,
`workspace.close`. The native menu says "New Window", because the OS object
is a window. The label is cheap to change; the command ids are not.

### The workflow this serves (user, 2026-09-22)

The main window is the notes scratchpad: buffers that rarely touch disk
and must come back after every restart, which the store gives them. A
second window is a work session on one folder (a documentation tree, for
example): opened with the folder button, files edited and added and saved
to disk there, searched there, and closed with Ctrl+Shift+W when the work
is done. Closing dissolves the workspace: its tabs go to Recent, and a
folder no other workspace lists loses its handle, so folder windows can
come and go without piling up handles. Search in files, below, is the one
piece of that workflow still missing.

### Search in files (planned in §16)

Scope: the workspace tabs plus its folders. On Chromium the folder files
are readable through the stored FSA handles. On macOS and Linux it waits
for the wrapper's native disk backend (desktop-wrapper-goose-patterns.md,
section 4). It is not part of the workspace build unit.

### 14.1 Schema and store (unit 1: one window, new model)

Ships alone and changes nothing visible. Every later unit builds on it.
Shipped 2026-09-21; the gate ran 47 checks across migration, fresh install,
single-window regressions, a second `?ws=` tab, sync arrivals and folders.
One rule was added on the way: a window that writes another workspace's
record (a synced doc landing in main from a `?ws=` window) re-reads that
record from IndexedDB first, because its Map copy can be stale.

- **IndexedDB v4.** New store `workspaces`, keyPath `id`. The upgrade
  handler gets `oldVersion` branches for the first time: under 4, it reads
  every buffer on the upgrade transaction, builds the main workspace
  (`id: "main"`, `tabs` = buffers with `closed !== true` and a document
  kind, ordered by `createdAt`, `folderIds` = every directory handle,
  `activeId` = `localStorage["vrtti.activeBuffer"]` when it is in `tabs`),
  rewrites each buffer without `closed`, and deletes the localStorage key.
  `openDb` gets `db.onversionchange` (close, drop the cached promise, fire a
  `vrtti:db-versionchange` window event that main.js answers with a reload,
  because a newer build in another window owns the schema now) and
  `req.onblocked` (log and wait: the other windows close on versionchange).
- **`model/workspace.js`**, `createWorkspaces({ id })`. Reads `?ws=` at
  boot in main.js; no parameter means `"main"`. Holds every workspace
  record in a Map (all windows load all records; unit 14.2 keeps them
  patched). API: `id`, `current()`, `all()`, `ownerOf(bufferId)`,
  `setTabs(tabs)`, `setActive(id)`, `addFolder(id)`, `removeFolder(id)`,
  `create()`, `dissolve(id)`, `load()`, `events`. A missing record for a
  `?ws=` id is created empty, so a stale link still opens a window. Every
  write goes through one `save(record)` that puts and (14.2) posts.
- **docs.js.** `createDocStore` takes `workspaces`. `openBuffers()` is the
  current workspace's `tabs`, in tab order; `closedBuffers()` is every
  document in no workspace, newest `updatedAt` first. `create` appends to
  `tabs` and activates; `close` removes from `tabs` and activates the
  neighbour; `reopen` appends; `activate` writes `workspace.activeId`.
  `createFromFile` and `applyRemote` use the same three. `newBufferRecord`
  loses `closed`; the keyring record never enters `tabs`. `start()` takes
  the active buffer from the workspace record.
- **folders.js.** `createFolderStore({ workspaces })`. `openFolders()`
  filters the handle store by the workspace's `folderIds`; `openFolder`
  adds the id, `closeFolder` removes it and deletes the handle only when
  no other workspace lists it.
- **Gate.** A seeded v3 database (open, closed and keyring records, a
  directory handle, the localStorage key) migrates to the expected main
  record; the single-window suite stays green; a `?ws=<new>` tab boots
  with one fresh scratch buffer and a separate Open list.

### 14.2 Windows talk (unit 2: two tabs in a browser)

Shipped 2026-09-21; the gate drove two pages through 34 checks (live Recent,
reopen and focus, content and rename relay, folder handle relay, settings
relay, delete eviction, sync lock handover, close-versus-reload grace, the
new-window button and chord) plus the 47 of unit 14.1. The sync lock from
14.3 ships here already: only the lock holder runs the schedule.

- **`model/channel.js`.** One `BroadcastChannel("vrtti")`, a random
  `windowId`, `post(type, payload)` and `on(type, handler)`. Messages:
  `buffer` (a record after a local put), `buffer-deleted`, `workspace`,
  `workspace-deleted`, `handle` (added or removed), `setting` (key),
  `focus` (workspace id), `window-closed` (workspace id). Units 14.3 and
  14.4 add theirs. A window patches its Maps from the payload and emits
  `change`, so the UI re-renders without a store read.
- **Ownership at the edges.** A window writes only its own workspace
  record and the buffers in its `tabs`. Buffers in Recent belong to nobody
  and any window may write them. `buffer.activate`, `buffer.reopen` and
  the file dedupe in `createFromFile` ask `ownerOf`: another workspace
  means post `focus` (and, in the shell, unit 14.4 brings the window up);
  no owner means take it. If two windows take the same Recent buffer at
  once, main keeps it, and between two secondary workspaces the smaller id
  keeps it: both windows run the rule on the other's record and must reach
  the same answer, and a timestamp rule failed that (each window bumps its
  own record twice while the other's message is in flight).
- **Commands.** `workspace.new` creates a record and opens its window: in
  a browser `window.open(url + "?ws=" + id, "vrtti-ws-" + id)` from the
  user gesture, in the shell through the bridge (14.4). `workspace.close`
  closes this window. `workspace.dissolve(id)` moves the tabs to Recent and
  deletes the record; main is never dissolved. Browser chord
  `Alt+Shift+KeyN`, which needs `Shift` in the chord grammar of
  `ui/shortcuts.js`. The sidebar gets a "new window" button next to the
  file buttons, visible on every platform.
- **Browser close.** `pagehide` posts `window-closed`. The main window
  waits five seconds, then dissolves the workspace unless
  `navigator.locks.query()` shows its `ws:<id>` lock held again, which is
  a reload. Every window holds `ws:<id>` for its lifetime. The shell skips
  this path; there the shell decides (14.4).
- **Gate.** Two pages in one Playwright context: a buffer created in A is
  absent from B; closed in A, it appears in B's Recent; reopened in B, it
  leaves A's Recent; a rename in B of a Recent buffer shows in A without a
  reload; a folder opened in A is not in B; closing B's tab dissolves its
  workspace into Recent after the grace; a reload of B keeps it.

### 14.3 One sync client (unit 3)

Shipped 2026-09-21; the gate ran 32 checks against an in-memory mock of the
sync API: leader and mirror, a non-leader's edit pushed with the owner
keeping the books, a routed change landing in the owner's editor in under
ten milliseconds, fork on dirty in the owner, an unknown doc routed to
main and its delete, the two-second ack timeout fallback, unlock and lock
travelling to a third window, the duplicated-tab redirect, and the lock
handover when the leader closes.

- **Leader.** `navigator.locks.request("vrtti:sync", () => hold)`. The
  holder runs the client as today; the others only `load()` the config and
  show a relayed status. When the leader window closes, the next request
  in line gets the lock and starts. Non-leaders post `sync-request` for
  "sync now" and `setting` after configure; the leader reloads its config
  on `setting`.
- **Routing keeps one writer.** The leader pulls. A change for a buffer in
  its own `tabs` or in Recent applies locally through `applyRemote`, as
  today. A change for a buffer owned by another live window travels as
  `remote-change` to that window, which runs its own `applyRemote`
  (the fork-on-dirty rule then sees the real in-memory text). An unknown
  doc goes to main the same way; when main is not live, the leader creates
  it and edits main's record, which is allowed because no window holds it.
  Pushes read the leader's Map, which the owners keep current with their
  `buffer` messages. After a push of a buffer it does not own, the leader
  posts `pushed` `{ id, rev, sentUpdatedAt }` and the owner runs
  `afterPush`, whose `sentUpdatedAt` guard already protects a newer edit.
  The cursor stays one settings row, written by the leader only.
- **Two rules the build added.** The leader waits two seconds for the
  owner's `remote-applied`; a window that is frozen or gone answers nothing,
  and the leader then applies the change itself, which the owner takes as
  an external replace when it wakes (the 14.2 path stays as the fallback).
  And a duplicated tab would be a second window of one workspace, so a
  window that finds its `ws:<id>` lock already held at boot creates a fresh
  empty workspace and redirects itself to it before anything loads.
- **Unlock travels.** A window that unlocks the keyring posts `unlock`
  with the identity; a window that boots posts `who-is-unlocked` and takes
  the first answer. `CryptoKey` objects clone across same-origin contexts,
  so no secret is re-derived and no passphrase is asked twice.
- **Gate.** Two pages against the existing sync test surface: only one
  page's client runs; a dirty edit in the non-leader page reaches the
  server; a remote change for the non-leader's buffer lands in its editor;
  closing the leader page moves the lock and the schedule to the other.

### 14.4 The shell opens windows (unit 4)

Built 2026-09-21. The first Windows run froze both windows: a window
created inside a synchronous Tauri command deadlocks on Windows, which
tauri documents on its window builders. The two page commands are async
since 2026-09-22, and the real shell then passed the whole unit on Linux
under Xvfb (spike log in §15). Additions to the plan, the first from need
and the rest from the goose lifecycle patterns the first build had skipped
(desktop-wrapper-goose-patterns.md §1 and §2):

- A native "Close Window" item on `CmdOrCtrl+Shift+W`, because a page
  cannot close a window it did not open, and closing through the shell is
  what dissolves. It closes only a window that reports focus, never a
  guessed one. On Windows the accelerator never fires while the webview
  has focus (§15), which the user found: the chord did nothing and a
  leftover window could not be closed by keyboard. So the bridge's
  keydown fallback takes Ctrl+Shift+W too and asks the shell through a
  third command, `close_workspace`; the close still goes through the
  shell, so it still dissolves.
- Single instance on every platform through the plugin: a second launch
  hands off and exits; two processes on one WebView2 profile would not
  even open a webview.
- Window state by label through the plugin, so each workspace window
  remembers its bounds and the outer-versus-inner size trap stays with the
  plugin.
- The ready handshake: the shell queues a forwarded command per window
  until the page's bridge calls `page_ready`, and a page load starting
  again resets it. A chord during boot, or a dissolve sent to a main that
  is still loading, is no longer lost. An older page never calls it (the
  service worker or the CDN edge can serve one after a deploy), so eight
  seconds after a page load finishes the window counts as ready anyway;
  the harness found the shell deaf on the old page before that fallback.
- Window state is saved on every close request and on exit request, not
  only on the plugin's own exit event: closing the last window on Linux
  exited without that event and lost the bounds.
- macOS keeps running with no window and reopens main from the dock; the
  last window closing is not a quit there, Cmd+Q is.
- Windows other than in `setup` open from the async runtime, never from
  an event handler.
- A dissolved window writes nothing back. The dying window used to hear
  its own deletion, find itself with no tabs, create a scratch buffer by
  the "a window always has a buffer" rule, and write the record back with
  that tab, so the window returned at every launch (the user's report on
  2026-09-22). Now the workspace store refuses its own writes once
  dissolved, the doc store does no repair work in that state, and at
  launch main dissolves any leftover workspace that has no folders and
  nothing but blank scratch buffers.

- **Labels.** `main` for the main workspace, `ws-<id>` for the others. The
  window factory takes the workspace id and appends `?ws=`.
- **Page to shell.** The bridge (`ui/desktop.js`) calls two Tauri commands
  through `window.__TAURI__.core.invoke`, granted to the Pages origin in
  the capability: `open_workspace(id)` and `focus_workspace(id)`. That is
  the second and third IPC after the clipboard; the page still imports
  nothing from Tauri.
- **Launch.** The shell opens only main. Main's page, once loaded, asks for
  a window for every workspace whose `ws:<id>` lock nobody holds. Quit
  therefore restores every window, and a plain browser does the same thing
  with nothing, which is the rule of section 14.
- **Close.** On `CloseRequested` of a non-main window while another window
  exists, the shell runs `workspace.dissolve` in a surviving window (main
  first). The last window closing is a quit: nothing dissolves. The menu
  gets "New Window" on `CmdOrCtrl+Shift+N`; the bridge's keydown fallback
  learns Shift.
- **Gate.** Rust compiles for Linux and Windows here; the user runs it on
  Windows: New Window opens a second workspace, a buffer closed in one
  appears in the other's Recent, closing the second window dissolves it,
  quitting and relaunching restores both.

## 15. Desktop shell, unit 1: the scaffold and the three chords (2026-09-21)

The Tauri shell from desktop-wrapper-tauri-vs-wails.md §11 exists in
`src-tauri/`. It is the spike vehicle of §8 there, built so the user can run
the spike on a real desktop. Nothing of the editor moved into it.

What the unit contains:

- **The shell.** One window factory (`open_main_window`), one app menu with
  File > New, Save, Close on `CmdOrCtrl+N/S/W`, and one forwarder: a menu id
  becomes `webview.eval` of a `vrtti:command` DOM event. The window loads
  `https://urza.github.io/editor/`, so push-to-main still updates the desktop
  app. The web inspector stays enabled for the spike. On macOS the menu also
  carries the application and Edit submenus, because WKWebView has no
  Cmd+C/V/X/A without them.
- **The Debug menu** (`src-tauri/src/debug.rs`): Reload, Force update,
  Diagnostics, Open inspector. Added after the first run on Windows, where
  the shell showed the build from before the deploy and the update check
  said "up to date": the GitHub Pages edge caches every file for ten
  minutes, and a page served from the service worker cannot tell. Force
  update drops the service worker and its caches and reloads with a query
  string. Diagnostics shows page build, server build with the edge age,
  service worker state, cache names and the persistence answer. "Copy
  spike report to clipboard" adds the chord delivery log that a recorder,
  injected with the marker, keeps since launch: each menu event and each
  Ctrl+N/S/W keydown with whether the page handled it. That log answers
  spike steps 2 and 3 without the inspector. The clipboard write is the
  first Tauri IPC granted to the Pages origin (`remote.urls` in the
  capability); the page code itself still never imports Tauri.
- **The marker.** An initialization script sets `window.vrttiDesktop`
  before any page script. `model/capabilities.js` reads it into `isDesktop`.
- **The page bridge**, `ui/desktop.js`. It listens for `vrtti:command` and,
  as a fallback, for the same three chords on keydown. The first delivery
  runs the command; a repeat within 50 ms is dropped, because a platform may
  deliver a chord both ways. Every delivery logs its path to the console,
  which is spike steps 2 and 3 in one build.
- **`buffer.save`** and `store.saveNow(id)`. Ctrl+S flushes both debounces.
  A buffer without a disk file opens the picker where the platform has one,
  and elsewhere lands in IndexedDB and reports "saved".
- **CI.** `.github/workflows/desktop.yml` builds Windows, Linux and a
  universal macOS bundle on every push that touches `src-tauri/`, and
  uploads them to the `desktop-latest` prerelease under fixed file names.

Decided with this unit:

- The page never imports Tauri. The shell talks to the page through DOM
  events, and the page has no way to call the shell yet. The Tauri IPC comes
  with the disk backend, when the page needs to call native code, and it will
  be granted to the Pages origin through a capability with `remote.urls`.
- The bundle identifier is `io.github.urza.vrtti`. It names the app's data
  directory on every OS and never changes.
- The Edit submenu exists on macOS only. On Windows and Linux the webview
  owns the edit chords, and a menu copy would take them from CodeMirror.
- Tauri does not expose the WebView2 switch for browser accelerator keys, so
  on Windows they stay on. The page cancels Ctrl+S on keydown, which is what
  stops WebView2's own "save page" dialog. F5 and Ctrl+P remain the webview's.

The spike protocol, per OS (the order of §8 in the comparison doc):

1. Launch the binary. Open the inspector (Ctrl+Shift+I, on macOS
   Cmd+Option+I) and keep the console visible.
2. Press Ctrl+N, Ctrl+S, Ctrl+W. Each press must do the Sublime thing and
   log one `[vrtti desktop]` line. The line says `via menu` or `via keydown`;
   a second line marked `duplicate, dropped` is fine and is the answer to
   "does this platform deliver both".
3. Quit, disconnect the network, relaunch. The page must come up from the
   service worker cache.
4. In the console: `navigator.storage.persist()` must resolve to `true`.
5. Open a real file through the sidebar. Windows should work. macOS and
   Linux should fail, and that failure sizes the disk backend.
6. Type for ten minutes on Linux and watch for lost focus or a frozen caret.

Spike log:

- **Windows, 2026-09-21** (WebView2, Edge 153). All three chords work and
  arrive as keydown only: the native menu accelerator does not fire while
  the webview has focus, so the bridge's keydown fallback is the real path
  on Windows and its `preventDefault` holds (our save dialog opened, not
  WebView2's "save page"). Menu items work by mouse. `storage.persist()`
  is true. The File System Access API exists in WebView2, so real files
  work without a native backend. The offline start works: the page comes up
  from the service worker cache. A stored file handle survives a restart,
  but its permission does not: the row shows the reconnect marker and one
  click restores it. Chrome keeps that permission, WebView2 does not. That
  gap belongs to the disk backend unit, either through the native backend
  shared with macOS and Linux or through WebView2's
  `CreateWebFileSystemDirectoryHandle` (desktop-wrapper.md). The Windows
  spike is complete and passed.

- **Linux, 2026-09-22** (WebKitGTK 2.52, run in the sandbox under Xvfb
  through tauri-driver and WebKitWebDriver, real X key events via xdotool).
  The mirror image of Windows: every chord arrives as a `menu event` from
  the GTK accelerator and never reaches the page as a keydown, so the
  bridge's fallback is dead code there. Ctrl+S flushes and the status bar
  says "saved"; WebKitGTK has no save picker, as expected, and no File
  System Access API at all. New Window, the live Recent between windows,
  Close Window dissolving into Recent, and the restore of both windows
  after a quit all passed on the real process. The harness is repeatable
  (see the shell test notes in the session scratchpad; packages xvfb,
  webkitgtk-webdriver, dbus-x11, xdotool, plus `cargo install
  tauri-driver`). Still open on Linux: the ten-minute typing check for
  focus and caret faults, which needs a human.

After the spike: workspaces (§14) as the next unit, then the disk backend
(desktop-wrapper-goose-patterns.md §4).

## 16. Search in files (agreed 2026-09-22)

The one piece of the folder workflow (§14, "The workflow this serves")
still missing. Sublime's Ctrl+Shift+F, reduced to what a notes and
documentation tool needs: plain text, one workspace, results in the
sidebar, a click lands on the line.

Shipped 2026-09-22. The gate ran 17 checks on Chromium with the stub handle
layer (chord, Escape, grouping and counts over tabs and a seeded tree, the
skips, the reconnect note, the case toggle, tab and folder hits with the
selection set, the `?ws=` scope, the 390px drawer, the 1000-hit cap, a
cancelled scan) plus 10 harness self-checks. Three rules came out of the
review: `open()` runs a new `sidebar.show` command first, because a collapsed
sidebar or a closed drawer is inert and focus() into it does nothing; a tab
hit goes through `buffer.reopen`, never `buffer.activate`, because the rows
are a snapshot and the tab may be closed by the time it is clicked; a file
that fails to read (deleted since the listing) is skipped alone, not with its
whole folder.

### Rules

- **Scope is the workspace**: its tabs, then every file under its folders,
  in that order. Another workspace's tabs and folders are invisible, which
  §14 promised when folders became workspace property.
- **Plain text, case-insensitive by default**, one toggle for case. No
  regular expressions and no replace in this unit; both are cheap to add
  later and expensive to get wrong now.
- **Enter runs the search**, typing does not. The buffers are in memory,
  but the folders are disk reads through the File System Access API, and
  a live search would scan the tree on every keystroke. A new Enter
  cancels the running scan.
- **Locked documents stay out** (§5: search and spellcheck only see
  unlocked docs). An encrypted buffer is searched only while the store is
  unlocked. A LockedError on the way is the courier case: skip the
  document silently, never prompt.
- **A file that is an open tab is searched as the tab**, never twice: the
  tab holds the unsaved text, the disk holds the old one. The match key is
  the `file.path` string the sidebar builds, `<folder name>/<path>`.
- **Folder files are read on demand and filtered by content, not by
  name**: skip dot-directories (`.git`, `.obsidian`), skip `*.age` by name
  (§5, never attempt a decode), skip a file over 2 MB by `file.size`
  before reading, skip a file with a NUL byte in its first kilobyte (a
  binary). An extension list would be wrong for someone's notes; the NUL
  test is what grep does.
- **The folder listing cache is the truth**: `folders.entries()` without
  `force`, so search sees the tree the sidebar shows and never rebuilds
  it. A folder that needs the reconnect click lists nothing; the results
  say so per folder and offer the click. They never report zero hits for
  it.
- **Results are a snapshot.** Edits after the search do not move the rows;
  a stale line number lands nearby. The list is capped at 1000 hits and
  the summary says when the cap cut it.
- **Open at line goes through the commands** (`buffer.activate`,
  `folder.openFile`), never the store, so the one-workspace rule of §14
  holds: a hit whose buffer another window owns focuses that window.

### Where it lives

- The sidebar switches to a search view; the lists come back on Escape or
  the close button. The sidebar is the app's list column and is resizable,
  and under 700px it is the drawer, so a phone gets the same view and the
  drawer closes when a hit opens (`sidebar.autoclose`), as the rows do
  today.
- `ui/search.js`, `mountSearch({ store, folders, workspaces, editor })`
  returns `{ open, close, isOpen }`. It owns `#search-view` inside
  `#sidebar-scroll` and toggles the class `searching` on `#sidebar`;
  `app.css` hides the list sections under that class. `ui/sidebar.js`
  does not know the view exists.
- Command `search.inFiles`, chord `Ctrl+Shift+KeyF`. Open is idempotent:
  open and focus the field, never toggle. In the shell the chord can
  arrive twice, as a menu event on Linux and macOS and as a keydown on
  Windows (§15), and a toggle would open and close.
- `ui/shortcuts.js` learns `Ctrl+` chords. Today it returns on every
  Ctrl/Meta keydown, because the browser owns most of them. A chord
  declared with `Ctrl+` is matched; every other Ctrl chord still passes
  through. Ctrl+Shift+F is unbound in Chrome, Edge and Firefox. Meta
  stands in for Ctrl on macOS.
- The shell gets "Find in Files…" on `CmdOrCtrl+Shift+F`: one tuple in
  the `CHORDS` table of `src-tauri/src/lib.rs`, forwarded like the rest.
  The bridge's keydown fallback in `ui/desktop.js` stays out of it. It
  ignores codes outside its tables, and the page's own chord does the
  work on Windows.
- A "search" button in `#open-actions`, visible everywhere, for touch.
- The editor grows `reveal(id, { line, col, len })` on the controller
  that `mountEditor` returns; main.js finally keeps that return value. It
  selects the match and scrolls it to the centre once the view holds the
  state of that buffer. An encrypted buffer's state arrives after the
  decode, so the reveal waits for it instead of selecting inside the
  locked placeholder.

### View

Query field, an "Aa" toggle (`aria-pressed`), a Go button for touch, a
status line, then the list: one heading per file (the buffer title or the
folder path), one row per matching line with the line number and the
trimmed line, the first match wrapped in `<mark>`. Groups append as each
file finishes, so a slow folder shows its first hits early. The status
line ends with "N hits in M files", plus "K locked documents skipped" and
one "needs reconnect" line per such folder. Escape in the field closes
the view and returns focus to the editor.

### Gate

Playwright on Chromium with the stand-in handle layer (§14.1 gate notes).
The chord opens the view with focus in the field; Escape closes it and
the editor has focus. Two buffers with hits group and count correctly;
the case toggle changes the count. A hit click activates the buffer and
the editor's active line is the hit. A seeded folder tree with a nested
directory, a dot-directory, an `.age` file, a NUL-byte file and a 3 MB
file yields only the text hits, with folder paths; a click opens the file
as a tab at the line; a file already open as a tab is listed once, as the
tab. A locked encrypted buffer is skipped with the note. A folder without
permission shows the reconnect note. A `?ws=` tab sees only its own tabs
and folders. Under 700px the button opens the view in the drawer and a
hit closes the drawer. No console errors.

## 17. Native disk backend (agreed 2026-09-22)

Files and folders in the desktop shell go through Rust instead of the
browser's File System Access API. WebKit on macOS and Linux has no such
API at all (§15 spike log), and WebView2 on Windows forgets a stored
handle's permission at every restart, so every folder window opens with a
reconnect click. The research this unit applies: desktop-wrapper.md
("Disk files are the real work item"), desktop-wrapper-tauri-vs-wails.md
§4.4, and desktop-wrapper-goose-patterns.md §3 (the contract), §4 (the
three file implementations), §6 (config dir, env override, temp plus
rename), §8 (check the webview label on every command) and §9 (Windows
path traps).

Units 17.1 and 17.2 built 2026-09-22. The Rust side has ten cargo tests
(the path table, a symlink out of the root, the atomic write keeping
content and mode and leaving no temp file, a taken name on rename, the
roots round trip, a stale root, prune). The page gate ran 19 checks in
Chromium against a faked shell (pick, tree, open, the debounce reaching
`disk_write`, clean and dirty external changes, rename surviving a
reload, no reconnect row after a reload, prune with the live ids, a
cancelled picker, a file root, search over a native folder, `.age`
bytes, save-as through `disk_pick_save`, the plain browser build, two
tabs) plus the search-in-files gate. Two things came out of the review:
in the shell a reconnect is always a fresh pick, because the reconnect
row has exactly two causes there (a WebView2 handle from before the
backend, or a native root whose folder or file moved), and a native
handle whose command answers `notFound` gets that row, since its
permission always reads granted. The picker wait uses the plugin's
callback API with a one-slot channel, not `blocking_*`: the plugin runs
the dialog through `run_on_main_thread` and drops a refused dispatch
silently, which would leave a blocking call waiting forever; "no answer"
is folded into the cancel case instead.

Unit 17.3 ran 2026-09-22 on the real shell on Linux (WebKitGTK under
Xvfb, tauri-driver, the deployed page at cb9a257, hermetic XDG dirs,
`VRTTI_TEST_PICK` and `VRTTI_CONFIG_DIR` set): the folder button lists
the tree with the real path in the heading, a file opens, the debounce
puts the edit on disk with no temp file left, Ctrl+S is harmless, an
external overwrite reloads the clean buffer without a conflict copy,
search in files finds the hit and skips `.git` and `.age`, a quit and a
relaunch bring the folder back with no reconnect click, and a rename
moves the file. Ten of ten, no Rust or page fault in the log. Left: the
user's Windows run, and macOS when a Mac is at hand.

### Decisions

- **One backend for all three systems in the shell.** Windows takes the
  native path too, not `CreateWebFileSystemDirectoryHandle`: one code path
  to test, real paths on every platform, and no permission clicks anywhere.
  The browser PWA keeps the File System Access API unchanged.
- **The page keeps talking to handles.** Every store and UI module calls
  twelve methods on handle objects (`values`, `getDirectoryHandle`,
  `getFile` with `text`/`arrayBuffer`/`size`/`lastModified`,
  `createWritable` with `write`/`close`, `queryPermission`,
  `requestPermission`, `isSameEntry`, `move`, plus `name` and `kind`), all
  behind `storage/fsa.js`. The native backend is a class per handle kind
  with exactly that surface over Tauri IPC, in `storage/native.js`.
  `folders.js`, `docs.js`, `sidebar.js` and `search.js` do not change
  their handle code. This was the gate's stub handle layer (§16), made
  production.
- **A native handle is plain data with methods on the prototype:**
  `{ native: true, kind, name, root, rootPath, path }`. IndexedDB and the
  BroadcastChannel structured-clone it into that descriptor by themselves;
  the two read boundaries (`idb.js` handle reads, the `handle` channel
  message in `folders.js`) pass values through one `reviveHandle()` that
  turns a descriptor back into a live adapter. A real FSA handle passes
  through untouched.
- **Roots live on the Rust side.** The page never sends a path it did not
  get from Rust: a root is a folder or file the user picked, registered
  under an id in `roots.json` in the app config dir, written with the
  temp-plus-rename pattern and a pid suffix (goose §6). Every command
  names a root id and a relative path. Restart needs no click because
  the grant is the root record itself. The page prunes roots it no
  longer references once at boot (`disk_prune`), and Rust keeps any root
  younger than a minute, so a pick in flight in another window survives.
- **Paths are confined, medium weight** (goose §4: the openat walk is
  for attacker-picked paths; ours are user-picked). A relative path is
  validated without touching the disk (segments split on `/`; `.`, `..`,
  empty, NUL, and a backslash inside a segment are rejected), joined under
  the root, then the target's parent is canonicalized and must start with
  the root's canonical path, which catches a symlink pointing out.
  Canonical is compared to canonical, so Windows `\\?\` prefixes match.
- **Writes are atomic** (goose §4): a temp file `.<name>.tmp-<pid>-<n>`
  in the destination directory, write, `sync_all`, rename over the
  canonical target. An existing file keeps its permissions on Unix. A
  symlinked target is replaced through its one-hop resolution, so the
  user's symlink survives.
- **Errors are data** (goose §3): a command fails with
  `{ code, message, path }`, codes `unknownRoot`, `outsideRoot`,
  `notFound`, `permission`, `exists`, `io`. The adapter maps `notFound`
  to a `NotFoundError` DOMException and `permission` to
  `NotAllowedError`, because `folders.js` and `search.js` branch on those
  names today. A cancelled picker throws `AbortError`, which `main.js`
  reads as "user cancelled".
- **Every command checks provenance** (goose §8): the webview label is
  `main` or `ws-*`, on top of the capability's origin rule.
- **Mixed handles are allowed in the Windows shell.** Records made before
  this unit hold real WebView2 handles and keep working with the click.
  Their reconnect row in the shell runs the native picker instead of
  `requestPermission`, and the picked root replaces the handle under the
  same record id, so the workspace and the buffers that point at it stay
  intact. `isSameEntry` across the two families is `false` without a
  call, through one `sameEntry(a, b)` helper in `fsa.js`.
- **No file watching.** The mtime poll on focus and every 30 s stays
  (§2); `getFile()` on a native handle is one stat, so the poll is cheap.
  Directory trees still refresh on focus through the listing cache.
- **Test hooks from day one** (goose §6): `VRTTI_CONFIG_DIR` relocates
  `roots.json`, and `VRTTI_TEST_PICK=<path>` makes every picker return
  that path without a dialog. Both are read once at startup and are
  documented as test-only.
- **The page still imports nothing from Tauri.** `native.js` reads
  `window.__TAURI__.core.invoke` the way `ui/desktop.js` does. The
  dialog plugin is used from Rust only, so the capability grants the
  page nothing but our own `disk_*` commands.

### The contract

Rust commands, all `async`, camelCase payloads by `serde(rename_all)`:

```
disk_pick_folder()                 -> Root | null
disk_pick_file()                   -> Root | null
disk_pick_save(suggestedName)      -> Root | null       (file may not exist yet)
disk_list(root, path)              -> [{ name, kind }]  (kind: "file" | "directory"; other types skipped)
disk_stat(root, path)              -> { size, mtime }   (mtime in ms)
disk_read(root, path)              -> { text }          (UTF-8, lossy like File.text())
disk_read_bytes(root, path)        -> raw bytes         (tauri::ipc::Response)
disk_write(root, path, text)       -> { mtime }         (atomic, creates the file)
disk_rename(root, path, newName)   -> { path, name }    (same directory; `exists` when taken)
disk_prune(keep: [rootId])         -> dropped count

Root = { id, kind: "file" | "directory", name, path }   (path absolute, for display)
```

A file root (from `disk_pick_file` or `disk_pick_save`) allows only
`path: ""` operations on itself. A folder picked twice returns the same
root id, so `isSameEntry` on two picks is a field comparison.

JS: `storage/native.js` exports `pickFolder()`, `pickFile()`,
`pickSave(suggestedName)`, `reviveHandle(value)`, `isNativeHandle(value)`,
`pruneRoots(keepIds)`. The adapters: `NativeDirectoryHandle` (`values()`
lists through `disk_list` and yields child adapters; `getDirectoryHandle`
is pure, no IPC, existence is checked at listing time) and
`NativeFileHandle` (`getFile()` is one `disk_stat` and returns an object
whose `text()` and `arrayBuffer()` read on demand, so search's 2 MB
guard still runs before a read; `createWritable()` collects the string
and commits on `close()` through `disk_write`; `move(newName)` renames
and updates `name` and `path` in place, and the caller re-puts the handle
record). `capabilities.js` gains `hasDisk = isDesktop ||
hasFileSystemAccess`; every gate that today reads `hasFileSystemAccess`
for "can this device see disk" reads `hasDisk`. `fsa.js` picker wrappers
branch on `isDesktop` first, because WebView2 has both. A folder heading
and the "On disk" hover show the real path for a native handle.

### 17.1 Rust (unit 1)

`src-tauri/src/disk.rs`: the roots store (load at setup, `Mutex` in
managed state, `roots.json` with `{ version: 1, roots: [...] }`), path
validation and confinement, the atomic write, the ten commands, the
provenance check, `tauri-plugin-dialog` for the three pickers (Rust API
only), `fs-err` so every error names its path. `build.rs` lists the
commands, `capabilities/default.json` allows them. Before the first
build, grep the vendored plugin for its documented traps (a blocking
picker on the main thread, the `FilePath` type) and apply them. Cargo
tests: path validation table, symlink escape in a temp dir, atomic write
keeps content and permissions and leaves no temp file, rename refuses a
taken name, roots round-trip through `VRTTI_CONFIG_DIR`.

### 17.2 Page (unit 2)

`storage/native.js`, the two revive boundaries, the `fsa.js` picker
branch and `sameEntry`, `hasDisk`, the reconnect-to-native migration in
both stores, the prune call at boot in the shell, the real path in the
sidebar heading. Gate: Playwright in Chromium with a faked shell
(`window.vrttiDesktop` plus a mock `__TAURI__.core.invoke` that serves
the contract from an in-memory tree with mtimes), which also proves the
Windows precedence since headless Chromium has the browser API too. The
run: pick a folder, the tree lists, open a file, edit, the debounce
reaches `disk_write` with the text, an mtime bump on disk reloads a clean
buffer on focus and forks a dirty one, rename through the row menu,
search in files over the native folder, close the folder, reload the
page and the folder is back with no reconnect row, prune runs with the
right ids, `.age` bytes read through `disk_read_bytes`, a cancelled
picker logs nothing, and the plain browser suite of §14 stays green with
the shell absent.

### 17.3 Real shell

Linux under Xvfb through tauri-driver (§15 spike log recipe) with
`VRTTI_TEST_PICK` and `VRTTI_CONFIG_DIR` set: folder button, tree,
edit, the text on disk after the debounce, rename, quit and relaunch
with the folder back and no click. The user's Windows run passed on
2026-09-22 ("all looks good"). macOS when a Mac is at hand.

## 18. Shell auto-update (agreed 2026-09-22)

A push to main builds the shell for the three systems and replaces the
files on the `desktop-latest` release (desktop.yml), but nothing told an
installed shell about it; the user was running a hand-copied exe. The
updater plugin closes that loop. The research this applies:
desktop-wrapper-tauri-vs-wails.md §4.6 (the updater plugin wants a
signing key pair and a manifest, GitHub Releases hosts both) and
desktop-wrapper-goose-patterns.md §7 (one feature flag, an env kill
switch, quiet failures).

### Decisions

- **Signed by us, not by the platform.** The updater verifies every
  download against a minisign key built into the app. The pair was
  generated 2026-09-22: the private half is `src-tauri/updater.key`,
  gitignored, and the user keeps it (losing it strands every installed
  shell on its version); the public half is `plugins.updater.pubkey` in
  tauri.conf.json. CI signs when the `TAURI_SIGNING_PRIVATE_KEY` secret is
  present and otherwise builds as before without updater artifacts, so a
  missing secret degrades to today's release instead of a red build.
  Authenticode and notarization stay out; the first-launch warning stays.
- **Version = `0.1.<run number>`**, set at build time by
  `cargo tauri build --config '{"version": …}'`. A local build stays
  `0.1.0`, so it never outranks an installed CI build. Every place that
  shows a version reads `app.package_info().version`, the page's
  `vrttiDesktop.version` included, so nothing says `CARGO_PKG_VERSION`
  any more.
- **One manifest per platform key on the release**:
  `latest-windows-x86_64.json`, `latest-linux-x86_64.json`,
  `latest-darwin-aarch64.json` and `latest-darwin-x86_64.json` (the
  universal app serves both), each in the plugin's single-platform format
  (`version`, `pub_date`, `url`, `signature`, `notes`). The endpoint is
  `.../desktop-latest/latest-{{target}}-{{arch}}.json`, which the plugin
  fills in. Each build job writes its own manifest, so a platform whose
  build failed keeps its previous file and its previous manifest, and
  nothing merges. The first plan said one merged `latest.json`; the plugin
  reads one `version` per manifest, so a merged file would send a shell
  whose platform failed to build after its own old file at every check
  and ask again every six hours. The script is
  `src-tauri/tools/latest-json.sh` (jq), testable with a fake `.sig`.
- **The updater artifacts** are the NSIS installer (`vrtti-setup.exe`),
  the AppImage (`vrtti-linux-x86_64.AppImage`) and the app archive
  (`vrtti-macos-universal.app.tar.gz`), each with its `.sig` next to it,
  all under the fixed names the release already uses. The bare exe, the
  deb and the dmg stay for hand installs. On Windows the updater replaces
  an installed app, so the user installs once through `vrtti-setup.exe`
  and runs it from the Start menu; a bare exe in a folder never updates
  itself. `installMode: passive`.
- **A copy that cannot replace itself makes no automatic check.** On
  Windows that is a bare exe (no `uninstall.exe` beside it, which only the
  NSIS install writes); on Linux the deb or the bare binary (no
  `APPIMAGE` in the environment). The updater would otherwise install a
  second copy elsewhere, or write the AppImage over the binary, and ask
  again at every check. Help > Check for updates… explains instead.
- **Check at launch and every six hours**, ten seconds after launch so
  boot is not slowed, on a plain thread in `src-tauri/src/update.rs`.
  A newer version is downloaded in the background first; only then a
  native dialog asks "vrtti <version> is ready. Restart now?" with
  "Restart now" and "Later". Later keeps the download in memory and asks
  again at the next check (a newer release drops it). Restart saves the
  window bounds, installs and relaunches; on Windows the plugin hands over
  to the installer and exits the process itself. Every failure (offline,
  a bad signature, a missing platform key) is one log line and no dialog,
  because an editor must never nag about the network. One check runs at a
  time: a click during the automatic check is logged and dropped.
- **A Help menu** with "About vrtti" (the shell version, OS and
  architecture, and the page build) and "Check for updates…", which runs
  the same check by hand and, when there is nothing or the check fails,
  says so in a dialog. This is the one place a check may speak when it
  finds nothing.
- **Env hooks, read once at startup** (goose §6): `VRTTI_NO_UPDATE=1`
  disables the automatic check (the menu item still works),
  `VRTTI_UPDATE_URL` replaces the endpoint and `VRTTI_UPDATE_PUBKEY` the
  key, which is what lets a real-shell test serve its own signed
  manifest.
- **The page stays out of it.** No capability change: the plugin is used
  from Rust only, like the dialog plugin. The one page change is that
  `page_ready` now carries the page's commit id (`version.js`), so About
  can name the page build; an older page sends none and About omits it.
- **Local bundling** (`cargo tauri build`) now needs either the key in
  `TAURI_SIGNING_PRIVATE_KEY` or
  `--config '{"bundle":{"createUpdaterArtifacts":false}}'`; `cargo
  build`, `check` and `test` are unaffected.

### 18.1 Shell and CI (unit 1, built 2026-09-22)

`tauri-plugin-updater` registered; `update.rs` with the check loop, the
dialog, the install, the three hooks, and the Help menu items wired in
lib.rs; `createUpdaterArtifacts: true` and the updater config in
tauri.conf.json; desktop.yml signs when the secret exists, passes the
version as `--config '{"version": …}'`, collects the installer, the
AppImage and the app archive with their signatures, writes one manifest
per platform key in the build job, and uploads the files before the
manifests so a shell checking in between never sees a manifest for a
file not there yet. Verified with cargo check, clippy, `cargo test`
(four tests on the hooks and the installed-copy check), the Windows
target, a shell run of `latest-json.sh` (a good manifest, four refused
inputs), and a Playwright smoke of `page_ready` carrying the build. The
user set the repository secret the same day.

### 18.2 Real shell (unit 2)

**Passed on Windows 2026-09-22**, on the user's machine, with the real
release: the shell installed from `vrtti-setup.exe` reported 0.1.11 and
the page build in Help > About, a manual workflow run published 0.1.12
from the same commit, the shell offered it, "Restart now" ran the
passive install, and the relaunched shell reported 0.1.12 ("works").
The Linux run below is optional now; the user's platform is Windows.

On Linux under Xvfb: build two AppImages on local disk, `0.1.0` and
`0.1.999`, sign the second with a throwaway key, serve a
`latest-linux-x86_64.json` for it from a local HTTP server, run the
first with the three hooks set, and expect the dialog, the replaced
AppImage after "Restart now", and the relaunched shell reporting
`0.1.999`. A release build refuses an `http://` endpoint
(`InsecureTransportProtocol`) unless the test builds carry
`--config '{"plugins":{"updater":{"dangerousInsecureTransportProtocol":true}}}'`;
a debug build only warns. Then the next push publishes a signed release
with the manifests, and the user installs `vrtti-setup.exe` once.
