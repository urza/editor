# age encryption layer: research and prototype

Status: researched and prototyped 2026-09-01. Input for architecture section 5.
Everything below was measured, not assumed. The prototype in this directory
runs the real flows in a real browser against the real age CLI.

Verdict: **typage is vendorable and fast enough. Ship it.**
33 of 33 automated checks pass. Both interop directions work with age v1.3.2.

## Pinned versions

| package | version | why this version |
| --- | --- | --- |
| `age-encryption` (typage) | **0.3.1** | latest on npm |
| `@noble/hashes` | **2.0.1** | see the flat-tree note below |
| `@noble/curves` | **2.0.1** | see the flat-tree note below |
| `@noble/ciphers` | **2.4.0** | latest 2.x; typage wants `^2.1.1`; nothing else depends on it |
| `@noble/post-quantum` | **0.5.4** | latest 0.5.x; typage wants `^0.5.3` |
| `@scure/base` | **2.4.0** | latest 2.x; typage wants `^2.0.0` |
| age CLI (interop test only) | **v1.3.2** | latest release |

**Flat-tree note.** Do not take "latest" for hashes and curves.
An import map is flat. It maps one specifier to one file, and it cannot nest.
`@noble/post-quantum` 0.5.4 requires `@noble/curves` `~2.0.0` and
`@noble/hashes` `~2.0.0`. typage requires `^2.0.1` for both. npm would resolve
this by installing 2.4.0 at the top and a second, nested copy of 2.0.x under
post-quantum. A flat vendor tree must pick one version that satisfies both
ranges, and 2.0.1 is that version. Pinning 2.4.0 here would 404 nothing but
would silently break `MLKEM768X25519` against a newer curves API.
`vendor.sh` carries this reason in a comment.

## Q1. typage vendor-ability

**Answer: it loads in a browser with a plain import map. No bundler, no
workaround needed.**

What typage ships: `dist/` only. Nine `.js` files plus nine `.d.ts` files, one
`package.json`, `README.md`, `LICENSE`. 93 KB unpacked, 55 KB of it JavaScript.
`"type": "module"`, `"exports": "./dist/index.js"`, ESM throughout.

Runtime dependencies: five packages, all from the noble/scure family.
`@noble/ciphers`, `@noble/curves`, `@noble/hashes`, `@noble/post-quantum`,
`@scure/base`. No WASM. No Node built-ins: a grep for `node:`, `require(`,
`process.`, and `__dirname` across the whole vendored tree returns nothing.

Why the import map is enough: every bare specifier in the tree is either a
package root or a package subpath that maps 1:1 to a file on disk. The noble
packages import each other, and even themselves, by bare specifier
(`from '@noble/hashes/utils.js'`), never by a relative path that would escape
the package. Every relative import carries a `.js` extension. There is no
extensionless import outside JSDoc examples, and there is no conditional
`exports` map to resolve. So a six-entry import map covers the whole graph:

```json
{
  "imports": {
    "age-encryption": "./vendor/age-encryption/index.js",
    "@noble/hashes/": "./vendor/noble-hashes/",
    "@noble/curves/": "./vendor/noble-curves/",
    "@noble/ciphers/": "./vendor/noble-ciphers/",
    "@noble/post-quantum/": "./vendor/noble-post-quantum/",
    "@scure/base": "./vendor/scure-base/index.js"
  }
}
```

`@scure/base` has no subpaths, so it gets an exact key, not a prefix key.

**Size.** On disk, runtime `.js` and licences only:

| directory | files | bytes |
| --- | ---: | ---: |
| `vendor/age-encryption` | 9 | 56,715 |
| `vendor/noble-ciphers` | 10 | 208,660 |
| `vendor/noble-curves` | 21 | 340,721 |
| `vendor/noble-hashes` | 19 | 167,689 |
| `vendor/noble-post-quantum` | 7 | 92,674 |
| `vendor/scure-base` | 1 | 49,993 |
| **total** | **67** | **916,452 (895 KB)** |

Gzipped, that is 238 KB.

**Only 38 of those 67 files actually load.** The static import graph from
`index.js` reaches 38 files and 488,672 bytes (477 KB). Chromium confirmed it:
the page fetched 43 JS files and 501 KB decoded, which is the 38 vendored files
plus the five prototype modules. The other 29 files (`aes.js`, `sha3-addons.js`,
`bls12-381.js`, `ml-dsa.js`, and friends) are vendored for upgrade safety and
never requested.

