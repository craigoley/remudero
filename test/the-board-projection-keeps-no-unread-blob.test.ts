/**
 * W1-T9357: a board projection kept every fact row whole for the life of its thread, blobs included. A read census
 * of the now view (a recording Proxy on each of 836,723 snapshot rows, four builds) found 11 fields never read;
 * kept without them, one core now view held 82 MB less after GC with byte-identical bodies.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BOARD_ROW_UNREAD_FIELDS, canonicalProjection, createBoardProjection, withoutUnreadFields, type BoardProjection, type Row } from "#src/lib/board-projection.js";
import type { Clock } from "#src/lib/clock.js";
import { createLedgerProjector, openProjectorReadModel } from "#src/lib/ledger-projector.js";
import type { Plan, Task } from "#src/lib/plan.js";
import { acquireLease } from "#src/lib/read-model-db.js";
import type { GitHub } from "#src/lib/status.js";
import { makeTempDir } from "#src/lib/tmp.js";

const T0 = Date.parse("2026-10-06T08:00:00.000Z");
const IDS = ["W1-T1", "W1-T2"];
const task = (id: string): Task => ({ id, title: `task ${id}`, repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 });
const PLAN: Plan = { tasks: IDS.map(task), byId: new Map(IDS.map((id) => [id, task(id)])) };
const GATEWAY = {
  readFailed: () => false, prByRef: () => null, findMergedByTrailer: () => null, findMergedByHeadBranch: () => [], listMergedHeadBranches: () => [],
  listOpenHeadBranches: () => [], headRefName: () => undefined, prBody: () => undefined, issueByUrl: () => ({ state: "OPEN", title: "t" }),
} as unknown as GitHub;
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

/** The blob each of three fat fact steps carries in production, beside the fields a derivation reads. */
const BLOBS: Record<string, Row> = {
  "worker.assignment": { worker_assignment: { selected: { model: "m" }, candidates: [1, 2, 3] }, benchmark_run: { version: "v1", phase: "attempt" } },
  "review.posted": { question: "Which is right?", decision_verdict: { verdict: "pass", reasons: ["a"] }, proof_exec: { ran: 3 } },
  "sweep.disposed": { stand_down_reason: "checks pending", changed_paths: ["src/a.ts"], review_input_digest: "d1" },
};
function rows(blobs: boolean): Row[] {
  return IDS.flatMap((id, k) => [
    { ts: iso(1_000 * k), step: "run.start", task_id: id, run_id: `r-${id}` },
    { ts: iso(1_000 * k + 10), step: "worker.assignment", task_id: id, run_id: `r-${id}`, cost_usd: 0.5, ...(blobs ? BLOBS["worker.assignment"] : {}) },
    { ts: iso(1_000 * k + 20), step: "review.posted", task_id: id, run_id: `r-${id}`, pr_url: `https://github.com/o/r/pull/${10 + k}`, state: "COMMENTED", ...(blobs ? BLOBS["review.posted"] : {}) },
    { ts: iso(1_000 * k + 30), step: "sweep.disposed", task_id: id, pr_number: 10 + k, disposition: "waiting", ...(blobs ? BLOBS["sweep.disposed"] : {}) },
    { ts: iso(1_000 * k + 40), step: "verdict", task_id: id, run_id: `r-${id}`, verdict: "failed" },
  ]);
}

function board(t: { after: (fn: () => void) => void }, blobs: boolean): BoardProjection {
  const dir = makeTempDir("board-unread-blob");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ms = T0 + 600_000;
  const clock: Clock = { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() };
  const db = openProjectorReadModel(join(dir, "home"), "core", clock);
  t.after(() => db.close());
  const got = acquireLease(db, { clock, ttlMs: 1e12 });
  assert.ok(got.ok);
  const ledgerDir = join(dir, "core", "state");
  mkdirSync(ledgerDir, { recursive: true });
  appendFileSync(join(ledgerDir, "ledger.ndjson"), rows(blobs).map((x) => `${JSON.stringify({ ...x, host: "h1" })}\n`).join(""));
  createLedgerProjector({ ledgerDir, db, lease: got.lease, clock }).tick();
  // W1-T9436: every row kept, so each fat row's kept shape is visible; the retention rules keep a subset of these same rows.
  const b = createBoardProjection({
    db, ledgerPath: join(ledgerDir, "ledger.ndjson"), clock, readPlan: () => PLAN, github: GATEWAY, githubGeneration: () => "g1",
    readCreditStore: () => ({}), readCreditOverrideFile: () => "", keepEveryRow: true,
  });
  let n = 0;
  while (!b.update({ force: true }).caughtUp && n++ < 100) { /* to caught up */ }
  return b;
}
const canonical = (b: BoardProjection): Record<string, string> => Object.fromEntries([...b.projections()].map(([id, p]) => [id, canonicalProjection(p)]).sort());

test("W1-T9357: the board projection keeps no unread blob", (t) => {
  const slim = board(t, true);
  const kept = slim.rows().filter((r) => typeof r.step === "string" && r.step in BLOBS);
  assert.equal(kept.length, 3 * IDS.length, "every fat fact row was ingested");
  for (const r of kept) {
    assert.deepEqual(Object.keys(r).filter((k) => BOARD_ROW_UNREAD_FIELDS.has(k)), [], `${String(r.step)} keeps no unread field`);
  }
  const posted = kept.find((r) => r.step === "review.posted")!;
  assert.deepEqual(Object.keys(posted), ["ts", "step", "task_id", "run_id", "pr_url", "state", "host"], "every other field is kept, in order");
  assert.equal(kept.find((r) => r.step === "sweep.disposed")!.disposition, "waiting");
  assert.deepEqual(canonical(slim), canonical(board(t, false)), "the board equals one built from rows that never held the blobs");
  assert.ok(Object.keys(canonical(slim)).length === IDS.length);
});

test("a row naming no unread field is kept as parsed", () => {
  const row: Row = { ts: iso(0), step: "verdict", task_id: "W1-T1", verdict: "failed" };
  assert.equal(withoutUnreadFields(row), row, "the same object, not a copy");
  const fat: Row = { ts: iso(0), question: "q", step: "review.posted", benchmark_run: {}, task_id: "W1-T1" };
  assert.deepEqual(Object.keys(withoutUnreadFields(fat)), ["ts", "step", "task_id"]);
  assert.deepEqual(Object.keys(fat), ["ts", "question", "step", "benchmark_run", "task_id"], "the parsed row is not changed");
});
