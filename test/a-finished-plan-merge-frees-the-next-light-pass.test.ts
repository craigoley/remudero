/**
 * A light pass's W1-T5901 plan-merge claim ends when ITS plan PR's sweep settles, not when the
 * whole pass does.
 *
 * MEASURED 2026-10-13: a light pass also awaits every other PR it disposes, and one ran ~20 min
 * (its rows carried a 1,190,922 ms snapshot age). It held the one-plan-merge claim the whole time,
 * so every overlapping light pass deferred every ready plan PR: #11367, #11368 and #11371 sat green,
 * reviewed and mergeable for 16-22 min.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readLedgerLines } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { lightPassActionable } from "#src/run-task.js";
import { DEFAULT_SWEEP_POLICY, runSweepLightPass, type OpenPrView, type SweepDeps } from "#test/helpers/sweep-test.js";

const NOW = Date.parse("2026-10-13T15:00:00Z");

function readyPr(prNumber: number, isPlanFiling: boolean): OpenPrView {
  return {
    prNumber,
    prUrl: `https://github.com/craigoley/remudero/pull/${prNumber}`,
    taskId: `W1-T${prNumber}`,
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW - 60_000).toISOString(),
    headSha: `head${prNumber}`,
    autoMergeArmed: false,
    isPlanFiling,
  };
}

/** Every pass shares one ledger; `blockOn` arms hang on `gate` until the test releases them. */
function deps(ledger: string, armed: number[], gate: Promise<void>, blockOn: Set<number>): SweepDeps {
  return {
    log: () => {},
    arm: async (p) => {
      armed.push(p.prNumber);
      if (blockOn.has(p.prNumber)) await gate;
      return "armed" as const;
    },
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    postReview: () => {},
    ledgerPath: ledger,
    runId: "SWEEP-PLAN-CLAIM-1",
    now: () => NOW,
    // production's own ordinary light-pass gate (`buildSweepLightHook`): arms admitted.
    actionable: (d) => lightPassActionable(d, false, false, true),
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function standDown(ledger: string, prNumber: number): string {
  const row = readLedgerLines(ledger).findLast((l) => l.step === "sweep.disposed" && l.pr_number === prNumber);
  return String(row?.stand_down_reason ?? "");
}

test("an overlapping light pass merges its plan PR once the long pass's own plan merge has finished", async () => {
  const ledger = join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}plan-claim-`)), "ledger.ndjson");
  const armed: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  // pass A: a code PR whose arm hangs keeps the pass open after its plan PR (9302) has merged
  const slowCode = readyPr(9301, false);
  const firstPlan = readyPr(9302, true);
  const passA = runSweepLightPass([slowCode, firstPlan], deps(ledger, armed, gate, new Set([9301])), DEFAULT_SWEEP_POLICY);
  for (let i = 0; i < 200 && !(armed.includes(9301) && armed.includes(9302)); i++) await settle();
  assert.ok(armed.includes(9302) && armed.includes(9301), "precondition: A's plan PR merged, its code arm still in flight");

  const secondPlan = readyPr(9303, true);
  await runSweepLightPass([secondPlan], deps(ledger, armed, gate, new Set()), DEFAULT_SWEEP_POLICY);
  assert.ok(armed.includes(9303), `the overlapping pass merged its own plan PR, not deferred: ${standDown(ledger, 9303)}`);
  assert.doesNotMatch(standDown(ledger, 9303), /one plan PR direct-merges per light pass/);

  release();
  await passA;
});

test("a finishing light pass never releases a plan-merge claim another pass holds", async () => {
  const ledger = join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}plan-claim-`)), "ledger.ndjson");
  const armed: number[] = [];
  let releaseHolder!: () => void;
  const holderGate = new Promise<void>((resolve) => { releaseHolder = resolve; });
  let releaseOld!: () => void;
  const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
  // an older pass whose plan merge finished but whose code arm still hangs
  const oldPass = runSweepLightPass([readyPr(9311, false), readyPr(9312, true)],
    deps(ledger, armed, oldGate, new Set([9311])), DEFAULT_SWEEP_POLICY);
  for (let i = 0; i < 200 && !(armed.includes(9311) && armed.includes(9312)); i++) await settle();
  // a newer pass now holds the claim: its plan merge hangs
  const holder = runSweepLightPass([readyPr(9313, true)], deps(ledger, armed, holderGate, new Set([9313])), DEFAULT_SWEEP_POLICY);
  for (let i = 0; i < 200 && !armed.includes(9313); i++) await settle();
  assert.ok(armed.includes(9313), "precondition: the newer pass holds the plan-merge claim");

  releaseOld();
  await oldPass; // the old pass ends; it must not clear the newer pass's claim
  await runSweepLightPass([readyPr(9314, true)], deps(ledger, armed, holderGate, new Set()), DEFAULT_SWEEP_POLICY);
  assert.ok(!armed.includes(9314), "a third pass still defers while the newer claim is live");
  assert.match(standDown(ledger, 9314), /one plan PR direct-merges per light pass/);

  releaseHolder();
  await holder;
});
