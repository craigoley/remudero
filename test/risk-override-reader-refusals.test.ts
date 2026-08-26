import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RISK_OVERRIDE_DISPOSITIONS,
  RISK_OVERRIDE_REASON_CLASSES,
  RISK_OVERRIDE_RECORDED_STEP,
  riskOverrideFromLedger,
} from "../src/lib/ledger.js";

// ── W1-T2244 — THE READER'S REFUSAL ARMS, IN THEIR OWN FILE ─────────────────────────────────
//
// `riskOverrideFromLedger` (src/lib/ledger.ts) is seven guards and one record construction, and
// the guards are the half that matters: the ledger is append-only and UNAUTHENTICATED, so a
// hand-edited or malformed row must read as ABSENT rather than as a grant. Its sibling
// `test/risk-override-record.test.ts` drives the PRODUCER end to end through a real temp-dir
// ledger; these cases drive the READER directly off literal rows, with no filesystem, no spawn
// and no shared temp state, so each guard is exercised in isolation and by construction.
//
// Deliberately its OWN test file (the #781 discipline): a coverage-load-bearing case appended to
// a large sibling can lose its own coverage record for reasons unrelated to the assertion, and
// this function's every line is exactly such a case.
//
// EVERY REFUSAL BELOW CARRIES A DISCRIMINATING FALSIFIER — the same row, repaired in the single
// field under test, must resolve. A refusal test with no falsifier cannot tell a working guard
// from a reader that returns undefined for everything.

const HEAD = "a".repeat(40);
const TASK = "W1-T9101";

function validRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    step: RISK_OVERRIDE_RECORDED_STEP,
    task_id: TASK,
    head_sha: HEAD,
    issue_url: "https://github.com/craigoley/remudero/issues/9101",
    verdict: "high",
    confidence: 0.82,
    disposition: "merged_by_hand",
    reason_class: "risk_accepted",
    ...overrides,
  };
}

/** The baseline every refusal below is measured against — if this ever stops resolving, every
 *  `undefined` in this file becomes vacuous rather than evidence. */
test("the falsifier baseline: a well-formed row resolves, so every refusal below is the guard and not a dead reader", () => {
  const found = riskOverrideFromLedger([validRow()], TASK, HEAD);
  assert.ok(found, "a well-formed row must resolve");
  assert.equal(found?.taskId, TASK);
  assert.equal(found?.headSha, HEAD);
  assert.equal(found?.issueUrl, "https://github.com/craigoley/remudero/issues/9101");
  assert.equal(found?.verdict, "high");
  assert.equal(found?.confidence, 0.82);
  assert.equal(found?.disposition, "merged_by_hand");
  assert.equal(found?.reasonClass, "risk_accepted");
});

test("a row written under a DIFFERENT step is not an override, however well-formed the rest of it is", () => {
  const wrongStep = validRow({ step: "panel.escalation_marked_handled" });
  assert.equal(riskOverrideFromLedger([wrongStep], TASK, HEAD), undefined);
  assert.ok(
    riskOverrideFromLedger([validRow()], TASK, HEAD),
    "the same fields under the right step resolve — the miss above is the step guard",
  );
});

test("a row belonging to a DIFFERENT task never answers for this one", () => {
  const otherTask = validRow({ task_id: "W1-T9102" });
  assert.equal(riskOverrideFromLedger([otherTask], TASK, HEAD), undefined);
  assert.ok(riskOverrideFromLedger([otherTask], "W1-T9102", HEAD), "queried under its own id it resolves");
});

test("a row whose head_sha is missing or not a string is refused, not coerced", () => {
  assert.equal(riskOverrideFromLedger([validRow({ head_sha: undefined })], TASK, HEAD), undefined);
  assert.equal(riskOverrideFromLedger([validRow({ head_sha: 40 })], TASK, HEAD), undefined);
  assert.ok(riskOverrideFromLedger([validRow()], TASK, HEAD), "a string head_sha that matches resolves");
});

test("a row recorded against a different head is skipped as if it were never written", () => {
  const stale = validRow({ head_sha: "b".repeat(40) });
  assert.equal(
    riskOverrideFromLedger([stale], TASK, HEAD),
    undefined,
    "an override must never outlive the diff it judged",
  );
  assert.ok(riskOverrideFromLedger([stale], TASK, "b".repeat(40)), "against its own head it still resolves");
});

test("verdict is closed to low and high — anything else is refused, and BOTH members are accepted", () => {
  assert.equal(riskOverrideFromLedger([validRow({ verdict: "medium" })], TASK, HEAD), undefined);
  assert.equal(riskOverrideFromLedger([validRow({ verdict: undefined })], TASK, HEAD), undefined);
  assert.equal(riskOverrideFromLedger([validRow({ verdict: 1 })], TASK, HEAD), undefined);
  assert.equal(riskOverrideFromLedger([validRow({ verdict: "low" })], TASK, HEAD)?.verdict, "low");
  assert.equal(riskOverrideFromLedger([validRow({ verdict: "high" })], TASK, HEAD)?.verdict, "high");
});

