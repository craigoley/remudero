import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { fixedClock } from "../src/lib/clock.js";
import { classEstimate, createTreePeakSampler, readPeakSamples, recordPeak, resetLearnedEstimateCacheForTests } from "../src/lib/host-memory-learning.js";
import {
  BACKTEST_WINDOW_MS, CALIBRATION_DAY_MS, JOINT_MODEL, calibrationReport, collectMemoryCalibration,
  calibrationStatePath, gradeMemoryForecast, jointMemoryClaim, kernelMemoryObservation, publishMemoryForecast, readCalibrationState,
  type CalibrationIo, type CalibrationState, type MemoryForecast,
} from "../src/lib/host-memory-calibration.js";
import { createDaemonFootprint, daemonFootprintPath } from "../src/lib/daemon-footprint.js";
import {
  CONTAINER_PRESSURE_FILE, SHADOW_STEP, evaluateShadowMemory, gatherShadowInputs, installShadowMemorySink, loadHostMemoryBudgetPolicy,
  parseHostMemoryBudgetPolicy, recordShadowMemoryVerdict, residentsOf, resetShadowMemoryStateForTests,
  type HostMemoryBudgetPolicy, type ShadowMemoryPorts,
} from "../src/lib/host-memory-shadow.js";
import { gitRepo } from "./helpers/git-repo.js";

const NOW = Date.parse("2026-10-15T00:00:00Z");
const forecast = (at = NOW): MemoryForecast => ({ id: "fixture", at, generation: "g1", scenario: "serve-steady",
  model: JOINT_MODEL, quantile: 0.95, projectedMib: 4400, initialMib: 1000, basis: "cgroup-current-mib" });
const observations = (at = NOW, peak = 3000) => Array.from({ length: 11 }, (_, i) => ({ at: at + i * 3 * 60_000, mib: peak, peakMib: peak, generation: "g1" }));

test("W1-T8879: legacy residents keep their shape while the real calibration gather explicitly requests RSS", () => {
  const policy = loadHostMemoryBudgetPolicy(new URL("../plan/policy.yaml", import.meta.url).pathname, fixedClock(NOW));
  const files: Record<string, string> = {
    "/ledger/outer.json": JSON.stringify({ roots: [{ pid: 10, start: "proc:100" }], tree: [{ pid: 12, start: "proc:120" }] }),
    "/ledger/inner.json": JSON.stringify({ roots: [{ pid: 12, start: "proc:120" }], tree: [] }),
    "/proc/10/stat": `10 (node) S 1 ${"0 ".repeat(17)}100 0 0`,
    "/proc/12/stat": `12 (node) S 1 ${"0 ".repeat(17)}120 0 0`,
    "/proc/10/status": "VmRSS: 102400 kB\nVmSwap: 51200 kB\n",
    "/proc/12/status": "VmRSS: 204800 kB\nVmSwap: 102400 kB\n",
  };
  const readFile = (path: string): string => {
    const text = files[path];
    if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return text;
  };
  const paths = ["/ledger/outer.json", "/ledger/inner.json"];
  assert.deepEqual(residentsOf(readFile, paths), [{ mib: 150, complete: true }, { mib: 300, complete: true }]);
  const expected = [{ mib: 150, complete: true, rssMib: 100 }, { mib: 300, complete: true, rssMib: 200 }];
  assert.deepEqual(residentsOf(readFile, paths, undefined, { includeRss: true }), expected,
    "swap is not concurrent RSS and a nested process still belongs to exactly one tree");
  const ports: ShadowMemoryPorts = {
    clock: fixedClock(NOW), nowNs: () => 0n, readFile, readTail: () => "",
    readLedger: () => ({ state: "present", scope: "host", dir: "/ledger", reservedMib: 1024,
      entries: paths.map((path, i) => ({ id: String(i), owner: "fixture@c1", workerClass: "implement" as const,
        estimateMib: 512, estimateSource: { kind: "default-unmeasured" as const }, status: "owned" as const,
        ageMs: 0, sinceVerifiedMs: 0, walkComplete: true, path })),
      counts: { live: 2, uncertain: 0, incompleteWalk: 0, localScope: 0, unreadable: 0 } }),
    policy: () => policy, write: undefined, stderr: () => undefined, instance: () => "fixture",
    daemonPid: () => undefined, listStateDir: () => [], estimate: () => 512, typical: () => 256,
    writeFile: () => undefined, readReviewDemand: () => { throw new Error("not a gather input"); },
    priorityPolicy: () => { throw new Error("not a gather input"); },
  };
  const start = { root: "/fixture/core", workerClass: "implement" as const, estimateMib: 512 };
  assert.deepEqual(gatherShadowInputs(start, ports, policy).entries.map(e => e.resident), expected,
    "the production gather opts in, not just the isolated reader test");
  assert.equal(evaluateShadowMemory(gatherShadowInputs(start, ports, policy), policy).numbers.reservationRssMib, 300,
    "the actual nested-tree gather supplies RSS attribution without counting a process twice or adding swap");
  files["/proc/12/status"] = "VmSwap: 102400 kB\n";
  assert.deepEqual(residentsOf(readFile, paths, undefined, { includeRss: true })[1], { mib: 100, complete: true },
    "a missing RSS reading stays missing, never measured zero");
});

