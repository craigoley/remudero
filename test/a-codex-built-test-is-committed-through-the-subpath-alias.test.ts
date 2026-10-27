// W1-T10084: a Codex writer's edits are committed by `commitCodexWriterEdits`, not `commitWorkerEdits`, so the
// W1-T10064 rewrite of an added test's relative imports must run on that commit path too.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { recordWorktreeBase } from "#src/lib/worker.js";
import { commitCodexWriterEdits, spawnCodexWorker } from "#src/lib/worker-provider.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "#test/helpers/git-repo.js";

// Built from UP so this file's own source never carries the specifier the census counts.
const UP = "..";
const RELATIVE = `import { x } from "${UP}/src/lib/x.js";\n`;
const ALIASED = 'import { x } from "#src/lib/x.js";\n';

/** A worktree the harness cut and recorded, the only shape `commitCodexWriterEdits` commits in. */
function codexCut(existing?: { path: string; text: string }) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t10084-`));
  const seed = gitRepo({ kind: "t10084-seed" });
  seed.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  seed.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  if (existing) {
    mkdirSync(join(seed.dir, "test"), { recursive: true });
    writeFileSync(join(seed.dir, existing.path), existing.text);
    seed.git("add", "--", existing.path);
    seed.git("commit", "--quiet", "-m", "chore: seed an existing test");
  }
  const wt = seed.addWorktree(join(root, "wt"), "run-W1-T10084-1");
  recordWorktreeBase(wt.dir, wt.git("rev-parse", "HEAD"), wt.git("rev-parse", "--absolute-git-dir"));
  mkdirSync(join(wt.dir, "test"), { recursive: true });
  return { wt, cleanup: () => { rmSync(root, { recursive: true, force: true }); seed.cleanup(); } };
}

test("W1-T10084: a Codex-built test is committed through the subpath alias", async () => {
  const { wt, cleanup } = codexCut();
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t10084-home-`));
  try {
    const stdout = new PassThrough();
    const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout });
    // The writer's async Git probe runs BEFORE the containment spawn: the child may only exit once it exists.
    let spawned!: () => void;
    const hasSpawned = new Promise<void>((resolve) => { spawned = resolve; });
    const run = spawnCodexWorker({
      workerHome: home, cwd: wt.dir, prompt: "add a test", settingsFile: join(process.cwd(), "settings/worker.json"),
      runId: "W1-T10084-run", taskId: "W1-T10084",
      containment: { spawn: () => { spawned(); return { process: proc as never, pid: 10084 }; }, teardown: () => { proc.emit("exit", null); } },
    }, { claudeBin: "/unused", root: home, workerProviders: { codexBin: "/bin/sh", codexModel: "gpt-6-luna" } });
    void run.catch(() => undefined);
    // The Codex writer adds a test that imports `../src`, then ends its turn.
    writeFileSync(join(wt.dir, "test/a.test.ts"), RELATIVE);
    stdout.write('{"type":"thread.started","thread_id":"t10084"}\n{"type":"turn.started"}\n');
    stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done\nCOMMIT_MESSAGE: test: add a" } })}\n`);
    stdout.end('{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}\n');
    await hasSpawned;
    proc.emit("exit", 0);
    const result = await run;

    assert.equal(result.harnessCommit?.outcome, "committed");
    assert.equal(wt.git("show", "HEAD:test/a.test.ts") + "\n", ALIASED);
    const rows = readFileSync(join(home, "state/ledger.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const row = rows.filter((r) => r.step === "codex.harness_commit");
    assert.equal(row.length, 1, "one codex.harness_commit row");
    assert.equal(row[0].run_id, "W1-T10084-run");
    assert.equal(row[0].outcome, "committed");
    assert.equal(row[0].sha, wt.git("rev-parse", "HEAD"));
    assert.deepEqual(row[0].alias_rewritten, ["test/a.test.ts"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
    cleanup();
  }
});

test("W1-T10084: the Codex harness commit never rewrites an existing test", () => {
  const { wt, cleanup } = codexCut({ path: "test/old.test.ts", text: RELATIVE });
  try {
    const left = `${RELATIVE}import { y } from "${UP}/src/lib/y.js";\n`;
    writeFileSync(join(wt.dir, "test/old.test.ts"), left);

    const commit = commitCodexWriterEdits(wt.dir, "done\nCOMMIT_MESSAGE: test: extend old");

    assert.equal(commit.outcome, "committed");
    assert.equal(wt.git("show", "HEAD:test/old.test.ts") + "\n", left);
    assert.deepEqual(commit, { outcome: "committed", sha: wt.git("rev-parse", "HEAD") }, "no aliasRewrite on the outcome");
  } finally { cleanup(); }
});

test("W1-T10084: a Codex harness commit with nothing changed is still nothing-to-commit", () => {
  const { wt, cleanup } = codexCut();
  try {
    assert.deepEqual(commitCodexWriterEdits(wt.dir, "done"), { outcome: "nothing-to-commit" });
  } finally { cleanup(); }
});
