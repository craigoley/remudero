import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { gitPushRunBranch } from "../src/lib/git-push.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  WorktreePointerTamperedError,
  harnessHooksDir,
  hostWorktreeGit,
  hostWorktreeGitPlan,
  recordWorktreePin,
  worktreePinPath,
} from "../src/lib/worktree-git.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "./helpers/git-repo.js";

/**
 * W1-T6106 — A HOST GIT CALL INTO A WORKER WORKTREE RUNS NO CODE THE WORKER WROTE.
 *
 * FIXTURES ONLY. The hostile config here is a fixture-local marker command (`touch <file under the test's tmp dir>`) in a
 * gitRepo() fixture; nothing runs against a real worktree or the host.
 */

interface Fixture {
  root: string;
  worktree: string;
  gitDir: string;
  markers: string;
  origin: string;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A linked worktree shaped like worktreeAdd's: relative `core.hooksPath=hooks` per worktree, tracked hooks/ that write a
 *  marker, the pointer pinned. */
function fixture(): Fixture {
  const markers = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t6106-markers-`));
  const origin = gitRepo({ bare: true, kind: "w1t6106-origin" });
  const main = gitRepo({ kind: "w1t6106-main" });
  main.addRemote("origin", origin.dir);
  mkdirSync(join(main.dir, "hooks"));
  for (const hook of ["pre-commit", "commit-msg", "pre-push"]) {
    writeFileSync(join(main.dir, "hooks", hook), `#!/bin/sh\ntouch '${join(markers, `worktree-${hook}`)}'\nexit 0\n`);
    chmodSync(join(main.dir, "hooks", hook), 0o755);
  }
  main.git("add", "hooks");
  main.git("commit", "--quiet", "-m", "chore: tracked hooks");
  main.git("config", "extensions.worktreeConfig", "true");
  const worktree = join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t6106-wt-`)), "wt");
  main.addWorktree(worktree, "run-fixture", "HEAD");
  main.git("-C", worktree, "config", "--worktree", "core.hooksPath", "hooks");
  assert.equal(recordWorktreePin(worktree), true, "the pin is recorded off the pointer worktreeAdd left");
  const gitDir = main.git("-C", worktree, "rev-parse", "--path-format=absolute", "--git-dir");
  return { root: main.dir, worktree, gitDir, markers, origin: origin.dir };
}

function withIdentity<T>(run: () => T): T {
  const saved = { ...process.env };
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = GIT_REPO_FIXTURE_IDENTITY.name;
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = GIT_REPO_FIXTURE_IDENTITY.email;
  try {
    return run();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

function cleanup(f: Fixture): void {
  for (const dir of [f.markers, f.root, f.origin, join(f.worktree, ".."), worktreePinPath(f.worktree)]) rmSync(dir, { recursive: true, force: true });
}

function trustedHooks(f: Fixture, names: string[]): string {
  const dir = join(f.markers, "trusted-hooks");
  mkdirSync(dir, { recursive: true });
  for (const hook of names) {
    writeFileSync(join(dir, hook), `#!/bin/sh\ntouch '${join(f.markers, `harness-${hook}`)}'\nexit 0\n`);
    chmodSync(join(dir, hook), 0o755);
  }
  return dir;
}

function emptyHooks(f: Fixture): string {
  const dir = join(f.markers, "empty-hooks");
  mkdirSync(dir, { recursive: true });
  return dir;
}

const fsmonitorMarker = (markers: string): string => `touch '${join(markers, "fsmonitor")}' #`;
const readGit = (dir: string, ...args: string[]): string => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

test("a .git pointer rewritten to a planted gitdir with a core.fsmonitor marker refuses before git runs, and the marker is never written", () => {
  const f = fixture();
  try {
    const planted = join(f.markers, "planted-gitdir");
    cpSync(f.gitDir, planted, { recursive: true });
    writeFileSync(join(planted, "commondir"), `${join(f.root, ".git")}\n`);
    writeFileSync(join(planted, "config.worktree"), `[core]\n\tfsmonitor = ${fsmonitorMarker(f.markers)}\n`);
    writeFileSync(join(f.worktree, ".git"), `gitdir: ${planted}\n`);

    // POSITIVE CONTROL: the planted gitdir really does execute its marker for a raw host call, so the refusal below is
    // not a vacuous pass over a fixture that never could have fired.
    execFileSync("git", ["-C", f.worktree, "status", "--porcelain"], { stdio: "ignore" });
    assert.equal(existsSync(join(f.markers, "fsmonitor")), true, "a raw `git -C <worktree> status` runs the planted fsmonitor");
    rmSync(join(f.markers, "fsmonitor"));

    assert.throws(
      () => hostWorktreeGit(f.worktree, ["status", "--porcelain"], { encoding: "utf8" }),
      (error: unknown) => {
        assert.ok(error instanceof WorktreePointerTamperedError);
        assert.match(error.message, new RegExp(escape(planted)), "names the planted pointer");
        assert.match(error.message, new RegExp(escape(f.gitDir)), "names the recorded pointer");
        return true;
      },
    );
    assert.equal(existsSync(join(f.markers, "fsmonitor")), false, "the marker is never written");
  } finally {
    cleanup(f);
  }
});

