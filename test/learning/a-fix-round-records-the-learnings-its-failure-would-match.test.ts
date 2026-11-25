import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "#src/lib/config.js";
import {
  FIX_LEARNINGS_LOG_TAIL_CHARS,
  fixLearningsCiConclusion,
  fixLearningsDoneConclusion,
  fixLearningsOutcomeRow,
  recordFixLearningsShadow,
  summarizeFixLearningsShadow,
  type FixLearningsRound,
} from "#src/lib/fix-learnings-shadow.js";
import { DEFAULT_KNOWLEDGE_BUDGET_CHARS } from "#src/lib/learnings.js";
import type { CriterionVerdict } from "#src/lib/review.js";
import type { CiFailure } from "#src/lib/sweep.js";
import { taskArmWithheld } from "#src/lib/task-arm.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { runFixRung } from "#test/helpers/run-task-test.js";

// W1-T14138: each fix round records which learnings its failing checks would match, in a task-keyed arm, and
// injects nothing. These tests drive the real fix rung over a real git worktree holding a learnings corpus.

const withheld = (taskId: string): boolean =>
  taskArmWithheld({ taskId, unit: "fix-learnings", share: 0.25, epoch: "fix-learnings-shadow-v1" });
const taskIds = Array.from({ length: 64 }, (_, i) => `W1-T${9100 + i}`);
const OFFERED_TASK = taskIds.find((id) => !withheld(id))!;
const WITHHELD_TASK = taskIds.find((id) => withheld(id))!;

const lesson = (id: string, matcher: string): string =>
  `- id: ${id}\n  lifecycle: active\n  files: [src/changed.ts]\n${matcher}  fact: FACT-OF-${id}\n  src: operator-fleet\n`;
const CORPUS = [
  lesson("by-check-name", "  error_signatures: [unit-shadow-check]\n"),
  lesson("by-log-error", "  error_signatures: [ERR_SHADOW_BOOM]\n"),
  lesson("by-title-symbol", "  symbols: [wireProducer]\n"),
  lesson("by-path-only", ""),
  lesson("by-absent-error", "  error_signatures: [ERR_NEVER_PRINTED]\n"),
].join("\n");

const FIRST_RED: CiFailure[] = [{ name: "unit-shadow-check", title: "wireProducer failed", logTail: "ERR_SHADOW_BOOM" }];
const SECOND_RED: CiFailure[] = [{ name: "lint-shadow-check", logTail: "a different failure" }];

const criteria: CriterionVerdict[] = [
  { claim: "wire producer", proof: "unit test: wires it", met: false, reason: "consumer disconnected", proof_exec: "executed_fail" },
];
const mount = { model: "sonnet", effort: "medium", maxTurns: 10, contextBudget: 120000 };

type Row = Record<string, unknown> & { step: string };
interface Run { prompts: string[]; rows: Row[]; pushed: string[] }

