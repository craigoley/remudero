/**
 * W1-T6133 — THE SWEEP'S AND THE WORKER'S GIT CALLS INTO A PR-HEAD TREE GO THROUGH THE LEAF.
 *
 * renumberPlanPrIds cuts its tree with worktreeAdd at the PR's own head (core.hooksPath=hooks), and
 * rebaseDirtyFleetBranchViaGit cuts one at `pr.headSha` under a checkout whose config may name a
 * relative hooks path: either way a raw commit, rebase or push ran the PR's TRACKED hooks as the
 * daemon. The credential-helper wiring and the lane reaper followed a worktree's `.git` pointer to
 * whatever gitdir it named. Every fixture here is a throwaway repository under the test's tmp dir:
 * the PR heads, their marker hooks, the planted gitdirs and the bare remotes alike.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "../src/lib/config.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
// A namespace import, so the file still loads where prHeadTreeGit is absent and each test fails on its own.
import * as sweep from "../src/lib/sweep.js";
import { planRepairGitRun, rebaseDirtyFleetBranchViaGit, renumberPlanPrIds, type OpenPrView } from "../src/lib/sweep.js";
import { makeTempDir } from "../src/lib/tmp.js";
import {
  credentialHelperSocketWired,
  reapStaleWorktreesAsync,
  runAdhocLaneReapRung,
  wireCredentialHelperSocket,
  worktreeAdd,
} from "../src/lib/worker.js";
import { WorktreePointerRefusedError } from "../src/lib/worktree-git.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

const BRANCH = "run-W1-T9001-1791354199000";
/** Every hook a commit, a rebase, a checkout or a push can run. */
const HOOKS = ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "pre-rebase", "post-rewrite", "post-checkout", "pre-push", "reference-transaction"];

/** A script that appends `name` to `marker` and succeeds. */
function markerScript(path: string, name: string, marker: string): void {
  writeFileSync(path, `#!/bin/sh\necho ${name} >> '${marker}'\nexit 0\n`);
  chmodSync(path, 0o755);
}

function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
}

/** Commit marker hooks into `repo`'s tracked hooks/ — the bytes a PR head controls. */
function commitTrackedHooks(repo: GitRepo, marker: string): void {
  mkdirSync(join(repo.dir, "hooks"), { recursive: true });
  for (const name of HOOKS) markerScript(join(repo.dir, "hooks", name), name, marker);
  repo.git("add", "hooks");
  repo.git("commit", "--no-verify", "-m", "chore: hooks the head carries");
}

/** The harness's own hooks dir for the push leaf's gate, recording that the HARNESS copy ran. */
function harnessHooks(root: string, marker: string): string {
  const dir = join(root, "harness-hooks");
  mkdirSync(dir);
  markerScript(join(dir, "pre-push"), "harness-pre-push", marker);
  return dir;
}

async function withHarnessHooks<T>(dir: string, run: () => Promise<T> | T): Promise<T> {
  const saved = process.env.RMD_HARNESS_HOOKS_DIR;
  process.env.RMD_HARNESS_HOOKS_DIR = dir;
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.RMD_HARNESS_HOOKS_DIR;
    else process.env.RMD_HARNESS_HOOKS_DIR = saved;
  }
}

function prView(headSha: string, over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 8558,
    prUrl: "https://github.com/acme/remudero/pull/8558",
    taskId: "W1-T9001",
    reviewState: "none",
    checksState: "none",
    unmetCriteria: [],
    priorStrikes: 0,
    headSha,
    headRefName: BRANCH,
    autoMergeArmed: false,
    body: "files W1-T9001",
    ...over,
  } as OpenPrView;
}

/** A bare remote, and the daemon's checkout of it, carrying its own identity (a CI runner has none). */
function remoteAndHost(kind: string): { remote: GitRepo; seed: GitRepo; host: () => GitRepo } {
  const remote = gitRepo({ bare: true, kind: `${kind}-remote` });
  const seed = gitRepo({ cloneFrom: remote.dir, kind: `${kind}-seed` });
  const host = (): GitRepo => {
    const h = gitRepo({ cloneFrom: remote.dir, kind: `${kind}-host` });
    h.git("config", "user.name", "remudero test fixture");
    h.git("config", "user.email", "fixture@remudero.invalid");
    return h;
  };
  return { remote, seed, host };
}

