import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSweep, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import { buildFixProgressInput, resolveFixProgress, type FixProgressJudge, type FixProgressWitness } from "#src/lib/fix-progress-judge.js";
import { runFixRung, buildFixRungDispatchArgs, type ReviewRunResult } from "#test/helpers/run-task-test.js";

const TASK = "W1-T9502";
const HEAD = "999a5dc";

function fixture(judge: FixProgressJudge = async () => ({ verdict: "continue", reason: "the current evidence permits repair" })) {
  const now = Date.now();
  const rows: Record<string, unknown>[] = [];
  let calls = 0;
  let contract = "contract-A";
  const view = (over: Partial<OpenPrView> = {}): OpenPrView => ({
    prNumber: 11559, prUrl: "https://github.com/fixture/repo/pull/11559", taskId: TASK,
    headSha: HEAD, checksState: "red", reviewState: "pending", unmetCriteria: [],
    priorStrikes: 1, autoMergeArmed: false, lastActivityAt: new Date(now).toISOString(),
    reviewInputDigest: "body-A", redRequiredChecks: ["ci"],
    ciFailures: [{ name: "ci", logTail: "Error: initial failing evidence" }], ...over,
  });
  const deps: SweepDeps = {
    ledgerPath: "/unused/progress-reuse-ledger", runId: "progress-reuse-test", now: () => now,
    readLedger: () => rows,
    appendLine: (_path, row) => { rows.push({ ts: new Date(now).toISOString(), ...row }); },
    readTaskContractRevision: () => contract,
    fixProgressJudge: async input => { calls++; return judge(input); },
    claimFixAdmission: () => ({ admitted: false, reason: "fixture host memory admission refused" }),
    dispatchFix: () => { assert.fail("a refused admission must not dispatch a worker"); },
    arm: () => { assert.fail("red CI is not mergeable"); },
    close: () => { assert.fail("no close was authorized"); },
    escalate: () => { assert.fail("these verdicts do not authorize an escalation"); },
  };
  return { rows, deps, view, calls: () => calls, setContract: (value: string) => { contract = value; },
    pass: (over: Partial<OpenPrView> = {}) => runSweep([view(over)], deps) };
}

test("W1-T9502: an unchanged input reuses its ledgered verdict", async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) await f.pass();
  assert.equal(f.calls(), 1, "three refused-admission passes must ask the same question once");
  const judged = f.rows.filter(row => row.step === "fix.progress_judged");
  const reused = f.rows.filter(row => row.step === "fix.progress_reused");
  assert.equal(judged.length, 1);
  assert.equal(reused.length, 2);
  for (const row of reused) {
    assert.equal(row.pr_number, 11559);
    assert.equal(row.head_sha, HEAD);
    assert.equal(row.input_key, judged[0].input_key);
    assert.equal(row.verdict, "continue");
    assert.equal(row.judged_at, judged[0].ts, "reuse keeps the original decision time");
  }
  assert.equal(f.rows.filter(row => row.step === "fix.dispatch").length, 0);
});

test("W1-T9502: a changed input asks the judge again", async () => {
  const changes: Array<{ name: string; view?: Partial<OpenPrView>; contract?: string }> = [
    { name: "head", view: { headSha: "new-head" } },
    { name: "red class", view: { redRequiredChecks: ["another-gate"], ciFailures: [{ name: "another-gate", logTail: "Error: another failure" }] } },
    { name: "failure evidence", view: { ciFailures: [{ name: "ci", logTail: "Error: a different named failure" }] } },
    { name: "operator answer", view: { pendingAnswer: { constraint: "preserve this newly supplied boundary" } } },
    { name: "body-only edit", view: { reviewInputDigest: "body-B" } },
    { name: "task contract", contract: "contract-B" },
  ];
  for (const change of changes) {
    const f = fixture();
    await f.pass();
    if (change.contract) f.setContract(change.contract);
    await f.pass(change.view);
    assert.equal(f.calls(), 2, `${change.name} is a different question`);
  }
  let answers = 0;
  const f = fixture(async () => ++answers === 1 ? undefined : { verdict: "continue", reason: "the provider answered this time" });
  await f.pass();
  await f.pass();
  await f.pass();
  assert.equal(f.calls(), 2, "unavailable is re-asked; its later real answer can then be reused");
  assert.equal(f.rows.filter(row => row.step === "fix.progress_judged" && row.verdict === "unavailable").length, 1);
  assert.equal(f.rows.filter(row => row.step === "fix.progress_reused").length, 1);
});

