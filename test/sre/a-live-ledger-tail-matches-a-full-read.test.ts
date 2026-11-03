import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { evaluateIncidentInvariants, INCIDENT_LONGEST_WINDOW_MS, LOOP_LAG_RULE_ID } from "#src/lib/incident-invariants.js";
import { createLiveLedgerTail } from "#src/lib/live-ledger-tail.js";
import { startIncidentInvariantsMonitor } from "#src/lib/serve.js";
import { readLedgerLines } from "#src/lib/status.js";
import { withTempDir } from "#src/lib/tmp.js";

const RETAIN_MS = 2 * INCIDENT_LONGEST_WINDOW_MS;
const row = (atMs: number, step: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ts: new Date(atMs).toISOString(), step, ...extra });
const lagRow = (atMs: number, p99Ms: number) => row(atMs, "runtime.loop_lag", { p99Ms, maxMs: p99Ms, p50Ms: 10 });

/** What a full read gives the evaluator: every row, then only those a window could reach. */
function fullRead(path: string, nowMs: number) {
  const rows = readLedgerLines(path).filter((r) => {
    const t = typeof r.ts === "string" ? Date.parse(r.ts) : Number.NaN;
    return Number.isFinite(t) && t > nowMs - RETAIN_MS;
  });
  return { rows, findings: evaluateIncidentInvariants(readLedgerLines(path), nowMs) };
}

function assertSameAsFullRead(tail: ReturnType<typeof createLiveLedgerTail>, path: string, nowMs: number, label: string) {
  const got = tail(nowMs);
  const want = fullRead(path, nowMs);
  assert.deepEqual(got.filter((r) => typeof r.ts === "string" && Date.parse(r.ts) > nowMs - RETAIN_MS), want.rows, `${label}: rows`);
  assert.deepEqual(evaluateIncidentInvariants(got, nowMs), want.findings, `${label}: findings`);
}

test("W1-T11210 criterion 1: the tail returns what a full read returns across appends, a pending line, a torn line, rotation, truncation and deletion", async (t) => {
  t.mock.method(console, "error", () => {});
  await withTempDir("live-ledger-tail", (dir) => {
    const path = join(dir, "ledger.ndjson");
    const nowMs = Date.now();
    const tail = createLiveLedgerTail(path, RETAIN_MS);
    assert.deepEqual(tail(nowMs), [], "a missing ledger reads as no rows");

    writeFileSync(path, [row(nowMs - RETAIN_MS - 60_000, "too.old"), lagRow(nowMs - 10 * 60_000, 900), "{\"no\":\"ts\"}"].join("\n") + "\n");
    assertSameAsFullRead(tail, path, nowMs, "first read");

    appendFileSync(path, lagRow(nowMs - 60_000, 950) + "\n" + "{torn" + "\n");
    assertSameAsFullRead(tail, path, nowMs, "append with a torn complete line");

    appendFileSync(path, lagRow(nowMs - 30_000, 990));
    assertSameAsFullRead(tail, path, nowMs, "a complete row with no newline yet");
    assert.equal(evaluateIncidentInvariants(tail(nowMs), nowMs).some((f) => f.ruleId === LOOP_LAG_RULE_ID), true, "positive control: the loop-lag rule fires");
    appendFileSync(path, "\n" + "{\"ts\":\"" + new Date(nowMs).toISOString());
    assertSameAsFullRead(tail, path, nowMs, "the pending row completed, a new one half written");

    const next = join(dir, "ledger.next");
    writeFileSync(next, lagRow(nowMs - 20_000, 100) + "\n");
    renameSync(next, path);
    assertSameAsFullRead(tail, path, nowMs, "rotation renamed a new live file into place");

    writeFileSync(path, lagRow(nowMs - 5_000, 200) + "\n" + lagRow(nowMs - 4_000, 210) + "\n");
    appendFileSync(path, lagRow(nowMs - 3_000, 220) + "\n");
    writeFileSync(path, lagRow(nowMs - 2_000, 230) + "\n");
    assertSameAsFullRead(tail, path, nowMs, "the same file truncated in place");

    rmSync(path);
    assert.deepEqual(tail(nowMs), [], "a deleted ledger reads as no rows");
    writeFileSync(path, lagRow(nowMs - 1_000, 240) + "\n");
    assertSameAsFullRead(tail, path, nowMs, "a recreated ledger");
  });
});

test("W1-T11210 criterion 2: a read error clears the tail and is rethrown, and a call with no new bytes parses nothing", async (t) => {
  t.mock.method(console, "error", () => {});
  await withTempDir("live-ledger-tail-error", (dir) => {
    const path = join(dir, "ledger.ndjson");
    const nowMs = Date.now();
    const tail = createLiveLedgerTail(path, RETAIN_MS);
    writeFileSync(path, lagRow(nowMs - 60_000, 900) + "\n");
    assert.equal(tail(nowMs).length, 1);

    const parse = t.mock.method(JSON, "parse");
    assert.equal(tail(nowMs).length, 1);
    assert.equal(parse.mock.callCount(), 0, "an unchanged ledger is not parsed again");
    parse.mock.restore();

    rmSync(path);
    mkdirSync(path);
    assert.throws(() => tail(nowMs), "an unreadable ledger rethrows, as readLedgerLines does");
    rmSync(path, { recursive: true });
    writeFileSync(path, lagRow(nowMs - 30_000, 300) + "\n");
    assertSameAsFullRead(tail, path, nowMs, "after the error the tail starts over");
  });
});

test("W1-T11210 criterion 3: the monitor's default reader evaluates the real live ledger through the tail", async () => {
  await withTempDir("live-ledger-tail-monitor", (dir) => {
    const path = join(dir, "ledger.ndjson");
    const nowMs = Date.now();
    writeFileSync(path, [lagRow(nowMs - 10 * 60_000, 900), lagRow(nowMs - 60_000, 950)].join("\n") + "\n");
    let tick: (() => void) | undefined;
    const written: Array<Record<string, unknown>> = [];
    const stop = startIncidentInvariantsMonitor(path, {
      clock: { now: () => nowMs, date: () => new Date(nowMs), iso: () => new Date(nowMs).toISOString() },
      eventLoopLag: () => undefined,
      writeLedger: ((_: string, line: Record<string, unknown>) => { written.push(line); }) as never,
      setInterval: ((fn: () => void) => { tick = fn; return { unref() {} }; }) as never,
      clearInterval: (() => {}) as never,
    });
    try {
      tick!();
      assert.ok(written.some((line) => line.step === "incident.event" && line.name === LOOP_LAG_RULE_ID),
        `the loop-lag finding is ledgered from the file: ${JSON.stringify(written)}`);
    } finally {
      stop();
    }
  });
});
