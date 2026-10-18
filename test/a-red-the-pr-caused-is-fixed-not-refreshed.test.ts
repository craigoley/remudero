import { repoRoot } from "#test/helpers/repo-root.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Config } from "#src/lib/config.js";
import type { IssueGateway } from "#src/lib/escalate.js";
import type { Mount } from "#src/lib/mounts.js";
import type { ReviewVerdict } from "#src/lib/review.js";
import type { WorkerResult } from "#src/lib/worker.js";
import {
  assessRefreshClearance,
  GITHUB_COMPARE_FILES_LISTED,
  mainPathsReachingRed,
  refreshRecordsFromLedger,
  refreshedOnSameRed,
  type BaseProbeFile,
} from "#src/lib/base-reproduction.js";
import { buildBaseReproductionProbe, buildImportClosureRead, mainTipViaGit, priorStrikesFor } from "#src/run-task.js";
import { runFixRung } from "#test/helpers/run-task-test.js";
import { DEFAULT_SWEEP_POLICY, isCiHarnessPath, runSweep, type OpenPrView, type SweepDeps } from "#test/helpers/sweep-test.js";
import { gitRepo } from "#test/helpers/git-repo.js";

// W1-T8396 — OBSERVED 2026-10-12 on #11017 (W1-T8008): the PR's own src change broke an untouched test.
// The fix rung's fileless arm merged main in (04:31:59Z); then the head was still red on the same check,
// the failing test passed on main, and W1-T6405's fixed-on-main arm merged main in again (04:55:28Z) over
// a main delta of three plan files. No fix worker was ever dispatched. These tests build that shape.

const NOW = Date.UTC(2026, 9, 12, 5);
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const MAIN = "3".repeat(40);
const HEAD = "4".repeat(40);
const OLD_HEAD = "1".repeat(40);
const PR = 11017;
const CHECK = "coverage-shard (4/8)";
const FILE = "test/a-dispatch-phase-is-not-held-by-its-slowest-lane.test.ts";
const PLAN_DELTA = [
  "plan/feedback/evidence-coverage-daemon-tokens.yaml",
  "plan/tasks.d/W1-T8490-one-shard.yaml",
  "plan/tasks.d/W1-T8491-another-shard.yaml",
];
const CLOSURE = new Map([[FILE, new Set([FILE, "src/run-task.ts", "src/lib/sweep.ts"])]]);
type Row = Record<string, unknown>;
type Outcome = BaseProbeFile["outcome"];

function redPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: PR, prUrl: `https://github.com/acme/remudero/pull/${PR}`, taskId: "W1-T8008",
    reviewState: "pending", checksState: "red", unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: ago(1), headSha: HEAD, headRefName: "run-W1-T8008-1", autoMergeArmed: false,
    ciFailures: [{ name: CHECK, logTail: `not ok 3 - ${FILE}` }], ...over,
  };
}

function peer(): OpenPrView {
  return redPr({ prNumber: 6000, prUrl: "https://github.com/acme/remudero/pull/6000", taskId: "W1-T6000",
    headRefName: "run-W1-T6000-1", checksState: "green", reviewState: "success", ciFailures: [] });
}

interface HarnessOpts {
  /** Main's changed paths since the head's merge base; undefined leaves the compare read unwired. */
  baseChanged?: string[];
  /** The failing test's outcome on main's tip. */
  onMain?: Outcome;
  /** The failing test's outcome on a trial merge of the head with main; undefined leaves the probe unwired. */
  merged?: Outcome;
  behindBy?: number;
}

