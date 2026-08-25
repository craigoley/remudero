import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ContainmentError,
  EGRESS_ALLOWED_HOST_FALLBACK,
  EGRESS_ALLOWED_MARKER,
  EGRESS_BLOCKED_HOST,
  EGRESS_BLOCKED_MARKER,
  EGRESS_TIMEOUT_SECONDS,
  OPERATOR_HOME_READ_SUCCESS_MARKER,
  PROBE_TURN_ALLOWANCE,
  STATE_READ_CONTROL_MARKER,
  TOKEN_READ_SUCCESS_MARKER,
  allowedHostFromSettings,
  assessContainment,
  assessEgressContainment,
  assessOperatorHomeReadContainment,
  assessTokenReadContainment,
  classifyUnprovenState,
  containmentProbePrompt,
  defaultExecutor,
  egressProbeCommand,
  operatorHomeReadProbeCommand,
  probeCommandCount,
  probeContainment,
  probeTurnBudget,
  stateReadControlBasename,
  tokenReadProbeCommand,
  type ContainmentEvidence,
  type ProbeExecResult,
} from "../src/lib/containment.js";
import type { Config } from "../src/lib/config.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";

function settingsFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-containment-test-"));
  const path = join(dir, "worker.json");
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

const ENABLED = {
  sandbox: { enabled: true, failIfUnavailable: true },
  permissions: { deny: [], allow: [], ask: [] },
};

// ── The PURE verdict (the falsifier lives here, LLM-free) ──────────────────

test("assessContainment: outside write OS-DENIED + denial seen ⇒ contained", () => {
  const v = assessContainment({
    outsideWriteCreated: false,
    osDenialSeen: true,
    insideWriteCreated: true,
  });
  assert.equal(v.contained, true);
});

test("assessContainment: outside write SUCCEEDED (sandbox dropped) ⇒ FAILS CLOSED", () => {
  const v = assessContainment({
    outsideWriteCreated: true,
    osDenialSeen: false,
    insideWriteCreated: true,
  });
  assert.equal(v.contained, false);
  assert.match(v.reason, /sandbox did not engage/i);
});

test("assessContainment: outside absent but NO denial observed ⇒ FAILS CLOSED (absence is not proof)", () => {
  const v = assessContainment({
    outsideWriteCreated: false,
    osDenialSeen: false,
    insideWriteCreated: false,
  });
  assert.equal(v.contained, false);
  assert.match(v.reason, /UNPROVEN/);
});

// ── probeContainment: the two fail-closed gates, via an injected executor ───

const denyingExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({
    transcript: `touch ../${token}.txt\ntouch: ../${token}.txt: Operation not permitted\ntouch probe-ok.txt`,
    outsideWriteCreated: false,
    insideWriteCreated: true,
    costUsd: 0,
  });

test("probeContainment: a sandbox-ENGAGED run (outside write OS-denied) PASSES", async () => {
  const res = await probeContainment({
    settingsFile: settingsFile(ENABLED),
    exec: denyingExec,
    token: "abc123",
  });
  assert.equal(res.contained, true);
  assert.match(res.reason, /OS-DENIED/);
});

test("probeContainment: a sandbox-DISABLED settings file FAILS CLOSED (config gate, before any spawn)", async () => {
  let spawned = false;
  await assert.rejects(
    () =>
      probeContainment({
        settingsFile: settingsFile({ sandbox: { enabled: false, failIfUnavailable: true } }),
        exec: async () => {
          spawned = true;
          return { transcript: "", outsideWriteCreated: false, insideWriteCreated: false };
        },
        token: "t",
      }),
    (e: unknown) => e instanceof ContainmentError && /does not declare an enabled sandbox/i.test((e as Error).message),
  );
  assert.equal(spawned, false, "the config gate fails closed BEFORE spawning a probe");
});

test("probeContainment: a silently-DROPPED sandbox (outside write landed) FAILS CLOSED", async () => {
  await assert.rejects(
    () =>
      probeContainment({
        settingsFile: settingsFile(ENABLED),
        token: "xyz",
        exec: async (token) => ({
          transcript: `touch ../${token}.txt   # succeeded, no error`,
          outsideWriteCreated: true, // the write LANDED — sandbox not engaged
          insideWriteCreated: true,
        }),
      }),
    (e: unknown) => e instanceof ContainmentError && /FAIL CLOSED/.test((e as Error).message),
  );
});

test("probeContainment: outside file absent but denial not tied to THIS token FAILS CLOSED", async () => {
  await assert.rejects(
    () =>
      probeContainment({
        settingsFile: settingsFile(ENABLED),
        token: "mytoken",
        exec: async () => ({
          // A denial phrase, but for some OTHER path — not our token ⇒ unproven.
          transcript: "some unrelated line: Operation not permitted on /elsewhere",
          outsideWriteCreated: false,
          insideWriteCreated: true,
        }),
      }),
    (e: unknown) => e instanceof ContainmentError,
  );
});

test("containmentProbePrompt: attempts an OUTSIDE-cwd write then an INSIDE-cwd write", () => {
  const p = containmentProbePrompt("tok");
  assert.match(p, /touch \.\.\/tok\.txt/);
  assert.match(p, /touch probe-ok\.txt/);
  assert.match(p, /OUTSIDE your working directory/i);
});

// ── W1-T91/P23: structured guard-cause on the thrown ContainmentError ───────

