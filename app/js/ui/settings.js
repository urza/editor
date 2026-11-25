// @ts-check
// Settings panel (architecture.md §9). A plain DOM overlay over the editor:
// no modal library, no routing. Escape, the × button, and the command that
// opened it all close it.
//
// The content is a declarative list of sections and items. A new setting is a
// new entry in SECTIONS, never new render code, and an item never writes state
// itself: it dispatches a command and the panel repaints from the state that
// results.

import { run } from "../commands/registry.js";
import { events as spellEvents, isEnabled, isPlainOn, setPlainOn } from "../editor/spellcheck.js";
import { activeLangs } from "../editor/mixed.js";
import { modelFixesCzechParagraphs, setModelFixesCzechParagraphs } from "../editor/adddiacritics.js";
import { hasDisk, isPersisted, storageEstimate } from "../model/capabilities.js";
import { BUILD } from "../version.js";
import { EDITOR, editorFontSize, UI, uiScale } from "./textsize.js";
import { sidebarNewButtonShown } from "./newbutton.js";
import { listRowsLong } from "./sidebar.js";
import { phoneMode, watchBack } from "./shell.js";
import { SYNC_LABEL } from "./statusbar.js";
import { buildSpellPage } from "./spellpage.js";
import { changedCount, wordList } from "../model/spellsettings.js";

/**
 * The keyring the Security and Devices sections report on, handed in by mountSettings.
 *
 * A module-level reference rather than a parameter threaded through every row:
 * SECTIONS is a static list built at module load, which is what keeps a new
 * setting a data change and not a render change. The rows below read this when
 * they paint, so it is always set by then.
 * @type {import("../crypto/keyring.js").KeyRing | null}
 */
let keyring = null;

/**
 * The sync client the Sync, Spaces, and Devices sections report on. Same reason
 * as `keyring` above.
 * @type {ReturnType<import("../sync/client.js").createSyncClient> | null}
 */
let sync = null;

/**
 * The document store the Editor language rows read from (architecture.md §22).
 * @type {ReturnType<import("../model/docs.js").createDocStore> | null}
 */
let store = null;

/** Result of the last "Test connection" click, shown on the Sync status row. */
let testResult = "";

/**
 * Opens the Spellcheck page inside the panel. Set by mountSettings: the rows
 * below are declared before the panel exists.
 * @type {() => void}
 */
let openSpellPage = () => {};

/** The right-hand text of the row that opens the Spellcheck page. */
function spellSummary() {
  if (!store) return "";
  const settings = store.sharedSettings();
  const rules = changedCount(settings);
  const words = wordList(settings).length;
  // No "823 rules" here on purpose: the total comes from Harper, and this row
  // must not load a 15 MB wasm file each time Settings opens.
  return `${rules} ${rules === 1 ? "rule" : "rules"} changed. ${words} ${words === 1 ? "word" : "words"}.`;
}

/**
 * One action button on an `action` row. `actions` lets a row carry two related
 * buttons side by side (e.g. "sync now" and "test" beside the sync status)
 * without splitting one concern across separate rows.
 * @typedef {{ key?: string, button: string, danger?: boolean,
 *             visible?: () => boolean,
 *             act: (repaint: () => void) => any }} ActionButton
 */

/**
 * One key/code block inside a collapsible `details` row (Security › Keys).
 * @typedef {{ key: string, label: string, hint?: string, value: string }} DetailBlock
 */

/**
 * One row. `type` picks the renderer; the other fields are per type.
 *
 * @typedef {Object} Item
 * @property {"toggle" | "text" | "info" | "action" | "note" | "stepper" | "select" | "list" | "grid" | "details" | "subhead"} type
 * @property {string} [key]    Stable id. Becomes data-key, for tests and for
 *                             the future settings store.
 * @property {string} [label]  Left-hand text of a row (or heading text of a subhead).
 * @property {string} [hint]   Short line under the label (1-2 lines on a phone).
 * @property {string} [more]   Optional extra explanation hidden behind an inline (i) button.
 * @property {() => any} [get]        toggle: the state. text/select: the value.
 * @property {(value?: any) => any} [set]  toggle: dispatch the flip. text/select:
 *                             dispatch the new value.
 * @property {() => { value: string, label: string }[]} [options] select: the choices,
 *                             read fresh on every paint so the list tracks spaces.
 * @property {number} [min]           stepper: the lowest value.
 * @property {number} [max]           stepper: the highest value.
 * @property {number} [step]          stepper: what one press adds.
 * @property {string} [unit]          stepper: shown after the number.
 * @property {boolean} [password]     text: hide what is typed.
 * @property {string} [placeholder]   text: empty-field hint.
 * @property {string} [invalid]       text: shown under the hint when `set`
 *                             answers false, so a refused value says why.
 * @property {() => string | Promise<string>} [value]    info (and action):
 *                             right-hand text.
 * @property {boolean} [block]        info: the value is a key or a code, so
 *                             it takes its own line in an inset block.
 * @property {() => boolean | Promise<boolean>} [visible] Hide the row when false.
 * @property {string} [button]                           action: single button label.
 * @property {boolean} [danger]                          action: danger styling and top rule.
 * @property {(repaint: () => void) => any} [act]        action: single button dispatch.
 *                             An action that reports progress calls `repaint`
 *                             at each step.
 * @property {ActionButton[]} [actions]                  action: multiple inline buttons.
 * @property {string} [text]                             note: one paragraph.
 * @property {boolean} [callout]                         note: highlighted notice banner.
 * @property {boolean} [compact]                         note: tight credit line with no divider.
 * @property {{ key?: string, button: string, act: () => any }} [headerAction]
 *                             list: optional button beside the list's label (e.g. "+ new space").
 * @property {string | (() => string)} [empty]           list: shown when `rows()` is empty.
 * @property {(repaint: () => void) => ListRow[]} [rows] list: the rows, read
 *                             on every paint. A list whose source is fetched
 *                             calls `repaint` when the answer lands.
 * @property {{ text: string, href: string }[]} [links]  note: external links.
 * @property {() => Grid} [grid]  grid: the table, read on every paint.
 * @property {() => string} [gridNote]  grid: a line below the table, "" for none.
 * @property {() => DetailBlock[]} [blocks]              details: blocks inside the disclosure.
 */

/**
 * A table of ticks: Settings › Devices (architecture.md §27). Each cell and
 * each column head dispatches through its `act`, like any other row.
 * @typedef {{ columns: { key: string, label: string, color?: string, title?: string, act?: () => any }[],
 *            rows: { key: string, label: string, me?: boolean,
 *                    cells: { checked: boolean, label: string, act: () => any }[] }[] }} Grid
 */

