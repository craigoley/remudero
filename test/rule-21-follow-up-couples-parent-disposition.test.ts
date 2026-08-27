import assert from "node:assert/strict";
import test from "node:test";

import {
  PARENT_SURVIVES_MARKER,
  parentDispositionStated,
  postMergeAmendmentViolations,
  followUpCarriesCriteria,
} from "../src/lib/task-linter.js";
import type { LintViolation } from "../src/lib/task-linter.js";
import type { AcceptanceCriterion, Task } from "../src/lib/plan.js";

// W1-T2375 — the Rule 21 follow-up escape gave amended criteria a SECOND home without taking the
// FIRST away, so parent and follow-up both stayed dispatchable and the fleet could build both.
// MEASURED ONCE: #3010 (13a73d57) filed the follow-up at 2026-08-26T22:30:50Z; nothing disposed of
// the parent until #3066 12h37m34s later, and inside that window run-W1-T2327-… and
// run-W1-T2340-… were dispatched in parallel.

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
    acceptance: [{ claim: "the original claim", proof: "unit test: test/original.test.ts" }],
    ...over,
  };
}

const BASE: AcceptanceCriterion[] = [{ claim: "the original claim", proof: "unit test: test/original.test.ts" }];
const AMENDED: AcceptanceCriterion[] = [
  ...BASE,
  { claim: "the amended claim", proof: "unit test: test/amended.test.ts" },
];
/** The follow-up the escape requires: a NEW task carrying every added criterion. */
const followUp = task({ id: "W1-T2340", acceptance: [{ claim: "the amended claim", proof: "unit test: test/f.test.ts" }] });

/** The merged-parent context the §5C pass injects. `followUpFiled` is computed by the caller with
 *  the real predicate rather than hand-set, so these cases exercise the same wiring CI does. */
function ctxFor(parent: Task, followUps: Task[]) {
  const added = AMENDED.filter((c) => !BASE.some((b) => b.claim === c.claim));
  return {
    postMergeAmendment: {
      statusResolvable: true,
      merged: true,
      baseAcceptance: BASE,
      baseTask: task({ id: parent.id, acceptance: BASE }),
      followUpFiled: followUpCarriesCriteria(added, followUps),
      followUpTaskIds: followUps.map((t) => t.id),
    },
  };
}

const blocking = (v: LintViolation[]): LintViolation[] => v.filter((x) => x.severity === "block");

test("W1-T2375 criterion 1+3: an amendment under the follow-up escape that disposes of NOTHING is refused, and the message names both tasks", () => {
  const parent = task({ id: "W1-T2327", acceptance: AMENDED }); // still status: queued
  const v = postMergeAmendmentViolations(parent, ctxFor(parent, [followUp]));
  const blocks = blocking(v);
  assert.equal(blocks.length, 1, "the unstated disposition must refuse");
  assert.match(blocks[0].message, /W1-T2327/, "the message must name the parent");
  assert.match(blocks[0].message, /W1-T2340/, "the message must name the follow-up");
  assert.match(blocks[0].message, /disposition is unstated/, "and say what is missing");
  assert.match(blocks[0].message, /operator act/, "and refuse to retire anything itself");
});

test("W1-T2375 criterion 2: a parent moved OUT OF DISPATCH in the same PR satisfies the requirement", () => {
  const parent = task({ id: "W1-T2327", acceptance: AMENDED, status: "blocked" });
  assert.equal(blocking(postMergeAmendmentViolations(parent, ctxFor(parent, [followUp]))).length, 0);
});

test("W1-T2375 criterion 4: a PARTLY superseded parent may keep its dispatchability when the PR states what remains", () => {
  const parent = task({
    id: "W1-T2327",
    acceptance: AMENDED,
    note: `${PARENT_SURVIVES_MARKER} the job-count arm is unamended and still owed.`,
  });
  assert.equal(parent.status, "queued", "the partial case stays dispatchable, deliberately");
  assert.equal(blocking(postMergeAmendmentViolations(parent, ctxFor(parent, [followUp]))).length, 0);
});

