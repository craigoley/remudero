/**
 * The slow lane's thread died 75 times on its heap limit (2026-10-06 19:00Z to 10-08 00:46Z) and every
 * death row said only "JS heap out of memory": not which unit was running, for which instance, or how
 * far it got. The thread now names its work to its parent BEFORE starting it, the parent holds that,
 * and both death rows carry what was in flight and the termination's own code.
 */
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { ANALYTICS_VIEW_NAME } from "../src/lib/analytics-view.js";
import { runSlowLaneWorker, threadSlowLane, type SlowLaneMessage, type SlowLaneWork } from "../src/lib/read-model-slow-lane.js";
import { makeTempDir } from "../src/lib/tmp.js";

type Logged = { step: string; extra: Record<string, unknown> };

/** A module the lane's thread loads in place of the real one. */
function laneModule(t: TestContext, body: string): URL {
  const dir = makeTempDir("rmd-slow-lane-death");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "lane.mjs");
  writeFileSync(path, `import { parentPort } from "node:worker_threads";\n${body}\n`);
  return pathToFileURL(path);
}

async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!done() && Date.now() < deadline) await sleep(5);
  assert.ok(done(), "timed out");
}

test("a slow lane thread that dies on its heap names the unit, instance and phase it was in", async (t) => {
  // The thread reports a unit that finished, then one it never finishes, then dies with Node's own heap code.
  const workerUrl = laneModule(t, `parentPort.on("message", (msg) => {
  if (msg.type !== "lease" || !msg.held) return;
  const done = { unit: "inbox", phase: "run" };
  parentPort.postMessage({ type: "begin", work: done });
  parentPort.postMessage({ type: "end", work: done });
  parentPort.postMessage({ type: "begin", work: { unit: "analytics", instance: "core", phase: "read-checkpoint" } });
  parentPort.postMessage({ type: "begin", work: { unit: "analytics", instance: "core", phase: "scan-from-disk-checkpoint" } });
  setTimeout(() => { const e = new Error("Worker terminated due to reaching memory limit: JS heap out of memory"); e.code = "ERR_WORKER_OUT_OF_MEMORY"; throw e; }, 20);
});`);
  const logs: Logged[] = [];
  const lane = threadSlowLane({ config: { intervalMs: 60_000 }, workerUrl, log: (step, extra) => logs.push({ step, extra }) });
  t.after(() => lane.close());
  lane.lease(true);
  await until(() => logs.some((l) => l.step === "read_model.slow_lane_exited"));
  const failed = logs.find((l) => l.step === "read_model.slow_lane_failed")!;
  const exited = logs.find((l) => l.step === "read_model.slow_lane_exited")!;
  for (const row of [failed, exited]) {
    assert.equal(row.extra.termination, "ERR_WORKER_OUT_OF_MEMORY", `${row.step} names the termination`);
    const inFlight = row.extra.inFlight as Array<SlowLaneWork & { runningMs: number }>;
    assert.deepEqual(inFlight.map(({ runningMs: _, ...work }) => work), [{ unit: "analytics", instance: "core", phase: "scan-from-disk-checkpoint" }], `${row.step} names only the unfinished work, at its last phase`);
    assert.ok(inFlight[0]!.runningMs >= 0);
  }
});

test("a slow lane thread that exits with nothing in flight says so, and is not called a heap death", async (t) => {
  const workerUrl = laneModule(t, `parentPort.on("message", (msg) => {
  if (msg.type !== "lease" || !msg.held) return;
  parentPort.postMessage({ type: "begin", work: { unit: "feedback", phase: "run" } });
  parentPort.postMessage({ type: "end", work: { unit: "feedback", phase: "run" } });
  setTimeout(() => process.exit(3), 20);
});`);
  const logs: Logged[] = [];
  const lane = threadSlowLane({ config: { intervalMs: 60_000 }, workerUrl, log: (step, extra) => logs.push({ step, extra }) });
  t.after(() => lane.close());
  lane.lease(true);
  await until(() => logs.some((l) => l.step === "read_model.slow_lane_exited"));
  const exited = logs.find((l) => l.step === "read_model.slow_lane_exited")!;
  assert.deepEqual([exited.extra.code, exited.extra.termination, exited.extra.inFlight], [3, "exit", []]);
  assert.equal(logs.some((l) => l.step === "read_model.slow_lane_failed"), false);
});

test("the slow lane names each unit and analytics refresh to its parent before it starts and after it ends", async (t) => {
  const posted: SlowLaneMessage[] = [];
  let onMessage: ((msg: { type?: string; held?: unknown; modes?: unknown }) => void) | undefined;
  const beforeRefresh: string[] = [];
  const stateDir = makeTempDir("rmd-slow-lane-begin");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const handle = runSlowLaneWorker({ on: (_event, run) => (onMessage = run), postMessage: (m) => void posted.push(m as SlowLaneMessage) }, { analytics: { instances: [{ name: "core", stateDir }] }, intervalMs: 60_000 }, {
    schedule: () => () => undefined,
    analyticsRefresh: async () => {
      for (const m of posted) if (m.type === "begin") beforeRefresh.push(`${m.work.unit}/${m.work.instance ?? "-"}/${m.work.phase}`);
      throw new Error("stub refresh");
    },
  });
  t.after(() => handle.stop());
  onMessage?.({ type: "views", modes: { [ANALYTICS_VIEW_NAME]: "shadow" } });
  onMessage?.({ type: "lease", held: true });
  await until(() => posted.some((m) => m.type === "source_snapshot"));
  await until(() => posted.some((m) => m.type === "end" && m.work.instance === "core"));
  assert.deepEqual(beforeRefresh, ["analytics/-/run", "analytics/core/read-checkpoint", "analytics/core/scan-from-disk-checkpoint"], "posted before the refresh ran");
  const order = posted.flatMap((m) => (m.type === "begin" || m.type === "end" ? [`${m.type}:${m.work.unit}/${m.work.instance ?? "-"}/${m.work.phase}`] : []));
  assert.deepEqual(order.filter((s) => s.includes("/core/")).at(-1), "end:analytics/core/scan-from-disk-checkpoint", "a failed refresh still ends its work");
  assert.deepEqual(order.filter((s) => s.endsWith("/-/run")), ["begin:analytics/-/run", "end:analytics/-/run"]);
});
