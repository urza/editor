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
import { on, post } from "../model/channel.js";

// Instances that already follow the other windows' setting writes (§14.2).
const watching = new WeakSet();
import { deviceId } from "../model/device.js";
import * as age from "./age.js";
import * as sign from "./sign.js";
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
 *   identities this device trusts on its own: the one it generated, or the
 *   ones it adopted before §21. A device that joins under §21 keeps this
 *   empty and trusts recovery keys through approvals instead. A list, not
 *   one value: two devices set up before sync each generate one, the keyring
 *   merge keeps both, and every recipient set then carries both so either
 *   paper key restores everything (architecture.md §13.2).
 * @property {number} createdAt
 * @property {string} [signKey]  Public half of the Ed25519 signing key, hex
 *   (architecture.md §21). Absent on a device that has not unlocked since
 *   the unit shipped; unlock() adds it.
 * @property {string} [wrappedSigning]  The signing secret, age-armored to
 *   the passphrase, like wrappedIdentity.
 * @property {Record<string, string>} [selfApprovals]  recipient -> this
 *   device's signature over `vrtti-recovery\n<recipient>`, made while the
 *   signing secret was at hand (setup, or the migration at unlock), so the
 *   keyring record can carry them without an unlock.
 * @property {string[]} [trusted]  Device ids the user confirmed by hand on
 *   this device ("Is this your device?"). The roots of the trust
 *   computation next to this device itself.
 */

/**
 * One device as it appears in the keyring record (architecture.md §13.3).
 * @typedef {Object} KeyringDevice
 * @property {string} id
 * @property {string} name
 * @property {string} recipient
 * @property {number} addedAt
 * @property {string} [signKey]  Ed25519 public key, hex (§21). Absent for a
 *   device that has not unlocked since the unit shipped.
 * @property {Approval[]} [approvals]  Who vouched for this entry.
 */

/**
 * One signature over an entry (architecture.md §21). `by` names the signing
 * device; its `signKey` in the record verifies `sig`.
 * @typedef {{by: string, sig: string}} Approval
 */

/**
 * The keyring record's content. `v` stays 1 on purpose: a reader from before
 * §21 ignores the fields it does not know, and `recovery` stays a list of
 * strings for the same reason, with the approvals beside it.
 * @typedef {{v: 1, devices: KeyringDevice[], recovery: string[],
 *            recoveryApprovals?: Record<string, Approval[]>}} KeyringContent
 */

/** @param {KeyringDevice} device The bytes an approval of a device entry signs. */
function devicePayload(device) {
  return ["vrtti-device", device.id, device.name, device.recipient, device.signKey ?? "", String(device.addedAt)].join("\n");
}

