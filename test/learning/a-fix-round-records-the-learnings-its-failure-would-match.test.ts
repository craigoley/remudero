import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { stringify } from "yaml";
import type { CiGateOutcome } from "#src/cli/commands/run-task-verb.js";
import { fixRoundReaderFor } from "#src/lib/adaptive-wip.js";
import type { Config } from "#src/lib/config.js";
import { summarizeFixLearningsShadow } from "#src/lib/fix-learnings-shadow.js";
import { buildLearningsIndex, DEFAULT_KNOWLEDGE_BUDGET_CHARS, loadLayeredLearningsForTaskFiles, selectLearnings } from "#src/lib/learnings.js";
import type { Mount } from "#src/lib/mounts.js";
import { renderFixPrompt } from "#src/lib/prompt-render.js";
import { runFixRung as runFixRungModule } from "#src/cli/commands/fix.js";
import { CODE_SCANNING_FIX_DISPATCH_STEP, codeScanningHeadSettled } from "#src/lib/sweep.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { withGhShim } from "#test/helpers/gh-shim.js";
import { fixCommandHost, harnessCommitForShellLessWorker, MERGE_UP_TO_DATE_REASON, runFixRung } from "#test/helpers/run-task-test.js";

const TASK = "W1-T14138";
const OTHER_TASK = "W1-T5";
const PR_URL = "https://github.com/acme/fixture/pull/42";
const PUSHED_HEAD = "b".repeat(40);
const FOREIGN_HEAD = "c".repeat(40);
const PATH = "src/example.ts";
const CHECK = { name: "checkParser", title: "parseTitle", logTail: "sample log\ntail signature 842" };
const TITLE = "repair the failing test";
const SECRET_FACT = "This learning's advice has no place in a fix prompt.";
const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 };
const WORKER: WorkerResult = {
  sessionId: "fixture", costUsd: 0, numTurns: 1, text: "REPORT\nFIX_OUTCOME: FIXED\nCOMMIT_MESSAGE: fix(ci): repair the check",
  blocks: [], stderr: "", subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
  model: "sonnet", effort: "medium", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {},
  compactionEvents: [], qualitySuspect: false,
};
const NEEDS_DESIGN_WORKER: WorkerResult = { ...WORKER, text: "REPORT\nFIX_OUTCOME: NEEDS_DESIGN the repair needs design" };

type Row = Record<string, unknown> & { step: string };

