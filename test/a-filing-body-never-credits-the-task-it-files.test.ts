/**
 * W1-T3362 — THE FILING EMITTER MUST NOT WRITE A BODY THE FILING GATE REFUSES.
 *
 * `files-and-credits-the-same-task` (W1-T3231, shipped by W1-T1004's refusal) fired nine times in
 * one day, each repaired by hand with the same edit: delete the `Remudero-Task:` trailer. The gate
 * was right; the producer (`buildPlanPrBody`) had no counterpart to it. These tests drive the REAL
 * emitter and feed its output to the REAL gate — not a description of either.
 *
 * THE SECOND HALF IS THE ONE THAT MATTERS: an implementing PR that adds no shard for its own task
 * must keep crediting it, so a "fix" that strips every trailer fails the last test here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPlanPrBody, diffContributesTaskShard, filingAcceptanceCriteria } from "../src/lib/plan-pr-emitter.js";
import { extractTaskTrailerId, filingSelfCreditCheck } from "../src/lib/review.js";
// @ts-expect-error — `scripts/**` sits outside tsconfig's `include`, so this executable .mjs has
// no declaration output (TS7016). The seam is declared below rather than left as `any`, the same
// idiom test/a-filing-pr-is-judged-against-criteria-it-cannot-satisfy.test.ts uses.
import * as authorGate from "../scripts/acceptance-author-gate.mjs";

const evaluateGate = authorGate.evaluateGate as (input: {
  body: string;
  trailerResolves?: (taskId: string) => boolean;
  introducedTaskIds?: readonly string[];
}) => { ok: boolean; defect?: string; message: string };

const FILED_ID = "W1-T9001";
const SHARD = `plan/tasks.d/${FILED_ID}-a-thing-worth-filing.yaml`;

/** The shape a filing flow hands the emitter — including a `taskId`, the very mistake under test. */
function filingBody(taskId: string | undefined): string {
  return buildPlanPrBody({
    intro: `Files ${FILED_ID}.`,
    criteria: filingAcceptanceCriteria([FILED_ID], [SHARD]),
    changedFiles: [SHARD],
    taskId,
  });
}

test("W1-T3362: a filing body for a newly added shard carries no trailer crediting that shard", () => {
  const body = filingBody(FILED_ID);
  assert.equal(extractTaskTrailerId(body), undefined);
  assert.doesNotMatch(body, /Remudero-Task:/);
  // The body is still a judgeable filing body: the acceptance block survives the omitted trailer.
  assert.match(body, /^Acceptance:$/m);
  assert.match(body, new RegExp(`grep: id: ${FILED_ID} in ${SHARD}`));

  // A body that was never handed a task id is unchanged by the guard.
  assert.equal(body, filingBody(undefined));
});

test("W1-T3362: the emitted filing body passes the acceptance author-time gate", () => {
  const body = filingBody(FILED_ID);
  // The gate refuses the SAME body once the self-credit is put back — proving the check below has teeth.
  const credited = `${body.trimEnd()}\n\nRemudero-Task: ${FILED_ID}\n`;
  const refused = evaluateGate({ body: credited, introducedTaskIds: [FILED_ID] });
  assert.equal(refused.ok, false);
  assert.equal(refused.defect, "files-and-credits-the-same-task");

  assert.equal(filingSelfCreditCheck(body, [FILED_ID]).ok, true);
  const gate = evaluateGate({ body, introducedTaskIds: [FILED_ID] });
  assert.equal(gate.ok, true, gate.message);
});

test("W1-T3362: an implementing body keeps its trailer when the diff adds no shard for that task", () => {
  const body = buildPlanPrBody({
    intro: `Implements ${FILED_ID}.`,
    criteria: [{ claim: "the thing works", proof: "unit test: the thing works" }],
    changedFiles: ["src/lib/the-thing.ts", "test/the-thing.test.ts"],
    taskId: FILED_ID,
  });
  assert.equal(extractTaskTrailerId(body), FILED_ID);
  assert.match(body, new RegExp(`\\nRemudero-Task: ${FILED_ID}\\n$`));
  assert.equal(evaluateGate({ body, introducedTaskIds: [] }).defect, undefined);

  // No changed-files list at all: nothing says the diff contributes a shard, so the credit stays.
  const bare = buildPlanPrBody({
    intro: `Implements ${FILED_ID}.`,
    criteria: [{ claim: "the thing works", proof: "unit test: the thing works" }],
    taskId: FILED_ID,
  });
  assert.equal(extractTaskTrailerId(bare), FILED_ID);

  // A shard for a DIFFERENT task in the diff is not this task's record; a prefix of another id is not either.
  const other = buildPlanPrBody({
    intro: `Implements ${FILED_ID}.`,
    criteria: [{ claim: "the thing works", proof: "unit test: the thing works" }],
    changedFiles: ["plan/tasks.d/W1-T90011-another.yaml", "plan/tasks.d/W1-T1-x.yaml"],
    taskId: FILED_ID,
  });
  assert.equal(extractTaskTrailerId(other), FILED_ID);

  // A plan task that merely EDITS its own existing shard still credits itself when the caller says the
  // shard was not added (W1-T1004: some tasks deliver plan text).
  const edit = buildPlanPrBody({
    intro: `Implements ${FILED_ID}.`,
    criteria: [{ claim: "the shard says it", proof: `grep: id: ${FILED_ID} in ${SHARD}` }],
    changedFiles: [SHARD],
    addedFiles: [],
    taskId: FILED_ID,
  });
  assert.equal(extractTaskTrailerId(edit), FILED_ID);
});

test("W1-T3362: the shard predicate matches the record's own path and nothing that merely shares a prefix", () => {
  assert.equal(diffContributesTaskShard(FILED_ID, [SHARD]), true);
  assert.equal(diffContributesTaskShard(FILED_ID, ["plan/tasks.d/W1-T90011-x.yaml"]), false);
  assert.equal(diffContributesTaskShard(FILED_ID, [`src/${FILED_ID}-x.yaml`]), false);
  assert.equal(diffContributesTaskShard(FILED_ID, []), false);
});