test("W1-T9502: a reused change of approach retains its exact instruction", async () => {
  const approach = "reproduce the actual failing proof before editing its fixture";
  const f = fixture(async () => ({ verdict: "change-approach", approach, reason: "the old approach did not address this red" }));
  for (let i = 0; i < 3; i++) await f.pass();
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.rows.filter(row => row.step === "fix.progress_reused").map(row => row.approach), [approach, approach]);
});

test("W1-T9502: the newest answer owns the exact question, never an older continue", async () => {
  const input = buildFixProgressInput({ prNumber: 11559, headSha: HEAD, currentRed: ["ci"], ledger: [], strikesSpent: 1 });
  const witnesses = { reviewInputDigest: "body-A", contractRevision: "contract-A" };
  const first = await resolveFixProgress(input, [], { ...witnesses, judge: async () => ({ verdict: "continue", reason: "readable" }) });
  const older = { ...first.receipt, ...first.decision, pr_number: 11559, head_sha: HEAD, ts: "2026-10-14T03:44:00Z" };
  for (const changed of [
    { verdict: "unavailable", reason: "provider unavailable" }, { verdict: "continue", reason: "" },
    { verdict: "change-approach", reason: "incomplete instruction", approach: " " },
    { verdict: "escalate", reason: "authority required", loop: "same failure" },
    { judge_skipped: "first-round" }, { ts: "not a timestamp" },
  ]) {
    let calls = 0;
    const result = await resolveFixProgress(input, [older, { ...older, ...changed }], { ...witnesses,
      judge: async () => { calls++; return { verdict: "continue", reason: "new judgment" }; } });
    assert.equal(calls, 1, JSON.stringify(changed));
    assert.equal(result.receipt.step, "fix.progress_judged");
  }
  for (const changed of [{ pr_number: 42 }, { head_sha: "other" }, { input_key: "other-question" }]) {
    const result = await resolveFixProgress(input, [older, { ...older, ...changed }], witnesses);
    assert.equal(result.receipt.step, "fix.progress_reused", "another tuple does not shadow this question");
    assert.equal(result.receipt.judged_at, older.ts);
  }
  const round = { step: "fix.dispatch", pr_number: 11559, head_sha: HEAD, round_id: "new-round", ci_failures: ["ci"] };
  const nextInput = buildFixProgressInput({ prNumber: 11559, headSha: HEAD, currentRed: ["ci"], ledger: [round], strikesSpent: 1 });
  assert.equal((await resolveFixProgress(nextInput, [older], witnesses)).decision.verdict, "unavailable", "a new round asks again");
});

test("W1-T9502: missing input witnesses and unavailable real defaults never become cached permission", async () => {
  const input = buildFixProgressInput({ prNumber: 11559, headSha: HEAD, currentRed: ["ci"], ledger: [], strikesSpent: 1 });
  const unreadable: FixProgressWitness[] = [{}, { reviewInputDigest: "body-A" },
    { reviewInputDigest: "", contractRevision: "contract-A" }, { reviewInputDigest: "body-A", contractRevision: "" }];
  for (const witnesses of unreadable) {
    let calls = 0;
    const judge: FixProgressJudge = async () => { calls++; return { verdict: "continue", reason: "current evidence" }; };
    const first = await resolveFixProgress(input, [], { ...witnesses, judge });
    const row = { ...first.receipt, ...first.decision, pr_number: 11559, head_sha: HEAD, ts: "2026-10-14T03:44:00Z" };
    assert.equal((await resolveFixProgress(input, [row], { ...witnesses, judge })).receipt.step, "fix.progress_judged");
    assert.equal(calls, 2);
  }
  const witnesses = { reviewInputDigest: "body-A", contractRevision: null };
  const absent = await resolveFixProgress(input, [], witnesses); // REAL default: no wired model, not a fake success.
  assert.equal(absent.decision.verdict, "unavailable");
  const thrown = await resolveFixProgress(input, [], { ...witnesses, judge: async () => { throw Error("provider refused"); } });
  assert.equal(thrown.decision.verdict, "unavailable");
  assert.match(thrown.decision.reason, /provider refused/);
  const firstInput = { ...input, strikesSpent: 0 };
  const firstRound = await resolveFixProgress(firstInput, [], { ...witnesses, firstRound: true });
  assert.equal(firstRound.decision.verdict, "continue", "the unchanged first-round skip stays deterministic");
  const first = await resolveFixProgress(input, [], { ...witnesses, judge: async () => ({ verdict: "continue", reason: "unfiled PR" }) });
  const row = { ...first.receipt, ...first.decision, pr_number: 11559, head_sha: HEAD, ts: "2026-10-14T03:44:00Z" };
  assert.equal((await resolveFixProgress(input, [row], witnesses)).receipt.step, "fix.progress_reused", "explicit no-contract is readable");
});

