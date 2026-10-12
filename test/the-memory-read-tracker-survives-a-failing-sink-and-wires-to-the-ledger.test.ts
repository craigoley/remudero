import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Clock } from "../src/lib/clock.js";
import { runDaemon } from "../src/lib/daemon.js";
import { createMemoryReadTracker, type MemoryReadHold } from "../src/lib/dispatch-governor.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import { requestStop, stopDetail } from "../src/lib/fleet-control.js";
import { loadPlan } from "../src/lib/plan.js";
import { readLedgerLines } from "../src/lib/status.js";
import { memoryReadTrackerFor } from "../src/run-task.js";

// W1-T7720 — the paths the tracker's own suite drives through fakes: a sink that throws, the daemon's
// own heartbeat for a held tick, and the run's REAL wiring of the tracker to the ledger and to an issue
// gateway. Every dispatch decision must survive a failing sink, and a sustained streak must raise ONE
// escalation however many ticks it outlasts.

const TICK_MS = 1000;

/** A hand-advanced clock whose three projections agree, so a test advances time by one assignment. */
function handClock(startMs = 1_000_000): { clock: Clock; at: { now: number } } {
  const at = { now: startMs };
  const clock: Clock = {
    now: () => at.now,
    date: () => new Date(at.now),
    iso: () => new Date(at.now).toISOString(),
  };
  return { clock, at };
}

test("W1-T7720: a ledger, history or escalation sink that throws never throws out of the tracker", () => {
  const { clock, at } = handClock();
  const reported: string[] = [];
  const tracker = createMemoryReadTracker(clock, {
    recoveredDurationsMs: () => {
      throw new Error("history unreadable");
    },
    writeRow: () => {
      throw new Error("disk full");
    },
    escalate: () => {
      throw new Error("issues API down");
    },
    onSinkError: (label) => reported.push(label),
  });
  let hold: MemoryReadHold | undefined;
  for (let tick = 0; tick < 8 && hold === undefined; tick++) {
    at.now += TICK_MS;
    tracker.observe();
    hold = tracker.unreadable("probe", "/proc/meminfo: EIO");
  }
  assert.ok(hold, "an unreadable streak that outlasts the fallback bound is held even when every sink is failing");
  assert.deepEqual([...new Set(reported)].sort(), ["escalate", "history", "row"], "each failing sink is handed to onSinkError by name");
});

test("W1-T7720: the daemon names a held tick in its own memory_unreadable heartbeat", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-memory-daemon-"));
  try {
    const file = join(dir, "tasks.yaml");
    writeFileSync(file, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
    const { clock, at } = handClock();
    const tracker = createMemoryReadTracker(clock, {
      recoveredDurationsMs: () => [],
      writeRow: () => undefined,
      escalate: () => undefined,
    });
    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    const attempted: string[] = [];
    let ticks = 0;
    const summary = await runDaemon(loadPlan(file), {
      refreshMerged: () => () => false,
      runOne: async (id) => {
        attempted.push(id);
        return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" };
      },
      sweep: () => undefined,
      memoryReadTracker: tracker,
      checkMemoryGovernor: () => {
        at.now += TICK_MS;
        throw new Error("/proc/meminfo: EIO");
      },
      checkStop: () => (ticks >= 10 ? stopDetail(dir) ?? "test complete" : undefined),
      sleep: async () => {
        ticks += 1;
        if (ticks >= 10) requestStop(dir, "test complete");
      },
      log: (step, extra = {}) => lines.push({ step, extra }),
    });
    assert.equal(summary.stopReason, "stopped");
    const held = lines.filter((l) => l.step === "daemon.memory_unreadable");
    assert.ok(held.length >= 1, "a sustained unreadable reading is announced by the daemon, tick by tick");
    assert.equal(held[0]!.extra.source, "probe");
    assert.match(String(held[0]!.extra.error), /meminfo/);
    assert.equal(typeof held[0]!.extra.tick, "number");
    assert.equal(typeof held[0]!.extra.poll_interval_ms, "number");
    assert.equal(attempted.length >= 1, true, "the early, transient ticks still dispatched before the streak was sustained");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T7720: the run's tracker ledgers its streak under GOVERNOR, reads recovery back, and raises one BLOCKED escalation", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-memory-wiring-"));
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const { clock, at } = handClock();
    const created: Array<{ title: string; body: string; labels: string[] }> = [];
    const issues: IssueGateway = {
      create: (title, body, labels) => {
        created.push({ title, body, labels });
        return "https://example.invalid/issues/1";
      },
    };
    const tracker = memoryReadTrackerFor(ledgerPath, "RUN-7720", "o", "r", clock, issues);

    // A first streak that recovers: its duration lands in the ledger and is read back as history.
    at.now += TICK_MS;
    tracker.observe();
    tracker.unreadable("probe", "/proc/meminfo: EIO");
    at.now += TICK_MS;
    tracker.readable("probe");

    // A second streak that outlasts the bound: it is held and escalated exactly once.
    let hold: MemoryReadHold | undefined;
    for (let tick = 0; tick < 12; tick++) {
      at.now += TICK_MS;
      tracker.observe();
      hold = tracker.unreadable("probe", "/proc/meminfo: EIO") ?? hold;
    }
    assert.ok(hold, "the second streak is sustained");
    assert.equal(created.length, 1, "one escalation per streak, however many ticks it outlasts");
    assert.match(created[0]!.body, /host memory probe \(\/proc\/meminfo\) has been unreadable/);
    assert.match(created[0]!.body, /sustained bound of \d+ s/);

    const rows = readLedgerLines(ledgerPath);
    const governor = rows.filter((r) => r.task_id === "GOVERNOR" && r.run_id === "RUN-7720");
    for (const step of ["memory_read.unreadable", "memory_read.recovered", "memory_read.sustained"]) {
      assert.ok(governor.some((r) => r.step === step), `${step} is ledgered under task GOVERNOR`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T7720: a tracker whose ledger cannot be written says so on stderr and keeps deciding", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-memory-sink-"));
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    const { clock } = handClock();
    // A directory where the ledger file should be: every append fails.
    const tracker = memoryReadTrackerFor(dir, "RUN-7720", "o", "r", clock, { create: () => "https://example.invalid/issues/2" });
    assert.equal(tracker.unreadable("store", "ledger directory: EACCES"), undefined, "a brand-new streak is not yet sustained");
    assert.match(errors.join("\n"), /memory_read tracker: row sink failed: /);
  } finally {
    console.error = originalError;
    rmSync(dir, { recursive: true, force: true });
  }
});
