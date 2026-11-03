/**
 * W1-T9716: storeIndex's taskBucket re-read and re-parsed a task's whole fact history (its own rows and alias rows) every
 * time the task re-derived, and the clock rule re-derives the same tasks every 30 s. The board projection now holds each
 * re-derived task's parsed rows, extends them by the rows past its high seq, and evicts the least recently re-derived
 * task at a byte bound. Each test compares the cached bucket with an uncached projection's read of the same store.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createBoardProjection, type BoardProjection, type BoardProjectionOptions, type Row } from "#src/lib/board-projection.js";
import type { Clock } from "#src/lib/clock.js";
import type { FeedbackEntry } from "#src/lib/feedback.js";
import { createLedgerProjector, openProjectorReadModel } from "#src/lib/ledger-projector.js";
import { createNowView, type NowViewContext, type NowViewData, type NowViewOptions } from "#src/lib/now-view.js";
import type { Plan, Task } from "#src/lib/plan.js";
import { acquireLease, type ReadModelDb, type ReadModelLease, type ReadModelStatement } from "#src/lib/read-model-db.js";
import type { GitHub, PrRef } from "#src/lib/status.js";
import { makeTempDir } from "#src/lib/tmp.js";

type TestCtx = { after: (fn: () => void) => void };

const T0 = Date.parse("2026-11-03T09:00:00.000Z");
const at = (ms: number): string => new Date(ms).toISOString();
const url = (pr: number): string => `https://github.com/o/r/pull/${pr}`;
const IDS = Array.from({ length: 8 }, (_, i) => `W1-T${21 + i}`);
const task = (id: string): Task => ({ id, title: `task ${id}`, repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 });
const PLAN: Plan = { tasks: IDS.map(task), byId: new Map(IDS.map((id) => [id, task(id)])) };
const OPEN: PrRef[] = IDS.map((id, k) => ({ number: 100 + k, url: url(100 + k), state: "OPEN", headRefName: `run-${id}-1`, headRefOid: `h${k}`, title: id }));
const GATEWAY = {
  readFailed: () => false,
  prByRef: (ref: number | string) => OPEN.find((pr) => pr.number === ref || pr.url === ref) ?? null,
  findMergedByTrailer: () => null, findMergedByHeadBranch: () => [], listMergedHeadBranches: () => [],
  listOpenHeadBranches: () => OPEN, headRefName: () => undefined, prBody: () => undefined,
  issueByUrl: () => ({ state: "OPEN", title: "issue" }),
} as unknown as GitHub;
const STEPS = ["run.start", "implement.done", "pr.opened", "review.posted", "sweep.disposed", "verdict"];

/** `n` rows per task from `from`, a second apart per task: runs, costs, PRs, dispositions; every task's rows the same size. */
function rowsFrom(from: number, n: number, offset = 0): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < n; i++) {
    for (const [k, id] of IDS.entries()) {
      const step = STEPS[(offset + i) % STEPS.length]!;
      out.push({
        ts: at(from + i * 1_000 + k), host: "h1", step, task_id: id, run_id: `r-${id}`, pr_url: url(100 + k), pr_number: 100 + k,
        head_sha: `h${k}`, n: String(offset + i).padStart(6, "0"),
        ...(step === "implement.done" ? { cost_usd: 0.25, num_turns: 3 } : {}),
        ...(step === "sweep.disposed" ? { disposition: "waiting", reason: "checks pending" } : {}),
        ...(step === "verdict" ? { verdict: "blocked_ci", cost_usd: 0.25 } : {}),
      });
    }
  }
  return out;
}

/** Rows a DAEMON-lane writer files under `task` only: alias rows, read by their task's bucket. */
const aliasRows = (ms: number, id: string, k: number): Row[] => [
  { ts: at(ms), host: "h1", step: "dispatch.circuit_broken", task_id: "DAEMON", task: id, freshCount: k },
];

