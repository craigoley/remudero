/**
 * EVERY `git worktree remove` THE HARNESS RUNS GOES THROUGH THE HARDENED GIT LEAF.
 *
 * #10677 routed `removeBaseProofWorktree` through `hostWorktreeGit` (src/lib/worktree-git.ts). The leaf
 * pins the repository and drops inherited variables that would redirect git (`GIT_DIR`,
 * `GIT_WORK_TREE`, `GIT_CONFIG_*`, ...), and vets the pinned config first. Eight more removals were raw
 * `git -C <dir> worktree remove`: worker teardown (`worktreeRemove`, `worktreeRemoveAsync`), the
 * start-of-run prune (`pruneStaleRuns`), the stale-worktree reaper (`executeWorktreeRemoval`), the
 * sync plan-PR preflight tree, the sweep's base-reproduction probe and the abandoned fix-owner
 * reclaim. The host's managed checkouts (core, console, site) hold only keys the leaf admits (read
 * 2026-10-11), so the vetting refuses none of them.
 *
 * The probe, as in #10677: an inherited `GIT_DIR` naming ANOTHER repository while the removal runs.
 * A raw removal follows it, git answers "is not a working tree", and the worktree stays registered
 * and on disk. Through the leaf it is removed, and the decoy repository is never touched.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { pruneStaleRuns, reapStaleWorktrees, worktreeRemove, worktreeRemoveAsync } from "#src/lib/worker.js";
import { buildBaseReproductionProbe, removeAbandonedFixWorktreeOwner } from "#src/run-task.js";
import type { Config } from "#src/lib/config.js";
import type { OpenPrView } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

let root: string;
let decoy: GitRepo;
let counter = 0;
const savedScratch = process.env.CLAUDE_CODE_TMPDIR;

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}leaf-remove-`)));
  // worktreeRemove reaps and sweeps Claude scratch under CLAUDE_CODE_TMPDIR; keep that inside this suite's root.
  mkdirSync(join(root, "scratch"));
  process.env.CLAUDE_CODE_TMPDIR = join(root, "scratch");
  decoy = gitRepo({ kind: "leaf-remove-decoy" });
});

after(() => {
  if (savedScratch === undefined) delete process.env.CLAUDE_CODE_TMPDIR;
  else process.env.CLAUDE_CODE_TMPDIR = savedScratch;
  rmSync(root, { recursive: true, force: true });
  decoy.cleanup();
});

/** A source repository with one linked worktree on `branch` under `<root>/<dir>`. */
function subjectWithTree(dir: string, branch: string): { subject: GitRepo; tree: string } {
  const subject = gitRepo({ kind: "leaf-remove-subject" });
  mkdirSync(join(root, dir), { recursive: true });
  const tree = join(root, dir, `${branch}-${++counter}`);
  subject.addWorktree(tree, `${branch}-${counter}`);
  return { subject, tree };
}

