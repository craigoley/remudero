import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
// A namespace import, so this file LOADS on a base without the awaited builder: there the review's base build is the
// sync one, and the ordering assertion below fails on its own terms rather than on a missing export.
import * as checkProof from "#src/lib/check-proof.js";
import type { BaseProofDir } from "#src/lib/check-proof.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

// W1-T11341. MEASURED 2026-11-04 on core: one in-process review's base build held the daemon loop 976 s, through
// execFileSync git in buildBaseProofDir. The review command's base build now awaits every git it runs, so the loop turns
// while each one is in flight. ORDERING ONLY: a git wrapper on PATH appends `start`/`end` around the real git, a heartbeat
// appends `tick`, all to one file, and every git child must have a tick between its own start and end.

type AwaitedBuilder = (criteria: ReadonlyArray<{ proof?: string }>, head: string, deps: { makeDir: () => string }) => Promise<BaseProofDir>;

/** The review command's base build: the awaited builder where it exists, else the sync one a base review ran. */
const awaitedBuild = (criteria: ReadonlyArray<{ proof?: string }>, head: string, makeDir: () => string): Promise<BaseProofDir> => {
  const lib = checkProof as unknown as { buildBaseProofDirAsync?: AwaitedBuilder };
  if (lib.buildBaseProofDirAsync) return lib.buildBaseProofDirAsync(criteria, head, { makeDir });
  return Promise.resolve(checkProof.buildBaseProofDir(criteria, head, { makeDir }));
};

const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

/** A `git` on PATH that brackets the real one with order rows. The pause gives the loop a turn to show it is free. */
function onPath(order: string): { restore(): void } {
  const bin = mkdtempSync(join(tmpdir(), "rmd-awaited-base-git-"));
  const wrapper = join(bin, "git");
  writeFileSync(wrapper, [
    "#!/bin/sh",
    `echo "start $$" >> '${order}'`,
    "sleep 0.25",
    `'${realGit}' "$@"`,
    "rc=$?",
    `echo "end $$" >> '${order}'`,
    "exit $rc",
    "",
  ].join("\n"));
  chmodSync(wrapper, 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  return { restore() { process.env.PATH = saved; rmSync(bin, { recursive: true, force: true }); } };
}

/** Each git child's rows, and whether the heartbeat ticked between its start and its end. */
function gitChildren(order: string): Array<{ pid: string; ticked: boolean }> {
  const rows = readFileSync(order, "utf8").split("\n").filter(Boolean);
  const children: Array<{ pid: string; ticked: boolean }> = [];
  rows.forEach((row, at) => {
    const [kind, pid] = row.split(" ");
    if (kind !== "start") return;
    const end = rows.findIndex((r, i) => i > at && r === `end ${pid}`);
    assert.ok(end > at, `git ${pid} recorded its end`);
    children.push({ pid: pid!, ticked: rows.slice(at + 1, end).includes("tick") });
  });
  return children;
}

/** A fixture whose head adds a test file and a plan file over an `origin/main` base. */
function fixture(): { repo: GitRepo; dirs: string[] } {
  const repo = gitRepo({ kind: "awaited-base" });
  mkdirSync(join(repo.dir, "plan"), { recursive: true });
  mkdirSync(join(repo.dir, "test"), { recursive: true });
  writeFileSync(join(repo.dir, "plan", "shard.yaml"), "title: before\n");
  writeFileSync(join(repo.dir, "test", "old.test.ts"), "// old\n");
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "base");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(repo.dir, "plan", "shard.yaml"), "title: after awaited-marker\n");
  writeFileSync(join(repo.dir, "test", "added.test.ts"), "// added awaited-marker\n");
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "head");
  return { repo, dirs: [] };
}

/** The facts and the bytes a base build produced, comparable across the two builders. */
function snapshot(built: BaseProofDir): Record<string, unknown> {
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === ".git") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files[relative(built.baseCheckoutDir!, path)] = readFileSync(path, "utf8");
    }
  };
  if (built.baseCheckoutDir) walk(built.baseCheckoutDir);
  return {
    hasDir: built.baseCheckoutDir !== undefined, baseIsCheckout: built.baseIsCheckout, baseIsGrepTree: built.baseIsGrepTree === true,
    unreadable: [...built.baseUnreadablePaths].sort(), added: [...built.addedTestFiles].sort(),
    failed: built.baseWorktreeFailure !== undefined, files,
  };
}

const CASES: Array<{ name: string; criteria: Array<{ proof: string }>; occupied?: boolean }> = [
  { name: "a plan filing's grep reads its base blob into a grep tree", criteria: [{ proof: "grep: awaited-marker in plan/shard.yaml" }] },
  { name: "a grep naming a test file also reads the diff's added tests", criteria: [{ proof: "grep: awaited-marker in test/added.test.ts" }] },
  { name: "a unit-test proof resolves its path in the base tree and checks the base out", criteria: [{ proof: "unit test: test/added.test.ts" }] },
  {
    name: "a checkout that cannot be made falls back to the base blobs",
    criteria: [{ proof: "unit test: test/added.test.ts" }, { proof: "grep: title in plan/shard.yaml" }], occupied: true,
  },
];

for (const c of CASES) {
  test(`W1-T11341 criterion 1: ${c.name}, and the loop turns during every git it runs`, async () => {
    const { repo } = fixture();
    const scratch = mkdtempSync(join(tmpdir(), "rmd-awaited-base-"));
    const order = join(scratch, "order");
    writeFileSync(order, "");
    let made = 0;
    const makeDir = (): string => {
      const dir = join(scratch, `base-${made += 1}`);
      mkdirSync(dir, { recursive: true });
      if (c.occupied) writeFileSync(join(dir, "occupied"), "a worktree cannot be added into a non-empty directory\n");
      return dir;
    };
    // The sync builder's own result is the contract the awaited one must keep, byte for byte.
    const expected = snapshot(checkProof.buildBaseProofDir(c.criteria, repo.dir, { makeDir }));
    const path = onPath(order);
    const heartbeat = setInterval(() => appendFileSync(order, "tick\n"), 5);
    let built: BaseProofDir;
    try {
      built = await awaitedBuild(c.criteria, repo.dir, makeDir);
    } finally {
      clearInterval(heartbeat);
      path.restore();
    }
    try {
      const children = gitChildren(order);
      assert.ok(children.length > 0, "the base build ran git through the wrapper");
      assert.deepEqual(children.filter((child) => !child.ticked).map((child) => child.pid), [],
        "no git child held the loop: the heartbeat ticked while each one ran");
      assert.deepEqual(snapshot(built), expected, "the awaited build keeps the sync builder's facts and bytes");
    } finally {
      for (const name of readdirSync(scratch)) {
        const dir = join(scratch, name);
        if (statSync(dir).isDirectory() && readdirSync(dir).includes(".git")) {
          try { repo.git("worktree", "remove", "--force", dir); } catch { /* the rm below reclaims it */ }
        }
      }
      rmSync(scratch, { recursive: true, force: true });
      repo.cleanup();
    }
  });
}
