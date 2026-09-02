// @ts-check
// Modal prompts, built on the native <dialog> element. No library, no routing,
// no framework, like the settings panel next door.
//
// Each function appends one dialog, opens it modally, resolves a Promise, and
// removes the element again. Nothing is kept between calls, so no dialog can
// leak a passphrase into a detached DOM node.
//
// The forms use method="dialog", which is what gives Enter-to-submit and the
// submitting button's value in `dialog.returnValue` with no key handling of our
// own. Escape is the browser's own cancel; every dialog here resolves null for
// it, except showSecret (see there).

/**
 * Open a prepared dialog and resolve when it closes.
 *
 * @template T
 * @param {HTMLDialogElement} dialog
 * @param {(returnValue: string) => T} result  Maps the close reason to a value.
 * @returns {Promise<T>}
 */
function openModal(dialog, result) {
  // Captured before showModal moves focus into the dialog, restored after the
  // element is gone: the user must land back where they were, which for a
  // settings action is the button they clicked.
  const returnFocus = document.activeElement;
  document.body.appendChild(dialog);
  return new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => {
        const value = dialog.returnValue;
        dialog.remove();
        if (returnFocus instanceof HTMLElement) returnFocus.focus();
        resolve(result(value));
      },
      { once: true }
    );
    dialog.showModal();
  });
}

/**
 * @param {string} title
 * @returns {{dialog: HTMLDialogElement, form: HTMLFormElement, body: HTMLElement, actions: HTMLElement}}
 */
function shell(title) {
  const dialog = document.createElement("dialog");
  dialog.className = "vrtti-dialog";
  const form = document.createElement("form");
  form.method = "dialog";
  const heading = document.createElement("h2");
  heading.className = "dialog-title";
  heading.textContent = title;
  const body = document.createElement("div");
  body.className = "dialog-body";
  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  form.append(heading, body, actions);
  dialog.appendChild(form);
  return { dialog, form, body, actions };
}

/**
 * @param {string} label
 * @param {string} value
 * @param {boolean} [primary]
 */
function button(label, value, primary = false) {
  const el = document.createElement("button");
  el.type = "submit";
  el.className = primary ? "settings-button dialog-primary" : "settings-button";
  el.value = value;
  el.textContent = label;
  return el;
}

/**
 * @param {HTMLElement} parent
 * @param {string} label
 * @param {string} type
 * @param {string} [value]
 */
function field(parent, label, type, value = "") {
  const wrap = document.createElement("label");
  wrap.className = "dialog-field";
  const text = document.createElement("span");
  text.textContent = label;
  const input = document.createElement("input");
  input.type = type;
  input.value = value;
  input.className = "dialog-input";
  wrap.append(text, input);
  parent.appendChild(wrap);
  return input;
}

/** @param {HTMLElement} parent */
function errorLine(parent) {
  const el = document.createElement("p");
  el.className = "dialog-error";
  el.hidden = true;
  parent.appendChild(el);
  return el;
}

/**
 * Ask for a passphrase, twice when `confirm` is set.
 *
 * @param {{title?: string, label?: string, confirm?: boolean, message?: string}} [opts]
 *   `message` is an inline line above the field, for the unlock retry.
 * @returns {Promise<string | null>} null when the user cancels.
 */
export function askPassphrase(opts = {}) {
  const { dialog, form, body, actions } = shell(opts.title ?? "Passphrase");

  if (opts.message) {
    const note = document.createElement("p");
    note.className = "dialog-error";
    note.textContent = opts.message;
    body.appendChild(note);
  }

  const first = field(body, opts.label ?? "Passphrase", "password");
  const second = opts.confirm ? field(body, "Repeat passphrase", "password") : null;
  const error = errorLine(body);
  actions.append(button("Cancel", "cancel"), button("OK", "ok", true));

  form.addEventListener("submit", (event) => {
    const submitter = /** @type {HTMLButtonElement | null} */ (
      /** @type {SubmitEvent} */ (event).submitter
    );
    if (submitter && submitter.value === "cancel") return;
    /** @param {string} text */
    const fail = (text) => {
      // preventDefault keeps method="dialog" from closing, which is the whole
      // point of validating here instead of after the Promise resolves.
      event.preventDefault();
      error.textContent = text;
      error.hidden = false;
    };
    if (!first.value) return fail("Enter a passphrase.");
    if (second && second.value !== first.value) {
      second.value = "";
      second.focus();
      return fail("The two passphrases are different.");
    }
  });

  // Read before openModal's close handler clears the DOM, and before the
  // element is dropped: the input is gone by the time the Promise resolves.
  const read = () => first.value;
  return openModal(dialog, (value) => (value === "ok" ? read() : null));
}

/**
 * Ask for one line of text.
 * @param {{title?: string, label?: string, value?: string, hint?: string,
 *          allowEmpty?: boolean}} [opts]
 *   `allowEmpty` lets "" through as an answer (the encrypt label: no name is a
 *   valid, deliberate choice there). Everywhere else empty means "try again".
 * @returns {Promise<string | null>} null when the user cancels.
 */
