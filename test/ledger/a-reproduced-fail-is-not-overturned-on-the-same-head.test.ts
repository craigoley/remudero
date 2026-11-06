import assert from "node:assert/strict";
import { test } from "node:test";
import * as review from "#src/lib/review.js";
import * as reviewCommand from "#src/cli/commands/review.js";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ghShim } from "#test/helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { appendLedger } from "#src/lib/ledger.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

function reviewFixtureHost(head: string): reviewCommand.ReviewCommandHost {
  const unrelatedHostPort = (): never => { throw new Error("unexpected unrelated orchestration port"); };
  return {
    GIT_UNTRACKED_FILES_ALL: "--untracked-files=all", JUDGE_AT_OWN_START_FLAG: "--judge-at-own-start",
    acceptedReviewAttemptId: value => typeof value === "string" ? value : undefined, attributeWorkerStreamEvent: unrelatedHostPort,
    ledgeredNonDispatchSpawn: unrelatedHostPort, lintPlanForReview: unrelatedHostPort,
    liveWorkerRunIds: new Set(), materializeReviewWorktree: unrelatedHostPort,
    readHeadShaRest: () => head, readMainPlanTreeSha: unrelatedHostPort, realDeps: () => ({ reviewWorktree: { fetch: unrelatedHostPort } }) as unknown as ReturnType<reviewCommand.ReviewCommandHost["realDeps"]>,
    reviewPostedDescription: verdict => {
      assert.equal(verdict.capped, false, "this fixture exercises the production uncapped description branch");
      return verdict.summary;
    },
    reviewWorkerLockId: runId => runId,
    reviewerClockBoundMs: override => { assert.ok(Number.isFinite(override)); return override!; },
    reviewSubjectGit: unrelatedHostPort,
  };
}

function successfulReviewWorker(text: string): Awaited<ReturnType<NonNullable<Parameters<typeof reviewCommand.runReview>[1]["reviewerSpawnWorker"]>>> {
  return {
    sessionId: "reproduction-fixture", costUsd: 0, numTurns: 1, text,
    blocks: [], stderr: "", subtype: "success", isError: false, apiError: false,
    exit: { kind: "exit", code: 0 },
    permissionDenials: [], childEnvKeys: [], model: "sonnet", provider: "codex", servedModel: "fixture", effort: "high",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  };
}

const SHA = "90be1a69eaea5510184cf6eec69f7c72afd13c39";
const failureBody = `**remudero-review=failure**\n\n1. laneTarget's CPU bound is measured\n   - proof executed and PASSED on the PR head — NOTE: reviewer judged the proof non-responsive: an in-memory runDaemon replay adopting a review child in shadow mode throws ReferenceError at daemon.ts:4218. The proof omits review-child adoption.`;
const history = [
  { context: "remudero-review", state: "failure", created_at: "2026-11-05T22:11:12Z" },
  { context: "remudero-review", state: "success", created_at: "2026-11-05T22:33:28Z" },
];
const reviews = [{ commit_id: SHA, state: "COMMENTED", body: failureBody }];
const computed = {
  state: "success", summary: "PASS", criteria: [{ claim: "laneTarget's CPU bound is measured", proof: "unit test: laneTarget", met: true,
    floorMet: true, reason: "proof passed", proof_exec: "executed_pass" }],
  testTheater: false, floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
};

test("W1-T11443 criterion 1: a same-head reproduced failure remains sticky after another machine posts PASS", () => {
  assert.equal(typeof review.reproducedReviewFailuresFromHistory, "function");
  assert.equal(typeof review.applyReviewStatusHistoryGuard, "function");
  assert.equal(typeof reviewCommand.readReviewStatusHistory, "function");
  const failures = review.reproducedReviewFailuresFromHistory(history, reviews, SHA);
  assert.equal(failures.length, 1);
  assert.match(failures[0].finding, /throws ReferenceError at daemon\.ts:4218/);
  const blocked = review.applyReviewStatusHistoryGuard(computed as never, SHA,
    { kind: "readable", failures }, "REVIEW_VERDICT 1: PASS");
  assert.equal(blocked.kind, "post");
  assert.equal(blocked.verdict.state, "failure");
  assert.match(blocked.verdict.summary, /ReferenceError at daemon\.ts:4218/);

  const addressed = `REVIEW_ADDRESSED_FAILURE 1: ${failures[0].id}\nREVIEW_VERDICT 1: PASS (re-ran the shadow adoption replay; no ReferenceError)`;
  const cleared = review.applyReviewStatusHistoryGuard(computed as never, SHA,
    { kind: "readable", failures }, addressed, [], failures.map((finding) => finding.id));
  assert.equal(cleared.kind, "post");
  assert.equal(cleared.verdict.state, "success");
});

