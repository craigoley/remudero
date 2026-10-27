/**
 * W1-T9604: each index the board projection built re-read every step it was asked for, and json_type-scanned every
 * pr.opened, review.posted and plan-only marker body for the plan-only sets, from seq 0. The projection now keeps the
 * buckets and the sets, read in full once and extended by the rows its own ingest already reads. Every test compares
 * them with a full read of the same store at the same seq: a fresh projection's first index, which reads in full.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  canonicalProjection,
  createBoardProjection,
  type BoardProjection,
  type BoardProjectionOptions,
  type Row,
} from "#src/lib/board-projection.js";
import type { Clock } from "#src/lib/clock.js";
import { PLAN_ONLY_REVIEW_MARKER_STEP } from "#src/lib/ledger-carry.js";
import { rotateLedger } from "#src/lib/ledger.js";
import { createLedgerProjector, openProjectorReadModel, type LedgerProjector } from "#src/lib/ledger-projector.js";
import type { Plan, Task } from "#src/lib/plan.js";
import { acquireLease, type ReadModelDb, type ReadModelStatement } from "#src/lib/read-model-db.js";
import type { GitHub, LedgerIndex, PrRef } from "#src/lib/status.js";
import { makeTempDir } from "#src/lib/tmp.js";

type TestCtx = { after: (fn: () => void) => void };

const T0 = Date.parse("2026-10-15T09:00:00.000Z");
const at = (ms: number): string => new Date(ms).toISOString();
const url = (pr: number): string => `https://github.com/o/r/pull/${pr}`;
const IDS = Array.from({ length: 12 }, (_, i) => `W1-T${i + 1}`);
const task = (id: string): Task => ({ id, title: `task ${id}`, repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 });
const PLAN: Plan = { tasks: IDS.map(task), byId: new Map(IDS.map((id) => [id, task(id)])) };
/** W1-T2 and W1-T5 merged by trailer, so their derives ask the plan-only sets. */
const MERGED: PrRef[] = [2, 5].map((k) => ({ number: 100 + k, url: url(100 + k), state: "MERGED", headRefName: `run-W1-T${k}-1`, headRefOid: `h${k}`, title: `t${k}`, body: `Remudero-Task: W1-T${k}` }));
const GATEWAY = {
  readFailed: () => false,
  prByRef: (ref: number | string) => MERGED.find((pr) => pr.number === ref || pr.url === ref) ?? null,
  findMergedByTrailer: (id: string) => MERGED.find((pr) => pr.body === `Remudero-Task: ${id}`) ?? null,
  findMergedByHeadBranch: () => [], listMergedHeadBranches: () => MERGED, listOpenHeadBranches: () => [],
  headRefName: (ref: string) => MERGED.find((pr) => pr.url === ref)?.headRefName, prBody: (ref: string) => MERGED.find((pr) => pr.url === ref)?.body,
  issueByUrl: () => ({ state: "OPEN", title: "issue" }),
} as unknown as GitHub;

/** Every step a reader asks of `byStep` (status.ts and now-view.ts), and the three plan-only steps. */
const READ_STEPS = ["verdict", "verdict.merged", "daemon.boot", "escalation.issue_opened", "recon.done", "implement.done", "implement.continued",
  "fix.done", "dep-review.decided", "ratify.approved", "verify_human.judged", "pr.opened", "review.posted", PLAN_ONLY_REVIEW_MARKER_STEP];

/** `n` rows from `from`, a second apart, cycling through every read step, a plan-only share, and steps no reader asks. */
function rowsFrom(from: number, n: number, offset = 0): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < n; i++) {
    const k = offset + i;
    const id = IDS[k % IDS.length]!;
    const ts = at(from + i * 1_000);
    const step = k % 5 === 4 ? (k % 2 === 0 ? "sweep.disposed" : "sweep.pass") : READ_STEPS[k % READ_STEPS.length]!;
    const pr = 100 + (k % IDS.length) + 1;
    out.push({
      ts, step, task_id: id, run_id: `r-${id}-${k % 3}`, pr_url: url(pr), pr_number: pr, head_sha: `h${k % 7}`, host: "h1", n: k,
      ...(k % 3 === 0 ? { plan_only: true } : {}),
      ...(step === "verdict" ? { verdict: k % 2 === 0 ? "merged" : "failed", cost_usd: 0.1 } : {}),
      ...(step === "daemon.boot" ? { head_sha: `c${k % 4}` } : {}),
      ...(step === "escalation.issue_opened" ? { issue_url: `https://github.com/o/r/issues/${k}`, class: "MANUAL" } : {}),
    });
  }
  return out;
}

