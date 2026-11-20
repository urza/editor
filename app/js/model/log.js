// @ts-check
// The app's own log, readable on a phone (Settings › Update › Log).
//
// A phone has no console the user can open, so an error there was a dialog to
// catch and a screenshot, and the reason behind it was gone. This keeps the
// last lines the app writes with console.log("[vrtti] …"), every
// console.error and console.warn, and uncaught errors, across reloads, so
// "copy the log" answers what went wrong the first time.
//
// The lines are what the app logs: note ids, spaces, steps and error texts,
// never the text of a note. They stay in this browser's localStorage.

const KEY = "vrtti.log";
const MAX_LINES = 200;
const MAX_LINE = 600;

/** @type {string[]} */
let lines = [];
try {
  const stored = JSON.parse(localStorage.getItem(KEY) ?? "[]");
  if (Array.isArray(stored)) lines = stored.filter((l) => typeof l === "string").slice(-MAX_LINES);
} catch {
  // No localStorage (a private window, a blocked origin): the log lives in
  // memory for this page only.
}

/** @param {unknown} value @returns {string} */
function show(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.name + ": " + value.message;
  if (value && typeof value === "object" && "name" in value && "message" in value) {
    // A DOMException from another realm, and the like.
    return String(/** @type {any} */ (value).name) + ": " + String(/** @type {any} */ (value).message);
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** @param {string} level @param {unknown[]} args */
function record(level, args) {
  const time = new Date().toISOString().slice(11, 19);
  const text = args.map(show).join(" ").slice(0, MAX_LINE);
  lines.push(time + (level === "log" ? " " : " " + level + " ") + text);
  if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
  try {
    localStorage.setItem(KEY, JSON.stringify(lines));
  } catch {
    // Full or blocked: the memory copy still serves this page.
  }
}

let installed = false;

/** Start recording. Call once, as early as possible. */
export function installLog() {
  if (installed) return;
  installed = true;
  for (const level of /** @type {const} */ (["log", "warn", "error"])) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      // Only the app's own log lines: libraries (the spellcheck engines)
      // log a lot, and those lines would push the useful ones out.
      if (level !== "log" || (typeof args[0] === "string" && args[0].startsWith("[vrtti]"))) {
        record(level, args);
      }
      original(...args);
    };
  }
  window.addEventListener("error", (event) => record("error", ["uncaught", event.message, event.filename + ":" + event.lineno]));
  window.addEventListener("unhandledrejection", (event) => record("error", ["unhandled", event.reason]));
}

/** The log, oldest line first. @returns {string} */
export function logText() {
  return lines.join("\n");
}
