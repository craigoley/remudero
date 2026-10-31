import assert from "node:assert/strict";
import { test } from "node:test";
import { collectWorkerResult, workerLedgerFields } from "#src/lib/worker.js";

async function collect(events: unknown[]) {
  return collectWorkerResult((async function* () {
    for (const event of events) yield event;
    yield { type: "result", subtype: "success", result: "ok", usage: {} };
  })(), { childEnvKeys: [] });
}

test("SDK init evidence reaches the real stream collector and ledger as names only", async () => {
  const result = await collect([{ type: "system", subtype: "init", cwd: "/private/operator",
    apiKeySource: "secret-auth-field", env: { TOKEN: "secret-token" }, prompt: "private-prompt",
    mcp_servers: [{ name: "github", status: "connected", config: { url: "private-url" } }],
    tools: ["Read", "Bash", "mcp__github__issues", "mcp__github__issues"] }]);
  const summary = workerLedgerFields(result).sdk_init_summary;
  assert.equal(summary.state, "observed");
  assert.equal(summary.source, "claude-sdk-system-init");
  assert.deepEqual(summary.serverNames.names, ["github"]);
  assert.deepEqual(summary.mcpToolNames.names, ["mcp__github__issues"]);
  assert.equal(summary.mcpToolNames.inputEntries, 4);
  for (const secret of ["secret-auth-field", "secret-token", "private-prompt", "/private/operator", "private-url"])
    assert.equal(JSON.stringify(summary).includes(secret), false);
});

test("missing SDK init is unavailable while a supplied empty inventory is measured empty", async () => {
  const absent = workerLedgerFields(await collect([])).sdk_init_summary;
  assert.equal(absent.state, "unavailable");
  assert.equal(absent.serverNames.inputEntries, null);
  const empty = workerLedgerFields(await collect([{ type: "system", subtype: "init", mcp_servers: [], tools: [] }])).sdk_init_summary;
  assert.equal(empty.state, "observed");
  assert.equal(empty.serverNames.inputEntries, 0);
  assert.deepEqual(empty.mcpToolNames.names, []);
});

test("malformed init fields remain partial and never become a no-connections claim", async () => {
  const row = workerLedgerFields(await collect([{ type: "system", subtype: "init", mcp_servers: "not-an-array" }])).sdk_init_summary;
  assert.equal(row.state, "partial");
  assert.equal(row.serverNames.state, "unavailable");
  assert.equal(row.mcpToolNames.inputEntries, null);
});

test("SDK inventory rejects secret-like and path names without storing rejected values", async () => {
  const { workerInitSummaryFromMessage } = await import("#src/lib/worker-init-summary.js");
  const raw = { type: "system", subtype: "init", mcp_servers: [null, { name: "ok" },
    { name: "https://private.example" }, { name: "ghp_secret" }, { name: "sk-secret" },
    { name: "eyJprivate" }, { name: "X".repeat(32) }],
    tools: [42, "Read", "mcp__ok__tool", "mcp__github_pat_secret__tool", "mcp__ok__../../secret", "sk-secret"] };
  const summary = workerInitSummaryFromMessage(raw)!;
  assert.equal(summary.state, "partial");
  assert.deepEqual(summary.serverNames.names, ["ok"]);
  assert.deepEqual(summary.mcpToolNames.names, ["mcp__ok__tool"]);
  assert.equal(summary.serverNames.rejectedEntries, 6);
  assert.equal(summary.mcpToolNames.rejectedEntries, 4);
  assert.equal(JSON.stringify(summary).includes("secret"), false);
});

test("SDK init parsing bounds work and retained inventory independently, reporting partial coverage", async () => {
  const { INIT_INSPECTION_LIMIT, INIT_SERVER_NAME_LIMIT, INIT_TOOL_NAME_LIMIT,
    workerInitSummaryFromMessage } = await import("#src/lib/worker-init-summary.js");
  const bounded = workerInitSummaryFromMessage({ type: "system", subtype: "init",
    mcp_servers: Array.from({ length: INIT_INSPECTION_LIMIT + 20 }, (_, i) => ({ name: `server-${i}` })),
    tools: Array.from({ length: INIT_INSPECTION_LIMIT + 20 }, (_, i) => `mcp__server__tool-${i}`) })!;
  assert.equal(bounded.state, "partial");
  assert.equal(bounded.serverNames.names.length, INIT_SERVER_NAME_LIMIT);
  assert.equal(bounded.mcpToolNames.names.length, INIT_TOOL_NAME_LIMIT);
  assert.equal(bounded.serverNames.inspectedEntries, INIT_INSPECTION_LIMIT);
  assert.equal(bounded.mcpToolNames.truncated, true);
  assert.ok(JSON.stringify(bounded).length < 8192);
});

test("system status, assistant messages and a repeated init cannot replace the first inventory", async () => {
  const { workerInitSummaryFromMessage } = await import("#src/lib/worker-init-summary.js");
  for (const event of [null, 0, { type: "assistant", subtype: "init" }, { type: "system", subtype: "status" }])
    assert.equal(workerInitSummaryFromMessage(event), undefined);
  const result = await collect([{ type: "system", subtype: "init", mcp_servers: [{ name: "first" }], tools: [] },
    { type: "system", subtype: "status" }, { type: "system", subtype: "init", mcp_servers: [], tools: [] }]);
  assert.deepEqual(result.initSummary?.serverNames.names, ["first"]);
});

test("legacy and other-provider ledger projections distinguish unknown from unsupported without changing provider", async () => {
  const base = await collect([]);
  delete base.initSummary;
  assert.equal(workerLedgerFields(base).sdk_init_summary.state, "unavailable");
  const codex = workerLedgerFields({ ...base, provider: "codex", model: "sonnet", routedModel: "gpt-5.3-codex" });
  assert.equal(codex.sdk_init_summary.state, "not-applicable");
  assert.equal(codex.provider, "codex");
  assert.equal(codex.routed_model, "gpt-5.3-codex");
});
