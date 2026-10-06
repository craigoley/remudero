import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import type { Config } from "../src/lib/config.js";
import { appendLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  buildSweepEffects,
  CHECK_REQUEUE_DEFERRAL_BACKSTOP,
  CHECK_REQUEUE_DEFERRED_STEP,
  MAX_REARMS_AFTER_DISARM_PER_HEAD,
  REARMED_AFTER_DISARM_STEP,
  REARM_EXHAUSTED_STEP,
  RISK_OVERRIDE_OBSERVED_STEP,
  requeuedCheckKeysFromLedger,
  runSweep,
  runSweepLightPass,
  type OpenPrView,
  type RollupCheckEntry,
  type SweepDeps,
} from "../src/lib/sweep.js";
import { lightPassActionable } from "../src/run-task.js";
import { ghShim, type GhShim } from "./helpers/gh-shim.js";

const HEAD = "1f9c8198e0b0344153d1c20259ddf6c81f6ffc61";
const NEXT_HEAD = "2a0d9209f1c1455264e2d31360eef7d92a0eb172";
const PR = 9392;
const PR_URL = `https://github.com/craigoley/remudero/pull/${PR}`;
const TASK = "W1-T5908";
const CHECK = "squash-trailer-gate";

// GitHub owns group verdicts, ejection, and merging; the sweep owns recovery writes.
class QueueRepoFake {
  head = HEAD;
  state: "OPEN" | "MERGED" = "OPEN";
  queued = false;
  group: "pending" | "cancelled" | "green" = "pending";
  checks: "green" | "cancelled" | "timeout" | "pending" = "green";
  runInFlight = true;
  jobId = "111";
  readonly arms: string[] = [];
  readonly updates: string[] = [];
  readonly escalations: Array<{ head: string; rearms: number; bound: number }> = [];
  readonly events: string[] = [];
  readonly timeline: Array<{ __typename: string; createdAt: string; actor: { login: string } }> = [];

  constructor(readonly shim: GhShim, readonly now: number) { this.publish(); }

  publish(): void {
    this.shim.addRoute({ when: "isInMergeQueue", stdout: JSON.stringify({
      data: { repository: { pullRequest: { isInMergeQueue: this.queued } } },
    }) });
    this.shim.addRoute({ when: "timelineItems", stdout: JSON.stringify({
      data: { repository: { pullRequest: { timelineItems: { nodes: this.timeline } } } },
    }) });
    this.shim.addRoute({ when: "actions/jobs/111/rerun", exit: 1,
      stderr: "gh: The workflow run containing this job is already running (HTTP 403)" });
    this.shim.addRoute({ when: "actions/jobs/222/rerun", exit: 0 });
  }

  enqueue(actor = "remudero-fleet"): void {
    assert.equal(this.state, "OPEN");
    assert.equal(this.checks, "green", "only a green head enters the queue");
    this.queued = true;
    this.group = "pending";
    this.timeline.push({ __typename: "AddedToMergeQueueEvent", actor: { login: actor },
      createdAt: new Date(this.now + this.timeline.length * 1000 + 1000).toISOString() });
    this.events.push(`enqueued:${actor}`);
    this.publish();
  }

  eject(): void {
    assert.equal(this.queued, true, "ejection requires an earlier enqueue");
    this.group = "cancelled";
    this.queued = false;
    this.events.push("group-cancelled:ejected:disarmed");
    this.publish();
  }

  mergeGreenGroup(): void {
    assert.equal(this.queued, true, "a stranded PR cannot merge");
    assert.equal(this.checks, "green");
    this.group = "green";
    this.queued = false;
    this.state = "MERGED";
    this.events.push("group-green:merged");
    this.publish();
  }

