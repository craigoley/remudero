import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregateByClass,
  aggregateByType,
  assertArchitectAboveWorker,
  buildGather,
  calibrationTable,
  classCalibrationTable,
  codeFilesInDiff,
  DEGRADED_SUCCESS_SIGNALS,
  extractStandingRules,
  gatherRuns,
  mergedSince,
  mineDegradedSuccess,
  mineOverrunClasses,
  ownBranchOf,
  parseLedger,
  planHealthSweep,
  renderDegradedSuccess,
  renderGather,
  renderOrientation,
  renderOverrunProposals,
  renderPlanHealth,
  shippedSince,
  tierOf,
  verdictDistribution,
  type DegradedSuccessSignal,
  type RunSummary,
  type ShippedGithub,
} from "../src/lib/retro.js";
import type { Task } from "../src/lib/plan.js";

// A recorded ledger fixture: two implement runs (one merged, one budget-blocked)
// and a recon run, exactly as run-task.ts writes them.
const LEDGER = [
  `{"ts":"2026-01-01T00:00:00.000Z","run_id":"A","task_id":"TA","step":"run.start","type":"implement","budget_usd":100,"task_class":"docs"}`,
  `{"ts":"2026-01-01T00:01:00.000Z","run_id":"A","task_id":"TA","step":"recon.done","num_turns":2,"cost_usd":0.2}`,
  `{"ts":"2026-01-01T00:02:00.000Z","run_id":"A","task_id":"TA","step":"implement.done","num_turns":10,"cost_usd":1.5}`,
  `{"ts":"2026-01-01T00:03:00.000Z","run_id":"A","task_id":"TA","step":"pr.opened","pr_url":"https://github.com/o/r/pull/1"}`,
  `{"ts":"2026-01-01T00:04:00.000Z","run_id":"A","task_id":"TA","step":"verdict","verdict":"merged","cost_usd":2.0,"pr_url":"https://github.com/o/r/pull/1"}`,
  `torn line that is not json {{{`,
  `{"ts":"2026-01-02T00:00:00.000Z","run_id":"B","task_id":"TB","step":"run.start","type":"implement","budget_usd":100,"task_class":"src"}`,
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

test("gatherRuns reads the W1-T167 task_class off run.start; a run that never logged it has no taskClass", () => {
  const runs = gatherRuns(parseLedger(LEDGER));
  assert.equal(runs.find((r) => r.runId === "A")!.taskClass, "docs");
  assert.equal(runs.find((r) => r.runId === "B")!.taskClass, "src");
  assert.equal(runs.find((r) => r.runId === "C")!.taskClass, undefined);
});

test("aggregateByClass (W1-T167): per-class cost/outcome so the retro can evaluate the routing table", () => {
  const agg = aggregateByClass(gatherRuns(parseLedger(LEDGER)));
  const docs = agg.find((c) => c.taskClass === "docs")!;
  assert.equal(docs.runs, 1);
  assert.equal(docs.totalCostUsd, 2.0);
  assert.equal(docs.merged, 1);
  assert.equal(docs.mergeRate, 1);
  const src = agg.find((c) => c.taskClass === "src")!;
  assert.equal(src.runs, 1);
  assert.equal(src.totalCostUsd, 5.0);
  assert.equal(src.merged, 0);
  assert.equal(src.mergeRate, 0);
  // A run that omitted task_class is grouped under "unknown" — NEVER dropped
  // (W1-T167 acceptance: "a run that omits the class/cost FAILS" — omitting it
  // from the aggregate entirely would be the same failure by a different name).
  const unknown = agg.find((c) => c.taskClass === "unknown")!;
  assert.equal(unknown.runs, 1);
  assert.equal(unknown.totalCostUsd, 0.3);
});

test("classCalibrationTable renders a markdown table with a row per class, including merge rate", () => {
  const table = classCalibrationTable(aggregateByClass(gatherRuns(parseLedger(LEDGER))));
  assert.match(table, /task_class \| runs \| merged \| merge rate/);
  assert.match(table, /\| docs \| 1 \| 1 \| 100%/);
  assert.match(table, /\| src \| 1 \| 0 \| 0%/);
});

test("buildGather includes byClass (W1-T167) alongside byType, and renderGather prints it", () => {
  const g = buildGather({ ledgerNdjson: LEDGER, learningsMd: "# L\n" });
  const docs = g.byClass.find((c) => c.taskClass === "docs")!;
  assert.equal(docs.runs, 1);
  assert.equal(docs.merged, 1);
  assert.match(renderGather(g), /Calibration \(BY TASK CLASS, W1-T167\)/);
  assert.match(renderGather(g), /\| docs \| 1 \| 1 \| 100%/);
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

// ── §5C plan-health sweep (W1-T20d) ────────────────────────────────────────

/** A minimal, otherwise-clean OPEN Task fixture (mirrors test/task-linter.test.ts's shape). */
function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: over.id,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    origin: "architect",
    acceptance: [{ claim: "does the thing", proof: "unit test test/foo.test.ts asserts the thing" }],
    ...over,
  };
}

test("planHealthSweep: an OPEN task violating a standing rule (Rule 19 sizing) is FLAGGED and a corrective task is filed", () => {
  const violating = task({
    id: "W1-T-SEED",
    files: ["src/lib/foo.ts"],
    acceptance: [
      { claim: "the daemon does X", proof: "unit test asserts X" },
      { claim: "launchctl loads the unit", proof: "unit test asserts the unit" },
    ],
  });
  const clean = task({ id: "W1-T-CLEAN" });
  const report = planHealthSweep([violating, clean]);
  assert.equal(report.flags.length, 1);
  assert.equal(report.flags[0]!.taskId, "W1-T-SEED");
  assert.ok(report.flags[0]!.violations.some((v) => v.check === "sizing"));
  assert.equal(report.correctiveTasks.length, 1);
  assert.equal(report.correctiveTasks[0]!.forTaskId, "W1-T-SEED");
  assert.equal(report.correctiveTasks[0]!.origin, "retro#plan-health");
  assert.ok(/sizing/.test(report.correctiveTasks[0]!.title));
});

test("planHealthSweep: a MERGED/DONE task is out of scope even if it would otherwise violate a rule", () => {
  const shippedButBad = task({
    id: "W1-T-OLD",
    status: "merged",
    files: ["src/lib/foo.ts"],
    acceptance: [{ claim: "the daemon does X", proof: "unit test asserts X" }],
  });
  const report = planHealthSweep([shippedButBad]);
  assert.deepEqual(report.flags, []);
  assert.deepEqual(report.correctiveTasks, []);
});

test("planHealthSweep: a WARN-only violation (budget-sanity) is never filed as a corrective task", () => {
  const t = task({ id: "W1-T-WARN" });
  const report = planHealthSweep([t], () => ({ mountMaxTurns: 10, calibration: { avgTurns: 45.2 } }));
  assert.deepEqual(report.flags, []);
  assert.deepEqual(report.correctiveTasks, []);
});

test("renderPlanHealth reports 'no violations' when the open queue is clean", () => {
  const report = planHealthSweep([task({ id: "W1-T-CLEAN" })]);
  assert.match(renderPlanHealth(report), /No violations/);
});

test("renderPlanHealth names the flagged task and its corrective task when the queue is dirty", () => {
  const violating = task({
    id: "W1-T-SEED",
    acceptance: [{ claim: "operator confirms the thing", proof: "unit test asserts the thing" }],
  });
  const report = planHealthSweep([violating]);
  const rendered = renderPlanHealth(report);
  assert.match(rendered, /W1-T-SEED/);
  assert.match(rendered, /Plan-health: fix W1-T-SEED/);
});

// ── Mining overruns for a CLASS-level fix (Standing rule 20) ───────────────

/** A minimal RunSummary fixture for overrun-mining tests. */
function run(over: Partial<RunSummary> & { runId: string; taskId: string }): RunSummary {
  return {
    type: "implement",
    startTs: "2026-01-01T00:00:00.000Z",
    verdict: "failed",
    costUsd: 5,
    numTurns: 80,
    risk: "medium",
    subtype: "error_max_turns",
    ...over,
  };
}

test("mineOverrunClasses: N max_turns verdicts across ONE class propose ONE class-level fix, not N per-task patches", () => {
  const runs = [
    run({ runId: "R1", taskId: "W1-T6" }),
    run({ runId: "R2", taskId: "W1-T9" }),
    run({ runId: "R3", taskId: "W1-T12" }),
  ];
  const proposals = mineOverrunClasses(runs);
  assert.equal(proposals.length, 1); // ONE proposal, not 3
  const p = proposals[0]!;
  assert.equal(p.taskType, "implement");
  assert.equal(p.risk, "medium");
  assert.equal(p.count, 3);
  assert.deepEqual(p.taskIds, ["W1-T12", "W1-T6", "W1-T9"]);
  assert.match(p.proposal, /class-level fix/);
});

test("mineOverrunClasses: a class below threshold (a single incident) proposes NOTHING", () => {
  const runs = [run({ runId: "R1", taskId: "W1-T-ONEOFF" })];
  assert.deepEqual(mineOverrunClasses(runs), []);
});

test("mineOverrunClasses: distinct classes each get their OWN proposal, and a merged run never counts", () => {
  const runs = [
    run({ runId: "R1", taskId: "W1-T6", type: "implement", risk: "medium" }),
    run({ runId: "R2", taskId: "W1-T9", type: "implement", risk: "medium" }),
    run({ runId: "R3", taskId: "W1-T-R1", type: "review", risk: "low", verdict: "blocked_review", subtype: undefined }),
    run({ runId: "R4", taskId: "W1-T-R2", type: "review", risk: "low", verdict: "blocked_review", subtype: undefined }),
    run({ runId: "R5", taskId: "W1-T-OK", verdict: "merged", subtype: undefined }),
  ];
  const proposals = mineOverrunClasses(runs);
  assert.equal(proposals.length, 2);
  assert.ok(proposals.some((p) => p.taskType === "implement" && p.risk === "medium"));
  assert.ok(proposals.some((p) => p.taskType === "review" && p.risk === "low"));
  assert.ok(!proposals.some((p) => p.taskIds.includes("W1-T-OK")));
});

test("renderOverrunProposals reports 'no pattern' when nothing meets threshold", () => {
  assert.match(renderOverrunProposals([]), /No class-level pattern/);
});

test("renderOverrunProposals names the proposed fix when a class overruns", () => {
  const proposals = mineOverrunClasses([
    run({ runId: "R1", taskId: "W1-T6" }),
    run({ runId: "R2", taskId: "W1-T9" }),
  ]);
  assert.match(renderOverrunProposals(proposals), /implement×medium/);
});

// ── Degraded-success mining (W1-T73) — a PASS that used a weaker path ─────

// The canonical fixture (RETRO-1784213948025/W1-T65): RD1 merged at proof_exec
// 0/2, floor_degraded (>=1 dialect-prefixed proof present, nothing OBSERVED).
// RD2 is a fully-observed sibling — N/N executed — that must emit NOTHING.
const DEGRADED_LEDGER = [
  `{"ts":"2026-03-01T00:00:00.000Z","run_id":"RD1","task_id":"W1-T200","step":"run.start","type":"implement"}`,
  `{"ts":"2026-03-01T00:01:00.000Z","run_id":"RD1","task_id":"W1-T200","step":"review.posted","state":"success","proof_exec":["not_executable","not_executable"],"floor_degraded":true}`,
  `{"ts":"2026-03-01T00:02:00.000Z","run_id":"RD1","task_id":"W1-T200","step":"verdict","verdict":"merged","cost_usd":1.0,"pr_url":"https://github.com/o/r/pull/200"}`,
  `{"ts":"2026-03-02T00:00:00.000Z","run_id":"RD2","task_id":"W1-T201","step":"run.start","type":"implement"}`,
  `{"ts":"2026-03-02T00:01:00.000Z","run_id":"RD2","task_id":"W1-T201","step":"review.posted","state":"success","proof_exec":["executed_pass","executed_pass"],"floor_degraded":false}`,
  `{"ts":"2026-03-02T00:02:00.000Z","run_id":"RD2","task_id":"W1-T201","step":"verdict","verdict":"merged","cost_usd":1.0,"pr_url":"https://github.com/o/r/pull/201"}`,
].join("\n");

test("mineDegradedSuccess: a merged run at proof_exec 0/N with a dialect-prefixed proof present (floor_degraded) emits a finding naming the run", () => {
  const records = parseLedger(DEGRADED_LEDGER);
  const findings = mineDegradedSuccess(gatherRuns(records), records);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.taskId, "W1-T200");
  assert.equal(findings[0]!.runId, "RD1");
  assert.equal(findings[0]!.signal, "zero_executed_dialect");
});

