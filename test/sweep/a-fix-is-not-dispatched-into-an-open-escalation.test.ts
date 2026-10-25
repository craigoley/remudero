import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { runSweep, runSweepLightPass, fixSeedRead, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import { buildFixRungDispatchArgs, buildSweepEffects, runFixRung, taskContractRevision } from "#src/run-task.js";

type OpenIssue = Awaited<ReturnType<NonNullable<SweepDeps["readOpenEscalations"]>>>[number];

const TASK = "PR-13218";
const HEAD = "2f835be";
const URL = "https://github.com/craigoley/remudero/pull/13218";
const task = { id: TASK, title: "repair the failing check", files: ["src/example.ts"],
  acceptance: [{ claim: "the check passes", proof: "unit test: the check passes" }] };

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rmd-open-escalation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = Date.now();
  const rows: Record<string, unknown>[] = [
    { ts: new Date(now - 2000).toISOString(), run_id: "prior", task_id: TASK,
      step: "sweep.disposed", disposition: "blocked-fixable", acted: true, pr_number: 13218, head_sha: HEAD },
    { ts: new Date(now - 1000).toISOString(), run_id: "prior", task_id: TASK,
      step: "fix.stood_down", site: "rung.strike", reason: "ALREADY OPEN", head_sha: HEAD },
  ];
  const pr: OpenPrView = { prNumber: 13218, prUrl: URL, taskId: TASK, headSha: HEAD,
    headRefName: "run-PR-13218-123", checksState: "red", reviewState: "pending",
    unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    lastActivityAt: new Date(now).toISOString(), redRequiredChecks: ["ci"],
    ciFailures: [{ name: "ci", logTail: "Error: expected the repair to pass" }] };
  let revision = taskContractRevision(task);
  let issues: OpenIssue[] = [{ number: 13250, url: "https://github.com/craigoley/remudero/issues/13250",
    title: "[BLOCKED] repair", body: `**Task:** ${TASK}\n**Class:** BLOCKED\n${URL}\n**Head:** ${HEAD}\n**Cause:** ci\n**Contract:** ${revision}\n` }];
  const dispatched: OpenPrView[] = [];
  const admitted: number[] = [];
  let reads = 0;
  const deps: SweepDeps = {
    ledgerPath: join(root, "ledger.ndjson"), runId: "open-escalation-test", now: () => now,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push({ ts: new Date(now).toISOString(), ...row }); },
    readTaskContractRevision: () => revision,
    readOpenEscalations: () => { reads++; return issues; },
    claimFixAdmission: view => { admitted.push(view.prNumber); return { admitted: true }; },
    dispatchFix: view => { dispatched.push(view); return false; },
    arm: () => assert.fail("a red PR must not arm"), close: () => assert.fail("no close is due"),
    escalate: () => assert.fail("the existing question must not be filed again"),
  };
  return { root, rows, pr, deps, dispatched, admitted, get issues() { return issues; },
    reads: () => reads, setIssues: (value: OpenIssue[]) => { issues = value; },
    setRevision: (value: string) => { revision = value; },
    pass: (prs = [pr]) => runSweep(prs, deps) };
}

test("W1-T10343: an open escalation holds the dispatch", async t => {
  const f = fixture(t);
  assert.equal(fixSeedRead(f.rows, f.pr, f.deps.runId)?.kind, "ended", "the prior rung ended at its open question");
  const peer = { ...f.pr, prNumber: 13219, prUrl: URL.replace("13218", "13219"), taskId: "PR-13219",
    headRefName: "run-PR-13219-123", redRequiredChecks: ["unit"],
    ciFailures: [{ name: "unit", logTail: "Error: a distinct repair is needed" }] };
  const result = await f.pass([f.pr, peer]);
  const held = result.actions.find(action => action.prNumber === 13218)!;
  assert.equal(held.acted, false);
  assert.match(held.reason, /issues\/13250/);
  assert.deepEqual(f.dispatched.map(pr => pr.prNumber), [13219], JSON.stringify(result));
  assert.deepEqual(f.admitted, [13219], "the held PR reserves no fix capacity");
  assert.equal(f.reads(), 1, "all PRs share one issue-list read");
  const row = f.rows.findLast(row => row.step === "sweep.disposed" && row.pr_number === 13218)!;
  assert.equal(row.acted, false);
  assert.match(String(row.stand_down_reason), /issues\/13250/);
  await f.pass();
  assert.equal(f.reads(), 2, "the next pass reads again rather than caching an open issue forever");
  assert.equal(f.dispatched.length, 1);
});

