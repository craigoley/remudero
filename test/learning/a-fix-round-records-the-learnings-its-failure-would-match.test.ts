import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runFixRung } from "#test/helpers/run-task-test.js";
import type { Config } from "#src/lib/config.js";
import {
  fixLearningsArm,
  recordFixLearningsOutcome,
  recordFixLearningsShadow,
  summarizeFixLearningsShadow,
} from "#src/lib/fix-learnings-shadow.js";
import type { CriterionVerdict } from "#src/lib/review.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { WorkerResult } from "#src/lib/worker.js";

// W1-T14138: a fix round records which learnings its failure text would match, under a task-keyed arm,
// and injects nothing in either arm.

const OFFERED_TASK = "W1-T9001";
const WITHHELD_TASK = "W1-T9003";

type Row = Record<string, unknown> & { step: string };

const SYMBOL_LEARNING = [
  "- id: frobnicate-contract",
  "  subsystem: ci",
  "  lifecycle: active",
  "  files: [src/never-touched.ts]",
  "  symbols: [frobnicateWidget]",
  "  fact: frobnicateWidget must be called before the gate runs.",
  "  src: PR#1",
].join("\n");
const ERROR_LEARNING = [
  "- id: refused-by-gate",
  "  subsystem: ci",
  "  lifecycle: active",
  "  files: [src/never-touched.ts]",
  "  error_signatures: [refused by the widget gate]",
  "  fact: A push refused by the widget gate needs the widget regenerated first.",
  "  src: PR#2",
].join("\n");
const FILE_ONLY_LEARNING = [
  "- id: foo-file-only",
  "  subsystem: ci",
  "  lifecycle: active",
  "  files: [src/lib/foo.ts]",
  "  fact: src/lib/foo.ts has a generic habit worth knowing.",
  "  src: PR#3",
].join("\n");
const UNRELATED_LEARNING = [
  "- id: unrelated-fact",
  "  subsystem: ci",
  "  lifecycle: active",
  "  files: [src/never-touched.ts]",
  "  symbols: [neverMentionedAnywhere]",
  "  fact: Nothing in the failure names this.",
  "  src: PR#4",
].join("\n");

const FAILURE_LOG = "AssertionError: frobnicateWidget was skipped\npush refused by the widget gate\nsee src/lib/foo.ts line 4";

