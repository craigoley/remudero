// 2026-10-10, core host: the daemon's live set was 0.6-0.9 GB, but under the container's
// NODE_OPTIONS=--max-old-space-size=8192 V8 let garbage reach ~4x that before a major GC, so the
// process sat at 4.1-4.5 GB RSS plus 1-3 GB of swap. Every child inherited the same ceiling. The
// heap-pressure restart never fired: 75% of an 8.4 GB V8 limit is 6.3 GB of the main isolate alone.
// These tests pin the three mechanisms in src/lib/daemon-memory-policy.ts and their wiring.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { runDaemon, type DaemonDeps, type DaemonSummary } from "../src/lib/daemon.js";
import {
  DEFAULT_DAEMON_MEMORY_POLICY,
  TIGHTEST_HEAP_GROWING_PERCENT,
  applyDaemonMemoryPolicy,
  createDaemonMemoryGovernor,
  decideMemoryPressure,
  parseDaemonMemoryPolicy,
  readDaemonMemory,
  readDaemonMemoryPolicy,
  withoutHeapCeiling,
  type DaemonMemoryPolicy,
  type DaemonMemoryReading,
} from "../src/lib/daemon-memory-policy.js";
import { loadPlan } from "../src/lib/plan.js";
import { daemonCommand } from "../src/run-task.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const MB = 1048576;
const GB = 1024 * MB;
const HIGH = 8_786_018_304; // the core container's memory.high, read 2026-10-10

function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${label}-`));
}

test("the daemon entry applies the GC flags and wires the governor before its loop", async () => {
  const home = tempDir("daemon-memory-entry");
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const applied: DaemonMemoryPolicy[] = [];
  let captured: DaemonDeps | undefined;
  let appliedBeforeLoop = false;
  try {
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      applyMemoryPolicy: (policy) => {
        applied.push(policy);
        return { heap_growing_percent: policy.heapGrowingPercent, node_options_before: "--max-old-space-size=8192" };
      },
      runDaemon: async (_plan, deps): Promise<DaemonSummary> => {
        appliedBeforeLoop = applied.length === 1;
        captured = deps;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    assert.equal(code, 0);
    assert.deepEqual(applied, [readDaemonMemoryPolicy(join(REPO_ROOT, "plan", "policy.yaml")).policy], "applied once, from plan/policy.yaml");
    assert.equal(applied[0].heapGrowingPercent, 50);
    assert.ok(appliedBeforeLoop, "the flags are set before the loop starts");
    assert.equal(typeof captured?.memoryGovernor?.step, "function", "the loop gets the policy's governor");
    const rows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const boot = rows.find((r) => r.step === "daemon.memory_policy");
    assert.ok(boot, `a daemon.memory_policy row, saw ${rows.map((r) => r.step).join(",")}`);
    assert.equal(boot.heap_growing_percent, 50);
    assert.equal(boot.restart_share, 0.5);
    assert.equal(boot.node_options_before, "--max-old-space-size=8192");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("applyDaemonMemoryPolicy sets the growth flag and strips only the heap ceiling from the children's NODE_OPTIONS", () => {
  const flags: string[] = [];
  const env: NodeJS.ProcessEnv = { NODE_OPTIONS: "--max-old-space-size=8192 --enable-source-maps" };
  const result = applyDaemonMemoryPolicy({ ...DEFAULT_DAEMON_MEMORY_POLICY, heapGrowingPercent: 40 }, { setFlags: (f) => flags.push(f), env });
  assert.deepEqual(flags, ["--heap-growing-percent=40"]);
  assert.equal(env.NODE_OPTIONS, "--enable-source-maps");
  assert.deepEqual(result, { heap_growing_percent: 40, node_options_before: "--max-old-space-size=8192 --enable-source-maps", node_options_children: "--enable-source-maps" });

  const only: NodeJS.ProcessEnv = { NODE_OPTIONS: "--max-old-space-size=8192" };
  applyDaemonMemoryPolicy(DEFAULT_DAEMON_MEMORY_POLICY, { setFlags: () => {}, env: only });
  assert.equal("NODE_OPTIONS" in only, false, "an emptied NODE_OPTIONS is removed, not left blank");

  assert.equal(withoutHeapCeiling("--max_old_space_size=4096 --max-old-space-size 8192 --trace-warnings"), "--trace-warnings");
  assert.equal(withoutHeapCeiling(undefined), undefined);
});

test("a child spawned after the entry no longer carries the 8192 MB ceiling, while the daemon keeps its own", () => {
  const moduleUrl = pathToFileURL(join(REPO_ROOT, "src", "lib", "daemon-memory-policy.ts")).href;
  const script = [
    `import { getHeapStatistics } from "node:v8";`,
    `import { spawnSync } from "node:child_process";`,
    `import { applyDaemonMemoryPolicy, DEFAULT_DAEMON_MEMORY_POLICY } from ${JSON.stringify(moduleUrl)};`,
    `if (process.argv[1] === "apply") applyDaemonMemoryPolicy(DEFAULT_DAEMON_MEMORY_POLICY);`,
    `const child = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify({ options: process.env.NODE_OPTIONS ?? null, limit: require('node:v8').getHeapStatistics().heap_size_limit }))"], { encoding: "utf8" });`,
    `process.stdout.write(JSON.stringify({ self: getHeapStatistics().heap_size_limit, child: JSON.parse(child.stdout) }));`,
  ].join("\n");
  const { NODE_TEST_CONTEXT: _context, NODE_V8_COVERAGE: _coverage, NODE_OPTIONS: _options, ...env } = process.env;
  const run = (mode: string) => {
    const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, mode], {
      cwd: REPO_ROOT, encoding: "utf8", env: { ...env, NODE_OPTIONS: "--max-old-space-size=8192 --no-deprecation" },
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout) as { self: number; child: { options: string | null; limit: number } };
  };
  const control = run("control");
  assert.ok(control.child.limit >= 8192 * MB, `without the entry a child inherits the ceiling (${control.child.limit})`);
  const applied = run("apply");
  assert.ok(applied.self >= 8192 * MB, `the daemon keeps its own ceiling (${applied.self})`);
  assert.equal(applied.child.options, "--no-deprecation", "the child inherits every other NODE_OPTIONS word");
  assert.ok(applied.child.limit < 8192 * MB, `the child gets V8's own default (${applied.child.limit})`);
});

