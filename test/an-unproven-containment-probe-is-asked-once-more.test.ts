import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ContainmentError, probeContainment, type ProbeExecResult } from "../src/lib/containment.js";

function settingsFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), "rmd-containment-retry-")), "worker.json");
  writeFileSync(path, JSON.stringify({
    sandbox: { enabled: true, failIfUnavailable: true },
    permissions: { deny: [], allow: [], ask: [] },
  }));
  return path;
}

function denied(token: string): ProbeExecResult {
  return {
    transcript: `touch ../${token}.txt\ntouch: ../${token}.txt: Operation not permitted`,
    outsideWriteCreated: false,
    insideWriteCreated: true,
    costUsd: 0.2,
  };
}

test("W1-T5005: an unproven first probe is asked once more and a contained second probe passes", async () => {
  const tokens: string[] = [];
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const result = await probeContainment({
    settingsFile: settingsFile(),
    token: "first-token",
    exec: async (token) => {
      tokens.push(token);
      return tokens.length === 1
        ? { transcript: "inside write completed", outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0.1 }
        : denied(token);
    },
    log: (step, extra) => rows.push({ step, extra }),
  });
  assert.equal(result.contained, true);
  assert.ok(Math.abs(result.costUsd - 0.3) < 1e-9);
  assert.equal(tokens.length, 2);
  assert.equal(tokens[0], "first-token");
  assert.notEqual(tokens[1], tokens[0], "the retry needs a fresh token");
  assert.deepEqual(rows.filter((row) => row.step === "containment.probe").map((row) => row.extra?.cost_usd), [0.1, 0.2]);
  const retry = rows.filter((row) => row.step === "containment.probe_retry");
  assert.equal(retry.length, 1);
  assert.equal(retry[0].extra?.state, "write-never-attempted");
  assert.match(String(retry[0].extra?.reason), /UNPROVEN/);
});

test("W1-T5005: an outside-cwd write that succeeded fails closed with no retry", async () => {
  let calls = 0;
  const steps: string[] = [];
  await assert.rejects(
    () => probeContainment({
      settingsFile: settingsFile(),
      token: "first-token",
      exec: async (token) => {
        calls++;
        return { transcript: `touch ../${token}.txt`, outsideWriteCreated: true, insideWriteCreated: true };
      },
      log: (step) => steps.push(step),
    }),
    (error: unknown) => error instanceof ContainmentError && /sandbox did not engage/.test(error.observed),
  );
  assert.equal(calls, 1);
  assert.equal(steps.includes("containment.probe_retry"), false);
});

test("W1-T5005: two unproven probes still fail closed", async () => {
  const tokens: string[] = [];
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  await assert.rejects(
    () => probeContainment({
      settingsFile: settingsFile(),
      token: "first-token",
      exec: async (token) => {
        tokens.push(token);
        return { transcript: "inside write completed", outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0.1 };
      },
      log: (step, extra) => rows.push({ step, extra }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ContainmentError);
      assert.equal(error.check, "outside-cwd-denial");
      assert.equal(error.observed, "write-never-attempted");
      return true;
    },
  );
  assert.equal(tokens.length, 2);
  assert.notEqual(tokens[0], tokens[1]);
  assert.equal(rows.filter((row) => row.step === "containment.probe_retry").length, 1);
  assert.deepEqual(rows.filter((row) => row.step === "containment.probe").map((row) => row.extra?.cost_usd), [0.1, 0.1]);
});

test("W1-T5005: attempted without denial and exhausted turns each get one retry", async () => {
  for (const first of [
    { transcript: "first-token", outsideWriteCreated: false, insideWriteCreated: true },
    { transcript: "", outsideWriteCreated: false, insideWriteCreated: false, turnsExhausted: true },
  ]) {
    let calls = 0;
    const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const result = await probeContainment({
      settingsFile: settingsFile(),
      token: "first-token",
      exec: async (token) => ++calls === 1 ? first : denied(token),
      log: (step, extra) => rows.push({ step, extra }),
    });
    assert.equal(result.contained, true);
    assert.equal(calls, 2);
    assert.equal(rows.find((row) => row.step === "containment.probe_retry")?.extra?.state,
      first.turnsExhausted ? "turns-exhausted" : "no-denial-observed");
  }
});

test("W1-T5005: the second unproven state is the final verdict", async () => {
  let calls = 0;
  await assert.rejects(
    () => probeContainment({
      settingsFile: settingsFile(),
      token: "first-token",
      exec: async (token) => ++calls === 1
        ? { transcript: `touch ../${token}.txt returned no output`, outsideWriteCreated: false, insideWriteCreated: true }
        : { transcript: "inside write completed", outsideWriteCreated: false, insideWriteCreated: true },
    }),
    (error: unknown) => error instanceof ContainmentError && error.observed === "write-never-attempted",
  );
  assert.equal(calls, 2);
});

test("W1-T5005: credential, transport, and probe-never-ran failures keep their one-spawn handling", async () => {
  for (const [result, observed] of [
    [{ transcript: "Not logged in. Please run /login", isError: true, outsideWriteCreated: false, insideWriteCreated: false }, "spawn_credential_failure"],
    [{ transcript: "API Error: 529 Overloaded", isError: true, outsideWriteCreated: false, insideWriteCreated: false }, "spawn_transport_failure"],
    [{ transcript: "", outsideWriteCreated: false, insideWriteCreated: false }, "probe-never-ran"],
  ] as const) {
    let calls = 0;
    await assert.rejects(
      () => probeContainment({ settingsFile: settingsFile(), exec: async () => { calls++; return result; } }),
      (error: unknown) => error instanceof ContainmentError && error.observed === observed,
    );
    assert.equal(calls, 1, `${observed} must not retry`);
  }
});