test("W1-T9502: the real fix rung reuses its ledger answer and names the reused event", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-progress-reuse-"));
  try {
    const f = fixture(), pr = f.view(), mount = { model: "sonnet", effort: "medium", maxTurns: 1, contextBudget: 10000 };
    const rows: Record<string, unknown>[] = [
      { task_id: TASK, pr_number: pr.prNumber, step: "fix.dispatch", head_sha: HEAD, round_id: "prior", strike: 1 },
      { task_id: TASK, pr_number: pr.prNumber, step: "fix.done", head_sha: HEAD, round_id: "prior", subtype: "success", fix_outcome: "NO_CHANGE" },
    ];
    let calls = 0, workers = 0;
    const args = buildFixRungDispatchArgs({ task: { id: TASK, title: "reuse" } as never,
      pr, evidence: { unmetCriteria: [{ claim: "criterion", proof: "unit test: criterion", reason: "unmet" }] },
      runId: "reuse-rung", prUrl: pr.prUrl, branch: "run-W1-T9502-123", worktreePath: root, mount,
      settingsFile: "settings/worker.json", config: {} as never, budgetUsd: 1, strikeCap: 2,
      reviewBase: { owner: "fixture", repo: "repo", headCheckoutDir: root, reviewerMount: mount } });
    assert.equal(args.progressReviewInputDigest, "body-A", "production dispatch threads its independently read input");
    const options = { ...args, escalationJudge: async () => ({ decision: "deliver", reason: "fixture" } as const), deps: {
      fixProgressJudge: async () => { calls++; return undefined; }, ledgerLines: () => rows,
      spawn: async () => { workers++; return { sessionId: "fixture", numTurns: 1, text: "fixed", subtype: "success",
        model: "sonnet", effort: "medium", costUsd: 0, blocks: [], stderr: "", isError: false, apiError: false,
        childEnvKeys: [], modelUsage: {}, compactionEvents: [], qualitySuspect: false,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, permissionDenials: [] } as never; },
      runReview: async () => ({ ...args.initialReview, state: "success", criteria: [] } as ReviewRunResult),
      waitForCiGreen: async () => "green" as const, fetchPrBody: async () => `Remudero-Task: ${TASK}`,
      fetchPrDiffFiles: async () => [], push: () => {}, ledgerPath: join(root, "ledger.ndjson"),
      issues: { create: () => { assert.fail("no escalation is permitted"); } },
      log: (step: string, fields?: Record<string, unknown>) => { rows.push({ ...fields, step, ts: "2026-10-14T03:44:00Z" }); },
      say: () => {}, account: <T>(result: T) => result,
    } };
    assert.equal((await runFixRung(options)).outcome, "handed_off");
    assert.equal(calls, 1);
    const judged = rows.findLast(row => row.step === "fix.progress_judged")!;
    Object.assign(judged, { verdict: "continue", reason: "fixture's recorded answer permits this exact repair" });
    assert.equal((await runFixRung(options)).outcome, "fixed");
    assert.equal(calls, 1, "the second rung does not ask the model again");
    assert.equal(workers, 1);
    assert.equal(rows.findLast(row => row.step === "fix.progress_reused")?.judged_at, judged.ts);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