/** Every statement's body rows but the ingest's own read: the task reads a test can count. */
function counting(db: ReadModelDb): { db: ReadModelDb; bodyRows(): number } {
  let rows = 0;
  const wrapped: ReadModelDb = {
    ...db,
    exec: (sql) => db.exec(sql),
    meta: (key) => db.meta(key),
    inTransaction: () => db.inTransaction(),
    close: () => db.close(),
    prepare: (sql, opts) => {
      const statement = db.prepare(sql, opts);
      if (/WHERE seq > \? ORDER BY seq LIMIT/.test(sql)) return statement;
      const note = (r: Record<string, unknown> | undefined): void => void (r && typeof r.body === "string" && rows++);
      const counted: ReadModelStatement = {
        run: (...params) => statement.run(...params),
        get: (...params) => {
          const r = statement.get(...params);
          note(r);
          return r;
        },
        all: (...params) => {
          const all = statement.all(...params);
          all.forEach(note);
          return all;
        },
        iterate: function* (...params) {
          for (const r of statement.iterate(...params)) {
            note(r);
            yield r;
          }
        },
      };
      return counted;
    },
  };
  return { db: wrapped, bodyRows: () => rows };
}

interface World {
  root: string;
  db: ReadModelDb;
  lease: ReadModelLease;
  ledgerDir: string;
  clock: Clock;
  set(ms: number): void;
  append(rows: Row[]): void;
  board(over?: Partial<BoardProjectionOptions>): BoardProjection;
}

function world(t: TestCtx, rows: Row[]): World {
  const root = makeTempDir("board-task-cache");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let ms = T0 + 3_600_000;
  const clock: Clock = { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() };
  const ledgerDir = join(root, "core", "state");
  mkdirSync(ledgerDir, { recursive: true });
  mkdirSync(join(root, "checkout", "plan", "feedback"), { recursive: true });
  const db = openProjectorReadModel(join(root, "home"), "core", clock);
  t.after(() => db.close());
  const got = acquireLease(db, { clock, ttlMs: 1e12 });
  assert.ok(got.ok);
  const projector = createLedgerProjector({ ledgerDir, db, lease: got.lease, clock });
  const append = (more: Row[]): void => {
    appendFileSync(join(ledgerDir, "ledger.ndjson"), more.map((r) => `${JSON.stringify(r)}\n`).join(""));
    projector.tick();
  };
  append(rows);
  return {
    root, db, lease: got.lease, ledgerDir, clock, append, set: (to) => void (ms = to),
    board: (over = {}) => createBoardProjection({
      db, ledgerPath: join(ledgerDir, "ledger.ndjson"), clock, readPlan: () => PLAN, github: GATEWAY, githubGeneration: () => "g1",
      readCreditStore: () => ({}), readCreditOverrideFile: () => "", ...over,
    }),
  };
}

function drain(board: BoardProjection): void {
  let n = 0;
  while (!board.update({ force: true }).caughtUp && n++ < 1_000) { /* to caught up */ }
}

/** Each task's bucket from an uncached projection's index: today's full read of the same store at the same seq. */
function uncachedBuckets(w: World): Record<string, string[]> {
  const fresh = w.board({ taskCacheBytes: 0 });
  drain(fresh);
  const index = fresh.index(fresh.rows());
  return Object.fromEntries(IDS.map((id) => [id, (index.byTask.get(id) ?? []).map((r) => JSON.stringify(r))]));
}

function bucketsOf(board: BoardProjection): Record<string, string[]> {
  const index = board.index(board.rows());
  return Object.fromEntries(IDS.map((id) => [id, (index.byTask.get(id) ?? []).map((r) => JSON.stringify(r))]));
}

/** The body rows one `byTask.get` reads on a fresh index of `board`. */
function readsOf(counted: { bodyRows(): number }, board: BoardProjection, id: string): { reads: number; rows: number } {
  const index = board.index(board.rows());
  const mark = counted.bodyRows();
  const rows = (index.byTask.get(id) ?? []).length;
  return { reads: counted.bodyRows() - mark, rows };
}

