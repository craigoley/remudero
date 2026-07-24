import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ContainmentError,
  assessContainment,
  containmentProbePrompt,
  probeContainment,
  type ProbeExecResult,
} from "../src/lib/containment.js";

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