test("mineDegradedSuccess: a fully-observed merged run (N/N) emits nothing; mining the SAME fixture twice emits no duplicate", () => {
  const records = parseLedger(DEGRADED_LEDGER);
  const runs = gatherRuns(records);
  assert.ok(!mineDegradedSuccess(runs, records).some((f) => f.taskId === "W1-T201"));
  const first = mineDegradedSuccess(runs, records);
  const second = mineDegradedSuccess(runs, records);
  assert.equal(first.length, 1); // one finding, not two — a re-run is not a re-count
  assert.deepEqual(first, second);
});

test("mineDegradedSuccess: the signal set is DATA — a caller-supplied second row (reviewer_outcome=error_max_turns) flags a matching run with ZERO executor-code changes", () => {
  const ledger = [
    `{"ts":"2026-03-03T00:00:00.000Z","run_id":"RD3","task_id":"W1-T202","step":"run.start","type":"implement"}`,
    `{"ts":"2026-03-03T00:01:00.000Z","run_id":"RD3","task_id":"W1-T202","step":"review.posted","state":"success","proof_exec":["executed_pass"],"floor_degraded":false,"reviewer_outcome":"error_max_turns"}`,
    `{"ts":"2026-03-03T00:02:00.000Z","run_id":"RD3","task_id":"W1-T202","step":"verdict","verdict":"merged","cost_usd":1.0,"pr_url":"https://github.com/o/r/pull/202"}`,
  ].join("\n");
  const records = parseLedger(ledger);
  const runs = gatherRuns(records);
  // The shipped row 1 alone doesn't catch it — fully executed, no floor fallback.
  assert.deepEqual(mineDegradedSuccess(runs, records, [DEGRADED_SUCCESS_SIGNALS[0]!]), []);
  // A brand-new signal row — no new mining function, no new branch — catches it.
  const extraRow: DegradedSuccessSignal = {
    key: "reviewer_error_max_turns",
    matches: (r) => r.reviewerOutcome === "error_max_turns",
    describe: () => "reviewer_outcome=error_max_turns",
  };
  const findings = mineDegradedSuccess(runs, records, [DEGRADED_SUCCESS_SIGNALS[0]!, extraRow]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.taskId, "W1-T202");
  assert.equal(findings[0]!.signal, "reviewer_error_max_turns");
});

