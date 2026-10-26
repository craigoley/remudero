// W1-T7998. LIVE 2026-10-17 on #12582 (W1-T9043): from 16:17Z every fix claim was declined
// registered_worktree_owner / dirty_worktree. The owner was round 1's own worktree, its HEAD the PR's
// head, but its index predated the worker's commit: the committed file read as a staged delete plus an
// untracked copy whose bytes equal HEAD's. The untracked_dirty arm admitted recovery only when
// localSha !== remoteSha, so a dead, idle owner at the CURRENT head was kept forever (also #10829).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  buildSweepEffects, captureRegisteredFixOwnerSnapshot, clearStaleDirtyFixOwner,
  decideRegisteredFixOwnerRecovery, preserveStaleDirtyFixOwner, registeredFixWorktreeOwner,
  removeAbandonedFixWorktreeOwner,
  preserveOrDiscardFixOwnerResidue, preserveStagedFixOwnerResidue, resetTrackedDirtyFixOwner,
  type BuildSweepEffectsDeps, type CaptureRegisteredFixOwnerDeps, type RegisteredFixOwnerSnapshot,
} from "#src/run-task.js";
import {
  DEFAULT_SWEEP_POLICY, FIX_CLAIM_DECLINE_BACKSTOP, fixDispatchHoldAtHead, registeredFixOwnerIdleBoundMs,
  runSweep, type OpenPrView, type SweepDeps,
} from "#test/helpers/sweep-test.js";
import type { Plan, Task } from "#src/lib/plan.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { readLedgerLines } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const TASK = "W1-T9043";
const PR = 12582;
const BRANCH = `run-${TASK}-1792250550466`;
const FILE = "test/an-escalated-machine-filing-is-resurfaced.test.ts";
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

function history(span: number) {
  const end = Date.now() - 10_000;
  return [{ step: "fix.done", ts: new Date(end).toISOString(), branch_claim_run_id: `sweep:fix-claim:${PR}:${end - span}` }];
}

/** The #12582 shape: the owner's HEAD IS the PR head, and its stale index reads the committed file as a
 *  staged delete beside an untracked copy of the same bytes. */
