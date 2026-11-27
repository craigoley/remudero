// W1-T15064: a fix round never edits source to answer a red step the base already carries, and never rewrites an
// existing test's expectation unless the finding it answers names that test. On core #21035, round 1835b8af3
// answered inherited expiring-fixture-census crossings by loosening `=== false` to `!== true` in src/lib/inbox.ts.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// @ts-expect-error -- plain .mjs script, no type declarations
import { emitCiReport, formatReport, isBlocked, proveNearCrossings, refusePopulationDrop } from "#scripts/expiring-fixture-census.mjs";
import { runFixRung as runFixRungWithHost, type FixCommandHost } from "#src/cli/commands/fix.js";
import {
  BASE_INHERITED_MARKER, answeredFindingText, baseInheritedRedSteps, readExpectationRewrites, rewrittenTestExpectations,
  unaskedExpectationRewrites,
} from "#src/lib/ci-remedy-execution.js";
import type { FixSelfCheckRunResult } from "#src/lib/fix-self-check.js";
import { hostWorktreeGitAsync } from "#src/lib/worktree-git.js";
import type { Config } from "#src/lib/config.js";
import type { ReviewVerdict } from "#src/lib/review.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { fixCommandHost } from "#test/helpers/run-task-test.js";

const mount = { model: "sonnet", effort: "medium" as const, maxTurns: 20, contextBudget: 120000 };
const SOURCE = "src/inbox.ts";
const TEST = "test/inbox.test.ts";
const GUARDED = "export const released = (r?: (id: string) => boolean) => r?.(\"x\") === false;\n";
const LOOSENED = "export const released = (r?: (id: string) => boolean) => r?.(\"x\") !== true;\n";
const EXPECT = "import assert from \"node:assert/strict\";\nassert.equal(released(undefined), false);\n";
const REWRITTEN = "import assert from \"node:assert/strict\";\nassert.equal(released(undefined), true);\n";

const NOW = Date.parse("2026-11-27T00:00:00Z");
const DAY = 86_400_000;

/** One reported crossing, as censusExpiringFixtures records it. */
const crossing = (file: string, daysLeft: number, inherited: boolean) => ({ file, line: 12, field: "ts", threshold: "7d",
  stamp: new Date(NOW - (7 - daysLeft) * DAY).toISOString(), expiresAt: NOW + daysLeft * DAY, daysLeft, inherited });

/** What the census step prints, by its own producers, as census main() runs them with RMD_CI_REPORT set: the report on
 *  stdout, then its `::error` annotation. Near crossings get the shifted-run verdict `confirmed`, so an all-inherited
 *  report still blocks — the case core #21035 hit. */
function censusLog(reported: ReturnType<typeof crossing>[], drops: Record<string, number> = {}) {
  proveNearCrossings(reported, (files: string[], days: number) => new Map(files.map((file) =>
    [file, days > 1 ? { passed: false, pass: 3, tests: 5 } : { passed: true, pass: 5, tests: 5 }])), 0);
  const populationDrop = refusePopulationDrop(drops, Object.fromEntries(Object.keys(drops).map((file) => [file, 9])));
  const report = formatReport({ population: 9, reported, exempt: [], populationDrop });
  const lines: string[] = [];
  lines.push(report);
  const blocked = isBlocked({ reported, populationDrop });
  emitCiReport("expiring-fixture-census", report, { blocked, env: { RMD_CI_REPORT: "1" }, log: (line: string) => lines.push(line) });
  return { blocked, log: lines.join("\n") };
}

/** The same log as the Actions job log reads it back: every line stamped with its time. */
const stamped = (log: string) => log.split("\n").map((line) => `2026-11-27T00:00:01.0000000Z ${line}`).join("\n");

const inherited = censusLog([crossing("test/a.test.ts", 0.4, true), crossing("test/b.test.ts", 0.6, true)]);
const inheritedLog = inherited.log;

interface RoundOptions {
  /** A reviewer-unmet round's last review; without one the round answers `ciFailures` in ci-log mode. */
  criteria?: ReviewVerdict["criteria"];
  acceptance?: Array<{ claim: string; proof: string }>;
  /** The self-check's transcripts, one per check; given, the round self-checks before its push. */
  selfChecks?: string[];
  /** The worker answers NEEDS_SCOPE for this undeclared path, so the round pushes only its in-scope repair. */
  needsScope?: string;
}

