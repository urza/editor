// The row preview and the short time of the phone note list (architecture.md
// §9, Phone mode), as tests.
//
//   node --test tests/*.test.mjs
//
// Plain Node, no browser and no packages: model/preview.js is pure and
// imports nothing.
//
// Outside app/ on purpose: everything under app/ is deployed and precached.

import assert from "node:assert/strict";
import { test } from "node:test";

const { previewOf, shortTime } = await import("../app/js/model/preview.js");

test("the preview starts after the line the title shows", () => {
  assert.equal(previewOf("Prague trip\n\nFlight at 7:40\nHotel near the river", "Prague trip"),
    "Flight at 7:40 Hotel near the river");
});

test("blank lines before the title line do not count", () => {
  assert.equal(previewOf("\n  \nGroceries\nmilk\neggs", "Groceries"), "milk eggs");
});

test("a title cut from a long first line still matches that line", () => {
  const first = "A first line that runs well past the forty characters a title keeps";
  assert.equal(previewOf(first + "\nsecond line", first.slice(0, 40)), "second line");
});

test("a title that is not the first line keeps the first line", () => {
  assert.equal(previewOf("# Heading\nbody", "notes.md"), "# Heading body");
  assert.equal(previewOf("line one\nline two"), "line one line two");
});

test("a note of one line has no preview", () => {
  assert.equal(previewOf("only the title", "only the title"), "");
  assert.equal(previewOf("only the title\n\n   \n", "only the title"), "");
});

test("an empty or blank text has no preview", () => {
  assert.equal(previewOf("", "untitled"), "");
  assert.equal(previewOf("\n\n  \n", "untitled"), "");
});

test("a long text gives a bounded preview", () => {
  const text = "Title\n" + "word ".repeat(100000);
  const preview = previewOf(text, "Title");
  assert.ok(preview.startsWith("word word"));
  assert.ok(preview.length <= 300);
});

test("a very long title line with no second line gives no preview", () => {
  assert.equal(previewOf("x".repeat(50000), "x".repeat(40)), "");
});

// The expected strings come from formatters built here, with the same
// options: the test is about which form a time gets, and the form's letters
// depend on the locale of the machine that runs it.
const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const date = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

/** Local time, so the test does not depend on the machine's zone. */
const at = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const now = at(19, 9, 0);

test("today shows the clock", () => {
  assert.equal(shortTime(at(19, 7, 40), now), clock.format(at(19, 7, 40)));
  assert.equal(shortTime(at(19, 0, 0), now), clock.format(at(19, 0, 0)));
});

test("last night is a weekday, not a clock, though it is under 24 hours ago", () => {
  assert.equal(shortTime(at(18, 23, 0), now), weekday.format(at(18, 23, 0)));
});

test("the six days before today show the weekday", () => {
  assert.equal(shortTime(at(13, 12), now), weekday.format(at(13, 12)));
});

test("a week ago and older show the day and the month", () => {
  assert.equal(shortTime(at(12, 12), now), date.format(at(12, 12)));
  assert.equal(shortTime(at(1, 12), now), date.format(at(1, 12)));
});

test("a broken time gives no label and does not throw", () => {
  assert.equal(shortTime(/** @type {any} */ (undefined), now), "");
  assert.equal(shortTime(NaN, now), "");
});

test("a time in the future reads as today", () => {
  assert.equal(shortTime(at(20, 12), now), clock.format(at(20, 12)));
});
