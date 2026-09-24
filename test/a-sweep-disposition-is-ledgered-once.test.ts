import assert from "node:assert/strict";
import { test } from "node:test";

import { appendLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import { DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "../src/lib/sweep.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

// MEASURED 2026-09-24 on the fleet host, 07:30-11:30Z: 767 `sweep.dispose` and 687
// `sweep.dispose.not_open` rows, every one matched by a `sweep.disposed` row for the same PR within
// 5s carrying the same disposition, acted, reason and stand-down reason — 10.3% of 14,089 core rows.
// No src reader reads either step. These tests drive runSweep through a `log` that appends to the
// SAME ledger, the way the daemon wires it, so a duplicate row would land where it did on the fleet.

function deps(over: Partial<SweepDeps> = {}): SweepDeps {
  const { path } = writeLedger();
  return {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: path,
    runId: "DAEMON-1",
    log: (step, extra = {}) => appendLedger(path, { run_id: "DAEMON-1", task_id: "DAEMON", step, lane: "daemon", ...extra }),
    ...over,
  };
}

function armedPr(): OpenPrView {
  return {
    prNumber: 71,
    prUrl: "url/71",
    taskId: "W1-A",
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-09-24T10:00:00Z",
    headSha: "aaaa111",
    autoMergeArmed: true,
  };
}

function mergedUnderUsPr(): OpenPrView {
  return {
    prNumber: 72,
    prUrl: "url/72",
    taskId: "W1-B",
    reviewState: "failure",
    checksState: "green",
    unmetCriteria: [{ claim: "criterion one", proof: "unit test: it works", met: false, reason: "not done", proof_exec: "executed_fail" }],
    reviewSummary: "one criterion unmet",
    priorStrikes: 0,
    lastActivityAt: "2026-09-24T10:00:00Z",
    headSha: "bbbb222",
    autoMergeArmed: false,
  };
}

const merged: Partial<SweepDeps> = { readLiveState: async () => ({ ok: true, state: "MERGED" }) };

test("a real sweep pass ledgers one sweep.disposed row per PR and no duplicate dispose row", async () => {
  const d = deps(merged);
  await runSweep([armedPr(), mergedUnderUsPr()], d, DEFAULT_SWEEP_POLICY);
  const steps = readLedgerLines(d.ledgerPath).map((l) => String(l.step));
  assert.equal(steps.filter((s) => s === "sweep.disposed").length, 2, "one row per disposed PR");
  assert.deepEqual(
    steps.filter((s) => s === "sweep.dispose" || s === "sweep.dispose.not_open"),
    [],
    `the duplicate rows are gone; saw ${JSON.stringify(steps)}`,
  );
});

test("the sweep.disposed row carries the stand-down reason and the deduped flag the dropped rows carried", async () => {
  const d = deps(merged);
  await runSweep([armedPr(), mergedUnderUsPr()], d, DEFAULT_SWEEP_POLICY);
  const rows = readLedgerLines(d.ledgerPath).filter((l) => l.step === "sweep.disposed");
  const armed = rows.find((l) => l.pr_number === 71);
  const stoodDown = rows.find((l) => l.pr_number === 72);
  assert.equal(armed?.disposition, "mergeable");
  assert.equal(armed?.acted, false);
  assert.equal(armed?.deduped, true, "an already-armed PR is deduped and says so on its one row");
  assert.match(String(armed?.stand_down_reason), /already armed/);
  assert.equal(stoodDown?.acted, false);
  assert.match(String(stoodDown?.stand_down_reason), /MERGED/, "the stand-down names the state on its one row");
  assert.equal(stoodDown?.deduped, undefined, "a PR that was not deduped carries no flag");
});

test("a dry-run sweep pass still ledgers its dispose and stand-down rows because it writes no sweep.disposed row", async () => {
  const d = deps({ ...merged, dryRun: true });
  await runSweep([armedPr(), mergedUnderUsPr()], d, DEFAULT_SWEEP_POLICY);
  const lines = readLedgerLines(d.ledgerPath);
  assert.equal(lines.filter((l) => l.step === "sweep.disposed").length, 0);
  const dispose = lines.filter((l) => l.step === "sweep.dispose");
  assert.equal(dispose.length, 2, "the preview's only per-PR trace");
  assert.ok(dispose.every((l) => l.dry_run === true), "tagged so a preview is never read as a daemon action");
  const notOpen = lines.filter((l) => l.step === "sweep.dispose.not_open" && l.pr_number === 71);
  assert.equal(notOpen.length, 1, "the preview still names the armed PR's stand-down");
  assert.match(String(notOpen[0].reason), /already armed/);
});
