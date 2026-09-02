// @ts-check
// Settings panel (architecture.md §9). A plain DOM overlay over the editor:
// no modal library, no routing. Escape, the × button, and the command that
// opened it all close it.
//
// The content is a declarative list of sections and items. A new setting is a
// new entry in SECTIONS, never new render code, and an item never writes state
// itself: it dispatches a command and the panel repaints from the state that
// results. Sync and Security sections join the same list when they ship.

import { run } from "../commands/registry.js";
import { events as spellEvents, isEnabled } from "../editor/spellcheck.js";
import { isPersisted, storageEstimate } from "../model/capabilities.js";
import { BUILD } from "../version.js";

/**
 * The keyring the Security section reports on, handed in by mountSettings.
 *
 * A module-level reference rather than a parameter threaded through every row:
 * SECTIONS is a static list built at module load, which is what keeps a new
 * setting a data change and not a render change. The rows below read this when
 * they paint, so it is always set by then.
 * @type {import("../crypto/keyring.js").KeyRing | null}
 */
let keyring = null;

/**
 * The sync client the Sync section reports on. Same reason as `keyring` above.
 * @type {ReturnType<import("../sync/client.js").createSyncClient> | null}
 */
let sync = null;

/** Result of the last "Test connection" click, shown on that row. */
let testResult = "";

/**
 * One row. `type` picks the renderer; the other fields are per type.
 *
 * @typedef {Object} Item
 * @property {"toggle" | "text" | "info" | "action" | "note"} type
 * @property {string} [key]    Stable id. Becomes data-key, for tests and for
 *                             the future settings store.
 * @property {string} [label]  Left-hand text of a toggle, info or action row.
 * @property {string} [hint]   Small line under the label.
 * @property {() => any} [get]        toggle: the state. text: the value.
 * @property {(value?: any) => any} [set]  toggle: dispatch the flip. text:
 *                             dispatch the value the user typed.
 * @property {boolean} [password]     text: hide what is typed.
 * @property {string} [placeholder]   text: empty-field hint.
 * @property {() => string | Promise<string>} [value]    info (and action):
 *                             right-hand text.
 * @property {() => boolean | Promise<boolean>} [visible] Hide the row when false.
 * @property {string} [button]                           action: button label.
 * @property {() => any} [act]                           action: dispatch the action.
 * @property {string} [text]                             note: one paragraph.
 * @property {{ text: string, href: string }[]} [links]  note: external links.
 */

/** @typedef {{ title: string, items: Item[] }} Section */

/**
 * Decimal units, because that is what storage quotas are reported in.
 * @type {[string, number][]}
 */
const UNITS = [
  ["GB", 1e9],
  ["MB", 1e6],
  ["kB", 1e3],
];

/** @param {number} bytes */
function formatBytes(bytes) {
  for (const [unit, size] of UNITS) {
    if (bytes >= size) return (bytes / size).toFixed(1) + " " + unit;
  }
  return bytes + " B";
}

/** One line for the sync status row: state, why, and when it last worked. */
function syncStatusText() {
  if (!sync) return "off";
  const { state, message, lastSyncAt } = sync.status;
  let text = state;
  if (message) text += " (" + message + ")";
  if (lastSyncAt) {
    text += " · last sync " + new Date(lastSyncAt).toLocaleTimeString();
  }
  return text;
}

