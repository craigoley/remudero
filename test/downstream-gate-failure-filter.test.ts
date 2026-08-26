import assert from "node:assert/strict";
import { test } from "node:test";

import { CI_GATE_CHECK_NAME, withoutDownstreamGateFailure, type CiFailure } from "../src/lib/sweep.js";

// ── `ci-gate` IS A DOWNSTREAM AGGREGATOR, AND WAS COUNTED AS A PEER ─────────────────────────────
//
// Its failing step is "Aggregate sibling check results"; its own annotations read `required
// check(s) failing — entering a 600s grace window` then `required check(s) FAILED — holding
// merge`. It is red BECAUSE a sibling is red. A failure list naming both therefore reports two
// failures where there is one, and the extra one cannot be fixed in isolation.
//
// THE ARM THAT MUST NOT REGRESS is `ci-gate` alone. That is the stale-aggregate signal — the
// gate concluded against siblings that are not failing — and erasing it would leave a red PR
// with an EMPTY failure list, which reads as "nothing is wrong" to every consumer downstream.
// Both arms are pinned here, and each one falsifies independently.

const gate = (): CiFailure => ({ name: CI_GATE_CHECK_NAME, logTail: "required check(s) FAILED — holding merge" });
const cov = (): CiFailure => ({ name: "coverage-ratchet", logTail: "Diff coverage" });
const ci = (): CiFailure => ({ name: "ci", logTail: "Test" });

test("ci-gate is dropped when a sibling is also failing — one cause, one reported failure", () => {
  const out = withoutDownstreamGateFailure([gate(), cov()]);
  assert.deepEqual(
    out.map((f) => f.name),
    ["coverage-ratchet"],
  );
});

test("the surviving sibling keeps its own evidence intact, never a rewritten one", () => {
  const out = withoutDownstreamGateFailure([gate(), cov()]);
  assert.equal(out[0].logTail, "Diff coverage", "the cause's own log tail is what a fix worker reads");
});

test("several siblings all survive — the filter removes the aggregate, never a peer", () => {
  const out = withoutDownstreamGateFailure([ci(), gate(), cov()]);
  assert.deepEqual(
    out.map((f) => f.name),
    ["ci", "coverage-ratchet"],
  );
});

test("ci-gate ALONE is KEPT — it is the stale-aggregate signal, and dropping it would erase the only evidence", () => {
  const out = withoutDownstreamGateFailure([gate()]);
  assert.deepEqual(
    out.map((f) => f.name),
    [CI_GATE_CHECK_NAME],
  );
});

test("the filter never turns a non-empty list into an empty one", () => {
  for (const input of [[gate()], [gate(), cov()], [ci()], [ci(), gate(), cov()]]) {
    assert.ok(withoutDownstreamGateFailure(input).length > 0, `emptied ${JSON.stringify(input.map((f) => f.name))}`);
  }
});

test("a list with no ci-gate at all is returned unchanged", () => {
  const input = [ci(), cov()];
  assert.deepEqual(
    withoutDownstreamGateFailure(input).map((f) => f.name),
    ["ci", "coverage-ratchet"],
  );
});

test("an empty list stays empty rather than throwing", () => {
  assert.deepEqual(withoutDownstreamGateFailure([]), []);
});

test("the input array is not mutated — callers may still read their own list", () => {
  const input = [gate(), cov()];
  const before = input.map((f) => f.name);
  withoutDownstreamGateFailure(input);
  assert.deepEqual(
    input.map((f) => f.name),
    before,
  );
});

test("REAL BOARD SHAPES, 2026-08-26: five reds narrow to their actual causes, #2900 keeps its gate", () => {
  // Measured failure sets from the open board on the day this filter was written.
  const board: Array<{ pr: number; failing: string[]; expect: string[] }> = [
    { pr: 2828, failing: ["ci-gate", "coverage-ratchet"], expect: ["coverage-ratchet"] },
    { pr: 2895, failing: ["ci", "ci-gate", "coverage-ratchet"], expect: ["ci", "coverage-ratchet"] },
    { pr: 2909, failing: ["ci-gate", "coverage-ratchet"], expect: ["coverage-ratchet"] },
    { pr: 2911, failing: ["ci", "ci-gate", "coverage-ratchet"], expect: ["ci", "coverage-ratchet"] },
    // #2900: every sibling green, ci-gate alone red — the grace window expired before a sibling
    // flipped. One re-run merged it. The gate MUST survive here or the PR reads as failure-free.
    { pr: 2900, failing: ["ci-gate"], expect: ["ci-gate"] },
  ];
  for (const row of board) {
    const out = withoutDownstreamGateFailure(row.failing.map((n) => ({ name: n, logTail: "" })));
    assert.deepEqual(
      out.map((f) => f.name),
      row.expect,
      `#${row.pr}`,
    );
  }
});

test("W1-T2296 x W1-T2287: the surviving failure keeps its NAMED unavailability cause through the filter", () => {
  // The interaction the merge with `origin/main` created: `fetchCiFailures` now attaches a
  // `logUnavailable` cause (a failed read vs a genuinely quiet job) and this filter runs over its
  // result. Dropping the aggregate must not strip the cause off the entry that survives — that
  // cause is the whole reason an empty tail is legible rather than silent.
  const withCause: CiFailure[] = [
    { name: CI_GATE_CHECK_NAME, logTail: "" },
    { name: "coverage-ratchet", logTail: "", logUnavailable: { kind: "fetch-failed", detail: "403" } } as CiFailure,
  ];
  const out = withoutDownstreamGateFailure(withCause);
  assert.deepEqual(
    out.map((f) => f.name),
    ["coverage-ratchet"],
  );
  assert.deepEqual(
    (out[0] as CiFailure & { logUnavailable?: unknown }).logUnavailable,
    { kind: "fetch-failed", detail: "403" },
    "the named cause rides through untouched",
  );
});

