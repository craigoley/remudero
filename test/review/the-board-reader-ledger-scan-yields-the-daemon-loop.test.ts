import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import * as agreement from "#src/lib/reader-agreement.js";
import { readLedgerUnionBounded } from "#src/lib/status.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

/**
 * W1-T13549 — THE BOARD READER-AGREEMENT LEDGER SCAN YIELDS THE DAEMON LOOP. boardFigures read its window twice a
 * check with readLedgerUnionBounded, a synchronous scan, inside the sweep's awaited prelude: it was about half of
 * checkReaderAgreement's loop-stall time on 2026-11-17. W1-T11506 moved only the independent read off the loop.
 *
 * FIXTURES ONLY: every corpus is a throwaway state dir with a live file and two gzip rotations.
 */

type Row = Record<string, unknown>;
type BoardCorpus = NonNullable<agreement.ReaderAgreementOptions["boardCorpus"]>;
const HALTED = "W1-T5902";
const BOARD_REFUSAL = /board ledger is missing or contains malformed rows/;
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
  ];
  // The W1 deploy is the row the live file shares with the newer archive.
  const shared = row(at(6), { task_id: "DEPLOY", run_id: "d-1", step: "deploy.ok", instance: "W1" });
  const newer = [row(at(5, 20), { task_id: HALTED, task: HALTED, run_id: "halt", step: "dispatch.circuit_broken" }), shared];
  const filler = (n: number, from: number) => Array.from({ length: n }, (_, i) => row(at((from + i) % 8, i % 60), {
    task_id: "DAEMON", run_id: `u-${from}-${i}`, step: "daemon.alive",
  }));
  const ledger = writeLedger([shared, ...filler(200, 3),
    row(at(8), { task_id: "DEPLOY", run_id: "d-2", step: "deploy.ok", instance: "W2" })], {
    scope: t,
    rotations: [
      { at: "2026-10-10T04:30:00.000Z", rows: [...older, ...filler(300, 1)], gz: true },
      { at: "2026-10-10T07:30:00.000Z", rows: [...older, ...newer, ...filler(300, 2)], gz: true },
    ],
  });
  writeFileSync(join(ledger.dir, "status.json"), JSON.stringify({ tasks: {
    [HALTED]: { status: "queued" }, "W1-T8000": { status: "queued" }, "W1-T8001": { status: "recon" },
  } }));
  return { dir: ledger.dir, path: ledger.path };
}

/** Figures nothing real can equal, so every board figure surfaces as a disagreement carrying its value. */
const sentinel: agreement.ReaderFigures = {
  dispatchStreaks: { [HALTED]: -1 }, openPrCount: -1, queuedTaskCount: -1,
  healthyDeploys: { local: "sentinel", W1: "sentinel", W2: "sentinel" },
};

/** One check with the independent side injected, so every corpus read in it is the board's. */
async function boardRun(path: string, boardCorpus?: BoardCorpus) {
  const written: Row[] = [];
  const findings = await agreement.checkReaderAgreement({ ledgerPath: path, runId: "SWEEP-t13549", openPrCount: 4,
    independentReader: () => sentinel, ...(boardCorpus ? { boardCorpus } : {}), appendLine: (_path, line) => written.push(line) });
  const report = written.find(line => line.step === "reader.agreement")!;
  const figures = Object.fromEntries(findings.map(f => [`${f.figure}:${f.subject}`, f.board_value]));
  return { figures, scanned: report.lines_scanned, kept: report.rows_kept };
}

/** `read`, with `mutate` run on the ledger just before its second call: the halted-task pass. */
function beforeHaltedPass(read: BoardCorpus, mutate: (path: string) => void): { read: BoardCorpus; calls: () => number } {
  let calls = 0;
  return { read: (path, opts) => {
    if (calls++ === 1) mutate(path);
    return read(path, opts);
  }, calls: () => calls };
}

test("W1-T13549 criterion 1: the default board reads yield the event loop, and nothing is written until they complete", async (t) => {
  const { path } = corpus(t);
  const written: Row[] = [];
  let settled = false;
  let atTimer: { settled: boolean; written: number } | undefined;
  // Set just before the check starts. A board read that held the loop to the end would let it fire only after.
  const timer = new Promise<void>(resolve => setTimeout(() => {
    atTimer = { settled, written: written.length };
    resolve();
  }, 0));
  const findings = await agreement.checkReaderAgreement({ ledgerPath: path, runId: "SWEEP-t13549",
    independentReader: () => sentinel, appendLine: (_path, line) => written.push(line) }).finally(() => { settled = true; });
  await timer;
  assert.deepEqual(atTimer, { settled: false, written: 0 }, "the timer fired during the board reads, before any row");
  assert.equal(findings.find(f => f.subject === HALTED)?.board_value, 2, "the halted-task pass completed");
  assert.ok(written.some(line => line.step === "reader.agreement"), "the stats row follows the reads");

  // A board read that stays pending: a timer runs, and nothing is written until the read resolves.
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  const pending: BoardCorpus = async (ledgerPath, opts) => {
    reads++;
    await gate;
    return agreement.readBoardLedgerWindow(ledgerPath, opts);
  };
  const early: Row[] = [];
  let returned = false;
  const check = agreement.checkReaderAgreement({ ledgerPath: path, runId: "SWEEP-t13549", independentReader: () => sentinel,
    boardCorpus: pending, appendLine: (_path, line) => early.push(line) }).finally(() => { returned = true; });
  assert.equal(await new Promise<boolean>(resolve => setTimeout(() => resolve(true), 5)), true);
  assert.equal(reads, 1, "the step pass is pending");
  assert.equal(returned, false, "the check has not returned");
  assert.deepEqual(early, [], "no reader.disagreement or reader.agreement row while a read is pending");
  release();
  assert.deepEqual(await check, findings, "the awaited reads give the same findings");
  assert.equal(reads, 2, "steps, then the halted task's rows");
});

