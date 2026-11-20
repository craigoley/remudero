/**
 * W1-T13905: each run activity row the board ingested asked the store for its run's newest fact time. The only index
 * is (task_id, seq), so a DAEMON run's MAX(ts_ms) scanned all of DAEMON's fact rows: 706,926 on core, 1.7 s a row,
 * and 84% of a steady core now build. The board keeps the per-run newest fact time its cold load builds, extends it
 * from the rows it ingests, and rebuilds it in one grouped read when the store drops rows under it.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BOARD_RUN_ACTIVITY_STEP, createBoardProjection, type BoardProjection, type Row } from "#src/lib/board-projection.js";
import type { Clock } from "#src/lib/clock.js";
import { createLedgerProjector, openProjectorReadModel } from "#src/lib/ledger-projector.js";
import { changedActivityByTask } from "#src/lib/now-view.js";
import type { Plan, Task } from "#src/lib/plan.js";
import { acquireLease, type ReadModelDb, type ReadModelStatement } from "#src/lib/read-model-db.js";
import { WORKER_ACTIVITY_STAND_IN_STEP, type GitHub } from "#src/lib/status.js";
import { onReadModelClose, readModelFixtureDir } from "#test/helpers/read-model-fixture-dir.js";

const T0 = Date.parse("2026-11-20T00:00:00.000Z");
const at = (ms: number): string => new Date(ms).toISOString();
const task = (id: string): Task => ({ id, title: id, repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 });
const PLAN: Plan = { tasks: [task("W1-T1")], byId: new Map([["W1-T1", task("W1-T1")]]) };
const GATEWAY = {
  readFailed: () => false, prByRef: () => null, findMergedByTrailer: () => null, findMergedByHeadBranch: () => [],
  listMergedHeadBranches: () => [], listOpenHeadBranches: () => [], headRefName: () => undefined, prBody: () => undefined,
  issueByUrl: () => null,
} as unknown as GitHub;
/** A fact step the board reads, and a step the projector keeps only as run activity. */
const FACT = "implement.done";
const ACTIVITY = "worker.tool_lineage";
const OLD = T0 - 14 * 86_400_000;
const fact = (ms: number, taskId: string, runId: string): Row => ({ ts: at(ms), step: FACT, task_id: taskId, run_id: runId, host: "h1" });
const activity = (ms: number, taskId: string, runId: string): Row => ({ ts: at(ms), step: ACTIVITY, task_id: taskId, run_id: runId, host: "h1" });

/** Counts executions of the statements whose SQL matches `pattern`. */
function counting(db: ReadModelDb, patterns: Record<string, RegExp>): { db: ReadModelDb; count: Record<string, number> } {
  const count = Object.fromEntries(Object.keys(patterns).map((k) => [k, 0]));
  return {
    count,
    db: { ...db, exec: (sql) => db.exec(sql), meta: (key) => db.meta(key), inTransaction: () => db.inTransaction(), close: () => db.close(),
      prepare: (sql, opts) => {
        const statement = db.prepare(sql, opts);
        const names = Object.entries(patterns).filter(([, re]) => re.test(sql)).map(([k]) => k);
        if (names.length === 0) return statement;
        const note = (): void => { for (const k of names) count[k]!++; };
        const counted: ReadModelStatement = {
          run: (...p) => statement.run(...p),
          get: (...p) => { note(); return statement.get(...p); },
          all: (...p) => { note(); return statement.all(...p); },
          iterate: (...p) => { note(); return statement.iterate(...p); },
        };
        return counted;
      } },
  };
}

