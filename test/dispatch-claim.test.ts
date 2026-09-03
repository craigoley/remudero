import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  decideDispatchClaim,
  decideDispatchClaimRelease,
  dispatchClaimRef,
  gitDispatchClaimReserver,
  releaseDispatchClaim,
  type DispatchClaimOutcome,
  type DispatchClaimReserver,
} from "../src/lib/dispatch-claim.js";
import { dispatchClaimReserverFor, runTask } from "../src/run-task.js";
import { nextRunnable, runnableCandidates, type NextRunnableOpts } from "../src/lib/drain.js";
import { loadPlanFromYaml } from "../src/lib/plan.js";
import { acquireInflightLock, InflightLockError, sweepStaleInflightLocks } from "../src/lib/inflight-lock.js";
import type { Config } from "../src/lib/config.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { GitHub } from "../src/lib/status.js";
import type { SpawnWorkerArgs, WorkerResult, spawnWorker } from "../src/lib/worker.js";

// ── WHAT THIS FILE PROVES (W1-T1268) ─────────────────────────────────────────────────────────
// `isDispatchEligible`'s ten probes (src/lib/drain.ts) all read a PUBLISHED artifact — an open
// PR or a pushed run-<id>-<epoch> branch. Two hosts (or a host and an operator dispatching by
// hand) starting inside the minutes-long window before either publishes anything both read
// nothing and both spend a run — MEASURED 2026-08-23: two W1-T1265 lanes branched 53.776s apart.
// The claim proved here is taken BEFORE any spend (run-task.ts, right after the target repo's
// clone is confirmed to exist, before pruneStaleRuns/worktreeAdd/the inflight lock's own worker
// spawn). Every DECISION is pure and asserted without a git remote; the one I/O seam is asserted
// against a real local bare repo. It mirrors auto-triage.ts's triage claim structurally.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUN_TASK_SRC = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
}
function tmp(p: string): string {
  return mkdtempSync(join(tmpdir(), p));
}

/** An in-memory stand-in for `origin`'s ref store: create-if-absent, exactly what a ref update on
 *  a remote gives, so two "hosts" can be driven against ONE shared remote inside one process. */
function fakeRemote(): { refs: Map<string, string>; calls: string[]; reserverFor: (anchor: string) => DispatchClaimReserver } {
  const refs = new Map<string, string>();
  const calls: string[] = [];
  return {
    refs,
    calls,
    reserverFor: (anchor: string): DispatchClaimReserver => ({
      mintAnchor: () => {
        calls.push("mintAnchor");
        return anchor;
      },
      attempt: (taskId, a) => {
        calls.push(`attempt:${taskId}`);
        const ref = dispatchClaimRef(taskId);
        if (refs.has(ref)) return "taken";
        refs.set(ref, a);
        return "created";
      },
      holder: (taskId) => {
        calls.push(`holder:${taskId}`);
        return refs.get(dispatchClaimRef(taskId));
      },
      drop: (taskId, opts = {}) => {
        calls.push(`drop:${taskId}:${opts.expect ?? "-"}`);
        const ref = dispatchClaimRef(taskId);
        if (opts.expect !== undefined && refs.get(ref) !== opts.expect) return false;
        return refs.delete(ref);
      },
    }),
  };
}

/** A reserver whose every attempt reports the remote unreadable — the fail-closed arm. */
function unreachableReserver(): DispatchClaimReserver {
  return {
    mintAnchor: () => "anchor-unreachable",
    attempt: () => "unreachable" as DispatchClaimOutcome,
    holder: () => undefined,
    drop: () => false,
  };
}

// ── THE PURE DECISIONS — no git, no clock, no remote ──────────────────────────────────────────

test("W1-T1268 PURE: a won claim proceeds; a lost one refuses and NAMES the claim it lost to", () => {
  const won = decideDispatchClaim("created", { taskId: "W1-T9001" });
  assert.equal(won.proceed, true);

  const lost = decideDispatchClaim("taken", { taskId: "W1-T9001", holder: "deadbeef" });
  assert.equal(lost.proceed, false);
  assert.match(lost.reason, /refs\/rmd-dispatch\/W1-T9001/);
  assert.match(lost.reason, /deadbeef/);

  // An anonymous holder (a failed holder READ) must never become a proceed.
  const lostAnon = decideDispatchClaim("taken", { taskId: "W1-T9001" });
  assert.equal(lostAnon.proceed, false);
  assert.doesNotMatch(lostAnon.reason, /held by/);
});

test("W1-T1268 PURE: an unreachable origin REFUSES rather than dispatching optimistically", () => {
  const d = decideDispatchClaim("unreachable", { taskId: "W1-T9002" });
  assert.equal(d.proceed, false, "a failed READ of the world is never read as 'free'");
  assert.match(d.reason, /cannot reach origin/);
});

