import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clockFromMillisFn } from "../src/lib/clock.js";
import type { DaemonDeps, DaemonSummary } from "../src/lib/daemon.js";
import type { GardenerRuntimeEvent } from "../src/lib/gardener-runtime.js";
import {
  boundedGardenPassSpawn,
  childGardenPassSpawn,
  GARDEN_HOURLY_FLAG,
  GARDEN_PASS_STEP,
  gardenSchedule,
  isRegisteredGardenName,
  REGISTERED_GARDEN_NAMES,
  startGardenOffLoop,
  type GardenPassSpawn,
} from "../src/lib/garden-registry.js";
import { HOST_RESOURCE_MIN_INTERVAL_MS } from "../src/lib/host-resource-gardener.js";
import { OVERSEER_MIN_INTERVAL_MS } from "../src/lib/gardener-overseer.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { buildRegisteredGarden, daemonCommand, gardenCommand, runRegisteredGardenPass, type GardenBuildContext } from "../src/run-task.js";
import { fakeGitHub } from "./helpers/fake-github.js";

// MEASURED 2026-10-01: eleven daemon ticks spent 4,344 s reaching admission; ~1,620 s of the silent-loop gaps ended
// in a gardener's scorecard, because every garden starter ran its synchronous pass on the daemon's event loop.

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function invokeGardenerRoute(route: import("../src/lib/service.js").Route) {
  let status = 0, body = "";
  const res = { writeHead(code: number) { status = code; }, end(value: string) { body = value; } };
  await route.handler({} as never, res as never, { params: {} });
  return { status, body: JSON.parse(body) };
}

test("gardener runtime projects only known fields at persistence and the read boundary", async (t) => {
  const { createGardenerRuntimeWriter, readGardenerRuntime, parseGardenerRuntime, GARDENER_RUNTIME_FILE } =
    await import("../src/lib/gardener-runtime.js");
  const { buildGardenersRoute } = await import("../src/lib/gardeners-route.js");
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gardener-projection-`));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const stamp = "2026-10-07T12:00:00.000Z", clock = clockFromMillisFn(() => Date.parse(stamp));
  const inventory = [{ name: "plan", enabled: true, cadenceMs: 60_000, scope: "repository" as const }];
  const writer = createGardenerRuntimeWriter({ stateDir, repository: "acme/app", daemonRunId: "boot", clock,
    gardens: inventory, log: () => {} });
  await writer.flush();
  const expected = await readGardenerRuntime(stateDir);
  const raw = { ...expected, internalNotes: "private-root",
    gardens: expected.gardens.map((garden) => ({ ...garden, internalNotes: "private-entry" })) };
  assert.deepEqual(parseGardenerRuntime(raw), expected);
  writeFileSync(join(stateDir, GARDENER_RUNTIME_FILE), JSON.stringify(raw));
  assert.deepEqual(await readGardenerRuntime(stateDir), expected);
  // A port is not permission to forward its untrusted fields, either.
  const result = await invokeGardenerRoute(buildGardenersRoute({ stateDir, clock, read: async () => raw }));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ...expected, generatedAt: stamp, coverage: "registered-off-loop",
    counterWindow: "daemon-run", outcomeAssessment: "not_collected", spend: null });
  const extraInventory = inventory.map((garden) => ({ ...garden, internalNotes: "not-persisted" }));
  const projectedWriter = createGardenerRuntimeWriter({ stateDir, repository: "acme/app", daemonRunId: "boot", clock,
    gardens: extraInventory, log: () => {} });
  await projectedWriter.flush();
  assert.deepEqual(JSON.parse(readFileSync(join(stateDir, GARDENER_RUNTIME_FILE), "utf8")), expected);
});

test("gardener runtime refuses array enum coercion at the parse and route boundaries", async (t) => {
  const { createGardenerRuntimeWriter, readGardenerRuntime, parseGardenerRuntime } = await import("../src/lib/gardener-runtime.js");
  const { buildGardenersRoute } = await import("../src/lib/gardeners-route.js");
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gardener-enum-`));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const clock = clockFromMillisFn(() => Date.parse("2026-10-07T12:00:00.000Z"));
  const writer = createGardenerRuntimeWriter({ stateDir, repository: "acme/app", daemonRunId: "boot", clock,
    gardens: [{ name: "plan", enabled: true, cadenceMs: 60_000, scope: "repository" }], log: () => {} });
  await writer.flush();
  const expected = await readGardenerRuntime(stateDir);
  for (const field of ["scope", "phase", "reason"] as const) {
    const raw = structuredClone(expected);
    Object.assign(raw.gardens[0]!, { [field]: [raw.gardens[0]![field]] });
    assert.throws(() => parseGardenerRuntime(raw), /malformed/);
    assert.deepEqual(await invokeGardenerRoute(buildGardenersRoute({ stateDir, clock, read: async () => raw })),
      { status: 503, body: { error: "gardeners_unavailable", reason: "unreadable" } });
  }
});

