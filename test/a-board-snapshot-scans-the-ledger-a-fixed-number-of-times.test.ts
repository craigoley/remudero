/**
 * The `now` view's snapshot stage runs `computeBoardSnapshot` over core's fact store, and on the fleet host it
 * took ~3.2 s a build (`read_model.slow_view` stages, 2026-10-07/08). Two parts of it scanned the whole ledger
 * once PER ITEM: `derivePrQueue` once per open PR for its `sweep.disposed` row, and `liveRunSpend` once per
 * running task. Each is now one pass, so the snapshot's reads of the ledger no longer grow with either count.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { computeBoardSnapshot, type BoardDeps } from "../src/lib/board.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { GitHub, PrRef, StatusProjection } from "../src/lib/status.js";

function task(id: string): Task {
  return { id, title: `Task ${id}`, repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 };
}

function openPr(number: number): PrRef {
  return { number, url: `https://github.com/craigoley/remudero/pull/${number}`, state: "OPEN", title: `PR ${number}`, headRefName: `topic-${number}`, headRefOid: `head-${number}`, body: "" };
}

/** A ledger whose element reads are counted, the way a `for...of` over the fact store's rows reads them. */
function countedRows(rows: Array<Record<string, unknown>>): { lines: Array<Record<string, unknown>>; reads: () => number } {
  let reads = 0;
  const lines = new Proxy(rows, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  return { lines, reads: () => reads };
}

function snapshotReads(openPrs: number, running: number): { reads: number; rows: number; snapshot: ReturnType<typeof computeBoardSnapshot> } {
  const ids = Array.from({ length: 40 }, (_, i) => `W1-T${100 + i}`);
  const tasks = ids.map(task);
  const plan: Plan = { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
  const rows: Array<Record<string, unknown>> = [];
  let ms = Date.parse("2026-10-09T08:00:00.000Z");
  const ts = (): string => new Date((ms += 1_000)).toISOString();
  for (let i = 0; i < 300; i++) rows.push({ ts: ts(), step: "dispatch.considered", task_id: ids[i % ids.length] });
  for (const id of ids.slice(0, running)) {
    rows.push({ ts: ts(), step: "run.start", task_id: id, run_id: `r-${id}` });
    rows.push({ ts: ts(), step: "implement.done", task_id: id, run_id: `r-${id}`, cost_usd: 0.25, num_turns: 4 });
  }
  const prs = Array.from({ length: openPrs }, (_, i) => openPr(9_000 + i));
  for (const pr of prs) {
    rows.push({ ts: ts(), step: "sweep.disposed", pr_number: pr.number, head_sha: "an-older-head", disposition: "stale" });
    rows.push({ ts: ts(), step: "sweep.disposed", pr_number: pr.number, head_sha: pr.headRefOid, disposition: "blocked-fixable", reason: "lint red" });
    rows.push({ ts: ts(), step: "sweep.disposed", pr_number: pr.number, head_sha: pr.headRefOid, disposition: "wait", reason: "checks running" });
  }
  const counted = countedRows(rows);
  const github: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    listOpenHeadBranches: () => prs,
    readFailed: () => false,
    readTruncated: () => false,
  };
  const deps: BoardDeps = { plan, ledgerPath: "/not-read/ledger.ndjson", github, readLedger: () => counted.lines, now: () => ms, readCreditStore: () => ({}), readCreditOverrideFile: () => "" };
  const reuse = (t: Task): StatusProjection => ({ taskId: t.id, status: "queued", merged: false, source: "none", ...(ids.indexOf(t.id) < running ? { phase: "implement" } : {}) });
  const snapshot = computeBoardSnapshot(deps, { reuseProjection: reuse });
  return { reads: counted.reads(), rows: rows.length, snapshot };
}

test("the board snapshot's passes over the ledger do not grow with its open PRs or its running tasks", () => {
  const few = snapshotReads(2, 1);
  const many = snapshotReads(30, 20);
  const passes = (run: { reads: number; rows: number }): number => run.reads / run.rows;
  assert.ok(few.reads > 0, "a positive control: the snapshot read the counted ledger");
  assert.ok(passes(many) <= passes(few) + 1, `30 open PRs and 20 running tasks cost ${passes(many).toFixed(1)} passes; 2 and 1 cost ${passes(few).toFixed(1)}`);

  // The one-pass answers are the per-item ones: each open head's NEWEST disposition for its CURRENT head, and each
  // running task's spend since its run.start.
  const queue = many.snapshot.prQueue.rows;
  assert.equal(queue.length, 30);
  assert.ok(queue.every((row) => row.disposition === "wait" && row.reason === "checks running"), "the newest row for the current head wins");
  const running = many.snapshot.tasks.filter((row) => row.liveSpendUsd !== undefined);
  assert.equal(running.length, 20);
  assert.ok(running.every((row) => row.liveSpendUsd === 0.25 && row.liveTurns === 4));
  assert.ok(!many.snapshot.tasks.some((row) => row.liveSpendPending), "every running task has logged spend");
});
