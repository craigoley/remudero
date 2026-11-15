// W1-T12025: on 2026-11-10 the flow-remedy gardener failed its pass with "flow plan shards unreadable:
// plan/tasks.d/W1-T11062-...yaml: PlanError: task W1-T11062: superseded_by unknown task 'W1-T11172'". W1-T11172 is on
// main in its own shard. The ladder read each shard as a whole plan, so any reference to another shard was unknown.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FIX_LANE_LADDER } from "#src/lib/fix-lane-gardener.js";
import { FLOW_LADDER, readLadderPlan } from "#src/lib/flow-remedy-gardener.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

function shard(id: string, origin: string, extra = ""): string {
  return `- id: ${id}
  title: remedy
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: low
  status: queued
  attempts: 0
  origin: "${origin}"
  files: [src/lib/sweep.ts]
  acceptance: [{claim: fixed, proof: "unit test: fixed"}]
${extra}`;
}

function planRepo(t: { after: (fn: () => void) => void }, shards: Record<string, string>): GitRepo {
  const repo = gitRepo({ kind: "ladder-plan-shards" });
  t.after(() => repo.cleanup());
  mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });
  for (const [name, text] of Object.entries(shards)) writeFileSync(join(repo.dir, "plan", "tasks.d", name), text);
  repo.git("add", ".");
  repo.git("commit", "-q", "-m", "chore(plan): file the fixture shards");
  repo.addRemote("origin", repo.dir);
  repo.git("fetch", "origin");
  return repo;
}

const FLOW_ORIGIN = "flow-blocker:conflict:merge conflict (mergeState dirty)";

test("W1-T12025 criterion 1: a ladder shard that names a task in another shard is read, not reported unreadable", (t) => {
  const repo = planRepo(t, {
    "W1-T9201.yaml": shard("W1-T9201", FLOW_ORIGIN, "  superseded_by: W1-T9202\n"),
    "W1-T9202.yaml": shard("W1-T9202", "operator-session#conflict-gardener"),
    "W1-T9203.yaml": shard("W1-T9203", "flow-blocker:escalated:metadata-only body red").replace("depends_on: []", "depends_on: [W1-T9202]"),
  });
  const flow = readLadderPlan(repo.dir, FLOW_LADDER);
  assert.deepEqual(flow.unreadable, [], "the references resolve in the plan, not in the one shard");
  assert.deepEqual(flow.tasks.map((task) => task.id).sort(), ["W1-T9201", "W1-T9203"], "only the ladder's own origins are its tasks");
});

test("W1-T12025 criterion 2: a shard that is not valid plan YAML or breaks the task schema is still reported unreadable, by path", (t) => {
  const repo = planRepo(t, {
    "W1-T9211.yaml": shard("W1-T9211", FLOW_ORIGIN),
    "W1-T9212.yaml": `${shard("W1-T9212", FLOW_ORIGIN)}  superseded_by: 7\n`,
    "W1-T9213.yaml": `- id: W1-T9213\n  origin: "${FLOW_ORIGIN}"\n  title: [unclosed\n`,
  });
  const flow = readLadderPlan(repo.dir, FLOW_LADDER);
  assert.deepEqual(flow.tasks.map((task) => task.id), ["W1-T9211"]);
  assert.equal(flow.unreadable?.length, 2);
  assert.match(flow.unreadable!.join("\n"), /W1-T9212\.yaml: .*superseded_by must be a task id/);
  assert.match(flow.unreadable!.join("\n"), /W1-T9213\.yaml: .*not valid YAML/);
});

test("W1-T12025 criterion 3: the fix-lane ladder reads through the same function and gets the same answer", (t) => {
  const repo = planRepo(t, {
    "W1-T9221.yaml": shard("W1-T9221", `${FIX_LANE_LADDER.prefix}:stalled:fix worker exited`, "  superseded_by: W1-T9222\n"),
    "W1-T9222.yaml": shard("W1-T9222", "operator-session#fix-lane"),
  });
  const fixLane = readLadderPlan(repo.dir, FIX_LANE_LADDER);
  assert.deepEqual([fixLane.unreadable, fixLane.tasks.map((task) => task.id)], [[], ["W1-T9221"]]);
});
