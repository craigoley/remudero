import assert from "node:assert/strict";
import { test } from "node:test";
import { canaryTransportCapture } from "#src/lib/model-canary-transport.js";

test("canary Claude stream counts cumulative usage once and times only visible text", () => {
  const c = canaryTransportCapture("anthropic-messages", 100);
  c.event({ type: "message_start", message: { model: "claude", usage: { input_tokens: 10, output_tokens: 1,
    cache_read_input_tokens: 30, cache_creation_input_tokens: 0 } } }, 105);
  c.event({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "reasoning" } }, 110);
  c.event({ type: "content_block_delta", delta: { type: "text_delta", text: "" } }, 115);
  c.event({ type: "content_block_delta", delta: { type: "text_delta", text: "hello" } }, 120);
  c.event({ type: "message_delta", usage: { output_tokens: 3 } }, 125);
  c.event({ type: "message_delta", usage: { output_tokens: 7 } }, 130);
  c.event({ type: "content_block_delta", delta: { type: "text_delta", text: "world" } }, 140);
  c.event({ type: "message_stop" }, 150);
  const result = c.finish(160, "complete");
  assert.equal(result.outputTokens, 7); assert.equal(result.inputTokens, 10); assert.equal(result.firstTextMs, 20);
  assert.equal(result.generationMs, 20); assert.equal(result.reasoningTokens, null); assert.equal(result.terminal, "complete");
  assert.equal(result.usageCoverage.inputIncludesCached, false); assert.equal(result.usageRatedUsd, null);
});

test("canary OpenAI stream preserves total and nested usage categories without double charging", () => {
  const c = canaryTransportCapture("openai-chat", 0);
  c.event({ model: "model", usage: null, choices: [{ delta: { content: "text" }, finish_reason: null }] }, 2);
  c.event({ model: "model", choices: [{ delta: {}, finish_reason: "stop" }] }, 3);
  c.event({ model: "model", choices: [], usage: { prompt_tokens: 100, completion_tokens: 40,
    prompt_tokens_details: { cached_tokens: 80 }, completion_tokens_details: { reasoning_tokens: 30 } } }, 4);
  const r = c.finish(5, "complete");
  assert.equal(r.inputTokens, 100); assert.equal(r.outputTokens, 40); assert.equal(r.cacheReadTokens, 80);
  assert.equal(r.reasoningTokens, 30); assert.equal(r.cacheWriteTokens, null);
  assert.equal(r.usageCoverage.outputIncludesReasoning, true); assert.equal(r.servedModel, "model");
});

test("canary raw transport errors retain usage and refuse conflicting identity and regressing counters", () => {
  const c = canaryTransportCapture("openai-chat", 0);
  c.event({ model: "one", usage: { completion_tokens: 5 }, choices: [] }, 1);
  c.event({ model: "two", usage: { completion_tokens: 3 }, choices: [] }, 2);
  const r = c.finish(3, "timeout");
  assert.equal(r.terminal, "timeout"); assert.equal(r.servedModel, null); assert.equal(r.outputTokens, null);
  assert.deepEqual(r.usageCoverage.invalidCounters, ["outputTokens"]);
  const failure = canaryTransportCapture("anthropic-messages", 0);
  failure.event({ type: "message_start", message: { usage: { input_tokens: 9 } } }, 1);
  failure.event({ type: "error" }, 2); assert.equal(failure.finish(3, "complete").terminal, "error");
  assert.equal(failure.finish(3, "error").inputTokens, 9);
  const fallback = canaryTransportCapture("anthropic-messages", 0);
  fallback.event({ type: "message_start", message: { model: "old" } }, 1);
  fallback.event({ type: "content_block_start", content_block: { type: "fallback" } }, 2);
  assert.equal(fallback.finish(3, "complete").servedModel, null);
  const missing = canaryTransportCapture("openai-chat", 0);
  missing.event({ choices: [] }, 1); assert.equal(missing.finish(2, "complete").terminal, "error");
  missing.event(null, 2); for (let i = 0; i < 8192; i++) missing.event({ type: "ping" }, 2);
  assert.equal(missing.finish(3, "complete").terminal, "error");
});

