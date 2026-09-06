import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { spawnCodexWorker } from "../src/lib/worker-provider.js";
import type { ContainedSpawnOptions } from "../src/lib/worker-containment.js";
import type { SpawnWorkerArgs } from "../src/lib/worker.js";

async function captureCodexSpawn(
  root: string,
  tools: string[],
  sandboxIntent?: SpawnWorkerArgs["sandboxIntent"],
): Promise<{ options: ContainedSpawnOptions; privateTmpExisted: boolean }> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr });
  const workerHome = mkdtempSync(join(tmpdir(), "rmd-codex-review-home-"));
  let captured: ContainedSpawnOptions | undefined;
  let privateTmpExisted = false;
  stdin.on("finish", () => {
    stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "codex-disposable-review" })}\n`);
    stdout.write(`${JSON.stringify({ type: "turn.started" })}\n`);
    stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } })}\n`);
    stdout.write(`${JSON.stringify({ type: "turn.completed", usage: {} })}\n`);
    stdout.end();
    queueMicrotask(() => child.emit("exit", 0));
  });
  try {
    await spawnCodexWorker(
      {
        workerHome,
        cwd: root,
        prompt: "exercise the sandbox contract",
        tools,
        sandboxIntent,
        containment: {
          spawn: (options) => {
            captured = options;
            privateTmpExisted = existsSync(options.env.TMPDIR!);
            return { process: child as never, pid: 29_460 };
          },
          teardown: () => {},
        },
      },
      { claudeBin: "/unused", root, workerProviders: { enabled: ["codex"], codexBin: "/bin/sh" } },
    );
    assert.ok(captured);
    assert.equal(existsSync(captured.env.TMPDIR!), false, "the provider reaps its private TMPDIR after the spawn");
    return { options: captured, privateTmpExisted };
  } finally {
    rmSync(workerHome, { recursive: true, force: true });
  }
}

test("W1-T2946: disposable reviews get private test writes without widening other Codex workers", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-codex-disposable-review-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    const source = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
    assert.equal(source.match(/sandboxIntent: "disposable-review"/g)?.length, 1, "only runReview marks this intent");
    assert.match(source, /tools: SPECIALIST_TOOLS, sandboxIntent: "disposable-review"/);

    const review = await captureCodexSpawn(root, ["Read", "Grep", "Glob", "Bash"], "disposable-review");
    const reviewArgs = review.options.args;
    assert.equal(review.privateTmpExisted, true);
    assert.equal(reviewArgs[reviewArgs.indexOf("--sandbox") + 1], "workspace-write");
    assert.equal(reviewArgs[reviewArgs.indexOf("--add-dir") + 1], review.options.env.TMPDIR);
    assert.equal(reviewArgs.filter((arg) => arg === "--add-dir").length, 1, "Git metadata gains no write grant");
    assert.equal(reviewArgs.includes("sandbox_workspace_write.network_access=true"), false);

    const specialist = await captureCodexSpawn(root, ["Read", "Bash"]);
    assert.equal(specialist.options.args[specialist.options.args.indexOf("--sandbox") + 1], "read-only");
    assert.equal(specialist.options.args.includes("--add-dir"), false);

    const implementation = await captureCodexSpawn(root, ["Read", "Write", "Edit", "Bash"]);
    assert.equal(implementation.options.args[implementation.options.args.indexOf("--sandbox") + 1], "workspace-write");
    assert.equal(implementation.options.args.includes("sandbox_workspace_write.network_access=true"), true);
    assert.ok(implementation.options.args.includes("--add-dir"), "implementation workers retain their Git metadata grant");
    assert.notEqual(implementation.options.args[implementation.options.args.indexOf("--add-dir") + 1], implementation.options.env.TMPDIR);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
