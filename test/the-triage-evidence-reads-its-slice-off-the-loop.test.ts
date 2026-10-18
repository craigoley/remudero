// W1-T9406 — W1-T9390 (#11608) moved sweepEscalationTriage's own history read off the daemon loop, but
// buildEscalationTriageRuntime's `evidence` callback still defaulted to a synchronous read of the WHOLE ledger union
// (readLedgerUnionRecordsSync over every rotation, no step filter), repeated once per escalation it triaged. These
// tests pin that the evidence reads only its step slice, that a pass refreshes that slice off the loop before it
// triages anything, that the slice answers exactly what the whole-union read answered (no time window), and that an
// unreadable slice refuses instead of reading as an empty history.
import assert from "node:assert/strict";
import fs, { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import zlib from "node:zlib";
import { NEEDS_HUMAN_LABEL, type Escalation, type IssueGateway, type OpenIssue } from "#src/lib/escalate.js";
import type { TriageEvidence } from "#src/lib/escalation-triage.js";
import { readLedgerUnionRecordsSync } from "#src/lib/ledger-union.js";
import { createEscalationTriageHistoryReader } from "#src/lib/sweep.js";
import { buildEscalationTriageRuntime, refreshEscalationTriageEvidence, sweepEscalationTriage } from "#src/run-task.js";
import type { Config } from "#src/lib/config.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const DAY = 86_400_000;
const daysAgo = (days: number): string => new Date(Date.now() - days * DAY).toISOString();
const ISSUE = "https://github.com/o/r/issues/501";

function esc(over: Partial<Escalation> = {}): Escalation {
  return {
    class: "BLOCKED", taskId: "W1-T501", summary: "W1-T501: two strikes exhausted", detail: "the retry still failed.",
    options: [{ label: "retry", detail: "resume with a fresh worker" }, { label: "abandon", detail: "drop the task" }],
    recommendation: "retry", ...over,
  };
}

/** The escalation born in the OLDEST rotation, as its `issue_opened` row recorded it. */
const BORN = esc({ headSha: "h1", contractRevision: "c1", cause: "conflict" });
/** Escalations whose evidence the test compares: born-in-the-oldest-rotation, unborn, and a class with no dispositions. */
const ASKED: Escalation[] = [BORN, esc({ taskId: "W1-T502", headSha: "h9", cause: "ci" }), esc({ class: "GRILL", taskId: "W1-T503" })];

function noise(tag: string, count: number, days: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({ ts: daysAgo(days), run_id: `${tag}-${i}`, task_id: "W1-T1", step: "heartbeat.tick" }));
}

function handled(n: number, disposition: string, days: number): Record<string, unknown> {
  return { ts: daysAgo(days), run_id: `PANEL-${n}`, task_id: `W1-T6${n}`, step: "panel.escalation_marked_handled", class: "BLOCKED", disposition };
}

/** A corpus spread over three rotations and the live file, every evidence row in a different one. */
function corpus() {
  const rotations = [
    { at: daysAgo(90), gz: true, rows: [
      { ts: daysAgo(91), run_id: "RUN-501", task_id: "W1-T501", step: "escalation.issue_opened", issue_url: ISSUE, triage_subject: BORN },
      { ts: daysAgo(91), run_id: "FIX-1", task_id: "W1-T501", step: "fix.dispatch", head_sha: "h1", mode: "ci-log" },
      handled(1, "false_positive", 91), handled(2, "false_positive", 91), handled(3, "duplicate", 91), ...noise("old", 30, 91)] },
    { at: daysAgo(45), gz: true, rows: [
      { ts: daysAgo(46), run_id: "RUN-501", task_id: "W1-T501", step: "escalation.auto_resolve_attempted", triage_action: "rekick_once", head_sha: "h1" },
      { ts: daysAgo(46), run_id: "FIX-2", task_id: "W1-T501", step: "fix.dispatch", head_sha: "h1", mode: "review", kind: "proof_amendment" },
      handled(4, "false_positive", 46), handled(5, "acted", 46), ...noise("mid", 30, 46)] },
    { at: daysAgo(3), gz: true, rows: [
      { ts: daysAgo(4), run_id: "RUN-501", task_id: "W1-T501", step: "escalation.auto_resolve_attempted", triage_action: "rekick_once", head_sha: "h0", contract_revision: "c1" },
      { ts: daysAgo(4), run_id: "RUN-502", task_id: "W1-T502", step: "escalation.auto_resolve_attempted", triage_action: "rekick_once", head_sha: "h9" },
      ...noise("new", 30, 4)] },
  ];
  return writeLedger([
    { ts: daysAgo(1), run_id: "FIX-3", task_id: "W1-T502", step: "fix.dispatch", head_sha: "h9", mode: "merge-conflict" },
    handled(6, "false_positive", 1), ...noise("live", 10, 1)], { rotations });
}

