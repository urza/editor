// @ts-check
// This device's keys, its unlock state, and the recipient sets
// (architecture.md §5, §27).
//
// A device has one key pair for each job: X25519 to decrypt (age) and Ed25519
// to sign space log entries. No other kind of key exists; who may read a note
// follows from the space logs (crypto/spaces.js), never from this file.
//
// Two ways to hold the keys, chosen per device with the switch "Ask for a
// passphrase at start":
//
// - Off (the default): both keys are non-extractable WebCrypto keys, stored
//   as CryptoKeys in the IndexedDB `settings` row. The device needs no
//   prompt, and no script can copy a key off it: IndexedDB holds a handle to
//   the key, never its bytes. This is the one place a usable private key sits
//   in IndexedDB, and only in this form. Never store an extractable key or a
//   key string next to it.
// - On: both secrets are age-wrapped with the passphrase, as before §27, and
//   unwrapped into memory once per session.
//
// A change of the switch makes a new device (makeSuccessor), because a
// non-extractable key can never be wrapped later.

import { deleteSetting, getSetting, putSetting } from "../storage/idb.js";
import { on, post } from "../model/channel.js";
import { deviceId, setDeviceId } from "../model/device.js";
import * as age from "./age.js";
import * as sign from "./sign.js";
import { unwrapInWorker, wrapInWorker } from "./unlock.js";

const STORE_KEY = "keyring";
// The keys of this device before a change of the passphrase switch, and the
// notes still encrypted for them (architecture.md §27). A row of its own: the
// keyring row's "setting" message drops the keys of a window with a
// passphrase, and this one is written once per round of re-encryption.
const REKEY_KEY = "keyring.rekey";

// Instances that already follow the other windows' setting writes (§14.2).
const watching = new WeakSet();

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
 * What the device stores about itself, under one settings row.
 * @typedef {Object} StoredKeyring
 * @property {2} v  1 was the format before §27: always wrapped, with the
 *   approvals and pins of §21 and §26. unlock() upgrades it.
 * @property {string} deviceId
 * @property {string} deviceName
 * @property {string} deviceRecipient  `age1...`
 * @property {string} signKey  Ed25519 public key, hex.
 * @property {number} createdAt
 * @property {boolean} askPassphrase  The switch "Ask for a passphrase at start".
 * @property {CryptoKey} [identityKey]  Switch off: the X25519 key.
 * @property {CryptoKey} [signingKey]  Switch off: the Ed25519 key.
 * @property {string} [wrappedIdentity]  Switch on: the age identity, wrapped.
 * @property {string} [wrappedSigning]  Switch on: the Ed25519 secret, wrapped.
 * @property {string[]} recoveryRecipients  The recovery keys this device
 *   encrypts to: the one it made as the first device, or the ones its join
 *   reply carried (architecture.md §27). Never read from the server alone.
 */

/**
 * A device as the space logs and the keyring record name it.
 * @typedef {{id: string, name: string, recipient: string, signKey: string, addedAt: number}} DeviceEntry
 */

/**
 * The keyring record's content (architecture.md §13.3, §27): the device
 * entries, so each device can show the names of the others. It decides
 * nothing: a reader of a note comes from a signed space log.
 * @typedef {{v: 2, devices: DeviceEntry[]}} KeyringContent
 */

/**
 * The identity of one device entry: every field, one per line. A space log
 * names devices by this string, and the server reads the id from its second
 * line (server/Vrtti.Server/SpaceLog.cs, DeviceIdOf).
 * @param {DeviceEntry} device
 */
export function entryKey(device) {
  return ["vrtti-device", device.id, device.name, device.recipient, device.signKey ?? "", String(device.addedAt)].join("\n");
}

/** Can this browser keep both keys as stored CryptoKeys? Cached. @type {Promise<boolean> | null} */
let storedKeysSupport = null;

/**
 * Both keys of a device without a passphrase need WebCrypto X25519 and
 * Ed25519. A browser that lacks one keeps the passphrase (§27).
 * @returns {Promise<boolean>}
 */
