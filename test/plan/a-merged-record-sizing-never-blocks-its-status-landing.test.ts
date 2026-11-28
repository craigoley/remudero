// W1-T15273: a merged or done record's Rule 19 sizing span is reported, not refused, so an ops
// status-reconcile landing that flips it to merged passes the ops gate's core lint. Open records
// (queued, blocked without retirement) keep exactly today's sizing block.
//
// The fixture is W1-T14556's real record text, read 2026-11-28 from remudero-ops main, parsed the
// way scripts/core-lint-changed-records.mts parses it (mergePlanBlobs, logLevel error,
// dependencyMode preserve-external) under the ops gate's full-path label and the ops read label.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mergePlanBlobs, type Task, type TaskStatus } from "#src/lib/plan.js";
import { lintTask, sizingViolation } from "#src/lib/task-linter.js";

const W1_T14556_FILE = "W1-T14556-a-triage-relint-keeps-cross-catalog-dependencies-when-it-loads-the-plan.yaml";

const W1_T14556_RECORD = `- id: W1-T14556
  title: "A triage relint keeps cross-catalog dependencies when it loads the plan, so one existing edge does not fail every triage"
  repo: remudero
  depends_on: []
  priority: 1
  type: implement
  verify: auto
  principles: {tdd: strict}
  risk: medium # changes how the relint loads the plan; the filed-id lint is unchanged
  origin: "operator-session#pr-backlog-2026-11-23"
  plan_refs: [W1-T11254, W1-T12081]
  files:
    - src/lib/relint.ts
    - test/relint-loop.test.ts
  status: queued
  attempts: 0
  rationale: |
    OBSERVED 2026-11-23, Azure core ledger: TRIAGE-onboarding-is-a-code-edit-20261103 started 15 times between 04:05Z
    and 21:12Z (every ~30 min since 14:26Z), half of all core runs after 19:00Z. Run -1795468362453 synthesized three
    times; every triage.relint carried "the filed plan does not load — fix before re-emitting: task W1-T13392:
    depends_on unknown task 'W1-T13902'", then triage.error ("AMBIGUOUS but files were changed") and the claim was
    released, so the next pass starts it again. W1-T13392 is an ops record; W1-T13902 is a core record. lintFiledTasks
    (src/lib/relint.ts:132-147) loads the plan with loadPlan's strict dependency mode, so a pre-existing cross-catalog
    edge that the run did not file fails the load and is blamed on the run, which no redraft can fix.
  design: |
    1. lintFiledTasks loads the plan keeping unseen dependencies (loadPlanKeepingUnseenDependencies, the
       "preserve-external" mode other cross-catalog readers use), so an edge from an existing record to a task in
       the other catalog does not fail the load.
    2. A load failure caused by a record this run filed still returns the plan-load block, as on origin/main.
    3. The per-filed-id lint is unchanged.
    INVARIANT own-load-failure-blocks: a filed record that makes the plan fail to load still blocks the relint.
  acceptance:
    - claim: "An existing record whose depends_on names a task in the other catalog does not block a triage relint"
      proof: "unit test: W1-T14556: an existing cross-catalog edge does not fail the triage relint"
    - claim: "invariant:own-load-failure-blocks — a filed record that breaks the plan load still blocks"
      kind: guard
      proof: "unit test: W1-T14556: a filed record that breaks the plan load still blocks the relint"
  falsifier: |
    Load the plan strictly again and criterion 1 fails; ignore every load error and criterion 2 fails.
  note: |
    Reserved for run-unfiled-1795469282969 with reserve-id.sh.
`;

/** The ops gate's core lint labels each record by its full checkout path; the ops read labels it
 *  relative to plan/. Both make the shard slug known, which is what made the span block (ops #910). */
const LABELS = [
  `/home/runner/work/remudero-ops/remudero-ops/plan/tasks.d/${W1_T14556_FILE}`,
  `tasks.d/${W1_T14556_FILE}`,
] as const;

/** The pre-dispatch options the ops gate's core lint passes to lintTask. */
const PRE_DISPATCH = { proofResolvability: "warn" } as const;

/** Today's (origin/main) sizing message for this record at an open status, pinned verbatim. */
const OPEN_SIZING_MESSAGE =
  "spans 2 distinct subsystems/concerns (relint, relint-loop) at risk:medium — Rule 19: raise to risk:high or " +
  "decompose into one task per concern — or, ONLY IF `test/relint-loop.test.ts` is THIS task's own falsifier " +
  "(the suite written to prove THESE acceptance criteria, not a suite that already exists for another concern), " +
  "rename this shard so its filename slug is `relint-loop` and the two match: the span here exists solely because " +
  "those two names differ, and W1-T2525's own-falsifier discount then applies. If the suite is not this task's own " +
  "falsifier, the span is REAL and renaming to silence it is gaming Rule 19, not satisfying it — decompose instead";

