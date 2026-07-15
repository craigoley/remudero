import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DIAGNOSE_AT_STRIKES,
  INITIAL_RETRY_STATE,
  MAX_STRIKES,
  MAX_TRANSIENT_RETRIES,
  classifyFailure,
  planRetry,
  runDiagnoseThenRetry,
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
