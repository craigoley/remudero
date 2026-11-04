import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { compressionPinBase } from "#test/helpers/compression-pin.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "#test/helpers/git-repo.js";

// W1-T11312: the reviewer's proof-discrimination base run copies a PR's ADDED test files into a detached
// merge-base worktree (src/lib/check-proof.ts buildBaseProofDir, W1-T3190), where they are untracked. There
// compressionPinBase's added-diff (`<merge-base>...HEAD`) is empty, so it returned undefined and a pin whose
// reductions sit behind `before === undefined` passed at base: #16652 (W1-T11190) spent six fix rounds on it.

const MODULE = "src/lib/module.ts";
const PIN = "test/compress-src-lib-module-ts.test.ts";
const UNCOMPRESSED = "// one\n// two\n// three\n// four\nexport const value = 1;\n";
const COMPRESSED = "// one, two, three and four\nexport const value = 1;\n";

const commentLines = (source: string) => source.split("\n").filter((line) => line.startsWith("//")).length;

/** A pin written the way the gardener template mints it: every reduction behind the guard. */
function pinOutcome(checkout: string): "inert" | "pass" | "fail" {
  const before = compressionPinBase(MODULE, pathToFileURL(join(checkout, PIN)).href, checkout);
  if (before === undefined) return "inert";
  const actual = readFileSync(join(checkout, MODULE), "utf8");
  return commentLines(actual) < commentLines(before) ? "pass" : "fail";
}

function write(dir: string, path: string, content: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

/** origin/main at the uncompressed base; a PR branch that compresses the module and ADDS the pin. */
function fixture(t: TestContext) {
  const origin = gitRepo({ bare: true });
  const repo = gitRepo();
  t.after(() => { repo.cleanup(); origin.cleanup(); });
  repo.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  repo.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  repo.addRemote("origin", origin.dir);
  write(repo.dir, MODULE, UNCOMPRESSED);
  repo.git("add", MODULE);
  repo.git("commit", "-qm", "chore(test): seed the module");
  const baseSha = repo.git("rev-parse", "HEAD").trim();
  repo.git("push", "-q", "origin", "main");
  repo.git("fetch", "-q", "origin");
  repo.git("checkout", "-qb", "compress");
  write(repo.dir, MODULE, COMPRESSED);
  write(repo.dir, PIN, "// the pin under test\n");
  repo.git("add", MODULE, PIN);
  repo.git("commit", "-qm", "refactor(test): compress the module and add its pin");
  return { repo, baseSha };
}

/** The reviewer's base run: a detached merge-base worktree with the PR's added pin copied in, untracked. */
function baseRun(t: TestContext, repo: ReturnType<typeof gitRepo>, baseSha: string): string {
  const holder = mkdtempSync(join(tmpdir(), "rmd-untracked-pin-base-"));
  t.after(() => { rmSync(holder, { recursive: true, force: true }); });
  const worktree = join(holder, "base");
  repo.git("worktree", "add", "--detach", worktree, baseSha);
  t.after(() => { spawnSync("git", ["-C", repo.dir, "worktree", "remove", "--force", worktree]); });
  mkdirSync(dirname(join(worktree, PIN)), { recursive: true });
  copyFileSync(join(repo.dir, PIN), join(worktree, PIN));
  return worktree;
}

test("an untracked compression pin compares against HEAD, so a guarded pin fails in the reviewer's base run", (t) => {
  const { repo, baseSha } = fixture(t);
  const base = baseRun(t, repo, baseSha);
  // Positive controls: the copied pin really is untracked there, and the base holds the uncompressed module.
  assert.notEqual(spawnSync("git", ["-C", base, "ls-files", "--error-unmatch", "--", PIN]).status, 0, "the copied pin is untracked");
  assert.equal(readFileSync(join(base, MODULE), "utf8"), UNCOMPRESSED);
  assert.equal(compressionPinBase(MODULE, pathToFileURL(join(base, PIN)).href, base), UNCOMPRESSED,
    "an untracked pin compares against HEAD's committed module");
  assert.equal(pinOutcome(base), "fail", "no reduction at base: the guarded pin must fail, not pass vacuously");
});

test("W1-T11312 criterion 2: the guarded pin fails untracked at base, passes at the compression commit, and is inert once tracked later", (t) => {
  const { repo, baseSha } = fixture(t);
  assert.equal(pinOutcome(baseRun(t, repo, baseSha)), "fail", "base run: untracked pin compares and fails");

  // The PR head: the pin is tracked and ADDED by the diff from origin/main, so it compares against the merge-base.
  assert.equal(compressionPinBase(MODULE, pathToFileURL(join(repo.dir, PIN)).href, repo.dir), UNCOMPRESSED);
  assert.equal(pinOutcome(repo.dir), "pass", "compression commit: comment lines decrease from the merge-base");

  // A later PR: main now carries the pin, and a feature edit to the module leaves the tracked pin inert.
  repo.git("push", "-q", "origin", "compress:main");
  repo.git("fetch", "-q", "origin");
  repo.git("checkout", "-qb", "feature", "origin/main");
  write(repo.dir, MODULE, `${COMPRESSED}// a later feature note\n// and another\nexport const more = 2;\n`);
  repo.git("commit", "-qam", "feat(test): a later feature edit");
  assert.equal(pinOutcome(repo.dir), "inert", "a tracked pin on a later PR never freezes the module");
});

test("a pin outside any git repository throws instead of reading as untracked", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-untracked-pin-nogit-"));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });
  write(dir, PIN, "// not in a repository\n");
  assert.throws(() => compressionPinBase(MODULE, pathToFileURL(join(dir, PIN)).href, dir), /git ls-files failed/);
});
