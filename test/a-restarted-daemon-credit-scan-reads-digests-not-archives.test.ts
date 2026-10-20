import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { ledgerRotationEntries } from "#src/lib/ledger-union.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
// Namespace imports: this file must LOAD on a base without the W1-T10048 symbols, so each proof fails
// there on its own assertion rather than on a missing export.
import * as status from "#src/lib/status.js";
import * as sweep from "#src/lib/sweep.js";

// W1-T10048. OBSERVED 2026-10-17: the first sweep.credit_backfill pass after each daemon boot streamed the whole
// archive set (275 rotations newest-first, about 309 MB) for about 60 KB of merge-credit rows, because the async
// scan's rotation memo lived only as long as the process. A restarted process must answer from durable digests:
// here every archive is overwritten with same-length garbage under its original size and mtime first.

const ROTATIONS = [
  "ledger.2026-10-12T00-00-00-000Z.ndjson.gz",
  "ledger.2026-10-13T00-00-00-000Z.ndjson.gz",
  "ledger.2026-10-14T00-00-00-000Z.ndjson.gz",
];
/** A whole-second mtime, so restoring it after the overwrite reproduces the size:mtime key exactly. */
const MTIME_S = 1_791_000_000;

function credit(taskId: string, ts: string): string {
  return JSON.stringify({ ts, run_id: `RUN-${taskId}`, task_id: taskId, step: "verdict.merged", verdict: "merged" });
}

/** Three gzipped rotations, each crediting one OLD task among unrelated rows, and a live file crediting LIVE. */
function corpus(prefix: string): { dir: string; live: string } {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${prefix}-`));
  ROTATIONS.forEach((name, i) => {
    const noise = Array.from({ length: 200 }, (_, n) => JSON.stringify({ ts: `2026-10-1${2 + i}T00:00:00.000Z`, step: "noise", n }));
    const text = [...noise, credit(`OLD-${i}`, `2026-10-1${2 + i}T01:00:00.000Z`)].join("\n") + "\n";
    writeFileSync(join(dir, name), gzipSync(Buffer.from(text)));
    utimesSync(join(dir, name), MTIME_S, MTIME_S);
  });
  writeFileSync(join(dir, "ledger.ndjson"), credit("LIVE", "2026-10-14T12:00:00.000Z") + "\n");
  return { dir, live: join(dir, "ledger.ndjson") };
}

/** The restarted process's view: every archive is now unreadable garbage of the same length, at the same mtime. */
function garbleArchives(dir: string): void {
  for (const entry of ledgerRotationEntries(readdirSync(dir), dir)) {
    writeFileSync(entry.path, Buffer.alloc(statSync(entry.path).size, 0x21));
    utimesSync(entry.path, MTIME_S, MTIME_S);
  }
}

const EVERY_CREDIT = ["LIVE", "OLD-0", "OLD-1", "OLD-2"];

test("W1-T10048: a fresh process credit scan reads digests, not rotations", async () => {
  const { dir, live } = corpus("credit-digest");
  try {
    // The daemon's own scan, with the production memo, credits every archived merge and leaves its digests.
    const first = await status.readMergeCreditedTaskIdsAsync(live);
    assert.deepEqual([...first.credited].sort(), EVERY_CREDIT);
    garbleArchives(dir);

    // A RESTARTED daemon: a new process whose production memo has never seen this corpus.
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const original = fs.createReadStream;
      let archiveReads = 0;
      fs.createReadStream = (...args) => { archiveReads++; return original(...args); };
      syncBuiltinESMExports();
      const { readMergeCreditedTaskIdsAsync } = await import("#src/lib/status.js");
      const read = await readMergeCreditedTaskIdsAsync(process.argv[1]);
      console.log(JSON.stringify({ archiveReads, credited: [...read.credited].sort(), filesRead: read.filesRead }));
    `, live], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const restarted = JSON.parse(child.stdout.trim().split("\n").at(-1) as string);
    assert.deepEqual(restarted.credited, EVERY_CREDIT, "the restarted scan still credits every archived merge");
    assert.equal(restarted.archiveReads, 0, "and opened no archive to do it");
    assert.equal(restarted.filesRead, ROTATIONS.length + 1);

    // The seam a test stands in for a restart with: a fresh memo, the same answer, every rotation a digest hit.
    const fresh = await status.readMergeCreditedTaskIdsAsync(live, { memo: status.createCreditScanMemo?.() });
    assert.deepEqual([...fresh.credited].sort(), EVERY_CREDIT);
    assert.deepEqual([fresh.rotationsLoaded, fresh.digestHits, fresh.digestMisses], [ROTATIONS.length, ROTATIONS.length, 0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T10048: the credit summary row names its digest hits and loads", async () => {
  const { dir, live } = corpus("credit-summary");
  try {
    const candidate = { taskId: "OLD-0", prNumber: 7, prUrl: "https://github.com/o/r/pull/7", merged: true };
    const pass = async () => {
      const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
      const summary = await sweep.runCreditBackfill([candidate], { ledgerPath: live, runId: "SWEEP-1", log: (step, extra) => logs.push({ step, extra }) });
      return { summary, row: logs.find((l) => l.step === "sweep.credit_backfill.summary")?.extra };
    };
    // A first pass walks to the oldest rotation, loading each one: a cold store, so every load is a digest miss.
    const cold = await pass();
    assert.ok(cold.row, "the summary fires on every pass");
    assert.equal(cold.row.credit_scan_files_read, ROTATIONS.length + 1);
    assert.equal(cold.row.credit_scan_rotations_loaded, ROTATIONS.length);
    assert.equal(cold.row.credit_scan_digest_misses, ROTATIONS.length);
    assert.equal(cold.row.credit_scan_digest_hits, 0);
    assert.equal(cold.summary.creditScanRotationsLoaded, ROTATIONS.length);
    // A second pass in the same process loads nothing: the rotations are already in memory.
    const warm = await pass();
    assert.deepEqual(
      [warm.row?.credit_scan_rotations_loaded, warm.row?.credit_scan_digest_hits, warm.row?.credit_scan_digest_misses],
      [0, 0, 0],
    );
    // A fresh memo over the same store reads every rotation from its digest.
    garbleArchives(dir);
    const restarted = await status.readMergeCreditedTaskIdsAsync(live, { candidates: ["OLD-0"], memo: status.createCreditScanMemo?.() });
    assert.equal(restarted.complete, true, "the archived credit is found after the restart");
    assert.deepEqual([restarted.rotationsLoaded, restarted.digestHits, restarted.digestMisses], [ROTATIONS.length, ROTATIONS.length, 0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
