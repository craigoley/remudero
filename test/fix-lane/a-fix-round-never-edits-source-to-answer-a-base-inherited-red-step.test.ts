// W1-T15064: a fix round never edits source to answer a red step the base already carries, and never rewrites an
// existing test's expectation unless the finding it answers names that test. On core #21035, round 1835b8af3
// answered inherited expiring-fixture-census crossings by loosening `=== false` to `!== true` in src/lib/inbox.ts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// @ts-expect-error -- plain .mjs script, no type declarations
import { emitCiReport, formatReport, isBlocked, proveNearCrossings, refusePopulationDrop } from "#scripts/expiring-fixture-census.mjs";
import { runFixRung as runFixRungWithHost, type FixCommandHost } from "#src/cli/commands/fix.js";
// A namespace import, so this file still links at a merge-base that lacks these exports: there each test fails on
// its own behaviour rather than the whole file failing to load.
import * as remedy from "#src/lib/ci-remedy-execution.js";
import type { FixSelfCheckRunResult } from "#src/lib/fix-self-check.js";
import { hostWorktreeGitAsync } from "#src/lib/worktree-git.js";
import { fetchCiFailuresAsync } from "#src/lib/tick-read-worker.js";
import type { Config } from "#src/lib/config.js";
import type { ReviewVerdict } from "#src/lib/review.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { fixCommandHost } from "#test/helpers/run-task-test.js";

const { BASE_INHERITED_MARKER, answeredFindingText, baseInheritedRedSteps, baseInheritedRedStepsFromJobLogs, readExpectationRewrites,
  rewrittenTestExpectations, unaskedExpectationRewrites } = remedy;

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
function censusLog(reported: ReturnType<typeof crossing>[], drops: Record<string, number> = {}, exemptCount = 0,
  greenWhenShifted: string[] = []) {
  proveNearCrossings(reported, (files: string[], days: number) => new Map(files.map((file) =>
    [file, days > 1 && !greenWhenShifted.includes(file) ? { passed: false, pass: 3, tests: 5 } : { passed: true, pass: 5, tests: 5 }])), 0);
  const populationDrop = refusePopulationDrop(drops, Object.fromEntries(Object.keys(drops).map((file) => [file, 9])));
  const exempt = Array.from({ length: exemptCount }, (_, i) => ({ file: `test/exempt-${i}.test.ts`, line: i + 1 }));
  const report = formatReport({ population: 9, reported, exempt, populationDrop });
  const lines: string[] = [];
  lines.push(report);
  const blocked = isBlocked({ reported, populationDrop });
  emitCiReport("expiring-fixture-census", report, { blocked, env: { RMD_CI_REPORT: "1" }, log: (line: string) => lines.push(line) });
  return { blocked, report, log: lines.join("\n") };
}

/** The census step's job log as GitHub serves it: a step group, the report on stdout, the runner's multi-line
 *  rendering of the `::error` annotation, the exit line, every line stamped with its time. */
const jobLog = (report: string) => stamped(["##[group]Run set -o pipefail", "  set -o pipefail",
  '  mkdir -p "$RUNNER_TEMP/gate-reports"',
  '  if [ "${GITHUB_EVENT_NAME}" = "merge_group" ]; then git update-ref refs/remotes/origin/main "$GATE_BASE"; fi',
  "  node scripts/expiring-fixture-census.mjs 2>&1 | tee \"$RUNNER_TEMP/gate-reports/expiring-fixture-census.log\"",
  "##[endgroup]", report,
  `##[error]${report}`, "##[error]Process completed with exit code 1."].join("\n"));
