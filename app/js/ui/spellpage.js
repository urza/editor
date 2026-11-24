// @ts-check
// The Spellcheck page: a second view inside the Settings panel
// (ui/settings.js, openSub). It has a switch for each rule of the English
// checker (Harper), in Harper's own groups, with a search, and the user's
// own list of words ("My words"), which both checkers accept.
//
// The design follows the settings page of the Harper browser extension, not
// its code: that page is Svelte with a build step, and this app has neither.
// Everything on screen comes from the engine at run time (ruleCatalog in
// editor/spellcheck.js), so vrtti keeps no list of rules of its own that a
// Harper update could leave behind.
//
// The page changes nothing by itself. Each switch writes the shared settings
// record (model/docs.js, writeSharedSettings); the store then fires
// "shared-settings", which repaints this page and hands the settings to the
// checker (main.js). A change from another window or another device arrives
// on the same event, so the page never shows a state of its own.

import { ruleCatalog } from "../editor/spellcheck.js";
import {
  addWord,
  changedCount,
  displayName,
  parseWords,
  removeWord,
  replaceWords,
  resetRules,
  setRule,
  wordKey,
  wordList,
} from "../model/spellsettings.js";

/**
 * @param {string} tag @param {string} [className] @param {string} [text]
 * @returns {HTMLElement}
 */