test("W1-T8879: the memory budget claims a calibrated joint quantile", () => {
  const samples = Array.from({ length: 100 }, (_, i) => ({ workerClass: "implement" as const,
    peakMib: i % 5 === 0 ? 1200 : 400, at: NOW - i * 1000, measurementBasis: "concurrent-rss" as const }));
  const members = Array.from({ length: 5 }, () => ({ workerClass: "implement" as const, residentRssMib: 0, own: true }));
  const joint = jointMemoryClaim(members, samples, NOW);
  assert.equal(joint.kind, "joint");
  if (joint.kind !== "joint") throw new Error("fixture joint model unavailable");
  assert.equal(joint.hostMib, 4400, "not the6000MiB sum of class p90s and not an unqualified one-tail safety claim");
  assert.equal(joint.ownMib, 4400);
  assert.equal(jointMemoryClaim(members, samples.slice(0, 2), NOW).kind, "fallback");
  assert.equal(jointMemoryClaim(members, samples.map(s => ({ ...s, measurementBasis: "legacy-hwm" as const })), NOW).kind, "fallback");
  assert.equal(jointMemoryClaim(members, samples.map(s => ({ ...s, at: NOW + 1 })), NOW).kind, "fallback", "no training on future evidence");
  assert.equal(jointMemoryClaim(members, samples.map(s => ({ ...s, at: NOW - 2 * CALIBRATION_DAY_MS })), NOW).kind, "fallback");
  assert.equal(jointMemoryClaim(members, samples, NOW, 1).kind, "fallback");
  const zero = jointMemoryClaim(members.map(m => ({ ...m, released: true })), [], NOW);
  assert.equal(zero.kind === "joint" && zero.hostMib, 0, "released occupancy adds no future claim");
});

test("W1-T8879: the real config loader refuses unsupported joint enforcement and rechecks changing evidence", () => {
  const repo = gitRepo({ kind: "memory-calibration" });
  const stateDir = join(repo.dir, "state"); mkdirSync(join(stateDir, "memory-calibration"), { recursive: true });
  const now = NOW + 2 * CALIBRATION_DAY_MS;
  const state: CalibrationState = { version: 1, startedAt: NOW, coveredSince: NOW, lastAt: now, generation: "g1",
    observations: [{ at: now, mib: 1000, generation: "g1" }], issues: [],
    outcomes: Array.from({ length: 100 }, (_, i) => ({ ...forecast(now - BACKTEST_WINDOW_MS - i * 60_000), id: String(i),
      closedAt: now, windowPeakUpperBoundMib: i < 42 ? 6000 : 3000, complete: true, upperBoundExceedsForecast: i < 42 })) };
  const doc = parseYaml(readFileSync(new URL("../plan/policy.yaml", import.meta.url), "utf8"));
  const policy = doc.sweep.hostMemoryBudget;
  const legacyPath = join(repo.dir, "legacy.yaml");
  writeFileSync(legacyPath, stringifyYaml(doc));
  assert.equal(loadHostMemoryBudgetPolicy(legacyPath, fixedClock(now)).claimModel, undefined, "the existing garden-only legacy policy is unchanged");
  policy.mode.value = "enforce";
  const unsupported = join(repo.dir, "unsupported-global.yaml"); writeFileSync(unsupported, stringifyYaml(doc));
  assert.throws(() => loadHostMemoryBudgetPolicy(unsupported, fixedClock(now)), /enforce refused/, "global enforcement cannot bypass qualification by omitting the new model selection");
  policy.claimModel = { value: JOINT_MODEL, origin: "proposal" };
  policy.mode.value = "enforce";
  policy.calibrationStateDir = { value: stateDir, origin: "proposal" };
  const path = join(repo.dir, "joint.yaml"); writeFileSync(path, stringifyYaml(doc));
  const observe = (at: number) => ({ at, mib: 1000, peakMib: 3000, generation: "g1" });
  writeFileSync(calibrationStatePath(stateDir), JSON.stringify(state));
  assert.throws(() => loadHostMemoryBudgetPolicy(path, fixedClock(now), observe), /joint enforce refused/);
  state.outcomes = state.outcomes.map(o => ({ ...o, upperBoundExceedsForecast: false, windowPeakUpperBoundMib: 3000 }));
  writeFileSync(calibrationStatePath(stateDir), JSON.stringify(state));
  assert.equal(loadHostMemoryBudgetPolicy(path, fixedClock(now), observe).claimModel, JOINT_MODEL);
  assert.throws(() => loadHostMemoryBudgetPolicy(path, fixedClock(now), at => ({ ...observe(at), generation: "g2" })), /current generation/);
  assert.throws(() => loadHostMemoryBudgetPolicy(path, fixedClock(now + CALIBRATION_DAY_MS), observe), /joint enforce refused/, "qualification is not cached into permanent permission");
  writeFileSync(calibrationStatePath(stateDir), "{}");
  assert.throws(() => loadHostMemoryBudgetPolicy(path, fixedClock(now)), /invalid calibration state/);
  repo.cleanup();
});

