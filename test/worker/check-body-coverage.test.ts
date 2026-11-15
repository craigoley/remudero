import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { deriveFixMode, selfHealBodyCoverage } from "#src/lib/prompt-render.js";
import { runFixRung, type FixCommandHost } from "#src/cli/commands/fix.js";
import type { Config } from "#src/lib/config.js";
import type { ReviewVerdict } from "#src/lib/review.js";

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
  assert.equal(selfHealBodyCoverage(evidence, fixture.body()), undefined, "do not append duplicate context");
});

test("body repair preserves a failing or unavailable review without spending a strike", async t => {
  for (const failure of [undefined, "review", "contract"] as const) {
    const fixture = await replay(t, failure, false);
    const result = await fixture.run();
    assert.equal(result.outcome, "stood_down");
    assert.equal(result.review.state, "failure");
    assert.equal(result.strikes, 0);
    assert.equal(fixture.spawned(), 0);
    if (failure) assert.ok(fixture.events.includes("fix.body_coverage_review_error"));
  }
});

for (const failure of ["fetch", "write"] as const) {
  test(`body ${failure} failure retains ordinary fix dispatch and records its reason`, async t => {
    const fixture = await replay(t, failure);
    await assert.rejects(fixture.run(), /ordinary dispatch reached/);
    assert.ok(fixture.events.includes("fix.body_coverage_self_heal_error"));
    assert.equal(fixture.body(), "Original PR explanation.\n");
  });
}

test("body repair declines real proof failures, CI red and already reported claims", () => {
  assert.equal(selfHealBodyCoverage({ review: { ...evidence.review,
    unmetCriteria: [{ ...unmet[0], proof_exec: "executed_fail" }] } }, ""), undefined);
  assert.equal(selfHealBodyCoverage({ ...evidence, ciFailures: [] }, ""), undefined);
  assert.equal(selfHealBodyCoverage({}, ""), undefined);
  assert.equal(selfHealBodyCoverage({ review: { ...evidence.review,
    unmetCriteria: [{ ...unmet[0], proof: "unresolved prose" }] } }, ""), undefined);
  assert.equal(selfHealBodyCoverage(evidence, `${unmet[0].claim}\n${unmet[0].proof}`), undefined);
  assert.ok(selfHealBodyCoverage(evidence, unmet[0].proof)?.includes(unmet[0].claim));
});
