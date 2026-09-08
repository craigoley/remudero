// W1-T3132 — `probeGithubThrottle` reads ONLY `.rate.remaining` from `gh api rate_limit`, so a
// SECONDARY (abuse/concurrency) rate limit is invisible to it: MEASURED BY HAND 2026-09-08,
// `/rate_limit` reported every PRIMARY bucket full (5000/5000) while `gh api user` and the PR
// fetches it backs still 403'd. `unavailable()` is a PRE-FLIGHT probe and cannot see that; the
// union's OWN fetches (`findMergedByTrailer`/`headRefName`) already know, because production's
// `ghGateway` (lib/status.ts) classifies every failed read and exposes it via `readFailed()` /
// `readFailureReason()`. This shard proves `buildGather` now folds a RATE-LIMIT-classified
// post-fetch failure into the merge-state join's availability verdict — never a 404 or a network
// drop, which keep `shippedSince`'s existing silent "no evidence either" handling untouched.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGather, renderGather, type ShippedGithub } from "../src/lib/retro.js";

function line(runId: string, taskId: string, verdict: string, prUrl?: string): string[] {
  return [
    `{"ts":"2026-09-08T07:00:00.000Z","run_id":"${runId}","task_id":"${taskId}","step":"run.start","type":"implement"}`,
    `{"ts":"2026-09-08T07:26:00.000Z","run_id":"${runId}","task_id":"${taskId}","step":"verdict","verdict":"${verdict}","cost_usd":5${
      prUrl ? `,"pr_url":"${prUrl}"` : ""
    }}`,
  ];
}

const RUN_A = "W1-T9001-1788850000000";
const RUN_B = "W1-T9002-1788850100000";
const LEDGER = [...line(RUN_A, "W1-T9001", "blocked_ci"), ...line(RUN_B, "W1-T9002", "blocked_review")].join("\n");

/** MEASURED shape (2026-09-08T07:26Z): `/rate_limit` full (`unavailable()` sees nothing) while
 *  the union's OWN fetches already 403'd and the gateway classified it `"rate_limit"`. */
const SECONDARY_LIMIT_GATEWAY: ShippedGithub = {
  findMergedByTrailer: () => null, // every real call refused — no evidence, exactly like a 403
  headRefName: () => undefined,
  unavailable: () => undefined, // `/rate_limit` reports every primary bucket full
  readFailed: () => true,
  readFailureReason: () => "rate_limit",
};

const HEALTHY_GATEWAY: ShippedGithub = {
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  unavailable: () => undefined,
  readFailed: () => false,
  readFailureReason: () => undefined,
};

const PRIMARY_EXHAUSTED_GATEWAY: ShippedGithub = {
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  unavailable: () => "GitHub API rate limit exhausted (0 remaining)",
  // The pre-flight probe already caught it; the fetches behind it never even ran.
};

// A 404 / network drop: the gateway DID fail, but not on a rate limit — must keep whatever
// handling `shippedSince` already gives a failed-but-not-rate-limited read (silent, unchanged).
const NON_RATE_LIMIT_FAILURE_GATEWAY: ShippedGithub = {
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  unavailable: () => undefined,
  readFailed: () => true,
  readFailureReason: () => "transport",
};

test("acceptance 1: a 403 rate-limit refusal from a board fetch makes the census source read unavailable, even when /rate_limit reports every bucket full", () => {
  const g = buildGather({ ledgerNdjson: LEDGER, learningsMd: "", github: SECONDARY_LIMIT_GATEWAY });
  assert.equal(g.mast.mergeStateSource, "unavailable", "the secondary limit must degrade the join, not read as a healthy github source");
  assert.ok(g.githubUnavailable, "a reason must be captured on the gather");
  assert.match(g.githubUnavailable!, /rate limit/i);
});

test("acceptance 2: the rendered merge-state line distinguishes a measured zero from an unanswered join", () => {
  const secondaryLimited = renderGather(buildGather({ ledgerNdjson: LEDGER, learningsMd: "", github: SECONDARY_LIMIT_GATEWAY }));
  const healthy = renderGather(buildGather({ ledgerNdjson: LEDGER, learningsMd: "", github: HEALTHY_GATEWAY }));

  // The healthy zero prints a plain, confident "github" join with a real 0 count.
  assert.match(healthy, /Merge-state join: github — 0 verdict-blocked run\(s\) merged gate-side/);
  assert.doesNotMatch(healthy, /UNAVAILABLE/);

  // The secondary-limited run must NEVER print that same confident line: it prints UNAVAILABLE,
  // names the reason, and reads its members UNCONFIRMED rather than a genuine zero.
  assert.doesNotMatch(secondaryLimited, /Merge-state join: github/);
  assert.match(secondaryLimited, /Merge-state join: UNAVAILABLE/);
  assert.match(secondaryLimited, /member\(s\) UNCONFIRMED, never counted as failures/);
  assert.match(secondaryLimited, /GITHUB GATEWAY UNAVAILABLE/);
});

test("acceptance 3: primary exhaustion (remaining 0) still reports unavailable, preserving the existing W1-T132 behaviour", () => {
  const g = buildGather({ ledgerNdjson: LEDGER, learningsMd: "", github: PRIMARY_EXHAUSTED_GATEWAY });
  assert.equal(g.mast.mergeStateSource, "unavailable");
  assert.equal(g.githubUnavailable, "GitHub API rate limit exhausted (0 remaining)", "the pre-flight probe's own reason must still win, unmodified by the new fold");
});

test("acceptance 4: a healthy run with all fetches succeeding still reports source github, so the fix does not make every join unavailable", () => {
  const g = buildGather({ ledgerNdjson: LEDGER, learningsMd: "", github: HEALTHY_GATEWAY });
  assert.equal(g.mast.mergeStateSource, "github");
  assert.equal(g.githubUnavailable, undefined);
});

test("FALSIFIER: a failed-but-not-rate-limited fetch (404 / network drop) never flips the join — only a rate-limit classification does", () => {
  const g = buildGather({ ledgerNdjson: LEDGER, learningsMd: "", github: NON_RATE_LIMIT_FAILURE_GATEWAY });
  assert.equal(g.mast.mergeStateSource, "github", "a non-rate-limit failure keeps shippedSince's existing silent handling, never a false throttle");
  assert.equal(g.githubUnavailable, undefined);
});

test("FALSIFIER: a gateway that implements neither readFailed nor readFailureReason behaves exactly as before — no crash, no false unavailable", () => {
  const legacyGateway: ShippedGithub = { findMergedByTrailer: () => null, headRefName: () => undefined };
  const g = buildGather({ ledgerNdjson: LEDGER, learningsMd: "", github: legacyGateway });
  assert.equal(g.mast.mergeStateSource, "github");
  assert.equal(g.githubUnavailable, undefined);
});
