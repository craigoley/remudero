import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CashRequestEffortCount, CashRequestTransport } from "../src/lib/cash-request-effort.js";
import { fixedClock } from "../src/lib/clock.js";
import type { Config } from "../src/lib/config.js";
import { spawnOpenWeightWorker } from "../src/lib/worker-provider.js";
import { workerLedgerFields, type WorkerResult } from "../src/lib/worker.js";

test("cash effort evidence reads each actual transport parameter without retaining request content", async () => {
  const { cashRequestEffort } = await import("../src/lib/cash-request-effort.js");
  for (const [transport, body, parameter] of [
    ["chat-completions", { reasoning_effort: "none" }, "reasoning_effort"],
    ["responses", { reasoning: { effort: "high" } }, "reasoning.effort"],
    ["foundry-messages", { output_config: { effort: "medium" } }, "output_config.effort"],
  ] as const) {
    const observed = cashRequestEffort(JSON.stringify({ ...body, prompt: "secret prompt", api_key: "secret key" }), transport);
    assert.equal(observed.parameter, parameter);
    assert.equal(observed.state, "parameter-present");
    assert.equal(observed.provenance, "adapter-fetch-call");
    assert.equal(observed.providerEffectiveEffort, null);
    assert.equal(JSON.stringify(observed).includes("secret"), false);
  }
});

test("an omitted cash effort parameter stays omitted without inferring a provider default", async () => {
  const { cashRequestEffort } = await import("../src/lib/cash-request-effort.js");
  for (const transport of ["chat-completions", "responses", "foundry-messages"] as const) {
    assert.equal(cashRequestEffort("{}", transport).state, "parameter-omitted");
    assert.equal(cashRequestEffort("{}", transport).value, null);
  }
  assert.equal(cashRequestEffort('{"reasoning":{}}', "responses").state, "parameter-omitted");
  assert.equal(cashRequestEffort('{"output_config":{}}', "foundry-messages").state, "parameter-omitted");
});

test("unreadable cash request parameters are distinct from omitted parameters", async () => {
  const { cashRequestEffort } = await import("../src/lib/cash-request-effort.js");
  for (const body of ["{bad", "null", "[]", "42", '"string"']) {
    assert.equal(cashRequestEffort(body, "chat-completions").state, "parameter-unreadable");
  }
  for (const transport of ["responses", "foundry-messages"] as CashRequestTransport[]) {
    const parent = transport === "responses" ? "reasoning" : "output_config";
    for (const value of [null, [], 2, "medium"])
      assert.equal(cashRequestEffort(JSON.stringify({ [parent]: value }), transport).state, "parameter-unreadable");
    for (const value of [null, 2, {}, "private arbitrary text"])
      assert.equal(cashRequestEffort(JSON.stringify({ [parent]: { effort: value } }), transport).state, "parameter-unreadable");
  }
  for (const value of [null, 2, {}, "private arbitrary text"])
    assert.equal(cashRequestEffort(JSON.stringify({ reasoning_effort: value }), "chat-completions").state, "parameter-unreadable");
});

test("cash request effort accepts only bounded known effort scalars", async () => {
  const { cashRequestEffort } = await import("../src/lib/cash-request-effort.js");
  for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"])
    assert.equal(cashRequestEffort(JSON.stringify({ reasoning_effort: effort }), "chat-completions").value, effort);
});


test("cash effort evidence bounds tuple storage while retaining every attempted request count", async () => {
  const { recordCashRequestEffort } = await import("../src/lib/cash-request-effort.js");
  const entries: CashRequestEffortCount[] = [];
  for (let i = 0; i < 10_000; i++) recordCashRequestEffort(entries, '{"reasoning_effort":"none"}', "chat-completions");
  recordCashRequestEffort(entries, "{}", "chat-completions");
  recordCashRequestEffort(entries, '{"reasoning":{"effort":"high"}}', "responses");
  assert.equal(entries.length, 3);
  assert.equal(entries[0]!.requests, 10_000);
  assert.equal(entries[1]!.state, "parameter-omitted");
  assert.equal(entries.reduce((n, row) => n + row.requests, 0), 10_002);
});

const NOW = Date.parse("2026-10-08T12:00:00Z");
const env = { RMD_OPENWEIGHT_API_KEY: "test-only-key", RMD_FOUNDRY_CLAUDE_API_KEY: "test-only-key",
  RMD_FOUNDRY_CLAUDE_ENDPOINT: "https://foundry.example.test/anthropic" };
