import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { age, fixture, git, repos, run, scratchDir } from "./helpers/host-cleanup-fixture.js";

test("test/a-scratch-workspace-holding-unpushed-commits-is-bundled-before-removal.test.ts", () => {
  const fx = fixture();
  const { main } = repos(fx);
  const unit = scratchDir(fx, "gate", false);
  const repo = join(unit, "repo");
  git(fx.root, "clone", main, repo);
  git(repo, "checkout", "-b", "unpublished");
  git(repo, "commit", "--allow-empty", "-m", "local branch only");
  const unpublished = git(repo, "rev-parse", "HEAD").trim();
  git(repo, "checkout", "main");
  const topBundle = join(fx.scratch, "saved.bundle");
  git(repo, "bundle", "create", topBundle, "--branches");
  const original = readFileSync(topBundle);
  age(unit); age(topBundle);
  const r = run(fx, { RMD_CLEANUP_SCRATCH_ROOTS: fx.scratch, RMD_CLEANUP_TMP_ROOTS: "" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(unit), false, r.stdout);
  assert.equal(existsSync(topBundle), false, r.stdout);
  const archive = join(fx.env.RMD_CLEANUP_WORKTREE_ARCHIVE_ROOT, "scratch");
  const files = readdirSync(archive).filter(p => p.endsWith(".bundle"));
  assert.equal(files.length, 2, r.stdout);
  for (const name of files) {
    const bundle = join(archive, name);
    git(main, "bundle", "verify", bundle);
    assert.ok(git(main, "bundle", "list-heads", bundle).includes(`${unpublished} refs/heads/unpublished`));
  }
  assert.ok(files.some(name => readFileSync(join(archive, name)).equals(original)), "top-level bundle is preserved byte for byte");
  assert.ok(r.stdout.indexOf("ARCHIVE-WORKTREE") < r.stdout.indexOf(`REMOVE ${unit}`), r.stdout);
});

test("unverifiable bundles and same-filesystem archives keep the scratch workspace", () => {
  for (const failure of ["verify", "list-heads", "filesystem"]) {
    const fx = fixture();
    const { main } = repos(fx);
    const unit = scratchDir(fx, "gate", false);
    const repo = join(unit, "repo");
    git(fx.root, "clone", main, repo);
    git(repo, "checkout", "-b", "unpublished");
    git(repo, "commit", "--allow-empty", "-m", "unsaved");
    git(repo, "checkout", "main");
    age(unit);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const shim = join(fx.root, "bin", "git");
    writeFileSync(shim, `#!/usr/bin/env bash\nif [[ "$*" = *"bundle ${failure}"* ]]; then exit 29; fi\nexec '${realGit}' "$@"\n`);
    chmodSync(shim, 0o755);
    const r = run(fx, { RMD_CLEANUP_SCRATCH_ROOTS: fx.scratch, RMD_CLEANUP_TMP_ROOTS: "", PATH: `${join(fx.root, "bin")}:${process.env.PATH}`, ...(failure === "filesystem" ? { FAKE_ARCHIVE_FSID: "1" } : {}) });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(existsSync(unit), true, r.stdout);
    assert.match(r.stdout, /could not be archived safely/);
    const archive = join(fx.env.RMD_CLEANUP_WORKTREE_ARCHIVE_ROOT, "scratch");
    if (existsSync(archive)) assert.deepEqual(readdirSync(archive), []);
  }
});

test("scratch dry run never writes an archive for unpublished branches or loose bundles", () => {
  const fx = fixture();
  const { main } = repos(fx);
  const unit = scratchDir(fx, "gate", false);
  git(fx.root, "clone", main, join(unit, "repo"));
  git(join(unit, "repo"), "commit", "--allow-empty", "-m", "local");
  const bundle = join(unit, "old.bundle");
  git(main, "bundle", "create", bundle, "--branches");
  age(unit);
  const r = run(fx, { RMD_CLEANUP_SCRATCH_ROOTS: fx.scratch, RMD_CLEANUP_TMP_ROOTS: "", DRY_RUN: "1" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(unit), true);
  assert.equal(existsSync(bundle), true);
  assert.equal(existsSync(fx.env.RMD_CLEANUP_WORKTREE_ARCHIVE_ROOT), false);
  assert.match(r.stdout, /ARCHIVE-WORKTREE/);
  assert.ok(r.stdout.includes(`ARCHIVE ${bundle}`), r.stdout);
});

test("a loose bundle inside ignored coverage is archived before removing its linked worktree", () => {
  const fx = fixture();
  const { main } = repos(fx);
  const linked = join(fx.scratch, "linked");
  git(main, "worktree", "add", "-b", "linked", linked, "main");
  writeFileSync(join(main, ".git", "info", "exclude"), "coverage\n");
  mkdirSync(join(linked, "coverage"));
  const bundle = join(linked, "coverage", "rescue.bundle");
  git(main, "bundle", "create", bundle, "--branches");
  const original = readFileSync(bundle);
  age(linked);
  const r = run(fx, { RMD_CLEANUP_SCRATCH_ROOTS: fx.scratch, RMD_CLEANUP_TMP_ROOTS: "" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(linked), false, r.stdout);
  const archive = join(fx.env.RMD_CLEANUP_WORKTREE_ARCHIVE_ROOT, "scratch");
  assert.ok(readdirSync(archive).some(name => readFileSync(join(archive, name)).equals(original)));
  assert.ok(r.stdout.indexOf(`ARCHIVE ${bundle}`) < r.stdout.indexOf(`REMOVE ${linked}`), r.stdout);
});