  openPrs(): OpenPrView[] {
    if (this.state === "MERGED") return [];
    return [{
      prNumber: PR, prUrl: PR_URL, taskId: TASK, headSha: this.head,
      headRefName: "run-W1-T5908-1791200000000", isPlanFiling: false,
      reviewState: "success", checksState: this.checks === "green" ? "green" : this.checks === "pending" ? "pending" : "red",
      unmetCriteria: [], priorStrikes: 0, lastActivityAt: new Date(this.now).toISOString(),
      // GitHub reports auto_merge:null even while this PR is in the merge queue.
      autoMergeArmed: false,
      ...(this.checks === "cancelled" ? {
        redRequiredChecks: [CHECK], ciFailures: [{ name: CHECK, conclusion: "CANCELLED", logTail: "", jobId: "111" }],
        cancelledRequiredChecks: [{ name: CHECK, jobId: "111" }],
      } : {}),
      ...(this.checks === "timeout" ? {
        redRequiredChecks: ["ci-gate"], ciFailures: [{ name: "ci-gate", conclusion: "FAILURE", jobId: "901",
          logTail: "ci-gate: TIMED OUT waiting for required check(s) to complete (this is NOT a check failure -- " +
            "a NEW sha is the only remedy, re-running this same sha will not help):\n  - rule-checks" }],
      } : {}),
    }];
  }

  rollup(): RollupCheckEntry[] {
    return [
      { name: CHECK, status: "COMPLETED", conclusion: "CANCELLED",
        detailsUrl: `https://github.com/craigoley/remudero/actions/runs/900/job/${this.jobId}` },
      { name: "acceptance-author-gate", status: this.runInFlight ? "IN_PROGRESS" : "COMPLETED",
        ...(this.runInFlight ? {} : { conclusion: "SUCCESS" }),
        detailsUrl: "https://github.com/craigoley/remudero/actions/runs/900/job/333" },
    ];
  }
}

function scenario(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5941-`));
  const shim = ghShim([], { kind: "w1t5941-gh" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath}`;
  t.after(() => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  });
  const ledgerPath = join(root, "ledger.ndjson");
  const gh = new QueueRepoFake(shim, Date.now());
  const effects = buildSweepEffects({
    owner: "craigoley", repo: "remudero", config: { root, claudeBin: "/bin/true" } as Config,
    ledgerPath, runId: "SWEEP-W1-T5941-effects", plan: { tasks: [], byId: new Map() }, log: () => {},
  });
  const deps: SweepDeps = {
    ledgerPath, runId: "SWEEP-W1-T5941", now: () => gh.now,
    arm: (p) => { gh.arms.push(p.headSha); gh.enqueue(); return "armed"; },
    close: () => assert.fail("queue recovery never closes the PR"),
    dispatchFix: () => assert.fail("queue recovery never spends a fix strike"),
    escalate: (_p, reason) => assert.fail(`unexpected escalation: ${reason}`),
    readLedgerUnion: () => ({ complete: false, lines: [] }),
    readMergeQueueMembership: effects.readMergeQueueMembership,
    readArmTimeline: effects.readArmTimeline,
    requeueCheck: effects.requeueCheck,
    escalateCancelledCheck: (_p, _c, reason) => assert.fail(`unexpected cancelled-check escalation: ${reason}`),
    readCiGateRollup: () => gh.rollup(),
    readLiveState: () => ({ ok: true, state: gh.state, headSha: gh.head }),
    readActiveWorkerCount: () => 0,
    updateBranch: (p) => {
      assert.ok(readLedgerLines(ledgerPath).some(r => r.step === "sweep.ci_timeout_refresh.attempted" && r.head_sha === p.headSha));
      gh.updates.push(p.headSha);
      gh.head = NEXT_HEAD;
      gh.checks = "pending";
      return "updated";
    },
    escalateRearmExhausted: (p, rearms, bound) => {
      gh.escalations.push({ head: p.headSha, rearms, bound });
      return "https://github.com/craigoley/remudero/issues/9999";
    },
  };
  let n = 0;
  const pass = async (surface: "full" | "light") => {
    const before = readLedgerLines(ledgerPath).length;
    const base = { ...deps, runId: `SWEEP-W1-T5941-${++n}-${surface}` };
    if (surface === "full") await runSweep(gh.openPrs(), base);
    else {
      // Mirror buildSweepLightHook: its requeue-only batch has neither rollup nor updateBranch.
      const requeueOnly = gh.checks === "cancelled";
      await runSweepLightPass(gh.openPrs(), {
        ...base, actionable: d => lightPassActionable(d, !requeueOnly, requeueOnly, !requeueOnly),
        readLiveHeadSha: () => gh.head, updateBranch: undefined,
        readCiGateRollup: requeueOnly ? undefined : base.readCiGateRollup,
      });
    }
    return readLedgerLines(ledgerPath).slice(before);
  };
  const rows = (step: string) => readLedgerLines(ledgerPath).filter(r => r.step === step);
  const posts = () => shim.calls().filter(c => c.includes("actions/jobs/") && c.includes("POST"));
  const finish = async () => {
    const arms = gh.arms.length;
    gh.mergeGreenGroup();
    assert.equal((await pass("full")).filter(r => r.step === "sweep.disposed").length, 0);
    await pass("light");
    assert.equal(gh.state, "MERGED");
    assert.equal(gh.arms.length, arms, "terminal PR never re-enters recovery");
  };
  return { gh, ledgerPath, shim, pass, rows, posts, finish };
}

