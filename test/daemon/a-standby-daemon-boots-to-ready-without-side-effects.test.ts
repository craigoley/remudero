// W1-T14544: `rmd daemon --standby` runs only the read-only part of its boot, says it is ready, and takes
// state/drain.lock only after it is promoted and the lock's live holder has let go. These drive the REAL
// daemonCommand; only the daemon loop (runDaemon) and the boot routine (daemonBoot) are replaced, and both throw
// if they are reached before promotion.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { acquireDrainLock } from "#src/lib/drain-lock.js";
import type { DaemonSummary } from "#src/lib/daemon.js";
import { daemonTargetRecordPath } from "#src/lib/repo-location.js";
import { handoffExitPath, leaveExitCodeForEntrypoint, standbyPromotePath, standbyReadyPath } from "#src/lib/daemon-standby.js";
import { daemonCommand } from "#test/helpers/run-task-daemon.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const RUN_ID = "DAEMON-STANDBY-TEST";
type Row = { step: string; [key: string]: unknown };

interface World { home: string; root: string; state: string; planPath: string; ledger: string }

function world(t: TestContext, plan = "[]\n"): World {
  const home = ownedFixtureDir(t, "standby-daemon").dir;
  const root = join(home, "Remudero");
  const state = join(root, "state");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, plan);
  return { home, root, state, planPath, ledger: join(state, "ledger.ndjson") };
}

function rows(w: World): Row[] {
  if (!existsSync(w.ledger)) return [];
  return readFileSync(w.ledger, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row);
}

const stopped: DaemonSummary = { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };

