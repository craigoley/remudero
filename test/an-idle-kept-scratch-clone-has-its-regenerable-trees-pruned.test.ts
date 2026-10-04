/**
 * W1-T5547 — a scratch unit W1-T5513 must KEEP (dirty, unbundleable) still loses its regenerable
 * trees. Driven as the real deploy/rmd-host-cleanup.sh against a fixture scratch root: an idle kept
 * clone has its top-level coverage/ and node_modules/ pruned, and nothing else; a fresh, held,
 * mounted or marked unit is never pruned; a symlinked node_modules is never followed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, lutimesSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { age, fixture, git, repos, run, scratchDir, type Fixture } from "./helpers/host-cleanup-fixture.js";

/** A clone under a scratch unit holding source, a dirty file, an ignored state/ and both caches. */
function keptClone(fx: Fixture, main: string, unitName: string) {
  const unit = scratchDir(fx, unitName, false);
  const repo = join(unit, "repo");
  git(fx.root, "clone", "--quiet", main, repo);
  writeFileSync(join(repo, ".git", "info", "exclude"), "node_modules\ncoverage\nstate\n");
  mkdirSync(join(repo, "coverage", "raw"), { recursive: true });
  writeFileSync(join(repo, "coverage", "raw", "coverage-1.json"), "{}\n");
  mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  mkdirSync(join(repo, "state"));
  writeFileSync(join(repo, "state", "ledger.jsonl"), "{}\n");
  return { unit, repo };
}

const scratchOnly = (fx: Fixture) => ({ RMD_CLEANUP_SCRATCH_ROOTS: fx.scratch, RMD_CLEANUP_TMP_ROOTS: "" });

test("test/an-idle-kept-scratch-clone-has-its-regenerable-trees-pruned.test.ts", () => {
  const fx = fixture();
  const { main } = repos(fx);

  // kept for an ignored path beyond node_modules/coverage AND uncommitted changes
  const dirty = keptClone(fx, main, "dirty-unit");
  writeFileSync(join(dirty.repo, "uncommitted.txt"), "not committed\n");
  // kept because its local branch cannot be bundled: the archive shares the scratch filesystem
  const unsaved = keptClone(fx, main, "unsaved-unit");
  rmSync(join(unsaved.repo, "state"), { recursive: true, force: true });
  git(unsaved.repo, "checkout", "-q", "-b", "local-only");
  git(unsaved.repo, "commit", "-q", "--allow-empty", "-m", "never pushed");
  // a symlinked node_modules points outside the unit; it must never be followed
  const linked = keptClone(fx, main, "symlink-unit");
  writeFileSync(join(linked.repo, "uncommitted.txt"), "x\n");
  const outside = join(fx.root, "outside-modules");
  mkdirSync(outside);
  writeFileSync(join(outside, "precious.js"), "keep\n");
  const linkedModules = join(linked.repo, "node_modules");
  rmSync(linkedModules, { recursive: true, force: true });
  symlinkSync(outside, linkedModules);

  // fresh and live units carry the same caches and must keep them
  const fresh = keptClone(fx, main, "fresh-unit");
  writeFileSync(join(fresh.repo, "uncommitted.txt"), "x\n");
  const live = keptClone(fx, main, "live-unit");
  writeFileSync(join(live.repo, "uncommitted.txt"), "x\n");
  for (const u of [dirty, unsaved, linked, live]) age(u.unit);
  // age() follows the link; the link's own mtime is what find -mmin sees, so age it too
  const old = new Date(Date.now() - 13 * 3600_000);
  lutimesSync(linkedModules, old, old);
  writeFileSync(fx.lsofList, `${live.repo}\n`);

  const r = run(fx, { ...scratchOnly(fx), FAKE_ARCHIVE_FSID: "1" });
  assert.equal(r.status, 0, r.stderr + r.stdout);

  for (const u of [dirty, unsaved]) {
    assert.equal(existsSync(u.unit), true, `the unit itself is kept: ${r.stdout}`);
    assert.equal(existsSync(join(u.repo, "coverage")), false, `coverage/ is pruned: ${r.stdout}`);
    assert.equal(existsSync(join(u.repo, "node_modules")), false, `node_modules/ is pruned: ${r.stdout}`);
    assert.ok(r.stdout.includes(`PRUNE ${join(u.repo, "coverage")}: `), r.stdout);
    assert.ok(r.stdout.includes(`PRUNE ${join(u.repo, "node_modules")}: `), r.stdout);
    assert.equal(readFileSync(join(u.repo, "README"), "utf8"), "r\n", "tracked source is untouched");
    assert.equal(existsSync(join(u.unit, "data")), true, "unit payload outside the repo is untouched");
  }
  assert.ok(r.stdout.includes(`KEEP ${dirty.unit}: uncommitted changes (${dirty.repo})`), r.stdout);
  assert.equal(readFileSync(join(dirty.repo, "uncommitted.txt"), "utf8"), "not committed\n");
  assert.equal(readFileSync(join(dirty.repo, "state", "ledger.jsonl"), "utf8"), "{}\n", "unknown ignored data stays");
  assert.ok(r.stdout.includes(`KEEP ${unsaved.unit}: local branches could not be archived safely`), r.stdout);
  assert.match(r.stdout, /pruned 5 regenerable trees from kept scratch units \([1-9][0-9]* bytes\)/);

  assert.equal(lstatSync(linkedModules).isSymbolicLink(), true, "a symlinked node_modules is left alone");
  assert.equal(readFileSync(join(outside, "precious.js"), "utf8"), "keep\n", "its target is never followed");
  assert.ok(r.stdout.includes(`KEEP ${linkedModules}: not a regular directory`), r.stdout);
  assert.equal(existsSync(join(linked.repo, "coverage")), false, "the real coverage/ beside it still goes");

  for (const u of [fresh, live]) {
    assert.equal(existsSync(join(u.repo, "coverage", "raw", "coverage-1.json")), true, r.stdout);
    assert.equal(existsSync(join(u.repo, "node_modules", "pkg", "index.js")), true, r.stdout);
    assert.ok(!r.stdout.includes(`PRUNE ${u.repo}`), r.stdout);
  }
  assert.ok(r.stdout.includes(`KEEP ${fresh.unit}: written within 720 min`), r.stdout);
  assert.ok(r.stdout.includes(`KEEP ${live.unit}: held open by a process`), r.stdout);
});

