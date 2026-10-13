import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CorpusProofOutcome, GoldenCorpusItem, ReplayIdleSignal } from "../src/lib/golden-corpus.js";
import type { UsageSnapshot } from "../src/lib/headroom.js";
import type { PairedAttemptRequest, PairedAttemptResult, PairedGrade } from "../src/lib/paired-trial.js";
import type { HeldOutSelected, SkillEvalAttempt, SkillEvalRun } from "../src/lib/skill-eval.js";

// Phase 3 of 5 of the held-out skill eval (operator rulings 2026-10-13): the runner that attempts a draft with
// and without the skill on K = 3 held-out tasks x R = 2 trials per arm, and the verdict it reaches. Every
// dispatcher and grader here is a fake but one, which greps real temp heads; nothing spawns a worker or spends.

/** Loaded inside each test, so on a tree without the runner each proof FAILS rather than the file failing to load. */
const skillEval = (): Promise<typeof import("../src/lib/skill-eval.js")> => import("../src/lib/skill-eval.js");

function corpusItem(taskId: string, proof = `unit test: the held-out proof title of ${taskId}`): GoldenCorpusItem {
  return {
    taskId, baseSha: `base-${taskId}`, headSha: `head-${taskId}`, mergedAt: "2026-10-01T00:00:00.000Z", creditSource: "ledger",
    proofs: [{ claim: `claim of ${taskId}`, proof, holdout: false }], spec: { type: "implement", verify: "auto", files: [`src/lib/${taskId}.ts`] },
    freshness: { ageDays: 12 }, heldOut: true,
  };
}

const CORPUS = Array.from({ length: 10 }, (_, i) => corpusItem(`W1-T97${i}0`));
const DRAFT = { markdown: "# types-first\n\n1. Run the type checker before the tests.\n", taskType: "implement" };
const HEADROOM: UsageSnapshot = { billingMode: "subscription", session: { percentUsed: 20 }, weekly: [{ label: "all models", percentUsed: 40 }] };
const IDLE: ReplayIdleSignal = { liveness: { state: "up", quiet: true }, headroom: HEADROOM };
const CONFIRM = ["--confirm-spend"];
const STACK = {
  pin: { provider: "claude", model: "model-under-test", effort: "high", billing: "subscription" as const, stackHash: "stack-1" },
  revisions: { harnessRevision: "h1", promptRevision: "p1", toolRevision: "t1", scorerRevision: "s1", environmentRevision: "e1" },
  stackEvidence: {},
};

async function selected(k?: number, corpus: readonly GoldenCorpusItem[] = CORPUS): Promise<HeldOutSelected> {
  const { selectHeldOutTasks } = await skillEval();
  const selection = selectHeldOutTasks({ corpus, draft: DRAFT, excludedTaskIds: [], ...(k === undefined ? {} : { k }) });
  assert.ok(selection.ok, JSON.stringify(selection));
  return selection;
}

type Override = Partial<PairedAttemptResult> | "throw";

/**
 * The fakes. `grade(taskId, arm, trial, n)` names the verdict the n-th dispatch's head grades to, `trial` counting that
 * task and arm's own attempts; `override(request, n)` replaces the n-th dispatch's result, or "throw" makes it reject.
 */
function fakeFleet(grade: (taskId: string, arm: string, trial: number, n: number) => CorpusProofOutcome | "throw",
  override: (request: PairedAttemptRequest<string>, n: number) => Override = () => ({})) {
  const requests: PairedAttemptRequest<string>[] = [];
  const built: string[] = [];
  const cleaned: number[] = [];
  const graded: string[] = [];
  const rows: { step: string; row: Record<string, unknown> }[] = [];
  const heads = new Map<string, { taskId: string; arm: string; trial: number; n: number }>();
  const dispatcherFor = (item: GoldenCorpusItem) => {
    built.push(item.taskId);
    return async (request: PairedAttemptRequest<string>): Promise<PairedAttemptResult> => {
      const n = requests.push(request) - 1;
      const trial = requests.filter((r) => r.taskId === request.taskId && r.arm === request.arm).length - 1;
      const over = override(request, n);
      if (over === "throw") throw new Error("the worker spawn died");
      heads.set(`/heads/${n}`, { taskId: request.taskId, arm: request.arm, trial, n });
      return { headDir: `/heads/${n}`, headSha: `sha-${n}`, servedModel: "model-under-test", billingMode: "subscription", costUsd: 1.25,
        cleanup: () => { cleaned.push(n); }, ...over };
    };
  };
  const gradeHead = ({ headDir }: { headDir: string }): PairedGrade => {
    graded.push(headDir);
    const head = heads.get(headDir)!;
    const verdict = grade(head.taskId, head.arm, head.trial, head.n);
    if (verdict === "throw") throw new Error("the grader died");
    return { verdict, passed: verdict === "pass" ? 1 : 0, failed: verdict === "fail" ? 1 : 0, unmeasurable: verdict === "unmeasurable" ? 1 : 0,
      holdouts: 0, reasons: [verdict === "unmeasurable" ? "named-test-not-found" : `executed-${verdict}`] };
  };
  const log = (step: string, row: Record<string, unknown>): void => { rows.push({ step, row }); };
  return { requests, built, cleaned, graded, rows, dispatcherFor, grade: gradeHead, log };
}

