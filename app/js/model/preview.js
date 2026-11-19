// @ts-check
// The second line of a row in the note list on a phone (architecture.md §9,
// Phone mode): the start of a note's text, and the time of its last change.
//
// Pure functions with no imports, so Node can test them (tests/preview.test.mjs)
// and so the sidebar can call them for every row on every keystroke.

/** How much text a row can show: two lines of a phone in landscape, with room to spare. */
const PREVIEW_MAX = 300;

/**
 * How far into a text the search for its first line with words goes. A note
 * that starts with more blank space than this, or whose first line is longer
 * than this, gets no preview. The bound is the point: the sidebar redraws on
 * every keystroke, and a note can be megabytes of newlines or one line of
 * megabytes (a log, minified JSON).
 */
const HEAD_MAX = 2000;

/**
 * The start of a note's text for its row, as one line.
 *
 * The row already shows the title, and for most notes the title is the first
 * line with words (titleOf in model/docs.js). The preview then starts on the
 * line after it, or the row would say the same thing twice. A note whose title
 * is something else (a rename, a file name) keeps its first line here.
 *
 * "Starts with", not "equals": titleOf cuts a long first line short, so the
 * title is a prefix of that line. The price is a note renamed to the first
 * word of its own first line, which loses the rest of that line from the
 * preview. Equality would need the cut length from docs.js, and this file
 * imports nothing on purpose.
 *
 * Never reads past the head of the text: it cuts the head off first, then
 * walks line ends with indexOf, so the cost does not grow with the note.
 *
 * @param {string} text @param {string} [title] What the row shows as its title.
 * @returns {string}
 */
export function previewOf(text, title) {
  if (!text) return "";
  // First, or indexOf below would search a megabyte line to its end for a
  // newline that is not there. Nothing after this reads further anyway.
  text = text.slice(0, HEAD_MAX + PREVIEW_MAX);
  let start = 0;
  while (start < text.length && start < HEAD_MAX) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    // The window bounds the trim of one very long line; a title is short.
    const line = text.slice(start, Math.min(end, start + PREVIEW_MAX)).trim();
    if (line) {
      if (title && line.startsWith(title)) start = end + 1;
      break;
    }
    start = end + 1;
  }
  return text
    .slice(start, start + PREVIEW_MAX)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

// Made once: constructing an Intl formatter costs far more than using one, and
// the list formats a time for every row on every redraw. `undefined` is the
// device's own locale, so the clock is 12 or 24 hours as the phone is set.
const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const DATE = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

/** Local midnight of the day a time falls in. @param {number} time */
function dayStart(time) {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * A time as short as a mail list shows it: the clock for today, the weekday
 * for the six days before, the day and month for anything older. Each form
 * fits beside a title on a phone; a full date does not.
 *
 * Counted in calendar days, not in 24-hour spans: at nine in the morning,
 * eleven last night is "yesterday" to a person, so it must not show a clock.
 * A time in the future (another device with a fast clock) reads as today.
 *
 * Empty for a time that is no number: Intl throws on one, and this runs
 * inside the draw of the whole sidebar, on a PC too. A record with a broken
 * stamp must cost its row a label, not the app its list.
 *
 * @param {number} then @param {number} [now] @returns {string}
 */
export function shortTime(then, now = Date.now()) {
  if (!Number.isFinite(then)) return "";
  // Rounded: a day with a clock change is 23 or 25 hours long.
  const days = Math.round((dayStart(now) - dayStart(then)) / 86400000);
  if (days <= 0) return TIME.format(then);
  if (days <= 6) return WEEKDAY.format(then);
  return DATE.format(then);
}
