import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildSweepEffects, captureRegisteredFixOwnerSnapshot, clearStaleDirtyFixOwner,
  decideRegisteredFixOwnerRecovery, preserveStaleDirtyFixOwner, registeredFixWorktreeOwner,
  removeAbandonedFixWorktreeOwner,
  type BuildSweepEffectsDeps, type CaptureRegisteredFixOwnerDeps, type RegisteredFixOwnerSnapshot,
} from "../src/run-task.js";
import { DEFAULT_SWEEP_POLICY, registeredFixOwnerIdleBoundMs, type OpenPrView } from "../src/lib/sweep.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { ghShim } from "./helpers/gh-shim.js";
import { gitRepo } from "./helpers/git-repo.js";

const TASK = "W1-T7719";
const PR = 10551;
const BRANCH = `run-${TASK}-1791611477902`;
const FILE = "owner.test.ts";
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });

function history(span: number) {
  const end = Date.now() - 10_000;
  return [{ step: "fix.done", ts: new Date(end).toISOString(), branch_claim_run_id: `sweep:fix-claim:${PR}:${end - span}` }];
}

function fixture() {
  const upstream = gitRepo({ bare: true });
  const repo = gitRepo({ kind: "stale-dirty-owner" });
  const root = mkdtempSync(join(tmpdir(), "rmd-stale-dirty-state-"));
  mkdirSync(join(root, "repos"));
  symlinkSync(repo.dir, join(root, "repos", "scratch-fbcs-repo"), "dir");
  repo.addRemote("origin", upstream.dir);
  writeFileSync(join(repo.dir, FILE), "base\n");
  writeFileSync(join(repo.dir, "tracked.txt"), "base tracked\n");
  repo.git("add", ".");
  repo.git("commit", "-m", "chore: seed owner");
  const localSha = repo.git("rev-parse", "HEAD");
  const worktreesRoot = join(root, "worktrees");
  mkdirSync(worktreesRoot);
  const ownerPath = join(worktreesRoot, `sweep-${TASK}-1791611477902`);
  const owner = repo.addWorktree(ownerPath, BRANCH);
  writeFileSync(join(repo.dir, "new-head.txt"), "upstream moved\n");
  repo.git("add", "new-head.txt");
  repo.git("commit", "-m", "chore: advance head");
  const head = repo.git("rev-parse", "HEAD");
  repo.git("push", "origin", `main:refs/heads/${BRANCH}`);
  owner.git("rm", FILE);
  writeFileSync(join(ownerPath, FILE), "untracked replacement\n");
  writeFileSync(join(ownerPath, "tracked.txt"), "working edit\n");
  writeFileSync(join(ownerPath, "binary.dat"), Buffer.from([0, 255, 10, 128]));
  writeFileSync(join(ownerPath, ".gitattributes"), "*.txt text eol=lf\n");
  writeFileSync(join(ownerPath, "stray[1].txt"), "raw bytes\r\n");
  writeFileSync(join(ownerPath, "executable"), "preserve mode\n");
  chmodSync(join(ownerPath, "executable"), 0o755);
  symlinkSync(FILE, join(ownerPath, "owner-link"));
  utimesSync(ownerPath, new Date(Date.now() - 100_000), new Date(Date.now() - 100_000));
  return { repo, upstream, root, ownerPath, worktreesRoot, localSha, head, cleanup() { rmSync(root, { recursive: true, force: true }); repo.cleanup(); upstream.cleanup(); } };
}
type Fixture = ReturnType<typeof fixture>;

function capture(f: Fixture, deps: CaptureRegisteredFixOwnerDeps = {}): RegisteredFixOwnerSnapshot {
  return captureRegisteredFixOwnerSnapshot({
    repoDir: f.repo.dir, worktreesRoot: f.worktreesRoot, ownerPath: f.ownerPath,
    taskId: TASK, branch: BRANCH, expectedRemoteSha: f.head, observedRemoteSha: f.head,
    inflightDir: join(f.root, "inflight"), claimKey: "owner", idleBoundMs: 1_000,
  }, { readClaim: () => "clear", processCensus: () => ({ state: "clear", scanned: 1 }), ...deps });
}

