import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runDaemon } from "../src/lib/daemon.js";
import { DECISION_RELEVANT_LEDGER_STEPS, appendLedger, rotateLedger, type LedgerLine } from "../src/lib/ledger.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { buildStatusBoard, renderStatusBoardText, type StatusBoardDeps } from "../src/lib/status-board.js";
import { readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { RunResult } from "../src/run-task.js";

// ── W1-T4939: the idle-lane account must survive a daemon restart ───────────────────────────
//
// W1-T4837's account accumulates in memory and emits one `lane.idle_summary` row per hour. The
// daemon restarts on its own freshness check long before most hours close, so the open window
// died with the process. These tests pin the three halves of the repair: the exit flushes the
// open window, rotation keeps the rows, and `rmd status` sums them by cause over the last day.

const MIN = 60_000;

const PLAN_YAML = `- id: A
  title: a
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
`;

function onePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}idle-restart-plan-`));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, PLAN_YAML);
  return loadPlan(f);
}

const neverRuns = async (id: string): Promise<RunResult> => {
  throw new Error(`unexpected dispatch of ${id}`);
};

type Row = { step: string; extra: Record<string, unknown> };

/** Drive a daemon whose only dispatchable task is held by the cost governor for `heldTicks` ticks of
 *  ten minutes each (well inside the 60-minute summary window), then stop it the given way. */
async function runHeldThenStopped(stopReason: "stop" | "freshness"): Promise<Row[]> {
  const rows: Row[] = [];
  let nowMs = Date.parse("2026-10-10T00:00:00.000Z");
  let sleeps = 0;
  let governorReads = 0;
  const heldTicks = 3;
  await runDaemon(onePlan(), {
    refreshMerged: () => () => false,
    runOne: neverRuns,
    now: () => new Date(nowMs),
    sleep: async (ms: number) => {
      void ms;
      sleeps++;
      nowMs += 10 * MIN;
    },
    // The tick-wide gate admits and the per-lane gate before dispatch refuses: that is the path on which selection
    // has run and counted a dispatchable task, which is what makes an empty lane an IDLE lane.
    checkCostGovernor: () => (++governorReads % 2 === 0 ? { deferred: true, observedDayCostUsd: 9, ceilingUsd: 5 } : undefined),
    checkStop: () => (stopReason === "stop" && sleeps >= heldTicks ? "operator stop" : undefined),
    checkFreshness: () =>
      stopReason === "freshness" && sleeps >= heldTicks
        ? { stale: true, oldSha: "a".repeat(40), newSha: "b".repeat(40), installNeeded: false }
        : { stale: false },
    log: (step, extra) => rows.push({ step, extra: extra ?? {} }),
  });
  return rows;
}

test("W1-T4939: a restart flushes the open idle window instead of losing it", async () => {
  for (const how of ["stop", "freshness"] as const) {
    const rows = await runHeldThenStopped(how);
    const summaries = rows.filter((r) => r.step === "lane.idle_summary");
    assert.equal(summaries.length, 1, `${how}: the window never reached 60 minutes, so only the exit flush can have written this row`);
    const row = summaries[0]!.extra;
    assert.equal(row.partial, true, `${how}: a flushed window is marked partial`);
    const byCause = row.minutes_by_cause as Record<string, number>;
    assert.ok(byCause.capacity_headroom >= 20, `${how}: the held minutes are charged to their cause, got ${JSON.stringify(byCause)}`);
    assert.equal(row.idle_minutes, byCause.capacity_headroom, `${how}: every flushed minute is accounted for`);
    // The flush lands before the summary row that closes the lifetime.
    const order = rows.map((r) => r.step);
    assert.ok(order.indexOf("lane.idle_summary") < order.lastIndexOf("daemon.summary"), `${how}: flushed before daemon.summary`);
  }
});

test("W1-T4939: a window with no idle minute writes no partial row", async () => {
  const rows: Row[] = [];
  await runDaemon(onePlan(), {
    refreshMerged: () => () => true,
    runOne: neverRuns,
    sleep: async () => {},
    checkStop: () => "stop now",
    log: (step, extra) => rows.push({ step, extra: extra ?? {} }),
  });
  assert.equal(rows.filter((r) => r.step === "lane.idle_summary").length, 0);
});

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}idle-restart-`));
}