async function runRound(t: TestContext, options: {
  taskId?: string;
  runId?: string;
  corpus?: "invalid" | "path-only";
  /** A function receives the head the worktree started the rung at. */
  ci?: CiGateOutcome | "green" | ((startHead: string) => CiGateOutcome);
  noPush?: boolean;
  priorRows?: Row[];
  reviewEvidence?: boolean;
  /** One verdict per review the rung asks for; each runs a further round while it fails. */
  laterReviews?: ("failure" | "success")[];
  spawnEnd?: "superseded" | "abandoned" | "throws";
  workerHoldsGit?: boolean;
  workerPushesBeforeHandoff?: boolean;
  workerPushesThen?: "plan_filing_refusal" | "recycle_yield";
  /** The worker leaves HEAD naming a branch with no commit, then hands off. */
  workerLosesHead?: boolean;
  mergeRefused?: boolean;
  /** The round's push leaves the branch at the head it started from. */
  unchangedHead?: boolean;
  /** The round keeps its branch claim for the CI wait; defaults to `unchangedHead`. */
  claimKept?: boolean;
  /** The review names the worktree head's parent, as after a red CI on a pushed round. The remote branch then
   *  reads as that worktree head (adopted), a foreign head (superseded), the review head (unpublished), or
   *  throws once (unread). */
  staleReview?: "adopted" | "superseded" | "unpublished" | "unread";
  /** The merge-conflict round's merge finds main already in the branch. */
  mergeUpToDate?: boolean;
} = {}) {
  const taskId = options.taskId ?? TASK;
  const runId = options.runId ?? "shadow-fixture";
  const source = gitRepo({ kind: "fix-learnings", scope: t });
  const head = source.git("rev-parse", "HEAD");
  if (options.staleReview) source.git("commit", "--quiet", "--allow-empty", "-m", "an earlier round's push");
  const startHead = source.git("rev-parse", "HEAD");
  const workerOrigin = options.workerPushesBeforeHandoff || options.workerPushesThen
    ? gitRepo({ bare: true, scope: t, kind: "fix-learnings-worker-origin" }) : undefined;
  if (workerOrigin) {
    source.addRemote("origin", workerOrigin.dir);
    source.git("push", "--quiet", "origin", `${startHead}:refs/heads/run-${taskId}-1`);
  }
  let remoteUnread = options.staleReview === "unread";
  const project = join(source.dir, "repos", "fixture", "learnings");
  mkdirSync(project, { recursive: true });
  const entries = [
    { id: "check-symbol", symbols: ["checkParser"] },
    { id: "title-symbol", symbols: ["parseTitle"] },
    { id: "error-and-symbol", symbols: ["checkParser"], error_signatures: ["tail signature 842"] },
    { id: "file-only" },
    { id: "review-claim", symbols: ["claimSymbol"] },
    { id: "review-finding", symbols: ["findingSymbol"] },
    { id: "discarded", error_signatures: ["discarded error"] },
  ].filter(entry => options.corpus !== "path-only" || entry.id === "file-only")
    .map(entry => ({ fact: SECRET_FACT, src: "fixture", files: [PATH], ...entry }));
  writeFileSync(join(project, "ci.yaml"), options.corpus === "invalid" ? "[invalid" : stringify(entries));
  if (options.corpus !== "invalid") writeFileSync(join(project, "index.json"), JSON.stringify(buildLearningsIndex(project)));
  const prompts: string[] = [];
  const rows = [...(options.priorRows ?? [])];
  const failure = options.reviewEvidence ? { ...CHECK, logTail: `discarded error\n${"x".repeat(8_000)}\n${CHECK.logTail}` } : CHECK;
  if (options.reviewEvidence) rows.push(
    { step: "review.posted", task_id: taskId, pr_url: PR_URL, head_sha: head, state: "failure", decision_verdict: { criteria: [
      { claim: "claimSymbol is missing", proof: "unit test: fixture", met: false, reason: "missing", proof_exec: "not_executable" },
    ] } },
    { step: "review.finding", task_id: taskId, pr_url: PR_URL, head_sha: head, capture_state: "verified",
      finding_id: "d".repeat(64), criterion_index: 1, category: "fixture", severity: "medium",
      anchor: { status: "verified", kind: "changed", path: PATH, line: 1, evidenceDigest: "e".repeat(64) },
      mechanism: "findingSymbol rejects the input", remedy: null },
  );
  const review = {
    state: "failure" as const, criteria: [], testTheater: false, summary: "", floorDegraded: false, capped: false,
    keywordOnly: false, planOnly: false, headSha: head, reviewerOutcome: "failure",
  };
  let pushes = 0;
  let waits = 0;
  const landedHead = options.unchangedHead ? startHead : PUSHED_HEAD;
  const claimKept = options.claimKept ?? options.unchangedHead;
  const remoteHead = async () => {
    if (options.workerPushesThen) return workerOrigin!.git("rev-parse", `refs/heads/run-${taskId}-1`);
    if (pushes > 0 || !options.staleReview) return landedHead;
    if (remoteUnread) { remoteUnread = false; throw new Error("fixture ls-remote failed"); }
    return options.staleReview === "superseded" ? FOREIGN_HEAD : options.staleReview === "unpublished" ? head : startHead;
  };
  const conflict = options.mergeRefused || options.mergeUpToDate;
  const reviews = [...(options.laterReviews ?? [])];
  const rounds = Math.max(1, reviews.length);
  const stillUnmet = { claim: "claimSymbol is missing", proof: "unit test: fixture", met: false,
    reason: "the symbol is absent", proof_exec: "executed_fail" as const };
  const rungOptions = {
    taskId, runId, task: { id: taskId, title: TITLE,
      files: options.workerPushesThen === "plan_filing_refusal" ? ["plan/tasks.d/new.yaml"] : [PATH] },
    prUrl: PR_URL, branch: `run-${taskId}-1`, worktreePath: source.dir,
    initialSessionId: "fixture", mount: MOUNT, settingsFile: join(source.dir, "settings.json"),
    config: { root: source.dir, workerProviders: { harnessCommitsFix: !options.workerHoldsGit } } as Config,
    budgetUsd: 10, strikeCap: rounds, initialReview: review, ciFailures: [failure],
    reviewBase: { owner: "acme", repo: "fixture", headCheckoutDir: source.dir, reviewerMount: MOUNT },
    escalationJudge: async () => ({ decision: "deliver", reason: "fixture" }),
    ...(conflict ? { mergeConflict: { files: [{ path: PATH, oursDeleted: 0, theirsDeleted: 0 }],
      oursLog: "ours", theirsLog: "theirs" } } : {}),
    ...(options.staleReview ? { requiredContexts: [CHECK.name] } : {}),
    deps: {
      spawn: async ({ prompt }) => {
        prompts.push(prompt);
        if (options.spawnEnd === "throws") throw new Error("fixture worker died");
        if (options.workerPushesBeforeHandoff || options.workerPushesThen) {
          source.git("commit", "--quiet", "--allow-empty", "-m", "worker pushed before handoff");
          source.git("push", "--quiet", "origin", `HEAD:refs/heads/run-${taskId}-1`);
          return NEEDS_DESIGN_WORKER;
        }
        if (options.workerLosesHead) {
          source.git("symbolic-ref", "HEAD", "refs/heads/unborn");
          return NEEDS_DESIGN_WORKER;
        }
        return options.spawnEnd ? new Promise<WorkerResult>(() => {}) : WORKER;
      },
      ...(options.spawnEnd === "abandoned" ? { spawnWallClockBoundMs: 20, reclaimWorker: () => {} } : {}),
      ...(options.spawnEnd === "superseded" ? { watchSuperseded: async () => ({ kind: "superseded" as const,
        condition: "head-moved" as const, oldHead: head, newHead: FOREIGN_HEAD }) } : {}),
      ...(conflict ? { startShellLessMergeConflictMerge: () => ({ started: false,
        reason: options.mergeUpToDate ? MERGE_UP_TO_DATE_REASON : "fixture merge refusal" }) } : {}),
      ...(options.staleReview === "adopted" ? {
        readCiRollup: async () => [{ name: CHECK.name, status: "COMPLETED", conclusion: "FAILURE" }],
      } : {}),
      ...(claimKept ? { branchClaim: { id: () => "claim", release: () => {}, reacquire: () => undefined,
        last: () => { throw new Error("not read"); }, keepForWait: () => ({}) } } : {}),
      push: () => { pushes++; },
      readRemoteBranchHead: options.workerPushesThen
        ? async () => workerOrigin!.git("rev-parse", `refs/heads/run-${taskId}-1`) : remoteHead,
      waitForCiGreen: async () => {
        waits++;
        if (!options.workerPushesThen) assert.equal(rows.findLast(row => row.step === "fix.done")?.pushed_head_sha, landedHead);
        const sha = options.workerPushesThen ? workerOrigin!.git("rev-parse", `refs/heads/run-${taskId}-1`) : landedHead!;
        return typeof options.ci === "function" ? options.ci(startHead) : options.ci ?? { state: "green", sha };
      },
      runReview: async () => reviews.shift() === "failure"
        ? { ...review, criteria: [stillUnmet] } : { ...review, state: "success" },
      fetchPrBody: async () => "REPORT",
      fetchPrDiffFiles: async () => options.workerPushesThen === "plan_filing_refusal" ? ["plan/tasks.d/new.yaml"] : [PATH],
      ...(options.workerPushesThen === "plan_filing_refusal" ? { scopeAmendmentGit: async (_cwd: string, args: string[]) => {
        if (args[0] === "ls-tree") return "";
        if (args[0] === "show" && args[1]?.startsWith(`${head}:`)) {
          return `- id: ${taskId}\n  files: [plan/tasks.d/new.yaml]\n  acceptance: []\n`;
        }
        if (args[0] === "show") return "[]\n";
        return "";
      } } : {}),
      fetchCiFailures: async () => options.staleReview === "adopted" && pushes === 0 ? [CHECK] : [],
      issues: { create: () => "https://github.com/acme/fixture/issues/1", listOpen: () => [], comment: () => {} },
      ledgerPath: join(source.dir, "ledger.ndjson"), ledgerLines: () => rows,
      log: (step, extra) => { rows.push({ task_id: taskId, run_id: runId, pr_number: 42, step, ...extra }); },
      say: () => {}, account: result => result,
      worktreeHasUncommittedChanges: () => true,
      harnessCommitForShellLessWorker: input => harnessCommitForShellLessWorker(input, {
        commit: () => options.noPush ? { committed: false, reason: "fixture refused commit", undeclared: [] }
          : { committed: true, sha: landedHead, undeclared: [] }, ahead: () => 1,
      }),
    },
  };
  const recycleYieldHost = options.workerPushesThen === "recycle_yield" ? {
    ...fixCommandHost(),
    spawnFixWorkerBounded: async (deps: Parameters<ReturnType<typeof fixCommandHost>["spawnFixWorkerBounded"]>[0], args: Parameters<ReturnType<typeof fixCommandHost>["spawnFixWorkerBounded"]>[1]) => {
      const result = await deps.spawn(args);
      return { kind: "yielded" as const, elapsedMs: 1,
        yielded: { trigger: "recycle" as const, detail: "fixture recycle", paths: [], costUsd: result.costUsd ?? 0 } };
    },
  } : undefined;
  const run = () => withGhShim([{ when: "", stdout: "{}" }], () => recycleYieldHost
    ? runFixRungModule(rungOptions, recycleYieldHost)
    : runFixRung(rungOptions));
  if (options.spawnEnd === "throws") await assert.rejects(run, /fixture worker died/);
  else await run();
  if (!options.spawnEnd && !options.mergeRefused && !options.workerPushesThen) {
    assert.equal(prompts.length, options.staleReview === "superseded" ? 0 : rounds);
  }
  return { rows, project, prompt: prompts[0]!, pushes, waits, startHead,
    workerRemoteHead: workerOrigin?.git("rev-parse", `refs/heads/run-${taskId}-1`),
    steps: (step: string) => rows.filter(row => row.step === step) };
}