type Log = { step: string; extra?: Record<string, unknown> };
async function drive(f: Fixture, opts: {
  preserveDeps?: CaptureRegisteredFixOwnerDeps;
  preserve?: () => string;
  clear?: () => void;
  rounds?: ReturnType<typeof history>;
} = {}) {
  const logs: Log[] = [];
  const order: string[] = [];
  const ledgerPath = join(f.root, "ledger.ndjson");
  writeFileSync(ledgerPath, (opts.rounds ?? history(1_000)).map(row => JSON.stringify(row)).join("\n") + "\n");
  const task = { id: TASK, title: TASK, risk: "low", acceptance: [], verify: "auto", files: [], status: "queued" } as unknown as Task;
  const shim = ghShim([
    { when: `commits/${f.head}/check-runs`, stdout: JSON.stringify({ check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] }) },
    { when: `commits/${f.head}/status`, stdout: JSON.stringify({ state: "success", statuses: [] }) },
    { when: "headRefName", stdout: JSON.stringify({ headRefName: BRANCH, headRefOid: f.head, body: "" }) },
    { when: `pulls/${PR}`, stdout: JSON.stringify({ state: "open", merged: false, head: { sha: f.head, ref: BRANCH }, base: { sha: f.localSha } }) },
    { when: "", stdout: "{}" },
  ], { kind: "stale-dirty-owner" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath}`;
  try {
    const effects = buildSweepEffects({
      owner: "acme", repo: "scratch-fbcs-repo",
      config: { root: f.root } as never, ledgerPath, runId: "SWEEP-W1T7719",
      plan: { tasks: [task], byId: new Map([[TASK, task]]) } as Plan,
      resolveTaskContractAtHeadImpl: () => ({ criteria: [] }), policy: DEFAULT_SWEEP_POLICY,
      log: (step, extra) => { logs.push({ step, extra }); if (step.endsWith("stale_dirty_preserved")) order.push("receipt"); },
      spawnImpl: (async () => ({ sessionId: "probe", costUsd: 0, text: "REPORT\nprobe", blocks: [], stderr: "", subtype: "success", isError: false, apiError: false, verdict: "success", tokens: {}, compactionEvents: [], childEnvKeys: [] } as unknown as WorkerResult)) as never,
      registeredWorktreeOwnerImpl: registeredFixWorktreeOwner,
      registeredOwnerRecovery: {
        capture: (args: Parameters<typeof captureRegisteredFixOwnerSnapshot>[0]) => captureRegisteredFixOwnerSnapshot(args,
          { readClaim: () => "clear", processCensus: () => ({ state: "clear", scanned: 1 }) }),
        preserveStaleDirty: (root: string, repoDir: string, ownerPath: string, branch: string, localSha: string) => {
          order.push("save");
          if (opts.preserve) return opts.preserve();
          return preserveStaleDirtyFixOwner(root, repoDir, ownerPath, branch, localSha, opts.preserveDeps);
        },
        clearStaleDirty: (ownerPath: string, localSha: string) => {
          order.push("clear");
          const row = logs.find(l => l.step === "sweep.fix.checkout_owner_stale_dirty_preserved");
          assert.ok(row, "receipt precedes any reset");
          assert.ok(existsSync(join(String(row.extra?.preserved_path), "index.patch")));
          if (opts.clear) opts.clear();
          else clearStaleDirtyFixOwner(ownerPath, localSha);
        },
        remove: (repoDir: string, ownerPath: string) => {
          order.push("remove");
          assert.equal(git(ownerPath, "status", "--porcelain=v1"), "");
          removeAbandonedFixWorktreeOwner(repoDir, ownerPath);
        },
      },
    } as BuildSweepEffectsDeps);
    const outcome = await effects.dispatchFix({
      prNumber: PR, prUrl: `https://github.com/acme/scratch-fbcs-repo/pull/${PR}`, headSha: f.head,
      taskId: TASK, reviewState: "failure", checksState: "green", unmetCriteria: [], priorStrikes: 0,
      lastActivityAt: new Date().toISOString(),
    } as unknown as OpenPrView as never, { unmetCriteria: [], ciFailures: [{ name: "ci", logTail: "red" }] } as never);
    return { logs, order, outcome };
  } finally {
    process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
  }
}

