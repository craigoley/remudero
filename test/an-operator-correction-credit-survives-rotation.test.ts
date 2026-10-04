/**
 * W1-T5551 — AN OPERATOR CORRECTION CREDIT SURVIVES ROTATION.
 *
 * MEASURED on the fleet host 2026-10-03 (read-only): `correction.provenance` sits on rotation's retained-step
 * list, yet the live ledger held none of the 7 rows `rmd correct` ever wrote. The whole-snapshot archive at
 * 2026-09-26T21:32 still carried three in its core (oldest core row 09-22T15:23); the rotation at
 * 2026-09-26T23:34 logged `ledger.rotation_shed` shed_count 433, and the next whole snapshot (09-27T12:48)
 * began at 09-23T03:29 with one left — W1-T3990's and W1-T3991's rows (09-23T00:22) were the OLDEST rows in
 * the core, so the convergence shed, which evicts by age across every step, took them first. The shed fires
 * about daily (19 pointers 09-07..10-02), so the last one went the same way. A retained step far under its
 * 200-row cap was evicted anyway.
 *
 * Two halves, both asserted here: (1) the shed no longer evicts a correction row; (2) a correction already
 * gone from the live file still projects `source: correction`, because the projection persisted it to the
 * durable credit store (`merge-credit.json`) the first time it read it live.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { rotateLedger } from "../src/lib/ledger.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { defaultCreditStorePath, loadCreditStore, projectPlan, type CreditStore } from "../src/lib/status.js";
import { fakeGitHub } from "./helpers/fake-github.js";

const CORRECTED_PR = "https://github.com/craigoley/remudero/pull/6492";

function rawLine(step: string, taskId: string, tsMs: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts: new Date(tsMs).toISOString(), run_id: `${step}-${taskId}-${tsMs}`, task_id: taskId, step, ...extra });
}

function correctionLine(taskId: string, tsMs: number, actual = CORRECTED_PR): string {
  return rawLine("correction.provenance", taskId, tsMs, { claimed_pr_url: null, actual_pr_url: actual, by: "operator", reason: "fixture" });
}

function task(id: string): Task {
  return { id, title: id, repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 };
}

function planOf(...tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

test("the convergence shed no longer evicts a correction.provenance row, even when it is the oldest row in the retained core", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t5551-shed-"));
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const base = Date.now() - 3_600_000;
    // The 2026-09-26T23:34 shape: an old correction, then a core of newer retained rows past the ceiling.
    const lines = [correctionLine("W1-CORRECTED", base - 1_000)];
    for (let i = 0; i < 400; i++) lines.push(rawLine("run.start", `W1-BLOAT-${i}`, base + i));
    writeFileSync(ledgerPath, lines.join("\n") + "\n");

    const result = rotateLedger(ledgerPath, { ceilingBytes: 6000, smoothingWindowMs: 0 });

    const live = readFileSync(ledgerPath, "utf8");
    // POSITIVE CONTROL: the shed really fired, and took the oldest run.start — the path under test ran.
    assert.equal(result.rotated, true);
    assert.match(live, /"step":"ledger\.rotation_shed"/);
    assert.doesNotMatch(live, /"task_id":"W1-BLOAT-0"/);
    assert.match(live, /"step":"correction\.provenance"/, "the correction row must outlive the age-ordered shed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a correction.provenance credit still projects source correction after its row has rotated out of the live ledger into an archive", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-t5551-credit-"));
  try {
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    const ledgerPath = join(stateDir, "ledger.ndjson");
    const plan = planOf(task("W1-CORRECTED"), task("W1-UNCORRECTED"));
    const tsMs = Date.now() - 86_400_000;
    const row = correctionLine("W1-CORRECTED", tsMs);
    writeFileSync(ledgerPath, row + "\n" + rawLine("run.start", "W1-UNCORRECTED", tsMs + 1) + "\n");

    // 1. While the row is live, the projection credits it — and records it durably.
    const first = projectPlan(plan, { ledgerPath, github: fakeGitHub() });
    assert.equal(first.get("W1-CORRECTED")?.source, "correction");
    assert.deepEqual(loadCreditStore(defaultCreditStorePath(ledgerPath))["W1-CORRECTED"]?.correction, {
      prUrl: CORRECTED_PR,
      prNumber: 6492,
    });

    // 2. The row leaves the live file and survives ONLY in a dated archive (the 2026-09-26 shed's outcome).
    writeFileSync(join(stateDir, "ledger.2026-09-26T21-32-30-286Z.ndjson.gz"), gzipSync(row + "\n"));
    writeFileSync(ledgerPath, rawLine("run.start", "W1-UNCORRECTED", tsMs + 2) + "\n");
    assert.doesNotMatch(readFileSync(ledgerPath, "utf8"), /correction\.provenance/);

    const after = projectPlan(plan, { ledgerPath, github: fakeGitHub() });
    assert.equal(after.get("W1-CORRECTED")?.source, "correction");
    assert.equal(after.get("W1-CORRECTED")?.status, "merged");
    assert.equal(after.get("W1-CORRECTED")?.prNumber, 6492);
    // CONTROL: an uncorrected neighbour still reads queued — the store credits only what a correction named.
    assert.equal(after.get("W1-UNCORRECTED")?.merged, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a newer live correction replaces the durable one, and an unchanged one costs no store write", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-t5551-newer-"));
  try {
    const ledgerPath = join(root, "ledger.ndjson");
    const plan = planOf(task("W1-CORRECTED"));
    const tsMs = Date.now() - 86_400_000;
    const later = "https://github.com/craigoley/remudero/pull/7001";
    writeFileSync(ledgerPath, correctionLine("W1-CORRECTED", tsMs) + "\n" + correctionLine("W1-CORRECTED", tsMs + 1, later) + "\n");
    let writes = 0;
    let store: CreditStore = { "W1-CORRECTED": { correction: { prUrl: CORRECTED_PR, prNumber: 6492 } } };
    const deps = {
      ledgerPath,
      github: fakeGitHub(),
      readCreditStore: () => store,
      writeCreditStore: (next: CreditStore) => {
        writes++;
        store = next;
      },
    };
    assert.equal(projectPlan(plan, deps).get("W1-CORRECTED")?.prNumber, 7001);
    assert.deepEqual(store["W1-CORRECTED"]?.correction, { prUrl: later, prNumber: 7001 });
    assert.equal(writes, 1);
    projectPlan(plan, deps);
    assert.equal(writes, 1, "a correction the store already holds is not rewritten");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
