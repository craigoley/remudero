/**
 * W1-T12707: the first full pass after a restart reads dispatch claims only after the start-claim sweep settles.
 * The pass reads an operator-session head's refs/rmd-dispatch claim (readSessionOwnershipViaGit); a dead claim
 * from before the restart that the sweep had not yet ended read as held, and a held verdict dispatches no round.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate as flush } from "node:timers/promises";
import { runDaemon } from "#src/lib/daemon.js";
import {
  bootSweepDispatchClaimsAsync, gitClaimRunnerAsync, gitDispatchClaimReserverAsync, type DispatchClaimReserverAsync,
} from "#src/lib/dispatch-claim.js";
import { loadPlan } from "#src/lib/plan.js";
import { readSessionOwnershipViaGit } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import {
  BRANCH, FIXED_HOST_PROBE, fakeReserver, gitRemote, LOCAL, orphanRunRows, TASK,
} from "#test/helpers/restart-orphan.js";
import { daemonCommand } from "#test/helpers/run-task-daemon.js";

type Row = Record<string, unknown>;
type Deps = NonNullable<Parameters<typeof daemonCommand>[1]>;
type Run = { taskId: string; runId: string; merged: boolean; costUsd: number; verdict: "merged" };
const RECYCLE_PAUSE = "PAUSE requested: container recycle (deploy/recycle-container.sh)";
const PLAN_YAML = "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function fixturePlan(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12707-plan-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "tasks.yaml"), PLAN_YAML);
  return loadPlan(join(dir, "tasks.yaml"));
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

async function turns(count: number, done: () => boolean = () => false): Promise<void> {
  for (let i = 0; i < count && !done(); i++) await tick();
}

function runOneFor(merged: Set<string>) {
  return async (id: string): Promise<Run> => {
    merged.add(id);
    return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" };
  };
}

test("W1-T12707 criterion 1: the tick's full pass does not call deps.sweep while the claim sweep is pending", async (t) => {
  const hold = deferred();
  const events: string[] = [];
  const merged = new Set<string>();
  const loop = runDaemon(fixturePlan(t), {
    claimSweepSettled: hold.promise,
    refreshMerged: () => (id) => merged.has(id),
    runOne: runOneFor(merged),
    sweep: async () => { events.push("sweep"); },
    sweepLight: async () => { events.push("review"); },
    sleep: tick,
    log: () => {},
  }, { max: 1 });
  await turns(100, () => events.includes("sweep"));
  assert.ok(events.includes("review"), `fixture: the loop ran (saw ${events.join(", ")})`);
  assert.equal(events.includes("sweep"), false, "the full pass has not started while the claim sweep is pending");
  hold.resolve();
  await loop;
  assert.equal(events.includes("sweep"), true, "the full pass starts once the claim sweep settles");
});

test("W1-T12707 criterion 1: the recycle-pause tick's full pass does not call deps.sweep while the claim sweep is pending", async (t) => {
  const hold = deferred();
  const events: string[] = [];
  const merged = new Set<string>();
  let paused: string | undefined = RECYCLE_PAUSE;
  const loop = runDaemon(fixturePlan(t), {
    claimSweepSettled: hold.promise,
    refreshMerged: () => (id) => merged.has(id),
    runOne: runOneFor(merged),
    checkPause: () => paused,
    sweep: async () => { events.push("sweep"); paused = undefined; },
    sweepLight: async () => {},
    sleep: tick,
    log: (step) => { events.push(step); },
  }, { max: 1 });
  await turns(100, () => events.includes("sweep"));
  assert.ok(events.includes("daemon.pause"), "fixture: the loop sat in the recycle PAUSE");
  assert.equal(events.includes("sweep"), false, "the full pass has not started while the claim sweep is pending");
  hold.resolve();
  await loop;
  assert.equal(events.includes("sweep"), true, "the full pass starts once the claim sweep settles");
});

test("W1-T12707 criterion 2: a dead claim from the previous run is not read as held by the first full pass", async (t) => {
  const remote = gitRemote(t);
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12707-state-`));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  writeFileSync(join(stateDir, "ledger.ndjson"), orphanRunRows().map((row) => `${JSON.stringify(row)}\n`).join(""));
  const hold = deferred();
  const real = gitDispatchClaimReserverAsync({ run: gitClaimRunnerAsync(remote.client.dir) });
  const reserver: DispatchClaimReserverAsync = { ...real, list: async () => { await hold.promise; return real.list!(); } };
  const lockIso = new Date().toISOString();
  const swept: Row[] = [];
  const claimSweepSettled = bootSweepDispatchClaimsAsync(reserver, {
    hostProbe: FIXED_HOST_PROBE, localHost: LOCAL, lockHeldSinceMs: Date.parse(lockIso), lockHeldSinceIso: lockIso, stateDir,
    log: (step, fields) => { swept.push({ step, ...fields }); },
  }).then(() => undefined);
  const claimsRead: Array<number | undefined> = [];
  const merged = new Set<string>();
  const loop = runDaemon(fixturePlan(t), {
    claimSweepSettled,
    refreshMerged: () => (id) => merged.has(id),
    runOne: runOneFor(merged),
    sweep: async () => {
      const evidence = await readSessionOwnershipViaGit(remote.client.dir, { headRefName: BRANCH, taskId: TASK }, {
        nowMs: Date.now(), readLock: () => undefined, fixClaimKey: "o/r/branch",
      });
      claimsRead.push(evidence.claims?.length);
    },
    sweepLight: async () => {},
    sleep: tick,
    log: (step, x) => { if (/sweep\.|claim/.test(step)) console.log(step, JSON.stringify(x).slice(0,300)); },
  }, { max: 1 });
  await turns(100, () => claimsRead.length > 0);
  assert.deepEqual(claimsRead, [], "the pass has read no claim while the sweep is pending");
  assert.notEqual(remote.claimTip(), "", "fixture: the dead claim is still on the remote");
  hold.resolve();
  await loop;
  await turns(1_000, () => claimsRead.length > 0);
  assert.deepEqual(claimsRead, [0], "the first pass read the claim ref after the sweep ended it: none held");
  assert.equal(remote.claimTip(), "", "the dead claim is gone from the remote");
  assert.ok(swept.some((r) => r.step === "dispatch.claim_released"), "the sweep ended the claim");
});

test("W1-T12707 criterion 3: a failed claim sweep still lets the first full pass start", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12707-cmd-`));
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "state", "ledger.ndjson"), "");
  const plan = join(root, "tasks.yaml");
  writeFileSync(plan, "[]\n");
  const signalListeners = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
  t.after(async () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      for (const listener of process.listeners(signal)) if (!signalListeners[signal].includes(listener)) process.removeListener(signal, listener);
    }
    await flush();
    rmSync(root, { recursive: true, force: true });
  });
  const reserver: DispatchClaimReserverAsync = { ...fakeReserver({}), list: async () => { throw new Error("ls-remote exploded"); } };
  const deps: Deps = {
    config: { root, claudeBin: "/bin/true" }, repoRoot: REPO_ROOT,
    startGithubAppRefresh: () => ({ armed: false }),
    applyMemoryPolicy: () => ({ heap_growing_percent: 10 }),
    daemonBoot: async () => ({ env_clean: true, billing_mode: "subscription", node_path: process.execPath, node_version: process.version }),
    checkPause: () => undefined, checkStop: () => undefined, readRunChildMode: () => "off",
    wireSweepWake: () => ({ sleep: async () => "timeout", acknowledge: () => {}, close: () => {} }),
    buildSweepHook: () => async () => {}, buildSweepLightHook: () => async () => {},
    bootClaimReserver: reserver,
  };
  let swept = false;
  const merged = new Set<string>();
  const code = await daemonCommand(["--allow-self-target", "--plan", plan, "--max", "0"], {
    ...deps,
    runDaemon: async (_plan, real) => {
      await runDaemon(fixturePlan(t), {
        claimSweepSettled: real.claimSweepSettled,
        refreshMerged: () => (id) => merged.has(id),
        runOne: runOneFor(merged),
        sweep: async () => { swept = true; },
        sweepLight: async () => {},
        sleep: tick,
        log: () => {},
      }, { max: 1 });
      return { attempted: [], merged: [], stopReason: "stopped" as const, costUsd: 0, ticks: 0 };
    },
  });
  assert.equal(code, 0);
  assert.equal(swept, true, "the full pass started after the sweep failed");
  const rows = (await import("node:fs")).readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n")
    .filter(Boolean).map((line) => JSON.parse(line) as Row);
  assert.equal(rows.filter((r) => r.step === "dispatch.claim_sweep_failed").length, 1, "the failed sweep is ledgered");
});
