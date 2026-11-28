// W1-T15260 — A CODEX WORKER OUTSIDE A GIT CHECKOUT READS NO FOLDER ABOVE ITS CWD.
//
// Codex looks upward from its cwd for a project-root marker (.git by default) before it loads
// AGENTS.md. Outside any checkout it finds none and loads the doc from the cwd alone, but the walk
// still touches every folder above the cwd. Under a sandbox that denies `:root`, that walk fails
// with "Permission denied (os error 13)" before the thread starts: every Codex judge whose cwd is
// the state root failed this way on 2026-11-28 (codex-cli 0.171.0). An empty marker list keeps
// the same doc and skips the walk. A cwd inside a checkout keeps its walk unchanged.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { spawnCodexWorker } from "#src/lib/worker-provider.js";
import type { ContainedSpawnOptions } from "#src/lib/worker-containment.js";

function deferredCodexProcess() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr });
  return {
    process: proc,
    finish(exitCode = 0) {
      stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "codex-root" })}\n`);
      stdout.write(`${JSON.stringify({ type: "turn.started" })}\n`);
      stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } })}\n`);
      stdout.write(`${JSON.stringify({ type: "turn.completed", usage: {} })}\n`);
      stdout.end();
      queueMicrotask(() => proc.emit("exit", exitCode));
    },
  };
}

async function capturedArgs(root: string, cwd: string): Promise<string[]> {
  const controlled = deferredCodexProcess();
  let options: ContainedSpawnOptions | undefined;
  const promise = spawnCodexWorker(
    {
      workerHome: mkdtempSync(join(tmpdir(), "rmd-codex-home-")),
      cwd,
      prompt: "probe",
      settingsFile: join(process.cwd(), "settings", "worker.json"),
      tools: ["Bash"],
      containment: {
        spawn: (opts) => {
          options = opts;
          return { process: controlled.process as never, pid: 31_003 };
        },
        teardown: () => {},
      },
    },
    {
      claudeBin: "/unused/claude",
      root,
      workerProviders: { enabled: ["codex" as const], codexBin: "/bin/sh", codexModel: "gpt-6-luna", codexHome: join(root, "codex-home") },
    } as never,
  );
  controlled.finish();
  await promise;
  assert.ok(options, "the containment layer was asked to spawn Codex");
  return options.args;
}

function markerOverrides(args: string[]): string[] {
  return args.filter((arg, i) => args[i - 1] === "-c" && arg.startsWith("project_root_markers="));
}

test("W1-T15260 criterion 1: a Codex spawn outside any git worktree passes project_root_markers=[]", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-codex-noroot-"));
  try {
    const args = await capturedArgs(root, root);
    assert.deepEqual(markerOverrides(args), ["project_root_markers=[]"],
      `a cwd in no checkout must stop Codex walking above it; argv was ${JSON.stringify(args)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T15260 criterion 2: a Codex spawn inside a git worktree gets no project_root_markers override", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-codex-inrepo-"));
  try {
    // The test runs from this repository's own checkout, which is a git worktree.
    const args = await capturedArgs(root, process.cwd());
    assert.deepEqual(markerOverrides(args), [],
      `a cwd inside a checkout keeps Codex's own project-root walk; argv was ${JSON.stringify(args)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
