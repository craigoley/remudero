import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  CostAnomalyPolicyError,
  detectCostAnomalies,
  loadCostAnomalyPolicy,
  parseCostAnomalyPolicy,
} from "../src/lib/cost-anomaly.js";
import type { RunSummary } from "../src/lib/retro.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const POLICY_PATH = join(REPO_ROOT, "plan", "policy.yaml");
const PLACEHOLDER_MULTIPLIER = 3;
const EXPECTED_MULTIPLIER = 8;
const OBSERVED_RUN_COUNT = 647;
const ORDINARY_VARIANCE_FLAGGED_AT_THREE = 33;
const RUNAWAYS_FLAGGED_AT_EIGHT = 2;

function observedImplementDistribution(): RunSummary[] {
  const runs: RunSummary[] = [];
  for (let i = 0; i < 614; i += 1) {
    runs.push(run(`BASE-${i}`, 4.23));
  }
  for (let i = 0; i < 31; i += 1) {
    runs.push(run(`VARIANCE-${i}`, 16.37));
  }
  for (let i = 0; i < RUNAWAYS_FLAGGED_AT_EIGHT; i += 1) {
    runs.push(run(`RUNAWAY-${i}`, 42.27));
  }
  return runs;
}

function run(runId: string, costUsd: number): RunSummary {
  return {
    runId,
    taskId: runId,
    type: "implement",
    startTs: "2026-09-08T00:00:00.000Z",
    verdict: "merged",
    costUsd,
    numTurns: 1,
    taskClass: "implement",
  };
}

function rawCostAnomalyRows(): {
  multiplier: { value: number; min: number; max: number; origin: string };
  minSamples: { value: number; min: number; max: number; origin: string };
} {
  const raw = parseYaml(readFileSync(POLICY_PATH, "utf8")) as {
    costAnomaly: {
      multiplier: { value: number; min: number; max: number; origin: string };
      minSamples: { value: number; min: number; max: number; origin: string };
    };
  };
  return raw.costAnomaly;
}

function throwsCostAnomalyPolicyError(fn: () => unknown, msgRe: RegExp): void {
  assert.throws(fn, (e: unknown) => e instanceof CostAnomalyPolicyError && msgRe.test((e as Error).message));
}

test("costAnomaly.multiplier: committed row flags only 2 of 647 observed implement runs, not the placeholder's 33", () => {
  const policy = loadCostAnomalyPolicy(POLICY_PATH);
  assert.equal(policy.multiplier, EXPECTED_MULTIPLIER);

  const runs = observedImplementDistribution();
  assert.equal(runs.length, OBSERVED_RUN_COUNT);

  const oldFindings = detectCostAnomalies(runs, { ...policy, multiplier: PLACEHOLDER_MULTIPLIER });
  const committedFindings = detectCostAnomalies(runs, policy);

  assert.equal(oldFindings.length, ORDINARY_VARIANCE_FLAGGED_AT_THREE);
  assert.equal(committedFindings.length, RUNAWAYS_FLAGGED_AT_EIGHT);
  assert.ok(committedFindings.length < oldFindings.length / 10, "the committed threshold removes the ordinary-variance bulk");
  assert.deepEqual(committedFindings.map((f) => f.runId), ["RUNAWAY-0", "RUNAWAY-1"]);
});

test("costAnomaly.multiplier: the policy row records the measured flag rate that justifies value 8", () => {
  const policyText = readFileSync(POLICY_PATH, "utf8");
  assert.match(policyText, /647 settled `implement\.done` rows/);
  assert.match(policyText, /multiplier 8\s+\(> \$33\.81\):\s+2 runs flagged\s+\(0\.3%\)/);
});

test("costAnomaly.multiplier: the committed value stays inside the row's declared bound", () => {
  const rows = rawCostAnomalyRows();
  const policy = loadCostAnomalyPolicy(POLICY_PATH);

  assert.equal(policy.multiplier, rows.multiplier.value);
  assert.equal(rows.multiplier.value, EXPECTED_MULTIPLIER);
  assert.ok(rows.multiplier.value >= rows.multiplier.min);
  assert.ok(rows.multiplier.value <= rows.multiplier.max);
});

test("costAnomaly.minSamples: unchanged at 5 while the threshold moves", () => {
  const rows = rawCostAnomalyRows();
  const policy = loadCostAnomalyPolicy(POLICY_PATH);

  assert.equal(policy.minSamples, 5);
  assert.equal(rows.minSamples.value, 5);
  assert.equal(rows.minSamples.min, 3);
  assert.equal(rows.minSamples.max, 15);
});

test("costAnomaly policy: the loader still refuses a multiplier outside the committed bound", () => {
  const rows = rawCostAnomalyRows();
  const policy = {
    costAnomaly: {
      multiplier: { ...rows.multiplier, value: rows.multiplier.max + 1 },
      minSamples: rows.minSamples,
    },
  };

  throwsCostAnomalyPolicyError(() => parseCostAnomalyPolicy(policy), /out of its declared bound/);
});
