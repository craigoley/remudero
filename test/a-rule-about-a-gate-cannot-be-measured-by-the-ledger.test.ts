// test/a-rule-about-a-gate-cannot-be-measured-by-the-ledger.test.ts — W1-T2958.
//
// `RULE_SIGNATURES` decides whether one of this repo's own rules is WORKING, and it offered exactly
// ONE recurrence channel: `stepPatterns` matched against the ledger union. `rule-efficacy.ts`'s own
// header states the boundary — "HOST-SIDE, NOT A CI GATE: the ledger lives on the daemon host;
// nothing in CI can read it" — so a rule whose failure class IS a red check can never become
// measurable, however the pattern is written.
//
// THE TABLE ALREADY SAID SO, AND DEFERRED IT BY NAME. Its own doc on the diff-coverage row: "a
// recurrence is 'WHICH ci check failed' … that name lives only in GitHub's check-run data …
// Reading GitHub check names is exactly the 'CI-failure-class signatures' this task's design marks
// NOT IN SCOPE (follow-on). UNMEASURABLE, honestly." This suite is that follow-on.

import assert from "node:assert/strict";
import test from "node:test";

import {
  RULE_SIGNATURES,
  declaredChannel,
  ruleEfficacyReport,
  type CiFailureObservation,
  type MeasurableRuleSignature,
  type RuleSignature,
} from "../src/lib/rule-efficacy.js";

/** A state dir with no ledger at all: the ledger channel finds nothing, so nothing a CI-channel
 *  rule reports can have leaked in from it. */
const NO_LEDGER = "/nonexistent-state-dir-for-w1-t2958";

const ciRule = (over: Partial<RuleSignature> = {}): RuleSignature =>
  ({
    ruleId: "CLAUDE.md#before-you-push:diff-coverage-gate",
    citation: "#768, #773, #777",
    description: "Run the diff-coverage gate LOCALLY before pushing any PR that adds source lines.",
    measurable: true,
    effectiveDate: "2026-08-01",
    ciGatePatterns: [/^coverage-ratchet$/, /^diff-coverage$/],
    ...over,
  }) as RuleSignature;

const obs = (gate: string, at: string): CiFailureObservation => ({ gate, at });

const verdictFor = (sigs: RuleSignature[], ci?: CiFailureObservation[]) =>
  ruleEfficacyReport(NO_LEDGER, sigs, undefined, ci).rules[0];

test("W1-T2958 a rule may declare a CI gate as its recurrence channel, and the report counts from it", () => {
  const v = verdictFor(
    [ciRule()],
    [obs("coverage-ratchet", "2026-09-01T10:00:00Z"), obs("coverage-ratchet", "2026-09-03T10:00:00Z")],
  );
  assert.equal(v.status, "REPEATING");
  assert.equal(v.recurrences.length, 2, "both post-citation reds recur this rule's failure class");
});

test("W1-T2958 the diff-coverage rule reads MEASURED rather than UNMEASURABLE once it declares that channel", () => {
  // The whole point: this row WAS `measurable: false`, and not by oversight — no ledger row
  // carries a failing check's NAME. With the CI channel it is gradeable, and the shipped table
  // now declares it (see the RULE_SIGNATURES test at the end of this file).
  const clean = verdictFor([ciRule()], []);
  assert.equal(clean.status, "PREVENTING", "no post-citation red on those gates is a real zero, not an absence");
  assert.equal(clean.why, undefined);
  assert.equal(clean.effectiveDate, "2026-08-01");
});

test("W1-T2958 a rule declaring NO channel still renders UNMEASURABLE with its reason, never a zero rate", () => {
  // P48's no-naked-zero clause. Widening the table must not turn an honest "we cannot measure this"
  // into a confident 0% over nothing measured.
  const v = verdictFor([
    {
      ruleId: "MASTER-PLAN.md#standing-rule-14:wiring-not-proved",
      citation: "W1-T365",
      description: "wiring must be proved, not asserted",
      measurable: false,
      why: "no ledger step distinguishes a live dispatch call site from a unit-tested pure function",
    } as RuleSignature,
  ]);
  assert.equal(v.status, "UNMEASURABLE");
  assert.match(v.why ?? "", /no ledger step distinguishes/);
  assert.deepEqual(v.recurrences, []);
});

test("W1-T2958 a red dated BEFORE the citation is not a recurrence, matching the ledger channel's own boundary", () => {
  // Without this the corpus's whole history counts against a rule written last week, and every rule
  // reads as failing — the boundary the ledger channel already applies, carried over unchanged.
  const v = verdictFor(
    [ciRule({ effectiveDate: "2026-08-15" } as Partial<RuleSignature>)],
    [obs("coverage-ratchet", "2026-08-01T10:00:00Z"), obs("coverage-ratchet", "2026-08-20T10:00:00Z")],
  );
  assert.equal(v.status, "REPEATING");
  assert.equal(v.recurrences.length, 1, "only the red AFTER the effective date counts");
});

