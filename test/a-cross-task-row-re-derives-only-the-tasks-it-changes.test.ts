/**
 * W1-T9719: a `daemon.boot` row and a plan-only `pr.opened` row marked every task dirty, because the readers that
 * consult them (environmentChangedSince, isPlanOnlyFilingPr) read whole-ledger: a full re-derive of every plan task
 * (~1.2 GB read on a production-sized store) for each boot and each plan-only filing PR. Each derive now records what
 * it read of those rows through the index, its stamp carries the answers, and a row re-derives only a task whose
 * answer it moved. Every test holds the result against the board oracle's no-reuse derive of the same store.
 */
import assert from "node:assert/strict";
import { appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BOARD_DERIVE_DEBOUNCE_MS, createBoardProjection, type BoardProjection, type BoardProjectionOptions } from "../src/lib/board-projection.js";
import type { Clock } from "../src/lib/clock.js";
import { createLedgerProjector, openProjectorReadModel } from "../src/lib/ledger-projector.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { acquireLease, type ReadModelDb } from "../src/lib/read-model-db.js";
import type { GitHub, PrRef } from "../src/lib/status.js";
import { makeTempDir } from "../src/lib/tmp.js";

type TestCtx = { after: (fn: () => void) => void };
type Row = Record<string, unknown>;

const T0 = Date.parse("2026-10-16T12:00:00.000Z");
const at = (ms: number): string => new Date(ms).toISOString();
const url = (pr: number): string => `https://github.com/o/r/pull/${pr}`;
const IDS = Array.from({ length: 50 }, (_, i) => `W1-T${i + 1}`);
const task = (id: string): Task => ({ id, title: `task ${id}`, repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 });
const PLAN: Plan = { tasks: IDS.map(task), byId: new Map(IDS.map((id) => [id, task(id)])) };
/** W1-T2 and W1-T5 merged by trailer, so their derives ask whether their PR is a plan-only filing. */
const MERGED: PrRef[] = [2, 5].map((k) => ({ number: 100 + k, url: url(100 + k), state: "MERGED", headRefName: `run-W1-T${k}-1`, headRefOid: `h${k}`, title: `t${k}`, body: `Remudero-Task: W1-T${k}` }));
const GITHUB = {
  readFailed: () => false,
  prByRef: (ref: number | string) => MERGED.find((pr) => pr.number === ref || pr.url === ref) ?? null,
  findMergedByTrailer: (id: string) => MERGED.find((pr) => pr.body === `Remudero-Task: ${id}`) ?? null,
  findMergedByHeadBranch: () => [], listMergedHeadBranches: () => MERGED, listOpenHeadBranches: () => [],
  headRefName: (ref: string) => MERGED.find((pr) => pr.url === ref)?.headRefName, prBody: (ref: string) => MERGED.find((pr) => pr.url === ref)?.body,
  issueByUrl: () => ({ state: "OPEN", title: "issue" }),
} as unknown as GitHub;

/** The blocked task: an environmental block an hour ago, on the code the boot before it ran. */
const BLOCKED = "W1-T7";

interface World {
  db: ReadModelDb;
  later(ms?: number): void;
  append(...rows: Row[]): void;
  /** A projection over the store, as serve opens one: a second call is a restart over what the first persisted.
   *  `persist` false: without the lease, so it keeps nothing. */
  board(over?: Partial<BoardProjectionOptions>, persist?: boolean): BoardProjection;
  /** Each plan task's recorded cross-task reads, as persisted. */
  persistedReads(): Map<string, string[]>;
}

function world(t: TestCtx): World {
  const dir = makeTempDir("board-cross-task");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = T0;
  const clock: Clock = { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() };
  const db = openProjectorReadModel(dir, "core", clock);
  t.after(() => db.close());
  const got = acquireLease(db, { clock, ttlMs: 1e12 });
  assert.ok(got.ok);
  const projector = createLedgerProjector({ ledgerDir: dir, db, lease: got.lease, clock });
  const append = (...rows: Row[]): void => {
    appendFileSync(join(dir, "ledger.ndjson"), rows.map((r) => `${JSON.stringify({ ts: at(now), host: "h1", ...r })}\n`).join(""));
    projector.tick();
  };
  // Every task has a failed run long ago; the boot before the block ran code c1; the block is environmental, so
  // whether it still holds depends on the boots after it.
  append(
    ...IDS.map((id, k) => ({ ts: at(T0 - 20 * 3_600_000 + k * 1_000), step: "verdict", task_id: id, run_id: `r-${id}`, verdict: "no_pr" })),
    { ts: at(T0 - 2 * 3_600_000), step: "daemon.boot", head_sha: "c1" },
    { ts: at(T0 - 3_600_000), step: "dispatch.blocked_independent", task_id: BLOCKED, run_id: `b-${BLOCKED}`, verdict: "blocked_transient" },
  );
  return {
    db,
    later: (ms = BOARD_DERIVE_DEBOUNCE_MS) => void (now += ms),
    append,
    board: (over = {}, persist = true) => createBoardProjection({
      db, ...(persist ? { lease: got.lease } : {}), ledgerPath: join(dir, "ledger.ndjson"), clock, readPlan: () => PLAN, github: GITHUB, githubGeneration: () => "g1",
      readCreditStore: () => ({}), readCreditOverrideFile: () => "", ...over,
    }),
    persistedReads: () => new Map(db.prepare("SELECT task_id, keys FROM task_cross_read").all().map((r) => [String(r.task_id), JSON.parse(String(r.keys)) as string[]])),
  };
}

