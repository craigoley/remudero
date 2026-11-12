/**
 * W1-T12238: the dispatch-claim sweep of a start delays the first dispatch only, not the first review.
 *
 * MEASURED 2026-11-04 to 2026-11-11 on the core instance: 45 starts spent a median of 18 s, and up to 90 s, between
 * `dispatch.lifetime_history_loaded` and `daemon.start`. The sweep ran its git reads on the daemon loop there. It now
 * starts at the same place, runs off the loop, and only the first dispatch selection waits for it.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate as flush } from "node:timers/promises";
import { runDaemon } from "#src/lib/daemon.js";
import {
  bootSweepDispatchClaims, bootSweepDispatchClaimsAsync, dispatchClaimRef, gitClaimRunnerAsync, gitDispatchClaimReserverAsync,
  type DispatchClaimReserverAsync,
} from "#src/lib/dispatch-claim.js";
import { loadPlan } from "#src/lib/plan.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import {
  anchorMessage, BRANCH, DEAD_PID, fakeReserver, gitRemote, LOCAL, MINT_ISO, orphanRunRows, orphanVerdicts, OTHER_HOST,
  RUN_ID, sweepRows, TASK,
} from "#test/helpers/restart-orphan.js";
import { daemonCommand } from "#test/helpers/run-task-daemon.js";

type Deps = NonNullable<Parameters<typeof daemonCommand>[1]>;
type Row = Record<string, unknown>;
const stopped = { attempted: [], merged: [], stopReason: "stopped" as const, costUsd: 0, ticks: 0 };
const ADOPTED = "W1-T12238-adopted";
const REPLACED = "W1-T12238-replaced";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** A daemon command over a fresh root, booted as the boot-cleanup tests boot it. */
function commandFixture(t: TestContext, seed: Row[] = []) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}claim-sweep-`));
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "state", "ledger.ndjson"), seed.map((row) => `${JSON.stringify(row)}\n`).join(""));
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
  const deps: Deps = {
    config: { root, claudeBin: "/bin/true" }, repoRoot: REPO_ROOT,
    startGithubAppRefresh: () => ({ armed: false }),
    applyMemoryPolicy: () => ({ heap_growing_percent: 10 }),
    daemonBoot: async () => ({ env_clean: true, billing_mode: "subscription", node_path: process.execPath, node_version: process.version }),
    checkPause: () => undefined, checkStop: () => undefined,
    readRunChildMode: () => "off",
    wireSweepWake: () => ({ sleep: async () => "timeout", acknowledge: () => {}, close: () => {} }),
    buildSweepHook: () => async () => {}, buildSweepLightHook: () => async () => {},
  };
  return {
    root,
    run: (overrides: Deps) => daemonCommand(["--allow-self-target", "--plan", plan, "--max", "0"], { ...deps, ...overrides }),
    rows: (): Row[] => readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as Row),
  };
}

test("W1-T12238 criterion 1: daemonCommand writes daemon.start while the claim sweep is still open", async (t) => {
  const f = commandFixture(t);
  const hold = deferred();
  const fallback = setTimeout(hold.resolve, 5_000);
  t.after(() => clearTimeout(fallback));
  let listed = false;
  const reserver: DispatchClaimReserverAsync = {
    ...fakeReserver({ [TASK]: anchorMessage(DEAD_PID, OTHER_HOST, MINT_ISO) }),
    list: async () => {
      listed = true;
      await hold.promise;
      return [TASK];
    },
  };
  let seenAtLoop: Row[] = [];
  const code = await f.run({
    bootClaimReserver: reserver,
    runDaemon: async (_plan, deps) => {
      seenAtLoop = f.rows();
      hold.resolve();
      await deps.claimSweepSettled;
      return stopped;
    },
  });
  assert.equal(code, 0);
  assert.equal(listed, true, "the sweep started before the loop");
  assert.ok(seenAtLoop.some((r) => r.step === "daemon.start"), "daemon.start is written before the loop starts");
  assert.equal(sweepRows(seenAtLoop).length, 0, "the sweep had not settled when the loop started");
  const rows = f.rows();
  const start = rows.findIndex((r) => r.step === "daemon.start");
  const released = rows.findIndex((r) => r.step === "dispatch.claim_released" && r.surface === "boot-sweep");
  assert.ok(start >= 0 && released > start, `daemon.start (${start}) precedes the sweep's row (${released})`);
});

