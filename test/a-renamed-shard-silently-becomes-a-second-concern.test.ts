import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task } from "../src/lib/plan.js";
import { ownFalsifierRenameCandidates, sizingViolation, subsystemsOf } from "../src/lib/task-linter.js";

/**
 * test/a-renamed-shard-silently-becomes-a-second-concern.test.ts — W1-T2673.
 *
 * Rule 19's own-falsifier discount (W1-T2525) turns on STRING EQUALITY between a shard's own
 * filename slug and a declared `test/` companion's `moduleIdFromPath`. Rename either side and the
 * equality breaks: the companion counts as an ordinary concern, `subsystemsOf` reports 2, and a
 * `risk: medium` task is refused for a sizing violation — one whose real cause is a filename, not
 * a genuine second concern. Nothing in the pre-W1-T2814 message named the slug, the stem, or the
 * near-miss that would have been discounted; an author reading it would raise the risk band or
 * decompose a task that was correctly sized all along.
 *
 * W1-T2814 (PR #4019, e6b57101) built the fix this task also asks for: `ownFalsifierRenameCandidates`
 * finds which declared companion would clear the span on an exact rename, and
 * `ownFalsifierRenameExit` appends the named stem/slug/rename to `sizingViolation`'s block message —
 * riding on the SAME message, never changing the count or the decision. This suite is W1-T2673's
 * own falsifier, asserting THIS task's four acceptance criteria directly against the shipped
 * behaviour rather than assuming W1-T2814's coverage subsumes it.
 */

const SOURCE_FILE = "src/lib/gizmo-encoder.ts";
const NEAR_MISS_TEST_FILE = "test/gizmo-encoder-suite.test.ts"; // stem differs from the shard's own slug
const NEAR_MISS_SLUG = "gizmo-encoder-suite"; // moduleIdFromPath(NEAR_MISS_TEST_FILE)
const MISMATCHED_OWN_SLUG = "gizmo-encoder-task"; // the shard's ACTUAL (mismatched) filename slug

function renameableFixture(): Task {
  return {
    id: "W1-T9101",
    title: "a shard whose own slug matches neither its source nor its test",
    risk: "medium",
    files: [SOURCE_FILE, NEAR_MISS_TEST_FILE],
    acceptance: [{ claim: "the gizmo is encoded", proof: `unit test: ${NEAR_MISS_TEST_FILE}` }],
  } as unknown as Task;
}

// ── acceptance 1 & 3: a would-clear near-miss is NAMED, and never itself discounted ────────────

test("W1-T2673 (acceptance 1): a violation that would clear on an exact slug match names the stem, the slug, and the rename", () => {
  const v = sizingViolation(renameableFixture(), { duplicateSlug: MISMATCHED_OWN_SLUG });
  assert.ok(v, "the mismatched slug does not discount the companion, so the span is real as reported");
  assert.equal(v.severity, "block");
  // Names WHICH declared file the span turns on — the stem.
  assert.ok(v.message.includes(NEAR_MISS_TEST_FILE), "names the companion whose stem the span turns on");
  // Names the exact slug a rename would have to hit.
  assert.ok(v.message.includes(NEAR_MISS_SLUG), "names the slug that would discount it");
  // Names the rename itself, not just the two facts in isolation.
  assert.match(v.message, /rename this shard so its filename slug is `gizmo-encoder-suite`/);
});

test("W1-T2673 (acceptance 3): the near-miss is reported but NEVER honoured — the task stays refused", () => {
  const withNearMiss = sizingViolation(renameableFixture(), { duplicateSlug: MISMATCHED_OWN_SLUG });
  assert.ok(withNearMiss, "a near-match alone must not silently clear the violation");
  assert.equal(withNearMiss.severity, "block", "reporting the near-miss is not the same as honouring it");
  assert.equal(
    subsystemsOf(renameableFixture(), undefined, undefined, MISMATCHED_OWN_SLUG).size,
    2,
    "the count itself is unmoved by the near-miss — only an EXACT rename would change it",
  );
  // The control: renaming the shard's slug to the EXACT stem is what would have discounted it.
  assert.equal(subsystemsOf(renameableFixture(), undefined, undefined, NEAR_MISS_SLUG).size, 1);
});