test("W1-T11443 criterion 1: the shared reader queries status history and joins same-head PR review findings", async () => {
  const requests: string[][] = [];
  const result = await reviewCommand.readReviewStatusHistory("craigoley", "remudero", "https://github.com/craigoley/remudero/pull/16523", SHA,
    async (args) => {
      requests.push(args);
      return args.at(-1)?.includes("/statuses?") ? [history] : [reviews];
    });
  assert.equal(result.kind, "readable");
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].finding, /ReferenceError at daemon\.ts:4218/);
  assert.equal(requests[0].at(-1), `repos/craigoley/remudero/commits/${SHA}/statuses?per_page=100`);
  assert.equal(requests[1].at(-1), "repos/craigoley/remudero/pulls/16523/reviews?per_page=100");
});

test("W1-T11443 criterion 1: an addressed marker needs a resolution clause on the affected criterion", () => {
  const failures = review.reproducedReviewFailuresFromHistory(history, reviews, SHA);
  const result = review.applyReviewStatusHistoryGuard(computed as never, SHA, { kind: "readable", failures },
    `REVIEW_ADDRESSED_FAILURE 1: ${failures[0].id}\nREVIEW_VERDICT 1: PASS`, [], [failures[0].id]);
  assert.equal(result.verdict.state, "failure", "a bare PASS never explains the reproduction");
});

test("W1-T11443 criterion 1: another criterion cannot acknowledge the affected finding", () => {
  const failures = review.reproducedReviewFailuresFromHistory(history, reviews, SHA);
  const twoCriteria = { ...computed, criteria: [computed.criteria[0], computed.criteria[0]] };
  const result = review.applyReviewStatusHistoryGuard(twoCriteria as never, SHA, { kind: "readable", failures },
    `REVIEW_ADDRESSED_FAILURE 2: ${failures[0].id}\nREVIEW_VERDICT 2: PASS (re-ran the reproduction)`, [], [failures[0].id]);
  assert.equal(result.verdict.state, "failure");
});

test("W1-T11443 criterion 1: a finding discovered after the prompt cannot be acknowledged blindly", () => {
  const failures = review.reproducedReviewFailuresFromHistory(history, reviews, SHA);
  const result = review.applyReviewStatusHistoryGuard(computed as never, SHA, { kind: "readable", failures },
    `REVIEW_ADDRESSED_FAILURE 1: ${failures[0].id}\nREVIEW_VERDICT 1: PASS (re-ran the reproduction)`, [], []);
  assert.equal(result.verdict.state, "failure");
});

test("W1-T11443 criterion 1: compressed unmet numbering maps back to the affected acceptance claim", () => {
  const failures = review.reproducedReviewFailuresFromHistory(history, reviews, SHA);
  const twoCriteria = { ...computed, criteria: [{ ...computed.criteria[0], claim: "an unrelated first criterion" }, computed.criteria[0]] };
  const blocked = review.applyReviewStatusHistoryGuard(twoCriteria as never, SHA, { kind: "readable", failures });
  assert.equal(blocked.verdict.criteria[1].met, false, "the finding concerns acceptance criterion 2 despite being the first unmet item");
  assert.equal(blocked.verdict.criteria[0].met, true);
  const cleared = review.applyReviewStatusHistoryGuard(twoCriteria as never, SHA, { kind: "readable", failures },
    `REVIEW_ADDRESSED_FAILURE 2: ${failures[0].id}\nREVIEW_VERDICT 2: PASS (re-ran the shadow adoption reproduction)`, [], [failures[0].id]);
  assert.equal(cleared.verdict.state, "success");
});

