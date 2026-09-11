import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RECON_MAX_TURNS, workerErrorVerdict } from "../src/run-task.js";
import { loadMounts, mountsPath } from "../src/lib/mounts.js";
import type { WorkerResult } from "../src/lib/worker.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MOUNTS_PATH = mountsPath(REPO_ROOT);
const RECON_P99_TURNS = 21;
const RECON_MAX_OBSERVED_TURNS = 26;
const IMPLEMENT_P99_TURNS = 228;

function mountsText(): string {
  return readFileSync(MOUNTS_PATH, "utf8");
}

function allWorkerCells(type: string): Array<{ risk: string; cls: string; maxTurns: number }> {
  const byRisk = loadMounts(MOUNTS_PATH).routes[type];
  assert.ok(byRisk, `routes.${type} must exist`);
  const out: Array<{ risk: string; cls: string; maxTurns: number }> = [];
  for (const [risk, byClass] of Object.entries(byRisk)) {
    for (const [cls, mount] of Object.entries(byClass)) out.push({ risk, cls, maxTurns: mount.maxTurns });
  }
  return out;
}

function clearsReconTail(cap: number): boolean {
  return cap > RECON_P99_TURNS && cap >= Math.ceil(RECON_P99_TURNS * 1.75);
}

function workerResult(overrides: Partial<WorkerResult>): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 0,
    numTurns: 0,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "sonnet",
    effort: "medium",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...overrides,
  };
}

test("every recon cell clears the measured p99 by the recorded margin", () => {
  assert.equal(clearsReconTail(20), false, "the old cap is the load-bearing falsifier: 20 is below p99 21");
  assert.equal(clearsReconTail(RECON_MAX_TURNS), true, "the shipped recon cap is at least 1.75x p99");
  assert.equal(RECON_MAX_TURNS, 40, "the cap is the chosen 1.90x-p99 cliff");
  assert.ok(RECON_MAX_TURNS > RECON_MAX_OBSERVED_TURNS, "the cap clears the observed max");

  const reconCells = allWorkerCells("recon");
  assert.equal(reconCells.length, 7, "every recon risk/class cell is present");
  for (const cell of reconCells) {
    assert.equal(cell.maxTurns, RECON_MAX_TURNS, `routes.recon.${cell.risk}.${cell.cls} mirrors RECON_MAX_TURNS`);
  }

  const text = mountsText();
  assert.match(text, /recon\.done`[\s\S]*rows: p50 6, p90 10, p95 13, p99 21, max 26/);
  assert.match(text, /Recon therefore uses 40: 1\.90x p99/);
});

test("the implement cap stays unchanged and records why it is already a cliff", () => {
  for (const cell of allWorkerCells("implement")) {
    assert.equal(cell.maxTurns, 400, `routes.implement.${cell.risk}.${cell.cls} stays at 400`);
  }
  assert.ok(400 >= Math.ceil(IMPLEMENT_P99_TURNS * 1.75), "400 is still at least 1.75x implement p99");

  const text = mountsText();
  assert.match(text, /implement\.done` rows: p50 72, p90 135, p95 156, p99 228, max 380/);
  assert.match(text, /ZERO runs\s+?# reached 390 or 400/);
});

test("the edited table still loads and preserves the Tier Invariant", () => {
  const mounts = loadMounts(MOUNTS_PATH);
  const architectTier = mounts.tiers[mounts.architect.model];
  const judgeTier = mounts.tiers[mounts.judge.model];
  for (const [type, byRisk] of Object.entries(mounts.routes)) {
    for (const [risk, byClass] of Object.entries(byRisk)) {
      for (const [cls, mount] of Object.entries(byClass)) {
        assert.ok(
          mounts.tiers[mount.model] < architectTier,
          `${type}.${risk}.${cls} must stay below the Architect tier`,
        );
        assert.ok(
          mounts.tiers[mount.model] < judgeTier,
          `${type}.${risk}.${cls} must stay below the flight-judge tier`,
        );
      }
    }
  }
});

test("a genuine recon turn runaway remains a bounded non-budget worker error", () => {
  const turnWall = workerErrorVerdict(
    workerResult({ isError: true, subtype: "error_max_turns", numTurns: RECON_MAX_TURNS + 1 }),
    0.40,
    "recon",
  );
  assert.ok(turnWall, "error_max_turns still reaches the recon retry/degrade branch");
  assert.equal(turnWall.budgetBreach, false, "turn exhaustion is still retryable/degradable, not a budget breach");
  assert.equal(turnWall.ledger.stage, "recon");
  assert.equal(turnWall.ledger.subtype, "error_max_turns");

  const budgetWall = workerErrorVerdict(
    workerResult({ isError: true, subtype: "error_max_budget_usd", numTurns: 5 }),
    10.00,
    "recon",
  );
  assert.equal(budgetWall?.budgetBreach, true, "dollars remain the fatal backstop");
});
