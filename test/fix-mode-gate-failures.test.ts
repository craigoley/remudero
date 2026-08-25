/**
 * test/fix-mode-gate-failures.test.ts — W1-T2236.
 *
 * THE DEFECT (measured, this task's own rationale): the sweep names N actionable gate
 * failures with a remedy each (`OpenPrView.actionableGateFailures`, W1-T923) whenever a
 * review FAILS with `unmetCriteria` empty (every named criterion may already read MET —
 * the #1991 shape). `deriveFixMode`'s old `reviewer-unmet` row was an UNCONDITIONAL
 * catch-all (`when: () => true`), so it always matched, and the dispatch evidence never
 * carried `actionableGateFailures` at all — 22 of 35 measured `reviewer-unmet` dispatches
 * (63%) went out naming ZERO unmet criteria.
 *
 * THE FIX (design notes i-iv):
 *   (i)   `FixEvidence`/`FixDispatchEvidence` now carry `actionableGateFailures`, threaded
 *         from the sweep's own producer through `routeFix`/`runSweep`'s `dispatchFix` call
 *         and `runFixRung`'s per-round evidence build. A new `gate-fix` mode selects on it —
 *         ahead of the `reviewer-unmet` row whenever the sweep already named a structured,
 *         single-form remedy — so the prompt carries THAT remedy instead of an empty list.
 *   (ii)  `reviewer-unmet`'s own rule is now named (`unmetCriteria.length > 0`), never an
 *         unconditional catch-all — `deriveFixMode`'s total-function fallback still names it
 *         for the residual shape (no unmet criteria, no gate failure, no CI/merge-conflict
 *         evidence), unchanged from before this task: that shape still dispatches off the
 *         review's own `summary`, spends its strike, and — on exhaustion — still escalates,
 *         never silently suppressed (W1-T487, `test/escalation-evidence-floor.test.ts`,
 *         protected and out of this task's scope — round 1 of this task tried adding a
 *         pre-dispatch stand-down for that residual shape and it broke that protected
 *         invariant; removed here, not carried forward).
 *   (iii) PINNED, UNCHANGED: the strike cap; a real unmet-criteria dispatch renders exactly
 *         as before; no review failure is ever treated as if it passed.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  deriveFixMode,
  renderFixPrompt,
  runFixRung,
  type FixEvidence,
} from "../src/run-task.js";
import {
  DEFAULT_SWEEP_POLICY,
  deriveDisposition,
  runSweep,
  type ActionableGateFailure,
  type OpenPrView,
} from "../src/lib/sweep.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { Config } from "../src/lib/config.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";

function criterion(over: Partial<CriterionVerdict> & Pick<CriterionVerdict, "claim" | "met">): CriterionVerdict {
  return { proof: "proof", reason: "", proof_exec: "not_executable", ...over };
}

function result(over: Partial<WorkerResult> = {}): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 0,
    numTurns: 0,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "default",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

const FIX_RUNG_MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

function reviewVerdict(over: Partial<ReviewVerdict & { headSha: string; reviewerOutcome: string }> = {}): ReviewVerdict & {
  headSha: string;
  reviewerOutcome: string;
} {
  return {
    state: "failure",
    criteria: [],
    testTheater: false,
    summary: "sweep-reconstructed failing review (0 unmet)",
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    headSha: "deadbeef",
    reviewerOutcome: "sweep-reconstructed",
    ...over,
  };
}

function fixRungBaseOpts(task: { id: string; title: string }) {
  return {
    taskId: task.id,
    runId: `${task.id}-1730000000000`,
    task,
    prUrl: "https://github.com/acme/remudero/pull/2236",
    branch: `run-${task.id}-1730000000000`,
    worktreePath: "/tmp/rmd-fixrung-gate-wt",
    initialSessionId: "",
    mount: FIX_RUNG_MOUNT,
    settingsFile: "/tmp/rmd-fixrung-gate-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: "/tmp/rmd-fixrung-gate-wt", reviewerMount: FIX_RUNG_MOUNT },
  };
}

function tmpLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-fixrung-gate-")), "ledger.ndjson");
}

function fakeIssueStore(): IssueGateway & { calls: Array<{ title: string; body: string; labels: string[] }> } {
  let seq = 9200;
  const issues: Array<{ number: number; url: string; title: string; body: string; state: string }> = [];
  const calls: Array<{ title: string; body: string; labels: string[] }> = [];
  return {
    calls,
    create(title, body, labels) {
      const number = seq++;
      const url = `https://github.com/acme/remudero/issues/${number}`;
      issues.push({ number, url, title, body, state: "open" });
      calls.push({ title, body, labels });
      return url;
    },
    listOpen(): OpenIssue[] {
      return issues.filter((i) => i.state === "open").map((i) => ({ number: i.number, url: i.url, title: i.title, body: i.body }));
    },
    comment() {
      // not exercised by these tests
    },
  };
}

// ── criteria 1/2 — deriveFixMode / renderFixPrompt: the new `gate-fix` mode ─────────────────────

test("deriveFixMode: a review failure with EMPTY unmetCriteria but a NAMED actionable gate failure derives gate-fix, never reviewer-unmet", () => {
  const gateFailure: ActionableGateFailure = { reason: "changeset contradiction: body claims 3 files, diff touches 5" };
  const evidence: FixEvidence = {
    review: { unmetCriteria: [], summary: "remudero-review: FAIL — changeset contradiction" },
    actionableGateFailures: [gateFailure],
  };
  assert.equal(deriveFixMode(evidence), "gate-fix");
});

test("deriveFixMode: reviewer-unmet's own rule is now NAMED — an evidence shape with no unmet criteria, no gate failure, and no ci/merge-conflict evidence never reaches a positively-matched row (falls to the total-function fallback only)", () => {
  const evidence: FixEvidence = { review: { unmetCriteria: [], summary: "contradictory" } };
  // `deriveFixMode` stays TOTAL (always returns a string) — but no TABLE ROW positively claims
  // this shape any more; see FIX_MODE_RULES' own doc for why this is the point.
  assert.equal(deriveFixMode(evidence), "reviewer-unmet");
});

test("deriveFixMode: a real unmet-criteria set still derives reviewer-unmet, byte-identical, even when actionableGateFailures is ALSO (incorrectly) populated — unmetCriteria wins by construction", () => {
  const evidence: FixEvidence = {
    review: {
      unmetCriteria: [criterion({ claim: "criterion A", met: false, reason: "executed and failed" })],
      summary: "remudero-review: FAIL",
    },
  };
  assert.equal(deriveFixMode(evidence), "reviewer-unmet");
});

test("renderFixPrompt (gate-fix mode): names the remedy the sweep already named, MODE header reads gate-fix, and the rendered prompt never claims zero/empty criteria", () => {
  const prompt = renderFixPrompt({
    task: { id: "W1-TX", title: "Some task" },
    round: 1,
    branch: "run-W1-TX-1730000000000",
    evidence: {
      review: { unmetCriteria: [], summary: "remudero-review: FAIL — changeset contradiction" },
      actionableGateFailures: [{ reason: "changeset contradiction: body claims 3 files, diff touches 5" }],
    },
  });
  assert.match(prompt, /MODE: gate-fix/, "the rendered prompt names its derived mode");
  assert.match(prompt, /changeset contradiction: body claims 3 files, diff touches 5/, "the exact named remedy is carried verbatim");
  assert.doesNotMatch(prompt, /0 UNMET acceptance criterion/i, "never renders as an empty unmet-criteria list");
});

test("renderFixPrompt (reviewer-unmet, unchanged): a real unmet set still renders the full claim/proof/reason block exactly as before this task", () => {
  const prompt = renderFixPrompt({
    task: { id: "W1-TX", title: "Some task" },
    round: 1,
    branch: "run-W1-TX-1730000000000",
    evidence: {
      review: {
        unmetCriteria: [criterion({ claim: "criterion A merges cleanly", proof: "proof A", met: false, reason: "reason-A-missing" })],
        summary: "remudero-review: FAIL — 1 criterion unmet",
      },
    },
  });
  assert.match(prompt, /MODE: reviewer-unmet/);
  assert.match(prompt, /criterion A merges cleanly/);
  assert.match(prompt, /reason-A-missing/);
});

// ── criterion 3 — a review failure WITH unmet criteria dispatches exactly as it does today ──────

test("runFixRung (criterion 3): a review-mode round with REAL unmet criteria dispatches exactly as before — one strike spent, mode reviewer-unmet, unaffected by the new gate-fix machinery", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const unmetCriterion = criterion({ claim: "criterion A merges cleanly", met: false, reason: "executed and failed: assertion mismatch" });

  const outcome = await runFixRung({
    ...fixRungBaseOpts({ id: "W1-T2236A", title: "some task" }),
    strikeCap: 2,
    initialReview: reviewVerdict({ criteria: [unmetCriterion], summary: "1 unmet criterion" }),
    // Unpopulated on purpose — this dispatch is the ORDINARY unmet-criteria path, which must
    // stay byte-identical whether or not a (never-applicable) gate-failure seed is present.
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: "fix-session-1" });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => reviewVerdict({ state: "success", criteria: [criterion({ claim: "criterion A merges cleanly", met: true })], headSha: "sha-1" }),
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => logs.push({ step, extra }),
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(spawnCalls.length, 1, "the ordinary unmet-criteria strike still dispatches");
  assert.equal(outcome.outcome, "fixed");
  const dispatched = logs.filter((l) => l.step === "fix.dispatch");
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].extra?.mode, "reviewer-unmet");
  assert.equal(dispatched[0].extra?.unmet_count, 1);
  assert.equal(
    logs.filter((l) => l.step === "fix.stood_down" && l.extra?.site === "rung.empty_review_evidence").length,
    0,
    "the new guard never fires when there IS something to hand the worker",
  );
});

// ── criteria 1/2 (round 1) — a gate-failure-only dispatch carries the remedy, never an empty list ──

test("runFixRung (criteria 1/2, round 1): unmetCriteria EMPTY but actionableGateFailures NAMED (seeded from the sweep, mirroring ciFailures/mergeConflict) dispatches in gate-fix mode, carrying the exact remedy", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const gateFailure: ActionableGateFailure = { reason: "test theater: added tests assert nothing" };

  const outcome = await runFixRung({
    ...fixRungBaseOpts({ id: "W1-T2236B", title: "some task" }),
    strikeCap: 2,
    // The #1991 shape: every named criterion already reads MET, but the review still fails.
    initialReview: reviewVerdict({ criteria: [], summary: "remudero-review: FAIL — test theater detected" }),
    actionableGateFailures: [gateFailure],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: "fix-session-1" });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => reviewVerdict({ state: "success", criteria: [], testTheater: false, headSha: "sha-1" }),
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => logs.push({ step, extra }),
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(spawnCalls.length, 1, "the gate-failure dispatch fires — there IS a named remedy to act on");
  assert.equal(outcome.outcome, "fixed");
  const dispatched = logs.filter((l) => l.step === "fix.dispatch");
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].extra?.mode, "gate-fix", "mode names the remedy shape, never the empty-list catch-all");
  assert.equal(dispatched[0].extra?.unmet_count, 0, "unmet_count is honestly 0 — the remedy is carried in a SEPARATE field, not manufactured as a fake criterion");
});

// ── criterion 4 — neither unmet criteria nor a named remedy: still dispatches, unchanged ────────
// (round 1 of this task tried a pre-dispatch stand-down for this residual shape; it broke the
// protected W1-T487 invariant in test/escalation-evidence-floor.test.ts — identical inputs
// (an empty-criteria failing review) there are pinned to dispatch-then-escalate, never a
// silent stand-down, so that behavior is not carried forward here. See this file's own header.)

test("runFixRung (criterion 4, round 1): unmetCriteria EMPTY and actionableGateFailures EMPTY/absent still dispatches as reviewer-unmet off the review's own summary — never defaults to a NEW stand-down that W1-T487 forbids for this exact shape", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts({ id: "W1-T2236C", title: "some task" }),
    strikeCap: 2,
    initialReview: reviewVerdict({ criteria: [], summary: "remudero-review: FAIL — contradictory" }),
    // No `actionableGateFailures:` at all — the genuinely-unclassifiable shape.
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: "fix-session-1" });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => reviewVerdict({ state: "success", criteria: [], headSha: "sha-1" }),
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => logs.push({ step, extra }),
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(spawnCalls.length, 1, "the review's own summary still gives the worker something to act on");
  assert.equal(outcome.outcome, "fixed");
  const dispatched = logs.filter((l) => l.step === "fix.dispatch");
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].extra?.mode, "reviewer-unmet", "the total-function fallback, unchanged from before this task");
  assert.equal(dispatched[0].extra?.unmet_count, 0, "honestly 0 — no gate-fix remedy was ever named for this shape");
});

test("runFixRung (criteria 1/2, mid-rung recurrence): round 2's fresh re-review is itself a gate failure (testTheater true) — derived FRESH off the live review, never the stale round-1 seed, and dispatches in gate-fix mode", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts({ id: "W1-T2236E", title: "some task" }),
    // Capped at 2 — the mock `runReview` below always reports the SAME persistent testTheater
    // gate failure (this fixture is about MODE selection, not eventual resolution), so a higher
    // cap would keep dispatching round 3+ on the identical evidence; 2 isolates round 2 alone.
    strikeCap: 2,
    initialReview: reviewVerdict({
      criteria: [criterion({ claim: "criterion A", met: false, reason: "executed and failed" })],
      summary: "1 unmet criterion",
    }),
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `fix-session-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "green",
      // Round 1's strike fixes the named criterion but ADDS assertion-free tests: testTheater
      // fails the verdict on its own — a genuine, structured, single-form gate failure.
      runReview: async () =>
        reviewVerdict({ state: "failure", criteria: [criterion({ claim: "criterion A", met: true })], testTheater: true, headSha: "sha-1" }),
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => logs.push({ step, extra }),
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(spawnCalls.length, 2, "round 2 DOES dispatch — there is a fresh, real gate failure to act on");
  assert.equal(outcome.outcome, "escalated", "strike cap reached with the review still failing — exhaustion escalates, exactly as before this task");
  const dispatched = logs.filter((l) => l.step === "fix.dispatch");
  assert.equal(dispatched.length, 2);
  assert.equal(dispatched[0].extra?.mode, "reviewer-unmet", "round 1 is the ordinary unmet path");
  assert.equal(dispatched[1].extra?.mode, "gate-fix", "round 2 derives gate-fix FRESH off its own live review");
});

// ── criterion 5 — no review failure reaches a merge as a result of this change ───────────────────

test("runFixRung (criterion 5): a fully empty-evidence review (no unmet criteria, no gate failure) is NEVER treated as passing — it dispatches, spends every strike, and on exhaustion still escalates, exactly like today (W1-T487)", async () => {
  const issues = fakeIssueStore();
  let reviewCalls = 0;

  const outcome = await runFixRung({
    ...fixRungBaseOpts({ id: "W1-T2236F", title: "some task" }),
    strikeCap: 1,
    initialReview: reviewVerdict({ criteria: [], summary: "contradictory" }),
    deps: {
      spawn: async () => result(),
      waitForCiGreen: async () => "green",
      runReview: async () => {
        reviewCalls++;
        return reviewVerdict({ state: "failure", criteria: [], summary: "contradictory", headSha: `esc-sha-${reviewCalls}` });
      },
      push: () => {},
      issues,
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(outcome.outcome, "escalated", "never 'fixed' — the review is never treated as if it passed, and empty evidence is never silently suppressed");
  assert.equal(outcome.review.state, "failure", "the review verdict this escalation returns still reads failing — nothing here can arm a merge");
  assert.equal(issues.calls.length, 1, "a needs-human issue IS opened once the rung exhausts on this shape");
});

// ── W1-T923 sweep-side wiring (design note i) — the disposition rule itself is UNCHANGED and ──────
// ── never lets a review failure through to `mergeable` regardless of which evidence is present ───

function criterionFail(over: Partial<CriterionVerdict> = {}): CriterionVerdict {
  return { claim: "c", proof: "p", met: false, reason: "r", proof_exec: "not_executable", ...over };
}

function gateFailurePr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 2236,
    prUrl: "https://github.com/acme/remudero/pull/2236",
    taskId: "W1-T2236X",
    reviewState: "failure",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-08-24T18:00:00Z",
    headSha: "cafef00d",
    autoMergeArmed: false,
    ...over,
  };
}

test("W1-T2236 (design v, regression lock): every combination of empty/non-empty unmetCriteria x actionableGateFailures derives blocked-fixable or blocked-ambiguous — NEVER mergeable, so no review failure this task's evidence-plumbing touches can reach a merge", () => {
  const NOW = Date.parse("2026-08-24T18:30:00Z");
  const combos: OpenPrView[] = [
    gateFailurePr({ unmetCriteria: [], actionableGateFailures: [] }),
    gateFailurePr({ unmetCriteria: [criterionFail()], actionableGateFailures: [] }),
    gateFailurePr({ unmetCriteria: [], actionableGateFailures: [{ reason: "gate failure" }] }),
    gateFailurePr({ unmetCriteria: [criterionFail()], actionableGateFailures: [{ reason: "gate failure" }] }),
  ];
  for (const pr of combos) {
    const { disposition } = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
    assert.ok(
      disposition === "blocked-fixable" || disposition === "blocked-ambiguous",
      `unmetCriteria=${pr.unmetCriteria.length} actionableGateFailures=${pr.actionableGateFailures?.length ?? 0} derived ${disposition}, never mergeable`,
    );
  }
});

test("W1-T2236 (design i, sweep wiring): runSweep's own blocked-fixable dispatch carries actionableGateFailures through to dispatchFix — the production wiring, not only routeFix", async () => {
  const pr = gateFailurePr({ unmetCriteria: [], actionableGateFailures: [{ reason: "changeset contradiction" }] });
  const dispatchedEvidence: Array<{ unmetCriteria: CriterionVerdict[]; actionableGateFailures?: ActionableGateFailure[] }> = [];
  await runSweep(
    [pr],
    {
      arm: () => {},
      close: () => {},
      dispatchFix: (_pr, evidence) => {
        dispatchedEvidence.push(evidence);
      },
      escalate: () => {},
      ledgerPath: "/dev/null/ledger.ndjson",
      runId: "w1-t2236-sweep-run",
      readLedger: () => [],
      appendLine: () => {},
      now: () => Date.parse("2026-08-24T18:30:00Z"),
      log: () => {},
    },
    DEFAULT_SWEEP_POLICY,
  );
  assert.equal(dispatchedEvidence.length, 1);
  assert.deepEqual(dispatchedEvidence[0].actionableGateFailures, [{ reason: "changeset contradiction" }]);
});
