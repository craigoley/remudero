import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFixProgressInput, type FixProgressInput, type FixProgressJudge } from "../src/lib/fix-progress-judge.js";
import {
  judgeCappedRepair,
  DIAGNOSE_AT_STRIKES,
  INITIAL_RETRY_STATE,
  MAX_STRIKES,
  MAX_TRANSIENT_RETRIES,
  TRANSIENT_BACKOFF_BASE_MS,
  TRANSIENT_BACKOFF_CEILING_MS,
  USAGE_WINDOW_RESET_RE,
  classifyFailure,
  detectUsageLimitRefusal,
  planRetry,
  runDiagnoseThenRetry,
  transientBackoffMs,
  type AttemptOutcome,
  type FailureSignal,
} from "../src/lib/classify.js";

// ── acceptance #1: "network/5xx/CI-flake retries consume NO strike;
// deterministic failures do" — classifier unit tests over RECORDED fixtures.
// Every fixture below is the exact shape run-task.ts's failure surfaces
// produce: worker stderr/text, a `gh` CLI error, or a CI check conclusion
// (run-task.ts's RED_CONCLUSIONS universe).

test("classifyFailure: recorded TRANSIENT fixtures — network errors", () => {
  const fixtures: FailureSignal[] = [
    { text: "Error: connect ECONNREFUSED 140.82.112.6:443" },
    { text: "FetchError: request to https://api.github.com/ failed, reason: getaddrinfo ENOTFOUND api.github.com" },
    { text: "Error: socket hang up\n    at TLSSocket.socketOnEnd" },
    { text: "Error: connect ETIMEDOUT" },
    { text: "getaddrinfo EAI_AGAIN api.github.com" },
  ];
  for (const f of fixtures) assert.equal(classifyFailure(f), "transient", JSON.stringify(f));
});

test("classifyFailure: recorded TRANSIENT fixtures — gh/GitHub 5xx + rate-limit backpressure", () => {
  const fixtures: FailureSignal[] = [
    { text: "gh: Bad Gateway (HTTP 502)" },
    { text: "HTTP/2 503\ngh: Service Unavailable" },
    { text: "gh api error: 500 Internal Server Error" },
    { text: "You have exceeded a secondary rate limit. Please wait a few minutes." },
    { text: "API rate limit exceeded for installation ID 123." },
    { text: "You have triggered an abuse detection mechanism and have been temporarily blocked." },
  ];
  for (const f of fixtures) assert.equal(classifyFailure(f), "transient", JSON.stringify(f));
});

test("classifyFailure: recorded TRANSIENT fixtures — CI-runner infra flake", () => {
  const fixtures: FailureSignal[] = [
    { text: "Error: The runner has received a shutdown signal. This can happen when the runner service is stopped." },
    { text: "##[error]Lost communication with the server. Please check the runner logs." },
    { text: "write EIO: no space left on device" },
    // CI conclusions that say nothing about code correctness, even absent log text:
    { ciConclusion: "CANCELLED" },
    { ciConclusion: "TIMED_OUT" },
    { ciConclusion: "STARTUP_FAILURE" },
  ];
  for (const f of fixtures) assert.equal(classifyFailure(f), "transient", JSON.stringify(f));
});

test("classifyFailure: recorded DETERMINISTIC (STRIKE) fixtures", () => {
  const fixtures: FailureSignal[] = [
    // Real compiler/test failures — never transient regardless of subtype.
    { text: "src/lib/foo.ts(12,7): error TS2322: Type 'string' is not assignable to type 'number'." },
    { text: "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n1 !== 2" },
    { text: "1 failing\n  1) should classify correctly:\n     AssertionError: expected false to be true" },
    // A genuinely red required check — a real gate failure, not infra.
    { ciConclusion: "FAILURE" },
    { ciConclusion: "ACTION_REQUIRED" },
    { ciConclusion: "ERROR" },
    // A stuck/looping worker — a real problem worth diagnosing, not a blip.
    { subtype: "error_max_turns", text: "" },
    // No evidence at all ⇒ fail closed, never assumed transient.
    {},
  ];
  for (const f of fixtures) assert.equal(classifyFailure(f), "strike", JSON.stringify(f));
});

