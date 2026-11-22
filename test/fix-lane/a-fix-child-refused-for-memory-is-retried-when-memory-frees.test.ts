import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os, { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import * as sweep from "#src/lib/sweep.js";
import type { BuildSweepEffectsDeps, FixAdmissionRung, OpenPrView, SweepDeps } from "#src/lib/sweep.js";
import { configPath } from "#src/lib/config.js";
import { createDaemonSlackReclaimer, installDaemonSlackReclaimer, installedDaemonSlackReclaimer } from "#src/lib/daemon-memory-policy.js";
import type { FixProgressJudge } from "#src/lib/fix-progress-judge.js";
import { classEstimate, classTypical, recordPeak, resetLearnedEstimateCacheForTests } from "#src/lib/host-memory-learning.js";
import { openMemoryReservation, readMemoryLedger } from "#src/lib/host-memory-ledger.js";
import { ledgerPathFor } from "#src/lib/ledger-path.js";
import { clearRepairMemoryDemand, freshRepairMemoryDemand, repairMemoryDemandMark } from "#src/lib/repair-memory-demand.js";
import { childIdentity, runDir, RUN_CHILD_SCHEMA, writeStatus } from "#src/lib/run-child-contract.js";
import { TEST_SLOT_DIR_ENV, TEST_SLOT_PARENT_ENV } from "#src/lib/test-slot.js";
import { activeWorkerCount } from "#src/lib/worker.js";

const { buildSweepEffects, createSweepFixAdmissionController, DEFAULT_SWEEP_POLICY,
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
const HOST_FLOOR = DEFAULT_SWEEP_POLICY.memoryFloorMib;
const sweepDeps = (rows: Record<string, unknown>[], counts: { dispatched: number; escalated: number },
  extra: Partial<SweepDeps> = {}): SweepDeps => ({
  arm: () => {}, close: () => {}, dispatchFix: () => { counts.dispatched++; },
  escalate: () => { counts.escalated++; }, runId: "memory-held", ledgerPath: "/unused", now: () => NOW,
  readLedger: () => rows, appendLine: (_path, row) => { rows.push({ ts: at(extra.now?.() ?? NOW), ...row }); }, ...extra });

function fixtureProductionProbe(t: TestContext, availableMib: () => number | undefined) {
  const root = mkdtempSync(join(tmpdir(), "rmd-memory-admission-"));
  const ledgerPath = ledgerPathFor({ root });
  const stateDir = dirname(ledgerPath);
  const home = join(root, "unconfigured-home");
  const priorSlotDir = process.env[TEST_SLOT_DIR_ENV];
  const priorSlotParent = process.env[TEST_SLOT_PARENT_ENV];
  process.env[TEST_SLOT_DIR_ENV] = join(root, "test-slots");
  delete process.env[TEST_SLOT_PARENT_ENV];
  resetLearnedEstimateCacheForTests();
  const readFileSync = fs.readFileSync;
  t.mock.method(os, "homedir", () => home);
  t.mock.method(fs, "readFileSync", ((path: fs.PathOrFileDescriptor, options?: unknown) => {
    if (path === "/proc/meminfo") {
      const available = availableMib();
      return available === undefined ? "MemAvailable unreadable\n"
        : `MemTotal: 131072000 kB\nMemAvailable: ${available * 1024} kB\n`;
    }
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
    if (priorSlotDir === undefined) delete process.env[TEST_SLOT_DIR_ENV];
    else process.env[TEST_SLOT_DIR_ENV] = priorSlotDir;
    if (priorSlotParent === undefined) delete process.env[TEST_SLOT_PARENT_ENV];
    else process.env[TEST_SLOT_PARENT_ENV] = priorSlotParent;
    resetLearnedEstimateCacheForTests();
    clearRepairMemoryDemand(pr.prNumber);
    rmSync(root, { recursive: true, force: true });
  });
  const effects = buildSweepEffects({ owner: "acme", repo: "scratch", config: { root } as BuildSweepEffectsDeps["config"],
    ledgerPath, runId: "memory-probe", plan: { tasks: [], byId: new Map() }, ciGateRequired: [], log: () => {} });
  const identity = childIdentity(process.pid);
  assert.ok(identity);
  const runId = "existing-worker";
  const dir = runDir(stateDir, runId);
  mkdirSync(dir, { recursive: true });
  const setWorkerState = (state: "running" | "done") => writeStatus(dir, {
    schema: RUN_CHILD_SCHEMA, runId, identity, engineSha: "fixture", entryKind: "tsx", phase: "fix",
    heartbeatAt: NOW, state,
  });
  setWorkerState("running");
  return { root, ledgerPath, stateDir, home, setWorkerState, fixDispatchCauseProbe: effects.fixDispatchCauseProbe };
}

async function runProductionPass(fixture: ReturnType<typeof fixtureProductionProbe>, rows: Record<string, unknown>[], now: number,
  effects: Partial<Pick<SweepDeps, "fixProgressJudge" | "escalate">> = {}) {
  const runId = `memory-pass-${now}`;
  const dispatchedHeads: string[] = [];
  await runSweep([{ ...pr }], withFullSweepRepairAdmission(sweepDeps(rows, { dispatched: 0, escalated: 0 }, {
    ledgerPath: fixture.ledgerPath, fixDispatchCauseProbe: fixture.fixDispatchCauseProbe, runId, now: () => now,
    fixProgressJudge: async () => ({ verdict: "continue", reason: "retry when room opens" }),
    log: (step, fields) => {
      if (step === "sweep.fix_capacity") rows.push({ ...fields, step, run_id: runId, ts: at(now) });
    },
    dispatchFix: (candidate) => { dispatchedHeads.push(candidate.headSha); },
    ...effects,
  })));
  const disposed = rows.findLast(row => row.step === "sweep.disposed" && row.run_id === runId && row.pr_number === pr.prNumber);
  assert.ok(disposed, "the full pass wrote a disposition for this PR");
  assert.equal(disposed.head_sha, pr.headSha);
  const capacity = rows.filter(row => row.step === "sweep.fix_capacity" && row.run_id === runId);
  assert.equal(capacity[0]?.surface, "full");
  assert.equal(capacity[0]?.active_workers, 1, "admission counts the live run child in the sweep state directory");
  assert.equal(capacity[0]?.review_reservations, 0);
  return { disposed, capacity, dispatchedHeads };
}

test("W1-T13869 criterion 1: a memory-held fix dispatch runs again at the same head on the first pass whose admission has room", async (t) => {
  const rows = seed();
  let available = HOST_FLOOR - 1;
  const fixture = fixtureProductionProbe(t, () => available);
  const short = await runProductionPass(fixture, rows, NOW);
  assert.equal(short.capacity[0]?.fix_admissions_available, 0);
  assert.equal(short.disposed.acted, false);
  assert.deepEqual(short.dispatchedHeads, []);
  assert.equal(short.disposed.backoff_ms, 2 * 40 * 60_000, "the learned backoff is unchanged");

  available = HOST_FLOOR + 64_000;
  const retry = await runProductionPass(fixture, rows, NOW + PASS_MS);
  const learnedRetry = Date.parse(String(short.disposed.failure_at)) + Number(short.disposed.backoff_ms);
  assert.ok(Date.parse(String(retry.disposed.ts)) < learnedRetry, "the retry precedes the learned backoff deadline");
  assert.ok(Number(retry.capacity[0]?.fix_admissions_available) >= 1);
  assert.ok(retry.capacity.some(row => row.fixes_admitted === 1), "dispatch still takes an admission claim");
  assert.equal(retry.disposed.acted, true);
  assert.equal(retry.disposed.dispatch_held, undefined);
  assert.deepEqual(retry.dispatchedHeads, [pr.headSha], "dispatches again at the same head, with no new push");
});

test("W1-T13869 criterion 1: ordinary full-pass reclaim releases the memory hold on that pass", async (t) => {
  const rows = seed();
  let collections = 0;
  const fixture = fixtureProductionProbe(t, () => collections > 0 ? HOST_FLOOR + 64_000 : HOST_FLOOR - 1);
  const short = await runProductionPass(fixture, rows, NOW);
  assert.equal(short.disposed.probe_result, "present");
  assert.deepEqual(short.dispatchedHeads, []);
  installDaemonSlackReclaimer(createDaemonSlackReclaimer({ collect: () => { collections++; }, setFlags: () => {},
    snapshot: () => ({ rss_bytes: 1, swap_bytes: 0, heap_used_bytes: 1, heap_physical_bytes: 1,
      external_bytes: 0, heap_size_limit_bytes: 100 }),
  }));

  const retry = await runProductionPass(fixture, rows, NOW + PASS_MS);
  assert.equal(collections, 1, "ordinary admission reclaimed before the dispatch claim");
  assert.ok(Number(retry.capacity[0]?.fix_admissions_available) >= 1);
  assert.ok(Date.parse(String(retry.disposed.ts)) < Date.parse(String(short.disposed.failure_at)) + Number(short.disposed.backoff_ms));
  assert.ok(retry.capacity.some(row => row.fixes_admitted === 1), "dispatch still claims capacity");
  assert.equal(retry.disposed.acted, true);
  assert.equal(retry.disposed.dispatch_held, undefined);
  assert.deepEqual(retry.dispatchedHeads, [pr.headSha]);
});

test("W1-T13869 criterion 1: the dispatch claim rechecks capacity after the full pass clears a memory hold", async (t) => {
  let readings = 0;
  const fixture = fixtureProductionProbe(t, () => ++readings === 2 ? HOST_FLOOR + 64_000 : HOST_FLOOR - 1);
  const { disposed, capacity, dispatchedHeads } = await runProductionPass(fixture, seed(), NOW);
  assert.ok(Number(capacity[0]?.fix_admissions_available) >= 1, "the full pass reads room after the first probe");
  const refusal = capacity.find(row => row.fixes_refused === 1);
  assert.equal(refusal?.fix_admissions_available, 0, "the claim rereads pressure and refuses when the room disappears");
  assert.equal(disposed.acted, false);
  assert.equal(disposed.dispatch_held, undefined, "the old failure hold was cleared");
  assert.deepEqual(dispatchedHeads, []);
});

test("W1-T13869 criterion 2: while the admission still refuses, the hold names probe present and a retry one pass away", async (t) => {
  const rows = seed();
  const fixture = fixtureProductionProbe(t, () => HOST_FLOOR - 1);
  for (const now of [NOW, NOW + PASS_MS, NOW + 2 * PASS_MS]) {
    const { disposed, capacity, dispatchedHeads } = await runProductionPass(fixture, rows, now);
    assert.equal(capacity[0]?.fix_admissions_available, 0);
    assert.match(String(disposed.cause), /^fix dispatch refused: worker admission refused \(live host capacity exhausted/);
    assert.equal(disposed.probe_result, "present");
    assert.equal(disposed.next_retry_at, at(now + PASS_MS), "one sweep cadence after the pass");
    assert.equal(disposed.backoff_ms, 2 * 40 * 60_000);
    assert.notEqual(disposed.next_retry_at, at(Date.parse(String(disposed.failure_at)) + Number(disposed.backoff_ms)));
    assert.equal(capacity.length, 1, "the present probe keeps the hold before any dispatch claim");
    assert.equal(disposed.acted, false);
    assert.deepEqual(dispatchedHeads, []);
  }

  const standIn = await fixDispatchHoldAtHeadAsync(pr, [failure(NOW, STAND_IN)], () => true, undefined,
    { nowMs: NOW, sweepPassMs: PASS_MS, causeProbe: async () => "present" });
  assert.equal(standIn?.fields.probe_result, "present", "the stand-in worker budget refusal is a memory cause too");
  assert.equal(standIn?.fields.next_retry_at, at(NOW + PASS_MS));
});

test("W1-T13869 criterion 3: the production probe matches a child admission claim without claiming or creating config", async (t) => {
  let available: number | undefined;
  const { root, stateDir, home, ledgerPath, setWorkerState, fixDispatchCauseProbe } = fixtureProductionProbe(t, () => available);
  const cause = "fix dispatch refused: worker admission refused (live host capacity exhausted";
  const path = configPath();
  assert.ok(path.startsWith(`${home}/`));
  assert.equal(existsSync(home), false);
  const realMkdir = fs.mkdirSync;
  let configCreationAttempts = 0;
  t.mock.method(fs, "mkdirSync", ((pathArg: fs.PathLike, options?: fs.Mode | fs.MakeDirectoryOptions | null) => {
    if (pathArg === dirname(path)) {
      configCreationAttempts++;
      throw new Error("probe attempted config bootstrap");
    }
    return realMkdir(pathArg, options as fs.MakeDirectoryOptions);
  }) as typeof fs.mkdirSync);
  syncBuiltinESMExports();

  for (const peak of [1600, 1600, 1600, 1600, 1600, 1600, 6400, 6400, 6400]) {
    assert.equal(recordPeak("fix", peak, { root }), true);
  }
  assert.deepEqual(classEstimate("fix"), { estimateMib: 6400, samples: 9, basis: "legacy-hwm-fallback" });
  assert.deepEqual(classTypical("fix"), { estimateMib: 1600, samples: 9 });

  async function compare(headroom: number | undefined, rung: FixAdmissionRung | undefined, activeWorkers: number, admitted: boolean) {
    available = headroom === undefined ? undefined : HOST_FLOOR + headroom;
    const countWorkers = () => activeWorkerCount(stateDir);
    const child = createSweepFixAdmissionController({
      surface: "full", queueDepth: 1, hostWorkerBudget: DEFAULT_SWEEP_POLICY.reviewCapacity.hostWorkerBudget,
      activeWorkers: countWorkers(), readActiveWorkers: countWorkers, reviewReservations: 0,
      readPressure: () => productionFixPressure(HOST_FLOOR, ledgerPath, classEstimate("fix").estimateMib),
      readEstimate: classEstimate, readTypical: classTypical, readResidents: () => productionFixAdmissionResidents(root),
    });
    assert.equal(child.snapshot().activeWorkers, activeWorkers);
    assert.equal(child.snapshot().charge?.admissionRung, rung);
    const before = readMemoryLedger({ root })!.entries.map(entry => [entry.path, fs.readFileSync(entry.path, "utf8")]);
    const demandMark = repairMemoryDemandMark();
    const demand = freshRepairMemoryDemand(Date.now());
    const first = await fixDispatchCauseProbe!(cause);
    assert.equal(await fixDispatchCauseProbe!(cause), first, "a second probe sees the same capacity");
    assert.equal(configCreationAttempts, 0, "the worker census does not enter config bootstrap");
    assert.equal(existsSync(home), false, "no config directory was created");
    assert.equal(repairMemoryDemandMark(), demandMark, "the probe recorded no refusal");
    assert.deepEqual(freshRepairMemoryDemand(Date.now()), demand, "the probe cleared no demand");
    const after = readMemoryLedger({ root })!.entries.map(entry => [entry.path, fs.readFileSync(entry.path, "utf8")]);
    assert.deepEqual(after, before, "the probe changed no reservation");
    const grant = child.claim(pr);
    assert.equal(grant.admitted, admitted);
    assert.equal(first, grant.admitted ? "clear" : "present");
    if (grant.admitted) grant.release?.();
  }

  await compare(undefined, undefined, 1, false);
  await compare(1599, "none", 1, false);
  setWorkerState("done");
  await compare(1599, "nothing-live", 0, true);
  await compare(1600, "typical", 0, true);

  setWorkerState("running");
  const reservation = openMemoryReservation({ root, workerClass: "fix" });
  try {
    assert.equal(reservation.published, true);
    reservation.bindRoot(process.pid);
    assert.equal(productionFixAdmissionResidents(root)?.fix.length, 1);
    await compare(6399, "none", 1, false);
    await compare(6400, "fits", 1, true);
  } finally {
    reservation.releaseOccupancy();
  }
  const runs = join(stateDir, "runs");
  rmSync(runs, { recursive: true });
  writeFileSync(runs, "unreadable worker census");
  assert.equal(await fixDispatchCauseProbe!(cause), "present", "an unreadable worker census keeps the hold");
  assert.equal(configCreationAttempts, 0);
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

test("W1-T13869 criterion 4: a memory refusal is never escalated", async (t) => {
  const fixture = fixtureProductionProbe(t, () => HOST_FLOOR - 1);
  const rows = seed();
  for (let i = 1; i <= 3; i++) rows.push(failure(NOW - 30_000 + i * 1000));
  let escalated = 0;
  let judged = 0;
  const judge: FixProgressJudge = async () => { judged++; return { verdict: "escalate", loop: "memory", reason: "same refusal" }; };
  const extra: Partial<SweepDeps> = { fixProgressJudge: judge,
    readFixPressure: () => ({ availableMib: 64_000, floorMib: FLOOR, tier: "fits" }) };
  for (let i = 0; i < 3; i++) {
    const { disposed: hold, dispatchedHeads } = await runProductionPass(fixture, rows, NOW + i * PASS_MS,
      { fixProgressJudge: judge, escalate: () => { escalated++; } });
    assert.equal(hold.judge_verdict, "escalate");
    assert.equal(hold.probe_result, "present");
    assert.ok(!("dispatch_cause_escalated" in hold));
    assert.ok(!("fix_dispatch_failed_escalated" in hold));
    assert.deepEqual(dispatchedHeads, []);
    if (i === 0) rows.splice(rows.indexOf(hold), 0, { ...pass(NOW - 1), dispatch_cause_escalated: hold.dispatch_cause_key });
  }
  assert.ok(judged >= 1, "the judge is still read for its reason");
  assert.equal(escalated, 0, "no escalation is filed");
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
