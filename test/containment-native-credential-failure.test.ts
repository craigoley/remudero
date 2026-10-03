import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assessWorkerSmoke, ContainmentError, defaultExecutor, NATIVE_LOGIN_EXPIRED_RE, NATIVE_TOKEN_EXPIRED_RE, probeContainment, runWorkerSmoke, type ProbeExecResult } from "../src/lib/containment.js";
import type { Config } from "../src/lib/config.js";
import type { WorkerResult } from "../src/lib/worker.js";

const LOGIN = "Failed to authenticate: OAuth session expired and could not be refreshed";
const TOKEN = "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue";
const CONTROL = "touch: ../native-probe.txt: Operation not permitted";

test("native saved-login validator admits complete diagnostics and refuses partial or narrated copies", () => {
  assert.equal(NATIVE_LOGIN_EXPIRED_RE.test(LOGIN), true);
  assert.equal(NATIVE_LOGIN_EXPIRED_RE.test(`Example: ${LOGIN}`), false);
  assert.equal(NATIVE_LOGIN_EXPIRED_RE.test("OAuth session expired"), false);
});

test("native token validator admits both complete token diagnostics and refuses other status codes", () => {
  assert.equal(NATIVE_TOKEN_EXPIRED_RE.test(TOKEN), true);
  assert.equal(NATIVE_TOKEN_EXPIRED_RE.test(TOKEN.replace("access token", "token")), true);
  assert.equal(NATIVE_TOKEN_EXPIRED_RE.test(TOKEN.replace("401", "529")), false);
  assert.equal(NATIVE_TOKEN_EXPIRED_RE.test(`Example: ${TOKEN}`), false);
});

function settings(root: string): string {
  const path = join(root, "worker.json");
  writeFileSync(path, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true }, permissions: { deny: [], allow: [], ask: [] } }));
  return path;
}

function worker(overrides: Partial<WorkerResult>): WorkerResult {
  return { sessionId: "native-fixture", costUsd: 0, numTurns: 1, text: "", blocks: [], stderr: "", subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], ...overrides } as WorkerResult;
}