test("W1-T2375 criterion 5: the check reads the property the DISPATCHER reads, never the provenance field beside it", () => {
  // The 2026-08-25 instance (#2840, 57d47446) set `retirement: retired` and left `status: queued`.
  // `isDispatchEligible` (drain.ts) refuses on `status === "blocked"` and drain.ts references
  // `retirement` ZERO times, so the parent was dispatched anyway. A field-keyed rule would have
  // PASSED it and prevented nothing — this asserts the field alone is NOT a disposition.
  const fieldOnly = task({ id: "W1-T2327", acceptance: AMENDED, retirement: "retired" });
  assert.equal(parentDispositionStated(fieldOnly), false, "retirement: alone leaves the parent selectable");
  assert.equal(blocking(postMergeAmendmentViolations(fieldOnly, ctxFor(fieldOnly, [followUp]))).length, 1);

  const outOfDispatch = task({ id: "W1-T2327", acceptance: AMENDED, status: "blocked" });
  assert.equal(parentDispositionStated(outOfDispatch), true, "the dispatcher's own property is what counts");
});

test("W1-T2375 criterion 6: an amendment with NO follow-up filed is unaffected and blocks exactly as before", () => {
  const parent = task({ id: "W1-T2327", acceptance: AMENDED });
  const v = blocking(postMergeAmendmentViolations(parent, ctxFor(parent, [])));
  assert.equal(v.length, 1);
  assert.match(v[0].message, /no follow-up task carrying it filed in the same PR/, "the pre-existing wording is unchanged");
  assert.doesNotMatch(v[0].message, /disposition is unstated/, "and it is NOT the new refusal");
});

test("W1-T2375 criterion 7: the blocking surface stays exactly one predicate wide", () => {
  const parent = task({ id: "W1-T2327", acceptance: AMENDED });
  const v = postMergeAmendmentViolations(parent, ctxFor(parent, [followUp]));
  const checks = new Set(blocking(v).map((x) => x.check));
  assert.deepEqual([...checks], ["post-merge-amendment"], "no second blocking arm was added");
  // every other arm stays a report
  for (const x of v.filter((y) => y.check !== "post-merge-amendment")) {
    assert.equal(x.severity, "warn");
  }
});

test("W1-T2375 criterion 8: the historical shape still passes — dec38d91's disposition satisfies the rule", () => {
  // dec38d91 (#1293) split W1-T314 into three successors and disposed of the parent in the SAME
  // commit with `status: blocked`, reasoning that blocked is this repo's established equivalent of
  // a retirement record. The practice predates the `retirement:` field and was never required.
  const parent = task({ id: "W1-T314", acceptance: AMENDED, status: "blocked" });
  assert.equal(blocking(postMergeAmendmentViolations(parent, ctxFor(parent, [followUp]))).length, 0);
});

test("W1-T2375: an UNMERGED parent is untouched — ordinary authoring never reaches this arm", () => {
  const parent = task({ id: "W1-T2327", acceptance: AMENDED });
  const c = ctxFor(parent, [followUp]);
  const v = postMergeAmendmentViolations(parent, { postMergeAmendment: { ...c.postMergeAmendment, merged: false } });
  assert.equal(v.length, 0);
});

test("W1-T2375: an unresolvable merge status still fails OPEN", () => {
  const parent = task({ id: "W1-T2327", acceptance: AMENDED });
  const c = ctxFor(parent, [followUp]);
  const v = postMergeAmendmentViolations(parent, {
    postMergeAmendment: { ...c.postMergeAmendment, statusResolvable: false },
  });
  assert.equal(v.length, 0);
});

