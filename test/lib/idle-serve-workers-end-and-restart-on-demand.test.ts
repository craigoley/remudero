// W1-T11937: serve's heavy view lane held about 0.86 GB of heap while no console was open (serve
// research, 2026-11-10). With no read for READ_MODEL_HEAVY_IDLE_MS the lane ends between builds and
// gives that heap back; the next read starts it again, hands it its units, and the first paint of
// the restart is logged as a ledger row. A restart that fails is told to the caller and retried by
// the next read. These run real threads: a lane stand-in module plays each lane's side.
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

/**
 * Each lane's side. The fast lane hands `now` to the heavy lane on `want move`; the heavy lane says
 * which units it was handed, starts a build on `want build`, finishes it on `want built`, and paints
 * (a finished build) the unit it is handed when it is restarted. It stays alive until stopped.
 */
const lane = (onStop: string): string => `import { parentPort, workerData, threadId } from "node:worker_threads";
const lane = workerData.lane;
const alive = setInterval(() => {}, 1000);
const say = (step, extra = {}) => parentPort.postMessage({ type: "log", step, extra: { lane, threadId, ...extra } });
parentPort.on("message", (msg) => {
  if (msg.type === "stop") { ${onStop} }
  if (msg.type === "lane") {
    // The paint comes BEFORE the log: the parent reads a port in order, so once the log is seen the
    // unit's start and end already are, and the thread is not mid-build in the parent's eyes.
    if (lane === "heavy" && msg.heavy) {
      parentPort.postMessage({ type: "view_unit", view: msg.view, phase: "start" });
      parentPort.postMessage({ type: "view_unit", view: msg.view, phase: "end" });
    }
    say("fixture.lane", { view: msg.view, heavy: msg.heavy });
  }
  if (msg.type === "read") say("fixture.read", { path: msg.path });
  if (msg.type !== "want") return;
  if (msg.view === "move" && lane === "fast") parentPort.postMessage({ type: "view_lane", view: "now", heavy: true, dueAt: 0, costMs: 2000 });
  if (msg.view === "build" && lane === "heavy") parentPort.postMessage({ type: "view_unit", view: "now", phase: "start" });
  if (msg.view === "built" && lane === "heavy") parentPort.postMessage({ type: "view_unit", view: "now", phase: "end" });
  say("fixture.want", { view: msg.view });
});
say("fixture.started");
`;
const LANE = lane(`clearInterval(alive); say("fixture.stopped"); return parentPort.close();`);
/** A lane that starts a build as it is asked to stop, finishes it 2.5 s later, and never exits by itself. */
const STUBBORN = lane(`say("fixture.stopped"); parentPort.postMessage({ type: "view_unit", view: "now", phase: "start" });
    setTimeout(() => { say("fixture.built"); parentPort.postMessage({ type: "view_unit", view: "now", phase: "end" }); }, 2_500); return;`);

/** A lane that dies as it starts, before any paint. */
const DYING = `process.exit(5);\n`;

async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!done() && Date.now() < deadline) await sleep(5);
  assert.ok(done(), what);
}

function rig(t: Parameters<typeof readModelFixtureDir>[0], name: string) {
  const dir = readModelFixtureDir(t, name).dir;
  const lanePath = join(dir, "lane.mjs");
  const dyingPath = join(dir, "dying.mjs");
  const stubbornPath = join(dir, "stubborn.mjs");
  writeFileSync(lanePath, LANE);
  writeFileSync(dyingPath, DYING);
  writeFileSync(stubbornPath, STUBBORN);
  let ms = Date.parse("2026-11-10T12:00:00.000Z");
  const clock: Clock = { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() };
  let check: (() => void) | undefined;
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const relayed: ReadModelWorkerMessage[] = [];
  const book = trackWorkerThreads();
  const options: Parameters<typeof threadViews>[0] = {
    data: { stateDir: dir, instances: [], tickMs: 50, holder: name }, workerUrl: pathToFileURL(lanePath), clock,
    every: (run) => { check = run; return () => void (check = undefined); },
    log: (step, extra) => void logs.push({ step, extra }), relay: (msg) => void relayed.push(msg),
  };
  const lanes = threadViews(options);
  onReadModelClose(t, async () => {
    lanes.close();
    await Promise.all(book.live().map(({ thread }) => (thread as Worker).terminate()));
    book.stop();
  });
  const rows = (step: string): Array<Record<string, unknown>> => logs.filter((row) => row.step === step).map((row) => row.extra);
  const said = (step: string): Array<Record<string, unknown>> =>
    relayed.flatMap((msg) => msg.type === "log" && msg.step === step ? [msg.extra] : []);
  const heavyThreads = () => book.live().filter(({ kind }) => kind.endsWith(":spawnHeavyViews"));
  /** Moves `now` to the heavy lane and waits until the heavy thread holds it. */
  const moved = async (): Promise<void> => {
    lanes.want("move", "");
    await until(() => said("fixture.lane").some((row) => row.lane === "heavy"), "the heavy lane was spawned and handed its unit");
  };
  return {
    lanes, rows, said, heavyThreads, moved, options, dyingUrl: pathToFileURL(dyingPath), stubbornUrl: pathToFileURL(stubbornPath), laneUrl: pathToFileURL(lanePath),
    advance: (by: number) => void (ms += by),
    check: () => { assert.ok(check, "the lane watch is scheduled"); check(); },
  };
}

