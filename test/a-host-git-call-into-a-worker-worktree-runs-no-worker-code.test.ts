/**
 * W1-T6106 — A HOST GIT CALL INTO A WORKER WORKTREE RUNS NO WORKER CODE.
 *
 * The daemon commits, diffs and pushes inside worktrees a worker writes. A raw `git -C <worktree>`
 * follows the worktree's `.git` pointer (so a planted gitdir's `core.fsmonitor` runs) and its
 * `core.hooksPath=hooks` (so the TRACKED hooks/ the worker edits run, pre-push included, as the daemon,
 * with its push credentials). Through the hardened leaf neither runs, the legitimate commit and push
 * still land, and the pre-push gate runs from the HARNESS's copy.
 *
 * FIXTURES ONLY: every hostile byte below is a `touch` of a marker under this suite's own mkdtemp
 * root, in repositories that root holds. Each hostile route is proven LIVE by a raw `git -C` control
 * first, so a marker that stays absent through the leaf is evidence, not an inert fixture.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as gitPush from "../src/lib/git-push.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { recordWorktreeBase, stampRunWorktreeAssignment, worktreeAdd } from "../src/lib/worker.js";
import * as provider from "../src/lib/worker-provider.js";
import { appendTaskTrailerToCommit, commitWorkerEdits } from "../src/run-task.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "./helpers/git-repo.js";

// The leaf is loaded in `before`, so at a base without it every subtest fails rather than the file.
type Leaf = typeof import("../src/lib/worktree-git.js");
let leaf: Leaf;
const { gitPushRunBranch, gitPushRunBranchAsync, PushFailedError, worktreeGitCapture, worktreePushExec } = gitPush as typeof gitPush;
const openWeightWritablePath: typeof provider.openWeightWritablePath = (...a) => provider.openWeightWritablePath(...a);
const leafGit: Leaf["hostWorktreeGit"] = (...a) => leaf.hostWorktreeGit(...a);
const pinnedConfigValue: Leaf["pinnedConfigValue"] = (...a) => leaf.pinnedConfigValue(...a);
const pinLane: Leaf["pinWorktreeGit"] = (...a) => leaf.pinWorktreeGit(...a);
const recordedGitDir: Leaf["recordedWorktreeGitDir"] = (...a) => leaf.recordedWorktreeGitDir(...a);
const isPointerRefusal = (e: unknown): boolean => e instanceof leaf.WorktreePointerRefusedError;

let root: string;
let markers: string;
let harnessHooks: string;
const savedHooksDir = process.env.RMD_HARNESS_HOOKS_DIR;
let counter = 0;

function raw(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function marker(name: string): string {
  return join(markers, name);
}

function script(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

/** A seeded origin + checkout whose TRACKED hooks/ each leave a marker, and a run worktree cut from it by
 *  the real `worktreeAdd` (which records the gitdir and wires `core.hooksPath=hooks`). */
function cutLane(): { wt: string; branch: string; remote: string; seed: string } {
  const n = ++counter;
  const remote = gitRepo({ bare: true, kind: `t6106-remote-${n}` }).dir;
  const seed = gitRepo({ kind: `t6106-seed-${n}` });
  seed.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  seed.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  mkdirSync(join(seed.dir, "hooks"));
  for (const hook of ["pre-push", "pre-commit", "commit-msg", "prepare-commit-msg", "post-commit"]) {
    script(join(seed.dir, "hooks", hook), `touch '${marker(`tracked-${hook}-${n}`)}'`);
  }
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "chore: seed");
  seed.addRemote("origin", remote);
  seed.git("push", "-q", "origin", "main");
  const wt = join(root, `t6106-wt-${n}`);
  const branch = `run-T6106-${n}-1`;
  worktreeAdd(seed.dir, wt, branch, "origin/main", { readRemoteHead: () => seed.git("rev-parse", "HEAD"), warn: () => {} });
  return { wt, branch, remote, seed: seed.dir };
}

/** A crafted gitdir outside the worktree whose config runs a marker on every index refresh and on every hook. */
function plantGitDir(name: string): string {
  const evil = join(root, `planted-${name}`);
  raw(root, "init", "-q", evil);
  const hooks = join(evil, "evil-hooks");
  mkdirSync(hooks);
  for (const hook of ["pre-push", "pre-commit", "commit-msg", "prepare-commit-msg"]) script(join(hooks, hook), `touch '${marker(`planted-hook-${name}`)}'`);
  raw(evil, "config", "core.fsmonitor", `sh -c 'touch "${marker(`planted-fsmonitor-${name}`)}"'`);
  raw(evil, "config", "core.hooksPath", hooks);
  return join(evil, ".git");
}

