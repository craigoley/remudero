import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

import type { Config } from "#src/lib/config.js";
import { designHoldCoverage, PARKED_PR_REMEDY_STEP, parkedPrFacts, type ParkedPrHost } from "#src/lib/parked-pr-remedy.js";
import { runSweep, type OpenPrView, type SweepDeps, type UpdateBranchOutcome } from "#src/lib/sweep.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { runFixRung } from "#test/helpers/run-task-test.js";

// W1-T13046: 408 sweep.disposed rows with a design hold on 20 pull requests (2026-11-08 to 2026-11-15), 65.4 PR-hours.
// No fix.needs_design row named what it was about, so the parked-PR remedy gave fix-on-pr, the fix lane stood down
// again and opened a needs-human issue. The hold now names its criteria and checks, and the sweep splits or rebuilds.

type Row = { step: string } & Record<string, unknown>;
type Run = Parameters<typeof runFixRung>[0];

const mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 } as const;
const FIX_CLAIM = "repair failing check";
const FIX_PR = 5532;

function fixRound(report: string) {
  const repo = gitRepo({ kind: "design-hold-covers" });
  repo.git("config", "user.name", "fixture");
  repo.git("config", "user.email", "fixture@example.invalid");
  mkdirSync(join(repo.dir, "src"));
  writeFileSync(join(repo.dir, "src/fix.ts"), "old source\n");
  repo.git("add", "-A");
  repo.git("commit", "-qm", "seed");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const rows: Row[] = [];
  let creates = 0;
  const review = {
    state: "failure", criteria: [{ claim: FIX_CLAIM, proof: "unit test: repair", met: false, reason: "broken", proof_exec: "not_executable" }],
    testTheater: false, summary: "broken", floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
    headSha: "head-a", reviewerOutcome: "failure",
  } as Run["initialReview"];
  const worker: WorkerResult = {
    sessionId: "fix-session", costUsd: 1, numTurns: 2, text: report, blocks: [], stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
    model: "sonnet", effort: "medium", tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false, provider: "claude",
  };
  const run: Run = {
    taskId: "W1-T5532", runId: "covers-run", task: { id: "W1-T5532", title: "typed fix", files: ["src/fix.ts"] },
    prUrl: `https://github.com/acme/remudero/pull/${FIX_PR}`, branch: "run-W1-T5532-1",
    worktreePath: repo.dir, initialSessionId: "initial", mount, settingsFile: join(repo.dir, "settings.json"),
    config: { root: repo.dir, workerProviders: { harnessCommitsFix: true } } as Config,
    budgetUsd: 10, strikeCap: 2, initialReview: review,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: repo.dir, reviewerMount: mount },
    escalationJudge: async () => ({ decision: "deliver", reason: "test" }),
    deps: {
      spawn: async () => worker,
      waitForCiGreen: async () => "green",
      runReview: async () => ({ ...review, state: "success" }),
      fetchPrBody: async () => "REPORT", push: () => {},
      issues: { create: () => { creates++; return "https://github.com/acme/remudero/issues/1"; }, listOpen: () => [], comment: () => {} },
      ledgerPath: join(repo.dir, "ledger.ndjson"), ledgerLines: () => rows,
      log: (step, extra) => rows.push({ step, task_id: "W1-T5532", ...extra }), say: () => {}, account: (r) => r,
    },
  };
  return { run, rows, creates: () => creates };
}

test("W1-T13046 criterion 1: the fix.needs_design row records the criteria and checks the round was given", async () => {
  const f = fixRound("REPORT\nFIX_OUTCOME: NEEDS_DESIGN which store owns retries?");
  assert.equal((await runFixRung(f.run)).outcome, "needs_design");
  const row = f.rows.find(r => r.step === "fix.needs_design")!;
  assert.deepEqual(row.covers_criteria, [FIX_CLAIM], "the unmet claims the round was given");
  assert.deepEqual(row.covers_checks, [], "a review round was given no red check");
  assert.deepEqual(designHoldCoverage(row), { criteria: [FIX_CLAIM], checks: [] });
  assert.equal(designHoldCoverage({ step: "fix.needs_design", reason: "an old row" }), undefined, "a row from before the fields has no coverage");
  assert.deepEqual(designHoldCoverage({ covers_checks: ["ci"] }), { criteria: [], checks: ["ci"] });
});