test("W1-T91 ACCEPTANCE: the UNPROVEN containment state (no OS-denial observed) round-trips as a NAMED sub-state, not the generic 'unproven' (W1-T1281)", async () => {
  // The transcript never mentions the token at all, though the probe DID land
  // its inside-cwd write — that specific combination is `write-never-attempted`
  // (W1-T1281's classifyUnprovenState), not the collapsed literal "unproven".
  await assert.rejects(
    () =>
      probeContainment({
        settingsFile: settingsFile(ENABLED),
        token: "mytoken",
        exec: async () => ({
          transcript: "some unrelated line: Operation not permitted on /elsewhere",
          outsideWriteCreated: false,
          insideWriteCreated: true,
        }),
      }),
    (e: unknown) => {
      assert.ok(e instanceof ContainmentError);
      const err = e as ContainmentError;
      assert.equal(err.guard, "containment");
      assert.equal(err.check, "outside-cwd-denial");
      assert.equal(err.observed, "write-never-attempted");
      assert.notEqual(err.observed, "unproven");
      return true;
    },
  );
});

test("ContainmentError: the sandbox-dropped state (outside write LANDED) is a PROVEN-BROKEN observed string, not 'unproven'", async () => {
  await assert.rejects(
    () =>
      probeContainment({
        settingsFile: settingsFile(ENABLED),
        token: "xyz",
        exec: async (token) => ({
          transcript: `touch ../${token}.txt   # succeeded, no error`,
          outsideWriteCreated: true,
          insideWriteCreated: true,
        }),
      }),
    (e: unknown) => {
      assert.ok(e instanceof ContainmentError);
      const err = e as ContainmentError;
      assert.equal(err.guard, "containment");
      assert.notEqual(err.observed, "unproven");
      assert.match(err.observed, /sandbox did not engage/i);
      return true;
    },
  );
});

// ── W1-T237: credential-dead worker gets a DISTINCT named reason, never the
// generic "unproven" — the misdiagnosis that cost the 2026-07-21 incident two
// days (a dead-auth worker and a compliant sandbox were byte-identical in the
// verdict). Planted-probe pattern: seed the exact verified CLI text ("Not
// logged in · Please run /login", isError true) and assert the verdict names it.

test("assessContainment: credentialFailure ⇒ FAILS CLOSED with the spawn_credential_failure reason, not generic unproven", () => {
  const v = assessContainment({
    outsideWriteCreated: false,
    osDenialSeen: false,
    insideWriteCreated: false,
    credentialFailure: true,
  });
  assert.equal(v.contained, false);
  assert.match(v.reason, /spawn_credential_failure/);
  assert.doesNotMatch(v.reason, /UNPROVEN/);
});

test("probeContainment: a seeded error-result carrying 'Not logged in · Please run /login' yields the credential-named reason, FAILS CLOSED", async () => {
  await assert.rejects(
    () =>
      probeContainment({
        settingsFile: settingsFile(ENABLED),
        token: "credtok",
        exec: async () => ({
          transcript: "Not logged in · Please run /login",
          outsideWriteCreated: false,
          insideWriteCreated: false,
          isError: true,
        }),
      }),
    (e: unknown) => {
      assert.ok(e instanceof ContainmentError);
      const err = e as ContainmentError;
      assert.equal(err.guard, "containment");
      assert.equal(err.check, "spawn-credential-failure");
      assert.equal(err.observed, "spawn_credential_failure");
      assert.match(err.message, /spawn_credential_failure/);
      return true;
    },
  );
});

test("probeContainment: a genuine no-write, no-denial, non-error run yields the NAMED write-never-attempted state, not the generic unproven (credential path does not swallow it)", async () => {
  await assert.rejects(
    () =>
      probeContainment({
        settingsFile: settingsFile(ENABLED),
        token: "mytoken",
        exec: async () => ({
          transcript: "some unrelated line: Operation not permitted on /elsewhere",
          outsideWriteCreated: false,
          insideWriteCreated: true,
          isError: false,
        }),
      }),
    (e: unknown) => {
      assert.ok(e instanceof ContainmentError);
      const err = e as ContainmentError;
      assert.equal(err.check, "outside-cwd-denial");
      assert.equal(err.observed, "write-never-attempted");
      assert.notEqual(err.observed, "unproven");
      return true;
    },
  );
});

// ── W1-T292 (phrases re-derived by W1-T2250): EXPIRED copied OAuth token — a
// SECOND, DISTINCT credential-dead signature from W1-T237's never-logged-in
// one. "Failed to authenticate. API Error: 401 OAuth access token has
// expired. Re-authenticate to continue" matches NEITHER CREDENTIAL_FAILURE_RE
// ("not logged in") NOR CREDENTIAL_LOGIN_HINT_RE ("run /login"), so it falls
// through to the generic unproven verdict unless the expired-token arm itself
// matches it — the exact misdiagnosis W1-T237 was built to prevent, just via a
// different message shape. (W1-T292's original fixture text, "OAuth session
// expired and could not be refreshed", is superseded — see W1-T2250.) ───────

test("assessContainment: credentialExpired ⇒ FAILS CLOSED with the DISTINCT spawn_credential_expired reason, never spawn_credential_failure or UNPROVEN", () => {
  const v = assessContainment({
    outsideWriteCreated: false,
    osDenialSeen: false,
    insideWriteCreated: false,
    credentialExpired: true,
  });
  assert.equal(v.contained, false);
  assert.match(v.reason, /spawn_credential_expired/);
  assert.doesNotMatch(v.reason, /spawn_credential_failure/);
  assert.doesNotMatch(v.reason, /UNPROVEN/);
});

