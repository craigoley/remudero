/**
 * W1-T4670 — borrow NVIDIA Model-Optimizer's AutoQuantize: estimate per queued task the gain an
 * Opus/high-effort upgrade would buy and its share of the live window, spend the window where the
 * gain is largest, and prove the policy first on an offline replay before it ever touches a live
 * spawn.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  allocateUpgrades,
  estimateUpgradeGain,
  extractUpgradeReplayRow,
  replayUpgradeAllocationPolicy,
  resolveUpgradeAllocationReplay,
  type UpgradeCandidateTask,
  type UpgradeReplayRow,
} from "../src/lib/upgrade-allocation.js";
import { queuedUpgradeAllocation } from "../src/lib/worker-provider.js";

const ESTIMATED = (estimate: number) => ({ state: "estimated" as const, estimate });
const INSUFFICIENT = { state: "insufficient" as const };

// ── estimateUpgradeGain ─────────────────────────────────────────────────────────────────────────

test("estimateUpgradeGain returns the sigmoid probability delta a stronger model buys over a weaker one on the same task", () => {
  const gain = estimateUpgradeGain({ baseline: ESTIMATED(-0.5), upgraded: ESTIMATED(1.5), taskDifficulty: ESTIMATED(0.2) });
  assert.equal(gain.state, "estimated");
  if (gain.state !== "estimated") return;
  const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
  const expected = sigmoid(1.5 - 0.2) - sigmoid(-0.5 - 0.2);
  assert.ok(Math.abs(gain.value - expected) < 1e-12);
  assert.ok(gain.value > 0, "a stronger model has a positive gain here");
});

test("estimateUpgradeGain is unavailable — never a fabricated number — when any reading is insufficient", () => {
  assert.deepEqual(
    estimateUpgradeGain({ baseline: INSUFFICIENT, upgraded: ESTIMATED(1), taskDifficulty: ESTIMATED(0) }),
    { state: "unavailable", reason: "baseline-ability-insufficient" },
  );
  assert.deepEqual(
    estimateUpgradeGain({ baseline: ESTIMATED(0), upgraded: INSUFFICIENT, taskDifficulty: ESTIMATED(0) }),
    { state: "unavailable", reason: "upgraded-ability-insufficient" },
  );
  assert.deepEqual(
    estimateUpgradeGain({ baseline: ESTIMATED(0), upgraded: ESTIMATED(1), taskDifficulty: INSUFFICIENT }),
    { state: "unavailable", reason: "task-difficulty-insufficient" },
  );
});

// ── allocateUpgrades ─────────────────────────────────────────────────────────────────────────────

test("W1-T4670: upgrades go to the tasks with the highest predicted gain per window share", () => {
  const candidates: UpgradeCandidateTask[] = [
    // Highest raw gain, but expensive: 0.30 / 20 = 0.015 per window-share point.
    { taskId: "W1-EXPENSIVE", gain: { state: "estimated", value: 0.3 }, windowSharePercent: 20 },
    // Lower raw gain, but cheap: 0.10 / 2 = 0.05 per window-share point — the best ratio.
    { taskId: "W1-CHEAP", gain: { state: "estimated", value: 0.1 }, windowSharePercent: 2 },
    // Mid gain, mid cost: 0.12 / 4 = 0.03 per window-share point.
    { taskId: "W1-MID", gain: { state: "estimated", value: 0.12 }, windowSharePercent: 4 },
  ];
  // Budget covers W1-CHEAP and W1-MID (2 + 4 = 6) but not also W1-EXPENSIVE (would need 26).
  const decisions = allocateUpgrades(candidates, { budgetPercent: 6 });

  assert.deepEqual(decisions.map((d) => d.taskId), ["W1-CHEAP", "W1-MID", "W1-EXPENSIVE"], "spent in ratio order, highest gain-per-window-share first");
  assert.equal(decisions.find((d) => d.taskId === "W1-CHEAP")!.upgraded, true);
  assert.equal(decisions.find((d) => d.taskId === "W1-MID")!.upgraded, true);
  const expensive = decisions.find((d) => d.taskId === "W1-EXPENSIVE")!;
  assert.equal(expensive.upgraded, false, "the highest RAW gain does not win when its window share does not fit the remaining budget");
  assert.equal(expensive.reason, "budget-exhausted");
});

test("an unavailable or non-positive gain is never admitted, however cheap", () => {
  const candidates: UpgradeCandidateTask[] = [
    { taskId: "W1-UNKNOWN", gain: { state: "unavailable", reason: "no-observations" }, windowSharePercent: 1 },
    { taskId: "W1-NO-BENEFIT", gain: { state: "estimated", value: 0 }, windowSharePercent: 1 },
    { taskId: "W1-WORSE", gain: { state: "estimated", value: -0.2 }, windowSharePercent: 1 },
  ];
  const decisions = allocateUpgrades(candidates, { budgetPercent: 100 });
  for (const decision of decisions) assert.equal(decision.upgraded, false);
  assert.equal(decisions.find((d) => d.taskId === "W1-UNKNOWN")!.reason, "unavailable-gain");
  assert.equal(decisions.find((d) => d.taskId === "W1-NO-BENEFIT")!.reason, "non-positive-gain");
  assert.equal(decisions.find((d) => d.taskId === "W1-WORSE")!.reason, "non-positive-gain");
});

test("allocateUpgrades is deterministic — a tied ratio breaks on taskId, independent of input order", () => {
  const a: UpgradeCandidateTask = { taskId: "W1-A", gain: { state: "estimated", value: 0.1 }, windowSharePercent: 5 };
  const b: UpgradeCandidateTask = { taskId: "W1-B", gain: { state: "estimated", value: 0.1 }, windowSharePercent: 5 };
  const forward = allocateUpgrades([a, b], { budgetPercent: 5 });
  const reversed = allocateUpgrades([b, a], { budgetPercent: 5 });
  assert.deepEqual(forward.map((d) => d.taskId), ["W1-A", "W1-B"]);
  assert.deepEqual(reversed.map((d) => d.taskId), ["W1-A", "W1-B"]);
  assert.equal(forward.find((d) => d.taskId === "W1-A")!.upgraded, true);
  assert.equal(forward.find((d) => d.taskId === "W1-B")!.upgraded, false);
});

// ── replayUpgradeAllocationPolicy ───────────────────────────────────────────────────────────────

test("W1-T4670: the offline replay compares allocation against today's policy on merged per window share", () => {
  const rows: UpgradeReplayRow[] = [
    // Recorded as NOT merged under today's fixed-tier policy; a strong predicted gain if upgraded.
    { taskId: "W1-A", windowSharePercent: 5, merged: false, gain: { state: "estimated", value: 0.6 } },
    // Recorded as merged already; upgrading it buys little.
    { taskId: "W1-B", windowSharePercent: 5, merged: true, gain: { state: "estimated", value: 0.05 } },
  ];
  const result = replayUpgradeAllocationPolicy(rows, { budgetPercent: 5 });

  assert.equal(result.rows, 2);
  // Today's policy: 1 merged out of 10 window-share points spent.
  assert.equal(result.todaysPolicy.merged, 1);
  assert.equal(result.todaysPolicy.totalWindowSharePercent, 10);
  assert.ok(Math.abs(result.todaysPolicy.mergedPerWindowSharePercent - 0.1) < 1e-12);
  // The candidate policy spends its 5-point budget on W1-A (best ratio: 0.6/5 = 0.12 vs 0.05/5 =
  // 0.01), nudging its expected merge from 0 to 0.6, while W1-B keeps its recorded 1 — so the
  // SAME total window share now carries a higher expected merge count.
  assert.equal(result.candidatePolicy.decisions.find((d) => d.taskId === "W1-A")!.upgraded, true);
  assert.ok(Math.abs(result.candidatePolicy.expectedMerged - 1.6) < 1e-12);
  assert.ok(result.candidatePolicy.mergedPerWindowSharePercent > result.todaysPolicy.mergedPerWindowSharePercent);
  assert.equal(result.candidateWins, true);
});

test("the offline replay can report today's policy winning — it is a comparison, not a foregone conclusion", () => {
  const rows: UpgradeReplayRow[] = [
    // Already merged, upgrading buys nothing (gain 0) — the candidate policy cannot beat today's here.
    { taskId: "W1-A", windowSharePercent: 5, merged: true, gain: { state: "estimated", value: 0 } },
    { taskId: "W1-B", windowSharePercent: 5, merged: true, gain: { state: "estimated", value: 0 } },
  ];
  const result = replayUpgradeAllocationPolicy(rows, { budgetPercent: 100 });
  assert.equal(result.candidatePolicy.mergedPerWindowSharePercent, result.todaysPolicy.mergedPerWindowSharePercent);
  assert.equal(result.candidateWins, false, "a tie is not a win for the candidate policy");
});

test("replayUpgradeAllocationPolicy is pure and deterministic — the identical corpus replays to the identical verdict", () => {
  const rows: UpgradeReplayRow[] = [
    { taskId: "W1-A", windowSharePercent: 3, merged: false, gain: { state: "estimated", value: 0.4 } },
    { taskId: "W1-B", windowSharePercent: 7, merged: true, gain: { state: "estimated", value: 0.02 } },
  ];
  const first = replayUpgradeAllocationPolicy(rows, { budgetPercent: 3 });
  const second = replayUpgradeAllocationPolicy(JSON.parse(JSON.stringify(rows)), { budgetPercent: 3 });
  assert.deepEqual(first, second);
});

test("an empty corpus replays to zero rows on both policies, never a fabricated comparison", () => {
  const result = replayUpgradeAllocationPolicy([], { budgetPercent: 10 });
  assert.equal(result.rows, 0);
  assert.equal(result.todaysPolicy.mergedPerWindowSharePercent, 0);
  assert.equal(result.candidatePolicy.mergedPerWindowSharePercent, 0);
  assert.equal(result.candidateWins, false);
});

// ── extractUpgradeReplayRow / resolveUpgradeAllocationReplay ────────────────────────────────────

test("extractUpgradeReplayRow reads a ledger-shaped row only when every field it needs is present", () => {
  const good = extractUpgradeReplayRow({
    task_id: "W1-T1",
    window_share_percent: 4,
    outcome: "merged",
    upgrade_gain: { state: "estimated", value: 0.2 },
  });
  assert.deepEqual(good, {
    taskId: "W1-T1",
    windowSharePercent: 4,
    merged: true,
    gain: { state: "estimated", value: 0.2 },
  });

  // Missing task_id, missing window_share_percent, missing upgrade_gain, and today's real rows
  // (W1-T4617/W1-T4618/W1-T4626 shapes) carry none of these fields at all — every one drops.
  assert.equal(extractUpgradeReplayRow({ window_share_percent: 4, upgrade_gain: { state: "estimated", value: 0.2 } }), undefined);
  assert.equal(extractUpgradeReplayRow({ task_id: "W1-T1", upgrade_gain: { state: "estimated", value: 0.2 } }), undefined);
  assert.equal(extractUpgradeReplayRow({ task_id: "W1-T1", window_share_percent: 4 }), undefined);
  assert.equal(extractUpgradeReplayRow({ task_id: "W1-T1", window_share_percent: 4, step: "routing.propensity" }), undefined);

  // An "unavailable" gain is a legitimate, non-fabricated reading — not the same as a missing
  // field — so a row carrying one still extracts, keeping its named reason intact.
  const unavailableGain = extractUpgradeReplayRow({
    task_id: "W1-T2",
    window_share_percent: 4,
    outcome: "not-merged",
    upgrade_gain: { state: "unavailable", reason: "no-observations" },
  });
  assert.deepEqual(unavailableGain, {
    taskId: "W1-T2",
    windowSharePercent: 4,
    merged: false,
    gain: { state: "unavailable", reason: "no-observations" },
  });

  // A malformed `upgrade_gain` — an object shaped like neither reading — is dropped, same as a
  // missing field: never guessed at.
  assert.equal(
    extractUpgradeReplayRow({ task_id: "W1-T3", window_share_percent: 4, upgrade_gain: { state: "estimated", value: "not-a-number" } }),
    undefined,
  );
  assert.equal(
    extractUpgradeReplayRow({ task_id: "W1-T3", window_share_percent: 4, upgrade_gain: { state: "mystery" } }),
    undefined,
  );
});

test("resolveUpgradeAllocationReplay refuses honestly when a readable ledger union carries none of the fields this replay reads", () => {
  const resolved = resolveUpgradeAllocationReplay("/fake/state", { budgetPercent: 5 }, () => ({
    ok: true,
    lines: [{ ts: "2026-09-01T00:00:00.000Z", run_id: "RUN-A", task_id: "W1-T1", step: "worker.assignment" }],
  }));
  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.match(resolved.reason, /zero ledger rows under \/fake\/state carry/);
});

test("resolveUpgradeAllocationReplay surfaces the underlying refusal (e.g. a zero-archive union) unchanged", () => {
  const resolved = resolveUpgradeAllocationReplay("/fake/state", { budgetPercent: 5 }, () => ({
    ok: false,
    reason: "zero ledger archive files matched under /fake/state",
  }));
  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.equal(resolved.reason, "zero ledger archive files matched under /fake/state");
});

test("resolveUpgradeAllocationReplay runs the real replay once the ledger carries every field it needs", () => {
  const resolved = resolveUpgradeAllocationReplay("/fake/state", { budgetPercent: 10 }, () => ({
    ok: true,
    lines: [
      { task_id: "W1-A", window_share_percent: 5, outcome: "not-merged", upgrade_gain: { state: "estimated", value: 0.3 } },
      { task_id: "W1-B", window_share_percent: 5, outcome: "merged", upgrade_gain: { state: "estimated", value: 0.01 } },
    ],
  }));
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.result.rows, 2);
  assert.equal(resolved.result.candidatePolicy.decisions.find((d) => d.taskId === "W1-A")!.upgraded, true);
});

test("resolveUpgradeAllocationReplay drops each unusable row and replays only the rest — a real archive is never uniformly shaped", () => {
  const resolved = resolveUpgradeAllocationReplay("/fake/state", { budgetPercent: 10 }, () => ({
    ok: true,
    lines: [
      // Usable.
      { task_id: "W1-A", window_share_percent: 5, outcome: "merged", upgrade_gain: { state: "estimated", value: 0.2 } },
      // Today's real shape (W1-T4617/W1-T4618/W1-T4626 rows) — no upgrade fields at all.
      { task_id: "W1-B", step: "routing.propensity" },
      // Usable.
      { task_id: "W1-C", window_share_percent: 3, outcome: "not-merged", upgrade_gain: { state: "unavailable", reason: "no-observations" } },
    ],
  }));
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  // Only the two usable rows reach the replay; the unusable middle row is dropped, not guessed at.
  assert.equal(resolved.result.rows, 2);
  assert.deepEqual(
    resolved.result.candidatePolicy.decisions.map((d) => d.taskId).sort(),
    ["W1-A", "W1-C"],
  );
});

// ── W1-T4670: the new module is called from src/lib/worker-provider.ts ─────────────────────────

test("queuedUpgradeAllocation (worker-provider.ts) calls allocateUpgrades and is additive: an empty queue upgrades nothing", () => {
  assert.deepEqual(queuedUpgradeAllocation([], { budgetPercent: 100 }), []);

  const candidates: UpgradeCandidateTask[] = [{ taskId: "W1-T1", gain: { state: "estimated", value: 0.2 }, windowSharePercent: 3 }];
  const decisions = queuedUpgradeAllocation(candidates, { budgetPercent: 3 });
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.upgraded, true);
  // Same shape allocateUpgrades itself returns directly, over the identical input.
  assert.deepEqual(decisions, allocateUpgrades(candidates, { budgetPercent: 3 }));
});
