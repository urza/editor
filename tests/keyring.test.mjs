// The trust rules of the device list (architecture.md §21, §26), as tests.
//
//   node --test tests/*.test.mjs
//
// Plain Node, no browser and no packages: crypto/keyring.js is pure apart
// from its storage calls, and nothing here reaches one. A device is built by
// hand (the fields setup() stores), and "the server" is whatever content a
// test hands to pull(). What needs IndexedDB or a window (confirm() and
// migratePins() storing a pin, the applyRemote door in model/docs.js) is
// covered by the browser gate, not here.
//
// Outside app/ on purpose: everything under app/ is deployed and precached.

import assert from "node:assert/strict";
import { test } from "node:test";

// model/channel.js reads `window` at import time. An empty object is a window
// without BroadcastChannel, so no channel opens and Node can exit.
globalThis.window = /** @type {any} */ ({});

const { KeyRing, entryKey, keyringContentFor, mergeKeyringContent, readKeyringContent } =
  await import("../app/js/crypto/keyring.js");
const age = await import("../app/js/crypto/age.js");
const sign = await import("../app/js/crypto/sign.js");

/** The wire: content leaves a device and arrives as JSON. */
const wire = (content) => JSON.parse(JSON.stringify(content));

/** A device as setup() leaves it, unlocked, with its own entry as its record. */
async function device(id, name, createdAt) {
  const identity = await age.generateIdentity();
  const signing = sign.generateSigningKey();
  const kr = new KeyRing();
  kr.stored = {
    v: 1,
    deviceId: id,
    deviceName: name,
    deviceRecipient: identity.recipient,
    wrappedIdentity: "x",
    recoveryRecipients: [],
    createdAt,
    signKey: signing.public,
    wrappedSigning: "x",
    selfApprovals: {},
    trusted: [],
    pins: {},
  };
  kr.signing = signing.secret;
  kr.setContent(keyringContentFor(kr));
  return { kr, identity, signing, id };
}

/** What applyRemoteKeyring does with a pulled copy: local first, server second. */
function pull(kr, serverContent) {
  kr.setContent(mergeKeyringContent(kr.content, readKeyringContent({ content: JSON.stringify(serverContent) })));
}

/** What confirm() stores, without the storage call. */
function pin(kr, other) {
  const entry = other.kr.ownEntry();
  kr.stored = {
    ...kr.stored,
    pins: { ...kr.stored.pins, [entry.id]: { signKey: entry.signKey, recipient: entry.recipient } },
    trusted: [...kr.stored.trusted, entry.id],
  };
}

/** A different six digits than `code`. */
function wrongCode(code) {
  const digits = code.replace(/\D/g, "");
  return (digits[0] === "9" ? "0" : "9") + digits.slice(1);
}

/** Desktop (elder) and Phone (joiner), joined the way §21 describes. */
async function joined() {
  const d = await device("dev-d", "Desktop", 1000);
  const p = await device("dev-p", "Phone", 2000);
  pull(d.kr, p.kr.content);
  const approved = d.kr.approve(entryKey(p.kr.ownEntry()), p.kr.pairingCode);
  assert.ok(approved, "the right code signs");
  d.kr.setContent(approved);
  pull(p.kr, wire(approved));
  pin(p.kr, d);
  return { d, p, server: wire(approved) };
}

const attacker = await age.generateIdentity();

test("a device alone encrypts to itself", async () => {
  const d = await device("dev-d", "Desktop", 1000);
  assert.deepEqual(d.kr.recipientsFor("all-devices"), [d.identity.recipient]);
});

test("the join: code, approval, confirmation, then both read", async () => {
  const d = await device("dev-d", "Desktop", 1000);
  const p = await device("dev-p", "Phone", 2000);

  pull(d.kr, p.kr.content);
  assert.deepEqual(d.kr.pendingJoins().map((e) => e.id), ["dev-p"]);
  assert.ok(!d.kr.recipientsFor("all-devices").includes(p.identity.recipient), "not before the code");

  const key = entryKey(p.kr.ownEntry());
  assert.equal(d.kr.approve(key, wrongCode(p.kr.pairingCode)), null, "a wrong code signs nothing");
  const approved = d.kr.approve(key, p.kr.pairingCode);
  d.kr.setContent(approved);
  assert.ok(d.kr.recipientsFor("all-devices").includes(p.identity.recipient));
  assert.deepEqual(d.kr.pendingJoins(), []);

  pull(p.kr, wire(approved));
  assert.deepEqual(p.kr.pendingJoins(), [], "the joiner never vets its elder");
  assert.deepEqual(p.kr.pendingApprovers().map((e) => e.id), ["dev-d"]);
  assert.ok(!p.kr.recipientsFor("all-devices").includes(d.identity.recipient), "not before the confirmation");
  assert.equal(p.kr.fingerprint(p.kr.pendingApprovers()[0]), d.kr.fingerprint(), "both screens show one fingerprint");

  pin(p.kr, d);
  assert.deepEqual(p.kr.pendingApprovers(), []);
  assert.ok(p.kr.recipientsFor("all-devices").includes(d.identity.recipient));
});

