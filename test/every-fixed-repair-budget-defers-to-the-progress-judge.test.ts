import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFixRung, buildSweepEffects, runPlanScopedFixRound, routeFix,
  finishTransientRetry, implementAttemptOutcome } from "./helpers/run-task-test.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { buildFixProgressInput, FIX_BUDGET_JUDGE_SITES, type FixProgressJudge } from "../src/lib/fix-progress-judge.js";
import { judgeSloRebuild, BLOCKER_SLO_MS } from "../src/lib/pr-blocker.js";
import { systemClock } from "../src/lib/clock.js";
import { createSweepFixAdmissionController, checkQueueGovernor, deriveQueueGovernorTrailingFlow,
  DEFAULT_SWEEP_POLICY, runSweep, readFixHostPressure, PLAN_REPAIR_DISPATCH_STEP, REARMED_AFTER_DISARM_STEP,
  type SweepDeps, type OpenPrView } from "../src/lib/sweep.js";

const NOW = Date.now();
const pr = (over: Partial<OpenPrView> = {}): OpenPrView => ({
  prNumber: 7243, prUrl: "https://github.com/o/r/pull/7243", taskId: "W1-T7243",
  headSha: "head", headRefName: "run-W1-T7243-123", checksState: "red", reviewState: "pending",
  unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
  lastActivityAt: new Date(NOW).toISOString(), ciFailures: [{ name: "ci", logTail: "test failed" }], ...over,
});
function fixture(rows: Record<string, unknown>[], judge: FixProgressJudge) {
  const fixed: unknown[] = [], escalated: string[] = [], planned: unknown[] = [], armed: number[] = [];
  const deps: SweepDeps = {
    ledgerPath: "/unused/budget-ledger", runId: "budget-test", now: () => NOW,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); }, fixProgressJudge: judge,
    dispatchFix: (_pr, evidence) => { fixed.push(evidence); },
    dispatchPlanOnlyRepair: (_pr, evidence) => { planned.push(evidence); return true; },
    escalate: (_pr, reason) => { escalated.push(reason); }, close: () => {},
    arm: p => { armed.push(p.prNumber); return "armed"; },
  };
  return { deps, fixed, escalated, planned, armed };
}
const input = () => buildFixProgressInput({ taskId: "W1-T7243", prNumber: 7243, headSha: "head", currentRed: ["ci"], ledger: [] });
const continueJudge: FixProgressJudge = async () => ({ verdict: "continue", reason: "new evidence" });