function fixture() {
  const upstream = gitRepo({ bare: true });
  const repo = gitRepo({ kind: "current-head-dirty-owner" });
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}current-head-owner-`));
  mkdirSync(join(root, "repos"));
  symlinkSync(repo.dir, join(root, "repos", "scratch-fbcs-repo"), "dir");
  repo.addRemote("origin", upstream.dir);
  writeFileSync(join(repo.dir, "seed.txt"), "seed\n");
  repo.git("add", ".");
  repo.git("commit", "-m", "chore: seed owner");
  const baseSha = repo.git("rev-parse", "HEAD");
  const worktreesRoot = join(root, "worktrees");
  mkdirSync(worktreesRoot);
  const ownerPath = join(worktreesRoot, `sweep-${TASK}-1792250550466`);
  const owner = repo.addWorktree(ownerPath, BRANCH);
  mkdirSync(join(ownerPath, "test"));
  writeFileSync(join(ownerPath, FILE), "the worker's committed test\n");
  owner.git("add", FILE);
  owner.git("commit", "-m", "test: the round's own commit");
  const head = git(ownerPath, "rev-parse", "HEAD");
  repo.git("push", "origin", `${BRANCH}:refs/heads/${BRANCH}`);
  owner.git("rm", "--cached", "-q", FILE);
  utimesSync(ownerPath, new Date(Date.now() - 100_000), new Date(Date.now() - 100_000));
  return {
    repo, root, ownerPath, worktreesRoot, head, baseSha,
    cleanup() { rmSync(root, { recursive: true, force: true }); repo.cleanup(); upstream.cleanup(); },
  };
}
type Fixture = ReturnType<typeof fixture>;

const deadOwner: CaptureRegisteredFixOwnerDeps = { readClaim: () => "clear", processCensus: () => ({ state: "clear", scanned: 1 }) };

function capture(f: Fixture, deps: CaptureRegisteredFixOwnerDeps = {}): RegisteredFixOwnerSnapshot {
  return captureRegisteredFixOwnerSnapshot({
    repoDir: f.repo.dir, worktreesRoot: f.worktreesRoot, ownerPath: f.ownerPath,
    taskId: TASK, branch: BRANCH, expectedRemoteSha: f.head, observedRemoteSha: f.head,
    inflightDir: join(f.root, "inflight"), claimKey: "owner", idleBoundMs: 1_000,
  }, { ...deadOwner, ...deps });
}

type Log = { step: string; extra?: Record<string, unknown> };
function effectsFor(f: Fixture, opts: { rounds?: ReturnType<typeof history>; captureDeps?: CaptureRegisteredFixOwnerDeps; wallClockMs?: number;
  preserveTracked?: (...args: any[]) => unknown; preserveStaged?: (...args: any[]) => unknown; preserveStale?: (...args: any[]) => unknown } = {}) {
  const logs: Log[] = [];
  const order: string[] = [];
  const ledgerPath = join(f.root, "ledger.ndjson");
  writeFileSync(ledgerPath, (opts.rounds ?? history(1_000)).map(row => JSON.stringify(row)).join("\n") + "\n");
  const task = { id: TASK, title: TASK, risk: "low", acceptance: [], verify: "auto", files: [], status: "queued" } as unknown as Task;
  const effects = buildSweepEffects({
    owner: "acme", repo: "scratch-fbcs-repo",
    config: { root: f.root } as never, ledgerPath, runId: "SWEEP-W1T7998",
    plan: { tasks: [task], byId: new Map([[TASK, task]]) } as Plan,
    resolveTaskContractAtHeadImpl: () => ({ criteria: [] }), policy: DEFAULT_SWEEP_POLICY,
    ...(opts.wallClockMs === undefined ? {} : { spawnWallClockBoundMsOverride: opts.wallClockMs }),
    log: (step, extra) => { logs.push({ step, extra }); if (step.endsWith("stale_dirty_preserved")) order.push("receipt"); },
    spawnImpl: (async () => ({ sessionId: "probe", costUsd: 0, text: "REPORT\nprobe", blocks: [], stderr: "", subtype: "success", isError: false, apiError: false, verdict: "success", tokens: {}, compactionEvents: [], childEnvKeys: [] } as unknown as WorkerResult)) as never,
    registeredWorktreeOwnerImpl: registeredFixWorktreeOwner,
    registeredOwnerRecovery: {
      preserveTrackedDirty: opts.preserveTracked ?? preserveOrDiscardFixOwnerResidue,
      preserveStagedResidue: opts.preserveStaged ?? preserveStagedFixOwnerResidue,
      resetTrackedDirty: (_repoDir: string, ownerPath: string, _branch: string, localSha: string) => {
        order.push("reset");
        resetTrackedDirtyFixOwner(ownerPath, localSha);
      },
      capture: (args: Parameters<typeof captureRegisteredFixOwnerSnapshot>[0]) =>
        captureRegisteredFixOwnerSnapshot(args, { ...deadOwner, ...opts.captureDeps }),
      preserveStaleDirty: (root: string, repoDir: string, ownerPath: string, branch: string, localSha: string) => {
        order.push("save");
        return (opts.preserveStale ?? preserveStaleDirtyFixOwner)(root, repoDir, ownerPath, branch, localSha);
      },
      clearStaleDirty: (ownerPath: string, localSha: string) => { order.push("clear"); clearStaleDirtyFixOwner(ownerPath, localSha); },
      remove: (repoDir: string, ownerPath: string) => {
        order.push("remove");
        assert.equal(git(ownerPath, "status", "--porcelain=v1"), "");
        removeAbandonedFixWorktreeOwner(repoDir, ownerPath);
      },
    },
  } as BuildSweepEffectsDeps);
  return { effects, logs, order };
}

function prView(f: Fixture): OpenPrView {
  return {
    prNumber: PR, prUrl: `https://github.com/acme/scratch-fbcs-repo/pull/${PR}`, headSha: f.head, headRefName: BRANCH,
    taskId: TASK, reviewState: "failure", checksState: "green", unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: new Date().toISOString(),
  } as unknown as OpenPrView;
}