/** Each statement's rows that carry a fact body, but the ingest's own read: the step reads a test can count. */
interface Counted {
  db: ReadModelDb;
  bodyRows(): number;
}

function counting(db: ReadModelDb): Counted {
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
  db: ReadModelDb;
  ledgerDir: string;
  projector: LedgerProjector;
  set(ms: number): void;
  append(rows: Row[]): void;
  board(over?: Partial<BoardProjectionOptions>): BoardProjection;
  /** A fresh projection over the same store, caught up: its first index reads every step in full. */
  fullRead(): LedgerIndex;
}

function world(t: TestCtx, rows: Row[]): World {
  const root = makeTempDir("board-step-buckets");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let ms = T0 + 3_600_000;
  const clock: Clock = { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() };
  const ledgerDir = join(root, "core", "state");
  mkdirSync(ledgerDir, { recursive: true });
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
  const board = (over: Partial<BoardProjectionOptions> = {}): BoardProjection => createBoardProjection({
    db, ledgerPath: join(ledgerDir, "ledger.ndjson"), clock, readPlan: () => PLAN, github: GATEWAY, githubGeneration: () => "g1",
    readCreditStore: () => ({}), readCreditOverrideFile: () => "", ...over,
  });
  return {
    db, ledgerDir, projector, append, board, set: (to) => void (ms = to),
    fullRead: () => {
      const fresh = board();
      fresh.update({ force: true });
      return fresh.index(fresh.rows());
    },
  };
}

/** Every read step's bucket and both plan-only sets, in a form deep-equality compares exactly (sets sorted). */
function shapeOf(index: LedgerIndex): Record<string, unknown> {
  const steps = Object.fromEntries(READ_STEPS.map((step) => [step, (index.byStep.get(step) ?? []).map((row) => JSON.stringify(row))]));
  return {
    steps,
    filing: [...index.planOnlyFilingPrUrls].sort(),
    reviewed: [...index.planOnlyReviewedHeads].map(([pr, heads]) => [pr, [...heads].sort()]).sort(),
  };
}

const ask = (index: LedgerIndex): void => {
  for (const step of READ_STEPS) index.byStep.get(step);
  void index.planOnlyFilingPrUrls;
  void index.planOnlyReviewedHeads;
};

/** Plan-only rows the sets skip: a filing with no PR url, and a review with no head. */
const oddPlanOnly = (ms: number): Row[] => [
  { ts: at(ms), step: "pr.opened", task_id: "W1-T8", plan_only: true, host: "h1" },
  { ts: at(ms + 1), step: "review.posted", task_id: "W1-T8", pr_url: url(108), plan_only: true, host: "h1" },
];

test("W1-T9604: an extended step bucket equals a fresh full read", (t) => {
  const w = world(t, [...rowsFrom(T0, 600), ...oddPlanOnly(T0 + 700_000)]);
  const board = w.board();
  board.update({ force: true });
  ask(board.index(board.rows()));
  // Three rounds of new rows. Each round's last rows carry a ts a minute before rows already held (a late row), a new
  // plan-only filing PR and a reviewed head on a PR the sets already hold.
  for (let round = 0; round < 3; round++) {
    const late = T0 + 300_000 + round * 1_000;
    w.append([
      ...rowsFrom(T0 + 3_000_000 + round * 60_000, 40, 600 + round * 40),
      { ts: at(late), step: "verdict.merged", task_id: "W1-T3", pr_url: url(103), pr_number: 103, host: "h1", late: round },
      { ts: at(late + 1), step: "daemon.boot", head_sha: `late${round}`, host: "h1" },
      { ts: at(late + 2), step: "pr.opened", task_id: "W1-T4", pr_url: url(900 + round), pr_number: 900 + round, plan_only: true, host: "h1" },
      { ts: at(late + 3), step: PLAN_ONLY_REVIEW_MARKER_STEP, task_id: "W1-T2", pr_url: url(102), head_sha: `late${round}`, plan_only: true, host: "h1" },
      // A second head for the same PR in the same extension, and a PR the reviewed set did not hold.
      { ts: at(late + 4), step: "review.posted", task_id: "W1-T2", pr_url: url(102), head_sha: `again${round}`, plan_only: true, host: "h1" },
      { ts: at(late + 5), step: "review.posted", task_id: "W1-T9", pr_url: url(950 + round), head_sha: `fresh${round}`, plan_only: true, host: "h1" },
      ...oddPlanOnly(late + 6),
    ]);
    board.update({ force: true });
    const extended = board.index(board.rows());
    const full = w.fullRead();
    assert.deepEqual(shapeOf(extended), shapeOf(full), `round ${round}: the extended buckets equal a full read at the same seq`);
    const merged = (extended.byStep.get("verdict.merged") ?? []).map((r) => r.late);
    assert.ok(merged.includes(round), `round ${round}: control, the late row is in the bucket`);
    assert.ok(merged.indexOf(round) < merged.length - 1, `round ${round}: control, the late row sorts before rows already held`);
    assert.ok(extended.planOnlyFilingPrUrls.has(url(900 + round)), `round ${round}: control, the new plan-only filing is in the set`);
  }
  // A/A: two full reads of one store agree, so the comparison above can tell a difference from noise.
  assert.deepEqual(shapeOf(w.fullRead()), shapeOf(w.fullRead()));
});

