/**
 * test/a-first-review-reads-only-archives-since-its-pr-opened.test.ts — W1-T11340 criterion 1.
 *
 * OBSERVED 2026-11-04: plan PRs #16763 and #16764 were never reviewed, so priorPostedReviewRow missed the live ledger
 * and gunzipped all ~391 archives (647 MB) on core's loop; both reviews hung for hours. A PR opened at 16:20 cannot
 * have a review.posted row in an archive cut before 16:20, so the PR's own created_at bounds the scan.
 *
 * The probe: each fixture plants this PR's row in an archive cut BEFORE the PR opened — impossible in production,
 * which is exactly why finding it proves the archive was opened. At base the lookup reads every archive and finds it.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import { appendLedger } from "#src/lib/ledger.js";
import { priorPostedReviewRow, reviewLanePr, type ReviewVerdict } from "#src/lib/review.js";

const URL = "https://github.com/acme/scratch/pull/16763";
const CREATED_AT = "2026-11-04T16:20:07Z";
const VERDICT = { state: "success", criteria: [{ claim: "c", proof: "grep: x in y", met: true }] } as unknown as ReviewVerdict;

const posted = (ts: string, head: string): string =>
  JSON.stringify({ ts, run_id: "r", task_id: "PR-16763", step: "review.posted", state: "success", pr_url: URL, head_sha: head, decision_verdict: VERDICT });

/** A state dir: a live ledger with no row for the PR, and `old` gzipped archives cut before CREATED_AT. */
function stateDir(old: number, after?: string): { ledgerPath: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "rmd-t11340-scan-"));
  const ledgerPath = join(root, "ledger.ndjson");
  appendLedger(ledgerPath, { run_id: "r", task_id: "PR-1", step: "review.posted", pr_url: "https://github.com/acme/scratch/pull/1", decision_verdict: VERDICT });
  for (let day = 1; day <= old; day++) {
    const stamp = `2026-10-${String(day).padStart(2, "0")}T00-00-00-000Z`;
    writeFileSync(join(root, `ledger.${stamp}.ndjson.gz`), gzipSync(`${posted(`2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`, `old-${day}`)}\n`));
  }
  if (after !== undefined) writeFileSync(join(root, "ledger.2026-11-04T18-00-00-000Z.ndjson.gz"), gzipSync(`${posted("2026-11-04T17:00:00.000Z", after)}\n`));
  return { ledgerPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("W1-T11340: a first review opens no archive cut before its PR opened", async () => {
  const s = stateDir(12);
  try {
    assert.equal(await priorPostedReviewRow(s.ledgerPath, "PR-16763", URL, { prCreatedAt: CREATED_AT }), undefined,
      "no archive older than the PR was opened, so the planted pre-PR row is never seen");
    assert.equal((await priorPostedReviewRow(s.ledgerPath, "PR-16763", URL))?.head_sha, "old-12",
      "the control: an unknown created_at keeps today's full union read, which does open them");
  } finally {
    s.cleanup();
  }
});

test("W1-T11340: an archive cut after the PR opened is still read for its verdict", async () => {
  const s = stateDir(12, "rotated-since-open");
  try {
    assert.equal((await priorPostedReviewRow(s.ledgerPath, "PR-16763", URL, { prCreatedAt: CREATED_AT }))?.head_sha,
      "rotated-since-open");
  } finally {
    s.cleanup();
  }
});

test("W1-T11340: created_at is fetched only on a live miss with archives to bound, and a failed read keeps the full union", async () => {
  const fetched: string[] = [];
  const fetchPrCreatedAt = async (prUrl: string): Promise<string> => { fetched.push(prUrl); return CREATED_AT; };
  const none = stateDir(0);
  try {
    assert.equal(await priorPostedReviewRow(none.ledgerPath, "PR-16763", URL, { fetchPrCreatedAt }), undefined);
    assert.deepEqual(fetched, [], "nothing rotated: no GitHub read for a bound with nothing to bound");
  } finally {
    none.cleanup();
  }
  const s = stateDir(3);
  try {
    assert.equal(await priorPostedReviewRow(s.ledgerPath, "PR-16763", URL, { fetchPrCreatedAt }), undefined);
    assert.deepEqual(fetched, [URL], "the fetched created_at bounds the scan exactly as a known one does");
    const failing = async (): Promise<string> => { throw new Error("gh unavailable"); };
    assert.equal((await priorPostedReviewRow(s.ledgerPath, "PR-16763", URL, { fetchPrCreatedAt: failing }))?.head_sha, "old-3",
      "an unread created_at is unknown, so the lookup keeps today's full read rather than guessing a bound");
    appendLedger(s.ledgerPath, { run_id: "r", task_id: "PR-16763", step: "review.posted", pr_url: URL, head_sha: "live", decision_verdict: VERDICT });
    assert.equal((await priorPostedReviewRow(s.ledgerPath, "PR-16763", URL, { fetchPrCreatedAt }))?.head_sha, "live");
    assert.deepEqual(fetched, [URL], "a live hit answers without any GitHub read");
  } finally {
    s.cleanup();
  }
});

test("W1-T11340: a review inside its lane's view of the same PR takes that PR's created_at", async () => {
  const s = stateDir(12);
  try {
    assert.equal(await reviewLanePr.run({ prUrl: URL, createdAt: CREATED_AT }, () => priorPostedReviewRow(s.ledgerPath, "PR-16763", URL)),
      undefined, "the admitting lane's open-PR view bounds the scan with no GitHub read");
    assert.equal((await reviewLanePr.run({ prUrl: "https://github.com/acme/scratch/pull/1", createdAt: CREATED_AT },
      () => priorPostedReviewRow(s.ledgerPath, "PR-16763", URL)))?.head_sha, "old-12",
      "another PR's lifetime is never this PR's bound");
  } finally {
    s.cleanup();
  }
});
