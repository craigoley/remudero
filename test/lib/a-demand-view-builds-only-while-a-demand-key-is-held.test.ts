// W1-T11934: daily-progress (603 builds in 600 s) and code-health (621) are declared demand-only, yet with no
// console open they rebuilt about once per second (serve research, 2026-11-10).
//
// MEASURED CAUSE (criterion 3): demand views were NOT DEMAND-GATED. The ticker's due set scheduled a demand
// unit on its cost cadence like any other unit. Nothing checked whether its demand book held a key for it.
// Both views' `materialize` also adds default keys (today and yesterday, or the all-repository scope) to the
// book's keys, so every due build produced bodies nobody asked for. The other two candidates are ruled out
// below: the book stays empty on every tick, so no key is held open and no build re-arms demand. The fix gates
// the due set on the book holding a key the unit owns. It applies to every view declared demand, by flag,
// never by name.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import type { Clock } from "#src/lib/clock.js";
import { createReadModelTicker, readModelSwitchesPath, type ReadModelView } from "#src/lib/read-model-worker.js";
import { createDemandBook, type DemandBook } from "#src/lib/view-demand.js";
import { switchViewsOn } from "#test/helpers/read-model-switches.js";
import { onReadModelClose, readModelFixtureDir } from "#test/helpers/read-model-fixture-dir.js";

const T0 = Date.parse("2026-11-10T12:00:00Z");
const TICK_MS = 1_000;
const WINDOW_MS = 10 * 60_000;
const COST_MS = 10;
/** The production names plus one generic name, so a fix that special-cases the two names fails here. */
const DEMAND_VIEWS = ["daily-progress", "code-health", "a-second-demand-view"];
const PLAIN_VIEW = "a-plain-view";
/** The ticker starts at most one unmeasured unit a tick, so every unit is measured after this. */
const WARM_MS = (DEMAND_VIEWS.length + 1) * TICK_MS;

function rig(t: TestContext, evictMs?: number) {
  const stateDir = readModelFixtureDir(t, "demand-gate").dir;
  let at = T0;
  const clock: Clock = { now: () => at, date: () => new Date(at), iso: () => new Date(at).toISOString() };
  const book: DemandBook = createDemandBook({ clock, ...(evictMs === undefined ? {} : { evictMs }) });
  const builds = new Map<string, number[]>();
  // Shaped like daily-progress and code-health: a default key is built whatever the book holds.
  const view = (name: string, demand: boolean): ReadModelView => ({
    name, version: 1, ...(demand ? { demand: true as const } : {}),
    materialize: () => {
      builds.set(name, [...builds.get(name) ?? [], at]);
      at += COST_MS;
      return [...new Set(["", ...demand ? book.keys(name) : []])].map(key => ({ key, data: { name, key }, sources: [] }));
    },
  });
  const views = [...DEMAND_VIEWS.map(name => view(name, true)), view(PLAIN_VIEW, false)];
  switchViewsOn(stateDir, views.map(v => v.name));
  writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ projector: "off", views: Object.fromEntries(views.map(v => [v.name, "serve"])) }));
  const ticker = createReadModelTicker({ stateDir, instances: [], views, clock, oracle: "off", passBudgetMs: 100, demand: book, post: () => {} });
  onReadModelClose(t, () => ticker.release());
  ticker.start();
  const heldKeys: number[] = [];
  /** Ticks once per second until `until`, recording how many keys the book held after each tick. */
  const runUntil = (until: number): void => {
    while (at < until) {
      ticker.tick();
      heldKeys.push(DEMAND_VIEWS.reduce((sum, name) => sum + book.keys(name).length, 0));
      at = Math.max(at, Math.floor((at - T0) / TICK_MS) * TICK_MS + T0 + TICK_MS);
    }
  };
  const count = (name: string, from = Number.NEGATIVE_INFINITY, to = Number.POSITIVE_INFINITY): number =>
    (builds.get(name) ?? []).filter(time => time >= from && time < to).length;
  return { ticker, book, runUntil, count, heldKeys, builds, now: () => at };
}