test("W1-T9604: a later index reads only the new rows of a cached step", (t) => {
  const w = world(t, rowsFrom(T0, 1_000));
  const counted = counting(w.db);
  const board = w.board({ db: counted.db });
  board.update({ force: true });
  const first = board.index(board.rows());
  const before = counted.bodyRows();
  const bucket = first.byStep.get("verdict.merged") ?? [];
  const firstRead = counted.bodyRows() - before;
  assert.ok(bucket.length > 0, "control: the step has rows");
  w.append([...rowsFrom(T0 + 3_000_000, 9, 1_000), { ts: at(T0 + 3_100_000), step: "verdict.merged", task_id: "W1-T4", pr_url: url(104), host: "h1" }]);
  board.update({ force: true });
  const second = board.index(board.rows());
  const mark = counted.bodyRows();
  const grown = second.byStep.get("verdict.merged") ?? [];
  const secondRead = counted.bodyRows() - mark;
  assert.ok(grown.length > bucket.length, "control: the new rows hold rows of the step");
  assert.ok(secondRead <= 10, `the second index read ${secondRead} rows of the step (cached at ${bucket.length}; 10 rows are new)`);
  assert.ok(firstRead === 0 || firstRead === bucket.length, "control: a first read reads the bucket once");
  // The plan-only sets the same way: the second ask reads only rows past the cached seq.
  void first.planOnlyFilingPrUrls;
  w.append(rowsFrom(T0 + 3_100_000, 10, 1_010));
  board.update({ force: true });
  const third = board.index(board.rows());
  const planMark = counted.bodyRows();
  void third.planOnlyFilingPrUrls;
  void third.planOnlyReviewedHeads;
  assert.ok(counted.bodyRows() - planMark <= 10, `the plan-only sets read ${counted.bodyRows() - planMark} rows`);
  assert.deepEqual(shapeOf(third), shapeOf(w.fullRead()), "and what they hand out is a full read's");
});

test("W1-T9604: an earlier index keeps the rows it was built at", (t) => {
  const w = world(t, rowsFrom(T0, 400));
  const board = w.board();
  board.update({ force: true });
  const early = board.index(board.rows());
  const merged = early.byStep.get("verdict.merged")!;
  const filing = early.planOnlyFilingPrUrls;
  const reviewed = early.planOnlyReviewedHeads;
  const snapshot = { merged: JSON.stringify(merged), length: merged.length, filing: [...filing].sort(), reviewed: JSON.stringify([...reviewed].map(([k, v]) => [k, [...v].sort()])) };
  const expected = shapeOf(w.fullRead());
  // Built at the same seq as `early`, but asks nothing until the cache has moved past it.
  const untouched = board.index(board.rows());
  w.append([...rowsFrom(T0 + 3_000_000, 60, 400), { ts: at(T0 + 1_000), step: "verdict.merged", task_id: "W1-T1", pr_url: url(101), host: "h1" },
    { ts: at(T0 + 2_000), step: "pr.opened", task_id: "W1-T6", pr_url: url(777), plan_only: true, host: "h1" },
    { ts: at(T0 + 3_000), step: "review.posted", task_id: "W1-T2", pr_url: url(102), head_sha: "brand-new", plan_only: true, host: "h1" }]);
  board.update({ force: true });
  const later = board.index(board.rows());
  assert.ok((later.byStep.get("verdict.merged") ?? []).length > snapshot.length, "control: the later index's bucket grew");
  assert.ok(later.planOnlyFilingPrUrls.has(url(777)), "control: the later index's set grew");
  assert.ok(later.planOnlyReviewedHeads.get(url(102))?.has("brand-new"), "control: the later index's reviewed heads grew");
  // The earlier index's arrays and sets are as they were handed out.
  assert.equal(early.byStep.get("verdict.merged"), merged, "the earlier index answers with the same array");
  assert.equal(merged.length, snapshot.length);
  assert.equal(JSON.stringify(merged), snapshot.merged);
  assert.deepEqual([...filing].sort(), snapshot.filing);
  assert.equal(JSON.stringify([...reviewed].map(([k, v]) => [k, [...v].sort()])), snapshot.reviewed);
  // A step the earlier index first asks AFTER the cache moved on is still read at the earlier index's own seq.
  assert.deepEqual(shapeOf(early), expected, "every bucket of the earlier index is a full read at its seq");
  assert.deepEqual(shapeOf(untouched), expected, "and so is every bucket and set an index first asks for after the cache moved on");
});