test("W1-T8879: the existing heartbeat invokes the real bounded collector without a new timer", () => {
  const repo = gitRepo({ kind: "memory-heartbeat" }), stateDir = join(repo.dir, "state");
  mkdirSync(stateDir);
  const rows: Array<Record<string, unknown>> = [];
  installShadowMemorySink((_path, row) => { rows.push(row); });
  try {
    assert.deepEqual(createDaemonFootprint(daemonFootprintPath(stateDir)).record({ at: NOW, bytes: 1234, pid: 1 }), { persisted: true });
    assert.equal(readCalibrationState(stateDir).startedAt, NOW);
    assert.equal(rows.at(-1)?.step, "memory_budget.backtest");
    assert.equal(rows.at(-1)?.qualified, false);
    const a = kernelMemoryObservation(NOW, path => path.endsWith("memory.current") || path.endsWith("memory.peak") ? "1048576" : path.endsWith("/stat") ? `1 (init) S 0 ${"0 ".repeat(17)}5 0 0` : "fixture");
    const b = kernelMemoryObservation(NOW + 1, path => path.endsWith("memory.current") || path.endsWith("memory.peak") ? "2097152" : path.endsWith("/stat") ? `1 (init) S 0 ${"1 ".repeat(17)}5 0 0` : "fixture");
    assert.equal(a.mib, 1); assert.equal(b.mib, 2); assert.equal(a.generation, b.generation, "CPU counters do not change cgroup generation identity");
  } finally { installShadowMemorySink(undefined); repo.cleanup(); }
});

test("W1-T8879: missing qualification is distinct from an unsupported scenario and neither blocks ordinary shadow recording", () => {
  const inherited = loadHostMemoryBudgetPolicy(new URL("../plan/policy.yaml", import.meta.url).pathname, fixedClock(NOW));
  const policy: HostMemoryBudgetPolicy = { ...inherited, mode: "enforce", classModes: { implement: "enforce" }, claimModel: JOINT_MODEL };
  const ports: ShadowMemoryPorts = {
    clock: fixedClock(NOW), nowNs: () => 0n,
    readFile: () => { throw Object.assign(new Error("fixture has no input"), { code: "ENOENT" }); },
    readTail: () => "", readLedger: () => undefined, policy: () => policy, write: undefined,
    readReviewDemand: () => { throw new Error("not a gather input"); },
    priorityPolicy: () => { throw new Error("not a gather input"); },
    stderr: () => undefined, instance: () => "fixture", daemonPid: () => undefined,
    listStateDir: () => [], estimate: () => 1024, typical: () => 512, writeFile: () => undefined,
  };
  const start = { root: "/fixture/core", workerClass: "implement" as const, estimateMib: 1024 };
  assert.throws(() => gatherShadowInputs(start, ports, policy), /qualification evidence is missing/);
  assert.throws(() => gatherShadowInputs(start, ports, { ...policy,
    jointQualification: { generation: "fixture", scenarios: ["serve-steady"] } }), /current scenario is not qualified/);
  const shadow = gatherShadowInputs(start, ports, { ...policy, mode: "shadow", classModes: { implement: "shadow" } });
  assert.equal(shadow.serve.scenario, "unknown", "unknown input stays visible without turning a shadow read into an approval hold");
});

