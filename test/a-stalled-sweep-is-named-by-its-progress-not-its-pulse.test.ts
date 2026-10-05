import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { fileURLToPath } from "node:url";
import {
  captureDiagnosticsBundle,
  decideProgressWatchdog,
  openPrCountFromRows,
} from "../src/lib/progress-watchdog.js";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const MIN = 60_000;
const ago = (minutes: number): string => new Date(NOW - minutes * MIN).toISOString();
type Row = Record<string, unknown>;

/** daemon.pulse, daemon.loop_lag and runtime.loop_lag every 60 s for the last `minutes` minutes. */
function pulseRows(minutes: number): Row[] {
  const rows: Row[] = [];
  for (let m = minutes; m >= 0; m--) {
    rows.push({ ts: ago(m), step: "daemon.pulse", run_id: "r-live" });
    rows.push({ ts: ago(m), step: "daemon.loop_lag", run_id: "r-live" });
    rows.push({ ts: ago(m), step: "runtime.loop_lag", run_id: "r-live" });
  }
  return rows;
}
const sweepPass = (minutesAgo: number, enumerated: number): Row => ({ ts: ago(minutesAgo), step: "sweep.pass", run_id: "r-sweep", enumerated });

test("a fixture whose newest sweep.pass is 31 minutes old reads STALLED with action recycle, whatever the pulse says", () => {
  const rows = [sweepPass(31, 4), ...pulseRows(60)];
  const verdict = decideProgressWatchdog({ rows, nowMs: NOW, openPrCount: openPrCountFromRows(rows) });
  assert.equal(verdict.state, "STALLED");
  assert.equal(verdict.action, "recycle");
  assert.equal(Math.round((verdict.progressAgeMs ?? 0) / MIN), 31);
});

test("at 16 minutes it reads STALLED with action capture-diagnostics", () => {
  const rows = [sweepPass(16, 4), ...pulseRows(60)];
  const verdict = decideProgressWatchdog({ rows, nowMs: NOW, openPrCount: openPrCountFromRows(rows) });
  assert.equal(verdict.state, "STALLED");
  assert.equal(verdict.action, "capture-diagnostics");
});

test("a sweep.pass 5 minutes old reads PROGRESSING with no action", () => {
  const rows = [sweepPass(5, 4)];
  const verdict = decideProgressWatchdog({ rows, nowMs: NOW, openPrCount: 4 });
  assert.deepEqual([verdict.state, verdict.action], ["PROGRESSING", "none"]);
});

test("review.posted and verdict.merged count as progress; the newest of the three wins", () => {
  const rows = [sweepPass(40, 4), { ts: ago(20), step: "review.posted", run_id: "r" }, { ts: ago(3), step: "verdict.merged", run_id: "r" }];
  const verdict = decideProgressWatchdog({ rows, nowMs: NOW, openPrCount: 4 });
  assert.equal(verdict.state, "PROGRESSING");
  assert.equal(Math.round((verdict.progressAgeMs ?? 0) / MIN), 3);
});

test("three daemon.paths boots in 15 minutes with no daemon.boot read CRASH_LOOP with action hold-revive", () => {
  const rows = [
    sweepPass(90, 4),
    { ts: ago(12), step: "daemon.paths", run_id: "b1" },
    { ts: ago(8), step: "daemon.paths", run_id: "b2" },
    { ts: ago(4), step: "daemon.paths", run_id: "b3" },
    ...pulseRows(15),
  ];
  const verdict = decideProgressWatchdog({ rows, nowMs: NOW, openPrCount: 4 });
  assert.equal(verdict.state, "CRASH_LOOP");
  assert.equal(verdict.action, "hold-revive");
  assert.equal(verdict.failedBoots15m, 3);
});

test("boots that reached daemon.boot are not failed boots", () => {
  const rows = [
    sweepPass(2, 4),
    ...["b1", "b2", "b3"].flatMap((run_id, i) => [
      { ts: ago(12 - i * 4), step: "daemon.paths", run_id },
      { ts: ago(11.9 - i * 4), step: "daemon.boot", run_id },
    ]),
  ];
  const verdict = decideProgressWatchdog({ rows, nowMs: NOW, openPrCount: 4 });
  assert.equal(verdict.failedBoots15m, 0);
  assert.equal(verdict.state, "PROGRESSING");
});

