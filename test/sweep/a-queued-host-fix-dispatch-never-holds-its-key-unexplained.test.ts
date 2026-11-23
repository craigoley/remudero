import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { test } from "node:test";
import { createDetachedWorkHost, spawnRunChild, type RunChildAbandoned, type RunChildPending } from "#src/lib/run-child.js";
import {
  drainDetachedSweepActions, installDetachedWorkHost, QUEUED_FIX_ADMISSION_RELEASE_MS, resetChildWork, runSweep,
  type OpenPrView, type SweepDeps,
} from "#src/lib/sweep.js";

// W1-T13440 — #19122's fix rung waited 17 minutes for the work host to admit its run child while later passes stood down on
// "already claimed this pass". A queued host fix dispatch now names its wait, is ledgered once, and is released past a bound.

const TASK = "W1-T13440";
const HEAD = "e1493c7aaa";
const KEY = `${TASK}@${HEAD}`;
const RUN = "work-fix-dispatch-W1-T13440-1";
const UNMET = [{ claim: "a criterion", proof: "unit test: x", met: false, reason: "not done", proof_exec: "not_executable" as const }];
const pr = (): OpenPrView => ({
  prNumber: 19122, prUrl: "https://github.com/craigoley/remudero/pull/19122", taskId: TASK, reviewState: "failure", checksState: "green",
  unmetCriteria: UNMET, priorStrikes: 0, lastActivityAt: "2026-11-17T16:00:00Z", headSha: HEAD, headRefName: `run-${TASK}-1`, autoMergeArmed: false,
});

type FixAsk = { fixKey: string; onPending?: (pending: { runId: string; abort: () => Promise<void> }) => void };

