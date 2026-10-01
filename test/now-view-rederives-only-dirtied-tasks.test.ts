import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BOARD_PROJECTION_DDL } from "../src/lib/board-projection.js";
import { boardOpenSnapshotPath, createBoardSnapshotCache } from "../src/lib/board-snapshot-cache.js";
import type { Clock } from "../src/lib/clock.js";
import { createLedgerProjector, openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { createNowView, type NowViewContext } from "../src/lib/now-view.js";
import type { BoardPrRest } from "../src/lib/open-prs-rest.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { acquireLease, type ReadModelLease } from "../src/lib/read-model-db.js";
import { makeTempDir } from "../src/lib/tmp.js";

const T0 = Date.parse("2026-10-01T08:00:00.000Z");
const IDS = ["W1-T1", "W1-T2", "W1-T3", "W1-T4", "W1-T5"];

type TestCtx = { after: (fn: () => void) => void };

function task(id: string): Task {
  return { id, title: `task ${id}`, repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 };
}

const PLAN: Plan = { tasks: IDS.map(task), byId: new Map(IDS.map((id) => [id, task(id)])) };

function openPr(number: number, taskId: string): BoardPrRest {
  return {
    number, url: `https://github.com/o/r/pull/${number}`, state: "OPEN", headRefName: `run-${taskId}-1790000000000`, headRefOid: `sha-${number}`,
    body: "work in progress", autoMergeRequest: null, title: `open ${number}`, updatedAt: "2026-10-01T07:00:00Z",
  };
}

/**
 * One instance whose ledger names every plan task, its store behind a lease, and the task ids each
 * build wrote to `task_projection`: a temp trigger on the same connection sees every write, so a
 * task the board re-derived is a task it wrote, and one it reused is not.
 */
function world(t: TestCtx) {
  const root = makeTempDir("now-dirty");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let ms = T0;
  const clock: Clock = { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() };
  const ledgerDir = join(root, "core", "state");
  mkdirSync(ledgerDir, { recursive: true });
  const db = openProjectorReadModel(join(root, "home"), "core", clock);
  t.after(() => db.close());
  const got = acquireLease(db, { clock, ttlMs: 1e12 });
  assert.ok(got.ok);
  const lease: ReadModelLease = got.lease;
  const projector = createLedgerProjector({ ledgerDir, db, lease, clock });
  const append = (taskId: string, n: number): void => {
    appendFileSync(join(ledgerDir, "ledger.ndjson"), `${JSON.stringify({ ts: clock.iso(), host: "h1", step: "worker.assignment", task_id: taskId, run_id: `r-${taskId}-${n}` })}\n`);
    projector.tick();
  };
  for (const id of IDS) append(id, 0);
  const snapshot = createBoardSnapshotCache(join(root, "core"), "o", "r");
  const resave = (rows: BoardPrRest[]): void => {
    assert.ok(snapshot.commitOpen!(rows, ms), "the gateway re-saved its open snapshot");
    const path = boardOpenSnapshotPath(join(root, "core"), "o", "r");
    utimesSync(path, new Date(ms), new Date(ms));
  };
  resave([openPr(9001, "W1-T1")]);
  db.exec(BOARD_PROJECTION_DDL);
  db.exec(`CREATE TEMP TABLE wrote(task_id TEXT);
    CREATE TEMP TRIGGER wrote_insert AFTER INSERT ON task_projection BEGIN INSERT INTO wrote VALUES(new.task_id); END;
    CREATE TEMP TRIGGER wrote_update AFTER UPDATE ON task_projection BEGIN INSERT INTO wrote VALUES(new.task_id); END;`);
  const wrote = (): string[] => {
    const ids = db.prepare("SELECT task_id FROM wrote ORDER BY task_id").all().map((r) => String(r.task_id));
    db.exec("DELETE FROM wrote");
    return ids;
  };
  const view = () => createNowView({ instances: [{ name: "core", ledgerDir, repo: "o/r" }], clock, readPlan: () => PLAN, hostProbe: { rateLimit: () => 1, diskFree: () => 1, readLive: () => [] }, planBehind: () => ({ commits: 0 }) });
  const ctx = (): NowViewContext => ({
    now: ms, switches: { views: { now: "shadow" } },
    instances: [{ state: { instance: "core", generation: Number(db.meta("generation")), lease: "held", failures: 0, tickedAt: ms, newestTs: null }, db, lease }],
  });
  return { db, view, ctx, append, resave, wrote, advance: (by: number) => void (ms += by), snapshotPath: boardOpenSnapshotPath(join(root, "core"), "o", "r") };
}

test("a re-saved github snapshot keeps the now board and re-derives only the dirtied task", (t) => {
  const w = world(t);
  const view = w.view();
  assert.equal(view.materialize(w.ctx()).length, 1);
  assert.deepEqual(w.wrote(), IDS, "the first build derives every task");

  // The gateway re-saves an unchanged open set every minute; only W1-T3 gained a row since the last build.
  w.advance(5_000);
  const before = statSync(w.snapshotPath).mtimeMs;
  w.resave([openPr(9001, "W1-T1")]);
  assert.notEqual(statSync(w.snapshotPath).mtimeMs, before, "the snapshot file moved");
  w.append("W1-T3", 1);
  assert.equal(view.materialize(w.ctx()).length, 1);
  assert.deepEqual(w.wrote(), ["W1-T3"], "only the dirtied task is re-derived");

  // A snapshot whose content changed may move any task: every one is re-derived.
  w.advance(5_000);
  w.resave([openPr(9001, "W1-T1"), openPr(9002, "W1-T4")]);
  assert.equal(view.materialize(w.ctx()).length, 1);
  assert.deepEqual(w.wrote(), IDS);
});

test("a restarted now view reuses the board projection its predecessor persisted", (t) => {
  const w = world(t);
  w.view().materialize(w.ctx());
  assert.deepEqual(w.wrote(), IDS);
  assert.equal(Number(w.db.prepare("SELECT count(*) AS n FROM task_projection").get()?.n), IDS.length, "the projection was persisted behind the lease");

  w.advance(1_000);
  w.append("W1-T2", 1);
  const restarted = w.view();
  assert.equal(restarted.materialize(w.ctx()).length, 1);
  assert.deepEqual(w.wrote(), ["W1-T2"], "a restart re-derives only what moved while it was down");
});
