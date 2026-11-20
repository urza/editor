// The space log and the join code (architecture.md §27), as tests.
//
//   node --test tests/*.test.mjs
//
// Plain Node, no browser and no packages: crypto/spaces.js is pure. A device
// is an entry key and a hex signing secret; "the server" is the list of
// entry texts a test hands to replay().
//
// Outside app/ on purpose: everything under app/ is deployed and precached.

import assert from "node:assert/strict";
import { test } from "node:test";

const spaces = await import("../app/js/crypto/spaces.js");
const sign = await import("../app/js/crypto/sign.js");
const age = await import("../app/js/crypto/age.js");
// keyring.js (for entryKey) imports the channel, which reads `window` at
// import time; spaces.js itself needs no window.
globalThis.window = /** @type {any} */ ({});
const { entryKey } = await import("../app/js/crypto/keyring.js");

/** A device: its entry key and its signer. */
async function device(id) {
  const { recipient } = await age.generateIdentity();
  const signing = sign.generateSigningKey();
  const key = entryKey({ id, name: id, recipient, signKey: signing.public, addedAt: 1 });
  return { id, key, signer: signing.secret };
}

/** Append an entry signed by `by` to `log`, in place. */
async function append(log, by, op, device, color, space = "personal") {
  log.push(await spaces.nextEntry(log, { op, space, device: device.key, color }, by.key, by.signer));
  return log;
}

const phone = await device("phone");
const desk = await device("desk");
const dev = await device("dev");

test("create, add and remove give the member list", async () => {
  const log = [];
  await append(log, phone, "create", phone, "#6699CC");
  await append(log, phone, "add", desk);
  await append(log, desk, "add", dev);
  await append(log, dev, "remove", phone);
  const state = spaces.replay(log, phone.key);
  assert.equal(state.error, undefined);
  assert.equal(state.seq, 4);
  assert.deepEqual(state.members, [desk.key, dev.key]);
  assert.deepEqual(state.known, [phone.key, desk.key, dev.key]);
  assert.equal(state.color, "#6699CC");
});

test("the first entry counts only for the pinned creator", async () => {
  const log = await append([], dev, "create", dev);
  const state = spaces.replay(log, phone.key);
  assert.match(state.error ?? "", /pinned creator/);
  assert.deepEqual(state.members, []);
  assert.equal(state.seq, 0);
});

test("a create of another device is refused", async () => {
  const log = [];
  log.push(await spaces.nextEntry(log, { op: "create", space: "personal", device: dev.key }, phone.key, phone.signer));
  assert.match(spaces.replay(log, phone.key).error ?? "", /create of its author/);
});

test("a forged signature stops the replay there", async () => {
  const log = await append([], phone, "create", phone);
  // dev signs, but the entry claims phone as its author.
  log.push(await spaces.makeEntry(
    { seq: 2, prev: spaces.hashEntry(log[0]), op: "add", space: "personal", device: dev.key, by: phone.key },
    (m) => sign.sign(m, dev.signer)
  ));
  await append(log, phone, "add", desk);
  const state = spaces.replay(log, phone.key);
  assert.match(state.error ?? "", /entry 2: bad signature/);
  assert.deepEqual(state.members, [phone.key]);
  assert.equal(state.seq, 1);
});

test("a broken prev or a gap in seq stops the replay", async () => {
  const log = await append([], phone, "create", phone);
  const badPrev = await spaces.makeEntry(
    { seq: 2, prev: "00".repeat(32), op: "add", space: "personal", device: desk.key, by: phone.key },
    (m) => sign.sign(m, phone.signer)
  );
  assert.match(spaces.replay([...log, badPrev], phone.key).error ?? "", /prev does not match/);
  const gap = await spaces.makeEntry(
    { seq: 3, prev: spaces.hashEntry(log[0]), op: "add", space: "personal", device: desk.key, by: phone.key },
    (m) => sign.sign(m, phone.signer)
  );
  assert.match(spaces.replay([...log, gap], phone.key).error ?? "", /wrong seq/);
});

test("a removed member's entries do not count, also with an old seq", async () => {
  const log = [];
  await append(log, phone, "create", phone);
  await append(log, phone, "add", dev);
  await append(log, phone, "remove", dev);
  // dev appends after its removal.
  const late = [...log];
  await append(late, dev, "add", desk);
  assert.match(spaces.replay(late, phone.key).error ?? "", /author is not a member/);
  // dev writes an entry for the position of its removal, to undo it: it does
  // not replace the real entry 3, and a log that holds it instead of the real
  // one makes dev's entry the third, which removes nobody.
  const forked = log.slice(0, 2);
  await append(forked, dev, "add", desk);
  const state = spaces.replay(forked, phone.key);
  assert.equal(state.error, undefined);
  assert.deepEqual(state.members, [phone.key, dev.key, desk.key]);
  // A server that shows the real log shows the removal; dev's fork shares
  // entries 1 and 2, but its entry 3 cannot follow the real entry 3.
  const mixed = [...log, forked[2]];
  assert.match(spaces.replay(mixed, phone.key).error ?? "", /entry 4/);
});

