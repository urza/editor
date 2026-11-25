// node --test tests/*.test.mjs
// The time limits for calls that leave the page (architecture.md §30).
import { test } from "node:test";
import assert from "node:assert/strict";
import { LIMITS, isNoAnswer, limitSignal, noAnswer, withTimeLimit } from "../app/js/model/timelimit.js";

/** A call that gives no answer and no error, as WebView2 did on 2026-11-25. */
const never = () => new Promise(() => {});

test("withTimeLimit passes an answer through", async () => {
  assert.equal(await withTimeLimit(Promise.resolve(7), 1000, "queryPermission"), 7);
});

test("withTimeLimit passes a failure through unchanged", async () => {
  const failure = new DOMException("gone", "NotFoundError");
  await assert.rejects(withTimeLimit(Promise.reject(failure), 1000, "queryPermission"), (err) => err === failure);
});

test("withTimeLimit ends a call with no answer as a TimeoutError that names the call", async () => {
  await assert.rejects(withTimeLimit(never(), 20, "queryPermission"), (err) => {
    assert.equal(isNoAnswer(err), true);
    assert.match(/** @type {Error} */ (err).message, /queryPermission/);
    return true;
  });
});

test("a `finally` behind a limited call runs, which is the point of the limit", async () => {
  // The shape of every "one at a time" guard in the app.
  let busy = false;
  async function pass() {
    if (busy) return "skipped";
    busy = true;
    try {
      await withTimeLimit(never(), 20, "queryPermission");
      return "done";
    } catch {
      return "failed";
    } finally {
      busy = false;
    }
  }
  assert.equal(await pass(), "failed");
  assert.equal(busy, false);
  // The next pass runs. Without the limit it would be "skipped" for ever.
  assert.equal(await pass(), "failed");
});

test("an answer that comes after the limit is dropped and raises nothing", async () => {
  /** @type {(value: string) => void} */
  let answer = () => {};
  const slow = new Promise((resolve) => {
    answer = resolve;
  });
  await assert.rejects(withTimeLimit(slow, 20, "queryPermission"), isNoAnswer);
  answer("late");
  assert.equal(await slow, "late");
});

test("a failure that comes after the limit is not an unhandled rejection", async () => {
  /** @type {(err: Error) => void} */
  let fail = () => {};
  const slow = new Promise((_, reject) => {
    fail = reject;
  });
  await assert.rejects(withTimeLimit(slow, 20, "queryPermission"), isNoAnswer);
  let unhandled = false;
  const onUnhandled = () => {
    unhandled = true;
  };
  process.once("unhandledRejection", onUnhandled);
  fail(new Error("late failure"));
  // Two turns of the timer queue: Node reports an unhandled rejection after
  // the microtasks of the turn that made it.
  await new Promise((resolve) => setTimeout(resolve, 20));
  process.removeListener("unhandledRejection", onUnhandled);
  assert.equal(unhandled, false);
});

test("limitSignal aborts with a TimeoutError", async () => {
  const signal = limitSignal(20);
  assert.equal(signal.aborted, false);
  // A timer of the test's own, and not a wait for the "abort" event: Node
  // does not keep the process alive for the timer inside
  // AbortSignal.timeout(), so the run would end before the event.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(signal.aborted, true);
  assert.equal(isNoAnswer(signal.reason), true);
});

test("isNoAnswer tells the limit from every other failure", () => {
  assert.equal(isNoAnswer(noAnswer("x")), true);
  assert.equal(isNoAnswer(new TypeError("Failed to fetch")), false);
  assert.equal(isNoAnswer(new DOMException("denied", "NotAllowedError")), false);
  assert.equal(isNoAnswer(undefined), false);
});

test("every limit is a positive number of ms, and the query is the short one", () => {
  for (const [name, ms] of Object.entries(LIMITS)) {
    assert.equal(Number.isFinite(ms) && ms > 0, true, name);
  }
  // The start asks every stored handle in turn, before the first mount, and
  // the start watch of index.html speaks after 10 s.
  assert.equal(LIMITS.query <= 3000, true);
});

test("no limit exists for a disk read or write (architecture.md §30 says why)", () => {
  // A stat that runs out of time before a write would let the write go out
  // with no check. A limit for disk calls needs a rule at each caller first.
  assert.deepEqual(Object.keys(LIMITS).sort(), ["model", "query", "request", "silentFor", "slowSave"]);
});