test("probeContainment: a seeded error-result carrying 'Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue' (an EXPIRED copied token) yields the DISTINCT spawn_credential_expired reason, FAILS CLOSED", async () => {
  await assert.rejects(
    () =>
      probeContainment({
        settingsFile: settingsFile(ENABLED),
        token: "expiredtok",
        exec: async () => ({
          transcript: "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue",
          outsideWriteCreated: false,
          insideWriteCreated: false,
          isError: true,
        }),
      }),
    (e: unknown) => {
      assert.ok(e instanceof ContainmentError);
      const err = e as ContainmentError;
      assert.equal(err.guard, "containment");
      assert.equal(err.check, "spawn-credential-expired");
      assert.equal(err.observed, "spawn_credential_expired");
      // NOT the W1-T237 never-logged-in reason — the two symbols never collide.
      assert.notEqual(err.check, "spawn-credential-failure");
      assert.notEqual(err.observed, "spawn_credential_failure");
      assert.match(err.message, /spawn_credential_expired/);
      return true;
    },
  );
});

test("probeContainment: a seeded 'Not logged in · Please run /login' result still yields the UNMODIFIED W1-T237 spawn_credential_failure reason, not the new expired reason", async () => {
  // Guards against the fix regressing W1-T237: a locked/logged-out probe (never
  // logged in at all) must keep reporting spawn_credential_failure, not the new
  // spawn_credential_expired symbol — the two demand different operator action
  // (log in from scratch vs. refresh/re-mint an existing token).
  await assert.rejects(
    () =>
      probeContainment({
        settingsFile: settingsFile(ENABLED),
        token: "lockedtok",
        exec: async () => ({
          transcript: "Not logged in · Please run /login",
          outsideWriteCreated: false,
          insideWriteCreated: false,
          isError: true,
        }),
      }),
    (e: unknown) => {
      assert.ok(e instanceof ContainmentError);
      const err = e as ContainmentError;
      assert.equal(err.check, "spawn-credential-failure");
      assert.equal(err.observed, "spawn_credential_failure");
      assert.notEqual(err.check, "spawn-credential-expired");
      assert.notEqual(err.observed, "spawn_credential_expired");
      return true;
    },
  );
});

test("probeContainment: an UNRELATED error-result that merely mentions 'expired' (rate-limit / session-window text) is NOT mislabelled a credential expiry — falls through to the NAMED probe-never-ran state", async () => {
  await assert.rejects(
    () =>
      probeContainment({
        settingsFile: settingsFile(ENABLED),
        token: "ratelimittok",
        exec: async () => ({
          // Deliberately shares the word "expired" with the real signature but
          // carries neither the "oauth session expired" NOR the "could not be
          // refreshed" fragment — a rate-limit / session-window message, not an
          // auth-dead one. insideWriteCreated: false ⇒ the probe mechanism
          // itself never ran (W1-T1281's "probe-never-ran"), the state that
          // matters most and was previously indistinguishable from any other
          // unproven cause.
          transcript: "rate limit exceeded: the request session window expired, please retry later",
          outsideWriteCreated: false,
          insideWriteCreated: false,
          isError: true,
        }),
      }),
    (e: unknown) => {
      assert.ok(e instanceof ContainmentError);
      const err = e as ContainmentError;
      assert.equal(err.check, "outside-cwd-denial");
      assert.equal(err.observed, "probe-never-ran");
      assert.notEqual(err.observed, "unproven");
      assert.notEqual(err.observed, "spawn_credential_expired");
      assert.notEqual(err.observed, "spawn_credential_failure");
      return true;
    },
  );
});

test("probeContainment: isError alone (no credential-shaped text) does NOT trip the credential verdict — falls through to the NAMED probe-never-ran state", async () => {
  await assert.rejects(
    () =>
      probeContainment({
        settingsFile: settingsFile(ENABLED),
        token: "othererr",
        exec: async () => ({
          transcript: "some unrelated transport failure",
          outsideWriteCreated: false,
          insideWriteCreated: false,
          isError: true,
        }),
      }),
    (e: unknown) => {
      assert.ok(e instanceof ContainmentError);
      const err = e as ContainmentError;
      assert.equal(err.check, "outside-cwd-denial");
      assert.equal(err.observed, "probe-never-ran");
      assert.notEqual(err.observed, "unproven");
      return true;
    },
  );
});

// ── W1-T1281: the containment failure path no longer discards the evidence
// that would name its cause. Every non-outside-write failure used to collapse
// to the literal string "unproven"; classifyUnprovenState now names WHICH of
// three states occurred, derived purely from evidence rather than left for a
// reader to re-classify a blob. The verdict itself is UNCHANGED — all three
// remain `contained: false` and FAIL CLOSED (design part (iv)). ──────────────

test("classifyUnprovenState: a failure where the probe never ran at all is named as such rather than as unproven", () => {
  const state = classifyUnprovenState({
    outsideWriteCreated: false,
    osDenialSeen: false,
    insideWriteCreated: false, // the instrument itself did not run
    outsideWriteAttempted: false,
  });
  assert.equal(state, "probe-never-ran");
  assert.notEqual(state, "unproven");
});

test("classifyUnprovenState: a failure where the write step was never even reported is distinct from probe-never-ran", () => {
  const state = classifyUnprovenState({
    outsideWriteCreated: false,
    osDenialSeen: false,
    insideWriteCreated: true, // the instrument DID run — inside write landed
    outsideWriteAttempted: false, // but the outside-write step was never reported
  });
  assert.equal(state, "write-never-attempted");
  assert.notEqual(state, "unproven");
  assert.notEqual(state, "probe-never-ran");
});