test("mineDegradedSuccess: a run with no review.posted line at all is silently skipped — nothing to mine", () => {
  const ledger = [
    `{"ts":"2026-03-04T00:00:00.000Z","run_id":"RD4","task_id":"W1-T203","step":"run.start","type":"implement"}`,
    `{"ts":"2026-03-04T00:01:00.000Z","run_id":"RD4","task_id":"W1-T203","step":"verdict","verdict":"merged","cost_usd":1.0,"pr_url":"https://github.com/o/r/pull/203"}`,
  ].join("\n");
  const records = parseLedger(ledger);
  assert.deepEqual(mineDegradedSuccess(gatherRuns(records), records), []);
});

test("renderDegradedSuccess reports 'no signal' when nothing was mined, and names the run + signal otherwise", () => {
  assert.match(renderDegradedSuccess([]), /No merged run posted/);
  const rendered = renderDegradedSuccess([
    { runId: "RD1", taskId: "W1-T200", signal: "zero_executed_dialect", description: "proof_exec 0/2 executed" },
  ]);
  assert.match(rendered, /W1-T200 \(RD1\)/);
  assert.match(rendered, /zero_executed_dialect/);
});

test("buildGather/renderGather surface degraded-success findings (W1-T73)", () => {
  const g = buildGather({ ledgerNdjson: DEGRADED_LEDGER, learningsMd: "# L\n" });
  assert.equal(g.degradedSuccess.length, 1);
  assert.equal(g.degradedSuccess[0]!.taskId, "W1-T200");
  assert.match(renderGather(g), /Degraded-success mining/);
  assert.match(renderGather(g), /W1-T200/);
});

