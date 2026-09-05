import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Config } from "../src/lib/config.js";
import { ADHOC_LANE_REAP_GRACE_MS, adhocLaneRoot, unmanagedWorktreeLanes, worktreesDir } from "../src/lib/worker.js";
import { DEFAULT_WORKTREE_REAP_GRACE_MS } from "../src/lib/worker.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

/**
 * test/adhoc-lane-root.test.ts — W1-T2847, the ROOT half.
 *
 * `worktreesDir(config)` is the only root `runWorktreeReapRung` ever hands `reapStaleWorktrees`.
 * MEASURED on the Mac mini 2026-09-04, with an explicit permission-truncation check (`find …
 * ! -readable` returned 0, `du` wrote 0 bytes to stderr): `config.root` held 214 entries of which
 * 180 carried a `.git` FILE — linked worktrees — sitting as SIBLINGS of `worktrees/`, which itself
 * held 11. The reaper's entire scan surface was 44K while 4.7G of the identical object class sat
 * one directory above it, reachable by nothing: `cloneReapRoots()` returns tmp roots only,
 * `pruneStaleRuns` is handed `worktreesDir` at every call site, and `reapWorkerScratch` is fenced
 * to `claudeScratchRoot()` children.
 *
 * THE POPULATION IS THE HAZARD, NOT THE TARGET. `git worktree list --porcelain` reported
 * `prunable` ZERO times across all 180 — every one is registered and on a live branch. So this
 * suite's job is to prove the new root is BOUNDED: a sibling of `worktrees/`, never `config.root`
 * itself (34 of those 214 entries are ledgers, PR bodies and manifests that no reaper may walk),
 * and never a home directory.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function cfg(root: string): Config {
  return { root } as unknown as Config;
}

// ── acceptance 1: one derived root, under config.root, and not config.root itself ──────────────

test("W1-T2847 (acceptance 1a): adhocLaneRoot resolves UNDER config.root and is a SIBLING of worktreesDir, never either of them", () => {
  const config = cfg("/srv/rmd-root");
  const lanes = adhocLaneRoot(config);
  assert.equal(lanes, join("/srv/rmd-root", "lanes"));
  assert.notEqual(lanes, config.root, "reaping config.root wholesale is what this task refuses");
  assert.notEqual(lanes, worktreesDir(config), "a distinct root, so the two rungs cannot be conflated");
  assert.equal(join(lanes, ".."), join(worktreesDir(config), ".."), "siblings — same parent");
  assert.ok(lanes.startsWith(`${config.root}/`), "and strictly inside config.root");
});

test("W1-T2847 (acceptance 1b): the root is DERIVED from config.root — it is never a hardcoded absolute path, and never a home directory", () => {
  // Two different roots must produce two different answers. A hardcoded path passes the first
  // assertion in 1a by accident and fails here, which is why this is a separate test.
  assert.notEqual(adhocLaneRoot(cfg("/a/one")), adhocLaneRoot(cfg("/b/two")));
  assert.equal(adhocLaneRoot(cfg("/a/one")), "/a/one/lanes");

  // NEVER $HOME. The console account's variant of this practice put lanes at `~/<name>`; a reaper
  // rooted at a home directory would gain Documents, Library and .ssh — refused by design (vii).
  const home = homedir();
  assert.notEqual(adhocLaneRoot(cfg("/srv/rmd-root")), home);
  assert.ok(!adhocLaneRoot(cfg("/srv/rmd-root")).startsWith(`${home}/lanes`) || "/srv/rmd-root".startsWith(home));

  // And the SOURCE carries no absolute lane literal — the public-repo-hygiene rule workerHomeDir
  // states for itself. Read from the tracked file rather than asserted about the value, because
  // the value above cannot see how it was produced.
  const src = readFileSync(join(REPO_ROOT, "src", "lib", "worker.ts"), "utf8");
  const fn = /export function adhocLaneRoot\([\s\S]*?\n}/.exec(src);
  assert.ok(fn, "the resolver is in the tracked file");
  assert.match(fn[0], /join\(config\.root,/, "derived with join(config.root, …), the house shape");
  assert.doesNotMatch(fn[0], /\/Users\/|\/home\/|homedir\(/, "no absolute path and no home lookup in the resolver");
});

// ── the age ceiling: sized for a human, and deliberately NOT the run-wall-clock one ────────────

test("W1-T2847: the lane ceiling is its OWN constant, far above the run-scoped one, so it cannot fire on a healthy overnight or weekend lane", () => {
  const HOUR = 60 * 60 * 1000;
  assert.equal(ADHOC_LANE_REAP_GRACE_MS, 14 * 24 * HOUR, "fourteen days");
  assert.ok(
    ADHOC_LANE_REAP_GRACE_MS > DEFAULT_WORKTREE_REAP_GRACE_MS,
    "reusing the run-scoped ceiling is the bound-fires-on-a-healthy-condition defect this repo keeps paying for",
  );
  // The longest LEGITIMATE idle window for a hand-cut lane is a long weekend: cut Friday evening,
  // resumed Tuesday morning is ~84h. The ceiling must clear that with real headroom.
  const LONG_WEEKEND_MS = 84 * HOUR;
  assert.ok(ADHOC_LANE_REAP_GRACE_MS / LONG_WEEKEND_MS >= 4, "at least 4x the longest legitimate idle window");
});

// ── design (vi), the reporting half: name the lanes no cadence can reach ───────────────────────

test("W1-T2847: unmanagedWorktreeLanes reports registrations outside BOTH managed roots, and reports neither managed one", () => {
  const config = cfg("/srv/rmd-root");
  const porcelain = [
    "worktree /srv/repo",
    "HEAD abc",
    "branch refs/heads/main",
    "",
    "worktree /srv/rmd-root/worktrees/run-W1-T1-1",
    "branch refs/heads/run-W1-T1-1",
    "",
    "worktree /srv/rmd-root/lanes/alloc",
    "branch refs/heads/alloc",
    "",
    "worktree /srv/rmd-root/atbase",
    "branch refs/heads/atbase",
    "",
    "worktree /Users/someone/board",
    "branch refs/heads/board",
    "",
  ].join("\n");
  const lanes = unmanagedWorktreeLanes(config, "/srv/repo", () => porcelain);
  assert.deepEqual(
    lanes,
    ["/srv/rmd-root/atbase", "/Users/someone/board"],
    "the two the cadence cannot reach — the sibling-of-worktrees shape and the home-rooted shape",
  );
  assert.ok(!lanes.includes("/srv/repo"), "the main checkout is not a lane");
});

test("W1-T2847: a root PREFIX is not a root — `lanes-old` is reported, not swallowed by `lanes`", () => {
  const porcelain = ["worktree /srv/repo", "", "worktree /srv/rmd-root/lanes-old/x", ""].join("\n");
  assert.deepEqual(unmanagedWorktreeLanes(cfg("/srv/rmd-root"), "/srv/repo", () => porcelain), [
    "/srv/rmd-root/lanes-old/x",
  ]);
});

test("W1-T2847: an unreadable registration reports NOTHING rather than guessing a population", () => {
  const lanes = unmanagedWorktreeLanes(cfg("/srv/rmd-root"), "/srv/repo", () => {
    throw new Error("not a git repository");
  });
  assert.deepEqual(lanes, [], "a read failure must never be rendered as 'no unmanaged lanes'");
});

test("W1-T2847: the reporter reads GIT'S OWN registration — driven against a real repo with a real linked worktree", () => {
  // The design forbids pattern-matching a shell command: the console account's 154 lanes were cut
  // by Codex, so a `worktree add` scan of one agent's log would have observed none of them. This
  // drives the REAL default reader against a REAL registration.
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}adhoc-lane-root-`));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const git = (args: string[], cwd = repo): string => execFileSync("git", args, { cwd, encoding: "utf8", env });
  git(["init", "--quiet", "-b", "main"]);
  writeFileSync(join(repo, "f.txt"), "x\n");
  git(["add", "-A"]);
  git(["commit", "--quiet", "-m", "first"]);
  const outside = join(root, "outside-lane");
  git(["worktree", "add", "--quiet", "-b", "lane", outside]);

  const config = cfg(join(root, "rmd-root"));
  const lanes = unmanagedWorktreeLanes(config, repo); // REAL default reader, no injection
  assert.ok(
    lanes.some((p) => p.endsWith("outside-lane")),
    `a real linked worktree outside both managed roots must be reported — saw ${JSON.stringify(lanes)}`,
  );
  assert.ok(!lanes.includes(repo), "and the main checkout still is not one");
});