test("W1-T13046 criterion 4: invariant:no-design-issue, a remedied design hold stands down without a needs-human issue", async () => {
  const control = fixRound("REPORT\nFIX_OUTCOME: NEEDS_DESIGN which store owns retries?");
  await runFixRung(control.run);
  const unremedied = await runFixRung(control.run);
  assert.equal(unremedied.outcome, "needs_design");
  assert.equal(control.creates(), 1, "without a remedy row the fix rung opens a needs-human issue");

  const f = fixRound("REPORT\nFIX_OUTCOME: NEEDS_DESIGN which store owns retries?");
  await runFixRung(f.run);
  f.rows.push({ step: PARKED_PR_REMEDY_STEP, task_id: "W1-T5532", pr_number: FIX_PR, head_sha: "head-a", cause: "needs-design",
    remedy: "split-follow-up", outcome: "taken" });
  for (let pass = 0; pass < 2; pass++) {
    const out = await runFixRung(f.run);
    assert.equal(out.outcome, "needs_design");
    assert.equal(out.issueUrl, undefined);
  }
  assert.equal(f.creates(), 0, "escalateForTask is never called");
  const stands = f.rows.filter(r => r.step === "fix.stood_down" && r.site === "rung.needs_design");
  assert.equal(stands.length, 2);
  assert.ok(stands.every(r => r.issue_url === undefined), "no fix.stood_down row carries an issue_url");

  const other = fixRound("REPORT\nFIX_OUTCOME: NEEDS_DESIGN which store owns retries?");
  await runFixRung(other.run);
  other.rows.push({ step: PARKED_PR_REMEDY_STEP, pr_number: FIX_PR + 1, head_sha: "head-a", remedy: "split-follow-up", outcome: "taken" },
    { step: PARKED_PR_REMEDY_STEP, pr_number: FIX_PR, head_sha: "head-b", remedy: "split-follow-up", outcome: "taken" });
  await runFixRung(other.run);
  assert.equal(other.creates(), 1, "a remedy row for another pull request or head releases nothing");
});

// ── the sweep ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const TASK = "W1-T13046-FIXTURE";
const PR = 13046;
const PR_URL = `https://github.com/o/remudero/pull/${PR}`;
const HEAD = "13046ab".padEnd(40, "1");
const MAIN = "a".repeat(40);
const NOW = Date.parse("2026-11-16T12:00:00Z");
const CLAIMS = ["the first criterion holds", "the second criterion needs a design answer", "the third criterion holds too"];
const CHECK = "ci-shard (1/8)";
const SHARD_REL = `plan/tasks.d/${TASK}-a-fixture-task.yaml`;
const shard = [`- id: ${TASK}`, "  title: \"A fixture task\"", "  repo: remudero", "  files:", "    - src/x.ts", "  status: queued",
  "  attempts: 0", "  acceptance:", ...CLAIMS.flatMap(c => [`    - claim: "${c}"`, `      proof: "grep: ${c} in src/x.ts"`]),
  "  rationale: |", "    WHY: a fixture.", ""].join("\n");

function parkedHost() {
  const landed: { relPath: string; content: string }[][] = [];
  const closed: string[] = [];
  let next = 99000;
  const h: ParkedPrHost = {
    readTaskShard: (id) => id === TASK ? { relPath: SHARD_REL, text: shard } : undefined,
    reserveTaskId: () => `W1-T${++next}`,
    landTaskFiles: async (files) => { landed.push(files.map(f => ({ relPath: f.relPath, content: f.content }))); return { prUrl: "https://github.com/o/remudero/pull/99999" }; },
    closePr: async (prUrl) => { closed.push(prUrl); },
  };
  return { h, landed, closed };
}

const unmet = (claims: readonly string[]) => claims.map(claim => ({ claim, proof: `grep: ${claim} in src/x.ts`, met: false,
  reason: `${claim} is not met`, proof_exec: "executed_fail" })) as OpenPrView["unmetCriteria"];

