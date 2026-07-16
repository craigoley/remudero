import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregateByType,
  assertArchitectAboveWorker,
  buildGather,
  calibrationTable,
  codeFilesInDiff,
  gatherRuns,
  mergedSince,
  ownBranchOf,
  parseLedger,
  shippedSince,
  tierOf,
  verdictDistribution,
  type ShippedGithub,
} from "../src/lib/retro.js";

// A recorded ledger fixture: two implement runs (one merged, one budget-blocked)
// and a recon run, exactly as run-task.ts writes them.
const LEDGER = [
  `{"ts":"2026-01-01T00:00:00.000Z","run_id":"A","task_id":"TA","step":"run.start","type":"implement","budget_usd":100}`,
  `{"ts":"2026-01-01T00:01:00.000Z","run_id":"A","task_id":"TA","step":"recon.done","num_turns":2,"cost_usd":0.2}`,
  `{"ts":"2026-01-01T00:02:00.000Z","run_id":"A","task_id":"TA","step":"implement.done","num_turns":10,"cost_usd":1.5}`,
  `{"ts":"2026-01-01T00:03:00.000Z","run_id":"A","task_id":"TA","step":"pr.opened","pr_url":"https://github.com/o/r/pull/1"}`,
  `{"ts":"2026-01-01T00:04:00.000Z","run_id":"A","task_id":"TA","step":"verdict","verdict":"merged","cost_usd":2.0,"pr_url":"https://github.com/o/r/pull/1"}`,
  `torn line that is not json {{{`,
  `{"ts":"2026-01-02T00:00:00.000Z","run_id":"B","task_id":"TB","step":"run.start","type":"implement","budget_usd":100}`,
  `{"ts":"2026-01-02T00:01:00.000Z","run_id":"B","task_id":"TB","step":"recon.done","num_turns":2}`,
  `{"ts":"2026-01-02T00:02:00.000Z","run_id":"B","task_id":"TB","step":"implement.done","num_turns":30}`,
  `{"ts":"2026-01-02T00:03:00.000Z","run_id":"B","task_id":"TB","step":"verdict","verdict":"blocked_budget","cost_usd":5.0}`,
  `{"ts":"2026-01-03T00:00:00.000Z","run_id":"C","task_id":"TC","step":"run.start","type":"diagnose"}`,
  `{"ts":"2026-01-03T00:01:00.000Z","run_id":"C","task_id":"TC","step":"verdict","verdict":"merged","cost_usd":0.3}`,
].join("\n");

test("parseLedger skips torn lines and keeps the valid ones", () => {
  const recs = parseLedger(LEDGER);
  assert.equal(recs.filter((r) => r.step === "run.start").length, 3);
});

test("gatherRuns reduces per-run: type, verdict, cost, summed turns, prUrl", () => {
  const runs = gatherRuns(parseLedger(LEDGER));
  const a = runs.find((r) => r.runId === "A")!;
  assert.equal(a.type, "implement");
  assert.equal(a.verdict, "merged");
  assert.equal(a.costUsd, 2.0); // the verdict line's total, not the per-step costs
  assert.equal(a.numTurns, 12); // recon 2 + implement 10
  assert.equal(a.prUrl, "https://github.com/o/r/pull/1");
  const b = runs.find((r) => r.runId === "B")!;
  assert.equal(b.verdict, "blocked_budget");
  assert.equal(b.numTurns, 32);
});

test("aggregateByType is the calibration data mounts.yaml needs (avg cost + turns by type)", () => {
  const agg = aggregateByType(gatherRuns(parseLedger(LEDGER)));
  const impl = agg.find((t) => t.type === "implement")!;
  assert.equal(impl.runs, 2);
  assert.equal(impl.totalCostUsd, 7.0);
  assert.equal(impl.avgCostUsd, 3.5);
  assert.equal(impl.avgTurns, 22); // (12 + 32) / 2
  assert.equal(impl.merged, 1);
});

test("verdictDistribution counts each terminal verdict", () => {
  const dist = verdictDistribution(gatherRuns(parseLedger(LEDGER)));
  assert.deepEqual(dist, { blocked_budget: 1, merged: 2 });
});

