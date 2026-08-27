import assert from "node:assert/strict";
import { test } from "node:test";
import {
  criteriaProofChanged,
  criteriaRemoved,
  lintTask,
  mergedFieldChangeViolations,
  postMergeAmendmentViolations,
  type PostMergeAmendmentContext,
} from "../src/lib/task-linter.js";
import type { Task } from "../src/lib/plan.js";

// W1-T2254: `postMergeAmendmentViolations` (task-linter.ts) guarded exactly ONE field of a
// merged shard — `acceptance`, and only against an ADDED/CHANGED claim — so every other field
// (including a criterion's PROOF, and a criterion being REMOVED outright) escaped unreported.
// This file exercises the widened context (`PostMergeAmendmentContext.baseTask`) and the three
// new REPORT-ONLY checks it feeds: `post-merge-field-drift`, `post-merge-criterion-removed` and
// `post-merge-proof-changed` — plus re-proves the five early exits the ORIGINAL acceptance guard
// (unchanged by this task) must still honour.

const BASE_ACCEPTANCE = [
  { claim: "the widget renders", proof: "unit test: test/widget.test.ts" },
  { claim: "the widget survives a reload", proof: "unit test: test/widget.test.ts::reload" },
];

const BASE_TASK: Task = {
  id: "W1-T900",
  title: "sample merged task",
  repo: "remudero",
  depends_on: [],
  type: "implement",
  verify: "auto",
  risk: "medium",
  status: "merged",
  attempts: 1,
  origin: "architect",
  files: ["src/lib/widget.ts"],
  priority: 10,
  principles: { tdd: "strict" },
  budget_usd: 20,
  note: "an operator note",
  rationale: "why this task exists",
  acceptance: BASE_ACCEPTANCE,
};

/** A fully-permissive context: merged, resolvable, no follow-up needed, base = {@link BASE_TASK}.
 *  Each test overrides only what it needs. */
function ctx(over: Partial<PostMergeAmendmentContext> = {}): PostMergeAmendmentContext {
  return {
    statusResolvable: true,
    merged: true,
    baseAcceptance: BASE_ACCEPTANCE,
    baseTask: BASE_TASK,
    followUpFiled: false,
    ...over,
  };
}

function current(over: Partial<Task> = {}): Task {
  return { ...BASE_TASK, ...over };
}

// ── ACCEPTANCE 1: status changed is reported, naming the field and both values ───────────────

test("ACCEPTANCE 1: a merged task whose status changed since the base ref is reported, naming the field and both values", () => {
  const t = current({ status: "queued" });
  const res = lintTask(t, { postMergeAmendment: ctx() });
  assert.equal(res.ok, true, "a field-drift report must never block");
  const v = res.violations.find((x) => x.check === "post-merge-field-drift" && /`status:`/.test(x.message));
  assert.ok(v, "expected a post-merge-field-drift violation naming `status:`");
  assert.equal(v?.severity, "warn");
  assert.match(v!.message, /W1-T900/);
  assert.match(v!.message, /"merged"/, "must name the BASE value");
  assert.match(v!.message, /"queued"/, "must name the CURRENT value");
});

test("(helper) mergedFieldChangeViolations: unchanged status draws nothing", () => {
  const v = mergedFieldChangeViolations(current(), BASE_TASK);
  assert.deepEqual(v, []);
});

// ── ACCEPTANCE 2: files changed is reported, and stays PERMITTED rather than blocked ─────────

test("ACCEPTANCE 2: a merged task's declared files changing is reported, and the change stays PERMITTED rather than blocked (W1-T2248)", () => {
  // risk:high — Rule 19's sizing check is exempt at risk:high (sizingViolation), which is
  // otherwise an UNRELATED block that a 2-file span at risk:medium would trip on its own; this
  // fixture isolates the field-drift report from that orthogonal check.
  const t = current({ risk: "high", files: ["src/lib/widget.ts", "src/lib/widget-two.ts"] });
  const res = lintTask(t, { postMergeAmendment: ctx() });
  assert.equal(res.ok, true, "W1-T2248: a merged files: correction must remain permitted, never blocked");
  const v = res.violations.find((x) => x.check === "post-merge-field-drift" && /`files:`/.test(x.message));
  assert.ok(v, "expected a post-merge-field-drift violation naming `files:`");
  assert.equal(v?.severity, "warn", "must be a report, never a block");
  assert.match(v!.message, /widget-two/);
});

// ── ACCEPTANCE 3: a proof rewritten under an identical claim is reported ─────────────────────

test("ACCEPTANCE 3: a proof rewritten under an identical claim is reported, so the executable half of a criterion cannot be weakened in silence", () => {
  const weakened = current({
    acceptance: [
      { claim: BASE_ACCEPTANCE[0].claim, proof: "grep: widget in src/lib/widget.ts" },
      BASE_ACCEPTANCE[1],
    ],
  });
  // The claim-only `criteriaAdded` comparison sees NOTHING — this is the exact blind spot
  // W1-T1098 documented and W1-T2254's rationale names as still open.
  const res = lintTask(weakened, { postMergeAmendment: ctx() });
  assert.equal(res.ok, true, "a proof rewrite is a report, never a block");
  assert.ok(!res.violations.some((v) => v.check === "post-merge-amendment"), "claim-only guard stays silent");
  const v = res.violations.find((x) => x.check === "post-merge-proof-changed");
  assert.ok(v, "expected a post-merge-proof-changed violation");
  assert.equal(v?.severity, "warn");
  assert.match(v!.message, /the widget renders/);
  assert.match(v!.message, /unit test: test\/widget\.test\.ts/);
  assert.match(v!.message, /grep: widget in src\/lib\/widget\.ts/);
});

