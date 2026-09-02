// @ts-check
// Device identity, unlock state, and the recipient sets (architecture.md §5).
//
// What is stored, and where: the wrapped identity and the public keys go into
// the IndexedDB `settings` store under one key. The *unlocked* identity is a
// field on this object and nothing else. Never put it in a record, a setting,
// or a structured clone: a CryptoKey is structured-cloneable, so IndexedDB
// would happily accept it, and IndexedDB alone must never hold a usable
// private key.

import { deleteSetting, getSetting, putSetting } from "../storage/idb.js";
import * as age from "./age.js";
import { unwrapInWorker, wrapInWorker } from "./unlock.js";

const STORE_KEY = "keyring";

/**
 * RFC 8410 PKCS#8 prefix for an X25519 private key.
 * WebCrypto importKey accepts "pkcs8" and "jwk" for X25519 private keys, but
 * not "raw" (raw is public-key only). age hands us 32 raw bytes, so we glue
 * this fixed header on. Do not "simplify" it away: the byte counts in it
 * (0x2e / 0x22 / 0x20) are what makes the DER parse.
 */
const PKCS8_X25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
  0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
]);

/**
 * @typedef {Object} StoredKeyring
 * @property {number} v
 * @property {string} deviceId    Identifies this device inside the keyring record.
 * @property {string} deviceName  Friendly label the user picked at setup.
 * @property {string} deviceRecipient  Public key, `age1...`.
 * @property {string} wrappedIdentity  The device identity, age-armored to a passphrase.
 * @property {string[]} recoveryRecipients  Public keys of the offline master
 *   identities. A list, not one value: two devices set up before sync each
 *   generate one, the keyring merge keeps both, and every recipient set then
 *   carries both so either paper key restores everything (architecture.md §13.2).
 * @property {number} createdAt
 */

/**
 * One device as it appears in the keyring record (architecture.md §13.3).
 * @typedef {Object} KeyringDevice
 * @property {string} id
 * @property {string} name
 * @property {string} recipient
 * @property {number} addedAt
 */

/** @typedef {{v: 1, devices: KeyringDevice[], recovery: string[]}} KeyringContent */

export class KeyRing extends EventTarget {
  constructor() {
    super();
    /** @type {StoredKeyring | null} */
    this.stored = null;
    /**
     * The unlocked device identity. A string, or a non-extractable CryptoKey
     * when the platform supports X25519 in WebCrypto.
     * @type {string | CryptoKey | null}
     */
    this.identity = null;
    /** How the current identity is held, for the UI to report. */
    this.identityKind = /** @type {"none"|"string"|"cryptokey"} */ ("none");
    /**
     * Public keys of the other devices, from the keyring record. Set by the
     * bootstrap and refreshed whenever that record changes; the keyring itself
     * never reads the document store.
     * @type {KeyringDevice[]}
     */
    this.peers = [];
  }

  get isSetUp() {
    return this.stored !== null;
  }
  get isUnlocked() {
    return this.identity !== null;
  }
  get deviceId() {
    return this.stored?.deviceId ?? null;
  }
  get deviceName() {
    return this.stored?.deviceName ?? null;
  }
  get deviceRecipient() {
    return this.stored?.deviceRecipient ?? null;
  }
  /** @returns {string[]} */
  get recoveryRecipients() {
    return this.stored?.recoveryRecipients ?? [];
  }

  /** Read the stored keyring. Async, so the bootstrap awaits it. */
  async load() {
    this.stored = (await getSetting(STORE_KEY)) ?? null;
    return this.stored;
  }

  /**
   * The device list this keyring resolves "all-devices" against.
   * @param {KeyringDevice[]} devices
   */
  setPeers(devices) {
    this.peers = devices ?? [];
  }

  /**
   * First run on a device.
   *
   * The recovery identity is generated here and returned exactly once. The
   * caller must show it and tell the user to write it down. We never store the
   * recovery *secret*, only its public recipient, because an offline master key
   * is the whole answer to a lost device (architecture.md §5).
   *
   * `existingRecovery` is the other half of that rule: a device joining a
   * keyring that already exists adopts its recovery recipients and mints no
   * second paper key. It returns null then, and the caller shows nothing.
   *
   * @param {string} passphrase
   * @param {{deviceName?: string, workFactor?: number, existingRecovery?: string[]}} [opts]
   * @returns {Promise<{recoveryIdentity: string | null}>}
   */
  async setup(passphrase, opts = {}) {
    const device = await age.generateIdentity();

    /** @type {string | null} */
    let recoveryIdentity = null;
    let recoveryRecipients = opts.existingRecovery ?? [];
    if (!recoveryRecipients.length) {
      const recovery = await age.generateIdentity();
      recoveryIdentity = recovery.identity;
      recoveryRecipients = [recovery.recipient];
    }

    const wrapped = await wrapInWorker(device.identity, passphrase, {
      workFactor: opts.workFactor,
    });

    this.stored = {
      v: 1,
      // The sync client (architecture.md §13.6) needs a device id too; it
      // should reuse this one rather than mint a second name for one device.
      deviceId: crypto.randomUUID(),
      deviceName: opts.deviceName || "this device",
      deviceRecipient: device.recipient,
      wrappedIdentity: wrapped,
      recoveryRecipients: [...recoveryRecipients],
      createdAt: Date.now(),
    };
    await putSetting(STORE_KEY, this.stored);
    // Leave the device locked after setup. Unlock is an explicit command, so
    // setup and unlock share one code path from here on.
    this.emit("change");
    return { recoveryIdentity };
  }