describe("test/every-fixed-repair-budget-defers-to-the-progress-judge.test.ts", () => {
  // The runDiagnoseThenRetry halves of these budgets (diagnose-retry / transient-retry continuing
  // past their former ceilings, and a transient escalation keeping its class) live in
  // test/classify.test.ts, inside stryker's commandRunner, so they kill classify.ts mutants.
  test("a transient judge escalation keeps blocked_transient, the named loop and the actual retry count", () => {
    const worker: WorkerResult = {
      sessionId: "session", costUsd: 0.25, numTurns: 7, text: "", blocks: [], stderr: "",
      subtype: "success", isError: false, apiError: true, permissionDenials: [], childEnvKeys: [],
      accountLabel: "transient-account", model: "sonnet", effort: "medium",
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {},
      compactionEvents: [], qualitySuspect: false,
    };
    // An api-error worker is a transient attempt, never a success or a strike.
    const attempt = implementAttemptOutcome(worker);
    assert.equal(attempt.success, false);
    assert.equal(attempt.success ? undefined : attempt.evidence.apiError, true);
    // The driver result runDiagnoseThenRetry returns when the judge escalates a transient loop
    // after two continues past MAX_TRANSIENT_RETRIES (asserted against the real driver in classify.test.ts).
    const driver: Parameters<typeof finishTransientRetry>[0] = { outcome: "gave_up", exhaustedClass: "transient",
      strikes: 0, transientRetries: 5, attempts: 6, diagnosed: false,
      reason: "fix progress loop: same provider outage — no new evidence" };
    for (const cleanupFails of [false, true]) {
      const rows: Record<string, unknown>[] = [];
      const messages: string[] = [];
      const removed: string[][] = [];
      const result = finishTransientRetry(driver, {
        taskId: "W1-T7243", runId: "transient", repoDir: "/repo", worktreePath: "/worktree",
        costUsd: 0.25, worker, log: (step, fields) => rows.push({ step, ...fields }), say: text => messages.push(text),
      }, (repo, worktree) => {
        removed.push([repo, worktree]);
        if (cleanupFails) throw new Error("cleanup refused");
      });
      assert.deepEqual(result, { taskId: "W1-T7243", runId: "transient", merged: false, costUsd: 0.25, verdict: "blocked_transient" });
      assert.deepEqual(removed, [["/repo", "/worktree"]]);
      assert.equal(rows[0].step, cleanupFails ? "worktree.remove.error" : "worktree.remove");
      if (cleanupFails) assert.equal(rows[0].error, "cleanup refused");
      const verdict = rows.at(-1)!;
      assert.equal(verdict.verdict, "blocked_transient");
      assert.equal(verdict.account_label, "transient-account");
      assert.equal(verdict.billing_mode, "subscription");
      assert.equal(verdict.num_turns, 7);
      assert.match(String(verdict.reason), /across 5 retries/);
      assert.match(String(verdict.reason), /same provider outage/);
      assert.match(messages[0], /same provider outage/);
    }
    const context = { taskId: "W1-T7243", runId: "control", repoDir: "/repo", worktreePath: "/worktree",
      costUsd: 0.25, worker, log: () => assert.fail("unrelated outcome must not write a transient verdict"),
      say: () => assert.fail("unrelated outcome must not announce a transient verdict") };
    // A code failure whose loop text merely MENTIONS transient retries keeps its strike class
    // (the real driver's half of this is asserted in classify.test.ts) and writes no transient verdict.
    const strike: Parameters<typeof finishTransientRetry>[0] = { outcome: "gave_up", exhaustedClass: "strike",
      strikes: 3, transientRetries: 0, attempts: 3, diagnosed: true,
      reason: "fix progress loop: transient retries exhausted — this is a code failure" };
    assert.equal(finishTransientRetry(strike, context), undefined);
    assert.equal(finishTransientRetry({ ...driver, outcome: "held" }, context), undefined);
    assert.equal(finishTransientRetry({ ...driver, outcome: "success" }, context), undefined);
  });

  test("transient cleanup uses its production remover and reports a refused worktree", async t => {
    const root = mkdtempSync(join(tmpdir(), "rmd-budget-cleanup-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const rows: Record<string, unknown>[] = [];
    const result = finishTransientRetry({ outcome: "gave_up", exhaustedClass: "transient", strikes: 0,
      transientRetries: 4, attempts: 4, diagnosed: false, reason: "provider outage" }, {
      taskId: "W1-T7243", runId: "cleanup", repoDir: root, worktreePath: root, costUsd: 0,
      worker: { subtype: "success", numTurns: 0, childEnvKeys: [] } as unknown as WorkerResult,
      log: (step, fields) => rows.push({ step, ...fields }), say: () => {},
    });
    assert.equal(result?.verdict, "blocked_transient");
    assert.equal(rows[0].step, "worktree.remove.error");
    assert.match(String(rows[0].error), /refus|git|live write/i);
  });

  test("a capped PR dispatches its third plan repair past MAX_PLAN_REPAIR_STRIKES", async () => {
    const criterion = { claim: "claim", proof: "unit test: proof", met: true, reason: "keyword floor", proof_exec: "not_executable" };
    const rows: Record<string, unknown>[] = [
      { task_id: "W1-T7243", step: "review.posted", pr_url: pr().prUrl, head_sha: "head", state: "success",
        capped: true, plan_only: false, decision_verdict: { state: "success", capped: true, planOnly: false, criteria: [criterion] } },
      ...Array.from({ length: 2 }, () => ({ task_id: "W1-T7243", step: PLAN_REPAIR_DISPATCH_STEP, pr_number: 7243, outcome: "dispatched" })),
    ];
    const f = fixture(rows, async facts => {
      if (facts.parkedReason?.startsWith("plan-repair")) {
        assert.equal(facts.formerCeiling, 2);
        assert.equal(facts.strikesSpent, 2);
        assert.equal(facts.remedyHistory?.length, 2);
      }
      return { verdict: "change-approach", approach: "replace the stale proof", reason: "new proof" };
    });
    await runSweep([pr({ checksState: "green", reviewState: "success", ciFailures: [], priorStrikes: 2 })], f.deps);
    assert.equal(f.planned.length, 1);
    assert.equal((f.planned[0] as { progressApproach: string }).progressApproach, "replace the stale proof");
    assert.deepEqual(f.escalated, []);
    const judgment = rows.find(row => row.step === "fix.progress_judged" && row.site === "plan-repair");
    assert.equal(judgment?.former_ceiling, 2);
    assert.match(String(judgment?.parked_reason), /plan-repair/);
  });

  test("an unfiled PR judges its own strike history and records its own budget-site identity", async () => {
    const rows: Record<string, unknown>[] = Array.from({ length: 2 }, (_, i) => [
      { task_id: "PR-7243", pr_number: 7243, step: "fix.dispatch", round_id: String(i), head_sha: "head", ci_failures: ["ci"] },
      { task_id: "PR-7243", pr_number: 7243, step: "fix.done", round_id: String(i), head_sha: "head", subtype: "success" },
    ]).flat();
    const judgments: Parameters<FixProgressJudge>[0][] = [];
    const f = fixture(rows, async facts => {
      judgments.push(facts);
      return undefined;
    });
    await runSweep([pr({ taskId: "unfiled", headRefName: "run-unfiled-123", priorStrikes: 2 })], f.deps);
    assert.equal(judgments.length, 1);
    assert.equal(judgments[0].taskId, "PR-7243");
    assert.equal(judgments[0].strikesSpent, 2);
    assert.equal(judgments[0].rounds.length, 2);
    assert.equal(judgments[0].formerCeiling, 2);
    const judgment = rows.find(row => row.step === "fix.progress_judged");
    assert.equal(judgment?.task_id, "PR-7243");
    assert.equal(judgment?.site, "fix-strike");
    assert.equal(judgment?.former_ceiling, 2);
    assert.deepEqual(f.fixed, []);
  });

  test("a capped body continues its own remedy before any plan repair has been tried", async () => {
    const criterion = { claim: "claim", proof: "unit test: proof", met: true, reason: "keyword floor", proof_exec: "not_executable" };
    const rows: Record<string, unknown>[] = [{ task_id: "W1-T7243", step: "review.posted", pr_url: pr().prUrl,
      head_sha: "head", state: "success", capped: true, plan_only: false,
      decision_verdict: { state: "success", capped: true, planOnly: false, criteria: [criterion] } }];
    const f = fixture(rows, async facts => {
      assert.match(facts.parkedReason!, /capped-body/);
      return { verdict: "continue", reason: "the new body proof can discriminate" };
    });
    await runSweep([pr({ checksState: "green", reviewState: "success", ciFailures: [], priorStrikes: 2 })], f.deps);
    assert.equal(f.fixed.length, 1);
    assert.equal(f.planned.length, 0);
  });

  test("a third rebuild on the same day is judged instead of refused", async () => {
    const slo = { blocker: "escalated" as const, owner: "NONE", reasonClass: "no-op-hold" as const,
      blockerAgeMs: BLOCKER_SLO_MS + 1, nowMs: NOW,
      rungHistory: Array.from({ length: 2 }, () => ({ rung: "rebuild" as const, atMs: NOW, atThisHead: true })) };
    assert.equal((await judgeSloRebuild(slo, input(), async facts => {
      assert.equal(facts.remedyHistory?.length, 2);
      return { verdict: "continue", reason: "a changed base makes rebuild useful" };
    })).rung, "rebuild");
    const stopped = await judgeSloRebuild(slo, input(), async () => ({ verdict: "escalate", loop: "identical rebuilds", reason: "no cure" }));
    assert.equal(stopped.rung, "digest");
    assert.match(stopped.reason, /identical rebuilds/);
    assert.equal((await judgeSloRebuild(slo, input(), async () => undefined)).rung, "none");
  });

  test("the real fix rung reaches a fourth strike and a fourth retrigger", async t => {
    t.mock.method(systemClock, "now", () => NOW);
    const root = mkdtempSync(join(tmpdir(), "rmd-budget-rung-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const retrigger of [false, true]) {
      let workers = 0;
      const rows: Record<string, unknown>[] = [];
      const mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };
      const review = () => ({ state: workers === 4 ? "success" as const : "failure" as const,
        headSha: `head-${workers}`, criteria: [{ claim: "repair", proof: "unit test: repair", met: workers === 4,
          reason: "failed", proof_exec: "executed_fail" as const }], testTheater: false, summary: "review",
        floorDegraded: false, capped: false, keywordOnly: false, planOnly: false, reviewerOutcome: "success" });
      const result = await runFixRung({ taskId: "W1-T7243", runId: "budget-rung", task: { id: "W1-T7243", title: "repair" },
        prUrl: pr().prUrl, branch: "run-W1-T7243-123", worktreePath: root, initialSessionId: "session",
        mount, settingsFile: "settings/worker.json", config: {} as never, budgetUsd: 1, strikeCap: 2, retriggerCap: 2,
        initialReview: review(), progressDecision: { verdict: "continue", reason: "sweep admitted" },
        reviewBase: { owner: "o", repo: "r", headCheckoutDir: root, reviewerMount: mount },
        deps: {
          spawn: async () => {
            workers++;
            return { sessionId: "session", costUsd: 0, numTurns: 1, text: "fixed", blocks: [], stderr: "",
              subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
              model: "sonnet", effort: "medium", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
              modelUsage: {}, compactionEvents: [], qualitySuspect: false };
          },
          fixProgressJudge: async facts => {
            assert.equal(facts.rounds.length, workers);
            return { verdict: "continue", reason: "new reproduction narrows the defect" };
          },
          readRoundCommits: async () => [{ changedFiles: retrigger ? 0 : 1, subject: retrigger ? "ci: retrigger" : "fix: repair" }],
          waitForCiGreen: async () => "green", runReview: async () => review(),
          fetchPrBody: async () => "Remudero-Task: W1-T7243", fetchPrDiffFiles: async () => [],
          push: () => {}, issues: { create: () => { assert.fail("no escalation while progress continues"); } },
          ledgerPath: join(root, "ledger.ndjson"), ledgerLines: () => [],
          log: (step, fields) => { rows.push({ step, ...fields }); }, say: () => {}, account: r => r,
        },
      });
      assert.equal(result.outcome, "fixed", result.reason);
      assert.equal(workers, 4);
      assert.equal(retrigger ? result.retriggers : result.strikes, 4);
      assert.ok(rows.some(row => row.step === "fix.progress_judged" && row.site === (retrigger ? "fix-retrigger" : "fix-strike") && row.former_ceiling === 2));
    }
  });

  test("the sweep rebuild gateway continues past two rebuilds and digests the named loop", async () => {
    for (const verdict of ["continue", "escalate", "unavailable"] as const) {
      const rows: Record<string, unknown>[] = [];
      const f = fixture(rows, async facts => {
        if (!facts.parkedReason?.startsWith("rebuild:")) return { verdict: "escalate", loop: "fix rounds repeated", reason: "try rebuild" };
        assert.equal(facts.strikesSpent, 2);
        return verdict === "unavailable" ? undefined : verdict === "continue"
          ? { verdict, reason: "main contains the cure" } : { verdict, loop: "identical rebuilds", reason: "no progress" };
      });
      let closed = false, notes = 0;
      const digests: string[] = [];
      f.deps.close = () => { closed = true; };
      f.deps.readLiveState = () => ({ ok: true, state: closed ? "CLOSED" : "OPEN", headSha: "head" });
      f.deps.strikeLadder = {
        readNotes: () => Array.from({ length: 2 }, () => ({ author: "strike-ladder" })) as never,
        readAuthor: async () => "remudero-fleet[bot]",
        readMergeBase: async () => "main", appendNote: () => { notes++; return true; },
        digest: (_pr, cause, _count, _issues, reason) => {
          assert.match(reason!, /identical rebuilds/);
          digests.push(cause);
          return { outcome: "opened", reason: "digest delivered", issueUrl: "https://github.com/o/r/issues/1" };
        },
      };
      f.deps.readMainRepair = async () => ({ sha: "main", committedAt: new Date(NOW).toISOString() });
      const summary = await runSweep([pr({ priorStrikes: 2, currentMergeBaseSha: "main" })], f.deps);
      assert.equal(closed, verdict === "continue");
      assert.equal(notes, verdict === "continue" ? 1 : 0);
      assert.equal(digests.length, verdict === "escalate" ? 1 : 0);
      if (verdict === "escalate") assert.match(summary.actions[0].reason, /identical rebuilds/);
      if (verdict === "unavailable") assert.match(summary.actions[0].reason, /absent or unparseable/);
    }
  });

  test("refused-twice waits once then dispatches when the judge releases it", async () => {
    const rows: Record<string, unknown>[] = Array.from({ length: 2 }, (_, i) => [
      { task_id: "W1-T7243", step: "fix.dispatch", round_id: String(i), head_sha: "head", ci_failures: ["ci"] },
      { task_id: "W1-T7243", step: "fix.commit_refused", round_id: String(i), head_sha: "head", reason: "same refusal" },
      { task_id: "W1-T7243", step: "fix.done", round_id: String(i), head_sha: "head", subtype: "commit_refused" },
    ]).flat();
    let judged = 0;
    const f = fixture(rows, async facts => {
      judged++;
      assert.match(facts.parkedReason!, /refused-twice/);
      assert.equal(facts.signals.refusedRounds, 2);
      return { verdict: "continue", reason: "a missing fixture is now available" };
    });
    const refused = pr({ repeatedFixRefusal: "same refusal" });
    await runSweep([refused], f.deps);
    assert.equal(judged, 0);
    assert.equal(f.fixed.length, 0);
    await runSweep([refused], f.deps);
    assert.equal(judged, 1);
    assert.equal(f.fixed.length, 1);
    assert.deepEqual(f.escalated, []);
  });

  test("rerun-still-red returns to the judge after its failed-job rerun", async () => {
    const rows: Record<string, unknown>[] = [
      { task_id: "W1-T7243", step: "fix.dispatch", round_id: "no-commit", head_sha: "head", mode: "ci-log" },
      { task_id: "W1-T7243", step: "fix.done", round_id: "no-commit", head_sha: "head", subtype: "success" },
      { task_id: "W1-T7243", step: "sweep.disposed", pr_number: 7243, head_sha: "head", no_commit_rerun_attempted: true },
    ];
    const f = fixture(rows, async facts => {
      assert.match(facts.parkedReason!, /rerun-still-red/);
      assert.equal(facts.formerCeiling, 1);
      return { verdict: "change-approach", approach: "inspect the flaky assertion", reason: "rerun did not cure it" };
    });
    await runSweep([pr()], f.deps);
    assert.equal(f.fixed.length, 1);
    assert.equal((f.fixed[0] as { progressApproach: string }).progressApproach, "inspect the flaky assertion");
    assert.equal(rows.find(row => row.step === "fix.progress_judged")?.site, "rerun-still-red");
  });

  test("a repeatedly refused plan filing waits once, holds unavailable, and carries a new approach", async () => {
    const rows: Record<string, unknown>[] = Array.from({ length: 2 }, () => ({
      step: "sweep.plan_round.refused", task_id: "W1-T7243", pr_number: 7243, head_sha: "head", reason: "missing rationale",
    }));
    let judged = 0, dispatched = 0;
    const f = fixture(rows, async facts => {
      assert.match(facts.parkedReason!, /refused-twice/);
      assert.equal(facts.remedyHistory?.length, 2);
      return ++judged === 1 ? undefined : { verdict: "change-approach", approach: "explain the measured failure", reason: "new evidence" };
    });
    f.deps.readPlanRepairFacts = () => ({ authorLogin: "remudero-fleet[bot]" });
    f.deps.repairPlanPr = () => { assert.fail("no mechanical metadata cure matches"); };
    f.deps.dispatchPlanGateRound = async filing => {
      assert.equal(filing.pendingAnswer?.constraint, "explain the measured failure");
      dispatched++;
      return { outcome: "pushed", headSha: "next" };
    };
    const filing = pr({ isPlanFiling: true, headRefName: "ci-friction-garden-1791084979333",
      ciFailures: [{ name: "lint-plan", logTail: "rationale is missing" }] });
    await runSweep([filing], f.deps);
    assert.equal(judged, 0);
    await runSweep([filing], f.deps);
    assert.equal(judged, 1);
    assert.equal(dispatched, 0);
    await runSweep([filing], f.deps);
    assert.equal(dispatched, 1);
    assert.deepEqual(f.escalated, []);
  });

  test("the plan round prompt includes the judge's approach alongside its prior refusal", async () => {
    const path = "plan/tasks.d/W1-T7243-fixture.yaml";
    let prompt = "";
    const result = await runPlanScopedFixRound({
      pr: pr({ pendingAnswer: { constraint: "explain the measured failure" } }),
      worktreePath: "/fixture", title: "chore(plan): file fixture",
      body: `## Acceptance\n- the shard is filed | grep: id: W1-T7243 in ${path}`,
      task: { id: "W1-T7243", title: "fixture", files: [path] }, lastRefusal: "missing rationale",
      deps: {
        runGit: args => args[0] === "rev-parse" ? "head" : args[0] === "ls-tree" ? path : "",
        preflight: async () => ({ ok: false, failures: [{ check: "lint-plan", firstLine: "rationale is missing" }], unreadable: [] }),
        spawn: async text => { prompt = text; return "no changes"; },
        push: () => { assert.fail("no clean change exists to push"); }, updateMetadata: async () => {}, log: () => {},
      },
    });
    assert.equal(result.outcome, "refused");
    assert.match(prompt, /explain the measured failure/);
    assert.match(prompt, /missing rationale/);
  });

  test("amendment-closed waits once then asks the judge for the same repair", async () => {
    const rows: Record<string, unknown>[] = [
      { task_id: "W1-T7243", step: "fix.dispatch", round_id: "scope", head_sha: "head" },
      { task_id: "W1-T7243", step: "fix.scope_amendment", amendment_number: 100 },
      { task_id: "W1-T7243", step: "fix.done", round_id: "scope", head_sha: "head", subtype: "scope_amendment_pending" },
      { task_id: "other", step: "pr.terminal", pr_number: 100, state: "closed" },
      { step: "sweep.disposed", pr_number: 7243, head_sha: "head", disposition: "blocked-fixable", acted: true },
    ];
    let judged = 0;
    const f = fixture(rows, async facts => {
      judged++;
      assert.match(facts.parkedReason!, /amendment-closed/);
      return { verdict: "continue", reason: "repair inside the current scope" };
    });
    await runSweep([pr()], f.deps);
    assert.equal(judged, 0);
    await runSweep([pr()], f.deps);
    assert.equal(judged, 1);
    assert.equal(f.fixed.length, 1);
  });

  test("proof-repair refusals beyond two remain worker rounds when the judge continues", async () => {
    const rows: Record<string, unknown>[] = Array.from({ length: 3 }, (_, i) => [
      { task_id: "W1-T7243", step: "fix.dispatch", round_id: String(i), head_sha: "head" },
      { task_id: "W1-T7243", step: "fix.commit_refused", round_id: String(i), head_sha: "head", reason: `refusal-${i}` },
      { task_id: "W1-T7243", step: "fix.done", round_id: String(i), head_sha: "head", subtype: "commit_refused" },
    ]).flat();
    const f = fixture(rows, async facts => {
      assert.match(facts.parkedReason!, /proof-repair-refusals/);
      assert.equal(facts.signals.refusedRounds, 3);
      return { verdict: "continue", reason: "the proof can be repaired" };
    });
    f.deps.repairMetadata = async () => ({ repaired: false, noCure: true, reason: "stale proof" });
    f.deps.readPlanRepairFacts = async () => ({ authorLogin: "remudero-fleet[bot]" }) as never;
    const proofLog = 'proof-discrimination: FAIL — 1 proof(s) pass at both PR head and merge base (abc123):\n  proof: unit test: stale proof\n  head hits: 1; base hits: 1';
    await runSweep([pr({ ciFailures: [{ name: "proof-discrimination", logTail: proofLog }],
      redRequiredChecks: ["proof-discrimination"], changedFiles: ["src/a.ts"] })], f.deps);
    assert.equal(f.fixed.length, 1);
    assert.equal(f.planned.length, 0);
  });

  test("a fourth re-arm asks the judge and escalation names its loop", async () => {
    for (const verdict of ["continue", "escalate", "unavailable"] as const) {
      const rows: Record<string, unknown>[] = [
        { step: "sweep.disposed", pr_number: 7243, head_sha: "head", disposition: "mergeable", acted: true, arm_outcome: "armed" },
        ...Array.from({ length: 3 }, () => ({ step: REARMED_AFTER_DISARM_STEP, pr_number: 7243, head_sha: "head" })),
      ];
      const f = fixture(rows, async facts => {
        assert.match(facts.parkedReason!, /re-arm/);
        assert.equal(facts.remedyHistory?.length, 3);
        return verdict === "unavailable" ? undefined : verdict === "continue"
          ? { verdict, reason: "checks improved" } : { verdict, loop: "repeated ejection", reason: "no progress" };
      });
      f.deps.readMergeQueueMembership = () => "not-queued";
      f.deps.escalateRearmExhausted = (_p, _count, _bound, reason) => { f.escalated.push(reason!); return "https://github.com/o/r/issues/1"; };
      await runSweep([pr({ checksState: "green", reviewState: "success", ciFailures: [] })], f.deps);
      assert.equal(f.armed.length, verdict === "continue" ? 1 : 0);
      if (verdict === "escalate") assert.match(f.escalated[0], /repeated ejection/);
      if (verdict === "unavailable") assert.deepEqual(f.escalated, []);
    }
  });

  test("a pass with one worker live admits the queued repair", () => {
    let live = 7;
    const rows: Record<string, unknown>[] = [];
    const controller = createSweepFixAdmissionController({ surface: "full", queueDepth: 12,
      hostWorkerBudget: 8, activeWorkers: live, reviewReservations: 0,
      readActiveWorkers: () => live, readPressure: () => ({ availableMib: 8192, floorMib: 1024 }),
      log: (step, fields) => rows.push({ step, ...fields }) });
    const first = controller.claim(pr());
    assert.equal(first.admitted, true);
    if (first.admitted) first.release?.();
    live = 1;
    for (let i = 0; i < 12; i++) {
      const claim = controller.claim(pr({ prNumber: 8000 + i }));
      assert.equal(claim.admitted, true);
      if (claim.admitted) claim.release?.();
    }
    assert.equal(rows.at(-1)?.active_workers, 1);
    assert.equal(rows.at(-1)?.pressure_available_mib, 8192);
  });

  test("live occupancy and host pressure refuse overlapping claims and recover", () => {
    let availableMib = 3072;
    const c = createSweepFixAdmissionController({ surface: "light", queueDepth: 4, hostWorkerBudget: 2,
      activeWorkers: 1, reviewReservations: 0, readActiveWorkers: () => 1,
      readPressure: () => ({ availableMib, floorMib: 1024 }) });
    const claim = c.claim(pr());
    assert.equal(claim.admitted, true);
    assert.equal(c.claim(pr()).admitted, false);
    if (claim.admitted) { claim.release?.(); claim.release?.(); }
    availableMib = 0;
    assert.equal(c.claim(pr()).admitted, false);
    availableMib = 3072;
    assert.equal(c.claim(pr()).admitted, true);
  });

  test("finished fixes release capacity within one sweep and ci waits allow overlapping starts", async () => {
    const rows: Record<string, unknown>[] = [];
    const f = fixture(rows, continueJudge);
    const c = createSweepFixAdmissionController({ surface: "full", queueDepth: 3, hostWorkerBudget: 8,
      activeWorkers: 1, reviewReservations: 0, readActiveWorkers: () => 1,
      readPressure: () => ({ availableMib: 3072, floorMib: 1024 }) });
    f.deps.claimFixAdmission = c.claim;
    const timings: Record<string, unknown>[] = [];
    f.deps.log = (step, fields) => timings.push({ step, ...fields });
    let finish!: () => void;
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    f.deps.detachFixWait = true;
    f.deps.dispatchFix = async (_pr, _evidence, phase) => {
      f.fixed.push(_pr.prNumber);
      phase?.("ci-wait");
      await waiting;
    };
    try {
      await runSweep(Array.from({ length: 3 }, (_, i) => pr({ prNumber: 7243 + i,
        taskId: `W1-T${7243 + i}`, headSha: `head-${i}`, headRefName: `run-W1-T${7243 + i}-123`,
        ciFailures: [{ name: `test-${i}`, logTail: `assertion ${i} failed` }] })), f.deps);
      assert.equal(f.fixed.length, 3, "the first ci wait releases its reservation before the next claim");
      assert.equal(c.snapshot().fixAdmissionsAvailable, 1);
      assert.equal(timings.filter(row => row.stage === "dispatch-call").length, 3);
    } finally { finish(); }
  });

  test("host pressure readings distinguish real memory from unreadable and malformed samples", () => {
    const live = readFixHostPressure(0);
    assert.ok(live.reason !== undefined || live.availableMib > 0, "a live read is either real memory or a named unreadable reason");
    assert.deepEqual(readFixHostPressure(1024, () => "MemAvailable: 4194304 kB\n"), { availableMib: 4096, floorMib: 1024 });
    assert.match(readFixHostPressure(0, () => "malformed").reason!, /MemAvailable absent/);
    assert.match(readFixHostPressure(0, () => { throw new Error("permission denied"); }).reason!, /permission denied/);
  });

  test("per-dispatch head lookup timings prove that preparation yields while github is pending", async t => {
    const root = mkdtempSync(join(tmpdir(), "rmd-budget-timing-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const timings: Record<string, unknown>[] = [];
    const starts: string[] = [];
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const task = { id: "W1-T7243", title: "repair", files: [], acceptance: [], depends_on: [], type: "implement" };
    // localRepoName pins the "is this the local checkout?" comparison. Omitted, buildSweepEffects
    // shells `git config remote.origin.url` on the checkout, which throws where the checkout has
    // no readable origin (the reviewer's bwrap sandbox) — failing this test before any dispatch.
    const effects = buildSweepEffects({ owner: "o", repo: "r", localRepoName: "remudero", config: { root } as never,
      plan: { tasks: [task], byId: new Map([[task.id, task]]) } as never,
      runId: "timing", ledgerPath: join(root, "ledger.ndjson"), log: (step, fields) => timings.push({ step, ...fields }),
      dispatchFixPreflightStandDownImpl: async () => undefined,
      readJsonImpl: async args => {
        starts.push(args[2]);
        await pending;
        return { headRefName: "run-W1-T9999-123", headRefOid: "head", files: [] };
      },
    });
    const work = Promise.all([effects.dispatchFix(pr(), { unmetCriteria: [] }),
      effects.dispatchFix(pr({ prNumber: 7244, prUrl: "https://github.com/o/r/pull/7244" }), { unmetCriteria: [] })]);
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(starts.length, 2, "both preparations reach github before either lookup finishes");
    } finally { release(); await work; }
    const headTimings = timings.filter(row => row.stage === "head-lookup");
    assert.equal(headTimings.length, 2);
    assert.ok(headTimings.every(row => row.asynchronous === true && Number(row.elapsed_ms) >= 0));
    t.diagnostic(JSON.stringify(headTimings));
  });

  test("a pr.terminal merge counts toward the queue governor trailing flow", () => {
    const ts = new Date(NOW - 1000).toISOString();
    const flow = deriveQueueGovernorTrailingFlow([
      { step: "pr.terminal", state: "merged", pr_number: 1, ts },
      { step: "verdict.merged", pr_number: 1, ts },
      { step: "pr.terminal", state: "closed", pr_number: 2, ts },
    ], NOW);
    assert.equal(flow.trailingMergedCount, 1);
    const result = checkQueueGovernor(20, DEFAULT_SWEEP_POLICY, { ...flow, pressure: { availableMib: 8192, floorMib: 1024 } });
    assert.equal(result.tier, "draining");
    assert.equal(result.deferred, false);
    assert.equal(result.measuredBound, 1);
  });

  test("the queue bound follows throughput and pressure rather than policy.wipLimit", () => {
    const flow = { trailingMergedCount: 15, trailingOpenedCount: 20, pressure: { availableMib: 65536, floorMib: 1024 } };
    assert.equal(checkQueueGovernor(12, { ...DEFAULT_SWEEP_POLICY, wipLimit: 2 }, flow).deferred, false);
    const squeezed = checkQueueGovernor(12, DEFAULT_SWEEP_POLICY, { ...flow, pressure: { availableMib: 0, floorMib: 1024 } });
    assert.equal(squeezed.measuredBound, 0);
    assert.equal(squeezed.deferred, true);
  });

  test("the site registry includes each former count and parked wait", () => {
    assert.deepEqual(FIX_BUDGET_JUDGE_SITES.map(site => site.name), [
      "diagnose-retry", "transient-retry", "capped-body", "plan-repair", "fix-retrigger", "fix-strike",
      "rebuild", "re-arm", "proof-repair-refusals", "refused-twice", "rerun-still-red", "amendment-closed",
    ]);
    for (const site of FIX_BUDGET_JUDGE_SITES) { assert.ok(site.file.startsWith("src/")); assert.ok(site.formerCeiling > 0); }
  });

  test("the manual repair route carries the judge's approach and former-bound evidence", async () => {
    const rows: Record<string, unknown>[] = [];
    const result = await routeFix("OPEN", pr({ priorStrikes: 1 }), {
      fixProgressJudge: async () => ({ verdict: "change-approach", approach: "inspect the real API response", reason: "new evidence" }),
      log: (step, fields) => { rows.push({ step, ...fields }); },
      dispatchFix: (_pr, evidence) => { assert.equal(evidence.progressApproach, "inspect the real API response"); },
      escalate: () => { assert.fail("the judge released this repair"); },
    });
    assert.equal(result.outcome, "fixed");
    assert.equal(rows[0].former_ceiling, 2);
    assert.match(String(rows[0].parked_reason), /fix-strike/);
  });
});
