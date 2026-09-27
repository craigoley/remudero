/**
 * W1-T4614 — A COMMIT NAMES THE ASSIGNMENT THAT WROTE IT.
 *
 * A PR head did not say which worker produced it: `implement.done`/`pr.opened` carried no sha and
 * no ledger row named the worker behind a head. Every commit made in a run worktree now carries a
 * `Remudero-Assignment: <selection_assignment_id>` trailer — the harness adds it to its own commits,
 * and a prepare-commit-msg hook adds it to a shell-capable worker's — and a head resolves back to
 * that assignment, or reads `unattributed` when the trailer is absent.
 *
 * Real git in temp repos, with the identity passed through the GIT_AUTHOR_ and GIT_COMMITTER_ variables so a CI
 * runner with no global identity commits exactly as a workstation does.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ASSIGNMENT_TRAILER_KEY,
  commitMessageAssignment,
  recordWorktreeBase,
  resolveCommitAssignment,
  stampAssignmentIfRunWorktree,
  stampRunWorktreeAssignment,
  withAssignmentTrailer,
} from "../src/lib/worker.js";
import { harnessCommitForShellLessWorker, headProvenanceFields } from "../src/run-task.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const saved: Record<string, string | undefined> = {};

// The code under test shells git with the inherited environment, so the identity must be ambient.
before(() => {
  for (const [key, value] of Object.entries(IDENTITY)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});
after(() => {
  for (const key of Object.keys(IDENTITY)) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...IDENTITY },
  });
}

function body(dir: string, rev = "HEAD"): string {
  return git(dir, "log", "-1", "--format=%B", rev);
}

/** A repo whose tracked `hooks/commit-msg` leaves a marker, wired the way `worktreeAdd` wires a run. */
function repoWithTrackedHook(): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}assignment-trailer-`));
  const repo = join(root, "main");
  mkdirSync(join(repo, "hooks"), { recursive: true });
  git(root, "init", "-q", "-b", "main", repo);
  const hook = join(repo, "hooks", "commit-msg");
  writeFileSync(hook, '#!/bin/sh\ntouch "$(git rev-parse --git-dir)/commit-msg-ran"\n');
  chmodSync(hook, 0o755);
  writeFileSync(join(repo, "README.md"), "seed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "chore: seed");
  git(repo, "config", "--local", "extensions.worktreeConfig", "true");
  return repo;
}

/** A linked worktree with the sibling `.base` record `worktreeAdd` writes for every run worktree. */
function runWorktree(repo: string, name: string): string {
  const wt = join(repo, "..", name);
  git(repo, "worktree", "add", "-q", "-b", `run-${name}-1`, "--no-track", wt, "main");
  git(wt, "config", "--worktree", "core.hooksPath", "hooks");
  recordWorktreeBase(wt, git(wt, "rev-parse", "HEAD").trim());
  return wt;
}

describe("W1-T4614: the trailer text", () => {
  it("appends to an existing trailer block, keeps every other trailer, and never duplicates", () => {
    const message = "feat(x): a change\n\nWhy it changed.\n\nRemudero-Task: W1-T1\nCo-Authored-By: A <a@b>";
    const stamped = withAssignmentTrailer(message, "asg-1");
    assert.equal(
      stamped,
      "feat(x): a change\n\nWhy it changed.\n\nRemudero-Task: W1-T1\nCo-Authored-By: A <a@b>\n" +
        `${ASSIGNMENT_TRAILER_KEY}: asg-1`,
    );
    assert.equal(withAssignmentTrailer(stamped, "asg-2"), stamped, "an existing assignment is never overwritten");
    assert.equal(withAssignmentTrailer("fix: y", "asg-1"), `fix: y\n\n${ASSIGNMENT_TRAILER_KEY}: asg-1`);
    assert.equal(withAssignmentTrailer("fix: y\n\nprose body", "asg-1"), `fix: y\n\nprose body\n\n${ASSIGNMENT_TRAILER_KEY}: asg-1`);
    assert.equal(withAssignmentTrailer("fix: y", undefined), "fix: y", "no assignment, no trailer");
  });

  it("reads the assignment back, or unattributed when absent — never guessed", () => {
    assert.equal(commitMessageAssignment(`feat: z\n\n${ASSIGNMENT_TRAILER_KEY}: asg-9\n\nRemudero-Task: W1-T1\n`), "asg-9");
    assert.equal(commitMessageAssignment("feat: z\n\nRemudero-Task: W1-T1\n"), "unattributed");
    assert.equal(commitMessageAssignment(`feat: z mentions ${ASSIGNMENT_TRAILER_KEY}: inline`), "unattributed");
  });
});

describe("W1-T4614: the harness's own commit carries the trailer", () => {
  it("harnessCommitForShellLessWorker stamps the worker's assignment and the head resolves to it", () => {
    const repo = repoWithTrackedHook();
    writeFileSync(join(repo, "README.md"), "edited\n");
    const count = harnessCommitForShellLessWorker(
      {
        harnessOwnsGit: true,
        commitCount: 0,
        report: "REPORT\nCOMMIT_MESSAGE: feat(x): harness commit",
        worktreePath: repo,
        declaredPaths: ["README.md"],
        assignmentId: "asg-harness",
        log: () => {},
        say: () => {},
      },
      { ahead: () => 1 },
    );
    assert.equal(count, 1);
    assert.match(body(repo), /^Remudero-Assignment: asg-harness$/m);
    const head = git(repo, "rev-parse", "HEAD").trim();
    assert.equal(resolveCommitAssignment(repo, head), "asg-harness");
    assert.deepEqual(headProvenanceFields(repo), { head_sha: head, head_assignment: "asg-harness" });
  });
});

describe("W1-T4614: a shell-capable worker's commit is stamped by the run worktree's hook", () => {
  it("every commit in a run worktree carries the current assignment; repo hooks still run; other trailers kept", () => {
    const repo = repoWithTrackedHook();
    const wt = runWorktree(repo, "wt-a");
    assert.equal(stampAssignmentIfRunWorktree(wt, "asg-impl"), true);

    writeFileSync(join(wt, "a.txt"), "a\n");
    git(wt, "add", "a.txt");
    git(wt, "commit", "-q", "-m", "feat(a): worker commit\n\nRemudero-Task: W1-T1\nCo-Authored-By: W <w@w>");
    const message = body(wt);
    assert.match(message, /^Remudero-Task: W1-T1$/m);
    assert.match(message, /^Co-Authored-By: W <w@w>$/m);
    assert.match(message, /^Remudero-Assignment: asg-impl$/m);
    const gitDir = git(wt, "rev-parse", "--path-format=absolute", "--git-dir").trim();
    assert.ok(existsSync(join(gitDir, "commit-msg-ran")), "the tracked commit-msg hook still ran");

    // --no-verify skips commit-msg, never prepare-commit-msg: the worker cannot opt out.
    writeFileSync(join(wt, "b.txt"), "b\n");
    git(wt, "add", "b.txt");
    git(wt, "commit", "-q", "--no-verify", "-m", "feat(b): unverified");
    assert.equal(resolveCommitAssignment(wt, git(wt, "rev-parse", "HEAD").trim()), "asg-impl");

    // A later spawn (a fix worker) re-stamps; its commits name it, and an amend keeps the author.
    assert.equal(stampAssignmentIfRunWorktree(wt, "asg-fix"), true);
    writeFileSync(join(wt, "c.txt"), "c\n");
    git(wt, "add", "c.txt");
    git(wt, "commit", "-q", "-m", "fix(c): fix worker commit");
    assert.equal(resolveCommitAssignment(wt, "HEAD"), "asg-fix");
    git(wt, "commit", "-q", "--amend", "-m", `${body(wt).trimEnd()}\n\nRemudero-Task: W1-T1\n`);
    const amended = body(wt);
    assert.equal(amended.match(/^Remudero-Assignment:/gm)?.length, 1, "an amend never adds a second assignment");
    assert.equal(commitMessageAssignment(amended), "asg-fix");
  });

  it("a commit made outside a run is untouched and reads unattributed", () => {
    const repo = repoWithTrackedHook();
    const wt = runWorktree(repo, "wt-b");
    assert.equal(stampAssignmentIfRunWorktree(wt, "asg-run"), true);
    assert.equal(stampAssignmentIfRunWorktree(repo, "asg-run"), false, "the canonical checkout is not a run worktree");

    writeFileSync(join(repo, "outside.txt"), "o\n");
    git(repo, "add", "outside.txt");
    git(repo, "commit", "-q", "-m", "chore: operator commit");
    assert.doesNotMatch(body(repo), /Remudero-Assignment/);
    assert.equal(resolveCommitAssignment(repo, git(repo, "rev-parse", "HEAD").trim()), "unattributed");
    assert.deepEqual(headProvenanceFields(repo).head_assignment, "unattributed");
  });

  it("refuses an id that is not a plain token, installing nothing", () => {
    const repo = repoWithTrackedHook();
    const wt = runWorktree(repo, "wt-c");
    assert.equal(stampRunWorktreeAssignment(wt, "bad id; rm -rf /"), false);
    mkdirSync(join(wt, "sub"));
    assert.equal(stampRunWorktreeAssignment(join(wt, "sub"), "asg-sub"), false, "a subdirectory never stamps its enclosing repo");
    writeFileSync(join(wt, "d.txt"), "d\n");
    git(wt, "add", "d.txt");
    git(wt, "commit", "-q", "-m", "feat(d): no assignment");
    assert.equal(resolveCommitAssignment(wt, "HEAD"), "unattributed");
  });

  it("a base-recorded dir git cannot read is not stamped, and the spawn is not refused", () => {
    const notARepo = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}assignment-norepo-`));
    recordWorktreeBase(notARepo, "0".repeat(40));
    assert.equal(stampAssignmentIfRunWorktree(notARepo, "asg-x"), false);
  });

  it("an unreadable head reads unreadable, never unattributed, and carries no sha", () => {
    const empty = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}assignment-none-`));
    assert.equal(resolveCommitAssignment(empty, "HEAD"), "unreadable");
    assert.deepEqual(headProvenanceFields(empty), {});
  });
});
