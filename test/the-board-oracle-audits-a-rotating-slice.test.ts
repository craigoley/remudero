/**
 * W1-T9718: the board oracle re-derived every plan task each BOARD_ORACLE_INTERVAL_MS, twice more on a mismatch: about
 * a full re-derive's read per pass (~1.2 GB on a production-sized store). A pass now audits one slice of the plan's
 * tasks (a stable hash of the id), the slices in turn, plus every task it healed within the recurrence window; the
 * other tasks are handed in as held. The default is six slices (operator ruling 2026-10-17); one audits every task.
 * Each test counts what the fact store was asked for by task, beside what the oracle reports, so neither is taken on
 * the oracle's word.
 */
import assert from "node:assert/strict";
import { appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  BOARD_ORACLE_INTERVAL_MS,
  BOARD_ORACLE_RECURRENCE_MS,
  BOARD_ORACLE_SLICES,
  boardOracleSliceOf,
  createBoardProjection,
  type BoardOracleResult,
  type BoardProjection,
  type BoardProjectionOptions,
} from "../src/lib/board-projection.js";
import type { Clock } from "../src/lib/clock.js";
import { createLedgerProjector, openProjectorReadModel } from "../src/lib/ledger-projector.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { acquireLease, type ReadModelDb, type ReadModelLease, type ReadModelStatement } from "../src/lib/read-model-db.js";
import type { GitHub } from "../src/lib/status.js";
import { makeTempDir } from "../src/lib/tmp.js";

type TestCtx = { after: (fn: () => void) => void };

const T0 = Date.parse("2026-10-16T12:00:00.000Z");
const IDS = Array.from({ length: 40 }, (_, i) => `W1-T${i + 1}`);
const task = (id: string): Task => ({ id, title: `task ${id}`, repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 });
const PLAN: Plan = { tasks: IDS.map(task), byId: new Map(IDS.map((id) => [id, task(id)])) };
const GITHUB = {
  readFailed: () => false, prByRef: () => null, findMergedByTrailer: () => null, findMergedByHeadBranch: () => [],
  listMergedHeadBranches: () => [], listOpenHeadBranches: () => [], headRefName: () => undefined, prBody: () => undefined,
  issueByUrl: () => ({ state: "OPEN", title: "issue" }),
} as unknown as GitHub;

interface Rig {
  db: ReadModelDb;
  lease: ReadModelLease;
  set(ms: number): void;
  /** The task ids the fact store was asked for by task since the last call, sorted. */
  askedTasks(): string[];
  /** A projection over the store, as serve opens one: a second call is a restart (it reads what the first persisted). */
  board(over?: Partial<BoardProjectionOptions>): BoardProjection;
  /** Rewrites `id`'s persisted projection under its own stamp, so the next restart holds a drifted one. */
  drift(id: string): void;
}

