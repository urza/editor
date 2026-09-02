// @ts-check
// Worker plumbing for the two slow keyring operations. Key logic lives in
// keyring.js; this file only knows how to get a job onto another thread and
// how to fail back to this one.

import * as age from "./age.js";

/**
 * A worker that could not be created or could not run at all. It is the ONLY
 * error that earns the main-thread fallback. A wrong passphrase is a perfectly
 * healthy worker reporting a crypto failure, and retrying that on the main
 * thread would burn another 650 ms of frozen UI to reach the same answer.
 */
class WorkerUnavailable extends Error {
  /** @param {unknown} cause */
  constructor(cause) {
    super("unlock: worker unavailable: " + String(cause));
    this.name = "WorkerUnavailable";
  }
}

/**
 * Run one job in a private worker and terminate it.
 *
 * A fresh worker per job, terminated in `finally`: the passphrase and the
 * plaintext identity string die with the worker's heap instead of waiting for
 * a garbage collector that JavaScript gives us no way to force. Do not turn
 * this into a pooled long-lived worker.
 *
 * @param {object} job  The message unlock.worker.js expects.
 * @returns {Promise<string>}
 */
async function runJob(job) {
  if (typeof Worker === "undefined") throw new WorkerUnavailable("no Worker");
  let worker;
  try {
    worker = new Worker(new URL("./unlock.worker.js", import.meta.url), {
      type: "module",
    });
  } catch (err) {
    throw new WorkerUnavailable(err);
  }
  try {
    return await new Promise((resolve, reject) => {
      worker.addEventListener("message", (event) => {
        const reply = event.data;
        if (reply && reply.ok) resolve(reply.result);
        else reject(new Error(reply?.error ?? "unlock: worker failed"));
      });
      // Fires when the module itself will not load or throws before it can
      // answer. Nothing crypto has happened yet, so the fallback is safe.
      worker.addEventListener("error", (event) => {
        reject(new WorkerUnavailable(event.message || "worker error"));
      });
      worker.postMessage(job);
    });
  } finally {
    worker.terminate();
  }
}

/**
 * Wrap a device identity to a passphrase (armored age, scrypt recipient).
 * @param {string} identity  `AGE-SECRET-KEY-1...`
 * @param {string} passphrase
 * @param {{workFactor?: number}} [opts]
 * @returns {Promise<string>}
 */
export async function wrapInWorker(identity, passphrase, opts = {}) {
  try {
    return await runJob({
      op: "wrap",
      identity,
      passphrase,
      workFactor: opts.workFactor,
    });
  } catch (err) {
    if (!(err instanceof WorkerUnavailable)) throw err;
    console.log("[vrtti] wrapping on the main thread:", err.message);
    return /** @type {string} */ (
      await age.encryptWithPassphrase(identity, passphrase, {
        armored: true,
        workFactor: opts.workFactor,
      })
    );
  }
}

/**
 * Unwrap a device identity with a passphrase.
 *
 * A wrong passphrase rejects with typage's own message ("no identity matched
 * any of the file's recipients"), so the unlock command can tell it apart from
 * a broken worker and offer a retry.
 *
 * @param {string} wrapped  Armored age file holding the identity.
 * @param {string} passphrase
 * @returns {Promise<string>}
 */
export async function unwrapInWorker(wrapped, passphrase) {
  try {
    return await runJob({ op: "unwrap", wrapped, passphrase });
  } catch (err) {
    if (!(err instanceof WorkerUnavailable)) throw err;
    console.log("[vrtti] unwrapping on the main thread:", err.message);
    return /** @type {string} */ (
      await age.decrypt(wrapped, { passphrases: [passphrase], output: "text" })
    );
  }
}
