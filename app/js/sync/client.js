// @ts-check
// The sync client (architecture.md §3, §13.6, §27).
//
// It owns the network, the schedule, the device token and the space logs.
// Every rule about records (what forks, what merges, what a tombstone does)
// lives in model/docs.js; every rule about who is a member lives in
// crypto/spaces.js. This file can be read as "pull the logs, pull the notes,
// push, then say so".
//
// Inert until a server URL and a device token exist. No login wall, no
// blocking on the network, and no request at all to any other origin before
// the user configured one: the app is fully functional with no server (§3).
//
// Order matters: logs first (a note is encrypted for members this device must
// know), then notes, then push. A push against a stale revision is the 409
// path, which costs a round trip; pulling first makes most of those
// disappear before they happen.

import { deleteSetting, getSetting, putSetting } from "../storage/idb.js";
import { on, post } from "../model/channel.js";
import { KEYRING_ID, KEYRING_SPACE, SETTINGS_ID } from "../model/docs.js";
import { isSystemRecord } from "../model/lifecycle.js";
import { hasDisk } from "../model/capabilities.js";
import { entryKey } from "../crypto/keyring.js";
import { sha256Hex } from "../crypto/sign.js";
import {
  checkIntroduction,
  formatCode,
  joinProof,
  joinReplyMac,
  joinVerifier,
  knownDevices,
  newCode,
  nextColor,
  nextEntry,
  normalizeCode,
  parseEntryKey,
  replay,
  sameHex,
  slotOf,
  vouch,
} from "../crypto/spaces.js";

const CONFIG_KEY = "sync.config";
// The device's mode per space ('tab' or 'list') and one pull cursor per
// space (§25).
const SPACES_KEY = "sync.spaces";
const CURSORS_KEY = "sync.cursors";
// "New notes" (§27): `{space: string | null}`, null is Local only. An object
// so a later field (a folder for new notes) can sit next to `space`. Only the
// user writes it; a join, an adopted space or a new space never do.
const NEW_NOTES_KEY = "sync.newNotes";
// The two settings "New notes" replaced. Read once, at the upgrade (load()).
const OLD_DEFAULT_ON_KEY = "sync.defaultOn";
const OLD_DEFAULT_SPACE_KEY = "sync.defaultSpace";
// The server URL the stored cursors were advanced against. A cursor is a
// position in one server's change log, so another server starts at 0. The
// reset waits for that server's first answer (see pullSpace), so a URL
// mistyped and put back never rewinds.
const CURSORS_URL_KEY = "sync.cursorsUrl";
// The space logs this device follows (§27): for each space, the creator it
// pinned when it made or joined the space, and the entries it pulled.
const LOGS_KEY = "sync.logs";
// Join codes this device showed and still has to answer (§27). The code is
// kept: the new device's proof and the reply's MAC both come from it.
const INVITES_KEY = "sync.invites";
// The device directory (§27): every checked introduction this device has,
// pulled or its own. Its own are written here first and sent later, so a
// device met through a join stays known while the send fails or waits.
const INTRODUCTIONS_KEY = "sync.introductions";
// The join this device made with a typed code and waits to hear back on.
const JOINING_KEY = "sync.joining";
// A change of the passphrase switch that has not ended (§27): the new keys
// and token, stored before the server registers them, and the old entry key
// that leaves the spaces at the end. The server takes one successor per
// device, so a try that stopped half way must go on with the same keys.
const SUCCESSOR_KEY = "sync.successor";

// How long an invite is kept: the code lives ten minutes on the server, but a
// used one waits for this device's next sync, which can be days on a phone.
const INVITE_KEEP = 7 * 24 * 60 * 60 * 1000;
const PAGE = 200;
// Slow poll. The responsive triggers are visibility, online, and the edit
// debounce; this only covers a window that sits open and untouched.
const POLL = 60000;
// Long enough that a sentence of typing is one revision, short enough that the
// other device sees it while the user is still looking at the screen.
const DEBOUNCE = 2000;
// What a server from before the shared settings (§29) answers to their push.
// The text is fixed in every such build (Program.cs before 2026-11-24), which
// is why it can be matched here.
const OLD_SERVER_REFUSAL = "only the keyring document lives in keyring";

/**
 * The server's rule for a space name (architecture.md §25). The client checks
 * it too, so a typo is refused at the dialog and never becomes a 400.
 * @param {unknown} name @returns {name is string}
 */
export function isValidSpace(name) {
  return typeof name === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(name);
}

/**
 * A plain map with no prototype. Space names are user text, and `constructor`
 * and `__proto__` pass the name rule: on an ordinary object the first reads
 * back as Object's own function and the second assigns the prototype instead
 * of a key. Every map keyed by a space name goes through here, including the
 * ones read back from IndexedDB, which come back as ordinary objects.
 * @template T
 * @param {Record<string, T> | undefined | null} [from]
 * @returns {Record<string, T>}
 */
function dict(from) {
  return Object.assign(Object.create(null), from ?? {});
}