/**
 * One row of a `list` item: a label with a value line under it, an optional
 * clickable color swatch, and an optional select and/or button. Read fresh on
 * every paint, so a list follows its source.
 * @typedef {{ key: string, label: string, value: string, hint?: string, color?: string,
 *            swatchTitle?: string, swatchAct?: () => any,
 *            button?: string, buttonTitle?: string, act?: () => any,
 *            select?: { value: string, options: { value: string, label: string }[],
 *                       set: (value: string) => Promise<unknown> | unknown } }} ListRow
 */

/**
 * One section. `group` inserts a quiet divider in the left rail whenever two
 * adjacent visible sections belong to different groups. `status` is the one
 * state line the rail shows under the section's name, read on every paint.
 * @typedef {{ title: string, group?: string, items: Item[],
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

/**
 * What the update check says at the moment, or null while it is silent
 * (the "App" section below).
 * @type {string | null}
 */
let updateStatus = null;

/** The sync state as the status bar says it, from one table, so the two never disagree. */
function syncStateWord() {
  if (!sync) return SYNC_LABEL.off;
  const { state } = sync.status;
  return SYNC_LABEL[state] ?? state;
}

/** One line for the sync status row: state, why, last sync time, and any test result. */
function syncStatusText() {
  if (!sync) return SYNC_LABEL.off;
  const { message, lastSyncAt } = sync.status;
  let text = syncStateWord();
  if (message) text += " (" + message + ")";
  if (lastSyncAt) {
    text += " · last sync " + new Date(lastSyncAt).toLocaleTimeString();
  }
  if (testResult) {
    text += " · test: " + testResult;
  }
  return text;
}

/** The two modes of a space (§25, §27), in the order the select offers them. */
const SPACE_MODES = [
  { value: "list", label: "Titles only" },
  { value: "tab", label: "Open as tabs" },
];

/**
 * The unified Spaces list: each space appears once with its clickable color
 * swatch, note count, open mode on this device, and (where disk access exists)
 * its folder backup button. Removing this device from a space stays in
 * Settings › Devices, beside all other membership ticks.
 * @returns {ListRow[]}
 */
function spaceRows() {
  if (!sync) return [];
  const client = sync;
  return client.listSpaces().map(({ space, count }) => ({
    key: "space-" + space,
    label: space,
    color: client.colorOf(space),
    swatchTitle: "Change the color of " + space,
    swatchAct: () => run("space.color", space),
    value: count === 1 ? "1 note" : count + " notes",
    select: {
      value: client.modeOf(space) ?? "tab",
      options: SPACE_MODES,
      set: (value) => run("sync.spaceMode", { space, mode: value }),
    },
    ...(hasDisk
      ? {
          button: "back up",
          buttonTitle:
            "Writes each note of this space into a folder you pick, as plain text or as .age files.",
          act: () => run("space.backup", space),
        }
      : {}),
  }));
}

// The texts of the "New notes" guidance (§27), in Settings › Spaces and in the
// one-time dialog of buffer.new (main.js).
const GUIDANCE_NO_SPACE =
  "Notes on this device exist only in this browser. Clearing the site data or losing the device deletes them. " +
  "To keep a copy on your sync server, make a space in Settings › Spaces.";
const GUIDANCE_LOCAL =
  "New notes stay only in this browser until you sync them from the note menu. To sync every new note, " +
  "pick a space here.";

/**
 * The guidance for "New notes", or "" when there is none (§27). Only on a
 * device with no disk (a phone, a browser with no File System Access API),
 * where the browser storage is the only copy of a local note, and only while
 * new notes are Local only. It informs and does not push: Local only with a
 * space is a valid choice.
 * @param {ReturnType<typeof import("../sync/client.js").createSyncClient> | null | undefined} client
 */
export function newNotesGuidance(client) {
  // Not while a join waits: its spaces are on their way, and "make a space"
  // would be the wrong advice.
  if (hasDisk || !client?.isConfigured || client.isJoining || client.defaultSpace()) return "";
  return client.mySpaces().length ? GUIDANCE_LOCAL : GUIDANCE_NO_SPACE;
}

// The answer to the last click in the grid of Settings › Devices. A tick in
// an empty cell changes nothing that this device can show: the other device
// gets the space at its own next sync. This line says so. It lasts until the
// next click or until the panel closes.
let gridNote = "";

/**
 * The text of a device that waits for the member that made its invite (§27).
 * It stands where an empty list would tell the person to make a space: the
 * spaces of this device are on their way.
 */
const JOIN_WAITS =
  "This device waits for your other device to let it in. Keep vrtti open and unlocked there. " +
  "The spaces show here after that.";

/**
 * The grid of Settings › Devices (§27): this device's spaces as columns, the
 * devices their logs name as rows, a tick where a device is a member. A
 * click adds or removes; the last member of a space cannot leave it.
 * @returns {Grid}
 */
function deviceGrid() {
  if (!sync) return { columns: [], rows: [] };
  const grid = sync.grid();
  return {
    columns: grid.spaces.map((space) => ({
      key: space.name,
      label: space.name,
      color: space.color,
      title: "Change the color of " + space.name,
      act: () => run("space.color", space.name),
    })),
    rows: grid.devices.map((device) => ({
      key: device.id,
      label: device.name,
      me: device.me,
      cells: grid.spaces.map((space) => {
        const member = grid.isMember(space.name, device.key);
        return {
          checked: member,
          label: (member ? "Remove " : "Add ") + device.name + (member ? " from " : " to ") + space.name,
          act: async () => {
            gridNote = "";
            const done = await run(member ? "space.remove" : "space.add", {
              space: space.name,
              key: device.key,
              name: device.name,
              me: device.me,
            });
            // Not for this device: its own column goes away, which says it.
            if (done && !device.me) {
              gridNote = member
                ? device.name + " gets no more notes of “" + space.name + "”."
                : device.name + " gets “" + space.name + "” at its next sync.";
            }
            return done;
          },
        };
      }),
    })),
  };
}