const PLAN_YAML = "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n";

function fixturePlan(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}claim-sweep-plan-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "tasks.yaml"), PLAN_YAML);
  return loadPlan(join(dir, "tasks.yaml"));
}

async function loopUntil(done: () => boolean, turns = 2_000): Promise<boolean> {
  for (let i = 0; i < turns && !done(); i++) await flush();
  return done();
}

test("W1-T12238 criterion 2: the boot review and the first sweep start while the claim sweep is open", async (t) => {
  const hold = deferred();
  const events: string[] = [];
  const merged = new Set<string>();
  const loop = runDaemon(fixturePlan(t), {
    claimSweepSettled: hold.promise,
    refreshMerged: () => (id) => merged.has(id),
    runOne: async (id): Promise<{ taskId: string; runId: string; merged: boolean; costUsd: number; verdict: "merged" }> => {
      events.push(`run:${id}`);
      merged.add(id);
      return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" };
    },
    sweep: async () => { events.push("sweep"); },
    sweepLight: async () => { events.push("review"); },
    sleep: async () => {},
    log: () => {},
  }, { max: 1 });
  const started = await loopUntil(() => events.includes("sweep") && events.includes("review"));
  assert.equal(started, true, `the boot review and the first sweep started (saw ${events.join(", ")})`);
  assert.deepEqual(events.filter((e) => e.startsWith("run:")), [], "nothing ran yet");
  hold.resolve();
  const summary = await loop;
  assert.deepEqual(summary.merged, ["A"]);
});

test("W1-T12238 criterion 3: the first dispatch selection waits for the claim sweep, and no run starts before it", async (t) => {
  const hold = deferred();
  let sweepOpen = true;
  const runsWhileOpen: string[] = [];
  const landed: boolean[] = [];
  const merged = new Set<string>();
  const loop = runDaemon(fixturePlan(t), {
    claimSweepSettled: hold.promise.then(() => { sweepOpen = false; }),
    releaseLandedClaims: async () => { landed.push(sweepOpen); },
    refreshMerged: () => (id) => merged.has(id),
    runOne: async (id): Promise<{ taskId: string; runId: string; merged: boolean; costUsd: number; verdict: "merged" }> => {
      if (sweepOpen) runsWhileOpen.push(id);
      merged.add(id);
      return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" };
    },
    sweep: async () => {},
    sweepLight: async () => {},
    sleep: async () => {},
    log: () => {},
  }, { max: 1 });
  await loopUntil(() => runsWhileOpen.length > 0, 500);
  assert.deepEqual(runsWhileOpen, [], "no run started while the claim sweep was open");
  hold.resolve();
  const summary = await loop;
  assert.deepEqual(summary.attempted, ["A"], "the task runs once the sweep has settled");
  assert.deepEqual(runsWhileOpen, []);
  assert.ok(landed.length > 0, "the tick's sweep of merged claims ran");
  assert.deepEqual(landed.filter((open) => open), [], "the tick's sweep of merged claims also waits for the boot sweep");
});

/** Claims of every arm: a restart orphan, a live run child the daemon adopted, and another host's claim. */
function sweepClaims(): Record<string, string> {
  return {
    [TASK]: anchorMessage(DEAD_PID, LOCAL, MINT_ISO),
    [ADOPTED]: anchorMessage(process.pid, LOCAL, MINT_ISO),
    [REPLACED]: anchorMessage(DEAD_PID, OTHER_HOST, MINT_ISO),
  };
}

