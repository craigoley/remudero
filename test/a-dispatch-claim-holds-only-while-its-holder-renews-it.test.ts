// W1-T9432: a dispatch claim holds only while its holder renews it. A renewal is a child commit of the
// claim pushed with --force-with-lease; a lane meeting a foreign claim judges its holder's silence against
// W, the p90 of this instance's measured claim-to-verdict durations: W reports it once and keeps it, 2W
// reclaims it and the judging lane takes the task. Driven against REAL bare fixture remotes, the judge with
// injected ledger rows and clocks, and `rmd claim --hold` as a real child process that is signalled.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, mock } from "node:test";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "#test/helpers/git-repo.js";
import { fixedClock } from "#src/lib/clock.js";
import {
  claimLastSignOfLife,
  claimRenewalMessage,
  claimSilenceWindow,
  decideClaimSilence,
  dispatchClaimRef,
  gitClaimRunnerAsync,
  gitDispatchClaimReserver,
  gitDispatchClaimReserverAsync,
  holdDispatchClaim,
  parseClaimAnchorMessage,
  parseClaimRenewal,
  readRunBranchActivity,
  reclaimSilentDispatchClaim,
  renewDispatchClaim,
  renewDispatchClaimAsync,
  type ClaimSilenceJudgeInputs,
  type DispatchClaimOutcome,
  type DispatchClaimReserver,
  type DispatchClaimReserverAsync,
} from "#src/lib/dispatch-claim.js";
import { claimCommand, claimHoldCommand, runTask, type RunResult } from "#src/run-task.js";
import type { Config } from "#src/lib/config.js";
import type { ProbeExecResult } from "#src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "#src/lib/isolation.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import type { GitHub } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { spawnWorker } from "#src/lib/worker.js";

Object.assign(process.env, {
  GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
  GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
  GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
  GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
});

const ID = "W1-T9432";
const MIN = 60_000;
const HOUR = 60 * MIN;
const W = 60 * MIN;
type Row = Record<string, unknown>;

interface Fixture { bare: string; work: string; git(dir: string, ...args: string[]): string; cleanup(): void }

function fixture(): Fixture {
  const bare = gitRepo({ bare: true, kind: "claim-renew-bare" });
  const work = gitRepo({ kind: "claim-renew-work" });
  work.addRemote("origin", bare.dir);
  work.git("push", "--quiet", "origin", "main");
  return {
    bare: bare.dir,
    work: work.dir,
    git: (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim(),
    cleanup() {
      bare.cleanup();
      work.cleanup();
    },
  };
}

const syncReserver = (dir: string): DispatchClaimReserver =>
  gitDispatchClaimReserver({
    run: (args) => {
      try {
        return { status: 0, stdout: execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: "pipe" }), stderr: "" };
      } catch (error) {
        const e = error as { status?: number; stdout?: string; stderr?: string };
        return { status: e.status ?? 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
      }
    },
  });

const asyncReserver = (dir: string): DispatchClaimReserverAsync => gitDispatchClaimReserverAsync({ run: gitClaimRunnerAsync(dir) });

/** Pushes a claim minted by a holder that is not this process — `pid@host` at `mintedAtMs` — and returns its sha. */
async function pushForeignClaim(f: Fixture, taskId: string, mintedAtMs: number, holder = "4242@dead-mac-mini"): Promise<string> {
  const tree = f.git(f.work, "hash-object", "-t", "tree", "/dev/null");
  const sha = f.git(f.work, "commit-tree", tree, "-m", `rmd-dispatch claim ${holder} ${new Date(mintedAtMs).toISOString()}`);
  assert.equal(await asyncReserver(f.work).attempt(taskId, sha), "created");
  return sha;
}

const remoteTip = (f: Fixture, taskId: string): string =>
  f.git(f.bare, "for-each-ref", "--format=%(objectname)", dispatchClaimRef(taskId));

const messageOf = (f: Fixture, sha: string): string => f.git(f.bare, "log", "-1", "--format=%B", sha);

/** `n` builds, each claimed and given its verdict `durationMs` later, within the last 7 days. */
function measuredRows(n: number, durationMs: number, nowMs: number): Row[] {
  return Array.from({ length: n }, (_, i) => {
    const claimedAt = nowMs - 2 * 24 * HOUR + i * MIN;
    return [
      { step: "dispatch.claim", outcome: "created", run_id: `measured-${i}`, task_id: `T-M-${i}`, ts: new Date(claimedAt).toISOString() },
      { step: "verdict", verdict: "merged", run_id: `measured-${i}`, task_id: `T-M-${i}`, ts: new Date(claimedAt + durationMs).toISOString() },
    ];
  }).flat();
}

