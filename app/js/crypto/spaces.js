// @ts-check
// Spaces as groups of devices (architecture.md §27), as pure functions: the
// signed space log, its replay into a member list, and the join code.
//
// The model, in the user's words: a space works like a group chat for
// devices. A device has a key; a space is a list of devices; any member adds
// and removes devices; the last member cannot remove itself; a note is in one
// space, and only the members of that space can read it.
//
// The list follows from the log, never from the server's member table. Each
// entry is signed by its author, names the entry before it by hash, and
// counts only when its author is a member at that point. The server stores
// the log and can hide its newest entries; it cannot add a member, because it
// cannot sign, and it cannot reorder entries, because each is bound to the
// one before it.
//
// No storage, no network, no window: tests/spaces.test.mjs runs this in Node.

import { scryptAsync } from "../../vendor/@noble/hashes/scrypt.js";
import { hmac } from "../../vendor/@noble/hashes/hmac.js";
import { sha256 } from "../../vendor/@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "../../vendor/@noble/hashes/utils.js";
import { sha256Hex, sign, verify } from "./sign.js";

/** The Mariana set (sublime-defaults.md part 2.3). A new space takes the first free one. */
export const PALETTE = ["#6699CC", "#F9AE58", "#99C794", "#EC5F67", "#C695C6", "#5FB4B4", "#FAC863"];

/** @typedef {"create" | "add" | "remove" | "color"} Op */

/**
 * One log entry. `device` and `by` are entry keys (crypto/keyring.js); `prev`
 * is the hash of the entry before, null for the first.
 * @typedef {{seq: number, prev: string | null, op: Op, space: string,
 *            device: string, by: string, color?: string, sig: string}} Entry
 */

/**
 * The state a log replays to.
 * @typedef {Object} SpaceState
 * @property {number} seq  The last entry that counted: the log position (`spaceSeq`).
 * @property {string[]} members  Entry keys, in the order they joined.
 * @property {string[]} known  Every entry key the log named, members and removed.
 * @property {string} color
 * @property {string} creator  The entry key of the `create`.
 * @property {string} [error]  Why the replay stopped before the end.
 */

/**
 * The fields of an entry key (`vrtti-device`, id, name, recipient, sign key,
 * added time), or null for a string that is not one.
 * @param {string} key
 * @returns {{id: string, name: string, recipient: string, signKey: string, addedAt: number} | null}
 */
export function parseEntryKey(key) {
  if (typeof key !== "string") return null;
  const parts = key.split("\n");
  if (parts.length !== 6 || parts[0] !== "vrtti-device") return null;
  const [, id, name, recipient, signKey, added] = parts;
  const addedAt = Number(added);
  if (!id || !recipient.startsWith("age1") || !/^[0-9a-f]{64}$/.test(signKey) || !Number.isFinite(addedAt)) return null;
  return { id, name, recipient, signKey, addedAt };
}

/**
 * The bytes a signature covers: every field but `sig`, one per line, with a
 * label first so a signature over an entry can never pass for anything else.
 * @param {Omit<Entry, "sig">} e
 */
export function signedText(e) {
  return ["vrtti-space-log", String(e.seq), e.prev ?? "", e.op, e.space, e.device, e.by, e.color ?? ""].join("\n");
}

/**
 * A signed entry as the text that goes to the server. The text is stored and
 * hashed as it is (the next `prev`), so it is built once, here, and never
 * re-serialized anywhere.
 * @param {Omit<Entry, "sig">} fields
 * @param {(message: string) => Promise<string>} signWith  The author's signer.
 * @returns {Promise<string>}
 */
export async function makeEntry(fields, signWith) {
  /** @type {Entry} */
  const entry = { seq: fields.seq, prev: fields.prev, op: fields.op, space: fields.space, device: fields.device, by: fields.by, sig: "" };
  if (fields.color !== undefined) entry.color = fields.color;
  entry.sig = await signWith(signedText(entry));
  return JSON.stringify(entry);
}

/** The `prev` of the entry after this one. @param {string} text */
export function hashEntry(text) {
  return sha256Hex(text);
}

/**
 * The next entry of a log, signed by `byKey` with `signer`.
 * @param {string[]} log  The texts so far.
 * @param {{op: Op, space: string, device: string, color?: string}} what
 * @param {string} byKey @param {import("./sign.js").Signer} signer
 */
export function nextEntry(log, what, byKey, signer) {
  const seq = log.length + 1;
  return makeEntry(
    { seq, prev: seq === 1 ? null : hashEntry(log[log.length - 1]), ...what, by: byKey },
    (message) => sign(message, signer)
  );
}

