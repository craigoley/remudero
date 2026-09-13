/**
 * test/an-adoption-proposal-retires-when-its-finding-goes.test.ts — W1-T3518.
 *
 * THE PRODUCER IMPROVED AND THE BACKLOG DID NOT MOVE. `mintAdoptionProposals` is idempotent by id,
 * so a finding minted once stays in the registry forever — even after the mechanism gains an
 * adopter, even after the SCANNER ITSELF is corrected and stops reporting it at all.
 *
 * MEASURED 2026-09-13 against the live scan: 15 of 108 open adoption proposals named a finding the
 * current scan no longer reports. Every `scripts/lib/*.mjs` one among them (`git.mjs` with 15 real
 * importers, `repo-root.mjs` with 12, `argv.mjs`, `lcov.mjs`) was minted while `scanUnadoptedScripts`
 * could not see `scripts/` as an invoker surface. W1-T3383 fixed that scan. Nothing told the backlog.
 *
 * THE GUARD IS THE HALF WORTH READING. A scan over a broken or partial checkout reports nothing, and
 * a reader that trusted it would retire the ENTIRE backlog in one pass. `shapesObserved` is the
 * defence, and it is deliberately a MINIMUM RESULT COUNT OF ONE — derived from the scan's own output
 * rather than a configured threshold, so there is no floor to tune, drift, or argue about.
 *
 * And the retirement is DERIVED, never a ledger decline: a finding that comes back un-retires its
 * proposal with no operator action, which is the property a decline could not have.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyProposal, type Proposal, type ReadinessContext } from "../src/lib/inbox.js";
import type { Plan } from "../src/lib/plan.js";
import {
  ADOPTION_SHAPES,
  adoptionFindingGone,
  adoptionLatestRecord,
  adoptionProposalId,
  readAdoptionLatest,
  adoptionShapeOf,
  type AdoptionFinding,
  type AdoptionLatest,
} from "../src/lib/measurement-cadence.js";

function finding(shape: AdoptionFinding["shape"], definedIn: string, mechanism: string): AdoptionFinding {
  return { shape, mechanism, definedIn, shippedAt: "2026-08-01", detail: "fixture" };
}

const GIT_MJS = finding("script-no-invoker", "scripts/lib/git.mjs", "scripts/lib/git.mjs");
const STILL_DEAD = finding("symbol-no-caller", "src/lib/sweep.ts", "mainHealthShouldStandDownDispatch");
const SCAN_RAN = true;

test("W1-T3518: a proposal whose finding the scan no longer reports is GONE", () => {
  // The scan still reports the symbol finding, so it observed that shape and both shapes are live.
  const report = { findings: [STILL_DEAD, finding("script-no-invoker", "scripts/other.mjs", "scripts/other.mjs")], shape4ListSize: 0, shape4ListLastEdited: "", shape4Unmeasurable: [] };
  const latest = adoptionLatestRecord(report, "2026-09-13T00:00:00Z", SCAN_RAN)!;
  assert.equal(adoptionFindingGone(adoptionProposalId(GIT_MJS), latest), true, "no longer reported ⇒ gone");
  assert.equal(adoptionFindingGone(adoptionProposalId(STILL_DEAD), latest), false, "still reported ⇒ not gone");
});

test("W1-T3518: a shape the scan did not observe retires NOTHING — the broken-checkout guard", () => {
  // A scan that found only symbol findings says nothing about scripts. Under a naive "absent means
  // gone" rule every script proposal in the registry would retire at once, on no evidence at all.
  const report = { findings: [STILL_DEAD], shape4ListSize: 0, shape4ListLastEdited: "", shape4Unmeasurable: [] };
  const latest = adoptionLatestRecord(report, "2026-09-13T00:00:00Z", SCAN_RAN)!;
  assert.deepEqual(latest.shapesObserved, ["symbol-no-caller"]);
  assert.equal(
    adoptionFindingGone(adoptionProposalId(GIT_MJS), latest),
    false,
    "script-no-invoker produced zero findings, so this scan cannot be said to have measured that shape",
  );
});

test("W1-T3518: a scan that never ran the static shapes produces NO record at all", () => {
  const report = { findings: [], shape4ListSize: 0, shape4ListLastEdited: "", shape4Unmeasurable: [] };
  assert.equal(
    adoptionLatestRecord(report, "2026-09-13T00:00:00Z", false),
    undefined,
    "runAdoptionReport skips shapes 1-3 without a checkoutDir; a record from that scan would read as 'all adopted'",
  );
});

test("W1-T3518: an absent, unparseable or foreign-shaped record is NO OPINION, never 'gone'", () => {
  assert.equal(adoptionFindingGone(adoptionProposalId(GIT_MJS), undefined), false, "no record ⇒ nothing retires");
  assert.equal(readAdoptionLatest("/nonexistent/adoption-latest.json"), undefined, "absent file never throws");
  const foreign = { generatedAt: "x", proposalIds: [], shapesObserved: ["a-shape-this-build-cannot-read"] } as unknown as AdoptionLatest;
  assert.equal(
    adoptionFindingGone(adoptionProposalId(GIT_MJS), foreign),
    false,
    "an unknown shape is not silently dropped into an empty observed-set that would retire everything",
  );
});

test("W1-T3518: only this module's own ids are retirable — a foreign id is never read as a finding", () => {
  const report = { findings: [STILL_DEAD], shape4ListSize: 0, shape4ListLastEdited: "", shape4Unmeasurable: [] };
  const latest = adoptionLatestRecord(report, "2026-09-13T00:00:00Z", SCAN_RAN)!;
  for (const foreign of ["proof-debt:W1-T965:0", "verify-human:W1-T204", "adoption:not-a-real-shape:x:y"]) {
    assert.equal(adoptionShapeOf(foreign), undefined, `${foreign} has no adoption shape`);
    assert.equal(adoptionFindingGone(foreign, latest), false, `${foreign} must never retire through this rule`);
  }
});

test("W1-T3518: the record names EVERY finding, unfiltered by the mint ceiling", () => {
  // The ceiling is 3 per fire. If the record only carried what was minted, every unminted finding
  // would read as "gone" and retire a proposal whose defect is still live — the inverse defect.
  const many = Array.from({ length: 10 }, (_, i) => finding("symbol-no-caller", `src/lib/m${i}.ts`, `sym${i}`));
  const latest = adoptionLatestRecord(
    { findings: many, shape4ListSize: 0, shape4ListLastEdited: "", shape4Unmeasurable: [] },
    "2026-09-13T00:00:00Z",
    SCAN_RAN,
  )!;
  assert.equal(latest.proposalIds.length, 10, "all ten, not the three a fire would mint");
  for (const f of many) assert.equal(adoptionFindingGone(adoptionProposalId(f), latest), false);
});

test("W1-T3518: every AdoptionShape round-trips through an id, so no shape is silently unretirable", () => {
  for (const shape of ADOPTION_SHAPES) {
    const id = adoptionProposalId({ shape, definedIn: "src/lib/x.ts", mechanism: "y" });
    assert.equal(adoptionShapeOf(id), shape, `${shape} must survive the id round-trip`);
  }
});

// ── the wiring half: the predicate actually reaches classifyProposal ─────────────────────────

/** An empty plan: no task here is a referent of anything below, so the adoption override is the
 *  only rule that can fire. Built directly rather than parsed — the retirement under test reads
 *  neither field, and a YAML fixture would only add a schema to keep in step. */
