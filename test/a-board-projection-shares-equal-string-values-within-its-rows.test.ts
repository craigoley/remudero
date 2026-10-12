/**
 * W1-T6467: a board projection holds every fact row as its own JSON.parse result, so each repeated step name,
 * task id or url was one string per row. Each projection now keeps a table of the equal short primitive strings
 * it parsed and shares them across its rows. In an isolated replay of the production read model one now@core
 * instance retained about 19% less heap per worker isolate, exactly equal to main (W1-T6369, PR #10118).
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BOARD_INTERN_MAX_CHARS, canonicalProjection, createBoardProjection, internRowStrings, type BoardProjection, type Row } from "../src/lib/board-projection.js";
import type { Clock } from "../src/lib/clock.js";
import { createLedgerProjector, openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { createNowView, type NowViewContext, type NowViewOptions } from "../src/lib/now-view.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { acquireLease, type ReadModelDb } from "../src/lib/read-model-db.js";
import type { GitHub } from "../src/lib/status.js";
import { makeTempDir } from "../src/lib/tmp.js";

const T0 = Date.parse("2026-10-06T08:00:00.000Z");
const IDS = ["W1-T1", "W1-T2", "W1-T3"];
type TestCtx = { after: (fn: () => void) => void };

function task(id: string): Task {
  return { id, title: `task ${id}`, repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 };
}
const PLAN: Plan = { tasks: IDS.map(task), byId: new Map(IDS.map((id) => [id, task(id)])) };
const GATEWAY = {
  readFailed: () => false, prByRef: () => null, findMergedByTrailer: () => null, findMergedByHeadBranch: () => [], listMergedHeadBranches: () => [],
  listOpenHeadBranches: () => [], headRefName: () => undefined, prBody: () => undefined, issueByUrl: () => ({ state: "OPEN", title: "t" }),
} as unknown as GitHub;
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

/** Rows repeating the same step names, task ids, run ids and urls, as a real ledger does. */
function rows(from: number, n: number): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (let k = from; k < from + n; k++) {
    const id = IDS[k % IDS.length]!;
    out.push({ ts: iso(1_000 * k), step: "run.start", task_id: id, run_id: `r-${id}` });
    out.push({ ts: iso(1_000 * k + 10), step: "pr.opened", task_id: id, run_id: `r-${id}`, pr_url: `https://github.com/o/r/pull/${10 + (k % IDS.length)}`, pr_number: 10 + (k % IDS.length) });
    out.push({ ts: iso(1_000 * k + 20), step: "verdict", task_id: id, run_id: `r-${id}`, verdict: k % 2 ? "no_pr" : "failed" });
  }
  return out;
}

function store(t: TestCtx): { dir: string; db: ReadModelDb; clock: Clock; append(...r: Array<Record<string, unknown>>): void; board(intern?: boolean): BoardProjection } {
  const dir = makeTempDir("board-intern");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let ms = T0 + 600_000;
  const clock: Clock = { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() };
  const db = openProjectorReadModel(join(dir, "home"), "core", clock);
  t.after(() => db.close());
  const got = acquireLease(db, { clock, ttlMs: 1e12 });
  assert.ok(got.ok);
  const ledgerDir = join(dir, "core", "state");
  mkdirSync(ledgerDir, { recursive: true });
  const projector = createLedgerProjector({ ledgerDir, db, lease: got.lease, clock });
  const append = (...r: Array<Record<string, unknown>>): void => {
    appendFileSync(join(ledgerDir, "ledger.ndjson"), r.map((x) => `${JSON.stringify({ ...x, host: "h1" })}\n`).join(""));
    projector.tick();
    ms += 1_000;
  };
  append(...rows(0, 12));
  return {
    dir: ledgerDir, db, clock, append,
    board: (intern = true) => createBoardProjection({
      db, ledgerPath: join(ledgerDir, "ledger.ndjson"), clock, readPlan: () => PLAN, github: GATEWAY, githubGeneration: () => "g1",
      readCreditStore: () => ({}), readCreditOverrideFile: () => "", ...(intern ? {} : { internStrings: false }),
    }),
  };
}

function drain(board: BoardProjection): void {
  let n = 0;
  while (!board.update({ force: true }).caughtUp && n++ < 100) { /* to caught up */ }
}

const canonical = (board: BoardProjection): Record<string, string> => Object.fromEntries([...board.projections()].map(([id, p]) => [id, canonicalProjection(p)]).sort());