/** @param {any} e @returns {e is Entry} */
function isEntry(e) {
  return (
    e && typeof e === "object" &&
    Number.isInteger(e.seq) &&
    (e.prev === null || typeof e.prev === "string") &&
    ["create", "add", "remove", "color"].includes(e.op) &&
    typeof e.space === "string" && typeof e.device === "string" &&
    typeof e.by === "string" && typeof e.sig === "string" &&
    (e.color === undefined || /^#[0-9A-Fa-f]{6}$/.test(e.color))
  );
}

/**
 * Replay a log into its members (architecture.md §27).
 *
 * An entry counts when: its seq is the next one; its prev is the hash of the
 * entry before (null for the first); its author is a member at that point;
 * its signature verifies with the author's key; and its op makes sense (an
 * add of a non-member, a remove of a member that is not the last one). The
 * first entry is a `create` of its own author, and it counts only when that
 * author is the creator this device pinned when it made or joined the space.
 *
 * The replay stops at the first entry that does not count, and nothing after
 * it counts either: an entry is bound to the one before it, so a gap means
 * the rest hangs off something this device refused. A removed device can
 * still sign entries, but it cannot place one before its removal.
 * @param {string[]} log  The entry texts, in seq order.
 * @param {string} creator  The pinned entry key of the space's creator.
 * @returns {SpaceState}
 */
export function replay(log, creator) {
  /** @type {SpaceState} */
  const state = { seq: 0, members: [], known: [], color: PALETTE[0], creator };
  /** @type {string | null} */
  let space = null;
  for (let i = 0; i < log.length; i++) {
    /** @type {any} */
    let e;
    try {
      e = JSON.parse(log[i]);
    } catch {
      return { ...state, error: "entry " + (i + 1) + " is not JSON" };
    }
    const fail = (/** @type {string} */ why) => ({ ...state, error: "entry " + (i + 1) + ": " + why });
    if (!isEntry(e)) return fail("malformed");
    if (e.seq !== i + 1) return fail("wrong seq");
    if (i === 0) {
      if (e.prev !== null) return fail("a first entry has no prev");
      if (e.op !== "create" || e.device !== e.by) return fail("the first entry is a create of its author");
      if (e.by !== creator) return fail("not the pinned creator");
      space = e.space;
    } else {
      if (e.prev !== hashEntry(log[i - 1])) return fail("prev does not match");
      if (e.space !== space) return fail("another space");
      if (!state.members.includes(e.by)) return fail("the author is not a member");
      if (e.op === "create") return fail("a second create");
    }
    const author = parseEntryKey(e.by);
    if (!author || !parseEntryKey(e.device)) return fail("malformed device");
    if (!verify(e.sig, signedText(e), author.signKey)) return fail("bad signature");

    const members = [...state.members];
    let color = state.color;
    if (e.op === "create" || e.op === "add") {
      if (members.includes(e.device)) return fail("already a member");
      members.push(e.device);
      if (e.op === "create" && e.color) color = e.color;
    } else if (e.op === "remove") {
      if (!members.includes(e.device)) return fail("not a member");
      if (members.length === 1) return fail("the last member cannot remove itself");
      members.splice(members.indexOf(e.device), 1);
    } else if (e.color) {
      color = e.color;
    }
    const known = state.known.includes(e.device) ? state.known : [...state.known, e.device];
    Object.assign(state, { seq: e.seq, members, known, color });
  }
  return state;
}

/**
 * The note was encrypted for an older member list than this device knows:
 * encrypt it again (architecture.md §27). A higher spaceSeq than the device
 * applied means this device is behind, and it leaves the note alone, or it
 * would add back a device that was removed.
 * @param {number | undefined} encSeq  `meta.enc.spaceSeq` of the note.
 * @param {number} applied  The log position this device applied.
 */
export function needsReencrypt(encSeq, applied) {
  return applied > 0 && (encSeq ?? 0) < applied;
}

/** The first palette color no space uses yet; the palette repeats after seven. @param {string[]} used */
export function nextColor(used) {
  return PALETTE.find((c) => !used.includes(c)) ?? PALETTE[used.length % PALETTE.length];
}

// ---- The join code --------------------------------------------------------
//
// Ten characters of Crockford base32, shown as `K7MQ2-XWD4P`. The first three
// are the public slot id; the server never sees the other seven. The member
// sends the server a verifier, the new device sends a proof over its device
// entry, and the member answers with a reply under a MAC: all three come from
// the code through scrypt, each with its own salt (architecture.md §27).

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 10;
// N 2^15 costs a phone a few hundred milliseconds, three times per join. The
// cost is what makes a guess against a verifier the server saw expensive.
const SCRYPT = { N: 1 << 15, r: 8, p: 1, dkLen: 32 };

/** A fresh code, ten characters. */
export function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  // 256 is a multiple of 32, so the modulo is unbiased.
  return [...bytes].map((b) => CROCKFORD[b % 32]).join("");
}

