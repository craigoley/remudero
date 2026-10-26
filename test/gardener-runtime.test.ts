import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import { createGardenerRuntimeWriter, GARDENER_RUNTIME_FILE, GARDENER_RUNTIME_MAX_BYTES, parseGardenerRuntime,
  readGardenerRuntime, type GardenerRuntimeEvent } from "../src/lib/gardener-runtime.js";
import { buildGardenersRoute } from "../src/lib/gardeners-route.js";
import type { Route } from "../src/lib/service.js";
import { declaredBody, SPEC, violations, type Schema } from "#test/helpers/openapi-strict.js";

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

async function opportunityRouteFixture(t: TestContext) {
  const stateDir = await mkdtemp(join(tmpdir(), "rmd-gardener-opportunity-route-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const writer = createGardenerRuntimeWriter({ stateDir, repository: "acme/app", daemonRunId: "boot", clock,
    gardens: inventory, log: () => {} }); await writer.flush();
  const route = buildGardenersRoute({ stateDir, repository: "acme/app", clock });
  return { path: join(stateDir, "opportunity-outcomes.json"), read: async () => {
    const result = await invoke(route); assert.equal(result.status, 200); return result.body;
  } };
}
const opportunityRouteRow = (key = "debt", state = "pending") => ({
  candidate: { repo: "acme/app", key, observedAt: "2026-10-06T12:00:00.000Z" },
  key: `acme/app/${key}`, proposalId: "proposal", sourceIds: ["source"], at: "2026-10-06T12:00:00.000Z", state,
  reason: "PRIVATE reason", privatePath: "/private/operator/root",
});

test("gardener process status exposes saved opportunity classifications with separate reconciliation timestamps", async (t) => {
  const f = await opportunityRouteFixture(t);
  const states = ["pending", "filed", "merged", "deployed", "measured-helped", "measured-hurt", "expired", "unavailable"];
  await writeFile(f.path, JSON.stringify(states.map((state, i) => opportunityRouteRow(`key-${i}`, state))));
  const body = await f.read();
  assert.equal(body.opportunityEvidence.total, 8);
  assert.deepEqual(body.opportunityEvidence.counts, Object.fromEntries(states.map((state) => [state, 1])));
  assert.equal(body.opportunityEvidence.readAt, stamp);
  assert.equal(body.opportunityEvidence.latestReconciledAt, "2026-10-06T12:00:00.000Z");
  assert.equal(body.opportunityEvidence.countSemantics, "reported_states_not_verified_outcomes");
  assert.equal(body.spend, null); assert.equal(body.outcomeAssessment, "not_collected");
  assert.ok(!JSON.stringify(body).includes("PRIVATE")); assert.ok(!JSON.stringify(body).includes("/private/operator"));
});

test("gardener process status retains valid runtime when opportunity evidence is missing invalid or oversized", async (t) => {
  const f = await opportunityRouteFixture(t);
  const valid = (await f.read()).gardens;
  assert.equal((await f.read()).opportunityEvidence.reason, "not_collected");
  for (const [text, reason] of [["[truncated", "malformed"], ["x".repeat(512 * 1024 + 1), "oversized"]]) {
    await writeFile(f.path, text!); const body = await f.read();
    assert.equal(body.opportunityEvidence.reason, reason); assert.deepEqual(body.gardens, valid);
    assert.equal(body.opportunityEvidence.total, undefined);
  }
  await rm(f.path); await mkdir(f.path);
  assert.equal((await f.read()).opportunityEvidence.reason, "unreadable");
});

test("gardener process status refuses mixed duplicate and future opportunity rows rather than certifying partial totals", async (t) => {
  const f = await opportunityRouteFixture(t);
  for (const [rows, reason] of [
    [[opportunityRouteRow(), opportunityRouteRow()], "malformed"],
    [[{ ...opportunityRouteRow(), key: "acme/other/debt", candidate: { ...opportunityRouteRow().candidate, repo: "acme/other" } }], "repository_mismatch"],
    [[{ ...opportunityRouteRow(), at: "2026-10-07T12:01:01.000Z" }], "clock_skew"],
  ] as const) {
    await writeFile(f.path, JSON.stringify(rows)); const body = await f.read();
    assert.equal(body.opportunityEvidence.reason, reason); assert.equal(body.opportunityEvidence.total, undefined);
    assert.equal(body.gardens.length, 2);
  }
});

test("a rank-deferred garden persists its actual refusal without claiming a memory failure or completion", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "rmd-gardener-rank-"));
  t.after(() => rm(stateDir, {recursive:true, force:true}));
  const writer = createGardenerRuntimeWriter({stateDir, repository:"acme/app", daemonRunId:"boot-rank", clock,
    gardens:inventory, log:() => {}});
  writer.record(event("queued"));
  writer.record({...event("idle"), reason:"admission-rank"});
  await writer.flush();
  const persisted = (await readGardenerRuntime(stateDir)).gardens[0]!;
  assert.equal(persisted.reason, "admission-rank");
  assert.equal(persisted.phase, "idle");
  assert.equal(persisted.attempts, 1);
  assert.equal(persisted.completions, 0);
  assert.equal(persisted.lastSuccessAt, null);
  assert.equal(persisted.lastCompletedAt, null);
  const response = await invoke(buildGardenersRoute({stateDir, repository:"acme/app", clock}));
  assert.equal(response.status, 200);
  assert.equal(response.body.gardens[0].reason, "admission-rank");
  assert.equal(response.body.gardens[0].completions, 0);
});

