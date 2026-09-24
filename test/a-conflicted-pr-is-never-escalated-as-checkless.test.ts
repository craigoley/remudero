import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DEFAULT_SWEEP_POLICY,
  lastKnownMergeStateFromLedger,
  runSweep,
  withInheritedMergeState,
  type ClarificationQuestion,
  type FixDispatchEvidence,
  type OpenPrView,
  type SweepDeps,
} from "../src/lib/sweep.js";
import { readLedgerLines } from "../src/lib/status.js";
import { appendLedger } from "../src/lib/ledger.js";

/**
 * PR #7028, 2026-09-24 (RETRO-1790262688710): a PR sat `mergeable_state: "dirty"` for over 40
 * minutes across 20+ sweep passes, correctly disposed `conflicted (mergeState dirty)` every time
 * — a CONFLICTING PR registers ZERO check runs by construction (CLAUDE.md). Interleaved among
 * those passes, GitHub's async mergeability recompute occasionally answered `unknown`
 * (`OpenPrView.mergeState: undefined`), and THAT pass's own `deriveDisposition` read the SAME
 * zero-check-run shape with no memory of the dirty read one tick either side of it: 15:47 waited
 * on "zero check runs … < 10m", 16:00 minted a pointless empty-commit re-push (`sweep.absent_repush`,
 * head f2ffec0, still conflicted), and 16:16 opened needs-human issue #7033 asking an operator to
 * choose between re-dispatch and revise-spec on a PR that only ever needed its conflict resolved.
 *
 * THE FIX (W1-T4470): an `unknown` mergeability read for a head INHERITS the last KNOWN
 * mergeability this SAME PR+head proved on a prior pass (`withInheritedMergeState`, sourced from
 * this module's own `sweep.disposed` ledger rows via `lastKnownMergeStateFromLedger`). The
 * zero-check-run rules (not-yet-scheduled wait, absent_repush, the checks-none escalation) never
 * fire for a head whose last known mergeability is dirty — it is disposed exactly as a freshly
 * observed dirty read would be.
 */

const NOW = Date.parse("2026-09-24T15:47:00.000Z");

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-w1-t4470-")), "ledger.ndjson");
}

function conflictedPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 7028,
    prUrl: "https://github.com/craigoley/remudero/pull/7028",
    taskId: "W1-T7028",
    reviewState: "none",
    checksState: "none",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW).toISOString(),
    headSha: "9515168aa",
    headRefName: "some-contributor-branch",
    autoMergeArmed: false,
    ...over,
  };
}

function fakeDeps(overrides: Partial<SweepDeps> = {}): SweepDeps & {
  escalated: Array<{ pr: OpenPrView; reason: string; question: ClarificationQuestion }>;
  repushed: OpenPrView[];
  fixed: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }>;
} {
  const escalated: Array<{ pr: OpenPrView; reason: string; question: ClarificationQuestion }> = [];
  const repushed: OpenPrView[] = [];
  const fixed: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }> = [];
  return {
    arm: () => {},
    close: () => {},
    dispatchFix: (pr, evidence) => {
      fixed.push({ pr, evidence });
    },
    escalate: (pr, reason, question) => {
      escalated.push({ pr, reason, question });
    },
    repushAbsent: async (pr) => {
      repushed.push(pr);
      return "new-empty-commit-sha";
    },
    escalated,
    repushed,
    fixed,
    ledgerPath: ledgerPath(),
    runId: "SWEEP-W1-T4470",
    ...overrides,
  };
}