/** Drive the fix rung from a red CI dispatch; `ci[i]` is what CI concludes on the head round i+1 pushes. */
async function fixRung(opts: {
  taskId?: string;
  corpus?: string;
  ci?: Array<"green" | "red">;
  landed?: boolean;
}): Promise<Run> {
  const taskId = opts.taskId ?? OFFERED_TASK;
  const ci = opts.ci ?? ["green"];
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}fix-learnings-`));
  const fixture = gitRepo({ kind: "fix-learnings" });
  const { dir: repo, git } = fixture;
  try {
    mkdirSync(join(repo, "learnings"), { recursive: true });
    if (opts.corpus !== undefined) writeFileSync(join(repo, "learnings", "ci.yaml"), opts.corpus);
    const base = git("rev-parse", "HEAD");
    const task = { id: taskId, title: "wire the producer", files: ["src/changed.ts"], acceptance: criteria };
    const runId = `${taskId}-1791151948510`;
    const initialReview = {
      state: "failure" as const, criteria, testTheater: false, summary: "one visible gap",
      floorDegraded: false, capped: false, keywordOnly: false, planOnly: false, headSha: base, reviewerOutcome: "success",
    };
    const prompts: string[] = [];
    const rows: Row[] = [];
    const pushed: string[] = [];
    let waits = 0;
    await runFixRung({
      task, taskId, runId, prUrl: "https://github.com/acme/remudero/pull/7", branch: `run-${runId}`,
      worktreePath: repo, initialSessionId: "", initialReview, ciFailures: FIRST_RED,
      mount, settingsFile: join(root, "settings.json"), config: { root } as Config, budgetUsd: 1, strikeCap: ci.length,
      reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: repo, reviewerMount: mount },
      deps: {
        approvedSkillsDir: join(root, "skills"),
        ledgerLines: () => rows.map((row) => ({ ...row, task_id: taskId })), ledgerPath: join(root, "ledger.ndjson"),
        spawn: async (args) => {
          prompts.push(args.prompt);
          writeFileSync(join(repo, `round-${prompts.length}.txt`), "fixed\n");
          git("add", `round-${prompts.length}.txt`);
          git("commit", "-q", "-m", `fix: round ${prompts.length}`);
          return {
            sessionId: "fix", costUsd: 0, numTurns: 1, text: "fixed", blocks: [], stderr: "",
            subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
            model: "sonnet", effort: "medium", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
            modelUsage: {}, compactionEvents: [], qualitySuspect: false,
          } satisfies WorkerResult;
        },
        push: () => { pushed.push(git("rev-parse", "HEAD")); },
        ...(opts.landed === false ? { readRemoteBranchHead: async () => base } : {}),
        waitForCiGreen: async () => ({ state: ci[waits++] ?? "green", sha: git("rev-parse", "HEAD") }),
        fetchCiFailures: async () => SECOND_RED,
        runReview: async () => ({ ...initialReview, state: "success", criteria: criteria.map((c) => ({ ...c, met: true })), headSha: git("rev-parse", "HEAD") }),
        readHeadShaForProvenance: async () => git("rev-parse", "HEAD"),
        fetchPrBody: async () => "implemented", fetchPrDiffFiles: async () => task.files,
        issues: { create: () => "https://github.com/acme/remudero/issues/1", listOpen: () => [], comment: () => {} },
        log: (step, extra) => rows.push({ ...extra, step }), say: () => {}, account: (worker) => worker,
      },
    });
    return { prompts, rows, pushed };
  } finally {
    fixture.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
}

const of = (run: Run, step: string): Row[] => run.rows.filter((row) => row.step === step);
const matchedIds = (row: Row): string[] => (row.matched as Array<{ id: string }>).map((m) => m.id).sort();

test("W1-T14138 criterion 1: a fix round writes one shadow row naming the matches, their kinds and the task's arm", async () => {
  for (const [taskId, arm] of [[OFFERED_TASK, "offered"], [WITHHELD_TASK, "withheld"]] as const) {
    const run = await fixRung({ taskId, corpus: CORPUS });
    const shadows = of(run, "fix.learnings_shadow");
    assert.equal(shadows.length, 1, "one row for the one round");
    const row = shadows[0]!;
    assert.equal(row.arm, arm);
    assert.deepEqual(
      Object.fromEntries((row.matched as Array<{ id: string; kinds: string[] }>).map((m) => [m.id, m.kinds])),
      { "by-check-name": ["error"], "by-log-error": ["error"], "by-title-symbol": ["symbol"] },
    );
    assert.deepEqual(row.failing_checks, ["unit-shadow-check"]);
    assert.equal(row.task_id, taskId);
    assert.equal(row.run_id, `${taskId}-1791151948510`);
    assert.equal(row.pr_number, 7);
    assert.equal(row.attempt, 1);
    assert.equal(row.round, "resume");
    assert.equal(row.budget_chars, DEFAULT_KNOWLEDGE_BUDGET_CHARS);
    assert.ok(run.rows.indexOf(row) < run.rows.indexOf(of(run, "fix.dispatch")[0]!), "written at prompt assembly");
  }
});

test("W1-T14138 criterion 2: a learning that would match only by file path is not recorded as a match", async () => {
  const run = await fixRung({ corpus: CORPUS });
  const row = of(run, "fix.learnings_shadow")[0]!;
  assert.deepEqual(matchedIds(row), ["by-check-name", "by-log-error", "by-title-symbol"]);
  assert.deepEqual(row.dropped_ids, [], "the path-only entry is not a dropped candidate either");
});

test("W1-T14138 criterion 3: the fix prompt is byte-identical in both arms whether or not learnings match", async () => {
  // An untrusted-data envelope draws a fresh random boundary per render, and commit ids carry a clock.
  const stable = (prompt: string): string => prompt.replace(/boundary="[^"]*"/g, 'boundary="B"')
    .replace(/\b[0-9a-f]{40}\b/g, "SHA").replace(new RegExp(`${RMD_TMP_PREFIX}fix-learnings-[A-Za-z0-9]+`, "g"), "ROOT");
  for (const taskId of [OFFERED_TASK, WITHHELD_TASK]) {
    const matching = await fixRung({ taskId, corpus: CORPUS });
    const empty = await fixRung({ taskId });
    assert.equal(matchedIds(of(matching, "fix.learnings_shadow")[0]!).length, 3, "precondition: this corpus matches");
    assert.deepEqual(matchedIds(of(empty, "fix.learnings_shadow")[0]!), []);
    assert.equal(stable(matching.prompts[0]!), stable(empty.prompts[0]!));
    assert.ok(!matching.prompts[0]!.includes("FACT-OF-"), "no matched fact reaches the prompt");
  }
});

test("W1-T14138 criterion 4: the outcome row records CI on the pushed head, red then green with rounds to green", async () => {
  const run = await fixRung({ corpus: CORPUS, ci: ["red", "green"] });
  const shadows = of(run, "fix.learnings_shadow");
  const outcomes = of(run, "fix.learnings_outcome");
  assert.deepEqual(shadows.map((row) => row.attempt), [1, 2]);
  assert.deepEqual(outcomes.map((row) => row.conclusion), ["red", "green"]);
  assert.deepEqual(outcomes.map((row) => row.shadow_id), shadows.map((row) => row.shadow_id));
  assert.deepEqual(outcomes.map((row) => row.pushed_head_sha), run.pushed);
  assert.deepEqual(outcomes.map((row) => row.round_id), of(run, "fix.dispatch").map((row) => row.round_id));
  assert.equal(outcomes[0]!.rounds_to_green, undefined);
  assert.equal(outcomes[1]!.rounds_to_green, 2);
  const summary = summarizeFixLearningsShadow(run.rows).offered;
  assert.deepEqual(summary.outcomes, { green: 1, red: 1, no_push: 0, unobserved: 0 });
  assert.deepEqual(summary.roundsToGreen, { [OFFERED_TASK]: 2 });
});

test("W1-T14138 criterion 4: a round whose push did not land records that it pushed nothing", async () => {
  const run = await fixRung({ corpus: CORPUS, landed: false });
  const outcomes = of(run, "fix.learnings_outcome");
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.conclusion, "no_push");
  assert.equal(outcomes[0]!.pushed_head_sha, undefined);
  assert.equal(outcomes[0]!.shadow_id, of(run, "fix.learnings_shadow")[0]!.shadow_id);
});

test("an unreadable corpus is recorded as a selection error, never as an empty match, and the round still runs", async () => {
  const run = await fixRung({ corpus: "- id: [unclosed\n" });
  const row = of(run, "fix.learnings_shadow")[0]!;
  assert.equal(row.matched, null);
  assert.match(String(row.selection_error), /not valid YAML/);
  assert.equal(run.prompts.length, 1);
  assert.equal(summarizeFixLearningsShadow(run.rows).offered.selectionErrors, 1);
});

test("selection reads unmet claims, findings and only the newest part of a log tail", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}fix-learnings-text-`));
  try {
    mkdirSync(join(root, "learnings"));
    writeFileSync(join(root, "learnings", "ci.yaml"), [
      lesson("by-claim", "  error_signatures: [CLAIM-SIG]\n"),
      lesson("by-mechanism", "  error_signatures: [MECHANISM-SIG]\n"),
      lesson("by-remedy", "  error_signatures: [REMEDY-SIG]\n"),
      lesson("by-old-log", "  error_signatures: [OLD-LOG-SIG]\n"),
    ].join("\n"));
    const round = recordFixLearningsShadow({
      taskId: OFFERED_TASK, runId: "r", prNumber: undefined, attempt: 1, round: "resume", repoDir: root, config: { root } as Config,
      priorRows: [],
      evidence: {
        ciFailures: [{ name: "c", logTail: `OLD-LOG-SIG${"x".repeat(FIX_LEARNINGS_LOG_TAIL_CHARS)}` }],
        review: {
          unmetCriteria: [{ ...criteria[0]!, claim: "CLAIM-SIG" }], summary: "",
          findings: [{ criterionIndex: 1, path: "a.ts", line: 1, mechanism: "MECHANISM-SIG", remedy: "REMEDY-SIG" }],
        },
      },
    });
    assert.deepEqual(matchedIds({ ...round.row, step: "fix.learnings_shadow" }), ["by-claim", "by-mechanism", "by-remedy"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const openRound = (priorRows: Array<Record<string, unknown>> = []): FixLearningsRound =>
  ({ row: { shadow_id: "s", task_id: "W1-T1", arm: "offered" }, priorRows });

test("only a push on a known head waits for CI, and only a conclusion on that head is recorded", () => {
  const unnamed = openRound();
  assert.equal(fixLearningsDoneConclusion(unnamed, { subtype: "commit_refused" }), undefined, "a row naming no round");
  assert.equal(fixLearningsDoneConclusion(unnamed, { round_id: "r1", push_outcome: "unverified" }), undefined);
  assert.deepEqual(unnamed.pushed, { head: undefined });
  assert.equal(fixLearningsCiConclusion(unnamed, "green", undefined), undefined);

  const round = openRound();
  assert.equal(fixLearningsCiConclusion(round, "green", undefined), undefined, "nothing pushed yet");
  assert.equal(fixLearningsDoneConclusion(round, { round_id: "r1", pushed_head_sha: "abc" }), undefined);
  assert.equal(fixLearningsDoneConclusion(round, { round_id: "r1" }), undefined, "a later row cannot undo the push");
  assert.equal(fixLearningsCiConclusion(round, "timeout", "abc"), undefined);
  assert.equal(fixLearningsCiConclusion(round, "freshness_handoff", "abc"), undefined);
  assert.equal(fixLearningsCiConclusion(round, "green", "def"), undefined);
  assert.equal(fixLearningsCiConclusion(round, "red", "abc"), "red");
  assert.equal(fixLearningsCiConclusion(round, "green", undefined), "green");
});

test("rounds to green joins this task's dispatched and pushed rounds from earlier runs and this one", () => {
  const earlier = [
    { step: "fix.dispatch", task_id: "W1-T1", round_id: "r1" },
    { step: "fix.done", task_id: "W1-T1", round_id: "r1", pushed_head_sha: "a" },
    { step: "fix.done", task_id: "W1-T1", round_id: "r2", pushed_head_sha: "b" },
    { step: "fix.done", task_id: "W1-T1", round_id: "r3" },
    { step: "fix.dispatch", task_id: "W1-T2", round_id: "other" },
    { step: "fix.dispatch", task_id: "W1-T1" },
  ];
  const round = { ...openRound(earlier), roundId: "r4" };
  const thisRung = [{ step: "fix.dispatch", task_id: "W1-T1", round_id: "r4" }];
  assert.equal(fixLearningsOutcomeRow(round, "green", thisRung).rounds_to_green, 3);
  assert.equal(fixLearningsOutcomeRow(round, "red", thisRung).rounds_to_green, undefined);
});

test("the summary reports match and outcome rates per arm, counting each round once", () => {
  const shadow = (id: string, arm: string, matched: unknown) => ({ step: "fix.learnings_shadow", shadow_id: id, task_id: id, arm, matched });
  const outcome = (id: string, conclusion: string) => ({ step: "fix.learnings_outcome", shadow_id: id, conclusion });
  const rows = [
    shadow("a", "offered", [{ id: "l", kinds: ["error"] }]),
    shadow("a", "offered", [{ id: "l", kinds: ["error"] }]),
    shadow("b", "offered", []),
    shadow("c", "offered", null),
    outcome("a", "red"), outcome("b", "no_push"),
  ];
  const summary = summarizeFixLearningsShadow(rows);
  assert.deepEqual(summary.offered, {
    rounds: 3, selectionErrors: 1, roundsWithMatch: 1, matchRate: { error: 0.5, symbol: 0 },
    outcomes: { green: 0, red: 1, no_push: 1, unobserved: 1 }, outcomeRates: { green: 0, red: 0.5, no_push: 0.5 },
    roundsToGreen: {},
  });
  assert.deepEqual(summary.withheld.matchRate, { error: null, symbol: null });
  assert.deepEqual(summary.withheld.outcomeRates, { green: null, red: null, no_push: null });
});