test("a third device is trusted through the chain of approvals", async () => {
  const { d, p, server } = await joined();
  const l = await device("dev-l", "Laptop", 3000);
  pull(d.kr, mergeKeyringContent(l.kr.content, server));
  const approved = d.kr.approve(entryKey(l.kr.ownEntry()), l.kr.pairingCode);
  d.kr.setContent(approved);
  pull(p.kr, wire(approved));
  assert.ok(p.kr.recipientsFor("all-devices").includes(l.identity.recipient), "Phone trusts Laptop through Desktop");
  assert.deepEqual(p.kr.pendingJoins(), [], "and is not asked for a code");
});

test("an entry nobody signed is a row, not a reader", async () => {
  const { d, server } = await joined();
  const evil = { id: "dev-evil", name: "Phone", recipient: attacker.recipient, addedAt: 5000, signKey: sign.generateSigningKey().public, approvals: [] };
  pull(d.kr, { ...server, devices: [...server.devices, evil] });
  assert.ok(!d.kr.recipientsFor("all-devices").includes(attacker.recipient));
  assert.equal(d.kr.deviceRows().find((r) => r.id === "dev-evil").state, "waiting");
});

test("the server cannot change this device's own recipient", async () => {
  const { d, p, server } = await joined();
  for (const victim of [d, p]) {
    const tampered = wire(server);
    tampered.devices.find((e) => e.id === victim.id).recipient = attacker.recipient;
    pull(victim.kr, tampered);
    assert.ok(!victim.kr.recipientsFor("all-devices").includes(attacker.recipient), victim.id);
    assert.ok(victim.kr.recipientsFor("all-devices").includes(victim.identity.recipient));
    assert.equal(victim.kr.audit().own, 1, "and the device says so");
  }
});

test("a second entry under this device's id is ignored, with or without a forged approval", async () => {
  const { d, server } = await joined();
  const forger = sign.generateSigningKey();
  // The attacker's own row under Desktop's id, with the attacker's signing
  // key, and a helper device "approved" with that key in Desktop's name.
  const twin = { id: "dev-d", name: "Desktop", recipient: attacker.recipient, addedAt: 1000, signKey: forger.public, approvals: [] };
  const helper = { id: "dev-h", name: "Tablet", recipient: attacker.recipient, addedAt: 6000, signKey: sign.generateSigningKey().public, approvals: [] };
  const payload = ["vrtti-device", helper.id, helper.name, helper.recipient, helper.signKey, String(helper.addedAt)].join("\n");
  helper.approvals.push({ by: "dev-d", sig: sign.sign(payload, forger.secret) });
  pull(d.kr, { ...server, devices: [twin, ...server.devices, helper] });
  assert.ok(!d.kr.recipientsFor("all-devices").includes(attacker.recipient));
  assert.deepEqual([...d.kr.trustedIds()].sort(), ["dev-d", "dev-p"]);
});

test("the server cannot change a confirmed device's recipient", async () => {
  const { d, p, server } = await joined();
  const tampered = wire(server);
  tampered.devices.find((e) => e.id === "dev-d").recipient = attacker.recipient;
  pull(p.kr, tampered);
  const set = p.kr.recipientsFor("all-devices");
  assert.ok(!set.includes(attacker.recipient), "the swapped entry is not a reader");
  assert.ok(set.includes(d.identity.recipient), "and the confirmed entry still is");
  assert.deepEqual(p.kr.audit().conflicts, ["Desktop"]);
  const rows = p.kr.deviceRows().filter((r) => r.id === "dev-d");
  assert.deepEqual(rows.map((r) => [r.state, r.conflict]).sort(), [["not confirmed", true], ["trusted", false]]);
});