async function dispatch(f: Fixture, built: ReturnType<typeof effectsFor>) {
  const shim = ghShim([
    { when: `commits/${f.head}/check-runs`, stdout: JSON.stringify({ check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] }) },
    { when: `commits/${f.head}/status`, stdout: JSON.stringify({ state: "success", statuses: [] }) },
    { when: "headRefName", stdout: JSON.stringify({ headRefName: BRANCH, headRefOid: f.head, body: "" }) },
    { when: `pulls/${PR}`, stdout: JSON.stringify({ state: "open", merged: false, head: { sha: f.head, ref: BRANCH }, base: { sha: f.baseSha } }) },
    { when: "", stdout: "{}" },
  ], { kind: "current-head-dirty-owner" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath}`;
  try {
    return await built.effects.dispatchFix(prView(f) as never, { unmetCriteria: [], ciFailures: [{ name: "ci", logTail: "red" }] } as never);
  } finally {
    process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
  }
}

function keptDeclines(f: Fixture, extra: Record<string, unknown> = { owner_recovery_decision: "keep" }) {
  return Array.from({ length: FIX_CLAIM_DECLINE_BACKSTOP }, () => ({
    step: "sweep.fix.checkout_claim_declined", task_id: TASK, reason: "registered_worktree_owner",
    owner_recovery_reason: "dirty_worktree", pr_number: PR, head_sha: f.head, branch: BRANCH,
    worktree_path: realpathSync(f.ownerPath), ...extra,
  }));
}

test("W1-T7998: a dead dirty owner at the current head is preserved and reclaimed", async () => {
  const f = fixture();
  try {
    assert.equal(git(f.ownerPath, "hash-object", FILE), git(f.ownerPath, "rev-parse", `HEAD:${FILE}`), "the untracked copy is HEAD's own bytes");
    const snapshot = capture(f);
    assert.equal(snapshot.treeState, "untracked_dirty");
    assert.equal(snapshot.localSha, f.head);
    assert.equal(snapshot.remoteSha, f.head, "the owner sits AT the PR's current head");
    assert.equal(snapshot.historyState, "contained");
    assert.deepEqual(decideRegisteredFixOwnerRecovery(snapshot), { kind: "preserve-stale-dirty" });

    const built = effectsFor(f);
    await dispatch(f, built);
    assert.deepEqual(built.order, ["save", "receipt", "clear", "remove"]);
    assert.equal(built.logs.filter(l => l.step === "sweep.fix.checkout_claim_declined").length, 0);
    assert.equal(built.logs.filter(l => l.step === "sweep.fix.dirty_recovery_untracked_refused").length, 0);
    assert.equal(built.logs.filter(l => l.step === "fix.dispatch").length, 1);
    assert.equal(registeredFixWorktreeOwner(f.repo.dir, `refs/heads/${BRANCH}`), undefined);
    const row = built.logs.find(l => l.step === "sweep.fix.checkout_owner_stale_dirty_preserved")!.extra!;
    assert.equal(row.at_current_head, true);
    assert.equal(row.head_sha, f.head);
    const saved = String(row.preserved_path);
    assert.match(readFileSync(join(saved, "index.patch"), "utf8"), /deleted file mode/);
    assert.match(readFileSync(join(saved, "untracked.patch"), "utf8"), /the worker's committed test/);
    assert.equal(readFileSync(join(saved, "head.ref"), "utf8").trim(), `refs/rmd-recovery/fix/${BRANCH}/${f.head}`);
  } finally { f.cleanup(); }
});

test("W1-T7998: a live or young dirty owner at the current head is still kept", async () => {
  const f = fixture();
  try {
    const snapshot = capture(f);
    for (const changes of [
      { claimState: "occupied" }, { claimState: "unknown" }, { processState: "occupied" }, { processState: "unknown" },
      { ageMs: 1_000 }, { ageMs: 999 }, { ageMs: null }, { idleBoundMs: null },
    ] as Partial<RegisteredFixOwnerSnapshot>[]) {
      assert.deepEqual(decideRegisteredFixOwnerRecovery({ ...snapshot, ...changes }), { kind: "keep", reason: "dirty_worktree" }, JSON.stringify(changes));
    }
    assert.equal(capture(f, { readClaim: () => "occupied" }).claimState, "occupied");
    assert.equal(capture(f, { processCensus: () => ({ state: "occupied", scanned: 1, pid: 42 }) }).processState, "occupied");

    const live = effectsFor(f, { captureDeps: { readClaim: () => "occupied" } });
    assert.deepEqual(await dispatch(f, live), { claimDeclined: true, ownerRecoveryReason: "dirty_worktree" });
    assert.deepEqual(live.order, []);
    const declined = live.logs.find(l => l.step === "sweep.fix.checkout_claim_declined")!.extra!;
    assert.equal(declined.owner_recovery_decision, "keep");
    assert.ok(existsSync(join(f.ownerPath, FILE)), "a live owner's tree is untouched");
    assert.ok(registeredFixWorktreeOwner(f.repo.dir, `refs/heads/${BRANCH}`));
  } finally { f.cleanup(); }
});

test("W1-T7998: no fix-round history still yields a finite idle bound", async () => {
  assert.equal(registeredFixOwnerIdleBoundMs([], 3_600_000), 3_600_000);
  assert.equal(registeredFixOwnerIdleBoundMs(history(2_000), 3_600_000), 2_000, "observed rounds win over the fallback");
  for (const fallback of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(registeredFixOwnerIdleBoundMs([], fallback), null, String(fallback));
  }
  const f = fixture();
  try {
    const young = effectsFor(f, { rounds: [], wallClockMs: 1_000_000 });
    assert.deepEqual(await dispatch(f, young), { claimDeclined: true, ownerRecoveryReason: "dirty_worktree" },
      "an owner younger than the fix worker's wall-clock budget may still be live");
    const dead = effectsFor(f, { rounds: [], wallClockMs: 1_000 });
    await dispatch(f, dead);
    assert.deepEqual(dead.order, ["save", "receipt", "clear", "remove"], "past the worker's own budget, no history is no reason to keep");
    assert.equal(registeredFixWorktreeOwner(f.repo.dir, `refs/heads/${BRANCH}`), undefined);
  } finally { f.cleanup(); }
});

test("W1-T7998: a backstop hold re-asks the owner decision and lifts when it is reclaimable", async () => {
  const f = fixture();
  try {
    const pr = prView(f);
    const lines = keptDeclines(f);
    assert.ok(fixDispatchHoldAtHead(pr, lines), "control: counting declines alone still holds");
    const { effects } = effectsFor(f);
    assert.equal(effects.fixOwnerReclaimableAtHold!(pr, lines[0]!), true);
    assert.equal(fixDispatchHoldAtHead(pr, lines, existsSync, effects.fixOwnerReclaimableAtHold), undefined);

    const live = effectsFor(f, { captureDeps: { processCensus: () => ({ state: "occupied", scanned: 1, pid: 7 }) } }).effects;
    assert.equal(live.fixOwnerReclaimableAtHold!(pr, lines[0]!), false);
    assert.ok(fixDispatchHoldAtHead(pr, lines, existsSync, live.fixOwnerReclaimableAtHold), "a decision that still keeps holds");
    const broken = effectsFor(f, { captureDeps: { processCensus: () => { throw new Error("proc unreadable"); } } }).effects;
    assert.equal(broken.fixOwnerReclaimableAtHold!(pr, lines[0]!), false, "an unreadable owner keeps today's hold");
    assert.equal(effects.fixOwnerReclaimableAtHold!(pr, { ...lines[0]!, branch: undefined }), false);
    let asked = 0;
    const spy = () => { asked++; return true; };
    const failedRecovery = keptDeclines(f, { owner_recovery_reason: "owner_untracked_preserve_failed" });
    assert.ok(fixDispatchHoldAtHead(pr, failedRecovery, existsSync, spy), "a failed recovery is not re-asked; it escalates once");
    assert.equal(asked, 0);

    const pass = async (reclaimable: SweepDeps["fixOwnerReclaimableAtHold"]) => {
      const ledgerPath = join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}held-owner-`)), "ledger.ndjson");
      let dispatched = 0;
      const escalations: string[] = [];
      await runSweep([{ ...pr, reviewState: "success", autoMergeArmed: false, mergeState: "dirty",
        mergeConflict: { files: [{ path: "src/lib/sweep.ts", oursDeleted: 1, theirsDeleted: 1 }], oursLog: "a ours", theirsLog: "b theirs" } }], {
        arm: () => {}, close: () => {}, dispatchFix: () => { dispatched++; },
        escalate: (_pr, reason) => { escalations.push(reason); },
        fixOwnerReclaimableAtHold: reclaimable, runId: "SWEEP-12582", readLedger: () => [...lines, ...readLedgerLines(ledgerPath)],
        policy: { mergeConflictAdmissionEnabled: true }, ledgerPath,
      } as SweepDeps);
      return { dispatched, escalations };
    };
    const held = await pass(live.fixOwnerReclaimableAtHold);
    assert.equal(held.dispatched, 0);
    assert.ok(held.escalations.some(r => /FIX_CLAIM_DECLINE_BACKSTOP/.test(r)), "the kept owner's hold escalates exactly as today");
    const lifted = await pass(effects.fixOwnerReclaimableAtHold);
    assert.equal(lifted.dispatched, 1, "the claim proceeds in the pass the owner became reclaimable");
    assert.deepEqual(lifted.escalations, []);
  } finally { f.cleanup(); }
});

