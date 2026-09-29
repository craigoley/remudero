/**
 * lib/upgrade-allocation.ts — spend the live window's model-upgrade budget where predicted gain
 * per window share is largest (W1-T4670), borrowing NVIDIA Model-Optimizer's AutoQuantize: score
 * each candidate's sensitivity to the expensive option (here: the merge-probability an
 * Opus/high-effort upgrade buys) and solve a constrained assignment under a budget, instead of the
 * two mechanisms that already exist and answer a DIFFERENT question:
 *   - `.remudero/mounts.yaml` fixes tier BY ROLE (workers capped at sonnet; opus/frontier reserved
 *     for the Architect or a last-attempt escalation) — a static rule, never a per-task estimate.
 *   - `selectWorkerProvider` (worker-provider.ts) auctions WHICH SUBSCRIPTION serves a spawn,
 *     weighted by squared remaining headroom — it never asks whether THIS spawn is worth the
 *     expensive tier at all.
 * This module answers "of the tasks queued right now, which ones' upgrade is worth the window
 * share it costs" — a ranking and a cutoff, not a subscription pick.
 *
 * GAIN COMES FROM THE ABILITY MAP (W1-T4626, ability-map.ts). That module already separates a
 * model's ability from a task's difficulty: P(success) = sigmoid(theta_model + theta_role -
 * beta_task). `estimateUpgradeGain` takes two ability readings at the same task/role — the tier a
 * task would run at today and the tier an upgrade would grant — and returns the probability delta
 * upgrading buys. `AbilityCell` values (ability-map.ts) satisfy `UpgradeAbilityReading`
 * structurally, so a caller can pass them straight through; this module deliberately does not
 * import ability-map.ts, so a fit failure there can never make an upgrade decision throw here.
 * Either reading being `insufficient` (thin evidence — ability-map.ts's own discipline) makes the
 * gain "unavailable", never a fabricated number: this module never guesses a gain it cannot
 * compute, and an unavailable gain can never outrank — or be outranked by — a computed one.
 *
 * ALLOCATION IS A GREEDY KNAPSACK ON GAIN PER UNIT COST (bang-per-buck) — the same shape
 * AutoQuantize's per-layer sensitivity-under-a-budget solve takes
 * (https://github.com/NVIDIA/Model-Optimizer/blob/main/docs/source/announcements/autoquantize.rst):
 * rank candidates by gain/windowSharePercent descending, admit while the running total of
 * windowSharePercent stays inside the live window's soft budget (a number that moves with
 * headroom — see {@link LiveUpgradeWindow} — never a fixed cap). A non-positive or unavailable
 * gain is never admitted, however cheap: spending window share on a task with no shown benefit is
 * exactly the waste this module exists to avoid.
 *
 * THE OFFLINE REPLAY (design point i) is `replayUpgradeAllocationPolicy`: pure, over a corpus of
 * ledger-shaped rows, comparing this allocation against TODAY's policy (every row keeps its own
 * recorded outcome) on the SAME metric — merged per window-share percent — so the two numbers are
 * comparable on their face. `resolveUpgradeAllocationReplay` points that pure core at a real
 * ledger corpus through `resolveReplayLedgerLines` (ledger-replay.ts), which already reads the
 * archive∪live union spanning however much history is retained — reused rather than re-built,
 * because a SECOND ledger-corpus reader would drift from the first one's refuse-on-partial-
 * coverage discipline. Today's ledger rows carry no `upgrade_gain`/`window_share_percent` fields
 * yet (W1-T4617/W1-T4618/W1-T4626 log propensity, task shape and ability separately, not this
 * module's joined view) — `extractUpgradeReplayRow` reads them ONLY where present and this resolve
 * wrapper refuses honestly with zero rows rather than fabricating a verdict from an empty corpus;
 * wiring a writer for those joined fields is this module's own declared follow-up.
 *
 * Design point (ii), spending the live window, is gated on the offline replay WINNING — spending
 * budget on an unproven policy is exactly the mistake "prove it first" exists to prevent. That is
 * why `worker-provider.ts`'s own call site (`queuedUpgradeAllocation`) is additive: it exposes
 * this module's decision to a future caller without wiring it into today's spawn path, which stays
 * governed by `.remudero/mounts.yaml` and `selectWorkerProvider` until an operator, holding a
 * replay verdict in hand, decides otherwise.
 *
 * Design point (iii), checking this cheap proxy against W1-T4625 paired trials on a subset, is
 * also out of this module's scope — it validates the PROXY (repair rounds, reviewer defects)
 * against a ground truth this module never touches.
 */

/** One ability-map cell, read structurally — `AbilityCell` (ability-map.ts) satisfies this without
 *  an import. `insufficient` carries no number: thin evidence is blank, never zero. */
export type UpgradeAbilityReading = { state: "estimated"; estimate: number } | { state: "insufficient" };

/** A computed gain, or a named reason it could not be computed — never a fabricated number. */
export type UpgradeGain = { state: "estimated"; value: number } | { state: "unavailable"; reason: string };

function sigmoid(x: number): number {
  return x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));
}

/**
 * The probability-of-merge delta an upgrade buys for one task, from the ability map's own
 * P(success) = sigmoid(theta_model + theta_role - beta_task): the same role and task difficulty
 * cancel out of the subtraction, leaving only the ability gap between the two tiers.
 */
export function estimateUpgradeGain(input: {
  baseline: UpgradeAbilityReading;
  upgraded: UpgradeAbilityReading;
  taskDifficulty: UpgradeAbilityReading;
}): UpgradeGain {
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
