import assert from "node:assert/strict";
import fs, { mkdirSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { daemonCommand, drainCommand } from "#src/run-task.js";
import type { Config } from "#src/lib/config.js";
import type { DaemonDeps } from "#src/lib/daemon.js";
import type { DrainDeps } from "#src/lib/drain.js";
import type { productionFixPressure } from "#src/lib/sweep.js";
import type { GitHub } from "#src/lib/status.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { ghShim } from "#test/helpers/gh-shim.js";

async function wired(t: TestContext, readQueuePressure?: typeof productionFixPressure) {
  const home = makeTempDir("queue-pressure-home"), root = join(home, "Remudero"), planPath = join(home, "tasks.yaml");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  const config = { root, claudeBin: "/bin/true" } as Config;
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify(config));
  writeFileSync(planPath, "[]\n");
  const shim = ghShim([{ when: "", exit: 1, stderr: "isolated queue-pressure fixture" }]);
  const oldHome = process.env.HOME, oldPath = process.env.PATH;
  process.env.HOME = home; process.env.PATH = shim.dir + ":" + oldPath;
  t.after(() => { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; });
  const github: GitHub = {
    prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined,
    listOpenHeadBranches: () => [{ number: 1, url: "https://github.com/fixture/remudero/pull/1", state: "OPEN", headRefName: "run-W1-T1-1000" }],
  };
  const pressure = readQueuePressure === undefined ? {} : { readQueuePressure };
  let drain: DrainDeps | undefined, daemon: DaemonDeps | undefined;
  assert.equal(await drainCommand([], { config, planPath, skipGitSync: true, githubFactory: () => github, ...pressure,
    notifyChannel: { send: () => true } as never, runDrain: async (_plan, deps) => { deps.refreshMerged(); drain = deps; return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, resumeCommand: "rmd drain" }; } }), 0);
  assert.equal(await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], { githubFactory: () => github, ...pressure,
    runDaemon: async (_plan, deps) => { deps.refreshMerged(); daemon = deps; return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 }; } }), 0);
  assert.ok(drain?.checkQueueGovernor); assert.ok(daemon?.checkQueueGovernor);
  return [drain.checkQueueGovernor, daemon.checkQueueGovernor];
}

function unreadableMeminfo(t: TestContext) {
  const original = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof original>) => {
    if (args[0] === "/proc/meminfo") { reads++; throw Object.assign(new Error("ENOENT: simulated missing /proc/meminfo"), { code: "ENOENT" }); }
    return Reflect.apply(original, fs, args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return () => reads;
}

test("W1-T7811: with /proc/meminfo unreadable the wired gates admit on an injected pressure reading", async (t) => {
  unreadableMeminfo(t);
  const gates = await wired(t, (floorMib) => ({ availableMib: 16_384, floorMib }));
  for (const gate of gates) assert.equal(gate(), undefined, "the fixture's healthy pressure, not the host, admits the one owned PR");
});

test("W1-T7811: with no injected reading an unreadable /proc/meminfo defers and names its reason", async (t) => {
  const reads = unreadableMeminfo(t);
  const gates = await wired(t);
  for (const gate of gates) { const result = gate(); assert.equal(result?.deferred, true); assert.match(result?.pressure?.reason ?? "", /host pressure unreadable.*ENOENT/); }
  assert.ok(reads() >= 2, "both unmodified production defaults really read the unavailable OS source");
});

test("W1-T7811: the wired gate reads host pressure only through its injected reader", async (t) => {
  unreadableMeminfo(t);
  const calls: Array<{ floorMib: number; ledgerPath: string }> = [];
  const gates = await wired(t, (floorMib, ledgerPath) => { calls.push({ floorMib, ledgerPath }); return { availableMib: 16_384, floorMib }; });
  for (const gate of gates) assert.equal(gate(), undefined);
  assert.equal(calls.length, 2, "each composition reaches the supplied pressure reader once");
  assert.ok(calls.every((call) => call.floorMib > 0 && call.ledgerPath.endsWith("ledger.ndjson")), "the reader receives the original policy floor and ledger identity");
});
