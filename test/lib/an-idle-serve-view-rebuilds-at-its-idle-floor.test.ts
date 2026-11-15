/**
 * W1-T11933. OBSERVED 2026-11-10 on the Azure host with no console open: `read_model.view_builds` over
 * 10 to 16 minutes counted instances 3241, nav-badge 3272 and analytics 3331 builds, because the idle
 * stretch was wired to the now view alone. Every lane view that no demand key holds now floors its
 * cadence at READ_MODEL_IDLE_FLOOR_MS while unread, and the next read puts it back on cost / share.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Clock } from "#src/lib/clock.js";
import {
  READ_MODEL_IDLE_FLOOR_MS,
  READ_MODEL_IDLE_STRETCH_MAX,
  READ_MODEL_READ_HOT_MS,
  READ_MODEL_VIEW_SHARE,
  createReadModelTicker,
  readModelLaneViews,
  type ReadModelInstanceState,
  type ReadModelView,
  type ReadModelViewFactory,
  type ReadModelWorkerMessage,
} from "#src/lib/read-model-worker.js";
import { createDemandBook } from "#src/lib/view-demand.js";
import { onReadModelClose, readModelFixtureDir } from "#test/helpers/read-model-fixture-dir.js";

const T0 = Date.parse("2026-11-10T08:00:00.000Z");
const COST_MS = 400;
const TICK_MS = 250;
const TEN_MINUTES = 10 * 60_000;
const BASE_WAIT_MS = COST_MS / READ_MODEL_VIEW_SHARE;

type TestCtx = Parameters<typeof readModelFixtureDir>[0];

function handClock(start: number): { clock: Clock; advance: (ms: number) => void } {
  let ms = start;
  return { clock: { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() }, advance: (by) => void (ms += by) };
}

function projectorStates(stateDir: string, ledgerDir: string, clock: Clock): { states: ReadModelInstanceState[]; release: () => number } {
  const posted: ReadModelWorkerMessage[] = [];
  const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir }], clock, holder: "idle-floor-holder", views: [], oracle: "off", post: (m) => void posted.push(m) });
  ticker.start();
  ticker.tick();
  const last = posted.findLast((m) => m.type === "state");
  return { states: last?.type === "state" ? last.instances : [], release: () => ticker.release() };
}

/** A view ticker on a hand clock: every named build is recorded with its start time and costs COST_MS. */
function fixture(t: TestCtx, specs: Array<{ name: string; flags?: Partial<Pick<ReadModelViewFactory, "readPaced" | "idleFloor" | "demand">>; throws?: true }>) {
  const stateDir = readModelFixtureDir(t, "idle-floor-state").dir;
  const ledgerDir = readModelFixtureDir(t, "idle-floor-ledger").dir;
  writeFileSync(join(ledgerDir, "ledger.ndjson"), `${JSON.stringify({ ts: new Date(T0).toISOString(), step: "run.start", task_id: "W1-T1", run_id: "r1" })}\n`);
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  writeFileSync(join(stateDir, "read-model", "switches.json"), JSON.stringify({ views: Object.fromEntries(specs.map(({ name }) => [name, "shadow"])) }));
  const hand = handClock(T0 + 1_000);
  const projector = projectorStates(stateDir, ledgerDir, hand.clock);
  onReadModelClose(t, () => void projector.release());
  const builds: Array<[string, number]> = [];
  const views: ReadModelViewFactory[] = specs.map(({ name, flags, throws }) => ({
    name, ...flags,
    create: (): ReadModelView => ({ name, version: 1, ...(flags?.demand ? { demand: true as const } : {}), materialize: () => {
      builds.push([name, hand.clock.now()]);
      hand.advance(COST_MS);
      if (throws) throw new Error(`${name} cannot build`);
      return [{ key: "", data: { at: hand.clock.now() }, sources: [] }];
    } }),
  }));
  const posted: ReadModelWorkerMessage[] = [];
  const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir }], clock: hand.clock, holder: "idle-floor-holder", views, viewsOnly: true, oracle: "off", post: (m) => void posted.push(m) });
  onReadModelClose(t, () => void ticker.release());
  ticker.observe(projector.states);
  const run = (ms: number, each?: () => void): void => {
    for (const end = hand.clock.now() + ms; hand.clock.now() < end;) {
      hand.advance(TICK_MS);
      ticker.tick();
      each?.();
    }
  };
  const count = (name: string, from: number): number => builds.filter(([n, at]) => n === name && at >= from).length;
  const starts = (name: string, from: number): number[] => builds.filter(([n, at]) => n === name && at >= from).map(([, at]) => at);
  const bodiesOf = (name: string): number[] => posted.flatMap((m) => m.type === "body" && m.entry.view === name ? [Date.parse(m.entry.body.generatedAt)] : []);
  const failures = (name: string): number => posted.filter((m) => m.type === "log" && m.step === "read_model.materialize_failed" && m.extra.view === name).length;
  return { hand, ticker, run, count, starts, bodiesOf, failures, posted };
}

