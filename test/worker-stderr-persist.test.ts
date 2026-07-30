import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import { defaultExecutor as containmentDefaultExecutor, probeContainment } from "../src/lib/containment.js";
import { defaultExecutor as isolationDefaultExecutor, probeIsolation } from "../src/lib/isolation.js";
import type { Config } from "../src/lib/config.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";
import {
  capStderrExcerpt,
  collectWorkerResult,
  STDERR_EXCERPT_CAP,
  workerFailureExcerpt,
  workerLedgerFields,
} from "../src/lib/worker.js";

/** Minimal fake WorkerResult — only the fields the defaultExecutor call sites read. */
function fakeWorkerResult(overrides: Partial<WorkerResult>): WorkerResult {
  return {
    sessionId: "sess-fake",
    costUsd: 0.01,
    numTurns: 1,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    ...overrides,
  } as WorkerResult;
}

function fakeConfigWithRoot(): Config {
  const root = mkdtempSync(join(tmpdir(), "rmd-stderr-persist-root-"));
  return { root } as Config;
}

// ── W1-T238: "the decisive stderr existed in memory on all four failing spawns
// and was discarded" — collectWorkerResult already captures the child's stderr
// (and, on a swallowed error-result throw, the SDK's message too) into
// WorkerResult.stderr/text, but nothing ever wrote it to disk: every call site
// spread `workerLedgerFields(result)` onto its ledger line, and that shape never
// carried stderr. These tests prove the excerpt is now on that shape (recoverable
// after the run, keyed by the run_id/task_id already on every ledger line),
// capped, and absent on a clean spawn.

function tmpLedgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-stderr-persist-"));
  return join(dir, "ledger.ndjson");
}

/** A settings file that passes probeContainment's gate-1 (validateWorkerSettingsFile) —
 * mirrors test/containment.test.ts's own fixture so this test exercises the same real
 * gate rather than an injected shortcut. */
function enabledSandboxSettingsFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-stderr-persist-settings-"));
  const path = join(dir, "worker.json");
  writeFileSync(
    path,
    JSON.stringify({
      sandbox: { enabled: true, failIfUnavailable: true },
      permissions: { deny: [], allow: [], ask: [] },
    }),
  );
  return path;
}

/** The WS-1 failure shape reused from worker.test.ts: the SDK yields the error
 * result envelope and THEN throws — collectWorkerResult swallows the throw and
 * pushes its message onto stderrChunks (worker.ts's documented behavior). */
function errorResultStream(subtype: string) {
  return (async function* (): AsyncGenerator<unknown> {
    yield {
      type: "result",
      subtype,
      is_error: true,
      result: "",
      session_id: "sess-err",
      total_cost_usd: 0.1,
      num_turns: 3,
      permission_denials: [],
    };
    throw new Error("Not logged in - Please run /login");
  })();
}

async function* successStream(): AsyncGenerator<unknown> {
  yield {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "PR_URL: https://github.com/x/y/pull/9",
    session_id: "sess-ok",
    total_cost_usd: 0.2,
    num_turns: 4,
    permission_denials: [],
  };
}

test("acceptance: a spawn returning isError=true leaves its stderr and result text recoverable from disk after the run, keyed to the run id", async () => {
  const stderrChunks = ["child stderr: Not logged in - Please run /login\n"];
  const r = await collectWorkerResult(errorResultStream("error_during_execution"), {
    childEnvKeys: [],
    stderrChunks,
  });
  assert.equal(r.isError, true);
  assert.match(r.stderr, /Not logged in - Please run \/login/);

  const fields = workerLedgerFields(r);
  assert.ok(fields.stderr_excerpt, "isError=true must carry a stderr_excerpt");
  assert.match(fields.stderr_excerpt!, /Not logged in - Please run \/login/);
  // the swallowed error-result throw message is folded in too (worker.ts's own
  // "[collectWorkerResult] error-result throw swallowed: …" push).
  assert.match(fields.stderr_excerpt!, /error-result throw swallowed/);

  const ledgerPath = tmpLedgerPath();
  try {
    appendLedger(ledgerPath, { run_id: "run-238", task_id: "T-1", step: "worker.spawn", ...fields });
    const lines = readLedgerLines(ledgerPath);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].run_id, "run-238");
    assert.equal(lines[0].task_id, "T-1");
    assert.match(String(lines[0].stderr_excerpt), /Not logged in - Please run \/login/);
  } finally {
    rmSync(join(ledgerPath, ".."), { recursive: true, force: true });
  }
});