test("classifyUnprovenState: a failure where no OS-denial was observed records a state distinct from the other two", () => {
  const state = classifyUnprovenState({
    outsideWriteCreated: false,
    osDenialSeen: false, // no denial phrase matched
    insideWriteCreated: true, // the instrument ran
    outsideWriteAttempted: true, // and the outside-write step WAS reported on
  });
  assert.equal(state, "no-denial-observed");
  assert.notEqual(state, "unproven");
  assert.notEqual(state, "probe-never-ran");
  assert.notEqual(state, "write-never-attempted");
});

test("classifyUnprovenState: the three states are pairwise DISTINCT (the falsifier direction design part (vi) requires)", () => {
  const probeNeverRan = classifyUnprovenState({
    outsideWriteCreated: false,
    osDenialSeen: false,
    insideWriteCreated: false,
    outsideWriteAttempted: false,
  });
  const writeNeverAttempted = classifyUnprovenState({
    outsideWriteCreated: false,
    osDenialSeen: false,
    insideWriteCreated: true,
    outsideWriteAttempted: false,
  });
  const noDenialObserved = classifyUnprovenState({
    outsideWriteCreated: false,
    osDenialSeen: false,
    insideWriteCreated: true,
    outsideWriteAttempted: true,
  });
  const all = [probeNeverRan, writeNeverAttempted, noDenialObserved];
  assert.equal(new Set(all).size, 3, "all three states must be pairwise distinct, not one string for all three");
  for (const s of all) assert.notEqual(s, "unproven");
});

test("classifyUnprovenState: the recorded state is DERIVED from evidence, not the reader re-classifying a raw blob — insideWriteCreated is checked FIRST (design part iii)", () => {
  // Even when the transcript-attempted signal would suggest "write-never-attempted",
  // a dead instrument (insideWriteCreated: false) must win — it is the MORE severe,
  // DIFFERENT fault (the mechanism didn't run at all), never masked by a lesser one.
  const state = classifyUnprovenState({
    outsideWriteCreated: false,
    osDenialSeen: false,
    insideWriteCreated: false,
    outsideWriteAttempted: false,
  });
  assert.equal(state, "probe-never-ran");
});

test("probeContainment: an unproven failure with the outside-write step reported but no denial phrase matched records 'no-denial-observed', still FAILS CLOSED", async () => {
  await assert.rejects(
    () =>
      probeContainment({
        settingsFile: settingsFile(ENABLED),
        token: "reportedtok",
        exec: async (token) => ({
          // The token IS mentioned (the step was reported on) but nothing in the
          // report matches OS_DENIAL_RE — an ambiguous, non-denial outcome.
          transcript: `outside: touch ../${token}.txt returned no output`,
          outsideWriteCreated: false,
          insideWriteCreated: true,
        }),
      }),
    (e: unknown) => {
      assert.ok(e instanceof ContainmentError);
      const err = e as ContainmentError;
      assert.equal(err.check, "outside-cwd-denial");
      assert.equal(err.observed, "no-denial-observed");
      assert.notEqual(err.observed, "unproven");
      assert.match(err.message, /FAIL CLOSED/);
      return true;
    },
  );
});

test("probeContainment: ALL THREE unproven sub-states still refuse the run (verdict unchanged, only the record changes — design part iv)", async () => {
  const fixtures: Array<{ label: string; result: ProbeExecResult; expected: string }> = [
    {
      label: "probe-never-ran",
      result: { transcript: "", outsideWriteCreated: false, insideWriteCreated: false },
      expected: "probe-never-ran",
    },
    {
      label: "write-never-attempted",
      result: {
        transcript: "unrelated transcript text",
        outsideWriteCreated: false,
        insideWriteCreated: true,
      },
      expected: "write-never-attempted",
    },
    {
      label: "no-denial-observed",
      result: {
        transcript: "outside: touch reported, no denial phrase present",
        outsideWriteCreated: false,
        insideWriteCreated: true,
      },
      expected: "no-denial-observed",
    },
  ];
  for (const { label, result, expected } of fixtures) {
    await assert.rejects(
      () =>
        probeContainment({
          settingsFile: settingsFile(ENABLED),
          token: label === "no-denial-observed" ? "" : "unused-token-not-in-transcript",
          exec: async () => result,
        }),
      (e: unknown) => {
        assert.ok(e instanceof ContainmentError, `${label}: must still throw ContainmentError`);
        const err = e as ContainmentError;
        assert.match(err.message, /FAIL CLOSED/, `${label}: must still fail closed`);
        assert.equal(err.observed, expected, `${label}: must record its own distinct state`);
        return true;
      },
    );
  }
});

// ── defaultExecutor: the real-spawn path plumbs isError through (W1-T237) ──

test("defaultExecutor: passes the real spawn's isError through to ProbeExecResult", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-containment-executor-test-"));
  const config = { root: dir } as Config;
  const fakeSpawn = async (_args: SpawnWorkerArgs): Promise<WorkerResult> =>
    ({
      sessionId: "s",
      costUsd: 0,
      numTurns: 0,
      text: "Not logged in · Please run /login",
      blocks: [],
      stderr: "",
      subtype: "error_during_execution",
      isError: true,
      apiError: false,
      permissionDenials: [],
    }) as unknown as WorkerResult;

  const exec = defaultExecutor("settings.json", config, undefined, fakeSpawn);
  const result: ProbeExecResult = await exec("execTok");

  assert.equal(result.isError, true);
  assert.match(result.transcript, /not logged in/i);
  assert.equal(result.outsideWriteCreated, false);
  assert.equal(result.insideWriteCreated, false);
});