describe("test/the-merge-queue-ejection-path-is-proven-across-real-sweep-passes.test.ts", () => {
  test("W1-T5941: a sweep-armed PR is ejected, re-armed across full/light passes and merged when its group is green", async t => {
    const s = scenario(t);
    await s.pass("full");
    assert.deepEqual(s.gh.arms, [HEAD]);
    assert.equal(s.rows("sweep.disposed")[0].arm_outcome, "armed");
    await s.pass("light");
    assert.deepEqual(s.gh.arms, [HEAD], "queued auto_merge:null never spends a re-arm");
    s.gh.eject();
    await s.pass("light");
    assert.deepEqual(s.gh.arms, [HEAD, HEAD], "GitHub's disarm outvotes the preceding full pass's arm memory");
    assert.deepEqual(s.rows(REARMED_AFTER_DISARM_STEP).map(r => [r.head_sha, r.rearm_count, r.bound]),
      [[HEAD, 1, MAX_REARMS_AFTER_DISARM_PER_HEAD]]);
    await s.pass("full");
    assert.equal(s.gh.arms.length, 2);
    await s.finish();
    assert.deepEqual(s.gh.events, ["enqueued:remudero-fleet", "group-cancelled:ejected:disarmed",
      "enqueued:remudero-fleet", "group-green:merged"]);
    assert.ok(s.shim.calls().some(c => c.includes("isInMergeQueue") && c.includes(`number=${PR}`)));
  });

  test("W1-T5941: an operator enqueue releases a risk-held head and its later ejection recovers to merge", async t => {
    const s = scenario(t);
    await s.pass("full");
    s.gh.eject();
    appendLedger(s.ledgerPath, { ts: new Date(s.gh.now).toISOString(), run_id: "RISK-JUDGE", task_id: TASK,
      step: "risk_judge.escalated", pr_number: PR, head_sha: HEAD,
      issue_url: "https://github.com/craigoley/remudero/issues/9395" });
    await s.pass("full");
    assert.equal(s.gh.arms.length, 1, "the hold stands before the operator acts");
    assert.equal(s.rows(RISK_OVERRIDE_OBSERVED_STEP).length, 0);
    s.gh.enqueue("cao825");
    await s.pass("light");
    assert.deepEqual(s.rows(RISK_OVERRIDE_OBSERVED_STEP).map(r => [r.by, r.head_sha, r.pr_number]), [["cao825", HEAD, PR]]);
    assert.equal(s.gh.arms.length, 1, "observing an operator enqueue does not enqueue twice");
    s.gh.eject();
    await s.pass("full");
    assert.deepEqual(s.gh.arms, [HEAD, HEAD]);
    await s.pass("light");
    assert.equal(s.rows(RISK_OVERRIDE_OBSERVED_STEP).length, 1, "the override survives the next pass without duplication");
    assert.equal(s.rows(REARMED_AFTER_DISARM_STEP)[0].rearm_count, 1);
    await s.finish();
  });

  test("W1-T5941: a 403-refused requeue retries the current job after its run concludes and reaches merge", async t => {
    const s = scenario(t);
    await s.pass("full");
    s.gh.eject();
    s.gh.checks = "cancelled";
    await s.pass("full");
    assert.equal(s.posts().length, 1);
    assert.equal(s.rows(CHECK_REQUEUE_DEFERRED_STEP)[0].refusal, "already_running");
    assert.equal(requeuedCheckKeysFromLedger(readLedgerLines(s.ledgerPath)).has(`${HEAD}@${CHECK}`), false);
    await s.pass("full");
    assert.equal(s.posts().length, 1, "a visible in-flight run holds the retry");
    s.gh.runInFlight = false;
    s.gh.jobId = "222";
    await s.pass("full");
    assert.equal(s.posts().length, 2);
    assert.match(s.posts()[1], /actions\/jobs\/222\/rerun/);
    assert.equal(requeuedCheckKeysFromLedger(readLedgerLines(s.ledgerPath)).has(`${HEAD}@${CHECK}`), true);
    s.gh.checks = "pending";
    await s.pass("light");
    assert.equal(s.posts().length, 2, "the accepted retry is not duplicated");
    s.gh.checks = "green";
    await s.pass("light");
    assert.deepEqual(s.gh.arms, [HEAD, HEAD]);
    await s.finish();
  });

  test("W1-T5941: light passes blind to a deferred requeue's run preserve its retry until the next full pass", async t => {
    const s = scenario(t);
    await s.pass("full");
    s.gh.eject();
    s.gh.checks = "cancelled";
    await s.pass("full");
    assert.equal(s.posts().length, 1);
    for (let i = 0; i <= CHECK_REQUEUE_DEFERRAL_BACKSTOP; i++) await s.pass("light");
    assert.equal(s.posts().length, 1, "an unavailable rollup cannot prove the run concluded");
    assert.equal(s.rows(CHECK_REQUEUE_DEFERRED_STEP).length, 1, "light passes spend neither deferrals nor escalation");
    s.gh.runInFlight = false;
    s.gh.jobId = "222";
    await s.pass("full");
    assert.equal(s.posts().length, 2);
    assert.match(s.posts()[1], /actions\/jobs\/222\/rerun/);
    s.gh.checks = "green";
    await s.pass("light");
    await s.finish();
  });

  test("W1-T5941: a ci-gate timeout defers on light passes, gets a new head on the full pass and merges", async t => {
    const s = scenario(t);
    await s.pass("full");
    s.gh.eject();
    s.gh.checks = "timeout";
    await s.pass("light");
    await s.pass("light");
    assert.deepEqual(s.gh.updates, []);
    assert.equal(s.rows("sweep.ci_timeout_refresh.escalated").length, 0);
    await s.pass("full");
    assert.deepEqual(s.gh.updates, [HEAD]);
    assert.equal(s.gh.head, NEXT_HEAD);
    assert.equal(s.rows("sweep.ci_timeout_refresh.outcome")[0].outcome, "updated");
    await s.pass("light");
    assert.deepEqual(s.gh.arms, [HEAD], "the replacement head waits for a CI verdict");
    s.gh.checks = "green";
    await s.pass("full");
    assert.deepEqual(s.gh.arms, [HEAD, NEXT_HEAD]);
    assert.equal(s.rows(REARMED_AFTER_DISARM_STEP).length, 0, "new head has no inherited re-arm debt");
    assert.deepEqual(s.posts(), [], "same-sha requeue cannot remedy this timeout");
    await s.finish();
  });

  test("W1-T5941: ejection on every attempt escalates once at the bound across full/light passes", async t => {
    const s = scenario(t);
    await s.pass("full");
    for (let i = 0; i < MAX_REARMS_AFTER_DISARM_PER_HEAD; i++) {
      s.gh.eject();
      await s.pass(i % 2 === 0 ? "light" : "full");
      assert.equal(s.gh.arms.length, i + 2);
      assert.equal(s.gh.escalations.length, 0);
    }
    s.gh.eject();
    for (const surface of ["full", "light", "full", "light"] as const) await s.pass(surface);
    assert.equal(s.gh.arms.length, 1 + MAX_REARMS_AFTER_DISARM_PER_HEAD);
    assert.deepEqual(s.rows(REARMED_AFTER_DISARM_STEP).map(r => r.rearm_count),
      Array.from({ length: MAX_REARMS_AFTER_DISARM_PER_HEAD }, (_, i) => i + 1));
    assert.deepEqual(s.gh.escalations, [{ head: HEAD, rearms: MAX_REARMS_AFTER_DISARM_PER_HEAD,
      bound: MAX_REARMS_AFTER_DISARM_PER_HEAD }]);
    assert.equal(s.rows(REARM_EXHAUSTED_STEP).length, 1);
    assert.equal(s.rows(REARM_EXHAUSTED_STEP)[0].escalated, true);
    assert.equal(s.gh.state, "OPEN");
    assert.equal(s.gh.queued, false);
  });
});
