/**
 * test/infrastructure-fault-has-a-disposition.test.ts — W1-T2293.
 *
 * THE DEFECT. `FIX_MODE_RULES` (src/run-task.ts) is a closed table of five rows — merge-conflict,
 * ci-log, gate-fix, body-coverage, reviewer-unmet — and `deriveFixMode` returns the first whose
 * `when` matches, defaulting to reviewer-unmet. Every one of the five is a BUILD mode: there is no
 * disposition that reports rather than edits. When a fix rung's OWN re-review runs against a body
 * it never fetched (`ReportSubstituteCause`, lib/review.ts, W1-T1100/#2886 — the three non-
 * body-coverage modes never read the PR body at all), every criterion the keyword floor withholds
 * coverage from reads as an ordinary unmet criterion, and the router — unable to say anything but
 * BUILD — dispatches a worker to "fix" a diff that was never judged. Measured twice the same day
 * (PR-2850, PR-2877): neither needed a line of code.
 *
 * THE FIX. `reportSubstituteStandDownReason` (pure, beside `deriveFixMode`) recognises this shape
 * off STRUCTURED data alone — the previous round's own `reportSubstituteCause`, already threaded
 * into `runFixRung`'s `deps.runReview` call — never a match on any criterion's `reason` text.
 * `runFixRung` consults it at a NEW pre-strike gate (site `rung.report_substituted`), mirroring
 * `rung.empty_ci_failures`/`rung.empty_review_evidence` beside it: no strike spent, a ledgered
 * reason, a named `"stood_down"` outcome, no edit to the PR. It refuses whenever any unmet
 * criterion carries an OBSERVED `executed_fail` — a real defect the next fix worker can still act
 * on — so a genuinely broken PR still reaches a worker exactly as before this task.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runFixRung, reportSubstituteStandDownReason } from "../src/run-task.js";
import { judgeCriterion, judgeReview } from "../src/lib/review.js";
import type { CriterionVerdict, ReviewVerdict, ReportSubstituteCause } from "../src/lib/review.js";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { Config } from "../src/lib/config.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";

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

function criterion(over: Partial<CriterionVerdict> & Pick<CriterionVerdict, "claim" | "met">): CriterionVerdict {
  return { proof: "proof", reason: "", proof_exec: "not_executable", ...over };
}

function fakeReview(
  state: "success" | "failure",
  criteria: CriterionVerdict[],
  headSha = "deadbeef",
): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return {
    state,
    criteria,
    testTheater: false,
    summary: state === "success" ? "all criteria met" : "unmet criteria",
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    headSha,
    reviewerOutcome: "success",
  };
}

const FIX_RUNG_MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

function fixRungBaseOpts(task: { id: string; title: string }) {
  return {
    taskId: task.id,
    runId: `${task.id}-1730000000000`,
    task,
    prUrl: "https://github.com/acme/remudero/pull/2877",
    branch: `run-${task.id}-1730000000000`,
    worktreePath: "/tmp/rmd-fixrung-infra-fault-wt",
    initialSessionId: "session-0",
    mount: FIX_RUNG_MOUNT,
    settingsFile: "/tmp/rmd-fixrung-infra-fault-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: "/tmp/rmd-fixrung-infra-fault-wt", reviewerMount: FIX_RUNG_MOUNT },
  };
}

function tmpLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-fixrung-infra-fault-")), "ledger.ndjson");
}

function fakeIssueStore(): IssueGateway & { calls: Array<{ title: string; body: string; labels: string[] }> } {
  let seq = 900;
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

// ── reportSubstituteStandDownReason — the pure recognition (claims 1, 4, 5) ────────────────────

test("reportSubstituteStandDownReason (claims 1, 4): fires on a STRUCTURED never-fetched cause + a fully capped review even when the reason text names nothing about a body — recognition is not a prose match", () => {
  const unmet = [
    criterion({ claim: "a", met: false, reason: "unrelated text naming nothing about any body" }),
    criterion({ claim: "b", met: false, reason: "also unrelated" }),
  ];
  const reason = reportSubstituteStandDownReason(unmet, true, { kind: "never-fetched", fixMode: "reviewer-unmet" });
  assert.ok(reason, "a floor failure caused by an unread body reaches a non-build disposition");
  assert.match(reason ?? "", /not read/i);
});

test("reportSubstituteStandDownReason (claim 4, converse): does NOT fire on reason text that LOOKS like a substitution refusal when no structured cause is present — the same string this task's rationale measured going stale", () => {
  const unmet = [criterion({ claim: "a", met: false, reason: "proof unmet: the PR body was NOT read — so this is the worker's own text" })];
  const reason = reportSubstituteStandDownReason(unmet, true, undefined);
  assert.equal(reason, undefined, "prose alone, with no structured cause, must never trigger the stand-down");
});

test("reportSubstituteStandDownReason: both ReportSubstituteCause kinds — never-fetched and fetch-failed — recognise the same underlying fact (the body was not judged)", () => {
  const unmet = [criterion({ claim: "a", met: false, reason: "r" })];
  assert.ok(reportSubstituteStandDownReason(unmet, true, { kind: "never-fetched" }));
  assert.ok(reportSubstituteStandDownReason(unmet, true, { kind: "fetch-failed" }));
});

test("reportSubstituteStandDownReason: an EMPTY unmet set never fires — that shape belongs to rung.empty_review_evidence beside it", () => {
  assert.equal(reportSubstituteStandDownReason([], true, { kind: "never-fetched" }), undefined);
});

test("reportSubstituteStandDownReason (claim 5): ANY observed executed_fail among the unmet set refuses — a genuine, OBSERVED defect still routes to build", () => {
  const unmet = [
    criterion({ claim: "a", met: false, reason: "r", proof_exec: "not_executable" }),
    criterion({ claim: "b", met: false, reason: "r2", proof_exec: "executed_fail" }),
  ];
  assert.equal(reportSubstituteStandDownReason(unmet, true, { kind: "never-fetched" }), undefined);
});

test("reportSubstituteStandDownReason: an ordinary in-progress round (review NOT capped — SOMETHING was observed elsewhere) never fires, even under a never-fetched cause — an unread body alone is not enough", () => {
  const unmet = [criterion({ claim: "a", met: false, reason: "r", proof_exec: "not_executable" })];
  assert.equal(
    reportSubstituteStandDownReason(unmet, false, { kind: "never-fetched", fixMode: "reviewer-unmet" }),
    undefined,
    "capped:false means some criterion in this SAME review was actually observed — real signal exists, so build proceeds",
  );
});

// ── runFixRung integration — the pre-strike gate (claims 1, 2, 3, 7, 8) ─────────────────────────

test("runFixRung (claims 1, 2, 3, 7): a review computed against an unread body (round 1's own never-fetched re-review) stands round 2 down BEFORE it spends a strike — never dispatches, ledgers a named reason, returns outcome stood_down", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let runReviewCalls = 0;
  let updatePrBodyCalls = 0;

  const initialReview = fakeReview("failure", [
    criterion({ claim: "criterion A merges cleanly", met: false, reason: "reason: r" }),
    criterion({ claim: "criterion B is documented", met: false, reason: "reason: r2" }),
  ]);

  const outcome = await runFixRung({
    ...fixRungBaseOpts({ id: "W1-T2293X", title: "fix the unmet criteria" }),
    strikeCap: 3,
    initialReview,
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `fix-session-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "green",
      // Round 1's dispatch mode is "reviewer-unmet" (no ciFailures/mergeConflict/gate-failure —
      // FIX_MODE_RULES falls to its own terminal row), which never fetches the PR body by the
      // initialiser (rationale (9)) — so THIS round's own re-review is judged against a substitute
      // regardless of what criteria it returns. `capped: true` mirrors the 22:57:43.941Z row design
      // note (i) cites — nothing anywhere in the review was ever OBSERVED (every proof prose-only).
      // Round 2 must never call this again.
      runReview: async () => {
        runReviewCalls++;
        if (runReviewCalls > 1) throw new Error("must never be reached — round 2 must stand down before any re-review");
        return { ...initialReview, headSha: "sha-1", capped: true };
      },
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => logs.push({ step, extra }),
      say: () => {},
      account: (r) => r,
      updatePrBody: async () => {
        updatePrBodyCalls++;
      },
    },
  });

  assert.equal(spawnCalls.length, 1, "exactly ONE strike — round 1's; round 2 never dispatches a fix worker");
  assert.equal(outcome.outcome, "stood_down", "the disposition is not a build mode");
  assert.equal(outcome.strikes, 1, "no strike was spent on the infra-fault round — the ceiling is unchanged");
  assert.ok(outcome.standDownReason, "the stand-down carries a named reason");
  assert.equal(updatePrBodyCalls, 0, "the disposition itself never writes the PR body");

  const stoodDown = logs.filter((l) => l.step === "fix.stood_down");
  assert.equal(stoodDown.length, 1, "the stand-down is ledgered, not silent");
  assert.equal(stoodDown[0].extra?.site, "rung.report_substituted");
  assert.equal(stoodDown[0].extra?.strike, 2, "named as the strike that was about to be spent — BEFORE it was counted");
  assert.ok(stoodDown[0].extra?.reason, "the ledgered line names its reason");

  const dispatched = logs.filter((l) => l.step === "fix.dispatch");
  assert.equal(dispatched.length, 1, "only round 1's real strike is ever counted as a dispatch");
});

test("runFixRung (claim 8): the stand-down opens no escalation and writes nothing — it only ledgers and narrates, mirroring the empty-evidence guards beside it", async () => {
  const issues = fakeIssueStore();
  const sayLines: string[] = [];
  let runReviewCalls = 0;
  const initialReview = fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "r" })]);

  const outcome = await runFixRung({
    ...fixRungBaseOpts({ id: "W1-T2293Y", title: "fix the unmet criterion" }),
    strikeCap: 3,
    initialReview,
    deps: {
      spawn: async () => result(),
      waitForCiGreen: async () => "green",
      runReview: async () => {
        runReviewCalls++;
        if (runReviewCalls > 1) throw new Error("must never be reached");
        return { ...initialReview, headSha: "sha-1", capped: true };
      },
      push: () => {},
      issues,
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: (msg) => sayLines.push(msg),
      account: (r) => r,
    },
  });

  assert.equal(outcome.outcome, "stood_down");
  assert.equal(issues.calls.length, 0, "no needs-human issue is opened for this reason — a human/existing path decides, not this guard");
  assert.equal(outcome.issueUrl, undefined);
  assert.ok(sayLines.some((m) => /standing down/.test(m)), "the operator narration names the stand-down too");
});

test("runFixRung (claim 5): a round whose unread-body re-review ALSO carries an OBSERVED executed_fail still dispatches — a genuine defect still reaches a worker", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let runReviewCalls = 0;

  const initialReview = fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "r" })]);
  // Round 1's re-review carries ONE withheld-coverage criterion AND one OBSERVED executed_fail —
  // the shape design note (viii) requires to still route to build.
  const round1Review = fakeReview(
    "failure",
    [
      criterion({ claim: "criterion A merges cleanly", met: false, reason: "r" }),
      criterion({ claim: "criterion B's test actually passes", met: false, reason: "observed failure", proof_exec: "executed_fail" }),
    ],
    "sha-1",
  );

  const outcome = await runFixRung({
    ...fixRungBaseOpts({ id: "W1-T2293Z", title: "fix the unmet criteria" }),
    strikeCap: 2,
    initialReview,
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `fix-session-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => {
        runReviewCalls++;
        return runReviewCalls === 1 ? round1Review : { ...round1Review, headSha: "sha-2", state: "success" as const };
      },
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => logs.push({ step, extra }),
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(spawnCalls.length, 2, "BOTH strikes dispatch — the observed executed_fail keeps this round out of the new guard");
  assert.equal(outcome.outcome, "fixed");
  assert.equal(outcome.strikes, 2);
  assert.equal(
    logs.filter((l) => l.step === "fix.stood_down" && l.extra?.site === "rung.report_substituted").length,
    0,
    "the new guard never fires when a real, observed defect is present",
  );
});

// ── W1-T1100 floor is unchanged (claim 6) ───────────────────────────────────────────────────────

test("judgeReview/judgeCriterion (claim 6): a substituted report at FULL keyword coverage still fails — this task changes the disposition, never the floor", () => {
  const diff = [
    "diff --git a/src/lib/proof-grammar.ts b/src/lib/proof-grammar.ts",
    "+++ b/src/lib/proof-grammar.ts",
    "@@",
    "+export function normalizeWhitespace(s: string): string { return s.trim(); }",
  ].join("\n");
  const acceptance: AcceptanceCriterion = {
    claim: "the parser normalizes whitespace",
    proof: "grep: normalizeWhitespace in src/lib/proof-grammar.ts",
  };
  // A worker narrative that echoes the proof's OWN vocabulary — full keyword coverage, the exact
  // fail-open shape the W1-T1100 floor exists to refuse.
  const fullCoverageReport = [
    "REPORT",
    "I added normalizeWhitespace to src/lib/proof-grammar.ts so the grep proof would match cleanly.",
    "PR_URL: https://github.com/o/r/pull/2877",
  ].join("\n");

  const trusted = judgeReview([acceptance], { diff, report: fullCoverageReport, reportIsSubstitute: false });
  assert.equal(trusted.criteria[0].met, true, "control: a genuinely fetched body at full coverage substantiates the proof");

  const substituted = judgeReview([acceptance], {
    diff,
    report: fullCoverageReport,
    reportIsSubstitute: true,
    reportSubstituteCause: { kind: "never-fetched", fixMode: "reviewer-unmet" },
  });
  assert.equal(substituted.state, "failure", "coverage 6-of-6-shaped or not, a substitute still fails the review");
  assert.equal(substituted.criteria[0].met, false, "full keyword coverage over a substitute is still withheld as substantiation");
  assert.doesNotMatch(substituted.criteria[0].reason, /substantiated/, "the reason never claims substantiation for a substitute");

  const tokenize = (s: string) =>
    s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const reportTokens = new Set(tokenize(fullCoverageReport));
  const direct = judgeCriterion(acceptance, reportTokens, undefined, undefined, true, undefined, {
    kind: "never-fetched",
    fixMode: "reviewer-unmet",
  });
  assert.equal(direct.met, false);
  assert.match(direct.reason, /the PR body was NOT read/, 'the reason names the structured cause, not a generic "unmet"');
});
