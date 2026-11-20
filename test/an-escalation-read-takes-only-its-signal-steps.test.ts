/**
 * W1-T13840: latestEscalationLine read a task's whole history to find three steps. Core's DAEMON id names 706,926 fact
 * rows (358 MB), larger than the board's 64 MiB task cache, so every now build re-read all of them twice. An index over
 * the fact store now answers a task's rows of named steps from its step buckets.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BOARD_RUN_ACTIVITY_STEP, createBoardProjection, type Row } from "#src/lib/board-projection.js";
import type { Clock } from "#src/lib/clock.js";
import { createLedgerProjector, openProjectorReadModel } from "#src/lib/ledger-projector.js";
import type { Plan, Task } from "#src/lib/plan.js";
import { acquireLease, type ReadModelDb, type ReadModelStatement } from "#src/lib/read-model-db.js";
import {
  buildLedgerIndex, ESCALATION_SIGNAL_STEPS, latestEscalationLine, WORKER_ACTIVITY_STAND_IN_STEP, type GitHub, type LedgerIndex,
} from "#src/lib/status.js";
import { onReadModelClose, readModelFixtureDir } from "#test/helpers/read-model-fixture-dir.js";

const T0 = Date.parse("2026-11-19T08:00:00.000Z");
const at = (ms: number): string => new Date(ms).toISOString();
const task = (id: string): Task => ({ id, title: id, repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 });
const PLAN: Plan = { tasks: [task("W1-T1")], byId: new Map([["W1-T1", task("W1-T1")]]) };
const GATEWAY = {
  readFailed: () => false, prByRef: () => null, findMergedByTrailer: () => null, findMergedByHeadBranch: () => [],
  listMergedHeadBranches: () => [], listOpenHeadBranches: () => [], headRefName: () => undefined, prBody: () => undefined,
  issueByUrl: () => ({ state: "OPEN", title: "issue" }),
} as unknown as GitHub;
const IDS = ["DAEMON", "W1-T1", "W1-T2", "W1-T3", "unfiled"];

/** A noisy history: many rows of other steps per id, escalations, runs after some of them, aliases and equal stamps. */
function history(from: number, n: number, offset = 0): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < n; i++) {
    const k = offset + i;
    const id = k % 4 !== 0 ? "DAEMON" : IDS[(k / 4) % IDS.length]!;
    const ts = at(from + Math.floor(i / 2) * 1_000); // two rows per stamp: order falls to seq
    const step = k % 41 === 7 ? "escalation.issue_opened" : k % 53 === 11 ? "run.start" : k % 97 === 5 ? "primary_shadow.issue_published"
      : k % 2 === 0 ? "implement.done" : "verdict";
    out.push({ ts, step, task_id: id, run_id: `r-${k % 5}`, host: "h1", n: k,
      ...(step.includes("issue") ? { issue_url: `https://github.com/o/r/issues/${k}`, class: "MANUAL" } : {}),
      ...(k % 17 === 0 ? { task: "W1-T2" } : {}) });
  }
  return out;
}

function counting(db: ReadModelDb): { db: ReadModelDb; bodies(): number } {
  let rows = 0;
  const note = (r: Record<string, unknown> | undefined): void => void (r && typeof r.body === "string" && rows++);
  return {
    bodies: () => rows,
    db: { ...db, exec: (sql) => db.exec(sql), meta: (key) => db.meta(key), inTransaction: () => db.inTransaction(), close: () => db.close(),
      prepare: (sql, opts) => {
        const statement = db.prepare(sql, opts);
        if (/WHERE seq > \? ORDER BY seq LIMIT/.test(sql)) return statement; // the ingest's own read
        const counted: ReadModelStatement = {
          run: (...p) => statement.run(...p),
          get: (...p) => { const r = statement.get(...p); note(r); return r; },
          all: (...p) => { const all = statement.all(...p); all.forEach(note); return all; },
          iterate: function* (...p) { for (const r of statement.iterate(...p)) { note(r); yield r; } },
        };
        return counted;
      } },
  };
}