test("acceptance: the persisted stderr is length-capped, so a large transcript cannot bloat the ledger", () => {
  const huge = "x".repeat(STDERR_EXCERPT_CAP * 3);
  const capped = capStderrExcerpt(huge);
  assert.ok(capped.length < huge.length);
  assert.ok(capped.length <= STDERR_EXCERPT_CAP + 64, "capped output must stay close to the cap, not merely smaller");
  assert.match(capped, /truncated/);

  const r = {
    isError: true,
    stderr: huge,
    text: "",
  };
  const excerpt = workerFailureExcerpt(r);
  assert.ok(excerpt);
  assert.ok(excerpt!.length <= STDERR_EXCERPT_CAP + 64);
});

test("acceptance: a clean spawn does not spam the surface - persistence fires on failure or isError, not on every success", async () => {
  const r = await collectWorkerResult(successStream(), { childEnvKeys: [] });
  assert.equal(r.isError, false);
  const fields = workerLedgerFields(r);
  assert.equal("stderr_excerpt" in fields, false, "a clean success line must never carry stderr_excerpt");
  assert.equal(workerFailureExcerpt(r), undefined);

  const ledgerPath = tmpLedgerPath();
  try {
    appendLedger(ledgerPath, { run_id: "run-239", task_id: "T-2", step: "worker.spawn", ...fields });
    const lines = readLedgerLines(ledgerPath);
    assert.equal("stderr_excerpt" in lines[0], false);
  } finally {
    rmSync(join(ledgerPath, ".."), { recursive: true, force: true });
  }
});

// ── The two named non-ledgering call sites (design block: "the containment
// probe" / isolation probe each spawn workers but never ledgered per-call
// telemetry via workerLedgerFields) — proven directly against their own `log`
// callback, which run-task.ts already wires straight into the run's
// appendLedger closure (run_id/task_id already bound there).

test("acceptance: the containment probe persists a capped stderr excerpt on log('containment.probe', …) only when the probe spawn itself errored", async () => {
  const events: Array<[string, Record<string, unknown> | undefined]> = [];
  // NOTE: the transcript deliberately avoids the "not logged in" / "run /login"
  // credential-failure phrasing (W1-T237's CREDENTIAL_FAILURE_RE /
  // CREDENTIAL_LOGIN_HINT_RE) — this test is exercising the generic
  // isError-persists-stderr path, not the credential-failure branch, which has
  // its own dedicated coverage in containment.test.ts.
  await probeContainment({
    settingsFile: enabledSandboxSettingsFile(),
    exec: async (token) => ({
      transcript: `outside: touch: cannot touch '../${token}.txt': Operation not permitted\nsome transient tool error\ninside: ok`,
      outsideWriteCreated: false,
      insideWriteCreated: true,
      costUsd: 0.05,
      isError: true,
    }),
    log: (step, extra) => events.push([step, extra]),
  });
  const [, extra] = events.find(([step]) => step === "containment.probe")!;
  assert.match(String(extra?.stderr_excerpt), /some transient tool error/);
});

test("acceptance: the containment probe does not persist an excerpt for a clean (non-erroring) probe spawn", async () => {
  const events: Array<[string, Record<string, unknown> | undefined]> = [];
  await probeContainment({
    settingsFile: enabledSandboxSettingsFile(),
    exec: async (token) => ({
      transcript: `outside: touch: cannot touch '../${token}.txt': Operation not permitted\ninside: ok`,
      outsideWriteCreated: false,
      insideWriteCreated: true,
      costUsd: 0.05,
      isError: false,
    }),
    log: (step, extra) => events.push([step, extra]),
  });
  const [, extra] = events.find(([step]) => step === "containment.probe")!;
  assert.equal(extra && "stderr_excerpt" in extra, false);
});