/** A fresh device token: 32 random bytes as hex. The server sees only its hash. */
function newToken() {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** @typedef {import("../model/docs.js").SpaceMode} SpaceMode */
/** @typedef {'tab' | 'list'} StoredMode */
/** @typedef {import("../crypto/spaces.js").SpaceState} SpaceState */

/**
 * @typedef {Object} SyncStatus
 * @property {'off' | 'idle' | 'syncing' | 'error' | 'offline'} state
 * @property {string} [message]
 * @property {number} [lastSyncAt]
 * @property {boolean} [directoryMissing]  The server has no device directory.
 *   In the status because only the leader pulls, and every window's Settings
 *   shows the note.
 * @property {boolean} [settingsRefused]  The server is from before the shared
 *   settings (§29). In the status for the same reason.
 */

/**
 * `v: 2` marks a device token. A config without it holds the server token of
 * the time before §27; the server refuses that for data, and the device has
 * to register or join (the upgrade, §27).
 * @typedef {{url: string, token: string, v?: 2}} Config
 */

/** @typedef {{creator: string, log: string[]}} SpaceLog */
/** @typedef {{slot: string, code: string, spaces: string[], at: number}} Invite */

/** An error the user can read, with the server's status when there is one. */
class SyncError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {{store: ReturnType<import("../model/docs.js").createDocStore>,
 *          keyring: import("../crypto/keyring.js").KeyRing}} deps
 */
export function createSyncClient({ store, keyring }) {
  const events = new EventTarget();

  /** @type {Config | null} */
  let config = null;
  /** @type {Record<string, number>} */
  let cursors = dict();
  /** The URL `cursors` belong to; "" before any page ever advanced one. */
  let cursorsUrl = "";
  /** @type {Record<string, StoredMode>} */
  let modes = dict();
  /** The "New notes" space as stored; null is Local only. @type {string | null} */
  let newNotes = null;
  /** @type {Record<string, SpaceLog>} */
  let logs = dict();
  /** The replayed state of each log, rebuilt whenever `logs` changes. @type {Record<string, SpaceState>} */
  let states = dict();
  /** The last `GET /api/spaces` answer. @type {{space: string, count: number, logSeq: number}[]} */
  let serverSpaces = [];
  /** @type {Invite[]} */
  let invites = [];
  /** @type {import("../crypto/spaces.js").Introduction[]} */
  let introductions = [];
  /** "device|by" of the introductions the server has, from this run of the app. */
  const sent = new Set();
  /** The server has no /api/introductions (an older build). */
  let directoryMissing = false;
  /**
   * The server refused the shared settings record (an older build, §29).
   * Until the next start of the app the record is not pushed again: without
   * this stop every round, one a minute, would fail and the status bar would
   * read "sync failed" for a server that is merely older.
   */
  let settingsRefused = false;
  /** @type {{slot: string, code: string, modes?: Record<string, "tab" | "list">} | null} */
  let joining = null;
  /** @type {SyncStatus} */
  let status = { state: "off" };
  let lastSyncAt = /** @type {number | undefined} */ (undefined);
  let running = false;
  let queued = false;
  let started = false;
  /** @type {number | undefined} */
  let debounceTimer;
  // Records whose file could not be read for a push. Logged once each, not
  // once per round: a file that stays missing would fill the console.
  /** @type {Set<string>} */
  const unreadable = new Set();
  /** Cached deviceId -> display name; cleared whenever logs, introductions, or keyring change. @type {Map<string, string>} */
  const deviceNames = new Map();
  keyring.addEventListener("change", () => deviceNames.clear());

  function isConfigured() {
    return Boolean(config && config.v === 2 && config.url && config.token);
  }

  /** A config from before §27: a server is set, but its token only registers. */
  function needsUpgrade() {
    return Boolean(config && config.url && config.token && config.v !== 2);
  }

  /** @param {SyncStatus} next */
  function setStatus(next) {
    status = next;
    events.dispatchEvent(new CustomEvent("status", { detail: status }));
    // The leader's status is everyone's status (architecture.md §14.3).
    if (started) post("sync-status", { status });
  }

  on("sync-status", (payload) => {
    if (started) return;
    status = payload.status;
    events.dispatchEvent(new CustomEvent("status", { detail: status }));
  });

  on("sync-request", () => {
    if (started) syncNow();
  });

  /**
   * @param {string} path
   * @param {{method?: string, body?: any, headers?: Record<string, string>, url?: string, token?: string | null}} [opts]
   *   `url` and `token` for a request outside the stored config: a
   *   registration or a join, before there is a device token. `token: null`
   *   sends none.
   * @returns {Promise<Response>}
   */
  function request(path, opts = {}) {
    const url = opts.url ?? config?.url;
    if (!url) throw new Error("sync: not configured");
    const token = opts.token === undefined ? config?.token : opts.token;
    /** @type {Record<string, string>} */
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = "Bearer " + token;
    return fetch(url + path, {
      method: opts.method ?? "GET",
      headers: { ...headers, ...opts.headers },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      // The service worker ignores cross-origin requests, but an HTTP cache in
      // front of the API would be just as wrong: a cached /changes page would
      // replay the same rows for ever.
      cache: "no-store",
    });
  }

  /** @param {Response} res */
  function httpError(res) {
    return new SyncError("server error " + res.status, res.status);
  }

  // ---- Spaces (architecture.md §27) ---------------------------------------

  /** Replay every log; the store and the UI read the result. */
  function rebuild() {
    deviceNames.clear();
    const next = dict();
    for (const [space, entry] of Object.entries(logs)) {
      const state = replay(entry.log, entry.creator, space);
      if (state.error) console.log("[vrtti] space log of", space, "stops at", state.error);
      next[space] = state;
    }
    states = next;
    events.dispatchEvent(new CustomEvent("spaces"));
  }

  /** @param {string} space */
  function isMine(space) {
    const me = keyring.ownKey();
    return Boolean(me && states[space]?.members.includes(me));
  }

  /** The spaces this device is a member of, by name. @returns {string[]} */
  function mySpaces() {
    return Object.keys(states).filter(isMine).sort();
  }

  /** @param {string} space @returns {string[]} */
  function recipients(space) {
    if (!isMine(space)) return [];
    return states[space].members.map((key) => parseEntryKey(key)?.recipient ?? "").filter(Boolean);
  }

  /**
   * The age recipients of the known devices (knownSet): the readers of the
   * shared settings (§29). Those settings belong to no space, so no space
   * log can name their readers; the known devices are "all devices of the
   * user" as far as this device can tell, and they are the rows of the grid
   * in Settings > Devices.
   * @returns {string[]}
   */
  function knownRecipients() {
    return [...new Set([...knownSet()].map((key) => parseEntryKey(key)?.recipient ?? "").filter(Boolean))];
  }

  /** @param {string} space */
  function logSeq(space) {
    return states[space]?.seq ?? 0;
  }

  /** @param {string} space */
  function colorOf(space) {
    return states[space]?.color ?? "";
  }

  async function saveLogs() {
    await putSetting(LOGS_KEY, { ...logs });
    post("setting", { key: LOGS_KEY });
    rebuild();
  }

  /**
   * Pull the new entries of one log. The server sends only what is after
   * `since`; an entry whose seq does not follow is left out, and the replay
   * decides what counts.
   * @param {string} space
   * @returns {Promise<boolean>} false: the server refuses this device the space.
   */
  async function pullLog(space) {
    const entry = logs[space];
    if (!entry) return true;
    const res = await request("/api/spaces/" + encodeURIComponent(space) + "/log?since=" + entry.log.length);
    if (res.status === 403) return false;
    if (!res.ok) throw httpError(res);
    /** @type {{seq: number, entry: string}[]} */
    const rows = await res.json();
    let grew = false;
    for (const row of rows) {
      if (row.seq !== entry.log.length + 1 || typeof row.entry !== "string") break;
      entry.log.push(row.entry);
      grew = true;
    }
    if (grew) await saveLogs();
    return true;
  }

  /**
   * The logs of this device's spaces, and the loss of the ones it is not in
   * any more (§27): the server stopped listing it, refuses its log, or the
   * log itself says this device was removed.
   */
  async function pullLogs() {
    // Only the spaces known before the request are judged by its answer: a
    // space made or joined while it was out is missing from the list, and
    // must not count as lost.
    const known = Object.keys(logs);
    const res = await request("/api/spaces");
    if (!res.ok) throw httpError(res);
    serverSpaces = await res.json();
    const listed = new Map(serverSpaces.map((s) => [s.space, s.logSeq]));
    for (const space of known) {
      const seq = listed.get(space);
      if (seq === undefined || !logs[space]) continue;
      if (seq > logs[space].log.length && !(await pullLog(space))) listed.delete(space);
    }
    for (const space of known) {
      if (!logs[space]) continue;
      // A log this device wrote itself and the server lists: a member. A log
      // that ends with this device removed, or that the server no longer
      // lists: lost. A space whose replay stopped early keeps the members
      // up to there.
      if (!listed.has(space) || !isMine(space)) await lose(space);
    }
    // A space the server lists and this device has no log of: a member added
    // this device in the grid. Not while a join waits: its reply pins those.
    if (!joining) {
      let adopted = false;
      for (const { space } of serverSpaces) {
        if (!logs[space] && isValidSpace(space) && space !== KEYRING_SPACE && (await adopt(space))) adopted = true;
      }
      if (adopted) await saveLogs();
    }
    // Notes and stubs from before §27 sit in spaces with no log here: a dev
    // machine that joined only dev-work still holds its `personal` notes.
    // Those spaces are lost too. Not while a join waits for its reply, which
    // can bring them, and not while the space has no member at all: the
    // first device after the upgrade may still take it over (the question
    // at start, then one claim after the other).
    const orphans = joining ? [] : [...store.heldSpaces()].filter((s) => !logs[s] && !known.includes(s));
    if (orphans.length) {
      const unclaimed = await listUnclaimed();
      for (const space of orphans) if (!unclaimed.includes(space)) await lose(space);
    }
    events.dispatchEvent(new CustomEvent("spaces"));
  }

  /**
   * Take a space another member added this device to (§27). The device has
   * no pinned creator for it, and the server's word is not enough: a server
   * could make up a log with its own key as a member. So the add of this
   * device must carry the signature of a known device (knownSet()). That
   * signature covers the hash of the entry before it, so it fixes the whole
   * chain back to the creator, and the creator in the first entry is safe
   * to pin.
   * The caller saves the logs.
   * @param {string} space @returns {Promise<boolean>} true: taken.
   */
  async function adopt(space) {
    const me = keyring.ownKey();
    if (!me) return false;
    const res = await request("/api/spaces/" + encodeURIComponent(space) + "/log?since=0");
    if (!res.ok) return false;
    /** @type {{seq: number, entry: string}[]} */
    const rows = await res.json();
    /** @type {string[]} */
    const log = [];
    for (const row of rows) {
      if (row.seq !== log.length + 1 || typeof row.entry !== "string") break;
      log.push(row.entry);
    }
    let creator;
    try {
      creator = JSON.parse(log[0]).by;
    } catch {
      return false;
    }
    if (typeof creator !== "string") return false;
    const state = replay(log, creator, space);
    if (!state.members.includes(me)) return false;
    const trusted = knownSet();
    // Only the replayed part: there each signature is checked.
    const vouched = log.slice(0, state.seq).some((text) => {
      const e = JSON.parse(text);
      return e.op === "add" && e.device === me && trusted.has(e.by);
    });
    if (!vouched) {
      console.log("[vrtti] the space", space, "was refused: no device this one knows added it");
      return false;
    }
    logs[space] = { creator, log };
    cursors[space] = 0;
    // Titles only, as an invite does: a new space must not open every
    // note as a tab at its first pull.
    if (!Object.hasOwn(modes, space)) modes[space] = "list";
    await putSetting(CURSORS_KEY, { ...cursors });
    await putSetting(SPACES_KEY, { ...modes });
    post("setting", { key: SPACES_KEY });
    console.log("[vrtti] this device was added to the space", space);
    return true;
  }

  /**
   * This device is out of a space: its notes go to the local trash, and the
   * device forgets the log, the cursor and the mode (§27).
   * @param {string} space
   */
  async function lose(space) {
    console.log("[vrtti] this device left the space", space);
    // New notes stay local from here, also when the device comes back to
    // the space later: only the user points "New notes" at a space.
    if (newNotes === space) await setNewNotes(null);
    await store.loseSpace(space);
    delete logs[space];
    delete cursors[space];
    delete modes[space];
    await putSetting(CURSORS_KEY, { ...cursors });
    await putSetting(SPACES_KEY, { ...modes });
    await saveLogs();
  }

  /**
   * Append one entry to a log, signed by this device. A 409 means another
   * member wrote first: pull the log and sign the next position again.
   * @param {string} space @param {{op: "add" | "remove" | "color", device: string, color?: string}} what
   */
  async function append(space, what) {
    const entry = logs[space];
    if (!entry || !isMine(space)) throw new SyncError("this device is not a member of " + space);
    if (!keyring.signer) throw new SyncError("unlock this device first");
    for (let attempt = 0; attempt < 3; attempt++) {
      const text = await nextEntry(entry.log, { ...what, space }, keyring.ownKey(), keyring.signer);
      // Checked here first, so a refused change says why before the server.
      const after = replay([...entry.log, text], entry.creator, space);
      if (after.error) throw new SyncError(after.error.replace(/^entry \d+: /, ""));
      const res = await request("/api/spaces/" + encodeURIComponent(space) + "/log", {
        method: "POST",
        body: { entry: text },
      });
      if (res.status === 409) {
        const body = await res.json().catch(() => ({}));
        if (/last member/.test(body.error ?? "")) throw new SyncError("the last member cannot remove itself", 409);
        await pullLog(space);
        continue;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new SyncError(body.error ?? "server error " + res.status, res.status);
      }
      entry.log.push(text);
      await saveLogs();
      return;
    }
    throw new SyncError("the space changed during the write, try again");
  }

  /**
   * A new space, with this device as its first member (§27). `claim` takes
   * over a space from before the upgrade: its old notes come down whole.
   * @param {string} name @param {{claim?: boolean}} [opts]
   */
  async function createSpace(name, opts = {}) {
    if (!isValidSpace(name) || name === KEYRING_SPACE) throw new SyncError("letters, digits, - and _ only, up to 32");
    if (logs[name]) throw new SyncError("this device has a space " + name);
    if (!keyring.signer) throw new SyncError("unlock this device first");
    const me = keyring.ownKey();
    const color = nextColor(Object.values(states).map((s) => s.color));
    const text = await nextEntry([], { op: "create", space: name, device: me, color }, me, keyring.signer);
    const res = await request(
      "/api/spaces/" + encodeURIComponent(name) + (opts.claim ? "/claim" : "/log"),
      { method: "POST", body: { entry: text } }
    );
    if (res.status === 409) throw new SyncError("the name " + name + " is taken", 409);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new SyncError(body.error ?? "server error " + res.status, res.status);
    }
    logs[name] = { creator: me, log: [text] };
    if (opts.claim) {
      cursors[name] = 0;
      await putSetting(CURSORS_KEY, { ...cursors });
    }
    // "New notes" stays as it is: a new space never takes the new notes.
    await saveLogs();
    void syncNow();
  }

  /** The spaces from before the upgrade that nobody claimed yet. @returns {Promise<string[]>} */
  async function listUnclaimed() {
    const res = await request("/api/spaces/unclaimed");
    if (res.status === 403) return [];
    if (!res.ok) throw httpError(res);
    return res.json();
  }

  /** @param {string} space @param {string} deviceKey */
  async function addDevice(space, deviceKey) {
    await append(space, { op: "add", device: deviceKey });
    void syncNow();
  }

  /** @param {string} space @param {string} deviceKey */
  async function removeDevice(space, deviceKey) {
    await append(space, { op: "remove", device: deviceKey });
    // A device that removed itself lost the space; the next pull says so.
    void syncNow();
  }

  /** @param {string} space @param {string} color */
  async function setColor(space, color) {
    await append(space, { op: "color", device: keyring.ownKey(), color });
  }

  /**
   * The grid of Settings › Devices: this device's spaces as columns, the
   * known devices as rows (knownSet(): a removed one can be added back).
   */
  function grid() {
    const spaces = mySpaces();
    const me = keyring.ownKey();
    /** @param {string} key */
    const inMine = (key) => spaces.some((s) => states[s].members.includes(key));
    const replaced = replacedKeys(spaces);
    // A key a `replaces` introduction names as `by` signed that itself, so a
    // key can only hide itself. Phone sees a switch on dev-work this way
    // with no space in common.
    for (const e of introductions) if (e.replaces) replaced.add(e.by);
    /** @type {{key: string, id: string, name: string, me: boolean}[]} */
    const rows = [];
    for (const key of knownSet()) {
      const parsed = parseEntryKey(key);
      if (!parsed) continue;
      // The guard: never hide this device, and never a member of one of its
      // spaces. A taken-over device could sign `replaces` for a dummy key,
      // leave the grid, and still read the space; the user could then not
      // untick it.
      if (replaced.has(key) && key !== me && !inMine(key)) continue;
      rows.push({ key, id: parsed.id, name: parsed.name, me: key === me });
    }
    rows.sort((a, b) => Number(b.me) - Number(a.me) || a.name.localeCompare(b.name));
    return {
      spaces: spaces.map((name) => ({ name, color: colorOf(name), creator: states[name].creator })),
      devices: rows,
      /** @param {string} space @param {string} key */
      isMember: (space, key) => Boolean(states[space]?.members.includes(key)),
    };
  }

  /**
   * Entry keys a change of the passphrase switch replaced (§27). The change
   * leaves one shape in a log: the old key adds the new one, and the new
   * one later removes the old key. Read from the replayed part of the logs
   * only, so each entry of the shape is signed. The `replaces` introduction
   * says the same for a device with no space in common; this stays for the
   * switches made before the device directory, which have no such entry.
   * @param {string[]} spaces @returns {Set<string>}
   */
  function replacedKeys(spaces) {
    const replaced = new Set();
    for (const space of spaces) {
      /** @type {Set<string>} "by|device" of each add */
      const adds = new Set();
      for (const text of logs[space].log.slice(0, states[space].seq)) {
        let entry;
        try {
          entry = JSON.parse(text);
        } catch {
          continue;
        }
        if (entry.op === "add") adds.add(entry.by + "|" + entry.device);
        if (entry.op === "remove" && adds.has(entry.device + "|" + entry.by)) replaced.add(entry.device);
      }
    }
    return replaced;
  }

  /**
   * The device name for a device id: from the known devices, which are
   * signed, else from the keyring record (names only, §27). @param {string} id
   */
  function deviceName(id) {
    const cached = deviceNames.get(id);
    if (cached !== undefined) return cached;
    let resolved = "";
    for (const key of knownSet()) {
      const parsed = parseEntryKey(key);
      if (parsed?.id === id) {
        resolved = parsed.name;
        break;
      }
    }
    if (!resolved) {
      resolved = keyring.content?.devices.find((d) => d.id === id)?.name ?? "";
    }
    deviceNames.set(id, resolved);
    return resolved;
  }

  // ---- The device directory (architecture.md §27) -------------------------

  /** @param {{device: string, by: string}} e */
  const pairOf = (e) => e.device + "|" + e.by;

  /**
   * The known devices: this device, every device its space logs name, and
   * the devices that introductions from known devices name, until nothing
   * changes. The start is signed (the logs) or this device itself; the
   * device that answered a join comes in through this device's own
   * introduction of it.
   */
  function knownSet() {
    const me = keyring.ownKey();
    const start = me ? [me] : [];
    for (const state of Object.values(states)) start.push(...state.known);
    return knownDevices(start, introductions);
  }

  /** @param {import("../crypto/spaces.js").Introduction[]} entries New ones only; the caller checked them. */
  async function remember(entries) {
    if (!entries.length) return;
    deviceNames.clear();
    introductions = [...introductions, ...entries];
    await putSetting(INTRODUCTIONS_KEY, introductions);
    post("setting", { key: INTRODUCTIONS_KEY });
    // Settings › Devices redraws its grid on this event.
    events.dispatchEvent(new CustomEvent("spaces"));
  }

  /**
   * This device vouches for each of `devices` it has not vouched for yet.
   * Stored now, sent by sendIntroductions(). A locked keyring writes nothing:
   * the caller runs again once it is unlocked.
   * @param {string[]} devices
   */
  async function introduce(devices) {
    const me = keyring.ownKey();
    const signer = keyring.signer;
    if (!me || !signer) return;
    const have = new Set(introductions.map(pairOf));
    /** @type {import("../crypto/spaces.js").Introduction[]} */
    const fresh = [];
    for (const device of devices) {
      if (device === me || have.has(device + "|" + me) || !parseEntryKey(device)) continue;
      have.add(device + "|" + me);
      fresh.push(await vouch(device, me, signer));
    }
    await remember(fresh);
  }

  /**
   * The introductions on the server. Each is checked here: the server does
   * not check signatures, so an entry it made up or changed is dropped.
   */
  async function pullIntroductions() {
    const res = await request("/api/introductions");
    // An older server. The app works as before, with no directory, and
    // Settings › Devices asks for an update of the server.
    if (res.status === 404) {
      directoryMissing = true;
      return;
    }
    if (!res.ok) throw httpError(res);
    directoryMissing = false;
    const rows = await res.json();
    const have = new Map(introductions.map((e) => [pairOf(e), e.sig]));
    /** @type {import("../crypto/spaces.js").Introduction[]} */
    const fresh = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      // Before pairOf(): one bad row from the server must not stop the round.
      if (!row || typeof row !== "object" || typeof row.device !== "string" || typeof row.by !== "string") continue;
      const pair = pairOf(row);
      // Checked once, when it arrived; the same signature again needs no check.
      if (have.has(pair)) {
        if (have.get(pair) === row.sig) sent.add(pair);
        continue;
      }
      const entry = { device: row.device, by: row.by, replaces: row.replaces === true, sig: row.sig };
      if (!checkIntroduction(entry)) continue;
      have.set(pair, entry.sig);
      sent.add(pair);
      fresh.push(entry);
    }
    await remember(fresh);
  }

  /** Send this device's introductions the server does not have yet. */
  async function sendIntroductions() {
    if (directoryMissing) return;
    const me = keyring.ownKey();
    for (const e of introductions) {
      const pair = pairOf(e);
      // The server takes an entry from its author only. The `replaces` entry
      // of a passphrase switch has the old key as author, so the switch sends
      // it itself, while it still has the old token.
      if (e.by !== me || sent.has(pair)) continue;
      const res = await request("/api/introductions", { method: "POST", body: e });
      if (res.status === 404) {
        directoryMissing = true;
        return;
      }
      if (res.status >= 500) throw httpError(res);
      // A 4xx says the same on each try: one log line, and the next start of
      // the app tries again.
      if (!res.ok) console.log("[vrtti] the server refused an introduction:", res.status);
      sent.add(pair);
    }
  }

  // ---- Joins (architecture.md §27) ----------------------------------------

  /**
   * "Add a device": a code for the ticked spaces, valid ten minutes, once.
   * No space is fine: the device joins the server, and the grid adds it later.
   * @param {string[]} spaces @returns {Promise<string>} The code, formatted.
   */
  async function invite(spaces) {
    for (const space of spaces) if (!isMine(space)) throw new SyncError("not a member of " + space);
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newCode();
      const slot = slotOf(code);
      if (invites.some((i) => i.slot === slot)) continue;
      const res = await request("/api/joins", {
        method: "POST",
        body: { slot, verifier: await joinVerifier(code), spaces },
      });
      // The slot serves another join: draw another code.
      if (res.status === 409) continue;
      if (!res.ok) throw httpError(res);
      invites = [...invites.filter((i) => Date.now() - i.at < INVITE_KEEP), { slot, code, spaces, at: Date.now() }];
      await putSetting(INVITES_KEY, invites);
      // The leader answers the join, and it may be another window: it has to
      // re-read the invites, or it never knows this code.
      post("setting", { key: INVITES_KEY });
      return formatCode(code);
    }
    throw new SyncError("no free code, try again");
  }

  /**
   * Whether a code from invite() still waits for its device. Read from the
   * stored setting, not from memory: the leader that answers the join can be
   * another window.
   * @param {string} formatted The code as invite() returned it.
   */
  async function inviteOpen(formatted) {
    const slot = slotOf(normalizeCode(formatted));
    /** @type {{slot: string}[]} */
    const stored = (await getSetting(INVITES_KEY)) ?? [];
    return stored.some((i) => i.slot === slot);
  }

  /**
   * The member's half of a join: a device used one of this device's codes.
   * Check its proof, add it to the spaces, and send the reply (§27).
   */
  async function completeJoins() {
    if (!invites.length || !keyring.signer) return;
    const res = await request("/api/joins");
    if (!res.ok) throw httpError(res);
    /** @type {{slot: string, spaces: string[], deviceId: string, entry: string, proof: string}[]} */
    const pending = await res.json();
    for (const join of pending) {
      const invite = invites.find((i) => i.slot === join.slot);
      if (!invite) continue;
      const parsed = parseEntryKey(join.entry);
      // The proof binds the device entry to the code: without it the server
      // could swap the new device's keys for its own.
      if (!parsed || parsed.id !== join.deviceId || !sameHex(join.proof, await joinProof(invite.code, join.entry))) {
        console.log("[vrtti] a join with a wrong proof was refused", join.slot);
        invites = invites.filter((i) => i !== invite);
        await putSetting(INVITES_KEY, invites);
        continue;
      }
      // Before the adds: the new device stays known also when the invite
      // gives no space, and the next sync sends the introduction.
      await introduce([join.entry]);
      /** @type {Record<string, string>} */
      const creators = {};
      for (const space of invite.spaces) {
        if (!isMine(space)) continue;
        if (!states[space].members.includes(join.entry)) await append(space, { op: "add", device: join.entry });
        creators[space] = logs[space].creator;
      }
      const reply = JSON.stringify({ member: keyring.ownKey(), creators, recovery: keyring.recoveryRecipients });
      const answered = await request("/api/joins/" + encodeURIComponent(join.slot) + "/reply", {
        method: "POST",
        body: { reply, mac: await joinReplyMac(invite.code, reply) },
      });
      if (!answered.ok && answered.status !== 404) throw httpError(answered);
      invites = invites.filter((i) => i !== invite);
      await putSetting(INVITES_KEY, invites);
      console.log("[vrtti] added", parsed.name, "to", Object.keys(creators).join(", ") || "no space");
    }
  }

  /**
   * The new device's half: type the server URL and the code. The device
   * registers with its own token; its memberships arrive with the reply.
   * `spaceModes` comes from an invite: the mode each space opens in here. It
   * waits in the joining record, because a mode needs the membership first.
   * @param {string} url @param {string} typed
   * @param {Record<string, "tab" | "list">} [spaceModes]
   */
  async function redeem(url, typed, spaceModes = {}) {
    const code = normalizeCode(typed);
    if (!code) throw new SyncError("that is not a code: ten letters and digits");
    const entry = keyring.ownKey();
    if (!entry) throw new SyncError("set up this device first");
    const base = url.trim().replace(/\/+$/, "");
    const token = newToken();
    let res;
    try {
      res = await request("/api/joins/redeem", {
        url: base,
        token: null,
        method: "POST",
        body: {
          slot: slotOf(code),
          verifier: await joinVerifier(code),
          deviceId: keyring.deviceId,
          tokenHash: sha256Hex(token),
          entry,
          proof: await joinProof(code, entry),
        },
      });
    } catch {
      throw new SyncError("no answer from the server");
    }
    if (res.status === 403) throw new SyncError("wrong code", 403);
    if (res.status === 404) throw new SyncError("the code is unknown or expired", 404);
    if (res.status === 409) throw new SyncError("this device is registered already", 409);
    if (!res.ok) throw httpError(res);
    joining = { slot: slotOf(code), code, modes: spaceModes };
    await putSetting(JOINING_KEY, joining);
    await saveConfig({ url: base, token, v: 2 });
    void syncNow();
  }

  /** The new device waits for its member's reply; true once it arrived. */
  async function checkJoinReply() {
    if (!joining) return true;
    // Locked: no signature for the member's introduction yet. The reply
    // waits on the server and the join in sync.joining, so the member is
    // not lost; the first round after the unlock ends the join.
    if (!keyring.signer) return false;
    const res = await request("/api/joins/" + encodeURIComponent(joining.slot) + "/reply");
    if (res.status === 404) return false;
    if (!res.ok) throw httpError(res);
    const { reply, mac } = await res.json();
    if (!reply) return false;
    if (!sameHex(mac, await joinReplyMac(joining.code, reply))) {
      // A reply that is not from the member: the server made it up. The
      // device waits on; only the real reply pins anything.
      console.log("[vrtti] a join reply with a wrong MAC was ignored");
      return false;
    }
    const parsed = JSON.parse(reply);
    for (const [space, creator] of Object.entries(parsed.creators ?? {})) {
      if (isValidSpace(space) && typeof creator === "string" && !logs[space]) {
        logs[space] = { creator, log: [] };
        cursors[space] = 0;
      }
    }
    await putSetting(CURSORS_KEY, { ...cursors });
    // The invite's modes, before the first pull of these spaces: a space set
    // to Titles only must never open its notes as tabs first.
    const suggested = joining.modes ?? {};
    const given = Object.keys(parsed.creators ?? {}).filter((space) => isValidSpace(space) && Object.hasOwn(suggested, space));
    if (given.length) {
      for (const space of given) modes[space] = suggested[space];
      await putSetting(SPACES_KEY, { ...modes });
      post("setting", { key: SPACES_KEY });
    }
    // The member that answered: a known device from now on, also when the
    // join gave no space (adopt(), grid()). The MAC above checked it.
    if (typeof parsed.member === "string") await introduce([parsed.member]);
    await keyring.addRecovery(Array.isArray(parsed.recovery) ? parsed.recovery : []);
    joining = null;
    await deleteSetting(JOINING_KEY);
    await saveLogs();
    return true;
  }

  /**
   * The first device: the server token registers it (§27). Nothing else uses
   * that token, and it is not stored.
   * @param {string} url @param {string} serverToken
   */
  async function registerFirst(url, serverToken) {
    if (!keyring.deviceId) throw new SyncError("set up this device first");
    const base = url.trim().replace(/\/+$/, "");
    const token = newToken();
    let res;
    try {
      res = await request("/api/devices", {
        url: base,
        token: serverToken.trim(),
        method: "POST",
        body: { id: keyring.deviceId, tokenHash: sha256Hex(token) },
      });
    } catch {
      throw new SyncError("no answer from the server");
    }
    if (res.status === 401) throw new SyncError("wrong server token", 401);
    if (res.status === 409) throw new SyncError("this device is registered already", 409);
    if (!res.ok) throw httpError(res);
    await saveConfig({ url: base, token, v: 2 });
    // Mirror disconnect() so statusbar and Settings see sync become active
    // immediately, even before the first sync round runs.
    setStatus({ state: "idle", lastSyncAt });
  }

  /**
   * @typedef {Object} Successor  A change of the switch that has not ended.
   * @property {string} from  The device id before the change.
   * @property {string} oldKey  Its entry key, removed from the spaces at the end.
   * @property {import("../crypto/keyring.js").StoredKeyring} stored  The new keys.
   * @property {string} token  The new device token.
   */

  /**
   * A change of the passphrase switch (§27): new keys under a new device id.
   * While this device holds both, it adds the new device to each of its
   * spaces, takes the new keys, encrypts its notes again (keyring.rekeyIds),
   * and then removes the old device.
   *
   * Any step can stop: no network, a closed app. So the new keys and token
   * are stored before the server hears of them (SUCCESSOR_KEY), and every
   * step is safe to run twice. Before the new keys take over, the next try
   * of the switch goes on with them; after, each sync round does
   * (finishSuccessor).
   * @param {{askPassphrase: boolean, passphrase?: string}} opts
   */
  async function changePassphraseSwitch(opts) {
    /** @type {Successor | null} */
    let pending = (await getSetting(SUCCESSOR_KEY)) ?? null;
    if (pending && pending.stored.deviceId === keyring.deviceId) {
      // The change before this one did not end; it ends first.
      await finishSuccessor();
      pending = null;
    }
    if (pending && pending.from !== keyring.deviceId) pending = null;
    const resumed = pending !== null;
    let next;
    if (pending) {
      try {
        next = await keyring.restoreSuccessor(pending.stored, opts.passphrase);
      } catch {
        throw new SyncError("a try before this one stopped half way: type the passphrase you chose then");
      }
    } else {
      next = await keyring.makeSuccessor(opts);
      pending = { from: /** @type {string} */ (keyring.deviceId), oldKey: keyring.ownKey(), stored: next.stored, token: newToken() };
      await putSetting(SUCCESSOR_KEY, pending);
    }
    if (isConfigured()) {
      const res = await request("/api/devices/successor", {
        method: "POST",
        body: { id: next.stored.deviceId, tokenHash: sha256Hex(pending.token) },
      });
      // 409: the server has a successor of this device. After a try that
      // stopped, it is this one: the keys were stored before the request.
      if (!res.ok && !(res.status === 409 && resumed)) throw httpError(res);
      const own = next.stored;
      const newKey = entryKey({ id: own.deviceId, name: own.deviceName, recipient: own.deviceRecipient, signKey: own.signKey, addedAt: own.createdAt });
      await introduceSuccessor(pending.oldKey, newKey);
      for (const space of mySpaces()) {
        if (!states[space].members.includes(newKey)) await append(space, { op: "add", device: newKey });
      }
    }
    // A revision of the shared settings that came while the device was
    // locked is encrypted for the old key. This opens it while that key is
    // still here: the old keys go as soon as the last note is encrypted
    // again (reencryptStale below), and the round that would open the
    // revision comes after that.
    await store.refreshSharedSettings();
    // Every note encrypted now is encrypted for the old keys.
    await keyring.adopt(next, [...store.encryptedIds()]);
    rebuild();
    if (!isConfigured()) {
      await deleteSetting(SUCCESSOR_KEY);
      await store.reencryptStale();
      return;
    }
    await saveConfig({ ...(/** @type {Config} */ (config)), token: pending.token });
    await store.reencryptStale();
    // Awaited, so the caller's busy dialog stays until the notes are pushed.
    // Nothing is lost if the app closes earlier: the next round goes on.
    await syncNow();
  }

  /**
   * The old key vouches for the new one with `replaces` (§27): every device
   * then shows one row for this device, also one with no space in common.
   * Sent here and not by sendIntroductions(): the server takes the entry
   * from its author only, and only now does this device hold the old token.
   * Before the adds of the new key, so the old key never vouches for it as
   * a plain member first. The keyring still holds the old keys here.
   * @param {string} oldKey @param {string} newKey
   */
  async function introduceSuccessor(oldKey, newKey) {
    if (!keyring.signer || keyring.ownKey() !== oldKey) return;
    let entry = introductions.find((e) => e.device === newKey && e.by === oldKey);
    if (!entry) {
      entry = await vouch(newKey, oldKey, keyring.signer, true);
      await remember([entry]);
    }
    const res = await request("/api/introductions", { method: "POST", body: entry });
    // 404: an older server, with no directory. The switch goes on.
    if (!res.ok && res.status !== 404) throw httpError(res);
  }

  /**
   * The end of a change of the switch, once the new keys took over: the new
   * token, then the old device leaves each space. Runs in each sync round
   * until it is done. A change that stopped before the new keys took over
   * waits for the next try of the switch, which has the passphrase.
   */
  async function finishSuccessor() {
    /** @type {Successor | undefined} */
    const pending = await getSetting(SUCCESSOR_KEY);
    if (!pending || pending.stored.deviceId !== keyring.deviceId) return;
    // The app can close between the new keys and the new token.
    if (config && config.token !== pending.token) await saveConfig({ ...config, token: pending.token });
    // Locked: the steps below need the new signer. The next round goes on.
    if (!keyring.signer) return;
    if (isConfigured()) {
      // The new key vouches for the old one, so the old key stays known, and
      // with it every device the old key vouched for. A device in no space
      // would otherwise know only itself after the switch, and refuse a
      // space from a device it knew before. The grid still hides the old key
      // (its `replaces` introduction).
      await introduce([pending.oldKey]);
      for (const space of mySpaces()) {
        if (states[space].members.includes(pending.oldKey)) await append(space, { op: "remove", device: pending.oldKey });
      }
    }
    await deleteSetting(SUCCESSOR_KEY);
  }

  // ---- Pull and push --------------------------------------------------------

  /** The spaces this device pulls notes of: the keyring, then its own. */
  function receivedSpaces() {
    return [KEYRING_SPACE, ...mySpaces()];
  }

  /**
   * Pull every change of one space since its cursor and apply it in order.
   *
   * One request per space, never `spaces=a,b`: each space keeps its own
   * cursor, so a space the device starts to receive can start at 0 and
   * arrive whole while the others go on from where they were.
   *
   * The cursor moves after each applied page, never before: a failure in the
   * middle of a page re-delivers it, and applyRemote is idempotent (a change
   * whose rev the record already agreed with is skipped).
   * @param {string} space
   */
  async function pullSpace(space) {
    while (true) {
      if (space !== KEYRING_SPACE && !isMine(space)) return;
      // Another server than the cursors know: start at 0, and forget the old
      // positions only once this server has answered. A typo in the URL and
      // the way back to the real server then cost nothing.
      const url = config?.url ?? "";
      const stale = cursorsUrl !== url;
      const since = stale ? 0 : cursors[space] ?? 0;
      // Titles-only spaces without an open Space Window ask for `?content=0`
      // so the server omits encrypted bodies; `applyRemoteBatch` fetches full
      // docs individually for any stub the user previously opened as a tab (S3).
      const omitBody =
        space !== KEYRING_SPACE &&
        modeOf(space) === "list" &&
        !(await store.hasLiveSpaceWindow(space));
      const res = await request(
        "/api/changes?since=" +
          since +
          "&limit=" +
          PAGE +
          "&spaces=" +
          encodeURIComponent(space) +
          (omitBody ? "&content=0" : "")
      );
      // The server refuses the space: this device is out of it.
      if (res.status === 403) return lose(space);
      if (!res.ok) throw httpError(res);
      if (stale) {
        cursors = dict();
        // Cursors first, URL second: a crash between the two leaves the old
        // positions under the old URL, and the next run finds them stale again.
        await putSetting(CURSORS_KEY, {});
        cursorsUrl = url;
        await putSetting(CURSORS_URL_KEY, url);
      }
      const body = await res.json();
      await store.applyRemoteBatch(body.changes ?? [], { fetchDoc });
      // Compare and set: a reset to 0 while this page was in flight (a space
      // turned from Titles only to Open as tabs) must win over this page's
      // `next`, or the listed notes would never arrive as tabs.
      if ((cursors[space] ?? 0) !== since) return;
      if (typeof body.next === "number" && body.next > since) {
        cursors[space] = body.next;
        await putSetting(CURSORS_KEY, { ...cursors });
      } else if (body.more) {
        // Guard against a broken server returning `more: true` without
        // advancing `next`, without capping large vaults at 100 pages (H4).
        throw new SyncError("sync cursor did not advance");
      }
      if (!body.more) return;
    }
  }

  /**
   * Notes this device holds as a title only, encrypted for older members:
   * fetch, encrypt again, push (§27). A "Titles only" note has no record
   * here, so the record pass of the store cannot reach it.
   */
  async function rewrapStubs() {
    // Stubs of keyring.rekeyIds that need the old keys no more.
    /** @type {string[]} */
    const rekeyed = [];
    for (const stub of store.remotes()) {
      if (!stub.enc || !isMine(stub.space)) continue;
      // After a change of the switch, every stub: in a space with no other
      // member, nobody else encrypts it for the new keys.
      const rekey = keyring.needsRekey(stub.id);
      if (!rekey && (stub.spaceSeq ?? 0) >= logSeq(stub.space)) continue;
      const res = await request("/api/docs/" + encodeURIComponent(stub.id));
      if (!res.ok) continue;
      const change = await res.json();
      if (change.kind !== "text" || change.space !== stub.space) continue;
      const body = await store.rewrapChange(change);
      if (!body) continue;
      const pushed = await request("/api/docs/" + encodeURIComponent(stub.id) + "/revisions", {
        method: "POST",
        body: { baseRev: change.rev, kind: "text", content: body.content, meta: body.meta, clientTime: change.clientTime, space: stub.space },
      });
      // 409: another member was faster, and its row arrives with the pull.
      if (!pushed.ok && pushed.status !== 409) throw httpError(pushed);
      // Not after a 409: that row may be from before the new device was a
      // member, and the next round tries again with the old keys still here.
      if (rekey && pushed.ok) rekeyed.push(stub.id);
    }
    await keyring.rekeyDone(rekeyed, store.encryptedIds());
  }

  /**
   * Push one record.
   *
   * age wraps a fresh file key on every save, so the ciphertext of unchanged
   * text differs on every push. Never add a "skip if the bytes are the same"
   * shortcut here (architecture.md §13.6).
   * @param {import("../storage/idb.js").BufferRecord} record
   * @param {boolean} [attach] Retry with baseRev null, after a 409 that came
   *   back with no current revision (the document has no rows at all).
   */
  async function pushOne(record, attach = false) {
    let prepared;
    try {
      prepared = await store.pushPayload(record);
    } catch (err) {
      // A file-backed body that cannot be read this round (§23): skip it.
      // The record stays dirty, and the next round tries again.
      if (!err || /** @type {any} */ (err).name !== "UnavailableError") throw err;
      if (!unreadable.has(record.id)) {
        unreadable.add(record.id);
        console.log("[vrtti] push skipped, file not readable:", record.id, err);
      }
      return;
    }
    unreadable.delete(record.id);
    const { payload, sentMtime, readers } = prepared;
    if (attach) payload.baseRev = null;
    // Read before the request: the push clears `purge`, and the user can type
    // while it is in flight, which is what afterPush compares against.
    const purge = Boolean(record.sync && record.sync.purge);
    const sentUpdatedAt = record.updatedAt;

    const res = await request("/api/docs/" + encodeURIComponent(record.id) + "/revisions", {
      method: "POST",
      body: payload,
    });

    if (res.status === 409) {
      const body = await res.json().catch(() => ({}));
      // The server's current version goes through the same door as a pulled
      // one, so the conflict rule stays in one place (model/docs.js).
      if (body && body.current) return store.applyRemote(body.current);
      if (!attach) return pushOne(record, true);
      return;
    }
    // 404: the note sits in a space this device is not a member of any more
    // (a move by another member, §27). The copy here goes to the trash.
    if (res.status === 404 && !isSystemRecord(record)) return store.trash(record.id);
    // A server from before §29 lets only the keyring record into the keyring
    // space, and answers 400 with this sentence. Not an error of this device:
    // the settings stay local, and the Spellcheck page says why. The sentence
    // is tested, not the status alone: the current server answers 400 too,
    // for a push that is wrong (plain text), and that must show as an error.
    if (res.status === 400 && record.id === SETTINGS_ID) {
      const body = await res.clone().json().catch(() => ({}));
      if (String(body?.error ?? "").includes(OLD_SERVER_REFUSAL)) {
        settingsRefused = true;
        console.log("[vrtti] the sync server is older than the shared settings; they stay on this device");
        return;
      }
    }
    if (!res.ok) throw httpError(res);

    const body = await res.json();
    await store.afterPush(record.id, body.rev, sentUpdatedAt, sentMtime, payload.kind);
    if (readers !== undefined) await store.sharedSettingsPushed(readers);

    if (purge) {
      // The doc just turned encrypted, and the older revisions still hold its
      // readable text (architecture.md §5). Purging is the whole point of the
      // conversion, so it runs right behind the push that replaced them.
      const purged = await request(
        "/api/docs/" + encodeURIComponent(record.id) + "/revisions?below=" + body.rev,
        { method: "DELETE" }
      );
      if (!purged.ok) throw httpError(purged);
      await store.clearPurge(record.id);
    }
  }

  /**
   * The records a round can push. The shared settings are left out in two
   * cases, and stay dirty for later:
   * - An older server refused them. They wait for the next start of the app.
   * - This device holds a revision it cannot read yet (`unread`), and that
   *   can still change: the device is locked, or its join is not done, so
   *   the sender did not know it. A push now would go on top of that
   *   revision without its entries, and the other devices would have to
   *   notice and push them again. The merge after the unlock sends one
   *   revision with everything (model/docs.js, refreshSharedSettings).
   *
   * An unlocked device after its join does push on top of a revision that it
   * cannot read: no key of this device opens that revision, and no wait
   * changes it. Its sender can be a lost device, or a removed device that
   * encrypted for itself alone. Held back, the settings of this device, and
   * of each device that joins through it, would never sync again. A sender
   * that is alive has the entries of its revision, and merges them into the
   * next one.
   *
   * A record that is left out must not count as work either, or each edit
   * of any note would start a round that has nothing to send.
   */
  function pushable() {
    const mayOpenLater = !keyring.isUnlocked || joining !== null;
    return store
      .dirtyRecords()
      .filter((record) => !(record.id === SETTINGS_ID && (settingsRefused || (record.unread && mayOpenLater))));
  }

  /**
   * Push every dirty record. One refused note must not hold back the notes
   * after it in every round, so the loop goes on and rethrows the first error
   * at the end, for the status. A wrong token or no network would fail every
   * record alike, so those stop the round at once.
   */
  async function push() {
    /** @type {unknown} */
    let firstError;
    for (const record of pushable()) {
      try {
        await pushOne(record);
      } catch (err) {
        const status = err && /** @type {any} */ (err).status;
        if (status === 401 || err instanceof TypeError) throw err;
        if (firstError === undefined) firstError = err;
        console.log("[vrtti] push failed", record.id, err);
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  /**
   * The keyring record joins sync as soon as both halves exist. Setup can
   * happen before a server is configured and the other way round, so neither
   * command can own this; the first run that sees both attaches the record.
   */
  function keyringNeedsAttach() {
    const record = store.keyringRecord();
    return Boolean(keyring.isSetUp && record && !record.sync);
  }

  /**
   * The same for the shared settings record (§29). It exists only once the
   * user changed a rule or a word, or a pull brought it; a device that never
   * did either has nothing to attach.
   */
  function settingsNeedAttach() {
    const record = store.get(SETTINGS_ID);
    return Boolean(keyring.isSetUp && record && !record.sync);
  }

  async function ensureKeyringSynced() {
    if (keyringNeedsAttach()) await store.setSync(KEYRING_ID, true, KEYRING_SPACE);
    if (settingsNeedAttach()) await store.setSync(SETTINGS_ID, true, KEYRING_SPACE);
  }

  /** Pull, then push. Single-flight; a call during a run buys one more run. */
  async function syncNow() {
    if (!started) {
      // Not the lock holder: the leader runs, and its status comes back
      // over the channel.
      post("sync-request", {});
      return;
    }
    if (needsUpgrade()) {
      setStatus({ state: "error", message: "set up sync again", lastSyncAt });
      return;
    }
    if (!isConfigured()) {
      setStatus({ state: "off" });
      return;
    }
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      do {
        queued = false;
        setStatus({ state: "syncing", lastSyncAt });
        const joined = await checkJoinReply();
        await ensureKeyringSynced();
        // The directory before the logs: adopt() trusts the known devices,
        // and a log pulled first would skip a space for one round.
        await pullIntroductions();
        await pullLogs();
        await completeJoins();
        await finishSuccessor();
        // This device vouches for the members of its space logs. It also
        // moves an install from before the directory onto it.
        await introduce(mySpaces().flatMap((space) => states[space].members));
        // Last: the joins and the switch above write introductions too.
        await sendIntroductions();
        for (const space of receivedSpaces()) await pullSpace(space);
        // Recent file notes changed on disk become dirty here, so this
        // round's push carries them (§23). After the pull: a pull writes
        // files itself and moves their stamps first.
        await store.stampRecentFiles();
        // The upgrade and the re-encryption run once the members are known.
        await store.sealSynced();
        await store.reencryptStale();
        // After the directory and the logs above: the readers of the shared
        // settings are the known devices as of this round.
        await store.refreshSharedSettings();
        await push();
        await rewrapStubs();
        lastSyncAt = Date.now();
        setStatus({
          state: "idle",
          lastSyncAt,
          directoryMissing,
          settingsRefused,
          message: joined
            ? undefined
            : keyring.signer
              ? "waiting for the device that showed the code"
              : "unlock this device to end the join",
        });
      } while (queued);
    } catch (err) {
      queued = false;
      // Never throws out of here: a sync runs from a timer and from an event
      // listener, and an unhandled rejection there is a console error the user
      // can do nothing about. The status element is the report.
      const code = err && /** @type {any} */ (err).status;
      if (code === 401) {
        setStatus({ state: "error", message: "this device is not registered", lastSyncAt });
      } else if (!navigator.onLine) {
        // Nothing is lost: every dirty record stays dirty and the next online
        // event runs this again.
        setStatus({ state: "offline", lastSyncAt });
      } else {
        // fetch reports a server it could not reach as a TypeError, with a
        // text that differs per browser; one sentence of ours says it better.
        const message =
          err instanceof TypeError
            ? "no answer from the server"
            : err instanceof Error
              ? err.message
              : String(err);
        setStatus({ state: "error", message, lastSyncAt });
      }
      console.log("[vrtti] sync failed", err);
    } finally {
      running = false;
    }
  }

  /** @param {Config | null} next */
  async function saveConfig(next) {
    // Another server (or none) has none of this device's introductions,
    // and may have a directory where the old one had none.
    if (next?.url !== config?.url) {
      sent.clear();
      directoryMissing = false;
      settingsRefused = false;
    }
    config = next;
    if (next) await putSetting(CONFIG_KEY, next);
    else await deleteSetting(CONFIG_KEY);
    post("setting", { key: CONFIG_KEY });
    // Only a device token answers /api/model (§27); probeModel checks it.
    void probeModel();
  }

  /** Leave the server: this device forgets its token. Its notes stay. */
  async function disconnect() {
    await saveConfig(null);
    setStatus({ state: "off" });
  }

  /** @returns {Promise<{ok: boolean, message?: string}>} */
  async function testConnection() {
    if (!isConfigured()) return { ok: false, message: "no server configured" };
    try {
      const res = await request("/api/spaces");
      if (res.status === 401) return { ok: false, message: "this device is not registered" };
      if (!res.ok) return { ok: false, message: "server error " + res.status };
      return { ok: true };
    } catch {
      return { ok: false, message: "no answer from the server" };
    }
  }

  /**
   * The newest server row of one document, for a click on a From server stub
   * (§25). Throws the HTTP error with its status, so the caller can tell a
   * document the server no longer has (404) from a network failure.
   * @param {string} id
   * @returns {Promise<import("../model/docs.js").Change>}
   */
  async function fetchDoc(id) {
    const res = await request("/api/docs/" + encodeURIComponent(id));
    if (!res.ok) throw httpError(res);
    return res.json();
  }

  /**
   * Every live note of a space as the server has it, for a backup (§27):
   * the newest row of each, from the start of the change log.
   * @param {string} space @returns {Promise<import("../model/docs.js").Change[]>}
   */
  async function allNotes(space) {
    /** @type {Map<string, any>} */
    const notes = new Map();
    let since = 0;
    while (true) {
      const res = await request(
        "/api/changes?since=" + since + "&limit=" + PAGE + "&spaces=" + encodeURIComponent(space)
      );
      if (!res.ok) throw httpError(res);
      const body = await res.json();
      for (const change of body.changes ?? []) {
        if (change.space === space && change.kind === "text") notes.set(change.docId, change);
        else notes.delete(change.docId);
      }
      if (!body.more) break;
      if (typeof body.next !== "number" || body.next <= since) {
        throw new SyncError("sync cursor did not advance");
      }
      since = body.next;
    }
    return [...notes.values()];
  }

  /** This device's spaces with a count of live notes each, for Settings. */
  function listSpaces() {
    const counts = new Map(serverSpaces.map((s) => [s.space, s.count]));
    return mySpaces().map((space) => ({ space, count: counts.get(space) ?? 0 }));
  }

  /** What this device does with a space; undefined: not one of its spaces. @param {string} space @returns {SpaceMode} */
  function modeOf(space) {
    if (space === KEYRING_SPACE) return "tab";
    if (!isMine(space)) return undefined;
    return Object.hasOwn(modes, space) ? modes[space] : "tab";
  }

  /**
   * The "New notes" space (§27): where new notes go, and the first "Sync to"
   * of a note's menu. Null is Local only. No fallback to another space: a
   * space another device adds this one to must never take the new notes.
   * @returns {string | null}
   */
  function defaultSpace() {
    return newNotes && isMine(newNotes) ? newNotes : null;
  }

  /**
   * Open as tabs or Titles only (§25). Any window can call this. It only
   * writes the setting; the leader's reload resets the cursor of a space
   * that turned to tabs, because it owns the cursors.
   * @param {string} space @param {StoredMode} mode
   * @returns {Promise<boolean>} false for a refused change
   */
  async function setSpaceMode(space, mode) {
    if (!isMine(space) || (mode !== "tab" && mode !== "list")) return false;
    const next = dict(modes);
    next[space] = mode;
    await putSetting(SPACES_KEY, { ...next });
    post("setting", { key: SPACES_KEY });
    await reloadSettings();
    return true;
  }

  /**
   * Set "New notes": one of this device's spaces, or null for Local only.
   * @param {string | null} space @returns {Promise<boolean>} false for a refused space
   */
  async function setNewNotes(space) {
    if (space !== null && !isMine(space)) return false;
    newNotes = space;
    // Kept: a later field of the setting must survive a change of the space.
    const stored = (await getSetting(NEW_NOTES_KEY)) ?? {};
    await putSetting(NEW_NOTES_KEY, { ...stored, space });
    post("setting", { key: NEW_NOTES_KEY });
    return true;
  }

  /** @param {string} id @returns {Promise<any[]>} */
  async function history(id) {
    const res = await request("/api/docs/" + encodeURIComponent(id) + "/revisions");
    if (!res.ok) throw httpError(res);
    return res.json();
  }

  /** @param {string} id @param {number} rev @returns {Promise<any>} */
  async function revision(id, rev) {
    const res = await request("/api/docs/" + encodeURIComponent(id) + "/revisions/" + rev);
    if (!res.ok) throw httpError(res);
    return res.json();
  }

  /** Does a new document get a server target? Only with a "New notes" space (§27). */
  function syncDefaultOn() {
    return isConfigured() && defaultSpace() !== null;
  }

  /**
   * "New notes" for an install from before it (§27), from the two settings
   * it replaced: the space new notes went to while "Sync new notes" was on
   * (a phone had it on by default), else Local only. Also a fresh install
   * gets its Local only stored here, so a later join never reads the old
   * defaults. @returns {Promise<string | null>}
   */
  async function upgradedNewNotes() {
    const on = await getSetting(OLD_DEFAULT_ON_KEY);
    const name = await getSetting(OLD_DEFAULT_SPACE_KEY);
    const space = typeof name === "string" && isMine(name) ? name : mySpaces()[0] ?? null;
    const wasOn = typeof on === "boolean" ? on : window.matchMedia("(pointer: coarse)").matches && !hasDisk;
    return isConfigured() && space && wasOn ? space : null;
  }

  /**
   * Read the stored settings. Separate from start() because the store creates
   * its first buffer in store.start(), and that buffer's sync target depends
   * on the default this reads.
   */
  async function load() {
    config = (await getSetting(CONFIG_KEY)) ?? null;
    modes = dict();
    for (const [name, mode] of Object.entries((await getSetting(SPACES_KEY)) ?? {})) {
      if (isValidSpace(name) && (mode === "tab" || mode === "list")) modes[name] = mode;
    }
    logs = dict();
    for (const [name, entry] of Object.entries((await getSetting(LOGS_KEY)) ?? {})) {
      if (isValidSpace(name) && entry && typeof entry.creator === "string" && Array.isArray(entry.log)) {
        logs[name] = { creator: entry.creator, log: entry.log.filter((t) => typeof t === "string") };
      }
    }
    invites = (await getSetting(INVITES_KEY)) ?? [];
    // Each one was checked or signed here before it was stored.
    const storedIntroductions = await getSetting(INTRODUCTIONS_KEY);
    introductions = Array.isArray(storedIntroductions) ? storedIntroductions : [];
    joining = (await getSetting(JOINING_KEY)) ?? null;
    rebuild();
    // After rebuild(): the upgrade reads the spaces of this device.
    let stored = await getSetting(NEW_NOTES_KEY);
    if (!stored || typeof stored !== "object") {
      stored = { space: await upgradedNewNotes() };
      await putSetting(NEW_NOTES_KEY, stored);
    }
    newNotes = isValidSpace(stored.space) && stored.space !== KEYRING_SPACE ? stored.space : null;
    // The leader owns the cursors and keeps them in memory; a re-read here
    // could land between its page and that page's write and step back.
    if (!started) await readCursors();
    if (!started) setStatus({ state: isConfigured() ? "idle" : needsUpgrade() ? "error" : "off" });
    void probeModel();
  }

  // ---- The user's language model (.work/mixed-spellcheck/plan.md) ---------
  //
  // The sync server can pass text to a model for "Add diacritics (vllm)".
  // Asked once per configuration, in every window (not only the sync leader),
  // because any window can show the menu entry.
  let model = false;
  /**
   * The last answer of GET /api/model: the model name and a live check
   * ("answers", "not answering", "name not served"). Null without a model,
   * and from a server before the check, which sends only `diacritics`.
   * @type {{name: string, state: string, why?: string | null} | null}
   */
  let modelState = null;

  async function probeModel() {
    // Set together at the end: Settings asks again while the menu may be
    // open, and the entry must not blink out during the request.
    let has = false;
    /** @type {typeof modelState} */
    let state = null;
    if (isConfigured()) {
      try {
        const res = await request("/api/model");
        // 404: a server from before this endpoint, which has no model.
        if (res.ok) {
          const info = await res.json();
          has = info.diacritics === true;
          if (has && info.state) state = { name: info.name, state: info.state, why: info.why };
        }
      } catch {
        // Offline: keep the last answer, so a network error while Settings
        // repaints does not hide the menu entry. At startup the last answer
        // is "no model"; the command asks again (runDiacritics in main.js).
        return model;
      }
    }
    model = has;
    modelState = state;
    return model;
  }

  /**
   * One paragraph to the model, through the server. Throws on any failure;
   * the caller keeps its local result for that paragraph. `caller` goes to
   * the server log only (who asked, which command, which paragraph); the
   * device name is URI-encoded, because fetch() refuses a header value with
   * characters outside Latin-1, and a name can be "Telefon Šárky".
   * @param {string} text
   * @param {{device: string, run: string, part: string}} [caller]
   * @returns {Promise<string>}
   */
  async function addDiacritics(text, caller) {
    // Only to a server that knows the headers (it reports `state`). An older
    // server's CORS rule allows Authorization and Content-Type only, so the
    // browser would refuse the whole request, and Pages deploys the app
    // before the user pulls the new server image.
    const headers = caller && modelState
      ?{ "X-Vrtti-Device": encodeURIComponent(caller.device), "X-Vrtti-Run": caller.run, "X-Vrtti-Part": caller.part }
      : undefined;
    const res = await request("/api/model/diacritics", { method: "POST", body: { text }, headers });
    if (!res.ok) throw httpError(res);
    return (await res.json()).text;
  }

  async function readCursors() {
    cursors = dict(await getSetting(CURSORS_KEY));
    const storedUrl = await getSetting(CURSORS_URL_KEY);
    if (typeof storedUrl === "string") {
      cursorsUrl = storedUrl;
    } else {
      cursorsUrl = config?.url ?? "";
      await putSetting(CURSORS_URL_KEY, cursorsUrl);
    }
  }

  /**
   * Re-read the settings after a write here or in another window. The leader
   * then starts a space again at 0 when it turned from Titles only to Open as
   * tabs, so its notes arrive whole and as tabs, and drops the stubs.
   */
  async function reloadSettings() {
    const before = modes;
    await load();
    if (!started) return;
    let reset = false;
    for (const space of Object.keys(modes)) {
      const was = Object.hasOwn(before, space) ? before[space] : "tab";
      if (was === "list" && modes[space] === "tab") {
        cursors[space] = 0;
        reset = true;
        await store.forgetRemotes(space);
      }
    }
    if (reset) await putSetting(CURSORS_KEY, { ...cursors });
    syncNow();
  }

  // A setting written in another window (architecture.md §14.2): the leader
  // picks up a new server, default, mode or log without a reload, and a window
  // that does not run the schedule still answers modeOf() and defaultSpace().
  on("setting", ({ key }) => {
    if (![CONFIG_KEY, SPACES_KEY, NEW_NOTES_KEY, LOGS_KEY, INVITES_KEY, INTRODUCTIONS_KEY].includes(key)) return;
    reloadSettings().catch((err) => console.log("[vrtti] sync settings reload failed", err));
  });

  /** Wire the triggers and run once. Call after store.start(). */
  function start() {
    if (started) return;
    started = true;

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") syncNow();
    });
    window.addEventListener("online", () => syncNow());
    setInterval(() => syncNow(), POLL);

    // Every keystroke emits "buffer-edit" (and metadata edits emit "change"),
    // so this debounce is what turns a burst of typing into one push.
    //
    // The dirty test is at the END of the wait, not at the start: a keystroke
    // emits "buffer-edit" immediately but only marks the record dirty 300 ms
    // later, after the codec stage of the persist debounce (model/docs.js).
    // Testing it on arrival would find nothing dirty and never arm the timer.
    const armPushDebounce = () => {
      if (!isConfigured()) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (pushable().length > 0 || keyringNeedsAttach() || settingsNeedAttach()) syncNow();
      }, DEBOUNCE);
    };
    store.events.addEventListener("change", armPushDebounce);
    store.events.addEventListener("buffer-edit", armPushDebounce);

    // A window can wait long for the lock, and the old leader moved the
    // cursors meanwhile: read them fresh, or the first run replays all of it.
    readCursors()
      .catch((err) => console.log("[vrtti] sync cursors read failed", err))
      .then(() => syncNow());
  }

  return {
    events,
    load,
    start,
    syncNow,
    testConnection,
    history,
    revision,
    syncDefaultOn,
    // Spaces (architecture.md §25, §27).
    isMine,
    modeOf,
    defaultSpace,
    recipients,
    knownRecipients,
    logSeq,
    colorOf,
    mySpaces,
    receivedSpaces,
    setSpaceMode,
    setNewNotes,
    fetchDoc,
    allNotes,
    listSpaces,
    listUnclaimed,
    isValidSpace,
    createSpace,
    addDevice,
    removeDevice,
    setColor,
    grid,
    deviceName,
    // Joins and registration (§27).
    invite,
    inviteOpen,
    redeem,
    registerFirst,
    changePassphraseSwitch,
    disconnect,
    // The server has no device directory: Settings › Devices asks for an update.
    get directoryMissing() {
      return started ? directoryMissing : status.directoryMissing === true;
    },
    // The server is from before the shared settings: the Spellcheck page says
    // that they stay on this device.
    get settingsRefused() {
      return started ? settingsRefused : status.settingsRefused === true;
    },
    get isJoining() {
      return joining !== null;
    },
    get status() {
      return status;
    },
    // Whether this window runs the schedule (the sync lock holder, §14.3).
    get isRunning() {
      return started;
    },
    get isConfigured() {
      return isConfigured();
    },
    get needsUpgrade() {
      return needsUpgrade();
    },
    // Whether the server has a model for "Add diacritics (vllm)".
    get hasModel() {
      return model;
    },
    get modelState() {
      return modelState;
    },
    addDiacritics,
    probeModel,
    get config() {
      return config ?? { url: "", token: "" };
    },
  };
}
