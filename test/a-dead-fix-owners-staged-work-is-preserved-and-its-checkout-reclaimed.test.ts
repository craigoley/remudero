/**
 * W1-T6362. A fix worker killed mid-round (a daemon restart, a drain-and-recycle) leaves a
 * staged-only edit in its sweep worktree at the PR's CURRENT head. W1-T5974 preserved and reclaimed
 * that residue only once the PR had moved past the owner; at the current head it kept W1-T5918's
 * `owner_dirty_staged_only_refused` decline, and FIX_CLAIM_DECLINE_BACKSTOP turned three of them
 * into a BLOCKED escalation (#10041, #10063, #10066, #10071, #10074 on 2026-10-08) that held the
 * PR's fix lane until a human answered.
 *
 * Nothing is lost by reclaiming: the owner is proven dead (claim and process census both clear)
 * before the residue is read, and the staged diff is preserved from the index into an immutable
 * recovery ref whose tree is proven equal to the owner's index before anything is reset. So a dead
 * owner's staged-only residue at the current head is now preserved, receipted as
 * `sweep.fix.owner_residue_preserved`, reset, removed and reclaimed in the same pass. A LIVE owner
 * is never touched, and a preserve that fails is still declined by name, head-stamped, and
 * escalated once at the backstop. Every fixture is a REAL git repository.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildSweepEffects,
  captureRegisteredFixOwnerSnapshot,
  preserveOrDiscardFixOwnerResidue,
  preserveStagedFixOwnerResidue,
  registeredFixWorktreeOwner,
  removeAbandonedFixWorktreeOwner,
  resetTrackedDirtyFixOwner,
  type BuildSweepEffectsDeps,
} from "../src/run-task.js";
import { DEFAULT_SWEEP_POLICY, FIX_CLAIM_DECLINE_BACKSTOP, runSweep, type OpenPrView } from "../src/lib/sweep.js";
import { readLedgerLines } from "../src/lib/status.js";
import { ghShim } from "./helpers/gh-shim.js";
import { gitRepo } from "./helpers/git-repo.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { WorkerResult } from "../src/lib/worker.js";

const TASK = "W1-T600";
const PR = 10041;
const STAGED = "staged.test.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const sha = (dir: string, ref: string): string => git(dir, "rev-parse", ref).trim();
const status = (dir: string): string => git(dir, "status", "--porcelain=v1");
const realpathOf = (p: string): string => execFileSync("realpath", [p], { encoding: "utf8" }).trim();

interface Fixture {
  root: string;
  repoDir: string;
  worktreesRoot: string;
  ownerPath: string;
  branch: string;
  ownerSha: string;
}

/** An upstream, the sweep's own copy of it, and a pushed run branch checked out in a managed
 *  `sweep-<task>-<epoch>` owner holding a staged-only edit (index differs, working tree == HEAD).
 *  The PR head IS the owner's HEAD: the PR has not moved past the dead worker. */
function fixture(epoch: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1t6362-"));
  const upstream = gitRepo({ bare: true, kind: "w1t6362-upstream" });
  const repoDir = join(root, "repos", "scratch-fbcs-repo");
  mkdirSync(join(root, "repos"), { recursive: true });
  git(root, "clone", "--quiet", upstream.dir, repoDir);
  git(repoDir, "config", "user.email", "probe@example.invalid");
  git(repoDir, "config", "user.name", "probe");
  git(repoDir, "checkout", "--quiet", "-b", "main");
  writeFileSync(join(repoDir, STAGED), "base\n");
  git(repoDir, "add", "--", STAGED);
  git(repoDir, "commit", "--no-verify", "--quiet", "-m", "chore: seed");
  git(repoDir, "push", "--quiet", "origin", "main");
  const branch = `run-${TASK}-${epoch}`;
  git(repoDir, "push", "--quiet", "origin", `main:refs/heads/${branch}`);
  git(repoDir, "fetch", "--quiet", "origin");
  git(repoDir, "branch", "--quiet", branch, `origin/${branch}`);
  const worktreesRoot = join(root, "worktrees");
  mkdirSync(worktreesRoot, { recursive: true });
  const ownerPath = join(worktreesRoot, `sweep-${TASK}-${epoch}`);
  git(repoDir, "worktree", "add", "--quiet", ownerPath, branch);
  writeFileSync(join(ownerPath, STAGED), "dead worker's staged edit\n");
  git(ownerPath, "add", "--", STAGED);
  writeFileSync(join(ownerPath, STAGED), "base\n");
  return { root, repoDir, worktreesRoot, ownerPath, branch, ownerSha: sha(ownerPath, "HEAD") };
}