test("W1-T10343: a closed issue, a new head or an amended contract releases the hold", async t => {
  for (const release of ["closed", "head", "contract", "cause"] as const) {
    const f = fixture(t);
    await f.pass();
    assert.equal(f.dispatched.length, 0);
    if (release === "closed") f.setIssues([]);
    if (release === "head") f.pr.headSha = "new-head";
    if (release === "contract") f.setRevision("amended-contract");
    if (release === "cause") f.issues[0].body = f.issues[0].body!.replace("**Cause:** ci", "**Cause:** review");
    await f.pass();
    assert.equal(f.dispatched.length, 1, `${release} releases on the next pass`);
    assert.equal(f.admitted.length, 1);
  }
});

async function rung(f: ReturnType<typeof fixture>, pendingAnswer?: OpenPrView["pendingAnswer"]) {
  const mount = { model: "sonnet", effort: "medium", maxTurns: 1, contextBudget: 10000 };
  const pr = { ...f.pr, pendingAnswer };
  const args = buildFixRungDispatchArgs({ task, pr, evidence: { unmetCriteria: [], ciFailures: pr.ciFailures },
    runId: f.deps.runId, prUrl: URL, branch: pr.headRefName!, worktreePath: f.root, mount,
    settingsFile: "settings/worker.json", config: {} as never, budgetUsd: 1, strikeCap: 1,
    reviewBase: { owner: "craigoley", repo: "remudero", headCheckoutDir: f.root, reviewerMount: mount } });
  let workers = 0;
  const result = await runFixRung({ ...args, baseSha: "new-base", escalationJudge: async () => ({ decision: "deliver", reason: "fixture" }),
    deps: {
      spawn: async input => { workers++; assert.match(input.prompt, /preserve the operator boundary/);
        return { sessionId: "fixture", numTurns: 1, text: "fixed", subtype: "success", costUsd: 0,
          isError: false, apiError: false, blocks: [], stderr: "", permissionDenials: [], childEnvKeys: [],
          modelUsage: {}, compactionEvents: [], qualitySuspect: false,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } } as never; },
      runReview: async () => ({ ...args.initialReview, state: "success", criteria: [] }),
      waitForCiGreen: async () => "green", fetchPrBody: async () => `Remudero-Task: ${TASK}`,
      fetchPrDiffFiles: async () => [], push: () => {}, ledgerPath: f.deps.ledgerPath,
      issues: { create: () => assert.fail("no new escalation"), listOpen: () => f.issues,
        closeWithComment: () => { f.setIssues([]); } },
      readLiveState: async () => ({ ok: true, state: "OPEN" }),
      log: (step, extra) => { f.rows.push({ ...extra, step }); }, say: () => {}, account: value => value,
    } });
  return { result, workers, args };
}

test("W1-T10343: an operator answer releases an open escalation", async t => {
  const f = fixture(t);
  const answer = { constraint: "preserve the operator boundary" };
  f.pr.pendingAnswer = answer;
  await f.pass();
  assert.equal(f.dispatched.length, 1);
  const released = await rung(f, answer);
  assert.equal(released.result.outcome, "fixed");
  assert.equal(released.workers, 1);
  assert.equal(released.args.constraint, answer.constraint);
  assert.equal(f.issues.length, 1, "the answer releases without closing the issue");
  const spent = { ...answer, spent: true as const };
  const again = fixture(t);
  again.pr.pendingAnswer = spent;
  await again.pass();
  assert.equal(again.dispatched.length, 0, "a spent answer holds again");
  const held = await rung(again, spent);
  assert.equal(held.result.outcome, "stood_down");
  assert.equal(held.workers, 0);
  assert.equal(held.args.constraint, answer.constraint, "spent feedback remains context, but never releases a hold");
});