/** Every scope-amendment write refuses: the shard is never found, so a NEEDS_SCOPE round escalates. */
function refusedScopeWrites(repoDir: string) {
  const write = () => assert.fail("the scope amendment should be refused before a write");
  return { repoDir, findShard: () => undefined, lookupIdentity: () => undefined, probeExisting: () => undefined,
    worktreePathFor: write, worktreeAdd: write, worktreeRemove: write, writeFile: write, gitAdd: write, gitCommit: write,
    gitPush: write, createPr: write, recordIdentity: write, updateBranch: write };
}

async function round(ciFailures: Array<{ name: string; logTail: string }> | undefined, edit: (dir: string, turn: number) => void,
  options: RoundOptions = {}) {
  const repo = gitRepo({ kind: "w1-t15064" });
  repo.git("config", "user.name", "fixture");
  repo.git("config", "user.email", "fixture@example.invalid");
  mkdirSync(join(repo.dir, "src"));
  mkdirSync(join(repo.dir, "test"));
  writeFileSync(join(repo.dir, SOURCE), GUARDED);
  writeFileSync(join(repo.dir, TEST), EXPECT);
  repo.git("add", "src", "test");
  repo.git("commit", "-qm", "seed");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const before = repo.git("rev-parse", "HEAD");
  const rows: Array<{ step: string } & Record<string, unknown>> = [];
  let spawns = 0, pushes = 0, issues = 0;
  const review: ReviewVerdict & { headSha: string; reviewerOutcome: string } = {
    state: "failure", criteria: options.criteria ?? [], summary: `checks red; ${TEST} stays green`, testTheater: false, floorDegraded: false, capped: false,
    keywordOnly: false, planOnly: false, headSha: before, reviewerOutcome: "failure",
  };
  const transcripts = [...(options.selfChecks ?? [])];
  const host: FixCommandHost = { ...fixCommandHost(), ...(options.selfChecks ? {
    runFixSelfCheck: async (): Promise<FixSelfCheckRunResult> => ({ transcript: transcripts.shift() ?? "" }) } : {}) };
  const outcome = await runFixRungWithHost({
    taskId: "W1-T15064X", runId: "W1-T15064X-run",
    task: { id: "W1-T15064X", title: "inbox released asks", files: [SOURCE, TEST], catalog: "ops" as const,
      ...(options.acceptance ? { acceptance: options.acceptance } : {}) },
    prUrl: "https://github.com/acme/remudero/pull/21035", branch: "run-W1-T15064X-1",
    worktreePath: repo.dir, initialSessionId: "initial", mount, settingsFile: join(repo.dir, "settings.json"),
    config: { root: repo.dir, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 1, initialReview: review, ...(ciFailures ? { ciFailures } : {}),
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: repo.dir, reviewerMount: mount },
    escalationJudge: async () => ({ decision: "deliver", reason: "fixture delivers" }),
    deps: {
      spawn: async () => {
        spawns++;
        edit(repo.dir, spawns);
        return {
          sessionId: "fix-session", costUsd: 0, numTurns: 1, provider: "codex",
          text: options.needsScope ? `FIX_OUTCOME: NEEDS_SCOPE ${options.needsScope}` : "COMMIT_MESSAGE: fix(inbox): answer the red check",
          blocks: [], stderr: "", subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
          model: "sonnet", effort: "medium", tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
          modelUsage: {}, compactionEvents: [], qualitySuspect: false,
        } satisfies WorkerResult;
      },
      waitForCiGreen: async () => "green",
      runReview: async () => ({ ...review, state: "success", criteria: [], headSha: repo.git("rev-parse", "HEAD"), reviewerOutcome: "success" }),
      fetchPrBody: async () => "Remudero-Task: W1-T15064X",
      fetchPrDiffFiles: async () => [SOURCE],
      scopeAmendmentWritePorts: refusedScopeWrites(repo.dir),
      readHeadShaForProvenance: () => repo.git("rev-parse", "HEAD"),
      push: () => { pushes++; },
      issues: { create: () => { issues++; return "https://github.com/acme/remudero/issues/1"; }, listOpen: () => [], comment: () => {} },
      ledgerPath: join(repo.dir, "ledger.ndjson"),
      log: (step: string, extra?: Record<string, unknown>) => { rows.push({ step, ...extra }); }, say: () => {},
      account: (result: WorkerResult) => result,
    },
  } as Parameters<typeof runFixRungWithHost>[0], host);
  return { repo, before, outcome, rows, spawns, pushes, issues: () => issues };
}

const loosenAndRewrite = (dir: string) => {
  writeFileSync(join(dir, SOURCE), LOOSENED);
  writeFileSync(join(dir, TEST), REWRITTEN);
};

