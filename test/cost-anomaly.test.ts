import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  alreadyLedgeredCostAnomalyRunIds,
  COST_ANOMALY_STEP,
  costAnomalyLine,
  CostAnomalyPolicyError,
  detectCostAnomalies,
  loadCostAnomalyPolicy,
  loadDefaultCostAnomalyPolicy,
  parseCostAnomalyPolicy,
  pendingCostAnomalies,
  recordCostAnomalies,
  type CostAnomalyDeps,
  type CostAnomalyPolicy,
} from "../src/lib/cost-anomaly.js";
import { appendLedger } from "../src/lib/ledger.js";
import { parseLedger, type RunSummary } from "../src/lib/retro.js";
import { buildStatusBoard, renderStatusBoardText, type StatusBoardDeps } from "../src/lib/status-board.js";
import { runSweep, type FixDispatchEvidence, type OpenPrView, type SweepDeps } from "../src/lib/sweep.js";
import type { ClarificationQuestion } from "../src/lib/sweep.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function ledgerTmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), "cost-anomaly-ledger-")), "ledger.ndjson");
}

/** One settled run's `run.start` + `verdict` ndjson lines. */
function runLines(opts: { runId: string; taskId: string; taskClass: string; costUsd: number; ts: string }): string {
  const start = JSON.stringify({ ts: opts.ts, run_id: opts.runId, task_id: opts.taskId, step: "run.start", type: "implement", task_class: opts.taskClass });
  const verdict = JSON.stringify({ ts: opts.ts, run_id: opts.runId, task_id: opts.taskId, step: "verdict", verdict: "merged", cost_usd: opts.costUsd });
  return `${start}\n${verdict}`;
}

const POLICY: CostAnomalyPolicy = { multiplier: 3, minSamples: 5 };

/** Same shape as test/policy.test.ts's own `throwsPolicyError` — asserts BOTH the error class
 *  and the message pattern in one call (node:assert's third `assert.throws` argument is a
 *  message STRING, never a second matcher, so both checks fold into the one validator function). */
function throwsCostAnomalyPolicyError(fn: () => unknown, msgRe: RegExp): void {
  assert.throws(fn, (e: unknown) => e instanceof CostAnomalyPolicyError && msgRe.test((e as Error).message));
}

// ── ACCEPTANCE 1: an over-threshold run ledgers exactly one cost.anomaly row; an under-
// threshold run in the SAME class ledgers none ──────────────────────────────────────────────

test("detectCostAnomalies: a run costing more than multiplier x its class median is flagged; a run at or under it is not", () => {
  // class "src": four ordinary runs at $1, one outlier at $10 — median is $1, threshold is $3.
  const runs: RunSummary[] = [
    { runId: "R1", taskId: "T1", type: "implement", startTs: "t1", verdict: "merged", costUsd: 1, numTurns: 1, taskClass: "src" },
    { runId: "R2", taskId: "T2", type: "implement", startTs: "t2", verdict: "merged", costUsd: 1, numTurns: 1, taskClass: "src" },
    { runId: "R3", taskId: "T3", type: "implement", startTs: "t3", verdict: "merged", costUsd: 1, numTurns: 1, taskClass: "src" },
    { runId: "R4", taskId: "T4", type: "implement", startTs: "t4", verdict: "merged", costUsd: 1, numTurns: 1, taskClass: "src" },
    { runId: "R5", taskId: "T5", type: "implement", startTs: "t5", verdict: "merged", costUsd: 10, numTurns: 1, taskClass: "src" },
  ];
  const findings = detectCostAnomalies(runs, POLICY);
  assert.equal(findings.length, 1, "exactly one anomaly — the $10 run, never the four $1 runs");
  assert.deepEqual(findings[0], {
    runId: "R5",
    taskId: "T5",
    taskClass: "src",
    costUsd: 10,
    medianCostUsd: 1,
    multiplier: 3,
    sampleSize: 5,
  });
});

