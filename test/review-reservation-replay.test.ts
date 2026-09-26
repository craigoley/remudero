import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "../src/lib/config.js";
import { appendLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import {
  claimReviewDecision,
  judgeReview,
  postReviewStatusGuarded,
  reviewDecisionDigest,
  reviewReservationOwnershipEvidence,
} from "../src/lib/review.js";
import { formatReservationAnchorMessage } from "../src/lib/task-id-reservation.js";
import { runReview } from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";
import { gitRepo } from "./helpers/git-repo.js";

const ID = "W1-T4561";
const BRANCH = "plan/review-reservation-replay-fixture";
const PR = "https://github.com/acme/remudero/pull/4561";
const FILE = `plan/tasks.d/${ID}-fixture.yaml`;
const DIFF = `diff --git a/${FILE} b/${FILE}\n+++ b/${FILE}\n@@\n+- id: ${ID}\n+  title: fixture\n`;
const CRITERIA = [{ claim: "the widget renders", proof: "the widget renders" }];
const REPORT = "REPORT: the widget renders";
const CLEAN_LINT = { ran: true as const, label: "fixture", checked: 1, violations: [] };
const digest = (headSha: string, ownership: ReturnType<typeof reviewReservationOwnershipEvidence>) =>
  reviewDecisionDigest({ headSha, diff: DIFF, report: REPORT, body: REPORT, acceptance: CRITERIA, ownership });

test("reservation repair reopens a same-head review decision", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-reservation-repair-"));
  const ledgerPath = join(root, "ledger.ndjson");
  const absent = reviewReservationOwnershipEvidence(DIFF, BRANCH, root, () => new Map([[ID, { status: "absent" as const }]]));
  const present = reviewReservationOwnershipEvidence(DIFF, BRANCH, root, () => new Map([[ID, { status: "present" as const, message: formatReservationAnchorMessage({ branch: BRANCH, pid: 1, host: "fixture", startedAt: "2026-09-26T00:00:00Z", source: "automatic" }) }]]));
  try {
    assert.deepEqual(absent?.map((f) => f.kind), ["unreserved"]);
    assert.deepEqual(present, []);
    const before = digest("same-head", absent);
    const after = digest("same-head", present);
    assert.notEqual(before, after);
    appendLedger(ledgerPath, { run_id: "old", task_id: ID, pr_url: PR, step: "review.posted", head_sha: "same-head", review_decision_digest: before, state: "failure", decision_verdict: { state: "failure", criteria: [], capped: false, keywordOnly: false } });
    assert.equal((await claimReviewDecision({ ledgerPath, taskId: ID, prUrl: PR, digest: before })).kind, "replay");
    const repaired = await claimReviewDecision({ ledgerPath, taskId: ID, prUrl: PR, digest: after });
    assert.equal(repaired.kind, "owned");
    if (repaired.kind === "owned") repaired.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unchanged reservation failure remains a named refusal", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-reservation-unchanged-"));
  const absent = () => reviewReservationOwnershipEvidence(DIFF, BRANCH, root, () => new Map([[ID, { status: "absent" as const }]]));
  const foreign = () => reviewReservationOwnershipEvidence(DIFF, BRANCH, root, () => new Map([[ID, { status: "present" as const, message: formatReservationAnchorMessage({ branch: "another-branch", pid: 1, host: "fixture", startedAt: "2026-09-26T00:00:00Z", source: "automatic" }) }]]));
  try {
    assert.equal(digest("same-head", absent()), digest("same-head", absent()));
    const missingVerdict = judgeReview(CRITERIA, { diff: DIFF, report: REPORT, planLint: CLEAN_LINT, headCheckoutDir: root, headRefName: BRANCH, reservationOwnership: absent() });
    assert.equal(missingVerdict.state, "failure");
    assert.match(missingVerdict.summary, /not reserved/);
    const foreignVerdict = judgeReview(CRITERIA, { diff: DIFF, report: REPORT, planLint: CLEAN_LINT, headCheckoutDir: root, headRefName: BRANCH, reservationOwnership: foreign() });
    assert.equal(foreignVerdict.state, "failure");
    assert.match(foreignVerdict.summary, /another-branch/);
    const unreadable = reviewReservationOwnershipEvidence(DIFF, BRANCH, root, () => new Map([[ID, { status: "unknown" as const, reason: "transport unavailable" }]]));
    assert.equal(judgeReview(CRITERIA, { diff: DIFF, report: REPORT, planLint: CLEAN_LINT, headCheckoutDir: root, headRefName: BRANCH, reservationOwnership: unreadable }).state, "failure");
    assert.notEqual(digest("same-head", absent()), digest("same-head", unreadable));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repaired reservation posts success without a verdict conflict", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-reservation-status-"));
  const ledgerPath = join(root, "ledger.ndjson");
  const before = digest("same-head", [{ id: ID, file: FILE, kind: "unreserved" }]);
  const after = digest("same-head", []);
  const posts: string[] = [];
  try {
    appendLedger(ledgerPath, { run_id: "old", task_id: ID, pr_url: PR, step: "review.posted", head_sha: "same-head", review_decision_digest: before, state: "failure", decision_verdict: { state: "failure", criteria: [], capped: false, keywordOnly: false } });
    const result = await postReviewStatusGuarded({ owner: "acme", repo: "remudero", sha: "same-head", state: "success", taskId: ID, evidence: "executed", ledgerPath, runId: "repaired", prUrl: PR, reviewDecisionDigest: after, fetchLifecycle: () => ({ merged: false, closed: false }), post: ({ state }) => void posts.push(state) });
    assert.deepEqual(result, { posted: true });
    assert.deepEqual(posts, ["success"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production review refreshes ownership before replay", async () => {
  const bare = gitRepo({ bare: true, kind: "reservation-replay-origin" });
  const work = gitRepo({ kind: "reservation-replay-work" });
  work.addRemote("origin", bare.dir);
  work.git("push", "--quiet", "origin", "main");
  const head = gitRepo({ cloneFrom: bare.dir, kind: "reservation-replay-head" });
  const sha = head.git("rev-parse", "HEAD");
  const root = mkdtempSync(join(tmpdir(), "rmd-reservation-production-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const gh = ghShim([
    { when: "api repos/", stdout: JSON.stringify({ number: 4561, html_url: PR, updated_at: "t", body: REPORT, head: { ref: BRANCH, sha }, state: "open" }) },
    { when: "pr diff", stdout: DIFF },
    { when: "pr view", stdout: '{"state":"OPEN"}' },
  ], { kind: "reservation-replay" });
  const priorPath = process.env.PATH;
  process.env.PATH = `${gh.dir}:${priorPath}`;
  try {
    const review = (runId: string) => runReview({
      owner: "acme", repo: "remudero", prUrl: PR, headRefName: BRANCH,
      task: { id: ID, acceptance: CRITERIA, files: [FILE] }, report: REPORT,
      settingsFile: "", config: { root, claudeBin: "/bin/true" } as Config,
      log: (step, extra = {}) => appendLedger(ledgerPath, { run_id: runId, task_id: ID, step, ...extra }),
      say: () => {}, account: (result) => result, spawnReviewer: false,
      headCheckoutDir: head.dir, lintPlanForReviewFn: async () => CLEAN_LINT,
      ledgerPath, runId,
      arm: () => "no-task-id", disarm: () => "not-armed",
    });
    const first = await review("missing");
    assert.equal(first.state, "failure");
    assert.deepEqual(first.taskIdOwnership?.map((f) => f.kind), ["unreserved"]);
    const tree = work.git("mktree");
    const anchor = work.git("commit-tree", tree, "-m", formatReservationAnchorMessage({ branch: BRANCH, pid: 1, host: "fixture", startedAt: "2026-09-26T00:00:00Z", source: "automatic" }));
    work.git("push", "--quiet", "origin", `${anchor}:refs/rmd-id/${ID}`);
    const second = await review("repaired");
    assert.equal(second.headSha, first.headSha);
    assert.equal(second.state, "success");
    assert.equal(second.decisionDisposition, "computed");
    assert.deepEqual(second.taskIdOwnership, []);
    assert.notEqual(second.reviewDecisionDigest, first.reviewDecisionDigest);
    const rows = readLedgerLines(ledgerPath);
    assert.ok(rows.some((row) => row.step === "review.posted" && row.state === "success" && row.review_decision_digest === second.reviewDecisionDigest), JSON.stringify(rows.filter((row) => String(row.step).startsWith("review."))));
    assert.ok(!rows.some((row) => row.step === "review.verdict_conflict"));
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    rmSync(gh.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    head.cleanup();
    work.cleanup();
    bare.cleanup();
  }
});
