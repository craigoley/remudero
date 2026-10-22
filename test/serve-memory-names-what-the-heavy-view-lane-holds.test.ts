// test/serve-memory-names-what-the-heavy-view-lane-holds.test.ts — W1-T9403.
//
// Serve's largest thread, the heavy view lane, read 1.06-1.65 GB in every serve.memory sample of
// 2026-10-14 06:39-07:52Z as ONE committed-heap number: nothing said how much was live, how much GC
// slack, or which instance's held board projection held it. Each worker-heap part now carries its
// used heap (`used_bytes`) beside its committed heap (`bytes`), and a views lane's part names each
// held board projection by instance (`holds["board:<instance>"]`: rows kept, kept source bytes).
// A reading only: nothing is bounded, relieved or refused.
// FALSIFIER: drop `used_bytes` from threadHeap, or the `view_holds` message, and the lane's part has
// no used_bytes or no board:<instance> entry.

import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { Worker } from "node:worker_threads";

import { BOARD_UNREAD_STEPS, createBoardProjection, type BoardProjection } from "../src/lib/board-projection.js";
import type { Clock } from "../src/lib/clock.js";
import { createLedgerProjector, openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { createNowView, type NowViewContext, type NowViewOptions } from "../src/lib/now-view.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { acquireLease, type ReadModelDb } from "../src/lib/read-model-db.js";
import {
  createReadModelTicker, threadViews, type ReadModelInstanceState, type ReadModelViewFactory, type ReadModelViewLane, type ReadModelWorkerMessage,
} from "../src/lib/read-model-worker.js";
import * as memory from "../src/lib/serve-memory.js";
import type { GitHub } from "../src/lib/status.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { answerThreadHeaps, readWorkerHeaps, THREAD_HEAPS_ANSWER, THREAD_HEAPS_REQUEST, type WorkerThread } from "../src/lib/worker-heaps.js";
import { switchViewsOn } from "./helpers/read-model-switches.js";

type Part = { entries: number; bytes: number; used_bytes?: number; holds?: Record<string, { entries: number; bytes: number }>; holds_age_ms?: number };
type Reading = memory.HolderReading & { used_bytes?: number; parts?: Record<string, Part> };
type Holds = Record<string, { rows: number; keptBytes: number }>;

const T0 = Date.parse("2026-10-14T06:39:00.000Z");
const IDS = ["W1-T1", "W1-T2", "W1-T3"];
const HEAVY = `${memory.WORKER_HEAP_PREFIX}read-model-worker:spawnHeavyViews`;
const FAST = `${memory.WORKER_HEAP_PREFIX}read-model-worker:spawnViews`;
const MB = 1024 ** 2;
const USAGE: NodeJS.MemoryUsage = { rss: 4_500 * MB, heapTotal: 700 * MB, heapUsed: 600 * MB, external: 14 * MB, arrayBuffers: 6 * MB };

function task(id: string): Task {
  return { id, title: `task ${id}`, repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 };
}
const PLAN: Plan = { tasks: IDS.map(task), byId: new Map(IDS.map((id) => [id, task(id)])) };
const GATEWAY = {
  readFailed: () => false, prByRef: () => null, findMergedByTrailer: () => null, findMergedByHeadBranch: () => [], listMergedHeadBranches: () => [],
  listOpenHeadBranches: () => [], headRefName: () => undefined, prBody: () => undefined, issueByUrl: () => ({ state: "OPEN", title: "t" }),
} as unknown as GitHub;
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

function rows(from: number, n: number): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (let k = from; k < from + n; k++) {
    const id = IDS[k % IDS.length]!;
    out.push({ ts: iso(1_000 * k), step: "run.start", task_id: id, run_id: `r-${id}` });
    out.push({ ts: iso(1_000 * k + 10), step: "verdict", task_id: id, run_id: `r-${id}`, verdict: k % 2 ? "no_pr" : "failed" });
  }
  return out;
}

