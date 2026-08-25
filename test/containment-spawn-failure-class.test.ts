/**
 * W1-T2249 — A DEAD PROBE AND A BROKEN BOUNDARY MUST NOT SHARE ONE VERDICT.
 *
 * THE DEFECT. A containment probe whose own worker died on a transport/API
 * failure (a 529, a dropped connection) before it ever attempted a write was
 * indistinguishable, at the `classifyUnprovenState`/`outside-cwd-denial` layer,
 * from a probe that ran cleanly and genuinely observed no denial. Both threw
 * the SAME `ContainmentError` (`check: "outside-cwd-denial"`), and
 * `dispatchesWithoutNewOwnedPr` (status.ts) counted every such throw as a
 * dispatch that produced nothing — so five 529s in sixteen minutes could trip
 * a task's circuit breaker exactly as five genuine no-progress dispatches
 * would (this task's own filing: W1-T1279, `freshCount:5, maxDispatches:5,
 * hasNewOwnedPr:false`, tripped twelve times off an API outage).
 *
 * THE FIX, MIRRORING THE PRECEDENT ALREADY IN THIS FILE (W1-T237/W1-T292's two
 * credential arms): a THIRD pre-classifier arm, `spawnTransportFailure`,
 * checked ahead of the unproven classifier, throwing its OWN
 * `spawn-transport-failure` / `spawn_transport_failure` symbol — still
 * unconditionally, still failing closed. `dispatchesWithoutNewOwnedPr` then
 * excludes a `run.start` whose OWN run ended in that class, narrowly, so
 * nothing else about the breaker moves.
 *
 * EVERY ASSERTION HERE GOES THROUGH THE REAL EXPORTED SURFACE — `probeContainment`
 * via an injected `exec` (no real spawn), and `dispatchesWithoutNewOwnedPr` via
 * real ledger rows round-tripped through `readLedgerLines` — never a hand-rolled
 * replica of either.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ContainmentError,
  assessContainment,
  classifyUnprovenState,
  probeContainment,
  type ProbeExecResult,
} from "../src/lib/containment.js";
import {
  DEFAULT_MAX_TASK_DISPATCHES,
  dispatchesWithoutNewOwnedPr,
  isDispatchBreakerTripped,
  readLedgerLines,
} from "../src/lib/status.js";

function settingsFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-spawn-failure-class-test-"));
  const path = join(dir, "worker.json");
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

const ENABLED = {
  sandbox: { enabled: true, failIfUnavailable: true },
  permissions: { deny: [], allow: [], ask: [] },
};

// The real observed excerpt this task's own filing quotes verbatim (five
// occurrences within sixteen minutes, corroborated by the ledger read) —
// attributed rather than re-derived by a live probe here.
const OBSERVED_529_TEXT = "API Error: 529 Overloaded";

const OBSERVED_EXPIRED_TEXT =
  "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue";

async function rejectsWith(
  exec: () => Promise<{
    transcript: string;
    outsideWriteCreated: boolean;
    insideWriteCreated: boolean;
    isError?: boolean;
  }>,
): Promise<ContainmentError> {
  let caught: unknown;
  await assert.rejects(
    () => probeContainment({ settingsFile: settingsFile(ENABLED), token: "tok", exec }),
    (e: unknown) => {
      caught = e;
      return true;
    },
  );
  assert.ok(caught instanceof ContainmentError, "must fail closed with a ContainmentError");
  return caught as ContainmentError;
}

// ── Acceptance (1): a dead-transport probe is refused under a DISTINCT class ──

test("ACCEPTANCE: a probe whose worker died on a transport/API failure (529) is refused under a distinct spawn-failure class, never outside-cwd-denial", async () => {
  const err = await rejectsWith(async () => ({
    transcript: OBSERVED_529_TEXT,
    outsideWriteCreated: false,
    insideWriteCreated: false,
    isError: true,
  }));
  assert.equal(err.guard, "containment");
  assert.equal(err.check, "spawn-transport-failure");
  assert.notEqual(err.check, "outside-cwd-denial");
  assert.equal(err.observed, "spawn_transport_failure");
  assert.notEqual(err.observed, "unproven");
  assert.notEqual(err.observed, "probe-never-ran");
});

test("ACCEPTANCE (1, precise fleet shape): a probe with no insideWriteCreated (the true 529-death shape) still classifies as the transport class, not probe-never-ran", async () => {
  // Before this fix, `!insideWriteCreated` alone routed straight to
  // `classifyUnprovenState`'s "probe-never-ran" — exactly the four rows this
  // task's own ledger read pins to the four 05:09–05:25 529s.
  const err = await rejectsWith(async () => ({
    transcript: `some earlier narration\n${OBSERVED_529_TEXT}\nprocess exited`,
    outsideWriteCreated: false,
    insideWriteCreated: false,
    isError: true,
  }));
  assert.equal(err.check, "spawn-transport-failure");
  assert.equal(err.observed, "spawn_transport_failure");
});

// ── Acceptance (2): the new class still throws and still fails closed ──────

test("ACCEPTANCE: the transport-failure class still throws ContainmentError and still fails closed — the run does not proceed", async () => {
  const err = await rejectsWith(async () => ({
    transcript: OBSERVED_529_TEXT,
    outsideWriteCreated: false,
    insideWriteCreated: false,
    isError: true,
  }));
  assert.ok(err instanceof ContainmentError);
  assert.match(err.message, /FAIL CLOSED/);
  assert.match(err.message, /does not proceed/);
});

test("ACCEPTANCE: assessContainment reports contained:false for a transport-failure evidence literal — no path treats it as proven", () => {
  const v = assessContainment({
    outsideWriteCreated: false,
    osDenialSeen: false,
    insideWriteCreated: false,
    spawnTransportFailure: true,
  });
  assert.equal(v.contained, false);
  assert.match(v.reason, /spawn_transport_failure/);
});

// ── Acceptance (3): the four existing unproven sub-states keep their names ──

test("ACCEPTANCE: turns-exhausted, probe-never-ran, write-never-attempted and no-denial-observed all keep their own names and are not absorbed into the new class", () => {
  const base = { outsideWriteCreated: false, insideWriteCreated: false, osDenialSeen: false } as const;
  assert.equal(classifyUnprovenState({ ...base, turnsExhausted: true }), "turns-exhausted");
  assert.equal(classifyUnprovenState({ ...base, insideWriteCreated: false }), "probe-never-ran");
  assert.equal(
    classifyUnprovenState({ ...base, insideWriteCreated: true, outsideWriteAttempted: false }),
    "write-never-attempted",
  );
  assert.equal(
    classifyUnprovenState({ ...base, insideWriteCreated: true, outsideWriteAttempted: true }),
    "no-denial-observed",
  );
  // None of the four collapses into the new class's own literal.
  for (const state of ["turns-exhausted", "probe-never-ran", "write-never-attempted", "no-denial-observed"]) {
    assert.notEqual(state, "spawn_transport_failure");
  }
});

test("ACCEPTANCE: a genuinely unproven probe (no transport-failure signature) still throws under outside-cwd-denial with its own named state", async () => {
  const err = await rejectsWith(async () => ({
    // Deliberately never mentions the probe's own run identifier ("tok" — note
    // even the word "token" contains that substring, so it is avoided too) —
    // the outside-cwd write step was never reached or never reported, so
    // `outsideWriteAttempted` reads false and this must classify
    // "write-never-attempted", not "no-denial-observed".
    transcript: "some unrelated narration with no denial phrase anywhere in it",
    outsideWriteCreated: false,
    insideWriteCreated: true,
    isError: false,
  }));
  assert.equal(err.check, "outside-cwd-denial");
  assert.equal(err.observed, "write-never-attempted");
});

// ── Acceptance (4): the breaker excludes a run refused for the new class ───

const T = "W1-T9001";
const runStart = (runId: string) => ({ task_id: T, step: "run.start", run_id: runId });
const transportFailureVerdict = (runId: string) => ({
  task_id: T,
  step: "verdict",
  verdict: "blocked_containment",
  guard: "containment",
  check: "spawn-transport-failure",
  observed: "spawn_transport_failure",
  run_id: runId,
});

function throughLedger(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), "spawn-failure-class-breaker-"));
  const path = join(dir, "ledger.ndjson");
  writeFileSync(path, rows.map((r) => JSON.stringify({ ts: "2026-08-24T00:00:00.000Z", ...r })).join("\n") + "\n");
  return readLedgerLines(path);
}

test("ACCEPTANCE: dispatchesWithoutNewOwnedPr does not count a run refused for spawn_transport_failure", () => {
  const rows = throughLedger([
    runStart("r1"),
    transportFailureVerdict("r1"),
    runStart("r2"),
    transportFailureVerdict("r2"),
  ]);
  assert.equal(dispatchesWithoutNewOwnedPr(rows, T), 0, "two infrastructure refusals must not count as dispatches");
  assert.equal(isDispatchBreakerTripped(rows, T, DEFAULT_MAX_TASK_DISPATCHES), false);
});

test("ACCEPTANCE: five API-outage transport refusals cannot trip the breaker — the exact W1-T1279 shape", () => {
  const rows = throughLedger(
    Array.from({ length: 5 }, (_, i) => [runStart(`r${i}`), transportFailureVerdict(`r${i}`)]).flat(),
  );
  assert.equal(dispatchesWithoutNewOwnedPr(rows, T), 0);
  assert.equal(isDispatchBreakerTripped(rows, T, DEFAULT_MAX_TASK_DISPATCHES), false, "an API outage must not halt dispatch");
});

test("ACCEPTANCE: a mix of transport refusals and genuine no-progress dispatches counts only the genuine ones", () => {
  const rows = throughLedger([
    runStart("r1"),
    transportFailureVerdict("r1"), // excluded
    runStart("r2"), // counts — no verdict line at all (still in flight / genuinely stalled)
    runStart("r3"),
    transportFailureVerdict("r3"), // excluded
    runStart("r4"), // counts
  ]);
  assert.equal(dispatchesWithoutNewOwnedPr(rows, T), 2);
});

// ── Acceptance (5): a genuine no-PR breaker still trips at the same threshold ─

test("ACCEPTANCE: a task that genuinely dispatches without producing an owned PR still trips the breaker at the same threshold, same reset rule", () => {
  const rows = throughLedger(Array.from({ length: 5 }, (_, i) => runStart(`g${i}`)));
  assert.equal(dispatchesWithoutNewOwnedPr(rows, T), 5);
  assert.equal(isDispatchBreakerTripped(rows, T, DEFAULT_MAX_TASK_DISPATCHES), true);
});

test("ACCEPTANCE: pr.opened still resets the streak exactly as before, transport refusals notwithstanding", () => {
  const rows = throughLedger([
    runStart("r1"),
    transportFailureVerdict("r1"),
    runStart("r2"),
    { task_id: T, step: "pr.opened", pr_url: "https://github.com/craigoley/remudero/pull/1", run_id: "r2" },
    runStart("r3"),
  ]);
  assert.equal(dispatchesWithoutNewOwnedPr(rows, T), 1, "only r3 counts — r1 excluded, r2's PR reset the streak");
});

// ── Acceptance (6): the excerpt is recorded on every REFUSING probe ────────

test("ACCEPTANCE: the containment.probe ledger line carries stderr_excerpt on a refusing probe even when isError is falsy (the no-denial-observed gap)", async () => {
  const lines: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const exec = (): Promise<ProbeExecResult> =>
    Promise.resolve({
      transcript: "clean probe narration, ran fine, but no denial phrase anywhere",
      outsideWriteCreated: false,
      insideWriteCreated: true,
      // isError deliberately OMITTED/false — a probe that returned NORMALLY and
      // simply observed no denial, the exact case W1-T238's original conditional
      // (`r.isError ? {...} : {}`) left with no transcript at all.
    });
  await assert.rejects(() =>
    probeContainment({
      settingsFile: settingsFile(ENABLED),
      exec,
      token: "tok123",
      log: (step, extra) => lines.push({ step, extra }),
    }),
  );
  const probe = lines.find((l) => l.step === "containment.probe");
  assert.ok(probe, "the probe must still log containment.probe on a fail-closed run");
  assert.equal(typeof probe!.extra?.stderr_excerpt, "string", "a refusing probe must carry a transcript excerpt");
  assert.match(probe!.extra?.stderr_excerpt as string, /no denial phrase/);
});

test("ACCEPTANCE: a PASSING probe's ledger row is UNCHANGED — no stderr_excerpt field at all", async () => {
  const lines: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const exec = (token: string): Promise<ProbeExecResult> =>
    Promise.resolve({
      transcript: `touch ../${token}.txt\ntouch: ../${token}.txt: Operation not permitted\ntouch probe-ok.txt`,
      outsideWriteCreated: false,
      insideWriteCreated: true,
    });
  await probeContainment({
    settingsFile: settingsFile(ENABLED),
    exec,
    token: "passtok",
    log: (step, extra) => lines.push({ step, extra }),
  });
  const probe = lines.find((l) => l.step === "containment.probe");
  assert.ok(probe);
  assert.equal("stderr_excerpt" in (probe!.extra ?? {}), false, "a passing probe's row must not grow this field");
});

// ── Acceptance (7): an expired OAuth token stays a credential refusal ──────

test("ACCEPTANCE: a transcript naming an expired OAuth token is refused under the credential class, never as an unproven containment state or the new transport class", async () => {
  const err = await rejectsWith(async () => ({
    transcript: OBSERVED_EXPIRED_TEXT,
    outsideWriteCreated: false,
    insideWriteCreated: false,
    isError: true,
  }));
  assert.equal(err.check, "spawn-credential-expired");
  assert.equal(err.observed, "spawn_credential_expired");
  assert.notEqual(err.check, "outside-cwd-denial");
  assert.notEqual(err.check, "spawn-transport-failure");
  assert.notEqual(err.observed, "spawn_transport_failure");
});