function indexedIgnoredOwner(f: Fixture) {
  git(f.ownerPath, "add", "--", FILE);
  writeFileSync(join(f.ownerPath, ".gitignore"), "coverage/\n");
  mkdirSync(join(f.ownerPath, "coverage"));
  const path = "coverage/indexed.txt";
  writeFileSync(join(f.ownerPath, path), "unpublished indexed bytes\n");
  git(f.ownerPath, "add", ".gitignore");
  git(f.ownerPath, "add", "--force", "--", path);
  return path;
}

test("a verified preservation capsule lifts only the failed tracked-owner backstop", () => {
  const f = fixture();
  try {
    const path = indexedIgnoredOwner(f);
    const pr = prView(f), declines = keptDeclines(f, { owner_recovery_reason: "owner_dirty_recovery_preserve_failed" });
    assert.ok(fixDispatchHoldAtHead(pr, declines), "three failed claims still hold without a fresh capsule");
    const indexPath = git(f.ownerPath, "rev-parse", "--path-format=absolute", "--git-path", "index");
    const index = readFileSync(indexPath), status = git(f.ownerPath, "status", "--porcelain=v1");
    const built = effectsFor(f);
    assert.equal(fixDispatchHoldAtHead(pr, declines, existsSync, built.effects.fixOwnerReclaimableAtHold), undefined);
    const refs = git(f.repo.dir, "for-each-ref", "--format=%(refname)", "refs/rmd-recovery/fix-dirty").split("\n");
    assert.equal(refs.length, 1);
    assert.equal(git(f.repo.dir, "show", `${refs[0]}:${path}`), "unpublished indexed bytes");
    assert.equal(git(f.repo.dir, "rev-parse", `${refs[0]}^1`), f.head);
    assert.deepEqual(readFileSync(indexPath), index);
    assert.equal(git(f.ownerPath, "status", "--porcelain=v1"), status);
    assert.deepEqual(built.order, [], "revalidation does not clear or remove the owner");
    assert.equal(registeredFixWorktreeOwner(f.repo.dir, `refs/heads/${BRANCH}`), realpathSync(f.ownerPath));
    assert.equal(built.logs.filter(row => row.step === "fix.dispatch").length, 0);
  } finally { f.cleanup(); }
});

