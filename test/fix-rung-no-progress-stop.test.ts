/**
 * Repeated red criteria are diagnostic evidence for W1-T7096's progress judge. They no longer
 * select an automatic stop or escalation in the disposition table.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DEFAULT_SWEEP_POLICY,
  deriveDisposition,
  fixRungRepeatsIdenticalFailure,
  runSweep,
  type ClarificationQuestion,
  type OpenPrView,
  type StrikeAttempt,
  type SweepDeps,
} from "../src/lib/sweep.js";
import type { CriterionVerdict } from "../src/lib/review.js";

const NOW = Date.parse("2026-08-28T12:00:00Z");
const RECENT = "2026-08-28T11:00:00Z";

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-fix-rung-no-progress-")), "ledger.ndjson");
}

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

function strike(over: Partial<StrikeAttempt> = {}): StrikeAttempt {
  return {
    strike: 1,
    round: "fresh",
    unmetCount: 2,
    ciGreen: true,
    reviewState: "failure",
    ...over,
  };
}

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 1269,
    prUrl: "https://github.com/craigoley/remudero/pull/1269",
    taskId: "W1-D",
    reviewState: "failure",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 1, // BELOW the default cap (2) — the earlier stop, never the cap itself
    lastActivityAt: RECENT,
    headSha: "cafe1269",
    autoMergeArmed: false,
    ...over,
  };
}

/** A recording fake for every injected sweep effect — mirrors handfiled-arm-handoff.test.ts's own. */
function fakeDeps(overrides: Partial<SweepDeps> = {}): SweepDeps & {
  armed: OpenPrView[];
  fixed: OpenPrView[];
  escalated: Array<{ pr: OpenPrView; reason: string; question: ClarificationQuestion }>;
} {
  const armed: OpenPrView[] = [];
  const fixed: OpenPrView[] = [];
  const escalated: Array<{ pr: OpenPrView; reason: string; question: ClarificationQuestion }> = [];
  return {
    armed,
    fixed,
    escalated,
    arm: (p) => {
      armed.push(p);
    },
    close: () => {},
    dispatchFix: (p) => {
      fixed.push(p);
    },
    escalate: (p, reason, question) => {
      escalated.push({ pr: p, reason, question });
    },
    ledgerPath: ledgerPath(),
    runId: "SWEEP-W1-T1269",
    now: () => NOW,
    ...overrides,
  };
}

// ── acceptance 1 — an identical-by-claim repeat stops the rung BEFORE the cap ──

test("W1-T1269 signal: unchanged unmet criteria do not override the progress-judge disposition", () => {
  const stalledPr = pr({
    priorStrikes: 1,
    unmetCriteria: [criterion({ claim: "criterion A" }), criterion({ claim: "criterion B" })],
    strikeHistory: [strike({ strike: 1, unmetCount: 2, unmetClaims: ["criterion A", "criterion B"] })],
  });

  assert.ok(1 < DEFAULT_SWEEP_POLICY.strikeCap, "sanity: this PR has NOT reached the cap yet");
  const result = deriveDisposition(stalledPr, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(result.disposition, "blocked-fixable", "the progress judge, not a repeated-set shortcut, owns the next-round decision");
  assert.doesNotMatch(result.reason, /identical unmet criteria/);
});

// ── acceptance 2 — a DIFFERENT unmet set, even at the same size, keeps its remaining strikes ──

test("W1-T1269 acceptance 2: a strike whose unmet criteria differ at the same size still gets its remaining strikes", () => {
  const progressingPr = pr({
    priorStrikes: 1,
    // Same COUNT (2) as the prior strike's set, but criterion B was fixed and criterion C
    // newly broke — a DIFFERENT set, not a repeat (the exact shape design note vi's falsifier
    // requires this rule to keep striking on).
    unmetCriteria: [criterion({ claim: "criterion A" }), criterion({ claim: "criterion C" })],
    strikeHistory: [strike({ strike: 1, unmetCount: 2, unmetClaims: ["criterion A", "criterion B"] })],
  });

  const result = deriveDisposition(progressingPr, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(result.disposition, "blocked-fixable", "still dispatches — a swapped criterion is lateral progress, never a repeat");
  assert.match(result.reason, /2 unmet criteria — strike 2\/2/);
});

// ── acceptance 3 — the comparison keys on IDENTITY, never on the count alone ──

test("W1-T1269 acceptance 3: fixRungRepeatsIdenticalFailure keys on each criterion's claim identity, not on how many there are", () => {
  // Byte-identical claim sets -> a genuine repeat.
  assert.equal(
    fixRungRepeatsIdenticalFailure(
      pr({
        unmetCriteria: [criterion({ claim: "A" }), criterion({ claim: "B" })],
        strikeHistory: [strike({ unmetClaims: ["A", "B"] })],
      }),
    ),
    true,
    "same claims, same size -> repeat",
  );

  // SAME size, DIFFERENT membership -> the count alone cannot see this, but identity can.
  assert.equal(
    fixRungRepeatsIdenticalFailure(
      pr({
        unmetCriteria: [criterion({ claim: "A" }), criterion({ claim: "C" })],
        strikeHistory: [strike({ unmetClaims: ["A", "B"] })],
      }),
    ),
    false,
    "same COUNT (2 vs 2) but a different claim set is never read as a repeat",
  );

  // A smaller count that is a subset (fixed one, the other still open) -> progress, not a repeat.
  assert.equal(
    fixRungRepeatsIdenticalFailure(
      pr({
        unmetCriteria: [criterion({ claim: "A" })],
        strikeHistory: [strike({ unmetClaims: ["A", "B"] })],
      }),
    ),
    false,
    "a shrinking set is progress, not a repeat — inclusion-descent is refused, not silently adopted either",
  );

  // No recorded strike claims at all (the unwired-producer default) -> fails CLOSED.
  assert.equal(
    fixRungRepeatsIdenticalFailure(
      pr({
        unmetCriteria: [criterion({ claim: "A" })],
        strikeHistory: [strike({ unmetClaims: undefined })],
      }),
    ),
    false,
    "no prior claim evidence recorded -> never matches (fail closed, byte-identical to pre-W1-T1269 behaviour)",
  );
});

// ── acceptance 4 — a repeated red set can escalate only through an explicit judge verdict ──

test("W1-T1269: the progress judge may escalate an unchanged red set, with a named loop", async () => {
  const deps = fakeDeps({
    fixProgressJudge: async () => ({ verdict: "escalate", loop: "same unmet criteria", reason: "the latest round added no evidence" }),
  });
  const stalledPr = pr({
    priorStrikes: 1,
    unmetCriteria: [criterion({ claim: "criterion A" }), criterion({ claim: "criterion B" })],
    strikeHistory: [strike({ strike: 1, unmetCount: 2, unmetClaims: ["criterion A", "criterion B"] })],
  });

  const summary = await runSweep([stalledPr], deps);
  assert.equal(summary.byDisposition["blocked-fixable"], 1);
  assert.equal(deps.fixed.length, 0, "the explicit judge verdict declines another round");
  assert.equal(deps.escalated.length, 1, "the judge's explicit decision reaches a human");
  assert.match(deps.escalated[0].reason, /same unmet criteria/);
  assert.ok(deps.escalated[0].question, "a real clarification question is generated, never silence");
  assert.equal(deps.escalated[0].question.taskId, "W1-D");
});
