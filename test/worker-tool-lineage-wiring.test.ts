import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { CLAUDE_BIN_ENV_OVERRIDE, collectWorkerResult, createClaudeExecutableCache, spawnWorker, type SpawnWorkerArgs } from "../src/lib/worker.js";
import { spawnCodexWorker, spawnOpenWeightWorker } from "../src/lib/worker-provider.js";
import { createWorkerToolLineage, observeWorkerToolLineage } from "../src/lib/worker-tool-lineage.js";

async function* stream() {
  yield { type: "assistant", message: { id: "turn", content: [
    { type: "tool_use", id: "a", name: "Bash", input: { command: "secret-command" } },
    { type: "tool_use", id: "b", name: "Read", input: { path: "/private/secret" } },
  ] } };
  yield { type: "user", message: { content: [
    { type: "tool_result", tool_use_id: "b", content: "secret-result", is_error: true },
    { type: "tool_result", tool_use_id: "a", content: "secret-result", is_error: false },
  ] } };
  yield { type: "result", subtype: "success", result: "done", session_id: "s", total_cost_usd: 0.1, num_turns: 1, is_error: false };
}

test("test/worker-tool-lineage-wiring.test.ts the consumed stream uses the default durable observer", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-tool-lineage-"));
  const result = await collectWorkerResult(stream(), { childEnvKeys: [], root, runId: "r", taskId: "task" });
  assert.equal(result.text, "done");
  const text = readFileSync(join(root, "state", "ledger.ndjson"), "utf8");
  const rows = text.trim().split("\n").map(line => JSON.parse(line));
  assert.ok(rows.every(r => r.step === "worker.tool_lineage"));
  assert.deepEqual(rows.map(r => r.tool_lineage.state), ["attempt", "attempt", "joined", "joined"]);
  assert.deepEqual(rows.slice(2).map(r => [r.tool_lineage.tool, r.tool_lineage.result]), [["Read", "error"], ["Bash", "success"]]);
  assert.ok(!text.includes("secret-command") && !text.includes("secret-result") && !text.includes("/private/secret"));
});

test("test/worker-tool-lineage-wiring.test.ts durable sink failure and interruption preserve execution outcomes", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-tool-lineage-failure-"));
  writeFileSync(join(root, "state"), "blocks the ledger directory");
  const result = await collectWorkerResult(stream(), { childEnvKeys: [], root, runId: "r" });
  assert.equal(result.text, "done");
  assert.equal(result.isError, false);
  const observer = createWorkerToolLineage({ provider: "claude", runId: "r", sink: () => { throw new TypeError("private credentials"); } });
  observeWorkerToolLineage(observer, { type: "assistant", message: { id: "t", content: [{ type: "tool_use", id: "a", name: "Read" }] } });
  assert.deepEqual(observer.delivery, { state: "failed", reason: "sink-threw", errorClass: "TypeError" });
  async function* interrupted() {
    yield { type: "assistant", message: { id: "t", content: [{ type: "tool_use", id: "a", name: "Read" }] } };
    throw new Error("transport ended");
  }
  const interruptedRoot = mkdtempSync(join(tmpdir(), "rmd-tool-lineage-interrupted-"));
  await assert.rejects(collectWorkerResult(interrupted(), { childEnvKeys: [], root: interruptedRoot, runId: "r" }), /transport ended/);
  const rows = readFileSync(join(interruptedRoot, "state", "ledger.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(rows.at(-1).tool_lineage.state, "unfinished");
  assert.equal(rows.at(-1).tool_lineage.reason, "interrupted");
});

test("test/worker-tool-lineage-wiring.test.ts spawnWorker forwards attribution to the default Claude observer", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-tool-lineage-spawn-"));
  const settingsFile = join(root, "settings.json");
  writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false } }));
  let consumed = 0;
  const result = await spawnWorker({
    cwd: root, prompt: "fixture", settingsFile, permissionMode: "bypassPermissions", runId: "assembly-run", taskId: "assembly-task",
    config: { root, claudeBin: "/unused" },
    queryFn: (() => { consumed++; return stream(); }) as unknown as SpawnWorkerArgs["queryFn"],
    claudeExecutable: { cache: createClaudeExecutableCache(), deps: {
      env: { [CLAUDE_BIN_ENV_OVERRIDE]: "/fake/claude" }, home: root,
      exists: () => true, canExecute: () => true, locations: [],
    } },
    keychain: { platform: "linux", readCredentialFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "stub", expiresAt: 4102444800000 } }) },
  });
  assert.equal(result.text, "done");
  assert.equal(consumed, 1);
  const rows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(rows.filter(r => r.tool_lineage?.state === "joined").length, 2);
  assert.ok(rows.every(r => r.tool_lineage.provider === "claude" && r.tool_lineage.runId !== null));
});

