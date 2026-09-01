// @ts-check
/**
 * Demo wiring for the crypto prototype.
 * Also exposes `window.proto` so the Playwright script can drive the same
 * flows without clicking through the page.
 */

import * as age from "./age.js"
import { KeyRing, hasWebCryptoX25519 } from "./keyring.js"
import * as codec from "./codec.js"
import { benchmark } from "./bench.js"

const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id))
const keyring = new KeyRing()

/** Last recovery secret from this page load. Kept only to prefill the demo field. */
let lastRecovery = ""

/** @param {HTMLElement} el @param {string} msg @param {"ok"|"err"|""} [cls] */
function say(el, msg, cls = "") {
    el.textContent = msg
    el.className = "log " + cls
}

/* --- environment probe --------------------------------------------------- */

async function probeEnv() {
    const lines = [
        `import map: resolved (this script imported "age-encryption" by bare specifier)`,
        `WebCrypto X25519: ${await hasWebCryptoX25519() ? "yes" : "NO"}`,
        `crypto.subtle: ${!!globalThis.crypto?.subtle}`,
        `keyring set up: ${keyring.isSetUp}`,
    ]
    say($("env"), lines.join("\n"))
}

/* --- flows --------------------------------------------------------------- */

async function doSetup() {
    const t0 = performance.now()
    const logN = parseInt($("setup-logn").value, 10)
    const { recoveryIdentity } = await keyring.setup($("setup-pass").value, {
        deviceName: "prototype", workFactor: Number.isFinite(logN) ? logN : undefined,
    })
    lastRecovery = recoveryIdentity
    $("recovery-key").value = recoveryIdentity
    say($("setup-out"), [
        `done in ${Math.round(performance.now() - t0)} ms (scrypt logN=${logN})`,
        `device recipient:   ${keyring.deviceRecipient}`,
        `recovery recipient: ${keyring.recoveryRecipient}`,
        `recovery SECRET (write this down, shown once):`,
        `  ${recoveryIdentity}`,
        `wrapped identity stored in localStorage, ${keyring.stored?.wrappedIdentity.length} chars armored`,
    ].join("\n"), "ok")
    await probeEnv()
    return { recoveryIdentity }
}

async function doUnlock() {
    const t0 = performance.now()
    try {
        await keyring.unlock($("unlock-pass").value)
        say($("unlock-out"),
            `unlocked in ${Math.round(performance.now() - t0)} ms; identity held as ${keyring.identityKind}`, "ok")
    } catch (err) {
        say($("unlock-out"), `unlock failed: ${err}`, "err")
        throw err
    }
    return keyring.identityKind
}

function doLock() {
    keyring.lock()
    say($("unlock-out"), "locked; identity dropped from memory", "ok")
}

async function doEncrypt() {
    const recipients = keyring.recipientsFor($("preset").value)
    const enc = codec.newEncMeta(recipients, "demo note")
    const t0 = performance.now()
    const out = await codec.encode($("plaintext").value, enc)
    $("ciphertext").value = out
    say($("note-out"), [
        `encrypted to ${recipients.length} recipients in ${Math.round(performance.now() - t0)} ms`,
        ...recipients.map((r, i) => `  [${i}] ${r}`),
        `armored length: ${out.length} chars`,
    ].join("\n"), "ok")
    return out
}

async function doDecrypt() {
    const enc = codec.newEncMeta(keyring.recipientsFor("this-device"), "demo note")
    const t0 = performance.now()
    try {
        const text = await codec.decode($("ciphertext").value, enc, keyring)
        say($("note-out"), `decrypted in ${Math.round(performance.now() - t0)} ms:\n${text}`, "ok")
        return text
    } catch (err) {
        say($("note-out"), `decrypt failed: ${err}`, "err")
        throw err
    }
}

async function doRecover() {
    const key = $("recovery-key").value.trim()
    try {
        const text = await age.decrypt($("ciphertext").value, { identities: [key], output: "text" })
        say($("recover-out"), `recovered with the recovery identity alone:\n${text}`, "ok")
        return text
    } catch (err) {
        say($("recover-out"), `recovery failed: ${err}`, "err")
        throw err
    }
}

async function doBench() {
    say($("bench-out"), "running...")
    const rows = await benchmark()
    const head = "size      enc ms (med/p95)   dec ms (med/p95)   ct bytes"
    const body = rows.map(r =>
        `${String(r.label).padEnd(9)} ${fmt(r.encMedian)}/${fmt(r.encP95)}`.padEnd(37)
        + `${fmt(r.decMedian)}/${fmt(r.decP95)}`.padEnd(19) + r.ciphertextBytes)
    say($("bench-out"), [head, ...body].join("\n"), "ok")
    return rows
}

const fmt = (/** @type {number} */ n) => n.toFixed(2)

/* --- bind ---------------------------------------------------------------- */

$("btn-setup").onclick = () => doSetup().catch(e => say($("setup-out"), String(e), "err"))
$("btn-reset").onclick = () => { keyring.reset(); say($("setup-out"), "device reset"); probeEnv() }
$("btn-unlock").onclick = () => doUnlock().catch(() => {})
$("btn-lock").onclick = doLock
$("btn-encrypt").onclick = () => doEncrypt().catch(e => say($("note-out"), String(e), "err"))
$("btn-decrypt").onclick = () => doDecrypt().catch(() => {})
$("btn-recover").onclick = () => doRecover().catch(() => {})
$("btn-bench").onclick = () => doBench().catch(e => say($("bench-out"), String(e), "err"))

probeEnv()

// Test surface. Playwright drives these instead of the DOM, so the assertions
// read as flow steps and not as clicks.
// @ts-ignore
window.proto = {
    keyring, age, codec,
    setup: doSetup, unlock: doUnlock, lock: doLock,
    encrypt: doEncrypt, decrypt: doDecrypt, recover: doRecover, bench: doBench,
    hasWebCryptoX25519,
    get recovery() { return lastRecovery },
    setPlaintext: (/** @type {string} */ s) => { $("plaintext").value = s },
    setCiphertext: (/** @type {string} */ s) => { $("ciphertext").value = s },
    getCiphertext: () => $("ciphertext").value,
}
// @ts-ignore
window.protoReady = true