test("W1-T6133: renumberPlanPrIds commits and pushes a PR head's renumber without running the head's tracked hooks", async () => {
  const root = makeTempDir("t6133-renumber");
  const marker = join(root, "tracked-hooks-ran");
  const harnessMarker = join(root, "harness-hooks-ran");
  const { remote, seed, host } = remoteAndHost("t6133-renumber");
  mkdirSync(join(seed.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), "tasks:\n  - id: W1-T10\n");
  seed.git("add", "plan");
  seed.git("commit", "-m", "chore: seed the plan");
  seed.git("push", "--quiet", "origin", "HEAD:main");
  seed.git("checkout", "-b", BRANCH);
  writeFileSync(join(seed.dir, "plan", "tasks.d", "W1-T9001-fixture.yaml"), "- id: W1-T9001\n  title: x\n");
  seed.git("add", "plan");
  seed.git("commit", "-m", "chore(plan): file W1-T9001");
  commitTrackedHooks(seed, marker);
  seed.git("push", "--quiet", "origin", BRANCH);
  const headSha = seed.git("rev-parse", "HEAD");
  const daemon = host();
  const patches: string[][] = [];

  const out = await withHarnessHooks(harnessHooks(root, harnessMarker), () =>
    withLiveWritesAllowed(() =>
      renumberPlanPrIds(prView(headSha), ["W1-T9001"], "chore(plan): file W1-T9001", daemon.dir, join(root, "renumber-wt"), {
        owner: "acme",
        repo: "remudero",
        log: () => {},
        ghJsonImpl: (args) => {
          patches.push(args);
          return {};
        },
      }),
    ),
  );

  assert.equal(out.outcome, "renumbered", JSON.stringify(out));
  const newId = Object.values(out.renames ?? {})[0]!;
  assert.match(newId, /^W1-T\d+$/);
  assert.equal(remote.git("rev-parse", `refs/heads/${BRANCH}`), out.newHeadSha, "the renumber landed on the remote");
  assert.match(remote.git("ls-tree", "-r", "--name-only", out.newHeadSha!, "plan/tasks.d"), new RegExp(`${newId}-fixture\\.yaml`));
  assert.deepEqual(lines(marker), [], "no hook the PR head tracks ran");
  assert.deepEqual(lines(harnessMarker), ["harness-pre-push"], "the push ran the harness's pre-push gate instead");
  assert.equal(patches.length, 1, "the PR's title and body were patched");
});

test("W1-T6133: rebaseDirtyFleetBranchViaGit rebases and pushes a PR head without running its hooks, under a checkout naming hooks/", async () => {
  const root = makeTempDir("t6133-rebase");
  const marker = join(root, "tracked-hooks-ran");
  const harnessMarker = join(root, "harness-hooks-ran");
  const fsmonitorMarker = join(root, "fsmonitor-ran");
  const { remote, seed, host } = remoteAndHost("t6133-rebase");
  writeFileSync(join(seed.dir, "README.md"), "base\n");
  seed.git("add", "README.md");
  seed.git("commit", "-m", "chore: seed");
  seed.git("push", "--quiet", "origin", "HEAD:main");
  seed.git("checkout", "-b", BRANCH);
  writeFileSync(join(seed.dir, "branch.txt"), "branch change\n");
  seed.git("add", "branch.txt");
  seed.git("commit", "-m", "feat: branch change");
  commitTrackedHooks(seed, marker);
  seed.git("push", "--quiet", "origin", BRANCH);
  const oldHead = seed.git("rev-parse", "HEAD");
  seed.git("checkout", "main");
  writeFileSync(join(seed.dir, "main.txt"), "main change\n");
  seed.git("add", "main.txt");
  seed.git("commit", "-m", "feat: main change");
  seed.git("push", "--quiet", "origin", "main");
  const daemon = host();
  // The managed checkout's config names a RELATIVE hooks path and an fsmonitor: resolved in the PR's tree.
  daemon.git("config", "core.hooksPath", "hooks");
  // It records where it ran: the checkout's own fetch may consult it; the PR's tree must not.
  writeFileSync(join(root, "fsmonitor"), `#!/bin/sh\necho "$PWD" >> '${fsmonitorMarker}'\nexit 1\n`);
  chmodSync(join(root, "fsmonitor"), 0o755);
  daemon.git("config", "core.fsmonitor", join(root, "fsmonitor"));

  const outcome = await withHarnessHooks(harnessHooks(root, harnessMarker), () =>
    withLiveWritesAllowed(() => rebaseDirtyFleetBranchViaGit(daemon.dir, join(root, "rebase-wt"), prView(oldHead))),
  );

  assert.equal(outcome.outcome, "rebased", JSON.stringify(outcome));
  assert.equal(remote.git("rev-parse", `refs/heads/${BRANCH}`), (outcome as { newHeadSha: string }).newHeadSha);
  assert.equal(remote.git("merge-base", "--is-ancestor", "refs/heads/main", `refs/heads/${BRANCH}`), "", "the head now sits on main");
  assert.deepEqual(lines(marker), [], "no hook the PR head tracks ran — not the cut's, the rebase's or the push's");
  const wt = realpathSync(root);
  assert.deepEqual(lines(fsmonitorMarker).filter((at) => at.startsWith(join(wt, "rebase-wt"))), [], "and no fsmonitor ran in the PR's tree");
  assert.deepEqual(lines(harnessMarker), ["harness-pre-push"], "the push ran the harness's pre-push gate instead");
});

/** A linked worktree whose `.git` pointer was rewritten to name `planted`'s gitdir. */
function pointAt(worktree: string, planted: GitRepo): void {
  writeFileSync(join(worktree, ".git"), `gitdir: ${join(planted.dir, ".git")}\n`);
}