test("W1-T15064 criterion 1: an all-inherited red step dispatches no source edit", async (t) => {
  const result = await round([{ name: "comment-load-ratchet", logTail: inheritedLog }], loosenAndRewrite);
  t.after(() => result.repo.cleanup());
  assert.equal(result.spawns, 0, "no worker is dispatched to edit source for a base-inherited red step");
  assert.equal(result.pushes, 0);
  assert.equal(result.outcome.outcome, "stood_down");
  assert.equal(result.repo.git("rev-parse", "HEAD"), result.before);
  const why = result.rows.find((row) => row.step === "fix.stood_down" && row.reason === "base_inherited");
  assert.deepEqual(why?.steps, ["comment-load-ratchet"], "the stand-down records why, naming the step");
  // The marker is the one the census really prints.
  assert.equal(readFileSync(join(REPO_ROOT, "scripts/expiring-fixture-census.mjs"), "utf8").includes(BASE_INHERITED_MARKER), true);
  assert.equal(inherited.blocked, true, "the census blocks on its confirmed near crossings even though the base owns them");
  assert.match(inheritedLog, /^::error title=expiring-fixture-census::expiring-fixture-census: BLOCKED -- 2 fixture\(s\) CROSS/m);
  // The same report read back three ways: the job log with its timestamps, the runner's rendering of the annotation,
  // and the annotation message alone, which is what a log read that falls back to annotations carries.
  const rendered = stamped(inheritedLog.replace(/^::error title=expiring-fixture-census::/m, "##[error]"));
  const reportOnly = inheritedLog.split("\n::error")[0]!;
  for (const logTail of [stamped(inheritedLog), rendered, reportOnly, `${rendered}\n##[error]Process completed with exit code 1.`]) {
    assert.equal(baseInheritedRedSteps([{ name: "light-gates", logTail }]).inherited, true, logTail.slice(0, 200));
  }
  // Any doubt dispatches as before: a crossing the diff planted, a population drop the base is not charged with,
  // another failure in the log, another error annotation, or no failure at all.
  const planted = censusLog([crossing("test/a.test.ts", 0.4, true), crossing("test/b.test.ts", 0.6, false)]);
  assert.equal(planted.blocked, true);
  assert.equal(baseInheritedRedSteps([{ name: "light-gates", logTail: planted.log }]).inherited, false);
  const dropped = censusLog([crossing("test/a.test.ts", 0.4, true)], { "test/c.test.ts": 4 });
  assert.match(dropped.log, /dropped below the recorded fixture population/);
  assert.equal(baseInheritedRedSteps([{ name: "light-gates", logTail: dropped.log }]).inherited, false);
  assert.equal(baseInheritedRedSteps([{ name: "light-gates", logTail: stamped(dropped.log) }]).inherited, false);
  const dropOnly = censusLog([], { "test/c.test.ts": 4 });
  assert.equal(baseInheritedRedSteps([{ name: "light-gates", logTail: dropOnly.log }]).inherited, false);
  assert.equal(baseInheritedRedSteps([{ name: "light-gates", logTail: `${inheritedLog}\nnot ok 3 - inbox` }]).inherited, false);
  assert.equal(baseInheritedRedSteps([{ name: "light-gates", logTail: `${rendered}\n##[error]tsc: 2 errors` }]).inherited, false);
  assert.equal(baseInheritedRedSteps([{ name: "light-gates", logTail: inheritedLog },
    { name: "unit", logTail: "✖ inbox released asks" }]).inherited, false);
  assert.equal(baseInheritedRedSteps([]).inherited, false);
});

test("W1-T15064 criterion 1: a red step this diff owns still dispatches its source edit", async (t) => {
  const result = await round([{ name: "unit", logTail: "✖ inbox guard\n    at released (src/inbox.ts:1:1)" }],
    (dir) => writeFileSync(join(dir, SOURCE), `${GUARDED}// repaired\n`));
  t.after(() => result.repo.cleanup());
  assert.equal(result.spawns, 1);
  assert.equal(result.pushes, 1);
  assert.equal(result.rows.some((row) => row.reason === "base_inherited"), false);
});

