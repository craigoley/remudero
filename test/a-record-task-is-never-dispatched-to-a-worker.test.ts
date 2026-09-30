import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTasksFromYaml, type Plan, type Task } from "../src/lib/plan.js";
import { nextRunnable, recordTaskRoutedLogger, runnableCandidates, type MergedSet } from "../src/lib/drain.js";
import { isRecordTask, lintTask } from "../src/lib/task-linter.js";

// W1-T4818 — a task whose EVERY acceptance proof greps its own plan/tasks.d shard has nothing for a
// worker to build. The drain routes it away from workers; the plan lint only warns, never refuses.

const NONE_MERGED: MergedSet = () => false;
const SHARD = "plan/tasks.d/W1-T9001-a-record.yaml";
const OTHER = "plan/tasks.d/W1-T9002-a-build.yaml";

function shard(id: string, path: string, proofs: string[], verify = "auto"): string {
  const acceptance = proofs
    .map((p, i) => `    - claim: "claim ${i + 1}"\n      proof: '${p}'\n`)
    .join("");
  return (
    `- id: ${id}\n  title: t ${id}\n  repo: remudero\n  type: implement\n  verify: ${verify}\n` +
    `  depends_on: []\n  status: queued\n  files: [src/lib/drain.ts]\n  acceptance:\n${acceptance}`
  );
}

function taskFrom(text: string, path: string): Task {
  return parseTasksFromYaml(text, path)[0];
}

function planOf(...tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

const SELF_PROOFS = [`grep: alpha phrase in ${SHARD}`, `grep: beta phrase in ${SHARD}`];

test("W1-T4818: a task whose every proof greps its own shard is routed to the judge, never to a worker", () => {
  const record = taskFrom(shard("W1-T9001", SHARD, SELF_PROOFS), SHARD);
  assert.equal(isRecordTask(record), true);
  const plan = planOf(record);
  const routed: string[] = [];
  const opts = { onRecordTaskRouted: (t: Task) => routed.push(t.id) };
  assert.equal(nextRunnable(plan, NONE_MERGED, opts), undefined);
  assert.deepEqual(runnableCandidates(plan, NONE_MERGED, 4, opts), []);
  assert.deepEqual([...new Set(routed)], ["W1-T9001"]);
});

test("W1-T4818: the routing ledger line is written once per task per drain run", () => {
  const record = taskFrom(shard("W1-T9001", SHARD, SELF_PROOFS), SHARD);
  const lines: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const seen = new Set<string>();
  const hook = recordTaskRoutedLogger(seen, (event, detail) => lines.push({ event, detail }));
  hook(record);
  hook(record);
  assert.deepEqual(lines, [{ event: "dispatch.record_task_routed", detail: { task: "W1-T9001" } }]);
  assert.deepEqual([...seen], ["W1-T9001"]);
});

test("W1-T4818: the plan lint warns on that shape and never refuses it", () => {
  const record = taskFrom(shard("W1-T9001", SHARD, SELF_PROOFS), SHARD);
  const result = lintTask(record);
  const hits = result.violations.filter((v) => v.check === "record-task");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].severity, "warn");
  assert.match(hits[0].message, /verify: human/);
  assert.match(hits[0].message, /real proofs/);
  // Never a refusal, even when the lint is asked to be as strict as it can be.
  const strict = lintTask(record, { proofSelfPath: "block" });
  assert.equal(strict.violations.filter((v) => v.check === "record-task").every((v) => v.severity === "warn"), true);
});

test("W1-T4818: a task with one proof outside its shard is dispatched as before", () => {
  const mixed = taskFrom(shard("W1-T9002", OTHER, [`grep: alpha phrase in ${OTHER}`, "grep: isRecordTask in src/lib/drain.ts"]), OTHER);
  assert.equal(isRecordTask(mixed), false);
  const routed: string[] = [];
  const opts = { onRecordTaskRouted: (t: Task) => routed.push(t.id) };
  assert.equal(nextRunnable(planOf(mixed), NONE_MERGED, opts)?.id, "W1-T9002");
  assert.deepEqual(routed, []);
  assert.equal(lintTask(mixed).violations.some((v) => v.check === "record-task"), false);
  // A task with no proofs at all is not a record task either.
  const bare = taskFrom(shard("W1-T9003", OTHER, []), OTHER);
  assert.equal(isRecordTask(bare), false);
});
