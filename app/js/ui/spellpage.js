// @ts-check
// The Spellcheck page: a second view inside the Settings panel
// (ui/settings.js, openSub). It has a switch for each rule of the English
// checker (Harper), in Harper's own groups, with a search.
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
import { changedCount, displayName, resetRules, setRule } from "../model/spellsettings.js";

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
 * @param {{ store: ReturnType<import("../model/docs.js").createDocStore> }} deps
 * @returns {{ title: string, element: HTMLElement, shown: () => void, hidden: () => void, escape: () => boolean }}
 */
export function buildSpellPage({ store }) {
  const element = make("div", "spell-page");

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

  /**
   * Escape in a filled search field clears the search; the next Escape goes
   * back to Settings. The panel owns the key (ui/settings.js, onKeydown) and
   * asks here first.
   * @returns {boolean} True when this page used the key.
   */
  function escape() {
    if (document.activeElement !== search || !search.value) return false;
    search.value = "";
    paintRules();
    return true;
  }

  function paint() {
    if (!visible) return;
    paintRules();
  }

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
    onlyChanged = false;
  }

  return { title: "Spellcheck", element, shown, hidden, escape };
}
