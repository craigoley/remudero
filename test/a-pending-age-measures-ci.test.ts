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
import { activeCiRerunEvidence } from "../src/lib/workflow-run.js";

const OWNER = "o";
const REPO = "r";
const NOW = Date.parse("2026-09-22T18:30:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const REQUIRED = ["ci", "coverage-ratchet"];

type CheckRun = { name: string; status: string; conclusion?: string; started_at?: string };

/** The views `buildOpenPrViews` produces for one open PR last touched at `updatedAt`. */
function viewsFor(checkRuns: CheckRun[], updatedAt: string,
  options: { required?: string[]; runs?: Record<string, unknown>[] } = {}) {
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
    if (/\/actions\/runs\?/.test(path) && options.runs) return { workflow_runs: options.runs };
    return [];
  };
  try {
    return buildOpenPrViews(OWNER, REPO, join(root, "ledger.ndjson"),
      { fetch, requiredContexts: () => options.required ?? REQUIRED });
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
  // age falls back to the PR's last activity: a minute old, and eligible for early review.
  const [view] = viewsFor([{ name: "ci", status: "queued" }], minutesAgo(1));
  assert.ok(view);
  assert.equal(view.checksPendingSince, undefined);
  const result = deriveDisposition(view, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(result.disposition, "post-review");
  assert.match(result.reason, /^checks pending 1m/);
  assert.match(result.reason, /review never posted/);
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

test("a unique verified CI rerun dates its missing required gate without resetting other waits", () => {
  const headSha = "6612".padEnd(40, "0");
  const required = ["remudero-review", "ci-gate"];
  const checks: CheckRun[] = [
    { name: "remudero-review", status: "completed", conclusion: "success", started_at: minutesAgo(90) },
    { name: "test-slow-shard (1/2)", status: "in_progress", started_at: minutesAgo(5) },
  ];
  const run = { id: 123, head_sha: headSha, path: ".github/workflows/ci.yml", status: "in_progress",
    conclusion: null, run_attempt: 2, run_started_at: minutesAgo(5) };
  assert.equal(activeCiRerunEvidence(null, headSha), undefined);
  assert.equal(activeCiRerunEvidence(run, "unbound"), undefined);
  assert.equal(activeCiRerunEvidence(run, headSha)?.startedAt, minutesAgo(5));
  const [view] = viewsFor(checks, minutesAgo(90), { required, runs: [run] });
  assert.ok(view);
  assert.equal(view.checksState, "pending");
  assert.equal(view.checksPendingSince, minutesAgo(5), JSON.stringify(view.workflowRuns));
  const disposition = deriveDisposition(view, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(disposition.disposition, "wait");
  assert.match(disposition.reason, /^checks pending 5m/);
  for (const changed of [
    { head_sha: "a".repeat(40) }, { path: ".github/workflows/other.yml" }, { run_attempt: 1 },
    { status: "completed" }, { conclusion: "failure" }, { run_started_at: "unreadable" }, { id: 0 },
  ]) {
    const [unproved] = viewsFor(checks, minutesAgo(90), { required, runs: [{ ...run, ...changed }] });
    assert.equal(unproved.checksPendingSince, undefined, JSON.stringify(changed));
    assert.equal(deriveDisposition(unproved, DEFAULT_SWEEP_POLICY, NOW).disposition, "blocked-ambiguous");
  }
  const [ambiguous] = viewsFor(checks, minutesAgo(90), { required, runs: [run, { id: 124, conclusion: null }] });
  assert.equal(ambiguous.checksPendingSince, undefined, "an unresolved second run is not a unique proof");
  const [otherMissing] = viewsFor(checks, minutesAgo(90), { required: [...required, "other-required"], runs: [run] });
  assert.equal(otherMissing.checksPendingSince, undefined, "CI cannot date a different missing requirement");
  const [otherSatisfied] = viewsFor([...checks,
    { name: "other-required", status: "completed", conclusion: "success" }], minutesAgo(90),
    { required: [...required, "other-required"], runs: [run] });
  assert.equal(otherSatisfied.checksPendingSince, minutesAgo(5), "every other CI requirement is satisfied");
  const [undatedGate] = viewsFor([...checks, { name: "ci-gate", status: "queued" }], minutesAgo(90), { required, runs: [run] });
  assert.equal(undatedGate.checksPendingSince, undefined, "a registered undated gate is not treated as absent");
  const [datedGate] = viewsFor([...checks,
    { name: "ci-gate", status: "in_progress", started_at: minutesAgo(90) }], minutesAgo(1), { required, runs: [run] });
  assert.equal(datedGate.checksPendingSince, minutesAgo(90), "a dated required check retains its original clock");
  assert.equal(deriveDisposition(datedGate, DEFAULT_SWEEP_POLICY, NOW).disposition, "blocked-ambiguous");
});
