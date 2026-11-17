import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rotateLedger } from "#src/lib/ledger.js";
import { readLedgerLines } from "#src/lib/status.js";
import { DEFAULT_SWEEP_POLICY, runSweep, type OpenPrView, type SweepDeps } from "#test/helpers/sweep-test.js";

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  step: "sweep.disposed",
  pr_number: 4522,
  head_sha: "c93b421ec55799d01b1de0cc8b76d25a1cce96be",
  disposition: "mergeable",
  acted: false,
  ...over,
});

test("W1-T9938: sweep.repeat_escalated no longer recurs", async () => {
  const now = Date.parse("2026-12-01T12:00:00.000Z");
  const target: OpenPrView = {
    prNumber: 4522,
    prUrl: "https://github.com/acme/widgets/pull/4522",
    taskId: "W1-T9938",
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(now).toISOString(),
    headSha: "c93b421ec55799d01b1de0cc8b76d25a1cce96be",
    autoMergeArmed: true,
  };

  async function tripsAfterRotation(withMarker: boolean): Promise<number> {
    const dir = mkdtempSync(join(tmpdir(), "rmd-repeat-rotation-"));
    try {
      const ledgerPath = join(dir, "ledger.ndjson");
      const rows = [
        ...(withMarker ? [row({
          ts: "2026-10-01T00:00:00.000Z",
          run_id: "SWEEP-marker",
          task_id: target.taskId,
          repeat_streak: 60,
          repeat_escalated: true,
        })] : []),
        row({
          ts: "2026-11-30T00:01:00.000Z",
          run_id: "SWEEP-latest-acted",
          task_id: target.taskId,
          repeat_streak: 60,
          acted: true,
        }),
        ...Array.from({ length: 300 }, (_, i) => ({
          ts: "2026-10-01T00:02:00.000Z",
          run_id: `noise-${i}`,
          task_id: "_rotation-test",
          step: "rotation.test_noise",
          n: i,
        })),
      ];
      writeFileSync(ledgerPath, `${rows.map((item) => JSON.stringify(item)).join("\n")}\n`);
      assert.equal(readLedgerLines(ledgerPath).some((line) => line.acted === true), true, "seed includes acted evidence");
      const rotation = rotateLedger(ledgerPath, {
        ceilingBytes: 2_000,
        smoothingWindowMs: 0,
        now: () => new Date(now),
      });
      assert.equal(rotation.rotated, true, "fixture crosses the real ledger rotation path");
      const rotated = readLedgerLines(ledgerPath).filter((line) => line.step === "sweep.disposed");
      assert.equal(rotated.some((line) => line.repeat_escalated === true), withMarker,
        "rotation keeps the marker for the unchanged newest head, even past the ordinary standing window");
      assert.ok(rotated.some((line) => line.acted === true), "rotation keeps the latest acted evidence too");

      const repeatTrips: Record<string, unknown>[] = [];
      const deps: SweepDeps = {
        ledgerPath,
        runId: "W1-T9938-after-rotation",
        now: () => now,
        arm: () => {},
        close: () => {},
        escalate: () => {},
        log: (step, extra = {}) => {
          if (step === "sweep.repeat_escalated") repeatTrips.push({ ...(extra as Record<string, unknown>) });
        },
      };
      await runSweep([target], deps, { ...DEFAULT_SWEEP_POLICY, repeatDispositionBound: 3 });
      return repeatTrips.length;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  assert.equal(await tripsAfterRotation(true), 0,
    "the production sweep's repeatAlreadyEscalated guard stays shut after real rotation");
  assert.equal(await tripsAfterRotation(false), 1,
    "FALSIFIER: without the surviving marker, the same over-bound head trips again");
});
