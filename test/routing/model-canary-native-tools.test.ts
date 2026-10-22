import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { nativeCanaryTools } from "#src/lib/model-canary-native-tools.js";
import { executeCanary, type CanaryPin, type CanaryRequest, type CanaryResponse } from "#src/lib/model-canary-runner.js";
import { commonCanarySuite, canaryTools, type CanaryToolEvent } from "#src/lib/model-canary-suite.js";

const pin: CanaryPin = { model: "synthetic-protocol-fixture", route: "fixture", effort: "medium", suiteHash: "fixture", billing: "subscription" };
const request = (over: Partial<CanaryRequest> = {}): CanaryRequest => ({ prompt: "synthetic fixture", pin, history: [],
  signal: new AbortController().signal, maxOutputBytes: 16384, ...over });
const response = (text: string, terminal: "complete" | "error" = "complete"): CanaryResponse => ({ text, toolCalls: [],
  resources: { durationMs: null, firstTextMs: null, generationMs: null, inputTokens: null, outputTokens: null,
    cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, usageRatedUsd: null, billing: "subscription", servedModel: null, terminal } });
async function connect(input: CanaryRequest) {
  const adapter = nativeCanaryTools(input); assert.ok(adapter.server);
  const client = new Client({ name: "synthetic-native-tool-fixture", version: "1.0.0" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await adapter.server.instance.connect(right); await client.connect(left);
  return { adapter, client, close: async () => { await client.close(); await adapter.server!.instance.close(); } };
}

test("the real SDK MCP server exposes one strict synthetic tool and never strips unauthorized fields into success", async (t) => {
  const item = commonCanarySuite().find(c => c.id === "tools-A")!; const calls: CanaryToolEvent[] = [], invoke = canaryTools(item);
  const c = await connect(request({ toolPolicy: "inventory", invokeTool: (name, args) => { const e = invoke(name, args); calls.push(e); return e; } })); t.after(c.close);
  const listed = await c.client.listTools(); assert.equal(listed.tools.length, 1); assert.equal(listed.tools[0]!.name, "inventory");
  assert.equal(listed.tools[0]!.inputSchema.additionalProperties, false);
  assert.equal(listed.tools[0]!._meta?.["anthropic/alwaysLoad"], true);
  const actual = await c.client.callTool({ name: "inventory", arguments: { item: "A" } });
  assert.deepEqual(actual.content, [{ type: "text", text: '{"quantity":4}' }]); assert.equal(actual.isError, false);
  const invalid = await c.client.callTool({ name: "inventory", arguments: { item: "A", paidTool: true } });
  assert.equal(invalid.isError, true); assert.equal(calls.length, 1, "the real native schema rejects before executing, rather than stripping");
});

test("real native MCP retry and approval tools return actual failed results and keep separate case state", async (t) => {
  for (const id of ["recovery-retry", "recovery-approval"]) {
    const item = commonCanarySuite().find(c => c.id === id)!;
    const c = await connect(request({ toolPolicy: item.tools, invokeTool: canaryTools(item) })); t.after(c.close);
    const first = await c.client.callTool({ name: "lookup", arguments: {} }); assert.equal(first.isError, true);
    const second = await c.client.callTool({ name: "lookup", arguments: {} });
    assert.equal(second.isError, id === "recovery-approval");
    if (id === "recovery-retry") assert.deepEqual(second.content, [{ type: "text", text: '{"value":23}' }]);
  }
});

test("native tools refuse missing or unknown harness authority and disable builtins discovery and interactive permissions", async () => {
  assert.throws(() => nativeCanaryTools(request({ toolPolicy: "inventory" })), /capability-missing/);
  assert.throws(() => nativeCanaryTools(request({ toolPolicy: "paid" as "none" })), /policy-invalid/);
  const none = nativeCanaryTools(request()); assert.equal(none.server, undefined);
  assert.deepEqual(none.options.tools, []); assert.deepEqual(none.options.allowedTools, []); assert.deepEqual(none.options.mcpServers, {});
  assert.deepEqual(none.options.settingSources, []); assert.deepEqual(none.options.skills, []); assert.deepEqual(none.options.plugins, []);
  assert.equal(none.options.strictMcpConfig, true); assert.equal(none.options.permissionMode, "dontAsk");
  assert.equal(none.check({ tool_name: "Bash", tool_input: {} }).hookSpecificOutput?.permissionDecision, "deny");
  const denied = await none.options.canUseTool!("Bash", {}, { signal: new AbortController().signal, toolUseID: "fixture" });
  assert.equal(denied.behavior, "deny");
});

test("native pre-tool authority checks record denials without double executing an allowed tool", () => {
  const item = commonCanarySuite().find(c => c.id === "tools-A")!; const calls: CanaryToolEvent[] = [], invoke = canaryTools(item);
  const adapter = nativeCanaryTools(request({ toolPolicy: "inventory", invokeTool: (name, args) => { const e = invoke(name, args); calls.push(e); return e; } }));
  assert.equal(adapter.check({ tool_name: "mcp__canary__inventory", tool_input: { item: "A" } }).continue, true);
  assert.equal(calls.length, 0);
  for (const input of [{ tool_name: "Bash", tool_input: {} }, { tool_name: "mcp__canary__inventory", tool_input: { item: "A", extra: true } }])
    assert.equal(adapter.check(input).hookSpecificOutput?.permissionDecision, "deny");
  assert.equal(calls.length, 2); assert.ok(calls.every(e => e.denied));
});

test("the real native server preserves harness failures as unavailable without leaking raw exceptions", async (t) => {
  const c = await connect(request({ toolPolicy: "retry", invokeTool: () => { throw new Error("private-fixture-secret"); } })); t.after(c.close);
  const result = await c.client.callTool({ name: "lookup", arguments: {} });
  assert.equal(result.isError, true); assert.doesNotMatch(JSON.stringify(result), /private-fixture-secret/);
  assert.equal(c.adapter.unavailable(), "synthetic-tool-harness-unavailable");
  assert.equal(c.adapter.check({ tool_name: "Bash", tool_input: {} }).hookSpecificOutput?.permissionDecision, "deny");
});

test("the real canary runner grades actual native MCP tool results using its own single trace", async () => {
  const item = commonCanarySuite().find(c => c.id === "tools-A")!;
  const result = await executeCanary(item, pin, { admit: async () => ({ state: "admitted" }), monotonicMs: () => performance.now(),
    save: async () => {}, request: async input => {
      assert.equal(input.toolPolicy, "inventory");
      const c = await connect(input);
      try { const actual = await c.client.callTool({ name: "inventory", arguments: { item: "A" } });
        return response((actual.content as { text: string }[])[0]!.text); }
      finally { await c.close(); }
    } });
  assert.equal(result.run.verified, true); assert.equal(result.trace.length, 1);
  assert.deepEqual(result.trace[0]!.result, { quantity: 4 });
  assert.equal(result.run.attempts[0]!.servedModel, null); assert.equal(result.run.attempts[0]!.inputTokens, null);
});

test("a native policy violation is a known failure even when the native response cannot complete", async () => {
  const item = commonCanarySuite().find(c => c.id === "schema-deploy")!;
  const result = await executeCanary(item, pin, { admit: async () => ({ state: "admitted" }), monotonicMs: () => performance.now(),
    save: async () => {}, request: async input => { nativeCanaryTools(input).check({ tool_name: "Bash", tool_input: {} }); return response("", "error"); } });
  assert.equal(result.run.verified, false); assert.equal(result.reason, "tool-or-authority-violation");
  assert.equal(result.trace.length, 1); assert.equal(result.trace[0]!.denied, true);
});

test("a native tool burst retains one bound violation and cannot grow a successful trace", async () => {
  const item = commonCanarySuite().find(c => c.id === "tools-A")!;
  const result = await executeCanary(item, pin, { admit: async () => ({ state: "admitted" }), monotonicMs: () => performance.now(),
    save: async () => {}, request: async input => { for (let i = 0; i < 1000; i++) input.invokeTool!("inventory", { item: "A" }); return response('{"quantity":4}'); } });
  assert.equal(result.run.verified, false); assert.equal(result.trace.length, 3); assert.equal(result.trace[2]!.denied, true);
});


test("a completed native request revokes its capability before the slot result can be saved", async () => {
  const item = commonCanarySuite().find(c => c.id === "tools-A")!;
  let captured: CanaryRequest | undefined;
  const result = await executeCanary(item, pin, { admit: async () => ({ state: "admitted" }), monotonicMs: () => performance.now(),
    save: async () => {}, request: async input => { captured = input; const e = input.invokeTool!("inventory", { item: "A" }); return response(JSON.stringify(e.result)); } });
  assert.equal(result.run.verified, true); assert.equal(result.trace.length, 1);
  const late = captured!.invokeTool!("inventory", { item: "B" });
  assert.equal(late.denied, true); assert.deepEqual(late.result, { error: "tool-capability-closed" });
  assert.equal(result.trace.length, 1, "late SDK activity cannot mutate a saved case trace");
});

test("native tool non-error throws are unavailable and never become a successful model result", async (t) => {
  const c = await connect(request({ toolPolicy: "retry", invokeTool: () => { throw "private-non-error-fixture"; } })); t.after(c.close);
  const result = await c.client.callTool({ name: "lookup", arguments: {} });
  assert.equal(result.isError, true); assert.doesNotMatch(JSON.stringify(result), /private-non-error-fixture/);
  assert.equal(c.adapter.unavailable(), "synthetic-tool-harness-non-error");
  c.adapter.check({ tool_name: "Bash", tool_input: {} }); assert.equal(c.adapter.unavailable(), "synthetic-tool-harness-non-error");
});

test("an aborted native request cannot execute a late tool or alter its retained unavailable result", async () => {
  const item = commonCanarySuite().find(c => c.id === "tools-A")!;
  let captured: CanaryRequest | undefined;
  const result = await executeCanary(item, pin, { admit: async () => ({ state: "admitted" }), monotonicMs: () => 0,
    save: async () => {}, request: input => { captured = input; return new Promise<CanaryResponse>(() => {}); } },
  { maxCalls: 1, wallMs: 50, maxOutputBytes: 16384 });
  assert.equal(result.state, "unavailable"); assert.equal(result.run.attempts[0]!.terminal, "timeout");
  assert.equal(captured!.signal.aborted, true);
  assert.equal(captured!.invokeTool!("inventory", { item: "A" }).denied, true);
  assert.equal(result.trace.length, 0);
});