test("(helper) criteriaProofChanged: same claim + same proof draws nothing; same claim + different proof is reported; a genuinely new claim is not (criteriaAdded's territory)", () => {
  assert.deepEqual(criteriaProofChanged(BASE_ACCEPTANCE, BASE_ACCEPTANCE), []);
  const changed = criteriaProofChanged(BASE_ACCEPTANCE, [
    { claim: BASE_ACCEPTANCE[0].claim, proof: "grep: widget in src/lib/widget.ts" },
    BASE_ACCEPTANCE[1],
  ]);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].base.proof, BASE_ACCEPTANCE[0].proof);
  assert.equal(changed[0].current.proof, "grep: widget in src/lib/widget.ts");
  const withNewClaim = criteriaProofChanged(BASE_ACCEPTANCE, [
    ...BASE_ACCEPTANCE,
    { claim: "a brand new promise", proof: "unit test: test/widget.test.ts::new" },
  ]);
  assert.deepEqual(withNewClaim, []);
});

// ── ACCEPTANCE 4: a removed acceptance criterion is reported rather than passing as no delta ──

test("ACCEPTANCE 4: a merged acceptance criterion that is REMOVED is reported rather than passing as no delta", () => {
  const shrunk = current({ acceptance: [BASE_ACCEPTANCE[0]] });
  const res = lintTask(shrunk, { postMergeAmendment: ctx() });
  assert.equal(res.ok, true, "a removal report is a warn, never a block");
  assert.ok(!res.violations.some((v) => v.check === "post-merge-amendment"), "criteriaAdded sees no addition here");
  const v = res.violations.find((x) => x.check === "post-merge-criterion-removed");
  assert.ok(v, "expected a post-merge-criterion-removed violation");
  assert.equal(v?.severity, "warn");
  assert.match(v!.message, /survives a reload/);
});

test("(helper) criteriaRemoved: an entry dropped from the current set is reported; an unchanged set reports nothing", () => {
  assert.deepEqual(criteriaRemoved(BASE_ACCEPTANCE, BASE_ACCEPTANCE), []);
  const removed = criteriaRemoved(BASE_ACCEPTANCE, [BASE_ACCEPTANCE[0]]);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].claim, BASE_ACCEPTANCE[1].claim);
});

// ── ACCEPTANCE 5: a field nothing reads after merge is NOT reported ──────────────────────────

test("ACCEPTANCE 5: prose fields an amendment is expected to touch (title, note, rationale) are not reported", () => {
  const t = current({ title: "a retitled task", note: "an updated note", rationale: "an updated rationale" });
  const res = lintTask(t, { postMergeAmendment: ctx() });
  assert.equal(res.ok, true);
  assert.ok(
    !res.violations.some((v) => v.check === "post-merge-field-drift"),
    "prose-only changes must draw no field-drift report",
  );
});

test("ACCEPTANCE 5: hand_built (zero consumers in src/) is not reported even though it changed", () => {
  const t = current({ hand_built: true });
  assert.equal((BASE_TASK as { hand_built?: boolean }).hand_built, undefined);
  const res = lintTask(t, { postMergeAmendment: ctx() });
  assert.ok(!res.violations.some((v) => v.check === "post-merge-field-drift"));
});

test("(helper) mergedFieldChangeViolations: title/note/rationale/hand_built changing draws nothing; a listed field changing does", () => {
  const t = current({ title: "different", note: "different", rationale: "different", hand_built: true, priority: 99 });
  const v = mergedFieldChangeViolations(t, BASE_TASK);
  assert.equal(v.length, 1, "only `priority:` is in the reported set among the changed fields here");
  assert.equal(v[0].check, "post-merge-field-drift");
  assert.match(v[0].message, /`priority:`/);
});

// ── ACCEPTANCE 6: the existing acceptance guard is UNCHANGED — all five early exits stay EMPTY ─

test("ACCEPTANCE 6 (i): no context at all -> EMPTY", () => {
  const t = current({ acceptance: [...BASE_ACCEPTANCE, { claim: "a genuinely new claim", proof: "unit test: test/widget.test.ts::new" }] });
  assert.deepEqual(postMergeAmendmentViolations(t), []);
});

