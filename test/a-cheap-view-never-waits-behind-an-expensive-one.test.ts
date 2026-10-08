/**
 * W1-T5885: a cheap view never waits behind an expensive one. The view side runs two lanes: a unit
 * measured over the solo budget moves to a heavy thread, so a cheap unit whose source moved is built
 * on the fast thread's next tick even while the heavy thread is mid-build.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { Clock } from "../src/lib/clock.js";
import {
  READ_MODEL_STALL_MS,
  createReadModelTicker,
  createReadModelWorker,
  runReadModelViewWorker,
  threadViews,
  type ReadModelBodyEntry,
  type ReadModelInstanceState,
  type ReadModelView,
  type ReadModelViewsInput,
  type ReadModelWorkerMessage,
} from "../src/lib/read-model-worker.js";
import { trackWorkerThreads } from "../src/lib/worker-heaps.js";
import { makeTempDir } from "../src/lib/tmp.js";

const T0 = Date.parse("2026-10-05T08:00:00.000Z");
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

function row(ms: number, runId: string): string {
  return `${JSON.stringify({ ts: new Date(ms).toISOString(), step: "run.start", task_id: "W1-T1", run_id: runId })}\n`;
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

function switchOn(stateDir: string, views: string[]): void {
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  writeFileSync(join(stateDir, "read-model", "switches.json"), JSON.stringify({ views: Object.fromEntries(views.map((v) => [v, "shadow"])) }));
}

test("while a fake view unit whose cost exceeds soloMs is mid-build, a cheap unit whose source moved is published before the heavy unit completes", async (t) => {
  let handle: ReturnType<typeof createReadModelWorker> | undefined;
  t.after(() => void handle?.stop());
  const stateDir = scratch(t, "lanes-state");
  const ledgerDir = scratch(t, "lanes-ledger");
  writeFileSync(join(ledgerDir, LIVE), row(Date.now(), "boot"));
  switchOn(stateDir, ["slow", "cheap"]);
  const work = scratch(t, "lanes-work");
  const marks = join(work, "marks.txt");
  const source = join(work, "source.txt");
  writeFileSync(source, "v0");
  // Twice the solo budget (passMs 2,500 x 0.4 = 1,000 ms), and far longer than a tick.
  const blockMs = 2_000;
  const viewsModule = moduleFile(t, "lanes-module", `import { appendFileSync, readFileSync } from "node:fs";
export default [
  { name: "slow", version: 1, materialize: () => {
    appendFileSync(${JSON.stringify(marks)}, "start " + Date.now() + "\\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${blockMs});
    appendFileSync(${JSON.stringify(marks)}, "end " + Date.now() + "\\n");
    return [{ key: "", data: { builtAt: Date.now() }, sources: [] }];
  } },
  { name: "cheap", version: 1, materialize: () => [{ key: "", data: { value: readFileSync(${JSON.stringify(source)}, "utf8") }, sources: [] }] },
];
`).href;
  const logs: string[] = [];
  handle = createReadModelWorker({ stateDir, instances: [{ name: "core", ledgerDir }], viewsModule, log: (step) => void logs.push(step), every: () => () => undefined });
  handle.start();
  const lines = (): string[] => (existsSync(marks) ? readFileSync(marks, "utf8").trim().split("\n") : []);
  // The first build of the unmeasured slow unit runs on the fast lane; it measures over soloMs and moves.
  await until(() => lines().filter((l) => l.startsWith("end")).length >= 1, "the slow unit's first build finished");
  await until(() => lines().length >= 3 && lines()[lines().length - 1]!.startsWith("start"), "the heavy lane began the slow unit's next build");
  const heavyStart = Number(lines()[lines().length - 1]!.split(" ")[1]);
  await until(() => (handle!.body("cheap")?.body.data as { value?: string } | undefined)?.value === "v0", "the cheap view's first body");

  writeFileSync(source, "v1");
  await until(() => (handle!.body("cheap")?.body.data as { value?: string } | undefined)?.value === "v1", "the cheap view's moved source was published", blockMs * 4);
  const ended = lines().filter((l) => l.startsWith("end")).length;
  assert.equal(ended, 1, "the cheap body was published while the slow unit was still mid-build");

  await until(() => ((handle!.body("slow")?.body.data as { builtAt?: number } | undefined)?.builtAt ?? 0) > heavyStart, "the heavy unit completed and published", blockMs * 4);
  assert.deepEqual(logs.filter((step) => /views_exited|views_failed|worker_(silent|recycled|exited)/.test(step)), []);
});

function projectorStates(stateDir: string, ledgerDir: string, clock: Clock): { states: ReadModelInstanceState[]; release: () => number } {
  const posted: ReadModelWorkerMessage[] = [];
  const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir }], clock, holder: "proj-holder", views: [], oracle: "off", post: (m) => void posted.push(m) });
  ticker.start();
  ticker.tick();
  const last = posted.findLast((m) => m.type === "state");
  return { states: last?.type === "state" ? last.instances : [], release: () => ticker.release() };
}

test("a unit moves lanes when its measured cost crosses soloMs in either direction, and each lane builds only the units it owns", (t) => {
  const stateDir = scratch(t, "lanes-unit-state");
  const ledgerDir = scratch(t, "lanes-unit-ledger");
  writeFileSync(join(ledgerDir, LIVE), row(T0, "r1"));
  switchOn(stateDir, ["slow", "cheap", "snap"]);
  const hand = handClock(T0 + 1_000);
  const projector = projectorStates(stateDir, ledgerDir, hand.clock);
  t.after(() => void projector.release());
  let slowMs = 2_000;
  let cheapSource = "v0";
  const builds: string[] = [];
  const views: ReadModelView[] = [
    { name: "slow", version: 1, materialize: () => (builds.push("slow"), hand.advance(slowMs), [{ key: "", data: { slow: true }, sources: [] }]) },
    { name: "cheap", version: 1, materialize: () => (builds.push("cheap"), [{ key: "", data: { value: cheapSource }, sources: [] }]) },
    { name: "snap", version: 1, snapshotSourced: true, materialize: () => (builds.push("snap"), [{ key: "", data: {}, sources: [] }]) },
  ];
  const lane = (name: "fast" | "heavy") => {
    const posted: ReadModelWorkerMessage[] = [];
    const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir }], clock: hand.clock, holder: "proj-holder", views, viewsOnly: true, oracle: "off", lane: name, post: (m) => void posted.push(m) });
    t.after(() => void ticker.release());
    ticker.observe(projector.states);
    return { ticker, posted, moves: () => posted.flatMap((m) => (m.type === "view_lane" ? [[m.view, m.heavy, m.costMs]] : [])) };
  };
  const fast = lane("fast");
  const heavy = lane("heavy");

  for (let i = 0; i < 3; i++) fast.ticker.tick();
  assert.deepEqual(fast.moves(), [["slow", true, 2_000]], "the fast lane hands off the unit it measured over soloMs");
  heavy.ticker.tick();
  assert.deepEqual(builds.filter((b) => b === "slow").length, 1, "the heavy lane builds nothing it was not handed");
  const handoff = fast.posted.find((m) => m.type === "view_lane");
  assert.ok(handoff?.type === "view_lane");
  heavy.ticker.lane({ ...handoff, dueAt: 0 });

  builds.length = 0;
  hand.advance(60_000);
  cheapSource = "v1";
  fast.ticker.tick();
  const cheapBody = fast.posted.findLast((m): m is Extract<ReadModelWorkerMessage, { type: "body" }> => m.type === "body" && m.entry.view === "cheap");
  assert.equal((cheapBody?.entry.body.data as { value?: string } | undefined)?.value, "v1", "the fast lane publishes the moved source in its next tick");
  fast.ticker.buildNow("slow");
  assert.ok(!builds.includes("slow"), "the fast lane never builds a unit it handed off, even on a want");
  assert.ok(builds.includes("cheap"));
  heavy.ticker.tick();
  assert.deepEqual(builds.filter((b) => b === "slow"), ["slow"], "the heavy lane builds the unit it now owns");
  assert.deepEqual(heavy.moves(), [], "still over soloMs: it stays heavy");
  const slowBody = heavy.posted.find((m): m is Extract<ReadModelWorkerMessage, { type: "body" }> => m.type === "body" && m.entry.view === "slow");
  assert.ok(slowBody, "the heavy lane publishes its own bodies");

  // The snapshot lands once, on the fast lane; the heavy lane only marks its snapshot-sourced units due.
  heavy.ticker.lane({ view: "snap", heavy: true, dueAt: Number.MAX_SAFE_INTEGER });
  builds.length = 0;
  assert.equal(heavy.ticker.acceptSnapshot({ instance: "core", ok: true, asOf: new Date(T0).toISOString(), bodies: [] }), true);
  heavy.ticker.tick();
  assert.ok(builds.includes("snap"), "a snapshot makes the heavy lane's snapshot-sourced unit due");

  slowMs = 1;
  hand.advance(60_000);
  heavy.ticker.tick();
  assert.deepEqual(heavy.moves().map(([view, toHeavy]) => [view, toHeavy]), [["snap", false], ["slow", false]], "a unit under soloMs on the heavy lane moves back to the fast lane");

  // The heavy lane's body reaches the fast lane, so a unit moving back republishes only what changed.
  fast.ticker.peer(slowBody.entry);
  fast.ticker.lane({ view: "slow", heavy: false, dueAt: 0 });
  const before = fast.posted.length;
  fast.ticker.tick();
  assert.ok(!fast.posted.slice(before).some((m) => m.type === "body" && m.entry.view === "slow"), "an unchanged body the peer lane posted is not posted again");

  // A lane that restarted: every unit goes back to the fast lane.
  heavy.ticker.lane({ heavy: false, dueAt: 0 });
  builds.length = 0;
  heavy.ticker.tick();
  assert.deepEqual(builds, [], "after a reset the heavy lane owns nothing");
});

test("the view thread body takes a lane move and a peer body from its threadViews parent", async (t) => {
  const stateDir = scratch(t, "lanes-body-state");
  const ledgerDir = scratch(t, "lanes-body-ledger");
  writeFileSync(join(ledgerDir, LIVE), row(Date.now(), "r1"));
  switchOn(stateDir, ["extra"]);
  const projector = projectorStates(stateDir, ledgerDir, { now: () => Date.now(), date: () => new Date(), iso: () => new Date().toISOString() });
  t.after(() => void projector.release());
  const viewsModule = moduleFile(t, "lanes-body-module", `export default [{ name: "extra", version: 1, materialize: () => [{ key: "", data: { extra: 1 }, sources: [] }] }];\n`).href;
  let onMessage: ((msg: ReadModelViewsInput) => void) | undefined;
  const posted: ReadModelWorkerMessage[] = [];
  const port = { on: (_e: "message", run: (msg: ReadModelViewsInput) => void) => void (onMessage = run), postMessage: (m: unknown) => void posted.push(m as ReadModelWorkerMessage), close: () => {} };
  runReadModelViewWorker(port, { stateDir, instances: [{ name: "core", ledgerDir }], tickMs: 5, holder: "proj-holder", viewsModule, lane: "heavy" });
  t.after(() => onMessage?.({ type: "stop" }));
  onMessage?.({ type: "state", instances: projector.states });
  await sleep(100);
  assert.ok(!posted.some((m) => m.type === "body"), "a heavy lane builds nothing until a unit is handed to it");
  onMessage?.({ type: "peer", entry: { view: "extra", key: "", version: 1, generation: 0, etag: "peer-etag", body: { view: "extra", version: 1, generatedAt: "", asOf: null, stale: false, sources: [], data: {} } } as ReadModelBodyEntry });
  onMessage?.({ type: "lane", view: "extra", heavy: true, dueAt: 0, costMs: 5_000 });
  await until(() => posted.some((m) => m.type === "body" && m.entry.view === "extra"), "the handed unit is built on the heavy lane");
  await until(() => posted.some((m) => m.type === "view_lane" && m.view === "extra" && !m.heavy), "measured cheap, it is handed back");
});

test("threadViews spawns the heavy lane on the first hand-off, names its thread, routes moves and bodies between the lanes, and watches each lane", async (t) => {
  const book = trackWorkerThreads();
  t.after(() => book.stop());
  const inputs = join(scratch(t, "lanes-thread-inputs"), "inputs.txt");
  const workerUrl = moduleFile(t, "lanes-thread", `import { parentPort, workerData } from "node:worker_threads";
import { appendFileSync } from "node:fs";
const lane = workerData.lane;
parentPort.on("message", (msg) => {
  appendFileSync(${JSON.stringify(inputs)}, lane + ":" + msg.type + (msg.type === "lane" ? ":" + (msg.view ?? "*") + ":" + msg.heavy : "") + "\\n");
  if (msg.type === "lane" && lane === "heavy" && msg.view === "now") {
    parentPort.postMessage({ type: "view_unit", view: "now", instance: "core", phase: "start" });
    parentPort.postMessage({ type: "body", entry: { view: "now", key: "core", version: 1, generation: 0, etag: "e", body: {} } });
  }
  if (msg.type === "want" && lane === "heavy") process.exit(3);
});
if (lane === "fast") parentPort.postMessage({ type: "view_lane", view: "now", instance: "core", heavy: true, dueAt: 0, costMs: 2_700 });
setInterval(() => {}, 1000);
`);
  const hand = handClock(T0);
  const relayed: ReadModelWorkerMessage[] = [];
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let watch: (() => void) | undefined;
  const lanes = threadViews({
    data: { stateDir: "/nonexistent", instances: [], tickMs: 5, holder: "h" }, workerUrl, clock: hand.clock,
    relay: (m) => void relayed.push(m), log: (step, extra) => void logs.push({ step, extra }), every: (run) => ((watch = run), () => undefined),
  });
  t.after(() => lanes.close());
  const got = (): string[] => (existsSync(inputs) ? readFileSync(inputs, "utf8").trim().split("\n") : []);
  await until(() => got().includes("heavy:lane:now:true"), "the fast lane's hand-off reached a heavy lane spawned for it");
  const kinds = book.live().map((w) => w.kind);
  assert.ok(kinds.includes("read-model-worker:spawnViews") && kinds.includes("read-model-worker:spawnHeavyViews"), `each lane's thread is named by its own spawn site: ${kinds.join(", ")}`);
  await until(() => got().includes("fast:peer"), "the heavy lane's body is handed to the fast lane");
  assert.ok(relayed.some((m) => m.type === "body" && m.entry.view === "now"), "and relayed to serve");
  assert.ok(!relayed.some((m) => m.type === "view_lane" || m.type === "view_unit"), "lane traffic is never relayed to serve");

  watch?.();
  hand.advance(READ_MODEL_STALL_MS);
  watch?.();
  watch?.();
  assert.deepEqual(logs.filter((l) => l.step === "read_model.view_build_long").map((l) => [l.extra.lane, l.extra.view, l.extra.instance]), [["heavy", "now", "core"]], "the heavy lane's long build is reported once, by lane");

  lanes.state([]);
  lanes.shadow({ view: "now", key: "core", requests: 1 });
  lanes.snapshot({ instance: "core", ok: true, asOf: new Date(T0).toISOString(), bodies: [] });
  lanes.want("task", "W1-T1");
  lanes.accept({ view: "inbox", version: 1, bodies: [] });
  await until(() => got().includes("fast:bodies"), "every input reached the fast lane");
  assert.deepEqual(got().filter((l) => /^(fast|heavy):(state|shadow|snapshot|want|bodies)$/.test(l)).sort(), ["fast:bodies", "fast:shadow", "fast:snapshot", "fast:state", "fast:want", "heavy:snapshot", "heavy:state", "heavy:want"]);
  // The heavy lane's death hands its units back to the fast lane, and again once it is respawned.
  await until(() => logs.some((l) => l.step === "read_model.views_exited" && l.extra.lane === "heavy"), "a heavy lane death is logged by lane");
  await until(() => got().filter((l) => l === "fast:lane:*:false").length >= 2, "the fast lane reclaimed the heavy lane's units at its death and at its respawn");
});

/**
 * `now` builds in bounded calls (board+snapshot, then decisions, then a cheap assemble), and an idle
 * instance's call builds nothing. Placed by its LAST call, it settled on the fast lane on the host
 * (2026-10-06: 3,209 of 3,892 `materialize_deferred` rows deferred `now@core` behind cheap views).
 */
