import type { OperatorAgentTaskOutcomeSignal } from "./operator-agent-outcomes.js";

export type AnalyticsBreakdownSourceState = "observed" | "empty" | "unreadable" | "unauthorized" | "not-collected";

export type AnalyticsBreakdownDimensionKey = "outcome" | "work-category";

export interface AnalyticsBreakdownBucket {
  key: string;
  label: string;
  count: number;
  denominator: number;
}

export interface AnalyticsBreakdownDimension {
  key: AnalyticsBreakdownDimensionKey;
  label: string;
  state: AnalyticsBreakdownSourceState;
  denominator: number;
  buckets: AnalyticsBreakdownBucket[];
}

export interface AnalyticsDrilldownRow extends AnalyticsBreakdownBucket {
  dimension: AnalyticsBreakdownDimensionKey;
}

export interface AnalyticsBreakdowns {
  dimensions: AnalyticsBreakdownDimension[];
  drilldowns: AnalyticsDrilldownRow[];
}

export interface AnalyticsBreakdownOptions {
  sourceState?: AnalyticsBreakdownSourceState;
  operatorAgentOutcomes?: OperatorAgentTaskOutcomeSignal;
}

const MAX_WORK_CATEGORY_BUCKETS = 20;
const MAX_DRILLDOWN_ROWS = 40;
const SUCCESS_VERDICTS = new Set(["merged", "already_satisfied"]);
const WORK_CATEGORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

type StartedRun = Record<string, never>;
type TerminalRun = { verdict?: string; success?: boolean };

