// @ts-check
// The sync client (architecture.md §3, §13.6).
//
// It owns the network and the schedule, and nothing else. Every rule about
// records (what forks, what merges, what a tombstone does) lives in
// model/docs.js, so this file can be read as "pull, then push, then say so".
//
// Inert until a server URL and a token exist. No login wall, no blocking on the
// network, and no request at all to any other origin before the user configured
// one: the app is fully functional with no server (architecture.md §3).
//
// Order matters: pull first, then push. A push against a stale revision is the
// 409 path, which costs a round trip and a conflict copy; pulling first makes
// most of those disappear before they happen.

import { deleteSetting, getSetting, putSetting } from "../storage/idb.js";
import { on, post } from "../model/channel.js";
import { DEFAULT_SPACE, KEYRING_ID, KEYRING_SPACE } from "../model/docs.js";
import { hasDisk } from "../model/capabilities.js";

const CONFIG_KEY = "sync.config";
const DEFAULT_ON_KEY = "sync.defaultOn";
// Spaces (architecture.md §25): the device's mode per space, its default
// space, and one pull cursor per space.
const SPACES_KEY = "sync.spaces";
const DEFAULT_SPACE_KEY = "sync.defaultSpace";
const CURSORS_KEY = "sync.cursors";
// The single cursor from before spaces. load() turns it into the cursors of
// `personal` and `keyring`, then deletes it.
const LEGACY_CURSOR_KEY = "sync.cursor";
// How long the server's space list stays fresh. The settings panel asks on
// every paint; ten seconds is a repaint burst, not a stale answer.
const SPACES_TTL = 10000;

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
 * it too, so a typo is refused at the settings row and never becomes a 400
 * on every push of a note.
 * @param {unknown} name @returns {name is string}
 */
export function isValidSpace(name) {
  return typeof name === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(name);
}

/**
 * A plain map with no prototype. Space names are user text, and `constructor`
 * and `__proto__` pass the name rule: on an ordinary object the first reads
 * back as Object's own function (a "mode" for a space nobody set) and the
 * second assigns the prototype instead of a key. Every map keyed by a space
 * name goes through here, including the ones read back from IndexedDB, which
 * come back as ordinary objects.
 * @template T
 * @param {Record<string, T> | undefined | null} [from]
 * @returns {Record<string, T>}
 */
function dict(from) {
  return Object.assign(Object.create(null), from ?? {});
}

/** @typedef {import("../model/docs.js").SpaceMode} SpaceMode */
/** @typedef {'tab' | 'list'} StoredMode */

/**
 * @typedef {Object} SyncStatus
 * @property {'off' | 'idle' | 'syncing' | 'error' | 'offline'} state
 * @property {string} [message]
 * @property {number} [lastSyncAt]
 */

/**
 * @param {{store: ReturnType<import("../model/docs.js").createDocStore>,
 *          keyring: import("../crypto/keyring.js").KeyRing}} deps
 */
