import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTasksFromYaml, type Plan, type Task } from "../src/lib/plan.js";
// Namespace import: the new symbols resolve to `undefined` at base instead of failing the load.
import * as drain from "../src/lib/drain.js";

// W1-T5351 — the fleet GitHub App has no `workflows` permission (operator decision 2026-10-02), so a
// worker's push touching .github/workflows/ is remote-rejected after a whole build. A task whose
// `files:` names such a path is declined with reason `operator-build` and left for an operator.

const NONE_MERGED: drain.MergedSet = () => false;
const WORKFLOW_FILES = "[.github/workflows/ci.yml, src/x.ts]";

function shard(id: string, files: string, verify = "auto"): Task {
  const path = `plan/tasks.d/${id}-t.yaml`;
  const text =
    `- id: ${id}\n  title: t ${id}\n  repo: remudero\n  type: implement\n  verify: ${verify}\n` +
    `  depends_on: []\n  status: queued\n  files: ${files}\n  acceptance:\n` +
    `    - claim: "c"\n      proof: "unit test: test/${id}.test.ts"\n`;
  return parseTasksFromYaml(text, path)[0];
}

function planOf(...tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

type Row = { event: string; detail: Record<string, unknown> };

test("W1-T5351: a task whose files list a path under .github/workflows/ is declined with reason operator-build", () => {
  const wf = shard("W1-T9101", WORKFLOW_FILES);
  const plain = shard("W1-T9102", "[src/x.ts, docs/.github-notes.md]");
  const filtered: Array<[string, string]> = [];
  const routed: string[] = [];
  const opts = {
    onFiltered: (t: Task, reason: string) => filtered.push([t.id, reason]),
    onOperatorBuildRouted: (t: Task) => routed.push(t.id),
  } as drain.NextRunnableOpts;
  const ids = drain.runnableCandidates(planOf(wf, plain), NONE_MERGED, 4, opts).map((t) => t.id);
  assert.deepEqual(ids, ["W1-T9102"], "the workflow-editing task is never offered to a worker");
  assert.deepEqual(filtered, [["W1-T9101", "operator-build"]]);
  assert.deepEqual(routed, ["W1-T9101"]);
  assert.equal(drain.nextRunnable(planOf(wf), NONE_MERGED, opts), undefined);
});

test("W1-T5351: an operator-released id is still declined — release lifts verify: human, not the App's missing permission", () => {
  const human = shard("W1-T9103", "[./.github/workflows/release.yml]", "human");
  const auto = shard("W1-T9104", WORKFLOW_FILES);
  const filtered: Array<[string, string]> = [];
  const opts = {
    releasedIds: new Set(["W1-T9103", "W1-T9104"]),
    onFiltered: (t: Task, reason: string) => filtered.push([t.id, reason]),
  } as drain.NextRunnableOpts;
  assert.deepEqual(drain.runnableCandidates(planOf(human, auto), NONE_MERGED, 4, opts), []);
  assert.deepEqual(filtered, [["W1-T9103", "operator-build"], ["W1-T9104", "operator-build"]]);
});

test("W1-T5351: a task with no workflow path is offered as before, and the census names the new bucket", () => {
  const plain = shard("W1-T9105", "[src/lib/drain.ts, .github/CODEOWNERS]");
  const wf = shard("W1-T9106", WORKFLOW_FILES);
  const tally = drain.tallyDispatchFilters();
  const routed: string[] = [];
  const opts = { onFiltered: tally.onFiltered, onOperatorBuildRouted: (t: Task) => routed.push(t.id) } as drain.NextRunnableOpts;
  assert.equal(drain.nextRunnable(planOf(plain), NONE_MERGED, opts)?.id, "W1-T9105");
  assert.deepEqual(routed, []);
  drain.runnableCandidates(planOf(wf), NONE_MERGED, 4, opts);
  const snap = tally.snapshot() as unknown as Record<string, { count: number; ids: string[] }>;
  assert.deepEqual(snap["operator-build"], { count: 1, ids: ["W1-T9106"], truncated: 0 });
});

test("W1-T5351: the routing ledger row names the task and its workflow paths once per drain run", () => {
  const wf = shard("W1-T9107", WORKFLOW_FILES);
  const rows: Row[] = [];
  const hook = drain.operatorBuildRoutedLogger(new Set<string>(), (event, detail) => rows.push({ event, detail }));
  hook(wf);
  hook(wf);
  assert.deepEqual(rows, [{ event: "dispatch.operator_build_routed", detail: { task: "W1-T9107", paths: [".github/workflows/ci.yml"] } }]);
});

test("W1-T5351: both drain loops log one operator_build_routed row and never dispatch the task", async () => {
  const wf = shard("W1-T9108", WORKFLOW_FILES);
  for (const laneCount of [1, 2]) {
    const rows: Row[] = [];
    const summary = await drain.runDrain(planOf(wf), {
      refreshMerged: () => NONE_MERGED,
      runOne: async () => { throw new Error("a workflow-editing task must never reach a worker"); },
      log: (event: string, detail: Record<string, unknown>) => rows.push({ event, detail }),
    } as never, { max: 1, laneCount, headroomEnabled: false });
    assert.equal(summary.stopReason, "no_runnable");
    assert.deepEqual(
      rows.filter((r) => r.event === "dispatch.operator_build_routed"),
      [{ event: "dispatch.operator_build_routed", detail: { task: "W1-T9108", paths: [".github/workflows/ci.yml"] } }],
      `laneCount=${laneCount} must name the routed task exactly once`,
    );
  }
});
