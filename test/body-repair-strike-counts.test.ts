/**
 * test/body-repair-strike-counts.test.ts — W1-T2306.
 *
 * THE DEFECT. `fix.dispatch` has TWO writers in run-task.ts: the ordinary strike (near the
 * bottom of `runFixRung`) and the body-repair arm (W1-T2272, `rung.strike` site, BEFORE any
 * commit). Only the ordinary writer tagged `verdict_regime`. `strikeRegimeOf` reads an absent
 * tag as `"keyword_only"` BY CONSTRUCTION — not a decision anyone made — and `priorStrikesFor`
 * amnesties every `"keyword_only"`-tagged row the instant the task's CURRENT regime (from the
 * latest `review.posted` line, `currentStrikeRegimeFor`) is `"executed"`. So an untagged
 * body-repair strike vanished from the count forever once any review executed a proof,
 * however many body-repair strikes had actually been spent.
 *
 * THE FIX. The body-repair writer now tags `verdict_regime` with the SAME computation the
 * ordinary writer already used (W1-T199): `"executed"` if the in-scope review's criteria show
 * any `proof_exec !== "not_executable"`, else `"keyword_only"`. W1-T2788 additionally stamps
 * `head_sha` from the review this repair targeted, so a later PR head gets a fresh bounded
 * allowance without changing this regime amnesty.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { priorStrikesFor, strikeRegimeOf, runFixRung } from "../src/run-task.js";
import { fixStrikeCap } from "../src/lib/config.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import type { CiFailure } from "../src/lib/sweep.js";
import type { Config } from "../src/lib/config.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";

/** No `## Acceptance`/`Acceptance:` header and no `Remudero-Task:` trailer anywhere — byte-
 *  identical to test/acceptance-gate-body-repair.test.ts's own fixture, so this shard drives the
 *  SAME repairable defect, not a bespoke one. */
const NO_HEADER_BODY = "This PR fixes the thing.\n\nSee the diff for details.\n";

const AUTHOR_GATE_CI_FAILURE: CiFailure = { name: "acceptance-author-gate", logTail: "REFUSED (no-header)" };

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

function fixRungBaseOpts() {
  return {
    taskId: "W1-BR",
    runId: "W1-BR-1730000000000",
    task: { id: "W1-BR", title: "Some task" },
    prUrl: "https://github.com/acme/remudero/pull/2306",
    branch: "run-W1-BR-1730000000000",
    worktreePath: "/tmp/rmd-body-repair-strike-counts-wt",
    initialSessionId: "session-0",
    mount: FIX_RUNG_MOUNT,
    settingsFile: "/tmp/rmd-body-repair-strike-counts-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: "/tmp/rmd-body-repair-strike-counts-wt", reviewerMount: FIX_RUNG_MOUNT },
  };
}

function tmpLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-body-repair-strike-counts-")), "ledger.ndjson");
}

function fakeIssueStore(): IssueGateway & { calls: Array<{ title: string; body: string; labels: string[] }> } {
  let seq = 4000;
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
    comment() {},
  };
}

/** Collects every `log(step, extra)` call, tagging each with the fixed task id — the raw shape
 *  `priorStrikesFor`/`strikeRegimeOf` read. */
function captureLog(taskId = "W1-BR"): {
  lines: Array<{ task_id: string; step: string } & Record<string, unknown>>;
  log: (step: string, extra?: Record<string, unknown>) => void;
} {
  const lines: Array<{ task_id: string; step: string } & Record<string, unknown>> = [];
  return {
    lines,
    log: (step, extra) => lines.push({ task_id: taskId, step, ...(extra ?? {}) }),
  };
}

/** Drives ONE body-repair strike through the real rung and returns the logged lines. `evidence`
 *  controls whether the in-scope review reads as executed or keyword-only, so the SAME helper
 *  produces both regimes a body-repair strike can actually be spent under. */
async function driveBodyRepairStrike(opts: {
  strikeCap: number;
  criteria: CriterionVerdict[];
  captureWorktreeSnapshot?: () => Promise<{ status: string; diff: string; untrackedHash: string }>;
}): Promise<{ lines: Array<{ task_id: string; step: string } & Record<string, unknown>>; outcome: Awaited<ReturnType<typeof runFixRung>> }> {
  const review = fakeReview("failure", opts.criteria);
  const { lines, log } = captureLog();
  const spawnCalls: SpawnWorkerArgs[] = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: opts.strikeCap,
    initialReview: review,
    ciFailures: [AUTHOR_GATE_CI_FAILURE],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: "should-never-run" });
      },
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => [AUTHOR_GATE_CI_FAILURE],
      fetchPrBody: async () => NO_HEADER_BODY,
      updatePrBody: async () => {},
      runReview: async () => review,
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log,
      say: () => {},
      account: (r) => r,
      ...(opts.captureWorktreeSnapshot ? { captureWorktreeSnapshot: opts.captureWorktreeSnapshot } : {}),
    },
  });

  assert.equal(spawnCalls.length, 0, "sanity: this fixture must stay on the body-repair path, never spawn a worker");
  return { lines, outcome };
}

