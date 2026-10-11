import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { REGISTERED_GARDEN_NAMES } from "../src/lib/garden-registry.js";
import { resolveSreLaneInstance, sreLaneDecision, sreLaneEnabled, sreLaneStartRow, type SreLaneInstance } from "../src/lib/sre-lane.js";
import * as runTask from "../src/run-task.js";

/**
 * W1-T8232 — the SRE lane starts on the registry's live `primary: true` instance with no env
 * opt-in, stays off elsewhere, `RMD_SRE_LANE=0` turns it off on the primary, and the daemon's start
 * ledgers which of those it decided. MEASURED 2026-10-11: the lane started only on
 * `RMD_SRE_LANE=1`, no container had it, and 284 incident events reached no reader.
 */

const PRIMARY: SreLaneInstance = { resolved: true, name: "core", live: true, primary: true };
const SECONDARY: SreLaneInstance = { resolved: true, name: "site", live: true, primary: false };

function registryText(root: string, primary: boolean): string {
  return [
    "instances:",
    "  core:",
    "    repo: remudero",
    "    github_repo: craigoley/remudero",
    `    primary: ${primary ? "true" : "false"}`,
    `    state_dir: ${root}`,
    "  site:",
    "    repo: remudero-site",
    "    github_repo: craigoley/remudero-site",
    `    primary: ${primary ? "false" : "true"}`,
    `    state_dir: ${root}-other`,
    "",
  ].join("\n");
}

interface DaemonStart {
  gardens: unknown[];
  laneRows: Array<Record<string, unknown>>;
}

/** Boot `rmd daemon` against a temp state root that the registry names as `core`, capture the
 *  gardens it hands the loop and the `sre_lane.*` rows it ledgered. */
async function startDaemon(t: TestContext, opts: { primary: boolean; sreEnv?: string }): Promise<DaemonStart> {
  const home = mkdtempSync(join(tmpdir(), "rmd-w1t8232-"));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const registryPath = join(home, "daemon-instances.yaml");
  writeFileSync(registryPath, registryText(root, opts.primary));
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const old = { HOME: process.env.HOME, RMD_SRE_LANE: process.env.RMD_SRE_LANE, RMD_INSTANCE_REGISTRY: process.env.RMD_INSTANCE_REGISTRY };
  process.env.HOME = home;
  process.env.RMD_INSTANCE_REGISTRY = registryPath;
  if (opts.sreEnv === undefined) delete process.env.RMD_SRE_LANE;
  else process.env.RMD_SRE_LANE = opts.sreEnv;
  t.after(() => {
    for (const [name, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });
  let gardens: unknown[] = [];
  await runTask.daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
    gardenPassSpawn: async () => 0,
    runDaemon: async (_plan, d) => {
      gardens = (d as { gardens?: unknown[] }).gardens ?? [];
      return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
    },
  } as Parameters<typeof runTask.daemonCommand>[1]);
  const laneRows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => typeof row.step === "string" && row.step.startsWith("sre_lane."));
  return { gardens, laneRows };
}

test("W1-T8232: the SRE lane starts on the primary instance with no env opt-in", async (t) => {
  assert.equal(sreLaneEnabled({ instance: PRIMARY, env: {} }), true);
  assert.deepEqual(sreLaneDecision({ instance: PRIMARY, env: {} }), { enabled: true, instance: "core", enabledBy: "primary" });
  const { gardens } = await startDaemon(t, { primary: true });
  assert.equal(gardens.length, REGISTERED_GARDEN_NAMES.length + 1, "the SRE starter is added after every registered garden");
  assert.equal(typeof gardens.at(-1), "function");
});

test("W1-T8232: the SRE lane stays off on a non-primary instance", async (t) => {
  assert.equal(sreLaneEnabled({ instance: SECONDARY, env: {} }), false);
  assert.equal(sreLaneEnabled({ instance: { ...PRIMARY, live: false }, env: {} }), false, "a retired row never runs it");
  assert.equal(sreLaneEnabled({ instance: { resolved: false, why: "no match" }, env: {} }), false, "an unresolvable instance is off");
  // `RMD_SRE_LANE=1` still turns it on anywhere, for existing hand setups.
  assert.deepEqual(sreLaneDecision({ instance: SECONDARY, env: { RMD_SRE_LANE: "1" } }), { enabled: true, instance: "site", enabledBy: "env" });
  const { gardens } = await startDaemon(t, { primary: false });
  assert.equal(gardens.length, REGISTERED_GARDEN_NAMES.length, "no SRE starter on a non-primary instance");
});

test("W1-T8232: RMD_SRE_LANE=0 keeps it off on the primary", async (t) => {
  assert.equal(sreLaneEnabled({ instance: PRIMARY, env: { RMD_SRE_LANE: "0" } }), false);
  const { gardens, laneRows } = await startDaemon(t, { primary: true, sreEnv: "0" });
  assert.equal(gardens.length, REGISTERED_GARDEN_NAMES.length, "the explicit off wins over primary");
  assert.equal(laneRows.length, 1);
  assert.equal(laneRows[0].step, "sre_lane.disabled");
  assert.equal(laneRows[0].instance, "core");
  assert.match(String(laneRows[0].reason), /RMD_SRE_LANE=0/);
});

test("W1-T8232: the lane ledgers whether it started", async (t) => {
  const started = await startDaemon(t, { primary: true });
  assert.deepEqual(
    started.laneRows.map((row) => ({ step: row.step, instance: row.instance, enabled_by: row.enabled_by })),
    [{ step: "sre_lane.started", instance: "core", enabled_by: "primary" }],
  );
  const off = await startDaemon(t, { primary: false });
  assert.equal(off.laneRows.length, 1);
  assert.equal(off.laneRows[0].step, "sre_lane.disabled");
  assert.equal(off.laneRows[0].instance, "core");
  assert.match(String(off.laneRows[0].reason), /not the registry's primary instance/);
  // An unresolvable instance is off AND the row says why.
  const unresolved = resolveSreLaneInstance({ stateRoot: "/nowhere", registryPath: "/nowhere/daemon-instances.yaml", readText: () => registryText("/elsewhere", true) });
  assert.equal(unresolved.resolved, false);
  const row = sreLaneStartRow({ instance: unresolved, env: {} });
  assert.equal(row.step, "sre_lane.disabled");
  assert.match(String(row.fields.reason), /state root \/nowhere is not exactly one instance's state_dir/);
});
