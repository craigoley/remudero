import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { mock, test } from "node:test";
import type { Clock } from "../src/lib/clock.js";
import type { Task } from "../src/lib/plan.js";
import { openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { BOARD_PROJECTION_DDL } from "../src/lib/board-projection.js";
import { createReadModelTicker, ledgerSource, type ReadModelBodyEntry, type ReadModelWorkerMessage } from "../src/lib/read-model-worker.js";
import type { GitHub } from "../src/lib/status.js";
import { flushReadModelTransactions, type ReadModelDb } from "#src/lib/read-model-db.js";
import { createTaskView, readRunTail, taskViewKey, type ReadModelInstanceState, type TaskViewData, type TaskViewOptions } from "../src/lib/task-view.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { TASK_VIEW_NAME, createDemandBook } from "../src/lib/view-demand.js";
import { switchViewsOn } from "./helpers/read-model-switches.js";
import { ACTIVITY_RING_PROJECTION, ledgerLineIdentity } from "#src/lib/ledger-projector.js";
import { TASK_ACTIVITY_KEYS_PER_TASK, TASK_ACTIVITY_PAGE_EVENTS, TASK_ACTIVITY_PASS_KEYS, type TaskActivity } from "#src/lib/task-view.js";
import { encodeTaskActivityCursor, viewKey } from "#src/lib/views.js";

const T0 = Date.parse("2026-10-02T12:00:00.000Z");
const ID = "W1-T1";
const RUN = `${ID}-1000`;
const PR_URL = "https://github.com/o/r/pull/7";
const KEY = taskViewKey("core", ID);

type TestCtx = { after: (fn: () => void) => void };

function mutableClock(): Clock & { advance(ms: number): void } {
  let at = T0;
  return { now: () => at, date: () => new Date(at), iso: () => new Date(at).toISOString(), advance: (ms) => void (at += ms) };
}

interface Fixture {
  root: string;
  stateDir: string;
  ledgerDir: string;
  releases: Array<() => void>;
}

async function retireFixture(root: string, releases: readonly (() => void)[], settle = flushReadModelTransactions): Promise<void> {
  const errors: unknown[] = [];
  for (const release of releases) {
    try { release(); } catch (error) { errors.push(error); }
  }
  if (errors.length > 0) throw new AggregateError(errors, "task-view fixture release failed; directory preserved");
  await settle();
  rmSync(root, { recursive: true, force: true });
}

function fixture(t: TestCtx): Fixture {
  const root = makeTempDir("task-view");
  const releases: Array<() => void> = [];
  t.after(() => retireFixture(root, releases));
  const ledgerDir = join(root, "state");
  mkdirSync(join(ledgerDir, "runs"), { recursive: true });
  const row = (ms: number, extra: Record<string, unknown>): string => JSON.stringify({ ts: new Date(T0 - 60_000 + ms).toISOString(), task_id: ID, run_id: RUN, ...extra });
  writeFileSync(
    join(ledgerDir, "ledger.ndjson"),
    [row(1, { step: "run.start" }), row(2, { step: "pr.opened", pr_url: PR_URL, pr_number: 7 }), row(3, { step: "verdict", verdict: "pass", cost_usd: 1.5 })].join("\n") + "\n",
  );
  writeFileSync(join(ledgerDir, "runs", `${RUN}.tail`), "first line\nsecond line\nlast line\n");
  return { root, stateDir: join(root, "read-model-state"), ledgerDir, releases };
}

const PLANNED = { id: ID, title: "the planned title", type: "implement", risk: "low", status: "queued", depends_on: ["W1-T0"], attempts: 0, acceptance: [{ claim: "c", proof: "p" }] } as unknown as Task;

/** A gateway that holds one PR and counts every lookup; any other method is a failure of the test. */
function countingGateway(): GitHub & { lookups: string[] } {
  const lookups: string[] = [];
  return new Proxy({ lookups } as unknown as GitHub & { lookups: string[] }, {
    get: (target, name) => {
      if (name === "lookups") return target.lookups;
      if (name === "prByRef") return (ref: string) => (lookups.push(ref), ref === PR_URL ? { number: 7, url: PR_URL, state: "MERGED", title: "the PR" } : null);
      throw new Error(`the task view called gateway.${String(name)}`);
    },
  });
}

/** Counts every way this process can start a child; the spies are on the real module and re-synced into the ESM exports. */
function spawnSpy(t: TestCtx): { calls: string[] } {
  const calls: string[] = [];
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const) {
    mock.method(childProcess, name, (() => {
      calls.push(name);
      throw new Error(`task view spawned a child: ${name}`);
    }) as never);
  }
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  return { calls };
}