The largest single reason for the size is `@noble/post-quantum`.
`dist/recipients.js` statically imports `@noble/post-quantum/hybrid.js` for
`age1pq1...` recipients, which pulls in ML-KEM-768 and, through it,
`@noble/curves/nist.js` with P-256 and the whole weierstrass abstraction.
vrtti uses none of that. The import is static, so it cannot be tree-shaken
without a bundler. Accept the ~130 KB, or fork typage. Accept it.

**jsdelivr is the wrong tool here, and it is not needed.**
`https://cdn.jsdelivr.net/npm/age-encryption@0.3.1/+esm` does return a 22 KB
bundle (HTTP 200), but its imports are absolute CDN paths
(`import{hmac as O}from"/npm/@noble/hashes@2..."`). That build fetches from the
CDN at runtime, which breaks the offline requirement. The registry tarballs plus
an import map are both smaller in transferred bytes and genuinely offline.

## Q2. API coverage

Everything the architecture needs is present. Exact names:

| need | API |
| --- | --- |
| X25519 keypair generation | `generateX25519Identity(): Promise<string>` then `identityToRecipient(id): Promise<string>` |
| encrypt to multiple recipients | `new Encrypter()`, `addRecipient(s)` called once per recipient, `encrypt(data)` |
| decrypt with an identity | `new Decrypter()`, `addIdentity(s)`, `decrypt(bytes, "text" \| "uint8array")` |
| scrypt passphrase recipient | `Encrypter.setPassphrase(s)`, `Encrypter.setScryptWorkFactor(logN)`, `Decrypter.addPassphrase(s)` |
| armored output | `armor.encode(bytes): string`, `armor.decode(str): Uint8Array` |
| binary output | `Encrypter.encrypt()` returns `Uint8Array` already; armor is the extra step |

Notes that matter:

- **Use `generateX25519Identity`, not `generateIdentity`.** typage documents
  `generateIdentity` as free to switch to post-quantum hybrid keys in a future
  release. A silent key-type change would break `.age` files for an older age
  CLI. `crypto-proto/js/age.js` pins the type for this reason.
- `setPassphrase` and `addRecipient` are mutually exclusive, and `setPassphrase`
  may be called only once. That matches how we use them: passphrase for the
  wrapped device identity, recipients for documents.
- `Decrypter` tries all added identities and passphrases in parallel per file.
  One `Decrypter` can therefore hold the device identity and, in a recovery
  flow, a pasted recovery identity.
- `decrypt(bytes, "text")` decodes UTF-8 for us. Verified with accents and an
  astral-plane emoji.
- Streaming exists (`ReadableStream` in and out) with a `.size()` helper.
  vrtti documents are small, so the one-shot `Uint8Array` path is right.

## Q3. Interop with the real age CLI

**Both directions work. Six interop checks, all passing, against age v1.3.2
(`age-v1.3.2-linux-amd64.tar.gz` from the GitHub release).**

typage in Chromium to the CLI:

- CLI decrypts typage **armored** output. Round-tripped `áčďé 🔒` exactly.
- CLI decrypts typage **binary** output.
- A two-recipient file written by typage opens with either recipient's key.

CLI to typage in Chromium:

- typage decrypts CLI **armored** output (`age -a -r ... -r ...`).
- typage decrypts CLI **binary** output.
- typage decrypts a CLI **passphrase** file (`age -p`).

The wrapped device identity is the same story, which is the part that makes the
"never a data prison" promise real for keys and not just documents:

- `age -d wrapped.age` prints the `AGE-SECRET-KEY-1...` back, given the
  passphrase.
- `age -d -i wrapped.age note.age` works directly. age accepts a
  passphrase-encrypted file as an identity file, so a user can restore a device
  with the age CLI and nothing else.

The test drives `age` through a pty (`ptyrun.py`), because age reads
passphrases from `/dev/tty` on purpose and refuses a pipe.

## Q4. Performance

Chromium 151 headless in this sandbox. 30 runs per size after a warm-up run.
Three recipients, armored output, whole encrypt-then-decrypt path through
`codec.js`. Times in milliseconds.

| payload | encrypt median | encrypt p95 | decrypt median | decrypt p95 | ciphertext |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 KB | 0.60 | 1.40 | 0.40 | 0.80 | 1,994 chars |
| 10 KB | 0.60 | 1.10 | 0.40 | 1.40 | 14,474 chars |
| 100 KB | 1.30 | 3.10 | 1.00 | 1.60 | 139,294 chars |