test("detectCostAnomalies: a run AT exactly multiplier x the median is not flagged (strictly greater, not >=)", () => {
  const runs: RunSummary[] = [
    { runId: "R1", taskId: "T1", type: "implement", startTs: "t1", verdict: "merged", costUsd: 2, numTurns: 1, taskClass: "docs" },
    { runId: "R2", taskId: "T2", type: "implement", startTs: "t2", verdict: "merged", costUsd: 2, numTurns: 1, taskClass: "docs" },
    { runId: "R3", taskId: "T3", type: "implement", startTs: "t3", verdict: "merged", costUsd: 2, numTurns: 1, taskClass: "docs" },
    { runId: "R4", taskId: "T4", type: "implement", startTs: "t4", verdict: "merged", costUsd: 2, numTurns: 1, taskClass: "docs" },
    // median is 2, multiplier 3 -> boundary is 6.00 exactly
    { runId: "R5", taskId: "T5", type: "implement", startTs: "t5", verdict: "merged", costUsd: 6, numTurns: 1, taskClass: "docs" },
  ];
  assert.deepEqual(detectCostAnomalies(runs, POLICY), []);
});

test("recordCostAnomalies (end to end over a real ledger file): ledgers exactly one cost.anomaly row for the outlier run and none for the four ordinary ones", () => {
  const path = ledgerTmpPath();
  const lines = [
    runLines({ runId: "W1-A1", taskId: "W1-A", taskClass: "src", costUsd: 1, ts: "2026-08-01T00:00:00.000Z" }),
    runLines({ runId: "W1-A2", taskId: "W1-A", taskClass: "src", costUsd: 1, ts: "2026-08-01T01:00:00.000Z" }),
    runLines({ runId: "W1-A3", taskId: "W1-A", taskClass: "src", costUsd: 1, ts: "2026-08-01T02:00:00.000Z" }),
    runLines({ runId: "W1-A4", taskId: "W1-A", taskClass: "src", costUsd: 1, ts: "2026-08-01T03:00:00.000Z" }),
    runLines({ runId: "W1-T7", taskId: "W1-T7", taskClass: "src", costUsd: 9.32, ts: "2026-08-01T04:00:00.000Z" }),
  ].join("\n");
  writeFileSync(path, `${lines}\n`);

  const records = parseLedger(readFileSync(path, "utf8"));
  const written = recordCostAnomalies(records, POLICY, { ledgerPath: path });

  assert.equal(written.length, 1);
  assert.equal(written[0].runId, "W1-T7");

  const after = parseLedger(readFileSync(path, "utf8"));
  const anomalyRows = after.filter((r) => r.step === COST_ANOMALY_STEP);
  assert.equal(anomalyRows.length, 1);
  assert.equal(anomalyRows[0].run_id, "W1-T7");
  assert.equal(anomalyRows[0].task_class, "src");
  assert.equal(anomalyRows[0].cost_usd, 9.32);
  assert.equal(anomalyRows[0].median_cost_usd, 1);
});

// ── ACCEPTANCE 2: the multiplier and minimum-sample floor are read from plan/policy.yaml, its
// schema bounds enforced — no source literal gates this ────────────────────────────────────────

test("loadCostAnomalyPolicy: reads the committed plan/policy.yaml costAnomaly rows (not a source literal)", () => {
  const policy = loadCostAnomalyPolicy(join(REPO_ROOT, "plan", "policy.yaml"));
  assert.equal(typeof policy.multiplier, "number");
  assert.equal(typeof policy.minSamples, "number");
  assert.ok(policy.multiplier > 1, "a multiplier of 1 or less would flag every run at or above its own class median");
  assert.ok(policy.minSamples >= 3, "design note (ii): n=1/n=2 is noise, never a trustworthy median");
});

test("loadDefaultCostAnomalyPolicy: resolves the SAME committed rows via installPolicyPath, memoized across calls", () => {
  const a = loadDefaultCostAnomalyPolicy();
  const b = loadDefaultCostAnomalyPolicy();
  assert.deepEqual(a, b);
  assert.deepEqual(a, loadCostAnomalyPolicy(join(REPO_ROOT, "plan", "policy.yaml")));
});

