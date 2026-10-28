// W1-T9390 — OBSERVED 2026-10-14 on the core daemon: every full sweep since #11487 froze the loop for 57-105 s
// inside `sweepEscalationTriage`. It read the WHOLE ledger union synchronously (450 rotations, no step filter, no
// memo), listed issues through the sync `gh` gateway, and copied that history once per open issue. These tests pin
// that the rung's GitHub reads are awaited, that its ledger read parses only what was appended since the last pass,
// and that the read keeps no time window.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { NEEDS_HUMAN_LABEL, FLEET_NOTICE_LABEL, type Escalation, type IssueGateway, type OpenIssue } from "#src/lib/escalate.js";
import type { GhAsyncExecutor } from "#src/lib/github-transport.js";
import { realLedgerFs, type LedgerGrepFsDeps } from "#src/lib/ledger-union.js";
import { createEscalationTriageHistoryReader, ESCALATION_REJUDGED_STEP } from "#src/lib/sweep.js";
import { buildEscalationTriageRuntime, sweepEscalationTriage } from "#src/run-task.js";
import type { Config } from "#src/lib/config.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const DAY = 86_400_000;
const daysAgo = (days: number): string => new Date(Date.now() - days * DAY).toISOString();
const issueUrl = (n: number): string => `https://github.com/o/r/issues/${n}`;

function subject(n: number): Escalation {
  return {
    class: "BLOCKED", taskId: `W1-T${n}`, summary: `W1-T${n}: two strikes exhausted`, detail: "the retry still failed.",
    options: [{ label: "retry", detail: "resume with a fresh worker" }, { label: "abandon", detail: "drop the task" }],
    recommendation: "retry",
  };
}

function birth(n: number, ts: string): Record<string, unknown> {
  return { ts, run_id: `RUN-${n}`, task_id: `W1-T${n}`, step: "escalation.issue_opened", issue_url: issueUrl(n), triage_subject: subject(n) };
}

function noise(tag: string, count: number, days: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({ ts: daysAgo(days), run_id: `${tag}-${i}`, task_id: "W1-T1", step: "heartbeat.tick" }));
}

function openIssue(n: number): OpenIssue {
  return { number: n, url: issueUrl(n), title: subject(n).summary, body: `**Task:** W1-T${n}\n` };
}

