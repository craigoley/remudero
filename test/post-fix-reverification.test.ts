import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPABILITY_SNAPSHOT_FIX_CLASS,
  CI_GATE_TIMEOUT_FIX_CLASS,
  COVERAGE_TIER_FIX_CLASS,
  DEFAULT_FIX_CLASSES,
  runPostFixReverification,
  type FixClass,
  type OpenPrView,
  type PostFixReverificationDeps,
  type RedriveResult,
} from "../src/lib/sweep.js";
import { DEFAULT_SWEEP_POLICY, runSweep, type SweepDeps } from "../src/lib/sweep.js";
import { readLedgerLines } from "../src/lib/status.js";
import { appendLedger } from "../src/lib/ledger.js";
import { sweepPostFixReverification } from "../src/run-task.js";

// ── W1-T124 — POST-FIX RE-VERIFICATION, the drainage-side complement to the
// W1-T121 queue governor: once a systemic fix merges, stale reds of that class
// self-heal instead of rotting. Fixtures below replay the 2026-07-19 incident
// verbatim: FOUR PRs (#265/#249/#245/#236) went red on
// "ci-gate: timed out waiting for required check(s) to complete:
// mutation-ratchet" while mutation-ratchet itself completed SUCCESS on those
// same heads moments later — the gate timed out, the work was fine.

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-post-fix-reverification-")), "ledger.ndjson");
}

/**
 * `lastActivityAt` for a fixture PR that must read as RECENT — i.e. NOT stale.
 *
 * THIS WAS A TIME BOMB and it went off on 2026-08-02T12:00:00Z. It was a hardcoded
 * `"2026-07-19T12:00:00Z"`, and staleness is `now - lastActivityAt >= policy.staleDays` (14 days,
 * plan/policy.yaml). Fourteen days after that literal, three tests here began asserting
 * `mergeable` against a disposition that had silently become `stale` — and because `ci` runs the
 * whole suite, EVERY open PR inherited three red tests and `ci-gate` failed for all of them, so
 * nothing could merge. PR #1112 (ci at 09:30Z) passed; #1114 (13:40Z) did not; the only thing that
 * changed between them was the wall clock.
 *
 * A fixture that means "recent" must be relative to the run, never a date. The 2026-07-19 incident
 * this suite replays is documented in the comments above and in the fixture NAMES — the calendar
 * date carries the provenance, and this constant carries the semantics, which are different jobs.
 */
const RECENT = new Date(Date.now() - 60 * 60 * 1000).toISOString();

// ── THE REGRESSION LOCK for the time bomb above ────────────────────────────────────────────
// This is the assertion whose absence let the fixture rot silently. `RECENT` must sit INSIDE the
// staleness window on every run, forever. A future edit that writes a date literal back here
// fails this immediately instead of fourteen days later, in CI, on somebody else's PR.
test("the RECENT fixture can never age into staleness — it is derived, not a date literal", () => {
  const ageDays = (Date.now() - Date.parse(RECENT)) / 86_400_000;
  assert.ok(Number.isFinite(ageDays), `RECENT must parse as a date, got ${RECENT}`);
  assert.ok(ageDays >= 0, `RECENT must not be in the future (age ${ageDays}d)`);
  // The margin is the whole point: comfortably inside staleDays, not one tick under it.
  assert.ok(
    ageDays < DEFAULT_SWEEP_POLICY.staleDays,
    `RECENT is ${ageDays.toFixed(1)}d old against staleDays=${DEFAULT_SWEEP_POLICY.staleDays} — ` +
      `the fixture has aged into 'stale' and every disposition assertion below is now testing the wrong branch`,
  );
});

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 1,
    prUrl: "https://github.com/o/r/pull/1",
    taskId: "W1-TX",
    reviewState: "pending",
    checksState: "pending",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: RECENT,
    headSha: "aaaa111",
    autoMergeArmed: false,
    ...over,
  };
}

/** A PR blocked exactly the way the 2026-07-19 fixture was: ci-gate itself timed out waiting on
 *  mutation-ratchet, review already succeeded (the work was fine), checks red is the only block. */
function ciGateTimeoutPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return pr({
    reviewState: "success",
    checksState: "red",
    ciFailures: [
      {
        name: "ci-gate",
        logTail: "ci-gate: timed out waiting for required check(s) to complete: mutation-ratchet",
      },
    ],
    ...over,
  });
}