test("W1-T11443 criteria 1/2: production publication guards shared history and presents the prior finding", async () => {
  for (const scenario of ["sticky", "addressed", "unreadable", "unreproduced", "late", "replay", "history-lost"] as const) {
    const fixture = gitRepo({ kind: "reproduced-failure-publication" });
    const root = fixture.dir;
    const oldPath = process.env.PATH;
    let shim: ReturnType<typeof ghShim> | undefined;
    try {
      writeFileSync(join(root, "changed.ts"), "export const changed = true;\n");
      fixture.git("add", "changed.ts");
      fixture.git("commit", "-qm", "changed");
      const head = fixture.git("rev-parse", "HEAD");
      const prUrl = "https://github.com/acme/remudero/pull/1";
      const failures = review.reproducedReviewFailuresFromHistory(history,
        [{ commit_id: head, body: failureBody.replace("laneTarget's CPU bound is measured", "changed exists") }], head);
      let reads = 0;
      let replayPhase = false;
      let historyRevision = "external-failure-v1";
      const prompts: string[] = [];
      const phases: string[] = [];
      const sharedStatuses = [{ id: 1, context: "remudero-review", state: "failure" }];
      const host = reviewFixtureHost(head);
      shim = ghShim([
        { when: "pulls/1/reviews", stdout: "[]" },
        { when: "pulls/1", stdout: JSON.stringify({ number: 1, html_url: prUrl, state: "open", merged_at: null, head: { ref: "b", sha: head } }) },
        { when: "pr diff", stdout: "diff --git a/changed.ts b/changed.ts\n+++ b/changed.ts\n@@ -0,0 +1 @@\n+export const changed = true;\n" },
        { when: "pr view", stdout: '{"state":"OPEN"}' },
        { when: "/status", stdout: '{"statuses":[]}' },
        { when: "api ", stdout: "{}" },
      ], { kind: "reproduced-failure-publication" });
      process.env.PATH = `${shim.dir}:${oldPath}`;
      const drive = () => reviewCommand.runReview(host, {
        owner: "acme", repo: "remudero", prUrl,
        task: { id: "W1-T11443", files: ["changed.ts"], acceptance: [{ claim: "changed exists", proof: "grep: changed in changed.ts" }] },
        report: "changed", settingsFile: join(root, "settings.json"), config: { root, claudeBin: "/unused" },
        log: (step: string, extra: Record<string, unknown> = {}) => appendLedger(join(root, "ledger.ndjson"), { run_id: `history-${scenario}`, task_id: "W1-T11443", step, ...extra }), say: () => {}, account: (worker: unknown) => worker,
        spawnReviewer: true, readReviewReuseFacts: () => undefined, onPhase: (phase: string) => phases.push(phase),
        readReviewStatusHistory: async () => {
          reads++;
          if (scenario === "addressed") return reviewCommand.readReviewStatusHistory("acme", "remudero", prUrl, head,
            async args => args.at(-1)?.includes("/statuses?") ? [sharedStatuses]
              : [[{ commit_id: head, body: failureBody.replace("laneTarget's CPU bound is measured", "changed exists") }]]);
          if (scenario === "unreadable" || (scenario === "history-lost" && reads > 1)) return { kind: "unreadable", reason: "history unavailable in fixture" };
          return { kind: "readable", failures: scenario === "unreproduced" || scenario === "history-lost" || (scenario === "late" && reads === 1) || (scenario === "replay" && !replayPhase) ? [] : failures, ...(scenario === "replay" && replayPhase ? { revision: historyRevision } : {}) };
        },
        reviewerSpawnWorker: async (args: { prompt: string }) => {
          prompts.push(args.prompt);
          const acknowledgement = scenario === "addressed" || scenario === "late"
            ? `REVIEW_ADDRESSED_FAILURE 1: ${failures[0].id}\n` : "";
          return successfulReviewWorker(`${acknowledgement}REVIEW_VERDICT 1: PASS (re-ran the shadow adoption reproduction and it no longer throws)`);
        },
        reviewerMount: { model: "sonnet", effort: "high", maxTurns: 10, contextBudget: 120_000 }, reviewerClockBoundMs: 120_000,
        headCheckoutDir: root, ledgerPath: join(root, "ledger.ndjson"), runId: `history-${scenario}`,
        disarm: () => "not-armed", arm: () => ({ armed: false, reason: "fixture" }),
      } as never);
      const verdict = await drive();
      assert.equal(reads, scenario === "unreadable" ? 1 : 2, `${scenario}: unavailable initial history refuses before paid dispatch`);
      if (scenario === "unreadable" || scenario === "history-lost") {
        assert.match(verdict.verdictWithheld ?? "", /history unavailable in fixture/);
      } else {
        assert.equal(verdict.state, scenario === "sticky" || scenario === "late" ? "failure" : "success", scenario);
      }
      if (scenario === "sticky" || scenario === "addressed") {
        assert.ok(prompts.some(prompt => prompt.includes(JSON.stringify(failures[0].finding))), "the reviewer receives the complete finding");
      }
      const posts = shim.calls().filter(call => call.includes(`statuses/${head}`));
      assert.ok(posts.some(call => call.includes("state=pending")), `${scenario}: pending is visible`);
      assert.equal(posts.some(call => call.includes("state=success")), scenario === "addressed" || scenario === "unreproduced" || scenario === "replay", scenario);
      if (scenario === "sticky" || scenario === "late") {
        assert.ok(posts.some(call => call.includes("state=failure")), scenario);
        const submitted = shim.calls().join("\n");
        assert.ok(submitted.includes("pulls/1/reviews") && submitted.includes("prior reproduced failure remains unaddressed: ReferenceError"), submitted);
      }
      if (scenario === "unreadable") {
        assert.equal(verdict.state, "pending", "an initial transport refusal claims no judgment");
        assert.equal(prompts.length, 0, "known-unreadable history must not dispatch a paid reviewer");
        assert.ok(phases.includes("posted"), "the withheld attempt releases its review slot");
        const retry = await drive();
        assert.equal(retry.state, "pending");
        assert.equal(prompts.length, 0, "an ongoing outage must not multiply paid reviewer attempts");
        assert.equal(reads, 2);
      }
      if (scenario === "history-lost") assert.ok(prompts.length > 0, "the final read protects an already-started review too");
      if (scenario === "addressed") {
        sharedStatuses.unshift({ id: 2, context: "remudero-review", state: "success" });
        const settled = await drive();
        assert.equal(settled.state, "success");
        sharedStatuses.unshift({ id: 3, context: "remudero-review", state: "success" });
        const priorPrompts = prompts.length;
        const reused = await drive();
        assert.equal(reused.decisionDisposition, "replayed", "an explicitly resolved PASS must not invalidate its own cache forever");
        assert.equal(reused.state, "success");
        assert.equal(prompts.length, priorPrompts, "another own PASS status is not new reproduction evidence");
      }
      if (scenario === "replay") {
        replayPhase = true;
        const changed = await drive();
        assert.equal(changed.decisionDisposition, "computed", "new shared reproduction cannot replay the cached PASS");
        assert.equal(changed.state, "failure");
        assert.notEqual(changed.reviewDecisionDigest, verdict.reviewDecisionDigest);
        assert.equal(reads, 4);
        historyRevision = "later-foreign-pass-v2";
        const contradicted = await drive();
        assert.equal(contradicted.decisionDisposition, "computed", "a later terminal status must revalidate the same finding");
        assert.equal(contradicted.state, "failure");
        assert.notEqual(contradicted.reviewDecisionDigest, changed.reviewDecisionDigest);
        assert.equal(reads, 6);
        assert.equal(shim.events().filter(event => event.phase === "start" && event.args.includes("state=failure")).length, 2);
      }
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      if (shim) rmSync(shim.dir, { recursive: true, force: true });
      fixture.cleanup();
    }
  }
});

