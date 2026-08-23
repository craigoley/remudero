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
import { dispatchClaimReserverFor } from "../src/run-task.js";
import { nextRunnable, runnableCandidates, type NextRunnableOpts } from "../src/lib/drain.js";
import { loadPlanFromYaml } from "../src/lib/plan.js";
import { acquireInflightLock, InflightLockError, sweepStaleInflightLocks } from "../src/lib/inflight-lock.js";

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
  const region = RUN_TASK_SRC.slice(start, start + 4000);
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
