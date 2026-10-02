import assert from "node:assert/strict";
import fs, { appendFileSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import {
  boardOpenSnapshotPath,
  createBoardSnapshotCache,
  createBoardSnapshotReader,
  type BoardSnapshotIo,
} from "../src/lib/board-snapshot-cache.js";
import type { Clock } from "../src/lib/clock.js";
import { createLedgerProjector, openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { NOW_REFRESH_MS, createNowView, planStamp, sharedPlan, snapshotGithub, type NowInstance, type NowViewContext, type NowViewOptions } from "../src/lib/now-view.js";
import type { BoardIssueRest, BoardPrRest } from "../src/lib/open-prs-rest.js";
import { loadPlanQuarantiningDuplicates, type Plan, type Task } from "../src/lib/plan.js";
import { createTaskView, taskViewKey, type TaskViewData } from "../src/lib/task-view.js";
import { TASK_VIEW_NAME, createDemandBook } from "../src/lib/view-demand.js";
import { acquireLease, type ReadModelDb } from "../src/lib/read-model-db.js";
import { makeTempDir } from "../src/lib/tmp.js";

const T0 = Date.parse("2026-09-30T12:00:00.000Z");
type TestCtx = { after: (fn: () => void) => void };

function scratch(t: TestCtx): string {
  const dir = makeTempDir("now-snapshot-once");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function task(id: string): Task {
  return { id, title: `task ${id}`, repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 };
}

const PLAN: Plan = (() => {
  const tasks = ["W1-T1", "W1-T2", "W1-T3", "W1-T4"].map(task);
  return { tasks, byId: new Map(tasks.map((x) => [x.id, x])) };
})();

interface Stepped extends Clock {
  set(ms: number): void;
}

function stepped(): Stepped {
  let now = T0;
  return { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString(), set: (ms) => { now = ms; } };
}

function pr(number: number, taskId: string, state: string): BoardPrRest {
  return {
    number, url: `https://github.com/o/r/pull/${number}`, state, headRefName: `run-${taskId}-1790000000000`, headRefOid: `sha-${number}`,
    body: `work\n\nRemudero-Task: ${taskId}`, autoMergeRequest: null, title: `pr ${number}`, updatedAt: "2026-09-30T11:00:00Z",
  };
}

function issue(number: number, state: string): BoardIssueRest {
  return { number, url: `https://github.com/o/r/issues/${number}`, state, title: `issue ${number}`, updatedAt: "2026-09-30T11:00:00Z" };
}

/** A read-model store for one instance whose ledger dir sits under `home`, so instances can share one state root. */
function store(t: TestCtx, home: string, name: string, clock: Clock): { name: string; ledgerDir: string; db: ReadModelDb; append(row: Record<string, unknown>): void } {
  const ledgerDir = join(home, `ledger-${name}`);
  mkdirSync(ledgerDir, { recursive: true });
  const db = openProjectorReadModel(join(home, "read-model-home"), name, clock);
  t.after(() => db.close());
  const acquired = acquireLease(db, { clock, ttlMs: 1e12 });
  assert.ok(acquired.ok);
  const projector = createLedgerProjector({ ledgerDir, db, lease: acquired.lease, clock });
  return {
    name, ledgerDir, db,
    append: (row) => {
      appendFileSync(join(ledgerDir, "ledger.ndjson"), `${JSON.stringify({ ts: clock.iso(), host: "h1", ...row })}\n`);
      projector.tick();
    },
  };
}

function ctxOf(clock: Clock, stores: Array<{ name: string; db: ReadModelDb }>): NowViewContext {
  return {
    now: clock.now(),
    switches: { views: { now: "shadow" } },
    instances: stores.map((s) => ({ state: { instance: s.name, generation: Number(s.db.meta("generation")), lease: "held" as const, failures: 0, tickedAt: clock.now(), newestTs: null }, db: s.db })),
  };
}

/** The fs, with every open of the closed/issues snapshot counted: one open is one parse. */
function countingIo(): { io: BoardSnapshotIo; parses: () => number } {
  let parses = 0;
  const io: BoardSnapshotIo = {
    stat(path) {
      const st = fs.statSync(path);
      return { size: st.size, isFile: st.isFile(), mtimeMs: st.mtimeMs, ino: st.ino };
    },
    mkdir: (path, mode) => void fs.mkdirSync(path, { recursive: true, mode }),
    openRead(path) {
      parses++;
      return fs.openSync(path, "r");
    },
    openWrite: (path, mode) => fs.openSync(path, "wx", mode),
    read: (fd, buffer, offset, length) => fs.readSync(fd, buffer, offset, length, null),
    write: (fd, buffer, offset, length) => fs.writeSync(fd, buffer, offset, length),
    fsync: (fd) => fs.fsyncSync(fd),
    close: (fd) => fs.closeSync(fd),
    rename: (from, to) => fs.renameSync(from, to),
    unlink: (path) => fs.unlinkSync(path),
  };
  return { io, parses: () => parses };
}

/** Writes the three snapshot halves as the legacy gateway persists them. */
function persist(root: string, closed: BoardPrRest[], issues: BoardIssueRest[], open: BoardPrRest[], atMs: number): void {
  const cache = createBoardSnapshotCache(root, "o", "r");
  assert.equal(cache.commitClosed(closed), true);
  assert.equal(cache.commitIssues(issues), true);
  assert.equal(cache.commitOpen!(open, atMs), true);
}

/** The open half's 60 s re-save: same rows, a new file and a new mtime. */
function resaveOpen(root: string, open: BoardPrRest[], atMs: number): void {
  assert.equal(createBoardSnapshotCache(root, "o", "r").commitOpen!(open, atMs), true);
  const at = new Date(atMs);
  utimesSync(boardOpenSnapshotPath(root, "o", "r"), at, at);
}

/** The pre-E33 read: a fresh parse of the snapshot on every call, so every build builds its own gateway too. */
const freshParse = (root: string, owner: string, repo: string) => ({ ...createBoardSnapshotCache(root, owner, repo).rows!() });

function setup(t: TestCtx, names: string[]) {
  const root = scratch(t);
  const clock = stepped();
  const home = join(root, "home");
  const stores = names.map((name) => store(t, home, name, clock));
  for (const s of stores) {
    s.append({ step: "daemon.tick" });
    s.append({ step: "escalation.issue_opened", task_id: "W1-T3", issue_url: "https://github.com/o/r/issues/5", class: "MANUAL" });
    s.append({ step: "run.start", task_id: "W1-T4", run_id: "r4" });
  }
  const instances: NowInstance[] = stores.map((s) => ({ name: s.name, ledgerDir: s.ledgerDir, repo: "o/r" }));
  for (const i of instances) assert.equal(dirname(i.ledgerDir), home, "every instance reads the one snapshot under the shared state root");
  const open = [pr(9001, "W1-T1", "OPEN")];
  persist(home, [pr(8001, "W1-T2", "MERGED"), pr(8002, "W1-T4", "CLOSED")], [issue(5, "OPEN"), issue(6, "CLOSED")], open, T0);
  const counting = countingIo();
  const reader = createBoardSnapshotReader({ io: counting.io });
  let reads = 0;
  const readBoardSnapshot: NonNullable<NowViewOptions["readBoardSnapshot"]> = (...args) => {
    reads++;
    return reader(...args);
  };
  const base = { instances, clock, readPlan: () => PLAN, hostProbe: { rateLimit: () => 4321, diskFree: () => 1 }, planBehind: () => ({ commits: 0 }) } satisfies NowViewOptions;
  return { root, home, clock, stores, instances, open, counting, reads: () => reads, readBoardSnapshot, base };
}

test("consecutive now builds over an unchanged board snapshot parse it once", (t) => {
  const { home, clock, stores, open, counting, reads, readBoardSnapshot, base } = setup(t, ["core"]);
  const view = createNowView({ ...base, readBoardSnapshot });
  const builds = 5;
  for (let n = 0; n < builds; n++) {
    clock.set(T0 + n * NOW_REFRESH_MS);
    if (n > 0) resaveOpen(home, open, clock.now());
    assert.equal(view.materialize(ctxOf(clock, stores)).length, 1);
  }
  assert.equal(reads(), builds, "every build read the snapshot (the open half's re-save made each one due)");
  assert.equal(counting.parses(), 1, "the closed/issues snapshot is parsed once while it is unchanged");
});

test("a board snapshot rewritten with new rows is parsed again and shown", (t) => {
  const { home, clock, stores, open, counting, readBoardSnapshot, base } = setup(t, ["core"]);
  const view = createNowView({ ...base, readBoardSnapshot });
  const first = view.materialize(ctxOf(clock, stores))[0]!.data;
  assert.equal(counting.parses(), 1);
  clock.set(T0 + NOW_REFRESH_MS);
  assert.equal(createBoardSnapshotCache(home, "o", "r").commitClosed([pr(8001, "W1-T2", "MERGED"), pr(8002, "W1-T4", "CLOSED"), pr(8003, "W1-T3", "MERGED")]), true);
  resaveOpen(home, open, clock.now());
  const second = view.materialize(ctxOf(clock, stores))[0]!.data;
  assert.equal(counting.parses(), 2, "a rewritten snapshot is a new file identity, so it is read again");
  assert.notDeepEqual(second.board, first.board, "the newly merged pull request reaches the body");
});

test("two instances sharing one core board snapshot parse it once", (t) => {
  const { clock, stores, counting, reads, readBoardSnapshot, base } = setup(t, ["core", "site"]);
  const view = createNowView({ ...base, readBoardSnapshot });
  assert.equal(view.materialize(ctxOf(clock, stores)).length, 2);
  assert.equal(reads(), 2, "each instance's build read the snapshot");
  assert.equal(counting.parses(), 1, "one parse serves both instances");
  const a = snapshotGithub(dirname(stores[0]!.ledgerDir), "o", "r", clock, { read: readBoardSnapshot });
  const b = snapshotGithub(dirname(stores[1]!.ledgerDir), "o", "r", clock, { read: readBoardSnapshot });
  assert.equal(counting.parses(), 1);
  assert.equal(a.github, b.github, "and one gateway, while what the snapshot holds is unchanged");
});

test("a board snapshot with no readable identity is parsed on every read and an absent one until it appears", (t) => {
  const root = scratch(t);
  const counting = countingIo();
  const noMtime: BoardSnapshotIo = { ...counting.io, stat: (path) => ({ ...counting.io.stat(path), mtimeMs: undefined }) };
  const absent = createBoardSnapshotReader({ io: counting.io });
  assert.deepEqual(absent(root, "o", "r"), {});
  assert.deepEqual(absent(root, "o", "r"), {});
  assert.equal(counting.parses(), 0, "an absent file is never opened");
  persist(root, [pr(8001, "W1-T2", "MERGED")], [issue(5, "OPEN")], [], T0);
  assert.equal(absent(root, "o", "r").closed?.size, 1, "a file that appears is read");
  assert.equal(counting.parses(), 1);
  const unknown = createBoardSnapshotReader({ io: noMtime });
  unknown(root, "o", "r");
  unknown(root, "o", "r");
  assert.equal(counting.parses(), 3, "without an mtime nothing is reused");
});

test("a snapshot gateway is rebuilt when the open pull requests change and kept across a bare re-save", (t) => {
  const { home, clock, open, readBoardSnapshot } = setup(t, ["core"]);
  const first = snapshotGithub(home, "o", "r", clock, { read: readBoardSnapshot });
  resaveOpen(home, open, T0 + NOW_REFRESH_MS);
  const resaved = snapshotGithub(home, "o", "r", clock, { read: readBoardSnapshot });
  assert.notEqual(resaved.generation, first.generation);
  assert.equal(resaved.content, first.content);
  assert.equal(resaved.github, first.github);
  resaveOpen(home, [...open, pr(9002, "W1-T3", "OPEN")], T0 + 2 * NOW_REFRESH_MS);
  const moved = snapshotGithub(home, "o", "r", clock, { read: readBoardSnapshot });
  assert.notEqual(moved.content, first.content);
  assert.notEqual(moved.github, first.github);
  assert.deepEqual(moved.github.listOpenHeadBranches!()?.map((p) => p.number).sort(), [9001, 9002]);
});

test("a rewritten board snapshot leaves its earlier parse unreachable from the now view", async (t) => {
  const { home, clock, stores, open, readBoardSnapshot, base } = setup(t, ["core"]);
  // One row of each parse: the gateway built over a parse keeps its rows, not the parse's own maps.
  const parsed: Array<WeakRef<object>> = [];
  let latest: object | undefined;
  const view = createNowView({ ...base, readBoardSnapshot: (...args) => {
    const rows = readBoardSnapshot(...args);
    if (rows !== latest) parsed.push(new WeakRef(rows.issues!.values().next().value!));
    latest = rows;
    return rows;
  } });
  view.materialize(ctxOf(clock, stores));
  clock.set(T0 + NOW_REFRESH_MS);
  assert.equal(createBoardSnapshotCache(home, "o", "r").commitClosed([pr(8001, "W1-T2", "MERGED"), pr(8003, "W1-T3", "MERGED")]), true);
  resaveOpen(home, open, clock.now());
  view.materialize(ctxOf(clock, stores));
  assert.equal(parsed.length, 2, "the rewrite was parsed");
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  // A WeakRef's target survives the job that dereferenced it, so collect from a later turn.
  await new Promise((resolve) => setImmediate(resolve));
  gc();
  assert.equal(parsed[0]!.deref(), undefined, "nothing in the view still holds the first parse");
  assert.ok(parsed[1]!.deref(), "the current parse is held");
});

test("now bodies over the shared snapshot are byte-identical to bodies over a fresh parse per build", (t) => {
  const { home, clock, stores, open, readBoardSnapshot, base } = setup(t, ["core", "site"]);
  const shared = createNowView({ ...base, readBoardSnapshot });
  let parses = 0;
  const fresh = createNowView({ ...base, readBoardSnapshot: (...args) => (parses++, freshParse(...args)) });
  const empty = createNowView({ ...base, readBoardSnapshot: () => ({}) });
  const steps: Array<() => void> = [
    () => {},
    () => resaveOpen(home, open, clock.now()),
    () => void createBoardSnapshotCache(home, "o", "r").commitClosed([pr(8001, "W1-T2", "MERGED"), pr(8002, "W1-T4", "CLOSED"), pr(8003, "W1-T3", "MERGED")]),
    () => resaveOpen(home, [pr(9002, "W1-T1", "OPEN")], clock.now()),
    () => void createBoardSnapshotCache(home, "o", "r").commitIssues([issue(5, "CLOSED")]),
  ];
  steps.forEach((change, n) => {
    clock.set(T0 + n * NOW_REFRESH_MS);
    change();
    const a = JSON.stringify(shared.materialize(ctxOf(clock, stores)));
    const b = JSON.stringify(fresh.materialize(ctxOf(clock, stores)));
    assert.equal(a, b, `build ${n}: the shared snapshot changes nothing the view computes`);
    assert.notEqual(JSON.stringify(empty.materialize(ctxOf(clock, stores))), b, `build ${n}: the fixture's snapshot reaches the body`);
  });
  assert.equal(parses, 2 * steps.length, "the reference parsed afresh for every build of both instances");
});

function planFile(root: string, title: string): string {
  const path = join(root, "checkout", "plan", "tasks.yaml");
  mkdirSync(join(dirname(path), "tasks.d"), { recursive: true });
  writeFileSync(path, `- id: W1-T1\n  title: ${title}\n  repo: remudero\n  depends_on: []\n  type: implement\n  risk: medium\n  verify: auto\n  status: queued\n`);
  return path;
}

test("one parse of a plan file serves every caller until its stamp moves", (t) => {
  const path = planFile(scratch(t), "first");
  let loads = 0;
  const load = (p: string): Plan => (loads++, loadPlanQuarantiningDuplicates(p).plan);
  const stamp = planStamp(path);
  const a = sharedPlan(path, stamp, load);
  const b = sharedPlan(path, stamp, load);
  assert.equal(loads, 1);
  assert.equal(a, b);
  writeFileSync(path, fs.readFileSync(path, "utf8").replace("title: first", "title: second"));
  utimesSync(path, new Date(T0 + 1_000), new Date(T0 + 1_000));
  assert.notEqual(planStamp(path), stamp);
  assert.equal(sharedPlan(path, planStamp(path), load).byId.get("W1-T1")?.title, "second");
  assert.equal(loads, 2, "a moved stamp is read again");
});

test("the now and task views read one shared parse of their plan", (t) => {
  const { clock, stores, base } = setup(t, ["core"]);
  const planPath = planFile(scratch(t), "the file's title");
  // Seed the thread's memo with a marked parse: a view that loads its own copy shows the file's title instead.
  const marked = sharedPlan(planPath, planStamp(planPath), (p) => {
    const plan = loadPlanQuarantiningDuplicates(p).plan;
    plan.byId.get("W1-T1")!.title = "the shared parse";
    return plan;
  });
  assert.equal(marked.byId.get("W1-T1")?.title, "the shared parse");
  const instance = { ...base.instances[0]!, planPath };
  const { readPlan: _injected, ...defaults } = base;
  const now = createNowView({ ...defaults, instances: [instance] }).materialize(ctxOf(clock, stores))[0]!.data;
  assert.equal(now.board.tasks.find((x) => x.taskId === "W1-T1")?.title, "the shared parse");
  const demand = createDemandBook({ clock });
  demand.want(TASK_VIEW_NAME, taskViewKey("core", "W1-T1"));
  const task = createTaskView({ instances: [instance], demand, clock, ledgerSource: (state) => ({ name: `ledger:${state.instance}`, asOf: null, state: "fresh" }) })
    .materialize(ctxOf(clock, stores) as never)[0]!.data as TaskViewData;
  assert.equal(task.task?.title, "the shared parse");
});
