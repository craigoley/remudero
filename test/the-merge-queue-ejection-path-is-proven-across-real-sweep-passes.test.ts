// test/the-merge-queue-ejection-path-is-proven-across-real-sweep-passes.test.ts — W1-T5941.
//
// THE GATE BEFORE THE MERGE QUEUE IS RE-ENABLED. The 2026-10-05 rollout proved only the happy path;
// its first live ejection exposed four daemon gaps, each fixed and tested in isolation:
// W1-T5909 (a disarm outvoted by prior-arm memory), W1-T5911 (a risk-held head the operator enqueued
// by hand), W1-T5920 (a 403-refused requeue dropped) and W1-T5921 (a ci-gate timeout no requeue
// clears). This suite drives ONE PR through each failure sequence across CONSECUTIVE real passes —
// `runSweep` (full) and `runSweepLightPass` (light) — against one stateful GitHub fake, so the fixes
// are proven to compose rather than each passing alone.
//
// The fake composes the per-fix harnesses' own stubs (the W1-T5909/W1-T5911 queue and timeline
// reads, W1-T5920's job-rerun answer, W1-T5921's update-branch) behind one model of the PR on
// GitHub: arming a green head enqueues it; a cancelled group run ejects it and disables auto-merge;
// a green group run merges it. The light pass is composed exactly as `buildSweepLightHook` composes
// it: the requeue-only batch split by `blockedFixableIsRequeueOnly`, `lightPassActionable` with the
// arm allowed, `updateBranch` unwired, and the requeue-only batch's rollup read unwired.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { appendLedger, type LedgerLine } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { ArmTimelineEvent } from "../src/lib/arm-auto-merge.js";
import {
  CHECK_REQUEUE_DEFERRED_STEP,
  DEFAULT_SWEEP_POLICY,
  MAX_REARMS_AFTER_DISARM_PER_HEAD,
  REARMED_AFTER_DISARM_STEP,
  REARM_EXHAUSTED_STEP,
  RISK_OVERRIDE_OBSERVED_STEP,
  runSweep,
  runSweepLightPass,
  type CiFailure,
  type JobRequeueOutcome,
  type OpenPrView,
  type RollupCheckEntry,
  type SweepDeps,
} from "./helpers/sweep-test.js";
import { blockedFixableIsRequeueOnly, lightPassActionable } from "../src/run-task.js";

const PR_NUMBER = 9392;
const PR_URL = `https://github.com/craigoley/remudero/pull/${PR_NUMBER}`;
const TASK = "W1-T5908";
const HEAD = "1f9c8198e0b0344153d1c20259ddf6c81f6ffc61";
const NEXT_HEAD = "2a0d9209f1c1455264e2d31360eef7d92a0eb172";
const ISSUE_URL = "https://github.com/craigoley/remudero/issues/9395";
const ESCALATED_AT = "2026-10-05T19:46:30.000Z";
const GATE = "squash-trailer-gate";
const RUN_ID = "900";
const ALREADY_RUNNING: JobRequeueOutcome = {
  kind: "deferred", refusal: "already_running",
  error: "gh: The workflow run containing this job is already running (HTTP 403)",
};

// W1-T5921's #9388 evidence: the gate's own TIMED OUT line over a never-started `rule-checks`.
const TIMEOUT_LOG_TAIL = [
  "2026-10-05T21:29:59.1000000Z waiting for required check(s) to complete:",
  "2026-10-05T21:29:59.1000000Z   - rule-checks",
  "2026-10-05T21:30:01.0000000Z ##[error]ci-gate: TIMED OUT waiting for required check(s) to complete (this is " +
    "NOT a check failure -- a NEW sha is the only remedy, re-running this same sha will not help):",
  "2026-10-05T21:30:01.0000000Z   - rule-checks",
  "2026-10-05T21:30:01.2000000Z ##[error]Process completed with exit code 1.",
].join("\n");

/** The PR head's own required checks, as GitHub reports them on the next read. */
type HeadChecks =
  | { kind: "green" }
  | { kind: "cancelled"; jobId: string; runInFlight: boolean }
  | { kind: "rerunning" }
  | { kind: "ci-gate-timeout" };

/** One PR on a merge-queue repo, as GitHub would answer every read and write the sweep makes. */
class QueueRepoFake {
  head = HEAD;
  reviewed = true;
  checks: HeadChecks = { kind: "green" };
  autoMerge = false;
  queued = false;
  merged = false;
  readonly timeline: ArmTimelineEvent[] = [];
  readonly arms: string[] = [];
  readonly rerunPosts: string[] = [];
  readonly branchUpdates: string[] = [];
  readonly escalations: string[] = [];
  readonly rearmEscalations: Array<{ head: string; rearms: number; bound: number }> = [];
  timelineReads = 0;

