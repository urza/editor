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
import { EDITOR, editorFontSize, UI, uiScale } from "./textsize.js";
import { titleOf } from "../model/docs.js";

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

/**
 * The document store the Trash section lists (architecture.md §22).
 * @type {ReturnType<import("../model/docs.js").createDocStore> | null}
 */
let store = null;

/** Result of the last "Test connection" click, shown on that row. */
let testResult = "";

/**
 * One row. `type` picks the renderer; the other fields are per type.
 *
 * @typedef {Object} Item
 * @property {"toggle" | "text" | "info" | "action" | "note" | "stepper" | "list"} type
 * @property {string} [key]    Stable id. Becomes data-key, for tests and for
 *                             the future settings store.
 * @property {string} [label]  Left-hand text of a toggle, info or action row.
 * @property {string} [hint]   Small line under the label.
 * @property {() => any} [get]        toggle: the state. text: the value.
 * @property {(value?: any) => any} [set]  toggle: dispatch the flip. text:
 *                             dispatch the value the user typed.
 * @property {number} [min]           stepper: the lowest value.
 * @property {number} [max]           stepper: the highest value.
 * @property {number} [step]          stepper: what one press adds.
 * @property {string} [unit]          stepper: shown after the number.
 * @property {boolean} [password]     text: hide what is typed.
 * @property {string} [placeholder]   text: empty-field hint.
 * @property {() => string | Promise<string>} [value]    info (and action):
 *                             right-hand text.
 * @property {boolean} [block]        info: the value is a key or a code, so
 *                             it takes its own line in an inset block.
 * @property {() => boolean | Promise<boolean>} [visible] Hide the row when false.
 * @property {string} [button]                           action: button label.
 * @property {() => any} [act]                           action: dispatch the action.
 * @property {string} [text]                             note: one paragraph.
 * @property {() => ListRow[]} [rows]                    list: the rows, read on every paint.
 * @property {{ text: string, href: string }[]} [links]  note: external links.
 */

/**
 * One row of a `list` item: a label with a value line under it, and an
 * optional button. Read fresh on every paint, so a list follows its source.
 * @typedef {{ key: string, label: string, value: string, hint?: string,
 *            button?: string, act?: () => any }} ListRow
 */

/**
 * One section. `status` is the one state word the rail shows under the
 * section's name (the sync state, the lock state), read on every paint.
 * @typedef {{ title: string, items: Item[],
 *            status?: () => string | Promise<string> }} Section
 */

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

/** The sync state in one word. Same words as the statusbar, so the two never disagree. */
function syncStateWord() {
  if (!sync) return "off";
  const { state } = sync.status;
  return state === "idle" ? "synced" : state;
}

/** One line for the sync status row: state, why, and when it last worked. */
function syncStatusText() {
  if (!sync) return "off";
  const { message, lastSyncAt } = sync.status;
  let text = syncStateWord();
  if (message) text += " (" + message + ")";
  if (lastSyncAt) {
    text += " · last sync " + new Date(lastSyncAt).toLocaleTimeString();
  }
  return text;
}

