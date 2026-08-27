import assert from "node:assert/strict";
import { test } from "node:test";
import {
  criteriaAdded,
  followUpCarriesCriteria,
  parentDispositionStated,
  postMergeAmendmentViolations,
} from "../src/lib/task-linter.js";
import type { Task } from "../src/lib/plan.js";

// W1-T2375 — Rule 21's follow-up escape (`followUpCarriesCriteria`, W1-T180) required a
// follow-up task to be FILED in the same PR that amends a MERGED task's criteria, but never
// asked whether the PARENT's own dispatchability was addressed. Both stayed dispatchable and
// the fleet built both (measured instance: #3010 filed W1-T2340 as W1-T2327's follow-up;
// nothing disposed of W1-T2327 for 12h37m34s, during which the fleet dispatched BOTH #3039 and
// #3043). This suite proves `postMergeAmendmentViolations` now refuses that silence: the
// escape requires the parent to say EITHER "I am fully superseded" (`status: "blocked"` in the
// same PR) or "I am partly superseded, and here is what remains" (its own note/rationale
// changed in the same PR) — never picks between them, never writes one, only refuses saying
// neither.

/** A minimal, otherwise-clean Task fixture — mirrors test/task-linter.test.ts's own helper. */
function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: over.id,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    origin: "architect",
    acceptance: [{ claim: "does the thing", proof: "unit test test/foo.test.ts asserts the thing" }],
    ...over,
  };
}

const PARENT_ID = "W1-T9001";
const FOLLOW_UP_ID = "W1-T9002";

const BASE_CRITERIA = [{ claim: "a stalled run is reported stalled", proof: "unit test: test/stall.test.ts" }];
const AMENDED_CRITERION = { claim: "a corrected discriminator: a non-terminal job under a terminal run", proof: "unit test: test/stall.test.ts::corrected" };

function amendedParent(over: Partial<Task> = {}): Task {
  return task({
    id: PARENT_ID,
    files: ["src/lib/stall.ts"],
    acceptance: [...BASE_CRITERIA, AMENDED_CRITERION],
    ...over,
  });
}

function baseParent(over: Partial<Task> = {}): Task {
  return task({ id: PARENT_ID, files: ["src/lib/stall.ts"], acceptance: BASE_CRITERIA, ...over });
}

function followUp(): Task {
  return task({ id: FOLLOW_UP_ID, files: ["src/lib/stall.ts"], acceptance: [AMENDED_CRITERION] });
}

/** Wires the SAME three values run-task.ts's `lintPlanCommand` already resolves at the point it
 *  computes `followUpFiled` — `added`, `followUpFiled`, and the raw `followUpTasks` array — so
 *  every test below exercises the real call-site shape rather than a hand-picked boolean. */
function lintAmendment(current: Task, baseTask: Task | undefined, candidateFollowUps: Task[]) {
  const added = criteriaAdded(baseTask?.acceptance, current.acceptance ?? []);
  const followUpFiled = followUpCarriesCriteria(added, candidateFollowUps);
  return postMergeAmendmentViolations(current, {
    postMergeAmendment: {
      statusResolvable: true,
      merged: true,
      baseAcceptance: baseTask?.acceptance,
      baseTask,
      followUpFiled,
      followUpTasks: candidateFollowUps,
    },
  });
}

test("W1-T2375 ACCEPTANCE 1: the follow-up escape requires the parent to state its own disposition, not just a follow-up to exist", () => {
  const current = amendedParent(); // status stays "queued", note/rationale unchanged from base
  const violations = lintAmendment(current, baseParent(), [followUp()]);
  const v = violations.find((x) => x.check === "post-merge-amendment");
  assert.ok(v, `expected a post-merge-amendment violation, got: ${JSON.stringify(violations)}`);
  assert.equal(v?.severity, "block");
});

test("W1-T2375 ACCEPTANCE 2: a parent moved to status: \"blocked\" in the same PR satisfies the requirement (fully superseded)", () => {
  const current = amendedParent({ status: "blocked" });
  const violations = lintAmendment(current, baseParent(), [followUp()]);
  assert.ok(!violations.some((v) => v.check === "post-merge-amendment"), "a fully-superseded parent must pass");

  // and the pure predicate agrees directly, independent of the wrapping violations list
  assert.equal(parentDispositionStated(current, baseParent()), true);
});

test("W1-T2375 ACCEPTANCE 3: a parent left dispatchable with no stated disposition is refused, and the message names both tasks", () => {
  const current = amendedParent(); // status stays "queued" — never disposed of
  const violations = lintAmendment(current, baseParent(), [followUp()]);
  const v = violations.find((x) => x.check === "post-merge-amendment");
  assert.ok(v, "expected a post-merge-amendment violation");
  assert.match(v!.message, new RegExp(PARENT_ID), "message must name the parent");
  assert.match(v!.message, new RegExp(FOLLOW_UP_ID), "message must name the follow-up that already carries the criterion");
});

