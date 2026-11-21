import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import {
  DEFAULT_SWEEP_POLICY,
  acquireFixRoundClaim,
  buildFixDispatchEnvelope,
  deferToLiveFixRound,
  drainDetachedSweepActions,
  fixAdmissionLockPath,
  fixRoundBranchClaim,
  fixRoundClaimEnded,
  fixRoundHandoffPath,
  fixRoundIsLiveOnHead,
  readFixRoundHandoff,
  installDetachedWorkHost,
  reclaimFixRoundBranch,
  resetChildWork,
  runFixDispatchChild,
  runSweep,
  type FixRoundLiveProbe,
  type OpenPrView,
  type SweepDeps,
} from "#src/lib/sweep.js";
import { InflightLockError, acquireInflightLock, readInflightLock, type InflightLockInfo } from "#src/lib/inflight-lock.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { Plan, Task } from "#src/lib/plan.js";
import type { SpawnWorkerArgs, WorkerResult } from "#src/lib/worker.js";
import {
  buildSweepEffects,
  captureRegisteredFixOwnerSnapshot,
  fixBranchClaimKey,
  registeredFixWorktreeOwner,
  removeAbandonedFixWorktreeOwner,
  waitForCiGreen,
  type BuildSweepEffectsDeps,
} from "#test/helpers/run-task-test.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { commitInsideFixture } from "#test/helpers/fixture-commit.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const TASK = "W1-T900";
const PR = 19771;
const BRANCH = "run-W1-T900-1795148454407";
const PUSHED = "11ddc2fe";
const ROUND = "work-fix-dispatch-W1-T900-1795148454407-5263";
const CLAIM = `${ROUND}:fix-claim:${PR}:1795148611956`;
const BOUND_MS = 3_600_000;
const PROCESS_START = "proc:12345";
const ROUND_ID = `${ROUND}:1`;
const UNMET = "the live round takes the new failure on its own head";
const HOLDOUT = "a private acceptance claim";
const REMEDY = "remove the unsupported change claim from the report";
const HANDED_CHECK = "lint-shard (2/3)";

type Row = Record<string, unknown>;

function scratch(t: TestContext, kind: string): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t13991-${kind}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const execChild = promisify(execFile);
function child(script: string, input: object) {
  return execChild(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, JSON.stringify(input)],
    { cwd: REPO_ROOT, timeout: 30_000 });
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 500 && !existsSync(path); attempt++) await delay(20);
  assert.ok(existsSync(path), `child did not create ${path}`);
}

const keyFor = (branch: string): string => fixBranchClaimKey("acme", "remudero", branch);

/** A round that pushed PUSHED, wrote fix.done under CLAIM and then started its CI wait. */
function waitingRound(nowMs: number): Row[] {
  return [
    { ts: new Date(nowMs - 120_000).toISOString(), run_id: ROUND, task_id: TASK, step: "fix.done",
      pr_number: PR, round_id: ROUND_ID, branch_claim_run_id: CLAIM, head_sha: "3179eb03", pushed_head_sha: PUSHED },
    { ts: new Date(nowMs - 110_000).toISOString(), run_id: ROUND, task_id: TASK, step: "run.awaiting_external", waiting_on: "ci",
      pr_number: PR, round_id: ROUND_ID, branch_claim_run_id: CLAIM, head_sha: PUSHED, process_start: PROCESS_START,
      round_started_at_ms: nowMs - 180_000 },
  ];
}

function probeFor(holder: Pick<InflightLockInfo, "pid" | "run_id"> & { host?: string }, nowMs: number,
  over: Partial<FixRoundLiveProbe> = {}): FixRoundLiveProbe {
  return { headSha: PUSHED, holder, nowMs, boundMs: BOUND_MS, isPidAlive: () => true, processStart: () => PROCESS_START,
    hostname: hostname(), ...over };
}

function reviewGatePr(headSha = PUSHED): OpenPrView {
  return { ...redPr(headSha), checksState: "green", reviewState: "failure", ciFailures: [], redRequiredChecks: [],
    reviewSummary: `Review gate refused: ${REMEDY}`, actionableGateFailures: [{ reason: REMEDY }] };
}

function redPr(headSha = PUSHED): OpenPrView {
  return { prNumber: PR, prUrl: `https://github.com/acme/remudero/pull/${PR}`, taskId: TASK, headSha, headRefName: BRANCH,
    checksState: "red", reviewState: "pending", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    lastActivityAt: new Date().toISOString(), redRequiredChecks: ["coverage-shard (1/12)"],
    ciFailures: [{ name: "coverage-shard (1/12)", logTail: "Error: a line no test executes" }] } as OpenPrView;
}

