import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { RunResult } from "../src/lib/run-result.js";
import { appendLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import { slugifyRuleId } from "../src/lib/doctrine-lifecycle.js";
import { lookupWorkerRule, parseRuleHeadlines } from "../src/lib/learnings.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { wipeTestCommand } from "../src/run-task.js";
import {
  CLAUDE_BIN_ENV_OVERRIDE,
  IMPLEMENT_CLAUDE_TOOLS,
  WORKER_RULE_TOOL_NAME,
  createClaudeExecutableCache,
  createWorkerRuleTool,
  spawnWorker,
} from "../src/lib/worker.js";

function fixture(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}worker-rule-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "doctrine"));
  mkdirSync(join(root, "learnings"));
  writeFileSync(join(root, "CLAUDE.md"),
    "# Rules\n\n- **Read the installed schema before trusting a prompt.** → doctrine/schema.md\n" +
    "- **Keep every fetch visible.** → doctrine/ledger.md\n");
  writeFileSync(join(root, "doctrine", "schema.md"),
    "- **Read the installed schema before trusting a prompt.**\nMeasured schema evidence.\n");
  writeFileSync(join(root, "doctrine", "ledger.md"),
    "- **Keep every fetch visible.**\nMeasured ledger evidence.\n");
  writeFileSync(join(root, "learnings", "fixture.yaml"),
    "- id: fixture-learning\n  files: [src/lib/worker.ts]\n  fact: Read the real schema.\n  evidence: The installed type differs.\n  src: fixture\n");
  return root;
}

function readText(result: Awaited<ReturnType<ReturnType<typeof createWorkerRuleTool>["handler"]>>): string {
  const first = result.content[0];
  assert.equal(first?.type, "text");
  return first.text;
}

test("W1-T4094: a worker can fetch a rule body by id or phrase", async (t) => {
  const root = fixture(t);
  const settingsFile = join(root, "worker.json");
  writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true } }));
  let options: Options | undefined;
  await spawnWorker({
    cwd: root,
    permissionMode: "bypassPermissions",
    settingsFile,
    prompt: "read a rule",
    tools: [...IMPLEMENT_CLAUDE_TOOLS],
    ruleLookup: { onPulled: () => {} },
    config: { claudeBin: "/unused", root },
    claudeExecutable: {
      cache: createClaudeExecutableCache(),
      deps: { env: { [CLAUDE_BIN_ENV_OVERRIDE]: "/fake/claude" }, home: root, exists: () => true, canExecute: () => true, locations: [] },
    },
    keychain: {
      platform: "linux",
      readCredentialFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "stub", expiresAt: 4102444800000 } }),
    },
    queryFn: ((params: { options: Options }) => {
      options = params.options;
      return (async function* () {
        yield { type: "result", subtype: "success", is_error: false, result: "done", session_id: "s-rule", total_cost_usd: 0, num_turns: 1 };
      })();
    }) as unknown as Parameters<typeof spawnWorker>[0]["queryFn"],
  });
  assert.ok(Array.isArray(options?.tools) && options.tools.includes(WORKER_RULE_TOOL_NAME),
    "the implement worker can call the named tool");
  assert.ok(options?.mcpServers?.knowledge, "the SDK receives its in-process knowledge server");

  const rule = createWorkerRuleTool(root, () => {});
  const byId = await rule.handler({ query: "read-the-installed-schema-before-trusting-a-prompt" }, {});
  const byPhrase = await rule.handler({ query: "installed schema" }, {});
  assert.equal(readText(byId), readText(byPhrase));
  assert.match(readText(byId), /Measured schema evidence/);
  const learning = await rule.handler({ query: "learnings#fixture-learning" }, {});
  assert.match(readText(learning), /Read the real schema\.\n\nThe installed type differs\./);

  const overall = join(root, "overall-learnings");
  mkdirSync(overall);
  writeFileSync(join(overall, "fixture.yaml"),
    "- id: overall-learning\n  files: [src/lib/worker.ts]\n  fact: Check the shared store.\n  evidence: Shared evidence is readable.\n  src: fixture\n");
  const layered = createWorkerRuleTool(root, () => {}, {
    homes: { projectDir: join(root, "learnings"), userOverallDir: overall },
    allowedIds: ["overall-learning"],
  });
  assert.match(readText(await layered.handler({ query: "learnings#overall-learning" }, {})), /Shared evidence is readable/);
  assert.equal((await layered.handler({ query: "learnings#fixture-learning" }, {})).isError, true,
    "an unselected learning is not exposed through the worker tool");
});