test("W1-T2958 a gate the rule does not name is not its recurrence", () => {
  const v = verdictFor([ciRule()], [obs("jscpd-gate", "2026-09-01T10:00:00Z")]);
  assert.equal(v.status, "PREVENTING", "an unrelated red gate must not be attributed to this rule");
});

test("W1-T2958 a CI-channel rule with NO corpus supplied is UNMEASURABLE, never a confident zero", () => {
  // THE FALSIFIER THAT MATTERS. "No corpus was supplied" and "the corpus contained no red" are
  // different facts, and the second is the only one that may render PREVENTING.
  const v = verdictFor([ciRule()], undefined);
  assert.equal(v.status, "UNMEASURABLE");
  assert.match(v.why ?? "", /corpus/i, "the reason must name the missing corpus, not a rate");
  assert.deepEqual(v.recurrences, []);
});

test("W1-T2958 a LEDGER-channel entry is graded exactly as before this change", () => {
  // The regression pin: this task extends one union and must change nothing about the channel that
  // already worked. With no ledger present the ledger rule reports UNMEASURABLE-by-absence rather
  // than borrowing the CI corpus.
  const ledgerRule = {
    ruleId: "CLAUDE.md#investigation-discipline:bound-fires-on-healthy-condition",
    citation: "W1-T312",
    description: "A bound that fires on a HEALTHY condition is this repo's recurring defect.",
    measurable: true,
    effectiveDate: "2026-08-01",
    stepPatterns: [/ci\.stalled/],
  } as RuleSignature;
  const v = verdictFor([ledgerRule], [obs("coverage-ratchet", "2026-09-01T10:00:00Z")]);
  assert.notEqual(v.status, "REPEATING", "a ledger rule must never count a CI observation as its own recurrence");
  assert.deepEqual(v.recurrences, []);
});

test("W1-T2958 an entry declaring BOTH channels, or NEITHER, is refused rather than graded", () => {
  // The invariant the type deliberately does not carry: `MeasurableRuleSignature` keeps optional
  // channels so existing readers of `stepPatterns` still compile, so "exactly one" is a RUNTIME
  // rule — and a table that is data, editable without a compile, is exactly where it must be.
  const base = {
    ruleId: "x",
    citation: "c",
    description: "d",
    measurable: true,
    effectiveDate: "2026-08-01",
  };
  const both = verdictFor(
    [{ ...base, stepPatterns: [/x/], ciGatePatterns: [/^coverage-ratchet$/] } as RuleSignature],
    [obs("coverage-ratchet", "2026-09-01T10:00:00Z")],
  );
  assert.equal(both.status, "UNMEASURABLE", "two channels means nobody chose one");
  assert.match(both.why ?? "", /neither exactly one ledger channel/);

  const neither = verdictFor([{ ...base } as RuleSignature], [obs("coverage-ratchet", "2026-09-01T10:00:00Z")]);
  assert.equal(neither.status, "UNMEASURABLE", "no channel is never PREVENTING");
  assert.deepEqual(neither.recurrences, []);
});

// THE WIRE, NOT THE UNIT. Every test above grades a FIXTURE, which proves the channel works and
// says nothing about whether the shipped table uses it — standing rule 14's defect, and itself the
// third row of this very table. These two assert the production `RULE_SIGNATURES`.

test("W1-T2958 the SHIPPED diff-coverage row declares the CI channel, not a ledger one", () => {
  const row = RULE_SIGNATURES.find((r) => r.ruleId === "CLAUDE.md#before-you-push:diff-coverage-gate");
  assert.ok(row, "the diff-coverage row is still in the table");
  assert.equal(row.measurable, true, "it is no longer listed UNMEASURABLE");
  const m = row as MeasurableRuleSignature;
  assert.equal(declaredChannel(m), "ci", "and it declares the CI channel, exactly one");
  // The REQUIRED aggregator's own name, from ci.yml's `coverage-ratchet-required` job. If that job
  // is renamed this assertion fails, which is the point: a pattern matching a check nobody reports
  // grades PREVENTING forever — a zero over nothing observed.
  assert.ok(
    (m.ciGatePatterns ?? []).some((re) => re.test("coverage-ratchet")),
    "and its patterns match the required check's real name",
  );
});

test("W1-T2958 the SHIPPED table grades that row from a CI corpus instead of refusing it", () => {
  const graded = ruleEfficacyReport(NO_LEDGER, RULE_SIGNATURES, undefined, [
    obs("coverage-ratchet", "2026-09-01T10:00:00Z"),
  ]).rules.find((r) => r.ruleId === "CLAUDE.md#before-you-push:diff-coverage-gate");
  assert.ok(graded);
  assert.equal(graded.status, "REPEATING", "a post-citation red on the required check recurs it");
  assert.equal(graded.recurrences.length, 1);
  // And the boundary is the SHIPPED effectiveDate, not the fixture's: all three citing PRs
  // (#768, #773, #777) merged 2026-07-25.
  assert.equal(graded.effectiveDate, "2026-07-25");
});
