import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalProjection, createBoardProjection, type BoardProjection } from "../src/lib/board-projection.js";
import type { Clock } from "../src/lib/clock.js";
import { createLedgerProjector, openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { createNowView, type NowViewContext, type NowViewOptions } from "../src/lib/now-view.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { acquireLease, type ReadModelDb, type ReadModelStatement } from "../src/lib/read-model-db.js";
import type { GitHub } from "../src/lib/status.js";
import { makeTempDir } from "../src/lib/tmp.js";

const T0 = Date.parse("2026-10-06T08:00:00.000Z");
const IDS = ["W1-T1", "W1-T2", "W1-T3", "W1-T4", "W1-T5", "W1-T6"];
const CHUNK = 5;

type TestCtx = { after: (fn: () => void) => void };

function task(id: string): Task {
  return { id, title: `task ${id}`, repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 };
}

const PLAN: Plan = { tasks: IDS.map(task), byId: new Map(IDS.map((id) => [id, task(id)])) };

const GATEWAY = {
  readFailed: () => false, prByRef: () => null, findMergedByTrailer: () => null, findMergedByHeadBranch: () => [], listMergedHeadBranches: () => [],
  listOpenHeadBranches: () => [], headRefName: () => undefined, prBody: () => undefined, issueByUrl: () => ({ state: "OPEN", title: "t" }),
} as unknown as GitHub;

function handClock(): Clock & { set(ms: number): void } {
  let ms = T0;
  return { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString(), set: (to) => void (ms = to) };
}

const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

/**
 * Fact rows over six tasks: runs that start, block, go non-fact-active and finish, an unread sweep
 * row, a cross-task boot, and rows written a few seconds out of time order across the chunk boundaries.
 */
function seedRows(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [{ ts: iso(0), step: "daemon.boot" }];
  IDS.forEach((id, i) => {
    const at = 1_000 * (i + 1);
    out.push({ ts: iso(at), step: "worker.assignment", task_id: id, run_id: `r-${id}` });
    out.push({ ts: iso(at + 10), step: "run.start", task_id: id, run_id: `r-${id}` });
    out.push({ ts: iso(at + 5), step: "sweep.pass", n: i });
    out.push({ ts: iso(at - 700), step: "worker.heartbeat", task_id: id, run_id: `r-${id}` });
  });
  out.push({ ts: iso(9_000), step: "dispatch.blocked_independent", task_id: "W1-T1", run_id: "r-W1-T1", verdict: "failed" });
  out.push({ ts: iso(8_500), step: "verdict", task_id: "W1-T2", run_id: "r-W1-T2", verdict: "no_pr" });
  out.push({ ts: iso(9_500), step: "verdict", task: "W1-T3", run_id: "r-W1-T3", verdict: "no_pr" });
  out.push({ ts: iso(9_600), step: "worker.activity", task_id: "W1-T4", run_id: "r-W1-T4", phase: "editing" });
  out.push({ ts: iso(9_700), step: "sweep.summary" });
  out.push({ ts: iso(9_800), step: "run.end", task_id: "W1-T4", run_id: "r-W1-T4" });
  return out;
}

interface Store {
  dir: string;
  db: ReadModelDb;
  clock: Clock & { set(ms: number): void };
  facts: number;
  /** Rows each fact read handed out, one entry per read. */
  reads: number[];
  append(...rows: Array<Record<string, unknown>>): void;
  board(over?: { chunkRows?: number; chunkMs?: number }): BoardProjection;
}

/** A store whose fact table holds every row of {@link seedRows}; `reads` counts what each fact read returned. */
function store(t: TestCtx): Store {
  const dir = makeTempDir("cold-board");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const clock = handClock();
  clock.set(T0 + 30_000);
  const raw = openProjectorReadModel(join(dir, "home"), "core", clock);
  t.after(() => raw.close());
  const got = acquireLease(raw, { clock, ttlMs: 1e12 });
  assert.ok(got.ok);
  const ledgerDir = join(dir, "core", "state");
  mkdirSync(ledgerDir, { recursive: true });
  const projector = createLedgerProjector({ ledgerDir, db: raw, lease: got.lease, clock });
  const reads: number[] = [];
  const counted = (s: ReadModelStatement): ReadModelStatement => new Proxy(s, {
    get(target, key) {
      if (key !== "iterate") return Reflect.get(target, key, target);
      return function* (...params: unknown[]) {
        let n = 0;
        try {
          for (const row of (target.iterate as (...p: unknown[]) => Iterable<Record<string, unknown>>)(...params)) {
            n++;
            yield row;
          }
        } finally {
          reads.push(n);
        }
      };
    },
  });
  const db = new Proxy(raw, {
    get(target, key) {
      const value = Reflect.get(target, key, target) as unknown;
      if (key === "prepare") return (sql: string) => (/FROM fact WHERE seq > \?/.test(sql) ? counted(target.prepare(sql)) : target.prepare(sql));
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  const append = (...rows: Array<Record<string, unknown>>): void => {
    appendFileSync(join(ledgerDir, "ledger.ndjson"), rows.map((r) => `${JSON.stringify({ ...r, host: "h1" })}\n`).join(""));
    projector.tick();
  };
  append(...seedRows());
  const facts = Number(raw.prepare("SELECT count(*) AS n FROM fact").get()?.n);
  assert.equal(Number(raw.prepare("SELECT count(*) AS n FROM fact WHERE ts_ms = 0").get()?.n), 0, "control: every fact carries its time");
  return {
    dir: ledgerDir, db, clock, facts, reads, append,
    board: (over = {}) => createBoardProjection({
      db, ledgerPath: join(ledgerDir, "ledger.ndjson"), clock, readPlan: () => PLAN, github: GATEWAY, githubGeneration: () => "g1",
      readCreditStore: () => ({}), readCreditOverrideFile: () => "",
      ...(over.chunkRows !== undefined ? { ingestChunkRows: over.chunkRows } : {}), ...(over.chunkMs !== undefined ? { ingestChunkMs: over.chunkMs } : {}),
    }),
  };
}

function canonical(board: BoardProjection): Record<string, string> {
  return Object.fromEntries([...board.projections()].map(([id, p]) => [id, canonicalProjection(p)]).sort());
}

/** Calls `update` until it reports caught up; each call's result, in order. */
function drain(board: BoardProjection): Array<ReturnType<BoardProjection["update"]>> {
  const out: Array<ReturnType<BoardProjection["update"]>> = [];
  do out.push(board.update({ force: true }));
  while (!out.at(-1)!.caughtUp && out.length < 100);
  return out;
}

test("a cold board stage over a fact store larger than one chunk takes more than one prepare step, each step ingests at most one chunk, and the resulting projections equal those of an unchunked ingest", (t) => {
  const s = store(t);
  assert.ok(s.facts > 4 * CHUNK, `control: the fixture spans ${s.facts} fact rows, more than four chunks of ${CHUNK}`);
  const feedbackRoot = join(s.dir, "checkout");
  mkdirSync(join(feedbackRoot, "plan", "feedback"), { recursive: true });
  const instance = { name: "core", ledgerDir: s.dir, repo: "o/r", feedbackRoot };
  const raw = (s.db as unknown as { meta(k: string): string | undefined }).meta("generation");
  const ctx: NowViewContext = {
    now: s.clock.now(), switches: { views: { now: "shadow" } },
    instances: [{ state: { instance: "core", generation: Number(raw), lease: "held", failures: 0, tickedAt: s.clock.now(), newestTs: null }, db: s.db }],
  };
  const seams: Partial<NowViewOptions> = {
    readPlan: () => PLAN, github: () => ({ github: GATEWAY, generation: "g", source: { asOf: null, state: "fresh" } }),
    hostProbe: { rateLimit: () => 5_000, diskFree: () => 1_000_000, readLive: () => [] }, listGrilling: () => [], planBehind: () => ({ commits: 0 }),
  };
  const stepped = createNowView({ instances: [instance], clock: s.clock, boardIngestChunkRows: CHUNK, ...seams });
  const oneStage = (): (() => boolean) => {
    let first = true;
    return () => {
      const allowed = first;
      first = false;
      return allowed;
    };
  };
  let steps = 1;
  while (!stepped.prepare(ctx, oneStage())) steps++;
  const chunkCalls = Math.floor(s.facts / CHUNK) + 1;
  assert.equal(steps, 6 + chunkCalls, `seven stages, the board's over ${chunkCalls} steps`);
  assert.equal(s.reads.length, chunkCalls, "one fact read per board step");
  assert.ok(s.reads.every((n) => n <= CHUNK), `no step read more than one chunk: ${s.reads.join(", ")}`);
  assert.equal(s.reads.reduce((a, b) => a + b, 0), s.facts, "every fact was read exactly once");
  const fromChunks = stepped.materialize(ctx);
  assert.equal(fromChunks.length, 1);
  s.reads.length = 0;
  const unchunked = createNowView({ instances: [instance], clock: s.clock, ...seams }).materialize(ctx);
  assert.deepEqual(s.reads, [s.facts], "control: the unchunked build read the whole store in one step");
  assert.deepEqual(fromChunks, unchunked);
});

test("W1-T6014: a chunked cold ingest projects the same board and rows as a one-call ingest of the same store", (t) => {
  const s = store(t);
  const whole = s.board();
  const one = drain(whole);
  assert.equal(one.length, 1, "control: the default chunk holds the whole fixture");
  assert.equal(one[0]!.newRows, s.facts);
  const chunked = s.board({ chunkRows: CHUNK });
  const calls = drain(chunked);
  const full = Math.floor(s.facts / CHUNK);
  assert.ok(full >= 4, `control: ${s.facts} fact rows fill ${full} chunks`);
  assert.deepEqual(calls.map((u) => u.newRows), [...Array(full).fill(CHUNK), s.facts - full * CHUNK]);
  assert.deepEqual(calls.map((u) => [u.caughtUp, u.derived]), [...Array(full).fill([false, false]), [true, true]]);
  assert.equal(Object.keys(canonical(whole)).length, IDS.length, "control: every plan task is projected");
  assert.deepEqual(canonical(chunked), canonical(whole));
  assert.deepEqual(chunked.rows(), whole.rows(), "the same rows, in the same (time) order");
  const written = new Set(seedRows().map((r) => r.step));
  const times = whole.rows().filter((r) => written.has(r.step)).map((r) => Date.parse(String(r.ts)));
  assert.deepEqual(times, [...times].sort((a, b) => a - b), "the rows stand in time order, though the ledger wrote them out of it");
});

test("W1-T6014: a cold ingest of N rows completes across bounded calls, each ending at its time budget", (t) => {
  const s = store(t);
  assert.equal(drain(s.board()).length, 1, "control: the default row bound holds the whole fixture, so only the time bound cuts it");
  const timed = s.board({ chunkMs: 0 });
  const calls = drain(timed);
  assert.equal(calls.length, s.facts, "a spent budget still ingests one row, then yields");
  assert.ok(calls.every((u) => u.newRows === 1));
  assert.ok(calls.slice(0, -1).every((u) => !u.caughtUp && !u.derived));
  assert.equal(calls.at(-1)!.caughtUp, true);
  assert.deepEqual(canonical(timed), canonical(drain2(s)));
});

function drain2(s: Store): BoardProjection {
  const b = s.board();
  drain(b);
  return b;
}

test("W1-T6014: a warm projection still ingests and derives a few new rows in one call", (t) => {
  const s = store(t);
  const board = s.board({ chunkRows: CHUNK });
  drain(board);
  s.clock.set(T0 + 60_000);
  s.append({ ts: iso(60_000), step: "verdict", task_id: "W1-T2", run_id: "r2", verdict: "no_pr" }, { ts: iso(59_000), step: "worker.assignment", task_id: "W1-T3", run_id: "r3" });
  const warm = board.update();
  assert.equal(warm.newRows, 2);
  assert.equal(warm.caughtUp, true);
  assert.equal(warm.derived, true);
  assert.ok(warm.rederived.includes("W1-T2") && warm.rederived.includes("W1-T3"), `the moved tasks re-derived: ${warm.rederived.join(", ")}`);
  const fresh = drain2(s);
  assert.deepEqual(canonical(board), canonical(fresh));
  assert.deepEqual(board.rows(), fresh.rows(), "a warm row a second early is walked back into time order");
});

test("W1-T6014: the oracle on a cold projection ingests the whole store, past any chunk", (t) => {
  const s = store(t);
  const board = s.board({ chunkRows: CHUNK });
  const result = board.oracle();
  assert.equal(result.outcome, "healed", "nothing was held yet, so every task heals in");
  assert.deepEqual(s.reads, [s.facts], "one unbounded read");
  assert.deepEqual(canonical(board), canonical(drain2(s)));
});