/** A genuinely unrelated red — a real defect, never matched by CI_GATE_TIMEOUT_FIX_CLASS. */
function unrelatedRedPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return pr({
    prNumber: 500,
    prUrl: "url/500",
    reviewState: "pending",
    checksState: "red",
    ciFailures: [{ name: "commitlint", logTail: "header-max-length: 108 chars exceeds the 100 cap" }],
    ...over,
  });
}

function fakeDeps(
  overrides: Partial<PostFixReverificationDeps> = {},
): PostFixReverificationDeps & { redriveCalls: Array<{ pr: OpenPrView; cls: FixClass }> } {
  const redriveCalls: Array<{ pr: OpenPrView; cls: FixClass }> = [];
  return {
    redriveCalls,
    redrive: (p, cls) => {
      redriveCalls.push({ pr: p, cls });
      return { fresh: { ...p, checksState: "green" } };
    },
    ledgerPath: ledgerPath(),
    runId: "SWEEP-1",
    ...overrides,
  };
}

// ── acceptance 1: matched PR re-drives exactly once, re-disposes on the fresh result ──

test("acceptance 1 — a matched PR has its required check re-driven exactly once and re-disposes on the fresh result", async () => {
  const candidate = ciGateTimeoutPr();
  const deps = fakeDeps();
  const merged = new Set([820]);

  const summary1 = await runPostFixReverification([candidate], merged, deps);
  assert.equal(summary1.redriven, 1);
  assert.equal(deps.redriveCalls.length, 1, "the redrive effect fired exactly once");
  assert.equal(deps.redriveCalls[0].cls.id, CI_GATE_TIMEOUT_FIX_CLASS.id);
  assert.equal(summary1.results[0].outcome, "redriven");
  assert.equal(summary1.results[0].disposition, "mergeable", "fresh checks green + review success -> mergeable");

  const lines = readLedgerLines(deps.ledgerPath);
  const redrivenLines = lines.filter((l) => l.step === "sweep.post_fix_redriven");
  assert.equal(redrivenLines.length, 1);
  assert.equal(redrivenLines[0].fix_pr_number, 820);

  // A SECOND pass over the SAME unchanged head must not redrive again.
  const summary2 = await runPostFixReverification([candidate], merged, deps);
  assert.equal(summary2.redriven, 0, "second pass over unchanged state redrives nothing new");
  assert.equal(deps.redriveCalls.length, 1, "still exactly one redrive call across both passes");
  assert.equal(summary2.results[0].outcome, "already-redriven");
});

test("acceptance 1b — a NEW push (fresh head sha) legitimately re-earns a redrive", async () => {
  const deps = fakeDeps();
  const merged = new Set([820]);

  await runPostFixReverification([ciGateTimeoutPr({ headSha: "aaaa111" })], merged, deps);
  assert.equal(deps.redriveCalls.length, 1);

  await runPostFixReverification([ciGateTimeoutPr({ headSha: "bbbb222" })], merged, deps);
  assert.equal(deps.redriveCalls.length, 2, "a new head sha is a fresh redrive candidate");
});

// ── acceptance 2: an unmatched PR is untouched — the falsifier ──────────────────────

test("acceptance 2 — a PR whose failure does NOT match the class is untouched: no redrive, no ledger line", async () => {
  const deps = fakeDeps();
  const merged = new Set([820]);

  const summary = await runPostFixReverification([unrelatedRedPr()], merged, deps);
  assert.equal(summary.redriven, 0);
  assert.equal(deps.redriveCalls.length, 0, "the mapping does real work — not a blanket rerun of every open PR");
  assert.equal(summary.results[0].outcome, "unmatched");

  const lines = readLedgerLines(deps.ledgerPath);
  assert.equal(lines.filter((l) => l.step === "sweep.post_fix_redriven").length, 0);
});

test("acceptance 2b — a matching failure whose fix PR has NOT merged yet is also untouched", async () => {
  const deps = fakeDeps();
  const notYetMerged = new Set<number>(); // 820 absent — the fix has not merged

  const summary = await runPostFixReverification([ciGateTimeoutPr()], notYetMerged, deps);
  assert.equal(summary.redriven, 0);
  assert.equal(deps.redriveCalls.length, 0);
  assert.equal(summary.results[0].outcome, "unmatched");
});

