import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Options, HookInput } from "@anthropic-ai/claude-agent-sdk";
import { applyWorkerMcpIsolation, validateWorkerMcpIsolation, workerMcpIsolationEvidence } from "../src/lib/worker-mcp-isolation.js";
import { workerInitSummaryFromMessage } from "../src/lib/worker-init-summary.js";
import { CLAUDE_BIN_ENV_OVERRIDE, createClaudeExecutableCache, spawnWorker, workerLedgerFields } from "../src/lib/worker.js";

const rule = "mcp__knowledge__rule";
const init = (servers: unknown = [], tools: unknown = []) => workerInitSummaryFromMessage({
  type: "system", subtype: "init", mcp_servers: servers, tools,
});
const approved = { mcpIsolation: "repo-knowledge-only" as const, mountProvider: "claude", tools: ["Read", "Bash"] };

test("repo/knowledge isolation is opt-in and refuses unqualified routing, reuse and tool bounds", () => {
  validateWorkerMcpIsolation({});
  validateWorkerMcpIsolation(approved);
  validateWorkerMcpIsolation({ ...approved, tools: [] });
  for (const extra of [{ mountProvider: undefined }, { mountProvider: "codex" }, { mountProvider: "cash" },
    { resumeSessionId: "old" }, { resumeSessionId: "" }, { tools: undefined },
    { tools: ["Agent"] }, { tools: ["Task"] }, { tools: ["WebFetch"] },
    { tools: ["mcp__knowledge__delete"] }, { mcpIsolation: "other" }]) {
    assert.throws(() => validateWorkerMcpIsolation({ ...approved, ...extra } as typeof approved), /fresh explicitly Claude/);
  }
});

test("repo/knowledge SDK policy preserves floor and egress while denying unexpected tools without an allow override", async () => {
  const prior = { hooks: [] };
  const sandbox = { enabled: true, network: { httpProxyPort: 1234 } };
  const options: Options = { tools: ["Read", "Bash", rule], mcpServers: { knowledge: { type: "sdk", name: "knowledge", instance: {} as never } },
    settings: { sandbox, permissions: { deny: ["Bash(rm *)"] } }, env: { SAFE: "kept", ENABLE_CLAUDEAI_MCP_SERVERS: "true" },
    hooks: { PreToolUse: [prior] }, disallowedTools: ["Write"] };
  const originalEnv = options.env;
  applyWorkerMcpIsolation(options);
  assert.equal(options.strictMcpConfig, true);
  assert.deepEqual(options.settings, { sandbox, permissions: { deny: ["Bash(rm *)"] }, disableClaudeAiConnectors: true });
  assert.deepEqual(options.disallowedTools, ["Write"]);
  assert.deepEqual(options.env, { SAFE: "kept", ENABLE_CLAUDEAI_MCP_SERVERS: "false" });
  assert.equal(options.env, originalEnv, "collector and SDK share one authoritative child environment");
  assert.equal(options.hooks?.PreToolUse?.[0], prior);
  const callback = options.hooks!.PreToolUse!.at(-1)!.hooks[0]!;
  for (const name of ["Read", "Bash", rule]) {
    assert.deepEqual(await callback({ hook_event_name: "PreToolUse", tool_name: name } as HookInput, undefined, { signal: new AbortController().signal }), {});
  }
  for (const name of ["mcp__claude_ai_Claude_Docs__delete", "mcp__knowledge__delete", "Agent", "Task", "WebFetch", "Write", "mcp__future__tool"]) {
    const verdict = await callback({ hook_event_name: "PreToolUse", tool_name: name } as HookInput, undefined, { signal: new AbortController().signal });
    assert.equal((verdict as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision, "deny");
  }
  const unexpected = await callback({ hook_event_name: "SessionStart" } as HookInput, undefined, { signal: new AbortController().signal });
  assert.equal((unexpected as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision, "deny");
});

test("repo/knowledge SDK composition reads real settings and refuses invalid settings and capability aliases", t => {
  const root = mkdtempSync(join(tmpdir(), "rmd-mcp-settings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "settings.json");
  writeFileSync(path, JSON.stringify({ sandbox: { enabled: true } }));
  const options: Options = { tools: [], settings: path };
  applyWorkerMcpIsolation(options);
  assert.deepEqual(options.settings, { sandbox: { enabled: true }, disableClaudeAiConnectors: true });
  for (const settings of ["null", "[]", "42", "not JSON"]) {
    writeFileSync(path, settings);
    assert.throws(() => applyWorkerMcpIsolation({ tools: [], settings: path }));
  }
  assert.throws(() => applyWorkerMcpIsolation({ tools: [], settings: join(root, "missing") }), /ENOENT/);
  for (const extra of [{ tools: undefined }, { tools: { type: "preset", preset: "claude_code" } },
    { tools: ["Agent"] }, { tools: [rule] }, { agents: {} }, { toolAliases: { Bash: "mcp__other__run" } },
    { resume: "old" }, { continue: true }, { mcpServers: { unexpected: {} } }, { mcpServers: { knowledge: {} } }]) {
    assert.throws(() => applyWorkerMcpIsolation({ tools: [], ...extra } as Options), /unqualified SDK/);
  }
  const noSettings: Options = { tools: [] };
  applyWorkerMcpIsolation(noSettings);
  assert.deepEqual(noSettings.settings, { disableClaudeAiConnectors: true });
});

test("repo/knowledge inventory never promotes missing, partial or leaked names to isolation proof", () => {
  assert.equal(workerMcpIsolationEvidence(undefined, false).inventory, "unknown");
  assert.equal(workerMcpIsolationEvidence(init(undefined, undefined), false).inventory, "observed-only");
  assert.equal(workerMcpIsolationEvidence(init([], [42]), false).inventory, "unknown");
  assert.equal(workerMcpIsolationEvidence(init([{ name: "knowledge" }], [rule, "Read"]), true).inventory, "observed-only");
  assert.equal(workerMcpIsolationEvidence(init([], []), false).inventory, "observed-only");
  assert.equal(workerMcpIsolationEvidence(init([], []), true).reason, "expected-knowledge-missing");
  assert.equal(workerMcpIsolationEvidence(init([{ name: "knowledge" }], []), false).inventory, "violated");
  assert.equal(workerMcpIsolationEvidence(init([], [rule]), false).inventory, "violated");
  assert.equal(workerMcpIsolationEvidence(init([{ name: "unexpected" }], []), false).reason, "unexpected-capability");
  assert.equal(workerMcpIsolationEvidence(init([], ["mcp__claude_ai_Claude_Docs__delete"]), false).inventory, "violated");
  const malformed = workerInitSummaryFromMessage({ type: "system", subtype: "init" });
  assert.equal(workerMcpIsolationEvidence(malformed, false).inventory, "unknown");
});

async function capture(t: { after(fn: () => void): void }, optIn: boolean, events: unknown[], knowledge = false) {
  const root = mkdtempSync(join(tmpdir(), "rmd-mcp-spawn-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const settingsFile = join(root, "worker.json");
  writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false } }));
  let options: Options | undefined;
  const result = await spawnWorker({ cwd: root, settingsFile, permissionMode: "bypassPermissions", prompt: "fixture",
    ...(optIn ? { mcpIsolation: "repo-knowledge-only" as const, mountProvider: "claude" as const } : {}),
    tools: ["Read", "Bash"], ...(knowledge ? { ruleLookup: { onPulled: () => {} } } : {}),
    egress: { mode: "off" }, config: { root, claudeBin: "/unused" },
    claudeExecutable: { cache: createClaudeExecutableCache(), deps: { env: { [CLAUDE_BIN_ENV_OVERRIDE]: "/fake/claude" },
      home: root, exists: () => true, canExecute: () => true, locations: [] } },
    keychain: { platform: "linux", readCredentialFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "stub", expiresAt: 4102444800000 } }) },
    queryFn: ((params: { options: Options }) => {
      options = params.options;
      return (async function* () {
        for (const event of events) yield event;
        yield { type: "result", subtype: "success", is_error: false, result: "fixture done", session_id: "fixture", total_cost_usd: 0, num_turns: 1 };
      })();
    }) as never,
  });
  assert.ok(options);
  return { options, result };
}