test("W1-T4094: every fetch is ledgered", async (t) => {
  const root = fixture(t);
  const ledgerPath = join(root, "ledger.ndjson");
  const rule = createWorkerRuleTool(root, (id, status) =>
    appendLedger(ledgerPath, { run_id: "RULE-1", task_id: "W1-T4094", step: "knowledge.pulled", id, status }));
  await rule.handler({ query: "installed schema" }, {});
  await rule.handler({ query: "learnings#fixture-learning" }, {});
  await rule.handler({ query: "absent-rule" }, {});
  writeFileSync(join(root, "doctrine", "ledger.md"), "- **Wrong headline.**\n");
  await rule.handler({ query: "keep-every-fetch-visible" }, {});
  assert.deepEqual(readLedgerLines(ledgerPath).map(({ step, id, status }) => ({ step, id, status })), [
    { step: "knowledge.pulled", id: "read-the-installed-schema-before-trusting-a-prompt", status: "found" },
    { step: "knowledge.pulled", id: "learnings#fixture-learning", status: "found" },
    { step: "knowledge.pulled", id: "absent-rule", status: "missing" },
    { step: "knowledge.pulled", id: "keep-every-fetch-visible", status: "error" },
  ]);
});

test("W1-T4094: the tool is read-only", async (t) => {
  const root = fixture(t);
  const before = ["CLAUDE.md", "doctrine/schema.md", "doctrine/ledger.md", "learnings/fixture.yaml"]
    .map((path) => readFileSync(join(root, path), "utf8"));
  const rule = createWorkerRuleTool(root, () => {});
  assert.equal(rule.annotations?.readOnlyHint, true);
  const response = await rule.handler({ query: "../worker.json" }, {});
  assert.equal(response.isError, true, "a caller cannot turn the query into a path read");
  assert.deepEqual(readdirSync(root).sort(), ["CLAUDE.md", "doctrine", "learnings"]);
  assert.deepEqual(
    ["CLAUDE.md", "doctrine/schema.md", "doctrine/ledger.md", "learnings/fixture.yaml"]
      .map((path) => readFileSync(join(root, path), "utf8")),
    before,
  );
});

test("W1-T4094: rules ablation enables headlines only in its unmasked arm", async (t) => {
  const root = fixture(t);
  const seen: Array<{ maskRules?: boolean; workerRuleHeadlinesEnabled?: boolean }> = [];
  const runTaskFn = (async (_id: string, options: { maskRules?: boolean; workerRuleHeadlinesEnabled?: boolean }) => {
    seen.push({ maskRules: options.maskRules, workerRuleHeadlinesEnabled: options.workerRuleHeadlinesEnabled });
    return {
      taskId: "W1-T4094", runId: options.maskRules ? "B" : "A", merged: false, costUsd: 1,
      verdict: "awaiting_merge",
    } satisfies RunResult;
  }) as typeof import("../src/run-task.js").runTask;
  const code = await wipeTestCommand(
    ["W1-T4094", "--factor", "rules", "--repo", "remudero", "--allow-non-sandbox"],
    { config: { claudeBin: "/bin/true", root }, runTaskFn, resolveMergedState: () => ({ merged: false }) },
  );
  assert.equal(code, 0);
  assert.deepEqual(seen, [
    { maskRules: undefined, workerRuleHeadlinesEnabled: true },
    { maskRules: true, workerRuleHeadlinesEnabled: true },
  ]);
});

test("W1-T4094: every live doctrine id agrees with the canonical id", () => {
  const root = process.cwd();
  const source = readFileSync(join(root, "CLAUDE.md"), "utf8");
  const rules = parseRuleHeadlines(source);
  assert.ok(rules.length > 10, "the parity check covers the real rule index");
  for (const rule of rules) {
    const canonicalId = slugifyRuleId(rule.headline);
    const result = lookupWorkerRule(canonicalId, source, (path) => readFileSync(join(root, path), "utf8"), []);
    assert.equal(result?.id, canonicalId, rule.headline);
  }
});
