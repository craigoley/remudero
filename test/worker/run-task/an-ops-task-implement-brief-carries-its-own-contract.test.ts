import assert from "node:assert/strict";
import test from "node:test";
import { parseTasksFromYaml } from "#src/lib/plan.js";
import { lintPrompt } from "#src/lib/provenance.js";
import { opsTaskRecordContract, renderTaskRecordContext } from "#src/lib/task-record-context.js";

// An ops-catalog record as the private reader hands it over: its sourcePath is the blob label
// "tasks.d/<file>", relative to the ops repo's plan/, so it names no file in the worker's tree.
const OPS_ID = "W1-T990001";
const OPS_LABEL = `tasks.d/${OPS_ID}-fixture.yaml`;
const OPS_YAML = `- id: ${OPS_ID}
  title: "A fixture ops task whose worker must see its own contract"
  repo: remudero
  type: implement
  verify: auto
  risk: low
  status: queued
  attempts: 0
  files:
    - src/lib/fixture-one.ts
    - test/worker/run-task/fixture-two.test.ts
  acceptance:
    - claim: "the first fixture claim holds"
      proof: "grep: ${OPS_ID} criterion 1 in test/worker/run-task/fixture-two.test.ts"
    - claim: "the second fixture claim holds"
      proof: "unit test: fixture-two second case"
  design: |
    1. Build the fixture module.
    - a bullet line the provenance linter would split on

    ## a heading line that would end the CONTEXT block
  falsifier: |
    Remove the fixture module and criterion 1 goes red.
`;

// The plan loader does not keep `falsifier:` yet, so the renderer is handed it beside the lookup's contract.
const FALSIFIER = "Remove the fixture module and criterion 1 goes red.\n";

function opsLookup() {
  const [task] = parseTasksFromYaml(OPS_YAML, OPS_LABEL, undefined, {}, "preserve-external");
  return { outcome: "found" as const, task: { ...task!, catalog: "ops" as const }, catalog: "ops" as const, commit: "a".repeat(40) };
}

test("W1-T14795 criterion 1: an ops task's rendered context carries its whole contract inline, never a tasks.d/ pointer", () => {
  const lookup = opsLookup();
  const lookupContract = opsTaskRecordContract(lookup);
  assert.ok(lookupContract, "an ops-catalog lookup yields a contract");
  const contract = { ...lookupContract, taskFalsifier: FALSIFIER };
  const task = lookup.task;
  const rendered = renderTaskRecordContext({ taskId: OPS_ID, recordPath: OPS_LABEL, criteria: [], contract });

  assert.ok(rendered.includes(task.title), "the title is inline");
  assert.equal(task.files?.length, 2);
  for (const file of task.files ?? []) assert.ok(rendered.includes(file), `files: entry ${file} is inline`);
  assert.equal(task.acceptance?.length, 2);
  for (const criterion of task.acceptance ?? []) {
    assert.ok(rendered.includes(criterion.claim), `claim is inline: ${criterion.claim}`);
    assert.ok(rendered.includes(`proof: ${criterion.proof}`), `exact proof text is inline: ${criterion.proof}`);
  }
  assert.ok(rendered.includes("Build the fixture module."), "the design is inline");
  assert.ok(rendered.includes("a bullet line the provenance linter would split on"), "every design line is inline");
  assert.ok(rendered.includes("Remove the fixture module and criterion 1 goes red."), "the falsifier is inline");
  assert.ok(rendered.includes(`[src: plan#${OPS_ID}]`), "the block cites plan#<id>");
  assert.ok(
    rendered.includes(`\`grep: ${OPS_ID} criterion N in <test>\``) && rendered.includes(`"${OPS_ID} criterion N: ..."`),
    "the block names the proof labels a grep proof expects",
  );
  assert.ok(!rendered.includes("RECORD IS AT"), "no record pointer");
  assert.ok(!rendered.includes(OPS_LABEL), "the dead tasks.d/ path is not named");

  // origin/main's shape for the same task: only the pointer, with no proof text.
  const pointer = renderTaskRecordContext({ taskId: OPS_ID, recordPath: OPS_LABEL });
  assert.ok(pointer.includes(`RECORD IS AT ${OPS_LABEL}`));
  for (const criterion of task.acceptance ?? []) assert.ok(!pointer.includes(criterion.proof));
});