test("the last member cannot remove itself", async () => {
  const log = await append([], phone, "create", phone);
  await append(log, phone, "remove", phone);
  assert.match(spaces.replay(log, phone.key).error ?? "", /last member/);
});

test("an add of a member and a remove of a non-member do not count", async () => {
  const log = await append([], phone, "create", phone);
  await append(log, phone, "add", phone);
  assert.match(spaces.replay(log, phone.key).error ?? "", /already a member/);
  const log2 = await append([], phone, "create", phone);
  await append(log2, phone, "remove", desk);
  assert.match(spaces.replay(log2, phone.key).error ?? "", /not a member/);
});

test("a color entry changes the color and nothing else", async () => {
  const log = await append([], phone, "create", phone, "#6699CC");
  await append(log, phone, "add", desk);
  await append(log, desk, "color", desk, "#EC5F67");
  const state = spaces.replay(log, phone.key);
  assert.equal(state.color, "#EC5F67");
  assert.deepEqual(state.members, [phone.key, desk.key]);
  assert.equal(spaces.nextColor(["#6699CC", "#F9AE58"]), "#99C794");
});

test("an entry of another space is refused", async () => {
  const log = await append([], phone, "create", phone);
  await append(log, phone, "add", desk, undefined, "work");
  assert.match(spaces.replay(log, phone.key).error ?? "", /another space/);
});

test("re-encryption follows the log position", () => {
  // A key that replaces a key keeps the member count, but moves the position.
  assert.equal(spaces.needsReencrypt(3, 5), true);
  // A device that is behind after a removal leaves the newer note alone.
  assert.equal(spaces.needsReencrypt(6, 5), false);
  assert.equal(spaces.needsReencrypt(5, 5), false);
  assert.equal(spaces.needsReencrypt(undefined, 1), true);
});

test("the join code: format, normalization, slot", () => {
  const code = spaces.newCode();
  assert.equal(code.length, 10);
  assert.equal(spaces.normalizeCode(spaces.formatCode(code).toLowerCase()), code);
  assert.equal(spaces.normalizeCode("k7mq2 - xwd4p"), "K7MQ2XWD4P");
  assert.equal(spaces.normalizeCode("o1l00-00000"), "01100000000".slice(0, 10));
  assert.equal(spaces.normalizeCode("K7MQ2-XWD4"), "");
  assert.equal(spaces.normalizeCode("K7MQ2-XWD4U"), "");
  assert.equal(spaces.slotOf("K7MQ2XWD4P"), "K7M");
});

test("the verifier, the proof and the reply MAC come from the code", async () => {
  const code = "K7MQ2XWD4P";
  const verifier = await spaces.joinVerifier(code);
  assert.equal(verifier, await spaces.joinVerifier(code));
  assert.notEqual(verifier, await spaces.joinVerifier("K7MQ2XWD4Q"));

  const proof = await spaces.joinProof(code, dev.key);
  assert.ok(spaces.sameHex(proof, await spaces.joinProof(code, dev.key)));
  // The server swaps the new device's keys: the proof no longer matches.
  assert.ok(!spaces.sameHex(proof, await spaces.joinProof(code, desk.key)));

  const reply = JSON.stringify({ member: phone.key, creators: { personal: phone.key } });
  const mac = await spaces.joinReplyMac(code, reply);
  assert.ok(spaces.sameHex(mac, await spaces.joinReplyMac(code, reply)));
  // A reply with a changed creator fails.
  const forged = JSON.stringify({ member: phone.key, creators: { personal: dev.key } });
  assert.ok(!spaces.sameHex(mac, await spaces.joinReplyMac(code, forged)));
  assert.ok(!spaces.sameHex(mac, "zz"));
});

test("an entry key parses, and a bad one does not", () => {
  assert.equal(spaces.parseEntryKey(dev.key)?.id, "dev");
  assert.equal(spaces.parseEntryKey("vrtti-device\nx"), null);
  assert.equal(spaces.parseEntryKey(dev.key.replace("age1", "xyz1")), null);
});
