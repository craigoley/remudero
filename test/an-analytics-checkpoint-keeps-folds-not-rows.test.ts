/**
 * The analytics checkpoint kept three row lists without bound — every row work integrity, judge
 * calibration and the operator-agent signals had ever read: ~254 MB of a 259 MB checkpoint measured
 * on this Mac, copied on every resume. Each consumer needs far less. The operator-agent signals are
 * counts plus their first 100 details; work integrity and judge calibration are joins over every
 * run, which their fold keeps per assignment, head and run rather than per row. The outputs must
 * be byte-identical to the row-list reading, from scratch and across a resume; the GOLDEN digests
 * below were taken from that reading (origin/main 9b5c67437) over this same deterministic corpus.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as analytics from "../src/lib/analytics-route.js";
import * as judge from "../src/lib/judge-calibration.js";
import * as workIntegrity from "../src/lib/work-integrity.js";
import { fixedClock } from "../src/lib/clock.js";

type Row = Record<string, unknown>;

const clock = fixedClock(Date.parse("2026-10-06T21:00:00.000Z"));
const MODELS = ["opus", "sonnet", "gpt-6", "gpt-oss-120b"];
const CLASSES = ["feature", "bugfix", "chore", undefined];
const CAPACITY_FIELDS = ["repo", "repository", "configured_capacity", "configured_pool_size", "worker_pool_size", "wip_limit", "admitted_lanes",
  "lane_budget", "active_workers", "queued_work", "queue_pending", "window_start", "measurement_start", "window_end", "measurement_end"];
const HEAD_ASSIGNMENT = ["self", "self", "self", "unattributed", "unreadable", undefined];

/** A seeded corpus touching every branch the three consumers read; `runs` scales it. */
function corpus(runs: number, seed = 7): Row[] {
  let state = seed;
  const rand = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(values: readonly T[]): T => values[Math.floor(rand() * values.length)]!;
  const rows: Row[] = [];
  let clockMs = Date.parse("2026-09-01T00:00:00.000Z");
  const ts = (): string => {
    clockMs += 1000 + Math.floor(rand() * 60_000);
    // A few rows land out of order, and a few carry no usable time.
    if (rand() < 0.01) return "not-a-time";
    return new Date(clockMs - (rand() < 0.05 ? 3_600_000 : 0)).toISOString();
  };
  for (let run = 0; run < runs; run += 1) {
    const runId = `run-${run}`;
    const taskId = `W1-T${1000 + (run % 900)}`;
    const taskClass = pick(CLASSES);
    rows.push({ ts: ts(), step: "run.start", run_id: runId, task_id: taskId, ...(taskClass ? { task_class: taskClass } : {}), lane: "claude" });
    const assignments = 1 + Math.floor(rand() * 2);
    let head = "";
    for (let a = 0; a < assignments; a += 1) {
      const id = `asg-${run}-${a}`;
      rows.push({ ts: ts(), step: "worker.assignment", run_id: runId, task_id: taskId,
        worker_assignment: { version: 1, id, selected: { provider: "claude", model: pick(MODELS) }, requested: { model: "x" } } });
      for (let attempt = Math.floor(rand() * 4); attempt > 0; attempt -= 1) {
        rows.push({ ts: ts(), step: "worker.attempt", run_id: runId, selection_assignment_id: id, outcome: "ok", tokens: { total: 10 } });
      }
      if (rand() < 0.08) rows.push({ ts: ts(), step: "worker.runaway_turns", run_id: rand() < 0.9 ? runId : undefined });
      if (rand() < 0.06) rows.push({ ts: ts(), step: "implement.harness_commit_refused", run_id: runId });
      head = `h${run}${a}${Math.floor(rand() * 3)}`;
      const authored = pick(HEAD_ASSIGNMENT);
      const headAssignment = authored === "self" ? id : authored;
      rows.push({ ts: ts(), step: a === 0 ? "implement.done" : "fix.done", run_id: runId, selection_assignment_id: id, head_sha: head,
        ...(headAssignment ? { head_assignment: headAssignment } : {}) });
      if (rand() < 0.07) rows.push({ ts: ts(), step: "scope_guard.overrun", run_id: rand() < 0.9 ? runId : undefined, out_of_scope: ["x"] });
      if (rand() < 0.04) rows.push({ ts: ts(), step: "fix.commit_refused", run_id: runId });
    }
    rows.push({ ts: ts(), step: "pr.opened", run_id: runId, head_sha: head, pr_url: `https://example.test/pr/${run}`,
      ...(rand() < 0.8 ? { head_assignment: `asg-${run}-0` } : {}) });
    for (let review = Math.floor(rand() * 3); review >= 0; review -= 1) {
      const proof = rand();
      rows.push({
        ts: ts(), step: "review.posted", run_id: `review-${run}`, task_id: rand() < 0.95 ? taskId : undefined,
        ...(rand() < 0.97 ? { head_sha: rand() < 0.9 ? head : `h-unknown-${run}` } : {}),
        pr_url: `https://example.test/pr/${run}`,
        state: pick(["success", "failure", "failure", "pending"]),
        reviewer_outcome: rand() < 0.9 ? "success" : "timeout",
        ...(rand() < 0.05 ? { dep_review: true } : {}),
        ...(rand() < 0.95 ? { evaluator_provenance: { servedModel: pick(MODELS), routedModel: "r", requestedModel: "q" } } : {}),
        ...(proof < 0.05 ? {} : { proof_exec: proof < 0.1 ? [] : proof < 0.13 ? ["mystery"] :
          Array.from({ length: 1 + Math.floor(rand() * 4) }, () => pick(["executed_pass", "executed_fail", "not_executable", "exec_error", "executed_stale"])) }),
        decision_verdict: { changesetContradictions: rand() < 0.1 ? [{ claim: "x" }] : [], refusalContradictions: [],
          testTheater: rand() < 0.1, rewardHackingGap: Math.floor(rand() * 4) / 4, summary: "s".repeat(80) },
        ...(rand() < 0.5 ? { test_theater: rand() < 0.1, reward_hacking_gap: Math.floor(rand() * 4) / 4 } : {}),
      });
    }
    if (rand() < 0.6) {
      rows.push({ ts: ts(), step: "risk_judge.decision", run_id: `review-${run}`, verdict: pick(["low", "high", "low", "unsure"]),
        model: rand() < 0.95 ? pick(MODELS) : undefined, availability: rand() < 0.05 ? "unavailable" : "available" });
    }
    rows.push({ ts: ts(), step: "verdict", run_id: runId, selection_assignment_id: `asg-${run}-0`, verdict: pick(["merged", "failed"]) });
    if (rand() < 0.5) {
      rows.push({ ts: ts(), step: pick(["automerge.armed", "automerge.clean_status_direct_merge", "automerge.direct_merge_failed"]),
        run_id: runId, task_id: rand() < 0.9 ? taskId : undefined, ...(taskClass ? { task_class: taskClass } : {}) });
    }
    if (rand() < 0.3) {
      rows.push({ ts: ts(), step: pick(["panel.manual_approved", "panel.proposal_accepted", "panel.proposal_rejected", "automerge.hold_engaged",
        "automerge.hold_released", "panel.proposal_declined"]), run_id: runId, task_id: rand() < 0.95 ? taskId : undefined,
      ...(rand() < 0.9 ? { task_class: pick(["feature", "bugfix", "chore"]) } : {}), ...(rand() < 0.9 ? { actor: pick(["craig", "agent"]) } : {}) });
    }
    if (rand() < 0.4) {
      const start = new Date(clockMs).toISOString();
      rows.push({ ts: ts(), step: "daemon.capacity", repo: rand() < 0.95 ? "craigoley/remudero" : undefined,
        configured_capacity: rand() < 0.95 ? 4 : 0, admitted_lanes: Math.floor(rand() * 5), active_workers: Math.floor(rand() * 5),
        queued_work: Math.floor(rand() * 3), window_start: start, window_end: rand() < 0.95 ? new Date(clockMs + 60_000).toISOString() : start });
    }
  }
  return rows;
}

