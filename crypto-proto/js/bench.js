// @ts-check
/**
 * Round-trip benchmark.
 *
 * The number that matters: the app encrypts on a ~300 ms autosave debounce
 * (architecture section 1). If a median encrypt of a realistic note costs more
 * than a few milliseconds, autosave stutters while typing.
 */

import * as age from "./age.js"

const SIZES = [
    { label: "1 KB", bytes: 1024 },
    { label: "10 KB", bytes: 10 * 1024 },
    { label: "100 KB", bytes: 100 * 1024 },
]

/** Runs per size. Enough to get a stable median without freezing the page. */
const RUNS = 30

/**
 * @param {{runs?: number, recipientCount?: number, armored?: boolean}} [opts]
 * @returns {Promise<Array<{label:string,bytes:number,encMedian:number,encP95:number,decMedian:number,decP95:number,ciphertextBytes:number,recipients:number,armored:boolean}>>}
 */
export async function benchmark(opts = {}) {
    const runs = opts.runs ?? RUNS
    const n = opts.recipientCount ?? 3
    const armored = opts.armored ?? true

    const ids = []
    for (let i = 0; i < n; i++) ids.push(await age.generateIdentity())
    const recipients = ids.map(i => i.recipient)
    const identity = ids[0].identity

    const out = []
    for (const { label, bytes } of SIZES) {
        // Lorem-ish filler. Real notes are text, so the payload is text.
        const text = "the quick brown fox jumps over the lazy dog. ".repeat(Math.ceil(bytes / 45)).slice(0, bytes)
        const encTimes = [], decTimes = []
        let ct = ""
        // One warm-up pass: the first call pays JIT and module init costs that
        // no later autosave will pay again.
        ct = /** @type {string} */ (await age.encrypt(text, recipients, { armored }))
        await age.decrypt(ct, { identities: [identity], output: "text" })

        for (let i = 0; i < runs; i++) {
            let t = performance.now()
            ct = /** @type {string} */ (await age.encrypt(text, recipients, { armored }))
            encTimes.push(performance.now() - t)

            t = performance.now()
            const back = await age.decrypt(ct, { identities: [identity], output: "text" })
            decTimes.push(performance.now() - t)
            if (back !== text) throw new Error("round-trip mismatch at " + label)
        }
        out.push({
            label, bytes, recipients: n, armored,
            encMedian: pct(encTimes, 50), encP95: pct(encTimes, 95),
            decMedian: pct(decTimes, 50), decP95: pct(decTimes, 95),
            ciphertextBytes: ct.length,
        })
    }
    return out
}

/** @param {number[]} xs @param {number} p */
function pct(xs, p) {
    const s = [...xs].sort((a, b) => a - b)
    return s[Math.min(s.length - 1, Math.floor(s.length * p / 100))]
}