function rig(t: TestCtx): Rig {
  const dir = makeTempDir("board-oracle-slice");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = T0;
  const clock: Clock = { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() };
  const raw = openProjectorReadModel(dir, "core", clock);
  t.after(() => raw.close());
  const got = acquireLease(raw, { clock, ttlMs: 1e12 });
  assert.ok(got.ok);
  const lease = got.lease;
  const projector = createLedgerProjector({ ledgerDir: dir, db: raw, lease, clock });
  // Every task has a history: a dispatch, a failed verdict, and a pr.opened, so each derive reads its own bucket.
  const rows = IDS.flatMap((id, k) => [
    { ts: new Date(T0 - 3_600_000 + k * 1_000).toISOString(), step: "run.start", task_id: id, run_id: `r-${id}`, host: "h1" },
    { ts: new Date(T0 - 3_000_000 + k * 1_000).toISOString(), step: "verdict", task_id: id, run_id: `r-${id}`, verdict: "no_pr", host: "h1" },
  ]);
  appendFileSync(join(dir, "ledger.ndjson"), rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
  projector.tick();
  let asked: string[] = [];
  // The fact store as the board sees it, noting each task bucket it is asked for (`taskFacts`, by its first argument).
  const db: ReadModelDb = {
    ...raw,
    exec: (sql) => raw.exec(sql),
    meta: (key) => raw.meta(key),
    inTransaction: () => raw.inTransaction(),
    close: () => raw.close(),
    prepare: (sql, opts) => {
      const statement = raw.prepare(sql, opts);
      if (!/FROM fact WHERE task_id = \?/.test(sql)) return statement;
      const noted: ReadModelStatement = {
        run: (...params) => statement.run(...params),
        get: (...params) => statement.get(...params),
        all: (...params) => statement.all(...params),
        iterate: (...params) => {
          asked.push(String(params[0]));
          return statement.iterate(...params);
        },
      };
      return noted;
    },
  };
  return {
    db, lease,
    set: (ms) => void (now = ms),
    askedTasks: () => {
      const out = [...new Set(asked)].sort();
      asked = [];
      return out;
    },
    board: (over = {}) => createBoardProjection({
      db, lease, ledgerPath: join(dir, "ledger.ndjson"), clock, readPlan: () => PLAN, github: GITHUB, githubGeneration: () => "g1",
      readCreditStore: () => ({}), readCreditOverrideFile: () => "", ...over,
    }),
    drift: (id) => {
      const json = String(raw.prepare("SELECT json FROM task_projection WHERE task_id = ?").get(id)?.json);
      raw.prepare("UPDATE task_projection SET json = ? WHERE task_id = ?").run(JSON.stringify({ ...JSON.parse(json), status: "drifted" }), id);
    },
  };
}

const sliceOf = (k: number, of: number): string[] => IDS.filter((id) => boardOracleSliceOf(id, of) === k).sort();
const oracleRows = (logged: Array<{ step: string; extra: Record<string, unknown> }>): Array<Record<string, unknown>> =>
  logged.filter((l) => l.step === "read_model.board_oracle").map((l) => l.extra);

test("W1-T9718: N oracle passes audit every task once and each projects only its slice", (t) => {
  const r = rig(t);
  const logged: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const board = r.board({ oracleSlices: 4, log: (step, extra) => void logged.push({ step, extra }) });
  assert.equal(board.update().full, true, "the first derive has nothing to reuse");
  assert.equal(r.askedTasks().length, IDS.length, "control: a full derive asks the store for every task");
  const seen: string[] = [];
  for (let pass = 0; pass < 4; pass++) {
    const result = board.oracle();
    const want = sliceOf(pass, 4);
    assert.ok(want.length > 0 && want.length < IDS.length, `slice ${pass} is a proper part of the plan`);
    assert.deepEqual(result.slice, { index: pass, of: 4, audited: want, alwaysAudited: [] }, `pass ${pass} audits its slice`);
    assert.deepEqual(r.askedTasks(), want, `pass ${pass} reads only its slice's tasks from the store`);
    assert.equal(result.compared, want.length, "and compares only them");
    assert.equal(result.outcome, "agree");
    seen.push(...result.slice.audited);
  }
  assert.deepEqual([...seen].sort(), [...IDS].sort(), "four passes audit every plan task exactly once");
  assert.equal(new Set(seen).size, seen.length, "and none twice");
  const rows = oracleRows(logged);
  assert.equal(rows.length, 4);
  rows.forEach((row, pass) => {
    assert.deepEqual(row.slice, { index: pass, of: 4, audited: sliceOf(pass, 4).length, always_audited: 0 }, `row ${pass} names its slice`);
    const read = row.read as { projections: number; rows: number; bytes: number };
    assert.equal(read.projections, 1, "an agreeing pass projects once");
    assert.ok(read.rows > 0 && read.bytes > 0, "and says what it read");
  });
  // The periodic pass (update, once the interval is up) continues the rotation: a fifth pass wraps to slice 0.
  r.set(T0 + BOARD_ORACLE_INTERVAL_MS);
  const periodic = board.update().oracle;
  assert.deepEqual(periodic?.slice.audited, sliceOf(0, 4), "the periodic pass audits the next slice");
  assert.equal(periodic?.slice.index, 0);
  // A restart resumes the rotation from the store rather than starting at slice 0 again.
  r.askedTasks();
  const restarted = r.board({ oracleSlices: 4 }).oracle();
  assert.equal(restarted.slice.index, 1, "a restart resumes the rotation where it stood");
  assert.deepEqual(r.askedTasks(), sliceOf(1, 4));
});

test("W1-T9718: a drift is healed within N passes and a recently healed task every pass", (t) => {
  const r = rig(t);
  r.board({ oracleSlices: 4 }).update();
  const victim = "W1-T7";
  const home = boardOracleSliceOf(victim, 4);
  const other = IDS.find((id) => id !== victim && boardOracleSliceOf(id, 4) !== (home + 1) % 4)!;
  r.drift(victim);
  let board = r.board({ oracleSlices: 4 });
  assert.equal(board.projections().get(victim)?.status, "drifted", "control: the restart holds the drifted projection");
  let healedAt: number | undefined;
  for (let pass = 0; pass < 4 && healedAt === undefined; pass++) {
    const result = board.oracle();
    if (result.mismatches.some((m) => m.taskId === victim)) {
      assert.equal(result.outcome, "healed");
      healedAt = pass;
    } else assert.equal(board.projections().get(victim)?.status, "drifted", `pass ${pass} is outside the victim's slice`);
  }
  assert.equal(healedAt, home, "the drift is healed on the pass whose slice holds it, within N passes");
  assert.notEqual(board.projections().get(victim)?.status, "drifted", "and the heal holds");
  // The same task drifts again, and so does a task in neither the healed set nor the next slice; a restart holds both.
  r.drift(victim);
  r.drift(other);
  board = r.board({ oracleSlices: 4 });
  const next = board.oracle();
  assert.equal(next.slice.index, (home + 1) % 4, "the next pass is the next slice");
  assert.ok(!sliceOf(next.slice.index, 4).includes(victim), "control: the victim is outside it");
  assert.deepEqual(next.slice.alwaysAudited, [victim], "a task healed within the recurrence window is audited every pass");
  assert.ok(next.slice.audited.includes(victim));
  assert.deepEqual(next.mismatches.map((m) => m.taskId), [victim], "its drift is found on the very next pass; the other waits for its slice");
  assert.equal(next.outcome, "escalated", "a drift again within 24 h of its heal escalates");
  let found: BoardOracleResult | undefined;
  for (let pass = 0; pass < 4 && !found; pass++) {
    const result = board.oracle();
    if (result.mismatches.some((m) => m.taskId === other)) found = result;
  }
  assert.ok(found, "the other drift is found within N passes too");
  // A day after the heal the task drops back to its own slice, and the store forgets the heal.
  r.set(T0 + BOARD_ORACLE_RECURRENCE_MS + 1);
  const dayLater = r.board({ oracleSlices: 4 }).oracle();
  assert.deepEqual(dayLater.slice.alwaysAudited, [], "a heal older than the window no longer pins the task");
  const pinned = r.db.prepare("SELECT task_id FROM board_oracle_heal").all().map((row) => String(row.task_id));
  assert.ok(!pinned.includes(victim), "and the expired heal is removed from the store");
});

test("operator ruling 2026-10-17: by default six oracle passes audit every task, each about a sixth plus the healed", (t) => {
  assert.equal(BOARD_ORACLE_SLICES, 6, "the operator ruled six slices: every task hourly at 10-minute passes");
  const r = rig(t);
  const logged: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const board = r.board({ log: (step, extra) => void logged.push({ step, extra }) });
  board.update();
  r.askedTasks();
  const seen: string[] = [];
  for (let pass = 0; pass < 6; pass++) {
    const result = board.oracle();
    const want = sliceOf(pass, 6);
    assert.equal(result.slice.of, 6, `pass ${pass} is one of six slices without any option`);
    assert.ok(want.length > 0 && want.length <= Math.ceil(IDS.length / 3), `slice ${pass} is about a sixth of the plan (${want.length})`);
    assert.deepEqual(result.slice.audited, want, `pass ${pass} audits only its slice`);
    assert.deepEqual(r.askedTasks(), want, `pass ${pass} reads only its slice's tasks from the store`);
    seen.push(...result.slice.audited);
  }
  assert.deepEqual([...seen].sort(), [...IDS].sort(), "six default passes audit every plan task exactly once");
  // The ledger row production reads to verify the ruling names each slice of six and what it audited.
  assert.deepEqual(oracleRows(logged).map((row) => row.slice), [0, 1, 2, 3, 4, 5].map((k) => ({ index: k, of: 6, audited: sliceOf(k, 6).length, always_audited: 0 })));
  // A drift is healed on its slice's pass; from then on that task rides along with every other slice.
  const victim = "W1-T7";
  r.drift(victim);
  const restarted = r.board();
  let healed: BoardOracleResult | undefined;
  for (let pass = 0; pass < 6 && !healed; pass++) {
    const result = restarted.oracle();
    if (result.outcome === "healed") healed = result;
  }
  assert.deepEqual(healed?.mismatches.map((m) => m.taskId), [victim], "the drift is found within six default passes");
  const next = restarted.oracle();
  assert.notEqual(next.slice.index, boardOracleSliceOf(victim, 6), "control: the next pass is another slice");
  assert.deepEqual(next.slice.alwaysAudited, [victim], "the healed task is audited on the next pass too");
  assert.deepEqual(next.slice.audited, [...sliceOf(next.slice.index, 6), victim].sort(), "beside that slice's own tasks");
});

test("W1-T9718: with one slice the oracle compares every task as before", (t) => {
  const r = rig(t);
  const logged: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const board = r.board({ oracleSlices: 1, log: (step, extra) => void logged.push({ step, extra }) });
  board.update();
  r.askedTasks();
  const result = board.oracle();
  assert.equal(result.compared, IDS.length, "every plan task is compared");
  assert.deepEqual(result.slice, { index: 0, of: 1, audited: [...IDS].sort(), alwaysAudited: [] });
  assert.deepEqual(r.askedTasks(), [...IDS].sort(), "and every task's history is read");
  assert.equal(r.db.meta("board.oracle_slice"), undefined, "one slice keeps no rotation");
  // A drift anywhere is found on the very next pass, healed, and the heal's three projections are counted.
  r.drift("W1-T33");
  const restarted = r.board({ oracleSlices: 1, log: (step, extra) => void logged.push({ step, extra }) });
  const healed = restarted.oracle();
  assert.equal(healed.outcome, "healed");
  assert.deepEqual(healed.mismatches.map((m) => m.taskId), ["W1-T33"]);
  assert.equal(healed.compared, IDS.length);
  const row = oracleRows(logged).at(-1)!;
  assert.deepEqual(row.slice, { index: 0, of: 1, audited: IDS.length, always_audited: 0 });
  assert.equal((row.read as { projections: number }).projections, 3, "a heal projects three times, as before");
  // An option that is not a count of slices is the default.
  assert.equal(r.board({ oracleSlices: 0 }).oracle().slice.of, BOARD_ORACLE_SLICES);
});