test("W1-T2375 ACCEPTANCE 4: a partly superseded parent may keep its dispatchability when the PR states what remains", () => {
  const current = amendedParent({
    status: "queued", // stays dispatchable — the parent's OTHER criteria are still real work
    note: "the corrected discriminator moved to " + FOLLOW_UP_ID + "; this task's other criteria (unrelated to the stall fix) still stand and remain open",
  });
  const violations = lintAmendment(current, baseParent({ note: undefined }), [followUp()]);
  assert.ok(!violations.some((v) => v.check === "post-merge-amendment"), "a stated partial disposition must pass without blocking dispatch");
  assert.equal(current.status, "queued", "the parent must still be dispatchable — this is the partial case, not a retirement");
});

test("W1-T2375 ACCEPTANCE 5: the check reads the property the dispatcher reads (status), never the provenance field beside it (retirement)", () => {
  // `retirement:` alone, with status left dispatchable, is exactly the shape rationale (3)
  // measured as inert: drain.ts never reads `retirement`, so a parent carrying it was
  // dispatched anyway. The check must still refuse this.
  const retirementOnly = amendedParent({ status: "queued", retirement: "retired" });
  const withRetirementOnly = lintAmendment(retirementOnly, baseParent(), [followUp()]);
  assert.ok(
    withRetirementOnly.some((v) => v.check === "post-merge-amendment"),
    "a `retirement:` field with status left dispatchable must still be refused — retirement is provenance, not mechanism",
  );

  // and the converse: `status: "blocked"` alone, with NO `retirement:` field at all, is
  // sufficient — the dispatcher-read property, unaccompanied by its provenance field.
  const statusOnly = amendedParent({ status: "blocked" });
  assert.equal(statusOnly.retirement, undefined);
  const withStatusOnly = lintAmendment(statusOnly, baseParent(), [followUp()]);
  assert.ok(
    !withStatusOnly.some((v) => v.check === "post-merge-amendment"),
    "status: \"blocked\" alone, with no retirement: field, must satisfy the requirement",
  );
});

test("W1-T2375 ACCEPTANCE 6: an amendment with NO follow-up filed is unaffected, and still blocks exactly as before", () => {
  const current = amendedParent(); // no follow-up in the candidate set at all
  const violations = lintAmendment(current, baseParent(), []);
  const v = violations.find((x) => x.check === "post-merge-amendment");
  assert.ok(v, "expected the original post-merge-amendment violation");
  assert.equal(v?.severity, "block");
  assert.match(v!.message, /no follow-up task carrying it filed in the same PR/, "the pre-W1-T2375 message must be byte-identical when there is no escape to gate");

  // the parent's own status/note are irrelevant here — this branch never even reaches the
  // disposition check, exactly as before W1-T2375.
  const blockedAnyway = amendedParent({ status: "blocked" });
  const stillBlocks = lintAmendment(blockedAnyway, baseParent(), []);
  assert.ok(
    stillBlocks.some((x) => x.check === "post-merge-amendment"),
    "status: blocked does not manufacture a follow-up that was never filed",
  );
});

test("W1-T2375 ACCEPTANCE 7: the blocking surface stays one predicate wide — every scenario above blocks under the SAME single check name", () => {
  const scenarios: Array<{ label: string; violations: ReturnType<typeof lintAmendment> }> = [
    { label: "no follow-up filed", violations: lintAmendment(amendedParent(), baseParent(), []) },
    { label: "follow-up filed, no disposition stated", violations: lintAmendment(amendedParent(), baseParent(), [followUp()]) },
    {
      label: "retirement field only, no status move",
      violations: lintAmendment(amendedParent({ retirement: "retired" }), baseParent(), [followUp()]),
    },
  ];
  const blockingCheckNames = new Set(
    scenarios.flatMap((s) => s.violations.filter((v) => v.severity === "block").map((v) => v.check)),
  );
  assert.deepEqual([...blockingCheckNames], ["post-merge-amendment"], "W1-T2375 must not introduce a second blocking check");
});

test("W1-T2375 ACCEPTANCE 8: every merged PR matching the historical shape (dec38d91: parent disposed of via status: \"blocked\" in the SAME commit as filing successors) still passes", () => {
  // Mirrors dec38d91 (#1293), which split a parent into successors and set the parent's
  // `status: blocked` in the SAME commit — the design's own "near-miss that proves the rule is
  // satisfiable". Full-supersede shape:
  const fullySuperseded = lintAmendment(amendedParent({ status: "blocked" }), baseParent(), [followUp()]);
  assert.ok(!fullySuperseded.some((v) => v.check === "post-merge-amendment"), "the full-supersede historical shape must still pass");

  // And the partial-supersede shape (ACCEPTANCE 4), restated here as its own historical-shape
  // instance so this test does not depend on ordering with an earlier one:
  const partlySuperseded = lintAmendment(
    amendedParent({ note: "the corrected discriminator moved to " + FOLLOW_UP_ID + "; the rest of this task's scope stands" }),
    baseParent({ note: undefined }),
    [followUp()],
  );
  assert.ok(!partlySuperseded.some((v) => v.check === "post-merge-amendment"), "the partial-supersede historical shape must still pass");
});
