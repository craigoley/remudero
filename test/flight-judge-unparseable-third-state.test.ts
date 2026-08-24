import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INITIAL_FLIGHT_JUDGE_STATE,
  parseJudgeResponse,
  parseJudgeVerdict,
  planJudgeAction,
  planJudgeActionForOutcome,
  type FlightJudgeConfig,
  type JudgeParseOutcome,
  type JudgeState,
} from "../src/lib/flight-judge.js";
import type { RiskTaskMetadata } from "../src/lib/risk-score.js";

// W1-T2225 — flight-judge.ts carries W1-T2212's collapse: an unreadable judge
// output must not be storable as a classification. See design (i)-(iii) in
// plan/tasks.d/W1-T2225-flight-judge-unparseable-collapse-is-latent.yaml.

const DEFAULT_CONFIG: FlightJudgeConfig = { maxInvocationsPerRun: 3 };

const UNPARSEABLE_TEXT = "the worker seems to be doing... something? not sure.";
const OFF_TRACK_TEXT = [
  "JUDGE_STATE: off_track",
  "JUDGE_RECOMMENDATION: escalate",
  "JUDGE_CONFIDENCE: 0.8",
  "JUDGE_EVIDENCE: the diff never touches the files the goal names",
].join("\n");

const FIVE_CLASSIFICATIONS: JudgeState[] = ["productive", "converging", "spiraling", "blocked", "off_track"];

// ── acceptance 1: an unparseable output yields a value that is not one of the
// five classifications ──────────────────────────────────────────────────────

test("acceptance 1: parseJudgeResponse returns a DISTINCT `unreadable` outcome — not a fabricated verdict", () => {
  const outcome = parseJudgeResponse(UNPARSEABLE_TEXT);
  assert.equal(outcome.kind, "unreadable");
  assert.ok(!("verdict" in outcome), "the unreadable arm carries no verdict field at all");
  assert.ok(!("state" in outcome), "the unreadable arm carries no state field at all");
  // "unreadable" (the discriminant itself) is not a member of the five-way JudgeState union.
  assert.ok(!(FIVE_CLASSIFICATIONS as string[]).includes(outcome.kind));
});

test("acceptance 1: parseJudgeResponse also fails closed on a recognized-but-invalid state/recommendation", () => {
  const outcome = parseJudgeResponse("JUDGE_STATE: confused\nJUDGE_RECOMMENDATION: continue\nJUDGE_CONFIDENCE: 0.5");
  assert.equal(outcome.kind, "unreadable");
});

// ── acceptance 2: an unreadable verdict still halts and still escalates ────

test("acceptance 2: planJudgeActionForOutcome on an unreadable outcome HALTS and ESCALATES", () => {
  const outcome = parseJudgeResponse(UNPARSEABLE_TEXT);
  const action = planJudgeActionForOutcome(INITIAL_FLIGHT_JUDGE_STATE, outcome, DEFAULT_CONFIG);
  assert.equal(action.kind, "halt_and_escalate");
  assert.notEqual(action.kind, "continue");
  assert.notEqual(action.kind, "raise_threshold_and_continue");
});

test("acceptance 2: the unreadable arm halts and escalates on the FIRST invocation, well under the K-cap", () => {
  const config: FlightJudgeConfig = { maxInvocationsPerRun: 10 };
  const outcome = parseJudgeResponse(UNPARSEABLE_TEXT);
  const action = planJudgeActionForOutcome(INITIAL_FLIGHT_JUDGE_STATE, outcome, config);
  assert.equal(action.kind, "halt_and_escalate", "an unreadable response is already terminal, K-cap or not");
  assert.equal(action.state.invocations, 1);
});

// ── acceptance 3: a genuine off_track classification is still distinguishable
// from an unreadable one ────────────────────────────────────────────────────

test("acceptance 3: a genuine off_track parse and an unreadable parse have different `kind`s", () => {
  const genuine = parseJudgeResponse(OFF_TRACK_TEXT);
  const unreadable = parseJudgeResponse(UNPARSEABLE_TEXT);
  assert.equal(genuine.kind, "parsed");
  assert.equal(unreadable.kind, "unreadable");
  assert.notEqual(genuine.kind, unreadable.kind);
  assert.ok(genuine.kind === "parsed" && genuine.verdict.state === "off_track");
});

test("acceptance 3: the two outcomes' resulting ControllerAction both halt_and_escalate, but the REASON distinguishes them", () => {
  const genuine = parseJudgeResponse(OFF_TRACK_TEXT);
  const unreadable = parseJudgeResponse(UNPARSEABLE_TEXT);
  const genuineAction = planJudgeActionForOutcome(INITIAL_FLIGHT_JUDGE_STATE, genuine, DEFAULT_CONFIG);
  const unreadableAction = planJudgeActionForOutcome(INITIAL_FLIGHT_JUDGE_STATE, unreadable, DEFAULT_CONFIG);
  assert.equal(genuineAction.kind, "halt_and_escalate");
  assert.equal(unreadableAction.kind, "halt_and_escalate");
  assert.match(genuineAction.reason, /off_track/);
  assert.doesNotMatch(unreadableAction.reason, /off_track/);
  assert.match(unreadableAction.reason, /no parseable verdict/);
  assert.notEqual(genuineAction.reason, unreadableAction.reason);
});