test("gardener lifecycle measures admission separately from execution and preserves interruption", async (t) => {
  const start = Date.parse("2026-10-07T12:00:00Z");
  let now = start;
  const observed: GardenerRuntimeEvent[] = [];
  const releases: Array<(exit: number | null) => void> = [];
  const spawn = boundedGardenPassSpawn(() => new Promise<number | null>((resolve) => releases.push(resolve)), 1);
  const wiring = { spawnPass: spawn, log: () => {}, clock: clockFromMillisFn(() => now), observe: (row: GardenerRuntimeEvent) => observed.push(row) };
  const a = startGardenOffLoop("plan", 60_000, wiring), b = startGardenOffLoop("gate", 60_000, wiring);
  t.after(() => { a.stop(); b.stop(); });
  await wait(0); now += 100; releases[0]!(0); await wait(0);
  now += 200; releases[1]!(null); await wait(0);
  const plan = observed.find((r) => r.name === "plan" && r.phase === "completed");
  const gate = observed.find((r) => r.name === "gate" && r.phase === "cancelled");
  assert.ok(plan, "the producer records the completed process");
  assert.ok(gate, "an interrupted process has a separate outcome");
  assert.equal(plan.queueMs, 0); assert.equal(plan.executionMs, 100);
  assert.equal(plan.nextDueAt, new Date(start + 60_000).toISOString());
  assert.equal(gate.queueMs, 100); assert.equal(gate.executionMs, 200);
  assert.equal(gate.reason, "signal-or-cancelled");
  assert.ok(observed.some((r) => r.name === "gate" && r.phase === "running"));
});

test("gardener lifecycle reports idle and spawn failures while an observer cannot break a pass", async (t) => {
  const observed: GardenerRuntimeEvent[] = [], logs: string[] = [];
  const idle = startGardenOffLoop("plan", 60_000, { log: () => {}, due: () => false,
    spawnPass: async () => { throw new Error("idle cannot spawn"); }, observe: (r) => observed.push(r) });
  const fail = startGardenOffLoop("gate", 60_000, { log: () => {}, spawnPass: () => { throw new Error("spawn refused"); },
    observe: (r) => observed.push(r) });
  const safe = startGardenOffLoop("config", 60_000, { log: (s) => logs.push(s), spawnPass: async () => 0,
    observe: () => { throw new Error("telemetry unavailable"); } });
  t.after(() => { idle.stop(); fail.stop(); safe.stop(); }); await wait(0);
  assert.equal(observed[0]?.phase, "idle"); assert.equal(observed[0]?.reason, "inputs-unchanged");
  assert.ok(observed.some((r) => r.phase === "failed" && r.reason === "spawn-failed" && r.executionMs === null));
  assert.ok(logs.includes("garden.pass")); assert.ok(logs.includes("garden.telemetry_failed"));
});

function rows() {
  const out: Array<{ step: string; extra: Record<string, unknown> }> = [];
  return { out, log: (step: string, extra: Record<string, unknown> = {}) => void out.push({ step, extra }) };
}