test("W1-T14138 criterion 1: records check and log matches once with a task-keyed arm", async t => {
  const first = await runRound(t);
  const next = await runRound(t, { runId: "shadow-fixture-3" });
  const other = await runRound(t, { taskId: OTHER_TASK });
  for (const round of [first, next, other]) {
    const rows = round.steps("fix.learnings_shadow");
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.ok(row);
    assert.equal(row.round_id, round.steps("fix.done")[0]?.round_id);
    assert.equal(row.attempt, 1);
    assert.equal(row.pr_number, 42);
    assert.equal(row.budget_chars, DEFAULT_KNOWLEDGE_BUDGET_CHARS);
    assert.deepEqual(row.failing_checks, [CHECK.name]);
    assert.deepEqual(row.matches, [
      { id: "error-and-symbol", kinds: ["symbol", "error"] },
      { id: "check-symbol", kinds: ["symbol"] },
      { id: "title-symbol", kinds: ["symbol"] },
    ]);
  }
  const arm = (round: Awaited<ReturnType<typeof runRound>>) => round.steps("fix.learnings_shadow")[0]?.arm;
  assert.equal(arm(next), arm(first));
  assert.deepEqual(new Set([arm(first), arm(other)]), new Set(["offered", "withheld"]));
});

test("W1-T14138 criterion 2: a path-only learning is excluded even when the diff and task name the path", async t => {
  const result = await runRound(t, { corpus: "path-only" });
  const { entries } = loadLayeredLearningsForTaskFiles({ projectDir: result.project }, [PATH]);
  assert.deepEqual(selectLearnings(entries, [PATH]).selected.map(entry => entry.id), ["file-only"]);
  const [shadow] = result.steps("fix.learnings_shadow");
  assert.ok(shadow);
  assert.deepEqual(shadow.matches, []);
});