before(async () => {
  leaf = await import("../src/lib/worktree-git.js");
  root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t6106-`));
  markers = join(root, "markers");
  harnessHooks = join(root, "harness-hooks");
  mkdirSync(markers);
  mkdirSync(harnessHooks);
  process.env.RMD_HARNESS_HOOKS_DIR = harnessHooks;
});

after(() => {
  if (savedHooksDir === undefined) delete process.env.RMD_HARNESS_HOOKS_DIR;
  else process.env.RMD_HARNESS_HOOKS_DIR = savedHooksDir;
  rmSync(root, { recursive: true, force: true });
});

describe("W1-T6106: the worktree's tracked hooks never run on a host commit or push", () => {
  it("the controls: a raw git -C commit and push in the same worktree DO run the tracked hooks", () => {
    const { wt } = cutLane();
    const n = counter;
    writeFileSync(join(wt, "control.txt"), "c\n");
    raw(wt, "add", "control.txt");
    raw(wt, "commit", "-q", "-m", "feat: control");
    raw(wt, "push", "-q", "origin", "HEAD");
    for (const hook of ["pre-commit", "commit-msg", "pre-push"]) {
      assert.ok(existsSync(marker(`tracked-${hook}-${n}`)), `control: the raw call ran the worktree's tracked ${hook}`);
    }
  });

  it("a host commit, trailer amend and push land, run none of them, and run the HARNESS's pre-push with git's stdin line", async () => {
    const { wt, branch, remote } = cutLane();
    const n = counter;
    const stdinLog = join(root, `harness-stdin-${n}`);
    script(join(harnessHooks, "pre-push"), `touch '${marker(`harness-pre-push-${n}`)}'\ncat >> '${stdinLog}'\nexit 0`);

    writeFileSync(join(wt, "a.txt"), "a\n");
    const commit = commitWorkerEdits(wt, ["a.txt"], "feat(a): the harness commits a worker's edit");
    assert.equal(commit.committed, true, commit.reason);
    withLiveWritesAllowed(() => gitPushRunBranch(wt));
    assert.equal(raw(remote, "rev-parse", `refs/heads/${branch}`).trim(), commit.sha, "the push landed the commit");

    assert.equal(appendTaskTrailerToCommit(wt, "W1-T6106"), true, "the trailer amend still lands");
    const amended = raw(wt, "rev-parse", "HEAD").trim();
    await withLiveWritesAllowed(() => gitPushRunBranchAsync(wt, { force: true }));
    assert.equal(raw(remote, "rev-parse", `refs/heads/${branch}`).trim(), amended, "the leased force push landed the amend");

    for (const hook of ["pre-push", "pre-commit", "commit-msg", "prepare-commit-msg", "post-commit"]) {
      assert.equal(existsSync(marker(`tracked-${hook}-${n}`)), false, `the worktree's tracked ${hook} never ran`);
    }
    assert.ok(existsSync(marker(`harness-pre-push-${n}`)), "the pre-push gate ran from the harness copy");
    const lines = readFileSync(stdinLog, "utf8").trim().split("\n");
    assert.equal(lines.length, 2, "one gate run per push");
    assert.equal(lines[0], `refs/heads/${branch} ${commit.sha} refs/heads/${branch} ${"0".repeat(40)}`);
    assert.equal(lines[1], `refs/heads/${branch} ${amended} refs/heads/${branch} ${commit.sha}`);
  });

  it("a refusal by the harness gate refuses the push in the shape the daemon classifies, and nothing lands", () => {
    const { wt, branch, remote } = cutLane();
    script(join(harnessHooks, "pre-push"), "echo 'census-precheck: this branch grows 1 census count(s)' >&2\nexit 1");
    writeFileSync(join(wt, "b.txt"), "b\n");
    assert.equal(commitWorkerEdits(wt, ["b.txt"], "feat(b): refused").committed, true);
    assert.throws(() => withLiveWritesAllowed(() => gitPushRunBranch(wt, { stdio: "ignore" })), (e: unknown) =>
      e instanceof PushFailedError && /^Command failed: git -C \S+ push /m.test(e.message) && /^census-precheck:/m.test(e.message));
    assert.throws(() => raw(remote, "rev-parse", "--verify", `refs/heads/${branch}`), "nothing was pushed");
  });

  it("the W1-T4614 assignment trailer still lands on a host commit, from the harness's host hook", () => {
    const { wt } = cutLane();
    const n = counter;
    assert.equal(stampRunWorktreeAssignment(wt, "asg-6106"), true);
    writeFileSync(join(wt, "c.txt"), "c\n");
    assert.equal(commitWorkerEdits(wt, ["c.txt"], "feat(c): stamped").committed, true);
    assert.match(raw(wt, "log", "-1", "--format=%B"), /^Remudero-Assignment: asg-6106$/m);
    assert.equal(existsSync(marker(`tracked-commit-msg-${n}`)), false, "the stamp's delegation to the tracked hooks never ran");
  });
});

