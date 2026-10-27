import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as daemon from "#src/lib/daemon.js";
import * as daemonCli from "#src/cli/commands/daemon.js";
import { loadPlanFromYaml } from "#src/lib/plan.js";
import { withTempDir } from "#src/lib/tmp.js";
import { daemonCommand } from "#test/helpers/run-task-daemon.js";

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const target = (id: string) => ({ operationId: id.repeat(64), stateDir: "/fleet/state", repoRoot: "/repos/atlas" });
function pumpFunction() {
  const fn = (daemon as unknown as Record<string, unknown>).startImprovementActionPump;
  assert.equal(typeof fn, "function", "saved requests need the real daemon action pump");
  return fn as (deps: { pendingImprovementActions: () => AsyncIterable<ReturnType<typeof target>>; handOffImprovementAction: (request: ReturnType<typeof target>) => Promise<unknown>; checkStop?: () => string | undefined; checkPause?: () => string | undefined }, interval: number, log: (step: string) => void) => { stop(): void; settled(): Promise<void>; isBusy(): boolean };
}

test("saved improvement pump preserves one active handoff during shutdown", async () => {
  const start = pumpFunction();
  let release!: () => void, active = 0, peak = 0, stopped = false;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const starts: string[] = [];
  const deps = {
    pendingImprovementActions: async function* () { yield target("a"); yield target("b"); },
    handOffImprovementAction: async (request: ReturnType<typeof target>) => { starts.push(request.operationId); active++; peak = Math.max(peak, active); await barrier; active--; },
  };
  const p = start(deps, 5, () => {});
  try {
    for (let i = 0; i < 100 && !starts.length; i++) await turn();
    assert.deepEqual(starts, [target("a").operationId]); assert.equal(p.isBusy(), true);
    p.stop(); stopped = true; release(); await p.settled();
    assert.equal(peak, 1); assert.equal(active, 0); assert.deepEqual(starts, [target("a").operationId], "stopping never starts the next operation or kills the active handoff");
  } finally { if (!stopped) p.stop(); release(); await p.settled(); }

});

test("saved improvement pump preserves pause stop and unreadable discovery", async () => {
  const start = pumpFunction(), lines: string[] = [];
  let paused: string | undefined = "hold", reads = 0, starts = 0;
  const p = start({ checkPause: () => paused, pendingImprovementActions: async function* () { reads++; throw new Error("directory unreadable"); }, handOffImprovementAction: async () => { starts++; } }, 5, step => lines.push(step));
  await turn(); assert.equal(reads, 0); paused = undefined;
  for (let i = 0; i < 100 && !reads; i++) await new Promise(resolve => setTimeout(resolve, 1));
  p.stop(); await p.settled(); assert(reads > 0); assert.equal(starts, 0); assert(lines.includes("improvement.action_read_failed"));
  const stop = start({ checkStop: () => "stopped", pendingImprovementActions: async function* () { assert.fail("STOP must not open the queue"); }, handOffImprovementAction: async () => assert.fail("STOP must not hand off") }, 5, () => {});
  stop.stop(); await stop.settled();
});

test("saved improvement actions start only through the daemon-owned handoff: daemon loop", async () => {
  const wire = (daemonCli as unknown as Record<string, unknown>).daemonImprovementActionDeps;
  assert.equal(typeof wire, "function", "the daemon CLI must supply the real saved-action discovery and handoff");
  let queued = true;
  const wired = (wire as (state: string, gateway: unknown) => { pendingImprovementActions(): AsyncIterable<ReturnType<typeof target>>; handOffImprovementAction(request: ReturnType<typeof target>): Promise<unknown> })("/fleet/state", { improvement: async (request: ReturnType<typeof target>) => { handed.push(request); queued = false; return { outcome: "queued" }; } });
  const handed: ReturnType<typeof target>[] = [];
  const plan = loadPlanFromYaml("[]", "improvement-pump-fixture"); let stop = false, polls = 0;
  const loop = daemon.runDaemon(plan, { ...wired, pendingImprovementActions: async function* () { if (queued) yield target("c"); }, refreshMerged: () => () => true,
    runOne: async () => { throw new Error("no build is part of a planning request"); }, checkStop: () => stop || ++polls > 50 ? "test complete" : undefined,
    sleep: async () => { await turn(); if (handed.length) stop = true; }, log: () => {} }, { pollIntervalMs: 1 });
  await loop; assert.deepEqual(handed, [target("c")]);
});


