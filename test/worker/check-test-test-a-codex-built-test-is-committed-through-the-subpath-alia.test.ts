// W1-T11063: the W1-T10084 subpath-alias commit test failed once in CI with `harnessCommit` undefined, i.e. the
// run was judged an error (a non-clean exit or incomplete output) so no commit was attempted. The original
// emits `exit 0` the instant the containment spawn is called, before the writer has consumed the stream. A
// real child exits only AFTER its stdout is closed and drained; this replay keeps that order, so the commit
// outcome cannot depend on exit racing the output. (Root cause inferred from the code, not reproduced.)
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { recordWorktreeBase } from "#src/lib/worker.js";
import { spawnCodexWorker } from "#src/lib/worker-provider.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const UP = "..";

test("W1-T11063: check:test:test/a-codex-built-test-is-committed-through-the-subpath-alias.test.ts is prevented, not retried", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t11063-`));
  const seed = gitRepo({ kind: "t11063-seed" });
  seed.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  seed.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  const wt = seed.addWorktree(join(root, "wt"), "run-W1-T11063-1");
  recordWorktreeBase(wt.dir, wt.git("rev-parse", "HEAD"), wt.git("rev-parse", "--absolute-git-dir"));
  mkdirSync(join(wt.dir, "test"), { recursive: true });
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t11063-home-`));
  try {
    const stdout = new PassThrough();
    const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout });
    const outputClosed = new Promise<void>((resolve) => stdout.once("end", resolve));
    const run = spawnCodexWorker({
      workerHome: home, cwd: wt.dir, prompt: "add a test", settingsFile: join(REPO_ROOT, "settings/worker.json"),
      runId: "W1-T11063-run", taskId: "W1-T11063",
      containment: { spawn: () => ({ process: proc as never, pid: 11063, outputClosed }), teardown: () => { proc.emit("exit", null); } },
    }, { claudeBin: "/unused", root: home, workerProviders: { codexBin: "/bin/sh", codexModel: "gpt-6-luna" } });
    void run.catch(() => undefined);
    writeFileSync(join(wt.dir, "test/a.test.ts"), `import { x } from "${UP}/src/lib/x.js";\n`);
    stdout.write('{"type":"thread.started","thread_id":"t11063"}\n{"type":"turn.started"}\n');
    stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done\nCOMMIT_MESSAGE: test: add a" } })}\n`);
    stdout.end('{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}\n');
    // A real child exits only after its stdout is closed and drained.
    await outputClosed;
    await new Promise((resolve) => setImmediate(resolve));
    while (proc.listenerCount("exit") === 0) await new Promise((resolve) => setImmediate(resolve));
    proc.emit("exit", 0);
    const result = await run;

    assert.equal(result.harnessCommit?.outcome, "committed");
    assert.equal(wt.git("show", "HEAD:test/a.test.ts") + "\n", 'import { x } from "#src/lib/x.js";\n');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    seed.cleanup();
  }
});
