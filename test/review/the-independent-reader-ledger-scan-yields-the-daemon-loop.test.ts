import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { readLedgerUnionRawLinesSync, type LedgerUnionRawRead } from "#src/lib/ledger-union.js";
import { loadPlanFromYaml, type Plan } from "#src/lib/plan.js";
import * as agreement from "#src/lib/reader-agreement.js";
import { buildBatchedGithub } from "#src/lib/status.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

/**
 * W1-T11506 — THE INDEPENDENT READER-AGREEMENT LEDGER SCAN YIELDS THE DAEMON LOOP. independentFigures read its window
 * with readLedgerUnionRawLinesSync, three times a check, inside the sweep's awaited prelude: checkReaderAgreement was
 * the first named frame in 28 loop-stall rows holding 892 s of lag on 2026-11-17.
 *
 * FIXTURES ONLY: every corpus is a throwaway state dir with a live file, a plain rotation and a gzip rotation.
 */

type Row = Record<string, unknown>;
const HALTED = "W1-T5902";
const PLAN_TASK = "W1-T8000";
const at = (hour: number, minute = 0): string => `2026-10-10T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;
const row = (ts: string, fields: Row): Row => ({ ts, ...fields });

function corpus(t: TestContext): { dir: string; path: string } {
  const halted = (ts: string, step: string, run_id: string, fields: Row = {}) => row(ts, { task_id: HALTED, run_id, step, ...fields });
  const older = [
    halted(at(1), "run.start", "h-1"), halted(at(1, 10), "verdict", "h-1", { verdict: "no_pr" }),
    halted(at(2), "pr.opened", "h-reset", { pr_url: "https://github.com/o/r/pull/9" }),
    halted(at(2, 30), "run.start", "h-2"), halted(at(2, 40), "verdict", "h-2", { verdict: "no_pr" }),
    halted(at(3), "run.start", "h-3"), halted(at(3, 10), "verdict", "h-3", { verdict: "no_pr" }),
    row(at(3), { task_id: "DEPLOY", run_id: "d-0", step: "deploy.ok" }),
    row(at(1), { task_id: PLAN_TASK, run_id: "p-1", step: "run.start" }),
    row(at(1, 15), { task_id: PLAN_TASK, run_id: "p-1", step: "dispatch.blocked_independent", verdict: "no_pr" }),
  ];
  const newer = [
    row(at(5, 20), { task_id: HALTED, task: HALTED, run_id: "halt", step: "dispatch.circuit_broken" }),
    row(at(6), { task_id: "DEPLOY", run_id: "d-1", step: "deploy.ok", instance: "W1" }),
    row(at(7, 5), { task_id: "W1-T7000", run_id: "u-merge", step: "verdict", verdict: "merged" }),
  ];
  const filler = (n: number, from: number) => Array.from({ length: n }, (_, i) => row(at((from + i) % 8, i % 60), {
    task_id: "DAEMON", run_id: `u-${from}-${i}`, step: "daemon.alive",
  }));
  const ledger = writeLedger([...newer.slice(-1), ...filler(200, 3),
    row(at(8), { task_id: "DEPLOY", run_id: "d-2", step: "deploy.ok", instance: "W2" })], {
    scope: t,
    rotations: [
      { at: "2026-10-10T04:30:00.000Z", rows: [...older, ...filler(300, 1)], gz: true },
      { at: "2026-10-10T07:30:00.000Z", rows: [...older, ...newer, ...filler(300, 2)] },
    ],
  });
  return { dir: ledger.dir, path: ledger.path };
}

/** Figures nothing real can equal, so every independent figure surfaces as a disagreement carrying its value. */
const sentinel: agreement.ReaderFigures = {
  dispatchStreaks: { [HALTED]: -1 }, queuedTaskCount: -1,
  healthyDeploys: { local: "sentinel", W1: "sentinel", W2: "sentinel" },
};

const plan = (): Plan => loadPlanFromYaml([HALTED, PLAN_TASK].map(id => `
- id: ${id}
  title: fixture task ${id}
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`).join(""), "fixture");

const freshGateway = () => buildBatchedGithub("o", `w1-t11506-${process.pid}`, {
  fetchAll: () => [], fetchAllIssues: () => [], commitTrailerIndex: () => new Map(), ttlMs: 3_600_000,
});

/** Counts setImmediate turns while it is on: a read that holds the loop to the end lets none run. */
function turnCounter(): { turns: () => number; stop: () => void } {
  let turns = 0;
  let on = true;
  const tick = (): void => {
    if (!on) return;
    turns++;
    setImmediate(tick);
  };
  setImmediate(tick);
  return { turns: () => turns, stop: () => { on = false; } };
}

test("W1-T11506 criterion 1: the independent default ledger reads yield the event loop and are awaited before figure publication", async (t) => {
  const { path } = corpus(t);
  // The real default: the board side is injected, so every corpus read in this check is the independent one.
  const counter = turnCounter();
  let turnsAtPublication = -1;
  const published: Row[] = [];
  const findings = await agreement.checkReaderAgreement({ ledgerPath: path, runId: "SWEEP-t11506", boardReader: () => sentinel,
    appendLine: (_path, line) => {
      if (line.step === "reader.agreement") turnsAtPublication = counter.turns();
      published.push(line);
    } }).finally(counter.stop);
  assert.ok(turnsAtPublication > 0, `the loop ran ${turnsAtPublication} turn(s) during the independent reads`);
  // Published figures are the corpus's, so every read finished before publication.
  assert.equal(findings.find(f => f.subject === HALTED)?.independent_value, 2);
  assert.equal(findings.find(f => f.subject === "W2")?.independent_value, at(8));
  const report = published.find(line => line.step === "reader.agreement")!;
  assert.ok((report.rows_kept as Record<string, number>).independent > 0);

  // A read that stays pending: a timer runs, and nothing is published until the read resolves.
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  const pendingCorpus = async (dir: string, opts?: Parameters<typeof readLedgerUnionRawLinesSync>[1]): Promise<LedgerUnionRawRead> => {
    reads++;
    await gate;
    return readLedgerUnionRawLinesSync(dir, opts);
  };
  const early: Row[] = [];
  const check = agreement.checkReaderAgreement({ ledgerPath: path, runId: "SWEEP-t11506", boardReader: () => sentinel,
    independentCorpus: pendingCorpus, appendLine: (_path, line) => early.push(line) });
  const timerRan = await new Promise<boolean>(resolve => setTimeout(() => resolve(true), 5));
  assert.equal(timerRan, true);
  assert.equal(reads, 1, "the first read is pending");
  assert.deepEqual(early, [], "nothing is published while a read is pending");
  release();
  const awaited = await check;
  assert.equal(reads, 2, "steps, then the halted task's rows");
  assert.deepEqual(awaited, findings, "the awaited reads publish the same figures");
});

test("W1-T11506 criterion 2: the real live-plus-gzip default and a synchronous injected control retain identical figures, scan counts and incomplete/unreadable refusal semantics", async (t) => {
  const { dir, path } = corpus(t);
  writeFileSync(join(dir, "status.json"), JSON.stringify({ tasks: {} }));
  const run = async (independentCorpus?: typeof readLedgerUnionRawLinesSync) => {
    const written: Row[] = [];
    const findings = await agreement.checkReaderAgreement({ ledgerPath: path, runId: "SWEEP-t11506", owner: "o", repo: "r",
      plan: plan(), boardReader: () => sentinel, queueGithub: freshGateway,
      ...(independentCorpus ? { independentCorpus } : {}), appendLine: (_path, line) => written.push(line) });
    const report = written.find(line => line.step === "reader.agreement")!;
    return { findings, scanned: report.lines_scanned, kept: report.rows_kept };
  };
  const real = await run();
  const control = await run(readLedgerUnionRawLinesSync);
  assert.deepEqual(real, control);
  // The halted-task, deploy and queued-plan branches all ran.
  assert.equal(real.findings.find(f => f.subject === HALTED)?.independent_value, 2);
  assert.equal(real.findings.find(f => f.subject === "local")?.independent_value, at(3));
  assert.equal(typeof real.findings.find(f => f.figure === "queued_task_count")?.independent_value, "number");
  const scanned = (real.scanned as Record<string, number>).independent!;
  const kept = (real.kept as Record<string, number>).independent!;
  assert.ok(scanned > 1_000, `the whole window was scanned (${scanned})`);
  assert.ok(kept > 0 && kept * 10 < scanned, `only the figures' rows were kept (${kept} of ${scanned})`);

  // The default and the sync control refuse the same corpora with the same error.
  const refuses = async (ledgerPath: string, error: RegExp | typeof SyntaxError) => {
    for (const independentCorpus of [undefined, readLedgerUnionRawLinesSync]) {
      await assert.rejects(agreement.checkReaderAgreement({ ledgerPath, runId: "SWEEP-t11506",
        boardReader: () => sentinel, ...(independentCorpus ? { independentCorpus } : {}),
        appendLine: () => assert.fail("no row for an unread check") }), error, independentCorpus ? "sync control" : "default");
    }
  };
  // An archive that cannot be decompressed leaves the corpus incomplete.
  writeFileSync(join(dir, "ledger.2026-10-10T06-00-00-000Z.ndjson.gz"), "not gzip");
  await refuses(path, /independent ledger corpus is incomplete/);
  // A malformed row is refused as the unfiltered parse refused it.
  const { path: malformed } = corpus(t);
  appendFileSync(malformed, "not json\n");
  await refuses(malformed, SyntaxError);
});
