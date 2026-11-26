// W1-T15008. Operator ruling 2026-11-26 16:55Z let serve's heavy view lane idle when no Console is open (W1-T15003),
// accepting a slower first load after idle, and asked that the Console say so while the lane warms up. OBSERVED at
// cd17c327d: the lane's restart was invisible to readers, whose last body said only that it was old.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { Worker } from "node:worker_threads";
import type { Clock } from "#src/lib/clock.js";
import {
  READ_MODEL_HEAVY_IDLE_MS,
  READ_MODEL_WARMING_SOURCE_PREFIX,
  createReadModelTicker,
  threadViews,
  type ReadModelBodyEntry,
  type ReadModelView,
  type ReadModelWorkerMessage,
} from "#src/lib/read-model-worker.js";
import { trackWorkerThreads } from "#src/lib/worker-heaps.js";
import { onReadModelClose, readModelFixtureDir } from "#test/helpers/read-model-fixture-dir.js";

type TestCtx = Parameters<typeof readModelFixtureDir>[0];
const T0 = Date.parse("2026-11-26T17:00:00.000Z");

function handClock(start: number): { clock: Clock; advance: (ms: number) => void } {
  let ms = start;
  return { clock: { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() }, advance: (by) => void (ms += by) };
}

/** A fast-lane ticker that has handed `slow` to the heavy lane, beside a heavy-lane ticker that builds it. */
function lanes(t: TestCtx) {
  const stateDir = readModelFixtureDir(t, "warming-state").dir;
  const ledgerDir = readModelFixtureDir(t, "warming-ledger").dir;
  writeFileSync(join(ledgerDir, "ledger.ndjson"), `${JSON.stringify({ ts: new Date(T0).toISOString(), step: "run.start", task_id: "W1-T1", run_id: "r1" })}\n`);
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  writeFileSync(join(stateDir, "read-model", "switches.json"), JSON.stringify({ views: { slow: "serve", cheap: "serve" } }));
  const hand = handClock(T0 + 1_000);
  const projectorPosted: ReadModelWorkerMessage[] = [];
  const projector = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir }], clock: hand.clock, holder: "warming-holder", views: [], oracle: "off", post: (m) => void projectorPosted.push(m) });
  onReadModelClose(t, () => void projector.release());
  projector.start();
  projector.tick();
  const state = projectorPosted.findLast((m) => m.type === "state");
  let slowBuild = 0;
  const views: ReadModelView[] = [
    { name: "slow", version: 1, materialize: () => (slowBuild++, hand.advance(2_000), [{ key: "", data: { build: slowBuild }, sources: [] }]) },
    { name: "cheap", version: 1, materialize: () => [{ key: "", data: { cheap: true }, sources: [] }] },
  ];
  const lane = (name: "fast" | "heavy") => {
    const posted: ReadModelWorkerMessage[] = [];
    const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir }], clock: hand.clock, holder: "warming-holder", views, viewsOnly: true, oracle: "off", lane: name, post: (m) => void posted.push(m) });
    onReadModelClose(t, () => void ticker.release());
    ticker.observe(state?.type === "state" ? state.instances : []);
    return { ticker, posted, bodies: (view: string) => posted.flatMap((m) => (m.type === "body" && m.entry.view === view ? [m.entry] : [])) };
  };
  const fast = lane("fast"), heavy = lane("heavy");
  for (let i = 0; i < 3; i++) fast.ticker.tick();
  const handoff = fast.posted.find((m) => m.type === "view_lane");
  assert.ok(handoff?.type === "view_lane" && handoff.view === "slow", "control: the fast lane handed slow to the heavy lane");
  heavy.ticker.lane({ ...handoff, dueAt: 0 });
  heavy.ticker.tick();
  const built = heavy.bodies("slow").at(-1);
  assert.ok(built, "control: the heavy lane built slow");
  fast.ticker.peer(built);
  return { fast, heavy, built, hand };
}

const warmingSource = (entry: ReadModelBodyEntry | undefined) => entry?.body.sources.find((source) => source.name.startsWith(READ_MODEL_WARMING_SOURCE_PREFIX));

test("W1-T15008 criterion 1: a restarted heavy lane's last bodies are republished as warming", (t) => {
  const { fast, built } = lanes(t);
  const before = fast.bodies("slow").length;
  fast.ticker.warming("slow");
  const republished = fast.bodies("slow");
  assert.equal(republished.length, before + 1, "the fast lane posts the unit's last body once more");
  const entry = republished.at(-1)!;
  assert.deepEqual(entry.body.data, built.body.data, "the answer is the last body's own data");
  assert.equal(entry.body.stale, true);
  assert.notEqual(entry.etag, built.etag, "the ETag moves, so a conditional read gets the warming body");
  const source = warmingSource(entry);
  assert.equal(source?.state, "stale");
  assert.equal(source?.phase, "warming", "the Console shows phase warming as 'warming up'");
  assert.match(source?.reason ?? "", /idled while nobody read it and restarted at /);
  fast.ticker.warming("slow");
  assert.equal(fast.bodies("slow").length, before + 1, "a body already marked warming is not posted again");
});

