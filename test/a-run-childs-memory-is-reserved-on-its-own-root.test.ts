import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import {
  defaultGeneration, defaultProbe, readMemoryLedger, sweepMemoryReservations,
  type HostMemoryLedgerOptions, type MemoryReservationEntry,
} from "../src/lib/host-memory-ledger.js";
import { createTreePeakSampler, readPeakSamples, resetLearnedEstimateCacheForTests } from "../src/lib/host-memory-learning.js";
import { RUN_CHILD_SCHEMA, writeSpec, writeStatus, type RunChildProbe, type RunChildSpec } from "../src/lib/run-child-contract.js";
import { adoptRunChildReservation, liveRunChildCount, reserveRunChild, withRunChildReservation } from "../src/lib/run-child-reservation.js";
import { activeWorkerCount, spawnWorker, withWorkerOccupancy } from "../src/lib/worker.js";

function fixture(t: TestContext) {
  resetLearnedEstimateCacheForTests();
  const root = mkdtempSync(join(tmpdir(), "rmd-run-memory-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateRoot = join(root, "state");
  const dir = join(root, "memory");
  mkdirSync(dir);
  writeFileSync(join(dir, ".ledger-id"), "fixture-ledger\n");
  const generation = { containerId: "container", initStart: "proc:1" };
  const processes = new Map([
    [1, { parent: 0, start: "proc:1", mib: 10, argv: "daemon" }],
    [2, { parent: 1, start: "proc:2", mib: 180, argv: "node run-child" }],
    [3, { parent: 2, start: "proc:3", mib: 700, argv: "worker" }],
  ]);
  const probe: RunChildProbe = {
    generation: () => generation,
    process: (pid) => processes.has(pid) ? { state: "alive", start: processes.get(pid)!.start } : { state: "gone" },
  };
  const ledger: HostMemoryLedgerOptions = {
    location: () => ({ dir, scope: "local" }), root, ownerPid: 1,
    instance: () => ({ name: "fixture", hostUnique: true }), generation: probe.generation,
    probe: probe.process, clock: fixedClock(1000), log: () => {},
    listProcesses: () => ({ complete: true, rows: [...processes].map(([pid, p]) => ({ pid, ...p })) }),
  };
  const store = { location: ledger.location, root, instance: () => ({ name: "fixture" }), clock: fixedClock(1000) };
  const sampler = createTreePeakSampler({
    listProcesses: () => ledger.listProcesses!({ maxEntries: 100, maxMs: 100 }),
    readFile: (path) => {
      const pid = Number(path.split("/")[2]);
      const p = processes.get(pid);
      if (!p) throw Object.assign(new Error("process exited"), { code: "ENOENT" });
      if (path.endsWith("stat")) return `${pid} (node) S ${p.parent} ${"0 ".repeat(17)}${p.start.slice(5)} 0`;
      if (path.endsWith("cmdline")) return p.argv;
      return `VmHWM: ${p.mib * 1024} kB\n`;
    },
    setTimer: () => ({ unref() {} }), clearTimer: () => {},
  });
  const deps = { ledger, store, sampler, admission: { policy: () => ({ mode: "shadow" }) as never } };
  const spec: RunChildSpec = {
    schema: RUN_CHILD_SCHEMA, taskId: "W1-T9080", runId: "run", instance: "fixture",
    engine: { sourceHash: "hash", sha: "sha" }, planSnapshotPath: "plan.json", reservationId: "adopted", options: {},
  };
  function status(runId: string, pid: number, state: "running" | "done" = "running") {
    const runDir = join(stateRoot, "runs", runId);
    mkdirSync(runDir, { recursive: true });
    writeSpec(runDir, { ...spec, runId });
    writeStatus(runDir, {
      schema: RUN_CHILD_SCHEMA, runId, identity: { pid, startTicks: `proc:${pid}`, containerGeneration: generation },
      entryKind: "tsx", engineSha: "sha", phase: "implementing", heartbeatAt: 1000, state,
    });
    return runDir;
  }
  return { root, stateRoot, dir, generation, processes, probe, ledger, store, sampler, deps, spec, status };
}

test("W1-T9080: a run child tree peak includes the child and its worker", async (t) => {
  const f = fixture(t);
  const run = await reserveRunChild({ lane: "implement", root: f.root, runId: "run", entryKind: "tsx" }, f.deps);
  assert.equal(readMemoryLedger(f.ledger)!.entries.length, 1, "reserved before the spawn");
  run.bindRoot(2);
  const entry = JSON.parse(readFileSync(join(f.dir, `${run.id}.json`), "utf8")) as MemoryReservationEntry;
  assert.deepEqual(entry.roots, [{ pid: 2, start: "proc:2" }]);
  assert.equal(entry.entry_kind, "tsx");
  assert.equal(entry.workerClass, "implement");
  run.releaseOccupancy();
  const peaks = readPeakSamples("implement", f.store);
  assert.equal(peaks[0]!.peakMib, 880);
  assert.equal(peaks[0]!.entryKind, "tsx");
  assert.equal(readMemoryLedger(f.ledger)!.entries.length, 1, "release still holds a live tree");
  f.processes.delete(2);
  assert.equal(sweepMemoryReservations(f.ledger)!.released.length, 0, "a surviving worker holds the tree");
  f.processes.delete(3);
  assert.deepEqual(sweepMemoryReservations(f.ledger)!.released.map((r) => r.rule), ["tree-gone"]);
});

test("W1-T9080: a restart keeps an adopted child reservation claimed", (t) => {
  const f = fixture(t);
  const runDir = f.status("run", 2);
  const entry: MemoryReservationEntry = {
    schema: 1, id: "adopted", instance: "fixture", instanceHostUnique: true, generation: f.generation,
    owner: { pid: 99, start: "proc:99" }, workerClass: "fix", estimateMib: 2500,
    estimateSource: { kind: "measured", samples: 12 }, openedAt: fixedClock(0).iso(), verifiedAt: fixedClock(0).iso(),
    roots: [{ pid: 2, start: "proc:2" }], tree: [{ pid: 2, start: "proc:2" }, { pid: 3, start: "proc:3" }], entry_kind: "tsx",
  };
  const path = join(f.dir, "adopted.json");
  writeFileSync(path, JSON.stringify(entry));
  const adopted = adoptRunChildReservation(runDir, f.deps, f.probe);
  assert.ok(adopted);
  assert.equal(adopted.id, "adopted");
  assert.equal(adopted.estimateMib, 2500);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).owner, { pid: 1, start: "proc:1" });
  rmSync(path);
  assert.equal(readMemoryLedger(f.ledger)!.entries[0]!.id, "adopted", "the restarted owner keeps an in-memory claim");
  assert.equal(sweepMemoryReservations(f.ledger)!.released.length, 0);
  assert.equal(readMemoryLedger(f.ledger)!.entries[0]!.occupancyReleased, false);
  assert.equal(f.sampler.size(), 1, "adoption resumes peak sampling");
  adopted.releaseOccupancy();
  assert.equal(readPeakSamples("fix", f.store)[0]!.peakMib, 880);
});

