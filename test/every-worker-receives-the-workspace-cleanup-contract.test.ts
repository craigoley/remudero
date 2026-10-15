import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { renderAgentsMd } from "../scripts/generate-agents-md.mjs";
import { createClaudeExecutableCache, spawnWorker, type SpawnWorkerArgs } from "../src/lib/worker.js";
import { withWorkspaceCleanup, WORKSPACE_CLEANUP_INSTRUCTIONS } from "../src/lib/workspace-cleanup-contract.js";

// Real common dispatcher, synthetic provider boundaries: no paid calls or live credentials.
for (const provider of ["claude", "codex", "cash"] as const) {
  test(`the real ${provider} worker receives cleanup duties without changing its task or authority`, async () => {
    const root = mkdtempSync(join(tmpdir(), "rmd-cleanup-contract-"));
    const task = 'Return exactly {"ok":true}; do not change repository files.';
    let received = "";
    const capture: NonNullable<SpawnWorkerArgs["providerRouting"]>["spawnCodex"] = async (args) => {
      received = args.prompt;
      assert.equal(args.cwd, root);
      assert.deepEqual(args.tools, ["Read"]);
      return { provider, text: '{"ok":true}', isError: false, subtype: "success" } as never;
    };
    try {
      const result = await spawnWorker({
        cwd: root, prompt: task, tools: ["Read"], mountProvider: provider,
        permissionMode: "bypassPermissions",
        settingsFile: join(process.cwd(), "settings/worker.json"),
        config: { root, claudeBin: "/unused", workerProviders: { enabled: ["claude", "codex", "cash"] } },
        providerRouting: { spawnCodex: capture, spawnOpenWeight: capture, writeStatus: () => {} },
        claudeExecutable: { cache: createClaudeExecutableCache(), deps: {
          env: { RMD_CLAUDE_BIN: "/fake/claude" }, home: root, exists: () => true,
          which: () => "/fake/claude", canExecute: () => true, locations: [],
        } },
        keychain: { platform: "linux", readCredentialFile: () => JSON.stringify({
          claudeAiOauth: { accessToken: "stub", expiresAt: 4_102_444_800_000 },
        }) },
        queryFn: ((args) => {
          received = args.prompt as string;
          return (async function* () { yield { type: "result", subtype: "success", is_error: false,
            result: '{"ok":true}', session_id: "synthetic", total_cost_usd: 0, num_turns: 1 }; })();
        }) as SpawnWorkerArgs["queryFn"],
      });
      assert.equal(result.text, '{"ok":true}');
      assert.equal(received, `${task}\n\n${WORKSPACE_CLEANUP_INSTRUCTIONS}`);
      assert.match(received, /existing tool\/write authority/);
      assert.match(received, /harness owns its teardown/);
      assert.match(received, /unpublished commits/);
      assert.match(received, /required output schema/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("provider fallback keeps exactly one cleanup contract and preserves the original task", () => {
  const prompt = "build the task";
  const first = withWorkspaceCleanup(prompt);
  assert.equal(first, `${prompt}\n\n${WORKSPACE_CLEANUP_INSTRUCTIONS}`);
  assert.equal(withWorkspaceCleanup(first), first);
});

test("Claude and generated agent instructions require every worker to clean its owned workspace safely", () => {
  const claude = readFileSync("CLAUDE.md", "utf8");
  const agents = readFileSync("AGENTS.md", "utf8");
  assert.equal(agents, renderAgentsMd(claude));
  for (const text of [claude, agents]) {
    assert.match(text, /Every builder, reviewer and worker must clean up its own disposable workspace artifacts/);
    assert.match(text, /preserve active\/shared paths, unpublished work and durable evidence/);
    assert.match(text, /worktree retirement to the harness/);
  }
});