test("a daemon.paths row seconds old is still booting, not a failed boot", () => {
  const rows = [
    { ts: ago(12), step: "daemon.paths", run_id: "b1" },
    { ts: ago(8), step: "daemon.paths", run_id: "b2" },
    { ts: new Date(NOW - 10_000).toISOString(), step: "daemon.paths", run_id: "b3" },
  ];
  assert.equal(decideProgressWatchdog({ rows, nowMs: NOW, openPrCount: 4 }).failedBoots15m, 2);
});

test("zero open PRs read IDLE with no action, however old the last progress row", () => {
  const rows = [sweepPass(120, 0), ...pulseRows(5)];
  const verdict = decideProgressWatchdog({ rows, nowMs: NOW, openPrCount: openPrCountFromRows(rows) });
  assert.deepEqual([verdict.state, verdict.action], ["IDLE", "none"]);
});

test("an empty ledger reads UNKNOWN, and so does an unknown open-PR count", () => {
  const empty = decideProgressWatchdog({ rows: [], nowMs: NOW, openPrCount: undefined });
  assert.deepEqual([empty.state, empty.action], ["UNKNOWN", "none"]);
  const noCount = decideProgressWatchdog({ rows: pulseRows(5), nowMs: NOW, openPrCount: undefined });
  assert.deepEqual([noCount.state, noCount.action], ["UNKNOWN", "none"]);
  assert.equal(openPrCountFromRows([{ ts: ago(1), step: "sweep.pass", run_id: "r" }]), undefined);
});

test("falsifier: counting daemon.* rows as progress would read the 31-minute fixture PROGRESSING", () => {
  const rows = [sweepPass(31, 4), ...pulseRows(60)];
  const pulseOnlyNewest = Math.max(...rows.filter((r) => String(r.step).startsWith("daemon.")).map((r) => Date.parse(String(r.ts))));
  assert.ok(NOW - pulseOnlyNewest < 15 * MIN, "the pulse is fresh, so a prefix reader would call this live");
  assert.equal(decideProgressWatchdog({ rows, nowMs: NOW, openPrCount: 4 }).state, "STALLED");
});

test("capture-diagnostics writes one bundle and a second call inside 15 minutes writes none", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}progress-watchdog-`));
  try {
    const rows = [sweepPass(16, 4)];
    const verdict = decideProgressWatchdog({ rows, nowMs: NOW, openPrCount: 4 });
    const calls: string[][] = [];
    const exec = {
      run(file: string, args: string[]): string {
        calls.push([file, ...args]);
        if (args[0] === "ps") return "remudero-tenant\nunrelated\n";
        throw new Error("logs unavailable");
      },
    };
    const first = captureDiagnosticsBundle(dir, NOW, verdict, rows, exec);
    assert.equal(first.written, true);
    assert.match(readFileSync(join(first.dir ?? "", "verdict.json"), "utf8"), /"capture-diagnostics"/);
    assert.match(readFileSync(join(first.dir ?? "", "docker-logs-0.txt"), "utf8"), /logs unavailable/);
    assert.deepEqual(calls.map((c) => c[1]), ["ps", "logs"]);
    const second = captureDiagnosticsBundle(dir, NOW + 5 * MIN, verdict, rows, exec);
    assert.equal(second.written, false);
    const third = captureDiagnosticsBundle(dir, NOW + 16 * MIN, verdict, rows, exec);
    assert.equal(third.written, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rmd progress-watchdog reads the ledger and prints the verdict as JSON without recycling", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}progress-watchdog-verb-`));
  try {
    const nowIso = (minutes: number): string => new Date(Date.now() - minutes * MIN).toISOString();
    const lines = [
      { ts: nowIso(40), step: "sweep.pass", run_id: "r", task_id: "x", enumerated: 3 },
      { ts: nowIso(0.1), step: "daemon.pulse", run_id: "r", task_id: "x" },
    ].map((r) => JSON.stringify(r));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ledger.ndjson"), lines.join("\n") + "\n");
    const entry = join(fileURLToPath(new URL("..", import.meta.url)), "src", "run-task.ts");
    const result = spawnSync(process.execPath, ["--import", "tsx", entry, "progress-watchdog", "--json", "--state-root", dir], { encoding: "utf8", timeout: 120_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const out = JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}") as Row;
    assert.equal(out.state, "STALLED");
    assert.equal(out.action, "recycle");
    assert.equal(existsSync(join(dir, "diagnostics")), false, "a recycle verdict writes no bundle");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