// ── acceptance 3: strike-exhausted PR becomes eligible again, strikes credited back ─

test("acceptance 3 — a strike-exhausted PR whose only defect was the fixed class becomes eligible again, strikes credited back", async () => {
  // Exhausted under the default strikeCap (2): this PR alone would land
  // blocked-ambiguous ("fix strikes exhausted") on an ordinary sweep pass.
  const exhausted = ciGateTimeoutPr({ prNumber: 265, prUrl: "url/265", priorStrikes: 2 });
  const deps = fakeDeps();
  const merged = new Set([820]);

  const summary = await runPostFixReverification([exhausted], merged, deps);
  assert.equal(summary.results[0].outcome, "redriven");
  assert.equal(summary.results[0].strikesCredited, 2, "the full exhausted count is credited back");
  assert.equal(
    summary.results[0].disposition,
    "mergeable",
    "credited to zero strikes + fresh checks green + review success -> eligible again, not stuck escalating",
  );

  const lines = readLedgerLines(deps.ledgerPath);
  const redrivenLine = lines.find((l) => l.step === "sweep.post_fix_redriven");
  assert.equal(redrivenLine?.credited_strikes, 2);
});

test("acceptance 3b — a re-verification pass never itself consumes a strike (no fix.dispatch-shaped ledger line)", async () => {
  const deps = fakeDeps();
  const merged = new Set([820]);

  await runPostFixReverification([ciGateTimeoutPr({ priorStrikes: 1 })], merged, deps);

  const lines = readLedgerLines(deps.ledgerPath);
  assert.equal(
    lines.some((l) => l.step === "fix.dispatch"),
    false,
    "the redrive path never dispatches the fix rung — it never spends a strike",
  );
});

// ── acceptance 4: the 2026-07-19 four-PR fixture replays clean ──────────────────────

test("acceptance 4 — the four 2026-07-19 ci-gate-timeout PRs, replayed as a fixture, all re-dispose to mergeable without a hand-pushed head", async () => {
  const fixture = [
    ciGateTimeoutPr({ prNumber: 265, prUrl: "url/265", taskId: "W1-T265", headSha: "sha265" }),
    ciGateTimeoutPr({ prNumber: 249, prUrl: "url/249", taskId: "W1-T249", headSha: "sha249" }),
    ciGateTimeoutPr({ prNumber: 245, prUrl: "url/245", taskId: "W1-T245", headSha: "sha245" }),
    ciGateTimeoutPr({ prNumber: 236, prUrl: "url/236", taskId: "W1-T236", headSha: "sha236" }),
  ];
  const deps = fakeDeps();
  const merged = new Set([820]); // W1-T123 has landed

  const summary = await runPostFixReverification(fixture, merged, deps);

  assert.equal(summary.redriven, 4, "all four PRs matched and were re-driven");
  assert.equal(deps.redriveCalls.length, 4);
  // Never a "hand-pushed head": the redrive re-drives the SAME head sha each PR
  // arrived with — nothing in this pass mints a new commit/head.
  for (const call of deps.redriveCalls) {
    assert.equal(call.pr.headSha, fixture.find((f) => f.prNumber === call.pr.prNumber)?.headSha);
  }
  for (const result of summary.results) {
    assert.equal(result.outcome, "redriven", `PR #${result.prNumber} was redriven`);
    assert.equal(result.disposition, "mergeable", `PR #${result.prNumber} re-disposes to mergeable`);
  }
});

test("acceptance 4b — before W1-T123 has merged, the same fixture is entirely untouched (the hard-dependency falsifier)", async () => {
  const fixture = [
    ciGateTimeoutPr({ prNumber: 265, prUrl: "url/265", headSha: "sha265" }),
    ciGateTimeoutPr({ prNumber: 249, prUrl: "url/249", headSha: "sha249" }),
  ];
  const deps = fakeDeps();
  const notYetMerged = new Set<number>();

  const summary = await runPostFixReverification(fixture, notYetMerged, deps);
  assert.equal(summary.redriven, 0);
  assert.equal(deps.redriveCalls.length, 0);
  assert.ok(summary.results.every((r) => r.outcome === "unmatched"));
});

// ── dry-run and failure handling ─────────────────────────────────────────────