test("W1-T9604: a store behind the cache is read in full", (t) => {
  const w = world(t, [...rowsFrom(T0, 300), { ts: at(T0 + 400_000), step: "pr.opened", task_id: "W1-T6", pr_url: url(4242), plan_only: true, host: "h1" }]);
  const counted = counting(w.db);
  const board = w.board({ db: counted.db });
  board.update({ force: true });
  ask(board.index(board.rows()));
  // A row of a cached step is deleted under the cache (the consistency oracle's heal drops a corrupt or duplicate row):
  // the cache must not hand it out again.
  const victim = Number(w.db.prepare("SELECT seq FROM fact WHERE step = 'verdict.merged' ORDER BY seq LIMIT 1").get()!.seq);
  w.db.exec(`DELETE FROM fact WHERE seq = ${victim}`);
  const afterDelete = board.index(board.rows());
  const mark = counted.bodyRows();
  const merged = afterDelete.byStep.get("verdict.merged") ?? [];
  assert.ok(counted.bodyRows() - mark >= merged.length && merged.length > 0, "the step was read in full again");
  assert.deepEqual(shapeOf(afterDelete), shapeOf(w.fullRead()), "and equals a full read without the deleted row");
  // A plan-only filing row deleted under the sets: they are read again, without it.
  assert.ok(board.index(board.rows()).planOnlyFilingPrUrls.has(url(4242)), "control: the set holds the filing");
  w.db.exec("DELETE FROM fact WHERE step = 'pr.opened' AND json_extract(body, '$.pr_url') = 'https://github.com/o/r/pull/4242'");
  const afterPlanDelete = board.index(board.rows());
  assert.equal(afterPlanDelete.planOnlyFilingPrUrls.has(url(4242)), false, "the deleted filing is gone from the set");
  assert.deepEqual(shapeOf(afterPlanDelete), shapeOf(w.fullRead()));
  // The store's max seq falls below the cache's seq: its newest rows (of steps no index asked for) are gone, as from a
  // store rebuilt behind the handle.
  w.append([0, 1, 2].map((i) => ({ ts: at(T0 + 3_000_000 + i), step: "sweep.disposed", task_id: "W1-T1", pr_number: 101, disposition: "waiting", host: "h1" })));
  board.update({ force: true });
  ask(board.index(board.rows()));
  const top = Number(w.db.prepare("SELECT MAX(seq) AS seq FROM fact").get()!.seq);
  w.db.exec(`DELETE FROM fact WHERE seq > ${top - 3}`);
  assert.equal(Number(w.db.prepare("SELECT count(*) AS n FROM fact WHERE step = 'sweep.disposed' AND seq > ?").get(top - 3)!.n), 0, "control: only those rows went");
  const behind = board.index(board.rows());
  const behindMark = counted.bodyRows();
  const boots = behind.byStep.get("daemon.boot") ?? [];
  assert.ok(counted.bodyRows() - behindMark >= boots.length && boots.length > 0, "a store behind the cache is read in full");
  assert.deepEqual(shapeOf(behind), shapeOf(w.fullRead()), "and holds only the rows the store still has");
});