test("mergedSince returns merged runs strictly after the marker ts, keyed by task", () => {
  const runs = gatherRuns(parseLedger(LEDGER));
  assert.deepEqual(mergedSince(runs, undefined).map((r) => r.taskId), ["TA", "TC"]);
  // A marker after run A excludes it; C (2026-01-03) still counts.
  assert.deepEqual(mergedSince(runs, "2026-01-02T00:00:00.000Z").map((r) => r.taskId), ["TC"]);
});

test("Tier Invariant (G-17): the Architect must OUTRANK the worker (fail-closed)", () => {
  assert.equal(tierOf("opus"), 3);
  assert.equal(tierOf("sonnet"), 2);
  assert.doesNotThrow(() => assertArchitectAboveWorker("opus", "sonnet"));
  assert.doesNotThrow(() => assertArchitectAboveWorker("claude-opus-4-8", "claude-sonnet-5"));
  assert.throws(() => assertArchitectAboveWorker("sonnet", "sonnet"), /Tier Invariant/);
  assert.throws(() => assertArchitectAboveWorker("sonnet", "opus"), /Tier Invariant/);
});

test("calibrationTable renders a markdown table with a row per type", () => {
  const table = calibrationTable(aggregateByType(gatherRuns(parseLedger(LEDGER))));
  assert.match(table, /task_type \| runs \| merged \| avg \$/);
  assert.match(table, /\| implement \| 2 \| 1 \|/);
  assert.match(table, /\| diagnose \| 1 \| 1 \|/);
});

test("codeFilesInDiff: a plan-only diff touches no src/test; a code diff is caught (fail-closed guard)", () => {
  const planOnly = [
    "diff --git a/MASTER-PLAN.md b/MASTER-PLAN.md",
    "+++ b/MASTER-PLAN.md",
    "+a plan edit",
    "+++ b/LEARNINGS.md",
    "+a learning",
  ].join("\n");
  assert.deepEqual(codeFilesInDiff(planOnly), []);
  const withCode = planOnly + "\n+++ b/src/run-task.ts\n+code\n+++ b/test/x.test.ts\n+t";
  assert.deepEqual(codeFilesInDiff(withCode), ["src/run-task.ts", "test/x.test.ts"]);
});

// ── W1-T51: SHIPPED union (ledger ∪ GitHub-derived trailered merges), P9 ownership assert + correction-awareness ──

// A ledger fixture with: a blocked run whose task later merged gate-side (T-GATE), a
// clean ledger-merged run whose PR IS its own branch (T-OK), and a run modeled on the
// real W1-T54b/#80/#91 false-attribution incident: verdict.pr_url claims #80 (foreign,
// Dependabot's PR) but a correction.provenance line names the true #91.
const SHIP_LEDGER = [
  `{"ts":"2026-02-01T00:00:00.000Z","run_id":"RGATE","task_id":"T-GATE","step":"run.start","type":"implement"}`,
  `{"ts":"2026-02-01T00:01:00.000Z","run_id":"RGATE","task_id":"T-GATE","step":"verdict","verdict":"blocked_review","cost_usd":1.1}`,
  `{"ts":"2026-02-01T01:00:00.000Z","run_id":"ROK","task_id":"T-OK","step":"run.start","type":"implement"}`,
  `{"ts":"2026-02-01T01:01:00.000Z","run_id":"ROK","task_id":"T-OK","step":"pr.opened","pr_url":"https://github.com/o/r/pull/10"}`,
  `{"ts":"2026-02-01T01:02:00.000Z","run_id":"ROK","task_id":"T-OK","step":"verdict","verdict":"merged","cost_usd":2.2,"pr_url":"https://github.com/o/r/pull/10"}`,
  `{"ts":"2026-02-01T02:00:00.000Z","run_id":"W1-T54b-1784151420811","task_id":"W1-T54b","step":"run.start","type":"implement"}`,
  `{"ts":"2026-02-01T02:01:00.000Z","run_id":"W1-T54b-1784151420811","task_id":"W1-T54b","step":"pr.opened","pr_url":"https://github.com/o/r/pull/80"}`,
  `{"ts":"2026-02-01T02:02:00.000Z","run_id":"W1-T54b-1784151420811","task_id":"W1-T54b","step":"verdict","verdict":"merged","cost_usd":3.3,"pr_url":"https://github.com/o/r/pull/80"}`,
  `{"ts":"2026-02-01T02:03:00.000Z","run_id":"W1-T54b-1784151420811","task_id":"W1-T54b","step":"correction.provenance","claimed_pr_url":"https://github.com/o/r/pull/80","actual_pr_url":"https://github.com/o/r/pull/91"}`,
].join("\n");