test("a second entry under an approved device's id is ignored", async () => {
  const { d, p, server } = await joined();
  const twin = { ...wire(server).devices.find((e) => e.id === "dev-p"), recipient: attacker.recipient };
  pull(d.kr, { ...server, devices: [...server.devices, twin] });
  const set = d.kr.recipientsFor("all-devices");
  assert.ok(!set.includes(attacker.recipient), "the approval signs the recipient, the copy has none that verifies");
  assert.ok(set.includes(p.identity.recipient));
});

test("the pairing code and the fingerprint cover the recipient", async () => {
  const d = await device("dev-d", "Desktop", 1000);
  const p = await device("dev-p", "Phone", 2000);
  // The joiner's entry reaches the elder with its real signing key and the
  // attacker's recipient: the code the user reads off the phone must not sign it.
  const swapped = wire(p.kr.content);
  swapped.devices[0].recipient = attacker.recipient;
  pull(d.kr, swapped);
  const key = entryKey(d.kr.pendingJoins()[0]);
  assert.equal(d.kr.approve(key, p.kr.pairingCode), null);
  assert.notEqual(d.kr.fingerprint(d.kr.pendingJoins()[0]), p.kr.fingerprint());
  assert.match(p.kr.fingerprint(), /^[0-9A-F]{4}( [0-9A-F]{4}){3}$/);
  assert.match(p.kr.pairingCode, /^\d{3} \d{3}$/);
});

test("an approver the user did not confirm is asked about, never trusted", async () => {
  const p = await device("dev-p", "Phone", 2000);
  // A fabricated elder that signs the phone's real entry: valid signature,
  // unknown key. It is a question for the user, and its fingerprint is its own.
  const fake = await device("dev-d", "Desktop", 1000);
  pull(fake.kr, p.kr.content);
  const approved = fake.kr.approve(entryKey(p.kr.ownEntry()), p.kr.pairingCode);
  pull(p.kr, wire(approved));
  assert.deepEqual(p.kr.pendingApprovers().map((e) => e.id), ["dev-d"]);
  assert.ok(!p.kr.recipientsFor("all-devices").includes(fake.identity.recipient));
});

test("the upgrade pins a device confirmed by id, from its approval of this device", async () => {
  const d = await device("dev-d", "Desktop", 1000);
  const p = await device("dev-p", "Phone", 2000);
  pull(d.kr, p.kr.content);
  const approved = d.kr.approve(entryKey(p.kr.ownEntry()), p.kr.pairingCode);
  pull(p.kr, wire(approved));
  // The state a page from before §26 left behind: an id, no pin.
  p.kr.stored = { ...p.kr.stored, trusted: ["dev-d"], pins: undefined };
  assert.ok(!p.kr.recipientsFor("all-devices").includes(d.identity.recipient), "an id alone is no root any more");
  const pins = p.kr.pinsFromTrusted();
  assert.deepEqual(pins, { "dev-d": { signKey: d.signing.public, recipient: d.identity.recipient } });
  p.kr.stored = { ...p.kr.stored, pins };
  assert.ok(p.kr.recipientsFor("all-devices").includes(d.identity.recipient));
  assert.equal(p.kr.pinsFromTrusted(), null, "a second run adds nothing");
  assert.deepEqual(p.kr.audit(), { own: 0, conflicts: [], unpinned: [] });
});

test("the upgrade pins nothing for an id whose approval does not verify", async () => {
  const p = await device("dev-p", "Phone", 2000);
  const stranger = await device("dev-d", "Desktop", 1000);
  pull(p.kr, stranger.kr.content);
  p.kr.stored = { ...p.kr.stored, trusted: ["dev-d"], pins: undefined };
  assert.equal(p.kr.pinsFromTrusted(), null);
  assert.deepEqual(p.kr.audit().unpinned, ["Desktop"]);
});

test("a recovery key counts only with an approval by a trusted device", async () => {
  const { d, p, server } = await joined();
  const recovery = await age.generateIdentity();
  const signed = wire(server);
  signed.recovery = [recovery.recipient, attacker.recipient];
  signed.recoveryApprovals = {
    [recovery.recipient]: [{ by: "dev-d", sig: sign.sign("vrtti-recovery\n" + recovery.recipient, d.signing.secret) }],
    [attacker.recipient]: [{ by: "dev-d", sig: sign.sign("vrtti-recovery\n" + attacker.recipient, sign.generateSigningKey().secret) }],
    constructor: [{ by: "dev-d", sig: "AAAA" }],
  };
  pull(p.kr, signed);
  const set = p.kr.recipientsFor("this-device");
  assert.ok(set.includes(recovery.recipient));
  assert.ok(!set.includes(attacker.recipient));
});