function world(t: { after: (fn: () => void) => void }, rows: Row[]) {
  const root = readModelFixtureDir(t, "run-activity-newest-fact").dir;
  const ms = T0 + 86_400_000;
  const clock: Clock = { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() };
  const ledgerDir = join(root, "core", "state");
  mkdirSync(ledgerDir, { recursive: true });
  const raw = openProjectorReadModel(join(root, "home"), "core", clock);
  onReadModelClose(t, () => raw.close());
  const got = acquireLease(raw, { clock, ttlMs: 1e12 });
  assert.ok(got.ok);
  const projector = createLedgerProjector({ ledgerDir, db: raw, lease: got.lease, clock });
  const append = (more: Row[]): void => {
    appendFileSync(join(ledgerDir, "ledger.ndjson"), more.map((r) => `${JSON.stringify(r)}\n`).join(""));
    for (let i = 0; i < 50; i++) projector.tick();
  };
  append(rows);
  const board = (db: ReadModelDb = raw, onIngest?: (rows: readonly Row[]) => void): BoardProjection => createBoardProjection({
    db, ledgerPath: join(ledgerDir, "ledger.ndjson"), clock, readPlan: () => PLAN, github: GATEWAY, githubGeneration: () => "g1",
    readCreditStore: () => ({}), readCreditOverrideFile: () => "", onIngest,
  });
  const caughtUp = (b: BoardProjection): BoardProjection => { while (!b.update({ force: true }).caughtUp); return b; };
  return { raw, append, board, caughtUp };
}

/** The board's run activity stand-ins, as task|run@ts, sorted. */
const standIns = (b: BoardProjection): string[] =>
  b.rows().filter((r) => r.step === BOARD_RUN_ACTIVITY_STEP).map((r) => `${String(r.task_id)}|${String(r.run_id)}@${String(r.ts)}`).sort();

const seed = (): Row[] => [
  ...Array.from({ length: 400 }, (_, i) => fact(T0 + i * 1_000, "DAEMON", `DAEMON-${i % 4}`)),
  fact(T0 + 1_000_000, "W1-T1", "r1"), activity(T0 + 1_100_000, "W1-T1", "r1"), // activity after the run's last fact: a stand-in
  fact(T0 + 1_300_000, "W1-T1", "r2"), activity(T0 + 1_200_000, "W1-T1", "r2"), // activity before it: none
];

test("W1-T13905 criterion 1: after the cold load, ingesting run activity asks the store for no run's newest fact", (t) => {
  const w = world(t, seed());
  const counted = counting(w.raw, { perRun: /SELECT MAX\(ts_ms\) AS ms FROM fact WHERE task_id = \? AND run_id = \?/ });
  const board = w.caughtUp(w.board(counted.db));
  const earlier = board.index(board.rows());
  w.append([activity(T0 + 2_000_000, "DAEMON", "DAEMON-1"), activity(T0 + 2_000_500, "DAEMON", "DAEMON-9"),
    fact(T0 + 2_001_000, "W1-T1", "r3"), activity(T0 + 2_002_000, "W1-T1", "r3"), fact(T0 + 2_003_000, "W1-T1", "r1")]);
  w.caughtUp(board);
  const activityAt = (index: typeof earlier) => {
    assert.ok(index.byTaskSteps);
    return index.byTaskSteps.get("W1-T1", [BOARD_RUN_ACTIVITY_STEP]).map((r) => r.run_id);
  };
  assert.deepEqual(activityAt(board.index(board.rows())), ["r3"]);
  assert.equal(counted.count.perRun, 0, "no per-run MAX(ts_ms) read");
  assert.ok(activityAt(earlier).includes("r1"), "the older index still compares activity against facts at its own sequence");
  assert.ok(counted.count.perRun! > 0, "the SQL counter sees the older fact lookup");
  assert.ok(standIns(board).includes(`DAEMON|DAEMON-1@${at(T0 + 2_000_000)}`), "the run activity still stands in");
});