/** @param {string} recipient The bytes an approval of a recovery key signs. */
function recoveryPayload(recipient) {
  return ["vrtti-recovery", recipient].join("\n");
}

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
     * The unlocked signing secret, hex (architecture.md §21). In the JS heap
     * while unlocked, like the string identity; cleared on lock.
     * @type {string | null}
     */
    this.signing = null;
    /**
     * The keyring record's content, from the document store. Set by the
     * bootstrap and refreshed whenever that record changes; the keyring
     * itself never reads the document store.
     * @type {KeyringContent | null}
     */
    this.content = null;
    /** Cache of trustedIds(), keyed by the content and the local roots. */
    this._trustKey = "";
    /** @type {Set<string>} */
    this._trusted = new Set();
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
    if (!watching.has(this)) {
      watching.add(this);
      // Setup or forget ran in another window: follow it.
      on("setting", ({ key }) => {
        if (key !== STORE_KEY) return;
        this.load().then(() => this.emit("change"));
      });
      // The unlock travels (architecture.md §14.3): one passphrase per
      // session, not one per window. A CryptoKey clones across same-origin
      // contexts and stays non-extractable; the string form is the fallback
      // for engines without X25519 in WebCrypto, on the same origin only.
      on("unlock", ({ identity, kind, signing }) => {
        if (this.isUnlocked || !this.stored) return;
        this.identity = identity;
        this.identityKind = kind;
        this.signing = signing ?? null;
        this.emit("change");
      });
      on("lock", () => {
        if (this.isUnlocked) this.lock({ broadcast: false });
      });
      on("who-is-unlocked", () => {
        if (this.isUnlocked) this.share();
      });
    }
    return this.stored;
  }

  /** Offer this window's identity to the others. */
  share() {
    if (!this.isUnlocked) return;
    post("unlock", { identity: this.identity, kind: this.identityKind, signing: this.signing });
  }

  /** A window that just booted asks whether anyone is unlocked already. */
  askUnlock() {
    if (this.isUnlocked || !this.stored) return;
    post("who-is-unlocked", {});
  }

  /**
   * The keyring record this keyring resolves "all-devices" against. Emits
   * "change" when the content differs, so the Settings device list follows a
   * pull without watching the document store itself.
   * @param {KeyringContent | null} content
   */
  setContent(content) {
    const before = JSON.stringify(this.content);
    this.content = content;
    if (JSON.stringify(content) !== before) this.emit("change");
  }

  /** @returns {KeyringDevice | null} This device's entry in the record. */
  ownEntry() {
    const id = this.deviceId;
    return this.content?.devices.find((d) => d.id === id) ?? null;
  }

  /**
   * The devices this one trusts, computed from the record (architecture.md
   * §21): this device and the ids confirmed by hand are the roots, and every
   * entry approved by a trusted device joins, until nothing changes. A pure
   * function of the record and the local roots, cached on both.
   * @returns {Set<string>}
   */
  trustedIds() {
    const me = this.deviceId;
    if (!me) return new Set();
    const roots = [me, ...(this.stored?.trusted ?? [])];
    const key = JSON.stringify(this.content) + "|" + roots.join(",");
    if (key === this._trustKey) return this._trusted;
    const trusted = new Set(roots);
    const devices = this.content?.devices ?? [];
    const byId = new Map(devices.map((d) => [d.id, d]));
    let grew = true;
    while (grew) {
      grew = false;
      for (const device of devices) {
        if (trusted.has(device.id)) continue;
        for (const approval of device.approvals ?? []) {
          const signer = byId.get(approval.by);
          if (!signer || !signer.signKey || !trusted.has(signer.id)) continue;
          if (sign.verify(approval.sig, devicePayload(device), signer.signKey)) {
            trusted.add(device.id);
            grew = true;
            break;
          }
        }
      }
    }
    this._trustKey = key;
    this._trusted = trusted;
    return trusted;
  }

  /**
   * The recovery recipients this device encrypts to: its own stored list,
   * plus every one in the record with a valid approval by a trusted device.
   * @returns {string[]}
   */
  trustedRecovery() {
    const set = [...(this.stored?.recoveryRecipients ?? [])];
    const trusted = this.trustedIds();
    const byId = new Map((this.content?.devices ?? []).map((d) => [d.id, d]));
    for (const recipient of this.content?.recovery ?? []) {
      if (set.includes(recipient)) continue;
      for (const approval of this.content?.recoveryApprovals?.[recipient] ?? []) {
        const signer = byId.get(approval.by);
        if (!signer || !signer.signKey || !trusted.has(signer.id)) continue;
        if (sign.verify(approval.sig, recoveryPayload(recipient), signer.signKey)) {
          set.push(recipient);
          break;
        }
      }
    }
    return set;
  }

  /** @param {string} [publicKey] Hex; this device's when omitted. */
  fingerprint(publicKey = this.stored?.signKey) {
    return publicKey ? sign.fingerprint(publicKey) : "";
  }

  /** The six digits shown on this device while it waits for approval. */
  get pairingCode() {
    return this.stored?.signKey ? sign.pairingCode(this.stored.signKey) : "";
  }

  /**
   * Entries that wait for this device's signature: not trusted here, with a
   * signing key, younger than this device's own entry, and not yet approved
   * by this device with its current key. Younger only: the device being
   * vetted must not be asked to vet its elders, those reach it the other
   * way round, through "Approved by …" (architecture.md §21). An approval
   * by this device that no longer verifies (the key changed) counts as
   * none, so the entry is offered again.
   * @returns {KeyringDevice[]}
   */
  pendingJoins() {
    const me = this.deviceId;
    const own = this.ownEntry();
    const trusted = this.trustedIds();
    return (this.content?.devices ?? []).filter(
      (d) =>
        d.id !== me &&
        !trusted.has(d.id) &&
        Boolean(d.signKey) &&
        (!own || d.addedAt > own.addedAt) &&
        !this.approvedByMe(d)
    );
  }

  /** @param {KeyringDevice} device Does this device's own, current key vouch for the entry? */
  approvedByMe(device) {
    const me = this.deviceId;
    const key = this.stored?.signKey;
    if (!key) return false;
    return (device.approvals ?? []).some(
      (a) => a.by === me && sign.verify(a.sig, devicePayload(device), key)
    );
  }

  /**
   * Devices that vouched for this one and are not trusted here yet: the
   * "Is this your device?" question. A signature that does not verify is
   * not a question, it is noise from the server.
   * @returns {KeyringDevice[]}
   */
  pendingApprovers() {
    const own = this.ownEntry();
    if (!own) return [];
    const trusted = this.trustedIds();
    const byId = new Map((this.content?.devices ?? []).map((d) => [d.id, d]));
    /** @type {KeyringDevice[]} */
    const out = [];
    for (const approval of own.approvals ?? []) {
      const signer = byId.get(approval.by);
      if (!signer || !signer.signKey || trusted.has(signer.id)) continue;
      if (sign.verify(approval.sig, devicePayload(own), signer.signKey)) out.push(signer);
    }
    return out;
  }

  /**
   * One row per device in the record, for Settings (architecture.md §21).
   * "waiting" is an entry this device can approve (younger, see
   * pendingJoins); "not confirmed" is an elder that has to approve this
   * device first, after which it shows up as "approved you".
   * @returns {{id: string, name: string, fingerprint: string, addedAt: number,
   *            state: "this device" | "trusted" | "waiting" | "not confirmed" | "approved you" | "needs update"}[]}
   */
  deviceRows() {
    const me = this.deviceId;
    const own = this.ownEntry();
    const trusted = this.trustedIds();
    const approvers = new Set(this.pendingApprovers().map((d) => d.id));
    return (this.content?.devices ?? []).map((d) => ({
      id: d.id,
      name: d.name,
      fingerprint: d.signKey ? sign.fingerprint(d.signKey) : "",
      addedAt: d.addedAt,
      state:
        d.id === me
          ? "this device"
          : !d.signKey
            ? "needs update"
            : trusted.has(d.id)
              ? "trusted"
              : approvers.has(d.id)
                ? "approved you"
                : own && d.addedAt <= own.addedAt
                  ? "not confirmed"
                  : "waiting",
    }));
  }

  /**
   * Sign another device's entry, after the user typed its pairing code
   * (architecture.md §21). Returns the record content with the approval
   * added, for the caller to write; null when the code does not match, so
   * an entry the server injected under that name never gets a signature.
   * @param {string} id @param {string} code As typed.
   * @returns {KeyringContent | null}
   */
  approve(id, code) {
    if (!this.signing || !this.stored || !this.content) throw new Error("keyring: locked");
    const device = this.content.devices.find((d) => d.id === id);
    if (!device || !device.signKey) throw new Error("keyring: unknown device");
    if (sign.normalizeCode(code) !== sign.pairingCode(device.signKey)) return null;
    const me = this.deviceId;
    const next = mergeKeyringContent(null, this.content);
    const entry = /** @type {KeyringDevice} */ (next.devices.find((d) => d.id === id));
    entry.approvals = [
      ...(entry.approvals ?? []).filter((a) => a.by !== me),
      { by: /** @type {string} */ (me), sig: sign.sign(devicePayload(entry), this.signing) },
    ];
    return next;
  }

  /**
   * The user said "yes, that is my device" to an approver: it becomes a root
   * of this device's trust, stored with the keyring.
   * @param {string} id
   */
  async confirm(id) {
    if (!this.stored) throw new Error("keyring: not set up");
    const trusted = this.stored.trusted ?? [];
    if (trusted.includes(id)) return;
    this.stored = { ...this.stored, trusted: [...trusted, id] };
    await putSetting(STORE_KEY, this.stored);
    post("setting", { key: STORE_KEY });
    this.emit("change");
  }

  /**
   * What this device has to add to the record about itself: its signing key
   * on its own entry, and its self-approvals of the recovery keys it trusts.
   * Returns the content to write, or null when the record already says it
   * all. Runs after every unlock (architecture.md §21), which is when a
   * device from before the unit gets its signing key.
   * @returns {KeyringContent | null}
   */
  selfUpdate() {
    const stored = this.stored;
    if (!stored || !this.content || !stored.signKey) return null;
    const next = mergeKeyringContent(null, this.content);
    let changed = false;
    let own = next.devices.find((d) => d.id === stored.deviceId);
    if (!own) {
      own = keyringContentFor(this).devices[0];
      next.devices.push(own);
      changed = true;
    } else if (own.signKey !== stored.signKey) {
      // A new key on the entry means old approvals no longer cover it; they
      // are dropped rather than left to fail verification one by one.
      own.signKey = stored.signKey;
      own.approvals = [];
      changed = true;
    }
    const approvals = next.recoveryApprovals ?? (next.recoveryApprovals = {});
    for (const [recipient, sig] of Object.entries(stored.selfApprovals ?? {})) {
      if (!next.recovery.includes(recipient)) next.recovery.push(recipient);
      const list = approvals[recipient] ?? (approvals[recipient] = []);
      const mine = list.find((a) => a.by === stored.deviceId);
      // Present and still valid: nothing to say. Present but signed by a
      // key this device no longer has: replaced, or the recovery key would
      // silently drop out of every other device's recipient set.
      if (mine && sign.verify(mine.sig, recoveryPayload(recipient), stored.signKey)) continue;
      approvals[recipient] = [...list.filter((a) => a.by !== stored.deviceId), { by: stored.deviceId, sig }];
      changed = true;
    }
    return changed ? next : null;
  }

  /**
   * First run on a device.
   *
   * The recovery identity is generated here and returned exactly once. The
   * caller must show it and tell the user to write it down. We never store the
   * recovery *secret*, only its public recipient, because an offline master key
   * is the whole answer to a lost device (architecture.md §5).
   *
   * `joining` is the other half of that rule: a device joining a keyring
   * that already exists mints no second paper key. It returns null then, and
   * the caller shows nothing. It also adopts nothing: the recovery keys of
   * that keyring become trusted through approvals, after an old device has
   * vouched for this one (architecture.md §21).
   *
   * @param {string} passphrase
   * @param {{deviceName?: string, workFactor?: number, joining?: boolean}} [opts]
   * @returns {Promise<{recoveryIdentity: string | null}>}
   */
  async setup(passphrase, opts = {}) {
    const device = await age.generateIdentity();
    const signing = sign.generateSigningKey();

    /** @type {string | null} */
    let recoveryIdentity = null;
    /** @type {string[]} */
    let recoveryRecipients = [];
    if (!opts.joining) {
      const recovery = await age.generateIdentity();
      recoveryIdentity = recovery.identity;
      recoveryRecipients = [recovery.recipient];
    }

    const wrapped = await wrapInWorker(device.identity, passphrase, {
      workFactor: opts.workFactor,
    });
    const wrappedSigning = await wrapInWorker(signing.secret, passphrase, {
      workFactor: opts.workFactor,
    });
    // Signed now, while the secret is at hand: setup leaves the device
    // locked, and the record still has to carry these (§21).
    /** @type {Record<string, string>} */
    const selfApprovals = {};
    for (const recipient of recoveryRecipients) {
      selfApprovals[recipient] = sign.sign(recoveryPayload(recipient), signing.secret);
    }

    this.stored = {
      v: 1,
      // Not minted here: the sync client stamps every revision with the same
      // id (architecture.md §13.6), so both read it from model/device.js. A
      // second id for one device would be a phantom device in the keyring.
      deviceId: await deviceId(),
      deviceName: opts.deviceName || "this device",
      deviceRecipient: device.recipient,
      wrappedIdentity: wrapped,
      recoveryRecipients,
      createdAt: Date.now(),
      signKey: signing.public,
      wrappedSigning,
      selfApprovals,
      trusted: [],
    };
    await putSetting(STORE_KEY, this.stored);
    post("setting", { key: STORE_KEY });
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
    await this.unlockSigning(passphrase);
    if (opts.preferCryptoKey !== false) {
      const key = await toNonExtractableKey(secret);
      if (key) {
        this.identity = key;
        this.identityKind = "cryptokey";
        this.emit("change");
        this.share();
        return;
      }
    }
    this.identity = secret;
    this.identityKind = "string";
    this.emit("change");
    this.share();
  }

  /**
   * The signing half of unlock (architecture.md §21). A device set up before
   * the unit has no signing key; this is the one moment the passphrase is at
   * hand, so it gets one here, wrapped and stored, with self-approvals of the
   * recovery keys it already trusts. The record learns about it through
   * selfUpdate(), which the bootstrap runs after every unlock.
   * @param {string} passphrase
   */
  async unlockSigning(passphrase) {
    const stored = /** @type {StoredKeyring} */ (this.stored);
    if (stored.wrappedSigning && stored.signKey) {
      this.signing = await unwrapInWorker(stored.wrappedSigning, passphrase);
      return;
    }
    const signing = sign.generateSigningKey();
    const wrappedSigning = await wrapInWorker(signing.secret, passphrase);
    /** @type {Record<string, string>} */
    const selfApprovals = {};
    for (const recipient of stored.recoveryRecipients) {
      selfApprovals[recipient] = sign.sign(recoveryPayload(recipient), signing.secret);
    }
    this.stored = {
      ...stored,
      signKey: signing.public,
      wrappedSigning,
      selfApprovals,
      trusted: stored.trusted ?? [],
    };
    await putSetting(STORE_KEY, this.stored);
    post("setting", { key: STORE_KEY });
    this.signing = signing.secret;
  }

  /**
   * Drop the identity. Manual lock only, per the decision log.
   *
   * Dropping the reference is all we can do for a string identity; JS gives no
   * way to zero it. With a CryptoKey there is nothing to zero in the JS heap at
   * all. The caller must also drop cached editor states of encrypted docs,
   * which is a store concern, not a keyring one.
   *
   * A lock is for the whole app, so it travels to the other windows; the
   * receiving end passes broadcast: false, or the windows would lock each
   * other for ever.
   * @param {{broadcast?: boolean}} [options]
   */
  lock({ broadcast = true } = {}) {
    this.identity = null;
    this.identityKind = "none";
    this.signing = null;
    this.emit("change");
    if (broadcast) post("lock", {});
  }

  /** Forget this device. The wrapped identity is unrecoverable afterwards. */
  async forget() {
    await deleteSetting(STORE_KEY);
    post("setting", { key: STORE_KEY });
    this.stored = null;
    this.content = null;
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
      // Trusted devices only (architecture.md §21): an entry nobody vouched
      // for is a row in the record, not a reader.
      const trusted = this.trustedIds();
      for (const device of this.content?.devices ?? []) {
        if (!trusted.has(device.id)) continue;
        if (device.recipient && !set.includes(device.recipient)) {
          set.push(device.recipient);
        }
      }
    }
    for (const recipient of this.trustedRecovery()) {
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
  /** @type {KeyringDevice} */
  const own = {
    id: stored.deviceId,
    name: stored.deviceName,
    recipient: stored.deviceRecipient,
    addedAt: stored.createdAt,
    approvals: [],
  };
  if (stored.signKey) own.signKey = stored.signKey;
  /** @type {Record<string, Approval[]>} */
  const recoveryApprovals = {};
  for (const [recipient, sig] of Object.entries(stored.selfApprovals ?? {})) {
    recoveryApprovals[recipient] = [{ by: stored.deviceId, sig }];
  }
  return { v: 1, devices: [own], recovery: [...stored.recoveryRecipients], recoveryApprovals };
}

