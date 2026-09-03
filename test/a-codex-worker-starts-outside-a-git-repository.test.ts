import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { spawnCodexWorker } from "../src/lib/worker-provider.js";
import type { ContainedSpawnOptions } from "../src/lib/worker-containment.js";

/** Minimal Codex child: emits a well-formed turn so the spawn resolves, exactly as the
 *  private-temp-root suite's own helper does. */
function deferredCodexProcess() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const process = Object.assign(new EventEmitter(), { stdin, stdout, stderr });
  let exited = false;
  return {
    process,
    finish(exitCode = 0) {
      if (exited) return;
      exited = true;
      stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "codex-trust" })}\n`);
      stdout.write(`${JSON.stringify({ type: "turn.started" })}\n`);
      stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } })}\n`);
      stdout.write(`${JSON.stringify({ type: "turn.completed", usage: {} })}\n`);
      stdout.end();
      queueMicrotask(() => process.emit("exit", exitCode));
    },
  };
}

function config(root: string) {
  return {
    claudeBin: "/unused/claude",
    root,
    workerProviders: { enabled: ["codex" as const], codexBin: "/bin/sh", codexHome: join(root, "codex-home") },
  };
}

/** Spawn one Codex worker and hand back the argv the containment layer was asked to run. */
async function capturedArgs(root: string, cwd: string, resumeSessionId?: string): Promise<string[]> {
  const controlled = deferredCodexProcess();
  let options: ContainedSpawnOptions | undefined;
  const promise = spawnCodexWorker(
    {
      cwd,
      prompt: "probe",
      // The isolation probe is Bash-only and carries no write tool; `readOnly` in
      // `codexExecArgs` is derived from exactly this list, so the fixture supplies it rather
      // than letting an absent list silently select `workspace-write`.
      tools: ["Bash"],
      resumeSessionId,
      containment: {
        spawn: (opts) => {
          options = opts;
          return { process: controlled.process as never, pid: 31_001 };
        },
        teardown: () => {},
      },
    },
    config(root),
  );
  controlled.finish();
  await promise;
  assert.ok(options, "the containment layer was asked to spawn Codex");
  return options.args;
}

test("W1-T2754: a Codex worker is launched with --skip-git-repo-check so a non-repository cwd cannot silently produce an empty transcript", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-codex-trust-"));
  // The isolation probe's own cwd shape: a bare mkdtemp directory that is NOT a git repository.
  // Codex refuses such a cwd by exiting 0 with no output, which reaches the caller as an
  // unparseable transcript rather than as an error.
  const nonRepoCwd = mkdtempSync(join(root, "isolation-probe-"));
  try {
    const fresh = await capturedArgs(root, nonRepoCwd);
    assert.ok(
      fresh.includes("--skip-git-repo-check"),
      `a fresh Codex spawn must waive the trusted-directory gate; argv was ${JSON.stringify(fresh)}`,
    );

    // `shared` feeds the resume argv too, so a resumed worker in the same cwd is covered by the
    // same single flag rather than by a second, drift-prone copy.
    const resumed = await capturedArgs(root, nonRepoCwd, "resume-thread");
    assert.ok(resumed.includes("resume"), "the resume path was exercised");
    assert.ok(
      resumed.includes("--skip-git-repo-check"),
      `a resumed Codex spawn must waive it as well; argv was ${JSON.stringify(resumed)}`,
    );

    // THE FLAG WAIVES THE TRUST PROMPT, NEVER THE SANDBOX. If this ever regresses into a broader
    // permission grant the containment guarantee is gone, so the sandbox bound is asserted on the
    // same argv rather than trusted to stay put.
    const sandboxIndex = fresh.indexOf("--sandbox");
    assert.notEqual(sandboxIndex, -1, "the sandbox bound is still declared");
    assert.equal(fresh[sandboxIndex + 1], "read-only", "a tool-less probe stays read-only");
    assert.ok(!fresh.includes("--dangerously-bypass-approvals-and-sandbox"));
    assert.ok(!fresh.includes("--full-auto"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
