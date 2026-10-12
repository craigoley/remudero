// test/a-light-pass-never-retries-a-deferred-requeue-blind-to-its-run.test.ts — W1-T5953.
//
// FOUND by W1-T5941's multi-pass scenario (sequence c): `buildSweepLightHook`'s requeue-only batch
// unwires `readCiGateRollup`, so W1-T5920's `deferredRequeueTarget(undefined, …)` read "run not in
// flight" and every light pass re-POSTed the stale job. Five light passes during one in-flight run
// reached CHECK_REQUEUE_DEFERRAL_BACKSTOP and escalated, stranding the PR until a new head.
//
// A deferred requeue is retried only by a pass that can see its run: a blind pass holds it — no
// POST, no deferral counted — under a named stand-down.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  buildSweepEffects,
  CHECK_REQUEUE_DEFERRAL_BACKSTOP,
  CHECK_REQUEUE_DEFERRED_STEP,
  checkRequeueDeferralsFromLedger,
  DEFAULT_SWEEP_POLICY,
  deferredRequeueTarget,
  requeuedCheckKeysFromLedger,
  runSweep,
  runSweepLightPass,
  type JobRequeueOutcome,
  type OpenPrView,
  type RollupCheckEntry,
  type SweepDeps,
} from "./helpers/sweep-test.js";
import { blockedFixableIsRequeueOnly, lightPassActionable } from "../src/run-task.js";

const PR = 9392;
const HEAD = "1f9c8198e0b0344153d1c20259ddf6c81f6ffc61";
const GATE = "squash-trailer-gate";
const KEY = `${HEAD}@${GATE}`;
const STALE_JOB = "111989995761";
const BLIND = /cannot see its run/;
const ALREADY_RUNNING: JobRequeueOutcome = {
  kind: "deferred", refusal: "already_running",
  error: "gh: The workflow run containing this job is already running (HTTP 403)",
};

/** The cancelled check's job beside a sibling of the same run — W1-T5920's rollup shape. */
const rollupOf = (jobId: string, runInFlight: boolean): RollupCheckEntry[] => [
  { name: GATE, status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-10-05T21:47:41Z",
    detailsUrl: `https://github.com/craigoley/remudero/actions/runs/900/job/${jobId}` },
  { name: "acceptance-author-gate", status: runInFlight ? "IN_PROGRESS" : "COMPLETED",
    ...(runInFlight ? {} : { conclusion: "SUCCESS" }), startedAt: "2026-10-05T21:47:42Z",
    detailsUrl: "https://github.com/craigoley/remudero/actions/runs/900/job/333" },
];

/** One PR whose required gate was cancelled; `refuse` is GitHub's answer while the run is live. */
class CancelledGateFake {
  jobId = STALE_JOB;
  runInFlight = true;
  refuseEvenWhenConcluded = false;
  readonly posts: string[] = [];
  readonly escalations: string[] = [];

  view(): OpenPrView {
    return {
      prNumber: PR, prUrl: `https://github.com/craigoley/remudero/pull/${PR}`, taskId: "W1-T5908",
      headSha: HEAD, headRefName: "run-W1-T5908-1791200000000", reviewState: "success", checksState: "red",
      unmetCriteria: [], priorStrikes: 0, lastActivityAt: new Date().toISOString(), autoMergeArmed: false,
      isPlanFiling: false, ciFailures: [{ name: GATE, logTail: "" }],
      cancelledRequiredChecks: [{ name: GATE, jobId: STALE_JOB }],
    };
  }

  effects(): Omit<SweepDeps, "ledgerPath" | "runId"> {
    return {
      arm: () => "armed", close: () => {},
      dispatchFix: () => { assert.fail("a cancelled gate never spends a fix strike"); },
      escalate: (_p, reason) => { this.escalations.push(reason); },
      escalateCancelledCheck: (_p, _c, reason) => { this.escalations.push(reason); },
      readLiveState: () => ({ ok: true, state: "OPEN", headSha: HEAD }),
      readCiGateRollup: () => rollupOf(this.jobId, this.runInFlight),
      requeueCheck: (_p, check) => {
        this.posts.push(String(check.jobId));
        return this.runInFlight || this.refuseEvenWhenConcluded ? ALREADY_RUNNING : true;
      },
      readLedgerUnion: () => ({ complete: false, lines: [] }),
    };
  }
}

function scenario(t: TestContext, label: string) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5953-${label}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "ledger.ndjson");
  const gh = new CancelledGateFake();
  let n = 0;
  const pass = async (surface: "full" | "light", over: Partial<SweepDeps> = {}) => {
    const before = readLedgerLines(ledgerPath).length;
    const base = { ...gh.effects(), ledgerPath, runId: `SWEEP-W1-T5953-${label}-${++n}-${surface}`, ...over };
    const prs = [gh.view()];
    if (surface === "full") {
      await runSweep(prs, base, DEFAULT_SWEEP_POLICY);
    } else {
      // `buildSweepLightHook`'s requeue-only batch, as it is composed there.
      assert.ok(blockedFixableIsRequeueOnly(prs[0]), "fixture: the PR rides the requeue-only batch");
      await runSweepLightPass(prs, {
        ...base, actionable: (d) => lightPassActionable(d, true, true),
        readCiGateRollup: undefined, reaggregateCiGate: undefined, updateBranch: undefined,
      }, DEFAULT_SWEEP_POLICY);
    }
    const rows = readLedgerLines(ledgerPath).slice(before);
    const disposed = rows.filter((r) => r.step === "sweep.disposed" && r.pr_number === PR).at(-1);
    return { rows, reason: String(disposed?.stand_down_reason), deferred: rows.filter((r) => r.step === CHECK_REQUEUE_DEFERRED_STEP) };
  };
  const deferral = () => checkRequeueDeferralsFromLedger(readLedgerLines(ledgerPath)).get(KEY);
  return { gh, pass, deferral, ledgerPath };
}

