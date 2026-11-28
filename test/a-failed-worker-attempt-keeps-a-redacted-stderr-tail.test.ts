import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { benchmarkNonDispatchSpawn } from "#src/lib/benchmark-run.js";
import type { Config } from "#src/lib/config.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

type Row = Record<string, unknown>;

function worker(over: Partial<WorkerResult> = {}): WorkerResult {
  return {
    sessionId: "stderr-tail-session", costUsd: 0, numTurns: 0, text: "",
    blocks: [], stderr: "", subtype: "success", isError: false, apiError: false,
    permissionDenials: [], childEnvKeys: [], model: "gpt-6-luna", servedModel: "gpt-6-luna",
    effort: "low", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false, workerDurationMs: 3800, provider: "codex", ...over,
  } as WorkerResult;
}

/** Runs one risk-judge attempt through the production non-dispatch wrapper and returns its worker.attempt row. */
async function attemptRow(result: WorkerResult): Promise<Row> {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}stderr-tail-`));
  try {
    const config = { root } as Config;
    const spawn = benchmarkNonDispatchSpawn("risk-judge", async () => result);
    await spawn({ cwd: root, permissionMode: "bypassPermissions", settingsFile: "s", prompt: "p", config });
    const rows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as Row).filter((row) => row.step === "worker.attempt");
    assert.equal(rows.length, 1, "one attempt writes one worker.attempt row");
    return rows[0]!;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("W1-T15168 criterion 1: a failed attempt's worker.attempt row keeps the last 600 bytes or fewer of its stderr", async () => {
  const short = await attemptRow(worker({ subtype: "error_exit_1", isError: true,
    stderr: "Error: model gpt-6-luna is not available on this account\n" }));
  assert.equal(short.stderr_tail, "Error: model gpt-6-luna is not available on this account\n");

  const long = "x".repeat(2000) + "\nfatal: the provider closed the stream before the first event\n";
  const row = await attemptRow(worker({ subtype: "error_exit_1", isError: true, stderr: long }));
  const tail = row.stderr_tail as string;
  assert.ok(Buffer.byteLength(tail, "utf8") <= 600, "the tail is capped at 600 bytes");
  assert.ok(tail.endsWith("fatal: the provider closed the stream before the first event\n"), "the tail keeps the END, where the cause is");
});

test("W1-T15168 criterion 2: invariant:no-secret-reaches-the-ledger — secrets in stderr are replaced, and a successful attempt keeps no tail", async () => {
  const bearer = "Bearer abcdEFGH1234ijklMNOP5678qrst";
  const apiKey = "sk-ant-api03-ZZZZyyyyXXXXwwwwVVVV1234";
  const authHeader = "authorization: s3cr3t-header-value-9876";
  const row = await attemptRow(worker({ subtype: "error_exit_1", isError: true,
    stderr: `request failed\n${bearer}\nkey ${apiKey}\n${authHeader}\nexit 1\n` }));
  const tail = row.stderr_tail as string;
  assert.ok(typeof tail === "string" && tail.includes("exit 1"), "the failure still keeps a tail");
  for (const secret of ["abcdEFGH1234ijklMNOP5678qrst", apiKey, "s3cr3t-header-value-9876"]) {
    assert.ok(!tail.includes(secret), `the ledger row never carries ${secret.slice(0, 6)}…`);
    assert.ok(!JSON.stringify(row).includes(secret), "no other field of the row carries it either");
  }
  assert.ok(tail.includes("<redacted>"), "each secret is replaced, not dropped silently");

  const ok = await attemptRow(worker({ subtype: "success", stderr: "warning: slow network\n" }));
  assert.equal(Object.hasOwn(ok, "stderr_tail"), false, "a successful attempt's row carries no stderr_tail");
  const silent = await attemptRow(worker({ subtype: "error_exit_1", isError: true, stderr: "" }));
  assert.equal(Object.hasOwn(silent, "stderr_tail"), false, "a failed attempt with no stderr carries no empty tail");
});
