/**
 * W1-T13304: serve's container averaged 1.58 cores on 2026-11-17 while a thin API layer should idle near zero, and
 * nothing recorded it. The supervisor now writes serve.cpu_budget each hour (boots left out), and the serve-cpu-budget
 * invariant fires when two hours in a row pass SERVE_STEADY_CPU_BUDGET_CORES.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  evaluateIncidentInvariants, SERVE_CPU_BUDGET_RULE_ID, SERVE_CPU_BUDGET_STEP, SERVE_STEADY_CPU_BUDGET_CORES,
} from "#src/lib/incident-invariants.js";
import { cgroupCpuUsageUsec, createServeSupervisor, procCpuConsumers, type GenerationProcess, type PreparedSlot, type ServeSupervisorOptions } from "#src/lib/serve-supervisor.js";
import type { GenerationMessage } from "#src/lib/serve-generation.js";

const MIN = 60_000;
const CORE_USEC_PER_MIN = 60 * 1e6;

/** A supervisor whose generations promote at once; a boot costs `boot.ms` of clock and `boot.usec` of CPU. */
function world(blind = false, shares: Array<[string, number]> = [["node", 0.5], ["children", 0.3], ["libuv-worker", 0.2], ["V8 Worker", 0]]) {
  const state = { now: 0, usec: 0, boot: { ms: 0, usec: 0 } };
  const slots = new Map<string, PreparedSlot>();
  let forks = 0;
  const spawn: ServeSupervisorOptions["spawn"] = (command, env) => {
    slots.set(env.RMD_SERVE_READY_SOCKET!, JSON.parse(command.args[0]!) as PreparedSlot);
    forks += 1;
    const onMessage: Array<(m: GenerationMessage) => void> = [];
    const onExit: Array<(c: number | null, s: string | null) => void> = [];
    const generation: GenerationProcess = {
      pid: 1_000_000 + forks,
      send(message) {
        if (message.type === "rmd.promote") queueMicrotask(() => onMessage.forEach((l) => l({ type: "rmd.promoted" })));
        if (message.type === "rmd.drain") queueMicrotask(() => onExit.forEach((l) => l(0, null)));
      },
      onMessage: (l) => void onMessage.push(l),
      onExit: (l) => void onExit.push(l),
      kill: () => onExit.forEach((l) => l(null, "SIGKILL")),
    };
    return generation;
  };
  const get: ServeSupervisorOptions["get"] = async (socketPath, path) => {
    if (path === "/v1/version") {
      // The boot's cost lands while the new generation comes up.
      state.now += state.boot.ms;
      state.usec += state.boot.usec;
      state.boot = { ms: 0, usec: 0 };
      return { status: 200, body: JSON.stringify({ sha: slots.get(socketPath)?.sha }) };
    }
    return { status: 200, body: JSON.stringify({ ready: true, criteria: [] }) };
  };
  const ticks: Array<() => void> = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let sha = 1;
  const supervisor = createServeSupervisor({
    coldSlot: { dir: "/cold", sha: "sha-1" },
    prepare: async (activeDir) => ({ dir: activeDir === "/slot-a" ? "/slot-b" : "/slot-a", sha: `sha-${++sha}` }),
    spawn, get,
    command: (slot) => ({ exec: "gen", execArgv: [], args: [JSON.stringify(slot)], cwd: slot.dir }),
    log: (step, extra) => void logs.push({ step, extra }),
    exit: () => {},
    clock: { now: () => state.now, iso: () => "" } as never,
    sleep: () => new Promise<void>(() => {}),
    freeMemory: () => undefined, rss: () => undefined, peakRss: () => 1_000,
    hostPressure: async () => ({ atMs: state.now, memAvailableBytes: 2 ** 40, swapInPagesPerSec: 0, psiSomeAvg10: 0, psiFullAvg10: 0, unread: [] }),
    upgradeThresholds: () => ({ hostReserveBytes: 0, swapInPagesPerSecMax: 256, psiSomeAvg10Max: 10, psiFullAvg10Max: 2, staleMs: 600_000 }),
    socketPathFor: (n) => `/sock/${n}`,
    cpuBudget: {
      usageUsec: () => (blind ? undefined : state.usec),
      consumers: () => new Map(shares.map(([name, share]) => [name, state.usec / 1e6 * share])),
      every: (_ms, fn) => (ticks.push(fn), () => {}),
    },
  });
  const rows = () => logs.filter((l) => l.step === SERVE_CPU_BUDGET_STEP).map((l) => l.extra!);
  return { supervisor, state, ticks, rows, logs };
}

