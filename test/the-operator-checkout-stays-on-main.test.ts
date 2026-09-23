import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// W1-T4082 — "the operator checkout stays on main" was written guidance only. OBSERVED 2026-09-22:
// an interactive session left ~/Remudero/remudero on run-W1-T4051-… and later run-W1-T4063-… while
// another session relied on it being main. The deny floor now refuses the switch itself.

const HOOK = fileURLToPath(new URL("../hooks/deny-floor.sh", import.meta.url));

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
}

/** An operator-shaped checkout (a real `.git` directory, remudero origin) plus a worktree of it, and a
 *  checkout of an unrelated repo as the control. */
function fixture(): { root: string; operator: string; worktree: string; other: string; subdir: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-opcheckout-")));
  const operator = join(root, "remudero");
  const other = join(root, "elsewhere");
  for (const [dir, origin] of [[operator, "https://github.com/craigoley/remudero.git"], [other, "https://github.com/someone/elsewhere.git"]]) {
    execFileSync("git", ["init", "-q", "-b", "main", dir]);
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    writeFileSync(join(dir, "README.md"), "x\n");
    git(dir, "add", "README.md");
    git(dir, "commit", "-q", "-m", "init");
    git(dir, "remote", "add", "origin", origin);
  }
  const subdir = join(operator, "src");
  mkdirSync(subdir);
  const worktree = join(root, "wt-feature");
  git(operator, "worktree", "add", "-q", "-b", "feature", worktree);
  return { root, operator, worktree, other, subdir };
}

function run(command: string, cwd: string): { status: number | null; stderr: string } {
  const cache = mkdtempSync(join(tmpdir(), "rmd-opcheckout-cache-"));
  try {
    const r = spawnSync("bash", [HOOK], {
      cwd,
      input: JSON.stringify({ cwd, tool_input: { command } }),
      encoding: "utf8",
      env: { ...process.env, XDG_CACHE_HOME: cache },
    });
    return { status: r.status, stderr: r.stderr };
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}

test("W1-T4082: a branch switch in the operator checkout is refused", () => {
  const f = fixture();
  try {
    for (const command of [
      "git checkout -b feat/x",
      "git checkout -B feat/x",
      "git switch run-W1-T4051-1790104408479",
      "git switch -c feat/y",
      "git checkout run-W1-T4063-1790113484225",
      "git branch -m renamed",
      `git -C ${f.operator} checkout -b z`,
      `cd ${f.worktree} && cd ${f.operator} && git status && git switch -c q`,
    ]) {
      const r = run(command, f.operator);
      assert.equal(r.status, 2, command);
      assert.match(r.stderr, /operator checkout/);
      assert.match(r.stderr, /git worktree add/, "the refusal names the way forward");
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("W1-T4082: checkout --detach is refused in the operator checkout", () => {
  const f = fixture();
  try {
    const r = run("git checkout --detach", f.operator);
    assert.equal(r.status, 2, "detaching leaves the operator checkout off main");
    assert.match(r.stderr, /operator checkout/);
    assert.match(r.stderr, /git worktree add/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("W1-T4082: git from a repository subdirectory still resolves the operator checkout", () => {
  const f = fixture();
  try {
    for (const [command, cwd] of [
      [`git -C ${f.subdir} switch -c nested-cwd`, f.operator],
      [`cd ${f.subdir} && git switch -c nested-cd`, f.operator],
      [`cd ${f.operator} && git -C src switch -c nested-relative`, f.root],
      [`cd ${f.operator} && git -C "${f.subdir}" switch -c nested-quoted`, f.root],
    ]) {
      const r = run(command, cwd);
      assert.equal(r.status, 2, command);
      assert.match(r.stderr, /operator checkout/);
      assert.match(r.stderr, /git worktree add/);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("W1-T4082: a worktree may switch branches", () => {
  const f = fixture();
  try {
    for (const [command, cwd] of [
      ["git checkout -b feat/x", f.worktree],
      ["git switch -c feat/y", f.worktree],
      [`cd ${f.worktree} && git checkout -b feat/z`, f.operator],
      [`git -C ${f.worktree} switch -c feat/w`, f.operator],
      ["git checkout -b feat/x", f.other],
    ] as const) {
      assert.equal(run(command, cwd).status, 0, `${command} @ ${cwd}`);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("W1-T4082: path restores and pulls stay allowed", () => {
  const f = fixture();
  try {
    for (const command of [
      "git checkout main",
      "git switch main",
      "git checkout -- README.md",
      "git checkout README.md",
      "git checkout HEAD -- README.md",
      "git pull --ff-only",
      "git status && git log --oneline -1",
      "git branch --show-current",
    ]) {
      assert.equal(run(command, f.operator).status, 0, command);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