function judgeDeps(f: Fixture, rows: Row[], nowMs: number, logged: Array<{ step: string; fields: Row }>): ClaimSilenceJudgeInputs {
  return {
    run: gitClaimRunnerAsync(f.work),
    stateDir: join(f.work, "no-state"),
    log: (step, fields) => void logged.push({ step, fields }),
    clock: fixedClock(nowMs),
    readRows: async () => [...rows, ...logged.map(({ step, fields }) => ({ step, ...fields }))],
    mintedByThisInstance: () => false,
  };
}

test("W1-T9432: a claim silent past twice the measured window is reclaimed and the lane takes it", async () => {
  const f = fixture();
  try {
    const nowMs = Date.now();
    const foreign = await pushForeignClaim(f, ID, nowMs - 25 * HOUR);
    const logged: Array<{ step: string; fields: Row }> = [];
    const said: string[] = [];
    const deps = { ...judgeDeps(f, measuredRows(152, W, nowMs), nowMs, logged), say: (line: string) => void said.push(line) };
    const judged = await reclaimSilentDispatchClaim(ID, asyncReserver(f.work), deps);
    assert.equal(judged.verdict, "reclaim");
    assert.equal(judged.dropped, true);
    assert.ok(judged.anchor, "the retried create took the claim");
    assert.equal(remoteTip(f, ID), judged.anchor, "the judging lane now holds the claim");
    const lane = parseClaimAnchorMessage(messageOf(f, judged.anchor!));
    assert.equal(lane?.host, hostname(), "the new claim names this lane's own host");
    assert.equal(lane?.pid, process.pid);
    const reclaimed = logged.filter((r) => r.step === "dispatch.claim_reclaimed");
    assert.equal(reclaimed.length, 1, "one dispatch.claim_reclaimed row");
    assert.deepEqual(
      { ...reclaimed[0]!.fields, reason: undefined },
      {
        ref: dispatchClaimRef(ID), sha: foreign, holder: "4242@dead-mac-mini", minted: new Date(nowMs - 25 * HOUR).toISOString(),
        last_sign_of_life: new Date(nowMs - 25 * HOUR).toISOString(), last_sign_of_life_source: "minted",
        silence_ms: 25 * HOUR, window_ms: W, samples: 152, reason: undefined, dropped: true,
      },
    );
    assert.match(String(reclaimed[0]!.fields.reason), /4242@dead-mac-mini.*silent for 2W or more; reclaiming/);
    assert.equal(logged.filter((r) => r.step === "dispatch.claim_unrenewed").length, 0);
    assert.equal(said.length, 1);
    assert.match(said[0]!, /^RECLAIMED a silent claim — /);
  } finally {
    f.cleanup();
  }
});

test("a reclaim whose lease is lost writes dropped: false and takes nothing", async () => {
  const nowMs = Date.now();
  const logged: Array<{ step: string; fields: Row }> = [];
  const calls: string[] = [];
  const reserver: DispatchClaimReserverAsync = {
    mintAnchor: () => (calls.push("mint"), "never"),
    attempt: () => (calls.push("attempt"), "created"),
    holder: () => "judged-sha",
    drop: (_id, o) => (calls.push(`drop:${o?.expect}`), false),
    anchorMessage: () => `rmd-dispatch claim 7@gone ${new Date(nowMs - 30 * HOUR).toISOString()}`,
  };
  const judged = await reclaimSilentDispatchClaim(ID, reserver, {
    run: async () => ({ status: 0, stdout: "", stderr: "" }),
    stateDir: "/nonexistent",
    log: (step, fields) => void logged.push({ step, fields }),
    clock: fixedClock(nowMs),
    readRows: async () => measuredRows(10, W, nowMs),
    mintedByThisInstance: () => false,
  });
  assert.equal(judged.verdict, "reclaim");
  assert.equal(judged.dropped, false);
  assert.equal(judged.anchor, undefined, "a lost lease takes nothing");
  assert.deepEqual(calls, ["drop:judged-sha"], "the drop is pinned to the sha judged and no retry follows a lost lease");
  assert.equal(logged[0]?.step, "dispatch.claim_reclaimed");
  assert.equal(logged[0]?.fields.dropped, false);
});