// ── acceptance 2: the subsystem count and the refusal are byte-identical either way ────────────

test("W1-T2673 (acceptance 2): the count and the refusal are byte-identical whether or not a rename exit is offered", () => {
  const withExit = sizingViolation(renameableFixture(), { duplicateSlug: MISMATCHED_OWN_SLUG });
  const twoRealStems: Task = {
    id: "W1-T9102",
    title: "two genuine source concerns, no companion at all",
    risk: "medium",
    files: ["src/lib/alpha-widget.ts", "src/lib/beta-widget.ts"],
    acceptance: [{ claim: "c", proof: "grep: alpha wired to beta in src/lib/alpha-widget.ts" }],
  } as unknown as Task;
  const withoutExit = sizingViolation(twoRealStems, { duplicateSlug: "two-genuine-source-concerns" });

  assert.ok(withExit && withoutExit);
  // Same subsystem count, same severity, same fixed prefix — no task passes that failed before,
  // and the count is not perturbed by whether the message goes on to offer a rename.
  assert.equal(
    subsystemsOf(renameableFixture(), undefined, undefined, MISMATCHED_OWN_SLUG).size,
    subsystemsOf(twoRealStems, undefined, undefined, "two-genuine-source-concerns").size,
  );
  assert.equal(withExit.severity, withoutExit.severity, "both block — refusal itself is identical");
  const fixedPrefix = "spans 2 distinct subsystems/concerns";
  assert.ok(withExit.message.startsWith(fixedPrefix));
  assert.ok(withoutExit.message.startsWith(fixedPrefix));
  assert.match(withExit.message, /raise to risk:high or decompose into one task per concern/);
  assert.match(withoutExit.message, /raise to risk:high or decompose into one task per concern/);
});

// ── acceptance 4: no test companion at all ⇒ unchanged, no note ────────────────────────────────

test("W1-T2673 (acceptance 4): a violation with no test companion at all is unchanged and gains no rename note", () => {
  const noCompanionAtAll: Task = {
    id: "W1-T9103",
    title: "two source files, no test/ path in files at all",
    risk: "medium",
    files: ["src/lib/alpha-widget.ts", "src/lib/beta-widget.ts"],
    acceptance: [{ claim: "c", proof: "grep: alpha wired to beta in src/lib/alpha-widget.ts" }],
  } as unknown as Task;

  assert.deepEqual(
    ownFalsifierRenameCandidates(noCompanionAtAll, "two-source-files-no-test-path-in-files-at-all"),
    [],
    "nothing declared is a test/ companion, so there is nothing to offer a rename toward",
  );

  const v = sizingViolation(noCompanionAtAll, { duplicateSlug: "two-source-files-no-test-path-in-files-at-all" });
  assert.ok(v, "two real source stems still span two concerns");
  assert.equal(v.severity, "block");
  assert.equal(
    v.message,
    "spans 2 distinct subsystems/concerns (alpha-widget, beta-widget) at risk:medium — Rule 19: raise " +
      "to risk:high or decompose into one task per concern",
    "byte-identical to the message a task with no test/ companion has always received",
  );
  assert.doesNotMatch(v.message, /rename this shard/, "no companion exists to name, so no rename note appears");
  assert.doesNotMatch(v.message, /ONLY IF/, "the conditional exit never fires with nothing to offer");

  // Also unchanged with NO slug threaded at all — the common pre-dispatch path.
  const vNoSlug = sizingViolation(noCompanionAtAll, {});
  assert.ok(vNoSlug);
  assert.equal(vNoSlug.message, v.message, "no slug threaded reads the same as an unmatched one here");
});