function harness(rows: Row[], opts: HarnessOpts) {
  const fixed: number[] = [];
  const refreshed: number[] = [];
  const merges: string[] = [];
  const escalations: string[] = [];
  const deps: SweepDeps = {
    arm: () => {}, close: () => {}, postReview: async () => {},
    escalate: (_pr, reason) => { escalations.push(reason); },
    dispatchFix: (pr) => {
      fixed.push(pr.prNumber);
      rows.push({ step: "fix.dispatch", task_id: pr.taskId, head_sha: pr.headSha, strike: 1 });
    },
    updateBranch: (pr) => { refreshed.push(pr.prNumber); return "updated"; },
    reproduceFailingTestsOnMain: async (_pr, files) =>
      files.map((file) => ({ file, outcome: opts.onMain ?? "passes", duration_ms: 9, cached: false })),
    ...(opts.baseChanged === undefined ? {} : {
      readRedBaseRefreshFacts: async () => ({ behindBy: opts.behindBy ?? 2, baseChangedFiles: opts.baseChanged }),
    }),
    readTestImportClosure: async () => CLOSURE,
    ...(opts.merged === undefined ? {} : {
      reproduceFailingTestsOnMerge: async (pr: OpenPrView, files: readonly string[], sha: string) => {
        merges.push(`${pr.headSha}+${sha}`);
        return files.map((file) => ({ file, outcome: opts.merged!, duration_ms: 7, cached: false }));
      },
    }),
    behindMainByPr: new Map([[PR, opts.behindBy ?? 2]]),
    ledgerPath: "/dev/null/w1-t8396.ndjson", runId: "W1-T8396-test", now: () => NOW,
    readLedger: () => [...rows], appendLine: (_path, row) => { rows.push(row); }, readMainTip: () => MAIN,
  };
  return { rows, fixed, refreshed, merges, escalations, deps };
}

const mainHealth = (): Row => ({ step: "main.health.observed", sha: MAIN, state: "undetermined" });
const clearances = (rows: Row[]) => rows.filter((r) => r.step === "refresh.clearance");

/** The stalled own-red stage: no fix round admitted, an own-red past its backstop, a clear probe at main's tip. */
function stalledRows(extra: Row[] = []): Row[] {
  return [
    mainHealth(),
    { ts: ago(50), run_id: "old", task_id: "W1-T8008", step: "sweep.disposed", pr_number: PR, head_sha: HEAD,
      disposition: "blocked-fixable", acted: false, blocker: "own-red", blocker_since: ago(50) },
    { ts: ago(20), run_id: "old", task_id: "W1-T8008", step: "sweep.base_reproduction", pr_number: PR,
      head_sha: HEAD, main_sha: MAIN, verdict: "clear", files: [{ file: FILE, outcome: "passes", duration_ms: 9, cached: false }] },
    ...extra,
  ];
}

// ── the fix rung's own harness, as test/a-red-branch-behind-its-base-spends-a-strike-first.test.ts builds it ──
const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 };
const REPO_ROOT = repoRoot();

function review(state: "success" | "failure", headSha = HEAD): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return {
    state, criteria: [{ claim: "the repair works", proof: "unit test", met: state === "success", reason: "", proof_exec: "not_executable" }],
    testTheater: false, summary: state, floorDegraded: false, capped: false, keywordOnly: false, planOnly: false, headSha, reviewerOutcome: state,
  };
}

function worker(): WorkerResult {
  return {
    sessionId: "fix-session", costUsd: 0, numTurns: 1, text: "fixed", blocks: [], stderr: "", subtype: "success", isError: false,
    apiError: false, permissionDenials: [], childEnvKeys: [], model: "sonnet", effort: "medium",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  };
}

