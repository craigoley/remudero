import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ENGINE_RECORD, enginePath, ensureEngineTree } from "#src/lib/engine-tree.js";
import { childIdentity, RUN_CHILD_SCHEMA, writeSpec, writeStatus } from "#src/lib/run-child-contract.js";

const hash = "a".repeat(64);
const otherSha = "b".repeat(40);
type LinkKind = "dangling" | "worktree" | "indirect" | "mismatch" | "trusted";
type RunKind = "hash" | "sha" | "undecidable" | "unreadable" | "terminal" | "unrelated";

function fixture(t: TestContext, kind: LinkKind) {
  const repo = gitRepo({ scope: t, kind: "unsafe-engine" });
  const root = realpathSync(repo.dir);
  const state = join(root, "state");
  const install = join(root, "node_modules");
  mkdirSync(install);
  const sha = repo.git("rev-parse", "HEAD");
  const engine = enginePath(state, hash);
  mkdirSync(join(state, "engines"), { recursive: true });
  repo.git("worktree", "add", "--quiet", "--detach", engine, sha);
  let target = install;
  if (kind === "dangling" || kind === "worktree" || kind === "indirect") {
    target = join(root, "worktrees", "run-old", "node_modules");
    if (kind === "worktree") mkdirSync(target, { recursive: true });
    if (kind === "indirect") {
      mkdirSync(join(root, "worktrees", "run-old"), { recursive: true });
      symlinkSync(install, target, "dir");
    }
  }
  symlinkSync(target, join(engine, "node_modules"), "dir");
  const nodeModulesTarget = kind === "mismatch" ? join(root, "previous-install") : install;
  writeFileSync(join(engine, ENGINE_RECORD), JSON.stringify({ sha, sourceHash: hash, builtAt: 1, nodeModulesTarget }));
  writeFileSync(join(engine, "old-engine"), "preserve while held");
  const rows: { step: string; extra?: Record<string, unknown> }[] = [];
  let materializations = 0;
  const deps = {
    repoDir: root,
    storeRoot: join(state, "store"),
    log: (step: string, extra?: Record<string, unknown>) => { rows.push({ step, extra }); },
    materialize: () => { materializations++; return { outcome: "hit" as const, hash }; },
  };
  return { state, engine, install, sha, target, rows, deps, materializations: () => materializations };
}

function plantRun(f: ReturnType<typeof fixture>, kind: RunKind) {
  if (kind === "unreadable") {
    writeFileSync(join(f.state, "runs"), "not a directory");
    return;
  }
  const runId = "run-9838";
  const dir = join(f.state, "runs", runId);
  mkdirSync(dir, { recursive: true });
  if (kind === "undecidable") return;
  const identity = childIdentity(process.pid);
  assert.ok(identity, "the real test process has a live child identity");
  writeStatus(dir, {
    schema: RUN_CHILD_SCHEMA, runId, identity, engineSha: kind === "sha" ? f.sha : otherSha,
    entryKind: "bundle", phase: "implement", heartbeatAt: Date.now(),
    state: kind === "terminal" ? "done" : "running",
  });
  if (kind === "sha") return;
  writeSpec(dir, {
    schema: RUN_CHILD_SCHEMA, runId, taskId: "W1-T9838", instance: "test",
    engine: { sourceHash: kind === "unrelated" ? "c".repeat(64) : hash, sha: otherSha },
    planSnapshotPath: "plan.yaml", reservationId: "fixture", options: {},
  });
}

test("W1-T9838: an unsafe engine no run names is rebuilt in the same pass", async (t) => {
  for (const kind of ["dangling", "worktree", "indirect", "mismatch"] as const) {
    const f = fixture(t, kind);
    if (kind === "worktree") plantRun(f, "terminal");
    if (kind === "indirect") plantRun(f, "unrelated");
    const first = ensureEngineTree(f.state, f.sha, hash, f.deps);
    const joined = ensureEngineTree(f.state, f.sha, hash, f.deps);
    assert.equal(joined, first, "concurrent callers join the replacement build");
    const result = await first;
    assert.equal(result.kind, "built", `${kind}: ${JSON.stringify(result)}`);
    assert.equal(f.materializations(), 1);
    assert.equal(readlinkSync(join(f.engine, "node_modules")), f.install);
    assert.equal(existsSync(join(f.engine, "old-engine")), false);
    const record = JSON.parse(readFileSync(join(f.engine, ENGINE_RECORD), "utf8"));
    assert.equal(record.nodeModulesTarget, f.install);
    assert.equal(record.sourceHash, hash);
    assert.deepEqual(f.rows.map((row) => row.step), ["engine.built"]);
    assert.match(String(f.rows[0]?.extra?.replaced_unsafe_reason),
      kind === "dangling" ? /^node-modules-dangling: / : /^node-modules-untrusted: /);
    assert.equal(f.rows[0]?.extra?.node_modules_target, f.install);
    assert.deepEqual(await ensureEngineTree(f.state, f.sha, hash, f.deps), { kind: "present", root: f.engine });
    assert.equal(f.materializations(), 1, "the replacement is safe on the next call");
  }
});

test("W1-T9838: an unsafe engine a live run names is held, not present", async (t) => {
  for (const kind of ["dangling", "worktree"] as const) {
    for (const run of ["hash", "sha", "undecidable", "unreadable"] as const) {
      const f = fixture(t, kind);
      plantRun(f, run);
      const before = readFileSync(join(f.engine, ENGINE_RECORD), "utf8");
      const result = await ensureEngineTree(f.state, f.sha, hash, f.deps);
      assert.equal(result.kind, "failed", `${kind}/${run}: ${JSON.stringify(result)}`);
      assert.ok(result.kind === "failed");
      assert.match(result.reason, kind === "dangling" ? /^node-modules-dangling: held/ : /^node-modules-untrusted: held/);
      assert.match(result.reason, run === "undecidable" ? /run run-9838.*names no engine/ : /live run/);
      if (run === "unreadable") assert.match(result.reason, /live runs unreadable: .*ENOTDIR/);
      assert.equal(readlinkSync(join(f.engine, "node_modules")), f.target);
      assert.equal(readFileSync(join(f.engine, ENGINE_RECORD), "utf8"), before);
      assert.equal(readFileSync(join(f.engine, "old-engine"), "utf8"), "preserve while held");
      assert.equal(f.materializations(), 0);
      assert.deepEqual(f.rows, [{ step: "engine.build_failed", extra: { sha: f.sha, source_hash: hash, reason: result.reason } }]);
    }
  }
});

test("W1-T9838: a safe present engine is not rebuilt", async (t) => {
  const f = fixture(t, "trusted");
  plantRun(f, "undecidable");
  const before = readFileSync(join(f.engine, ENGINE_RECORD), "utf8");
  const result = await ensureEngineTree(f.state, f.sha, hash, {
    ...f.deps,
    git: async () => { assert.fail("a safe engine requires no git operation"); },
    resolveModulesSource: () => { assert.fail("a safe engine requires no new install resolution"); },
  });
  assert.deepEqual(result, { kind: "present", root: f.engine });
  assert.equal(readFileSync(join(f.engine, ENGINE_RECORD), "utf8"), before);
  assert.equal(readlinkSync(join(f.engine, "node_modules")), f.install);
  assert.equal(f.materializations(), 0);
  assert.deepEqual(f.rows, []);
});
