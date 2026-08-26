import assert from "node:assert/strict";
import { test } from "node:test";

import { judgeCriterion, type ReportSubstituteCause } from "../src/lib/review.js";

// A refusal named a failure that never happened (2026-08-25).
//
// The reason read "PR body unreadable -- judged against the worker's own text (substituted after a
// failed body fetch)". No fetch had failed. `review.body_fetch_error` and `fix.body_fetch_error`
// both read ZERO across 27 archives and 258,784 rows; neither has ever fired on any host. The real
// mechanism is that the fix rung fetches the body ONLY in `body-coverage` mode and defaults the
// substitute flag true for the other three, so on `ci-log`, `reviewer-unmet` and `merge-conflict`
// no fetch is attempted at all -- and `body-coverage` has dispatched 4 times all-time against
// `ci-log` 140 and `reviewer-unmet` 40. The string sent an operator recon hunting a transient
// GitHub read failure and a body-size bound, and refuted both.
//
// THE VERDICT DOES NOT CHANGE HERE. `reportSubstituted` keeps failing closed in every branch, and
// coverage stays withheld in EITHER direction -- the fail-open case W1-T1100 design (iii) exists to
// refuse. Only the wording branches.

const criterion = { claim: "the digest fires on its own cadence", proof: "unit test: test/fleet-digest-cadence.test.ts" };
/** Tokens that DO cover the proof's keywords -- so every case below is the high-coverage shape,
 *  which is the one that must still refuse. */
const covering = new Set(["unit", "test", "fleet", "digest", "cadence", "ts"]);

function judge(cause: ReportSubstituteCause | undefined): string {
  const v = judgeCriterion(criterion, covering, undefined, undefined, true, undefined, cause);
  assert.equal(v.met, false, "the refusal must stand in every branch -- only the wording differs");
  return v.reason ?? "";
}

test("a never-fetched substitute says so, and names the mode that does not read the body", () => {
  const reason = judge({ kind: "never-fetched", fixMode: "ci-log" });
  assert.match(reason, /the PR body was NOT read/);
  assert.match(reason, /"ci-log" fix mode does not fetch it/, "the mode is the actionable half");
  assert.match(reason, /withheld as substantiation/, "the withholding still stands");
  // NEGATIVE, so this branch can never render the other's text.
  assert.doesNotMatch(reason, /read FAILED/);
  assert.doesNotMatch(reason, /failed body fetch/, "the string that cost a recon must not survive");
  assert.doesNotMatch(reason, /unreadable/, "nothing here was unreadable");
});

test("a genuine fetch failure says THAT, and nothing about a mode", () => {
  const reason = judge({ kind: "fetch-failed" });
  assert.match(reason, /fetched and the read FAILED/);
  assert.match(reason, /withheld as substantiation/);
  // NEGATIVE in the other direction.
  assert.doesNotMatch(reason, /was NOT read/);
  assert.doesNotMatch(reason, /fix mode does not fetch it/);
});

test("the two renderings are not the same string, which is the whole point", () => {
  assert.notEqual(judge({ kind: "never-fetched", fixMode: "reviewer-unmet" }), judge({ kind: "fetch-failed" }));
});

test("an unrecorded cause guesses at neither, rather than asserting the rare one", () => {
  const reason = judge(undefined);
  assert.match(reason, /cause not recorded/);
  assert.doesNotMatch(reason, /read FAILED/, "silence must not be rendered as the failure that has never occurred");
  assert.doesNotMatch(reason, /was NOT read/);
  assert.match(reason, /withheld as substantiation/);
});

test("a never-fetched cause with no mode in hand still avoids claiming a failure", () => {
  const reason = judge({ kind: "never-fetched" });
  assert.match(reason, /this code path does not fetch it/);
  assert.doesNotMatch(reason, /read FAILED/);
});

test("the refusal is unchanged at FULL coverage, which is the fail-open case the rule exists to refuse", () => {
  // The 22:57:43.941Z row: 6/6 keywords covered, all eight criteria still unmet. Coverage is
  // withheld in EITHER direction, so a perfect substitute fails exactly like a poor one.
  const rich = judgeCriterion(criterion, covering, undefined, undefined, true, undefined, { kind: "never-fetched", fixMode: "ci-log" });
  const poor = judgeCriterion(criterion, new Set(["unrelated"]), undefined, undefined, true, undefined, { kind: "never-fetched", fixMode: "ci-log" });
  assert.equal(rich.met, false);
  assert.equal(poor.met, false);
  // FULL coverage generically -- N/N -- rather than a hardcoded number, so this asserts the
  // property (every keyword covered) instead of the tokenizer's current arithmetic.
  assert.match(rich.reason ?? "", /\((\d+)\/\1 proof keywords\)/, "the count is still reported, and it is full");
  assert.match(rich.reason ?? "", /withheld as substantiation/, "and still withheld despite being full");
});

test("a NON-substitute report is untouched by any of this", () => {
  const v = judgeCriterion(criterion, covering, undefined, undefined, false, undefined, { kind: "fetch-failed" });
  assert.equal(v.met, true, "a real body at full coverage still passes -- the cause is inert when the flag is false");
  assert.doesNotMatch(v.reason ?? "", /worker's own text/);
});
