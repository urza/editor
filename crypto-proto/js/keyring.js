// @ts-check
/**
 * Device identity, unlock state, and the recipient sets.
 * Prototype of `app/js/crypto/keyring.js` (architecture section 5).
 *
 * Storage here is localStorage to keep the prototype self-contained.
 * The real module writes the same shape into the IndexedDB `settings` store,
 * and the device list into a synced plaintext keyring doc.
 */

import * as age from "./age.js"

const STORE_KEY = "vrtti.keyring.v1"

/**
 * RFC 8410 PKCS#8 prefix for an X25519 private key.
 * WebCrypto importKey accepts "pkcs8" and "jwk" for X25519 private keys, but
 * not "raw" (raw is public-key only). age hands us 32 raw bytes, so we glue
 * this fixed header on. Do not "simplify" it away: the byte count in it
 * (0x2e / 0x22 / 0x20) is what makes the DER parse.
 */
const PKCS8_X25519_PREFIX = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
    0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
])

/**
 * @typedef {Object} StoredKeyring
 * @property {number} v
 * @property {string} deviceName
 * @property {string} deviceRecipient   public key, `age1...`
 * @property {string} wrappedIdentity   the device identity, age-armored to a passphrase
 * @property {string} recoveryRecipient public key of the offline master identity
 * @property {number} createdAt
 */

export class KeyRing extends EventTarget {
    constructor() {
        super()
        /** @type {StoredKeyring | null} */
        this.stored = readStore()
        /**
         * The unlocked device identity. A string, or a non-extractable
         * CryptoKey when the platform supports X25519 in WebCrypto.
         * @type {string | CryptoKey | null}
         */
        this.identity = null
        /** How the current identity is held, for the UI to report. */
        this.identityKind = /** @type {"none"|"string"|"cryptokey"} */ ("none")
    }

    get isSetUp() { return this.stored !== null }
    get isUnlocked() { return this.identity !== null }
    get deviceRecipient() { return this.stored?.deviceRecipient ?? null }
    get recoveryRecipient() { return this.stored?.recoveryRecipient ?? null }

    /**
     * First run on a device.
     *
     * The recovery identity is generated here and returned exactly once.
     * The caller must show it and tell the user to write it down. We never
     * store the recovery *secret*, only its public recipient, because an
     * offline master key is the whole answer to a lost device
     * (architecture section 5).
     *
     * @param {string} passphrase
     * @param {{deviceName?: string, workFactor?: number}} [opts]
     * @returns {Promise<{recoveryIdentity: string}>}
     */
    async setup(passphrase, opts = {}) {
        const device = await age.generateIdentity()
        const recovery = await age.generateIdentity()
        const wrapped = await age.encryptWithPassphrase(device.identity, passphrase, {
            armored: true, workFactor: opts.workFactor,
        })
        this.stored = {
            v: 1,
            deviceName: opts.deviceName ?? "this device",
            deviceRecipient: device.recipient,
            wrappedIdentity: /** @type {string} */ (wrapped),
            recoveryRecipient: recovery.recipient,
            createdAt: Date.now(),
        }
        writeStore(this.stored)
        // Leave the device locked after setup. Unlock is an explicit command,
        // so setup and unlock share one code path from here on.
        this.emit("change")
        return { recoveryIdentity: recovery.identity }
    }

    /**
     * Unwrap the device identity into memory.
     * @param {string} passphrase
     * @param {{preferCryptoKey?: boolean}} [opts]
     */
    async unlock(passphrase, opts = {}) {
        if (!this.stored) throw new Error("keyring: not set up")
        const secret = /** @type {string} */ (await age.decrypt(this.stored.wrappedIdentity, {
            passphrases: [passphrase], output: "text",
        }))
        if (opts.preferCryptoKey !== false) {
            const key = await toNonExtractableKey(secret)
            if (key) {
                this.identity = key
                this.identityKind = "cryptokey"
                this.emit("change")
                return
            }
        }
        this.identity = secret
        this.identityKind = "string"
        this.emit("change")
    }