test("W1-T13549 criterion 2: the async default and readLedgerUnionBounded give the same board figures, lines scanned and rows kept", async (t) => {
  const { path } = corpus(t);
  const real = await boardRun(path);
  const control = await boardRun(path, readLedgerUnionBounded);
  assert.deepEqual(real, control);
  assert.deepEqual(real.figures, {
    [`dispatch_streak:${HALTED}`]: 2, "open_pr_count:repository": 4, "queued_task_count:repository": 2,
    "last_healthy_deploy:local": at(3), "last_healthy_deploy:W1": at(6), "last_healthy_deploy:W2": at(8),
  });
  const scanned = (real.scanned as Record<string, number>).board!;
  const kept = (real.kept as Record<string, number>).board!;
  assert.ok(scanned > 1_000, `the whole window was scanned twice (${scanned})`);
  assert.ok(kept > 0 && kept * 10 < scanned, `only the figures' rows were kept (${kept} of ${scanned})`);
  // The row the live file shares with an archive is kept once by both readers.
  const shared = (line: string) => line.includes('"d-1"');
  assert.equal((await agreement.readBoardLedgerWindow(path, { keep: shared })).length, 1);
  assert.equal(readLedgerUnionBounded(path, { keep: shared }).length, 1);
});

test("W1-T13549 criterion 3: both readers refuse a missing ledger, an unreadable live file, a torn row and a malformed row in both passes, and agree on an unreadable rotation", async (t) => {
  const readers: Array<[string, BoardCorpus]> = [["async default", agreement.readBoardLedgerWindow], ["readLedgerUnionBounded", readLedgerUnionBounded]];
  const refuses = async (label: string, boardCorpus: BoardCorpus | undefined, path: string) => {
    await assert.rejects(agreement.checkReaderAgreement({ ledgerPath: path, runId: "SWEEP-t13549",
      independentReader: () => sentinel, ...(boardCorpus ? { boardCorpus } : {}),
      appendLine: () => assert.fail("no row for a refused check") }), BOARD_REFUSAL, label);
  };
  // The step pass. A ts-led row that does not parse is torn; a kept row that is not an object is malformed.
  const stepCases: Array<[string, (path: string) => void]> = [
    ["missing ledger", path => unlinkSync(path)],
    ["torn row", path => appendFileSync(path, `{"ts":"${at(8, 45)}","task_id":"DEPLOY","step":"deploy.ok",torn}\n`)],
    ["malformed row", path => appendFileSync(path, `["deploy.ok"]\n`)],
  ];
  for (const [name, mutate] of stepCases) {
    for (const [label, read] of [["the real default", undefined] as const, ...readers]) {
      const { path } = corpus(t);
      mutate(path);
      await refuses(`step pass, ${name}, ${label}`, read, path);
    }
  }
  // The halted-task pass: the ledger changes after the step pass read it clean.
  const haltedCases: Array<[string, (path: string) => void]> = [
    ["missing ledger", path => unlinkSync(path)],
    ["torn row", path => appendFileSync(path, `{"ts":"${at(8, 50)}","task_id":"${HALTED}","run_id":"torn",torn}\n`)],
    ["malformed row", path => appendFileSync(path, `{"task_id":"${HALTED}","run_id":"cut"\n`)],
  ];
  for (const [name, mutate] of haltedCases) {
    for (const [label, read] of readers) {
      const { path } = corpus(t);
      const wrapped = beforeHaltedPass(read, mutate);
      await refuses(`halted-task pass, ${name}, ${label}`, wrapped.read, path);
      assert.equal(wrapped.calls(), 2, `the halted-task pass ran (${name}, ${label})`);
    }
  }
  // A live file that exists but cannot be read (a directory at its path) is refused with the read's own error.
  const unreadableLive = (path: string) => { unlinkSync(path); mkdirSync(path); };
  for (const [label, read] of [["the real default", undefined] as const, ...readers]) {
    const { path } = corpus(t);
    unreadableLive(path);
    await assert.rejects(agreement.checkReaderAgreement({ ledgerPath: path, runId: "SWEEP-t13549",
      independentReader: () => sentinel, ...(read ? { boardCorpus: read } : {}),
      appendLine: () => assert.fail("no row for a refused check") }), { code: "EISDIR" }, `step pass, unreadable live file, ${label}`);
  }
  for (const [label, read] of readers) {
    const { path } = corpus(t);
    const wrapped = beforeHaltedPass(read, unreadableLive);
    await assert.rejects(agreement.checkReaderAgreement({ ledgerPath: path, runId: "SWEEP-t13549",
      independentReader: () => sentinel, boardCorpus: wrapped.read,
      appendLine: () => assert.fail("no row for a refused check") }), { code: "EISDIR" }, `halted-task pass, unreadable live file, ${label}`);
    assert.equal(wrapped.calls(), 2);
  }
  // An archive that cannot be decompressed: the same outcome from both.
  const { dir, path } = corpus(t);
  writeFileSync(join(dir, "ledger.2026-10-10T06-00-00-000Z.ndjson.gz"), "not gzip");
  const outcome = (boardCorpus?: BoardCorpus) => boardRun(path, boardCorpus).catch((error: Error) => ({ error: error.message }));
  const real = await outcome();
  assert.deepEqual(real, await outcome(readLedgerUnionBounded));
  assert.ok("figures" in real, "an unreadable rotation is skipped, as readLedgerUnionBounded skips it");
});