test("an admitted daemon records its gardener inventory while dry runs and telemetry failures preserve authority", async (t) => {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}garden-inventory-home-`));
  const root = join(home, "Remudero"), state = join(root, "state");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(state, { recursive: true });
  const planPath = join(home, "tasks.yaml"), inventoryPath = join(state, "gardener-runtime.json");
  writeFileSync(planPath, "[]\n");
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true }); });
  let calls = 0;
  const deps = { gardenPassesInProcess: true, githubFactory: () => fakeGitHub(), runDaemon: async (): Promise<DaemonSummary> => {
    calls++; return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
  } };
  const args = ["--allow-self-target", "--plan", planPath, "--max", "0"];
  assert.equal(await daemonCommand(args, deps), 0);
  assert.ok(existsSync(inventoryPath), "an admitted daemon persists its own inventory");
  const manifest = JSON.parse(readFileSync(inventoryPath, "utf8"));
  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.gardens.map((g: { name: string }) => g.name), REGISTERED_GARDEN_NAMES);
  assert.ok(manifest.gardens.every((g: { enabled: boolean }) => g.enabled));
  assert.match(manifest.codeSha, /^[a-f0-9]{40}$/);
  const saved = JSON.stringify({ ...manifest, testSentinel: "preserve this recorded authority" });
  writeFileSync(inventoryPath, saved);
  assert.equal(await daemonCommand([...args, "--dry-run"], deps), 0);
  assert.equal(calls, 1, "a dry run never admits the daemon loop");
  assert.equal(readFileSync(inventoryPath, "utf8"), saved, "a dry run cannot replace the live receipt");
  rmSync(inventoryPath); mkdirSync(inventoryPath);
  assert.equal(await daemonCommand(args, deps), 0, "a telemetry write failure is not a failed daemon admission");
  assert.equal(calls, 2);
  const ledger = readFileSync(join(state, "ledger.ndjson"), "utf8");
  assert.match(ledger, /"step":"garden.telemetry_failed"/);
  assert.match(ledger, /"reason":"runtime-inventory-write-failed"/);
});

test("W1-T5114: a gardener pass never runs on the daemon event loop", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}garden-offloop-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A pass that holds its own thread for a full second, as a heavy inventory read does.
  const busy = join(dir, "busy-pass.mjs");
  writeFileSync(busy, "const end = Date.now() + 1000; while (Date.now() < end) {}\n");
  const spawnPass = childGardenPassSpawn({ execPath: process.execPath, execArgv: [], entry: busy });
  const { out, log } = rows();
  const events: string[] = [];
  const timer = setTimeout(() => events.push("loop-timer"), 50);
  const garden = startGardenOffLoop("plan", 60 * 60 * 1000, {
    spawnPass: (name, args, signal) => spawnPass(name, args, signal).then((exit) => (events.push("pass-exit"), exit)),
    log,
  });
  t.after(() => { clearTimeout(timer); garden.stop(); });
  for (let waited = 0; !out.some((r) => r.step === GARDEN_PASS_STEP) && waited < 20_000; waited += 25) await wait(25);
  assert.deepEqual(events, ["loop-timer", "pass-exit"], "the loop's own timer fired while the pass was still running");
  const pass = out.find((r) => r.step === GARDEN_PASS_STEP)!;
  assert.equal(pass.extra.name, "plan");
  assert.equal(pass.extra.exit, 0);
  assert.ok(Number(pass.extra.ms) >= 900, `the pass row carries the pass's own duration (${pass.extra.ms} ms)`);
});

test("W1-T5114: a garden tick is skipped while its pass is still running", async (t) => {
  const calls: Array<readonly string[]> = [];
  let finish: (exit: number) => void = () => {};
  const spawnPass: GardenPassSpawn = (_name, args) => {
    calls.push(args);
    return new Promise((resolve) => { finish = resolve; });
  };
  const { out, log } = rows();
  const garden = startGardenOffLoop("test", 10, { spawnPass, log });
  t.after(() => garden.stop());
  await wait(60);
  assert.equal(calls.length, 1, "ticks while the first pass runs are skipped");
  assert.deepEqual(calls[0], [GARDEN_HOURLY_FLAG], "the first test-garden pass of a ledger bucket refreshes its hourly evidence");
  finish(0);
  for (let waited = 0; calls.length < 2 && waited < 2_000; waited += 10) await wait(10);
  assert.ok(calls.length >= 2, "the next tick after the pass settles runs again");
  assert.deepEqual(calls[1], [], "the same bucket is not refreshed twice once a pass succeeded");
  assert.equal(out.filter((r) => r.step === GARDEN_PASS_STEP).length, 1);
});