test("W1-T9080: a worker inside a run child opens no second reservation", async (t) => {
  const f = fixture(t);
  let admissionReads = 0;
  await withRunChildReservation(f.spec, async () => {
    await assert.rejects(spawnWorker({
      cwd: f.root, settingsFile: join(f.root, "missing.json"), permissionMode: "bypassPermissions", prompt: "work",
      config: { root: f.root } as never,
      memoryShadow: { policy: () => { admissionReads++; return { mode: "shadow" } as never; } },
    }));
    assert.equal(admissionReads, 0);
    await withWorkerOccupancy(async () => {
      assert.equal(readMemoryLedger(f.ledger)!.entries.length, 0);
    }, { ledger: f.ledger, learning: { store: f.store, sampler: f.sampler } });
  });
  assert.equal(readMemoryLedger(f.ledger)!.entries.length, 0);
  await withRunChildReservation({ ...f.spec, reservationId: "" }, () => withWorkerOccupancy(async () => {
    assert.equal(readMemoryLedger(f.ledger)!.entries.length, 1, "an empty id does not bypass reservation");
  }, { ledger: f.ledger, learning: { store: f.store, sampler: f.sampler } }));
});

test("W1-T9080: activeWorkerCount counts live run children", async (t) => {
  const f = fixture(t);
  f.status("first", 2);
  f.status("second", 3);
  f.status("terminal", 2, "done");
  f.status("lost", 44);
  assert.equal(liveRunChildCount(f.stateRoot, f.probe), 2);
  assert.equal(activeWorkerCount(f.stateRoot, f.probe), 2);
  await withWorkerOccupancy(async () => {
    assert.equal(activeWorkerCount(f.stateRoot, f.probe), 3);
  }, { ledger: f.ledger, learning: { store: f.store, sampler: f.sampler } });
  assert.equal(activeWorkerCount(f.stateRoot, f.probe), 2);
  f.processes.get(2)!.start = "proc:reused";
  assert.equal(activeWorkerCount(f.stateRoot, f.probe), 1);
  assert.equal(liveRunChildCount(join(f.root, "missing"), f.probe), 0);
});

