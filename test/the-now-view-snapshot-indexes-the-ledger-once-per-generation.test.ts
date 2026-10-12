import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { BoardIssueRest, BoardPrRest } from "../src/lib/open-prs-rest.js";
import { boardOpenSnapshotPath, createBoardSnapshotCache } from "../src/lib/board-snapshot-cache.js";
import type { Clock } from "../src/lib/clock.js";
import { createLedgerProjector, openProjectorReadModel } from "../src/lib/ledger-projector.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { acquireLease, type ReadModelDb } from "../src/lib/read-model-db.js";
import { makeTempDir } from "../src/lib/tmp.js";
// NAMESPACE imports: at the merge base the W1-T6253 counting seams do not exist, and a named import would fail the
// whole file at load, which the reviewer reads as "never ran" rather than as a red.
import * as nowView from "../src/lib/now-view.js";
import * as status from "../src/lib/status.js";
import * as statusBoard from "../src/lib/status-board.js";

/**
 * W1-T6253 — THE NOW VIEW'S SNAPSHOT INDEXES THE LEDGER ONCE PER GENERATION. Every now build's snapshot stage ran
 * computeBoardSnapshot → buildStatusBoard, which indexed the whole ledger once for the projection and once for each of
 * two board sections, and rescanned the day's cost rows: a median 2.4 s per build on serve (2026-10-07).
 *
 * FIXTURES ONLY: every ledger, read model and board snapshot lives in a throwaway directory.
 */

const T0 = Date.parse("2026-10-07T12:00:00.000Z");
type TestCtx = { after: (fn: () => void) => void };

function task(id: string): Task {
  return { id, title: `task ${id}`, repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 };
}

const PLAN: Plan = (() => {
  const tasks = ["W1-T1", "W1-T2"].map(task);
  return { tasks, byId: new Map(tasks.map((x) => [x.id, x])) };
})();

function pr(number: number, taskId: string, state: string): BoardPrRest {
  return {
    number, url: `https://github.com/o/r/pull/${number}`, state, headRefName: `run-${taskId}-1790000000000`, headRefOid: `sha-${number}`,
    body: `work\n\nRemudero-Task: ${taskId}`, autoMergeRequest: null, title: `pr ${number}`, updatedAt: "2026-10-07T11:00:00Z",
  };
}

const issue = (number: number): BoardIssueRest =>
  ({ number, url: `https://github.com/o/r/issues/${number}`, state: "OPEN", title: `issue ${number}`, updatedAt: "2026-10-07T11:00:00Z" });

test("W1-T6253: one status-board build indexes the ledger once", () => {
  const root = makeTempDir("t6253-board");
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    const rows = [
      { ts: "2026-10-07T10:00:00.000Z", step: "run.start", task_id: "W1-T1", run_id: "r1" },
      { ts: "2026-10-07T10:05:00.000Z", step: "daemon.tick" },
    ];
    const before = status.ledgerIndexBuildCount();
    statusBoard.buildStatusBoard(root, join(root, "state", "ledger.ndjson"), {
      queryService: () => ({ running: false, pid: null }), repoDir: "/nonexistent/repo/for/tests", now: () => T0,
      resolveOriginMainSha: () => undefined, isPidAlive: () => true, plan: PLAN,
      github: status.buildBatchedGithub("o", "r", { fetchAll: () => [], fetchAllIssues: () => [] }),
      readLedger: () => rows.map((row) => ({ ...row })),
    } as Parameters<typeof statusBoard.buildStatusBoard>[2]);
    assert.equal(status.ledgerIndexBuildCount() - before, 1, "the projection and both board sections share one index");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** One instance's read model and ledger, the way serve's views worker sees them. */
function setup(t: TestCtx) {
  const root = makeTempDir("t6253-now");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let now = T0;
  const clock: Clock & { set(ms: number): void } = {
    now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString(), set: (ms) => { now = ms; },
  };
  const home = join(root, "home");
  const ledgerDir = join(home, "ledger-core");
  mkdirSync(ledgerDir, { recursive: true });
  const db: ReadModelDb = openProjectorReadModel(join(home, "read-model-home"), "core", clock);
  t.after(() => db.close());
  const acquired = acquireLease(db, { clock, ttlMs: 1e12 });
  assert.ok(acquired.ok);
  const projector = createLedgerProjector({ ledgerDir, db, lease: acquired.lease, clock });
  const append = (row: Record<string, unknown>): void => {
    appendFileSync(join(ledgerDir, "ledger.ndjson"), `${JSON.stringify({ ts: clock.iso(), host: "h1", ...row })}\n`);
    projector.tick();
  };
  append({ step: "daemon.tick" });
  append({ step: "run.start", task_id: "W1-T1", run_id: "r1" });
  append({ step: "worker.cost", task_id: "W1-T1", run_id: "r1", usd: 0.5 });
  const open = [pr(9001, "W1-T1", "OPEN")];
  const cache = createBoardSnapshotCache(home, "o", "r");
  assert.equal(cache.commitClosed([pr(8001, "W1-T2", "MERGED")]), true);
  assert.equal(cache.commitIssues([issue(5)]), true);
  assert.equal(cache.commitOpen!(open, T0), true);
  const resave = (): void => {
    assert.equal(createBoardSnapshotCache(home, "o", "r").commitOpen!(open, clock.now()), true);
    const at = new Date(clock.now());
    utimesSync(boardOpenSnapshotPath(home, "o", "r"), at, at);
  };
  const view = nowView.createNowView({
    instances: [{ name: "core", ledgerDir, repo: "o/r" }], clock, readPlan: () => PLAN,
    hostProbe: { rateLimit: () => 4321, diskFree: () => 1 }, planBehind: () => ({ commits: 0 }),
  });
  const build = (): void => {
    const ctx: nowView.NowViewContext = {
      now: clock.now(), switches: { views: { now: "shadow" } },
      instances: [{ state: { instance: "core", generation: Number(db.meta("generation")), lease: "held", failures: 0, tickedAt: clock.now(), newestTs: null }, db }],
    };
    assert.equal(view.materialize(ctx).length, 1, "the build finished");
  };
  return { clock, append, resave, build };
}

test("W1-T6253: an unchanged row generation is indexed once across now builds", (t) => {
  const { clock, resave, build } = setup(t);
  build();
  const [indexes, scans] = [status.ledgerIndexBuildCount(), nowView.dayCostScanCount()];
  clock.set(T0 + nowView.NOW_REFRESH_MS);
  resave(); // the open half's re-save makes the next build due, with no new ledger row
  build();
  assert.equal(status.ledgerIndexBuildCount() - indexes, 0, "an unchanged row generation reuses the held index");
  assert.equal(nowView.dayCostScanCount() - scans, 0, "and the day's cost rows");
});

test("W1-T6253: a new row generation rebuilds the index", (t) => {
  const { clock, append, resave, build } = setup(t);
  build();
  const [indexes, scans] = [status.ledgerIndexBuildCount(), nowView.dayCostScanCount()];
  clock.set(T0 + nowView.NOW_REFRESH_MS);
  append({ step: "worker.cost", task_id: "W1-T1", run_id: "r2", usd: 0.25 });
  resave();
  build();
  assert.ok(status.ledgerIndexBuildCount() - indexes >= 1, "a new ledger row is a new generation, indexed again");
  assert.ok(nowView.dayCostScanCount() - scans >= 1, "and its day costs scanned again");
});
