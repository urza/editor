// @ts-check
/**
 * The codec stage between editor and record (architecture sections 1 and 5).
 * Prototype of `app/js/model/codec.js`.
 *
 * Everything below this stage treats content as opaque. That rule is what
 * makes encryption orthogonal to storage, disk, and sync, so this file is the
 * only place that knows a record can be ciphertext.
 */

import * as age from "./age.js"

/**
 * @typedef {Object} EncMeta
 * @property {1} v
 * @property {string[]} recipients  `age1...` public keys this doc is encrypted to
 * @property {string} label         plaintext title, accepted metadata leak
 */

/** Thrown when the keyring is locked or holds no matching identity. */
export class LockedError extends Error {
    constructor(msg = "document is locked") { super(msg); this.name = "LockedError" }
}

/**
 * editor text -> record content.
 *
 * Called on every debounced autosave of an encrypted doc. age wraps a fresh
 * file key each time, so two saves of the same text give different bytes.
 * That is correct, and it is why sync must compare revisions, never content.
 *
 * @param {string} text
 * @param {EncMeta | undefined} enc  absent for a plaintext doc
 * @returns {Promise<string>} armored ciphertext, or the text unchanged
 */
export async function encode(text, enc) {
    if (!enc) return text
    if (!enc.recipients?.length) throw new Error("codec: doc has enc but no recipients")
    return /** @type {string} */ (await age.encrypt(text, enc.recipients, { armored: true }))
}

/**
 * record content -> editor text.
 *
 * @param {string} content
 * @param {EncMeta | undefined} enc
 * @param {{identity: string | CryptoKey | null}} keyring
 * @returns {Promise<string>}
 */
export async function decode(content, enc, keyring) {
    if (!enc) return content
    if (!keyring.identity) throw new LockedError()
    try {
        return /** @type {string} */ (await age.decrypt(content, {
            identities: [keyring.identity], output: "text",
        }))
    } catch (err) {
        // typage throws the same "no identity matched" error for a locked
        // keyring and for a doc this device is not a recipient of. The second
        // case is the courier device of section 5: it stores and syncs the
        // ciphertext and shows a locked row. Both surface as LockedError.
        throw new LockedError(String(err instanceof Error ? err.message : err))
    }
}

/**
 * Build the `enc` field when a doc turns secret.
 *
 * Converting a plaintext doc must also purge its server revisions, or the old
 * plaintext history defeats the point (architecture section 5). That purge is
 * the sync client's job; this function only mints the metadata.
 *
 * @param {string[]} recipients
 * @param {string} label
 * @returns {EncMeta}
 */
export function newEncMeta(recipients, label) {
    return { v: 1, recipients: [...recipients], label }
}
