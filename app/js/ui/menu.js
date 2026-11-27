// @ts-check
// One small popup menu, the kind that hangs off a "⋯" button or the desktop
// View filter button (architecture.md §9, §28). No library, no framework.
//
// The menu renders into document.body, not next to its button: #sidebar-scroll
// scrolls with overflow, and a menu built inside a row would be clipped at the
// scroller edge. Body plus position:fixed coordinates is what escapes that.
//
// One menu exists at a time. Opening a second one closes the first.

import { menuIcon } from "./icons.js";
import { watchBack } from "./shell.js";

/**
 * One entry. A separator or header needs nothing else; every other item needs a label.
 *
 * @typedef {Object} MenuItem
 * @property {boolean} [separator]
 * @property {string} [header]      Section heading row inside the popup.
 * @property {{ label: string, act: () => any }} [headerAction]  Optional button on the heading row.
 * @property {string} [label]
 * @property {string} [hint]        Small second line, e.g. why the item is off.
 * @property {string} [icon]        A name from ui/icons.js, drawn before the label.
 * @property {boolean} [checked]    Present (true or false) means a checkable item.
 * @property {boolean} [disabled]
 * @property {boolean} [danger]     Destructive item styled in danger red.
 * @property {string} [swatch]      Space color hex, or "local" for a hollow local swatch.
 * @property {number} [count]       Optional right-aligned count (View filter).
 * @property {{ label: string, title?: string, act: () => any }} [action]
 *                                  Optional secondary hover button on the row ("only").
 * @property {() => any} [act]
 */

const GAP = 4;

/** @type {{ el: HTMLElement, anchor: HTMLElement, onKey: (e: KeyboardEvent) => void, onDown: (e: Event) => void, onAway: () => void, stopBack: () => void } | null} */
let current = null;

/** @param {{restoreFocus?: boolean}} [opts] */
export function closeMenu({ restoreFocus = false } = {}) {
  if (!current) return;
  const { el, anchor, onKey, onDown, onAway, stopBack } = current;
  current = null;
  stopBack();
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("pointerdown", onDown, true);
  window.removeEventListener("scroll", onAway, true);
  window.removeEventListener("resize", onAway);
  el.remove();
  // Only on Escape and after an item ran: a click somewhere else is already
  // moving the focus, and stealing it back would fight the user.
  if (restoreFocus && anchor.isConnected) anchor.focus();
  // After the focus, not before: a sidebar row drops its buttons out of the
  // layout once the menu is gone and no button has the focus (app.css), and a
  // button with display: none cannot take the focus. Only a button that
  // declares the popup carries the state: the editor's text is an anchor too
  // (editor/spellcheck.js), and "expanded" would mean nothing on it.
  if (anchor.hasAttribute("aria-haspopup")) anchor.setAttribute("aria-expanded", "false");
}

/** @param {HTMLElement} el @returns {HTMLButtonElement[]} */
function enabledItems(el) {
  return /** @type {HTMLButtonElement[]} */ ([
    ...el.querySelectorAll(
      ".menu-head button:not(:disabled), button.menu-item:not(:disabled), button.filter-toggle:not(:disabled), button.filter-only:not(:disabled)"
    ),
  ]);
}

/**
 * Place the menu under a rectangle, and keep it inside the window.
 * @param {HTMLElement} el @param {{left: number, top: number, bottom: number}} rect
 */
function place(el, rect) {
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  const left = Math.max(GAP, Math.min(rect.left, window.innerWidth - width - GAP));
  // Below the button, unless the window ends first; then above it.
  let top = rect.bottom + GAP;
  if (top + height > window.innerHeight - GAP) {
    top = Math.max(GAP, rect.top - height - GAP);
  }
  el.style.left = left + "px";
  el.style.top = top + "px";
}

/** @param {string} swatch */
function makeSwatch(swatch) {
  const dot = document.createElement("span");
  dot.className = swatch === "local" ? "space-swatch local" : "space-swatch";
  if (swatch !== "local") dot.style.setProperty("--space-color", swatch);
  return dot;
}