// ── acceptance 1 & 2: every writer tags the regime, and an EXECUTED-regime body repair counts ──

test("W1-T2306 (acceptance 1, 2): a body-repair fix.dispatch row spent while the review executed a proof is tagged verdict_regime:executed, and counts toward the cap", async () => {
  const { lines } = await driveBodyRepairStrike({
    strikeCap: 1,
    criteria: [criterion({ claim: "criterion A merges cleanly", met: false, reason: "r", proof_exec: "executed_fail" })],
  });

  const dispatchLines = lines.filter((l) => l.step === "fix.dispatch");
  assert.equal(dispatchLines.length, 1);
  assert.equal(dispatchLines[0].mode, "body-repair", "sanity: this really is the body-repair writer");
  assert.equal(dispatchLines[0].verdict_regime, "executed", "the body-repair writer must tag the regime, not omit it");
  assert.equal(strikeRegimeOf(dispatchLines[0]), "executed");

  assert.equal(
    priorStrikesFor(lines, "W1-BR", "executed"),
    1,
    "a body-repair strike spent under the executed regime counts toward the cap under that SAME regime — the amnesty must not erase it",
  );
});

// ── acceptance 3: a genuinely keyword-era body-repair strike is still amnestied once the task's
// regime has moved on — the amnesty's original purpose is untouched ──────────────────────────────

test("W1-T2306 (acceptance 3): a body-repair strike spent while every criterion was keyword-only is tagged verdict_regime:keyword_only, and IS amnestied once the current regime is executed", async () => {
  const { lines } = await driveBodyRepairStrike({
    strikeCap: 1,
    criteria: [criterion({ claim: "criterion A merges cleanly", met: false, reason: "r", proof_exec: "not_executable" })],
  });

  const dispatchLines = lines.filter((l) => l.step === "fix.dispatch");
  assert.equal(dispatchLines[0].verdict_regime, "keyword_only");

  assert.equal(
    priorStrikesFor(lines, "W1-BR", "executed"),
    0,
    "a keyword-era body-repair strike is amnestied once the task's own regime has converged on executed evidence — the amnesty's purpose survives",
  );
  assert.equal(
    priorStrikesFor(lines, "W1-BR", "keyword_only"),
    1,
    "the SAME strike still counts under the keyword_only regime — nothing is EVER erased from the ledger, only read differently",
  );
});

// ── acceptance 4: exact input-head attribution ─────────────────────────────────────────────────

test("W1-T2788: the body-repair fix.dispatch row records its exact input head and only counts for that head", async () => {
  const { lines: strike1 } = await driveBodyRepairStrike({
    strikeCap: 1,
    criteria: [criterion({ claim: "criterion A", met: false, reason: "r", proof_exec: "executed_fail" })],
  });
  const dispatchLine = strike1.find((l) => l.step === "fix.dispatch")!;
  assert.equal(dispatchLine.sha, undefined, "the legacy ambiguous field spelling stays absent");
  assert.equal(dispatchLine.head_sha, "deadbeef", "the body-only repair targets the initial review head exactly");

  // Two tagged rows for the same task belong to different head generations.
  const rows = [
    { task_id: "W1-BR", step: "fix.dispatch", verdict_regime: "executed", head_sha: "aaa" },
    { task_id: "W1-BR", step: "fix.dispatch", verdict_regime: "executed", head_sha: "bbb" },
  ];
  assert.equal(priorStrikesFor(rows, "W1-BR", "executed", "aaa"), 1);
  assert.equal(priorStrikesFor(rows, "W1-BR", "executed", "bbb"), 1);
});

// ── acceptance 5: the falsifier — remove the tag again, and the count reverts to the original
// defect (zero at two strikes) ─────────────────────────────────────────────────────────────────