function runtimeFor(root: string, readRows?: (ledgerPath: string) => Record<string, unknown>[]) {
  return buildEscalationTriageRuntime({ root, config: { root } as Config, owner: "o", repo: "r" }, {
    readPolicy: () => ({ escalationTriage: { mode: "shadow" } }), seenAt: () => Date.now() - 60_000, windowMs: () => 1,
    judge: async () => ({ decision: "deliver", reason: "the test judge keeps it visible" }),
    ...(readRows ? { readRows } : {}),
  });
}

/** Counts every SYNCHRONOUS read of a rotation and every synchronous gunzip, whoever makes it. */
function syncReadSpy() {
  const counts = { rotationReads: [] as string[], gunzips: 0 };
  const readFileSync = fs.readFileSync;
  const gunzipSync = zlib.gunzipSync;
  fs.readFileSync = ((path: unknown, ...rest: unknown[]) => {
    if (typeof path === "string" && /ledger\.[^/]*\.ndjson(\.gz)?$/.test(path)) counts.rotationReads.push(path);
    return (readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.readFileSync;
  zlib.gunzipSync = ((...args: Parameters<typeof gunzipSync>) => (counts.gunzips += 1, gunzipSync(...args))) as typeof gunzipSync;
  syncBuiltinESMExports();
  return {
    counts,
    restore: (): void => {
      fs.readFileSync = readFileSync;
      zlib.gunzipSync = gunzipSync;
      syncBuiltinESMExports();
    },
  };
}

test("W1-T9406: the triage evidence reads its slice off the loop", async (t) => {
  const fixture = corpus();
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t9406-root-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(fixture.dir, { recursive: true, force: true }); });
  const deps = { issues: {} as never, ledgerPath: fixture.path, runId: "SWEEP-T9406" };

  // THE ORACLE: today's whole-union read, every rotation, no step filter.
  const whole = runtimeFor(root, (path) => readLedgerUnionRecordsSync(dirname(path), { refuseIncomplete: true }).rows)(deps);
  const expected = ASKED.map((e) => whole.evidence!(e));
  // The oracle answers are not vacuous: each field the slice must reproduce is set by a row in a different file.
  assert.deepEqual(expected[0], { classTier: "board", defaultApplies: true, rekick: { priorRekicks: 2, newFailureSinceLastStrike: true } });
  assert.deepEqual(expected[1], { classTier: "board", defaultApplies: false, rekick: { priorRekicks: 1, newFailureSinceLastStrike: true } });
  assert.deepEqual(expected[2], { classTier: "issue", defaultApplies: false, rekick: { priorRekicks: 0, newFailureSinceLastStrike: false } });

  // THE PASS: the default evidence, driven by the daemon's rejudge rung over the one open issue.
  const runtime = runtimeFor(root);
  const seen: TriageEvidence[] = [];
  const observed = Object.assign((d: Parameters<typeof runtime>[0]) => {
    const settings = runtime(d);
    return { ...settings, evidence: (e: Escalation) => { const read = settings.evidence!(e); seen.push(read); return read; } };
  }, runtime);
  const open: OpenIssue[] = [{ number: 501, url: ISSUE, title: BORN.summary, body: "**Task:** W1-T501\n" }];
  const issues = { listOpen: (label: string) => label === NEEDS_HUMAN_LABEL ? open : [] } as unknown as IssueGateway;
  const failures: string[] = [];
  const spy = syncReadSpy();
  let direct: TriageEvidence[];
  try {
    await sweepEscalationTriage({ root, config: { root } as Config, owner: "o", repo: "r", ledgerPath: fixture.path, runId: "SWEEP-T9406" },
      [], (step, extra) => { if (/failed/.test(step)) failures.push(`${step} ${JSON.stringify(extra)}`); },
      { issues, runtime: observed, history: createEscalationTriageHistoryReader() });
    direct = ASKED.map((e) => runtime(deps).evidence!(e));
  } finally {
    spy.restore();
  }
  assert.deepEqual(failures, []);
  assert.deepEqual(spy.counts, { rotationReads: [], gunzips: 0 }, "no rotation is read or decompressed on the loop during the pass");
  assert.deepEqual(seen, [expected[0]], "the rejudged candidate's evidence is the whole-union answer");
  assert.deepEqual(direct, expected, "every escalation's strike, rekick count, birth and class tier match the whole-union read");

  // The slice has its own durable digest, beside (never instead of) the rung's own.
  const holders = readdirSync(join(fixture.dir, "cache", "rotation-digests")).sort();
  assert.equal(holders.length, 2, `two holders keep two digests (${holders})`);
  for (const holder of holders) assert.equal(readdirSync(join(fixture.dir, "cache", "rotation-digests", holder)).filter((n) => n.endsWith(".json")).length, 3);

  // A row appended after the refresh is still seen: the live file is read from where the refresh stopped.
  fixture.append([{ ts: daysAgo(0), run_id: "RUN-503", task_id: "W1-T503", step: "escalation.auto_resolve_attempted", triage_action: "rekick_once", head_sha: "h3" }]);
  const after = syncReadSpy();
  let rekicks: number | undefined;
  try {
    rekicks = runtime(deps).evidence!(esc({ class: "GRILL", taskId: "W1-T503", headSha: "h3" })).rekick?.priorRekicks;
  } finally {
    after.restore();
  }
  assert.equal(rekicks, 1);
  assert.deepEqual(after.counts, { rotationReads: [], gunzips: 0 });
});

test("W1-T9406: an unreadable evidence slice refuses instead of reading as an empty history", async (t) => {
  const fixture = corpus();
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t9406-root-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(fixture.dir, { recursive: true, force: true }); });
  // A rotation that cannot be decompressed is unread, so the union refuses (refuseIncomplete).
  fs.writeFileSync(join(fixture.dir, `ledger.${daysAgo(2).replace(/[:.]/g, "-")}.ndjson.gz`), "not gzip");
  const runtime = runtimeFor(root);
  await runtime.refresh(fixture.path);
  const settings = runtime({ issues: {} as never, ledgerPath: fixture.path, runId: "SWEEP-T9406" });
  assert.throws(() => settings.evidence!(BORN), /triage evidence history is unreadable/);
});