/** @type {Section[]} */
const SECTIONS = [
  {
    title: "Editor",
    items: [
      {
        type: "toggle",
        key: "spellcheck",
        label: "Spellcheck (English)",
        hint: "Harper, offline. Spelling is underlined red, style hints blue.",
        get: () => isEnabled(),
        set: () => run("spell.toggle"),
      },
    ],
  },
  {
    title: "Storage",
    items: [
      {
        type: "info",
        key: "persisted",
        label: "Persistent storage",
        hint: "Without it the browser may evict buffers when disk runs low.",
        value: async () => ((await isPersisted()) ? "granted" : "not granted"),
      },
      {
        type: "info",
        key: "usage",
        label: "Used",
        value: async () => {
          const estimate = await storageEstimate();
          if (!estimate) return "unknown";
          return formatBytes(estimate.usage) + " of " + formatBytes(estimate.quota);
        },
      },
      {
        type: "action",
        key: "request-persist",
        label: "Request persistent storage",
        hint: "Chrome grants it silently to an installed app; other browsers ask.",
        button: "request",
        // Pointless once the grant exists, so the row disappears with it.
        visible: async () => !(await isPersisted()),
        act: () => run("storage.persist"),
      },
    ],
  },
  {
    title: "Sync",
    items: [
      {
        type: "text",
        key: "sync-url",
        label: "Server URL",
        hint: "Empty means no sync at all. The app never calls a server it was not given.",
        placeholder: "https://sync.example.com",
        get: () => sync?.config.url ?? "",
        // Both fields dispatch the whole config: the client stores one row, and
        // a half-written config would make it inert on the next reload.
        set: (value) =>
          run("sync.configure", { url: value, token: sync?.config.token ?? "" }),
      },
      {
        type: "text",
        key: "sync-token",
        label: "Token",
        hint: "The server's bearer token. It stays on this device.",
        password: true,
        get: () => sync?.config.token ?? "",
        set: (value) =>
          run("sync.configure", { url: sync?.config.url ?? "", token: value }),
      },
      {
        type: "info",
        key: "sync-status",
        label: "Status",
        value: () => syncStatusText(),
      },
      {
        type: "action",
        key: "sync-test",
        label: "Test connection",
        button: "test",
        visible: () => Boolean(sync?.isConfigured),
        value: () => testResult,
        act: async () => {
          testResult = "…";
          const result = await (sync?.testConnection() ?? { ok: false });
          testResult = result.ok ? "ok" : result.message ?? "failed";
        },
      },
      {
        type: "toggle",
        key: "sync-default",
        label: "New docs sync by default",
        hint: "Unset follows the platform: on for a phone, off where there is a disk.",
        get: () => Boolean(sync?.syncDefaultOn()),
        set: () => run("sync.defaultToggle"),
      },
      {
        type: "action",
        key: "sync-all",
        label: "Sync all current docs",
        hint: "Attaches every open document. It sets the same per-document flag.",
        button: "attach",
        visible: () => Boolean(sync?.isConfigured),
        act: () => run("sync.all"),
      },
      {
        type: "action",
        key: "sync-run",
        label: "Sync now",
        button: "sync",
        visible: () => Boolean(sync?.isConfigured),
        act: () => run("sync.now"),
      },
    ],
  },
  {
    title: "Security",
    items: [
      {
        type: "info",
        key: "encryption",
        label: "Encryption",
        hint: "Per document, real age format. Unlock once per session.",
        value: () => {
          if (!keyring?.isSetUp) return "not set up";
          if (!keyring.isUnlocked) return "locked";
          // The two unlocked states are worth telling apart: with a CryptoKey
          // the device secret never enters the JS heap at all (§5).
          return keyring.identityKind === "cryptokey"
            ? "unlocked (CryptoKey)"
            : "unlocked (in memory)";
        },
      },
      {
        type: "info",
        key: "device-name",
        label: "This device",
        visible: () => Boolean(keyring?.isSetUp),
        value: () => keyring?.deviceName ?? "",
      },
      {
        type: "info",
        key: "device-key",
        label: "Device key",
        hint: "Public. Add it to another device to share encrypted documents.",
        visible: () => Boolean(keyring?.isSetUp),
        value: () => keyring?.deviceRecipient ?? "",
      },
      {
        type: "info",
        key: "recovery-key",
        label: "Recovery key",
        hint: "Public half of the offline master key. Every document is encrypted to it.",
        visible: () => Boolean(keyring?.isSetUp),
        value: () => (keyring?.recoveryRecipients ?? []).join(" "),
      },
      {
        type: "action",
        key: "crypto-setup",
        label: "Set up encryption",
        hint: "Generates a device key and a recovery key. The recovery key is shown once.",
        button: "set up",
        visible: () => !keyring?.isSetUp,
        act: () => run("crypto.setup"),
      },
      {
        type: "action",
        key: "crypto-unlock",
        label: "Unlock",
        hint: "Decrypts the device key into memory for this session.",
        button: "unlock",
        visible: () => Boolean(keyring?.isSetUp) && !keyring?.isUnlocked,
        act: () => run("crypto.unlock"),
      },
      {
        type: "action",
        key: "crypto-lock",
        label: "Lock",
        hint: "Drops the device key. Encrypted documents become unreadable until you unlock.",
        button: "lock",
        visible: () => Boolean(keyring?.isUnlocked),
        act: () => run("crypto.lock"),
      },
    ],
  },
  {
    title: "About",
    items: [
      { type: "note", text: "vrtti — scratchpad editor" },
      { type: "info", key: "build", label: "Build", value: () => BUILD.commit },
      {
        type: "info",
        key: "built-at",
        label: "Built",
        value: () => new Date(BUILD.builtAt).toLocaleString(),
      },
      {
        type: "note",
        text: "CodeMirror 6 — MIT.",
        links: [{ text: "codemirror.net", href: "https://codemirror.net/" }],
      },
      {
        type: "note",
        text: "Harper spellcheck engine — Apache-2.0.",
        links: [{ text: "writewithharper.com", href: "https://writewithharper.com/" }],
      },
      {
        // CC-BY 4.0 wants the credit where the work is used, so it lives in the
        // app and not only in VENDOR.md. Do not move it back into the docs.
        type: "note",
        text:
          "Twemoji graphics © Twitter / Jason Sofonia & contributors, CC-BY 4.0.",
        links: [
          { text: "github.com/jdecked/twemoji", href: "https://github.com/jdecked/twemoji" },
        ],
      },
    ],
  },
];

