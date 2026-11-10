import assert from "node:assert/strict";
import fs, { appendFileSync, renameSync, truncateSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  DAEMON_LOOP_SILENT_RULE_ID,
  DISPATCH_STALL_RULE_ID,
  evaluateIncidentInvariants,
  INCIDENT_LONGEST_WINDOW_MS,
  invariantFindingLedgerLine,
  LOOP_LAG_RULE_ID,
  NO_MERGES_WITH_GREEN_QUEUE_RULE_ID,
  REPEATED_REFUSAL_RULE_ID,
  SERVE_MEMORY_HEADROOM_RULE_ID,
} from "#src/lib/incident-invariants.js";
import { INCIDENT_INVARIANTS_TAIL_RETAIN_MS, startIncidentInvariantsMonitor } from "#src/lib/serve.js";
import { readLedgerLines } from "#src/lib/status.js";
import { withTempDir } from "#src/lib/tmp.js";

// A fixed base instant: every row and every tick runs on the injected clock, never on real time.
const BASE_MS = Date.UTC(2026, 9, 1, 0, 0, 0);
const MINUTE_MS = 60_000;
// live-ledger-tail.ts re-checks and re-records a 64-byte head and a 64-byte anchor around each read.
const ANCHOR_READ_BYTES = 4 * 64;

const row = (atMs: number, step: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ ts: new Date(atMs).toISOString(), step, ...extra });
const lagRow = (atMs: number, p99Ms: number): string => row(atMs, "runtime.loop_lag", { p99Ms, maxMs: p99Ms, p50Ms: 10 });

/** The verdicts the monitor's old route produced: every row of the declared tail, re-read from byte 0. */
function fullReTailFindings(path: string, nowMs: number, crossCheck = true) {
  const all = readLedgerLines(path);
  const tail = all.filter((r) => {
    const t = typeof r.ts === "string" ? Date.parse(r.ts) : Number.NaN;
    return Number.isFinite(t) && t > nowMs - INCIDENT_INVARIANTS_TAIL_RETAIN_MS;
  });
  const findings = evaluateIncidentInvariants(tail, nowMs);
  if (crossCheck) {
    assert.deepEqual(findings, evaluateIncidentInvariants(all, nowMs), "the declared tail holds every row a verdict can read");
  }
  return findings.map((finding) => invariantFindingLedgerLine(finding, nowMs));
}

/** The real monitor on its default reader, driven tick by tick on an injected clock. */
function startMonitor(path: string, opts: { appendOwnRows?: boolean } = {}) {
  let nowMs = BASE_MS;
  let tick: (() => void) | undefined;
  let written: Array<Record<string, unknown>> = [];
  let own: string[] = [];
  const stop = startIncidentInvariantsMonitor(path, {
    clock: { now: () => nowMs, date: () => new Date(nowMs), iso: () => new Date(nowMs).toISOString() },
    eventLoopLag: () => undefined,
    writeLedger: ((ledgerPath: string, line: Record<string, unknown>) => {
      written.push(line);
      // Serve's own finding rows land in the same live ledger the next tick reads, once the line in flight ends.
      if (opts.appendOwnRows) own.push(JSON.stringify({ ts: new Date(nowMs).toISOString(), ...line }) + "\n");
    }) as never,
    setInterval: ((fn: () => void) => { tick = fn; return { unref() {} }; }) as never,
    clearInterval: (() => {}) as never,
  });
  return {
    stop,
    tickAt(atMs: number): Array<Record<string, unknown>> {
      nowMs = atMs;
      written = [];
      tick!();
      return written;
    },
    flushOwnRows(): void {
      for (const line of own) appendFileSync(path, line);
      own = [];
    },
  };
}

