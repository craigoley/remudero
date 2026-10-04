import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { fixedClock } from "../src/lib/clock.js";
import {
  cachedMountHeadroomSweep, configGardenSpec, configInventory, configMeasurementOffLoop,
  configMountSweepCachePath, mountRecommendationSource, readConfigGardenLedgerRows,
  runConfigGarden, serveConfigMeasurement, startConfigGarden, type ConfigInventory,
} from "../src/lib/config-gardener.js";
import { gardenStatePath, type GardenerDeps } from "../src/lib/gardener.js";
import type { MountHeadroomCell } from "../src/lib/mount-recommender.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { buildRegisteredGarden, type GardenBuildContext } from "../src/run-task.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

const execFileAsync = promisify(execFile);
const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const REPO = resolve(import.meta.dirname, "..");
const SCRIPT = join(REPO, "scripts", "mount-headroom-sweep.mjs");
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}config-offloop-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  const events: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const deps: GardenerDeps = {
    repoRoot: root, stateDir, clock: fixedClock(NOW), seed: 7,
    log: (step, extra) => void events.push({ step, extra }),
    openWorkspace: () => { throw new Error("empty inventory must not open a workspace"); },
  };
  return { root, stateDir, deps, events };
}

function settledRun(i: number): Array<Record<string, unknown>> {
  return [
    { step: "run.start", run_id: `r${i}`, task_id: `W1-T${i}`, type: "implement", risk: "low", task_class: "src", ts: fixedClock(NOW).iso() },
    { step: "implement.done", run_id: `r${i}`, model: "sonnet", effort: "high", cost_usd: 3, num_turns: 4, ts: fixedClock(NOW).iso() },
    { step: "verdict", run_id: `r${i}`, verdict: "merged", cost_usd: 3, ts: fixedClock(NOW).iso() },
  ];
}

const cell: MountHeadroomCell = { cellKey: "implement|low|src", type: "implement", risk: "low", taskClass: "src", arms: [], comparisons: [] };

// A real default ledger read, with both archive forms and live rows, rather than an async fake.
test("W1-T4969: a timer keeps firing while the config inventory reads the ledger", async (t) => {
  const f = fixture(t);
  const rows = Array.from({ length: 8000 }, (_, i) => settledRun(i)).flat();
  writeLedger(rows.slice(16000), { dir: f.stateDir, rotations: [
    { at: "2026-09-29T00:00:00.000Z", rows: rows.slice(0, 8000), gz: true },
    { at: "2026-09-30T00:00:00.000Z", rows: rows.slice(8000, 16000) },
  ] });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 2);
  t.after(() => clearInterval(timer));
  const control = readConfigGardenLedgerRows(f.stateDir);
  assert.equal(ticks, 0, "positive control: the synchronous read holds the loop");
  assert.equal(control.length, rows.length, "the read sees both rotations and live rows");
  const inventory = await configInventory(f.deps);
  clearInterval(timer);
  assert.ok(ticks > 0, `a timer fired ${ticks} times before the inventory completed`);
  assert.equal(inventory.runs.length, 8000);
  assert.deepEqual(inventory.queued, []);
  let inline: unknown;
  await serveConfigMeasurement({ kind: "inventory", repoRoot: f.root, stateDir: f.stateDir, nowMs: NOW, recommendations: [] }, { postMessage: (reply) => { inline = reply; } });
  assert.deepEqual(inline, { ok: true, value: inventory }, "the worker preserves every inventory field");
});

test("W1-T4969: an unchanged ledger reuses the mount headroom sweep", async (t) => {
  const f = fixture(t);
  writeLedger(settledRun(2), { dir: f.stateDir, rotations: [{ at: "2026-09-30T00:00:00.000Z", rows: settledRun(1), gz: true }] });
  // These fresh Node processes use the production source, whose sweep runs in its own worker.
  const script = join(f.root, "counted-sweep.mjs");
  const counter = join(f.stateDir, "sweeps.txt");
  writeFileSync(script, `import { appendFileSync } from 'node:fs';\nexport function buildMountHeadroomSweep() { appendFileSync(${JSON.stringify(counter)}, 'sweep\\n'); return { cells: ${JSON.stringify([cell])} }; }\n`);
  const child = join(f.root, "child.mjs");
  writeFileSync(child, `import { mountRecommendationSource } from ${JSON.stringify(pathToFileURL(join(REPO, "src/lib/config-gardener.ts")).href)};\nconst source = mountRecommendationSource({ ...${JSON.stringify({ sweepScript: script, stateDir: f.stateDir, mountsFile: join(REPO, ".remudero/mounts.yaml"), billingMode: "api" })}, log: (step, extra) => { throw new Error(step + JSON.stringify(extra)); } });\nconsole.log(JSON.stringify(await source()));\n`);
  const pass = async () => {
    const output = await execFileAsync(process.execPath, ["--import", "tsx", child], { cwd: REPO });
    assert.deepEqual(JSON.parse(output.stdout.trim()), []);
  };
  await pass();
  await pass();
  assert.equal(readFileSync(counter, "utf8"), "sweep\n", "a second process reuses the first process's persisted cells");
  appendFileSync(join(f.stateDir, "ledger.ndjson"), JSON.stringify({ step: "ci.polling" }) + "\n");
  await pass();
  assert.equal(readFileSync(counter, "utf8"), "sweep\n", "live appends wait for a rotation");
  writeFileSync(join(f.stateDir, "ledger.2026-10-01T00-00-00-000Z.ndjson"), "{}\n");
  await pass();
  assert.equal(readFileSync(counter, "utf8"), "sweep\nsweep\n", "a new plain rotation invalidates a cache seeded with gzip");
  appendFileSync(join(f.stateDir, "ledger.2026-10-01T00-00-00-000Z.ndjson"), "{}\n");
  await pass();
  assert.equal(readFileSync(counter, "utf8").trim().split("\n").length, 3, "changed rotation metadata invalidates too");
});

