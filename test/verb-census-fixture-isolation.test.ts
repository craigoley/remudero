import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildMeasurementCadenceDaemonHooks } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("W1-T4758: verb census daemon fixture isolates unrelated human verification", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-vc-cadence-"));
  try {
    mkdirSync(join(root, "state"), { recursive: true }); // no ledger archive: the corpus refuses
    let verified = 0;
    // No `run`/`check` override: the real daemon producer executes against this checkout.
    // Only independent cadence leaves are pinned to keep this fixture on its verb-census claim.
    const hooks = buildMeasurementCadenceDaemonHooks({
      config: { root } as Config,
      policy: { values: { measurementCadence: { escalate: false } } } as never,
      now: () => new Date("2026-08-25T12:00:00Z"),
      creditedMergedIds: () => new Set(),
      verifyHumanCadenceResult: async (checkout) => {
        verified++;
        assert.equal(checkout, repoRoot);
        return {
          parked: 0,
          judged: 0,
          needsOperator: [],
          automated: [],
          backlog: [],
          judgeFailed: [],
          skipped: [],
          stateChanged: [],
          ageBandReasks: [],
          status: "clear",
        };
      },
      successorWatch: async () => ({}) as never,
      adoptionShipDateFor: () => "fixture-date",
      adoptionShipDateForAsync: async () => "fixture-date",
      proofDebtInput: () => undefined,
      planReconcileLand: () => {
        throw new Error("a verb-census fixture must never reach the plan-reconcile landing bridge");
      },
      coverageImprovementReader: () => ({ status: "refused", reason: "no_coverage_merged_artifact", detail: "offline fixture" }),
    });
    const result = await hooks.runMeasurementCadence();
    assert.equal(verified, 1, "the daemon hook must call the injected verifier once");
    assert.ok(result.verbCensus, "the real daemon producer must attach a verbCensus");
    assert.equal(result.verbCensus.status, "refused", "no ledger archive exists in this fixture — refused, not a fabricated zero");
    assert.match(result.verbCensus.refusedReason ?? "", /ledger corpus incomplete/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
