import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import type { Clock } from "#src/lib/clock.js";
import { createReadModelTicker, readModelSwitchesPath, type ReadModelTickerOptions, type ReadModelView, type ReadModelWorkerMessage } from "#src/lib/read-model-worker.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { switchViewsOn } from "#test/helpers/read-model-switches.js";

const T0 = Date.parse("2026-10-07T12:00:00Z");
const WINDOW_MS = 10 * 60_000;

function rig(t: TestContext, makeViews: (spend: (ms: number) => void) => ReadModelView[], options: Partial<ReadModelTickerOptions> = {}) {
  const stateDir = makeTempDir("view-builds");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  let at = T0;
  const spend = (ms: number): void => { at += ms; };
  const clock: Clock = { now: () => at, date: () => new Date(at), iso: () => new Date(at).toISOString() };
  const views = makeViews(spend);
  switchViewsOn(stateDir, views.map((view) => view.name));
  writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ projector: "off", views: Object.fromEntries(views.map((view) => [view.name, "serve"])) }));
  const posted: ReadModelWorkerMessage[] = [];
  const ticker = createReadModelTicker({ stateDir, instances: [], views, clock, oracle: "off", passBudgetMs: 100, ...options, post: (message) => void posted.push(message) });
  t.after(() => ticker.release());
  if (options.viewsOnly) ticker.observe([]);
  ticker.start();
  const rows = (step = "read_model.view_builds") => posted.flatMap((message) => message.type === "log" && message.step === step ? [message.extra] : []);
  const flushAt = (time: number): void => {
    ticker.lane({ heavy: options.lane === "heavy", dueAt: Infinity });
    at = time;
    ticker.tick();
  };
  return { ticker, rows, flushAt, spend };
}

test("test/every-view-build-is-counted.test.ts: under-budget builds sum their costs and idle windows emit no row", (t) => {
  let cost = 10;
  const { ticker, rows, flushAt } = rig(t, (spend) => [{
    name: "cheap", version: 1,
    materialize: () => {
      spend(cost);
      return [{ key: "private-key", data: { secret: "private-body" }, sources: [] }];
    },
  }]);
  ticker.tick();
  cost = 20;
  ticker.buildNow("cheap");
  assert.deepEqual(rows(), [], "no per-build row before the ten-minute window");
  assert.deepEqual(rows("read_model.slow_view"), [], "both builds are under the pass budget");
  flushAt(T0 + WINDOW_MS - 1);
  assert.deepEqual(rows(), []);
  flushAt(T0 + WINDOW_MS);
  assert.deepEqual(rows(), [{ view: "cheap", thread: "projector", calls: 2, builds: 2, ms: 30, maxMs: 20, window: [T0, T0 + WINDOW_MS] }]);
  flushAt(T0 + 2 * WINDOW_MS);
  assert.equal(rows().length, 1, "an idle window writes no row");
  ticker.buildNow("cheap");
  flushAt(T0 + 3 * WINDOW_MS);
  assert.deepEqual(rows()[1], { view: "cheap", thread: "projector", calls: 1, builds: 1, ms: 20, maxMs: 20, window: [T0 + 2 * WINDOW_MS, T0 + 3 * WINDOW_MS] });
});

test("view build tallies include preparation cost, empty calls and failed calls without counting them as bodies", (t) => {
  let prepared = false;
  let result: "body" | "empty" | "throw" = "body";
  const { ticker, rows, flushAt } = rig(t, (spend) => [{
    name: "staged", version: 1,
    prepare: () => { spend(5); return prepared; },
    materialize: () => {
      spend(10);
      if (result === "throw") throw new Error("fixture materialization failed");
      return result === "empty" ? [] : [{ key: "a", data: 1, sources: [] }, { key: "b", data: 2, sources: [] }];
    },
  }]);
  ticker.tick();
  prepared = true;
  ticker.buildNow("staged");
  result = "empty";
  ticker.buildNow("staged");
  result = "throw";
  ticker.buildNow("staged");
  flushAt(T0 + WINDOW_MS);
  assert.deepEqual(rows(), [{ view: "staged", thread: "projector", calls: 3, builds: 1, ms: 50, maxMs: 15, window: [T0, T0 + WINDOW_MS] }]);
  assert.equal(rows("read_model.materialize_failed").length, 1);
});

test("a preparation pass with no materialize call or measured cost leaves the tally unchanged", (t) => {
  const { ticker, rows, flushAt } = rig(t, () => [{
    name: "waiting", version: 1, prepare: () => false,
    materialize: () => { throw new Error("not prepared"); },
  }]);
  ticker.tick();
  flushAt(T0 + WINDOW_MS);
  assert.deepEqual(rows(), []);
});

test("view build tallies separate views, instances, threads and lanes and preserve slow_view", (t) => {
  for (const lane of [undefined, "fast", "heavy"] as const) {
    const viewsOnly = lane !== undefined;
    const { ticker, rows, flushAt } = rig(t, (spend) => [
      { name: "wide", version: 1, perInstance: true, materialize: (ctx) => {
        spend(ctx.instances[0]!.state.instance === "core" ? 10 : 20);
        return [{ key: "", data: 1, sources: [] }];
      } },
      { name: "slow", version: 1, materialize: () => {
        spend(150);
        return [{ key: "", data: 1, sources: [] }];
      } },
    ], { viewsOnly, lane, instances: [{ name: "core", ledgerDir: "unused" }, { name: "console", ledgerDir: "unused" }] });
    if (lane === "heavy") ticker.lane({ heavy: true, dueAt: 0 });
    ticker.buildNow("wide");
    ticker.buildNow("slow");
    flushAt(T0 + WINDOW_MS);
    const thread = viewsOnly ? "views" : "projector";
    const location = { thread, ...(lane ? { lane } : {}) };
    assert.deepEqual(rows(), [
      { view: "wide", instance: "core", ...location, calls: 1, builds: 1, ms: 10, maxMs: 10, window: [T0, T0 + WINDOW_MS] },
      { view: "wide", instance: "console", ...location, calls: 1, builds: 1, ms: 20, maxMs: 20, window: [T0, T0 + WINDOW_MS] },
      { view: "slow", ...location, calls: 1, builds: 1, ms: 150, maxMs: 150, window: [T0, T0 + WINDOW_MS] },
    ]);
    assert.deepEqual(rows("read_model.slow_view"), [{ view: "slow", ms: 150, passMs: 100, thread }]);
  }
});