/** A runSweep harness over one PR whose branch claim lives in `inflightDir`. */
function sweepHarness(t: TestContext, opts: { live: boolean; seam?: boolean; isPidAlive?: FixRoundLiveProbe["isPidAlive"];
  processStart?: FixRoundLiveProbe["processStart"] }) {
  const root = scratch(t, "sweep");
  const inflightDir = join(root, "state", "inflight");
  const nowMs = Date.now();
  const rows: Row[] = [];
  let hold: ReturnType<typeof acquireInflightLock> | undefined;
  const goLive = (): void => {
    hold = acquireInflightLock(inflightDir, keyFor(BRANCH), { run_id: CLAIM });
    mkdirSync(dirname(fixRoundHandoffPath(root, CLAIM)), { recursive: true });
    rows.push(...waitingRound(nowMs));
  };
  if (opts.live) goLive();
  t.after(() => hold?.release());
  const dispatched: number[] = [];
  const admitted: number[] = [];
  const deps: SweepDeps = {
    ledgerPath: join(root, "ledger.ndjson"), runId: "SWEEP-W1T13991", now: () => nowMs,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push({ ts: new Date(nowMs).toISOString(), ...row }); },
    log: (step, extra) => { rows.push({ ts: new Date(nowMs).toISOString(), step, ...(extra ?? {}) }); },
    claimFixAdmission: (view) => { admitted.push(view.prNumber); return { admitted: true }; },
    dispatchFix: (view) => { dispatched.push(view.prNumber); return false; },
    arm: () => assert.fail("a red PR must not arm"), close: () => assert.fail("no close is due"),
    escalate: () => assert.fail("nothing is escalated"),
    ...(opts.seam === false ? {} : {
      deferToLiveFixRound: (pr: OpenPrView, lines: ReadonlyArray<Row>) => deferToLiveFixRound(pr, lines, {
        inflightDir, stateRoot: root, claimKeyFor: keyFor, nowMs, boundMs: BOUND_MS,
        isPidAlive: opts.isPidAlive ?? (() => true), processStart: opts.processStart ?? (() => PROCESS_START), hostname: hostname() }),
    }),
  };
  return { root, inflightDir, rows, deps, dispatched, admitted, nowMs, goLive,
    deferred: () => rows.filter((row) => row.step === "sweep.fix.deferred_to_live_round") };
}

