import { strict as assert } from "node:assert";
import { test } from "node:test";
import { declaredScopeViolation, sizingViolation, subsystemsOf } from "../src/lib/task-linter.js";
import type { Task } from "../src/lib/plan.js";

/**
 * W1-T2525 — Rule 19 sizing must not count a source file and ITS OWN test as two concerns, and
 * `risk: medium` must stay reachable for the dominant `files: [src/x.ts, test/x.test.ts]` shape.
 *
 * W1-T2543 already discounts ANY `test/` path once some non-companion file survives — the fix
 * this file pins NARROWS that discount to the task's OWN falsifier, keyed on `opts.duplicateSlug`
 * (the shard filename slug {@link duplicateTitleViolations} already reads — same fact, second
 * reader). A companion whose module id does not match the slug counts like an ordinary concern;
 * a caller that supplies no slug at all keeps the W1-T2543 discount byte for byte, so nothing that
 * passed before this task regresses (see test/a-suite-is-not-a-second-concern.test.ts, unedited by
 * this task and still green).
 */
function task(over: Partial<Task> = {}): Task {
  return { id: "W1-TX", title: "an ordinary task", repo: "remudero", type: "implement", risk: "medium", files: [], ...over } as Task;
}

test("criterion 1: one src stem plus its OWN slug-matching test passes sizing at medium", () => {
  const t = task({ files: ["src/lib/foo.ts", "test/rule-19-sizing-counts-a-test-as-a-concern.test.ts"] });
  const opts = { duplicateSlug: "rule-19-sizing-counts-a-test-as-a-concern" };
  assert.deepEqual([...subsystemsOf(t, undefined, undefined, opts.duplicateSlug)], ["foo"], "the own test is the falsifier, not a second concern");
  assert.equal(sizingViolation(t, opts), undefined, "one concern must not trip Rule 19 at risk:medium");
});

test("criterion 2: a task listing two src stems is still refused at medium", () => {
  const t = task({
    files: ["src/lib/foo.ts", "src/lib/bar.ts", "test/rule-19-sizing-counts-a-test-as-a-concern.test.ts"],
  });
  const opts = { duplicateSlug: "rule-19-sizing-counts-a-test-as-a-concern" };
  assert.deepEqual([...subsystemsOf(t, undefined, undefined, opts.duplicateSlug)].sort(), ["bar", "foo"], "both real source stems survive the exemption");
  const v = sizingViolation(t, opts);
  assert.ok(v, "a genuine two-source span must still be refused, own-test exemption or not");
  assert.match(v!.message, /spans 2 distinct subsystems/);
});

test("criterion 3: a test file that does NOT match the task's own slug is still counted as a concern", () => {
  const t = task({ files: ["src/lib/foo.ts", "test/some-other-tasks-test.test.ts"] });
  const opts = { duplicateSlug: "rule-19-sizing-counts-a-test-as-a-concern" }; // this task's real slug
  assert.deepEqual(
    [...subsystemsOf(t, undefined, undefined, opts.duplicateSlug)].sort(),
    ["foo", "some-other-tasks-test"],
    "an unrelated test file is SOMEONE ELSE's test, not this task's falsifier — it counts",
  );
  const v = sizingViolation(t, opts);
  assert.ok(v, "one source plus an unrelated test is a genuine two-concern span");
  assert.match(v!.message, /spans 2 distinct subsystems/);
});

test("criterion 4: a task listing several unrelated test files is still refused", () => {
  const t = task({
    files: ["src/lib/foo.ts", "test/unrelated-one.test.ts", "test/unrelated-two.test.ts"],
  });
  const opts = { duplicateSlug: "rule-19-sizing-counts-a-test-as-a-concern" };
  assert.equal(subsystemsOf(t, undefined, undefined, opts.duplicateSlug).size, 3, "the source plus BOTH unrelated tests all count");
  const v = sizingViolation(t, opts);
  assert.ok(v, "several unrelated test files must still be refused, not swept into a single discount");
  assert.match(v!.message, /spans 3 distinct subsystems/);

  // The same shape with no source file at all — still refused, exactly as W1-T2543 already pins.
  const testOnly = task({ files: ["test/unrelated-one.test.ts", "test/unrelated-two.test.ts"] });
  assert.equal(subsystemsOf(testOnly, undefined, undefined, opts.duplicateSlug).size, 2);
  assert.ok(sizingViolation(testOnly, opts));
});