const PLAN: Plan = (() => {
  const tasks = [
    { id: TASK, title: TASK, risk: "low", acceptance: [], verify: "auto", files: [], status: "queued" } as unknown as Task,
  ];
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
})();

const WORKER = {
  sessionId: "W1-T6362-PROBE",
  costUsd: 0,
  text: "REPORT\nresidue probe\n",
  blocks: [],
  stderr: "",
  subtype: "success",
  isError: false,
  apiError: false,
  verdict: "success",
  tokens: {},
  compactionEvents: [],
  childEnvKeys: [],
} as unknown as WorkerResult;

type Log = { step: string; extra?: Record<string, unknown> };

function view(head: string): OpenPrView {
  return {
    prNumber: PR,
    prUrl: `https://github.com/acme/scratch-fbcs-repo/pull/${PR}`,
    headSha: head,
    taskId: TASK,
    reviewState: "failure",
    checksState: "green",
    unmetCriteria: [{ claim: "a criterion", proof: "unit test: x", met: false, reason: "not done", proof_exec: "not_executable" }],
    priorStrikes: 0,
    lastActivityAt: new Date().toISOString(),
  } as unknown as OpenPrView;
}

interface Opts {
  claim?: "clear" | "occupied";
  preserveStaged?: (repoDir: string, ownerPath: string, branch: string, localSha: string) => string;
  ledgerPath?: string;
  readPreservedOwnerPatchImpl?: BuildSweepEffectsDeps["readPreservedOwnerPatchImpl"];
}

/** The real sweep effects over the real owner; only the capture's remote head and censuses are pinned. */
function effectsFor(f: Fixture, head: string, logs: Log[], order: string[], opts: Opts = {}) {
  return buildSweepEffects({
    resolveTaskContractAtHeadImpl: () => ({ criteria: [] }),
    owner: "acme",
    repo: "scratch-fbcs-repo",
    config: { root: f.root } as never,
    ledgerPath: join(f.root, "effects-ledger.ndjson"),
    runId: "SWEEP-W1T6362",
    plan: PLAN,
    log: (step, extra) => {
      logs.push({ step, extra });
      if (opts.ledgerPath) appendFileSync(opts.ledgerPath, `${JSON.stringify({ ts: new Date().toISOString(), step, ...extra })}\n`);
    },
    policy: DEFAULT_SWEEP_POLICY,
    spawnImpl: (async () => WORKER) as never,
    registeredWorktreeOwnerImpl: (repoDir: string, branchRef: string) => registeredFixWorktreeOwner(repoDir, branchRef),
    ...(opts.readPreservedOwnerPatchImpl ? { readPreservedOwnerPatchImpl: opts.readPreservedOwnerPatchImpl } : {}),
    registeredOwnerRecovery: {
      capture: () =>
        captureRegisteredFixOwnerSnapshot(
          {
            repoDir: f.repoDir,
            worktreesRoot: f.worktreesRoot,
            ownerPath: f.ownerPath,
            taskId: TASK,
            branch: f.branch,
            expectedRemoteSha: head,
            observedRemoteSha: head,
            inflightDir: join(f.root, "inflight"),
            claimKey: "fixture",
          },
          { readClaim: () => opts.claim ?? "clear", processCensus: () => ({ state: "clear", scanned: 1 }) },
        ),
      preserveTrackedDirty: (repoDir: string, ownerPath: string, branch: string, localSha: string) => {
        order.push("residue");
        return preserveOrDiscardFixOwnerResidue(repoDir, ownerPath, branch, localSha);
      },
      preserveStagedResidue: (repoDir: string, ownerPath: string, branch: string, localSha: string) => {
        order.push("preserve-staged");
        return (opts.preserveStaged ?? preserveStagedFixOwnerResidue)(repoDir, ownerPath, branch, localSha);
      },
      resetTrackedDirty: (_repoDir: string, ownerPath: string, _branch: string, localSha: string) => {
        order.push("reset");
        resetTrackedDirtyFixOwner(ownerPath, localSha);
      },
      remove: (repoDir: string, ownerPath: string) => {
        order.push("remove");
        removeAbandonedFixWorktreeOwner(repoDir, ownerPath);
      },
    },
  } as BuildSweepEffectsDeps);
}