/** Runs a real ticker with the task view until the wanted key's body shows the ledger rows projected. */
function build(_t: TestCtx, f: Fixture, overrides: Partial<TaskViewOptions> = {}, key = KEY): { data: TaskViewData; body: ReadModelBodyEntry["body"]; messages: ReadModelWorkerMessage[]; ticker: ReturnType<typeof createReadModelTicker> } {
  const clock = mutableClock();
  const demand = createDemandBook({ clock });
  const messages: ReadModelWorkerMessage[] = [];
  const instance = { name: "core", ledgerDir: f.ledgerDir, repo: "o/r" };
  const view = createTaskView({ instances: [instance], ledgerSource, demand, clock, readTask: () => ({ task: PLANNED, source: { asOf: clock.iso(), state: "fresh" } }), ...overrides });
  switchViewsOn(f.stateDir, [TASK_VIEW_NAME]);
  const ticker = createReadModelTicker({
    stateDir: f.stateDir, instances: [instance], clock, holder: "task-view", oracle: "off", demand, views: [view], post: (m) => void messages.push(m),
  });
  f.releases.push(() => ticker.release());
  ticker.start();
  ticker.want(TASK_VIEW_NAME, key);
  const latest = (): ReadModelBodyEntry | undefined => messages.flatMap((m) => (m.type === "body" && m.entry.view === TASK_VIEW_NAME && m.entry.key === key ? [m.entry] : [])).at(-1);
  for (let tick = 0; tick < 40 && ((latest()?.body.data as TaskViewData | undefined)?.runs.length ?? 0) === 0; tick++) {
    ticker.tick();
    clock.advance(1_000);
  }
  const entry = latest();
  assert.ok(entry, "the wanted key was materialized");
  return { data: entry.body.data as TaskViewData, body: entry.body, messages, ticker };
}

function seedProjection(f: Fixture): void {
  const db = openProjectorReadModel(f.stateDir, "core");
  try {
    db.exec(BOARD_PROJECTION_DDL);
    db.prepare("INSERT OR REPLACE INTO task_projection(task_id, stamp, json) VALUES(?, ?, ?)").run(ID, "s", JSON.stringify({ taskId: ID, status: "merged", merged: true, source: "ledger", prNumber: 7, prUrl: PR_URL, prState: "MERGED" }));
  } finally {
    db.close();
  }
}

test("W1-T5048: the task view reads pr state from the gateway and spawns no github read", (t) => {
  const f = fixture(t);
  const spy = spawnSpy(t);
  const gateway = countingGateway();
  const { data, body } = build(t, f, { github: () => ({ github: gateway, source: { asOf: new Date(T0).toISOString(), state: "fresh" } }) });
  assert.equal(data.runs.length, 1);
  assert.deepEqual(data.runs[0]!.pr, { url: PR_URL, number: 7, state: "MERGED", title: "the PR" }, "the run's PR state is the gateway's");
  assert.deepEqual(gateway.lookups, [PR_URL], "the gateway was asked once, for the run's PR");
  assert.deepEqual(spy.calls, [], "no child process was started to read GitHub");
  assert.ok(body.sources.some((s) => s.name === "github:core"), "the body names its github source");
});

test("W1-T5048: the default gateway is the persisted snapshot: a PR it does not hold reads unknown and spawns nothing", (t) => {
  const f = fixture(t);
  const spy = spawnSpy(t);
  const { data, body } = build(t, f);
  assert.match(String(data.reason), /no task projection yet/, "a store with no projection table says so");
  assert.equal(data.runs[0]!.pr?.state, "unknown");
  assert.match(String(data.runs[0]!.pr?.reason), /./, "and says why");
  assert.deepEqual(spy.calls, [], "no child process was started");
  const github = body.sources.find((s) => s.name === "github:core");
  assert.ok(github && github.state !== "fresh", "an absent snapshot reads as a stale github source");
  assert.equal(body.stale, true);
});

