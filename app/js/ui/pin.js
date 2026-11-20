// @ts-check
// The PIN lock (architecture.md §27): a guard for the screen, not encryption.
//
// One PIN for each device, stored on that device as a salted PBKDF2 hash. A
// note carries only the mark (`record.pin`, and `sealed.pin` when it syncs).
// The right PIN opens every locked note of the device, in every window; the
// notes lock again when the app starts, and when all of its windows stay
// hidden for five minutes. After five wrong PINs the pad waits 30 seconds,
// and the count survives a reload.

import { getSetting, putSetting } from "../storage/idb.js";
import { on, post } from "../model/channel.js";

const HASH_KEY = "pin.hash";
const FAILS_KEY = "pin.fails";
const PIN_LENGTH = 4;
const MAX_FAILS = 5;
const WAIT = 30 * 1000;
const HIDDEN_LOCK = 5 * 60 * 1000;
// A visible window says so this often, so a hidden one knows not to lock.
const HEARTBEAT = 60 * 1000;
// PBKDF2 makes each guess at a stolen hash cost something; the pad's own
// wait is what stops guessing on the device.
const ITERATIONS = 200000;

/**
 * @param {string} pin @param {Uint8Array} salt @returns {Promise<string>} Hex.
 */
async function hashPin(pin, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS }, key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The pad: four digits, the phone's number keyboard.
 * @param {{title: string, message?: string}} opts
 * @returns {Promise<string | null>}
 */
function askDigits(opts) {
  const dialog = document.createElement("dialog");
  dialog.className = "vrtti-dialog";
  const form = document.createElement("form");
  form.method = "dialog";
  const heading = document.createElement("h2");
  heading.className = "dialog-title";
  heading.textContent = opts.title;
  const input = document.createElement("input");
  input.className = "dialog-input pin-input";
  input.type = "password";
  // inputmode, not type="number": a number field drops leading zeros and
  // shows spinners, and a PIN is four digits, not a number.
  input.inputMode = "numeric";
  input.autocomplete = "off";
  input.maxLength = PIN_LENGTH;
  input.pattern = "[0-9]{" + PIN_LENGTH + "}";
  input.setAttribute("aria-label", "PIN");
  const message = document.createElement("p");
  message.className = "dialog-error";
  message.hidden = !opts.message;
  message.textContent = opts.message ?? "";
  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "settings-button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => dialog.close("cancel"));
  const ok = document.createElement("button");
  ok.type = "submit";
  ok.value = "ok";
  ok.className = "settings-button dialog-primary";
  ok.textContent = "OK";
  actions.append(cancel, ok);
  form.append(heading, message, input, actions);
  dialog.appendChild(form);
  form.addEventListener("submit", (event) => {
    if (!new RegExp("^[0-9]{" + PIN_LENGTH + "}$").test(input.value)) {
      event.preventDefault();
      message.textContent = "Four digits.";
      message.hidden = false;
    }
  });
  // The fourth digit is the answer: no OK press on a phone.
  input.addEventListener("input", () => {
    if (input.value.length === PIN_LENGTH && /^[0-9]+$/.test(input.value)) form.requestSubmit(ok);
  });
  // The chord table listens on window, so Alt+W here would close a buffer.
  input.addEventListener("keydown", (event) => event.stopPropagation());
  const returnFocus = document.activeElement;
  document.body.appendChild(dialog);
  return new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => {
        const value = dialog.returnValue === "ok" ? input.value : null;
        dialog.remove();
        if (returnFocus instanceof HTMLElement) returnFocus.focus();
        resolve(value);
      },
      { once: true }
    );
    dialog.showModal();
    input.focus();
  });
}

/**
 * @param {{store: ReturnType<import("../model/docs.js").createDocStore>,
 *          notice: (text: string) => void}} deps
 */
