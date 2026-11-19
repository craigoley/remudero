import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { runReview, type ReviewCommandHost } from "#src/cli/commands/review.js";
import type { Config } from "#src/lib/config.js";
import { readLedgerLines } from "#src/lib/status.js";
import { readReviewEvidenceRecord, renderReviewEvidenceRecord } from "#src/lib/review-evidence-record.js";
import { reviewInputDigest, type ReviewVerdict } from "#src/lib/review.js";
import { runSweep, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { ghShim, type GhShimRoute } from "#test/helpers/gh-shim.js";

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

function github(t: TestContext, routes: GhShimRoute[]) {
  const gh = ghShim(routes);
  const oldPath = process.env.PATH;
  process.env.PATH = `${gh.dir}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  return gh;
}

function comment(body: string, author = FLEET) {
  return { id: 123, body, user: author, created_at: COMMENT_AT, updated_at: COMMENT_AT };
}

function reads(comments: unknown[], state = "success", creator = FLEET, codeSha = REVIEWER_CODE): GhShimRoute[] {
  return [
    { when: "issues/42/comments?per_page=100", stdout: JSON.stringify([[], comments]) },
    { when: `commits/${HEAD}/status`, stdout: JSON.stringify({
      sha: HEAD, statuses: [{ context: "remudero-review", state, creator, created_at: STATUS_AT,
        description: `Verdict [review code ${codeSha}]` }],
    }) },
  ];
}

async function handReview(t: TestContext, extraRoutes: GhShimRoute[] = []) {
  const root = makeTempDir("t12159-review");
  const gh = github(t, [
    ...extraRoutes,
    { when: "/statuses?", stdout: "[[]]" },
    { when: "pulls/42", stdout: JSON.stringify({ state: "open", merged: false, head: { sha: HEAD } }) },
    { when: "pr diff", stdout: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n" },
  ]);
  const host = {
    readHeadShaRest: () => HEAD,
    reviewPostedDescription: (verdict: ReviewVerdict) => verdict.summary,
  } as unknown as ReviewCommandHost;
  const ledger: Record<string, unknown>[] = [];
  const verdict = await runReview(host, {
    owner: "acme", repo: "remudero", prUrl: PR,
    task: { id: "W1-T12159", acceptance: [{ claim: CRITERION.claim, proof: CRITERION.proof }] },
    report: REPORT, settingsFile: join(root, "settings.json"), config: { root } as Config,
    ledgerPath: join(root, "ledger.ndjson"), runId: "review-test",
    log: (step, row) => ledger.push({ ...row, step }), say: () => {}, account: result => result,
    spawnReviewer: false, reviewerMount: { model: "sonnet", effort: "medium", maxTurns: 1, contextBudget: 120000 },
    reviewerCodeFreshness: () => ({ status: "fresh", codeSha: REVIEWER_CODE, originMainSha: REVIEWER_CODE, advance: "none" }),
    arm: () => "ledger-refused", disarm: () => "not-armed",
  });
  return { gh, ledger, verdict };
}

test("W1-T12159 criterion 1: the review command publishes one record of its posted verdict", async (t) => {
  const { gh, ledger, verdict } = await handReview(t);
  const published = gh.calls().filter(call => call.includes("--method POST repos/acme/remudero/issues/42/comments"));
  assert.equal(published.length, 1);
  const row = ledger.find(entry => entry.step === "review.posted");
  assert.ok(row);
  const calls = gh.calls();
  const body = calls.slice(calls.indexOf(published[0]!), calls.indexOf(published[0]!) + 3).join("\n").split("body=")[1]!;
  for (const route of reads([comment(body)], verdict.state)) gh.addRoute(route);
  const record = await readReviewEvidenceRecord({ prUrl: PR, headSha: HEAD, reviewState: verdict.state, reviewInputDigest: DIGEST });
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
  routes = reads(comments, state)) {
  github(t, routes);
  const ledgerPath = join(makeTempDir("t12159-sweep"), "ledger.ndjson");
  const pr: OpenPrView = {
    prNumber: 42, prUrl: PR, taskId: "W1-T12159", headSha: HEAD, reviewInputDigest: DIGEST,
    reviewState: state, checksState: "green", mergeState: "clean", priorReviewAttemptsForInput: 0,
    unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false, lastActivityAt: COMMENT_AT,
  };
  let reviewers = 0;
  const deps: SweepDeps = {
    ledgerPath, runId: "sweep-test", now: () => Date.parse(COMMENT_AT),
    readReviewEvidenceRecord,
    postReview: () => { reviewers++; },
    arm: () => assert.fail("arm in a later pass"), close: () => assert.fail("unexpected close"),
    dispatchFix: () => assert.fail("unexpected fix"), escalate: () => assert.fail("unexpected escalation"),
  };
  await runSweep([pr], deps);
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
  const { pr, deps } = await sweep(t, [comment(renderReviewEvidenceRecord(ROW))]);
  const checked: unknown[] = [];
  let pendingPosts = 0;
  let reviewers = 0;
  await runSweep([{ ...pr, priorReviewAttemptsForInput: 1 }], {
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
  });
  assert.deepEqual(checked, [REVIEWER_CODE]);
  assert.equal(pendingPosts, 0);
  assert.equal(reviewers, 0);
});