/** One instance's projected store over a real ledger, as the views lane's now view reads it. */
function store(t: TestContext, instance: string) {
  const dir = makeTempDir("w1-t9403-store");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let ms = T0 + 600_000;
  const clock: Clock = { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() };
  const db = openProjectorReadModel(join(dir, "home"), instance, clock);
  t.after(() => db.close());
  const got = acquireLease(db, { clock, ttlMs: 1e12 });
  assert.ok(got.ok);
  const ledgerDir = join(dir, instance, "state");
  mkdirSync(ledgerDir, { recursive: true });
  const projector = createLedgerProjector({ ledgerDir, db, lease: got.lease, clock });
  const lines: string[] = [];
  const append = (...r: Array<Record<string, unknown>>): void => {
    const text = r.map((x) => JSON.stringify({ ...x, host: "h1" }));
    lines.push(...text);
    appendFileSync(join(ledgerDir, "ledger.ndjson"), text.map((line) => `${line}\n`).join(""));
    projector.tick();
    ms += 1_000;
  };
  append(...rows(0, 6));
  // W1-T9436: these boards keep every row, so the count names every fact row; what the retention rules keep is counted
  // by the-board-projection-holds-per-key-state-not-history.test.ts.
  const board = (): BoardProjection => createBoardProjection({
    db, ledgerPath: join(ledgerDir, "ledger.ndjson"), clock, readPlan: () => PLAN, github: GATEWAY, githubGeneration: () => "g1",
    readCreditStore: () => ({}), readCreditOverrideFile: () => "", keepEveryRow: true,
  });
  const now = (): ReturnType<typeof createNowView> => {
    const feedbackRoot = join(ledgerDir, "checkout");
    mkdirSync(join(feedbackRoot, "plan", "feedback"), { recursive: true });
    const seams: Partial<NowViewOptions> = {
      readPlan: () => PLAN, github: () => ({ github: GATEWAY, generation: "g", source: { asOf: null, state: "fresh" } }),
      hostProbe: { rateLimit: () => 5_000, diskFree: () => 1_000_000, readLive: () => [] }, listGrilling: () => [], planBehind: () => ({ commits: 0 }),
    };
    return createNowView({ instances: [{ name: instance, ledgerDir, repo: "o/r", feedbackRoot }], clock, boardOptions: { keepEveryRow: true }, ...seams });
  };
  const ctx = (): NowViewContext => {
    const generation = Number((db as unknown as { meta(k: string): string | undefined }).meta("generation"));
    return { now: clock.now(), switches: { views: { now: "shadow" } }, instances: [{ state: { instance, generation, lease: "held", failures: 0, tickedAt: clock.now(), newestTs: null }, db: db as ReadModelDb }] };
  };
  const build = (view: ReturnType<typeof createNowView>): number => {
    const c = ctx();
    while (!view.prepare(c, () => true)) { /* to ready */ }
    return view.materialize(c).length;
  };
  return { db, append, board, now, build, lines };
}

function drain(board: BoardProjection): void {
  let n = 0;
  while (!board.update({ force: true }).caughtUp && n++ < 100) { /* to caught up */ }
}

/** Kept source text: each fact row's ledger line, less the steps the projection never parses. */
const keptOf = (lines: readonly string[]): { rows: number; keptBytes: number } => {
  const kept = lines.filter((line) => !BOARD_UNREAD_STEPS.has(String((JSON.parse(line) as { step?: unknown }).step)));
  return { rows: kept.length, keptBytes: kept.reduce((sum, line) => sum + line.length, 0) };
};

/** Preserve this suite's exact board-row/source-byte controls while W1-T9983 names other holders too. */
const sizeOf = (view: unknown): Holds => Object.fromEntries(Object.entries((view as { heldSizes(): Holds }).heldSizes())
  .filter(([, hold]) => typeof hold.rows === "number" && typeof hold.keptBytes === "number"));
const projectionSize = (board: BoardProjection): { rows: number; keptBytes: number } => (board as unknown as { size(): { rows: number; keptBytes: number } }).size();

/**
 * A views lane stand-in: the fast lane hands the `now` unit to the heavy lane, which posts what its now
 * view holds, exactly as a real lane posts after a now build. Kept alive until the lane is stopped.
 */