  /** The open-PR list a pass starts from: a merged PR is no longer in it. */
  openPrs(): OpenPrView[] {
    if (this.merged) return [];
    const c = this.checks;
    const view: OpenPrView = {
      prNumber: PR_NUMBER, prUrl: PR_URL, taskId: TASK, headSha: this.head,
      headRefName: "run-W1-T5908-1791200000000",
      reviewState: this.reviewed ? "success" : "none",
      checksState: c.kind === "green" ? "green" : c.kind === "rerunning" ? "pending" : "red",
      unmetCriteria: [], priorStrikes: 0, lastActivityAt: new Date().toISOString(),
      // A queued PR reads `auto_merge: null` exactly like a disarmed one (W1-T5909).
      autoMergeArmed: this.autoMerge && !this.queued,
      isPlanFiling: false,
    };
    if (c.kind === "cancelled") {
      view.ciFailures = [{ name: GATE, logTail: "" }];
      view.cancelledRequiredChecks = [{ name: GATE, jobId: c.jobId }];
    }
    if (c.kind === "ci-gate-timeout") {
      const hang = (name: string): CiFailure => ({ name, conclusion: "FAILURE", jobId: `${name.length}00`,
        logTail: `${name}: SHARD HANG — the matrix was cancelled while the PR head\n  was unchanged. THE TESTS DID NOT RUN — this is NOT a failure of this diff` });
      view.redRequiredChecks = ["ci", "coverage-ratchet"];
      view.ciFailures = [{ name: "ci-gate", conclusion: "FAILURE", jobId: "901", logTail: TIMEOUT_LOG_TAIL }, hang("ci"), hang("coverage-ratchet")];
    }
    return [view];
  }

  // ── GitHub's own transitions, driven by the scenario between passes ──
  /** The merge group's checks were cancelled: GitHub ejects the PR and disables its auto-merge. */
  groupCancelled(): void {
    assert.equal(this.queued, true, "fixture: only a queued PR can be ejected");
    this.queued = false;
    this.autoMerge = false;
  }
  /** The merge group went green: the queue merges the PR. */
  groupGreen(): void {
    assert.equal(this.queued, true, "fixture: only a queued PR can merge through the queue");
    this.queued = false;
    this.merged = true;
  }
  /** The operator clicks "Merge when ready" on the risk-held head (W1-T5911's #9391). */
  operatorEnqueues(at: string): void {
    this.queued = true;
    this.autoMerge = true;
    this.timeline.push({ kind: "AddedToMergeQueueEvent", actor: "cao825", at });
  }

  /** The rollup the full pass reads (W1-T5920's shape: the cancelled job beside a sibling of its run). */
  rollup(): RollupCheckEntry[] | undefined {
    const c = this.checks;
    if (c.kind !== "cancelled") return undefined;
    return [
      { name: GATE, status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-10-05T21:47:41Z",
        detailsUrl: `https://github.com/craigoley/remudero/actions/runs/${RUN_ID}/job/${c.jobId}` },
      { name: "acceptance-author-gate", status: c.runInFlight ? "IN_PROGRESS" : "COMPLETED",
        ...(c.runInFlight ? {} : { conclusion: "SUCCESS" }), startedAt: "2026-10-05T21:47:42Z",
        detailsUrl: `https://github.com/craigoley/remudero/actions/runs/${RUN_ID}/job/333` },
    ];
  }