function evaluated(run: SkillEvalRun): Extract<SkillEvalRun, { state: "evaluated" }> {
  assert.equal(run.state, "evaluated", `expected an evaluated run, got ${JSON.stringify(run)}`);
  return run as Extract<SkillEvalRun, { state: "evaluated" }>;
}

/** With-skill always passes; without-skill passes only its first trial: 1.0 against 0.5 on every task. */
const LIFTS = (_task: string, arm: string, trial: number): CorpusProofOutcome => (arm === "with-skill" || trial === 0 ? "pass" : "fail");
/** With-skill passes, without-skill fails. */
const WITH_ONLY = (_task: string, arm: string): CorpusProofOutcome => (arm === "with-skill" ? "pass" : "fail");

test("a skill eval passes a draft that lifts the with-skill pass rate, logs every attempt and the result, and cleans up every head", async () => {
  const { runSkillEval, SKILL_EVAL_STEPS } = await skillEval();
  const selection = await selected();
  const fleet = fakeFleet(LIFTS);
  const run = evaluated(await runSkillEval({ selection, draftMarkdown: DRAFT.markdown, dispatcherFor: fleet.dispatcherFor, stack: STACK,
    grade: fleet.grade, argv: CONFIRM, idle: IDLE, log: fleet.log }));
  const taskIds = selection.items.map((i) => i.taskId);

  assert.equal(run.verdict.verdict, "pass", JSON.stringify(run.verdict));
  assert.equal(run.verdict.reason, "held-out-benefit");
  assert.equal(run.verdict.delta, 0.5);
  assert.equal(run.verdict.measurableTasks, 3);
  assert.equal(run.verdict.totalCostUsd, 15);
  assert.deepEqual(run.verdict.perTask, taskIds.map((taskId) => ({ taskId, measurable: true, passRateWith: 1, passRateWithout: 0.5 })));
  assert.deepEqual(fleet.built, taskIds, "one dispatcher per held-out task, built in selection order");
  assert.equal(fleet.requests.length, 12, "K = 3 tasks x R = 2 trials x 2 arms");
  assert.deepEqual([...fleet.cleaned].sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i), "every attempt's head is cleaned up");
  for (const request of fleet.requests) {
    assert.deepEqual(request.pin, STACK.pin, "both arms run on the one pinned stack");
    assert.deepEqual(request.revisions, STACK.revisions);
    assert.deepEqual(request.isolation, { worktree: "fresh-detached", push: false, openPr: false, merge: false });
  }

  const attemptRows = fleet.rows.filter((r) => r.step === SKILL_EVAL_STEPS.attempt);
  assert.equal(attemptRows.length, 12);
  for (const [n, { row }] of attemptRows.entries()) {
    const request = fleet.requests[n]!;
    assert.equal(row.draft_sha256, selection.draftSha256);
    assert.equal(row.held_out_set_hash, selection.heldOutSetHash);
    assert.equal(row.task_id, request.taskId);
    assert.equal(row.arm, request.arm);
    assert.ok(row.trial === 0 || row.trial === 1);
    assert.equal(row.verdict, row.arm === "with-skill" || row.trial === 0 ? "pass" : "fail");
    assert.equal(row.cost_usd, 1.25);
    assert.equal(row.served_model, "model-under-test");
    assert.equal(row.breach, null);
  }
  const results = fleet.rows.filter((r) => r.step === SKILL_EVAL_STEPS.result);
  assert.equal(results.length, 1);
  assert.equal(fleet.rows.at(-1)!.step, SKILL_EVAL_STEPS.result, "the result row is written after every attempt row");
  assert.equal(results[0]!.row.verdict, "pass");
  assert.equal(results[0]!.row.draft_sha256, selection.draftSha256);
  assert.equal(results[0]!.row.delta, 0.5);
});