function make(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/**
 * @param {string} className @param {string} text
 * @returns {HTMLButtonElement}
 */
function makeButton(className, text) {
  const button = /** @type {HTMLButtonElement} */ (make("button", className, text));
  button.type = "button";
  return button;
}

/**
 * @param {{ store: ReturnType<import("../model/docs.js").createDocStore>,
 *           sync: ReturnType<import("../sync/client.js").createSyncClient> | null }} deps
 * @returns {{ title: string, element: HTMLElement, shown: () => void, hidden: () => void, escape: () => boolean }}
 */
export function buildSpellPage({ store, sync }) {
  const element = make("div", "spell-page");

  // Where these settings live. They are the only settings of the app that
  // travel to the other devices (architecture.md §29), so the page says it,
  // and it says so too when they cannot travel.
  const syncLine = make("p", "spell-note spell-sync");
  element.appendChild(syncLine);

  function paintSync() {
    if (!sync?.isConfigured) syncLine.textContent = "These settings stay on this device.";
    else if (sync.settingsRefused) {
      syncLine.textContent = "The sync server is older than this app, so these settings stay on this device.";
    } else syncLine.textContent = "These settings sync to all your devices.";
  }

  // ---- Rules ---------------------------------------------------------------
  const rulesSection = make("section", "settings-section");
  rulesSection.appendChild(make("h3", "", "Rules"));
  const search = /** @type {HTMLInputElement} */ (make("input", "settings-input spell-search"));
  search.type = "search";
  search.placeholder = "Search the rules";
  search.setAttribute("aria-label", "Search the rules");
  search.spellcheck = false;
  const bar = make("div", "spell-bar");
  const groupsBox = make("div", "spell-groups");
  rulesSection.append(search, bar, groupsBox);
  element.appendChild(rulesSection);

  /**
   * undefined: not asked yet or still loading. null: Harper failed to load.
   * @type {import("../editor/spellrules.js").CatalogGroup[] | null | undefined}
   */
  let catalog;
  let visible = false;
  let onlyChanged = false;
  /** The groups the user opened, by label. */
  const open = new Set();

  /** Write new settings; the "shared-settings" event repaints. */
  const write = (/** @type {import("../model/spellsettings.js").SpellSettings} */ next) =>
    store.writeSharedSettings(next).catch((err) => console.error("[vrtti] spellcheck settings not saved", err));

  function paintRules() {
    // A repaint builds the rows again, so the focus is put back by key: a
    // switch must stay under the finger and under the Tab key.
    const active = /** @type {HTMLElement | null} */ (document.activeElement);
    const focusKey = active && groupsBox.contains(active) ? active.dataset.focusKey : undefined;

    if (catalog === undefined) {
      bar.replaceChildren();
      groupsBox.replaceChildren(make("p", "spell-note", "Loading the rules…"));
      return;
    }
    if (catalog === null) {
      bar.replaceChildren();
      groupsBox.replaceChildren(make("p", "spell-note", "The English checker did not load, so its rules cannot show here."));
      return;
    }

    const settings = store.sharedSettings();
    const changed = changedCount(settings);
    // A filter that matches nothing any more would leave an empty page with
    // no way out, because the "N changed" button is gone at zero.
    if (changed === 0) onlyChanged = false;
    const total = catalog.reduce((sum, group) => sum + group.rules.length, 0);

    // The count line. "N changed" is a filter button: it is the way back to a
    // rule that was turned off with a quick button on a mark.
    const count = make("span", "spell-count", `${total} rules`);
    if (changed > 0) {
      count.append(" · ");
      const filter = makeButton("spell-changed-filter", `${changed} changed`);
      filter.setAttribute("aria-pressed", String(onlyChanged));
      filter.title = onlyChanged ? "Show all rules" : "Show only the changed rules";
      filter.addEventListener("click", () => {
        onlyChanged = !onlyChanged;
        paintRules();
      });
      count.appendChild(filter);
    }
    const reset = makeButton("settings-button", "Reset to defaults");
    reset.disabled = changed === 0;
    reset.addEventListener("click", () => write(resetRules(store.sharedSettings(), Date.now())));
    bar.replaceChildren(count, reset);

    const query = search.value.trim().toLowerCase();
    const filtering = Boolean(query) || onlyChanged;
    const rows = [];
    for (const group of catalog) {
      const isChanged = (/** @type {{ name: string }} */ rule) => (settings.rules[rule.name]?.on ?? null) !== null;
      const groupChanged = group.rules.filter(isChanged).length;
      const shown = group.rules.filter(
        (rule) =>
          (!onlyChanged || isChanged(rule)) &&
          (!query ||
            rule.name.toLowerCase().includes(query) ||
            displayName(rule.name).toLowerCase().includes(query) ||
            rule.description.toLowerCase().includes(query))
      );
      if (filtering && shown.length === 0) continue;
      // A filter opens every group it has a hit in: the hits are the point.
      const isOpen = filtering || open.has(group.label);

      const head = makeButton("spell-group", "");
      head.dataset.focusKey = "group:" + group.label;
      head.setAttribute("aria-expanded", String(isOpen));
      head.append(
        make("span", "spell-group-caret", isOpen ? "▾" : "▸"),
        make("span", "spell-group-name", group.label)
      );
      const tail = make("span", "spell-group-count");
      if (groupChanged > 0) tail.append(make("span", "spell-changed", `${groupChanged} changed`), " · ");
      tail.append(String(group.rules.length));
      head.appendChild(tail);
      // With a filter on, the groups are open by the filter, and a click
      // would change nothing the user can see.
      head.disabled = filtering;
      head.addEventListener("click", () => {
        if (open.has(group.label)) open.delete(group.label);
        else open.add(group.label);
        paintRules();
      });
      rows.push(head);
      if (!isOpen) continue;

      // The rules of a group are built only when it is open: 823 switches
      // that nobody looks at would cost the build and the memory for nothing.
      const list = make("div", "spell-rules");
      if (group.description && !filtering) list.appendChild(make("p", "spell-note", group.description));
      for (const rule of shown) {
        const on = settings.rules[rule.name]?.on ?? rule.byDefault;
        const row = make("div", "settings-row");
        row.dataset.rule = rule.name;
        const labels = make("div", "settings-label");
        const name = make("div", "", displayName(rule.name));
        if (isChanged(rule)) name.append(" ", make("span", "spell-changed", "changed"));
        labels.append(name, make("p", "settings-hint", rule.description));
        const toggle = makeButton("settings-toggle", on ? "on" : "off");
        toggle.dataset.focusKey = "rule:" + rule.name;
        toggle.setAttribute("aria-pressed", String(on));
        toggle.setAttribute("aria-label", displayName(rule.name));
        toggle.addEventListener("click", () =>
          write(setRule(store.sharedSettings(), rule.name, !on, rule.byDefault, Date.now()))
        );
        row.append(labels, toggle);
        list.appendChild(row);
      }
      rows.push(list);
    }
    if (rows.length === 0) {
      rows.push(make("p", "spell-note", query ? `No rule matches “${search.value.trim()}”.` : "No rule is changed."));
    }
    groupsBox.replaceChildren(...rows);

    if (focusKey) {
      for (const el of groupsBox.querySelectorAll("[data-focus-key]")) {
        if (/** @type {HTMLElement} */ (el).dataset.focusKey === focusKey) /** @type {HTMLElement} */ (el).focus();
      }
    }
  }

  search.addEventListener("input", paintRules);

  // ---- My words ------------------------------------------------------------
  // The list must stay usable with hundreds of words: one field filters it
  // and adds to it, the words stand in columns, and "Edit as text" takes a
  // paste of many words at once.
  const wordsSection = make("section", "settings-section");
  wordsSection.appendChild(make("h3", "", "My words"));
  wordsSection.appendChild(
    make("p", "spell-note", "A word of this list gets no mark, in English and in Czech text. Capital letters make no difference.")
  );
  const field = /** @type {HTMLInputElement} */ (make("input", "settings-input spell-search"));
  field.type = "text";
  field.placeholder = "Filter or add a word";
  field.setAttribute("aria-label", "Filter or add a word");
  field.spellcheck = false;
  field.autocapitalize = "off";
  field.autocomplete = "off";
  const addButton = makeButton("settings-button", "");
  const fieldRow = make("div", "spell-field");
  fieldRow.append(field, addButton);
  const wordsBar = make("div", "spell-bar");
  const wordsCount = make("span", "spell-count");
  const editButton = makeButton("settings-button", "Edit as text");
  wordsBar.append(wordsCount, editButton);
  const wordsBox = make("div", "spell-words");
  // "Edit as text": the same list as one text, one word in each line.
  const textBar = make("div", "spell-bar");
  const cancelButton = makeButton("settings-button", "Cancel");
  const saveButton = makeButton("settings-button", "Save");
  textBar.append(make("span", "spell-count", "One word in each line."), cancelButton, saveButton);
  const textArea = /** @type {HTMLTextAreaElement} */ (make("textarea", "settings-input spell-text"));
  textArea.setAttribute("aria-label", "My words as text");
  textArea.spellcheck = false;
  textArea.autocapitalize = "off";
  wordsSection.append(fieldRow, wordsBar, wordsBox, textBar, textArea);
  element.appendChild(wordsSection);

  let editing = false;

  /** The typed word when the button "Add" applies to it, else "". */
  function addable() {
    const typed = field.value.trim();
    if (!typed || /\s/.test(typed)) return "";
    const key = wordKey(typed);
    return wordList(store.sharedSettings()).some((word) => wordKey(word) === key) ? "" : typed;
  }

  function paintWords() {
    fieldRow.hidden = wordsBar.hidden = wordsBox.hidden = editing;
    textBar.hidden = textArea.hidden = !editing;
    // The text field is the user's draft while it is open. A change from
    // another device must not replace what they typed; Save merges by word.
    if (editing) return;

    const active = /** @type {HTMLElement | null} */ (document.activeElement);
    const focusKey = active && wordsBox.contains(active) ? active.dataset.focusKey : undefined;

    const all = wordList(store.sharedSettings());
    const query = wordKey(field.value);
    const shown = query ? all.filter((word) => wordKey(word).includes(query)) : all;
    const typed = addable();
    addButton.hidden = !typed;
    addButton.textContent = `Add “${typed}”`;

    if (all.length === 0) wordsCount.textContent = "No words yet.";
    else if (!query) wordsCount.textContent = `${all.length} ${all.length === 1 ? "word" : "words"}`;
    else if (shown.length === 0) wordsCount.textContent = `No word contains “${field.value.trim()}”.`;
    else wordsCount.textContent = `${shown.length} of ${all.length} words`;

    wordsBox.replaceChildren(
      ...shown.map((word) => {
        const item = make("span", "spell-word");
        const remove = makeButton("", "×");
        remove.dataset.focusKey = "word:" + wordKey(word);
        remove.setAttribute("aria-label", `Remove ${word}`);
        remove.title = "Remove";
        remove.addEventListener("click", () => write(removeWord(store.sharedSettings(), word, Date.now())));
        item.append(make("span", "", word), remove);
        return item;
      })
    );
    if (focusKey) {
      for (const el of wordsBox.querySelectorAll("[data-focus-key]")) {
        if (/** @type {HTMLElement} */ (el).dataset.focusKey === focusKey) /** @type {HTMLElement} */ (el).focus();
      }
    }
  }

  function addTyped() {
    const typed = addable();
    if (!typed) return;
    // Cleared first: the repaint that follows the write then shows the whole
    // list again, with the new word in it.
    field.value = "";
    write(addWord(store.sharedSettings(), typed, Date.now()));
  }

  field.addEventListener("input", paintWords);
  field.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addTyped();
  });
  addButton.addEventListener("click", () => {
    addTyped();
    field.focus();
  });

  /** @param {boolean} on */
  function setEditing(on) {
    editing = on;
    if (on) textArea.value = wordList(store.sharedSettings()).join("\n");
    paintWords();
    if (on) textArea.focus();
    else editButton.focus();
  }
  editButton.addEventListener("click", () => setEditing(true));
  cancelButton.addEventListener("click", () => setEditing(false));
  saveButton.addEventListener("click", () => {
    write(replaceWords(store.sharedSettings(), parseWords(textArea.value), Date.now()));
    setEditing(false);
  });

  /**
   * Escape takes one step back inside the page before it leaves the page: it
   * clears a filled search or word field, and it closes "Edit as text"
   * without saving. The panel owns the key (ui/settings.js, onKeydown) and
   * asks here first.
   * @returns {boolean} True when this page used the key.
   */
  function escape() {
    const active = document.activeElement;
    if (active === search && search.value) {
      search.value = "";
      paintRules();
      return true;
    }
    if (active === field && field.value) {
      field.value = "";
      paintWords();
      return true;
    }
    if (editing) {
      setEditing(false);
      return true;
    }
    return false;
  }

  function paint() {
    if (!visible) return;
    paintSync();
    paintRules();
    paintWords();
  }
  // The answer of an older server arrives with a sync round.
  sync?.events.addEventListener("status", () => {
    if (visible) paintSync();
  });

  store.events.addEventListener("shared-settings", paint);

  function shown() {
    visible = true;
    paint();
    if (!catalog) {
      // The engine loads here, also with spellcheck off: the user must be
      // able to prepare the rules before turning it on. Asked again after a
      // failed load (null): the next opening of the page is a new try.
      ruleCatalog().then((groups) => {
        catalog = groups;
        paint();
      });
    }
  }

  function hidden() {
    visible = false;
    search.value = "";
    field.value = "";
    editing = false;
    onlyChanged = false;
  }

  return { title: "Spellcheck", element, shown, hidden, escape };
}
