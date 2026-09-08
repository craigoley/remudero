import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  ATTRIBUTIVE_SUBJECT_RE,
  CONDITIONAL_CLAUSE_RE,
  SELF_REFERENTIAL_SUBJECT_RE,
  bodyContradictsDiff,
  failSummary,
  recognizeChangesetClaims,
} from "../src/lib/review.js";

/**
 * W1-T3061 — `recognizeChangesetClaims` read two shapes as this changeset's own assertion that are
 * not assertions about it at all.
 *
 * MEASURED on origin/main 2026-09-07, five bodies over the same src-touching changeset. Two PRs
 * were refused for them in one afternoon, each after a full CI cycle, neither making the claim:
 *
 *   REFUSED  "A shard is refused unless the PR is plan-only."      <- states the RULE
 *   REFUSED  "1020 files is a very large plan-only diff."          <- a HYPOTHETICAL run
 *   clean    "Depends on #4454, which files the shard plan-only."  <- about ANOTHER PR
 *   REFUSED  "This PR is plan-only."                               <- CONTROL: a real false claim
 *   clean    "... unless the whole diff is `plan-only`."           <- the same mention, quoted
 *
 * THE CONTROL IS WHAT MAKES THE REST MEANINGFUL. The check is doing its job on a genuine false
 * claim, and the third row shows the predicate already distinguishes some non-assertions. These
 * are two specific gaps, not a broken check, and the direction of failure matters: a false refusal
 * costs a cycle, a false pass costs the guarantee. So both new reads are FAIL-CLOSED — an
 * unenumerated subordinator and an unreadable subject frame leave today's verdict untouched.
 */

/** A src-touching changeset, so a genuine `plan-only` claim about it would be FALSE. */
const DIFF = ["src/lib/review.ts", "test/a-described-rule-is-not-a-claim.test.ts"];

const body = (line: string) => ["Intro.", "", line, "", "Acceptance:", "- c | unit test: test/x.test.ts", ""].join("\n");
const refused = (line: string) => bodyContradictsDiff(body(line), DIFF).length > 0;

// ── criterion 1: a rule stated conditionally is not this changeset's claim ─────────────────────

test("W1-T3061 criterion 1: a body stating the rule conditionally is no longer read as claiming it", () => {
  assert.equal(refused("A shard is refused unless the PR is plan-only."), false, "the measured #4450/#4457 shape");
  for (const line of [
    "A shard is refused unless the PR is plan-only.",
    "The gate blocks if the diff is plan-only.",
    "Coverage is skipped when the change is plan-only.",
    "It is exempt whenever the PR is plan-only.",
    "The carve-out applies provided the diff is plan-only.",
    "The fast lane fires only when the diff is plan-only.",
  ]) {
    assert.equal(refused(line), false, `a conditional states a rule, it does not assert one: ${line}`);
  }
});

test("W1-T3061 criterion 1: the widening is ENUMERATED — a subordinator not on the list still refuses", () => {
  // The failure direction is the point. A list keeps this auditable and keeps anything that
  // refuses today refusing, so the change can never silently stop catching a real false claim.
  assert.equal(refused("The gate blocks because the diff is plan-only."), true, "`because` is not on the list");
  assert.equal(refused("The gate blocks although the diff is plan-only."), true, "`although` is not on the list");
  assert.equal(refused("The gate blocks since the diff is plan-only."), true, "`since` is not on the list");
});

test("W1-T3061 criterion 1: the subordinator must govern THIS clause, not merely appear earlier", () => {
  // Bounded exactly like W1-T2533's denial arms: an anywhere-in-sentence qualifier would silence a
  // genuine claim that happens to share a sentence with a conditional about something else.
  assert.equal(
    refused("Unless the linter is upgraded, this PR is plan-only."),
    true,
    "a conditional governing a DIFFERENT clause must not release the claim in this one",
  );
});

// ── criterion 2: a hypothetical the body declines to produce is not this changeset ─────────────

test("W1-T3061 criterion 2: a body describing a hypothetical diff is not read as describing this one", () => {
  assert.equal(refused("1020 files is a very large plan-only diff."), false, "the measured shape");
  assert.equal(refused("Forty shards is a big plan-only changeset."), false, "another subject, same frame");
  assert.equal(refused("#4454 is a plan-only diff."), false, "a subject naming ANOTHER pull request");
});