test("W1-T9716: an extended task bucket equals a fresh full read", (t) => {
  const w = world(t, [...rowsFrom(T0, 40), ...aliasRows(T0 + 50_000, "W1-T23", 1)]);
  const board = w.board();
  drain(board);
  bucketsOf(board); // every task's bucket held
  for (let round = 0; round < 3; round++) {
    // New rows for every task, a new alias row, and a late row for W1-T24 whose ts is before rows its bucket holds.
    const late = T0 + 5_000 + round;
    w.append([
      ...rowsFrom(T0 + 600_000 + round * 60_000, 4, 40 + round * 4),
      ...aliasRows(T0 + 650_000 + round * 60_000, "W1-T23", 2 + round),
      { ts: at(late), host: "h1", step: "verdict", task_id: "W1-T24", run_id: "r-W1-T24", verdict: "failed", cost_usd: 0.1, late: round },
    ]);
    drain(board);
    const extended = bucketsOf(board);
    assert.deepEqual(extended, uncachedBuckets(w), `round ${round}: every extended bucket equals a fresh full read at the same seq`);
    const lateAt = extended["W1-T24"]!.findIndex((r) => (JSON.parse(r) as Row).late === round);
    assert.ok(lateAt >= 0 && lateAt < extended["W1-T24"]!.length - 1, `round ${round}: control, the late row is held and sorts before rows already held`);
    assert.equal(extended["W1-T23"]!.filter((r) => (JSON.parse(r) as Row).step === "dispatch.circuit_broken").length, 2 + round,
      `round ${round}: control, the bucket holds every alias row`);
  }
  // A/A: two uncached reads of one store agree, so the comparison above can tell a difference from noise.
  assert.deepEqual(uncachedBuckets(w), uncachedBuckets(w));
});

test("W1-T9716: a re-derived task reads only its new rows", (t) => {
  const w = world(t, rowsFrom(T0, 60));
  const counted = counting(w.db);
  const board = w.board({ db: counted.db });
  drain(board);
  const first = readsOf(counted, board, "W1-T23");
  assert.ok(first.rows > 50, `control: the task holds ${first.rows} rows`);
  w.append([
    ...["implement.done", "review.posted", "verdict"].map((step, i) => ({ ts: at(T0 + 900_000 + i * 1_000), host: "h1", step, task_id: "W1-T23", run_id: "r-W1-T23", n: `x${i}` })),
    ...aliasRows(T0 + 910_000, "W1-T25", 1),
  ]);
  drain(board);
  const second = readsOf(counted, board, "W1-T23");
  assert.equal(second.rows, first.rows + 3, "control: the bucket holds the 3 new rows");
  assert.ok(second.reads <= 3, `the re-derived bucket read ${second.reads} rows (it holds ${second.rows}; 3 are new)`);
  assert.deepEqual(bucketsOf(board), uncachedBuckets(w), "and what it hands out is a full read's");
  // Control: with the cache off, the same ask reads every row of the task again.
  const offCounted = counting(w.db);
  const off = w.board({ db: offCounted.db, taskCacheBytes: 0 });
  drain(off);
  assert.equal(readsOf(offCounted, off, "W1-T23").reads, second.rows, "control: an uncached ask reads the whole history");
});

