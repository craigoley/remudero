// A fleet build that changed only tests and whose filed proof already passed at the merge base found
// nothing to change: main ships the behaviour. The refusal records `pr.open_satisfied_by_main`, and the
// backlog gardener retires the task from that row instead of a human closing a BLOCKED escalation
// (W1-T5689, W1-T5736, W1-T7213 on 2026-10-10).
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import * as backlog from "../src/lib/backlog-gardener.js";
import { fixedClock } from "../src/lib/clock.js";
import type { PlanInventory } from "../src/lib/plan-gardener.js";
import type { Task } from "../src/lib/plan.js";
import { makeTempDir } from "../src/lib/tmp.js";

const NOW = new Date("2026-10-10T04:00:00.000Z");
const ROW = { step: "pr.open_satisfied_by_main", task_id: "W1-T5", branch: "run-W1-T5-1", head_sha: "d".repeat(40), changed_files: ["test/a-regression.test.ts"] };

function fixture(t: { after: (fn: () => void) => void }, task: Task, rows: Record<string, unknown>[]) {
  const root = makeTempDir("satisfied-by-main");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  const rel = `plan/tasks.d/${task.id}.yaml`;
  writeFileSync(join(root, rel), `- id: ${task.id}\n  title: ${task.title}\n${task.priority === undefined ? "" : `  priority: ${task.priority}\n`}  status: queued\n`);
  const shards = new Map([[task.id, rel]]);
  const plan: PlanInventory = { open: [task], all: [task], shards };
  const sources = {
    repoRoot: root,
    plan: () => plan,
    ledger: (steps: readonly string[]) => rows.filter((r) => steps.includes(String(r.step))),
    history: () => [],
    mergedLastDay: () => 2,
    clock: fixedClock(NOW.getTime()),
    fileExists: () => true,
    proofsHolding: () => new Set<string>(),
  } satisfies backlog.BacklogSources;
  return { root, shards, sources, read: () => readFileSync(join(root, rel), "utf8") };
}

const task = (fields: Partial<Task> = {}): Task => ({ id: "W1-T5", title: "pin the shipped behaviour", repo: "remudero", depends_on: [], type: "implement", verify: "auto", risk: "low", status: "queued", attempts: 0, files: ["src/x.ts"], ...fields });

test("a task whose build found nothing to change is retired as closed, citing the build", (t) => {
  const f = fixture(t, task(), [ROW]);
  const inv = backlog.backlogInventory(f.sources);
  assert.deepEqual(inv.candidates[0]?.disposition, { kind: "retire", retirement: "closed" });
  assert.match(inv.candidates[0]!.reason, /run-W1-T5-1/);
  backlog.applyBacklogActions(f.root, f.shards, inv.candidates);
  assert.match(f.read(), /retirement: closed/);
});

test("a declared priority does not hold back a task main already satisfies", (t) => {
  const f = fixture(t, task({ priority: 1 }), [ROW]);
  const inv = backlog.backlogInventory(f.sources);
  assert.equal(inv.candidates[0]?.disposition.kind, "retire");
  backlog.applyBacklogActions(f.root, f.shards, inv.candidates);
  assert.match(f.read(), /retirement: closed/);
});

test("a prioritized task with no satisfied-by-main row keeps its operator priority", (t) => {
  const f = fixture(t, task({ priority: 1 }), []);
  assert.equal(backlog.backlogInventory(f.sources).candidates.length, 0);
});
