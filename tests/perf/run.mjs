#!/usr/bin/env node
// Unified performance benchmark runner for vrtti (B1 through B9).
//
//   node tests/perf/run.mjs [--only B1,B6] [--runs 5] [--no-phone] [--out file.json]
//
// Zero npm dependencies: plain Node 22 + local Chromium over CDP + local dotnet.

import fs from "node:fs";
import path from "node:path";
import {
  cleanupServerBuild,
  collectEnvInfo,
  findChromium,
  gitCommit,
  ROOT,
} from "./lib/env.mjs";
import {
  runB1,
  runB2,
  runB3,
  runB4,
  runB5,
  runB7,
} from "./benches/browser.mjs";
import { runB6 } from "./benches/update.mjs";
import { runB8 } from "./benches/server.mjs";
import { runB9 } from "./benches/desktop.mjs";

const ALL_IDS = ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9"];

function parseArgs(argv) {
  const opts = { only: null, runs: 5, phone: true, out: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--only" && argv[i + 1]) {
      opts.only = argv[++i]
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
    } else if (arg === "--runs" && argv[i + 1]) {
      opts.runs = Math.max(1, Number.parseInt(argv[++i], 10) || 5);
    } else if (arg === "--no-phone") {
      opts.phone = false;
    } else if (arg === "--out" && argv[i + 1]) {
      opts.out = argv[++i];
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node tests/perf/run.mjs [--only B1,B2,...] [--runs 5] [--no-phone] [--out path.json]"
      );
      process.exit(0);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const selected = opts.only ? ALL_IDS.filter((id) => opts.only.includes(id)) : ALL_IDS;
  if (!selected.length) {
    console.error("No matching benchmark IDs. Valid IDs:", ALL_IDS.join(", "));
    process.exit(1);
  }

  const chromePath = findChromium();
  const state = { chromiumVersion: null };
  const ctx = {
    runs: opts.runs,
    phone: opts.phone,
    chromePath,
    onChromeVersion: (v) => {
      if (v && !state.chromiumVersion) state.chromiumVersion = v;
    },
  };

  const runners = {
    B1: () => runB1(ctx),
    B2: () => runB2(ctx),
    B3: () => runB3(ctx),
    B4: () => runB4(ctx),
    B5: () => runB5(ctx),
    B6: () => runB6(ctx),
    B7: () => runB7(ctx),
    B8: () => runB8(ctx),
    B9: () => runB9(ctx),
  };

  const results = {};
  try {
    for (const id of selected) {
      const t0 = performance.now();
      process.stderr.write(`[perf] Running ${id} (runs=${opts.runs})... `);
      results[id] = await runners[id]();
      const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
      process.stderr.write(`done (${elapsed}s)\n`);
    }
  } finally {
    cleanupServerBuild();
  }

  const payload = {
    schemaVersion: 1,
    runs: opts.runs,
    phoneIncluded: opts.phone,
    selected,
    env: collectEnvInfo(state.chromiumVersion),
    results,
  };

  const outPath =
    opts.out ??
    path.join(ROOT, "tests", "perf", "results", `perf-${gitCommit()}-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  process.stderr.write(`[perf] Wrote ${outPath}\n`);
  console.log(JSON.stringify(payload, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