test("ownBranchOf: a run's own branch is deterministic run-<runId> (matches run-task.ts worktree naming)", () => {
  assert.equal(ownBranchOf("ROK"), "run-ROK");
});

test("gatherRuns: a correction.provenance line OVERRIDES verdict.pr_url (never the claimed URL)", () => {
  const runs = gatherRuns(parseLedger(SHIP_LEDGER));
  const corrected = runs.find((r) => r.runId === "W1-T54b-1784151420811")!;
  assert.equal(corrected.prUrl, "https://github.com/o/r/pull/91");
  assert.equal(corrected.correctedFromPrUrl, "https://github.com/o/r/pull/80");
  // An uncorrected run is untouched.
  const ok = runs.find((r) => r.runId === "ROK")!;
  assert.equal(ok.prUrl, "https://github.com/o/r/pull/10");
  assert.equal(ok.correctedFromPrUrl, undefined);
});

function fakeGithub(overrides: Partial<ShippedGithub> = {}): ShippedGithub {
  return { findMergedByTrailer: () => null, headRefName: () => undefined, ...overrides };
}

test("shippedSince: a gate-side merge (blocked run, later merged on GitHub) is credited + annotated + the discrepancy is NAMED", () => {
  const runs = gatherRuns(parseLedger(SHIP_LEDGER));
  const github = fakeGithub({
    findMergedByTrailer: (taskId) =>
      taskId === "T-GATE" ? { number: 42, url: "https://github.com/o/r/pull/42" } : null,
    headRefName: (url) => (url === "https://github.com/o/r/pull/42" ? "run-RGATE" : undefined),
  });
  const { shipped, discrepancies } = shippedSince(runs, undefined, github);
  const gate = shipped.find((s) => s.taskId === "T-GATE");
  assert.ok(gate, "gate-side merge must appear in SHIPPED additions");
  assert.equal(gate!.source, "github");
  assert.equal(gate!.annotation, "gate-side merge; run ended blocked_review");
  assert.ok(
    discrepancies.some((d) => d.includes("T-GATE") && d.includes("blocked_review")),
    "the discrepancy must be NAMED in the retro output",
  );
});

test("shippedSince: a ledger-merged run with matching ownership behaves as today — included, no annotation", () => {
  const runs = gatherRuns(parseLedger(SHIP_LEDGER));
  const github = fakeGithub({
    headRefName: (url) => (url === "https://github.com/o/r/pull/10" ? "run-ROK" : undefined),
  });
  const { shipped } = shippedSince(runs, undefined, github);
  const ok = shipped.find((s) => s.taskId === "T-OK");
  assert.ok(ok);
  assert.equal(ok!.source, "ledger");
  assert.equal(ok!.annotation, undefined);
});

