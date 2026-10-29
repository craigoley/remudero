import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detachedSweepActionCount, drainDetachedSweepActions, productionFixProgressJudge,
  HOST_GAP_REREVIEW_STEP, REFUSED_POST_HOST_GAP_REREVIEW_STEP, hostGapRereviewFacts,
  MAX_REARMS_AFTER_DISARM_PER_HEAD, runSweep, runSweepLightPass, type OpenPrView, type SweepDeps,
} from "#src/lib/sweep.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

type JudgmentSite = number | "re-arm" | "host-gap" | "host-gap-refusal";
const judgmentSites = [1, 3, "re-arm", "host-gap", "host-gap-refusal"] as const;

function fixture(waitForMemory = true, holdJudge = waitForMemory, priorStrikes: JudgmentSite = 3) {
  const now = Date.now();
  const rows: Record<string, unknown>[] = [];
  const admission = deferred();
  const entered = deferred();
  let spawns = 0;
  const dispatched: number[] = [];
  const armed: number[] = [];
  const reviewed: number[] = [];
  const pr: OpenPrView = {
    prNumber: 9814, prUrl: "https://github.com/fixture/repo/pull/9814", taskId: "W1-T9814",
    headSha: "memory-held-head", checksState: "red", reviewState: "pending", unmetCriteria: [],
    priorStrikes: typeof priorStrikes === "number" ? priorStrikes : 0,
    autoMergeArmed: false, lastActivityAt: new Date(now).toISOString(),
    reviewInputDigest: "body-A", redRequiredChecks: ["ci"],
    ciFailures: [{ name: "ci", logTail: "Error: fixture assertion failed" }],
  };
  if (priorStrikes === "re-arm") {
    Object.assign(pr, { checksState: "green", reviewState: "success", redRequiredChecks: [], ciFailures: [] });
    rows.push({ step: "sweep.disposed", pr_number: pr.prNumber, pr_url: pr.prUrl,
      head_sha: pr.headSha, disposition: "mergeable", acted: true, arm_outcome: "armed" });
    for (let i = 0; i < MAX_REARMS_AFTER_DISARM_PER_HEAD; i++) {
      rows.push({ step: "automerge.rearmed_after_disarm", pr_number: pr.prNumber,
        head_sha: pr.headSha, rearm_count: i + 1 });
    }
  }
  const hostGap = priorStrikes === "host-gap" || priorStrikes === "host-gap-refusal";
  const rereviewStep = priorStrikes === "host-gap-refusal" ? REFUSED_POST_HOST_GAP_REREVIEW_STEP : HOST_GAP_REREVIEW_STEP;
  if (hostGap) {
    Object.assign(pr, { checksState: "green", reviewState: priorStrikes === "host-gap" ? "success" : "pending",
      reviewPendingSince: new Date(now - 200 * 60_000).toISOString(), redRequiredChecks: [], ciFailures: [] });
    const identity = { task_id: pr.taskId, pr_number: pr.prNumber, pr_url: pr.prUrl,
      head_sha: pr.headSha, review_input_digest: pr.reviewInputDigest };
    for (const attempt of [0, 1]) {
      const at = (ago: number) => new Date(now - ago * 60_000).toISOString();
      const attemptId = `review-PR9814-00000000-0000-4000-8000-${String(attempt).padStart(12, "0")}`;
      if (attempt === 1) rows.push({ ...identity, ts: at(180), step: rereviewStep,
        skips: ["cwd-missing"], host_gap: "cwd-missing", refusal_at: now - 190 * 60_000 });
      rows.push({ ...identity, ts: at(200 - attempt * 20), step: "sweep.review_admitted",
        review_attempt_id: attemptId, host_gap_rereview: attempt === 1, skips: ["cwd-missing"] });
      rows.push({ ...identity, ts: at(190 - attempt * 20), review_attempt_id: attemptId,
        run_id: `review-PR9814-${1000 + attempt}`,
        ...(priorStrikes === "host-gap-refusal" ? {
          step: "review.post_refused", attempted_state: "success", reviewer_code_freshness: "unreadable",
          reviewer_code_host_gap: "cwd-missing", reviewer_code_reason: "fixture reviewer checkout vanished",
        } : {
          step: "review.posted", state: "success", capped: true, plan_only: false,
          decision_verdict: { state: "success", capped: true, planOnly: false,
            criteria: [{ claim: "fixture proof", proof: "unit test: fixture proof", met: true,
              reason: "reviewer checkout vanished", proof_exec: "not_executable", proof_skip: "cwd-missing" }] },
        }) });
    }
  }
  const deps: SweepDeps = {
    ledgerPath: "/unused/t9814-ledger", runId: "SWEEP-T9814", now: () => now,
    readLedger: () => [...rows],
    appendLine: (_path, row) => { rows.push({ ts: new Date(now).toISOString(), ...row }); },
    readTaskContractRevision: () => "contract-A",
    arm: (candidate) => {
      assert.equal(priorStrikes, "re-arm", "red CI cannot arm");
      armed.push(candidate.prNumber);
      return "armed";
    },
    readMergeQueueMembership: () => "not-queued",
    readLedgerUnion: () => ({ complete: false, lines: [] }),
    close: () => { assert.fail("no close authorized"); },
    escalate: () => { assert.fail("a continue verdict cannot escalate"); },
    dispatchFix: (candidate) => { dispatched.push(candidate.prNumber); },
    postReview: (candidate) => { reviewed.push(candidate.prNumber); },
    claimFixAdmission: () => ({ admitted: true }),
    readActiveWorkerCount: () => 0,
    readFixPressure: () => ({ availableMib: 8192, floorMib: 1024 }),
    fixProgressJudge: productionFixProgressJudge({ cwd: ".", settingsFile: "settings/worker.json",
      mount: { model: "fixture", effort: "low", maxTurns: 1, contextBudget: 10000 },
      spawn: async (args) => {
        spawns++;
        if (waitForMemory) {
          await args.memoryShadow!.sleep!(0);
        }
        entered.resolve();
        if (holdJudge) await admission.promise;
        return { text: 'FIX_PROGRESS: {"verdict":"continue","reason":"fixture permits repair"}' } as never;
      } }),
  };
  const expectedDispatch = typeof priorStrikes === "number" ? [9814] : [];
  const expectedArm = priorStrikes === "re-arm" ? [9814] : [];
  const expectedReview = hostGap ? [9814] : [];
  return { pr, deps, rows, admission, entered, dispatched, armed, reviewed, hostGap, rereviewStep,
    expectedDispatch, expectedArm, expectedReview, spawns: () => spawns };
}

