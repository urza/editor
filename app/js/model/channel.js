// @ts-check
// The wire between windows (architecture.md §14.2): one BroadcastChannel and
// typed messages. A window patches its in-memory Maps from what arrives and
// never re-reads the store for it. BroadcastChannel never echoes to the
// sender, so a handler only ever sees other windows' messages. The window id
// travels with every message so a later unit can address one window.
//
// Message types and payloads:
//   buffer            { record }            a buffer record after a local put
//   buffer-deleted    { id }
//   workspace         { record }            a workspace record after a local put
//   workspace-deleted { id }
//   handle            { kind: "added", record } | { kind: "removed", id }
//   setting           { key }               a settings row changed
//   focus             { ws }                bring that workspace's window forward
//   window-closed     { ws }                a browser tab went away (pagehide)
//   unlock            { identity, kind, signing }  a window's unlocked keys (§14.3, §21)

const NAME = "vrtti";

export const windowId = crypto.randomUUID();

/** @type {BroadcastChannel | null} */
const channel = "BroadcastChannel" in window ? new BroadcastChannel(NAME) : null;

/** @type {Map<string, Set<(payload: any, message: any) => void>>} */
const handlers = new Map();

if (channel) {
  channel.onmessage = (event) => {
    const message = event.data;
    if (!message || typeof message.type !== "string") return;
    for (const handler of handlers.get(message.type) ?? []) {
      try {
        handler(message.payload, message);
      } catch (err) {
        console.log("[vrtti] channel handler failed:", message.type, err);
      }
    }
  };
}

/** @param {string} type @param {any} payload */
export function post(type, payload) {
  if (!channel) return;
  try {
    channel.postMessage({ type, payload, from: windowId });
  } catch (err) {
    // A payload that cannot be cloned is a bug; say so instead of throwing
    // into a write path that already finished its IndexedDB work.
    console.log("[vrtti] channel post failed:", type, err);
  }
}

/**
 * @param {string} type @param {(payload: any, message: any) => void} handler
 * @returns {() => void} unsubscribe
 */
export function on(type, handler) {
  let set = handlers.get(type);
  if (!set) {
    set = new Set();
    handlers.set(type, set);
  }
  set.add(handler);
  return () => set?.delete(handler);
}