function fixture(cap = 25) {
  const root = mkdtempSync(join(tmpdir(), "rmd-cash-request-effort-"));
  return { root, config: { root, dailyCapUsd: cap,
    workerProviders: { cashEndpoint: "https://openai.example.test/" } } as Config,
  close: () => rmSync(root, { recursive: true, force: true }) };
}
function reply(model: string) {
  if (model.startsWith("claude-")) return { id: "messages-1", model, stop_reason: "end_turn",
    content: [{ type: "text", text: "done" }], usage: { input_tokens: 20, output_tokens: 5 } };
  if (model === "gpt-6.1-sol") return { id: "responses-1", model, status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }],
    usage: { input_tokens: 20, output_tokens: 5 } };
  return { id: "chat-1", model, choices: [{ message: { content: "done" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 5 } };
}

test("actual Luna tool-less requests retain omitted effort alongside the requested effort", async () => {
  const f = fixture();
  try {
    for (const effort of ["low", "medium", "high"]) {
      let sent = 0;
      const result = await spawnOpenWeightWorker({ cwd: f.root, workerHome: f.root, prompt: "classify", env,
        clock: fixedClock(NOW), fetchImpl: async (_url, init) => {
          sent++; assert.equal(Object.hasOwn(JSON.parse(String(init?.body)), "reasoning_effort"), false);
          return new Response(JSON.stringify(reply("gpt-6-luna")), { status: 200 });
        } }, f.config, { model: "gpt-6-luna", effort });
      assert.equal(result.isError, false, result.stderr);
      assert.equal(result.effort, effort);
      assert.equal(sent, 1);
      assert.deepEqual(result.requestEfforts, [{ provenance: "adapter-fetch-call", transport: "chat-completions",
        parameter: "reasoning_effort", state: "parameter-omitted", value: null, providerEffectiveEffort: null, requests: 1 }]);
      assert.deepEqual(workerLedgerFields(result as WorkerResult).request_efforts, result.requestEfforts);
      const legacy: WorkerResult = { ...result };
      delete legacy.requestEfforts;
      assert.equal(Object.hasOwn(workerLedgerFields(legacy), "request_efforts"), false,
        "legacy absence is unknown, not a known zero-request attempt");
    }
  } finally { f.close(); }
});

test("actual cash adapters report their own serialized parameter without changing tool compatibility", async () => {
  const { cashRequestEffort } = await import("../src/lib/cash-request-effort.js");
  const f = fixture();
  try {
    for (const [model, effort, tools, parameter, value] of [
      ["gpt-6-luna", "high", ["Read"], "reasoning_effort", "none"],
      ["gpt-6.1-sol", "high", [], "reasoning.effort", "high"],
      ["claude-haiku-5-5", "low", [], "output_config.effort", "low"],
      ["claude-haiku-5-5", "default", [], "output_config.effort", "medium"],
    ] as const) {
      const result = await spawnOpenWeightWorker({ cwd: f.root, workerHome: f.root, prompt: "classify", env,
        tools: [...tools], clock: fixedClock(NOW), fetchImpl: async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          const observed = cashRequestEffort(String(init?.body), model.startsWith("claude-") ? "foundry-messages"
            : model === "gpt-6.1-sol" ? "responses" : "chat-completions");
          assert.equal(observed.value, value);
          if (model === "gpt-6-luna") assert.equal(body.reasoning_effort, "none");
          return new Response(JSON.stringify(reply(model)), { status: 200 });
        } }, f.config, { model, effort });
      assert.equal(result.isError, false, result.stderr);
      assert.equal(result.requestEfforts[0]!.parameter, parameter);
      assert.equal(result.requestEfforts[0]!.value, value);
      assert.equal(result.requestEfforts[0]!.requests, 1);
      assert.equal(result.requestEfforts[0]!.providerEffectiveEffort, null);
    }
  } finally { f.close(); }
});

test("failed cash fetches retain request effort while pre-transport budget refusals record zero requests", async () => {
  for (const model of ["gpt-6-luna", "claude-haiku-5-5"]) {
    for (const fail of ["budget", "throw", "http"] as const) {
      const f = fixture(fail === "budget" ? 0.0000001 : 25);
      try {
        let sent = 0;
        const result = await spawnOpenWeightWorker({ cwd: f.root, workerHome: f.root, prompt: "classify", env,
          clock: fixedClock(NOW), fetchImpl: async () => {
            sent++; if (fail === "throw") throw new Error("synthetic transport failure");
            return new Response("synthetic refusal", { status: 503 });
          } }, f.config, { model, effort: "high" });
        assert.equal(result.isError, true);
        assert.equal(sent, fail === "budget" ? 0 : 1);
        assert.equal(result.requestEfforts.length, sent);
        assert.equal(result.requestEfforts[0]?.requests ?? 0, sent);
        assert.equal(result.budgetRefused, fail === "budget");
        assert.deepEqual(workerLedgerFields(result as WorkerResult).request_efforts, result.requestEfforts);
      } finally { f.close(); }
    }
  }
});

