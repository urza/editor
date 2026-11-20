// @ts-check
// Ed25519 signatures for the space logs (architecture.md §27). One file owns
// the vendored noble surface, like age.js owns typage.
//
// Two forms of a signing key, one signature format. A device without a
// passphrase keeps a non-extractable WebCrypto key in IndexedDB, so it can
// sign with no prompt and no script can copy the key. A device with a
// passphrase holds the secret as hex in memory while it is unlocked. Both
// make standard Ed25519 signatures, and noble verifies every one of them.
// Keys travel as hex, a signature as base64, and the message as a string.

import { ed25519 } from "../../vendor/@noble/curves/ed25519.js";
import { sha256 } from "../../vendor/@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "../../vendor/@noble/hashes/utils.js";

const encoder = new TextEncoder();

/**
 * RFC 8410 PKCS#8 prefix for an Ed25519 private key. WebCrypto imports an
 * Ed25519 private key as PKCS#8 or JWK only, never raw; the 32-byte seed goes
 * after this fixed header. Do not "simplify" it away: the byte counts in it
 * are what makes the DER parse.
 */
const PKCS8_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
  0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

/** A key that signs: a non-extractable CryptoKey, or a 32-byte secret as hex. @typedef {CryptoKey | string} Signer */

/** A secret in the JS heap, for a device with a passphrase. @returns {{secret: string, public: string}} Both hex. */
export function generateSigningKey() {
  const secret = ed25519.utils.randomSecretKey();
  return { secret: bytesToHex(secret), public: bytesToHex(ed25519.getPublicKey(secret)) };
}

/**
 * A non-extractable WebCrypto key, for a device without a passphrase. The
 * public half stays exportable; that is how WebCrypto makes every key pair.
 * @returns {Promise<{key: CryptoKey, public: string}>}
 */
export async function generateStoredSigningKey() {
  const pair = /** @type {CryptoKeyPair} */ (
    await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])
  );
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { key: pair.privateKey, public: bytesToHex(raw) };
}

/**
 * A hex secret as a non-extractable CryptoKey: the upgrade of a device whose
 * secret was wrapped with a passphrase, and an unlock that can keep the
 * secret out of the JS heap.
 * @param {string} secret Hex, 32 bytes. @returns {Promise<CryptoKey>}
 */
export function importSigningSecret(secret) {
  const pkcs8 = new Uint8Array([...PKCS8_ED25519_PREFIX, ...hexToBytes(secret)]);
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
}

/** @param {string} secret Hex, 32 bytes. @returns {string} The public key, hex. */
export function publicKeyOf(secret) {
  return bytesToHex(ed25519.getPublicKey(hexToBytes(secret)));
}

/** @param {string} message @param {Signer} signer @returns {Promise<string>} Base64. */
export async function sign(message, signer) {
  const bytes = encoder.encode(message);
  const sig =
    typeof signer === "string"
      ? ed25519.sign(bytes, hexToBytes(signer))
      : new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, signer, bytes));
  return btoa(String.fromCharCode(...sig));
}

/**
 * Never throws: a malformed key or signature is "not valid", because a log
 * entry is data from the server and a bad entry must not break the replay.
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

/** The lowercase hex SHA-256 of a string's UTF-8 bytes. @param {string} text */
export function sha256Hex(text) {
  return bytesToHex(sha256(encoder.encode(text)));
}