async function fixRung(merged: Outcome | undefined, mainTip: string | null = MAIN) {
  const events: string[] = [];
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const outcome = await runFixRung({
    taskId: "W1-T8008", runId: "W1-T8008-1791773782381", task: { id: "W1-T8008", title: "hand off out-of-scope checkpoints" },
    prUrl: `https://github.com/acme/remudero/pull/${PR}`, branch: "run-W1-T8008-1791773782381", worktreePath: REPO_ROOT,
    initialSessionId: "implement-session", mount: MOUNT, settingsFile: "/tmp/w1-t8396-settings.json", config: {} as Config,
    budgetUsd: 5, strikeCap: 1, initialReview: review("failure"),
    ciFailures: [{ name: CHECK, logTail: `not ok 3 - checkpoint\n    at file:///workspace/remudero/${FILE}:88:3` }],
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: REPO_ROOT, reviewerMount: MOUNT },
    deps: {
      spawn: async () => { events.push("spawn"); return worker(); },
      waitForCiGreen: async () => { events.push("wait"); return "green" as const; },
      fetchPrBody: async () => "PR body",
      runReview: async () => review("success", "fixed-head"),
      push: () => events.push("push"),
      issues: {} as IssueGateway,
      ledgerPath: "/tmp/w1-t8396-ledger.ndjson",
      log: (step: string, extra?: Record<string, unknown>) => { events.push(step); logged.push({ step, extra }); },
      say: () => {},
      account: (result: WorkerResult) => result,
      readRedBaseRefreshFacts: async () => ({ behindBy: 5, baseChangedFiles: [FILE] }),
      updateBranch: async () => { events.push("update-branch"); return { ok: true }; },
      readMainTip: async () => {
        if (mainTip === null) throw new Error("main tip unreadable");
        return mainTip;
      },
      ...(merged === undefined ? {} : {
        reproduceFailingTestsOnMerge: async (_pr: OpenPrView, files: readonly string[]) =>
          files.map((file) => ({ file, outcome: merged, duration_ms: 3, cached: false })),
      }),
    },
  });
  return { outcome, events, logged };
}

test("W1-T8396: main changed nothing the failing test reaches, so no refresh and the fix lane takes the red", async () => {
  // The #11017 second refresh: the failing test passes on main, main is two commits ahead, and those
  // commits touched only plan files — nothing the failing test imports, and no CI harness path.
  const h = harness([mainHealth()], { baseChanged: PLAN_DELTA, merged: "passes" });
  await runSweep([redPr(), peer()], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.refreshed, [], "a main that cannot reach the red is not merged in");
  assert.deepEqual(h.merges, [], "the path pre-filter decides before any trial merge runs");
  assert.deepEqual(h.fixed, [PR], "the red is the PR's own: the fix lane takes it");
  assert.equal(h.rows.filter((r) => r.step === "sweep.base_fixed.refresh").length, 0);
  const rows = clearances(h.rows);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.arm, "base-fixed");
  assert.equal(rows[0]?.evidence, "prefilter");
  assert.equal(rows[0]?.refresh, false);
  assert.equal(rows[0]?.main_sha, MAIN);
  assert.equal(rows[0]?.head_sha, HEAD);
  assert.deepEqual(rows[0]?.test_files, [FILE]);
  assert.deepEqual(rows[0]?.checks, [CHECK]);
  assert.deepEqual(rows[0]?.counted_paths, []);
});

