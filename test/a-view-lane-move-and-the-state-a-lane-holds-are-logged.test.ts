import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { Clock } from "../src/lib/clock.js";
import { createReadModelTicker, threadViews, type ReadModelView, type ReadModelWorkerMessage } from "../src/lib/read-model-worker.js";
import { makeTempDir } from "../src/lib/tmp.js";

const proof = "test/a-view-lane-move-and-the-state-a-lane-holds-are-logged.test.ts";
const intervalMs = 10 * 60_000;

async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!done() && Date.now() < deadline) await sleep(5);
  assert.ok(done(), "the worker produced the expected telemetry");
}

test(`${proof}: the relay logs each move and counts units reclaimed at death and respawn`, async (t) => {
  const dir = makeTempDir("lane-log-relay");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const modulePath = join(dir, "worker.mjs");
  writeFileSync(modulePath, `import { parentPort, workerData } from "node:worker_threads";
const lane = workerData.lane;
parentPort.on("message", (msg) => {
  if (msg.type === "lane") parentPort.postMessage({ type: "log", step: "fixture.lane", extra: { lane, ...msg } });
  if (msg.type !== "want") return;
  if (msg.view === "move" && lane === "fast") {
    for (const instance of ["core", "site"]) parentPort.postMessage({ type: "view_lane", view: "now", instance, heavy: true, dueAt: 123, costMs: 2000 });
  }
  if (msg.view === "return" && lane === "heavy") parentPort.postMessage({ type: "view_lane", view: "now", instance: "site", heavy: false, dueAt: 456, costMs: 1 });
  if (msg.view === "die" && lane === "heavy") process.exit(3);
  if (msg.view === "die-fast" && lane === "fast") process.exit(4);
});
`);
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const relayed: ReadModelWorkerMessage[] = [];
  const lanes = threadViews({ data: { stateDir: dir, instances: [], tickMs: 50, holder: "h" }, workerUrl: pathToFileURL(modulePath),
    log: (step, extra) => void logs.push({ step, extra }), relay: (msg) => void relayed.push(msg) });
  t.after(() => lanes.close());
  const rows = (step: string) => logs.filter((row) => row.step === step).map((row) => row.extra);
  const forwarded = () => relayed.flatMap((msg) => msg.type === "log" && msg.step === "fixture.lane" ? [msg.extra] : []);
  lanes.want("move", "");
  await until(() => forwarded().length === 2);
  assert.deepEqual(rows("read_model.view_lane_moved"), ["core", "site"].map((instance) => ({
    view: "now", instance, from: "fast", to: "heavy", costMs: 2000, soloMs: 1000,
  })));
  assert.deepEqual(forwarded().map((row) => [row.lane, row.instance, row.heavy, row.dueAt, row.costMs]),
    [["heavy", "core", true, 123, 2000], ["heavy", "site", true, 123, 2000]]);
  lanes.want("return", "");
  await until(() => forwarded().length === 3);
  assert.deepEqual(rows("read_model.view_lane_moved")[2], { view: "now", instance: "site", from: "heavy", to: "fast", costMs: 1, soloMs: 1000 });
  lanes.want("die", "");
  await until(() => forwarded().filter((row) => row.view === undefined).length === 2);
  assert.deepEqual(rows("read_model.view_lane_reclaimed"), [
    { lane: "fast", from: "heavy", count: 1, reason: "exit" },
    { lane: "fast", from: "heavy", count: 0, reason: "respawn" },
  ]);
  assert.deepEqual(forwarded().filter((row) => row.view === undefined).map((row) => [row.lane, row.heavy, row.dueAt]),
    [["fast", false, 0], ["fast", false, 0]]);
  lanes.want("die-fast", "");
  await until(() => rows("read_model.view_lane_reclaimed").length === 4);
  assert.deepEqual(rows("read_model.view_lane_reclaimed").slice(2), [
    { lane: "heavy", from: "fast", count: 0, reason: "exit" },
    { lane: "heavy", from: "fast", count: 0, reason: "respawn" },
  ], "the existing reset keeps every unit fast even when the heavy lane survives");
  assert.equal(rows("read_model.view_lane_moved").length, 3, "one row per move");
});