describe("W1-T6106: a rewritten .git pointer is refused before git runs", () => {
  it("worktreeAdd records the gitdir it cut, and the leaf pins to it", () => {
    const { wt } = cutLane();
    const recorded = recordedGitDir(wt);
    assert.ok(recorded, "the base record names a gitdir");
    assert.equal(pinLane(wt).gitDir, recorded);
    assert.equal(pinLane(wt).source, "recorded");
  });

  it("the control: a raw git -C status in a worktree pointing at the planted gitdir runs its fsmonitor", () => {
    const { wt } = cutLane();
    writeFileSync(join(wt, ".git"), `gitdir: ${plantGitDir("control")}\n`);
    raw(wt, "status", "--porcelain");
    assert.ok(existsSync(marker("planted-fsmonitor-control")), "control: the planted core.fsmonitor command is live");
  });

  it("commit, diff, push and stamp through the leaf all refuse, and no planted marker is written", async () => {
    const { wt, branch, remote } = cutLane();
    const n = counter;
    writeFileSync(join(wt, "d.txt"), "d\n");
    writeFileSync(join(wt, ".git"), `gitdir: ${plantGitDir("leaf")}\n`);
    const refused = (e: unknown) => isPointerRefusal(e) && /no longer names the gitdir worktreeAdd recorded/.test((e as Error).message);
    const rows: string[] = [];
    assert.throws(() => leafGit(wt, ["diff", "HEAD"], { log: (step) => rows.push(step) }), refused);
    assert.deepEqual(rows, ["worktree_git.pointer_refused"], "the refusal writes its row");
    assert.throws(() => commitWorkerEdits(wt, ["d.txt"], "feat(d): never"), refused);
    assert.throws(() => withLiveWritesAllowed(() => gitPushRunBranch(wt)), refused);
    await assert.rejects(withLiveWritesAllowed(() => gitPushRunBranchAsync(wt)), refused);
    assert.equal(stampRunWorktreeAssignment(wt, "asg-planted"), false, "the stamp writes nothing through a refused pointer");
    assert.equal(existsSync(marker("planted-fsmonitor-leaf")), false, "the planted fsmonitor never ran");
    assert.equal(existsSync(marker("planted-hook-leaf")), false, "no planted hook ran");
    assert.equal(existsSync(marker(`tracked-pre-push-${n}`)), false, "the tracked pre-push never ran");
    assert.throws(() => raw(remote, "rev-parse", "--verify", `refs/heads/${branch}`), "nothing was pushed");
  });

  it("an UNRECORDED worktree whose pointer names a gitdir planted inside it is refused too", () => {
    const { wt } = cutLane();
    const planted = join(wt, "planted");
    raw(wt, "init", "-q", planted);
    raw(planted, "config", "core.fsmonitor", `sh -c 'touch "${marker("planted-inside")}"'`);
    recordWorktreeBase(wt, raw(wt, "rev-parse", "HEAD").trim());
    writeFileSync(join(wt, ".git"), `gitdir: ${join(planted, ".git")}\n`);
    assert.equal(recordedGitDir(wt), null);
    assert.throws(() => leafGit(wt, ["status"], { log: () => {} }), isPointerRefusal);
    assert.equal(existsSync(marker("planted-inside")), false);
  });

  it("code-executing config in the pinned gitdir's own config is disabled, while its credential helper stays", () => {
    const { wt } = cutLane();
    raw(wt, "config", "--worktree", "core.fsmonitor", `sh -c 'touch "${marker("pinned-fsmonitor")}"'`);
    raw(wt, "config", "--worktree", "credential.helper", "!fixture-credential-helper");
    writeFileSync(join(wt, "e.txt"), "e\n");
    leafGit(wt, ["status", "--porcelain"]);
    assert.equal(existsSync(marker("pinned-fsmonitor")), false, "the leaf disabled core.fsmonitor");
    assert.ok(leafGit(wt, ["config", "--get-all", "credential.helper"]).split("\n").includes("!fixture-credential-helper"),
      "the daemon-written credential helper a push authenticates through is still visible to the leaf");
    raw(wt, "status", "--porcelain");
    assert.ok(existsSync(marker("pinned-fsmonitor")), "control: the same config runs through a raw call");
  });
});

