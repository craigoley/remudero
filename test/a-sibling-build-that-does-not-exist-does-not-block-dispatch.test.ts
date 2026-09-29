import assert from "node:assert/strict";
import { test } from "node:test";
import { loadPlanFromYaml } from "../src/lib/plan.js";
import { nextRunnable } from "../src/lib/drain.js";
import { openSiblingBuild, type PrRef, type StatusProjection } from "../src/lib/status.js";
import { openSiblingObservation } from "../src/run-task.js";

const taskId = "W1-T3116";
const declaredFiles = ["src/run-task.ts"];
const plan = loadPlanFromYaml(`
- id: W1-T3116
  title: repository maintenance
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
`, "fixture");
const changedFiles = () => ["src/run-task.ts"];

test("W1-T4689: a merged filing PR on a run branch is not an open sibling build", () => {
  const mergedFiling: PrRef = {
    number: 4554, url: "https://github.com/craigoley/remudero/pull/4554",
    title: "file W1-T3116", state: "MERGED", headRefName: "run-W1-T3116-1788838731105",
  };
  assert.equal(openSiblingBuild(taskId, declaredFiles, [mergedFiling], changedFiles), undefined);

  // #7431 was open at the breaker timestamp and touched src/run-task.ts, but its run branch
  // identifies W1-T4571. The overlap is real; the claim that it builds W1-T3116 is false.
  const otherTask: PrRef = {
    number: 7431, url: "https://github.com/craigoley/remudero/pull/7431",
    title: "benchmark worker revisions", state: "OPEN", headRefName: "run-W1-T4571-1790504286505",
  };
  const overlap = openSiblingBuild(taskId, declaredFiles, [otherTask], changedFiles);
  assert.equal(overlap?.prNumber, 7431, "the shared-file detector really does see this PR");
  const projection = new Map([[taskId, { openSiblingBuild: overlap } as StatusProjection]]);
  const logged: string[] = [];
  const observation = openSiblingObservation("daemon", () => projection, (step) => logged.push(step));
  assert.equal(observation.openSiblingBuildFor(taskId), undefined, "the foreign run is not this task's build");
  assert.equal(nextRunnable(plan, () => false, observation)?.id, taskId, "dispatch remains eligible");
  assert.deepEqual(logged, [], "no false dispatch.open_sibling_build event is emitted");
});

test("W1-T4689: a closed build is not an open sibling build", () => {
  const closedBuild: PrRef = {
    number: 4596, url: "https://github.com/craigoley/remudero/pull/4596",
    title: "build W1-T3116", state: "CLOSED", headRefName: "run-W1-T3116-1788845350000",
  };
  assert.equal(openSiblingBuild(taskId, declaredFiles, [closedBuild], changedFiles), undefined);
  const observation = openSiblingObservation("daemon", () => new Map(), () => {
    assert.fail("no sibling event expected");
  });
  assert.equal(nextRunnable(plan, () => false, observation)?.id, taskId);
});