  /** The effects every pass shares — the same seams the per-fix harnesses stub. */
  effects(): Omit<SweepDeps, "ledgerPath" | "runId"> {
    return {
      arm: (p) => {
        this.arms.push(p.headSha);
        // A green head on a merge-queue repo is enqueued by its arm.
        this.autoMerge = true;
        this.queued = true;
        this.timeline.push({ kind: "AddedToMergeQueueEvent", actor: "remudero-fleet", at: new Date().toISOString() });
        return "armed";
      },
      close: () => {}, dispatchFix: () => { assert.fail("no sequence here may spend a fix strike"); },
      escalate: (_p, reason) => { this.escalations.push(reason); },
      escalateCancelledCheck: (_p, _c, reason) => { this.escalations.push(reason); },
      escalateInfrastructureCheck: (_p, _c, reason) => { this.escalations.push(reason); },
      escalateRearmExhausted: (p, rearms, bound) => {
        this.rearmEscalations.push({ head: p.headSha, rearms, bound });
        return `https://github.com/craigoley/remudero/issues/${9500 + this.rearmEscalations.length}`;
      },
      readMergeQueueMembership: () => (this.queued ? "queued" : "not-queued"),
      readArmTimeline: () => { this.timelineReads++; return { events: [...this.timeline] }; },
      readLiveState: () => ({ ok: true, state: this.merged ? "MERGED" : "OPEN", headSha: this.head }),
      readCiGateRollup: () => this.rollup(),
      requeueCheck: (_p, check) => {
        const c = this.checks;
        this.rerunPosts.push(String(check.jobId));
        if (c.kind === "cancelled" && c.runInFlight) return ALREADY_RUNNING;
        this.checks = { kind: "rerunning" };
        return true;
      },
      updateBranch: (p) => {
        this.branchUpdates.push(p.headSha);
        this.head = NEXT_HEAD;
        this.reviewed = false;
        this.checks = { kind: "rerunning" };
        return "updated";
      },
      readLedgerUnion: () => ({ complete: false, lines: [] }),
    };
  }
}

type Surface = "full" | "light";

function scenario(t: TestContext, label: string) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5941-${label}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "ledger.ndjson");
  const gh = new QueueRepoFake();
  let n = 0;

  /** One real pass; returns the rows it wrote. */
  const pass = async (surface: Surface, opts: { fixRungAllowed?: boolean } = {}) => {
    const before = readLedgerLines(ledgerPath).length;
    const base = { ...gh.effects(), ledgerPath, runId: `SWEEP-W1-T5941-${label}-${++n}-${surface}` };
    const openPrs = gh.openPrs();
    if (surface === "full") {
      await runSweep(openPrs, base, DEFAULT_SWEEP_POLICY);
    } else {
      // `buildSweepLightHook`, batch for batch.
      const fixRungAllowed = opts.fixRungAllowed ?? true;
      const requeueOnly = openPrs.filter((p) => blockedFixableIsRequeueOnly(p));
      const rest = openPrs.filter((p) => !requeueOnly.includes(p));
      const passes = [runSweepLightPass(rest, {
        ...base, actionable: (d) => lightPassActionable(d, fixRungAllowed, false, true),
        readLiveHeadSha: () => gh.head, updateBranch: undefined,
      }, DEFAULT_SWEEP_POLICY)];
      if (requeueOnly.length > 0) {
        passes.push(runSweepLightPass(requeueOnly, {
          ...base, actionable: (d) => lightPassActionable(d, fixRungAllowed, true),
          readCiGateRollup: undefined, reaggregateCiGate: undefined, updateBranch: undefined,
        }, DEFAULT_SWEEP_POLICY));
      }
      await Promise.all(passes);
    }
    const rows = readLedgerLines(ledgerPath).slice(before);
    const disposed = rows.filter((r) => r.step === "sweep.disposed" && r.pr_number === PR_NUMBER).at(-1);
    return { rows, disposed, step: (step: string) => rows.filter((r) => r.step === step) };
  };
  const all = (step: string) => readLedgerLines(ledgerPath).filter((r) => r.step === step);
  return { gh, ledgerPath, pass, all };
}

const REARMED = (count: number) => ({ count, bound: MAX_REARMS_AFTER_DISARM_PER_HEAD });

test("W1-T5941: (a) a sweep-armed PR the queue ejects is re-armed on the next pass within the bound and merges when green", async (t) => {
  const s = scenario(t, "a");
  const armed = await s.pass("full");
  assert.deepEqual(s.gh.arms, [HEAD], "pass 1 (full): the green, reviewed head is armed, which enqueues it");
  assert.equal(armed.disposed?.acted, true);
  assert.equal(armed.disposed?.arm_outcome, "armed");

  const queued = await s.pass("light");
  assert.deepEqual(s.gh.arms, [HEAD], "pass 2 (light): a queued PR is never re-armed");
  assert.match(String(queued.disposed?.stand_down_reason), /in the merge queue \(observed on GitHub\)/);

  s.gh.groupCancelled();
  const rearm = await s.pass("light");
  assert.deepEqual(s.gh.arms, [HEAD, HEAD], "pass 3 (light): GitHub's disarm outranks the prior-arm memory");
  assert.equal(rearm.disposed?.acted, true);
  assert.equal(rearm.disposed?.queue_membership, "not-queued");
  assert.deepEqual(rearm.step(REARMED_AFTER_DISARM_STEP).map((r) => ({ count: r.rearm_count, bound: r.bound })), [REARMED(1)]);
  assert.equal(s.gh.queued, true);

  const waiting = await s.pass("full");
  assert.match(String(waiting.disposed?.stand_down_reason), /in the merge queue/, "pass 4 (full): queued again, nothing to do");
  s.gh.groupGreen();
  const after = await s.pass("full");
  assert.equal(s.gh.merged, true, "the queue merged it");
  assert.equal(after.disposed, undefined, "a merged PR leaves the open list");
  assert.deepEqual(s.gh.arms, [HEAD, HEAD]);
  assert.deepEqual(s.gh.escalations, []);
  assert.deepEqual(s.gh.rearmEscalations, []);
});

