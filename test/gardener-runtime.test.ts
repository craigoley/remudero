import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import { createGardenerRuntimeWriter, GARDENER_RUNTIME_FILE, GARDENER_RUNTIME_MAX_BYTES, parseGardenerRuntime,
  readGardenerRuntime, type GardenerRuntimeEvent } from "../src/lib/gardener-runtime.js";
import { buildGardenersRoute } from "../src/lib/gardeners-route.js";
import type { Route } from "../src/lib/service.js";

const stamp = "2026-10-07T12:00:00.000Z";
const clock = fixedClock(Date.parse(stamp));
const inventory = [{ name: "plan", enabled: true, cadenceMs: 60_000, scope: "repository" as const },
  { name: "host-resource", enabled: false, cadenceMs: 300_000, scope: "host" as const }];
const event = (phase: GardenerRuntimeEvent["phase"]): GardenerRuntimeEvent => ({ name: "plan", phase,
  observedAt: stamp, passId: "pass-1", nextDueAt: null, queueMs: null, executionMs: null, exit: null, reason: null });
async function invoke(route: Route) {
  let status = 0, body = "";
  const res = { writeHead(code: number) { status = code; }, end(value: string) { body = value; } };
  await route.handler({} as never, res as never, { params: {} });
  return { status, body: JSON.parse(body) };
}

test("gardener runtime persists bounded boot-scoped counters without claiming outcomes or spend", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "rmd-gardener-runtime-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const logged: string[] = [];
  const writer = createGardenerRuntimeWriter({ stateDir, repository: "acme/app", daemonRunId: "boot-1", clock,
    gardens: inventory, log: (step) => logged.push(step) });
  await writer.flush();
  writer.record(event("queued"));
  writer.record({ ...event("running"), queueMs: 12 });
  writer.record({ ...event("completed"), exit: 0, queueMs: 12, executionMs: 40, reason: "process-completed" });
  await writer.flush();
  const result = await invoke(buildGardenersRoute({ stateDir, repository: "acme/app", clock }));
  assert.equal(result.status, 200);
  assert.equal(result.body.gardens[0].phase, "completed");
  assert.equal(result.body.gardens[0].attempts, 1);
  assert.equal(result.body.gardens[0].completions, 1);
  assert.equal(result.body.gardens[0].executionMs, 40);
  assert.equal(result.body.gardens[1].enabled, false);
  assert.equal(result.body.counterWindow, "daemon-run");
  assert.equal(result.body.outcomeAssessment, "not_collected");
  assert.equal(result.body.spend, null);
  writer.record({ ...event("idle"), passId: null, reason: "inputs-unchanged" });
  await writer.flush();
  const idle = (await readGardenerRuntime(stateDir)).gardens[0]!;
  assert.equal(idle.executionMs, 40); assert.equal(idle.lastSuccessAt, stamp);
  assert.equal(idle.lastCompletedAt, stamp); assert.equal(idle.lastFailureAt, null);
  assert.equal(logged.filter((step) => step === "garden.lifecycle").length, 4);
  assert.throws(() => writer.record({ ...event("queued"), name: "host-resource" }), /inventory/);
  assert.throws(() => writer.record({ ...event("queued"), name: "unknown" }), /inventory/);
});

test("gardener runtime rejects malformed empty duplicate and unbounded inventories", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "rmd-gardener-bounds-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const writer = createGardenerRuntimeWriter({ stateDir, repository: "acme/app", daemonRunId: "boot", clock,
    gardens: inventory, log: () => {} });
  await writer.flush();
  const snapshot = await readGardenerRuntime(stateDir);
  for (const change of [
    (s: any) => { s.version = 2; }, (s: any) => { s.repository = "../../secret"; },
    (s: any) => { s.codeSha = "not-a-sha"; }, (s: any) => { s.gardens = []; },
    (s: any) => { s.gardens.push(s.gardens[0]); }, (s: any) => { s.gardens[0].observedAt = "yesterday"; },
    (s: any) => { s.gardens[0].completions = 2; }, (s: any) => { s.gardens[0].queueMs = -1; },
    (s: any) => { s.gardens = Array.from({ length: 33 }, (_, i) => ({ ...s.gardens[0], name: `garden-${i}` })); },
  ]) { const modified = structuredClone(snapshot); change(modified); assert.throws(() => parseGardenerRuntime(modified), /malformed/); }
  await writeFile(join(stateDir, GARDENER_RUNTIME_FILE), "x".repeat(GARDENER_RUNTIME_MAX_BYTES + 1));
  await assert.rejects(readGardenerRuntime(stateDir), /bound/);
  await writeFile(join(stateDir, GARDENER_RUNTIME_FILE), "corrupt");
  await assert.rejects(readGardenerRuntime(stateDir), SyntaxError);
  await rm(join(stateDir, GARDENER_RUNTIME_FILE));
  await mkdir(join(stateDir, GARDENER_RUNTIME_FILE));
  await assert.rejects(readGardenerRuntime(stateDir), /bound/);
});

test("gardener runtime serializes overlapping writes and retries a failed real persistence", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "rmd-gardener-writes-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let release!: () => void;
  const writes: string[] = [];
  const writer = createGardenerRuntimeWriter({ stateDir, repository: "acme/app", daemonRunId: "boot", clock,
    gardens: inventory, log: () => {}, write: async (_path, text) => {
      writes.push(text); if (writes.length === 1) await new Promise<void>((resolve) => { release = resolve; });
    } });
  const first = writer.flush();
  writer.record(event("queued")); writer.record(event("failed"));
  assert.equal(writes.length, 1);
  release(); await first;
  assert.equal(writes.length, 2);
  assert.equal(JSON.parse(writes[1]!).gardens[0].failures, 1);
  const blocker = join(stateDir, "not-a-directory");
  await writeFile(blocker, "blocker");
  const logs: string[] = [];
  const real = createGardenerRuntimeWriter({ stateDir: blocker, repository: "acme/app", daemonRunId: "boot", clock,
    gardens: inventory, log: (step) => logs.push(step) });
  await assert.rejects(real.flush());
  real.record(event("queued")); await assert.rejects(real.flush());
  assert.ok(logs.includes("garden.telemetry_failed"));
  await rm(blocker); await mkdir(blocker); await real.flush();
  assert.equal((await readGardenerRuntime(blocker)).gardens[0]!.attempts, 1);
});

test("gardener status refuses missing unreadable wrong-repo and future receipts instead of reporting zero", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "rmd-gardener-route-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const route = buildGardenersRoute({ stateDir, clock });
  assert.deepEqual(await invoke(route), { status: 503, body: { error: "gardeners_unavailable", reason: "not_collected" } });
  await writeFile(join(stateDir, GARDENER_RUNTIME_FILE), "bad-json");
  assert.equal((await invoke(route)).body.reason, "unreadable");
  const writer = createGardenerRuntimeWriter({ stateDir, repository: "acme/other", daemonRunId: "boot", clock,
    gardens: inventory, log: () => {} }); await writer.flush();
  assert.equal((await invoke(buildGardenersRoute({ stateDir, repository: "acme/app", clock }))).body.reason, "repository_mismatch");
  const future = createGardenerRuntimeWriter({ stateDir, repository: "acme/app", daemonRunId: "boot",
    clock: fixedClock(clock.now() + 61_000), gardens: inventory, log: () => {} }); await future.flush();
  assert.equal((await invoke(route)).body.reason, "clock_skew");
});
