// W1-T5363: the backlog gardener's ledger read is bounded to the steps its examined shards cite
// (plus the class-value step its evidence always reads), and its candidates are unchanged.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import * as backlog from "../src/lib/backlog-gardener.js";
import { fixedClock } from "../src/lib/clock.js";
import type { GardenerDeps } from "../src/lib/gardener.js";
import { readLedgerUnionRecordsSync } from "../src/lib/ledger-union.js";
import type { PlanInventory } from "../src/lib/plan-gardener.js";
import type { Task } from "../src/lib/plan.js";
import { deriveTaskClass } from "../src/lib/task-class.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

const NOW_MS = Date.parse("2026-10-01T12:00:00.000Z");
const CLASS_VALUE_STEP = "dispatch.value.calibrated";

function task(id: string, fields: Partial<Task> = {}): Task {
  return { id, title: `task ${id}`, repo: "remudero", depends_on: [], type: "implement", verify: "auto", risk: "low", status: "queued", attempts: 0, files: [`src/${id}.ts`], ...fields };
}

function fixture(t: { after: (fn: () => void) => void }, tasks: Task[]) {
  const root = mkdtempSync(join(tmpdir(), "rmd-backlog-steps-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const shards = new Map<string, string>();
  for (const item of tasks) {
    const rel = `plan/tasks.d/${item.id}.yaml`;
    shards.set(item.id, rel);
    writeFileSync(join(root, rel), `- id: ${item.id}\n  title: ${item.title}\n${item.priority === undefined ? "" : `  priority: ${item.priority}\n`}  status: queued\n`);
  }
  const plan: PlanInventory = { open: tasks, all: tasks, shards };
  const overrides: Partial<backlog.BacklogSources> = {
    repoRoot: root,
    plan: () => plan,
    history: () => [],
    mergedLastDay: () => 5,
    clock: fixedClock(NOW_MS),
    fileExists: () => true,
    proofsHolding: () => new Set(),
  };
  const garden: GardenerDeps = {
    stateDir, repoRoot: root, log: () => {},
    openWorkspace: () => ({ root, land: () => undefined, dispose: () => {} }),
  };
  return { root, stateDir, overrides, garden };
}

function recordingReader() {
  const calls: Array<Parameters<typeof readLedgerUnionRecordsSync>[1]> = [];
  const returned: Array<Record<string, unknown>> = [];
  const reader: typeof readLedgerUnionRecordsSync = (dir, options, fs) => {
    calls.push(options);
    const result = readLedgerUnionRecordsSync(dir, options, fs);
    returned.push(...result.rows);
    return result;
  };
  return { calls, returned, reader };
}

const cited = [
  task("W1-T1", { rationale: "Observed merge.refused rising in `src/lib/x.ts` and plan.md notes." }),
  task("W1-T2", { title: "fix pr.opened noise" }),
  // An operator-owned priority is never examined, so its cited step must not be read.
  task("W1-T3", { priority: 1, rationale: "Observed secret.uncited.step." }),
];

test("the-backlog-gardener-reads-only-the-ledger-steps-its-shards-cite.test.ts: the read passes exactly the cited steps and keeps the candidates of the unfiltered read", (t) => {
  const f = fixture(t, cited);
  const noise = Array.from({ length: 300 }, (_, i) => ({ step: "heartbeat.tick", ordinal: i, ts: "2026-10-01T11:00:00.000Z" }));
  writeLedger([
    { step: "merge.refused", ts: "2026-10-01T10:00:00.000Z" },
    { step: "merge.refused", ts: "2026-10-01T11:00:00.000Z" },
    { step: "secret.uncited.step", ts: "2026-10-01T11:00:00.000Z" },
    { step: CLASS_VALUE_STEP, task_class: deriveTaskClass(cited[0]!), mean: 0.7, attempts: 9, ts: "2026-10-01T09:00:00.000Z" },
    ...noise,
  ], { dir: f.stateDir, rotations: [
    { at: "2026-09-29T00:00:00.000Z", rows: [{ step: "merge.refused", ts: "2026-09-28T10:00:00.000Z" }, { step: "pr.opened", ts: "2026-09-28T11:00:00.000Z" }, ...noise] },
    { at: "2026-09-30T12:00:00.000Z", gz: true, rows: [{ step: "pr.opened", ts: "2026-09-30T10:00:00.000Z" }, { step: CLASS_VALUE_STEP, task_class: deriveTaskClass(cited[0]!), mean: 0.4, attempts: 3, ts: "2026-09-30T09:00:00.000Z" }] },
  ] });

  const rec = recordingReader();
  const filtered = backlog.backlogGardenSpec(f.garden, f.overrides, rec.reader).inventory();
  assert.equal(rec.calls.length, 1, "one bounded union read per pass");
  assert.deepEqual([...(rec.calls[0]?.step ?? [])].sort(), [CLASS_VALUE_STEP, "merge.refused", "pr.opened"]);
  assert.equal(rec.calls[0]?.refuseIncomplete, true, "a bounded read still refuses an incomplete union");
  const kept = new Set(rec.returned.map((r) => r.step));
  assert.deepEqual([...kept].sort(), [CLASS_VALUE_STEP, "merge.refused", "pr.opened"], "rows of uncited steps are never materialised");

  const unfiltered = backlog.backlogInventory({
    ...(f.overrides as backlog.BacklogSources),
    ledger: () => readLedgerUnionRecordsSync(f.stateDir, { refuseIncomplete: true }).rows,
  });
  assert.ok(filtered.candidates.length === 2, "positive control: both unowned shards are proposed");
  const first = filtered.candidates.find((c) => c.target === "W1-T1")!;
  assert.deepEqual(first.evidence.symptoms, [{ step: "merge.refused", recent: 2, previousDay: 0, earlier: 1 }]);
  assert.deepEqual(first.evidence.classValue, { mean: 0.7, attempts: 9 }, "the class-value step survives the filter");
  assert.deepEqual(filtered.candidates, unfiltered.candidates);
});

test("the backlog gardener's citation rule is shared by its read and its evidence", () => {
  const item = cited[0]!;
  assert.deepEqual(backlog.backlogCitedSteps(item), ["merge.refused"], "file names are not steps");
  const evidence = backlog.backlogEvidence(item, "/nonexistent", new Map(), [], [], fixedClock(NOW_MS).date(), () => false, false);
  assert.deepEqual(evidence.symptoms.map((s) => s.step), backlog.backlogCitedSteps(item));
});

test("a plan whose shards cite no step reads only the class-value step, and nothing to examine reads no ledger", (t) => {
  const quiet = fixture(t, [task("W1-T4")]);
  writeLedger([{ step: "heartbeat.tick", ts: "2026-10-01T11:00:00.000Z" }], { dir: quiet.stateDir });
  const rec = recordingReader();
  backlog.backlogGardenSpec(quiet.garden, quiet.overrides, rec.reader).inventory();
  assert.deepEqual(rec.calls.map((c) => c?.step), [[CLASS_VALUE_STEP]]);
  assert.deepEqual(rec.returned, []);

  const owned = fixture(t, [task("W1-T5", { priority: 1, rationale: "Observed merge.refused." })]);
  const none = recordingReader();
  const inv = backlog.backlogGardenSpec(owned.garden, owned.overrides, none.reader).inventory();
  assert.equal(none.calls.length, 0, "no examinable shard reads no ledger at all");
  assert.deepEqual(inv.candidates, []);
});

test("the bounded read still refuses an incomplete ledger union", (t) => {
  const f = fixture(t, [cited[0]!]);
  writeLedger([{ step: "merge.refused", ts: "2026-10-01T11:00:00.000Z" }], { dir: f.stateDir });
  writeFileSync(join(f.stateDir, "ledger.2026-09-30T00-00-00-000Z.ndjson.gz"), "not a gzip archive");
  assert.throws(() => backlog.backlogGardenSpec(f.garden, f.overrides).inventory(), /backlog gardener: incomplete ledger union/);
});
