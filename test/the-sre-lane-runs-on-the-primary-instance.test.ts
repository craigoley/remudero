import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";

import { daemonInstanceRegistryPath } from "#src/lib/deployer.js";
import { makeTempDir } from "#src/lib/tmp.js";
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
  // W1-T9500: `env: {}` — a fleet container carries RMD_INSTANCE_NAME=core, which would resolve it.
  const unresolved = resolveSreLaneInstance({ stateRoot: "/nowhere", registryPath: "/nowhere/daemon-instances.yaml", readText: () => registryText("/elsewhere", true), env: {} });
  assert.equal(unresolved.resolved, false);
  const row = sreLaneStartRow({ instance: unresolved, env: {} });
  assert.equal(row.step, "sre_lane.disabled");
  assert.match(String(row.fields.reason), /state root \/nowhere is not exactly one instance's state_dir/);
});

test("W1-T8232: an unreadable registry disables the lane with the read error", () => {
  const registryPath = "/fixture/daemon-instances.yaml";
  const instance = resolveSreLaneInstance({
    stateRoot: "/fixture/core",
    registryPath,
    readText: (path) => {
      assert.equal(path, registryPath);
      throw new Error("registry read denied");
    },
  });
  const reason = `the instance registry ${registryPath} is unreadable: registry read denied`;
  assert.deepEqual(instance, { resolved: false, why: reason });
  assert.equal(sreLaneEnabled({ instance, env: {} }), false);
  assert.deepEqual(sreLaneStartRow({ instance, env: {} }), {
    step: "sre_lane.disabled",
    fields: { instance: null, reason },
  });
});

test("W1-T8232: a refused registry disables the lane with the parser error", (t) => {
  const home = mkdtempSync(join(tmpdir(), "rmd-w1t8232-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, "core");
  const registryPath = join(home, "daemon-instances.yaml");
  writeFileSync(registryPath, registryText(root, true).replace("primary: true", "primary: invalid"));
  const instance = resolveSreLaneInstance({ stateRoot: root, registryPath });
  const reason = `the instance registry ${registryPath} is refused: ` +
    "instance registry invalid_primary: instance 'core' primary must be true or false";
  assert.deepEqual(instance, { resolved: false, why: reason });
  assert.equal(sreLaneEnabled({ instance, env: {} }), false);
  assert.deepEqual(sreLaneStartRow({ instance, env: {} }), {
    step: "sre_lane.disabled",
    fields: { instance: null, reason },
  });
});

test("selected lifecycle shadow reaches actual deploy pause and daemon consumers: CLI composition", async t => {
  const root = makeTempDir("selected-lifecycle-cli"), stateRoot = join(root, "owner");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const registry = daemonInstanceRegistryPath(root), selected = join(root, "selected.yaml");
  const text = `instances:\n  owner:\n    github_repo: fixture/owner\n    primary: true\n    state_dir: ${stateRoot}\n    container_name: owner-container\n  other:\n    github_repo: fixture/other\n    state_dir: ${join(root, "other")}\n`;
  mkdirSync(dirname(registry), { recursive: true });
  mkdirSync(join(stateRoot, "state"), { recursive: true });
  mkdirSync(join(root, "other", "state"), { recursive: true });
  writeFileSync(registry, text); writeFileSync(selected, text);
  const home = join(root, "cli-home"), configDir = join(home, ".config", "remudero");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ root: stateRoot, claudeBin: "/bin/true",
    selectedRegistryMode: { mode: "shadow", registryPath: selected } }));
  const saved = { HOME: process.env.HOME, RMD_INSTANCE_REGISTRY: process.env.RMD_INSTANCE_REGISTRY,
    RMD_INSTANCE_NAME: process.env.RMD_INSTANCE_NAME }, savedArgv = process.argv;
  process.env.HOME = home; process.env.RMD_INSTANCE_REGISTRY = registry; process.env.RMD_INSTANCE_NAME = "owner";
  const exit = new Error("fixture CLI exit");
  const exitMock = t.mock.method(process, "exit", ((code: number) => { assert.equal(code, 0); throw exit; }) as never);
  try {
    for (const verb of ["pause", "resume"]) {
      process.argv = [process.execPath, "run-task.js", verb];
      await assert.rejects(runTask.main({ checkFreshness: () => ({ status: "guarded" }) }), error => error === exit);
    }
    const plan = join(root, "tasks.yaml");
    writeFileSync(plan, "[]\n");
    process.argv = [process.execPath, "run-task.js", "daemon", "--allow-self-target", "--plan", plan, "--max", "0"];
    await assert.rejects(runTask.main({ checkServiceFreshness: () => ({ status: "guarded" }),
      dispatch: async (_verb, rest) => runTask.daemonCommand(rest, {
        gardenPassSpawn: async () => 0,
        runDaemon: async () => ({ attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 }),
      }),
    }), error => error === exit);
    const receipts = readFileSync(join(stateRoot, "state", "ledger.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    for (const action of ["pause", "resume", "sre-target"]) {
      assert.ok(receipts.some(row => row.action === action && row.target_instance === "owner"
        && row.selected_state === "unknown" && row.publication_permission === "not-granted"));
    }
  } finally {
    exitMock.mock.restore(); process.argv = savedArgv;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