/**
 * @param {string} label
 * @param {string} [hint]
 */
function labelBlock(label, hint) {
  const wrap = document.createElement("div");
  wrap.className = "settings-label";
  const name = document.createElement("div");
  name.textContent = label;
  wrap.appendChild(name);
  if (hint) {
    const small = document.createElement("p");
    small.className = "settings-hint";
    small.textContent = hint;
    wrap.appendChild(small);
  }
  return wrap;
}

/**
 * Build one row and the function that repaints it. Everything that can change
 * (a toggle state, an async storage figure, a row's visibility) is read inside
 * `paint`, so one refresh() call brings the whole panel up to date.
 *
 * @param {Item} item
 * @param {() => void} refresh  Repaint the whole panel, for an action row.
 * @returns {{ el: HTMLElement, paint: () => void }}
 */
function makeRow(item, refresh) {
  const row = document.createElement("div");
  row.className = item.type === "note" ? "settings-note" : "settings-row";
  if (item.key) row.dataset.key = item.key;
  // A conditional row starts hidden and is only ever shown by the answer of
  // its own check. Hiding it again on each repaint would make it blink, and
  // the check is async, so the blink would be visible.
  if (item.visible) row.hidden = true;

  /** @type {() => void} */
  let paintOwn = () => {};

  if (item.type === "note") {
    row.textContent = item.text ?? "";
    for (const link of item.links ?? []) {
      row.append(" ");
      const anchor = document.createElement("a");
      anchor.href = link.href;
      anchor.textContent = link.text;
      // Leaving the app must never replace it, and noopener keeps the new tab
      // away from window.opener.
      anchor.target = "_blank";
      anchor.rel = "noopener";
      row.appendChild(anchor);
    }
  } else {
    row.appendChild(labelBlock(item.label ?? "", item.hint));
  }

  if (item.type === "toggle") {
    const button = document.createElement("button");
    button.className = "settings-toggle";
    button.type = "button";
    paintOwn = () => {
      const on = item.get ? item.get() : false;
      button.setAttribute("aria-pressed", String(on));
      button.textContent = on ? "on" : "off";
    };
    button.addEventListener("click", async () => {
      // Awaited: a flip that writes a setting resolves after the write, and
      // repainting before it lands would show the old state.
      if (item.set) await item.set();
      paintOwn();
    });
    row.appendChild(button);
  }

  if (item.type === "text") {
    const input = document.createElement("input");
    input.className = "settings-input";
    input.type = item.password ? "password" : "text";
    input.spellcheck = false;
    if (item.placeholder) input.placeholder = item.placeholder;

    // What was last written through this row. It makes the commit idempotent,
    // so Enter (which blurs) does not send the same value twice.
    let committed = "";
    paintOwn = () => {
      // Never while the user is typing in it: a repaint arrives from every
      // sync status event, and it would wipe a half-typed token.
      if (document.activeElement === input) return;
      committed = String((item.get ? item.get() : "") ?? "");
      input.value = committed;
    };

    async function commit() {
      if (!item.set || input.value === committed) return;
      committed = input.value;
      await item.set(committed);
      // The value changed what other rows report (the status, the visibility
      // of the sync actions), so the whole panel repaints.
      refresh();
    }

    input.addEventListener("keydown", (event) => {
      // The chord table listens on window, so Alt+W here would close a buffer
      // while the user is typing a URL.
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        input.blur(); // the blur listener commits
      }
    });
    input.addEventListener("blur", commit);
    row.appendChild(input);
  }

  if (item.type === "info" || (item.type === "action" && item.value)) {
    const value = document.createElement("span");
    value.className = "settings-value";
    paintOwn = () => {
      // A sync value renders at once; a promise fills the span when it lands.
      Promise.resolve(item.value ? item.value() : "").then((text) => {
        value.textContent = text;
      });
    };
    row.appendChild(value);
  }

  if (item.type === "action") {
    const button = document.createElement("button");
    button.className = "settings-button";
    button.type = "button";
    button.textContent = item.button ?? "run";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        // The click is the user gesture some of these APIs require, so the
        // command runs on this stack and not on a timer.
        if (item.act) await item.act();
      } finally {
        button.disabled = false;
        // The action changed what other rows report (a granted permission, a
        // new figure), so repaint the panel and not just this row.
        refresh();
      }
    });
    row.appendChild(button);
  }

  const paint = () => {
    paintOwn();
    if (!item.visible) return;
    Promise.resolve(item.visible()).then((show) => {
      row.hidden = !show;
    });
  };
  return { el: row, paint };
}

