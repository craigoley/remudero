import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DENIED_ATTRIBUTIVE_RE, DENIED_LABEL_ANSWER_RE, bodyContradictsDiff } from "../src/lib/review.js";

/**
 * W1-T2533 — the label arm of `shorthandIsAboutChangeset` decides on the COLON alone and never
 * reads what follows, so a body that answered the scope question HONESTLY IN THE NEGATIVE was
 * refused for having made the claim it just denied.
 *
 * MEASURED on #3373, whose body said `Plan-only: no.` — the correct answer, correctly stating the
 * PR is NOT plan-only. A reader who answers truthfully was punished for it, which is the one shape
 * a scope detector must never punish.
 */

const DIFF = ["src/lib/a.ts", "test/a.test.ts"];
const body = (line: string) => ["Intro.", "", line, "", "Acceptance:", "- c | unit test: test/x.test.ts", ""].join("\n");
const refused = (line: string) => bodyContradictsDiff(body(line), DIFF).length > 0;

test("W1-T2533 criterion 1: a body that answers the scope question negatively is not refused", () => {
  for (const line of [
    "Plan-only: no.",
    "Plan-only: no — this touches src/ and test/.",
    "Plan-only: not this time, src/ is edited.",
    "Plan-only: nope.",
    "**Plan-only**: no, see below.",
  ]) {
    assert.equal(refused(line), false, `an honest denial must not be refused: ${line}`);
  }
});

test("W1-T2533 criterion 2: the label form still refuses a POSITIVE claim whose elaboration BEGINS with a negative word", () => {
  // THE HARD CASE, and the reason the discriminator is not simply "contains a negative word".
  // "no code" describes what the scope IS; it does not answer the label in the negative.
  assert.equal(refused("Plan-only: no code, only the shard."), true, "an assertion must stay refused");
  assert.equal(refused("Plan-only: no src/ edit, plan files alone."), true);
  assert.equal(refused("Plan-only: one file added."), true, "the ordinary assertion is unmoved");
  assert.equal(refused("Plan-only: nothing but the shard."), true, "'nothing' is not a negative ANSWER");
});

test("W1-T2533 criterion 3: the attributive form still refuses an asserted claim while releasing a denied one", () => {
  assert.equal(refused("This is a plan-only change."), true, "the assertion survives");
  assert.equal(refused("This is not a plan-only change."), false, "the denial is released");
  assert.equal(refused("This is never a plan-only diff."), false);
  // and the negator must be IMMEDIATE — a negation elsewhere in the sentence must not silence a
  // genuine claim, the same bound the copular arm already carries.
  assert.equal(
    refused("There is no reason to doubt it; this is a plan-only change."),
    true,
    "an unrelated negation earlier in the sentence must not release a real claim",
  );
});

test("W1-T2533 criterion 4: the copular arm's behaviour on both an assertion and a denial is unchanged", () => {
  // It was already correct — SELF_REFERENTIAL_CLAIM_RE requires the linking verb IMMEDIATELY
  // before the shorthand, so "is not plan-only" never matched. Pinned so this task cannot be
  // credited with a fix it did not make, and so a later change cannot quietly break it.
  assert.equal(refused("The diff is plan-only."), true);
  assert.equal(refused("The diff is not plan-only."), false);
});

test("W1-T2533 criterion 5: a shorthand merely cited in prose, and a path containing it, both stay silent", () => {
  assert.equal(refused("The plan-only carve-out exempts a plan-scope diff."), false, "about the LANE, not this diff");
  assert.equal(refused("See test/trailer-credit-plan-only.test.ts for detail."), false, "a path is not a claim");
  assert.equal(refused("W1-T274 described its revert as data-only."), false, "about ANOTHER PR");
});

test("W1-T2533 criterion 6: #3373's verbatim sentence is a fixture and passes", () => {
  // The observation this task is anchored to. #3373's body carried exactly this line against a
  // three-file diff and was refused for it.
  const real = ["src/lib/task-linter.ts", "src/run-task.ts", "test/a-blocked-task-must-name-its-disposition.test.ts", "scripts/source-size-baseline.json"];
  assert.equal(
    bodyContradictsDiff(body("Plan-only: no."), real).length,
    0,
    "the exact body that was wrongly refused must now pass",
  );
});

test("W1-T2533: the detector still refuses the claims it exists to catch — the floor is unmoved", () => {
  // A regression lock spanning all three arms, so the negation handling cannot be widened later
  // into a general escape hatch.
  for (const line of ["Plan-only: one file added.", "This is a plan-only change.", "The diff is plan-only."]) {
    assert.equal(refused(line), true, `must still refuse: ${line}`);
  }
});

// W1-T2533: the two denial regexes get their own both-arm fixtures, driving the REFUSING arm and
// the ACCEPTING arm separately. `bodyContradictsDiff` above exercises them only through the
// surrounding arm logic, so a regex that widened into a general escape hatch (or narrowed into a
// dead branch) could still leave those cases green. `negative-reachability-ratchet` enumerates
// every module-scope `_RE` in src/ and holds each file's fixture-less count at its baseline, which
// is what requires the two symbols to be named by identifier here rather than only reached through
// their caller.

test("W1-T2533: DENIED_LABEL_ANSWER_RE separates a negative ANSWER from a description of content", () => {
  // The unhealthy arm the regex exists to name: the label was answered, so there is no claim.
  assert.equal(DENIED_LABEL_ANSWER_RE.test(": no."), true);
  assert.equal(DENIED_LABEL_ANSWER_RE.test(": nope"), true);
  assert.equal(DENIED_LABEL_ANSWER_RE.test(": not this time"), true);
  assert.equal(DENIED_LABEL_ANSWER_RE.test("**: no**"), true, "reads through markdown emphasis");
  // The healthy arm: `no <noun>` DESCRIBES the changeset rather than denying the label, so it is
  // still a claim and must stay judgeable. This is the distinction the regex's lookahead draws.
  assert.equal(DENIED_LABEL_ANSWER_RE.test(": no code."), false);
  assert.equal(DENIED_LABEL_ANSWER_RE.test(": no src touched"), false);
  assert.equal(DENIED_LABEL_ANSWER_RE.test(": one file added."), false);
  assert.equal(DENIED_LABEL_ANSWER_RE.test(" describes a lane, not this diff"), false, "no colon: not the label form at all");
});

test("W1-T2533: DENIED_ATTRIBUTIVE_RE fires only on a negator IMMEDIATELY before the noun phrase", () => {
  // The unhealthy arm: the shorthand is modified AND denied, so the attributive read must not
  // credit it as a claim.
  assert.equal(DENIED_ATTRIBUTIVE_RE.test("this is not a "), true);
  assert.equal(DENIED_ATTRIBUTIVE_RE.test("this is never a "), true);
  assert.equal(DENIED_ATTRIBUTIVE_RE.test("it isn't a "), true);
  assert.equal(DENIED_ATTRIBUTIVE_RE.test("these aren't "), true, "the article is optional");
  // The healthy arm: an affirmative attributive stays a claim, and — the bound that matters — a
  // negation EARLIER in the same sentence must not silence one, which is why the pattern is
  // anchored to the end of the preceding text rather than searched anywhere in it.
  assert.equal(DENIED_ATTRIBUTIVE_RE.test("this is a "), false);
  assert.equal(DENIED_ATTRIBUTIVE_RE.test("not the lane it ran in, this is a "), false);
  assert.equal(DENIED_ATTRIBUTIVE_RE.test("the revert was not reviewed, so the "), false);
});