test("W1-T8879: frozen predictions grade later starts, correlated tails and incomplete windows honestly", () => {
  assert.equal(gradeMemoryForecast(forecast(), observations(), NOW + BACKTEST_WINDOW_MS - 1), undefined);
  const ordinary = gradeMemoryForecast(forecast(), observations(), NOW + BACKTEST_WINDOW_MS)!;
  assert.equal(ordinary.complete, true); assert.equal(ordinary.upperBoundExceedsForecast, false);
  const later = observations(); later[7]!.mib = 6000;
  for (const row of later.slice(7)) row.peakMib = 6000;
  const tail = gradeMemoryForecast(forecast(), later, NOW + BACKTEST_WINDOW_MS)!;
  assert.equal(tail.upperBoundExceedsForecast, true, "a later start or correlated peak is never censored from the outcome");
  const oldHighWater = observations().map(o => ({ ...o, peakMib: 10_000 }));
  const bounded = gradeMemoryForecast(forecast(), oldHighWater, NOW + BACKTEST_WINDOW_MS)!;
  assert.equal(bounded.complete, true);
  assert.equal(bounded.windowPeakUpperBoundMib, 10_000, "a historical peak is only an upper bound, not this window's measured peak");
  assert.equal(bounded.upperBoundExceedsForecast, true);
  const report = calibrationReport({ version: 1, startedAt: NOW - CALIBRATION_DAY_MS,
    coveredSince: NOW - CALIBRATION_DAY_MS, lastAt: NOW + BACKTEST_WINDOW_MS, generation: "g1",
    observations: oldHighWater, outcomes: [bounded], issues: [] }, NOW + BACKTEST_WINDOW_MS);
  assert.equal(report.rateKind, "conservative-upper-bound-exceedances-not-confirmed-window-misses");
  assert.equal(report.scenarios["serve-steady"]!.exceedanceRateUpperBound, 1);
  assert.equal(report.qualified, false, "historical high-water never masquerades as an accurately calibrated interval rate");
  assert.equal(gradeMemoryForecast(forecast(), observations().filter((_, i) => i !== 5), NOW + BACKTEST_WINDOW_MS)!.complete, false);
  assert.equal(gradeMemoryForecast(forecast(), observations().map((o, i) => i === 5 ? { ...o, generation: "g2" } : o), NOW + BACKTEST_WINDOW_MS)!.complete, false);
  assert.equal(gradeMemoryForecast(forecast(), observations().slice(0, 9), NOW + BACKTEST_WINDOW_MS)!.complete, false);
  assert.equal(gradeMemoryForecast(forecast(), observations().map(o => ({ ...o, peakMib: null })), NOW + BACKTEST_WINDOW_MS)!.complete, false, "periodic samples alone cannot qualify an unseen peak");
  const reset = observations(); reset[8]!.peakMib = 2000;
  assert.equal(gradeMemoryForecast(forecast(), reset, NOW + BACKTEST_WINDOW_MS)!.complete, false, "a reset high-water mark cannot certify the whole interval");
});

test("W1-T8879: qualification rejects42percent misses, sparse/reset/stale stores and correlated-tail models", () => {
  const now = NOW + 2 * CALIBRATION_DAY_MS;
  const state: CalibrationState = { version: 1, startedAt: NOW, coveredSince: NOW, lastAt: now, generation: "g1",
    observations: [{ at: now, mib: 3000, generation: "g1" }], issues: [],
    outcomes: Array.from({ length: 100 }, (_, i) => ({ ...forecast(now - BACKTEST_WINDOW_MS - i * 60_000),
      id: String(i), closedAt: now, windowPeakUpperBoundMib: i < 42 ? 6000 : 3000, complete: true, upperBoundExceedsForecast: i < 42 })) };
  assert.equal(calibrationReport(state, now).qualified, false);
  assert.equal(calibrationReport(state, now).scenarios["serve-steady"]!.exceedanceRateUpperBound, 0.42);
  const good = { ...state, outcomes: state.outcomes.map(o => ({ ...o, upperBoundExceedsForecast: false, windowPeakUpperBoundMib: 3000 })) };
  assert.equal(calibrationReport(good, now).qualified, true, "a positive control prevents an always-refuse gate");
  assert.equal(calibrationReport({ ...good, startedAt: now }, now).qualified, false);
  assert.equal(calibrationReport({ ...good, lastAt: NOW }, now).qualified, false);
  assert.equal(calibrationReport({ ...good, outcomes: [] }, now).qualified, false);
  assert.equal(calibrationReport({ ...good, outcomes: good.outcomes.map(o => ({ ...o, complete: false })) }, now).qualified, false);
});

