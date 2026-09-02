// @ts-check
// One small popup menu, the kind that hangs off a "⋯" button (architecture.md
// §9). No library, no framework.
//
// The menu renders into document.body, not next to its button: #sidebar-scroll
// scrolls with overflow, and a menu built inside a row would be clipped at the
// scroller edge. Body plus position:fixed coordinates is what escapes that.
//
// One menu exists at a time. Opening a second one closes the first.

/**
 * One entry. A separator needs nothing else; every other item needs a label.
 *
 * @typedef {Object} MenuItem
 * @property {boolean} [separator]
 * @property {string} [label]
 * @property {string} [hint]      Small second line, e.g. why the item is off.
 * @property {boolean} [checked]  Present (true or false) means a checkable item.
 * @property {boolean} [disabled]
 * @property {() => any} [act]
 */

const GAP = 4;

/** @type {{ el: HTMLElement, anchor: HTMLElement, onKey: (e: KeyboardEvent) => void, onDown: (e: Event) => void, onAway: () => void } | null} */
let current = null;

/** @param {{restoreFocus?: boolean}} [opts] */
export function closeMenu({ restoreFocus = false } = {}) {
  if (!current) return;
  const { el, anchor, onKey, onDown, onAway } = current;
  current = null;
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("pointerdown", onDown, true);
  window.removeEventListener("scroll", onAway, true);
  window.removeEventListener("resize", onAway);
  el.remove();
  // Only on Escape and after an item ran: a click somewhere else is already
  // moving the focus, and stealing it back would fight the user.
  if (restoreFocus && anchor.isConnected) anchor.focus();
}

/** @param {HTMLElement} el @returns {HTMLButtonElement[]} */
function enabledItems(el) {
  return /** @type {HTMLButtonElement[]} */ ([
    ...el.querySelectorAll("button.menu-item:not(:disabled)"),
  ]);
}

/**
 * Place the menu under its anchor, and keep it inside the window.
 * @param {HTMLElement} el @param {HTMLElement} anchor
 */
function place(el, anchor) {
  const rect = anchor.getBoundingClientRect();
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

/**
 * @param {HTMLElement} anchor The button the menu belongs to.
 * @param {MenuItem[]} items
 */
export function openMenu(anchor, items) {
  closeMenu();
  // A row can be redrawn between the click and this call (a rename committing
  // on blur redraws the list). A detached anchor has a zero rect, and the menu
  // would land in the window corner; better to open nothing.
  if (!anchor.isConnected) return;

  const el = document.createElement("div");
  el.className = "menu";
  el.setAttribute("role", "menu");

  for (const item of items) {
    if (item.separator) {
      const line = document.createElement("div");
      line.className = "menu-sep";
      el.appendChild(line);
      continue;
    }

    const button = document.createElement("button");
    button.className = "menu-item";
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
    button.appendChild(check);

    const text = document.createElement("span");
    text.className = "menu-text";
    const label = document.createElement("span");
    label.className = "menu-label";
    label.textContent = item.label ?? "";
    text.appendChild(label);
    if (item.hint) {
      const hint = document.createElement("span");
      hint.className = "menu-hint";
      hint.textContent = item.hint;
      text.appendChild(hint);
    }
    button.appendChild(text);

    button.addEventListener("click", () => {
      // Close first: the item may redraw the list the anchor lives in.
      closeMenu({ restoreFocus: true });
      if (item.act) item.act();
    });
    el.appendChild(button);
  }

  document.body.appendChild(el);
  place(el, anchor);

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
    const at = buttons.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
    const step = event.key === "ArrowDown" ? 1 : -1;
    // Wraps at both ends, like every native menu.
    buttons[(at + step + buttons.length) % buttons.length].focus();
  };

  /** @param {Event} event */
  const onDown = (event) => {
    if (event.target instanceof Node && el.contains(event.target)) return;
    closeMenu();
  };

  // A menu is placed once. Anything that moves its anchor closes it instead of
  // chasing it: capture:true is what catches a scroll inside the sidebar.
  const onAway = () => closeMenu();

  window.addEventListener("keydown", onKey, true);
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("scroll", onAway, true);
  window.addEventListener("resize", onAway);
  current = { el, anchor, onKey, onDown, onAway };

  const first = enabledItems(el)[0];
  if (first) first.focus();
}
