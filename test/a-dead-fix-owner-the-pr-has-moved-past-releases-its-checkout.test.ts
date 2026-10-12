/**
 * W1-T5974. A fix worker killed by a daemon restart left a staged-only edit in its sweep worktree
 * at the PR's OLD head (fleet #9471: owner at 45736389, PR moved by update_branch to dae02e24).
 * W1-T5918's residue reader refused every staged-only residue, and the sweep returned without a
 * head-stamped decline, so every later fix round was refused against that dead worktree and nothing
 * escalated. A staged-only residue on a head the PR has moved past is now preserved from the index
 * into a recovery ref, reset, removed and reclaimed in one pass. (W1-T6362 extended the same
 * preserve-and-reclaim to a dead owner on the PR's CURRENT head, which this task still refused; that
 * case and its preserve-failure escalation are pinned in
 * test/a-dead-fix-owners-staged-work-is-preserved-and-its-checkout-reclaimed.test.ts.) Every
 * fixture is a REAL git repository.
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
import { DEFAULT_SWEEP_POLICY, type OpenPrView } from "../src/lib/sweep.js";
import { ghShim } from "./helpers/gh-shim.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { WorkerResult } from "../src/lib/worker.js";

const TASK = "W1-T500";
const PR = 9471;
const STAGED = "staged.test.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const sha = (repo: string, ref: string): string => git(repo, "rev-parse", ref).trim();

interface Fixture {
  root: string;
  repoDir: string;
  worktreesRoot: string;
  ownerPath: string;
  branch: string;
  ownerSha: string;
}

/** A bare upstream, the sweep's clone, and a pushed run branch checked out in a managed
 *  `sweep-<task>-<epoch>` owner holding a staged-only edit (index differs, working tree == HEAD). */
function fixture(epoch: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1t5974-"));
  const upstream = join(root, "upstream.git");
  git(root, "init", "--quiet", "--bare", "--initial-branch", "main", upstream);
  const repoDir = join(root, "repos", "scratch-fbcs-repo");
  mkdirSync(join(root, "repos"), { recursive: true });
  git(root, "clone", "--quiet", upstream, repoDir);
  git(repoDir, "config", "user.email", "probe@example.invalid");
  git(repoDir, "config", "user.name", "probe");
  git(repoDir, "checkout", "--quiet", "-b", "main");
  writeFileSync(join(repoDir, STAGED), "base\n");
  git(repoDir, "add", "-A");
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

/** The sweep's update_branch: the PR head moves PAST the owner's HEAD, the owner never moves. */
function movePrPast(f: Fixture): string {
  const tree = sha(f.repoDir, `${f.ownerSha}^{tree}`);
  const next = execFileSync("git", ["-C", f.repoDir, "commit-tree", tree, "-p", f.ownerSha, "-m", "Merge main"], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "p", GIT_AUTHOR_EMAIL: "p@x.invalid", GIT_COMMITTER_NAME: "p", GIT_COMMITTER_EMAIL: "p@x.invalid" },
  }).trim();
  git(f.repoDir, "push", "--quiet", "origin", `${next}:refs/heads/${f.branch}`);
  git(f.repoDir, "fetch", "--quiet", "origin");
  return next;
}

const PLAN: Plan = (() => {
  const tasks = [
    { id: TASK, title: TASK, risk: "low", acceptance: [], verify: "auto", files: [], status: "queued" } as unknown as Task,
  ];
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
})();

