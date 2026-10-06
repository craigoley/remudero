import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Clock } from "../src/lib/clock.js";
import { NAV_BADGE_VIEW_NAME } from "../src/lib/nav-badge-view.js";
import { NEEDS_YOU_VIEW_NAME } from "../src/lib/needs-you-view.js";
import { NOW_VIEW_NAME } from "../src/lib/now-view.js";
import { OPERATOR_AGENT_ROWS_VIEW } from "../src/lib/operator-agent-read-model.js";
import {
  createReadModelTicker,
  READ_MODEL_VIEW_READERS,
  readModelSwitchesPath,
  readModelViewBuilt,
  type ReadModelSwitches,
  type ReadModelView,
  type ReadModelViewReaders,
  type ReadModelWorkerMessage,
} from "../src/lib/read-model-worker.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { READ_MODEL_STATUS_VIEW } from "../src/lib/views.js";

const T0 = Date.parse("2026-10-05T12:00:00.000Z");

function scratch(t: { after: (fn: () => void) => void }, kind: string): string {
  const dir = makeTempDir(kind);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function steppedClock(): { clock: Clock; advance: (ms: number) => void } {
  let ms = T0;
  return { clock: { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() }, advance: (by) => void (ms += by) };
}

/** A view that counts its builds; `cost` advances the clock so the build is measured as that long. */
function counted(name: string, advance?: (ms: number) => void, cost = 0): ReadModelView & { builds: () => number } {
  let builds = 0;
  return {
    name,
    version: 1,
    materialize: () => {
      builds++;
      advance?.(cost);
      return [{ key: "", data: { name }, sources: [] }];
    },
    builds: () => builds,
  };
}

function fixture(t: { after: (fn: () => void) => void }, views: ReadModelView[], switches: Record<string, unknown>, readers: ReadModelViewReaders, extra: { passBudgetMs?: number; advance?: Clock } = {}) {
  const stateDir = scratch(t, "no-switch-state");
  const ledgerDir = scratch(t, "no-switch-ledger");
  mkdirSync(ledgerDir, { recursive: true });
  writeFileSync(join(ledgerDir, "ledger.ndjson"), `${JSON.stringify({ ts: new Date(T0 - 1000).toISOString(), step: "run.start", task_id: "T1", run_id: "r1" })}\n`);
  mkdirSync(dirname(readModelSwitchesPath(stateDir)), { recursive: true });
  writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify(switches));
  const messages: ReadModelWorkerMessage[] = [];
  const ticker = createReadModelTicker({
    stateDir, instances: [{ name: "core", ledgerDir }], post: (m) => void messages.push(m), oracle: "off", views, readers,
    ...(extra.advance ? { clock: extra.advance } : {}), ...(extra.passBudgetMs !== undefined ? { passBudgetMs: extra.passBudgetMs } : {}),
  });
  t.after(() => ticker.release());
  const bodies = (): string[] => [...new Set(messages.flatMap((m) => (m.type === "body" ? [m.entry.view] : [])))].sort();
  const logs = (step: string) => messages.flatMap((m) => (m.type === "log" && m.step === step ? [m.extra] : []));
  return { ticker, bodies, logs };
}

test("with switches naming one served view that reads another view's body and nothing else, a view absent from the switches with no served dependent is never materialized, a view switched off explicitly is never materialized, the served view is built, and the absent view the served one reads is still built", (t) => {
  const served = counted("served");
  const input = counted("input");
  const dark = counted("dark");
  const off = counted("off-view");
  const readers: ReadModelViewReaders = { input: [{ consumer: "served", reader: "the served view's composer", view: "served" }] };
  const f = fixture(t, [served, input, dark, off], { views: { served: "serve", "off-view": "off" } }, readers);
  f.ticker.start();
  for (let i = 0; i < 3; i++) f.ticker.tick();
  f.ticker.buildNow("dark");
  f.ticker.buildNow("off-view");
  f.ticker.buildNow("input");

  assert.equal(dark.builds(), 0, "a view with no switch and no served reader is never materialized, by tick or by buildNow");
  assert.equal(off.builds(), 0, "an explicit off stays off");
  assert.ok(served.builds() > 0, "the served view is built");
  assert.ok(input.builds() > 0, "the absent view a served one reads is still built");
  assert.deepEqual(f.bodies(), ["input", "served"]);
});

