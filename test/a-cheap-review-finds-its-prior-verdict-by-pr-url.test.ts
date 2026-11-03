/**
 * test/a-cheap-review-finds-its-prior-verdict-by-pr-url.test.ts — W1-T9681.
 *
 * MEASURED 2026-10-15: 10 of 10 discriminate-only admissions since 10-14 23:19Z fell back to a full review with
 * "prior verdict, task identity, or current reuse facts are unreadable". Every one was a plan filing or hand PR with
 * no task id (admission rows carry task_id SWEEP), and reviewReuseRunner refused `!pr.taskId` before it looked for the
 * verdict, which reviewRowNamesPr already finds by PR URL. The runner's own wiring is proven in
 * test/review-reuse-discrimination-outcome.test.ts, which already imports src/run-task.ts (affected-reach ratchet).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { appendLedger, type LedgerLine } from "#src/lib/ledger.js";
import { missingReviewReuseFact, priorPostedReviewRow, type ReviewVerdict } from "#src/lib/review.js";

const URL = "https://github.com/acme/scratch/pull/11882";
const OTHER = "https://github.com/acme/scratch/pull/1";
const VERDICT = { state: "success", criteria: [{ claim: "c", proof: "grep: x in y", met: true }] } as unknown as ReviewVerdict;

const row = (over: Record<string, unknown> & { task_id: string }): LedgerLine => ({ run_id: "r", step: "review.posted", state: "success", decision_verdict: VERDICT, ...over });

function ledger(live: LedgerLine[], archive?: string) {
  const root = mkdtempSync(join(tmpdir(), "rmd-t9681-"));
  const ledgerPath = join(root, "ledger.ndjson");
  for (const r of live) appendLedger(ledgerPath, r);
  if (archive !== undefined) writeFileSync(join(root, "ledger.2026-10-14T00-00-00-000Z.ndjson"), archive);
  return { ledgerPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("W1-T9681: a PR with no task id finds its prior verdict by its url", async () => {
  const l = ledger([
    row({ task_id: "PR-11882", pr_url: URL, head_sha: "old" }),
    row({ task_id: "PR-11882", pr_url: URL, head_sha: "judged" }),
    row({ task_id: "PR-1", pr_url: OTHER, head_sha: "newer-but-not-ours" }),
    { run_id: "r", step: "review.posted", task_id: "PR-11882", pr_url: URL, head_sha: "no-verdict" },
  ]);
  try {
    assert.equal((await priorPostedReviewRow(l.ledgerPath, undefined, URL))?.head_sha, "judged");
    assert.equal(await priorPostedReviewRow(l.ledgerPath, undefined, "https://github.com/acme/scratch/pull/2"), undefined);
  } finally {
    l.cleanup();
  }
});

test("W1-T9681: a verdict rotated out of the live ledger is still found by its url", async () => {
  const archived = [
    JSON.stringify({ ts: "2026-10-14T00:00:00.000Z", ...row({ task_id: "PR-11882", pr_url: URL, head_sha: "archived" }) }),
    JSON.stringify({ ts: "2026-10-14T00:00:01.000Z", ...row({ task_id: "W1-T57", head_sha: "legacy-key-only" }) }),
    `{"ts":"2026-10-14T00:00:02.000Z","step":"review.posted","pr_url":${JSON.stringify(URL)},"torn`,
  ].join("\n");
  const l = ledger([row({ task_id: "PR-1", pr_url: OTHER })], `${archived}\n`);
  try {
    assert.equal((await priorPostedReviewRow(l.ledgerPath, undefined, URL))?.head_sha, "archived", "the torn row is skipped, not fatal");
    assert.equal((await priorPostedReviewRow(l.ledgerPath, "W1-T57", "https://github.com/acme/scratch/pull/57"))?.head_sha,
      "legacy-key-only", "a row with no pr_url still answers to its task id");
  } finally {
    l.cleanup();
  }
});

test("W1-T9681: a cheap review fallback names the one fact it could not read", () => {
  const ready = { currentOwnDiffDigest: "sha256:x", currentMergeBaseSha: "base" };
  assert.equal(missingReviewReuseFact(VERDICT, ready), undefined);
  assert.equal(missingReviewReuseFact(undefined, ready), "no-prior-verdict");
  assert.equal(missingReviewReuseFact({ ...VERDICT, state: "pending" } as unknown as ReviewVerdict, ready), "prior-not-terminal");
  assert.equal(missingReviewReuseFact({ ...VERDICT, criteria: undefined } as unknown as ReviewVerdict, ready), "criteria-unreadable");
  assert.equal(missingReviewReuseFact(VERDICT, { currentMergeBaseSha: "base" }), "own-diff-digest-unread");
  assert.equal(missingReviewReuseFact(VERDICT, { currentOwnDiffDigest: "sha256:x" }), "merge-base-unread");
});
