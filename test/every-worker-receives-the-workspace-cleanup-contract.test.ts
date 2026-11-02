import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { createClaudeExecutableCache, spawnWorker, type SpawnWorkerArgs, type WorkerSelectionAssignment } from "#src/lib/worker.js";
import { openWeightEstimatedTokens, spawnDecisionPoint } from "#src/lib/worker-provider.js";

// Real common dispatcher, synthetic provider boundaries: no paid calls or live credentials.
for (const provider of ["claude", "codex", "cash"] as const) {
  test(`the real ${provider} worker receives cleanup duties without changing its task or authority`, async () => {
    const { WORKSPACE_CLEANUP_INSTRUCTIONS } = await import("#src/lib/workspace-cleanup-contract.js");
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

test("provider fallback keeps exactly one cleanup contract and preserves the original task", async () => {
  const { withWorkspaceCleanup, WORKSPACE_CLEANUP_INSTRUCTIONS } = await import("#src/lib/workspace-cleanup-contract.js");
  const prompt = "build the task";
  const first = withWorkspaceCleanup(prompt);
  assert.equal(first, `${prompt}\n\n${WORKSPACE_CLEANUP_INSTRUCTIONS}`);
  assert.equal(withWorkspaceCleanup(first), first);
});

test("cleanup instructions preserve the auction seed and assignment", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-cleanup-auction-"));
  const task = { prompt: "fix rung 1", model: "sonnet", effort: "medium", taskId: "W1-T9301", runId: "run-W1-T9301-2" };
  const assignments: WorkerSelectionAssignment[] = [];
  let received = "";
  try {
    const result = await spawnWorker({
      ...task, cwd: root, permissionMode: "bypassPermissions", settingsFile: join(process.cwd(), "settings/worker.json"),
      config: { root, claudeBin: "/unused", workerProviders: { enabled: ["codex"] } },
      providerRouting: {
        readCodex: async () => ({ provider: "codex", readable: true, model: "gpt-6-sol", effort: "medium",
          windows: [{ name: "codex weekly", usedPercent: 50, resetsAt: Date.now() / 1000 + 3600 }] }),
        spawnCodex: async args => { received = args.prompt; return { provider: "codex", text: "done", model: "gpt-6-sol" } as never; },
        writeStatus: () => {},
      },
      onSelectionAssignment: value => { assignments.push(value); },
    });
    assert.equal(result.text, "done");
    assert.ok(received.startsWith(`${task.prompt}\n\n# WORKSPACE CLEANUP\n`));
    assert.equal(received.split("# WORKSPACE CLEANUP").length, 2);
    assert.equal(assignments.length, 1);
    assert.equal(assignments[0]!.routing.propensity?.draw?.key?.point, spawnDecisionPoint(task));
    assert.notEqual(spawnDecisionPoint(task), spawnDecisionPoint({ ...task, prompt: received }), "control: the extra instructions would change the routing seed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cash context estimates include the cleanup prompt actually sent", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-cleanup-cash-estimate-"));
  const task = "Return one classification.";
  let received = "";
  let estimated: number | undefined;
  try {
    await spawnWorker({
      cwd: root, prompt: task, model: "haiku", effort: "medium", mountProvider: "cash",
      permissionMode: "bypassPermissions", settingsFile: join(process.cwd(), "settings/worker.json"),
      config: { root, claudeBin: "/unused", workerProviders: { enabled: ["cash"] } },
      providerRouting: {
        spawnOpenWeight: async (args, _config, selection) => {
          received = args.prompt;
          assert.ok("estimatedTokens" in selection && typeof selection.estimatedTokens === "number");
          estimated = selection.estimatedTokens;
          return { provider: "cash", text: "done", isError: false } as never;
        },
        writeStatus: () => {},
      },
    });
    assert.ok(received.startsWith(`${task}\n\n# WORKSPACE CLEANUP\n`));
    assert.equal(received.split("# WORKSPACE CLEANUP").length, 2);
    assert.equal(estimated, openWeightEstimatedTokens(Buffer.byteLength(received, "utf8")));
    assert.ok(estimated! > openWeightEstimatedTokens(Buffer.byteLength(task, "utf8")), "control: ignoring the added instructions understates the request");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Claude and generated agent instructions require every worker to clean its owned workspace safely", () => {
  const claude = readFileSync("CLAUDE.md", "utf8");
  const agents = readFileSync("AGENTS.md", "utf8");
  const result = execFileSync(process.execPath, ["--import", "tsx", "scripts/generate-agents-md.mjs", "--check"], { encoding: "utf8" });
  assert.match(result, /generate-agents-md: OK/);
  for (const text of [claude, agents]) {
    assert.match(text, /Every builder, reviewer and worker must clean up its own disposable workspace artifacts/);
    assert.match(text, /preserve active\/shared paths, unpublished work and durable evidence/);
    assert.match(text, /worktree retirement to the harness/);
  }
});
