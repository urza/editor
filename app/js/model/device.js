// @ts-check
// The id of this browser profile, minted once and never again.
//
// One device, one id. The keyring record names devices by it (architecture.md
// §13.3) and every pushed revision carries it (§3, §13.6). Two ids for one
// device would show up as a phantom device in the keyring and as a stranger in
// the history list, so both users of the id read it from here.

import { getSetting, putSetting } from "../storage/idb.js";

const KEY = "device.id";
// The keyring's own settings row (crypto/keyring.js STORE_KEY). Read here only
// for the migration below; nothing else in this module knows about crypto.
const KEYRING_KEY = "keyring";

/** @type {string | null} */
let cached = null;

/**
 * This device's id. Mints and stores one on the first call.
 * @returns {Promise<string>}
 */
export async function deviceId() {
  if (cached) return cached;
  let id = await getSetting(KEY);
  if (!id) {
    // Migration: a device set up before this module existed minted its id
    // inside the keyring, and the keyring record (possibly already on the
    // server) names it by that value. Adopting it keeps one device one id.
    const stored = await getSetting(KEYRING_KEY);
    id = (stored && stored.deviceId) || crypto.randomUUID();
    await putSetting(KEY, id);
  }
  cached = id;
  return id;
}
