import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import { openProjectorReadModel } from "#src/lib/ledger-projector.js";
import { consistencyCheckDue, ORACLE_AGREE_INTERVAL_MS, ORACLE_DRIFT_INTERVAL_MS } from "#src/lib/read-model-consistency.js";
import { flushReadModelTransactions, type ReadModelDb } from "#src/lib/read-model-db.js";
import { makeTempDir } from "#src/lib/tmp.js";

// W1-T13617: serve's projector asks consistencyCheckDue on every tick. It read every consistency_run row to take the
// last one: 46% of the projector thread's CPU in a 30 s profile on the host on 2026-11-18. The table is never pruned:
// 5,911 to 11,714 rows per instance since 2026-10-01.

const NOW = Date.parse("2026-11-18T05:00:00Z");

function store(t: { after: (fn: () => Promise<void>) => void }): ReadModelDb {
  const dir = makeTempDir("consistency-due");
  const db = openProjectorReadModel(dir, "core", fixedClock(NOW));
  t.after(async () => {
    db.close();
    await flushReadModelTransactions();
    rmSync(dir, { recursive: true, force: true });
  });
  db.exec(`CREATE TABLE IF NOT EXISTS consistency_run(id INTEGER PRIMARY KEY, at_ms INTEGER NOT NULL,
    t0 INTEGER NOT NULL, t1 INTEGER NOT NULL, outcome TEXT NOT NULL, ledger_rows INTEGER NOT NULL, missing INTEGER NOT NULL,
    ledger_lost INTEGER NOT NULL, fact_missing INTEGER NOT NULL, fact_corrupt INTEGER NOT NULL, healed INTEGER NOT NULL, lost_fp TEXT)`);
  return db;
}

function run(db: ReadModelDb, atMs: number, outcome: string): void {
  db.prepare("INSERT INTO consistency_run(at_ms, t0, t1, outcome, ledger_rows, missing, ledger_lost, fact_missing, fact_corrupt, healed, lost_fp) VALUES(?, 0, 0, ?, 0, 0, 0, 0, 0, 0, NULL)").run(atMs, outcome);
}

/** Records every statement the due check prepares and how it reads each one. */
function recording(db: ReadModelDb): { db: ReadModelDb; reads: string[] } {
  const reads: string[] = [];
  const wrapped = new Proxy(db, {
    get(target, key) {
      if (key !== "prepare") return Reflect.get(target, key);
      return (sql: string, opts?: { bigInts?: boolean }) => {
        const statement = target.prepare(sql, opts);
        return new Proxy(statement, {
          get(s, k) {
            const value = Reflect.get(s, k);
            return typeof value === "function" ? (...args: unknown[]) => (reads.push(`${String(k)} ${sql}`), value.apply(s, args)) : value;
          },
        });
      };
    },
  });
  return { db: wrapped, reads };
}

test("W1-T13617 criterion 1: with 5,000 recorded runs, the due check reads one row, never the whole history", (t) => {
  const db = store(t);
  db.exec("BEGIN");
  for (let i = 0; i < 5_000; i++) run(db, NOW - 10 * ORACLE_AGREE_INTERVAL_MS + i, "agree");
  db.exec("COMMIT");
  const rec = recording(db);
  consistencyCheckDue(rec.db, NOW);
  assert.ok(rec.reads.length > 0, "the recorder saw the due check's reads");
  assert.deepEqual(rec.reads.filter((r) => r.startsWith("all ")), [], "no statement is read with all()");
  assert.ok(rec.reads.filter((r) => r.includes("consistency_run") && !r.includes("sqlite_master")).every((r) => /LIMIT 1/.test(r)), `every run read is limited to one row: ${rec.reads.join(" | ")}`);
});

test("W1-T13617 criterion 2: the due check still answers from the newest run by id, an hour after agreement and ten minutes after anything else", (t) => {
  const db = store(t);
  assert.equal(consistencyCheckDue(db, NOW), true, "no run recorded: due");
  run(db, NOW, "agree");
  assert.equal(consistencyCheckDue(db, NOW + ORACLE_DRIFT_INTERVAL_MS), false, "an agreement waits the hour");
  assert.equal(consistencyCheckDue(db, NOW + ORACLE_AGREE_INTERVAL_MS), true);
  run(db, NOW - ORACLE_AGREE_INTERVAL_MS, "healed");
  assert.equal(consistencyCheckDue(db, NOW - ORACLE_AGREE_INTERVAL_MS + ORACLE_DRIFT_INTERVAL_MS), true, "the newest run by id decides, not the latest at_ms");
});