const view = (over: Partial<OpenPrView> = {}): OpenPrView => ({
  prNumber: PR, prUrl: PR_URL, taskId: TASK, headSha: HEAD, checksState: "red", reviewState: "pending", unmetCriteria: [],
  priorStrikes: 1, autoMergeArmed: false, lastActivityAt: new Date(NOW).toISOString(),
  ciFailures: [{ name: CHECK, logTail: "not ok 1 - a test" }], ...over,
});

function designRows(covers: { criteria?: readonly string[]; checks?: readonly string[] }): Row[] {
  const common = { task_id: TASK, head_sha: HEAD, run_id: "DESIGN-ROUND", host: "fixture-host", actor_pid: 777 };
  const round = { ...common, round_id: "DESIGN-ROUND:1", repair_pr_url: PR_URL };
  return [
    { ...round, step: "fix.dispatch", ts: new Date(NOW - 3000).toISOString(), mode: "ci-log" },
    { ...common, step: "fix.needs_design", ts: new Date(NOW - 2000).toISOString(), contract_revision: "contract-A",
      reason: "which store owns the retries?",
      ...(covers.criteria === undefined ? {} : { covers_criteria: covers.criteria }), ...(covers.checks === undefined ? {} : { covers_checks: covers.checks }) },
    { ...round, step: "fix.done", ts: new Date(NOW - 1000).toISOString(), fix_outcome: "NEEDS_DESIGN", subtype: "success" },
  ];
}

function sweepWorld(rows: Row[], parked: ParkedPrHost, opts: { behind?: number } = {}) {
  const state = { escalated: 0, dispatched: 0, refreshed: 0 };
  const deps: SweepDeps = {
    ledgerPath: "/unused/design-hold-covers-ledger", runId: "W1-T13046-test", now: () => NOW,
    readLedger: () => rows, readHeadContractRefreshHistory: async () => ({ complete: true, lines: rows }),
    appendLine: (_path, row) => { rows.push(row as Row); },
    fixProgressJudge: async () => ({ verdict: "continue", reason: "the judge permits another round" }),
    readTaskContractRevision: () => "contract-A",
    readMainTip: async () => MAIN,
    behindMainByPr: new Map([[PR, opts.behind ?? 0]]),
    updateBranch: async (): Promise<UpdateBranchOutcome> => { state.refreshed++; return "updated"; },
    arm: () => {}, close: () => {},
    escalate: () => { state.escalated++; },
    dispatchFix: () => { state.dispatched++; },
    claimFixAdmission: () => ({ admitted: true }),
    parkedPr: parked,
  };
  return { deps, state, remedies: () => rows.filter(r => r.step === PARKED_PR_REMEDY_STEP) };
}

const yamlTask = (content: string) => (parse(content) as Record<string, unknown>[])[0]!;

test("W1-T13046 criterion 2: parkedPrFacts marks only the covered unmet criteria as needing input, and ladder-spent", () => {
  const pr = { prNumber: PR, prUrl: PR_URL, headSha: HEAD, taskId: TASK, unmetCriteria: unmet([CLAIMS[0]!, CLAIMS[1]!]) };
  const { h } = parkedHost();
  const covered = parkedPrFacts(pr, { redChecks: [], designQuestion: "which store?", fixModelOrder: ["fix"],
    designCoverage: { criteria: [CLAIMS[1]!], checks: [] } }, [], h);
  assert.deepEqual(covered.unmetCriteria.map(c => [c.claim, c.needsInput, c.ladderSpent]),
    [[CLAIMS[0], false, false], [CLAIMS[1], true, true]], "the uncovered criterion stays fixable");
  assert.equal(covered.taskCriteria, 3);
  const legacy = parkedPrFacts(pr, { redChecks: [], designQuestion: "which store?", fixModelOrder: ["fix"] }, [], h);
  assert.deepEqual(legacy.unmetCriteria.map(c => c.needsInput), [true, true], "a row without covers fields keeps today's rule");
  const checks = parkedPrFacts({ ...pr, unmetCriteria: [] }, { redChecks: [CHECK, "other"], designQuestion: "which store?",
    fixModelOrder: ["fix"], designCoverage: { criteria: [], checks: [CHECK, "now green"] } }, [], h);
  assert.deepEqual(checks.designHoldChecks, [CHECK], "only a covered check that is red now counts");
});

