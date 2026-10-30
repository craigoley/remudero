import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { isSpawnInfraBlockedError } from "#src/lib/ledger.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { WorktreeNodeModulesRefusedError, worktreeAdd, worktreeAddAsync } from "#src/lib/worker.js";
import { runTask } from "#src/run-task.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const adders = [worktreeAddAsync, worktreeAdd];
type Row = [string, Record<string, unknown> | undefined];

function fixture(t: TestContext, withPackage = true) {
  const repo = gitRepo({ scope: t, kind: "w1-t9855" });
  if (withPackage) {
    writeFileSync(join(repo.dir, "package.json"), JSON.stringify({ name: "w1-t9855" }));
    repo.git("add", "package.json");
    repo.git("commit", "--quiet", "-m", "chore: seed package");
  }
  repo.addRemote("origin", repo.dir);
  return repo;
}

test("W1-T9855: an implement worktree with no install source is refused as a deferral", async (t) => {
  for (const add of adders) {
    const repo = fixture(t);
    const worktree = join(repo.dir, "worktree");
    const rows: Row[] = [];
    const deps = {
      resolveSource: () => undefined,
      refuseSamePackageLockfileMismatch: true,
      log: (step: string, extra?: Record<string, unknown>) => rows.push([step, extra]),
    };
    await assert.rejects(async () => add(repo.dir, worktree, "run-no-source", "origin/main", deps), (error: unknown) => {
      assert.ok(error instanceof WorktreeNodeModulesRefusedError, String(error));
      assert.equal(isSpawnInfraBlockedError(error), true);
      assert.equal(error.packageName, "w1-t9855");
      assert.equal(error.worktreePath, worktree);
      assert.match(error.message, /no-source/);
      return true;
    });
    assert.equal(existsSync(join(worktree, "node_modules")), false);
    assert.deepEqual(rows.filter(([step]) => step === "worktree.node_modules"), [
      ["worktree.node_modules", { outcome: "no-source", source: null }],
    ]);
  }
});

test("W1-T9855: every lane ledgers the root node_modules outcome", async (t) => {
  for (const add of adders) {
    for (const withPackage of [true, false]) {
      for (const outcome of ["no-source", "failed"] as const) {
        const repo = fixture(t, withPackage);
        const worktree = join(repo.dir, "worktree");
        const source = outcome === "failed" ? join(repo.dir, "missing", "node_modules") : undefined;
        const rows: Row[] = [];
        await add(repo.dir, worktree, "run-observe", "origin/main", {
          resolveSource: () => source,
          refuseSamePackageLockfileMismatch: !withPackage,
          log: (step, extra) => rows.push([step, extra]),
        });
        assert.equal(existsSync(join(worktree, "node_modules")), false);
        assert.deepEqual(rows.filter(([step]) => step === "worktree.node_modules"), [
          ["worktree.node_modules", { outcome, source: source ?? null }],
        ]);
      }
    }
  }
});

test("W1-T9855: a failed root install is refused before worktree preparation finishes", async (t) => {
  for (const add of adders) {
    const repo = fixture(t);
    const source = join(repo.dir, "missing", "node_modules");
    const rows: Row[] = [];
    await assert.rejects(async () => add(repo.dir, join(repo.dir, "worktree"), "run-failed", "origin/main", {
      resolveSource: () => source,
      refuseSamePackageLockfileMismatch: true,
      log: (step, extra) => rows.push([step, extra]),
    }), (error: unknown) => {
      assert.ok(error instanceof WorktreeNodeModulesRefusedError, String(error));
      assert.equal(isSpawnInfraBlockedError(error), true);
      assert.equal(error.nodeModulesSource, source);
      assert.match(error.message, /failed/);
      return true;
    });
    assert.deepEqual(rows.filter(([step]) => step === "worktree.node_modules"), [
      ["worktree.node_modules", { outcome: "failed", source }],
    ]);
  }
});

test("W1-T9855: runTask releases the claim without spawning a worker when the install is absent", async (t) => {
  const origin = fixture(t);
  const root = origin.dir;
  origin.git("clone", "--quiet", root, join(root, "repos", "remudero"));
  const taskId = "T-W1-T9855-PROBE";
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, [
    `- id: ${taskId}`, "  title: missing install probe", "  repo: remudero", "  type: implement",
    "  verify: auto", "  risk: medium", "  files: [src/lib/worker.ts]", "  origin: architect", "  status: queued", "",
  ].join("\n"));
  const dropped: string[] = [];
  let spawned = 0;
  await assert.rejects(() => withLiveWritesAllowed(() => runTask(taskId, {
    skipGitSync: true,
    planPath,
    config: { claudeBin: "/bin/true", root, installRoot: REPO_ROOT },
    github: {
      prByRef: () => null, findMergedByTrailer: () => null,
      headRefName: () => undefined, prBody: () => undefined,
    },
    spawn: async () => { spawned++; throw new Error("a worker must not run without an install"); },
    containmentExec: async (token) => ({
      transcript: `touch ../${token}.txt: Operation not permitted`,
      outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0,
    }),
    isolationExec: async () => ({
      transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -",
      aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0,
    }),
    claimReserver: {
      mintAnchor: () => "w1-t9855-anchor", attempt: () => "created", holder: () => undefined,
      drop: (id) => { dropped.push(id); return true; },
    },
    worktreeBaseDeps: { resolveSource: () => undefined },
    managedCheckoutInstall: () => {},
  })), (error: unknown) => {
    assert.ok(error instanceof WorktreeNodeModulesRefusedError, String(error));
    assert.equal(isSpawnInfraBlockedError(error), true);
    assert.match(error.message, /no-source/);
    return true;
  });
  assert.equal(spawned, 0);
  assert.deepEqual(dropped, [taskId]);
  const rows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(rows.find((row) => row.step === "worktree.node_modules")?.outcome, "no-source");
  assert.ok(rows.find((row) => row.step === "worktree.node_modules_refused"));
  assert.equal(rows.find((row) => row.step === "worktree.add_failed"), undefined);
});

test("test/a-run-worktree-without-node-modules-is-refused-before-its-worker.test.ts", async (t) => {
  for (const add of adders) {
    const repo = fixture(t);
    const source = join(repo.dir, "node_modules");
    mkdirSync(source);
    const rows: Row[] = [];
    const worktree = join(repo.dir, "worktree");
    await add(repo.dir, worktree, "run-healthy", "origin/main", {
      refuseSamePackageLockfileMismatch: true,
      log: (step, extra) => rows.push([step, extra]),
    });
    assert.equal(realpathSync(join(worktree, "node_modules")), realpathSync(source));
    assert.deepEqual(rows.filter(([step]) => step === "worktree.node_modules"), [
      ["worktree.node_modules", { outcome: "linked", source }],
    ]);
  }
});