test("registered gardens share two child slots and a stopped queued pass never spawns", async () => {
  const started: string[] = [];
  const release: Array<(exit: number) => void> = [];
  const spawn = boundedGardenPassSpawn((name) => {
    started.push(name);
    return new Promise<number>((resolve) => release.push(resolve));
  }, 2);
  const signals = [{ stopped: false }, { stopped: false }, { stopped: false }, { stopped: false }];
  const passes = [
    spawn("plan", [], signals[0]!),
    spawn("gate", [], signals[1]!),
    spawn("test", [], signals[2]!),
    spawn("config", [], signals[3]!),
  ];
  await wait(0);
  assert.deepEqual(started, ["plan", "gate"], "only two expensive children start at once");
  signals[2]!.stopped = true;
  release[0]!(0);
  assert.equal(await passes[0], 0);
  await wait(0);
  assert.deepEqual(started, ["plan", "gate", "config"], "a stopped queued pass is skipped and the next live one starts");
  assert.equal(await passes[2], null);
  release[1]!(0);
  release[2]!(0);
  assert.deepEqual(await Promise.all([passes[1], passes[3]]), [0, 0]);
});

test("a failed garden child releases its shared slot", async () => {
  const started: string[] = [];
  const spawn = boundedGardenPassSpawn((name) => {
    started.push(name);
    if (name === "plan") throw new Error("spawn EAGAIN");
    return Promise.resolve(0);
  }, 1);
  const first = spawn("plan", [], { stopped: false });
  const second = spawn("gate", [], { stopped: false });
  await assert.rejects(first, /spawn EAGAIN/);
  assert.equal(await second, 0);
  assert.deepEqual(started, ["plan", "gate"]);
});

test("W1-T5114: each garden keeps its own pacing, and a failed spawn is logged rather than thrown", async (t) => {
  assert.equal(gardenSchedule("host-resource").minIntervalMs, HOST_RESOURCE_MIN_INTERVAL_MS);
  assert.equal(gardenSchedule("host-resource").intervalFor(60_000), Math.max(1_000, Math.min(60_000, HOST_RESOURCE_MIN_INTERVAL_MS)));
  assert.equal(gardenSchedule("overseer").intervalFor(60_000), Math.max(60_000, OVERSEER_MIN_INTERVAL_MS));
  assert.equal(gardenSchedule("plan").intervalFor(60_000), 60_000);
  assert.equal(isRegisteredGardenName("plan"), true);
  assert.equal(isRegisteredGardenName("knowledge"), false);

  let now = 1_000_000;
  const clock = clockFromMillisFn(() => now);
  let hostCalls = 0;
  const host = startGardenOffLoop("host-resource", 5, { spawnPass: async () => (hostCalls++, 0), log: () => {}, clock });
  t.after(() => host.stop());
  await wait(40);
  assert.equal(hostCalls, 1, "inside the host-resource minimum interval a tick is skipped");
  now += HOST_RESOURCE_MIN_INTERVAL_MS;
  await wait(1_200);
  assert.equal(hostCalls, 2, "after the minimum interval the next tick runs");

  const thrown = rows();
  const sync = startGardenOffLoop("export", 60 * 60 * 1000, { spawnPass: () => { throw new Error("spawn EAGAIN"); }, log: thrown.log });
  sync.stop();
  assert.deepEqual(thrown.out.map((r) => [r.step, r.extra.exit, r.extra.error]), [[GARDEN_PASS_STEP, null, "spawn EAGAIN"]]);

  const rejected = rows();
  const failing = startGardenOffLoop("export", 60 * 60 * 1000, { spawnPass: () => Promise.reject(new Error("child died")), log: rejected.log });
  failing.stop();
  await wait(10);
  assert.deepEqual(rejected.out.map((r) => [r.extra.exit, r.extra.error]), [[null, "child died"]]);

  const stopped = rows();
  let stoppedCalls = 0;
  const halted = startGardenOffLoop("export", 5, { spawnPass: async () => (stoppedCalls++, 0), log: stopped.log });
  halted.stop();
  await wait(30);
  assert.equal(stoppedCalls, 1, "a stopped garden never starts another pass");
});

