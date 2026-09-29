/**
 * lib/upgrade-allocation.ts — spend the live window's model-upgrade budget where predicted gain
 * per window share is largest (W1-T4670), borrowing NVIDIA Model-Optimizer's AutoQuantize: score
 * each candidate's sensitivity to the expensive option and solve a constrained assignment under a
 * budget. Answers a question neither existing mechanism does: `.remudero/mounts.yaml` fixes tier
 * BY ROLE (a static rule) and `selectWorkerProvider` (worker-provider.ts) auctions WHICH
 * SUBSCRIPTION serves a spawn (never whether THIS spawn deserves the expensive tier).
 *
 * INVARIANT: an unavailable or non-positive gain is never admitted, however cheap its window
 * share — `estimateUpgradeGain`/`allocateUpgrades` read `AbilityCell`-shaped readings
 * (ability-map.ts, W1-T4626) structurally (no import, so a fit failure there cannot throw here)
 * and refuse to compare a computed gain against an unknown one.
 *
 * TRAP this avoids: spending the live window on an unproven policy. Design point (ii) (spending
 * live) is gated on design point (i) (the offline replay) winning first — see
 * `replayUpgradeAllocationPolicy`, which compares this allocation against TODAY's recorded
 * outcomes on the same merged-per-window-share metric. `worker-provider.ts`'s call site
 * (`queuedUpgradeAllocation`) is therefore additive only, never wired into today's spawn path.
 *
 * Today's ledger rows carry none of the joined `task_id`/`window_share_percent`/`upgrade_gain`
 * fields this replay reads yet — `resolveUpgradeAllocationReplay` refuses honestly on that rather
 * than fabricating a verdict. Design (iii), validating the gain proxy against W1-T4625 paired
 * trials, is out of scope. FALSIFIER: test/model-upgrades-are-allocated-across-the-queue.test.ts.
 */

/** One ability-map cell, read structurally — `AbilityCell` (ability-map.ts) satisfies this without
 *  an import. `insufficient` carries no number: thin evidence is blank, never zero. */
export type UpgradeAbilityReading = { state: "estimated"; estimate: number } | { state: "insufficient" };

/** A computed gain, or a named reason it could not be computed — never a fabricated number. */
export type UpgradeGain = { state: "estimated"; value: number } | { state: "unavailable"; reason: string };

function sigmoid(x: number): number {
  return x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));
}

/** {@link estimateUpgradeGain}'s input, NAMED rather than inlined: diff-coverage.mjs only exempts
 *  an erased `interface`/`type X = {` body, not an inline multi-line parameter type literal. */
export interface UpgradeGainInput {
  baseline: UpgradeAbilityReading;
  upgraded: UpgradeAbilityReading;
  taskDifficulty: UpgradeAbilityReading;
}

/**
 * The probability-of-merge delta an upgrade buys for one task, from the ability map's own
 * P(success) = sigmoid(theta_model + theta_role - beta_task): the same role and task difficulty
 * cancel out of the subtraction, leaving only the ability gap between the two tiers.
 */
export function estimateUpgradeGain(input: UpgradeGainInput): UpgradeGain {
  if (input.baseline.state !== "estimated") return { state: "unavailable", reason: "baseline-ability-insufficient" };
  if (input.upgraded.state !== "estimated") return { state: "unavailable", reason: "upgraded-ability-insufficient" };
  if (input.taskDifficulty.state !== "estimated") return { state: "unavailable", reason: "task-difficulty-insufficient" };
  const baselineP = sigmoid(input.baseline.estimate - input.taskDifficulty.estimate);
  const upgradedP = sigmoid(input.upgraded.estimate - input.taskDifficulty.estimate);
  return { state: "estimated", value: upgradedP - baselineP };
}

/** One queued task's upgrade candidacy: the gain an upgrade would buy it, and what that upgrade
 *  would cost expressed as a percent of the live window (the SAME unit `windowBudgetPercent`,
 *  below, is expressed in — a percent of remaining headroom, never a token count or a dollar). */
export interface UpgradeCandidateTask {
  taskId: string;
  gain: UpgradeGain;
  windowSharePercent: number;
}

/** The live window's soft upgrade budget: a percent of remaining headroom that MOVES with it tick
 *  to tick, never a fixed cap — the same "soft budget" the task's own design names. */
export interface LiveUpgradeWindow {
  budgetPercent: number;
}

