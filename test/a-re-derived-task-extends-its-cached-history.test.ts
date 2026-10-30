import assert from "node:assert/strict";
import { test } from "node:test";
import { createBoardProjection, type BoardProjectionOptions, type Row } from "#src/lib/board-projection.js";
import type { Clock } from "#src/lib/clock.js";
import { FACT_ALIAS_META, LEDGER_PROJECTOR_DDL } from "#src/lib/ledger-projector.js";
import { createNowView, type NowViewContext } from "#src/lib/now-view.js";
import type { Plan, Task } from "#src/lib/plan.js";
import { openScratchReadModel, type ReadModelDb, type ReadModelStatement } from "#src/lib/read-model-db.js";
import type { GitHub } from "#src/lib/status.js";

const T0 = Date.parse("2026-10-15T12:00:00Z");
const at = (offset: number): string => new Date(T0 + offset).toISOString();
const IDS = ["W1-T1", "W1-T2", "W1-T3"];
const tasks: Task[] = IDS.map((id) => ({ id, title: id, repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 }));
const PLAN: Plan = { tasks, byId: new Map(tasks.map((task) => [task.id, task])) };
const GITHUB = {
  readFailed: () => false, prByRef: () => null, findMergedByTrailer: () => null, findMergedByHeadBranch: () => [],
  listMergedHeadBranches: () => [], listOpenHeadBranches: () => [], headRefName: () => undefined, prBody: () => undefined,
  issueByUrl: () => ({ state: "OPEN", title: "issue" }),
} as unknown as GitHub;
type Options = Partial<BoardProjectionOptions>;
type CacheStats = { hits: number; extended_rows: number; full_reads: number; evictions: number; bytes: number };

function rig(t: { after(fn: () => void): void }, initial: Row[] = []) {
  const raw = openScratchReadModel();
  t.after(() => raw.close());
  raw.exec(`CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID; ${LEDGER_PROJECTOR_DDL}`);
  raw.prepare("INSERT INTO meta(k, v) VALUES(?, 'backfilled')").run(FACT_ALIAS_META);
  let seq = 0;
  let ms = T0 + 3_600_000;
  let bodyReads = 0;
  const ranges: unknown[][] = [];
  const db: ReadModelDb = {
    ...raw,
    prepare(sql, options) {
      const stmt = raw.prepare(sql, options);
      if (!sql.includes("SELECT seq, ts_ms, step, body FROM fact WHERE task_id = ?")) return stmt;
      const note = (rows: ReturnType<ReadModelStatement["all"]>) => { bodyReads += rows.length; return rows; };
      return {
        run: (...p) => stmt.run(...p), get: (...p) => stmt.get(...p),
        all: (...p) => { ranges.push(p); return note(stmt.all(...p)); },
        iterate: function* (...p) {
          ranges.push(p);
          for (const row of stmt.iterate(...p)) { bodyReads++; yield row; }
        },
      };
    },
  };
  const append = (rows: Row[]): void => {
    for (const row of rows) {
      raw.prepare("INSERT INTO fact(seq, ts, ts_ms, step, task_id, run_id, body) VALUES(?, ?, ?, ?, ?, ?, ?)")
        .run(++seq, String(row.ts), Date.parse(String(row.ts)), String(row.step), typeof row.task_id === "string" ? row.task_id : null,
          typeof row.run_id === "string" ? row.run_id : null, JSON.stringify(row));
      if (typeof row.task === "string" && typeof row.task_id === "string" && row.task !== row.task_id) raw.prepare("INSERT INTO fact_alias VALUES(?, ?)").run(row.task, seq);
    }
  };
  append(initial);
  const clock: Clock = { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() };
  const logged: Record<string, unknown>[] = [];
  const board = (extra: Options = {}) => createBoardProjection({
    db, ledgerPath: "/unused/ledger.ndjson", clock, readPlan: () => PLAN, github: GITHUB, githubGeneration: () => "g",
    readCreditStore: () => ({}), readCreditOverrideFile: () => "", oracleSlices: 1,
    log: (step, row) => { if (step === "read_model.board_oracle") logged.push(row); }, ...extra,
  });
  const stats = (b: ReturnType<typeof board>): CacheStats => {
    b.oracle();
    const step = logged.at(-1)!.step_cache as { task_cache: CacheStats };
    assert.ok(step.task_cache, "the oracle reports task-cache reads and held bytes");
    return step.task_cache;
  };
  return { raw, db, clock, board, stats, append, ranges, reads: () => bodyReads, set: (now: number) => { ms = now; } };
}

