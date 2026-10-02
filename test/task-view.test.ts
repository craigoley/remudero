import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { mock, test } from "node:test";
import type { Clock } from "../src/lib/clock.js";
import type { Task } from "../src/lib/plan.js";
import { openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { BOARD_PROJECTION_DDL } from "../src/lib/board-projection.js";
import { createReadModelTicker, ledgerSource, type ReadModelBodyEntry, type ReadModelWorkerMessage } from "../src/lib/read-model-worker.js";
import type { GitHub } from "../src/lib/status.js";
import type { ReadModelDb } from "../src/lib/read-model-db.js";
import { createTaskView, readRunTail, taskViewKey, type ReadModelInstanceState, type TaskViewData, type TaskViewOptions } from "../src/lib/task-view.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { TASK_VIEW_NAME, createDemandBook } from "../src/lib/view-demand.js";

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
}

function fixture(t: TestCtx): Fixture {
  const root = makeTempDir("task-view");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerDir = join(root, "state");
  mkdirSync(join(ledgerDir, "runs"), { recursive: true });
  const row = (ms: number, extra: Record<string, unknown>): string => JSON.stringify({ ts: new Date(T0 - 60_000 + ms).toISOString(), task_id: ID, run_id: RUN, ...extra });
  writeFileSync(
    join(ledgerDir, "ledger.ndjson"),
    [row(1, { step: "run.start" }), row(2, { step: "pr.opened", pr_url: PR_URL, pr_number: 7 }), row(3, { step: "verdict", verdict: "pass", cost_usd: 1.5 })].join("\n") + "\n",
  );
  writeFileSync(join(ledgerDir, "runs", `${RUN}.tail`), "first line\nsecond line\nlast line\n");
  return { root, stateDir: join(root, "read-model-state"), ledgerDir };
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
function build(t: TestCtx, f: Fixture, overrides: Partial<TaskViewOptions> = {}, key = KEY): { data: TaskViewData; body: ReadModelBodyEntry["body"]; messages: ReadModelWorkerMessage[] } {
  const clock = mutableClock();
  const demand = createDemandBook({ clock });
  const messages: ReadModelWorkerMessage[] = [];
  const instance = { name: "core", ledgerDir: f.ledgerDir, repo: "o/r" };
  const view = createTaskView({ instances: [instance], ledgerSource, demand, clock, readTask: () => ({ task: PLANNED, source: { asOf: clock.iso(), state: "fresh" } }), ...overrides });
  const ticker = createReadModelTicker({
    stateDir: f.stateDir, instances: [instance], clock, holder: "task-view", oracle: "off", demand, views: [view], post: (m) => void messages.push(m),
  });
  t.after(() => ticker.release());
  ticker.start();
  ticker.want(TASK_VIEW_NAME, key);
  const latest = (): ReadModelBodyEntry | undefined => messages.flatMap((m) => (m.type === "body" && m.entry.view === TASK_VIEW_NAME && m.entry.key === key ? [m.entry] : [])).at(-1);
  for (let tick = 0; tick < 40 && ((latest()?.body.data as TaskViewData | undefined)?.runs.length ?? 0) === 0; tick++) {
    ticker.tick();
    clock.advance(1_000);
  }
  const entry = latest();
  assert.ok(entry, "the wanted key was materialized");
  return { data: entry.body.data as TaskViewData, body: entry.body, messages };
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