test("classifyFailure: a transient TEXT signature wins even under a deterministic-looking conclusion", () => {
  // Positive evidence of infra flake always wins — the conclusion alone is not
  // dispositive when the log itself names the real cause.
  const f: FailureSignal = { ciConclusion: "FAILURE", text: "gh: Bad Gateway (HTTP 502)" };
  assert.equal(classifyFailure(f), "transient");
});

// ── The pure strike/diagnose state machine ─────────────────────────────────

test("planRetry: TRANSIENT never touches strikes, bounded by MAX_TRANSIENT_RETRIES", () => {
  let state = INITIAL_RETRY_STATE;
  for (let i = 1; i <= MAX_TRANSIENT_RETRIES; i++) {
    const action = planRetry(state, "transient");
    assert.equal(action.kind, "retry_transient", `attempt ${i}`);
    assert.equal(action.state.strikes, 0, `attempt ${i}: strikes must stay 0`);
    assert.equal(action.state.transientRetries, i);
    state = action.state;
  }
  // One more transient failure exceeds the cap.
  const exhausted = planRetry(state, "transient");
  assert.equal(exhausted.kind, "give_up");
  assert.equal(exhausted.state.strikes, 0, "give-up on transient exhaustion is still strike-free");
  assert.match((exhausted as { reason: string }).reason, /transient retries exhausted/i);
});

test("planRetry: strike 1 retries blind; strike 2 (DIAGNOSE_AT_STRIKES) dispatches diagnose; strike 3 gives up", () => {
  assert.equal(DIAGNOSE_AT_STRIKES, 2, "acceptance #2 names TWO strikes");
  let state = INITIAL_RETRY_STATE;

  const first = planRetry(state, "strike");
  assert.equal(first.kind, "retry_strike");
  assert.equal(first.state.strikes, 1);
  state = first.state;

  const second = planRetry(state, "strike");
  assert.equal(second.kind, "diagnose", "two strikes must dispatch DIAGNOSE before any third patch");
  assert.equal(second.state.strikes, DIAGNOSE_AT_STRIKES);
  state = second.state;

  const third = planRetry(state, "strike");
  assert.equal(third.kind, "give_up", "no unbounded blind patching past MAX_STRIKES");
  assert.ok(state.strikes >= MAX_STRIKES);
});

// ── The diagnose-then-retry driver (acceptance #2's runnable proof) ────────

/** Build a scripted `attempt` fn from a queue of outcomes, recording the
 * `findings` argument each call received (the "never blind" falsifier). */
function scriptedAttempts(outcomes: AttemptOutcome[]): {
  attempt: (findings?: string) => Promise<AttemptOutcome>;
  callsFindings: (string | undefined)[];
} {
  const callsFindings: (string | undefined)[] = [];
  let i = 0;
  return {
    attempt: async (findings?: string) => {
      callsFindings.push(findings);
      const outcome = outcomes[Math.min(i, outcomes.length - 1)];
      i++;
      return outcome;
    },
    callsFindings,
  };
}

test("runDiagnoseThenRetry: a seeded double-failure produces a diagnose run in the ledger, never a third blind patch", async () => {
  const { attempt, callsFindings } = scriptedAttempts([
    { success: false, evidence: { text: "error TS2322: Type mismatch" } }, // strike 1
    { success: false, evidence: { text: "1 failing: AssertionError" } }, // strike 2 → diagnose
    { success: true }, // the diagnose-informed 3rd attempt succeeds
  ]);

  const ledger: { step: string; extra?: Record<string, unknown> }[] = [];
  let diagnoseCalls = 0;
  const result = await runDiagnoseThenRetry({
    attempt,
    diagnose: async () => {
      diagnoseCalls++;
      return { text: "DIAGNOSE REPORT: the failing assertion expects a 1-indexed count; code emits 0-indexed." };
    },
    log: (step, extra) => ledger.push({ step, extra }),
  });

  assert.equal(result.outcome, "success");
  assert.equal(result.strikes, DIAGNOSE_AT_STRIKES);
  assert.equal(result.diagnosed, true);
  assert.equal(result.attempts, 3);
  assert.equal(diagnoseCalls, 1, "diagnose dispatches exactly once, at the second strike");

  // The ledger carries a diagnose run — "paste the ledger showing … diagnose".
  assert.ok(ledger.some((l) => l.step === "diagnose.spawn"), "ledger must show diagnose.spawn");
  assert.ok(ledger.some((l) => l.step === "diagnose.done"), "ledger must show diagnose.done");

  // "never a third blind patch": the 1st and 2nd attempts are blind (no
  // findings yet); the 3rd attempt MUST receive the diagnose findings.
  assert.equal(callsFindings.length, 3);
  assert.equal(callsFindings[0], undefined, "1st attempt is blind");
  assert.equal(callsFindings[1], undefined, "2nd attempt (blind retry after strike 1) is still blind");
  assert.match(callsFindings[2] ?? "", /DIAGNOSE REPORT/, "3rd attempt must be diagnose-informed, never blind");
});