const history = (): Row[] => IDS.flatMap((id) => Array.from({ length: 15 }, (_, n) => ({ ts: at(n * 1_000), step: "run.start", task_id: id, run_id: `r-${id}`, n, question: "unread", details: { nested: [n] } })));

test("W1-T9716: an extended task bucket equals a fresh full read", (t) => {
  const w = rig(t, history());
  const board = w.board();
  board.update({ force: true });
  const early = board.index(board.rows());
  const before = structuredClone(early.byTask.get(IDS[0]!)!);
  const untouched = board.index(board.rows());
  w.append([
    { ts: at(-1_000), step: "verdict", task_id: "DAEMON", task: IDS[0], verdict: "no_pr", late: true },
    { ts: at(2_000), step: "run.start", task_id: IDS[0], run_id: "tied", tied: true },
    { ts: at(20_000), step: "run.start", task_id: IDS[1], task: IDS[1], run_id: "same-alias" },
  ]);
  board.update({ force: true });
  const fresh = w.board({ taskCacheMaxBytes: 0 });
  fresh.update({ force: true });
  const extended = board.index(board.rows());
  for (const id of IDS) assert.deepEqual(extended.byTask.get(id), fresh.index(fresh.rows()).byTask.get(id));
  assert.equal(extended.byTask.get(IDS[0]!)![0]!.late, true);
  assert.deepEqual(early.byTask.get(IDS[0]!), before);
  assert.deepEqual(untouched.byTask.get(IDS[0]!), before, "an earlier index first asked after extension still sees its own seq");
  assert.ok(w.stats(board).extended_rows >= 3);
});

test("W1-T9716: a re-derived task reads only its new rows", (t) => {
  const w = rig(t, history());
  const board = w.board();
  board.update({ force: true });
  assert.ok(w.reads() >= 45, "control: the cold derive reads the histories");
  const mark = w.reads();
  w.ranges.length = 0;
  w.append([
    { ts: at(30_000), step: "run.start", task_id: IDS[0], run_id: "new" },
    { ts: at(-500), step: "verdict", task_id: "DAEMON", task: IDS[0], verdict: "no_pr" },
    { ts: at(31_000), step: "sweep.pass", task_id: IDS[0] },
  ]);
  board.update({ force: true });
  assert.equal(w.reads() - mark, 2, "only the two new readable task and alias rows reach the reader");
  assert.ok(w.ranges.some((p) => p[0] === IDS[0] && p[1] === 45 && p[2] === 48), "the task query has the cached lower seq bound");
  const again = w.reads();
  w.set(T0 + 3_630_000);
  board.update({ force: true });
  assert.equal(w.reads(), again, "a clock re-derive reads no old task bodies");
  const stats = w.stats(board);
  assert.equal(stats.extended_rows, 2);
  assert.ok(stats.hits > 0);
});

test("W1-T9716: the task cache evicts the least recently re-derived task at its bound", (t) => {
  const rows = IDS.map((id) => ({ ts: at(0), step: "run.start", task_id: id, run_id: id, payload: "é".repeat(100) }));
  const bytes = Buffer.byteLength(JSON.stringify(rows[0]));
  const w = rig(t, rows);
  const board = w.board({ taskCacheMaxBytes: bytes * 2 });
  board.update({ force: true });
  const ask = (id: string) => board.index(board.rows()).byTask.get(id);
  ask(IDS[0]!); ask(IDS[1]!); ask(IDS[0]!);
  const mark = w.reads();
  ask(IDS[2]!);
  assert.equal(w.reads() - mark, 1);
  const hit = w.reads();
  ask(IDS[0]!);
  assert.equal(w.reads(), hit, "the recently re-derived task survived");
  ask(IDS[1]!);
  assert.equal(w.reads() - hit, 1, "the least recent task needs a full read");
  const stats = w.stats(board);
  assert.ok(stats.bytes > 0 && stats.bytes <= bytes * 2);
  assert.ok(stats.evictions >= 2);
  const oversized = w.board({ taskCacheMaxBytes: bytes - 1 });
  oversized.update({ force: true });
  assert.equal(w.stats(oversized).bytes, 0, "a single oversized bucket is not retained");
});