// ── W1-T2375 (extracted from #3091): NAMING THE FOLLOW-UP THAT ACTUALLY CARRIES THE CRITERIA ──
//
// MESSAGE PRECISION, NOT A VERDICT CHANGE, and the last case here is what says so. `followUpFiled`
// is decided by which filed tasks CARRY every added criterion (`followUpCarriesCriteria`), while
// `followUpTaskIds` is every new task in the PR (run-task.ts passes `followUpTasks.map(t => t.id)`)
// — so before this, a PR filing one carrying follow-up beside one unrelated new task named BOTH.

/** A new task filed in the same PR that carries NONE of the added criteria — the noise the
 *  carrying filter removes from the message. */
const unrelated = task({ id: "W1-T9001", acceptance: [{ claim: "something else entirely", proof: "unit test: test/other.test.ts" }] });

/** {@link ctxFor}, widened with the follow-up TASKS — the field run-task.ts now passes. */
function ctxWithTasks(parent: Task, followUps: Task[]) {
  const base = ctxFor(parent, followUps);
  return { postMergeAmendment: { ...base.postMergeAmendment, followUpTasks: followUps } };
}

test("W1-T2375: the refusal names ONLY the follow-up carrying the criteria, not every new task in the PR", () => {
  const parent = task({ id: "W1-T2327", acceptance: AMENDED }); // still status: queued
  const v = blocking(postMergeAmendmentViolations(parent, ctxWithTasks(parent, [followUp, unrelated])));
  assert.equal(v.length, 1);
  assert.match(v[0].message, /W1-T2340/, "the follow-up that carries the amended criterion is named");
  assert.equal(/W1-T9001/.test(v[0].message), false, "the unrelated new task is NOT named — it carries nothing");
  assert.match(v[0].message, /W1-T2327/, "and the parent is still named");
});

test("W1-T2375: with the tasks NOT supplied the message is byte-identical to before this field existed", () => {
  const parent = task({ id: "W1-T2327", acceptance: AMENDED });
  const withoutTasks = blocking(postMergeAmendmentViolations(parent, ctxFor(parent, [followUp, unrelated])));
  assert.equal(withoutTasks.length, 1);
  assert.match(withoutTasks[0].message, /W1-T2340, W1-T9001/, "the caller-supplied id list, verbatim");
});

test("W1-T2375: a carrying subset that comes back EMPTY falls back rather than naming nothing", () => {
  // Reachable only by hand: the real predicate would set `followUpFiled: false` here and take the
  // other arm entirely. Pinned anyway, because the fallback is what keeps this a NARROWING of the
  // message rather than a way to blank it.
  const parent = task({ id: "W1-T2327", acceptance: AMENDED });
  const ctx = ctxFor(parent, [unrelated]);
  const forced = {
    postMergeAmendment: { ...ctx.postMergeAmendment, followUpFiled: true, followUpTasks: [unrelated] },
  };
  const v = blocking(postMergeAmendmentViolations(parent, forced));
  assert.equal(v.length, 1);
  assert.match(v[0].message, /W1-T9001/, "falls back to the caller's id list rather than emitting an empty name");
});

test("W1-T2375: naming the carrier changes NO verdict — the same scenarios block identically with and without it", () => {
  const cases: Array<[string, Task, Task[]]> = [
    ["unstated disposition", task({ id: "W1-T2327", acceptance: AMENDED }), [followUp, unrelated]],
    ["parent blocked", task({ id: "W1-T2327", acceptance: AMENDED, status: "blocked" }), [followUp, unrelated]],
    ["no follow-up filed", task({ id: "W1-T2327", acceptance: AMENDED }), []],
    ["unrelated task only", task({ id: "W1-T2327", acceptance: AMENDED }), [unrelated]],
  ];
  for (const [label, parent, ups] of cases) {
    const without = blocking(postMergeAmendmentViolations(parent, ctxFor(parent, ups))).length;
    const with_ = blocking(postMergeAmendmentViolations(parent, ctxWithTasks(parent, ups))).length;
    assert.equal(with_, without, `${label}: the blocking count must be identical — this is a message change, not a behaviour change`);
  }
});
