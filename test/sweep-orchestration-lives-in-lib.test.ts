import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Config } from "../src/lib/config.js";
import type { Plan } from "../src/lib/plan.js";
import {
  buildSweepEffects as buildLibSweepEffects,
  DEFAULT_SWEEP_POLICY,
  type BuildSweepEffectsDeps,
} from "../src/lib/sweep.js";
import { buildSweepEffects as buildEntrypointSweepEffects } from "../src/run-task.js";

const EFFECT_KEYS = [
  "arm",
  "captureRepairFeedback",
  "close",
  "depReview",
  "disarmAutoMerge",
  "dispatchFix",
  "escalate",
  "escalateCancelledCheck",
  "escalateInfrastructureCheck",
  "postReview",
  "readCiGateRollup",
  "readLiveState",
  "readMainTip",
  "readRedBaseRefreshFacts",
  "reaggregateCiGate",
  "releaseBaseCausedStandDown",
  "repairMissingTaskTrailer",
  "repushAbsent",
  "requeueCheck",
  "selectAdaptiveReviewWidth",
  "terminalFixStandDown",
  "updateBranch",
] as const;

test("W1-T2890: sweep effects are built from the lib module with the same effect surface", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-sweep-effects-in-lib-"));
  try {
    const deps: BuildSweepEffectsDeps = {
      owner: "craigoley",
      repo: "remudero",
      config: { root, claudeBin: "/bin/true" } as Config,
      ledgerPath: join(root, "state", "ledger.ndjson"),
      runId: "SWEEP-W1-T2890",
      plan: { tasks: [], byId: new Map() } as unknown as Plan,
      log: () => {},
      policy: DEFAULT_SWEEP_POLICY,
      reviewRunner: async () => 0,
      issuesImpl: { create: () => "https://github.com/craigoley/remudero/issues/2890" },
      stallNotice: () => {},
      armImpl: () => "armed",
      armSessionPrsOverride: false,
      updateBranchImpl: async () => "updated",
      captureRepairFeedbackImpl: () => {},
      ghRunImpl: () => {},
      spawnWallClockBoundMsOverride: 1,
      reclaimWorkerImpl: () => {},
      disarmImpl: () => undefined,
      readJsonImpl: async () => ({}),
      updatePrBodyImpl: async () => {},
      registeredWorktreeOwnerImpl: () => undefined,
      registeredOwnerRecovery: { capture: () => undefined, remove: () => undefined },
    };

    const libEffects = buildLibSweepEffects(deps);
    const entrypointEffects = buildEntrypointSweepEffects(deps);

    assert.deepEqual(Object.keys(libEffects).sort(), [...EFFECT_KEYS].sort());
    assert.deepEqual(
      Object.keys(libEffects).sort(),
      Object.keys(entrypointEffects).sort(),
      "the lib-built orchestration must expose the same sweep effect set the entrypoint exposed before the move",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