/**
 * Union two keyring contents (architecture.md §13.3). The keyring record is the
 * one record that merges instead of forking: a fork would split the device list
 * in two, and every device would then encrypt to half of the devices.
 *
 * The incoming (server) version leads, and anything the local copy knows and it
 * does not is appended. Union by device id and by recipient string, so two
 * devices that set up before they ever met keep both entries and both recovery
 * keys (§13.2).
 *
 * @param {KeyringContent | null} local
 * @param {KeyringContent | null} remote
 * @returns {KeyringContent}
 */
export function mergeKeyringContent(local, remote) {
  /** @type {KeyringDevice[]} */
  const devices = (remote?.devices ?? []).map((d) => ({ ...d, approvals: [...(d.approvals ?? [])] }));
  const byId = new Map(devices.map((d) => [d.id, d]));
  for (const device of local?.devices ?? []) {
    if (!device || !device.id) continue;
    const known = byId.get(device.id);
    if (!known) {
      const copy = { ...device, approvals: [...(device.approvals ?? [])] };
      byId.set(copy.id, copy);
      devices.push(copy);
      continue;
    }
    // A signing key the other side has not learned yet comes along; a key
    // that changed (the device re-keyed at unlock) replaces the old one.
    if (device.signKey && device.signKey !== known.signKey) known.signKey = device.signKey;
  }
  // Approvals second, once every signer's current key is known: one
  // approval per signer, and where the two sides disagree the one that
  // verifies wins, so a re-signed approval is not lost to a stale server
  // copy (§21). Neither verifying keeps the server's.
  for (const device of local?.devices ?? []) {
    const known = device && byId.get(device.id);
    if (!known) continue;
    known.approvals = unionApprovals(known.approvals, device.approvals ?? [], devicePayload(known), byId);
  }
  const recovery = [...(remote?.recovery ?? [])];
  for (const recipient of local?.recovery ?? []) {
    if (recipient && !recovery.includes(recipient)) recovery.push(recipient);
  }
  /** @type {Record<string, Approval[]>} */
  const recoveryApprovals = {};
  for (const [recipient, list] of Object.entries(remote?.recoveryApprovals ?? {})) {
    recoveryApprovals[recipient] = unionApprovals([], list ?? [], recoveryPayload(recipient), byId);
  }
  for (const [recipient, list] of Object.entries(local?.recoveryApprovals ?? {})) {
    recoveryApprovals[recipient] = unionApprovals(
      recoveryApprovals[recipient] ?? [],
      list ?? [],
      recoveryPayload(recipient),
      byId
    );
  }
  return { v: 1, devices, recovery, recoveryApprovals };
}

/**
 * Union of two approval lists by signer. A newcomer is appended; a signer
 * present on both sides keeps the one that verifies against its current
 * key, the existing one when both or neither do.
 * @param {Approval[]} target @param {Approval[]} incoming @param {string} payload
 * @param {Map<string, KeyringDevice>} byId
 */
function unionApprovals(target, incoming, payload, byId) {
  const out = [...target];
  for (const approval of incoming) {
    if (!approval || !approval.by) continue;
    const index = out.findIndex((a) => a.by === approval.by);
    if (index < 0) {
      out.push(approval);
      continue;
    }
    const key = byId.get(approval.by)?.signKey;
    if (!key) continue;
    if (!sign.verify(out[index].sig, payload, key) && sign.verify(approval.sig, payload, key)) {
      out[index] = approval;
    }
  }
  return out;
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
