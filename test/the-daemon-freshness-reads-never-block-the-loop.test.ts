/**
 * W1-T5282 — THE DAEMON'S OWN FRESHNESS READS NEVER BLOCK THE LOOP.
 *
 * A live CPU profile of the core daemon (2026-10-02) caught a 49 s loop stall whose stack was
 * spawnSync < execFileSync < fetchOriginRetryingRefLock < checkServiceFreshness. #8674 added the
 * awaited fetch but left the daemon's two readers on the sync one: `DaemonDeps.checkFreshness`
 * (read up to three times a tick) and the CI wait's `externalWaitFreshness`. Both are now built by
 * `daemonFreshnessReads`, which awaits `checkServiceFreshnessAsync`, and that fetch is bounded.
 *
 * NO WALL CLOCK. Responsiveness is measured in EVENT-LOOP TURNS: a `setImmediate` chain counts the
 * turns that ran while a read was pending. A read that holds the thread settles before the first
 * turn, so it counts zero; an awaited one counts at least the turns its fake fetch spans.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { test } from "node:test";

import { runDaemon, type DaemonDeps, type DaemonFreshness } from "../src/lib/daemon.js";
import { boundGitCall, GATEWAY_FETCH_TIMEOUT_MS, killAfterGrace, type AsyncGitRunner } from "../src/lib/git-fetch-retry.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { checkServiceFreshnessAsync, daemonFreshnessFromService } from "../src/lib/self-sync.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { daemonFreshnessReads, waitForCiGreen, type RunResult } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

const HEAD = "a".repeat(40);
const MAIN = "b".repeat(40);
/** The turns each fake fetch stays in flight. */
const FETCH_TURNS = 5;

/** A process-wide turn counter: `turn()` reads how many event-loop turns have run since `start()`. */
function loopTurns() {
  let turns = 0;
  let running = false;
  const spin = (): void => {
    if (!running) return;
    turns += 1;
    setImmediate(spin);
  };
  return {
    start: () => {
      running = true;
      setImmediate(spin);
    },
    stop: () => {
      running = false;
    },
    turn: () => turns,
  };
}

/** Event-loop turns that ran while `call` was pending. */
async function turnsWhilePending<T>(call: () => T | Promise<T>): Promise<{ turns: number; value: T }> {
  const counter = loopTurns();
  counter.start();
  try {
    const value = await call();
    return { turns: counter.turn(), value };
  } finally {
    counter.stop();
  }
}

/** Settles after `n` event-loop turns: a fetch in flight that never holds the thread. */
async function afterTurns<T>(n: number, value: T): Promise<T> {
  for (let i = 0; i < n; i++) await flush();
  return value;
}

/** Everything AFTER the fetch, as local git answers it; the sync `fetch` returns at once. */
function localGit(opts: { main?: string; changed?: string } = {}) {
  const main = opts.main ?? HEAD;
  return (args: string[]): string => {
    const line = args.join(" ");
    if (args[0] === "fetch") return "";
    if (line === "rev-parse HEAD") return `${HEAD}\n`;
    if (line === "rev-parse origin/main") return `${main}\n`;
    if (args[0] === "status") return "";
    if (args[0] === "diff") return `${opts.changed ?? "docs/a.md"}\n`;
    if (args[0] === "log") return `\x1e${main}\x1ffeat: x\n\n${opts.changed ?? "docs/a.md"}\n`;
    throw new Error(`unrouted git ${line}`);
  };
}