export interface AnalyticsBreakdownAccumulator {
  add(line: Record<string, unknown>): void;
  build(options?: AnalyticsBreakdownOptions): AnalyticsBreakdowns;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function workCategory(value: unknown): string {
  const candidate = text(value);
  return candidate && WORK_CATEGORY_PATTERN.test(candidate) ? candidate : "unknown";
}

function emptyBreakdowns(state: AnalyticsBreakdownSourceState): AnalyticsBreakdowns {
  return {
    dimensions: [
      { key: "outcome", label: "Outcome", state, denominator: 0, buckets: [] },
      { key: "work-category", label: "Work category", state, denominator: 0, buckets: [] },
    ],
    drilldowns: [],
  };
}

function addCount(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function bucketRows(counts: Map<string, number>, denominator: number, order?: readonly string[]): AnalyticsBreakdownBucket[] {
  const keys = order ? [...order, ...[...counts.keys()].filter((key) => !order.includes(key))] : [...counts.keys()];
  return keys
    .filter((key) => (counts.get(key) ?? 0) > 0)
    .map((key) => ({ key, label: key, count: counts.get(key)!, denominator }));
}

function buildFromAccumulator(
  state: AnalyticsBreakdownSourceState,
  starts: Map<string, StartedRun>,
  terminals: Map<string, TerminalRun>,
  startsWithoutRunId: number,
  terminalsWithoutRunId: number,
  workCategories: Map<string, number>,
  operatorAgentOutcomes: OperatorAgentTaskOutcomeSignal | undefined,
): AnalyticsBreakdowns {
  if (state !== "observed") return emptyBreakdowns(state);

  const outcomeCounts = new Map<string, number>();
  for (const runId of starts.keys()) {
    const terminal = terminals.get(runId);
    if (!terminal) {
      addCount(outcomeCounts, "missing-terminal-receipt");
      continue;
    }
    const isSuccessfulTerminal = SUCCESS_VERDICTS.has(terminal.verdict ?? "") && terminal.success !== false;
    if (isSuccessfulTerminal) addCount(outcomeCounts, "success");
    else if (!terminal.verdict) addCount(outcomeCounts, "unknown");
    else addCount(outcomeCounts, "failure");
  }
  for (let index = 0; index < startsWithoutRunId; index += 1) addCount(outcomeCounts, "missing-terminal-receipt");
  for (let index = 0; index < terminalsWithoutRunId; index += 1) addCount(outcomeCounts, "unknown");
  for (const [runId, terminal] of terminals) {
    if (starts.has(runId)) continue;
    if (terminal.verdict) addCount(outcomeCounts, SUCCESS_VERDICTS.has(terminal.verdict) && terminal.success !== false ? "success" : "failure");
    else addCount(outcomeCounts, "unknown");
  }

  const outcomeDenominator = [...outcomeCounts.values()].reduce((sum, count) => sum + count, 0);
  const attributedDenominator = operatorAgentOutcomes?.status === "measured" ? operatorAgentOutcomes.armsClassified : 0;
  const attributedRows = operatorAgentOutcomes?.status === "measured"
    ? [
        { key: "reverted", label: "reverted", count: operatorAgentOutcomes.classes.reduce((sum, item) => sum + item.revertedCount, 0), denominator: attributedDenominator },
        { key: "follow-up-fix", label: "follow-up-fix", count: operatorAgentOutcomes.classes.reduce((sum, item) => sum + item.followupFixedCount, 0), denominator: attributedDenominator },
      ].filter((row) => row.count > 0)
    : [];
  const workDenominator = [...workCategories.values()].reduce((sum, count) => sum + count, 0);
  const outcome = {
    key: "outcome" as const,
    label: "Outcome",
    state: outcomeDenominator > 0 ? ("observed" as const) : ("empty" as const),
    denominator: outcomeDenominator,
    buckets: [...bucketRows(outcomeCounts, outcomeDenominator, ["success", "failure", "missing-terminal-receipt", "unknown"]), ...attributedRows],
  };
  const categories = [...workCategories.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const boundedCategories = categories.slice(0, MAX_WORK_CATEGORY_BUCKETS);
  const overflow = categories.slice(MAX_WORK_CATEGORY_BUCKETS).reduce((sum, [, count]) => sum + count, 0);
  if (overflow > 0) boundedCategories.push(["other", overflow]);
  const categoryCounts = new Map(boundedCategories);
  const workCategoryDimension = {
    key: "work-category" as const,
    label: "Work category",
    state: workDenominator > 0 ? ("observed" as const) : ("empty" as const),
    denominator: workDenominator,
    buckets: bucketRows(categoryCounts, workDenominator),
  };
  const dimensions = [outcome, workCategoryDimension];
  const drilldowns = dimensions.flatMap((dimension) =>
    dimension.buckets.slice(0, MAX_DRILLDOWN_ROWS).map((bucket) => ({ ...bucket, dimension: dimension.key })),
  );
  return { dimensions, drilldowns };
}

export function createAnalyticsBreakdownAccumulator(): AnalyticsBreakdownAccumulator {
  const starts = new Map<string, StartedRun>();
  const terminals = new Map<string, TerminalRun>();
  const workCategories = new Map<string, number>();
  let startsWithoutRunId = 0;
  let terminalsWithoutRunId = 0;
  return {
    add(line) {
      if (line.step === "run.start") {
        addCount(workCategories, workCategory(line.type));
        const runId = text(line.run_id);
        if (!runId) {
          startsWithoutRunId += 1;
          return;
        }
        if (!starts.has(runId)) {
          starts.set(runId, {});
        }
        return;
      }
      if (line.step !== "verdict") return;
      const runId = text(line.run_id);
      const terminal: TerminalRun = {
        verdict: text(line.verdict),
        ...(typeof line.success === "boolean" ? { success: line.success } : {}),
      };
      if (!runId) {
        terminalsWithoutRunId += 1;
        return;
      }
      terminals.set(runId, terminal);
    },
    build(options = {}) {
      const state = options.sourceState ?? "observed";
      return buildFromAccumulator(state, starts, terminals, startsWithoutRunId, terminalsWithoutRunId, workCategories, options.operatorAgentOutcomes);
    },
  };
}

export function buildAnalyticsBreakdowns(
  lines: Iterable<Record<string, unknown>> | AnalyticsBreakdownAccumulator,
  options: AnalyticsBreakdownOptions = {},
): AnalyticsBreakdowns {
  if ("add" in lines && "build" in lines) return lines.build(options);
  const accumulator = createAnalyticsBreakdownAccumulator();
  for (const line of lines) accumulator.add(line);
  return accumulator.build(options);
}