test("W1-T11937 criterion 1: a heavy view lane with no read for the idle window ends and releases its heap", async (t) => {
  const r = rig(t, "idle-ends");
  await r.moved();
  const [thread] = r.heavyThreads();
  assert.ok(thread, "control: the heavy lane is a live thread before the window passes");
  r.advance(READ_MODEL_HEAVY_IDLE_MS - 1);
  r.check();
  assert.deepEqual(r.rows("read_model.view_lane_idle_ended"), [], "one millisecond short of the window, the lane keeps running");
  assert.equal(r.heavyThreads().length, 1);

  r.advance(1);
  r.check();
  assert.deepEqual(r.rows("read_model.view_lane_idle_ended"), [{ lane: "heavy", idleMs: READ_MODEL_HEAVY_IDLE_MS, units: 1 }]);
  await until(() => r.heavyThreads().length === 0, "the heavy thread exited, so its isolate and heap are gone");
  assert.equal(thread.thread.threadId, -1, "an exited Worker reads threadId -1: its isolate is destroyed");
  await assert.rejects(Promise.resolve().then(() => thread.thread.getHeapStatistics()), "an ended thread has no heap left to read");
  assert.deepEqual(r.rows("read_model.views_exited"), [], "an idle end is not a death: no respawn is scheduled");
  assert.deepEqual(r.rows("read_model.view_lane_reclaimed"), [], "its units stay the heavy lane's, so the fast lane does not build them");
  r.check();
  assert.equal(r.rows("read_model.view_lane_idle_ended").length, 1, "an ended lane is ended once");
});

test("W1-T11937 criterion 2: the first read after the lane ended restarts it, is answered, and logs the restart's first paint", async (t) => {
  const r = rig(t, "read-restarts");
  await r.moved();
  r.advance(READ_MODEL_HEAVY_IDLE_MS);
  r.check();
  await until(() => r.heavyThreads().length === 0, "the idle lane ended");
  const started = r.said("fixture.started").filter((row) => row.lane === "heavy").length;

  assert.deepEqual(r.lanes.read("/v1/now"), { woke: "restarted" }, "the read tells its caller it restarted the lane");
  r.advance(250);
  await until(() => r.rows("read_model.view_lane_restarted").length === 1, "the restart's first paint was logged");
  assert.deepEqual(r.rows("read_model.view_lane_restarted"), [{ lane: "heavy", firstPaintMs: 250, units: 1 }]);
  assert.equal(r.said("fixture.started").filter((row) => row.lane === "heavy").length, started + 1, "a new heavy thread started");
  assert.equal(r.heavyThreads().length, 1);
  // The stand-in paints BEFORE it logs the unit it was handed, so the paint's row can be seen first.
  await until(() => r.said("fixture.lane").filter((row) => row.lane === "heavy").length >= 2, "the restarted lane is handed the units it held");
  await until(() => r.said("fixture.read").some((row) => row.lane === "heavy" && row.path === "/v1/now"), "the restarted lane is sent the read");
  assert.deepEqual(r.lanes.read("/v1/now"), { woke: "none" }, "a read of a running lane restarts nothing");
});