test("saved improvement pump names its active handoff and starts no second target after stop", async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const starts: string[] = [], steps: string[] = [];
  const p = daemon.startImprovementActionPump({
    pendingImprovementActions: async function* () { yield target("d"); yield target("e"); },
    handOffImprovementAction: async (request: ReturnType<typeof target>) => { starts.push(request.operationId); await barrier; },
  }, 5, step => steps.push(step));
  try {
    for (let i = 0; i < 100 && !starts.length; i++) await turn();
    assert.equal(p.activeOperation(), target("d").operationId, "the running handoff is named while it runs");
    p.stop();
    for (let i = 0; i < 20; i++) await turn();
    assert.equal(p.isBusy(), true, "stop never interrupts the active handoff");
    release(); await p.settled();
    assert.deepEqual(starts, [target("d").operationId], "stop refuses the second target");
    assert.equal(p.activeOperation(), undefined);
    assert.deepEqual(steps, ["improvement.action_started", "improvement.action_handoff_settled"]);
  } finally { p.stop(); release(); await p.settled(); }
});

test("saved improvement pump logs a failed handoff, clears it, and goes on to the next target", async () => {
  const starts: string[] = [], rows: { step: string; extra?: Record<string, unknown> }[] = [];
  const p = daemon.startImprovementActionPump({
    pendingImprovementActions: async function* () { yield target("i"); yield target("j"); },
    handOffImprovementAction: async (request: ReturnType<typeof target>) => {
      starts.push(request.operationId);
      if (request.operationId === target("i").operationId) throw new Error("gateway refused");
      return { outcome: "drafted" };
    },
  }, 5, (step, extra) => rows.push({ step, extra }));
  try {
    for (let i = 0; i < 100 && starts.length < 2; i++) await turn();
    p.stop(); await p.settled();
    assert.deepEqual(starts.slice(0, 2), [target("i").operationId, target("j").operationId], "a failed handoff never stops the pass");
    assert.deepEqual(rows.slice(0, 4).map(r => r.step), [
      "improvement.action_started", "improvement.action_handoff_failed", "improvement.action_started", "improvement.action_handoff_settled",
    ]);
    assert.deepEqual(rows[1]!.extra, { operation_id: target("i").operationId, error: "Error: gateway refused" });
    assert.equal(p.activeOperation(), undefined, "the failed handoff is no longer named active");
  } finally { p.stop(); await p.settled(); }
});

type Row = { step: string; fields: Record<string, unknown> };
async function until(done: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert(done(), what);
}
/** The real runDaemon with one saved action; STOP is raised once the pump has reached `stopWhen`. */
function stoppingDaemon(saved: { pendingImprovementActions: () => AsyncIterable<ReturnType<typeof target>>; handOffImprovementAction: (request: ReturnType<typeof target>) => Promise<unknown> }, stopWhen: () => boolean, opts: daemon.DaemonOpts = {}) {
  const rows: Row[] = [];
  const state = { returned: false };
  const loop = daemon.runDaemon(loadPlanFromYaml("[]", "improvement-stop-fixture"), {
    ...saved, refreshMerged: () => () => true,
    runOne: async () => { throw new Error("no build is part of a planning request"); },
    checkStop: () => stopWhen() ? "operator stop" : undefined,
    sleep: async () => { await turn(); }, log: (step, fields = {}) => { rows.push({ step, fields }); },
  }, { pollIntervalMs: 1, ...opts }).then(result => { state.returned = true; return result; });
  return { loop, rows, state };
}

