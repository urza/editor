// @ts-check
// Time limits for calls that leave the page: the disk, the WebView's own file
// handles, the sync server (architecture.md §30).
//
// Why this exists: on 2026-11-25 a WebView2 call for one old file handle gave
// no answer and no error, and the app start waited with no end. A promise
// that never settles runs no `catch` and no `finally`. So every "one at a
// time" flag behind such a call (the external-change pass, the folder
// refresh, a sync round) stays set until a reload, and nothing says so. A
// time limit turns "no answer" into an error, and the error paths were good
// already.
//
// Two kinds of call have a limit: a request to the sync server, and the
// permission query on a browser file handle. A disk read or write has none,
// on purpose. Do not add one in the storage layer:
//  - A stat often guards a write. adoptRemote() in model/docs.js takes a stat
//    that failed to mean "the write fails the same way" and then writes with
//    no check of the file time. A stat that only ran out of time breaks that,
//    and the write can replace an edit that another program made.
//  - A write that lands after its limit still changes the file. The retry
//    then meets a change that the app made itself and makes a conflict copy.
// Both need a rule at their callers first (§30 lists the call sites).
//
// No imports, on purpose: the Node tests load this with no page at all.

/**
 * Every limit in one place, in ms. An object and not constants: an e2e test
 * shortens a limit on the page's own module instance, so no test waits for a
 * minute and no test hook lives in the callers.
 */
export const LIMITS = {
  /** One request to the sync server, headers and body. */
  request: 60_000,
  /** One paragraph to the model on the server, which can take long. */
  model: 5 * 60_000,
  /**
   * A permission query on a browser file handle. It reads a flag, and a
   * healthy handle answers in a few ms. Short, because the app start asks
   * every stored handle in turn.
   */
  query: 3000,
  /**
   * How long a handle that gave no answer to that query is not asked again
   * (storage/fsa.js, queryState). It counts from the last refused read. It
   * must cover one flow of "stat, then write", so both get the same answer;
   * that flow takes well under a second.
   */
  silentFor: 5000,
  /**
   * How long a save may stay open after the last keystroke before the status
   * bar says "not saved yet" (ui/statusbar.js). The debounce is 300 ms and a
   * healthy write takes a few ms more.
   */
  slowSave: 5000,
};

/** @param {string} what The call that got no answer, for the log. */
export function noAnswer(what) {
  // The name that AbortSignal.timeout() uses, so isNoAnswer() covers both.
  return new DOMException("no answer: " + what, "TimeoutError");
}

/** @param {unknown} err */
export function isNoAnswer(err) {
  return /** @type {any} */ (err)?.name === "TimeoutError";
}

/**
 * The answer of `promise`, or a TimeoutError after `ms`. The work behind the
 * promise goes on (nothing here can stop a call into the browser); its late
 * answer is dropped. So use it only where a late answer does no harm.
 * @template T
 * @param {Promise<T>} promise @param {number} ms @param {string} what
 * @returns {Promise<T>}
 */
export function withTimeLimit(promise, ms, what) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {Promise<never>} */
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(noAnswer(what)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/**
 * A signal for fetch() that aborts after `ms` with a TimeoutError. Unlike
 * withTimeLimit() it stops the request, and it also covers the read of the
 * body, which the caller does later.
 * @param {number} ms @returns {AbortSignal}
 */
export function limitSignal(ms) {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  // Safari before 16. Without this branch every request there would throw,
  // and sync would stop on that browser.
  const controller = new AbortController();
  setTimeout(() => controller.abort(noAnswer("request")), ms);
  return controller.signal;
}