test("shippedSince: P9 OWNERSHIP ASSERT rejects a trailered PR whose head branch is NOT the claiming run's branch (the #80/W1-T54b class) — never credited; a matching branch IS credited", () => {
  const runs = gatherRuns(parseLedger(SHIP_LEDGER));
  const github = fakeGithub({
    // #80 is foreign (Dependabot's branch); #91 (the corrected URL) IS this run's own branch.
    headRefName: (url) => {
      if (url === "https://github.com/o/r/pull/80") return "dependabot/npm_and_yarn/x";
      if (url === "https://github.com/o/r/pull/91") return "run-W1-T54b-1784151420811";
      return undefined;
    },
  });
  const { shipped, discrepancies } = shippedSince(runs, undefined, github);
  // Correction-aware: the run is credited to #91 (its real, owned PR) — never #80.
  const credited = shipped.find((s) => s.taskId === "W1-T54b");
  assert.ok(credited, "the corrected, owned PR must be credited");
  assert.equal(credited!.prUrl, "https://github.com/o/r/pull/91");
  assert.ok(!shipped.some((s) => s.prUrl === "https://github.com/o/r/pull/80"), "the foreign #80 must NEVER be credited");
  assert.ok(
    !discrepancies.some((d) => d.includes("W1-T54b")),
    "no rejection needed for W1-T54b once the correction is honored — #80 was never even checked",
  );
});

test("shippedSince: OWNERSHIP ASSERT rejects when no correction exists and the ledger's own claimed PR is foreign — GitHub-side trailer with a mismatched branch is rejected too", () => {
  const runs: ReturnType<typeof gatherRuns> = [
    { runId: "RFOREIGN", taskId: "T-FOREIGN", type: "implement", startTs: "2026-03-01T00:00:00.000Z", verdict: "merged", costUsd: 1, numTurns: 5, prUrl: "https://github.com/o/r/pull/999" },
    { runId: "RGATE2", taskId: "T-GATE2", type: "implement", startTs: "2026-03-01T00:00:00.000Z", verdict: "blocked_budget", costUsd: 1, numTurns: 5 },
  ];
  const github = fakeGithub({
    headRefName: (url) => (url === "https://github.com/o/r/pull/999" ? "someone-elses-branch" : undefined),
    findMergedByTrailer: (taskId) =>
      taskId === "T-GATE2" ? { number: 7, url: "https://github.com/o/r/pull/7" } : null,
    // pull/7's head branch resolves to something other than run-RGATE2 too.
  });
  const { shipped, discrepancies } = shippedSince(runs, undefined, github);
  assert.deepEqual(shipped, []);
  assert.ok(discrepancies.some((d) => d.includes("T-FOREIGN") && /reject/i.test(d)));
  assert.ok(discrepancies.some((d) => d.includes("T-GATE2") && /reject/i.test(d)));
});

test("buildGather: without a github gateway, shipped falls back to the ledger-only list (no regression, no unverified annotation)", () => {
  const g = buildGather({ ledgerNdjson: SHIP_LEDGER, learningsMd: "# L\n- a\n" });
  assert.ok(g.shipped.some((s) => s.taskId === "T-OK"));
  assert.ok(g.shipped.every((s) => s.annotation === undefined));
  assert.deepEqual(g.discrepancies, []);
});

test("buildGather: with a github gateway, shipped is the full union and renderGather names the discrepancies", () => {
  const github = fakeGithub({
    findMergedByTrailer: (taskId) =>
      taskId === "T-GATE" ? { number: 42, url: "https://github.com/o/r/pull/42" } : null,
    headRefName: (url) =>
      url === "https://github.com/o/r/pull/42" ? "run-RGATE" : url === "https://github.com/o/r/pull/10" ? "run-ROK" : undefined,
  });
  const g = buildGather({ ledgerNdjson: SHIP_LEDGER, learningsMd: "# L\n- a\n", github });
  assert.ok(g.shipped.some((s) => s.taskId === "T-GATE" && s.annotation));
  assert.ok(g.discrepancies.some((d) => d.includes("T-GATE")));
});

test("buildGather scopes runs by the marker and computes the learnings delta", () => {
  const g = buildGather({
    ledgerNdjson: LEDGER,
    learningsMd: "# L\n- a\n- b\n- c\n",
    sinceTs: "2026-01-02T00:00:00.000Z",
    learningsAtMarker: 1,
  });
  // Only runs started after the marker: B (2026-01-02 is NOT strictly after) and C.
  assert.equal(g.totalRuns, 1); // only C started strictly after 2026-01-02T00:00:00
  assert.equal(g.learningsNow, 3);
  assert.equal(g.learningsNow - g.learningsAtMarker, 2);
});