test("W1-T13991 criterion 1: a live waiting round keeps its claim, and the next pass defers to it with one sweep.fix.deferred_to_live_round row", async (t) => {
  const h = sweepHarness(t, { live: true });
  const ledger = join(h.root, "ledger.ndjson");
  writeFileSync(ledger, `${h.rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const key = keyFor(BRANCH);
  const holder = readInflightLock(h.inflightDir, key)!;
  assert.equal(holder.run_id, CLAIM);

  // origin/main's reading: the fix.done row ends the claim, so the next round reclaims it.
  assert.equal(fixRoundClaimEnded(ledger, CLAIM), true);
  // This change: a holder live in its CI wait for the PR's head has not ended, and keeps its claim.
  assert.equal(fixRoundIsLiveOnHead(h.rows, probeFor(holder, h.nowMs)), true);
  assert.equal(fixRoundClaimEnded(ledger, CLAIM, probeFor(holder, h.nowMs)), false);
  assert.throws(() => acquireFixRoundClaim(h.inflightDir, key, "NEXT", (id, held) =>
    fixRoundClaimEnded(ledger, id, held && probeFor(held, h.nowMs))), InflightLockError);
  assert.equal(readInflightLock(h.inflightDir, key)?.run_id, CLAIM, "the live round's claim is kept");

  const first = await runSweep([reviewGatePr()], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.dispatched, [], JSON.stringify(first.actions));
  const action = first.actions.find((a) => a.prNumber === PR)!;
  assert.equal(action.acted, false);
  assert.match(action.reason, new RegExp(`deferred to the live fix round ${ROUND}`));
  assert.equal(h.deferred().length, 1);
  assert.equal(h.deferred()[0].live_round_run_id, ROUND);
  assert.equal(h.deferred()[0].claim_run_id, CLAIM);
  const marker = readFixRoundHandoff(fixRoundHandoffPath(h.root, CLAIM));
  assert.equal(marker?.failure, "review");
  assert.deepEqual(marker?.unmet_criteria, []);
  assert.deepEqual(marker?.actionable_gate_failures, [{ reason: REMEDY }]);

  await runSweep([reviewGatePr()], h.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.dispatched, [], "no second round on the live round's head");
  assert.equal(h.deferred().length, 1, "one row per hand-off, not one per pass");

  // origin/main's sweep, with no deferral: a second round is dispatched on the same head.
  const base = sweepHarness(t, { live: true, seam: false });
  await runSweep([reviewGatePr()], base.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(base.dispatched, [PR]);
  assert.equal(base.deferred().length, 0);

  // Two independent sweeps stage the same handoff before either is allowed to publish it.
  const race = sweepHarness(t, { live: true });
  const script = `
    import { existsSync, writeFileSync } from "node:fs";
    import { hostname } from "node:os";
    import { deferToLiveFixRound, runSweep, DEFAULT_SWEEP_POLICY } from "#src/lib/sweep.js";
    const { root, inflightDir, key, pr, rows, ready, peer, nowMs, boundMs, start } = JSON.parse(process.argv[1]);
    const log = [];
    const pass = await runSweep([pr], {
      ledgerPath: root + "/ledger.ndjson", runId: ready, now: () => nowMs, readLedger: () => rows, appendLine: () => {},
      log: (step, fields) => log.push({ step, ...fields }),
      deferToLiveFixRound: (pr, lines) => deferToLiveFixRound(pr, lines, {
        stateRoot: root, inflightDir, claimKeyFor: () => key, nowMs, boundMs,
        isPidAlive: () => true, processStart: () => start, hostname: hostname(),
        beforePublish: () => {
          writeFileSync(ready, "");
          const wake = new Int32Array(new SharedArrayBuffer(4));
          for (let n = 0; n < 500 && !existsSync(peer); n++) Atomics.wait(wake, 0, 0, 20);
          if (!existsSync(peer)) throw new Error("peer did not reach publication");
        },
      }),
      dispatchFix: () => { throw new Error("unexpected dispatch"); },
    }, DEFAULT_SWEEP_POLICY);
    console.log(JSON.stringify({ acted: pass.actions[0].acted, reason: pass.actions[0].reason,
      deferrals: log.filter(row => row.step === "sweep.fix.deferred_to_live_round") }));
  `;
  const inputs = { root: race.root, inflightDir: race.inflightDir, key, pr: reviewGatePr(), rows: race.rows,
    nowMs: race.nowMs, boundMs: BOUND_MS, start: PROCESS_START };
  const readyA = join(race.root, "a-ready");
  const readyB = join(race.root, "b-ready");
  const results = await Promise.allSettled([
    child(script, { ...inputs, ready: readyA, peer: readyB }),
    child(script, { ...inputs, ready: readyB, peer: readyA }),
  ]);
  const passes = results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return JSON.parse(result.value.stdout) as { acted: boolean; reason: string; deferrals: Row[] };
  });
  for (const pass of passes) {
    assert.equal(pass.acted, false);
    assert.match(pass.reason, /deferred to the live fix round/);
  }
  assert.deepEqual(passes.flatMap((pass) => pass.deferrals).map((row) => row.live_round_run_id), [ROUND]);
  const retired = sweepHarness(t, { live: true });
  const retiredPath = fixRoundHandoffPath(retired.root, CLAIM);
  const late = deferToLiveFixRound(reviewGatePr(), retired.rows, {
    inflightDir: retired.inflightDir, stateRoot: retired.root, claimKeyFor: keyFor, nowMs: retired.nowMs, boundMs: BOUND_MS,
    isPidAlive: () => true, processStart: () => PROCESS_START, hostname: hostname(),
    beforePublish: () => rmSync(dirname(retiredPath), { recursive: true }),
  });
  assert.equal(late, undefined, "a sweep that staged before retirement cannot publish afterward");
  assert.equal(existsSync(dirname(retiredPath)), false);
});

test("W1-T13991 criterion 3: independent sweep processes charge at most one fix round per PR", async (t) => {
  const h = sweepHarness(t, { live: false });
  const dir = join(h.root, "fix-admission");
  const ready = join(h.root, "charged");
  const park = join(h.root, "park");
  const parked = join(h.root, "parked");
  const settle = join(h.root, "settle");
  const old = redPr("3179eb03");
  const current = redPr();
  const script = `
    import { existsSync, writeFileSync } from "node:fs";
    import { setTimeout as delay } from "node:timers/promises";
    import { runFixDispatchChild } from "#src/lib/sweep.js";
    const { envelope, ready, park, parked, settle } = JSON.parse(process.argv[1]);
    const charges = [];
    const until = async (path) => {
      for (let n = 0; n < 750 && !existsSync(path); n++) await delay(20);
      if (!existsSync(path)) throw new Error("parent did not create " + path);
    };
    let refusal;
    try {
      await runFixDispatchChild({ envelope }, {
        readLivePr: async () => ({ state: "OPEN", headSha: envelope.pr.headSha }),
        readTask: () => ({ found: true, merged: false, retired: false }),
        hold: () => undefined,
        log: () => {},
        claimFixAdmission: () => {
          charges.push("charged");
          return { admitted: true, release: () => charges.push("released") };
        },
        dispatcher: () => ({
          dispatchFix: async (_pr, _evidence, onPhase) => {
            if (!ready) return;
            writeFileSync(ready, "");
            await until(park);
            onPhase("ci-wait");
            writeFileSync(parked, "");
            await until(settle);
          },
        }),
      });
    } catch (error) {
      refusal = error.message;
    }
    console.log(JSON.stringify({ charges, refusal }));
  `;
  const envelope = (pr: OpenPrView) => buildFixDispatchEnvelope(pr, { unmetCriteria: [] },
    { fixKey: `${TASK}@${pr.headSha}`, decidedAtMs: h.nowMs, fixAdmissionLockDir: dir });
  const first = child(script, { envelope: envelope(old), ready, park, parked, settle });
  const firstResult = first.then((value) => ({ value }), (error: unknown) => ({ error }));
  try {
    await waitForFile(ready);
    const second = await child(script, { envelope: envelope(current) });
    const refused = JSON.parse(second.stdout);
    assert.deepEqual(refused.charges, []);
    assert.match(refused.refusal, /already holds admission/);

    const deps = { ...h.deps, fixAdmissionLockDir: dir };
    const refusedSweep = await runSweep([current], deps, DEFAULT_SWEEP_POLICY);
    assert.match(refusedSweep.actions[0].reason, /already holds admission/);
    assert.deepEqual(h.admitted, []);
    assert.deepEqual(h.dispatched, []);

    writeFileSync(park, "");
    await waitForFile(parked);
    h.goLive();
    await runSweep([redPr()], deps, DEFAULT_SWEEP_POLICY);
    assert.equal(h.deferred().length, 1, "the parked round receives its own head's failure before admission");
    assert.deepEqual(h.admitted, []);

    await runSweep([redPr("foreign")], deps, DEFAULT_SWEEP_POLICY);
    assert.deepEqual(h.dispatched, [PR], "a foreign head can be redispatched while the old round waits");
    assert.deepEqual(h.admitted, [PR]);
  } finally {
    writeFileSync(park, "");
    writeFileSync(settle, "");
    const settled = await firstResult;
    if ("error" in settled) throw settled.error;
    assert.deepEqual(JSON.parse(settled.value.stdout), { charges: ["charged", "released"] });
  }
});

test("W1-T13991 criterion 4: a dead round, an ended round and a head someone else moved are reclaimed as on origin/main", async (t) => {
  const root = scratch(t, "doubt");
  const inflightDir = join(root, "inflight");
  const ledger = join(root, "ledger.ndjson");
  const nowMs = Date.now();
  const holder = { pid: process.pid, run_id: CLAIM, host: hostname() };
  const later = new Date(nowMs - 100_000).toISOString();
  const cases: Array<[string, Row[], Partial<FixRoundLiveProbe>]> = [
    ["the round's process is gone", waitingRound(nowMs), { isPidAlive: () => false }],
    ["the PID now belongs to another process", waitingRound(nowMs), { processStart: () => "proc:45678" }],
    ["the process start is unreadable", waitingRound(nowMs), { processStart: () => undefined }],
    ["the claim names another host", waitingRound(nowMs), { holder: { ...holder, host: "another-host" } }],
    ["someone else moved the head", waitingRound(nowMs), { headSha: "f00dfeed" }],
    ...["fix.stood_down", "run.freshness_handoff", "fix.ci_not_green", "fix.commit_refused", "sweep.fix.error"].map(
      (step): [string, Row[], Partial<FixRoundLiveProbe>] =>
        [step, [...waitingRound(nowMs), { ts: later, run_id: ROUND, pr_number: PR, step }], {}]),
    ["the round is past its spawn bound", waitingRound(nowMs), { nowMs: nowMs + BOUND_MS - 150_000 }],
    ["the round never started its wait", waitingRound(nowMs).slice(0, 1), {}],
  ];
  for (const [name, rows, over] of cases) {
    writeFileSync(ledger, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const probe = probeFor(holder, nowMs, over);
    assert.equal(fixRoundIsLiveOnHead(rows, probe), false, name);
    assert.equal(fixRoundClaimEnded(ledger, CLAIM, probe), true, name);
    const key = keyFor(`run-W1-T900-${cases.findIndex(([n]) => n === name)}`);
    const stale = acquireInflightLock(inflightDir, key, { run_id: CLAIM });
    const taken = acquireFixRoundClaim(inflightDir, key, "NEXT", (id, held) => fixRoundClaimEnded(ledger, id, held && probeFor(held, nowMs, over)));
    assert.equal(taken.endedRunId, CLAIM, `${name}: reclaimed exactly as origin/main reclaims an ended round`);
    taken.handle.release();
    stale.release();
  }

  for (const [name, head, options] of [
    ["dead", PUSHED, { isPidAlive: () => false }],
    ["reused PID", PUSHED, { processStart: () => "proc:45678" }],
    ["moved", "f00dfeed", {}],
  ] as const) {
    const h = sweepHarness(t, { live: true, ...options });
    await runSweep([redPr(head)], h.deps, DEFAULT_SWEEP_POLICY);
    assert.deepEqual(h.dispatched, [PR], name);
    assert.equal(h.deferred().length, 0, name);
  }
  // A conflicted head is a conflict round's, as before.
  const dirty = sweepHarness(t, { live: true });
  assert.equal(dirty.deps.deferToLiveFixRound!({ ...redPr(), mergeState: "dirty" } as OpenPrView, dirty.rows), undefined);

  // The claim key, and the release on every ending path: without a re-take under a given id, no claim is held
  // through a wait (the operator run-task path); with one, a replacement holder is never unlinked.
  assert.equal(keyFor("run-X-1"), "fix-branch--acme--remudero--run-X-1");
  const key = keyFor("run-W1-T900-hold");
  const plain = fixRoundBranchClaim(acquireInflightLock(inflightDir, key, { run_id: "P1" }), () => "refused");
  assert.equal(plain.holdForWait, undefined);
  plain.release();
  const retakeAs = (id: string) => reclaimFixRoundBranch({ inflightDir, claimKey: key, claimRunId: id, roundEnded: () => false, ownsWorktree: () => true });
  const claim = fixRoundBranchClaim(acquireInflightLock(inflightDir, key, { run_id: "R1" }), () => retakeAs("R2"), retakeAs);
  claim.release();
  assert.equal(readInflightLock(inflightDir, key), null, "fix.done still releases the claim");
  assert.equal(claim.holdForWait!(), undefined);
  assert.equal(readInflightLock(inflightDir, key)?.run_id, "R1", "the wait holds the claim fix.done named");
  rmSync(join(inflightDir, `${key}.lock`));
  const successor = acquireInflightLock(inflightDir, key, { run_id: "SUCCESSOR" });
  assert.equal(claim.reacquire(), "branch claim held by SUCCESSOR", "a replaced claim stands the round down as before");
  assert.equal(readInflightLock(inflightDir, key)?.run_id, "SUCCESSOR", "and the successor's claim is untouched");
  successor.release();

  // Recycle and error paths release directly, before the normal post-CI ownership check.
  const ending = fixRoundBranchClaim(acquireInflightLock(inflightDir, key, { run_id: "ENDING" }), () => retakeAs("R3"), retakeAs);
  ending.release();
  assert.equal(ending.holdForWait!(), undefined);
  rmSync(join(inflightDir, `${key}.lock`));
  const replacement = acquireInflightLock(inflightDir, key, { run_id: "REPLACEMENT" });
  try {
    ending.release();
    assert.equal(readInflightLock(inflightDir, key)?.run_id, "REPLACEMENT", "cleanup preserves a successor without a prior verification");
  } finally {
    replacement.release();
  }
});

test("W1-T13991 criterion 3: a hosted round holds the PR's admission through the host's reservation, and its child adopts it", async (t) => {
  const root = scratch(t, "hosted");
  const dir = join(root, "fix-admission");
  const rows: Row[] = [];
  const nowMs = Date.now();
  const charges: string[] = [];
  const holder = (path: string): string | undefined => {
    try { return (JSON.parse(readFileSync(path, "utf8")) as { run_id?: string }).run_id; } catch { return undefined; }
  };
  const depsFor = (runId: string): SweepDeps => ({
    ledgerPath: join(root, "ledger.ndjson"), runId, now: () => nowMs, detachFixWait: true, fixAdmissionLockDir: dir,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push({ ts: new Date(nowMs).toISOString(), ...row }); },
    log: (step, extra) => { rows.push({ ts: new Date(nowMs).toISOString(), step, ...(extra ?? {}) }); },
    claimFixAdmission: (view) => {
      charges.push(`${runId}@${view.headSha}`);
      return { admitted: true, release: () => charges.push(`${runId}:released`) };
    },
    dispatchFix: () => assert.fail("a hosted fix never runs in process"),
    arm: () => assert.fail("a red PR must not arm"), close: () => assert.fail("no close is due"),
    escalate: () => assert.fail("nothing is escalated"),
  });
  const seen: { atReservation?: string; inEnvelope?: string; overlapping?: string; inChild?: string } = {};
  t.after(() => { installDetachedWorkHost(undefined); resetChildWork(); });
  installDetachedWorkHost({
    hosts: new Set(["review", "fix-dispatch"]), mode: () => "on", spawnReview: async () => undefined,
    spawnFix: async (input) => {
      // The host reserves the child's memory here, before the child reaches its own admission.
      const path = fixAdmissionLockPath(dir, input.envelope.pr);
      seen.atReservation = holder(path);
      seen.inEnvelope = input.envelope.fixAdmissionOwner?.run_id;
      const overlapping = await runSweep([redPr("f00dfeed")], depsFor("SWEEP-B"), DEFAULT_SWEEP_POLICY);
      seen.overlapping = overlapping.actions.find((action) => action.prNumber === PR)?.reason;
      await runFixDispatchChild({ envelope: input.envelope }, {
        readLivePr: async () => ({ state: "OPEN", headSha: input.envelope.pr.headSha }),
        readTask: () => ({ found: true, merged: false, retired: false }),
        hold: () => undefined, log: () => {},
        claimFixAdmission: () => {
          charges.push("child");
          return { admitted: true, release: () => charges.push("child:released") };
        },
        dispatcher: () => ({ dispatchFix: async () => { seen.inChild = holder(path); } }),
      } as never);
      return { runId: "work-fix-dispatch-R1", settled: Promise.resolve() };
    },
  });
  await runSweep([redPr()], depsFor("SWEEP-A"), DEFAULT_SWEEP_POLICY);
  await drainDetachedSweepActions();
  assert.ok(seen.atReservation !== undefined, "the sweep's admission lock is held while the host reserves the child's memory");
  assert.equal(seen.atReservation, seen.inEnvelope, "the envelope names that holder for the child");
  assert.match(String(seen.overlapping), /already holds admission/, "an overlapping round for the PR is refused before any reservation");
  assert.ok(seen.inChild !== undefined && seen.inChild !== seen.atReservation, "the child adopted the lock in place");
  assert.deepEqual(charges, [`SWEEP-A@${PUSHED}`, "SWEEP-A:released", "child", "child:released"], "one round charged at a time");
  assert.equal(holder(fixAdmissionLockPath(dir, redPr())), undefined, "the lock is free once the child ends");
});

test("W1-T13991 criterion 4: an abandoned admission lock another host left in shared state never blocks this host's redispatch", async (t) => {
  const h = sweepHarness(t, { live: false });
  const dir = join(h.root, "fix-admission");
  const foreign = fixAdmissionLockPath(dir, redPr(), "build-host-b");
  mkdirSync(dirname(foreign), { recursive: true });
  writeFileSync(foreign, JSON.stringify({ run_id: "ABANDONED", pid: 4242, host: "build-host-b",
    startedAt: new Date(h.nowMs - 3_600_000).toISOString() }));
  assert.notEqual(foreign, fixAdmissionLockPath(dir, redPr()), "the lock is this host's own");
  await runSweep([redPr()], { ...h.deps, fixAdmissionLockDir: dir }, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(h.admitted, [PR], "this host charges its own memory, as on origin/main");
  assert.deepEqual(h.dispatched, [PR]);
  assert.equal(existsSync(foreign), true, "the other host's lock is left to that host");
});

test("W1-T13991 criterion 5: the wait belongs to the exact round and another PR's dispatch under the same run does not end it", () => {
  const nowMs = Date.now();
  const probe = probeFor({ pid: process.pid, run_id: CLAIM, host: hostname() }, nowMs);
  const [done, wait] = waitingRound(nowMs);
  const unrelated = { run_id: ROUND, pr_number: PR + 1, ts: new Date(nowMs).toISOString() };
  assert.equal(fixRoundIsLiveOnHead([done, wait, { ...unrelated, step: "fix.dispatch" }], probe), true);
  assert.equal(fixRoundIsLiveOnHead([done, { ...wait, ...unrelated }], probe), false);
  assert.equal(fixRoundIsLiveOnHead([done, { ...wait, waiting_on: "pr" }], probe), false);
  assert.equal(fixRoundIsLiveOnHead([done, { ...wait, head_sha: "f00dfeed" }], probe), false);
  assert.equal(fixRoundIsLiveOnHead([done, { ...wait, round_id: "OTHER" }], probe), false);
  assert.equal(fixRoundIsLiveOnHead([done, wait, { ...unrelated, pr_number: PR, step: "fix.dispatch" }], probe), false);
});

// ── the sweep's real dispatchFix and fix rung ───────────────────────────────────────────────

const PLAN: Plan = (() => {
  const tasks = [{ id: TASK, title: TASK, risk: "low", acceptance: [
    { claim: HOLDOUT, proof: "unit test: private proof", holdout: true },
    { claim: UNMET, proof: "unit test: takes it" },
  ], verify: "auto",
    files: [], status: "queued" } as unknown as Task];
  return { tasks, byId: new Map(tasks.map((task) => [task.id, task])) };
})();

function worker(text: string): WorkerResult {
  return {
    sessionId: "fix-session", costUsd: 1, numTurns: 2, text, blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "sonnet", effort: "medium",
    tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  };
}

test("W1-T13991 criterion 2: red checks and failing reviews resume the round in its own worktree with the original criterion index", async (t) => {
  for (const failure of ["review", "public-criterion", "check", "check-pending", "foreign-head", "marker-error"] as const) {
    const root = scratch(t, `rung-${failure}`);
    const repo = "scratch-w1t13991";
    // A checkout of a bare origin under <root>/repos/<repo>, with the run branch pushed.
    const origin = gitRepo({ bare: true, kind: "w1t13991-origin" });
    t.after(() => origin.cleanup());
    const seed = gitRepo({ kind: "w1t13991-seed" });
    seed.addRemote("origin", origin.dir);
    seed.git("push", "--quiet", "origin", "main");
    seed.git("checkout", "--quiet", "-b", BRANCH);
    commitInsideFixture(seed.dir, seed.dir, "seed.txt", "chore: ours");
    seed.git("push", "--quiet", "origin", BRANCH);
    seed.git("checkout", "--quiet", "main");
    mkdirSync(join(root, "repos"), { recursive: true });
    renameSync(seed.dir, join(root, "repos", repo));
    mkdirSync(join(root, "worktrees"), { recursive: true });
    const ledger = join(root, "ledger.ndjson");
    const key = fixBranchClaimKey("acme", repo, BRANCH);
    const logs: Row[] = [];
    const spawns: SpawnWorkerArgs[] = [];
    const seen: { heldDuringWait?: string; deferral?: unknown; waitedOut?: boolean; foreignPolls?: number;
      lockAtWaitRow?: string | null; racerRefused?: boolean } = {};
    let waits = 0;
    let successor: InflightLockInfo | undefined;
    const shim = ghShim([
      { when: "commits/cafe1234/check-runs", stdout: JSON.stringify({ check_runs: [{ name: "ci", status: "completed", conclusion: "failure" }] }) },
      { when: "commits/cafe1234/status", stdout: JSON.stringify({ state: "failure", statuses: [] }) },
      { when: "headRefName", stdout: JSON.stringify({ headRefName: BRANCH, headRefOid: "cafe1234", body: "" }) },
      { when: `pulls/${PR}`, stdout: JSON.stringify({ state: "open", merged: false, head: { sha: "cafe1234", ref: BRANCH }, base: { sha: "deadbeef" } }) },
      { when: "statusCheckRollup", stdout: JSON.stringify({ statusCheckRollup: [{ __typename: "CheckRun", name: "coverage-shard (1/12)",
        status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/acme/remudero/actions/runs/1/job/2" }] }) },
      { when: "", stdout: "{}" },
    ], { kind: "w1t13991" });
    const oldPath = process.env.PATH;
    process.env.PATH = `${shim.dir}:${oldPath}`;
    try {
      const effects = buildSweepEffects({
        resolveTaskContractAtHeadImpl: () => ({ criteria: PLAN.tasks[0].acceptance }),
        owner: "acme", repo, config: { root } as never, ledgerPath: ledger, runId: "SWEEP-W1T13991", plan: PLAN,
        policy: DEFAULT_SWEEP_POLICY,
        log: (step: string, fields?: Row) => {
          const row = { ts: new Date().toISOString(), run_id: "SWEEP-W1T13991", step, ...(fields ?? {}) };
          // The first wait row that reads the round live: the claim fix.done released must not be re-taken yet.
          if (step === "run.awaiting_external" && fields?.branch_claim_run_id !== undefined && seen.lockAtWaitRow === undefined) {
            seen.lockAtWaitRow = readInflightLock(join(root, "state", "inflight"), key)?.run_id ?? null;
          }
          logs.push(row);
          appendFileSync(ledger, `${JSON.stringify(row)}\n`);
        },
        spawnImpl: (async (args: SpawnWorkerArgs) => {
          spawns.push(args);
          commitInsideFixture(root, args.cwd, `fix-${spawns.length}.txt`, "fix(ci): repair the check");
          return worker("REPORT\nfixed\nCOMMIT_MESSAGE: fix(ci): repair the check");
        }) as never,
        registeredWorktreeOwnerImpl: (repoDir: string, branchRef: string) => registeredFixWorktreeOwner(repoDir, branchRef),
        registeredOwnerRecovery: {
          capture: (args: Parameters<typeof captureRegisteredFixOwnerSnapshot>[0]) => captureRegisteredFixOwnerSnapshot(args,
            { processCensus: () => ({ state: "clear", scanned: 1 }) }),
          remove: (repoDir: string, ownerPath: string) => removeAbandonedFixWorktreeOwner(repoDir, ownerPath),
        },
        pushFixRoundImpl: async () => undefined,
        waitForCiGreenImpl: async (url: string, waitLog: (step: string, extra?: Row) => void, _every: number,
          poll: { sleep: (ms: number) => Promise<void>; readJson: (args: string[]) => Promise<unknown> }) => {
          if (++waits > 1) return { state: "red", sha: logs.findLast((row) => row.step === "fix.done")?.pushed_head_sha };
          const done = logs.find((row) => row.step === "fix.done")!;
          // GitHub now reads the head this round pushed.
          const head = String(done.pushed_head_sha);
          shim.addRoute({ when: `pulls/${PR}`, stdout: JSON.stringify({ state: "open", merged: false, head: { sha: head, ref: BRANCH }, base: { sha: "deadbeef" } }) });
          shim.addRoute({ when: "headRefName", stdout: JSON.stringify({ headRefName: BRANCH, headRefOid: head, body: "" }) });
          const logWait = (step: string, extra?: Row) => {
            waitLog(step, extra);
            if (step === "run.awaiting_external") seen.heldDuringWait = readInflightLock(join(root, "state", "inflight"), key)?.run_id;
          };
          const handoff = (view: OpenPrView) => {
            seen.deferral = (effects as unknown as Required<Pick<SweepDeps, "deferToLiveFixRound">>).deferToLiveFixRound(view,
              readFileSync(ledger, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Row));
          };
          if (failure === "check" || failure === "check-pending" || failure === "foreign-head") {
            let polls = 0;
            // The rollup lags the red the sweep saw: only the hand-off names the failing check.
            if (failure === "check-pending") shim.addRoute({ when: "statusCheckRollup", stdout: JSON.stringify({ statusCheckRollup: [] }) });
            return waitForCiGreen(url, logWait, 0, {
              sleep: async () => {
                await poll.sleep(0);
                if (failure === "foreign-head") {
                  shim.addRoute({ when: `pulls/${PR}`, stdout: JSON.stringify({ state: "open", merged: false,
                    head: { sha: "f00dfeed", ref: BRANCH }, base: { sha: "deadbeef" } }) });
                }
              },
              requiredContexts: () => ["coverage-shard (1/12)"],
              readJson: async (args) => {
                if (args[1].includes("commits/f00dfeed/check-runs")) {
                  seen.foreignPolls = (seen.foreignPolls ?? 0) + 1;
                  if (seen.foreignPolls === 1) {
                    const inflightDir = join(root, "state", "inflight");
                    const taken = acquireFixRoundClaim(inflightDir, key, "SUCCESSOR", (id, held) =>
                      fixRoundClaimEnded(ledger, id, held && probeFor(held, Date.now(), { headSha: "f00dfeed" })));
                    assert.equal(taken.endedRunId, done.branch_claim_run_id);
                    successor = taken.handle.info;
                    t.after(() => taken.handle.release());
                  }
                  const failed = seen.foreignPolls > 1;
                  return { check_runs: [{ name: "coverage-shard (1/12)", status: failed ? "completed" : "in_progress",
                    conclusion: failed ? "failure" : null }] };
                }
                if (args[1].includes(`commits/${head}/check-runs`) && failure === "check-pending") {
                  // The sweep hands the red over while this head's checks still read pending: the hand-off ends the wait.
                  // Poll 1 starts the wait (its row reads the round live); the hand-off lands at poll 2, checks still pending.
                  if (++polls === 2) handoff({ ...redPr(head), redRequiredChecks: [HANDED_CHECK],
                    ciFailures: [{ name: HANDED_CHECK, logTail: "Error: the red the sweep handed over" }] } as OpenPrView);
                  if (polls > 2) seen.waitedOut = true;
                  const stuck = polls > 4; // never reached when the hand-off ends the wait; it bounds a red run
                  return { check_runs: [{ name: "coverage-shard (1/12)", status: stuck ? "completed" : "in_progress",
                    conclusion: stuck ? "failure" : null }] };
                }
                if (args[1].includes(`commits/${head}/check-runs`)) {
                  const failed = ++polls > 1;
                  if (failed) handoff(redPr(head));
                  return { check_runs: [{ name: "coverage-shard (1/12)", status: failed ? "completed" : "in_progress",
                    conclusion: failed ? "failure" : null }] };
                }
                if (args[1].endsWith("/status")) return { statuses: [] };
                if (args[1].includes("actions/runs?")) return { workflow_runs: [] };
                return poll.readJson(args);
              },
            });
          }
          logWait("run.awaiting_external", { waiting_on: "ci", head_sha: head });
          if (failure === "review") {
            // A sweep racing the round into its wait: it reads the re-taken claim, and the wait beside it.
            try {
              acquireFixRoundClaim(join(root, "state", "inflight"), key, "RACER", (id, held) =>
                fixRoundClaimEnded(ledger, id, held && probeFor(held, Date.now(), { headSha: head, processStart: undefined })));
              seen.racerRefused = false;
            } catch (error) {
              seen.racerRefused = error instanceof InflightLockError;
            }
          }
          if (failure === "marker-error") {
            mkdirSync(fixRoundHandoffPath(root, String(done.branch_claim_run_id)), { recursive: true });
            await poll.sleep(0);
            return { state: "freshness_handoff", sha: head, recycle: "fixture recycle" };
          }
          const sleeping = poll.sleep(0);
          handoff(failure === "public-criterion" ? {
            ...reviewGatePr(head),
            actionableGateFailures: [],
            unmetCriteria: [{ claim: UNMET, proof: "unit test: takes it", met: false, reason: "public criterion still unmet",
              proof_exec: "executed_pass" }],
          } : reviewGatePr(head));
          await sleeping;
          seen.waitedOut = true;
          return "pending" as never;
        },
      } as unknown as BuildSweepEffectsDeps);
      // The round was dispatched on an earlier red ("ci"); the new failure on its own push is another.
      const pr = { ...redPr("cafe1234"), prUrl: `https://github.com/acme/${repo}/pull/${PR}`, redRequiredChecks: ["ci"],
        ciFailures: [{ name: "ci", logTail: "Error: the first red" }] } as OpenPrView;
      await effects.dispatchFix(pr as never, { unmetCriteria: [], ciFailures: pr.ciFailures } as never);
    } finally {
      process.env.PATH = oldPath;
      rmSync(shim.dir, { recursive: true, force: true });
    }
    const steps = (step: string) => logs.filter((row) => row.step === step);
    const firstDone = steps("fix.done")[0];
    assert.equal(seen.lockAtWaitRow, null, `${failure}: the wait row lands before the claim is re-taken`);
    if (failure === "review") assert.equal(seen.racerRefused, true, "a racing sweep reads the live wait and keeps off the claim");
    assert.equal(seen.heldDuringWait, firstDone?.branch_claim_run_id, `${failure}: the waiting round holds the claim fix.done named`);
    assert.deepEqual(readInflightLock(join(root, "state", "inflight"), key), successor ?? null,
      `${failure}: cleanup never removes a successor's claim`);
    if (failure === "foreign-head") {
      const stoodDown = steps("fix.stood_down")[0];
      assert.equal(stoodDown?.site, "rung.branch_claim");
      assert.equal(stoodDown?.reason, "branch claim held by SUCCESSOR");
      assert.equal(seen.foreignPolls, 2, "the ordinary CI wait reaches its terminal poll before the old round checks ownership");
      assert.equal(steps("fix.live_round_resumed").length, 0);
      assert.equal(spawns.length, 1, "the old round releases instead of striking on the foreign head");
      continue;
    }
    if (failure === "marker-error") {
      assert.ok(steps("sweep.fix.handoff_unreadable").length > 0);
      assert.equal(existsSync(fixRoundHandoffPath(root, String(firstDone?.branch_claim_run_id))), false);
      assert.equal(steps("fix.live_round_resumed").length, 0);
      assert.equal(steps("fix.stood_down")[0]?.reason, "recycle_yield");
      assert.equal(steps("sweep.fix.error").length, 0);
      continue;
    }
    const failureKind = failure === "check" || failure === "check-pending" ? "check" : "review";
    assert.deepEqual(seen.deferral, { liveRoundRunId: "SWEEP-W1T13991", claimRunId: firstDone?.branch_claim_run_id,
      failure: failureKind, handedOff: true });
    assert.equal(seen.waitedOut, undefined, `${failure}: the hand-off ended the wait at its next poll`);
    const resumed = steps("fix.live_round_resumed");
    assert.equal(resumed.length, 1, `${failure}: ${JSON.stringify(logs.map((row) => row.step))}`);
    assert.equal(resumed[0].failure, failureKind);
    assert.equal(resumed[0].head_sha, firstDone?.pushed_head_sha);
    assert.ok(spawns.length >= 2, `${failure}: the round struck again: ${JSON.stringify(logs.slice(logs.indexOf(resumed[0])).map((row) => [row.step, row.reason ?? row.site]))}`);
    assert.equal(spawns[1].cwd, spawns[0].cwd, `${failure}: in its own worktree`);
    if (failure === "review") assert.match(String(spawns[1].prompt), new RegExp(REMEDY), "the strike targets the handed gate remedy");
    else if (failure === "public-criterion") {
      const prompt = String(spawns[1].prompt);
      assert.match(prompt, /public criterion still unmet/);
      assert.match(prompt, new RegExp(UNMET));
      assert.doesNotMatch(prompt, new RegExp(HOLDOUT));
    }
    else {
      assert.ok(logs.indexOf(steps("fix.ci_not_green")[0]) > logs.indexOf(resumed[0]), "the wait reads the handed red");
      if (failure === "check-pending") {
        assert.match(String(spawns[1].prompt), new RegExp(HANDED_CHECK.replace(/[()/]/g, "\\$&")),
          "the strike targets the handed red, though the rollup lags it");
      } else assert.match(String(spawns[1].prompt), /coverage-shard \(1\/12\)/, "the strike targets the red check");
    }
    assert.deepEqual(steps("fix.stood_down").filter((row) => /a later round reclaimed/.test(String(row.reason))), []);
    assert.equal(existsSync(fixRoundHandoffPath(root, String(firstDone?.branch_claim_run_id))), false, `${failure}: the round removed its hand-off when it ended`);
  }
});