test("W1-T11933 criterion 1: an idle-floor view unread past the idle window builds at least tenfold less often over ten minutes than today's cadence", (t) => {
  const f = fixture(t, [{ name: "floored", flags: { idleFloor: true } }, { name: "today" }]);
  f.run(READ_MODEL_READ_HOT_MS - 5_000);
  const hot = f.count("floored", 0);
  assert.ok(hot >= 50, `inside the idle window the floor does not engage: ${hot} builds`);
  assert.ok(Math.abs(hot - f.count("today", 0)) <= 2, "the same cadence as an unflagged view of the same cost while read recently");

  f.run(60_000);
  const from = f.hand.clock.now();
  f.run(TEN_MINUTES);
  const floored = f.count("floored", from);
  const today = f.count("today", from);
  assert.ok(today >= 300, `a positive control: today's cadence kept building, ${today} builds`);
  assert.ok(floored <= Math.ceil(TEN_MINUTES / READ_MODEL_IDLE_FLOOR_MS) + 1, `unread, it built ${floored} times in ten minutes`);
  assert.ok(floored >= Math.floor(TEN_MINUTES / (READ_MODEL_IDLE_FLOOR_MS + COST_MS + TICK_MS)), `and it still builds once per floor: ${floored}`);
  assert.ok(today >= 10 * floored, `at least tenfold fewer builds than today: ${floored} vs ${today}`);
});

test("W1-T11933 criterion 2: a read of an idle view restores its cadence within one tick, built on demand, and no body it holds outlives the idle floor by more than one build", (t) => {
  const f = fixture(t, [{ name: "floored", flags: { idleFloor: true } }, { name: "today" }]);
  f.run(READ_MODEL_READ_HOT_MS + 60_000);
  let oldest = 0;
  f.run(TEN_MINUTES, () => {
    const newest = f.bodiesOf("floored").at(-1)!;
    oldest = Math.max(oldest, f.hand.clock.now() - newest);
  });
  assert.ok(oldest > BASE_WAIT_MS * 4, `a positive control: idle, its newest body aged well past today's wait (${oldest} ms)`);
  assert.ok(oldest <= READ_MODEL_IDLE_FLOOR_MS + COST_MS + TICK_MS, `unread, its newest body was at most ${oldest} ms old`);

  // A read of an unrelated route changes nothing.
  f.ticker.read("/v1/registry");
  const unrelated = f.hand.clock.now();
  f.run(TICK_MS * 4);
  assert.equal(f.count("floored", unrelated), 0, "a read of a route that reads no floored view does not build it");

  const bodies = f.bodiesOf("floored").length;
  f.ticker.read("/v1/views/floored");
  const readAt = f.hand.clock.now();
  f.run(TICK_MS);
  assert.equal(f.count("floored", readAt), 1, "the next tick after a read builds the idle view");
  assert.equal(f.bodiesOf("floored").length, bodies + 1, "and posts the body that build made");
  assert.ok(f.bodiesOf("floored").at(-1)! >= readAt, "the body serve holds after the read was built after it");

  const readingFrom = f.hand.clock.now();
  for (let minute = 0; minute < 5; minute++) {
    f.ticker.read("/v1/views/floored");
    f.run(60_000);
  }
  const reading = f.count("floored", readingFrom);
  assert.ok(Math.abs(reading - f.count("today", readingFrom)) <= 2, `read every minute, it keeps today's cadence: ${reading} vs ${f.count("today", readingFrom)}`);
});

