import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "#src/lib/config.js";
import {
  fixLearningsArm,
  recordFixLearningsOutcome,
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

const taskInArm = (arm: FixLearningsArm): string => {
  for (let i = 1; ; i++) {
    const id = `W1-T9${String(i).padStart(3, "0")}`;
    if (fixLearningsArm(id) === arm) return id;
  }
};

interface RoundResult { rows: Row[]; prompts: string[] }

/** One fix rung of `taskId` through the fix lane, with `withLearnings` choosing whether the repo holds a corpus. */
async function fixRound(taskId: string, withLearnings: boolean, ciFailures = failingChecks): Promise<RoundResult> {
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
  const rows: Row[] = [];
  const prompts: string[] = [];
  try {
    await runFixRung({
      task, taskId, runId: `run-${taskId}-1`, prUrl: "https://github.com/acme/remudero/pull/7",
      branch: `run-${taskId}-1791151948510`, worktreePath: worktree, initialSessionId: "", initialReview,
      ciFailures,
      mount, settingsFile: join(worktree, "settings.json"), config: { root } as Config, budgetUsd: 1, strikeCap: 1,
      reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: worktree, reviewerMount: mount },
      deps: {
        approvedSkillsDir: join(root, ".claude", "skills"),
        ledgerLines: () => [], ledgerPath: join(worktree, "ledger.ndjson"),
        spawn: async (args: { prompt: string }) => {
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return { rows, prompts };
}

const stepRows = (rows: Row[], step: string): Row[] => rows.filter((row) => row.step === step);

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
  const { rows } = await fixRound(taskInArm("offered"), true);
  const shadow = stepRows(rows, "fix.learnings_shadow")[0]!;
  const outcomes = stepRows(rows, "fix.learnings_outcome");
  assert.equal(outcomes.length, 1, "one outcome row per round");
  assert.equal(outcomes[0]!.ci_conclusion, "no_push", "the worker changed nothing, so nothing was pushed");
  assert.equal(outcomes[0]!.round_key, shadow.round_key, "the outcome joins its shadow row");
  assert.equal(outcomes[0]!.pushed_head_sha, undefined);

  const logged: Row[] = [];
  const log = (step: string, extra: Record<string, unknown>) => logged.push({ ...extra, step });
  const base = { taskId: "W1-T1", roundKey: "k", attempt: 1, log };
  assert.equal(recordFixLearningsOutcome({ ...base, pushedHeadSha: "b".repeat(40), ciState: "green" }), "green");
  assert.equal(recordFixLearningsOutcome({ ...base, pushedHeadSha: "c".repeat(40), ciState: "red" }), "red");
  assert.equal(recordFixLearningsOutcome({ ...base, pushedHeadSha: "d".repeat(40), ciState: "timeout" }), "other");
  assert.deepEqual(logged.map((r) => [r.ci_conclusion, r.pushed_head_sha]), [["green", "b".repeat(40)], ["red", "c".repeat(40)], ["other", "d".repeat(40)]]);
});

test("W1-T14138: the shadow row records an unreadable corpus instead of failing the round", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}fix-learnings-bad-`));
  try {
    writeFileSync(join(dir, "ci.yaml"), "- id: [unclosed\n  fact: {");
    const logged: Row[] = [];
    const result = recordFixLearningsShadow({
      taskId: "W1-T1", attempt: 1, round: "fresh", roundKey: "k", evidence: { ciFailures: failingChecks },
      homes: { projectDir: dir }, log: (step, extra) => logged.push({ ...extra, step }),
    });
    assert.equal(logged.length, 1);
    assert.equal(logged[0]!.outcome, "unreadable");
    assert.match(String(logged[0]!.reason), /\S/, "the row names why");
    assert.deepEqual(result.matches, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T14138: the summary reports, per arm, match rate by kind and outcome rates", () => {
  const shadow = (arm: string, key: string, task: string, matched: unknown[]): Row =>
    ({ step: "fix.learnings_shadow", arm, round_key: key, task_id: task, outcome: "recorded", matched });
  const outcome = (key: string, ci_conclusion: string): Row => ({ step: "fix.learnings_outcome", round_key: key, ci_conclusion });
  const summary = summarizeFixLearningsShadow([
    shadow("offered", "a", "T1", [{ id: "x", kinds: ["error", "symbol"] }]), outcome("a", "red"),
    shadow("offered", "b", "T1", []), outcome("b", "green"),
    shadow("withheld", "c", "T2", [{ id: "y", kinds: ["symbol"] }]), outcome("c", "no_push"),
  ]);
  assert.equal(summary.offered.rounds, 2);
  assert.equal(summary.offered.roundsWithMatch, 1);
  assert.deepEqual(summary.offered.matchRateByKind, { error: 0.5, symbol: 0.5 });
  assert.deepEqual(summary.offered.outcomeRates, { green: 0.5, red: 0.5, no_push: 0, other: 0 });
  assert.deepEqual(summary.offered.roundsToGreen, { T1: 2 });
  assert.equal(summary.withheld.rounds, 1);
  assert.deepEqual(summary.withheld.outcomeRates, { green: 0, red: 0, no_push: 1, other: 0 });
  assert.deepEqual(summary.withheld.roundsToGreen, {});
});
