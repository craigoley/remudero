// W1-T15003. OBSERVED 2026-11-26 16:35Z: serve's read-model worker ran at 114% CPU and 2.7 GB for 2h48m on a CPU-bound
// host, because W1-T14444 kept its heavy view lane warm whenever the now view served, read or not. Operator ruling
// 2026-11-26 16:55Z: let the heavy lane idle when no Console is open; a slower first load after idle is accepted.
// These run real threads: a stand-in module plays each lane's side, as in idle-serve-workers-end-and-restart-on-demand.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { Worker } from "node:worker_threads";
import type { Clock } from "#src/lib/clock.js";
import { READ_MODEL_HEAVY_IDLE_MS, threadViews, type ReadModelWorkerMessage } from "#src/lib/read-model-worker.js";
import { trackWorkerThreads } from "#src/lib/worker-heaps.js";
import { onReadModelClose, readModelFixtureDir } from "#test/helpers/read-model-fixture-dir.js";

/** The fast lane hands `now` to the heavy lane on `want move`; the heavy lane builds each unit it is handed. */
const LANE = `import { parentPort, workerData } from "node:worker_threads";
const lane = workerData.lane;
const alive = setInterval(() => {}, 1000);
const say = (step, extra = {}) => parentPort.postMessage({ type: "log", step, extra: { lane, ...extra } });
parentPort.on("message", (msg) => {
  if (msg.type === "stop") { clearInterval(alive); return parentPort.close(); }
  if (msg.type === "lane" && lane === "heavy" && msg.heavy) {
    parentPort.postMessage({ type: "view_unit", view: msg.view, phase: "start" });
    parentPort.postMessage({ type: "view_unit", view: msg.view, phase: "end" });
    say("fixture.built", { view: msg.view });
  }
  if (msg.type === "read") say("fixture.read", { path: msg.path });
  if (msg.type === "want" && msg.view === "move" && lane === "fast") parentPort.postMessage({ type: "view_lane", view: "now", heavy: true, dueAt: 0, costMs: 2000 });
});
`;

async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!done() && Date.now() < deadline) await sleep(5);
  assert.ok(done(), what);
}

/**
 * The lane manager as runReadModelWorker builds it while the now view serves. Before W1-T15003 the worker also passed
 * `keepWarm: () => heavyLaneKeptWarm({ now: "serve" })`, which is true; the hook is passed here to prove it is gone.
 */
function servingLanes(t: Parameters<typeof readModelFixtureDir>[0], name: string) {
  const dir = readModelFixtureDir(t, name).dir;
  const lanePath = join(dir, "lane.mjs");
  writeFileSync(lanePath, LANE);
  let ms = Date.parse("2026-11-26T17:00:00.000Z");
  const clock: Clock = { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() };
  let check: (() => void) | undefined;
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const relayed: ReadModelWorkerMessage[] = [];
  const book = trackWorkerThreads();
  const options = {
    data: { stateDir: dir, instances: [], tickMs: 50, holder: name }, workerUrl: pathToFileURL(lanePath), clock,
    every: (run: () => void) => { check = run; return () => void (check = undefined); },
    log: (step: string, extra: Record<string, unknown>) => void logs.push({ step, extra }),
    relay: (msg: ReadModelWorkerMessage) => void relayed.push(msg),
    keepWarm: () => true,
  };
  const lanes = threadViews(options as Parameters<typeof threadViews>[0]);
  onReadModelClose(t, async () => {
    lanes.close();
    await Promise.all(book.live().map(({ thread }) => (thread as Worker).terminate()));
    book.stop();
  });
  const said = (step: string) => relayed.flatMap((msg) => msg.type === "log" && msg.step === step ? [msg.extra] : []);
  const heavyBuilds = () => said("fixture.built").filter((row) => row.lane === "heavy").length;
  return {
    lanes, said, heavyBuilds,
    rows: (step: string) => logs.filter((row) => row.step === step).map((row) => row.extra),
    heavyThreads: () => book.live().filter(({ kind }) => kind.endsWith(":spawnHeavyViews")),
    moved: async () => {
      lanes.want("move", "");
      await until(() => heavyBuilds() === 1, "the heavy lane was spawned and built the unit it was handed");
    },
    advance: (by: number) => void (ms += by),
    check: () => { assert.ok(check, "the lane watch is scheduled"); check(); },
  };
}

test("W1-T15003 criterion 1: an unread worker stops rebuilding and the next read rebuilds", async (t) => {
  const r = servingLanes(t, "unread-stops");
  await r.moved();
  r.advance(READ_MODEL_HEAVY_IDLE_MS);
  r.check();
  assert.deepEqual(r.rows("read_model.view_lane_idle_ended"), [{ lane: "heavy", idleMs: READ_MODEL_HEAVY_IDLE_MS, units: 1 }],
    "unread for its window, the heavy lane ends even while the now view serves");
  await until(() => r.heavyThreads().length === 0, "the heavy thread exited, so nothing rebuilds its views");
  const built = r.heavyBuilds();
  r.advance(READ_MODEL_HEAVY_IDLE_MS * 3);
  r.check();
  await sleep(50);
  assert.equal(r.heavyBuilds(), built, "an unread, ended lane builds nothing more");

  assert.deepEqual(r.lanes.read("/v1/now"), { woke: "restarted" }, "the next read restarts the lane");
  await until(() => r.heavyBuilds() === built + 1, "the restarted lane rebuilds the unit it holds");
  await until(() => r.said("fixture.read").some((row) => row.lane === "heavy" && row.path === "/v1/now"), "the read is answered by the restarted lane");
  await until(() => r.rows("read_model.view_lane_restarted").length === 1, "the restart's first paint is logged");
});

test("W1-T15003 criterion 2: a read view rebuilds at today's pace", async (t) => {
  const r = servingLanes(t, "read-stays");
  await r.moved();
  for (let i = 0; i < 3; i++) {
    r.advance(READ_MODEL_HEAVY_IDLE_MS - 1);
    assert.deepEqual(r.lanes.read("/v1/now"), { woke: "none" }, "a read of a running lane restarts nothing");
    r.check();
  }
  assert.deepEqual(r.rows("read_model.view_lane_idle_ended"), [], "a lane read inside each window keeps running");
  assert.equal(r.heavyThreads().length, 1);
  await until(() => r.said("fixture.read").filter((row) => row.lane === "heavy").length === 3, "each read reaches the running lane");
  assert.deepEqual(r.rows("read_model.view_lane_restarted"), [], "a read lane is never cold-started");
});
