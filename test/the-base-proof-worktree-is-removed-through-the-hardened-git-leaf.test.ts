/**
 * THE MERGE-BASE PROOF WORKTREE IS REMOVED THROUGH THE HARDENED GIT LEAF.
 *
 * `buildBaseProofDir` cuts a `unit test:` proof's merge-base worktree through `hostWorktreeGit`
 * (src/lib/worktree-git.ts), which pins the repository and drops inherited variables that would
 * redirect git (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_CONFIG_*`, ...). Its teardown, `releaseBaseProofDir`,
 * removed that worktree with a raw `git -C <dir> worktree remove` by default, and every caller that
 * passes no remover (`rmd check-proof --base`, `rmd check-acceptance`, the sweep's review-reuse path
 * without `worktreeRemoveImpl`) took that default. #10666 routed only `dispatchProofAmendmentWrite`
 * through the leaf, by injecting a remover.
 *
 * The probe: an inherited `GIT_DIR` naming ANOTHER repository. The raw default follows it, git
 * answers "is not a working tree", the teardown logs the failure, and the worktree stays registered
 * and on disk. The leaf ignores it, so the worktree is gone. This drives the real exported
 * `checkProofCommand`, with no remover injected.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { checkProofCommand, CHECK_PROOF_EXIT } from "../src/run-task.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** `checkProofCommand` from `cwd` with `GIT_DIR` set to `gitDir`; stdout, stderr, cwd and env restored. */
function runVerbUnderGitDir(argv: string[], cwd: string, gitDir: string, deps: Parameters<typeof checkProofCommand>[1]): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  const realCwd = process.cwd();
  const hadGitDir = Object.hasOwn(process.env, "GIT_DIR");
  const savedGitDir = process.env.GIT_DIR;
  console.log = (...args: unknown[]) => void out.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => void err.push(args.map(String).join(" "));
  try {
    process.chdir(cwd);
    process.env.GIT_DIR = gitDir;
    const code = checkProofCommand(argv, deps);
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    if (hadGitDir) process.env.GIT_DIR = savedGitDir;
    else delete process.env.GIT_DIR;
    process.chdir(realCwd);
    console.log = realLog;
    console.error = realError;
  }
}

/** The `worktree` paths `git worktree list --porcelain` prints. */
function listedTrees(porcelain: string): string[] {
  return porcelain.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length));
}

test("check-proof --base removes its merge-base worktree through the hardened git leaf even when an inherited GIT_DIR names another repository", () => {
  // Two commits whose one test passes on both, so the `unit test:` proof gets a real merge-base worktree and runs there.
  const subject = gitRepo({ kind: "base-proof-leaf" });
  writeFileSync(join(subject.dir, "package.json"), JSON.stringify({ name: "base-proof-leaf-fixture", private: true, type: "module" }));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(subject.dir, "node_modules"));
  mkdirSync(join(subject.dir, "test", "setup"), { recursive: true });
  writeFileSync(join(subject.dir, "test", "setup", "tmp-hygiene.ts"), "export {};\n");
  writeFileSync(join(subject.dir, "test", "stays.test.ts"), 'import { test } from "node:test";\ntest("passes on both commits", () => {});\n');
  subject.git("add", "-A");
  subject.git("commit", "-q", "-m", "base");
  subject.git("commit", "-q", "--allow-empty", "-m", "head");
  const decoy = gitRepo({ kind: "base-proof-leaf-decoy" });
  const baseTree = join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}base-proof-leaf-tree-`)), "base");

  const { code, out, err } = runVerbUnderGitDir(["--base", "HEAD~1", "unit test:", "test/stays.test.ts"], subject.dir, join(decoy.dir, ".git"), {
    baseBlobDeps: { makeDir: () => baseTree },
  });

  // The precondition: the merge-base worktree was really cut at baseTree and the proof ran in it.
  assert.equal(code, CHECK_PROOF_EXIT.executedStale, `${out}\n${err}`);
  assert.match(out, /^base:\s+pass$/m, "the base run executed in the merge-base worktree");
  // The teardown: nothing failed, git no longer lists the worktree, and its directory is gone.
  assert.doesNotMatch(err, /base worktree teardown failed/, `the removal did not fail:\n${err}`);
  assert.equal(listedTrees(subject.git("worktree", "list", "--porcelain")).length, 1, "the subject repository lists only its own tree again");
  assert.equal(existsSync(baseTree), false, `the merge-base worktree ${baseTree} is deleted`);
  assert.equal(listedTrees(decoy.git("worktree", "list", "--porcelain")).length, 1, "the decoy repository was never touched");
});