/** @type {Section[]} */
const SECTIONS = [
  {
    title: "Appearance",
    items: [
      {
        type: "stepper",
        key: "editor-size",
        label: "Editor text size",
        hint:
          "The document only. It is a setting of this device, not of the " +
          "documents, so it never syncs.",
        unit: " px",
        min: EDITOR.min,
        max: EDITOR.max,
        step: EDITOR.step,
        get: () => editorFontSize(),
        set: (value) => run("view.editorFontSize", value),
      },
      {
        type: "stepper",
        key: "ui-size",
        label: "Interface text size",
        hint: "The sidebar, the status bar, the menus and this panel.",
        unit: " %",
        min: UI.min,
        max: UI.max,
        step: UI.step,
        get: () => uiScale(),
        set: (value) => run("view.uiScale", value),
      },
    ],
  },
  {
    title: "Editor",
    items: [
      {
        type: "toggle",
        key: "spellcheck",
        label: "Spellcheck (English and Czech)",
        hint:
          "Offline, per paragraph: Harper for English, Hunspell for Czech. " +
          "Spelling is underlined red, style hints blue.",
        get: () => isEnabled(),
        set: () => run("spell.toggle"),
      },
    ],
  },
  {
    title: "Storage",
    status: async () => ((await isPersisted()) ? "persistent" : "not persistent"),
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
    status: () => syncStateWord(),
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
    status: () => {
      if (!keyring?.isSetUp) return "not set up";
      return keyring.isUnlocked ? "unlocked" : "locked";
    },
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
        hint: "Public. Your other devices encrypt to it once they approve this device.",
        block: true,
        visible: () => Boolean(keyring?.isSetUp),
        value: () => keyring?.deviceRecipient ?? "",
      },
      {
        type: "info",
        key: "pairing-code",
        label: "Pairing code",
        hint: "Type it on a device that already uses this keyring to approve this one. The fingerprint next to it is what the other device shows you to confirm.",
        block: true,
        visible: () => Boolean(keyring?.isSetUp && keyring.pairingCode),
        value: () => keyring?.pairingCode + "   ·   fingerprint " + keyring?.fingerprint(),
      },
      {
        type: "list",
        key: "devices",
        label: "Devices",
        hint: "Every device in the keyring, and whether this device trusts it (architecture.md §21).",
        visible: () => Boolean(keyring?.isSetUp),
        rows: () =>
          (keyring?.deviceRows() ?? []).map((row) => {
            const when = new Date(row.addedAt).toLocaleDateString();
            const fp = row.fingerprint ? " · " + row.fingerprint : "";
            const base = { key: "device-" + row.id, label: row.name + fp, value: "" };
            switch (row.state) {
              case "this device":
                return { ...base, value: "this device · added " + when };
              case "trusted":
                return { ...base, value: "trusted · added " + when };
              case "approved you":
                return {
                  ...base,
                  value: "approved this device · confirm that it is yours",
                  button: "confirm",
                  act: () => run("crypto.confirm", row.id),
                };
              case "needs update":
                return { ...base, value: "needs its update · unlock it once, then approve it here" };
              case "not confirmed":
                return {
                  ...base,
                  value: "not confirmed · approve this device from it, then confirm it here",
                };
              default:
                return {
                  ...base,
                  value: "waiting for approval · type its pairing code",
                  button: "approve",
                  act: () => run("crypto.approve", row.id),
                };
            }
          }),
      },
      {
        type: "info",
        key: "recovery-key",
        label: "Recovery key",
        hint: "Public half of the offline master key. Every document is encrypted to it.",
        block: true,
        visible: () => Boolean(keyring?.isSetUp),
        value: () => (keyring?.recoveryRecipients ?? []).join(" "),
      },
      {
        type: "action",
        key: "crypto-setup",
        label: "Set up encryption",
        hint: "Generates a device key and a recovery key. The recovery key is shown once. On a second device, set the sync server first, so it joins the keyring your other devices use.",
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
    title: "Trash",
    status: () => {
      const count = store?.trashed().length ?? 0;
      return count === 1 ? "1 note" : count + " notes";
    },
    items: [
      {
        type: "list",
        key: "trash",
        label: "Deleted notes",
        hint: "A note a delete reached stays here for 30 days. Restore puts it back into Recent as a local note (architecture.md §22).",
        visible: () => (store?.trashed().length ?? 0) > 0,
        rows: () =>
          (store?.trashed() ?? []).map((record) => ({
            key: "trash-" + record.id,
            label: titleOf(record),
            value: "deleted " + new Date(record.trashedAt ?? 0).toLocaleString(),
            button: "restore",
            act: () => store?.restore(record.id),
          })),
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
  // A note is a row too (it gets the rule between rows), only laid out as prose.
  row.className = item.type === "note" ? "settings-row settings-note" : "settings-row";
  if (item.key) row.dataset.key = item.key;
  if (item.block) row.classList.add("settings-row-block");
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

  if (item.type === "stepper") {
    const min = item.min ?? 0;
    const max = item.max ?? 0;
    const step = item.step ?? 1;

    const group = document.createElement("div");
    group.className = "settings-stepper";

    const value = document.createElement("span");
    value.className = "settings-stepper-value";
    // The number is the only feedback a press gives, and it lives outside the
    // button that was pressed, so a screen reader needs to be told to read it.
    value.setAttribute("aria-live", "polite");

    /** @param {-1 | 1} direction @param {string} glyph */
    function stepButton(direction, glyph) {
      const button = document.createElement("button");
      button.className = "settings-button settings-stepper-button";
      button.type = "button";
      button.textContent = glyph;
      button.setAttribute(
        "aria-label",
        (item.label ?? "") + (direction < 0 ? ", smaller" : ", larger"),
      );
      button.addEventListener("click", async () => {
        const current = Number(item.get ? item.get() : 0);
        const next = Math.min(max, Math.max(min, current + direction * step));
        if (next === current) return;
        // Awaited for the same reason as the toggle: the paint below must see
        // the value the command settled on, not the one before it.
        if (item.set) await item.set(next);
        paintOwn();
      });
      return button;
    }

    // U+2212, not a hyphen: it has the same width as the "+" beside it.
    const down = stepButton(-1, "\u2212");
    const up = stepButton(1, "+");

    paintOwn = () => {
      const current = Number(item.get ? item.get() : 0);
      value.textContent = current + (item.unit ?? "");
      // Disabled rather than inert at the ends, so the control shows where the
      // range stops instead of swallowing the press.
      down.disabled = current <= min;
      up.disabled = current >= max;
    };

    group.append(down, value, up);
    row.appendChild(group);
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

  if (item.type === "list") {
    // The rows sit under the label, not beside it: a list is a column.
    row.classList.add("settings-row-list");
    const list = document.createElement("div");
    list.className = "settings-list";
    row.appendChild(list);
    paintOwn = () => {
      const rows = item.rows ? item.rows() : [];
      list.replaceChildren(
        ...rows.map((entry) => {
          const line = document.createElement("div");
          line.className = "settings-list-row";
          line.dataset.key = entry.key;
          const text = document.createElement("div");
          text.className = "settings-list-text";
          const label = document.createElement("div");
          label.textContent = entry.label;
          text.appendChild(label);
          const value = document.createElement("div");
          value.className = "settings-hint";
          value.textContent = entry.value;
          text.appendChild(value);
          line.appendChild(text);
          if (entry.button && entry.act) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "settings-button";
            button.textContent = entry.button;
            button.addEventListener("click", async () => {
              button.disabled = true;
              try {
                await entry.act?.();
              } finally {
                // The answer changed what the whole panel reports.
                refresh();
              }
            });
            line.appendChild(button);
          }
          return line;
        })
      );
    };
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
  store = deps.store ?? null;
  const panel = /** @type {HTMLElement} */ (document.getElementById("settings-panel"));

  // The head and the body share the .settings-page width, so the × and the
  // content line up on the same right edge.
  const head = document.createElement("div");
  head.className = "settings-head";
  const headRow = document.createElement("div");
  headRow.className = "settings-page settings-head-row";
  head.appendChild(headRow);
  const title = document.createElement("h2");
  title.className = "settings-title";
  title.textContent = "Settings";
  headRow.appendChild(title);
  const closeButton = document.createElement("button");
  closeButton.className = "icon-button";
  closeButton.id = "settings-close";
  closeButton.type = "button";
  closeButton.textContent = "×";
  closeButton.title = "Close (Esc)";
  closeButton.addEventListener("click", () => close());
  headRow.appendChild(closeButton);

  // The body is the app's own shape in small: a rail of sections on the
  // left, the document on the right. CSS folds the rail away when the panel
  // is narrow (a phone, a narrow editor pane).
  const body = document.createElement("div");
  body.className = "settings-page settings-body";
  const rail = document.createElement("nav");
  rail.className = "settings-rail";
  rail.setAttribute("aria-label", "Sections");
  const main = document.createElement("div");
  main.className = "settings-main";
  body.append(rail, main);

  /** @type {(() => void)[]} */
  const painters = [];
  /**
   * One per section: its element in the document, its button in the rail
   * and the state word under that button.
   * @type {{ section: Section, element: HTMLElement, item: HTMLButtonElement,
   *          status: HTMLElement }[]}
   */
  const entries = [];

  // Which section the reader is in: the last one that starts under the
  // sticky head. Once the panel is scrolled to its end, the last visible
  // section takes the mark, or a short About could never have it. A panel
  // that does not scroll at all marks the first.
  function markCurrent() {
    const shown = entries.filter((entry) => !entry.element.hidden);
    if (shown.length === 0) return;
    const top = panel.scrollTop + head.offsetHeight + 1;
    let current = shown[0];
    for (const entry of shown) {
      if (entry.element.offsetTop <= top) current = entry;
    }
    const scrolls = panel.scrollHeight > panel.clientHeight + 1;
    const atEnd = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 1;
    if (scrolls && atEnd) current = shown[shown.length - 1];
    for (const entry of entries) {
      if (entry === current) entry.item.setAttribute("aria-current", "true");
      else entry.item.removeAttribute("aria-current");
    }
  }

  let marking = false;
  panel.addEventListener(
    "scroll",
    () => {
      // One mark per frame; a scroll fires many times per frame.
      if (marking) return;
      marking = true;
      requestAnimationFrame(() => {
        marking = false;
        markCurrent();
      });
    },
    { passive: true },
  );

  // Hoisted on purpose: the rows below take it as their repaint hook.
  function refresh() {
    for (const paint of painters) paint();
    for (const entry of entries) {
      if (!entry.section.status) continue;
      Promise.resolve(entry.section.status()).then((text) => {
        entry.status.textContent = text;
      });
    }
    // A row's visible() answers in a microtask; the sections are judged
    // after that. A section whose rows are all hidden (the Trash while it
    // is empty, §22) hides with them, heading and rail entry included.
    setTimeout(() => {
      for (const entry of entries) {
        const rows = [...entry.element.children].filter((el) => el.tagName !== "H3");
        const hide = rows.length > 0 && rows.every((el) => el.hidden);
        entry.element.hidden = hide;
        entry.item.hidden = hide;
      }
      markCurrent();
    }, 0);
  }

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
    main.appendChild(element);

    const item = document.createElement("button");
    item.type = "button";
    item.className = "settings-rail-item";
    const status = document.createElement("span");
    status.className = "settings-rail-status";
    // The space keeps the name and the state word apart in the accessible
    // name; the state is a block of its own on screen.
    item.append(section.title, " ", status);
    item.addEventListener("click", () => {
      // The panel's scroll-padding-top keeps it out from under the head.
      element.scrollIntoView({ block: "start" });
    });
    rail.appendChild(item);
    entries.push({ section, element, item, status });
  }
  panel.replaceChildren(head, body);

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

  // A tombstone can trash a note while the panel is open; the Trash rows
  // follow the store (architecture.md §22).
  store?.events.addEventListener("change", () => {
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