const LANE_FIXTURE = `import { parentPort, workerData } from "node:worker_threads";
const alive = setInterval(() => {}, 1000);
parentPort.on("message", (m) => { if (m && m.type === "stop") { clearInterval(alive); parentPort.close(); } });
if (workerData.lane === "fast") parentPort.postMessage({ type: "view_lane", view: "now", instance: "core", heavy: true, dueAt: 0 });
else parentPort.postMessage({ type: "view_holds", lane: workerData.lane, holds: workerData.fixtureHolds, observedAt: Date.now() });
`;

async function answered(views: ReadModelViewLane, book: ReturnType<typeof memory.trackWorkerThreads>, id: number): Promise<Reading[]> {
  const answers: Array<{ type?: string; id?: number; readings?: Reading[] }> = [];
  const port = { postMessage: (m: unknown) => void answers.push(m as (typeof answers)[number]) };
  const holdsOf = (views as unknown as { holdsOf?: (threadId: number) => Part["holds"] }).holdsOf;
  const ask = answerThreadHeaps as unknown as (p: typeof port, msg: unknown, b: typeof book, holds?: typeof holdsOf) => boolean;
  assert.equal(ask(port, { type: THREAD_HEAPS_REQUEST, id, timeoutMs: 10_000 }, book, holdsOf), true);
  for (let turn = 0; turn < 200 && answers.length === 0; turn += 1) await sleep(25);
  assert.equal(answers[0]?.type, THREAD_HEAPS_ANSWER);
  return answers[0]?.readings ?? [];
}

