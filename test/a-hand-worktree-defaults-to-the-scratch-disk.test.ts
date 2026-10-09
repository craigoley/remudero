import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import { defaultHandWorktreeParent } from "../src/lib/hand-worktree.js";
import { handWorktreeCommand } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

const PROOF = "test/a-hand-worktree-defaults-to-the-scratch-disk.test.ts";
const NOW = 1_791_000_000_000;

function fixture() {
  const origin = gitRepo({ bare: true, kind: "hand-scratch-origin" });
  const seed = gitRepo({ kind: "hand-scratch-seed" });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "-q", "origin", "main");
  const repo = seed.addWorktree(join(origin.dir, "checkout"), "checkout");
  const scratchRoot = join(repo.dir, "scratch");
  mkdirSync(scratchRoot);
  return { repo, scratchRoot };
}

function command(rest: string[], opts: Parameters<typeof handWorktreeCommand>[1]) {
  const out: string[] = [];
  const err: string[] = [];
  const [log, error] = [console.log, console.error];
  console.log = (...args: unknown[]) => void out.push(args.join(" "));
  console.error = (...args: unknown[]) => void err.push(args.join(" "));
  try {
    return { code: handWorktreeCommand(rest, opts), out: out.join("\n"), err: err.join("\n") };
  } finally {
    [console.log, console.error] = [log, error];
  }
}

test(`${PROOF}: defaults to /mnt/scratch/hand and checks the scratch root`, () => {
  const checked: string[] = [];
  assert.equal(defaultHandWorktreeParent("/checkout/repo", {
    exists: (path) => { checked.push(path); return true; },
  }), "/mnt/scratch/hand");
  assert.deepEqual(checked, ["/mnt/scratch"]);
});

test(`${PROOF}: an existing directory selects hand and a missing root or a file selects the checkout parent`, () => {
  const { repo, scratchRoot } = fixture();
  assert.equal(defaultHandWorktreeParent(repo.dir, { scratchRoot }), join(scratchRoot, "hand"));
  assert.equal(defaultHandWorktreeParent(repo.dir, { scratchRoot: join(scratchRoot, "absent") }), dirname(repo.dir));
  const file = join(scratchRoot, "file");
  writeFileSync(file, "not a directory");
  assert.equal(defaultHandWorktreeParent(repo.dir, { scratchRoot: file }), dirname(repo.dir));
  assert.equal(defaultHandWorktreeParent("relative/repo", { exists: () => false }), dirname(resolve("relative/repo")));
});

test(`${PROOF}: no --parent creates the worktree in a newly created scratch hand directory`, () => {
  const { repo, scratchRoot } = fixture();
  const parent = join(scratchRoot, "hand");
  assert.equal(existsSync(parent), false);
  const result = command(["unfiled"], { repoDir: repo.dir, scratchRoot, clock: fixedClock(NOW) });
  assert.equal(result.code, 0, result.err);
  const path = join(parent, `run-unfiled-${NOW}`);
  assert.ok(existsSync(join(path, ".git")));
  assert.ok(repo.git("worktree", "list", "--porcelain").includes(`worktree ${path}\n`));
  assert.ok(result.out.includes(`parent: ${parent} (scratch root ${scratchRoot} is a directory)`));
  assert.match(result.out, /next step: `npm\s+ci`/);
  assert.equal(existsSync(join(scratchRoot, "worktrees")), false);
});

test(`${PROOF}: no --parent falls back beside the checkout when scratch is absent`, () => {
  const { repo, scratchRoot } = fixture();
  const missing = join(scratchRoot, "absent");
  const parent = dirname(repo.dir);
  const result = command(["unfiled"], { repoDir: repo.dir, scratchRoot: missing, clock: fixedClock(NOW) });
  assert.equal(result.code, 0, result.err);
  const path = join(parent, `run-unfiled-${NOW}`);
  assert.ok(existsSync(join(path, ".git")));
  assert.ok(result.out.includes(`parent: ${parent} (scratch root ${missing} is not a directory; using checkout parent)`));
  repo.git("worktree", "remove", "--force", path);
});

test(`${PROOF}: explicit --parent wins without inspecting or creating scratch`, () => {
  const { repo, scratchRoot } = fixture();
  const parent = join(repo.dir, "explicit");
  mkdirSync(parent);
  const result = command(["unfiled", "--parent", parent], {
    repoDir: repo.dir, scratchRoot, clock: fixedClock(NOW),
    exists: () => { throw new Error("explicit parent must skip scratch probing"); },
  });
  assert.equal(result.code, 0, result.err);
  assert.ok(existsSync(join(parent, `run-unfiled-${NOW}`, ".git")));
  assert.ok(result.out.includes(`parent: ${parent} (explicit --parent)`));
  assert.equal(existsSync(join(scratchRoot, "hand")), false);
});

test(`${PROOF}: scratch hand creation failure is refused with its filesystem reason`, () => {
  const { repo, scratchRoot } = fixture();
  const parent = join(scratchRoot, "hand");
  writeFileSync(parent, "occupied");
  const before = repo.git("worktree", "list", "--porcelain");
  const result = command(["unfiled"], { repoDir: repo.dir, scratchRoot, clock: fixedClock(NOW) });
  assert.equal(result.code, 1);
  assert.ok(result.err.includes(`cannot create scratch parent ${parent}`));
  assert.match(result.err, /EEXIST/);
  assert.equal(repo.git("worktree", "list", "--porcelain"), before);
});
