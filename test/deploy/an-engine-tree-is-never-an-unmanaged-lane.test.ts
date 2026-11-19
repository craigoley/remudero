import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "#src/lib/config.js";
import { enginePath, enginesRoot } from "#src/lib/engine-tree.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ADHOC_LANE_REAP_GRACE_MS, runAdhocLaneReapRung, unmanagedWorktreeLanes } from "#src/lib/worker.js";
import { gitRepo } from "#test/helpers/git-repo.js";

/** Sets every entry's mtime to twice the lane grace, so age alone would remove it. */
function age(path: string): void {
  const old = (Date.now() - ADHOC_LANE_REAP_GRACE_MS * 2) / 1000;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) age(join(path, entry.name));
    else utimesSync(join(path, entry.name), old, old);
  }
  utimesSync(path, old, old);
}

/** A real repo with a published engine, an in-flight `.build-` sibling and an ordinary lane outside every root. */
function fixture(): { config: Config; repo: string; engine: string; building: string; control: string; registered: () => string[] } {
  const root = mkdtempSync(join(realpathSync(tmpdir()), `${RMD_TMP_PREFIX}engine-tree-lane-`));
  const fixtureRepo = gitRepo({ kind: "engine-tree-lane-repo" });
  // git registers real paths; macOS reaches tmpdir() through a /private symlink.
  const repo = realpathSync(fixtureRepo.dir);
  const sha = fixtureRepo.git("rev-parse", "HEAD");
  const config = { root: join(root, "rmd-root") } as unknown as Config;
  const state = join(config.root, "state");
  const hash = "a".repeat(64);
  const engine = enginePath(state, hash);
  const building = join(enginesRoot(state), `.build-${hash.slice(0, 12)}-${process.pid}-1`);
  const control = join(root, "manual", "control");
  mkdirSync(enginesRoot(state), { recursive: true });
  mkdirSync(join(root, "manual"), { recursive: true });
  for (const path of [engine, building, control]) fixtureRepo.git("worktree", "add", "--quiet", "--detach", path, "HEAD");
  writeFileSync(join(engine, "engine.json"), JSON.stringify({ sha, sourceHash: hash, builtAt: 1 }));
  for (const path of [engine, building, control]) age(path);
  const registered = (): string[] =>
    fixtureRepo.git("worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
  return { config, repo, engine, building, control, registered };
}


test("W1-T10777: an engine tree registered outside the lane roots is not an unmanaged lane", () => {
  const { config, repo, engine, building, control } = fixture();
  const engineOwned: string[] = [];
  const lanes = unmanagedWorktreeLanes(config, repo, undefined, (path) => engineOwned.push(path));
  assert.deepEqual(lanes, [control], "only the ordinary lane outside every managed root is an unmanaged lane");
  assert.deepEqual(engineOwned.sort(), [engine, building].sort(), "the engine and the .build- sibling are left to the engine owner");
});

test("W1-T10777: an armed ad-hoc reap pass never removes or sizes an engine tree", async () => {
  const { config, repo, engine, building, control, registered } = fixture();
  const sized: string[] = [];
  const lines: Array<[string, Record<string, unknown> | undefined]> = [];
  await runAdhocLaneReapRung(config, (step, fields) => lines.push([step, fields]), {
    repoDir: repo,
    enabled: () => true,
    sizeBytes: (path) => {
      sized.push(path);
      return 0;
    },
  });
  for (const path of [engine, building]) {
    assert.ok(existsSync(path), `${path} stays on disk`);
    assert.ok(registered().includes(path), `${path} stays registered`);
    assert.ok(!sized.includes(path), `${path} is never sized`);
  }
  const row = lines.find(([step]) => step === "adhoc_lane.unmanaged")?.[1];
  assert.ok(row, "the survey still reports the pass");
  assert.equal(row.engine_owned, 2, "the row counts the registrations it left to the engine owner");
  assert.equal(row.dry_run, false);
  assert.ok(sized.includes(control), "the stale control lane is still sized");
  assert.equal(existsSync(control), false, "and still reaped");
  assert.ok(!registered().includes(control), "through its parent, so its registration goes too");
});
