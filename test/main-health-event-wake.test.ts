import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runDaemon } from "../src/lib/daemon.js";
import {
  sweepWakeMarkerPath,
  type SweepWakeMarker,
  type SweepWakeTimerDeps,
  wireSweepWakeToDaemon,
  writeSweepWakeMarkerAtomic,
} from "../src/lib/github-event-wake.js";
import { buildMainHealthRung } from "../src/lib/main-health-rung.js";
import type { GhApiFetcher } from "../src/lib/open-prs-rest.js";
import { loadPlan } from "../src/lib/plan.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPOSITORY = "craigoley/remudero";

class ManualTimers implements SweepWakeTimerDeps {
  nowMs = 0;
  #nextId = 1;
  #timers = new Map<number, { at: number; callback: () => void }>();

  setTimer(callback: () => void, ms: number): unknown {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.nowMs + ms, callback });
    return id;
  }

  clearTimer(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  advance(ms: number): void {
    const target = this.nowMs + ms;
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      this.nowMs = due[1].at;
      this.#timers.delete(due[0]);
      due[1].callback();
    }
    this.nowMs = target;
  }
}

function marker(deliveryId: string, event: string, action: string | undefined, nowMs: number): SweepWakeMarker {
  return { deliveryId, event, action, repository: REPOSITORY, receivedAtIso: new Date(nowMs).toISOString() };
}