test("W1-T13905 criterion 2: invariant:same-stand-ins — an extended board holds the run activity stand-ins a fresh cold load holds", (t) => {
  const w = world(t, seed());
  const board = w.caughtUp(w.board());
  assert.deepEqual(standIns(board), standIns(w.caughtUp(w.board())));
  for (let round = 0; round < 3; round++) {
    const base = T0 + 3_000_000 + round * 100_000;
    w.append([
      activity(base, "W1-T1", "r1"), // newer activity on a run with a stand-in
      fact(base + 1_000, "W1-T1", "r1"), // then a newer fact withdraws it
      activity(base + 2_000, "W1-T1", `new-${round}`), // a run with no fact at all
      fact(base + 3_000, "DAEMON", "DAEMON-2"), activity(base + 2_500, "DAEMON", "DAEMON-2"), // activity older than a new fact
      activity(base + 4_000, "DAEMON", "DAEMON-3"),
    ]);
    w.caughtUp(board);
    const expected = standIns(w.caughtUp(w.board()));
    assert.deepEqual(standIns(board), expected, `round ${round}`);
    assert.ok(expected.length >= 2, "the comparison covers stand-ins");
  }
});

test("W1-T13905 criterion 2: tied activity keeps cold-load precedence across fact appends", (t) => {
  const w = world(t, [activity(OLD, "W1-T1", "backup"), activity(OLD, "W1-T1", "newest")]);
  const board = w.caughtUp(w.board());
  assert.deepEqual(standIns(board), [`W1-T1|newest@${at(OLD)}`]);

  w.append([fact(OLD, "W1-T1", "different-run")]);
  w.caughtUp(board);
  assert.deepEqual(standIns(board), standIns(w.caughtUp(w.board())), "a tied fact from another run leaves the winner in place");

  w.append([fact(OLD, "W1-T1", "newest")]);
  w.caughtUp(board);
  const fresh = standIns(w.caughtUp(w.board()));
  assert.deepEqual(fresh, [`W1-T1|backup@${at(OLD)}`]);
  assert.deepEqual(standIns(board), fresh, "a tied fact from the winning run lets the other activity stand in");
});

test("W1-T13905 criterion 2: strictly newer sweep repeats restore the best remaining changed activity", (t) => {
  const ids = ["W1-T1", "W1-T2", "W1-T3"];
  const disposition = (ms: number, id: string, pr: number): Row => ({
    ts: at(ms), step: "sweep.disposed", task_id: id, pr_number: pr, disposition: "waiting", host: "h1",
  });
  const w = world(t, [
    ...ids.flatMap((id, i) => [disposition(OLD, id, i + 1), activity(OLD + 1_000, id, "backup"), activity(OLD + 3_000, id, "winner")]),
    { ts: at(OLD + 2_000), step: FACT, task_id: "W1-T2", host: "h1" },
    { ts: at(OLD + 2_000), step: "worker.activity", task_id: "W1-T3", run_id: "worker", event_kind: "working", host: "h1" },
    fact(OLD + 2_000, "W1-T3", "worker"),
  ]);
  const counted = counting(w.raw, { perRun: /SELECT MAX\(ts_ms\) AS ms FROM fact WHERE task_id = \? AND run_id = \?/ });
  const board = w.caughtUp(w.board(counted.db));
  assert.deepEqual(standIns(board), ids.map((id) => `${id}|winner@${at(OLD + 3_000)}`));

  w.append(ids.map((id, i) => ({ ...disposition(OLD + 4_000, id, i + 1), run_id: "winner" })));
  w.caughtUp(board);
  const fresh = w.caughtUp(w.board());
  assert.deepEqual(standIns(fresh), [`W1-T1|backup@${at(OLD + 1_000)}`]);
  assert.deepEqual(standIns(board), standIns(fresh));
  assert.deepEqual(changedActivityByTask(board.rows()), changedActivityByTask(fresh.rows()));
  assert.ok(board.rows().some((r) => r.step === WORKER_ACTIVITY_STAND_IN_STEP && r.task_id === "W1-T3"));
  assert.equal(counted.count.perRun, 0, "recovery uses the in-memory fact times");
});