test("runDiagnoseThenRetry: transient failures retry with NO strike and never trigger diagnose", async () => {
  const { attempt } = scriptedAttempts([
    { success: false, evidence: { text: "gh: Bad Gateway (HTTP 502)" } },
    { success: false, evidence: { ciConclusion: "TIMED_OUT" } },
    { success: true },
  ]);
  let diagnoseCalls = 0;
  const result = await runDiagnoseThenRetry({
    attempt,
    diagnose: async () => {
      diagnoseCalls++;
      return { text: "" };
    },
  });
  assert.equal(result.outcome, "success");
  assert.equal(result.strikes, 0, "transient retries must consume NO strike");
  assert.equal(result.transientRetries, 2);
  assert.equal(result.diagnosed, false);
  assert.equal(diagnoseCalls, 0);
});

test("runDiagnoseThenRetry: exhausting strikes past the diagnose-informed retry gives up (bounded, no forever-loop)", async () => {
  const { attempt } = scriptedAttempts([
    { success: false, evidence: { text: "error TS2322" } }, // strike 1
    { success: false, evidence: { text: "1 failing" } }, // strike 2 → diagnose
    { success: false, evidence: { text: "1 failing" } }, // strike 3 → give up
  ]);
  let diagnoseCalls = 0;
  const result = await runDiagnoseThenRetry({
    attempt,
    diagnose: async () => {
      diagnoseCalls++;
      return { text: "DIAGNOSE REPORT: root cause unclear." };
    },
  });
  assert.equal(result.outcome, "gave_up");
  assert.equal(diagnoseCalls, 1, "diagnose still dispatches only once — it does not retry itself");
  assert.equal(result.diagnosed, true);
  assert.match(result.reason ?? "", /strikes exhausted/i);
});

// ── The Anthropic-side transient (server_error mid-response) — W1-T12a-1784117152056.
// A result carrying the api-error signature is TRANSIENT (retry, no strike), NOT a task
// failure. This is the SECOND Anthropic-side transient (the autoupdater race was first). ──
test("classifyFailure: the apiError flag classifies TRANSIENT (server_error / <synthetic> / isApiErrorMessage)", () => {
  assert.equal(classifyFailure({ apiError: true }), "transient");
  assert.equal(classifyFailure({ apiError: true, subtype: "success" }), "transient");
});

test("classifyFailure: the 'Server error mid-response' / overloaded text is TRANSIENT even without the flag", () => {
  assert.equal(
    classifyFailure({ text: "API Error: Server error mid-response. The response above may be incomplete." }),
    "transient",
  );
  assert.equal(classifyFailure({ text: "overloaded_error: the model is overloaded" }), "transient");
});

test("classifyFailure: a real task failure is still a STRIKE — no api-error false positive", () => {
  assert.equal(classifyFailure({ subtype: "error_max_turns" }), "strike");
  assert.equal(classifyFailure({ text: "AssertionError: expected 3 to equal 4" }), "strike");
  assert.equal(classifyFailure({ apiError: false, subtype: "success" }), "strike"); // no evidence ⇒ strike (fail-closed)
});

// ── W1-T2515: usage-window refusal + bounded backoff ────────────────────────────────────────
//
// THESE LIVE HERE, NOT IN THE TASK'S OWN FILE, ON PURPOSE. stryker.conf.json mutates
// `src/lib/classify.ts` and runs ONLY `test/classify.test.ts test/block-reason.test.ts`. A test
// for classify.ts placed in any third file is invisible to the mutation runner, so every mutant in
// the code it covers survives and the score collapses — measured: 38.91% against a 75.92% baseline.
// stryker.conf.json is an INSTRUMENT path (review.ts's INSTRUMENT_SURFACE), so widening its command
// alongside a src/ change would trip Rule 25 entanglement. The tests move; the instrument does not.