function stagedLanes(t: TestCtx, kind: string) {
  const stateDir = scratch(t, `${kind}-state`);
  const ledgerDir = scratch(t, `${kind}-ledger`);
  writeFileSync(join(ledgerDir, LIVE), row(T0, "r1"));
  switchOn(stateDir, ["staged"]);
  const hand = handClock(T0 + 1_000);
  const projector = projectorStates(stateDir, ledgerDir, hand.clock);
  t.after(() => void projector.release());
  const plan = { costs: [2_000, 2_000, 50], due: true, stage: 0 };
  const view: ReadModelView = {
    name: "staged", version: 1,
    prepare: (_ctx, more) => {
      if (!plan.due) return true;
      while (plan.stage < plan.costs.length) {
        if (!more()) return false;
        hand.advance(plan.costs[plan.stage++]!);
      }
      return true;
    },
    materialize: () => {
      if (plan.stage < plan.costs.length) return [];
      plan.stage = 0;
      return [{ key: "", data: { at: hand.clock.now() }, sources: [] }];
    },
  };
  const lane = (name: "fast" | "heavy") => {
    const posted: ReadModelWorkerMessage[] = [];
    const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir }], clock: hand.clock, holder: "proj-holder", views: [view], viewsOnly: true, oracle: "off", lane: name, post: (m) => void posted.push(m) });
    t.after(() => void ticker.release());
    ticker.observe(projector.states);
    const run = (ticks: number): void => {
      for (let i = 0; i < ticks; i++) {
        hand.advance(60_000);
        ticker.tick();
      }
    };
    return { ticker, run, moves: () => posted.flatMap((m) => (m.type === "view_lane" ? [[m.view, m.heavy, m.costMs]] : [])), bodies: () => posted.filter((m) => m.type === "body").length };
  };
  return { plan, lane };
}

