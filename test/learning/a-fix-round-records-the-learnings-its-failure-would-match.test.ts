import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "#src/lib/config.js";
import {
  fixLearningsArm,
  recordFixLearningsShadow,
  summarizeFixLearningsShadow,
  type FixLearningsArm,
} from "#src/lib/fix-learnings-shadow.js";
import { learningMatchKinds } from "#src/lib/learnings.js";
import type { CriterionVerdict } from "#src/lib/review.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { runFixRung } from "#test/helpers/run-task-test.js";

// W1-T14138: a fix round MEASURES which learnings its failing checks would match, with a task-keyed withheld
// arm, and injects nothing. These tests drive the fix lane's own rung and read the ledger rows it writes.

type Row = Record<string, unknown> & { step: string };

const SYMBOL_FACT = "When renderWidgetTable throws, rebuild the table index before touching the renderer.";
const ERROR_FACT = "A widget-gate refusal means the registry row is missing; add it before anything else.";
const FILE_FACT = "Changes under src/widgets touch the render cache; clear it in the same commit.";

const CORPUS = `- id: widget-symbol-learning
  subsystem: ci
  lifecycle: active
  files: ["src/other/**"]
  symbols: [renderWidgetTable]
  fact: >-
    ${SYMBOL_FACT}
  src: test
  cited: "2026-11-01"
- id: widget-error-learning
  subsystem: ci
  lifecycle: active
  files: ["src/other/**"]
  error_signatures: ["widget-gate refused"]
  fact: >-
    ${ERROR_FACT}
  src: test
  cited: "2026-11-01"
- id: widget-file-only-learning
  subsystem: ci
  lifecycle: active
  files: ["src/widgets/**"]
  fact: >-
    ${FILE_FACT}
  src: test
  cited: "2026-11-01"
`;

const criteria: CriterionVerdict[] = [
  { claim: "wire producer", proof: "unit test: wires it", met: false, reason: "consumer disconnected", proof_exec: "executed_fail" },
];
const mount = { model: "sonnet", effort: "medium", maxTurns: 10, contextBudget: 120000 };

const failingChecks = [{
  name: "widget-gate",
  title: "widget-gate refused the change",
  logTail: "TypeError at src/widgets/table.ts:12\n  renderWidgetTable is not a function\nwidget-gate refused: row missing",
}];

const workerResult = (extra: Partial<WorkerResult> = {}): WorkerResult => ({
  sessionId: "fix", costUsd: 0, numTurns: 1, text: "fixed", blocks: [], stderr: "",
  subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
  model: "sonnet", effort: "medium", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  modelUsage: {}, compactionEvents: [], qualitySuspect: false, ...extra,
});

const taskInArm = (arm: FixLearningsArm): string => {
  for (let i = 1; ; i++) {
    const id = `W1-T9${String(i).padStart(3, "0")}`;
    if (fixLearningsArm(id) === arm) return id;
  }
};

interface RoundResult { rows: Row[]; prompts: string[] }

type RungDeps = Parameters<typeof runFixRung>[0]["deps"];

/** One fix rung of `taskId` through the fix lane, with `withLearnings` choosing whether the repo holds a corpus.
 *  `rows` collects what the rung logged, so a caller that expects a throw still reads them. */
