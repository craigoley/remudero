import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Config } from "../src/lib/config.js";
import type { Plan } from "../src/lib/plan.js";
import { DEFAULT_SWEEP_POLICY } from "../src/lib/sweep.js";
import { buildSweepEffects, type BuildSweepEffectsDeps } from "../src/run-task.js";

const EFFECT_KEYS = [
  "arm",
  "close",
  "dispatchFix",
  "escalate",
  "readLiveState",
  "terminalFixStandDown",
  "readRedBaseRefreshFacts",
  "depReview",
  "postReview",
  "repushAbsent",
  "updateBranch",
  "captureRepairFeedback",
  "disarmAutoMerge",
  "requeueCheck",
  "escalateCancelledCheck",
  "escalateInfrastructureCheck",
  "readCiGateRollup",
  "reaggregateCiGate",
  "readMainTip",
  "releaseBaseCausedStandDown",
  "selectAdaptiveReviewWidth",
] as const;

test("buildSweepEffects takes one typed deps object and returns the sweep effects surface", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-build-sweep-effects-deps-"));
  try {
    const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const deps: BuildSweepEffectsDeps = {
      owner: "craigoley",
      repo: "remudero",
      config: { root, claudeBin: "/bin/true" } as Config,
      ledgerPath: join(root, "state", "ledger.ndjson"),
      runId: "SWEEP-W1-T2889",
      plan: { tasks: [], byId: new Map() } as unknown as Plan,
      log: (step, extra) => logs.push({ step, extra }),
      policy: DEFAULT_SWEEP_POLICY,
      reviewRunner: async () => 0,
      issuesImpl: { create: () => "https://github.com/craigoley/remudero/issues/1" },
      stallNotice: () => {},
      armImpl: () => "armed",
      armSessionPrsOverride: false,
      captureRepairFeedbackImpl: () => {},
      ghRunImpl: () => {},
      spawnWallClockBoundMsOverride: 1,
      reclaimWorkerImpl: () => {},
      disarmImpl: () => undefined,
      readJsonImpl: async () => ({}),
      registeredWorktreeOwnerImpl: () => undefined,
    };

    const effects = buildSweepEffects(deps);

    assert.deepEqual(Object.keys(effects).sort(), [...EFFECT_KEYS].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// @ts-expect-error owner is a required named field, not an omittable positional slot.
const missingRequiredFieldFails: BuildSweepEffectsDeps = {
  repo: "remudero",
  config: { root: "/tmp" } as Config,
  ledgerPath: "/tmp/ledger.ndjson",
  runId: "SWEEP-W1-T2889",
  plan: { tasks: [], byId: new Map() } as unknown as Plan,
  log: () => {},
};

void missingRequiredFieldFails;