test("W1-T3061 criterion 2: the frame is ENUMERATED too — a copula outside the set keeps refusing", () => {
  // MEASURED on origin/main: "Forty shards would be a big plan-only changeset." refuses there and
  // refuses here. `would be` is a hypothetical marker and releasing it would be defensible, but the
  // shard measured `is`, and the falsifier refuses a widening that reaches past what was measured.
  // Recorded as a pinned NON-change so a later lane sees it was a decision, not an oversight.
  assert.equal(refused("Forty shards would be a big plan-only changeset."), true, "`would be` is outside the frame");
});

test("W1-T3061 criterion 2: a SELF-REFERENTIAL subject in the same frame is still a claim", () => {
  // This is the half that must not move. The frame is identical; only the subject differs, and the
  // subject is the whole discriminator.
  assert.equal(refused("This is a plan-only change."), true, "the W1-T2533 assertion is unmoved");
  assert.equal(refused("The diff is a plan-only changeset."), true);
  assert.equal(refused("It is a plan-only diff."), true);
  // NOT a hole this task opened: `patch` is absent from CHANGESET_CONTEXT_RE, so the attributive
  // arm has never read it as a changeset noun. Measured on origin/main, clean there too. Pinned so
  // the next reader can tell an inherited gap from one of these two widenings.
  assert.equal(refused("It is a plan-only patch."), false, "pre-existing: `patch` is not a changeset noun");
});

test("W1-T3061 criterion 2: an attributive with NO readable frame keeps refusing", () => {
  // FAIL-CLOSED: only a positively identified foreign subject cancels the claim. No copular frame
  // means no opinion, and no opinion means the refusal stands.
  assert.equal(refused("This ships a plan-only diff."), true, "no copular frame — refusal stands");
  assert.equal(refused("Plan-only change, one shard added."), true, "a bare attributive is unaffected");
});

// ── criterion 3: the genuine false claim is STILL refused ──────────────────────────────────────

test("W1-T3061 criterion 3: the control — a real false claim on a src-touching diff is still refused", () => {
  // Without this the task would have traded a false refusal for a false pass, which is the more
  // expensive direction: a false pass merges.
  assert.equal(refused("This PR is plan-only."), true);
  assert.equal(refused("The diff is plan-only."), true);
  assert.equal(refused("Plan-only: one file added."), true, "the label arm is untouched");
  assert.equal(refused("This is a plan-only change."), true, "the attributive arm still refuses an assertion");
});

test("W1-T3061 criterion 3: all five measured bodies land where the rationale says they must", () => {
  const expected: Array<[string, boolean]> = [
    ["A shard is refused unless the PR is plan-only.", false],
    ["1020 files is a very large plan-only diff.", false],
    ["Depends on #4454, which files the shard plan-only.", false],
    ["This PR is plan-only.", true],
    ["... unless the whole diff is `plan-only`.", false],
  ];
  for (const [line, shouldRefuse] of expected) {
    assert.equal(refused(line), shouldRefuse, `measured row: ${line}`);
  }
  // and the recognition COUNT moves with the verdict, so a released body is not merely
  // un-contradicted while still counted as a recognised claim (W1-T1264's silent-pass field).
  assert.equal(recognizeChangesetClaims(body("A shard is refused unless the PR is plan-only."), DIFF).recognisedCount, 0);
  assert.equal(recognizeChangesetClaims(body("This PR is plan-only."), DIFF).recognisedCount, 1);
});

// ── criterion 4: the refusal names the escape ──────────────────────────────────────────────────

test("W1-T3061 criterion 4: the refusal names the inline-quote escape an author can actually use", () => {
  // Both PRs refused on 2026-09-07 fixed it by marking ONE mention as a quotation, a remedy
  // discoverable only by reading review.ts.
  const [contradiction] = bodyContradictsDiff(body("This PR is plan-only."), DIFF);
  assert.ok(contradiction, "sanity: the control still produces a contradiction to render");
  const summary = failSummary([], false, false, false, 0, [contradiction]);
  assert.match(summary, /backtick a mention to quote it/, "the remedy is stated, not left in the source");
  assert.match(summary, /body contradicts its own diff/, "and the phrase five suites pin is unchanged");
});