test("W1-T11443 criterion 1: a reproduced finding and a later terminal status invalidate cached decision identity", () => {
  const input = { headSha: SHA, diff: "", report: "", acceptance: [] };
  const original = review.reviewDecisionDigest(input);
  assert.equal(review.reviewDecisionDigest({ ...input, sharedReviewHistory: { failureIds: [] } } as never), original);
  const failure = review.reviewDecisionDigest({ ...input, sharedReviewHistory: { failureIds: ["finding"], revision: "failure-v1" } } as never);
  assert.notEqual(failure, original);
  assert.notEqual(review.reviewDecisionDigest({ ...input, sharedReviewHistory: { failureIds: ["finding"], revision: "foreign-pass-v2" } } as never), failure);
});

test("W1-T11443 criterion 1: an unmatched acceptance claim still renders an unmet criterion", () => {
  const failures = review.reproducedReviewFailuresFromHistory(history, reviews, SHA);
  const changedClaim = { ...computed, criteria: [{ ...computed.criteria[0], claim: "claim changed by an amendment" }] };
  const result = review.applyReviewStatusHistoryGuard(changedClaim as never, SHA, { kind: "readable", failures });
  assert.equal(result.verdict.state, "failure");
  assert.ok(result.verdict.criteria.some(criterion => !criterion.met), "the rendered review must include the blocking finding");
  assert.match(result.verdict.criteria[0].reason, /prior reproduced failure/);
});

