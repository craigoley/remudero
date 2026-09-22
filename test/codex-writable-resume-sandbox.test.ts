import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { spawnCodexWorker } from "../src/lib/worker-provider.js";
import type { ContainedSpawnOptions } from "../src/lib/worker-containment.js";

function config(root: string) {
  return {
    claudeBin: "/unused/claude",
    root,
    workerProviders: {
      enabled: ["codex" as const],
      codexBin: "/bin/sh", codexModel: "gpt-6-luna",
      codexHome: join(root, "codex-home"),
    },
  };
}

function completedChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const process = Object.assign(new EventEmitter(), { stdin, stdout, stderr });
  return {
    process,
    finish() {
      stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "codex-writable-resume" })}\n`);
      stdout.write(`${JSON.stringify({ type: "turn.started" })}\n`);
      stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } })}\n`);
      stdout.write(`${JSON.stringify({ type: "turn.completed", usage: {} })}\n`);
      stdout.end();
      queueMicrotask(() => process.emit("exit", 0));
    },
  };
}

async function captureArgs(root: string, cwd: string, tools: string[], resumeSessionId?: string): Promise<string[]> {
  const child = completedChild();
  let captured: ContainedSpawnOptions | undefined;
  const workerHome = mkdtempSync(join(root, "codex-home-"));
  const result = spawnCodexWorker(
    {
      workerHome,
      cwd,
      prompt: "repair the reported acceptance failure",
      settingsFile: join(process.cwd(), "settings", "worker.json"),
      tools,
      resumeSessionId,
      containment: {
        spawn: (options) => {
          captured = options;
          return { process: child.process as never, pid: 37_920 };
        },
        teardown: () => {},
      },
    },
    config(root),
  );
  child.finish();
  await result;
  assert.ok(captured, "the containment adapter must receive the Codex argv");
  return captured.args;
}

function initializedWorktree(root: string): string {
  const worktree = join(root, "worktree");
  execFileSync("git", ["init", "-q", "-b", "main", worktree]);
  return worktree;
}

test("W1-T3792: writable Codex resume retains workspace-write sandbox", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-codex-writable-resume-"));
  try {
    const args = await captureArgs(root, initializedWorktree(root), ["Read", "Write", "Edit", "Bash"], "failed-fix-session");
    assert.equal(args[0], "exec");
    assert.equal(args.includes("resume"), false, "a writer cannot use the containment-less resume form");
    assert.equal(args[args.indexOf("--sandbox") + 1], "workspace-write");
    assert.ok(args.includes("sandbox_workspace_write.network_access=true"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3792: writable Codex resume keeps fresh containment roots", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-codex-writable-roots-"));
  const worktree = initializedWorktree(root);
  try {
    const args = await captureArgs(root, worktree, ["Read", "Write", "Edit", "Bash"], "failed-fix-session");
    const cwdIndex = args.indexOf("-C");
    const writableRoots = args.flatMap((arg, index) => arg === "--add-dir" ? [args[index + 1]] : []);
    assert.equal(args[cwdIndex + 1], worktree, "the fresh invocation keeps the requested worktree cwd");
    assert.deepEqual(writableRoots, [realpathSync(join(worktree, ".git"))], "only this worktree's Git administrative root is writable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3792: Codex resume preserves read-only and non-repository boundaries", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-codex-resume-boundaries-"));
  const worktree = initializedWorktree(root);
  const nonRepository = mkdtempSync(join(root, "non-repository-"));
  try {
    const reviewer = await captureArgs(root, worktree, ["Read", "Grep", "Glob", "Bash"], "review-session");
    assert.deepEqual(reviewer.slice(0, 2), ["exec", "resume"], "read-only continuations retain the CLI resume form");

    const writer = await captureArgs(root, nonRepository, ["Read", "Write", "Edit", "Bash"], "failed-fix-session");
    assert.equal(writer.includes("resume"), false, "the fresh writer path still owns a write-capable continuation");
    assert.equal(writer.includes("--skip-git-repo-check"), false, "a writer outside Git receives no trust bypass");
    assert.equal(writer.includes("--add-dir"), false, "an unproven repository layout earns no writable root");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