export function supportsStoredKeys() {
  storedKeysSupport ??= (async () => {
    try {
      await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
      await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
      return true;
    } catch {
      return false;
    }
  })();
  return storedKeysSupport;
}

/**
 * Fresh keys for a device, in the form its switch asks for.
 * @param {{deviceId: string, deviceName: string, askPassphrase: boolean, passphrase?: string,
 *          recoveryRecipients: string[], workFactor?: number}} opts
 * @returns {Promise<{stored: StoredKeyring, identity: string | CryptoKey, signer: sign.Signer}>}
 */
async function makeKeys(opts) {
  const base = {
    v: /** @type {2} */ (2),
    deviceId: opts.deviceId,
    deviceName: opts.deviceName,
    createdAt: Date.now(),
    askPassphrase: opts.askPassphrase,
    recoveryRecipients: [...opts.recoveryRecipients],
  };
  if (!opts.askPassphrase) {
    const pair = /** @type {CryptoKeyPair} */ (
      await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])
    );
    const signing = await sign.generateStoredSigningKey();
    const recipient = await age.toRecipient(pair.privateKey);
    return {
      stored: {
        ...base,
        deviceRecipient: recipient,
        signKey: signing.public,
        identityKey: pair.privateKey,
        signingKey: signing.key,
      },
      identity: pair.privateKey,
      signer: signing.key,
    };
  }
  if (!opts.passphrase) throw new Error("keyring: a passphrase is required");
  const device = await age.generateIdentity();
  const signing = sign.generateSigningKey();
  const wrappedIdentity = await wrapInWorker(device.identity, opts.passphrase, { workFactor: opts.workFactor });
  const wrappedSigning = await wrapInWorker(signing.secret, opts.passphrase, { workFactor: opts.workFactor });
  return {
    stored: { ...base, deviceRecipient: device.recipient, signKey: signing.public, wrappedIdentity, wrappedSigning },
    identity: (await toNonExtractableKey(device.identity)) ?? device.identity,
    signer: signing.secret,
  };
}

export class KeyRing extends EventTarget {
  constructor() {
    super();
    /** @type {StoredKeyring | any | null} Any: a v1 row until unlock() upgrades it. */
    this.stored = null;
    /** @type {string | CryptoKey | null} */
    this.identity = null;
    /** @type {sign.Signer | null} */
    this.signer = null;
    /**
     * Identities of this device before a change of the passphrase switch.
     * They still decrypt the notes until each is encrypted again for the
     * new key (makeSuccessor); nothing encrypts to them.
     * @type {(string | CryptoKey)[]}
     */
    this.previous = [];
    /**
     * The ids of the notes and "Titles only" stubs still encrypted for
     * `previous`. Stored with those keys (REKEY_KEY): an app closed before
     * the re-encryption ends must still open them at the next start.
     * @type {Set<string>}
     */
    this.rekeyIds = new Set();
    /** @type {KeyringContent | null} The keyring record, for device names. */
    this.content = null;
  }