export function askText(opts = {}) {
  const { dialog, form, body, actions } = shell(opts.title ?? "Enter a value");
  const input = field(body, opts.label ?? "Value", "text", opts.value ?? "");
  if (opts.hint) {
    const hint = document.createElement("p");
    hint.className = "settings-hint";
    hint.textContent = opts.hint;
    body.appendChild(hint);
  }
  const error = errorLine(body);
  actions.append(button("Cancel", "cancel"), button("OK", "ok", true));

  form.addEventListener("submit", (event) => {
    const submitter = /** @type {HTMLButtonElement | null} */ (
      /** @type {SubmitEvent} */ (event).submitter
    );
    if (submitter && submitter.value === "cancel") return;
    if (!input.value.trim() && !opts.allowEmpty) {
      event.preventDefault();
      error.textContent = "Enter a value.";
      error.hidden = false;
    }
  });

  const read = () => input.value.trim();
  return openModal(dialog, (value) => (value === "ok" ? read() : null));
}

/**
 * Show a secret exactly once: the recovery identity after setup.
 *
 * This dialog refuses Escape and the backdrop on purpose. The recovery key is
 * generated, shown, and then only its public half is kept; a stray Escape would
 * destroy the one copy that can restore the user's documents. The single way
 * out is the confirm button, which is a deliberate act.
 *
 * @param {{title?: string, text: string, note?: string, confirm?: string}} opts
 * @returns {Promise<void>}
 */
export function showSecret(opts) {
  const { dialog, body, actions } = shell(opts.title ?? "Write this down");

  const secret = document.createElement("pre");
  secret.className = "dialog-secret";
  secret.tabIndex = 0;
  secret.textContent = opts.text;
  body.appendChild(secret);

  if (opts.note) {
    const note = document.createElement("p");
    note.className = "settings-hint";
    note.textContent = opts.note;
    body.appendChild(note);
  }

  const status = document.createElement("p");
  status.className = "settings-hint";
  body.appendChild(status);

  const copy = document.createElement("button");
  copy.type = "button"; // not a submit: copying must not close the dialog
  copy.className = "settings-button";
  copy.textContent = "Copy";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(opts.text);
      status.textContent = "Copied to the clipboard.";
    } catch {
      // A denied clipboard permission is not a failure of the flow: the key is
      // on screen and selectable, which is the path we actually recommend.
      status.textContent = "Copy failed. Select the text and copy it by hand.";
    }
  });

  actions.append(copy, button(opts.confirm ?? "I wrote it down", "done", true));
  dialog.addEventListener("cancel", (event) => event.preventDefault());

  // Not openModal: Chrome's close watcher ignores the cancel preventDefault on
  // a second Escape in a row (anti-abuse rule), so the dialog can still close
  // without the confirm button. Reopening it until returnValue is "done" is
  // the only way to keep the promise that the key was seen and acknowledged.
  const returnFocus = document.activeElement;
  document.body.appendChild(dialog);
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      if (dialog.returnValue !== "done") {
        dialog.returnValue = "";
        dialog.showModal();
        return;
      }
      dialog.remove();
      if (returnFocus instanceof HTMLElement) returnFocus.focus();
      resolve();
    });
    dialog.showModal();
  });
}

/**
 * Pick one of a small set of options.
 * @param {{title?: string, options: {id: string, label: string, hint?: string}[]}} opts
 * @returns {Promise<string | null>} The chosen id, or null when cancelled.
 */
export function choose(opts) {
  const { dialog, body, actions } = shell(opts.title ?? "Choose");
  for (const option of opts.options) {
    const el = document.createElement("button");
    el.type = "submit";
    el.className = "dialog-option";
    el.value = option.id;
    const label = document.createElement("span");
    label.textContent = option.label;
    el.appendChild(label);
    if (option.hint) {
      const hint = document.createElement("span");
      hint.className = "settings-hint";
      hint.textContent = option.hint;
      el.appendChild(hint);
    }
    body.appendChild(el);
  }
  actions.append(button("Cancel", "cancel"));
  const ids = new Set(opts.options.map((o) => o.id));
  return openModal(dialog, (value) => (ids.has(value) ? value : null));
}

/**
 * A modal "working…" panel for a slow step, with no way to dismiss it.
 *
 * Setup and unlock take about a second of scrypt. That work runs in a worker,
 * so this dialog keeps painting; it exists to stop a second click, not to
 * animate. The caller must call close() in a `finally`.
 *
 * @param {string} message
 * @returns {{close: () => void}}
 */
export function showBusy(message) {
  const dialog = document.createElement("dialog");
  dialog.className = "vrtti-dialog";
  const text = document.createElement("p");
  text.className = "dialog-busy";
  text.textContent = message;
  dialog.appendChild(text);
  dialog.addEventListener("cancel", (event) => event.preventDefault());
  const returnFocus = document.activeElement;
  document.body.appendChild(dialog);
  dialog.showModal();
  return {
    close() {
      dialog.close();
      dialog.remove();
      if (returnFocus instanceof HTMLElement) returnFocus.focus();
    },
  };
}