test("W1-T2787: settled check bursts invoke main health, while structural PR wakes remain wake-only", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}main-health-event-`));
  const timers = new ManualTimers();
  const watcher = new EventEmitter() as FSWatcher;
  watcher.close = () => {};
  let notify: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
  let observations = 0;
  const wiring = wireSweepWakeToDaemon(
    root,
    () => {},
    ((_dir: string, listener: (eventType: string, filename: string | Buffer | null) => void) => {
      notify = listener;
      return watcher;
    }) as typeof import("node:fs").watch,
    {
      checkSettleMs: 10_000,
      timers,
      now: () => timers.nowMs,
      onCheckBurstSettled: () => {
        observations++;
      },
    },
  );
  const deliver = (record: SweepWakeMarker) => {
    writeSweepWakeMarkerAtomic(sweepWakeMarkerPath(root), record);
    notify?.("rename", "SWEEP_WAKE_REQUESTED");
  };

  try {
    deliver(marker("check-a", "check_run", "completed", timers.nowMs));
    deliver(marker("status-b", "status", undefined, timers.nowMs));
    timers.advance(9_999);
    assert.equal(observations, 0, "a check burst is observed only after its existing settle boundary");
    timers.advance(1);
    assert.equal(observations, 1, "the whole settled burst produces one independent observation");

    wiring.acknowledge();
    deliver(marker("pr-sync", "pull_request", "synchronize", timers.nowMs));
    assert.equal(observations, 1, "a structural PR wake does not spend a main-health read");
  } finally {
    wiring.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2787: main health still runs when the awakened full sweep refuses an abandoned predecessor", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}main-health-concurrent-sweep-`));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, "- id: W1-T2787\n  title: event health\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  const timers = new ManualTimers();
  const watcher = new EventEmitter() as FSWatcher;
  watcher.close = () => {};
  let notify: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
  let observations = 0;
  const steps: string[] = [];
  let releaseSweep: () => void = () => {};
  let reportSweepStarted: () => void = () => {};
  let reportSweepAbandoned: () => void = () => {};
  const sweepStarted = new Promise<void>((resolve) => { reportSweepStarted = resolve; });
  const sweepAbandoned = new Promise<void>((resolve) => { reportSweepAbandoned = resolve; });
  const heldSweep = new Promise<void>((resolve) => { releaseSweep = resolve; });
  const wiring = wireSweepWakeToDaemon(
    root,
    () => {},
    ((_dir: string, listener: (eventType: string, filename: string | Buffer | null) => void) => {
      notify = listener;
      return watcher;
    }) as typeof import("node:fs").watch,
    {
      checkSettleMs: 10_000,
      timers,
      now: () => timers.nowMs,
      onCheckBurstSettled: () => { observations++; },
    },
  );

  try {
    const running = runDaemon(
      loadPlan(planPath),
      {
        refreshMerged: () => () => true,
        runOne: async () => { throw new Error("the merged fixture task must never dispatch"); },
        sweep: async () => {
          reportSweepStarted();
          await heldSweep;
        },
        sweepLight: async () => {},
        checkStop: () => steps.includes("daemon.sweep.skipped_concurrent") ? "proof complete" : undefined,
        sleep: async () => new Promise<void>((resolve) => setTimeout(resolve, 1)),
        sleepUntilSweepWake: (ms) =>
          steps.includes("daemon.sweep.skipped_concurrent") ? Promise.resolve("timeout") : wiring.sleep(ms),
        acknowledgeSweepWake: wiring.acknowledge,
        log: (step) => {
          steps.push(step);
          if (step === "daemon.sweep.abandoned") reportSweepAbandoned();
        },
      },
      { pollIntervalMs: 60_000, sweepWallClockBoundMs: 5 },
    );
    await sweepStarted;
    await sweepAbandoned;

    writeSweepWakeMarkerAtomic(
      sweepWakeMarkerPath(root),
      marker("while-abandoned", "check_run", "completed", timers.nowMs),
    );
    notify?.("rename", "SWEEP_WAKE_REQUESTED");
    timers.advance(10_000);

    const timeout = new Promise<never>((_, reject) => {
      const handle = setTimeout(() => reject(new Error(`daemon did not refuse the concurrent wake: ${steps.join(",")}`)), 2_000);
      handle.unref();
    });
    const summary = await Promise.race([running, timeout]);
    assert.equal(summary.stopReason, "stopped");
    assert.equal(observations, 1, "main health runs at settlement before sweep admission is known");
    assert.ok(steps.includes("daemon.sweep.skipped_concurrent"), "the awakened ordinary sweep really was refused");
  } finally {
    releaseSweep();
    wiring.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2787: the event callback and immediate full sweep share one fresh main-health read", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}main-health-fresh-`));
  let nowMs = 1_000;
  let commitReads = 0;
  const fetch = ((args: string[]) => {
    const path = args[1] ?? "";
    if (path === "repos/craigoley/remudero") return { default_branch: "main" };
    if (path === "repos/craigoley/remudero/commits/main") {
      commitReads++;
      return { sha: "1111111111111111111111111111111111111111" };
    }
    if (path.endsWith("/check-runs?per_page=100")) {
      return { check_runs: [{ name: "ci-gate", status: "completed", conclusion: "success" }] };
    }
    if (path.endsWith("/status")) return { statuses: [] };
    throw new Error(`unrouted path: ${path}`);
  }) as GhApiFetcher;
  const rung = buildMainHealthRung("craigoley", "remudero", {
    fetch,
    issues: { create: () => "unused", listOpen: () => [], closeWithComment: () => {} },
    ledgerPath: join(root, "ledger.ndjson"),
    runId: "DAEMON-W1-T2787",
    log: () => {},
    freshMs: 10_000,
    now: () => nowMs,
  });

  try {
    await rung();
    await rung();
    assert.equal(commitReads, 1, "an immediate ordinary sweep reuses the settled-event observation");

    nowMs += 10_001;
    await rung();
    assert.equal(commitReads, 2, "the cache is only brief; a later ordinary sweep reads main again");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2787: a failed observation is not cached and does not escape", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}main-health-retry-`));
  let reads = 0;
  const logs: string[] = [];
  const fetch = ((args: string[]) => {
    const path = args[1] ?? "";
    if (path === "repos/craigoley/remudero") {
      reads++;
      if (reads === 1) throw new Error("transient GitHub failure");
      return { default_branch: "main" };
    }
    if (path === "repos/craigoley/remudero/commits/main") {
      return { sha: "2222222222222222222222222222222222222222" };
    }
    if (path.endsWith("/check-runs?per_page=100")) {
      return { check_runs: [{ name: "ci-gate", status: "completed", conclusion: "success" }] };
    }
    if (path.endsWith("/status")) return { statuses: [] };
    throw new Error(`unrouted path: ${path}`);
  }) as GhApiFetcher;
  const rung = buildMainHealthRung("craigoley", "remudero", {
    fetch,
    issues: { create: () => "unused", listOpen: () => [], closeWithComment: () => {} },
    ledgerPath: join(root, "ledger.ndjson"),
    runId: "DAEMON-W1-T2787-RETRY",
    log: (step) => logs.push(step),
    freshMs: 10_000,
    now: () => 1_000,
  });

  try {
    const eventObservation = rung();
    const concurrentSweepObservation = rung();
    await assert.doesNotReject(Promise.all([eventObservation, concurrentSweepObservation]));
    assert.equal(reads, 1, "a concurrent sweep joins the failing event observation instead of duplicating it");

    await assert.doesNotReject(rung());
    assert.equal(reads, 2, "the ordinary path retries immediately after the joined failure settles");
    assert.deepEqual(logs.filter((step) => step === "main.health.error"), ["main.health.error"]);
    assert.deepEqual(logs.filter((step) => step === "main.health.observed"), ["main.health.observed"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2787: production composes one observer into both the event and full-sweep paths", () => {
  const source = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  const observer = source.indexOf("const mainHealthRung = buildMainHealthRung(");
  const wake = source.indexOf("const githubEventWake =", observer);
  const daemon = source.indexOf("runDaemon(", wake);
  const wiring = source.slice(observer, daemon);

  assert.ok(observer > 0, "the observer is built once, before wake wiring and daemon deps");
  assert.match(wiring, /onCheckBurstSettled:\s*\(\)\s*=>\s*void mainHealthRung\(\)/);
  assert.match(wiring, /buildSweepHook\([\s\S]*?mainHealthRung[\s\S]*?\)/);
});
