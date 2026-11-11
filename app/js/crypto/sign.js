// @ts-check
// Ed25519 signatures for the keyring (architecture.md §21). One file owns the
// vendored noble surface, like age.js owns typage. Keys travel as hex, a
// signature as base64, and the message as a string, so every value fits into
// the JSON keyring record and into IndexedDB without further encoding.

import { ed25519 } from "../../vendor/@noble/curves/ed25519.js";
import { sha256 } from "../../vendor/@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "../../vendor/@noble/hashes/utils.js";

const encoder = new TextEncoder();

/** @returns {{secret: string, public: string}} Both hex. */
export function generateSigningKey() {
  const secret = ed25519.utils.randomSecretKey();
  return { secret: bytesToHex(secret), public: bytesToHex(ed25519.getPublicKey(secret)) };
}

/** @param {string} secret Hex, 32 bytes. @returns {string} The public key, hex. */
export function publicKeyOf(secret) {
  return bytesToHex(ed25519.getPublicKey(hexToBytes(secret)));
}

/** @param {string} message @param {string} secret Hex. @returns {string} Base64. */
export function sign(message, secret) {
  const sig = ed25519.sign(encoder.encode(message), hexToBytes(secret));
  return btoa(String.fromCharCode(...sig));
}

/**
 * Never throws: a malformed key or signature is "not valid", because the
 * record is data from the server and a bad row must not break the trust
 * computation for the good ones.
 * @param {string} signature Base64. @param {string} message @param {string} publicKey Hex.
 */
export function verify(signature, message, publicKey) {
  try {
    const sig = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
    return ed25519.verify(sig, encoder.encode(message), hexToBytes(publicKey));
  } catch {
    return false;
  }
}

/**
 * The hash both short strings below come from. It covers the signing key AND
 * the age recipient (architecture.md §26): the user's comparison is the one
 * thing that binds a device's two keys together for a device nobody has
 * signed yet. A hash of the signing key alone let the server keep the key,
 * swap the recipient, and still show the code the user expects.
 * The strings are hashed as they stand in the record, never decoded: a
 * malformed key from the server must give a wrong code, not a throw.
 * @param {string} signKey Hex. @param {string} recipient `age1...`
 */
function identityHash(signKey, recipient) {
  return sha256(encoder.encode(["vrtti-identity", signKey, recipient].join("\n")));
}

/**
 * Sixteen hex characters in groups of four: what the user compares between
 * two screens. Sixteen, because the server sees both keys and can try keys
 * until a short value repeats; eight characters fell to that in days
 * (architecture.md §26).
 * @param {string} signKey Hex. @param {string} recipient `age1...`
 */
export function fingerprint(signKey, recipient) {
  const hex = bytesToHex(identityHash(signKey, recipient)).slice(0, 16).toUpperCase();
  return /** @type {string[]} */ (hex.match(/.{4}/g)).join(" ");
}

/**
 * Six digits typed on the approving device, from the same hash as the
 * fingerprint but from its other end, so the two never look alike.
 * @param {string} signKey Hex. @param {string} recipient `age1...`
 */
export function pairingCode(signKey, recipient) {
  const hash = identityHash(signKey, recipient);
  const n = ((hash[28] << 24) | (hash[29] << 16) | (hash[30] << 8) | hash[31]) >>> 0;
  const digits = String(n % 1000000).padStart(6, "0");
  return digits.slice(0, 3) + " " + digits.slice(3);
}

/** @param {string} code As typed; spaces and other separators are ignored. */
export function normalizeCode(code) {
  const digits = (code || "").replace(/\D/g, "");
  return digits.length === 6 ? digits.slice(0, 3) + " " + digits.slice(3) : "";
}