const REFUSAL = "Claude Code returned an error result: You've hit your session limit · resets 8:50pm (UTC)";
const NOW = Date.parse("2026-08-30T19:52:34.185Z");
const RESET = Date.parse("2026-08-30T20:50:00.000Z");

test("detectUsageLimitRefusal: 8:50pm (UTC) resolves to 20:50Z on the same day", () => {
  assert.equal(detectUsageLimitRefusal(REFUSAL, NOW)?.resetsAtMs, RESET);
});

test("detectUsageLimitRefusal: pinned Codex subscription refusal families are provider-neutral", () => {
  const refusals = [
    "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again later.",
    "Your workspace is out of credits. Add credits to continue.",
    "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.",
    "You hit your spend cap set in your workspace. Increase your spend cap to continue.",
    "You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.",
    "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
  ];
  for (const refusal of refusals) {
    assert.ok(detectUsageLimitRefusal(refusal, NOW), refusal);
  }
});

test("detectUsageLimitRefusal: nearby Codex prose is not a refusal", () => {
  const controls = [
    "The workspace credits report is ready.",
    "Please document how spend caps work in a ChatGPT workspace.",
    "The task discusses a usage limit without saying that this account hit it.",
  ];
  for (const control of controls) {
    assert.equal(detectUsageLimitRefusal(control, NOW), undefined, control);
  }
});

// Conversion is tested from EARLY in the day so every expected time is still ahead of `now` —
// otherwise the same-day/next-day rollover (covered separately below) would mask a bad conversion.
const EARLY = Date.parse("2026-08-30T00:05:00.000Z");

test("detectUsageLimitRefusal: pm ADDS twelve hours, and only below noon", () => {
  // kills `hour -= 12`, `hour >= 12`, `hour <= 12`, `meridiem !== "pm"`, `if (true)`, `if (false)`
  const at1 = detectUsageLimitRefusal("session limit reached · resets 1:00pm (UTC)", EARLY)?.resetsAtMs;
  assert.equal(at1, Date.parse("2026-08-30T13:00:00.000Z"), "1pm is 13:00, not 01:00 and not -11:00");
  const noon = detectUsageLimitRefusal("session limit reached · resets 12:00pm (UTC)", EARLY)?.resetsAtMs;
  assert.equal(noon, Date.parse("2026-08-30T12:00:00.000Z"), "12pm is NOON — adding 12 would make it midnight");
  const h23 = detectUsageLimitRefusal("session limit reached · resets 23:30 (UTC)", EARLY)?.resetsAtMs;
  assert.equal(h23, Date.parse("2026-08-30T23:30:00.000Z"), "a 24-hour clock time is left alone");
});

test("detectUsageLimitRefusal: 12am is midnight, and no other am hour is touched", () => {
  // kills `meridiem !== "am"`, `hour !== 12`, `if (true)`, `if (false)`, the "" string mutants
  const midnight = detectUsageLimitRefusal("session limit reached · resets 12:15am (UTC)", EARLY)?.resetsAtMs;
  assert.equal(midnight, Date.parse("2026-08-30T00:15:00.000Z"), "12:15am is 00:15, not 12:15");
  const am7 = detectUsageLimitRefusal("session limit reached · resets 7:05am (UTC)", EARLY)?.resetsAtMs;
  assert.equal(am7, Date.parse("2026-08-30T07:05:00.000Z"), "7am is 07:00, untouched");
});

test("detectUsageLimitRefusal: an out-of-range clock time yields no epoch — the reachable bound", () => {
  // kills `hour > 23` -> `>=`/`<=`/true/false and the same family on minute
  const badHour = detectUsageLimitRefusal("session limit reached · resets 99:00 (UTC)", NOW);
  assert.equal(badHour?.resetsAtMs, undefined, "hour 99 is refused");
  const badMin = detectUsageLimitRefusal("session limit reached · resets 10:99 (UTC)", NOW);
  assert.equal(badMin?.resetsAtMs, undefined, "minute 99 is refused");
  const ok23 = detectUsageLimitRefusal("session limit reached · resets 23:59 (UTC)", NOW);
  assert.ok(ok23?.resetsAtMs, "23:59 is IN range — a `>=` bound would wrongly refuse it");
});

