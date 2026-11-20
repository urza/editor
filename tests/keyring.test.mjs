// The keyring record and the recipient sets (architecture.md §13.3, §27).
//
//   node --test tests/*.test.mjs
//
// Plain Node: crypto/keyring.js is pure apart from its storage calls, and
// nothing here reaches one. The trust rules of §21 and §26 went with §27;
// who reads a note follows from the space log (tests/spaces.test.mjs).
//
// Outside app/ on purpose: everything under app/ is deployed and precached.

import assert from "node:assert/strict";
import { test } from "node:test";

// model/channel.js reads `window` at import time. An empty object is a window
// without BroadcastChannel, so no channel opens and Node can exit.
globalThis.window = /** @type {any} */ ({});

const { KeyRing, entryKey, mergeKeyringContent, readKeyringContent } = await import("../app/js/crypto/keyring.js");

const entry = (id, signKey = "ab".repeat(32)) => ({ id, name: id, recipient: "age1" + id, signKey, addedAt: 1 });

test("the record merges as a union of entries, server order first", () => {
  const local = { v: 2, devices: [entry("a"), entry("b")] };
  const remote = { v: 2, devices: [entry("c"), entry("a")] };
  assert.deepEqual(
    mergeKeyringContent(local, remote).devices.map((d) => d.id),
    ["c", "a", "b"]
  );
  // Two entries under one id are two claims; the merge keeps both.
  const twice = mergeKeyringContent({ devices: [entry("a", "cd".repeat(32))] }, remote);
  assert.equal(twice.devices.filter((d) => d.id === "a").length, 2);
});

test("malformed rows and rows without a signing key drop out", () => {
  const content = readKeyringContent({
    content: JSON.stringify({
      devices: [entry("ok"), { id: "old", name: "x", recipient: "age1x", addedAt: 1 }, { ...entry("x"), id: "a\nb" }, null, 5],
    }),
  });
  assert.deepEqual(content?.devices.map((d) => d.id), ["ok"]);
  assert.equal(readKeyringContent({ content: "not json" }), null);
});

test("the entry key holds every field, one per line", () => {
  assert.equal(entryKey(entry("a")), ["vrtti-device", "a", "a", "age1a", "ab".repeat(32), "1"].join("\n"));
});

test("a space note goes to its members and the recovery keys; nothing guesses members", () => {
  const kr = new KeyRing();
  kr.stored = { v: 2, deviceId: "me", deviceName: "me", deviceRecipient: "age1me", signKey: "x", createdAt: 1, askPassphrase: true, recoveryRecipients: ["age1rec"] };
  assert.deepEqual(kr.recipientsFor("space", ["age1me", "age1you"]), ["age1me", "age1you", "age1rec"]);
  assert.deepEqual(kr.recipientsFor("this-device"), ["age1me", "age1rec"]);
  // A local note from before §27 keeps its preset; it goes to this device only.
  assert.deepEqual(kr.recipientsFor("all-devices"), ["age1me", "age1rec"]);
  assert.throws(() => kr.recipientsFor("space", []));
});

test("a v1 row needs the one-time upgrade and asks for its passphrase", () => {
  const kr = new KeyRing();
  kr.stored = { v: 1, deviceId: "me", wrappedIdentity: "x" };
  assert.equal(kr.needsUpgrade, true);
  assert.equal(kr.askPassphrase, true);
});