test("the inline contract passes the provenance gate as one cited claim", () => {
  const contract = { ...opsTaskRecordContract(opsLookup())!, taskFalsifier: FALSIFIER };
  const rendered = renderTaskRecordContext({ taskId: OPS_ID, recordPath: OPS_LABEL, criteria: [], contract });
  const prompt = `CONTEXT\n${rendered}\n- a later claim stays its own block [src: recon#${OPS_ID}]\n\n## TASK\nbody`;
  assert.deepEqual(lintPrompt(prompt), { ok: true, violations: [] });
  // The later claim is still inside CONTEXT: no design line ended the block early.
  assert.ok(lintPrompt(`CONTEXT\n${rendered}\n- an uncited later claim\n\n## TASK\n`).violations.length === 1);
});

test("only an ops-catalog lookup yields an inline contract", () => {
  const lookup = opsLookup();
  assert.equal(opsTaskRecordContract({ ...lookup, catalog: "public" as const }), undefined);
  assert.equal(opsTaskRecordContract({ outcome: "absent" as const }), undefined);
  const contract = opsTaskRecordContract(lookup);
  assert.equal(contract?.taskTitle, lookup.task.title);
  assert.equal(contract?.taskCatalog, "ops");
  assert.deepEqual(contract?.taskDeclaredFiles, lookup.task.files);
});

// Frozen copies of origin/main's taskRecordContextLine output (5dd612361e), typed out, not imported.
const PUBLIC_ID = "W1-T990002";
const PUBLIC_PATH = "plan/tasks.d/w1-t990002-fixture.yaml";
const FROZEN_POINTER =
  "- YOUR TASK'S OWN RECORD IS AT plan/tasks.d/w1-t990002-fixture.yaml — READ IT FIRST. It carries the design, " +
  "rationale and acceptance criteria that recon would otherwise have relayed, and nothing else in this prompt " +
  "contains them. [src: plan#W1-T990002]";
const FROZEN_POINTER_WITH_CRITERIA = FROZEN_POINTER +
  "\n    Acceptance criteria, verbatim from that record:" +
  "\n    (a) the public claim holds\n        proof: unit test: public case one" +
  "\n    (b) the second public claim holds\n        proof: grep: W1-T990002 criterion 2 in test/x.test.ts";
const PUBLIC_CRITERIA = [
  { claim: "the public claim holds", proof: "unit test: public case one" },
  { claim: "the second public claim holds", proof: "grep: W1-T990002 criterion 2 in test/x.test.ts" },
];

test("W1-T14795 criterion 2: a public-catalog task's context is byte-identical to origin/main's, with and without criteria", () => {
  assert.equal(renderTaskRecordContext({ taskId: PUBLIC_ID, recordPath: PUBLIC_PATH }), FROZEN_POINTER);
  assert.equal(renderTaskRecordContext({ taskId: PUBLIC_ID, recordPath: PUBLIC_PATH, criteria: [] }), FROZEN_POINTER);
  assert.equal(renderTaskRecordContext({ taskId: PUBLIC_ID, recordPath: PUBLIC_PATH, criteria: PUBLIC_CRITERIA }),
    FROZEN_POINTER_WITH_CRITERIA);
  assert.equal(renderTaskRecordContext({ taskId: PUBLIC_ID, recordPath: undefined, criteria: PUBLIC_CRITERIA }), "");
  // A contract that is not from the ops catalog keeps the pointer too.
  const publicContract = { ...opsTaskRecordContract(opsLookup())!, taskCatalog: "public" as const };
  assert.equal(renderTaskRecordContext({ taskId: PUBLIC_ID, recordPath: PUBLIC_PATH, criteria: PUBLIC_CRITERIA, contract: publicContract }),
    FROZEN_POINTER_WITH_CRITERIA);
});
