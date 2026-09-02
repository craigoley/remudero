import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadMounts, mountsPath } from "../src/lib/mounts.js";
import { mountRecommendationProposalCandidate, recommendMounts, type MountHeadroomCell } from "../src/lib/mount-recommender.js";
import { runMountRecommenderRung } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sweep = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "mount-headroom-sweep.mjs")).href)) as {
  armFieldsByRunId: (records: unknown[]) => Map<string, { provider: string; servedModel: string; effort: string }>;
  windowEvidenceByRunId: (
    records: unknown[],
    arms: Map<string, { provider: string; servedModel: string; effort: string }>,
  ) => Map<string, {
    eligibleCalls: number;
    measuredCalls: number;
    unreadableCalls: number;
    totalPercentConsumed: number;
    reasons: string[];
    newestMeasurementTs?: string;
  }>;
  buildMountHeadroomSweep: (stateDir: string) => {
    cells: Array<{ arms: Array<{
      armKey: string;
      distinctSettledTasks: number;
      windowShare: { provider: string; percentConsumedPerCompletedTask: number | null };
      windowEvidence: {
        eligibleCalls: number;
        measuredCalls: number;
        unreadableCalls: number;
        reasons: string[];
        newestMeasurementTs?: string;
      };
    }> }>;
  };
  renderMountHeadroomReport: (report: unknown) => string;
};

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function implementation(opts: {
  runId?: string;
  step?: "implement.done" | "implement.resumed";
  provider?: string;
  servedModel?: string;
  effort?: string;
  ts?: string;
  window?: unknown;
} = {}): Record<string, unknown> {
  return {
    ts: opts.ts ?? "2026-09-02T01:00:00.000Z",
    run_id: opts.runId ?? "R1",
    step: opts.step ?? "implement.done",
    provider: opts.provider ?? "claude",
    served_model: opts.servedModel ?? "haiku",
    effort: opts.effort ?? "medium",
    ...(opts.window === undefined
      ? {}
      : { window_consumption: opts.window }),
  };
}

function measure(records: unknown[]) {
  const arms = sweep.armFieldsByRunId(records);
  return sweep.windowEvidenceByRunId(records, arms).get("R1")!;
}