test("W1-T15064 criterion 2: a changed test expectation is refused unless its finding names the test", async (t) => {
  // The finding names the source only: the rewritten assertion in test/inbox.test.ts is refused and nothing is pushed.
  const refused = await round([{ name: "unit", logTail: "✖ inbox guard\n    at released (src/inbox.ts:1:1)" }], loosenAndRewrite);
  t.after(() => refused.repo.cleanup());
  assert.equal(refused.spawns, 1);
  assert.equal(refused.pushes, 0, "the round that rewrote an unnamed test's expectation does not push");
  assert.equal(refused.outcome.outcome, "stood_down");
  const row = refused.rows.find((r) => r.step === "fix.commit_refused" && r.reason === "the round changed a test expectation the answered finding does not name");
  assert.deepEqual(row?.tests, [TEST]);
  assert.deepEqual(row?.changed_assertions, ["assert.equal(released(undefined), false)"]);
  // The finding names the test: the same rewrite is the asked-for repair and is pushed.
  const named = await round([{ name: "unit", logTail: `✖ inbox guard\n    at (${TEST}:2:8)\n    at released (src/inbox.ts:1:1)` }], loosenAndRewrite);
  t.after(() => named.repo.cleanup());
  assert.equal(named.pushes, 1);
  // A new assertion beside the existing ones changes no expectation.
  assert.deepEqual(rewrittenTestExpectations([{ path: TEST, base: EXPECT, head: `${EXPECT}assert.equal(released(() => false), true);\n` }]), []);
  // A multi-line expectation is compared whole, and a match by file name counts as naming the test.
  const multi = rewrittenTestExpectations([{ path: TEST, base: "assert.deepEqual(rows,\n  [1, 2]);\n", head: "assert.deepEqual(rows,\n  [1]);\n" }]);
  assert.deepEqual(multi, [{ path: TEST, changed: ["assert.deepEqual(rows, [1, 2])"] }]);
  assert.deepEqual(unaskedExpectationRewrites(multi, "fails in inbox.test.ts"), []);
  assert.deepEqual(unaskedExpectationRewrites(multi, "fails in src/inbox.ts"), multi);
});

const REFUSAL = "the round changed a test expectation the answered finding does not name";
const refusalOf = (rows: Array<{ step: string } & Record<string, unknown>>) =>
  rows.find((row) => row.step === "fix.commit_refused" && row.reason === REFUSAL);
const UNMET = { claim: "released asks the reference", proof: "unit test: released asks the reference" };
/** The source criterion is unmet; the one criterion that names the test passed, so the round is not asked about it. */
const reviewed: ReviewVerdict["criteria"] = [
  { ...UNMET, met: false, reason: "released(undefined) is true", proof_exec: "not_executable" },
  { claim: "the inbox suite stays green", proof: `unit test: ${TEST}`, met: true, reason: "passed", proof_exec: "not_executable" },
];
const acceptance = reviewed.map(({ claim, proof }) => ({ claim, proof }));

test("W1-T15064 criterion 2: a met criterion or the review summary naming the test is not asked of the round", async (t) => {
  const result = await round(undefined, loosenAndRewrite, { criteria: reviewed, acceptance });
  t.after(() => result.repo.cleanup());
  assert.equal(result.spawns, 1);
  assert.equal(result.pushes, 0, "only the unmet criterion is answered, and it names no test");
  assert.deepEqual(refusalOf(result.rows)?.tests, [TEST]);
  const evidence = { review: { unmetCriteria: [reviewed[0]!], summary: `${TEST} stays green`,
    metCriteria: [{ criterionIndex: 2, claim: reviewed[1]!.claim, proof: reviewed[1]!.proof }] } };
  const rewrites = [{ path: TEST, changed: ["assert.equal(released(undefined), false)"] }];
  assert.deepEqual(unaskedExpectationRewrites(rewrites, answeredFindingText(evidence)), rewrites);
  assert.deepEqual(unaskedExpectationRewrites(rewrites, answeredFindingText({ review: { unmetCriteria: [reviewed[1]!] } })), []);
  assert.deepEqual(unaskedExpectationRewrites(rewrites, answeredFindingText({ review: { unmetCriteria: [],
    findings: [{ path: TEST, line: 2, mechanism: "asserts the old default", remedy: null }] } })), []);
  assert.deepEqual(unaskedExpectationRewrites(rewrites, answeredFindingText({ mergeConflict: { files: [{ path: TEST }] } })), []);
});

test("W1-T15064 criterion 2: a NEEDS_SCOPE round's partial push is refused when it rewrites an unnamed test", async (t) => {
  const edits = (dir: string) => { loosenAndRewrite(dir); writeFileSync(join(dir, "src/refused.ts"), "export {};\n"); };
  const result = await round([{ name: "unit", logTail: "✖ inbox guard\n    at released (src/inbox.ts:1:1)" }], edits,
    { needsScope: "src/refused.ts" });
  t.after(() => result.repo.cleanup());
  assert.equal(result.spawns, 1);
  assert.equal(result.pushes, 0, "the in-scope repair rewrote test/inbox.test.ts, so it is not pushed");
  const refusal = refusalOf(result.rows);
  assert.deepEqual(refusal?.tests, [TEST]);
  assert.notEqual(refusal?.round_head_sha, result.before, "the guard read the partial repair's own commit");
});