test("W1-T4470: an unknown read on a head last seen dirty is disposed conflicted", async () => {
  const path = ledgerPath();

  // Pass 1: an ordinary OBSERVED dirty read — zero check runs, mergeState "dirty" — disposed the
  // ordinary way (no captured merge-conflict evidence, so the auto-repair "conflicted" row does
  // not admit and this falls to the `blocked-ambiguous` dirty row, exactly like every other
  // contributor-branch conflict).
  const deps1 = fakeDeps({
    ledgerPath: path,
    now: () => NOW,
  });
  const pass1Pr = conflictedPr({ mergeState: "dirty", mergeable: false, mergeableState: "dirty" });
  const summary1 = await runSweep([pass1Pr], deps1, DEFAULT_SWEEP_POLICY);
  assert.equal(summary1.byDisposition["blocked-ambiguous"], 1);
  const disposed1 = readLedgerLines(path).filter((l) => l.step === "sweep.disposed");
  assert.equal(disposed1.length, 1);
  assert.equal(disposed1[0].merge_state, "dirty", "the effective mergeState is ledgered for later inheritance");
  assert.match(String(disposed1[0].reason), /merge conflict \(mergeState dirty\)/);

  // Pass 2, SAME head, ~13 minutes later: GitHub's lazy recompute answers `unknown` this tick —
  // `mergeState`/`mergeable`/`mergeableState` all undefined — the EXACT #7028 shape. Without
  // hysteresis this falls through every dirty-gated row (none of which match `undefined`) to the
  // checks-none catch-all and escalates "not positively mergeable — checks none".
  const NOW2 = NOW + 13 * 60_000;
  const deps2 = fakeDeps({
    ledgerPath: path,
    now: () => NOW2,
  });
  const pass2Pr = conflictedPr({
    lastActivityAt: new Date(NOW2 - 20 * 60_000).toISOString(),
    mergeState: undefined,
    mergeable: undefined,
    mergeableState: undefined,
  });
  const summary2 = await runSweep([pass2Pr], deps2, DEFAULT_SWEEP_POLICY);

  assert.equal(summary2.byDisposition["blocked-ambiguous"], 1, "still disposed as a conflict, not wait/mergeable");
  const disposed2 = readLedgerLines(path).filter((l) => l.step === "sweep.disposed");
  assert.equal(disposed2.length, 2);
  const reason2 = String(disposed2[1].reason);
  assert.match(reason2, /merge conflict \(mergeState dirty\)/, "disposed as conflicted, inheriting the last known dirty read");
  assert.match(reason2, /inherited last known "dirty"/, "the inheritance itself is named on the ledgered row (design iv)");
  assert.doesNotMatch(reason2, /not positively mergeable/, "never falls to the checks-none catch-all");
  assert.doesNotMatch(reason2, /zero check runs/, "never treated as the ordinary zero-check-run shape");
  assert.equal(disposed2[1].merge_state, "dirty", "the inherited state is itself ledgered forward");

  // Pure-function proof, independent of the full sweep: the SAME lookup `runSweep` uses.
  const known = lastKnownMergeStateFromLedger(readLedgerLines(path), 7028, "9515168aa");
  assert.equal(known?.state, "dirty");
  const { pr: inheritedPr, inherited } = withInheritedMergeState(
    conflictedPr({ mergeState: undefined, mergeable: undefined, mergeableState: undefined }),
    readLedgerLines(path),
  );
  assert.equal(inheritedPr.mergeState, "dirty");
  assert.equal(inherited?.state, "dirty");
});

test("W1-T4470: a head last seen dirty is never re-pushed or escalated for zero check runs", async () => {
  const path = ledgerPath();

  // Seed a PRIOR pass's own KNOWN observation directly, exactly the row `runSweep` itself writes
  // (see the first test) — `acted: false` (this row's OWN pass deferred the escalation to the
  // full sweep, e.g. a light-pass tick's `actionable` gate; see `SweepDeps.actionable`) so the
  // ORDINARY per-head "already escalated" dedup (`prior.escalated`, keyed off `acted:true` rows
  // only) never masks THIS test's own assertion — the pass below must genuinely REACH the
  // zero-check-run remedies to prove hysteresis, not merely coast on an unrelated dedup.
  appendLedger(path, {
    run_id: "SWEEP-PRIOR",
    task_id: "W1-T7028",
    step: "sweep.disposed",
    pr_number: 7028,
    pr_url: "https://github.com/craigoley/remudero/pull/7028",
    disposition: "blocked-ambiguous",
    acted: false,
    stand_down_reason: "deferred to full sweep (light pass)",
    reason: "merge conflict (mergeState dirty) — head is not this PR task's rmd-owned run branch — not dispatched",
    head_sha: "9515168aa",
    merge_state: "dirty",
  });

  // This pass is old enough (well past `absentCeilingMinutes`, default 10m) that, absent
  // hysteresis, the ABSENT-check-suite remedy would fire a pointless empty-commit re-push
  // (`sweep.absent_repush`) exactly like 16:00's f2ffec0, or the checks-none catch-all would
  // escalate exactly like 16:16's needs-human #7033 — both on a PR that only needed its
  // already-known conflict left alone. `mergeState`/`mergeable`/`mergeableState` are all
  // undefined — the exact #7028 "unknown" read.
  const NOW2 = NOW + 45 * 60_000;
  const deps2 = fakeDeps({ ledgerPath: path, now: () => NOW2 });
  const pass2Pr = conflictedPr({
    lastActivityAt: new Date(NOW2 - 40 * 60_000).toISOString(),
    mergeState: undefined,
    mergeable: undefined,
    mergeableState: undefined,
  });
  await runSweep([pass2Pr], deps2, DEFAULT_SWEEP_POLICY);

  assert.equal(deps2.repushed.length, 0, "never re-pushed — the head's last known state is dirty, not ABSENT");
  assert.equal(
    readLedgerLines(path).some((l) => l.step === "sweep.absent_repush"),
    false,
    "no absent_repush ledger row for a head last seen dirty",
  );
  // The dirty row DOES still escalate (design (ii) only exempts the zero-check-run rules, not
  // the ordinary dirty escalation itself) — but for the right reason, never "checks none".
  assert.equal(deps2.escalated.length, 1);
  assert.match(deps2.escalated[0].reason, /merge conflict \(mergeState dirty\)/);
  assert.doesNotMatch(deps2.escalated[0].reason, /checks none/);
  assert.doesNotMatch(deps2.escalated[0].reason, /not positively mergeable/);
});
