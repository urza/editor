// @ts-check
// Thin wrapper over vendored typage (npm `age-encryption`).
//
// Why a wrapper: the rest of the app must never import typage directly. One
// file owns the vendored API surface, so a typage upgrade touches one file.
//
// The import below is a relative path and not a bare specifier on purpose.
// Import maps apply to the window only, a dedicated worker ignores them, and
// unlock.worker.js loads this module. tools/vendor_age.py rewrites the whole
// vendored age tree the same way; do not add an import-map entry for it.

import {
  Encrypter,
  Decrypter,
  generateX25519Identity,
  identityToRecipient,
  armor,
} from "../../vendor/age-encryption/index.js";

/** Marker of an ASCII-armored age file. */
const ARMOR_HEAD = "-----BEGIN AGE ENCRYPTED FILE-----";
/** First bytes of a binary age file. */
const BINARY_HEAD = "age-encryption.org/v1";

/**
 * Generate a fresh X25519 identity.
 *
 * We call generateX25519Identity, not generateIdentity. generateIdentity is
 * documented as free to switch to post-quantum hybrid keys in a later release.
 * A silent format change would break interop with an older age CLI, so we pin
 * the key type ourselves.
 *
 * @returns {Promise<{identity: string, recipient: string}>}
 */
export async function generateIdentity() {
  const identity = await generateX25519Identity();
  const recipient = await identityToRecipient(identity);
  return { identity, recipient };
}

/**
 * Derive the public recipient from an identity.
 * @param {string | CryptoKey} identity
 * @returns {Promise<string>}
 */
export function toRecipient(identity) {
  return identityToRecipient(identity);
}

/**
 * Encrypt to one or more recipients.
 *
 * @param {string | Uint8Array} plaintext
 * @param {string[]} recipients  `age1...` public keys, at least one.
 * @param {{armored?: boolean}} [opts]  Armored output for text transports
 *   (server JSON, IndexedDB, textarea); binary for `.age` files on disk.
 * @returns {Promise<string | Uint8Array>} Armored string or raw bytes.
 */
export async function encrypt(plaintext, recipients, opts = {}) {
  if (!recipients.length) throw new Error("age: no recipients");
  const e = new Encrypter();
  for (const r of recipients) e.addRecipient(r);
  const out = await e.encrypt(plaintext);
  return opts.armored ? armor.encode(out) : out;
}

/**
 * Encrypt to a passphrase (scrypt recipient). Used to wrap a device identity.
 *
 * @param {string | Uint8Array} plaintext
 * @param {string} passphrase
 * @param {{armored?: boolean, workFactor?: number}} [opts]
 * @returns {Promise<string | Uint8Array>}
 */
export async function encryptWithPassphrase(plaintext, passphrase, opts = {}) {
  const e = new Encrypter();
  e.setPassphrase(passphrase);
  // logN 18 is the typage/age default: ~650 ms on a laptop, deliberately slow.
  // We unlock once per session, so the cost is paid once and buys brute-force
  // resistance for the wrapped device identity sitting in IndexedDB.
  if (opts.workFactor !== undefined) e.setScryptWorkFactor(opts.workFactor);
  const out = await e.encrypt(plaintext);
  return opts.armored ? armor.encode(out) : out;
}

/**
 * Decrypt with identities and/or passphrases. All candidates are tried.
 *
 * @param {string | Uint8Array} ciphertext  Armored text or raw bytes.
 * @param {{identities?: (string | CryptoKey)[], passphrases?: string[], output?: "text" | "uint8array"}} opts
 * @returns {Promise<string | Uint8Array>}
 */
export async function decrypt(ciphertext, opts) {
  const d = new Decrypter();
  for (const i of opts.identities ?? []) d.addIdentity(i);
  for (const p of opts.passphrases ?? []) d.addPassphrase(p);
  const bytes = typeof ciphertext === "string" ? armor.decode(ciphertext) : ciphertext;
  return opts.output === "uint8array" ? d.decrypt(bytes) : d.decrypt(bytes, "text");
}

/** @param {string} text */
export function isArmored(text) {
  return text.trimStart().startsWith(ARMOR_HEAD);
}

/**
 * Recognize an age file without decrypting it. The sidebar needs this to show
 * a locked row for a `.age` file it cannot open (architecture.md §5).
 * @param {string | Uint8Array} content
 */
export function isAgeFile(content) {
  if (typeof content === "string") {
    return isArmored(content) || content.startsWith(BINARY_HEAD);
  }
  const head = new TextDecoder().decode(content.subarray(0, BINARY_HEAD.length));
  return head === BINARY_HEAD;
}

// 1,400 base64 lines of 64 chars decode to ~67 KB, well above any age recipient
// header we write while avoiding a multi-MB decode on large armored notes.
const HEADER_ARMOR_LINES = 1400;
const ARMOR_FOOT = "-----END AGE ENCRYPTED FILE-----";

/**
 * How many recipients an armored age file was encrypted to, read off its
 * header: one `->` stanza per recipient, and the header ends at the `---`
 * line. It says nothing about who they are, which is the point of the
 * format; model/docs.js compares the count with the keyring to find a
 * document wrapped before a device joined (architecture.md §20).
 * @param {string} armored
 */
export function countRecipients(armored) {
  // Slice only the opening armor lines instead of passing the whole multi-MB
  // file to `armor.decode()` (which validates the footer and decodes every byte).
  const start = armored.indexOf(ARMOR_HEAD);
  if (start < 0) {
    const bytes = armor.decode(armored);
    const head = new TextDecoder().decode(bytes.subarray(0, 65536));
    return countHeaderLines(head);
  }
  let pos = armored.indexOf("\n", start + ARMOR_HEAD.length);
  if (pos < 0) return 0;
  pos++;
  const b64Parts = [];
  for (let i = 0; i < HEADER_ARMOR_LINES && pos < armored.length; i++) {
    const nl = armored.indexOf("\n", pos);
    const rawLine = nl < 0 ? armored.slice(pos) : armored.slice(pos, nl);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line || line === ARMOR_FOOT) break;
    b64Parts.push(line);
    if (nl < 0) break;
    pos = nl + 1;
  }
  let joined = b64Parts.join("");
  // Keep a 4-character multiple so `atob` decodes a truncated prefix cleanly.
  joined = joined.slice(0, joined.length - (joined.length % 4));
  if (!joined) return 0;
  const bin = atob(joined);
  return countHeaderLines(bin);
}

/** @param {string} head */
function countHeaderLines(head) {
  let count = 0;
  let pos = 0;
  while (pos < head.length) {
    const nl = head.indexOf("\n", pos);
    const line = nl < 0 ? head.slice(pos) : head.slice(pos, nl);
    if (line.startsWith("---")) break;
    if (line.startsWith("-> ")) count++;
    if (nl < 0) break;
    pos = nl + 1;
  }
  return count;
}

export { armor };