test("run-child reservation uses the real process identity and sampler", async (t) => {
  const f = fixture(t);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(async () => { child.kill("SIGKILL"); await exited; });
  const ledger = { ...f.ledger, ownerPid: process.pid, probe: defaultProbe, generation: defaultGeneration, listProcesses: undefined };
  const sampler = createTreePeakSampler();
  const run = await reserveRunChild({ lane: "sweep-fix", root: f.root, entryKind: "bundle" }, { ...f.deps, ledger, sampler });
  run.bindRoot(child.pid!);
  run.releaseOccupancy();
  assert.equal(readMemoryLedger(ledger)!.entries.length, 1);
  const samples = readPeakSamples("fix", f.store);
  if (process.platform === "linux") {
    assert.ok(samples[0]!.peakMib > 0, "Linux must positively measure the real child's VmHWM");
  } else {
    assert.deepEqual(samples, [], "without Linux /proc the real sampler records no invented peak measurement");
  }
  child.kill("SIGKILL");
  await exited;
  const swept = sweepMemoryReservations(ledger)!;
  if (process.platform === "linux") {
    assert.equal(swept.released[0]!.rule, "tree-gone");
  } else {
    assert.deepEqual(swept.released, [], "an incomplete native tree census never proves every descendant exited");
    assert.equal(swept.reading.entries[0]!.status, "uncertain");
    assert.equal(swept.reading.entries[0]!.walkComplete, false);
    assert.equal(swept.reading.entries[0]!.occupancyReleased, true);
  }
});

test("a reserved run child still discovers and learns its nested test reservation", async (t) => {
  const f = fixture(t);
  f.processes.set(4, { parent: 3, start: "proc:4", mib: 300, argv: "node\0--test\0suite.test.ts\0" });
  const run = await reserveRunChild({ lane: "implement", root: f.root, entryKind: "bundle" }, f.deps);
  run.bindRoot(2);
  assert.deepEqual(readMemoryLedger(f.ledger)!.entries.map((e) => e.workerClass).sort(), ["implement", "test"]);
  f.processes.delete(4);
  f.sampler.sampleNow();
  assert.equal(readPeakSamples("test", f.store)[0]!.peakMib, 300);
  assert.equal(readPeakSamples("test", f.store)[0]!.entryKind, undefined);
  run.releaseOccupancy();
  assert.equal(readPeakSamples("implement", f.store)[0]!.peakMib, 880, "each member teaches one class");
});

test("adoption rejects a terminal, reused, released or mismatched child and names ledger failures", async (t) => {
  const f = fixture(t);
  const run = await reserveRunChild({ lane: "fix", root: f.root, entryKind: "bundle" }, f.deps);
  run.bindRoot(2);
  const dir = f.status("run", 2);
  writeSpec(dir, { ...f.spec, reservationId: run.id! });
  const path = join(f.dir, `${run.id}.json`);
  const entry = JSON.parse(readFileSync(path, "utf8")) as MemoryReservationEntry;
  for (const change of [
    { occupancyReleasedAt: fixedClock(1000).iso() },
    { roots: [{ pid: 3, start: "proc:3" }] },
    { generation: { ...f.generation, initStart: "proc:old" } },
    { id: "another-id" },
  ]) {
    writeFileSync(path, JSON.stringify({ ...entry, ...change }));
    assert.equal(adoptRunChildReservation(dir, f.deps, f.probe), undefined);
  }
  writeFileSync(path, JSON.stringify(entry));
  f.processes.get(2)!.start = "proc:reused";
  assert.equal(adoptRunChildReservation(dir, f.deps, f.probe), undefined);
  f.processes.get(2)!.start = "proc:2";
  const logs: Array<Record<string, unknown>> = [];
  const log = (event: Record<string, unknown>) => { logs.push(event); };
  for (const fail of [
    { read: () => { throw new Error("read refused"); } },
    { write: () => { throw new Error("write refused"); } },
    { ownerPid: 999 },
    { location: () => { throw new Error("storage unavailable"); } },
  ]) {
    assert.equal(adoptRunChildReservation(dir, { ...f.deps, ledger: { ...f.ledger, ...fail, log } }, f.probe), undefined);
  }
  assert.deepEqual(logs.map((event) => event.op), ["adopt", "adopt", "adopt", "adopt"]);
  assert.match(String(logs[0]!.reason), /read refused/);
  assert.match(String(logs[1]!.reason), /write refused/);
  writeSpec(dir, { ...f.spec, reservationId: "../escape" });
  assert.equal(adoptRunChildReservation(dir, { ...f.deps, ledger: { ...f.ledger, log } }, f.probe), undefined);
  assert.match(String(logs.at(-1)!.reason), /invalid reservation id/);
  f.status("run", 2, "done");
  assert.equal(adoptRunChildReservation(dir, f.deps, f.probe), undefined);
  assert.equal(readMemoryLedger(f.ledger)!.entries.length, 1);
});