test("W1-T13046 criterion 3: runSweep splits a partly covered hold and rebuilds a fully covered or check-only hold", async () => {
  // Some criteria covered: split-follow-up for the covered ones.
  const split = parkedHost();
  const splitRows = designRows({ criteria: [CLAIMS[1]!], checks: [] });
  const s = sweepWorld(splitRows, split.h);
  await runSweep([view({ reviewState: "failure", checksState: "green", ciFailures: [], unmetCriteria: unmet([CLAIMS[0]!, CLAIMS[1]!]) })], s.deps);
  assert.deepEqual(s.remedies().map(r => [r.remedy, r.cause, r.outcome]), [["split-follow-up", "needs-design", "taken"]]);
  assert.deepEqual((yamlTask(split.landed[0]![0]!.content).acceptance as { claim: string }[]).map(c => c.claim), [CLAIMS[1]]);
  assert.deepEqual((yamlTask(split.landed[0]![1]!.content).acceptance as { claim: string }[]).map(c => c.claim), [CLAIMS[0], CLAIMS[2]]);
  assert.equal(split.closed.length, 0);
  assert.equal(s.state.escalated, 0);

  // Every criterion covered: close-and-rebuild.
  const all = parkedHost();
  const allRows = designRows({ criteria: CLAIMS, checks: [] });
  const a = sweepWorld(allRows, all.h);
  await runSweep([view({ reviewState: "failure", checksState: "green", ciFailures: [], unmetCriteria: unmet(CLAIMS) })], a.deps);
  assert.deepEqual(a.remedies().map(r => r.remedy), ["close-and-rebuild"]);
  assert.deepEqual(all.closed, [PR_URL]);
  assert.equal(a.state.escalated, 0);

  // Only red checks covered: close-and-rebuild, since a red check cannot leave the task.
  const red = parkedHost();
  const redRows = designRows({ criteria: [], checks: [CHECK] });
  const r = sweepWorld(redRows, red.h);
  await runSweep([view()], r.deps);
  assert.deepEqual(r.remedies().map(row => row.remedy), ["close-and-rebuild"]);
  assert.deepEqual(red.closed, [PR_URL]);
  assert.deepEqual((yamlTask(red.landed[0]![0]!.content).acceptance as { claim: string }[]).map(c => c.claim), CLAIMS);

  for (const w of [s, a, r]) assert.ok(w.remedies().every(row => row.remedy !== "fix-on-pr"), "no design hold takes fix-on-pr");

  // Control: the same check-only hold with no covers fields keeps today's fix-on-pr.
  const legacy = parkedHost();
  const l = sweepWorld(designRows({}), legacy.h);
  await runSweep([view()], l.deps);
  assert.deepEqual(l.remedies().map(row => row.remedy), ["fix-on-pr"]);
});

test("W1-T13046 criterion 5: invariant:main-first, a due main adoption comes before any split or close", async () => {
  const parked = parkedHost();
  const rows = designRows({ criteria: [CLAIMS[1]!], checks: [] });
  const w = sweepWorld(rows, parked.h, { behind: 3 });
  const pr = view({ reviewState: "failure", checksState: "green", ciFailures: [], unmetCriteria: unmet([CLAIMS[0]!, CLAIMS[1]!]) });
  await runSweep([pr], w.deps);
  assert.equal(w.state.refreshed, 1, "the branch takes main first");
  assert.deepEqual(w.remedies(), [], "no remedy while the adoption is due");
  assert.equal(parked.landed.length + parked.closed.length, 0, "no split and no close");
  await runSweep([pr], w.deps);
  assert.equal(w.state.refreshed, 1);
  assert.deepEqual(w.remedies().map(r => r.remedy), ["split-follow-up"], "once the adoption is spent, the hold splits what it covers");
  assert.equal(w.state.escalated, 0);
});