function world(t: { after: (fn: () => void) => void }, rows: Row[]) {
  const root = readModelFixtureDir(t, "escalation-signal-steps").dir;
  const ms = T0 + 86_400_000;
  const clock: Clock = { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() };
  const ledgerDir = join(root, "core", "state");
  mkdirSync(ledgerDir, { recursive: true });
  const raw = openProjectorReadModel(join(root, "home"), "core", clock);
  onReadModelClose(t, () => raw.close());
  const got = acquireLease(raw, { clock, ttlMs: 1e12 });
  assert.ok(got.ok);
  const projector = createLedgerProjector({ ledgerDir, db: raw, lease: got.lease, clock });
  const all: Row[] = [];
  const append = (more: Row[]): void => {
    all.push(...more);
    appendFileSync(join(ledgerDir, "ledger.ndjson"), more.map((r) => `${JSON.stringify(r)}\n`).join(""));
    // One tick ingests a bounded share of the file; tick until the store holds every row.
    for (let i = 0; i < 50; i++) projector.tick();
  };
  append(rows);
  const counted = counting(raw);
  const board = createBoardProjection({ db: counted.db, ledgerPath: join(ledgerDir, "ledger.ndjson"), clock, readPlan: () => PLAN,
    github: GATEWAY, githubGeneration: () => "g1", readCreditStore: () => ({}), readCreditOverrideFile: () => "" });
  const index = (): LedgerIndex => { while (!board.update({ force: true }).caughtUp); return board.index(board.rows()); };
  return { append, index, all, bodies: counted.bodies, board };
}

const ownRowsOf = (index: LedgerIndex, id: string, steps: readonly string[]): readonly Row[] =>
  (index.byTask.get(id) ?? []).filter((r) => r.task_id === id && typeof r.step === "string" && steps.includes(r.step));

test("W1-T13840 criterion 1: a store index's byTaskSteps equals the task's own rows of those steps, in ledger order, as the store grows", (t) => {
  const id = "W1-T4";
  const ts = at(T0 + 1_000);
  const w = world(t, [...history(T0, 3_000),
    { ts, step: "run.start", task_id: id, run_id: "fact" },
    { ts, step: "worker.activity", task_id: id, run_id: "worker", event_kind: "working", served_model: "model" },
    { ts, step: "worker.state", task_id: id, run_id: "fact" },
  ]);
  const mixed = [...ESCALATION_SIGNAL_STEPS, BOARD_RUN_ACTIVITY_STEP, WORKER_ACTIVITY_STAND_IN_STEP];
  for (let round = 0; round < 3; round++) {
    if (round > 0) {
      w.append([...history(T0 + 7_200_000 + round * 60_000, 300, 2_700 + round * 300),
        { ts: at(T0 + round), step: "run.start", task_id: id, run_id: `late-${round}` }]);
    }
    const index = w.index();
    assert.ok(index.byTaskSteps, "the store index answers byTaskSteps");
    for (const steps of [ESCALATION_SIGNAL_STEPS, [BOARD_RUN_ACTIVITY_STEP], [WORKER_ACTIVITY_STAND_IN_STEP], mixed]) {
      for (const taskId of [...IDS, id, "missing"]) {
        assert.deepEqual(index.byTaskSteps.get(taskId, steps), ownRowsOf(index, taskId, steps), `round ${round}, ${taskId}, ${steps}`);
      }
    }
    assert.deepEqual(ownRowsOf(index, id, mixed).map((r) => r.run_id), [
      ...Array.from({ length: round }, (_, i) => `late-${i + 1}`), "fact", "worker", "worker",
    ]);
  }
});