test("W1-T9716: the task cache evicts the least recently re-derived task at its bound", (t) => {
  const w = world(t, rowsFrom(T0, 30));
  const bytes = (id: string): number => Number(w.db.prepare("SELECT sum(length(body)) AS b FROM fact WHERE task_id = ?").get(id)?.b ?? 0);
  const per = Math.max(...IDS.map(bytes));
  assert.ok(Math.min(...IDS.map(bytes)) > per * 0.9, "control: every task's history is about the same size");
  const bound = Math.floor(per * 2.5); // two tasks fit, three do not
  const counted = counting(w.db);
  const logged: Array<Record<string, unknown>> = [];
  const board = w.board({ db: counted.db, taskCacheBytes: bound, oracleSlices: 1, log: (step, extra) => void (step === "read_model.board_oracle" && logged.push(extra)) });
  drain(board);
  const [a, b, c] = ["W1-T21", "W1-T22", "W1-T23"];
  // Held after this: a then b (most recent last).
  readsOf(counted, board, a);
  readsOf(counted, board, b);
  assert.equal(readsOf(counted, board, a).reads, 0, "a held task is served without a store read");
  // c arrives: the least recently re-derived (b) goes.
  assert.ok(readsOf(counted, board, c).reads > 0, "control: c is read in full");
  const bAgain = readsOf(counted, board, b);
  assert.equal(bAgain.reads, bAgain.rows, "b was evicted, so it is read in full again");
  // b's return evicted a (now the least recent); c, re-derived after a, is still held.
  assert.equal(readsOf(counted, board, c).reads, 0, "c, more recent than a, is still held");
  const aAgain = readsOf(counted, board, a);
  assert.equal(aAgain.reads, aAgain.rows, "a, the least recent at b's return, was evicted and is read in full");
  board.oracle();
  const cache = (logged.at(-1)?.step_cache as { task_cache: { bytes: number; tasks: number; evictions: number; full_reads: number; hits: number } }).task_cache;
  assert.ok(cache.bytes <= bound, `the cache holds ${cache.bytes} bytes, at most its bound ${bound}`);
  assert.ok(cache.tasks <= 2, `and at most two tasks (${cache.tasks})`);
  assert.ok(cache.evictions >= 2 && cache.full_reads > 0 && cache.hits > 0, "the oracle row counts evictions, full reads and hits");
});

const FEEDBACK: FeedbackEntry[] = [];

function nowView(w: World, boardOptions: Partial<BoardProjectionOptions>) {
  const instance = { name: "core", ledgerDir: w.ledgerDir, repo: "o/r", feedbackRoot: join(w.root, "checkout") };
  return createNowView({
    instances: [instance], clock: w.clock, readPlan: () => PLAN, github: () => ({ github: GATEWAY, generation: "g", source: { asOf: null, state: "fresh" } }),
    hostProbe: { rateLimit: () => 5_000, diskFree: () => 1_000_000, readLive: () => [] }, listGrilling: () => FEEDBACK, planBehind: () => ({ commits: 0 }),
    // The task cache's bound rides the board options the view already spreads into its projection.
    boardOptions: boardOptions as unknown as NowViewOptions["boardOptions"],
  });
}

function built(w: World, db: ReadModelDb, view: ReturnType<typeof createNowView>): NowViewData {
  const c: NowViewContext = {
    now: w.clock.now(), switches: { views: { now: "shadow" } },
    instances: [{ state: { instance: "core", generation: Number(w.db.meta("generation")), lease: "held", failures: 0, tickedAt: w.clock.now(), newestTs: null }, db, lease: w.lease }],
  } as unknown as NowViewContext;
  while (!view.prepare(c, () => true)) { /* to ready */ }
  const bodies = view.materialize(c);
  assert.equal(bodies.length, 1, "control: one body");
  return bodies[0]!.data;
}