test("W1-T6133: the credential-helper wiring refuses a worktree whose pointer names a planted gitdir, and writes an intact one", () => {
  const root = makeTempDir("t6133-credential");
  const parent = gitRepo({ kind: "t6133-credential-parent" });
  parent.git("config", "extensions.worktreeConfig", "true");
  const planted = gitRepo({ kind: "t6133-credential-planted" });
  const hostile = parent.addWorktree(join(root, "hostile"), "hostile");
  pointAt(hostile.dir, planted);
  const socket = join(root, "credential.sock");

  assert.equal(credentialHelperSocketWired(hostile.dir, socket), false, "a refused pointer is never read as wired");
  assert.throws(() => wireCredentialHelperSocket(hostile.dir, socket), WorktreePointerRefusedError);
  const plantedConfig = readFileSync(join(planted.dir, ".git", "config"), "utf8");
  assert.doesNotMatch(plantedConfig, /credential|useHttpPath/, "nothing was written into the planted gitdir's config");
  assert.equal(existsSync(join(planted.dir, ".git", "config.worktree")), false);

  // The control: an intact worktree is wired in ITS OWN pinned config.worktree, as before.
  const intact = parent.addWorktree(join(root, "intact"), "intact");
  assert.equal(credentialHelperSocketWired(intact.dir, socket), false);
  wireCredentialHelperSocket(intact.dir, socket);
  assert.equal(credentialHelperSocketWired(intact.dir, socket), true);
  assert.match(intact.git("config", "--worktree", "--get-all", "credential.helper"), /git-credential-socket-helper\.mjs/);
});

test("W1-T6133: the lane reaper keeps a lane whose pointer it refuses instead of reading the planted gitdir", async () => {
  const root = makeTempDir("t6133-lanes");
  const lanes = join(root, "lanes");
  mkdirSync(lanes);
  const parent = gitRepo({ kind: "t6133-lane-parent" });
  const hostile = parent.addWorktree(join(lanes, "hostile"), "hostile");
  hostile.git("commit", "--allow-empty", "-m", "lane-only work the reaper must not destroy");
  // The planted gitdir reads as fully pushed, so following the pointer would reap the lane.
  const planted = gitRepo({ kind: "t6133-lane-planted" });
  planted.git("update-ref", "refs/remotes/origin/main", planted.git("rev-parse", "HEAD"));
  pointAt(hostile.dir, planted);
  const old = (Date.now() - 365 * 24 * 60 * 60 * 1000) / 1000;
  utimesSync(hostile.dir, old, old);
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];

  const summary = await runAdhocLaneReapRung({ root } as Config, (step, extra) => rows.push({ step, extra }), {
    enabled: () => true,
    diskHeadroom: () => ({ freeBytes: 0, totalBytes: 100 }),
    reap: (at, opts) => reapStaleWorktreesAsync(at, {
      ...opts, newestActivity: () => ({ mtimeMs: 0, complete: true }), branchIsLiveUpstream: () => false,
    }),
  });

  assert.deepEqual(summary?.reaped, []);
  assert.deepEqual(summary?.keptReasons, [{ name: "hostile", reason: "work-undecidable" }]);
  assert.equal(existsSync(hostile.dir), true, "the lane survives");
  const undecidable = rows.find((r) => r.step === "adhoc_lane.reap.work_undecidable");
  assert.equal(undecidable?.extra?.pointer_refused, true, "the keep names the refused pointer");
});

test("W1-T6133: the PR-head seams address only their own tree, and the reservation runner reports git's own exit", () => {
  const parent = gitRepo({ kind: "t6133-seams" });
  const tree = parent.addWorktree(join(makeTempDir("t6133-seams-wt"), "wt"), "wt");
  assert.throws(() => sweep.prHeadTreeGit(tree.dir)("git", ["-C", parent.dir, "status"]), /must address/);
  assert.equal(sweep.prHeadTreeGit(tree.dir)("git", ["-C", tree.dir, "rev-parse", "HEAD"]).trim(), tree.git("rev-parse", "HEAD"));
  const run = planRepairGitRun(tree.dir);
  assert.deepEqual(run(["rev-parse", "--abbrev-ref", "HEAD"]), { status: 0, stdout: "wt\n", stderr: "" });
  const missing = run(["rev-parse", "--verify", "--quiet", "refs/heads/absent"]);
  assert.equal(missing.status, 1, "a failed git is its exit status, not a refusal");
  // A worktreeAdd-cut tree pins its RECORDED gitdir through the same runner.
  const remote = gitRepo({ bare: true, kind: "t6133-seams-remote" });
  parent.addRemote("origin", remote.dir);
  parent.git("push", "--quiet", "origin", "HEAD:main");
  parent.git("fetch", "--quiet", "origin");
  const cut = join(makeTempDir("t6133-seams-cut"), "cut");
  worktreeAdd(parent.dir, cut, "t6133-cut", "origin/main", { log: () => {} });
  assert.equal(planRepairGitRun(cut)(["rev-parse", "HEAD"]).stdout.trim(), parent.git("rev-parse", "HEAD"));
});
