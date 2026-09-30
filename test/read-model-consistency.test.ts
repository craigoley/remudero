import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { fixedClock, type Clock } from "../src/lib/clock.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import { createLedgerProjector, openProjectorReadModel, readModelDigest } from "../src/lib/ledger-projector.js";
import { readLedgerUnionRawLinesSync, realLedgerFs, type LedgerGrepFsDeps } from "../src/lib/ledger-union.js";
import {
  ORACLE_AGREE_INTERVAL_MS,
  ORACLE_CLOSED_LAG_MS,
  ORACLE_DRIFT_INTERVAL_MS,
  READ_MODEL_CONSISTENCY_STEP,
  READ_MODEL_SELF_HEALED_STEP,
  ReadModelConsistencyError,
  consistencyCheckDue,
  ORACLE_SLICE_MS,
  advanceOracleSlice,
  factColumns,
  nextOracleSlice,
  runConsistencyCheck,
  type ConsistencyCheckOptions,
} from "../src/lib/read-model-consistency.js";
import { acquireLease, type ReadModelDb, type ReadModelLease } from "../src/lib/read-model-db.js";
import { makeTempDir } from "../src/lib/tmp.js";

const T0 = Date.parse("2026-09-30T12:00:00.000Z");
const LIVE = "ledger.ndjson";
/** The oracle's clock: an hour after the rows, so every fixture row sits inside the closed window. */
const CHECK_AT = T0 + 3_600_000;

type TestCtx = { after: (fn: () => void) => void };

function scratch(t: TestCtx, kind: string): string {
  const dir = makeTempDir(kind);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function row(ms: number, step: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts: new Date(ms).toISOString(), host: "h1", step, ...extra });
}