test("W1-T11443 criterion 1: an executed failing proof is a reproduced counterexample", () => {
  const body = "remudero-review=failure\n1. claim\n   - proof executed and FAILED on the PR head (unit test: regression) — overrides any keyword coverage";
  const failures = review.reproducedReviewFailuresFromHistory(history, [{ commit_id: SHA, body }], SHA);
  assert.equal(failures.length, 1, "a concrete executed failing test is not an unexplained downgrade");
  const result = review.applyReviewStatusHistoryGuard({ ...computed, criteria: [{ ...computed.criteria[0], claim: "claim" }] } as never,
    SHA, { kind: "readable", failures });
  assert.equal(result.verdict.state, "failure");
});

test("W1-T11443 criterion 1: the recorded classifier-check counterexample is sticky without a reproduction label", () => {
  const body = "remudero-review=failure\n1. lifetime excludes restart downtime\n   - proof executed and PASSED on the PR head — NOTE: reviewer judged the proof non-responsive (semantic downgrade): A read-only classifier check with a boot-only tail and 100-minute restart gap produced a 100-minute lifetime.";
  const failures = review.reproducedReviewFailuresFromHistory(history, [{ commit_id: SHA, body }], SHA);
  assert.equal(failures.length, 1, "PR16971's recorded executed counterexample must not depend on the word reproduction");
  const result = review.applyReviewStatusHistoryGuard({ ...computed, criteria: [{ ...computed.criteria[0], claim: "lifetime excludes restart downtime" }] } as never,
    SHA, { kind: "readable", failures });
  assert.equal(result.verdict.state, "failure");
  assert.match(failures[0].finding, /100-minute restart gap produced a 100-minute lifetime/);
});

test("W1-T11443 criterion 1: the recorded in-process delivery counterexamples remain sticky", () => {
  for (const reason of [
    "Named suite passes 16/16, but an additional in-process counterexample shows that one temporary issue-creation refusal permanently suppresses the incident.",
    "Grep resolves and the named tests pass, but an additional in-process counterexample shows that a refused comment is permanently lost.",
  ]) {
    const body = `remudero-review=failure\n1. claim\n   - proof executed and PASSED on the PR head — NOTE: reviewer judged the proof non-responsive (semantic downgrade): ${reason}`;
    const failures = review.reproducedReviewFailuresFromHistory(history, [{ commit_id: SHA, body }], SHA);
    assert.equal(failures.length, 1, "PR16971 review at 2026-11-06T16:24:44Z records an executed counterexample");
    const result = review.applyReviewStatusHistoryGuard({ ...computed, criteria: [{ ...computed.criteria[0], claim: "claim" }] } as never,
      SHA, { kind: "readable", failures });
    assert.equal(result.verdict.state, "failure", reason);
  }
});

test("W1-T11443 criterion 2: hypothetical or explicitly unperformed checks are not reproduced findings", () => {
  for (const reason of [
    "A classifier check would have produced a 100-minute lifetime.",
    "No classifier check produced a result; the reviewer could not inspect.",
    "A classifier check was not run and would have returned the incorrect result.",
    "The replay no longer throws ReferenceError at daemon.ts:4218.",
    "A reproduction could throw TypeError at daemon.ts:4218.",
    "A counterexample would show a permanently suppressed incident.",
    "An in-process counterexample was not run and could show a permanently lost comment.",
    "The counterexample did not show an incident suppressed by a temporary refusal.",
  ]) {
    const body = `remudero-review=failure\n1. claim\n   - proof executed and PASSED on the PR head — NOTE: reviewer judged the proof non-responsive: ${reason}`;
    const failures = review.reproducedReviewFailuresFromHistory(history, [{ commit_id: SHA, body }], SHA);
    assert.equal(failures.length, 0, reason);
    const result = review.applyReviewStatusHistoryGuard(computed as never, SHA, { kind: "readable", failures });
    assert.equal(result.verdict.state, "success", reason);
  }
});