test("W1-T5048: the task view is built from the projection row, the indexed fact rows, the tail and the plan", (t) => {
  const f = fixture(t);
  // The projection table is the board's; a first body may precede it, so seed it before the key is built.
  const seed = createReadModelTicker({ stateDir: f.stateDir, instances: [{ name: "core", ledgerDir: f.ledgerDir }], clock: mutableClock(), oracle: "off", views: [], post: () => {} });
  seed.start();
  seed.tick();
  seed.release();
  seedProjection(f);
  const { data, body } = build(t, f, { github: () => ({ github: countingGateway(), source: { asOf: new Date(T0).toISOString(), state: "fresh" } }) });
  assert.equal(data.found, true);
  assert.equal(data.projection?.status, "merged");
  assert.equal(data.projection?.prNumber, 7);
  assert.equal(data.task?.title, "the planned title");
  assert.deepEqual(data.task?.dependsOn, ["W1-T0"]);
  assert.ok(data.facts.length >= 3 && data.facts.every((fact) => typeof fact.seq === "number"), "the fact rows are listed");
  assert.deepEqual(data.facts.map((fact) => fact.step).sort(), ["pr.opened", "run.start", "verdict"]);
  assert.equal(data.runs[0]!.verdict, "pass");
  assert.equal(data.trace.costUsd, 1.5);
  assert.equal(data.trace.lastVerdict, "pass");
  assert.equal(data.trace.runs, 1);
  assert.deepEqual(data.tail, { runId: RUN, lines: ["first line", "second line", "last line"] });
  assert.deepEqual(body.sources.map((s) => s.name).sort(), ["github:core", "ledger:core", "plan:core"]);
});

test("W1-T5048: an instance the worker does not project is reported, not thrown", (t) => {
  const f = fixture(t);
  const unknown = build(t, f, {}, taskViewKey("nowhere", ID));
  assert.equal(unknown.data.found, false);
  assert.match(String(unknown.data.reason), /no instance named nowhere/);
  assert.equal(unknown.body.stale, true, "the body is stale: its ledger source is unavailable");
});

test("W1-T5048: readRunTail refuses a run id that could leave the runs directory and clips what it returns", (t) => {
  const f = fixture(t);
  const instance = { name: "core", ledgerDir: f.ledgerDir };
  assert.equal(readRunTail(instance, "../ledger"), undefined);
  assert.equal(readRunTail(instance, "nope-1"), undefined);
  writeFileSync(join(f.ledgerDir, "runs", "long-1.tail"), `${"x".repeat(1_000)}\n`);
  assert.equal(readRunTail(instance, "long-1")![0]!.length, 301);
  assert.deepEqual(readRunTail(instance, RUN, 2), ["second line", "last line"]);
});

const STATE: ReadModelInstanceState = { instance: "core", tickedAt: T0, generation: 1, lease: "held", failures: 0, newestTs: null };
const FACT_ROWS = [
  { step: "run.start" },
  { step: "pr.opened", pr_url: PR_URL },
].map((extra, i) => ({ seq: i + 1, ts: new Date(T0 + i).toISOString(), step: extra.step, run_id: RUN, body: JSON.stringify({ ts: new Date(T0 + i).toISOString(), task_id: ID, run_id: RUN, ...extra }) }));

/** A store whose fact rows are `facts` (or whose fact read fails); no task projection row. */
function fakeDb(facts: typeof FACT_ROWS | Error): ReadModelDb {
  return {
    prepare: (sql: string) => ({
      get: () => undefined,
      all: () => {
        assert.match(sql, /FROM fact WHERE task_id/);
        if (facts instanceof Error) throw facts;
        return [...facts].reverse();
      },
    }),
  } as unknown as ReadModelDb;
}

/** Builds the wanted keys by calling the view's own materialize, with the store `db` (or none). */
function direct(f: Fixture, overrides: Partial<TaskViewOptions>, db: ReadModelDb | undefined, ids: string[] = [ID]): { bodies: Map<string, { data: TaskViewData; sources: Array<{ name: string; state: string; reason?: string }> }>; logs: Array<[string, Record<string, unknown>]> } {
  const clock = mutableClock();
  const demand = createDemandBook({ clock });
  for (const id of ids) demand.want(TASK_VIEW_NAME, taskViewKey("core", id));
  const logs: Array<[string, Record<string, unknown>]> = [];
  const view = createTaskView({
    instances: [{ name: "core", ledgerDir: f.ledgerDir, repo: "o/r" }], ledgerSource, demand, clock, log: (step, extra) => void logs.push([step, extra]),
    readTask: () => ({ source: { asOf: clock.iso(), state: "fresh" } }), ...overrides,
  });
  const built = view.materialize({ now: T0, instances: [{ state: STATE, ...(db ? { db } : {}) }] });
  return { bodies: new Map(built.map((entry) => [new URLSearchParams(entry.key).get("id")!, { data: entry.data, sources: entry.sources }])), logs };
}