test("W1-T5114: the daemon wiring and the garden CLI build each garden from the same registry", async (t) => {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}garden-registry-home-`));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");

  // The CLI names exactly the registry.
  let usage = "";
  try {
    execFileSync(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "run-task.ts"), "garden", "run", "not-a-garden"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, RMD_SELF_SYNC_DONE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    usage = String((e as { stderr?: string }).stderr ?? "");
    assert.equal((e as { status?: number }).status, 2);
  }
  assert.match(usage, new RegExp(`gardens: ${REGISTERED_GARDEN_NAMES.join(", ")}`));

  // The daemon wires one starter per registered garden (the machine-filing judge is one since W1-T5361).
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  let captured: DaemonDeps | undefined;
  try {
    await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      gardenPassesInProcess: true,
      runDaemon: async (_plan, d): Promise<DaemonSummary> => {
        captured = d;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
  assert.equal(captured?.gardens?.length, REGISTERED_GARDEN_NAMES.length);

  // Every registered name builds through the one builder both paths use; nothing runs a pass here.
  const ctx: GardenBuildContext = {
    config: { claudeBin: "/bin/true", root } as GardenBuildContext["config"],
    repoRoot: process.cwd(),
    owner: "acme",
    repo: "remudero",
    log: () => {},
    raiseDuplicate: () => "",
  };
  for (const name of REGISTERED_GARDEN_NAMES) {
    const built = await buildRegisteredGarden(name, ctx);
    assert.equal(typeof built, "function", `${name} builds a pass`);
  }
  assert.equal(await runRegisteredGardenPass("gate", [], ctx, { stopped: true }), 0, "a pass stopped before its garden loads never runs");
});

test("W1-T5114: every registered garden's pass records its own failure and never throws", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}garden-failure-`));
  const bare = join(root, "not-a-repo");
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(bare, { recursive: true });
  const oldPath = process.env.PATH;
  // No `gh` on PATH: every GitHub read inside a pass fails fast instead of reaching the network.
  process.env.PATH = "/usr/bin:/bin";
  t.after(() => { process.env.PATH = oldPath; rmSync(root, { recursive: true, force: true }); });
  const failures: string[] = [];
  const ctxFor = (repoRoot: string, throwing: boolean): GardenBuildContext => ({
    config: { claudeBin: "/bin/true", root } as GardenBuildContext["config"],
    repoRoot,
    owner: "acme",
    repo: "remudero",
    log: (step: string) => {
      if (/failed$/.test(step)) return void failures.push(step);
      if (throwing) throw new Error(`log refused ${step}`);
    },
    raiseDuplicate: () => "",
  });
  const runPass = async (name: (typeof REGISTERED_GARDEN_NAMES)[number], ctx: GardenBuildContext) => {
    const pass = await buildRegisteredGarden(name, ctx, { hourly: true });
    await pass();
  };
  // A repo with no scripts: the three ES-module gardens fail to load and record it under their own names.
  for (const name of ["gate", "test", "config"] as const) await runPass(name, ctxFor(bare, false));
  // The real repo with a log that refuses every non-failure row: each loaded pass fails inside and records it.
  for (const name of ["test", "config", "selector-shadow", "evidence-coverage"] as const) await runPass(name, ctxFor(process.cwd(), true));
  // A root that is not a git repo: the host-resource and overseer passes fail on their first read.
  for (const name of ["host-resource", "overseer"] as const) await runPass(name, ctxFor(bare, true));
  for (const step of [
    "gate.gardener_failed",
    "test.gardener_failed",
    "config.gardener_failed",
    "test.evidence_failed",
    "selector-shadow.gardener_failed",
    "evidence_coverage.gardener_failed",
    "host_resource.failed",
    "gardener_overseer.overseer_failed",
  ]) assert.ok(failures.includes(step), `${step} is recorded (saw ${failures.join(", ")})`);
});

test("W1-T5114: rmd garden run runs one pass of a registered garden and refuses an unknown one", async (t) => {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}garden-cli-home-`));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  });
  assert.equal(await gardenCommand(["run", "not-a-garden"]), 2);
  assert.equal(await gardenCommand(["run", "evidence-coverage", "--bogus"]), 2);
  assert.equal(await gardenCommand(["run", "evidence-coverage"]), 0);
  const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8");
  assert.match(ledger, /"run_id":"GARDEN-evidence-coverage-\d+","task_id":"DAEMON"/);
});
