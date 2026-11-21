/**
 * W1-T13203: serve's request loop was blocked for 14.8 minutes on 2026-11-16 and the loop-lag invariant never named
 * it: runtime.loop_lag at 14:39:37Z had p99Ms 108.6 and maxMs 887,447.6, and the rule read only p99Ms.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createHistogram } from "node:perf_hooks";
import { test } from "node:test";
import type { Worker } from "node:worker_threads";
import { fixedClock } from "#src/lib/clock.js";
import { evaluateIncidentInvariants, LOOP_LAG_MAX_STALL_BOUND_MS, LOOP_LAG_P99_BOUND_MS,
  LOOP_LAG_RULE_ID, RUNTIME_LOOP_LAG_STEP, RUNTIME_LOOP_STALL_PROFILE_STEP } from "#src/lib/incident-invariants.js";
import { appendLedger } from "#src/lib/ledger.js";
import type { StallFold } from "#src/lib/loop-stall-profiler.js";
import { INCIDENT_INVARIANTS_INTERVAL_MS, startIncidentInvariantsMonitor } from "#src/lib/serve.js";
import { readLedgerLines } from "#src/lib/status.js";
import { withTempDir } from "#src/lib/tmp.js";

const NOW = Date.parse("2026-11-16T14:45:00.000Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const lag = (minutesAgo: number, p99Ms: number, maxMs: number) =>
  ({ ts: at(minutesAgo), run_id: `RUNTIME-${NOW - minutesAgo * 60_000}`, task_id: "INCIDENT", step: "runtime.loop_lag", p50Ms: 20, p99Ms, maxMs, windowMs: 60_000 });
const loopLag = (rows: Array<Record<string, unknown>>) => evaluateIncidentInvariants(rows, NOW).find((finding) => finding.ruleId === LOOP_LAG_RULE_ID);

test("W1-T13203 criterion 1: one stall over the max bound is bad even with p99 at 108 ms, and the message names it", () => {
  const rows = [lag(10, 108.6, 200), lag(5, 108.6, 300), lag(0.5, 108.6, 887_447.6)];
  const finding = loopLag(rows);
  assert.ok(finding, "the loop-lag rule fires on the one long stall");
  assert.match(finding.message, /p99=108\.6ms/);
  assert.match(finding.message, new RegExp(`max=887447\\.6ms, bound=${LOOP_LAG_MAX_STALL_BOUND_MS}ms`));
});

for (const callbackOffsetMs of [-5, 5]) {
  test(`W1-T13203 criterion 2: Serve attributes the long stall when the profile arrives ${callbackOffsetMs}ms from the lag tick`, async () => {
    await withTempDir("serve-long-stall", (dir) => {
      const path = join(dir, "ledger.ndjson");
      const watchdog = Object.assign(new EventEmitter(), { unref() {}, async terminate() { return 0; } });
      const intervalMs = INCIDENT_INVARIANTS_INTERVAL_MS;
      const silentMs = 887_100;
      const histogram = createHistogram();
      histogram.record(silentMs * 1e6);
      const maxMs = Math.round(histogram.max / 1e5) / 10;
      const inclusive: StallFold["inclusive"] = new Map([
        ["classifyAllProposals", { frame: { function: "classifyAllProposals", url: "file:///src/panel-graph.ts", line: 1 }, us: 880_000_000 }],
        ["loadPlan", { frame: { function: "loadPlan", url: "file:///src/plan.ts", line: 1 }, us: 4_000_000 }],
        ["readJson", { frame: { function: "readJson", url: "file:///src/fs.ts", line: 1 }, us: 1_000_000 }],
        ["fourth", { frame: { function: "fourth", url: "file:///src/y.ts", line: 1 }, us: 10_000 }],
      ]);
      const fold: StallFold = {
        chunks: 1, profiledUs: 885_010_000, inclusive,
        self: new Map(), callers: new Map(), syncSpawn: new Map(), syncSpawnUs: 0,
      };
      let nowMs = NOW - silentMs;
      let tick: (() => void) | undefined;
      const stop = startIncidentInvariantsMonitor(path, {
        clock: { now: () => nowMs, date: () => new Date(nowMs), iso: () => new Date(nowMs).toISOString() },
        eventLoopLag: () => ({
          p50Ms: 20, p99Ms: 108.6, maxMs: nowMs === NOW ? maxMs : 200,
          windowMs: nowMs === NOW ? silentMs : intervalMs,
        }),
        setInterval: ((cb: () => void) => {
          tick = cb;
          return { unref() {} };
        }) as typeof setInterval,
        clearInterval: () => {},
        writeLedger: (ledger, line, options) =>
          appendLedger(ledger, line, { ...options, clock: options?.clock ?? fixedClock(nowMs) }),
        stallProfiler: { spawn: () => watchdog as unknown as Worker },
      });
      try {
        assert.ok(tick);
        tick();
        const deliverProfile = (offsetMs: number, recoveredAtMs: number) => {
          nowMs = NOW + offsetMs;
          watchdog.emit("message", { kind: "profile", beat: 1, recoveredAtMs,
            silent_ms: silentMs, unprofiled_ms: 1_000, fold });
        };
        // Even with the same duration, a recovery outside the histogram window cannot explain this sample.
        deliverProfile(-5, callbackOffsetMs < 0 ? NOW - 10 : NOW - silentMs - 1_000);
        nowMs = NOW;
        tick();
        const initial = readLedgerLines(path).find((row) => row.name === LOOP_LAG_RULE_ID);
        assert.ok(initial, "the lag tick detects the stall immediately");
        assert.match(String(initial.message), new RegExp(`max=${maxMs}ms`));
        if (callbackOffsetMs > 0) deliverProfile(callbackOffsetMs, NOW - 10);
        nowMs = NOW + intervalMs;
        tick();
        const rows = readLedgerLines(path);
        const long = rows.find((row) => row.step === RUNTIME_LOOP_LAG_STEP && row.maxMs === maxMs);
        assert.ok(long);
        const profiles = rows.filter((row) => row.step === RUNTIME_LOOP_STALL_PROFILE_STEP);
        const profile = profiles.find((row) => row.run_id === long.run_id);
        assert.ok(profile);
        assert.ok(Array.isArray(profile.top_inclusive) && profile.top_inclusive.length === 4);
        if (callbackOffsetMs > 0) {
          assert.equal(profiles.length, 2);
          assert.equal(profiles.filter((row) => row.run_id === long.run_id).length, 1,
            "the out-of-window profile is still written under a separate run ID");
        }
        const incident = rows.filter((row) => row.step === "incident.event" && row.name === LOOP_LAG_RULE_ID).at(-1);
        assert.ok(incident);
        assert.match(String(incident.message),
          /top: classifyAllProposals \(panel-graph\.ts\), loadPlan \(plan\.ts\), readJson \(fs\.ts\)$/);
        const unrelated = { ...profile, run_id: "RUNTIME-1" };
        const withoutMatch = evaluateIncidentInvariants([long, unrelated], nowMs).find((finding) => finding.ruleId === LOOP_LAG_RULE_ID);
        assert.ok(withoutMatch);
        assert.doesNotMatch(withoutMatch.message, /top:/);
      } finally {
        stop();
      }
    });
  });
}

for (const longestFirst of [false, true]) {
  for (const shorterMs of [30_050, 30_100]) {
    test(`W1-T13203 criterion 2: competing stalls (${shorterMs}ms and 30150ms, largest delivered first: ${longestFirst})`, async () => {
      await withTempDir("serve-competing-stalls", (dir) => {
        const path = join(dir, "ledger.ndjson");
        const watchdog = Object.assign(new EventEmitter(), { unref() {}, async terminate() { return 0; } });
        const intervalMs = INCIDENT_INVARIANTS_INTERVAL_MS;
        let nowMs = NOW - 65_000;
        let tick: (() => void) | undefined;
        const stop = startIncidentInvariantsMonitor(path, {
          clock: { now: () => nowMs, date: () => new Date(nowMs), iso: () => new Date(nowMs).toISOString() },
          eventLoopLag: () => ({ p50Ms: 20, p99Ms: 108.6, maxMs: nowMs === NOW ? 30_150 : 200, windowMs: 65_000 }),
          setInterval: ((cb: () => void) => { tick = cb; return { unref() {} }; }) as unknown as typeof setInterval,
          clearInterval: () => {},
          writeLedger: (ledger, line, options) =>
            appendLedger(ledger, line, { ...options, clock: options?.clock ?? fixedClock(nowMs) }),
          stallProfiler: { spawn: () => watchdog as unknown as Worker },
        });
        const deliver = (longest: boolean) => {
          const silentMs = longest ? 30_150 : shorterMs;
          const frame = longest ? { function: "classifyAllProposals", url: "file:///src/panel-graph.ts", line: 1 }
            : { function: "shorterStall", url: "file:///src/shorter.ts", line: 1 };
          const fold: StallFold = {
            chunks: 1, profiledUs: 29_000_000,
            inclusive: new Map([[frame.function, { frame, us: 29_000_000 }]]),
            self: new Map(), callers: new Map(), syncSpawn: new Map(), syncSpawnUs: 0,
          };
          watchdog.emit("message", { kind: "profile", beat: longest ? 2 : 1,
            recoveredAtMs: longest ? NOW - 10 : NOW - 32_000, silent_ms: silentMs, unprofiled_ms: 1_000, fold });
        };
        try {
          assert.ok(tick);
          tick();
          nowMs = NOW - 5;
          deliver(longestFirst);
          nowMs = NOW;
          tick();
          deliver(!longestFirst); // Same clock millisecond as the histogram row, after its append.
          nowMs += intervalMs;
          tick();

          const rows = readLedgerLines(path);
          const long = rows.find((row) => row.step === RUNTIME_LOOP_LAG_STEP && row.maxMs === 30_150);
          assert.ok(long);
          const profiles = rows.filter((row) => row.step === RUNTIME_LOOP_STALL_PROFILE_STEP);
          assert.deepEqual(profiles.map((row) => row.lag_ms).sort(), [shorterMs, 30_150]);
          const linked = profiles.filter((row) => row.run_id === long.run_id);
          const incidents = rows.filter((row) => row.step === "incident.event" && row.name === LOOP_LAG_RULE_ID);
          assert.equal(incidents.length, 2);
          for (const incident of incidents) {
            assert.match(String(incident.message), /max=30150ms/);
            assert.doesNotMatch(String(incident.message), /shorterStall/);
          }
          if (shorterMs === 30_100) {
            assert.deepEqual(linked, [], "both durations fit the timer tolerance, so neither profile claims the maximum");
            assert.ok(incidents.every((incident) => !String(incident.message).includes("top:")));
          } else {
            assert.deepEqual(linked.map((row) => row.lag_ms), [30_150]);
            assert.match(String(incidents.at(-1)?.message), /top: classifyAllProposals \(panel-graph\.ts\)$/);
          }
        } finally {
          stop();
        }
      });
    });
  }
}

test("W1-T13203 criterion 2: legacy lag runs with duplicate profile rows remain unattributed", () => {
  const reading = lag(0.5, 108.6, 30_150);
  const profile = { ts: reading.ts, run_id: reading.run_id, step: RUNTIME_LOOP_STALL_PROFILE_STEP,
    top_inclusive: [{ function: "classifyAllProposals", url: "file:///src/panel-graph.ts" }] };
  assert.match(loopLag([reading, profile])?.message ?? "", /top: classifyAllProposals \(panel-graph\.ts\)/);
  const duplicate = { ...profile, top_inclusive: [{ function: "shorterStall", url: "file:///src/shorter.ts" }] };
  const finding = loopLag([reading, duplicate, profile]);
  assert.ok(finding);
  assert.doesNotMatch(finding.message, /top:/);
});

test("W1-T13203 criterion 3: invariant:p99-path-unchanged — a p99 breach under the max bound reads as before", () => {
  const p99 = loopLag([lag(10, LOOP_LAG_P99_BOUND_MS + 100, 2_000), lag(0.5, LOOP_LAG_P99_BOUND_MS + 100, 2_000)]);
  assert.ok(p99);
  assert.equal(p99.message, `p99=${LOOP_LAG_P99_BOUND_MS + 100}ms over 2 sample(s), bound=${LOOP_LAG_P99_BOUND_MS}ms`);
  const healthy = lag(0.5, LOOP_LAG_P99_BOUND_MS - 1, LOOP_LAG_MAX_STALL_BOUND_MS - 1);
  assert.equal(loopLag([lag(10, 100, 2_000), healthy]), undefined, "under both bounds is not bad");
});

test("W1-T13203 criterion 2: a long stall profile still waiting for its lag sample is written when the monitor stops", async () => {
  await withTempDir("serve-long-stall-stop", (dir) => {
    const path = join(dir, "ledger.ndjson");
    const watchdog = Object.assign(new EventEmitter(), { unref() {}, async terminate() { return 0; } });
    const silentMs = 35_000;
    const fold: StallFold = {
      chunks: 1, profiledUs: 34_000_000,
      inclusive: new Map([["classifyAllProposals", { frame: { function: "classifyAllProposals", url: "file:///src/panel-graph.ts", line: 1 }, us: 34_000_000 }]]),
      self: new Map(), callers: new Map(), syncSpawn: new Map(), syncSpawnUs: 0,
    };
    let nowMs = NOW - INCIDENT_INVARIANTS_INTERVAL_MS;
    let tick: (() => void) | undefined;
    const stop = startIncidentInvariantsMonitor(path, {
      clock: { now: () => nowMs, date: () => new Date(nowMs), iso: () => new Date(nowMs).toISOString() },
      eventLoopLag: () => ({ p50Ms: 20, p99Ms: 108.6, maxMs: 200, windowMs: INCIDENT_INVARIANTS_INTERVAL_MS }),
      setInterval: ((cb: () => void) => { tick = cb; return { unref() {} }; }) as unknown as typeof setInterval,
      clearInterval: () => {},
      writeLedger: (ledger, line, options) => appendLedger(ledger, line, { ...options, clock: options?.clock ?? fixedClock(nowMs) }),
      stallProfiler: { spawn: () => watchdog as unknown as Worker },
    });
    assert.ok(tick);
    tick(); // the profiler is watching from serve's first lag reading
    nowMs = NOW;
    // A replay: the completed profile arrives before the lag tick that would place it, then serve stops.
    watchdog.emit("message", { kind: "profile", beat: 1, recoveredAtMs: NOW - 10, silent_ms: silentMs, unprofiled_ms: 1_000, fold });
    assert.equal(readLedgerLines(path).filter((row) => row.step === RUNTIME_LOOP_STALL_PROFILE_STEP).length, 0,
      "positive control: the profile waits for its lag sample");
    nowMs = NOW + 5;
    stop();
    const profiles = readLedgerLines(path).filter((row) => row.step === RUNTIME_LOOP_STALL_PROFILE_STEP);
    assert.equal(profiles.length, 1, "the completed profile was written at stop");
    assert.ok(Array.isArray(profiles[0]!.top_inclusive) && profiles[0]!.top_inclusive.length === 1);
  });
});

for (const stderrFails of [false, true]) {
  test(`W1-T13203: a refused profile append cannot interrupt shutdown (stderr fails: ${stderrFails})`, async (t) => {
    await withTempDir("serve-long-stall-stop-refused", (dir) => {
      const path = join(dir, "ledger.ndjson");
      const watchdog = Object.assign(new EventEmitter(), { unref() {}, async terminate() { return 0; } });
      const fold: StallFold = {
        chunks: 1, profiledUs: 34_000_000, inclusive: new Map(),
        self: new Map(), callers: new Map(), syncSpawn: new Map(), syncSpawnUs: 0,
      };
      let nowMs = NOW - INCIDENT_INVARIANTS_INTERVAL_MS;
      let tick: (() => void) | undefined;
      let ledgerLogCalls = 0;
      const stderr = t.mock.method(console, "error", () => {
        if (stderrFails) throw new Error("stderr unavailable");
      });
      const stop = startIncidentInvariantsMonitor(path, {
        clock: { now: () => nowMs, date: () => new Date(nowMs), iso: () => new Date(nowMs).toISOString() },
        eventLoopLag: () => ({ p50Ms: 20, p99Ms: 108.6, maxMs: 200, windowMs: INCIDENT_INVARIANTS_INTERVAL_MS }),
        setInterval: ((cb: () => void) => { tick = cb; return { unref() {} }; }) as unknown as typeof setInterval,
        clearInterval: () => {},
        stallProfiler: { spawn: () => watchdog as unknown as Worker },
        log: (step, extra) => {
          ledgerLogCalls++;
          appendLedger(path, { run_id: "SERVE-test", task_id: "SERVE", step, lane: "serve", ...extra });
        },
      });
      assert.ok(tick);
      tick();
      nowMs = NOW;
      watchdog.emit("message", { kind: "profile", beat: 1, recoveredAtMs: NOW - 10, silent_ms: 35_000, unprofiled_ms: 1_000, fold });
      renameSync(path, join(dir, "previous.ndjson"));
      mkdirSync(path);

      assert.doesNotThrow(stop);
      assert.equal(ledgerLogCalls, 0, "shutdown diagnostics bypass the ledger logger");
      assert.equal(stderr.mock.callCount(), 1);
      const [message, detail] = stderr.mock.calls[0]!.arguments;
      assert.equal(message, "serve: failed to flush pending loop-stall profiles");
      assert.match(String(detail), /EISDIR/);
    });
  });
}