test("test/worker-tool-lineage-wiring.test.ts the real Codex JSONL consumer joins split chunks exactly once", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-tool-lineage-codex-"));
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  let spawns = 0;
  const pending = spawnCodexWorker({
    cwd: root, workerHome: join(root, "home"), prompt: "fixture", runId: "r",
    settingsFile: join(process.cwd(), "settings", "worker.json"), tools: ["Read"],
    containment: { spawn: () => {
      spawns++;
      queueMicrotask(() => {
        const events = [
          { type: "turn.started" },
          { type: "item.started", item: { type: "command_execution", id: "call", command: "secret-command" } },
          { type: "item.completed", item: { type: "command_execution", id: "call", status: "completed", exit_code: 0, aggregated_output: "secret-output" } },
          { type: "item.completed", item: { type: "agent_message", text: "done" } },
          { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 0 } },
        ].map(event => JSON.stringify(event)).join("\n");
        child.stdout.write(events.slice(0, 80));
        child.stdout.end(events.slice(80));
        queueMicrotask(() => child.emit("exit", 0));
      });
      return { process: child as never, pid: 37920 };
    }, teardown: () => {} },
  }, { root, claudeBin: "/unused", workerProviders: { enabled: ["codex"], codexBin: "/bin/sh", codexModel: "gpt-6-luna", codexHome: join(root, "codex-home") } });
  const result = await pending;
  assert.equal(result.isError, false);
  assert.equal(result.text, "done");
  assert.equal(spawns, 1);
  const text = readFileSync(join(root, "state", "ledger.ndjson"), "utf8");
  const rows = text.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(rows.map(r => r.tool_lineage.state), ["attempt", "joined"]);
  assert.equal(rows[1].tool_lineage.result, "success");
  assert.ok(!text.includes("secret-command") && !text.includes("secret-output"));
});

