import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os, { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import * as sweep from "#src/lib/sweep.js";
import type { BuildSweepEffectsDeps, FixAdmissionResidents, FixHostPressure, OpenPrView, SweepDeps } from "#src/lib/sweep.js";
import { configPath } from "#src/lib/config.js";
import { createDaemonSlackReclaimer, installDaemonSlackReclaimer, installedDaemonSlackReclaimer } from "#src/lib/daemon-memory-policy.js";
import type { FixProgressJudge } from "#src/lib/fix-progress-judge.js";
import { classEstimate, classTypical } from "#src/lib/host-memory-learning.js";
import { repairMemoryDemandMark } from "#src/lib/repair-memory-demand.js";
import { childIdentity, RUN_CHILD_SCHEMA, runDir, writeStatus } from "#src/lib/run-child-contract.js";
import { TEST_SLOT_DIR_ENV, TEST_SLOT_PARENT_ENV } from "#src/lib/test-slot.js";
import { activeWorkerCount } from "#src/lib/worker.js";

const { buildSweepEffects, createSweepFixAdmissionController, DEFAULT_SWEEP_POLICY, fixAdmissionCauseProbe,
  fixDispatchHoldAtHeadAsync, fixDispatchMemoryCause, productionFixAdmissionResidents, productionFixPressure,
  runSweep, withFullSweepRepairAdmission } = sweep;
const NOW = Date.parse("2026-11-19T17:57:29Z");
const PASS_MS = 5 * 60_000;
const pr: OpenPrView = { prNumber: 19695, prUrl: "https://github.com/craigoley/remudero/pull/19695",
  taskId: "W1-T12041", headSha: "0a66a11", headRefName: "run-W1-T12041-1795100000000",
  reviewState: "success", checksState: "green", unmetCriteria: [], priorStrikes: 0,
  lastActivityAt: new Date(NOW).toISOString(), autoMergeArmed: false, mergeState: "dirty",
  mergeConflict: { files: [{ path: "src/lib/sweep.ts", oursDeleted: 1, theirsDeleted: 1 }], oursLog: "ours", theirsLog: "theirs" } };
const at = (ms: number) => new Date(ms).toISOString();
const MEMORY = "fix dispatch refused: worker admission refused (live host capacity exhausted for this full pass " +
  "(headroom 6149 MiB over the floor; charged 0 MiB for 0 reviews at 2048 and 0 MiB for 0 admitted fixes; a fix needs " +
  "6258 MiB (measured; typical 1754); 8 active, 0 fixes admitted) — repair remains queued and will be re-derived next pass)";
const STAND_IN = "fix dispatch refused: worker admission refused (host worker budget 4 exhausted for this full pass " +
  "(4 active, 0 reserved for review, 0 fixes admitted) — repair remains queued and will be re-derived next pass)";
const failure = (ms: number, error = MEMORY, headSha = pr.headSha) => ({ step: "sweep.fix.dispatch_failed",
  pr_number: pr.prNumber, task_id: pr.taskId, head_sha: headSha, error, ts: at(ms) });
const dispatch = (ms: number, headSha: string) => ({ step: "fix.dispatch", pr_number: pr.prNumber,
  task_id: pr.taskId, head_sha: headSha, ts: at(ms) });
const pass = (ms: number) => ({ step: "sweep.disposed", pr_number: pr.prNumber, head_sha: pr.headSha, ts: at(ms) });
/** A learned 40 min failure-to-success wait at an older head, two memory refusals at this head, and two passes 5 min apart. */
const seed = (): Record<string, unknown>[] => [failure(NOW - 10 * 3_600_000, MEMORY, "1111111"),
  dispatch(NOW - 10 * 3_600_000 + 40 * 60_000, "1111111"), pass(NOW - 2 * PASS_MS), pass(NOW - PASS_MS),
  failure(NOW - 60_000), failure(NOW - 30_000)];

const FLOOR = 1024;
type Readers = Required<Parameters<typeof fixAdmissionCauseProbe>[0]>;
/** The readings the run child reads: a fix p90 of 6258 MiB, a typical of 1754 MiB and one live fix tree. */
const readers = (headroomMib: number, extra: Partial<Readers> = {}): Readers => ({
  hostWorkerBudget: 4, readActiveWorkers: () => 8,
  readPressure: () => ({ availableMib: FLOOR + headroomMib, floorMib: FLOOR, binding: "host",
    tier: headroomMib >= 6258 ? "fits" : "host-short" }),
  readEstimate: (workerClass) => ({ estimateMib: workerClass === "fix" ? 6258 : 2048, samples: 9 }),
  readTypical: (workerClass) => ({ estimateMib: workerClass === "fix" ? 1754 : 1200, samples: 9 }),
  readResidents: () => ({ fix: [1500], review: [] }),
  ...extra,
});
const probeOn = (headroom: () => number): NonNullable<SweepDeps["fixDispatchCauseProbe"]> =>
  async (cause) => fixDispatchMemoryCause(cause) ? fixAdmissionCauseProbe(readers(headroom())) : undefined;
const sweepDeps = (rows: Record<string, unknown>[], counts: { dispatched: number; escalated: number },
  extra: Partial<SweepDeps> = {}): SweepDeps => ({
  arm: () => {}, close: () => {}, dispatchFix: () => { counts.dispatched++; },
  escalate: () => { counts.escalated++; }, runId: "memory-held", ledgerPath: "/unused", now: () => NOW,
  readLedger: () => rows, appendLine: (_path, row) => { rows.push({ ts: at(NOW), ...row }); }, ...extra });

function fixtureProductionProbe(t: TestContext, availableMib: () => number) {
  const root = mkdtempSync(join(tmpdir(), "rmd-memory-admission-"));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  t.mock.method(os, "homedir", () => root);
  t.mock.property(process, "env", { ...process.env, [TEST_SLOT_DIR_ENV]: join(root, "slots"), [TEST_SLOT_PARENT_ENV]: "" });
  const readFileSync = fs.readFileSync;
  t.mock.method(fs, "readFileSync", ((path: fs.PathOrFileDescriptor, options?: unknown) => {
    if (path === "/proc/meminfo") return `MemTotal: 131072000 kB\nMemAvailable: ${availableMib() * 1024} kB\n`;
    if (path === "/sys/fs/cgroup/memory.current") return "0";
    if (path === "/sys/fs/cgroup/memory.max" || path === "/sys/fs/cgroup/memory.high") return "max";
    return readFileSync(path, options as BufferEncoding);
  }) as typeof fs.readFileSync);
  syncBuiltinESMExports();
  const priorReclaimer = installedDaemonSlackReclaimer();
  installDaemonSlackReclaimer(undefined);
  t.after(() => {
    installDaemonSlackReclaimer(priorReclaimer);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  });
  const effects = buildSweepEffects({ owner: "acme", repo: "scratch", config: { root } as BuildSweepEffectsDeps["config"],
    ledgerPath, runId: "memory-probe", plan: { tasks: [], byId: new Map() }, ciGateRequired: [], log: () => {} });
  return { root, ledgerPath, fixDispatchCauseProbe: effects.fixDispatchCauseProbe };
}

function fixtureFullSweep(t: TestContext, availableMib: () => number) {
  const rows = seed();
  const counts = { dispatched: 0, escalated: 0 };
  const { ledgerPath, fixDispatchCauseProbe } = fixtureProductionProbe(t, availableMib);
  const capacity: Record<string, unknown>[] = [];
  const dispatchedHeads: string[] = [];
  const deps = withFullSweepRepairAdmission(sweepDeps(rows, counts, { ledgerPath, fixDispatchCauseProbe,
    fixProgressJudge: async () => ({ verdict: "continue", reason: "retry when room opens" }),
    log: (step, fields) => { if (step === "sweep.fix_capacity" && fields) capacity.push(fields); },
    dispatchFix: (candidate) => { dispatchedHeads.push(candidate.headSha); },
  }));
  const run = async (now: number) => {
    capacity.length = 0;
    await runSweep([pr], { ...deps, runId: `memory-pass-${now}`, now: () => now });
    const disposed = rows.findLast(row => row.step === "sweep.disposed" && row.run_id === `memory-pass-${now}`);
    assert.ok(disposed, "this full pass wrote a disposition");
    assert.equal(disposed.head_sha, pr.headSha);
    return disposed;
  };
  return { run, capacity, dispatchedHeads };
}

test("W1-T13869 criterion 1: a memory-held fix dispatch runs again at the same head on the first pass whose admission has room", async (t) => {
  const floor = DEFAULT_SWEEP_POLICY.memoryFloorMib;
  let available = floor - 1;
  const { run, capacity, dispatchedHeads } = fixtureFullSweep(t, () => available);
  const held = await run(NOW);
  assert.deepEqual(dispatchedHeads, []);
  assert.equal(capacity[0]?.fix_admissions_available, 0, "the first full pass still refuses one fix");
  assert.equal(held.probe_result, "present");
  assert.match(String(held.cause), /^fix dispatch refused: worker admission refused \(live host capacity exhausted/);
  const learnedRetry = Date.parse(String(held.failure_at)) + Number(held.backoff_ms);
  assert.equal(held.backoff_ms, 2 * 40 * 60_000, "the learned backoff is unchanged");
  available = floor + 64_000;
  const later = NOW + PASS_MS;
  assert.ok(later < learnedRetry, "the next pass comes before the learned next retry");
  const retried = await run(later);
  assert.ok(Number(capacity[0]?.fix_admissions_available) >= 1, "the first full pass after memory frees has room");
  assert.equal(retried.probe_result, undefined, "the production probe cleared the memory hold");
  assert.ok(capacity.some(row => row.fixes_admitted === 1), "dispatch still takes an admission claim");
  assert.deepEqual(dispatchedHeads, [pr.headSha], "dispatches again at the same head, with no new push");
});

test("W1-T13869 criterion 2: while the admission still refuses, the hold names probe present and a retry one pass away", async (t) => {
  const floor = DEFAULT_SWEEP_POLICY.memoryFloorMib;
  let reads = 0;
  let transientCapacity = false;
  const { run, capacity, dispatchedHeads } = fixtureFullSweep(t, () =>
    transientCapacity && ++reads === 2 ? floor + 64_000 : floor - 1);
  for (const now of [NOW, NOW + PASS_MS, NOW + 2 * PASS_MS]) {
    const held = await run(now);
    assert.equal(held.probe_result, "present");
    assert.equal(held.next_retry_at, at(now + PASS_MS), "one sweep cadence after the pass");
    assert.notEqual(held.next_retry_at, at(Date.parse(String(held.failure_at)) + Number(held.backoff_ms)));
    assert.equal(held.backoff_ms, 2 * 40 * 60_000);
    if (transientCapacity) {
      assert.ok(Number(capacity[0]?.fix_admissions_available) >= 1, "the later capacity snapshot briefly saw room");
    } else {
      assert.equal(capacity[0]?.fix_admissions_available, 0);
    }
    assert.ok(capacity.every(row => row.fixes_admitted === 0 && row.fixes_refused === 0), "a present probe retains the hold without claiming");
    transientCapacity = true;
    reads = 0;
  }
  assert.deepEqual(dispatchedHeads, []);
  const standIn = await fixDispatchHoldAtHeadAsync(pr, [failure(NOW, STAND_IN)], () => true, undefined,
    { nowMs: NOW, sweepPassMs: PASS_MS, causeProbe: async () => "present" });
  assert.equal(standIn?.fields.probe_result, "present", "the stand-in worker budget refusal is a memory cause too");
  assert.equal(standIn?.fields.next_retry_at, at(NOW + PASS_MS));
});

test("W1-T13869 criterion 3: the probe answers clear exactly when the run child's claim admits, and claims nothing", () => {
  const child = (r: Readers) => createSweepFixAdmissionController({ surface: "full", queueDepth: 1,
    hostWorkerBudget: r.hostWorkerBudget, activeWorkers: r.readActiveWorkers(), readActiveWorkers: r.readActiveWorkers,
    reviewReservations: 0, readPressure: r.readPressure, readEstimate: r.readEstimate, readTypical: r.readTypical,
    readResidents: r.readResidents }).claim(pr).admitted;
  const tiers: FixHostPressure["tier"][] = ["fits", "host-short", "container-short", "nothing-to-wait-for"];
  const trees: FixAdmissionResidents[] = [undefined, { fix: [], review: [] }, { fix: [1500], review: [] }, { fix: [], review: [900] }];
  let clear = 0;
  let present = 0;
  for (const headroom of [0, 1000, 1754, 2000, 6257, 6258, 9204, 13000])
    for (const tier of tiers)
      for (const residents of trees)
        for (const active of [0, 8])
          for (const reason of [undefined, "memory reading unreadable"]) {
            const r = readers(headroom, { readActiveWorkers: () => active, readResidents: () => residents,
              readPressure: () => ({ availableMib: FLOOR + headroom, floorMib: FLOOR, binding: "host", tier,
                ...(reason === undefined ? {} : { reason }) }) });
            const answer = fixAdmissionCauseProbe(r);
            assert.equal(answer, child(r) ? "clear" : "present", JSON.stringify({ headroom, tier, residents, active, reason }));
            if (answer === "clear") clear++;
            else present++;
          }
  assert.ok(clear > 0 && present > 0, "the grid holds both answers");
  const oneFix = readers(6258);
  for (let i = 0; i < 3; i++) assert.equal(fixAdmissionCauseProbe(oneFix), "clear");
  const controller = createSweepFixAdmissionController({ surface: "full", queueDepth: 1, hostWorkerBudget: 4,
    activeWorkers: 8, readActiveWorkers: oneFix.readActiveWorkers, reviewReservations: 0, readPressure: oneFix.readPressure,
    readEstimate: oneFix.readEstimate, readTypical: oneFix.readTypical, readResidents: oneFix.readResidents });
  assert.equal(controller.claim(pr).admitted, true, "the probes reserved nothing: the one fix the headroom holds is still free");
  assert.equal(fixAdmissionCauseProbe(readers(9204, { readPressure: () => { throw new Error("vm_stat failed"); } })), "present",
    "an unreadable pressure reading is present");
});

test("W1-T13869 criterion 3: the production probe reads live workers in a fresh state root without loading config", async (t) => {
  const policy = DEFAULT_SWEEP_POLICY;
  let available = policy.memoryFloorMib + 1;
  const { root, ledgerPath, fixDispatchCauseProbe } = fixtureProductionProbe(t, () => available);
  const stateDir = dirname(ledgerPath);
  const runId = "live-fix-worker";
  const identity = childIdentity(process.pid);
  assert.ok(identity, "the test process has a live identity for the worker census");
  writeStatus(runDir(stateDir, runId), { schema: RUN_CHILD_SCHEMA, runId, identity, engineSha: "fixture",
    entryKind: "tsx", phase: "worker", heartbeatAt: NOW, state: "running" });
  assert.equal(activeWorkerCount(stateDir), 1, "the instance has one live worker");

  const configDir = dirname(configPath());
  const mkdirSync = fs.mkdirSync;
  const mkdir = t.mock.method(fs, "mkdirSync", ((path: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
    assert.notEqual(path, configDir, "the probe must not enter loadConfig");
    return mkdirSync(path, options);
  }) as typeof fs.mkdirSync);
  syncBuiltinESMExports();
  const filesBefore = fs.readdirSync(root, { recursive: true }).sort();
  const demandBefore = repairMemoryDemandMark();
  const cause = "fix dispatch refused: worker admission refused (live host capacity exhausted";
  const needed = policy.memoryFloorMib + classEstimate("fix").estimateMib;
  const short = await fixDispatchCauseProbe!(cause);
  available = needed;
  const clear = await fixDispatchCauseProbe!(cause);
  const repeated = await fixDispatchCauseProbe!(cause);
  assert.equal(mkdir.mock.callCount(), 0, "the probes created no directory, including the missing config directory");
  assert.deepEqual(fs.readdirSync(root, { recursive: true }).sort(), filesBefore, "the probes created no files or reservations");
  assert.equal(repairMemoryDemandMark(), demandBefore, "the probes did not register a refused claim");
  assert.equal(short, "present", "one MiB and a live worker do not admit a fix");
  assert.equal(clear, "clear", "the exact learned estimate now fits");
  assert.equal(repeated, clear, "a second probe sees the same room");

  const claim = () => createSweepFixAdmissionController({ surface: "full", queueDepth: 1,
    hostWorkerBudget: policy.reviewCapacity.hostWorkerBudget, activeWorkers: activeWorkerCount(stateDir),
    readActiveWorkers: () => activeWorkerCount(stateDir), reviewReservations: 0,
    readPressure: () => productionFixPressure(policy.memoryFloorMib, ledgerPath, classEstimate("fix").estimateMib),
    readEstimate: classEstimate, readTypical: classTypical, readResidents: () => productionFixAdmissionResidents(root),
  }).claim(pr);
  available = policy.memoryFloorMib + 1;
  assert.equal(claim().admitted, false, "the same short production reading refuses a claim");
  available = needed;
  const admitted = claim();
  assert.equal(admitted.admitted, true, "probing left the one admissible fix free to claim");
  if (admitted.admitted) admitted.release?.();
});

test("W1-T13869 criterion 3: the production probe leaves reclaim to ordinary admission", async (t) => {
  const floor = DEFAULT_SWEEP_POLICY.memoryFloorMib;
  let collections = 0;
  const { fixDispatchCauseProbe, ledgerPath } = fixtureProductionProbe(t, () => collections === 0 ? floor - 1 : floor + 64_000);
  const cause = "fix dispatch refused: worker admission refused (live host capacity exhausted";
  installDaemonSlackReclaimer(createDaemonSlackReclaimer({ collect: () => { collections++; }, setFlags: () => {},
    snapshot: () => ({ rss_bytes: 1, swap_bytes: 0, heap_used_bytes: 1, heap_physical_bytes: 1,
      external_bytes: 0, heap_size_limit_bytes: 100 }),
  }));
  const demandMark = repairMemoryDemandMark();
  assert.equal(await fixDispatchCauseProbe!(cause), "present");
  assert.equal(collections, 0, "probing a short reading does not collect");
  assert.equal(repairMemoryDemandMark(), demandMark, "probing a short reading does not record a refused claim");
  assert.equal(productionFixPressure(floor, ledgerPath).reclaim?.outcome, "reclaimed");
  assert.equal(collections, 1, "ordinary admission pressure can still reclaim");
  assert.equal(await fixDispatchCauseProbe!(cause), "clear", "the probe observes the subsequent relief");
  assert.equal(collections, 1);
});

test("W1-T13869 criterion 4: a memory refusal is never escalated", async () => {
  const rows = seed();
  for (let i = 1; i <= 3; i++) rows.push(failure(NOW - 30_000 + i * 1000));
  const counts = { dispatched: 0, escalated: 0 };
  let judged = 0;
  const judge: FixProgressJudge = async () => { judged++; return { verdict: "escalate", loop: "memory", reason: "same refusal" }; };
  const extra: Partial<SweepDeps> = { fixProgressJudge: judge,
    readFixPressure: () => ({ availableMib: 64_000, floorMib: FLOOR, tier: "fits" }) };
  for (let i = 0; i < 3; i++) {
    await runSweep([pr], sweepDeps(rows, counts, { ...extra, runId: `escalate-${i}`, now: () => NOW + i * PASS_MS,
      fixDispatchCauseProbe: probeOn(() => 6149) }));
    const hold = rows.findLast(row => row.step === "sweep.disposed")!;
    assert.equal(hold.judge_verdict, "escalate");
    assert.equal(hold.probe_result, "present");
    assert.ok(!("dispatch_cause_escalated" in hold));
    assert.ok(!("fix_dispatch_failed_escalated" in hold));
    if (i === 0) rows.splice(rows.indexOf(hold), 0, { ...pass(NOW - 1), dispatch_cause_escalated: hold.dispatch_cause_key });
  }
  assert.ok(judged >= 1, "the judge is still read for its reason");
  assert.equal(counts.escalated, 0, "no escalation is filed");
  assert.equal(counts.dispatched, 0);
  const unprobed = seed();
  const unprobedCounts = { dispatched: 0, escalated: 0 };
  const late = NOW + 3 * 3_600_000;
  await runSweep([pr], sweepDeps(unprobed, unprobedCounts, { ...extra, runId: "no-probe", now: () => late }));
  assert.equal(unprobedCounts.escalated, 0);
  assert.equal(unprobedCounts.dispatched, 1, "without a probe, an escalate verdict does not hold a memory cause past its backoff");
});

test("W1-T13869 criterion 5: other causes keep today's probe and backoff", async () => {
  const probed: string[] = [];
  const spy: NonNullable<SweepDeps["fixDispatchCauseProbe"]> = async (cause) => { probed.push(cause); return "present"; };
  const opts = { nowMs: NOW, sweepPassMs: PASS_MS, causeProbe: spy };
  const catalog = await fixDispatchHoldAtHeadAsync(pr, [failure(NOW, "task catalog unreadable: ops-ref_moved")], () => true, undefined, opts);
  assert.deepEqual(probed, ["task catalog unreadable: ops-ref_moved"]);
  assert.equal(catalog?.fields.probe_result, "present");
  for (const error of ["fix dispatch refused: the PR head moved from 0a66a11 to 9f8e7d6", "fix dispatch refused: task W1-T12206 is already merged"]) {
    probed.length = 0;
    const held = await fixDispatchHoldAtHeadAsync(pr, [failure(NOW, error)], () => true, undefined, opts);
    assert.equal(probed.length, 0, `${error} is not probed`);
    assert.equal(held?.fields.probe_result, "unprobed");
    const retryAt = Date.parse(String(held?.fields.failure_at)) + Number(held?.fields.backoff_ms);
    assert.equal(held?.fields.next_retry_at, at(retryAt), "retried on the learned backoff");
    assert.equal(await fixDispatchHoldAtHeadAsync(pr, [failure(NOW, error)], () => true, undefined, { ...opts, nowMs: retryAt }), undefined);
    assert.equal(fixDispatchMemoryCause(String(held?.fields.cause)), false);
  }
  const root = mkdtempSync(join(tmpdir(), "rmd-memory-cause-"));
  try {
    writeFileSync(join(root, "ledger.ndjson"), "");
    const effects = buildSweepEffects({ owner: "acme", repo: "scratch", config: { root }, ledgerPath: join(root, "ledger.ndjson"),
      runId: "catalog-probe", plan: { tasks: [], byId: new Map() }, log: () => {} } as never);
    assert.equal(await effects.fixDispatchCauseProbe!("task catalog unreadable: ops-ref_moved"), "clear",
      "the ops catalog read still answers a catalog cause");
    assert.equal(await effects.fixDispatchCauseProbe!("fix dispatch refused: the PR head moved from <sha> to <sha>"), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T13869 criterion 6: the production sweep deps answer a memory cause with the fix admission probe", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-memory-probe-"));
  try {
    const ledgerPath = join(root, "ledger.ndjson");
    writeFileSync(ledgerPath, "");
    const effects = buildSweepEffects({ owner: "acme", repo: "scratch", config: { root }, ledgerPath,
      runId: "memory-probe", plan: { tasks: [], byId: new Map() }, log: () => {} } as never);
    const answers: Array<string | undefined> = [];
    const rows = seed();
    const counts = { dispatched: 0, escalated: 0 };
    await runSweep([pr], sweepDeps(rows, counts, { ledgerPath, fixDispatchCauseProbe: async (cause) => {
      const answer = await effects.fixDispatchCauseProbe!(cause);
      answers.push(answer);
      return answer;
    } }));
    assert.ok(answers.length >= 1, "the memory cause is probed");
    assert.ok(answers.every(answer => answer === "clear" || answer === "present"), `the live admission answered ${answers.join(", ")}`);
    if (answers.at(-1) === "clear") assert.equal(counts.dispatched, 1, "a clear reading lifts the hold at once");
    else {
      assert.equal(counts.dispatched, 0);
      assert.equal(rows.findLast(row => row.step === "sweep.disposed")?.probe_result, "present");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