test("detectUsageLimitRefusal: the rollover adds exactly 24 hours, and the boundary is >=", () => {
  // kills `candidate - 24*60*60*1000`, the `/` arithmetic mutants, and `>` vs `>=` vs `<`
  const justAfter = detectUsageLimitRefusal(REFUSAL, RESET + 1);
  assert.equal(justAfter?.resetsAtMs, RESET + 24 * 60 * 60 * 1000, "one ms past reset rolls a full day");
  assert.equal(
    (justAfter?.resetsAtMs ?? 0) - RESET,
    86_400_000,
    "exactly 86400000ms — a divide mutant would produce 1440 or 0.024",
  );
  const exactly = detectUsageLimitRefusal(REFUSAL, RESET);
  assert.equal(exactly?.resetsAtMs, RESET, "AT the reset instant is not past it — the bound is >=, not >");
});

test("transientBackoffMs: doubles from the base, and the ceiling clamps it", () => {
  // kills Math.min->Math.max, Math.max->Math.min, 2**(n-1)->2**(n+1), BASE*->BASE/
  assert.equal(transientBackoffMs(1), TRANSIENT_BACKOFF_BASE_MS, "the first wait IS the base");
  assert.equal(transientBackoffMs(2), TRANSIENT_BACKOFF_BASE_MS * 2, "then doubles");
  assert.equal(transientBackoffMs(3), TRANSIENT_BACKOFF_BASE_MS * 4);
  assert.equal(transientBackoffMs(99), TRANSIENT_BACKOFF_CEILING_MS, "and is clamped, never grows");
  assert.ok(transientBackoffMs(99) < TRANSIENT_BACKOFF_BASE_MS * 2 ** 98, "clamped BELOW the raw value");
  assert.equal(transientBackoffMs(0), TRANSIENT_BACKOFF_BASE_MS, "attempts below 1 clamps UP to the base");
  assert.equal(transientBackoffMs(-5), TRANSIENT_BACKOFF_BASE_MS, "never negative, never zero");
});

test("runDiagnoseThenRetry: a shut window returns the reason and the refusal, and logs the step", () => {
  // kills the `if (usageLimit) {}` block mutant, `if (false)`, the empty-object and "" log mutants,
  // the `outcome: ""` mutant, and both branches of the reason ternary
  const steps: string[] = [];
  const payloads: Array<Record<string, unknown>> = [];
  return runDiagnoseThenRetry({
    attempt: async () => ({ success: false, evidence: { text: REFUSAL, apiError: true } }),
    diagnose: async () => ({ text: "" }),
    now: () => NOW,
    log: (step, extra) => {
      steps.push(step);
      payloads.push(extra ?? {});
    },
  }).then((r) => {
    assert.equal(r.outcome, "gave_up", "not an empty-string outcome");
    assert.equal(r.usageLimit?.resetsAtMs, RESET);
    assert.match(String(r.reason), /^usage window shut — .+ \(resets 8:50pm \(UTC\)\)$/);
    assert.ok(steps.includes("retry.usage_limit"), "the step name is real, not an empty string");
    const p = payloads[steps.indexOf("retry.usage_limit")];
    assert.equal(p.resets_at_ms, RESET, "the payload carries the parsed reset, not an empty object");
    assert.equal(p.matched, "You've hit your session limit");
  });
});

test("runDiagnoseThenRetry: no reset time takes the OTHER branch of the reason ternary", () => {
  return runDiagnoseThenRetry({
    attempt: async () => ({ success: false, evidence: { text: "You've hit your session limit", apiError: true } }),
    diagnose: async () => ({ text: "" }),
    now: () => NOW,
  }).then((r) => {
    assert.equal(r.reason, "usage window shut — You've hit your session limit (no reset time stated)");
    assert.equal(r.usageLimit?.resetsAtMs, undefined);
  });
});

test("runDiagnoseThenRetry: the sleep seam is actually consulted between transient retries", () => {
  // kills `if (false) await deps.sleep(...)`
  const slept: number[] = [];
  return runDiagnoseThenRetry({
    attempt: async () => ({ success: false, evidence: { text: "ECONNRESET", apiError: true } }),
    diagnose: async () => ({ text: "" }),
    now: () => NOW,
    sleep: async (ms) => void slept.push(ms),
  }).then(() => {
    assert.deepEqual(slept, [TRANSIENT_BACKOFF_BASE_MS, TRANSIENT_BACKOFF_BASE_MS * 2, TRANSIENT_BACKOFF_BASE_MS * 4]);
  });
});