test("W1-T5048: a store that is not open yet, or whose fact read fails, says so in the body", (t) => {
  const f = fixture(t);
  const closed = direct(f, {}, undefined).bodies.get(ID)!;
  assert.equal(closed.data.reason, "the read model store is not open yet");
  assert.equal(closed.data.found, false);
  assert.deepEqual(closed.sources.find((s) => s.name === "read-model:core")?.state, "unavailable");

  const failing = direct(f, {}, fakeDb(new Error("no such table: fact")));
  const body = failing.bodies.get(ID)!;
  assert.equal(body.data.reason, "no fact rows: no such table: fact");
  assert.deepEqual(body.data.runs, []);
  assert.deepEqual(failing.logs, [["read_model.task_view_facts_failed", { instance: "core", id: ID, error: "no such table: fact" }]]);
});

test("W1-T5048: a gateway that cannot answer leaves each run's pr unknown with its reason", (t) => {
  const f = fixture(t);
  const down = direct(f, { github: () => { throw new Error("the snapshot is unreadable"); } }, fakeDb(FACT_ROWS)).bodies.get(ID)!;
  assert.deepEqual(down.data.runs[0]!.pr, { url: PR_URL, state: "unknown", reason: "the snapshot is unreadable" });
  const github = down.sources.find((s) => s.name === "github:core");
  assert.equal(github?.state, "unavailable");
  assert.equal(github?.reason, "the snapshot is unreadable");

  const throwing = { prByRef: () => { throw new Error("the gateway lookup failed"); } } as unknown as GitHub;
  const lookup = direct(f, { github: () => ({ github: throwing, source: { asOf: new Date(T0).toISOString(), state: "fresh" } }) }, fakeDb(FACT_ROWS)).bodies.get(ID)!;
  assert.deepEqual(lookup.data.runs[0]!.pr, { url: PR_URL, state: "unknown", reason: "the gateway lookup failed" });
  assert.equal(lookup.data.found, true, "the fact rows still name the task");
});

test("W1-T5048: one key that cannot be built answers unavailable and leaves the other keys built", (t) => {
  const f = fixture(t);
  const BAD = "W1-T9";
  const readTask: TaskViewOptions["readTask"] = (_instance, id) => {
    if (id === BAD) throw new Error("the plan record is corrupt");
    return { task: PLANNED, source: { asOf: new Date(T0).toISOString(), state: "fresh" } };
  };
  const { bodies, logs } = direct(f, { readTask }, fakeDb([]), [ID, BAD]);
  assert.equal(bodies.get(ID)?.data.task?.title, "the planned title", "the good key is built");
  const bad = bodies.get(BAD)!;
  assert.equal(bad.data.found, false);
  assert.equal(bad.data.reason, "the plan record is corrupt");
  assert.deepEqual(bad.sources.map((s) => [s.name, s.state]), [["ledger:core", "unavailable"]]);
  assert.deepEqual(logs, [["read_model.task_view_failed", { instance: "core", id: BAD, error: "the plan record is corrupt" }]]);
});

test("W1-T5048: the default plan reader reads the instance's plan file and reports an absent one", (t) => {
  const f = fixture(t);
  const planPath = join(f.root, "plan", "tasks.yaml");
  const instance = { name: "core", ledgerDir: f.ledgerDir, repo: "o/r", planPath };
  const read = (): { data: TaskViewData; sources: Array<{ name: string; state: string; reason?: string }> } => {
    const demand = createDemandBook({ clock: mutableClock() });
    demand.want(TASK_VIEW_NAME, KEY);
    const view = createTaskView({ instances: [instance], ledgerSource, demand, clock: mutableClock() });
    return view.materialize({ now: T0, instances: [{ state: STATE, db: fakeDb([]) }] })[0]!;
  };
  const absent = read();
  const plan = absent.sources.find((s) => s.name === "plan:core");
  assert.equal(plan?.state, "unavailable");
  assert.equal(plan?.reason, `the plan file ${planPath} is absent`);
  assert.equal(absent.data.task, undefined);

  mkdirSync(join(f.root, "plan"), { recursive: true });
  writeFileSync(planPath, `- id: ${ID}\n  title: the plan file's title\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n`);
  const present = read();
  assert.equal(present.data.task?.title, "the plan file's title");
  assert.equal(present.data.found, true);
  assert.equal(present.sources.find((s) => s.name === "plan:core")?.state, "fresh");
});