test("W1-T4939: idle summaries are retained through log rotation", () => {
  assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has("lane.idle_summary"), "named beside daemon.idle_reasons in the retained steps");
  const dir = tmpDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    for (let i = 0; i < 3; i++) {
      appendLedger(ledgerPath, { run_id: `idle${i}`, task_id: "daemon", step: "lane.idle_summary", marker: i, partial: i === 2 } as LedgerLine, {
        ceilingBytes: Number.MAX_SAFE_INTEGER,
      });
    }
    const ceiling = statSync(ledgerPath).size * 4;
    const noise = JSON.stringify({ step: "ci.polling", run_id: "noise", detail: "x".repeat(64) }) + "\n";
    for (let n = 0; n < Math.ceil(ceiling / noise.length) + 50; n++) writeFileSync(ledgerPath, noise, { flag: "a" });

    const result = rotateLedger(ledgerPath, { ceilingBytes: ceiling });
    assert.equal(result.rotated, true, "setup: the ledger really rotated");
    const live = readLedgerLines(ledgerPath).filter((l) => l.step === "lane.idle_summary");
    assert.deepEqual(live.map((l) => l.marker).sort(), [0, 1, 2], "every idle summary survives into the live ledger");
    assert.ok(!readFileSync(ledgerPath, "utf8").includes("ci.polling"), "while the noise was archived away");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const NOW = Date.parse("2026-10-10T12:00:00.000Z");

function summaryRow(endMsAgo: number, minutes: Record<string, number>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const total = Object.values(minutes).reduce((a, b) => a + b, 0);
  const endMs = NOW - endMsAgo;
  return {
    ts: new Date(endMs).toISOString(),
    step: "lane.idle_summary",
    window_start_ms: endMs - total * MIN,
    window_end_ms: endMs,
    idle_minutes: total,
    minutes_by_cause: minutes,
    largest_cause: null,
    ...extra,
  };
}

function idle(model: ReturnType<typeof buildStatusBoard>): NonNullable<ReturnType<typeof buildStatusBoard>["idleLane"]> {
  assert.ok(model.idleLane, "buildStatusBoard always sets the idle-lane section");
  return model.idleLane;
}

function boardFor(lines: Array<Record<string, unknown>>) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}idle-restart-board-`));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}idle-restart-root-`));
  mkdirSync(join(root, "state"), { recursive: true });
  const deps: StatusBoardDeps = {
    queryService: () => ({ running: false, pid: null }),
    repoDir: "/nonexistent/repo/for/tests",
    now: () => NOW,
    resolveOriginMainSha: () => undefined,
    isPidAlive: () => true,
  };
  return buildStatusBoard(root, ledgerPath, deps);
}

test("W1-T4939: rmd status shows idle minutes by cause for the last day", () => {
  const model = boardFor([
    summaryRow(2 * 60 * MIN, { wip_limit: 30, pause: 10 }),
    summaryRow(60 * MIN, { wip_limit: 5, unknown: 2.5 }, { partial: true }),
    // Older than a day: must not be summed in.
    summaryRow(25 * 60 * MIN, { wip_limit: 99 }),
  ]);

  assert.equal(idle(model).found, true);
  assert.equal(idle(model).rows, 2, "the row from 25 hours ago is outside the window");
  assert.equal(idle(model).partialRows, 1);
  assert.equal(idle(model).idleMinutes, 47.5);
  assert.deepEqual(idle(model).minutesByCause, { wip_limit: 35, pause: 10, unknown: 2.5 });
  assert.equal(idle(model).largestCause, "wip_limit");

  const text = renderStatusBoardText(model);
  assert.match(text, /── IDLE LANE/);
  assert.match(text, /idle minutes \(24h\): 47\.5 {2}rows: 2 \(1 partial\)/);
  assert.match(text, /wip_limit: 35/);
  assert.match(text, /pause: 10/);
  assert.match(text, /unknown: 2\.5/);
  assert.doesNotMatch(text, /wip_limit: 134/);
});

test("W1-T4939: rmd status says so when no idle summary is recorded in the last day", () => {
  const model = boardFor([summaryRow(30 * 60 * MIN, { pause: 5 })]);
  assert.equal(idle(model).found, false);
  assert.equal(idle(model).idleMinutes, 0);
  const text = renderStatusBoardText(model);
  assert.match(text, /── IDLE LANE/);
  assert.match(text, /no idle-lane summary rows in the last 24 hours/);
});