function sweepSeed(): Row[] {
  const adoptedRun = `${ADOPTED}-946684799000`;
  return [
    ...orphanRunRows(),
    ...orphanRunRows(ADOPTED, adoptedRun),
    { ts: "2000-01-01T00:00:00.700Z", run_id: "daemon-old", step: "dispatch.claim", host: OTHER_HOST, actor: "daemon",
      ref: dispatchClaimRef(REPLACED), outcome: "created" },
  ];
}

function sweepState(t: TestContext): { stateDir: string; rows: () => Row[]; log: (step: string, fields: Row) => void } {
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}claim-sweep-state-`));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const ledger = join(stateDir, "ledger.ndjson");
  writeFileSync(ledger, sweepSeed().map((row) => `${JSON.stringify(row)}\n`).join(""));
  const written: Row[] = [];
  return { stateDir, rows: () => written, log: (step, fields) => { written.push({ step, ...fields }); } };
}

test("W1-T12238 criterion 4: the awaited sweep judges each claim as the sync sweep does, and an adopted child keeps its claim", async (t) => {
  const lock = { localHost: LOCAL, lockHeldSinceMs: Date.parse("2026-11-11T00:00:00.000Z"), lockHeldSinceIso: "2026-11-11T00:00:00.000Z" };
  const heads = { [BRANCH]: `${"a".repeat(40)}` };
  const syncState = sweepState(t);
  const syncReserver = fakeReserver(sweepClaims(), { heads });
  const syncSwept = bootSweepDispatchClaims(syncReserver, { ...lock, stateDir: syncState.stateDir, log: syncState.log });
  const asyncState = sweepState(t);
  const asyncReserver = fakeReserver(sweepClaims(), { heads });
  const asyncSwept = await bootSweepDispatchClaimsAsync(asyncReserver, { ...lock, stateDir: asyncState.stateDir, log: asyncState.log });

  assert.deepEqual(asyncSwept, syncSwept, "the same decisions");
  assert.deepEqual(asyncState.rows(), syncState.rows(), "the same dispatch.claim_released and verdict rows");
  assert.deepEqual(asyncReserver.dropped, syncReserver.dropped);
  const arms = Object.fromEntries(asyncSwept.map((c) => [c.taskId, [c.arm, c.dropped]]));
  assert.deepEqual(arms, {
    [TASK]: ["dead-claimant", true],
    [ADOPTED]: ["operator", false],
    [REPLACED]: ["dead-claimant", true],
  });
  assert.ok(!asyncReserver.dropped.includes(ADOPTED), "a live run child's claim is kept");
  const verdicts = orphanVerdicts(asyncState.rows());
  assert.deepEqual(verdicts.map((v) => [v.run_id, v.head_sha]), [[RUN_ID, heads[BRANCH]]], "only the orphan's run is ended");
});

test("W1-T12238 criterion 4: an adopted child keeps its claim when the sweep settles after the daemon is running", async (t) => {
  const f = commandFixture(t, sweepSeed());
  const hold = deferred();
  const fallback = setTimeout(hold.resolve, 5_000);
  t.after(() => clearTimeout(fallback));
  const fake = fakeReserver(sweepClaims());
  const reserver: DispatchClaimReserverAsync = { ...fake, list: async () => { await hold.promise; return fake.list!(); } };
  const code = await f.run({
    bootClaimReserver: reserver,
    runDaemon: async (_plan, deps) => {
      hold.resolve();
      await deps.claimSweepSettled;
      return stopped;
    },
  });
  assert.equal(code, 0);
  const adopted = sweepRows(f.rows()).find((r) => r.ref === dispatchClaimRef(ADOPTED));
  assert.equal(adopted?.arm, "operator");
  assert.equal(adopted?.dropped, false);
  assert.ok(!fake.dropped.includes(ADOPTED), "the adopted child's claim is still held");
});

test("W1-T12238 criterion 5: a failed claim sweep is ledgered, the promise resolves, and dispatch goes on", async (t) => {
  const f = commandFixture(t);
  const reserver: DispatchClaimReserverAsync = { ...fakeReserver({}), list: async () => { throw new Error("ls-remote exploded"); } };
  let settled = false;
  const code = await f.run({
    bootClaimReserver: reserver,
    runDaemon: async (_plan, deps) => {
      await deps.claimSweepSettled;
      settled = true;
      return stopped;
    },
  });
  assert.equal(code, 0);
  assert.equal(settled, true, "the loop's wait resolved");
  const failed = f.rows().filter((r) => r.step === "dispatch.claim_sweep_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.surface, "boot-sweep");
  assert.match(String(failed[0]!.error), /ls-remote exploded/);

  const merged = new Set<string>();
  const summary = await runDaemon(fixturePlan(t), {
    claimSweepSettled: Promise.resolve(),
    refreshMerged: () => (id) => merged.has(id),
    runOne: async (id): Promise<{ taskId: string; runId: string; merged: boolean; costUsd: number; verdict: "merged" }> => { merged.add(id); return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" }; },
    sleep: async () => {},
    log: () => {},
  }, { max: 1 });
  assert.deepEqual(summary.attempted, ["A"], "a settled sweep holds no dispatch");
});

test("W1-T12238 criterion 6: the claim sweep does its git reads off the daemon loop", async (t) => {
  const remote = gitRemote(t);
  const state = sweepState(t);
  const lock = { localHost: LOCAL, lockHeldSinceMs: Date.parse("2026-11-11T00:00:00.000Z"), lockHeldSinceIso: "2026-11-11T00:00:00.000Z" };
  let turns = 0;
  let sweeping = true;
  const ticker = (async () => { while (sweeping) { await flush(); turns++; } })();
  const reserver = gitDispatchClaimReserverAsync({ run: gitClaimRunnerAsync(remote.client.dir) });
  const swept = await bootSweepDispatchClaimsAsync(reserver, { ...lock, stateDir: state.stateDir, log: state.log });
  sweeping = false;
  await ticker;
  assert.ok(turns > 0, `the loop turned while the sweep read git (saw ${turns} turns)`);
  assert.deepEqual(swept.map((c) => [c.taskId, c.arm, c.dropped]), [[TASK, "dead-claimant", true]]);
  assert.equal(remote.claimTip(), "", "the orphan's claim was dropped on the remote");
  assert.deepEqual(orphanVerdicts(state.rows()).map((v) => v.head_sha), [remote.head], "the run's head was read off the loop");
});

test("W1-T12238 production path: rmd daemon sweeps the target's remote through its own git reserver", async (t) => {
  const remote = gitRemote(t);
  const f = commandFixture(t, orphanRunRows());
  const clone = spawnSync("git", ["clone", "-q", remote.remote.dir, join(f.root, "repos", "remudero")], { encoding: "utf8" });
  assert.equal(clone.status, 0, clone.stderr);
  let openAtLoop: boolean | undefined;
  const code = await f.run({
    runDaemon: async (_plan, deps) => {
      openAtLoop = sweepRows(f.rows()).length === 0;
      await deps.claimSweepSettled;
      return stopped;
    },
  });
  assert.equal(code, 0);
  assert.equal(f.rows().find((r) => r.step === "daemon.start")?.repo, "remudero", "fixture: the reserver reads repos/remudero");
  assert.equal(typeof openAtLoop, "boolean");
  const rows = f.rows();
  assert.deepEqual(sweepRows(rows).map((r) => [r.ref, r.arm, r.dropped]), [[dispatchClaimRef(TASK), "dead-claimant", true]]);
  assert.deepEqual(orphanVerdicts(rows).map((v) => [v.run_id, v.head_sha]), [[RUN_ID, remote.head]]);
  assert.equal(remote.claimTip(), "", "the claim is gone from the remote");
});