test("W1-T9432: a claim silent past one window is reported once and kept", async () => {
  const f = fixture();
  try {
    const nowMs = Date.now();
    const foreign = await pushForeignClaim(f, ID, nowMs - 90 * MIN);
    const logged: Array<{ step: string; fields: Row }> = [];
    const deps = judgeDeps(f, measuredRows(20, W, nowMs), nowMs, logged);
    const first = await reclaimSilentDispatchClaim(ID, asyncReserver(f.work), deps);
    assert.equal(first.verdict, "unrenewed");
    assert.equal(first.anchor, undefined);
    const second = await reclaimSilentDispatchClaim(ID, asyncReserver(f.work), { ...deps, clock: fixedClock(nowMs + 5 * MIN) });
    assert.equal(second.verdict, "unrenewed");
    const reported = logged.filter((r) => r.step === "dispatch.claim_unrenewed");
    assert.equal(reported.length, 1, "reported once per judged anchor sha, not once per lane");
    assert.equal(reported[0]!.fields.sha, foreign);
    assert.equal(reported[0]!.fields.holder, "4242@dead-mac-mini");
    assert.equal(reported[0]!.fields.window_ms, W);
    assert.equal(reported[0]!.fields.samples, 20);
    assert.equal(reported[0]!.fields.silence_ms, 90 * MIN);
    assert.equal(logged.filter((r) => r.step === "dispatch.claim_reclaimed").length, 0);
    assert.equal(remoteTip(f, ID), foreign, "the claim is kept");
  } finally {
    f.cleanup();
  }
});

test("W1-T9432: a renewed claim or a moving run branch keeps the claim", async () => {
  const f = fixture();
  try {
    const mintedAtMs = Date.now() - 25 * HOUR;
    const anchor = await pushForeignClaim(f, ID, mintedAtMs, `${process.pid}@${hostname()}`);
    const renewal = renewDispatchClaim(syncReserver(f.work), ID, anchor);
    assert.equal(renewal.outcome, "renewed");
    const renewedSha = renewal.outcome === "renewed" ? renewal.sha : "";
    assert.equal(remoteTip(f, ID), renewedSha);
    assert.equal(f.git(f.bare, "rev-parse", `${renewedSha}^`), anchor, "a renewal is a child commit of the claim it renews");
    const message = messageOf(f, renewedSha);
    assert.deepEqual(parseClaimAnchorMessage(message), parseClaimAnchorMessage(messageOf(f, anchor)), "the minter still decodes from the first line");
    assert.match(message, new RegExp(`^renewed ${process.pid}@${hostname().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\S+$`, "m"));

    const nowMs = Date.now() + MIN;
    const rows = measuredRows(152, W, nowMs);
    const logged: Array<{ step: string; fields: Row }> = [];
    const renewed = await reclaimSilentDispatchClaim(ID, asyncReserver(f.work), judgeDeps(f, rows, nowMs, logged));
    assert.equal(renewed.verdict, "alive", renewed.reason);
    assert.match(renewed.reason, /\(renewed\)/);
    assert.equal(remoteTip(f, ID), renewedSha, "the renewed claim is kept");

    const branchTask = "W1-T94320";
    const branchClaim = await pushForeignClaim(f, branchTask, mintedAtMs);
    f.git(f.work, "commit", "--quiet", "--allow-empty", "-m", "a live hand-build's checkpoint");
    f.git(f.work, "push", "--quiet", "origin", `HEAD:refs/heads/run-${branchTask}-1792372622906`);
    const moving = await reclaimSilentDispatchClaim(branchTask, asyncReserver(f.work), judgeDeps(f, rows, nowMs, logged));
    assert.equal(moving.verdict, "alive", moving.reason);
    assert.match(moving.reason, /\(run-branch\)/);
    assert.equal(remoteTip(f, branchTask), branchClaim, "a claim whose run branch moved is kept");
    assert.deepEqual(logged, [], "neither claim is reported or reclaimed");

    const control = decideClaimSilence({
      taskId: branchTask, anchor: parseClaimAnchorMessage(messageOf(f, branchClaim)),
      lastSignOfLife: claimLastSignOfLife(parseClaimAnchorMessage(messageOf(f, branchClaim))!, messageOf(f, branchClaim)),
      mintedByThisInstance: false, window: claimSilenceWindow(rows), nowMs,
    });
    assert.equal(control.verdict, "reclaim", "control: the same claim judged without its branch would be reclaimed");
  } finally {
    f.cleanup();
  }
});

test("W1-T9432: no measured durations means no reclaim", async () => {
  const f = fixture();
  try {
    const nowMs = Date.now();
    const foreign = await pushForeignClaim(f, ID, nowMs - 100 * HOUR);
    const unpaired = measuredRows(30, W, nowMs).filter((r) => r.step === "dispatch.claim");
    const logged: Array<{ step: string; fields: Row }> = [];
    const judged = await reclaimSilentDispatchClaim(ID, asyncReserver(f.work), judgeDeps(f, unpaired, nowMs, logged));
    assert.equal(judged.verdict, "no-verdict");
    assert.match(judged.reason, /^no-duration-evidence/);
    assert.deepEqual(logged, [], "nothing is reported and nothing reclaimed");
    assert.equal(remoteTip(f, ID), foreign, "the claim stays for the operator arm");
    assert.deepEqual(claimSilenceWindow(unpaired), { samples: 0 }, "a claim with no verdict is not a sample");
    const anchor = parseClaimAnchorMessage(messageOf(f, foreign))!;
    assert.equal(
      decideClaimSilence({ taskId: ID, anchor, lastSignOfLife: claimLastSignOfLife(anchor, undefined), mintedByThisInstance: false, window: { samples: 0 }, nowMs }).verdict,
      "no-verdict",
    );
  } finally {
    f.cleanup();
  }
});