test("dry-run leaves no trace: no redrive call, no ledger line, but the plan is still previewed", async () => {
  const deps = fakeDeps({ dryRun: true });
  const merged = new Set([820]);

  const summary = await runPostFixReverification([ciGateTimeoutPr()], merged, deps);
  assert.equal(summary.redriven, 1, "the plan still counts the match");
  assert.equal(deps.redriveCalls.length, 0, "but no real redrive effect fires under dry-run");

  const lines = readLedgerLines(deps.ledgerPath);
  assert.equal(lines.length, 0, "dry-run leaves no ledger trace");
});

test("a thrown redrive is contained per-PR (W1-T99 lesson) — one failure never strands the rest of the pass", async () => {
  const calls: number[] = [];
  const deps = fakeDeps({
    redrive: (p) => {
      calls.push(p.prNumber);
      if (p.prNumber === 1) throw new Error("gh api rate limited");
      return { fresh: { ...p, checksState: "green" } };
    },
  });
  const merged = new Set([820]);

  const summary = await runPostFixReverification(
    [ciGateTimeoutPr({ prNumber: 1 }), ciGateTimeoutPr({ prNumber: 2, prUrl: "url/2", headSha: "bbbb222" })],
    merged,
    deps,
  );

  assert.equal(calls.length, 2, "the second PR was still attempted after the first threw");
  assert.equal(summary.results[0].outcome, "redrive-failed");
  assert.equal(summary.results[1].outcome, "redriven");
  assert.equal(summary.redriven, 1);

  const lines = readLedgerLines(deps.ledgerPath);
  assert.equal(
    lines.some((l) => l.step === "sweep.post_fix_redriven" && l.pr_number === 1),
    false,
    "a failed redrive is never ledgered as done — it retries next pass",
  );
});

test("a redrive with no settled fresh result is ledgered as done but leaves disposition undefined for this pass", async () => {
  const deps = fakeDeps({ redrive: () => ({}) });
  const merged = new Set([820]);

  const summary = await runPostFixReverification([ciGateTimeoutPr()], merged, deps);
  assert.equal(summary.results[0].outcome, "redriven");
  assert.equal(summary.results[0].disposition, undefined, "no fresh view yet -> the next ordinary sweep re-derives it");

  const lines = readLedgerLines(deps.ledgerPath);
  assert.equal(lines.filter((l) => l.step === "sweep.post_fix_redriven").length, 1, "still recorded — never re-driven twice");
});

// ── policy-as-data: a new systemic fix is a row, never a code change ────────────────

test("DEFAULT_FIX_CLASSES carries the mapping as a table row, not an inlined constant in the reconciler", () => {
  assert.ok(Array.isArray(DEFAULT_FIX_CLASSES));
  assert.ok(DEFAULT_FIX_CLASSES.includes(CI_GATE_TIMEOUT_FIX_CLASS));
  assert.equal(CI_GATE_TIMEOUT_FIX_CLASS.fixPrNumber, 820);
});

// ── W1-T474 rows: #1758 (coverage-tier) and #1762 (capability-snapshot) — appended as DATA to
// DEFAULT_FIX_CLASSES, never a branch in runPostFixReverification (design note i) ──────────────

test("W1-T474 — DEFAULT_FIX_CLASSES carries the two new rows appended, never replacing the existing one", () => {
  assert.ok(DEFAULT_FIX_CLASSES.includes(CI_GATE_TIMEOUT_FIX_CLASS), "the W1-T124 row is untouched");
  assert.ok(DEFAULT_FIX_CLASSES.includes(COVERAGE_TIER_FIX_CLASS));
  assert.ok(DEFAULT_FIX_CLASSES.includes(CAPABILITY_SNAPSHOT_FIX_CLASS));
  assert.equal(COVERAGE_TIER_FIX_CLASS.fixPrNumber, 1758);
  assert.equal(CAPABILITY_SNAPSHOT_FIX_CLASS.fixPrNumber, 1762);
});

