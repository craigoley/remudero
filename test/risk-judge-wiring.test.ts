import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * W1-T248 (P34 clause (b)): the risk judge is wired into run-task.ts's dispatch
 * path. Mirrors test/arm-at-open.test.ts's own "MECHANISM" tests and its own
 * documented rationale for doing so at SOURCE level rather than driving a full
 * green-CI real merge through `runTask()`: that file's header comment states
 * outright that the capped-verdict mitigation is "proven at SOURCE level rather
 * than by driving a real runTask() through the review gate — deliberately, not
 * by omission." The risk judge sits on the SAME call path (between the
 * capped-refusal branch and `pollToGate`), so the same technique applies.
 *
 * The judge's own decision logic (proceed/escalate, fail-closed on
 * unavailability, stability, mount resolution, ledgering) is fully
 * behaviorally unit-tested in test/risk-judge.test.ts — this file proves only
 * that run-task.ts actually WIRES that module in, at the right place, in the
 * right order.
 */

const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");

test("run-task.ts imports the risk judge module and resolves its mount from the committed mounts.yaml (W1-T5), not a hardcoded literal", () => {
  assert.match(runTaskSrc, /from "\.\/lib\/risk-judge\.js"/);
  assert.match(runTaskSrc, /resolveRiskJudgeMount\(loadMounts\(mountsPath\(repoRoot\)\)\)/);
});

test("runRiskJudge has EXACTLY ONE call site in run-task.ts's dispatch path", () => {
  const calls = runTaskSrc.match(/runRiskJudge\(/g) ?? [];
  assert.equal(calls.length, 1, "a second call site would mean a second, un-reviewed dispatch decision path");
});

test("the risk judge call sits BETWEEN the capped-refusal branch and pollToGate — every candidate change is assessed before the merge gate", () => {
  const cappedReturnIdx = runTaskSrc.indexOf('return { taskId, runId, prUrl, merged: false, costUsd, verdict: "blocked" };\n    }\n\n    // ── RISK JUDGE');
  assert.ok(cappedReturnIdx >= 0, "the risk judge block must immediately follow the capped-refusal branch's closing brace");

  const riskJudgeCallIdx = runTaskSrc.indexOf("await runRiskJudge(");
  assert.ok(riskJudgeCallIdx > cappedReturnIdx, "runRiskJudge must be called AFTER the capped-refusal branch");

  const pollIdx = runTaskSrc.indexOf("const outcome = await pollToGate(prUrl,");
  assert.ok(pollIdx > riskJudgeCallIdx, "pollToGate must be reached only AFTER the risk judge has had its say");

  // Nothing else calls pollToGate or armAutoMerge in between (the gap is the
  // risk-judge block ITSELF, not some other unrelated logic).
  const between = runTaskSrc.slice(riskJudgeCallIdx, pollIdx);
  assert.doesNotMatch(between, /pollToGate\(/, "pollToGate must not appear again before the real call");
  assert.doesNotMatch(between, /armAutoMerge\(prUrl, taskId\)/, "no re-arm may happen in the risk-judge gap");
});

test("on ESCALATE, the wiring withdraws the early arm-at-open BEFORE calling escalate() — same W1-T125 shape as the capped-refusal branch", () => {
  const escalateDepsIdx = runTaskSrc.indexOf("escalate: (verdict, action) => {");
  assert.ok(escalateDepsIdx >= 0, "the risk judge's escalate dependency closure must exist");

  // W1-T1215: the return is no longer discarded — it goes to `disposeDisarm`, which decides the
  // ledger step and whether a lost race escalates. The BEFORE-escalate ordering is unchanged.
  const disarmIdx = runTaskSrc.indexOf("disposeDisarm(disarmAutoMerge(prUrl)", escalateDepsIdx);
  assert.ok(disarmIdx > escalateDepsIdx, "the withdrawal must still happen inside the escalate closure");

  const realEscalateCallIdx = runTaskSrc.indexOf("return escalate(", escalateDepsIdx);
  assert.ok(realEscalateCallIdx > disarmIdx, "the real escalate() call must come AFTER the disarm, never before");
  assert.ok(realEscalateCallIdx - disarmIdx < 700, "the escalate() call must be the SAME closure's own call, not an unrelated one elsewhere");

  // W1-T1215: the step is computed from the outcome, so this pins the LOG rather than a literal
  // step name — asserting `automerge.disarmed` verbatim here would re-assert the removed defect.
  const disarmedLedgerIdx = runTaskSrc.indexOf("log(disposition.step, disposition.row)", escalateDepsIdx);
  assert.ok(
    disarmedLedgerIdx > disarmIdx && disarmedLedgerIdx < realEscalateCallIdx,
    "the disarm must be ledgered, attributably, between the disarm call and the escalate call",
  );
});

test("on ESCALATE, run-task.ts returns a terminal blocked verdict WITHOUT ever reaching pollToGate", () => {
  const escalateBranchIdx = runTaskSrc.indexOf('if (riskJudgeResult.action.kind === "escalate")');
  assert.ok(escalateBranchIdx >= 0);
  // W1-T268: the ledger line grew two fields (billing_mode, account_label) — widened
  // from 500 so the window still reaches the branch's `return` statement below.
  const branchSlice = runTaskSrc.slice(escalateBranchIdx, escalateBranchIdx + 650);
  assert.match(branchSlice, /verdict:\s*"blocked"/);
  assert.match(branchSlice, /return \{ taskId, runId, prUrl, merged: false, costUsd, verdict: "blocked" \};/);
  assert.doesNotMatch(branchSlice, /pollToGate\(/, "the escalate branch must return before ever polling the merge gate");
});

test("the risk judge is given the candidate CHANGE's own description/files and gates state — NEVER task.risk (the static sizing artifact)", () => {
  const inputIdx = runTaskSrc.indexOf("const riskJudgeInput: RiskJudgeInput = {");
  assert.ok(inputIdx >= 0);
  const inputSlice = runTaskSrc.slice(inputIdx, inputIdx + 500);
  assert.match(inputSlice, /change:\s*\{\s*description:/);
  assert.match(inputSlice, /gatesState:\s*\{/);
  assert.match(inputSlice, /planContext:\s*\{/);
  // task.risk must not appear anywhere in the constructed input literal.
  assert.doesNotMatch(inputSlice, /task\.risk\b/, "the static task.risk field must never feed the risk judge's input");
});
