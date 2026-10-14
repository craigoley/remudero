/**
 * W1-T8861 — sweep_worktree judged a standalone clone saved by its HEAD alone, so a live pass rm -rf'd
 * a clone that was the git dir of 33 linked worktrees and held a local-only branch, and left no trace in
 * any log. Driven as the real deploy/rmd-host-cleanup.sh against fixture clones under a worktree root:
 * a clone that hosts a live linked worktree is kept; an unpushed branch or tag is bundled to another
 * filesystem first, or the clone is kept; and every removal is appended to the durable audit log.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { age, fixture, git, repos, run, type Fixture } from "./helpers/host-cleanup-fixture.js";

/** A clone of the fixture origin at `<root>/<name>`; the fixture's fsid stub puts scratch on its own fs. */
function clone(fx: Fixture, root: string, name: string): string {
  mkdirSync(root, { recursive: true });
  const p = join(root, name);
  git(root, "clone", "--quiet", join(fx.root, "origin.git"), p);
  return p;
}

function auditLog(fx: Fixture): string {
  return join(fx.home, ".local", "state", "remudero", "janitor-audit.log");
}

function bundles(fx: Fixture): string[] {
  const dir = fx.env.RMD_CLEANUP_WORKTREE_ARCHIVE_ROOT;
  return existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith(".bundle")) : [];
}

test("W1-T8861: the janitor never removes a clone that hosts worktrees or unsaved refs", () => {
  const fx = fixture();
  repos(fx);
  const clones = join(fx.scratch, "clones");

  const plain = clone(fx, clones, "plain");
  const hosting = clone(fx, clones, "hosting");
  const linked = join(fx.root, "elsewhere", "linked");
  mkdirSync(join(fx.root, "elsewhere"));
  git(hosting, "worktree", "add", "-b", "hosted", linked, "origin/main");
  const stale = clone(fx, clones, "stale");
  const gone = join(fx.root, "elsewhere", "gone");
  git(stale, "worktree", "add", "-b", "gone", gone, "origin/main");
  rmSync(gone, { recursive: true, force: true });
  const sideBranch = clone(fx, clones, "side-branch");
  git(sideBranch, "branch", "keep/local-only");
  git(sideBranch, "checkout", "-q", "keep/local-only");
  git(sideBranch, "commit", "-q", "--allow-empty", "-m", "never pushed");
  const unpushed = git(sideBranch, "rev-parse", "HEAD").trim();
  git(sideBranch, "checkout", "-q", "main");
  const tagged = clone(fx, clones, "tagged");
  git(tagged, "commit", "-q", "--allow-empty", "-m", "tagged only");
  git(tagged, "tag", "local-tag");
  git(tagged, "reset", "-q", "--hard", "origin/main");
  const taggedTip = git(tagged, "rev-parse", "local-tag").trim();
  for (const p of [plain, hosting, stale, sideBranch, tagged]) age(p);

  const r = run(fx, { RMD_CLEANUP_WORKTREE_ROOTS: clones });
  assert.equal(r.status, 0, r.stderr + r.stdout);

  // an otherwise identical clone with nothing to lose is removed
  assert.equal(existsSync(plain), false, r.stdout);
  assert.match(r.stdout, new RegExp(`REMOVE ${plain} \\(standalone clone\\)`));

  // a clone that hosts a live linked worktree is kept, and the worktree still works
  assert.equal(existsSync(hosting), true, r.stdout);
  assert.match(r.stdout, new RegExp(`KEEP ${hosting}: hosts linked worktree ${linked}`));
  assert.equal(git(linked, "rev-parse", "--is-inside-work-tree").trim(), "true");

  // a linked worktree whose directory is gone no longer holds the clone
  assert.equal(existsSync(stale), false, r.stdout);

  // an unpushed branch and an unpushed tag are bundled before the clone goes
  assert.equal(existsSync(sideBranch), false, r.stdout);
  assert.equal(existsSync(tagged), false, r.stdout);
  const names = bundles(fx);
  assert.equal(names.length, 2, r.stdout);
  const heads = names.map(n => git(fx.root, "bundle", "list-heads", join(fx.env.RMD_CLEANUP_WORKTREE_ARCHIVE_ROOT, n))).join("\n");
  assert.ok(heads.includes(`${unpushed} refs/heads/keep/local-only`), heads);
  assert.ok(heads.includes(`${taggedTip} refs/tags/local-tag`), heads);

  // every removal is on the durable audit log, whatever stdout did
  const audit = readFileSync(auditLog(fx), "utf8");
  for (const p of [plain, stale, sideBranch, tagged]) {
    assert.match(audit, new RegExp(`^\\S+Z uid=\\d+ dry_run=0 pid=\\d+ REMOVE ${p} \\(standalone clone\\)$`, "m"), audit);
  }
  assert.doesNotMatch(audit, new RegExp(`REMOVE ${hosting}`));
  assert.match(audit, /ARCHIVE-WORKTREE .*side-branch/);
});

test("W1-T8861: a clone with an unpushed ref that cannot be bundled off its filesystem is kept", () => {
  const fx = fixture();
  repos(fx);
  const clones = join(fx.scratch, "clones");
  const risky = clone(fx, clones, "risky");
  git(risky, "branch", "keep/local-only");
  git(risky, "checkout", "-q", "keep/local-only");
  git(risky, "commit", "-q", "--allow-empty", "-m", "never pushed");
  git(risky, "checkout", "-q", "main");
  age(risky);

  // the archive shares the clone's filesystem, so a bundle there would die with the disk
  const r = run(fx, { RMD_CLEANUP_WORKTREE_ROOTS: clones, FAKE_ARCHIVE_FSID: "1" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(risky), true, r.stdout);
  assert.match(r.stdout, new RegExp(`KEEP ${risky}: unsaved refs \\(refs/heads/keep/local-only HEAD\\) could not be archived safely`));
  assert.deepEqual(bundles(fx), []);
  assert.equal(existsSync(auditLog(fx)) ? readFileSync(auditLog(fx), "utf8").includes(`REMOVE ${risky}`) : false, false);
});

test("W1-T8861: an unwritable audit log keeps the clone instead of removing it silently", () => {
  const fx = fixture();
  repos(fx);
  const clones = join(fx.scratch, "clones");
  const plain = clone(fx, clones, "plain");
  age(plain);
  // the log's parent is a regular file, so it can be neither created nor appended to
  const blocker = join(fx.root, "blocker");
  writeFileSync(blocker, "x");

  const r = run(fx, { RMD_CLEANUP_WORKTREE_ROOTS: clones, RMD_CLEANUP_AUDIT_LOG: join(blocker, "audit.log") });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(plain), true, r.stdout);
  assert.match(r.stdout, new RegExp(`KEEP ${plain}: audit log unwritable`));
});

test("W1-T8861: a dry run records its decision on the audit log and removes nothing", () => {
  const fx = fixture();
  repos(fx);
  const clones = join(fx.scratch, "clones");
  const plain = clone(fx, clones, "plain");
  age(plain);

  const r = run(fx, { RMD_CLEANUP_WORKTREE_ROOTS: clones, DRY_RUN: "1" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(existsSync(plain), true, r.stdout);
  assert.match(readFileSync(auditLog(fx), "utf8"), new RegExp(` dry_run=1 pid=\\d+ REMOVE ${plain} \\(standalone clone\\)`));
});