test("W1-T11934 criterion 1: with no demand key held, a view declared demand builds zero times over ten minutes of fake clock", (t) => {
  const { runUntil, count } = rig(t);
  runUntil(T0 + WINDOW_MS);
  for (const name of DEMAND_VIEWS) assert.equal(count(name), 0, `${name} is declared demand and no key is held, so it must not build`);
  assert.equal(count(PLAIN_VIEW), WINDOW_MS / TICK_MS, "positive control: the ticker really ticked a build-due unit every second for ten minutes");
});

test("W1-T11934 criterion 2: with a demand key held, the view builds at its declared cadence and stops within one tick of the key being released", (t) => {
  const HOLD_MS = 30_000;
  const { ticker, runUntil, count, book, builds } = rig(t, HOLD_MS);
  runUntil(T0 + 5 * TICK_MS);
  for (const name of DEMAND_VIEWS) assert.equal(count(name), 0, `${name}: nothing held yet, so nothing built`);
  const wantedAt = T0 + 5 * TICK_MS;
  for (const name of DEMAND_VIEWS) assert.equal(ticker.want(name, "repository=all"), true, "positive control: a fresh key is due at once");
  const releasedAt = wantedAt + HOLD_MS;
  runUntil(T0 + WINDOW_MS);
  // The ticker starts one unmeasured unit per tick, so the three are all measured after WARM_MS.
  const measuredAt = wantedAt + WARM_MS;
  for (const name of DEMAND_VIEWS) {
    assert.ok(count(name, wantedAt, measuredAt) >= 1, `${name}'s fresh key is built within the warm-up`);
    // Held: one build per tick, the same cadence as the plain view with the same cost.
    assert.equal(count(name, measuredAt, releasedAt), count(PLAIN_VIEW, measuredAt, releasedAt), `${name} builds at the declared cadence while its key is held`);
    assert.equal(count(name, measuredAt, releasedAt), (releasedAt - measuredAt) / TICK_MS, `${name} rebuilt on every tick while held`);
    assert.equal(book.keys(name).length, 0, `positive control: ${name}'s key was released by the book's own eviction`);
    assert.equal(count(name, releasedAt + TICK_MS), 0, `${name} stops within one tick of its key being released; builds at ${JSON.stringify(builds.get(name)?.filter(at => at >= releasedAt))}`);
  }
});

test("W1-T11934 criterion 3: the measured cause is that demand views were not demand-gated, not a key held open or a build that re-arms demand", (t) => {
  const { runUntil, count, heldKeys } = rig(t);
  runUntil(T0 + WINDOW_MS);
  assert.equal(heldKeys.length, WINDOW_MS / TICK_MS, "positive control: the book was read after every tick");
  assert.deepEqual([...new Set(heldKeys)], [0], "no key is held open and no build re-arms demand: the book is empty after every tick");
  // With the book empty all along, any demand build would mean the due set ignores the book: the cause.
  assert.deepEqual(DEMAND_VIEWS.map(name => count(name)), DEMAND_VIEWS.map(() => 0), "the due set consults the demand book, so an empty book schedules no demand build");
});

test("W1-T11934 criterion 4: a view that is not declared demand is unchanged by this task", (t) => {
  const end = T0 + WARM_MS + 60 * TICK_MS;
  const idle = rig(t);
  idle.runUntil(end);
  assert.equal(idle.count(PLAIN_VIEW), (end - T0) / TICK_MS, "with no key held the plain view still builds on every tick");
  const held = rig(t);
  for (const name of DEMAND_VIEWS) held.ticker.want(name, "repository=all");
  held.runUntil(end);
  const ticks = (at: number[]) => at.filter(time => time >= T0 + WARM_MS).map(time => Math.floor((time - T0) / TICK_MS));
  assert.equal(held.count(PLAIN_VIEW, T0 + WARM_MS), 60, "with keys held the plain view still builds on every tick once every unit is measured");
  assert.deepEqual(ticks(held.builds.get(PLAIN_VIEW)!), ticks(idle.builds.get(PLAIN_VIEW)!), "the plain view builds in the same ticks either way");
  for (const name of DEMAND_VIEWS) assert.equal(held.count(name, T0 + WARM_MS), 60, `positive control: ${name} was really built beside it`);
});