function plan(ids: string[], kind: string): Plan {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${kind}-`));
  const path = join(dir, "tasks.yaml");
  writeFileSync(
    path,
    ids
      .map((id) => `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`)
      .join(""),
  );
  return loadPlan(path);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const okResult = (id: string): RunResult => ({ taskId: id, runId: `${id}-run`, merged: true, costUsd: 0.5, verdict: "merged" });

test("W1-T5282: the daemon freshness read lets a timer fire while git fetch is in flight", async () => {
  // The reader the daemon is wired with, alone: its fetch spans FETCH_TURNS turns of a live loop.
  const { checkFreshness } = daemonFreshnessReads("/repo", {}, { ignoreReentrancyGuard: true, git: localGit(), gitAsync: () => afterTurns(FETCH_TURNS, "") });
  const alone = await turnsWhilePending(() => checkFreshness());
  assert.ok(alone.turns >= FETCH_TURNS, `the loop kept turning during the fetch (counted ${alone.turns})`);
  assert.deepEqual(alone.value, { stale: false, notStale: { arm: "up_to_date" } });

  // The same reader inside a real daemon tick: a timer armed when the fetch starts fires before the
  // tick acts on the reading.
  const events: string[] = [];
  const counter = loopTurns();
  const fetchTurns: number[] = [];
  const reads = daemonFreshnessReads("/repo", {}, {
    ignoreReentrancyGuard: true,
    git: localGit(),
    gitAsync: async () => {
      events.push("fetch:start");
      fetchTurns.push(counter.turn());
      setTimeout(() => events.push("timer"), 0);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await afterTurns(FETCH_TURNS, "");
      events.push("fetch:settled");
      return "";
    },
  });
  let stops = 0;
  counter.start();
  try {
    const summary = await runDaemon(plan(["A"], "freshness-tick"), {
      refreshMerged: () => () => true,
      runOne: async (id: string) => okResult(id),
      sleep: async () => {},
      checkStop: () => (++stops >= 2 ? "fixture done" : undefined),
      checkFreshness: reads.checkFreshness,
      log: (step: string, extra?: Record<string, unknown>) => {
        if (step === "daemon.freshness_not_stale") events.push(`${step}:${String(extra?.arm)}@${counter.turn() - fetchTurns[0]!}`);
      },
    } as unknown as DaemonDeps);
    assert.equal(summary.stopReason, "stopped");
  } finally {
    counter.stop();
  }
  assert.deepEqual(events.slice(0, 3), ["fetch:start", "timer", "fetch:settled"], "the timer fired while the tick's fetch was in flight");
  const acted = events[3] ?? "";
  assert.match(acted, /^daemon\.freshness_not_stale:up_to_date@\d+$/, "the tick acted on the reading only after it settled");
  assert.ok(Number(acted.split("@")[1]) >= FETCH_TURNS, `the loop turned during the tick's read: ${acted}`);
});

test("W1-T5282: the ci wait freshness read lets a timer fire while git fetch is in flight", async () => {
  const events: string[] = [];
  const counter = loopTurns();
  let fetchStartTurn: number | undefined;
  const { externalWaitFreshness } = daemonFreshnessReads("/repo", {}, {
    ignoreReentrancyGuard: true,
    git: localGit({ main: MAIN, changed: "src/lib/daemon.ts" }),
    gitAsync: async () => {
      fetchStartTurn = counter.turn();
      events.push("fetch:start");
      setTimeout(() => events.push("timer"), 0);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await afterTurns(FETCH_TURNS, "");
      events.push("fetch:settled");
      return "";
    },
  });
  let handoffTurns: number | undefined;
  counter.start();
  let outcome: Awaited<ReturnType<typeof waitForCiGreen>>;
  try {
    outcome = await waitForCiGreen(
      "https://github.com/acme/remudero/pull/1",
      (step) => {
        if (step === "run.freshness_handoff") handoffTurns = counter.turn() - (fetchStartTurn ?? Number.NaN);
      },
      0,
      {
        requiredContexts: () => ["ci"],
        readJson: async (args: string[]) => {
          const request = args.join(" ");
          if (request.includes("/pulls/1")) return { number: 1, state: "open", head: { sha: "c".repeat(40) } };
          if (request.includes("/check-runs")) return { check_runs: [{ name: "ci", status: "in_progress" }] };
          if (request.includes("/status")) return { statuses: [] };
          throw new Error(`unexpected request: ${request}`);
        },
        externalWaitFreshness,
        sleep: async () => {
          throw new Error("a restart-worthy advance must yield before the next poll");
        },
      },
    );
  } finally {
    counter.stop();
  }
  assert.equal(outcome.state, "freshness_handoff");
  assert.equal((outcome as { newSha?: string }).newSha, MAIN, "the awaited reading drives the same handoff the sync one did");
  assert.deepEqual(events, ["fetch:start", "timer", "fetch:settled"], "the timer fired while the wait's fetch was in flight");
  assert.ok((handoffTurns ?? 0) >= FETCH_TURNS, `the loop turned during the wait's read (counted ${handoffTurns})`);
});