test("W1-T9716: now-view bodies are identical with the task cache on and off", (t) => {
  const w = rig(t, history());
  const logs: Record<string, unknown>[] = [];
  const make = (taskCacheMaxBytes: number) => {
    const boardOptions = { keepEveryRow: false, taskCacheMaxBytes, oracleSlices: 1, readCreditStore: () => ({}), readCreditOverrideFile: () => "",
      log: (step: string, row: Record<string, unknown>) => { if (step === "read_model.board_oracle") logs.push(row); } };
    return createNowView({
      instances: [{ name: "core", ledgerDir: "/unused", repo: "o/r" }], clock: w.clock, readPlan: () => PLAN,
      github: () => ({ github: GITHUB, generation: "g", source: { asOf: null, state: "fresh" } }), boardOptions,
      hostProbe: { rateLimit: () => 5_000, diskFree: () => 1_000_000, readLive: () => [] }, listGrilling: () => [], planBehind: () => ({ commits: 0 }),
    });
  };
  const on = make(16 * 1024 * 1024);
  const off = make(0);
  const build = (view: ReturnType<typeof make>): string => {
    const ctx: NowViewContext = { now: w.clock.now(), switches: { views: { now: "shadow" } }, instances: [{
      state: { instance: "core", generation: Number(w.db.meta("generation")), lease: "held", failures: 0, tickedAt: w.clock.now(), newestTs: null }, db: w.db,
    }] };
    while (!view.prepare(ctx, () => true)) { /* finish the current build */ }
    const bodies = view.materialize(ctx);
    assert.equal(bodies.length, 1);
    return JSON.stringify(bodies);
  };
  for (let round = 0; round < 5; round++) {
    w.set(T0 + 3_600_000 + round * 660_000);
    if (round) w.append([
      { ts: at(round * 1_000), step: "verdict", task_id: "DAEMON", task: IDS[round % 3], verdict: "no_pr" },
      { ts: at(round * 660_000), step: "run.start", task_id: IDS[0], run_id: `new-${round}` },
      { ts: at(round * 660_000), step: "daemon.boot", head_sha: `head-${round}` },
    ]);
    assert.equal(build(on), build(off), `round ${round}: serialized now-view bodies agree`);
  }
  const cacheRows = logs.map((row) => (row.step_cache as { task_cache: CacheStats }).task_cache);
  assert.ok(cacheRows.some((stats) => stats && stats.hits > 0 && stats.extended_rows > 0), "the on arm really extends and reuses cached histories");
  assert.ok(cacheRows.some((stats) => stats && stats.bytes === 0 && stats.full_reads > 0), "the off arm really reads histories in full");
});

test("W1-T9716: handed-out rows cannot mutate the task cache", (t) => {
  const w = rig(t, history());
  const board = w.board();
  board.update({ force: true });
  const original = structuredClone(board.index(board.rows()).byTask.get(IDS[0]!)!);
  const handed = board.index(board.rows()).byTask.get(IDS[0]!)!;
  assert.ok(handed.length > 0);
  assert.equal(handed[0]!.question, undefined, "cached rows still omit unread fields");
  handed[0]!.run_id = "mutated";
  (handed[0]!.details as { nested: number[] }).nested.push(999);
  (handed as Row[]).pop();
  const before = w.reads();
  assert.deepEqual(board.index(board.rows()).byTask.get(IDS[0]!), original);
  assert.equal(w.reads(), before, "the unmutated answer came from cache");
});

test("W1-T9716: deleted task and alias rows and a rewound store invalidate cached histories", (t) => {
  const w = rig(t, [...history(), { ts: at(-1_000), step: "run.start", task_id: "DAEMON", task: IDS[0], run_id: "alias" }]);
  const board = w.board();
  board.update({ force: true });
  const ask = () => board.index(board.rows()).byTask.get(IDS[0]!)!;
  assert.equal(ask().length, 16);
  w.raw.exec("DELETE FROM fact_alias WHERE task = 'W1-T1'");
  let before = w.reads();
  assert.equal(ask().length, 15);
  assert.equal(w.reads() - before, 15, "alias-index deletion forces a fresh read");
  w.raw.exec("DELETE FROM fact WHERE seq = 1");
  before = w.reads();
  assert.equal(ask().length, 14);
  assert.equal(w.reads() - before, 14, "an interior deletion is found even when max seq is unchanged");
  w.append([{ ts: at(60_000), step: "sweep.pass", task_id: IDS[0] }]);
  board.update({ force: true });
  ask();
  w.raw.exec("DELETE FROM fact WHERE step = 'sweep.pass'");
  before = w.reads();
  assert.equal(ask().length, 14);
  assert.equal(w.reads() - before, 14, "a max seq behind the cache forces a full read");
});