test("W1-T5941: (b) a risk-held head the operator enqueues by hand is released, re-armed after its ejection, and merges", async (t) => {
  const s = scenario(t, "b");
  appendLedger(s.ledgerPath, { ts: ESCALATED_AT, run_id: "RISK-JUDGE", task_id: TASK, step: "risk_judge.escalated",
    issue_url: ISSUE_URL, pr_number: PR_NUMBER, head_sha: HEAD } as LedgerLine);

  const held = await s.pass("full");
  assert.deepEqual(s.gh.arms, [], "pass 1 (full): the risk judge's refusal stands");
  assert.match(String(held.disposed?.stand_down_reason),
    /^risk judge escalated this head, no operator override recorded .*no arm or enqueue by anyone but the fleet App/);

  s.gh.operatorEnqueues("2026-10-05T19:52:27Z");
  const released = await s.pass("light");
  const observed = released.step(RISK_OVERRIDE_OBSERVED_STEP);
  assert.equal(observed.length, 1, "pass 2 (light): the operator's enqueue is recorded as this head's override");
  assert.equal(observed[0].by, "cao825");
  assert.equal(observed[0].head_sha, HEAD);
  assert.match(String(released.disposed?.stand_down_reason), /in the merge queue/, "and the queued head is left alone");
  assert.deepEqual(s.gh.arms, []);

  s.gh.groupCancelled();
  const armed = await s.pass("full");
  assert.deepEqual(s.gh.arms, [HEAD], "pass 3 (full): the released head is armed by the sweep after its ejection");
  assert.equal(armed.disposed?.acted, true);

  s.gh.groupCancelled();
  const rearm = await s.pass("light");
  assert.deepEqual(s.gh.arms, [HEAD, HEAD], "pass 4 (light): ejected again, it is re-armed under W1-T5909's bound");
  assert.deepEqual(rearm.step(REARMED_AFTER_DISARM_STEP).map((r) => ({ count: r.rearm_count, bound: r.bound })), [REARMED(1)]);

  s.gh.groupGreen();
  await s.pass("full");
  assert.equal(s.gh.merged, true);
  assert.equal(s.all(RISK_OVERRIDE_OBSERVED_STEP).length, 1, "the override is recorded once");
  assert.equal(s.gh.timelineReads, 2, "asked on pass 1 (no override) and pass 2 (recorded); the row is read back after");
  assert.deepEqual(s.gh.escalations, []);
});

test("W1-T5941: (c) an ejected PR's requeue refused with 403 already-running is deferred, retried after its run concludes, and merges", async (t) => {
  const s = scenario(t, "c");
  await s.pass("full");
  assert.deepEqual(s.gh.arms, [HEAD]);
  s.gh.groupCancelled();
  s.gh.checks = { kind: "cancelled", jobId: "111989995761", runInFlight: true };

  const refused = await s.pass("full");
  assert.deepEqual(s.gh.rerunPosts, ["111989995761"], "pass 2 (full): one rerun POST, refused while the run is in flight");
  const deferred = refused.step(CHECK_REQUEUE_DEFERRED_STEP);
  assert.equal(deferred.length, 1);
  assert.equal(deferred[0].refusal, "already_running");
  assert.equal(deferred[0].outcome, "deferred");
  assert.match(String(refused.disposed?.stand_down_reason), /deferred/);

  const waiting = await s.pass("light");
  assert.deepEqual(s.gh.rerunPosts, ["111989995761"], "pass 3 (light): nothing is POSTed while the run is still in flight");
  assert.equal(waiting.step(CHECK_REQUEUE_DEFERRED_STEP).length, 0);
  const waitingFull = await s.pass("full");
  assert.deepEqual(s.gh.rerunPosts, ["111989995761"], "pass 4 (full): still in flight, still waiting");
  assert.match(String(waitingFull.disposed?.stand_down_reason), /in flight/);

  // The run concluded; the check's current attempt is a new job.
  s.gh.checks = { kind: "cancelled", jobId: "222", runInFlight: false };
  await s.pass("full");
  assert.deepEqual(s.gh.rerunPosts, ["111989995761", "222"], "pass 5 (full): retried at the CURRENT attempt's job");
  assert.deepEqual(s.gh.checks, { kind: "rerunning" });

  s.gh.checks = { kind: "green" };
  const rearm = await s.pass("light");
  assert.deepEqual(s.gh.arms, [HEAD, HEAD], "pass 6 (light): green again, the ejected head is re-armed");
  assert.deepEqual(rearm.step(REARMED_AFTER_DISARM_STEP).map((r) => r.rearm_count), [1]);
  s.gh.groupGreen();
  await s.pass("full");
  assert.equal(s.gh.merged, true);
  assert.deepEqual(s.gh.escalations, []);
});