test("W1-T9604: a restarted projection and a rotated ledger read the same buckets as a full read", (t) => {
  const w = world(t, rowsFrom(T0, 300));
  const board = w.board();
  board.update({ force: true });
  ask(board.index(board.rows()));
  // Rotation: the live file is archived and carried; the projector reads the archive and the new live file, dropping the
  // rows it has seen, and the board ingests what is new.
  const live = join(w.ledgerDir, "ledger.ndjson");
  for (let round = 0; round < 3; round++) {
    appendFileSync(live, rowsFrom(T0 + 3_000_000 + round * 100_000, 30, 300 + round * 30).map((r) => `${JSON.stringify(r)}\n`).join(""));
    const rotated = rotateLedger(live, { ceilingBytes: 1_000, smoothingWindowMs: 0, now: () => new Date(T0 + 4_000_000 + round * 100_000) });
    assert.equal(rotated.rotated, true, `control: round ${round} rotated`);
    w.projector.tick();
    board.update({ force: true });
    assert.deepEqual(shapeOf(board.index(board.rows())), shapeOf(w.fullRead()), `rotation ${round}`);
  }
  // A restart: a new projection over the same store starts with no cache, and its buckets equal the old one's.
  const restarted = w.board();
  restarted.update({ force: true });
  assert.deepEqual(shapeOf(restarted.index(restarted.rows())), shapeOf(board.index(board.rows())));
});

test("W1-T9604: the board oracle audits the step cache and the board derives as it did", (t) => {
  const logged: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const w = world(t, rowsFrom(T0, 500));
  const board = w.board({ oracleSlices: 1, log: (step, extra) => void logged.push({ step, extra }) });
  // The reference arm: every row kept and the derive made from them in memory, as before W1-T9436; no store index.
  const reference = w.board({ keepEveryRow: true, deriveFromRows: true });
  for (let round = 0; round < 4; round++) {
    if (round > 0) w.append(rowsFrom(T0 + 3_000_000 + round * 60_000, 25, 500 + round * 25));
    board.update({ force: true });
    reference.update({ force: true });
    ask(board.index(board.rows()));
    const ids = [...reference.projections().keys()].sort();
    assert.deepEqual(ids, [...board.projections().keys()].sort());
    for (const id of ids) assert.equal(canonicalProjection(board.projections().get(id)), canonicalProjection(reference.projections().get(id)), `round ${round}: ${id}`);
  }
  const result = board.oracle();
  assert.equal(result.mismatches.length, 0, "the oracle finds no drift");
  const row = logged.findLast((l) => l.step === "read_model.board_oracle")!.extra;
  const cache = row.step_cache as { indexes: number; fullReads: number; extendedRows: number; reusedRows: number; held: { steps: number; rows: number; bytes: number };
    audit: { steps: number; rows: number; mismatches: string[] }; resets: Record<string, number> };
  assert.ok(cache.indexes > 0 && cache.fullReads > 0, "the oracle row counts the indexes and their full reads");
  assert.ok(cache.extendedRows > 0 && cache.reusedRows > 0, "and the rows extended from the ingest and reused");
  assert.ok(cache.held.steps > 0 && cache.held.rows > 0 && cache.held.bytes > 0, "and what the cache holds");
  assert.deepEqual(cache.audit.mismatches, [], "the audit (A/A against the oracle's full read) agrees");
  assert.ok(cache.audit.steps > 0 && cache.audit.rows > 0, "control: the audit compared rows");
  // Falsifier arm: a cached row changed under the cache (a reader writing into a row it was handed) is found by the
  // audit, which drops the cache, so the next index reads in full again.
  const handedIndex = board.index(board.rows());
  const handed = handedIndex.byStep.get("verdict.merged")!;
  (handed[0] as Row).pr_url = "mutated";
  (handedIndex.planOnlyFilingPrUrls as Set<string>).add("https://github.com/o/r/pull/mutated");
  board.oracle();
  const audited = logged.findLast((l) => l.step === "read_model.board_oracle")!.extra.step_cache as typeof cache;
  assert.ok(audited.audit.mismatches.includes("verdict.merged"), "the audit names the step that drifted");
  assert.ok(audited.audit.mismatches.includes("plan_only"), "and the plan-only sets");
  assert.equal(audited.resets.audit, 1, "and drops the cache");
  assert.notEqual((board.index(board.rows()).byStep.get("verdict.merged") ?? [])[0]?.pr_url, "mutated", "the next index reads the step again");
  // The in-memory arm derives from its rows, so it has no store index, no cache and no step_cache to report.
  const before = logged.length;
  const referenceLog: Array<Record<string, unknown>> = [];
  const inMemory = w.board({ keepEveryRow: true, deriveFromRows: true, oracleSlices: 1, log: (_step, extra) => void referenceLog.push(extra) });
  inMemory.update({ force: true });
  assert.equal(inMemory.oracle().mismatches.length, 0);
  assert.equal(referenceLog.at(-1)?.step_cache, undefined);
  assert.equal(logged.length, before, "control: the reference arm logs to its own sink");
});