test("ContainmentError: the static config gate (sandbox disabled) names its own guard-cause", async () => {
  await assert.rejects(
    () =>
      probeContainment({
        settingsFile: settingsFile({ sandbox: { enabled: false, failIfUnavailable: true } }),
        exec: async () => ({ transcript: "", outsideWriteCreated: false, insideWriteCreated: false }),
        token: "t",
      }),
    (e: unknown) => {
      assert.ok(e instanceof ContainmentError);
      const err = e as ContainmentError;
      assert.equal(err.guard, "containment");
      assert.equal(err.check, "sandbox-enabled");
      assert.equal(err.observed, "disabled");
      return true;
    },
  );
});

// ── W1-T1265: THE EGRESS ARM — all three verdicts falsified ────────────────────
//
// The third arm is the one that matters: without it an OFFLINE HOST reads as a
// perfect sandbox, because "the blocked request failed" and "nothing can reach
// anything" are the same observation.

/** Evidence with the filesystem arm already holding, so only egress is under test. */
function egressEvidence(over: Partial<ContainmentEvidence>): ContainmentEvidence {
  return {
    outsideWriteCreated: false,
    osDenialSeen: true,
    insideWriteCreated: true,
    ...over,
  };
}

test("W1-T1265: blocked refused plus the control succeeding verdicts egress PROVEN-HOLDING", () => {
  const v = assessEgressContainment(
    egressEvidence({ egressBlockedReached: false, egressAllowedReached: true, egressDenialSeen: true }),
  );
  assert.equal(v.contained, true);
  assert.match(v.reason, /REFUSED/);
  assert.match(v.reason, /control request succeeded/);
});

test("W1-T1265: the blocked host coming back verdicts egress PROVEN-BROKEN", () => {
  const v = assessEgressContainment(
    egressEvidence({ egressBlockedReached: true, egressAllowedReached: true, egressDenialSeen: false }),
  );
  assert.equal(v.contained, false);
  assert.match(v.reason, /PROVEN-BROKEN/);
  assert.match(v.reason, new RegExp(EGRESS_BLOCKED_HOST.replace(".", "\\.")));
});

test("W1-T1265: the control failing too verdicts UNPROVEN and never proven-holding", () => {
  const v = assessEgressContainment(
    egressEvidence({ egressBlockedReached: false, egressAllowedReached: false, egressDenialSeen: true }),
  );
  assert.equal(v.contained, false);
  assert.match(v.reason, /UNPROVEN/);
  assert.match(v.reason, /offline host/);
});

test("W1-T1265: an unobserved egress attempt stays UNPROVEN rather than reading as blocked", () => {
  const v = assessEgressContainment(egressEvidence({}));
  assert.equal(v.contained, false);
  assert.match(v.reason, /UNPROVEN/);
  assert.match(v.reason, /no egress attempt was observed/);
});

test("W1-T1265: a blocked request with no observed refusal stays UNPROVEN", () => {
  const v = assessEgressContainment(
    egressEvidence({ egressBlockedReached: false, egressAllowedReached: true, egressDenialSeen: false }),
  );
  assert.equal(v.contained, false);
  assert.match(v.reason, /UNPROVEN/);
});

test("W1-T1265: the control host is derived from the allowlist rather than duplicated", () => {
  assert.equal(
    allowedHostFromSettings({ sandbox: { network: { allowedDomains: ["github.com", "api.github.com"] } } }),
    "github.com",
  );
  assert.equal(allowedHostFromSettings({}), EGRESS_ALLOWED_HOST_FALLBACK);
  assert.equal(allowedHostFromSettings({ sandbox: { network: { allowedDomains: [] } } }), EGRESS_ALLOWED_HOST_FALLBACK);
});

test("W1-T1265: the egress command carries its own timeout and writes a marker per request", () => {
  const cmd = egressProbeCommand("api.github.com");
  assert.match(cmd, new RegExp(`-m ${EGRESS_TIMEOUT_SECONDS}\\b`));
  assert.ok(cmd.includes(EGRESS_BLOCKED_HOST), "the blocked target must be the RFC 2606 host");
  assert.ok(cmd.includes("api.github.com"), "the control target must be the allowlisted host");
  assert.ok(cmd.includes(EGRESS_BLOCKED_MARKER) && cmd.includes(EGRESS_ALLOWED_MARKER));
});

test("W1-T1265: a reported egress attempt derives the denial from the transcript rather than from silence", async () => {
  // Drives probeContainment's OWN egress wiring (not just the pure verdict): an executor
  // that REPORTS an egress attempt must have `egressDenialSeen` computed from the
  // transcript. The `undefined` arm is covered by the unobserved case above.
  const res = await probeContainment({
    settingsFile: settingsFile(ENABLED),
    token: "tok1265",
    exec: async (): Promise<ProbeExecResult> => ({
      transcript: "tok1265 touch: ../tok1265.txt: Operation not permitted\negress: Connection refused",
      outsideWriteCreated: false,
      insideWriteCreated: true,
      egressBlockedReached: false,
      egressAllowedReached: true,
    }),
  });
  // The filesystem verdict is unchanged by the egress arm — it still governs the throw.
  assert.equal(res.contained, true);
  assert.equal(res.evidence.egressBlockedReached, false);
  assert.equal(res.evidence.egressAllowedReached, true);
  assert.equal(res.evidence.egressDenialSeen, true);
  // And the pure verdict over that same evidence reads PROVEN-HOLDING.
  assert.equal(assessEgressContainment(res.evidence).contained, true);
});

