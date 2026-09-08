/**
 * test/helpers/git-repo.test.ts — W1-T2903 acceptance: "a shared git repository fixture sets the
 * identity env and honours the tmp hygiene shim."
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { test } from "node:test";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "./git-repo.js";
import { RMD_TMP_PREFIX } from "../../src/lib/tmp.js";

// ── identity: set on every commit, even with NO ambient config to fall back to ──────────────────

test("gitRepo: a commit is authored by the fixture's OWN identity, never the host's", () => {
  const repo = gitRepo();
  const authorLine = repo.git("log", "-1", "--format=%an <%ae>");
  assert.equal(authorLine, `${GIT_REPO_FIXTURE_IDENTITY.name} <${GIT_REPO_FIXTURE_IDENTITY.email}>`);
  const committerLine = repo.git("log", "-1", "--format=%cn <%ce>");
  assert.equal(committerLine, `${GIT_REPO_FIXTURE_IDENTITY.name} <${GIT_REPO_FIXTURE_IDENTITY.email}>`);
});

test("gitRepo: THE FALSIFIER — a bare `git commit` with NO identity env, stripped exactly the way CI is stripped, refuses (proving the fixture's env is what makes the test above pass, not an ambient config)", () => {
  const repo = gitRepo({ seedCommit: false });
  // CLAUDE.md's own reproduction recipe for the CI-stripped condition (#1971, after #1964 failed
  // the same way): neither system nor global config, and the repo's own user.name/user.email
  // unset — the exact shape `actions/checkout` leaves a fresh clone in.
  const strippedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    HOME: repo.dir, // no ~/.gitconfig to fall back to either
  };
  delete strippedEnv.GIT_AUTHOR_NAME;
  delete strippedEnv.GIT_AUTHOR_EMAIL;
  delete strippedEnv.GIT_COMMITTER_NAME;
  delete strippedEnv.GIT_COMMITTER_EMAIL;
  assert.throws(
    () =>
      execFileSync("git", ["-C", repo.dir, "commit", "--quiet", "--allow-empty", "-m", "no identity"], {
        encoding: "utf8",
        env: strippedEnv,
      }),
    /Author identity unknown|unable to auto-detect/,
    "a commit with genuinely no identity anywhere must refuse — the control for the test above",
  );
});

// ── tmp hygiene: routed through the suite's own mkdtempSync (test/setup/tmp-hygiene.ts) ─────────

test("gitRepo: its directory is a direct child of the OS tmp root, honouring the suite's tmp-hygiene sweep", () => {
  const repo = gitRepo();
  assert.equal(resolve(dirname(repo.dir)), resolve(tmpdir()));
  // This fixture prefixes with RMD_TMP_PREFIX itself (see the module doc's "TMP HYGIENE, TWO
  // LAYERS"), so src/lib/tmp.ts's production boot sweep can reap it directly — with no dependence
  // on test/setup/tmp-hygiene.ts's runtime normalization, which is only ever a backstop for a
  // BARE prefix. Asserting the prefix — not merely that the dir exists — is what proves gitRepo's
  // own mkdtempSync call carries it, rather than this fixture happening to also work if it didn't.
  assert.ok(
    basename(repo.dir).startsWith(RMD_TMP_PREFIX),
    `expected ${basename(repo.dir)} to start with ${RMD_TMP_PREFIX} — src/lib/tmp.ts's own sweep marker`,
  );
});

test("gitRepo: cleanup() removes the directory", () => {
  const repo = gitRepo();
  assert.ok(existsSync(repo.dir));
  repo.cleanup();
  assert.ok(!existsSync(repo.dir));
  assert.doesNotThrow(() => repo.cleanup(), "cleanup must be safe to call twice");
});

// ── shapes: bare / worktree / remote ─────────────────────────────────────────────────────────

test("gitRepo({ bare: true }): a bare repo has no working tree and seeds no commit", () => {
  const bare = gitRepo({ bare: true });
  assert.equal(bare.git("rev-parse", "--is-bare-repository"), "true");
  assert.throws(() => bare.git("log", "-1"), /does not have any commits yet|bad default revision/);
});

test("gitRepo: addRemote wires a remote whose url resolves back to another gitRepo's dir", () => {
  const origin = gitRepo({ bare: true });
  const local = gitRepo(); // seedCommit defaults true — needs a real HEAD to push
  local.addRemote("origin", origin.dir);
  assert.equal(local.git("remote", "get-url", "origin"), origin.dir);
  local.git("push", "origin", "HEAD:main");
  assert.equal(origin.git("rev-parse", "main"), local.git("rev-parse", "HEAD"));
});

test("gitRepo: addWorktree checks out a new branch at a second path, sharing the fixture's identity", () => {
  const repo = gitRepo();
  const worktreeDir = `${repo.dir}-wt`;
  const worktree = repo.addWorktree(worktreeDir, "feature");
  assert.equal(worktree.dir, worktreeDir);
  assert.equal(worktree.git("rev-parse", "--abbrev-ref", "HEAD"), "feature");
  // the worktree is a real second working copy of the SAME repo, not an independent clone
  assert.equal(worktree.git("rev-parse", "HEAD"), repo.git("rev-parse", "HEAD"));
  const authorLine = worktree.git("log", "-1", "--format=%ae");
  assert.equal(authorLine, GIT_REPO_FIXTURE_IDENTITY.email);
});

test("gitRepo({ cloneFrom }): clones an existing repo rather than initializing an empty one", () => {
  const origin = gitRepo();
  origin.git("commit", "--quiet", "--allow-empty", "-m", "second commit");
  const clone = gitRepo({ cloneFrom: origin.dir });
  assert.equal(clone.git("rev-parse", "HEAD"), origin.git("rev-parse", "HEAD"));
  assert.equal(clone.git("log", "--format=%H"), origin.git("log", "--format=%H"));
});