test("W1-T10760: gardener runtime contract declares the emitted admission-rank reason", () => {
  const supported: Record<NonNullable<GardenerRuntimeEvent["reason"]>, true> = {
    "inputs-unchanged": true, "process-completed": true, "process-failed": true,
    "signal-or-cancelled": true, "spawn-failed": true, "memory-budget-shortfall": true,
    "admission-rank": true,
  };
  const properties = SPEC.components.schemas.GardenerRuntimeEntry!.properties as Record<string, Schema>;
  assert.deepEqual(properties.reason!.enum, [...Object.keys(supported), null]);
  for (const reason of [...Object.keys(supported), null]) {
    assert.deepEqual(violations(reason, properties.reason!), []);
  }
  assert.ok(violations("unsupported-reason", properties.reason!).length > 0);
});

test("W1-T10760: idle admission deferral validates against the published gardener schema", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "rmd-gardener-rank-contract-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const writer = createGardenerRuntimeWriter({ stateDir, repository: "acme/app", daemonRunId: "boot-rank", clock,
    gardens: inventory, log: () => {} });
  writer.record(event("queued"));
  writer.record({ ...event("idle"), reason: "admission-rank" });
  await writer.flush();
  const response = await invoke(buildGardenersRoute({ stateDir, repository: "acme/app", clock }));
  assert.equal(response.status, 200);
  assert.deepEqual(violations(response.body, declaredBody("/v1/gardeners", "GET", 200)), []);
  const garden = response.body.gardens[0];
  assert.equal(garden.reason, "admission-rank");
  assert.equal(garden.phase, "idle");
  assert.equal(garden.executionMs, null);
  assert.equal(garden.exit, null);
  assert.equal(garden.attempts, 1);
  assert.equal(garden.completions, 0);
  assert.equal(garden.lastCompletedAt, null);
  assert.equal(response.body.spend, null);
  assert.equal(response.body.outcomeAssessment, "not_collected");
});

test("W1-T10760: gardener contract accepts current admission but refuses unsupported reasons", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "rmd-gardener-rank-controls-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const writer = createGardenerRuntimeWriter({ stateDir, repository: "acme/app", daemonRunId: "boot-rank", clock,
    gardens: inventory, log: () => {} });
  const route = buildGardenersRoute({ stateDir, repository: "acme/app", clock });
  const success = declaredBody("/v1/gardeners", "GET", 200);
  writer.record(event("queued"));
  writer.record({ ...event("completed"), reason: "process-completed", exit: 0, executionMs: 40 });
  await writer.flush();
  const completed = await invoke(route);
  assert.equal(completed.status, 200);
  assert.deepEqual(violations(completed.body, success), []);
  assert.equal(completed.body.gardens[0].executionMs, 40);
  writer.record({ ...event("queued"), passId: "pass-2" });
  writer.record({ ...event("idle"), passId: "pass-2", reason: "admission-rank" });
  await writer.flush();
  const deferred = await invoke(route);
  assert.equal(deferred.status, 200);
  assert.deepEqual(violations(deferred.body, success), []);
  const garden = deferred.body.gardens[0];
  assert.equal(garden.reason, "admission-rank");
  assert.equal(garden.executionMs, null);
  assert.equal(garden.exit, null);
  assert.equal(garden.attempts, 2);
  assert.equal(garden.completions, 1);
  assert.equal(garden.lastCompletedAt, stamp);
  assert.equal(garden.lastSuccessAt, stamp);
  const unsupported = structuredClone(deferred.body);
  unsupported.gardens[0].reason = "unsupported-reason";
  assert.ok(violations(unsupported, success).some((problem) => problem.includes("reason") && problem.includes("enum")));
  const snapshot = await readGardenerRuntime(stateDir);
  for (const [mutate, reason] of [
    [(value: any) => { value.gardens[0].reason = "unsupported-reason"; }, "unreadable"],
    [(value: any) => { value.gardens[0].completions = value.gardens[0].attempts + 1; }, "unreadable"],
    [(value: any) => { value.repository = "acme/other"; }, "repository_mismatch"],
  ] as const) {
    const invalid = structuredClone(snapshot); mutate(invalid);
    await writeFile(join(stateDir, GARDENER_RUNTIME_FILE), JSON.stringify(invalid));
    const refused = await invoke(route);
    assert.deepEqual(refused, { status: 503, body: { error: "gardeners_unavailable", reason } });
    assert.deepEqual(violations(refused.body, declaredBody("/v1/gardeners", "GET", 503)), []);
  }
});
