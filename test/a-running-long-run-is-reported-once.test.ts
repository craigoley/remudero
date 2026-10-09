import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  COST_ANOMALY_STEP,
  pendingCostAnomalies,
  pendingRunningLong,
  readReportedAnomalies,
  RUNNING_LONG_STEP,
  type CostAnomalyPolicy,
  type ReportedAnomalies,
} from "../src/lib/cost-anomaly.js";
import { appendLedger, rotateLedger } from "../src/lib/ledger.js";
import { realLedgerFs } from "../src/lib/ledger-union.js";
import { parseLedger } from "../src/lib/retro.js";
import { runSweep, type SweepDeps } from "./helpers/sweep-test.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// W1-T4702 — a running-long run was reported on every sweep, not once. `rotateLedger` archives every
// `run.running_long` row (and all but the newest 200 `cost.anomaly` rows) while the run's own
// `run.start` stays live, so a dedupe over the live file alone forgot the report after each
// rotation. These tests drive the REAL `rotateLedger` and the REAL `runSweep` sentinel hook.

const POLICY: CostAnomalyPolicy = { multiplier: 3, minSamples: 3 };
const T0 = Date.parse("2026-09-28T00:00:00.000Z");
const MIN = 60_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function stateDir(): { dir: string; ledgerPath: string } {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}running-long-once-`));
  return { dir, ledgerPath: join(dir, "ledger.ndjson") };
}

/** Three settled `src` runs of 10 minutes and $1 each: the class median both sentinels judge against. */
function settledClass(): string[] {
  const out: string[] = [];
  for (let i = 0; i < 3; i++) {
    const start = T0 + i * 20 * MIN;
    out.push(
      JSON.stringify({ ts: iso(start), run_id: `SET-${i}`, task_id: `W1-S${i}`, step: "run.start", task_class: "src" }),
      JSON.stringify({ ts: iso(start + 10 * MIN), run_id: `SET-${i}`, task_id: `W1-S${i}`, step: "verdict", verdict: "merged", cost_usd: 1 }),
    );
  }
  return out;
}

function inFlight(runId: string, startMs: number): string {
  return JSON.stringify({ ts: iso(startMs), run_id: runId, task_id: `W1-${runId}`, step: "run.start", task_class: "src" });
}

function writeLedger(path: string, lines: string[]): void {
  writeFileSync(path, `${lines.join("\n")}\n`);
}

/** Force a real rotation: pad with noise past a ceiling the retained core fits under (so no shed). */
function rotate(path: string, atMs: number): string {
  const ceilingBytes = statSync(path).size + 500;
  for (let n = 0; n < 50; n++) {
    appendLedger(path, { run_id: `noise-${atMs}-${n}`, task_id: "W1-NOISE", step: "ci.polling", detail: "x".repeat(64) } as never);
  }
  const result = rotateLedger(path, { ceilingBytes, smoothingWindowMs: 0, now: () => new Date(atMs) });
  assert.equal(result.rotated, true, "fixture sanity: a real rotation fired");
  assert.ok(result.archivePath && existsSync(result.archivePath), "fixture sanity: the rotation wrote an archive");
  return result.archivePath;
}

function live(path: string): Array<Record<string, unknown>> {
  return parseLedger(readFileSync(path, "utf8"));
}

/** Runs one sweep pass at `nowMs` and returns only the rows that pass wrote, plus its log calls. */
async function sweepOnce(
  ledgerPath: string,
  nowMs: number,
  overrides: Partial<SweepDeps> = {},
): Promise<{ written: Array<Record<string, unknown>>; logged: Array<{ step: string; extra?: Record<string, unknown> }> }> {
  const written: Array<Record<string, unknown>> = [];
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  await runSweep([], {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath,
    runId: "SWEEP-RUNNING-LONG-ONCE",
    now: () => nowMs,
    costAnomalyPolicy: POLICY,
    appendLine: (path, line) => {
      written.push(line);
      appendLedger(path, line);
    },
    log: (step, extra) => logged.push({ step, extra }),
    ...overrides,
  });
  return { written, logged };
}

function reportsFor(rows: Array<Record<string, unknown>>, step: string, runId: string): number {
  return rows.filter((r) => r.step === step && r.run_id === runId).length;
}

function incidentsFor(rows: Array<Record<string, unknown>>, runId: string): number {
  return rows.filter((r) => r.step === "incident.event" && r.run_id === `INCIDENT-${runId}`).length;
}

test("a run whose earlier running_long row was rotated into an archive while its run.start stays live is not reported again and writes no new incident event", async () => {
  const { ledgerPath } = stateDir();
  writeLedger(ledgerPath, [...settledClass(), inFlight("HUNG", T0 + 60 * MIN)]);

  const first = await sweepOnce(ledgerPath, T0 + 300 * MIN);
  assert.equal(reportsFor(first.written, RUNNING_LONG_STEP, "HUNG"), 1, "the first pass reports the hung run");
  assert.equal(incidentsFor(first.written, "HUNG"), 1, "with one incident event");

  rotate(ledgerPath, T0 + 301 * MIN);
  const after = live(ledgerPath);
  assert.equal(reportsFor(after, RUNNING_LONG_STEP, "HUNG"), 0, "rotation archived the running_long row");
  assert.equal(reportsFor(after, "run.start", "HUNG"), 1, "while the run's own run.start stayed live");
  assert.deepEqual(
    pendingRunningLong(after, POLICY, T0 + 310 * MIN).map((f) => f.runId),
    ["HUNG"],
    "the exposure is real: a dedupe over the live file alone would report HUNG again",
  );

  for (const at of [310, 320, 330]) {
    const pass = await sweepOnce(ledgerPath, T0 + at * MIN);
    assert.equal(reportsFor(pass.written, RUNNING_LONG_STEP, "HUNG"), 0, `no new running_long row at +${at}min`);
    assert.equal(incidentsFor(pass.written, "HUNG"), 0, `no new incident event at +${at}min`);
  }
});

test("a genuinely new long run is still reported exactly once, across a rotation", async () => {
  const { ledgerPath } = stateDir();
  writeLedger(ledgerPath, [...settledClass(), inFlight("OLD", T0 + 60 * MIN)]);
  await sweepOnce(ledgerPath, T0 + 300 * MIN);
  rotate(ledgerPath, T0 + 301 * MIN);

  appendLedger(ledgerPath, { ts: iso(T0 + 302 * MIN), run_id: "NEW", task_id: "W1-NEW", step: "run.start", task_class: "src" } as never);
  const early = await sweepOnce(ledgerPath, T0 + 310 * MIN);
  assert.equal(reportsFor(early.written, RUNNING_LONG_STEP, "NEW"), 0, "8 minutes in, NEW is not long yet");

  const due = await sweepOnce(ledgerPath, T0 + 400 * MIN);
  assert.equal(reportsFor(due.written, RUNNING_LONG_STEP, "NEW"), 1, "NEW is reported once it runs long");
  assert.equal(incidentsFor(due.written, "NEW"), 1, "with exactly one incident event");
  assert.equal(reportsFor(due.written, RUNNING_LONG_STEP, "OLD"), 0, "OLD, archived, stays reported");

  rotate(ledgerPath, T0 + 401 * MIN);
  const again = await sweepOnce(ledgerPath, T0 + 410 * MIN);
  assert.equal(reportsFor(again.written, RUNNING_LONG_STEP, "NEW"), 0, "and never again after its own report rotates away");
  assert.equal(incidentsFor(again.written, "NEW"), 0);
});

test("an unreadable union reports nothing new, logs why once, and reports the run once it is readable", async () => {
  const { dir, ledgerPath } = stateDir();
  writeLedger(ledgerPath, [...settledClass(), inFlight("BLIND", T0 + 60 * MIN)]);
  const corrupt = join(dir, "ledger.2026-09-27T00-00-00-000Z.ndjson.gz");
  writeFileSync(corrupt, "this is not gzip");

  const first = await sweepOnce(ledgerPath, T0 + 300 * MIN);
  const second = await sweepOnce(ledgerPath, T0 + 310 * MIN);
  for (const pass of [first, second]) {
    assert.equal(pass.written.filter((r) => r.step === RUNNING_LONG_STEP || r.step === COST_ANOMALY_STEP).length, 0);
    assert.equal(pass.written.filter((r) => r.step === "incident.event").length, 0);
  }
  const gaps = [...first.logged, ...second.logged].filter((l) => l.step === "sweep.anomaly_dedupe.incomplete");
  assert.equal(gaps.length, 1, "a persistent gap is logged once, not once per pass");
  assert.match(String(gaps[0].extra?.reason), /unreadable ledger archive/);
  assert.ok(String(gaps[0].extra?.reason).includes(corrupt), "the log names the archive it could not read");

  rmSync(corrupt);
  const readable = await sweepOnce(ledgerPath, T0 + 320 * MIN);
  assert.equal(reportsFor(readable.written, RUNNING_LONG_STEP, "BLIND"), 1);
  assert.equal(incidentsFor(readable.written, "BLIND"), 1);
});

test("an unlistable state directory, or a union reader that throws, is incomplete rather than empty", async () => {
  const unlistable = await readReportedAnomalies("/state", [], {
    ...realLedgerFs,
    readdirSync: () => {
      throw new Error("EACCES");
    },
  });
  assert.equal(unlistable.complete, false);
  assert.match(String(unlistable.reason), /state directory unreadable: \/state: EACCES/);

  const { ledgerPath } = stateDir();
  writeLedger(ledgerPath, [...settledClass(), inFlight("THROWN", T0 + 60 * MIN)]);
  const pass = await sweepOnce(ledgerPath, T0 + 300 * MIN, {
    readReportedAnomalies: () => {
      throw new Error("union reader exploded");
    },
  });
  assert.equal(reportsFor(pass.written, RUNNING_LONG_STEP, "THROWN"), 0);
  assert.deepEqual(
    pass.logged.filter((l) => l.step === "sweep.anomaly_dedupe.incomplete").map((l) => l.extra?.reason),
    ["union reader exploded"],
  );
});

test("the cost.anomaly twin: a report rotated out of the live file's newest-200 window is not re-reported", async () => {
  const { ledgerPath } = stateDir();
  const pricey = JSON.stringify({ ts: iso(T0 + 70 * MIN), run_id: "PRICEY", task_id: "W1-PRICEY", step: "run.start", task_class: "src" });
  const priceyVerdict = JSON.stringify({ ts: iso(T0 + 80 * MIN), run_id: "PRICEY", task_id: "W1-PRICEY", step: "verdict", verdict: "merged", cost_usd: 20 });
  writeLedger(ledgerPath, [...settledClass(), pricey, priceyVerdict]);

  const first = await sweepOnce(ledgerPath, T0 + 100 * MIN);
  assert.equal(reportsFor(first.written, COST_ANOMALY_STEP, "PRICEY"), 1);

  // 200 later reports of other runs push PRICEY's row out of rotateLedger's newest-200 window.
  for (let n = 0; n < 200; n++) {
    appendLedger(ledgerPath, { ts: iso(T0 + 101 * MIN + n), run_id: `ELSEWHERE-${n}`, task_id: "W1-ELSEWHERE", step: COST_ANOMALY_STEP } as never);
  }
  rotate(ledgerPath, T0 + 110 * MIN);
  const after = live(ledgerPath);
  assert.equal(reportsFor(after, COST_ANOMALY_STEP, "PRICEY"), 0, "rotation archived PRICEY's cost.anomaly row");
  assert.equal(reportsFor(after, "verdict", "PRICEY"), 1, "while its settled run stayed live");
  assert.deepEqual(pendingCostAnomalies(after, POLICY).map((f) => f.runId), ["PRICEY"], "the twin's exposure is real");

  const second = await sweepOnce(ledgerPath, T0 + 120 * MIN);
  assert.equal(reportsFor(second.written, COST_ANOMALY_STEP, "PRICEY"), 0, "no second cost.anomaly row");
  assert.equal(incidentsFor(second.written, "PRICEY"), 0, "no second incident event");
});

test("replay: twelve sweeps with a rotation between each write one running_long row, where a live-only dedupe writes twelve", async () => {
  const liveOnly = async (): Promise<ReportedAnomalies> => ({ complete: true, costAnomaly: new Set(), runningLong: new Set() });
  const replay = async (overrides: Partial<SweepDeps>): Promise<number> => {
    const { ledgerPath } = stateDir();
    writeLedger(ledgerPath, [...settledClass(), inFlight("REPLAY", T0 + 60 * MIN)]);
    let rows = 0;
    for (let pass = 0; pass < 12; pass++) {
      const at = T0 + (300 + pass * 20) * MIN;
      rows += reportsFor((await sweepOnce(ledgerPath, at, overrides)).written, RUNNING_LONG_STEP, "REPLAY");
      rotate(ledgerPath, at + MIN);
    }
    return rows;
  };
  assert.equal(await replay({ readReportedAnomalies: liveOnly }), 12, "before: one report per rotation");
  assert.equal(await replay({}), 1, "after: one report, ever");
});