test("W1-T9814: a full pass stands down on a head held by a memory-waiting light-pass action", async (t) => {
  for (const priorStrikes of [1, 3]) {
    await t.test(`priorStrikes=${priorStrikes}`, async () => {
      const f = fixture(true, true, priorStrikes);
      const light = runSweepLightPass([f.pr], f.deps);
      let full: ReturnType<typeof runSweep> | undefined;
      try {
        await f.entered.promise;
        await light;
        let returned = false;
        full = runSweep([f.pr], f.deps).then((summary) => { returned = true; return summary; });
        await turn();
        assert.equal(f.spawns(), 1, "the held head must not admit another progress judge");
        assert.equal(returned, true, "the full pass returns while the original judge is waiting");
        const summary = await full;
        assert.equal(summary.total, 1);
        assert.equal(summary.byDisposition.wait, 1);
        assert.equal(summary.actionsTaken, 0);
        const row = f.rows.findLast((row) => row.step === "sweep.disposed");
        assert.equal(row?.disposition, "wait");
        assert.equal(row?.acted, false);
        assert.equal(row?.in_flight_action, "light-pass-action");
        assert.match(String(row?.reason), /still waiting for memory admission/);
        assert.deepEqual(f.dispatched, []);
        await runSweep([{ ...f.pr, headSha: "new-head" }], f.deps);
        assert.equal(f.spawns(), 2, "a different head remains eligible for its own judgment");
      } finally {
        f.admission.resolve();
        await light;
        await full;
        await drainDetachedSweepActions();
      }
    });
  }
});