const EMPTY_PLAN: Plan = { tasks: [], byId: new Map() };

function ctxWith(gone: (id: string) => boolean): ReadinessContext {
  return {
    plan: EMPTY_PLAN,
    isMerged: () => false,
    grepAnchorTrue: () => true,
    openProposalIds: new Set(),
    isRatified: () => false,
    adoptionFindingGone: gone,
  };
}

const ADOPTION_PROPOSAL: Proposal = {
  id: "adoption:script-no-invoker:scripts/lib/git.mjs:scripts/lib/git.mjs",
  summary: "scripts/lib/git.mjs has no invoker",
  evidenceAnchors: [],
};

test("W1-T3518: classifyProposal RETIRES an adoption proposal whose finding is gone, with a reason", () => {
  const result = classifyProposal(ADOPTION_PROPOSAL, undefined, ctxWith(() => true));
  assert.equal(result.state, "retired");
  assert.match(String(result.retiredReason), /no longer reported by the adoption scan/);
  assert.match(String(result.retiredReason), /un-retires this proposal/, "the reason must say it is reversible");
});

test("W1-T3518: it does NOT retire while the finding is still reported", () => {
  const result = classifyProposal(ADOPTION_PROPOSAL, undefined, ctxWith(() => false));
  assert.notEqual(result.state, "retired", "a live finding is still the operator's to act on");
});

test("W1-T3518: a caller that supplies NO predicate retires nothing — forgetting cannot clear the backlog", () => {
  const noPredicate: ReadinessContext = { ...ctxWith(() => true), adoptionFindingGone: undefined };
  const result = classifyProposal(ADOPTION_PROPOSAL, undefined, noPredicate);
  assert.notEqual(result.state, "retired");
});

test("W1-T3518: a NON-adoption proposal is untouched even when the predicate would say gone", () => {
  const foreign: Proposal = { id: "proof-debt:W1-T965", summary: "proof debt", evidenceAnchors: [] };
  const result = classifyProposal(foreign, undefined, ctxWith(() => true));
  assert.notEqual(result.state, "retired", "the id prefix gate must hold, not just the shape parse");
});