test("W1-T5282: a hung freshness fetch ends at its bound and never reads fresh", { timeout: 30_000 }, async () => {
  assert.equal(GATEWAY_FETCH_TIMEOUT_MS, 60_000, "the daemon reuses serve's existing fetch bound (W1-T4229), not a new number");

  // An injected fetch that never settles and ignores its abort signal.
  let seenSignal: AbortSignal | undefined;
  const hung: AsyncGitRunner = (_args, signal) => {
    seenSignal = signal;
    return new Promise<string>(() => {});
  };
  const svc = await checkServiceFreshnessAsync("/repo", {}, { ignoreReentrancyGuard: true, git: localGit(), gitAsync: hung, fetchTimeoutMs: 20 });
  assert.equal(svc.status, "degraded");
  assert.match((svc as { reason: string }).reason, /git fetch origin failed in \/repo: Error: git fetch --quiet origin exceeded its 20ms bound/);
  assert.equal(seenSignal?.aborted, true, "the runner is told to kill its child");
  const reading = daemonFreshnessFromService(svc);
  assert.equal(reading.stale, false);
  assert.equal((reading as { notStale?: { arm: string } }).notStale?.arm, "unassessed", "a failed fetch is unassessed, never up to date");

  // The daemon's own reader, through the same bound.
  const viaDaemon = await daemonFreshnessReads("/repo", {}, { ignoreReentrancyGuard: true, git: localGit(), gitAsync: hung, fetchTimeoutMs: 20 }).checkFreshness();
  assert.deepEqual(viaDaemon, reading);

  // A REAL git whose transport hangs: the default runner's child is killed at the bound.
  const origin = gitRepo({ kind: "hung-fetch" });
  origin.git("remote", "add", "origin", "ssh://rmd-fixture.invalid/never.git");
  origin.git("config", "ssh.variant", "simple");
  origin.git("config", "core.sshCommand", "exec 2>/dev/null; exec sleep 5;:");
  const real = await checkServiceFreshnessAsync(origin.dir, {}, { ignoreReentrancyGuard: true, fetchTimeoutMs: 300 });
  assert.equal(real.status, "degraded");
  assert.match((real as { reason: string }).reason, /exceeded its 300ms bound/);
  assert.equal(daemonFreshnessFromService(real).stale, false);
});

test("W1-T5282: a bounded git call passes a runner's own failure through and clears its bound", async () => {
  await assert.rejects(boundGitCall(async () => { throw new Error("could not read from remote"); }, ["fetch"], 10_000), /could not read from remote/);
  assert.equal(await boundGitCall(async () => "ok", ["fetch"], 10_000), "ok");
});

test("W1-T5282: a fetch child that ignores SIGTERM is sent SIGKILL after its grace; an exited one is left alone", async () => {
  const kills: string[] = [];
  const alive = { exitCode: null, signalCode: null, kill: (signal?: NodeJS.Signals | number) => kills.push(`alive:${String(signal)}`) > 0 };
  const exited = { exitCode: null, signalCode: "SIGTERM" as NodeJS.Signals, kill: (signal?: NodeJS.Signals | number) => kills.push(`exited:${String(signal)}`) > 0 };
  killAfterGrace(alive, 0);
  killAfterGrace(exited, 0);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(kills, ["alive:SIGKILL"]);
});

/** One run of the W1-T126 stale fixture: fresh at both boundaries of tick one, stale from tick two. */
async function staleFixtureRun(awaited: boolean) {
  const steps: string[] = [];
  const merged = new Set<string>();
  let reads = 0;
  const summary = await runDaemon(plan(["A", "B"], "stale-parity"), {
    refreshMerged: () => (id: string) => merged.has(id),
    runOne: async (id: string) => {
      merged.add(id);
      return okResult(id);
    },
    sleep: async () => {},
    log: (step: string) => steps.push(step),
    checkFreshness: () => {
      reads += 1;
      const reading: DaemonFreshness = reads <= 2 ? { stale: false } : { stale: true, oldSha: HEAD, newSha: MAIN };
      return awaited ? afterTurns(2, reading) : reading;
    },
  } as unknown as DaemonDeps);
  return { summary, steps };
}

const ADVANCE: Extract<DaemonFreshness, { stale: true }> = {
  stale: true,
  oldSha: HEAD,
  newSha: MAIN,
  installNeeded: true,
  changes: [{ sha: MAIN, files: ["src/lib/daemon.ts"] }],
};

