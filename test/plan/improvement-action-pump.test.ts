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

test("saved improvement actions start only through the daemon-owned handoff", async () => {
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

test("saved improvement production wiring reaches the fresh gateway from the daemon loop", async () => {
  const wire = (daemonCli as unknown as Record<string, unknown>).daemonImprovementActionDeps;
  assert.equal(typeof wire, "function", "the daemon CLI must supply the real saved-action discovery and handoff");
  const wired = (wire as (state: string, gateway: unknown) => { pendingImprovementActions(): AsyncIterable<ReturnType<typeof target>>; handOffImprovementAction(request: ReturnType<typeof target>): Promise<unknown> })("/fleet/state", { improvement: async (request: ReturnType<typeof target>) => { handed.push(request); return { outcome: "queued" }; } });
  const handed: ReturnType<typeof target>[] = [];
  const plan = loadPlanFromYaml("[]", "improvement-pump-fixture"); let stop = false, polls = 0;
  const loop = daemon.runDaemon(plan, { ...wired, pendingImprovementActions: async function* () { yield target("c"); }, refreshMerged: () => () => true,
    runOne: async () => { throw new Error("no build is part of a planning request"); }, checkStop: () => stop || ++polls > 50 ? "test complete" : undefined,
    sleep: async () => { await turn(); if (handed.length) stop = true; }, log: () => {} }, { pollIntervalMs: 1 });
  await loop; assert.deepEqual(handed, [target("c")]);
});


test("saved improvement daemon command supplies durable discovery and the owned handoff", async () => {
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