For comparison, one recipient: 0.30 / 0.30 / 1.20 ms encrypt at 1 / 10 / 100 KB.
Binary output, three recipients: 0.50 / 0.60 / 1.00 ms encrypt.

**The 300 ms autosave debounce is not remotely at risk.** The worst median is
1.3 ms, which is 0.4% of the debounce window and about a tenth of one 60 Hz
frame. Even the 100 KB p95 of 3.1 ms fits in a frame. Recipient count costs
roughly 0.15 ms per extra recipient, because each one is an X25519 scalar
multiplication. Payload size costs almost nothing, because ChaCha20-Poly1305 is
fast. A vrtti note would have to be megabytes before this mattered.

**scrypt is the only slow thing, and it is slow on purpose.**

| work factor | wrap time |
| ---: | ---: |
| logN=14 | 35 ms |
| logN=16 | 176 ms |
| logN=18 (typage default) | 653 ms |
| logN=20 | 2,555 ms |

Unlock at logN=18 measured 600 to 1,214 ms. Device setup, which is two key
generations plus one wrap, measured about 1.3 s cold.

That cost is paid once per session, so keep logN=18. But note the real problem:
`@noble/hashes` scrypt is **synchronous**, and typage calls it synchronously
(`ScryptRecipient.wrapFileKey` returns `Stanza[]`, not a Promise). Unlock
therefore blocks the main thread for the whole 600 ms. A phone will be
noticeably worse. Put the unlock in a Web Worker (see next steps).

Ciphertext size, three recipients:

| payload | binary | armored | armor cost |
| --- | ---: | ---: | ---: |
| 1 KB | 1,420 B | 1,994 B | +40% |
| 10 KB | 10,636 B | 14,474 B | +36% |
| 100 KB | 102,812 B | 139,294 B | +36% |

Fixed header cost is about 390 bytes for three recipients. Streaming overhead is
0.4%. Armor adds a flat 36% on top, which is base64 plus line breaks.

## Q5. Non-extractable key handling

**Yes. The decrypted identity can live as a non-extractable `CryptoKey`, and it
does in the prototype.** This is the most useful finding of the whole study.

`Decrypter.addIdentity` accepts `string | CryptoKey | Identity`. A `CryptoKey`
must have `type: "private"`, `algorithm: {name: "X25519"}`, and usages
`["deriveBits"]`. `identityToRecipient` accepts a `CryptoKey` too, so the public
recipient can still be derived from it. Verified: the recipient derived from the
imported CryptoKey equals the stored device recipient.

WebCrypto will not import a raw 32-byte X25519 private key, only PKCS#8 or JWK.
The fix is a fixed 16-byte ASN.1 prefix (RFC 8410). typage does exactly this
internally. `crypto-proto/js/keyring.js` does the same to import the unwrapped
identity as non-extractable.

Measured in Chromium 151:

- WebCrypto X25519 is available.
- After unlock, `keyring.identity instanceof CryptoKey` is true.
- `crypto.subtle.exportKey("pkcs8", identity)` throws `InvalidAccessError`.
  The secret cannot be read back into JavaScript.
- Decryption still works, so typage really uses the CryptoKey for `deriveBits`.

Inside typage, `X25519Identity` stores whatever it is given.
Given a string it does `this.identity = bech32.decodeToBytes(s)`, so the 32
secret bytes sit in a `Uint8Array` on the JS heap for that object's lifetime.
Given a `CryptoKey` it stores the handle, and the secret bytes never enter the
JS heap at all. typage also falls back to pure-JS `x25519` from `@noble/curves`
when WebCrypto raises `NotSupportedError`, and it throws a clear error if a
CryptoKey was supplied and WebCrypto is missing.

### Memory-hygiene consequences for the lock feature

What we get:

- Between unlock and lock, the device secret exists only as an opaque browser
  handle. A heap snapshot, an XSS read of app state, or a stray `JSON.stringify`
  of the keyring cannot leak it.
- `lock()` drops the reference. With a CryptoKey there is nothing left in the JS
  heap to zero, so "drop the reference" is a complete answer for the first time.

What we do not get, and must be honest about:

- **Unlock briefly holds the identity as a string.** The wrapped blob is a
  standard age scrypt file whose plaintext is the `AGE-SECRET-KEY-1...` text.
  We decrypt it to a string, then import it. JavaScript strings cannot be
  zeroed, so that copy lives until the garbage collector reclaims it.
  The alternative, deriving the device key from the passphrase directly, would
  destroy the `age -d -i wrapped.age` recovery path proven in Q3. Keep the
  string, accept the transient.