test("acceptance: the isolation probe persists a capped stderr excerpt on log('isolation.probe', …) only when the probe spawn itself errored", async () => {
  const events: Array<[string, Record<string, unknown> | undefined]> = [];
  await probeIsolation({
    settingsFile: enabledSandboxSettingsFile(),
    exec: async () => ({
      transcript: "alias_count: 0\nfunction_count: 0\nNot logged in - Please run /login",
      aliasCount: 0,
      functionCount: 0,
      costUsd: 0.05,
      isError: true,
    }),
    log: (step, extra) => events.push([step, extra]),
  });
  const [, extra] = events.find(([step]) => step === "isolation.probe")!;
  assert.match(String(extra?.stderr_excerpt), /Not logged in - Please run \/login/);
});

// ── The REAL (non-injected-exec) code paths: `probeContainment`/`probeIsolation`
// resolve to `defaultExecutor` whenever the caller doesn't supply `exec`, and it is
// THAT function's own `isError: probe.isError` line — never reached by the `exec`
// fakes above — that this task's fix touches. Exercised directly here with an
// injected `spawn` (defaulting to the real spawnWorker in production) so the real
// propagation is under coverage without paying for an actual SDK spawn.

test("acceptance: containment.ts's real defaultExecutor propagates a failed probe spawn's isError (not only the exec-fake path)", async () => {
  const settingsFile = enabledSandboxSettingsFile();
  const config = fakeConfigWithRoot();
  const fakeSpawn = async (_args: SpawnWorkerArgs) =>
    fakeWorkerResult({
      isError: true,
      stderr: "Not logged in - Please run /login\n",
      text: "outside: touch: Operation not permitted\ninside: ok",
    });
  const exec = containmentDefaultExecutor(settingsFile, config, undefined, fakeSpawn);
  const result = await exec("tok-real-238");
  assert.equal(result.isError, true);
  assert.match(result.transcript, /Not logged in - Please run \/login/);
});

test("acceptance: containment.ts's real defaultExecutor reports isError=false on a clean probe spawn", async () => {
  const settingsFile = enabledSandboxSettingsFile();
  const config = fakeConfigWithRoot();
  const fakeSpawn = async (_args: SpawnWorkerArgs) =>
    fakeWorkerResult({ isError: false, text: "outside: touch: Operation not permitted\ninside: ok" });
  const exec = containmentDefaultExecutor(settingsFile, config, undefined, fakeSpawn);
  const result = await exec("tok-real-238-clean");
  assert.equal(result.isError, false);
});

test("acceptance: isolation.ts's real defaultExecutor propagates a failed probe spawn's isError (not only the exec-fake path)", async () => {
  const settingsFile = enabledSandboxSettingsFile();
  const config = fakeConfigWithRoot();
  const fakeSpawn = async (_args: SpawnWorkerArgs) =>
    fakeWorkerResult({
      isError: true,
      stderr: "Not logged in - Please run /login\n",
      text: "alias_count: 0\nfunction_count: 0",
    });
  const exec = isolationDefaultExecutor(settingsFile, config, undefined, fakeSpawn);
  const result = await exec();
  assert.equal(result.isError, true);
  assert.match(result.transcript, /Not logged in - Please run \/login/);
});

test("acceptance: isolation.ts's real defaultExecutor reports isError=false on a clean probe spawn", async () => {
  const settingsFile = enabledSandboxSettingsFile();
  const config = fakeConfigWithRoot();
  const fakeSpawn = async (_args: SpawnWorkerArgs) =>
    fakeWorkerResult({ isError: false, text: "alias_count: 0\nfunction_count: 0" });
  const exec = isolationDefaultExecutor(settingsFile, config, undefined, fakeSpawn);
  const result = await exec();
  assert.equal(result.isError, false);
});
