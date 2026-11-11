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
 *   this device ("Is this your device?"). Written for a page from before
 *   §26, which reads only this list, and read once by the migration; the
 *   trust computation reads `pins`.
 * @property {Record<string, Pin>} [pins]  The keys each confirmed device had
 *   when the user confirmed it, by device id (architecture.md §26). These
 *   are the roots of the trust computation next to this device itself.
 */

/**
 * What this device remembers of a device the user confirmed by hand
 * (architecture.md §26). A device id alone is not a root: the record comes
 * from the server, and the server can put any keys under any id. A confirmed
 * device counts only while an entry in the record carries exactly these two.
 * @typedef {{signKey: string, recipient: string}} Pin
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
 * device; the `signKey` of a trusted entry of that device verifies `sig`.
 * @typedef {{by: string, sig: string}} Approval
 */

/**
 * One row of the Settings device list (KeyRing.deviceRows). `key` is the
 * entryKey, which is what the approve and confirm commands take.
 * @typedef {{key: string, id: string, name: string, fingerprint: string, addedAt: number,
 *            state: "this device" | "trusted" | "waiting" | "not confirmed" | "approved you" | "needs update",
 *            conflict: boolean}} DeviceRow
 */

/**
 * The keyring record's content. `v` stays 1 on purpose: a reader from before
 * §21 ignores the fields it does not know, and `recovery` stays a list of
 * strings for the same reason, with the approvals beside it.
 *
 * The record is a list of claims, not of facts (architecture.md §26). It
 * travels through the server, so every entry in it is something somebody
 * says, and two entries may say different things under one device id. This
 * device believes an entry only when a pin or a valid signature backs that
 * exact entry; everything else is a row in Settings and nothing more.
 * @typedef {{v: 1, devices: KeyringDevice[], recovery: string[],
 *            recoveryApprovals?: Record<string, Approval[]>}} KeyringContent
 */

/** @param {KeyringDevice} device The bytes an approval of a device entry signs. */
function devicePayload(device) {
  return ["vrtti-device", device.id, device.name, device.recipient, device.signKey ?? "", String(device.addedAt)].join("\n");
}

/**
 * The identity of one entry in the record. An entry is addressed by all of
 * what an approval signs, never by its device id alone: the id is the one
 * field a second, hostile entry would copy (architecture.md §26).
 * @param {KeyringDevice} device
 */
export function entryKey(device) {
  return devicePayload(device);
}

/** @param {string} recipient The bytes an approval of a recovery key signs. */
function recoveryPayload(recipient) {
  return ["vrtti-recovery", recipient].join("\n");
}

/**
 * This device's entry as the record should carry it, from what the device
 * stored at setup.
 * @param {StoredKeyring} stored @returns {KeyringDevice}
 */
function ownEntryOf(stored) {
  /** @type {KeyringDevice} */
  const own = {
    id: stored.deviceId,
    name: stored.deviceName,
    recipient: stored.deviceRecipient,
    addedAt: stored.createdAt,
    approvals: [],
  };
  if (stored.signKey) own.signKey = stored.signKey;
  return own;
}

/**
 * Does one of these approvals verify against a key that may vouch?
 * @param {Approval[]} approvals @param {string} payload
 * @param {Map<string, string[]>} keys  Signing keys of the trusted entries, by device id.
 */
function vouched(approvals, payload, keys) {
  for (const approval of approvals) {
    for (const key of keys.get(approval?.by) ?? []) {
      if (sign.verify(approval.sig, payload, key)) return true;
    }
  }
  return false;
}