test("W1-T7719: a dead dirty owner on a stale head is preserved and reclaimed", async () => {
  const f = fixture();
  try {
    const canonicalOwnerPath = realpathSync(f.ownerPath);
    const snapshot = capture(f);
    assert.equal(snapshot.treeState, "untracked_dirty");
    assert.equal(snapshot.localSha, f.localSha);
    assert.equal(snapshot.remoteSha, f.head);
    assert.equal(snapshot.claimState, "clear");
    assert.equal(snapshot.processState, "clear");
    assert.deepEqual(decideRegisteredFixOwnerRecovery(snapshot), { kind: "preserve-stale-dirty" });
    const { logs, order } = await drive(f);
    assert.deepEqual(order, ["save", "receipt", "clear", "remove"]);
    assert.equal(logs.filter(l => l.step === "sweep.fix.checkout_claim_declined").length, 0);
    assert.equal(logs.filter(l => l.step === "fix.dispatch").length, 1);
    assert.equal(registeredFixWorktreeOwner(f.repo.dir, `refs/heads/${BRANCH}`), undefined);
    const row = logs.find(l => l.step === "sweep.fix.checkout_owner_stale_dirty_preserved")!.extra!;
    assert.equal(row.pr_number, PR);
    assert.equal(row.task_id, TASK);
    assert.equal(row.branch, BRANCH);
    assert.equal(row.worktree_path, canonicalOwnerPath);
    assert.equal(row.local_sha_prefix, f.localSha.slice(0, 12));
    assert.equal(row.head_sha, f.head);
    assert.ok(String(row.preserved_path).startsWith(join(f.root, "recovery", "fix-owner", BRANCH)));
    assert.ok(existsSync(String(row.preserved_path)), "the saved state survives removal");
  } finally { f.cleanup(); }
});

test("W1-T7719: a dirty owner at the current head is still kept", () => {
  const f = fixture();
  try {
    const snapshot = capture(f);
    assert.deepEqual(decideRegisteredFixOwnerRecovery({ ...snapshot, remoteSha: f.localSha }), { kind: "keep", reason: "dirty_worktree" });
    for (const changes of [
      { idleBoundMs: null }, { ageMs: null }, { ageMs: 1_000 }, { ageMs: 999 },
      { localSha: null }, { remoteSha: null }, { remoteState: "unknown" }, { remoteState: "changed" },
      { historyState: "unknown" },
    ] as Partial<RegisteredFixOwnerSnapshot>[]) {
      assert.deepEqual(decideRegisteredFixOwnerRecovery({ ...snapshot, ...changes }), { kind: "keep", reason: "dirty_worktree" });
    }
  } finally { f.cleanup(); }
});

test("W1-T7719: a dirty owner with a live claim or process is still kept", () => {
  const f = fixture();
  try {
    const snapshot = capture(f);
    for (const changes of [{ claimState: "occupied" }, { claimState: "unknown" }, { processState: "occupied" }, { processState: "unknown" }] as Partial<RegisteredFixOwnerSnapshot>[]) {
      assert.deepEqual(decideRegisteredFixOwnerRecovery({ ...snapshot, ...changes }), { kind: "keep", reason: "dirty_worktree" });
    }
    assert.equal(capture(f, { readClaim: () => "occupied" }).claimState, "occupied");
    assert.equal(capture(f, { processCensus: () => ({ state: "occupied", scanned: 1, pid: 42 }) }).processState, "occupied");
  } finally { f.cleanup(); }
});