// ── docs/ORIENTATION.md (W1-T39) ───────────────────────────────────────────

const STANDING_RULES_FIXTURE = `
## 11. Open decisions

Some unrelated section with a numbered list that must NOT leak into §12:
1. not a standing rule.

## 12. Standing rules

1. PROVENANCE OR IT DOESN'T GO IN A PROMPT.
2. Trust, scheduling, strikes, budgets = deterministic predicates. Never LLM decisions.
3B. **The merge gate is a GitHub-enforced CONTRACT**, wrapped onto
   a SECOND line that must fold back into rule 3B, never becoming its own bullet.
20. A LAST NUMBERED RULE.

- Lives at repo root. Header carries sync date + focus, his-house style.
- A second trailing bullet that is NOT a Standing rule.

## 12A. Documentation as a gated artifact, in tiers

Unrelated section content that must never appear in the extracted list.
`;

test("extractStandingRules: pulls ONLY the numbered rules from §12, folding wrapped continuation lines back in", () => {
  const rules = extractStandingRules(STANDING_RULES_FIXTURE);
  assert.deepEqual(rules, [
    "1. PROVENANCE OR IT DOESN'T GO IN A PROMPT.",
    "2. Trust, scheduling, strikes, budgets = deterministic predicates. Never LLM decisions.",
    "3B. The merge gate is a GitHub-enforced CONTRACT, wrapped onto a SECOND line that must fold back into rule 3B, never becoming its own bullet.",
    "20. A LAST NUMBERED RULE.",
  ]);
});

