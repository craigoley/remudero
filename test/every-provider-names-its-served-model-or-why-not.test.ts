import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { Config } from "#src/lib/config.js";
import { fixedClock, type Clock } from "#src/lib/clock.js";
import { benchmarkRunAttemptReceipt, benchmarkWorkerAttemptResources, spawnFailureDetail } from "#src/lib/benchmark-run.js";
import { workerLedgerFields, type WorkerResult } from "#src/lib/worker.js";
import {
  CASH_SERVED_MODEL_REASONS,
  CODEX_REROUTE_RE,
  CODEX_SERVED_MODEL_REASON,
  cashResponseModel,
  codexServedModel,
  cashServedModel,
  spawnCodexWorker,
  spawnOpenWeightWorker,
} from "#src/lib/worker-provider.js";

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

async function runCash(fetchImpl: typeof fetch, model = "gpt-5-nano", clock: Clock = fixedClock(NOW)) {
  const f = cashFixture();
  try {
    return await spawnOpenWeightWorker({
      cwd: f.root, workerHome: join(f.root, "home"), prompt: "classify",
      env: { RMD_OPENWEIGHT_API_KEY: "test-only-key" }, clock, fetchImpl,
    }, f.config, { model, effort: "low" });
  } finally { f.cleanup(); }
}

/** A clock that passes every request deadline the moment `expire()` runs: the reply then lands too late. */
function lateClock() {
  let ms = NOW;
  const clock: Clock = { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() };
  return { clock, expire: () => { ms = NOW + 24 * 60 * 60_000; } };
}

/** A valid, settled reply that arrives after the attempt's deadline has passed. */
function lateReply(expire: () => void, body: Record<string, unknown>): typeof fetch {
  return async () => { expire(); return new Response(JSON.stringify(body), { status: 200 }); };
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

test("a multi-response cash attempt records the latest model a response named, and a reason only when none did", () => {
  assert.deepEqual(cashServedModel(["gpt-oss-120b", "gpt-oss-120b"]), { servedModel: "gpt-oss-120b" });
  // W1-T13868: a name the call received is never dropped because another response omitted or changed it.
  assert.deepEqual(cashServedModel(["gpt-oss-120b", "gpt-5-nano"]), { servedModel: "gpt-5-nano" });
  assert.deepEqual(cashServedModel(["gpt-oss-120b", undefined]), { servedModel: "gpt-oss-120b" });
  assert.deepEqual(cashServedModel([undefined, undefined]),
    { servedModel: null, servedModelReason: CASH_SERVED_MODEL_REASONS.unnamed });
  assert.deepEqual(cashServedModel([]), { servedModel: null, servedModelReason: CASH_SERVED_MODEL_REASONS.noResponse });
  assert.equal(cashResponseModel("gpt-5-nano-2025-08-07"), "gpt-5-nano-2025-08-07");
  for (const notAnId of [undefined, null, "", " ", "<synthetic>", 42, "x".repeat(200)]) {
    assert.equal(cashResponseModel(notAnId), undefined, String(notAnId));
  }
});

/** `turnItems` land in the first turn only; later turns carry just a message, as a turn codex did not reroute does. */
function codexProcess(turnItems: Record<string, unknown>[] = [], turns = 1) {
  const stdout = new PassThrough();
  const process = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout, stderr: new PassThrough() });
  setImmediate(() => {
    for (const event of [
      { type: "thread.started", thread_id: "codex-thread" },
      ...Array.from({ length: turns }, (_, turn) => [
        { type: "turn.started" },
        ...(turn === 0 ? turnItems : []).map((item) => ({ type: "item.completed", item })),
        { type: "item.completed", item: { type: "agent_message", text: "done" } },
        { type: "turn.completed", usage: { input_tokens: 3, output_tokens: 2 } },
      ]).flat(),
    ]) stdout.write(`${JSON.stringify(event)}\n`);
    stdout.end();
    setImmediate(() => process.emit("exit", 0));
  });
  return process;
}