function stablePrompt(prompt: string): string {
  const nonce = /<untrusted_external_data source="ci-log" boundary="([\w-]+)">/.exec(prompt)?.[1];
  assert.ok(nonce);
  assert.ok(prompt.includes(`</untrusted_external_data boundary="${nonce}">`));
  return prompt.replaceAll(` boundary="${nonce}">`, ' boundary="FIXTURE">');
}

test("W1-T14138 criterion 3: the worker sees the same prompt bytes in both arms", async t => {
  for (const [taskId, arm] of [[TASK, "offered"], [OTHER_TASK, "withheld"]]) {
    const withCorpus = await runRound(t, { taskId });
    const original = renderFixPrompt({ task: { id: taskId, title: TITLE, files: [PATH] }, branch: `run-${taskId}-1`,
      harnessCommits: true, baselineDiffFiles: [PATH], round: 1, evidence: { ciFailures: [CHECK] } });
    assert.equal(stablePrompt(withCorpus.prompt), stablePrompt(original));
    const [shadow] = withCorpus.steps("fix.learnings_shadow");
    assert.equal(shadow?.arm, arm);
    assert.ok(Array.isArray(shadow.matches) && shadow.matches.length > 0);
  }
});

test("review claims and findings match against the evidence and the discarded log prefix stays out", async t => {
  const result = await runRound(t, { reviewEvidence: true });
  const [shadow] = result.steps("fix.learnings_shadow");
  assert.deepEqual(shadow?.matches, [
    { id: "error-and-symbol", kinds: ["symbol", "error"] },
    { id: "check-symbol", kinds: ["symbol"] },
    { id: "review-claim", kinds: ["symbol"] },
    { id: "review-finding", kinds: ["symbol"] },
    { id: "title-symbol", kinds: ["symbol"] },
  ]);
});