/** The board equals a full re-derive: the oracle's no-reuse derive of every task finds nothing to heal. */
function assertEqualsFullDerive(board: BoardProjection, what: string): void {
  const audit = board.oracle();
  assert.equal(audit.compared, IDS.length, `${what}: control: the oracle compared every task`);
  assert.deepEqual(audit.mismatches, [], `${what}: the board equals a full re-derive`);
}

test("W1-T9719: a daemon.boot row re-derives only the tasks that read it", (t) => {
  const w = world(t);
  const logged: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const board = w.board({ log: (step, extra) => void logged.push({ step, extra }) });
  assert.equal(board.update().full, true, "the first derive has nothing to reuse");
  assert.equal(board.projections().get(BLOCKED)?.status, "blocked", "control: the environmental block holds on the boot it saw");
  assert.deepEqual(w.persistedReads().get(BLOCKED), ["step:daemon.boot"], "the blocked task's derive read the boot history");
  assert.deepEqual(w.persistedReads().get("W1-T8"), [], "an unblocked task's did not");
  // A boot on other code: the blocked task's answer moves (the environment changed), no other task's can.
  w.later();
  w.append({ step: "daemon.boot", head_sha: "c2" });
  const booted = board.update();
  assert.equal(booted.full, false, "a boot is no longer a full re-derive");
  assert.deepEqual(booted.rederived, [BLOCKED], "only the task that read the boot history re-derives");
  assert.deepEqual(booted.crossTask, { rows: 1, rederived: 1, reused: IDS.length - 1 }, "and the update says so");
  assert.notEqual(board.projections().get(BLOCKED)?.status, "blocked", "the block is released by the new code");
  assertEqualsFullDerive(board, "after the boot");
  const row = logged.findLast((l) => l.step === "read_model.board_oracle")!.extra;
  assert.deepEqual(row.cross_task, { rows: 1, rederived: 1, reused: IDS.length - 1 }, "the oracle's row carries the cross-task rows and their cost");
  // A boot naming a plan task moves that task as any row naming it does, beside the readers.
  w.later();
  w.append({ step: "daemon.boot", head_sha: "c3", task_id: "W1-T20" });
  assert.deepEqual(board.update().rederived, ["W1-T20", BLOCKED].sort(), "a boot naming a task moves it too");
  assertEqualsFullDerive(board, "after a boot naming a task");
});

test("W1-T9719: a plan-only pr.opened re-derives only the tasks whose answer moved", (t) => {
  const w = world(t);
  const board = w.board();
  board.update();
  assert.ok(w.persistedReads().get("W1-T2")?.includes(`filing:${url(102)}`), "control: W1-T2's derive asked whether its PR is a plan-only filing");
  const before = JSON.stringify(board.projections().get("W1-T2"));
  // A plan-only filing PR nobody asked about: no task's answer moves.
  w.later();
  w.append({ step: "pr.opened", plan_only: true, pr_url: url(900), run_id: "f1" });
  const unrelated = board.update();
  assert.deepEqual(unrelated.rederived, [], "a filing no derive asked about re-derives nothing");
  assert.deepEqual(unrelated.crossTask, { rows: 1, rederived: 0, reused: IDS.length });
  // W1-T2's merged PR turns out to be a plan-only filing: only W1-T2's answer moves.
  w.later();
  w.append({ step: "pr.opened", plan_only: true, pr_url: url(102), run_id: "f2" });
  const moved = board.update();
  assert.equal(moved.full, false);
  assert.deepEqual(moved.rederived, ["W1-T2"], "only the task that asked about that PR re-derives");
  assert.notEqual(JSON.stringify(board.projections().get("W1-T2")), before, "control: its projection changed with the answer");
  assertEqualsFullDerive(board, "after the filing");
  // A filing row naming a plan task moves that task as any row naming it does.
  w.later();
  w.append({ step: "pr.opened", plan_only: true, pr_url: url(901), run_id: "f3", task_id: "W1-T30" });
  assert.deepEqual(board.update().rederived, ["W1-T30"]);
  assertEqualsFullDerive(board, "after a filing naming a task");
});

test("W1-T9719: recorded cross-task reads survive a restart", (t) => {
  const w = world(t);
  w.board().update();
  const persisted = w.persistedReads();
  assert.equal(persisted.size, IDS.length, "every derived task's reads are persisted beside its projection");
  // A restart: a new projection over the same store reuses every persisted task and its recorded reads.
  w.later();
  const restarted = w.board();
  const first = restarted.update();
  assert.equal(first.full, false, "control: the restart reuses the persisted board");
  w.later();
  w.append({ step: "daemon.boot", head_sha: "c2" });
  const booted = restarted.update();
  assert.equal(booted.full, false, "the first boot row after a restart is not a full re-derive");
  assert.deepEqual(booted.rederived, [BLOCKED]);
  assertEqualsFullDerive(restarted, "after the restart's boot");
  // A derive with no recording index (from rows held in memory: the reference arm) records nothing, so its tasks
  // keep the whole-board rule.
  const other = world(t);
  const inMemory = other.board({ keepEveryRow: true, deriveFromRows: true }, false);
  assert.equal(inMemory.update().full, true);
  other.later();
  other.append({ step: "daemon.boot", head_sha: "c2" });
  assert.equal(inMemory.update().full, true, "a task with no recorded reads re-derives on every cross-task row");
});
