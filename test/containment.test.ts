import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ContainmentError,
  assessContainment,
  containmentProbePrompt,
  defaultExecutor,
  probeContainment,
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

test("W1-T91 ACCEPTANCE: the UNPROVEN containment state (no OS-denial observed) round-trips as observed='unproven'", async () => {
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
      assert.equal(err.observed, "unproven");
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

test("probeContainment: a genuine no-write, no-denial, non-error run still yields the generic unproven reason (credential path does not swallow it)", async () => {
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
      assert.equal(err.observed, "unproven");
      return true;
    },
  );
});

test("probeContainment: a seeded error-result carrying 'OAuth session expired and could not be refreshed' (an EXPIRED copied token) yields the credential-named reason, FAILS CLOSED", async () => {
  await assert.rejects(
    () =>
      probeContainment({
        settingsFile: settingsFile(ENABLED),
        token: "expiredtok",
        exec: async () => ({
          transcript: "OAuth session expired and could not be refreshed",
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

test("probeContainment: isError alone (no credential-shaped text) does NOT trip the credential verdict — falls through to genuine unproven", async () => {
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
      assert.equal(err.observed, "unproven");
      return true;
    },
  );
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