test("W1-T1265: the probe prompt asks for the egress attempt and its outcome", () => {
  const prompt = containmentProbePrompt("tok", "api.github.com");
  assert.match(prompt, /THREE commands/, "the three containment steps are unchanged");
  assert.match(prompt, /FOURTH command/, "the egress check is asked for as an explicit fourth step");
  assert.ok(prompt.includes(EGRESS_BLOCKED_HOST));
  assert.match(prompt, /^egress: /m);
});

// ── W1-T2211: THE READ ARM — a worker's read of the console's write-token path
// is denied, and that denial is OBSERVED (not assumed) by the same three-state
// verdict the write and egress arms already use. `assessTokenReadContainment`
// is the pure falsifier the shard's acceptance criteria 1 and 2 point at; the
// `stateReadSucceeded` control is criterion 3's own falsifier. ─────────────────

/** Evidence with the filesystem arm already holding, so only the read arm is under test. */
function tokenReadEvidence(over: Partial<ContainmentEvidence>): ContainmentEvidence {
  return {
    outsideWriteCreated: false,
    osDenialSeen: true,
    insideWriteCreated: true,
    ...over,
  };
}

test("W1-T2211 ACCEPTANCE 1+2: the token read DENIED plus the control read succeeding verdicts token-read PROVEN-HOLDING, three-state", () => {
  const v = assessTokenReadContainment(
    tokenReadEvidence({ tokenReadSucceeded: false, stateReadSucceeded: true, tokenReadDenialSeen: true }),
  );
  assert.equal(v.contained, true);
  assert.match(v.reason, /DENIED/);
  assert.match(v.reason, /control read succeeded/);
});

test("W1-T2211: the token read SUCCEEDING (the denyRead entry did not hold) verdicts token-read PROVEN-BROKEN", () => {
  const v = assessTokenReadContainment(
    tokenReadEvidence({ tokenReadSucceeded: true, stateReadSucceeded: true, tokenReadDenialSeen: false }),
  );
  assert.equal(v.contained, false);
  assert.match(v.reason, /PROVEN-BROKEN/);
  assert.match(v.reason, /service-tokens\.json/);
});

test("W1-T2211 ACCEPTANCE 3: the ordinary-state control failing too verdicts token-read UNPROVEN and never proven-holding — an over-broad deny cannot pass as a clean result", () => {
  const v = assessTokenReadContainment(
    tokenReadEvidence({ tokenReadSucceeded: false, stateReadSucceeded: false, tokenReadDenialSeen: true }),
  );
  assert.equal(v.contained, false);
  assert.match(v.reason, /UNPROVEN/);
  assert.match(v.reason, /control read also failed/);
});

test("W1-T2211: an unobserved read attempt stays UNPROVEN rather than reading as denied", () => {
  const v = assessTokenReadContainment(tokenReadEvidence({}));
  assert.equal(v.contained, false);
  assert.match(v.reason, /UNPROVEN/);
  assert.match(v.reason, /no read attempt was observed/);
});

test("W1-T2211: a control-succeeding read with no observed denial stays UNPROVEN", () => {
  const v = assessTokenReadContainment(
    tokenReadEvidence({ tokenReadSucceeded: false, stateReadSucceeded: true, tokenReadDenialSeen: false }),
  );
  assert.equal(v.contained, false);
  assert.match(v.reason, /UNPROVEN/);
  assert.match(v.reason, /no denial was observed/);
});

test("W1-T2211: the read-arm command never prints either file's content — both reads redirect to /dev/null", () => {
  const cmd = tokenReadProbeCommand("/root/state/service-tokens.json", "/root/state/control.txt");
  assert.match(cmd, />\/dev\/null/);
  assert.ok(cmd.includes(TOKEN_READ_SUCCESS_MARKER) && cmd.includes(STATE_READ_CONTROL_MARKER));
  assert.ok(cmd.includes("service-tokens.json"));
});

test("W1-T2211: the control basename is scoped per-token so concurrent runs never collide", () => {
  assert.notEqual(stateReadControlBasename("a"), stateReadControlBasename("b"));
  assert.match(stateReadControlBasename("tok"), /tok/);
});

test("W1-T2211: the probe prompt asks for the token-read attempt and its outcome, as a distinct FIFTH step", () => {
  const prompt = containmentProbePrompt("tok", "api.github.com", "/root/state/service-tokens.json", "/root/state/control.txt");
  assert.match(prompt, /FIFTH command/, "the token-read check is asked for as an explicit fifth step");
  assert.ok(prompt.includes("service-tokens.json"));
  assert.match(prompt, /^tokenread: /m);
});

test("W1-T2211: a reported token-read attempt derives the denial from the transcript rather than from silence, wired through probeContainment", async () => {
  // Drives probeContainment's OWN read-arm wiring (not just the pure verdict): an
  // executor that REPORTS a read attempt must have `tokenReadDenialSeen` computed
  // from the transcript. The `undefined` arm is covered by the unobserved case above.
  const res = await probeContainment({
    settingsFile: settingsFile(ENABLED),
    token: "tok2211",
    exec: async (): Promise<ProbeExecResult> => ({
      transcript:
        "tok2211 touch: ../tok2211.txt: Operation not permitted\n" +
        'cat: /root/state/service-tokens.json: Permission denied',
      outsideWriteCreated: false,
      insideWriteCreated: true,
      tokenReadSucceeded: false,
      stateReadSucceeded: true,
    }),
  });
  // The filesystem verdict is unchanged by the read arm — it still governs the throw.
  assert.equal(res.contained, true);
  assert.equal(res.evidence.tokenReadSucceeded, false);
  assert.equal(res.evidence.stateReadSucceeded, true);
  assert.equal(res.evidence.tokenReadDenialSeen, true);
  // And the pure verdict over that same evidence reads PROVEN-HOLDING.
  assert.equal(assessTokenReadContainment(res.evidence).contained, true);
});