test("real Luna tool turns count both fetches and preserve the existing explicit tool error", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "input.txt"), "verified input");
    for (const missing of [false, true]) {
      let sent = 0;
      const result = await spawnOpenWeightWorker({ cwd: f.root, workerHome: f.root, prompt: "read input.txt", env,
        tools: ["Read"], maxTurns: 2, clock: fixedClock(NOW), fetchImpl: async (_url, init) => {
          sent++;
          if (sent === 2) {
            const body = JSON.parse(String(init?.body));
            const tool = body.messages.find((message: { role: string }) => message.role === "tool");
            assert.ok(tool, "the second request carries the real tool outcome");
            assert.equal(Object.hasOwn(JSON.parse(tool.content), "error"), missing);
            if (!missing) assert.ok(tool.content.includes("verified input"));
          }
          return new Response(JSON.stringify(sent === 1 ? { ...reply("gpt-6-luna"), choices: [{
            message: { content: "", tool_calls: [{ id: "call-1", type: "function", function: {
              name: "read_file", arguments: JSON.stringify({ path: missing ? "missing.txt" : "input.txt" }) } }] },
            finish_reason: "tool_calls" }] } : reply("gpt-6-luna")), { status: 200 });
        } }, f.config, { model: "gpt-6-luna", effort: "high" });
      assert.equal(result.isError, false, result.stderr);
      assert.equal(sent, 2);
      assert.equal(result.requestEfforts.length, 1);
      assert.equal(result.requestEfforts[0]!.requests, sent);
      assert.equal(result.requestEfforts[0]!.value, "none");
    }
  } finally { f.close(); }
});

test("real Haiku and Sol failed Read attempts count only the fetch before the tool refusal", async () => {
  for (const model of ["claude-haiku-5-5", "gpt-6.1-sol"]) {
    const f = fixture();
    try {
      let sent = 0;
      const result = await spawnOpenWeightWorker({ cwd: f.root, workerHome: f.root, prompt: "read missing.txt", env,
        tools: ["Read"], maxTurns: 2, clock: fixedClock(NOW), fetchImpl: async () => {
          sent++;
          const response = model.startsWith("claude-") ? { ...reply(model), stop_reason: "tool_use",
            content: [{ type: "tool_use", id: "read-1", name: "read_file", input: { path: "missing.txt" } }] }
            : { ...reply(model), output: [{ type: "function_call", call_id: "read-1", name: "read_file",
              arguments: JSON.stringify({ path: "missing.txt" }) }] };
          return new Response(JSON.stringify(response), { status: 200 });
        } }, f.config, { model, effort: "high" });
      assert.equal(result.isError, true);
      assert.match(result.stderr, /tool read_file failed/);
      assert.equal(sent, 1);
      assert.equal(result.requestEfforts.length, 1);
      assert.equal(result.requestEfforts[0]!.requests, 1);
      assert.equal(result.requestEfforts[0]!.value, "high");
    } finally { f.close(); }
  }
});

test("real Haiku tool success counts each attempted messages request", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "input.txt"), "verified input");
    let sent = 0;
    const result = await spawnOpenWeightWorker({ cwd: f.root, workerHome: f.root, prompt: "read input.txt", env,
      tools: ["Read"], maxTurns: 2, clock: fixedClock(NOW), fetchImpl: async (_url, init) => {
        sent++;
        if (sent === 2) assert.ok(String(init?.body).includes("verified input"));
        return new Response(JSON.stringify(sent === 1 ? { ...reply("claude-haiku-5-5"), stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "read-1", name: "read_file", input: { path: "input.txt" } }] }
          : reply("claude-haiku-5-5")), { status: 200 });
      } }, f.config, { model: "claude-haiku-5-5", effort: "medium" });
    assert.equal(result.isError, false, result.stderr);
    assert.equal(sent, 2);
    assert.equal(result.requestEfforts.length, 1);
    assert.equal(result.requestEfforts[0]!.requests, 2);
    assert.equal(result.requestEfforts[0]!.value, "medium");
  } finally { f.close(); }
});