test("saved improvement actions start only through the daemon-owned handoff: a daemon stop waits for the active handoff", async () => {
  let release!: () => void, started = false, finished = false;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const { loop, rows, state } = stoppingDaemon({
    pendingImprovementActions: async function* () { yield target("f"); },
    handOffImprovementAction: async () => { started = true; await barrier; finished = true; return { outcome: "drafted" }; },
  }, () => started);
  try {
    await until(() => rows.some(r => r.step === "daemon.stop"), "STOP was not observed after the handoff started");
    for (let i = 0; i < 25; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(state.returned, false, "runDaemon must not report stopped while its owned handoff is active");
    assert.equal(rows.some(r => r.step === "daemon.summary"), false);
    release();
    const result = await loop;
    assert.equal(result.stopReason, "stopped"); assert.equal(result.stopDetail, "operator stop"); assert.equal(finished, true);
    const settled = rows.findIndex(r => r.step === "improvement.action_handoff_settled");
    assert(settled >= 0, "the active handoff's settlement is logged");
    assert.equal(rows[settled]!.fields.operation_id, target("f").operationId);
    assert(settled < rows.findIndex(r => r.step === "daemon.summary"), "the handoff settles before the exit summary");
    assert.equal(rows.some(r => r.step === "improvement.action_handoff_abandoned" || r.step === "daemon.stop_drain.completed"), false);
  } finally { release(); await loop; }
});

test("saved improvement actions start only through the daemon-owned handoff: the stop bound names an abandoned handoff", async () => {
  let release!: () => void, started = false;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const { loop, rows } = stoppingDaemon({
    pendingImprovementActions: async function* () { yield target("g"); },
    handOffImprovementAction: async () => { started = true; await barrier; },
  }, () => started, { sweepWallClockBoundMs: 20 });
  try {
    const result = await loop;
    assert.equal(result.stopReason, "stopped");
    assert.equal(result.stopDetail, `operator stop; improvement handoff ${target("g").operationId} still running at the 20 ms stop bound`);
    const abandoned = rows.find(r => r.step === "improvement.action_handoff_abandoned");
    assert.deepEqual(abandoned?.fields, { operation_id: target("g").operationId, phase: "handoff", bound_ms: 20 });
    assert.deepEqual(rows.find(r => r.step === "daemon.stop_drain.completed")?.fields, {
      abandoned_in_flight_reviews: 0, bound_ms: 20, abandoned_improvement_pass: { operation_id: target("g").operationId, phase: "handoff" },
    });
    assert.equal(rows.some(r => r.step === "improvement.action_handoff_settled"), false, "an abandoned handoff is never claimed settled");
  } finally { release(); await loop; }
});

test("saved improvement actions start only through the daemon-owned handoff: the stop bound names an unfinished queue read", async () => {
  let release!: () => void, reading = false, handed = 0;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const { loop, rows } = stoppingDaemon({
    pendingImprovementActions: async function* () { reading = true; await barrier; yield target("h"); },
    handOffImprovementAction: async () => { handed++; },
  }, () => reading, { sweepWallClockBoundMs: 20 });
  try {
    const result = await loop;
    assert.equal(result.stopDetail, "operator stop; improvement saved-action queue read still running at the 20 ms stop bound");
    assert.deepEqual(rows.find(r => r.step === "improvement.action_handoff_abandoned")?.fields, { operation_id: null, phase: "discovery", bound_ms: 20 });
    release(); for (let i = 0; i < 20; i++) await turn();
    assert.equal(handed, 0, "a stopped pump starts no handoff once its queue read returns");
  } finally { release(); await loop; }
});

test("saved improvement actions start only through the daemon-owned handoff: command wiring", async () => {
  await withTempDir("improvement-command-wiring", async home => {
    const root = join(home, "Remudero"), planPath = join(home, "tasks.yaml");
    mkdirSync(join(home, ".config", "remudero"), { recursive: true }); mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ root, claudeBin: "/bin/true" }));
    writeFileSync(planPath, "[]\n");
    const oldHome = process.env.HOME; process.env.HOME = home;
    let captured: daemon.DaemonDeps | undefined;
    try {
      const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
        daemonBoot: async () => ({ env_clean: true, billing_mode: "subscription", node_path: process.execPath, node_version: process.version }),
        runDaemon: async (_plan, deps) => { captured = deps; return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 }; },
      });
      assert.equal(code, 0); assert(captured);
      assert.equal(typeof captured.pendingImprovementActions, "function", "the real command must wire restart discovery");
      assert.equal(typeof captured.handOffImprovementAction, "function", "the real command must wire the fresh gateway");
      const pending = []; for await (const row of captured.pendingImprovementActions!()) pending.push(row);
      assert.deepEqual(pending, [], "a fresh fixture store has no saved operations");
    } finally { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; }
  });
});