test("W1-T8879: a real collector persists before consuming immutable forecasts and recovers without duplicate credit", () => {
  const files = new Map<string, string>(); let removeFails = true;
  const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
  const io: CalibrationIo = { read: path => { const v = files.get(path); if (v === undefined) throw missing(); return v; },
    write: (p, s) => { files.set(p, s); }, publish: (p, s) => { if (files.has(p)) throw Object.assign(new Error("exists"), { code: "EEXIST" }); files.set(p, s); },
    list: p => [...files.keys()].filter(k => k.startsWith(p + "/")).map(k => k.slice(p.length + 1)),
    remove: p => { if (removeFails) throw new Error("interrupted cleanup"); files.delete(p); } };
  publishMemoryForecast("/fixture", forecast(), io); publishMemoryForecast("/fixture", forecast(), io);
  for (const o of observations()) collectMemoryCalibration("/fixture", o, io);
  const first = collectMemoryCalibration("/fixture", { at: NOW + BACKTEST_WINDOW_MS + 1000, mib: 3000, generation: "g1" }, io);
  assert.equal(first.scenarios["serve-steady"]!.forecasts, 1);
  removeFails = false;
  const again = collectMemoryCalibration("/fixture", { at: NOW + BACKTEST_WINDOW_MS + 2000, mib: 3000, generation: "g1" }, io);
  assert.equal(again.scenarios["serve-steady"]!.forecasts, 1, "replayed receipt is deduplicated, not a second success");
  assert.equal(again.qualified, false, "a short fixture is not24hour live qualification");
});

test("W1-T8879: default filesystem receipts, bad populations and publisher failures never manufacture qualification", () => {
  const repo = gitRepo({ kind: "memory-calibration-files" });
  const stateDir = join(repo.dir, "state");
  try {
    publishMemoryForecast(stateDir, forecast()); publishMemoryForecast(stateDir, forecast());
    for (const row of observations()) collectMemoryCalibration(stateDir, row);
    const state = readCalibrationState(stateDir);
    assert.equal(state.outcomes.length, 1);
    assert.equal(state.outcomes[0]!.windowPeakUpperBoundMib, 3000);
    assert.equal(statSync(calibrationStatePath(stateDir)).mode & 0o777, 0o600);
    assert.throws(() => publishMemoryForecast(stateDir, { ...forecast(), quantile: 1 }), /invalid forecast/);
    assert.equal(calibrationReport(readCalibrationState(stateDir), NOW + BACKTEST_WINDOW_MS).qualified, false);
    state.outcomes[0]!.upperBoundExceedsForecast = true;
    writeFileSync(calibrationStatePath(stateDir), JSON.stringify(state));
    assert.throws(() => readCalibrationState(stateDir), /invalid calibration population/, "stored miss flags must agree with the measured outcome");
    writeFileSync(calibrationStatePath(stateDir), " ".repeat(8 * 1024 * 1024 + 1));
    assert.throws(() => readCalibrationState(stateDir), /too large/);
    const recovered = collectMemoryCalibration(stateDir, { at: NOW + BACKTEST_WINDOW_MS, mib: null, peakMib: null, generation: "g2" });
    assert.equal(recovered.qualified, false); assert.equal(recovered.coveredSince, NOW + BACKTEST_WINDOW_MS);
    const footprint = createDaemonFootprint(daemonFootprintPath(stateDir), {
      readFile: () => "{}", writeFile: () => undefined, observeCalibration: () => { throw new Error("collector refused"); },
    });
    assert.deepEqual(footprint.record({ at: NOW, bytes: 12, pid: 1 }), { persisted: true, reason: "calibration:collector refused" });
  } finally { repo.cleanup(); }
});