/** Bytes `node:fs` readSync returned while `fn` ran: the monitor's whole ledger read cost for one tick. */
function bytesReadDuring(t: TestContext, fn: () => void): number {
  let bytes = 0;
  const real = fs.readSync;
  const spy = t.mock.method(fs, "readSync", (...args: Parameters<typeof fs.readSync>) => {
    const n = (real as (...a: unknown[]) => number)(...args);
    bytes += n;
    return n;
  });
  syncBuiltinESMExports();
  try {
    fn();
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
  return bytes;
}

test("W1-T11936 criterion 1: a tick reads only the bytes appended since the previous tick and evaluates what a full re-tail would", async (t) => {
  await withTempDir("incident-monitor-incremental", (dir) => {
    const path = join(dir, "ledger.ndjson");
    const history: string[] = [];
    for (let m = 0; m < 3_000; m++) history.push(row(BASE_MS + m * 1_000, "serve.memory", { headroom: 0.9, rss_bytes: 1_000 + m }));
    writeFileSync(path, history.join("\n") + "\n");
    const size = fs.statSync(path).size;
    const monitor = startMonitor(path);
    try {
      let nowMs = BASE_MS + 3_000 * 1_000;
      let findings: Array<Record<string, unknown>> = [];
      const first = bytesReadDuring(t, () => { findings = monitor.tickAt(nowMs); });
      assert.ok(first >= size, `the first tick reads the whole ledger: ${first} of ${size} bytes`);
      assert.deepEqual(findings, fullReTailFindings(path, nowMs), "first tick: verdicts");

      const idle = bytesReadDuring(t, () => { findings = monitor.tickAt(nowMs += MINUTE_MS); });
      assert.ok(idle <= ANCHOR_READ_BYTES, `a tick over no new bytes reads only its anchors: ${idle} bytes`);
      assert.deepEqual(findings, fullReTailFindings(path, nowMs), "idle tick: verdicts");

      for (let k = 0; k < 3; k++) {
        const appended = [lagRow(nowMs + 1_000, 900), lagRow(nowMs + 2_000, 950)].join("\n") + "\n";
        appendFileSync(path, appended);
        const read = bytesReadDuring(t, () => { findings = monitor.tickAt(nowMs += MINUTE_MS); });
        const added = Buffer.byteLength(appended);
        assert.ok(read >= added && read <= added + ANCHOR_READ_BYTES,
          `tick ${k}: read ${read} bytes for ${added} appended, of a ${fs.statSync(path).size}-byte ledger`);
        assert.deepEqual(findings, fullReTailFindings(path, nowMs), `tick ${k}: verdicts`);
      }
      assert.ok(findings.some((line) => line.name === LOOP_LAG_RULE_ID),
        `positive control: the appended rows alone fire the loop-lag rule: ${JSON.stringify(findings)}`);
    } finally {
      monitor.stop();
    }
  });
});

test("W1-T11936 criterion 2: a rotation, a truncation or an offset past the end falls back to a full bounded tail and skips no row", async (t) => {
  t.mock.method(console, "error", () => {});
  await withTempDir("incident-monitor-fallback", (dir) => {
    const path = join(dir, "ledger.ndjson");
    let nowMs = BASE_MS + 60 * MINUTE_MS;
    const quiet = (count: number) => Array.from({ length: count }, (_, i) => lagRow(nowMs - (count - i) * 1_000, 20));
    // Bad samples sit at the START of each new content: a reader resuming at the old offset would skip them.
    const spike = (count: number) => Array.from({ length: count }, (_, i) => lagRow(nowMs - 70_000 + i * 1_000, 900 + i));
    const samples = (findings: Array<Record<string, unknown>>) =>
      String(findings.find((line) => line.name === LOOP_LAG_RULE_ID)?.message ?? "");
    const monitor = startMonitor(path);
    try {
      writeFileSync(path, quiet(400).join("\n") + "\n");
      let findings = monitor.tickAt(nowMs);
      assert.deepEqual(findings, fullReTailFindings(path, nowMs), "first read: verdicts");
      assert.equal(samples(findings), "", "a quiet ledger fires no loop-lag finding");

      nowMs += MINUTE_MS;
      const next = join(dir, "ledger.next");
      writeFileSync(next, [...spike(3), ...quiet(500)].join("\n") + "\n");
      renameSync(next, path);
      findings = monitor.tickAt(nowMs);
      assert.deepEqual(findings, fullReTailFindings(path, nowMs), "rotation: verdicts");
      assert.match(samples(findings), /p99=902ms over 503 sample/, "rotation: every row of the new file is read");

      nowMs += MINUTE_MS;
      writeFileSync(path, [...spike(2), ...quiet(5)].join("\n") + "\n");
      findings = monitor.tickAt(nowMs);
      assert.deepEqual(findings, fullReTailFindings(path, nowMs), "truncation in place: verdicts");
      assert.match(samples(findings), /p99=901ms over 7 sample/, "truncation in place: every row is read");

      nowMs += MINUTE_MS;
      appendFileSync(path, quiet(300).join("\n") + "\n");
      monitor.tickAt(nowMs);
      const offsetBytes = fs.statSync(path).size;
      truncateSync(path, 0);
      nowMs += MINUTE_MS;
      appendFileSync(path, [...spike(4), ...quiet(2)].join("\n") + "\n");
      findings = monitor.tickAt(nowMs);
      assert.ok(fs.statSync(path).size < offsetBytes, "the last tick's offset lies past the end of the shortened file");
      assert.deepEqual(findings, fullReTailFindings(path, nowMs), "offset past the end: verdicts");
      assert.match(samples(findings), /p99=903ms over 6 sample/, "offset past the end: every row is read");

      nowMs += MINUTE_MS;
      const size = fs.statSync(path).size;
      const rewritten = [...spike(5), ...quiet(40)].join("\n") + "\n";
      writeFileSync(path, rewritten);
      assert.ok(Buffer.byteLength(rewritten) > size, "a rewrite in place that grew past the old offset");
      findings = monitor.tickAt(nowMs);
      assert.deepEqual(findings, fullReTailFindings(path, nowMs), "rewrite in place: verdicts");
      assert.match(samples(findings), /p99=904ms over 45 sample/, "rewrite in place: every row is read");
    } finally {
      monitor.stop();
    }
  });
});

/** A deterministic ten-hour ledger recording that, minute by minute, drives every invariant rule to fire. */
function recordedMinutes(): Array<{ atMs: number; lines: string[] }> {
  const minutes: Array<{ atMs: number; lines: string[] }> = [];
  for (let m = 0; m < 600; m++) {
    const at = BASE_MS + m * MINUTE_MS;
    const lines: string[] = [lagRow(at + 1_000, m >= 60 && m < 100 ? 900 : 20)];
    if ((m < 200 || m >= 240) && m % 5 === 0) lines.push(row(at + 2_000, "daemon.pulse"));
    if (m < 120 && m % 5 === 0) lines.push(row(at + 3_000, "dispatch.settled_set", { fulfilled: 1 }));
    if (m >= 120 && m < 400 && m % 10 === 0) lines.push(row(at + 4_000, "dispatch.lane_refill_held"));
    if (m === 420) lines.push(row(at + 4_000, "run.start", { type: "implement" }));
    if (m >= 300 && m <= 302) lines.push(row(at + 5_000, "merge_refused", { reason: "base-red" }));
    if (m % 10 === 0) lines.push(row(at + 6_000, "sweep.disposed", { blocker: "awaiting-arm", pr_number: 5 }));
    if (m === 10 || m === 450) lines.push(row(at + 7_000, "verdict.merged"));
    if (m % 3 === 0) lines.push(row(at + 8_000, "serve.memory", { headroom: m >= 480 && m < 560 ? 0.1 : 0.6 }));
    if (m % 37 === 0) lines.push(JSON.stringify({ step: "fix.dispatch" }));
    if (m === 333) lines.push("{torn");
    minutes.push({ atMs: at, lines });
  }
  return minutes;
}

test("W1-T11936 criterion 3: the monitor's verdicts over a recorded ledger replay are identical to the full re-tail verdicts", async (t) => {
  t.mock.method(console, "error", () => {});
  await withTempDir("incident-monitor-replay", (dir) => {
    const path = join(dir, "ledger.ndjson");
    writeFileSync(path, "");
    const fired = new Set<unknown>();
    let ticks = 0;
    const monitor = startMonitor(path, { appendOwnRows: true });
    try {
      for (const [i, minute] of recordedMinutes().entries()) {
        const text = minute.lines.join("\n") + "\n";
        // Every seventh minute a writer is caught mid-line: half its bytes land before the tick, the rest after.
        const cut = i % 7 === 0 ? Math.floor(text.length / 2) : text.length;
        appendFileSync(path, text.slice(0, cut));
        const nowMs = minute.atMs + 30_000;
        const want = fullReTailFindings(path, nowMs, i % 60 === 0);
        const got = monitor.tickAt(nowMs);
        assert.deepEqual(got, want, `minute ${i}: the monitor's verdicts`);
        for (const line of got) fired.add(line.name);
        appendFileSync(path, text.slice(cut));
        monitor.flushOwnRows();
        ticks += 1;
      }
    } finally {
      monitor.stop();
    }
    assert.equal(ticks, 600, "every recorded minute was replayed");
    assert.deepEqual([...fired].sort(), [
      DAEMON_LOOP_SILENT_RULE_ID, DISPATCH_STALL_RULE_ID, LOOP_LAG_RULE_ID,
      NO_MERGES_WITH_GREEN_QUEUE_RULE_ID, REPEATED_REFUSAL_RULE_ID, SERVE_MEMORY_HEADROOM_RULE_ID,
    ].sort(), "positive control: the recording fires every invariant rule");
  });
});

test("W1-T11936 criterion 4: the tail window stays a declared, finite bound covering every rule window", () => {
  assert.equal(typeof INCIDENT_INVARIANTS_TAIL_RETAIN_MS, "number", "the bound is a declared export of serve.ts");
  assert.ok(Number.isFinite(INCIDENT_INVARIANTS_TAIL_RETAIN_MS), "the bound is finite, never an unbounded tail");
  assert.equal(INCIDENT_INVARIANTS_TAIL_RETAIN_MS, 2 * INCIDENT_LONGEST_WINDOW_MS, "twice the longest rule window");
  assert.ok(INCIDENT_INVARIANTS_TAIL_RETAIN_MS > INCIDENT_LONGEST_WINDOW_MS, "the bound covers every window a rule reads");
});
