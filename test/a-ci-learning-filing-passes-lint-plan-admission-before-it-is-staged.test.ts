import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { landCiLearningShards } from "#src/lib/feedback-landing.js";
import {
  ciLearningLessonsFile,
  ciLearningRecordVerdict,
  ciLearningShardYaml,
  type CiLearningShardDraft,
} from "#src/lib/measurement-cadence.js";
import { machineShardFilingRefusal } from "#src/lib/machine-filing.js";
import { loadPlanFromYaml } from "#src/lib/plan.js";
import { lintTask } from "#src/lib/task-linter.js";

const draft: CiLearningShardDraft = {
  findingId: "ci-learning:12305:scan-pr / osv-scan",
  title: "teach the scan lane its repaired failure shape",
  gate: "scan-pr / osv-scan",
  pr: 12305,
  prs: [12305],
  repairFiles: ["src/lib/dep-review.ts"],
  dominantRepairFiles: [],
  author_class: "machine",
  verify: "human",
  remedySurface: "learnings/*.yaml",
};
const label = "ci-learning:W1-T10016";
const rendered = ciLearningShardYaml(draft, "W1-T10016");

test("W1-T10041: a rendered ci-learning shard passes lint-plan machine-filing admission", () => {
  assert.equal(machineShardFilingRefusal(rendered, label, { pathExists: () => false }), undefined);
  assert.deepEqual(ciLearningRecordVerdict(rendered, label), { ok: true, reason: "" });
});

test("W1-T10041: a ci-learning record lint-plan would refuse is refused before it is staged", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-ci-learning-admission-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const missing = "learnings/elsewhere/x.yaml";
  const contents = rendered.replaceAll(ciLearningLessonsFile(draft.findingId), missing);
  assert.equal(lintTask(loadPlanFromYaml(contents, label).tasks[0]!).ok, true);
  const reason = machineShardFilingRefusal(contents, label, { pathExists: () => false });
  assert.match(reason!, /machine-filing-admission/);
  assert.match(reason!, /learnings\/elsewhere\/x\.yaml/);
  assert.deepEqual(ciLearningRecordVerdict(contents, label), { ok: false, reason });

  const calls: string[][] = [];
  const repository = { owner: "fixture", repo: "remudero" };
  const result = landCiLearningShards([draft], root, {
    stateRoot: root,
    planOrigins: [],
    mintTaskId: () => "W1-T10016",
    renderShard: () => contents,
    recordVerdict: ciLearningRecordVerdict,
    sourceRepository: repository,
    targetRepository: repository,
    git: (args) => { calls.push(args); return ""; },
    gh: (args) => { calls.push(args); return "[]"; },
  });
  assert.deepEqual(result, { filed: [], skipped: [], refused: [{ findingId: draft.findingId, reason }] });
  assert.equal(existsSync(join(root, "state", "ci-learning-pending")), false);
  assert.equal(calls.some(([verb]) => ["add", "push", "commit-tree", "pr"].includes(verb)), false);
});

test("W1-T10041: admission never borrows an existing path from the daemon checkout", () => {
  const contents = rendered.replaceAll(ciLearningLessonsFile(draft.findingId), "package.json");
  const verdict = ciLearningRecordVerdict(contents, label);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /machine-filing-admission/);
  assert.match(verdict.reason, /exist in neither the checkout nor the base tree: package\.json/);
});
