import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectWorkerResult, spawnWorker, workerLedgerFields, createClaudeExecutableCache,
  CLAUDE_BIN_ENV_OVERRIDE } from "#src/lib/worker.js";
import { INIT_INSPECTION_LIMIT, INIT_TOOL_NAME_LIMIT } from "#src/lib/worker-init-summary.js";

const init = (extra: Record<string, unknown> = {}) => ({ type: "system", subtype: "init",
  mcp_servers: [], tools: ["Read"], plugins: [{ name: "engineering", path: "/private/plugin" }],
  skills: ["engineering:code-review", "pdf"], agents: ["general-purpose"], plugin_errors: [], ...extra });

async function collect(events: unknown[]) {
  return collectWorkerResult((async function* () {
    yield* events;
    yield { type: "result", subtype: "success", is_error: false, result: "ok", usage: {} };
  })(), { childEnvKeys: [] });
}

test("W1-T9642: an init message naming a plugin and skills is recorded on the worker row", async () => {
  const row = workerLedgerFields(await collect([init({ plugins: [
    { name: "engineering", path: "/private/plugin" }, { name: "engineering", path: "/private/duplicate" },
  ], skills: ["engineering:code-review", "pdf", "pdf"], plugin_errors: [
    { plugin: "failed", path: "/private/failed", type: "generic-error", message: "private diagnostic" },
  ] })]));
  assert.deepEqual(row.plugin_inventory, { state: "observed", plugins: ["engineering"],
    skills: ["engineering:code-review", "pdf"], agents: ["general-purpose"], plugin_error_count: 1 });
  assert.deepEqual(row.sdk_init_summary.pluginNames.names, ["engineering"]);
  assert.equal(row.sdk_init_summary.skillNames.inputEntries, 3);
  assert.equal(row.sdk_init_summary.pluginErrorCount, 1);
  assert.equal(JSON.stringify(row).includes("/private/"), false);
  assert.equal(JSON.stringify(row).includes("private diagnostic"), false);
});

test("W1-T9642: an init message with no plugins field records the inventory as unknown, never empty", async () => {
  const row = workerLedgerFields(await collect([init({ plugins: undefined, plugin_errors: undefined })]));
  assert.equal(row.plugin_inventory.state, "unknown");
  assert.equal(row.plugin_inventory.plugins, null);
  assert.deepEqual(row.plugin_inventory.skills, ["engineering:code-review", "pdf"]);
  assert.equal(row.plugin_inventory.plugin_error_count, null);
  assert.equal(row.sdk_init_summary.pluginNames.state, "unavailable");
  const missing = await collect([]);
  for (const result of [missing, { ...missing, initSummary: undefined },
    { ...missing, provider: "codex" as const, initSummary: undefined }]) {
    assert.deepEqual(workerLedgerFields(result).plugin_inventory, { state: "unknown", plugins: null,
      skills: null, agents: null, plugin_error_count: null });
  }
  const empty = workerLedgerFields(await collect([init({ plugins: [], skills: [], agents: [], plugin_errors: [] })]));
  assert.deepEqual(empty.plugin_inventory, { state: "observed", plugins: [], skills: [], agents: [], plugin_error_count: 0 });
});

test("W1-T9642: a loaded plugin never fails the run", async t => {
  const root = mkdtempSync(join(tmpdir(), "rmd-plugin-inventory-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const settingsFile = join(root, "settings.json");
  writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false } }));
  for (const extra of [{}, { plugins: undefined, skills: undefined, agents: undefined },
    { skills: [42], plugin_errors: [{ message: "unloaded component" }] }]) {
    const result = await spawnWorker({ cwd: root, settingsFile, prompt: "inventory fixture", tools: ["Read"],
      mcpIsolation: "repo-knowledge-only", mountProvider: "claude", permissionMode: "bypassPermissions",
      egress: { mode: "off" }, config: { root, claudeBin: "/unused" },
      claudeExecutable: { cache: createClaudeExecutableCache(), deps: {
        env: { [CLAUDE_BIN_ENV_OVERRIDE]: "/fake/claude" }, home: root,
        exists: () => true, canExecute: () => true, locations: [] } },
      keychain: { platform: "linux", readCredentialFile: () => JSON.stringify({
        claudeAiOauth: { accessToken: "fixture", expiresAt: Number.MAX_SAFE_INTEGER } }) },
      queryFn: (() => (async function* () {
        yield init(extra);
        yield { type: "result", subtype: "success", is_error: false, result: "ok", usage: {} };
      })()) as never,
    });
    const row = workerLedgerFields(result);
    assert.equal(result.isError, false);
    assert.equal(result.subtype, "success");
    assert.equal(row.verdict, "success");
    assert.equal(row.mcp_isolation?.inventory, "observed-only");
    assert.equal(row.mcp_exposure, undefined);
    assert.ok(row.plugin_inventory);
  }
});

test("W1-T9642: plugin inventory bounds names and inspection and discards malformed or sensitive values", async () => {
  const row = workerLedgerFields(await collect([init({ plugins: [null, "invalid", {},
    { name: "engineering", path: "/private/plugin" }, { name: "sk-secret" }, { name: "../private" }],
    skills: ["engineering:code-review", "ghp_secret", "engineering:sk-secret", "https://private", 42],
    agents: "not-an-array", plugin_errors: "not-an-array" })]));
  assert.equal(row.plugin_inventory.state, "unknown");
  assert.deepEqual(row.plugin_inventory.plugins, ["engineering"]);
  assert.deepEqual(row.plugin_inventory.skills, ["engineering:code-review"]);
  assert.equal(row.plugin_inventory.agents, null);
  assert.equal(row.plugin_inventory.plugin_error_count, null);
  assert.equal(row.sdk_init_summary.pluginNames.rejectedEntries, 5);
  assert.equal(row.sdk_init_summary.skillNames.rejectedEntries, 4);
  assert.equal(JSON.stringify(row).includes("secret"), false);
  for (const field of ["plugins", "skills", "agents"]) {
    const names = Array.from({ length: INIT_INSPECTION_LIMIT + 5 }, (_, i) => `name-${i}`);
    const bounded = workerLedgerFields(await collect([init({ [field]: field === "plugins"
      ? names.map(name => ({ name, path: "/private/plugin" })) : names })]));
    const evidence = field === "plugins" ? bounded.sdk_init_summary.pluginNames
      : field === "skills" ? bounded.sdk_init_summary.skillNames : bounded.sdk_init_summary.agentNames;
    assert.equal(bounded.plugin_inventory.state, "unknown");
    assert.equal(evidence.names.length, INIT_TOOL_NAME_LIMIT);
    assert.equal(evidence.inspectedEntries, INIT_INSPECTION_LIMIT);
    assert.equal(evidence.truncated, true);
  }
});

test("W1-T9642: optional agents remain unknown and only the first init supplies plugin evidence", async () => {
  const absentAgents = workerLedgerFields(await collect([init({ agents: undefined })]));
  assert.equal(absentAgents.plugin_inventory.state, "unknown");
  assert.equal(absentAgents.plugin_inventory.agents, null);
  assert.equal(absentAgents.sdk_init_summary.agentNames.inputEntries, null);
  const first = workerLedgerFields(await collect([init(), init({ plugins: [] }),
    { ...init({ plugins: [] }), subtype: "status" }]));
  assert.deepEqual(first.plugin_inventory.plugins, ["engineering"]);
});
