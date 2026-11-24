// Deterministic seeded fixture generators for tests/perf/.
// Generates logs, prose, Markdown tables, IndexedDB vaults, and SQLite server
// databases on the fly so no binary fixture data needs to be committed.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

export const DEFAULT_SEED = 20261124;

/** Deterministic PRNG (mulberry32). */
export function mulberry32(seed = DEFAULT_SEED) {
  let t = seed >>> 0;
  return function next() {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generate a timestamped log file with zero blank lines (single Markdown leaf). */
export function makeLogText(targetBytes, seed = DEFAULT_SEED) {
  const rand = mulberry32(seed);
  const levels = ["INFO", "WARN", "DEBUG", "ERROR"];
  const mods = ["worker-01", "worker-02", "sync-pull", "disk-io", "index-db"];
  const lines = [];
  let len = 0;
  let seq = 10000;
  while (len < targetBytes) {
    const lv = levels[Math.floor(rand() * levels.length)];
    const mod = mods[Math.floor(rand() * mods.length)];
    const ms = Math.floor(rand() * 140) + 1;
    const line = `2026-11-24T12:00:00Z ${lv} ${mod} batch=${seq++} duration=${ms}ms status=ok\n`;
    lines.push(line);
    len += line.length;
  }
  return lines.join("").slice(0, targetBytes);
}

/** Generate multi-paragraph Markdown prose with blank lines every 5 lines. */
export function makeProseText(targetBytes, seed = DEFAULT_SEED) {
  const rand = mulberry32(seed + 1);
  const sentences = [
    "The local store keeps every active scratch note inside IndexedDB with an atomic write after typing pauses.",
    "Devices share encrypted spaces through a blind relay server that never holds a decryption key.",
    "Markdown headings, lists, and fenced code blocks format cleanly while keeping plain prose readable.",
    "Sync pulls read pages in sequence order and advance each space cursor only after local storage finishes.",
    "Desktop windows open project folders directly from disk without copying their contents into the browser database.",
  ];
  const parts = ["# Performance Test Document\n\n"];
  let len = parts[0].length;
  let para = 0;
  while (len < targetBytes) {
    const block = [];
    for (let i = 0; i < 5; i++) {
      block.push(sentences[Math.floor(rand() * sentences.length)]);
    }
    const chunk = (para % 12 === 0 ? `## Section ${para}\n\n` : "") + block.join("\n") + "\n\n";
    parts.push(chunk);
    len += chunk.length;
    para++;
  }
  return parts.join("").slice(0, targetBytes);
}

/** Generate a 6-column Markdown table with rowCount data rows and emoji cells. */
export function makeMarkdownTable(rowCount) {
  const rows = [
    "# Table Benchmark\n\n",
    "| Row | Key | Status | Value | Notes | Tag |\n",
    "| --- | --- | --- | --- | --- | --- |\n",
  ];
  for (let i = 0; i < rowCount; i++) {
    rows.push(`| Row ${i} | item-${String(i).padStart(4, "0")} | status ok | ${i * 17} | sample cell text | 🎉 |\n`);
  }
  return rows.join("");
}

/** Generate deterministic English prose containing repeatable misspellings for Harper. */
export function makeEnglishProse(chars) {
  const para =
    "This is a simple English paragraph with one speling mistake and several normal words to measure lint speed.\n\n";
  return para.repeat(Math.ceil(chars / para.length)).slice(0, chars);
}

/** 20 Czech words without diacritics for Hunspell suggestion / twins timing. */
export function makeCzechWords() {
  return [
    "tlacitko", "prilis", "zlutoucky", "kun", "upel", "dabelske", "ody", "clanky",
    "poznamka", "rozhrani", "rychlost", "spolehlivost", "sifrovani", "synchronizace",
    "vyhledavani", "nastaveni", "odstranit", "obnovit", "zalohovani", "pripojeni",
  ];
}

/**
 * Seed IndexedDB (`buffers`, `remote`, `workspaces`) inside a running vrtti page.
 * Deterministic timestamps and sizes ensure repeatable startup and sidebar runs.
 */
export async function seedVaultInPage(
  cdp,
  { openCount, recentCount, closedSyncedCount = 0, stubCount = 0, trashCount = 0, noteSizeBytes = 4096, encrypted = false }
) {
  return cdp.eval(`(async () => {
    // Open without a version number: the page already created the database at
    // the app's current DB_VERSION, so future schema bumps will not break seeding.
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("vrtti");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const clearStore = (name) => new Promise((resolve, reject) => {
      const tx = db.transaction(name, "readwrite");
      tx.objectStore(name).clear();
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    await clearStore("buffers");
    await clearStore("remote");
    await clearStore("workspaces");

    const now = Date.now();
    const para = "The quick brown fox jumps over the lazy dog in a technical note about local storage and latency. ";
    const makeBody = (idx, size) => {
      let s = "Note #" + idx + " Architecture Summary\\n\\n";
      while (s.length < size) s += para + "\\n";
      return s.slice(0, size);
    };

    let sampleCipher = null;
    if (${encrypted}) {
      if (!window.vrtti.keyring.isSetUp) {
        await window.vrtti.keyring.setup({ deviceName: "PerfBench", askPassphrase: false, firstDevice: true });
      }
      sampleCipher = await window.vrtti.age.encrypt(
        makeBody(1, ${noteSizeBytes}),
        [window.vrtti.keyring.deviceRecipient],
        { armored: true }
      );
    }

    const tabs = [];
    const records = [];
    const totalBufs = ${openCount} + ${recentCount} + ${closedSyncedCount} + ${trashCount};
    for (let i = 0; i < totalBufs; i++) {
      const id = "note-" + String(i).padStart(6, "0");
      const rec = {
        id,
        content: ${encrypted} ? sampleCipher : makeBody(i, ${noteSizeBytes}),
        createdAt: now - (totalBufs - i) * 60000,
        updatedAt: now - (totalBufs - i) * 1000,
      };
      if (${encrypted}) {
        rec.enc = { v: 1, preset: "this-device" };
        rec.firstLine = "Note #" + i + " Encrypted";
      }
      if (i < ${openCount}) {
        tabs.push(id);
      } else if (i < ${openCount + recentCount}) {
        rec.closedAt = now - 3600000;
      } else if (i < ${openCount + recentCount + closedSyncedCount}) {
        rec.closedAt = now - 3600000;
        rec.sync = { rev: 1, dirty: false, space: "work" };
      } else {
        rec.trashedAt = now - 3600000;
      }
      records.push(rec);
    }

    for (let off = 0; off < records.length; off += 500) {
      await new Promise((resolve, reject) => {
        const tx = db.transaction("buffers", "readwrite");
        const st = tx.objectStore("buffers");
        for (let j = off; j < Math.min(off + 500, records.length); j++) st.put(records[j]);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    }

    if (${stubCount} > 0) {
      for (let off = 0; off < ${stubCount}; off += 500) {
        await new Promise((resolve, reject) => {
          const tx = db.transaction("remote", "readwrite");
          const st = tx.objectStore("remote");
          for (let j = off; j < Math.min(off + 500, ${stubCount}); j++) {
            st.put({
              id: "stub-" + String(j).padStart(6, "0"),
              space: j % 2 === 0 ? "archive" : "infra",
              title: "Remote Note #" + j,
              rev: 1,
              enc: true,
              spaceSeq: 1,
              updatedAt: now - j * 1000,
            });
          }
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
      }
    }

    await new Promise((resolve, reject) => {
      const tx = db.transaction("workspaces", "readwrite");
      tx.objectStore("workspaces").put({
        id: "main",
        tabs,
        activeId: tabs[0] ?? null,
        folderIds: [],
        createdAt: now,
        updatedAt: now,
      });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return { totalBufs, stubs: ${stubCount}, firstId: tabs[0] ?? null };
  })()`);
}

/**
 * Seed a Vrtti.Server SQLite database using Python's stdlib sqlite3 module.
 * Requires the server to have initialized the schema once beforehand.
 */
export function seedServerDb(
  dbPath,
  { docCount, revsPerDoc, avgBytes = 4096, bigDocRevs = 200, bigDocBytes = 512 * 1024 }
) {
  const devToken = "a".repeat(64);
  const tokenHash = crypto.createHash("sha256").update(devToken).digest("hex");
  const script = `
import sqlite3, json, time, sys

db_path, doc_count, revs_per_doc, avg_bytes, big_doc_revs, big_doc_bytes, token_hash = (
    sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]),
    int(sys.argv[5]), int(sys.argv[6]), sys.argv[7]
)

conn = sqlite3.connect(db_path)
conn.execute("PRAGMA journal_mode=WAL;")
conn.execute("PRAGMA synchronous=OFF;")

now = 1764000000000
conn.execute(
    "INSERT OR REPLACE INTO devices (id, token_hash, via_server_token, predecessor, created) VALUES (?, ?, 1, NULL, ?)",
    ("dev-1", token_hash, now),
)
for sp in ("personal", "work", "archive"):
    conn.execute("INSERT OR REPLACE INTO members (space, device_id) VALUES (?, ?)", (sp, "dev-1"))
    conn.execute(
        "INSERT OR REPLACE INTO space_log (space, seq, entry) VALUES (?, 1, ?)",
        (sp, json.dumps({"seq": 1, "op": "create", "space": sp})),
    )

header = "-----BEGIN AGE ENCRYPTED FILE-----\\n"
footer = "\\n-----END AGE ENCRYPTED FILE-----\\n"
body_small = header + ("A" * max(64, avg_bytes - len(header) - len(footer))) + footer
body_big = header + ("B" * max(64, big_doc_bytes - len(header) - len(footer))) + footer
sealed = header + ("S" * 180) + footer
meta = json.dumps({"kind": "scratch", "enc": {"v": 1, "preset": "space", "spaceSeq": 1}, "sealed": sealed})

spaces = ["personal", "work", "archive"]
rows = []
for r in range(1, revs_per_doc + 1):
    for i in range(doc_count):
        sp = spaces[i % 3]
        rows.append((f"doc-{i:06d}", r, "text", body_small, meta, "dev-1", now + r * 1000 + i, now + r * 1000 + i, sp, None))
        if len(rows) >= 5000:
            conn.executemany(
                "INSERT INTO revisions (doc_id, rev, kind, content, meta, device_id, client_time, server_time, space, prev_space) VALUES (?,?,?,?,?,?,?,?,?,?)",
                rows,
            )
            rows.clear()
if rows:
    conn.executemany(
        "INSERT INTO revisions (doc_id, rev, kind, content, meta, device_id, client_time, server_time, space, prev_space) VALUES (?,?,?,?,?,?,?,?,?,?)",
        rows,
    )

big_rows = [
    ("big-doc-001", r, "text", body_big, meta, "dev-1", now + r * 1000, now + r * 1000, "personal", None)
    for r in range(1, big_doc_revs + 1)
]
conn.executemany(
    "INSERT INTO revisions (doc_id, rev, kind, content, meta, device_id, client_time, server_time, space, prev_space) VALUES (?,?,?,?,?,?,?,?,?,?)",
    big_rows,
)
conn.commit()

total_revs = conn.execute("SELECT COUNT(*) FROM revisions").fetchone()[0]
max_seq = conn.execute("SELECT MAX(seq) FROM revisions").fetchone()[0]
conn.close()
print(json.dumps({"totalRevs": total_revs, "maxSeq": max_seq}))
`;
  const raw = execFileSync(
    "python3",
    ["-c", script, dbPath, String(docCount), String(revsPerDoc), String(avgBytes), String(bigDocRevs), String(bigDocBytes), tokenHash],
    { encoding: "utf8" }
  );
  return { devToken, ...JSON.parse(raw) };
}