/**
 * Mount the settings overlay. Returns the controller the settings.toggle
 * command dispatches into.
 *
 * @param {{keyring?: import("../crypto/keyring.js").KeyRing,
 *          sync?: ReturnType<import("../sync/client.js").createSyncClient>}} [deps]
 */
export function mountSettings(deps = {}) {
  keyring = deps.keyring ?? null;
  sync = deps.sync ?? null;
  const panel = /** @type {HTMLElement} */ (document.getElementById("settings-panel"));

  const head = document.createElement("div");
  head.className = "settings-head";
  const title = document.createElement("h2");
  title.className = "settings-title";
  title.textContent = "Settings";
  head.appendChild(title);
  const closeButton = document.createElement("button");
  closeButton.className = "icon-button";
  closeButton.id = "settings-close";
  closeButton.type = "button";
  closeButton.textContent = "×";
  closeButton.title = "Close (Esc)";
  closeButton.addEventListener("click", () => close());
  head.appendChild(closeButton);

  /** @type {(() => void)[]} */
  const painters = [];

  // Hoisted on purpose: the rows below take it as their repaint hook.
  function refresh() {
    for (const paint of painters) paint();
  }

  /** @type {HTMLElement[]} */
  const children = [head];

  for (const section of SECTIONS) {
    const element = document.createElement("section");
    element.className = "settings-section";
    const heading = document.createElement("h3");
    heading.textContent = section.title;
    element.appendChild(heading);
    for (const item of section.items) {
      const { el, paint } = makeRow(item, refresh);
      painters.push(paint);
      element.appendChild(el);
    }
    children.push(element);
  }
  panel.replaceChildren(...children);

  // The statusbar spellcheck button stays clickable next to an open panel on a
  // PC, so the panel repaints whenever that state flips, whoever flipped it.
  spellEvents.addEventListener("change", () => {
    if (!panel.hidden) refresh();
  });

  // Unlock and lock are also reachable from outside the panel (a locked doc
  // asks on open), so the Security rows follow the keyring wherever it changed.
  keyring?.addEventListener("change", () => {
    if (!panel.hidden) refresh();
  });

  // A sync run is the one thing here that changes on its own, on a timer and
  // on the network. The status row would otherwise sit at whatever it said
  // when the panel opened.
  sync?.events.addEventListener("status", () => {
    if (!panel.hidden) refresh();
  });

  /** @type {Element | null} */
  let returnFocus = null;

  /** @param {KeyboardEvent} event */
  function onKeydown(event) {
    if (event.key !== "Escape") return;
    // A modal <dialog> (ui/dialog.js) owns Escape while it is open. This
    // capture listener would otherwise run first, close the panel behind the
    // prompt, and swallow the browser's own cancel of the dialog.
    if (document.querySelector("dialog[open]")) return;
    // Capture phase: CodeMirror binds Escape too, and this way the panel wins
    // wherever the focus happens to be.
    event.preventDefault();
    close();
  }

  function open() {
    refresh();
    panel.hidden = false;
    returnFocus = document.activeElement;
    // Focus moves off the editor, so typing cannot land in a document hidden
    // behind the panel, and Escape has somewhere to arrive.
    panel.focus();
    window.addEventListener("keydown", onKeydown, true);
  }

  function close() {
    if (panel.hidden) return;
    panel.hidden = true;
    window.removeEventListener("keydown", onKeydown, true);
    if (returnFocus instanceof HTMLElement) returnFocus.focus();
    returnFocus = null;
  }

  function toggle() {
    if (panel.hidden) open();
    else close();
  }

  return { open, close, toggle, isOpen: () => !panel.hidden };
}