test("tracked-owner revalidation retains live uncertain and unverified preservation holds", () => {
  const variants = [
    { captureDeps: { processCensus: () => ({ state: "occupied", scanned: 1, pid: 7 }) } },
    { captureDeps: { processCensus: () => { throw new Error("process ownership unreadable"); } } },
    { preserveTracked: () => { throw new Error("tree mismatch"); } },
    { preserveTracked: () => undefined },
    { preserveTracked: () => "not-a-verified-recovery-ref" },
    { preserveTracked: () => ({ refusal: "owner_dirty_staged_only_refused" }) },
  ] as Parameters<typeof effectsFor>[1][];
  for (const options of variants) {
    const f = fixture();
    try {
      indexedIgnoredOwner(f);
      const pr = prView(f), declines = keptDeclines(f, { owner_recovery_reason: "owner_dirty_recovery_preserve_failed" });
      const built = effectsFor(f, options), status = git(f.ownerPath, "status", "--porcelain=v1");
      assert.ok(fixDispatchHoldAtHead(pr, declines, existsSync, built.effects.fixOwnerReclaimableAtHold));
      assert.equal(git(f.ownerPath, "status", "--porcelain=v1"), status);
      assert.deepEqual(built.order, []);
      assert.equal(git(f.repo.dir, "for-each-ref", "--format=%(refname)", "refs/rmd-recovery/fix-dirty"), "");
    } finally { f.cleanup(); }
  }
});

