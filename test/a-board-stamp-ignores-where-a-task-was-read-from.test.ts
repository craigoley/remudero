/**
 * W1-T14326: a board projection stamped each task by hashing the whole parsed object, `sourcePath` included. Serve's
 * plan pin labels every blob `<ref>:<path>` and plan.ts copies that label onto each reused task, so every adopted ref
 * moved every stamp: all 6,220 of core's tasks re-derived on each merge to main, about 20 s of CPU on the Azure host.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BOARD_DERIVE_DEBOUNCE_MS, createBoardProjection } from "#src/lib/board-projection.js";
import type { Clock } from "#src/lib/clock.js";
import { createLedgerProjector, openProjectorReadModel } from "#src/lib/ledger-projector.js";
import { mergePlanBlobsQuarantiningDuplicates, PlanBlobCache, type Plan } from "#src/lib/plan.js";
import { acquireLease } from "#src/lib/read-model-db.js";
import type { GitHub } from "#src/lib/status.js";
import { onReadModelClose, readModelFixtureDir } from "#test/helpers/read-model-fixture-dir.js";

const T0 = Date.parse("2026-11-22T02:00:00.000Z");
const IDS = Array.from({ length: 12 }, (_, i) => `W1-T${i + 1}`);
const GITHUB = {
  readFailed: () => false, prByRef: () => null, findMergedByTrailer: () => null, findMergedByHeadBranch: () => [],
  listMergedHeadBranches: () => [], listOpenHeadBranches: () => [], headRefName: () => undefined, prBody: () => undefined,
  issueByUrl: () => null,
} as unknown as GitHub;
const record = (id: string, title: string): string => `- id: ${id}\n  title: ${title}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n`;

/** The plan as serve's pin builds it at `ref`: one cached parse per blob, each task labelled `<ref>:<path>`. */
function pinned(cache: PlanBlobCache, ref: string, titles: Record<string, string> = {}): Plan {
  const blobs = [{ label: `${ref}:plan/tasks.yaml`, text: "[]\n" },
    ...IDS.map((id) => ({ label: `${ref}:plan/tasks.d/${id}-x.yaml`, text: record(id, titles[id] ?? `${id} title`) }))];
  return mergePlanBlobsQuarantiningDuplicates(blobs, cache).plan;
}

function world(t: { after: (fn: () => void) => void }) {
  const root = readModelFixtureDir(t, "board-stamp-label").dir;
  const dir = join(root, "core", "state");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ledger.ndjson"), IDS.map((id, i) => `${JSON.stringify({
    ts: new Date(T0 - 3_600_000 + i * 1_000).toISOString(), step: "verdict", task_id: id, run_id: `r-${id}`, verdict: "no_pr", host: "h1",
  })}\n`).join(""));
  let now = T0;
  const clock: Clock = { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() };
  const db = openProjectorReadModel(join(root, "home"), "core", clock);
  onReadModelClose(t, () => db.close());
  const got = acquireLease(db, { clock, ttlMs: 1e12 });
  assert.ok(got.ok);
  const projector = createLedgerProjector({ ledgerDir: dir, db, lease: got.lease, clock });
  for (let i = 0; i < 20; i++) projector.tick();
  const cache = new PlanBlobCache();
  let plan = pinned(cache, "a".repeat(40));
  const board = () => createBoardProjection({
    db, lease: got.lease, ledgerPath: join(dir, "ledger.ndjson"), clock, readPlan: () => plan, github: GITHUB, githubGeneration: () => "g1",
    readCreditStore: () => ({}), readCreditOverrideFile: () => "", oracleSlices: 1,
  });
  return {
    board,
    later: () => void (now += BOARD_DERIVE_DEBOUNCE_MS),
    adopt: (ref: string, titles?: Record<string, string>) => {
      const before = plan;
      plan = pinned(cache, ref, titles);
      assert.notEqual(plan.tasks[0]!.sourcePath, before.tasks[0]!.sourcePath, "control: the new pin relabelled the tasks");
    },
  };
}

test("W1-T14326 criterion 1: a plan adopted at a new ref with the same content re-derives no task", (t) => {
  const w = world(t);
  const board = w.board();
  assert.equal(board.update({ force: true }).full, true, "control: the first derive derives every task");
  w.adopt("b".repeat(40));
  w.later();
  assert.deepEqual(board.update({ force: true }).rederived, []);
});

test("W1-T14326 criterion 2: invariant:content-still-moves — a changed task at a new ref re-derives, only that task does, and the board equals a full derive", (t) => {
  const w = world(t);
  const board = w.board();
  board.update({ force: true });
  w.adopt("b".repeat(40), { "W1-T7": "a new title" });
  w.later();
  assert.deepEqual(board.update({ force: true }).rederived, ["W1-T7"]);
  const audit = board.oracle();
  assert.equal(audit.compared, IDS.length, "control: the oracle compared every task");
  assert.deepEqual(audit.mismatches, []);
});

test("W1-T14326 criterion 3: a restarted board reuses projections persisted under an earlier ref", (t) => {
  const w = world(t);
  w.board().update({ force: true });
  w.adopt("c".repeat(40));
  w.later();
  const restarted = w.board();
  let update = restarted.update({ force: true });
  while (!update.caughtUp) update = restarted.update({ force: true });
  assert.deepEqual(update.rederived, []);
});