test("an absent view's input is dropped once its only reader is switched off, and an explicit off beats a served reader", () => {
  const readers: ReadModelViewReaders = {
    input: [{ consumer: "served", reader: "composer", view: "served" }],
    chain: [{ consumer: "input", reader: "input's composer", view: "input" }],
    always: [{ consumer: "GET /v1/always", reader: "a route served whatever the switches say" }],
  };
  const on: ReadModelSwitches = { projector: "on", views: { served: "auto" } };
  assert.equal(readModelViewBuilt("input", on, readers), true);
  assert.equal(readModelViewBuilt("chain", on, readers), true, "an input of an input of a served view is built");
  assert.equal(readModelViewBuilt("input", { projector: "on", views: { served: "off" } }, readers), false);
  assert.equal(readModelViewBuilt("chain", { projector: "on", views: {} }, readers), false);
  assert.equal(readModelViewBuilt("input", { projector: "on", views: { served: "serve", input: "off" } }, readers), false, "an explicit off stays off");
  assert.equal(readModelViewBuilt("always", { projector: "on", views: {} }, readers), true);
  assert.equal(readModelViewBuilt("lonely", { projector: "on", views: { lonely: "shadow" } }, readers), true, "a set switch builds as before");
  const loop: ReadModelViewReaders = { a: [{ consumer: "b", reader: "b", view: "b" }], b: [{ consumer: "a", reader: "a", view: "a" }] };
  assert.equal(readModelViewBuilt("a", { projector: "on", views: {} }, loop), false, "a reader cycle with nothing served ends");
});

test("the declared readers keep now, the status view and the operator-agent rows built with an empty switch file, and nothing else", () => {
  const empty: ReadModelSwitches = { projector: "on", views: {} };
  const built = ["nav-badge", "repositories", READ_MODEL_STATUS_VIEW, NOW_VIEW_NAME, "instances", "task", "inbox-thread", "workstreams", "agent", "incidents", OPERATOR_AGENT_ROWS_VIEW, "analytics", "host"]
    .filter((view) => readModelViewBuilt(view, empty));
  assert.deepEqual(built, [READ_MODEL_STATUS_VIEW, NOW_VIEW_NAME, OPERATOR_AGENT_ROWS_VIEW]);
  assert.ok(READ_MODEL_VIEW_READERS[NEEDS_YOU_VIEW_NAME], "needs-you's readers are declared under its real name");
  assert.ok(READ_MODEL_VIEW_READERS[NEEDS_YOU_VIEW_NAME]!.some((edge) => edge.view === NAV_BADGE_VIEW_NAME));
  for (const edges of Object.values(READ_MODEL_VIEW_READERS)) for (const edge of edges) assert.ok(edge.reader.length > 0, "every edge names its reader");
});

test("a view built only for its readers carries what it has cost on its slow_view row", (t) => {
  const { clock, advance } = steppedClock();
  const served = counted("served");
  const input = counted("input", advance, 50);
  const readers: ReadModelViewReaders = { input: [{ consumer: "served", reader: "composer", view: "served" }] };
  const f = fixture(t, [served, input], { views: { served: "serve" } }, readers, { advance: clock, passBudgetMs: 10 });
  f.ticker.start();
  f.ticker.buildNow("input");
  f.ticker.buildNow("input");
  f.ticker.buildNow("served");
  const rows = f.logs("read_model.slow_view");
  assert.deepEqual(rows.filter((row) => row.view === "input").map((row) => row.unswitched), [{ builds: 1, ms: 50 }, { builds: 2, ms: 100 }]);
  assert.ok(rows.every((row) => row.view === "input"), "a fast switched view writes no slow_view row");
});