/** Two attempts per arm for one task, from verdict lists. */
function trials(taskId: string, withSkill: CorpusProofOutcome[], withoutSkill: CorpusProofOutcome[]): Pick<SkillEvalAttempt, "taskId" | "arm" | "verdict" | "costUsd">[] {
  return [...withSkill.map((verdict) => ({ taskId, arm: "with-skill" as const, verdict, costUsd: 1 })),
    ...withoutSkill.map((verdict) => ({ taskId, arm: "without-skill" as const, verdict, costUsd: 1 }))];
}

test("a skill eval refuses a draft that regresses one held-out task even when the mean delta is positive", async () => {
  const { skillEvalVerdict } = await skillEval();
  const verdict = skillEvalVerdict([
    ...trials("W1-TA", ["pass", "pass"], ["fail", "fail"]),
    ...trials("W1-TB", ["pass", "pass"], ["fail", "fail"]),
    ...trials("W1-TC", ["pass", "fail"], ["pass", "pass"]),
  ]);
  assert.equal(verdict.delta, 0.5, "(1 + 1 - 0.5) / 3: the mean alone would pass the draft");
  assert.equal(verdict.measurableTasks, 3);
  assert.equal(verdict.verdict, "refuse");
  assert.equal(verdict.reason, "per-task-regression");
  assert.match(verdict.detail, /W1-TC/);
  assert.doesNotMatch(verdict.detail, /W1-TA|W1-TB/);
  assert.equal(verdict.totalCostUsd, 12);
});

test("a skill eval refuses a draft whose mean with-skill minus without-skill delta is zero or below", async () => {
  const { skillEvalVerdict } = await skillEval();
  const level = skillEvalVerdict([
    ...trials("W1-TA", ["pass", "fail"], ["fail", "pass"]),
    ...trials("W1-TB", ["pass", "pass"], ["pass", "pass"]),
    ...trials("W1-TC", ["fail", "fail"], ["fail", "fail"]),
  ]);
  assert.equal(level.delta, 0);
  assert.equal(level.verdict, "refuse");
  assert.equal(level.reason, "no-benefit");
  const worse = skillEvalVerdict([
    ...trials("W1-TA", ["fail", "fail"], ["pass", "pass"]),
    ...trials("W1-TB", ["fail", "fail"], ["pass", "fail"]),
    ...trials("W1-TC", ["fail", "fail"], ["fail", "fail"]),
  ]);
  assert.equal(worse.delta, -0.5);
  assert.equal(worse.verdict, "refuse");
  assert.equal(worse.reason, "no-benefit");
});

test("a skill eval counts a task with any unmeasurable attempt as unmeasurable, and refuses fewer than K measurable tasks", async () => {
  const { runSkillEval } = await skillEval();
  const selection = await selected();
  const last = selection.items[2]!.taskId;
  // Every task would be a clean win for the draft; one without-skill attempt on the last task cannot be graded.
  const fleet = fakeFleet((task, arm, trial) => (arm === "with-skill" ? "pass" : task === last && trial === 1 ? "unmeasurable" : "fail"));
  const run = evaluated(await runSkillEval({ selection, draftMarkdown: DRAFT.markdown, dispatcherFor: fleet.dispatcherFor, stack: STACK,
    grade: fleet.grade, argv: CONFIRM, idle: IDLE, log: fleet.log }));
  assert.equal(run.verdict.verdict, "refuse");
  assert.equal(run.verdict.reason, "too-few-measurable-tasks");
  assert.equal(run.verdict.measurableTasks, 2);
  assert.deepEqual(run.verdict.perTask.find((t) => t.taskId === last), { taskId: last, measurable: false, passRateWith: null, passRateWithout: null });
  const ungraded = run.attempts.filter((a) => a.verdict === "unmeasurable");
  assert.equal(ungraded.length, 1);
  assert.equal(ungraded[0]!.taskId, last);
  assert.deepEqual(ungraded[0]!.reasons, ["ungradeable:named-test-not-found"]);
});

