import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LearningEntry } from "../src/lib/learnings.js";
import { readLedgerLines } from "../src/lib/status.js";
import {
  aggregateWipeTestPairs,
  computeMatchedLearningsForArm,
  computeWipeTestDelta,
  ledgerWipeTestPair,
  resolveWipeTestTarget,
  WIPE_TEST_PAIR_STEP,
  WIPE_TEST_SANDBOX_DEFAULT,
  type LearningsInjectionDeps,
  type WipeTestPair,
  type WipeTestRunResult,
} from "../src/lib/wipe-test.js";

// W1-T86 — ratifies P12: injected learnings must be shown to help, or pruned. These
// tests are the harness's own acceptance proofs (plan/tasks.yaml's design).

function entry(id: string, fact: string): LearningEntry {
  return { id, subsystem: "testing", lifecycle: "active", files: ["src/lib/wipe-test.ts"], fact, src: "PR#1" };
}

function tmpLedgerDir(): string {
  return mkdtempSync(join(tmpdir(), "rmd-wipe-test-"));
}

// ── acceptance criterion 1: arm B masks injection, store untouched; arm A carries facts ──

test("computeMatchedLearningsForArm: arm B NEVER calls the load/select/render chain — the store is never touched — and renders zero learning blocks", () => {
  let loadCalls = 0;
  let selectCalls = 0;
  let renderCalls = 0;
  const spyDeps: LearningsInjectionDeps = {
    loadLayeredLearningsForTaskFiles: (...args) => {
      loadCalls++;
      return { entries: [entry("e1", "a fact")] };
    },
    selectLearnings: (...args) => {
      selectCalls++;
      return { selected: [], dropped: [] };
    },
    renderMatchedLearnings: (...args) => {
      renderCalls++;
      return "SHOULD NOT APPEAR";
    },
  };

  const result = computeMatchedLearningsForArm(
    "B",
    { homes: { projectDir: "/nonexistent" }, taskFiles: ["src/lib/wipe-test.ts"] },
    spyDeps,
  );

  assert.equal(loadCalls, 0, "arm B must never call the store loader — masking, not deletion");
  assert.equal(selectCalls, 0, "arm B must never call the selector");
  assert.equal(renderCalls, 0, "arm B must never call the renderer");
  assert.equal(result.matchedLearnings, "", "arm B's rendered prompt text must contain zero learning blocks");
  assert.deepEqual(result.selectedIds, []);
  assert.deepEqual(result.droppedIds, []);
});

test("computeMatchedLearningsForArm: arm A carries the matched learnings via the real chain", () => {
  const facts = [entry("e1", "fact one"), entry("e2", "fact two")];
  let loadCalls = 0;
  const spyDeps: LearningsInjectionDeps = {
    loadLayeredLearningsForTaskFiles: () => {
      loadCalls++;
      return { entries: facts };
    },
    selectLearnings: (entries) => ({ selected: entries, dropped: [] }),
    renderMatchedLearnings: (selected) => selected.map((e) => `- ${e.fact}`).join("\n"),
  };

  const result = computeMatchedLearningsForArm(
    "A",
    { homes: { projectDir: "/nonexistent" }, taskFiles: ["src/lib/wipe-test.ts"] },
    spyDeps,
  );

  assert.equal(loadCalls, 1, "arm A must read the store exactly once");
  assert.match(result.matchedLearnings, /fact one/);
  assert.match(result.matchedLearnings, /fact two/);
  assert.deepEqual(result.selectedIds, ["e1", "e2"]);
});

// ── acceptance criterion 2: paired deltas are computed and ledgered ──

function runResult(over: Partial<WipeTestRunResult>): WipeTestRunResult {
  return {
    taskId: "W1-T999",
    runId: "R1",
    verdict: "merged",
    numTurns: 10,
    costUsd: 1,
    strikes: 0,
    proofExec: [],
    ...over,
  };
}

test("computeWipeTestDelta: computes turn/cost/verdict/strike deltas for one fixture pair (B minus A)", () => {
  const pair: WipeTestPair = {
    taskId: "W1-T999",
    armA: runResult({ runId: "A1", numTurns: 10, costUsd: 2, strikes: 0, verdict: "merged", proofExec: ["executed_pass", "executed_pass"] }),
    armB: runResult({ runId: "B1", numTurns: 18, costUsd: 3.5, strikes: 1, verdict: "blocked_review", proofExec: ["executed_fail", "executed_pass"] }),
  };
  const delta = computeWipeTestDelta(pair);
  assert.equal(delta.taskId, "W1-T999");
  assert.equal(delta.turnsDelta, 8, "masked run took 8 more turns than the injected baseline");
  assert.equal(delta.costDelta, 1.5);
  assert.equal(delta.strikesDelta, 1);
  assert.equal(delta.verdictA, "merged");
  assert.equal(delta.verdictB, "blocked_review");
  assert.equal(delta.verdictChanged, true, "masking flipped the verdict — direct evidence the learnings mattered");
  assert.equal(delta.proofExecPassA, 2);
  assert.equal(delta.proofExecPassB, 1);
});