test("W1-T474 — a PR blocked by coverage-ratchet against the stale pre-#1758 floor matches COVERAGE_TIER_FIX_CLASS and re-drives once #1758 has merged", async () => {
  const candidate = pr({
    prNumber: 1770,
    prUrl: "url/1770",
    reviewState: "success",
    checksState: "red",
    ciFailures: [
      { name: "coverage-ratchet", logTail: "coverage-ratchet: BLOCKED -- coverage is below a floor:\n  - branches 71.20% is below the 72.00% floor" },
    ],
  });
  const deps = fakeDeps();

  // Not yet merged: untouched.
  const before = await runPostFixReverification([candidate], new Set<number>(), deps);
  assert.equal(before.results[0].outcome, "unmatched");
  assert.equal(deps.redriveCalls.length, 0);

  // #1758 has merged: matches and re-drives.
  const after = await runPostFixReverification([candidate], new Set([1758]), deps);
  assert.equal(after.results[0].outcome, "redriven");
  assert.equal(after.results[0].fixClassId, COVERAGE_TIER_FIX_CLASS.id);
  assert.equal(deps.redriveCalls[0].cls.fixPrNumber, 1758);
});

test("W1-T474 — a genuinely lower-coverage PR (no floor-blocked wording) never matches COVERAGE_TIER_FIX_CLASS", () => {
  const genuinelyLow = pr({
    checksState: "red",
    ciFailures: [{ name: "coverage-ratchet", logTail: "coverage-ratchet: unexpected error reading lcov" }],
  });
  assert.equal(COVERAGE_TIER_FIX_CLASS.matchesFailure(genuinelyLow), false);
});

test("W1-T474 — a PR blocked by the claims check's stale capability-snapshot matches CAPABILITY_SNAPSHOT_FIX_CLASS and re-drives once #1762 has merged", async () => {
  const candidate = pr({
    prNumber: 1771,
    prUrl: "url/1771",
    reviewState: "success",
    checksState: "red",
    ciFailures: [
      {
        name: "claims",
        logTail:
          "generate-capability-snapshot: MASTER-PLAN.md's CAPABILITY SNAPSHOT block is STALE -- it does not match a fresh regeneration.",
      },
    ],
  });
  const deps = fakeDeps();

  const before = await runPostFixReverification([candidate], new Set<number>(), deps);
  assert.equal(before.results[0].outcome, "unmatched");

  const after = await runPostFixReverification([candidate], new Set([1762]), deps);
  assert.equal(after.results[0].outcome, "redriven");
  assert.equal(after.results[0].fixClassId, CAPABILITY_SNAPSHOT_FIX_CLASS.id);
  assert.equal(deps.redriveCalls[0].cls.fixPrNumber, 1762);
});

test("W1-T474 — a genuine claims failure unrelated to the capability snapshot never matches CAPABILITY_SNAPSHOT_FIX_CLASS", () => {
  const genuineClaimsFailure = pr({
    checksState: "red",
    ciFailures: [{ name: "claims", logTail: "claims: FALSE -- plan/claims.yaml#some-other-claim" }],
  });
  assert.equal(CAPABILITY_SNAPSHOT_FIX_CLASS.matchesFailure(genuineClaimsFailure), false);
});

// ── W1-T474 wiring: sweepPostFixReverification (src/run-task.ts) — the real call site ──────────

function fakeSweepDeps(
  overrides: Partial<SweepDeps> = {},
): SweepDeps & { fixed: Array<{ pr: OpenPrView }> } {
  const fixed: Array<{ pr: OpenPrView }> = [];
  return {
    fixed,
    arm: () => {},
    close: () => {},
    dispatchFix: (p) => {
      fixed.push({ pr: p });
    },
    escalate: () => {},
    ledgerPath: ledgerPath(),
    runId: "SWEEP-WIRE-1",
    ...overrides,
  };
}