test("W1-T11937 criterion 3: a heavy lane mid-build is never ended, and the idle window is the declared ten-minute constant", async (t) => {
  assert.equal(READ_MODEL_HEAVY_IDLE_MS, 10 * 60_000, "the idle window is ten minutes");
  const r = rig(t, "never-mid-build");
  await r.moved();
  await until(() => r.rows("read_model.view_lane_moved").length === 1, "control: the move was relayed");
  // Start a build: `want` is not a read of the lane's views, but it does count as demand, so age past it.
  r.lanes.want("build", "");
  await until(() => r.said("fixture.want").some((row) => row.lane === "heavy" && row.view === "build"), "the heavy lane started its build");
  r.advance(READ_MODEL_HEAVY_IDLE_MS * 3);
  for (let i = 0; i < 3; i++) {
    r.check();
    await sleep(20);
  }
  assert.deepEqual(r.rows("read_model.view_lane_idle_ended"), [], "a lane mid-build is left to finish, however long idle");
  assert.equal(r.heavyThreads().length, 1);
  assert.ok(!r.said("fixture.stopped").some((row) => row.lane === "heavy"), "it was never even asked to stop");

  r.lanes.want("built", "");
  await until(() => r.said("fixture.want").some((row) => row.lane === "heavy" && row.view === "built"), "the heavy lane finished its build");
  r.advance(READ_MODEL_HEAVY_IDLE_MS);
  r.check();
  assert.equal(r.rows("read_model.view_lane_idle_ended").length, 1, "once the build ends, the idle lane ends");
  await until(() => r.heavyThreads().length === 0, "the heavy thread exited after its build");
});

test("W1-T11937 criterion 3: a lane that starts a build as it is stopped is terminated only after the build ends", async (t) => {
  const r = rig(t, "stop-mid-build");
  r.options.workerUrl = r.stubbornUrl;
  await r.moved();
  r.advance(READ_MODEL_HEAVY_IDLE_MS);
  r.check();
  assert.equal(r.rows("read_model.view_lane_idle_ended").length, 1, "control: the idle lane was asked to stop");
  await until(() => r.said("fixture.stopped").some((row) => row.lane === "heavy"), "the lane began a build as it was stopped");
  await sleep(2_200);
  assert.equal(r.heavyThreads().length, 1, "past the stop wait, a thread still mid-build is not terminated");
  assert.ok(!r.said("fixture.built").length, "control: its build had not ended yet");
  await until(() => r.said("fixture.built").length === 1, "its build ended");
  await until(() => r.heavyThreads().length === 0, "a thread that outlives its stop is terminated once its build has ended");
});

test("W1-T11937 criterion 4: a lane that fails to restart reports it to the caller, and the next read retries it", async (t) => {
  const r = rig(t, "restart-fails");
  await r.moved();
  r.advance(READ_MODEL_HEAVY_IDLE_MS);
  r.check();
  await until(() => r.heavyThreads().length === 0, "the idle lane ended");

  // A restart that cannot construct its thread fails in the read's own call.
  r.options.workerUrl = new URL("http://invalid.example/lane.mjs");
  const refused = r.lanes.read("/v1/now");
  assert.equal(refused.woke, "failed");
  assert.match((refused as { error: string }).error, /scheme/i, "the caller is told why the restart failed");
  assert.deepEqual(r.rows("read_model.view_lane_restart_failed").map((row) => row.lane), ["heavy"]);
  assert.equal(r.heavyThreads().length, 0);

  // A restart whose thread dies before its first paint is ledgered, and leaves the lane to the next read.
  r.options.workerUrl = r.dyingUrl;
  assert.deepEqual(r.lanes.read("/v1/now"), { woke: "restarted" });
  await until(() => r.rows("read_model.view_lane_restart_failed").length === 2, "the dying restart was reported");
  assert.deepEqual(r.rows("read_model.view_lane_restart_failed")[1], { lane: "heavy", code: 5 });
  assert.deepEqual(r.rows("read_model.views_exited"), [], "a failed restart is not scheduled as a death's respawn");

  r.options.workerUrl = r.laneUrl;
  assert.deepEqual(r.lanes.read("/v1/now"), { woke: "restarted" }, "the next read retries the restart");
  await until(() => r.rows("read_model.view_lane_restarted").length === 1, "the retried restart painted");
  assert.equal(r.heavyThreads().length, 1);
});