test("USAGE_WINDOW_RESET_RE: it ACCEPTS a real reset clause and REFUSES text carrying no clock time", () => {
  // W1-T2317's negative-reachability contract: BOTH arms, named, with each outcome asserted in the
  // invocation's own window — so the refusal is provably distinct from acceptance rather than
  // merely present. This regex decides whether a resume time is believed at all.
  assert.equal(
    USAGE_WINDOW_RESET_RE.test("You've hit your session limit · resets 8:50pm (UTC)"),
    true,
    "the healthy arm: a real refusal's clause matches",
  );
  assert.equal(USAGE_WINDOW_RESET_RE.exec("resets 8:50pm (UTC)")?.[1], "8", "and the hour is captured");
  assert.equal(USAGE_WINDOW_RESET_RE.exec("resets 8:50pm (UTC)")?.[4], "UTC", "and the zone");
  assert.equal(
    USAGE_WINDOW_RESET_RE.test("You've hit your session limit, try later"),
    false,
    "the refusing arm: a limit message with NO reset clause matches nothing, so no epoch is invented",
  );
  assert.equal(
    USAGE_WINDOW_RESET_RE.test("the reset button was pressed"),
    false,
    "and prose containing the word reset but no time is refused too",
  );
});

// W1-T7243: the classify-side budgets defer to the progress judge. These live here, inside
// stryker's commandRunner, so their assertions kill classify.ts mutants (W1-T133).
const input = () => buildFixProgressInput({ taskId: "W1-T7243", prNumber: 7243, headSha: "head", currentRed: ["ci"], ledger: [] });
const continueJudge: FixProgressJudge = async () => ({ verdict: "continue", reason: "new evidence" });

test("capped body and plan judgments hold unavailable and carry their named loop", async () => {
  for (const capable of [false, true]) {
    const state = { bodyStrikes: 4, planRepairStrikes: 4 };
    const opts = { planRepairCapable: capable, input: input(), judge: continueJudge };
    assert.equal((await judgeCappedRepair(state, 2, opts)).kind, capable ? "repair_plan_shard" : "repair_body");
    const changed = await judgeCappedRepair(state, 2, { ...opts, judge: async () => ({ verdict: "change-approach", approach: "reproduce", reason: "new route" }) });
    assert.equal(changed.progress?.verdict, "change-approach");
    assert.equal((await judgeCappedRepair(state, 2, { ...opts, judge: async () => undefined })).kind, "hold");
    const stopped = await judgeCappedRepair(state, 2, { ...opts, judge: async () => ({ verdict: "escalate", loop: "same proof forever", reason: "no progress" }) });
    assert.equal(stopped.kind, "give_up");
    assert.match(stopped.reason!, /same proof forever/);
  }
});

test("diagnose-informed retries and transient retries continue past their old ceilings", async () => {
  for (const text of ["test failed", "ECONNRESET"]) {
    let attempts = 0;
    const judgments: unknown[] = [];
    const result = await runDiagnoseThenRetry({
      attempt: async () => ++attempts === 6 ? { success: true } : { success: false, evidence: { text } },
      diagnose: async () => ({ text: "inspect failing test" }),
      fixProgressJudge: async facts => { judgments.push(facts); return { verdict: "continue", reason: "new evidence" }; },
    });
    assert.equal(result.outcome, "success");
    assert.equal(attempts, 6);
    assert.ok(judgments.length >= 2);
  }
});

test("retry judgment escalates its loop and holds an unavailable response", async () => {
  for (const verdict of ["escalate", "unavailable", "change-approach"] as const) {
    let attempts = 0;
    let approach: string | undefined;
    const result = await runDiagnoseThenRetry({
      attempt: async findings => {
        approach = findings;
        return ++attempts === 5 ? { success: true } : { success: false, evidence: { text: "test failed" } };
      }, diagnose: async () => ({ text: "failure diagnosis" }),
      progressInput: input(),
      fixProgressJudge: async facts => {
        assert.equal(facts.rounds.length, attempts);
        assert.deepEqual(facts.currentRed, ["test failed"]);
        return verdict === "unavailable" ? undefined : verdict === "escalate"
          ? { verdict, loop: "same patch forever", reason: "no progress" }
          : { verdict, approach: "reproduce with the real fixture", reason: "new evidence" };
      },
    });
    assert.equal(result.outcome, verdict === "unavailable" ? "held" : verdict === "escalate" ? "gave_up" : "success");
    if (verdict === "escalate") assert.match(result.reason!, /same patch forever/);
    if (verdict === "change-approach") assert.match(approach!, /reproduce with the real fixture/);
  }
});

