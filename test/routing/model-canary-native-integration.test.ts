import { REPO_ROOT as __workspaceRoot } from "#test/helpers/repo-root.js";
import { pathToFileURL as __workspaceUrl } from "node:url";
const __workspaceRootUrl = __workspaceUrl(__workspaceRoot + "/");
/** Standalone acceptance seam: an absent implementation fails a real assertion at base. */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

test("native resource integration reads one real SDK user turn without resumed session cost", async t => {
  assert.ok(existsSync(new URL("src/lib/model-canary-native-adapter.ts", __workspaceRootUrl)), "canonical native resource integration source is required");
  // Loading follows the assertion so a base without this implementation produces an actual
  // failing test, rather than a test module load failure masquerading as environment evidence.
  const { nativeCanaryAdapter } = await import("#src/lib/model-canary-native-adapter.js");
  const cwd = mkdtempSync(join(tmpdir(), "rmd-native-integration-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const executable = join(cwd, "native.mjs");
  writeFileSync(executable, `#!${process.execPath}\n` + readFileSync(new URL("test/fixtures/canary-native-cli.mjs", __workspaceRootUrl), "utf8"));
  chmodSync(executable, 0o700);
  const env: NodeJS.ProcessEnv = { HOME: cwd, CLAUDE_CONFIG_DIR: join(cwd, "config"), PATH: dirname(process.execPath) + ":" + process.env.PATH,
    RMD_CANARY_FIXTURE_MODE: "usage-cache", RMD_CANARY_FIXTURE_LOG: join(cwd, "protocol.ndjson"), RMD_CANARY_FIXTURE_STATE: join(cwd, "session.json"),
    RMD_CANARY_RESOURCE_CONTRACTS: new URL("test/fixtures/canary-native-resource-contracts.json", __workspaceRootUrl).pathname };
  for (const name of Object.keys(process.env)) if (/^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_SESSION_ACCESS_TOKEN$|CLAUDE_CODE_EXTRA_BODY$|NODE_V8_COVERAGE$)/.test(name)) env[name] = undefined;
  const adapter = nativeCanaryAdapter({ cwd, executable, env, maxUserTurns: 8 });
  const response = await adapter.request({ prompt: "synthetic user turn", history: [], signal: AbortSignal.timeout(5000), maxOutputBytes: 4096,
    pin: { model: "synthetic-model", route: "fixture-subscription", effort: "medium", billing: "subscription", suiteHash: "fixture" } });
  assert.equal(response.resources.terminal, "complete"); assert.equal(response.resources.servedModel, "synthetic-model");
  assert.equal(response.resources.inputTokens, 2); assert.equal(response.resources.outputTokens, 3);
  assert.equal(response.resources.cacheReadTokens, 3); assert.equal(response.resources.cacheWriteTokens, 1);
  assert.equal(response.resources.usageRatedUsd, null); assert.equal(response.observation.sessionCostConsumed, false);
  assert.equal(response.native.promptSent, true); assert.equal(response.native.adapterQualified, false);
});

function resourceAdapter(t: { after(fn: () => void): void }, mode: string) {
  const cwd = mkdtempSync(join(tmpdir(), "rmd-native-resource-integration-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const executable = join(cwd, "native.mjs");
  writeFileSync(executable, `#!${process.execPath}\n` + readFileSync(new URL("test/fixtures/canary-native-cli.mjs", __workspaceRootUrl), "utf8"));
  chmodSync(executable, 0o700);
  const env: NodeJS.ProcessEnv = { HOME: cwd, CLAUDE_CONFIG_DIR: join(cwd, "config"),
    PATH: dirname(process.execPath) + ":" + process.env.PATH, RMD_CANARY_FIXTURE_MODE: mode,
    RMD_CANARY_FIXTURE_LOG: join(cwd, "protocol.ndjson"), RMD_CANARY_FIXTURE_STATE: join(cwd, "session.json"),
    RMD_CANARY_RESOURCE_CONTRACTS: new URL("test/fixtures/canary-native-resource-contracts.json", __workspaceRootUrl).pathname };
  for (const name of Object.keys(process.env)) if (/^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_SESSION_ACCESS_TOKEN$|CLAUDE_CODE_EXTRA_BODY$|NODE_V8_COVERAGE$)/.test(name)) env[name] = undefined;
  return { cwd, config: { cwd, executable, env, maxUserTurns: 8 as const } };
}
const resourceRequest = (prompt: string, conversation?: { role: "system" | "user" | "assistant"; content: string }[]) => ({
  prompt, conversation, history: [], signal: AbortSignal.timeout(5000), maxOutputBytes: 4096,
  pin: { model: "synthetic-model", route: "fixture-subscription", effort: "medium", billing: "subscription" as const, suiteHash: "fixture" },
});

test("default SDK adapter preserves all resource contracts and seals uncertain resource turns", async t => {
  assert.ok(existsSync(new URL("src/lib/model-canary-native-adapter.ts", __workspaceRootUrl)), "the SDK adapter is required before resource qualification");
  const { nativeCanaryAdapter } = await import("#src/lib/model-canary-native-adapter.js");
  const pack = JSON.parse(readFileSync(new URL("test/fixtures/canary-native-resource-contracts.json", __workspaceRootUrl), "utf8"));
  assert.equal(pack.scenarios.length, 8);
  for (const scenario of pack.scenarios) {
    const f = resourceAdapter(t, scenario.mode), adapter = nativeCanaryAdapter(f.config);
    const response = await adapter.request(resourceRequest("synthetic resource contract"));
    for (const [key, value] of Object.entries(scenario.expected)) {
      const actual = key === "failure" || key === "invalidCounters"
        ? response.observation[key as "failure" | "invalidCounters"]
        : response.resources[key as keyof typeof response.resources];
      assert.deepEqual(actual, value, scenario.mode + ": " + key);
    }
    assert.equal(response.resources.usageRatedUsd, null);
    assert.equal(response.observation.sessionCostConsumed, false);
    assert.equal(response.native.adapterQualified, false);
    assert.doesNotMatch(JSON.stringify(response), /"(?:modelUsage|total_cost_usd|costUSD|cumulative)":/);
    if (response.resources.terminal !== "complete") {
      const before = readFileSync(join(f.cwd, "protocol.ndjson"), "utf8");
      const refused = await adapter.request(resourceRequest("attempted uncertain resume"));
      assert.equal(refused.native.reason, "native-session-unavailable", scenario.mode);
      assert.equal(refused.native.promptSent, false);
      assert.equal(readFileSync(join(f.cwd, "protocol.ndjson"), "utf8"), before, "no additional SDK child or prompt");
    }
  }
});

test("default resumed SDK adapter keeps each turn usage separate from cumulative session cost", async t => {
  assert.ok(existsSync(new URL("src/lib/model-canary-native-adapter.ts", __workspaceRootUrl)), "the SDK adapter is required before resource qualification");
  const { nativeCanaryAdapter } = await import("#src/lib/model-canary-native-adapter.js");
  const f = resourceAdapter(t, "usage-cache"), adapter = nativeCanaryAdapter(f.config);
  const conversation: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: "synthetic retained instruction" },
  ];
  const turns = [];
  for (const prompt of ["first resource turn", "second resource turn"]) {
    conversation.push({ role: "user", content: prompt });
    const response = await adapter.request(resourceRequest(prompt, conversation));
    assert.equal(response.resources.terminal, "complete");
    conversation.push({ role: "assistant", content: response.text }); turns.push(response);
  }
  assert.deepEqual(turns.map(turn => turn.resources.inputTokens), [2, 2]);
  assert.deepEqual(turns.map(turn => turn.resources.outputTokens), [3, 3]);
  assert.deepEqual(turns.map(turn => turn.resources.cacheReadTokens), [3, 3]);
  assert.deepEqual(turns.map(turn => turn.resources.cacheWriteTokens), [1, 1]);
  assert.ok(turns.every(turn => turn.resources.usageRatedUsd === null && !turn.observation.sessionCostConsumed));
  const protocol = readFileSync(join(f.cwd, "protocol.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const prompts = protocol.filter(row => row.phase === "prompt");
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1].resumed, prompts[0].sessionId);
});