test("extractStandingRules: never leaks a numbered list from a DIFFERENT section, and stops at the trailing bullets after the numbered list", () => {
  const rules = extractStandingRules(STANDING_RULES_FIXTURE);
  assert.ok(!rules.some((r) => r.includes("not a standing rule")));
  assert.ok(!rules.some((r) => r.includes("Lives at repo root")));
  assert.ok(!rules.some((r) => r.includes("gated artifact")));
});

test("extractStandingRules: a missing §12 heading fails SOFT (empty list), never throws", () => {
  assert.deepEqual(extractStandingRules("# Some doc\n\nNo standing rules here.\n"), []);
});

function fixtureTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "W1-TX",
    title: "Example next task",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    ...overrides,
  };
}

test("renderOrientation: names the next runnable task, the shipped-since-marker list, and the invariants", () => {
  const gather = buildGather({ ledgerNdjson: SHIP_LEDGER, learningsMd: "# L\n- a\n" });
  const md = renderOrientation({
    generatedAt: "2026-07-18T00:00:00.000Z",
    gather,
    nextTask: fixtureTask({ id: "W1-T7", title: "Transient-vs-strike classifier", depends_on: ["W1-T3"] }),
    standingRules: ["1. RULE ONE.", "2. RULE TWO."],
  });
  assert.match(md, /# ORIENTATION/);
  assert.match(md, /MAINTAINED BY `rmd retro`/);
  assert.match(md, /## Next runnable task/);
  assert.match(md, /\*\*W1-T7\*\* — Transient-vs-strike classifier/);
  assert.match(md, /depends_on: W1-T3/);
  assert.match(md, /## Never-do invariants/);
  assert.match(md, /1\. RULE ONE\./);
  assert.match(md, /2\. RULE TWO\./);
});

test("renderOrientation: no runnable task renders an explicit '(none runnable)' state, never a blank/undefined section", () => {
  const gather = buildGather({ ledgerNdjson: "", learningsMd: "# L\n" });
  const md = renderOrientation({ generatedAt: "2026-07-18T00:00:00.000Z", gather, standingRules: [] });
  assert.match(md, /none runnable right now/);
  assert.doesNotMatch(md, /undefined/);
});

// The saveMarker/loadMarker atomicity + corrupt-vs-absent-marker coverage for W1-T242
// lives in test/retro-marker-atomic.test.ts, mirroring test/ledger-atomic.test.ts and
// test/status-atomic-write.test.ts's precedent of one dedicated file per atomic-write
// surface (not folded into this module's general render/gather tests).
