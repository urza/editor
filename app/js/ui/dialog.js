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
// own. Only the confirming button may be a submit button, because Enter picks
// the first one in the form and not the primary one (see cancelButton).
// Escape is the browser's own cancel; every dialog here resolves null for it,
// except showSecret (see there).

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
 * Cancel, and never a submit button.
 *
 * Enter in a text field triggers implicit submission, which clicks the FIRST
 * submit button of the form, not the primary one. Cancel is first because it
 * reads to the left of OK, so as a submit button it made Enter cancel the
 * dialog. On a phone that is the keyboard's return key, so setup could not be
 * completed by typing (found on iOS, 2026-09-09).
 *
 * @param {HTMLDialogElement} dialog
 * @param {string} [label]
 */
function cancelButton(dialog, label = "Cancel") {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "settings-button";
  el.textContent = label;
  el.addEventListener("click", () => dialog.close("cancel"));
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
 * @param {{title?: string, label?: string, confirm?: boolean, message?: string,
 *          hint?: string}} [opts]
 *   `message` is an inline line above the field, for the unlock retry.
 *   `hint` is the small line under the fields: what the passphrase means, at setup.
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
  if (opts.hint) {
    const hint = document.createElement("p");
    hint.className = "settings-hint";
    hint.textContent = opts.hint;
    body.appendChild(hint);
  }
  const error = errorLine(body);
  actions.append(cancelButton(dialog), button("OK", "ok", true));

  form.addEventListener("submit", (event) => {
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
 *          placeholder?: string, allowEmpty?: boolean}} [opts]
 *   `allowEmpty` lets "" through as an answer (the encrypt label: no name is a
 *   valid, deliberate choice there). Everywhere else empty means "try again".
 * @returns {Promise<string | null>} null when the user cancels.
 */
export function askText(opts = {}) {
  const { dialog, form, body, actions } = shell(opts.title ?? "Enter a value");
  const input = field(body, opts.label ?? "Value", "text", opts.value ?? "");
  if (opts.placeholder) input.placeholder = opts.placeholder;
  if (opts.hint) {
    const hint = document.createElement("p");
    hint.className = "settings-hint";
    hint.textContent = opts.hint;
    body.appendChild(hint);
  }
  const error = errorLine(body);
  actions.append(cancelButton(dialog), button("OK", "ok", true));

  form.addEventListener("submit", (event) => {
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
 * Pick one of a small set of options. `text` is a paragraph above them.
 * `cancel: false` leaves out the Cancel button, for a dialog whose options
 * are its only answers (Escape still closes it, with null).
 * @param {{title?: string, text?: string, cancel?: boolean,
 *          options: {id: string, label: string, hint?: string}[]}} opts
 * @returns {Promise<string | null>} The chosen id, or null when cancelled.
 */
export function choose(opts) {
  const { dialog, body, actions } = shell(opts.title ?? "Choose");
  if (opts.text) {
    const text = document.createElement("p");
    text.className = "settings-hint";
    text.textContent = opts.text;
    body.appendChild(text);
  }
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
  if (opts.cancel !== false) actions.append(cancelButton(dialog));
  const ids = new Set(opts.options.map((o) => o.id));
  return openModal(dialog, (value) => (ids.has(value) ? value : null));
}

/**
 * One paragraph and an OK button: for a step that ends on another device,
 * where nothing else on this screen would say that it is done.
 * @param {{title: string, text: string}} opts
 * @returns {Promise<void>}
 */
export function showNote(opts) {
  const { dialog, body, actions } = shell(opts.title);
  const text = document.createElement("p");
  text.className = "settings-hint";
  text.textContent = opts.text;
  body.appendChild(text);
  actions.append(button("OK", "ok", true));
  return openModal(dialog, () => undefined);
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

const SPACE_MODES = [
  { value: "list", label: "Titles only" },
  { value: "tab", label: "Open as tabs" },
];

/**
 * The spaces of an invite, each with its mode (§27), and the name of the new
 * device. One form for both ends: the device that invites ticks the spaces
 * (`tickable`), the new device only sees them and may change a mode, because
 * the membership is the inviting device's choice and the mode is its own.
 *
 * @param {{title: string, hint?: string, confirm: string,
 *          facts?: {label: string, value: string}[],
 *          name?: {label: string, value: string, placeholder?: string, hint?: string} | null,
 *          tickable?: boolean,
 *          newNotes?: {hint: string},
 *          spaces: {id: string, mode: "tab" | "list", checked?: boolean}[]}} opts
 *   `facts` are read-only lines above the form (the server). `name` null
 *   hides the name field: a device that is set up has its name already.
 *   `newNotes` adds the "New notes" choice of the new device: Local only,
 *   which is its start value, or one of the spaces.
 * @returns {Promise<{name: string, spaces: Record<string, "tab" | "list">, newNotes: string | null} | null>}
 */
export function askInvite(opts) {
  const { dialog, form, body, actions } = shell(opts.title);
  for (const fact of opts.facts ?? []) {
    const line = document.createElement("p");
    line.className = "settings-hint";
    line.textContent = fact.label + ": " + fact.value;
    body.appendChild(line);
  }
  /** @type {HTMLInputElement | null} */
  let nameInput = null;
  if (opts.name) {
    nameInput = field(body, opts.name.label, "text", opts.name.value);
    if (opts.name.placeholder) nameInput.placeholder = opts.name.placeholder;
    if (opts.name.hint) {
      const hint = document.createElement("p");
      hint.className = "settings-hint";
      hint.textContent = opts.name.hint;
      body.appendChild(hint);
    }
  }
  /** @type {{id: string, box: HTMLInputElement | null, select: HTMLSelectElement}[]} */
  const rows = [];
  for (const space of opts.spaces) {
    const row = document.createElement("div");
    row.className = "dialog-space";
    const label = document.createElement("label");
    label.className = "dialog-check";
    /** @type {HTMLInputElement | null} */
    let box = null;
    if (opts.tickable) {
      box = document.createElement("input");
      box.type = "checkbox";
      box.checked = Boolean(space.checked);
      label.appendChild(box);
    }
    const text = document.createElement("span");
    text.textContent = space.id;
    label.appendChild(text);
    const select = document.createElement("select");
    select.className = "settings-select";
    select.setAttribute("aria-label", "Mode of " + space.id);
    for (const mode of SPACE_MODES) {
      const el = document.createElement("option");
      el.value = mode.value;
      el.textContent = mode.label;
      select.appendChild(el);
    }
    select.value = space.mode;
    if (box) {
      const follow = () => (select.disabled = !(/** @type {HTMLInputElement} */ (box).checked));
      box.addEventListener("change", follow);
      follow();
    }
    row.append(label, select);
    body.appendChild(row);
    rows.push({ id: space.id, box, select });
  }
  if (opts.hint) {
    const hint = document.createElement("p");
    hint.className = "settings-hint";
    hint.textContent = opts.hint;
    body.appendChild(hint);
  }
  /** @type {HTMLSelectElement | null} */
  let newNotes = null;
  if (opts.newNotes && opts.spaces.length) {
    const row = document.createElement("label");
    row.className = "dialog-space";
    const text = document.createElement("span");
    text.className = "dialog-check";
    text.textContent = "New notes";
    newNotes = document.createElement("select");
    newNotes.className = "settings-select";
    // Local only first, and so the start value: only the person points new
    // notes at a space (client.js defaultSpace()), also at a join.
    for (const [value, label] of [["", "Local only"], ...opts.spaces.map((s) => [s.id, s.id])]) {
      const el = document.createElement("option");
      el.value = value;
      el.textContent = label;
      newNotes.appendChild(el);
    }
    row.append(text, newNotes);
    const hint = document.createElement("p");
    hint.className = "settings-hint";
    hint.textContent = opts.newNotes.hint;
    body.append(row, hint);
  }
  actions.append(cancelButton(dialog), button(opts.confirm, "ok", true));
  // No tick is a valid answer: an invite for no space joins the device to
  // the server, and the grid in Settings › Devices adds it to spaces later.
  const picked = () => rows.filter((r) => !r.box || r.box.checked);
  const read = () => ({
    name: nameInput ? nameInput.value.trim() : "",
    spaces: Object.fromEntries(picked().map((r) => [r.id, /** @type {"tab" | "list"} */ (r.select.value)])),
    newNotes: newNotes?.value || null,
  });
  return openModal(dialog, (value) => (value === "ok" ? read() : null));
}

/**
 * The invite for a new device, with Copy and Share, the server and the code
 * for typing, its time left, and a live line that says where the join
 * stands. While the dialog is open it calls `check` every few seconds: the
 * inviting device finishes the join at a sync, and the user waits here for
 * exactly that. Escape closes it; the invite stays valid, and the next
 * regular sync still finishes the join.
 *
 * @param {{title: string, text: string, note?: string, expiresAt: number,
 *          typed?: {label: string, facts: {label: string, value: string, code?: boolean}[]},
 *          check: () => Promise<{text?: string, done?: boolean, ok?: boolean}>}} opts
 *   `typed` is the same invite for a person who cannot paste: the lines to
 *   type on the new device. `check` says where the join stands: `text`
 *   replaces the line with the time left, `done` ends the wait (`ok`: the
 *   new device is in).
 * @returns {Promise<void>}
 */
export function showInvite(opts) {
  const { dialog, body, actions } = shell(opts.title);
  const text = document.createElement("pre");
  text.className = "dialog-secret";
  text.tabIndex = 0;
  text.textContent = opts.text;
  body.appendChild(text);
  if (opts.note) {
    const note = document.createElement("p");
    note.className = "settings-hint";
    note.textContent = opts.note;
    body.appendChild(note);
  }
  if (opts.typed) {
    const label = document.createElement("p");
    label.className = "settings-hint";
    label.textContent = opts.typed.label;
    body.appendChild(label);
    for (const fact of opts.typed.facts) {
      const line = document.createElement("p");
      line.className = "dialog-fact";
      const name = document.createElement("span");
      name.textContent = fact.label;
      const value = document.createElement("span");
      value.className = fact.code ? "dialog-fact-value dialog-code" : "dialog-fact-value";
      value.textContent = fact.value;
      line.append(name, value);
      body.appendChild(line);
    }
  }
  const status = document.createElement("p");
  status.className = "settings-hint dialog-live";
  status.setAttribute("aria-live", "polite");
  body.appendChild(status);

  const copy = document.createElement("button");
  copy.type = "button"; // not a submit: copying must not close the dialog
  copy.className = "settings-button";
  copy.textContent = "Copy";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(opts.text);
      copy.textContent = "Copied";
    } catch {
      copy.textContent = "Select and copy";
    }
  });
  actions.append(copy);
  // The share sheet of the system, where there is one (a phone): the person
  // sends the invite to the new device with the app they use for that.
  if (typeof navigator.share === "function") {
    const share = document.createElement("button");
    share.type = "button"; // as Copy
    share.className = "settings-button";
    share.textContent = "Share";
    share.addEventListener("click", () => {
      // A closed share sheet rejects (AbortError). Nothing to report: the
      // invite is still on the screen.
      navigator.share({ text: opts.text }).catch(() => {});
    });
    actions.append(share);
  }
  actions.append(button("Done", "ok", true));

  let done = false;
  let checking = false;
  /** The line from the last check, in the place of the time left. */
  let override = "";
  const tick = () => {
    if (done) return;
    const left = Math.max(0, Math.round((opts.expiresAt - Date.now()) / 1000));
    status.textContent =
      override ||
      (left
        ? "Waiting for the new device. Keep vrtti open on this device. Works once, for " +
          Math.floor(left / 60) +
          ":" +
          String(left % 60).padStart(2, "0") +
          " more."
        : "The invite expired. Make a new one.");
  };
  const poll = async () => {
    // A minute past the code's end the regular sync takes over: a join that
    // started just in time still finishes, without a sync every 3 seconds
    // for a dialog left open.
    if (Date.now() > opts.expiresAt + 60 * 1000) clearInterval(poller);
    if (done || checking) return;
    checking = true;
    try {
      const state = await opts.check();
      override = state.text ?? "";
      tick();
      if (state.done) {
        done = true;
        status.classList.toggle("dialog-ok", Boolean(state.ok));
      }
    } catch (err) {
      console.log("[vrtti] invite check failed", err);
    } finally {
      checking = false;
    }
  };
  tick();
  const clock = setInterval(tick, 1000);
  const poller = setInterval(poll, 3000);
  dialog.addEventListener("close", () => {
    clearInterval(clock);
    clearInterval(poller);
  });
  return openModal(dialog, () => undefined);
}

/**
 * The first step on a device that wants to sync: one field for what the
 * other device gave (an invite, or a code typed by hand), and one option for
 * the device that has no other device. A code alone does not say where the
 * server is, so the server field shows while the text is a code.
 *
 * The dialog knows nothing about invites and codes: `isCode` and `check`
 * come from the caller, so the rules stay next to the join (main.js).
 *
 * @param {{title: string, label: string, placeholder?: string, hint: string,
 *          message?: string, value?: string, url?: string,
 *          again?: {label: string, hint: string},
 *          first: {label: string, hint: string},
 *          isCode: (text: string) => boolean,
 *          check: (text: string, url: string) => string}} opts
 *   `message` is why the last try failed; `value` and `url` are what the
 *   person typed then. `check` returns what is wrong with the two values,
 *   or "" when they can go on. `again` is an option above the field, for a
 *   device that synced before and needs nothing from another device.
 * @returns {Promise<{kind: "first"} | {kind: "again"} | {kind: "text", text: string, url: string} | null>}
 */
export function askConnect(opts) {
  const { dialog, form, body, actions } = shell(opts.title);
  // Not submit buttons: Enter in the field must mean "Next", and Enter
  // picks the first submit button of the form (see cancelButton).
  /** @param {{label: string, hint: string}} option @param {string} value */
  const option = (option, value) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "dialog-option";
    const label = document.createElement("span");
    label.textContent = option.label;
    const hint = document.createElement("span");
    hint.className = "settings-hint";
    hint.textContent = option.hint;
    el.append(label, hint);
    el.addEventListener("click", () => dialog.close(value));
    body.appendChild(el);
  };
  if (opts.again) option(opts.again, "again");
  const input = field(body, opts.label, "text", opts.value ?? "");
  if (opts.placeholder) input.placeholder = opts.placeholder;
  // A phone must not turn a code into a word with a capital letter.
  input.autocapitalize = "off";
  input.autocomplete = "off";
  input.spellcheck = false;
  // type "text" and not "url": the browser checks a url field itself, also
  // while the field is hidden, and then refuses the submit with no message.
  // opts.check says what is wrong with the address instead.
  const urlInput = field(body, "Server URL", "text", opts.url ?? "");
  urlInput.inputMode = "url";
  urlInput.autocapitalize = "off";
  urlInput.spellcheck = false;
  urlInput.placeholder = "https://sync.example.com";
  const urlField = /** @type {HTMLElement} */ (urlInput.parentElement);
  const hint = document.createElement("p");
  hint.className = "settings-hint";
  hint.textContent = opts.hint;
  body.appendChild(hint);
  const error = errorLine(body);
  if (opts.message) {
    error.textContent = opts.message;
    error.hidden = false;
  }
  const follow = () => (urlField.hidden = !opts.isCode(input.value));
  input.addEventListener("input", follow);
  follow();

  option(opts.first, "first");

  actions.append(cancelButton(dialog), button("Next", "ok", true));
  form.addEventListener("submit", (event) => {
    const problem = opts.check(input.value.trim(), urlInput.value.trim());
    if (!problem) return;
    event.preventDefault();
    error.textContent = problem;
    error.hidden = false;
  });

  const read = () => ({ kind: /** @type {"text"} */ ("text"), text: input.value.trim(), url: urlInput.value.trim() });
  return openModal(dialog, (value) =>
    value === "ok" ? read() : value === "first" || value === "again" ? { kind: value } : null
  );
}

/**
 * A wait that ends on another device, shown step by step: a line for each
 * step, with a tick once it is done. `poll` runs at the start and then every
 * `every` milliseconds and returns the whole view. The person can close the
 * dialog at any time: the wait goes on without it, so closing is "Close"
 * and not "Cancel".
 *
 * @param {{title: string, every: number,
 *          poll: () => Promise<{title?: string, lines: {text: string, ok: boolean}[],
 *                               result?: string, hint?: string, done?: boolean}>}} opts
 *   `result` is the green line of the end, `hint` the small line below.
 * @returns {Promise<void>}
 */
export function showProgress(opts) {
  const { dialog, form, body, actions } = shell(opts.title);
  const heading = /** @type {HTMLElement} */ (form.querySelector(".dialog-title"));
  body.setAttribute("aria-live", "polite");
  const close = button("Close", "ok");
  actions.append(close);

  let done = false;
  let polling = false;
  const poll = async () => {
    if (done || polling) return;
    polling = true;
    try {
      const view = await opts.poll();
      heading.textContent = view.title ?? opts.title;
      /** @type {HTMLElement[]} */
      const lines = view.lines.map((step) => {
        const line = document.createElement("p");
        line.className = step.ok ? "dialog-step dialog-step-ok" : "dialog-step";
        const mark = document.createElement("span");
        mark.textContent = step.ok ? "✓" : "…";
        const text = document.createElement("span");
        text.textContent = step.text;
        line.append(mark, text);
        return line;
      });
      for (const [value, className] of [
        [view.result, "dialog-busy dialog-ok"],
        [view.hint, "settings-hint"],
      ]) {
        if (!value) continue;
        const line = document.createElement("p");
        line.className = className;
        line.textContent = value;
        lines.push(line);
      }
      body.replaceChildren(...lines);
      if (view.done) {
        done = true;
        close.textContent = "OK";
        close.classList.add("dialog-primary");
        clearInterval(timer);
      }
    } catch (err) {
      console.log("[vrtti] progress check failed", err);
    } finally {
      polling = false;
    }
  };
  void poll();
  const timer = setInterval(poll, opts.every);
  dialog.addEventListener("close", () => clearInterval(timer));
  return openModal(dialog, () => undefined);
}
