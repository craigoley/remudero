/**
 * THE JUDGE REFUSED SHARDS FOR LACKING EVIDENCE THAT WAS SITTING IN THE RECORD.
 *
 * `parkedVerifyHumanShards` passed `rationale` as the only free text. MEASURED over the 42
 * machine-filed CI-learning shards: ZERO carry a `rationale`, and ALL 42 carry `ci_learning_prs`.
 * So the judge was handed a title claiming "THE ci-gate GATE REFUSED 36 PULL REQUESTS IN THIS
 * WINDOW" with no pull requests, and refused it in those words:
 *
 *     "references '36 PULL REQUESTS IN THIS WINDOW' without providing the PR list, time window"
 *
 * THE REFUSAL WAS CORRECT ON ITS INPUT. The input was impoverished — twice over:
 *
 *   1. the projection passed only `rationale`, which these records do not have; and
 *   2. `loadPlan` DROPPED `ci_learning_prs` entirely, because the field was absent from the Task
 *      schema. The miner wrote the corpus and every consumer read a task without it.
 *
 * So this is not a judge that is too strict, and not a miner that records too little. It is
 * evidence written at one end of the pipe and discarded before the other.
 *
 * BOUNDED BY DESIGN. These records' `note` runs to a hundred-plus file paths from a single
 * repair; passing it whole would spend the judge's context on noise and bury the signal. The
 * corpus goes as a count plus a head sample, the note as its leading sentence only.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan } from "../src/lib/plan.js";
import { parkedVerifyHumanShards } from "../src/run-task.js";

const clock = { now: () => Date.UTC(2026, 8, 22), date: () => new Date(Date.UTC(2026, 8, 22)), iso: () => "2026-09-22T00:00:00.000Z" };

function planWith(extra: string): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-ev-"));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(
    join(root, "plan", "tasks.yaml"),
    ["- id: W1-T9100", '  title: "THE ci-gate GATE REFUSED 36 PULL REQUESTS IN THIS WINDOW"', "  repo: remudero",
     "  type: implement", "  verify: human", "  status: queued", "  depends_on: []", extra, ""].join("\n"),
    "utf8",
  );
  return root;
}

test("the PR corpus survives the plan loader — it used to be dropped", () => {
  const root = planWith("  ci_learning_prs: [5289, 5318, 5321]");
  const task = loadPlan(join(root, "plan", "tasks.yaml")).byId.get("W1-T9100");
  assert.deepEqual(task?.ci_learning_prs, [5289, 5318, 5321], "the loader must carry the corpus the miner wrote");
});

test("a shard with no rationale still reaches the judge WITH its corpus", () => {
  // The exact shape of all 42: no rationale, a corpus in the record.
  const root = planWith("  ci_learning_prs: [5289, 5318, 5321]\n  origin: \"ci-learning:5289:ci-gate\"");
  const plan = loadPlan(join(root, "plan", "tasks.yaml"));
  const [shard] = parkedVerifyHumanShards(plan, root, clock);
  assert.equal(shard?.rationale, "", "these records genuinely have no rationale");
  assert.ok(shard?.evidence, "so evidence must carry what the record does hold");
  assert.match(shard.evidence, /3 pull request/, "the corpus size must be stated");
  assert.match(shard.evidence, /5289/, "and the corpus itself must be reachable");
  assert.match(shard.evidence, /ci-learning:5289:ci-gate/, "the origin key identifies the gate");
});

test("evidence is BOUNDED — a giant note is summarised, not pasted", () => {
  const huge = "Filed by the ci-learning rung. " + Array.from({ length: 200 }, (_, i) => `src/lib/f${i}.ts`).join(", ");
  const root = planWith(`  ci_learning_prs: [1, 2]\n  note: "${huge}"`);
  const plan = loadPlan(join(root, "plan", "tasks.yaml"));
  const [shard] = parkedVerifyHumanShards(plan, root, clock);
  assert.ok(shard?.evidence);
  assert.ok(shard.evidence.length < 800, `evidence must stay bounded, got ${shard.evidence.length} chars`);
  assert.ok(!shard.evidence.includes("f199.ts"), "the path dump must not be pasted whole");
});

test("ABSENT STAYS ABSENT — a shard carrying no evidence reports none", () => {
  // Re-creating the defect in reverse would be just as bad: a shard with nothing to show must not
  // be dressed up as one that has evidence.
  const root = planWith("  priority: 1");
  const plan = loadPlan(join(root, "plan", "tasks.yaml"));
  const [shard] = parkedVerifyHumanShards(plan, root, clock);
  assert.equal(shard?.evidence, undefined, "no evidence must read as undefined, never an empty string");
});
