// @ts-check
/**
 * Thin wrapper over vendored typage (npm `age-encryption`).
 *
 * Why a wrapper: the rest of the app must never import typage directly.
 * One file owns the vendored API surface, so a typage upgrade touches one file.
 * This is the prototype of `app/js/crypto/age.js` (architecture section 6).
 */

import { Encrypter, Decrypter, generateX25519Identity, identityToRecipient, armor } from "age-encryption"

/** Marker of an ASCII-armored age file. */
const ARMOR_HEAD = "-----BEGIN AGE ENCRYPTED FILE-----"
/** First bytes of a binary age file. */
const BINARY_HEAD = "age-encryption.org/v1"

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
    const identity = await generateX25519Identity()
    const recipient = await identityToRecipient(identity)
    return { identity, recipient }
}

/**
 * Derive the public recipient from an identity.
 * @param {string | CryptoKey} identity
 * @returns {Promise<string>}
 */
export function toRecipient(identity) {
    return identityToRecipient(identity)
}

/**
 * Encrypt to one or more recipients.
 *
 * @param {string | Uint8Array} plaintext
 * @param {string[]} recipients - `age1...` public keys, at least one.
 * @param {{armored?: boolean}} [opts] - armored output for text transports
 *   (server JSON, textarea); binary for `.age` files on disk.
 * @returns {Promise<string | Uint8Array>} armored string or raw bytes.
 */
export async function encrypt(plaintext, recipients, opts = {}) {
    if (!recipients.length) throw new Error("age: no recipients")
    const e = new Encrypter()
    for (const r of recipients) e.addRecipient(r)
    const out = await e.encrypt(plaintext)
    return opts.armored ? armor.encode(out) : out
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
    const e = new Encrypter()
    e.setPassphrase(passphrase)
    // logN 18 is the typage/age default: ~1 s on a laptop, deliberately slow.
    // We unlock once per session, so the cost is paid once and buys brute-force
    // resistance for the wrapped device identity sitting in IndexedDB.
    if (opts.workFactor !== undefined) e.setScryptWorkFactor(opts.workFactor)
    const out = await e.encrypt(plaintext)
    return opts.armored ? armor.encode(out) : out
}

/**
 * Decrypt with identities and/or passphrases. All candidates are tried.
 *
 * @param {string | Uint8Array} ciphertext - armored text or raw bytes.
 * @param {{identities?: (string | CryptoKey)[], passphrases?: string[], output?: "text" | "uint8array"}} opts
 * @returns {Promise<string | Uint8Array>}
 */
export async function decrypt(ciphertext, opts) {
    const d = new Decrypter()
    for (const i of opts.identities ?? []) d.addIdentity(i)
    for (const p of opts.passphrases ?? []) d.addPassphrase(p)
    const bytes = typeof ciphertext === "string" ? armor.decode(ciphertext) : ciphertext
    return opts.output === "uint8array"
        ? d.decrypt(bytes)
        : d.decrypt(bytes, "text")
}

/** @param {string} text */
export function isArmored(text) {
    return text.trimStart().startsWith(ARMOR_HEAD)
}

/**
 * Recognize an age file without decrypting it. The sidebar needs this to show
 * a locked row for a `.age` file it cannot open (architecture section 5).
 * @param {string | Uint8Array} content
 */
export function isAgeFile(content) {
    if (typeof content === "string") {
        return isArmored(content) || content.startsWith(BINARY_HEAD)
    }
    const head = new TextDecoder().decode(content.subarray(0, BINARY_HEAD.length))
    return head === BINARY_HEAD
}

export { armor }