const learningsDir = (root: string, entries: string[]): string => {
  const dir = join(root, "learnings");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ci.yaml"), entries.join("\n\n") + "\n");
  return dir;
};
const scratch = (): string => mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}fix-learnings-shadow-`));

const baseInput = (root: string, taskId = OFFERED_TASK) => ({
  runId: `SWEEP-1`, taskId, pr: 7, attempt: 1, round: "resume",
  failingChecks: [{ name: "test (shard 2)", title: "unit tests", logTail: FAILURE_LOG }],
  homes: { projectDir: join(root, "learnings") },
});

test("W1-T14138 criterion 1: a fix round writes one shadow row naming the matched learnings, their kinds and its task-keyed arm", () => {
  const root = scratch();
  try {
    learningsDir(root, [SYMBOL_LEARNING, ERROR_LEARNING, UNRELATED_LEARNING]);
    const rows: Row[] = [];
    const log = (step: string, extra?: Record<string, unknown>) => rows.push({ ...extra, step });
    recordFixLearningsShadow(baseInput(root), log);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.step, "fix.learnings_shadow");
    assert.equal(rows[0]!.state, "ok");
    assert.deepEqual(rows[0]!.matched, [
      { id: "refused-by-gate", kind: "error", symbol: 0, error: 1 },
      { id: "frobnicate-contract", kind: "symbol", symbol: 1, error: 0 },
    ]);
    assert.deepEqual(rows[0]!.failing_checks, ["test (shard 2)"]);
    assert.equal(rows[0]!.arm, fixLearningsArm(OFFERED_TASK));
    assert.equal(rows[0]!.arm, "offered");
    assert.equal(rows[0]!.arm_unit, "task");
    assert.equal(rows[0]!.pr, 7);
    assert.equal(rows[0]!.attempt, 1);

    // The arm is keyed on the task: another run id and round of the same task draw the same arm.
    recordFixLearningsShadow({ ...baseInput(root), runId: "other-run", attempt: 3, round: "fresh" }, log);
    assert.equal(rows[1]!.arm, rows[0]!.arm);
    recordFixLearningsShadow(baseInput(root, WITHHELD_TASK), log);
    assert.equal(rows[2]!.arm, "withheld");
    assert.deepEqual(rows[2]!.matched_ids, rows[0]!.matched_ids, "both arms record the match; only the label differs");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T14138 criterion 1: an unreadable learnings store is a row of its own, not an empty match", () => {
  const rows: Row[] = [];
  recordFixLearningsShadow(baseInput(tmpdir()), (step, extra) => rows.push({ ...extra, step }), {
    load: () => { throw new Error("shard is not valid YAML"); },
    select: () => { throw new Error("unreachable"); },
  });
  assert.equal(rows[0]!.state, "unreadable");
  assert.equal(rows[0]!.reason, "shard is not valid YAML");
  assert.deepEqual(rows[0]!.matched_ids, []);
  const summary = summarizeFixLearningsShadow(rows);
  assert.equal(summary.offered.rounds, 0, "an unreadable round is not counted as a round that matched nothing");
});

test("W1-T14138 criterion 2: a learning that matches only by file path is not recorded", () => {
  const root = scratch();
  try {
    learningsDir(root, [FILE_ONLY_LEARNING, SYMBOL_LEARNING]);
    const rows: Row[] = [];
    // The failure text names src/lib/foo.ts, which the file-only learning's glob covers.
    assert.ok(FAILURE_LOG.includes("src/lib/foo.ts"));
    recordFixLearningsShadow(baseInput(root), (step, extra) => rows.push({ ...extra, step }));
    assert.deepEqual(rows[0]!.matched_ids, ["frobnicate-contract"]);
    assert.ok(!(rows[0]!.matched as { id: string }[]).some((m) => m.id === "foo-file-only"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the fix lane ───────────────────────────────────────────────────────────

const criteria: CriterionVerdict[] = [
  { claim: "wire producer", proof: "unit test: wires it", met: false, reason: "consumer disconnected", proof_exec: "executed_fail" },
];
const taskFor = (id: string) => ({ id, title: "wire the producer", files: ["src/changed.ts"], acceptance: criteria });
const mount = { model: "sonnet", effort: "medium", maxTurns: 10, contextBudget: 120000 };

/** One fix round of `taskId` on a red CI; returns the prompt the worker was spawned with and every ledger row. */
async function fixRound(taskId: string, entries: string[]): Promise<{ prompt: string; rows: Row[] }> {
  const task = taskFor(taskId);
  const runId = `${taskId}-1791151948510`;
  const root = scratch();
  if (entries.length > 0) learningsDir(root, entries);
  const initialReview = {
    state: "failure" as const, criteria, testTheater: false, summary: "one visible gap",
    floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
    headSha: "a".repeat(40), reviewerOutcome: "success",
  };
  const prompts: string[] = [];
  const rows: Row[] = [];
  try {
    await runFixRung({
      task, taskId: task.id, runId, prUrl: "https://github.com/acme/remudero/pull/1",
      branch: `run-${runId}`, worktreePath: root, initialSessionId: "", initialReview,
      ciFailures: [{ name: "test (shard 2)", logTail: FAILURE_LOG }],
      mount, settingsFile: join(root, "settings.json"), config: {} as Config, budgetUsd: 1, strikeCap: 1,
      reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: root, reviewerMount: mount },
      deps: {
        ledgerLines: () => [], ledgerPath: join(root, "ledger.ndjson"),
        spawn: async (args) => {
          prompts.push(args.prompt);
          return {
            sessionId: "fix", costUsd: 0, numTurns: 1, text: "fixed", blocks: [], stderr: "",
            subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
            model: "sonnet", effort: "medium", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
            modelUsage: {}, compactionEvents: [], qualitySuspect: false,
          } satisfies WorkerResult;
        },
        waitForCiGreen: async () => "green",
        runReview: async () => ({ ...initialReview, state: "success", criteria: criteria.map((c) => ({ ...c, met: true })), headSha: "d".repeat(40) }),
        push: () => {}, fetchPrBody: async () => "implemented", fetchPrDiffFiles: async () => task.files,
        issues: { create: () => "https://github.com/acme/remudero/issues/1", listOpen: () => [], comment: () => {} },
        log: (step, extra) => rows.push({ ...extra, step }), say: () => {}, account: (worker) => worker,
      },
    });
    assert.equal(prompts.length, 1, "the fixture dispatches exactly one fix worker");
    return { prompt: prompts[0]!, rows };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// An untrusted-data envelope draws a fresh random boundary per render; every other byte must match.
const normalized = (prompt: string): string => prompt.replace(/boundary="[^"]*"/g, 'boundary="B"');

test("W1-T14138 criterion 3: the fix prompt is byte-identical with and without matching learnings, in both arms", async () => {
  for (const taskId of [OFFERED_TASK, WITHHELD_TASK]) {
    const withLearnings = await fixRound(taskId, [SYMBOL_LEARNING, ERROR_LEARNING]);
    const without = await fixRound(taskId, []);
    const shadow = withLearnings.rows.filter((row) => row.step === "fix.learnings_shadow");
    assert.equal(shadow.length, 1, `${taskId}: one shadow row`);
    assert.equal(shadow[0]!.arm, fixLearningsArm(taskId));
    assert.deepEqual(shadow[0]!.matched_ids, ["refused-by-gate", "frobnicate-contract"], `${taskId}: the failure matches`);
    assert.deepEqual(shadow[0]!.failing_checks, ["test (shard 2)"]);
    assert.equal(normalized(withLearnings.prompt), normalized(without.prompt), `${taskId}: matches never reach the prompt`);
    assert.ok(!withLearnings.prompt.includes("frobnicateWidget must be called"), "the fact is not injected");
    assert.deepEqual(without.rows.find((row) => row.step === "fix.learnings_shadow")!.matched_ids, []);
  }
});

test("W1-T14138 criterion 4: a round's outcome row records the CI conclusion on the head it pushed, or that it pushed nothing", async () => {
  const rows: Row[] = [];
  const log = (step: string, extra?: Record<string, unknown>) => rows.push({ ...extra, step });
  const base = { runId: "SWEEP-1", taskId: OFFERED_TASK, pr: 7, attempt: 1, roundId: "SWEEP-1:1:100" };
  recordFixLearningsOutcome({ ...base, pushedHeadSha: "b".repeat(40), ci: "green" }, log);
  recordFixLearningsOutcome({ ...base, pushedHeadSha: "c".repeat(40), ci: "red" }, log);
  recordFixLearningsOutcome({ ...base, pushedHeadSha: undefined, ci: "green" }, log);
  assert.deepEqual(rows.map((row) => row.step), Array(3).fill("fix.learnings_outcome"));
  assert.deepEqual(rows.map((row) => row.conclusion), ["green", "red", "no_push"]);
  assert.equal(rows[0]!.pushed_head_sha, "b".repeat(40));
  assert.ok(!("pushed_head_sha" in rows[2]!), "a round that pushed nothing names no head");

  // The lane writes the row: this fixture's worker changes nothing, so the round pushes nothing and settles when the loop ends.
  const { rows: laneRows } = await fixRound(OFFERED_TASK, []);
  const outcomes = laneRows.filter((row) => row.step === "fix.learnings_outcome");
  assert.equal(outcomes.length, 1, "one outcome per round");
  assert.equal(outcomes[0]!.attempt, 1);
  assert.equal(outcomes[0]!.task_id, OFFERED_TASK);
  assert.equal(outcomes[0]!.conclusion, "no_push", "the fixture's worker commits nothing, so nothing was pushed");
  assert.ok(!("pushed_head_sha" in outcomes[0]!));
});

test("W1-T14138 criterion 4: the summary reports, per arm, matches by kind, outcome rates and rounds to green", () => {
  const shadow = (taskId: string, attempt: number, arm: string, matched: { kind: string }[]) =>
    ({ step: "fix.learnings_shadow", run_id: "R", task_id: taskId, attempt, arm, state: "ok", matched });
  const outcome = (taskId: string, attempt: number, conclusion: string) =>
    ({ step: "fix.learnings_outcome", run_id: "R", task_id: taskId, attempt, conclusion, round_id: `R:${attempt}` });
  const done = (taskId: string, attempt: number) => ({ step: "fix.done", task_id: taskId, round_id: `R:${attempt}` });
  const summary = summarizeFixLearningsShadow([
    shadow("T-A", 1, "offered", [{ kind: "symbol" }, { kind: "error" }]), done("T-A", 1), outcome("T-A", 1, "red"),
    shadow("T-A", 2, "offered", []), done("T-A", 2), outcome("T-A", 2, "green"),
    shadow("T-B", 1, "withheld", [{ kind: "both" }]), done("T-B", 1), outcome("T-B", 1, "no_push"),
    shadow("T-B", 2, "withheld", []),
  ]);
  assert.equal(summary.offered.rounds, 2);
  assert.equal(summary.offered.roundsWithMatch, 1);
  assert.deepEqual(summary.offered.matchRateByKind, { symbol: 0.5, error: 0.5, both: 0 });
  assert.deepEqual(summary.offered.outcomeRates, { green: 0.5, red: 0.5, no_push: 0, unknown: 0 });
  assert.equal(summary.offered.meanRoundsToGreen, 2);
  assert.equal(summary.withheld.rounds, 2);
  assert.equal(summary.withheld.settled, 1, "a round with no outcome row is unsettled, not counted");
  assert.equal(summary.withheld.outcomes.no_push, 1);
  assert.equal(summary.withheld.meanRoundsToGreen, undefined);
  assert.deepEqual(summary.tasks, [
    { taskId: "T-A", arm: "offered", roundsToGreen: 2 },
    { taskId: "T-B", arm: "withheld", roundsToGreen: undefined },
  ]);
});