test("W1-T15008 criterion 2: the restart asks the fast lane to mark each heavy unit warming", async (t) => {
  const dir = readModelFixtureDir(t, "warming-lanes").dir;
  const lanePath = join(dir, "lane.mjs");
  writeFileSync(lanePath, `import { parentPort, workerData } from "node:worker_threads";
const lane = workerData.lane;
const alive = setInterval(() => {}, 1000);
parentPort.on("message", (msg) => {
  if (msg.type === "stop") { clearInterval(alive); return parentPort.close(); }
  if (msg.type === "lane" && lane === "heavy" && msg.heavy) {
    parentPort.postMessage({ type: "view_unit", view: msg.view, phase: "start" });
    parentPort.postMessage({ type: "view_unit", view: msg.view, phase: "end" });
  }
  if (msg.type === "warming") parentPort.postMessage({ type: "log", step: "fixture.warming", extra: { lane, view: msg.view, instance: msg.instance ?? null } });
  if (msg.type === "want" && msg.view === "move" && lane === "fast") {
    parentPort.postMessage({ type: "view_lane", view: "now", instance: "core", heavy: true, dueAt: 0, costMs: 2000 });
    parentPort.postMessage({ type: "view_lane", view: "board", heavy: true, dueAt: 0, costMs: 2000 });
  }
});
`);
  const hand = handClock(T0);
  let check: (() => void) | undefined;
  const relayed: ReadModelWorkerMessage[] = [];
  const book = trackWorkerThreads();
  const views = threadViews({
    data: { stateDir: dir, instances: [], tickMs: 50, holder: "warming-lanes" }, workerUrl: pathToFileURL(lanePath), clock: hand.clock,
    every: (run) => { check = run; return () => void (check = undefined); },
    log: () => undefined, relay: (msg) => void relayed.push(msg),
  });
  onReadModelClose(t, async () => {
    views.close();
    await Promise.all(book.live().map(({ thread }) => (thread as Worker).terminate()));
    book.stop();
  });
  const marked = () => relayed.flatMap((msg) => (msg.type === "log" && msg.step === "fixture.warming" ? [msg.extra] : []));
  const heavyThreads = () => book.live().filter(({ kind }) => kind.endsWith(":spawnHeavyViews"));
  views.want("move", "");
  const deadline = Date.now() + 10_000;
  while (heavyThreads().length === 0 && Date.now() < deadline) await sleep(5);
  assert.equal(heavyThreads().length, 1, "control: the heavy lane runs");
  hand.advance(READ_MODEL_HEAVY_IDLE_MS);
  check!();
  while (heavyThreads().length > 0 && Date.now() < deadline) await sleep(5);
  assert.equal(heavyThreads().length, 0, "control: the idle heavy lane ended");
  assert.deepEqual(marked(), [], "an ending lane marks nothing");
  assert.deepEqual(views.read("/v1/now"), { woke: "restarted" });
  while (marked().length < 2 && Date.now() < deadline) await sleep(5);
  assert.deepEqual(marked().sort((a, b) => String(a.view).localeCompare(String(b.view))),
    [{ lane: "fast", view: "board", instance: null }, { lane: "fast", view: "now", instance: "core" }], "the fast lane marks exactly the units the heavy lane holds");
});

test("W1-T15008 criterion 3: invariant:own-source-otherwise", (t) => {
  const { fast, heavy, hand } = lanes(t);
  const cheap = fast.bodies("cheap").at(-1);
  assert.ok(cheap, "control: the fast lane built cheap");
  fast.ticker.warming("cheap");
  assert.ok(!warmingSource(fast.bodies("cheap").at(-1)), "a running lane's body keeps its own sources");
  const before = fast.posted.length;
  fast.ticker.warming("absent");
  assert.equal(fast.posted.length, before, "a view no lane holds marks nothing");
  fast.ticker.warming("slow");
  assert.ok(warmingSource(fast.bodies("slow").at(-1)), "control: slow is marked warming");
  hand.advance(60_000);
  heavy.ticker.lane({ view: "slow", heavy: true, dueAt: 0 });
  heavy.ticker.tick();
  const fresh = heavy.bodies("slow").at(-1)!;
  assert.ok(!warmingSource(fresh), "the restarted lane's first fresh body carries only its own sources");
  fast.ticker.peer(fresh);
  fast.ticker.warming("slow");
  assert.ok(warmingSource(fast.bodies("slow").at(-1)), "a later restart marks the fresh body again");
});
