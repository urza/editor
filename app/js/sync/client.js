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

import { getSetting, putSetting } from "../storage/idb.js";
import { KEYRING_ID } from "../model/docs.js";
import { hasFileSystemAccess } from "../model/capabilities.js";

const CONFIG_KEY = "sync.config";
const CURSOR_KEY = "sync.cursor";
const DEFAULT_ON_KEY = "sync.defaultOn";

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
  /** The seq of the last change applied. The server's paging cursor (§13.5). */
  let cursor = 0;
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

  function isConfigured() {
    return Boolean(config && config.url && config.token);
  }

  /** @param {SyncStatus} next */
  function setStatus(next) {
    status = next;
    events.dispatchEvent(new CustomEvent("status", { detail: status }));
  }

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
   * Pull every change since the cursor and apply it in order.
   *
   * The cursor moves after each applied page, never before: a failure in the
   * middle of a page re-delivers it, and applyRemote is idempotent (a change
   * whose rev the record already agreed with is skipped).
   */
  async function pull() {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await request("/api/changes?since=" + cursor + "&limit=" + PAGE);
      if (!res.ok) throw httpError(res);
      const body = await res.json();
      for (const change of body.changes ?? []) await store.applyRemote(change);
      if (typeof body.next === "number" && body.next !== cursor) {
        cursor = body.next;
        await putSetting(CURSOR_KEY, cursor);
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
    const payload = await store.pushPayload(record);
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
      // one, so the conflict rule stays in one place (model/docs.js).
      if (body && body.current) return store.applyRemote(body.current);
      if (!attach) return pushOne(record, true);
      return;
    }
    if (!res.ok) throw httpError(res);

    const body = await res.json();
    await store.afterPush(record.id, body.rev, sentUpdatedAt);

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
    if (keyringNeedsAttach()) await store.setSync(KEYRING_ID, true);
  }

  /** Pull, then push. Single-flight; a call during a run buys one more run. */
  async function syncNow() {
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
    return window.matchMedia("(pointer: coarse)").matches && !hasFileSystemAccess;
  }

  /** Flip it, and store the answer as an explicit choice from now on. */
  async function toggleSyncDefault() {
    defaultOn = !syncDefaultOn();
    await putSetting(DEFAULT_ON_KEY, defaultOn);
    return defaultOn;
  }

  /**
   * Read the stored config, cursor and default. Separate from start() because
   * the store creates its first buffer in store.start(), and that buffer's
   * sync target depends on the default this reads.
   */
  async function load() {
    config = (await getSetting(CONFIG_KEY)) ?? null;
    cursor = (await getSetting(CURSOR_KEY)) ?? 0;
    defaultOn = await getSetting(DEFAULT_ON_KEY);
    setStatus({ state: isConfigured() ? "idle" : "off" });
  }

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

    syncNow();
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
    get status() {
      return status;
    },
    get isConfigured() {
      return isConfigured();
    },
    get config() {
      return config ?? { url: "", token: "" };
    },
  };
}
