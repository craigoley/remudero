import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "#test/helpers/sweep-test.js";
import { appendLedger } from "#src/lib/ledger.js";
import { reviewSetupRefusalsFor } from "#src/lib/tick-read-worker.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

// W1-T13838 — the live console #2715 shape (2026-11-19): reviewer-regression incident reviewer-regression-ef8b74910f25
// was open, so each review ran from a healed tree and wrote that tree's sha. The W1-T13193 hold compared every refusal
// with the daemon's own loaded sha, counted none, and the sweep re-admitted the same refused input 9 times in 9 minutes.
const NOW = Date.parse("2026-11-19T12:57:00Z");
const PR_NUMBER = 2715;
const PR_URL = `https://github.com/craigoley/remudero-console/pull/${PR_NUMBER}`;
const TASK = "CONSOLE-T252";
const HEAD = "17bec589" + "a".repeat(32);
const DIGEST = "v2:3c04e52b3dc26a6abdde3c2491821e0e2acf8f143dad6c4c532b7871501d0bd8";
const RUNNING = "762d3a05308fa3a2f9b996f8c882fd6c3d61aead";
const HEALED_A = "efa46f6b" + "b".repeat(32);
const HEALED_B = "e9890cfaf00253151107434a31c076dd96be896a";
const REASON = "head-task-metadata-unavailable";

type Row = Record<string, unknown>;

function admitted(ts: string): Row {
  return { ts, step: "sweep.review_admitted", task_id: TASK, pr_number: PR_NUMBER, pr_url: PR_URL, head_sha: HEAD,
    review_key: TASK, review_input_digest: DIGEST };
}
function refused(ts: string, codeSha: string): Row {
  return { ts, step: "review.semantic_setup_refused", task_id: TASK, lane: "review", pr_url: PR_URL, head_sha: HEAD,
    review_input_digest: DIGEST, reviewer_code_sha: codeSha, reason: REASON };
}
function healed(ts: string, sha: string): Row {
  return { ts, step: "review.ran_from_healed_tree", task_id: "DAEMON", incident_id: "reviewer-regression-ef8b74910f25",
    pr: String(PR_NUMBER), healed_sha: sha, exit_code: 2 };
}

const HEALED_REFUSALS: Row[] = [
  admitted("2026-11-19T12:48:43Z"), refused("2026-11-19T12:49:26Z", HEALED_A), healed("2026-11-19T12:49:26Z", HEALED_A),
  admitted("2026-11-19T12:53:06Z"), refused("2026-11-19T12:53:45Z", HEALED_B), healed("2026-11-19T12:53:45Z", HEALED_B),
];

function viewFor(ledger: Row[]): OpenPrView {
  return {
    prNumber: PR_NUMBER, prUrl: PR_URL, taskId: TASK, headRefName: "run-CONSOLE-T252-1795091723001",
    reviewState: "none", checksState: "green", unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: "2026-11-19T12:36:10Z", headSha: HEAD, autoMergeArmed: false,
    reviewInputDigest: DIGEST, priorReviewAttemptsForInput: 0,
    reviewSetupRefused: reviewSetupRefusalsFor(ledger, TASK, PR_URL, HEAD, DIGEST, RUNNING),
  } as OpenPrView;
}

function ledgerWith(rows: Row[]): string {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13838-`)), "ledger.ndjson");
  for (const row of rows) appendLedger(ledgerPath, row as never);
  return ledgerPath;
}

test("W1-T13838 criterion 1: two refusals written by healed trees hold the review while the running sha differs", async () => {
  const held = reviewSetupRefusalsFor(HEALED_REFUSALS, TASK, PR_URL, HEAD, DIGEST, RUNNING);
  assert.equal(held?.reason, REASON);
  assert.equal(held?.count, 2);
  assert.equal(held?.runningReviewerCodeSha, RUNNING);

  const ledgerPath = ledgerWith(HEALED_REFUSALS);
  const reviewed: number[] = [];
  const deps = {
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    postReview: (p: OpenPrView) => { reviewed.push(p.prNumber); },
    ledgerPath, runId: "SWEEP-1", now: () => NOW,
  } as unknown as SweepDeps;
  await runSweep([viewFor(HEALED_REFUSALS)], deps, DEFAULT_SWEEP_POLICY);
  assert.equal(reviewed.length, 0, "no review child is started for the refused input");
  const written = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row)
    .slice(HEALED_REFUSALS.length);
  assert.equal(written.filter((row) => row.step === "sweep.review_admitted").length, 0);
});

test("W1-T13838 criterion 2: invariant:known-code-only — a refusal of unknown code, or at another head or digest, does not count", () => {
  const unknown = [refused("2026-11-19T12:49:26Z", "f".repeat(40)), refused("2026-11-19T12:53:45Z", "e".repeat(40))];
  assert.equal(reviewSetupRefusalsFor(unknown, TASK, PR_URL, HEAD, DIGEST, RUNNING), undefined);
  assert.equal(reviewSetupRefusalsFor(HEALED_REFUSALS, TASK, PR_URL, "0".repeat(40), DIGEST, RUNNING), undefined);
  assert.equal(reviewSetupRefusalsFor(HEALED_REFUSALS, TASK, PR_URL, HEAD, "v2:other", RUNNING), undefined);
  const restarted = [...HEALED_REFUSALS, { ts: "2026-11-19T12:55:00Z", step: "review.pending_posted", task_id: TASK,
    pr_url: PR_URL, head_sha: HEAD, review_input_digest: DIGEST }];
  assert.equal(reviewSetupRefusalsFor(restarted, TASK, PR_URL, HEAD, DIGEST, RUNNING), undefined);
});
