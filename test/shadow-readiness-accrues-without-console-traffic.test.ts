import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { Clock } from "../src/lib/clock.js";
import { createReadModelWorker, READ_MODEL_SWITCH_RECHECK_MS, readModelStatusView, readModelSwitchesPath, type ReadModelBodyEntry } from "../src/lib/read-model-worker.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { createShadowSampler, VIEW_SHADOW_DIFF_STEP, VIEW_SHADOW_SAMPLE_MS, withViewShadow } from "../src/lib/view-shadow.js";
import type { ViewDefinition } from "../src/lib/views.js";

const T0 = Date.parse("2026-10-01T03:00:00.000Z");
/** The prefix test/the-shadow-readiness-test-stops-its-worker-before-cleanup.test.ts reads the cleanup order by. */
const SHADOW_CLEANUP_NOTE = "shadow-readiness cleanup:";

/**
 * W1-T5461: ONE after-hook owns the order. node:test runs `t.after` hooks first-registered-first and
 * skips the rest once one throws, so a separate `rmSync` hook ran while the restarted worker still
 * wrote (ENOTEMPTY) and the stop hook behind it never ran; the live thread held the shard open.
 * The retries outlast the view thread's READ_MODEL_STOP_WAIT_MS terminate, which `stop()` does not await.
 */
function scratch(t: TestContext, kind: string): { dir: string; stopsFirst: (worker: { stop(): boolean }) => void } {
  const dir = makeTempDir(kind);
  const workers: Array<{ stop(): boolean }> = [];
  t.after(() => {
    for (const worker of workers) {
      worker.stop();
      t.diagnostic(`${SHADOW_CLEANUP_NOTE} worker stopped`);
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    t.diagnostic(`${SHADOW_CLEANUP_NOTE} scratch removed`);
  });
  return { dir, stopsFirst: (worker) => void workers.push(worker) };
}

async function until(done: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2_000 && !done(); i++) await sleep(10);
  assert.ok(done(), what);
}

type Readiness = { view: string; requests: number; samples: number };
const shownShadow = (entry: ReadModelBodyEntry | undefined): Readiness[] | undefined => (entry?.body.data as { shadow?: Readiness[] } | undefined)?.shadow;

test("a shadowed view is compared on the driver cadence with no console request at all", async (t) => {
  const { dir: stateDir, stopsFirst } = scratch(t, "shadow-drive");
  writeFileSync(join(stateDir, "ledger.ndjson"), `${JSON.stringify({ ts: new Date(T0).toISOString(), step: "run.start", task_id: "W1-T1" })}\n`);
  mkdirSync(dirname(readModelSwitchesPath(stateDir)), { recursive: true });
  writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ projector: "on", views: { "read-model": "shadow", repositories: "serve" } }));
  const timers = new Map<number, () => void>();
  const every = (run: () => void, ms: number): (() => void) => {
    timers.set(ms, run);
    return () => void timers.delete(ms);
  };
  const logs: Array<[string, Record<string, unknown> | undefined]> = [];
  const handle = createReadModelWorker({ stateDir, instances: [{ name: "core", ledgerDir: stateDir }], tickMs: 20, every, log: (step, extra) => void logs.push([step, extra]) });
  stopsFirst(handle);
  const legacy: ViewDefinition = { name: readModelStatusView.name, version: 1, compute: () => ({ data: { instances: [] }, sources: [] }) };
  const served: ViewDefinition = { name: "repositories", version: 1, compute: () => ({ data: { instances: ["differs"] }, sources: [] }) };
  const opts = withViewShadow(handle, { legacy: [legacy, served], readModel: handle, servedByDefault: [readModelStatusView.name] });
  assert.equal(typeof opts.shadow, "function");
  handle.start();
  await until(() => handle.body("read-model") !== undefined && handle.body("repositories") !== undefined, "the worker posted both bodies");
  assert.equal(shownShadow(handle.body("read-model")), undefined, "nothing compared yet, so no readiness");

  const drive = timers.get(READ_MODEL_SWITCH_RECHECK_MS);
  assert.ok(drive, "the switch watch drives the shadowed views");
  drive();
  drive();
  await until(() => logs.some(([step]) => step === VIEW_SHADOW_DIFF_STEP), "the driven sample was compared in the worker");
  await until(() => shownShadow(handle.body("read-model")) !== undefined, "the status view shows readiness");
  assert.deepEqual(logs.filter(([step]) => step === VIEW_SHADOW_DIFF_STEP).map(([, extra]) => extra?.view), ["read-model"], "only the shadowed view is driven, never a served one");
  assert.deepEqual(shownShadow(handle.body("read-model"))!.map((r) => [r.view, r.requests, r.samples]), [["read-model", 0, 1]], "a driven sample is a sample, not a request");
  handle.stop();
  assert.equal(timers.has(READ_MODEL_SWITCH_RECHECK_MS), false, "stopping the handle stops the driver");

  const again = createReadModelWorker({ stateDir, instances: [{ name: "core", ledgerDir: stateDir }], tickMs: 20, every: () => () => {} });
  stopsFirst(again);
  const posted: ReadModelBodyEntry[] = [];
  again.onBody((entry) => void (entry.view === "read-model" && posted.push(entry)));
  again.start();
  await until(() => posted.length > 0, "the restarted worker posted its status body");
  assert.deepEqual(shownShadow(posted[0])?.map((r) => [r.view, r.samples]), [["read-model", 1]], "readiness shows from the persisted counters before any compare after a restart");
});

test("a driven sample stands for no request and shares the per-key throttle with real requests", () => {
  let ms = T0;
  const clock: Clock = { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() };
  const sent: Array<[string, number]> = [];
  const sample = createShadowSampler({ clock, defer: (run) => run(), send: ({ key, requests }) => void sent.push([key, requests]) });
  sample("v", "", new URLSearchParams(), true);
  sample("v", "", new URLSearchParams());
  sample("v", "", new URLSearchParams(), true);
  ms += VIEW_SHADOW_SAMPLE_MS;
  sample("v", "", new URLSearchParams(), true);
  ms += VIEW_SHADOW_SAMPLE_MS;
  sample("v", "", new URLSearchParams(), true);
  assert.deepEqual(sent, [["", 0], ["", 1], ["", 0]], "the real request inside the period rides on the next driven sample, and a driven offer adds none");
});