test("the pressure decision is RSS plus swap as a share of the container's memory.high, never V8's limit", () => {
  const p = DEFAULT_DAEMON_MEMORY_POLICY;
  // The same 3 GB process: pressure in an 8 GB container, none in a 20 GB one.
  assert.equal(decideMemoryPressure({ rss_bytes: 3 * GB, budget_bytes: 8 * GB, budget_source: "memory.high" }, p, 50).tier, "tighten");
  assert.equal(decideMemoryPressure({ rss_bytes: 3 * GB, budget_bytes: 20 * GB, budget_source: "memory.high" }, p, 50).tier, "clear");
  // Swap counts: 2 GB resident plus 2.5 GB swapped out is past the restart share of 8 GB.
  const swapped = decideMemoryPressure({ rss_bytes: 2 * GB, swap_bytes: 2.5 * GB, budget_bytes: 8 * GB, budget_source: "memory.high" }, p, 50);
  assert.equal(swapped.share, 4.5 / 8);
  assert.deepEqual([swapped.tier, swapped.heapGrowingPercent], ["tighten", TIGHTEST_HEAP_GROWING_PERCENT], "the tightest factor comes before any restart");
  const again = decideMemoryPressure({ rss_bytes: 2 * GB, swap_bytes: 2.5 * GB, budget_bytes: 8 * GB, budget_source: "memory.high" }, p, TIGHTEST_HEAP_GROWING_PERCENT);
  assert.equal(again.tier, "restart");
  assert.match(String(again.detail), /56% of the container's memory\.high 8192 MB/);
  // Unknown budget is not pressure, however large the process.
  assert.equal(decideMemoryPressure({ rss_bytes: 64 * GB }, p, TIGHTEST_HEAP_GROWING_PERCENT).tier, "clear");
  // Proportional inside the band: halfway between the shares is halfway between 50 and 10.
  assert.equal(decideMemoryPressure({ rss_bytes: 0.4 * HIGH, budget_bytes: HIGH, budget_source: "memory.high" }, p, 50).heapGrowingPercent, 30);
});

test("readDaemonMemory takes memory.high, falls back to memory.max, and reads VmSwap", () => {
  const dir = tempDir("daemon-memory-cgroup");
  try {
    const status = join(dir, "status");
    writeFileSync(status, "Name:\tnode\nVmRSS:\t4115300 kB\nVmSwap:\t  577768 kB\n");
    writeFileSync(join(dir, "memory.high"), `${HIGH}\n`);
    writeFileSync(join(dir, "memory.max"), "9248440320\n");
    const io = { cgroupRoot: dir, procStatusPath: status, rss: () => 4 * GB };
    assert.deepEqual(readDaemonMemory(io), { rss_bytes: 4 * GB, swap_bytes: 577768 * 1024, budget_bytes: HIGH, budget_source: "memory.high" });
    writeFileSync(join(dir, "memory.high"), "max\n");
    assert.equal(readDaemonMemory(io).budget_source, "memory.max");
    writeFileSync(join(dir, "memory.max"), "max\n");
    const none = readDaemonMemory({ ...io, procStatusPath: join(dir, "absent") });
    assert.deepEqual(none, { rss_bytes: 4 * GB }, "no budget and no swap are absent, never zero");
    assert.deepEqual(readDaemonMemory({ ...io, cgroupRoot: join(dir, "no-cgroup") }).budget_bytes, undefined, "an unreadable cgroup is no budget");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the governor tightens in proportion, backs off when the share falls, and restarts only past the tightest factor", () => {
  const shares = [0.2, 0.4, 0.2, 0.6, 0.6];
  const flags: string[] = [];
  let i = 0;
  const governor = createDaemonMemoryGovernor({
    read: () => ({ rss_bytes: shares[i++] * HIGH, budget_bytes: HIGH, budget_source: "memory.high" }),
    setFlags: (f) => flags.push(f),
  });
  const steps = shares.map(() => governor.step());
  assert.deepEqual(steps.map((s) => s.tier), ["clear", "tighten", "clear", "tighten", "restart"]);
  assert.deepEqual(steps.map((s) => s.changed), [false, true, true, true, true]);
  assert.deepEqual(flags, ["--heap-growing-percent=30", "--heap-growing-percent=50", "--heap-growing-percent=10"]);
});

test("parseDaemonMemoryPolicy defaults each row and refuses an out-of-bounds or inverted one", () => {
  assert.deepEqual(parseDaemonMemoryPolicy(undefined), DEFAULT_DAEMON_MEMORY_POLICY);
  assert.deepEqual(parseDaemonMemoryPolicy({ heapGrowingPercent: { value: 25, origin: "net-new" } }), { ...DEFAULT_DAEMON_MEMORY_POLICY, heapGrowingPercent: 25 });
  assert.throws(() => parseDaemonMemoryPolicy({ heapGrowingPercent: { value: 5 } }), /\[10, 300\]/);
  assert.throws(() => parseDaemonMemoryPolicy({ tightenShare: { value: 0.6 } }), /must be below restartShare/);
  assert.throws(() => parseDaemonMemoryPolicy([]), /must be a mapping/);
  assert.throws(() => parseDaemonMemoryPolicy({ restartShare: 0.5 }), /'daemonMemory.restartShare' must be a mapping/);
  const broken = readDaemonMemoryPolicy("/policy.yaml", () => "daemonMemory:\n  restartShare: 7\n");
  assert.deepEqual(broken.policy, DEFAULT_DAEMON_MEMORY_POLICY, "a malformed row boots on the defaults");
  assert.match(String(broken.error), /restartShare/);
});

test("the daemon loop drains and restarts on the cgroup share while V8's own limit is far away", async () => {
  const dir = tempDir("daemon-memory-loop");
  const planPath = join(dir, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const flags: string[] = [];
  let idles = 0;
  const reading: DaemonMemoryReading = { rss_bytes: 3.9 * GB, swap_bytes: 1.5 * GB, budget_bytes: HIGH, budget_source: "memory.high" };
  try {
    const summary = await runDaemon(loadPlan(planPath), {
      refreshMerged: () => () => false,
      runOne: async () => {
        throw new Error("an empty plan dispatches nothing");
      },
      sleep: async () => {
        if (++idles > 5) throw new Error("five idle ticks and no restart");
      },
      heapStatistics: () => ({ used_heap_size: 1.2 * GB, heap_size_limit: 8 * GB }),
      memoryGovernor: createDaemonMemoryGovernor({ read: () => reading, setFlags: (f) => flags.push(f) }),
      log: (step, extra = {}) => rows.push({ step, extra }),
    }, { pollIntervalMs: 1 });
    assert.equal(summary.stopReason, "heap_pressure");
    assert.match(String(summary.stopDetail), /of the container's memory\.high/);
    assert.deepEqual(flags, ["--heap-growing-percent=10"], "the tightest factor was tried first");
    const pressure = rows.filter((r) => r.step === "daemon.memory_pressure").map((r) => r.extra.tier);
    assert.deepEqual(pressure, ["tighten", "restart"]);
    const exit = rows.find((r) => r.step === "daemon.heap_pressure_exit");
    assert.equal(exit?.extra.basis, "cgroup_share");
    assert.equal(exit?.extra.budget_bytes, HIGH);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