test("W1-T9432: a renewal never recreates a reclaimed claim", async () => {
  const f = fixture();
  try {
    const own = asyncReserver(f.work);
    const anchor = await own.mintAnchor();
    assert.equal(await own.attempt(ID, anchor), "created");
    assert.equal(await own.drop(ID, { expect: anchor }), true, "another lane reclaims it");
    assert.deepEqual(await renewDispatchClaimAsync(own, ID, anchor), { outcome: "lost" });
    assert.deepEqual(renewDispatchClaim(syncReserver(f.work), ID, anchor), { outcome: "lost" });
    assert.equal(remoteTip(f, ID), "", "the reclaimed claim is not recreated");

    const next = await pushForeignClaim(f, ID, Date.now(), "99@other-host");
    assert.deepEqual(await renewDispatchClaimAsync(own, ID, anchor), { outcome: "lost", holder: next });
    assert.deepEqual(renewDispatchClaim(syncReserver(f.work), ID, anchor), { outcome: "lost", holder: next });
    assert.equal(remoteTip(f, ID), next, "the new holder's claim is untouched");

    const midTask = "W1-T94322";
    const held = await own.mintAnchor();
    assert.equal(await own.attempt(midTask, held), "created");
    const run = gitClaimRunnerAsync(f.work);
    const reclaimedMidRenewal = gitDispatchClaimReserverAsync({
      run: async (args) => {
        if (args[0] === "push") execFileSync("git", ["-C", f.bare, "update-ref", "-d", dispatchClaimRef(midTask)]);
        return run(args);
      },
    });
    assert.deepEqual(await renewDispatchClaimAsync(reclaimedMidRenewal, midTask, held), { outcome: "lost" });
    assert.equal(remoteTip(f, midTask), "", "a claim reclaimed after the renewal read it is still not recreated — the push lease refuses");
  } finally {
    f.cleanup();
  }
});

test("a renewal that loses the push lease is lost, and an unreachable origin is unreachable", async () => {
  const f = fixture();
  try {
    const anchor = await pushForeignClaim(f, ID, Date.now(), "1@h");
    const racing = await pushForeignClaim(f, "W1-T94329", Date.now(), "2@h");
    const run = gitClaimRunnerAsync(f.work);
    const raced = gitDispatchClaimReserverAsync({
      run: async (args) => {
        if (args[0] === "push") {
          execFileSync("git", ["-C", f.bare, "update-ref", dispatchClaimRef(ID), racing]);
        }
        return run(args);
      },
    });
    assert.deepEqual(await renewDispatchClaimAsync(raced, ID, anchor), { outcome: "lost" }, "the lease refuses a claim that moved after the read");
    assert.equal(remoteTip(f, ID), racing);

    execFileSync("git", ["-C", f.work, "remote", "set-url", "origin", join(f.bare, "missing")]);
    const gone = await renewDispatchClaimAsync(asyncReserver(f.work), ID, racing);
    assert.equal(gone.outcome, "unreachable");
    assert.equal(renewDispatchClaim(syncReserver(f.work), ID, racing).outcome, "unreachable");
    const fakes: DispatchClaimReserver = { mintAnchor: () => "a", attempt: () => "created", holder: () => undefined, drop: () => true };
    assert.equal(renewDispatchClaim(fakes, ID, "a").outcome, "unreachable", "a reserver that cannot renew never claims it renewed");
    assert.equal((await renewDispatchClaimAsync(fakes, ID, "a")).outcome, "unreachable");
  } finally {
    f.cleanup();
  }
});

