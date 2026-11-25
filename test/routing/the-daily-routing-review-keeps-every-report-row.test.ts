/**
 * W1-T14836: on 2026-11-25 the host's daily routing review counted experiment tasks again (W1-T14473, W1-T14801) but
 * stayed observed-partial. Its 32 MiB and 100,000-row retention defaults dropped 157,433 core report rows, and the
 * daemon's own appends to the live ledger during the scan read as a changed corpus. The defaults are gone (an
 * explicit bound still binds), a live ledger that only grew is the same corpus, and observeReviewFlow takes any count.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openLedgerUnion } from "#src/lib/ledger-union.js";
import { observeReviewFlow } from "#src/lib/review-flow-observation.js";
import { ROUTING_EXPERIMENTS } from "#src/lib/routing-experiments.js";

// `scripts/**` has no declarations, so the review loads through a dynamic specifier, as its other suites load it.
const reviewModule = "#scripts/private-routing-daily-review.mjs";
const { dailyRoutingReview } = await import(reviewModule);

const asOf = "2026-10-02T14:00:00.000Z";
const ts = "2026-10-02T10:00:00.000Z";
const epoch = ROUTING_EXPERIMENTS.find((item) => item.id === "sol61-vs-sonnet55")!;
const assignment = (id: string, pad = "") => ({ ts, step: "worker.assignment", task_id: `W1-T${id}`, pad,
  worker_assignment: { id: `a-${id}`, selected: { provider: "codex" }, routing: { decision: { ab: epoch.id,
    considered: [{ provider: "claude", model: "claude-sonnet-5-5" }] }, experiment: { assignedArm: "sol61", crossover: false } } } });
const encode = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

async function review(rows: unknown[], options: { retention?: Record<string, number>; openUnion?: typeof openLedgerUnion } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-routing-keeps-"));
  try {
    const stateDir = join(dir, "state");
    mkdirSync(stateDir);
    writeFileSync(join(stateDir, "ledger.ndjson"), encode(rows));
    const { snapshot } = await dailyRoutingReview({ sources: [{ label: "core", stateDir }], outDir: join(dir, "out"), asOf,
      retention: { scratchDir: dir, ...options.retention }, ...(options.openUnion ? { openUnion: options.openUnion } : {}) });
    return snapshot.sources[0];
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const tasks = (source: { reports: { id: string; arms: { arm: string; tasks: number }[] }[] }) =>
  source.reports.find((report) => report.id === epoch.id)!.arms.find((arm) => arm.arm === "sol61")!.tasks;

// 1,200 report rows of ~16 KiB UTF-16 each: about 19 MiB of JS strings, over 32 MiB as the review counts bytes (x2).
const BIG = Array.from({ length: 1200 }, (_, n) => assignment(String(n), "p".repeat(14_000)));

test("W1-T14836 criterion 1: with no retention options every report row over the old 32 MiB default is retained", async () => {
  const source = await review(BIG);
  assert.ok(source.auditedRetainedBytes > 32 * 1024 * 1024, `audited ${source.auditedRetainedBytes} bytes`);
  assert.equal(source.retainedRows, BIG.length);
  assert.equal(source.retainedRowsOmitted, 0);
  assert.deepEqual(source.reasons.filter((reason: string) => reason.startsWith("ledger-retention-")), []);
  assert.equal(source.maxRetainedBytes, null);
  assert.equal(tasks(source), BIG.length);
});

test("W1-T14836 criterion 2: invariant:an-explicit-retention-bound-still-binds", async () => {
  const bytes = await review(BIG, { retention: { maxRetainedBytes: 32 * 1024 * 1024 } });
  assert.ok(bytes.retainedRowsOmitted > 0);
  assert.ok(bytes.reasons.includes("ledger-retention-byte-bound"));
  assert.equal(bytes.state, "observed-partial");
  const rows = await review(BIG.slice(0, 3), { retention: { maxRetainedRows: 2 } });
  assert.equal(rows.retainedRowsOmitted, 1);
  assert.ok(rows.reasons.includes("ledger-retention-row-bound"));
});

test("W1-T14836 criterion 3: a live append during the scan is not a changed corpus, a rewrite or rotation still is", async () => {
  const rows = [assignment("1"), assignment("2")];
  // The daemon appends between the audit read and delivery: same inode, the audited bytes unchanged.
  const between = (act: (stateDir: string) => void): typeof openLedgerUnion => {
    let reads = 0;
    return async function* (dir, options) {
      if (++reads === 2) act(dir);
      yield* openLedgerUnion(dir, options);
    };
  };
  const appended = await review(rows, { openUnion: between((dir) =>
    appendFileSync(join(dir, "ledger.ndjson"), encode([{ ts: "2026-10-02T15:00:00Z", step: "unrelated" }]))) });
  assert.ok(!appended.reasons.includes("ledger-source-changed-during-review"), appended.reasons.join(","));
  assert.equal(appended.state, "observed");
  assert.equal(appended.retainedRows, 2);

  const rewritten = await review(rows, { openUnion: between((dir) =>
    writeFileSync(join(dir, "ledger.ndjson"), encode([assignment("1"), assignment("3"), assignment("4")]))) });
  assert.ok(rewritten.reasons.includes("ledger-source-changed-during-review"), "a rewrite of audited bytes is a change");

  const rotated = await review(rows, { openUnion: between((dir) =>
    writeFileSync(join(dir, "ledger.2026-10-02T13-00-00-000Z.ndjson"), encode([assignment("9")]))) });
  assert.ok(rotated.reasons.includes("ledger-source-changed-during-review"), "a new rotation is a change");
});

test("W1-T14836 criterion 4: observeReviewFlow accepts more than 100,000 rows", () => {
  const rows = Array.from({ length: 100_001 }, (_, n) => ({ ts, step: "sweep.review_eligible", pr_url: `https://x/pull/${n}`,
    head_sha: `sha${n}`, review_input_digest: `d${n}` }));
  const report = observeReviewFlow(rows, asOf, "2026-10-01T14:00:00.000Z");
  assert.equal(report.counts.unresolvedSourceGap, 100_001);
});
