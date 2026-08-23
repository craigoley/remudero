import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_SWEEP_POLICY,
  deriveDisposition,
  runSweep,
  unmetCriteriaSignature,
  type ClarificationQuestion,
  type FixDispatchEvidence,
  type OpenPrView,
  type SweepDeps,
} from "../src/lib/sweep.js";
import type { CriterionVerdict } from "../src/lib/review.js";

/**
 * W1-T1269 — THE FIX RUNG RETRIES WITH NO TEST FOR PROGRESS. Across strikes the only quantity
 * DISPOSITION_RULES watched was `priorStrikes`, and it only ever ASCENDS — a strike that fails
 * IDENTICALLY (same unmet claims, same reasons) was indistinguishable from one that made real
 * progress, until the cap (`policy.strikeCap`) was finally hit. `unmetCriteria` is a
 * `CriterionVerdict[]` carrying each unmet claim's own identity; this task adds a row that
 * compares that SET (via {@link unmetCriteriaSignature}, keyed by `claim` + `reason`, never
 * `.length`) against {@link OpenPrView.priorUnmetCriteria} — the immediately-prior strike's own
 * unmet set — and stops the rung EARLIER, before the cap, the moment a strike changes nothing.
 *
 * This is an EARLIER stop, never a longer leash (design note iv): the cap itself is untouched,
 * and a CHANGED unmet set — including one of the same size — still gets its remaining strikes
 * (design note vi, the falsifier that must run both ways).
 */

const NOW = Date.parse("2026-08-23T12:00:00Z");
const RECENT = "2026-08-23T11:55:00Z";

function criterion(over: Partial<CriterionVerdict> = {}): CriterionVerdict {
  return {
    claim: "does the thing",
    proof: "unit test: it works",
    met: false,
    reason: "the thing is not done",
    proof_exec: "executed_fail",
    ...over,
  };
}

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 1,
    prUrl: "https://github.com/o/r/pull/1",
    taskId: "W1-TX",
    reviewState: "failure",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: RECENT,
    headSha: "aaaa111",
    autoMergeArmed: false,
    ...over,
  };
}

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-fix-rung-no-progress-")), "ledger.ndjson");
}

/** A recording fake for every injected effect, mirroring test/sweep.test.ts's own `fakeDeps`. */
function fakeDeps(overrides: Partial<SweepDeps> = {}): SweepDeps & {
  fixed: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }>;
  escalated: Array<{ pr: OpenPrView; reason: string; question: ClarificationQuestion }>;
} {
  const fixed: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }> = [];
  const escalated: Array<{ pr: OpenPrView; reason: string; question: ClarificationQuestion }> = [];
  return {
    fixed,
    escalated,
    arm: () => {},
    close: () => {},
    dispatchFix: (p, evidence) => {
      fixed.push({ pr: p, evidence });
    },
    escalate: (p, reason, question) => {
      escalated.push({ pr: p, reason, question });
    },
    ledgerPath: ledgerPath(),
    runId: "SWEEP-1269",
    now: () => NOW,
    ...overrides,
  };
}

// ── acceptance 1 — a strike whose unmet criteria are unchanged stops the rung before the cap ──

