import assert from "node:assert/strict";
import { test } from "node:test";
import { runSweep, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import type { FixProgressJudge } from "#src/lib/fix-progress-judge.js";

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