test("W1-T14138 criterion 4: records CI green or red on the round's pushed head, or no push", async t => {
  for (const expected of ["green", "red", "no_push"] as const) {
    const ci = expected === "no_push" ? undefined : { state: expected, sha: PUSHED_HEAD };
    const earlier = { task_id: TASK, run_id: "earlier", round_id: "earlier:1:1", pr_number: 42 };
    const priorRows = [{ ...earlier, step: "fix.dispatch" }, { ...earlier, step: "fix.done" }];
    const result = await runRound(t, { ci, noPush: expected === "no_push", priorRows });
    assert.equal(result.pushes, expected === "no_push" ? 0 : 1);
    assert.equal(result.waits, result.pushes);
    const outcomes = result.steps("fix.learnings_outcome");
    assert.equal(outcomes.length, 1);
    const [outcome] = outcomes;
    assert.ok(outcome);
    assert.equal(outcome.outcome, expected);
    assert.equal(outcome.pushed_head_sha, expected === "no_push" ? undefined : PUSHED_HEAD);
    assert.equal(outcome.round_id, result.steps("fix.done").at(-1)?.round_id);
    assert.equal(outcome.rounds_to_green, expected === "green" ? 2 : undefined);
  }
});

test("W1-T14138 criterion 1: a review round after a green CI records none of the earlier round's reds", async t => {
  const result = await runRound(t, { ci: "green", laterReviews: ["failure", "success"] });
  const [first, second, ...rest] = result.steps("fix.learnings_shadow");
  assert.equal(rest.length, 0);
  assert.deepEqual(first?.failing_checks, [CHECK.name]);
  assert.equal(result.steps("fix.dispatch")[1]?.mode, "reviewer-unmet");
  assert.deepEqual(second?.failing_checks, []);
  assert.deepEqual(second?.matches, [{ id: "review-claim", kinds: ["symbol"] }]);
});

test("W1-T14138 criterion 1: an iteration that starts no worker writes no shadow row, so one attempt is one round", async t => {
  // Each early exit before the worker: an adopted published head, an up-to-date merge, a superseded head.
  for (const [name, options, exit] of [
    ["adopted head", { staleReview: "adopted" }, "fix.evidence_head_adopted"],
    ["up-to-date merge", { mergeUpToDate: true }, "fix.merge_mode_cleared"],
  ] as const) {
    const result = await runRound(t, options);
    assert.equal(result.steps(exit).length, 1, name);
    const dispatched = result.steps("fix.dispatch").map(row => row.round_id);
    assert.equal(dispatched.length, 1, name);
    assert.deepEqual(result.steps("fix.learnings_shadow").map(row => row.round_id), dispatched, name);
    assert.deepEqual(result.steps("fix.learnings_shadow").map(row => row.attempt), [1], name);
    assert.deepEqual(result.steps("fix.learnings_outcome").map(row => [row.round_id, row.outcome]),
      [[dispatched[0], "green"]], name);
    const summary = summarizeFixLearningsShadow(result.rows);
    assert.equal(summary.offered.rounds + summary.withheld.rounds, 1, name);
  }
  const superseded = await runRound(t, { staleReview: "superseded" });
  assert.equal(superseded.steps("fix.evidence_head_superseded").length, 1);
  assert.equal(superseded.steps("fix.learnings_shadow").length, 0);
  assert.equal(superseded.steps("fix.learnings_outcome").length, 0);
});