const ndjson = (rows: readonly Row[]): string => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

/** Every output the three consumers feed, as one canonical string. */
function derived(snapshot: analytics.AnalyticsSnapshot): string {
  const hidden = snapshot as unknown as { workIntegrity: unknown; judgeCalibration: unknown };
  return JSON.stringify({
    workIntegrity: hidden.workIntegrity,
    judgeCalibration: hidden.judgeCalibration,
    operatorAgent: snapshot.consoleV1.operatorAgent,
  });
}

const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

async function fold(rows: readonly Row[], split?: number): Promise<{ scratch: string; resumed?: string; state: string }> {
  const dir = mkdtempSync(join(tmpdir(), "rmd-analytics-folds-"));
  try {
    const labels = judge.drawJudgeSample(judge.extractJudgeVerdicts(rows).verdicts, { perStratum: 6 })
      .map((item, index) => ({ verdictRef: item.verdictRef, label: index % 3 === 0 ? "fail" as const : "pass" as const,
        labeller: "craig", labelledAt: "2026-10-01T00:00:00.000Z" }));
    const options = { judgeLabels: { labels } };
    const live = join(dir, "ledger.ndjson");
    appendFileSync(live, ndjson(split === undefined ? rows : rows.slice(0, split)));
    const first = await analytics.deriveAnalyticsSnapshotFromCheckpointedLedger(dir, clock, undefined, undefined, options);
    if (split === undefined) return { scratch: derived(first.snapshot), state: JSON.stringify(first.checkpoint.state) };
    const prior = JSON.parse(JSON.stringify(first.checkpoint)) as analytics.AnalyticsCheckpoint;
    appendFileSync(live, ndjson(rows.slice(split)));
    const resumed = await analytics.deriveAnalyticsSnapshotFromCheckpointedLedger(dir, clock, undefined, prior, options);
    assert.equal(resumed.scan?.mode, "resume", `positive control: the second fold resumed (refused: ${resumed.scan?.reason})`);
    const scratch = await analytics.deriveAnalyticsSnapshotFromCheckpointedLedger(dir, clock, undefined, undefined, options);
    return { scratch: derived(scratch.snapshot), resumed: derived(resumed.snapshot), state: JSON.stringify(resumed.checkpoint.state) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const GOLDEN = "e89b83ee40b47592cf027eb6bcb7e9ae5311fac8816e2196e975890ae3ff8439";

test("unit test: work integrity, judge calibration and the operator-agent signals read byte-identically from the checkpoint's folds", async () => {
  const rows = corpus(600);
  const result = await fold(rows, 1700);
  const parsed = JSON.parse(result.scratch) as { workIntegrity: { cells: unknown[] }; judgeCalibration: { judges: unknown[]; sample: unknown[] };
    operatorAgent: { proof: { unmeasurableCount: number }; decisions: { classes: unknown[]; automaticMergeEventCount: number };
      capacity: { measurementCount: number; unavailableCount: number } } };
  // Positive controls: the corpus reaches every consumer, past every first-100 detail cap.
  assert.ok(parsed.workIntegrity.cells.length >= 8, "work integrity has cells");
  assert.ok(parsed.judgeCalibration.judges.length >= 4 && parsed.judgeCalibration.sample.length > 0, "judges and a labelled sample");
  assert.ok(parsed.operatorAgent.proof.unmeasurableCount > 100, "proof details overflow their cap");
  assert.ok(parsed.operatorAgent.decisions.automaticMergeEventCount > 100 && parsed.operatorAgent.decisions.classes.length === 3, "decisions");
  assert.ok(parsed.operatorAgent.capacity.measurementCount > 100, "capacity measurements overflow their cap");
  assert.equal(result.resumed, result.scratch, "a resume reads what a scratch fold reads");
  assert.equal(digest(result.scratch), GOLDEN, "byte-identical to the row-list reading");
});

test("unit test: the analytics checkpoint state does not grow with rows that only repeat what its folds already hold", async () => {
  const rows = corpus(300);
  // Rows a row list keeps one by one but no fold needs again: more attempts by known assignments,
  // and capacity and decision rows past their first-100 details.
  const repeats = (count: number): Row[] => Array.from({ length: count }, (_, i) => [
    { ts: "2026-09-01T12:00:00.000Z", step: "worker.attempt", run_id: `run-${i % 300}`, selection_assignment_id: `asg-${i % 300}-0` },
    { ts: "2026-09-01T12:00:00.000Z", step: "daemon.capacity", repo: "craigoley/remudero", configured_capacity: 4, admitted_lanes: 2,
      active_workers: 1, queued_work: 0, window_start: "2026-09-01T12:00:00.000Z", window_end: "2026-09-01T12:01:00.000Z" },
    { ts: "2026-09-01T12:00:00.000Z", step: "automerge.armed", run_id: `run-${i % 300}`, task_id: "W1-T1000", task_class: "feature" },
  ]).flat();
  const once = await fold([...rows, ...repeats(4000)]);
  const twice = await fold([...rows, ...repeats(8000)]);
  const growth = twice.state.length - once.state.length;
  assert.ok(once.state.length > 0, "positive control: the state was measured");
  assert.ok(growth < 1024, `12000 more repeating rows grew the checkpoint state by ${growth} bytes`);
});

test("unit test: an analytics checkpoint written with row lists resumes onto the folds and reads the same", async () => {
  const rows = corpus(600);
  const dir = mkdtempSync(join(tmpdir(), "rmd-analytics-legacy-rows-"));
  try {
    const live = join(dir, "ledger.ndjson");
    const head = rows.slice(0, 1700);
    appendFileSync(live, ndjson(head));
    const options = { judgeLabels: { labels: [] } };
    const first = await analytics.deriveAnalyticsSnapshotFromCheckpointedLedger(dir, clock, undefined, undefined, options);
    // The state a checkpoint carried before the folds: each consumer's selected rows, one by one.
    const legacy = JSON.parse(JSON.stringify(first.checkpoint)) as analytics.AnalyticsCheckpoint;
    const state = legacy.state as unknown as Record<string, unknown> & { operatorAgentRows: Record<string, unknown> };
    delete state.workIntegrityFold;
    delete state.judgeCalibrationFold;
    delete state.operatorAgentFolds;
    state.workIntegrityRows = head.map(workIntegrity.workIntegrityRow).filter(Boolean);
    state.judgeCalibrationRows = head.map(judge.judgeCalibrationRow).filter(Boolean);
    const pick = (row: Row, fields: readonly string[]): Row => Object.fromEntries(fields.map((field) => [field, row[field]]));
    state.operatorAgentRows.proof = head.filter((row) => row.step === "review.posted").map((row) => pick(row, ["step", "task_id", "proof_exec"]));
    state.operatorAgentRows.decisions = head.filter((row) => /^(panel|automerge)\./.test(String(row.step)))
      .map((row) => pick(row, ["step", "task_id", "task_class", "task_type", "class", "origin", "actor", "by"]));
    state.operatorAgentRows.capacity = head.filter((row) => row.step === "daemon.capacity").map((row) => pick(row, CAPACITY_FIELDS));
    appendFileSync(live, ndjson(rows.slice(1700)));
    const resumed = await analytics.deriveAnalyticsSnapshotFromCheckpointedLedger(dir, clock, undefined, legacy, options);
    assert.equal(resumed.scan?.mode, "resume", `positive control: the row-list checkpoint resumed (refused: ${resumed.scan?.reason})`);
    const scratch = await analytics.deriveAnalyticsSnapshotFromCheckpointedLedger(dir, clock, undefined, undefined, options);
    assert.equal(derived(resumed.snapshot), derived(scratch.snapshot));
    assert.ok(resumed.checkpoint.state.workIntegrityRows === undefined, "and it is written back as folds");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
