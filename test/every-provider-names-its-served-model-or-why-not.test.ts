import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { Config } from "#src/lib/config.js";
import { fixedClock, type Clock } from "#src/lib/clock.js";
import { benchmarkNonDispatchSpawn, benchmarkRunAttemptReceipt, benchmarkWorkerAttemptResources, recordBenchmarkWorkerAttempt, spawnFailureDetail,
  terminalVerdictFields, THROWN_SERVED_MODEL_UNREADABLE } from "#src/lib/benchmark-run.js";
import { spawnWorker, WorkerAbandonedError, workerLedgerFields, type WorkerResult } from "#src/lib/worker.js";
import * as runtimeRegistry from "#src/lib/instance-registry-selection.js";
import { recordReviewFindings } from "#src/lib/review-findings.js";

import {
  CASH_SERVED_MODEL_REASONS,
  CODEX_REROUTE_RE,
  CODEX_SERVED_MODEL_REASON,
  CODEX_WORKER_STDOUT_STREAM_BACKSTOP_BYTES,
  cashResponseModel,
  codexServedModel,
  cashServedModel,
  spawnCodexWorker,
  spawnOpenWeightWorker,
  withObservedServedModel,
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

/** A reply whose headers arrive in time but whose body is held until `holdMs` after the request deadline aborted it. */
function heldBodyReply(body: Record<string, unknown>, holdMs: number): typeof fetch {
  return async () => new Response(new ReadableStream({ start(controller) {
    setTimeout(() => { controller.enqueue(new TextEncoder().encode(JSON.stringify(body))); controller.close(); }, holdMs);
  } }), { status: 200 });
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
function codexProcess(turnItems: Record<string, unknown>[] = [], turns = 1, finalModel?: string) {
  const stdout = new PassThrough();
  const process = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout, stderr: new PassThrough() });
  setImmediate(() => {
    for (const event of [
      { type: "thread.started", thread_id: "codex-thread" },
      ...Array.from({ length: turns }, (_, turn) => [
        { type: "turn.started" },
        ...(turn === 0 ? turnItems : []).map((item) => ({ type: "item.completed", item })),
        { type: "item.completed", item: { type: "agent_message", text: "done" } },
        { type: "turn.completed", usage: { input_tokens: 3, output_tokens: 2 },
          ...(finalModel !== undefined && turn === turns - 1 ? { model: finalModel } : {}) },
      ]).flat(),
    ]) stdout.write(`${JSON.stringify(event)}\n`);
    stdout.end();
    setImmediate(() => process.emit("exit", 0));
  });
  return process;
}