function triageContext(ledgerPath: string) {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t9390-root-"));
  const context = { root, config: { root } as Config, owner: "o", repo: "r", ledgerPath, runId: "SWEEP-T9390" };
  const runtime = buildEscalationTriageRuntime(context, {
    readPolicy: () => ({ escalationTriage: { mode: "shadow" } }), readRows: () => [], seenAt: () => undefined, windowMs: () => 1,
    judge: async () => ({ decision: "deliver", reason: "the test judge keeps it visible" }),
  });
  return { context, runtime, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function rejudgedUrls(ledgerPath: string): string[] {
  return readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row.step === ESCALATION_REJUDGED_STEP).map((row) => String(row.issue_url));
}

function countingReads() {
  const counts = { asyncRotationReads: [] as string[], syncRotationReads: 0, gunzips: 0, wholeLiveReads: 0, rangeStarts: [] as number[] };
  const fs: LedgerGrepFsDeps = {
    ...realLedgerFs,
    readFileSync: (path) => {
      if (path.endsWith("ledger.ndjson")) counts.wholeLiveReads += 1;
      else if (!path.includes("rotation-digests") && /ledger\.[^/]*\.ndjson(\.gz)?$/.test(path)) counts.syncRotationReads += 1;
      return realLedgerFs.readFileSync(path);
    },
    gunzipSync: (buf) => (counts.gunzips += 1, realLedgerFs.gunzipSync(buf)),
    readRangeSync: (path, start, end) => (counts.rangeStarts.push(start), realLedgerFs.readRangeSync(path, start, end)),
  };
  const readRotation = async (path: string): Promise<Buffer> => {
    counts.asyncRotationReads.push(path);
    return readFile(path);
  };
  const reset = (): void => {
    counts.asyncRotationReads = [];
    counts.syncRotationReads = 0;
    counts.gunzips = 0;
    counts.wholeLiveReads = 0;
    counts.rangeStarts = [];
  };
  return { counts, fs, readRotation, reset };
}

test("W1-T9390: a slow gh issue list does not block a concurrent timer", async () => {
  const fixture = writeLedger([]);
  const { context, runtime, cleanup } = triageContext(fixture.path);
  const calls: string[][] = [];
  const ticksWhilePending: number[] = [];
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 1);
  const execAsync = (async (_file: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "api") {
      const before = ticks;
      await delay(60);
      ticksWhilePending.push(ticks - before);
      return { stdout: "[]", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  }) as unknown as GhAsyncExecutor;
  const failures: string[] = [];
  try {
    await sweepEscalationTriage(context, [], (step) => { if (/failed/.test(step)) failures.push(step); }, { rows: [], runtime, execAsync });
  } finally {
    clearInterval(timer);
    cleanup();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
  const listed = calls.filter((args) => args[0] === "api" && /\/issues\?labels=/.test(args[1] ?? "")).map((args) => args[1]);
  assert.equal(listed.length, 2, `the injected executor serves every label's issue list (${JSON.stringify(calls)})`);
  assert.ok(listed.some((path) => path.includes(`labels=${encodeURIComponent(NEEDS_HUMAN_LABEL)}`)));
  assert.ok(listed.some((path) => path.includes(`labels=${encodeURIComponent(FLEET_NOTICE_LABEL)}`)));
  assert.equal(ticksWhilePending.length, 2);
  for (const n of ticksWhilePending) assert.ok(n > 0, `a concurrent timer fired while the list was pending (${ticksWhilePending})`);
  assert.deepEqual(failures, []);
});

test("W1-T9390: a second pass parses only what was appended since the first", async (t) => {
  const rotations = [
    { at: daysAgo(30), gz: true, rows: [birth(1, daysAgo(31)), ...noise("a", 20, 31)] },
    { at: daysAgo(20), gz: true, rows: noise("b", 20, 21) },
    { at: daysAgo(10), gz: true, rows: noise("c", 20, 11) },
  ];
  const fixture = writeLedger(noise("live", 10, 2), { rotations });
  const { context, runtime, cleanup } = triageContext(fixture.path);
  t.after(() => { cleanup(); rmSync(fixture.dir, { recursive: true, force: true }); });
  const { counts, fs, readRotation, reset } = countingReads();
  const history = createEscalationTriageHistoryReader({ fs, readFile: readRotation });
  let open: OpenIssue[] = [openIssue(1)];
  const issues = { listOpen: (label: string) => label === NEEDS_HUMAN_LABEL ? open : [] } as unknown as IssueGateway;
  const failures: string[] = [];
  const log = (step: string): void => { if (/failed/.test(step)) failures.push(step); };

  await sweepEscalationTriage(context, [], log, { issues, runtime, history });
  assert.equal(counts.asyncRotationReads.length, 3, `the first pass loads each rotation once, off the loop (${counts.asyncRotationReads})`);
  assert.equal(counts.syncRotationReads + counts.gunzips, 0, "no rotation is read or decompressed on the loop");
  assert.deepEqual(rejudgedUrls(fixture.path), [issueUrl(1)]);

  // A rotation lands, the live file grows with a second issue's birth, and the second issue is open.
  const added = join(fixture.dir, `ledger.${daysAgo(5).replace(/[:.]/g, "-")}.ndjson.gz`);
  writeFileSync(added, gzipSync(Buffer.from(noise("d", 20, 6).map((row) => JSON.stringify(row)).join("\n") + "\n")));
  const liveBytesBefore = readFileSync(fixture.path).length;
  fixture.append([birth(2, daysAgo(1))]);
  open = [openIssue(1), openIssue(2)];
  reset();

  await sweepEscalationTriage(context, [], log, { issues, runtime, history });
  assert.deepEqual(counts.asyncRotationReads, [added], "the second pass loads only the rotation that landed since the first");
  assert.equal(counts.syncRotationReads + counts.gunzips, 0, "no earlier rotation is parsed again");
  assert.equal(counts.wholeLiveReads, 0, "the live file is never read whole again");
  assert.ok(counts.rangeStarts.length > 0 && Math.min(...counts.rangeStarts) > 0,
    `the live file is read from where the first pass stopped (${counts.rangeStarts} of ${liveBytesBefore})`);
  // The first issue's state was judged on the first pass (a row read from the appended tail); only the new one is.
  assert.deepEqual(rejudgedUrls(fixture.path), [issueUrl(1), issueUrl(2)]);
  assert.deepEqual(failures, []);
});

test("W1-T9390: an issue born in the oldest rotation is still rejudged", async (t) => {
  const rotations = [
    { at: daysAgo(90), gz: true, rows: [birth(7, daysAgo(91)), ...noise("old", 5, 91)] },
    { at: daysAgo(45), gz: true, rows: noise("mid", 5, 46) },
    { at: daysAgo(3), gz: true, rows: noise("new", 5, 4) },
  ];
  const fixture = writeLedger(noise("live", 5, 1), { rotations });
  const { context, runtime, cleanup } = triageContext(fixture.path);
  t.after(() => { cleanup(); rmSync(fixture.dir, { recursive: true, force: true }); });
  const issues = { listOpen: (label: string) => label === NEEDS_HUMAN_LABEL ? [openIssue(7)] : [] } as unknown as IssueGateway;
  const failures: string[] = [];
  await sweepEscalationTriage(context, [], (step) => { if (/failed/.test(step)) failures.push(step); },
    { issues, runtime, history: createEscalationTriageHistoryReader() });
  assert.deepEqual(rejudgedUrls(fixture.path), [issueUrl(7)]);
  assert.deepEqual(failures, []);
});

test("W1-T9390: an unstattable rotation or an unlistable state dir is left to the union read", async (t) => {
  const fixture = writeLedger([], { rotations: [{ at: daysAgo(30), gz: true, rows: [birth(3, daysAgo(31))] }] });
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const unstattable: LedgerGrepFsDeps = {
    ...realLedgerFs,
    statSync: (path) => {
      if (/ledger\.[^/]*\.ndjson\.gz$/.test(path)) throw new Error("EACCES: stat refused");
      return realLedgerFs.statSync(path);
    },
  };
  const read = await createEscalationTriageHistoryReader({ fs: unstattable })(fixture.dir);
  assert.deepEqual(read.rows.map((row) => row.issue_url), [issueUrl(3)], "the union reads an unstattable rotation inline");
  const unlistable: LedgerGrepFsDeps = { ...realLedgerFs, readdirSync: () => { throw new Error("EACCES: readdir refused"); } };
  const none = await createEscalationTriageHistoryReader({ fs: unlistable })(fixture.dir);
  assert.deepEqual(none.rows, [], "an unlistable state dir yields no history");
});