  /**
   * Unwrap the device identity into memory.
   *
   * Rejects with typage's own message when the passphrase is wrong, which is
   * what lets the unlock command offer a retry instead of a stack trace.
   *
   * @param {string} passphrase
   * @param {{preferCryptoKey?: boolean}} [opts]
   */
  async unlock(passphrase, opts = {}) {
    if (!this.stored) throw new Error("keyring: not set up");
    const secret = await unwrapInWorker(this.stored.wrappedIdentity, passphrase);
    if (opts.preferCryptoKey !== false) {
      const key = await toNonExtractableKey(secret);
      if (key) {
        this.identity = key;
        this.identityKind = "cryptokey";
        this.emit("change");
        return;
      }
    }
    this.identity = secret;
    this.identityKind = "string";
    this.emit("change");
  }

  /**
   * Drop the identity. Manual lock only, per the decision log.
   *
   * Dropping the reference is all we can do for a string identity; JS gives no
   * way to zero it. With a CryptoKey there is nothing to zero in the JS heap at
   * all. The caller must also drop cached editor states of encrypted docs,
   * which is a store concern, not a keyring one.
   */
  lock() {
    this.identity = null;
    this.identityKind = "none";
    this.emit("change");
  }

  /** Forget this device. The wrapped identity is unrecoverable afterwards. */
  async forget() {
    await deleteSetting(STORE_KEY);
    this.stored = null;
    this.peers = [];
    this.lock();
  }

  /**
   * Recipient set for a preset. Presets first, per-device picking later.
   * The recovery recipients are in every set by default and are not optional.
   * @param {"all-devices" | "this-device"} preset
   * @returns {string[]}
   */
  recipientsFor(preset) {
    if (!this.stored) throw new Error("keyring: not set up");
    const set = [this.stored.deviceRecipient];
    if (preset === "all-devices") {
      for (const device of this.peers) {
        if (device.recipient && !set.includes(device.recipient)) {
          set.push(device.recipient);
        }
      }
    }
    for (const recipient of this.stored.recoveryRecipients) {
      if (!set.includes(recipient)) set.push(recipient);
    }
    return set;
  }

  /** @param {string} type */
  emit(type) {
    this.dispatchEvent(new CustomEvent(type));
  }
}

/**
 * The keyring record's content for a freshly set-up device (architecture.md
 * §13.3). The record itself is a buffer record; the document store writes it.
 *
 * @param {KeyRing} keyring
 * @returns {KeyringContent}
 */
export function keyringContentFor(keyring) {
  const stored = keyring.stored;
  if (!stored) throw new Error("keyring: not set up");
  return {
    v: 1,
    devices: [
      {
        id: stored.deviceId,
        name: stored.deviceName,
        recipient: stored.deviceRecipient,
        addedAt: stored.createdAt,
      },
    ],
    recovery: [...stored.recoveryRecipients],
  };
}

/**
 * Parse a keyring buffer record. Returns null for a missing or unreadable one,
 * because a corrupt record must degrade to "no peers", never to a broken app.
 *
 * @param {{content?: string} | undefined} record
 * @returns {KeyringContent | null}
 */
export function readKeyringContent(record) {
  if (!record || !record.content) return null;
  try {
    const parsed = JSON.parse(record.content);
    if (!parsed || !Array.isArray(parsed.devices)) return null;
    return parsed;
  } catch {
    return null;
  }
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
    const raw = decodeBech32Secret(identity);
    const pkcs8 = new Uint8Array(PKCS8_X25519_PREFIX.length + raw.length);
    pkcs8.set(PKCS8_X25519_PREFIX, 0);
    pkcs8.set(raw, PKCS8_X25519_PREFIX.length);
    return await crypto.subtle.importKey("pkcs8", pkcs8, { name: "X25519" }, false, [
      "deriveBits",
    ]);
  } catch {
    return null;
  }
}

/** Does this browser have X25519 in WebCrypto at all? */
export async function hasWebCryptoX25519() {
  try {
    await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
    return true;
  } catch {
    return false;
  }
}

/* --- bech32 for AGE-SECRET-KEY-1 ----------------------------------------- */

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/**
 * Decode the 32 secret bytes out of an `AGE-SECRET-KEY-1...` string.
 * We do not import @scure/base here on purpose: this module depends on the age
 * wrapper only, not on typage's own dependencies.
 * @param {string} s
 */
function decodeBech32Secret(s) {
  const lower = s.toLowerCase();
  const sep = lower.lastIndexOf("1");
  if (!lower.startsWith("age-secret-key-") || sep < 0) {
    throw new Error("not an age identity");
  }
  const data = lower.slice(sep + 1, lower.length - 6); // drop the 6-char checksum
  let acc = 0;
  let bits = 0;
  const out = [];
  for (const ch of data) {
    const v = BECH32_CHARSET.indexOf(ch);
    if (v < 0) throw new Error("bad bech32 char");
    acc = (acc << 5) | v;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  if (out.length !== 32) throw new Error("bad identity length");
  return new Uint8Array(out);
}