test("W1-T9403: serve.memory names the used heap of each thread and each held board projection", async (t) => {
  // The holds a heavy lane posts are what a real now view reports over real stores, one per instance.
  const core = store(t, "core");
  const site = store(t, "site");
  const holds: Holds = {};
  for (const s of [core, site]) {
    const view = s.now();
    assert.equal(s.build(view), 1, "control: the now view built one body");
    Object.assign(holds, sizeOf(view));
  }
  assert.deepEqual(Object.keys(holds).sort(), ["core", "site"], "each instance's held projection is named");
  assert.ok(holds.core!.rows > 0 && holds.core!.keptBytes > 0, `the core projection keeps rows: ${JSON.stringify(holds)}`);
  const fixtureHolds = { ...holds,
    "workstreams:payload@core": { entries: 1, bytes: 42, unit: "body", bytes_basis: "fixture-accounted-payload" },
    "workstreams:opaque@core": { entries: 1, unsized: "shared plan; exclusive bytes unavailable", unit: "container" },
  };

  const dir = makeTempDir("w1-t9403-lanes");
  const fixture = join(dir, "lane.mjs");
  writeFileSync(fixture, LANE_FIXTURE);
  const book = memory.trackWorkerThreads();
  const views = threadViews({
    data: { stateDir: dir, instances: [], tickMs: 20, holder: "w1-t9403", fixtureHolds } as Parameters<typeof threadViews>[0]["data"],
    relay: () => {}, log: () => {}, workerUrl: pathToFileURL(fixture), every: () => () => {},
  });
  t.after(async () => {
    views.close();
    await Promise.all(book.live().map(({ thread }) => (thread as Worker).terminate()));
    book.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  let readings: Reading[] = [];
  const heavyPart = (): Part | undefined => Object.values(readings.find((r) => r.name === HEAVY)?.parts ?? {})[0];
  for (let id = 1; id <= 20 && !(heavyPart()?.holds && heavyPart()?.used_bytes); id += 1) {
    if (id > 1) await sleep(100);
    readings = await answered(views, book, id);
  }
  const sample = memory.sampleServeMemory([], { usage: () => USAGE, headroom: () => undefined, workerHeaps: readings });
  const heavy = sample.holders.find((holder) => holder.name === HEAVY) as Reading | undefined;
  const fast = sample.holders.find((holder) => holder.name === FAST) as Reading | undefined;
  assert.ok(heavy && fast, `both lanes are on the serve.memory row: ${JSON.stringify(sample.holders)}`);
  const part = Object.values(heavy.parts ?? {})[0]!;
  assert.equal(typeof part.used_bytes, "number", `the heavy lane's part carries its used heap: ${JSON.stringify(heavy)}`);
  assert.ok(part.used_bytes! > 0 && part.used_bytes! <= part.bytes, `used (${part.used_bytes}) is within committed (${part.bytes})`);
  assert.equal(heavy.used_bytes, part.used_bytes, "the reading sums its parts' used heap as it sums their bytes");
  assert.ok(typeof part.holds_age_ms === "number" && part.holds_age_ms >= 0, "the real worker and default clock carry report age");
  assert.deepEqual(part.holds, {
    "board:core": { entries: holds.core!.rows, bytes: holds.core!.keptBytes },
    "board:site": { entries: holds.site!.rows, bytes: holds.site!.keptBytes },
    "workstreams:payload@core": fixtureHolds["workstreams:payload@core"],
    "workstreams:opaque@core": fixtureHolds["workstreams:opaque@core"],
  }, "exact board bytes survive real-thread transport; canonical holders keep their names, basis and unknown sizes");
  const fastPart = Object.values(fast.parts ?? {})[0]!;
  assert.equal(typeof fastPart.used_bytes, "number", "every thread's part carries its used heap");
  assert.equal(fastPart.holds, undefined, "a lane that never built a now view has no holds");
});

test("W1-T9403: a thread's used heap is read beside its committed heap, and an unreadable thread has none", async () => {
  const stats = { total_heap_size: 1_000, used_heap_size: 600, external_memory: 50 };
  const thread = (threadId: number, read: () => Promise<Partial<typeof stats>>): WorkerThread =>
    ({ threadId, getHeapStatistics: read, once: () => undefined }) as unknown as WorkerThread;
  const read = readWorkerHeaps as unknown as (w: Parameters<typeof readWorkerHeaps>[0], ms: number, holds?: (id: number) => Part["holds"]) => Promise<Reading[]>;
  const readings = await read([
    { kind: "probe:views", thread: thread(7, async () => stats) },
    { kind: "probe:views", thread: thread(8, async () => { throw new Error("thread is gone"); }) },
    { kind: "probe:views", thread: thread(9, async () => ({ total_heap_size: 300, external_memory: 20 })) },
  ], 1_000, (id) => (id === 7 ? { "board:core": { entries: 3, bytes: 120 } } : undefined));
  assert.equal(readings.length, 1);
  const [reading] = readings;
  assert.equal(reading!.bytes, 1_370, "the committed heap is unchanged: total + external");
  assert.equal(reading!.used_bytes, 650, "the used heap is used + external, summed over the parts that report one");
  assert.deepEqual(reading!.parts!["thread-7"], { entries: 1, bytes: 1_050, used_bytes: 650, holds: { "board:core": { entries: 3, bytes: 120 } },
    holds_age_reason: "holder report time unavailable or ahead of sample clock", unattributed_used_bytes: 530,
    unattributed_used_basis: "used-heap-less-named-payload-estimates-not-exclusive-v8" });
  assert.deepEqual(reading!.parts!["thread-8"], { entries: 1, bytes: 0 }, "an unreadable thread has no used_bytes: absent, never zero");
  assert.deepEqual(reading!.parts!["thread-9"], { entries: 1, bytes: 320 }, "a runtime that reports no used heap leaves it absent, never NaN");
  assert.match(reading!.error ?? "", /thread 8 unsized: thread is gone/);
});

test("W1-T9403: a views lane posts each held board projection after each now build", (t) => {
  const stateDir = makeTempDir("w1-t9403-ticker");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const ledgerDir = join(stateDir, "core");
  mkdirSync(ledgerDir);
  writeFileSync(join(ledgerDir, "ledger.ndjson"), "");
  const instances = [{ name: "core", ledgerDir }];
  switchViewsOn(stateDir, ["now", "plain"], "shadow");
  let now = T0;
  const clock: Clock = { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() };
  const states: ReadModelWorkerMessage[] = [];
  const projector = createReadModelTicker({ stateDir, instances, views: [], oracle: "off", holder: "w1-t9403", clock, post: (m) => void states.push(m) });
  projector.start();
  let kept = 0;
  const holding: ReadModelViewFactory = { name: "now", perInstance: true, create: () => ({ name: "now", perInstance: true, version: 1,
    heldSizes: () => ({ core: { rows: kept, keptBytes: kept * 40 } }),
    materialize: ({ instances: scoped }) => scoped.map(({ state }) => {
      kept += 2;
      return { key: `instance=${state.instance}`, data: { kept }, sources: [] };
    }) }) as ReturnType<ReadModelViewFactory["create"]> };
  const plain: ReadModelViewFactory = { name: "plain", perInstance: true, create: () => ({ name: "plain", perInstance: true, version: 1,
    materialize: ({ instances: scoped }) => scoped.map(({ state }) => ({ key: `instance=${state.instance}`, data: { now }, sources: [] })) }) };
  const posts: ReadModelWorkerMessage[] = [];
  const lane = createReadModelTicker({ stateDir, instances, views: [holding, plain], viewsOnly: true, lane: "fast", oracle: "off", holder: "w1-t9403", clock,
    passBudgetMs: 1_000_000, post: (m) => void posts.push(m) });
  lane.start();
  t.after(() => { lane.release(); projector.release(); });
  const tick = (): void => {
    projector.tick();
    const state = states.findLast((m) => m.type === "state");
    assert.ok(state && state.type === "state");
    lane.observe(state.instances as ReadModelInstanceState[]);
    lane.tick();
  };
  // Both units are cheap, so the fast lane keeps them; a lane posts the same way whichever it is.
  tick();
  now += 10 * 60_000;
  tick();
  const held = posts.filter((m) => (m as { type: string }).type === "view_holds") as unknown as Array<{ lane: string; holds: Holds & Record<string, { entries?: number; bytes?: number; unsized?: string }>; observedAt: number }>;
  assert.ok(posts.some((m) => m.type === "body" && m.entry.view === "plain"), "control: the plain view was built too");
  assert.deepEqual(held.map((report) => ({ lane: report.lane, board: report.holds.core, units: report.holds["lane:fast"]?.entries, at: report.observedAt })), [
    { lane: "fast", board: { rows: 2, keptBytes: 80 }, units: 2, at: T0 },
    { lane: "fast", board: { rows: 2, keptBytes: 80 }, units: 2, at: T0 },
    { lane: "fast", board: { rows: 4, keptBytes: 160 }, units: 2, at: now },
    { lane: "fast", board: { rows: 4, keptBytes: 160 }, units: 2, at: now },
  ], "each owned unit reports; the exact board controls survive the additional non-now reports");
  assert.ok(held.every(report => report.holds["lane:fast"]?.bytes === undefined && report.holds["lane:fast"]?.unsized), "opaque lane bookkeeping remains explicitly unsized");
});

test("W1-T9403: the board projection and the now view report the rows and source bytes they keep", (t) => {
  const s = store(t, "core");
  const board = s.board();
  assert.deepEqual(projectionSize(board), { rows: 0, keptBytes: 0 }, "nothing is kept before an ingest");
  drain(board);
  assert.deepEqual(projectionSize(board), keptOf(s.lines), "each kept fact row and its source text are counted");
  s.append(...rows(6, 2), { ts: iso(9_000), step: [...BOARD_UNREAD_STEPS][0]!, task_id: "W1-T1" });
  drain(board);
  assert.deepEqual(projectionSize(board), keptOf(s.lines), "an append is counted as it is ingested; an unparsed step is not kept");
  assert.equal(projectionSize(board).rows, board.rows().length - 1, "the rows counted are the rows the projection holds, less its sentinel");

  const view = s.now();
  assert.deepEqual(sizeOf(view), {}, "a now view that never built holds nothing");
  assert.equal(s.build(view), 1, "control: one body");
  assert.deepEqual(sizeOf(view), { core: keptOf(s.lines) }, "the now view names its held projection by instance");
});
