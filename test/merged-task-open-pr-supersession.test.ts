// W1-T2794 — #3874 merged W1-T2786 and the credit rung wrote a durable `verdict.merged`, yet #3877
// stayed open, was reviewed PASS, and escalated `blocked-ambiguous` every sweep until the operator
// closed it by hand. The information was never missing: `supersededBy` is computed from the OPEN-PR
// array, so the peer relation vanished the moment the winner left it, while the stronger merged
// evidence was built AFTER disposition had already run.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_SWEEP_POLICY,
  deriveDisposition,
  projectMergedTaskCandidates,
  type CreditCandidate,
  type OpenPrView,
} from "../src/lib/sweep.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function openPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 3877,
    prUrl: "https://github.com/craigoley/remudero/pull/3877",
    taskId: "W1-T2786",
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    strikeHistory: [],
    lastActivityAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    headSha: "deadbeef",
    autoMergeArmed: false,
    isDependabot: false,
    ...over,
  } as OpenPrView;
}

/** The winner: W1-T2786, merged by #3874, as the credit rung's projection reports it. */
const MERGED: CreditCandidate[] = [
  {
    taskId: "W1-T2786",
    prNumber: 3874,
    prUrl: "https://github.com/craigoley/remudero/pull/3874",
    merged: true,
    // W1-T3063: #3874's real subject is `feat(sweep): ...` — an IMPLEMENTATION. This flag is now
    // required for a close, because a credit earned by a `chore(plan)` filing closed the validated
    // build in #4461. Without it these rows would (correctly) decline.
    creditIsImplementation: true,
  },
];

/** END TO END, projection THEN disposition — the composition the sweep now performs. This is what
 *  makes the control below load-bearing: neutering the projection reddens this and nothing else. */
function dispose(pr: OpenPrView, candidates?: CreditCandidate[]) {
  const [projected] = projectMergedTaskCandidates([pr], candidates);
  return deriveDisposition(projected, DEFAULT_SWEEP_POLICY);
}