describe("W1-T6106: the open-weight write tools cannot write the .git entry", () => {
  it("refuses .git (any case) and paths under it, and still allows the tracked hooks/", () => {
    const { wt } = cutLane();
    for (const path of [".git", ".GIT", "./.git", "sub/../.git", ".git/config"]) {
      assert.throws(() => openWeightWritablePath(wt, path), /\.git entry/, path);
    }
    assert.equal(openWeightWritablePath(wt, "hooks/pre-push"), join(realpathSync(wt), "hooks", "pre-push"));
    assert.equal(openWeightWritablePath(wt, ".github/x.yml"), join(realpathSync(wt), ".github", "x.yml"));
  });
});

describe("W1-T6106: the leaf's edges", () => {
  it("a detached head pushes a sha refspec through the gate; an unreachable remote fails the push as git did", () => {
    const { wt, remote } = cutLane();
    const n = counter;
    const stdinLog = join(root, `harness-stdin-edge-${n}`);
    script(join(harnessHooks, "pre-push"), `cat >> '${stdinLog}'\nexit 0`);
    writeFileSync(join(wt, "f.txt"), "f\n");
    const head = commitWorkerEdits(wt, ["f.txt"], "feat(f): detached").sha!;
    raw(wt, "checkout", "-q", "--detach");
    withLiveWritesAllowed(() => worktreePushExec(wt)("git", ["-C", wt, "push", "origin", `${head}:refs/heads/edge-${n}`], { stdio: "ignore" }));
    assert.equal(raw(remote, "rev-parse", `refs/heads/edge-${n}`).trim(), head);
    assert.equal(readFileSync(stdinLog, "utf8"), `${head} ${head} refs/heads/edge-${n} ${"0".repeat(40)}\n`);
    raw(wt, "remote", "add", "gone", join(root, `no-such-remote-${n}`));
    assert.throws(() => worktreePushExec(wt)("git", ["-C", wt, "push", "gone", "HEAD:refs/heads/x"], { stdio: "inherit" }),
      (e: unknown) => e instanceof PushFailedError && /^Command failed: git -C \S+ push gone/m.test(e.message));
    assert.throws(() => worktreeGitCapture(wt)("git", ["-C", join(wt, "elsewhere"), "status"]), /must address/);
  });

  it("a plain repository pins to its own .git directory; one whose recorded pointer became a directory is refused", () => {
    const plain = gitRepo({ kind: "t6106-plain" });
    assert.equal(pinLane(plain.dir).source, "git-directory");
    assert.equal(recordedGitDir(plain.dir), null);
    plain.cleanup();
    const { wt } = cutLane();
    writeFileSync(join(wt, ".git"), `gitdir: ${join(root, "no-such-gitdir")}\n`);
    assert.throws(() => pinLane(wt, () => {}), /no longer names the gitdir/, "a pointer to nothing is refused");
    rmSync(join(wt, ".git"));
    mkdirSync(join(wt, ".git"));
    assert.throws(() => pinLane(wt, () => {}), /replaced by a directory/);
    // A symlinked `.git` is refused without being followed: the pointer is read through one
    // O_NOFOLLOW descriptor, never checked and then re-read by path.
    rmSync(join(wt, ".git"), { recursive: true, force: true });
    symlinkSync(recordedGitDir(wt)!, join(wt, ".git"));
    assert.throws(() => pinLane(wt, () => {}), /neither a pointer file nor a directory/);
  });

  it("an unrecorded pointer to an outside gitdir that does not name the worktree back is refused", () => {
    const { wt } = cutLane();
    recordWorktreeBase(wt, raw(wt, "rev-parse", "HEAD").trim());
    writeFileSync(join(wt, ".git"), `gitdir: ${plantGitDir("no-back")}\n`);
    assert.throws(() => pinLane(wt, () => {}), /does not name this worktree back/);
    assert.equal(existsSync(marker("planted-fsmonitor-no-back")), false);
  });

  it("a pinned config read answers unset as undefined and refuses to call an unreadable config unset", () => {
    const { wt } = cutLane();
    const pin = pinLane(wt);
    assert.equal(pinnedConfigValue(pin, "remudero.never-set"), undefined);
    writeFileSync(join(pin.gitDir, "config.worktree"), "[core\n\tbroken = \n");
    assert.throws(() => pinnedConfigValue(pin, "core.hooksPath"));
  });

  it("a fix round's commit onto a prior head stages through the leaf's temporary index", () => {
    const { wt, branch } = cutLane();
    const n = counter;
    const prior = raw(wt, "rev-parse", "HEAD").trim();
    writeFileSync(join(wt, "g.txt"), "g\n");
    const commit = commitWorkerEdits(wt, ["g.txt"], "fix(g): a round", {}, [], { priorHeadSha: prior, branch });
    assert.equal(commit.committed, true, commit.reason);
    assert.equal(raw(wt, "rev-parse", `refs/heads/${branch}`).trim(), commit.sha);
    assert.equal(existsSync(marker(`tracked-pre-commit-${n}`)), false);
  });
});
