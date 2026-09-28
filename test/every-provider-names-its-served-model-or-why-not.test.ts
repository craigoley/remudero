import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import { fixedClock } from "../src/lib/clock.js";
import { benchmarkRunAttemptReceipt, benchmarkWorkerAttemptResources } from "../src/lib/benchmark-run.js";
import { workerLedgerFields, type WorkerResult } from "../src/lib/worker.js";
import {
  CASH_SERVED_MODEL_REASONS,
  CODEX_SERVED_MODEL_REASON,
  cashResponseModel,
  cashServedModel,
  spawnCodexWorker,
  spawnOpenWeightWorker,
} from "../src/lib/worker-provider.js";

// W1-T4650: claude attempts named their served model in 242 of 258 rows, codex in 0 of 100 and
// cash in 0 of 260 — and none of the unnamed rows said why. Each provider now either names the
// model its own response reported, or names the reason it cannot.

const NOW = Date.parse("2026-09-28T12:00:00Z");

function cashFixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-served-model-"));
  const config = {
    root, claudeBin: "/unused", dailyCapUsd: 5,
    workerProviders: { enabled: ["cash"], cashEndpoint: "https://openai.example.test/" },
  } as Config;
  return { root, config, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function cashReply(extra: Record<string, unknown>) {
  return async () => new Response(JSON.stringify({
    id: "chat-1", choices: [{ message: { content: "done" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 5 }, ...extra,
  }), { status: 200 });
}

async function runCash(fetchImpl: typeof fetch, model = "gpt-5-nano") {
  const f = cashFixture();
  try {
    return await spawnOpenWeightWorker({
      cwd: f.root, workerHome: join(f.root, "home"), prompt: "classify",
      env: { RMD_OPENWEIGHT_API_KEY: "test-only-key" }, clock: fixedClock(NOW), fetchImpl,
    }, f.config, { model, effort: "low" });
  } finally { f.cleanup(); }
}

test("a cash response naming a DIFFERENT model than requested records the response's model, never the request", async () => {
  const result = await runCash(cashReply({ model: "gpt-5-nano-2025-08-07" }));
  assert.equal(result.isError, false, result.stderr);
  assert.equal(result.model, "gpt-5-nano", "the request half is unchanged");
  assert.equal(result.servedModel, "gpt-5-nano-2025-08-07");
  assert.equal(result.servedModelReason, undefined);
  const fields = workerLedgerFields(result as WorkerResult);
  assert.equal(fields.served_model, "gpt-5-nano-2025-08-07");
  assert.equal(fields.served_model_reason, undefined);
});

test("a cash response with no model records a named reason instead of the requested deployment", async () => {
  const result = await runCash(cashReply({}));
  assert.equal(result.isError, false, result.stderr);
  assert.equal(result.servedModel, null);
  assert.equal(result.servedModelReason, CASH_SERVED_MODEL_REASONS.unnamed);
  assert.equal(workerLedgerFields(result as WorkerResult).served_model_reason, CASH_SERVED_MODEL_REASONS.unnamed);
});

test("a cash attempt that received no response names that reason", async () => {
  const result = await runCash(async () => new Response("unavailable", { status: 503 }));
  assert.equal(result.isError, true);
  assert.equal(result.servedModel, null);
  assert.equal(result.servedModelReason, CASH_SERVED_MODEL_REASONS.noResponse);
});

async function runFoundry(stopReason: string) {
  const f = cashFixture();
  try {
    return await spawnOpenWeightWorker({
      cwd: f.root, workerHome: join(f.root, "home"), prompt: "classify", cashSqueezed: true,
      env: { RMD_FOUNDRY_CLAUDE_API_KEY: "test-only-key", RMD_FOUNDRY_CLAUDE_ENDPOINT: "https://foundry.example.test/anthropic" },
      clock: fixedClock(NOW),
      fetchImpl: async () => new Response(JSON.stringify({
        id: "msg-1", model: "claude-opus-5-5-20260920", stop_reason: stopReason,
        content: [{ type: "text", text: "done" }], usage: { input_tokens: 10, output_tokens: 4 },
      }), { status: 200 }),
    }, f.config, { model: "claude-opus-5-5", effort: "medium" });
  } finally { f.cleanup(); }
}

test("a Foundry Opus cash response records the model its message names, on success and on a failed turn", async () => {
  const ok = await runFoundry("end_turn");
  assert.equal(ok.isError, false, ok.stderr);
  assert.equal(ok.servedModel, "claude-opus-5-5-20260920");
  // A truncated reply is a failed attempt, but the response that reported it still named its model.
  const truncated = await runFoundry("max_tokens");
  assert.equal(truncated.isError, true);
  assert.equal(truncated.servedModel, "claude-opus-5-5-20260920");
});

test("a multi-response cash attempt reports a model only when every response named the same one", () => {
  assert.deepEqual(cashServedModel(["gpt-oss-120b", "gpt-oss-120b"]), { servedModel: "gpt-oss-120b" });
  assert.deepEqual(cashServedModel(["gpt-oss-120b", "gpt-5-nano"]),
    { servedModel: null, servedModelReason: `${CASH_SERVED_MODEL_REASONS.mixed}: gpt-5-nano, gpt-oss-120b` });
  assert.deepEqual(cashServedModel(["gpt-oss-120b", undefined]),
    { servedModel: null, servedModelReason: CASH_SERVED_MODEL_REASONS.unnamed });
  assert.deepEqual(cashServedModel([]), { servedModel: null, servedModelReason: CASH_SERVED_MODEL_REASONS.noResponse });
  assert.equal(cashResponseModel("gpt-5-nano-2025-08-07"), "gpt-5-nano-2025-08-07");
  for (const notAnId of [undefined, null, "", " ", "<synthetic>", 42, "x".repeat(200)]) {
    assert.equal(cashResponseModel(notAnId), undefined, String(notAnId));
  }
});

function codexProcess() {
  const stdout = new PassThrough();
  const process = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout, stderr: new PassThrough() });
  setImmediate(() => {
    for (const event of [
      { type: "thread.started", thread_id: "codex-thread" },
      { type: "turn.started" },
      { type: "item.completed", item: { type: "agent_message", text: "done" } },
      { type: "turn.completed", usage: { input_tokens: 3, output_tokens: 2 } },
    ]) stdout.write(`${JSON.stringify(event)}\n`);
    stdout.end();
    setImmediate(() => process.emit("exit", 0));
  });
  return process;
}

async function runCodex(): Promise<WorkerResult> {
  const root = mkdtempSync(join(tmpdir(), "rmd-served-model-codex-"));
  try {
    return await spawnCodexWorker({
      workerHome: join(root, "home"), cwd: process.cwd(), prompt: "review",
      settingsFile: join(process.cwd(), "settings", "worker.json"), tools: ["Read", "Grep", "Glob", "Bash"],
      containment: { spawn: () => ({ process: codexProcess() as never, pid: 31_337 }), teardown: () => {} },
    }, {
      claudeBin: "/unused/claude", root,
      workerProviders: { enabled: ["codex"], codexBin: "/bin/sh", codexModel: "gpt-6-luna", codexHome: join(root, "codex-home") },
    } as Config, { model: "gpt-6-luna", effort: "low" });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("a codex result records a fixed named reason, since its exec --json stream carries no model id", async () => {
  const result = await runCodex();
  assert.equal(result.isError, false, result.stderr);
  assert.equal(result.servedModel, null);
  assert.equal(result.servedModelReason, CODEX_SERVED_MODEL_REASON);
  assert.equal(workerLedgerFields(result).served_model_reason, CODEX_SERVED_MODEL_REASON);
});

test("the attempt row and its receipt carry the provider's own served-model reason", async () => {
  const codex = benchmarkWorkerAttemptResources(await runCodex());
  assert.equal(codex.served_model, null);
  assert.equal(codex.served_model_reason, CODEX_SERVED_MODEL_REASON);
  assert.deepEqual(benchmarkRunAttemptReceipt({ step: "worker.attempt", ...codex })?.servedModel,
    { state: "unavailable", reason: CODEX_SERVED_MODEL_REASON });

  const cash = benchmarkWorkerAttemptResources(await runCash(cashReply({})) as WorkerResult);
  assert.deepEqual(benchmarkRunAttemptReceipt({ step: "worker.attempt", ...cash })?.servedModel,
    { state: "unavailable", reason: CASH_SERVED_MODEL_REASONS.unnamed });

  const named = benchmarkWorkerAttemptResources(await runCash(cashReply({ model: "gpt-5-nano-2025-08-07" })) as WorkerResult);
  assert.equal("served_model_reason" in named, false, "a named model carries no reason");
  assert.deepEqual(benchmarkRunAttemptReceipt({ step: "worker.attempt", ...named })?.servedModel,
    { state: "observed", value: "gpt-5-nano-2025-08-07" });

  // A row written before the reason was carried still falls back to the generic string.
  assert.deepEqual(benchmarkRunAttemptReceipt({ step: "worker.attempt", served_model: null })?.servedModel,
    { state: "unavailable", reason: "provider-did-not-report-served-model" });
});