test("W1-T1268 PURE: release has exactly three arms, and the third refuses rather than guessing", () => {
  const holder = decideDispatchClaimRelease({ heldByThisRun: true, evidenceObserved: false, taskId: "W1-T9003" });
  assert.deepEqual({ arm: holder.arm, release: holder.release }, { arm: "holder", release: true });

  const evidence = decideDispatchClaimRelease({ heldByThisRun: false, evidenceObserved: true, taskId: "W1-T9003" });
  assert.deepEqual({ arm: evidence.arm, release: evidence.release }, { arm: "evidence", release: true });

  const operator = decideDispatchClaimRelease({ heldByThisRun: false, evidenceObserved: false, taskId: "W1-T9003" });
  assert.deepEqual({ arm: operator.arm, release: operator.release }, { arm: "operator", release: false });
  // Cross-host liveness is not decidable, so the honest answer is a person WITH THE COMMAND —
  // a refusal that does not say how to clear the thing it refused is a dead end. "Never expired"
  // is the acceptance's own wording: the operator arm is the ONLY thing that clears a live
  // holder's claim, and it is a name + a command, never a countdown.
  assert.match(operator.reason, /git push origin :refs\/rmd-dispatch\/W1-T9003/);

  // PRECEDENCE: holding beats evidence, so a lane's own completion never takes the wider arm.
  assert.equal(decideDispatchClaimRelease({ heldByThisRun: true, evidenceObserved: true, taskId: "W1-T9003" }).arm, "holder");
});

test("W1-T1268 NO TIMER: the release decision reads no clock — W1-T1067's stranded lock is the precedent", () => {
  const a = decideDispatchClaimRelease({ heldByThisRun: false, evidenceObserved: false, taskId: "W1-T9004" });
  const b = decideDispatchClaimRelease({ heldByThisRun: false, evidenceObserved: false, taskId: "W1-T9004" });
  assert.deepEqual(a, b);

  const src = readFileSync(join(REPO_ROOT, "src", "lib", "dispatch-claim.ts"), "utf8");
  const start = src.indexOf("export function decideDispatchClaimRelease");
  assert.ok(start > 0, "the decision function is present under that exact name");
  const body = src.slice(start, src.indexOf("\n}", start));
  for (const clock of ["Date.now", "new Date", "setTimeout", "expiresAt", "ttl", "TTL", "elapsed"]) {
    assert.ok(!body.includes(clock), `the release decision must not consult ${clock}`);
  }
});

// ── THE ORCHESTRATION — one shared fake remote, two "hosts" ───────────────────────────────────

test("W1-T1268 ACCEPTANCE: a lane that takes the claim proceeds; a second lane on another host is refused BEFORE it spends", () => {
  const remote = fakeRemote();
  let spendCalls = 0;

  function dispatchAttempt(taskId: string, anchor: string): { proceed: boolean } {
    const reserver = remote.reserverFor(anchor);
    const a = reserver.mintAnchor();
    const outcome = reserver.attempt(taskId, a);
    const holder = outcome === "taken" ? reserver.holder(taskId) : undefined;
    const decision = decideDispatchClaim(outcome, { taskId, holder });
    if (decision.proceed) spendCalls++; // stands in for "recon worker spawns"
    return decision;
  }

  const first = dispatchAttempt("W1-T1265", "anchor-hostA");
  assert.equal(first.proceed, true, "the first lane wins and proceeds to spend");
  const second = dispatchAttempt("W1-T1265", "anchor-hostB");
  assert.equal(second.proceed, false, "the second lane refuses — before any spend");
  assert.equal(spendCalls, 1, "only the winner ever reaches the point that would spend");
  assert.equal(remote.refs.get(dispatchClaimRef("W1-T1265")), "anchor-hostA", "the loser never steals the winner's claim");
});

test("W1-T1268 RELEASE ARM 1 (HOLDER): drops only the claim it still holds, never one that became another lane's", () => {
  const remote = fakeRemote();
  const reserver = remote.reserverFor("anchor-A");
  const anchor = reserver.mintAnchor();
  reserver.attempt("W1-T20", anchor);
  remote.calls.length = 0;

  const released = releaseDispatchClaim("W1-T20", reserver, { anchor });
  assert.equal(released.arm, "holder");
  assert.equal(released.dropped, true);
  assert.equal(remote.refs.has(dispatchClaimRef("W1-T20")), false, "the ref is gone");
  assert.deepEqual(remote.calls, ["drop:W1-T20:anchor-A"], "waiting for nothing — exactly one remote operation");

  // AND CONDITIONAL: a stale anchor cannot delete a claim that is now someone else's.
  const other = remote.reserverFor("anchor-NEW");
  other.attempt("W1-T21", other.mintAnchor());
  const staleRelease = releaseDispatchClaim("W1-T21", remote.reserverFor("x"), { anchor: "anchor-OLD" });
  assert.equal(staleRelease.dropped, false, "the conditional delete refuses");
  assert.equal(remote.refs.get(dispatchClaimRef("W1-T21")), "anchor-NEW", "and the live claim survives");
});