test("W1-T8879: the policy parser accepts a bounded jointQuantile and maxBacktestMissRate and refuses the rest", () => {
  const doc = parseYaml(readFileSync(new URL("../plan/policy.yaml", import.meta.url), "utf8"));
  const block = (extra: Record<string, unknown>): Record<string, unknown> => ({ ...doc.sweep.hostMemoryBudget, ...extra });
  const row = (value: unknown, origin = "proposal") => ({ origin, value });
  const parsed = parseHostMemoryBudgetPolicy(block({ jointQuantile: row(0.9), maxBacktestMissRate: row(0.1) }));
  assert.equal(parsed.jointQuantile, 0.9);
  assert.equal(parsed.maxBacktestMissRate, 0.1);
  assert.equal(parseHostMemoryBudgetPolicy(block({ maxBacktestMissRate: row(0) })).maxBacktestMissRate, 0, "zero is a valid miss-rate ceiling");
  assert.throws(() => parseHostMemoryBudgetPolicy(block({ jointQuantile: row(0.4) })), /invalid jointQuantile/);
  assert.throws(() => parseHostMemoryBudgetPolicy(block({ jointQuantile: row(1) })), /invalid jointQuantile/);
  assert.throws(() => parseHostMemoryBudgetPolicy(block({ maxBacktestMissRate: row(-0.1) })), /invalid maxBacktestMissRate/);
  assert.throws(() => parseHostMemoryBudgetPolicy(block({ maxBacktestMissRate: row("0.1") })), /invalid maxBacktestMissRate/);
  assert.throws(() => parseHostMemoryBudgetPolicy(block({ jointQuantile: row(0.9, "operator") })), /origin/);
});

