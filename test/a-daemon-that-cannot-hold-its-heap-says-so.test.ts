import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DAEMON_EXIT_STALE,
  HEAP_PRESSURE_RESTART_FRACTION,
  daemonExitCode,
  runDaemon,
} from "../src/lib/daemon.js";
import { deriveDaemonLiveness } from "../src/lib/panel-actions.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import type { RunResult } from "../src/lib/run-result.js";
import { DEFAULT_LIVENESS_BOUND_MS, readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const LIMIT = 8_589_934_592;
const NOW = Date.parse("2026-09-10T13:49:00.000Z");

type LedgerRow = { step: string; extra: Record<string, unknown> };

function planWith(ids: readonly string[]): Plan {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}heap-pressure-acceptance-`));
  const path = join(dir, "tasks.yaml");
  writeFileSync(
    path,
    ids
      .map(
        (id) => `
- id: ${id}
  title: task ${id}
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
`,
      )
      .join(""),
  );
  return loadPlan(path);
}

function mergedResult(taskId: string): RunResult {
  return { taskId, runId: `${taskId}-run`, merged: true, costUsd: 0.25, verdict: "merged" };
}

test("W1-T3335 criterion 1: the daemon ledgers heap pressure against V8's limit on its own tick", async () => {
  const rows: LedgerRow[] = [];
  const summary = await runDaemon(
    planWith(["A"]),
    {
      refreshMerged: () => () => false,
      runOne: async () => {
        throw new Error("heap pressure must stop before dispatch");
      },
      sleep: async () => {
        throw new Error("heap pressure must not idle");
      },
      heapStatistics: () => ({ used_heap_size: 8_188 * 1e6, heap_size_limit: LIMIT }),
      log: (step, extra = {}) => rows.push({ step, extra }),
    },
  );

  assert.equal(summary.stopReason, "heap_pressure");
  assert.match(String(summary.stopDetail), /heap at 9\d% of V8's 8590 MB limit/);
  assert.match(String(summary.stopDetail), /tick boundary/);
  assert.equal(daemonExitCode(summary.stopReason), DAEMON_EXIT_STALE);

  assert.equal(rows[0]?.step, "daemon.tick", "heap accounting is reached from the daemon's own tick");
  const pressure = rows.find((row) => row.step === "daemon.heap_pressure_exit");
  assert.ok(pressure, `expected a daemon.heap_pressure_exit row, saw ${JSON.stringify(rows.map((row) => row.step))}`);
  assert.equal(pressure.extra.used_heap_size, 8_188 * 1e6);
  assert.equal(pressure.extra.heap_size_limit, LIMIT);
  assert.equal(pressure.extra.threshold, HEAP_PRESSURE_RESTART_FRACTION);
});

test("W1-T3335 criterion 2: once pressure is observed, no new work is accepted after the in-flight task drains", async () => {
  const rows: LedgerRow[] = [];
  const merged = new Set<string>();
  const ran: string[] = [];
  let heapReads = 0;

  const summary = await runDaemon(
    planWith(["A", "B"]),
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        ran.push(id);
        merged.add(id);
        return mergedResult(id);
      },
      sleep: async () => {
        throw new Error("the second task must be refused before the daemon idles");
      },
      heapStatistics: () => {
        heapReads++;
        return heapReads === 1
          ? { used_heap_size: 2_000 * 1e6, heap_size_limit: LIMIT }
          : { used_heap_size: LIMIT * HEAP_PRESSURE_RESTART_FRACTION, heap_size_limit: LIMIT };
      },
      log: (step, extra = {}) => rows.push({ step, extra }),
    },
  );

  assert.deepEqual(ran, ["A"], "A finished, then B was never accepted after the pressure reading");
  assert.deepEqual(summary.attempted, ["A"]);
  assert.deepEqual(summary.merged, ["A"]);
  assert.equal(summary.stopReason, "heap_pressure");
  assert.ok(rows.find((row) => row.step === "dispatch.settled_set"), "the admitted work settled before the exit");
  assert.equal(rows.filter((row) => row.step === "daemon.heap_pressure_exit").length, 1);
});

test("W1-T3335 criterion 3: a daemon comfortably inside its limit ledgers no heap pressure and refuses no work", async () => {
  const rows: LedgerRow[] = [];
  const merged = new Set<string>();
  const ran: string[] = [];

  const summary = await runDaemon(
    planWith(["A"]),
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        ran.push(id);
        merged.add(id);
        return mergedResult(id);
      },
      sleep: async () => {
        throw new Error("max should stop this bounded fixture before idle");
      },
      heapStatistics: () => ({ used_heap_size: 2_000 * 1e6, heap_size_limit: LIMIT }),
      log: (step, extra = {}) => rows.push({ step, extra }),
    },
    { max: 1 },
  );

  assert.deepEqual(ran, ["A"]);
  assert.deepEqual(summary.attempted, ["A"]);
  assert.equal(summary.stopReason, "max_reached");
  assert.equal(rows.filter((row) => row.step === "daemon.heap_pressure_exit").length, 0);
});

test("W1-T3335 criterion 4: a stopped fleet is visible from outside the process by stale ledger cadence", () => {
  const staleHeartbeat = { ts: new Date(NOW - DEFAULT_LIVENESS_BOUND_MS - 1).toISOString(), step: "daemon.tick" };
  assert.deepEqual(
    deriveDaemonLiveness([staleHeartbeat], NOW, DEFAULT_LIVENESS_BOUND_MS),
    { live: false, reason: "last-poll-stale" },
  );

  const freshHeartbeat = { ts: new Date(NOW - DEFAULT_LIVENESS_BOUND_MS).toISOString(), step: "daemon.tick" };
  assert.deepEqual(
    deriveDaemonLiveness([freshHeartbeat], NOW, DEFAULT_LIVENESS_BOUND_MS),
    { live: true, reason: "fresh-poll" },
    "the same cadence boundary must keep a healthy quiet daemon from raising a halt alarm",
  );

  const absent = readLedgerLines(join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}heap-pressure-absent-`)), "ledger.ndjson"));
  assert.deepEqual(
    deriveDaemonLiveness(absent, NOW, DEFAULT_LIVENESS_BOUND_MS),
    { reason: "ledger-absent" },
    "an absent ledger is unknown, not falsely reported as a stopped fleet",
  );
});