/** @type {Section[]} */
const SECTIONS = [
  {
    title: "Appearance",
    group: "editor",
    items: [
      {
        type: "stepper",
        key: "editor-size",
        label: "Editor text size",
        hint: "Note text only. This device.",
        more: "Does not sync to other devices. Ctrl+wheel over a note zooms that note alone on this device.",
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
        hint: "Sidebar, status bar, menus.",
        unit: " %",
        min: UI.min,
        max: UI.max,
        step: UI.step,
        get: () => uiScale(),
        set: (value) => run("view.uiScale", value),
      },
      {
        type: "toggle",
        key: "sidebar-new",
        label: "The + button in the sidebar",
        hint: "This device only.",
        more: "A phone also has the round + over the editor, so this button can be hidden.",
        get: () => sidebarNewButtonShown(),
        set: () => run("view.sidebarNewButton"),
      },
      // The phone note list (architecture.md §9, Phone mode). app.css shows
      // this row in phone mode only, and hides the one above there: the
      // sidebar "+" is not on screen in that layout. In CSS, not with a
      // `hidden` here, because the mode can change while the panel is open.
      {
        type: "toggle",
        key: "list-rows",
        label: "Longer rows in the note list",
        hint: "Two preview lines per note.",
        more: "Shows two lines of each note's text in place of one. Stays on this device.",
        get: () => listRowsLong(),
        set: () => run("view.listRows"),
      },
    ],
  },
  {
    title: "Editor",
    group: "editor",
    items: [
      {
        type: "toggle",
        key: "spellcheck",
        label: "Spellcheck (English and Czech)",
        hint: "Offline. This device only.",
        more:
          "Marks a word only when each active language of the note rejects it: " +
          "red for typos, blue for missing Czech diacritics and style hints.",
        get: () => isEnabled(),
        set: () => run("spell.toggle"),
      },
      // The 823 rules of the English checker and the user's own words have a
      // page of their own (ui/spellpage.js), so Settings stays one screen.
      {
        type: "action",
        key: "spell-page",
        label: "Spellcheck rules and words",
        hint: "Rules of the English checker, and your own words.",
        more:
          "Turn single rules on or off, and keep a list of words that neither language marks. " +
          "With sync set up, these settings go to all your devices.",
        value: () => spellSummary(),
        button: "open",
        act: () => openSpellPage(),
      },
      // The app's own blue mark, not a Harper rule, so it is a switch here
      // and not a row of the Spellcheck page (user decision, 2026-11-24).
      {
        type: "toggle",
        key: "spell-plain",
        label: "Mark Czech without diacritics",
        hint: "A blue mark on words such as “dekuji”. This device only.",
        more:
          "The mark shows on a word that becomes a Czech word when you add diacritics. " +
          "Off: such a word gets no mark.",
        get: () => isPlainOn(),
        set: () => setPlainOn(!isPlainOn()),
      },
      // The languages of the open note. Phone mode only (app.css): a PC has
      // the two buttons in the status bar, and the phone has no status bar.
      {
        type: "toggle",
        key: "spell-cs",
        label: "Czech in this note",
        visible: () => Boolean(store?.activeId),
        hint: "Syncs with this note.",
        get: () => noteLangOn("cs"),
        set: () => run("spell.lang", "cs"),
      },
      {
        type: "toggle",
        key: "spell-en",
        label: "English in this note",
        visible: () => Boolean(store?.activeId),
        hint: "Syncs with this note.",
        get: () => noteLangOn("en"),
        set: () => run("spell.lang", "en"),
      },
      // Only where "Add diacritics (vllm)" exists: the sync server has a model.
      // Asked again on each paint, so opening Settings is the way to see if
      // vLLM came up; the server checks vLLM live, at most every 30 seconds.
      // The menu entry stays when the model does not answer: vLLM can start
      // after the app, and a hidden entry would need a reload to come back.
      {
        type: "subhead",
        key: "model-heading",
        label: "Diacritics model (server)",
        visible: () => Boolean(sync?.hasModel),
      },
      {
        type: "info",
        key: "model-state",
        label: "Model",
        hint: "Server model for Add diacritics.",
        more: "The sync server checks vLLM live when you open Settings (at most every 30 seconds).",
        visible: () => Boolean(sync?.hasModel),
        value: async () => {
          await sync?.probeModel();
          const m = sync?.modelState;
          // A server from before the check sends no state.
          if (!m) return sync?.hasModel ? "set" : "not set";
          if (m.state === "answers") return `${m.name}, answers`;
          if (m.state === "name not served") return `vLLM answers, but does not serve “${m.name}”`;
          return `not answering${m.why ? ` (${m.why})` : ""}`;
        },
      },
      {
        type: "toggle",
        key: "model-czech",
        label: "Fix English-looking words in Czech",
        hint: "For Add diacritics. This device.",
        more:
          "Short Czech words such as az, tim, or mit look English to the checker. " +
          "When on, the model may write až, tím, or mít in a Czech paragraph, and it may also change a real English word there.",
        visible: () => Boolean(sync?.hasModel),
        get: () => modelFixesCzechParagraphs(),
        set: () => setModelFixesCzechParagraphs(!modelFixesCzechParagraphs()),
      },
    ],
  },
  {
    title: "Sync",
    group: "sync",
    status: () => syncStateWord(),
    items: [
      {
        type: "info",
        key: "sync-url",
        label: "Server",
        hint: "Without one, notes stay local.",
        value: () => (sync?.isConfigured || sync?.needsUpgrade ? sync.config.url : "none"),
      },
      {
        type: "action",
        key: "sync-connect",
        label: "Sync with a server",
        hint: "Use an invite, or a server token.",
        more:
          "A new device pastes the invite, or types the code, that “invite a device” in Settings › Devices " +
          "shows on a device that syncs. Only the first device of a server types the server URL and the VRTTI_TOKEN.",
        button: "connect",
        // Shown before device setup too: a new device looks for sync here, not
        // in Settings › Security. The connect flow makes the keys when the
        // device has none (main.js connectDevice).
        visible: () => !sync?.isConfigured,
        act: () => run("device.connect"),
      },
      {
        type: "action",
        key: "sync-status",
        label: "Status",
        hint: "Syncs after edits and every minute.",
        visible: () => Boolean(sync?.isConfigured || sync?.needsUpgrade),
        value: () => syncStatusText(),
        actions: [
          {
            key: "sync-run",
            button: "sync now",
            visible: () => Boolean(sync?.isConfigured),
            act: () => {
              testResult = "";
              return run("sync.now");
            },
          },
          {
            key: "sync-test",
            button: "test",
            visible: () => Boolean(sync?.isConfigured),
            act: async (repaint) => {
              testResult = "…";
              repaint();
              const result = await (sync?.testConnection() ?? { ok: false });
              testResult = result.ok ? "connected" : result.message ?? "failed";
            },
          },
        ],
      },
      {
        type: "action",
        key: "sync-disconnect",
        label: "Stop syncing this device",
        hint: "Forgets the server. Notes stay here.",
        button: "stop",
        danger: true,
        visible: () => Boolean(sync?.isConfigured || sync?.needsUpgrade),
        act: () => run("sync.disconnect"),
      },
    ],
  },
  {
    title: "Spaces",
    group: "sync",
    status: () => {
      const count = sync?.mySpaces().length ?? 0;
      return count === 1 ? "1 space" : count + " spaces";
    },
    items: [
      {
        type: "list",
        key: "sync-spaces",
        label: "Your spaces",
        hint: hasDisk ? "Click a color square to change it." : "Tap a color square to change it.",
        more: hasDisk
          ? "Choose whether each space opens notes as tabs or lists titles only. Back up writes every note of a space into a folder as plain text or .age files."
          : "Choose whether each space opens notes as tabs or lists titles only. To leave a space, untick this device in Settings › Devices.",
        headerAction: {
          key: "space-create",
          button: "+ new space",
          act: () => run("space.create"),
        },
        empty: () => (sync?.isJoining ? JOIN_WAITS : "No spaces yet. Create one to sync notes."),
        visible: () => Boolean(sync?.isConfigured),
        rows: spaceRows,
      },
      {
        type: "select",
        key: "sync-new-notes",
        label: "New notes",
        hint: "Default space for new notes.",
        more:
          "Pick one of your spaces or Local only. With Local only, sync a note from its menu. " +
          "Only you change this setting; creating a space does not.",
        visible: () => Boolean(sync?.isConfigured),
        get: () => sync?.defaultSpace() ?? "",
        options: () => [
          { value: "", label: "Local only" },
          ...(sync?.mySpaces() ?? []).map((space) => ({ value: space, label: space })),
        ],
        set: (value) => run("sync.newNotes", value || null),
      },
      // The guidance of a device with no disk (§27): two rows, one for each
      // text, because a note row paints its text once.
      {
        type: "note",
        key: "sync-guidance-no-space",
        callout: true,
        text: GUIDANCE_NO_SPACE,
        visible: () => newNotesGuidance(sync) === GUIDANCE_NO_SPACE,
      },
      {
        type: "note",
        key: "sync-guidance-local",
        callout: true,
        text: GUIDANCE_LOCAL,
        visible: () => newNotesGuidance(sync) === GUIDANCE_LOCAL,
      },
      {
        type: "action",
        key: "sync-all",
        label: "Sync every open note",
        hint: "Syncs local notes in Open.",
        more:
          "Turns on sync for each note in this window's Open list, into the New notes space " +
          "(or a space you pick when set to Local only). Notes in Recent and files stay as they are.",
        button: "sync all",
        visible: () => Boolean(sync?.isConfigured && sync.mySpaces().length),
        act: () => run("sync.all"),
      },
    ],
  },
  {
    title: "Devices",
    group: "sync",
    status: () => {
      const count = sync?.grid().devices.length ?? 0;
      if (count > 0) return count === 1 ? "1 device" : count + " devices";
      return keyring?.deviceName ?? "";
    },
    items: [
      {
        type: "action",
        key: "device-name",
        label: "This device",
        hint: "Name shown on other devices.",
        more:
          "“invite a device” makes an invite for a new device: a text to paste there, and a code to type. " +
          "The new device joins this server and gets the spaces you tick.",
        visible: () => Boolean(sync?.isConfigured),
        value: () => keyring?.deviceName ?? "",
        actions: [
          {
            // Available even with no space: the new device joins the server,
            // and the grid adds it once this device has a space.
            key: "device-invite",
            button: "invite a device",
            act: () => run("device.invite"),
          },
        ],
      },
      {
        type: "note",
        key: "sync-directory-missing",
        callout: true,
        text:
          "Update the sync server. Without a device directory, devices appear here only when they share a space.",
        visible: () => Boolean(sync?.isConfigured && sync.directoryMissing),
      },
      {
        type: "grid",
        key: "device-grid",
        label: "Space access",
        hint: "Ticked devices receive and decrypt notes.",
        more: "Untick a device to remove it, or untick this device to leave a space. Click a space name to change its color.",
        visible: () => Boolean(sync?.isConfigured && sync.mySpaces().length),
        grid: deviceGrid,
        gridNote: () => gridNote,
      },
      // Two rows, one for each text, because a note row paints its text once.
      {
        type: "note",
        key: "device-no-spaces",
        text: "Create a space in Spaces above to share notes.",
        visible: () => Boolean(sync?.isConfigured && !sync.mySpaces().length && !sync.isJoining),
      },
      {
        type: "note",
        key: "device-joining",
        text: JOIN_WAITS,
        visible: () => Boolean(sync?.isConfigured && !sync.mySpaces().length && sync.isJoining),
      },
    ],
  },
  {
    title: "Security",
    group: "sync",
    status: () => {
      if (!keyring?.isSetUp) return "not set up";
      if (!keyring.isUnlocked) return "locked";
      return keyring.askPassphrase ? "passphrase on" : "no passphrase";
    },
    items: [
      {
        type: "action",
        key: "device-setup",
        label: "Set up this device",
        hint: "Creates a name and keys.",
        more: "Your first device also creates a recovery key. Every other device joins with an invite.",
        button: "set up",
        visible: () => !keyring?.isSetUp,
        act: () => run("device.setup"),
      },
      {
        // Shown only while not syncing: Devices hides when offline, so a user
        // who set up keys for local file encryption still sees this device's name here.
        type: "info",
        key: "security-device-name",
        label: "This device",
        hint: "Name stored with this key.",
        visible: () => Boolean(keyring?.isSetUp && !sync?.isConfigured),
        value: () => keyring?.deviceName ?? "",
      },
      {
        type: "action",
        key: "passphrase-switch",
        label: "Ask for a passphrase at start",
        hint: "Prompt for a passphrase on open.",
        more:
          "Off: keeps its key and opens notes at once. On: asks for the passphrase at each start. " +
          "Changing this gives this device new keys.",
        button: "change",
        visible: () => Boolean(keyring?.isSetUp && keyring.isUnlocked),
        value: () => (keyring?.askPassphrase ? "on" : "off"),
        act: () => run("device.passphraseSwitch"),
      },
      {
        type: "action",
        key: "crypto-unlock",
        label: "Unlock",
        hint: "Open encrypted notes.",
        more: "Asks for your passphrase. Notes stay open until you press Lock or close the last window.",
        button: "unlock",
        visible: () => Boolean(keyring?.isSetUp) && !keyring?.isUnlocked,
        act: () => run("crypto.unlock"),
      },
      {
        type: "action",
        key: "crypto-lock",
        label: "Lock",
        hint: "Close encrypted notes.",
        more: "Encrypted notes stay closed until you unlock again. Undo history for those notes is dropped.",
        button: "lock",
        visible: () => Boolean(keyring?.isUnlocked && keyring.askPassphrase),
        act: () => run("crypto.lock"),
      },
      {
        type: "details",
        key: "security-keys",
        label: "Device and recovery keys",
        hint: "Public age keys. Not a secret.",
        visible: () => Boolean(keyring?.isSetUp || keyring?.recoveryRecipients.length),
        blocks: () => {
          /** @type {DetailBlock[]} */
          const list = [];
          if (keyring?.isSetUp && keyring.deviceRecipient) {
            list.push({
              key: "device-key",
              label: "Device key",
              hint: "Public key for this device.",
              value: keyring.deviceRecipient,
            });
          }
          if (keyring?.recoveryRecipients.length) {
            list.push({
              key: "recovery-key",
              label: "Recovery key (public)",
              hint: "Opens every synced note offline with age.",
              value: keyring.recoveryRecipients.join(" "),
            });
          }
          return list;
        },
      },
    ],
  },
  {
    // Deleted notes moved to the sidebar Trash drawer (§28).
    title: "Storage",
    group: "system",
    status: async () => ((await isPersisted()) ? "persistent" : "not persistent"),
    items: [
      {
        type: "info",
        key: "persisted",
        label: "Persistent storage",
        hint: "Prevents automatic browser cleanup.",
        more: "Without persistent storage, the browser may delete your notes when disk space runs low.",
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
        hint: "Ask the browser to keep data.",
        more: "Chrome grants it silently to an installed app; other browsers ask.",
        button: "request",
        // Pointless once the grant exists, so the row disappears with it.
        visible: async () => !(await isPersisted()),
        act: () => run("storage.persist"),
      },
    ],
  },
  {
    // The build, update check, log, and credits sit together here rather than
    // only in the status bar: phone mode has no status bar (app.css), so this
    // is the one place a phone can ask for a new build.
    title: "App",
    group: "system",
    status: () => BUILD.commit,
    items: [
      {
        type: "action",
        key: "update",
        label: "Version",
        hint: "Built " + new Date(BUILD.builtAt).toLocaleString(),
        more: "Checks for a newer build. If one exists, the app loads it and starts again.",
        value: () => updateStatus ?? BUILD.commit,
        button: "check",
        // The check reports in steps ("checking…", then the result, then
        // null a few seconds later), so each step repaints the row.
        act: (repaint) =>
          run("app.update", (/** @type {string | null} */ msg) => {
            updateStatus = msg;
            repaint();
          }),
      },
      {
        // Here, beside the build: a report of a problem needs both.
        type: "action",
        key: "log",
        label: "Log",
        hint: "Recent events and errors.",
        more: "Open and copy the log when reporting a problem.",
        button: "show",
        act: () => run("app.log"),
      },
      { type: "note", compact: true, key: "credit-vrtti", text: "vrtti — scratchpad editor" },
      {
        type: "note",
        compact: true,
        text: "CodeMirror 6 — MIT.",
        links: [{ text: "codemirror.net", href: "https://codemirror.net/" }],
      },
      {
        type: "note",
        compact: true,
        text: "Harper spellcheck engine — Apache-2.0.",
        links: [{ text: "writewithharper.com", href: "https://writewithharper.com/" }],
      },
      {
        // CC-BY 4.0 wants the credit where the work is used, so it lives in the
        // app and always stays visible (never inside a collapsed block). Do not
        // move it back into the docs.
        type: "note",
        compact: true,
        text: "Twemoji graphics © Twitter / Jason Sofonia & contributors, CC-BY 4.0.",
        links: [{ text: "github.com/jdecked/twemoji", href: "https://github.com/jdecked/twemoji" }],
      },
    ],
  },
];

