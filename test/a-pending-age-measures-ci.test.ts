/**
 * W1-T4054 — A PULL REQUEST'S PENDING AGE MEASURES ITS CI, NOT ITS LAST ACTIVITY.
 *
 * `pendingAgeMinutes` reads `checksPendingSince ?? lastActivityAt`, and no producer ever set
 * `checksPendingSince`. So every push, comment or label moved `updated_at` and restarted the clock:
 * #6612's `sweep.disposed` reasons read "checks pending 6m, 7m, 1m, 2m, 4m, 3m, 8m, 9m" across four
 * pushes, and the 60-minute stale-pending escalation measured nothing about CI. The start time was
 * already on the rollup (`RestRollupEntry.startedAt`, W1-T2300); these fixtures drive the REAL
 * `buildOpenPrViews` over a fake REST fetch, then the REAL `deriveDisposition` over what it built.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { KNOWN_UNWIRED } from "../src/lib/producer-completeness.js";
import {
  DEFAULT_SWEEP_POLICY,
  checksPendingSinceFromRollup,
  deriveDisposition,
  type RollupCheckEntry,
} from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { buildOpenPrViews } from "../src/run-task.js";

const OWNER = "o";
const REPO = "r";
const NOW = Date.parse("2026-09-22T18:30:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const REQUIRED = ["ci", "coverage-ratchet"];

type CheckRun = { name: string; status: string; conclusion?: string; started_at?: string };

/** The views `buildOpenPrViews` produces for one open PR last touched at `updatedAt`. */
function viewsFor(checkRuns: CheckRun[], updatedAt: string) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t4054-`));
  const fetch = (args: string[]): unknown => {
    const path = args[args.length - 1] ?? "";
    if (/state=open/.test(path)) {
      return [{
        number: 6612,
        html_url: `https://github.com/${OWNER}/${REPO}/pull/6612`,
        head: { ref: "run-W1-TX-1", sha: "6612".padEnd(40, "0") },
        updated_at: updatedAt,
        body: "Remudero-Task: W1-TX",
        auto_merge: null,
        state: "open",
      }];
    }
    if (/check-runs/.test(path)) return { check_runs: checkRuns };
    if (/\/status/.test(path)) return { statuses: [] };
    return [];
  };
  try {
    return buildOpenPrViews(OWNER, REPO, join(root, "ledger.ndjson"), { fetch, requiredContexts: () => REQUIRED });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T4054: pending age starts at the pending check", () => {
  const rollup: RollupCheckEntry[] = [
    // Finished long ago: not pending, so it cannot date the pending state.
    { name: "lint-plan", status: "COMPLETED", conclusion: "SUCCESS", startedAt: minutesAgo(200) },
    // Two pending required checks: the EARLIEST start is when checks began pending.
    { name: "coverage-ratchet", status: "IN_PROGRESS", startedAt: minutesAgo(40) },
    { name: "ci", status: "QUEUED", startedAt: minutesAgo(75) },
    // Pending but not required: outside the gate, so it dates nothing.
    { name: "heartbeat-watch", status: "IN_PROGRESS", startedAt: minutesAgo(500) },
  ];
  assert.equal(checksPendingSinceFromRollup(rollup, REQUIRED), minutesAgo(75));
  // Unreadable protection judges every check (checksStateFromRollup's fail-closed arm), so the
  // monitor's start then counts too — the same gate, never a second one.
  assert.equal(checksPendingSinceFromRollup(rollup, undefined), minutesAgo(500));

  // End to end: the producer assigns it, so the disposition reads the CI's age.
  const [view] = viewsFor([{ name: "ci", status: "in_progress", started_at: minutesAgo(75) }], minutesAgo(75));
  assert.equal(view?.checksState, "pending");
  assert.equal(view?.checksPendingSince, minutesAgo(75));
});

test("W1-T4054: pr activity does not reset the pending age", () => {
  // The #6612 shape: a comment or label touched the PR a minute ago; the required check has been
  // pending for 70 minutes. The age is the check's, so the 60-minute ceiling fires.
  const [view] = viewsFor([{ name: "ci", status: "in_progress", started_at: minutesAgo(70) }], minutesAgo(1));
  assert.ok(view, "one open PR produces one view");
  const result = deriveDisposition(view, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(result.disposition, "blocked-ambiguous");
  assert.match(result.reason, /^stale-pending — checks pending 70m/);
});

test("W1-T4054: no start time keeps the old fallback", () => {
  // A rollup entry with no start time (e.g. a status context never created) dates nothing, so the
  // age falls back to the PR's last activity exactly as before: a minute old, so it waits.
  const [view] = viewsFor([{ name: "ci", status: "queued" }], minutesAgo(1));
  assert.ok(view);
  assert.equal(view.checksPendingSince, undefined);
  const result = deriveDisposition(view, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(result.disposition, "wait");
  assert.match(result.reason, /^checks pending 1m/);
  assert.equal(checksPendingSinceFromRollup([], REQUIRED), undefined);
  assert.equal(checksPendingSinceFromRollup(undefined, REQUIRED), undefined);
});

test("W1-T4054: a red or green rollup dates no pending state", () => {
  const green: RollupCheckEntry[] = [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: minutesAgo(10) }];
  const red: RollupCheckEntry[] = [
    { name: "ci", status: "COMPLETED", conclusion: "FAILURE", startedAt: minutesAgo(10) },
    { name: "coverage-ratchet", status: "IN_PROGRESS", startedAt: minutesAgo(90) },
  ];
  assert.equal(checksPendingSinceFromRollup(green, REQUIRED), undefined);
  assert.equal(checksPendingSinceFromRollup(red, REQUIRED), undefined, "red outranks pending, as in checksStateFromRollup");
});

test("W1-T4054: checksPendingSince is no longer recorded as unwired", () => {
  assert.equal("checksPendingSince" in KNOWN_UNWIRED, false);
});