/** Why a candidate was NOT admitted; absent on an admitted candidate. */
export type UpgradeAllocationSkipReason = "unavailable-gain" | "non-positive-gain" | "budget-exhausted";

export interface UpgradeAllocationDecision {
  taskId: string;
  upgraded: boolean;
  gain: UpgradeGain;
  windowSharePercent: number;
  /** Running total of windowSharePercent spent on admitted upgrades, AFTER this decision. */
  cumulativeSharePercent: number;
  reason?: UpgradeAllocationSkipReason;
}

/**
 * Rank `candidates` by predicted gain per window share (bang-per-buck) and admit them, highest
 * ratio first, while the running spend stays inside `liveWindow.budgetPercent`. Deterministic: a
 * tie in ratio breaks on `taskId` (ascending), so the SAME candidates in ANY input order allocate
 * identically — the queue's own arrival order moves no decision.
 *
 * Returned in ranked (spend) order, not input order, so "where the window went" reads top to
 * bottom exactly as it was spent.
 */
export function allocateUpgrades(
  candidates: readonly UpgradeCandidateTask[],
  liveWindow: LiveUpgradeWindow,
): UpgradeAllocationDecision[] {
  const ratio = (candidate: UpgradeCandidateTask): number =>
    candidate.gain.state === "estimated" ? candidate.gain.value / candidate.windowSharePercent : Number.NEGATIVE_INFINITY;
  const ranked = [...candidates].sort((a, b) => {
    const diff = ratio(b) - ratio(a);
    if (diff !== 0) return diff;
    return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
  });

  let spent = 0;
  const decisions: UpgradeAllocationDecision[] = [];
  for (const candidate of ranked) {
    const skip = (reason: UpgradeAllocationSkipReason): void => {
      decisions.push({
        taskId: candidate.taskId,
        upgraded: false,
        gain: candidate.gain,
        windowSharePercent: candidate.windowSharePercent,
        cumulativeSharePercent: spent,
        reason,
      });
    };
    if (candidate.gain.state !== "estimated") {
      skip("unavailable-gain");
      continue;
    }
    if (candidate.gain.value <= 0) {
      skip("non-positive-gain");
      continue;
    }
    if (spent + candidate.windowSharePercent > liveWindow.budgetPercent) {
      skip("budget-exhausted");
      continue;
    }
    spent += candidate.windowSharePercent;
    decisions.push({
      taskId: candidate.taskId,
      upgraded: true,
      gain: candidate.gain,
      windowSharePercent: candidate.windowSharePercent,
      cumulativeSharePercent: spent,
    });
  }
  return decisions;
}

/** One historical row the offline replay reads: what actually happened under today's fixed-tier
 *  policy, plus the gain an upgrade would have predicted for it at the time. */
export interface UpgradeReplayRow {
  taskId: string;
  windowSharePercent: number;
  merged: boolean;
  gain: UpgradeGain;
}

export interface UpgradeAllocationPolicyOutcome {
  mergedPerWindowSharePercent: number;
  totalWindowSharePercent: number;
}

export interface UpgradeAllocationReplayResult {
  rows: number;
  /** What actually happened: every row keeps its recorded outcome. */
  todaysPolicy: UpgradeAllocationPolicyOutcome & { merged: number };
  /** What this module's allocation would have bought: an admitted row's expected merge
   *  probability is nudged upward by its own predicted gain (capped at 1); every other row keeps
   *  its recorded outcome exactly — the offline stand-in for "run it again with the upgrade" a
   *  replay that reads history once, never re-executing it, can actually compute. */
  candidatePolicy: UpgradeAllocationPolicyOutcome & { expectedMerged: number; decisions: UpgradeAllocationDecision[] };
  /** True when the candidate policy's merged-per-window-share beats today's on this corpus. */
  candidateWins: boolean;
}

/**
 * W1-T4670: the offline replay compares allocation against today's policy on merged per window
 * share — design point (i). Pure: reads only `rows` and `liveWindow`, writes nothing, no clock,
 * no randomness; the identical corpus replays to the identical verdict every time.
 */