test("the window is the p90 of paired claim-to-verdict durations and the renewal grammar round-trips", () => {
  const nowMs = Date.parse("2026-10-19T00:00:00Z");
  const rows: Row[] = Array.from({ length: 10 }, (_, i) => measuredRows(1, (i + 1) * MIN, nowMs + i * HOUR).map((r) => ({ ...r, run_id: `r${i}` }))).flat();
  rows.push({ step: "verdict", run_id: "r0", ts: new Date(nowMs + 99 * HOUR).toISOString() }, { step: "dispatch.claim", outcome: "taken", run_id: "rx", ts: "x" });
  assert.deepEqual(claimSilenceWindow(rows), { windowMs: 9 * MIN, samples: 10 });
  assert.equal(claimRenewalMessage("not a claim", "1@h 2026-10-19T00:00:00.000Z"), undefined);
  const msg = claimRenewalMessage("rmd-dispatch claim 5@mac 2026-10-18T00:00:00.000Z\nrenewed 6@mac 2026-10-18T01:00:00.000Z", "6@mac 2026-10-18T02:00:00.000Z");
  assert.equal(msg, "rmd-dispatch claim 5@mac 2026-10-18T00:00:00.000Z\nrenewed 6@mac 2026-10-18T02:00:00.000Z");
  assert.deepEqual(parseClaimRenewal(`${msg}\nrenewed 6@mac 2026-10-18T01:00:00.000Z`), {
    by: "6@mac", renewedAtMs: Date.parse("2026-10-18T02:00:00.000Z"), renewedAtIso: "2026-10-18T02:00:00.000Z",
  });
  assert.equal(parseClaimRenewal("rmd-dispatch claim 5@mac 2026-10-18T00:00:00.000Z"), undefined);
  const anchor = parseClaimAnchorMessage(msg)!;
  assert.equal(claimLastSignOfLife(anchor, "renewed 1@h 2026-10-17T00:00:00.000Z").source, "minted", "a renewal older than the mint is not newer life");
  const base = { taskId: ID, anchor, lastSignOfLife: claimLastSignOfLife(anchor, msg), mintedByThisInstance: false, window: { windowMs: W, samples: 3 } };
  const at = (ms: number) => decideClaimSilence({ ...base, nowMs: Date.parse("2026-10-18T02:00:00.000Z") + ms }).verdict;
  assert.deepEqual([at(W - 1), at(W), at(2 * W - 1), at(2 * W)], ["alive", "unrenewed", "unrenewed", "reclaim"]);
  assert.equal(decideClaimSilence({ ...base, anchor: undefined, nowMs }).verdict, "no-verdict");
  assert.match(decideClaimSilence({ ...base, mintedByThisInstance: true, nowMs }).reason, /fleet lane of this instance/);
  assert.match(decideClaimSilence({ ...base, lastSignOfLife: undefined, nowMs }).reason, /run branches are unreadable/);
});

test("an unreadable run branch, an unreadable anchor or a fleet lane's own claim is never judged", async () => {
  const f = fixture();
  try {
    const nowMs = Date.now();
    const foreign = await pushForeignClaim(f, ID, nowMs - 30 * HOUR);
    const rows = measuredRows(10, W, nowMs);
    const logged: Array<{ step: string; fields: Row }> = [];
    const failing = async () => ({ status: 128, stdout: "", stderr: "fatal: could not read from remote" });
    const unreadable = await reclaimSilentDispatchClaim(ID, asyncReserver(f.work), { ...judgeDeps(f, rows, nowMs, logged), run: failing });
    assert.equal(unreadable.verdict, "no-verdict");
    assert.deepEqual(await readRunBranchActivity(ID, failing), { ok: false, stderr: "fatal: could not read from remote" });
    const mine = await reclaimSilentDispatchClaim(ID, asyncReserver(f.work), { ...judgeDeps(f, rows, nowMs, logged), mintedByThisInstance: undefined, stateDir: join(f.work, "absent-state") });
    assert.equal(mine.verdict, "reclaim", "with no mint row in this instance's ledger the default probe reads a foreign claim");
    const again = await pushForeignClaim(f, "W1-T94321", nowMs - 30 * HOUR);
    const own = await reclaimSilentDispatchClaim("W1-T94321", asyncReserver(f.work), { ...judgeDeps(f, rows, nowMs, logged), mintedByThisInstance: () => true });
    assert.equal(own.verdict, "no-verdict");
    assert.equal(remoteTip(f, "W1-T94321"), again);
    const noAnchor: DispatchClaimReserverAsync = { mintAnchor: () => "x", attempt: () => "taken", holder: () => foreign, drop: () => true };
    assert.equal((await reclaimSilentDispatchClaim(ID, noAnchor, judgeDeps(f, rows, nowMs, logged))).verdict, "no-verdict");
    let shownLog = 0;
    const badLog = async (args: string[]) => {
      if (args[0] === "ls-remote") return { status: 0, stdout: `${"a".repeat(40)}\trefs/heads/run-${ID}-1\n${"b".repeat(40)}\trefs/heads/run-W1-T94-2\n`, stderr: "" };
      if (args[0] === "log") return (shownLog++, { status: 0, stdout: "not-a-time\n", stderr: "" });
      return { status: 0, stdout: "", stderr: "" };
    };
    assert.equal((await readRunBranchActivity(ID, badLog)).ok, false);
    assert.equal(shownLog, 1, "a branch of another task id is never read");
    const badFetch = async (args: string[]) => (args[0] === "fetch" ? { status: 1, stdout: "", stderr: "" } : badLog(args));
    assert.deepEqual(await readRunBranchActivity(ID, badFetch), { ok: false, stderr: "git exited 1" });
  } finally {
    f.cleanup();
  }
});

