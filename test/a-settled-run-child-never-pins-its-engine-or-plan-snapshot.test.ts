import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { daemonBoot } from "#src/lib/daemon.js";
import { pruneEngineTrees } from "#src/lib/engine-tree.js";
import type { LearnedReservation, TreePeakSampler } from "#src/lib/host-memory-learning.js";
import * as runChild from "#src/lib/run-child.js";
import { classifyRunDir, parseStatus, readSpec, readStatus, realRunChildProbe, RUN_CHILD_SCHEMA, runDir, writeSpec, writeStatus } from "#src/lib/run-child-contract.js";
import { daemonCommand } from "#src/run-task.js";

const HASH = "a".repeat(64);
const SHA = "b".repeat(40);
type Row = { step: string } & Record<string, unknown>;

class Child extends EventEmitter {
  pid = 424242;
  stderr = new PassThrough();
  unref(): void {}
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-t9910-"));
  const state = join(root, "state");
  const engine = join(state, "engines", HASH);
  mkdirSync(engine, { recursive: true });
  writeFileSync(join(engine, "engine.json"), JSON.stringify({ sourceHash: HASH, sha: SHA, builtAt: 1 }));
  const rows: Row[] = [];
  const log = (step: string, extra?: Record<string, unknown>): void => { rows.push({ step, ...extra }); };
  const input = { root, stateRoot: state, repoDir: root, taskId: "W1-T9910", options: {}, log,
    plan: Promise.resolve({ plan: { tasks: [{ id: "W1-T9910" }] } }) };
  const sampler = { sampleNow() {}, finish: () => undefined } as unknown as TreePeakSampler;
  const reserve = () => ({ id: "reservation", bindRoot() {}, releaseOccupancy() {} }) as unknown as LearnedReservation;
  const ports: runChild.RunChildProbePorts = {
    readMode: () => "shadow", mainSha: async () => SHA, engine: { isCurrent: () => true },
    sampler, reserve, launch: () => ({ kind: "tsx", reason: "fixture", argv: ["--version"], cwd: root, engineRoot: engine }),
  };
  const specOnly = (id: string): string => {
    const dir = runDir(state, id);
    writeSpec(dir, { schema: RUN_CHILD_SCHEMA, runId: id, taskId: "W1-T9910", instance: "fixture",
      engine: { sourceHash: HASH, sha: SHA }, planSnapshotPath: runChild.writePlanSnapshot(state, []).path,
      reservationId: "", options: {} });
    return dir;
  };
  const ledger = (name: string, records: unknown[]): void => {
    const text = records.map(row => JSON.stringify(row)).join("\n") + "\n";
    writeFileSync(join(state, name), name.endsWith(".gz") ? gzipSync(text) : text);
  };
  const newerResources = (): void => {
    const newer = join(state, "engines", "c".repeat(64));
    mkdirSync(newer, { recursive: true });
    writeFileSync(join(newer, "engine.json"), JSON.stringify({ sourceHash: "c".repeat(64), sha: "d".repeat(40), builtAt: 2 }));
    for (const name of [runChild.writePlanSnapshot(state, []).path, runChild.writePlanSnapshot(state, [{ id: "W1-T9910" }]).path]) {
      utimesSync(name, 1, 1);
    }
    const snapshot = runChild.writePlanSnapshot(state, [{ id: "newer" }]);
    utimesSync(snapshot.path, 2, 2);
  };
  const prune = () => pruneEngineTrees(state, { repoDir: root, git: async () => "" });
  return { root, state, engine, rows, log, input, ports, reserve, specOnly, ledger, newerResources, prune,
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("W1-T9910: a probe that ends with no status no longer pins its engine or plan snapshot", async () => {
  for (const real of [false, true]) {
    const f = fixture();
    try {
      const child = new Child();
      const outcome = await runChild.startRunChildProbe(f.input, { ...f.ports,
        ...(real ? {} : { spawn: () => { setImmediate(() => child.emit("exit", 1, null)); return child as unknown as ChildProcess; } }),
      });
      assert.ok(outcome.started);
      const dir = runDir(f.state, String(outcome.row.run_id));
      const spec = readSpec(dir);
      assert.ok(spec.ok);
      const status = readStatus(dir);
      assert.ok(status.ok, JSON.stringify(status));
      assert.equal(status.value.state, "aborted");
      assert.equal(status.value.identity.startTicks, "unknown");
      if (!real) assert.equal(status.value.identity.pid, child.pid);
      assert.equal(status.value.engineSha, SHA);
      assert.equal(status.value.failure?.message, outcome.row.error);
      assert.equal(classifyRunDir(dir).kind, "terminal");
      f.newerResources();
      await f.prune();
      runChild.prunePlanSnapshots(f.state);
      assert.equal(existsSync(f.engine), false, "the settled probe releases its engine");
      assert.equal(existsSync(spec.value.planSnapshotPath), false, "the settled probe releases its snapshot");
      assert.deepEqual(runChild.pruneProbeRunDirs(f.state, 0), [dir]);
    } finally { f.cleanup(); }
  }
});

test("W1-T9910: a boot settles only the spec-only directories the ledger proves settled", () => {
  const f = fixture();
  try {
    const ids = ["probe-archive", "run-plain", "run-live", "run-unsettled", "probe-wrong-step"];
    ids.forEach(f.specOnly);
    f.ledger("ledger.2026-10-14.ndjson.gz", [{ step: "run_child.shadow", run_id: ids[0], error: "no probe status" }]);
    f.ledger("ledger.2026-10-15.ndjson", [{ step: "run_child.lost", run_id: ids[1], detail: "child exited" }]);
    f.ledger("ledger.ndjson", [
      { step: "run_child.settled", run_id: ids[2], reason: "parent observed the end" },
      { step: "run_child.spawned", run_id: ids[3] },
      { step: "run_child.settled", run_id: ids[4] },
      { step: "run_child.shadow", run_id: "other", error: ids[3] },
    ]);
    runChild.settleRunChildBacklog(f.state, f.log);
    for (const id of ids.slice(0, 3)) {
      const status = readStatus(runDir(f.state, id));
      assert.ok(status.ok);
      assert.equal(status.value.state, "aborted");
      assert.deepEqual(status.value.identity, { settledByParent: true });
      assert.equal(status.value.engineSha, SHA);
      assert.equal(classifyRunDir(runDir(f.state, id)).kind, "terminal");
    }
    assert.equal(readStatus(runDir(f.state, ids[0]!)).ok && classifyRunDir(runDir(f.state, ids[0]!)).status?.failure?.message, "no probe status");
    for (const id of ids.slice(3)) assert.equal(existsSync(join(runDir(f.state, id), "status.json")), false);
    const row = f.rows.at(-1)!;
    assert.equal(row.step, "run_child.boot_settlement");
    assert.equal(row.settled, 3);
    assert.equal(row.unsettled, 2);
    assert.equal(row.unread, 0);
    for (const broken of ["ledger.2026-10-16.ndjson.gz", "ledger.ndjson"]) {
      const dir = f.specOnly(`run-unread-${broken.endsWith(".gz") ? "archive" : "live"}`);
      f.ledger("ledger.2026-10-15.ndjson", [{ step: "run_child.lost", run_id: dir.split("/").at(-1), detail: "gone" }]);
      if (broken.endsWith(".gz")) writeFileSync(join(f.state, broken), "broken gzip");
      else { rmSync(join(f.state, broken)); mkdirSync(join(f.state, broken)); }
      runChild.settleRunChildBacklog(f.state, f.log);
      assert.equal(existsSync(join(dir, "status.json")), false);
      assert.equal(f.rows.at(-1)?.settled, 0);
      assert.ok(Number(f.rows.at(-1)?.unread) > 0);
      rmSync(join(f.state, broken), { recursive: true });
      if (!broken.endsWith(".gz")) f.ledger(broken, []);
    }
  } finally { f.cleanup(); }
});

test("W1-T9910: an in-flight directory and a child-written status are left alone", async () => {
  const f = fixture();
  const child = new Child();
  let spawned!: () => void;
  const ready = new Promise<void>(resolve => { spawned = resolve; });
  const pending = runChild.startRunChildProbe(f.input, { ...f.ports, spawn: () => {
    spawned(); return child as unknown as ChildProcess;
  } });
  try {
    await ready;
    const dirs = readdirSync(join(f.state, "runs"));
    const id = dirs[0]!;
    const dir = runDir(f.state, id);
    f.ledger("ledger.ndjson", [{ step: "run_child.shadow", run_id: id, error: "a stale end row" }]);
    runChild.settleRunChildBacklog(f.state, f.log);
    assert.equal(existsSync(join(dir, "status.json")), false);
    assert.equal(classifyRunDir(dir).kind, "unreadable");
    f.newerResources();
    await f.prune();
    runChild.prunePlanSnapshots(f.state);
    assert.equal(existsSync(f.engine), true);
    const spec = readSpec(dir);
    assert.ok(spec.ok);
    assert.equal(existsSync(spec.value.planSnapshotPath), true);
    writeStatus(dir, { schema: RUN_CHILD_SCHEMA, runId: id,
      identity: { pid: child.pid, startTicks: "proc:1", containerGeneration: { containerId: "fixture", initStart: "proc:1" } },
      state: "running", engineSha: SHA, entryKind: "tsx", phase: "child-owned", heartbeatAt: 1 });
    const before = readFileSync(join(dir, "status.json"), "utf8");
    child.emit("exit", 1, null);
    await pending;
    runChild.settleRunChildBacklog(f.state, f.log);
    assert.equal(readFileSync(join(dir, "status.json"), "utf8"), before);
    await f.prune();
    assert.equal(existsSync(f.engine), true);
    const raw = JSON.parse(before) as Record<string, unknown>;
    assert.equal(parseStatus({ ...raw, identity: { settledByParent: true } }).ok, false,
      "a parent-settled identity cannot represent a running process");
  } finally { child.emit("exit", 1, null); await pending; f.cleanup(); }
});

test("W1-T9910: a lost run child records its observed end before cleanup", async () => {
  const f = fixture();
  try {
    const child = new Child();
    const handle = await runChild.spawnRunChild({ ...f.input, plan: async () => (await f.input.plan)! }, {
      mainSha: f.ports.mainSha, engine: f.ports.engine, launch: f.ports.launch,
      reserve: async () => f.reserve(), spawn: () => child as unknown as ChildProcess,
      workerAdmissionHold: () => undefined, watch: false, pollMs: 60_000,
    });
    assert.ok(handle.started);
    f.ledger("ledger.ndjson", [{ step: "run_child.lost", run_id: handle.runId, detail: "stale evidence" }]);
    runChild.settleRunChildBacklog(f.state, f.log);
    assert.equal(existsSync(join(handle.dir, "status.json")), false);
    const rejected = assert.rejects(handle.settled, /the child exited/);
    child.emit("exit", 1, null);
    await rejected;
    const status = readStatus(handle.dir);
    assert.ok(status.ok);
    assert.equal(status.value.state, "aborted");
    assert.equal(status.value.identity.pid, child.pid);
    assert.equal(status.value.identity.startTicks, "unknown");
    assert.equal(status.value.engineSha, SHA);
    assert.equal(status.value.entryKind, "tsx");
    assert.equal(status.value.failure?.message, f.rows.find(row => row.step === "run_child.lost")?.detail);
    assert.equal(classifyRunDir(handle.dir).kind, "terminal");
    f.newerResources();
    await f.prune();
    assert.equal(existsSync(f.engine), false);
  } finally { f.cleanup(); }
});

test("W1-T9910: a spawn exception settles without inventing a pid", async () => {
  const f = fixture();
  try {
    const outcome = await runChild.startRunChildProbe(f.input, { ...f.ports, spawn: () => { throw new Error("spawn refused"); } });
    assert.ok(outcome.started);
    const status = readStatus(runDir(f.state, String(outcome.row.run_id)));
    assert.ok(status.ok);
    assert.deepEqual(status.value.identity, { settledByParent: true });
    assert.equal(status.value.failure?.message, outcome.row.error);
    assert.equal(classifyRunDir(runDir(f.state, String(outcome.row.run_id))).kind, "terminal");
  } finally { f.cleanup(); }
});

test("W1-T9910: the daemon boot repairs settled probes even in shadow mode", async () => {
  const f = fixture();
  try {
    const dir = f.specOnly("probe-before-boot");
    f.ledger("ledger.2026-10-14.ndjson.gz", [{ step: "run_child.shadow", run_id: "probe-before-boot", error: "no status" }]);
    const plan = join(f.root, "tasks.yaml");
    writeFileSync(plan, "[]\n");
    let boots = 0;
    let atBoot: string | undefined;
    const code = await daemonCommand(["--allow-self-target", "--plan", plan, "--max", "0"], {
      config: { root: f.root, claudeBin: "/bin/true" }, readRunChildMode: () => "shadow",
      checkStop: () => undefined, checkPause: () => undefined,
      daemonBoot: (log, env) => {
        boots++;
        atBoot = classifyRunDir(dir).kind;
        return daemonBoot(log, env);
      },
      runDaemon: async () => ({ attempted: [], merged: [], costUsd: 0, ticks: 0, stopReason: "max_reached" }),
    });
    assert.equal(code, 0);
    assert.equal(boots, 1);
    assert.equal(atBoot, "terminal");
    const rows = readFileSync(join(f.state, "ledger.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line) as Row);
    const settlements = rows.filter(row => row.step === "run_child.boot_settlement");
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0]?.settled, 1);
  } finally { f.cleanup(); }
});

test("W1-T9910: settlement failures report an unread reason and leave the directory non-terminal", async (t) => {
  const f = fixture();
  try {
    t.mock.method(realRunChildProbe, "generation", () => { throw new Error("generation unreadable"); });
    const child = new Child();
    const outcome = await runChild.startRunChildProbe(f.input, { ...f.ports, spawn: () => {
      setImmediate(() => child.emit("exit", 1, null)); return child as unknown as ChildProcess;
    } });
    assert.ok(outcome.started);
    assert.match(String(outcome.row.settlement_error), /generation unreadable/);
    const dir = runDir(f.state, String(outcome.row.run_id));
    assert.equal(classifyRunDir(dir).kind, "unreadable");
    f.ledger("ledger.ndjson", [{ ...outcome.row, step: "run_child.shadow", child_pid: child.pid }]);
    runChild.settleRunChildBacklog(f.state, f.log);
    assert.equal(f.rows.at(-1)?.settled, 0);
    assert.equal(f.rows.at(-1)?.unsettled, 1);
    assert.equal(f.rows.at(-1)?.unread, 1);
    assert.match(String(f.rows.at(-1)?.error), /generation unreadable/);
    assert.equal(existsSync(join(dir, "status.json")), false);
    const run = new Child();
    const handle = await runChild.spawnRunChild({ ...f.input, plan: async () => (await f.input.plan)! }, {
      mainSha: f.ports.mainSha, engine: f.ports.engine, launch: f.ports.launch,
      reserve: async () => f.reserve(), spawn: () => run as unknown as ChildProcess,
      workerAdmissionHold: () => undefined, watch: false, pollMs: 60_000,
    });
    assert.ok(handle.started);
    const rejected = assert.rejects(handle.settled, /the child exited/);
    run.emit("exit", 1, null);
    await rejected;
    const loss = f.rows.find(row => row.step === "run_child.lost");
    assert.match(String(loss?.settlement_error), /generation unreadable/);
    assert.equal(existsSync(join(handle.dir, "status.json")), false);
  } finally { f.cleanup(); }
});

test("W1-T9910: an unreadable run directory census is reported instead of settled", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.state, "runs"), "not a directory");
    runChild.settleRunChildBacklog(f.state, f.log);
    assert.equal(f.rows.at(-1)?.settled, 0);
    assert.equal(f.rows.at(-1)?.unread, 1);
    assert.match(String(f.rows.at(-1)?.error), /ENOTDIR/);
  } finally { f.cleanup(); }
});
