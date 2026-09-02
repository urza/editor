// @ts-check
// The codec stage between editor and record (architecture.md §1 and §5).
//
// Everything below this stage treats content as opaque. That rule is what makes
// encryption orthogonal to storage, disk, and sync, so this file is the only
// place that knows a record can be ciphertext.
//
// Nothing in the app calls this yet; model/docs.js wires it into the write
// pipeline in unit 2 (architecture.md §13.4).

import * as age from "../crypto/age.js";

/** @typedef {import("../storage/idb.js").EncMeta} EncMeta */

/**
 * The keyring surface the codec needs. Typed as a shape, not as the class, so a
 * test can hand in a stub.
 * @typedef {Object} CodecKeyring
 * @property {string | CryptoKey | null} identity
 * @property {(preset: "all-devices" | "this-device") => string[]} recipientsFor
 */

/** Thrown when the keyring is locked or holds no matching identity. */
export class LockedError extends Error {
  constructor(msg = "document is locked") {
    super(msg);
    this.name = "LockedError";
  }
}

/**
 * editor text -> record content.
 *
 * Called on every debounced autosave of an encrypted doc. age wraps a fresh
 * file key each time, so two saves of the same text give different bytes. That
 * is correct, and it is why sync must compare revisions, never content.
 *
 * The recipient list is resolved here, from the preset, and never stored: an
 * age header deliberately hides who can decrypt a file, and writing the list
 * into record metadata would hand the server exactly that (architecture.md §5).
 *
 * @param {string} text
 * @param {EncMeta | undefined} enc  Absent for a plaintext doc.
 * @param {CodecKeyring} keyring
 * @returns {Promise<string>} Armored ciphertext, or the text unchanged.
 */
export async function encode(text, enc, keyring) {
  if (!enc) return text;
  const recipients = keyring.recipientsFor(enc.preset);
  if (!recipients.length) throw new Error("codec: preset resolved to no recipients");
  return /** @type {string} */ (await age.encrypt(text, recipients, { armored: true }));
}

/**
 * record content -> editor text.
 *
 * @param {string} content
 * @param {EncMeta | undefined} enc
 * @param {CodecKeyring} keyring
 * @returns {Promise<string>}
 */
export async function decode(content, enc, keyring) {
  if (!enc) return content;
  if (!keyring.identity) throw new LockedError();
  try {
    return /** @type {string} */ (
      await age.decrypt(content, { identities: [keyring.identity], output: "text" })
    );
  } catch (err) {
    // typage throws the same "no identity matched" error for a locked keyring
    // and for a doc this device is not a recipient of. The second case is the
    // courier device of §5: it stores and syncs the ciphertext and shows a
    // locked row. Both surface as LockedError.
    throw new LockedError(String(err instanceof Error ? err.message : err));
  }
}

/**
 * Build the `enc` field when a doc turns secret.
 *
 * Converting a plaintext doc must also purge its server revisions, or the old
 * plaintext history defeats the point (architecture.md §5). That purge is the
 * sync client's job; this function only mints the metadata.
 *
 * @param {"all-devices" | "this-device"} preset
 * @returns {EncMeta}
 */
export function newEncMeta(preset) {
  return { v: 1, preset };
}