/** A staged-only residue at the PR's current head: the index holds bytes the working tree reverted. */
function stagedOnlyOwner(f: Fixture) {
  git(f.ownerPath, "add", "--", FILE);
  writeFileSync(join(f.ownerPath, FILE), "staged residue bytes\n");
  git(f.ownerPath, "add", "--", FILE);
  writeFileSync(join(f.ownerPath, FILE), "the worker's committed test\n");
}

function ownerState(f: Fixture) {
  const indexPath = git(f.ownerPath, "rev-parse", "--path-format=absolute", "--git-path", "index");
  return { indexPath, index: readFileSync(indexPath), status: git(f.ownerPath, "status", "--porcelain=v1") };
}

function assertOwnerUntouched(f: Fixture, built: ReturnType<typeof effectsFor>, before: ReturnType<typeof ownerState>) {
  assert.deepEqual(readFileSync(before.indexPath), before.index);
  assert.equal(git(f.ownerPath, "status", "--porcelain=v1"), before.status);
  for (const effect of ["clear", "reset", "remove"]) assert.ok(!built.order.includes(effect), `revalidation never runs ${effect}`);
  assert.equal(registeredFixWorktreeOwner(f.repo.dir, `refs/heads/${BRANCH}`), realpathSync(f.ownerPath));
  assert.equal(built.logs.filter(row => row.step === "fix.dispatch").length, 0);
}