test("W1-T11933 criterion 3: the now view keeps its stretch ladder and a demand view keeps its demand cadence, and every other lane view carries the idle floor", (t) => {
  const lane = readModelLaneViews({ instances: [{ name: "core", ledgerDir: "/nonexistent" }] }, handClock(T0).clock, () => {}, createDemandBook());
  const now = lane.filter((view) => view.name === "now");
  assert.equal(now.length, 1);
  assert.equal(now[0]!.readPaced, true, "the now view is still read-paced");
  assert.equal(now[0]!.idleFloor, undefined, "and is not paced a second time by the floor");
  const demand = lane.filter((view) => view.demand === true);
  assert.deepEqual(demand.map((view) => view.name).sort(), ["code-health", "daily-progress", "inbox-thread", "task"]);
  assert.ok(demand.every((view) => view.idleFloor === undefined && view.readPaced === undefined), "a demand view keeps its demand rule alone");
  const rest = lane.filter((view) => view.demand !== true && view.readPaced !== true);
  for (const name of ["nav-badge", "repositories", "analytics", "instances", "workstreams", "host", "read-model"]) {
    assert.ok(rest.some((view) => view.name === name), `the lane registers ${name}`);
  }
  assert.deepEqual(rest.filter((view) => view.idleFloor !== true).map((view) => view.name), [], "every view no demand key holds carries the idle floor");

  // Behaviour: the read-paced ladder is unchanged, and a demand view flagged with the floor ignores it.
  const f = fixture(t, [{ name: "now", flags: { readPaced: true } }, { name: "wanted", flags: { demand: true, idleFloor: true } }, { name: "today" }]);
  f.run(READ_MODEL_READ_HOT_MS - 5_000);
  const idleFrom = f.hand.clock.now();
  f.run(TEN_MINUTES);
  const nowStarts = f.starts("now", idleFrom);
  const ladder = nowStarts.slice(1).map((at, i) => Math.round((at - nowStarts[i]! - COST_MS) / BASE_WAIT_MS));
  // Three views share each pass here, so a stretched wait can round one base wait long.
  const first = ladder.indexOf(4);
  assert.deepEqual(ladder.slice(first, first + 3), [4, 8, 16], `the now view's wait still doubles: ${ladder.join(", ")}`);
  const held = ladder.slice(first + 3);
  assert.ok(held.length >= 5 && held.every((stretch) => Math.abs(stretch - READ_MODEL_IDLE_STRETCH_MAX) <= 1), `then holds at its stretch bound, never the floor: ${ladder.join(", ")}`);
  const wanted = f.count("wanted", idleFrom), today = f.count("today", idleFrom);
  assert.ok(today >= 300, `a positive control: ${today} builds at today's cadence`);
  assert.ok(Math.abs(wanted - today) <= 2, `a demand view is never floored: ${wanted} vs ${today}`);
});

test("W1-T11933 criterion 4: the idle floor is a declared 30 to 60 second constant and an idle view whose build throws still reports each failure", (t) => {
  assert.ok(READ_MODEL_IDLE_FLOOR_MS >= 30_000 && READ_MODEL_IDLE_FLOOR_MS <= 60_000, `the floor is ${READ_MODEL_IDLE_FLOOR_MS} ms`);
  const f = fixture(t, [{ name: "broken", flags: { idleFloor: true }, throws: true }, { name: "floored", flags: { idleFloor: true } }]);
  f.run(READ_MODEL_READ_HOT_MS + 60_000);
  const from = f.hand.clock.now();
  const before = f.failures("broken");
  f.run(TEN_MINUTES);
  const flooredStarts = f.starts("floored", from);
  const gaps = flooredStarts.slice(1).map((at, i) => at - flooredStarts[i]!);
  assert.ok(gaps.length > 0 && gaps.every((ms) => ms >= READ_MODEL_IDLE_FLOOR_MS && ms <= READ_MODEL_IDLE_FLOOR_MS + COST_MS + TICK_MS), `idle builds are spaced by the floor: ${gaps.join(", ")}`);
  const attempts = f.count("broken", from);
  const reported = f.failures("broken") - before;
  assert.ok(attempts >= Math.floor(TEN_MINUTES / (READ_MODEL_IDLE_FLOOR_MS + COST_MS + TICK_MS)), `the throwing view is still attempted once per floor: ${attempts}`);
  assert.equal(reported, attempts, "every attempt that threw reported its failure");
  const failedBefore = f.failures("broken");
  f.ticker.read("/v1/views/broken");
  f.run(TICK_MS);
  assert.equal(f.failures("broken"), failedBefore + 1, "a read retries it on the next tick and reports that failure too");
});
