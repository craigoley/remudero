/**
 * W1-T13187: an Inbox write on 2026-11-16 froze serve for 887 s while the draft lint checked each draft path with
 * its own synchronous `git ls-tree` (and a `git config --list` vet), forked from a 2.6 GB process. The check now
 * lists origin/main once per commit and answers from that set, with the same answers as the per-path check.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkoutRepoFacts } from "#src/lib/inbox.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });

function repo(t: { after: (fn: () => void) => void }): string {
  const root = gitRepo({ seedCommit: false, kind: "base-listing" }).dir;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src", "lib"), { recursive: true });
  writeFileSync(join(root, "src", "lib", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "README.md"), "x\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "one");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  return root;
}

function counting(): { calls: string[][]; run: (root: string, args: readonly string[]) => string } {
  const calls: string[][] = [];
  return { calls, run: (root, args) => { calls.push([...args]); return execFileSync("git", [...args], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); } };
}

test("W1-T13187 criterion 1: fifty path checks on one commit list origin/main once", (t) => {
  const root = repo(t);
  const seam = counting();
  const facts = checkoutRepoFacts(root, seam.run);
  for (let i = 0; i < 50; i++) facts.pathExistsAtBase!(`test/missing-${i}.test.ts`);
  assert.equal(facts.pathExistsAtBase!("src/lib/a.ts"), true, "a file at origin/main");
  assert.equal(facts.pathExistsAtBase!("src/lib"), true, "its parent directory");
  assert.equal(facts.pathExistsAtBase!("src"), true, "and the top directory");
  assert.equal(facts.pathExistsAtBase!("src/lib/b.ts"), false, "an absent path");
  assert.equal(seam.calls.length, 1, "one listing for 54 questions");
  assert.deepEqual(seam.calls[0]!.slice(0, 4), ["ls-tree", "-r", "-z", "--name-only"]);
});

test("W1-T13187 criterion 2: a moved origin/main is listed again and its new file is seen", (t) => {
  const root = repo(t);
  const seam = counting();
  const facts = checkoutRepoFacts(root, seam.run);
  assert.equal(facts.pathExistsAtBase!("src/lib/b.ts"), false, "positive control: absent before the move");
  writeFileSync(join(root, "src", "lib", "b.ts"), "export const b = 2;\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "two");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  assert.equal(facts.pathExistsAtBase!("src/lib/b.ts"), true, "the new commit's file");
  assert.equal(facts.pathExistsAtBase!("src/lib/a.ts"), true);
  assert.equal(seam.calls.length, 2, "one listing per commit");
});

test("W1-T13187 criterion 3: on a real repository every answer equals the per-path ls-tree check it replaces", (t) => {
  const root = repo(t);
  const facts = checkoutRepoFacts(root);
  const perPath = (path: string): boolean => git(root, "ls-tree", "-z", "--name-only", "origin/main", "--", path).split("\0").includes(path);
  for (const path of ["src/lib/a.ts", "README.md", "src/lib", "src", "src/lib/", "src/lib/zz.ts", "docs", "src/li"]) {
    assert.equal(facts.pathExistsAtBase!(path), perPath(path), `same answer for ${path}`);
  }
});