test("W1-T14138 criterion 4: re-pushing the head the round started from is no push, not an earlier round's CI", async t => {
  // The review still names the head before an earlier round's push; the round changes nothing and CI is red on it.
  for (const claimKept of [false, true]) {
    const result = await runRound(t, { staleReview: "unread", unchangedHead: true, claimKept,
      ci: startHead => ({ state: "red", sha: startHead }) });
    assert.equal(result.steps("fix.evidence_head_unread").length, 1);
    assert.equal(result.steps("fix.done")[0]?.pushed_head_sha, result.startHead);
    const outcomes = result.steps("fix.learnings_outcome");
    assert.deepEqual(outcomes.map(row => [row.outcome, row.pushed_head_sha]), [["no_push", undefined]], String(claimKept));
    assert.equal(outcomes[0]?.round_id, result.steps("fix.learnings_shadow")[0]?.round_id);
  }
  // A local advance the remote read proves unpublished is still this round's own push.
  const unpublished = await runRound(t, { staleReview: "unpublished", unchangedHead: true,
    ci: startHead => ({ state: "red", sha: startHead }) });
  assert.deepEqual(unpublished.steps("fix.learnings_outcome").map(row => [row.outcome, row.pushed_head_sha]),
    [["red", unpublished.startHead]]);
});

test("W1-T14138 criterion 4: a round whose worker is superseded, abandoned or dies pushed nothing", async t => {
  for (const spawnEnd of ["superseded", "abandoned", "throws"] as const) {
    const result = await runRound(t, { spawnEnd });
    assert.equal(result.pushes, 0, spawnEnd);
    const outcomes = result.steps("fix.learnings_outcome");
    assert.deepEqual(outcomes.map(row => row.outcome), ["no_push"], spawnEnd);
    assert.equal(outcomes[0]?.round_id, result.steps("fix.learnings_shadow")[0]?.round_id, spawnEnd);
  }
});

test("W1-T14138 criterion 4: a worker-owned push before NEEDS_DESIGN stays unresolved without its CI", async t => {
  const result = await runRound(t, { workerHoldsGit: true, workerPushesBeforeHandoff: true });
  assert.equal(result.steps("fix.done").length, 1);
  assert.equal(result.steps("fix.done")[0]?.pushed_head_sha, undefined);
  assert.notEqual(result.workerRemoteHead, result.startHead);
  assert.equal(result.steps("fix.learnings_outcome").length, 0);
});

test("W1-T14138 criterion 4: early plan-filing refusal and recycle yield attribute a worker push to its remote head", async t => {
  for (const exit of ["plan_filing_refusal", "recycle_yield"] as const) {
    const result = await runRound(t, { workerHoldsGit: true, workerPushesThen: exit });
    const remoteHead = result.workerRemoteHead;
    assert.ok(remoteHead && remoteHead !== result.startHead, exit);
    const outcomes = result.steps("fix.learnings_outcome");
    assert.equal(outcomes.length, 1, exit);
    assert.deepEqual([outcomes[0]?.outcome, outcomes[0]?.pushed_head_sha], ["green", remoteHead], exit);
    assert.equal(result.waits, 1, exit);
  }
});

test("W1-T14138 criterion 4: a worker-owned head that cannot be read leaves the round unresolved", async t => {
  const result = await runRound(t, { workerHoldsGit: true, workerLosesHead: true });
  assert.equal(result.steps("fix.done").length, 1);
  assert.equal(result.steps("fix.evidence_head_unread").length, 1);
  assert.equal(result.steps("fix.learnings_shadow").length, 1);
  assert.equal(result.steps("fix.learnings_outcome").length, 0);
});

test("a worker that holds its own git and may still be running leaves the round unresolved", async t => {
  for (const spawnEnd of ["superseded", "abandoned", "throws"] as const) {
    const result = await runRound(t, { spawnEnd, workerHoldsGit: true });
    assert.equal(result.steps("fix.learnings_shadow").length, 1, spawnEnd);
    assert.equal(result.steps("fix.learnings_outcome").length, 0, spawnEnd);
  }
});

