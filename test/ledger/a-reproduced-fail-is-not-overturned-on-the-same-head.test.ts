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
  const observations: { findings: number; state: string }[] = [];
  for (const reason of [
    "Named suite passes 16/16, but an additional in-process counterexample shows that one temporary issue-creation refusal permanently suppresses the incident.",
    "Grep resolves and the named tests pass, but an additional in-process counterexample shows that a refused comment is permanently lost.",
    "A probe classified three short fatal exits as zero abnormal exits; removing only their error-summary rows in memory yielded a trailing run of three.",
    "Grep resolves all seven proof markers, but the unlearned-history preservation constraint fails: six fatal exits with zero clean exits became six learned clean samples in a read-only probe.",
  ]) {
    const body = `remudero-review=failure\n1. claim\n   - proof executed and PASSED on the PR head — NOTE: reviewer judged the proof non-responsive (semantic downgrade): ${reason}`;
    const failures = review.reproducedReviewFailuresFromHistory(history, [{ commit_id: SHA, body }], SHA);
    const result = review.applyReviewStatusHistoryGuard({ ...computed, criteria: [{ ...computed.criteria[0], claim: "claim" }] } as never,
      SHA, { kind: "readable", failures });
    observations.push({ findings: failures.length, state: result.verdict.state });
  }
  assert.deepEqual(observations, Array.from({ length: 4 }, () => ({ findings: 1, state: "failure" })),
    "both recorded delivery counterexamples and both fatal-exit probe observations must remain sticky");
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
    "A probe would have classified three short fatal exits as zero abnormal exits.",
    "No probe classified three short fatal exits as zero abnormal exits.",
    "Six fatal exits never became six learned clean samples in a read-only probe.",
    "Six fatal exits would have become six learned clean samples in a read-only probe.",
    "Six fatal exits became six learned clean samples in a read-only probe that was not run.",
  ]) {
    const body = `remudero-review=failure\n1. claim\n   - proof executed and PASSED on the PR head — NOTE: reviewer judged the proof non-responsive: ${reason}`;
    const failures = review.reproducedReviewFailuresFromHistory(history, [{ commit_id: SHA, body }], SHA);
    assert.equal(failures.length, 0, reason);
    const result = review.applyReviewStatusHistoryGuard(computed as never, SHA, { kind: "readable", failures });
    assert.equal(result.verdict.state, "success", reason);
  }
});