export function mountPin({ store, notice }) {
  let open = false;
  let lastVisibleAt = Date.now();

  /** @param {boolean} broadcast */
  function lock(broadcast) {
    if (!open) return;
    open = false;
    store.pinLock();
    if (broadcast) post("pin-lock", {});
  }

  function unlockHere() {
    if (open) return;
    open = true;
    store.pinUnlock();
  }

  on("pin-open", () => unlockHere());
  on("pin-lock", () => lock(false));
  on("pin-visible", ({ at }) => {
    lastVisibleAt = Math.max(lastVisibleAt, at);
  });
  // A window that opens late asks whether the notes are open.
  on("pin-who-is-open", () => {
    if (open) post("pin-open", {});
  });
  post("pin-who-is-open", {});

  function beat() {
    if (document.visibilityState !== "visible") return;
    lastVisibleAt = Date.now();
    post("pin-visible", { at: lastVisibleAt });
  }
  document.addEventListener("visibilitychange", beat);
  setInterval(() => {
    beat();
    // Hidden here, and no window said it was visible for five minutes.
    if (document.visibilityState !== "visible" && Date.now() - lastVisibleAt > HIDDEN_LOCK) lock(true);
  }, HEARTBEAT / 2);
  beat();

  /** @returns {Promise<{count: number, until: number}>} */
  async function fails() {
    return (await getSetting(FAILS_KEY)) ?? { count: 0, until: 0 };
  }

  /**
   * Ask the PIN and check it. True once the right one was typed.
   * @param {string} title
   */
  async function check(title) {
    const stored = await getSetting(HASH_KEY);
    if (!stored) return true;
    let message = "";
    for (;;) {
      const state = await fails();
      const wait = state.until - Date.now();
      if (wait > 0) message = "Too many wrong PINs. Wait " + Math.ceil(wait / 1000) + " seconds.";
      const pin = await askDigits({ title, message });
      if (pin === null) return false;
      if ((await fails()).until > Date.now()) continue;
      const salt = Uint8Array.from(stored.salt);
      if ((await hashPin(pin, salt)) === stored.hash) {
        await putSetting(FAILS_KEY, { count: 0, until: 0 });
        return true;
      }
      const count = state.count + 1;
      const until = count >= MAX_FAILS ? Date.now() + WAIT : 0;
      await putSetting(FAILS_KEY, { count: count >= MAX_FAILS ? 0 : count, until });
      message = until ? "Too many wrong PINs. Wait 30 seconds." : "Wrong PIN.";
    }
  }

  /** A new PIN, typed twice. False when the user walks away. */
  async function choose() {
    for (let attempt = 0; attempt < 3; attempt++) {
      const first = await askDigits({ title: "Choose a PIN for this device" });
      if (first === null) return false;
      const second = await askDigits({ title: "Type the PIN again" });
      if (second === null) return false;
      if (first === second) {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        await putSetting(HASH_KEY, { salt: [...salt], hash: await hashPin(first, salt) });
        return true;
      }
      notice("the two PINs differ");
    }
    return false;
  }

  return {
    get isOpen() {
      return open;
    },
    /** The pad for the locked notes. True when they are open afterwards. */
    async unlock() {
      if (open) return true;
      if (!(await check("Locked note"))) return false;
      unlockHere();
      post("pin-open", {});
      return true;
    },
    /** "Lock with PIN": a device without a PIN chooses one first. @param {string} id */
    async lockNote(id) {
      if (!(await getSetting(HASH_KEY)) && !(await choose())) return false;
      await store.setPin(id, true);
      return true;
    },
    /** "Remove PIN lock" asks the PIN. @param {string} id */
    async unlockNote(id) {
      if (!(await check("Remove the PIN lock"))) return false;
      await store.setPin(id, false);
      return true;
    },
    /** For "Copy text", "History…" and a backup: the PIN when the note or the device has one. */
    async allow(/** @type {string} */ title) {
      if (open) return true;
      if (!(await check(title))) return false;
      unlockHere();
      post("pin-open", {});
      return true;
    },
  };
}
