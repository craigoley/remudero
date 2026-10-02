import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Clock } from "../src/lib/clock.js";
import { openReadModel } from "../src/lib/read-model-db.js";
import { LEDGER_PROJECTOR_SCHEMA_VERSION } from "../src/lib/ledger-projector.js";
import { setTimeout as sleep } from "node:timers/promises";
import { createReadModelTicker, runReadModelViewWorker, type ReadModelBodyEntry, type ReadModelView, type ReadModelViewsInput, type ReadModelWorkerMessage } from "../src/lib/read-model-worker.js";
import { makeTempDir } from "../src/lib/tmp.js";
import {
  VIEW_DEMAND_EVICT_MS,
  VIEW_DEMAND_MAX_PENDING,
  VIEW_DEMAND_WAIT_MS,
  awaitViewDemand,
  createDemandBook,
  touchViewDemand,
  type ViewDemandSource,
} from "../src/lib/view-demand.js";
import { buildReadModelViewRoutes, viewEtag, type ViewBodySource } from "../src/lib/views.js";

const T0 = Date.parse("2026-10-02T12:00:00.000Z");
const KEY = "id=W1-T1&instance=core";

type TestCtx = { after: (fn: () => void) => void };

function scratch(t: TestCtx, kind: string): string {
  const dir = makeTempDir(kind);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seeded(t: TestCtx, kind: string): string {
  const dir = scratch(t, kind);
  seedRunRows(dir);
  return dir;
}

function mutableClock(): Clock & { advance(ms: number): void } {
  let at = T0;
  return { now: () => at, date: () => new Date(at), iso: () => new Date(at).toISOString(), advance: (ms) => void (at += ms) };
}

function seedRunRows(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const rows = [0, 1, 2].map((i) => JSON.stringify({ ts: new Date(T0 - 60_000 + i).toISOString(), step: "run.start", task_id: `T${i}`, run_id: `T${i}-1` }));
  writeFileSync(join(dir, "ledger.ndjson"), `${rows.join("\n")}\n`);
}

/** A demand view that builds one body per live key and counts its builds. */
function demandView(book: ReturnType<typeof createDemandBook>, builds: string[][]): ReadModelView {
  return {
    name: "task",
    version: 1,
    demand: true,
    materialize: () => {
      const keys = book.keys("task");
      builds.push(keys);
      return keys.map((key) => ({ key, data: { key }, sources: [] }));
    },
  };
}

/** Serve's side as the tests need it: the bodies a ticker posts, a listener list, and `want` handed to the ticker. */
function fakeMain(wantTicker: () => { want(view: string, key: string): boolean }): ViewDemandSource<ReadModelBodyEntry> & { messages: ReadModelWorkerMessage[]; post: (m: ReadModelWorkerMessage) => void; wants: string[] } {
  const bodies = new Map<string, ReadModelBodyEntry>();
  const listeners = new Set<(entry: ReadModelBodyEntry) => void>();
  const messages: ReadModelWorkerMessage[] = [];
  const wants: string[] = [];
  return {
    messages,
    wants,
    post: (m) => {
      messages.push(m);
      if (m.type === "body") {
        bodies.set(`${m.entry.view}|${m.entry.key}`, m.entry);
        for (const listener of listeners) listener(m.entry);
      } else if (m.type === "drop") bodies.delete(`${m.view}|${m.key}`);
    },
    body: (view, key = "") => bodies.get(`${view}|${key}`),
    want: (view, key) => {
      wants.push(`${view}|${key}`);
      wantTicker().want(view, key);
      return true;
    },
    onBody: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function ticker(t: TestCtx, opts: { clock: Clock; stateDir: string; ledgerDir: string; book: ReturnType<typeof createDemandBook>; builds: string[][]; post: (m: ReadModelWorkerMessage) => void }) {
  const made = createReadModelTicker({
    stateDir: opts.stateDir, instances: [{ name: "core", ledgerDir: opts.ledgerDir }], clock: opts.clock, holder: "view-demand", oracle: "off",
    demand: opts.book, views: [demandView(opts.book, opts.builds)], post: opts.post,
  });
  t.after(() => made.release());
  made.start();
  return made;
}

test("W1-T5048: a first read of an unmaterialized task key is answered after one worker pass", async (t) => {
  const clock = mutableClock();
  const book = createDemandBook({ clock });
  const builds: string[][] = [];
  let made: ReturnType<typeof ticker> | undefined;
  const main = fakeMain(() => made!);
  made = ticker(t, { clock, stateDir: scratch(t, "vd-state"), ledgerDir: seeded(t, "vd-ledger"), book, builds, post: main.post });
  assert.equal(main.body("task", KEY), undefined, "nothing is materialized for the key yet");

  const timers: Array<() => void> = [];
  const answer = awaitViewDemand(main, "task", KEY, { after: (run) => (timers.push(run), () => {}) });
  assert.deepEqual(main.wants, [`task|${KEY}`], "main posted want{view, key} for the missing key");
  let settled = false;
  void answer.then(() => (settled = true));
  await Promise.resolve();
  assert.equal(settled, false, "the read waits: it is not answered before the worker has run a pass");

  made.tick(); // the one worker pass
  const got = await answer;
  assert.equal(got.ok, true, "the read is answered by that pass");
  if (got.ok) assert.deepEqual(got.entry.body.data, { key: KEY });
  assert.equal(builds.filter((keys) => keys.includes(KEY)).length, 1, "the key was built by exactly one pass");
  assert.equal(timers.length, 1, "one 300 ms timer was armed for the wait");
});

test("W1-T5048: a miss past 300 ms answers view_not_ready with retryMs", async () => {
  const main: ViewDemandSource = { body: () => undefined, want: () => true, onBody: () => () => {} };
  let fire: () => void = () => {};
  let armedFor = -1;
  const answer = awaitViewDemand(main, "task", KEY, { after: (run, ms) => ((fire = run), (armedFor = ms), () => {}) });
  assert.equal(armedFor, VIEW_DEMAND_WAIT_MS);
  assert.equal(VIEW_DEMAND_WAIT_MS, 300);
  fire();
  const got = await answer;
  assert.deepEqual(got, { ok: false, reason: "timeout", retryMs: got.ok ? 0 : got.retryMs });
  assert.ok(!got.ok && got.retryMs > 0);

  const bare: ViewDemandSource = { body: () => undefined };
  const refused = await awaitViewDemand(bare, "task", KEY);
  assert.ok(!refused.ok && refused.reason === "no_worker", "with no worker to ask the read is refused at once");
});

test("W1-T5048: pending wants are bounded at 64 and concurrent reads of a key share one wait", async () => {
  const wanted: string[] = [];
  const main: ViewDemandSource = { body: () => undefined, want: (view, key) => (wanted.push(`${view}|${key}`), true), onBody: () => () => {} };
  const fires: Array<() => void> = [];
  const after = (run: () => void): (() => void) => (fires.push(run), () => {});
  const waits = Array.from({ length: VIEW_DEMAND_MAX_PENDING }, (_, i) => awaitViewDemand(main, "task", `id=T${i}&instance=core`, { after }));
  const over = await awaitViewDemand(main, "task", "id=over&instance=core", { after });
  assert.ok(!over.ok && over.reason === "saturated", "the 65th want is refused");
  assert.equal(wanted.length, VIEW_DEMAND_MAX_PENDING, "a refused want is never posted");
  const again = awaitViewDemand(main, "task", "id=T0&instance=core", { after });
  assert.equal(again, waits[0], "a second read of a key already waited on shares its wait");
  assert.equal(wanted.length, VIEW_DEMAND_MAX_PENDING);
  for (const fire of fires) fire();
  await Promise.all(waits);
  const later = await awaitViewDemand(main, "task", "id=over&instance=core", { after: (run) => (queueMicrotask(run), () => {}) });
  assert.ok(!later.ok && later.reason === "timeout", "settled waits free their slots");
});

test("W1-T5048: an unread keyed view is evicted after ten minutes", (t) => {
  assert.equal(VIEW_DEMAND_EVICT_MS, 10 * 60_000);
  const clock = mutableClock();
  const book = createDemandBook({ clock });
  const builds: string[][] = [];
  const stateDir = scratch(t, "vde-state");
  let made: ReturnType<typeof ticker> | undefined;
  const main = fakeMain(() => made!);
  made = ticker(t, { clock, stateDir, ledgerDir: seeded(t, "vde-ledger"), book, builds, post: main.post });
  const storedKeys = (): string[] => {
    const db = openReadModel({ stateDir, instance: "core", schemaVersion: LEDGER_PROJECTOR_SCHEMA_VERSION, readOnly: true });
    try {
      return db.prepare("SELECT key FROM view_body WHERE view = 'task'").all().map((row) => String(row.key));
    } finally {
      db.close();
    }
  };

  main.want?.("task", KEY);
  made.tick();
  assert.ok(main.body("task", KEY), "the wanted key was materialized");
  assert.deepEqual(storedKeys(), [KEY], "and persisted");

  clock.advance(VIEW_DEMAND_EVICT_MS - 60_000);
  made.tick();
  assert.ok(main.body("task", KEY), "a key unread for under ten minutes stays");
  assert.deepEqual(book.keys("task"), [KEY]);

  clock.advance(60_000);
  made.tick();
  assert.equal(main.body("task", KEY), undefined, "a key unread for ten minutes is dropped from serve's memory");
  assert.deepEqual(book.keys("task"), [], "the worker no longer keeps it live");
  assert.deepEqual(storedKeys(), [], "and deleted from the store");
  assert.ok(main.messages.some((m) => m.type === "drop" && m.key === KEY), "serve was told to drop it");
  const buildsAfter = builds.length;
  clock.advance(5_000);
  made.tick();
  assert.ok(builds.slice(buildsAfter).every((keys) => !keys.includes(KEY)), "an evicted key is not built again");
});

test("W1-T5048: a key that is read again is kept ten minutes from its last read, and a pinned key is never evicted", (t) => {
  const clock = mutableClock();
  const pinned = new Set<string>();
  const book = createDemandBook({ clock, pinned: (view, key) => pinned.has(`${view}|${key}`) });
  const builds: string[][] = [];
  let made: ReturnType<typeof ticker> | undefined;
  const main = fakeMain(() => made!);
  made = ticker(t, { clock, stateDir: scratch(t, "vdk-state"), ledgerDir: seeded(t, "vdk-ledger"), book, builds, post: main.post });
  const PINNED = "id=W1-T2&instance=core";
  main.want?.("task", KEY);
  main.want?.("task", PINNED);
  pinned.add(`task|${PINNED}`);
  made.tick();
  clock.advance(9 * 60_000);
  main.want?.("task", KEY); // read again
  made.tick();
  clock.advance(9 * 60_000);
  made.tick();
  assert.ok(main.body("task", KEY), "a read nine minutes ago keeps the key");
  assert.ok(main.body("task", PINNED), "a pinned key outlives ten minutes");
  clock.advance(2 * 60_000);
  made.tick();
  assert.equal(main.body("task", KEY), undefined, "unread for ten minutes since its last read, it goes");
  assert.ok(main.body("task", PINNED));
});

test("W1-T5048: a body an earlier run persisted is dropped unless this run is asked for it", (t) => {
  const clock = mutableClock();
  const stateDir = scratch(t, "vds-state");
  const ledgerDir = seeded(t, "vds-ledger");
  const first = createDemandBook({ clock });
  const firstMain = fakeMain(() => firstTicker);
  const firstTicker = ticker(t, { clock, stateDir, ledgerDir, book: first, builds: [], post: firstMain.post });
  firstMain.want?.("task", KEY);
  firstTicker.tick();
  assert.ok(firstMain.body("task", KEY));
  firstTicker.release();

  const book = createDemandBook({ clock });
  const main = fakeMain(() => made);
  const made = ticker(t, { clock, stateDir, ledgerDir, book, builds: [], post: main.post });
  made.tick();
  assert.ok(main.messages.some((m) => m.type === "drop" && m.key === KEY), "the stale persisted key is dropped on this run's first sweep");
});

test("W1-T5048: the view routes ask the worker for a missing key and answer from its body", async () => {
  const clock = mutableClock();
  let switches = { projector: "on" as const, views: { task: "serve" as const } };
  const listeners = new Set<(entry: ReadModelBodyEntry) => void>();
  const bodies = new Map<string, ReadModelBodyEntry>();
  const wants: string[] = [];
  const entry: ReadModelBodyEntry = {
    view: "task", key: KEY, version: 1, generation: 1, etag: viewEtag("task", 1, false, { id: "W1-T1" }),
    body: { view: "task", version: 1, generatedAt: clock.iso(), asOf: null, stale: false, sources: [], data: { id: "W1-T1" } },
  };
  const readModel: ViewBodySource = {
    body: (view, key = "") => bodies.get(`${view}|${key}`),
    judge: (sources) => [...sources],
    switches: () => switches,
    want: (view, key) => {
      wants.push(`${view}|${key}`);
      // The worker answers on a later turn, as a thread would.
      setImmediate(() => {
        bodies.set(`${view}|${key}`, entry);
        for (const listener of listeners) listener(entry);
      });
      return true;
    },
    onBody: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
  };
  const route = buildReadModelViewRoutes({ legacy: [], readModelViews: ["task"], readModel, clock }).find((r) => r.path === "/v1/views/task")!;
  const call = (url: string): Promise<{ status: number; body: Record<string, unknown> }> =>
    new Promise((resolve) => {
      let status = 0;
      const res = {
        headersSent: false,
        once: () => res,
        writeHead: (code: number) => void (status = code),
        end: (text?: string) => resolve({ status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} }),
      };
      void route.handler({ url, headers: {} } as never, res as never, {} as never);
    });

  assert.equal((await call("/v1/views/task?instance=core")).status, 400, "the key needs both instance and id");
  const first = await call("/v1/views/task?instance=core&id=W1-T1");
  assert.equal(first.status, 200, "a first read is answered once the worker has built the key");
  assert.deepEqual(wants, [`task|${KEY}`], "main wanted the key with its sorted-query form");
  assert.deepEqual((first.body.data as { id: string }).id, "W1-T1");
  const second = await call("/v1/views/task?id=W1-T1&instance=core");
  assert.equal(second.status, 200);
  assert.equal(wants.length, 1, "a key that is held is not asked for again within the touch interval");
  clock.advance(61_000);
  await call("/v1/views/task?id=W1-T1&instance=core");
  assert.equal(wants.length, 2, "a served key is re-wanted now and then so the worker keeps it");

  bodies.clear();
  const never: ViewBodySource = { ...readModel, want: (view, key) => (wants.push(`${view}|${key}`), true) };
  const silent = buildReadModelViewRoutes({ legacy: [], readModelViews: ["task"], readModel: never, clock }).find((r) => r.path === "/v1/views/task")!;
  // The wait's own timer is unref'd (a socket keeps the loop alive in serve); this test has no socket.
  const keepAlive = setTimeout(() => {}, 5_000);
  const miss = await new Promise<{ status: number; body: Record<string, unknown> }>((resolve) => {
    let status = 0;
    const res = { headersSent: false, once: () => res, writeHead: (code: number) => void (status = code), end: (text?: string) => resolve({ status, body: JSON.parse(text ?? "{}") as Record<string, unknown> }) };
    void silent.handler({ url: "/v1/views/task?instance=core&id=W1-T9", headers: {} } as never, res as never, {} as never);
  });
  clearTimeout(keepAlive);
  assert.equal(miss.status, 404);
  assert.equal(miss.body.error, "view_not_ready");
  assert.equal(typeof miss.body.retryMs, "number", "a miss past 300 ms carries retryMs");
  switches = { projector: "on", views: {} } as never;
  const off = await call("/v1/views/task?instance=core&id=W1-T1");
  assert.equal(off.status, 404);
  assert.equal(off.body.error, "view_disabled", "a view that is not switched to serve asks for nothing");
});

test("W1-T5048: touching a held key re-wants it at most once per interval", () => {
  const wants: string[] = [];
  const main: ViewDemandSource = { body: () => undefined, want: (view, key) => (wants.push(`${view}|${key}`), true) };
  touchViewDemand(main, "task", KEY, T0);
  touchViewDemand(main, "task", KEY, T0 + 1_000);
  touchViewDemand(main, "task", KEY, T0 + 61_000);
  assert.equal(wants.length, 2);
});

test("W1-T5048: the view thread builds a wanted task key in the pass its want message triggers", async (t) => {
  const stateDir = scratch(t, "vdw-state");
  const ledgerDir = seeded(t, "vdw-ledger");
  const instances = [{ name: "core", ledgerDir }];
  // The projector thread's side: it holds the lease and posts the instance state the view thread waits for.
  const posted: ReadModelWorkerMessage[] = [];
  const projector = createReadModelTicker({ stateDir, instances, oracle: "off", holder: "vdw-projector", views: [], post: (m) => void posted.push(m) });
  t.after(() => projector.release());
  projector.start();
  projector.tick();
  const state = posted.find((m) => m.type === "state");
  assert.ok(state && state.type === "state", "the projector posted its state");

  const handlers: Array<(msg: ReadModelViewsInput) => void> = [];
  const out: ReadModelWorkerMessage[] = [];
  runReadModelViewWorker(
    { on: (_event, run) => void handlers.push(run), postMessage: (m) => void out.push(m as ReadModelWorkerMessage), close: () => {} },
    // A tick a minute: only the want message can have built the key within this test.
    { stateDir, instances, tickMs: 60_000, holder: "vdw-projector" },
  );
  const send = (msg: ReadModelViewsInput): void => handlers.forEach((run) => run(msg));
  t.after(() => send({ type: "stop" }));
  await sleep(50); // the thread finishes starting; messages before that are queued
  send({ type: "state", instances: state.instances });
  const taskBodies = (): ReadModelBodyEntry[] => out.flatMap((m) => (m.type === "body" && m.entry.view === "task" ? [m.entry] : []));
  await sleep(100);
  assert.deepEqual(taskBodies(), [], "no task key is built until one is wanted");

  send({ type: "want", view: "task", key: KEY });
  for (let waited = 0; waited < 5_000 && taskBodies().length === 0; waited += 20) await sleep(20);
  assert.equal(taskBodies().filter((entry) => entry.key === KEY).length, 1, "the want message built the key in a pass of its own, long before the next timer tick");
  assert.equal((taskBodies()[0]!.body.data as { id: string; instance: string }).id, "W1-T1");
});