test(`${proof}: held reports exclude owned and never-built units, age on cadence, and preserve state`, (t) => {
  const dir = makeTempDir("lane-log-held");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "read-model"));
  writeFileSync(join(dir, "read-model", "switches.json"), JSON.stringify({ projector: "off", views: { measured: "shadow", unbuilt: "off", global: "shadow" } }));
  let ms = 0;
  const clock: Clock = { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() };
  const posted: ReadModelWorkerMessage[] = [];
  const state = new Map<string, { secret: string; builds: number }>();
  let coreCost = 2000;
  let succeeds = true;
  const view: ReadModelView = { name: "measured", version: 1, perInstance: true, materialize: (ctx) => {
    const instance = ctx.instances[0]!.state.instance;
    if (!succeeds) throw new Error("build failed");
    const held = state.get(instance) ?? { secret: "private row content", builds: 0 };
    held.builds++;
    state.set(instance, held);
    ms += instance === "core" ? coreCost : 1;
    return [{ key: "private key", data: held, sources: [] }];
  } };
  const ticker = createReadModelTicker({ stateDir: dir, instances: ["core", "site"].map((name) => ({ name, ledgerDir: dir })), clock,
    views: [view, { ...view, name: "unbuilt" }, { name: "global", version: 1, materialize: () => [{ key: "", data: {}, sources: [] }] }],
    viewsOnly: true, lane: "fast", oracle: "off", post: (msg) => void posted.push(msg) });
  t.after(() => void ticker.release());
  ticker.observe([]);
  const rows = () => posted.flatMap((msg) => msg.type === "log" && msg.step === "read_model.view_lane_held" ? [msg.extra] : []);
  ticker.tick();
  assert.deepEqual(rows().at(-1), { lane: "fast", count: 1, units: [{ view: "measured", instance: "core", minutesSinceBuild: 0 }] });
  const retained = state.get("core");
  assert.ok(retained);
  ticker.tick();
  ticker.lane({ view: "unbuilt", instance: "core", heavy: true, dueAt: 0, costMs: 2000 });
  assert.deepEqual(rows().at(-1)?.units, [{ view: "measured", instance: "core", minutesSinceBuild: 1 / 60_000 }]);
  const reportedAt = ms;
  const before = rows().length;
  succeeds = false;
  ms = reportedAt + intervalMs - 1;
  ticker.tick();
  assert.equal(rows().length, before, "periodic reports wait ten minutes after a move report");
  ms++;
  ticker.tick();
  assert.equal(rows().length, before + 1);
  assert.deepEqual(rows().at(-1), { lane: "fast", count: 1, units: [{ view: "measured", instance: "core", minutesSinceBuild: (ms - 2000) / 60_000 }] });
  ticker.lane({ view: "global", heavy: true, dueAt: 123 });
  assert.deepEqual((rows().at(-1)?.units as unknown[]).length, 2, "a built aggregate unit is named without an instance");
  assert.ok(!JSON.stringify(rows()).includes("private"), "names and counts contain neither keys nor body data");
  assert.equal(state.get("core"), retained, "handoff preserves the view's retained object");
  assert.equal(retained.builds, 1, "a held unit is not rebuilt by periodic reporting");
  ticker.lane({ heavy: false, dueAt: 0 });
  assert.deepEqual(rows().at(-1), { lane: "fast", count: 0, units: [] }, "reclaimed units are owned, not held");
  coreCost = 1;
  succeeds = true;
  const lastBuiltAt = ms + 1;
  ticker.buildNow("measured");
  assert.equal(state.get("core"), retained);
  assert.equal(retained.builds, 2, "the reclaimed view reuses its state");
  succeeds = false;
  ticker.buildNow("measured");
  ms += 60_000;
  ticker.lane({ view: "measured", instance: "core", heavy: true, dueAt: 0 });
  assert.deepEqual(rows().at(-1)?.units, [{ view: "measured", instance: "core", minutesSinceBuild: (ms - lastBuiltAt) / 60_000 }],
    "a failed call does not refresh the last successful build time");
});

test(`${proof}: the heavy lane reports a successful aggregate build after it moves back to fast`, (t) => {
  const dir = makeTempDir("lane-log-heavy");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "read-model"));
  writeFileSync(join(dir, "read-model", "switches.json"), JSON.stringify({ views: { cheap: "shadow", empty: "shadow", broken: "shadow" } }));
  const posted: ReadModelWorkerMessage[] = [];
  const ticker = createReadModelTicker({ stateDir: dir, instances: [], viewsOnly: true, lane: "heavy", oracle: "off",
    clock: { now: () => 0, date: () => new Date(0), iso: () => new Date(0).toISOString() },
    views: [
      { name: "cheap", version: 1, materialize: () => [{ key: "private key", data: { secret: "private body" }, sources: [] }] },
      { name: "empty", version: 1, materialize: () => [] },
      { name: "broken", version: 1, materialize: () => { throw new Error("no build"); } },
    ], post: (msg) => void posted.push(msg) });
  t.after(() => void ticker.release());
  ticker.observe([]);
  ticker.lane({ heavy: true, dueAt: 0 });
  ticker.tick();
  const rows = () => posted.flatMap((msg) => msg.type === "log" && msg.step === "read_model.view_lane_held" ? [msg.extra] : []);
  assert.deepEqual(rows().at(-1), { lane: "heavy", count: 1, units: [{ view: "cheap", minutesSinceBuild: 0 }] });
  ticker.lane({ heavy: false, dueAt: 0 });
  assert.deepEqual(rows().at(-1), { lane: "heavy", count: 1, units: [{ view: "cheap", minutesSinceBuild: 0 }] },
    "empty and failed calls never mark a view as previously built");
  const before = posted.filter((msg) => msg.type === "body").length;
  ticker.tick();
  assert.equal(posted.filter((msg) => msg.type === "body").length, before, "the heavy lane holds the body without rebuilding it");
});