test("W1-T11443 criterion 1: cached CLI restoration rechecks the current shared history", async t => {
  for (const scenario of ["late", "lost", "clear", "withheld"] as const) {
    await t.test(scenario, async st => {
      const fixture = gitRepo({ scope: st, kind: "cached-history-restore" });
      const root = fixture.dir;
      writeFileSync(join(root, "changed.ts"), "export const changed = true;\n");
      fixture.git("add", "changed.ts"); fixture.git("commit", "-qm", "changed");
      const head = fixture.git("rev-parse", "HEAD");
      const prUrl = "https://github.com/acme/remudero/pull/1";
      const body = "## Acceptance\n- changed exists | grep: changed in changed.ts\n";
      const diff = "diff --git a/changed.ts b/changed.ts\n+++ b/changed.ts\n@@ -0,0 +1 @@\n+export const changed = true;\n";
      const failures = review.reproducedReviewFailuresFromHistory(history,
        [{ commit_id: head, body: failureBody.replace("laneTarget's CPU bound is measured", "changed exists") }], head);
      const host = { ...reviewFixtureHost(head), reviewPostedDescription: (verdict: { summary: string }) => verdict.summary };
      const view = { number: 1, state: "open", merged_at: null, body, html_url: prUrl, head: { ref: "topic", sha: head } };
      const shim = ghShim([
        { when: "pulls/1/reviews", stdout: "[]" },
        { when: "pulls/1", stdout: JSON.stringify(view) },
        { when: "pr diff", stdout: diff },
        { when: "pr view", stdout: '{"state":"OPEN"}' },
        { when: "/status", stdout: '{"statuses":[]}' },
        { when: "api ", stdout: "{}" },
      ], { kind: "cached-history-restore" });
      const previousPath = process.env.PATH;
      process.env.PATH = `${shim.dir}:${previousPath ?? ""}`;
      let reads = 0, modelRuns = 0, attempt = 0;
      const decisions: Awaited<ReturnType<typeof reviewCommand.runReview>>[] = [];
      const restoration: Parameters<NonNullable<reviewCommand.ReviewCommandDeps["postStatus"]>>[0][] = [];
      const published: { state: string; description: string }[] = [];
      const phases: string[] = [];
      try {
        const drive = () => reviewCommand.reviewCommand(host, "1", ["--repo", "acme/remudero"], {
          resolveOwnerRepo: () => ({ owner: "acme", repo: "remudero" }),
          fetchView: () => view,
          loadConfig: () => ({ root, installRoot: REPO_ROOT, claudeBin: "/unused" }) as never,
          fetchHead: () => {},
          executionMode: "deterministic",
          materialize: () => ({ worktreePath: root }),
          withMaterialized: async (_path, _repo, run) => run(),
          buildBaseProof: () => ({ baseCheckoutDir: undefined, baseUnreadablePaths: new Set(), baseIsCheckout: false, addedTestFiles: new Set() }),
          postReviewPending: async () => ({ posted: true }),
          reviewerCodeFreshness: () => ({ status: "fresh", codeSha: head, originMainSha: head, advance: "none" }),
          readReviewStatusHistory: async () => {
            reads++;
            if (reads >= 4 && scenario === "late") return { kind: "readable", failures, revision: "late-shared-finding" };
            if (reads >= 4 && scenario === "lost") return { kind: "unreadable", reason: "history lost during cached replay" };
            return { kind: "readable", failures: [] };
          },
          onPhase: phase => phases.push(phase),
          runReview: async args => {
            const result = await reviewCommand.runReview(host, {
              ...args, headCheckoutDir: root, readReviewReuseFacts: () => undefined,
              spawnReviewer: true, requireSemanticReview: false,
              reviewerMount: { model: "sonnet", effort: "high", maxTurns: 10, contextBudget: 120_000 },
              reviewerClockBoundMs: 120_000,
              reviewerSpawnWorker: async () => { modelRuns++; return successfulReviewWorker("REVIEW_VERDICT 1: PASS (the changed file proves the claim)"); },
              disarm: () => "not-armed", arm: () => "hold-refused",
            });
            if (attempt === 1 && scenario === "withheld") {
              result.verdictWithheld = "a prior publication guard already withheld this cached result";
              args.onPhase?.("posted");
            }
            decisions.push(result);
            return result;
          },
          postStatus: async args => {
            assert.ok(typeof args.description === "string", "restoration names its verdict reason");
            restoration.push(args);
            if (scenario === "late") {
              assert.equal(args.state, "failure", "a newly readable reproduction cannot restore cached PASS");
              assert.notEqual(args.reviewDecisionDigest, decisions[0].reviewDecisionDigest, "late shared evidence is a new decision input");
              return review.postReviewStatusGuarded({ ...args,
                fetchLifecycle: () => ({ headSha: head, merged: false, closed: false, reviewInputDigest: args.reviewInputDigest }),
                post: async post => {
                  assert.ok(typeof post.description === "string", "publication names its verdict reason");
                  published.push({ state: post.state, description: post.description });
                },
              });
            }
            published.push({ state: args.state, description: args.description });
            return { posted: true };
          },
        });
        assert.equal(await drive(), 0, "the real first review computes a cached PASS");
        assert.equal(decisions[0].state, "success");
        assert.equal(decisions[0].decisionDisposition, "computed");
        assert.ok(modelRuns > 0, "the computed review dispatches a reviewer");
        const computedModelRuns = modelRuns;
        attempt = 1;
        const code = await drive();
        assert.equal(decisions[1].decisionDisposition, "replayed", "the second run must exercise the actual cache path");
        assert.equal(modelRuns, computedModelRuns, "the cached decision does not dispatch another reviewer");
        if (scenario === "clear") {
          assert.equal(code, 0);
          assert.equal(restoration.length, 1);
          assert.equal(restoration[0].state, "success");
          assert.equal(restoration[0].reviewDecisionDigest, decisions[0].reviewDecisionDigest);
        } else if (scenario === "late") {
          assert.equal(code, 1);
          assert.equal(reads, 4, "cached SUCCESS rechecks shared history before restoration");
          assert.deepEqual(published.map(post => post.state), ["failure"]);
          assert.match(published[0].description, /prior reproduced failure/);
          const rows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
          assert.equal(rows.some(row => row.step === "review.verdict_conflict"), false, "new evidence must not be treated as same-input disagreement");
          const original = review.lastReviewDecisionTerminal(rows, restoration[0].taskId, prUrl, decisions[0].reviewDecisionDigest!);
          assert.equal(original?.state, "success", "the previous cached terminal remains immutable");
        } else {
          assert.equal(code, 2);
          assert.equal(restoration.length, 0, "a withheld cached result cannot reach the status poster");
          assert.ok(phases.includes("posted"), "withheld replay releases its phase without claiming a publication");
        }
      } finally {
        process.env.PATH = previousPath;
        rmSync(shim.dir, { recursive: true, force: true });
      }
    });
  }
});