test("W1-T14138 criterion 4: a push that leaves the head unchanged is no push, even with the claim kept", async t => {
  const result = await runRound(t, { unchangedHead: true });
  assert.equal(result.waits, 1);
  assert.equal(result.steps("fix.done")[0]?.ci_wait_holds_claim, true);
  assert.deepEqual(result.steps("fix.learnings_outcome").map(row => row.outcome), ["no_push"]);
});

test("W1-T14138 criterion 4: the measurement rows never change how a code-scanning round's end is read", async t => {
  for (const [name, options, settled] of [
    ["refused commit", { noPush: true }, false],
    ["unchanged head", { unchangedHead: true }, false],
    ["superseded worker", { spawnEnd: "superseded" }, true],
  ] as const) {
    const result = await runRound(t, options);
    const head = result.rows.find(row => row.step.startsWith("fix.") && typeof row.head_sha === "string")?.head_sha;
    assert.equal(typeof head, "string", name);
    const intent = { step: CODE_SCANNING_FIX_DISPATCH_STEP, run_id: "shadow-fixture", task_id: TASK,
      pr_number: 42, head_sha: head };
    const read = (rows: Row[]) => codeScanningHeadSettled([intent, ...rows], 42, String(head));
    const without = result.rows.filter(row => !row.step.startsWith("fix.learnings_"));
    assert.ok(without.length < result.rows.length, name);
    assert.equal(read(without), settled, name);
    assert.equal(read(result.rows), settled, name);
  }
});

test("a refused merge keeps its round-id marker on every row, and its prompt's evidence names no check", async t => {
  const result = await runRound(t, { mergeRefused: true });
  const roundId = String(result.steps("fix.dispatch")[0]?.round_id);
  assert.match(roundId, /^shadow-fixture:merge-refused:1:\d+$/);
  for (const step of ["fix.done", "fix.learnings_shadow", "fix.learnings_outcome"]) {
    assert.deepEqual(result.steps(step).map(row => row.round_id), [roundId], step);
  }
  assert.deepEqual(result.steps("fix.learnings_shadow")[0]?.failing_checks, []);
  assert.deepEqual(result.steps("fix.learnings_shadow")[0]?.matches, []);
  const read = fixRoundReaderFor(result.rows.map(row => ({ ...row, ts: new Date(1_000).toISOString() })));
  assert.deepEqual(read(0)?.refusedCauses, { merge_refused: 1 });
});

test("the summary keeps unreadable corpora and unresolved CI out of the rate denominators", async t => {
  const offered = await runRound(t);
  const unavailable = await runRound(t, { runId: "invalid-corpus", corpus: "invalid", ci: { state: "timeout" } });
  const withheld = await runRound(t, { taskId: OTHER_TASK, corpus: "path-only", noPush: true });
  const missing = unavailable.steps("fix.learnings_shadow")[0];
  assert.equal(missing?.selection, "unavailable");
  assert.match(String(missing?.reason), /not valid YAML/);
  const summary = summarizeFixLearningsShadow([...offered.rows, ...unavailable.rows, ...withheld.rows, ...offered.rows]);
  assert.deepEqual(summary, {
    offered: { rounds: 2, measured: 1, matched: 1, concluded: 1, matchRate: { symbol: 1, error: 1 },
      outcomeRate: { green: 1, red: 0, no_push: 0 } },
    withheld: { rounds: 1, measured: 1, matched: 0, concluded: 1, matchRate: { symbol: 0, error: 0 },
      outcomeRate: { green: 0, red: 0, no_push: 1 } },
  });
  assert.deepEqual(summarizeFixLearningsShadow([]).offered.outcomeRate, { green: null, red: null, no_push: null });
});

test("CI from a foreign head, a timeout, or a verdict without a SHA cannot conclude the round", async t => {
  for (const ci of [{ state: "green", sha: FOREIGN_HEAD }, { state: "timeout", sha: PUSHED_HEAD }, "green"] as const) {
    const result = await runRound(t, { ci });
    assert.equal(result.pushes, 1);
    assert.equal(result.steps("fix.learnings_outcome").length, 0);
  }
});