test("a run's lease renews its claim on the pace and stop() hands back the sha to release", async (t) => {
  const f = fixture();
  const leases: Array<ReturnType<typeof holdDispatchClaim>> = [];
  t.mock.timers.enable({ apis: ["setInterval"] });
  try {
    const reserver = asyncReserver(f.work);
    const anchor = await reserver.mintAnchor();
    assert.equal(await reserver.attempt(ID, anchor), "created");
    const logged: string[] = [];
    const lease = holdDispatchClaim(ID, reserver, anchor, { intervalMs: 20, log: (step) => void logged.push(step) });
    leases.push(lease);
    t.mock.timers.tick(19);
    assert.equal(remoteTip(f, ID), anchor, "the lease waits for its renewal pace");
    t.mock.timers.tick(1);
    const held = await lease.stop();
    assert.notEqual(held, anchor, "the lease renewed the claim");
    assert.equal(remoteTip(f, ID), held, "stop() returns the sha the ref now carries");
    assert.equal(lease.current(), held);
    assert.equal(await reserver.drop(ID, { expect: held }), true, "the holder release pinned to that sha drops it");
    assert.equal(logged.length, 0, "a healthy lease records nothing");

    const taken = await reserver.mintAnchor();
    assert.equal(await reserver.attempt(ID, taken), "created");
    assert.equal(await reserver.drop(ID, { expect: taken }), true);
    let recordFailure!: () => void;
    const failure = new Promise<void>((resolve) => { recordFailure = resolve; });
    const lost = holdDispatchClaim(ID, reserver, taken, { intervalMs: 20, log: (step, fields) => {
      logged.push(`${step}:${String(fields.outcome)}`);
      recordFailure();
    } });
    leases.push(lost);
    t.mock.timers.tick(20);
    await failure;
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(100);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(await lost.stop(), taken);
    assert.deepEqual(logged, ["dispatch.claim_renew_failed:lost"], "a lost claim stops renewing and is recorded once");
    assert.equal(remoteTip(f, ID), "", "a lost lease never recreates the claim");

    const throwing: DispatchClaimReserverAsync = { ...reserver, renew: () => Promise.reject(new Error("git exploded")) };
    const errored = holdDispatchClaim(ID, throwing, "z", { intervalMs: 10, log: (step, fields) => void logged.push(`${step}:${String(fields.error)}`) });
    leases.push(errored);
    t.mock.timers.tick(10);
    await errored.stop();
    assert.equal(logged[1], "dispatch.claim_renew_failed:git exploded");
    const inert = holdDispatchClaim(ID, { mintAnchor: () => "q", attempt: () => "created", holder: () => undefined, drop: () => true }, "q");
    assert.equal(await inert.stop(), "q", "a reserver that cannot renew holds its anchor unchanged");
  } finally {
    for (const lease of leases) await lease.stop();
    f.cleanup();
  }
});

function captured<T>(fn: () => T): { value: T; out: () => string; err: () => string; restore: () => void } {
  const out = mock.method(console, "log", () => {});
  const err = mock.method(console, "error", () => {});
  const text = (m: typeof out) => () => m.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
  return { value: fn(), out: text(out), err: text(err), restore: () => (out.mock.restore(), err.mock.restore()) };
}