test("task-view fixture releases its real ticker before retiring its directory", (t) => {
  const f = fixture(t);
  const { ticker } = build(t, f);
  const release = ticker.release.bind(ticker);
  ticker.release = () => {
    assert.ok(existsSync(f.root), "the real ticker is released while it still owns its directory");
    return release();
  };
});

test("task-view fixture preserves evidence and attempts every release when one fails", async () => {
  const root = makeTempDir("task-view-release-control");
  let secondReleased = false;
  let settled = false;
  try {
    await assert.rejects(retireFixture(root, [
      () => { throw new Error("injected release failure"); },
      () => { secondReleased = true; },
    ], async () => { settled = true; }), /release failed; directory preserved/);
    assert.equal(secondReleased, true);
    assert.equal(settled, false);
    assert.equal(existsSync(root), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("task-view fixture preserves its directory when diagnostic publication fails", async () => {
  const root = makeTempDir("task-view-publication-control");
  try {
    await assert.rejects(retireFixture(root, [], async () => { throw new Error("injected diagnostic failure"); }), /injected diagnostic failure/);
    assert.equal(existsSync(root), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("task-view retirement waits for real diagnostic publication before directory removal", async (t) => {
  const f = fixture(t);
  build(t, f);
  await retireFixture(f.root, f.releases);
  f.releases.length = 0;
  await flushReadModelTransactions();
  assert.equal(existsSync(f.root), false, "diagnostic writes cannot recreate the retired directory");
});


// ---- W1-T11395: the per-run activity cursor, over a REAL activity_ring written by the projector's own apply/settle ----

interface RingRow { ms: number; task?: string; run?: string; step?: string; extra?: Record<string, unknown> }

/** A projector store whose activity ring is built, and a writer that applies rows through the ring projection itself. */
function ringStore(f: Fixture): { db: ReadModelDb; add: (rows: RingRow[]) => void; seqOf: (ms: number, step: string) => number } {
  const db = openProjectorReadModel(f.stateDir, "core");
  f.releases.push(() => db.close());
  db.exec(ACTIVITY_RING_PROJECTION.ddl);
  const add = (rows: RingRow[]): void => {
    for (const row of rows) {
      const line = JSON.stringify({ ts: new Date(T0 + row.ms).toISOString(), step: row.step ?? "worker.event", task_id: row.task ?? ID, run_id: row.run ?? RUN, ...row.extra });
      ACTIVITY_RING_PROJECTION.apply(db, line, ledgerLineIdentity(line), () => JSON.parse(line) as Record<string, unknown>);
    }
    ACTIVITY_RING_PROJECTION.settle?.(db);
  };
  const seqOf = (ms: number, step: string): number => Number(db.prepare("SELECT seq FROM activity_ring WHERE ts_ms = ? AND json_extract(body, '$.step') = ?").get(T0 + ms, step)?.seq);
  return { db, add, seqOf };
}

/** The activity of one key, built by the view's own materialize over `db`. */
function activityOf(f: Fixture, db: ReadModelDb | undefined, query: { id?: string; run: string; cursor?: string }, state: ReadModelInstanceState = STATE): TaskActivity {
  const id = query.id ?? ID;
  const params = new URLSearchParams({ instance: "core", id, activityRun: query.run, ...(query.cursor ? { activityCursor: query.cursor } : {}) });
  const clock = mutableClock();
  const demand = createDemandBook({ clock });
  demand.want(TASK_VIEW_NAME, viewKey(params));
  const view = createTaskView({ instances: [{ name: "core", ledgerDir: f.ledgerDir, repo: "o/r" }], ledgerSource, demand, clock, readTask: () => ({ source: { asOf: clock.iso(), state: "fresh" } }) });
  const entry = view.materialize({ now: T0, instances: [{ state, ...(db ? { db } : {}) }] })[0]!;
  assert.ok(entry.data.activity, "a key that names activityRun carries an activity page");
  return entry.data.activity;
}

function drain(f: Fixture, db: ReadModelDb, id = ID, run = RUN): { pages: TaskActivity[]; ids: string[] } {
  const pages: TaskActivity[] = [];
  let cursor: string | undefined;
  do {
    const page = activityOf(f, db, { id, run, ...(cursor ? { cursor } : {}) });
    pages.push(page);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor && pages.length < 20);
  return { pages, ids: pages.flatMap((page) => page.events.map((event) => event.id)) };
}

test("task activity cursor pages preserve exact task run and sequence identity", (t) => {
  const f = fixture(t);
  const ring = ringStore(f);
  const mine: RingRow[] = Array.from({ length: TASK_ACTIVITY_PAGE_EVENTS + 10 }, (_, n) => ({ ms: 10 + n * 2, step: `mine.${n}` }));
  const noise: RingRow[] = [
    ...Array.from({ length: 12 }, (_, n) => ({ ms: 11 + n * 2, step: `other-run.${n}`, run: `${ID}-2000` })),
    ...Array.from({ length: 12 }, (_, n) => ({ ms: 12 + n * 2, step: `other-task.${n}`, task: "W1-T2" })),
    // the same run id under another task is a different run: it must not leak in.
    ...Array.from({ length: 4 }, (_, n) => ({ ms: 40 + n, step: `same-run-other-task.${n}`, task: "W1-T2" })),
    { ms: 50, step: "no-run", run: undefined, extra: { run_id: null } },
  ];
  ring.add([...mine, ...noise].sort((a, b) => a.ms - b.ms));
  const { pages, ids } = drain(f, ring.db);
  assert.equal(pages.length, 2, "sixty events are a full page then a short one");
  assert.equal(pages[0]!.events.length, TASK_ACTIVITY_PAGE_EVENTS);
  assert.equal(pages[0]!.hasMore, true);
  assert.equal(pages[1]!.hasMore, false);
  const steps = pages.flatMap((page) => page.events.map((event) => event.step));
  assert.deepEqual(steps, mine.map((row) => row.step), "exactly this task's and this run's events, in order");
  assert.equal(new Set(ids).size, ids.length, "no event twice");
  for (const event of pages[0]!.events) assert.equal(event.seq, ring.seqOf(Number(event.id.split(":")[0]) - T0, event.step), "an event carries the ring's own sequence");
  assert.deepEqual(pages[0]!.events.map((e) => e.seq), [...pages[0]!.events.map((e) => e.seq)].sort((a, b) => a - b));
  assert.equal(pages[0]!.ring?.capacity, 500);
  assert.ok(pages.every((page) => page.state === "available" && !page.retentionGap && !page.reset && page.runId === RUN));
  const otherRun = activityOf(f, ring.db, { run: `${ID}-2000` });
  assert.deepEqual(otherRun.events.map((e) => e.step), Array.from({ length: 12 }, (_, n) => `other-run.${n}`), "another run of the same task reads only its own events");
  const otherTask = activityOf(f, ring.db, { id: "W1-T2", run: RUN });
  assert.deepEqual(otherTask.events.map((e) => e.step), [...Array.from({ length: 12 }, (_, n) => `other-task.${n}`), ...Array.from({ length: 4 }, (_, n) => `same-run-other-task.${n}`)],
    "the same run id under another task is that task's run and reads only its events");
  assert.ok(![...otherTask.events, ...otherRun.events].some((e) => e.step.startsWith("mine.")));
});

test("task activity cursor handles equal timestamps replay and foreign scope", (t) => {
  const f = fixture(t);
  const ring = ringStore(f);
  // every row lands in the SAME millisecond, mine interleaved with another task's: only the ring's sequence tells them apart.
  const rows: RingRow[] = Array.from({ length: 70 }, (_, n) => (n % 3 === 2 ? { ms: 5, step: `foreign.${n}`, task: "W1-T2" } : { ms: 5, step: `same-ms.${n}` }));
  ring.add(rows);
  const mine = rows.filter((row) => row.task === undefined).map((row) => row.step);
  const first = activityOf(f, ring.db, { run: RUN });
  const replay = activityOf(f, ring.db, { run: RUN });
  assert.deepEqual(replay, first, "re-reading the same position repeats the same page");
  const second = activityOf(f, ring.db, { run: RUN, cursor: first.cursor });
  const secondAgain = activityOf(f, ring.db, { run: RUN, cursor: first.cursor });
  assert.deepEqual(secondAgain, second, "a replayed continuation repeats too");
  assert.deepEqual([...first.events, ...second.events].map((e) => e.step), mine, "equal-millisecond events neither skip nor repeat across the page boundary");
  assert.ok(![...first.events, ...second.events].some((e) => e.step.startsWith("foreign")), "another task's same-millisecond rows never appear");
  assert.equal(new Set([...first.events, ...second.events].map((e) => e.id)).size, mine.length);
  // a cursor issued for another task or another run is refused, never read as this one's position.
  const theirs = activityOf(f, ring.db, { id: "W1-T2", run: RUN });
  assert.ok(theirs.events.length > 0 && theirs.cursor);
  const foreign = activityOf(f, ring.db, { run: RUN, cursor: theirs.cursor });
  assert.equal(foreign.state, "unavailable");
  assert.deepEqual(foreign.events, []);
  assert.match(String(foreign.reason), /another instance or task/);
  const wrongRun = activityOf(f, ring.db, { run: `${ID}-2000`, cursor: first.cursor });
  assert.equal(wrongRun.state, "unavailable");
  assert.match(String(wrongRun.reason), /another run/);
});

test("task activity cursor distinguishes caught up gaps resets and unavailable history", (t) => {
  const f = fixture(t);
  const ring = ringStore(f);
  ring.add([{ ms: 1, step: "a" }, { ms: 2, step: "b" }, { ms: 3, step: "other", task: "W1-T2" }]);
  const head = activityOf(f, ring.db, { run: RUN });
  assert.deepEqual(head.events.map((e) => e.step), ["a", "b"], "the healthy nonempty page is the positive control");
  // caught up: an empty AVAILABLE page that still names the validated corpus position.
  const caught = activityOf(f, ring.db, { run: RUN, cursor: head.cursor });
  assert.equal(caught.state, "available");
  assert.deepEqual(caught.events, []);
  assert.equal(caught.hasMore, false);
  assert.equal(caught.retentionGap || caught.reset, false);
  assert.ok(caught.cursor, "caught up carries the exact validated ring tail");
  // a new event after the cursor arrives as the next page, not as a gap.
  ring.add([{ ms: 4, step: "c" }]);
  assert.deepEqual(activityOf(f, ring.db, { run: RUN, cursor: caught.cursor }).events.map((e) => e.step), ["c"]);

  // a cursor from the FUTURE of this store (a higher generation) is a reset.
  const future = activityOf(f, ring.db, { run: RUN, cursor: encodeTaskActivityCursor({ i: "core", t: ID, r: RUN, g: STATE.generation + 5, s: 2, m: T0 + 2, h: "1" }) });
  assert.equal(future.reset, true);
  assert.equal(future.state, "available");
  assert.ok(future.events.length > 0, "a reset restarts at the oldest retained event");
  // a position inside the retained window whose row is not the one named is a reset too.
  const forged = activityOf(f, ring.db, { run: RUN, cursor: encodeTaskActivityCursor({ i: "core", t: ID, r: RUN, g: 1, s: 2, m: T0 + 2, h: "12345" }) });
  assert.equal(forged.reset, true);
  assert.equal(forged.retentionGap, false);
  assert.match(String(forged.reason), /does not belong/);

  // ring rollover: more than the ring's capacity of newer rows pushes the cursor's row out.
  ring.add(Array.from({ length: 520 }, (_, n) => ({ ms: 100 + n, step: `later.${n}`, task: "W1-T2" })));
  const rolled = activityOf(f, ring.db, { run: RUN, cursor: head.cursor });
  assert.equal(rolled.state, "available");
  assert.equal(rolled.retentionGap, true, "the ring rolled past the cursor: events may be lost");
  assert.equal(rolled.reset, false);
  assert.match(String(rolled.reason), /rolled past/);
  assert.deepEqual(rolled.events, [], "the rolled-off events are simply not retained; the gap flag, not the empty list, is what says so");

  // unreadable history is UNAVAILABLE, never an empty page.
  const closed = activityOf(f, undefined, { run: RUN });
  assert.equal(closed.state, "unavailable");
  assert.deepEqual([closed.events, closed.hasMore, closed.retentionGap, closed.reset], [[], false, false, false]);
  const bare = ringStore({ ...f, stateDir: join(f.root, "bare-state") });
  bare.db.exec("DROP TABLE activity_ring");
  assert.match(String(activityOf(f, bare.db, { run: RUN }).reason), /ring is not built/);
  const logs: Array<[string, Record<string, unknown>]> = [];
  const broken = { inTransaction: () => false, exec: () => {}, prepare: () => { throw new Error("database disk image is malformed"); } } as unknown as ReadModelDb;
  const clock = mutableClock();
  const demand = createDemandBook({ clock });
  demand.want(TASK_VIEW_NAME, viewKey(new URLSearchParams({ instance: "core", id: ID, activityRun: RUN })));
  const view = createTaskView({ instances: [{ name: "core", ledgerDir: f.ledgerDir }], ledgerSource, demand, clock, log: (step, extra) => void logs.push([step, extra]), readTask: () => ({ source: { asOf: clock.iso(), state: "fresh" } }) });
  const unreadable = view.materialize({ now: T0, instances: [{ state: STATE, db: broken }] })[0]!.data.activity!;
  assert.equal(unreadable.state, "unavailable");
  assert.match(String(unreadable.reason), /could not be read: database disk image is malformed/);
  assert.deepEqual(unreadable.events, []);
  assert.ok(logs.some(([step, extra]) => step === "read_model.task_view_failed" && extra.activity === true));
});

test("task activity cursor bounds demand cardinality and total materialization work", (t) => {
  const f = fixture(t);
  const ring = ringStore(f);
  ring.add([{ ms: 1, step: "a" }]);
  const statements: string[] = [];
  const counting = new Proxy(ring.db, {
    get: (target, name) => name === "prepare" ? (sql: string) => (statements.push(sql), target.prepare(sql)) : Reflect.get(target, name).bind?.(target) ?? Reflect.get(target, name),
  });
  const clock = mutableClock();
  const demand = createDemandBook({ clock });
  const logs: Array<[string, Record<string, unknown>]> = [];
  const key = (id: string, cursor: string): string => viewKey(new URLSearchParams({ instance: "core", id, activityRun: RUN, activityCursor: cursor }));
  const cursorFor = (id: string, n: number): string => encodeTaskActivityCursor({ i: "core", t: id, r: RUN, g: 1, s: n + 1, m: T0 + n, h: String(n) });
  // 3 distinct cursors for each of 30 tasks, then 100 distinct cursors on ONE task read last.
  for (let task = 0; task < 30; task++) for (let n = 0; n < 3; n++) demand.want(TASK_VIEW_NAME, key(`W1-T${100 + task}`, cursorFor(`W1-T${100 + task}`, n)));
  for (let n = 0; n < 100; n++) demand.want(TASK_VIEW_NAME, key(ID, cursorFor(ID, n)));
  demand.want(TASK_VIEW_NAME, taskViewKey("core", ID));
  const view = createTaskView({ instances: [{ name: "core", ledgerDir: f.ledgerDir, repo: "o/r" }], ledgerSource, demand, clock, log: (step, extra) => void logs.push([step, extra]), readTask: () => ({ source: { asOf: clock.iso(), state: "fresh" } }) });
  const built = view.materialize({ now: T0, instances: [{ state: STATE, db: counting }] });
  const withActivity = built.filter((entry) => entry.data.activity);
  const worked = withActivity.filter((entry) => !/demand bound/.test(String(entry.data.activity?.reason)));
  assert.equal(withActivity.length, 190, "every key still answers, none is dropped silently");
  assert.equal(worked.length, TASK_ACTIVITY_PASS_KEYS, "the pass's budget is spent, not exceeded");
  assert.ok(worked.length <= TASK_ACTIVITY_PASS_KEYS, `at most ${TASK_ACTIVITY_PASS_KEYS} activity keys do ring work in a pass, saw ${worked.length}`);
  const perTask = new Map<string, number>();
  for (const entry of worked) perTask.set(entry.data.id, (perTask.get(entry.data.id) ?? 0) + 1);
  assert.ok([...perTask.values()].every((count) => count <= TASK_ACTIVITY_KEYS_PER_TASK), "and at most four per task");
  const ringStatements = statements.filter((sql) => /activity_ring/.test(sql)).length;
  assert.ok(ringStatements > 0 && ringStatements <= TASK_ACTIVITY_PASS_KEYS * 5, `the pass's ring work is bounded, ${ringStatements} statements`);
  const heldBack = withActivity.filter((entry) => entry.data.activity?.state === "unavailable" && /demand bound/.test(String(entry.data.activity.reason)));
  assert.equal(heldBack.length, 190 - worked.length);
  assert.ok(heldBack.every((entry) => entry.data.activity!.events.length === 0 && entry.data.found === false));
  // the most recently read keys of the one-task flood are the ones admitted: the oldest cursors give way.
  const admittedOfFlood = worked.filter((entry) => entry.data.id === ID).map((entry) => new URLSearchParams(entry.key).get("activityCursor"));
  assert.deepEqual(admittedOfFlood.sort(), [96, 97, 98, 99].map((n) => cursorFor(ID, n)).sort());
  // the plain task key is untouched by the activity bound, and carries no activity.
  const plain = built.find((entry) => entry.key === taskViewKey("core", ID))!;
  assert.equal(plain.data.activity, undefined);
  assert.equal(demand.keys(TASK_VIEW_NAME).length, 191, "the demand book itself holds the keys it always did");
});
