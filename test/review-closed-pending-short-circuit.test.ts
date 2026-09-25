import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runReview } from "../src/run-task.js";
import { REVIEW_ENGINE_REVISION, reviewInputDigest } from "../src/lib/review.js";
import type { Config } from "../src/lib/config.js";
import type { WorkerResult } from "../src/lib/worker.js";

/**
 * W1-T4468 — a review whose FIRST effect, the pending post, is refused because the PR already
 * merged or closed stands down there: no `gh pr diff`, no decision claim, no reviewer, no proofs.
 * Every other pending refusal (an already-pending claim on the same input) keeps today's path.
 *
 * Driven through the real `runReview` against a stub `gh` on PATH that records every call it
 * receives, so "stopped before the diff" is read off what was actually shelled out.
 */

const HEAD_SHA = "deadbeefcafe4468";
const PR_URL = "https://github.com/acme/remudero/pull/4468";
const TASK_ID = "W1-T4468";

type Lifecycle = "open" | "merged" | "closed";

function stubGh(binDir: string, callLog: string, lifecycle: Lifecycle): void {
  const row = JSON.stringify({
    number: 4468,
    html_url: PR_URL,
    updated_at: "t",
    body: "",
    state: lifecycle === "open" ? "open" : "closed",
    merged_at: lifecycle === "merged" ? "2026-09-24T16:00:00Z" : null,
    head: { ref: "b", sha: HEAD_SHA },
  });
  writeFileSync(
    join(binDir, "gh"),
    `#!/bin/sh
echo "$*" >> '${callLog}'
case "$1 $2" in
  "api "*)
    case "$*" in
      *pulls/*) echo '${row}' ;;
      *) echo '{}' ;;
    esac ;;
  "pr view")
    case "$*" in
      *headRefOid*) echo '{"headRefOid":"${HEAD_SHA}"}' ;;
      *) echo '{}' ;;
    esac ;;
  "pr diff") echo "diff --git a/README.md b/README.md" ;;
  *) exit 0 ;;
esac
`,
    { mode: 0o755 },
  );
}

interface ReviewRun {
  result: Awaited<ReturnType<typeof runReview>> | undefined;
  rows: Array<{ step: string } & Record<string, unknown>>;
  calls: string;
  ledger: string;
}

async function drive(lifecycle: Lifecycle, seedLedger?: (ledgerPath: string) => void): Promise<ReviewRun> {
  const root = mkdtempSync(join(tmpdir(), "rmd-closed-pending-"));
  const binDir = mkdtempSync(join(tmpdir(), "rmd-closed-pending-gh-"));
  const callLog = join(root, "gh-calls.log");
  const oldPath = process.env.PATH;
  const rows: Array<{ step: string } & Record<string, unknown>> = [];
  let result: ReviewRun["result"];
  const ledgerPath = join(root, "state", "ledger.ndjson");
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    seedLedger?.(ledgerPath);
    writeFileSync(join(root, "settings.json"), "{}", "utf8");
    stubGh(binDir, callLog, lifecycle);
    process.env.PATH = `${binDir}:${oldPath}`;
    try {
      result = await runReview({
        owner: "acme",
        repo: "remudero",
        prUrl: PR_URL,
        task: { id: TASK_ID },
        report: "",
        reviewInputBody: "",
        settingsFile: join(root, "settings.json"),
        config: { claudeBin: "/bin/true", root } as Config,
        log: (step: string, extra?: Record<string, unknown>) => void rows.push({ step, ...(extra ?? {}) }),
        say: () => {},
        account: (r: WorkerResult) => r,
        spawnReviewer: false,
        reviewerMount: { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 },
        ledgerPath,
        runId: `REVIEW-CLOSED-PENDING-${lifecycle}`,
      });
    } catch {
      // A review that carries on past the pending post may fail later against this thin stub;
      // only what it shelled out before that is asserted.
    }
    const calls = existsSync(callLog) ? readFileSync(callLog, "utf8") : "";
    const ledger = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : "";
    return { result, rows, calls, ledger };
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
}

test("W1-T4468: a review whose pending post is refused because the PR merged stops before the diff", async () => {
  const run = await drive("merged");

  assert.ok(run.result, `a stood-down review returns a result; rows were ${JSON.stringify(run.rows)}`);
  assert.equal(run.result!.verdictWithheld, "pr_merged");
  assert.equal(run.result!.reviewerOutcome, "not_attempted_pr_merged");
  assert.equal(run.result!.headSha, HEAD_SHA);
  assert.doesNotMatch(run.calls, /pr diff/, "no diff may be fetched for a merged PR");
  const stood = run.rows.find((row) => row.step === "review.stood_down");
  assert.ok(stood, `the stop must be ledgered; rows were ${JSON.stringify(run.rows)}`);
  assert.equal(stood!.reason, "pr_merged");
  assert.equal(stood!.head_sha, HEAD_SHA);
  assert.equal(stood!.pr_url, PR_URL);
});

test("W1-T4468: a review whose pending post is refused because the PR closed stops the same way", async () => {
  const run = await drive("closed");

  assert.ok(run.result, `a stood-down review returns a result; rows were ${JSON.stringify(run.rows)}`);
  assert.equal(run.result!.verdictWithheld, "pr_closed");
  assert.equal(run.result!.state, "failure");
  assert.doesNotMatch(run.calls, /pr diff/, "no diff may be fetched for a closed PR");
  const stood = run.rows.find((row) => row.step === "review.stood_down");
  assert.equal(stood?.reason, "pr_closed");
});

test("W1-T4468: an already-pending refusal on an open PR still lets the review run", async () => {
  // A fresh same-input pending claim makes postReviewPending refuse WITHOUT a lifecycle — the
  // idempotent no-op — so the review must carry on to the diff exactly as before.
  const run = await drive("open", (ledgerPath) => {
    appendFileSync(
      ledgerPath,
      JSON.stringify({
        ts: new Date().toISOString(),
        run_id: "REVIEW-OTHER-HOLDER",
        task_id: TASK_ID,
        step: "review.pending_posted",
        head_sha: HEAD_SHA,
        pr_url: PR_URL,
        review_input_digest: reviewInputDigest(HEAD_SHA, "", REVIEW_ENGINE_REVISION),
      }) + "\n",
      "utf8",
    );
  });

  // The refusal really was the already-pending no-op: this run never posted a pending of its own.
  const ownPending = run.ledger
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row.step === "review.pending_posted" && row.run_id === "REVIEW-CLOSED-PENDING-open");
  assert.deepEqual(ownPending, [], "the seeded claim must make this run's pending post a no-op");
  assert.match(run.calls, /pr diff/);
  assert.ok(!run.rows.some((row) => row.step === "review.stood_down"), `rows were ${JSON.stringify(run.rows)}`);
});