async function runCodex(turnItems: Record<string, unknown>[] = [], turns = 1): Promise<WorkerResult> {
  const root = mkdtempSync(join(tmpdir(), "rmd-served-model-codex-"));
  try {
    return await spawnCodexWorker({
      workerHome: join(root, "home"), cwd: process.cwd(), prompt: "review",
      settingsFile: join(process.cwd(), "settings", "worker.json"), tools: ["Read", "Grep", "Glob", "Bash"],
      containment: { spawn: () => ({ process: codexProcess(turnItems, turns) as never, pid: 31_337 }), teardown: () => {} },
    }, {
      claudeBin: "/unused/claude", root,
      workerProviders: { enabled: ["codex"], codexBin: "/bin/sh", codexModel: "gpt-6-luna", codexHome: join(root, "codex-home") },
    } as Config, { model: "gpt-6-luna", effort: "low" });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/** A codex that streams `items` in one turn, then hangs until the clock bound tears it down. */
async function runHungCodex(items: Record<string, unknown>[]): Promise<unknown> {
  const root = mkdtempSync(join(tmpdir(), "rmd-served-model-codex-hung-"));
  const stdout = new PassThrough();
  const process = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout, stderr: new PassThrough() });
  setImmediate(() => {
    for (const event of [{ type: "thread.started", thread_id: "codex-thread" }, { type: "turn.started" },
      ...items.map((item) => ({ type: "item.completed", item }))]) stdout.write(`${JSON.stringify(event)}\n`);
  });
  try {
    await spawnCodexWorker({
      workerHome: join(root, "home"), cwd: globalThis.process.cwd(), prompt: "review", clockBound: { boundMs: 200 },
      settingsFile: join(globalThis.process.cwd(), "settings", "worker.json"), tools: ["Read", "Grep", "Glob", "Bash"],
      containment: { spawn: () => ({ process: process as never, pid: 31_338 }),
        teardown: () => { stdout.end(); setImmediate(() => process.emit("exit", null, "SIGTERM")); } },
    }, {
      claudeBin: "/unused/claude", root,
      workerProviders: { enabled: ["codex"], codexBin: "/bin/sh", codexModel: "gpt-6-luna", codexHome: join(root, "codex-home") },
    } as Config, { model: "gpt-6-luna", effort: "low" });
    return undefined;
  } catch (error) { return error; } finally { rmSync(root, { recursive: true, force: true }); }
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

test("W1-T13868 criterion 1: a codex call and a GPT call each record the model the response named, or the named reason none was", async () => {
  // codex-rs rust-v0.152.0 streams the server's model only as a reroute: an `error` item, never a failure.
  const reroute = { type: "error", message: "model rerouted: gpt-6-luna -> gpt-5.2 (HighRiskCyberActivity)" };
  const rerouted = await runCodex([reroute]);
  assert.equal(rerouted.isError, false, rerouted.stderr);
  assert.equal(rerouted.model, "gpt-6-luna", "the request half is unchanged");
  assert.equal(rerouted.servedModel, "gpt-5.2");
  assert.equal(rerouted.servedModelReason, undefined);
  assert.equal(workerLedgerFields(rerouted).served_model, "gpt-5.2");
  assert.equal("served_model_reason" in benchmarkWorkerAttemptResources(rerouted), false, "a named model carries no reason");

  // No reroute: codex only logs a matching model, so the request is never written as what served it.
  const plain = await runCodex([{ type: "error", message: "some unrelated warning" }]);
  assert.equal(plain.servedModel, null);
  assert.equal(plain.servedModelReason, CODEX_SERVED_MODEL_REASON);
  assert.equal(workerLedgerFields(plain).served_model_reason, CODEX_SERVED_MODEL_REASON);

  // Only codex's own reroute line names a model; an unrelated error item or agent prose that mentions a reroute does not.
  assert.equal(CODEX_REROUTE_RE.test(reroute.message), true);
  assert.equal(CODEX_REROUTE_RE.exec(reroute.message)?.[2], "gpt-5.2");
  assert.equal(CODEX_REROUTE_RE.test("some unrelated warning"), false);
  assert.equal(CODEX_REROUTE_RE.test("the model rerouted: a -> b (x)"), false);

  // A call that received any model name records it, even when only one of its turns was rerouted.
  const twoTurns = await runCodex([reroute], 2);
  assert.equal(twoTurns.servedModel, "gpt-5.2");
  assert.equal(twoTurns.servedModelReason, undefined);
  assert.deepEqual(codexServedModel(["gpt-5.1", "gpt-5.2"]), { servedModel: "gpt-5.2" }, "the latest reported name wins");
  assert.deepEqual(codexServedModel([]), { servedModel: null, servedModelReason: CODEX_SERVED_MODEL_REASON });

  // A codex call that received a reroute and then hit its clock bound throws, but its failed-attempt row still
  // records the model it was served; one that received none records the named reason.
  const hung = await runHungCodex([reroute]);
  assert.ok(hung instanceof Error && /clock bound/.test(hung.message), String(hung));
  const hungRow = spawnFailureDetail(hung, true);
  assert.equal(hungRow.served_model, "gpt-5.2");
  assert.deepEqual(benchmarkRunAttemptReceipt({ step: "worker.attempt", ...hungRow })?.servedModel,
    { state: "observed", value: "gpt-5.2" });
  const hungUnnamed = spawnFailureDetail(await runHungCodex([]), true);
  assert.equal(hungUnnamed.served_model, null);
  assert.equal(hungUnnamed.served_model_reason, CODEX_SERVED_MODEL_REASON);
  assert.equal("served_model" in spawnFailureDetail(new Error("plain"), true), false, "an error with no observation adds nothing");

  // A GPT call over the cash Chat Completions path names what its response named, or why not. Each call succeeds,
  // so the recorded name comes from a real answer, not from an error result.
  const gpt = await runCash(cashReply({ model: "gpt-5-nano-2025-08-07" }), "gpt-5-nano");
  assert.equal(gpt.isError, false, gpt.stderr);
  assert.equal(gpt.servedModel, "gpt-5-nano-2025-08-07");
  assert.equal(workerLedgerFields(gpt as WorkerResult).served_model, "gpt-5-nano-2025-08-07");
  const gptUnnamed = await runCash(cashReply({}), "gpt-5-nano");
  assert.equal(gptUnnamed.isError, false, gptUnnamed.stderr);
  assert.equal(gptUnnamed.servedModel, null);
  assert.equal(gptUnnamed.servedModelReason, CASH_SERVED_MODEL_REASONS.unnamed);

  // A reply that named its model and settled its usage, then missed the deadline, still names that model:
  // the attempt fails, but it did receive a response. Chat Completions, Responses and Foundry Messages alike.
  const chatLate = lateClock();
  const chatTimedOut = await runCash(lateReply(chatLate.expire, {
    id: "chat-1", model: "gpt-5-nano-2025-08-07", choices: [{ message: { content: "done" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 5 },
  }), "gpt-5-nano", chatLate.clock);
  assert.equal(chatTimedOut.isError, true, "the deadline still fails the attempt");
  assert.equal(chatTimedOut.servedModel, "gpt-5-nano-2025-08-07");
  assert.equal(chatTimedOut.servedModelReason, undefined);
  const responsesLate = lateClock();
  const responsesTimedOut = await runCash(lateReply(responsesLate.expire, {
    id: "resp-1", model: "gpt-6.2-sol-2026-10-01", status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }],
    usage: { input_tokens: 20, output_tokens: 5 },
  }), "gpt-6.2-sol", responsesLate.clock);
  assert.equal(responsesTimedOut.isError, true, "the deadline still fails the attempt");
  assert.equal(responsesTimedOut.servedModel, "gpt-6.2-sol-2026-10-01");
  assert.equal(workerLedgerFields(responsesTimedOut as WorkerResult).served_model, "gpt-6.2-sol-2026-10-01");
  const foundryLate = lateClock();
  const f = cashFixture();
  try {
    const foundryTimedOut = await spawnOpenWeightWorker({
      cwd: f.root, workerHome: join(f.root, "home"), prompt: "classify", cashSqueezed: true,
      env: { RMD_FOUNDRY_CLAUDE_API_KEY: "test-only-key", RMD_FOUNDRY_CLAUDE_ENDPOINT: "https://foundry.example.test/anthropic" },
      clock: foundryLate.clock,
      fetchImpl: lateReply(foundryLate.expire, { id: "msg-1", model: "claude-opus-5-5-20260920", stop_reason: "end_turn",
        content: [{ type: "text", text: "done" }], usage: { input_tokens: 10, output_tokens: 4 } }),
    }, f.config, { model: "claude-opus-5-5", effort: "medium" });
    assert.equal(foundryTimedOut.isError, true, "the deadline still fails the attempt");
    assert.equal(foundryTimedOut.servedModel, "claude-opus-5-5-20260920");
  } finally { f.cleanup(); }
});