function listedTrees(repo: GitRepo): string[] {
  return repo.git("worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
}

/** Run `fn` with `GIT_DIR` naming the decoy repository; the variable is restored however `fn` ends. */
async function underDecoyGitDir<T>(fn: () => T | Promise<T>): Promise<T> {
  const had = Object.hasOwn(process.env, "GIT_DIR");
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = join(decoy.dir, ".git");
  try {
    return await fn();
  } finally {
    if (had) process.env.GIT_DIR = saved;
    else delete process.env.GIT_DIR;
  }
}

/** Set the decoy `GIT_DIR` from inside a callback the code under test calls between its reads and its removal. */
function armDecoyGitDir(): () => void {
  const had = Object.hasOwn(process.env, "GIT_DIR");
  const saved = process.env.GIT_DIR;
  return () => {
    if (had) process.env.GIT_DIR = saved;
    else delete process.env.GIT_DIR;
  };
}

function assertRemoved(subject: GitRepo, tree: string): void {
  assert.equal(existsSync(tree), false, `the worktree ${tree} is deleted`);
  assert.deepEqual(listedTrees(subject).filter((t) => t !== realpathSync(subject.dir)), [], "the subject lists only its own tree");
  assert.equal(listedTrees(decoy).length, 1, "the decoy repository was never touched");
}

describe("a worktree removal is not redirected by an inherited GIT_DIR", () => {
  it("worktreeRemove (worker teardown) removes the tree from the pinned repository", async () => {
    const { subject, tree } = subjectWithTree("teardown", "run-sync");
    await underDecoyGitDir(() => worktreeRemove(subject.dir, tree));
    assertRemoved(subject, tree);
  });

  it("worktreeRemoveAsync (the daemon-loop teardown) removes the tree from the pinned repository", async () => {
    const { subject, tree } = subjectWithTree("teardown", "run-async");
    await underDecoyGitDir(() => worktreeRemoveAsync(subject.dir, tree));
    assertRemoved(subject, tree);
  });

  it("removeAbandonedFixWorktreeOwner (the sweep's fix-owner reclaim) removes the clean owner", async () => {
    const { subject, tree } = subjectWithTree("fix-owners", "fix-owner");
    await underDecoyGitDir(() => removeAbandonedFixWorktreeOwner(subject.dir, tree));
    assertRemoved(subject, tree);
  });

  it("pruneStaleRuns removes a dead run's worktree even when GIT_DIR appears after it listed the registry", () => {
    const { subject, tree } = subjectWithTree("runs", "run-dead");
    const restore = armDecoyGitDir();
    let summary;
    try {
      // `now` is read by the age guard, after the registry listing and before the removal it gates.
      summary = pruneStaleRuns(subject.dir, join(root, "runs"), {
        graceMs: 1,
        now: () => {
          process.env.GIT_DIR = join(decoy.dir, ".git");
          return Date.now() + 60_000;
        },
      });
    } finally {
      restore();
    }
    assert.deepEqual(summary.worktrees, [tree], "the prune reports the removal");
    assertRemoved(subject, tree);
  });

  it("the stale-worktree reaper's git-remove plan removes a registered tree even when GIT_DIR appears after its gates", () => {
    const { subject, tree } = subjectWithTree("reap", "run-reaped");
    const restore = armDecoyGitDir();
    let summary;
    try {
      summary = reapStaleWorktrees(join(root, "reap"), {
        isPidAlive: () => false,
        maxAgeMs: 0,
        newestActivity: () => ({ mtimeMs: 0, complete: true }),
        // The live-branch gate runs after the registration lookup and right before the removal plan executes.
        branchIsLiveUpstream: () => {
          process.env.GIT_DIR = join(decoy.dir, ".git");
          return false;
        },
      });
    } finally {
      restore();
    }
    assert.deepEqual(summary.keptReasons, [], "nothing was kept, so the removal did not fail");
    assert.deepEqual(summary.reaped, [tree.slice(join(root, "reap").length + 1)]);
    assertRemoved(subject, tree);
  });

  it("the base-reproduction probe's default git cuts and removes its origin/main tree in the pinned repository", async () => {
    const subject = gitRepo({ kind: "leaf-remove-probe" });
    // A commit the decoy cannot have: two seed commits made in the same second share a sha.
    subject.git("commit", "-q", "--allow-empty", "-m", `probe subject ${counter}`);
    assert.throws(() => decoy.git("cat-file", "-e", `${subject.git("rev-parse", "HEAD")}^{commit}`), "the decoy lacks the probed commit");
    const config = { root: join(root, `probe-${++counter}`) } as Config;
    const sha = subject.git("rev-parse", "HEAD");
    const probe = buildBaseReproductionProbe(config, subject.dir, "unused", () => {}, {
      readLedger: () => [], link: () => "linked", readFile: async () => "contents", execute: async () => "pass",
    });
    const result = await underDecoyGitDir(() => probe({ prNumber: 1, headSha: sha } as OpenPrView, [`test/leaf-${counter}.test.ts`], sha));
    assert.equal((result as { setup_error?: string }).setup_error, undefined, "the probe's tree was cut in the subject, not the decoy");
    assert.equal(result[0]!.outcome, "passes");
    assertRemoved(subject, join(config.root, "worktrees", `base-repro-${sha.slice(0, 12)}`));
  });
});

describe("no converted removal keeps a raw `git worktree remove` spawn", () => {
  const RAW_REMOVE = /\b(?:execFileSync|execFile|execFilePromise|execFileAsync|spawnSync|spawn)\(\s*"git",\s*\[\s*"-C",\s*[^\]]*"worktree",\s*"remove"/;
  const WRAPPED_REMOVE = /\bworktreeGit\(\s*\[\s*"-C",\s*[^\]]*"worktree",\s*"remove"/;
  const SITES: ReadonlyArray<readonly [string, string]> = [
    ["src/lib/worker.ts", "worktreeRemove"],
    ["src/lib/worker.ts", "worktreeRemoveAsync"],
    ["src/lib/worker.ts", "pruneStaleRuns"],
    ["src/lib/worker.ts", "executeWorktreeRemoval"],
    ["src/lib/plan-pr-emitter.ts", "planPrPreflightAtCommit"],
    ["src/lib/plan-pr-emitter.ts", "removeTemporaryWorktree"],
    ["src/run-task.ts", "buildBaseReproductionProbe"],
    ["src/run-task.ts", "removeAbandonedFixWorktreeOwner"],
  ];

  /** The text of top-level function `name`: its declaration to the first column-0 `}`. */
  function functionBody(source: string, name: string): string | undefined {
    const at = new RegExp(`^(?:export )?(?:async )?function\\*? ${name}\\(`, "m").exec(source);
    if (!at) return undefined;
    const end = source.indexOf("\n}\n", at.index);
    return source.slice(at.index, end < 0 ? undefined : end);
  }

  it("each removal site reaches the leaf and spawns no raw `git -C … worktree remove`", () => {
    for (const [file, name] of SITES) {
      const body = functionBody(readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8"), name);
      assert.ok(body, `${file}: ${name} not found`);
      assert.doesNotMatch(body, RAW_REMOVE, `${file}: ${name} spawns a raw git worktree remove`);
      assert.doesNotMatch(body, WRAPPED_REMOVE, `${file}: ${name} spawns a raw git worktree remove through worktreeGit`);
      assert.match(body, /\bhostWorktreeGit(?:Async)?\(/, `${file}: ${name} does not call the hardened leaf`);
    }
  });

  it("the census pattern sees a raw removal: a positive control", () => {
    assert.match('execFileSync("git", ["-C", repoDir, "worktree", "remove", "--force", wt], {', RAW_REMOVE);
    assert.match('await worktreeGit(["-C", repoDir, "worktree", "remove", "--force", wt], true);', WRAPPED_REMOVE);
  });
});