/**
 * Build the label column for a settings row. A short `hint` stays visible in
 * one or two lines; optional longer `more` text hides behind an inline "i"
 * button so normal scanning stays compact on phones.
 * @param {string} label
 * @param {string} [hint]
 * @param {string} [more]
 */
function labelBlock(label, hint, more) {
  const wrap = document.createElement("div");
  wrap.className = "settings-label";
  const nameRow = document.createElement("div");
  nameRow.className = "settings-label-row";
  const name = document.createElement("span");
  name.textContent = label;
  nameRow.appendChild(name);
  wrap.appendChild(nameRow);
  if (hint) {
    const small = document.createElement("p");
    small.className = "settings-hint";
    small.textContent = hint;
    wrap.appendChild(small);
  }
  if (more) {
    const infoBtn = document.createElement("button");
    infoBtn.type = "button";
    infoBtn.className = "settings-info-btn";
    infoBtn.textContent = "i";
    infoBtn.title = "More info";
    infoBtn.setAttribute("aria-label", "More about " + label);
    infoBtn.setAttribute("aria-expanded", "false");

    const moreEl = document.createElement("p");
    moreEl.className = "settings-more";
    moreEl.textContent = more;
    moreEl.hidden = true;

    infoBtn.addEventListener("click", (event) => {
      // Stop propagation so an info button inside a <summary> or interactive
      // wrapper toggles only its own disclosure.
      event.stopPropagation();
      event.preventDefault();
      const open = moreEl.hidden;
      moreEl.hidden = !open;
      infoBtn.setAttribute("aria-expanded", String(open));
    });
    nameRow.appendChild(infoBtn);
    wrap.appendChild(moreEl);
  }
  return wrap;
}

