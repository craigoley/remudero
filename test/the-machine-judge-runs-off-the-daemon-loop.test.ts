import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DaemonDeps, DaemonSummary } from "../src/lib/daemon.js";
import * as registry from "../src/lib/garden-registry.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import * as runTask from "../src/run-task.js";

// W1-T5361. MEASURED 2026-10-02: the machine-filing judge was the one gardener still started in-process.
// Its synchronous git fetch, worktree add and commit held the daemon's thread for 85-241 s per failed
// pass, and every daemon.loop_lag row after 20:05Z followed a machine_judge.failed within seconds.

const JUDGE = "machine-judge";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function rows() {
  const out: Array<{ step: string; extra: Record<string, unknown> }> = [];
  return { out, log: (step: string, extra: Record<string, unknown> = {}) => void out.push({ step, extra }) };
}

test("W1-T5361: the daemon starts no in-process machine-filing judge; the judge is a garden child that ledgers garden.pass", async (t) => {
  // Checked first, so a tree without the registered judge never starts a single garden below.
  assert.equal(registry.isRegisteredGardenName(JUDGE), true, "the judge is a registered garden");
  const names = registry.REGISTERED_GARDEN_NAMES as readonly string[];
  assert.equal(names.indexOf(JUDGE), names.indexOf("hot-file") - 1, "it keeps the slot the in-process starter held, just before hot-file");
  const schedule = registry.gardenSchedule(JUDGE as registry.RegisteredGardenName);
  assert.equal(schedule.intervalFor(60_000), 60_000, "the judge keeps the daemon's poll interval");
  assert.equal(schedule.minIntervalMs, 0);
  assert.equal(schedule.hourly, false);

  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}machine-judge-offloop-`));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const oldHome = process.env.HOME;
  const oldSre = process.env.RMD_SRE_LANE;
  process.env.HOME = home;
  delete process.env.RMD_SRE_LANE;
  const started: Array<{ stop: () => void }> = [];
  t.after(() => {
    for (const s of started) s.stop();
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldSre !== undefined) process.env.RMD_SRE_LANE = oldSre;
    rmSync(home, { recursive: true, force: true });
  });

  const spawned: string[] = [];
  const recordingSpawn: registry.GardenPassSpawn = async (name) => (spawned.push(name), 0);
  let captured: DaemonDeps | undefined;
  await runTask.daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
    gardenPassSpawn: recordingSpawn,
    runDaemon: async (_plan, d): Promise<DaemonSummary> => {
      captured = d;
      return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
    },
  } as Parameters<typeof runTask.daemonCommand>[1]);

  // One starter per registered garden and nothing else: no spliced in-process judge starter.
  const gardens = captured?.gardens ?? [];
  assert.equal(gardens.length, names.length, "the daemon's gardens list is exactly the registry");
  for (const start of gardens) started.push(start(60 * 60 * 1000));
  for (let waited = 0; spawned.length < names.length && waited < 5_000; waited += 10) await wait(10);
  assert.deepEqual([...spawned].sort(), [...names].sort(), "every garden, the judge included, runs through the garden spawn");

  const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const judgePass = ledger.find((r) => r.step === registry.GARDEN_PASS_STEP && r.name === JUDGE);
  assert.ok(judgePass, "the judge's pass is ledgered as garden.pass under its own name");
  assert.equal(judgePass.exit, 0);
});

test("W1-T5361: a machine-judge child pass that throws still ledgers machine_judge.failed", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}machine-judge-failed-`));
  const bare = join(root, "not-a-repo");
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(bare, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { out, log } = rows();
  const ctx: runTask.GardenBuildContext = {
    config: { claudeBin: "/bin/true", root } as runTask.GardenBuildContext["config"],
    repoRoot: bare,
    owner: "acme",
    repo: "remudero",
    log,
    raiseDuplicate: () => "",
  };
  // The child's whole job (`rmd garden run machine-judge`): build the pass and run it once. A checkout with
  // no plan makes the judge throw on its first read; the pass records it and the child still exits 0.
  assert.equal(await runTask.runRegisteredGardenPass(JUDGE as registry.RegisteredGardenName, [], ctx), 0);
  const failed = out.filter((r) => r.step === "machine_judge.failed");
  assert.equal(failed.length, 1, `machine_judge.failed is ledgered (saw ${out.map((r) => r.step).join(", ")})`);
  assert.match(String(failed[0]!.extra.error), /\S/);
});

test("W1-T5361: a slow, failing judge child never blocks the parent's event loop", async (t) => {
  assert.equal(registry.isRegisteredGardenName(JUDGE), true, "the judge is a registered garden");
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}machine-judge-busy-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A judge pass that holds its own thread for a second (a synchronous git fetch on a loaded host),
  // then fails, and records the argv it was started with.
  const argvFile = join(dir, "argv.json");
  const busy = join(dir, "busy-judge.mjs");
  writeFileSync(
    busy,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\nconst end = performance.now() + 1000; while (performance.now() < end) {}\nprocess.exit(1);\n`,
  );
  const spawnPass = registry.childGardenPassSpawn({ execPath: process.execPath, execArgv: [], entry: busy });
  const { out, log } = rows();
  const events: string[] = [];
  const timer = setTimeout(() => events.push("loop-timer"), 50);
  const garden = registry.startGardenOffLoop(JUDGE as registry.RegisteredGardenName, 60 * 60 * 1000, {
    spawnPass: (name, args, signal) => spawnPass(name, args, signal).then((exit) => (events.push("pass-exit"), exit)),
    log,
  });
  t.after(() => { clearTimeout(timer); garden.stop(); });
  for (let waited = 0; !out.some((r) => r.step === registry.GARDEN_PASS_STEP) && waited < 20_000; waited += 25) await wait(25);
  assert.deepEqual(events, ["loop-timer", "pass-exit"], "the parent's own timer fired while the judge child was still running");
  assert.deepEqual(JSON.parse(readFileSync(argvFile, "utf8")), ["garden", "run", JUDGE]);
  const pass = out.find((r) => r.step === registry.GARDEN_PASS_STEP)!;
  assert.equal(pass.extra.name, JUDGE);
  assert.equal(pass.extra.exit, 1, "the failed child is recorded with its exit code");
});
