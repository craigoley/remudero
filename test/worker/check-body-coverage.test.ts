import assert from "node:assert/strict";
import { test } from "node:test";
import { runFixRung } from "#test/helpers/run-task-test.js";
import type { Config } from "#src/lib/config.js";
import type { ReviewVerdict } from "#src/lib/review.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { bodyCoverageSelfHealCriteria, deriveFixMode, renderFixPrompt } from "#src/lib/prompt-render.js";

// Recorded round shape (PR #13946): every unmet reason is a proof-keyword gap, none executed_fail.
const unmet = [{
  claim: "a Claude login that cannot reach the fleet store answers unavailable and creates nothing",
  proof: "unit test: W1-T10511: a Claude login that cannot reach the fleet store answers unavailable",
  met: false,
  reason: "matched 0/6 proof keywords in the report",
  proof_exec: "not_executable" as const,
  criterionIndex: 1,
}];

test("W1-T10661: a recorded body-coverage round is self-healed with a paste-ready Acceptance block", () => {
  const evidence = { review: { unmetCriteria: unmet, summary: "keyword gap" } };
  assert.equal(deriveFixMode(evidence), "body-coverage");
  assert.deepEqual(bodyCoverageSelfHealCriteria(evidence, [{ claim: unmet[0].claim, proof: unmet[0].proof }]), [
    { claim: unmet[0].claim, proof: unmet[0].proof },
  ]);
  assert.equal(bodyCoverageSelfHealCriteria(evidence, [{ claim: unmet[0].claim, proof: "an unprefixed proof" }]), undefined);
  const prompt = renderFixPrompt({ task: { id: "W1-T10511", title: "t" }, round: 1, branch: "run-W1-T10511-1", evidence });
  assert.match(prompt, /Paste-ready PR body Acceptance block/);
  assert.ok(prompt.includes(`- Criterion 1: ${unmet[0].claim} — proven by ${unmet[0].proof}`));
});

test("W1-T10661 criterion 1: a recorded body-coverage round repairs the live Acceptance block before any fix worker dispatch", async () => {
  const headSha = "a".repeat(40);
  const body = "The implementation is ready.\n\nRemudero-Task: W1-T10511\n";
  const updates: string[] = [];
  const spawns: unknown[] = [];
  const rows: Array<{ step: string; [key: string]: unknown }> = [];
  const criterion = { ...unmet[0], met: false, criterionIndex: 1 };
  const review = (state: "failure" | "success"): ReviewVerdict & { headSha: string; reviewerOutcome: string } => ({
    state,
    criteria: [state === "success" ? { ...criterion, met: true, reason: "proof substantiated" } : criterion],
    testTheater: false,
    summary: state === "success" ? "all criteria met" : "keyword gap",
    floorDegraded: false,
    capped: false,
    keywordOnly: true,
    planOnly: false,
    headSha,
    reviewerOutcome: "success",
  });
  const worker: WorkerResult = {
    sessionId: "unused",
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
    model: "test",
    effort: "medium",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
  };

  const outcome = await runFixRung({
    taskId: "W1-T10511",
    runId: "W1-T10511-test",
    task: { id: "W1-T10511", title: "Recorded body-coverage round", acceptance: [{ claim: criterion.claim, proof: criterion.proof }] },
    prUrl: "https://github.com/acme/remudero/pull/10511",
    branch: "run-W1-T10511-test",
    worktreePath: process.cwd(),
    initialSessionId: "body-coverage-review",
    mount: { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 20000 },
    settingsFile: "/tmp/body-coverage-settings.json",
    config: {} as Config,
    budgetUsd: 1,
    strikeCap: 1,
    initialReview: review("failure"),
    reviewBase: {
      owner: "acme",
      repo: "remudero",
      headCheckoutDir: process.cwd(),
      reviewerMount: { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 20000 },
    },
    deps: {
      spawn: async () => { spawns.push(worker); return worker; },
      waitForCiGreen: async () => "green",
      fetchPrBody: async () => body,
      fetchPrDiffFiles: async () => ["src/lib/prompt-render.ts"],
      updatePrBody: async (_prUrl, updated) => { updates.push(updated); },
      readLiveHead: async () => ({ ok: true, headSha }),
      runReview: async ({ report }) => {
        assert.match(report, /Acceptance:\n- a Claude login that cannot reach the fleet store answers unavailable and creates nothing \| unit test:/);
        return review("success");
      },
      push: () => {},
      issues: { create: () => "https://github.com/acme/remudero/issues/1" },
      ledgerPath: "/tmp/body-coverage-ledger.ndjson",
      log: (step, extra) => rows.push({ step, ...(extra ?? {}) }),
      say: () => {},
      account: (result) => result,
    },
  });

  assert.equal(outcome.outcome, "fixed");
  assert.equal(outcome.strikes, 0);
  assert.equal(updates.length, 1);
  assert.equal(spawns.length, 0);
  assert.equal(rows.some((row) => row.step === "fix.dispatch"), false);
  assert.equal(rows.some((row) => row.step === "fix.body_coverage_repaired"), true);
});