test("canary Responses stream captures visible text and final inclusive usage exactly once", () => {
  const c = canaryTransportCapture("openai-responses", 100);
  c.event({ type: "response.created", response: { model: "sol-6.1", usage: null } }, 101);
  c.event({ type: "response.reasoning_summary_text.delta", delta: "internal summary" }, 105);
  c.event({ type: "response.output_text.delta", delta: "" }, 110);
  c.event({ type: "response.output_text.delta", delta: "hello" }, 120);
  c.event({ type: "response.output_text.delta", delta: "world" }, 140);
  c.event({ type: "response.output_text.done", text: "helloworld" }, 150);
  const complete = { type: "response.completed", response: { model: "sol-6.1", status: "completed", usage: {
    input_tokens: 100, output_tokens: 40, input_tokens_details: { cached_tokens: 80, cache_write_tokens: 5 },
    output_tokens_details: { reasoning_tokens: 30 } } } };
  c.event(complete, 155); c.event(complete, 156);
  const r = c.finish(160, "complete");
  assert.equal(r.firstTextMs, 20); assert.equal(r.generationMs, 20); assert.equal(r.terminal, "complete");
  assert.equal(r.inputTokens, 100); assert.equal(r.outputTokens, 40); assert.equal(r.cacheReadTokens, 80);
  assert.equal(r.cacheWriteTokens, 5); assert.equal(r.reasoningTokens, 30); assert.equal(r.servedModel, "sol-6.1");
  assert.equal(r.usageCoverage.inputIncludesCached, true); assert.equal(r.usageCoverage.outputIncludesReasoning, true);
  assert.equal(r.usageRatedUsd, null);
});

test("canary Responses failed incomplete malformed and missing completion preserve usage without claiming success", () => {
  for (const type of ["response.failed", "response.incomplete", "error"]) {
    const c = canaryTransportCapture("openai-responses", 0);
    c.event({ type, response: { model: "observed-model", usage: { input_tokens: 9, output_tokens: 3 } } }, 1);
    const r = c.finish(2, "complete");
    assert.equal(r.terminal, "error"); assert.equal(r.inputTokens, 9); assert.equal(r.outputTokens, 3);
    assert.equal(r.firstTextMs, null); assert.equal(r.usageRatedUsd, null);
  }
  for (const response of [undefined, { status: "incomplete" }, { status: "completed", error: { code: "server_error" } },
    { status: "completed", error: 0 }]) {
    const c = canaryTransportCapture("openai-responses", 0);
    c.event({ type: "response.completed", response }, 1); assert.equal(c.finish(2, "complete").terminal, "error");
  }
  const missing = canaryTransportCapture("openai-responses", 0);
  missing.event({ type: "response.output_text.delta", delta: "text" }, 1);
  assert.equal(missing.finish(2, "complete").terminal, "error");
  assert.equal(missing.finish(2, "timeout").terminal, "timeout");
});

test("canary Responses counter and identity conflicts stay unknown after a later complete snapshot", () => {
  const c = canaryTransportCapture("openai-responses", 0);
  c.event({ type: "response.in_progress", response: { model: "one", usage: { output_tokens: 5 } } }, 1);
  c.event({ type: "response.in_progress", response: { model: "two", usage: { output_tokens: 3 } } }, 2);
  c.event({ type: "response.completed", response: { model: "two", status: "completed", usage: { output_tokens: 9 } } }, 3);
  const r = c.finish(4, "complete");
  assert.equal(r.servedModel, null); assert.equal(r.outputTokens, null);
  assert.deepEqual(r.usageCoverage.invalidCounters, ["outputTokens"]);
  const fallback = canaryTransportCapture("openai-responses", 0);
  fallback.event({ type: "response.created", response: { model: "one" } }, 1);
  fallback.event({ type: "fallback" }, 2);
  assert.equal(fallback.finish(3, "complete").servedModel, null);
});

test("canary transport exposes supplied Claude thinking and OpenAI cache write counters as inclusive subsets", () => {
  const claude = canaryTransportCapture("anthropic-messages", 0);
  claude.event({ type: "message_start", message: { usage: { output_tokens: 1, output_tokens_details: { thinking_tokens: 1 } } } }, 1);
  claude.event({ type: "message_delta", usage: { output_tokens: 10, output_tokens_details: { thinking_tokens: 6 } } }, 2);
  claude.event({ type: "message_stop" }, 3);
  const c = claude.finish(4, "complete"); assert.equal(c.outputTokens, 10); assert.equal(c.reasoningTokens, 6);
  assert.equal(c.usageCoverage.outputIncludesReasoning, true);
  const chat = canaryTransportCapture("openai-chat", 0);
  chat.event({ choices: [{ finish_reason: "stop" }], usage: { prompt_tokens_details: { cache_write_tokens: 7 } } }, 1);
  assert.equal(chat.finish(2, "complete").cacheWriteTokens, 7);
  assert.throws(() => canaryTransportCapture("unknown" as never, 0), /protocol-unsupported/);
});