// ── acceptance 4: the risk-score metadata type cannot accept an unreadable
// verdict as a classification ───────────────────────────────────────────────

test("acceptance 4: a genuine JudgeState value DOES compile as RiskTaskMetadata.flightJudgeState (positive control)", () => {
  const outcome = parseJudgeResponse(OFF_TRACK_TEXT);
  assert.equal(outcome.kind, "parsed");
  const metadata: RiskTaskMetadata =
    outcome.kind === "parsed" ? { flightJudgeState: outcome.verdict.state } : { flightJudgeState: undefined };
  assert.equal(metadata.flightJudgeState, "off_track");
});

test("acceptance 4: JudgeParseOutcome's `unreadable` discriminant is not a JudgeState and cannot fill flightJudgeState", () => {
  // @ts-expect-error design (ii): "unreadable" is JudgeParseOutcome's discriminant, never a
  // member of JudgeState — RiskTaskMetadata.flightJudgeState (typed JudgeState) refuses it, so a
  // real caller cannot smuggle the unreadable arm in as though it were a genuine classification.
  // `npm run typecheck` is what actually exercises this directive; a widened JudgeState that ever
  // grew an `"unreadable"` member would make this line stop erroring and fail the build instead
  // (an unused @ts-expect-error), which is the falsifier for this claim.
  const metadata: RiskTaskMetadata = { flightJudgeState: "unreadable" };
  assert.ok(metadata, "compile-time-only assertion — see the @ts-expect-error comment above");
});

test("acceptance 4: the unreadable outcome OBJECT itself (not just its discriminant string) cannot fill flightJudgeState", () => {
  const outcome: JudgeParseOutcome = parseJudgeResponse(UNPARSEABLE_TEXT);
  assert.equal(outcome.kind, "unreadable");
  // @ts-expect-error design (ii): a JudgeParseOutcome (object) is never assignable to
  // JudgeState (a five-member string union) at all — a real caller has to explicitly extract
  // (and narrow) a `.verdict.state` from the `parsed` arm; there is no shortcut that reaches
  // flightJudgeState from the unreadable arm.
  const metadata: RiskTaskMetadata = { flightJudgeState: outcome };
  assert.ok(metadata, "compile-time-only assertion — see the @ts-expect-error comment above");
});

// ── acceptance 5: a parsed adverse verdict is unchanged in state,
// recommendation and confidence ─────────────────────────────────────────────

test("acceptance 5: parseJudgeResponse's `parsed` arm matches parseJudgeVerdict's state/recommendation/confidence exactly, for the same well-formed input", () => {
  const outcome = parseJudgeResponse(OFF_TRACK_TEXT);
  const legacy = parseJudgeVerdict(OFF_TRACK_TEXT);
  assert.equal(outcome.kind, "parsed");
  assert.ok(outcome.kind === "parsed");
  if (outcome.kind === "parsed") {
    assert.equal(outcome.verdict.state, legacy.state);
    assert.equal(outcome.verdict.recommendation, legacy.recommendation);
    assert.equal(outcome.verdict.confidence, legacy.confidence);
    assert.deepEqual(outcome.verdict.evidence, legacy.evidence);
  }
});

test("acceptance 5: a parsed adverse verdict's confidence is NEVER forced to 1 — it carries the judge's own stated value", () => {
  const outcome = parseJudgeResponse(OFF_TRACK_TEXT);
  assert.ok(outcome.kind === "parsed");
  if (outcome.kind === "parsed") {
    assert.equal(outcome.verdict.confidence, 0.8, "the judge stated 0.8 — the parse must not overwrite it");
  }
});

test("acceptance 5: planJudgeAction on a genuinely parsed off_track verdict is unaffected by this task — still halt_and_escalate", () => {
  const outcome = parseJudgeResponse(OFF_TRACK_TEXT);
  assert.ok(outcome.kind === "parsed");
  if (outcome.kind === "parsed") {
    const action = planJudgeAction(INITIAL_FLIGHT_JUDGE_STATE, outcome.verdict, DEFAULT_CONFIG);
    assert.equal(action.kind, "halt_and_escalate");
    assert.equal(action.reason, "judge classified the run off_track");
  }
});

test("acceptance 5: parseJudgeVerdict (the pre-existing back-compat parser) is untouched — still fails closed to off_track/escalate/confidence 1", () => {
  // Regression guard: this task must not change parseJudgeVerdict's existing contract, which
  // test/flight-judge.test.ts (out of this task's declared scope) already exercises directly.
  const v = parseJudgeVerdict(UNPARSEABLE_TEXT);
  assert.equal(v.state, "off_track");
  assert.equal(v.recommendation, "escalate");
  assert.equal(v.confidence, 1);
});
