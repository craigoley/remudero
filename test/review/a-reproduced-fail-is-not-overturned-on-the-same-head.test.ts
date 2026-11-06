import assert from "node:assert/strict";
import { test } from "node:test";
import * as review from "#src/lib/review.js";
import * as reviewCommand from "#src/cli/commands/review.js";
import { runReview } from "#src/run-task.js";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ghShim } from "#test/helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";

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
  for (const scenario of ["sticky", "addressed", "unreadable", "unreproduced", "late"] as const) {
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
      const prompts: string[] = [];
      shim = ghShim([
        { when: "pulls/1/reviews", stdout: "[]" },
        { when: "pulls/1", stdout: JSON.stringify({ number: 1, html_url: prUrl, state: "open", merged_at: null, head: { ref: "b", sha: head } }) },
        { when: "pr diff", stdout: "diff --git a/changed.ts b/changed.ts\n+++ b/changed.ts\n@@ -0,0 +1 @@\n+export const changed = true;\n" },
        { when: "pr view", stdout: '{"state":"OPEN"}' },
        { when: "/status", stdout: '{"statuses":[]}' },
        { when: "api ", stdout: "{}" },
      ], { kind: "reproduced-failure-publication" });
      process.env.PATH = `${shim.dir}:${oldPath}`;
      const verdict = await runReview({
        owner: "acme", repo: "remudero", prUrl,
        task: { id: "W1-T11443", files: ["changed.ts"], acceptance: [{ claim: "changed exists", proof: "grep: changed in changed.ts" }] },
        report: "changed", settingsFile: join(root, "settings.json"), config: { root, claudeBin: "/unused" },
        log: () => {}, say: () => {}, account: (worker: unknown) => worker,
        spawnReviewer: true, readReviewReuseFacts: () => undefined,
        readReviewStatusHistory: async () => {
          reads++;
          if (scenario === "unreadable") return { kind: "unreadable", reason: "history unavailable in fixture" };
          return { kind: "readable", failures: scenario === "unreproduced" || (scenario === "late" && reads === 1) ? [] : failures };
        },
        reviewerSpawnWorker: async (args: { prompt: string }) => {
          prompts.push(args.prompt);
          const acknowledgement = scenario === "addressed" || scenario === "late"
            ? `REVIEW_ADDRESSED_FAILURE 1: ${failures[0].id}\n` : "";
          return {
            sessionId: "reproduction-fixture", costUsd: 0, numTurns: 1,
            text: `${acknowledgement}REVIEW_VERDICT 1: PASS (re-ran the shadow adoption reproduction and it no longer throws)`,
            blocks: [], stderr: "", subtype: "success", isError: false, apiError: false,
            permissionDenials: [], childEnvKeys: [], model: "sonnet", provider: "codex", servedModel: "fixture", effort: "high",
            tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
          };
        },
        reviewerMount: { model: "sonnet", effort: "high", maxTurns: 10, contextBudget: 120_000 },
        headCheckoutDir: root, ledgerPath: join(root, "ledger.ndjson"), runId: `history-${scenario}`,
        disarm: () => "not-armed", arm: () => ({ armed: false, reason: "fixture" }),
      } as never);
      assert.equal(reads, 2, `${scenario}: history is checked before the prompt and again before publication`);
      if (scenario === "unreadable") {
        assert.match(verdict.verdictWithheld ?? "", /history unavailable in fixture/);
      } else {
        assert.equal(verdict.state, scenario === "sticky" || scenario === "late" ? "failure" : "success", scenario);
      }
      if (scenario === "sticky" || scenario === "addressed") {
        assert.ok(prompts.some(prompt => prompt.includes(JSON.stringify(failures[0].finding))), "the reviewer receives the complete finding");
      }
      const posts = shim.calls().filter(call => call.includes(`statuses/${head}`));
      assert.ok(posts.some(call => call.includes("state=pending")), `${scenario}: pending is visible`);
      assert.equal(posts.some(call => call.includes("state=success")), scenario === "addressed" || scenario === "unreproduced", scenario);
      if (scenario === "sticky" || scenario === "late") {
        assert.ok(posts.some(call => call.includes("state=failure")), scenario);
        assert.ok(shim.calls().some(call => call.includes("pulls/1/reviews") && call.includes("prior reproduced failure remains unaddressed: ReferenceError")), "the published finding cites the prior reproduction");
      }
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      if (shim) rmSync(shim.dir, { recursive: true, force: true });
      fixture.cleanup();
    }
  }
});