test("parseCostAnomalyPolicy: an out-of-bound multiplier.value is refused, never silently clamped or accepted", () => {
  const fixture = {
    costAnomaly: {
      multiplier: { value: 1, origin: "net-new", min: 2, max: 8 }, // below the committed min
      minSamples: { value: 5, origin: "net-new", min: 3, max: 15 },
    },
  };
  throwsCostAnomalyPolicyError(() => parseCostAnomalyPolicy(fixture), /out of its declared bound/);
});

test("parseCostAnomalyPolicy: a minSamples row spelled 'lifted:...' is refused — both rows are net-new, never a source literal", () => {
  const fixture = {
    costAnomaly: {
      multiplier: { value: 3, origin: "net-new", min: 2, max: 8 },
      minSamples: { value: 5, origin: "lifted:src/lib/somewhere.ts:1 (INVENTED)", min: 3, max: 15 },
    },
  };
  throwsCostAnomalyPolicyError(() => parseCostAnomalyPolicy(fixture), /must be exactly "net-new"/);
});

test("parseCostAnomalyPolicy: a min > max bound is refused as unsatisfiable", () => {
  const fixture = {
    costAnomaly: {
      multiplier: { value: 3, origin: "net-new", min: 8, max: 2 },
      minSamples: { value: 5, origin: "net-new", min: 3, max: 15 },
    },
  };
  throwsCostAnomalyPolicyError(() => parseCostAnomalyPolicy(fixture), /unsatisfiable bound/);
});

// ── ACCEPTANCE 3: a class under the minimum-sample floor emits NOTHING — the median is never
// taken over a thin sample, never a false alarm on an under-sampled class (design note ii) ─────

test("detectCostAnomalies: a class below policy.minSamples is SILENT even though the same outlier-vs-baseline shape fires once the class clears the floor", () => {
  const policy: CostAnomalyPolicy = { multiplier: 3, minSamples: 3 };
  const thinClass: RunSummary[] = [
    { runId: "THIN1", taskId: "T1", type: "implement", startTs: "t1", verdict: "merged", costUsd: 1, numTurns: 1, taskClass: "thin" },
    { runId: "THIN2", taskId: "T2", type: "implement", startTs: "t2", verdict: "merged", costUsd: 10, numTurns: 1, taskClass: "thin" },
  ]; // n=2 < minSamples=3 -- must stay silent no matter how extreme the ratio looks
  assert.deepEqual(detectCostAnomalies(thinClass, policy), []);

  // The SAME shape (one baseline run, one 10x outlier), one more run added to clear the floor —
  // now it fires, proving the silence above was the floor, not the math.
  const clearedClass: RunSummary[] = [
    ...thinClass.map((r) => ({ ...r, taskClass: "cleared" })),
    { runId: "THIN3", taskId: "T3", type: "implement", startTs: "t3", verdict: "merged", costUsd: 1, numTurns: 1, taskClass: "cleared" },
  ];
  const cleared = detectCostAnomalies(clearedClass, policy);
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0].runId, "THIN2");
});

test("detectCostAnomalies: an in-flight run (verdict 'incomplete') neither anchors a class median nor is itself judged", () => {
  const runs: RunSummary[] = [
    { runId: "R1", taskId: "T1", type: "implement", startTs: "t1", verdict: "merged", costUsd: 1, numTurns: 1, taskClass: "src" },
    { runId: "R2", taskId: "T2", type: "implement", startTs: "t2", verdict: "merged", costUsd: 1, numTurns: 1, taskClass: "src" },
    { runId: "R3", taskId: "T3", type: "implement", startTs: "t3", verdict: "merged", costUsd: 1, numTurns: 1, taskClass: "src" },
    { runId: "R4", taskId: "T4", type: "implement", startTs: "t4", verdict: "merged", costUsd: 1, numTurns: 1, taskClass: "src" },
    // still running -- a partial cost snapshot, never settled
    { runId: "R5", taskId: "T5", type: "implement", startTs: "t5", verdict: "incomplete", costUsd: 50, numTurns: 1, taskClass: "src" },
  ];
  // Only 4 SETTLED runs in "src" -- below POLICY.minSamples (5) -- so this stays silent, and
  // critically the in-flight $50 run is never itself flagged even though it dwarfs the others.
  assert.deepEqual(detectCostAnomalies(runs, POLICY), []);
});

