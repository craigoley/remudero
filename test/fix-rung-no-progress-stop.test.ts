/**
 * test/fix-rung-no-progress-stop.test.ts — W1-T1269.
 *
 * THE DEFECT. Across separate fix-rung dispatches for one PR, the ONLY quantity the sweep's
 * strike-cap escalation row reads is `pr.priorStrikes` (a count that only ascends) against
 * `policy.strikeCap` — `pr.priorStrikes >= policy.strikeCap` (DISPOSITION_RULES row 4). The
 * evidence a strike leaves behind, `pr.unmetCriteria` (a `CriterionVerdict[]` carrying each
 * criterion's `claim`), is rendered into the strike reason ("N unmet criteria — strike X/Y") but
 * nothing ever COMPARES it to what the prior strike was given, so a strike that reproduces the
 * identical failure — same claims, same reasons — is indistinguishable from one that halved the
 * count or swapped which criteria are unmet. The cap is spent regardless.
 *
 * THE FIX. `fixRungRepeatsIdenticalFailure` (lib/sweep.ts, pure) compares the CURRENT
 * `pr.unmetCriteria` claim set against `pr.strikeHistory`'s most recently recorded strike's own
 * `unmetClaims` (a new, additive field on `StrikeAttempt`) — keyed on each claim's IDENTITY,
 * never on `.length`. DISPOSITION_RULES gains one new row (5.5), ordered after the cap-exhausted
 * row (unaffected) and the ci-log row ("ci-log wins" unaffected), but strictly before the
 * ordinary criteria-dispatch row: an EXACT repeat escalates immediately, BEFORE the cap; a
 * DIFFERENT set — even one of the same size — falls through and keeps its remaining strikes. The
 * escalation route is the SAME `blocked-ambiguous` disposition every other ambiguous block
 * already uses (`deps.escalate`, carrying a rendered `ClarificationQuestion`) — never a silent
 * stand-down.
 *
 * SCOPE: `StrikeAttempt.unmetClaims` ships unwired (no producer in `run-task.ts` populates it
 * yet, mirroring `pendingAnswer`/`reviewOrphanedByPush`'s own shipped-ahead-of-producer
 * precedent) — every fixture here supplies it directly, exactly as the real gateway will once its
 * own follow-up producer lands.
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

test("W1-T1269 acceptance 1: a strike whose unmet criteria are unchanged stops the rung before the cap", () => {
  const stalledPr = pr({
    priorStrikes: 1,
    unmetCriteria: [criterion({ claim: "criterion A" }), criterion({ claim: "criterion B" })],
    strikeHistory: [strike({ strike: 1, unmetCount: 2, unmetClaims: ["criterion A", "criterion B"] })],
  });

  assert.ok(1 < DEFAULT_SWEEP_POLICY.strikeCap, "sanity: this PR has NOT reached the cap yet");
  const result = deriveDisposition(stalledPr, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(result.disposition, "blocked-ambiguous", "escalates instead of dispatching another strike");
  assert.match(result.reason, /identical unmet criteria/);
  assert.match(result.reason, /escalating before the cap/);
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

// ── acceptance 4 — the earlier stop still escalates to a human, never goes quiet ──

test("W1-T1269 acceptance 4: an early stop still escalates to a human rather than going quiet", async () => {
  const deps = fakeDeps();
  const stalledPr = pr({
    priorStrikes: 1,
    unmetCriteria: [criterion({ claim: "criterion A" }), criterion({ claim: "criterion B" })],
    strikeHistory: [strike({ strike: 1, unmetCount: 2, unmetClaims: ["criterion A", "criterion B"] })],
  });

  const summary = await runSweep([stalledPr], deps);
  assert.equal(summary.byDisposition["blocked-ambiguous"], 1);
  assert.equal(deps.fixed.length, 0, "never spends another strike on a proven-identical failure");
  assert.equal(deps.escalated.length, 1, "escalates to a human instead of standing down silently");
  assert.match(deps.escalated[0].reason, /identical unmet criteria/);
  assert.ok(deps.escalated[0].question, "a real clarification question is generated, never silence");
  assert.equal(deps.escalated[0].question.taskId, "W1-D");
});