test("W1-T8396: a red the trial merge keeps is not refreshed", async () => {
  // Sweep arm: main DID change a module the failing test imports, but the test still fails on the merge.
  const sweep = harness([mainHealth()], { baseChanged: ["src/lib/sweep.ts", ...PLAN_DELTA], merged: "fails" });
  await runSweep([redPr(), peer()], sweep.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(sweep.merges, [`${HEAD}+${MAIN}`], "the trial merge runs on the head and main's tip");
  assert.deepEqual(sweep.refreshed, []);
  assert.deepEqual(sweep.fixed, [PR]);
  const row = clearances(sweep.rows)[0];
  assert.equal(row?.evidence, "merged-probe");
  assert.equal(row?.merged_verdict, "reproduced");
  assert.deepEqual(row?.counted_paths, ["src/lib/sweep.ts"]);

  // Stalled-stage arm: the same evidence refuses its fixed-on-main refresh, and the stage escalates.
  const stalled = harness(stalledRows(), { baseChanged: ["src/lib/sweep.ts"], merged: "fails" });
  await runSweep([redPr()], { ...stalled.deps, actionable: () => false }, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(stalled.refreshed, []);
  assert.equal(stalled.escalations.length, 1);
  assert.match(stalled.escalations[0]!, /fixed-on-main \(branch refresh refused: merged-probe\)/);
  assert.equal(clearances(stalled.rows)[0]?.arm, "stalled-stage");

  // Fix rung arm: main changed the failing test file itself, yet the merged tree keeps the red.
  const rung = await fixRung("fails");
  assert.equal(rung.outcome.outcome, "fixed", "the round spends its strike and dispatches its worker");
  assert.equal(rung.outcome.strikes, 1);
  assert.equal(rung.events.includes("update-branch"), false);
  assert.ok(rung.events.includes("spawn"));
  const rungRow = rung.logged.find((r) => r.step === "refresh.clearance")?.extra;
  assert.equal(rungRow?.arm, "fix-rung");
  assert.equal(rungRow?.evidence, "merged-probe");
  assert.equal(rungRow?.main_sha, MAIN);
  assert.deepEqual(rungRow?.test_files, [FILE]);
});

test("W1-T8396: a refresh that left the same red is not repeated by another arm", async () => {
  // The fix rung's fileless refresh (#11017's 04:31:59Z merge) of the PRIOR head, red on the same check.
  const fixRefresh: Row = { ts: ago(30), run_id: "fix", task_id: "W1-T8008", step: "fix.base_refreshed", pr_number: PR,
    head_sha: OLD_HEAD, red_checks: [CHECK], test_files: [], matching_base_files: ["scripts/pure-test-pool.mjs"] };
  // Main's delta is unread and the trial merge reads clear: only the refresh history can refuse.
  const sweep = harness([mainHealth(), fixRefresh], { merged: "passes" });
  await runSweep([redPr(), peer()], sweep.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(sweep.refreshed, [], "the fixed-on-main arm does not refresh the head the fix rung's refresh made");
  assert.deepEqual(sweep.merges, []);
  assert.deepEqual(sweep.fixed, [PR]);
  assert.equal(clearances(sweep.rows)[0]?.evidence, "repeat");

  // The stalled-stage arm after the sweep's own refresh of the prior head (a row from before this task).
  const sweepRefresh: Row = { ts: ago(40), run_id: "old", task_id: "W1-T8008", step: "sweep.base_fixed.refresh", pr_number: PR,
    head_sha: OLD_HEAD, main_sha: "2".repeat(40), test_files: [FILE], outcome: "updated" };
  const stalled = harness(stalledRows([sweepRefresh]), { baseChanged: PLAN_DELTA, merged: "passes" });
  await runSweep([redPr()], { ...stalled.deps, actionable: () => false }, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(stalled.refreshed, []);
  assert.equal(clearances(stalled.rows)[0]?.evidence, "repeat");
  assert.match(stalled.escalations[0] ?? "", /refused: repeat/);

  // Once main changes a path the failing test reaches, the trial merge decides again.
  const moved = harness([mainHealth(), fixRefresh], { baseChanged: ["src/run-task.ts"], merged: "passes" });
  await runSweep([redPr(), peer()], moved.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(moved.refreshed, [PR]);
  assert.equal(clearances(moved.rows)[0]?.evidence, "merged-probe");
});

test("W1-T8396: a red main fixed still refreshes and a base red still stands down", async () => {
  // Main changed a module the failing test imports, and the trial merge passes: main once, no strike.
  const fixedOnMain = harness([mainHealth()], { baseChanged: ["src/lib/sweep.ts"], merged: "passes" });
  await runSweep([redPr(), peer()], fixedOnMain.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(fixedOnMain.refreshed, [PR]);
  assert.deepEqual(fixedOnMain.fixed, []);
  assert.equal(priorStrikesFor(fixedOnMain.rows, "W1-T8008", "keyword_only", HEAD), 0);
  const refresh = fixedOnMain.rows.filter((r) => r.step === "sweep.base_fixed.refresh");
  assert.equal(refresh.length, 1);
  assert.deepEqual(refresh[0]?.check_names, [CHECK], "the refresh records the red it was taken on");
  const row = clearances(fixedOnMain.rows)[0];
  assert.equal(row?.refresh, true);
  assert.equal(row?.evidence, "merged-probe");
  assert.equal(row?.merged_verdict, "clear");

  // A red that reproduces on main stands down: no refresh, no fix, and no trial merge.
  const baseRed = harness([mainHealth()], { baseChanged: ["src/lib/sweep.ts"], onMain: "fails", merged: "fails" });
  await runSweep([redPr(), peer()], baseRed.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(baseRed.refreshed, []);
  assert.deepEqual(baseRed.fixed, []);
  assert.deepEqual(baseRed.merges, []);
  assert.match(String(baseRed.rows.findLast((r) => r.step === "sweep.disposed" && r.pr_number === PR)?.stand_down_reason),
    /base red reproduced/);

  // The fix rung: a trial merge that clears the red still refreshes with no strike, and records the red.
  const rung = await fixRung("passes");
  assert.equal(rung.outcome.outcome, "base_refreshed");
  assert.equal(rung.outcome.strikes, 0);
  const refreshed = rung.logged.find((r) => r.step === "fix.base_refreshed")?.extra;
  assert.equal(refreshed?.head_sha, HEAD);
  assert.deepEqual(refreshed?.red_checks, [CHECK]);
  assert.deepEqual(refreshed?.test_files, [FILE]);
});

test("W1-T8396: an unrunnable or partial trial merge keeps today's refresh and names why", async () => {
  const reach = { counted: ["src/lib/sweep.ts"], complete: true };
  const input = { failingTestFiles: [FILE, "test/other.test.ts"], reach, priorRefresh: false };
  const unwired = await assessRefreshClearance(input, undefined);
  assert.deepEqual([unwired.refresh, unwired.evidence], [true, "unrunnable"]);
  const thrown = await assessRefreshClearance(input, async () => { throw new Error("merge conflict in src/lib/sweep.ts"); });
  assert.deepEqual([thrown.refresh, thrown.evidence], [true, "unrunnable"]);
  assert.match(thrown.reason, /merge conflict in src\/lib\/sweep\.ts/);
  const refused = await assessRefreshClearance(input, async () => Object.assign([], { reason: "too many test files" }));
  assert.deepEqual([refused.refresh, refused.evidence, refused.mergedVerdict], [true, "unrunnable", "unrunnable"]);
  assert.match(refused.reason, /too many test files/);
  const silent = await assessRefreshClearance(input, async () => [
    { file: FILE, outcome: "unrunnable", duration_ms: 1, cached: false }, { file: "test/other.test.ts", outcome: "passes", duration_ms: 1, cached: false }]);
  assert.equal(silent.reason, "the trial merge is unrunnable; keeping today's refresh");
  const partial = await assessRefreshClearance(input, async () => [
    { file: FILE, outcome: "fails", duration_ms: 1, cached: false }, { file: "test/other.test.ts", outcome: "passes", duration_ms: 1, cached: false }]);
  assert.deepEqual([partial.refresh, partial.evidence], [true, "partial"]);

  // A fileless red has nothing to probe: its arm's own path evidence decides, as today.
  const fileless = await assessRefreshClearance({ failingTestFiles: [], reach: undefined, priorRefresh: false }, undefined);
  assert.deepEqual([fileless.refresh, fileless.evidence], [true, "fileless"]);
  // A repeat whose counted paths were read says so.
  const repeat = await assessRefreshClearance({ failingTestFiles: [FILE], reach: { counted: [], complete: false }, priorRefresh: true }, undefined);
  assert.match(repeat.reason, /main has changed nothing since/);

  // The fix rung keeps today's refresh when main's tip is unreadable, and names why.
  const rung = await fixRung("fails", null);
  assert.equal(rung.outcome.outcome, "base_refreshed");
  assert.equal(rung.logged.find((r) => r.step === "refresh.clearance")?.extra?.evidence, "unrunnable");
});

test("W1-T8396: main's delta proves nothing when truncated, unknown or blind to the graph", () => {
  const isHarness = isCiHarnessPath;
  const base = { failingTestFiles: [FILE], closure: CLOSURE, isHarnessPath: isHarness };
  assert.equal(mainPathsReachingRed({ ...base, mainChangedFiles: undefined }), undefined);
  assert.deepEqual(mainPathsReachingRed({ ...base, mainChangedFiles: PLAN_DELTA }), { counted: [], complete: true });
  const truncated = Array.from({ length: GITHUB_COMPARE_FILES_LISTED }, (_, i) => `plan/tasks.d/W1-T${i}.yaml`);
  assert.equal(mainPathsReachingRed({ ...base, mainChangedFiles: truncated })?.complete, false);
  assert.equal(mainPathsReachingRed({ ...base, closure: undefined, mainChangedFiles: PLAN_DELTA })?.complete, false);
  assert.deepEqual(mainPathsReachingRed({ ...base, mainChangedFiles: [
    "package-lock.json", "test/fixtures/a.json", "test/unrelated.test.ts", ".github/workflows/ci.yml", "docs/x.md", "src/other.ts",
  ], matchedPaths: ["src/other.ts"] })?.counted, ["package-lock.json", "test/fixtures/a.json", ".github/workflows/ci.yml", "src/other.ts"]);
});

test("W1-T8396: every refresh step is read by PR and red, never by head", () => {
  const records = refreshRecordsFromLedger([
    { step: "fix.base_refreshed", pr_number: 1, matching_base_files: ["src/a.ts"] },
    { step: "fix.base_refreshed", pr_number: 2, red_checks: ["ci"], test_files: [FILE] },
    { step: "sweep.base_red.refresh", pr_number: 3, outcome: "updated", check_names: ["ci"], files: [{ file: FILE }, { outcome: "fails" }] },
    { step: "sweep.base_red.refresh", pr_number: 4, outcome: "error: 422" },
    { step: "sweep.base_red.refresh", pr_number: 5, outcome: "updated" },
    { step: "sweep.base_fixed.refresh", pr_number: 5, outcome: "updated", test_files: [FILE] },
    { step: "sweep.base_fixed.refresh", outcome: "updated", test_files: [FILE] },
  ]);
  assert.deepEqual([...records.keys()], [2, 3, 5], "a legacy fix row names no red; a failed update made no head");
  assert.deepEqual(records.get(3), [{ checks: ["ci"], testFiles: [FILE] }]);
  assert.equal(refreshedOnSameRed(records, 2, ["ci"], [FILE]), true);
  assert.equal(refreshedOnSameRed(records, 2, ["lint"], [FILE]), false, "another check is another red");
  assert.equal(refreshedOnSameRed(records, 2, ["ci"], ["test/other.test.ts"]), false, "another test file is another red");
  assert.equal(refreshedOnSameRed(records, 2, ["ci"], []), false);
  assert.equal(refreshedOnSameRed(records, 5, ["anything"], ["test/other.test.ts"]), true, "a fileless legacy row matches any red");
  assert.equal(refreshedOnSameRed(records, 9, ["ci"], [FILE]), false);
});

test("W1-T8396: a refusal is decided once per head and main, not re-probed every pass", async () => {
  const h = harness([mainHealth()], { baseChanged: ["src/lib/sweep.ts"], merged: "fails" });
  const deps = { ...h.deps, dispatchFix: () => {} };
  await runSweep([redPr(), peer()], deps, DEFAULT_SWEEP_POLICY);
  await runSweep([redPr(), peer()], deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.merges, [`${HEAD}+${MAIN}`], "the second pass reuses the recorded refusal");
  assert.equal(clearances(h.rows).length, 1);
  assert.deepEqual(h.refreshed, []);

  // An unreadable compare or closure is no evidence: the trial merge decides.
  const unread = harness([mainHealth()], { baseChanged: PLAN_DELTA, merged: "fails" });
  unread.deps.readRedBaseRefreshFacts = async () => { throw new Error("compare 502"); };
  unread.deps.readTestImportClosure = async () => { throw new Error("tree unreadable"); };
  await runSweep([redPr(), peer()], unread.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(unread.merges, [`${HEAD}+${MAIN}`]);
  assert.equal(clearances(unread.rows)[0]?.counted_paths, undefined);
});

function scratch(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t8396-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("W1-T8396: the production closure reads both trees and main's tip through git", async (t) => {
  const origin = gitRepo({ bare: true, kind: "w8396-origin" });
  const repo = gitRepo({ kind: "w8396-tree" });
  t.after(() => { repo.cleanup(); origin.cleanup(); });
  const write = (path: string, text: string) => {
    mkdirSync(join(repo.dir, path, ".."), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  };
  write("src/lib/a.ts", `import {\n  b,\n} from "./b.js";\nexport const a = b;\n`);
  write("src/lib/b.ts", "export const b = 1;\n");
  write("src/lib/c.ts", "export const c = 2;\n");
  write("test/a.test.ts", `import { a } from "../src/lib/a.js";\nconst helper = "test/helpers/h.ts";\nvoid a; void helper;\n`);
  write("test/helpers/h.ts", "export {};\n");
  write("plan/tasks.d/x.yaml", "id: x\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "main");
  const main = repo.git("rev-parse", "HEAD");
  // The head adds an import main does not have, and a test main has never seen.
  repo.git("checkout", "-q", "-b", "pr");
  write("src/lib/a.ts", `import { b } from "./b.js";\nimport { c } from "./c.js";\nexport const a = b + c;\n`);
  write("test/new.test.ts", `import "../src/lib/c.js";\n`);
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "head");
  const head = repo.git("rev-parse", "HEAD");
  repo.git("checkout", "-q", "main");
  repo.addRemote("origin", origin.dir);
  repo.git("push", "-q", "origin", "main");

  const logged: string[] = [];
  const read = buildImportClosureRead(repo.dir, (step) => { logged.push(step); });
  const closure = await read({ prNumber: 7, headSha: head }, ["test/a.test.ts", "test/new.test.ts", "test/gone.test.ts"], main);
  assert.deepEqual([...closure!.get("test/a.test.ts")!].sort(),
    ["src/lib/a.ts", "src/lib/b.ts", "src/lib/c.ts", "test/a.test.ts", "test/helpers/h.ts"]);
  assert.deepEqual([...closure!.get("test/new.test.ts")!].sort(), ["src/lib/c.ts", "test/new.test.ts"]);
  assert.equal(closure!.has("test/gone.test.ts"), false, "a test on neither tree has an unknown closure");
  assert.equal(await read({ prNumber: 7, headSha: "f".repeat(40) }, ["test/a.test.ts"], main), undefined,
    "an unreadable head is no closure at all");
  assert.deepEqual(logged, ["refresh.clearance.closure_unreadable"]);
  assert.equal(await mainTipViaGit(repo.dir), main);
});

test("W1-T8396: the trial-merge probe merges the head into main's tip and caches apart from main's probe", async (t) => {
  const root = scratch(t);
  const calls: string[][] = [];
  const inTree: Array<{ tree: string; args: string[] }> = [];
  const executions: string[] = [];
  let present = false;
  const probeDeps = {
    readLedger: () => [{ step: "sweep.base_reproduction", main_sha: MAIN, files: [{ file: FILE, outcome: "passes" }] }],
    git: async (args: string[]) => { calls.push(args); },
    treeGit: async (tree: string, args: string[]) => {
      inTree.push({ tree, args });
      if (args[0] === "cat-file" && !present) throw new Error("missing object");
    },
    link: () => "linked" as const,
    readFile: async () => "contents",
    execute: async (proof: { label: string }) => { executions.push(proof.label); return "fail" as const; },
    timeout: () => 60_000,
  };
  const probeMerge = buildBaseReproductionProbe({ root } as Config, join(root, "repo"), "unused", () => {}, { ...probeDeps, merge: true });
  const first = await probeMerge({ prNumber: PR, headSha: HEAD } as OpenPrView, [FILE], MAIN);
  assert.deepEqual(first.map(({ file, outcome, cached }) => ({ file, outcome, cached })), [{ file: FILE, outcome: "fails", cached: false }],
    "main's recorded pass is not the merged tree's outcome");
  assert.deepEqual(executions, [FILE]);
  const worktree = calls.find((args) => args.includes("worktree") && args.includes("add"))!;
  assert.ok(worktree.includes(MAIN));
  const wt = worktree[worktree.indexOf("--detach") + 1]!;
  assert.match(wt, /merge-4{12}$/);
  assert.ok(inTree.every(({ tree }) => tree === wt), "every merge step runs in the probe tree");
  assert.ok(inTree.some(({ args }) => args.includes("fetch") && args.includes(`+refs/pull/${PR}/head`)), "a head the checkout lacks is fetched");
  const merge = inTree.find(({ args }) => args.includes("merge"))!.args;
  assert.equal(merge.at(-1), HEAD);
  assert.ok(merge.includes("--no-edit") && merge.includes("--no-verify"));

  const again = await probeMerge({ prNumber: PR, headSha: HEAD } as OpenPrView, [FILE], MAIN);
  assert.equal(again[0]?.cached, true);
  assert.deepEqual(executions, [FILE]);
  present = true;
  inTree.length = 0;
  await probeMerge({ prNumber: PR, headSha: "5".repeat(40) } as OpenPrView, [FILE], MAIN);
  assert.equal(inTree.some(({ args }) => args.includes("fetch")), false, "a head the checkout has is not fetched");
  assert.deepEqual(executions, [FILE, FILE]);
});

test("W1-T8396: the trial merge really merges the head through the hardened leaf", async (t) => {
  const repo = gitRepo({ kind: "w8396-merge" });
  t.after(() => repo.cleanup());
  writeFileSync(join(repo.dir, "base.txt"), "main\n");
  repo.git("add", "base.txt");
  repo.git("commit", "-q", "-m", "main side");
  const main = repo.git("rev-parse", "HEAD");
  repo.git("checkout", "-q", "-b", "pr", "HEAD~1");
  writeFileSync(join(repo.dir, "head.txt"), "head\n");
  repo.git("add", "head.txt");
  repo.git("commit", "-q", "-m", "head side");
  const head = repo.git("rev-parse", "HEAD");
  repo.git("checkout", "-q", "main");
  const root = scratch(t);
  const seen: string[] = [];
  const probeMerge = buildBaseReproductionProbe({ root } as Config, repo.dir, "unused", () => {}, {
    readLedger: () => [], link: () => "linked", readFile: async () => "contents", timeout: () => 60_000, merge: true,
    execute: async (_proof, dir) => {
      seen.push(...["base.txt", "head.txt"].filter((name) => existsSync(join(dir, name))));
      return "pass";
    },
  });
  const result = await probeMerge({ prNumber: 3, headSha: head } as OpenPrView, ["test/merged.test.ts"], main);
  assert.equal((result as { setup_error?: string }).setup_error, undefined);
  assert.equal(result[0]?.outcome, "passes");
  assert.deepEqual(seen, ["base.txt", "head.txt"], "the probe ran on a tree holding both main's and the head's commits");
  assert.equal(existsSync(join(root, "worktrees", `base-repro-${main.slice(0, 12)}-merge-${head.slice(0, 12)}`)), false, "the probe tree is removed");
});