function assertStalePreserved(f: Fixture, saved: string) {
  assert.equal(dirname(saved), join(f.root, "recovery", "fix-owner", BRANCH));
  assert.match(readFileSync(join(saved, "index.patch"), "utf8"), /deleted file mode/);
  assert.match(readFileSync(join(saved, "untracked.patch"), "utf8"), /the worker's committed test/);
  assert.equal(readFileSync(join(saved, "untracked.paths"), "utf8"), `${FILE}\0`);
  assert.equal(readFileSync(join(saved, "head.ref"), "utf8").trim(), `refs/rmd-recovery/fix/${BRANCH}/${f.head}`);
  assert.equal(git(f.repo.dir, "rev-parse", `refs/rmd-recovery/fix/${BRANCH}/${f.head}`), f.head);
}

test("a verified stale-dirty preservation lifts its failed-owner backstop", () => {
  const f = fixture();
  try {
    const pr = prView(f), declines = keptDeclines(f, { owner_recovery_reason: "owner_stale_dirty_preserve_failed" });
    assert.ok(fixDispatchHoldAtHead(pr, declines), "three failed preserves still hold without a fresh preservation");
    const before = ownerState(f);
    const built = effectsFor(f);
    assert.equal(fixDispatchHoldAtHead(pr, declines, existsSync, built.effects.fixOwnerReclaimableAtHold), undefined);
    assert.deepEqual(built.order, ["save", "receipt"]);
    assertOwnerUntouched(f, built, before);
    const row = built.logs.find(l => l.step === "sweep.fix.checkout_owner_stale_dirty_preserved")!.extra!;
    assert.equal(row.from_backstop_revalidation, true);
    assert.equal(row.head_sha, f.head);
    assertStalePreserved(f, String(row.preserved_path));
  } finally { f.cleanup(); }
});

test("a verified staged-residue preservation lifts its failed-owner backstop", () => {
  const f = fixture();
  try {
    stagedOnlyOwner(f);
    const residue = preserveOrDiscardFixOwnerResidue(f.repo.dir, f.ownerPath, BRANCH, f.head);
    assert.equal(typeof residue === "object" ? residue.refusal : residue, "owner_dirty_staged_only_refused",
      "control: the claim path routes this owner to its staged-residue helper");
    assert.deepEqual(decideRegisteredFixOwnerRecovery(capture(f)), { kind: "preserve-tracked-dirty" });
    const pr = prView(f);
    const declines = keptDeclines(f, { owner_recovery_reason: "owner_staged_residue_preserve_failed", staged_paths: [FILE] });
    assert.ok(fixDispatchHoldAtHead(pr, declines), "three failed preserves still hold without a fresh preservation");
    const before = ownerState(f);
    const built = effectsFor(f);
    assert.equal(fixDispatchHoldAtHead(pr, declines, existsSync, built.effects.fixOwnerReclaimableAtHold), undefined);
    assert.deepEqual(built.order, []);
    assertOwnerUntouched(f, built, before);
    const row = built.logs.find(l => l.step === "sweep.fix.owner_residue_preserved")!.extra!;
    assert.equal(row.from_backstop_revalidation, true);
    const ref = String(row.recovery_ref);
    assert.equal(git(f.repo.dir, "for-each-ref", "--format=%(refname)", "refs/rmd-recovery/fix-dirty"), ref);
    assert.equal(git(f.repo.dir, "show", `${ref}:${FILE}`), "staged residue bytes");
    assert.equal(git(f.repo.dir, "rev-parse", `${ref}^1`), f.head);
  } finally { f.cleanup(); }
});

test("a failed stale-dirty reset lifts only once its preservation is re-verified, without resetting", () => {
  const f = fixture();
  try {
    const pr = prView(f), declines = keptDeclines(f, {
      owner_recovery_reason: "owner_stale_dirty_reset_failed", preserved_path: join(f.root, "recovery", "fix-owner", BRANCH, "earlier"),
    });
    assert.ok(fixDispatchHoldAtHead(pr, declines), "three failed resets still hold without a fresh preservation");
    const unproven = effectsFor(f, { preserveStale: () => { throw new Error("saved owner state did not verify: index.patch"); } });
    assert.ok(fixDispatchHoldAtHead(pr, declines, existsSync, unproven.effects.fixOwnerReclaimableAtHold),
      "a preservation that does not re-verify keeps the hold");
    assert.deepEqual(unproven.order, ["save"]);
    const before = ownerState(f);
    const built = effectsFor(f);
    assert.equal(fixDispatchHoldAtHead(pr, declines, existsSync, built.effects.fixOwnerReclaimableAtHold), undefined);
    assert.deepEqual(built.order, ["save", "receipt"], "re-proved, never reset");
    assertOwnerUntouched(f, built, before);
    assert.ok(existsSync(join(f.ownerPath, FILE)), "the untracked copy a reset would clear is still there");
    const row = built.logs.find(l => l.step === "sweep.fix.checkout_owner_stale_dirty_preserved")!.extra!;
    assert.equal(row.from_backstop_revalidation, true);
    assertStalePreserved(f, String(row.preserved_path));
  } finally { f.cleanup(); }
});

test("every failed-owner revalidation keeps the hold on a live owner, an error or an unverified result", () => {
  type Variant = { name: string; staged?: boolean; prOver?: Partial<OpenPrView>; options?: (f: Fixture) => Parameters<typeof effectsFor>[1] };
  const shared: Variant[] = [
    { name: "live process", options: () => ({ captureDeps: { processCensus: () => ({ state: "occupied", scanned: 1, pid: 7 }) } }) },
    { name: "live claim", options: () => ({ captureDeps: { readClaim: () => "occupied" } }) },
    { name: "unreadable process", options: () => ({ captureDeps: { processCensus: () => { throw new Error("process ownership unreadable"); } } }) },
    { name: "another branch", prOver: { headRefName: "run-W1-T9043-1792250550467" } },
    { name: "another task", prOver: { taskId: "W1-T9044" } },
  ];
  const cases: Array<[string, Variant[]]> = [];
  for (const reason of ["owner_stale_dirty_preserve_failed", "owner_stale_dirty_reset_failed"]) {
    cases.push([reason, [...shared,
      { name: "wrong decision", staged: true },
      { name: "throws", options: () => ({ preserveStale: () => { throw new Error("saved owner state did not verify: head.ref"); } }) },
      { name: "no path", options: () => ({ preserveStale: () => undefined }) },
      { name: "empty path", options: () => ({ preserveStale: () => "" }) },
      { name: "foreign path", options: f => ({ preserveStale: () => join(f.root, "elsewhere", BRANCH, `${f.head}-1-abc`) }) },
      { name: "another head", options: f => ({ preserveStale: () => join(f.root, "recovery", "fix-owner", BRANCH, `${f.baseSha}-1-abc`) }) },
    ]]);
  }
  cases.push(["owner_staged_residue_preserve_failed", [...shared.map(v => ({ ...v, staged: true })),
    { name: "wrong decision" },
    { name: "throws", staged: true, options: () => ({ preserveStaged: () => { throw new Error("tree mismatch"); } }) },
    { name: "no ref", staged: true, options: () => ({ preserveStaged: () => undefined }) },
    { name: "refusal", staged: true, options: () => ({ preserveStaged: () => ({ refusal: "owner_dirty_staged_only_refused" }) }) },
    { name: "foreign ref", staged: true, options: f => ({ preserveStaged: () => `refs/rmd-recovery/fix-dirty/other/${f.head}/${f.head}` }) },
    { name: "no tree", staged: true, options: f => ({ preserveStaged: () => `refs/rmd-recovery/fix-dirty/${BRANCH}/${f.head}/not-a-tree` }) },
  ]]);
  let checked = 0;
  for (const [reason, variants] of cases) {
    for (const variant of variants) {
      const f = fixture();
      try {
        if (variant.staged) stagedOnlyOwner(f);
        const pr = { ...prView(f), ...variant.prOver }, declines = keptDeclines(f, { owner_recovery_reason: reason });
        const before = ownerState(f);
        const built = effectsFor(f, variant.options?.(f));
        assert.ok(fixDispatchHoldAtHead(pr, declines, existsSync, built.effects.fixOwnerReclaimableAtHold), `${reason}: ${variant.name}`);
        assertOwnerUntouched(f, built, before);
        assert.deepEqual(built.logs.filter(row => /preserved$/.test(row.step)), [], `${reason}: ${variant.name} logs no receipt`);
        assert.equal(git(f.repo.dir, "for-each-ref", "--format=%(refname)", "refs/rmd-recovery"), "", `${reason}: ${variant.name}`);
        assert.equal(existsSync(join(f.root, "recovery")), false, `${reason}: ${variant.name} saves nothing`);
        checked++;
      } finally { f.cleanup(); }
    }
  }
  assert.equal(checked, 33);
});
