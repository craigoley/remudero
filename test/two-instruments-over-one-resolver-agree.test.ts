/**
 * test/two-instruments-over-one-resolver-agree.test.ts — W1-T3513.
 *
 * TWO READERS OF ONE RESOLVER REACHED OPPOSITE VERDICTS ON THE SAME INPUT. `proofQueueAudit`
 * (lib/proof-queue-audit.ts) and `proofNameResolutionViolations` (lib/task-linter.ts) both call
 * `resolveNameFilteredCandidates` — the reviewer's own — precisely so they can never disagree with
 * what executes. Over the live open+unmerged population on 2026-09-13 (146 tasks, 580 criteria)
 * the audit reported 96 `name-filtered-zero-match` offenders and the linter reported ZERO.
 *
 * The linter was right and says why in its own source: zero-match is the ordinary state of a task
 * authored test-first, so reporting it unconditionally reports CORRECT AUTHORING at scale. It
 * narrows to the diagnostic case — a title carrying a regex metacharacter, which this dialect
 * escapes into a literal and so can only ever match itself. The audit carried no such narrowing,
 * and the audit is what MINTS proof-debt proposals into the operator's inbox.
 *
 * This proves the single shared predicate three ways:
 *   (i)   the ordinary forward reference is no longer reported for an UNCREDITED task;
 *   (ii)  the diagnostic metacharacter case still IS — the narrowing keeps the real signal;
 *   (iii) a CREDITED task is still reported unnarrowed, because W1-T2280's whole point is that a
 *         credited task has no forward left to reference. Silencing that would be the regression.
 *
 * FALSIFIER for the agreement claim itself: (iv) drives both instruments over one shared corpus
 * and asserts they return the same verdict per task — the assertion that would have caught 96-to-0.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Task } from "../src/lib/plan.js";
import type { NameFilterResolution } from "../src/lib/review.js";
import { proofQueueAudit, type ProofQueueAuditOpts } from "../src/lib/proof-queue-audit.js";
import { proofNameResolutionViolations, zeroMatchTitleIsReportable } from "../src/lib/task-linter.js";

function fixtureTask(id: string, proof: string): Task {
  return {
    id,
    title: id,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    principles: {},
    budget_usd: 10,
    risk: "low",
    origin: "architect",
    status: "queued",
    attempts: 0,
    acceptance: [{ claim: "a claim", proof }],
  } as Task;
}

/** Every title resolves to ZERO — the state both instruments are being asked to judge. */
const allAbsent: ProofQueueAuditOpts["resolveNameFilteredCandidates"] = (): NameFilterResolution => ({
  status: "absent",
});

/** An ordinary test title: prose, no metacharacter, short enough not to read as a narrative. */
const PLAIN_TITLE = "the reaper releases a lease whose holder is gone";
/** The diagnostic shape: the author wrote a regex, but this dialect escapes it into a literal. */
const METACHAR_TITLE = "the reaper releases lease.*whose holder is gone";

test("W1-T3513: an UNCREDITED task's zero-match title is a forward reference, not proof debt", () => {
  const report = proofQueueAudit([fixtureTask("W9-FR1", `unit test: ${PLAIN_TITLE}`)], {
    resolveNameFilteredCandidates: allAbsent,
  });
  assert.deepEqual(
    report.offenders,
    [],
    "an open task's not-yet-written test is the normal state of test-first authoring, never debt",
  );
  assert.deepEqual(report.byCause["name-filtered-zero-match"], []);
});

test("W1-T3513: the DIAGNOSTIC metacharacter title is still reported — the narrowing keeps the real signal", () => {
  const report = proofQueueAudit([fixtureTask("W9-FR2", `unit test: ${METACHAR_TITLE}`)], {
    resolveNameFilteredCandidates: allAbsent,
  });
  assert.equal(report.offenders.length, 1, "a title that can only ever match itself is real debt");
  assert.equal(report.offenders[0]!.cause, "name-filtered-zero-match");
  assert.deepEqual(report.byCause["name-filtered-zero-match"], ["W9-FR2"]);
});

test("W1-T3513: a CREDITED task's zero-match title is STILL reported unnarrowed (W1-T2280 keeps its teeth)", () => {
  const credited = fixtureTask("W9-FR3", `unit test: ${PLAIN_TITLE}`);
  const report = proofQueueAudit([credited], {
    resolveNameFilteredCandidates: allAbsent,
    creditedIds: new Set(["W9-FR3"]),
  });
  assert.equal(
    report.offenders.length,
    1,
    "a credited task has no forward left to reference — narrowing this one would be the regression",
  );
  assert.equal(report.offenders[0]!.cause, "name-filtered-zero-match");
});

test("W1-T3513: over one corpus the audit and the linter return the SAME verdict per task", () => {
  const corpus = [
    fixtureTask("W9-AG1", `unit test: ${PLAIN_TITLE}`),
    fixtureTask("W9-AG2", `unit test: ${METACHAR_TITLE}`),
    fixtureTask("W9-AG3", "unit test: another plain title with no metacharacters at all"),
    fixtureTask("W9-AG4", "unit test: a second (parenthesised) title the dialect makes literal"),
  ];
  const auditFlagged = new Set(
    proofQueueAudit(corpus, { resolveNameFilteredCandidates: allAbsent }).offenders.map((o) => o.taskId),
  );
  const lintFlagged = new Set(
    corpus
      .filter((t) => proofNameResolutionViolations(t, { resolveNameFilteredCandidates: allAbsent }).length > 0)
      .map((t) => t.id),
  );
  assert.deepEqual(
    [...auditFlagged].sort(),
    [...lintFlagged].sort(),
    "the two readers of one resolver must not carry separate opinions — this is the 96-to-0 assertion",
  );
  assert.ok(auditFlagged.size > 0, "the corpus must exercise the positive case, or agreement is vacuous");
  assert.ok(auditFlagged.size < corpus.length, "and the negative case, or agreement is vacuous the other way");
});

test("W1-T3513: the shared predicate names the metacharacter case and excludes the narrative shape", () => {
  assert.equal(zeroMatchTitleIsReportable(PLAIN_TITLE), false);
  assert.equal(zeroMatchTitleIsReportable(METACHAR_TITLE), true);
  assert.equal(
    zeroMatchTitleIsReportable("a title, with, several, commas, that reads as a scenario.*narrative"),
    false,
    "proofResolvabilityViolations already warns on the narrative shape — reporting it here double-counts",
  );
});