/** W1-T5308's lane pool: A and B held open; the dispatch ticker reads freshness while they run. */
function lanePool(awaited: boolean, readTurns = 1, max = 3) {
  const steps: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const started: string[] = [];
  const ready = deferred<void>();
  const gates = new Map(["A", "B"].map((id) => [id, deferred<void>()]));
  const sleeps: Array<ReturnType<typeof deferred<void>>> = [];
  let advance: DaemonFreshness = { stale: false };
  let stop = false;
  let reads = 0;
  const run = runDaemon(plan(["A", "B", "C"], "lane-pool-await"), {
    refreshMerged: () => () => false,
    checkStop: () => (stop ? "fixture cleanup" : undefined),
    checkFreshness: () => {
      reads += 1;
      const reading = advance;
      return awaited ? afterTurns(readTurns, reading) : reading;
    },
    sleep: () => {
      if (stop) return Promise.resolve();
      const sleep = deferred<void>();
      sleeps.push(sleep);
      return sleep.promise;
    },
    sweepLight: async () => {},
    runInstall: () => steps.push({ step: "install" }),
    log: (step: string, extra?: Record<string, unknown>) => steps.push({ step, extra }),
    runOne: async (id: string) => {
      started.push(id);
      if (started.length === 2) ready.resolve();
      await gates.get(id)?.promise;
      return okResult(id);
    },
  } as unknown as DaemonDeps, { laneCount: 2, pollIntervalMs: 10, max });
  return {
    steps,
    started,
    reads: () => reads,
    run,
    ready: ready.promise,
    advance: (value: DaemonFreshness = ADVANCE) => {
      advance = value;
    },
    release: (id: string) => gates.get(id)?.resolve(),
    wake: () => sleeps.shift()?.resolve(),
    finish: async () => {
      stop = true;
      for (const gate of gates.values()) gate.resolve();
      for (let i = 0; i < 40; i++) {
        for (const sleep of sleeps.splice(0)) sleep.resolve();
        await flush();
      }
      return run;
    },
  };
}

async function lanePoolRestart(awaited: boolean) {
  const h = lanePool(awaited);
  await h.ready;
  h.advance();
  h.wake();
  for (let i = 0; i < 6; i++) await flush();
  const decidedWhileInFlight = h.steps.some((row) => row.step === "daemon.freshness_decision" && row.extra?.action === "restart");
  h.release("B");
  for (let i = 0; i < 3; i++) await flush();
  const startedBeforeA = [...h.started];
  h.release("A");
  const summary = await h.run;
  await h.finish();
  return { summary, decidedWhileInFlight, startedBeforeA, steps: h.steps.map((row) => row.step).filter((step) => step !== "daemon.alive") };
}

test("W1-T5282: the daemon stops for an awaited stale reading exactly as for a sync one", async () => {
  // At the top of a tick: the W1-T126 stale fixture, sync and awaited, step for step.
  const sync = await staleFixtureRun(false);
  const awaited = await staleFixtureRun(true);
  assert.equal(sync.summary.stopReason, "stale");
  assert.deepEqual(awaited.summary, sync.summary);
  assert.deepEqual(awaited.steps, sync.steps, "the awaited reading drives the same rows in the same order");
  assert.ok(awaited.steps.includes("daemon_selfrestart_for_freshness"));

  // While lanes are in flight: the dispatch ticker's reading closes refill and the pool settles before the exit.
  const poolSync = await lanePoolRestart(false);
  const poolAwaited = await lanePoolRestart(true);
  assert.equal(poolSync.summary.stopReason, "stale");
  assert.equal(poolAwaited.decidedWhileInFlight, true, "the ticker's awaited reading is acted on while lanes run");
  assert.deepEqual(poolAwaited.startedBeforeA, ["A", "B"], "a restart closes refill before the pool settles");
  assert.deepEqual(poolAwaited.summary, poolSync.summary);
  assert.deepEqual(poolAwaited.steps, poolSync.steps);
});

test("W1-T5282: an awaited refill reads this tick's settled reading and starts no fetch of its own", async () => {
  const h = lanePool(true);
  await h.ready;
  const readsAtAdmission = h.reads();
  h.release("B");
  for (let i = 0; i < 3; i++) await flush();
  assert.deepEqual(h.started, ["A", "B", "C"], "the admission reading was fresh, so B's freed lane refills");
  assert.equal(h.reads(), readsAtAdmission, "a synchronous refill cannot await a fetch, so it never starts one");
  h.release("A");
  assert.equal((await h.run).stopReason, "max_reached");
  await h.finish();
});

test("W1-T5282: a dispatch reading that settles after its pool has settled is not acted on", async () => {
  const h = lanePool(true, 40, 2);
  await h.ready;
  h.advance();
  h.wake(); // the ticker starts a read that outlives both lanes
  await flush();
  h.release("A");
  h.release("B");
  const summary = await h.run;
  for (let i = 0; i < 45; i++) await flush();
  assert.equal(summary.stopReason, "max_reached");
  assert.equal(h.steps.some((row) => row.step === "daemon.freshness_decision"), false, "a late reading belongs to no dispatch");
  await h.finish();
});