test("criterion 5a: risk:high with no band_meaning behaves exactly as it does today, own-test slug or not", () => {
  const t = task({ risk: "high", files: ["src/lib/foo.ts", "test/rule-19-sizing-counts-a-test-as-a-concern.test.ts"] });
  const opts = { duplicateSlug: "rule-19-sizing-counts-a-test-as-a-concern" };
  // No riskTransition ⇒ no diff context ⇒ no opinion, same as before this task (opts.duplicateSlug
  // is irrelevant here — this arm never reaches subsystemsOf at all).
  assert.equal(sizingViolation(t), undefined);
  assert.equal(sizingViolation(t, opts), undefined);
});

test("criterion 5b: risk:high band_meaning:span still REPORTS the span, own-test slug or not", () => {
  const t = task({
    risk: "high",
    band_meaning: "span",
    files: ["src/lib/foo.ts", "src/lib/bar.ts", "test/rule-19-sizing-counts-a-test-as-a-concern.test.ts"],
  });
  const opts = { duplicateSlug: "rule-19-sizing-counts-a-test-as-a-concern" };
  const v = sizingViolation(t, opts);
  assert.ok(v, "band_meaning: span still reports a genuine 2-source span");
  assert.equal(v!.severity, "warn", "reported, never refused, exactly as W1-T2503 already pins");
  assert.match(v!.message, /spans 2 distinct subsystems/);
});

test("criterion 5c: risk:low behaves exactly like risk:medium — the exemption is not risk-specific", () => {
  const t = task({ risk: "low", files: ["src/lib/foo.ts", "test/rule-19-sizing-counts-a-test-as-a-concern.test.ts"] });
  const opts = { duplicateSlug: "rule-19-sizing-counts-a-test-as-a-concern" };
  assert.equal(sizingViolation(t, opts), undefined, "one concern passes sizing at risk:low too");
  const spanning = task({
    risk: "low",
    files: ["src/lib/foo.ts", "test/some-other-tasks-test.test.ts"],
  });
  assert.ok(sizingViolation(spanning, opts), "an unrelated test still trips Rule 19 at risk:low");
});

test("criterion 6: an empty files list is still refused as it is today (a DIFFERENT check, untouched)", () => {
  const t = task({
    files: [],
    verify: "auto",
    status: "queued",
  } as Partial<Task>);
  // Rule 19 sizing itself has no opinion on an empty files list (0 < 2 concerns, nothing to flag) —
  // it is `declaredScopeViolation` that refuses an undeclared scope, and this task changes neither
  // that function nor its call site.
  assert.equal(sizingViolation(t), undefined, "sizing itself never fired on an empty files list");
  const scope = declaredScopeViolation(t);
  assert.ok(scope, "an undeclared (absent/empty) files: is still refused today");
  assert.equal(scope!.severity, "block");
});

test("criterion 7: removing the exemption (no companion class recognised at all) makes the one-stem-plus-own-test assertion fail again", () => {
  // W1-T2525's own claim, pinned directly: BEFORE any companion discount existed (the state Rule 19
  // was in prior to W1-T2543, and the state this task's title describes — "risk: medium IS
  // UNREACHABLE for the dominant task shape"), the exact one-stem-plus-own-test filing from
  // criterion 1 above counted its own test as a SECOND concern and was refused at risk:medium.
  // `companionClasses: []` disables the companion mechanism entirely — the same ZERO-changes-to-
  // the-counting-function injection point test/a-suite-is-not-a-second-concern.test.ts's own
  // criterion 4 uses to prove the discount is a table, reused here to prove its ABSENCE regresses
  // Rule 19's sizing count (`sizingViolation` itself always calls `subsystemsOf` with the shipped
  // table, so this reaches into the same seam `sizingViolation`'s count is built from).
  const t = task({ files: ["src/lib/foo.ts", "test/rule-19-sizing-counts-a-test-as-a-concern.test.ts"] });
  const opts = { duplicateSlug: "rule-19-sizing-counts-a-test-as-a-concern" };
  assert.equal(sizingViolation(t, opts), undefined, "sanity: WITH the shipped exemption this passes (criterion 1)");

  const withoutExemption = subsystemsOf(t, undefined, [], opts.duplicateSlug);
  assert.deepEqual(
    [...withoutExemption].sort(),
    ["foo", "rule-19-sizing-counts-a-test-as-a-concern"],
    "with no companion class recognised, the own test counts as a second concern again",
  );
  assert.equal(withoutExemption.size, 2, "which is exactly what trips Rule 19's `< 2` gate at risk:medium");
});
