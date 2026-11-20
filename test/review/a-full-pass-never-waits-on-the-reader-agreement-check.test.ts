/**
 * W1-T13884 — A FULL PASS NEVER WAITS ON THE READER AGREEMENT CHECK.
 *
 * On the Azure host core ledger, 2026-11-19, `reader.agreement` rows scanned about 2.0M lines twice each and ran
 * from 45,746 ms to 2,407,529 ms at a flat input size. runSweep awaited the check inline, so each due full pass
 * held its dispositions, reviews and merges for as long as the check took (one pass's reader_agreement stage:
 * 3,082,328 ms). The pass now starts the check and goes on; the check's findings are still logged when it settles,
 * and one check runs at a time.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ReaderFigures } from "#src/lib/reader-agreement.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { runSweep, settleReaderAgreement, type SweepDeps } from "#test/helpers/sweep-test.js";

const figures: ReaderFigures = { dispatchStreaks: {}, openPrCount: 3, healthyDeploys: {} };
const MINUTE = 60_000;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13884-`));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let boardCalls = 0;
  let nowMs = 1_000 * MINUTE;
  const rows: Record<string, unknown>[] = [];
  const deps: SweepDeps = {
    ledgerPath, runId: "SWEEP-t13884", arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {},
    appendLine: (_path, row) => rows.push(row), now: () => nowMs,
    readerAgreement: {
      boardReader: async () => { boardCalls++; await gate; return { ...figures, openPrCount: 5 }; },
      independentReader: () => figures,
    },
    readReportedAnomalies: async () => ({ complete: true, costAnomaly: new Set(), runningLong: new Set() }),
  };
  return {
    deps, rows, release, boardCalls: () => boardCalls, advance: (ms: number) => { nowMs += ms; },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Runs one full pass; a pass still held after two seconds is released and reported as held, never hung. */
async function passWithin(f: ReturnType<typeof fixture>): Promise<"done" | "held"> {
  const pass = runSweep([], f.deps).then(() => "done" as const);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"held">((resolve) => { timer = setTimeout(() => resolve("held"), 2_000); });
  const outcome = await Promise.race([pass, timeout]);
  clearTimeout(timer);
  if (outcome === "held") { f.release(); await pass; }
  return outcome;
}

test("W1-T13884 criterion 1: a full pass finishes while its reader agreement check is still running, and the check's findings land when it settles", async () => {
  const f = fixture();
  try {
    assert.equal(await passWithin(f), "done", "W1-T13884 no wait: the pass returns while the check is held");
    assert.equal(f.boardCalls(), 1, "positive control: the check was started");
    assert.equal(f.rows.filter((row) => row.step === "reader.disagreement").length, 0, "nothing is logged before it settles");
    f.release();
    await settleReaderAgreement(f.deps.ledgerPath);
    assert.equal(f.rows.filter((row) => row.step === "reader.disagreement").length, 1, "its finding is logged when it settles");
  } finally { f.release(); f.cleanup(); }
});

test("W1-T13884 invariant: a due pass never starts a second check while one is in flight", async () => {
  const f = fixture();
  try {
    assert.equal(await passWithin(f), "done");
    f.advance(16 * MINUTE);
    await runSweep([], f.deps);
    assert.equal(f.boardCalls(), 1, "W1-T13884 one in flight: the later due pass started no second check");
    f.release();
    await settleReaderAgreement(f.deps.ledgerPath);
    f.advance(16 * MINUTE);
    await runSweep([], f.deps);
    assert.equal(f.boardCalls(), 2, "once it settled, the next due pass starts one again");
    await settleReaderAgreement(f.deps.ledgerPath);
  } finally { f.release(); f.cleanup(); }
});