test("W1-T4969: the cache rebuilds damaged entries and does not retain failed or incomplete sweeps", async (t) => {
  const f = fixture(t);
  const ledger = writeLedger([], { dir: f.stateDir });
  let calls = 0;
  const build = () => { calls++; return { cells: [cell] }; };
  await cachedMountHeadroomSweep(f.stateDir, SCRIPT, build);
  assert.equal(calls, 1);
  await cachedMountHeadroomSweep(f.stateDir, SCRIPT, build);
  assert.equal(calls, 1);
  ledger.append(settledRun(1));
  await cachedMountHeadroomSweep(f.stateDir, SCRIPT, build);
  assert.equal(calls, 2, "before any rotation, live growth invalidates the cache");
  const path = configMountSweepCachePath(f.stateDir);
  for (const bad of ["{broken", "null", JSON.stringify({ version: 99 }), JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), cells: [null] })]) {
    writeFileSync(path, bad);
    assert.deepEqual(await cachedMountHeadroomSweep(f.stateDir, SCRIPT, build), { cells: [cell] });
  }
  assert.equal(calls, 6, "malformed JSON and invalid shapes regenerate");
  rmSync(path);
  await assert.rejects(() => cachedMountHeadroomSweep(f.stateDir, SCRIPT, () => { throw new Error("sweep failed"); }), /sweep failed/);
  assert.equal(existsSync(path), false);
  await cachedMountHeadroomSweep(f.stateDir, SCRIPT, () => ({ cells: [cell], corpus: { unread: ["broken.gz"] } }));
  assert.equal(existsSync(path), false, "partial history is not persisted");
  await cachedMountHeadroomSweep(f.stateDir, SCRIPT, () => {
    ledger.append(settledRun(2));
    return { cells: [cell] };
  });
  assert.equal(existsSync(path), false, "a corpus change during the sweep cannot tag it with the old key");
});

test("W1-T4969: the real sweep builds cached cells while mounts are read on every pass", async (t) => {
  const f = fixture(t);
  writeLedger(settledRun(3), { dir: f.stateDir, rotations: [
    { at: "2026-09-29T00:00:00.000Z", rows: settledRun(1), gz: true },
    { at: "2026-09-30T00:00:00.000Z", rows: settledRun(2) },
  ] });
  let reply: unknown;
  await serveConfigMeasurement({ kind: "mount", stateDir: f.stateDir, sweepScript: SCRIPT }, { postMessage: (r) => { reply = r; } });
  const cached = readFileSync(configMountSweepCachePath(f.stateDir), "utf8");
  const cells = JSON.parse(cached).cells as MountHeadroomCell[];
  assert.equal(cells.length, 1, "positive control: the real sweep sees runs in all three file forms");
  assert.equal(cells[0].arms[0].n, 3);
  assert.deepEqual(reply, { ok: true, value: { cells } });
  const mountsFile = join(f.root, "mounts.yaml");
  writeFileSync(mountsFile, readFileSync(join(REPO, ".remudero", "mounts.yaml"), "utf8"));
  const source = mountRecommendationSource({ stateDir: f.stateDir, sweepScript: SCRIPT, mountsFile, billingMode: "api", log: f.deps.log });
  assert.deepEqual(await source(), []);
  assert.equal(f.events.length, 0, "thin evidence is a measured refusal, not a read failure");
  writeFileSync(mountsFile, "routes: [broken YAML");
  assert.deepEqual(await source(), []);
  assert.ok(f.events.some((e) => e.step === "config.mount_recommendations_unread"), "a cache hit still reloads the mounts file");
  assert.equal(readFileSync(configMountSweepCachePath(f.stateDir), "utf8"), cached, "only sweep cells are retained");
});

