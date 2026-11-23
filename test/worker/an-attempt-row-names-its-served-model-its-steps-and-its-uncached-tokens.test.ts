// W1-T12151: an attempt row names the model that served it (and which source said so), the turns and a Codex attempt's
// model steps, and input tokens split into uncached and cached with one meaning for both providers. A count the
// provider did not report is a named gap, never 0.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { Config } from "#src/lib/config.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { benchmarkWorkerAttemptResources, orphanedAttemptFields, spawnFailureDetail, SPAWN_THREW_BEFORE_RESULT,
  unreportedAttemptCounts } from "#src/lib/benchmark-run.js";
import { CODEX_SERVED_MODEL_REASON, CODEX_SESSION_SERVED_MODEL_REASONS, codexSessionFileModel, codexSessionFilePath,
  spawnCodexWorker } from "#src/lib/worker-provider.js";

const THREAD = "019a7c2e-5b1d-7f10-9c3a-12151aaaaaaa";
const REQUESTED = "gpt-6-luna";

type Event = Record<string, unknown>;
const turn = (items: Event[], usage?: Event): Event[] => [{ type: "turn.started" },
  ...items.map((item) => ({ type: "item.completed", item })), { type: "turn.completed", ...(usage ? { usage } : {}) }];

/** A codex child that streams `events` on stdout and exits 0. */
function codexProcess(events: Event[]) {
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout, stderr: new PassThrough() });
  setImmediate(() => {
    for (const event of events) stdout.write(`${JSON.stringify(event)}\n`);
    stdout.end();
    setImmediate(() => child.emit("exit", 0));
  });
  return child;
}

/** A day directory codex names a thread's session file under, `sessions/YYYY/MM/DD`. Whatever zone named it, the
 *  newest day directories are the ones searched. */