test("W1-T8879: a failed forecast publication whose error marker also cannot be written still rethrows the publication error", () => {
  const writes: string[] = [];
  const io: CalibrationIo = {
    read: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    write: path => { writes.push(path); throw new Error("store unavailable"); },
    publish: () => { throw new Error("publish refused"); },
    list: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    remove: () => undefined,
  };
  assert.throws(() => publishMemoryForecast("/fixture", forecast(), io), /publish refused/,
    "the marker failure is swallowed; the original publication failure is what surfaces");
  assert.equal(writes.length, 1, "the marker write was attempted exactly once");
  assert.match(writes[0]!, /^\/fixture\//);
});

test("W1-T8879: a recorded shadow verdict publishes its charge-compared forecast from the sampled observation", () => {
  resetShadowMemoryStateForTests();
  const MIB = 1024 * 1024, root = "/joint-forecast-fixture";
  const policy: HostMemoryBudgetPolicy = { mode: "shadow", jointQuantile: 0.9, hostReserveMib: 2048, containerReserveMib: 1024,
    swapInPagesPerSecMax: 256, psiSomeAvg10Max: 10, psiFullAvg10Max: 2, serveColdStartReserveMib: 7680,
    uncertaintyMarginMib: 256, daemonGrowthUnmeasuredMib: 1024, daemonGrowthMinSamples: 6, staleReadingMs: 600_000 };
  const files: Record<string, string> = {
    "/proc/meminfo": "MemAvailable: 16000000 kB\n", "/proc/vmstat": "pswpin 100\n",
    "/proc/pressure/memory": "some avg10=0 avg60=0\nfull avg10=0 avg60=0\n",
    "/sys/fs/cgroup/memory.current": `${8000 * MIB}\n`, "/sys/fs/cgroup/memory.max": `${9000 * MIB}\n`,
    "/sys/fs/cgroup/memory.high": `${8379 * MIB}\n`, "/sys/fs/cgroup/memory.stat": "inactive_file 0\npswpin 100\n",
    "/sys/fs/cgroup/memory.events": "high 1\n", "/sys/fs/cgroup/memory.pressure": "some avg10=0 avg60=0\nfull avg10=0 avg60=0\n",
    [`${root}/state/${CONTAINER_PRESSURE_FILE}`]: JSON.stringify({ prior: { at: NOW - 20_000, pswpin: 100, high: 1 }, swap: [[NOW - 60_000, 20, 0]], container: [] }),
  };
  const rows: Array<Record<string, unknown>> = [];
  const published: Array<{ stateDir: string; forecast: MemoryForecast }> = [];
  const ports: Partial<ShadowMemoryPorts> = {
    clock: fixedClock(NOW), policy: () => policy,
    readFile: path => { if (!(path in files)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" }); return files[path]!; },
    readTail: () => "",
    readLedger: () => ({ state: "present", scope: "host", dir: "/ledger", entries: [], reservedMib: 0,
      counts: { live: 0, uncertain: 0, incompleteWalk: 0, localScope: 0, unreadable: 0 } }),
    write: (_path, row) => void rows.push(row as unknown as Record<string, unknown>),
    writeFile: (path, content) => { files[path] = content; },
    stderr: () => undefined, instance: () => "fixture", daemonPid: () => undefined, listStateDir: () => [],
    estimate: () => 1024, typical: () => 1024,
    readReviewDemand: () => ({ state: "present", rows: [], unreadableRows: 0 }),
    readHostServe: () => ({ state: "unknown", cause: "local-only", basis: "fixture" }),
    calibrationObservation: at => ({ at, mib: 500, peakMib: 600, generation: "gen-7" }),
    publishCalibration: (stateDir, f) => void published.push({ stateDir, forecast: f }),
  };
  const outcome = recordShadowMemoryVerdict({ root, workerClass: "review", reservationId: "res-1" }, ports);
  assert.equal(outcome.kind, "recorded");
  const numbers = rows.filter(r => r.step === SHADOW_STEP).at(-1)!.numbers as Record<string, number | null>;
  assert.equal(published.length, 1);
  assert.equal(published[0]!.stateDir, `${root}/state`);
  const f = published[0]!.forecast;
  const projected = numbers.containerProjectedMib!;
  assert.equal(typeof projected, "number");
  assert.equal(f.projectedMib, 500 + projected - (numbers.containerWorkingSetMib ?? numbers.containerCurrentMib ?? 0),
    "the sampled charge plus the projected growth, compared charge to charge");
  assert.equal(f.id, "res-1");
  assert.equal(f.at, NOW);
  assert.equal(f.generation, "gen-7");
  assert.equal(f.initialMib, 500);
  assert.equal(f.quantile, 0.9);
  assert.equal(f.basis, "cgroup-current-mib");
  assert.equal(f.model, "legacy-one-tail-fallback", "no joint evidence is available, so the forecast names the fallback");
  assert.notEqual(f.model, "unavailable");
});

test("W1-T8879: paired legacy peaks keep existing admission estimates on their original basis", () => {
  let text = "";
  const options = { location: () => ({ dir: "/fixture" }), instance: () => ({ name: "fixture" }),
    clock: fixedClock(NOW), list: () => ["fixture.ndjson"], readTail: () => text,
    append: (_p: string, line: string) => { text += line; }, size: () => text.length };
  try {
    for (let i = 0; i < 40; i++) recordPeak("garden", 1800, options);
    resetLearnedEstimateCacheForTests(); const before = classEstimate("garden", options);
    text = "";
    for (let i = 0; i < 40; i++) recordPeak("garden", 300, { ...options, measurementBasis: "concurrent-rss", legacyPeakMib: 1800 });
    resetLearnedEstimateCacheForTests(); assert.deepEqual(classEstimate("garden", options), before);
    assert.equal(readPeakSamples("garden", options)[0]!.peakMib, 300, "the new candidate still receives actual concurrent RSS");
    assert.equal(readPeakSamples("garden", options)[0]!.legacyPeakMib, 1800);
  } finally { resetLearnedEstimateCacheForTests(); }
});

test("W1-T8879: tree peaks measure concurrent RSS rather than unrelated historical highs", () => {
  let phase = 0;
  const sampler = createTreePeakSampler({
    listProcesses: () => ({ complete: true, rows: [
      { pid: 10, parent: 1, start: "proc:5" }, { pid: 11, parent: 10, start: "proc:6" },
    ] }),
    readFile: (path) => {
      if (path.endsWith("/stat")) return `10 (node) S 1 ${"0 ".repeat(17)}5 0 0`;
      const root = path === "/proc/10/status";
      return `VmRSS:\t${root ? phase ? 200 * 1024 : 100 * 1024 : phase ? 20 * 1024 : 200 * 1024} kB\nVmHWM:\t${900 * 1024} kB\n`;
    },
    setTimer: () => undefined,
    clearTimer: () => undefined,
  });
  sampler.track("concurrent", 10);
  phase = 1;
  sampler.sampleNow();
  const measured = sampler.finishMeasurement!("concurrent");
  assert.equal(measured.peakMib, 300, "max(sum of current RSS) is 300 MiB, not sum of two 900 MiB historical highs");
  assert.equal(measured.legacyPeakMib, 1800);
});

test("W1-T8879: legacy and concurrent peak bases survive the real store serializer and compaction", () => {
  const now = Date.parse("2026-10-14T23:00:00Z");
  let text = JSON.stringify({ c: "garden", p: 1800, at: new Date(now - 1000).toISOString() }) + "\n";
  text += JSON.stringify({ c: "garden", p: 900, at: new Date(now - 500).toISOString(), basis: "future-unknown" }) + "\n";
  const opts = {
    location: () => ({ dir: "/fixture" }), root: "/fixture", instance: () => ({ name: "core" }),
    clock: fixedClock(now), list: () => ["core.ndjson"], readTail: () => text,
    append: (_path: string, line: string) => { text += line; },
    size: () => 2 * 1024 * 1024,
    rewrite: (_path: string, content: string) => { text = content; },
    measurementBasis: "concurrent-rss" as const,
  };
  assert.equal(recordPeak("garden", 300, opts), true);
  const rows = readPeakSamples("garden", opts);
  assert.deepEqual(rows.map(row => ({ peak: row.peakMib, basis: (row as { measurementBasis?: string }).measurementBasis })), [
    { peak: 1800, basis: "legacy-hwm" }, { peak: 900, basis: "unknown" }, { peak: 300, basis: "concurrent-rss" },
  ], "compaction must not upgrade legacy evidence or erase new measurement provenance");
});

test("W1-T8879: incomplete or denied tree readings are not recorded as smaller measured peaks", () => {
  for (const fault of ["listing", "denied", "missing-rss", "negative-rss"] as const) {
    const sampler = createTreePeakSampler({
      listProcesses: () => ({ complete: fault !== "listing", rows: [{ pid: 10, parent: 1, start: "proc:5" }] }),
      readFile: (path) => {
        if (path.endsWith("/stat")) return `10 (node) S 1 ${"0 ".repeat(17)}5 0 0`;
        if (fault === "denied") throw Object.assign(new Error("denied"), { code: "EACCES" });
        return fault === "listing" ? "VmRSS: 409600 kB\n" : fault === "negative-rss" ? "VmRSS: -1 kB\n" : "VmHWM: 409600 kB\n";
      },
      setTimer: () => undefined, clearTimer: () => undefined,
    });
    sampler.track(fault, 10);
    assert.equal(sampler.finishMeasurement!(fault).peakMib, undefined, `${fault} is missing evidence, not a lower or zero tree peak`);
  }
});

test("W1-T8879: a later unreadable interval invalidates concurrent training without losing the legacy measurement", () => {
  let readable = true;
  const sampler = createTreePeakSampler({
    listProcesses: () => ({ complete: true, rows: [{ pid: 10, parent: 1, start: "proc:5" }] }),
    readFile: path => {
      if (path.endsWith("/stat")) return `10 (node) S 1 ${"0 ".repeat(17)}5 0 0`;
      if (!readable) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return "VmRSS: 409600 kB\nVmHWM: 819200 kB\n";
    }, setTimer: () => undefined, clearTimer: () => undefined,
  });
  sampler.track("partial", 10); readable = false; sampler.sampleNow(); readable = true;
  const measured = sampler.finishMeasurement!("partial");
  assert.equal(measured.peakMib, undefined, "a later small reading does not erase missing training coverage");
  assert.equal(measured.legacyPeakMib, 800, "the existing HWM-based admission cohort remains separate");
});

test("W1-T8879: binding a root twice does not count its concurrent RSS twice", () => {
  const sampler = createTreePeakSampler({
    listProcesses: () => ({ complete: true, rows: [{ pid: 10, parent: 1, start: "proc:5" }] }),
    readFile: path => path.endsWith("/stat") ? `10 (node) S 1 ${"0 ".repeat(17)}5 0 0` : "VmRSS: 409600 kB\nVmHWM: 819200 kB\n",
    setTimer: () => undefined, clearTimer: () => undefined,
  });
  sampler.track("root", 10);
  sampler.track("root", 10);
  assert.deepEqual(sampler.finishMeasurement!("root"), { peakMib: 400, legacyPeakMib: 800 });
});

test("W1-T8879: the production-style finish adapter still sees the legacy result while training records concurrent RSS", () => {
  const base = createTreePeakSampler({
    listProcesses: () => ({ complete: true, rows: [{ pid: 10, parent: 1, start: "proc:5" }] }),
    readFile: path => path.endsWith("/stat") ? `10 (node) S 1 ${"0 ".repeat(17)}5 0 0` : "VmRSS: 409600 kB\nVmHWM: 819200 kB\n",
    setTimer: () => undefined, clearTimer: () => undefined,
  });
  let calls = 0, captured: number | undefined;
  const wrapped = { ...base, finish: (id: string) => { calls++; captured = base.finish(id); return captured; } };
  wrapped.track("wrapped", 10);
  assert.deepEqual(wrapped.finishMeasurement!("wrapped"), { peakMib: 400, legacyPeakMib: 800 });
  assert.equal(calls, 1); assert.equal(captured, 800); assert.equal(wrapped.size(), 0);
});
