import { REPO_ROOT as __workspaceRoot } from "#test/helpers/repo-root.js";
import { pathToFileURL as __workspaceUrl } from "node:url";
const __workspaceRootUrl = __workspaceUrl(__workspaceRoot + "/");
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

async function load() {
  assert.ok(existsSync(new URL("src/lib/model-canary-native-stream.ts", __workspaceRootUrl)), "native canary capture source is required");
  return import("#src/lib/model-canary-native-stream.js");
}
type Capture = ReturnType<Awaited<ReturnType<typeof load>>["canaryNativeStreamCapture"]>;
function raw(c: Capture, event: unknown, atMs = 110) { c.event({ type: "stream_event", parent_tool_use_id: null, event }, atMs); }
function message(c: Capture, id = "m1", input = 10, model = "observed-model") {
  raw(c, { type: "message_start", message: { id, model, usage: { input_tokens: input, output_tokens: 999,
    cache_read_input_tokens: 30, cache_creation_input_tokens: 0 } } });
}
function text(c: Capture, value = "answer") {
  raw(c, { type: "content_block_start", index: 0, content_block: { type: "text" } });
  raw(c, { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "discard this secret" } }, 115);
  raw(c, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: value } }, 120);
  raw(c, { type: "content_block_stop", index: 0 });
}
function close(c: Capture) { raw(c, { type: "message_stop" }, 130); }
function result(c: Capture, overrides: Record<string, unknown> = {}) {
  c.event({ type: "result", subtype: "success", is_error: false, permission_denials: [], num_turns: 1,
    result: "answer", usage: { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 30,
      cache_creation_input_tokens: 0, output_tokens_details: { thinking_tokens: 2 } },
    total_cost_usd: 125, modelUsage: { "old-session-model": { costUSD: 125, outputTokens: 10000 } }, ...overrides }, 140);
}
async function completed() {
  const { canaryNativeStreamCapture } = await load(), c = canaryNativeStreamCapture(100, "subscription");
  message(c); text(c); close(c); return c;
}

test("native canary uses terminal turn output once and ignores duplicate blocks and resumed-session spend", async () => {
  const c = await completed();
  c.event({ type: "assistant", parent_tool_use_id: null, message: { id: "m1", content: [{ type: "text", text: "answer" }],
    usage: { input_tokens: 10, output_tokens: 999 } } }, 135);
  c.event({ type: "assistant", parent_tool_use_id: null, message: { id: "m1", content: [{ type: "text", text: "answer" }] } }, 136);
  result(c); const out = c.finish(150, "complete");
  assert.equal(out.text, "answer"); assert.equal(out.resources.outputTokens, 7); assert.equal(out.resources.inputTokens, 10);
  assert.equal(out.resources.cacheReadTokens, 30); assert.equal(out.resources.cacheWriteTokens, 0);
  assert.equal(out.resources.reasoningTokens, 2); assert.equal(out.resources.usageRatedUsd, null);
  assert.equal(out.resources.firstTextMs, 20); assert.equal(out.resources.durationMs, 50);
  assert.equal(out.resources.terminal, "complete"); assert.equal(out.resources.servedModel, "observed-model");
  assert.equal(out.observation.usageScope, "main-loop-user-turn"); assert.equal(out.observation.sessionCostConsumed, false);
  assert.equal(out.observation.adapterQualified, false); assert.doesNotMatch(JSON.stringify(out), /discard this secret|old-session-model|10000/);
});

test("native canary message stop without a successful SDK result retains partial input and unknown output", async () => {
  const c = await completed(), out = c.finish(150, "complete");
  assert.equal(out.resources.terminal, "error"); assert.equal(out.resources.inputTokens, 10);
  assert.equal(out.resources.outputTokens, null); assert.equal(out.resources.usageRatedUsd, null);
  assert.equal(out.observation.resultObserved, false); assert.equal(out.text, "");
});

test("native canary error and timeout preserve observed terminal usage", async () => {
  for (const transport of ["complete", "error", "timeout"] as const) {
    const c = await completed(); result(c, { subtype: "error_during_execution", is_error: true });
    const out = c.finish(150, transport); assert.equal(out.resources.outputTokens, 7);
    assert.equal(out.resources.terminal, transport === "timeout" ? "timeout" : "error");
  }
});