/** Runs the real command with HOME and the run id pinned; `during` runs while the command is waiting. */
async function standby(w: World, args: string[], deps: Record<string, unknown>, during?: () => Promise<void>): Promise<number> {
  const env = { HOME: process.env.HOME, REMUDERO_RUN_ID: process.env.REMUDERO_RUN_ID };
  process.env.HOME = w.home;
  process.env.REMUDERO_RUN_ID = RUN_ID;
  try {
    const run = daemonCommand(["--allow-self-target", "--max", "0", "--standby", ...args], deps as never);
    if (during) await during();
    return await run;
  } finally {
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

async function until(predicate: () => boolean, what: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const throwing = {
  runDaemon: async () => { throw new Error("the loop ran before promotion"); },
  daemonBoot: async () => { throw new Error("the boot sweeps ran before promotion"); },
};

test("W1-T14544 a standby reaches ready with every side-effect seam a throwing fake", async (t) => {
  const w = world(t);
  const exitListeners = process.listenerCount("exit");
  let seenWhileReady: { lock: boolean; record: boolean } | undefined;
  const code = await standby(w, ["--plan", w.planPath], { ...throwing, standby: { pollMs: 5, promoteBoundMs: 400 } }, async () => {
    await until(() => existsSync(standbyReadyPath(w.state, RUN_ID)), "the ready marker");
    seenWhileReady = { lock: existsSync(join(w.state, "drain.lock")), record: existsSync(daemonTargetRecordPath(w.state)) };
  });
  assert.deepEqual(seenWhileReady, { lock: false, record: false }, "ready, with no lock and no target record");
  const ready = rows(w).find((r) => r.step === "daemon.standby_ready");
  assert.ok(ready, "daemon.standby_ready is ledgered");
  assert.equal(ready.pid, process.pid);
  assert.equal(typeof ready.prepare_ms, "number");
  // Never promoted: it gives up at its bound, leaving nothing behind.
  assert.equal(code, 1);
  assert.equal(rows(w).find((r) => r.step === "daemon.standby_aborted")?.criterion, "promote_bound");
  assert.equal(existsSync(join(w.state, "drain.lock")), false);
  assert.equal(existsSync(standbyReadyPath(w.state, RUN_ID)), false, "the ready marker is withdrawn");
  assert.equal(process.listenerCount("exit"), exitListeners, "a standby that never promoted leaves no exit hook");
});

test("W1-T14544 a standby never takes the lock from a live holder", async (t) => {
  const w = world(t);
  const lockPath = join(w.state, "drain.lock");
  const holder = acquireDrainLock(lockPath); // this test process: alive for the whole wait
  try {
    const code = await standby(w, ["--plan", w.planPath], { ...throwing, standby: { pollMs: 5, lockWaitBoundMs: 300 } }, async () => {
      await until(() => existsSync(standbyReadyPath(w.state, RUN_ID)), "the ready marker");
      writeFileSync(standbyPromotePath(w.state, RUN_ID), "");
    });
    assert.equal(code, 1);
    const refused = rows(w).find((r) => r.step === "daemon.standby_promote_refused");
    assert.ok(refused, "the refusal is ledgered");
    assert.equal(refused.holder_pid, process.pid, "it names the live holder");
    assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).pid, process.pid, "the holder's lock is untouched");
    assert.equal(existsSync(daemonTargetRecordPath(w.state)), false);
  } finally {
    holder.release();
  }
});

test("W1-T14544 a promoted standby takes over and says how long each part took", async (t) => {
  const w = world(t);
  const lockPath = join(w.state, "drain.lock");
  let lockHeldInLoop = false;
  let recordInLoop = false;
  const exitListeners = process.listeners("exit");
  const code = await standby(w, ["--plan", w.planPath], {
    runDaemon: async () => {
      lockHeldInLoop = JSON.parse(readFileSync(lockPath, "utf8")).pid === process.pid;
      recordInLoop = existsSync(daemonTargetRecordPath(w.state));
      return stopped;
    },
    standby: { pollMs: 5 },
  }, async () => {
    await until(() => existsSync(standbyReadyPath(w.state, RUN_ID)), "the ready marker");
    writeFileSync(standbyPromotePath(w.state, RUN_ID), "");
  });
  const added = process.listeners("exit").filter((l) => !exitListeners.includes(l));
  for (const l of added) process.removeListener("exit", l);
  assert.equal(code, 0);
  assert.equal(lockHeldInLoop, true, "the loop runs holding the lock");
  assert.equal(recordInLoop, true, "the deferred target record is written before the loop");
  const promoted = rows(w).filter((r) => r.step === "daemon.standby_promoted");
  assert.equal(promoted.length, 1);
  for (const field of ["prepare_ms", "promote_wait_ms", "lock_wait_ms", "takeover_ms"]) {
    assert.equal(typeof promoted[0]![field], "number", field);
  }
  assert.equal(added.length, 1, "a promoted standby leaves one exit hook for the entrypoint");
  assert.equal(existsSync(standbyPromotePath(w.state, RUN_ID)), false, "the promote marker is consumed");
});

test("W1-T14544 a standby that cannot get ready aborts and leaves the lock alone", async (t) => {
  const slow = world(t);
  const late = await standby(slow, ["--plan", slow.planPath], { ...throwing, standby: { readyBoundMs: -1 } });
  assert.equal(late, 1);
  assert.equal(rows(slow).find((r) => r.step === "daemon.standby_aborted")?.criterion, "ready_bound");
  assert.equal(existsSync(join(slow.state, "drain.lock")), false);
  assert.equal(rows(slow).some((r) => r.step === "daemon.standby_ready"), false, "it never said it was ready");

  const broken = world(t, "- id: [unterminated\n");
  const failed = await standby(broken, ["--plan", broken.planPath], { ...throwing, standby: { pollMs: 5 } });
  assert.equal(failed, 1);
  assert.equal(rows(broken).find((r) => r.step === "daemon.standby_aborted")?.criterion, "prepare_failed");
  assert.equal(existsSync(join(broken.state, "drain.lock")), false);
});

test("W1-T14544 a standby starts no garden and syncs no checkout before it holds the lock", async (t) => {
  // A self-target with no --plan: a normal boot git-syncs the checkout's plan (W1-T60). The standby must not.
  const origin = gitRepo({ scope: t, bare: true, kind: "standby-origin" });
  const checkout = gitRepo({ scope: t, kind: "standby-checkout" });
  mkdirSync(join(checkout.dir, "plan"), { recursive: true });
  writeFileSync(join(checkout.dir, "plan", "tasks.yaml"), "[]\n");
  checkout.git("add", "-A");
  checkout.git("commit", "-qm", "plan");
  checkout.addRemote("origin", origin.dir);
  checkout.git("push", "-q", "origin", "HEAD:main");
  const w = world(t);
  let loopRan = false;
  let fetchedBeforeLock: boolean | undefined;
  const code = await standby(w, [], {
    repoRoot: checkout.dir,
    runDaemon: async () => { loopRan = true; return stopped; },
    daemonBoot: async () => { throw new Error("the boot sweeps ran before promotion"); },
    standby: { pollMs: 5, promoteBoundMs: 400 },
  }, async () => {
    await until(() => existsSync(standbyReadyPath(w.state, RUN_ID)), "the ready marker");
    fetchedBeforeLock = existsSync(join(checkout.dir, ".git", "FETCH_HEAD"));
  });
  assert.equal(code, 1, "never promoted, so it gives up at its bound");
  assert.equal(fetchedBeforeLock, false, "no plan sync fetched the checkout");
  assert.equal(loopRan, false, "the loop, which starts the gardens, never ran");
  assert.equal(existsSync(daemonTargetRecordPath(w.state)), false);

  // Promoted over the same checkout, it runs the sync it skipped once it holds the lock, then the loop.
  const v = world(t);
  let fetchedAtReady: boolean | undefined;
  let inLoop: { fetched: boolean; locked: boolean } | undefined;
  const exitListeners = process.listeners("exit");
  const promoted = await standby(v, [], {
    repoRoot: checkout.dir,
    runDaemon: async () => {
      inLoop = { fetched: existsSync(join(checkout.dir, ".git", "FETCH_HEAD")),
        locked: JSON.parse(readFileSync(join(v.state, "drain.lock"), "utf8")).pid === process.pid };
      return stopped;
    },
    standby: { pollMs: 5 },
  }, async () => {
    await until(() => existsSync(standbyReadyPath(v.state, RUN_ID)), "the ready marker");
    fetchedAtReady = existsSync(join(checkout.dir, ".git", "FETCH_HEAD"));
    writeFileSync(standbyPromotePath(v.state, RUN_ID), "");
  });
  for (const l of process.listeners("exit").filter((l) => !exitListeners.includes(l))) process.removeListener("exit", l);
  assert.equal(promoted, 0);
  assert.equal(fetchedAtReady, false, "still no sync while it waits");
  assert.deepEqual(inLoop, { fetched: true, locked: true }, "the plan sync ran after the lock, before the loop");
  assert.equal(existsSync(daemonTargetRecordPath(v.state)), true);
});

test("W1-T14544 a promoted standby leaves its exit code for the entrypoint", (t) => {
  const state = join(ownedFixtureDir(t, "standby-exit").dir, "state");
  const proc = new EventEmitter();
  leaveExitCodeForEntrypoint(state, 4242, proc as unknown as NodeJS.Process);
  assert.equal(existsSync(handoffExitPath(state, 4242)), false, "nothing is written before the process exits");
  proc.emit("exit", 75);
  assert.equal(readFileSync(handoffExitPath(state, 4242), "utf8"), "75\n");
});
