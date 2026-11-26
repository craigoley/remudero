import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { stringify } from "yaml";
import type { CiGateOutcome } from "#src/cli/commands/run-task-verb.js";
import type { Config } from "#src/lib/config.js";
import { summarizeFixLearningsShadow } from "#src/lib/fix-learnings-shadow.js";
import { buildLearningsIndex, DEFAULT_KNOWLEDGE_BUDGET_CHARS, loadLayeredLearningsForTaskFiles, selectLearnings } from "#src/lib/learnings.js";
import type { Mount } from "#src/lib/mounts.js";
import { renderFixPrompt } from "#src/lib/prompt-render.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { withGhShim } from "#test/helpers/gh-shim.js";
import { harnessCommitForShellLessWorker, runFixRung } from "#test/helpers/run-task-test.js";

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

type Row = Record<string, unknown> & { step: string };

async function runRound(t: TestContext, options: {
  taskId?: string;
  runId?: string;
  corpus?: "invalid" | "path-only";
  ci?: CiGateOutcome | "green";
  noPush?: boolean;
  priorRows?: Row[];
  reviewEvidence?: boolean;
} = {}) {
  const taskId = options.taskId ?? TASK;
  const runId = options.runId ?? "shadow-fixture";
  const source = gitRepo({ kind: "fix-learnings", scope: t });
  const head = source.git("rev-parse", "HEAD");
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
  await withGhShim([{ when: "", stdout: "{}" }], () => runFixRung({
    taskId, runId, task: { id: taskId, title: TITLE, files: [PATH] },
    prUrl: PR_URL, branch: `run-${taskId}-1`, worktreePath: source.dir,
    initialSessionId: "fixture", mount: MOUNT, settingsFile: join(source.dir, "settings.json"),
    config: { root: source.dir, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 1, initialReview: review, ciFailures: [failure],
    reviewBase: { owner: "acme", repo: "fixture", headCheckoutDir: source.dir, reviewerMount: MOUNT },
    deps: {
      spawn: async ({ prompt }) => { prompts.push(prompt); return WORKER; },
      push: () => { pushes++; },
      readRemoteBranchHead: async () => PUSHED_HEAD,
      waitForCiGreen: async () => {
        waits++;
        assert.equal(rows.findLast(row => row.step === "fix.done")?.pushed_head_sha, PUSHED_HEAD);
        return options.ci ?? { state: "green", sha: PUSHED_HEAD };
      },
      runReview: async () => ({ ...review, state: "success" }),
      fetchPrBody: async () => "REPORT",
      fetchPrDiffFiles: async () => [PATH],
      fetchCiFailures: async () => [],
      issues: { create: () => "https://github.com/acme/fixture/issues/1", listOpen: () => [], comment: () => {} },
      ledgerPath: join(source.dir, "ledger.ndjson"), ledgerLines: () => rows,
      log: (step, extra) => { rows.push({ task_id: taskId, run_id: runId, pr_number: 42, step, ...extra }); },
      say: () => {}, account: result => result,
      worktreeHasUncommittedChanges: () => true,
      harnessCommitForShellLessWorker: input => harnessCommitForShellLessWorker(input, {
        commit: () => options.noPush ? { committed: false, reason: "fixture refused commit", undeclared: [] }
          : { committed: true, sha: PUSHED_HEAD, undeclared: [] }, ahead: () => 1,
      }),
    },
  }));
  assert.equal(prompts.length, 1);
  return { rows, project, prompt: prompts[0]!, pushes, waits, steps: (step: string) => rows.filter(row => row.step === step) };
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