test("implementation window deltas aggregate across redispatches over the distinct-task denominator and expose coverage/freshness", () => {
  const dir = tmp("rmd-window-share-");
  try {
    const lines = [
      { ts: "2026-09-02T00:00:00.000Z", run_id: "R1", task_id: "T1", step: "run.start", type: "implement", risk: "medium", task_class: "src" },
      implementation({ runId: "R1", ts: "2026-09-02T00:01:00.000Z", window: { provider: "claude", percent_consumed: 2 } }),
      { ts: "2026-09-02T00:02:00.000Z", run_id: "R1", task_id: "T1", step: "verdict", verdict: "blocked_ci", cost_usd: 1 },
      { ts: "2026-09-02T01:00:00.000Z", run_id: "R2", task_id: "T1", step: "run.start", type: "implement", risk: "medium", task_class: "src" },
      implementation({ runId: "R2", ts: "2026-09-02T01:01:00.000Z", window: { provider: "claude", percent_consumed: 3 } }),
      { ts: "2026-09-02T01:02:00.000Z", run_id: "R2", task_id: "T1", step: "verdict", verdict: "merged", cost_usd: 1 },
    ];
    writeFileSync(join(dir, "ledger.ndjson"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

    const report = sweep.buildMountHeadroomSweep(dir);
    const arm = report.cells[0]!.arms[0]!;
    assert.equal(arm.distinctSettledTasks, 1);
    assert.deepEqual(arm.windowShare, { provider: "claude", percentConsumedPerCompletedTask: 5 });
    assert.deepEqual(arm.windowEvidence, {
      eligibleCalls: 2,
      measuredCalls: 2,
      unreadableCalls: 0,
      reasons: [],
      newestMeasurementTs: "2026-09-02T01:01:00.000Z",
    });
    assert.match(sweep.renderMountHeadroomReport(report), /window=5%\/completed-task; coverage=2\/2; unreadable=0; newest=2026-09-02T01:01:00.000Z/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing, null, malformed, negative, cross-provider and mixed-resume measurements invalidate the whole arm instead of becoming zero or a partial sum", () => {
  const cases: Array<[string, unknown[], RegExp]> = [
    ["missing", [implementation()], /missing-window-consumption/],
    ["null reset", [implementation({ window: { provider: "claude", percent_consumed: null, reason: "window-reset" } })], /window-reset/],
    ["malformed", [implementation({ window: { provider: "claude", percent_consumed: "2" } })], /invalid-percent-consumed/],
    ["negative", [implementation({ window: { provider: "claude", percent_consumed: -1 } })], /invalid-percent-consumed/],
    ["cross-provider", [implementation({ window: { provider: "codex", percent_consumed: 2 } })], /window-provider-mismatch/],
    ["mixed resume", [
      implementation({ window: { provider: "claude", percent_consumed: 1 } }),
      implementation({ step: "implement.resumed", provider: "codex", servedModel: "gpt-5.6-terra", window: { provider: "codex", percent_consumed: 1 } }),
    ], /mixed-implementation-arm/],
  ];
  for (const [name, records, reason] of cases) {
    const evidence = measure(records);
    assert.equal(evidence.eligibleCalls, records.length, name);
    assert.ok(evidence.unreadableCalls > 0, name);
    assert.match(evidence.reasons.join(" "), reason, name);
  }

  const partial = measure([
    implementation({ window: { provider: "claude", percent_consumed: 2 } }),
    implementation({ step: "implement.resumed" }),
  ]);
  assert.equal(partial.measuredCalls, 1);
  assert.equal(partial.unreadableCalls, 1);
  assert.equal(partial.totalPercentConsumed, 2, "the measured subtotal stays observable");
});

function cell(windowA: number | null, windowB: number | null): MountHeadroomCell {
  const cellKey = "implement::medium::src";
  const a = {
    cellKey, armKey: "claude::haiku::medium", provider: "claude", servedModel: "haiku", effort: "medium", n: 40,
    outcomes: { passing: 38, blockedCi: 2, redispatched: 0 }, costP50: 1, costP90: 1.2, costMax: 1.2,
    costPerCompletedTaskUsd: 1.1, windowShare: { provider: "claude", percentConsumedPerCompletedTask: windowA },
    windowEvidence: { eligibleCalls: 40, measuredCalls: windowA === null ? 39 : 40, unreadableCalls: windowA === null ? 1 : 0, reasons: windowA === null ? ["window-reset"] : [] },
  };
  const b = {
    cellKey, armKey: "codex::sonnet::medium", provider: "codex", servedModel: "sonnet", effort: "medium", n: 40,
    outcomes: { passing: 36, blockedCi: 4, redispatched: 0 }, costP50: 3, costP90: 4, costMax: 4,
    costPerCompletedTaskUsd: 3.5, windowShare: { provider: "codex", percentConsumedPerCompletedTask: windowB },
    windowEvidence: { eligibleCalls: 40, measuredCalls: windowB === null ? 39 : 40, unreadableCalls: windowB === null ? 1 : 0, reasons: windowB === null ? ["capacity-unreadable"] : [] },
  };
  return {
    cellKey, type: "implement", risk: "medium", taskClass: "src", arms: [a, b],
    comparisons: [{ cellKey, armKeyA: a.armKey, armKeyB: b.armKey, nA: 40, nB: 40, cheaperByCostP50: a.armKey, cheaperByCostPerCompletedTask: a.armKey, advantageHoldsUnderRedispatch: true, note: "stable" }],
  };
}

test("subscription compares complete provider-owned window shares, while incomplete evidence falls back as one comparable notional-dollar objective and says why", () => {
  const mounts = loadMounts(mountsPath(REPO_ROOT));
  const windowDecision = recommendMounts([cell(5, 1)], mounts, { minSampleN: 1, billingMode: "subscription", warn: () => {} });
  assert.equal(windowDecision[0]?.kind, "refusal");
  assert.equal(windowDecision[0]?.kind === "refusal" ? windowDecision[0].reason : "", "objective-disagreement");

  const fallback = recommendMounts([cell(null, 1)], mounts, { minSampleN: 1, billingMode: "subscription", warn: () => {} })[0]!;
  assert.equal(fallback.kind, "recommendation");
  if (fallback.kind !== "recommendation") return;
  assert.equal(fallback.objective.kind, "notional-dollar");
  assert.match(fallback.objective.fallbackReasons?.join(" ") ?? "", /window-reset|window-share.*unreadable/);
  assert.match(mountRecommendationProposalCandidate(fallback).summary, /fallback.*window/i);

  const api = recommendMounts([cell(99, 1)], mounts, { minSampleN: 1, billingMode: "api" })[0]!;
  assert.equal(api.kind, "recommendation");
  if (api.kind === "recommendation") assert.equal(api.objective.kind, "notional-dollar");
});

test("the production rung derives and reports the material billing mode from the same sanctioned worker environment boundary", async () => {
  const root = tmp("rmd-window-billing-");
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    const lines = [
      { ts: "2026-09-02T00:00:00.000Z", run_id: "R1", task_id: "T1", step: "run.start", type: "implement", risk: "medium", task_class: "src" },
      implementation({ window: { provider: "claude", percent_consumed: 1 } }),
      { ts: "2026-09-02T00:02:00.000Z", run_id: "R1", task_id: "T1", step: "verdict", verdict: "merged", cost_usd: 1 },
    ];
    writeFileSync(join(root, "state", "ledger.ndjson"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    const events: Array<[string, Record<string, unknown> | undefined]> = [];
    const config = { claudeBin: "/bin/true", root, overflow: "api_key", dailyCapUsd: 10 } as Config;
    await runMountRecommenderRung(config, "RUN", (step, extra) => events.push([step, extra]), {
      root: REPO_ROOT,
      env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "test-only-not-logged" },
    });
    const swept = events.find(([step]) => step === "mount_recommendation.swept");
    assert.equal(swept?.[1]?.billing_mode, "api");
    assert.doesNotMatch(JSON.stringify(events), /test-only-not-logged/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