test("W1-T4969: measurement failures reject, and unavailable mount evidence is logged", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.stateDir, "ledger.2026-09-30T00-00-00-000Z.ndjson.gz"), "not gzip");
  await assert.rejects(() => configInventory(f.deps), /incomplete ledger union/);
  let reply: unknown;
  await serveConfigMeasurement({ kind: "inventory", repoRoot: f.root, stateDir: f.stateDir, nowMs: NOW, recommendations: [] }, { postMessage: (r) => { reply = r; } });
  assert.match(JSON.stringify(reply), /"ok":false.*incomplete ledger union/);
  await serveConfigMeasurement({ kind: "mount", stateDir: f.stateDir, sweepScript: join(f.root, "absent.mjs") }, { postMessage: (r) => { reply = r; } });
  assert.match(JSON.stringify(reply), /"ok":false.*Cannot find module/);
  const input = { kind: "mount" as const, stateDir: f.stateDir, sweepScript: SCRIPT };
  await assert.rejects(() => configMeasurementOffLoop(input, pathToFileURL(join(f.root, "no-worker.mjs"))), /Cannot find module/);
  const emptyWorker = join(f.root, "empty-worker.mjs");
  writeFileSync(emptyWorker, "process.exit(0);\n");
  await assert.rejects(() => configMeasurementOffLoop(input, pathToFileURL(emptyWorker)), /exited before answering/);
  await assert.rejects(() => configMeasurementOffLoop(input, new URL("https://example.invalid/worker")), /scheme file/);
  const source = mountRecommendationSource({ ...input, mountsFile: "absent.yaml", billingMode: "api", build: () => { throw new Error("no runs"); }, log: f.deps.log });
  assert.deepEqual(await source(), []);
  assert.ok(f.events.some((e) => e.step === "config.mount_recommendations_unread" && e.extra?.error === "no runs"));
});

test("W1-T4969: the registered config pass awaits its inventory and records async failure", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, "scripts"));
  writeFileSync(join(f.root, "scripts", "mount-headroom-sweep.mjs"), "export function buildMountHeadroomSweep() { return { cells: [] }; }\n");
  const ctx: GardenBuildContext = { config: { root: f.root, claudeBin: "/bin/true", overflow: "none" } as GardenBuildContext["config"], repoRoot: f.root, owner: "acme", repo: "remudero", log: f.deps.log, raiseDuplicate: () => "" };
  const pass = await buildRegisteredGarden("config", ctx);
  const pending = pass();
  assert.ok(pending instanceof Promise, "the production caller returns the outstanding inventory completion");
  assert.equal(existsSync(gardenStatePath(f.stateDir, "config")), false);
  await pending;
  assert.ok(f.events.some((e) => e.step === "config.scorecard"), "the scorecard is written before completion is reported");
  rmSync(gardenStatePath(f.stateDir, "config"));
  writeFileSync(join(f.stateDir, "ledger.2026-09-30T00-00-00-000Z.ndjson.gz"), "not gzip");
  await pass();
  assert.ok(f.events.some((e) => e.step === "config.gardener_failed" && /incomplete ledger union/.test(String(e.extra?.error))));
});

test("W1-T4969: the config timer holds its overlap guard until async completion", async (t) => {
  const f = fixture(t);
  const inv: ConfigInventory = { nowIso: fixedClock(NOW).iso(), runs: [], queued: [], recommendations: [], active: [], cooling: [] };
  let calls = 0;
  let release!: (value: ConfigInventory) => void;
  const spec = { ...configGardenSpec(f.deps), inventory: () => { calls++; return new Promise<ConfigInventory>((resolve) => { release = resolve; }); } };
  const garden = startConfigGarden(spec, f.deps, {}, 5);
  t.after(garden.stop);
  await pause(40);
  assert.equal(calls, 1, "ticks cannot overlap a pending inventory");
  release(inv);
  await pause(20);
  assert.equal(calls, 1, "unchanged ticks skip inventory after the completed pass");
  garden.stop();
  const broken = startConfigGarden({ ...spec, cheapFingerprint: () => "changed", inventory: async () => { throw new Error("async inventory failed"); } }, f.deps, {}, 60_000);
  broken.stop();
  await pause(10);
  assert.ok(f.events.some((e) => e.step === "config.gardener_failed" && e.extra?.error === "async inventory failed"));
  const before = f.events.filter((e) => e.step === "config.scorecard").length;
  await assert.rejects(() => runConfigGarden({ ...spec, cheapFingerprint: () => "changed", inventory: async () => { throw new Error("read refused"); } }, f.deps), /read refused/);
  assert.equal(f.events.filter((e) => e.step === "config.scorecard").length, before, "a failed measurement records no successful pass");
});