test("selfUpdate adds this device's entry and never removes a row", async () => {
  const { d, server } = await joined();
  assert.equal(d.kr.selfUpdate(), null, "the record already says it");
  const tampered = wire(server);
  tampered.devices.find((e) => e.id === "dev-d").recipient = attacker.recipient;
  // A device that lost its local copy and pulls a record with a swapped own row.
  d.kr.content = null;
  d.kr.setContent(readKeyringContent({ content: JSON.stringify(tampered) }));
  const next = d.kr.selfUpdate();
  assert.ok(next, "the real entry goes back in");
  const own = next.devices.filter((e) => e.id === "dev-d");
  assert.equal(own.length, 2);
  assert.ok(own.some((e) => e.recipient === d.identity.recipient));
});

test("the merge is a union: both claims stay, and it settles", async () => {
  const { d, p, server } = await joined();
  const swapped = wire(server);
  swapped.devices.find((e) => e.id === "dev-d").recipient = attacker.recipient;
  const merged = mergeKeyringContent(p.kr.content, swapped);
  assert.equal(merged.devices.filter((e) => e.id === "dev-d").length, 2);
  // Idempotent, and the dirty test of applyRemoteKeyring: a copy with nothing
  // to add equals the server's copy merged alone.
  assert.deepEqual(wire(mergeKeyringContent(merged, merged)), wire(merged));
  assert.deepEqual(wire(mergeKeyringContent(wire(server), server)), wire(mergeKeyringContent(null, server)));
  assert.notDeepEqual(wire(mergeKeyringContent(merged, server)), wire(mergeKeyringContent(null, server)));
  // The other device ends with the same set, whatever order the copies met in.
  const viaD = mergeKeyringContent(d.kr.content, wire(merged));
  assert.deepEqual(viaD.devices.map(entryKey).sort(), merged.devices.map(entryKey).sort());
});

test("an entry from before signing keys gives way to the same entry with one", () => {
  const old = { id: "dev-o", name: "Old", recipient: "age1old", addedAt: 500, approvals: [] };
  const grown = { ...old, signKey: "ab".repeat(32) };
  for (const [local, remote] of [[{ v: 1, devices: [old], recovery: [] }, { v: 1, devices: [grown], recovery: [] }], [{ v: 1, devices: [grown], recovery: [] }, { v: 1, devices: [old], recovery: [] }]]) {
    const merged = mergeKeyringContent(local, remote);
    assert.deepEqual(merged.devices.map((e) => e.signKey), [grown.signKey]);
  }
});

test("a malformed record degrades, it never throws", async () => {
  const d = await device("dev-d", "Desktop", 1000);
  const hostile = {
    v: 1,
    devices: [null, 5, "x", { id: "__proto__", name: "p", recipient: "age1p", addedAt: 1 }, { id: "dev-x" }, { id: "dev-y", name: "Y", recipient: "age1y", addedAt: 7, signKey: "zz", approvals: [null, 3, { by: "dev-d" }, { by: "dev-d", sig: 9 }, { by: "dev-d", sig: "!!!" }] }, { id: "dev-z", name: 4, recipient: "age1z", addedAt: 7 }],
    recovery: [null, 7, "age1r"],
    // Parsed, not written as a literal: only JSON makes "__proto__" a key.
    recoveryApprovals: JSON.parse('{"age1r":"nope","__proto__":[{"by":"dev-d","sig":"x"}]}'),
  };
  pull(d.kr, hostile);
  assert.deepEqual(d.kr.content.devices.map((e) => e.id), ["dev-y", "dev-d"]);
  assert.deepEqual(d.kr.recipientsFor("all-devices"), [d.identity.recipient]);
  assert.equal(d.kr.deviceRows().length, 2);
  assert.equal(d.kr.audit().own, 0);
  for (const content of ["", "{", "null", "[]", '{"devices":5}', '{"devices":[],"recovery":5,"recoveryApprovals":[1]}']) {
    assert.doesNotThrow(() => readKeyringContent({ content }));
  }
});