test("rmd claim --renew renews only this host's claim", async () => {
  const f = fixture();
  try {
    const reserver = syncReserver(f.work);
    const none = captured(() => claimCommand([ID, "--renew"], { reserver, isPlanned: () => true }));
    none.restore();
    assert.equal(none.value, 1);
    assert.match(none.err(), /not held — nothing to renew/);
    const anchor = await pushForeignClaim(f, ID, Date.now(), `1@${hostname()}`);
    const r = captured(() => claimCommand([ID, "--renew"], { reserver, isPlanned: () => true }));
    r.restore();
    assert.equal(r.value, 0, r.err());
    assert.match(r.out(), new RegExp(`^renewed ${dispatchClaimRef(ID)} ${remoteTip(f, ID)} `));
    assert.notEqual(remoteTip(f, ID), anchor);
    const foreign = captured(() => claimCommand([ID, "--renew"], { reserver, isPlanned: () => true, localHost: "another-host" }));
    foreign.restore();
    assert.equal(foreign.value, 1);
    assert.match(foreign.err(), /refusing to renew another host's claim/);
    f.git(f.bare, "update-ref", "-d", dispatchClaimRef(ID));
    const tip = await pushForeignClaim(f, ID, Date.now(), `1@${hostname()}`);
    const lost = captured(() => claimCommand([ID, "--renew"], { reserver: { ...reserver, holder: () => anchor }, isPlanned: () => true }));
    lost.restore();
    assert.equal(lost.value, 1);
    assert.match(lost.err(), new RegExp(`lost ${dispatchClaimRef(ID)} — it is now held by ${tip}`));
  } finally {
    f.cleanup();
  }
});

test("rmd claim --hold in-process: takes, renews, adopts, refuses and ends on a signal or a lost claim", async () => {
  const f = fixture();
  const out = mock.method(console, "log", () => {});
  const err = mock.method(console, "error", () => {});
  const text = (m: typeof out) => m.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
  try {
    const reserver = syncReserver(f.work);
    assert.equal(await claimHoldCommand([ID, "--hold", "--interval-ms", "0"], { reserver, isPlanned: () => true }), 2);
    assert.equal(await claimHoldCommand(["--hold"], { reserver }), 2);
    assert.equal(await claimHoldCommand([ID, "--hold"], { reserver, isPlanned: () => false }), 1);
    const signals = new EventEmitter();
    const held = claimHoldCommand([ID, "--hold", "--interval-ms", "30"], { reserver, isPlanned: () => true, signals });
    const deadline = Date.now() + 20_000;
    while (!/renewed /.test(text(out)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    signals.emit("SIGHUP");
    assert.equal(await held, 0);
    assert.match(text(out), new RegExp(`holding ${dispatchClaimRef(ID)} [0-9a-f]{40}`));
    assert.match(text(out), new RegExp(`dropped ${dispatchClaimRef(ID)}`));
    assert.equal(remoteTip(f, ID), "");
    assert.equal(signals.listenerCount("SIGTERM"), 0, "every signal listener is removed");

    const mine = await pushForeignClaim(f, ID, Date.now(), `1@${hostname()}`);
    const adopted = claimHoldCommand([ID, "--hold", "--interval-ms", "30"], { reserver, isPlanned: () => true, signals });
    await new Promise((r) => setTimeout(r, 10));
    f.git(f.bare, "update-ref", "-d", dispatchClaimRef(ID));
    assert.equal(await adopted, 1, "a lost renewal exits 1");
    assert.match(text(err), /rmd claim: lost refs\/rmd-dispatch\/W1-T9432 — it is now held by nobody/);
    assert.ok(text(out).includes(`holding ${dispatchClaimRef(ID)} ${mine}`), "this host's existing claim is adopted");

    await pushForeignClaim(f, ID, Date.now(), "3@another-host");
    assert.equal(await claimHoldCommand([ID, "--hold"], { reserver, isPlanned: () => true, signals }), 1, "another host's claim is never adopted");
    assert.match(text(err), /already claimed by another lane/);
    f.git(f.bare, "update-ref", "-d", dispatchClaimRef(ID));
    const noDrop = claimHoldCommand([ID, "--hold", "--interval-ms", "60000"], { reserver: { ...reserver, drop: () => false }, isPlanned: () => true, signals });
    await new Promise((r) => setTimeout(r, 10));
    signals.emit("SIGINT");
    assert.equal(await noDrop, 1, "a drop that fails on exit is not reported as success");
    assert.match(text(err), /could not drop/);
  } finally {
    out.mock.restore();
    err.mock.restore();
    f.cleanup();
  }
});

test("W1-T9432: rmd claim --hold renews while alive and drops on SIGTERM", async () => {
  const f = fixture();
  try {
    const runTaskUrl = pathToFileURL(join(process.cwd(), "src", "run-task.ts")).href;
    const script = [
      `const m = await import(${JSON.stringify(runTaskUrl)});`,
      `const code = await m.claimHoldCommand([${JSON.stringify(ID)}, "--hold", "--interval-ms", "300"],`,
      `  { reserver: m.dispatchClaimReserverFor(${JSON.stringify(f.work)}), isPlanned: () => true });`,
      "process.exit(code);",
    ].join("\n");
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    const deadline = Date.now() + 120_000;
    while ((stdout.match(/^renewed /gm)?.length ?? 0) < 2 && child.exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const holding = /^holding refs\/rmd-dispatch\/W1-T9432 ([0-9a-f]{40})$/m.exec(stdout);
    assert.ok(holding, `the holder announced its claim; stdout=${stdout} stderr=${stderr}`);
    assert.ok((stdout.match(/^renewed /gm)?.length ?? 0) >= 2, `it renewed while alive; stderr=${stderr}`);
    const tip = remoteTip(f, ID);
    assert.notEqual(tip, holding[1], "the claim on origin moved past its mint");
    assert.equal(f.git(f.bare, "merge-base", "--is-ancestor", holding[1]!, tip), "", "each renewal descends from the claim it holds");
    assert.equal(parseClaimAnchorMessage(messageOf(f, tip))?.host, hostname());
    assert.ok(parseClaimRenewal(messageOf(f, tip)), "the tip carries a renewal line");
    child.kill("SIGTERM");
    assert.equal(await exited, 0, `stderr=${stderr}`);
    assert.match(stdout, /^dropped refs\/rmd-dispatch\/W1-T9432$/m);
    assert.equal(remoteTip(f, ID), "", "the claim is dropped when its holder is signalled");
  } finally {
    f.cleanup();
  }
});

// ── runTask's taken arm, end to end: the lane that judged a silent claim builds the task ───────

const TASK_ID = "T-RECLAIM-SILENT";

function buildRunFixture(): { root: string; planPath: string; config: Config; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}claim-reclaim-`));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, [`- id: ${TASK_ID}`, "  title: a silent claim is reclaimed", "  repo: remudero", "  type: implement",
    "  verify: auto", "  risk: medium", "  files: [src/lib/daemon.ts]", "  origin: test", "  status: queued", ""].join("\n"));
  const origin = gitRepo({ bare: true, kind: "claim-reclaim-origin" });
  const seed = gitRepo({ cloneFrom: origin.dir, kind: "claim-reclaim-seed" });
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "seed");
  seed.git("push", "-q", "origin", "HEAD:main");
  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", origin.dir, repoDir], { stdio: "pipe" });
  const config: Config = { claudeBin: "/bin/true", root, installRoot: process.cwd() };
  return { root, planPath, config, cleanup: () => (origin.cleanup(), seed.cleanup(), rmSync(root, { recursive: true, force: true })) };
}

test("runTask reclaims a claim silent past 2W and builds the task under its own retried claim", async () => {
  const fx = buildRunFixture();
  try {
    const nowMs = Date.now();
    mkdirSync(join(fx.root, "state"), { recursive: true });
    writeFileSync(join(fx.root, "state", "ledger.ndjson"), measuredRows(12, W, nowMs).map((r) => JSON.stringify(r)).join("\n") + "\n");
    const calls: string[] = [];
    const anchors = ["lane-anchor", "retried-anchor"];
    const outcomes: DispatchClaimOutcome[] = ["taken", "created"];
    const reserver: DispatchClaimReserver = {
      mintAnchor: () => anchors.shift()!,
      attempt: (_id, anchor) => (calls.push(`attempt:${anchor}`), outcomes.shift()!),
      holder: () => "silent-holder-sha",
      drop: (id, o) => (calls.push(`drop:${id}:${o?.expect ?? "-"}`), true),
      anchorMessage: () => `rmd-dispatch claim 4242@dead-mac-mini ${new Date(nowMs - 25 * HOUR).toISOString()}`,
    };
    const offline: GitHub = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
    const spawnNever: typeof spawnWorker = async () => {
      throw new Error("must never spawn — the stale base refuses before any worker runs");
    };
    const result: RunResult = await withLiveWritesAllowed(() =>
      runTask(TASK_ID, {
        skipGitSync: true,
        planPath: fx.planPath,
        config: fx.config,
        github: offline,
        spawn: spawnNever,
        containmentExec: (token: string): Promise<ProbeExecResult> =>
          Promise.resolve({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 }),
        isolationExec: (): Promise<IsolationProbeExecResult> =>
          Promise.resolve({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 }),
        claimReserver: reserver,
        worktreeBaseDeps: { readRemoteHead: () => "0".repeat(40) },
      }),
    );
    const ledger = readFileSync(join(fx.root, "state", "ledger.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);
    const runId = ledger.find((r) => r.step === "run.start")?.run_id;
    const own = ledger.filter((r) => r.run_id === runId);
    const reclaimed = own.find((r) => r.step === "dispatch.claim_reclaimed");
    assert.ok(reclaimed, "the taken arm writes dispatch.claim_reclaimed");
    assert.equal(reclaimed.dropped, true);
    assert.equal(reclaimed.sha, "silent-holder-sha");
    assert.notEqual(result.verdict, "blocked_inflight", "the lane is not refused");
    assert.equal(own.find((r) => r.step === "verdict")?.stage, "worktree.stale_base", "the lane went on to build");
    assert.deepEqual(calls, [
      "attempt:lane-anchor",
      `drop:${TASK_ID}:silent-holder-sha`,
      "attempt:retried-anchor",
      `drop:${TASK_ID}:retried-anchor`,
    ], "dropped pinned to the judged sha, retried once, and released under the anchor it took");
  } finally {
    fx.cleanup();
  }
});