test("W1-T1268 RELEASE ARM 2 (EVIDENCE): a claim whose task's work has landed is released by ANY host", () => {
  const remote = fakeRemote();
  const dead = remote.reserverFor("anchor-DEAD");
  dead.attempt("W1-T30", dead.mintAnchor()); // a lane that died holding it

  // A DIFFERENT host, holding no anchor, carries fresh evidence the task is already merged —
  // exactly what `isMerged(task)` (the SAME projection the W1-T319 already-merged guard reads)
  // supplies at the real call site in run-task.ts.
  const released = releaseDispatchClaim("W1-T30", remote.reserverFor("anchor-B"), { evidenceObserved: true });
  assert.equal(released.arm, "evidence");
  assert.equal(released.dropped, true, "the stale claim was dropped by a host that never held it");
  assert.equal(remote.refs.has(dispatchClaimRef("W1-T30")), false);
});

test("W1-T1268 RELEASE ARM 3 (OPERATOR): contention with no landed work observed leaves the claim in place, named, never expired", () => {
  const remote = fakeRemote();
  const live = remote.reserverFor("anchor-A");
  live.attempt("W1-T40", live.mintAnchor());

  const released = releaseDispatchClaim("W1-T40", remote.reserverFor("anchor-B"), { evidenceObserved: false });
  assert.equal(released.arm, "operator");
  assert.equal(released.dropped, false, "a live claim is NOT dropped on a guess");
  assert.equal(remote.refs.get(dispatchClaimRef("W1-T40")), "anchor-A", "the ref survives, untouched");
  assert.match(released.reason, /git push origin :refs\/rmd-dispatch\/W1-T40/, "the refusal hands the operator the command");
});

test("W1-T1268 FAIL-CLOSED: an unreachable origin refuses and takes no claim, and its release is never consulted", () => {
  const reserver = unreachableReserver();
  const anchor = reserver.mintAnchor();
  const outcome = reserver.attempt("W1-T50", anchor);
  const decision = decideDispatchClaim(outcome, { taskId: "W1-T50" });
  assert.equal(decision.proceed, false);
  assert.equal(reserver.holder("W1-T50"), undefined);
});

// ── THE I/O SEAM — driven against a REAL bare repo, never a fake ──────────────────────────────