test("W1-T7719: the idle bound follows observed fix-round lengths", () => {
  assert.equal(registeredFixOwnerIdleBoundMs(history(1_000)), 1_000);
  assert.equal(registeredFixOwnerIdleBoundMs(history(9_000)), 9_000);
  assert.equal(registeredFixOwnerIdleBoundMs([]), null, "without completed observations, keep the owner");
  assert.equal(registeredFixOwnerIdleBoundMs([
    ...Array.from({ length: 20 }, (_, i) => history((i + 1) * 1_000)[0]!), ...history(100_000),
  ]), 20_000, "nearest-rank p95 follows the population rather than its single longest outlier");
  assert.equal(registeredFixOwnerIdleBoundMs([
    { step: "fix.dispatch", ts: new Date().toISOString(), branch_claim_run_id: "missing" },
    { step: "fix.done", ts: "bad", branch_claim_run_id: "x:fix-claim:1:2" },
    { step: "fix.done", ts: new Date(1).toISOString(), branch_claim_run_id: "x:fix-claim:1:2" },
    { step: "fix.done" }, ...history(2_000),
  ]), 2_000);
});

test("W1-T7719: the owner state is saved and verified before removal", () => {
  const f = fixture();
  try {
    const before = git(f.ownerPath, "status", "--porcelain=v1");
    const saved = preserveStaleDirtyFixOwner(f.root, f.repo.dir, f.ownerPath, BRANCH, f.localSha);
    assert.equal(git(f.ownerPath, "status", "--porcelain=v1"), before, "preservation alone never resets");
    const restored = f.repo.addWorktree(join(f.worktreesRoot, "restore"), "restored", f.localSha);
    restored.git("apply", "--index", join(saved, "index.patch"));
    restored.git("apply", join(saved, "worktree.patch"));
    restored.git("apply", "--whitespace=nowarn", join(saved, "untracked.patch"));
    assert.equal(git(restored.dir, "status", "--porcelain=v1"), before);
    assert.equal(readFileSync(join(restored.dir, FILE), "utf8"), "untracked replacement\n");
    assert.equal(readFileSync(join(restored.dir, "tracked.txt"), "utf8"), "working edit\n");
    assert.deepEqual(readFileSync(join(restored.dir, "binary.dat")), Buffer.from([0, 255, 10, 128]));
    assert.equal(readFileSync(join(restored.dir, "stray[1].txt"), "utf8"), "raw bytes\r\n", "attributes never rewrite preserved untracked bytes");
    assert.equal(statSync(join(restored.dir, "executable")).mode & 0o111, 0o111);
    assert.equal(readlinkSync(join(restored.dir, "owner-link")), FILE);
    assert.ok(existsSync(join(f.root, "recovery", ".rmd-scratch-keep")), "host cleanup keeps the recovery root");
    assert.equal(readFileSync(join(saved, "head.ref"), "utf8").trim(), `refs/rmd-recovery/fix/${BRANCH}/${f.localSha}`);
    assert.throws(() => preserveStaleDirtyFixOwner(f.root, f.repo.dir, f.ownerPath, BRANCH, f.head), /HEAD changed/);
    assert.throws(() => preserveStaleDirtyFixOwner(f.root, f.repo.dir, f.ownerPath, BRANCH, f.localSha, {
      saveRecoveryFile: (path) => writeFileSync(path, ""),
    }), /saved owner state did not verify/);
    assert.equal(git(f.ownerPath, "status", "--porcelain=v1"), before);
  } finally { f.cleanup(); }
});