test("W1-T2211: an UNRELATED permission-denied line that never mentions service-tokens.json does NOT satisfy tokenReadDenialSeen", async () => {
  const res = await probeContainment({
    settingsFile: settingsFile(ENABLED),
    token: "tok2211b",
    exec: async (): Promise<ProbeExecResult> => ({
      transcript:
        "tok2211b touch: ../tok2211b.txt: Operation not permitted\n" +
        "cat: /some/unrelated/path: Permission denied",
      outsideWriteCreated: false,
      insideWriteCreated: true,
      tokenReadSucceeded: false,
      stateReadSucceeded: true,
    }),
  });
  assert.equal(res.evidence.tokenReadDenialSeen, false);
  assert.equal(assessTokenReadContainment(res.evidence).contained, false);
});

test("W1-T2211: defaultExecutor observes the read arm's markers via existsSync, exactly like the write and egress arms", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-containment-readarm-test-"));
  const config = { root: dir } as Config;
  const fakeSpawn = async (args: SpawnWorkerArgs): Promise<WorkerResult> => {
    // Simulate the sandbox DENYING the token read and ALLOWING the control read —
    // create only the control-read marker inside cwd, mirroring what a real spawn
    // would leave behind via `touch` in tokenReadProbeCommand.
    writeFileSync(join(args.cwd, STATE_READ_CONTROL_MARKER), "");
    return {
      sessionId: "s",
      costUsd: 0,
      numTurns: 0,
      text: "REPORT\ntokenread: token read denied, control read succeeded",
      blocks: [],
      stderr: "",
      subtype: "success",
      isError: false,
      apiError: false,
      permissionDenials: [],
    } as unknown as WorkerResult;
  };

  const exec = defaultExecutor("settings.json", config, undefined, fakeSpawn);
  const result: ProbeExecResult = await exec("readarmtok");

  assert.equal(result.tokenReadSucceeded, false, "no token-read marker was created ⇒ read did not succeed");
  assert.equal(result.stateReadSucceeded, true, "the control marker WAS created ⇒ control read succeeded");
});

// ── W1-T2213: THE RE-ANCHORING ARM — a worker's read of the operator's real
// `~/.config/remudero/config.json` (one of the six `~`-anchored denies re-
// anchored to `~/../..`, design part (i)) is denied, and that denial is
// OBSERVED (not assumed) by the same three-state verdict every other arm
// uses. `assessOperatorHomeReadContainment` is the pure falsifier the shard's
// acceptance criteria 3 and 4 point at; criterion 5 is the turn-budget test
// at the bottom of this block. ──────────────────────────────────────────────

/** Evidence with the filesystem arm already holding, so only this read arm is under test. */
function operatorHomeReadEvidence(over: Partial<ContainmentEvidence>): ContainmentEvidence {
  return {
    outsideWriteCreated: false,
    osDenialSeen: true,
    insideWriteCreated: true,
    ...over,
  };
}

test("W1-T2213 ACCEPTANCE 3+4: the operator-home read DENIED plus the control read succeeding verdicts operator-home-read PROVEN-HOLDING, three-state", () => {
  const v = assessOperatorHomeReadContainment(
    operatorHomeReadEvidence({
      operatorHomeReadSucceeded: false,
      stateReadSucceeded: true,
      operatorHomeReadDenialSeen: true,
    }),
  );
  assert.equal(v.contained, true);
  assert.match(v.reason, /DENIED/);
  assert.match(v.reason, /control read succeeded/);
});

test("W1-T2213: the operator-home read SUCCEEDING (the re-anchored denyRead entry did not hold) verdicts operator-home-read PROVEN-BROKEN", () => {
  const v = assessOperatorHomeReadContainment(
    operatorHomeReadEvidence({
      operatorHomeReadSucceeded: true,
      stateReadSucceeded: true,
      operatorHomeReadDenialSeen: false,
    }),
  );
  assert.equal(v.contained, false);
  assert.match(v.reason, /PROVEN-BROKEN/);
  assert.match(v.reason, /config\.json/);
});

test("W1-T2213: the ordinary-state control failing too verdicts operator-home-read UNPROVEN and never proven-holding — an over-broad deny cannot pass as a clean result", () => {
  const v = assessOperatorHomeReadContainment(
    operatorHomeReadEvidence({
      operatorHomeReadSucceeded: false,
      stateReadSucceeded: false,
      operatorHomeReadDenialSeen: true,
    }),
  );
  assert.equal(v.contained, false);
  assert.match(v.reason, /UNPROVEN/);
  assert.match(v.reason, /control read also failed/);
});

test("W1-T2213: an unobserved read attempt stays UNPROVEN rather than reading as denied", () => {
  const v = assessOperatorHomeReadContainment(operatorHomeReadEvidence({}));
  assert.equal(v.contained, false);
  assert.match(v.reason, /UNPROVEN/);
  assert.match(v.reason, /no read attempt was observed/);
});

test("W1-T2213: a control-succeeding read with no observed denial stays UNPROVEN", () => {
  const v = assessOperatorHomeReadContainment(
    operatorHomeReadEvidence({
      operatorHomeReadSucceeded: false,
      stateReadSucceeded: true,
      operatorHomeReadDenialSeen: false,
    }),
  );
  assert.equal(v.contained, false);
  assert.match(v.reason, /UNPROVEN/);
  assert.match(v.reason, /no denial was observed/);
});