/**
 * Build one action button that disables itself while its command runs and
 * repaints the whole panel afterward.
 * @param {ActionButton} spec
 * @param {() => void} refresh
 */
function makeActionButton(spec, refresh) {
  const button = document.createElement("button");
  button.className = spec.danger ? "settings-button settings-button-danger" : "settings-button";
  button.type = "button";
  button.textContent = spec.button;
  if (spec.key) button.dataset.key = spec.key;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      // The click is the user gesture some of these APIs require, so the
      // command runs on this stack and not on a timer.
      await spec.act(refresh);
    } finally {
      button.disabled = false;
      // The action changed what other rows report (a granted permission, a
      // new figure), so repaint the panel and not just this row.
      refresh();
    }
  });
  return button;
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
  if (item.type === "subhead") {
    const sub = document.createElement("div");
    sub.className = "settings-subhead";
    sub.textContent = item.label ?? "";
    if (item.key) sub.dataset.key = item.key;
    if (item.visible) sub.hidden = true;
    const paint = () => {
      if (!item.visible) return;
      Promise.resolve(item.visible()).then((show) => {
        sub.hidden = !show;
      });
    };
    return { el: sub, paint };
  }

  const row = document.createElement("div");
  // A note is a row too (it gets the rule between rows), only laid out as prose.
  row.className = item.type === "note" ? "settings-row settings-note" : "settings-row";
  if (item.key) row.dataset.key = item.key;
  if (item.block) row.classList.add("settings-row-block");
  if (item.danger) row.classList.add("settings-row-danger");
  if (item.callout) row.classList.add("settings-callout");
  if (item.compact) row.classList.add("settings-note-compact");
  // A conditional row starts hidden and is only ever shown by the answer of
  // its own check. Hiding it again on each repaint would make it blink, and
  // the check is async, so the blink would be visible.
  if (item.visible) row.hidden = true;

  /** @type {() => void} */
  let paintOwn = () => {};
  /** @type {HTMLElement | null} The label and hint column; a text row adds its error line to it. */
  let labels = null;

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
  } else if (item.type !== "details" && !(item.type === "list" && item.headerAction)) {
    labels = labelBlock(item.label ?? "", item.hint, item.more);
    row.appendChild(labels);
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

  if (item.type === "select") {
    const select = document.createElement("select");
    select.className = "settings-select";
    select.setAttribute("aria-label", item.label ?? "");
    paintOwn = () => {
      // Never while this select has focus: a repaint arrives from every sync
      // status event and replacing options would close an open dropdown.
      if (document.activeElement === select) return;
      const options = item.options ? item.options() : [];
      select.replaceChildren(
        ...options.map((option) => {
          const el = document.createElement("option");
          el.value = option.value;
          el.textContent = option.label;
          return el;
        }),
      );
      select.value = String((item.get ? item.get() : "") ?? "");
    };
    select.addEventListener("change", async () => {
      select.disabled = true;
      try {
        if (item.set) await item.set(select.value);
      } finally {
        select.disabled = false;
        // Blur before refresh so the focus guard in paintOwn lets the stored
        // value repaint (including when the command refused the change).
        select.blur();
        refresh();
      }
    });
    row.appendChild(select);
  }

  if (item.type === "text") {
    const input = document.createElement("input");
    input.className = "settings-input";
    input.type = item.password ? "password" : "text";
    input.spellcheck = false;
    if (item.placeholder) input.placeholder = item.placeholder;
    // A refused value (`set` answered false): the repaint puts the old one
    // back, and this line under the hint says why, until the next commit.
    const error = document.createElement("p");
    error.className = "dialog-error";
    error.hidden = true;
    labels?.appendChild(error);

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
      const ok = await item.set(committed);
      error.hidden = !(ok === false && item.invalid);
      error.textContent = error.hidden ? "" : item.invalid ?? "";
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
    if (item.headerAction) {
      const headerRow = document.createElement("div");
      headerRow.className = "settings-list-header";
      labels = labelBlock(item.label ?? "", item.hint, item.more);
      const headerBtn = makeActionButton(item.headerAction, refresh);
      headerRow.append(labels, headerBtn);
      row.appendChild(headerRow);
    }
    const list = document.createElement("div");
    list.className = "settings-list";
    row.appendChild(list);
    paintOwn = () => {
      // Never while a select in the list has the focus, or while a button in
      // the list waits for its command: a repaint arrives from every sync
      // status event and every store change, and replacing the row would close
      // an open dropdown or drop an in-flight click.
      const focused = document.activeElement;
      if (focused instanceof HTMLSelectElement && list.contains(focused)) return;
      if (list.querySelector("button:disabled")) return;
      const rows = item.rows ? item.rows(refresh) : [];
      if (rows.length === 0 && item.empty) {
        const empty = document.createElement("p");
        empty.className = "settings-hint settings-list-empty";
        empty.textContent = typeof item.empty === "function" ? item.empty() : item.empty;
        list.replaceChildren(empty);
        return;
      }
      list.replaceChildren(
        ...rows.map((entry) => {
          const line = document.createElement("div");
          line.className = "settings-list-row";
          line.dataset.key = entry.key;
          const text = document.createElement("div");
          text.className = "settings-list-text";
          if (entry.color && entry.swatchAct) {
            const swatchBtn = document.createElement("button");
            swatchBtn.type = "button";
            swatchBtn.className = "settings-swatch-button";
            if (entry.swatchTitle) {
              swatchBtn.title = entry.swatchTitle;
              swatchBtn.setAttribute("aria-label", entry.swatchTitle);
            }
            swatchBtn.appendChild(swatch(entry.color));
            swatchBtn.addEventListener("click", async () => {
              swatchBtn.disabled = true;
              try {
                await entry.swatchAct?.();
              } finally {
                swatchBtn.disabled = false;
                refresh();
              }
            });
            line.appendChild(swatchBtn);
          }
          const label = document.createElement("div");
          label.textContent = entry.label;
          if (entry.color && !entry.swatchAct) label.prepend(swatch(entry.color));
          text.appendChild(label);
          if (entry.value) {
            const value = document.createElement("div");
            value.className = "settings-hint";
            value.textContent = entry.value;
            text.appendChild(value);
          }
          line.appendChild(text);

          const hasControls = Boolean(entry.select || (entry.button && entry.act));
          if (hasControls) {
            const controls = document.createElement("div");
            controls.className = "settings-actions";
            const choice = entry.select;
            if (choice) {
              const select = document.createElement("select");
              select.className = "settings-select";
              select.setAttribute("aria-label", entry.label);
              for (const option of choice.options) {
                const el = document.createElement("option");
                el.value = option.value;
                el.textContent = option.label;
                select.appendChild(el);
              }
              select.value = choice.value;
              select.addEventListener("change", async () => {
                select.disabled = true;
                try {
                  await choice.set(select.value);
                } finally {
                  // The repaint replaces this select with one that shows the
                  // stored mode, also when the command refused the change. The
                  // blur first, or the focus guard in paintOwn skips it.
                  select.blur();
                  refresh();
                }
              });
              controls.appendChild(select);
            }
            if (entry.button && entry.act) {
              const button = document.createElement("button");
              button.type = "button";
              button.className = "settings-button";
              button.textContent = entry.button;
              if (entry.buttonTitle) button.title = entry.buttonTitle;
              button.addEventListener("click", async () => {
                button.disabled = true;
                try {
                  await entry.act?.();
                } finally {
                  button.disabled = false;
                  // The answer changed what the whole panel reports.
                  refresh();
                }
              });
              controls.appendChild(button);
            }
            line.appendChild(controls);
          }
          return line;
        })
      );
    };
  }

  if (item.type === "grid") {
    row.classList.add("settings-row-list");
    const wrap = document.createElement("div");
    wrap.className = "settings-grid-wrap";
    row.appendChild(wrap);
    paintOwn = () => {
      // Not while a click in the grid waits for its answer: the repaint
      // after it shows the result.
      if (wrap.querySelector("button:disabled")) return;
      const grid = item.grid ? item.grid() : { columns: [], rows: [] };
      const table = document.createElement("table");
      table.className = "settings-grid";
      const head = table.createTHead().insertRow();
      head.appendChild(document.createElement("th"));
      for (const column of grid.columns) {
        const th = document.createElement("th");
        th.scope = "col";
        const button = document.createElement("button");
        button.type = "button";
        button.className = "settings-grid-head";
        if (column.title) button.title = column.title;
        if (column.color) button.appendChild(swatch(column.color));
        button.append(column.label);
        button.addEventListener("click", () => act(button, column.act));
        th.appendChild(button);
        head.appendChild(th);
      }
      const bodyRows = table.createTBody();
      for (const line of grid.rows) {
        const tr = bodyRows.insertRow();
        tr.dataset.key = line.key;
        const th = document.createElement("th");
        th.scope = "row";
        th.append(line.label);
        if (line.me) {
          const tag = document.createElement("span");
          tag.className = "settings-me-tag";
          tag.textContent = "this device";
          th.append(" ", tag);
        }
        tr.appendChild(th);
        for (const cell of line.cells) {
          const td = tr.insertCell();
          const button = document.createElement("button");
          button.type = "button";
          button.className = "settings-grid-cell";
          button.setAttribute("role", "checkbox");
          button.setAttribute("aria-checked", String(cell.checked));
          button.setAttribute("aria-label", cell.label);
          button.title = cell.label;
          button.textContent = cell.checked ? "✓" : "";
          button.addEventListener("click", () => act(button, cell.act));
          td.appendChild(button);
        }
      }
      // What the last tick does on the other device (deviceGrid()).
      const note = document.createElement("p");
      note.className = "settings-hint settings-grid-note";
      note.setAttribute("aria-live", "polite");
      note.textContent = item.gridNote ? item.gridNote() : "";
      note.hidden = !note.textContent;
      wrap.replaceChildren(table, note);
    };
    /** @param {HTMLButtonElement} button @param {(() => any) | undefined} run */
    const act = async (button, run) => {
      if (!run) return;
      button.disabled = true;
      try {
        await run();
      } finally {
        button.disabled = false;
        refresh();
      }
    };
  }

  if (item.type === "details") {
    row.classList.add("settings-row-details");
    const details = document.createElement("details");
    details.className = "settings-details";
    const summary = document.createElement("summary");
    summary.className = "settings-details-summary";
    summary.appendChild(labelBlock(item.label ?? "", item.hint, item.more));
    const chevron = document.createElement("span");
    chevron.className = "settings-details-state";
    chevron.setAttribute("aria-hidden", "true");
    summary.appendChild(chevron);
    const body = document.createElement("div");
    body.className = "settings-details-body";
    details.append(summary, body);
    row.appendChild(details);

    // Only rebuild the key blocks when their values change so background sync
    // repaints never clear a selection or reset a "copied" button label.
    let lastSignature = "";
    paintOwn = () => {
      const blocks = item.blocks ? item.blocks() : [];
      const sig = blocks.map((b) => b.key + "\0" + b.label + "\0" + b.value).join("\n");
      if (sig === lastSignature) return;
      lastSignature = sig;
      body.replaceChildren(
        ...blocks.map((block) => {
          const box = document.createElement("div");
          box.className = "settings-key-box";
          box.dataset.key = block.key;
          const head = document.createElement("div");
          head.className = "settings-key-head";
          const name = document.createElement("span");
          name.className = "settings-key-label";
          name.textContent = block.label;
          const copy = document.createElement("button");
          copy.type = "button";
          copy.className = "settings-button settings-key-copy";
          copy.textContent = "copy";
          copy.addEventListener("click", async () => {
            try {
              await navigator.clipboard.writeText(block.value);
              copy.textContent = "copied";
            } catch {
              copy.textContent = "select key";
            }
            setTimeout(() => {
              if (copy.isConnected) copy.textContent = "copy";
            }, 1800);
          });
          head.append(name, copy);
          box.appendChild(head);
          if (block.hint) {
            const hint = document.createElement("p");
            hint.className = "settings-hint";
            hint.textContent = block.hint;
            box.appendChild(hint);
          }
          const code = document.createElement("div");
          code.className = "settings-key-code";
          code.textContent = block.value;
          box.appendChild(code);
          return box;
        }),
      );
    };
  }

  if (item.type === "info") {
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
    const controls = document.createElement("div");
    controls.className = "settings-actions";
    /** @type {HTMLSpanElement | null} */
    let valueEl = null;
    if (item.value) {
      valueEl = document.createElement("span");
      valueEl.className = "settings-value";
      controls.appendChild(valueEl);
    }
    /** @type {{ el: HTMLButtonElement, spec: ActionButton }[]} */
    const buttons = [];
    if (item.actions && item.actions.length) {
      for (const spec of item.actions) {
        const btn = makeActionButton(spec, refresh);
        buttons.push({ el: btn, spec });
        controls.appendChild(btn);
      }
    } else if (item.act || item.button) {
      const spec = {
        button: item.button ?? "run",
        danger: item.danger,
        act: item.act ?? (() => {}),
      };
      const btn = makeActionButton(spec, refresh);
      buttons.push({ el: btn, spec });
      controls.appendChild(btn);
    }
    paintOwn = () => {
      if (valueEl) {
        Promise.resolve(item.value ? item.value() : "").then((text) => {
          if (valueEl) valueEl.textContent = text;
        });
      }
      for (const { el, spec } of buttons) {
        if (spec.visible) el.hidden = !spec.visible();
      }
    };
    row.appendChild(controls);
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
 * A small square in a space's color, before its name. Decorative: the name
 * says which space it is.
 * @param {string} color
 */
function swatch(color) {
  const el = document.createElement("span");
  el.className = "space-swatch";
  el.setAttribute("aria-hidden", "true");
  // A CSS variable, not `background`: the stylesheet decides how it is drawn.
  el.style.setProperty("--space-color", color);
  return el;
}

/**
 * Whether a spellcheck language is on for the open note, as the status bar
 * shows it: off when the spellcheck is off on this device.
 * @param {"cs" | "en"} lang
 */
function noteLangOn(lang) {
  const record = store?.activeId ? store.get(store.activeId) : undefined;
  return isEnabled() && activeLangs(record?.spellOff)[lang];
}

/**
 * Mount the settings overlay. Returns the controller the settings.toggle
 * command dispatches into.
 *
 * @param {{keyring?: import("../crypto/keyring.js").KeyRing,
 *          sync?: ReturnType<import("../sync/client.js").createSyncClient>,
 *          store?: ReturnType<import("../model/docs.js").createDocStore>}} [deps]
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
  // Shown only while a second view is open (openSub below).
  const backButton = document.createElement("button");
  backButton.className = "settings-button";
  backButton.id = "settings-back";
  backButton.type = "button";
  backButton.textContent = "← Settings";
  backButton.hidden = true;
  backButton.addEventListener("click", () => closeSub());
  headRow.appendChild(backButton);
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

  // Horizontal jump strip for narrow panes and phone mode, where the left rail
  // folds away (app.css). Hidden on wide screens.
  const jumpBar = document.createElement("nav");
  jumpBar.className = "settings-page settings-jump";
  jumpBar.setAttribute("aria-label", "Jump to section");
  head.appendChild(jumpBar);

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
  // A second view takes the place of the body: the Spellcheck page. It lives
  // inside this panel and not in a panel of its own, so the head, the ×,
  // Escape, Back and the focus rules below stay in one place.
  const sub = document.createElement("div");
  sub.className = "settings-page settings-sub";
  sub.hidden = true;

  /** @type {(() => void)[]} */
  const painters = [];
  /**
   * One per section: its element in the document, its button in the rail,
   * its pill in the narrow jump strip, an optional rail divider before it,
   * and the state word under the rail button.
   * @type {{ section: Section, element: HTMLElement, item: HTMLButtonElement,
   *          jumpItem: HTMLButtonElement, gap: HTMLElement | null,
   *          status: HTMLElement }[]}
   */
  const entries = [];

  // Which section the reader is in: the last one that starts under the
  // sticky head. Once the panel is scrolled to its end, the last visible
  // section takes the mark, or a short bottom section could never have it. A
  // panel that does not scroll at all marks the first.
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
      const active = entry === current;
      if (active) {
        entry.item.setAttribute("aria-current", "true");
        entry.jumpItem.setAttribute("aria-current", "true");
      } else {
        entry.item.removeAttribute("aria-current");
        entry.jumpItem.removeAttribute("aria-current");
      }
      // The stripe in the document (app.css), also on a phone, where the
      // rail is hidden and this is the only mark.
      entry.element.classList.toggle("is-current", active);
    }
    // Keep the active pill in sight horizontally without calling scrollIntoView,
    // which can nudge the vertical scroll of #settings-panel on mobile Safari.
    if (jumpBar.clientWidth > 0 && jumpBar.scrollWidth > jumpBar.clientWidth) {
      const pill = current.jumpItem;
      const left = pill.offsetLeft;
      const right = left + pill.offsetWidth;
      if (left < jumpBar.scrollLeft) {
        jumpBar.scrollLeft = Math.max(0, left - 8);
      } else if (right > jumpBar.scrollLeft + jumpBar.clientWidth) {
        jumpBar.scrollLeft = right - jumpBar.clientWidth + 8;
      }
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
    // after that. A section whose rows are all hidden hides with them,
    // heading, rail entry, and jump pill included.
    setTimeout(() => {
      /** @type {string | undefined} */
      let lastVisibleGroup;
      let anyVisible = false;
      for (const entry of entries) {
        const rows = [...entry.element.children].filter((el) => el.tagName !== "H3");
        const hide = rows.length > 0 && rows.every((el) => el.hidden);
        entry.element.hidden = hide;
        entry.item.hidden = hide;
        entry.jumpItem.hidden = hide;
        if (entry.gap) {
          // Draw a rail divider only between two visible sections in different
          // groups, so hidden sections never leave a double or leading line.
          entry.gap.hidden = hide || !anyVisible || entry.section.group === lastVisibleGroup;
        }
        if (!hide) {
          anyVisible = true;
          lastVisibleGroup = entry.section.group;
        }
      }
      markCurrent();
    }, 0);
  }

  /** @type {string | undefined} */
  let prevGroup;
  for (const section of SECTIONS) {
    /** @type {HTMLElement | null} */
    let gap = null;
    if (prevGroup !== undefined && section.group !== prevGroup) {
      gap = document.createElement("div");
      gap.className = "settings-rail-gap";
      gap.setAttribute("aria-hidden", "true");
      rail.appendChild(gap);
    }
    prevGroup = section.group;

    const element = document.createElement("section");
    element.className = "settings-section";
    element.dataset.section = section.title.toLowerCase();
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

    const jumpItem = document.createElement("button");
    jumpItem.type = "button";
    jumpItem.className = "settings-jump-pill";
    jumpItem.textContent = section.title;
    jumpItem.addEventListener("click", () => {
      element.scrollIntoView({ block: "start" });
    });
    jumpBar.appendChild(jumpItem);

    entries.push({ section, element, item, jumpItem, gap, status });
  }
  panel.replaceChildren(head, body, sub);

  // The statusbar spellcheck button stays clickable next to an open panel on a
  // PC, so the panel repaints whenever that state flips, whoever flipped it.
  spellEvents.addEventListener("change", () => {
    if (!panel.hidden) refresh();
  });

  // The language rows read the open note, which another window or a sync can
  // change while the panel is open.
  store?.events.addEventListener("spell", () => {
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
  // The grid and the space rows follow the space logs (§27).
  sync?.events.addEventListener("spaces", () => {
    if (!panel.hidden) refresh();
  });

  // A note change can update space counts or the active note's language rows
  // while the panel is open.
  store?.events.addEventListener("change", () => {
    if (!panel.hidden) refresh();
  });

  // On a phone the panel is the whole screen, and Back must close it, not
  // leave the app (watchBack in ui/shell.js).
  let stopBack = () => {};

  /**
   * The second view that is open, or null.
   * @type {{ title: string, element: HTMLElement, shown?: () => void, hidden?: () => void,
   *          escape?: () => boolean } | null}
   */
  let subPage = null;
  // A layer of its own for Back on a phone: the first Back returns to the
  // rows of Settings, the second closes the panel.
  let stopSubBack = () => {};

  /** @param {NonNullable<typeof subPage>} page */
  function openSub(page) {
    if (subPage) closeSub();
    subPage = page;
    sub.replaceChildren(page.element);
    body.hidden = true;
    // The strip of section buttons (narrow panes, phones) belongs to the
    // rows. It stands in the head, outside the body, so it is hidden on its
    // own: over a page, its buttons would scroll rows that are not there.
    jumpBar.hidden = true;
    sub.hidden = false;
    backButton.hidden = false;
    title.textContent = page.title;
    panel.scrollTop = 0;
    stopSubBack = watchBack(closeSub);
    page.shown?.();
  }

  /** @param {boolean} [refocus] False when the whole panel closes next. */
  function closeSub(refocus = true) {
    if (!subPage) return;
    const page = subPage;
    subPage = null;
    stopSubBack();
    stopSubBack = () => {};
    sub.hidden = true;
    body.hidden = false;
    jumpBar.hidden = false;
    backButton.hidden = true;
    title.textContent = "Settings";
    page.hidden?.();
    // The row that opened the page shows counts the page may have changed.
    refresh();
    // The focused control went away with the page; Escape needs a target.
    if (refocus) panel.focus();
  }

  if (store) {
    const spellPage = buildSpellPage({ store, sync });
    openSpellPage = () => openSub(spellPage);
  }

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
    // One step at a time, like Back on a phone. The page can use the key
    // first, for a step of its own (a filled search field).
    if (subPage?.escape?.()) return;
    if (subPage) closeSub();
    else close();
  }

  function open() {
    refresh();
    panel.hidden = false;
    // Focus moves off the editor, so typing cannot land in a document hidden
    // behind the panel, and Escape has somewhere to arrive.
    panel.focus();
    window.addEventListener("keydown", onKeydown, true);
    stopBack = watchBack(close);
  }

  function close() {
    if (panel.hidden) return;
    gridNote = "";
    // The panel opens on its rows the next time, never on a page of last week.
    // No refocus: the lines below decide where the focus goes.
    closeSub(false);
    // Read before hiding: setting panel.hidden = true drops focus from inside
    // the panel onto document.body.
    const active = document.activeElement;
    const hadFocus =
      !active ||
      active === document.body ||
      active === document.documentElement ||
      panel.contains(active);
    panel.hidden = true;
    stopBack();
    window.removeEventListener("keydown", onKeydown, true);
    // Return focus to the editor on desktop instead of restoring the Settings
    // button, which stayed invisibly focused after mouse clicks and re-opened
    // Settings on a later Space or Enter (e.g. waking a sleeping display).
    // Phone mode skips this so closing Settings never pops up the on-screen
    // keyboard or closes the full-screen note list behind it.
    if (hadFocus && !phoneMode()) run("editor.focus");
  }

  function toggle() {
    if (panel.hidden) open();
    else close();
  }

  return { open, close, toggle, isOpen: () => !panel.hidden };
}
