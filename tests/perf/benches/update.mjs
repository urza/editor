// B6: Service Worker update size without a browser.
// Reads app/sw-precache.js, measures raw and gzipped wire sizes (mirroring
// GitHub Pages where .dic is served uncompressed as text/x-c), and computes
// app-only deploy bytes if spellcheck lives in its own cache tier.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";
import { APP_DIR } from "../lib/env.mjs";

const SPELL_PREFIXES = ["vendor/harper/", "vendor/hunspell/", "vendor/dictionary-cs/"];

function isSpellAsset(rel) {
  return SPELL_PREFIXES.some((p) => rel.startsWith(p));
}

export async function runB6() {
  const swPath = path.join(APP_DIR, "sw-precache.js");
  const swSrc = fs.readFileSync(swPath, "utf8");
  const sandbox = { self: {} };
  vm.runInNewContext(swSrc, sandbox);
  const precache = sandbox.self.__PRECACHE;

  // Support both current single-list format (`files`) and future split format (`app`/`spell`).
  const allFiles = Array.isArray(precache.files)
    ? precache.files
    : [...(precache.app ?? []), ...(precache.spell ?? [])];
  const splitFormat = !Array.isArray(precache.files) && Array.isArray(precache.app);

  let rawTotal = 0;
  let wireTotal = 0;
  let wireGzipAll = 0;
  let rawSpell = 0;
  let wireSpell = 0;
  let rawApp = 0;
  let wireApp = 0;

  for (const entry of allFiles) {
    const clean = entry === "./" ? "index.html" : entry.replace(/^\.\//, "");
    const full = path.join(APP_DIR, clean);
    if (!fs.existsSync(full)) continue;
    const buf = fs.readFileSync(full);
    const raw = buf.byteLength;
    const gz = zlib.gzipSync(buf, { level: 6 }).byteLength;
    // GitHub Pages gzips JS/CSS/HTML/WASM/JSON/SVG but sends .dic uncompressed
    // because its MIME table serves .dic as text/x-c; PNGs are already compressed.
    const pagesWire = clean.endsWith(".dic") || clean.endsWith(".png") ? raw : gz;

    rawTotal += raw;
    wireTotal += pagesWire;
    wireGzipAll += gz;

    if (isSpellAsset(clean)) {
      rawSpell += raw;
      wireSpell += pagesWire;
    } else {
      rawApp += raw;
      wireApp += pagesWire;
    }
  }

  // If sw-precache.js still has one monolithic list, an app-only deploy downloads
  // every file in the list; once split, an app-only deploy downloads only app files.
  const appDeployWireBytes = splitFormat ? wireApp : wireTotal;
  const mb = (b) => +(b / 1048576).toFixed(2);
  const secAt1600kbps = (b) => +((b * 8) / 1_600_000).toFixed(1);

  return {
    fileCount: allFiles.length,
    splitCacheDetected: splitFormat,
    rawTotalMB: mb(rawTotal),
    wireTotalMB: mb(wireTotal),
    wireAllGzippedMB: mb(wireGzipAll),
    wireSpellMB: mb(wireSpell),
    wireAppOnlyMB: mb(wireApp),
    spellShareOfWirePct: +((wireSpell / Math.max(1, wireTotal)) * 100).toFixed(1),
    appOnlyDeployMB: mb(appDeployWireBytes),
    appOnlyDeployFast3gSec: secAt1600kbps(appDeployWireBytes),
    fullInstallFast3gSec: secAt1600kbps(wireTotal),
  };
}