    /**
     * Drop the identity. Manual lock only, per the decision log.
     *
     * Dropping the reference is all we can do for a string identity; JS gives
     * no way to zero it. With a CryptoKey there is nothing to zero in the JS
     * heap at all. The caller must also drop cached editor states of encrypted
     * docs, which is a store concern, not a keyring one.
     */
    lock() {
        this.identity = null
        this.identityKind = "none"
        this.emit("change")
    }

    /** Forget this device completely. Prototype convenience. */
    reset() {
        localStorage.removeItem(STORE_KEY)
        this.stored = null
        this.lock()
    }

    /**
     * Recipient set for a preset. Presets first, per-device picking later.
     * The recovery recipient is in every set by default and is not optional.
     * @param {"all-devices" | "this-device"} preset
     * @returns {string[]}
     */
    recipientsFor(preset) {
        if (!this.stored) throw new Error("keyring: not set up")
        const set = [this.stored.deviceRecipient]
        // "all-devices" would append the other device recipients read from the
        // synced keyring doc. The prototype has one device, so both presets
        // differ only in that list.
        if (preset === "all-devices") {
            for (const r of otherDeviceRecipients()) if (!set.includes(r)) set.push(r)
        }
        set.push(this.stored.recoveryRecipient)
        return set
    }

    /** @param {string} type */
    emit(type) { this.dispatchEvent(new CustomEvent(type)) }
}

/**
 * Import an `AGE-SECRET-KEY-1...` string as a non-extractable CryptoKey.
 *
 * typage's Decrypter.addIdentity accepts an X25519 private CryptoKey with
 * usages ["deriveBits"]. Once imported, the secret bytes live in the browser's
 * crypto backend and cannot be read back out of JS. Returns null where the
 * platform has no X25519 in WebCrypto, so the caller can fall back to a string.
 *
 * @param {string} identity
 * @returns {Promise<CryptoKey | null>}
 */
export async function toNonExtractableKey(identity) {
    try {
        const raw = decodeBech32Secret(identity)
        const pkcs8 = new Uint8Array(PKCS8_X25519_PREFIX.length + raw.length)
        pkcs8.set(PKCS8_X25519_PREFIX, 0)
        pkcs8.set(raw, PKCS8_X25519_PREFIX.length)
        return await crypto.subtle.importKey(
            "pkcs8", pkcs8, { name: "X25519" }, false, ["deriveBits"])
    } catch {
        return null
    }
}

/** Does this browser have X25519 in WebCrypto at all? */
export async function hasWebCryptoX25519() {
    try {
        await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])
        return true
    } catch {
        return false
    }
}

/* --- bech32 for AGE-SECRET-KEY-1, borrowed shape from typage ------------- */

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"

/**
 * Decode the 32 secret bytes out of an `AGE-SECRET-KEY-1...` string.
 * We do not import @scure/base here on purpose: keyring.js should depend on
 * the age wrapper only, not on typage's own dependencies.
 * @param {string} s
 */
function decodeBech32Secret(s) {
    const lower = s.toLowerCase()
    const sep = lower.lastIndexOf("1")
    if (!lower.startsWith("age-secret-key-") || sep < 0) throw new Error("not an age identity")
    const data = lower.slice(sep + 1, lower.length - 6) // drop the 6-char checksum
    let acc = 0, bits = 0
    const out = []
    for (const ch of data) {
        const v = BECH32_CHARSET.indexOf(ch)
        if (v < 0) throw new Error("bad bech32 char")
        acc = (acc << 5) | v
        bits += 5
        while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff) }
    }
    if (out.length !== 32) throw new Error("bad identity length")
    return new Uint8Array(out)
}

/* --- storage ------------------------------------------------------------- */

/** @returns {StoredKeyring | null} */
function readStore() {
    try {
        const raw = localStorage.getItem(STORE_KEY)
        return raw ? JSON.parse(raw) : null
    } catch { return null }
}

/** @param {StoredKeyring} v */
function writeStore(v) { localStorage.setItem(STORE_KEY, JSON.stringify(v)) }

/**
 * Public keys of other devices. In the app these come from the synced keyring
 * doc. The prototype lets the demo page inject them.
 * @returns {string[]}
 */
function otherDeviceRecipients() {
    try {
        return JSON.parse(localStorage.getItem("vrtti.keyring.peers") ?? "[]")
    } catch { return [] }
}