test("a skill eval treats an isolation breach as unmeasurable, never grading the breached head", async () => {
  const { runSkillEval, SKILL_EVAL_STEPS } = await skillEval();
  const selection = await selected();
  const [first, second] = selection.items.map((i) => i.taskId);
  const fleet = fakeFleet(WITH_ONLY, (request) => {
    if (request.arm !== "with-skill") return {};
    if (request.taskId === first) return { pushedRef: "refs/heads/leaked" };
    return request.taskId === second ? { breach: "branch-write:refs/heads/attempt" } : {};
  });
  const run = evaluated(await runSkillEval({ selection, draftMarkdown: DRAFT.markdown, dispatcherFor: fleet.dispatcherFor, stack: STACK,
    grade: fleet.grade, argv: CONFIRM, idle: IDLE, log: fleet.log }));
  const breached = run.attempts.filter((a) => a.breach !== null);
  assert.equal(breached.length, 4, "both with-skill trials on two tasks");
  for (const attempt of breached) {
    assert.equal(attempt.verdict, "unmeasurable", "a breached head would have graded pass, yet it is never a pass");
    assert.deepEqual(attempt.reasons, ["isolation-breach"]);
  }
  assert.equal(fleet.graded.length, 8, "only the 8 sealed heads reach the grader");
  assert.equal(fleet.cleaned.length, 12, "a breached attempt is still cleaned up");
  const rows = fleet.rows.filter((r) => r.step === SKILL_EVAL_STEPS.attempt && r.row.breach !== null);
  assert.deepEqual([...new Set(rows.map((r) => r.row.breach))].sort(), ["branch-write:refs/heads/attempt", "refs/heads/leaked"]);
  assert.equal(run.verdict.verdict, "refuse");
  assert.equal(run.verdict.reason, "too-few-measurable-tasks");
  assert.equal(run.verdict.measurableTasks, 1);
});

test("a skill eval without --confirm-spend, or with the fleet not idle, refuses and dispatches nothing", async () => {
  const { runSkillEval, SKILL_EVAL_STEPS } = await skillEval();
  const selection = await selected();
  const cases: { argv: string[]; idle: ReplayIdleSignal; reason: string }[] = [
    { argv: [], idle: IDLE, reason: "spend-not-confirmed" },
    { argv: ["--confirm"], idle: IDLE, reason: "spend-not-confirmed" },
    { argv: CONFIRM, idle: { liveness: { state: "up" }, headroom: HEADROOM }, reason: "fleet-not-idle" },
    { argv: CONFIRM, idle: { headroom: HEADROOM }, reason: "fleet-not-idle" },
    { argv: CONFIRM, idle: { liveness: { state: "up", quiet: true }, headroom: { ...HEADROOM, session: { percentUsed: 99 } } }, reason: "fleet-not-idle" },
  ];
  for (const { argv, idle, reason } of cases) {
    const fleet = fakeFleet(LIFTS);
    const run = await runSkillEval({ selection, draftMarkdown: DRAFT.markdown, dispatcherFor: fleet.dispatcherFor, stack: STACK,
      grade: fleet.grade, argv, idle, log: fleet.log });
    assert.equal(run.state, "refused", JSON.stringify({ argv, idle }));
    assert.ok(run.state === "refused" && run.reason === reason && run.dispatched === 0, JSON.stringify(run));
    assert.ok(run.state === "refused" && run.detail.startsWith("refusing to replay"), "the gate's own reason is carried");
    assert.equal(fleet.built.length, 0, "no dispatcher is even built");
    assert.equal(fleet.requests.length, 0, "the fake dispatcher records zero calls");
    assert.deepEqual(fleet.rows.map((r) => r.step), [SKILL_EVAL_STEPS.refused]);
    assert.equal(fleet.rows[0]!.row.reason, reason);
  }
});

