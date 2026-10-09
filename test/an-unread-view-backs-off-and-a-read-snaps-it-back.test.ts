/**
 * Demand-aware view pacing. MEASURED 2026-10-06 20:25Z to 10-08 18:38Z on the fleet host: `now@core` was
 * rebuilt 5,320 times for 25,605 s of CPU (~4.8 s a build, due on every ledger generation), while the
 * routes that read it (`now`, `needs-you`, `nav-badge`, `/v1/status`) were read in 20 of those 46 hours.
 *
 * A view marked `readPaced` keeps its cost / share cadence while it is read, stretches that wait by
 * doubling each unread build, and goes back to its unstretched schedule on the next read.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { Clock } from "../src/lib/clock.js";
import {
  READ_MODEL_IDLE_STRETCH_MAX,
  READ_MODEL_READ_HOT_MS,
  READ_MODEL_READ_NOTE_MS,
  READ_MODEL_VIEW_SHARE,
  createReadModelTicker,
  createReadModelWorker,
  runReadModelViewWorker,
  readModelLaneViews,
  runReadModelWorker,
  threadViews,
  viewsReadBy,
  type ReadModelInstanceState,
  type ReadModelView,
  type ReadModelViewFactory,
  type ReadModelViewsInput,
  type ReadModelWorkerMessage,
} from "../src/lib/read-model-worker.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { createDemandBook } from "../src/lib/view-demand.js";
import { VIEW_VERSIONS_PATH } from "../src/lib/view-events.js";

const T0 = Date.parse("2026-10-09T08:00:00.000Z");
const LIVE = "ledger.ndjson";

type TestCtx = { after: (fn: () => void | Promise<void>) => void };

function scratch(t: TestCtx, kind: string): string {
  const dir = makeTempDir(kind);
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  return dir;
}

function handClock(start: number): { clock: Clock; advance: (ms: number) => void } {
  let ms = start;
  return { clock: { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() }, advance: (by) => void (ms += by) };
}

function row(ms: number): string {
  return `${JSON.stringify({ ts: new Date(ms).toISOString(), step: "run.start", task_id: "W1-T1", run_id: "r1" })}\n`;
}

function switchOn(stateDir: string, views: string[]): void {
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  writeFileSync(join(stateDir, "read-model", "switches.json"), JSON.stringify({ views: Object.fromEntries(views.map((v) => [v, "shadow"])) }));
}

async function until(done: () => boolean, what: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await sleep(5);
  assert.ok(done(), what);
}

function moduleFile(t: TestCtx, kind: string, source: string): URL {
  const path = join(scratch(t, kind), "module.mjs");
  writeFileSync(path, source);
  return pathToFileURL(path);
}

function projectorStates(stateDir: string, ledgerDir: string, clock: Clock): { states: ReadModelInstanceState[]; release: () => number } {
  const posted: ReadModelWorkerMessage[] = [];
  const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir }], clock, holder: "proj-holder", views: [], oracle: "off", post: (m) => void posted.push(m) });
  ticker.start();
  ticker.tick();
  const last = posted.findLast((m) => m.type === "state");
  return { states: last?.type === "state" ? last.instances : [], release: () => ticker.release() };
}

test("a read-paced view nobody reads is rebuilt at most once per stretched interval, and the next read rebuilds it on the next tick", (t) => {
  const stateDir = scratch(t, "paced-state");
  const ledgerDir = scratch(t, "paced-ledger");
  writeFileSync(join(ledgerDir, LIVE), row(T0));
  switchOn(stateDir, ["now", "steady"]);
  const hand = handClock(T0 + 1_000);
  const projector = projectorStates(stateDir, ledgerDir, hand.clock);
  t.after(() => void projector.release());
  const costMs = 400;
  const builds: Array<[string, number]> = [];
  const built = (name: string) => () => {
    builds.push([name, hand.clock.now()]);
    hand.advance(costMs);
    return [{ key: "", data: { at: hand.clock.now() }, sources: [] }];
  };
  // "now" stands in for the real view, in the lane's factory shape: a read of nav-badge reaches it through
  // READ_MODEL_VIEW_READERS, and the factory's flag paces it although the view it makes carries none.
  const views: Array<ReadModelView | ReadModelViewFactory> = [
    { name: "now", readPaced: true, create: () => ({ name: "now", version: 1, materialize: built("now") }) },
    { name: "steady", version: 1, materialize: built("steady") },
  ];
  const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir }], clock: hand.clock, holder: "proj-holder", views, viewsOnly: true, oracle: "off", post: () => {} });
  t.after(() => void ticker.release());
  ticker.observe(projector.states);
  const tickMs = 250;
  const run = (ms: number): void => {
    for (const end = hand.clock.now() + ms; hand.clock.now() < end;) {
      hand.advance(tickMs);
      ticker.tick();
    }
  };
  const count = (name: string, from: number): number => builds.filter(([n, at]) => n === name && at >= from).length;
  const baseWaitMs = costMs / READ_MODEL_VIEW_SHARE;

  run(READ_MODEL_READ_HOT_MS - 5_000);
  const hot = count("now", 0);
  assert.ok(hot >= 50, `inside the hot window it keeps the unstretched cadence: ${hot} builds`);
  assert.ok(Math.abs(hot - count("steady", 0)) <= 2, "the same cadence as an unpaced view of the same cost");

  // Past the window every unread build doubles the wait, up to the bound.
  const idleFrom = hand.clock.now();
  run(10 * 60_000);
  const nowStarts = builds.filter(([n, at]) => n === "now" && at >= idleFrom).map(([, at]) => at);
  const waits = nowStarts.slice(1).map((at, i) => at - nowStarts[i]! - costMs);
  const ladder = waits.map((ms) => Math.round(ms / baseWaitMs));
  const first = ladder.findIndex((stretch) => stretch >= 2);
  assert.deepEqual(ladder.slice(first, first + 7), [2, 4, 8, 16, READ_MODEL_IDLE_STRETCH_MAX, READ_MODEL_IDLE_STRETCH_MAX, READ_MODEL_IDLE_STRETCH_MAX], `the wait doubles per unread build, then holds at the bound: ${waits.join(", ")} ms`);
  const lastTenFrom = hand.clock.now();
  run(10 * 60_000);
  const idle = count("now", lastTenFrom);
  const steady = count("steady", lastTenFrom);
  assert.ok(steady >= 300, `a positive control: the unpaced view kept building, ${steady} builds`);
  assert.ok(idle <= Math.ceil((10 * 60_000) / (baseWaitMs * READ_MODEL_IDLE_STRETCH_MAX)) + 1, `unread, it was built ${idle} times in 10 min (unpaced: ${steady})`);

  // A read of a route that reads no paced view changes nothing.
  ticker.read("/v1/registry");
  const unrelated = hand.clock.now();
  run(tickMs * 4);
  assert.equal(count("now", unrelated), 0, "a read of an unrelated route does not rebuild it");

  // A read of a view built from it puts it back on its unstretched schedule at once.
  ticker.read("/v1/views/nav-badge");
  const readAt = hand.clock.now();
  run(tickMs);
  assert.equal(count("now", readAt), 1, "the next tick after a read rebuilds the stale unit");
  const readingFrom = hand.clock.now();
  for (let minute = 0; minute < 5; minute++) {
    ticker.read("/v1/views/nav-badge");
    run(60_000);
  }
  const reading = count("now", readingFrom);
  assert.ok(Math.abs(reading - count("steady", readingFrom)) <= 2, `read every minute, it keeps the unpaced cadence: ${reading} vs ${count("steady", readingFrom)}`);
});

test("the lane's now view is read-paced and no other built-in view is", () => {
  const lane = readModelLaneViews({ instances: [{ name: "core", ledgerDir: "/nonexistent" }] }, handClock(T0).clock, () => {}, createDemandBook());
  assert.deepEqual(lane.filter((view) => view.readPaced).map((view) => view.name), ["now"]);
});

test("a read reaches the views it reads directly or through a view built from them", () => {
  const names = ["now", "nav-badge", "repositories", "read-model"];
  assert.deepEqual(viewsReadBy("/v1/views/nav-badge", names).sort(), ["nav-badge", "needs-you", "now"]);
  assert.deepEqual(viewsReadBy("/v1/views/needs-you", names).sort(), ["needs-you", "now"]);
  assert.deepEqual(viewsReadBy("/v1/i/core/views/now", names), ["now"], "a per-instance copy reads what its core path does");
  assert.deepEqual(viewsReadBy("/v1/status", names).sort(), ["needs-you", "now"], "/v1/status carries needs-you's human gates");
  assert.deepEqual(viewsReadBy("/v1/i/site/status", names).sort(), ["needs-you", "now"]);
  assert.deepEqual(viewsReadBy(VIEW_VERSIONS_PATH, names), names, "a console polling every version reads every view");
  assert.deepEqual(viewsReadBy("/v1/registry", names), []);
  assert.deepEqual(viewsReadBy("/v1/views/repositories", names), ["repositories"]);
});

test("serve posts a path's read to the worker at most once per note interval, and only while a worker runs", async (t) => {
  const stateDir = scratch(t, "paced-note-state");
  const seen = join(scratch(t, "paced-note-seen"), "seen.txt");
  const workerUrl = moduleFile(t, "paced-note-worker", `import { parentPort } from "node:worker_threads";
import { appendFileSync } from "node:fs";
parentPort.on("message", (msg) => { if (msg.type === "read") appendFileSync(${JSON.stringify(seen)}, msg.path + "\\n"); });
setInterval(() => {}, 1000);
`);
  const hand = handClock(T0);
  const handle = createReadModelWorker({ stateDir, instances: [{ name: "core", ledgerDir: stateDir }], workerUrl, clock: hand.clock, every: () => () => undefined, stopWaitMs: 1 });
  t.after(() => void handle.stop());
  handle.noteViewRead?.("/v1/views/now");
  handle.start();
  handle.noteViewRead?.("/v1/views/now");
  handle.noteViewRead?.("/v1/views/now");
  hand.advance(READ_MODEL_READ_NOTE_MS - 1);
  handle.noteViewRead?.("/v1/views/now");
  handle.noteViewRead?.("/v1/status");
  hand.advance(1);
  handle.noteViewRead?.("/v1/views/now");
  const lines = (): string[] => (existsSync(seen) ? readFileSync(seen, "utf8").trim().split("\n") : []);
  await until(() => lines().length >= 3, "the worker received the posted reads");
  await sleep(50);
  assert.deepEqual(lines(), ["/v1/views/now", "/v1/status", "/v1/views/now"]);
});

test("a read reaches both view lanes from the projector thread", async (t) => {
  const inputs = join(scratch(t, "paced-lanes-inputs"), "inputs.txt");
  const workerUrl = moduleFile(t, "paced-lanes", `import { parentPort, workerData } from "node:worker_threads";
import { appendFileSync } from "node:fs";
const lane = workerData.lane;
parentPort.on("message", (msg) => appendFileSync(${JSON.stringify(inputs)}, lane + ":" + msg.type + (msg.type === "read" ? ":" + msg.path : "") + "\\n"));
if (lane === "fast") parentPort.postMessage({ type: "view_lane", view: "now", instance: "core", heavy: true, dueAt: 0, costMs: 2_700 });
setInterval(() => {}, 1000);
`);
  const lanes = threadViews({ data: { stateDir: "/nonexistent", instances: [], tickMs: 5, holder: "h" }, workerUrl, relay: () => {}, log: () => {}, every: () => () => undefined });
  t.after(() => lanes.close());
  const got = (): string[] => (existsSync(inputs) ? readFileSync(inputs, "utf8").trim().split("\n") : []);
  await until(() => got().includes("heavy:lane:now:true") || got().some((l) => l.startsWith("heavy:lane")), "the heavy lane was spawned");
  lanes.read("/v1/views/nav-badge");
  await until(() => got().includes("fast:read:/v1/views/nav-badge") && got().includes("heavy:read:/v1/views/nav-badge"), "both lanes received the read");
});

test("the view thread and the projector thread take a read message without failing", async (t) => {
  const stateDir = scratch(t, "paced-thread-state");
  const ledgerDir = scratch(t, "paced-thread-ledger");
  writeFileSync(join(ledgerDir, LIVE), row(Date.now()));
  switchOn(stateDir, ["extra"]);
  const projector = projectorStates(stateDir, ledgerDir, { now: () => Date.now(), date: () => new Date(), iso: () => new Date().toISOString() });
  t.after(() => void projector.release());
  const viewsModule = moduleFile(t, "paced-thread-module", `export default [{ name: "extra", version: 1, readPaced: true, materialize: () => [{ key: "", data: { extra: 1 }, sources: [] }] }];\n`).href;
  let onView: ((msg: ReadModelViewsInput) => void) | undefined;
  const viewPosted: ReadModelWorkerMessage[] = [];
  const viewPort = { on: (_e: "message", run: (msg: ReadModelViewsInput) => void) => void (onView = run), postMessage: (m: unknown) => void viewPosted.push(m as ReadModelWorkerMessage), close: () => {} };
  runReadModelViewWorker(viewPort, { stateDir, instances: [{ name: "core", ledgerDir }], tickMs: 5, holder: "proj-holder", viewsModule });
  t.after(() => onView?.({ type: "stop" }));
  onView?.({ type: "read", path: "/v1/views/extra" });
  onView?.({ type: "state", instances: projector.states });
  await until(() => viewPosted.some((m) => m.type === "body" && m.entry.view === "extra"), "the view thread built its body after a queued read");
  onView?.({ type: "read", path: "/v1/views/extra" });

  const workerState = scratch(t, "paced-projector-state");
  const workerLedger = scratch(t, "paced-projector-ledger");
  writeFileSync(join(workerLedger, LIVE), row(Date.now()));
  const posted: ReadModelWorkerMessage[] = [];
  let onMessage: ((msg: { type?: string }) => void) | undefined;
  const port = { on: (_event: "message", run: (msg: { type?: string }) => void) => void (onMessage = run), postMessage: (m: unknown) => void posted.push(m as ReadModelWorkerMessage), close: () => {} };
  runReadModelWorker(port, { kind: "remudero-read-model", stateDir: workerState, instances: [{ name: "core", ledgerDir: workerLedger }], tickMs: 5, signal: new SharedArrayBuffer(8) });
  t.after(() => onMessage?.({ type: "stop" }));
  onMessage?.({ type: "read", path: "/v1/views/read-model" } as { type: string });
  await until(() => posted.some((m) => m.type === "body" && m.entry.view === "read-model"), "the projector thread kept building after a read");
  assert.deepEqual(posted.filter((m) => m.type === "log" && /views_failed|views_exited|tick_failed/.test(m.step)).map((m) => m.type === "log" && m.step), []);
});