test("W1-T2213: the read-arm command never prints the file's content — the read redirects to /dev/null", () => {
  const cmd = operatorHomeReadProbeCommand("/home/op/.config/remudero/config.json");
  assert.match(cmd, />\/dev\/null/);
  assert.ok(cmd.includes(OPERATOR_HOME_READ_SUCCESS_MARKER));
  assert.ok(cmd.includes(".config/remudero/config.json"));
});

test("W1-T2213 ACCEPTANCE 5: the probe prompt asks for the operator-home read as a distinct SIXTH step, and the turn cap absorbs it WITHOUT a hand-set literal", () => {
  const prompt = containmentProbePrompt(
    "tok",
    "api.github.com",
    "/root/state/service-tokens.json",
    "/root/state/control.txt",
    "/home/op/.config/remudero/config.json",
  );
  assert.match(prompt, /SIXTH command/, "the operator-home read check is asked for as an explicit sixth step");
  assert.ok(prompt.includes(".config/remudero/config.json"));
  assert.match(prompt, /^operatorhomeread: /m);
  // Rationale (6): the prompt carried FOUR commands before W1-T2211 added the
  // token-read arm as a fifth; this task adds the operator-home-read arm as a
  // SIXTH, and the cap is DERIVED from the prompt's own numbered commands
  // (probeCommandCount), not a hand-set literal — so the sixth command moves
  // the cap automatically, with PROBE_TURN_ALLOWANCE untouched by this task
  // (design part (iii)).
  assert.equal(probeCommandCount(prompt), 6, "six numbered commands: write x2, tripwire, egress, token-read, operator-home-read");
  assert.equal(PROBE_TURN_ALLOWANCE, 3, "the allowance itself is untouched — only the derived cap moves");
  assert.equal(
    probeTurnBudget(prompt),
    probeCommandCount(prompt) + 1 + PROBE_TURN_ALLOWANCE,
    "the cap is DERIVED from the prompt's own command count, never a separate literal",
  );
  assert.equal(probeTurnBudget(prompt), 10, "6 commands + 1 report turn + 3 allowance = 10, moved automatically from 9");
});

test("W1-T2213: a reported operator-home-read attempt derives the denial from the transcript rather than from silence, wired through probeContainment", async () => {
  // Drives probeContainment's OWN wiring for this arm (not just the pure
  // verdict): an executor that REPORTS a read attempt must have
  // `operatorHomeReadDenialSeen` computed from the transcript.
  const res = await probeContainment({
    settingsFile: settingsFile(ENABLED),
    token: "tok2213",
    exec: async (): Promise<ProbeExecResult> => ({
      transcript:
        "tok2213 touch: ../tok2213.txt: Operation not permitted\n" +
        "cat: /home/op/.config/remudero/config.json: Permission denied",
      outsideWriteCreated: false,
      insideWriteCreated: true,
      operatorHomeReadSucceeded: false,
      stateReadSucceeded: true,
    }),
  });
  // The filesystem verdict is unchanged by this arm — it still governs the throw.
  assert.equal(res.contained, true);
  assert.equal(res.evidence.operatorHomeReadSucceeded, false);
  assert.equal(res.evidence.stateReadSucceeded, true);
  assert.equal(res.evidence.operatorHomeReadDenialSeen, true);
  assert.equal(assessOperatorHomeReadContainment(res.evidence).contained, true);
});

test("W1-T2213: an UNRELATED permission-denied line that never mentions config/remudero does NOT satisfy operatorHomeReadDenialSeen", async () => {
  const res = await probeContainment({
    settingsFile: settingsFile(ENABLED),
    token: "tok2213b",
    exec: async (): Promise<ProbeExecResult> => ({
      transcript:
        "tok2213b touch: ../tok2213b.txt: Operation not permitted\n" +
        "cat: /some/unrelated/path: Permission denied",
      outsideWriteCreated: false,
      insideWriteCreated: true,
      operatorHomeReadSucceeded: false,
      stateReadSucceeded: true,
    }),
  });
  assert.equal(res.evidence.operatorHomeReadDenialSeen, false);
  assert.equal(assessOperatorHomeReadContainment(res.evidence).contained, false);
});

test("W1-T2213: defaultExecutor observes this arm's marker via existsSync, exactly like the write, egress and token-read arms", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-containment-operatorhomearm-test-"));
  const config = { root: dir } as Config;
  const fakeSpawn = async (args: SpawnWorkerArgs): Promise<WorkerResult> => {
    // Simulate the sandbox DENYING the operator-home read and ALLOWING the
    // control read — create only the control-read marker inside cwd, mirroring
    // what a real spawn would leave behind via `touch` in the probe command.
    writeFileSync(join(args.cwd, STATE_READ_CONTROL_MARKER), "");
    return {
      sessionId: "s",
      costUsd: 0,
      numTurns: 0,
      text: "REPORT\noperatorhomeread: operator-home read denied, control read succeeded",
      blocks: [],
      stderr: "",
      subtype: "success",
      isError: false,
      apiError: false,
      permissionDenials: [],
    } as unknown as WorkerResult;
  };

  const exec = defaultExecutor("settings.json", config, undefined, fakeSpawn);
  const result: ProbeExecResult = await exec("operatorhometok");

  assert.equal(
    result.operatorHomeReadSucceeded,
    false,
    "no operator-home-read marker was created ⇒ read did not succeed",
  );
  assert.equal(result.stateReadSucceeded, true, "the control marker WAS created ⇒ control read succeeded");
});
