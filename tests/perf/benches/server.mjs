// B8: Vrtti.Server (.NET 10 Release) + SQLite scale benchmarks.
// Seeds 1k/5k, 5k/50k, and 10k/100k databases (each with 512 KB big-doc
// revisions) and measures p50/p95 latency and response bytes for core routes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasDotnet, hasPython3, medianObjects, percentile, startSyncServer } from "../lib/env.mjs";
import { seedServerDb } from "../lib/fixtures.mjs";

async function timedFetch(url, devToken, opts = {}) {
  const headers = { Authorization: "Bearer " + devToken, "Content-Type": "application/json" };
  const t0 = performance.now();
  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const buf = await res.arrayBuffer();
  const ms = +(performance.now() - t0).toFixed(2);
  return {
    status: res.status,
    ms,
    bytes: buf.byteLength,
    json: () => JSON.parse(Buffer.from(buf).toString("utf8")),
  };
}

const TIERS = [
  { name: "1k_docs_5k_revs", docCount: 1000, revsPerDoc: 5, avgBytes: 4096, bigDocRevs: 50, bigDocBytes: 512 * 1024 },
  { name: "5k_docs_50k_revs", docCount: 5000, revsPerDoc: 10, avgBytes: 4096, bigDocRevs: 200, bigDocBytes: 512 * 1024 },
  { name: "10k_docs_100k_revs", docCount: 10000, revsPerDoc: 10, avgBytes: 4096, bigDocRevs: 200, bigDocBytes: 512 * 1024 },
];

export async function runB8({ runs = 5 } = {}) {
  if (!hasDotnet()) return { skipped: "dotnet not installed" };
  if (!hasPython3()) return { skipped: "python3 not installed" };

  const trials = Math.max(5, runs);
  const out = {};

  for (const tier of TIERS) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vrtti-perf-b8-"));
    const dbPath = path.join(dir, "vrtti.db");
    let srv = null;
    try {
      // First start initializes the SQLite schema via Db.cs.
      srv = await startSyncServer({ dbPath });
      await srv.close();
      srv = null;

      const seeded = seedServerDb(dbPath, tier);
      const dbSizeMB = +(fs.statSync(dbPath).size / 1048576).toFixed(2);

      srv = await startSyncServer({ dbPath });
      await timedFetch(`${srv.url}/api/health`, seeded.devToken);

      // 1. GET /api/spaces
      const spacesSamples = [];
      let spacesBytes = 0;
      for (let i = 0; i < trials; i++) {
        const r = await timedFetch(`${srv.url}/api/spaces`, seeded.devToken);
        spacesSamples.push(r.ms);
        spacesBytes = r.bytes;
      }

      // 2. GET /api/changes page 1 (since=0, limit=200, personal)
      const page1Samples = [];
      let page1Bytes = 0;
      for (let i = 0; i < trials; i++) {
        const r = await timedFetch(`${srv.url}/api/changes?since=0&limit=200&spaces=personal`, seeded.devToken);
        page1Samples.push(r.ms);
        page1Bytes = r.bytes;
      }

      // 3. Full pull of space "personal"
      const fullPullRuns = [];
      for (let runIdx = 0; runIdx < runs; runIdx++) {
        let since = 0;
        let pages = 0;
        let bytes = 0;
        const t0 = performance.now();
        while (true) {
          const r = await timedFetch(`${srv.url}/api/changes?since=${since}&limit=200&spaces=personal`, seeded.devToken);
          bytes += r.bytes;
          const body = r.json();
          pages++;
          if (!body.more) break;
          since = body.next;
        }
        fullPullRuns.push({
          wallMs: +(performance.now() - t0).toFixed(1),
          pages,
          bytes,
        });
      }

      // 4. GET /api/docs/big-doc-001/revisions (history list)
      const historySamples = [];
      let historyBytes = 0;
      for (let i = 0; i < trials; i++) {
        const r = await timedFetch(`${srv.url}/api/docs/big-doc-001/revisions`, seeded.devToken);
        historySamples.push(r.ms);
        historyBytes = r.bytes;
      }

      // 5. POST push 4 KB and 1 MB
      const header = "-----BEGIN AGE ENCRYPTED FILE-----\n";
      const footer = "\n-----END AGE ENCRYPTED FILE-----\n";
      const body4KB = header + "X".repeat(4000) + footer;
      const body1MB = header + "Y".repeat(1048500) + footer;
      const sealedMeta = {
        kind: "scratch",
        enc: { v: 1, preset: "space", spaceSeq: 1 },
        sealed: header + "S".repeat(180) + footer,
      };

      const push4kSamples = [];
      let revSmall = tier.revsPerDoc;
      for (let i = 0; i < trials; i++) {
        const r = await timedFetch(`${srv.url}/api/docs/doc-000000/revisions`, seeded.devToken, {
          method: "POST",
          body: { baseRev: revSmall, kind: "text", content: body4KB, meta: sealedMeta, clientTime: Date.now(), space: "personal" },
        });
        if (r.status !== 201) throw new Error(`B8 4KB push failed (${r.status})`);
        revSmall++;
        push4kSamples.push(r.ms);
      }

      const push1mSamples = [];
      let revBig = tier.bigDocRevs;
      for (let i = 0; i < trials; i++) {
        const r = await timedFetch(`${srv.url}/api/docs/big-doc-001/revisions`, seeded.devToken, {
          method: "POST",
          body: { baseRev: revBig, kind: "text", content: body1MB, meta: sealedMeta, clientTime: Date.now(), space: "personal" },
        });
        if (r.status !== 201) throw new Error(`B8 1MB push failed (${r.status})`);
        revBig++;
        push1mSamples.push(r.ms);
      }

      out[tier.name] = {
        dbSizeMB,
        totalRevs: seeded.totalRevs,
        spaces: { p50Ms: percentile(spacesSamples, 0.5), p95Ms: percentile(spacesSamples, 0.95), bytes: spacesBytes },
        changesPage1: { p50Ms: percentile(page1Samples, 0.5), p95Ms: percentile(page1Samples, 0.95), bytes: page1Bytes },
        fullPullPersonal: medianObjects(fullPullRuns),
        historyBigDoc: { p50Ms: percentile(historySamples, 0.5), p95Ms: percentile(historySamples, 0.95), bytes: historyBytes },
        push4KB: { p50Ms: percentile(push4kSamples, 0.5), p95Ms: percentile(push4kSamples, 0.95) },
        push1MB: { p50Ms: percentile(push1mSamples, 0.5), p95Ms: percentile(push1mSamples, 0.95) },
        plans: seeded.plans,
      };
    } finally {
      if (srv) await srv.close();
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }

  return out;
}
