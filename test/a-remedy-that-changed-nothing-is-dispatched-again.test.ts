/**
 * W1-T3309 — an unchanged remedy is evidence, not a reason to try again.
 *
 * These fixtures drive both ledger producers: an ordinary `fix.dispatch` records the claims it
 * targeted, while a Rule-25 prerequisite dispatch records its two path sets without spending a
 * normal strike. The sweep may escalate only when the current cause exactly repeats one of those
 * recorded causes; neither timestamps nor pass counts participate.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildOpenPrViews, deriveStrikeHistory, runFixRung } from "../src/run-task.js";
import {
  DEFAULT_SWEEP_POLICY,
  deriveDisposition,
  runSweep,
  type OpenPrView,
  type SweepDeps,
} from "../src/lib/sweep.js";
import { reviewInputDigest, type CriterionVerdict, type ReviewVerdict } from "../src/lib/review.js";
import type { Config } from "../src/lib/config.js";
import type { WorkerResult } from "../src/lib/worker.js";

const TASK_ID = "W1-T3309-FIXTURE";
const PR_URL = "https://github.com/craigoley/remudero/pull/3309";
const BODY = `Remudero-Task: ${TASK_ID}`;
const CURRENT_HEAD = "cccccccccccccccccccccccccccccccccccccccc";
const PRIOR_HEAD = "pppppppppppppppppppppppppppppppppppp";
const NOW = Date.parse("2026-09-10T12:00:00.000Z");
const INSTRUMENT_PATHS = ["scripts/coverage-ratchet.mjs"];
const SRC_PATHS = ["src/lib/sweep.ts"];

function criterion(claim = "the implementation is complete"): CriterionVerdict {
  return { claim, proof: "unit test", met: false, reason: "still missing", proof_exec: "executed_fail" };
}

function ordinaryReview(state: "failure" | "success", headSha = CURRENT_HEAD): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return {
    state,
    criteria: state === "failure" ? [criterion()] : [{ ...criterion(), met: true, proof_exec: "executed_pass" }],
    testTheater: false,
    summary: state,
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    headSha,
    reviewerOutcome: "success",
  };
}

function entangledReview(headSha = CURRENT_HEAD): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return {
    state: "failure",
    criteria: [],
    testTheater: false,
    summary: "entangled: instrument path(s) changed alongside src/ path(s)",
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    instrumentEntangled: true,
    instrumentEntanglementPaths: { instrumentPaths: INSTRUMENT_PATHS, srcPaths: SRC_PATHS },
    headSha,
    reviewerOutcome: "success",
  };
}

function workerResult(report = "implemented"): WorkerResult {
  return {
    sessionId: "worker-session",
    costUsd: 0,
    numTurns: 1,
    text: report,
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "sonnet",
    effort: "medium",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
  };
}

function reviewRow(paths = { instrumentPaths: INSTRUMENT_PATHS, srcPaths: SRC_PATHS }): Record<string, unknown> {
  return {
    step: "review.posted",
    task_id: TASK_ID,
    pr_url: PR_URL,
    head_sha: CURRENT_HEAD,
    review_input_digest: reviewInputDigest(CURRENT_HEAD, BODY),
    state: "failure",
    failure_class: "instrument_entangled",
    unmet_criteria: [],
    reasons: [],
    decision_verdict: { state: "failure", instrumentEntangled: true, instrumentEntanglementPaths: paths },
  };
}

function boardView(rows: Record<string, unknown>[]): { view: OpenPrView; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1-t3309-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const [view] = buildOpenPrViews("craigoley", "remudero", ledgerPath, {
    fetch: (args: string[]): unknown => {
      const path = args.at(-1) ?? "";
      if (/state=open/.test(path)) {
        return [{
          number: 3309,
          html_url: PR_URL,
          head: { ref: `run-${TASK_ID}-1`, sha: CURRENT_HEAD },
          updated_at: "2026-09-10T11:59:00.000Z",
          body: BODY,
          auto_merge: null,
          state: "open",
        }];
      }
      if (/check-runs/.test(path)) return { check_runs: [{ name: "ci-gate", status: "completed", conclusion: "success" }] };
      if (/commits\/.+\/status/.test(path)) return { statuses: [{ context: "remudero-review", state: "failure" }] };
      if (/\/pulls\/3309$/.test(path)) return { mergeable: true, mergeable_state: "clean" };
      return [];
    },
    requiredContexts: () => ["ci-gate"],
    readCiGateRequired: () => ["ci-gate"],
    fetchCiFailureEvidence: () => [],
  });
  assert.ok(view, "the fake REST gateway produced the target PR");
  return { view, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function sweepDeps(): SweepDeps & { dispatched: OpenPrView[]; escalated: OpenPrView[] } {
  const dispatched: OpenPrView[] = [];
  const escalated: OpenPrView[] = [];
  return {
    dispatched,
    escalated,
    arm: async () => {},
    close: async () => {},
    dispatchFix: async (pr) => { dispatched.push(pr); },
    escalate: async (pr) => { escalated.push(pr); },
    ledgerPath: join(mkdtempSync(join(tmpdir(), "rmd-w1-t3309-sweep-")), "ledger.ndjson"),
    runId: "SWEEP-W1-T3309",
    now: () => NOW,
  };
}

test("an ordinary fix.dispatch records its claim set, and its first exact recurrence escalates before the cap", async () => {
  const lines: Array<Record<string, unknown>> = [];
  await runFixRung({
    taskId: TASK_ID,
    runId: "W1-T3309-ordinary",
    task: { id: TASK_ID, title: "ordinary claim-set producer" },
    prUrl: PR_URL,
    branch: `run-${TASK_ID}-ordinary`,
    worktreePath: process.cwd(),
    initialSessionId: "author-session",
    mount: { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 20_000 },
    settingsFile: "/tmp/rmd-w1-t3309-settings.json",
    config: {} as Config,
    budgetUsd: 1,
    strikeCap: 2,
    initialReview: ordinaryReview("failure"),
    reviewBase: { owner: "craigoley", repo: "remudero", headCheckoutDir: process.cwd(), reviewerMount: { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 20_000 } },
    deps: {
      spawn: async () => workerResult(),
      waitForCiGreen: async () => "green",
      runReview: async () => ordinaryReview("success"),
      push: () => {},
      issues: { create: () => "https://github.com/craigoley/remudero/issues/3309" },
      ledgerPath: "/tmp/rmd-w1-t3309-ordinary-ledger.ndjson",
      log: (step: string, extra?: Record<string, unknown>) => lines.push({ task_id: TASK_ID, step, ...(extra ?? {}) }),
      say: () => {},
      account: (result: WorkerResult) => result,
    },
  });

  assert.deepEqual(lines.find((line) => line.step === "fix.dispatch")?.unmet_claims, [criterion().claim]);
  const history = deriveStrikeHistory(lines, TASK_ID, CURRENT_HEAD);
  assert.deepEqual(history[0]?.unmetClaims, [criterion().claim], "the ledger reader restores the producer's exact claim set");
  const repeated: OpenPrView = {
    prNumber: 3309,
    prUrl: PR_URL,
    taskId: TASK_ID,
    reviewState: "failure",
    checksState: "green",
    unmetCriteria: [criterion()],
    priorStrikes: 1,
    strikeHistory: history,
    lastActivityAt: "2026-09-10T11:59:00.000Z",
    headSha: CURRENT_HEAD,
    autoMergeArmed: false,
  };
  const disposition = deriveDisposition(repeated, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(disposition.disposition, "blocked-ambiguous");
  assert.match(disposition.reason, /identical unmet criteria/);
});

test("the first exact Rule-25 recurrence escalates from structured paths, even after a new head", async () => {
  const { view, cleanup } = boardView([
    {
      step: "fix.instrument_entangled",
      task_id: TASK_ID,
      pr_url: PR_URL,
      head_sha: PRIOR_HEAD,
      instrument_paths: INSTRUMENT_PATHS,
      src_paths: SRC_PATHS,
    },
    reviewRow(),
  ]);
  try {
    assert.deepEqual(view.previousInstrumentEntanglementPaths, { instrumentPaths: INSTRUMENT_PATHS, srcPaths: SRC_PATHS });
    const disposition = deriveDisposition(view, DEFAULT_SWEEP_POLICY, NOW);
    assert.equal(disposition.disposition, "blocked-ambiguous", "no elapsed time or recurrence count is consulted");
    const deps = sweepDeps();
    await runSweep([view], deps, DEFAULT_SWEEP_POLICY);
    assert.equal(deps.dispatched.length, 0, "a proven-ineffective prerequisite remedy is not re-dispatched");
    assert.equal(deps.escalated.length, 1, "the first exact recurrence is visible to an operator");
  } finally {
    cleanup();
  }
});

test("a first or changed Rule-25 cause remains fixable", () => {
  const first = boardView([reviewRow()]);
  const changed = boardView([
    {
      step: "fix.instrument_entangled",
      task_id: TASK_ID,
      pr_url: PR_URL,
      instrument_paths: INSTRUMENT_PATHS,
      src_paths: SRC_PATHS,
    },
    reviewRow({ instrumentPaths: ["scripts/other-ratchet.mjs"], srcPaths: SRC_PATHS }),
  ]);
  try {
    assert.equal(deriveDisposition(first.view, DEFAULT_SWEEP_POLICY, NOW).disposition, "blocked-fixable", "a first refusal still dispatches");
    assert.equal(deriveDisposition(changed.view, DEFAULT_SWEEP_POLICY, NOW).disposition, "blocked-fixable", "a changed refusal is not a repeat");
  } finally {
    first.cleanup();
    changed.cleanup();
  }
});

test("the first entanglement records its structured cause but opens a prerequisite with zero ordinary strikes", async () => {
  const lines: Array<Record<string, unknown>> = [];
  const outcome = await runFixRung({
    taskId: TASK_ID,
    runId: "W1-T3309-entangled",
    task: { id: TASK_ID, title: "Rule-25 producer" },
    prUrl: PR_URL,
    branch: `run-${TASK_ID}-entangled`,
    worktreePath: process.cwd(),
    initialSessionId: "author-session",
    mount: { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 20_000 },
    settingsFile: "/tmp/rmd-w1-t3309-settings.json",
    config: {} as Config,
    budgetUsd: 1,
    strikeCap: 2,
    initialReview: entangledReview(),
    reviewBase: { owner: "craigoley", repo: "remudero", headCheckoutDir: process.cwd(), reviewerMount: { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 20_000 } },
    deps: {
      spawn: async () => workerResult("REPORT\nPR_URL: https://github.com/craigoley/remudero/pull/9001"),
      waitForCiGreen: async () => "green",
      readPrerequisiteState: async () => ({ ok: true, state: "OPEN" }) as never,
      runReview: async () => { throw new Error("an open prerequisite parks before ordinary review"); },
      push: () => { throw new Error("the entangled branch is not pushed in place"); },
      issues: { create: () => { throw new Error("a healthy prerequisite does not escalate"); } },
      ledgerPath: "/tmp/rmd-w1-t3309-entangled-ledger.ndjson",
      log: (step: string, extra?: Record<string, unknown>) => lines.push({ task_id: TASK_ID, step, ...(extra ?? {}) }),
      say: () => {},
      account: (result: WorkerResult) => result,
      ledgerLines: () => [],
      updateBranch: () => { throw new Error("an open prerequisite is not rebased"); },
    },
  } as never);

  assert.equal(outcome.outcome, "parked");
  assert.equal(outcome.strikes, 0);
  assert.deepEqual(lines.find((line) => line.step === "fix.instrument_entangled"), {
    task_id: TASK_ID,
    step: "fix.instrument_entangled",
    strike: 0,
    pr_url: PR_URL,
    head_sha: CURRENT_HEAD,
    summary: "entangled: instrument path(s) changed alongside src/ path(s)",
    instrument_paths: INSTRUMENT_PATHS,
    src_paths: SRC_PATHS,
  });
  assert.equal(lines.some((line) => line.step === "fix.dispatch"), false, "the structural arm spends no ordinary strike");
});