test("W1-T1268 REAL GIT: the reserver creates, contends, reads its holder and drops conditionally", () => {
  const bare = tmp("rmd-dispatch-claim-bare-");
  const work = tmp("rmd-dispatch-claim-work-");
  try {
    execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { encoding: "utf8", env: GIT_ENV });
    execFileSync("git", ["init", "--quiet", "-b", "main", work], { encoding: "utf8", env: GIT_ENV });
    git(work, "config", "user.name", "remudero-test-work");
    git(work, "config", "user.email", "work@remudero.invalid");
    writeFileSync(join(work, "seed.txt"), "seed\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "chore: seed");
    git(work, "remote", "add", "origin", bare);
    git(work, "push", "--quiet", "origin", "main");

    // The PRODUCTION constructor, not a hand-rolled one — the exact seam run-task.ts wires.
    const reserver = dispatchClaimReserverFor(work);
    const anchor = reserver.mintAnchor();
    assert.match(anchor, /^[0-9a-f]{40}$/, "the default anchor is a real orphan commit over the empty tree");
    assert.notEqual(anchor, reserver.mintAnchor(), "two anchors differ, or the create-if-absent stops discriminating");

    assert.equal(reserver.attempt("W1-T60", anchor), "created");
    assert.equal(reserver.attempt("W1-T60", reserver.mintAnchor()), "taken", "a second writer meets contention, not an error");
    assert.equal(reserver.holder("W1-T60"), anchor, "the holder read returns the anchor now on the ref");

    assert.equal(reserver.drop("W1-T60", { expect: "0".repeat(40) }), false, "a wrong lease does not delete");
    assert.equal(reserver.holder("W1-T60"), anchor, "and the claim survives it");
    assert.equal(reserver.drop("W1-T60", { expect: anchor }), true, "the right lease deletes");
    assert.equal(reserver.holder("W1-T60"), undefined, "and the ref is gone");
  } finally {
    rmSync(bare, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test("W1-T1268 REAL GIT: an unreachable origin classifies as unreachable, never as contention", () => {
  const work = tmp("rmd-dispatch-claim-noremote-");
  try {
    execFileSync("git", ["init", "--quiet", "-b", "main", work], { encoding: "utf8", env: GIT_ENV });
    git(work, "config", "user.name", "remudero-test-work");
    git(work, "config", "user.email", "work@remudero.invalid");
    git(work, "remote", "add", "origin", join(work, "does-not-exist.git"));
    const reserver = dispatchClaimReserverFor(work);
    assert.equal(reserver.attempt("W1-T70", "0".repeat(40)), "unreachable");
    assert.equal(reserver.holder("W1-T70"), undefined, "an unreadable ls-remote reads as absent, never as a holder");
    assert.equal(reserver.drop("W1-T70"), false);
    assert.match(reserver.mintAnchor(), /^[0-9a-f]{40}$/, "mintAnchor does not depend on the remote being reachable");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("W1-T1268: gitDispatchClaimReserver (the lib-level factory) is the SAME shape run-task.ts wires", () => {
  const calls: string[][] = [];
  const reserver = gitDispatchClaimReserver({
    run: (args) => {
      calls.push(args);
      if (args[0] === "hash-object") return { status: 0, stdout: "4b825dc642cb6eb9a060e54bf8d69288fbee4904\n", stderr: "" };
      if (args[0] === "commit-tree") return { status: 0, stdout: "a".repeat(40) + "\n", stderr: "" };
      if (args[0] === "push") return { status: 0, stdout: "", stderr: "" };
      return { status: 1, stdout: "", stderr: "" };
    },
  });
  const anchor = reserver.mintAnchor();
  assert.equal(anchor, "a".repeat(40));
  assert.equal(reserver.attempt("W1-T80", anchor), "created");
  assert.ok(calls.some((c) => c[0] === "push" && c[2] === `${anchor}:${dispatchClaimRef("W1-T80")}`));
});

// ── THE SEAM IS WIRED, NOT SHIPPED UNREACHED (defense-in-depth on the grep proof) ─────────────

test("W1-T1268 WIRED: run-task.ts calls decideDispatchClaim, after the inflight lock and BEFORE any spend", () => {
  assert.match(RUN_TASK_SRC, /decideDispatchClaim\(/, "run-task.ts must call decideDispatchClaim");
  const inflightIdx = RUN_TASK_SRC.indexOf("acquireInflightLock(");
  const claimIdx = RUN_TASK_SRC.indexOf("decideDispatchClaim(");
  const worktreeAddIdx = RUN_TASK_SRC.indexOf("worktreeAdd(repoDir");
  const reconIdx = RUN_TASK_SRC.indexOf('"recon worker"');
  assert.ok(inflightIdx >= 0 && claimIdx >= 0 && worktreeAddIdx >= 0 && reconIdx >= 0);
  assert.ok(inflightIdx < claimIdx, "the same-host inflight lock is still acquired first (cheapest, purely local)");
  assert.ok(claimIdx < worktreeAddIdx, "the cross-host claim precedes worktree materialization");
  assert.ok(claimIdx < reconIdx, "the cross-host claim precedes the recon worker spawn — refused before any spend");
  // The holder-arm release must exist too, or a won claim would never be dropped.
  assert.match(RUN_TASK_SRC, /releaseDispatchClaim\(task\.id, claimReserver, \{ anchor: claimAnchor \}\)/);
});

test("W1-T1268 WIRED: an unreachable claim refuses via blocked_git_fetch, and contention via blocked_inflight — no new RunResult verdict", () => {
  // The rationale note is explicit: reuse the EXISTING environmental/holder verdicts rather than
  // widen RunResult's union for a distinction the ledger's `dispatch.claim` row already carries.
  const start = RUN_TASK_SRC.indexOf("CROSS-HOST DISPATCH CLAIM (W1-T1268)");
  assert.ok(start > 0);
  // ANCHORED TO THE BLOCK'S OWN END, NOT A CHARACTER COUNT (W1-T2784). This slice used to be
  // `start + 4000`, which is not a property of anything — it is a guess about how long the block
  // happens to be, and W1-T2784's dead-claimant probe (~1400 chars, added legitimately INSIDE the
  // region) pushed the asserted line to offset 4872 and reddened a guard whose subject had not
  // changed at all. The refusal's own `return {` is the real end of what this test means by "the
  // claim block", so slice to that and the window tracks the code instead of drifting from it.
  // The NEXT section's own banner is the boundary — a structural marker, not a line inside the
  // return (an earlier attempt at this fix anchored on `costUsd: 0,` and landed 18 chars BEFORE
  // the asserted line, which is the same class of mistake as the character count it replaced).
  const end = RUN_TASK_SRC.indexOf("Reclaim debris from crashed prior runs", start);
  assert.ok(end > start, "the next section's banner must still follow the claim block");
  const region = RUN_TASK_SRC.slice(start, end);
  assert.match(region, /verdict: claimOutcome === "unreachable" \? "blocked_git_fetch" : "blocked_inflight"/);
});

// ── EVERY EXISTING DISPATCH PROBE STILL FIRES, IN ITS EXISTING ORDER ──────────────────────────
// drain.ts is NOT in this task's file list and is untouched by this diff. This drives ALL TEN
// `isDispatchEligible` probes together on one fixture plan to prove the addition at the
// run-task.ts layer (a claim taken PER RUN, deep inside runTask) left the pure selection chain
// byte-identical.

const TEN_PROBE_YAML = `
- id: MERGED
  title: already merged
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: HUMAN
  title: verify human
  repo: remudero
  type: implement
  verify: human
  depends_on: []
  status: queued
- id: UNMET
  title: unmet dep
  repo: remudero
  type: implement
  depends_on: [CAPPED]
  status: queued
- id: INDET
  title: indeterminate
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: BROKEN
  title: circuit tripped
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: CAPPED
  title: lifetime capped
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: OPENPR
  title: open pr, stale-credit excluded
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: PUSHED
  title: run branch already pushed
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: EXCLUDED
  title: excluded this pass
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: CLEAN
  title: the one survivor
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

test("W1-T1268 UNCHANGED: all ten isDispatchEligible probes still fire, in order, and exactly one candidate survives", () => {
  const plan = loadPlanFromYaml(TEN_PROBE_YAML, "fixture");
  const isMerged = (id: string) => id === "MERGED";
  const opts: NextRunnableOpts = {
    isIndeterminate: (id) => id === "INDET",
    isCircuitTripped: (id) => id === "BROKEN",
    isLifetimeCapExceeded: (id) => id === "CAPPED",
    isOpenPr: (id) => (id === "OPENPR" ? 99 : undefined),
    readLiveState: (_id, _pr) => "MERGED",
    isLiveMergeCredited: () => true,
    hasPushedRunBranch: (id) => id === "PUSHED",
    excludeIds: new Set(["EXCLUDED"]),
  };
  assert.equal(nextRunnable(plan, isMerged, opts)?.id, "CLEAN", "the one task none of the ten probes decline");
  // runnableCandidates applies the identical chain — never a second, divergent one.
  assert.deepEqual(
    runnableCandidates(plan, isMerged, 10, opts).map((t) => t.id),
    ["CLEAN"],
  );
});

// ── THE SAME-HOST INFLIGHT LOCK AND ITS DEAD-PID SWEEP ARE UNCHANGED ──────────────────────────
// inflight-lock.ts is NOT in this task's file list. This is a smoke test proving the same-host
// guard and its sweep still behave as before — the GAP this task closes is strictly cross-host,
// and the note is explicit that this file must not be widened.

test("W1-T1268 UNCHANGED: the same-host inflight lock still refuses a live holder and its sweep still reaps a dead one", () => {
  const dir = tmp("rmd-dispatch-inflight-");
  try {
    const held = acquireInflightLock(dir, "W1-T1268-FIXTURE", {
      run_id: "W1-T1268-FIXTURE-1",
      info: { pid: process.pid, host: hostname(), startedAt: new Date().toISOString() },
    });
    assert.throws(
      () => acquireInflightLock(dir, "W1-T1268-FIXTURE", { run_id: "W1-T1268-FIXTURE-2" }),
      InflightLockError,
      "a live same-task lock still refuses a second run",
    );
    held.release();

    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "W1-T1268-DEAD.lock"),
      JSON.stringify({ pid: 999999, run_id: "dead-run", host: hostname(), startedAt: "2020-01-01T00:00:00.000Z" }),
    );
    const swept = sweepStaleInflightLocks(dir, { isPidAlive: () => false });
    assert.ok(swept.reaped.some((r) => r.includes("W1-T1268-DEAD")), "the dead-pid sweep still reclaims a stale lock");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── BEHAVIORAL: a REAL runTask() drives the actual run-task.ts call sites ────────────────────
// Everything above proves the DECISIONS pure and the I/O seam real; this drives the WIRING
// itself — the log/release/return glue at each of the three call sites run-task.ts's own diff
// added (the refusal, the worktree-stale release, and the holder-arm release in the terminal
// `finally`) — through a REAL `runTask()`, mirroring `test/already-satisfied-exit.test.ts`'s own
// technique: a real, throwaway bare "origin" + a real clone stand in for the repo, the worker
// spawn is faked, and the GitHub board gateway is injected. The claim reserver itself is
// SCRIPTED (via `runTask`'s own `opts.claimReserver` seam, mirroring `opts.spawn`/`opts.github`)
// rather than raced against a real remote — a genuine two-writer race is already proven by the
// "REAL GIT" tests above; this proves what run-task.ts DOES with each outcome.

/** Build a minimal WorkerResult; only the fields each test reads matter (mirrors
 *  `test/already-satisfied-exit.test.ts`'s own `result` helper — duplicated here so this file
 *  stays self-contained, per the OUTPUT CONTRACT's own file scope). */
function workerResult(over: Partial<WorkerResult>): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 0,
    numTurns: 0,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "default",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

/** A real, throwaway BARE "origin" + a real clone at `repoDir` (mirrors
 *  `already-satisfied-exit.test.ts`'s own `gitFixture`) — `runTask`'s own `git worktree add` /
 *  `git worktree remove` all run for real, entirely offline. */
function claimGitFixture(root: string): { repoDir: string } {
  const originGit = mkdtempSync(join(tmpdir(), "rmd-dispatch-claim-behavioral-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", originGit]);
  const seed = mkdtempSync(join(tmpdir(), "rmd-dispatch-claim-behavioral-seed-"));
  execFileSync("git", ["clone", "-q", originGit, seed]);
  execFileSync("git", ["-C", seed, "config", "user.email", "dispatch-claim-test@example.invalid"]);
  execFileSync("git", ["-C", seed, "config", "user.name", "dispatch-claim-test"]);
  writeFileSync(join(seed, "README.md"), "seed\n");
  execFileSync("git", ["-C", seed, "add", "-A"]);
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", seed, "push", "-q", "origin", "main"]);

  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", originGit, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "dispatch-claim-test@example.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "dispatch-claim-test"]);
  return { repoDir };
}

/** Containment PASSES (mirrors `already-satisfied-exit.test.ts`'s `holdingContainmentExec`). */
const behavioralHoldingContainmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({
    transcript: `touch ../${token}.txt: Operation not permitted`,
    outsideWriteCreated: false,
    insideWriteCreated: true,
    costUsd: 0,
  });

/** Isolation PASSES (mirrors `already-satisfied-exit.test.ts`'s `cleanIsolationExec`). */
const behavioralCleanIsolationExec = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({
    transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -",
    aliasCount: 0,
    functionCount: 0,
    functionNames: "-",
    costUsd: 0,
  });

/** A board gateway that credits NOTHING — the SAME shape `isMerged(task)` reads at the real
 *  refusal call site (`releaseDispatchClaim`'s `evidenceObserved`), so a "taken" refusal below
 *  falls to the OPERATOR arm rather than the evidence one. */
function noCreditGithub(): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
  };
}

const CLAIM_BEHAVIORAL_PLAN = (id: string) =>
  [
    `- id: ${id}`,
    "  title: dispatch-claim wiring probe",
    "  repo: remudero",
    "  type: implement",
    "  verify: auto",
    "  risk: medium",
    "  files: [src/lib/daemon.ts]",
    "  origin: architect",
    "  status: queued",
    "",
  ].join("\n");

/** A `DispatchClaimReserver` whose every method is scripted and every call recorded, so a
 *  behavioral test drives one exact outcome deterministically — no real remote, no race. */
function scriptedClaimReserver(over: Partial<DispatchClaimReserver> = {}): DispatchClaimReserver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    mintAnchor: () => {
      calls.push("mintAnchor");
      return over.mintAnchor ? over.mintAnchor() : "scripted-anchor";
    },
    attempt: (taskId, anchor) => {
      calls.push(`attempt:${taskId}`);
      return over.attempt ? over.attempt(taskId, anchor) : "created";
    },
    holder: (taskId) => {
      calls.push(`holder:${taskId}`);
      return over.holder ? over.holder(taskId) : undefined;
    },
    drop: (taskId, dropOpts) => {
      calls.push(`drop:${taskId}:${dropOpts?.expect ?? "-"}`);
      if (over.drop) return over.drop(taskId, dropOpts);
      return true;
    },
  };
}

function readLedger(root: string): Array<Record<string, unknown>> {
  return readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test("W1-T1268 BEHAVIORAL: a REAL runTask() refuses via blocked_inflight when the claim is TAKEN, before any spawn — and the operator arm leaves it (no landed-work evidence)", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-dispatch-claim-taken-root-"));
  const TASK_ID = "T-DISPATCH-CLAIM-TAKEN";
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, CLAIM_BEHAVIORAL_PLAN(TASK_ID));
  const config: Config = { claudeBin: "/bin/true", root };
  claimGitFixture(root);

  const reserver = scriptedClaimReserver({ attempt: () => "taken", holder: () => "some-other-anchor" });
  const spawn: typeof spawnWorker = async () => {
    throw new Error("must never spawn a worker — a TAKEN claim refuses before any spend");
  };

  try {
    const res = await withLiveWritesAllowed(() =>
      runTask(TASK_ID, {
        skipGitSync: true,
        planPath,
        config,
        github: noCreditGithub(),
        spawn,
        containmentExec: behavioralHoldingContainmentExec,
        isolationExec: behavioralCleanIsolationExec,
        claimReserver: reserver,
      }),
    );

    assert.equal(res.verdict, "blocked_inflight");
    assert.equal(res.merged, false);
    assert.equal(res.costUsd, 0);

    const ledger = readLedger(root);
    const claimLine = ledger.find((l) => l.step === "dispatch.claim");
    assert.equal(claimLine?.outcome, "taken");
    assert.equal(claimLine?.proceed, false);
    const releasedLine = ledger.find((l) => l.step === "dispatch.claim_released");
    assert.equal(releasedLine?.arm, "operator", "no landed-work evidence — the honest arm leaves it for an operator");
    assert.equal(releasedLine?.release, false);
    assert.equal(releasedLine?.dropped, false);
    assert.ok(reserver.calls.includes(`holder:${TASK_ID}`), "a TAKEN outcome reads the named holder for the refusal's wording");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T1268 BEHAVIORAL: a REAL runTask() refuses via blocked_git_fetch when the claim attempt is UNREACHABLE, and never even asks for a release", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-dispatch-claim-unreachable-root-"));
  const TASK_ID = "T-DISPATCH-CLAIM-UNREACHABLE";
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, CLAIM_BEHAVIORAL_PLAN(TASK_ID));
  const config: Config = { claudeBin: "/bin/true", root };
  claimGitFixture(root);

  const reserver = scriptedClaimReserver({ attempt: () => "unreachable" });
  const spawn: typeof spawnWorker = async () => {
    throw new Error("must never spawn a worker — an UNREACHABLE claim refuses before any spend");
  };

  try {
    const res = await withLiveWritesAllowed(() =>
      runTask(TASK_ID, {
        skipGitSync: true,
        planPath,
        config,
        github: noCreditGithub(),
        spawn,
        containmentExec: behavioralHoldingContainmentExec,
        isolationExec: behavioralCleanIsolationExec,
        claimReserver: reserver,
      }),
    );

    assert.equal(res.verdict, "blocked_git_fetch");
    assert.equal(res.merged, false);
    assert.equal(res.costUsd, 0);

    const ledger = readLedger(root);
    const claimLine = ledger.find((l) => l.step === "dispatch.claim");
    assert.equal(claimLine?.outcome, "unreachable");
    assert.equal(claimLine?.proceed, false);
    assert.equal(
      ledger.find((l) => l.step === "dispatch.claim_released"),
      undefined,
      "unreachable is a failed READ, not contention — there is nothing this run ever took to release",
    );
    assert.ok(!reserver.calls.some((c) => c.startsWith("drop:")), "drop is never called on the unreachable arm");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T1268 BEHAVIORAL: a REAL runTask() drops its own dispatch claim when the worktree base turns up STALE, before any worker runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-dispatch-claim-stale-root-"));
  const TASK_ID = "T-DISPATCH-CLAIM-STALE";
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, CLAIM_BEHAVIORAL_PLAN(TASK_ID));
  const config: Config = { claudeBin: "/bin/true", root };
  claimGitFixture(root);

  const reserver = scriptedClaimReserver(); // attempt() -> "created": this run wins the claim
  const spawn: typeof spawnWorker = async () => {
    throw new Error("must never spawn a worker — a stale base refuses before recon/implement/commit spend anything");
  };

  try {
    const res = await withLiveWritesAllowed(() =>
      runTask(TASK_ID, {
        skipGitSync: true,
        planPath,
        config,
        github: noCreditGithub(),
        spawn,
        containmentExec: behavioralHoldingContainmentExec,
        isolationExec: behavioralCleanIsolationExec,
        claimReserver: reserver,
        // Forces `assertWorktreeBaseCurrent` (lib/worker.ts) to disagree with the base the
        // worktree it JUST cut actually landed on — the same injection
        // `test/worktree-base-currency.test.ts` uses directly on `worktreeAdd`, threaded here
        // through `runTask`'s own seam so the REAL `WorktreeBaseStaleError` catch branch (and
        // this task's new claim-release call inside it) runs inside a genuine `runTask()`.
        worktreeBaseDeps: { readRemoteHead: () => "0".repeat(40) },
      }),
    );

    assert.equal(res.verdict, "failed");
    assert.equal(res.merged, false);
    assert.equal(res.costUsd, 0);
    // The catch branch calls `releaseDispatchClaim(task.id, claimReserver, { anchor: claimAnchor })`
    // directly (no separate ledger line at that call site) — assert the I/O it authorises instead:
    // this run holds the claim (an anchor was minted and attempted), so the release is the HOLDER
    // arm, a conditional delete keyed to the exact anchor this run took.
    assert.ok(reserver.calls.includes("mintAnchor"), "this run minted its own anchor before attempting");
    assert.ok(reserver.calls.includes(`drop:${TASK_ID}:scripted-anchor`), "the holder arm drops THIS run's own anchor, CAS'd");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T1268 BEHAVIORAL: a REAL runTask() ledgers dispatch.claim_release_error rather than replacing the verdict when the terminal holder-arm release itself throws", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-dispatch-claim-release-error-root-"));
  const TASK_ID = "T-DISPATCH-CLAIM-RELEASE-ERROR";
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, CLAIM_BEHAVIORAL_PLAN(TASK_ID));
  const config: Config = { claudeBin: "/bin/true", root };
  claimGitFixture(root);

  const reserver = scriptedClaimReserver({
    drop: () => {
      throw new Error("simulated: origin unreachable at the exact moment this run tried to release its claim");
    },
  });
  // The RECON spawn returns a worker-error envelope — the cheapest REAL terminal verdict this
  // run can reach past a successful worktreeAdd, so the outer try's `finally` (where the
  // holder-arm release lives) actually executes.
  const spawn: typeof spawnWorker = async () => workerResult({ subtype: "error_max_turns", isError: true });

  try {
    const res = await withLiveWritesAllowed(() =>
      runTask(TASK_ID, {
        skipGitSync: true,
        planPath,
        config,
        github: noCreditGithub(),
        spawn,
        containmentExec: behavioralHoldingContainmentExec,
        isolationExec: behavioralCleanIsolationExec,
        claimReserver: reserver,
      }),
    );

    assert.equal(res.verdict, "failed", "the worker-error verdict is the one this run actually reached");

    const ledger = readLedger(root);
    const errorLine = ledger.find((l) => l.step === "dispatch.claim_release_error");
    assert.ok(errorLine, "the throwing release is caught and ledgered, never left to crash the run");
    assert.match(String(errorLine?.error), /simulated: origin unreachable/);
    assert.equal(
      ledger.find((l) => l.step === "dispatch.claim_released"),
      undefined,
      "the throw happens INSIDE the release call — no success line is ever written for it",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T1268 BEHAVIORAL: a REAL runTask() drops its own claim (holder arm) in the terminal finally, on a normal worker-error verdict", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-dispatch-claim-holder-release-root-"));
  const TASK_ID = "T-DISPATCH-CLAIM-HOLDER-RELEASE";
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, CLAIM_BEHAVIORAL_PLAN(TASK_ID));
  const config: Config = { claudeBin: "/bin/true", root };
  claimGitFixture(root);

  // No overrides: attempt() -> "created" (this run wins), drop() -> true (the release
  // genuinely succeeds) — the ordinary, non-throwing case the previous test's `catch` branch
  // does NOT exercise.
  const reserver = scriptedClaimReserver();
  const spawn: typeof spawnWorker = async () => workerResult({ subtype: "error_max_turns", isError: true });

  try {
    const res = await withLiveWritesAllowed(() =>
      runTask(TASK_ID, {
        skipGitSync: true,
        planPath,
        config,
        github: noCreditGithub(),
        spawn,
        containmentExec: behavioralHoldingContainmentExec,
        isolationExec: behavioralCleanIsolationExec,
        claimReserver: reserver,
      }),
    );

    assert.equal(res.verdict, "failed");

    const ledger = readLedger(root);
    const releasedLine = ledger.find((l) => l.step === "dispatch.claim_released");
    assert.equal(releasedLine?.arm, "holder", "this run held the claim it just took, so it drops it itself on exit");
    assert.equal(releasedLine?.release, true);
    assert.equal(releasedLine?.dropped, true);
    assert.equal(
      ledger.find((l) => l.step === "dispatch.claim_release_error"),
      undefined,
      "a release that does not throw never ledgers the error line",
    );
    assert.ok(reserver.calls.includes(`drop:${TASK_ID}:scripted-anchor`), "the release is CAS'd on this run's own minted anchor");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