test("native canary sums distinct message inputs and refuses a generation interval across tool gaps", async () => {
  const c = await completed(); message(c, "m2", 6); text(c); close(c);
  result(c, { num_turns: 2, usage: { input_tokens: 16, output_tokens: 27, cache_read_input_tokens: 60, cache_creation_input_tokens: 0 } });
  const out = c.finish(200, "complete"); assert.equal(out.resources.terminal, "complete");
  assert.equal(out.resources.inputTokens, 16); assert.equal(out.resources.outputTokens, 27);
  assert.equal(out.resources.cacheReadTokens, 60); assert.equal(out.resources.generationMs, null);
  assert.equal(out.observation.messages, 2); assert.equal(out.resources.firstTextMs, 20);
});

test("native canary contradictory and malformed counters stay unknown", async () => {
  const c = await completed(); result(c, { usage: { input_tokens: 11, output_tokens: -1,
    cache_read_input_tokens: "30", cache_creation_input_tokens: 0, output_tokens_details: { thinking_tokens: -1 } } });
  const out = c.finish(150, "complete");
  assert.equal(out.resources.inputTokens, null); assert.equal(out.resources.outputTokens, null);
  assert.equal(out.resources.cacheReadTokens, null); assert.equal(out.resources.reasoningTokens, null);
  assert.deepEqual(out.observation.invalidCounters, ["inputTokens", "cacheReadTokens", "outputTokens", "reasoningTokens"]);
});

test("native canary interrupted tool input cannot become completion at message stop", async () => {
  const { canaryNativeStreamCapture } = await load(), c = canaryNativeStreamCapture(100, "subscription");
  message(c); raw(c, { type: "content_block_start", index: 0, content_block: { type: "tool_use" } });
  raw(c, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"item":' } });
  close(c); result(c); const out = c.finish(150, "complete");
  assert.equal(out.resources.terminal, "error"); assert.equal(out.observation.failure, "incomplete-content-block");
  assert.equal(out.observation.toolBlocks, 1); assert.equal(out.resources.outputTokens, 7);
});

test("native canary unproven permission turn and final-text outcomes refuse", async () => {
  for (const overrides of [{ permission_denials: undefined }, { permission_denials: [{ tool_name: "Bash" }] },
    { num_turns: 0 }, { num_turns: 33 }, { result: undefined }, { is_error: undefined }, { subtype: "error_max_turns" }]) {
    const c = await completed(); result(c, overrides); assert.equal(c.finish(150, "complete").resources.terminal, "error");
  }
});

test("native canary missing duplicated and child message identities refuse", async () => {
  const { canaryNativeStreamCapture } = await load();
  for (const frame of [null, { type: "unknown" }, { type: "stream_event", parent_tool_use_id: "child", event: { type: "ping" } },
    { type: "assistant", parent_tool_use_id: null, message: { id: "missing" } },
    { type: "stream_event", parent_tool_use_id: null, event: {} },
    { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: {} } }]) {
    const c = canaryNativeStreamCapture(100, "subscription"); c.event(frame, 110); message(c); text(c); close(c); result(c);
    assert.equal(c.finish(150, "complete").resources.terminal, "error");
  }
  const c = await completed(); message(c); close(c); result(c); assert.equal(c.finish(150, "complete").resources.terminal, "error");
});

test("native canary context resets duplicate results and post-result frames retain refusals", async () => {
  for (const subtype of ["compact_boundary", "conversation_reset"]) {
    const c = await completed(); c.event({ type: "system", subtype }, 135); result(c);
    assert.equal(c.finish(150, "complete").resources.terminal, "error");
  }
  const c = await completed(); result(c); result(c); const out = c.finish(150, "complete");
  assert.equal(out.resources.terminal, "error"); assert.equal(out.resources.outputTokens, null); assert.equal(out.resources.inputTokens, null);
  const after = await completed(); result(after); after.event({ type: "system" }, 145);
  assert.equal(after.finish(150, "complete").resources.terminal, "error");
});

test("native canary mixed models and raw errors cannot prove a successful common identity", async () => {
  const mixed = await completed(); message(mixed, "m2", 10, "other-model"); text(mixed); close(mixed);
  result(mixed, { usage: { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 60, cache_creation_input_tokens: 0 } });
  const out = mixed.finish(150, "complete"); assert.equal(out.resources.terminal, "error"); assert.equal(out.resources.servedModel, null);
  const { canaryNativeStreamCapture } = await load(), c = canaryNativeStreamCapture(100, "api");
  message(c); raw(c, { type: "error", error: { message: "private error text" } }); close(c); result(c);
  assert.equal(c.finish(150, "complete").resources.servedModel, null);
});