/** A sweep whose installed work host queues every fix child until the test admits or the sweep aborts it. */
function rig(opts: { reportsPending: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t13440-"));
  let now = Date.parse("2026-11-17T16:44:25Z");
  const rows: Array<Record<string, unknown>> = [];
  const asked: FixAsk[] = [];
  const aborts: string[] = [];
  const waits: Array<{ abandon: () => void }> = [];
  const deps: SweepDeps = {
    arm: () => {}, close: () => {}, escalate: () => {}, runId: "SWEEP-W1-T13440", now: () => now, detachFixWait: true,
    ledgerPath: join(dir, "ledger.ndjson"), readLedger: () => [...rows], appendLine: (_path, row) => { rows.push({ ts: new Date(now).toISOString(), ...row }); },
    log: (step, extra) => { rows.push({ step, ...extra }); }, dispatchFix: () => assert.fail("a hosted fix never runs in process"),
  };
  installDetachedWorkHost({
    hosts: new Set(["review", "fix-dispatch"]), mode: () => "on", spawnReview: async () => undefined,
    spawnFix: (input: FixAsk) => {
      asked.push(input);
      const runId = `${RUN.slice(0, -1)}${asked.length}`;
      return new Promise<RunChildAbandoned>((resolve) => {
        let ended!: () => void;
        const settled = new Promise<void>((r) => { ended = r; });
        const abandon = () => {
          const abandoned: RunChildAbandoned = { started: false, abandoned: true, reason: "admission-abandoned", runId, waitedMs: 1 };
          resolve(abandoned);
          ended();
        };
        waits.push({ abandon });
        if (opts.reportsPending) input.onPending?.({ runId, abort: () => { aborts.push(runId); abandon(); return settled; } });
      });
    },
  });
  return {
    deps, rows, asked, aborts, waits, advance: (ms: number) => { now += ms; },
    disposed: () => rows.filter((r) => r.step === "sweep.disposed" && r.pr_number === 19122),
    cleanup: async () => {
      for (const w of waits) w.abandon();
      await drainDetachedSweepActions();
      installDetachedWorkHost(undefined); resetChildWork(); rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function untilAsked(asked: readonly unknown[], n: number) {
  for (let i = 0; i < 400 && asked.length < n; i++) await flush();
  assert.equal(asked.length, n, `positive control: the sweep asked the host for fix child ${n}`);
}

test("W1-T13440 criterion 1: a later pass names the queued fix child, its run id and its wait, never the same-pass literal", async () => {
  const f = rig({ reportsPending: true });
  try {
    const first = runSweep([pr()], f.deps);
    await untilAsked(f.asked, 1);
    f.advance(600_000);
    await runSweep([pr()], f.deps);
    const reason = String(f.disposed().at(-1)?.stand_down_reason);
    assert.equal(reason, `duplicate fix-dispatch key (${KEY}) is held by its queued fix dispatch, waiting for the work host to admit run ${RUN} for 600s`);
    assert.doesNotMatch(reason, /already claimed this pass/);
    assert.equal(f.disposed().at(-1)?.child_run_id, RUN);
    assert.equal(f.disposed().at(-1)?.in_flight_phase, "admission");
    assert.equal(f.asked.length, 1, "the later pass did not dispatch a second child");
    assert.deepEqual(f.aborts, [], "inside the bound the wait is kept");
    f.waits[0]!.abandon();
    await first;
  } finally { await f.cleanup(); }
});

test("W1-T13440 criterion 2: queuing a host fix child writes one ledger row with the PR, the fix key and the run id", async () => {
  const f = rig({ reportsPending: true });
  try {
    const first = runSweep([pr()], f.deps);
    await untilAsked(f.asked, 1);
    f.advance(60_000);
    await runSweep([pr()], f.deps);
    const queued = f.rows.filter((r) => r.step === "sweep.fix.child_queued");
    assert.equal(queued.length, 1, "one row on queue; a stand-down pass writes none");
    assert.deepEqual({ pr: queued[0]!.pr_number, head: queued[0]!.head_sha, key: queued[0]!.fix_key, run: queued[0]!.child_run_id },
      { pr: 19122, head: HEAD, key: KEY, run: RUN });
    f.waits[0]!.abandon();
    await first;
  } finally { await f.cleanup(); }

  // The real host hands the hook to the run child's reservation wait.
  const dir = mkdtempSync(join(tmpdir(), "rmd-t13440-host-"));
  try {
    let handed: ((pending: RunChildPending) => void) | undefined;
    const fixWaited = [{ step: "daemon.freshness_drain.completed", duration_ms: 9_000,
      waited_on: [{ what: "detached", kind: "fix-dispatch", settled_after_ms: 6_000 }] }];
    const host = createDetachedWorkHost({ stateRoot: dir, repoDir: dir, root: dir, repo: "fixture", log: () => {},
      readLedger: () => fixWaited, readMode: () => "on",
      spawn: (async (input: { onPending?: (pending: RunChildPending) => void }) => {
        handed = input.onPending;
        return { started: false, reason: "unavailable" };
      }) as unknown as typeof spawnRunChild });
    const hook = () => {};
    await host.spawnFix({ pr: { prNumber: 19122, headSha: HEAD, taskId: TASK }, fixKey: KEY, envelope: {}, onPending: hook });
    assert.equal(handed, hook, "spawnFix passes onPending through to spawnRunChild");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("W1-T13440 criterion 3: past the bound a later pass releases the key, ledgers the wait, and the next pass dispatches again", async () => {
  const f = rig({ reportsPending: true });
  try {
    const first = runSweep([pr()], f.deps);
    await untilAsked(f.asked, 1);
    f.advance(QUEUED_FIX_ADMISSION_RELEASE_MS - 1_000);
    await runSweep([pr()], f.deps);
    assert.deepEqual(f.aborts, [], "control: one second inside the bound releases nothing");
    f.advance(1_000);
    await runSweep([pr()], f.deps);
    assert.deepEqual(f.aborts, [RUN], "the bound aborts the queued wait");
    const released = f.rows.filter((r) => r.step === "sweep.fix.child_admission_released");
    assert.equal(released.length, 1);
    assert.deepEqual({ key: released[0]!.fix_key, run: released[0]!.child_run_id, waited: released[0]!.waited_ms, bound: released[0]!.bound_ms },
      { key: KEY, run: RUN, waited: QUEUED_FIX_ADMISSION_RELEASE_MS, bound: QUEUED_FIX_ADMISSION_RELEASE_MS });
    await first;
    const failed = f.rows.filter((r) => r.step === "sweep.fix.dispatch_failed");
    assert.equal(failed.length, 1, "the awaiting pass ledgers the abandoned admission");
    assert.equal(failed[0]!.admission_run_id, RUN);

    // The sweep's own retry backoff for a failed dispatch still applies; past it the key is free.
    f.advance(5 * 60_000);
    const next = runSweep([pr()], f.deps);
    await untilAsked(f.asked, 2);
    assert.equal(f.asked[1]!.fixKey, KEY, "the released key is dispatched again");
    f.waits[1]!.abandon();
    await next;
  } finally { await f.cleanup(); }
});

test("a host launch without an admission callback names its age and keeps its claim past the queue bound", async () => {
  const f = rig({ reportsPending: false });
  try {
    const first = runSweep([pr()], f.deps);
    await untilAsked(f.asked, 1);
    f.advance(QUEUED_FIX_ADMISSION_RELEASE_MS * 2);
    await runSweep([pr()], f.deps);
    const disposed = f.disposed().at(-1);
    assert.equal(disposed?.stand_down_reason,
      `duplicate fix-dispatch key (${KEY}) is held by a fix child launch in progress for ${QUEUED_FIX_ADMISSION_RELEASE_MS * 2 / 1000}s`);
    assert.equal(disposed?.in_flight_action, "fix-child-launch");
    assert.equal(disposed?.in_flight_age_ms, QUEUED_FIX_ADMISSION_RELEASE_MS * 2);
    assert.equal(f.asked.length, 1);
    assert.deepEqual(f.aborts, [], "only a reported admission wait can be aborted");
    assert.equal(f.rows.some((r) => r.step === "sweep.fix.child_queued"), false);
    assert.equal(f.rows.some((r) => r.step === "sweep.fix.child_admission_released"), false);
    f.waits[0]!.abandon();
    await first;
  } finally { await f.cleanup(); }
});

test("W1-T13440 criterion 4: invariant:same-pass-race-unchanged — an inline claim keeps the full fallback", async () => {
  const f = rig({ reportsPending: false });
  let enter!: () => void;
  let settle!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const settled = new Promise<void>(resolve => { settle = resolve; });
  let dispatches = 0;
  f.deps.detachFixWait = false;
  f.deps.dispatchFix = async () => {
    dispatches++;
    enter();
    await settled;
  };
  const first = runSweep([pr()], f.deps);
  try {
    await entered;
    await runSweep([pr()], f.deps);
    const disposed = f.disposed().at(-1);
    assert.equal(disposed?.stand_down_reason,
      `duplicate fix-dispatch key (${KEY}) already claimed this pass — a concurrent sweep is already dispatching this PR's fix rung`);
    assert.equal(disposed?.in_flight_action, undefined);
    assert.equal(dispatches, 1);
    assert.deepEqual(f.asked, []);
  } finally {
    settle();
    try { await first; } finally { await f.cleanup(); }
  }
});
