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
import { KEYRING_ID, KEYRING_SPACE } from "../model/docs.js";
import { hasDisk } from "../model/capabilities.js";
import { entryKey } from "../crypto/keyring.js";
import { sha256Hex } from "../crypto/sign.js";
import {
  formatCode,
  joinProof,
  joinReplyMac,
  joinVerifier,
  newCode,
  nextColor,
  nextEntry,
  normalizeCode,
  parseEntryKey,
  replay,
  sameHex,
  slotOf,
} from "../crypto/spaces.js";

const CONFIG_KEY = "sync.config";
const DEFAULT_ON_KEY = "sync.defaultOn";
// The device's mode per space ('tab' or 'list'), its default space, and one
// pull cursor per space (§25).
const SPACES_KEY = "sync.spaces";
const DEFAULT_SPACE_KEY = "sync.defaultSpace";
const CURSORS_KEY = "sync.cursors";
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
// A guard, not a limit: `more` comes from the server, and a server that always
// answers true would otherwise spin here for ever.
const MAX_PAGES = 100;

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
  /** @type {string} */
  let defaultSpaceName = "";
  /** @type {Record<string, SpaceLog>} */
  let logs = dict();
  /** The replayed state of each log, rebuilt whenever `logs` changes. @type {Record<string, SpaceState>} */
  let states = dict();
  /** The last `GET /api/spaces` answer. @type {{space: string, count: number, logSeq: number}[]} */
  let serverSpaces = [];
  /** @type {Invite[]} */
  let invites = [];
  /** @type {{slot: string, code: string, modes?: Record<string, "tab" | "list">} | null} */
  let joining = null;
  /** @type {boolean | undefined} An explicit choice; undefined means "platform". */
  let defaultOn;
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
    const next = dict();
    for (const [space, entry] of Object.entries(logs)) {
      const state = replay(entry.log, entry.creator);
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
   * This device is out of a space: its notes go to the local trash, and the
   * device forgets the log, the cursor and the mode (§27).
   * @param {string} space
   */
  async function lose(space) {
    console.log("[vrtti] this device left the space", space);
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
      const after = replay([...entry.log, text], entry.creator);
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
    await saveLogs();
    if (!defaultSpaceName || !isMine(defaultSpaceName)) await setDefaultSpace(name);
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
   * The grid of Settings › Devices: this device's spaces as columns, every
   * device their logs ever named as rows (a removed one can be added back).
   */
  function grid() {
    const spaces = mySpaces();
    /** @type {Map<string, {key: string, id: string, name: string, me: boolean}>} */
    const devices = new Map();
    const me = keyring.ownKey();
    const replaced = replacedKeys(spaces);
    for (const space of spaces) {
      for (const key of states[space].known) {
        const parsed = parseEntryKey(key);
        if (!parsed || devices.has(key)) continue;
        // The keys of a device before a change of its passphrase switch:
        // the same device under its new key is a row of its own already.
        if (replaced.has(key) && !spaces.some((s) => states[s].members.includes(key))) continue;
        devices.set(key, { key, id: parsed.id, name: parsed.name, me: key === me });
      }
    }
    const rows = [...devices.values()].sort((a, b) => Number(b.me) - Number(a.me) || a.name.localeCompare(b.name));
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
   * only, so each entry of the shape is signed.
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
   * The device name for a device id: from the logs, which are signed, else
   * from the keyring record (names only, §27), for a device of a space this
   * device is not in. @param {string} id
   */
  function deviceName(id) {
    for (const state of Object.values(states)) {
      for (const key of state.known) {
        const parsed = parseEntryKey(key);
        if (parsed?.id === id) return parsed.name;
      }
    }
    return keyring.content?.devices.find((d) => d.id === id)?.name ?? "";
  }

  // ---- Joins (architecture.md §27) ----------------------------------------

  /**
   * "Add a device": a code for the ticked spaces, valid ten minutes, once.
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
      console.log("[vrtti] added", parsed.name, "to", Object.keys(creators).join(", "));
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
      for (const space of mySpaces()) {
        if (!states[space].members.includes(newKey)) await append(space, { op: "add", device: newKey });
      }
    }
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
    if (isConfigured()) {
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
    for (let page = 0; page < MAX_PAGES; page++) {
      if (space !== KEYRING_SPACE && !isMine(space)) return;
      // Another server than the cursors know: start at 0, and forget the old
      // positions only once this server has answered. A typo in the URL and
      // the way back to the real server then cost nothing.
      const url = config?.url ?? "";
      const stale = cursorsUrl !== url;
      const since = stale ? 0 : cursors[space] ?? 0;
      const res = await request(
        "/api/changes?since=" + since + "&limit=" + PAGE + "&spaces=" + encodeURIComponent(space)
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
      for (const change of body.changes ?? []) await store.applyRemote(change);
      // Compare and set: a reset to 0 while this page was in flight (a space
      // turned from Titles only to Open as tabs) must win over this page's
      // `next`, or the listed notes would never arrive as tabs.
      if ((cursors[space] ?? 0) !== since) return;
      if (typeof body.next === "number" && body.next !== since) {
        cursors[space] = body.next;
        await putSetting(CURSORS_KEY, { ...cursors });
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
    const { payload, sentMtime } = prepared;
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
    if (res.status === 404 && record.kind !== "keyring") return store.trash(record.id);
    if (!res.ok) throw httpError(res);

    const body = await res.json();
    await store.afterPush(record.id, body.rev, sentUpdatedAt, sentMtime);

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
   * Push every dirty record. One refused note must not hold back the notes
   * after it in every round, so the loop goes on and rethrows the first error
   * at the end, for the status. A wrong token or no network would fail every
   * record alike, so those stop the round at once.
   */
  async function push() {
    /** @type {unknown} */
    let firstError;
    for (const record of store.dirtyRecords()) {
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

  async function ensureKeyringSynced() {
    if (keyringNeedsAttach()) await store.setSync(KEYRING_ID, true, KEYRING_SPACE);
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
        await pullLogs();
        await completeJoins();
        await finishSuccessor();
        for (const space of receivedSpaces()) await pullSpace(space);
        // Recent file notes changed on disk become dirty here, so this
        // round's push carries them (§23). After the pull: a pull writes
        // files itself and moves their stamps first.
        await store.stampRecentFiles();
        // The upgrade and the re-encryption run once the members are known.
        await store.sealSynced();
        await store.reencryptStale();
        await push();
        await rewrapStubs();
        lastSyncAt = Date.now();
        setStatus({
          state: "idle",
          lastSyncAt,
          message: joined ? undefined : "waiting for the device that showed the code",
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
    for (let page = 0; page < MAX_PAGES; page++) {
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
   * Where this device's new syncs go (§25, §27): the chosen space while this
   * device is in it, else its first space, else nowhere.
   * @returns {string | null}
   */
  function defaultSpace() {
    if (defaultSpaceName && isMine(defaultSpaceName)) return defaultSpaceName;
    return mySpaces()[0] ?? null;
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

  /** @param {string} name @returns {Promise<boolean>} false for a refused name */
  async function setDefaultSpace(name) {
    if (!isValidSpace(name) || name === KEYRING_SPACE) return false;
    defaultSpaceName = name;
    await putSetting(DEFAULT_SPACE_KEY, name);
    post("setting", { key: DEFAULT_SPACE_KEY });
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

  /**
   * Does a new document get a server target? Unset means the platform default:
   * on where there is no disk to fall back on (architecture.md §3, §4), and
   * never without a space to put it in (§27).
   */
  function syncDefaultOn() {
    if (!isConfigured() || !defaultSpace()) return false;
    if (typeof defaultOn === "boolean") return defaultOn;
    return window.matchMedia("(pointer: coarse)").matches && !hasDisk;
  }

  /** Flip it, and store the answer as an explicit choice from now on. */
  async function toggleSyncDefault() {
    defaultOn = !syncDefaultOn();
    await putSetting(DEFAULT_ON_KEY, defaultOn);
    post("setting", { key: DEFAULT_ON_KEY });
    return defaultOn;
  }

  /**
   * Read the stored settings. Separate from start() because the store creates
   * its first buffer in store.start(), and that buffer's sync target depends
   * on the default this reads.
   */
  async function load() {
    config = (await getSetting(CONFIG_KEY)) ?? null;
    defaultOn = await getSetting(DEFAULT_ON_KEY);
    const storedName = await getSetting(DEFAULT_SPACE_KEY);
    defaultSpaceName = isValidSpace(storedName) && storedName !== KEYRING_SPACE ? storedName : "";
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
    joining = (await getSetting(JOINING_KEY)) ?? null;
    rebuild();
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
    if (![CONFIG_KEY, DEFAULT_ON_KEY, SPACES_KEY, DEFAULT_SPACE_KEY, LOGS_KEY, INVITES_KEY].includes(key)) return;
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

    // Every keystroke emits "change", so this debounce is what turns a burst of
    // typing into one push.
    //
    // The dirty test is at the END of the wait, not at the start: a keystroke
    // emits "change" immediately but only marks the record dirty 300 ms later,
    // after the codec stage of the persist debounce (model/docs.js). Testing it
    // on arrival would find nothing dirty and never arm the timer at all.
    store.events.addEventListener("change", () => {
      if (!isConfigured()) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (store.dirtyRecords().length > 0 || keyringNeedsAttach()) syncNow();
      }, DEBOUNCE);
    });

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
    toggleSyncDefault,
    // Spaces (architecture.md §25, §27).
    modeOf,
    defaultSpace,
    recipients,
    logSeq,
    colorOf,
    mySpaces,
    receivedSpaces,
    setSpaceMode,
    setDefaultSpace,
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