/** `K7MQ2XWD4P` as `K7MQ2-XWD4P`. @param {string} code */
export function formatCode(code) {
  return code.slice(0, 5) + "-" + code.slice(5);
}

/**
 * The code as typed, in its canonical form, or "" when it is not one. Case,
 * dashes and spaces do not matter, and the letters Crockford reads as digits
 * (O, I, L) count as those digits.
 * @param {string} typed
 */
export function normalizeCode(typed) {
  const code = String(typed || "")
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return code.length === CODE_LENGTH && [...code].every((c) => CROCKFORD.includes(c)) ? code : "";
}

const INVITE_PREFIX = "vrtti-invite:";

/**
 * @typedef {{url: string, code: string, name: string, spaces: Record<string, "tab" | "list">}} Invite
 *   One paste for a new device (§27): the server, the join code, the name the
 *   new device starts with, and the mode each space opens in there.
 */

/**
 * The invite as one line: a prefix and base64url JSON. base64url, so the line
 * survives chats, mail and a URL hash without escapes. It holds the join
 * code, so it is a secret as long as the code is.
 * @param {Invite} invite
 */
export function encodeInvite(invite) {
  const json = JSON.stringify({ v: 1, u: invite.url, c: invite.code, n: invite.name, s: invite.spaces });
  const bytes = encoder.encode(json);
  const b64 = btoa(String.fromCharCode(...bytes));
  return INVITE_PREFIX + b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The invite in a pasted text, or null when the text holds none. Lenient
 * about what surrounds it (a chat adds quotes, spaces and line breaks), strict
 * about the content: a bad URL or code makes the whole invite null, and a
 * space with an unknown mode is dropped. The space names are checked where
 * they are used, against the spaces the join reply gives.
 * @param {string} text
 * @returns {Invite | null}
 */
export function decodeInvite(text) {
  const match = /vrtti-invite:([A-Za-z0-9_-]+)/.exec(String(text || "").replace(/\s+/g, ""));
  if (!match) return null;
  let data;
  try {
    const b64 = match[1].replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!data || data.v !== 1 || typeof data.u !== "string" || !/^https?:\/\/\S+$/.test(data.u)) return null;
  const code = normalizeCode(data.c);
  if (!code) return null;
  /** @type {Record<string, "tab" | "list">} */
  const spaces = {};
  for (const [space, mode] of Object.entries(data.s && typeof data.s === "object" ? data.s : {})) {
    if (mode === "tab" || mode === "list") spaces[space] = mode;
  }
  // One line: the name becomes a line of the device's entry key (keyring.js).
  const name = typeof data.n === "string" ? data.n.replace(/\s+/g, " ").trim().slice(0, 64) : "";
  return { url: data.u, code, name, spaces };
}

/** The public part. @param {string} code */
export function slotOf(code) {
  return code.slice(0, 3);
}

const encoder = new TextEncoder();

/** @param {string} code @param {string} salt */
async function derive(code, salt) {
  return scryptAsync(encoder.encode(code), encoder.encode(salt), SCRYPT);
}

/** What the member gives the server to check the new device's code. @param {string} code */
export async function joinVerifier(code) {
  return bytesToHex(await derive(code, "vrtti-join-verify"));
}

/**
 * The new device's proof that it typed the code, bound to its device entry:
 * without it, the server could swap the new device's keys.
 * @param {string} code @param {string} entry
 */
export async function joinProof(code, entry) {
  return bytesToHex(hmac(sha256, await derive(code, "vrtti-join-proof"), encoder.encode(entry)));
}

/**
 * The MAC over the member's reply. Not a signature: the new device does not
 * know the member's key yet, so a server could sign a fake reply and pin
 * itself as a creator.
 * @param {string} code @param {string} reply
 */
export async function joinReplyMac(code, reply) {
  return bytesToHex(hmac(sha256, await derive(code, "vrtti-join-reply"), encoder.encode(reply)));
}

/**
 * Constant-time compare of two hex strings.
 * @param {string} a @param {string} b
 */
export function sameHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let x;
  try {
    const left = hexToBytes(a);
    const right = hexToBytes(b);
    let diff = 0;
    for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
    x = diff === 0;
  } catch {
    x = false;
  }
  return x;
}
