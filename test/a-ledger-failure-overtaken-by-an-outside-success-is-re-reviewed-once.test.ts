import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readLedgerLines } from "../src/lib/status.js";
import {
  DEFAULT_SWEEP_POLICY,
  reviewDeliveredFailureOvertaken,
  runSweep,
  type OpenPrView,
  type SweepDeps,
} from "./helpers/sweep-test.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// ── W1-T5840 ──────────────────────────────────────────────────────────────────────────────────
//
// W1-T3823's case: the daemon's reviewer DELIVERED a failure for an exact input, and later a manual
// or external actor put a review status of SUCCESS on the same head. W1-T5813 ended the supersedes
// re-review demand for every delivered verdict, so this case fell to the arm path, which refuses the
// ledger failure forever while the board reads green. The demand must fire for a delivered FAILURE
// the status overtakes, exactly once per status timestamp, and keep ending for a delivered success.
// ──────────────────────────────────────────────────────────────────────────────────────────────

const HEAD = "c7a6af55912de44aa62ec051383c5eb851242515";
const URL = "https://github.com/craigoley/remudero/pull/9155";
const DIGEST = "v2:18fd92ac56f3c990bc16553c3c54675c584c6d0f8f91d7a24593596d8c259075";
const FAILED_AT = "2026-10-05T02:55:18.739Z";
const STATUS_AT = "2026-10-05T03:43:11Z";
const RE_REVIEW_AT = "2026-10-05T03:50:00.000Z";
const NEWER_STATUS_AT = "2026-10-05T04:10:00Z";
const NOW = Date.parse("2026-10-05T04:20:00.000Z");
const SUPERSEDES = /review_status_supersedes_ledger_attempt/;

function posted(ts: string, state: "success" | "failure"): Record<string, unknown> {
  return {
    ts,
    run_id: `review-PR9155-${Date.parse(ts)}`,
    task_id: "PR-9155",
    step: "review.posted",
    lane: "review",
    context: "remudero-review",
    state,
    head_sha: HEAD,
    pr_url: URL,
    review_input_digest: DIGEST,
    capped: false,
    plan_only: true,
  };
}

/** The view GitHub shows: green checks and a review status of success posted at `statusAt`. */
function view(lastAttemptAt: string, statusAt: string, over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 9155,
    prUrl: URL,
    taskId: undefined,
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: statusAt,
    createdAt: "2026-10-04T20:30:00Z",
    headSha: HEAD,
    autoMergeArmed: false,
    isPlanFiling: true,
    mergeState: "clean",
    requiredContextsUnreadable: false,
    reviewInputDigest: DIGEST,
    priorReviewAttemptsForInput: 1,
    reviewInputLastAttemptAt: lastAttemptAt,
    reviewVerdictPostedAt: statusAt,
    reviewPostRefused: false,
    ...over,
  };
}

function ledgerWith(rows: Array<Record<string, unknown>>): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t5840-`));
  const path = join(dir, "ledger.ndjson");
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return { dir, path };
}

function deps(path: string, armed: number[], reviewed: number[]): SweepDeps {
  return {
    arm: (pr) => { armed.push(pr.prNumber); return "armed"; },
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    postReview: (pr) => { reviewed.push(pr.prNumber); },
    ledgerPath: path,
    runId: "DAEMON-W1-T5840",
    now: () => NOW,
    readLedgerUnion: () => ({ complete: false, lines: [] }),
  };
}

function disposedRows(path: string): Array<Record<string, unknown>> {
  return readLedgerLines(path).filter((row) => row.step === "sweep.disposed" && row.pr_number === 9155);
}

function append(path: string, row: Record<string, unknown>): void {
  const rows = [...readLedgerLines(path), row];
  writeFileSync(path, rows.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

test("a delivered ledger failure followed by a newer GitHub success demands exactly one re-review for that status timestamp", async () => {
  const { dir, path } = ledgerWith([posted(FAILED_AT, "failure")]);
  try {
    const armed: number[] = [];
    const reviewed: number[] = [];
    await runSweep([view(FAILED_AT, STATUS_AT)], deps(path, armed, reviewed), DEFAULT_SWEEP_POLICY);
    const [row] = disposedRows(path);
    assert.equal(row.disposition, "post-review", String(row.reason));
    assert.match(String(row.reason), SUPERSEDES);
    assert.equal(row.acted, true, "the claim admits the re-review instead of standing down as DELIVERED");
    assert.deepEqual(reviewed, [9155], "the authoritative reviewer runs once");
    assert.deepEqual(armed, [], "the stale ledger failure is never armed over");

    // The re-review delivered a verdict newer than the status; the same status demands nothing more.
    append(path, posted(RE_REVIEW_AT, "failure"));
    await runSweep([view(RE_REVIEW_AT, STATUS_AT, { priorReviewAttemptsForInput: 2 })],
      deps(path, armed, reviewed), DEFAULT_SWEEP_POLICY);
    const again = disposedRows(path).at(-1)!;
    assert.doesNotMatch(String(again.reason), SUPERSEDES, "a repeat pass after the re-review demands nothing");
    assert.deepEqual(reviewed, [9155], "no second reviewer run for the same status timestamp");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a second success status with a newer timestamp may demand a re-review once more", async () => {
  const { dir, path } = ledgerWith([posted(FAILED_AT, "failure"), posted(RE_REVIEW_AT, "failure")]);
  try {
    const reviewed: number[] = [];
    await runSweep([view(RE_REVIEW_AT, NEWER_STATUS_AT, { priorReviewAttemptsForInput: 2 })],
      deps(path, [], reviewed), DEFAULT_SWEEP_POLICY);
    const [row] = disposedRows(path);
    assert.equal(row.disposition, "post-review", String(row.reason));
    assert.match(String(row.reason), SUPERSEDES);
    assert.deepEqual(reviewed, [9155]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a delivered success still ends the supersedes re-review demand", async () => {
  const { dir, path } = ledgerWith([posted(FAILED_AT, "success")]);
  try {
    const armed: number[] = [];
    const reviewed: number[] = [];
    await runSweep([view(FAILED_AT, STATUS_AT)], deps(path, armed, reviewed), DEFAULT_SWEEP_POLICY);
    const [row] = disposedRows(path);
    assert.notEqual(row.disposition, "post-review", String(row.reason));
    assert.doesNotMatch(String(row.reason), SUPERSEDES);
    assert.deepEqual(reviewed, [], "no reviewer is demanded for a delivered success");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failure the status does not overtake, or whose time is unreadable, demands nothing", () => {
  const failedMs = Date.parse(FAILED_AT);
  const overtaken = view(FAILED_AT, STATUS_AT);
  assert.equal(reviewDeliveredFailureOvertaken(overtaken, failedMs), true);
  assert.equal(reviewDeliveredFailureOvertaken(overtaken, undefined), false, "no delivered failure");
  assert.equal(reviewDeliveredFailureOvertaken(overtaken, Number.NaN), false, "unreadable failure time");
  assert.equal(reviewDeliveredFailureOvertaken(overtaken, Date.parse(STATUS_AT) + 1), false, "status older than the failure");
  assert.equal(reviewDeliveredFailureOvertaken(view(FAILED_AT, STATUS_AT, { reviewState: "failure" }), failedMs), false);
  assert.equal(reviewDeliveredFailureOvertaken(view(FAILED_AT, STATUS_AT, { checksState: "pending" }), failedMs), false);
});