test("confidence must be a number — a numeric STRING is refused rather than parsed", () => {
  assert.equal(riskOverrideFromLedger([validRow({ confidence: "0.82" })], TASK, HEAD), undefined);
  assert.equal(riskOverrideFromLedger([validRow({ confidence: undefined })], TASK, HEAD), undefined);
  assert.equal(riskOverrideFromLedger([validRow({ confidence: 0 })], TASK, HEAD)?.confidence, 0, "zero is a number");
});

test("issue_url must be a string — the row names the escalation it overrode or it is not a record", () => {
  assert.equal(riskOverrideFromLedger([validRow({ issue_url: undefined })], TASK, HEAD), undefined);
  assert.equal(riskOverrideFromLedger([validRow({ issue_url: 9101 })], TASK, HEAD), undefined);
  assert.ok(riskOverrideFromLedger([validRow()], TASK, HEAD));
});

test("disposition is validated against the CLOSED set, and every declared member is accepted", () => {
  assert.equal(riskOverrideFromLedger([validRow({ disposition: "merged_by_robot" })], TASK, HEAD), undefined);
  assert.equal(riskOverrideFromLedger([validRow({ disposition: undefined })], TASK, HEAD), undefined);
  assert.equal(riskOverrideFromLedger([validRow({ disposition: 0 })], TASK, HEAD), undefined);
  for (const d of RISK_OVERRIDE_DISPOSITIONS) {
    assert.equal(
      riskOverrideFromLedger([validRow({ disposition: d })], TASK, HEAD)?.disposition,
      d,
      `${d} is a declared disposition and must resolve`,
    );
  }
});

test("reason_class is validated against the CLOSED set, and judge_wrong and risk_accepted stay DISTINCT", () => {
  assert.equal(riskOverrideFromLedger([validRow({ reason_class: "overridden" })], TASK, HEAD), undefined);
  assert.equal(riskOverrideFromLedger([validRow({ reason_class: undefined })], TASK, HEAD), undefined);
  assert.equal(riskOverrideFromLedger([validRow({ reason_class: 2 })], TASK, HEAD), undefined);
  for (const c of RISK_OVERRIDE_REASON_CLASSES) {
    assert.equal(
      riskOverrideFromLedger([validRow({ reason_class: c })], TASK, HEAD)?.reasonClass,
      c,
      `${c} is a declared reason class and must resolve`,
    );
  }
  assert.notEqual(
    riskOverrideFromLedger([validRow({ reason_class: "judge_wrong" })], TASK, HEAD)?.reasonClass,
    riskOverrideFromLedger([validRow({ reason_class: "risk_accepted" })], TASK, HEAD)?.reasonClass,
    "collapsing the two would drive calibration the wrong way — they are opposite signals",
  );
});

test("free-text reason rides alongside the class when present and is OMITTED, never nulled, when it is not a string", () => {
  assert.equal(
    riskOverrideFromLedger([validRow({ reason: "shipping the release, cost accepted" })], TASK, HEAD)?.reason,
    "shipping the release, cost accepted",
  );
  const noReason = riskOverrideFromLedger([validRow()], TASK, HEAD);
  assert.ok(noReason);
  assert.equal("reason" in (noReason as object), false, "an absent reason leaves the key off entirely");
  const numericReason = riskOverrideFromLedger([validRow({ reason: 7 })], TASK, HEAD);
  assert.ok(numericReason, "a non-string reason does not refuse the row — it is simply not carried");
  assert.equal("reason" in (numericReason as object), false);
});

test("an empty corpus and a corpus of only malformed rows both read as absent", () => {
  assert.equal(riskOverrideFromLedger([], TASK, HEAD), undefined);
  assert.equal(
    riskOverrideFromLedger([validRow({ verdict: "medium" }), validRow({ confidence: "0.5" }), { step: "run.start" }], TASK, HEAD),
    undefined,
  );
});

test("last one wins across a mixed corpus — a later VALID row supersedes an earlier one, and a later MALFORMED row does not erase it", () => {
  const first = validRow({ reason_class: "judge_wrong" });
  const second = validRow({ reason_class: "risk_accepted" });
  assert.equal(riskOverrideFromLedger([first, second], TASK, HEAD)?.reasonClass, "risk_accepted");
  assert.equal(
    riskOverrideFromLedger([second, validRow({ disposition: "merged_by_robot" })], TASK, HEAD)?.reasonClass,
    "risk_accepted",
    "a malformed row is skipped, so the last VALID row still stands",
  );
});