test("capped repair asks at the body boundary and judges only an adopted plan rung", async () => {
  const base = input();
  for (const fixture of [
    { body: 2, plan: 0, capable: true, site: "capped-body", spent: 2, ceiling: 2, kind: "repair_body" },
    { body: 5, plan: 0, capable: true, site: "capped-body", spent: 5, ceiling: 2, kind: "repair_body" },
    { body: 5, plan: 1, capable: true, site: "plan-repair", spent: 1, ceiling: 2, kind: "repair_plan_shard" },
    { body: 5, plan: 7, capable: true, site: "plan-repair", spent: 7, ceiling: 2, kind: "repair_plan_shard" },
    { body: 5, plan: 7, capable: false, site: "capped-body", spent: 5, ceiling: 2, kind: "repair_body" },
  ]) {
    const facts: FixProgressInput[] = [];
    const logs: unknown[] = [];
    const result = await judgeCappedRepair({ bodyStrikes: fixture.body, planRepairStrikes: fixture.plan }, 2, {
      input: base, planRepairCapable: fixture.capable,
      judge: async value => { facts.push(value); return { verdict: "continue", reason: "fresh evidence" }; },
      log: (step, fields) => logs.push({ step, ...fields }),
    });
    const parkedReason = `${fixture.site}: ${fixture.spent} prior repairs`;
    assert.deepEqual(facts, [{ ...base, strikesSpent: fixture.spent,
      formerCeiling: fixture.ceiling, parkedReason }]);
    assert.deepEqual(result, { kind: fixture.kind, reason: "fresh evidence",
      progress: { verdict: "continue", reason: "fresh evidence" } });
    assert.deepEqual(logs, [{ step: "fix.progress_judged", site: fixture.site,
      pr_number: base.prNumber, head_sha: base.headSha, former_ceiling: fixture.ceiling,
      parked_reason: parkedReason, round_count: base.rounds.length, signals: base.signals,
      verdict: "continue", reason: "fresh evidence" }]);
  }
  const untouched = await judgeCappedRepair({ bodyStrikes: 1, planRepairStrikes: 7 }, 2, {
    input: base, planRepairCapable: true,
    judge: async () => { assert.fail("a body repair below its threshold needs no judgment"); },
    log: () => assert.fail("no judgment was made"),
  });
  assert.deepEqual(untouched, { kind: "repair_body" });
});

test("capped repair preserves approach, hold reason and the full escalation reason", async () => {
  for (const planRepairCapable of [false, true]) {
    for (const verdict of [
      { verdict: "change-approach", approach: "use the real fixture", reason: "different evidence" } as const,
      { verdict: "escalate", loop: "identical patch", reason: "unchanged failure" } as const,
      undefined,
    ]) {
      const progress = verdict ?? { verdict: "unavailable", reason: "absent or unparseable fix progress verdict; re-ask next pass" };
      const result = await judgeCappedRepair({ bodyStrikes: 6, planRepairStrikes: 4 }, 3, {
        input: input(), planRepairCapable, judge: async () => verdict,
      });
      assert.deepEqual(result, {
        kind: verdict === undefined ? "hold" : verdict.verdict === "escalate" ? "give_up"
          : planRepairCapable ? "repair_plan_shard" : "repair_body",
        reason: verdict?.verdict === "escalate" ? "fix progress loop: identical patch — unchanged failure" : progress.reason,
        progress,
      });
    }
  }
});