test("W1-T13905 criterion 2: a fact appended after a detected rewind can reuse a sequence", (t) => {
  const w = world(t, [
    fact(T0, "W1-T1", "other"), activity(T0 + 1_000, "W1-T1", "target"),
    { ts: at(T0 + 2_000), step: "daemon.boot", host: "h1" },
  ]);
  const counted = counting(w.raw, { grouped: /GROUP BY task_id, run_id/ });
  const delivered: Row[] = [];
  const board = w.caughtUp(w.board(counted.db, (rows) => delivered.push(...rows)));
  board.index(board.rows()).byStep.get(FACT);
  const max = (): number => Number(w.raw.prepare("SELECT MAX(seq) AS seq FROM fact").get()?.seq);
  const previous = max();
  assert.equal(w.raw.prepare("DELETE FROM fact WHERE seq = ?").run(previous).changes, 1);
  board.index(board.rows());
  assert.equal(counted.count.grouped, 1, "the board detects the rewind before the sequence is reused");
  assert.ok(standIns(board).includes(`W1-T1|target@${at(T0 + 1_000)}`));

  w.append([fact(T0 + 1_000, "W1-T1", "target")]);
  assert.equal(max(), previous, "the new fact reused the old tail sequence");
  w.caughtUp(board);
  const fresh = standIns(w.caughtUp(w.board()));
  assert.deepEqual(fresh, []);
  assert.deepEqual(standIns(board), fresh);
  assert.deepEqual(delivered.filter((row) => row.step === FACT).map((row) => row.run_id), ["other", "target"]);
  assert.equal(counted.count.grouped, 1, "the replacement fact was ingested without another rebuild");
});

test("W1-T13905 criterion 3: a fact row dropped under the board rebuilds the newest fact times in one grouped read", (t) => {
  const w = world(t, seed());
  const counted = counting(w.raw, { grouped: /GROUP BY task_id, run_id/ });
  const board = w.caughtUp(w.board(counted.db));
  board.index(board.rows()).byStep.get(FACT); // the step cache holds FACT, so a dropped FACT row is noticed
  const r2 = `W1-T1|r2@${at(T0 + 1_300_000)}`;
  assert.ok(!standIns(board).includes(r2), "r2's newest fact suppresses its activity at the same time");
  assert.equal(counted.count.grouped, 0);
  const newest = w.raw.prepare(`SELECT MAX(seq) AS seq FROM fact WHERE step = ? AND task_id = 'W1-T1' AND run_id = 'r2'`).get(FACT)!;
  assert.equal(w.raw.prepare("DELETE FROM fact WHERE seq = ?").run(newest.seq).changes, 1);
  board.index(board.rows());
  assert.equal(counted.count.grouped, 1, "one grouped read after the drop");
  const fresh = standIns(w.caughtUp(w.board()));
  assert.ok(fresh.includes(r2), "the existing run activity now stands in on a cold load");
  assert.deepEqual(standIns(board), fresh);
});

test("W1-T13905 criterion 3: removing a cached task-only fact restores an older stand-in", (t) => {
  const w = world(t, [
    activity(OLD, "W1-T1", "older"),
    { ts: at(OLD + 1_000), step: FACT, task_id: "W1-T1", host: "h1" },
    fact(T0, "W1-T2", "tail"),
  ]);
  const counted = counting(w.raw, { grouped: /GROUP BY task_id, run_id/ });
  const board = w.caughtUp(w.board(counted.db));
  board.index(board.rows()).byStep.get(FACT);
  assert.deepEqual(standIns(board), [], "the newer task-only fact initially holds the task's slot");
  assert.deepEqual(board.update({ force: true }).rederived, [], "the unchanged task projection is reused");
  assert.equal(counted.count.grouped, 0);

  assert.equal(w.raw.prepare("DELETE FROM fact WHERE task_id = ? AND run_id IS NULL").run("W1-T1").changes, 1);
  const update = board.update({ force: true });
  assert.deepEqual(update.rederived, ["W1-T1"], "the update re-derives the task with its rebuilt stamp");
  assert.equal(counted.count.grouped, 1, "one grouped read after the deletion below the tail");
  const fresh = standIns(w.caughtUp(w.board()));
  assert.deepEqual(fresh, [`W1-T1|older@${at(OLD)}`]);
  assert.deepEqual(standIns(board), fresh);
});