test("W1-T2306 (acceptance 5, falsifier): two UNTAGGED body-repair rows (simulating a reverted fix) score ZERO under the executed regime, reproducing the original defect", () => {
  const untaggedRows = [
    { task_id: "W1-BR", step: "fix.dispatch", strike: 1, strike_cap: 2, unmet_count: 0, round: "resume", mode: "body-repair", defect: "no-header" },
    { task_id: "W1-BR", step: "fix.dispatch", strike: 2, strike_cap: 2, unmet_count: 0, round: "fresh", mode: "body-repair", defect: "no-header" },
  ];
  assert.equal(strikeRegimeOf(untaggedRows[0]), "keyword_only", "an untagged row grades keyword-only BY CONSTRUCTION");
  assert.equal(
    priorStrikesFor(untaggedRows, "W1-BR", "executed"),
    0,
    "THE FALSIFIER: with the tag removed, two spent strikes are amnestied down to zero — this is the defect this task closes",
  );
  // ...and a THIRD untagged strike changes nothing — the rationale's own "three score zero too".
  const threeUntagged = [...untaggedRows, { task_id: "W1-BR", step: "fix.dispatch", strike: 3, strike_cap: 2, unmet_count: 0, round: "fresh", mode: "body-repair", defect: "no-header" }];
  assert.equal(priorStrikesFor(threeUntagged, "W1-BR", "executed"), 0, "three untagged strikes score zero too, exactly as the rationale measures");
});

// ── acceptance 6: the unchanged-tree stand-down is untouched, and still fires within ONE strike ─

test("W1-T2306 (acceptance 6): the unchanged-tree stand-down still fires after a single body-repair strike, unmodified by the regime tag", async () => {
  const noReviewYet = fakeReview("failure", []);
  const spawnCalls: SpawnWorkerArgs[] = [];
  const updateCalls: string[] = [];
  const unchangedSnapshot = { status: "", diff: "", untrackedHash: "h1" };

  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 3,
    initialReview: noReviewYet,
    ciFailures: [AUTHOR_GATE_CI_FAILURE],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: "should-never-run" });
      },
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => [AUTHOR_GATE_CI_FAILURE],
      fetchPrBody: async () => NO_HEADER_BODY,
      updatePrBody: async (_prUrl, body) => {
        updateCalls.push(body);
      },
      runReview: async () => noReviewYet,
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      readLiveState: async () => ({ ok: true, state: "OPEN" }),
      captureWorktreeSnapshot: async () => unchangedSnapshot,
    },
  });

  assert.equal(updateCalls.length, 1, "the body-only write happens ONCE — the very next round's unchanged-tree gate refuses before a repeat");
  assert.equal(spawnCalls.length, 0);
  assert.equal(outcome.strikes, 1, "the stand-down fires WITHIN a single strike, exactly as before this task");
  assert.equal(outcome.outcome, "stood_down");
  assert.match(outcome.standDownReason ?? "", /byte-identical/);
});

// ── acceptance 7: the ceiling is still two, and no policy default moved ────────────────────────

test("W1-T2306 (acceptance 7): the fix-strike ceiling defaults to 2 and no policy default was raised to compensate for the counter now counting", () => {
  assert.equal(fixStrikeCap({} as Config), 2, "the cap default is untouched — a counter that starts counting must not be compensated for by raising the ceiling");
});

// ── acceptance 8: no wait, retry cadence or backoff was added to any dispatch path ─────────────

test("W1-T2306 (acceptance 8): two consecutive body-repair strikes (strikeCap 2, tree changing each round) complete with no injected wait — a real backoff would show up as elapsed wall-clock time", async () => {
  let round = 0;
  const review = fakeReview("failure", [criterion({ claim: "criterion A", met: false, reason: "r", proof_exec: "executed_fail" })]);
  const { lines, log } = captureLog();
  const issues = fakeIssueStore();

  const start = Date.now();
  const outcome = await runFixRung({
    ...fixRungBaseOpts(),
    strikeCap: 2,
    initialReview: review,
    ciFailures: [AUTHOR_GATE_CI_FAILURE],
    deps: {
      spawn: async () => {
        throw new Error("must never be called — this fixture stays on the body-repair path for both rounds");
      },
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => [AUTHOR_GATE_CI_FAILURE],
      fetchPrBody: async () => NO_HEADER_BODY,
      updatePrBody: async () => {},
      runReview: async () => review,
      push: () => {
        throw new Error("must never be called");
      },
      issues,
      ledgerPath: tmpLedgerPath(),
      log,
      say: () => {},
      account: (r) => r,
      // A fresh, DISTINCT untracked hash every call — never a stand-down — so the rung actually
      // runs the body-repair arm TWICE, back to back, up to the strike cap.
      captureWorktreeSnapshot: async () => ({ status: "", diff: "", untrackedHash: `h${++round}` }),
    },
  });
  const elapsedMs = Date.now() - start;

  const dispatchLines = lines.filter((l) => l.step === "fix.dispatch");
  assert.equal(dispatchLines.length, 2, "both strikes of the cap were spent on the body-repair arm");
  assert.equal(outcome.strikes, 2);
  assert.equal(outcome.outcome, "escalated", "the cap's own exhaustion path fires with no wait involved");
  assert.ok(
    elapsedMs < 2000,
    `two rounds of dispatch completed in ${elapsedMs}ms with no injected sleep/backoff/retry-cadence — a real pacing mechanism would dominate this bound`,
  );
});