async function runCodex(turnItems: Record<string, unknown>[] = [], turns = 1, finalModel?: string): Promise<WorkerResult> {
  const root = mkdtempSync(join(tmpdir(), "rmd-served-model-codex-"));
  try {
    return await spawnCodexWorker({
      workerHome: join(root, "home"), cwd: process.cwd(), prompt: "review",
      settingsFile: join(process.cwd(), "settings", "worker.json"), tools: ["Read", "Grep", "Glob", "Bash"],
      containment: { spawn: () => ({ process: codexProcess(turnItems, turns, finalModel) as never, pid: 31_337 }), teardown: () => {} },
    }, {
      claudeBin: "/unused/claude", root,
      workerProviders: { enabled: ["codex"], codexBin: "/bin/sh", codexModel: "gpt-6-luna", codexHome: join(root, "codex-home") },
    } as Config, { model: "gpt-6-luna", effort: "low" });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/** A codex that streams `items` in one turn, then hangs until the clock bound tears it down. */
async function runHungCodex(items: Record<string, unknown>[], end: "hang" | "overflow" | "crash" = "hang"): Promise<unknown> {
  const root = mkdtempSync(join(tmpdir(), "rmd-served-model-codex-hung-"));
  const stdout = new PassThrough();
  const process = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout, stderr: new PassThrough() });
  setImmediate(() => {
    const lines = [{ type: "thread.started", thread_id: "codex-thread" }, { type: "turn.started" },
      ...items.map((item) => ({ type: "item.completed", item }))].map((event) => `${JSON.stringify(event)}\n`).join("");
    // `overflow`: the same complete lines arrive in ONE read chunk with the byte that crosses the stdout backstop.
    stdout.write(end === "overflow" ? Buffer.concat([Buffer.from(lines), Buffer.alloc(CODEX_WORKER_STDOUT_STREAM_BACKSTOP_BYTES, "x")]) : lines);
    // `crash`: the child process itself fails after the stream named the model.
    if (end === "crash") setImmediate(() => process.emit("error", new Error("codex child crashed")));
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

/** A codex call under a selected private registry that completes after its stream named `items`, and whose private
 * profile is then removed, so cleanup fails after the call already returned a result. */
async function runCleanupFailedCodex(items: Record<string, unknown>[]): Promise<unknown> {
  const root = mkdtempSync(join(tmpdir(), "rmd-served-model-codex-cleanup-"));
  const codexHome = join(root, "codex-home"), cwd = join(root, "checkout"), selected = join(root, "private.yaml");
  const registryText = "instances:\n  worker:\n    github_repo: owner/repo\n";
  mkdirSync(codexHome); mkdirSync(cwd); mkdirSync(join(root, ".remudero"));
  writeFileSync(join(root, ".remudero", "daemon-instances.yaml"), registryText.replace("repo\n", "repo\n    mode: live\n"));
  writeFileSync(selected, registryText.replace("repo\n", "repo\n    mode: shadow\n"));
  const run = Reflect.get(runtimeRegistry, "withInstanceRegistryRuntime") as <T>(op: () => Promise<T>, input: { envPath: string }) => Promise<T>;
  try {
    await run(() => spawnCodexWorker({
      cwd, workerHome: root, prompt: "review", settingsFile: join(globalThis.process.cwd(), "settings", "worker.json"),
      tools: ["Read", "Bash"],
      containment: { spawn: (options) => {
        const index = options.args.indexOf("--profile");
        unlinkSync(join(codexHome, options.args[index + 1]! + ".config.toml"));
        const stdin = new PassThrough(), stdout = new PassThrough();
        const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough() });
        stdin.on("finish", () => {
          stdout.end([{ type: "thread.started", thread_id: "codex-thread" }, { type: "turn.started" },
            ...items.map((item) => ({ type: "item.completed", item })), { type: "turn.completed", usage: {} }]
            .map((event) => `${JSON.stringify(event)}\n`).join(""));
          queueMicrotask(() => child.emit("exit", 0));
        });
        stdin.resume();
        return { process: child as never, pid: 31_339 };
      }, teardown: () => {} },
    }, { claudeBin: "/unused/claude", root,
      workerProviders: { enabled: ["codex"], codexBin: "/bin/sh", codexModel: "gpt-6-luna", codexHome } } as Config), { envPath: selected });
    return undefined;
  } catch (error) { return error; } finally { rmSync(root, { recursive: true, force: true }); }
}

/** A cash call routed through production `spawnWorker` whose adapter returns `result` only once the clock-bound watchdog
 * has aborted it: the reply that named a model came back, and a later turn stalled past the bound. */
async function runAbandonedCash(result: Partial<WorkerResult>, callerReason?: Error): Promise<unknown> {
  const root = mkdtempSync(join(tmpdir(), "rmd-served-model-abandoned-"));
  // `callerReason`: the CALLER's own signal aborts with this error instead of the clock-bound watchdog.
  const caller = new AbortController();
  if (callerReason !== undefined) setTimeout(() => caller.abort(callerReason), 5);
  try {
    await spawnWorker({ cwd: root, settingsFile: join(globalThis.process.cwd(), "settings", "worker.json"),
      permissionMode: "bypassPermissions", prompt: "bounded worker", model: "sonnet", effort: "low", maxTurns: 4,
      mountProvider: "cash", cashSqueezed: true, clockBound: { boundMs: callerReason === undefined ? 25 : 60_000, pollMs: 5 },
      ...(callerReason === undefined ? {} : { signal: caller.signal }),
      config: { root, dailyCapUsd: 25, workerProviders: { enabled: ["cash"], cashEndpoint: "https://openai.example.test/" } } as Config,
      providerRouting: { spawnOpenWeight: (args: { signal?: AbortSignal }) => new Promise((resolve) => {
        args.signal?.addEventListener("abort", () => resolve({ isError: true, subtype: "error_during_execution", text: "",
          stderr: "stalled second turn", numTurns: 2, durationMs: 30, totalCostUsd: 0, ...result } as never), { once: true });
      }) },
    } as never);
    return undefined;
  } catch (error) { return error; } finally { rmSync(root, { recursive: true, force: true }); }
}

/** Two cash calls through the production receipt wrapper, cancelled by ONE caller signal with ONE frozen error. Each
 *  rung names its own model. Returns the two calls' errors and the spawn-threw worker.attempt rows they wrote. */
async function runSharedSignalCash(models: readonly string[], lane: "benchmark" | "dispatch" = "benchmark"): Promise<{ errors: unknown[]; rows: Record<string, unknown>[] }> {
  const root = mkdtempSync(join(tmpdir(), "rmd-served-model-shared-signal-"));
  const shared = Object.freeze(new Error("caller cancelled every call"));
  const caller = new AbortController();
  setTimeout(() => caller.abort(shared), 5);
  // `dispatch`: the run-task dispatch lane's own receipt writer, which logs through its caller's `log`.
  const dispatchRows: Record<string, unknown>[] = [];
  const spawn: typeof spawnWorker = lane === "benchmark" ? benchmarkNonDispatchSpawn("served-model-shared-signal", spawnWorker)
    : (args) => recordBenchmarkWorkerAttempt(() => spawnWorker(args), (step, fields) => dispatchRows.push({ step, ...fields }),
      () => undefined, () => {});
  try {
    const errors = await Promise.all(models.map(async (servedModel, index) => {
      const cwd = join(root, `call-${index}`);
      mkdirSync(cwd);
      try {
        await spawn({ cwd, settingsFile: join(globalThis.process.cwd(), "settings", "worker.json"),
          permissionMode: "bypassPermissions", prompt: "bounded worker", model: "sonnet", effort: "low", maxTurns: 4,
          mountProvider: "cash", cashSqueezed: true, clockBound: { boundMs: 60_000, pollMs: 5 }, signal: caller.signal,
          config: { root, dailyCapUsd: 25, workerProviders: { enabled: ["cash"], cashEndpoint: "https://openai.example.test/" } } as Config,
          providerRouting: { spawnOpenWeight: (args: { signal?: AbortSignal }) => new Promise((resolve) => {
            args.signal?.addEventListener("abort", () => resolve({ isError: true, subtype: "error_during_execution", text: "",
              stderr: "stalled second turn", numTurns: 2, durationMs: 30, totalCostUsd: 0, servedModel } as never), { once: true });
          }) },
        } as never);
        return undefined;
      } catch (error) { return error; }
    }));
    const path = join(root, "state", "ledger.ndjson");
    const rows = (lane === "dispatch" ? dispatchRows : existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>) : [])
      .filter((row) => row.step === "worker.attempt" && row.worker_failure === "spawn-threw-before-result");
    return { errors, rows };
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
  // An event that itself carries a model id (codex 0.152.0 streams none) names what served the call: the latest name wins.
  const finalNamed = await runCodex([], 1, "gpt-5.3-codex");
  assert.equal(finalNamed.servedModel, "gpt-5.3-codex");
  assert.equal(finalNamed.servedModelReason, undefined);
  assert.equal((await runCodex([reroute], 1, "gpt-5.3-codex")).servedModel, "gpt-5.3-codex", "the final event is the latest name");
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
  // A complete reroute that shares one read chunk with the first byte past the stdout backstop still names the model.
  const overflowed = await runHungCodex([reroute], "overflow");
  assert.ok(overflowed instanceof Error && !/clock bound/.test(overflowed.message), String(overflowed));
  assert.equal(spawnFailureDetail(overflowed, true).served_model, "gpt-5.2");
  const crashed = await runHungCodex([reroute], "crash");
  assert.ok(crashed instanceof Error && /crashed/.test(crashed.message), String(crashed));
  assert.equal(spawnFailureDetail(crashed, true).served_model, "gpt-5.2");

  // A codex call that returned a named model, and whose private profile cleanup then failed, still records that model.
  const cleanupFailed = await runCleanupFailedCodex([reroute]);
  assert.ok(cleanupFailed instanceof runtimeRegistry.InstanceRegistryRuntimeError, String(cleanupFailed));
  assert.match(String(cleanupFailed), /worker_profile_cleanup_unknown/);
  assert.equal(spawnFailureDetail(cleanupFailed, true).served_model, "gpt-5.2");
  const cleanupUnnamed = spawnFailureDetail(await runCleanupFailedCodex([]), true);
  assert.equal(cleanupUnnamed.served_model, null);
  assert.equal(cleanupUnnamed.served_model_reason, CODEX_SERVED_MODEL_REASON);

  // A Codex or GPT review whose reviewer named no model writes review.finding rows that name why, never a bare null.
  const findingRows: Record<string, unknown>[] = [];
  const capture = { state: "captured", verifiedCount: 0, invalidCount: 0, droppedCount: 0, findings: [{ id: "f1", lineageKey: "l1",
    criterion: 1, category: "correctness", severity: "high", mechanism: "m", remedy: "r",
    anchor: { path: "src/a.ts", line: 1, kind: "changed", status: "unsupported", evidenceDigest: "d" } }] } as never;
  const reviewProvenance = { provider: "codex", requestedModel: "gpt-6-luna", servedModel: null, effort: "high", sessionId: "s" };
  for (const servedModelReason of [CODEX_SERVED_MODEL_REASON, undefined]) {
    recordReviewFindings(capture, { taskId: "W1-T13868", prUrl: "https://github.com/o/r/pull/1", headSha: "a".repeat(40),
      decisionDigest: "d", provenance: { ...reviewProvenance, servedModelReason }, log: (step, row) => findingRows.push({ step, ...row }) });
  }
  assert.equal(findingRows[0]?.served_model, null);
  assert.equal(findingRows[0]?.served_model_reason, CODEX_SERVED_MODEL_REASON, "the reviewer's own reason is kept");
  assert.equal(typeof findingRows[1]?.served_model_reason, "string", "a null with no reviewer reason still names one");
  recordReviewFindings(capture, { taskId: "W1-T13868", prUrl: "https://github.com/o/r/pull/1", headSha: "a".repeat(40),
    decisionDigest: "d", provenance: { ...reviewProvenance, servedModel: "gpt-5.2" }, log: (step, row) => findingRows.push({ step, ...row }) });
  assert.equal(findingRows[2]?.served_model, "gpt-5.2");
  assert.equal("served_model_reason" in findingRows[2]!, false, "a named model carries no reason");

  // A body held past the request deadline lands only after the attempt ended and its row was built. The row keeps the
  // existing no-response reason, which the attribution reader keys on: no response had arrived when the attempt ended.
  const heldFixture = cashFixture();
  try {
    const held = await spawnOpenWeightWorker({ cwd: heldFixture.root, workerHome: join(heldFixture.root, "home"), prompt: "classify",
      env: { RMD_OPENWEIGHT_API_KEY: "test-only-key" }, requestTimeoutMs: 20,
      fetchImpl: heldBodyReply({ id: "chat-1", model: "gpt-5-nano-2025-08-07", choices: [{ message: { content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 5 } }, 80) }, heldFixture.config, { model: "gpt-5-nano", effort: "low" });
    assert.equal(held.isError, true, "the deadline fails the attempt");
    assert.equal(held.servedModel, null);
    assert.equal(held.servedModelReason, CASH_SERVED_MODEL_REASONS.noResponse);
    await new Promise((resolve) => setTimeout(resolve, 120));
  } finally { heldFixture.cleanup(); }

  // Through production spawnWorker: the watchdog replaces a cash rung that named its model with WorkerAbandonedError, and
  // the failed-attempt row still records that model (or the rung's named reason) through the error's cause.
  const abandoned = await runAbandonedCash({ servedModel: "gpt-5-nano-2025-08-07" });
  assert.ok(abandoned instanceof WorkerAbandonedError, String(abandoned));
  assert.equal(spawnFailureDetail(abandoned, true).served_model, "gpt-5-nano-2025-08-07");
  const abandonedUnnamed = spawnFailureDetail(await runAbandonedCash({ servedModel: null,
    servedModelReason: CASH_SERVED_MODEL_REASONS.unnamed }), true);
  assert.equal(abandonedUnnamed.served_model, null);
  assert.equal(abandonedUnnamed.served_model_reason, CASH_SERVED_MODEL_REASONS.unnamed);
  // A caller that cancels with a FROZEN error keeps that exact error, and the failed-attempt row still records the model.
  const frozen = Object.freeze(new Error("caller cancelled"));
  const cancelled = await runAbandonedCash({ servedModel: "gpt-5-nano-2025-08-07" }, frozen);
  assert.equal(cancelled, frozen, "the caller's own error is thrown unchanged");
  assert.equal(spawnFailureDetail(cancelled, true).served_model, "gpt-5-nano-2025-08-07");
  // Two calls cancelled through ONE caller signal throw the same frozen error. Each call's row still records its OWN
  // model: the observation is the call's, never the shared error's, so the second call cannot overwrite the first.
  const sharedSignal = await runSharedSignalCash(["gpt-5-nano-2025-08-07", "gpt-6.2-sol-2026-10-01"]);
  assert.equal(sharedSignal.errors[0], sharedSignal.errors[1], "both calls throw the caller's one error, unchanged");
  assert.ok(Object.isFrozen(sharedSignal.errors[0]), String(sharedSignal.errors[0]));
  assert.deepEqual(sharedSignal.rows.map((row) => row.served_model).sort(), ["gpt-5-nano-2025-08-07", "gpt-6.2-sol-2026-10-01"],
    "each call's failed-attempt row names the model its own rung reported");
  // The dispatch lane writes its own spawn-threw row (recordBenchmarkWorkerAttempt): each call keeps its own model there too.
  const dispatched = await runSharedSignalCash(["gpt-5-nano-2025-08-07", "gpt-6.2-sol-2026-10-01"], "dispatch");
  assert.equal(dispatched.errors[0], dispatched.errors[1], "both dispatch calls throw the caller's one error, unchanged");
  assert.deepEqual(dispatched.rows.map((row) => row.served_model).sort(), ["gpt-5-nano-2025-08-07", "gpt-6.2-sol-2026-10-01"],
    "each dispatch call's failed-attempt row names the model its own rung reported");

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

test("W1-T13868 criterion 1: a terminal verdict row carries the provider's reason beside a null served model", async () => {
  const codex = terminalVerdictFields(await runCodex());
  assert.equal(codex.served_model, null);
  assert.equal(codex.served_model_reason, CODEX_SERVED_MODEL_REASON, "a codex verdict row names why it has no model");
  const unnamed = terminalVerdictFields(await runCash(cashReply({})) as WorkerResult);
  assert.equal(unnamed.served_model, null);
  assert.equal(unnamed.served_model_reason, CASH_SERVED_MODEL_REASONS.unnamed, "a GPT verdict row names why it has no model");
  const named = terminalVerdictFields(await runCash(cashReply({ model: "gpt-5-nano-2025-08-07" })) as WorkerResult);
  assert.equal(named.served_model, "gpt-5-nano-2025-08-07");
  assert.equal("served_model_reason" in named, false, "positive control: a named model carries no reason");
});

test("W1-T13868 criterion 1: a throwing getter on a spawn error never replaces the rejection or drops the failed-attempt row", async () => {
  const hostile = new Error("spawn failed before any result");
  Object.defineProperty(hostile, "cause", { get() { throw new Error("cause getter exploded"); } });
  const named = { served_model: null, served_model_reason: THROWN_SERVED_MODEL_UNREADABLE };
  assert.deepEqual({ served_model: spawnFailureDetail(hostile, false).served_model,
    served_model_reason: spawnFailureDetail(hostile, false).served_model_reason }, named);
  // The dispatch lane: the original error rejects, and its spawn-threw row is still logged.
  const logged: Record<string, unknown>[] = [];
  await assert.rejects(recordBenchmarkWorkerAttempt(() => Promise.reject(hostile), (step, fields) => logged.push({ step, ...fields }),
    () => undefined, () => {}), (error) => error === hostile);
  assert.deepEqual(logged.filter((row) => row.worker_failure === "spawn-threw-before-result")
    .map((row) => [row.step, row.served_model, row.served_model_reason]), [["worker.attempt", null, THROWN_SERVED_MODEL_UNREADABLE]]);
  // The non-dispatch lane: the same, through its ledger.
  const root = mkdtempSync(join(tmpdir(), "rmd-served-model-hostile-cause-"));
  try {
    const spawn = benchmarkNonDispatchSpawn("served-model-hostile-cause", (() => Promise.reject(hostile)) as typeof spawnWorker);
    await assert.rejects(spawn({ cwd: root, config: { root } } as never), (error) => error === hostile);
    const rows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>).filter((row) => row.worker_failure === "spawn-threw-before-result");
    assert.deepEqual(rows.map((row) => [row.step, row.served_model, row.served_model_reason]),
      [["worker.attempt", null, THROWN_SERVED_MODEL_UNREADABLE]]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("W1-T13868 criterion 1: a receipt scope that opens after the model was observed still records it", async () => {
  // The fix lane (fixWorkerReceipt) writes through recordBenchmarkWorkerAttempt, whose per-call scope may open after
  // the observation was made, as here, where the error is observed before the call starts.
  const thrown = withObservedServedModel(new Error("codex call failed after naming its model"), { servedModel: "gpt-5.3-codex" });
  const rows: Record<string, unknown>[] = [];
  await assert.rejects(recordBenchmarkWorkerAttempt(() => Promise.reject(thrown), (step, fields) => rows.push({ step, ...fields }),
    () => undefined, () => {}), (error) => error === thrown);
  assert.deepEqual(rows.filter((row) => row.worker_failure === "spawn-threw-before-result")
    .map((row) => [row.step, row.served_model]), [["worker.attempt", "gpt-5.3-codex"]], "the dispatch lane's row");
  const root = mkdtempSync(join(tmpdir(), "rmd-served-model-unscoped-"));
  try {
    const spawn = benchmarkNonDispatchSpawn("served-model-unscoped", (() => Promise.reject(thrown)) as typeof spawnWorker);
    await assert.rejects(spawn({ cwd: root, config: { root } } as never), (error) => error === thrown);
    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>).filter((row) => row.worker_failure === "spawn-threw-before-result");
    assert.deepEqual(ledger.map((row) => row.served_model), ["gpt-5.3-codex"], "the non-dispatch lane's row");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("W1-T13868 criterion 1: past the kept bound, a codex call still records the model its final event named", async () => {
  const reroutes = Array.from({ length: 70 }, () => ({ type: "error", message: "model rerouted: gpt-6-luna -> gpt-5.2 (HighRiskCyberActivity)" }));
  const result = await runCodex(reroutes, 1, "gpt-5.3-codex");
  assert.equal(result.isError, false, result.stderr);
  assert.equal(result.servedModel, "gpt-5.3-codex", "the final event's model, not an earlier one kept before the bound");
  assert.equal(benchmarkWorkerAttemptResources(result).served_model, "gpt-5.3-codex", "the worker.attempt row");
  const bounded = await runCodex(reroutes);
  assert.equal(bounded.servedModel, "gpt-5.2", "positive control: without a final model the latest reroute is recorded");
});