test("a skill eval trial order is seeded by the draft sha256 and interleaves the arms in alternating blocks", async () => {
  const { runSkillEval, skillEvalTrialOrder, SKILL_EVAL_TRIALS_PER_ARM } = await skillEval();
  assert.equal(SKILL_EVAL_TRIALS_PER_ARM, 2);
  const seed = "a".repeat(64);
  const ids = Array.from({ length: 32 }, (_, i) => `W1-T98${String(i).padStart(2, "0")}`);
  const openers = new Set<string>();
  for (const id of ids) {
    const order = skillEvalTrialOrder(seed, id);
    assert.deepEqual(skillEvalTrialOrder(seed, id), order, "the same seed and task give the same order");
    assert.equal(order.length, 4);
    assert.deepEqual(order.map((s) => [s.trial, s.position]), [[0, 0], [0, 1], [1, 0], [1, 1]]);
    for (const block of [order.slice(0, 2), order.slice(2)]) {
      assert.deepEqual(block.map((s) => s.arm).sort(), ["with-skill", "without-skill"], "each block holds one attempt per arm");
    }
    assert.equal(order[0]!.arm, order[3]!.arm, "the blocks alternate (A B, B A), so both arms share one mean position in time");
    openers.add(order[0]!.arm);
  }
  assert.equal(openers.size, 2, "the seed, not a fixed rule, picks which arm opens");
  const reseeded = ids.map((id) => skillEvalTrialOrder("b".repeat(64), id)[0]!.arm);
  assert.notDeepEqual(reseeded, ids.map((id) => skillEvalTrialOrder(seed, id)[0]!.arm), "another draft orders some task differently");

  const selection = await selected();
  const fleet = fakeFleet(LIFTS);
  await runSkillEval({ selection, draftMarkdown: DRAFT.markdown, dispatcherFor: fleet.dispatcherFor, stack: STACK, grade: fleet.grade,
    argv: CONFIRM, idle: IDLE, log: fleet.log });
  for (const item of selection.items) {
    const dispatched = fleet.requests.filter((r) => r.taskId === item.taskId).map((r) => [r.arm, r.position]);
    assert.deepEqual(dispatched, skillEvalTrialOrder(selection.draftSha256, item.taskId).map((s) => [s.arm, s.position]),
      "the runner dispatches in the order the draft sha256 seeds");
  }
});

test("a skill eval spend ceiling is 180 USD, and a run that could exceed it refuses before dispatching anything", async () => {
  const { runSkillEval, SKILL_EVAL_MAX_SPEND_USD, SKILL_EVAL_HELD_OUT_TASKS, SKILL_EVAL_TRIALS_PER_ARM } = await skillEval();
  const { PAIRED_ATTEMPT_MAX_BUDGET_USD } = await import("../src/lib/paired-trial.js");
  assert.equal(SKILL_EVAL_MAX_SPEND_USD, 180);
  assert.equal(SKILL_EVAL_MAX_SPEND_USD, SKILL_EVAL_HELD_OUT_TASKS * SKILL_EVAL_TRIALS_PER_ARM * 2 * PAIRED_ATTEMPT_MAX_BUDGET_USD);
  const four = await selected(4);
  const fleet = fakeFleet(LIFTS);
  const run = await runSkillEval({ selection: four, draftMarkdown: DRAFT.markdown, dispatcherFor: fleet.dispatcherFor, stack: STACK,
    grade: fleet.grade, argv: CONFIRM, idle: IDLE, log: fleet.log });
  assert.ok(run.state === "refused" && run.reason === "over-spend-ceiling", JSON.stringify(run));
  assert.match(run.detail, /16 attempts/);
  assert.equal(fleet.built.length, 0);
  assert.equal(fleet.requests.length, 0);
});

test("a skill eval stops dispatching once an overspent attempt leaves less than one attempt cap under the ceiling", async () => {
  const { runSkillEval } = await skillEval();
  const selection = await selected();
  const fleet = fakeFleet(LIFTS, () => ({ costUsd: 16 }));
  const run = evaluated(await runSkillEval({ selection, draftMarkdown: DRAFT.markdown, dispatcherFor: fleet.dispatcherFor, stack: STACK,
    grade: fleet.grade, argv: CONFIRM, idle: IDLE, log: fleet.log }));
  assert.equal(fleet.requests.length, 11, "11 x 16 = 176 spent, and one more at the 15 cap could reach 191");
  const skipped = run.attempts.at(-1)!;
  assert.equal(skipped.verdict, "unmeasurable");
  assert.equal(skipped.costUsd, 0);
  assert.deepEqual(skipped.reasons, ["spend-ceiling-reached"]);
  assert.equal(run.verdict.verdict, "refuse");
  assert.equal(run.verdict.reason, "too-few-measurable-tasks");
  assert.equal(run.verdict.totalCostUsd, 176);
});