test("retry judge receives the observed counts, history, identity and diagnosis for each remedy", async () => {
  for (const transient of [false, true]) {
    const base = { ...input(), operatorAnswer: "keep investigating" };
    const text = transient ? "ECONNRESET" : "test failed";
    const count = transient ? 4 : 3;
    const facts: FixProgressInput[] = [];
    const logs: { step: string; fields?: Record<string, unknown> }[] = [];
    const sleeps: number[] = [];
    let attempts = 0;
    const result = await runDiagnoseThenRetry({
      progressInput: base,
      attempt: async () => { attempts++; return { success: false, evidence: { text } }; },
      diagnose: async () => ({ text: "inspect the assertion" }),
      fixProgressJudge: async value => { facts.push(value); return { verdict: "escalate", loop: "same failure", reason: "no new evidence" }; },
      log: (step, fields) => logs.push({ step, fields }),
      sleep: async ms => { sleeps.push(ms); },
    });
    const site = transient ? "transient-retry" : "diagnose-retry";
    const reason = transient ? "transient retries exhausted (3)" : "strikes exhausted (2); diagnosis: inspect the assertion";
    const expected = buildFixProgressInput({ taskId: base.taskId, prNumber: base.prNumber,
      headSha: base.headSha, currentRed: [text], operatorAnswer: base.operatorAnswer,
      ledger: Array.from({ length: count }, (_, i) => [
        { task_id: base.taskId, step: "fix.dispatch", round_id: String(i + 1), ci_failures: [text] },
        { task_id: base.taskId, step: "fix.done", round_id: String(i + 1), subtype: "failure" },
      ]).flat(),
    });
    expected.strikesSpent = count;
    expected.formerCeiling = transient ? 3 : 2;
    expected.parkedReason = `${site}: ${reason}`;
    assert.deepEqual(facts, [expected]);
    assert.equal(attempts, count);
    assert.deepEqual(result, { outcome: "gave_up", strikes: transient ? 0 : count,
      transientRetries: transient ? count : 0, diagnosed: !transient, attempts: count,
      exhaustedClass: transient ? "transient" : "strike",
      reason: "fix progress loop: same failure — no new evidence" });
    assert.deepEqual(sleeps, transient ? [1000, 2000, 4000] : [1000]);
    assert.deepEqual(logs.filter(row => row.step === "fix.progress_judged"), [{ step: "fix.progress_judged",
      fields: { site, parked_reason: expected.parkedReason, former_ceiling: expected.formerCeiling,
        round_count: count, signals: expected.signals, verdict: "escalate", loop: "same failure", reason: "no new evidence" } }]);
    assert.deepEqual(logs.at(-1), { step: "retry.exhausted", fields: { attempts: count,
      reason: result.reason, strikes: result.strikes, transient_retries: result.transientRetries } });
  }
});

test("retry judge falls back to subtype or unknown evidence and holds with exact counters", async () => {
  for (const evidence of [{ subtype: "error_max_turns" }, {}]) {
    let attempts = 0;
    const facts: FixProgressInput[] = [];
    const result = await runDiagnoseThenRetry({
      attempt: async () => { attempts++; return { success: false, evidence }; },
      diagnose: async () => ({ text: "" }),
      fixProgressJudge: async value => { facts.push(value); return undefined; },
    });
    assert.deepEqual(result, { outcome: "held", strikes: 3, transientRetries: 0, diagnosed: true, attempts: 3,
      reason: "absent or unparseable fix progress verdict; re-ask next pass" });
    assert.equal(attempts, 3);
    assert.equal(facts.length, 1);
    assert.equal(facts[0].taskId, "retry");
    assert.equal(facts[0].headSha, "uncommitted");
    assert.deepEqual(facts[0].currentRed, [evidence.subtype ?? "unknown failure"]);
    assert.deepEqual(facts[0].rounds.map(round => round.redBefore), Array(3).fill(facts[0].currentRed));
    assert.equal(facts[0].parkedReason, "diagnose-retry: strikes exhausted (2)");
  }
});

test("judge-admitted retries keep their backoff and pass an approach without a prior diagnosis", async () => {
  for (const changed of [false, true]) {
    let attempts = 0;
    const findings: (string | undefined)[] = [];
    const sleeps: number[] = [];
    const result = await runDiagnoseThenRetry({
      attempt: async value => { findings.push(value); return ++attempts === 5
        ? { success: true } : { success: false, evidence: { text: "ECONNRESET" } }; },
      diagnose: async () => { assert.fail("transient retries do not diagnose"); },
      sleep: async ms => { sleeps.push(ms); },
      fixProgressJudge: async () => changed
        ? { verdict: "change-approach", approach: "try another endpoint", reason: "new route" }
        : { verdict: "continue", reason: "network recovering" },
    });
    assert.deepEqual(result, { outcome: "success", strikes: 0, transientRetries: 4, diagnosed: false, attempts: 5 });
    assert.deepEqual(sleeps, [1000, 2000, 4000, 8000]);
    assert.deepEqual(findings, [undefined, undefined, undefined, undefined,
      changed ? "\nApproach: try another endpoint" : undefined]);
  }
});