test("W1-T9716: now-view bodies are identical with the task cache on and off", (t) => {
  const history = [...rowsFrom(T0, 40), ...aliasRows(T0 + 60_000, "W1-T26", 1)];
  const on = world(t, history);
  const off = world(t, history);
  const [onDb, offDb] = [counting(on.db), counting(off.db)];
  const onView = nowView(on, {});
  const offView = nowView(off, { taskCacheBytes: 0 });
  const portable = (w: World, data: NowViewData): unknown => JSON.parse(JSON.stringify(data).split(w.root).join("<root>"));
  let ms = T0 + 3_600_000;
  const [onMark, offMark] = [onDb.bodyRows(), offDb.bodyRows()];
  for (let round = 0; round < 5; round++) {
    if (round > 0) {
      const more = [...rowsFrom(T0 + 700_000 + round * 60_000, 2, 40 + round * 2), ...aliasRows(T0 + 710_000 + round * 60_000, "W1-T26", round + 1)];
      on.append(more);
      off.append(more);
      // Past the clock rule's 30 s, so every aging projection re-derives as it does in serve.
      ms += 31_000;
      on.set(ms);
      off.set(ms);
    }
    const [a, b] = [built(on, onDb.db, onView), built(off, offDb.db, offView)];
    assert.deepEqual(portable(on, a), portable(off, b), `round ${round}: the now-view bodies are byte-identical`);
    assert.ok(JSON.stringify(a).includes("W1-T21"), `round ${round}: control, the body lists the tasks`);
  }
  const [onReads, offReads] = [onDb.bodyRows() - onMark, offDb.bodyRows() - offMark];
  assert.ok(onReads < offReads, `control: the cached arm read ${onReads} body rows against ${offReads} uncached`);
});

test("W1-T9716: the board oracle finds a held task bucket that drifted and drops the cache", (t) => {
  const w = world(t, rowsFrom(T0, 20));
  const logged: Array<Record<string, unknown>> = [];
  const board = w.board({ oracleSlices: 1, log: (step, extra) => void (step === "read_model.board_oracle" && logged.push(extra)) });
  drain(board);
  board.oracle();
  const clean = logged.at(-1)?.step_cache as { audit: { mismatches: string[]; tasks: number } };
  assert.deepEqual(clean.audit.mismatches, [], "the audit (cached against the oracle's uncached read) agrees");
  assert.ok(clean.audit.tasks > 0, "control: the audit compared held task buckets");
  // A reader writing into a row it was handed changes the held bucket: the next audit names the task and drops the cache.
  const handed = board.index(board.rows()).byTask.get("W1-T23") ?? [];
  (handed[0] as Row).run_id = "mutated";
  board.oracle();
  const drifted = logged.at(-1)?.step_cache as { audit: { mismatches: string[] }; resets: { audit: number } };
  assert.ok(drifted.audit.mismatches.includes("task:W1-T23"), "the audit names the task that drifted");
  assert.equal(drifted.resets.audit, 1, "and drops the cache");
  assert.notEqual((board.index(board.rows()).byTask.get("W1-T23") ?? [])[0]?.run_id, "mutated", "the next index reads the task again");
});

test("W1-T9716: a re-derive larger than the bound keeps the buckets it already used", (t) => {
  const w = world(t, rowsFrom(T0, 30));
  const bytes = (id: string): number => Number(w.db.prepare("SELECT sum(length(body)) AS b FROM fact WHERE task_id = ?").get(id)?.b ?? 0);
  const bound = Math.floor(Math.max(...IDS.map(bytes)) * 2.5);
  const counted = counting(w.db);
  const board = w.board({ db: counted.db, taskCacheBytes: bound });
  drain(board);
  // One index re-derives four tasks in a fixed order, as a clock pass does, twice: plain LRU would evict each bucket just
  // before its next use and hit nothing. The buckets this index already used are kept; the rest are read but not held.
  const order = ["W1-T21", "W1-T22", "W1-T23", "W1-T24"];
  const pass = (): number[] => {
    const index = board.index(board.rows());
    return order.map((id) => {
      const mark = counted.bodyRows();
      index.byTask.get(id);
      return counted.bodyRows() - mark;
    });
  };
  pass();
  const second = pass();
  assert.deepEqual(second.slice(0, 2), [0, 0], `the two buckets that fit are served without a store read (${second.join(", ")})`);
  assert.ok(second[2]! > 0 && second[3]! > 0, "control: the rest are read in full, not held");
});
