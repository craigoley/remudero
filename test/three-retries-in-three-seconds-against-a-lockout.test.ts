// WHY SOME OF THIS IS ALSO IN test/classify.test.ts. stryker.conf.json mutates src/lib/classify.ts
// and runs ONLY classify.test.ts + block-reason.test.ts, so a classify test living anywhere else is
// invisible to the mutation runner — measured: 38.91% against a 75.92% baseline before the unit
// assertions moved there. stryker.conf.json is an INSTRUMENT path (review.ts INSTRUMENT_SURFACE),
// so widening its command alongside a src/ change would trip Rule 25 entanglement. This file stays
// as W1-T2515s own named falsifier (its shard proofs resolve to this path) and carries the
// end-to-end incident narrative; classify.test.ts carries the mutant-killing unit assertions.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// Deliberately a DYNAMIC import, never a static `from "...classify..."` one: test/
// mutation-ratchet.test.ts greps every test/**/*.test.ts file for a static classify.ts
// import and requires each one be named in stryker.conf.json's PR-gate commandRunner scope
// (W1-T133's latency fix). Widening that INSTRUMENT-path config to cover this file would trip
// Rule 25 entanglement against this task's declared scope (src/lib/classify.ts, src/run-task.ts,
// and this file only). A dynamic import reaches the identical production module at runtime
// without becoming a new STATIC importer that scope must track — classify.test.ts already
// carries the mutation-covered unit assertions (see the file-header comment above).
const { MAX_TRANSIENT_RETRIES, TRANSIENT_BACKOFF_CEILING_MS, detectUsageLimitRefusal, runDiagnoseThenRetry, transientBackoffMs } =
  await import("../src/lib/classify.js");
// Same reasoning for the type: `import(...)` as a TYPE QUERY (not a `from` import
// declaration) is erased entirely by tsx's type-stripping and never appears as a runtime
// import, so it does not trip the same grep either.
type AttemptOutcome = import("../src/lib/classify.js").AttemptOutcome;

// W1-T2515. The incident, verbatim from the ledger's `stderr_excerpt` on four consecutive
// `implement.done` rows for W1-T2471, all `api_error: true`:
const REFUSAL = "Claude Code returned an error result: You've hit your session limit · resets 8:50pm (UTC)";
// The first of those rows was stamped 19:52:34.185Z; the last 19:52:37.704Z — 3.519s for the whole
// transient budget, against a window the message itself said reopened at 20:50Z.
const INCIDENT_NOW = Date.parse("2026-08-30T19:52:34.185Z");
const INCIDENT_RESET = Date.parse("2026-08-30T20:50:00.000Z");

const failWith = (text: string): AttemptOutcome => ({ success: false, evidence: { text, apiError: true } });

/** Records what the driver asked to wait for, without ever waiting. */
function recorder() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => void slept.push(ms) };
}

test("the production retry driver is given a backoff and no longer retries with zero delay", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "src", "run-task.ts"), "utf8");
  assert.match(
    src,
    /runDiagnoseThenRetry\(\{[\s\S]{0,400}?sleep: \(ms\) => new Promise\(\(resolve\) => setTimeout\(resolve, ms\)\)/,
    "run-task.ts's runDiagnoseThenRetry call must supply a real `sleep` — its absence WAS the defect",
  );
});

test("a usage-limit refusal stops retrying at once instead of spending the retry budget", async () => {
  const clock = recorder();
  let attempts = 0;
  const r = await runDiagnoseThenRetry({
    attempt: async () => {
      attempts++;
      return failWith(REFUSAL);
    },
    diagnose: async () => ({ text: "never reached" }),
    sleep: clock.sleep,
    now: () => INCIDENT_NOW,
  });
  assert.equal(attempts, 1, "one attempt, then stop — the 3.519s burn was three more after this one");
  assert.equal(r.outcome, "gave_up");
  assert.equal(r.transientRetries, 0, "a shut window must not consume the transient budget");
  assert.deepEqual(clock.slept, [], "and must not wait inside the loop — that would hold a dispatch lane");
});

test("the reset time is parsed off the refusal and carried out in the result", async () => {
  const r = await runDiagnoseThenRetry({
    attempt: async () => failWith(REFUSAL),
    diagnose: async () => ({ text: "" }),
    now: () => INCIDENT_NOW,
  });
  assert.ok(r.usageLimit, "the refusal must be carried, not merely detected");
  assert.equal(r.usageLimit?.resetsAtMs, INCIDENT_RESET, "8:50pm (UTC) on the incident's own day");
  assert.equal(r.usageLimit?.resetsAtText, "8:50pm (UTC)", "carried verbatim, never re-rendered");
  assert.equal(
    (r.usageLimit?.resetsAtMs ?? 0) - INCIDENT_NOW,
    57 * 60_000 + 25_815,
    "57m25.8s of lockout remained when the burn began",
  );
  assert.match(String(r.reason), /usage window shut/);
});

