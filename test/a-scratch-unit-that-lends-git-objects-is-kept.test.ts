/**
 * W1-T5634 — the W1-T5513 scratch sweep removed an idle, saved unit without asking whether another
 * unit's objects/info/alternates points into it, and the borrower's HEAD became unreadable (the host's
 * /mnt/scratch/g and h, whose lender remudero-preflight-W1-T4884-* vanished). Driven as the real
 * deploy/rmd-host-cleanup.sh against fixture roots only (RMD_CLEANUP_SCRATCH_ROOTS / _PARENTS under an
 * RMD_TMP_PREFIX temp dir); nothing here reads /mnt or /etc, and nothing depends on uid 0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { age, fixture, git, repos, run, scratchDir, type Fixture } from "./helpers/host-cleanup-fixture.js";

/** A saved, clean clone of the fixture's published main at <unit>/repo. */
function cloneUnit(fx: Fixture, main: string, name: string, parent = fx.scratch) {
  const unit = join(parent, name);
  mkdirSync(unit, { recursive: true });
  const repo = join(unit, "repo");
  git(fx.root, "clone", "--quiet", main, repo);
  return { unit, repo };
}

/** A clone of `lender` that borrows its objects through alternates, which then reads `alternates`. */
function borrowerUnit(fx: Fixture, lender: string, name: string, alternates: string, parent = fx.scratch) {
  const unit = join(parent, name);
  mkdirSync(unit, { recursive: true });
  const repo = join(unit, "repo");
  git(fx.root, "clone", "--quiet", "--shared", lender, repo);
  writeFileSync(join(repo, ".git", "objects", "info", "alternates"), `${alternates}\n`);
  return { unit, repo };
}

function headType(repo: string): string | null {
  const r = spawnSync("git", ["-C", repo, "cat-file", "-t", "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

const scratchOnly = (fx: Fixture, parents = "") => ({
  RMD_CLEANUP_SCRATCH_ROOTS: fx.scratch, RMD_CLEANUP_SCRATCH_PARENTS: parents, RMD_CLEANUP_TMP_ROOTS: "",
});

test("test/a-scratch-unit-that-lends-git-objects-is-kept.test.ts", () => {
  const fx = fixture();
  const { main } = repos(fx);
  const parent = join(fx.scratch, "o");

  // the host's shape: m/repo lends to o/repo (a child of the o parent root), and to n/repo by a
  // relative alternates line; both borrowers are themselves kept (held open, freshly written)
  const lender = cloneUnit(fx, main, "m");
  const lenderObjects = join(lender.repo, ".git", "objects");
  const held = borrowerUnit(fx, lender.repo, "repo", lenderObjects, parent);
  const relative = borrowerUnit(fx, lender.repo, "n", "../../../../m/repo/.git/objects");
  // g/repo borrows from a store that is already gone
  const gone = cloneUnit(fx, main, "gone");
  const missingTarget = join(gone.repo, ".git", "objects");
  const broken = borrowerUnit(fx, gone.repo, "g", missingTarget);
  rmSync(gone.unit, { recursive: true, force: true });
  // the positive control: an idle, saved unit nothing borrows from is still removed
  const plain = cloneUnit(fx, main, "plain");

  for (const u of [lender, held, broken, plain]) age(u.unit);
  age(parent);
  writeFileSync(fx.lsofList, `${held.repo}\n`);
  assert.equal(headType(held.repo), "commit", "the fixture's borrower reads HEAD before the pass");
  assert.equal(headType(broken.repo), null, "the fixture's orphan cannot read HEAD at all");

  const r = run(fx, scratchOnly(fx, parent));
  assert.equal(r.status, 0, r.stderr + r.stdout);

  assert.equal(existsSync(lender.repo), true, `the lender is kept: ${r.stdout}`);
  assert.ok(r.stdout.includes(`KEEP ${lender.unit}: lends objects to `), r.stdout);
  assert.ok(r.stdout.includes(held.repo), `the absolute borrower is named: ${r.stdout}`);
  assert.ok(r.stdout.includes(relative.repo), `the relative borrower is named: ${r.stdout}`);
  assert.ok(!r.stdout.includes(`REMOVE ${lender.unit}`), r.stdout);
  assert.equal(headType(held.repo), "commit", "the borrower still reads HEAD after the pass");
  assert.equal(headType(relative.repo), "commit", "the relative borrower still reads HEAD too");
  assert.ok(r.stdout.includes(`KEEP ${held.unit}: held open by a process`), r.stdout);
  assert.ok(r.stdout.includes(`KEEP ${relative.unit}: written within 720 min`), r.stdout);

  assert.ok(r.stdout.includes(`KEEP ${broken.unit}: borrows from missing ${missingTarget}`), r.stdout);
  assert.equal(existsSync(broken.repo), true, "the orphaned borrower is kept for an operator");

  assert.ok(r.stdout.includes(`REMOVE ${plain.unit}`), r.stdout);
  assert.equal(existsSync(plain.unit), false, "a unit nobody borrows from still goes");
});

test("a borrower that was removed earlier in the pass no longer holds its lender", () => {
  const fx = fixture();
  const { main } = repos(fx);
  // b sorts before l, so the idle, saved borrower is judged (and removed) first
  const lender = cloneUnit(fx, main, "l");
  const borrower = borrowerUnit(fx, lender.repo, "b", join(lender.repo, ".git", "objects"));
  for (const u of [lender, borrower]) age(u.unit);
  const r = run(fx, scratchOnly(fx));
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(r.stdout.includes(`REMOVE ${borrower.unit}`), r.stdout);
  assert.ok(r.stdout.includes(`REMOVE ${lender.unit}`), r.stdout);
  assert.equal(existsSync(lender.unit), false, r.stdout);
});

test("the lender scan reads only inside the configured roots and never follows a link out", () => {
  const fx = fixture();
  const { main } = repos(fx);
  const lender = cloneUnit(fx, main, "x");
  // a borrower outside every configured root, reachable only through a symlink inside one
  const outside = join(fx.root, "outside");
  mkdirSync(outside);
  borrowerUnit(fx, lender.repo, "far", join(lender.repo, ".git", "objects"), outside);
  symlinkSync(outside, join(fx.scratch, "link"));
  age(lender.unit);
  const r = run(fx, scratchOnly(fx));
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(r.stdout.includes(`KEEP ${join(fx.scratch, "link")}: symbolic link`), r.stdout);
  assert.ok(!r.stdout.includes("lends objects"), r.stdout);
  assert.ok(r.stdout.includes(`REMOVE ${lender.unit}`), r.stdout);
});

test("a failed lender scan keeps every unit it could not clear, naming the unknown", () => {
  const fx = fixture();
  const { main } = repos(fx);
  const unit = cloneUnit(fx, main, "y");
  age(unit.unit);
  // a find that fails only for the alternates scan; every other walk is the real one
  const bin = join(fx.root, "failbin");
  mkdirSync(bin);
  const real = spawnSync("bash", ["-c", "command -v find"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(bin, "find"), `#!/usr/bin/env bash\ncase "$*" in *alternates*) exit 1 ;; esac\nexec ${real} "$@"\n`);
  chmodSync(join(bin, "find"), 0o755);
  const r = run(fx, { ...scratchOnly(fx), PATH: `${bin}:${process.env.PATH ?? ""}` });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(r.stdout.includes(`KEEP ${unit.unit}: alternates scan failed (unknown)`), r.stdout);
  assert.equal(existsSync(unit.repo), true, r.stdout);
});
