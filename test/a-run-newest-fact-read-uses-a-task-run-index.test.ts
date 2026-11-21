/**
 * W1-T13905: the board asks the fact store for a run's newest fact time once per run activity row it ingests. The
 * store's only usable index was fact_task (task_id, seq), so one DAEMON run's MAX(ts_ms) read every DAEMON fact row:
 * 706,926 on core, 1.7 s a lookup, 84% of a steady core now build. The projector's store now carries fact_task_run
 * (task_id, run_id, seq), and the same statement reads one run's rows.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createBoardProjection, type Row } from "#src/lib/board-projection.js";
import type { Clock } from "#src/lib/clock.js";
import { createLedgerProjector, openProjectorReadModel } from "#src/lib/ledger-projector.js";
import type { Plan } from "#src/lib/plan.js";
import { acquireLease, type ReadModelDb } from "#src/lib/read-model-db.js";
import type { GitHub } from "#src/lib/status.js";
import { onReadModelClose, readModelFixtureDir } from "#test/helpers/read-model-fixture-dir.js";

const T0 = Date.parse("2026-11-20T00:00:00.000Z");
const at = (ms: number): string => new Date(ms).toISOString();
const PLAN: Plan = { tasks: [], byId: new Map() };
const GATEWAY = {
  readFailed: () => false, prByRef: () => null, findMergedByTrailer: () => null, findMergedByHeadBranch: () => [],
  listMergedHeadBranches: () => [], listOpenHeadBranches: () => [], headRefName: () => undefined, prBody: () => undefined,
} as unknown as GitHub;
/** The statement the board prepares for one run's newest fact time. */
const RUN_NEWEST = /SELECT MAX\(ts_ms\) AS ms FROM fact WHERE task_id = \? AND run_id = \?/;

const hasIndex = (db: ReadModelDb): boolean =>
  db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'index' AND name = 'fact_task_run'").get() !== undefined;

function store(t: { after: (fn: () => void) => void }) {
  const root = readModelFixtureDir(t, "run-newest-index").dir;
  const ms = T0 + 86_400_000;
  const clock: Clock = { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() };
  const ledgerDir = join(root, "core", "state");
  mkdirSync(ledgerDir, { recursive: true });
  const open = (): ReadModelDb => {
    const db = openProjectorReadModel(join(root, "home"), "core", clock);
    onReadModelClose(t, () => { try { db.close(); } catch { /* deliberate: a test may already have closed it */ } });
    return db;
  };
  return { root, clock, ledgerDir, open };
}

const history = (): Row[] => [
  ...Array.from({ length: 300 }, (_, i) => ({ ts: at(T0 + i * 1_000), step: "implement.done", task_id: "DAEMON", run_id: `DAEMON-${i % 3}`, host: "h1" })),
  { ts: at(T0 + 400_000), step: "worker.tool_lineage", task_id: "DAEMON", run_id: "DAEMON-1", host: "h1" },
  { ts: at(T0 + 100), step: "worker.tool_lineage", task_id: "DAEMON", run_id: "DAEMON-2", host: "h1" },
  { ts: at(T0 + 500_000), step: "worker.tool_lineage", task_id: "W1-T1", run_id: "only-activity", host: "h1" },
];

test("W1-T13905 criterion 1: the projector's store carries fact_task_run, and the board's newest-fact read uses it", (t) => {
  const s = store(t);
  const db = s.open();
  assert.ok(hasIndex(db), "a new store has the index");
  const got = acquireLease(db, { clock: s.clock, ttlMs: 1e12 });
  assert.ok(got.ok);
  appendFileSync(join(s.ledgerDir, "ledger.ndjson"), history().map((r) => `${JSON.stringify(r)}\n`).join(""));
  const projector = createLedgerProjector({ ledgerDir: s.ledgerDir, db, lease: got.lease, clock: s.clock });
  for (let i = 0; i < 20; i++) projector.tick();
  const plans: string[] = [];
  const watched: ReadModelDb = { ...db, exec: (sql) => db.exec(sql), meta: (k) => db.meta(k), inTransaction: () => db.inTransaction(), close: () => db.close(),
    prepare: (sql, opts) => {
      if (RUN_NEWEST.test(sql)) plans.push(...db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("DAEMON", "DAEMON-1", 1e15, ...unreadArgs(sql)).map((r) => String(r.detail)));
      return db.prepare(sql, opts);
    } };
  const board = createBoardProjection({ db: watched, ledgerPath: join(s.ledgerDir, "ledger.ndjson"), clock: s.clock, readPlan: () => PLAN,
    github: GATEWAY, githubGeneration: () => "g1", readCreditStore: () => ({}), readCreditOverrideFile: () => "" });
  while (!board.update({ force: true }).caughtUp);
  assert.ok(plans.length > 0, "the board prepared its newest-fact statement");
  assert.ok(plans.some((p) => p.includes("fact_task_run")), `the plan uses fact_task_run: ${plans.join(" / ")}`);
});

/** The statement's NOT IN (...) placeholders after its first three parameters, filled with steps no row has. */
function unreadArgs(sql: string): string[] {
  const placeholders = (sql.match(/\?/g) ?? []).length;
  return Array.from({ length: Math.max(0, placeholders - 3) }, (_, i) => `none-${i}`);
}

test("W1-T13905 criterion 2: a store made before the index gains it when the projector opens it", (t) => {
  const s = store(t);
  const first = s.open();
  first.exec("DROP INDEX fact_task_run");
  assert.ok(!hasIndex(first));
  first.close();
  assert.ok(hasIndex(s.open()), "reopening the store builds the index");
});

test("W1-T13905 criterion 3: invariant:same-answer — the newest-fact read answers the same with and without the index", (t) => {
  const s = store(t);
  const db = s.open();
  const got = acquireLease(db, { clock: s.clock, ttlMs: 1e12 });
  assert.ok(got.ok);
  appendFileSync(join(s.ledgerDir, "ledger.ndjson"), history().map((r) => `${JSON.stringify(r)}\n`).join(""));
  const projector = createLedgerProjector({ ledgerDir: s.ledgerDir, db, lease: got.lease, clock: s.clock });
  for (let i = 0; i < 20; i++) projector.tick();
  const sql = "SELECT MAX(ts_ms) AS ms FROM fact WHERE task_id = ? AND run_id = ? AND seq <= ? AND json_type(body, '$.task_id') = 'text'";
  const runs: Array<[string, string, number]> = [["DAEMON", "DAEMON-0", 1e15], ["DAEMON", "DAEMON-1", 1e15], ["DAEMON", "DAEMON-2", 150],
    ["W1-T1", "only-activity", 1e15], ["DAEMON", "missing", 1e15]];
  const answers = () => runs.map(([task, run, upTo]) => db.prepare(sql).get(task, run, upTo)?.ms ?? null);
  const indexed = answers();
  db.exec("DROP INDEX fact_task_run");
  assert.deepEqual(answers(), indexed);
  assert.ok(indexed.filter((v) => v !== null).length >= 3, "the comparison covers runs with facts");
});