async function withGh<T>(f: Fixture, head: string, run: () => Promise<T>): Promise<T> {
  const pr = JSON.stringify({ state: "open", merged: false, head: { sha: head, ref: f.branch }, base: { sha: "deadbeef" } });
  const shim = ghShim(
    [
      { when: `commits/${head}/check-runs`, stdout: JSON.stringify({ check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] }) },
      { when: `commits/${head}/status`, stdout: JSON.stringify({ state: "success", statuses: [] }) },
      { when: "headRefName", stdout: JSON.stringify({ headRefName: f.branch, headRefOid: head, body: "" }) },
      { when: `pulls/${PR}`, stdout: pr },
      { when: "", stdout: "{}" },
    ],
    { kind: "w1t6362" },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath}`;
  try {
    return await run();
  } finally {
    process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
  }
}

const steps = (logs: Log[], step: string): Log[] => logs.filter((entry) => entry.step === step);

test("W1-T6362: a dead owner's staged work at the current head is preserved and reclaimed", async () => {
  const f = fixture("1791480000001");
  try {
    const prHead = f.ownerSha;
    assert.equal(git(f.ownerPath, "diff", "--binary", f.ownerSha), "", "the working tree equals HEAD");
    assert.match(status(f.ownerPath), /^MM staged\.test\.ts$/m, "the residue is staged-only (index differs; working tree restored to HEAD)");
    const stagedTree = git(f.ownerPath, "write-tree").trim();
    const ownerRealpath = realpathOf(f.ownerPath);
    const logs: Log[] = [];
    const order: string[] = [];
    const outcome = await withGh(f, prHead, async () =>
      effectsFor(f, prHead, logs, order).dispatchFix(view(prHead) as never, { unmetCriteria: [], ciFailures: [{ name: "ci", logTail: "red" }] } as never),
    );
    assert.equal(typeof outcome === "object" && outcome !== null && "claimDeclined" in outcome, false, "the claim is not declined");
    assert.deepEqual(steps(logs, "sweep.fix.checkout_claim_declined"), [], "never owner_dirty_staged_only_refused at the current head");
    assert.deepEqual(order, ["residue", "preserve-staged", "reset", "remove"]);

    const preserved = steps(logs, "sweep.fix.owner_residue_preserved");
    assert.equal(preserved.length, 1, "one receipt names what was preserved and where");
    const row = preserved[0].extra ?? {};
    assert.equal(row.pr_number, PR);
    assert.equal(row.task_id, TASK);
    assert.equal(row.branch, f.branch);
    assert.equal(row.worktree_path, ownerRealpath, "the receipt names the dead worktree");
    assert.deepEqual(row.staged_paths, [STAGED], "the receipt names the staged paths");
    assert.equal(row.staged_more, 0);
    assert.equal(row.local_sha_prefix, f.ownerSha.slice(0, 12));
    assert.equal(row.head_sha, prHead, "the receipt names the PR head it was preserved at");
    assert.ok(!Number.isNaN(Date.parse(String(row.preserved_at))), `preserved_at is a timestamp: ${String(row.preserved_at)}`);
    const ref = String(row.recovery_ref);
    assert.match(ref, new RegExp(`^refs/rmd-recovery/fix-dirty/${f.branch}/${f.ownerSha}/`), "the receipt names where the work lives");
    assert.equal(git(f.repoDir, "show", `${ref}:${STAGED}`), "dead worker's staged edit\n", "the staged edit survives in the ref");
    assert.equal(sha(f.repoDir, `${ref}^{tree}`), stagedTree, "the ref holds the owner's exact index tree");
    assert.equal(sha(f.repoDir, `${ref}^`), f.ownerSha);
    assert.equal(steps(logs, "sweep.fix.checkout_owner_residue_discarded").length, 0, "preserved, not discarded");

    const reclaimed = steps(logs, "sweep.fix.checkout_owner_reclaimed");
    assert.equal(reclaimed.length, 1);
    const proof = reclaimed[0].extra?.proof as Record<string, unknown>;
    assert.equal(proof.recovery_ref, ref);
    assert.equal(proof.residue_discarded, false);
    assert.equal(proof.no_live_claim, true);
    assert.equal(proof.no_process_cwd, true);
    assert.equal(registeredFixWorktreeOwner(f.repoDir, `refs/heads/${f.branch}`), undefined, "the dead worktree is released");
    assert.equal(steps(logs, "fix.dispatch").length, 1, "the same pass dispatches exactly one repair worker");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("W1-T6362: a LIVE owner's staged work at the current head is never touched", async () => {
  const f = fixture("1791480000002");
  try {
    const prHead = f.ownerSha;
    const before = status(f.ownerPath);
    const logs: Log[] = [];
    const order: string[] = [];
    await withGh(f, prHead, async () =>
      effectsFor(f, prHead, logs, order, { claim: "occupied" }).dispatchFix(
        view(prHead) as never,
        { unmetCriteria: [], ciFailures: [{ name: "ci", logTail: "red" }] } as never,
      ),
    );
    const declines = steps(logs, "sweep.fix.checkout_claim_declined");
    assert.equal(declines.length, 1);
    assert.equal(declines[0].extra?.owner_recovery_reason, "live_branch_claim");
    assert.deepEqual(order, [], "no residue read, no preserve, no reset, no removal");
    assert.equal(steps(logs, "sweep.fix.owner_residue_preserved").length, 0);
    assert.equal(steps(logs, "fix.dispatch").length, 0);
    assert.equal(status(f.ownerPath), before, "the owner is untouched");
    assert.equal(git(f.repoDir, "for-each-ref", "refs/rmd-recovery/"), "");
    assert.equal(registeredFixWorktreeOwner(f.repoDir, `refs/heads/${f.branch}`), realpathOf(f.ownerPath));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("W1-T6362: a failed preserve at the current head is still declined by name, head-stamped, and escalated once naming the worktree and paths", async () => {
  const f = fixture("1791480000003");
  try {
    const prHead = f.ownerSha;
    const before = status(f.ownerPath);
    const ledgerPath = join(f.root, "ledger.ndjson");
    writeFileSync(ledgerPath, "");
    const escalations: string[] = [];
    const logs: Log[] = [];
    const order: string[] = [];
    const preserveStaged = () => {
      throw new Error("recovery ref write refused");
    };
    await withGh(f, prHead, async () => {
      const effects = effectsFor(f, prHead, logs, order, { preserveStaged, ledgerPath });
      for (let i = 0; i < FIX_CLAIM_DECLINE_BACKSTOP + 2; i++) {
        await runSweep([view(prHead)], {
          arm: () => {},
          close: () => {},
          dispatchFix: effects.dispatchFix,
          escalate: (_pr, reason) => void escalations.push(reason),
          runId: `SWEEP-W1T6362-${i}`,
          readLedger: () => readLedgerLines(ledgerPath),
          ledgerPath,
        });
      }
    });

    const declines = steps(logs, "sweep.fix.checkout_claim_declined");
    assert.equal(declines.length, FIX_CLAIM_DECLINE_BACKSTOP, "every pass below the backstop re-attempts, then the sweep stands down");
    for (const d of declines) {
      assert.equal(d.extra?.owner_recovery_reason, "owner_staged_residue_preserve_failed");
      assert.equal(d.extra?.head_sha, prHead, "the decline names its head, so the backstop counts it");
      assert.deepEqual(d.extra?.staged_paths, [STAGED]);
      assert.match(String(d.extra?.error), /recovery ref write refused/);
    }
    assert.equal(escalations.length, 1, "escalated exactly once, not declined silently on every pass");
    for (const named of [`#${PR}`, realpathOf(f.ownerPath), "owner_staged_residue_preserve_failed", STAGED]) {
      assert.ok(escalations[0].includes(named), `the escalation names ${named}: ${escalations[0]}`);
    }
    assert.equal(order.includes("reset"), false, "an unpreserved residue is never reset");
    assert.equal(steps(logs, "sweep.fix.owner_residue_preserved").length, 0);
    assert.equal(steps(logs, "fix.dispatch").length, 0);
    assert.equal(status(f.ownerPath), before, "the owner is untouched");
    assert.equal(registeredFixWorktreeOwner(f.repoDir, `refs/heads/${f.branch}`), realpathOf(f.ownerPath));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("W1-T6434: a prior-partial-work read that throws is logged by name and the round still dispatches", async () => {
  const f = fixture("1791480000004");
  try {
    const prHead = f.ownerSha;
    const logs: Log[] = [];
    const order: string[] = [];
    const readPreservedOwnerPatchImpl = () => {
      throw Object.assign(new Error("EACCES: permission denied, open 'ledger.ndjson'"), { code: "EACCES" });
    };
    await withGh(f, prHead, async () =>
      effectsFor(f, prHead, logs, order, { readPreservedOwnerPatchImpl }).dispatchFix(
        view(prHead) as never,
        { unmetCriteria: [], ciFailures: [{ name: "ci", logTail: "red" }] } as never,
      ),
    );
    const unreadable = steps(logs, "sweep.fix.prior_partial_work_unreadable");
    assert.equal(unreadable.length, 1, "the failed read is named once");
    assert.equal(unreadable[0].extra?.pr_number, PR);
    assert.equal(unreadable[0].extra?.head_sha, prHead);
    assert.match(String(unreadable[0].extra?.reason), /EACCES/, "the reason carries the read's own error");
    assert.equal(steps(logs, "fix.dispatch").length, 1, "the round dispatches without prior partial work");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
