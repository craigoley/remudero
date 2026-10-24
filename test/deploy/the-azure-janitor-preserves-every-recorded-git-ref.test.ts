import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { age, git, run } from "#test/helpers/host-cleanup-fixture.js";
import { cloneAt, commitFile, phaseFixture, type PhaseFixture } from "#test/helpers/host-cleanup-phases.js";

function setup() {
  const fx = phaseFixture();
  const roots = join(fx.root, "units");
  mkdirSync(roots);
  return { fx, roots, repo: cloneAt(fx, join(roots, "idle")) };
}
function pass(fx: PhaseFixture, roots: string, extra: Record<string, string> = {}) {
  return run(fx, { ...fx.env, RMD_CLEANUP_PRESERVE_ROOTS: roots, RMD_CLEANUP_DUMP_ROOTS: "", ...extra });
}
function copy(fx: PhaseFixture, repo: string) {
  const stem = repo.replace(/^\//, "").replace(/\//g, "__") + "@";
  const found = readdirSync(fx.preserved).filter(n => n.startsWith(stem));
  assert.equal(found.length, 1);
  return join(fx.preserved, found[0]);
}
function privateCommit(repo: string, ref: string) {
  const published = git(repo, "rev-parse", "HEAD").trim();
  commitFile(repo, "checkpoint.txt", ref + "\n", ref);
  const oid = git(repo, "rev-parse", "HEAD").trim();
  git(repo, "update-ref", ref, oid);
  git(repo, "reset", "--hard", published);
  return oid;
}
function restore(fx: PhaseFixture, saved: string) {
  const repo = join(fx.root, "independent-restore");
  git(fx.root, "clone", "--quiet", fx.origin, repo);
  git(repo, "bundle", "verify", join(saved, "unpublished.bundle"));
  git(repo, "bundle", "unbundle", join(saved, "unpublished.bundle"));
  for (const line of readFileSync(join(saved, "refs.txt"), "utf8").trim().split("\n")) {
    const [oid, ref] = line.split(" ");
    git(repo, "cat-file", "-e", oid + "^{object}");
    git(repo, "update-ref", ref, oid);
  }
  git(repo, "fsck", "--full", "--no-dangling");
  return repo;
}

test("the Azure preservation bundle restores private checkpoint and cached remote refs from the recorded ref list", () => {
  const { fx, roots, repo } = setup();
  try {
    const checkpoint = privateCommit(repo, "refs/rmd-checkpoints/operator-proof");
    const remote = privateCommit(repo, "refs/remotes/retired-provider/private");
    age(repo, 13);
    const result = pass(fx, roots);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(existsSync(repo), false, result.stdout);
    const restored = restore(fx, copy(fx, repo));
    assert.equal(git(restored, "show", checkpoint + ":checkpoint.txt"), "refs/rmd-checkpoints/operator-proof\n");
    assert.equal(git(restored, "rev-parse", "refs/remotes/retired-provider/private").trim(), remote);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("the Azure preservation bundle includes a private blob ref when no unpublished commit exists", () => {
  const { fx, roots, repo } = setup();
  try {
    const data = join(fx.root, "private-blob");
    writeFileSync(data, "operator evidence without a commit\n");
    const oid = git(repo, "hash-object", "-w", data).trim();
    git(repo, "update-ref", "refs/rmd-operator/evidence", oid);
    age(repo, 13);
    const result = pass(fx, roots);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(existsSync(repo), false, result.stdout);
    const saved = copy(fx, repo);
    assert.match(readFileSync(join(saved, "MANIFEST.txt"), "utf8"), /commits not on a published remote: 0\n/);
    assert.equal(git(restore(fx, saved), "cat-file", "blob", oid), "operator evidence without a commit\n");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("the Azure janitor keeps an idle checkout if a private ref moves after preservation", () => {
  const { fx, roots, repo } = setup();
  try {
    privateCommit(repo, "refs/rmd-checkpoints/moving");
    const published = git(repo, "rev-parse", "HEAD").trim();
    const probe = join(fx.root, "move-ref-probe");
    writeFileSync(probe, `#!/usr/bin/env bash\nfor manifest in '${fx.preserved}'/*/MANIFEST.txt; do\n  [ -f "$manifest" ] || continue\n  git -C '${repo}' update-ref refs/rmd-checkpoints/moving '${published}' || exit 2\ndone\nexit 0\n`);
    chmodSync(probe, 0o755);
    age(repo, 13);
    const result = pass(fx, roots, { RMD_CLEANUP_LSOF: probe });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(existsSync(repo), true, result.stdout);
    assert.match(result.stdout, /Git refs moved or became unreadable before retire/);
    assert.ok(existsSync(join(copy(fx, repo), "unpublished.bundle")));
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});
