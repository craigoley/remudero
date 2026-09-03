/**
 * W1-T2741 — terminal GitHub checks are a settlement stream, not one full-board sweep each.
 *
 * The webhook route already coalesces durable state, but the daemon-side watcher currently turns
 * every distinct delivery id into an immediate edge. These tests pin the missing time dimension:
 * high-fanout check/status edges settle on one trailing wake while structural PR/review changes
 * remain immediate and the ordinary poll deadline stays the starvation bound.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  consumeSweepWakeMarker,
  readSweepWakeMarker,
  sweepWakeMarkerPath,
  type SweepWakeMarker,
  type SweepWakeTimerDeps,
  wireSweepWakeToDaemon,
  writeSweepWakeMarkerAtomic,
} from "../src/lib/github-event-wake.js";
import { loadPolicy } from "../src/lib/policy.js";
import { daemonCommand } from "../src/run-task.js";

const REPOSITORY = "craigoley/remudero";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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

function harness(root: string, timers: ManualTimers, logs: Array<{ step: string; extra?: Record<string, unknown> }> = []) {
  const watcher = new EventEmitter() as FSWatcher;
  watcher.close = () => {};
  let notify: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
  const wiring = wireSweepWakeToDaemon(
    root,
    (step, extra) => logs.push({ step, extra }),
    ((_dir: string, listener: (eventType: string, filename: string | Buffer | null) => void) => {
      notify = listener;
      return watcher;
    }) as typeof import("node:fs").watch,
    { checkSettleMs: 10_000, timers, now: () => timers.nowMs },
  );
  return {
    wiring,
    deliver(record: SweepWakeMarker) {
      writeSweepWakeMarkerAtomic(sweepWakeMarkerPath(root), record);
      notify?.("rename", "SWEEP_WAKE_REQUESTED");
    },
  };
}

test("many terminal check/status deliveries inside the settle window produce one trailing wake and one bounded fact", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-check-settle-"));
  const timers = new ManualTimers();
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const { wiring, deliver } = harness(root, timers, logs);
  try {
    let result: "wake" | "timeout" | undefined;
    const waiting = wiring.sleep(60_000).then((value) => (result = value));

    deliver(marker("check-a", "check_run", "completed", timers.nowMs));
    await Promise.resolve();
    assert.equal(result, undefined, "the first terminal check must not wake the whole-board sweep immediately");
    timers.advance(9_000);
    deliver(marker("status-b", "status", undefined, timers.nowMs));
    timers.advance(9_000);
    deliver(marker("check-c", "check_run", "completed", timers.nowMs));
    timers.advance(9_999);
    await Promise.resolve();
    assert.equal(result, undefined, "each new high-fanout edge moves the trailing settle boundary");

    timers.advance(1);
    await waiting;
    assert.equal(result, "wake");
    assert.deepEqual(
      logs.filter((entry) => entry.step === "github.wake.check_settled"),
      [{
        step: "github.wake.check_settled",
        extra: { event_class: "check/status", coalesced_edges: 3, settle_ms: 10_000 },
      }],
    );
    assert.equal(readSweepWakeMarker(sweepWakeMarkerPath(root))?.deliveryId, "check-c");
    wiring.acknowledge();
    assert.equal(consumeSweepWakeMarker(sweepWakeMarkerPath(root)), undefined);
  } finally {
    wiring.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("pull-request structural changes and submitted reviews still interrupt the poll immediately", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-structural-wake-"));
  const timers = new ManualTimers();
  const { wiring, deliver } = harness(root, timers);
  try {
    const first = wiring.sleep(60_000);
    deliver(marker("pr-sync", "pull_request", "synchronize", timers.nowMs));
    assert.equal(await first, "wake");
    wiring.acknowledge();

    const second = wiring.sleep(60_000);
    deliver(marker("review-submit", "pull_request_review", "submitted", timers.nowMs));
    assert.equal(await second, "wake");
    wiring.acknowledge();
  } finally {
    wiring.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a continuous terminal-check stream cannot postpone reconciliation beyond the ordinary poll deadline", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-check-starvation-"));
  const timers = new ManualTimers();
  const { wiring, deliver } = harness(root, timers);
  try {
    const waiting = wiring.sleep(60_000);
    deliver(marker("check-0", "check_run", "completed", timers.nowMs));
    for (let i = 1; i <= 6; i++) {
      timers.advance(9_000);
      deliver(marker(`check-${i}`, "check_run", "completed", timers.nowMs));
    }
    timers.advance(6_000);
    assert.equal(await waiting, "timeout", "the original poll timer, not the trailing settle timer, wins at 60 seconds");
    assert.ok(readSweepWakeMarker(sweepWakeMarkerPath(root)), "the timed poll has not claimed the durable intent yet");
    wiring.acknowledge();
    assert.equal(consumeSweepWakeMarker(sweepWakeMarkerPath(root)), undefined);
  } finally {
    wiring.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a settled wake stays durable through a declined pass and daemon restart until an accepted sweep acknowledges it", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-check-durable-"));
  const timers = new ManualTimers();
  const first = harness(root, timers);
  try {
    const waiting = first.wiring.sleep(60_000);
    first.deliver(marker("survives-stop-pause-or-busy-gate", "check_run", "completed", timers.nowMs));
    timers.advance(10_000);
    assert.equal(await waiting, "wake");
    assert.ok(readSweepWakeMarker(sweepWakeMarkerPath(root)), "an edge is not an acknowledgement");
    first.wiring.close();

    const restarted = harness(root, timers);
    try {
      assert.equal(await restarted.wiring.sleep(60_000), "wake", "the durable boot level re-offers the unacknowledged work");
      assert.ok(readSweepWakeMarker(sweepWakeMarkerPath(root)));
      restarted.wiring.acknowledge();
      assert.equal(consumeSweepWakeMarker(sweepWakeMarkerPath(root)), undefined);
    } finally {
      restarted.wiring.close();
    }
  } finally {
    first.wiring.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the check settle duration is bounded policy data with the measured ten-second default", () => {
  const policy = loadPolicy(join(REPO_ROOT, "plan", "policy.yaml"));
  assert.equal(policy.values.githubEventWake.checkSettleMs, 10_000);
  assert.deepEqual(policy.bounds["githubEventWake.checkSettleMs"], { min: 1_000, max: 60_000 });
  assert.equal(policy.origin["githubEventWake.checkSettleMs"].kind, "net-new");
});

test("the production daemon command passes the committed settle duration into the wake wiring", async () => {
  const home = mkdtempSync(join(tmpdir(), "rmd-check-settle-wiring-"));
  const root = join(home, "Remudero");
  const planPath = join(home, "tasks.yaml");
  const oldHome = process.env.HOME;
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  writeFileSync(planPath, "[]\n");
  utimesSync(home, new Date(), new Date());
  let checkSettleMs: number | undefined;
  process.env.HOME = home;
  try {
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      wireSweepWake: ((_root, _log, _watch, options) => {
        checkSettleMs = options?.checkSettleMs;
        return { sleep: async () => "timeout", acknowledge: () => {}, close: () => {} };
      }) as typeof wireSweepWakeToDaemon,
      runDaemon: async () => ({ attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 }),
    });
    assert.equal(code, 0);
    assert.equal(checkSettleMs, 10_000);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});
