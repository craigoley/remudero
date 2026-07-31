import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { worktreeAdd } from "../src/lib/worker.js";

// ── W1-T137: STOP a worker committing a malformed message in its OWN worktree ──
//
// PR #407 shipped the instructional half (commitMessageContractLines(), embedded in the
// worker OUTPUT CONTRACT and every fix-rung prompt) and a harness-side shaping helper for
// the two sites where the HARNESS builds a commit header (plan-architect.ts, triage.ts).
// It explicitly left one thing unbuilt: policing a message a worker LLM authors itself via
// its own `git commit`. The only backstop left was `commitlint` in CI -- and #830
// (W1-T129, see test/commitlint-mode.test.ts) relocated that job to lint the PR TITLE only,
// not any branch commit, since this repo squash-merges everything.
//
// This suite proves the REAL fix end-to-end against the REAL `commitlint` CLI and this
// repo's own commitlint.config.mjs (never a reimplementation of its rules), using a real,
// throwaway git repo: `worktreeAdd` (src/lib/worker.ts) is exercised for real, so a passing
// suite here proves the actual production wiring -- not a mock of it.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const HAS_COMMITLINT = existsSync(join(REPO_ROOT, "node_modules", ".bin", "commitlint"));

/** A real, throwaway BARE "origin" seeded with THIS repo's own hooks/commit-msg and
 *  commitlint.config.mjs -- both are TRACKED files in the real repo, so `git worktree add`
 *  checks them into every worktree exactly like this fixture does. `worktreeAdd`'s own
 *  `git fetch origin` / `git worktree add ... origin/main` run for real, entirely offline. */
function commitMsgHookFixture(root: string): { repoDir: string } {
  const originGit = mkdtempSync(join(tmpdir(), "commitmsg-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", originGit]);

  const seed = mkdtempSync(join(tmpdir(), "commitmsg-seed-"));
  execFileSync("git", ["clone", "-q", originGit, seed]);
  execFileSync("git", ["-C", seed, "config", "user.email", "commitmsg-test@example.invalid"]);
  execFileSync("git", ["-C", seed, "config", "user.name", "commitmsg-test"]);

  mkdirSync(join(seed, "hooks"), { recursive: true });
  writeFileSync(join(seed, "hooks", "commit-msg"), readFileSync(join(REPO_ROOT, "hooks", "commit-msg")));
  chmodSync(join(seed, "hooks", "commit-msg"), 0o755);
  writeFileSync(
    join(seed, "commitlint.config.mjs"),
    readFileSync(join(REPO_ROOT, "commitlint.config.mjs")),
  );
  writeFileSync(join(seed, "package.json"), "{}\n");
  writeFileSync(join(seed, "README.md"), "seed\n");

  execFileSync("git", ["-C", seed, "add", "-A"]);
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "chore: seed the fixture repo"]);
  execFileSync("git", ["-C", seed, "push", "-q", "origin", "main"]);

  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", originGit, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "commitmsg-test@example.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "commitmsg-test"]);
  return { repoDir };
}

/** Reuse the REAL, already-installed commitlint under REPO_ROOT instead of paying for a
 *  fresh `npm ci` per worktree -- production worktrees get their own via `ensureDeps`
 *  (src/lib/review.ts) lazily; this test only needs the binary to exist to prove the hook
 *  actually gates, not to prove npm install works. */
function symlinkNodeModules(worktreePath: string): void {
  // IDEMPOTENT since W1-T137's gap was closed: `worktreeAdd` now supplies this link itself
  // (linkWorktreeNodeModules, src/lib/worker.ts) because the hook below rejects EVERY commit
  // without it. These tests still call this explicitly to state the precondition they rely on.
  if (existsSync(join(worktreePath, "node_modules"))) return;
  symlinkSync(join(REPO_ROOT, "node_modules"), join(worktreePath, "node_modules"), "dir");
}