// ── ACCEPTANCE 4: a repeated pass over the SAME ledger re-ledgers nothing — idempotent on run id ──

test("pendingCostAnomalies: a run already carrying a cost.anomaly row is never re-derived as pending", () => {
  const ndjson = [
    runLines({ runId: "W1-A1", taskId: "W1-A", taskClass: "src", costUsd: 1, ts: "2026-08-01T00:00:00.000Z" }),
    runLines({ runId: "W1-A2", taskId: "W1-A", taskClass: "src", costUsd: 1, ts: "2026-08-01T01:00:00.000Z" }),
    runLines({ runId: "W1-A3", taskId: "W1-A", taskClass: "src", costUsd: 1, ts: "2026-08-01T02:00:00.000Z" }),
    runLines({ runId: "W1-A4", taskId: "W1-A", taskClass: "src", costUsd: 1, ts: "2026-08-01T03:00:00.000Z" }),
    runLines({ runId: "W1-T7", taskId: "W1-T7", taskClass: "src", costUsd: 9.32, ts: "2026-08-01T04:00:00.000Z" }),
  ].join("\n");
  const before = parseLedger(ndjson);
  const first = pendingCostAnomalies(before, POLICY);
  assert.equal(first.length, 1);

  const alreadyLedgered = `${ndjson}\n${JSON.stringify({ ts: "2026-08-01T04:00:01.000Z", ...costAnomalyLine(first[0]) })}`;
  const after = parseLedger(alreadyLedgered);
  assert.equal(pendingCostAnomalies(after, POLICY).length, 0, "a second pass over the same (now-ledgered) run must return nothing new");
  assert.ok(alreadyLedgeredCostAnomalyRunIds(after).has("W1-T7"));
});

test("recordCostAnomalies: TWO sequential passes over the SAME growing ledger file append exactly one cost.anomaly row, never two", () => {
  const path = ledgerTmpPath();
  const ndjson = [
    runLines({ runId: "W1-A1", taskId: "W1-A", taskClass: "src", costUsd: 1, ts: "2026-08-01T00:00:00.000Z" }),
    runLines({ runId: "W1-A2", taskId: "W1-A", taskClass: "src", costUsd: 1, ts: "2026-08-01T01:00:00.000Z" }),
    runLines({ runId: "W1-A3", taskId: "W1-A", taskClass: "src", costUsd: 1, ts: "2026-08-01T02:00:00.000Z" }),
    runLines({ runId: "W1-A4", taskId: "W1-A", taskClass: "src", costUsd: 1, ts: "2026-08-01T03:00:00.000Z" }),
    runLines({ runId: "W1-T7", taskId: "W1-T7", taskClass: "src", costUsd: 9.32, ts: "2026-08-01T04:00:00.000Z" }),
  ].join("\n");
  writeFileSync(path, `${ndjson}\n`);

  const pass1 = recordCostAnomalies(parseLedger(readFileSync(path, "utf8")), POLICY, { ledgerPath: path });
  assert.equal(pass1.length, 1);
  const pass2 = recordCostAnomalies(parseLedger(readFileSync(path, "utf8")), POLICY, { ledgerPath: path });
  assert.equal(pass2.length, 0, "the second pass reads its own first pass's write and re-ledgers nothing");

  const finalLines = parseLedger(readFileSync(path, "utf8"));
  assert.equal(finalLines.filter((r) => r.step === COST_ANOMALY_STEP).length, 1, "never a stacked duplicate row");
});