test("W1-T3061 criterion 4: the remedy survives the 140-char commit-status cap", () => {
  // THE REASON PLACEMENT IS LOAD-BEARING, and it is measured rather than assumed. This string is
  // the commit-status description, capped at 140 by the API — the `criteriaTampered` branch beside
  // it was rewritten to 133 characters for exactly that reason. MEASURED on origin/main: with a
  // realistic file list this message was ALREADY 161 and 157 characters, so the tail was being
  // sliced before this task existed. The remedy therefore rides in FRONT of the file list, which
  // is the half a reader can recover from the PR itself.
  const summary = failSummary([], false, false, false, 0, [
    { claim: "plan-only", files: ["src/lib/review.ts", "test/a-described-rule-is-not-a-claim.test.ts"] },
  ]);
  assert.ok(summary.length > 140, "sanity: this case really is truncated, so the assertion below is not vacuous");
  assert.match(summary.slice(0, 140), /backtick a mention to quote it/, "the remedy must survive the slice");
});

// ── each new surface driven by identifier, both arms ───────────────────────────────────────────
//
// `negative-reachability-ratchet` (W1-T2317) counts a module-scope `_RE` that no fixture ACCEPTS
// AND REJECTS directly as fixture-less debt, and reaching one only through its caller satisfies
// nothing: a distinction dying at a seam is the defect that ratchet exists for. Same shape as
// W1-T2533's two denial regexes, which are exported for the same reason.

test("W1-T3061: CONDITIONAL_CLAUSE_RE fires only on an ENUMERATED subordinator governing this clause", () => {
  // The unhealthy arm: the clause is a rule, a condition or a hypothetical, so there is no claim.
  assert.equal(CONDITIONAL_CLAUSE_RE.test("a shard is refused unless the PR is "), true);
  assert.equal(CONDITIONAL_CLAUSE_RE.test("the gate blocks if the diff is "), true);
  assert.equal(CONDITIONAL_CLAUSE_RE.test("skipped when the change is "), true);
  assert.equal(CONDITIONAL_CLAUSE_RE.test("the fast lane fires only when the diff is "), true);
  // The healthy arm: a bare assertion, a subordinator OUTSIDE the list, and a conditional
  // governing a DIFFERENT clause all leave the copular arm's verdict exactly where it was.
  assert.equal(CONDITIONAL_CLAUSE_RE.test("this PR is "), false);
  assert.equal(CONDITIONAL_CLAUSE_RE.test("the gate blocks because the diff is "), false, "`because` is not enumerated");
  assert.equal(CONDITIONAL_CLAUSE_RE.test("unless the linter is upgraded, this PR is "), false, "governs another clause");
});

test("W1-T3061: ATTRIBUTIVE_SUBJECT_RE matches the copular frame and captures its subject", () => {
  // The unhealthy arm for the caller: a frame IS readable, so the subject can be judged.
  assert.equal(ATTRIBUTIVE_SUBJECT_RE.exec("1020 files is a very large ")?.[1], "1020 files");
  assert.equal(ATTRIBUTIVE_SUBJECT_RE.exec("This is a ")?.[1], "This");
  assert.equal(ATTRIBUTIVE_SUBJECT_RE.exec("The diff is a ")?.[1], "The diff");
  // The healthy arm: NO readable frame, which is the fail-closed path — the caller then keeps
  // refusing rather than guessing, so a null here is what preserves today's verdict.
  assert.equal(ATTRIBUTIVE_SUBJECT_RE.test("This ships a "), false, "no copula");
  assert.equal(ATTRIBUTIVE_SUBJECT_RE.test("this is not a "), false, "a negator breaks the frame; W1-T2533 owns that case");
  assert.equal(ATTRIBUTIVE_SUBJECT_RE.test("Forty shards would be a big "), false, "`would be` is outside the frame");
});

test("W1-T3061: SELF_REFERENTIAL_SUBJECT_RE tells THIS changeset from any other subject", () => {
  // The unhealthy arm for the caller: the subject IS this changeset, so the claim stands.
  assert.equal(SELF_REFERENTIAL_SUBJECT_RE.test("This"), true);
  assert.equal(SELF_REFERENTIAL_SUBJECT_RE.test("It"), true);
  assert.equal(SELF_REFERENTIAL_SUBJECT_RE.test("The diff"), true);
  assert.equal(SELF_REFERENTIAL_SUBJECT_RE.test("the commit"), true);
  // The healthy arm: a subject naming something else, which is what releases the claim.
  assert.equal(SELF_REFERENTIAL_SUBJECT_RE.test("1020 files"), false);
  assert.equal(SELF_REFERENTIAL_SUBJECT_RE.test("Forty shards"), false);
  assert.equal(SELF_REFERENTIAL_SUBJECT_RE.test("the linter"), false, "`the` alone is not self-referential");
});
