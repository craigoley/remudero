// W1-T10257: addCowWorktree clones the donor checkout's UNCHANGED tracked files and lets git write the rest.
// Every fixture is a real throwaway git repo; the clone seam is injected (this host's volume cannot clone),
// except where a test says it shells out for real.
import assert from "node:assert/strict";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  addCowWorktree,
  cloneCpArgs,
  defaultCowWorktreePort,
  linkDonorNodeModules,
  mainWorktreeOf,
  renderCowWorktree,
  type CloneRun,
  type CowWorktreePort,
} from "#src/lib/cow-worktree.js";
import { worktreeCommand } from "#src/run-task.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

interface Fixture {
  repo: GitRepo;
  /** The commit the donor checkout sits at; `base` adds one commit on top. */
  base: string;
}

/** a.txt, keep/c.txt, run.sh unchanged across the base; b.txt changes in the base; a.txt is dirty in the donor. */
function fixture(): Fixture {
  const repo = gitRepo({ kind: "cow-wt" });
  mkdirSync(join(repo.dir, "keep"));
  writeFileSync(join(repo.dir, "a.txt"), "a committed\n");
  writeFileSync(join(repo.dir, "b.txt"), "b one\n");
  writeFileSync(join(repo.dir, "keep", "c.txt"), "c committed\n");
  writeFileSync(join(repo.dir, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "donor head");
  repo.git("checkout", "-q", "-b", "next");
  writeFileSync(join(repo.dir, "b.txt"), "b two\n");
  writeFileSync(join(repo.dir, "added.txt"), "added in base\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "base");
  const base = repo.git("rev-parse", "HEAD");
  repo.git("checkout", "-q", "main");
  // the donor's uncommitted edit and an untracked file: neither may reach the new worktree
  writeFileSync(join(repo.dir, "a.txt"), "a DONOR EDIT\n");
  writeFileSync(join(repo.dir, "untracked.txt"), "never copied\n");
  return { repo, base };
}

/** A clone seam that copies, records every name it was asked for, and so stands in for APFS. */
function copyingPort(asked: string[], tamper?: (dst: string) => void): CowWorktreePort {
  return {
    ...defaultCowWorktreePort,
    cloneFiles(srcDir, dstDir, names): CloneRun {
      const probe = dstDir.includes(".rmd-cow-probe-");
      for (const name of names) {
        const leaf = name.split("/").pop() as string;
        copyFileSync(join(srcDir, name), join(dstDir, leaf));
        if (probe) continue;
        asked.push(name);
        tamper?.(join(dstDir, leaf));
      }
      return { ok: true, detail: "" };
    },
  };
}

const unsupportedPort: CowWorktreePort = {
  ...defaultCowWorktreePort,
  cloneFiles: () => ({ ok: false, detail: "Operation not supported" }),
};

function target(repo: GitRepo, name: string): string {
  return join(repo.dir, "..", `${repo.dir.split("/").pop()}-${name}`);
}

function treeOf(repo: GitRepo, dir: string): string {
  return repo.git("-C", dir, "rev-parse", "HEAD^{tree}");
}

test("W1-T10257: a worktree clones unchanged checkout files and falls back off APFS", () => {
  const { repo, base } = fixture();
  const baseTree = repo.git("rev-parse", `${base}^{tree}`);

  // WITH clone support: only the unchanged, donor-clean files are cloned
  const asked: string[] = [];
  const cloneDir = target(repo, "clone");
  const cloned = addCowWorktree({ repoDir: repo.dir, dir: cloneDir, branch: "cow-clone", base, donorDir: repo.dir, port: copyingPort(asked) });
  assert.equal(cloned.method, "clone");
  assert.deepEqual(asked.sort(), ["keep/c.txt", "run.sh"], "a.txt is donor-dirty and b.txt differs in the base: neither is cloned");
  assert.equal(cloned.cloned, 2);
  assert.equal(cloned.written, 3, "git wrote the other three tracked paths: a.txt, b.txt, added.txt");
  assert.equal(cloned.reconciledByRewrite, false);
  assert.equal(readFileSync(join(cloneDir, "a.txt"), "utf8"), "a committed\n", "the donor's uncommitted edit is absent");
  assert.equal(readFileSync(join(cloneDir, "b.txt"), "utf8"), "b two\n", "a path changed between donor HEAD and base is the base's");
  assert.equal(readFileSync(join(cloneDir, "added.txt"), "utf8"), "added in base\n");
  assert.equal(existsSync(join(cloneDir, "untracked.txt")), false, "the donor's untracked file never reaches the worktree");
  assert.notEqual(lstatSync(join(cloneDir, "run.sh")).mode & 0o111, 0, "the cloned script is still executable");
  assert.equal(repo.git("-C", cloneDir, "status", "--porcelain", "--untracked-files=all"), "");
  assert.equal(repo.git("-C", cloneDir, "rev-parse", "HEAD"), base);
  assert.equal(repo.git("-C", cloneDir, "rev-parse", "--abbrev-ref", "HEAD"), "cow-clone");
  assert.equal(treeOf(repo, cloneDir), baseTree);
  assert.deepEqual(readdirSync(join(repo.dir, "..")).filter((n) => n.startsWith(".rmd-cow-probe-")), [], "the clone probe directory is removed");

  // WITHOUT clone support: a normal checkout with the same tree, and the reason is reported
  const plainDir = target(repo, "plain");
  const plain = addCowWorktree({ repoDir: repo.dir, dir: plainDir, branch: "cow-plain", base, donorDir: repo.dir, port: unsupportedPort });
  assert.equal(plain.method, "checkout");
  assert.equal(plain.cloned, 0);
  assert.equal(plain.fallbackReason, "Operation not supported");
  assert.equal(repo.git("-C", plainDir, "status", "--porcelain", "--untracked-files=all"), "");
  assert.equal(treeOf(repo, plainDir), baseTree);
  assert.equal(readFileSync(join(plainDir, "a.txt"), "utf8"), "a committed\n");
  assert.match(renderCowWorktree(plainDir, "cow-plain", plain), /fell back to a normal checkout: Operation not supported/);
});

test("W1-T10257: a clone that left the status dirty is rewritten by git and reported", () => {
  const { repo, base } = fixture();
  const dir = target(repo, "dirty");
  const result = addCowWorktree({
    repoDir: repo.dir, dir, branch: "cow-dirty", base, donorDir: repo.dir,
    port: copyingPort([], (dst) => { if (dst.endsWith("c.txt")) writeFileSync(dst, "corrupted clone\n"); }),
  });
  assert.equal(result.method, "clone");
  assert.equal(result.reconciledByRewrite, true);
  assert.equal(readFileSync(join(dir, "keep", "c.txt"), "utf8"), "c committed\n");
  assert.equal(repo.git("-C", dir, "status", "--porcelain", "--untracked-files=all"), "");
  assert.match(renderCowWorktree(dir, "cow-dirty", result), /reconciled-by-rewrite/);
});

test("W1-T10257: a failed clone batch leaves git to write the missing files", () => {
  const { repo, base } = fixture();
  const dir = target(repo, "partial");
  let first = true;
  const port: CowWorktreePort = {
    ...defaultCowWorktreePort,
    cloneFiles(srcDir, dstDir, names): CloneRun {
      if (dstDir.includes(".rmd-cow-probe-")) { copyFileSync(join(srcDir, names[0]), join(dstDir, "x")); return { ok: true, detail: "" }; }
      if (first) { first = false; return { ok: false, detail: "ENOSPC" }; }
      for (const n of names) copyFileSync(join(srcDir, n), join(dstDir, n.split("/").pop() as string));
      return { ok: true, detail: "" };
    },
  };
  const result = addCowWorktree({ repoDir: repo.dir, dir, branch: "cow-partial", base, donorDir: repo.dir, port });
  assert.equal(result.method, "clone");
  assert.equal(result.cloned, 1, "one directory's batch failed; its files are written by git");
  assert.equal(repo.git("-C", dir, "status", "--porcelain", "--untracked-files=all"), "");
  assert.equal(treeOf(repo, dir), repo.git("rev-parse", `${base}^{tree}`));
});

test("W1-T10257: the default clone backend really shells out and the worktree is a clean checkout either way", () => {
  const { repo, base } = fixture();
  const dir = target(repo, "real");
  const result = addCowWorktree({ repoDir: repo.dir, dir, branch: "cow-real", base, donorDir: repo.dir });
  assert.ok(result.method === "clone" || result.method === "checkout");
  if (result.method === "checkout") assert.ok(result.fallbackReason !== null && result.fallbackReason !== "");
  assert.equal(repo.git("-C", dir, "status", "--porcelain", "--untracked-files=all"), "");
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "a committed\n");
  assert.ok(result.freeBytesBefore > 0 && result.freeBytesAfter > 0);
  assert.deepEqual(cloneCpArgs("darwin"), ["-c"]);
  assert.deepEqual(cloneCpArgs("linux"), ["--reflink=always"]);
  assert.equal(cloneCpArgs("win32"), null);
  const refused = defaultCowWorktreePort.cloneFiles(repo.dir, repo.dir, ["a.txt"]);
  assert.equal(refused.ok, false, "cloning a file onto itself is refused, never reported as a clone");
});

test("W1-T10257: git failing to cut the worktree throws and is never reported as a clone", () => {
  const { repo } = fixture();
  assert.throws(
    () => addCowWorktree({ repoDir: repo.dir, dir: target(repo, "nobase"), branch: "cow-nobase", base: "no-such-ref", donorDir: repo.dir, port: copyingPort([]) }),
    /git ls-tree -r failed/,
  );
});

test("W1-T10257: mainWorktreeOf names the operator checkout and linkDonorNodeModules symlinks only when there is something to link", () => {
  const { repo, base } = fixture();
  const dir = target(repo, "linked");
  addCowWorktree({ repoDir: repo.dir, dir, branch: "cow-linked", base, donorDir: repo.dir, port: unsupportedPort });
  assert.equal(mainWorktreeOf(dir), mainWorktreeOf(repo.dir));
  assert.equal(linkDonorNodeModules(repo.dir, dir), false, "no donor node_modules: nothing linked");
  mkdirSync(join(repo.dir, "node_modules"));
  assert.equal(linkDonorNodeModules(repo.dir, dir), true);
  assert.equal(readlinkSync(join(dir, "node_modules")), join(repo.dir, "node_modules"));
  assert.equal(linkDonorNodeModules(repo.dir, dir), false, "an existing link is left alone");
  assert.throws(() => mainWorktreeOf(join(repo.dir, "..")), /git worktree list failed/);
});

test("W1-T10257: rmd worktree add makes the worktree, and refuses bad usage with exit 2", () => {
  const { repo } = fixture();
  const dir = target(repo, "cli");
  const errors: string[] = [];
  const logs: string[] = [];
  const realErr = console.error;
  const realLog = console.log;
  console.error = (...a: unknown[]) => { errors.push(a.join(" ")); };
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
  try {
    assert.equal(worktreeCommand(["add", dir, "-b", "cow-cli", "next"], { repoDir: repo.dir }), 0);
    assert.equal(worktreeCommand([], { repoDir: repo.dir }), 2);
    assert.equal(worktreeCommand(["add", "relative", "-b", "x", "next"], { repoDir: repo.dir }), 2);
    assert.equal(worktreeCommand(["add", dir, "next"], { repoDir: repo.dir }), 2);
    assert.equal(worktreeCommand(["add", dir, "-b"], { repoDir: repo.dir }), 2);
    assert.equal(worktreeCommand(["add", dir, "-b", "x", "next", "--bogus"], { repoDir: repo.dir }), 2);
    assert.equal(worktreeCommand(["add", dir, "-b", "x", "next", "--donor", "rel"], { repoDir: repo.dir }), 2);
    assert.equal(worktreeCommand(["add", dir, "-b", "again", "next"], { repoDir: repo.dir }), 1, "an existing dir is refused by git");
  } finally {
    console.error = realErr;
    console.log = realLog;
  }
  assert.match(logs.join("\n"), /method: (clone|checkout)/);
  assert.match(logs.join("\n"), /node_modules: /);
  assert.match(errors.join("\n"), /usage: rmd worktree add/);
  assert.match(errors.join("\n"), /refused/);
  assert.equal(repo.git("-C", dir, "rev-parse", "--abbrev-ref", "HEAD"), "cow-cli");
});