test("W1-T15064 criterion 2: the guard reads the head the self-check's extra turn committed", async (t) => {
  const turns = (dir: string, turn: number) => turn === 1
    ? writeFileSync(join(dir, SOURCE), `${GUARDED}// asks the reference\n`) : writeFileSync(join(dir, TEST), REWRITTEN);
  const result = await round(undefined, turns, { criteria: reviewed.slice(0, 1), acceptance: acceptance.slice(0, 1),
    selfChecks: ["REVIEW_VERDICT 1: FAIL (a) released(undefined) is still true", "REVIEW_VERDICT 1: PASS"] });
  t.after(() => result.repo.cleanup());
  assert.equal(result.spawns, 2, "the uncleared self-check got its extra worker turn");
  assert.equal(result.pushes, 0, "that turn rewrote an unnamed test's expectation after the first commit");
  const refusal = refusalOf(result.rows);
  assert.equal(refusal?.round_head_sha, result.repo.git("rev-parse", "HEAD"));
});

/** A real repository with `test/inbox.test.ts` on main and a branch cut from it. */
function history() {
  const repo = gitRepo({ kind: "w1-t15064-history" });
  repo.git("config", "user.name", "fixture");
  repo.git("config", "user.email", "fixture@example.invalid");
  mkdirSync(join(repo.dir, "test"));
  writeFileSync(join(repo.dir, TEST), `${EXPECT}assert.equal(released(() => true), true);\n`);
  repo.git("add", "test");
  repo.git("commit", "-qm", "main");
  return { repo, git: (args: string[]) => hostWorktreeGitAsync(repo.dir, args) };
}

test("W1-T15064 criterion 2: a merge round is charged only for what it changed beyond main", async (t) => {
  const { repo, git } = history();
  t.after(() => repo.cleanup());
  repo.git("checkout", "-qb", "run-W1-T15064X-1");
  writeFileSync(join(repo.dir, "src.txt"), "branch\n");
  repo.git("add", "src.txt");
  repo.git("commit", "-qm", "branch work");
  const roundStart = repo.git("rev-parse", "HEAD");
  repo.git("checkout", "-q", "main");
  writeFileSync(join(repo.dir, TEST), `${REWRITTEN}assert.equal(released(() => true), true);\n`);
  repo.git("commit", "-qam", "main changes the expectation");
  repo.git("checkout", "-q", "run-W1-T15064X-1");
  repo.git("merge", "-q", "--no-edit", "main");
  const merged = repo.git("rev-parse", "HEAD");
  assert.equal(repo.git("rev-list", "--count", "--merges", `${roundStart}..${merged}`), "1");
  assert.deepEqual(await readExpectationRewrites(git, roundStart, merged), [], "main's own change is not the round's");
  // The control: the merge round also rewrites an expectation main kept.
  writeFileSync(join(repo.dir, TEST), `${REWRITTEN}assert.equal(released(() => true), false);\n`);
  repo.git("commit", "-qam", "the round rewrites what main kept");
  assert.deepEqual(await readExpectationRewrites(git, roundStart, repo.git("rev-parse", "HEAD")),
    [{ path: TEST, changed: ["assert.equal(released(() => true), true)"] }]);
});

test("W1-T15064 criterion 2: a renamed test is compared with its old path", async (t) => {
  const { repo, git } = history();
  t.after(() => repo.cleanup());
  const base = repo.git("rev-parse", "HEAD");
  const renamed = "test/inbox-released.test.ts";
  repo.git("mv", TEST, renamed);
  writeFileSync(join(repo.dir, renamed), `${REWRITTEN}assert.equal(released(() => true), true);\n`);
  repo.git("commit", "-qam", "rename and rewrite");
  const head = repo.git("rev-parse", "HEAD");
  assert.match(repo.git("diff", "--name-status", "-M", base, head), /^R\d+\ttest\/inbox\.test\.ts\ttest\/inbox-released\.test\.ts$/m);
  assert.deepEqual(await readExpectationRewrites(git, base, head),
    [{ path: renamed, changed: ["assert.equal(released(undefined), false)"] }]);
});