test("test/worker-tool-lineage-wiring.test.ts cash adapters retain actual IDs and execution survives a failed ledger sink", async () => {
  for (const model of ["gpt-6-luna", "gpt-6.1-sol", "claude-haiku-5-5"]) {
    for (const [failedTool, failedSink] of [[false, false], [false, true], [true, false], [true, true]] as const) {
      const root = mkdtempSync(join(tmpdir(), "rmd-tool-lineage-cash-"));
      if (failedSink) mkdirSync(join(root, "state", "ledger.ndjson"), { recursive: true });
      writeFileSync(join(root, "input.txt"), "private-file-body");
      const path = failedTool ? "absent.txt" : "input.txt";
      let requests = 0;
      const foundry = model === "claude-haiku-5-5";
      const responses = model === "gpt-6.1-sol";
      const result = await spawnOpenWeightWorker({
        cwd: root, workerHome: join(root, "home"), prompt: "fixture", runId: "r", tools: ["Read"], maxTurns: 3,
        env: { RMD_OPENWEIGHT_API_KEY: "test-only-key", RMD_FOUNDRY_CLAUDE_API_KEY: "test-only-key", RMD_FOUNDRY_CLAUDE_ENDPOINT: "https://example.test/anthropic" },
        fetchImpl: async () => {
          const first = requests++ === 0;
          const payload = foundry ? { id: "response", model, stop_reason: first ? "tool_use" : "end_turn",
            usage: { input_tokens: 10, output_tokens: 2 },
            content: first ? [{ type: "tool_use", id: "actual-call", name: "read_file", input: { path } }] : [{ type: "text", text: "done" }],
          } : responses ? { id: "response", model, status: "completed", usage: { input_tokens: 10, output_tokens: 2 },
            output: first ? [{ type: "function_call", id: "different-item-id", call_id: "actual-call", name: "read_file", arguments: JSON.stringify({ path }) }]
              : [{ type: "message", content: [{ type: "output_text", text: "done" }] }],
          } : { id: "response", model, usage: { prompt_tokens: 10, completion_tokens: 2 }, choices: [{ finish_reason: first ? "tool_calls" : "stop", message: {
            content: first ? null : "done", tool_calls: first ? [{ id: "actual-call", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path }) } }] : [],
          } }] };
          return new Response(JSON.stringify(payload), { status: 200 });
        },
      }, { root, claudeBin: "/unused", dailyCapUsd: 25, workerProviders: { enabled: ["cash"], openweightEndpoint: "https://example.test/" } }, { model, effort: "low" });
      assert.equal(result.isError, failedTool && (foundry || responses), result.stderr);
      assert.equal(requests, failedTool && (foundry || responses) ? 1 : 2);
      if (failedSink) continue;
      const text = readFileSync(join(root, "state", "ledger.ndjson"), "utf8");
      const rows = text.trim().split("\n").map(line => JSON.parse(line));
      assert.deepEqual(rows.map(r => r.tool_lineage.state), ["attempt", "joined"]);
      assert.equal(rows[1].tool_lineage.result, failedTool ? "error" : "success");
      assert.equal(rows[0].tool_lineage.callId, rows[1].tool_lineage.callId);
      assert.ok(!text.includes("private-file-body") && !text.includes("input.txt") && !text.includes("actual-call"));
    }
  }
});

test("test/worker-tool-lineage-wiring.test.ts rejected asynchronous sinks do not reject tool execution", async () => {
  const observer = createWorkerToolLineage({ provider: "cash-chat", runId: "r", sink: async () => { throw "private-rejection"; } });
  observeWorkerToolLineage(observer, { type: "tool_use", turnId: "t", id: "a", name: "read_file" });
  await Promise.resolve();
  assert.deepEqual(observer.delivery, { state: "failed", reason: "sink-threw", errorClass: "non-error" });
  observeWorkerToolLineage(observer, { type: "tool_result", turnId: "t", tool_use_id: "a", is_error: false });
  await Promise.resolve();
  assert.equal(observer.delivery.state, "failed");
  observer.finish("stream-ended");
});

test("test/worker-tool-lineage-wiring.test.ts delivery distinguishes asynchronous success from a prior sink failure", async () => {
  let failed = false;
  const observer = createWorkerToolLineage({ provider: "cash-chat", runId: "r", sink: async () => {
    if (failed) throw new Error("write unavailable");
  } });
  const deliveryState = () => observer.delivery.state;
  observeWorkerToolLineage(observer, { type: "tool_use", turnId: "t", id: "a", name: "read_file" });
  assert.equal(deliveryState(), "pending");
  await Promise.resolve();
  assert.equal(deliveryState(), "written");
  failed = true;
  observeWorkerToolLineage(observer, { type: "tool_use", turnId: "t", id: "b", name: "read_file" });
  await Promise.resolve();
  assert.equal(deliveryState(), "failed");
  failed = false;
  observeWorkerToolLineage(observer, { type: "tool_result", turnId: "t", tool_use_id: "a", is_error: false });
  await Promise.resolve();
  assert.equal(deliveryState(), "failed", "a later write cannot erase missing telemetry");
});