  get isSetUp() {
    return this.stored !== null;
  }
  get isUnlocked() {
    return this.identity !== null;
  }
  /** A row from before §27: the next unlock asks the old passphrase once and upgrades it. */
  get needsUpgrade() {
    return this.stored !== null && this.stored.v !== 2;
  }
  get askPassphrase() {
    return Boolean(this.stored && (this.stored.v !== 2 || this.stored.askPassphrase));
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

  /** Read the stored keys. A device without a passphrase is unlocked from here on. */
  async load() {
    this.stored = (await getSetting(STORE_KEY)) ?? null;
    this.takeStoredKeys();
    await this.loadRekey();
    if (!watching.has(this)) {
      watching.add(this);
      // Setup, an upgrade or a successor ran in another window: follow it.
      on("setting", ({ key }) => {
        if (key === REKEY_KEY) {
          // A change of the switch in another window: this window's tabs
          // are its own to encrypt again, and "change" runs that.
          this.loadRekey().then(() => this.emit("change"));
          return;
        }
        if (key !== STORE_KEY) return;
        this.identity = null;
        this.signer = null;
        this.load().then(() => this.emit("change"));
      });
      // The unlock of a device with a passphrase travels (architecture.md
      // §14.3): one passphrase per session, not one per window. A CryptoKey
      // clones across same-origin contexts and stays non-extractable.
      on("unlock", ({ identity, signer }) => {
        if (this.isUnlocked || !this.stored) return;
        this.identity = identity;
        this.signer = signer ?? null;
        this.emit("change");
      });
      on("lock", () => {
        if (this.isUnlocked && this.askPassphrase) this.lock({ broadcast: false });
      });
      on("who-is-unlocked", () => {
        if (this.isUnlocked && this.askPassphrase) this.share();
      });
    }
    return this.stored;
  }

  /** Switch off: the stored CryptoKeys are the unlocked state, with no prompt. */
  takeStoredKeys() {
    const stored = this.stored;
    if (stored && stored.v === 2 && !stored.askPassphrase && stored.identityKey && stored.signingKey) {
      this.identity = stored.identityKey;
      this.signer = stored.signingKey;
    }
  }

  /** Offer this window's unlocked keys to the others. */
  share() {
    if (!this.isUnlocked) return;
    post("unlock", { identity: this.identity, signer: this.signer });
  }

  /** A window that just booted asks whether anyone is unlocked already. */
  askUnlock() {
    if (this.isUnlocked || !this.stored) return;
    post("who-is-unlocked", {});
  }

  /** This device's entry, from what it stored and never from the server. @returns {DeviceEntry | null} */
  ownEntry() {
    const s = this.stored;
    if (!s || !s.signKey) return null;
    return { id: s.deviceId, name: s.deviceName, recipient: s.deviceRecipient, signKey: s.signKey, addedAt: s.createdAt };
  }

  /** @returns {string} This device's entry key, or "" before setup. */
  ownKey() {
    const own = this.ownEntry();
    return own ? entryKey(own) : "";
  }

  /**
   * The keyring record, for names only (sync's deviceName reads it). No
   * "change" event: that event runs the re-encryption of every note, and a
   * list of names changes nothing about who reads a note.
   * @param {KeyringContent | null} content
   */
  setContent(content) {
    this.content = content;
  }

  /**
   * First run on a device (architecture.md §27).
   *
   * The first device makes the recovery key here and gets it back exactly
   * once; the caller shows it, and only its public half is kept. A device
   * that joins with a code makes none: its join reply carries the recovery
   * keys of the others (setRecovery).
   * @param {{deviceName?: string, askPassphrase?: boolean, passphrase?: string,
   *          firstDevice?: boolean, workFactor?: number}} [opts]
   * @returns {Promise<{recoveryIdentity: string | null}>}
   */
  async setup(opts = {}) {
    const askPassphrase = Boolean(opts.askPassphrase) || !(await supportsStoredKeys());
    /** @type {string | null} */
    let recoveryIdentity = null;
    /** @type {string[]} */
    let recoveryRecipients = [];
    if (opts.firstDevice) {
      const recovery = await age.generateIdentity();
      recoveryIdentity = recovery.identity;
      recoveryRecipients = [recovery.recipient];
    }
    const made = await makeKeys({
      // Not minted here: the device id lives in model/device.js, which the
      // history and the server registration read too.
      deviceId: await deviceId(),
      deviceName: opts.deviceName || "this device",
      askPassphrase,
      passphrase: opts.passphrase,
      recoveryRecipients,
      workFactor: opts.workFactor,
    });
    await this.save(made.stored);
    this.identity = made.identity;
    this.signer = made.signer;
    this.emit("change");
    if (askPassphrase) this.share();
    return { recoveryIdentity };
  }

  /**
   * Unwrap the keys of a device with a passphrase. On a row from before §27
   * this is also the one-time upgrade: the old passphrase unwraps both
   * secrets, and where the browser can, they become stored non-extractable
   * keys and the device never asks again (architecture.md §27).
   *
   * Rejects with typage's own message when the passphrase is wrong, which is
   * what lets the unlock command offer a retry instead of a stack trace.
   * @param {string} passphrase
   */
  async unlock(passphrase) {
    const stored = this.stored;
    if (!stored) throw new Error("keyring: not set up");
    const secret = await unwrapInWorker(stored.wrappedIdentity, passphrase);
    // A device set up before §21 has no signing key; it gets one now.
    const signing =
      stored.wrappedSigning && stored.signKey
        ? { secret: await unwrapInWorker(stored.wrappedSigning, passphrase), public: stored.signKey }
        : sign.generateSigningKey();

    if (stored.v !== 2) {
      const identityKey = await toNonExtractableKey(secret);
      if (identityKey && (await supportsStoredKeys())) {
        const signingKey = await sign.importSigningSecret(signing.secret);
        await this.save(this.upgraded(stored, { askPassphrase: false, signKey: signing.public, identityKey, signingKey }));
        this.identity = identityKey;
        this.signer = signingKey;
        this.emit("change");
        return;
      }
      const wrappedSigning = stored.wrappedSigning ?? (await wrapInWorker(signing.secret, passphrase));
      await this.save(this.upgraded(stored, { askPassphrase: true, signKey: signing.public, wrappedIdentity: stored.wrappedIdentity, wrappedSigning }));
    }

    this.identity = (await toNonExtractableKey(secret)) ?? secret;
    this.signer = (await sign.importSigningSecret(signing.secret).catch(() => null)) ?? signing.secret;
    this.emit("change");
    this.share();
  }

  /**
   * A v2 row from a v1 row. The approvals, pins and trusted ids of §21 and
   * §26 are dropped: trust is per space now, from the logs.
   * @param {any} old @param {Partial<StoredKeyring>} keys @returns {StoredKeyring}
   */
  upgraded(old, keys) {
    return /** @type {StoredKeyring} */ ({
      v: 2,
      deviceId: old.deviceId,
      deviceName: old.deviceName,
      deviceRecipient: old.deviceRecipient,
      createdAt: old.createdAt,
      recoveryRecipients: [...(old.recoveryRecipients ?? [])],
      ...keys,
    });
  }

  /**
   * Drop the keys of a device with a passphrase. A device without one has
   * nothing to lock: its keys are the stored ones.
   *
   * A lock is for the whole app, so it travels to the other windows; the
   * receiving end passes broadcast: false, or the windows would lock each
   * other for ever.
   * @param {{broadcast?: boolean}} [options]
   */
  lock({ broadcast = true } = {}) {
    if (!this.askPassphrase) return;
    this.identity = null;
    this.signer = null;
    this.emit("change");
    if (broadcast) post("lock", {});
  }

  /** Forget this device. Its keys are gone for good afterwards. */
  async forget() {
    await deleteSetting(STORE_KEY);
    post("setting", { key: STORE_KEY });
    this.previous = [];
    this.rekeyIds.clear();
    await this.saveRekey();
    this.stored = null;
    this.content = null;
    this.identity = null;
    this.signer = null;
    this.emit("change");
  }

  /**
   * The recovery keys a join reply carried (architecture.md §27). Added, never
   * replaced: the first device's own key stays whatever a reply says.
   * @param {string[]} recipients
   */
  async addRecovery(recipients) {
    const stored = /** @type {StoredKeyring} */ (this.stored);
    const list = [...stored.recoveryRecipients];
    for (const r of recipients) if (typeof r === "string" && r.startsWith("age1") && !list.includes(r)) list.push(r);
    if (list.length === stored.recoveryRecipients.length) return;
    await this.save({ ...stored, recoveryRecipients: list });
    this.emit("change");
  }

  /**
   * New keys under a new device id, for a change of the passphrase switch
   * (architecture.md §27). Nothing is stored: the sync client registers the
   * successor and moves the memberships while this device still holds both,
   * then calls adopt().
   * @param {{askPassphrase: boolean, passphrase?: string}} opts
   */
  async makeSuccessor(opts) {
    const stored = /** @type {StoredKeyring} */ (this.stored);
    return makeKeys({
      deviceId: crypto.randomUUID(),
      deviceName: stored.deviceName,
      askPassphrase: opts.askPassphrase,
      passphrase: opts.passphrase,
      recoveryRecipients: stored.recoveryRecipients,
    });
  }

  /**
   * The successor from its stored row, for a change of the switch that
   * stopped after the server registered it. A row with a passphrase needs
   * the one chosen at that first try; a wrong one rejects.
   * @param {StoredKeyring} stored @param {string} [passphrase]
   * @returns {Promise<{stored: StoredKeyring, identity: string | CryptoKey, signer: sign.Signer}>}
   */
  async restoreSuccessor(stored, passphrase) {
    if (!stored.askPassphrase) {
      return {
        stored,
        identity: /** @type {CryptoKey} */ (stored.identityKey),
        signer: /** @type {CryptoKey} */ (stored.signingKey),
      };
    }
    if (!passphrase) throw new Error("keyring: a passphrase is required");
    const secret = await unwrapInWorker(/** @type {string} */ (stored.wrappedIdentity), passphrase);
    const signing = await unwrapInWorker(/** @type {string} */ (stored.wrappedSigning), passphrase);
    return {
      stored,
      identity: (await toNonExtractableKey(secret)) ?? secret,
      signer: (await sign.importSigningSecret(signing).catch(() => null)) ?? signing,
    };
  }

  /**
   * Become the successor. The old identity stays in `previous`, so the notes
   * still encrypted for it open until each is encrypted again.
   * @param {{stored: StoredKeyring, identity: string | CryptoKey, signer: sign.Signer}} next
   * @param {string[]} rekeyIds The notes and stubs encrypted for the old keys.
   */
  async adopt(next, rekeyIds) {
    if (this.identity) this.previous.push(this.identity);
    for (const id of rekeyIds) this.rekeyIds.add(id);
    // Before the new row: a start between the two writes then still has
    // the old key for every note.
    await this.saveRekey();
    await setDeviceId(next.stored.deviceId);
    await this.save(next.stored);
    this.identity = next.identity;
    this.signer = next.signer;
    this.emit("change");
    if (next.stored.askPassphrase) this.share();
  }

  /** Is this note or stub still encrypted for the keys before a switch change? @param {string} id */
  needsRekey(id) {
    return this.rekeyIds.has(id);
  }

  /**
   * These notes are encrypted for the new keys now. `live` is every note
   * and stub that still exists: an id outside it has nothing left to
   * encrypt. With no id left, the old keys go.
   * @param {Iterable<string>} done @param {Set<string>} [live]
   */
  async rekeyDone(done, live) {
    if (!this.rekeyIds.size) return;
    const before = this.rekeyIds.size;
    for (const id of done) this.rekeyIds.delete(id);
    if (live) for (const id of [...this.rekeyIds]) if (!live.has(id)) this.rekeyIds.delete(id);
    if (this.rekeyIds.size === before) return;
    if (!this.rekeyIds.size) this.previous = [];
    await this.saveRekey();
  }

  async loadRekey() {
    const row = await getSetting(REKEY_KEY);
    const ids = Array.isArray(row?.ids) ? row.ids.filter((/** @type {unknown} */ id) => typeof id === "string") : [];
    this.rekeyIds = new Set(ids);
    if (!this.rekeyIds.size) {
      this.previous = [];
      return;
    }
    const stored = Array.isArray(row?.identities) ? row.identities.filter((/** @type {unknown} */ k) => k instanceof CryptoKey) : [];
    // A string identity (a browser without X25519 in WebCrypto) is never
    // stored in the clear; it lives in the memory of this window only.
    const inMemory = this.previous.filter((k) => typeof k === "string");
    this.previous = [...stored, ...inMemory];
  }

  /**
   * The old keys are stored as they are, non-extractable CryptoKeys. After
   * a change to "ask for a passphrase", this keeps an old key without one
   * until the last note is encrypted again, because a non-extractable key
   * cannot be wrapped (architecture.md §27).
   */
  async saveRekey() {
    if (this.rekeyIds.size) {
      await putSetting(REKEY_KEY, {
        identities: this.previous.filter((k) => typeof k !== "string"),
        ids: [...this.rekeyIds],
      });
    } else {
      await deleteSetting(REKEY_KEY);
    }
    post("setting", { key: REKEY_KEY });
  }

  /** Every identity that may decrypt: this device's, then the ones before a switch change. */
  identities() {
    return this.identity ? [this.identity, ...this.previous] : [];
  }

  /** @param {string} message @returns {Promise<string>} */
  sign(message) {
    if (!this.signer) throw new Error("keyring: locked");
    return sign.sign(message, this.signer);
  }

  /** @param {StoredKeyring} stored */
  async save(stored) {
    this.stored = stored;
    await putSetting(STORE_KEY, stored);
    post("setting", { key: STORE_KEY });
  }

  /**
   * Recipient set for a preset (architecture.md §5, §27). The recovery keys
   * are in every set and are not optional.
   * - "space": the members of the note's space; the caller resolves them from
   *   the verified log and hands them in.
   * - "this-device": this device. Also "all-devices", a preset from before
   *   §27 that a local note may still carry; a synced one became "space".
   * @param {string} preset @param {string[]} [members] Recipients of the space.
   * @returns {string[]}
   */
  recipientsFor(preset, members = []) {
    if (!this.stored) throw new Error("keyring: not set up");
    /** @type {string[]} */
    const set = [];
    if (preset === "space") {
      // Never a guess: a space whose members this device does not know is a
      // note it must not encrypt, or it would lock out the others.
      if (!members.length) throw new Error("keyring: no members for this space");
      set.push(...members);
    } else {
      set.push(this.stored.deviceRecipient);
    }
    for (const recipient of this.recoveryRecipients) {
      if (!set.includes(recipient)) set.push(recipient);
    }
    return [...new Set(set)];
  }

  /** @param {string} type */
  emit(type) {
    this.dispatchEvent(new CustomEvent(type));
  }
}

/**
 * What this device says about itself in the keyring record. Merged into the
 * record whenever the device starts with keys (architecture.md §27).
 * @param {KeyRing} keyring @returns {KeyringContent}
 */
export function keyringContentFor(keyring) {
  const own = keyring.ownEntry();
  return { v: 2, devices: own ? [own] : [] };
}

/**
 * Union two keyring contents (architecture.md §13.3). The keyring record is
 * the one record that merges instead of forking. A plain set union of
 * entries, by entry key; nothing in it is trusted, so no rule picks a winner.
 * The incoming (server) version leads the order, and what the local copy
 * knows on top is appended, so `merge(local, remote)` equals
 * `merge(null, remote)` exactly when the local copy had nothing to add.
 * Every entry is checked on the way in: the record is data from the server.
 * @param {any} local @param {any} remote @returns {KeyringContent}
 */
export function mergeKeyringContent(local, remote) {
  /** @type {DeviceEntry[]} */
  const devices = [];
  const seen = new Set();
  for (const source of [remote, local]) {
    for (const raw of Array.isArray(source?.devices) ? source.devices : []) {
      const device = cleanDevice(raw);
      if (!device) continue;
      const key = entryKey(device);
      if (seen.has(key)) continue;
      seen.add(key);
      devices.push(device);
    }
  }
  return { v: 2, devices };
}

/**
 * One entry as the record may carry it, or null for a row that is not one.
 * Rows from before §27 without a signing key drop out: no log can name them.
 * @param {any} raw @returns {DeviceEntry | null}
 */
function cleanDevice(raw) {
  if (!raw || typeof raw !== "object") return null;
  const { id, name, recipient, addedAt, signKey } = raw;
  if (typeof id !== "string" || !id || id === "__proto__" || id.includes("\n")) return null;
  if (typeof name !== "string" || name.includes("\n")) return null;
  if (typeof recipient !== "string" || !recipient || typeof signKey !== "string" || !signKey) return null;
  if (typeof addedAt !== "number" || !Number.isFinite(addedAt)) return null;
  return { id, name, recipient, signKey, addedAt };
}

/**
 * Parse a keyring buffer record. Returns null for a missing or unreadable one,
 * because a corrupt record must degrade to "no names", never to a broken app.
 * @param {{content?: string} | undefined} record
 * @returns {KeyringContent | null}
 */
export function readKeyringContent(record) {
  if (!record || !record.content) return null;
  try {
    const parsed = JSON.parse(record.content);
    if (!parsed || !Array.isArray(parsed.devices)) return null;
    return mergeKeyringContent(null, parsed);
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
