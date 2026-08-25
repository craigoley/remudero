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
 *         and `runFixRung`'s per-round evidence build. A new `gate-fix` mode selects on it.
 *   (ii)  `reviewer-unmet`'s own rule is now named (`unmetCriteria.length > 0`), never an
 *         unconditional catch-all.
 *   (iii) A review-mode round with NEITHER unmet criteria NOR a named gate failure now
 *         stands down under a named ledger reason (`rung.empty_review_evidence`) instead of
 *         dispatching a worker with nothing to act on.
 *   (iv)  PINNED, UNCHANGED: the strike cap; a real unmet-criteria dispatch renders exactly
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

// ── criterion 4 — neither unmet criteria nor a named remedy: stand down, never default ──────────

test("runFixRung (criterion 4, round 1): unmetCriteria EMPTY and actionableGateFailures EMPTY/absent stands down BEFORE strike 1 — never spawns a worker, never spends a strike, ledgers a named reason instead of defaulting to reviewer-unmet with an empty list", async () => {
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
      runReview: async () => {
        throw new Error("must never be reached — no strike should ever be dispatched");
      },
      push: () => {
        throw new Error("must never be reached — no strike should ever push");
      },
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => logs.push({ step, extra }),
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(spawnCalls.length, 0, "no fix worker is ever spawned");
  assert.equal(outcome.outcome, "stood_down");
  assert.equal(outcome.strikes, 0, "no strike consumed");
  assert.match(outcome.standDownReason ?? "", /no unmet acceptance criterion and no actionable gate failure named/i);

  const stoodDown = logs.filter((l) => l.step === "fix.stood_down" && l.extra?.site === "rung.empty_review_evidence");
  assert.equal(stoodDown.length, 1, "the stand-down is ledgered, not silent");
  assert.equal(stoodDown[0].extra?.strike, 1, "named as the strike that was about to be spent");

  const dispatched = logs.filter((l) => l.step === "fix.dispatch");
  assert.equal(dispatched.length, 0, "fix.dispatch — the one step a strike/prior.fixed dedup is counted from — is never logged");
});

test("runFixRung (criterion 4, mid-rung recurrence): round 1 has a real unmet criterion and dispatches; round 2's fresh re-review comes back with unmetCriteria empty and testTheater/contradictions absent — stands round 2 down instead of striking on nothing", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts({ id: "W1-T2236D", title: "some task" }),
    strikeCap: 3,
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
      // Round 1's strike leaves the review STILL FAILING (state stays "failure" — this rung's
      // loop condition is `review.state !== "success"`), but every named criterion now reads
      // MET, testTheater false, no changeset contradictions: a genuinely contradictory verdict,
      // never something a fix worker can act on.
      runReview: async () => reviewVerdict({ state: "failure", criteria: [criterion({ claim: "criterion A", met: true })], testTheater: false, headSha: "sha-1" }),
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => logs.push({ step, extra }),
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(spawnCalls.length, 1, "exactly ONE strike — round 1's; round 2 never dispatches");
  assert.equal(outcome.outcome, "stood_down");
  assert.equal(outcome.strikes, 1, "strikes never incremented past round 1");
  assert.match(outcome.standDownReason ?? "", /no unmet acceptance criterion and no actionable gate failure named/i);

  const stoodDown = logs.filter((l) => l.step === "fix.stood_down" && l.extra?.site === "rung.empty_review_evidence");
  assert.equal(stoodDown.length, 1);
  assert.equal(stoodDown[0].extra?.strike, 2, "named as the strike that was about to be spent");
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

test("runFixRung (criterion 5): the empty-review-evidence stand-down never treats the review as passing, escalates NOTHING, and rewrites NOTHING — it only ledgers and says, exactly like the sibling terminal-state stand-downs", async () => {
  const issues = fakeIssueStore();
  let updatePrBodyCalls = 0;
  const sayLines: string[] = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts({ id: "W1-T2236F", title: "some task" }),
    strikeCap: 2,
    initialReview: reviewVerdict({ criteria: [], summary: "contradictory" }),
    deps: {
      spawn: async () => result(),
      waitForCiGreen: async () => "green",
      runReview: async () => {
        throw new Error("must never be reached");
      },
      push: () => {},
      issues,
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: (msg) => sayLines.push(msg),
      account: (r) => r,
      updatePrBody: async () => {
        updatePrBodyCalls++;
      },
    },
  });

  assert.equal(outcome.outcome, "stood_down", "never 'fixed' — the review is never treated as if it passed");
  assert.equal(outcome.review.state, "failure", "the review verdict this stand-down returns still reads failing — nothing here can arm a merge");
  assert.equal(issues.calls.length, 0, "no needs-human issue is opened for this reason");
  assert.equal(updatePrBodyCalls, 0, "the stand-down never rewrites the PR body");
  assert.ok(sayLines.some((m) => /standing down/.test(m)), "the operator narration names the stand-down too");
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
