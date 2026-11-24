#!/usr/bin/env node
// Compare two benchmark JSON files produced by tests/perf/run.mjs and print
// a before/after Markdown table.
//
//   node tests/perf/compare.mjs before.json after.json

import fs from "node:fs";

const [, , beforePath, afterPath] = process.argv;
if (!beforePath || !afterPath) {
  console.error("Usage: node tests/perf/compare.mjs <before.json> <after.json>");
  process.exit(1);
}

const before = JSON.parse(fs.readFileSync(beforePath, "utf8"));
const after = JSON.parse(fs.readFileSync(afterPath, "utf8"));

function flatten(obj, prefix = "", out = new Map()) {
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "number" && Number.isFinite(v)) {
      out.set(key, v);
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      flatten(v, key, out);
    }
  }
  return out;
}

const a = flatten(before.results ?? before);
const b = flatten(after.results ?? after);
const keys = [...new Set([...a.keys(), ...b.keys()])];

console.log(`Before: ${beforePath} (commit ${before.env?.commit ?? "?"}, runs=${before.runs ?? "?"})`);
console.log(`After:  ${afterPath} (commit ${after.env?.commit ?? "?"}, runs=${after.runs ?? "?"})\n`);
console.log("| Metric | Before | After | Delta |");
console.log("|---|---:|---:|---:|");

for (const key of keys) {
  const v0 = a.get(key);
  const v1 = b.get(key);
  if (v0 === undefined || v1 === undefined) {
    console.log(`| \`${key}\` | ${v0 ?? "n/a"} | ${v1 ?? "n/a"} | n/a |`);
    continue;
  }
  let delta = "0.0%";
  if (v0 === 0 && v1 === 0) {
    delta = "0.0%";
  } else if (v0 === 0) {
    delta = `+${v1}`;
  } else {
    const pct = ((v1 - v0) / Math.abs(v0)) * 100;
    const sign = pct > 0 ? "+" : "";
    delta = `${sign}${pct.toFixed(1)}%`;
  }
  console.log(`| \`${key}\` | ${v0} | ${v1} | ${delta} |`);
}