test("equal string values from two rows resolve through one table entry, and nothing else about a row changes", () => {
  const long = "x".repeat(BOARD_INTERN_MAX_CHARS + 1);
  const atLimit = "y".repeat(BOARD_INTERN_MAX_CHARS);
  const text = JSON.stringify({ ts: "2026-10-06T08:00:00.000Z", step: "run.start", task_id: "W1-T1", emoji: "🐎 é", n: 7, ok: true, none: null, list: ["run.start"], nested: { step: "run.start" }, long, atLimit });
  const table = new Map<string, string>();
  const first = JSON.parse(text) as Row;
  const nested = first.nested; const list = first.list;
  const keysBefore = Object.keys(first);
  internRowStrings(first, table);
  assert.deepEqual(first, JSON.parse(text), "every value is still equal to what was parsed");
  assert.deepEqual(Object.keys(first), keysBefore, "field order and presence are unchanged");
  assert.equal(first.nested, nested, "an object is left as parsed, not replaced or shared");
  assert.equal(first.list, list, "an array is left as parsed");
  assert.equal(first.emoji, "🐎 é", "a value outside ASCII is held exactly");
  assert.deepEqual([...table.keys()].sort(), ["2026-10-06T08:00:00.000Z", "W1-T1", "run.start", "🐎 é", atLimit].sort(), "only top-level strings up to the bound enter the table");
  const second = internRowStrings(JSON.parse(text) as Row, table);
  assert.equal(table.size, 5, "the second row's equal strings resolved through the first row's entries");
  assert.deepEqual(second, JSON.parse(text));
  assert.equal(typeof second.n, "number");
  assert.equal(second.none, null);
  assert.equal(table.has(long), false, "a string over the bound stays as parsed");
});

test("each projection keeps its own table, empty until it ingests", (t) => {
  const s = store(t);
  const a = s.board();
  assert.equal(a.internedStrings(), 0, "a new projection's table is empty");
  drain(a);
  const held = a.internedStrings();
  assert.ok(held > 0, "ingest filled it");
  assert.ok(held < a.rows().length * 4, `repeated values are held once: ${held} strings for ${a.rows().length} rows`);
  const b = s.board();
  assert.equal(b.internedStrings(), 0, "a second projection does not see the first one's table");
  drain(b);
  assert.equal(b.internedStrings(), held, "and builds the same one from the same rows");
  const off = s.board(false);
  drain(off);
  assert.equal(off.internedStrings(), 0, "control: the arm without the table holds none");
});

test("a projection with the table derives the same board, rows and oracle verdict as one without it, across appends", (t) => {
  const s = store(t);
  const shared = s.board();
  const plain = s.board(false);
  drain(shared); drain(plain);
  assert.equal(Object.keys(canonical(shared)).length, IDS.length, "control: every plan task is projected");
  assert.deepEqual(canonical(shared), canonical(plain));
  assert.deepEqual(shared.rows(), plain.rows());
  s.append(...rows(12, 4));
  drain(shared); drain(plain);
  assert.deepEqual(canonical(shared), canonical(plain), "after appends");
  assert.deepEqual(shared.rows(), plain.rows(), "after appends");
  assert.deepEqual(shared.oracle().outcome, plain.oracle().outcome);
});

test("the now view's body is canonically equal with and without the board's string table", (t) => {
  const s = store(t);
  const feedbackRoot = join(s.dir, "checkout");
  mkdirSync(join(feedbackRoot, "plan", "feedback"), { recursive: true });
  const instance = { name: "core", ledgerDir: s.dir, repo: "o/r", feedbackRoot };
  const seams: Partial<NowViewOptions> = {
    readPlan: () => PLAN, github: () => ({ github: GATEWAY, generation: "g", source: { asOf: null, state: "fresh" } }),
    hostProbe: { rateLimit: () => 5_000, diskFree: () => 1_000_000, readLive: () => [] }, listGrilling: () => [], planBehind: () => ({ commits: 0 }),
  };
  const ctx = (): NowViewContext => {
    const generation = Number((s.db as unknown as { meta(k: string): string | undefined }).meta("generation"));
    return { now: s.clock.now(), switches: { views: { now: "shadow" } }, instances: [{ state: { instance: "core", generation, lease: "held", failures: 0, tickedAt: s.clock.now(), newestTs: null }, db: s.db }] };
  };
  const shared = createNowView({ instances: [instance], clock: s.clock, ...seams });
  const plain = createNowView({ instances: [instance], clock: s.clock, boardInternStrings: false, ...seams });
  const built = (view: ReturnType<typeof createNowView>) => { const c = ctx(); while (!view.prepare(c, () => true)) { /* to ready */ } return view.materialize(c); };
  const first = built(shared);
  assert.equal(first.length, 1, "control: one body");
  assert.deepEqual(first, built(plain));
  s.append(...rows(16, 3));
  assert.deepEqual(built(shared), built(plain), "after appends");
});
