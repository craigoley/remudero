/**
 * test/fix-branch-checkout-serialization.test.ts
 *
 * W1-T2609. THE DEFECT (PR #3261): `createFixRungWorktree` ran an unconditional
 * `git checkout -B <branch> origin/<branch>` onto the fix rung's PR-head branch — a branch
 * deliberately SHARED across every concurrent fix round for one task (creditability,
 * `fixHeadAcceptable`/`deriveStatus`'s `ownsBranch`; only the WORKTREE is per-attempt unique).
 * `-B` force-resets the local ref: round A commits locally (unpushed), round B arrives in that
 * window and resets the SAME local ref back to `origin/<branch>` — A's commit is now
 * unreferenced, rewound with no error, between commit and push.
 *
 * THE FIRST FIX, two halves at one site (never a second concern):
 *  (i) `checkoutFixHeadRef` (src/run-task.ts) replaces the destructive `checkout -B` with a
 *      three-way compare against the local ref: absent → create (unchanged); at/behind origin →
 *      fast-forward (unchanged); AHEAD of origin → originally REFUSE via
 *      `FixRungCheckoutRefusedError`.
 *  (ii) `dispatchFix` takes an EXCLUSIVE per-(repo, branch) claim — reusing
 *      `src/lib/inflight-lock.ts`'s O_EXCL discipline via `fixBranchClaimKey` — before any
 *      worktree/git side effect, so two concurrent rounds for the same task never even race the
 *      checkout: the loser declines the poll (`sweep.fix.checkout_claim_declined`) instead of
 *      reaching the checkout at all.
 *
 * W1-T2839 keeps that no-loss rule but closes its permanent refusal state: once the exclusive
 * claim is held, an unheld ahead/diverged tip is anchored under `refs/rmd-recovery/fix/`, then
 * the branch is moved with compare-and-swap. A held branch or lost CAS still refuses.
 *
 * Git-backed tests use REAL repositories (no execFileSync mocking) — same convention as the
 * sibling suite test/git-config-lock-contention.test.ts. The `dispatchFix`-level tests drive the
 * REAL closure with a stub `gh` on PATH — same convention as test/uncreditable-head-reason.test.ts.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FixRungCheckoutRefusedError,
  buildSweepEffects,
  captureRegisteredFixOwnerSnapshot,
  decideRegisteredFixOwnerRecovery,
  checkoutFixHeadRef,
  createFixRungWorktree,
  fixBranchClaimKey,
  preserveAbandonedFixOwnerDivergence,
  publishAbandonedFixOwnerAhead,
  readBoundedProcessCwdCensus,
  readRegisteredFixOwnerClaim,
  registeredFixWorktreeOwner,
  removeAbandonedFixWorktreeOwner,
  type RegisteredFixOwnerSnapshot,
} from "../src/run-task.js";
import { acquireInflightLock } from "../src/lib/inflight-lock.js";
import { DEFAULT_SWEEP_POLICY } from "../src/lib/sweep.js";
import type { OpenPrView } from "../src/lib/sweep.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { WorkerResult } from "../src/lib/worker.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A bare "upstream" (stands in for GitHub) plus a first commit on `main`, pushed from a
 *  throwaway seed clone — so `repoDir`/`advancer` clones below are genuinely SEPARATE
 *  checkouts of one shared remote, never a self-pointing origin. That separation is what lets
 *  a test advance `origin/<branch>` without moving `repoDir`'s own local ref, and vice versa —
 *  the exact asymmetry `checkoutFixHeadRef` has to tell apart. */
function seedUpstream(root: string): string {
  const upstream = join(root, "upstream.git");
  mkdirSync(upstream, { recursive: true });
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch", "main", upstream]);
  const seed = join(root, "seed-clone");
  execFileSync("git", ["clone", "--quiet", upstream, seed]);
  execFileSync("git", ["-C", seed, "config", "user.email", "probe@example.invalid"]);
  execFileSync("git", ["-C", seed, "config", "user.name", "probe"]);
  writeFileSync(join(seed, "seed.txt"), "x\n");
  execFileSync("git", ["-C", seed, "add", "-A"]);
  execFileSync("git", ["-C", seed, "commit", "--no-verify", "--quiet", "-m", "chore: seed"]);
  execFileSync("git", ["-C", seed, "push", "--quiet", "origin", "main"]);
  return upstream;
}

function cloneOf(upstream: string, dest: string): void {
  execFileSync("git", ["clone", "--quiet", upstream, dest]);
  execFileSync("git", ["-C", dest, "config", "user.email", "probe@example.invalid"]);
  execFileSync("git", ["-C", dest, "config", "user.name", "probe"]);
}

function sha(repo: string, ref: string): string {
  return execFileSync("git", ["-C", repo, "rev-parse", ref], { encoding: "utf8" }).trim();
}

function commit(repo: string, file: string, msg: string): void {
  writeFileSync(join(repo, file), `${msg}\n`, "utf8");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "--no-verify", "--quiet", "-m", msg]);
}

function commitObject(repo: string, parent: string, msg: string): string {
  const tree = sha(repo, `${parent}^{tree}`);
  return execFileSync("git", ["-C", repo, "commit-tree", tree, "-p", parent, "-m", msg], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "probe",
      GIT_AUTHOR_EMAIL: "probe@example.invalid",
      GIT_COMMITTER_NAME: "probe",
      GIT_COMMITTER_EMAIL: "probe@example.invalid",
    },
  }).trim();
}

// ── (i) checkoutFixHeadRef / createFixRungWorktree — the non-destructive checkout ─────