test("W1-T474 — sweepPostFixReverification pushes an empty commit (never a check re-run) naming the merged fix PR, on the matched PR's OWN head", async () => {
  const pushes: Array<{ branch: string; head: string; message: string }> = [];
  const candidate = ciGateTimeoutPr({ prNumber: 1780, prUrl: "url/1780", headRefName: "run-W1-T1780-1" });

  const summary = await sweepPostFixReverification("o", "r", [candidate], ledgerPath(), "SWEEP-WIRE-2", () => {}, {
    isMergedByNumber: (n) => n === 820,
    pushEmptyCommit: (_repoRoot, branch, head, message) => {
      pushes.push({ branch, head, message });
      return "newsha";
    },
  });

  assert.equal(summary.redriven, 1);
  assert.equal(pushes.length, 1, "the redrive is an empty-commit push, the effect W1-T474 rationale (8) names");
  assert.equal(pushes[0].branch, "run-W1-T1780-1");
  assert.equal(pushes[0].head, candidate.headSha);
  assert.match(pushes[0].message, /#820/, "names the merged fix PR");
});

test("W1-T474 — sweepPostFixReverification never pushes for a class whose fix has NOT merged (isMergedByNumber says so)", async () => {
  let pushes = 0;
  const candidate = ciGateTimeoutPr({ prNumber: 1781, prUrl: "url/1781", headRefName: "run-W1-T1781-1" });

  const summary = await sweepPostFixReverification("o", "r", [candidate], ledgerPath(), "SWEEP-WIRE-3", () => {}, {
    isMergedByNumber: () => false,
    pushEmptyCommit: () => {
      pushes++;
      return "never";
    },
  });

  assert.equal(summary.redriven, 0);
  assert.equal(pushes, 0);
});

test("W1-T474 — the ordering the rationale requires: a PR redriven this pass is excluded before runSweep's fix rung ever sees it, so no strike is spent on it in the same pass", async () => {
  const matched = ciGateTimeoutPr({ prNumber: 1790, prUrl: "url/1790", headRefName: "run-W1-T1790-1" });
  const unrelated = unrelatedRedPr({ prNumber: 1791, prUrl: "url/1791" });
  const openPrs = [matched, unrelated];

  const reverifySummary = await sweepPostFixReverification("o", "r", openPrs, ledgerPath(), "SWEEP-WIRE-4", () => {}, {
    isMergedByNumber: (n) => n === 820,
    pushEmptyCommit: () => "newsha",
  });
  const redrivenThisPass = new Set(
    reverifySummary.results.filter((r) => r.outcome === "redriven").map((r) => r.prNumber),
  );
  assert.deepEqual([...redrivenThisPass], [1790]);

  const prsForFixRung = openPrs.filter((p) => !redrivenThisPass.has(p.prNumber));
  const sweepDeps = fakeSweepDeps();
  await runSweep(prsForFixRung, sweepDeps, DEFAULT_SWEEP_POLICY);

  assert.deepEqual(
    sweepDeps.fixed.map((f) => f.pr.prNumber),
    [1791],
    "the fix rung never spends a strike on the PR the re-verification rung just acted on this pass",
  );
});

test("a custom class table is honored — covering a new systemic fix is a row, never a code change", async () => {
  const customClass: FixClass = {
    id: "custom-flaky-check",
    fixPrNumber: 999,
    description: "a made-up class for this test",
    matchesFailure: (p) => (p.ciFailures ?? []).some((f) => f.name === "flaky-thing"),
  };
  const deps = fakeDeps();
  const candidate = pr({
    reviewState: "success",
    checksState: "red",
    ciFailures: [{ name: "flaky-thing", logTail: "boom" }],
  });

  const summary = await runPostFixReverification([candidate], new Set([999]), deps, [customClass]);
  assert.equal(summary.redriven, 1);
  assert.equal(summary.results[0].fixClassId, "custom-flaky-check");

  // The built-in ci-gate class is NOT consulted when the caller supplies its own table.
  const summary2 = await runPostFixReverification(
    [ciGateTimeoutPr({ prNumber: 2, prUrl: "url/2", headSha: "cccc333" })],
    new Set([820]),
    fakeDeps(),
    [customClass],
  );
  assert.equal(summary2.results[0].outcome, "unmatched");
});

// ── W1-T977 — THE RUNG IS BLIND EXACTLY WHEN IT IS NEEDED. `buildOpenPrViews` only fetches
// `OpenPrView.ciFailures` when the AGGREGATE `checksState` is `"red"`, but a `ci-gate` required-
// check timeout is BY DEFINITION observed while a sibling required check is still running — i.e.
// `checksState === "pending"` — so the shared snapshot's `ciFailures` is undefined in the one
// state this class exists to catch. `PostFixReverificationDeps.readCiFailures` closes that gap:
// an OPTIONAL reader, consulted only for `undefined` + `"pending"`, never touching what any other
// rung observes off the same `OpenPrView`. ──────────────────────────────────────────────────────

/** A PR blocked the same way `ciGateTimeoutPr` is, EXCEPT the sibling this task's rationale
 *  describes is still running: the aggregate `checksState` is `"pending"` (not `"red"`), so
 *  `buildOpenPrViews` never populated `ciFailures` — the shared snapshot is exactly what the
 *  rung sees BEFORE this task's reader exists. */
function pendingCiGateTimeoutPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return pr({
    reviewState: "success",
    checksState: "pending",
    ciFailures: undefined,
    ...over,
  });
}