test("repo/knowledge isolation reaches the real SDK spawn boundary and retains the approved knowledge tool", async t => {
  const { options, result } = await capture(t, true, [{ type: "system", subtype: "init", mcp_servers: [{ name: "knowledge" }], tools: ["Read", "Bash", rule] }], true);
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
  assert.ok(result.childEnvKeys.includes("ENABLE_CLAUDEAI_MCP_SERVERS"), "effective child-env key reaches collector provenance");
  assert.deepEqual(options.tools, ["Read", "Bash", rule]);
  assert.ok(options.mcpServers?.knowledge);
  assert.equal(result.isError, false);
  assert.equal(workerLedgerFields(result).mcp_isolation?.inventory, "observed-only");
  assert.equal(result.text, "fixture done");
});

test("default workers are unchanged and opted-in unknown or leaked inventory cannot earn success credit", async t => {
  const baseline = await capture(t, false, []);
  assert.equal("strictMcpConfig" in baseline.options, false);
  assert.equal("hooks" in baseline.options, false);
  assert.equal(typeof baseline.options.settings, "string");
  assert.equal("mcp_isolation" in workerLedgerFields(baseline.result), false);
  assert.equal(baseline.result.isError, false);
  for (const events of [[], [{ type: "system", subtype: "init", mcp_servers: [], tools: ["mcp__external__delete"] }]]) {
    const { result } = await capture(t, true, events);
    assert.equal(result.isError, true);
    assert.notEqual(result.mcpIsolation?.inventory, "observed-only");
  }
  const empty = await capture(t, true, [{ type: "system", subtype: "init", mcp_servers: [], tools: ["Read", "Bash"] }]);
  assert.equal(empty.result.isError, false);
});
