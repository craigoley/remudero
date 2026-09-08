import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GITHUB_THROTTLE_REFUSAL_RE,
  censusMergeStateFrom,
  probeGithubThrottle,
  type ThrottleProbeRun,
} from "../src/lib/retro.js";

// W1-T3132 — MEASURED 2026-09-08T07:26Z, in this order: `gh api rate_limit` reported EVERY bucket
// full (core 5000/5000); `gh api user` returned HTTP 403 "API rate limit exceeded"; so did the
// open-PR fetch. The probe read only the buckets, answered "available", and the retro stamped
// `source: github` on a census built from three refused fetches.

const REAL_403 =
  'gh: API rate limit exceeded for user ID 4397075. If you reach out to GitHub Support for help, ' +
  'please include the request ID F3F3:1C422 and timestamp 2026-09-08 07:26:52 UTC. (HTTP 403)';

/** A run that answers the buckets healthy and the live call however the test wants. */
const runWith = (live: { ok: boolean; stderr?: string }): ThrottleProbeRun => (args) =>
  args.includes("rate_limit")
    ? { ok: true, stdout: "5000", stderr: "" }
    : { ok: live.ok, stdout: live.ok ? "someone" : "", stderr: live.stderr ?? "" };

test("W1-T3132: a 403 rate-limit refusal reports unavailable even when /rate_limit says 5000/5000", () => {
  // THE EXACT SHAPE OBSERVED. Before this task the buckets alone answered, and answered "fine".
  const reason = probeGithubThrottle(runWith({ ok: false, stderr: REAL_403 }));
  assert.notEqual(reason, undefined, "the probe must not call GitHub available while it refuses calls");
  assert.match(String(reason), /secondary limit/);
  assert.match(String(reason), /while \/rate_limit still reports quota/);
});

test("W1-T3132: primary exhaustion still reports unavailable — W1-T132's behaviour is preserved", () => {
  const exhausted: ThrottleProbeRun = (args) =>
    args.includes("rate_limit") ? { ok: true, stdout: "0", stderr: "" } : { ok: true, stdout: "x", stderr: "" };
  assert.match(String(probeGithubThrottle(exhausted)), /rate limit exhausted \(0 remaining\)/);
});

test("W1-T3132: a healthy gateway still reports available — the fix does not make every run unavailable", () => {
  // THE POSITIVE CONTROL for the two refusals above.
  assert.equal(probeGithubThrottle(runWith({ ok: true })), undefined);
});

test("W1-T3132: a NON-rate-limit failure is not relabelled a throttle", () => {
  // A 404, a permissions error and a network drop are different conditions and keep their own
  // handling. Matching the status alone would swallow all of them, which is why the TEXT decides.
  assert.equal(probeGithubThrottle(runWith({ ok: false, stderr: "HTTP 404: Not Found" })), undefined);
  assert.equal(probeGithubThrottle(runWith({ ok: false, stderr: "Resource not accessible by integration" })), undefined);
  assert.equal(probeGithubThrottle(runWith({ ok: false, stderr: "getaddrinfo ENOTFOUND api.github.com" })), undefined);
});

test("W1-T3132: the refusal matcher drives both arms on literal text", () => {
  assert.equal(GITHUB_THROTTLE_REFUSAL_RE.test("API rate limit exceeded for user ID 4397075"), true);
  assert.equal(GITHUB_THROTTLE_REFUSAL_RE.test("You have exceeded a secondary rate limit"), true);
  assert.equal(GITHUB_THROTTLE_REFUSAL_RE.test("HTTP 404: Not Found"), false);
  assert.equal(GITHUB_THROTTLE_REFUSAL_RE.test("Resource not accessible by integration"), false);
});

test("W1-T3132: a probe that reports a reason makes the census read unavailable, not github", () => {
  // The join's own wiring, driven end to end: censusMergeStateFrom stamps `unavailable` when a
  // reason is present, which is what routes members to `unconfirmed` instead of printing a
  // confident zero. This is the line the whole task exists to change.
  const gh = {} as never;
  const armed = censusMergeStateFrom([], gh, probeGithubThrottle(runWith({ ok: false, stderr: REAL_403 })));
  assert.equal(armed.source, "unavailable");
  assert.match(String(armed.unavailableReason), /secondary limit/);
  // ...and a healthy probe still yields `github`, so the degrade is conditional, not permanent.
  const healthy = censusMergeStateFrom([], gh, probeGithubThrottle(runWith({ ok: true })));
  assert.equal(healthy.source, "github");
});