export function createSyncClient({ store, keyring }) {
  const events = new EventTarget();

  /** @type {{url: string, token: string} | null} */
  let config = null;
  /**
   * The seq of the last change applied, per received space: the server's
   * paging cursor (§13.5, §25). The leader writes it, as one settings row.
   * @type {Record<string, number>}
   */
  let cursors = dict();
  /**
   * The device's mode per space (§25). An absent name is Not here. Starts as
   * the no-setting answer, so a store question before load() finds the
   * behaviour of a device that never touched spaces.
   * @type {Record<string, StoredMode>}
   */
  let modes = dict({ [DEFAULT_SPACE]: "tab" });
  let defaultSpaceName = DEFAULT_SPACE;
  /** @type {{at: number, list: {space: string, count: number}[]} | null} */
  let spacesCache = null;
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
    return Boolean(config && config.url && config.token);
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
   * @param {string} path @param {{method?: string, body?: any}} [opts]
   * @returns {Promise<Response>}
   */
  function request(path, opts = {}) {
    if (!config) throw new Error("sync: not configured");
    return fetch(config.url + path, {
      method: opts.method ?? "GET",
      headers: {
        Authorization: "Bearer " + config.token,
        "Content-Type": "application/json",
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      // The service worker ignores cross-origin requests, but an HTTP cache in
      // front of the API would be just as wrong: a cached /changes page would
      // replay the same rows for ever.
      cache: "no-store",
    });
  }

  /** @param {Response} res */
  function httpError(res) {
    const err = new Error("server said " + res.status);
    // @ts-ignore - carried so the status handler can tell 401 from the rest
    err.status = res.status;
    return err;
  }

  /**
   * The spaces this device pulls: the keyring, then every mode in the map.
   * The keyring goes first in a round, as it came first in the one feed
   * before spaces: a note encrypted to a device this one has not met yet
   * must find the device list already merged (§13.3, §20).
   */
  function receivedSpaces() {
    return [KEYRING_SPACE, ...Object.keys(modes)];
  }

  /** @param {string} space */
  function isReceived(space) {
    return space === KEYRING_SPACE || Object.hasOwn(modes, space);
  }

  /** Pull each received space in turn (§25). */
  async function pull() {
    for (const space of receivedSpaces()) await pullSpace(space);
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
      // The settings can change during a page (another window, a click):
      // a space dropped since must not get its cursor back.
      if (!isReceived(space)) return;
      const since = cursors[space] ?? 0;
      const res = await request(
        "/api/changes?since=" + since + "&limit=" + PAGE +
          "&spaces=" + encodeURIComponent(space)
      );
      if (!res.ok) throw httpError(res);
      const body = await res.json();
      for (const change of body.changes ?? []) await store.applyRemote(change);
      // Compare and set: a reset to 0 while this page was in flight (a space
      // turned from From server to Open as tab) must win over this page's
      // `next`, or the listed notes would never arrive as tabs.
      if ((cursors[space] ?? 0) !== since || !isReceived(space)) return;
      if (typeof body.next === "number" && body.next !== since) {
        cursors[space] = body.next;
        await putSetting(CURSORS_KEY, { ...cursors });
      }
      if (!body.more) return;
    }
  }

  /**
   * Push one record.
   *
   * age wraps a fresh file key on every save, so the ciphertext of unchanged
   * text differs on every push. Never add a "skip if the bytes are the same"
   * shortcut here: it would do nothing for encrypted docs and would hide real
   * pushes of plaintext ones (architecture.md §13.6).
   *
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

    const res = await request(
      "/api/docs/" + encodeURIComponent(record.id) + "/revisions",
      { method: "POST", body: payload }
    );

    if (res.status === 409) {
      const body = await res.json().catch(() => ({}));
      // The server's current version goes through the same door as a pulled
      // one, so the conflict rule stays in one place (model/docs.js). The
      // space rules too: a `current` from a space this device does not
      // receive (the note moved elsewhere) detaches the record there.
      if (body && body.current) return store.applyRemote(body.current);
      if (!attach) return pushOne(record, true);
      return;
    }
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

  async function push() {
    for (const record of store.dirtyRecords()) await pushOne(record);
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
        await ensureKeyringSynced();
        await pull();
        // Recent file notes changed on disk become dirty here, so this
        // round's push carries them (§23). After the pull: a pull writes
        // files itself and moves their stamps first.
        await store.stampRecentFiles();
        await push();
        lastSyncAt = Date.now();
        setStatus({ state: "idle", lastSyncAt });
      } while (queued);
    } catch (err) {
      queued = false;
      // Never throws out of here: a sync runs from a timer and from an event
      // listener, and an unhandled rejection there is a console error the user
      // can do nothing about. The status element is the report.
      const code = err && /** @type {any} */ (err).status;
      if (code === 401) {
        setStatus({ state: "error", message: "unauthorized", lastSyncAt });
      } else if (!navigator.onLine) {
        // Nothing is lost: every dirty record stays dirty and the next online
        // event runs this again.
        setStatus({ state: "offline", lastSyncAt });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        setStatus({ state: "error", message, lastSyncAt });
      }
      console.log("[vrtti] sync failed", err);
    } finally {
      running = false;
    }
  }

  /**
   * Store a server and try it at once. Called by the settings rows through the
   * sync.configure command.
   * @param {{url?: string, token?: string}} next
   */
  async function configure(next) {
    const url = (next.url ?? "").trim().replace(/\/+$/, "");
    const token = (next.token ?? "").trim();
    config = { url, token };
    await putSetting(CONFIG_KEY, config);
    post("setting", { key: CONFIG_KEY });
    if (!isConfigured()) {
      setStatus({ state: "off" });
      return;
    }
    // A new server is a new namespace, but the cursor is not reset here: the
    // user's own server can be re-entered after a typo, and rewinding to 0
    // would replay every change as a conflict. Clearing the setting is the
    // deliberate way to start over.
    await syncNow();
  }

  /** @returns {Promise<{ok: boolean, message?: string}>} */
  async function testConnection() {
    if (!isConfigured()) return { ok: false, message: "no server configured" };
    try {
      const res = await request("/api/changes?since=0&limit=1");
      if (res.status === 401) return { ok: false, message: "unauthorized" };
      if (!res.ok) return { ok: false, message: "server said " + res.status };
      return { ok: true };
    } catch {
      return { ok: false, message: "unreachable" };
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
    const change = await res.json();
    change.space ??= DEFAULT_SPACE;
    return change;
  }

  /**
   * The server's spaces with a count of live documents each, for the settings
   * panel (§25). `keyring` is left out: no list ever shows it.
   * @returns {Promise<{space: string, count: number}[]>}
   */
  async function listSpaces() {
    if (!isConfigured()) return [];
    if (spacesCache && Date.now() - spacesCache.at < SPACES_TTL) return spacesCache.list;
    const res = await request("/api/spaces");
    // A server from before spaces has no such endpoint. Its notes are all in
    // `personal`, which the panel lists from the device's own map anyway.
    if (res.status === 404) return [];
    if (!res.ok) throw httpError(res);
    /** @type {{space: string, count: number}[]} */
    const all = await res.json();
    const list = all.filter((entry) => entry.space !== KEYRING_SPACE);
    spacesCache = { at: Date.now(), list };
    return list;
  }

  /** What this device does with a space; undefined is Not here. @param {string} space @returns {SpaceMode} */
  function modeOf(space) {
    if (space === KEYRING_SPACE) return "tab";
    return Object.hasOwn(modes, space) ? modes[space] : undefined;
  }

  /** @returns {string} */
  function defaultSpace() {
    return defaultSpaceName;
  }

  /**
   * Give a space a mode, or take it off this device with null (§25). Any
   * window can call this. It only writes the setting; the leader's reload
   * diffs the modes and does the cursor resets, the detach and the stub
   * removal, because those touch the records and the cursors it owns.
   * @param {string} space @param {StoredMode | null} mode
   * @returns {Promise<boolean>} false for a refused change
   */
  async function setSpaceMode(space, mode) {
    if (!isValidSpace(space) || space === KEYRING_SPACE) return false;
    if (mode !== "tab" && mode !== "list" && mode !== null) return false;
    // The default space is always received: a note this device attaches
    // must be able to come back to it.
    if (mode === null && space === defaultSpaceName) return false;
    const next = dict(modes);
    if (mode === null) delete next[space];
    else next[space] = mode;
    await putSetting(SPACES_KEY, { ...next });
    post("setting", { key: SPACES_KEY });
    await reloadSettings();
    return true;
  }

  /**
   * Where this device's new syncs go (§25). A space that was Not here turns
   * Open as tab in the same step, so the default is always received.
   * @param {string} name @returns {Promise<boolean>} false for a refused name
   */
  async function setDefaultSpace(name) {
    if (!isValidSpace(name) || name === KEYRING_SPACE) return false;
    if (!Object.hasOwn(modes, name)) {
      await putSetting(SPACES_KEY, { ...modes, [name]: "tab" });
    }
    await putSetting(DEFAULT_SPACE_KEY, name);
    // One message for both rows: a reload re-reads every space setting, and
    // two messages would run the leader's diff twice.
    post("setting", { key: DEFAULT_SPACE_KEY });
    await reloadSettings();
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
    const res = await request(
      "/api/docs/" + encodeURIComponent(id) + "/revisions/" + rev
    );
    if (!res.ok) throw httpError(res);
    return res.json();
  }

  /**
   * Does a new document get a server target? Unset means the platform default:
   * on where there is no disk to fall back on (architecture.md §3, §4), and
   * never at all without a server, because a flag nothing acts on is a lie.
   */
  function syncDefaultOn() {
    if (!isConfigured()) return false;
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
   * Read the stored config, cursor and default. Separate from start() because
   * the store creates its first buffer in store.start(), and that buffer's
   * sync target depends on the default this reads.
   */
  async function load() {
    config = (await getSetting(CONFIG_KEY)) ?? null;
    defaultOn = await getSetting(DEFAULT_ON_KEY);
    await loadSpaces();
    setStatus({ state: isConfigured() ? "idle" : "off" });
  }

  /** The space settings and the cursors (§25), with their two defaults. */
  async function loadSpaces() {
    const storedName = await getSetting(DEFAULT_SPACE_KEY);
    defaultSpaceName =
      isValidSpace(storedName) && storedName !== KEYRING_SPACE ? storedName : DEFAULT_SPACE;
    /** @type {Record<string, StoredMode>} */
    const next = dict();
    const stored = await getSetting(SPACES_KEY);
    // Unset means a device that never touched spaces: it takes `personal`
    // as tabs, exactly as sync worked before.
    for (const [name, mode] of Object.entries(stored ?? { [DEFAULT_SPACE]: "tab" })) {
      // `keyring` is received apart from the map, always, so it is never a
      // mode a setting could turn off.
      if (!isValidSpace(name) || name === KEYRING_SPACE) continue;
      if (mode === "tab" || mode === "list") next[name] = mode;
    }
    // The default is always received (setDefaultSpace writes it so). A map
    // that lost it by hand still gets it here, in memory only.
    if (!Object.hasOwn(next, defaultSpaceName)) next[defaultSpaceName] = "tab";
    modes = next;
    // The leader owns the cursors and keeps them in memory; a re-read here
    // could land between its page and that page's write and step back.
    if (!started) await readCursors();
  }

  /** The cursors, with the one-time move from the single legacy cursor. */
  async function readCursors() {
    let storedCursors = await getSetting(CURSORS_KEY);
    if (storedCursors === undefined) {
      const legacy = await getSetting(LEGACY_CURSOR_KEY);
      if (typeof legacy === "number") {
        // Before spaces every row was in one of these two, so both have
        // seen everything up to the old cursor.
        storedCursors = { [DEFAULT_SPACE]: legacy, [KEYRING_SPACE]: legacy };
        await putSetting(CURSORS_KEY, storedCursors);
        await deleteSetting(LEGACY_CURSOR_KEY);
      }
    }
    cursors = dict(storedCursors);
  }

  /**
   * Re-read the settings after a write here or in another window. The leader
   * then applies what changed in the modes (§25): a space that appears, or
   * turns from From server to Open as tab, starts again at 0 so its notes
   * arrive whole and as tabs; a space that goes loses its cursor, its
   * records' sync and its stubs. Only the leader does this, because only it
   * writes the cursors and the stubs.
   */
  async function reloadSettings() {
    const before = modes;
    await load();
    if (!started) return;
    let reset = false;
    for (const space of Object.keys(modes)) {
      const was = Object.hasOwn(before, space) ? before[space] : undefined;
      if (was === undefined || (was === "list" && modes[space] === "tab")) {
        cursors[space] = 0;
        reset = true;
      }
    }
    for (const space of Object.keys(before)) {
      if (Object.hasOwn(modes, space)) continue;
      delete cursors[space];
      reset = true;
      await store.detachSpace(space);
    }
    if (reset) await putSetting(CURSORS_KEY, { ...cursors });
    syncNow();
  }

  // A setting written in another window (architecture.md §14.2): the leader
  // picks up a new server, default or space without a reload, and a window
  // that does not run the schedule still answers syncDefaultOn(), modeOf()
  // and defaultSpace() correctly.
  on("setting", ({ key }) => {
    if (![CONFIG_KEY, DEFAULT_ON_KEY, SPACES_KEY, DEFAULT_SPACE_KEY].includes(key)) return;
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
        // The keyring record is the one thing that can be waiting here without
        // being dirty yet: setup writes it with no server target at all, and
        // ensureKeyringSynced attaches it inside the run.
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
    configure,
    testConnection,
    history,
    revision,
    syncDefaultOn,
    toggleSyncDefault,
    // Spaces (architecture.md §25).
    modeOf,
    defaultSpace,
    receivedSpaces,
    setSpaceMode,
    setDefaultSpace,
    fetchDoc,
    listSpaces,
    isValidSpace,
    get spaces() {
      return { modes: { ...modes }, defaultSpace: defaultSpaceName };
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
    get config() {
      return config ?? { url: "", token: "" };
    },
  };
}