- A `CryptoKey` is structured-cloneable. It can be written to IndexedDB by
  accident. Never put `keyring.identity` in a record. Architecture section 5
  already says IndexedDB alone must never hold a usable private key.
- Browsers without WebCrypto X25519 fall back to a string identity in memory.
  The prototype tests that path explicitly (`preferCryptoKey: false`), and it
  works. iOS Safari is the platform to verify here, because the iPhone is the
  primary phone and this sandbox cannot test it. If it lacks X25519, nothing
  breaks. The memory-hygiene benefit is simply absent there.
- Locking must also drop cached editor states of encrypted docs. That is a store
  concern, not a keyring one, and it is already a decided behaviour.

## Vendoring recipe

`vendor.sh` in this directory is the recipe, and it is verified: running it into
a fresh directory reproduces `vendor/` byte for byte (`diff -r` reports no
difference). It needs curl and tar. It never runs npm.

Exact URLs:

```
https://registry.npmjs.org/age-encryption/-/age-encryption-0.3.1.tgz
https://registry.npmjs.org/@noble/hashes/-/hashes-2.0.1.tgz
https://registry.npmjs.org/@noble/curves/-/curves-2.0.1.tgz
https://registry.npmjs.org/@noble/ciphers/-/ciphers-2.4.0.tgz
https://registry.npmjs.org/@noble/post-quantum/-/post-quantum-0.5.4.tgz
https://registry.npmjs.org/@scure/base/-/base-2.4.0.tgz
```

For the interop test only, not vendored into the app:

```
https://github.com/FiloSottile/age/releases/download/v1.3.2/age-v1.3.2-linux-amd64.tar.gz
```

The rule per package: unpack, keep every `*.js` outside `src/`, keep `LICENSE`,
drop `*.d.ts`, `*.map`, and `src/`. typage's `dist/` is flattened one level so
the import map key stays short. Attribution belongs in `VENDOR.md`. typage is
BSD-3-Clause, the noble and scure packages are MIT.

Browser floor for import maps: Chrome 89, Firefox 108, Safari 16.4. Safari 16.4
shipped in March 2023, so the iOS PWA baseline is fine.

## Proposed API for the real modules

Signatures, matching architecture sections 5 and 6. The prototype in `js/` is a
working version of all three.

### `app/js/crypto/age.js`

The only file that imports typage. A typage upgrade touches one file.

```js
generateIdentity(): Promise<{identity: string, recipient: string}>
toRecipient(identity: string | CryptoKey): Promise<string>
encrypt(plaintext: string | Uint8Array, recipients: string[],
        opts?: {armored?: boolean}): Promise<string | Uint8Array>
encryptWithPassphrase(plaintext, passphrase: string,
        opts?: {armored?: boolean, workFactor?: number}): Promise<string | Uint8Array>
decrypt(ciphertext: string | Uint8Array,
        opts: {identities?: (string|CryptoKey)[], passphrases?: string[],
               output?: "text" | "uint8array"}): Promise<string | Uint8Array>
isArmored(text: string): boolean
isAgeFile(content: string | Uint8Array): boolean   // for `.age` rows in folders
```

### `app/js/crypto/keyring.js`

```js
class KeyRing extends EventTarget {
  get isSetUp: boolean
  get isUnlocked: boolean
  get deviceRecipient: string | null
  get recoveryRecipient: string | null
  identity: string | CryptoKey | null       // never persist this
  identityKind: "none" | "string" | "cryptokey"

  setup(passphrase, opts?: {deviceName?, workFactor?})
      : Promise<{recoveryIdentity: string}>  // shown once, never stored
  unlock(passphrase, opts?: {preferCryptoKey?: boolean}): Promise<void>
  lock(): void
  recipientsFor(preset: "all-devices" | "this-device"): string[]
}
toNonExtractableKey(identity: string): Promise<CryptoKey | null>
hasWebCryptoX25519(): Promise<boolean>
```

Stored shape, which goes in the IndexedDB `settings` store, not localStorage:

```js
{ v: 1, deviceName, deviceRecipient, wrappedIdentity, recoveryRecipient, createdAt }
```

`wrappedIdentity` is armored age. The test asserts no `AGE-SECRET-KEY` substring
ever reaches storage.

### `app/js/model/codec.js`

```js
encode(text: string, enc: EncMeta | undefined): Promise<string>
decode(content: string, enc: EncMeta | undefined,
       keyring: {identity: string|CryptoKey|null}): Promise<string>
newEncMeta(recipients: string[], label: string): EncMeta
class LockedError extends Error
```

