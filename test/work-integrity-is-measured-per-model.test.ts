/**
 * W1-T4621 — contradicted claims, holdout reward-hacking gaps, scope overruns, empty commits,
 * runaway turns and test theater are recorded per run but were never attributed to a model. The
 * work-integrity projection joins each signal to the assignment that authored the work and rolls it
 * up per model x task class, every rate carrying its denominator, coverage and unavailable count.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildAnalyticsRoute,
  deriveAnalyticsSnapshot,
  deriveAnalyticsSnapshotFromCheckpointedLedger,
} from "../src/lib/analytics-route.js";
import { fixedClock } from "../src/lib/clock.js";
import {
  deriveWorkIntegrity,
  unavailableWorkIntegrity,
  WORK_INTEGRITY_SIGNALS,
  WORK_INTEGRITY_VERSION,
  type WorkIntegrity,
  type WorkIntegrityCell,
} from "../src/lib/work-integrity.js";

const NOW = "2026-09-27T12:00:00.000Z";
const at = (second: number): string => `2026-09-27T10:00:${String(second).padStart(2, "0")}.000Z`;

type Row = Record<string, unknown>;

function assignment(second: number, runId: string, id: string, model: string): Row {
  return {
    ts: at(second), step: "worker.assignment", run_id: runId, task_id: "W1-T1", lane: "run-task",
    worker_assignment: {
      version: 1, id, phase: "pre-execution",
      requested: { model: "sonnet", effort: "high", maxTurns: 400 },
      selected: { provider: "claude", model, effort: "high" },
      routing: { mode: "claude-only" }, candidates: [],
    },
  };
}

function review(second: number, head: string | undefined, verdict: Row, extra: Row = {}): Row {
  return {
    ts: at(second), step: "review.posted", run_id: "REVIEW", task_id: "W1-T1",
    ...(head === undefined ? {} : { head_sha: head }),
    decision_verdict: { state: "success", criteria: [], summary: "s", ...verdict },
    ...extra,
  };
}

function ledgerRows(): Row[] {
  return [
    { ts: at(0), step: "run.start", run_id: "R1", task_id: "W1-T1", type: "implement", task_class: "feature" },
    { ts: at(0), step: "run.start", run_id: "R2", task_id: "W1-T2", type: "implement", task_class: "feature" },
    { ts: at(0), step: "run.start", run_id: "R3", task_id: "W1-T3", type: "implement", task_class: "bugfix" },
    { ts: at(0), step: "run.start", run_id: "R4", task_id: "W1-T4", type: "implement", task_class: "feature" },

    // R1: one implementer (A1) that ran away, overran scope and made a contradicted claim.
    assignment(1, "R1", "A1", "model-x"),
    { ts: at(2), step: "worker.runaway_turns", run_id: "R1", task_id: "W1-T1", turns_so_far: 401, bound_turns: 400 },
    { ts: at(3), step: "implement.done", run_id: "R1", selection_assignment_id: "A1", model: "model-x", head_sha: "H1", head_assignment: "A1" },
    { ts: at(4), step: "scope_guard.overrun", run_id: "R1", out_of_scope: ["src/x.ts"], declared_files: [] },
    { ts: at(5), step: "pr.opened", run_id: "R1", pr_url: "u1", head_sha: "H1", head_assignment: "A1" },
    review(6, "H1", { changesetContradictions: [{ claim: "2 files" }], refusalContradictions: [], testTheater: false, rewardHackingGap: 0.5 },
      { test_theater: false, reward_hacking_gap: 0.5 }),
    { ts: at(7), step: "verdict", run_id: "R1", selection_assignment_id: "A1", success: true, verdict: "merged" },

    // R2: an implementer (A2) whose empty commit was refused, then a fix worker (A3) whose was too.
    assignment(10, "R2", "A2", "model-x"),
    { ts: at(11), step: "implement.harness_commit_refused", run_id: "R2", reason: "worker changed nothing" },
    { ts: at(12), step: "implement.done", run_id: "R2", selection_assignment_id: "A2", head_sha: "H2", head_assignment: "A2" },
    review(13, "H2", { changesetContradictions: [], refusalContradictions: [], testTheater: false, rewardHackingGap: 0 },
      { test_theater: false, reward_hacking_gap: 0 }),
    assignment(14, "R2", "A3", "model-y"),
    { ts: at(15), step: "fix.commit_refused", run_id: "R2", strike: 1, round: "r1", reason: "worker changed nothing" },
    { ts: at(16), step: "fix.done", run_id: "R2", selection_assignment_id: "A3" },
    // The later review of the same head supersedes the earlier one: one head, one judgement.
    review(17, "H2", { changesetContradictions: [], refusalContradictions: [{ criterion: "c" }], testTheater: true, rewardHackingGap: null },
      { test_theater: true, reward_hacking_gap: null }),

    // R3: a head whose trailer could not be read; the overrun falls back to the implementer's own id.
    assignment(20, "R3", "A4", "model-x"),
    { ts: at(21), step: "implement.done", run_id: "R3", selection_assignment_id: "A4", head_sha: "H4", head_assignment: "unreadable" },
    review(22, "H4", { changesetContradictions: [] }, { test_theater: false, reward_hacking_gap: 0 }),
    { ts: at(23), step: "worker.attempt", run_id: "R3", selection_assignment_id: "A4", success: false },
    { ts: at(24), step: "scope_guard.overrun", run_id: "R3", out_of_scope: ["src/y.ts"], declared_files: [] },

    // R4: an assignment that never reported, and a refusal logged before any worker was assigned.
    { ts: at(29), step: "implement.harness_commit_refused", run_id: "R4", reason: "worker changed nothing" },
    assignment(30, "R4", "A5", "model-y"),

    // R5: no run.start (unclassified); its review withheld every measurement.
    { ts: at(39), step: "scope_guard.overrun", run_id: "R5", out_of_scope: ["src/z.ts"], declared_files: [] },
    assignment(40, "R5", "A6", "model-x"),
    { ts: at(41), step: "implement.done", run_id: "R5", selection_assignment_id: "A6", head_sha: "H6", head_assignment: "A6" },
    review(42, "H6", {}),

    // Rows that cannot be joined to any assignment — each is counted, never dropped.
    { ts: at(50), step: "worker.runaway_turns", task_id: "W1-T9", turns_so_far: 9, bound_turns: 8 },
    { ts: at(51), step: "worker.runaway_turns", run_id: "R-none", turns_so_far: 9, bound_turns: 8 },
    { ts: "not-a-time", step: "fix.commit_refused", run_id: "R1", reason: "worker changed nothing" },
    review(52, undefined, { changesetContradictions: [] }),
    review(53, "H9", { changesetContradictions: [] }),
    { ts: at(54), step: "implement.done", run_id: "R7", selection_assignment_id: "A-ghost", head_sha: "H7", head_assignment: "A-ghost" },
    review(55, "H7", { changesetContradictions: [] }),
    { ts: at(56), step: "pr.opened", run_id: "R8", pr_url: "u8", head_sha: "H8" },
    review(57, "H8", { changesetContradictions: [] }),
    { ts: at(58), step: "scope_guard.overrun", run_id: "R7", out_of_scope: ["a"], declared_files: [] },
    { ts: at(59), step: "implement.done", run_id: "R9", head_sha: "H10", head_assignment: "unattributed" },
    review(59, "H10", { changesetContradictions: [] }),
    { ts: "2026-09-27T10:01:00.000Z", step: "scope_guard.overrun", run_id: "R9", out_of_scope: ["b"], declared_files: [] },
  ];
}

function cell(integrity: WorkIntegrity, model: string, taskClass: string): WorkIntegrityCell {
  const found = integrity.cells.find((c) => c.model === model && c.taskClass === taskClass);
  assert.ok(found, `cell ${model} x ${taskClass}`);
  return found;
}

const rate = (numerator: number, denominator: number, unavailable: number) => ({
  numerator,
  denominator,
  rate: denominator === 0 ? null : numerator / denominator,
  unavailable,
  coverage: denominator + unavailable === 0 ? null : denominator / (denominator + unavailable),
});

test("each behaviour signal is joined to its authoring assignment and rolled up per model and task class", () => {
  const integrity = deriveWorkIntegrity(ledgerRows(), { asOf: NOW });
  assert.equal(integrity.version, WORK_INTEGRITY_VERSION);
  assert.equal(integrity.version, "work-integrity-v1");
  assert.equal(integrity.state, "observed");
  assert.equal(integrity.evidence, "observational");
  assert.equal(integrity.asOf, NOW);
  assert.deepEqual(
    integrity.cells.map((c) => [c.model, c.taskClass, c.assignments]),
    [["model-x", "bugfix", 1], ["model-x", "feature", 2], ["model-x", "unclassified", 1], ["model-y", "feature", 2]],
  );

  const xFeature = cell(integrity, "model-x", "feature");
  assert.deepEqual(xFeature.signals.runawayTurns, rate(1, 2, 0), "A1 ran away; A2 completed without doing so");
  assert.deepEqual(xFeature.signals.emptyCommitRefusals, rate(1, 2, 0), "A2's harness commit was refused");
  assert.deepEqual(xFeature.signals.scopeOverruns, rate(1, 2, 0), "the overrun joins to R1's implementer");
  assert.deepEqual(xFeature.signals.contradictedClaims, rate(2, 2, 0), "a changeset and a refusal contradiction both count");
  assert.deepEqual(xFeature.signals.testTheater, rate(1, 2, 0), "only H2's LATEST review found theater");
  assert.deepEqual(xFeature.signals.rewardHackingGap, rate(1, 1, 1), "H2's gap was not measurable: unavailable, not zero");
  assert.equal(xFeature.meanRewardHackingGap, 0.5);

  const xBugfix = cell(integrity, "model-x", "bugfix");
  assert.deepEqual(xBugfix.signals.scopeOverruns, rate(1, 1, 0), "an unreadable head trailer falls back to the implementer's own id");
  assert.deepEqual(xBugfix.signals.runawayTurns, rate(0, 1, 0), "an observed zero is a real zero with its denominator");
  assert.deepEqual(xBugfix.signals.contradictedClaims, rate(0, 0, 0), "no review joined: rate and coverage are null, never 0");
  assert.equal(xBugfix.meanRewardHackingGap, null);

  const xUnclassified = cell(integrity, "model-x", "unclassified");
  for (const signal of ["contradictedClaims", "rewardHackingGap", "testTheater"] as const) {
    assert.deepEqual(xUnclassified.signals[signal], rate(0, 0, 1), `${signal}: the withheld measurement is unavailable`);
  }
  assert.deepEqual(xUnclassified.signals.scopeOverruns, rate(0, 1, 0));

  const yFeature = cell(integrity, "model-y", "feature");
  assert.deepEqual(yFeature.signals.emptyCommitRefusals, rate(1, 1, 1), "A3's fix commit was refused; A5 never reported");
  assert.deepEqual(yFeature.signals.runawayTurns, rate(0, 1, 1));
  assert.deepEqual(yFeature.signals.scopeOverruns, rate(0, 0, 1), "a fix worker is not an implementer; A5 never reported");

  assert.deepEqual(Object.keys(integrity.cells[0]!.signals).sort(), [...WORK_INTEGRITY_SIGNALS].sort());
  assert.equal(JSON.stringify(integrity).includes("W1-T"), false, "no task id reaches the projection");
  assert.equal(JSON.stringify(integrity).includes("\"R1\""), false, "no run id reaches the projection");
});

test("a signal that cannot be joined to an assignment is reported as unavailable with its reason", () => {
  const { unattributed } = deriveWorkIntegrity(ledgerRows(), { asOf: NOW });
  assert.deepEqual(unattributed.runawayTurns, { count: 2, reasons: { "no-run-id": 1, "no-assignment-in-run": 1 } });
  assert.deepEqual(unattributed.emptyCommitRefusals, { count: 2, reasons: { "no-assignment-in-run": 1, untimed: 1 } });
  assert.deepEqual(unattributed.scopeOverruns, {
    count: 3,
    reasons: { "no-implement-in-run": 1, "assignment-not-observed": 1, "implement-unattributed": 1 },
  });
  const reviewReasons = {
    "head-unreadable": 1,
    "review-without-head": 1,
    "head-not-observed": 1,
    "assignment-not-observed": 1,
    "head-assignment-unrecorded": 1,
    "head-unattributed": 1,
  };
  for (const signal of ["contradictedClaims", "rewardHackingGap", "testTheater"] as const) {
    assert.deepEqual(unattributed[signal], { count: 6, reasons: reviewReasons }, signal);
  }
});

test("with no assignment observed the projection is unavailable, never a table of zeros", () => {
  const empty = deriveWorkIntegrity([{ ts: at(1), step: "worker.runaway_turns", run_id: "R1" }], { asOf: NOW });
  assert.equal(empty.state, "unavailable");
  assert.equal(empty.reason, "no-assignments-observed");
  assert.deepEqual(empty.cells, []);
  assert.deepEqual(empty.unattributed.runawayTurns, { count: 1, reasons: { "no-assignment-in-run": 1 } });

  const pending = unavailableWorkIntegrity("work-integrity-refresh-pending");
  assert.equal(pending.state, "unavailable");
  assert.equal(pending.asOf, null);
  assert.equal(pending.unattributed.testTheater.count, 0);
});

function fakeResponse() {
  let body = "";
  let status = 0;
  const res = {
    statusCode: 0,
    setHeader() {},
    writeHead(code: number) { status = code; return this; },
    end(chunk?: string) { body = chunk ?? ""; },
  } as unknown as ServerResponse;
  return { res, body: () => body, status: () => status || (res as unknown as { statusCode: number }).statusCode };
}

test("the analytics route serves work integrity as a private, versioned projection", async () => {
  const rows = ledgerRows();
  const base = deriveAnalyticsSnapshot(rows, NOW);
  const route = buildAnalyticsRoute({ currentSnapshot: () => base });

  const versioned = fakeResponse();
  await route.handler({ url: `/v1/analytics?projectionVersion=${WORK_INTEGRITY_VERSION}` } as never, versioned.res, { params: {} });
  assert.equal(versioned.status(), 200);
  assert.deepEqual(JSON.parse(versioned.body()), deriveWorkIntegrity(rows, { asOf: NOW }), "the route folds the same rows the module derives from");

  const full = fakeResponse();
  await route.handler({ url: "/v1/analytics" } as never, full.res, { params: {} });
  assert.equal("workIntegrity" in (JSON.parse(full.body()) as Record<string, unknown>), false, "private by default: never in the unversioned body");

  const cold = buildAnalyticsRoute({ currentSnapshot: () => ({ ...base, workIntegrity: undefined }) });
  const pending = fakeResponse();
  await cold.handler({ url: `/v1/analytics?projectionVersion=${WORK_INTEGRITY_VERSION}` } as never, pending.res, { params: {} });
  const unavailable = JSON.parse(pending.body()) as WorkIntegrity;
  assert.equal(unavailable.state, "unavailable");
  assert.equal(unavailable.reason, "work-integrity-refresh-pending");
});

test("a checkpoint resume carries the retained work-integrity rows forward", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-work-integrity-"));
  const live = join(dir, "ledger.ndjson");
  const rows = ledgerRows();
  const cut = rows.findIndex((row) => row.step === "worker.assignment" && row.run_id === "R2");
  try {
    writeFileSync(live, `${rows.slice(0, cut).map((row) => JSON.stringify(row)).join("\n")}\n`);
    const first = await deriveAnalyticsSnapshotFromCheckpointedLedger(dir, fixedClock(Date.parse(NOW)));
    appendFileSync(live, `${rows.slice(cut).map((row) => JSON.stringify(row)).join("\n")}\n`);
    const resumed = await deriveAnalyticsSnapshotFromCheckpointedLedger(dir, fixedClock(Date.parse(NOW)), undefined, first.checkpoint);
    const full = await deriveAnalyticsSnapshotFromCheckpointedLedger(dir, fixedClock(Date.parse(NOW)));
    assert.equal(resumed.snapshot.workIntegrity?.state, "observed");
    assert.deepEqual(resumed.snapshot.workIntegrity, full.snapshot.workIntegrity);
    assert.deepEqual(full.snapshot.workIntegrity, deriveWorkIntegrity(rows, { asOf: NOW }));

    const legacy = structuredClone(first.checkpoint);
    delete (legacy.state as { workIntegrityRows?: unknown }).workIntegrityRows;
    const rescanned = await deriveAnalyticsSnapshotFromCheckpointedLedger(dir, fixedClock(Date.parse(NOW)), undefined, legacy);
    assert.deepEqual(rescanned.snapshot.workIntegrity, full.snapshot.workIntegrity, "a checkpoint without retained rows forces a full scan");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