test("W1-T9716: legacy alias backfill and run stand-ins retain their uncached behavior", (t) => {
  const w = rig(t, [...history(), { ts: at(-1_000), step: "verdict", task_id: "DAEMON", task: IDS[0], verdict: "no_pr" }]);
  w.raw.exec("DELETE FROM fact_alias; DELETE FROM meta WHERE k = 'fact_alias'");
  w.raw.exec("CREATE TABLE run_activity(task_id TEXT, run_id TEXT, ts TEXT, ts_ms INTEGER, seq INTEGER)");
  w.raw.prepare("INSERT INTO run_activity VALUES(?, ?, ?, ?, ?)").run(IDS[0]!, "activity", at(60_000), T0 + 60_000, 1);
  const board = w.board();
  board.update({ force: true });
  const ask = () => board.index(board.rows()).byTask.get(IDS[0]!)!;
  assert.equal(ask().length, 17, "legacy aliases and the activity stand-in are present");
  assert.equal(w.stats(board).bytes, 0, "a store awaiting alias backfill is not cached");
  w.raw.prepare("INSERT INTO fact_alias VALUES(?, ?)").run(IDS[0]!, 46);
  w.raw.prepare("INSERT INTO meta VALUES(?, 'backfilled')").run(FACT_ALIAS_META);
  assert.equal(ask().length, 17);
  w.raw.prepare("UPDATE run_activity SET ts = ?, ts_ms = ?").run(at(90_000), T0 + 90_000);
  const before = w.reads();
  assert.equal(ask().find((row) => row.run_id === "activity")!.ts, at(90_000));
  assert.equal(w.reads(), before, "the stand-in was rebuilt without re-reading task history");
});

test("W1-T9716: the oracle audits task histories independently and drops a corrupt cache", (t) => {
  const w = rig(t, history());
  const logged: Record<string, unknown>[] = [];
  const board = w.board({ log: (_step, row) => logged.push(row) });
  board.update({ force: true });
  const sql = "UPDATE fact SET body = json_set(body, '$.n', 999) WHERE seq = 1";
  w.raw.exec(sql);
  assert.equal(board.index(board.rows()).byTask.get(IDS[0]!)![0]!.n, 0, "control: the digest cannot detect an in-place body edit");
  board.oracle();
  const cache = logged.at(-1)!.step_cache as { audit: { mismatches: string[] }; task_cache: CacheStats };
  assert.ok(cache.audit.mismatches.includes(`task:${IDS[0]}`));
  assert.equal(cache.task_cache.bytes, 0);
  assert.equal(board.index(board.rows()).byTask.get(IDS[0]!)![0]!.n, 999);
});

test("W1-T9716: the default task-cache bound is 16 MiB and an extension can outgrow it", (t) => {
  const w = rig(t, IDS.slice(0, 2).map((id) => ({ ts: at(0), step: "run.start", task_id: id, run_id: id, payload: "x".repeat(8 * 1024 * 1024) })));
  const board = w.board();
  board.update({ force: true });
  const mark = w.reads();
  board.index(board.rows()).byTask.get(IDS[1]!);
  assert.equal(w.reads(), mark, "the latest task's bucket fits and is cached");
  board.index(board.rows()).byTask.get(IDS[0]!);
  assert.equal(w.reads() - mark, 1, "two buckets exceeding 16 MiB evict the oldest");
  assert.ok(w.stats(board).bytes <= 16 * 1024 * 1024);
  board.index(board.rows()).byTask.get(IDS[0]!);
  w.append([{ ts: at(1_000), step: "run.start", task_id: IDS[0], run_id: "new", payload: "y".repeat(8 * 1024 * 1024) }]);
  board.update({ force: true });
  const after = w.reads();
  assert.equal(board.index(board.rows()).byTask.get(IDS[0]!)!.length, 2);
  assert.equal(w.reads() - after, 2, "the oversized extended bucket is read in full on its next derive");
  const stats = w.stats(board);
  assert.equal(stats.extended_rows, 1, "the outgrown bucket was actually extended before eviction");
  assert.ok(stats.bytes <= 16 * 1024 * 1024);
});