/** The evidence a live `readCiFailures` reader would return for the pending PR above — the SAME
 *  ci-gate-timeout shape `ciGateTimeoutPr` carries directly in its snapshot. */
const CI_GATE_TIMEOUT_EVIDENCE = [
  {
    name: "ci-gate",
    logTail: "ci-gate: timed out waiting for required check(s) to complete: mutation-ratchet",
  },
];

test("W1-T977: the redrive rung matches a ci-gate timeout while a sibling is pending", async () => {
  const deps = fakeDeps({ readCiFailures: () => CI_GATE_TIMEOUT_EVIDENCE });
  const merged = new Set([820]);

  const summary = await runPostFixReverification([pendingCiGateTimeoutPr()], merged, deps);

  assert.equal(summary.redriven, 1, "a pending ci-gate timeout must now be redriven, not silently skipped");
  assert.equal(summary.results[0].outcome, "redriven");
  assert.equal(summary.results[0].fixClassId, CI_GATE_TIMEOUT_FIX_CLASS.id);
  assert.equal(deps.redriveCalls.length, 1);
});

test("W1-T977: a pr matching no merged class is still left untouched by the rung", async () => {
  const deps = fakeDeps({
    // A pending PR whose reader turns up a REAL, unrelated failure — never ci-gate-timeout-shaped.
    readCiFailures: () => [{ name: "commitlint", logTail: "header-max-length: 108 chars exceeds the 100 cap" }],
  });
  const merged = new Set([820]);

  const summary = await runPostFixReverification([pendingCiGateTimeoutPr()], merged, deps);

  assert.equal(summary.results[0].outcome, "unmatched");
  assert.equal(summary.redriven, 0);
  assert.equal(deps.redriveCalls.length, 0, "no redrive call for an unmatched pr");
  const lines = readLedgerLines(deps.ledgerPath);
  assert.equal(lines.filter((l) => l.step === "sweep.post_fix_redriven").length, 0, "no ledger line either");
});

test("W1-T977: the rung reads failures through its own injected reader", async () => {
  const readCalls: OpenPrView[] = [];
  const candidate = pendingCiGateTimeoutPr();
  const deps = fakeDeps({
    readCiFailures: (p) => {
      readCalls.push(p);
      return CI_GATE_TIMEOUT_EVIDENCE;
    },
  });
  const merged = new Set([820]);

  const summary = await runPostFixReverification([candidate], merged, deps);

  assert.equal(readCalls.length, 1, "the injected reader is consulted exactly once for this pr");
  assert.equal(readCalls[0].prNumber, candidate.prNumber);
  assert.equal(summary.results[0].outcome, "redriven", "the match came from the reader, not the (undefined) snapshot field");
  // The reader's result is never written back into the shared snapshot object this rung was
  // handed — matching it never widens what any other rung observes off the same `OpenPrView`.
  assert.equal(candidate.ciFailures, undefined, "the caller's own pr object is never mutated");
});