test("a light pass without the CI rollup neither POSTs nor counts a deferred requeue, and the requeue is retried at the current job once a pass that can see the run finds it concluded", async (t) => {
  const s = scenario(t, "blind");
  const refused = await s.pass("full");
  assert.deepEqual(s.gh.posts, [STALE_JOB], "the first requeue is POSTed and refused while the run is in flight");
  assert.equal(refused.deferred.length, 1);
  assert.equal(s.deferral()?.count, 1);

  for (let i = 0; i < CHECK_REQUEUE_DEFERRAL_BACKSTOP + 1; i++) {
    const blind = await s.pass("light");
    assert.deepEqual(s.gh.posts, [STALE_JOB], `light pass ${i + 1}: no POST of the stale job`);
    assert.equal(blind.deferred.length, 0, `light pass ${i + 1}: no deferral counted, none escalated`);
    assert.match(blind.reason, BLIND, `light pass ${i + 1}: the hold is named`);
  }
  assert.deepEqual(s.deferral(), { count: 1, escalated: false, refusal: "already_running" });
  assert.deepEqual(s.gh.escalations, []);

  const waiting = await s.pass("full");
  assert.deepEqual(s.gh.posts, [STALE_JOB], "a pass that sees the run in flight waits");
  assert.match(waiting.reason, /in flight/);
  assert.equal(s.deferral()?.count, 1);

  s.gh.jobId = "222";
  s.gh.runInFlight = false;
  const retried = await s.pass("full");
  assert.deepEqual(s.gh.posts, [STALE_JOB, "222"], "retried at the CURRENT attempt's job");
  assert.equal(retried.deferred.length, 0);
  assert.ok(requeuedCheckKeysFromLedger(readLedgerLines(s.ledgerPath)).has(KEY), "the accepted retry is spent");
  assert.deepEqual(s.gh.escalations, []);
});

test("a full pass whose rollup read failed holds the deferred requeue rather than reading the run as concluded", async (t) => {
  const s = scenario(t, "unread");
  await s.pass("full");
  s.gh.jobId = "222";
  s.gh.runInFlight = false;
  const unread = await s.pass("full", { readCiGateRollup: () => undefined });
  assert.deepEqual(s.gh.posts, [STALE_JOB]);
  assert.match(unread.reason, BLIND);
  assert.equal(s.deferral()?.count, 1);
});

test("genuine in-flight refusals still reach CHECK_REQUEUE_DEFERRAL_BACKSTOP and escalate once", async (t) => {
  const s = scenario(t, "backstop");
  s.gh.runInFlight = false;
  s.gh.refuseEvenWhenConcluded = true;
  await s.pass("full");
  for (let i = 1; i < CHECK_REQUEUE_DEFERRAL_BACKSTOP; i++) {
    await s.pass("light");
    await s.pass("full");
  }
  assert.equal(s.gh.posts.length, CHECK_REQUEUE_DEFERRAL_BACKSTOP, "only the passes that saw the run POSTed");
  assert.equal(s.deferral()?.count, CHECK_REQUEUE_DEFERRAL_BACKSTOP);
  assert.deepEqual(s.gh.escalations, []);

  const at = await s.pass("light");
  assert.equal(s.gh.posts.length, CHECK_REQUEUE_DEFERRAL_BACKSTOP, "no POST at the bound");
  assert.equal(s.gh.escalations.length, 1);
  assert.match(s.gh.escalations[0], /already_running/);
  assert.match(at.reason, /escalated/);
  await s.pass("full");
  assert.equal(s.gh.escalations.length, 1, "escalated once per (head, check)");
});

test("deferredRequeueTarget answers undefined for an unavailable rollup, never a concluded run", () => {
  assert.equal(deferredRequeueTarget(undefined, GATE), undefined);
  assert.deepEqual(deferredRequeueTarget(rollupOf("222", true), GATE), { jobId: "222", runInFlight: true });
  assert.deepEqual(deferredRequeueTarget(rollupOf("222", false), GATE), { jobId: "222", runInFlight: false });
  assert.deepEqual(deferredRequeueTarget([], GATE), { runInFlight: false }, "a read rollup without the check: nothing in flight");
});

test("the real rollup reader's catch arm degrades to undefined, which the sweep holds", async (t) => {
  const logged: string[] = [];
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5953-root-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const effects = buildSweepEffects({
    owner: "craigoley", repo: "remudero",
    config: { claudeBin: "/usr/bin/true", root } as never,
    ledgerPath: join(root, "effects.ndjson"), runId: "SWEEP-T5953", plan: { tasks: [] } as never,
    log: (step) => void logged.push(step),
    policy: undefined, reviewRunner: undefined, spawnImpl: undefined, pushEmptyCommit: undefined,
    issuesImpl: undefined, stallNotice: undefined, armImpl: undefined, armSessionPrsOverride: undefined,
    updateBranchImpl: undefined, captureRepairFeedbackImpl: undefined,
    readJsonImpl: async () => { throw new Error("gh: HTTP 502"); },
  });
  const s = scenario(t, "catch");
  await s.pass("full");
  s.gh.runInFlight = false;
  const unread = await s.pass("full", { readCiGateRollup: effects.readCiGateRollup });
  assert.deepEqual(logged, ["sweep.ci_gate_rollup.error"]);
  assert.deepEqual(s.gh.posts, [STALE_JOB]);
  assert.match(unread.reason, BLIND);
});
