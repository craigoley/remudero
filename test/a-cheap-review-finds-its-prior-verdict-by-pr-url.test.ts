/**
 * test/a-cheap-review-finds-its-prior-verdict-by-pr-url.test.ts — W1-T9681.
 *
 * MEASURED 2026-10-15: 10 of 10 discriminate-only admissions since 10-14 23:19Z fell back to a full review with
 * "prior verdict, task identity, or current reuse facts are unreadable". Every one was a plan filing or hand PR with
 * no task id (admission rows carry task_id SWEEP), and reviewReuseRunner refused `!pr.taskId` before it looked for the
 * verdict, which reviewRowNamesPr already finds by PR URL.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { appendLedger } from "../src/lib/ledger.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { judgeReview, type ReviewVerdict } from "../src/lib/review.js";
import { readLedgerLines } from "../src/lib/status.js";
import type { OpenPrView, ReviewReuseInputs } from "../src/lib/sweep.js";
import { buildSweepEffects } from "../src/run-task.js";

const PR_NUMBER = 11882;
const PR_URL = `https://github.com/acme/scratch/pull/${PR_NUMBER}`;
const SHARD = "plan/tasks.d/W1-T9681-a-cheap-review.yaml";
const SRC = "src/lib/test-setup.ts";
const CODE_DIFF = `diff --git a/${SRC} b/${SRC}\n+export const inherited = false;\n`;
const PLAN_DIFF = `diff --git a/${SHARD} b/${SHARD}\n+- id: W1-T9681\n`;
const BODY = "The shared test setup ignores an inherited transport floor.";
const HEAD = "cafef00dcafef00dcafef00dcafef00dcafef00d";
const PRIOR_HEAD = "d00dfeedd00dfeedd00dfeedd00dfeedd00dfeed";

const priorVerdict = (planFiling: boolean): ReviewVerdict =>
  planFiling
    ? judgeReview([{ claim: "the shard is filed", proof: `grep: W1-T9681 in ${SHARD}` }], {
      diff: PLAN_DIFF, report: BODY, headCheckoutDir: "/head", execProof: () => "pass",
      planLint: { ran: true, label: "fixture", checked: 1, violations: [] },
    })
    : judgeReview([{ claim: "the setup ignores the floor", proof: `grep: inherited in ${SRC}` }], {
      diff: CODE_DIFF, report: BODY, headCheckoutDir: "/head", execProof: () => "pass",
    });

type Options = {
  planFiling?: boolean;
  prior?: "live" | "archive" | "none";
  verdict?: (v: ReviewVerdict) => unknown;
  pr?: Partial<OpenPrView & ReviewReuseInputs>;
};

function cheapReview(options: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "rmd-t9681-"));
  const bin = mkdtempSync(join(tmpdir(), "rmd-t9681-gh-"));
  const ledgerPath = join(root, "ledger.ndjson");
  const oldPath = process.env.PATH;
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      'case "$*" in',
      `  *"pulls/${PR_NUMBER}"*) printf '{"state":"open","merged":false}\\n' ;;`,
      `  *"pr diff"*) printf '%s' '${options.planFiling ? PLAN_DIFF : CODE_DIFF}' ;;`,
      "  *) printf '{}\\n' ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const prior = priorVerdict(options.planFiling === true);
  const row = {
    run_id: "prior", task_id: `PR-${PR_NUMBER}`, step: "review.posted", state: prior.state, head_sha: PRIOR_HEAD, pr_url: PR_URL,
    decision_verdict: options.verdict ? options.verdict(prior) : prior,
  };
  appendLedger(ledgerPath, { run_id: "other", task_id: "PR-1", step: "review.posted", state: "failure", pr_url: "https://github.com/acme/scratch/pull/1", decision_verdict: { ...prior, state: "failure" } });
  if ((options.prior ?? "live") === "live") appendLedger(ledgerPath, row);
  if (options.prior === "archive") writeFileSync(join(root, "ledger.2026-10-14T00-00-00-000Z.ndjson"), `${JSON.stringify({ ts: "2026-10-14T00:00:00.000Z", ...row })}\n`);
  const steps: Array<{ step: string; fields: Record<string, unknown> }> = [];
  process.env.PATH = `${bin}:${oldPath}`;
  const effects = buildSweepEffects({
    owner: "acme",
    repo: "scratch",
    localRepoName: "not-scratch",
    config: { root } as never,
    ledgerPath,
    runId: "t9681",
    plan: { tasks: [], byId: new Map() } as never,
    log: (step, fields) => steps.push({ step, fields: (fields ?? {}) as Record<string, unknown> }),
    reviewRunner: async () => {
      steps.push({ step: "full-review", fields: {} });
      return 0;
    },
    materializeReviewWorktreeImpl: () => ({ worktreePath: "/head" }),
    buildBaseProofDirImpl: () => ({ baseCheckoutDir: "/base", baseUnreadablePaths: new Set<string>(), baseIsCheckout: true, addedTestFiles: new Set<string>() }),
    reviewReuseExecProofImpl: (_proof, cwd) => (cwd === "/head" ? "pass" : "fail"),
    worktreeRemoveImpl: () => {},
  });
  const pr = {
    prNumber: PR_NUMBER, prUrl: PR_URL, isPlanFiling: options.planFiling === true, reviewState: "none", checksState: "green", unmetCriteria: [],
    priorStrikes: 0, lastActivityAt: "2026-10-15T00:00:00Z", headSha: HEAD, autoMergeArmed: false, body: BODY,
    currentOwnDiffDigest: "sha256:current", currentMergeBaseSha: "base-current", ...options.pr,
  } as OpenPrView & Partial<ReviewReuseInputs>;
  const run = (kind: "discriminate-only" | "reuse") =>
    withLiveWritesAllowed(() => effects.postReview!(pr, { kind, judgedHeadSha: PRIOR_HEAD }));
  return {
    run,
    steps,
    posted: () => readLedgerLines(ledgerPath).filter((l) => l.step === "review.posted" && l.head_sha === HEAD),
    fallbacks: () => steps.filter((s) => s.step === "sweep.review_reuse_discrimination_fallback").map((s) => s.fields.fallback_reason),
    cleanup: () => {
      process.env.PATH = oldPath;
      rmSync(root, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    },
  };
}

test("W1-T9681: a hand PR with no task id runs its cheap review from the verdict its url names", async () => {
  const f = cheapReview();
  try {
    await f.run("discriminate-only");
    assert.deepEqual(f.fallbacks(), [], "no fallback to a full review");
    assert.equal(f.steps.some((s) => s.step === "full-review"), false);
    const [posted, ...rest] = f.posted();
    assert.equal(rest.length, 0);
    assert.equal(posted?.effective_review_mode, "proof-only-discrimination");
    assert.equal(posted?.task_id, `PR-${PR_NUMBER}`, "keyed by the PR number, as every unfiled review is");
    assert.equal(posted?.pr_url, PR_URL);
  } finally {
    f.cleanup();
  }
});

test("W1-T9681: a plan filing with no task id finds its verdict by url, then names why it needs a full review", async () => {
  const f = cheapReview({ planFiling: true });
  try {
    await f.run("discriminate-only");
    assert.deepEqual(f.fallbacks(), ["a plan-only verdict needs a full review to re-run lint-plan"], "W1-T4423's own reason, not a lumped unreadable");
  } finally {
    f.cleanup();
  }
});

test("W1-T9681: a cheap review fallback names the one fact it could not read", async () => {
  const cases: Array<[string, Options]> = [
    ["no-prior-verdict", { prior: "none" }],
    ["prior-not-terminal", { verdict: (v) => ({ ...v, state: "pending" }) }],
    ["criteria-unreadable", { verdict: (v) => ({ ...v, criteria: undefined }) }],
    ["own-diff-digest-unread", { pr: { currentOwnDiffDigest: undefined } }],
    ["merge-base-unread", { pr: { currentMergeBaseSha: undefined } }],
  ];
  for (const [fact, options] of cases) {
    const f = cheapReview(options);
    try {
      await f.run("discriminate-only");
      assert.deepEqual(f.fallbacks(), [fact], fact);
      assert.equal(f.steps.some((s) => s.step === "full-review"), true, `${fact}: the full review still runs`);
    } finally {
      f.cleanup();
    }
  }
});

test("W1-T9681: a verdict rotated out of the live ledger is still found by its url", async () => {
  const f = cheapReview({ prior: "archive" });
  try {
    await f.run("discriminate-only");
    assert.deepEqual(f.fallbacks(), [], "the archive union holds the verdict the live file lost");
    assert.equal(f.posted()[0]?.effective_review_mode, "proof-only-discrimination");
  } finally {
    f.cleanup();
  }
});

test("W1-T9681: an exact reuse of a PR with no task id re-posts the verdict its url names", async () => {
  const f = cheapReview();
  try {
    await f.run("reuse");
    assert.equal(f.steps.some((s) => s.step === "sweep.review_reuse_unreadable" || s.step === "full-review"), false);
    assert.equal(f.posted()[0]?.effective_review_mode, "verdict-reuse");
  } finally {
    f.cleanup();
  }
});
