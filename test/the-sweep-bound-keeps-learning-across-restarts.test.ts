/**
 * W1-T9632 — the full-sweep bound keeps learning across restarts. On 2026-10-15 the core daemon restarted about
 * hourly, full passes settled at 1,384-4,995 s, and each boot seeded W1-T9563's learner from the live ledger alone:
 * 0-2 samples, under the 5 the p90 rule needs, so every full pass was abandoned at the 559 s policy value. The
 * daemon-level tests scale minutes to milliseconds as W1-T9563's suite does (a 20 ms policy value for 559 s).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import * as daemon from "../src/lib/daemon.js";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { readLedgerRawLines, readRestartHistoryLines } from "../src/run-task.js";

// A namespace import, so the file still loads at base and each test reddens on its own.
const { learnedSweepBound, recordSettledSweep } = daemon;

const REAL_SLEEP: DaemonDeps["sleep"] = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MIN = 60_000;

type Line = { step: string; extra: Record<string, unknown> };

function fixturePlan(root: string): Plan {
  const path = join(root, "tasks.yaml");
  writeFileSync(path, `
- id: W1-T9632FIX
  title: keep the sweep bound across restarts
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`);
  return loadPlan(path);
}

/** One cycle, then a stale exit: the shape W1-T9563's suite uses. */
function staleOnceDeps(lines: Line[], over: Partial<DaemonDeps>): DaemonDeps {
  return {
    refreshMerged: () => () => false,
    runOne: async (id) => ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0, verdict: "merged" }),
    checkFreshness: () => ({ stale: true, oldSha: "aaaaaaa1111111111111111111111111111111", newSha: "bbbbbbb2222222222222222222222222222222" }),
    sweep: () => new Promise<void>((resolve) => setTimeout(resolve, 200)),
    sleep: REAL_SLEEP,
    log: (step, extra = {}) => lines.push({ step, extra }),
    ...over,
  };
}

function settledRow(elapsedMs: number, minutesAgo: number): string {
  return JSON.stringify({
    ts: new Date(Date.now() - minutesAgo * MIN).toISOString(), run_id: "DAEMON-1", task_id: "DAEMON",
    step: "daemon.sweep.settled", elapsed_ms: elapsedMs, abandoned: true,
  });
}

/** `ledger.<ISO stamp with : and . as ->.ndjson.gz`, the name a rotation cuts. */
function rotationName(minutesAgo: number): string {
  return `ledger.${new Date(Date.now() - minutesAgo * MIN).toISOString().replace(/[:.]/g, "-")}.ndjson.gz`;
}

const p90x3 = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.9 * sorted.length) - 1] * 3;
};

test("W1-T9632: three settled passes of 1,384-4,995 s bound the next pass at 3x the longest, not the 559 s policy value", () => {
  const learner = { fallbackMs: 559_000, settledMs: [] as number[] };
  for (const s of [4_995, 1_384, 2_373]) recordSettledSweep(learner, s * 1000);
  const bound = learnedSweepBound(learner);
  assert.equal(bound.basis, "settled_max_fallback");
  assert.equal(bound.samples, 3);
  assert.ok(bound.boundMs >= 3 * 4_995_000, `at least 3 x the longest settled pass: ${bound.boundMs} ms`);
  assert.equal(bound.boundMs, 14_985_000);
  // A held pass that would not outlast the policy value leaves the policy value the bound.
  assert.deepEqual(learnedSweepBound({ fallbackMs: 559_000, settledMs: [60_000] }), { boundMs: 559_000, basis: "no_history_fallback", samples: 1 });
  assert.deepEqual(learnedSweepBound({ fallbackMs: 559_000, settledMs: [] }), { boundMs: 559_000, basis: "no_history_fallback", samples: 0 });
});

test("W1-T9632: a boot whose settled passes were rotated into archives keeps its samples", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t9632-"));
  try {
    // 8 passes of 110-350 ms (the 11-35 min population) sit only in a rotated archive. The live file holds 2 short
    // ones (5 and 6 ms, under the policy value / 3), so a live-only seed stays on the 20 ms policy value.
    const archived = Array.from({ length: 8 }, (_, i) => Math.round(110 + (240 * i) / 7));
    const live = [5, 6];
    writeFileSync(join(dir, rotationName(60)), gzipSync(archived.map((ms, i) => settledRow(ms, 300 - i * 20)).join("\n") + "\n"));
    writeFileSync(join(dir, "ledger.ndjson"), [...live.map((ms, i) => settledRow(ms, 30 - i * 10)), JSON.stringify({ ts: new Date().toISOString(), step: "daemon.start" })].join("\n") + "\n");
    const lines: Line[] = [];
    const summary = await runDaemon(fixturePlan(dir), staleOnceDeps(lines, {
      readLedgerLines: () => readLedgerRawLines(join(dir, "ledger.ndjson")),
      readRestartHistory: () => readRestartHistoryLines(dir),
    }), { pollIntervalMs: 30, sweepWallClockBoundMs: 20 });
    assert.equal(summary.stopReason, "stale");
    const steps = lines.map((l) => l.step);
    assert.deepEqual(lines.find((l) => l.step === "daemon.sweep.seeded")?.extra, { samples: 10, source: "ledger_union" },
      `the union seeds every settled pass once, live rows not counted twice: ${steps.join(", ")}`);
    assert.deepEqual(lines.find((l) => l.step === "daemon.sweep.started")?.extra,
      { bound_ms: p90x3([...archived, ...live]), bound_basis: "observed_passes", samples: 10 });
    assert.equal(steps.includes("daemon.sweep.abandoned"), false, `the pass runs inside its learned bound: ${steps.join(", ")}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("W1-T9632: an unreadable archive union seeds the sweep bound from the live ledger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t9632-"));
  try {
    const seeded = Array.from({ length: 6 }, (_, i) => 110 + i * 40);
    const lines: Line[] = [];
    await runDaemon(fixturePlan(dir), staleOnceDeps(lines, {
      readLedgerLines: () => seeded.map((ms, i) => settledRow(ms, 60 - i * 5)),
      readRestartHistory: () => { throw new Error("restart history unreadable: ledger.x.ndjson.gz"); },
    }), { pollIntervalMs: 30, sweepWallClockBoundMs: 20 });
    assert.ok(lines.some((l) => l.step === "daemon.restart_history_unreadable"));
    assert.deepEqual(lines.find((l) => l.step === "daemon.sweep.seeded")?.extra, { samples: 6, source: "live_ledger" });
    assert.deepEqual(lines.find((l) => l.step === "daemon.sweep.started")?.extra, { bound_ms: p90x3(seeded), bound_basis: "observed_passes", samples: 6 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