function text(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

function archiveName(ms: number): string {
  return `ledger.${new Date(ms).toISOString().replace(/[:.]/g, "-")}.ndjson`;
}

interface Fixture {
  rowsDir: string;
  metricPath: string;
  db: ReadModelDb;
  lease: ReadModelLease;
  lines: string[];
}

/** A ledger in all three rotation forms, projected once into a fresh read model. */
function projected(t: TestCtx): Fixture {
  const rowsDir = scratch(t, "oracle-rows");
  const lines = Array.from({ length: 12 }, (_, i) => row(T0 + i * 1_000, i % 3 === 0 ? "worker.activity" : "run.start", { task_id: `W1-T${i}`, run_id: `r${i}` }));
  const torn = `{"ts":"${new Date(T0 + 500).toISOString()}","step":"run.start",`;
  writeFileSync(join(rowsDir, `${archiveName(T0 + 4_500)}.gz`), gzipSync(text([...lines.slice(0, 5), torn])));
  writeFileSync(join(rowsDir, archiveName(T0 + 8_500)), text(lines.slice(3, 9)));
  writeFileSync(join(rowsDir, LIVE), text(lines.slice(7)));
  const clock = fixedClock(T0 + 60_000);
  const db = openProjectorReadModel(scratch(t, "oracle-state"), "core", clock);
  t.after(() => db.close());
  const got = acquireLease(db, { clock });
  if (!got.ok) throw new Error("lease");
  createLedgerProjector({ ledgerDir: rowsDir, db, lease: got.lease, clock }).tick();
  return { rowsDir, metricPath: join(scratch(t, "oracle-metric"), LIVE), db, lease: got.lease, lines };
}

function check(f: Fixture, extra: Partial<ConsistencyCheckOptions> = {}, clock: Clock = fixedClock(CHECK_AT)) {
  return runConsistencyCheck({ db: f.db, ledgerDir: f.rowsDir, instance: "core", metricLedgerPath: f.metricPath, lease: f.lease, clock, ...extra });
}

function metrics(f: Fixture): Array<Record<string, unknown>> {
  if (!existsSync(f.metricPath)) return [];
  return readFileSync(f.metricPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
}

function fakeIssues(): IssueGateway & { titles: string[] } {
  const titles: string[] = [];
  return {
    titles,
    create(title) {
      titles.push(title);
      return `https://github.com/craigoley/remudero/issues/${9000 + titles.length}`;
    },
  };
}

function digestOfCleanRebuild(t: TestCtx, rowsDir: string): string {
  const clock = fixedClock(T0 + 60_000);
  const db = openProjectorReadModel(scratch(t, "oracle-clean"), "core", clock);
  t.after(() => db.close());
  const got = acquireLease(db, { clock });
  if (!got.ok) throw new Error("lease");
  createLedgerProjector({ ledgerDir: rowsDir, db, lease: got.lease, clock }).tick();
  return readModelDigest(db);
}

test("a faithful projection agrees with every rotation form and writes one metric row", (t) => {
  const f = projected(t);
  const run = check(f);
  assert.equal(run.outcome, "agree");
  assert.equal(run.ledgerRows, 13, "twelve rows plus the torn line, each once across three forms");
  assert.deepEqual(run.forms.map((x) => [x.form, x.expected, x.read]), [["gzip", 1, 1], ["plain", 1, 1], ["live", 1, 1]]);
  assert.ok(run.forms.every((x) => x.lines > 0), "each form contributed lines");
  assert.deepEqual(run.window, { t0: CHECK_AT - ORACLE_CLOSED_LAG_MS - 7 * 86_400_000, t1: CHECK_AT - ORACLE_CLOSED_LAG_MS });
  const m = metrics(f);
  assert.equal(m.length, 1);
  assert.equal(m[0]!.step, READ_MODEL_CONSISTENCY_STEP);
  assert.equal(m[0]!.outcome, "agree");
  assert.equal(m[0]!.compared, 13);
});

test("a corrupted projection row is detected and healed on the second consecutive check", (t) => {
  const f = projected(t);
  const clean = readModelDigest(f.db);
  assert.equal(clean, digestOfCleanRebuild(t, f.rowsDir));
  f.db.exec("UPDATE fact SET step = 'verdict' WHERE seq = (SELECT min(seq) FROM fact)");
  f.db.exec("DELETE FROM fact WHERE seq = (SELECT max(seq) FROM fact)");
  f.db.exec("DELETE FROM seen WHERE ts_ms = (SELECT max(ts_ms) FROM seen)");
  assert.notEqual(readModelDigest(f.db), clean);

  const run = check(f);
  assert.equal(run.outcome, "healed");
  assert.deepEqual(run.mismatches, { missing: 1, ledgerLost: 0, factMissing: 2, factCorrupt: 1, projectionMissing: 0, projectionExtra: 0 });
  assert.equal(run.healedRows, 4);
  assert.equal(readModelDigest(f.db), clean, "the healed store equals a clean rebuild");
  assert.deepEqual(metrics(f).map((m) => [m.step, m.outcome ?? m.healed_rows]), [[READ_MODEL_CONSISTENCY_STEP, "healed"], [READ_MODEL_SELF_HEALED_STEP, 4]]);
  assert.equal(check(f, {}, fixedClock(CHECK_AT + 60_000)).outcome, "agree", "the next check agrees");
});

test("a drift that recurs within a day of a self-heal escalates", (t) => {
  const f = projected(t);
  const issues = fakeIssues();
  const escalation = { issues, ledgerPath: f.metricPath, runId: "oracle" };
  f.db.exec("UPDATE fact SET body = body || ' ' WHERE seq = (SELECT min(seq) FROM fact)");
  assert.equal(check(f, { escalation }).outcome, "healed");
  assert.equal(issues.titles.length, 0, "the first drift heals without asking anyone");
  f.db.exec("UPDATE fact SET body = body || ' ' WHERE seq = (SELECT min(seq) FROM fact)");
  const again = check(f, { escalation }, fixedClock(CHECK_AT + 3_600_000));
  assert.equal(again.outcome, "escalated");
  assert.match(again.escalationReasons.join(), /within 24 h of an earlier self-heal/);
  assert.equal(again.issueUrl, "https://github.com/craigoley/remudero/issues/9001");
  assert.equal(issues.titles.length, 1);
});

test("a drift that survives a rebuild of its window opens one needs-human issue", (t) => {
  const f = projected(t);
  const issues = fakeIssues();
  // Fault injection: every delete the heal makes is put straight back, so the drift cannot heal.
  f.db.exec("CREATE TRIGGER undo_heal AFTER DELETE ON fact BEGIN INSERT INTO fact(ts, ts_ms, step, task_id, run_id, body) VALUES(old.ts, old.ts_ms, old.step, old.task_id, old.run_id, old.body); END");
  f.db.exec("UPDATE fact SET task_id = 'W9-T9' WHERE seq = (SELECT min(seq) FROM fact)");
  const run = check(f, { escalation: { issues, ledgerPath: f.metricPath, runId: "oracle" } });
  assert.equal(run.outcome, "escalated");
  assert.match(run.escalationReasons.join(), /survived a rebuild of the window/);
  assert.equal(issues.titles.length, 1);
  assert.match(issues.titles[0]!, /read model core disagrees with its ledger/);
});

test("a missing ledger row the projector still holds escalates and is never healed away", (t) => {
  const f = projected(t);
  const issues = fakeIssues();
  const escalation = { issues, ledgerPath: f.metricPath, runId: "oracle" };
  const lost = f.lines[11]!;
  writeFileSync(join(f.rowsDir, LIVE), text(f.lines.slice(7, 11)));
  const before = readModelDigest(f.db);

  const run = check(f, { escalation });
  assert.equal(run.outcome, "escalated");
  assert.equal(run.mismatches.ledgerLost, 1);
  assert.match(run.escalationReasons.join(), /absent from every ledger rotation form/);
  assert.equal(run.healedRows, 0);
  assert.equal(readModelDigest(f.db), before, "the lost row stays in the read model as evidence");
  assert.equal(issues.titles.length, 1);
  assert.equal(run.sample.length, 1);

  const next = check(f, { escalation }, fixedClock(CHECK_AT + 60_000));
  assert.equal(next.outcome, "ledger_lost_known", "the same lost set is not escalated twice");
  assert.equal(issues.titles.length, 1);
  assert.ok(lost.length > 0);
});

test("a failed escalation of a lost row is retried on the next run", (t) => {
  const f = projected(t);
  let attempts = 0;
  const failing: IssueGateway = {
    create() {
      attempts++;
      throw new Error("gh is down");
    },
  };
  writeFileSync(join(f.rowsDir, LIVE), text(f.lines.slice(7, 11)));
  const escalation = { issues: failing, ledgerPath: f.metricPath, runId: "oracle" };
  assert.equal(check(f, { escalation }).issueUrl, null);
  assert.equal(check(f, { escalation }, fixedClock(CHECK_AT + 60_000)).outcome, "escalated");
  assert.equal(attempts, 2);
});

test("a mismatch that is gone on the recheck is transient and changes nothing", (t) => {
  const f = projected(t);
  let reads = 0;
  const lateRow = row(T0 + 20_000, "run.start", { task_id: "W1-T99" });
  const fs: LedgerGrepFsDeps = {
    ...realLedgerFs,
    readFileSync: (path) => {
      const buf = realLedgerFs.readFileSync(path);
      return path.endsWith(LIVE) && reads++ === 0 ? Buffer.concat([buf, Buffer.from(`${lateRow}\n`)]) : buf;
    },
  };
  const before = readModelDigest(f.db);
  const run = check(f, { fs });
  assert.equal(run.outcome, "transient");
  assert.equal(readModelDigest(f.db), before);
});

test("without the writer lease the oracle reports drift and heals nothing", (t) => {
  const f = projected(t);
  f.db.exec("DELETE FROM fact WHERE seq = (SELECT min(seq) FROM fact)");
  const run = runConsistencyCheck({ db: f.db, ledgerDir: f.rowsDir, instance: "core", metricLedgerPath: f.metricPath, clock: fixedClock(CHECK_AT) });
  assert.equal(run.outcome, "drift");
  assert.equal(run.healedRows, 0);
  assert.equal(run.mismatches.factMissing, 1);
});

test("the positive control fails loudly when a rotation form was unread", (t) => {
  const f = projected(t);
  const hidePlain: LedgerGrepFsDeps = { ...realLedgerFs, readdirSync: (dir) => realLedgerFs.readdirSync(dir).filter((n) => !n.endsWith(".ndjson") || n === LIVE) };
  assert.throws(() => check(f, { fs: hidePlain }), (error: unknown) => {
    assert.ok(error instanceof ReadModelConsistencyError);
    assert.match(error.message, /left the plain form unread/);
    return true;
  });
  const failGzip: LedgerGrepFsDeps = { ...realLedgerFs, gunzipSync: () => { throw new Error("corrupt gzip"); } };
  assert.throws(() => check(f, { fs: failGzip }), /left the gzip form unread/);
  const m = metrics(f);
  assert.deepEqual(m.map((x) => x.outcome), ["blind", "blind"], "each blind run still leaves its metric row");
});

test("an oracle window that reads zero ledger rows fails instead of reporting agreement", (t) => {
  const f = projected(t);
  assert.throws(() => check(f, {}, fixedClock(CHECK_AT + 30 * 86_400_000)), /read zero ledger rows/);
});

test("fact columns come from the parsed row and a torn line has none", () => {
  const isRun = (s: string) => s === "run.start";
  assert.deepEqual(factColumns(row(T0, "run.start", { task: "W1-T1" }), isRun), { step: "run.start", task: "W1-T1", run: null });
  assert.equal(factColumns('{"ts":"x","step":"run.start",', isRun), undefined);
  assert.equal(factColumns(row(T0, "worker.activity"), isRun), undefined);
  assert.equal(factColumns("[1]", isRun), undefined);
});

test("a row quarantined at ingest is not a missing fact once its window closes", (t) => {
  const rowsDir = scratch(t, "oracle-rows");
  const early = row(T0 + 600_000, "run.start", { task_id: "W1-T1" });
  writeFileSync(join(rowsDir, LIVE), text([row(T0, "run.start", { task_id: "W1-T0" }), early]));
  const clock = fixedClock(T0);
  const db = openProjectorReadModel(scratch(t, "oracle-state"), "core", clock);
  t.after(() => db.close());
  const got = acquireLease(db, { clock });
  if (!got.ok) throw new Error("lease");
  assert.equal(createLedgerProjector({ ledgerDir: rowsDir, db, lease: got.lease, clock }).tick().quarantined, 1);
  const run = check({ rowsDir, metricPath: join(scratch(t, "oracle-metric"), LIVE), db, lease: got.lease, lines: [] });
  assert.equal(run.outcome, "agree");
  assert.equal(run.ledgerRows, 2);
});

function repoTables(db: ReadModelDb): string {
  const rows = db.prepare("SELECT ts_ms, h, body FROM repo_row ORDER BY ts_ms, h", { bigInts: true }).all();
  const beat = db.prepare("SELECT k, last_ms FROM instance_heartbeat ORDER BY k", { bigInts: true }).all();
  return JSON.stringify({ rows, beat }, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
}

test("the oracle heal covers repo_row: a lost identity and its repo row come back together", (t) => {
  const f = projected(t);
  const clean = repoTables(f.db);
  assert.ok(Number(f.db.prepare("SELECT count(*) AS n FROM repo_row").get()?.n) >= 8, "positive control: the run.start rows project");
  // P1-BUILD-E's case: an identity the store lost carries a repo row, and healing `seen` alone left it out.
  f.db.exec("DELETE FROM repo_row WHERE ts_ms = (SELECT max(ts_ms) FROM repo_row)");
  f.db.exec("DELETE FROM seen WHERE ts_ms = (SELECT max(ts_ms) FROM seen)");
  f.db.exec("UPDATE repo_row SET body = '{}' WHERE ts_ms = (SELECT min(ts_ms) FROM repo_row)");
  const run = check(f);
  assert.equal(run.outcome, "healed");
  assert.equal(run.mismatches.projectionMissing, 2, "the deleted row and the true body of the corrupted one");
  assert.equal(run.mismatches.projectionExtra, 1, "the corrupted body no ledger line explains");
  assert.equal(repoTables(f.db), clean, "repo_row equals a clean projection again");
  assert.equal(check(f, {}, fixedClock(CHECK_AT + 60_000)).outcome, "agree");
});

test("the oracle heal raises an instance heartbeat the daemon rows exceed", (t) => {
  const f = projected(t);
  writeFileSync(join(f.rowsDir, LIVE), text([...f.lines.slice(7), row(T0 + 20_000, "daemon.boot")]));
  const clock = fixedClock(T0 + 60_000);
  createLedgerProjector({ ledgerDir: f.rowsDir, db: f.db, lease: f.lease, clock }).tick();
  const clean = repoTables(f.db);
  assert.match(clean, new RegExp(String(T0 + 20_000)), "positive control: the daemon row set the heartbeat");
  f.db.exec(`UPDATE instance_heartbeat SET last_ms = ${T0 - 1}`);
  const run = check(f);
  assert.equal(run.outcome, "healed");
  assert.equal(run.mismatches.projectionMissing, 1);
  assert.equal(repoTables(f.db), clean);
});

test("a repo row whose ledger line was lost is evidence and is not deleted by a heal", (t) => {
  const f = projected(t);
  writeFileSync(join(f.rowsDir, LIVE), text(f.lines.slice(7, 11)));
  const before = repoTables(f.db);
  const run = check(f);
  assert.equal(run.mismatches.ledgerLost, 1);
  assert.equal(run.mismatches.projectionExtra, 0);
  assert.equal(repoTables(f.db), before);
});

test("the oracle schedule is due first then hourly after agreement and sooner after drift", (t) => {
  const f = projected(t);
  assert.equal(consistencyCheckDue(f.db, CHECK_AT), true, "never run: due");
  check(f);
  assert.equal(consistencyCheckDue(f.db, CHECK_AT + ORACLE_DRIFT_INTERVAL_MS), false, "an agreement waits the hour");
  assert.equal(consistencyCheckDue(f.db, CHECK_AT + ORACLE_AGREE_INTERVAL_MS), true);
  f.db.exec("DELETE FROM fact WHERE seq = (SELECT min(seq) FROM fact)");
  check(f, {}, fixedClock(CHECK_AT + ORACLE_AGREE_INTERVAL_MS));
  assert.equal(consistencyCheckDue(f.db, CHECK_AT + ORACLE_AGREE_INTERVAL_MS + ORACLE_DRIFT_INTERVAL_MS), true, "after a heal the next check comes sooner");
});

test("the rolling slice cursor starts a new cycle when it is finished or unreadable", (t) => {
  const f = projected(t);
  const setCursor = (v: string) => f.db.prepare("INSERT INTO meta(k, v) VALUES('oracle_slice', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(v);
  const first = nextOracleSlice(f.db, CHECK_AT, 2 * ORACLE_SLICE_MS);
  assert.equal(first.startsCycle, true);
  assert.deepEqual(first.window, { t0: CHECK_AT - ORACLE_CLOSED_LAG_MS - ORACLE_SLICE_MS, t1: CHECK_AT - ORACLE_CLOSED_LAG_MS });
  advanceOracleSlice(f.db, f.lease, first.cursor);
  const second = nextOracleSlice(f.db, CHECK_AT + 60_000, 2 * ORACLE_SLICE_MS);
  assert.equal(second.startsCycle, false, "the cycle resumes from the stored cursor, whatever the clock says");
  assert.deepEqual(second.window, { t0: first.window.t0 - ORACLE_SLICE_MS, t1: first.window.t0 });
  advanceOracleSlice(f.db, f.lease, second.cursor);
  assert.equal(nextOracleSlice(f.db, CHECK_AT, 2 * ORACLE_SLICE_MS).startsCycle, true, "a finished cycle starts another");
  setCursor("{not json");
  assert.equal(nextOracleSlice(f.db, CHECK_AT).startsCycle, true, "an unreadable cursor starts a cycle rather than stalling");
});

test("a slice window retains only its own rows from the union read", (t) => {
  const f = projected(t);
  const run = check(f, { window: { t0: T0 + 2_000, t1: T0 + 4_000 } });
  assert.equal(run.outcome, "agree");
  assert.equal(run.ledgerRows, 3, "rows at T0+2 s, +3 s and +4 s only");
  const all = readLedgerUnionRawLinesSync(f.rowsDir, {}).rawLines.length;
  const kept = readLedgerUnionRawLinesSync(f.rowsDir, { keep: (line) => line.includes('"W1-T3"') }).rawLines;
  assert.ok(all > 1);
  assert.deepEqual(kept, [f.lines[3]], "the union reader retains only the lines its caller keeps");
});