test("computeWipeTestDelta: an unchanged verdict across arms reports verdictChanged=false", () => {
  const pair: WipeTestPair = {
    taskId: "W1-T999",
    armA: runResult({ verdict: "merged" }),
    armB: runResult({ verdict: "merged" }),
  };
  assert.equal(computeWipeTestDelta(pair).verdictChanged, false);
});

test("ledgerWipeTestPair: writes exactly one wipetest.pair ledger line carrying the turn/cost/verdict deltas", () => {
  const dir = tmpLedgerDir();
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    const pair: WipeTestPair = {
      taskId: "W1-T999",
      armA: runResult({ runId: "A1", numTurns: 10, costUsd: 2, verdict: "merged" }),
      armB: runResult({ runId: "B1", numTurns: 20, costUsd: 4, verdict: "merged" }),
    };
    const delta = ledgerWipeTestPair(ledgerPath, "WIPETEST-1", pair);
    assert.equal(delta.turnsDelta, 10);

    const lines = readLedgerLines(ledgerPath);
    const pairLines = lines.filter((l) => l.step === WIPE_TEST_PAIR_STEP);
    assert.equal(pairLines.length, 1, "exactly one wipetest.pair line for one pair");
    const line = pairLines[0];
    assert.equal(line.task_id, "W1-T999");
    assert.equal(line.turns_delta, 10);
    assert.equal(line.cost_delta, 2);
    assert.equal(line.verdict_a, "merged");
    assert.equal(line.verdict_b, "merged");
    assert.equal(line.verdict_changed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("aggregateWipeTestPairs: aggregates two seeded pairs correctly (avg deltas + verdict-changed count/rate)", () => {
  const pairs: WipeTestPair[] = [
    {
      taskId: "W1-T1",
      armA: runResult({ runId: "A1", numTurns: 10, costUsd: 2, strikes: 0, verdict: "merged" }),
      armB: runResult({ runId: "B1", numTurns: 20, costUsd: 4, strikes: 1, verdict: "merged" }),
    },
    {
      taskId: "W1-T2",
      armA: runResult({ runId: "A2", numTurns: 12, costUsd: 3, strikes: 0, verdict: "merged" }),
      armB: runResult({ runId: "B2", numTurns: 12, costUsd: 3, strikes: 0, verdict: "blocked_review" }),
    },
  ];
  const agg = aggregateWipeTestPairs(pairs);
  assert.equal(agg.pairs, 2);
  // pair 1: turnsDelta=10, costDelta=2, strikesDelta=1; pair 2: turnsDelta=0, costDelta=0, strikesDelta=0
  assert.equal(agg.avgTurnsDelta, 5);
  assert.equal(agg.avgCostDelta, 1);
  assert.equal(agg.avgStrikesDelta, 0.5);
  assert.equal(agg.verdictChangedCount, 1, "only pair 2 flipped verdict");
  assert.equal(agg.verdictChangedRate, 0.5);
});

test("aggregateWipeTestPairs: zero pairs is a well-defined empty aggregate, never NaN", () => {
  const agg = aggregateWipeTestPairs([]);
  assert.equal(agg.pairs, 0);
  assert.equal(agg.avgTurnsDelta, 0);
  assert.equal(agg.avgCostDelta, 0);
  assert.equal(agg.avgStrikesDelta, 0);
  assert.equal(agg.verdictChangedCount, 0);
  assert.equal(agg.verdictChangedRate, 0);
});

// ── acceptance criterion 3: the harness refuses non-sandbox targets by default ──

test("resolveWipeTestTarget: no --repo defaults to the sandbox, no refusal", () => {
  const resolved = resolveWipeTestTarget([]);
  assert.ok("target" in resolved);
  assert.equal((resolved as { target: { repo: string } }).target.repo, WIPE_TEST_SANDBOX_DEFAULT);
});

test("resolveWipeTestTarget: target=remudero (primary repo) without --allow-non-sandbox is REFUSED, naming the sandbox default", () => {
  const resolved = resolveWipeTestTarget(["--repo", "remudero"]);
  assert.ok("error" in resolved, "a non-sandbox target must be refused by default");
  const err = (resolved as { error: string }).error;
  assert.match(err, /remudero-sandbox/, "the refusal must name the sandbox default so the operator knows the fix");
  assert.match(err, /remudero/);
});

test("resolveWipeTestTarget: --repo remudero --allow-non-sandbox is honored (explicit override)", () => {
  const resolved = resolveWipeTestTarget(["--repo", "remudero", "--allow-non-sandbox"]);
  assert.ok("target" in resolved);
  assert.equal((resolved as { target: { repo: string } }).target.repo, "remudero");
});

test("resolveWipeTestTarget: an explicit --repo naming the sandbox itself is never refused", () => {
  const resolved = resolveWipeTestTarget(["--repo", WIPE_TEST_SANDBOX_DEFAULT]);
  assert.ok("target" in resolved);
});
