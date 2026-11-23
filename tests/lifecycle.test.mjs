// Unit tests for pure note-lifecycle helpers (app/js/model/lifecycle.js).
//
//   node --test tests/lifecycle.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  daysLeft,
  isRecentExpired,
  RECENT_KEEP,
  spaceBadge,
  stubTitle,
  TRASH_KEEP,
} from "../app/js/model/lifecycle.js";

const DAY = 24 * 60 * 60 * 1000;

test("spaceBadge derives 1-2 uppercase initials from word parts", () => {
  assert.equal(spaceBadge("personal"), "P");
  assert.equal(spaceBadge("infra"), "I");
  assert.equal(spaceBadge("dev-work"), "DW");
  assert.equal(spaceBadge("dev-hobby"), "DH");
  assert.equal(spaceBadge("my_long_space_name"), "ML");
  assert.equal(spaceBadge("--dev--ops--"), "DO");
  assert.equal(spaceBadge("x"), "X");
  assert.equal(spaceBadge(""), "");
  assert.equal(spaceBadge("---"), "");
});

test("isRecentExpired respects 30d window, missing closedAt, sync, and file.unwritten", () => {
  const now = 1_800_000_000_000;
  assert.equal(RECENT_KEEP, 30 * DAY);
  assert.equal(TRASH_KEEP, 30 * DAY);

  // 29d old -> not expired; 31d old -> expired.
  assert.equal(
    isRecentExpired({ id: "1", createdAt: now - 40 * DAY, updatedAt: now - 40 * DAY, closedAt: now - 29 * DAY }, now),
    false
  );
  assert.equal(
    isRecentExpired({ id: "2", createdAt: now - 40 * DAY, updatedAt: now - 40 * DAY, closedAt: now - 31 * DAY }, now),
    true
  );

  // Records without closedAt never expire until startup stamps closedAt = now.
  assert.equal(
    isRecentExpired({ id: "3", createdAt: now - 40 * DAY, updatedAt: now - 29 * DAY }, now),
    false
  );
  assert.equal(
    isRecentExpired({ id: "4", createdAt: now - 60 * DAY, updatedAt: now - 60 * DAY }, now),
    false
  );

  // Skips synced notes, trashed notes, keyring records, and unwritten files.
  assert.equal(
    isRecentExpired(
      {
        id: "5",
        createdAt: now - 60 * DAY,
        updatedAt: now - 60 * DAY,
        closedAt: now - 60 * DAY,
        sync: { rev: 1, dirty: false, space: "personal" },
      },
      now
    ),
    false
  );
  assert.equal(
    isRecentExpired(
      {
        id: "6",
        createdAt: now - 60 * DAY,
        updatedAt: now - 60 * DAY,
        closedAt: now - 60 * DAY,
        trashedAt: now - 5 * DAY,
      },
      now
    ),
    false
  );
  assert.equal(
    isRecentExpired(
      {
        id: "7",
        kind: "keyring",
        createdAt: now - 60 * DAY,
        updatedAt: now - 60 * DAY,
      },
      now
    ),
    false
  );
  assert.equal(
    isRecentExpired(
      {
        id: "8",
        kind: "file",
        createdAt: now - 60 * DAY,
        updatedAt: now - 60 * DAY,
        closedAt: now - 60 * DAY,
        file: { handleId: "h1", name: "a.md", unwritten: true },
      },
      now
    ),
    false
  );
  // Clean local file older than 30d DOES expire.
  assert.equal(
    isRecentExpired(
      {
        id: "9",
        kind: "file",
        createdAt: now - 60 * DAY,
        updatedAt: now - 60 * DAY,
        closedAt: now - 31 * DAY,
        file: { handleId: "h2", name: "b.md" },
      },
      now
    ),
    true
  );
});

test("stubTitle never leaks a PIN-locked note's first line", () => {
  // PIN note with explicit user title keeps user title.
  assert.equal(
    stubTitle({ title: "Bank notes", line: "secret pin 9999", pin: true }),
    "Bank notes"
  );
  // PIN note without user title returns "" and NEVER falls back to line.
  assert.equal(
    stubTitle({ title: "", line: "secret first line", pin: true }),
    ""
  );
  assert.equal(
    stubTitle({ line: "secret first line", pin: true }),
    ""
  );
  // Non-PIN note prefers explicit title, else falls back to first line.
  assert.equal(
    stubTitle({ title: "Custom", line: "First line", pin: false }),
    "Custom"
  );
  assert.equal(
    stubTitle({ title: "", line: "First line" }),
    "First line"
  );
  assert.equal(stubTitle({}), "");
});

test("daysLeft clamps cleanly to at least 1 day and rounds up", () => {
  const now = 1_800_000_000_000;
  assert.equal(daysLeft(now, TRASH_KEEP, now), 30);
  assert.equal(daysLeft(now - 25 * DAY, TRASH_KEEP, now), 5);
  assert.equal(daysLeft(now - 29.5 * DAY, TRASH_KEEP, now), 1);
  assert.equal(daysLeft(now - 40 * DAY, TRASH_KEEP, now), 1);
});