/** @type {{entries: KeyringDevice[], keys: Map<string, string[]>, trustedKeys: Set<string>}} */
const NO_TRUST = { entries: [], keys: new Map(), trustedKeys: new Set() };

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
    /** Cache of trust(), keyed by the content and the local roots. */
    this._trustKey = "";
    this._trustValue = NO_TRUST;
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
    if (JSON.stringify(content) === JSON.stringify(this.content)) return;
    this.content = content;
    this.emit("change");
  }

  /**
   * This device's entry, built from what this device stored at setup and
   * never read from the record (architecture.md §26). A row in the record
   * with this device's id is a claim like any other: the server can write
   * one, so it names no key this device believes.
   * @returns {KeyringDevice | null}
   */
  ownEntry() {
    return this.stored ? ownEntryOf(this.stored) : null;
  }

  /**
   * A record entry of another device, by its entryKey.
   * @param {string} key @returns {KeyringDevice | null}
   */
  entry(key) {
    const me = this.deviceId;
    return (this.content?.devices ?? []).find((d) => d.id !== me && entryKey(d) === key) ?? null;
  }

  /**
   * The entries this device trusts, and the signing keys that may vouch
   * for others (architecture.md §21, §26).
   *
   * Trust belongs to an entry, not to a device id. The roots are the keys
   * this device holds itself: its own (from `stored`, so no row in the
   * record can speak for it) and the pins of the devices the user confirmed
   * by hand. An entry joins when it matches a pin exactly, or when it
   * carries an approval that verifies against the signing key of an entry
   * already in, until nothing changes. An approval signs the id, the name,
   * both keys and the date, so a signed entry cannot be altered; a second
   * entry under a trusted id has no signature of its own and stays out.
   * A pure function of the record and the local roots, cached on both.
   * @returns {{entries: KeyringDevice[], keys: Map<string, string[]>, trustedKeys: Set<string>}}
   *   `trustedKeys` holds the entryKey of every trusted entry: the cache
   *   outlives the content object it was computed from, so callers compare
   *   keys, never object identity.
   */
  trust() {
    const stored = this.stored;
    if (!stored) return NO_TRUST;
    const cacheKey = JSON.stringify([
      this.content,
      stored.pins ?? null,
      stored.deviceId,
      stored.signKey ?? null,
    ]);
    if (cacheKey === this._trustKey) return this._trustValue;

    const me = stored.deviceId;
    /** @type {Map<string, string[]>} */
    const keys = new Map();
    if (stored.signKey) keys.set(me, [stored.signKey]);
    /** @type {KeyringDevice[]} */
    const entries = [];
    /** @type {Set<string>} */
    const trustedKeys = new Set();
    /** @param {KeyringDevice} device */
    const admit = (device) => {
      entries.push(device);
      trustedKeys.add(entryKey(device));
      const list = keys.get(device.id) ?? [];
      if (device.signKey && !list.includes(device.signKey)) list.push(device.signKey);
      keys.set(device.id, list);
    };

    const pins = stored.pins ?? {};
    /** @type {KeyringDevice[]} */
    let waiting = [];
    for (const device of this.content?.devices ?? []) {
      // Rows under this device's own id are skipped on purpose, whatever
      // they carry: this device is in every recipient set from `stored`.
      if (device.id === me || !device.signKey) continue;
      const pin = Object.hasOwn(pins, device.id) ? pins[device.id] : null;
      if (pin && pin.signKey === device.signKey && pin.recipient === device.recipient) {
        admit(device);
      } else {
        waiting.push(device);
      }
    }
    let grew = true;
    while (grew) {
      grew = false;
      /** @type {KeyringDevice[]} */
      const still = [];
      for (const device of waiting) {
        if (vouched(device.approvals ?? [], devicePayload(device), keys)) {
          admit(device);
          grew = true;
        } else {
          still.push(device);
        }
      }
      waiting = still;
    }

    this._trustKey = cacheKey;
    this._trustValue = { entries, keys, trustedKeys };
    return this._trustValue;
  }

  /**
   * The ids of the trusted devices, this one included. For a caller that
   * only asks "is some entry of this device trusted"; a decision about one
   * entry asks trust().
   * @returns {Set<string>}
   */
  trustedIds() {
    const me = this.deviceId;
    if (!me) return new Set();
    return new Set([me, ...this.trust().entries.map((d) => d.id)]);
  }

  /**
   * The recovery recipients this device encrypts to: its own stored list,
   * plus every one in the record with a valid approval by a trusted device.
   * @returns {string[]}
   */
  trustedRecovery() {
    const set = [...(this.stored?.recoveryRecipients ?? [])];
    const { keys } = this.trust();
    const approvals = this.content?.recoveryApprovals ?? {};
    for (const recipient of this.content?.recovery ?? []) {
      if (set.includes(recipient)) continue;
      // hasOwn: the recipient string comes from the server, and
      // "constructor" would otherwise read Object's own function.
      const list = Object.hasOwn(approvals, recipient) ? approvals[recipient] : [];
      if (vouched(list ?? [], recoveryPayload(recipient), keys)) set.push(recipient);
    }
    return set;
  }

  /**
   * What the user compares between two screens: sixteen characters over
   * both keys of an entry (architecture.md §26).
   * @param {KeyringDevice | null} [device] This device's own entry when omitted.
   */
  fingerprint(device = this.ownEntry()) {
    return device && device.signKey ? sign.fingerprint(device.signKey, device.recipient) : "";
  }

  /** The six digits shown on this device while it waits for approval. */
  get pairingCode() {
    const own = this.ownEntry();
    return own && own.signKey ? sign.pairingCode(own.signKey, own.recipient) : "";
  }

  /**
   * Entries that wait for this device's signature: not trusted here, with a
   * signing key, younger than this device, and not yet approved by this
   * device with its current key. Younger only: the device being vetted must
   * not be asked to vet its elders, those reach it the other way round,
   * through "Approved by …" (architecture.md §21). An approval by this
   * device that no longer verifies (the key changed) counts as none, so the
   * entry is offered again.
   * @returns {KeyringDevice[]}
   */
  pendingJoins() {
    const stored = this.stored;
    if (!stored) return [];
    const { trustedKeys } = this.trust();
    return (this.content?.devices ?? []).filter(
      (d) =>
        d.id !== stored.deviceId &&
        Boolean(d.signKey) &&
        !trustedKeys.has(entryKey(d)) &&
        d.addedAt > stored.createdAt &&
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
   *
   * The approval must sign this device's entry as this device stored it,
   * and it may sit on any row with this device's id: the rows come from
   * the server, the signed bytes do not (architecture.md §26).
   *
   * Never an entry of a device that already has a trusted entry. A second
   * row can copy a trusted device's signing key and put another recipient
   * beside it; the real device's approval then verifies for the copy too,
   * and the question would carry the trusted device's name. No honest
   * device produces such a row (a device that sets up again makes both keys
   * anew, is younger than this one from then on, and is approved by code),
   * so it is never asked about.
   * @returns {KeyringDevice[]}
   */
  pendingApprovers() {
    const own = this.ownEntry();
    if (!own || !this.content) return [];
    const payload = devicePayload(own);
    const trusted = new Set(this.trust().entries.map((d) => d.id));
    const mine = this.content.devices
      .filter((d) => d.id === own.id)
      .flatMap((d) => d.approvals ?? []);
    return this.content.devices.filter(
      (d) =>
        d.id !== own.id &&
        Boolean(d.signKey) &&
        !trusted.has(d.id) &&
        mine.some((a) => a.by === d.id && sign.verify(a.sig, payload, /** @type {string} */ (d.signKey)))
    );
  }

  /**
   * One row per entry in the record, for Settings (architecture.md §21),
   * with this device's own row first and from `stored`. Rows the record
   * carries under this device's id are not listed; audit() counts them.
   * "waiting" is an entry this device can approve (younger, see
   * pendingJoins); "not confirmed" is an elder that has to approve this
   * device first, after which it shows up as "approved you". `conflict`
   * marks an untrusted row under the id of a device this one already
   * trusts or confirmed: other keys under a known name (§26).
   * @returns {DeviceRow[]}
   */
  deviceRows() {
    const own = this.ownEntry();
    if (!own) return [];
    const { entries, trustedKeys } = this.trust();
    const approvers = new Set(this.pendingApprovers().map(entryKey));
    const known = new Set([
      ...entries.map((d) => d.id),
      ...Object.keys(this.stored?.pins ?? {}),
      ...(this.stored?.trusted ?? []),
    ]);
    /** @type {DeviceRow[]} */
    const rows = [
      {
        key: entryKey(own),
        id: own.id,
        name: own.name,
        fingerprint: this.fingerprint(own),
        addedAt: own.addedAt,
        state: "this device",
        conflict: false,
      },
    ];
    for (const d of this.content?.devices ?? []) {
      if (d.id === own.id) continue;
      const key = entryKey(d);
      const state = !d.signKey
        ? "needs update"
        : trustedKeys.has(key)
          ? "trusted"
          : approvers.has(key)
            ? "approved you"
            : d.addedAt <= own.addedAt
              ? "not confirmed"
              : "waiting";
      rows.push({
        key,
        id: d.id,
        name: d.name,
        fingerprint: this.fingerprint(d),
        addedAt: d.addedAt,
        state,
        conflict: state !== "trusted" && state !== "needs update" && known.has(d.id),
      });
    }
    return rows;
  }

  /**
   * Sign another device's entry, after the user typed its pairing code
   * (architecture.md §21). Returns the record content with the approval
   * added, for the caller to write; null when the code does not match, so
   * an entry the server injected under that name never gets a signature.
   * The code covers both keys of the entry (§26), so an entry with the
   * right signing key and a swapped recipient does not match either.
   * @param {string} key The entryKey of the entry. @param {string} code As typed.
   * @returns {KeyringContent | null}
   */
  approve(key, code) {
    if (!this.signing || !this.stored || !this.content) throw new Error("keyring: locked");
    const device = this.entry(key);
    if (!device || !device.signKey) throw new Error("keyring: unknown device");
    if (sign.normalizeCode(code) !== sign.pairingCode(device.signKey, device.recipient)) return null;
    const me = this.stored.deviceId;
    const next = mergeKeyringContent(null, this.content);
    const entry = next.devices.find((d) => entryKey(d) === key);
    if (!entry) throw new Error("keyring: unknown device");
    // Ed25519 is deterministic: signing the same entry twice gives the same
    // signature, and the union below keeps one.
    entry.approvals = unionApprovals(entry.approvals ?? [], [
      { by: me, sig: sign.sign(devicePayload(entry), this.signing) },
    ]);
    return next;
  }

  /**
   * The user said "yes, that is my device" to an approver: its two keys are
   * pinned on this device and it becomes a root of this device's trust
   * (architecture.md §21, §26). Only an entry whose approval of this device
   * verifies can be confirmed, which is also the only entry the dialog and
   * the Settings button ever name.
   * @param {string} key The entryKey of the approver's entry.
   * @returns {Promise<boolean>}
   */
  async confirm(key) {
    const stored = this.stored;
    if (!stored) throw new Error("keyring: not set up");
    const device = this.pendingApprovers().find((d) => entryKey(d) === key);
    if (!device || !device.signKey) return false;
    // A device confirmed again (it re-keyed) replaces its pin: one device
    // id, one pinned pair of keys.
    await this.savePins({
      ...(stored.pins ?? {}),
      [device.id]: { signKey: device.signKey, recipient: device.recipient },
    });
    return true;
  }

  /** @param {Record<string, Pin>} pins */
  async savePins(pins) {
    const stored = /** @type {StoredKeyring} */ (this.stored);
    // `trusted` keeps the ids for a page from before §26 that still runs in
    // another window; nothing here reads it back after the migration.
    const trusted = [...new Set([...(stored.trusted ?? []), ...Object.keys(pins)])];
    this.stored = { ...stored, pins, trusted };
    await putSetting(STORE_KEY, this.stored);
    post("setting", { key: STORE_KEY });
    this.emit("change");
  }

  /**
   * The pins for the devices this device confirmed before §26, when it
   * stored their ids only. Null when there is nothing to add.
   *
   * The keys come from this device's own copy of the record. That is the
   * one moment the upgrade trusts what is there, so it takes as little on
   * faith as it can: a device is pinned only when its approval of this
   * device, the very thing the user confirmed it for, verifies with the
   * signing key being pinned. The recipient beside that key has no
   * signature before §26 and is taken as found; audit() on the pinned
   * device itself is what would show a recipient changed earlier.
   * @returns {Record<string, Pin> | null}
   */
  pinsFromTrusted() {
    const stored = this.stored;
    const own = this.ownEntry();
    if (!stored || !own || !this.content) return null;
    const payload = devicePayload(own);
    const mine = this.content.devices
      .filter((d) => d.id === own.id)
      .flatMap((d) => d.approvals ?? []);
    let pins = { ...(stored.pins ?? {}) };
    let added = false;
    for (const id of stored.trusted ?? []) {
      if (Object.hasOwn(pins, id)) continue;
      const device = this.content.devices.find(
        (d) =>
          d.id === id &&
          Boolean(d.signKey) &&
          mine.some((a) => a.by === id && sign.verify(a.sig, payload, /** @type {string} */ (d.signKey)))
      );
      if (!device || !device.signKey) continue;
      // A computed key in a literal, never an assignment: an id from the
      // record must become an own property whatever its spelling.
      pins = { ...pins, [id]: { signKey: device.signKey, recipient: device.recipient } };
      added = true;
    }
    return added ? pins : null;
  }

  /** Run the §26 migration and store its result. Safe to run at every start. */
  async migratePins() {
    const pins = this.pinsFromTrusted();
    if (!pins) return false;
    await this.savePins(pins);
    return true;
  }

  /**
   * What in the record contradicts what this device knows (architecture.md
   * §26). None of it changes a recipient set, the trust computation already
   * ignores every such row; this is for telling the user.
   *
   * `own`: rows under this device's id with other keys. `conflicts`: other
   * devices that appear with more than one pair of keys. `unpinned`:
   * devices confirmed before §26 that the migration could not pin.
   * A device that set up encryption a second time leaves its old entry
   * behind, and that shows here too; the notice says so.
   * @returns {{own: number, conflicts: string[], unpinned: string[]}}
   */
  audit() {
    /** @type {{own: number, conflicts: string[], unpinned: string[]}} */
    const out = { own: 0, conflicts: [], unpinned: [] };
    const stored = this.stored;
    if (!stored || !this.content) return out;
    /** @type {Map<string, {name: string, pairs: Set<string>}>} */
    const others = new Map();
    for (const d of this.content.devices) {
      if (d.id === stored.deviceId) {
        const sameKeys =
          d.recipient === stored.deviceRecipient && (!d.signKey || d.signKey === stored.signKey);
        if (!sameKeys) out.own++;
        continue;
      }
      if (!d.signKey) continue;
      const seen = others.get(d.id) ?? { name: d.name, pairs: new Set() };
      seen.pairs.add(d.signKey + "\n" + d.recipient);
      others.set(d.id, seen);
    }
    for (const seen of others.values()) {
      if (seen.pairs.size > 1) out.conflicts.push(seen.name);
    }
    const pins = stored.pins ?? {};
    for (const id of stored.trusted ?? []) {
      if (!Object.hasOwn(pins, id)) out.unpinned.push(others.get(id)?.name ?? id.slice(0, 8));
    }
    return out;
  }

  /**
   * What this device has to add to the record about itself: its entry with
   * its signing key, and its self-approvals of the recovery keys it trusts.
   * Returns the content to write, or null when the record already says it
   * all. Runs after every unlock (architecture.md §21), which is when a
   * device from before the unit gets its signing key.
   *
   * It only ever adds (§26). A row under this device's id with other keys
   * stays where it is: removing it here would start a tug of war with every
   * device that still holds it, and the trust computation ignores it anyway.
   * @returns {KeyringContent | null}
   */
  selfUpdate() {
    if (!this.stored || !this.content || !this.stored.signKey) return null;
    const current = mergeKeyringContent(null, this.content);
    const next = mergeKeyringContent(keyringContentFor(this), this.content);
    return JSON.stringify(next) === JSON.stringify(current) ? null : next;
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
      pins: {},
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
    // This device's own recipient comes from `stored`, never from its row in
    // the record (architecture.md §26).
    const set = [this.stored.deviceRecipient];
    if (preset === "all-devices") {
      // Trusted entries only (§21, §26): an entry nobody vouched for is a
      // row in the record, not a reader, and that holds for a second row
      // under a trusted device's id too. Do not turn this back into a test
      // on the device id; that test is what let the server add a reader.
      for (const device of this.trust().entries) {
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
 * What a device says about itself in the record (architecture.md §13.3, §21):
 * its own entry, the recovery recipients it holds, and its approvals of
 * those. The content of a freshly set-up device, and the half that
 * selfUpdate() merges into a record that already exists.
 *
 * @param {KeyRing} keyring
 * @returns {KeyringContent}
 */
export function keyringContentFor(keyring) {
  const stored = keyring.stored;
  if (!stored) throw new Error("keyring: not set up");
  /** @type {Record<string, Approval[]>} */
  const recoveryApprovals = Object.create(null);
  for (const [recipient, sig] of Object.entries(stored.selfApprovals ?? {})) {
    recoveryApprovals[recipient] = [{ by: stored.deviceId, sig }];
  }
  return {
    v: 1,
    devices: [ownEntryOf(stored)],
    recovery: [...stored.recoveryRecipients],
    recoveryApprovals,
  };
}

/**
 * Union two keyring contents (architecture.md §13.3, §26). The keyring record
 * is the one record that merges instead of forking: a fork would split the
 * device list in two, and every device would then encrypt to half of the
 * devices.
 *
 * A plain set union, and nothing else. An entry is one claim, identified by
 * everything an approval signs (entryKey), and it is kept or added whole:
 * the merge never builds an entry out of fields from two copies, and it
 * never decides which of two entries under one device id is the real one.
 * That decision needs this device's pins, and it is made in trust(), on the
 * merged list. A union also cannot ping-pong: two devices that hold
 * different claims both end with both.
 *
 * The incoming (server) version leads the order, and what the local copy
 * knows on top is appended, so `merge(local, remote)` equals
 * `merge(null, remote)` exactly when the local copy had nothing to add.
 * Every entry is checked on the way in: the record is data from the server,
 * and a malformed row must drop out here, not throw somewhere later.
 *
 * @param {KeyringContent | null} local
 * @param {KeyringContent | null} remote
 * @returns {KeyringContent}
 */
export function mergeKeyringContent(local, remote) {
  /** @type {KeyringDevice[]} */
  let devices = [];
  /** @type {Map<string, KeyringDevice>} */
  const byKey = new Map();
  /** @type {string[]} */
  const recovery = [];
  // No prototype: the keys are recipient strings from the server, and
  // "__proto__" or "constructor" must be keys like any other.
  /** @type {Record<string, Approval[]>} */
  const recoveryApprovals = Object.create(null);

  for (const source of [remote, local]) {
    for (const raw of Array.isArray(source?.devices) ? source.devices : []) {
      const device = cleanDevice(raw);
      if (!device) continue;
      const key = entryKey(device);
      const known = byKey.get(key);
      if (known) {
        known.approvals = unionApprovals(known.approvals ?? [], device.approvals ?? []);
      } else {
        byKey.set(key, device);
        devices.push(device);
      }
    }
    for (const recipient of Array.isArray(source?.recovery) ? source.recovery : []) {
      if (typeof recipient === "string" && recipient && !recovery.includes(recipient)) {
        recovery.push(recipient);
      }
    }
    const approvals = source?.recoveryApprovals;
    if (approvals && typeof approvals === "object" && !Array.isArray(approvals)) {
      for (const [recipient, list] of Object.entries(approvals)) {
        recoveryApprovals[recipient] = unionApprovals(
          recoveryApprovals[recipient] ?? [],
          cleanApprovals(list)
        );
      }
    }
  }

  // A device from before §21 had no signing key in its entry and gained one
  // at its next unlock. The entry with the key is the same claim, grown;
  // the one without it can never be trusted and would only sit in Settings
  // as a second row for the device.
  const grown = new Set(
    devices.filter((d) => d.signKey).map((d) => entryKey({ ...d, signKey: undefined }))
  );
  devices = devices.filter((d) => d.signKey || !grown.has(entryKey(d)));

  return { v: 1, devices, recovery, recoveryApprovals };
}

/**
 * One entry as the record may carry it, or null for a row that is not one.
 * Fields this version does not know stay on the entry, so a newer device's
 * additions survive a round trip through this one.
 * @param {any} raw @returns {KeyringDevice | null}
 */
function cleanDevice(raw) {
  if (!raw || typeof raw !== "object") return null;
  const { id, name, recipient, addedAt, signKey } = raw;
  // "__proto__" is refused as an id: it is the one spelling that an
  // assignment somewhere would turn into a prototype instead of a key.
  if (typeof id !== "string" || !id || id === "__proto__") return null;
  if (typeof name !== "string" || typeof recipient !== "string" || !recipient) return null;
  if (typeof addedAt !== "number" || !Number.isFinite(addedAt)) return null;
  if (signKey !== undefined && (typeof signKey !== "string" || !signKey)) return null;
  return { ...raw, approvals: cleanApprovals(raw.approvals) };
}

/** @param {any} list @returns {Approval[]} The well-formed approvals, each once. */
function cleanApprovals(list) {
  /** @type {Approval[]} */
  const clean = [];
  for (const a of Array.isArray(list) ? list : []) {
    if (!a || typeof a.by !== "string" || !a.by || typeof a.sig !== "string" || !a.sig) continue;
    clean.push({ by: a.by, sig: a.sig });
  }
  return unionApprovals([], clean);
}

/**
 * Union of two approval lists: every distinct signature, once. Nothing is
 * verified here and nothing is replaced. One signer may have two approvals
 * on an entry (it re-keyed and signed again); trust() takes whichever
 * verifies against a key it trusts, and the other is inert.
 * @param {Approval[]} target @param {Approval[]} incoming
 * @returns {Approval[]}
 */
function unionApprovals(target, incoming) {
  const out = [...target];
  for (const approval of incoming) {
    if (!out.some((a) => a.by === approval.by && a.sig === approval.sig)) out.push(approval);
  }
  return out;
}

/**
 * Parse a keyring buffer record. Returns null for a missing or unreadable one,
 * because a corrupt record must degrade to "no peers", never to a broken app.
 * What comes back went through the merge alone, so it holds only well-formed
 * entries, each claim once.
 *
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
