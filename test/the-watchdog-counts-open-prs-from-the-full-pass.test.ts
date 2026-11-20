import assert from "node:assert/strict";
import test from "node:test";
import {
  decideProgressWatchdog,
  openPrCountFromRows,
  openPrCountReadingFromRows,
  renderProgressWatchdogVerdict,
} from "../src/lib/progress-watchdog.js";
import { DEFAULT_SWEEP_POLICY, runSweep } from "./helpers/sweep-test.js";

// W1-T9702: on 2026-10-15 the 17:09:32Z verdict said "1 open PR(s)" while the full pass at 17:19:37Z
// enumerated 31. A light pass fans runSweep out one PR at a time, so each of its sweep.pass rows
// reads enumerated 1, and an empty light pass reads 0, which would have said IDLE.

const NOW = Date.parse("2026-10-15T17:09:32.550Z");
const MIN = 60_000;
const ago = (minutes: number): string => new Date(NOW - minutes * MIN).toISOString();
type Row = Record<string, unknown>;
const pass = (minutesAgo: number, enumerated: number, surface?: "full" | "light"): Row =>
  ({ ts: ago(minutesAgo), step: "sweep.pass", run_id: "DAEMON-1", enumerated, ...(surface ? { surface } : {}) });

test("W1-T9702: a light pass's enumerated 1 never stands in for the full pass's open-PR count", () => {
  const rows = [pass(25, 31, "full"), pass(21, 1, "light"), pass(21, 1, "light"), pass(17, 1, "light")];
  assert.deepEqual(openPrCountReadingFromRows(rows), { count: 31, source: "full_pass" });
  assert.equal(openPrCountFromRows(rows), 31);
  const reading = openPrCountReadingFromRows(rows);
  const verdict = decideProgressWatchdog({ rows, nowMs: NOW, openPrCount: reading.count, openPrCountSource: reading.source });
  assert.equal(verdict.state, "STALLED");
  assert.match(verdict.reason, /with 31 open PR\(s\)/);
  assert.equal(verdict.openPrCountSource, "full_pass");
  assert.match(renderProgressWatchdogVerdict(verdict), /with 31 open PR\(s\) \(count: full_pass\)/);
});

test("W1-T9702: an empty light pass's enumerated 0 never reads IDLE while the full pass saw open PRs", () => {
  // An empty light pass calls runSweep([]) with no surface, so its row carries none.
  const rows = [pass(25, 31, "full"), pass(17, 0)];
  const reading = openPrCountReadingFromRows(rows);
  assert.deepEqual(reading, { count: 31, source: "full_pass" });
  const verdict = decideProgressWatchdog({ rows, nowMs: NOW, openPrCount: reading.count, openPrCountSource: reading.source });
  assert.notEqual(verdict.state, "IDLE");
  assert.equal(verdict.action, "capture-diagnostics");
});

test("W1-T9702: a pass newer than the full pass that saw more open PRs raises the count", () => {
  const rows = [pass(25, 0, "full"), pass(20, 1, "light")];
  assert.deepEqual(openPrCountReadingFromRows(rows), { count: 1, source: "full_pass_raised" });
  const reading = openPrCountReadingFromRows([pass(25, 0, "full"), pass(30, 4, "light")]);
  assert.deepEqual(reading, { count: 0, source: "full_pass" }, "a pass OLDER than the full pass raises nothing");
  const idle = decideProgressWatchdog({ rows: [pass(25, 0, "full")], nowMs: NOW, openPrCount: 0, openPrCountSource: "full_pass" });
  assert.equal(idle.state, "IDLE", "a full pass that saw none still reads IDLE");
  assert.equal(idle.reason, "no open PRs (count: full_pass), so no progress is owed");
});

test("W1-T9702: with no full pass in the window the count is the max over the window, and says so", () => {
  const rows = [pass(200, 31), pass(17, 1), pass(16, 0)];
  assert.deepEqual(openPrCountReadingFromRows(rows), { count: 31, source: "max_over_window" });
  assert.deepEqual(openPrCountReadingFromRows([]), { count: undefined, source: undefined });
  assert.deepEqual(openPrCountReadingFromRows([{ ts: ago(1), step: "sweep.pass", enumerated: "x" }]),
    { count: undefined, source: undefined }, "a row with no count is not a count");
  const verdict = decideProgressWatchdog({ rows, nowMs: NOW, openPrCount: 31, openPrCountSource: "max_over_window" });
  assert.match(renderProgressWatchdogVerdict(verdict), /with 31 open PR\(s\) \(count: max_over_window\)/);
  assert.equal(verdict.openPrCountSource, "max_over_window");
});

test("W1-T9702: runSweep names its surface on the sweep.pass row, full or light", async () => {
  const rows: Row[] = [];
  const deps = (surface?: "full" | "light") => ({
    arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    ledgerPath: "/dev/null/ledger.ndjson", runId: "ida", dryRun: true,
    ...(surface ? { repairAdmissionSurface: surface } : {}),
    readLedger: () => [], appendLine: () => {},
    log: (step: string, data?: Record<string, unknown>) => { if (step === "sweep.pass") rows.push({ ...data }); },
  });
  await runSweep([], deps("full"), DEFAULT_SWEEP_POLICY);
  await runSweep([], deps("light"), DEFAULT_SWEEP_POLICY);
  await runSweep([], deps(), DEFAULT_SWEEP_POLICY);
  assert.equal(rows.length, 3, "positive control: every pass wrote its heartbeat");
  assert.deepEqual(rows.map((row) => row.surface), ["full", "light", undefined]);
  assert.deepEqual(rows.map((row) => row.enumerated), [0, 0, 0]);
});