test("ACCEPTANCE 6 (ii): statusResolvable: false -> EMPTY, including fields/removals/proof-rewrites, failing OPEN on an unreadable derived status", () => {
  // risk:high — see ACCEPTANCE 2's fixture comment; isolates this from Rule 19's unrelated sizing block.
  const t = current({
    risk: "high",
    status: "queued",
    files: ["src/lib/widget.ts", "src/lib/other.ts"],
    acceptance: [{ claim: BASE_ACCEPTANCE[0].claim, proof: "grep: widget in src/lib/widget.ts" }],
  });
  const res = lintTask(t, { postMergeAmendment: ctx({ statusResolvable: false }) });
  assert.equal(res.ok, true);
  assert.deepEqual(res.violations.filter((v) => v.check.startsWith("post-merge")), []);
});

test("ACCEPTANCE 6 (iii): merged: false -> EMPTY", () => {
  const t = current({ status: "queued", acceptance: [{ claim: "a genuinely new claim", proof: "unit test: test/x.test.ts" }] });
  const res = lintTask(t, { postMergeAmendment: ctx({ merged: false }) });
  assert.equal(res.ok, true);
  assert.deepEqual(res.violations.filter((v) => v.check.startsWith("post-merge")), []);
});

test("ACCEPTANCE 6 (iv): no delta against the base -> EMPTY (identical task, identical acceptance)", () => {
  const res = lintTask(current(), { postMergeAmendment: ctx() });
  assert.deepEqual(res.violations.filter((v) => v.check.startsWith("post-merge")), []);
});

test("ACCEPTANCE 6 (v): followUpFiled: true -> EMPTY for the acceptance-added case (the pre-existing escape hatch keeps working)", () => {
  // W1-T2375: the escape now has TWO conditions — a follow-up AND a stated parent disposition.
  // The fixture states it (status: blocked); the ASSERTION is unchanged, because the escape still
  // works. Adding the disposition is what a real PR must now do, not a weakening of the test.
  const t = current({ status: "blocked", acceptance: [...BASE_ACCEPTANCE, { claim: "a genuinely new claim", proof: "unit test: test/widget.test.ts::new" }] });
  const res = lintTask(t, { postMergeAmendment: ctx({ followUpFiled: true }) });
  assert.equal(res.ok, true);
  assert.ok(!res.violations.some((v) => v.check === "post-merge-amendment"));
});

test("ACCEPTANCE 6 (v, W1-T2375): followUpFiled: true with the parent left DISPATCHABLE now refuses — the second condition", () => {
  const t = current({ acceptance: [...BASE_ACCEPTANCE, { claim: "a genuinely new claim", proof: "unit test: test/widget.test.ts::new" }] });
  const res = lintTask(t, { postMergeAmendment: ctx({ followUpFiled: true }) });
  assert.equal(res.ok, false, "a follow-up alone no longer buys the escape");
  assert.ok(res.violations.some((v) => v.check === "post-merge-amendment" && v.severity === "block"));
});

// The original blocking control still fires exactly as before this task.
test("(control) a genuinely new/changed claim on a merged task with no follow-up still BLOCKS, unchanged by this task", () => {
  const t = current({ acceptance: [...BASE_ACCEPTANCE, { claim: "a genuinely new claim", proof: "unit test: test/widget.test.ts::new" }] });
  const res = lintTask(t, { postMergeAmendment: ctx() });
  assert.equal(res.ok, false);
  const v = res.violations.find((x) => x.check === "post-merge-amendment");
  assert.ok(v);
  assert.equal(v?.severity, "block");
});

// ── ACCEPTANCE 7: the check REPORTS and NEVER REWRITES — no field is restored to its base value ─

test("ACCEPTANCE 7: postMergeAmendmentViolations reports and never rewrites — task and baseTask are untouched by any code path", () => {
  const t = current({
    status: "queued",
    files: ["src/lib/widget.ts", "src/lib/other.ts"],
    priority: 99,
    acceptance: [{ claim: BASE_ACCEPTANCE[0].claim, proof: "grep: widget in src/lib/widget.ts" }],
  });
  const tBefore = JSON.parse(JSON.stringify(t));
  const baseBefore = JSON.parse(JSON.stringify(BASE_TASK));
  const violations = postMergeAmendmentViolations(t, { postMergeAmendment: ctx() });
  assert.ok(violations.length > 0, "sanity: this fixture must actually draw reports");
  assert.deepEqual(t, tBefore, "the current task object must not be mutated by the check");
  assert.deepEqual(BASE_TASK, baseBefore, "the base task object must not be mutated by the check");
  // And the result carries no field/path that would let a caller apply a correction —
  // every violation is plain { check, severity, message }, nothing executable.
  for (const v of violations) {
    assert.deepEqual(Object.keys(v).sort(), ["check", "message", "severity"]);
  }
});

test("(helper) mergedFieldChangeViolations and criteriaRemoved/criteriaProofChanged are pure — repeated calls over the same inputs return equal results", () => {
  const t = current({ status: "queued", files: ["src/lib/widget.ts", "src/lib/other.ts"] });
  assert.deepEqual(mergedFieldChangeViolations(t, BASE_TASK), mergedFieldChangeViolations(t, BASE_TASK));
  assert.deepEqual(criteriaRemoved(BASE_ACCEPTANCE, [BASE_ACCEPTANCE[0]]), criteriaRemoved(BASE_ACCEPTANCE, [BASE_ACCEPTANCE[0]]));
});