test("native canary event message and UTF8 output bounds hold", async () => {
  const { canaryNativeStreamCapture } = await load();
  const frames = await completed(); for (let n = 0; n < 8193; n++) raw(frames, { type: "ping" });
  result(frames); assert.equal(frames.finish(150, "complete").resources.terminal, "error");
  const messages = canaryNativeStreamCapture(100, "subscription");
  for (let n = 0; n < 33; n++) { message(messages, `m${n}`); close(messages); }
  result(messages); const bounded = messages.finish(150, "complete"); assert.equal(bounded.observation.messages, 32);
  assert.equal(bounded.resources.terminal, "error");
  const bytes = canaryNativeStreamCapture(100, "subscription", 2); message(bytes); text(bytes, "☃"); close(bytes); result(bytes, { result: "☃" });
  assert.equal(bytes.finish(150, "complete").resources.terminal, "error");
  const final = await completed(); result(final, { result: "x".repeat(16385) }); assert.equal(final.finish(150, "complete").text, "");
});

test("native canary malformed block frames and raw counter overflow stay unavailable", async () => {
  const { canaryNativeStreamCapture } = await load();
  for (const event of [null, { type: "content_block_start", index: 256, content_block: { type: "text" } },
    { type: "content_block_stop", index: 0 }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }]) {
    const c = canaryNativeStreamCapture(100, "subscription"); message(c); raw(c, event); close(c); result(c);
    assert.equal(c.finish(150, "complete").resources.terminal, "error");
  }
  const c = canaryNativeStreamCapture(100, "subscription"); message(c, "m1", Number.MAX_SAFE_INTEGER); close(c);
  message(c, "m2", Number.MAX_SAFE_INTEGER); close(c); result(c, { usage: {} });
  assert.equal(c.finish(150, "complete").resources.inputTokens, null);
  const spoofed = canaryNativeStreamCapture(100, "subscription"); message(spoofed);
  raw(spoofed, { type: "content_block_start", index: 0, content_block: { type: "thinking" } });
  raw(spoofed, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "not a text block" } });
  raw(spoofed, { type: "content_block_stop", index: 0 }); close(spoofed); result(spoofed);
  assert.equal(spoofed.finish(150, "complete").resources.terminal, "error");
  const partial = canaryNativeStreamCapture(100, "subscription"); message(partial); result(partial);
  assert.equal(partial.finish(150, "complete").resources.terminal, "error");
});

test("native canary unknown optional usage is null and a finished capture cannot be reused", async () => {
  const c = await completed();
  c.event({ type: "system", subtype: "init" }, 132); c.event({ type: "user" }, 133); c.event({ type: "tool_progress" }, 134);
  result(c, { usage: {} }); const out = c.finish(150, "complete");
  assert.equal(out.resources.outputTokens, null); assert.equal(out.resources.reasoningTokens, null);
  assert.equal(out.resources.inputTokens, 10); assert.equal(out.resources.terminal, "complete");
  assert.throws(() => c.finish(160, "complete"), /already-finished/); assert.throws(() => c.event({}, 160), /already-finished/);
  const { canaryNativeStreamCapture } = await load();
  assert.throws(() => canaryNativeStreamCapture(0, "subscription", 65537), /bound-invalid/);
  assert.throws(() => canaryNativeStreamCapture(0, "unknown" as "api"), /bound-invalid/);
});

test("native canary snapshots bounded turn counters and refuses oversized identities", async () => {
  const c = await completed();
  const frame = { type: "result", subtype: "success", is_error: false, permission_denials: [], num_turns: 1,
    result: "answer", usage: { input_tokens: 10, output_tokens: 7 } };
  c.event(frame, 140); frame.usage.output_tokens = 10000;
  assert.equal(c.finish(150, "complete").resources.outputTokens, 7, "later SDK object mutation cannot rewrite an observation");
  const { canaryNativeStreamCapture } = await load();
  for (const [id, model] of [["x".repeat(513), "model"], [" ", "model"], ["m1", "x".repeat(257)], ["m1", " "]]) {
    const scoped = canaryNativeStreamCapture(100, "subscription"); message(scoped, id, 10, model); close(scoped); result(scoped);
    const out = scoped.finish(150, "complete"); assert.equal(out.resources.terminal, "error"); assert.equal(out.resources.servedModel, null);
  }
});