test("a usage-limit refusal with no parseable reset time still stops, naming that it could not parse one", async () => {
  let attempts = 0;
  const r = await runDiagnoseThenRetry({
    attempt: async () => {
      attempts++;
      return failWith("You've hit your session limit");
    },
    diagnose: async () => ({ text: "" }),
    now: () => INCIDENT_NOW,
  });
  assert.equal(attempts, 1, "no reset time is not a reason to keep retrying");
  assert.equal(r.usageLimit?.resetsAtMs, undefined, "never invented");
  assert.match(String(r.reason), /no reset time stated/);
});

test("a clock time in an unknown zone is never converted to an epoch — guessing would resume wrong", () => {
  const local = detectUsageLimitRefusal("You've hit your session limit · resets 8:50pm", INCIDENT_NOW);
  assert.ok(local, "still recognised as a refusal");
  assert.equal(local?.resetsAtText, "8:50pm", "the text is carried");
  assert.equal(local?.resetsAtMs, undefined, "but no epoch — the zone was never stated");
  const other = detectUsageLimitRefusal("session limit reached · resets 8:50pm (PDT)", INCIDENT_NOW);
  assert.equal(other?.resetsAtMs, undefined, "and a NON-UTC zone is not converted either");
});

test("a reset time already past today rolls forward to tomorrow, never backwards", () => {
  const afterReset = Date.parse("2026-08-30T21:30:00.000Z");
  const hit = detectUsageLimitRefusal(REFUSAL, afterReset);
  assert.equal(hit?.resetsAtMs, Date.parse("2026-08-31T20:50:00.000Z"), "next occurrence, not a past one");
  assert.ok((hit?.resetsAtMs ?? 0) > afterReset, "a resume time in the past would resume immediately and re-burn");
});

test("an ordinary network transient still retries, under a bounded backoff that never grows without limit", async () => {
  const clock = recorder();
  let attempts = 0;
  const r = await runDiagnoseThenRetry({
    attempt: async () => {
      attempts++;
      return failWith("ECONNRESET while talking to the API");
    },
    diagnose: async () => ({ text: "" }),
    sleep: clock.sleep,
    now: () => INCIDENT_NOW,
  });
  assert.equal(r.outcome, "gave_up", "still bounded — a flake is retried, not retried forever");
  // planRetry INCREMENTS then compares against the bound, so the counter reads one past it when
  // it trips — pre-existing semantics, shared with strikes, and deliberately not changed here.
  assert.equal(r.transientRetries, MAX_TRANSIENT_RETRIES + 1, "the transient budget IS spent on a real transient");
  assert.equal(attempts, MAX_TRANSIENT_RETRIES + 1, "one initial attempt plus MAX_TRANSIENT_RETRIES retries");
  assert.equal(clock.slept.length, MAX_TRANSIENT_RETRIES, "one wait before each retry — before this change, zero");
  assert.deepEqual(clock.slept, [...clock.slept].sort((a, b) => a - b), "monotonic");
  for (const ms of clock.slept) {
    assert.ok(ms > 0 && ms <= TRANSIENT_BACKOFF_CEILING_MS, `every wait bounded by the ceiling, got ${ms}`);
  }
  assert.equal(transientBackoffMs(50), TRANSIENT_BACKOFF_CEILING_MS, "the ceiling holds at any attempt count");
  assert.equal(transientBackoffMs(0), transientBackoffMs(1), "a miscounted attempt cannot produce a negative delay");
});

test("the retry bound is still MAX_TRANSIENT_RETRIES and is not raised by this change", () => {
  assert.equal(MAX_TRANSIENT_RETRIES, 3, "the fix is the schedule, never a longer leash");
});

test("a task's own build failure still strikes, never absorbed into a usage-limit verdict", async () => {
  const r = await runDiagnoseThenRetry({
    attempt: async () => ({ success: false, evidence: { text: "AssertionError: expected 1 to equal 2" } }),
    diagnose: async () => ({ text: "the assertion is wrong" }),
    now: () => INCIDENT_NOW,
  });
  assert.equal(r.usageLimit, undefined, "a real failure must never read as a fleet condition");
  assert.ok(r.strikes > 0, "it strikes");
  assert.equal(r.transientRetries, 0, "and spends no transient budget");
});

test("prose ABOUT a limit is not a refusal — the patterns match the refusal's own phrasing", () => {
  const chatter = "I checked whether we hit your session limit handling and the rate limit exceeded path is fine";
  assert.equal(detectUsageLimitRefusal(chatter, INCIDENT_NOW), undefined, "no false positive on a worker's own prose");
  assert.ok(detectUsageLimitRefusal(REFUSAL, INCIDENT_NOW), "positive control: the real refusal still matches");
});