test("W1-T13304 criterion 1: the hourly row leaves boots out: steady_cores is usage outside boots over seconds outside boots", async () => {
  const w = world();
  await w.supervisor.start();
  assert.equal(w.ticks.length, 1, "the budget timer starts once serve is ready");
  // Hour one: a 10-minute boot at 2 cores, then 50 minutes at 0.1 core.
  w.state.boot = { ms: 10 * MIN, usec: 10 * 2 * CORE_USEC_PER_MIN };
  await w.supervisor.requestHandoff();
  assert.equal(w.logs.filter((l) => l.step === "serve.handoff_done").length, 1, "positive control: the handoff ran");
  w.state.now += 50 * MIN;
  w.state.usec += 50 * 0.1 * CORE_USEC_PER_MIN;
  w.ticks[0]!();
  const [row] = w.rows();
  assert.equal(row!.window_ms, 60 * MIN);
  assert.equal(row!.boot_ms, 10 * MIN);
  assert.equal(row!.usage_usec, (20 + 5) * CORE_USEC_PER_MIN);
  assert.equal(row!.steady_cores, 0.1, "the boot's 2 cores are not steady CPU (with it, 0.417)");
  assert.equal(row!.prev_steady_cores, null);
  assert.deepEqual((row!.top as Array<{ name: string }>).map((c) => c.name), ["node", "children", "libuv-worker"]);
  // Hour two carries hour one's reading.
  w.state.now += 60 * MIN;
  w.state.usec += 60 * 0.5 * CORE_USEC_PER_MIN;
  w.ticks[0]!();
  assert.equal(w.rows()[1]!.steady_cores, 0.5);
  assert.equal(w.rows()[1]!.prev_steady_cores, 0.1);
});

const at = (ms: number) => new Date(Date.parse("2026-11-17T00:00:00.000Z") + ms).toISOString();
const budgetRow = (hour: number, steady: number | null, prev: number | null) => ({
  ts: at(hour * 60 * MIN), step: SERVE_CPU_BUDGET_STEP, steady_cores: steady, prev_steady_cores: prev,
  top: [{ name: "node", cores: 0.9 }, { name: "children", cores: 0.4 }, { name: "libuv-worker", cores: 0.2 }, { name: "V8 Worker", cores: 0.1 }],
});
const fired = (rows: Record<string, unknown>[], hour: number) =>
  evaluateIncidentInvariants(rows, Date.parse(at(hour * 60 * MIN + MIN))).filter((f) => f.ruleId === SERVE_CPU_BUDGET_RULE_ID);

test("W1-T13441 criterion 3: serve.cpu_budget lists every named thread over the floor, not only the top three", async () => {
  // 1 core for the hour: views 0.54, main 0.36, then three more named threads and one under the floor.
  const w = world(false, [["rmd-rm-views", 0.54], ["MainThread", 0.36], ["rmd-board", 0.05], ["rmd-rm-txn-wrtr", 0.03], ["V8Worker", 0.018], ["rmd-plan-reload", 0.002]]);
  await w.supervisor.start();
  w.state.now += 60 * MIN;
  w.state.usec += 60 * CORE_USEC_PER_MIN;
  w.ticks[0]!();
  const row = w.rows().at(-1)!;
  assert.deepEqual((row.top as Array<{ name: string }>).map((c) => c.name), ["rmd-rm-views", "MainThread", "rmd-board"], "top stays three: the serve-cpu-budget rule reads it");
  assert.deepEqual(row.threads, [
    { name: "rmd-rm-views", cores: 0.54 }, { name: "MainThread", cores: 0.36 }, { name: "rmd-board", cores: 0.05 },
    { name: "rmd-rm-txn-wrtr", cores: 0.03 }, { name: "V8Worker", cores: 0.018 },
  ], "every thread at or over SERVE_CPU_BUDGET_THREAD_FLOOR_CORES, hottest first; rmd-plan-reload's 0.002 is under it");
});

test("W1-T13304 criterion 2: serve-cpu-budget fires on two hours in a row over budget and names the top three consumers", () => {
  assert.equal(SERVE_STEADY_CPU_BUDGET_CORES, 0.3);
  assert.equal(fired([budgetRow(1, 1.2, null)], 1).length, 0, "one hour over budget is not enough");
  assert.equal(fired([budgetRow(1, 0.2, null), budgetRow(2, 1.2, 0.2)], 2).length, 0, "the hour before was under budget");
  const findings = fired([budgetRow(1, 1.2, null), budgetRow(2, 1.1, 1.2)], 2);
  assert.equal(findings.length, 1, "positive control: two hours over budget fire");
  assert.match(findings[0]!.message, /node=0\.9, children=0\.4, libuv-worker=0\.2;?/);
  assert.doesNotMatch(findings[0]!.message, /V8 Worker/);
});

test("W1-T13304 criterion 3: an unreadable cgroup writes steady_cores null and never fires", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-cpu-budget-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(cgroupCpuUsageUsec(join(dir, "absent")), undefined, "a missing cpu.stat is unknown, not zero");
  writeFileSync(join(dir, "cpu.stat"), "usage_usec 1234\nuser_usec 1000\n");
  assert.equal(cgroupCpuUsageUsec(join(dir, "cpu.stat")), 1234, "positive control: a readable cpu.stat");
  const blind = world(true);
  await blind.supervisor.start();
  for (let hour = 0; hour < 2; hour += 1) {
    blind.state.now += 60 * MIN;
    blind.state.usec += 60 * 2 * CORE_USEC_PER_MIN;
    blind.ticks[0]!();
  }
  const rows = blind.rows();
  assert.deepEqual(rows.map((r) => [r.usage_usec, r.steady_cores]), [[null, null], [null, null]]);
  assert.equal(fired(rows.map((r, i) => ({ ...r, ts: at((i + 1) * 60 * MIN) })), 2).length, 0);
  assert.equal(fired([budgetRow(1, null, null), budgetRow(2, null, null)], 2).length, 0);
  mkdirSync(join(dir, "proc"));
  assert.equal(procCpuConsumers([999_999], join(dir, "proc")).size, 0, "a pid that is gone adds no consumer");
});