function recordAt(status: TaskStatus, text: string = W1_T14556_RECORD): string {
  const out = text.replace("\n  status: queued\n", `\n  status: ${status}\n`);
  assert.ok(out.includes(`\n  status: ${status}\n`), `fixture rewrite to status ${status} took effect`);
  return out;
}

function parse(label: string, text: string): Task {
  const tasks = mergePlanBlobs([{ label, text }], { logLevel: "error" }, { dependencyMode: "preserve-external" }).tasks;
  assert.equal(tasks.length, 1, "the fixture parses to exactly one record");
  const task = tasks[0];
  assert.equal(task.id, "W1-T14556");
  assert.equal(task.sourcePath, label, "the parse carries the label as sourcePath, as the gate's read does");
  return task;
}

function blocks(task: Task): string[] {
  return lintTask(task, PRE_DISPATCH).violations.filter((v) => v.severity === "block").map((v) => `${v.check}: ${v.message}`);
}

for (const label of LABELS) {
  for (const status of ["merged", "done"] as const) {
    test(`W1-T15273 criterion 1: W1-T14556 at status ${status} under ${label} gets a sizing warn naming ${status} and lints with no block`, () => {
      const task = parse(label, recordAt(status));
      assert.equal(task.status, status);
      const violation = sizingViolation(task);
      assert.ok(violation, "the landed record's span stays observable");
      assert.equal(violation.check, "sizing");
      assert.equal(violation.severity, "warn");
      assert.match(violation.message, new RegExp(`\\bstatus ${status}\\b`), "the message names the landed status");
      assert.match(violation.message, /reported, not refused/);
      assert.ok(violation.message.startsWith(OPEN_SIZING_MESSAGE), "the span text itself is unchanged");
      assert.deepEqual(blocks(task), [], "the ops gate's core lint sees no block on the merged flip");
    });
  }

  test(`W1-T15273 criterion 2: W1-T14556 at status queued under ${label} keeps today's sizing block, same message`, () => {
    const task = parse(label, recordAt("queued"));
    assert.deepEqual(sizingViolation(task), { check: "sizing", severity: "block", message: OPEN_SIZING_MESSAGE });
    assert.deepEqual(blocks(task), [`sizing: ${OPEN_SIZING_MESSAGE}`]);
  });

  test(`W1-T15273 criterion 2: W1-T14556 at status blocked with no retirement under ${label} keeps today's sizing block`, () => {
    const task = parse(label, recordAt("blocked"));
    assert.equal(task.retirement, undefined);
    assert.deepEqual(sizingViolation(task), { check: "sizing", severity: "block", message: OPEN_SIZING_MESSAGE });
    assert.deepEqual(blocks(task), [`sizing: ${OPEN_SIZING_MESSAGE}`]);
  });

  test(`W1-T15273 criterion 2: a withdrawn W1-T14556 under ${label} still gets the retired (withdrawn) warning`, () => {
    const task: Task = { ...parse(label, recordAt("blocked")), retirement: "withdrawn" };
    assert.deepEqual(sizingViolation(task), {
      check: "sizing",
      severity: "warn",
      message: "retired (withdrawn) shard W1-T14556 will never be built — sizing observation downgraded to warn",
    });
  });

  test(`W1-T15273 criterion 2: a merged record whose span is below two concerns under ${label} gets no sizing violation`, () => {
    const oneConcern = W1_T14556_RECORD.replace("    - src/lib/relint.ts\n    - test/relint-loop.test.ts\n", "    - src/lib/relint.ts\n");
    assert.notEqual(oneConcern, W1_T14556_RECORD, "the one-concern rewrite took effect");
    assert.equal(sizingViolation(parse(label, recordAt("queued", oneConcern))), undefined, "below two concerns at queued");
    assert.equal(sizingViolation(parse(label, recordAt("merged", oneConcern))), undefined, "and silent at merged too");
  });

  test(`W1-T15273 criterion 3: W1-T14556 requeued from merged to queued under ${label} gets the block again`, () => {
    const merged = parse(label, recordAt("merged"));
    assert.equal(sizingViolation(merged)?.severity, "warn");
    // The requeue rewrites status on the record already read, and on the next parse of its text.
    const requeuedInPlace: Task = { ...merged, status: "queued" };
    assert.deepEqual(sizingViolation(requeuedInPlace), { check: "sizing", severity: "block", message: OPEN_SIZING_MESSAGE });
    assert.deepEqual(blocks(requeuedInPlace), [`sizing: ${OPEN_SIZING_MESSAGE}`]);
    const reparsed = parse(label, recordAt("queued"));
    assert.deepEqual(sizingViolation(reparsed), { check: "sizing", severity: "block", message: OPEN_SIZING_MESSAGE });
  });
}