test("a kept unit's prune is only logged under DRY_RUN=1 and changes nothing", () => {
  const fx = fixture();
  const { main } = repos(fx);
  const dirty = keptClone(fx, main, "dry-unit");
  writeFileSync(join(dirty.repo, "uncommitted.txt"), "x\n");
  age(dirty.unit);
  const r = run(fx, { ...scratchOnly(fx), DRY_RUN: "1" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(r.stdout.includes(`PRUNE ${join(dirty.repo, "coverage")}: `), r.stdout);
  assert.ok(r.stdout.includes(`DRYRUN would: rm -rf -- ${join(dirty.repo, "node_modules")}`), r.stdout);
  assert.equal(existsSync(join(dirty.repo, "coverage", "raw", "coverage-1.json")), true);
  assert.equal(existsSync(join(dirty.repo, "node_modules", "pkg", "index.js")), true);
});

test("a mounted, marked, locked, tracked or bundle-holding kept tree is never pruned", () => {
  const fx = fixture();
  const { main } = repos(fx);
  const mounted = keptClone(fx, main, "mounted-unit");
  const marked = keptClone(fx, main, "marked-unit");
  writeFileSync(join(marked.unit, ".rmd-scratch-keep"), "");
  // coverage/ is TRACKED here: Git does not call it disposable, so it stays
  const tracked = keptClone(fx, main, "tracked-unit");
  writeFileSync(join(tracked.repo, ".git", "info", "exclude"), "node_modules\nstate\n");
  git(tracked.repo, "add", "coverage");
  git(tracked.repo, "commit", "-q", "-m", "tracked coverage");
  writeFileSync(join(tracked.repo, ".git", "info", "exclude"), "node_modules\ncoverage\nstate\n");
  // a loose bundle inside coverage/ is a rescue the bundle archiver reads; it is never pruned
  const bundled = keptClone(fx, main, "bundle-unit");
  git(main, "bundle", "create", join(bundled.repo, "coverage", "rescue.bundle"), "--branches");
  // a locked linked worktree is an explicit hold: the unit and its caches stay
  const lockedUnit = scratchDir(fx, "locked-unit", false);
  const lockedTree = join(lockedUnit, "wt");
  git(main, "worktree", "add", "-q", "-b", "locked", lockedTree, "main");
  git(main, "worktree", "lock", lockedTree);
  writeFileSync(join(main, ".git", "info", "exclude"), "node_modules\ncoverage\n");
  mkdirSync(join(lockedTree, "coverage"));
  writeFileSync(join(lockedTree, "coverage", "lcov.info"), "x\n");
  for (const u of [mounted, marked, tracked, bundled]) {
    writeFileSync(join(u.repo, "uncommitted.txt"), "x\n");
    age(u.unit);
  }
  age(lockedUnit);
  const docker = join(fx.root, "bin", "docker");
  writeFileSync(docker, `#!/usr/bin/env bash\nif [ "$1" = ps ]; then echo container; else printf '%s\\n' '${mounted.unit}'; fi\n`);

  const r = run(fx, { ...scratchOnly(fx), FAKE_ARCHIVE_FSID: "1" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const u of [mounted, marked]) {
    assert.equal(existsSync(join(u.repo, "coverage", "raw", "coverage-1.json")), true, r.stdout);
    assert.equal(existsSync(join(u.repo, "node_modules", "pkg", "index.js")), true, r.stdout);
  }
  assert.ok(r.stdout.includes(`KEEP ${mounted.unit}: running container mount`), r.stdout);
  assert.ok(r.stdout.includes(`KEEP ${marked.unit}: scratch keep marker`), r.stdout);
  assert.equal(existsSync(join(tracked.repo, "coverage", "raw", "coverage-1.json")), true, r.stdout);
  assert.ok(r.stdout.includes(`KEEP ${join(tracked.repo, "coverage")}: Git does not confirm it is ignored and untracked`), r.stdout);
  assert.equal(existsSync(join(tracked.repo, "node_modules")), false, "its ignored node_modules/ still goes");
  assert.equal(existsSync(join(bundled.repo, "coverage", "rescue.bundle")), true, r.stdout);
  assert.ok(r.stdout.includes(`KEEP ${join(bundled.repo, "coverage")}: holds a bundle or repository`), r.stdout);
  assert.equal(existsSync(join(lockedTree, "coverage", "lcov.info")), true, r.stdout);
  assert.ok(r.stdout.includes(`KEEP ${lockedUnit}: Git worktree is locked`), r.stdout);
  assert.ok(!r.stdout.includes(`PRUNE ${lockedTree}`), r.stdout);
});