test("a planted core.fsmonitor in the pinned gitdir's own config is overridden on every host call", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.gitDir, "config.worktree"), `[core]\n\thooksPath = hooks\n\tfsmonitor = ${fsmonitorMarker(f.markers)}\n`);
    execFileSync("git", ["-C", f.worktree, "status", "--porcelain"], { stdio: "ignore" });
    assert.equal(existsSync(join(f.markers, "fsmonitor")), true, "positive control: the raw call fires the planted fsmonitor");
    rmSync(join(f.markers, "fsmonitor"));

    hostWorktreeGit(f.worktree, ["status", "--porcelain"], { encoding: "utf8" });
    assert.equal(existsSync(join(f.markers, "fsmonitor")), false, "the hardened call does not");
  } finally {
    cleanup(f);
  }
});

test("a host commit through the leaf never runs the worktree's tracked hooks dir", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.worktree, "work.txt"), "work\n");
    const trusted = trustedHooks(f, ["pre-commit", "commit-msg"]);
    withIdentity(() => {
      hostWorktreeGit(f.worktree, ["add", "-A"], { stdio: "pipe" });
      hostWorktreeGit(f.worktree, ["commit", "-m", "chore: host commit"], { stdio: "pipe" }, { hooksDir: trusted });
    });
    assert.equal(readGit(f.worktree, "log", "-1", "--format=%s"), "chore: host commit");
    assert.equal(existsSync(join(f.markers, "worktree-pre-commit")), false, "the worktree's tracked pre-commit never ran");
    assert.equal(existsSync(join(f.markers, "worktree-commit-msg")), false, "the worktree's tracked commit-msg never ran");
    assert.equal(existsSync(join(f.markers, "harness-pre-commit")), true, "the harness copy's pre-commit ran instead");
    assert.equal(existsSync(join(f.markers, "harness-commit-msg")), true, "the harness copy's commit-msg ran instead");
  } finally {
    cleanup(f);
  }
});

test("a host push through the leaf runs the pre-push gate from the harness copy, never the worktree's tracked copy", () => {
  const f = fixture();
  try {
    const trusted = trustedHooks(f, ["pre-push"]);
    writeFileSync(join(f.worktree, "work.txt"), "work\n");
    withIdentity(() => {
      hostWorktreeGit(f.worktree, ["add", "-A"], { stdio: "pipe" });
      hostWorktreeGit(f.worktree, ["commit", "-m", "chore: host commit"], { stdio: "pipe" }, { hooksDir: emptyHooks(f) });
    });
    hostWorktreeGit(f.worktree, ["push", "origin", "HEAD"], { stdio: "pipe" }, { hooksDir: trusted });
    assert.equal(existsSync(join(f.markers, "harness-pre-push")), true, "the harness pre-push gate ran");
    assert.equal(existsSync(join(f.markers, "worktree-pre-push")), false, "the worktree's tracked pre-push never ran");
    assert.match(readGit(f.origin, "branch", "--list", "run-fixture"), /run-fixture/);
  } finally {
    cleanup(f);
  }
});

test("gitPushRunBranch runs through the leaf: the default hooks dir is this install's own hooks/, and the worktree's copy stays unrun", () => {
  const f = fixture();
  try {
    const plan = hostWorktreeGitPlan(f.worktree, ["push", "origin", "HEAD"]);
    assert.ok(plan.argv.includes(`core.hooksPath=${harnessHooksDir()}`), "a push plan points core.hooksPath at the harness hooks/");
    assert.ok(plan.argv.includes("core.fsmonitor=false"));
    assert.ok(plan.argv.includes("--git-dir") && plan.argv.includes(f.gitDir), "the gitdir is the pinned one");
    assert.ok(existsSync(join(harnessHooksDir(), "pre-push")), "the harness ships the pre-push gate");

    writeFileSync(join(f.worktree, "work.txt"), "work\n");
    const savedGate = process.env.RMD_PREPUSH_GATES;
    process.env.RMD_PREPUSH_GATES = "0"; // the harness gate's own documented switch: it runs and exits at once
    try {
      withIdentity(() => {
        hostWorktreeGit(f.worktree, ["add", "-A"], { stdio: "pipe" });
        hostWorktreeGit(f.worktree, ["commit", "-m", "chore: host commit"], { stdio: "pipe" }, { hooksDir: emptyHooks(f) });
      });
      withLiveWritesAllowed(() => gitPushRunBranch(f.worktree, { stdio: "ignore" }));
    } finally {
      if (savedGate === undefined) delete process.env.RMD_PREPUSH_GATES;
      else process.env.RMD_PREPUSH_GATES = savedGate;
    }
    assert.equal(existsSync(join(f.markers, "worktree-pre-push")), false, "the worktree's tracked pre-push never ran");
    assert.match(readGit(f.origin, "branch", "--list", "run-fixture"), /run-fixture/);
  } finally {
    cleanup(f);
  }
});

test("a worktree with no pin record is not refused, but still gets the config overrides", () => {
  const f = fixture();
  try {
    rmSync(worktreePinPath(f.worktree));
    writeFileSync(join(f.gitDir, "config.worktree"), `[core]\n\tfsmonitor = ${fsmonitorMarker(f.markers)}\n`);
    hostWorktreeGit(f.worktree, ["status", "--porcelain"], { encoding: "utf8" });
    assert.equal(existsSync(join(f.markers, "fsmonitor")), false);
    assert.equal(readFileSync(join(f.worktree, ".git"), "utf8").startsWith("gitdir:"), true);
  } finally {
    cleanup(f);
  }
});
