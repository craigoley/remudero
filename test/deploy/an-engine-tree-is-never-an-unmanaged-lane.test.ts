import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "#src/lib/config.js";
import { enginePath, enginesRoot } from "#src/lib/engine-tree.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ADHOC_LANE_REAP_GRACE_MS, reapStaleWorktreesAsync, runAdhocLaneReapRung, unmanagedWorktreeLanes } from "#src/lib/worker.js";
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

/** Which directory on the way to `<config.root>/state/engines` is a symlink; "none" is the canonical layout. */
type Link = "none" | "root" | "state" | "engines" | "lanes-engines";
const LINKS: readonly Link[] = ["none", "root", "state", "engines", "lanes-engines"];

/** Makes `at` a symlink to a new real directory beside it, or a plain directory when `link` names another level. */
function dir(at: string, link: Link, level: Link): void {
  if (link !== level) return void mkdirSync(at, { recursive: true });
  const real = `${at}-real`;
  mkdirSync(real, { recursive: true });
  symlinkSync(real, at);
}

/** A real repo with a published engine, an in-flight `.build-` sibling and an ordinary lane outside every root. With a
 * `link`, config.root keeps the symlinked spelling while git registers each tree under its real path. */
function fixture(link: Link = "none"): {
  config: Config;
  repo: string;
  engine: string;
  building: string;
  control: string;
  staleInEngineRoot?: string;
  registered: () => string[];
} {
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
  const staleInEngineRoot = link === "lanes-engines" ? join(enginesRoot(state), "stale-lane-registration") : undefined;
  dir(config.root, link, "root");
  dir(state, link, "state");
  dir(enginesRoot(state), link, "engines");
  if (staleInEngineRoot) symlinkSync(enginesRoot(state), join(config.root, "lanes"));
  mkdirSync(join(root, "manual"), { recursive: true });
  for (const path of [engine, building, control, ...(staleInEngineRoot ? [staleInEngineRoot] : [])]) {
    fixtureRepo.git("worktree", "add", "--quiet", "--detach", path, "HEAD");
  }
  writeFileSync(join(engine, "engine.json"), JSON.stringify({ sha, sourceHash: hash, builtAt: 1 }));
  for (const path of [engine, building, control, ...(staleInEngineRoot ? [staleInEngineRoot] : [])]) age(path);
  if (link !== "none" && link !== "lanes-engines") {
    assert.notEqual(realpathSync(engine), engine, "the fixture reaches the engine through a symlink");
  }
  const registered = (): string[] =>
    fixtureRepo.git("worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
  return { config, repo, engine: realpathSync(engine), building: realpathSync(building), control,
    ...(staleInEngineRoot ? { staleInEngineRoot: realpathSync(staleInEngineRoot) } : {}), registered };
}


test("W1-T10777: an engine tree registered outside the lane roots is not an unmanaged lane", () => {
  for (const link of LINKS) {
    const { config, repo, engine, building, control, staleInEngineRoot } = fixture(link);
    const engineOwned: string[] = [];
    const lanes = unmanagedWorktreeLanes(config, repo, undefined, (path) => engineOwned.push(path));
    assert.deepEqual(lanes.sort(), [control, ...(staleInEngineRoot ? [staleInEngineRoot] : [])].sort(),
      `${link} link: non-engine lanes remain in the census, including a stale registration under an aliased engine root`);
    assert.deepEqual(engineOwned.sort(), [engine, building].sort(), `${link} link: the engine trees are left to the engine owner`);
    rmSync(building, { recursive: true, force: true });
    const goneOwned: string[] = [];
    const afterGone = unmanagedWorktreeLanes(config, repo, undefined, (path) => goneOwned.push(path));
    assert.deepEqual(afterGone.sort(), [control, ...(staleInEngineRoot ? [staleInEngineRoot] : [])].sort(),
      `${link} link: a gone engine tree stays owned while the stale non-engine registration stays reapable`);
    assert.ok(goneOwned.includes(building), `${link} link: the gone .build- sibling stays with the engine owner`);
  }
});

test("W1-T10777: an armed ad-hoc reap pass never removes or sizes an engine tree", async () => {
  for (const link of LINKS) {
    const { config, repo, engine, building, control, staleInEngineRoot, registered } = fixture(link);
    const sized: string[] = [];
    const lines: Array<[string, Record<string, unknown> | undefined]> = [];
    await runAdhocLaneReapRung(config, (step, fields) => lines.push([step, fields]), {
      repoDir: repo,
      enabled: () => true,
      // W1-T15026: the real reaper, told nobody works in the fixtures instead of reading the host's `/proc`.
      reap: (root, opts) => reapStaleWorktreesAsync(root, { ...opts, cwdCensus: () => ({ state: "clear", scanned: 0 }) }),
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
    if (staleInEngineRoot) {
      assert.ok(sized.includes(staleInEngineRoot), "the stale non-engine registration inside the aliased root still reaches the reaper");
      assert.equal(existsSync(staleInEngineRoot), false, "and is reaped from the engine-root alias");
      assert.ok(!registered().includes(staleInEngineRoot), "its registration is removed too");
      assert.ok(lines.some(([step, fields]) => step === "adhoc_lane.reap.root_skipped" && fields?.reason === "overlaps-engine-store"),
        "the direct root sweep is skipped before it can enumerate the engine trees");
    }
  }
});