const crossingLines = (log: string) => log.split("\n").filter((line) => / goes red /.test(line)).length;

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
  /** The host's complete job-log reader; absent, every read fails, as with no network. */
  readCiJobLog?: (owner: string, repo: string, jobId: string) => Promise<string>;
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
  const host: FixCommandHost = { ...fixCommandHost(),
    readCiJobLog: options.readCiJobLog ?? (async () => { throw new Error("no job log in this fixture"); }), ...(options.selfChecks ? {
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
  const skipped = result.rows.find((row) => row.step === "fix.round_skipped" && row.reason === "base_inherited");
  assert.deepEqual(skipped?.steps, ["comment-load-ratchet"], "the skipped round is recorded as fix.round_skipped");
  // The marker is the one the census really prints.
  assert.equal(readFileSync(join(REPO_ROOT, "scripts/expiring-fixture-census.mjs"), "utf8").includes(BASE_INHERITED_MARKER), true);
  assert.equal(inherited.blocked, true, "the census blocks on its confirmed near crossings even though the base owns them");
  assert.match(inheritedLog, /^::error title=expiring-fixture-census::expiring-fixture-census: BLOCKED -- 2 fixture\(s\) CROSS/m);
  // The same report read back three ways: the job log with its timestamps, the runner's rendering of the annotation,
  // and the annotation message alone, which is what a log read that falls back to annotations carries.
  const rendered = stamped(inheritedLog.replace(/^::error title=expiring-fixture-census::/m, "##[error]"));
  const reportOnly = inheritedLog.split("\n::error")[0]!;
  for (const [shape, logTail] of [["stamped", stamped(inheritedLog)], ["rendered", rendered], ["report-only", reportOnly]] as const) {
    assert.equal(baseInheritedRedSteps([{ name: "light-gates", logTail }]).inherited, true, `${shape}: ${logTail.slice(0, 200)}`);
  }
  assert.equal(baseInheritedRedSteps([{ name: "light-gates", logTail: `${rendered}\n##[error]Process completed with exit code 1.` }]).inherited, false,
    "a generic failed exit without the job step heading is ambiguous");
  // Any doubt dispatches as before: a crossing the diff planted, a population drop the base is not charged with,
  // another failure in the log, another error annotation, or no failure at all.
  const planted = censusLog([crossing("test/a.test.ts", 0.4, true), crossing("test/b.test.ts", 0.6, false)]);
  assert.equal(planted.blocked, true);
  assert.equal(baseInheritedRedSteps([{ name: "light-gates", logTail: planted.log }]).inherited, false);
  const dropped = censusLog([crossing("test/a.test.ts", 0.4, true)], { "test/c.test.ts": 4 });
  assert.match(dropped.log, /dropped below the recorded fixture population/);
  assert.equal(baseInheritedRedSteps([{ name: "light-gates", logTail: dropped.log }]).inherited, false);
  assert.equal(baseInheritedRedSteps([{ name: "light-gates", logTail: stamped(dropped.log) }]).inherited, false);
  // The drop reads the same from the report alone, as an annotation-backed log read carries it.
  assert.equal(baseInheritedRedSteps([{ name: "light-gates", logTail: dropped.log.split("\n::error")[0]! }]).inherited, false);
  const dropOnly = censusLog([], { "test/c.test.ts": 4 });
  assert.equal(baseInheritedRedSteps([{ name: "light-gates", logTail: dropOnly.log }]).inherited, false);
  assert.equal(baseInheritedRedSteps([{ name: "light-gates", logTail: `${inheritedLog}\nnot ok 3 - inbox` }]).inherited, false);
  assert.equal(baseInheritedRedSteps([{ name: "light-gates", logTail: `${rendered}\n##[error]tsc: 2 errors` }]).inherited, false);
  assert.equal(baseInheritedRedSteps([{ name: "light-gates", logTail: `${rendered}\n##[error]Process completed with exit code 1.\n##[error]Process completed with exit code 1.` }]).inherited, false,
    "a second failed-step exit in the same job means the census is not the only red step");
  const otherStepFailed = `${rendered}\n##[group]Run npm run lint-plan\n##[endgroup]\n##[error]Process completed with exit code 1.`;
  assert.equal(baseInheritedRedSteps([{ name: "light-gates", logTail: otherStepFailed }]).inherited, false,
    "a generic failure attributed to another named job step cannot be explained by the inherited census");
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
  // Named assert imports count as assertion heads, and a destructured loop value inherits changes to its source table.
  const casesBase = `import { strictEqual } from "node:assert/strict";\nconst cases = [{ expected: false }];\nfor (const { expected } of cases) strictEqual(f(), expected);\n`;
  const casesHead = casesBase.replace("expected: false", "expected: true");
  assert.deepEqual(rewrittenTestExpectations([{ path: "test/console-review-three-state.test.ts", base: casesBase, head: casesHead }]), [
    { path: "test/console-review-three-state.test.ts", changed: ["strictEqual(f(), expected) (reads changed cases)"] },
  ]);
  const tupleBase = `import assert from "node:assert/strict";\nconst cases = [["origin", "portal"]];\nfor (const [origin, want] of cases) assert.deepEqual(resolve(origin), want);\n`;
  assert.deepEqual(rewrittenTestExpectations([{ path: "test/resolve-owner-repo-names-its-failure.test.ts", base: tupleBase,
    head: tupleBase.replace("portal", "other") }]), [
    { path: "test/resolve-owner-repo-names-its-failure.test.ts", changed: ["assert.deepEqual(resolve(origin), want) (reads changed cases)"] },
  ]);
  const objectVariableBase = `import { strictEqual } from "node:assert/strict";\nconst cases = [{ expected: false }];\nfor (const c of cases) strictEqual(f(), c.expected);\n`;
  assert.deepEqual(rewrittenTestExpectations([{ path: "test/containment.test.ts", base: objectVariableBase,
    head: objectVariableBase.replace("expected: false", "expected: true") }]), [
    { path: "test/containment.test.ts", changed: ["strictEqual(f(), c.expected) (reads changed cases)"] },
  ]);
  // A finding for a longer, similarly named file does not name this test.
  assert.deepEqual(unaskedExpectationRewrites(multi, "test/fix-rung-inbox.test.ts"), multi);
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

test("W1-T15064 criterion 2: an added test leaves every real test file's expectations unchanged", () => {
  const files = execFileSync("git", ["-C", REPO_ROOT, "ls-files", "-z", "--", "test/"], { encoding: "utf8" })
    .split("\0").filter((path) => /\.test\.[cm]?[jt]s$/.test(path));
  assert.ok(files.length > 1000, `the census saw its corpus: ${files.length} test files`);
  const appended = "\ntest(\"W1-T15064 appended\", () => {\n  const result = 1;\n  assert.equal(result, 1);\n});\n";
  const refused = files.filter((path) => {
    const base = readFileSync(join(REPO_ROOT, path), "utf8");
    return rewrittenTestExpectations([{ path, base, head: `${base}${appended}` }]).length > 0;
  });
  assert.deepEqual(refused, [], `${refused.length} of ${files.length} files read an add-only edit as a rewrite`);
  // Positive control: the same scan does see a rewrite in a real file.
  const real = files.find((path) => readFileSync(join(REPO_ROOT, path), "utf8").includes("assert.equal("))!;
  const text = readFileSync(join(REPO_ROOT, real), "utf8");
  const at = text.indexOf("assert.equal(");
  assert.equal(rewrittenTestExpectations([{ path: real, base: text,
    head: `${text.slice(0, at)}assert.notEqual(${text.slice(at + "assert.equal(".length)}` }]).length, 1);
});

test("W1-T15064 criterion 2: quotes and parens inside regular expressions and templates are not code", () => {
  const base = [
    "assert.match(text, /can't (open/);",
    "assert.match(text, /fn\\(/);",
    "const label = `it's ${name} (x`;",
    "assert.equal(label, `it's a (x`);",
    "assert.equal(f(\")\"), 1);",
  ].join("\n");
  assert.deepEqual(rewrittenTestExpectations([{ path: TEST, base, head: `${base}\nassert.equal(1, 1);\n` }]), []);
  assert.deepEqual(rewrittenTestExpectations([{ path: TEST, base, head: base.replace("/fn\\(/", "/fn/") }]),
    [{ path: TEST, changed: ["assert.match(text, /fn\\(/)"] }]);
});

test("W1-T15064 criterion 2: changing a value an assertion reads changes that expectation", () => {
  const base = "const expected = false;\nconst rows = [\n  1,\n  2,\n];\nassert.equal(f(), expected);\nassert.deepEqual(g(), rows);\n";
  assert.deepEqual(rewrittenTestExpectations([{ path: TEST, base, head: base.replace("= false", "= true") }]),
    [{ path: TEST, changed: ["assert.equal(f(), expected) (reads changed expected)"] }]);
  assert.deepEqual(rewrittenTestExpectations([{ path: TEST, base, head: base.replace("  2,\n", "") }]),
    [{ path: TEST, changed: ["assert.deepEqual(g(), rows) (reads changed rows)"] }]);
  // A destructured fixture constant counts the same way.
  const destructured = "const { want } = { want: 1 };\nassert.equal(h(), want);\n";
  assert.equal(rewrittenTestExpectations([{ path: TEST, base: destructured, head: destructured.replace("want: 1", "want: 2") }]).length, 1);
  // Declaring the same name again in a new test is not a change to the old one.
  assert.deepEqual(rewrittenTestExpectations([{ path: TEST, base, head: `${base}const expected = true;\nassert.equal(k(), expected);\n` }]), []);
});

test("W1-T15064 criterion 1: an all-inherited red step dispatches no source edit, read from the complete job log", async (t) => {
  // This repo's real footer: 82 exempt fixtures, listed after the crossings.
  const census = censusLog([crossing("test/a.test.ts", 0.4, true), crossing("test/b.test.ts", 0.6, true)], {}, 82);
  assert.equal(census.blocked, true);
  const log = jobLog(census.report);
  const rollup = [{ name: "light-gates", conclusion: "FAILURE", detailsUrl: "https://github.com/acme/remudero/actions/runs/1/job/777" }];
  for (const annotations of [[], [census.report]]) {
    const [failure] = await fetchCiFailuresAsync("acme", "remudero", rollup, 60,
      { fetchAnnotations: async () => annotations, fetchJobLog: async () => log });
    assert.equal(failure!.jobId, "777");
    assert.ok(crossingLines(failure!.logTail) < 2 * 2, `the region is cut: ${crossingLines(failure!.logTail)} crossing line(s)`);
    // The production region alone is unknown, never inherited.
    if (crossingLines(failure!.logTail) < 2) assert.equal(baseInheritedRedSteps([failure!]).inherited, false);
    const full = await baseInheritedRedStepsFromJobLogs([failure!], async (jobId) => { assert.equal(jobId, "777"); return log; });
    assert.equal(full.inherited, true, "the complete log shows every crossing inherited");
  }
  const [failure] = await fetchCiFailuresAsync("acme", "remudero", rollup, 60,
    { fetchAnnotations: async () => [], fetchJobLog: async () => log });
  assert.equal(crossingLines(failure!.logTail), 0, "the 82-line footer pushes every crossing out of the region");
  const stood = await round([failure!], loosenAndRewrite, { readCiJobLog: async () => log });
  t.after(() => stood.repo.cleanup());
  assert.equal(stood.spawns, 0, "read from the complete log, the inherited red dispatches no source edit");
  assert.ok(stood.rows.some((row) => row.step === "fix.stood_down" && row.reason === "base_inherited"));
  // No complete log: the cut region is unknown, so the round dispatches as it always did.
  const unread = await round([failure!], (dir) => writeFileSync(join(dir, SOURCE), `${GUARDED}// repaired\n`));
  t.after(() => unread.repo.cleanup());
  assert.equal(unread.spawns, 1);
});

test("W1-T15064 criterion 1: a cut report whose lost lines hold a crossing this diff owns never stands down", async () => {
  // Three crossings, the nearest planted by this diff and green in its shifted run, so the report asks no fix of it
  // and the step still blocks on the two inherited ones. With no footer the region keeps only those two.
  const census = censusLog([crossing("test/mine.test.ts", 0.2, false), crossing("test/a.test.ts", 0.4, true),
    crossing("test/b.test.ts", 0.6, true)], {}, 0, ["test/mine.test.ts"]);
  assert.equal(census.blocked, true);
  assert.match(census.report, /BLOCKED -- 3 fixture\(s\) CROSS/);
  const log = jobLog(census.report);
  const rollup = [{ name: "light-gates", conclusion: "FAILURE", detailsUrl: "https://github.com/acme/remudero/actions/runs/1/job/778" }];
  const [failure] = await fetchCiFailuresAsync("acme", "remudero", rollup, 60, { fetchAnnotations: async () => [], fetchJobLog: async () => log });
  assert.ok(failure!.logTail.includes(BASE_INHERITED_MARKER), "the region keeps inherited crossings");
  assert.equal(failure!.logTail.includes("test/mine.test.ts"), false, "and cuts the one this diff planted");
  assert.equal(baseInheritedRedSteps([failure!]).inherited, false, "fewer crossings than the headline states is unknown");
  assert.equal((await baseInheritedRedStepsFromJobLogs([failure!], async () => log)).inherited, false);
  assert.equal((await baseInheritedRedStepsFromJobLogs([failure!], async () => { throw new Error("403"); })).inherited, false);
});

/** The census step's job log in the shape actions/runner really writes it, as captured in this repo's other job-log
 *  fixtures (test/a-plan-only-pr-red-only-on-a-ci-infrastructure-step-is-re-run.test.ts): the group header names the
 *  script's first line, the runner echoes every script line wrapped in `ESC[36;1m … ESC[0m`, then its `shell:` and
 *  `env:` lines. The script lines are ci.yml's expiring-fixture-census step (ci.yml:1571-1574), verbatim. */
const CENSUS_STEP_SCRIPT = [
  "set -o pipefail",
  'mkdir -p "$RUNNER_TEMP/gate-reports"',
  'if [ "${GITHUB_EVENT_NAME}" = "merge_group" ]; then git update-ref refs/remotes/origin/main "$GATE_BASE"; fi # W1-T5522: no base flag',
  'node scripts/expiring-fixture-census.mjs 2>&1 | tee "$RUNNER_TEMP/gate-reports/expiring-fixture-census.log"',
];
const runnerGroup = (script: readonly string[], env: readonly string[] = []) => [`##[group]Run ${script[0]}`,
  ...script.map((line) => `\u001b[36;1m${line}\u001b[0m`), "shell: /usr/bin/bash -e {0}",
  ...(env.length > 0 ? ["env:", ...env] : []), "##[endgroup]"];
const runnerStamped = (lines: readonly string[]) => lines.flatMap((line) => line.split("\n"))
  .map((line, i) => `2026-11-27T00:00:01.${String(841136 + i).padStart(7, "0")}Z ${line}`).join("\n");
const runnerJobLog = (report: string, after: readonly string[] = []) => runnerStamped([
  ...runnerGroup(CENSUS_STEP_SCRIPT, ["  RMD_CI_REPORT: 1"]), ...report.split("\n"),
  `##[error]${report}`, "##[error]Process completed with exit code 1.", ...after]);

test("W1-T15064 criterion 1: an all-inherited census red read from a real runner job log, colour codes and all, stands down", async (t) => {
  const census = censusLog([crossing("test/a.test.ts", 0.4, true), crossing("test/b.test.ts", 0.6, true)], {}, 82);
  assert.equal(census.blocked, true);
  const log = runnerJobLog(census.report);
  // The fixture carries the runner's colour codes around the very line that names the census.
  assert.match(log, /Z \u001b\[36;1mnode scripts\/expiring-fixture-census\.mjs 2>&1 \| tee .*\u001b\[0m$/m);
  assert.equal(baseInheritedRedSteps([{ name: "light-gates", logTail: log }]).inherited, true,
    "the census is the job's only failed step and every crossing is inherited");
  // The same log uncoloured reads the same: the escape codes decide nothing.
  assert.equal(baseInheritedRedSteps([{ name: "light-gates", logTail: log.replace(/\u001b\[[0-9;]*m/g, "") }]).inherited, true);
  // The only-failed-step rule still holds in this shape: another coloured step failing after the census dispatches.
  const lint = runnerJobLog(census.report, [...runnerGroup(["npm run --silent lint-plan"]), "##[error]Process completed with exit code 1."]);
  assert.equal(baseInheritedRedSteps([{ name: "light-gates", logTail: lint }]).inherited, false);
  // A failed exit whose step is not the census, though the census report sits in its log, dispatches.
  const other = runnerStamped([...runnerGroup(["npm run --silent console-parity"]), ...census.report.split("\n"),
    `##[error]${census.report}`, "##[error]Process completed with exit code 1."]);
  assert.equal(baseInheritedRedSteps([{ name: "light-gates", logTail: other }]).inherited, false);
  // A crossing this diff planted, in the same real shape, dispatches.
  const planted = censusLog([crossing("test/a.test.ts", 0.4, true), crossing("test/b.test.ts", 0.6, false)], {}, 82);
  assert.equal(baseInheritedRedSteps([{ name: "light-gates", logTail: runnerJobLog(planted.report) }]).inherited, false);

  // The rung.strike site, reading that complete job log by the failure's job id: no worker, no edit, a recorded why.
  const rollup = [{ name: "light-gates", conclusion: "FAILURE", detailsUrl: "https://github.com/acme/remudero/actions/runs/1/job/779" }];
  const [failure] = await fetchCiFailuresAsync("acme", "remudero", rollup, 60, { fetchAnnotations: async () => [], fetchJobLog: async () => log });
  assert.equal(failure!.jobId, "779");
  const stood = await round([failure!], loosenAndRewrite, { readCiJobLog: async () => log });
  t.after(() => stood.repo.cleanup());
  assert.equal(stood.spawns, 0, "no worker is dispatched to edit source");
  assert.equal(stood.pushes, 0);
  assert.equal(stood.repo.git("rev-parse", "HEAD"), stood.before, "no commit");
  assert.equal(stood.repo.git("status", "--porcelain", "--", "src", "test"), "", "no source edit in the worktree");
  assert.equal(readFileSync(join(stood.repo.dir, SOURCE), "utf8"), GUARDED);
  assert.equal(stood.outcome.outcome, "stood_down");
  const skipped = stood.rows.find((row) => row.step === "fix.round_skipped");
  assert.equal(skipped?.reason, "base_inherited", "the skipped round records why");
  assert.deepEqual(skipped?.steps, [failure!.name], "and names the red steps it did not answer");
  assert.equal(skipped?.site, "rung.strike");
  // The control: the same round over the planted report's real log dispatches its worker.
  const plantedLog = runnerJobLog(planted.report);
  const [plantedFailure] = await fetchCiFailuresAsync("acme", "remudero", rollup, 60,
    { fetchAnnotations: async () => [], fetchJobLog: async () => plantedLog });
  const dispatched = await round([plantedFailure!], (dir) => writeFileSync(join(dir, SOURCE), `${GUARDED}// repaired\n`),
    { readCiJobLog: async () => plantedLog });
  t.after(() => dispatched.repo.cleanup());
  assert.equal(dispatched.spawns, 1);
  assert.equal(dispatched.rows.some((row) => row.step === "fix.round_skipped"), false);
});

const PR_OWN = "assert.equal(prOwn(), false);\n";

/** A harness merge round in a real repository: the PR added `assert.equal(prOwn(), false)` to a test file main also
 *  has, main then changed that file to `mainText`, and the round merged main in one real two-parent commit whose
 *  resolution `resolve` writes. */
function mergeRound(mainText: string, resolve: (merged: string) => string) {
  const { repo, git } = history();
  repo.git("checkout", "-qb", "run-W1-T15064X-1");
  writeFileSync(join(repo.dir, TEST), `${readFileSync(join(repo.dir, TEST), "utf8")}${PR_OWN}`);
  repo.git("commit", "-qam", "the PR adds its own assertion");
  const roundStart = repo.git("rev-parse", "HEAD");
  repo.git("checkout", "-q", "main");
  writeFileSync(join(repo.dir, TEST), mainText);
  repo.git("commit", "-qam", "main changes the test file");
  repo.git("checkout", "-q", "run-W1-T15064X-1");
  repo.git("merge", "-q", "--no-ff", "--no-commit", "main");
  writeFileSync(join(repo.dir, TEST), resolve(readFileSync(join(repo.dir, TEST), "utf8")));
  repo.git("add", TEST);
  repo.git("commit", "-qm", "merge main");
  const merged = repo.git("rev-parse", "HEAD");
  assert.equal(repo.git("rev-list", "--count", "--merges", `${roundStart}..${merged}`), "1", "one real two-parent commit");
  return { repo, read: () => readExpectationRewrites(git, roundStart, merged), mergedText: () => readFileSync(join(repo.dir, TEST), "utf8") };
}

const MAIN_FLIPS_ITS_OWN = `${REWRITTEN}assert.equal(released(() => true), true);\n`;

test("W1-T15064 criterion 2: a merge round that flips an assertion the PR added is charged, though main lacks it", async (t) => {
  // The reviewer's probe: main never had `prOwn`, so main lacking it is no evidence main changed it.
  const flipped = mergeRound(MAIN_FLIPS_ITS_OWN, (text) => text.replace(PR_OWN, "assert.equal(prOwn(), true);\n"));
  t.after(() => flipped.repo.cleanup());
  assert.match(flipped.mergedText(), /released\(undefined\), true/, "main's own change came in through the merge");
  assert.deepEqual(await flipped.read(), [{ path: TEST, changed: ["assert.equal(prOwn(), false)"] }],
    "charged for the PR's assertion it flipped, never for main's");
  assert.deepEqual(unaskedExpectationRewrites(await flipped.read(), answeredFindingText({ review: { unmetCriteria: [UNMET] } })),
    [{ path: TEST, changed: ["assert.equal(prOwn(), false)"] }], "no finding names the test, so the round is refused");
  // The control: the merge keeps the PR's assertion, and nothing is charged.
  const kept = mergeRound(MAIN_FLIPS_ITS_OWN, (text) => text);
  t.after(() => kept.repo.cleanup());
  assert.equal(kept.mergedText().includes(PR_OWN), true);
  assert.deepEqual(await kept.read(), []);
});

test("W1-T15064 criterion 2: a merge round that rewrites what main brought in is charged for it", async (t) => {
  // Main changed an expectation and the round's resolution changed main's version again.
  const again = mergeRound(MAIN_FLIPS_ITS_OWN, (text) => text.replace("released(undefined), true", "released(undefined), \"x\""));
  t.after(() => again.repo.cleanup());
  assert.deepEqual(await again.read(), [{ path: TEST, changed: ["assert.equal(released(undefined), true)"] }]);
  // Main added an assertion and the round's resolution dropped it.
  const MAIN_OWN = "assert.equal(mainOwn(), 1);\n";
  const added = `${EXPECT.replace("\n", `\n${MAIN_OWN}`)}assert.equal(released(() => true), true);\n`;
  const dropped = mergeRound(added, (text) => text.replace(MAIN_OWN, ""));
  t.after(() => dropped.repo.cleanup());
  assert.deepEqual(await dropped.read(), [{ path: TEST, changed: ["assert.equal(mainOwn(), 1)"] }]);
  // The control: the same merge, taken whole, charges nothing.
  const whole = mergeRound(added, (text) => text);
  t.after(() => whole.repo.cleanup());
  assert.equal(whole.mergedText().includes(MAIN_OWN), true);
  assert.deepEqual(await whole.read(), []);
});