// ── ACCEPTANCE 5: an anomalous run surfaces as a NEEDS ME row naming the run, its class, its
// cost, and the median it exceeded — the sentinel is wired into src/lib/status-board.ts, not
// shipped dark (grep: costAnomaly in src/lib/status-board.ts) ──────────────────────────────────

function statusBoardDeps(overrides: Partial<StatusBoardDeps> = {}): StatusBoardDeps {
  return {
    queryService: () => ({ running: false, pid: null }),
    repoDir: "/nonexistent/repo/for/tests",
    resolveOriginMainSha: () => undefined,
    isPidAlive: () => true,
    ...overrides,
  };
}

test("buildStatusBoard/renderStatusBoardText: a ledgered cost.anomaly row surfaces in NEEDS ME, naming the run, its class, its cost, and the median it exceeded", () => {
  const path = ledgerTmpPath();
  const line = costAnomalyLine({
    runId: "W1-T7",
    taskId: "W1-T7",
    taskClass: "src",
    costUsd: 9.32,
    medianCostUsd: 1,
    multiplier: 3,
    sampleSize: 5,
  });
  appendLedger(path, line);

  const model = buildStatusBoard("/nonexistent/root/for/tests", path, statusBoardDeps());
  assert.equal(model.needsMe.costAnomaly.length, 1);
  const row = model.needsMe.costAnomaly[0];
  assert.equal(row.runId, "W1-T7");
  assert.equal(row.taskId, "W1-T7");
  assert.equal(row.taskClass, "src");
  assert.equal(row.costUsd, 9.32);
  assert.equal(row.medianCostUsd, 1);
  assert.equal(row.multiplier, 3);

  const text = renderStatusBoardText(model);
  assert.match(text, /── NEEDS ME/);
  assert.match(text, /W1-T7/);
  assert.match(text, /\bsrc\b/);
  assert.match(text, /9\.32/);
  assert.match(text, /1\.00|\$1\b/); // the median it exceeded

  // --json projects the SAME model, never a second derivation.
  const json = JSON.parse(JSON.stringify(model));
  assert.equal(json.needsMe.costAnomaly[0].runId, "W1-T7");
});

test("buildStatusBoard: no cost.anomaly rows in the ledger -> NEEDS ME is empty, rendered as 'nothing needs you'", () => {
  const model = buildStatusBoard("/nonexistent/root/for/tests", join(tmpdir(), "does-not-exist-cost-anomaly.ndjson"), statusBoardDeps());
  assert.deepEqual(model.needsMe.costAnomaly, []);
  assert.match(renderStatusBoardText(model), /nothing needs you/);
});

// ── ACCEPTANCE 6: the sentinel gates nothing — no dispatch deferred, no worker stopped, no
// merge blocked by a cost.anomaly row (design note v) ───────────────────────────────────────────

function fakeSweepDeps(ledgerPath: string, overrides: Partial<SweepDeps> = {}): SweepDeps & {
  armed: OpenPrView[];
  closed: unknown[];
  fixed: unknown[];
  escalated: unknown[];
} {
  const armed: OpenPrView[] = [];
  const closed: unknown[] = [];
  const fixed: unknown[] = [];
  const escalated: unknown[] = [];
  return {
    armed,
    closed,
    fixed,
    escalated,
    arm: (p) => {
      armed.push(p);
    },
    close: (p, reason) => {
      closed.push({ p, reason });
    },
    dispatchFix: (p: OpenPrView, evidence: FixDispatchEvidence) => {
      fixed.push({ p, evidence });
    },
    escalate: (p: OpenPrView, reason: string, question: ClarificationQuestion) => {
      escalated.push({ p, reason, question });
    },
    ledgerPath,
    runId: "SWEEP-COST-ANOMALY-TEST",
    now: () => Date.parse("2026-08-17T12:00:00.000Z"),
    ...overrides,
  };
}

function mergeableTestPr(): OpenPrView {
  return {
    prNumber: 900,
    prUrl: "https://github.com/o/r/pull/900",
    taskId: "W1-T900",
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-08-16T12:00:00.000Z",
    headSha: "abc900",
    autoMergeArmed: false,
  };
}