test("W1-T1269 acceptance 1 — an unmet-criteria set unchanged from the prior strike stops the rung BEFORE the cap is reached", () => {
  const identical = [criterion({ claim: "48 files changed", reason: "diff too large" })];
  const p = pr({
    priorStrikes: 1, // strictly less than DEFAULT_SWEEP_POLICY.strikeCap (2) — the cap is NOT yet reached
    unmetCriteria: identical,
    priorUnmetCriteria: identical.map((c) => ({ ...c })), // a SEPARATE object, same content — never reference equality
  });
  assert.ok(p.priorStrikes < DEFAULT_SWEEP_POLICY.strikeCap, "fixture sanity: the cap has not been hit yet");

  const r = deriveDisposition(p, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-ambiguous", "stops the rung rather than dispatching a further identical strike");
  assert.match(r.reason, /no progress/i);
  assert.doesNotMatch(r.reason, /exhausted/, "this is the EARLY stop, not the cap-exhaustion row — different reason text");
});

// ── acceptance 2 — a strike whose unmet criteria differ at the same size still gets its remaining strikes ──

test("W1-T1269 acceptance 2 — an unmet-criteria set that CHANGED, even at the SAME size, still gets its remaining strikes", () => {
  const before = [criterion({ claim: "criterion A", reason: "A failed" }), criterion({ claim: "criterion B", reason: "B failed" })];
  // A strike that fixed A and broke C: same COUNT (2), completely different membership.
  const after = [criterion({ claim: "criterion A", reason: "A failed" }), criterion({ claim: "criterion C", reason: "C failed" })];
  const p = pr({
    priorStrikes: 1,
    unmetCriteria: after,
    priorUnmetCriteria: before,
  });
  assert.equal(after.length, before.length, "fixture sanity: identical SIZE, different membership");

  const r = deriveDisposition(p, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-fixable", "a lateral swap is progress-shaped, not a repeat — dispatches the remaining strike");
  assert.match(r.reason, /2 unmet criteria/);
});

test("W1-T1269 acceptance 2b — the SAME two claims, but one's reason changed, is still read as a DIFFERENT failure (still gets remaining strikes)", () => {
  const before = [criterion({ claim: "criterion A", reason: "A failed with error X" })];
  const after = [criterion({ claim: "criterion A", reason: "A failed with error Y" })];
  const p = pr({ priorStrikes: 1, unmetCriteria: after, priorUnmetCriteria: before });

  const r = deriveDisposition(p, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-fixable", "same claim, different reason — not a provable repeat");
});

// ── acceptance 3 — the comparison keys on each criterion's identity, not on the count ──

test("W1-T1269 acceptance 3 — unmetCriteriaSignature keys on (claim, reason) identity, order-independent, never on .length", () => {
  const a = [criterion({ claim: "one", reason: "r1" }), criterion({ claim: "two", reason: "r2" })];
  const bReordered = [criterion({ claim: "two", reason: "r2" }), criterion({ claim: "one", reason: "r1" })];
  assert.equal(
    unmetCriteriaSignature(a),
    unmetCriteriaSignature(bReordered),
    "the SAME set in a different array order must produce the SAME signature",
  );

  // The falsifier this design note calls out explicitly: two DIFFERENT sets of the SAME size
  // must NOT collide just because their .length matches.
  const cSameSizeDifferentMembers = [criterion({ claim: "three", reason: "r3" }), criterion({ claim: "four", reason: "r4" })];
  assert.notEqual(
    unmetCriteriaSignature(a),
    unmetCriteriaSignature(cSameSizeDifferentMembers),
    "same COUNT, different membership must never read as identical — a .length-keyed comparison would collide here",
  );

  // A single differing reason (same claim) must also change the signature — "same claims failed
  // for the same reasons" is the FULL identity, not the claim alone.
  const dSameClaimsDifferentReason = [criterion({ claim: "one", reason: "different reason entirely" }), criterion({ claim: "two", reason: "r2" })];
  assert.notEqual(unmetCriteriaSignature(a), unmetCriteriaSignature(dSameClaimsDifferentReason));

  // Fixture-level corroboration via the real DISPOSITION_RULES table: same LENGTH (2 vs 2) on
  // both sides, one identical, one not — only the identical one stops early.
  const identicalPr = pr({ priorStrikes: 1, unmetCriteria: a, priorUnmetCriteria: a.map((c) => ({ ...c })) });
  const differentPr = pr({ priorStrikes: 1, unmetCriteria: a, priorUnmetCriteria: cSameSizeDifferentMembers });
  assert.equal(deriveDisposition(identicalPr, DEFAULT_SWEEP_POLICY, NOW).disposition, "blocked-ambiguous");
  assert.equal(deriveDisposition(differentPr, DEFAULT_SWEEP_POLICY, NOW).disposition, "blocked-fixable");
});

// ── acceptance 4 — an early stop still escalates to a human rather than going quiet ──

test("W1-T1269 acceptance 4 — an early no-progress stop still calls escalate() (a human sees it) rather than going quiet", async () => {
  const identical = [criterion({ claim: "48 files changed", reason: "diff too large" })];
  const p = pr({
    prNumber: 1269,
    priorStrikes: 1,
    unmetCriteria: identical,
    priorUnmetCriteria: identical.map((c) => ({ ...c })),
  });
  const deps = fakeDeps();

  const summary = await runSweep([p], deps);

  assert.equal(summary.byDisposition["blocked-ambiguous"], 1);
  assert.equal(deps.fixed.length, 0, "no-progress — never a further fix dispatch");
  assert.equal(deps.escalated.length, 1, "escalate() fires — the SAME transport every other blocked-ambiguous row uses, never a silent stand-down");
  assert.match(deps.escalated[0].reason, /no progress/i);
});

// ── design note iv — an EARLIER stop, never a longer leash: the cap itself is untouched ──

test("W1-T1269 design note iv — the cap is untouched: once priorStrikes actually reaches strikeCap, the ORIGINAL exhaustion row (not this one) still fires, with its own wording", () => {
  const identical = [criterion({ claim: "still unmet" })];
  const p = pr({
    priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap, // the cap itself
    unmetCriteria: identical,
    priorUnmetCriteria: identical.map((c) => ({ ...c })),
  });
  const r = deriveDisposition(p, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-ambiguous");
  assert.match(r.reason, /exhausted/, "row 4's own exhaustion wording — ordered before this task's row, unaffected by it");
  assert.doesNotMatch(r.reason, /no progress/i);
});

// ── design note vi (the other half) — no `priorUnmetCriteria` at all is the safe, unset default ──

test("W1-T1269 — priorUnmetCriteria undefined (no prior strike recorded, or an older producer that never wired this) never stops early — byte-identical to pre-W1-T1269 behaviour", () => {
  const p = pr({
    priorStrikes: 1,
    unmetCriteria: [criterion({ claim: "still unmet" })],
    // priorUnmetCriteria intentionally omitted
  });
  assert.equal(p.priorUnmetCriteria, undefined, "fixture sanity");
  const r = deriveDisposition(p, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-fixable", "the safe default is to keep dispatching, not to stop");
  assert.match(r.reason, /1 unmet criteri/);
});

// ── design note v / OUT OF SCOPE — actionableGateFailures (no claim identity) is untouched ──

test("W1-T1269 — a repeated actionableGateFailures-only block (no unmetCriteria at all) is NOT caught by this row — scoped to unmetCriteria only", () => {
  const p = pr({
    priorStrikes: 1,
    unmetCriteria: [],
    actionableGateFailures: [{ reason: "same named remedy every time" }],
    // Even if a caller mistakenly sets priorUnmetCriteria to [] here, unmetCriteria.length is 0
    // so this row's own guard (unmetCriteria.length > 0) never engages.
    priorUnmetCriteria: [],
  });
  const r = deriveDisposition(p, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-fixable", "gate failures keep dispatching — this task never widens scope to actionableGateFailures");
  assert.match(r.reason, /actionable gate failure/);
});