function commitCount(dir: string): number {
  return Number(
    execFileSync("git", ["-C", dir, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim(),
  );
}

function tryCommit(dir: string, message: string): { status: number; stderr: string } {
  writeFileSync(join(dir, `f-${commitCount(dir)}.txt`), `${Date.now()}\n`);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  const result = spawnSync("git", ["-C", dir, "commit", "-m", message], { encoding: "utf8" });
  return { status: result.status ?? 1, stderr: result.stderr ?? "" };
}

test("worktreeAdd wires core.hooksPath=hooks so a fresh worktree resolves its OWN tracked hooks/commit-msg", () => {
  const root = mkdtempSync(join(tmpdir(), "commitmsg-run-"));
  const { repoDir } = commitMsgHookFixture(root);
  const worktreePath = join(root, "worktrees", "run-a");
  worktreeAdd(repoDir, worktreePath, "run-a");

  const hooksPath = execFileSync("git", ["-C", worktreePath, "config", "--get", "core.hooksPath"], {
    encoding: "utf8",
  }).trim();
  assert.equal(hooksPath, "hooks", "worktreeAdd must set a RELATIVE core.hooksPath (resolves per-worktree)");

  const hookFile = join(worktreePath, "hooks", "commit-msg");
  assert.ok(existsSync(hookFile), "the worktree's own checkout must contain hooks/commit-msg");
  assert.ok(statSync(hookFile).mode & 0o111, "hooks/commit-msg must be executable in the checkout");
});

test(
  "commit-msg hook: a conventional message is ACCEPTED, and the SAME malformed message that is " +
    "BLOCKED with the hook wired SUCCEEDS once it is disabled -- the falsifier proving this is " +
    "real enforcement, not a hook that always passes",
  { skip: HAS_COMMITLINT ? false : "requires node_modules/.bin/commitlint (run npm ci first)" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "commitmsg-run-"));
    const { repoDir } = commitMsgHookFixture(root);
    const worktreePath = join(root, "worktrees", "run-b");
    worktreeAdd(repoDir, worktreePath, "run-b");
    symlinkNodeModules(worktreePath);

    const before = commitCount(worktreePath);
    const good = tryCommit(worktreePath, "feat(hook): add a conventional commit");
    assert.equal(good.status, 0, `expected a conventional commit to be accepted:\n${good.stderr}`);
    assert.equal(commitCount(worktreePath), before + 1);

    // Verbatim shape of PR #405 (W1-T157): 124 chars AND an upper-case subject.
    const malformed =
      "feat(serve): FIND layer — fuzzy search, faceted filters, sortable columns, cmd+K palette, URL-persisted view state (W1-T157)";
    const blockedCount = commitCount(worktreePath);
    const blocked = tryCommit(worktreePath, malformed);
    assert.notEqual(blocked.status, 0, "a malformed message must be REJECTED before it becomes a commit");
    assert.match(blocked.stderr, /header-max-length|subject-case/);
    assert.equal(
      commitCount(worktreePath),
      blockedCount,
      "a rejected commit-msg hook must leave HEAD unchanged -- nothing was created to amend or rewrite",
    );

    // Disable enforcement and retry the IDENTICAL message: it now succeeds. This is the
    // counterfactual half of the falsifier -- proof the block above came from the hook,
    // not from something else about the message (a stray typo, a bad fixture, etc).
    execFileSync("git", ["-C", worktreePath, "config", "--unset", "core.hooksPath"]);
    const unenforced = tryCommit(worktreePath, malformed);
    assert.equal(
      unenforced.status,
      0,
      `with the hook disabled the SAME message must succeed (reproduces the pre-W1-T137 gap):\n${unenforced.stderr}`,
    );
    assert.equal(commitCount(worktreePath), blockedCount + 1);
  },
);

test(
  "commit-msg hook: FAILS LOUD when commitlint isn't installed -- never silently lets a message through",
  () => {
    const root = mkdtempSync(join(tmpdir(), "commitmsg-run-"));
    const { repoDir } = commitMsgHookFixture(root);
    const worktreePath = join(root, "worktrees", "run-c");
    worktreeAdd(repoDir, worktreePath, "run-c");
    // Deliberately STRIP the node_modules back out. This test asserts a property of the HOOK
    // -- that a missing commitlint blocks loudly rather than skipping the gate -- so it must
    // construct that condition explicitly. It used to get it for free, because `worktreeAdd`
    // supplied no node_modules at all; that was the W1-T137 gap (every real worktree commit
    // was rejected from 2026-07-29 on), and it is fixed. Unlinking removes the LINK, never
    // the shared install it points at.
    rmSync(join(worktreePath, "node_modules"), { force: true });

    const before = commitCount(worktreePath);
    const result = tryCommit(worktreePath, "feat(hook): would be fine if it ever ran");
    assert.notEqual(result.status, 0, "missing commitlint must BLOCK, not silently skip, the gate");
    assert.match(result.stderr, /npm ci/, "the failure must tell the worker the actionable next step");
    assert.equal(commitCount(worktreePath), before, "no commit is created when the gate cannot run");
  },
);

test(
  "commit-msg hook: a synthesized 3-commit branch (initial + 2 fix rounds), all conventional, " +
    "lints CLEAN over origin/main..HEAD with enforcement on",
  { skip: HAS_COMMITLINT ? false : "requires node_modules/.bin/commitlint (run npm ci first)" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "commitmsg-run-"));
    const { repoDir } = commitMsgHookFixture(root);
    const worktreePath = join(root, "worktrees", "run-d");
    worktreeAdd(repoDir, worktreePath, "run-d");
    symlinkNodeModules(worktreePath);

    const rounds = [
      "feat(hook): implement the commit-msg gate (W1-T137 round 1)",
      "fix(hook): address review feedback (W1-T137 round 2)",
      "fix(hook): satisfy the last falsifier (W1-T137 round 3)",
    ];
    for (const message of rounds) {
      const result = tryCommit(worktreePath, message);
      assert.equal(result.status, 0, `round commit must be accepted: ${message}\n${result.stderr}`);
    }

    assert.equal(
      Number(
        execFileSync("git", ["-C", worktreePath, "rev-list", "--count", "origin/main..HEAD"], {
          encoding: "utf8",
        }).trim(),
      ),
      3,
      "all 3 rounds must be real, distinct commits on top of origin/main",
    );

    const rangeLog = execFileSync(
      "git",
      ["-C", worktreePath, "log", "--format=%B%x00", "origin/main..HEAD"],
      { encoding: "utf8" },
    );
    for (const header of rangeLog.split("\0").map((m) => m.trim()).filter(Boolean)) {
      const lint = spawnSync(
        join(worktreePath, "node_modules", ".bin", "commitlint"),
        ["--config", join(worktreePath, "commitlint.config.mjs")],
        { input: header, encoding: "utf8" },
      );
      assert.equal(lint.status, 0, `every commit in the range must independently lint clean:\n${header}`);
    }
  },
);