async function observe(overrides: Partial<ProbeExecResult & { nativeStderr: string }>) {
  const root = mkdtempSync(join(tmpdir(), "rmd-native-expiry-test-"));
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let calls = 0;
  try {
    const result = await probeContainment({ settingsFile: settings(root), token: "native-probe", log: (step, extra = {}) => rows.push({ step, extra }), exec: async () => {
      calls++;
      return { transcript: "", outsideWriteCreated: false, insideWriteCreated: false, ...overrides };
    } });
    return { result, error: undefined, calls, rows: rows.filter(row => row.step === "containment.probe" || row.step === "containment.probe_retry") };
  } catch (error) {
    assert.ok(error instanceof ContainmentError);
    return { result: undefined, error, calls, rows: rows.filter(row => row.step === "containment.probe" || row.step === "containment.probe_retry") };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("containment native diagnostics preserve child stderr provenance", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-native-executor-test-"));
  try {
    const result = await defaultExecutor(settings(root), { root } as Config, undefined, async () => worker({ text: "assistant result", blocks: ["assistant narration"], stderr: LOGIN }))("native-probe");
    assert.equal((result as ProbeExecResult & { nativeStderr?: string }).nativeStderr, LOGIN);
    assert.match(result.transcript, /assistant result/);
    assert.match(result.transcript, /assistant narration/);
    assert.match(result.transcript, /OAuth session expired/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("containment native login expiry stays named across envelope shapes", async () => {
  for (const diagnostic of [LOGIN, TOKEN, TOKEN.replace("access token", "token"), `${LOGIN}\r\n`]) {
    for (const isError of [undefined, false, true]) {
      const actual = await observe({ transcript: diagnostic, nativeStderr: diagnostic, isError });
      assert.equal(actual.error?.observed, "spawn_credential_expired", `${diagnostic}; envelope=${String(isError)}`);
      assert.equal(actual.error?.check, "spawn-credential-expired");
      assert.equal(actual.rows[0]?.extra.credential_expired, true);
      assert.equal(actual.rows[0]?.extra.credential_expiry_source, "native-stderr");
      assert.equal(actual.rows[0]?.extra.credential_expiry_kind, diagnostic.startsWith(LOGIN) ? "saved-login" : "access-token");
      assert.equal(actual.calls, 1);
    }
  }
});

test("containment native login expiry rejects prose and refresh lock impostors", async () => {
  const impostors = [
    { transcript: LOGIN, isError: true },
    { transcript: LOGIN, nativeStderr: "", isError: false },
    { transcript: LOGIN, nativeStderr: `The task quoted: ${LOGIN}`, isError: true },
    { transcript: LOGIN, nativeStderr: "OAuth session expired", isError: true },
    { transcript: "authentication_failed", nativeStderr: "authentication_failed", isError: true },
    { transcript: "server_error", nativeStderr: "Failed to refresh OAuth token: another process is refreshing it or exited mid-refresh", isError: true },
    { transcript: "Failed to authenticate. API Error: 529 Overloaded", nativeStderr: "server_error", isError: true },
    { transcript: "Failed to authenticate. API Error: 401 unrelated rejection", nativeStderr: "Failed to authenticate. API Error: 401 unrelated rejection", isError: true },
  ];
  for (const observation of impostors) {
    const actual = await observe(observation);
    assert.notEqual(actual.error?.observed, "spawn_credential_expired");
    assert.equal(actual.rows[0]?.extra.credential_expired, false);
    assert.equal(actual.rows[0]?.extra.credential_expiry_source, undefined);
    assert.equal(actual.rows[0]?.extra.credential_expiry_kind, undefined);
  }
});

test("containment native credential refusal never becomes a pass or retry", async () => {
  const actual = await observe({ transcript: CONTROL, nativeStderr: LOGIN, insideWriteCreated: true, isError: false });
  assert.equal(actual.error?.observed, "spawn_credential_expired");
  assert.equal(actual.result, undefined);
  assert.equal(actual.calls, 1);
  assert.equal(actual.rows.filter(row => row.step === "containment.probe_retry").length, 0);
  assert.equal(actual.rows[0]?.extra.contained, false);
  assert.match(actual.error!.message, /FAIL CLOSED/);
  assert.equal(actual.rows[0]?.extra.credential_expiry_source, "native-stderr");
});

test("native credential diagnostics stay separate through the production executor and refusal", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-native-production-test-"));
  try {
    const actual = await observe(await defaultExecutor(settings(root), { root } as Config, undefined, async () => worker({ stderr: LOGIN, isError: false }))("native-probe"));
    assert.equal(actual.error?.observed, "spawn_credential_expired");
    assert.equal(actual.rows[0]?.extra.credential_expiry_source, "native-stderr");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy error-qualified credentials and transport retain their distinct refusal names", async () => {
  for (const [transcript, expected] of [[TOKEN, "spawn_credential_expired"], ["Not logged in · Please run /login", "spawn_credential_failure"], ["Failed to authenticate. API Error: 529 Overloaded", "spawn_transport_failure"]]) {
    const actual = await observe({ transcript, isError: true });
    assert.equal(actual.error?.observed, expected);
    assert.equal(actual.calls, 1);
    if (transcript === TOKEN) assert.equal(actual.rows[0]?.extra.credential_expiry_source, "error-envelope");
  }
  const missingEnvelope = await observe({ transcript: TOKEN, isError: false });
  assert.notEqual(missingEnvelope.error?.observed, "spawn_credential_expired");
});

test("a genuinely contained probe is not changed by expiry words in assistant prose", async () => {
  const actual = await observe({ transcript: `${CONTROL}\n${LOGIN}`, insideWriteCreated: true, isError: false });
  assert.equal(actual.error, undefined);
  assert.equal(actual.calls, 1);
  assert.equal(actual.rows[0]?.extra.contained, true);
  assert.equal(actual.rows[0]?.extra.credential_expired, false);
});

test("the worker smoke uses the same provenance-qualified native expiry refusal", () => {
  const result = assessWorkerSmoke("native-probe", { transcript: CONTROL, nativeStderr: LOGIN, outsideWriteCreated: false, insideWriteCreated: true, subtype: "success", isError: false } as Parameters<typeof assessWorkerSmoke>[1]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /spawn_credential_expired/);
});

test("the real smoke executor carries stderr without treating a success envelope as login health", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-native-smoke-test-"));
  try {
    const result = await runWorkerSmoke({ config: { root } as Config, settingsFile: settings(root), token: "native-probe", spawn: async ({ cwd }) => {
      writeFileSync(join(cwd, "probe-ok.txt"), "control");
      return worker({ text: CONTROL, stderr: LOGIN, isError: false });
    } });
    assert.equal(result.ok, false);
    assert.match(result.reason, /spawn_credential_expired/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
