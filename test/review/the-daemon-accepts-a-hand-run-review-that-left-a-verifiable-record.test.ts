import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { reviewCommand, runReview, type ReviewCommandHost } from "#src/cli/commands/review.js";
import type { Config } from "#src/lib/config.js";
import { readLedgerLines } from "#src/lib/status.js";
import { readReviewEvidenceRecord, renderReviewEvidenceRecord, writeReviewEvidenceRecord } from "#src/lib/review-evidence-record.js";
import { reviewInputDigest, type ReviewVerdict } from "#src/lib/review.js";
import { runSweep, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import { withGhShim, type GhShimRoute } from "#test/helpers/gh-shim.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const PR = "https://github.com/acme/remudero/pull/42";
const HEAD = "a".repeat(40);
const REVIEWER_CODE = "c".repeat(40);
const REPORT = "The review evidence works.";
const DIGEST = reviewInputDigest(HEAD, REPORT);
const FLEET = { login: "remudero-fleet[bot]", type: "Bot" };
const STATUS_AT = "2026-11-19T10:01:00Z";
const COMMENT_AT = "2026-11-19T10:01:01Z";
const CRITERION = { claim: "the review evidence works", proof: "a prose proof", met: true,
  reason: "recorded by the reviewer", proof_exec: "not_executable" } as const;
const ROW = {
  pr_url: PR, head_sha: HEAD, review_input_digest: DIGEST, state: "success",
  reviewer_code_sha: REVIEWER_CODE,
  capped: false, plan_only: false, partially_executed: true,
  decision_verdict: { criteria: [CRITERION] }, unmet_criteria: [], reasons: [],
} as const;

function comment(body: string, author = FLEET) {
  return { id: 123, body, user: author, created_at: COMMENT_AT, updated_at: COMMENT_AT };
}

function reads(comments: unknown[], state = "success", creator: typeof FLEET | null = FLEET, codeSha = REVIEWER_CODE): GhShimRoute[] {
  return [
    { when: "issues/42/comments?per_page=100", stdout: JSON.stringify([[], comments]) },
    { when: `commits/${HEAD}/status`, stdout: JSON.stringify({
      sha: HEAD, statuses: [{ context: "remudero-review", state, creator, created_at: STATUS_AT,
        description: `Verdict [review code ${codeSha}]` }],
    }) },
    statusContext(state, creator ?? FLEET, STATUS_AT, codeSha),
  ];
}

function statusContext(state: string, creator: typeof FLEET, createdAt: string, codeSha: string): GhShimRoute {
  return { when: "api graphql", stdout: JSON.stringify({ data: { repository: { nameWithOwner: "acme/remudero",
    object: { oid: HEAD, status: { context: { context: "remudero-review", state: state.toUpperCase(), createdAt,
      description: `Verdict [review code ${codeSha}]`,
      creator: { login: creator.login.replace(/\[bot\]$/, ""), __typename: creator.type } } } },
  } } }) };
}

async function handReview(t: TestContext, extraRoutes: GhShimRoute[] = [],
  input: Pick<Parameters<typeof runReview>[1], "reportIsSubstitute" | "reviewInputBody"> = {}) {
  const { dir: root } = ownedFixtureDir(t, "t12159-review");
  const routes: GhShimRoute[] = [
    ...extraRoutes,
    { when: "/statuses?", stdout: "[[]]" },
    { when: `commits/${HEAD}/status`, stdout: '{"statuses":[]}' },
    { when: "pulls/42", stdout: JSON.stringify({ state: "open", merged: false, head: { sha: HEAD } }) },
    { when: "pr diff", stdout: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n" },
  ];
  const host = {
    readHeadShaRest: () => HEAD,
    reviewPostedDescription: (verdict: ReviewVerdict) => verdict.summary,
  } as unknown as ReviewCommandHost;
  const ledger: Record<string, unknown>[] = [];
  return withGhShim(routes, async (gh) => {
    const verdict = await runReview(host, {
      owner: "acme", repo: "remudero", prUrl: PR,
      task: { id: "W1-T12159", acceptance: [{ claim: CRITERION.claim, proof: CRITERION.proof }] },
      report: input.reportIsSubstitute ? "Fix worker transcript" : REPORT, ...input,
      settingsFile: join(root, "settings.json"), config: { root } as Config,
      ledgerPath: join(root, "ledger.ndjson"), runId: "review-test",
      log: (step, row) => ledger.push({ ...row, step }), say: () => {}, account: result => result,
      spawnReviewer: false, reviewerMount: { model: "sonnet", effort: "medium", maxTurns: 1, contextBudget: 120000 },
      reviewerCodeFreshness: () => ({ status: "fresh", codeSha: REVIEWER_CODE, originMainSha: REVIEWER_CODE, advance: "none" }),
      arm: () => "ledger-refused", disarm: () => "not-armed",
    });
    return { calls: gh.calls(), ledger, verdict };
  });
}

test("W1-T12159 criterion 1: the review command publishes one record of its posted verdict", async (t) => {
  const { calls, ledger, verdict } = await handReview(t);
  const published = calls.filter(call => call.includes("--method POST repos/acme/remudero/issues/42/comments"));
  assert.equal(published.length, 1);
  const row = ledger.find(entry => entry.step === "review.posted");
  assert.ok(row);
  const body = calls.slice(calls.indexOf(published[0]!), calls.indexOf(published[0]!) + 3).join("\n").split("body=")[1]!;
  const record = await withGhShim(reads([comment(body)], verdict.state), () =>
    readReviewEvidenceRecord({ prUrl: PR, headSha: HEAD, reviewState: verdict.state, reviewInputDigest: DIGEST }));
  assert.ok(record);
  assert.equal(record.row.head_sha, row.head_sha);
  assert.equal(record.row.review_input_digest, row.review_input_digest);
  assert.equal(record.row.state, row.state);
  assert.equal(record.row.reviewer_code_sha, row.reviewer_code_sha);
  assert.deepEqual(record.row.proof_exec, row.proof_exec);
  assert.deepEqual(record.row.decision_verdict.criteria.map(({ met }) => met), verdict.criteria.map(({ met }) => met));
});

test("a comment write failure is logged without changing the posted verdict", async (t) => {
  const { ledger, verdict } = await handReview(t, [
    { when: "--method POST repos/acme/remudero/issues/42/comments", exit: 1, stderr: "HTTP 503" },
  ]);
  assert.equal(ledger.find(row => row.step === "review.posted")?.state, verdict.state);
  assert.match(String(ledger.find(row => row.step === "review.evidence_write_failed")?.reason), /HTTP 503|failed/i);
});

test("terminal evidence without an input digest is an explicit write failure", async () => {
  await assert.rejects(writeReviewEvidenceRecord({ ...ROW, review_input_digest: undefined }), /without the exact review input digest/);
});

test("W1-T12159 criterion 1: a fix-rung transcript alone cannot publish a terminal verdict", async (t) => {
  const { calls, ledger, verdict } = await handReview(t, [], { reportIsSubstitute: true });
  assert.equal(verdict.state, "failure");
  assert.match(verdict.verdictWithheld ?? "", /PR body.*unavailable/);
  assert.ok(calls.some(call => call.includes("/statuses/") && call.includes("state=pending")));
  assert.ok(!calls.some(call => call.includes("/statuses/") && /state=(success|failure)/.test(call)));
  assert.ok(!calls.some(call => call.includes("--method POST repos/acme/remudero/issues/42/comments")));
  assert.ok(!ledger.some(row => row.step === "review.posted"));
  assert.match(String(ledger.find(row => row.step === "review.evidence_write_failed")?.reason), /PR body.*unavailable/);
});

test("W1-T12159 criterion 1: a fix-rung transcript uses the separately fetched PR body's digest", async (t) => {
  const { calls, ledger, verdict } = await handReview(t, [], { reportIsSubstitute: true, reviewInputBody: REPORT });
  assert.equal(verdict.state, "failure");
  assert.equal(verdict.verdictWithheld, undefined);
  assert.ok(calls.some(call => call.includes("/statuses/") && call.includes("state=failure")));
  assert.equal(calls.filter(call => call.includes("--method POST repos/acme/remudero/issues/42/comments")).length, 1);
  assert.equal(ledger.find(row => row.step === "review.posted")?.review_input_digest, DIGEST);
});

test("W1-T12159 criterion 1: replay publishes evidence only when it actually restores the status", async (t) => {
  for (const publish of [true, false]) {
    await t.test(publish ? "status written via the transport" : "injected status result", async (t) => {
      const { dir: root } = ownedFixtureDir(t, "t12159-review-replay");
      const host = {
        acceptedReviewAttemptId: () => undefined, liveWorkerRunIds: new Set<string>(),
        reviewWorktreeAsync: { fetch: () => {} }, reviewWorkerLockId: (runId: string) => runId,
        reviewPostedDescription: (verdict: ReviewVerdict) => verdict.summary,
      } as unknown as ReviewCommandHost;
      await withGhShim([], async (gh) => {
        const code = await reviewCommand(host, "42", [], {
          resolveOwnerRepo: () => ({ owner: "acme", repo: "remudero" }),
          loadConfig: () => ({ root }) as Config,
          fetchView: () => ({ number: 42, html_url: PR, body: REPORT, head: { sha: HEAD, ref: "topic" } }),
          postReviewPending: async () => ({ posted: false }),
          materialize: () => ({ worktreePath: undefined, failure: { errorClass: "other", message: "fixture" } }),
          reviewerCodeFreshness: () => ({ status: "fresh", codeSha: REVIEWER_CODE, originMainSha: REVIEWER_CODE, advance: "none" }),
          runReview: async () => ({
            state: "success", criteria: [CRITERION], testTheater: false, summary: "fixture verdict",
            floorDegraded: false, capped: false, keywordOnly: false, planOnly: false, headSha: HEAD,
            reviewerOutcome: "success", decisionDisposition: "replayed", reviewDecisionDigest: "b".repeat(64),
          }),
          postStatus: async ({ post, owner, repo, sha, state, description }) => {
            if (publish) await post!({ owner, repo, sha, state, description });
            return { posted: true };
          },
        });
        assert.equal(code, 0);
        const writes = gh.calls().filter(call => call.includes("/statuses/") || call.includes("--method POST repos/acme/remudero/issues/42/comments"));
        assert.equal(writes.length, publish ? 2 : 0);
        if (publish) {
          assert.match(writes[0]!, /state=success/);
          assert.match(writes[1]!, /issues\/42\/comments/);
        }
      });
    });
  }
});

test("the record preserves proof results and keeps holdout text and ops details private", () => {
  const record = renderReviewEvidenceRecord({
    ...ROW,
    decision_verdict: { criteria: [CRITERION, { ...CRITERION, claim: "private holdout claim", holdout: true }] },
  }, "ops");
  assert.match(record, /"proof_exec":"not_executable"/);
  assert.match(record, /"holdout":true/);
  assert.doesNotMatch(record, /private holdout claim|recorded by the reviewer|a prose proof/);
});

async function sweep(t: TestContext, comments: unknown[], state: "success" | "failure" = "success",
  routes = reads(comments, state), prOverrides: Partial<OpenPrView> = {}) {
  const ledgerPath = join(ownedFixtureDir(t, "t12159-sweep").dir, "ledger.ndjson");
  const pr: OpenPrView = {
    prNumber: 42, prUrl: PR, taskId: "W1-T12159", headSha: HEAD, reviewInputDigest: DIGEST,
    reviewState: state, checksState: "green", mergeState: "clean", priorReviewAttemptsForInput: 0,
    unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false, lastActivityAt: COMMENT_AT, ...prOverrides,
  };
  let reviewers = 0;
  const deps: SweepDeps = {
    ledgerPath, runId: "sweep-test", now: () => Date.parse(COMMENT_AT),
    readReviewEvidenceRecord,
    postReview: () => { reviewers++; },
    arm: () => assert.fail("arm in a later pass"), close: () => assert.fail("unexpected close"),
    dispatchFix: () => assert.fail("unexpected fix"), escalate: () => assert.fail("unexpected escalation"),
  };
  await withGhShim(routes, () => runSweep([pr], deps));
  return { reviewers, rows: readLedgerLines(ledgerPath).filter(row => row.step === "review.posted"), pr, deps };
}

test("W1-T12159 criterion 2: each terminal verdict recovers its exact-input row without a reviewer", async (t) => {
  for (const state of ["success", "failure"] as const) {
    await t.test(state, async (t) => {
      const { reviewers, rows } = await sweep(t, [comment(renderReviewEvidenceRecord({ ...ROW, state }))], state);
      assert.equal(reviewers, 0);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.task_id, "W1-T12159");
      assert.equal(rows[0]!.pr_url, PR);
      assert.equal(rows[0]!.head_sha, HEAD);
      assert.equal(rows[0]!.review_input_digest, DIGEST);
      assert.equal(rows[0]!.state, state);
      assert.equal(rows[0]!.reviewer_code_sha, REVIEWER_CODE);
      assert.equal(rows[0]!.partially_executed, true);
      assert.deepEqual(rows[0]!.proof_exec, ["not_executable"]);
    });
  }
});

test("W1-T12159 criterion 2: the status author's entry also supplies the timestamp and reviewer-code SHA", async (t) => {
  const comments = [comment(renderReviewEvidenceRecord(ROW))];
  const cases = [
    { name: "author and matching metadata in the same entry", createdAt: STATUS_AT, codeSha: REVIEWER_CODE, reviewers: 0 },
    { name: "author's same-state status is newer than the comment", createdAt: "2026-11-19T10:02:00Z", codeSha: REVIEWER_CODE, reviewers: 1 },
    { name: "author's same-state status has a different code SHA", createdAt: STATUS_AT, codeSha: "d".repeat(40), reviewers: 1 },
  ];
  for (const { name, createdAt, codeSha, reviewers: expectedReviewers } of cases) {
    await t.test(name, async (t) => {
      const [commentRoute, restWithoutAuthor] = reads(comments, "success", null);
      const { reviewers, rows } = await sweep(t, comments, "success", [
        commentRoute!, restWithoutAuthor!, statusContext("success", FLEET, createdAt, codeSha),
      ]);
      assert.equal(reviewers, expectedReviewers);
      assert.equal(rows.length, 1 - expectedReviewers);
    });
  }
});

test("W1-T2299 activity-after-failure reruns the reviewer instead of recovering the old evidence", async (t) => {
  const failed = renderReviewEvidenceRecord({ ...ROW, state: "failure" });
  const { reviewers, rows } = await sweep(t, [comment(failed)], "failure", reads([comment(failed)], "failure"), {
    reviewVerdictPostedAt: STATUS_AT,
    lastActivityAt: "2026-11-19T10:01:02Z",
  });
  assert.equal(reviewers, 1);
  assert.deepEqual(rows, []);
});

test("W1-T12159 criterion 3: missing, mismatched, foreign and damaged evidence preserves re-review", async (t) => {
  const valid = renderReviewEvidenceRecord(ROW);
  const foreign = { login: "some-other-reviewer[bot]", type: "Bot" };
  const cases = [
    { name: "absent record", comments: [] },
    { name: "another head", comments: [comment(renderReviewEvidenceRecord({ ...ROW, head_sha: "b".repeat(40) }))] },
    { name: "another digest", comments: [comment(renderReviewEvidenceRecord({ ...ROW, review_input_digest: reviewInputDigest(HEAD, "edited") }))] },
    { name: "another PR", comments: [comment(renderReviewEvidenceRecord({ ...ROW, pr_url: PR + "0" }))] },
    { name: "another state", comments: [comment(renderReviewEvidenceRecord({ ...ROW, state: "failure" }))] },
    { name: "another reviewer-code revision", comments: [comment(valid)],
      routes: reads([comment(valid)], "success", FLEET, "d".repeat(40)) },
    { name: "another author", comments: [comment(valid, foreign)] },
    { name: "foreign status and author agree", comments: [comment(valid, foreign)], routes: reads([comment(valid, foreign)], "success", foreign) },
    { name: "unparseable", comments: [comment(valid.replace("{", "["))] },
    { name: "invalid checksum", comments: [comment(valid.replace("recorded by the reviewer", "altered"))] },
    { name: "older than the status", comments: [{ ...comment(valid), created_at: "2026-11-19T09:00:00Z", updated_at: "2026-11-19T09:00:00Z" }] },
    { name: "edited comment", comments: [{ ...comment(valid), updated_at: "2026-11-19T12:00:00Z" }] },
    { name: "unreadable comments", comments: [], routes: [{ when: "issues/42/comments", exit: 1, stderr: "HTTP 503" }] },
  ];
  for (const { name, comments, routes } of cases) {
    await t.test(name, async (t) => {
      const { reviewers, rows } = await sweep(t, comments, "success", routes);
      assert.equal(reviewers, 1);
      assert.deepEqual(rows, []);
    });
  }
});

test("W1-T12159 criterion 4: the recovered row names the GitHub comment as its source", async (t) => {
  const { rows } = await sweep(t, [comment(renderReviewEvidenceRecord(ROW))]);
  assert.equal(rows[0]?.review_source, "github-comment");
  assert.equal(rows[0]?.review_evidence_comment_id, 123);
});

test("the next sweep checks the recovered verdict's reviewer-code freshness", async (t) => {
  const comments = [comment(renderReviewEvidenceRecord(ROW))];
  const { pr, deps } = await sweep(t, comments);
  const checked: unknown[] = [];
  let pendingPosts = 0;
  let reviewers = 0;
  await withGhShim(reads(comments), () => runSweep([{ ...pr, priorReviewAttemptsForInput: 1 }], {
    ...deps,
    reviewerCodeAdvance: {
      judge: async codeSha => {
        checked.push(codeSha);
        return { status: "fresh", codeSha: REVIEWER_CODE, originMainSha: REVIEWER_CODE, advance: "none" };
      },
      postPending: async () => {
        pendingPosts++;
        return { posted: true };
      },
    },
    postReview: () => { reviewers++; },
    arm: () => "armed",
  }));
  assert.deepEqual(checked, [REVIEWER_CODE]);
  assert.equal(pendingPosts, 0);
  assert.equal(reviewers, 0);
});
