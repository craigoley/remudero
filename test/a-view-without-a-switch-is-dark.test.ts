import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createReadModelTicker, createReadModelWorker, readModelSwitchesPath, type ReadModelBodyEntry, type ReadModelSwitches, type ReadModelWorkerMessage } from "../src/lib/read-model-worker.js";
import { createService } from "../src/lib/service.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { withViewShadow, type ShadowRequest } from "../src/lib/view-shadow.js";
import { buildReadModelViewRoutes, viewEtag, type ViewBodySource, type ViewDefinition } from "../src/lib/views.js";

type TestCtx = { after: (fn: () => void) => void };
const SILENT_WORKER = new URL("data:text/javascript,setInterval(() => {}, 1000)");

function scratch(t: TestCtx, kind: string): string {
  const dir = makeTempDir(kind);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function entry(view: string, data: unknown): ReadModelBodyEntry {
  return { view, key: "", version: 1, generation: 1, etag: viewEtag(view, 1, false, data), body: { view, version: 1, generatedAt: "2026-09-30T12:00:00.000Z", asOf: null, stale: false, sources: [], data } };
}

/** Every view has a read-model body; `legacy-view` also has a core computation, `console-view` does not. */
async function views(t: TestCtx, switches: ReadModelSwitches["views"]): Promise<{ read: (name: string) => Promise<{ status: number; body: Record<string, unknown> }>; samples: ShadowRequest[] }> {
  const bodies = new Map(["legacy-view", "console-view", "status-view"].map((name) => [name, entry(name, { from: "read-model" })]));
  const readModel: ViewBodySource = { body: (view) => bodies.get(view), judge: (sources) => [...sources], switches: () => ({ views: switches }) };
  const legacy: ViewDefinition = { name: "legacy-view", version: 1, compute: () => ({ data: { from: "legacy" }, sources: [] }) };
  const samples: ShadowRequest[] = [];
  const routes = buildReadModelViewRoutes(withViewShadow({ shadow: (request) => void samples.push(request) }, {
    legacy: [legacy], readModel, readModelViews: ["console-view", "status-view"], servedByDefault: ["status-view"],
  }));
  const server = createService({ tokens: { read: "r", write: "w" }, routes });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    samples,
    read: async (name) => {
      const res = await fetch(`${url}/v1/views/${name}`, { headers: { authorization: "Bearer r" } });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    },
  };
}

test("a view with no switch entry is dark and never answers with its read-model body", async (t) => {
  const { read, samples } = await views(t, {});
  assert.deepEqual((await read("legacy-view")).body.data, { from: "legacy" }, "a view with a core computation answers from it");
  assert.deepEqual(await read("console-view"), { status: 404, body: { error: "view_disabled", view: "console-view" } }, "a console-legacy view 404s so the console falls back");
  assert.deepEqual((await read("status-view")).body.data, { from: "read-model" }, "only a view named servedByDefault serves without a switch");
  await nextTurn();
  assert.equal(samples.length, 0, "a dark view is not sampled");
});

test("a shadowed view answers legacy primary or 404 view_shadow and hands a sample to the comparator", async (t) => {
  const { read, samples } = await views(t, { "legacy-view": "shadow", "console-view": "shadow", "status-view": "shadow" });
  assert.deepEqual((await read("legacy-view")).body.data, { from: "legacy" }, "the legacy computation is primary");
  assert.deepEqual(await read("console-view"), { status: 404, body: { error: "view_shadow", view: "console-view" } });
  assert.equal((await read("status-view")).status, 404, "shadow never serves the read-model body");
  await nextTurn();
  await nextTurn();
  const byView = new Map(samples.map((sample) => [sample.view, sample]));
  assert.deepEqual(byView.get("legacy-view")?.legacy?.data, { from: "legacy" }, "serve renders the legacy side it served");
  assert.equal(byView.get("console-view")?.legacy, undefined, "the worker computes a console-legacy view's legacy side");
  assert.deepEqual([...byView.keys()].sort(), ["console-view", "legacy-view", "status-view"]);
});

test("a view switched serve answers with its read-model body", async (t) => {
  const { read } = await views(t, { "legacy-view": "serve", "console-view": "serve" });
  assert.deepEqual((await read("legacy-view")).body.data, { from: "read-model" });
  assert.deepEqual((await read("console-view")).body.data, { from: "read-model" });
});

test("an absent or unreadable switch file is ledgered once and leaves every view dark", (t) => {
  const stateDir = scratch(t, "switch-dark");
  const logged: Array<[string, Record<string, unknown> | undefined]> = [];
  let refresh: (() => void) | undefined;
  const handle = createReadModelWorker({ stateDir, instances: [{ name: "core", ledgerDir: stateDir }], workerUrl: SILENT_WORKER, stopWaitMs: 20,
    log: (step, extra) => void logged.push([step, extra]), every: (run) => ((refresh = run), () => undefined) });
  t.after(() => handle.stop());
  handle.start();
  refresh?.();
  const switchRows = (): string[] => logged.filter(([step]) => step.startsWith("read_model.switch_")).map(([step]) => step);
  assert.deepEqual(switchRows(), ["read_model.switch_absent"], "one row for the absent file, not one per re-read");
  assert.match(String(logged.find(([step]) => step === "read_model.switch_absent")?.[1]?.reason), /no switch file/);
  assert.deepEqual(handle.switches().views, {});

  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ projector: "off", views: { now: "serve" } }));
  refresh?.();
  assert.deepEqual(handle.switches(), { projector: "off", views: { now: "serve" } });
  writeFileSync(readModelSwitchesPath(stateDir), "{ half");
  refresh?.();
  refresh?.();
  assert.deepEqual(handle.switches(), { projector: "off", views: {} }, "a torn file darkens every view and keeps the projector switch");
  assert.deepEqual(switchRows(), ["read_model.switch_absent", "read_model.switch_unreadable"]);
});

test("a projector tick is judged from when it completed and a slow one is ledgered", (t) => {
  const dir = scratch(t, "slow-tick");
  writeFileSync(join(dir, "ledger.ndjson"), `${JSON.stringify({ ts: "2026-09-30T11:59:00.000Z", step: "run.start", task_id: "T1" })}\n`);
  // Each clock read is 1.9 s later: one tick of the projector spans more than the 10 s stale bound.
  let ms = Date.parse("2026-09-30T12:00:00.000Z");
  const clock = { now: () => (ms += 1_900), date: () => new Date(ms), iso: () => new Date(ms).toISOString() };
  const posted: ReadModelWorkerMessage[] = [];
  const ticker = createReadModelTicker({ stateDir: dir, instances: [{ name: "core", ledgerDir: dir }], clock, post: (m) => void posted.push(m), oracle: "off" });
  t.after(() => ticker.release());
  ticker.tick();
  const state = posted.find((m) => m.type === "state");
  assert.ok(state?.type === "state");
  const tickedAt = state.instances[0]?.tickedAt ?? 0;
  assert.ok(tickedAt > state.at, `tickedAt ${tickedAt} is after the tick began at ${state.at}`);
  const steps = posted.flatMap((m) => (m.type === "log" ? [m.step] : []));
  assert.ok(steps.includes("read_model.slow_tick"), `a tick over the stale bound is ledgered: ${steps.join(", ")}`);
  assert.ok(steps.includes("read_model.lease_acquired"), "the first lease acquisition is ledgered");
});