async function fixRound(
  taskId: string,
  withLearnings: boolean,
  ciFailures = failingChecks,
  overrides: Partial<RungDeps> = {},
  rows: Row[] = [],
  config?: Config,
): Promise<RoundResult> {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}fix-learnings-`));
  const worktree = join(root, "worktree");
  mkdirSync(worktree, { recursive: true });
  if (withLearnings) {
    mkdirSync(join(worktree, "learnings"), { recursive: true });
    writeFileSync(join(worktree, "learnings", "ci.yaml"), CORPUS);
  }
  const task = { id: taskId, title: "wire the producer", files: ["src/changed.ts"], acceptance: criteria };
  const initialReview = {
    state: "failure" as const, criteria, testTheater: false, summary: "one visible gap",
    floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
    headSha: "a".repeat(40), reviewerOutcome: "success",
  };
  const prompts: string[] = [];
  try {
    await runFixRung({
      task, taskId, runId: `run-${taskId}-1`, prUrl: "https://github.com/acme/remudero/pull/7",
      branch: `run-${taskId}-1791151948510`, worktreePath: worktree, initialSessionId: "", initialReview,
      ciFailures,
      mount, settingsFile: join(worktree, "settings.json"), config: config ?? ({ root } as Config), budgetUsd: 1, strikeCap: 1,
      reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: worktree, reviewerMount: mount },
      deps: {
        approvedSkillsDir: join(root, ".claude", "skills"),
        ledgerLines: () => [], ledgerPath: join(worktree, "ledger.ndjson"),
        spawn: async (args: { prompt: string }) => {
          prompts.push(args.prompt);
          return workerResult();
        },
        waitForCiGreen: async () => "green",
        runReview: async () => ({ ...initialReview, state: "success", criteria: criteria.map((c) => ({ ...c, met: true })), headSha: "d".repeat(40) }),
        push: () => {}, fetchPrBody: async () => "implemented", fetchPrDiffFiles: async () => task.files,
        issues: { create: () => "https://github.com/acme/remudero/issues/1", listOpen: () => [], comment: () => {} },
        log: (step, extra) => rows.push({ ...extra, step }), say: () => {}, account: (worker) => worker,
        ...overrides,
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return { rows, prompts };
}

const stepRows = (rows: Row[], step: string): Row[] => rows.filter((row) => row.step === step);

const PUSHED = "b".repeat(40);

/** A push the remote branch confirms, so the round waits on CI for `PUSHED`. */
const landedPush: Partial<RungDeps> = {
  push: () => ({ fixRoundPushedHead: PUSHED }),
  readRemoteBranchHead: async () => PUSHED,
  readHeadShaForProvenance: () => PUSHED,
};

/** The one outcome row of a rung's first round, after checking it joins that round's shadow row. */
function onlyOutcome(rows: Row[]): Row {
  const shadow = stepRows(rows, "fix.learnings_shadow");
  const outcomes = stepRows(rows, "fix.learnings_outcome");
  assert.equal(shadow.length, 1, "one shadow row");
  assert.equal(outcomes.length, 1, "one outcome row per round");
  assert.equal(outcomes[0]!.round_id, shadow[0]!.round_id, "the outcome joins its shadow row");
  return outcomes[0]!;
}

test("W1-T14138 criterion 1: a fix round writes one shadow row naming the learnings its failing checks would match, with kinds and arm", async () => {
  for (const arm of ["offered", "withheld"] as const) {
    const taskId = taskInArm(arm);
    const { rows } = await fixRound(taskId, true);
    const shadow = stepRows(rows, "fix.learnings_shadow");
    assert.equal(shadow.length, 1, `${arm}: one shadow row per round`);
    const row = shadow[0]!;
    assert.equal(row.arm, arm, "the row carries the task-keyed arm");
    assert.equal(row.arm_unit, "fix-learnings");
    assert.equal(row.arm_epoch, "fix-learnings-shadow-v1");
    assert.equal(row.task_id, taskId);
    assert.equal(row.pr, 7);
    assert.equal(row.attempt, 1);
    assert.equal(row.round, "resume");
    assert.equal(row.round_id, stepRows(rows, "fix.dispatch")[0]!.round_id, "the row is keyed on the dispatched round");
    assert.deepEqual(row.check_names, ["widget-gate"], "the failing check names are recorded");
    assert.equal(typeof row.budget_chars, "number");
    const matched = row.matched as { id: string; kinds: string[] }[];
    assert.deepEqual(
      matched.map((m) => [m.id, m.kinds]).sort(),
      [["widget-error-learning", ["error"]], ["widget-symbol-learning", ["symbol"]]],
      "each matched learning is named with its kind",
    );
  }
  assert.equal(fixLearningsArm(taskInArm("withheld")), "withheld");
  assert.equal(fixLearningsArm(taskInArm("offered")), "offered");
});

test("W1-T14138 criterion 2: a learning that would match only by file path is not recorded as a match", async () => {
  const { rows } = await fixRound(taskInArm("offered"), true, [{
    name: "widget-gate", title: "failed", logTail: "TypeError at src/widgets/table.ts:12 nothing else to go on",
  }]);
  const row = stepRows(rows, "fix.learnings_shadow")[0]!;
  assert.deepEqual(row.matched, [], "the failure names a path the file-only learning globs, and nothing it matches by symbol or error");
  // The same entry does match by file when the selector is handed the path: the recorder withholds the task files.
  const entry = { id: "x", subsystem: "ci", lifecycle: "active" as const, files: ["src/widgets/**"], fact: FILE_FACT, src: "test" };
  assert.deepEqual(learningMatchKinds(entry as never, ["src/widgets/table.ts"]), ["file"]);
  assert.deepEqual(learningMatchKinds(entry as never, undefined, { text: "src/widgets/table.ts" }), []);
});

test("W1-T14138 criterion 3: the fix prompt is byte-identical with and without learnings, in both arms", async () => {
  for (const arm of ["offered", "withheld"] as const) {
    const taskId = taskInArm(arm);
    const withCorpus = await fixRound(taskId, true);
    const withoutCorpus = await fixRound(taskId, false);
    const matched = stepRows(withCorpus.rows, "fix.learnings_shadow")[0]!.matched as unknown[];
    assert.equal(matched.length, 2, `${arm}: positive control: the round did match learnings`);
    assert.deepEqual(stepRows(withoutCorpus.rows, "fix.learnings_shadow")[0]!.matched, [], `${arm}: no corpus, no match`);
    assert.equal(withCorpus.prompts.length, 1);
    // The untrusted-data fence carries a fresh random nonce per render; nothing else may differ.
    const unfenced = (prompt: string): string => prompt.replace(/boundary="[A-Za-z0-9_-]+"/g, 'boundary="NONCE"');
    assert.equal(unfenced(withCorpus.prompts[0]!), unfenced(withoutCorpus.prompts[0]!), `${arm}: the prompt does not depend on the corpus`);
    for (const fact of [SYMBOL_FACT, ERROR_FACT, FILE_FACT]) assert.ok(!withCorpus.prompts[0]!.includes(fact), `${arm}: no learning is injected`);
  }
});

test("W1-T14138 criterion 4: a round's outcome row records the CI conclusion on the head it pushed, or that it pushed nothing", async () => {
  for (const conclusion of ["green", "red"] as const) {
    const { rows } = await fixRound(taskInArm("offered"), true, failingChecks,
      { ...landedPush, waitForCiGreen: async () => conclusion });
    const outcome = onlyOutcome(rows);
    assert.equal(outcome.ci_conclusion, conclusion);
    assert.equal(outcome.pushed_head_sha, PUSHED, "the row names the head CI was read on");
    assert.equal(outcome.attempt, 1);
  }
  // A push double that names no head never reached a remote, so the round pushed nothing.
  const nothing = onlyOutcome((await fixRound(taskInArm("offered"), true)).rows);
  assert.equal(nothing.ci_conclusion, "no_push");
  assert.equal(nothing.pushed_head_sha, undefined);
});

test("W1-T14138: a CI state read on another head, or neither green nor red, is not the pushed head's conclusion", async () => {
  for (const ci of [{ state: "green" as const, sha: "c".repeat(40) }, "timeout" as const]) {
    const { rows } = await fixRound(taskInArm("offered"), true, failingChecks, { ...landedPush, waitForCiGreen: async () => ci });
    const outcome = onlyOutcome(rows);
    assert.equal(outcome.ci_conclusion, "other");
    assert.equal(outcome.pushed_head_sha, PUSHED);
  }
});

test("W1-T14138: a round whose remote head cannot be read after the push records other, never no_push", async () => {
  const { rows } = await fixRound(taskInArm("offered"), true, failingChecks,
    { ...landedPush, readRemoteBranchHead: async () => { throw new Error("remote unreachable"); } });
  const outcome = onlyOutcome(rows);
  assert.equal(outcome.ci_conclusion, "other");
  assert.equal(outcome.push_unread, true);
});

test("W1-T14138: a round that ends before its fix.done row, or by a throw, still writes its outcome", async () => {
  const abandoned = await fixRound(taskInArm("offered"), true, failingChecks,
    { spawn: async () => workerResult({ notStarted: "admission-abandoned" }) });
  assert.equal(onlyOutcome(abandoned.rows).ci_conclusion, "no_push");

  const crashed: Row[] = [];
  await assert.rejects(fixRound(taskInArm("offered"), true, failingChecks,
    { spawn: async () => { throw new Error("spawn broke"); } }, crashed), /spawn broke/);
  assert.equal(onlyOutcome(crashed).ci_conclusion, "no_push");

  const unwaited: Row[] = [];
  await assert.rejects(fixRound(taskInArm("offered"), true, failingChecks,
    { ...landedPush, waitForCiGreen: async () => { throw new Error("ci wait broke"); } }, unwaited), /ci wait broke/);
  const outcome = onlyOutcome(unwaited);
  assert.equal(outcome.ci_conclusion, "other", "the head was pushed and its CI never read");
  assert.equal(outcome.pushed_head_sha, PUSHED);
});

test("W1-T14138: the shadow row records an unreadable corpus instead of failing the round", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}fix-learnings-bad-`));
  try {
    writeFileSync(join(dir, "ci.yaml"), "- id: [unclosed\n  fact: {");
    const logged: Row[] = [];
    const result = recordFixLearningsShadow({
      taskId: "W1-T1", attempt: 1, round: "fresh", roundId: "k", evidence: { ciFailures: failingChecks },
      homes: () => ({ projectDir: dir }), log: (step, extra) => logged.push({ ...extra, step }),
    });
    assert.equal(logged.length, 1);
    assert.equal(logged[0]!.outcome, "unreadable");
    assert.match(String(logged[0]!.reason), /\S/, "the row names why");
    assert.deepEqual(result.matches, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T14138: a rung whose shared learnings homes cannot be resolved runs its round and records why", async () => {
  const { rows, prompts } = await fixRound(taskInArm("offered"), true, failingChecks, {}, [], {} as Config);
  assert.equal(prompts.length, 1, "the round still spawned its worker");
  const shadow = stepRows(rows, "fix.learnings_shadow")[0]!;
  assert.equal(shadow.outcome, "unreadable");
  assert.match(String(shadow.reason), /\S/, "the row names why");
  assert.equal(onlyOutcome(rows).ci_conclusion, "no_push");
});

