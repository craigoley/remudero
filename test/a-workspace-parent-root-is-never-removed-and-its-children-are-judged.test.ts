import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { age, fixture, git, repos, run, scratchDir } from "./helpers/host-cleanup-fixture.js";

test("test/a-workspace-parent-root-is-never-removed-and-its-children-are-judged.test.ts", () => {
  const fx = fixture();
  const parent = join(fx.scratch, "o");
  const idle = join(parent, "idle");
  const fresh = join(parent, "fresh");
  const kept = join(parent, "kept");
  for (const p of [idle, fresh, kept]) { mkdirSync(p, { recursive: true }); writeFileSync(join(p, "data"), "x"); }
  writeFileSync(join(kept, ".rmd-scratch-keep"), "");
  const allIdle = join(fx.scratch, "all-idle-parent");
  mkdirSync(join(allIdle, "child"), { recursive: true });
  writeFileSync(join(allIdle, "child", "data"), "x");
  age(allIdle);
  age(parent);
  writeFileSync(join(fresh, "new"), "fresh");
  const r = run(fx, { RMD_CLEANUP_SCRATCH_ROOTS: fx.scratch, RMD_CLEANUP_SCRATCH_PARENTS: `${parent}:${allIdle}`, RMD_CLEANUP_TMP_ROOTS: "" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(parent), true);
  assert.equal(existsSync(allIdle), true, "even a wholly idle parent survives");
  assert.equal(existsSync(join(allIdle, "child")), false, r.stdout);
  assert.equal(existsSync(idle), false, r.stdout);
  assert.equal(existsSync(fresh), true);
  assert.equal(existsSync(kept), true);
  assert.ok(r.stdout.includes(`KEEP ${parent}: workspace parent root`), r.stdout);
  assert.ok(r.stdout.includes(`REMOVE ${idle}`), r.stdout);
  assert.ok(r.stdout.includes(`KEEP ${fresh}: written within 720 min`), r.stdout);
  assert.ok(r.stdout.includes(`KEEP ${kept}: scratch keep marker`), r.stdout);
});

test("live linked worktrees use git removal; orphaned ones require their parent to be gone", () => {
  const fx = fixture();
  const { main } = repos(fx);
  const live = join(fx.scratch, "live-linked");
  git(main, "worktree", "add", "-b", "live", live, "main");
  const locked = join(fx.scratch, "locked-linked");
  git(main, "worktree", "add", "-b", "locked", locked, "main");
  git(main, "worktree", "lock", locked);
  const missingRegistration = scratchDir(fx, "missing-registration", false);
  writeFileSync(join(missingRegistration, ".git"), `gitdir: ${join(main, ".git", "worktrees", "missing")}\n`);
  const orphan = scratchDir(fx, "orphan", false);
  const goneParent = join(fx.root, "gone");
  writeFileSync(join(orphan, ".git"), `gitdir: ${goneParent}/.git/worktrees/orphan\n`);
  rmSync(goneParent, { recursive: true, force: true });
  for (const p of [live, locked, missingRegistration, orphan]) age(p);
  const r = run(fx, { RMD_CLEANUP_SCRATCH_ROOTS: fx.scratch, RMD_CLEANUP_TMP_ROOTS: "" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(live), false, r.stdout);
  assert.ok(!git(main, "worktree", "list", "--porcelain").includes(live), "Git registration is removed too");
  assert.equal(existsSync(locked), true);
  assert.equal(existsSync(missingRegistration), true);
  assert.equal(existsSync(orphan), false, r.stdout);
  assert.match(r.stdout, /Git worktree is locked/);
  assert.match(r.stdout, /Git metadata is unreadable/);
});