test("a skill eval names each failed attempt reason and keeps a graded verdict when only its cleanup fails", async () => {
  const { runSkillEval } = await skillEval();
  const selection = await selected();
  const fleet = fakeFleet((task, arm, _trial, n) => (n === 2 ? "throw" : n === 3 ? "unmeasurable" : WITH_ONLY(task, arm)), (_request, n) => {
    if (n === 0) return "throw";
    if (n === 1) return { headDir: null };
    return n === 4 ? { cleanup: () => { throw new Error("worktree remove failed"); } } : {};
  });
  const run = evaluated(await runSkillEval({ selection, draftMarkdown: DRAFT.markdown, dispatcherFor: fleet.dispatcherFor, stack: STACK,
    grade: fleet.grade, argv: CONFIRM, idle: IDLE, log: fleet.log }));
  assert.deepEqual(run.attempts.slice(0, 4).map((a) => [a.verdict, a.reasons]), [
    ["unmeasurable", ["attempt-failed: the worker spawn died"]],
    ["unmeasurable", ["no-head"]],
    ["unmeasurable", ["grading-failed: the grader died"]],
    ["unmeasurable", ["ungradeable:named-test-not-found"]],
  ], "each failure keeps its own message, so a paid attempt that died says why");
  assert.equal(run.attempts[0]!.costUsd, null, "a dispatch that died reports no cost");
  const cleanupFailed = run.attempts[4]!;
  assert.notEqual(cleanupFailed.verdict, "unmeasurable", "a head graded before its cleanup failed keeps its grade");
  assert.deepEqual(cleanupFailed.reasons, ["cleanup-failed: worktree remove failed"]);
  assert.equal(run.verdict.reason, "too-few-measurable-tasks");
});

test("a skill eval refuses a draft that is not the one its held-out set was drawn for, or a set smaller than K", async () => {
  const { runSkillEval } = await skillEval();
  const selection = await selected();
  const edited = await runSkillEval({ selection, draftMarkdown: `${DRAFT.markdown}2. Then run the tests.\n`, dispatcherFor: fakeFleet(LIFTS).dispatcherFor,
    stack: STACK, argv: CONFIRM, idle: IDLE, log: () => {} });
  assert.ok(edited.state === "refused" && edited.reason === "draft-not-selected", JSON.stringify(edited));
  const fleet = fakeFleet(LIFTS);
  const two = await runSkillEval({ selection: await selected(2), draftMarkdown: DRAFT.markdown, dispatcherFor: fleet.dispatcherFor,
    stack: STACK, argv: CONFIRM, idle: IDLE, log: fleet.log });
  assert.ok(two.state === "refused" && two.reason === "too-few-held-out-tasks", JSON.stringify(two));
  assert.equal(fleet.requests.length, 0);
});

test("a skill eval with no grader grades each head by its held-out proofs through the reviewer executor", async () => {
  const { runSkillEval } = await skillEval();
  const proof = "grep: SKILL_EVAL_HEAD_MARK in src/feature.ts";
  const selection = await selected(undefined, CORPUS.map((item) => corpusItem(item.taskId, proof)));
  const removed: string[] = [];
  // Each with-skill head carries the mark the held-out proof greps for; each without-skill head does not.
  const dispatcherFor = () => async (request: PairedAttemptRequest<string>): Promise<PairedAttemptResult> => {
    const dir = mkdtempSync(join(tmpdir(), "rmd-skill-eval-head-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "feature.ts"), request.arm === "with-skill" ? "export const SKILL_EVAL_HEAD_MARK = 1;\n" : "export const other = 1;\n");
    return { headDir: dir, headSha: null, servedModel: null, billingMode: null, costUsd: 0.5,
      cleanup: () => { rmSync(dir, { recursive: true, force: true }); removed.push(dir); } };
  };
  const run = evaluated(await runSkillEval({ selection, draftMarkdown: DRAFT.markdown, dispatcherFor, stack: STACK, argv: CONFIRM, idle: IDLE,
    log: () => {} }));
  assert.deepEqual(run.attempts.map((a) => a.verdict), run.attempts.map((a) => (a.arm === "with-skill" ? "pass" : "fail")),
    JSON.stringify(run.attempts.map((a) => a.reasons)));
  assert.equal(run.verdict.verdict, "pass");
  assert.equal(run.verdict.delta, 1);
  assert.equal(removed.length, 12);
});