test("W1-T977: the fix rung strike accounting is unchanged by the rung's own read", async () => {
  let unrelatedReaderCalled = false;
  const matchedPending = pendingCiGateTimeoutPr({ prNumber: 7, prUrl: "url/7", priorStrikes: 2 });
  const unrelatedRed = unrelatedRedPr({ priorStrikes: 2 });
  const originalUnrelatedCiFailures = unrelatedRed.ciFailures;
  const deps = fakeDeps({
    readCiFailures: (p) => {
      // The reader must be scoped to the pending+undefined gap this task closes — an already-red
      // pr's `ciFailures` came straight off the shared snapshot and must never be re-read here.
      if (p.prNumber === unrelatedRed.prNumber) unrelatedReaderCalled = true;
      return CI_GATE_TIMEOUT_EVIDENCE;
    },
  });
  const merged = new Set([820]);

  const summary = await runPostFixReverification([matchedPending, unrelatedRed], merged, deps);

  assert.equal(unrelatedReaderCalled, false, "the reader is never consulted for an already-red pr");
  const matchedResult = summary.results.find((r) => r.prNumber === matchedPending.prNumber);
  const unrelatedResult = summary.results.find((r) => r.prNumber === unrelatedRed.prNumber);
  assert.equal(matchedResult?.outcome, "redriven");
  assert.equal(matchedResult?.strikesCredited, 2, "this rung's own credit-back is unaffected by the added read");
  assert.equal(unrelatedResult?.outcome, "unmatched", "an unrelated red pr's disposition path is untouched");
  // The unrelated pr's own ciFailures — what the fix rung's ci-log mode and strike ladder read —
  // is byte-identical to what buildOpenPrViews handed in; this task never widens it.
  assert.deepEqual(unrelatedRed.ciFailures, originalUnrelatedCiFailures);
});

test("W1-T977: omitting the reader leaves the rung's behaviour unchanged", async () => {
  // No `readCiFailures` supplied at all — every existing caller/fixture in this suite (and every
  // caller of runPostFixReverification before this task) takes this path.
  const deps = fakeDeps();
  const merged = new Set([820]);

  const summary = await runPostFixReverification([pendingCiGateTimeoutPr()], merged, deps);

  assert.equal(summary.results[0].outcome, "unmatched", "byte-identical to before the reader existed: still blind");
  assert.equal(summary.redriven, 0);
  assert.equal(deps.redriveCalls.length, 0);
});

// ── W1-T977: `sweepPostFixReverification`'s OWN default `readCiFailures` — every test above
// drives `runPostFixReverification` (lib/sweep.ts) directly with a hand-supplied reader; none of
// them execute the real call site's fallback (`ghJson(["pr","view",…,"statusCheckRollup"])` +
// `fetchCiFailures`) that fires when the real caller (`runSweep`'s daemon wiring, run-task.ts
// line ~16443/~17140) omits `opts.readCiFailures` entirely. A PATH-stubbed `gh` (the same
// pattern test/check-wait-progress.test.ts uses for `waitForCiGreen`) drives that fallback for
// real, with zero network and no real `gh` binary.
test("BEHAVIORAL (W1-T977): sweepPostFixReverification's own default reader does a live gh read for a pending PR and redrives the ci-gate-timeout match", async () => {
  const fakeBinDir = mkdtempSync(join(tmpdir(), "post-fix-reverify-default-reader-bin-"));
  writeFileSync(
    join(fakeBinDir, "gh"),
    [
      "#!/bin/bash",
      "if [[ \"$1\" == 'pr' && \"$2\" == 'view' ]]; then",
      "  echo '{\"statusCheckRollup\":[{\"name\":\"ci-gate\",\"conclusion\":\"TIMED_OUT\"," +
        "\"detailsUrl\":\"https://github.com/o/r/actions/runs/1/job/42\"}]}'",
      "  exit 0",
      "fi",
      "if [[ \"$1\" == 'run' && \"$2\" == 'view' ]]; then",
      "  echo 'ci-gate: timed out waiting for required check(s) to complete: mutation-ratchet'",
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(join(fakeBinDir, "gh"), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${savedPath}`;

  try {
    const pushes: Array<{ branch: string; head: string }> = [];
    const candidate = pendingCiGateTimeoutPr({ prNumber: 1977, prUrl: "url/1977", headRefName: "run-W1-T1977-1" });

    const summary = await sweepPostFixReverification("o", "r", [candidate], ledgerPath(), "SWEEP-WIRE-977", () => {}, {
      isMergedByNumber: (n) => n === 820,
      pushEmptyCommit: (_repoRoot, branch, head) => {
        pushes.push({ branch, head });
        return "newsha";
      },
      // Deliberately NO `readCiFailures` override — this drives the module's own default.
    });

    assert.equal(summary.redriven, 1, "the live gh read must surface the ci-gate timeout the pending snapshot hid");
    assert.equal(summary.results[0].outcome, "redriven");
    assert.equal(summary.results[0].fixClassId, CI_GATE_TIMEOUT_FIX_CLASS.id);
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].branch, "run-W1-T1977-1");
  } finally {
    process.env.PATH = savedPath;
  }
});