export function replayUpgradeAllocationPolicy(
  rows: readonly UpgradeReplayRow[],
  liveWindow: LiveUpgradeWindow,
): UpgradeAllocationReplayResult {
  const totalWindowSharePercent = rows.reduce((sum, row) => sum + row.windowSharePercent, 0);
  const merged = rows.reduce((sum, row) => sum + (row.merged ? 1 : 0), 0);
  const todaysPolicy = {
    merged,
    totalWindowSharePercent,
    mergedPerWindowSharePercent: totalWindowSharePercent > 0 ? merged / totalWindowSharePercent : 0,
  };

  const decisions = allocateUpgrades(
    rows.map((row) => ({ taskId: row.taskId, gain: row.gain, windowSharePercent: row.windowSharePercent })),
    liveWindow,
  );
  const rowByTaskId = new Map(rows.map((row) => [row.taskId, row]));
  let expectedMerged = 0;
  for (const decision of decisions) {
    const row = rowByTaskId.get(decision.taskId)!;
    const recorded = row.merged ? 1 : 0;
    expectedMerged += decision.upgraded && decision.gain.state === "estimated" ? Math.min(1, recorded + decision.gain.value) : recorded;
  }
  const candidatePolicy = {
    expectedMerged,
    totalWindowSharePercent,
    mergedPerWindowSharePercent: totalWindowSharePercent > 0 ? expectedMerged / totalWindowSharePercent : 0,
    decisions,
  };

  return {
    rows: rows.length,
    todaysPolicy,
    candidatePolicy,
    candidateWins: candidatePolicy.mergedPerWindowSharePercent > todaysPolicy.mergedPerWindowSharePercent,
  };
}

function upgradeGainFromField(value: unknown): UpgradeGain | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.state === "estimated" && typeof record.value === "number") return { state: "estimated", value: record.value };
  if (record.state === "unavailable" && typeof record.reason === "string") return { state: "unavailable", reason: record.reason };
  return undefined;
}

/**
 * Read one {@link UpgradeReplayRow} from a generic ledger line (the loose
 * `Record<string, unknown>` shape every ledger consumer in the tree uses — see
 * `ReplayLedgerLine`, ledger-replay.ts), or `undefined` when the row does not carry every field
 * this replay needs. NEVER fabricates: a row missing `task_id`, `window_share_percent` or
 * `upgrade_gain` (today's real rows — see this module's header note) is dropped, not guessed at.
 */
export function extractUpgradeReplayRow(row: Record<string, unknown>): UpgradeReplayRow | undefined {
  const taskId = row.task_id;
  const windowSharePercent = row.window_share_percent;
  const gain = upgradeGainFromField(row.upgrade_gain);
  if (typeof taskId !== "string" || taskId.length === 0) return undefined;
  if (typeof windowSharePercent !== "number" || !(windowSharePercent > 0)) return undefined;
  if (gain === undefined) return undefined;
  return { taskId, windowSharePercent, gain, merged: row.outcome === "merged" };
}

/** Everything {@link resolveUpgradeAllocationReplay} could resolve, or why it refused to. */
export type UpgradeAllocationReplayRead =
  | { ok: true; result: UpgradeAllocationReplayResult }
  | { ok: false; reason: string };

/**
 * Point the pure {@link replayUpgradeAllocationPolicy} at a real ledger corpus, via
 * `resolveReplayLedgerLines` (ledger-replay.ts) — the union reader that already spans whatever
 * history the archive retains, refusing rather than narrating a partial window. Depends on
 * `resolveReplayLedgerLines` rather than importing `ledger-union.ts` directly, so this module and
 * `buildReplay` share exactly ONE definition of "the corpus" and can never drift apart on it.
 *
 * REFUSES, NEVER FABRICATES A VERDICT: a readable union whose rows carry none of
 * `task_id`/`window_share_percent`/`upgrade_gain` yet (today's real shape) resolves zero replay
 * rows — reported as a refusal, not a "candidate wins" or "today wins" comparison with nothing
 * behind it.
 */
export function resolveUpgradeAllocationReplay(
  stateDir: string,
  liveWindow: LiveUpgradeWindow,
  resolveLines: (stateDir: string) => { ok: true; lines: readonly Record<string, unknown>[] } | { ok: false; reason: string },
): UpgradeAllocationReplayRead {
  const read = resolveLines(stateDir);
  if (!read.ok) return { ok: false, reason: read.reason };
  const rows = read.lines
    .map((line) => extractUpgradeReplayRow(line))
    .filter((row): row is UpgradeReplayRow => row !== undefined);
  if (rows.length === 0) {
    return {
      ok: false,
      reason:
        `zero ledger rows under ${stateDir} carry the task_id/window_share_percent/upgrade_gain fields this replay ` +
        "reads — nothing to compare yet",
    };
  }
  return { ok: true, result: replayUpgradeAllocationPolicy(rows, liveWindow) };
}