test("W1-T9406: the history reader takes its step slice as a parameter", async (t) => {
  const fixture = corpus();
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  const rung = await createEscalationTriageHistoryReader()(fixture.dir);
  assert.deepEqual([...new Set(rung.rows.map((row) => row.step))], ["escalation.issue_opened"], "the rung's default slice is unchanged");
  const strikes = await createEscalationTriageHistoryReader({ slice: { holder: "test.w1-t9406-strikes", steps: ["fix.dispatch"] } })(fixture.dir);
  assert.deepEqual(strikes.rows.map((row) => row.run_id), ["FIX-1", "FIX-2", "FIX-3"]);
});

test("W1-T9406: the daemon tick's evidence refresh loads the slice, and a failed one is logged, not thrown", async (t) => {
  const fixture = corpus();
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t9406-root-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(fixture.dir, { recursive: true, force: true }); });
  const logged: Array<[string, Record<string, unknown> | undefined]> = [];
  const log = (step: string, extra?: Record<string, unknown>): void => void logged.push([step, extra]);
  const runtime = runtimeFor(root);
  await refreshEscalationTriageEvidence(runtime, fixture.path, log);
  const spy = syncReadSpy();
  try {
    runtime({ issues: {} as never, ledgerPath: fixture.path, runId: "TICK-T9406" }).evidence!(BORN);
  } finally {
    spy.restore();
  }
  assert.deepEqual(spy.counts, { rotationReads: [], gunzips: 0 }, "the tick's refresh left nothing to read on the loop");
  assert.deepEqual(logged, []);
  await refreshEscalationTriageEvidence({ refresh: async () => { throw new Error("EIO: the state dir went away"); } }, fixture.path, log);
  assert.deepEqual(logged, [["escalation_triage.evidence_refresh_failed", { error: "EIO: the state dir went away" }]]);
});