Both `encode` and `decode` pass content through untouched when `enc` is absent,
so every caller can go through the codec with no branching.

## Risks and surprises

1. **`enc.recipients` leaks more than the ciphertext does.** age headers do not
   name their recipients. An X25519 stanza carries an ephemeral share, not a
   public key, so nobody can tell from a `.age` file who it is for. Writing the
   recipient list into the record metadata gives that back to the server for
   free. Fix: store the preset id (`"all-devices"`) in `enc`, and resolve it
   against the local keyring at encrypt time. It is smaller, and it follows the
   keyring when a device is added or removed. Per-doc explicit lists, when they
   arrive, should be encrypted or kept device-local.
2. **Unlock blocks the main thread for ~600 ms**, and worse on a phone, because
   noble's scrypt is synchronous and typage calls it synchronously. Not a bug,
   but the UI will freeze without a Worker.
3. **Ciphertext changes on every save even when the text does not.** age wraps a
   fresh file key each time. Nothing may compare content bytes to detect change.
   The architecture already uses timestamps and revision numbers, so this is
   safe today. It is worth a comment in the sync client, because a future
   "skip the write if content is unchanged" optimisation would be silently dead.
4. **Armor costs 36%.** IndexedDB and the FSA API both take `Uint8Array`
   directly, so binary is available where it matters. Recommendation: keep
   armored text as the single record representation for v1, because one content
   type keeps the pipeline simple and the database stays inspectable. Revisit if
   sync payload size becomes a real complaint.
5. **`generateIdentity` may switch to post-quantum keys.** Already handled by
   pinning `generateX25519Identity`, but a typage upgrade should re-check this.
6. **The flat import map forces the version pin in `vendor.sh`.** A future
   `vendor.py` that just takes `latest` for the noble packages will produce a
   tree that loads but fails at runtime inside ML-KEM. Keep the pins explicit,
   keep the comment.
7. **iOS Safari X25519 in WebCrypto is untested here.** The fallback works, so
   the risk is a lost security property, not a broken app. Test on the real
   phone during step 3a.
8. **~130 KB of ML-KEM is vendored and loaded for nothing.** No bundler means no
   tree-shaking. Accepted.

## Recommended next steps

1. Land `vendor.sh`'s pins and rules into `app/tools/vendor.py`, with the
   flat-tree comment. Vendor into `app/vendor/`, add the import map to
   `index.html`, add the six directories to the service worker precache list.
   Precache all 67 files. The 29 unused ones cost 419 KB of disk and zero
   requests, and a partial list breaks after an upgrade.
2. Port `js/age.js` and `js/codec.js` as they stand. They are already written to
   the architecture's shapes and need no redesign.
3. Port `js/keyring.js`, with two changes: store into the IndexedDB `settings`
   store instead of localStorage, and read peer device keys from the synced
   keyring doc instead of a localStorage array.
4. **Move unlock into a Web Worker.** The worker takes the passphrase and the
   wrapped blob, returns the identity string, and the main thread imports it as
   a non-extractable CryptoKey. This is the one piece the prototype does not
   have, and it is what makes unlock acceptable on a phone.
5. Change `enc` to carry the preset id rather than the resolved recipient list
   (risk 1). Do it before the schema ships, because `enc` is reserved in the
   first migration and changing it later means a migration.
6. Wire the commands: `crypto.setup`, `crypto.unlock`, `crypto.lock`,
   `doc.encrypt`, `doc.decrypt`. Opening a locked doc dispatches `crypto.unlock`
   first. `LockedError` from the codec is the single signal the UI renders as a
   locked row.
7. Keep an interop test in CI. `scratchpad/crypto/test_crypto_proto.py` is the
   pattern: drive the page with Playwright, verify against the real age binary,
   assert both directions. It caught nothing this time, and it is exactly the
   test that will catch a typage upgrade that changes the wire format.
8. Only then start sync. Crypto lands first, per the build order, so the server
   never sees a plaintext revision.

## Running the prototype

```sh
cd crypto-proto && python3 -m http.server 8850
# open http://127.0.0.1:8850/
```

The page walks the five flows in order: device setup, unlock, encrypt to a
recipient set, decrypt, and recovery-key fallback. It also runs the benchmark.

The full verification, including both age CLI interop directions, lives at
`scratchpad/crypto/test_crypto_proto.py` and starts its own server on port 8850.
