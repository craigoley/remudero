import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { runFixRung, type FixCommandHost } from "#src/cli/commands/fix.js";
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
const evidence = { review: { unmetCriteria: unmet, summary: "keyword gap" } };
const initialReview: ReviewVerdict & { headSha: string; reviewerOutcome: string } = {
  state: "failure", criteria: unmet, summary: "keyword gap", headSha: "deadbeef",
  reviewerOutcome: "success", testTheater: false, floorDegraded: false, capped: false,
  keywordOnly: false, planOnly: false,
};

async function replay(t: TestContext, failure?: "fetch" | "write" | "review" | "contract", reviewPasses = true) {
  const scratch = mkdtempSync(join(tmpdir(), "rmd-body-coverage-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  let body = "Original PR explanation.\n";
  const events: string[] = [];
  let spawned = 0;
  let reviewedBody: string | undefined;
  const host = {
    workerBoundaryStack: {},
    prNumberFromRef: () => 13946,
    fixRoundGitOwnership: () => { throw new Error("ordinary dispatch reached"); },
  } as unknown as FixCommandHost;
  const run = () => runFixRung({
    taskId: "W1-T10511", runId: "W1-T10511-replay", task: { id: "W1-T10511", title: "login" },
    prUrl: "https://github.com/craigoley/remudero/pull/13946", branch: "run-W1-T10511-1",
    worktreePath: scratch, initialSessionId: "original", strikeCap: 1,
    mount: { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 },
    settingsFile: join(scratch, "settings.json"), config: {} as Config, budgetUsd: 1,
    reviewBase: { owner: "craigoley", repo: "remudero", headCheckoutDir: scratch,
      reviewerMount: { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 } },
    initialReview,
    escalationJudge: async () => { throw new Error("unexpected escalation judge"); },
    deps: {
      spawn: async () => { spawned++; throw new Error("worker must not spawn"); },
      fetchPrBody: async () => {
        if (failure === "fetch") throw new Error("body read unavailable");
        return body;
      },
      updatePrBody: async (_url, updated) => {
        if (failure === "write") throw new Error("body write unavailable");
        body = updated;
        events.push("write");
      },
      runReview: async args => {
        events.push("review");
        reviewedBody = args.report;
        assert.equal(args.reportIsSubstitute, false);
        assert.equal(args.reviewInputBody, body);
        assert.deepEqual(args.task.acceptance, unmet.map(({ claim, proof }) => ({ claim, proof })));
        if (failure === "review") throw new Error("review unavailable");
        return reviewPasses ? { ...initialReview, state: "success", criteria: [{ ...unmet[0], met: true }] } : initialReview;
      },
      resolveTaskContractAtHead: async () => failure === "contract" ? undefined : {
        taskId: "W1-T10511", criteria: unmet.map(({ claim, proof }) => ({ claim, proof })),
      },
      waitForCiGreen: async () => { throw new Error("body edits require no new CI run"); },
      push: () => assert.fail("body edits require no push"),
      issues: { create: () => { throw new Error("unexpected escalation"); } },
      ledgerLines: () => [], ledgerPath: join(scratch, "ledger.ndjson"),
      approvedSkillsDir: join(scratch, "skills"),
      log: step => events.push(step), say: () => {}, account: r => r,
    },
  }, host);
  return { run, events, body: () => body, spawned: () => spawned, reviewedBody: () => reviewedBody };
}

test("W1-T10661: a recorded body-coverage round repairs the PR body without dispatching a fix worker", async t => {
  assert.equal(deriveFixMode(evidence), "body-coverage");
  assert.deepEqual(bodyCoverageSelfHealCriteria(evidence, [{ claim: unmet[0].claim, proof: unmet[0].proof }]), [
    { claim: unmet[0].claim, proof: unmet[0].proof },
  ]);
  assert.equal(bodyCoverageSelfHealCriteria(evidence, [{ claim: unmet[0].claim, proof: "an unprefixed proof" }]), undefined);
  const prompt = renderFixPrompt({ task: { id: "W1-T10511", title: "t" }, round: 1, branch: "run-W1-T10511-1", evidence });
  assert.match(prompt, /Paste-ready PR body Acceptance block/);
  assert.ok(prompt.includes(`- Criterion 1: ${unmet[0].claim} — proven by ${unmet[0].proof}`));
});

test("body repair is exercised through the real fix rung before worker dispatch", async t => {
  const fixture = await replay(t);
  const result = await fixture.run();
  assert.equal(result.strikes, 0);
  assert.equal(fixture.spawned(), 0);
  assert.ok(!fixture.events.includes("fix.dispatch"));
  assert.ok(fixture.events.indexOf("write") < fixture.events.indexOf("review"));
  assert.equal(fixture.reviewedBody(), fixture.body());
  assert.ok(fixture.body().startsWith("Original PR explanation.\n"));
  assert.ok(fixture.body().includes(unmet[0].claim));
  assert.ok(fixture.body().includes(unmet[0].proof));
  assert.equal(result.review.state, "success");
});

test("body repair preserves a failing or unavailable review without spending a strike", async t => {
  for (const failure of [undefined, "review"] as const) {
    const fixture = await replay(t, failure, false);
    const result = await fixture.run();
    assert.equal(result.outcome, "stood_down");
    assert.equal(result.review.state, "failure");
    assert.equal(result.strikes, 0);
    assert.equal(fixture.spawned(), 0);
    if (failure) assert.ok(fixture.events.includes("fix.body_coverage_repair_error"));
  }
});

for (const failure of ["fetch", "write"] as const) {
  test(`body ${failure} failure retains ordinary fix dispatch and records its reason`, async t => {
    const fixture = await replay(t, failure);
    await assert.rejects(fixture.run(), /ordinary dispatch reached/);
    assert.ok(fixture.events.includes("fix.body_coverage_repair_error"));
    assert.equal(fixture.body(), "Original PR explanation.\n");
  });
}



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

  const host = {
    workerBoundaryStack: {},
    prNumberFromRef: () => 10511,
    readRegistrationChanges: () => [],
    fixRoundGitOwnership: () => { throw new Error("body repair must precede dispatch"); },
  } as unknown as FixCommandHost;
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
  }, host);

  assert.equal(outcome.outcome, "fixed");
  assert.equal(outcome.strikes, 0);
  assert.equal(updates.length, 1);
  assert.equal(spawns.length, 0);
  assert.equal(rows.some((row) => row.step === "fix.dispatch"), false);
  assert.equal(rows.some((row) => row.step === "fix.body_coverage_repaired"), true);
});
