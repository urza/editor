// @ts-check
// The scrypt half of the keyring, off the main thread (architecture.md §5,
// crypto-proto/REPORT.md Q4). noble's scrypt is synchronous and typage calls
// it synchronously, so wrapping and unwrapping the device identity block their
// thread for ~650 ms on a laptop and longer on a phone. Here that thread is a
// throwaway worker and the UI keeps painting.
//
// One job per worker, and the caller terminates it (js/crypto/unlock.js). The
// passphrase and the plaintext identity therefore exist only in a heap that is
// destroyed a moment later.
//
// This module imports ./age.js by relative path, and age.js imports the
// vendored typage tree by relative path, because a dedicated worker ignores
// the page's import map. tools/vendor_age.py exists for exactly that reason.

import * as age from "./age.js";

/**
 * @typedef {{op: "wrap", identity: string, passphrase: string, workFactor?: number}
 *         | {op: "unwrap", wrapped: string, passphrase: string}} Job
 */

/**
 * @typedef {{ok: true, result: string} | {ok: false, error: string}} Reply
 */

self.addEventListener("message", async (event) => {
  const job = /** @type {Job} */ (event.data);
  try {
    /** @type {string} */
    let result;
    if (job.op === "wrap") {
      result = /** @type {string} */ (
        await age.encryptWithPassphrase(job.identity, job.passphrase, {
          armored: true,
          workFactor: job.workFactor,
        })
      );
    } else if (job.op === "unwrap") {
      result = /** @type {string} */ (
        await age.decrypt(job.wrapped, {
          passphrases: [job.passphrase],
          output: "text",
        })
      );
    } else {
      throw new Error("unlock.worker: unknown op");
    }
    /** @type {Reply} */
    const reply = { ok: true, result };
    self.postMessage(reply);
  } catch (err) {
    // A wrong passphrase arrives here as typage's own error. It travels back as
    // data, not as an exception, so the caller can tell it apart from a worker
    // that failed to start and must never retry such a job on the main thread.
    /** @type {Reply} */
    const reply = { ok: false, error: String(err instanceof Error ? err.message : err) };
    self.postMessage(reply);
  }
});
