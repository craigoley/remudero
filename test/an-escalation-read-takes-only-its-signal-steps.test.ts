/**
 * W1-T13840: latestEscalationLine read a task's whole history to find three steps. Core's DAEMON id names 706,926 fact
 * rows (358 MB), larger than the board's 64 MiB task cache, so every now build re-read all of them twice. An index over
 * the fact store now answers a task's rows of named steps from its step buckets.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createBoardProjection, type Row } from "#src/lib/board-projection.js";
import type { Clock } from "#src/lib/clock.js";
import { createLedgerProjector, openProjectorReadModel } from "#src/lib/ledger-projector.js";
import type { Plan, Task } from "#src/lib/plan.js";
import { acquireLease, type ReadModelDb, type ReadModelStatement } from "#src/lib/read-model-db.js";
import { buildLedgerIndex, ESCALATION_SIGNAL_STEPS, latestEscalationLine, type GitHub, type LedgerIndex } from "#src/lib/status.js";
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
  return { append, index, all, bodies: counted.bodies };
}

const signalsOf = (index: LedgerIndex, id: string): string[] =>
  (index.byTask.get(id) ?? []).filter((r) => r.task_id === id && ESCALATION_SIGNAL_STEPS.includes(String(r.step))).map((r) => JSON.stringify(r));

test("W1-T13840 criterion 1: a store index's byTaskSteps equals the task's own rows of those steps, in ledger order, as the store grows", (t) => {
  const w = world(t, history(T0, 3_000));
  for (let round = 0; round < 3; round++) {
    const index = w.index();
    assert.ok(index.byTaskSteps, "the store index answers byTaskSteps");
    for (const id of IDS) {
      assert.deepEqual(index.byTaskSteps.get(id, ESCALATION_SIGNAL_STEPS).map((r) => JSON.stringify(r)), signalsOf(index, id), `round ${round} ${id}`);
    }
    // New rows, some stamped before rows already held (a late row), extend the cached step buckets.
    w.append([...history(T0 + 7_200_000 + round * 60_000, 300, 3_000 + round * 300),
      { ts: at(T0 + 1_000 + round), step: "run.start", task_id: "W1-T3", run_id: `late-${round}`, host: "h1" }]);
  }
});

test("W1-T13840 criterion 2: invariant:same-escalation — latestEscalationLine over the store index equals it over an in-memory index of the same rows", (t) => {
  const w = world(t, history(T0, 3_000));
  w.append([{ ts: at(T0 + 9_000_000), step: "run.start", task_id: "W1-T1", run_id: "after", host: "h1" }]);
  const store = w.index();
  const rows = store.rows;
  const memory = buildLedgerIndex(w.all);
  let some = 0;
  for (const id of IDS) {
    const viaStore = latestEscalationLine(rows, id, store);
    if (viaStore) some++;
    assert.deepEqual(viaStore, latestEscalationLine(w.all, id, memory), id);
  }
  assert.equal(latestEscalationLine(rows, "W1-T1", store), undefined, "a run after the escalation clears it");
  assert.ok(some >= 2, "the comparison covers open escalations, not only absent ones");
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