const WORKER = {
  sessionId: "W1-T5974-PROBE",
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

/** The real sweep effects over the real owner; only the capture's remote head and censuses are pinned. */
function effectsFor(f: Fixture, head: string, logs: Log[], order: string[], ledgerPath?: string) {
  return buildSweepEffects({
    resolveTaskContractAtHeadImpl: () => ({ criteria: [] }),
    owner: "acme",
    repo: "scratch-fbcs-repo",
    config: { root: f.root } as never,
    ledgerPath: join(f.root, "effects-ledger.ndjson"),
    runId: "SWEEP-W1T5974",
    plan: PLAN,
    log: (step, extra) => {
      logs.push({ step, extra });
      if (ledgerPath) appendFileSync(ledgerPath, `${JSON.stringify({ ts: new Date().toISOString(), step, ...extra })}\n`);
    },
    policy: DEFAULT_SWEEP_POLICY,
    spawnImpl: (async () => WORKER) as never,
    registeredWorktreeOwnerImpl: (repoDir: string, branchRef: string) => registeredFixWorktreeOwner(repoDir, branchRef),
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
          { readClaim: () => "clear", processCensus: () => ({ state: "clear", scanned: 1 }) },
        ),
      preserveTrackedDirty: (repoDir: string, ownerPath: string, branch: string, localSha: string) => {
        order.push("residue");
        return preserveOrDiscardFixOwnerResidue(repoDir, ownerPath, branch, localSha);
      },
      preserveStagedResidue: (repoDir: string, ownerPath: string, branch: string, localSha: string) => {
        order.push("preserve-staged");
        return preserveStagedFixOwnerResidue(repoDir, ownerPath, branch, localSha);
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
    { kind: "w1t5974" },
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

test("a dead fix owner whose staged-only residue sits on a head the PR has moved past is preserved and reclaimed so the fix round proceeds", async () => {
  const f = fixture("1791263072316");
  try {
    const prHead = movePrPast(f);
    assert.notEqual(prHead, f.ownerSha, "the #9471 shape: the PR head moved past the dead owner");
    assert.equal(git(f.ownerPath, "diff", "--binary", f.ownerSha), "", "the working tree equals HEAD");
    const stagedTree = git(f.ownerPath, "write-tree").trim();
    const logs: Log[] = [];
    const order: string[] = [];
    const outcome = await withGh(f, prHead, async () =>
      effectsFor(f, prHead, logs, order).dispatchFix(view(prHead) as never, { unmetCriteria: [], ciFailures: [{ name: "ci", logTail: "red" }] } as never),
    );
    assert.equal(typeof outcome === "object" && outcome !== null && "claimDeclined" in outcome, false, "the claim is not declined");
    assert.deepEqual(steps(logs, "sweep.fix.checkout_claim_declined"), [], "never owner_dirty_staged_only_refused");
    assert.deepEqual(order, ["residue", "preserve-staged", "reset", "remove"]);

    const preserved = steps(logs, "sweep.fix.checkout_owner_dirty_preserved");
    assert.equal(preserved.length, 1);
    assert.equal(preserved[0].extra?.staged_only, true);
    assert.deepEqual(preserved[0].extra?.staged_paths, [STAGED]);
    assert.equal(preserved[0].extra?.local_sha_prefix, f.ownerSha.slice(0, 12));
    assert.equal(preserved[0].extra?.remote_sha_prefix, prHead.slice(0, 12));
    const ref = String(preserved[0].extra?.recovery_ref);
    assert.match(ref, new RegExp(`^refs/rmd-recovery/fix-dirty/${f.branch}/${f.ownerSha}/`));
    assert.equal(git(f.repoDir, "show", `${ref}:${STAGED}`), "dead worker's staged edit\n", "the staged edit survives in the ref");
    assert.equal(sha(f.repoDir, `${ref}^{tree}`), stagedTree, "the ref holds the owner's exact index tree");
    assert.equal(sha(f.repoDir, `${ref}^`), f.ownerSha);
    assert.equal(steps(logs, "sweep.fix.checkout_owner_residue_discarded").length, 0, "preserved, not discarded");

    const reclaimed = steps(logs, "sweep.fix.checkout_owner_reclaimed");
    assert.equal(reclaimed.length, 1);
    const proof = reclaimed[0].extra?.proof as Record<string, unknown>;
    assert.equal(proof.recovery_ref, ref);
    assert.equal(proof.residue_discarded, false);
    assert.equal(registeredFixWorktreeOwner(f.repoDir, `refs/heads/${f.branch}`), undefined, "the dead worktree is released");
    assert.equal(steps(logs, "fix.dispatch").length, 1, "the same pass dispatches exactly one repair worker");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
