/** Descriptive matched-task differences. Repeated cases do not become independent samples. */
import { projectCanaryRuns, type CanaryRun } from "./model-canary-metrics.js";

type Metric = "correct" | "durationMs" | "inputTokens" | "outputTokens" | "usageRatedUsd";
const metrics: Metric[] = ["correct", "durationMs", "inputTokens", "outputTokens", "usageRatedUsd"];
const configuration = (run: CanaryRun) => JSON.stringify([run.model, run.route, run.effort, run.attempts[0]?.billing ?? null]);

function measurement(run: CanaryRun, metric: Metric): number | null {
  // A requested model is not a served identity; mixed or absent identities withhold attribution.
  if (!run.attempts.length || run.attempts.some(a => a.servedModel !== run.model)) return null;
  if (metric === "correct") return run.verified === null ? null : Number(run.verified);
  if (metric === "durationMs") return run.totalDurationMs;
  const values = run.attempts.map(a => a[metric]);
  if (values.some(v => v === null)) return null;
  const sum = values.reduce<number>((n, value) => n + value!, 0);
  return Number.isFinite(sum) && (metric === "usageRatedUsd" || Number.isSafeInteger(sum)) ? sum : null;
}

/** Input uses the canonical bounded validator and exact duplicate semantics. No model call occurs. */
export function analyzeCanaryPairs(input: readonly CanaryRun[]) {
  projectCanaryRuns(input);
  const runs = [...new Map(input.map(r => [r.id, r])).values()];
  const blocks = new Map<string, CanaryRun[]>();
  for (const run of runs) if (run.trial) {
    const rows = blocks.get(run.trial.blockId) ?? [];
    rows.push(run); blocks.set(run.trial.blockId, rows);
  }
  const exclusions: { blockId: string; reason: string; observedSlots: number; plannedSlots: number }[] = [];
  const comparisons = new Map<string, { suiteHash: string; family: string; route: string; effort: string;
    billing: "api" | "subscription"; mode: "A/A" | "models"; left: string; right: string;
    pairs: { blockId: string; day: string; caseId: string; leftRunId: string; rightRunId: string;
      differences: Record<Metric, number | null> }[] }>();
  let completeBlocks = 0;
  for (const [blockId, rows] of blocks) {
    const first = rows[0]!, trial = first.trial!;
    const exclude = (reason: string) => exclusions.push({ blockId, reason, observedSlots: rows.length,
      plannedSlots: trial.plannedSlotIds.length });
    if (rows.length !== trial.plannedSlotIds.length
      || trial.plannedSlotIds.some(id => !rows.some(r => r.trial!.slotId === id))) {
      exclude("incomplete-planned-block"); continue;
    }
    if (rows.some(r => r.family !== first.family)) { exclude("mixed-family-block"); continue; }
    const aa = rows.every(r => r.trial!.aaLabel !== null);
    if (!aa && rows.some(r => r.trial!.aaLabel !== null)) { exclude("mixed-analysis-mode"); continue; }
    if (rows.some(r => !r.attempts.length || r.attempts.some(a => a.billing !== r.attempts[0]!.billing))) {
      exclude("billing-scope-unavailable"); continue;
    }
    const arms = new Map<string, CanaryRun[]>();
    for (const run of rows) {
      const key = configuration(run), group = arms.get(key) ?? [];
      group.push(run); arms.set(key, group);
    }
    if ([...arms.values()].some(group => aa
      ? group.length !== 2 || new Set(group.map(r => r.trial!.aaLabel)).size !== 2
      : group.length !== 1)) { exclude("arm-multiplicity-unproven"); continue; }
    completeBlocks++;
    const add = (left: CanaryRun, right: CanaryRun, mode: "A/A" | "models") => {
      if (left.route !== right.route || left.effort !== right.effort
        || left.attempts[0]!.billing !== right.attempts[0]!.billing) return;
      const key = JSON.stringify([first.suiteHash, first.family, mode, configuration(left), configuration(right)]);
      const group = comparisons.get(key) ?? { suiteHash: first.suiteHash, family: first.family,
        route: left.route, effort: left.effort, billing: left.attempts[0]!.billing, mode,
        left: left.model, right: right.model, pairs: [] };
      const differences = {} as Record<Metric, number | null>;
      for (const metric of metrics) {
        const a = measurement(left, metric), b = measurement(right, metric);
        differences[metric] = a === null || b === null ? null : b - a;
      }
      group.pairs.push({ blockId, day: trial.day, caseId: first.caseId,
        leftRunId: left.id, rightRunId: right.id, differences });
      comparisons.set(key, group);
    };
    const ordered = [...arms.entries()].sort(([a], [b]) => a.localeCompare(b));
    if (aa) for (const [, group] of ordered)
      add(group.find(r => r.trial!.aaLabel === "A")!, group.find(r => r.trial!.aaLabel === "B")!, "A/A");
    else for (let i = 0; i < ordered.length; i++) for (let j = i + 1; j < ordered.length; j++)
      add(ordered[i]![1][0]!, ordered[j]![1][0]!, "models");
  }
  return { version: "canary-paired-descriptive-v1" as const, private: true as const,
    uniqueRuns: runs.length, unpairedRuns: runs.filter(r => !r.trial).length,
    observedBlocks: blocks.size, completeBlocks, exclusions,
    differenceDirection: "right-minus-left" as const, inference: "descriptive-only" as const,
    comparisons: [...comparisons.values()].map(group => ({ ...group,
      distinctCases: new Set(group.pairs.map(p => p.caseId)).size,
      observedDays: new Set(group.pairs.map(p => p.day)).size,
      metrics: Object.fromEntries(metrics.map(metric => {
        const byCase = new Map<string, number[]>();
        for (const pair of group.pairs) if (pair.differences[metric] !== null) {
          const values = byCase.get(pair.caseId) ?? [];
          values.push(pair.differences[metric]!); byCase.set(pair.caseId, values);
        }
        const caseMeans = [...byCase.values()].map(v => v.reduce((a, b) => a + b, 0) / v.length);
        return [metric, { plannedPairs: group.pairs.length,
          observedPairs: [...byCase.values()].reduce((n, v) => n + v.length, 0), observedCases: byCase.size,
          caseBalancedMeanDifference: caseMeans.length ? caseMeans.reduce((a, b) => a + b, 0) / caseMeans.length : null,
          uncertainty: null, inference: "descriptive-only" }];
      })),
    })),
  };
}