test("byTaskSteps keeps each distinct step set grouped for the lifetime of the index", (t) => {
  const index = world(t, history(T0, 300)).index();
  const lookup = index.byTaskSteps;
  assert.ok(lookup);
  const a = lookup.get("DAEMON", ESCALATION_SIGNAL_STEPS);
  assert.ok(a.length > 0);
  assert.ok(lookup.get("DAEMON", ["verdict"]).length > 0);
  assert.strictEqual(lookup.get("DAEMON", ESCALATION_SIGNAL_STEPS), a, "reuses A after querying B");
  const reordered = [...ESCALATION_SIGNAL_STEPS].reverse();
  assert.strictEqual(lookup.get("DAEMON", [...reordered, reordered[0]!]), a, "permutations and duplicates identify the same set");
});

test("W1-T13840 criterion 2: invariant:same-escalation — latestEscalationLine over the store index equals it over an in-memory index of the same rows", (t) => {
  const openedAt = at(T0 + 2_000);
  const lateOpenedAt = at(T0 + 1_000);
  const issueUrl = "https://github.com/o/r/issues/1";
  const lateIssueUrl = "https://github.com/o/r/issues/2";
  const opened = { ts: openedAt, issue_url: issueUrl, class: "MANUAL" };
  const w = world(t, [
    { ...opened, step: "escalation.issue_opened", task_id: "W1-T1" },
    { ...opened, step: "primary_shadow.issue_published", task_id: "W1-T2" },
    { ts: openedAt, step: "run.start", task_id: "W1-T2", run_id: "same-stamp" },
    { ts: openedAt, step: "run.start", task_id: "W1-T3", run_id: "never-escalated" },
  ]);
  const verify = (expected: Record<string, ReturnType<typeof latestEscalationLine>>): void => {
    const store = w.index();
    const memory = buildLedgerIndex(w.all);
    const projected = w.board.projections();
    for (const [id, answer] of Object.entries(expected)) {
      assert.deepEqual(latestEscalationLine(w.all, id), answer, `${id}, unindexed ledger`);
      assert.deepEqual(latestEscalationLine(w.all, id, memory), answer, `${id}, in-memory index`);
      assert.deepEqual(latestEscalationLine(store.rows, id, store), answer, `${id}, store index`);
      assert.equal(projected.get(id)?.escalationIssueUrl, answer?.issueUrl, `${id}, board projection`);
    }
  };
  verify({ "W1-T1": { issueUrl, escalationClass: "MANUAL", openedAt }, "W1-T2": undefined, "W1-T3": undefined });
  w.append([
    { ts: lateOpenedAt, step: "run.start", task_id: "W1-T1", run_id: "late-run" },
    { ts: lateOpenedAt, step: "escalation.issue_opened", task_id: "W1-T2", issue_url: lateIssueUrl },
  ]);
  verify({
    "W1-T1": undefined,
    "W1-T2": { issueUrl: lateIssueUrl, escalationClass: undefined, openedAt: lateOpenedAt },
    "W1-T3": undefined,
  });
});

test("W1-T13840 criterion 3: a board build reads no fact row of a long-history task's other steps for its escalation", (t) => {
  // DAEMON names no plan task, so only the task-less escalation pass reads it.
  const w = world(t, [...history(T0, 6_000), { ts: at(T0 + 9_000_000), step: "escalation.issue_opened", task_id: "DAEMON",
    issue_url: "https://github.com/o/r/issues/1", class: "MANUAL", host: "h1" }]);
  const before = w.bodies();
  const index = w.index();
  const read = w.bodies() - before;
  const daemonRows = w.all.filter((r) => r.task_id === "DAEMON").length;
  const otherRows = w.all.filter((r) => r.task_id !== "DAEMON" || ESCALATION_SIGNAL_STEPS.includes(String(r.step))).length;
  assert.ok(read <= otherRows, `the build read ${read} fact bodies; every row but DAEMON's non-signal rows is ${otherRows}`);
  assert.ok(daemonRows > otherRows, "the fixture's DAEMON history is the bulk of the store");
  assert.ok(latestEscalationLine(index.rows, "DAEMON", index), "DAEMON's escalation is still read");
});