test("W1-T2794 criterion 1: THE #3877 INCIDENT — a merged task closes its leftover open PR, naming the merged PR", () => {
  const d = dispose(openPr(), MERGED);
  assert.equal(d.disposition, "stale");
  assert.match(d.reason, /already merged by #3874/);
  assert.match(d.reason, /W1-T2786/, "the reason must name the task, not only the PR");
});

test("W1-T2794 criterion 1: the projection stamps taskMergedBy and leaves everything else alone", () => {
  const pr = openPr();
  const [out] = projectMergedTaskCandidates([pr], MERGED);
  assert.equal(out.taskMergedBy, 3874);
  assert.deepEqual({ ...out, taskMergedBy: undefined }, { ...pr, taskMergedBy: undefined });
});

test("W1-T2794 criterion 4 (falsifier): EVERY DARKNESS PRESERVES THE PRIOR DISPOSITION", () => {
  // Closing is destructive queue hygiene, so it requires POSITIVE evidence. A failed projection is
  // indistinguishable from "nothing merged", and both must be inert.
  const cases: Array<[string, CreditCandidate[] | undefined, OpenPrView]> = [
    ["no candidate set at all", undefined, openPr()],
    ["an empty candidate set", [], openPr()],
    ["a candidate that is not merged", [{ ...MERGED[0], merged: false }], openPr()],
    ["a candidate for an unrelated task", [{ ...MERGED[0], taskId: "W1-T9999" }], openPr()],
    ["a PR carrying no task id", MERGED, openPr({ taskId: undefined })],
  ];
  for (const [label, candidates, pr] of cases) {
    const [projected] = projectMergedTaskCandidates([pr], candidates);
    assert.equal(projected.taskMergedBy, undefined, `${label}: must not stamp`);
    // Assert the PROPERTY directly. An earlier draft compared against `dispose(pr, MERGED)`,
    // which for the no-task-id row is the same un-stamped result — so the two sides matched and
    // the assertion proved nothing about reaching the row.
    assert.doesNotMatch(
      deriveDisposition(projected, DEFAULT_SWEEP_POLICY).reason,
      /already merged by/,
      `${label}: must not reach the merged-task row`,
    );
  }
});

test("W1-T2794 (falsifier): the WINNER itself is never closed by its own merge", () => {
  // The merged PR is not normally in the open array, but a stale listing must not be able to close
  // the PR that did the work.
  const [out] = projectMergedTaskCandidates([openPr({ prNumber: 3874 })], MERGED);
  assert.equal(out.taskMergedBy, undefined);
});

test("W1-T2794 (falsifier): W1-T2779's complement rule is not weakened", () => {
  // A plan filing is not an ownership-asserted merged implementation candidate, so it can never
  // populate the field and can never be closed by the new row. Asserted with the complement verdict
  // present AND no merged candidate for it.
  const complement = openPr({ taskId: "W1-T2786", supersededBy: 3999, supersessionVerdict: { status: "complementary" } as never });
  const d = dispose(complement, [{ ...MERGED[0], taskId: "W1-T-OTHER" }]);
  assert.doesNotMatch(d.reason, /already merged/);
  assert.notEqual(d.disposition, "stale", "the complement must still yield, exactly as W1-T2779 requires");
});

test("W1-T2794 (falsifier): ordinary open-peer supersession is untouched", () => {
  // THE CONTROL THAT MUST STAY GREEN when the projection is neutered — it proves the new row did
  // not simply absorb the old one.
  const d = dispose(openPr({ supersededBy: 3999 }), undefined);
  assert.equal(d.disposition, "stale");
  assert.equal(d.reason, "superseded-by #3999");
});

test("W1-T2794 criterion 1: merged evidence OUTRANKS the open-peer row when both are present", () => {
  const d = dispose(openPr({ supersededBy: 3999 }), MERGED);
  assert.match(d.reason, /already merged by #3874/, "the stronger evidence must win the first match");
});

// ═════════ criteria 2 and 3: the composition ═══════════════════════════════════════════════════
// @source-text-subject — W1-T2905's declared carve-out, and this is the case it exists for: the
// SUBJECT of these assertions IS the source text. What they claim is a property of the composition
// itself — that each body builds the candidates exactly once, and does it before dispatch — which
// no behavioural test can express without a live GitHub gateway, a plan and a ledger. Asserting on
// behaviour is the census's FIRST remedy and the better one wherever it fits; it does not fit here,
// so the choice is declared rather than left as an unexplained read.
//
// ⚠ STRUCTURAL, NOT EXECUTIONAL, AND SAID SO PLAINLY. Driving `sweepCommand`/`buildSweepHook` end
// to end needs a live GitHub gateway, a plan and a ledger; these assertions instead read the two
// composition bodies out of run-task.ts and check ORDER and COUNT. That catches the regressions the
// falsifier names — a second `buildCreditCandidates` call, or the hoist being reverted — but it does
// NOT prove the runtime call count, and no claim here should be read as if it did.
function functionBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `composition not found: ${declaration}`);
  const next = source.indexOf("\nexport ", start + declaration.length);
  return source.slice(start, next === -1 ? source.length : next);
}

test("W1-T2794 criteria 2+3: both compositions build the candidates ONCE, before disposition", () => {
  const source = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  for (const decl of ["export async function sweepCommand(", "export function buildSweepHook("]) {
    const body = functionBody(source, decl);
    const builds = [...body.matchAll(/buildCreditCandidates\(owner/g)];
    assert.equal(builds.length, 1, `${decl} must build the credit candidates exactly once`);
    const buildAt = body.indexOf("buildCreditCandidates(owner");
    const sweepAt = body.indexOf("runSweep(");
    const backfillAt = body.indexOf("runCreditBackfill(creditCandidates");
    assert.ok(buildAt < sweepAt, `${decl}: the build must precede disposition`);
    assert.ok(backfillAt > buildAt, `${decl}: the backfill must reuse the same array`);
    assert.match(body, /projectMergedTaskCandidates\(prsForFixRung, creditCandidates\)/, `${decl}: projection not wired`);
  }
});