test("W1-T9814: a full pass progress judgment waiting for memory leaves the pass", async (t) => {
  for (const priorStrikes of judgmentSites) {
    await t.test(`priorStrikes=${priorStrikes}`, async () => {
      const f = fixture(true, true, priorStrikes);
      if (f.hostGap) {
        const facts = hostGapRereviewFacts(f.pr, f.rows);
        assert.equal(facts.history.filter((attempt) => attempt.completed).length, 1);
        assert.equal(facts.observedReviewMs, 10 * 60_000);
      }
      const ready = { ...f.pr, prNumber: 9815, headSha: "ready-head", checksState: "green" as const,
        reviewState: "none" as const, priorStrikes: 0, redRequiredChecks: [], ciFailures: [] };
      let returned = false;
      const pass = runSweep([f.pr, ready], f.deps).then((summary) => { returned = true; return summary; });
      try {
        await f.entered.promise;
        await turn();
        assert.equal(returned, true, "admission must not hold the rest of the full pass");
        assert.deepEqual(f.reviewed, [9815], "another head progresses during the memory wait");
        assert.deepEqual(f.dispatched, []);
        assert.deepEqual(f.armed, []);
        assert.equal(f.rows.some((row) => row.step === "fix.progress_judged"), false);
        const disposed = f.rows.findLast((row) => row.pr_number === 9814 && row.step === "sweep.disposed");
        assert.match(String(f.hostGap ? disposed?.reason : disposed?.stand_down_reason),
          /progress judgment waiting for memory admission/);
        if (f.hostGap) {
          assert.equal(disposed?.disposition, "wait");
          assert.equal(disposed?.acted, false);
          assert.equal(f.rows.filter((row) => row.step === f.rereviewStep).length, 1,
            "a waiting judgment must not request another re-review");
        }
        assert.equal(detachedSweepActionCount(), 1);
        await runSweep([f.pr], f.deps);
        await runSweepLightPass([f.pr], f.deps);
        assert.equal(f.spawns(), 1, "both surfaces honor the full pass's hold");
        for (const freshness of [false, true]) {
          const waiting = await drainDetachedSweepActions({ boundMs: 0, freshness });
          assert.equal(waiting.length, 1);
          assert.equal(waiting[0]?.actionKind, "light-pass-action");
        }
        let drained = false;
        const drain = drainDetachedSweepActions().then(() => { drained = true; });
        await turn();
        assert.equal(drained, false, "stop waits for the detached judgment");
        f.admission.resolve();
        await drain;
        assert.equal(detachedSweepActionCount(), 0);
        const judged = f.rows.find((row) => row.step === "fix.progress_judged");
        assert.equal(judged?.verdict, "continue");
        assert.equal(judged?.reason, "fixture permits repair");
        if (priorStrikes === "re-arm") assert.equal(judged?.site, "re-arm");
        if (f.hostGap) {
          assert.equal(judged?.site, "host-gap-rereview", "the planner records the settled progress verdict");
          assert.equal(judged?.round_count, 1);
        }
        await runSweep([f.pr], f.deps);
        assert.equal(f.spawns(), 1, "the next pass consumes the settled judgment");
        const reused = f.rows.findLast((row) => row.step === "fix.progress_reused");
        assert.equal(reused?.input_key, judged?.input_key);
        assert.equal(reused?.judged_at, judged?.ts);
        assert.deepEqual(f.dispatched, f.expectedDispatch);
        assert.deepEqual(f.armed, f.expectedArm);
        assert.deepEqual(f.reviewed, [9815, ...f.expectedReview]);
        if (f.hostGap) assert.equal(f.rows.filter((row) => row.step === f.rereviewStep).length, 2);
        await pass;
      } finally {
        f.admission.resolve();
        await pass;
        await drainDetachedSweepActions();
      }
    });
  }
});

test("W1-T9814: an unheld head is judged by the full pass as today", async (t) => {
  for (const priorStrikes of judgmentSites) {
    await t.test(`priorStrikes=${priorStrikes}`, async () => {
      const f = fixture(false, false, priorStrikes);
      await runSweep([f.pr], f.deps);
      assert.equal(f.spawns(), 1);
      assert.equal(f.rows.find((row) => row.step === "fix.progress_judged")?.verdict, "continue");
      assert.deepEqual(f.dispatched, f.expectedDispatch);
      assert.deepEqual(f.armed, f.expectedArm);
      assert.deepEqual(f.reviewed, f.expectedReview);
      assert.equal(detachedSweepActionCount(), 0);
      const slow = fixture(false, true, priorStrikes);
      let returned = false;
      const pass = runSweep([slow.pr], slow.deps).then(() => { returned = true; });
      try {
        await slow.entered.promise;
        await turn();
        assert.equal(returned, false, "a judgment without a memory-wait signal stays inline");
        assert.equal(detachedSweepActionCount(), 0);
        assert.deepEqual(slow.dispatched, []);
        assert.deepEqual(slow.armed, []);
        assert.deepEqual(slow.reviewed, []);
        slow.admission.resolve();
        await pass;
        assert.deepEqual(slow.dispatched, slow.expectedDispatch);
        assert.deepEqual(slow.armed, slow.expectedArm);
        assert.deepEqual(slow.reviewed, slow.expectedReview);
      } finally {
        slow.admission.resolve();
        await pass;
      }
    });
  }
});
