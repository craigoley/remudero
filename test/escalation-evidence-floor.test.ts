/**
 * test/escalation-evidence-floor.test.ts — W1-T487.
 *
 * THE DEFECT. `runFixRung`'s exhaustion escalate() builds its `detail` for all three modes
 * (conflicted / blocked_ci / blocked_review) with a bare `(list ?? []).map(...).join("\n")`
 * after a heading (`Conflicting file(s):` / `Failing check(s):` / `Unmet criteria:`). Nothing
 * checked the list's length first, so a rung that exhausts with an empty evidence list renders
 * a heading, a blank line, and nothing else — the one artifact a human reads to decide what
 * broke names a cause and supplies zero instances.
 *
 * THE FIX is a rendering floor ONLY (`renderEscalationEvidence`, src/run-task.ts): every arm now
 * says "(no evidence — ...)" instead of nothing, and distinguishes the two ways a list can be
 * empty — never collected for this rung at all, versus collected and genuinely empty. NO
 * dispatch/trigger condition changes; every scenario below still ends in `outcome: "escalated"`
 * with exactly one issue filed, proving the empty case is never suppressed.
 *
 * NO GATEWAY IS REACHED HERE: `deps.spawn`/`deps.issues`/`deps.waitForCiGreen`/`deps.runReview`
 * are all injected fakes; nothing on this file's path shells out to `gh` or a worker.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runFixRung } from "../src/run-task.js";
import type { CiFailure, MergeConflictEvidence } from "../src/lib/sweep.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { Mount } from "../src/lib/mounts.js";
import type { Config } from "../src/lib/config.js";
import type { WorkerResult } from "../src/lib/worker.js";

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

function fixRungBaseOpts() {
  return {
    taskId: "W1-TX",
    runId: "W1-TX-1730000000000",
    task: { id: "W1-TX", title: "Some task" },
    prUrl: "https://github.com/acme/remudero/pull/1",
    branch: "run-W1-TX-1730000000000",
    worktreePath: "/tmp/rmd-fixrung-wt",
    initialSessionId: "session-0",
    mount: FIX_RUNG_MOUNT,
    settingsFile: "/tmp/rmd-fixrung-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: "/tmp/rmd-fixrung-wt", reviewerMount: FIX_RUNG_MOUNT },
  };
}

function tmpLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-escfloor-")), "ledger.ndjson");
}

function fakeIssues(calls: Array<{ title: string; body: string; labels: string[] }>): IssueGateway {
  return {
    create(title, body, labels) {
      calls.push({ title, body, labels });
      return "https://github.com/acme/remudero/issues/9";
    },
  };
}

// ── (1) CONFLICT ARM ─────────────────────────────────────────────────────────

test("runFixRung: a conflicted exhaustion with REAL conflicting files renders every one, unchanged from today", async () => {
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  const mergeConflict: MergeConflictEvidence = {
    files: [{ path: "src/x.ts", oursDeleted: 0, theirsDeleted: 0 }, { path: "src/y.ts", oursDeleted: 0, theirsDeleted: 0 }],
    oursLog: "abc1234 add entry A",
    theirsLog: "def5678 add entry B",
  };
  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 1,
    initialReview: fakeReview("failure", []),
    mergeConflict,
    deps: {
      spawn: async () => result(),
      waitForCiGreen: async () => "red",
      runReview: async () => {
        throw new Error("runReview must never be called — the merge state never resolved");
      },
      push: () => {},
      issues: fakeIssues(issueCalls),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(outcome.outcome, "escalated");
  assert.equal(issueCalls.length, 1);
  assert.match(issueCalls[0].body, /Conflicting file\(s\):\n\n- src\/x\.ts\n- src\/y\.ts/, "unchanged rendering for a real list");
  assert.doesNotMatch(issueCalls[0].body, /no evidence/);
});

test("runFixRung: a conflicted exhaustion with an EMPTY conflicting-file list says so in words, and still escalates", async () => {
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  const mergeConflict: MergeConflictEvidence = { files: [], oursLog: "abc1234 add entry A", theirsLog: "def5678 add entry B" };
  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 1,
    initialReview: fakeReview("failure", []),
    mergeConflict,
    deps: {
      spawn: async () => result(),
      waitForCiGreen: async () => "red",
      runReview: async () => {
        throw new Error("runReview must never be called — the merge state never resolved");
      },
      push: () => {},
      issues: fakeIssues(issueCalls),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(outcome.outcome, "escalated", "an empty evidence list is never suppressed — it still escalates");
  assert.equal(issueCalls.length, 1);
  assert.doesNotMatch(
    issueCalls[0].body,
    /Conflicting file\(s\):\n\n\n/,
    "never a bare heading with nothing after it",
  );
  assert.match(
    issueCalls[0].body,
    /Conflicting file\(s\):\n\n\(no evidence — this was checked and is empty\)/,
    "names the cause in words: the conflict evidence was collected, and IS empty",
  );
});

// ── (2) BLOCKED_CI ARM ───────────────────────────────────────────────────────

test("runFixRung: a blocked_ci exhaustion with REAL failing checks renders every one, unchanged from today", async () => {
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  const ciFailures: CiFailure[] = [{ name: "typecheck", logTail: "tsc: error TS2322" }];
  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 1,
    initialReview: fakeReview("failure", []),
    ciFailures,
    deps: {
      spawn: async () => result(),
      waitForCiGreen: async () => "red",
      runReview: async () => {
        throw new Error("runReview must never be called — CI never went green");
      },
      push: () => {},
      issues: fakeIssues(issueCalls),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(outcome.outcome, "escalated");
  assert.equal(issueCalls.length, 1);
  assert.match(issueCalls[0].body, /Failing check\(s\):\n\n- typecheck — tsc: error TS2322/, "unchanged rendering for a real list");
  assert.doesNotMatch(issueCalls[0].body, /no evidence/);
});

test("runFixRung: a blocked_ci exhaustion whose failing-check list was CHECKED AND IS EMPTY (fetched, zero rows) says so, distinct from never-collected, and still escalates", async () => {
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 1,
    initialReview: fakeReview("failure", []),
    // W1-T1282: round 1 must start with REAL evidence — a genuinely empty `ciFailures` now
    // stands the rung down BEFORE any strike (the two-reader-split guard this task adds), which
    // this file's own concern (the ESCALATION's rendering, once one is reached) never disputes.
    // Round 1 dispatches on this real check, then its post-strike refresh (`fetchCiFailures`
    // below) is what goes empty — the SAME "checked and is empty" shape, discovered mid-rung
    // rather than at round 1, and still reachable because the loop exits (strikeCap 1) before
    // this guard's next top-of-round check would otherwise catch it too.
    ciFailures: [{ name: "ci", logTail: "irrelevant — round 1 dispatches on this" }],
    deps: {
      spawn: async () => result(),
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => [], // opts.ciFailures !== undefined — the list WAS collected, and is empty
      runReview: async () => {
        throw new Error("runReview must never be called — CI never went green");
      },
      push: () => {},
      issues: fakeIssues(issueCalls),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(outcome.outcome, "escalated", "an empty evidence list is never suppressed — it still escalates");
  assert.equal(issueCalls.length, 1);
  assert.doesNotMatch(issueCalls[0].body, /Failing check\(s\):\n\n\n/, "never a bare heading with nothing after it");
  assert.match(
    issueCalls[0].body,
    /Failing check\(s\):\n\n\(no evidence — this was checked and is empty\)/,
    "names the cause in words: checked, genuinely empty",
  );
});

test("runFixRung: a blocked_ci exhaustion whose failing-check list was NEVER COLLECTED (a later strike regressed CI with no fetchCiFailures dep) says so, distinct from checked-and-empty, and still escalates", async () => {
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  // Starts as an ORDINARY blocked_review dispatch (no opts.ciFailures at all — see run-task.ts's
  // own `noReviewYet = opts.ciFailures !== undefined`), so the first strike's escaped push
  // regresses CI (waitForCiGreen -> "red"), flipping `noReviewYet` true mid-rung while
  // `currentCiFailures` is never assigned by anything (no `fetchCiFailures` dep supplied) — the
  // exact "no evidence collected" shape run-task.ts's own W1-T226 comment documents.
  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 1,
    initialReview: fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: false, reason: "still broken" })]),
    deps: {
      spawn: async () => result(),
      waitForCiGreen: async () => "red",
      runReview: async () => {
        throw new Error("runReview must never be called — CI regressed before any review could run");
      },
      push: () => {},
      issues: fakeIssues(issueCalls),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(outcome.outcome, "escalated", "an empty evidence list is never suppressed — it still escalates");
  assert.equal(issueCalls.length, 1);
  assert.match(issueCalls[0].title, /blocked_ci/, "the regression re-routes the exhaustion to blocked_ci framing");
  assert.doesNotMatch(issueCalls[0].body, /Failing check\(s\):\n\n\n/, "never a bare heading with nothing after it");
  assert.match(
    issueCalls[0].body,
    /Failing check\(s\):\n\n\(no evidence — this was never collected for this rung\)/,
    "names the cause in words: never collected, NOT merely checked-and-empty",
  );
});

// ── (3) BLOCKED_REVIEW ARM ───────────────────────────────────────────────────

test("runFixRung: a blocked_review exhaustion with REAL unmet criteria renders every one, unchanged from today", async () => {
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  const stillFailing = fakeReview("failure", [
    criterion({ claim: "criterion A merges cleanly", met: false, reason: "still broken" }),
  ]);
  let reviewCalls = 0;
  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 1,
    initialReview: stillFailing,
    deps: {
      spawn: async () => result(),
      waitForCiGreen: async () => "green",
      runReview: async () => {
        reviewCalls++;
        return { ...stillFailing, headSha: `esc-sha-${reviewCalls}` };
      },
      push: () => {},
      issues: fakeIssues(issueCalls),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(outcome.outcome, "escalated");
  assert.equal(issueCalls.length, 1);
  assert.match(
    issueCalls[0].body,
    /Unmet criteria:\n\n- criterion A merges cleanly\n {2}reason: still broken/,
    "unchanged rendering for a real list",
  );
  assert.doesNotMatch(issueCalls[0].body, /no evidence/);
});

test("runFixRung: a blocked_review exhaustion whose criteria were CHECKED AND ARE ALL MET (state still not success) says so, and still escalates", async () => {
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  // review.criteria.length > 0 but every one is met — a real (if unusual) shape: the reviewer
  // failed the PR for a reason OTHER than an unmet criterion (e.g. testTheater/capped), so
  // `unmet` is genuinely empty even though criteria WERE evaluated.
  const allMetButFailing = fakeReview("failure", [criterion({ claim: "criterion A merges cleanly", met: true })]);
  let reviewCalls = 0;
  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 1,
    initialReview: allMetButFailing,
    deps: {
      spawn: async () => result(),
      waitForCiGreen: async () => "green",
      runReview: async () => {
        reviewCalls++;
        return { ...allMetButFailing, headSha: `esc-sha-${reviewCalls}` };
      },
      push: () => {},
      issues: fakeIssues(issueCalls),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(outcome.outcome, "escalated", "an empty evidence list is never suppressed — it still escalates");
  assert.equal(issueCalls.length, 1);
  assert.doesNotMatch(issueCalls[0].body, /Unmet criteria:\n\n\n/, "never a bare heading with nothing after it");
  assert.match(
    issueCalls[0].body,
    /Unmet criteria:\n\n\(no evidence — this was checked and is empty\)/,
    "names the cause in words: checked, genuinely empty",
  );
});

test("runFixRung: a blocked_review exhaustion whose criteria list was NEVER COLLECTED (zero criteria the whole rung) says so, distinct from checked-and-empty, and still escalates", async () => {
  const issueCalls: Array<{ title: string; body: string; labels: string[] }> = [];
  const noCriteriaAtAll = fakeReview("failure", []);
  let reviewCalls = 0;
  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 1,
    initialReview: noCriteriaAtAll,
    deps: {
      spawn: async () => result(),
      waitForCiGreen: async () => "green",
      runReview: async () => {
        reviewCalls++;
        return { ...noCriteriaAtAll, headSha: `esc-sha-${reviewCalls}` };
      },
      push: () => {},
      issues: fakeIssues(issueCalls),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(outcome.outcome, "escalated", "an empty evidence list is never suppressed — it still escalates");
  assert.equal(issueCalls.length, 1);
  assert.match(issueCalls[0].title, /blocked_review/, "zero criteria, real review — this is still blocked_review framing");
  assert.doesNotMatch(issueCalls[0].body, /Unmet criteria:\n\n\n/, "never a bare heading with nothing after it");
  assert.match(
    issueCalls[0].body,
    /Unmet criteria:\n\n\(no evidence — this was never collected for this rung\)/,
    "names the cause in words: never collected, NOT merely checked-and-empty",
  );
});

// ── (4) THE LEDGER STILL RECORDS EXHAUSTION FOR AN EMPTY-EVIDENCE ESCALATION ──

test("runFixRung: an empty-evidence exhaustion still writes the same fix.exhausted + escalation.issue_opened ledger lines as a real-evidence one", async () => {
  const ledgerPath = tmpLedgerPath();
  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 1,
    initialReview: fakeReview("failure", []),
    // W1-T1282: see the sibling test above — round 1 needs real evidence to reach a strike at
    // all under the new zero-enumerable-failures guard; the post-strike refresh is what goes
    // empty here, reaching the SAME exhaustion-with-empty-evidence shape this test targets.
    ciFailures: [{ name: "ci", logTail: "irrelevant — round 1 dispatches on this" }],
    deps: {
      spawn: async () => result(),
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => [],
      runReview: async () => {
        throw new Error("runReview must never be called — CI never went green");
      },
      push: () => {},
      issues: fakeIssues([]),
      ledgerPath,
      log: () => {},
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(outcome.outcome, "escalated");
  const ledgerLines = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(
    ledgerLines.some((l) => l.step === "escalation.issue_opened"),
    "an empty-evidence exhaustion escalates via the SAME escalate.ts mechanism as a real-evidence one",
  );
});