test("W1-T14138: the summary reports, per arm, match rate by kind, outcome rates and rounds to green", () => {
  const shadow = (arm: string, key: string, task: string, matched: unknown[], outcome = "recorded"): Row =>
    ({ step: "fix.learnings_shadow", arm, round_id: key, task_id: task, outcome, matched });
  const outcome = (key: string, task: string, ci_conclusion: string): Row =>
    ({ step: "fix.learnings_outcome", round_id: key, task_id: task, ci_conclusion });
  const done = (step: "fix.dispatch" | "fix.done", key: string, task: string): Row => ({ step, round_id: key, task_id: task });
  const summary = summarizeFixLearningsShadow([
    // A round that predates the shadow rows still counts toward its task's rounds to green.
    done("fix.dispatch", "earlier", "T1"), done("fix.done", "earlier", "T1"),
    shadow("offered", "a", "T1", [{ id: "x", kinds: ["error", "symbol"] }]), done("fix.dispatch", "a", "T1"),
    done("fix.done", "a", "T1"), outcome("a", "T1", "red"),
    shadow("offered", "b", "T1", []), done("fix.dispatch", "b", "T1"), outcome("b", "T1", "green"),
    shadow("withheld", "c", "T2", [{ id: "y", kinds: ["symbol"] }]), done("fix.done", "c", "T2"), outcome("c", "T2", "no_push"),
    // An unreadable corpus measured no match, so its round is outside the rates.
    shadow("withheld", "d", "T3", [], "unreadable"), outcome("d", "T3", "red"),
  ]);
  assert.equal(summary.offered.rounds, 2);
  assert.equal(summary.offered.roundsWithMatch, 1);
  assert.deepEqual(summary.offered.matchRateByKind, { error: 0.5, symbol: 0.5 });
  assert.deepEqual(summary.offered.outcomeRates, { green: 0.5, red: 0.5, no_push: 0, other: 0 });
  assert.deepEqual(summary.offered.roundsToGreen, { T1: 3 });
  assert.equal(summary.withheld.rounds, 1);
  assert.deepEqual(summary.withheld.outcomeRates, { green: 0, red: 0, no_push: 1, other: 0 });
  assert.deepEqual(summary.withheld.roundsToGreen, {});
});
