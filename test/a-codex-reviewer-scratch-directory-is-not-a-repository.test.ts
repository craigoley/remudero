import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
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
      codexBin: "/bin/sh",
      codexHome: join(root, "codex-home"),
    },
  };
}

async function captureSpawn(
  root: string,
  cwd: string,
  tools: string[],
  resumeSessionId?: string,
): Promise<{ args: string[]; text: string; sessionId: string }> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr });
  let captured: ContainedSpawnOptions | undefined;
  const resultPromise = spawnCodexWorker(
    {
      // W1-T2800: the Codex spawn now requires an explicit redirected worker home.
      workerHome: mkdtempSync(join(tmpdir(), "rmd-codex-home-")),
      cwd,
      prompt: "review this change",
      tools,
      resumeSessionId,
      containment: {
        spawn: (options) => {
          captured = options;
          return { process: child as never, pid: 31_274 };
        },
        teardown: () => {},
      },
    },
    config(root),
  );

  stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "codex-review-thread" })}\n`);
  stdout.write(`${JSON.stringify({ type: "turn.started" })}\n`);
  stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "review complete" } })}\n`);
  stdout.write(`${JSON.stringify({ type: "turn.completed", usage: {} })}\n`);
  stdout.end();
  queueMicrotask(() => child.emit("exit", 0));

  const result = await resultPromise;
  assert.ok(captured, "the containment adapter must receive the Codex spawn");
  return { args: captured.args, text: result.text, sessionId: result.sessionId };
}

test("W1-T2748: a read-only reviewer in a non-repository scratch gets the narrow trust bypass and completes", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-codex-reviewer-trust-"));
  const scratch = mkdtempSync(join(root, "review-"));
  try {
    const result = await captureSpawn(root, scratch, ["Read", "Grep", "Glob", "Bash"]);
    assert.ok(result.args.includes("--skip-git-repo-check"));
    assert.equal(result.args[result.args.indexOf("--sandbox") + 1], "read-only");
    assert.equal(result.text, "review complete", "the existing JSONL result stream still reaches the caller");
    assert.equal(result.sessionId, "codex-review-thread");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2748: a read-only worker in a real Git worktree keeps the trust check", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-codex-reviewer-git-"));
  const worktree = join(root, "worktree");
  try {
    execFileSync("git", ["init", "-q", "-b", "main", worktree]);
    const result = await captureSpawn(root, worktree, ["Read", "Bash"]);
    assert.equal(result.args.includes("--skip-git-repo-check"), false);
    assert.equal(result.args[result.args.indexOf("--sandbox") + 1], "read-only");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2748: a write-capable worker outside Git remains fail-closed at Codex's trust gate", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-codex-writer-trust-"));
  const scratch = mkdtempSync(join(root, "writer-"));
  try {
    const result = await captureSpawn(root, scratch, ["Read", "Write", "Edit", "Bash"]);
    assert.equal(result.args.includes("--skip-git-repo-check"), false);
    assert.equal(result.args[result.args.indexOf("--sandbox") + 1], "workspace-write");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2748: fresh and resumed read-only reviewers share the same narrow non-repository decision", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-codex-reviewer-resume-"));
  const scratch = mkdtempSync(join(root, "review-"));
  try {
    const fresh = await captureSpawn(root, scratch, ["Read", "Bash"]);
    const resumed = await captureSpawn(root, scratch, ["Read", "Bash"], "resume-review-thread");
    assert.ok(fresh.args.includes("--skip-git-repo-check"));
    assert.ok(resumed.args.includes("resume"));
    assert.ok(resumed.args.includes("--skip-git-repo-check"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