test("a view whose bounded build ends in a cheap call is placed by its costliest call, so it never settles on the fast lane", (t) => {
  const { lane } = stagedLanes(t, "staged-fast");
  const fast = lane("fast");
  fast.run(3);
  assert.equal(fast.bodies(), 1, "three bounded calls finish one build");
  assert.deepEqual(fast.moves(), [["staged", true, 2_000]], "its 2,000 ms calls, not its 50 ms last one, send it to the heavy lane");
});

test("a heavy unit stays on the heavy lane through a cheap last call and a poll that builds nothing, and a whole build under soloMs still moves it back", (t) => {
  const { plan, lane } = stagedLanes(t, "staged-heavy");
  const heavy = lane("heavy");
  heavy.ticker.lane({ view: "staged", heavy: true, dueAt: 0, costMs: 2_000 });
  heavy.run(3);
  assert.equal(heavy.bodies(), 1, "the heavy lane finished the build");
  plan.due = false;
  heavy.run(2);
  assert.deepEqual(heavy.moves(), [], "neither the 50 ms assemble nor an idle poll is a cheap build");
  Object.assign(plan, { due: true, costs: [10, 10, 10] });
  heavy.run(1);
  assert.deepEqual(heavy.moves(), [["staged", false, 30]], "a build whose costliest call fits soloMs returns to the fast lane");
});