test("W1-T5941: (d) an ejected PR whose ci-gate timed out gets a new head, which is armed and merges", async (t) => {
  const s = scenario(t, "d");
  await s.pass("full");
  assert.deepEqual(s.gh.arms, [HEAD]);
  s.gh.groupCancelled();
  s.gh.checks = { kind: "ci-gate-timeout" };

  const light = await s.pass("light");
  assert.deepEqual(s.gh.branchUpdates, [], "pass 2 (light): update-branch is a full-pass lane");
  assert.equal(light.step("sweep.ci_timeout_refresh.escalated").length, 0, "and the light pass does not escalate it");
  const refreshed = await s.pass("full");
  assert.deepEqual(s.gh.branchUpdates, [HEAD], "pass 3 (full): one base refresh — a new head, never a same-sha requeue");
  assert.equal(refreshed.step("sweep.ci_timeout_refresh.outcome")[0]?.outcome, "updated");
  assert.deepEqual(s.gh.rerunPosts, []);
  assert.equal(s.gh.head, NEXT_HEAD);

  // The new head re-runs its checks and its review.
  s.gh.checks = { kind: "green" };
  s.gh.reviewed = true;
  await s.pass("light");
  assert.deepEqual(s.gh.arms, [HEAD, NEXT_HEAD], "pass 4 (light): the new head earns its own first arm");
  assert.equal(s.all(REARMED_AFTER_DISARM_STEP).length, 0, "a new head is a fresh arm, not a re-arm");
  s.gh.groupGreen();
  await s.pass("full");
  assert.equal(s.gh.merged, true);
  assert.deepEqual(s.gh.escalations, []);
});

test("W1-T5941: (e) a PR the queue ejects on every attempt is re-armed up to the bound, then escalated once and never looped", async (t) => {
  const s = scenario(t, "e");
  await s.pass("full");
  assert.deepEqual(s.gh.arms, [HEAD]);
  const surfaces: Surface[] = ["light", "full"];
  for (let i = 1; i <= MAX_REARMS_AFTER_DISARM_PER_HEAD; i++) {
    await s.pass(surfaces[i % 2]);
    assert.equal(s.gh.queued, true, `attempt ${i}: queued`);
    s.gh.groupCancelled();
    const rearm = await s.pass(surfaces[(i + 1) % 2]);
    assert.deepEqual(rearm.step(REARMED_AFTER_DISARM_STEP).map((r) => r.rearm_count), [i], `re-arm ${i}`);
  }
  assert.equal(s.gh.arms.length, 1 + MAX_REARMS_AFTER_DISARM_PER_HEAD);

  s.gh.groupCancelled();
  const exhausted = await s.pass("light");
  assert.equal(s.gh.arms.length, 1 + MAX_REARMS_AFTER_DISARM_PER_HEAD, "the bound holds the arm");
  assert.deepEqual(s.gh.rearmEscalations,
    [{ head: HEAD, rearms: MAX_REARMS_AFTER_DISARM_PER_HEAD, bound: MAX_REARMS_AFTER_DISARM_PER_HEAD }]);
  assert.deepEqual(exhausted.step(REARM_EXHAUSTED_STEP).map((r) => r.escalated), [true]);
  assert.match(String(exhausted.disposed?.stand_down_reason), new RegExp(`bound ${MAX_REARMS_AFTER_DISARM_PER_HEAD}\\) — not re-armed; escalated once`));

  for (const surface of ["full", "light", "full"] as const) await s.pass(surface);
  assert.equal(s.gh.arms.length, 1 + MAX_REARMS_AFTER_DISARM_PER_HEAD, "no loop: never re-armed past the bound");
  assert.equal(s.gh.rearmEscalations.length, 1, "escalated once, not once per pass");
  assert.equal(s.all(REARM_EXHAUSTED_STEP).length, 1);
  assert.equal(s.gh.merged, false);
});