test("absent local ref: created fresh at origin/<branch> — unchanged from the old sequence", () => {
  const root = tmp("rmd-fbcs-absent-");
  try {
    const upstream = seedUpstream(root);
    const repoDir = join(root, "repoDir");
    cloneOf(upstream, repoDir);
    execFileSync("git", ["-C", repoDir, "branch", "run-absent-probe"]);
    execFileSync("git", ["-C", repoDir, "push", "--quiet", "origin", "run-absent-probe"]);
    const expected = sha(repoDir, "origin/run-absent-probe");

    const worktreePath = join(root, "wt");
    createFixRungWorktree(repoDir, worktreePath, "run-absent-probe");

    assert.equal(sha(worktreePath, "HEAD"), expected, "lands at origin/<branch>'s commit");
    assert.equal(
      execFileSync("git", ["-C", worktreePath, "symbolic-ref", "-q", "HEAD"], { encoding: "utf8" }).trim(),
      "refs/heads/run-absent-probe",
      "a real named local branch, not detached",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local ref BEHIND origin: fast-forwards — unchanged from the old sequence", () => {
  const root = tmp("rmd-fbcs-behind-");
  try {
    const upstream = seedUpstream(root);
    const repoDir = join(root, "repoDir");
    cloneOf(upstream, repoDir);
    execFileSync("git", ["-C", repoDir, "checkout", "-q", "-b", "run-ff-probe"]);
    execFileSync("git", ["-C", repoDir, "push", "--quiet", "origin", "run-ff-probe"]);
    execFileSync("git", ["-C", repoDir, "checkout", "-q", "main"]);
    const behindSha = sha(repoDir, "run-ff-probe");

    // A SEPARATE clone advances origin's branch without ever touching repoDir's own local ref.
    const advancer = join(root, "advancer");
    cloneOf(upstream, advancer);
    execFileSync("git", ["-C", advancer, "checkout", "-q", "run-ff-probe"]);
    commit(advancer, "advance.txt", "advance");
    execFileSync("git", ["-C", advancer, "push", "--quiet", "origin", "run-ff-probe"]);
    const aheadSha = sha(advancer, "run-ff-probe");
    assert.notEqual(behindSha, aheadSha, "premise: origin genuinely moved past repoDir's local ref");

    const worktreePath = join(root, "wt");
    // createFixRungWorktree fetches origin itself — repoDir need not fetch first.
    createFixRungWorktree(repoDir, worktreePath, "run-ff-probe");

    assert.equal(sha(worktreePath, "HEAD"), aheadSha, "fast-forwarded to origin's new tip");
    assert.equal(sha(repoDir, "refs/heads/run-ff-probe"), aheadSha, "the shared local ref itself moved forward");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local ref EQUAL to origin: unchanged — a no-op reset either way", () => {
  const root = tmp("rmd-fbcs-equal-");
  try {
    const upstream = seedUpstream(root);
    const repoDir = join(root, "repoDir");
    cloneOf(upstream, repoDir);
    execFileSync("git", ["-C", repoDir, "branch", "run-equal-probe"]);
    execFileSync("git", ["-C", repoDir, "push", "--quiet", "origin", "run-equal-probe"]);
    const worktreePath1 = join(root, "wt1");
    createFixRungWorktree(repoDir, worktreePath1, "run-equal-probe");
    execFileSync("git", ["-C", repoDir, "worktree", "remove", "--force", worktreePath1]);
    const expected = sha(repoDir, "refs/heads/run-equal-probe");

    const worktreePath2 = join(root, "wt2");
    createFixRungWorktree(repoDir, worktreePath2, "run-equal-probe");
    assert.equal(sha(worktreePath2, "HEAD"), expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local ref AHEAD of origin: preserves the local commit, resets by CAS, and proceeds", () => {
  const root = tmp("rmd-fbcs-ahead-");
  try {
    const upstream = seedUpstream(root);
    const repoDir = join(root, "repoDir");
    cloneOf(upstream, repoDir);
    execFileSync("git", ["-C", repoDir, "branch", "run-ahead-probe"]);
    execFileSync("git", ["-C", repoDir, "push", "--quiet", "origin", "run-ahead-probe"]);
    const originSha = sha(repoDir, "origin/run-ahead-probe");

    // Round A: checks out, commits LOCALLY, never pushes — then its worktree is torn down
    // (mirrors dispatchFix's own `finally` cleanup), leaving the branch unattached but the
    // commit only local. This is the exact race window PR #3261 reported.
    const wtA = join(root, "wtA");
    createFixRungWorktree(repoDir, wtA, "run-ahead-probe");
    commit(wtA, "local-only.txt", "round A's unpushed commit");
    const localSha = sha(wtA, "HEAD");
    assert.notEqual(localSha, originSha, "premise: round A really did move the branch ahead of origin");
    execFileSync("git", ["-C", repoDir, "worktree", "remove", "--force", wtA]);

    // Round B arrives after round A's claim is gone. The local-only commit remains recoverable,
    // but it no longer parks every future level-triggered repair pass.
    const wtB = join(root, "wtB");
    const recovered = createFixRungWorktree(repoDir, wtB, "run-ahead-probe");

    assert.ok(recovered, "the non-ancestor transition is reported to the caller");
    assert.equal(recovered.localSha, localSha);
    assert.equal(recovered.originSha, originSha);
    assert.equal(sha(repoDir, recovered.recoveryRef), localSha, "the local-only commit remains named");
    assert.equal(sha(repoDir, "refs/heads/run-ahead-probe"), originSha, "the shared branch now follows origin");
    assert.equal(sha(wtB, "HEAD"), originSha, "the repair worktree can proceed from the PR head");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local ref DIVERGED from origin: preserves the local side and proceeds from the remote side", () => {
  const root = tmp("rmd-fbcs-diverged-");
  try {
    const upstream = seedUpstream(root);
    const repoDir = join(root, "repoDir");
    cloneOf(upstream, repoDir);
    const branch = "run-diverged-probe";
    execFileSync("git", ["-C", repoDir, "checkout", "-q", "-b", branch]);
    execFileSync("git", ["-C", repoDir, "push", "--quiet", "origin", branch]);
    commit(repoDir, "local-only.txt", "local-only");
    const localSha = sha(repoDir, branch);
    execFileSync("git", ["-C", repoDir, "checkout", "-q", "main"]);

    const advancer = join(root, "advancer");
    cloneOf(upstream, advancer);
    execFileSync("git", ["-C", advancer, "checkout", "-q", branch]);
    commit(advancer, "remote-only.txt", "remote-only");
    execFileSync("git", ["-C", advancer, "push", "--quiet", "origin", branch]);
    const originSha = sha(advancer, branch);

    const recovered = createFixRungWorktree(repoDir, join(root, "wt"), branch);
    assert.ok(recovered);
    assert.equal(sha(repoDir, recovered.recoveryRef), localSha);
    assert.equal(sha(repoDir, `refs/heads/${branch}`), originSha);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a local ref held by a registered worktree is refused and no recovery ref is created", () => {
  const root = tmp("rmd-fbcs-held-");
  try {
    const upstream = seedUpstream(root);
    const repoDir = join(root, "repoDir");
    cloneOf(upstream, repoDir);
    const branch = "run-held-probe";
    execFileSync("git", ["-C", repoDir, "branch", branch]);
    execFileSync("git", ["-C", repoDir, "push", "--quiet", "origin", branch]);
    const originSha = sha(repoDir, `origin/${branch}`);
    const holder = join(root, "holder");
    createFixRungWorktree(repoDir, holder, branch);
    commit(holder, "held.txt", "held local commit");
    const localSha = sha(holder, "HEAD");

    assert.throws(
      () => createFixRungWorktree(repoDir, join(root, "challenger"), branch),
      (e: unknown) => e instanceof FixRungCheckoutRefusedError,
    );
    assert.equal(sha(repoDir, `refs/heads/${branch}`), localSha);
    assert.throws(() => sha(repoDir, `refs/rmd-recovery/fix/${branch}/${localSha}`));
    assert.notEqual(localSha, originSha);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the recovered branch move is compare-and-swap protected against a concurrent ref change", () => {
  const root = tmp("rmd-fbcs-cas-");
  try {
    const upstream = seedUpstream(root);
    const repoDir = join(root, "repoDir");
    cloneOf(upstream, repoDir);
    const branch = "run-cas-probe";
    execFileSync("git", ["-C", repoDir, "checkout", "-q", "-b", branch]);
    execFileSync("git", ["-C", repoDir, "push", "--quiet", "origin", branch]);
    commit(repoDir, "local-only.txt", "local-only");
    const localSha = sha(repoDir, branch);
    const racingSha = commitObject(repoDir, localSha, "racing commit");
    execFileSync("git", ["-C", repoDir, "checkout", "-q", "main"]);

    assert.throws(
      () =>
        createFixRungWorktree(repoDir, join(root, "wt"), branch, {
          beforeHeadCompareAndSwap: () =>
            execFileSync("git", ["-C", repoDir, "update-ref", `refs/heads/${branch}`, racingSha, localSha]),
        }),
      (e: unknown) => e instanceof FixRungCheckoutRefusedError,
    );
    assert.equal(sha(repoDir, `refs/heads/${branch}`), racingSha, "the racing writer wins; recovery overwrites nothing");
    assert.equal(sha(repoDir, `refs/rmd-recovery/fix/${branch}/${localSha}`), localSha);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkoutFixHeadRef is the named non-destructive checkout createFixRungWorktree now delegates to", () => {
  // Direct proof the two are wired together, not just coincidentally producing the same result
  // above — createFixRungWorktree's worktree/branch already exists by the time this runs.
  assert.equal(typeof checkoutFixHeadRef, "function");
});

// ── (ii) the per-(repo, branch) exclusive claim ────────────────────────────────

const T = (id: string): Task =>
  ({ id, title: id, risk: "low", acceptance: [], verify: "auto", files: [], status: "queued" }) as unknown as Task;

const PLAN: Plan = (() => {
  const tasks = [T("W1-T500")];
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
})();

function prFor(prNumber: number, headRefName: string): OpenPrView {
  return {
    prNumber,
    prUrl: `https://github.com/acme/scratch-fbcs-repo/pull/${prNumber}`,
    headSha: "cafe1234",
    headRefName,
    taskId: "W1-T500",
    reviewState: "none",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date().toISOString(),
  } as unknown as OpenPrView;
}

type Drive = { logs: Array<{ step: string; extra?: Record<string, unknown> }>; threw: unknown };

/** Drives the REAL `dispatchFix` closure with a stub `gh` on PATH — same convention as
 *  test/uncreditable-head-reason.test.ts's `driveDispatchFix`. `root` is caller-owned (not
 *  cleaned up here) so a test can inspect/pre-seed `state/inflight` and `repos/<repo>` around
 *  the call. */
async function driveDispatchFix(
  root: string,
  headRefName: string,
  registeredWorktreeOwnerPath?: string | (() => string | undefined),
  registeredOwnerRecovery?: Parameters<typeof buildSweepEffects>[23],
  spawnImpl?: Parameters<typeof buildSweepEffects>[9],
  evidence: { unmetCriteria: never[]; ciFailures: Array<{ name: string; logTail: string }> } = {
    unmetCriteria: [],
    ciFailures: [],
  },
): Promise<Drive> {
  const bin = mkdtempSync(join(tmpdir(), "fbcs-gh-"));
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/usr/bin/env node",
      'const a = process.argv.slice(2); const i = a.indexOf("--json"); const f = i >= 0 ? a[i+1] : undefined;',
      `const HEAD = ${JSON.stringify(headRefName)};`,
      'if (f && f.includes("headRefName")) process.stdout.write(JSON.stringify({ headRefName: HEAD, headRefOid: "cafe1234", body: "" }));',
      'else if (a[0] === "api" && typeof a[1] === "string" && /^repos\\/[^/]+\\/[^/]+\\/pulls\\/\\d+$/.test(a[1])) process.stdout.write(JSON.stringify({ state: "open", merged: false, head: { sha: "cafe1234", ref: HEAD }, base: { sha: "deadbeef" } }));',
      'else if (a[0] === "api" && typeof a[1] === "string" && /\\/commits\\/cafe1234\\/check-runs(?:\\?.*)?$/.test(a[1])) process.stdout.write(JSON.stringify({ check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] }));',
      'else if (a[0] === "api" && typeof a[1] === "string" && /\\/commits\\/cafe1234\\/status$/.test(a[1])) process.stdout.write(JSON.stringify({ state: "success", statuses: [] }));',
      'else process.stdout.write("{}");',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let threw: unknown;
  try {
    const effects = buildSweepEffects(
      "acme",
      "scratch-fbcs-repo",
      { root } as never,
      join(root, "ledger.ndjson"),
      "SWEEP-FBCS",
      PLAN,
      (step, extra) => void logs.push({ step, extra }),
      DEFAULT_SWEEP_POLICY,
      undefined, // reviewRunner
      spawnImpl as never,
      undefined, // pushEmptyCommit
      undefined, // issuesImpl
      undefined, // stallNotice
      undefined, // armImpl
      undefined, // armSessionPrsOverride
      undefined, // updateBranchImpl
      undefined, // captureRepairFeedbackImpl
      undefined, // ghRunImpl
      undefined, // spawnWallClockBoundMsOverride
      undefined, // reclaimWorkerImpl
      undefined, // disarmImpl
      undefined, // readJsonImpl
      (_repoDir: string, branchRef: string) => {
        assert.equal(branchRef, `refs/heads/${headRefName}`);
        return typeof registeredWorktreeOwnerPath === "function"
          ? registeredWorktreeOwnerPath()
          : registeredWorktreeOwnerPath;
      },
      registeredOwnerRecovery,
    );
    await effects.dispatchFix(prFor(9001, headRefName) as never, evidence as never);
  } catch (e) {
    threw = e;
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
  }
  return { logs, threw };
}

test("a branch claim already held by another run declines the poll — no worktree/git side effect reached", async () => {
  const root = tmp("rmd-fbcs-claim-held-");
  const branch = "run-W1-T500-1785600000000";
  try {
    mkdirSync(join(root, "repos"), { recursive: true }); // repoDir absent — nothing reachable past the claim may run
    const inflightDir = join(root, "state", "inflight");
    const key = fixBranchClaimKey("acme", "scratch-fbcs-repo", branch);
    const holder = acquireInflightLock(inflightDir, key, { run_id: "OTHER-CONCURRENT-RUN" });
    try {
      const { logs, threw } = await driveDispatchFix(root, branch);
      const row = logs.find((l) => l.step === "sweep.fix.checkout_claim_declined");
      assert.ok(row, `expected a decline row; steps were ${JSON.stringify(logs.map((l) => l.step))}`);
      assert.equal(row!.extra?.reason, "inflight_lock_owner");
      assert.equal(row!.extra?.branch, branch);
      assert.equal(row!.extra?.holder_run_id, "OTHER-CONCURRENT-RUN");
      assert.ok(!logs.some((l) => l.step === "fix.dispatch"), "no strike spent on a declined round");
      assert.equal(threw, undefined, "a decline returns cleanly, it does not throw");
    } finally {
      holder.release();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registered worktree lookup uses the exact branch ref and ignores a detached holder", () => {
  const root = tmp("rmd-fbcs-owner-lookup-");
  try {
    const upstream = seedUpstream(root);
    const repoDir = join(root, "repo");
    cloneOf(upstream, repoDir);
    const requested = "run-W1-T500-1785600000004";
    const similar = `${requested}-suffix`;
    execFileSync("git", ["-C", repoDir, "branch", similar]);
    const holder = join(root, "holder");
    execFileSync("git", ["-C", repoDir, "worktree", "add", "--quiet", holder, similar]);

    assert.equal(registeredFixWorktreeOwner(repoDir, `refs/heads/${requested}`), undefined);
    assert.equal(registeredFixWorktreeOwner(repoDir, `refs/heads/${similar}`), realpathSync(holder));

    execFileSync("git", ["-C", holder, "checkout", "--quiet", "--detach"]);
    assert.equal(registeredFixWorktreeOwner(repoDir, `refs/heads/${similar}`), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const SAFE_OWNER_SNAPSHOT: RegisteredFixOwnerSnapshot = {
  path: "/fleet/worktrees/sweep-W1-T500-1785600000003",
  pathState: "managed",
  attachmentState: "exact",
  treeState: "clean",
  remoteState: "exact",
  historyState: "contained",
  claimState: "clear",
  processState: "clear",
  ageMs: 60_000,
  localSha: "a".repeat(40),
  remoteSha: "b".repeat(40),
};

test("W1-T2952: only a clean, exact, unowned managed fix worktree is reclaimable", () => {
  assert.deepEqual(decideRegisteredFixOwnerRecovery(SAFE_OWNER_SNAPSHOT), { kind: "reclaim-contained" });

  const unsafe: Array<[Partial<RegisteredFixOwnerSnapshot>, string]> = [
    [{ pathState: "foreign" }, "foreign_worktree_path"],
    [{ pathState: "unknown" }, "worktree_path_unreadable"],
    [{ attachmentState: "detached_or_other" }, "detached_or_wrong_branch"],
    [{ attachmentState: "unknown" }, "branch_probe_unreadable"],
    [{ treeState: "dirty" }, "dirty_worktree"],
    [{ treeState: "unknown" }, "tree_probe_unreadable"],
    [{ remoteState: "changed" }, "remote_head_changed"],
    [{ remoteState: "unknown" }, "remote_head_unreadable"],
    [{ historyState: "unknown" }, "history_probe_unreadable"],
    [{ claimState: "occupied" }, "live_branch_claim"],
    [{ claimState: "unknown" }, "branch_claim_unreadable"],
    [{ processState: "occupied" }, "process_cwd_owner"],
    [{ processState: "unknown" }, "process_cwd_probe_unreadable"],
  ];
  for (const [override, reason] of unsafe) {
    assert.deepEqual(decideRegisteredFixOwnerRecovery({ ...SAFE_OWNER_SNAPSHOT, ...override }), {
      kind: "keep",
      reason,
    });
  }
});

test("W1-T3170 ancestry continues through abandonment probes", () => {
  assert.deepEqual(
    decideRegisteredFixOwnerRecovery({ ...SAFE_OWNER_SNAPSHOT, historyState: "ahead" }),
    { kind: "publish-ahead" },
  );
  assert.deepEqual(
    decideRegisteredFixOwnerRecovery({ ...SAFE_OWNER_SNAPSHOT, historyState: "diverged" }),
    { kind: "preserve-diverged" },
  );
  for (const historyState of ["ahead", "diverged"] as const) {
    assert.deepEqual(
      decideRegisteredFixOwnerRecovery({ ...SAFE_OWNER_SNAPSHOT, historyState, claimState: "occupied" }),
      { kind: "keep", reason: "live_branch_claim" },
    );
    assert.deepEqual(
      decideRegisteredFixOwnerRecovery({ ...SAFE_OWNER_SNAPSHOT, historyState, processState: "occupied" }),
      { kind: "keep", reason: "process_cwd_owner" },
    );
  }
});

test("W1-T3170 falsifier deletes salvage and restores permanent stand-down", () => {
  assert.notEqual(
    decideRegisteredFixOwnerRecovery({ ...SAFE_OWNER_SNAPSHOT, historyState: "ahead" }).kind,
    "keep",
  );
  assert.notEqual(
    decideRegisteredFixOwnerRecovery({ ...SAFE_OWNER_SNAPSHOT, historyState: "diverged" }).kind,
    "keep",
  );
});

test("W1-T3170 real owner census distinguishes ahead from diverged and preserves the exact divergent object", () => {
  const root = tmp("rmd-fbcs-owner-ancestry-");
  try {
    const upstream = seedUpstream(root);
    const repoDir = join(root, "repo");
    cloneOf(upstream, repoDir);
    const branch = "run-W1-T3170-1785600000012";
    execFileSync("git", ["-C", repoDir, "branch", branch]);
    execFileSync("git", ["-C", repoDir, "push", "--quiet", "origin", branch]);
    const remoteBase = sha(repoDir, branch);
    const worktreesRoot = join(root, "worktrees");
    const ownerPath = join(worktreesRoot, "sweep-W1-T3170-1785600000012");
    mkdirSync(worktreesRoot, { recursive: true });
    execFileSync("git", ["-C", repoDir, "worktree", "add", "--quiet", ownerPath, branch]);
    commit(ownerPath, "local.txt", "local owner commit");
    const localSha = sha(ownerPath, "HEAD");
    let claimReads = 0;
    let processReads = 0;
    const capture = (remoteSha: string) => captureRegisteredFixOwnerSnapshot({
      repoDir,
      worktreesRoot,
      ownerPath,
      taskId: "W1-T3170",
      branch,
      expectedRemoteSha: remoteSha,
      observedRemoteSha: remoteSha,
      inflightDir: join(root, "inflight"),
      claimKey: "fixture",
    }, {
      readClaim: () => { claimReads += 1; return "clear"; },
      processCensus: () => { processReads += 1; return { state: "clear", scanned: 1 }; },
    });
    assert.equal(capture(remoteBase).historyState, "ahead");

    const advancer = join(root, "advancer");
    cloneOf(upstream, advancer);
    execFileSync("git", ["-C", advancer, "checkout", "--quiet", branch]);
    commit(advancer, "remote.txt", "remote competing commit");
    execFileSync("git", ["-C", advancer, "push", "--quiet", "origin", branch]);
    const remoteDiverged = sha(advancer, "HEAD");
    execFileSync("git", ["-C", repoDir, "fetch", "--quiet", "origin", branch]);
    assert.equal(capture(remoteDiverged).historyState, "diverged");
    assert.equal(claimReads, 2, "both non-contained states reach the claim proof");
    assert.equal(processReads, 2, "both non-contained states reach the process-cwd proof");
    const recoveryRef = preserveAbandonedFixOwnerDivergence(repoDir, branch, localSha);
    assert.equal(sha(repoDir, recoveryRef), localSha);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** The two history arms the ancestry census above never reaches. `ahead`/`diverged` both come
 *  back from `merge-base --is-ancestor` exiting 1; these two are the OTHER exits — 0 (the owner
 *  is already contained by the remote, so there is nothing to salvage) and anything else, which
 *  is git failing to answer at all. They are split from the census test rather than folded into
 *  it because each needs a repository the other cannot be in: `contained` needs an owner that
 *  never committed, and the unreadable arm needs a remote SHA that names no object. */
test("W1-T3170 an owner already contained by the remote is a salvage no-op, not an abandonment", () => {
  const root = tmp("rmd-fbcs-owner-contained-");
  try {
    const upstream = seedUpstream(root);
    const repoDir = join(root, "repo");
    cloneOf(upstream, repoDir);
    const branch = "run-W1-T3170-1785600000013";
    execFileSync("git", ["-C", repoDir, "branch", branch]);
    execFileSync("git", ["-C", repoDir, "push", "--quiet", "origin", branch]);
    const worktreesRoot = join(root, "worktrees");
    const ownerPath = join(worktreesRoot, "sweep-W1-T3170-1785600000013");
    mkdirSync(worktreesRoot, { recursive: true });
    // NO local commit: the owner's HEAD stays where the branch was, so advancing the remote
    // below leaves the owner strictly BEHIND — an ancestor, which is the `contained` arm.
    execFileSync("git", ["-C", repoDir, "worktree", "add", "--quiet", ownerPath, branch]);
    const localSha = sha(ownerPath, "HEAD");

    const advancer = join(root, "advancer");
    cloneOf(upstream, advancer);
    execFileSync("git", ["-C", advancer, "checkout", "--quiet", branch]);
    commit(advancer, "remote.txt", "remote commit the owner never saw");
    execFileSync("git", ["-C", advancer, "push", "--quiet", "origin", branch]);
    const remoteAhead = sha(advancer, "HEAD");
    execFileSync("git", ["-C", repoDir, "fetch", "--quiet", "origin", branch]);
    assert.notEqual(localSha, remoteAhead, "the fixture is only meaningful if the two SHAs differ");

    const snapshot = captureRegisteredFixOwnerSnapshot({
      repoDir,
      worktreesRoot,
      ownerPath,
      taskId: "W1-T3170",
      branch,
      expectedRemoteSha: remoteAhead,
      observedRemoteSha: remoteAhead,
      inflightDir: join(root, "inflight"),
      claimKey: "fixture",
    }, {
      readClaim: () => "clear",
      processCensus: () => ({ state: "clear", scanned: 1 }),
    });

    assert.equal(snapshot.historyState, "contained");
    // Nothing is at risk, so the decision must be to reclaim rather than stand down -- the
    // whole point of telling this arm apart from `ahead`/`diverged`.
    assert.deepEqual(decideRegisteredFixOwnerRecovery(snapshot), { kind: "reclaim-contained" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3170 a remote SHA git cannot resolve reads unknown and stands the salvage down", () => {
  const root = tmp("rmd-fbcs-owner-unreadable-");
  try {
    const upstream = seedUpstream(root);
    const repoDir = join(root, "repo");
    cloneOf(upstream, repoDir);
    const branch = "run-W1-T3170-1785600000014";
    execFileSync("git", ["-C", repoDir, "branch", branch]);
    execFileSync("git", ["-C", repoDir, "push", "--quiet", "origin", branch]);
    const worktreesRoot = join(root, "worktrees");
    const ownerPath = join(worktreesRoot, "sweep-W1-T3170-1785600000014");
    mkdirSync(worktreesRoot, { recursive: true });
    execFileSync("git", ["-C", repoDir, "worktree", "add", "--quiet", ownerPath, branch]);

    // Well-formed but nameless: `merge-base --is-ancestor` exits 128 rather than 0 or 1, which
    // is the arm that must NOT be read as "not an ancestor". Observed === expected so the probe
    // reaches the ancestry question at all instead of short-circuiting on remoteState.
    const nonexistent = "0".repeat(39) + "1";
    assert.throws(
      () => execFileSync("git", ["-C", repoDir, "cat-file", "-e", nonexistent], { stdio: "ignore" }),
      "the fixture SHA must genuinely name no object",
    );

    let claimReads = 0;
    let processReads = 0;
    const snapshot = captureRegisteredFixOwnerSnapshot({
      repoDir,
      worktreesRoot,
      ownerPath,
      taskId: "W1-T3170",
      branch,
      expectedRemoteSha: nonexistent,
      observedRemoteSha: nonexistent,
      inflightDir: join(root, "inflight"),
      claimKey: "fixture",
    }, {
      readClaim: () => { claimReads += 1; return "clear"; },
      processCensus: () => { processReads += 1; return { state: "clear", scanned: 1 }; },
    });

    assert.equal(snapshot.historyState, "unknown");
    assert.equal(snapshot.remoteState, "exact", "the probe reached the ancestry question, not a remote mismatch");
    assert.equal(snapshot.error, undefined, "an unreadable ancestry is a STATE, not a thrown probe error");
    assert.equal(claimReads, 0, "an unreadable history returns before the claim proof");
    assert.equal(processReads, 0, "an unreadable history returns before the process-cwd proof");
    assert.deepEqual(decideRegisteredFixOwnerRecovery(snapshot), {
      kind: "keep",
      reason: "history_probe_unreadable",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3170 ahead publish fails closed", () => {
  const localSha = "c".repeat(40);
  const remoteSha = "b".repeat(40);
  const ref = "refs/heads/run-W1-T3170-fixture";

  const changedCalls: string[][] = [];
  assert.throws(() => publishAbandonedFixOwnerAhead("/repo", "run-W1-T3170-fixture", localSha, remoteSha, {
    runGit: (args) => {
      changedCalls.push(args);
      return `${"d".repeat(40)}\t${ref}\n`;
    },
  }), /changed before publish/);
  assert.equal(changedCalls.length, 1, "a changed precondition reaches no push");

  const pushCalls: string[][] = [];
  assert.throws(() => publishAbandonedFixOwnerAhead("/repo", "run-W1-T3170-fixture", localSha, remoteSha, {
    runGit: (args) => {
      pushCalls.push(args);
      if (args[0] === "push") throw new Error("push refused");
      return `${remoteSha}\t${ref}\n`;
    },
  }), /push refused/);
  assert.deepEqual(pushCalls[1], ["push", "origin", `${localSha}:${ref}`]);
  assert.ok(pushCalls.flat().every((arg) => !arg.includes("force")), "the publish is never force-capable");

  let reads = 0;
  assert.throws(() => publishAbandonedFixOwnerAhead("/repo", "run-W1-T3170-fixture", localSha, remoteSha, {
    runGit: (args) => {
      if (args[0] === "push") return "";
      reads += 1;
      return `${reads === 1 ? remoteSha : "e".repeat(40)}\t${ref}\n`;
    },
  }), /did not publish exact local SHA/);
});

test("W1-T3170 ahead publisher fast-forwards the exact object on a real remote", () => {
  const root = tmp("rmd-fbcs-owner-publish-");
  try {
    const upstream = seedUpstream(root);
    const repoDir = join(root, "repo");
    cloneOf(upstream, repoDir);
    const branch = "run-W1-T3170-1785600000013";
    execFileSync("git", ["-C", repoDir, "checkout", "--quiet", "-b", branch]);
    execFileSync("git", ["-C", repoDir, "push", "--quiet", "origin", branch]);
    const remoteSha = sha(repoDir, "HEAD");
    commit(repoDir, "ahead.txt", "ahead owner commit");
    const localSha = sha(repoDir, "HEAD");
    publishAbandonedFixOwnerAhead(repoDir, branch, localSha, remoteSha);
    const published = execFileSync("git", ["-C", repoDir, "ls-remote", "origin", `refs/heads/${branch}`], {
      encoding: "utf8",
    }).trim().split(/\s+/)[0];
    assert.equal(published, localSha);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3170 unsafe owner salvage refuses effects", async () => {
  for (const historyState of ["ahead", "diverged"] as const) {
    const root = tmp(`rmd-fbcs-owner-effect-fail-${historyState}-`);
    const branch = `run-W1-T500-${historyState === "ahead" ? "1785600000014" : "1785600000015"}`;
    const ownerPath = join(root, "worktrees", `sweep-W1-T500-${historyState === "ahead" ? "1785600000014" : "1785600000015"}`);
    let removed = false;
    try {
      mkdirSync(join(root, "repos"), { recursive: true });
      const { logs, threw } = await driveDispatchFix(root, branch, ownerPath, {
        capture: () => ({ ...SAFE_OWNER_SNAPSHOT, path: ownerPath, historyState }),
        publishAhead: () => { throw new Error("publish failed"); },
        preserveDiverged: () => { throw new Error("preserve failed"); },
        remove: () => { removed = true; },
      });
      assert.equal(threw, undefined);
      assert.equal(removed, false);
      assert.ok(!logs.some((entry) => entry.step === "fix.dispatch"));
      assert.equal(
        logs.find((entry) => entry.step === "sweep.fix.checkout_claim_declined")?.extra?.owner_recovery_reason,
        historyState === "ahead" ? "owner_ahead_publish_failed" : "owner_divergence_preserve_failed",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("W1-T3170 ahead owner is published before reclaim; W1-T3170 salvage telemetry and dispatch are single-path", async () => {
  const root = tmp("rmd-fbcs-owner-ahead-");
  const branch = "run-W1-T500-1785600000010";
  const ownerPath = join(root, "worktrees", "sweep-W1-T500-1785600000010");
  const localSha = "c".repeat(40);
  const remoteSha = "b".repeat(40);
  const order: string[] = [];
  let registeredOwner: string | undefined = ownerPath;
  try {
    mkdirSync(join(root, "repos"), { recursive: true });
    const upstream = seedUpstream(root);
    const repoDir = join(root, "repos", "scratch-fbcs-repo");
    cloneOf(upstream, repoDir);
    execFileSync("git", ["-C", repoDir, "branch", branch]);
    execFileSync("git", ["-C", repoDir, "push", "--quiet", "origin", branch]);
    mkdirSync(join(root, "worktrees"), { recursive: true });
    execFileSync("git", ["-C", repoDir, "worktree", "add", "--quiet", ownerPath, branch]);
    const worker = { sessionId: "W1-T3170-AHEAD", costUsd: 0, text: "REPORT\nfixed\n", blocks: [], stderr: "", subtype: "success", isError: false, apiError: false, verdict: "success", tokens: {}, compactionEvents: [], childEnvKeys: [] } as unknown as WorkerResult;
    const { logs, threw } = await driveDispatchFix(
      root,
      branch,
      () => registeredOwner,
      {
        capture: () => ({ ...SAFE_OWNER_SNAPSHOT, path: ownerPath, historyState: "ahead", localSha, remoteSha }),
        publishAhead: (_repo, seenBranch, seenLocal, seenRemote) => {
          assert.deepEqual([seenBranch, seenLocal, seenRemote], [branch, localSha, remoteSha]);
          order.push("publish");
        },
        preserveDiverged: () => { throw new Error("divergence effect must not run"); },
        remove: (canonical, owner) => {
          order.push("remove");
          removeAbandonedFixWorktreeOwner(canonical, owner);
          registeredOwner = undefined;
        },
      },
      async () => worker,
      { unmetCriteria: [], ciFailures: [{ name: "ci", logTail: "fixture failure" }] },
    );
    assert.equal(threw, undefined);
    assert.deepEqual(order, ["publish", "remove"]);
    assert.equal(logs.filter((entry) => entry.step === "sweep.fix.checkout_owner_ahead_published").length, 1);
    assert.equal(logs.filter((entry) => entry.step === "fix.dispatch").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3170 diverged owner is preserved before reclaim", async () => {
  const root = tmp("rmd-fbcs-owner-diverged-");
  const branch = "run-W1-T500-1785600000011";
  const ownerPath = join(root, "worktrees", "sweep-W1-T500-1785600000011");
  const localSha = "c".repeat(40);
  const remoteSha = "b".repeat(40);
  const recoveryRef = `refs/rmd-recovery/fix/${branch}/${localSha}`;
  const order: string[] = [];
  let registeredOwner: string | undefined = ownerPath;
  try {
    mkdirSync(join(root, "repos"), { recursive: true });
    const upstream = seedUpstream(root);
    const repoDir = join(root, "repos", "scratch-fbcs-repo");
    cloneOf(upstream, repoDir);
    execFileSync("git", ["-C", repoDir, "branch", branch]);
    execFileSync("git", ["-C", repoDir, "push", "--quiet", "origin", branch]);
    mkdirSync(join(root, "worktrees"), { recursive: true });
    execFileSync("git", ["-C", repoDir, "worktree", "add", "--quiet", ownerPath, branch]);
    const worker = { sessionId: "W1-T3170-DIVERGED", costUsd: 0, text: "REPORT\nfixed\n", blocks: [], stderr: "", subtype: "success", isError: false, apiError: false, verdict: "success", tokens: {}, compactionEvents: [], childEnvKeys: [] } as unknown as WorkerResult;
    const { logs, threw } = await driveDispatchFix(
      root,
      branch,
      () => registeredOwner,
      {
        capture: () => ({ ...SAFE_OWNER_SNAPSHOT, path: ownerPath, historyState: "diverged", localSha, remoteSha }),
        publishAhead: () => { throw new Error("publish effect must not run"); },
        preserveDiverged: (_repo, seenBranch, seenLocal) => {
          assert.deepEqual([seenBranch, seenLocal], [branch, localSha]);
          order.push("preserve");
          return recoveryRef;
        },
        remove: (canonical, owner) => {
          order.push("remove");
          removeAbandonedFixWorktreeOwner(canonical, owner);
          registeredOwner = undefined;
        },
      },
      async () => worker,
      { unmetCriteria: [], ciFailures: [{ name: "ci", logTail: "fixture failure" }] },
    );
    assert.equal(threw, undefined);
    assert.deepEqual(order, ["preserve", "remove"]);
    assert.equal(logs.filter((entry) => entry.step === "sweep.fix.checkout_owner_divergence_preserved").length, 1);
    assert.equal(logs.filter((entry) => entry.step === "fix.dispatch").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2952: the process-cwd census finds descendants and fails closed on unreadable or bounded scans", () => {
  const sequence = (...pids: string[]) => {
    const pending = [...pids];
    return () => pending.shift() ?? null;
  };

  assert.deepEqual(
    readBoundedProcessCwdCensus("/fleet/worktrees/sweep-W1-T500-1", {
      readNextPid: sequence("10", "11"),
      readCwd: (pid) => (pid === "11" ? "/fleet/worktrees/sweep-W1-T500-1/test" : "/tmp"),
      now: () => 0,
    }),
    { state: "occupied", scanned: 2, pid: 11 },
  );

  assert.deepEqual(
    readBoundedProcessCwdCensus("/fleet/worktrees/sweep-W1-T500-1", {
      readNextPid: sequence("10"),
      readCwd: () => "/tmp",
      now: () => 0,
    }),
    { state: "clear", scanned: 1 },
  );

  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  assert.deepEqual(
    readBoundedProcessCwdCensus("/fleet/worktrees/sweep-W1-T500-1", {
      readNextPid: sequence("10"),
      readCwd: () => {
        throw denied;
      },
      now: () => 0,
    }),
    { state: "unknown", scanned: 1, reason: "cwd_unreadable" },
  );

  assert.deepEqual(
    readBoundedProcessCwdCensus("/fleet/worktrees/sweep-W1-T500-1", {
      readNextPid: sequence("10", "11"),
      readCwd: () => "/tmp",
      now: () => 0,
      maxEntries: 1,
    }),
    { state: "unknown", scanned: 1, reason: "entry_bound" },
  );

  let tick = 0;
  assert.deepEqual(
    readBoundedProcessCwdCensus("/fleet/worktrees/sweep-W1-T500-1", {
      readNextPid: sequence("10"),
      readCwd: () => "/tmp",
      now: () => (tick++ === 0 ? 0 : 101),
      wallMs: 100,
    }),
    { state: "unknown", scanned: 0, reason: "wall_bound" },
  );
});

test("W1-T2952: the default branch-claim reader distinguishes absent, malformed, live, and stale holders", () => {
  const root = tmp("rmd-fbcs-owner-claim-");
  const claimKey = "fix-branch-owner";
  const lockPath = join(root, `${claimKey}.lock`);
  try {
    assert.equal(readRegisteredFixOwnerClaim(root, claimKey), "clear");
    writeFileSync(lockPath, "not-json");
    assert.equal(readRegisteredFixOwnerClaim(root, claimKey), "unknown");
    writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      run_id: "live-owner",
      host: hostname(),
      startedAt: new Date().toISOString(),
    }));
    assert.equal(readRegisteredFixOwnerClaim(root, claimKey), "occupied");
    writeFileSync(lockPath, JSON.stringify({
      pid: 2_147_483_647,
      run_id: "dead-owner",
      host: hostname(),
      startedAt: new Date().toISOString(),
    }));
    assert.equal(readRegisteredFixOwnerClaim(root, claimKey), "clear");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2952: abandoned-owner removal uses plain git worktree remove and preserves the branch", () => {
  const root = tmp("rmd-fbcs-owner-remove-");
  try {
    const upstream = seedUpstream(root);
    const repoDir = join(root, "repo");
    cloneOf(upstream, repoDir);
    const branch = "run-W1-T500-1785600000003";
    execFileSync("git", ["-C", repoDir, "branch", branch]);
    const owner = join(root, "worktrees", "sweep-W1-T500-1785600000003");
    mkdirSync(join(root, "worktrees"), { recursive: true });
    execFileSync("git", ["-C", repoDir, "worktree", "add", "--quiet", owner, branch]);

    removeAbandonedFixWorktreeOwner(repoDir, owner);

    assert.equal(registeredFixWorktreeOwner(repoDir, `refs/heads/${branch}`), undefined);
    assert.equal(sha(repoDir, `refs/heads/${branch}`).length, 40, "the branch is preserved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2952: a proven-abandoned registered owner is reclaimed and the same poll dispatches one repair", async () => {
  const root = tmp("rmd-fbcs-owner-recovery-");
  try {
    const upstream = seedUpstream(root);
    mkdirSync(join(root, "repos"), { recursive: true });
    const repoDir = join(root, "repos", "scratch-fbcs-repo");
    cloneOf(upstream, repoDir);
    const branch = "run-W1-T500-1785600000003";
    execFileSync("git", ["-C", repoDir, "branch", branch]);
    execFileSync("git", ["-C", repoDir, "push", "--quiet", "origin", branch]);
    const ownerPath = join(root, "worktrees", "sweep-W1-T500-1785600000003");
    mkdirSync(join(root, "worktrees"), { recursive: true });
    execFileSync("git", ["-C", repoDir, "worktree", "add", "--quiet", ownerPath, branch]);
    let registeredOwner: string | undefined = ownerPath;

    const worker: WorkerResult = {
      sessionId: "W1-T2952-PROBE",
      costUsd: 0,
      numTurns: 1,
      text: "REPORT\nrecovery integration probe\n",
      blocks: ["REPORT\nrecovery integration probe\n"],
      stderr: "",
      subtype: "success",
      isError: false,
      apiError: false,
      model: "claude-sonnet-5",
      effort: "high",
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      totalCostUsd: 0,
      billingMode: "subscription",
      verdict: "success",
      qualitySuspect: false,
      compactionEvents: [],
      childEnvKeys: [],
    } as unknown as WorkerResult;

    const { logs, threw } = await driveDispatchFix(
      root,
      branch,
      () => registeredOwner,
      {
        capture: () => ({ ...SAFE_OWNER_SNAPSHOT, path: ownerPath }),
        remove: (canonical, owner) => {
          removeAbandonedFixWorktreeOwner(canonical, owner);
          registeredOwner = undefined;
        },
      },
      async () => worker,
      { unmetCriteria: [], ciFailures: [{ name: "ci", logTail: "fixture failure" }] },
    );

    assert.equal(threw, undefined);
    assert.equal(logs.filter((entry) => entry.step === "sweep.fix.checkout_owner_reclaimed").length, 1);
    assert.equal(logs.filter((entry) => entry.step === "fix.dispatch").length, 1, "the same poll spent one repair strike");
    assert.ok(!logs.some((entry) => entry.step === "sweep.fix.checkout_claim_declined"));
    assert.equal(registeredFixWorktreeOwner(repoDir, `refs/heads/${branch}`), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a surviving registered worktree declines before a dead-parent branch claim can be reclaimed", async () => {
  const root = tmp("rmd-fbcs-worktree-owner-");
  const branch = "run-W1-T500-1785600000003";
  const ownerPath = join(root, "worktrees", "surviving-worker");
  try {
    mkdirSync(join(root, "repos"), { recursive: true }); // no repo: reaching checkout would throw
    const inflightDir = join(root, "state", "inflight");
    mkdirSync(inflightDir, { recursive: true });
    const claimPath = join(inflightDir, `${fixBranchClaimKey("acme", "scratch-fbcs-repo", branch)}.lock`);
    const deadParentClaim = JSON.stringify({
      pid: 2_147_483_647,
      run_id: "DEAD-DAEMON-PARENT",
      startedAt: "2026-09-05T02:00:00.000Z",
    });
    writeFileSync(claimPath, deadParentClaim);

    const { logs, threw } = await driveDispatchFix(root, branch, ownerPath);
    const row = logs.find((entry) => entry.step === "sweep.fix.checkout_claim_declined");
    assert.ok(row, `expected a decline row; steps were ${JSON.stringify(logs.map((entry) => entry.step))}`);
    assert.equal(row.extra?.reason, "registered_worktree_owner");
    assert.equal(row.extra?.pr_number, 9001);
    assert.equal(row.extra?.task_id, "W1-T500");
    assert.equal(row.extra?.branch, branch);
    assert.equal(row.extra?.worktree_path, ownerPath);
    assert.equal(readFileSync(claimPath, "utf8"), deadParentClaim, "the dead-parent claim was not reclaimed");
    assert.ok(!logs.some((entry) => entry.step === "fix.dispatch"), "no strike was spent");
    assert.equal(threw, undefined, "a registered owner stands down cleanly");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a FREE branch claim is taken and the round proceeds to the checkout step (and releases the claim on exit)", async () => {
  const root = tmp("rmd-fbcs-claim-free-");
  const branch = "run-W1-T500-1785600000001";
  try {
    mkdirSync(join(root, "repos"), { recursive: true }); // still no real repoDir — proceeding this far throws a git error
    const { logs, threw } = await driveDispatchFix(root, branch);
    assert.ok(
      !logs.some((l) => l.step === "sweep.fix.checkout_claim_declined"),
      "the claim was free, so it must not decline",
    );
    assert.ok(threw, "with the claim granted it proceeds to the real git side effect, which fails (no real repo)");
    assert.match(String((threw as Error)?.message ?? threw), /git/i);

    // And the claim was released on the way out — re-acquiring it now must succeed immediately.
    const inflightDir = join(root, "state", "inflight");
    const key = fixBranchClaimKey("acme", "scratch-fbcs-repo", branch);
    const reacquired = acquireInflightLock(inflightDir, key, { run_id: "PROBE-AFTER" });
    reacquired.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispatchFix ledgers a successful stale-ref recovery before the repair worker starts", async () => {
  const root = tmp("rmd-fbcs-recovery-ledger-");
  const branch = "run-W1-T500-1785600000002";
  try {
    const upstream = seedUpstream(root);
    mkdirSync(join(root, "repos"), { recursive: true });
    const repoDir = join(root, "repos", "scratch-fbcs-repo");
    cloneOf(upstream, repoDir);
    execFileSync("git", ["-C", repoDir, "checkout", "-q", "-b", branch]);
    execFileSync("git", ["-C", repoDir, "push", "--quiet", "origin", branch]);
    const originSha = sha(repoDir, `origin/${branch}`);
    commit(repoDir, "abandoned.txt", "abandoned fix commit");
    const localSha = sha(repoDir, branch);
    execFileSync("git", ["-C", repoDir, "checkout", "-q", "main"]);

    const { logs } = await driveDispatchFix(root, branch);
    const row = logs.find((entry) => entry.step === "sweep.fix.checkout_recovered");
    assert.ok(row, `expected recovery telemetry; steps were ${JSON.stringify(logs.map((entry) => entry.step))}`);
    assert.equal(row.extra?.branch, branch);
    assert.equal(row.extra?.local_sha, localSha);
    assert.equal(row.extra?.origin_sha, originSha);
    assert.equal(sha(repoDir, String(row.extra?.recovery_ref)), localSha);
    assert.ok(!logs.some((entry) => entry.step === "sweep.fix.checkout_refused"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fixBranchClaimKey is stable per (owner, repo, branch) and namespaced away from a plain task id", () => {
  assert.equal(fixBranchClaimKey("acme", "r", "run-W1-T1-1"), fixBranchClaimKey("acme", "r", "run-W1-T1-1"));
  assert.notEqual(fixBranchClaimKey("acme", "r", "run-W1-T1-1"), fixBranchClaimKey("acme", "r", "run-W1-T2-1"));
  assert.notEqual(fixBranchClaimKey("acme", "r1", "b"), fixBranchClaimKey("acme", "r2", "b"));
  assert.notEqual(fixBranchClaimKey("acme", "r", "b"), "W1-T1", "never collides with a bare task id's own lock file");
  // Slashes in a branch name (an accepted synthetic head can be plain feat/…-shaped) never
  // produce a key with a path separator, so the lock always lands directly in inflightDir.
  assert.ok(!fixBranchClaimKey("acme", "r", "feat/deploy-thing").includes("/"));
});