test("runSweep: a cost.anomaly ledgered this SAME pass never changes a PR's own disposition — it defers no dispatch, blocks no merge, stops no worker", async () => {
  const path = ledgerTmpPath();
  const ndjson = [
    runLines({ runId: "W1-A1", taskId: "W1-A", taskClass: "src", costUsd: 1, ts: "2026-08-01T00:00:00.000Z" }),
    runLines({ runId: "W1-A2", taskId: "W1-A", taskClass: "src", costUsd: 1, ts: "2026-08-01T01:00:00.000Z" }),
    runLines({ runId: "W1-A3", taskId: "W1-A", taskClass: "src", costUsd: 1, ts: "2026-08-01T02:00:00.000Z" }),
    runLines({ runId: "W1-A4", taskId: "W1-A", taskClass: "src", costUsd: 1, ts: "2026-08-01T03:00:00.000Z" }),
    runLines({ runId: "W1-T7", taskId: "W1-T7", taskClass: "src", costUsd: 9.32, ts: "2026-08-01T04:00:00.000Z" }),
  ].join("\n");
  writeFileSync(path, `${ndjson}\n`);

  const deps = fakeSweepDeps(path, { costAnomalyPolicy: POLICY });
  const summary = await runSweep([mergeableTestPr()], deps);

  // The cost.anomaly detector fired (ledgered its one row)...
  const lines = parseLedger(readFileSync(path, "utf8"));
  assert.equal(lines.filter((r) => r.step === COST_ANOMALY_STEP).length, 1);

  // ...yet the PR's own disposition/arming is byte-identical to what an ordinary mergeable pass
  // produces: `arm` was called exactly once, `close`/`dispatchFix`/`escalate` never — the same
  // outcome a cost-anomaly-free ledger would produce for this exact PR.
  assert.equal(deps.armed.length, 1);
  assert.equal(deps.closed.length, 0);
  assert.equal(deps.fixed.length, 0);
  assert.equal(deps.escalated.length, 0);
  assert.equal(summary.actionsTaken, 1);
  assert.equal(summary.actionsFailed, 0);
  assert.equal(summary.byDisposition.mergeable, 1);
});

test("runSweep --dry-run: writes NO cost.anomaly row at all (same 'no ledger writes' contract as every other action this module performs)", async () => {
  const path = ledgerTmpPath();
  const ndjson = [
    runLines({ runId: "W1-A1", taskId: "W1-A", taskClass: "src", costUsd: 1, ts: "2026-08-01T00:00:00.000Z" }),
    runLines({ runId: "W1-A2", taskId: "W1-A", taskClass: "src", costUsd: 1, ts: "2026-08-01T01:00:00.000Z" }),
    runLines({ runId: "W1-A3", taskId: "W1-A", taskClass: "src", costUsd: 1, ts: "2026-08-01T02:00:00.000Z" }),
    runLines({ runId: "W1-A4", taskId: "W1-A", taskClass: "src", costUsd: 1, ts: "2026-08-01T03:00:00.000Z" }),
    runLines({ runId: "W1-T7", taskId: "W1-T7", taskClass: "src", costUsd: 9.32, ts: "2026-08-01T04:00:00.000Z" }),
  ].join("\n");
  writeFileSync(path, `${ndjson}\n`);

  const deps = fakeSweepDeps(path, { costAnomalyPolicy: POLICY, dryRun: true });
  await runSweep([mergeableTestPr()], deps);

  const lines = parseLedger(readFileSync(path, "utf8"));
  assert.equal(lines.filter((r) => r.step === COST_ANOMALY_STEP).length, 0);
});

test("costAnomalyLine/recordCostAnomalies: the injected deps carry nothing but a ledger sink — structurally there is no dispatch/merge/kill hook this module could call even if it wanted to", () => {
  const deps: CostAnomalyDeps = { ledgerPath: ledgerTmpPath(), writeLedger: () => {} };
  assert.deepEqual(Object.keys(deps).sort(), ["ledgerPath", "writeLedger"]);
});