/**
 * @param {HTMLElement} anchor The button the menu belongs to. It gets the
 *   focus back when the menu closes by keyboard.
 * @param {MenuItem[] | (() => MenuItem[])} itemsOrFn
 * @param {{at?: {left: number, top: number, bottom: number}, stayOpen?: boolean}} [opts]
 *   `at`: where the menu hangs when not under the anchor (editor/spellcheck.js).
 *   `stayOpen`: keep the popup open on click and re-render from `itemsOrFn`
 *   (the desktop View space filter checklist, §28).
 */
export function openMenu(anchor, itemsOrFn, { at, stayOpen = false } = {}) {
  // Toggle shut only when clicking a real menu button (`aria-haspopup`) a
  // second time. The Ctrl+. spelling menu passes `view.contentDOM` as its
  // anchor (editor/spellcheck.js), where a second Ctrl+. on another word must
  // replace the menu instead of toggling it closed.
  if (current && current.anchor === anchor && anchor.hasAttribute("aria-haspopup")) {
    closeMenu({ restoreFocus: true });
    return;
  }
  closeMenu();
  // A row can be redrawn between the click and this call (a rename committing
  // on blur redraws the list). A detached anchor has a zero rect, and the menu
  // would land in the window corner; better to open nothing.
  if (!anchor.isConnected) return;

  const el = document.createElement("div");
  el.className = "menu";
  el.setAttribute("role", "menu");

  const getItems = typeof itemsOrFn === "function" ? itemsOrFn : () => itemsOrFn;

  function renderItems() {
    // The column of a menu with icons is as wide as an icon, also on its
    // items that have none, so every label still starts at the same x.
    const items = getItems();
    el.classList.toggle("has-icons", items.some((item) => Boolean(item.icon)));
    // Re-rendering a `stayOpen` checklist replaces the focused button; restore
    // focus to the same item index afterwards so Enter/Space/Arrows keep working.
    const priorButtons = enabledItems(el);
    const focusedIdx =
      document.activeElement instanceof HTMLButtonElement
        ? priorButtons.indexOf(document.activeElement)
        : -1;
    el.replaceChildren();
    for (const item of items) {
      if (item.separator) {
        const line = document.createElement("div");
        line.className = "menu-sep";
        el.appendChild(line);
        continue;
      }

      if (item.header !== undefined) {
        const head = document.createElement("div");
        head.className = "menu-head";
        const span = document.createElement("span");
        span.textContent = item.header;
        head.appendChild(span);
        if (item.headerAction) {
          const actBtn = document.createElement("button");
          actBtn.type = "button";
          actBtn.textContent = item.headerAction.label;
          const act = item.headerAction.act;
          actBtn.addEventListener("click", (event) => {
            event.stopPropagation();
            act();
            if (stayOpen) renderItems();
            else closeMenu({ restoreFocus: true });
          });
          head.appendChild(actBtn);
        }
        el.appendChild(head);
        continue;
      }

      if (item.action) {
        const row = document.createElement("div");
        row.className = "filter-row";

        const toggle = document.createElement("button");
        toggle.className = "filter-toggle";
        toggle.type = "button";
        toggle.disabled = Boolean(item.disabled);
        const checkable = item.checked !== undefined;
        toggle.setAttribute("role", checkable ? "menuitemcheckbox" : "menuitem");
        if (checkable) toggle.setAttribute("aria-checked", String(item.checked));

        const check = document.createElement("span");
        check.className = "menu-check";
        check.textContent = item.checked ? "✓" : "";
        toggle.appendChild(check);

        if (item.swatch) toggle.appendChild(makeSwatch(item.swatch));

        const label = document.createElement("span");
        label.className = "filter-label";
        label.textContent = item.label ?? "";
        toggle.appendChild(label);

        if (typeof item.count === "number") {
          const count = document.createElement("span");
          count.className = "menu-count";
          count.textContent = String(item.count);
          toggle.appendChild(count);
        }

        toggle.addEventListener("click", (event) => {
          event.stopPropagation();
          if (item.act) item.act();
          if (stayOpen) renderItems();
          else closeMenu({ restoreFocus: true });
        });

        const secondary = document.createElement("button");
        secondary.className = "filter-only";
        secondary.type = "button";
        secondary.textContent = item.action.label;
        if (item.action.title) secondary.title = item.action.title;
        const secAct = item.action.act;
        secondary.addEventListener("click", (event) => {
          event.stopPropagation();
          secAct();
          if (stayOpen) renderItems();
          else closeMenu({ restoreFocus: true });
        });

        row.append(toggle, secondary);
        el.appendChild(row);
        continue;
      }

      const button = document.createElement("button");
      button.className = item.danger ? "menu-item danger" : "menu-item";
      button.type = "button";
      button.disabled = Boolean(item.disabled);

      const checkable = item.checked !== undefined;
      button.setAttribute("role", checkable ? "menuitemcheckbox" : "menuitem");
      if (checkable) button.setAttribute("aria-checked", String(item.checked));

      const check = document.createElement("span");
      check.className = "menu-check";
      // The empty span stays on plain items: it holds the column, so every
      // label starts at the same x.
      check.textContent = item.checked ? "✓" : "";
      // An icon takes the same column as the check mark, so a menu needs no
      // second gutter. No menu has both on one item.
      if (item.icon && !checkable) {
        check.classList.add("menu-icon-slot");
        check.appendChild(menuIcon(item.icon));
      }
      button.appendChild(check);

      const text = document.createElement("span");
      text.className = "menu-text";
      const label = document.createElement("span");
      label.className = "menu-label";
      if (item.swatch) label.appendChild(makeSwatch(item.swatch));
      label.append(item.label ?? "");
      if (typeof item.count === "number") {
        const count = document.createElement("span");
        count.className = "menu-count";
        count.textContent = String(item.count);
        label.appendChild(count);
      }
      text.appendChild(label);
      if (item.hint) {
        const hint = document.createElement("span");
        hint.className = "menu-hint";
        hint.textContent = item.hint;
        text.appendChild(hint);
      }
      button.appendChild(text);

      button.addEventListener("click", (event) => {
        if (stayOpen) {
          event.stopPropagation();
          if (item.act) item.act();
          renderItems();
          return;
        }
        // Close first: the item may redraw the list the anchor lives in.
        closeMenu({ restoreFocus: true });
        if (item.act) item.act();
      });
      el.appendChild(button);
    }
    if (focusedIdx >= 0) {
      const nextButtons = enabledItems(el);
      if (nextButtons.length) {
        nextButtons[Math.min(focusedIdx, nextButtons.length - 1)].focus();
      }
    }
  }

  renderItems();
  document.body.appendChild(el);
  place(el, at ?? anchor.getBoundingClientRect());

  /** @param {KeyboardEvent} event */
  const onKey = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu({ restoreFocus: true });
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const buttons = enabledItems(el);
    if (!buttons.length) return;
    const idx = buttons.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
    const step = event.key === "ArrowDown" ? 1 : -1;
    // Wraps at both ends, like every native menu.
    buttons[(idx + step + buttons.length) % buttons.length].focus();
  };

  /** @param {Event} event */
  const onDown = (event) => {
    // Exempt the anchor only when it is a popup button (`aria-haspopup`), so
    // its click handler toggles the menu cleanly without closing and reopening.
    // When the anchor is the editor text (`view.contentDOM` in spellcheck.js),
    // clicking anywhere in the text must close the spelling menu.
    if (
      event.target instanceof Node &&
      (el.contains(event.target) ||
        (anchor.hasAttribute("aria-haspopup") && anchor.contains(event.target)))
    ) {
      return;
    }
    closeMenu();
  };

  // A menu is placed once. Anything that moves its anchor closes it instead of
  // chasing it: capture:true is what catches a scroll inside the sidebar.
  const onAway = () => closeMenu();

  window.addEventListener("keydown", onKey, true);
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("scroll", onAway, true);
  window.addEventListener("resize", onAway);
  // On a phone, Back closes the menu and nothing under it. Without this the
  // note list under a row menu would take the Back, and the menu would stay
  // on screen over the editor: none of the listeners above sees a list that
  // goes away.
  const stopBack = watchBack(() => closeMenu());
  current = { el, anchor, onKey, onDown, onAway, stopBack };
  // Screen readers announce it, and app.css keeps a sidebar row's buttons on
  // screen by it while the pointer is in the menu, off the row. The guard is
  // explained in closeMenu.
  if (anchor.hasAttribute("aria-haspopup")) anchor.setAttribute("aria-expanded", "true");

  const first =
    /** @type {HTMLButtonElement | null} */ (
      el.querySelector("button.menu-item:not(:disabled), button.filter-toggle:not(:disabled)")
    ) ?? enabledItems(el)[0];
  if (first) first.focus();
}
