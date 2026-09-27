import assert from "node:assert/strict";
import { test } from "node:test";
import { shadowJudgeSampled } from "../src/lib/shadow-judge.js";
import type { Config } from "../src/lib/config.js";
import type { Mount, Mounts } from "../src/lib/mounts.js";
import type { ShardUnderJudgement } from "../src/lib/verify-human-judge.js";
import type { SpawnWorkerArgs, WorkerResult, spawnWorker } from "../src/lib/worker.js";
import { shadowedVerifyHumanJudge } from "../src/run-task.js";

function workerResult(text: string, model: string, servedModel: string): WorkerResult {
  return {
    sessionId: model,
    costUsd: 0,
    numTurns: 1,
    text,
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model,
    servedModel,
    effort: "low",
    tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
  };
}

test("verify-human keeps its primary verdict while recording a separately bounded shadow judge", async () => {
  const primaryMount: Mount = { model: "judge-model", effort: "low", maxTurns: 12, contextBudget: 4_000 };
  const shadowMount: Mount = { model: "review-model", effort: "low", maxTurns: 20, contextBudget: 8_000 };
  const mounts = {
    tiers: { "judge-model": 1, "review-model": 2 },
    efforts: { low: 1 },
    architect: primaryMount,
    judge: primaryMount,
    verify_human_judge: primaryMount,
    synthesis: {},
    routes: { reviewer: { low: { src: shadowMount } } },
  } as unknown as Mounts;
  const config = { root: "/tmp/shadow-judge-test" } as Config;
  const shardId = Array.from({ length: 100 }, (_, i) => `T-SHADOW-${i}`)
    .find((id) => shadowJudgeSampled(`verify-human:${id}:deps=0:cited=0`));
  assert.ok(shardId);
  const shard: ShardUnderJudgement = {
    id: shardId,
    title: "verify-human shadow fixture",
    rationale: "test only",
    acceptance: [],
    ageDays: 0,
    depsAllMerged: false,
    citedInSrc: false,
  };
  const calls: SpawnWorkerArgs[] = [];
  const primary: typeof spawnWorker = async (args) => {
    calls.push(args);
    return workerResult("VERIFY_HUMAN_DECISION: needs_operator\nVERIFY_HUMAN_REASON: primary", "judge-model", "served-primary");
  };
  const shadow: typeof spawnWorker = async (args) => {
    calls.push(args);
    return workerResult("VERIFY_HUMAN_DECISION: backlog\nVERIFY_HUMAN_REASON: shadow", "review-model", "served-shadow");
  };
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const judge = shadowedVerifyHumanJudge({
    mounts,
    config,
    cwd: "/tmp/shadow-judge-test",
    settingsFile: "/tmp/shadow-judge-test/settings.json",
    spawns: { primary, shadow },
    log: (step, fields) => rows.push({ step, fields }),
  });

  const verdict = await judge(shard);

  assert.deepEqual(verdict, { decision: "needs_operator", reason: "primary" });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.model, "review-model");
  assert.equal(calls[1]?.maxTurns, 4);
  assert.equal(calls[1]?.maxBudgetUsd, 0.1);
  assert.deepEqual(calls[1]?.clockBound, { boundMs: 60_000 });
  assert.deepEqual(calls[1]?.tools, []);
  assert.deepEqual(rows.map((row) => row.step), ["shadow_judge.paired"]);
});