function sessionDay(home: string, day = "2026/11/23"): string {
  const dir = join(home, "sessions", ...day.split("/"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Run a codex attempt over `events` after its thread starts; `session` writes the thread's session file first (a directory
 *  for "dir"); `silent` writes no report at all, not even the thread's start. */
async function runCodex(events: Event[], session?: Event[] | "dir", silent = false): Promise<WorkerResult> {
  const root = mkdtempSync(join(tmpdir(), "rmd-attempt-row-12151-"));
  const home = join(root, "codex-home");
  mkdirSync(home);
  try {
    if (session !== undefined) {
      const path = join(sessionDay(home), `rollout-2026-11-23T09-00-00-${THREAD}.jsonl`);
      if (session === "dir") mkdirSync(path);
      else writeFileSync(path, session.map((record) => JSON.stringify(record)).join("\n") + "\n");
    }
    return await spawnCodexWorker({
      workerHome: join(root, "home"), cwd: process.cwd(), prompt: "review",
      settingsFile: join(process.cwd(), "settings", "worker.json"), tools: ["Read", "Grep", "Glob", "Bash"],
      containment: { spawn: () => ({ process: codexProcess(silent ? [] : [{ type: "thread.started", thread_id: THREAD }, ...events]) as never,
        pid: 31_351 }), teardown: () => {} },
    }, {
      claudeBin: "/unused/claude", root,
      workerProviders: { enabled: ["codex"], codexBin: "/bin/sh", codexModel: REQUESTED, codexHome: home },
    } as Config, { model: REQUESTED, effort: "low" });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/** A Claude result envelope, reported the way the SDK reports one: cache reads and writes apart from input. */
function claudeResult(over: Partial<WorkerResult> = {}): WorkerResult {
  return { provider: "claude", sessionId: "s", model: "sonnet", servedModel: "claude-sonnet-4-6", effort: "low", costUsd: 0.1,
    numTurns: 7, text: "done", blocks: [], stderr: "", subtype: "success", isError: false, apiError: false, permissionDenials: [],
    childEnvKeys: [], tokens: { input: 10, output: 4, cacheRead: 50, cacheCreation: 5 }, modelUsage: {}, compactionEvents: [],
    qualitySuspect: false, ...over } as WorkerResult;
}

const message = { type: "agent_message", text: "done" };
const usage = { input_tokens: 100, cached_input_tokens: 60, output_tokens: 9 };

test("W1-T12151 criterion 1: a codex attempt records the served model a codex-written source names, and which source", async () => {
  const turnContext = { timestamp: "2026-11-23T09:00:01Z", type: "turn_context",
    payload: { cwd: "/w", approval_policy: "never", model: "gpt-5.3-codex", effort: "low" } };
  const fromSession = await runCodex(turn([message], usage), [
    { timestamp: "2026-11-23T09:00:00Z", type: "session_meta", payload: { id: THREAD } }, turnContext]);
  assert.equal(fromSession.isError, false, fromSession.stderr);
  assert.equal(fromSession.model, REQUESTED, "the request half is unchanged");
  const row = benchmarkWorkerAttemptResources(fromSession);
  assert.equal(row.served_model, "gpt-5.3-codex");
  assert.notEqual(row.served_model, REQUESTED, "the requested --model is never copied into served_model");
  assert.equal(row.served_model_source, "codex-session-file");
  assert.equal("served_model_reason" in row, false, "a named model carries no reason");

  // A reroute the session file recorded after the turn's context names what served that turn: the latest name wins.
  const rerouted = await runCodex(turn([message], usage), [turnContext,
    { type: "event_msg", payload: { type: "model_reroute", from_model: "gpt-5.3-codex", to_model: "gpt-5.2" } }]);
  assert.equal(benchmarkWorkerAttemptResources(rerouted).served_model, "gpt-5.2");

  // The exec --json stream's own reroute speaks first, and names its source.
  const streamed = benchmarkWorkerAttemptResources(await runCodex(turn([
    { type: "error", message: `model rerouted: ${REQUESTED} -> gpt-5.1 (HighRiskCyberActivity)` }, message], usage), [turnContext]));
  assert.equal(streamed.served_model, "gpt-5.1");
  assert.equal(streamed.served_model_source, "codex-exec-stream");

  // No source names one: the row keeps null and its reason, and names no source.
  for (const [session, reason] of [[undefined, CODEX_SERVED_MODEL_REASON],
    [[{ type: "session_meta", payload: { id: THREAD } }], CODEX_SESSION_SERVED_MODEL_REASONS.unnamed],
    ["dir", CODEX_SESSION_SERVED_MODEL_REASONS.unreadable]] as const) {
    const unnamed = benchmarkWorkerAttemptResources(await runCodex(turn([message], usage), session as Event[] | "dir" | undefined));
    assert.equal(unnamed.served_model, null, String(reason));
    assert.equal(unnamed.served_model_reason, reason);
    assert.equal("served_model_source" in unnamed, false);
  }

  // The file is found only by its own thread id; a torn line is skipped, never read as a model.
  assert.deepEqual(codexSessionFilePath("/nonexistent", "../escape"), { state: "absent" });
  assert.deepEqual(codexSessionFilePath("/nonexistent", THREAD), { state: "absent" });
  // Only the newest day directories are searched: a thread's file is created the day the thread starts.
  const days = mkdtempSync(join(tmpdir(), "rmd-attempt-row-12151-days-"));
  try {
    const oldest = sessionDay(days, "2025/12/31");
    for (const day of ["2026/01/01", "2026/01/02", "2026/02/01"]) sessionDay(days, day);
    writeFileSync(join(oldest, `rollout-2025-12-31T23-59-00-${THREAD}.jsonl`), JSON.stringify(turnContext));
    assert.deepEqual(codexSessionFilePath(days, THREAD), { state: "absent" }, "a fourth-newest day is not searched");
    const kept = join(sessionDay(days, "2026/01/01"), `rollout-2026-01-01T00-00-01-${THREAD}.jsonl`);
    writeFileSync(kept, JSON.stringify(turnContext));
    assert.deepEqual(codexSessionFilePath(days, THREAD), { state: "found", path: kept });
  } finally { rmSync(days, { recursive: true, force: true }); }
  // A day directory that exists but cannot be listed is unreadable, never read as no file.
  const blocked = mkdtempSync(join(tmpdir(), "rmd-attempt-row-12151-day-"));
  try {
    const day = sessionDay(blocked);
    rmSync(day, { recursive: true });
    writeFileSync(day, "not a directory");
    assert.deepEqual(codexSessionFilePath(blocked, THREAD), { state: "unreadable" });
  } finally { rmSync(blocked, { recursive: true, force: true }); }
  assert.equal(codexSessionFileModel(`{"type":"turn_context","payl\n${JSON.stringify(turnContext)}\n`), "gpt-5.3-codex");
  assert.equal(codexSessionFileModel(JSON.stringify({ type: "turn_context", payload: { model: "" } })), undefined);
});

test("W1-T12151 criterion 2: every attempt row records its turns, and a codex row its model steps inside them", async () => {
  // Two turns: each a reasoning item, a command, a file change and a message; an error item is not a model step.
  const steps = [{ type: "reasoning", text: "think" }, { type: "command_execution", command: "ls", aggregated_output: "" },
    { type: "file_change", changes: [{ path: "a.ts", kind: "update" }] }, message];
  const codex = benchmarkWorkerAttemptResources(await runCodex([...turn(steps, usage),
    ...turn([{ type: "error", message: "some unrelated warning" }, ...steps], usage)]));
  assert.equal(codex.turns, 2);
  assert.equal(codex.model_steps, 8);

  const claude = benchmarkWorkerAttemptResources(claudeResult());
  assert.equal(claude.turns, 7);
  assert.equal("model_steps" in claude, false, "a claude turn is already one model step");
});

test("W1-T12151 criterion 3: every attempt row records uncached and cached input tokens with one meaning for both providers", async () => {
  // Codex reports input with cached inside: uncached is input minus cached.
  const codexResult = await runCodex(turn([message], usage));
  const codex = benchmarkWorkerAttemptResources(codexResult);
  assert.equal(codex.uncached_input_tokens, 40);
  assert.equal(codex.cached_input_tokens, 60);
  assert.deepEqual(codex.tokens, { input: 100, output: 9, cacheRead: 60, cacheCreation: 0 }, "older readers' tokens are unchanged");

  // Claude reports them apart: uncached is its input plus what it wrote to the cache, cached is what it read from it.
  const claude = benchmarkWorkerAttemptResources(claudeResult());
  assert.equal(claude.uncached_input_tokens, 15);
  assert.equal(claude.cached_input_tokens, 50);
  assert.deepEqual(claude.tokens, { input: 10, output: 4, cacheRead: 50, cacheCreation: 5 });
});

test("W1-T12151 criterion 4: a count the provider did not report is a named gap, never 0", async () => {
  // A codex turn that reported no usage: the token counts are null beside why, never 0.
  const noUsage = benchmarkWorkerAttemptResources(await runCodex(turn([message])));
  assert.equal(noUsage.turns, 1);
  for (const field of ["uncached_input_tokens", "cached_input_tokens"] as const) {
    assert.equal(noUsage[field], null, field);
    assert.equal(noUsage[`${field}_unreported_reason`], "worker-token-usage-unavailable");
  }
  // A turn that started and never completed reported part of its usage.
  const partial = benchmarkWorkerAttemptResources(await runCodex([...turn([message], usage), { type: "turn.started" }]));
  assert.equal(partial.cached_input_tokens, null);
  assert.equal(partial.cached_input_tokens_unreported_reason, "worker-token-usage-partial");

  // A codex child that wrote no report at all reported no turn and no step.
  const silent = benchmarkWorkerAttemptResources(await runCodex([], undefined, true));
  for (const field of ["turns", "model_steps"] as const) {
    assert.equal(silent[field], null, field);
    assert.equal(silent[`${field}_unreported_reason`], "codex-stdout-report-absent");
  }
  // A result built before model steps were counted names that, rather than 0.
  const { modelSteps: _counted, ...uncounted } = await runCodex(turn([message], usage)) as WorkerResult & { modelSteps?: number };
  const legacy = benchmarkWorkerAttemptResources(uncounted as WorkerResult);
  assert.equal(legacy.model_steps, null);
  assert.equal(legacy.model_steps_unreported_reason, "codex-model-steps-not-counted");

  // A claude call with no result envelope reported no turns and no tokens.
  const noEnvelope = benchmarkWorkerAttemptResources(claudeResult({ subtype: "", numTurns: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } }));
  for (const field of ["turns", "uncached_input_tokens", "cached_input_tokens"] as const) {
    assert.equal(noEnvelope[field], null, field);
    assert.equal(noEnvelope[`${field}_unreported_reason`], "worker-result-envelope-not-reported");
  }
  // A cash call's input count follows its deployment's API, so it is not split under the one meaning.
  const cash = benchmarkWorkerAttemptResources(claudeResult({ provider: "cash" }));
  assert.equal(cash.turns, 7);
  assert.equal(cash.uncached_input_tokens, null);
  assert.equal(cash.uncached_input_tokens_unreported_reason, "cash-input-token-split-differs-by-deployment-api");

  // Rows with no worker result to read from: a spawn that threw, and an orphaned assignment.
  const threw = spawnFailureDetail(new Error("spawn failed"), true);
  const orphan = orphanedAttemptFields("assignment-1", "sweep");
  for (const [row, reason] of [[threw, SPAWN_THREW_BEFORE_RESULT], [orphan, orphan.served_model_unavailable_reason]] as const) {
    for (const field of ["turns", "uncached_input_tokens", "cached_input_tokens"]) {
      assert.equal(row[field], null, field);
      assert.equal(row[`${field}_unreported_reason`], reason);
    }
  }
  assert.deepEqual(unreportedAttemptCounts("why"), { turns: null, turns_unreported_reason: "why", uncached_input_tokens: null,
    uncached_input_tokens_unreported_reason: "why", cached_input_tokens: null, cached_input_tokens_unreported_reason: "why" });
});