test("W1-T10343: unreadable and unwired issue lists fail open", async t => {
  for (const list of ["unreadable", "unwired", "empty"] as const) {
    const f = fixture(t);
    if (list === "unreadable") f.deps.readOpenEscalations = () => { throw Error("issue list unavailable"); };
    if (list === "unwired") f.deps.readOpenEscalations = undefined;
    if (list === "empty") f.setIssues([]);
    f.deps.readTaskContractRevision = () => assert.fail("no open issue needs a contract comparison");
    await f.pass();
    assert.equal(f.dispatched.length, 1);
    assert.equal(f.admitted.length, 1);
  }
});

test("W1-T10343: production effects read the needs-human gateway", async t => {
  const f = fixture(t);
  const labels: string[] = [];
  const args = { owner: "craigoley", repo: "remudero", config: { root: f.root },
    ledgerPath: f.deps.ledgerPath, runId: f.deps.runId, plan: { tasks: [task], byId: new Map([[TASK, task]]) },
    log: () => {}, reviewRunner: async () => 0,
    issuesImpl: { create: () => assert.fail("read-only"), listOpen: (label: string) => { labels.push(label); return f.issues; } },
  };
  const effects = buildSweepEffects(args as never);
  assert.deepEqual(await effects.readOpenEscalations!(), f.issues);
  assert.deepEqual(labels, ["needs-human"]);
  const unwired = buildSweepEffects({ ...args, issuesImpl: { create: () => assert.fail("read-only") } } as never);
  assert.deepEqual(await unwired.readOpenEscalations!(), []);
});

test("W1-T10343: a light pass shares its issue read across every PR", async t => {
  const f = fixture(t);
  const peer = { ...f.pr, taskId: "PR-13219", prNumber: 13219, prUrl: URL.replace("13218", "13219") };
  f.issues.push({ ...f.issues[0], number: 13251, url: f.issues[0].url.replace("13250", "13251"),
    body: f.issues[0].body!.replaceAll("13218", "13219") });
  const summaries = await runSweepLightPass([f.pr, peer], f.deps);
  assert.equal(f.reads(), 1);
  assert.equal(f.dispatched.length, 0);
  assert.equal(f.admitted.length, 0);
  assert.equal(summaries.flatMap(summary => summary.actions).filter(action => !action.acted).length, 2);
  await runSweepLightPass([f.pr, peer], f.deps);
  assert.equal(f.reads(), 2, "each new light pass obtains a new snapshot");
});

test("W1-T10343: legacy issues without a head never hold", async t => {
  const f = fixture(t);
  f.issues[0].body = f.issues[0].body!.replace(`**Head:** ${HEAD}\n`, "");
  await f.pass();
  assert.equal(f.dispatched.length, 1);
});

test("W1-T10343: a cleared conflict releases and the rung closes its issue", async t => {
  const f = fixture(t);
  f.issues[0].body += "**Raised-by:** conflict-not-admitted\n**Base:** old-base\n";
  f.deps.readMainTip = () => "new-base";
  await f.pass();
  assert.equal(f.dispatched.length, 1);
  // The rung retains ownership of closing cleared issues.
  const released = await rung(f, { constraint: "preserve the operator boundary" });
  assert.equal(released.workers, 1);
  assert.equal(f.issues.length, 0);
});

test("W1-T10343: stand-downs at other sites keep their existing seed reading", async t => {
  const f = fixture(t);
  f.rows[1].site = "rung.entry";
  assert.equal(fixSeedRead(f.rows, f.pr, f.deps.runId)?.kind, "ended");
  f.setIssues([]);
  await f.pass();
  assert.equal(f.dispatched.length, 1);
});
