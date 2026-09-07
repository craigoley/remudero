/**
 * W1-T2674: when the checks rollup says a PR is red but the ci-log miner enumerates no failing
 * checks, the fix rung's local stand-down is correct but incomplete unless it ledgers the
 * disagreement as its own finding.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildFixRungDispatchArgs, runFixRung } from "../src/run-task.js";
import type { CiFailure } from "../src/lib/sweep.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
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

function ciLogInitialReview(headSha = "deadbeef"): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return {
    state: "failure",
    criteria: [],
    testTheater: false,
    summary: "sweep-reconstructed: required checks red (0 failing check(s)) - ci-log dispatch",
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    headSha,
    reviewerOutcome: "sweep-reconstructed-ci-log",
  };
}

const FIX_RUNG_MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

function fixRungBaseOpts(task: { id: string; title: string }) {
  return {
    taskId: task.id,
    runId: `${task.id}-1730000000000`,
    task,
    prUrl: "https://github.com/acme/remudero/pull/2674",
    branch: `run-${task.id}-1730000000000`,
    worktreePath: "/tmp/rmd-fixrung-red-no-enumerable-wt",
    initialSessionId: "",
    mount: FIX_RUNG_MOUNT,
    settingsFile: "/tmp/rmd-fixrung-red-no-enumerable-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: "/tmp/rmd-fixrung-red-no-enumerable-wt", reviewerMount: FIX_RUNG_MOUNT },
  };
}

function tmpLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-fixrung-red-no-enumerable-")), "ledger.ndjson");
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

test("runFixRung: a red rollup with zero enumerable failing checks writes one disagreement row carrying the rollup and miner sides, and spends no strike", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts({ id: "W1-T2674A", title: "record red rollup with no ci failures" }),
    strikeCap: 3,
    initialReview: ciLogInitialReview(),
    ciFailures: [],
    ciEvidenceDisagreement: {
      rollup: { checks_state: "red", red_checks: ["ci-gate"] },
      miner: { enumerable_failures: [] },
    },
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `fix-session-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => {
        throw new Error("must never be reached");
      },
      push: () => {
        throw new Error("must never be reached");
      },
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => logs.push({ step, extra }),
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(outcome.outcome, "stood_down");
  assert.equal(outcome.strikes, 0, "the stand-down is unchanged: no strike is spent on empty evidence");
  assert.equal(spawnCalls.length, 0, "there is still nothing to hand a fix worker");

  const disagreements = logs.filter((l) => l.step === "fix.ci_evidence_disagreement");
  assert.equal(disagreements.length, 1, "the disagreement is ledgered as its own countable row");
  assert.deepEqual(disagreements[0].extra?.rollup, { checks_state: "red", red_checks: ["ci-gate"] });
  assert.deepEqual(disagreements[0].extra?.miner, { enumerable_failures: [] });
  assert.equal(disagreements[0].extra?.site, "rung.empty_ci_failures");
  assert.equal(disagreements[0].extra?.strike, 1);

  const reason = String(disagreements[0].extra?.reason ?? "");
  assert.match(reason, /zero enumerable failing check/);
  assert.match(reason, /nothing to hand a fix worker/);
  assert.equal(reason, logs.find((l) => l.step === "fix.stood_down")?.extra?.reason, "the row reason comes from this stand-down decision");
  assert.equal(logs.filter((l) => l.step === "fix.dispatch").length, 0, "fix.dispatch is still absent, so no strike is counted");
});

test("buildFixRungDispatchArgs: the red rollup side is carried to the rung beside the miner side", () => {
  const args = buildFixRungDispatchArgs({
    task: { id: "W1-T2674B", title: "record red rollup with no ci failures" },
    runId: "SWEEP-1730000000000",
    prUrl: "https://github.com/acme/remudero/pull/2674",
    branch: "run-W1-T2674B-1730000000000",
    worktreePath: "/tmp/rmd-dispatch-wt",
    mount: FIX_RUNG_MOUNT,
    settingsFile: "/tmp/rmd-dispatch-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    strikeCap: 2,
    evidence: { unmetCriteria: [], ciFailures: [] },
    pr: { headSha: "cafe1234", checksState: "red", redRequiredChecks: ["ci-gate"] },
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: "/tmp/rmd-dispatch-wt", reviewerMount: FIX_RUNG_MOUNT },
  });

  assert.deepEqual(args.ciEvidenceDisagreement?.rollup, { checks_state: "red", red_checks: ["ci-gate"] });
  assert.deepEqual(args.ciEvidenceDisagreement?.miner, { enumerable_failures: [] });
});

test("runFixRung: a red PR whose failing checks are enumerable dispatches normally and writes no disagreement row", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const failures: CiFailure[] = [{ name: "ci", logTail: "Error: build failed" }];

  const outcome = await runFixRung({
    ...fixRungBaseOpts({ id: "W1-T2674C", title: "dispatch enumerable ci failures" }),
    strikeCap: 3,
    initialReview: ciLogInitialReview(),
    ciFailures: failures,
    ciEvidenceDisagreement: {
      rollup: { checks_state: "red", red_checks: ["ci"] },
      miner: { enumerable_failures: failures.map((f) => ({ name: f.name })) },
    },
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `fix-session-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => ({
        ...ciLogInitialReview("sha-1"),
        state: "success",
        criteria: [criterion({ claim: "required checks are green", met: true })],
      }),
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => logs.push({ step, extra }),
      say: () => {},
      account: (r) => r,
    },
  });

  assert.equal(outcome.outcome, "fixed");
  assert.equal(outcome.strikes, 1);
  assert.equal(spawnCalls.length, 1, "enumerable evidence still dispatches exactly as before");
  assert.equal(logs.filter((l) => l.step === "fix.ci_evidence_disagreement").length, 0);
  assert.equal(logs.filter((l) => l.step === "fix.dispatch").length, 1);
});