test("W1-T7719: a failed save or verification declines without clearing the owner", async () => {
  for (const failure of ["write", "verify"] as const) {
    const f = fixture();
    try {
      const before = git(f.ownerPath, "status", "--porcelain=v1");
      const { logs, order, outcome } = await drive(f, { preserveDeps: { saveRecoveryFile: path => {
        if (failure === "write") throw new Error("save refused");
        writeFileSync(path, "");
      } } });
      assert.deepEqual(outcome, { claimDeclined: true, ownerRecoveryReason: "owner_stale_dirty_preserve_failed" });
      assert.deepEqual(order, ["save"]);
      assert.equal(logs.filter(l => l.step === "sweep.fix.checkout_owner_stale_dirty_preserved").length, 0);
      assert.equal(git(f.ownerPath, "status", "--porcelain=v1"), before);
      assert.ok(registeredFixWorktreeOwner(f.repo.dir, `refs/heads/${BRANCH}`));
    } finally { f.cleanup(); }
  }
});

test("W1-T7719: a failed clear retains the saved path and declines by name", async () => {
  const f = fixture();
  try {
    const { logs, order, outcome } = await drive(f, { clear: () => { throw new Error("reset refused"); } });
    assert.deepEqual(outcome, { claimDeclined: true, ownerRecoveryReason: "owner_stale_dirty_reset_failed" });
    assert.deepEqual(order, ["save", "receipt", "clear"]);
    assert.ok(existsSync(String(logs.find(l => l.step.endsWith("stale_dirty_preserved"))!.extra!.preserved_path)));
    assert.ok(registeredFixWorktreeOwner(f.repo.dir, `refs/heads/${BRANCH}`));
  } finally { f.cleanup(); }
});

test("W1-T7719: absent history keeps the stale dirty owner without invoking preservation", async () => {
  const f = fixture();
  try {
    const { order, outcome } = await drive(f, { rounds: [] });
    assert.deepEqual(outcome, { claimDeclined: true, ownerRecoveryReason: "dirty_worktree" });
    assert.deepEqual(order, []);
    assert.ok(registeredFixWorktreeOwner(f.repo.dir, `refs/heads/${BRANCH}`));
  } finally { f.cleanup(); }
});

test("W1-T7719: a missing preserved path never licenses a reset", async () => {
  const f = fixture();
  try {
    const { order, outcome } = await drive(f, { preserve: () => "" });
    assert.deepEqual(outcome, { claimDeclined: true, ownerRecoveryReason: "owner_stale_dirty_preserve_failed" });
    assert.deepEqual(order, ["save"]);
    assert.ok(existsSync(join(f.ownerPath, FILE)));
  } finally { f.cleanup(); }
});

test("W1-T7719: an empty worktree patch is saved and untracked absence refuses preservation", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.ownerPath, "tracked.txt"), "base tracked\n");
    const saved = preserveStaleDirtyFixOwner(f.root, f.repo.dir, f.ownerPath, BRANCH, f.localSha);
    assert.equal(readFileSync(join(saved, "worktree.patch"), "utf8"), "");
    assert.ok(readFileSync(join(saved, "index.patch")).length > 0);
    git(f.ownerPath, "clean", "-fd");
    assert.throws(() => preserveStaleDirtyFixOwner(f.root, f.repo.dir, f.ownerPath, BRANCH, f.localSha), /untracked state is empty/);
  } finally { f.cleanup(); }
});

test("W1-T7719: an unresolved index is kept because a patch cannot preserve its stages", () => {
  const f = fixture();
  try {
    const blob = f.repo.git("rev-parse", `${f.localSha}:tracked.txt`);
    execFileSync("git", ["-C", f.ownerPath, "update-index", "--index-info"], {
      input: `0 ${"0".repeat(40)}\ttracked.txt\n100644 ${blob} 1\ttracked.txt\n100644 ${blob} 2\ttracked.txt\n100644 ${blob} 3\ttracked.txt\n`,
    });
    const before = git(f.ownerPath, "ls-files", "--unmerged");
    assert.throws(() => preserveStaleDirtyFixOwner(f.root, f.repo.dir, f.ownerPath, BRANCH, f.localSha), /unresolved stages/);
    assert.equal(git(f.ownerPath, "ls-files", "--unmerged"), before);
  } finally { f.cleanup(); }
});
