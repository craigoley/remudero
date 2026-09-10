import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DAEMON_EXIT_STALE, HEAP_PRESSURE_RESTART_FRACTION, daemonExitCode, runDaemon } from "../src/lib/daemon.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// ── W1-T3335 — THE LOOP ARM, not just the predicate ───────────────────────────────────────────
//
// `heapPressureDetail` is pure and separately falsified. This drives the arm that CONSUMES it: the
// tick-boundary check that logs and returns instead of running into V8's wall. diff-coverage named
// exactly these lines (src/lib/daemon.ts:2033-2039) as added with zero covering tests, and it was
// right — the seam exists (`deps.heapStatistics`) and nothing was using it.
//
// MEASURED on the fleet host 2026-09-10: the process reached 8,188 MB and aborted after 184-197
// SECONDS, 41+ times. An abort loses in-flight work and costs the entrypoint's 120s crash throttle;
// this arm gives up the tick instead, on the exit code the entrypoint already treats as a non-crash.

type LedgerRow = { step: string; extra: Record<string, unknown> };

const LIMIT = 8_589_934_592;

function tinyPlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}heap-pressure-loop-`));
  const path = join(dir, "tasks.yaml");
  writeFileSync(
    path,
    `
- id: A
  title: only task
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
`,
  );
  return loadPlan(path);
}

/** Deps that keep the loop inert: nothing dispatches, and a stop guard bounds a runaway. */
function inertDeps(rows: LedgerRow[], stopAfter: () => boolean) {
  return {
    refreshMerged: () => (() => false),
    isOpenPr: () => undefined,
    isCreditIndeterminate: () => false,
    runOne: async () => { throw new Error("no task may be dispatched in this test"); },
    escalateBlock: async () => {},
    sweep: async () => {},
    sleep: async () => { throw new Error("plain sleep must not own the wait"); },
    sleepUntilSweepWake: async () => {},
    checkStop: () => (stopAfter() ? "test stop" : undefined),
    log: (step: string, extra: Record<string, unknown> = {}) => rows.push({ step, extra }),
  };
}

test("W1-T3335: a heap at V8's ceiling ends the pass at the tick boundary, before anything dispatches", async () => {
  const rows: LedgerRow[] = [];
  const summary = await runDaemon(tinyPlan(), {
    ...inertDeps(rows, () => false),
    heapStatistics: () => ({ used_heap_size: 8_188 * 1e6, heap_size_limit: LIMIT }),
  } as never);

  assert.equal(summary.stopReason, "heap_pressure", `expected the pass to end for heap pressure, got ${summary.stopReason}`);
  assert.match(String(summary.stopDetail ?? ""), /tick boundary/, "the detail must say the restart was taken deliberately");

  const row = rows.find((r) => r.step === "daemon.heap_pressure_exit");
  assert.ok(row, `expected a daemon.heap_pressure_exit row, saw ${JSON.stringify(rows.map((r) => r.step))}`);
  assert.equal(row?.extra.heap_size_limit, LIMIT, "the row must carry the limit it measured against");
  assert.equal(row?.extra.threshold, HEAP_PRESSURE_RESTART_FRACTION, "and the fraction it applied");

  // The exit must be spent from the NON-CRASH budget, or the 120s throttle applies anyway.
  assert.equal(daemonExitCode(summary.stopReason), DAEMON_EXIT_STALE);
});

test("W1-T3335: an idle heap does not end the pass — the arm must not degrade into 'always restart'", async () => {
  // THE CONTROL THAT MATTERS. An arm that fired unconditionally satisfies the case above and turns
  // the daemon into a boot loop that dispatches nothing, which is worse than the abort it replaces.
  const rows: LedgerRow[] = [];
  let ticks = 0;
  const summary = await runDaemon(tinyPlan(), {
    ...inertDeps(rows, () => ++ticks > 3),
    heapStatistics: () => ({ used_heap_size: 200 * 1e6, heap_size_limit: LIMIT }),
  } as never);

  assert.notEqual(summary.stopReason, "heap_pressure", "an idle heap must not end the pass");
  assert.equal(rows.filter((r) => r.step === "daemon.heap_pressure_exit").length, 0, "and must log no pressure row");
  assert.ok(rows.some((r) => r.step === "daemon.tick"), "the loop must actually have ticked, or this proves nothing");
});
