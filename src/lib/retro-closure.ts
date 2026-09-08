/**
 * Closure by task class and guard fire counts: the two tables a fleet operator acts on
 * (W1-T3074, MASTER-PLAN §Self-improvement's harness-compression duty).
 *
 * The gather already carries every input: `RunSummary.taskClass`, the SHIPPED union, the open
 * task set and the guard population the MAST mapping's `infrastructure` rows plus retro.ts's
 * fallback table name. This module reduces them to one row per class and one row per guard.
 *
 * INVARIANT: nothing here decides. A refused merge rate and a guard at zero are NAMED, never
 * acted on; retiring a class or a guard is an operator ruling taken behind the golden suite.
 *
 * INVARIANT: every input type is structural and nothing is imported from retro.ts, so retro.ts
 * imports this file without a cycle (scripts/cycle-baseline.json refuses a new one).
 *
 * FALSIFIER: test/the-retro-emits-closure-by-class-and-guard-fire-counts.test.ts. Forensics and
 * the measured filing-versus-closure figures: docs/forensics/retro.md (W1-T3074).
 */

/** The class a run or credit with no `taskClass` groups under, matching `aggregateByClass`. */
const UNKNOWN_CLASS = "unknown";

/** The guard a mapping row names: its verdict with the `blocked_` prefix stripped, so
 *  `blocked_isolation` names `isolation` exactly as the fallback table does. */
export function guardNameOfVerdict(verdict: string): string {
  return verdict.startsWith("blocked_") ? verdict.slice("blocked_".length) : verdict;
}

/** The run fields both reducers read. `RunSummary` (retro.ts) satisfies it structurally. */
export interface ClosureRun {
  runId: string;
  taskId: string;
  startTs: string;
  verdict: string;
  costUsd: number;
  taskClass?: string;
  subtype?: string;
  reason?: string;
  guard?: string;
  check?: string;
}

/** The merged-credit fields the class join reads. `ShippedRecord` satisfies it structurally. */
export interface ClosureShipped {
  runId: string;
  taskId: string;
}

/** One filing, supplied only by a caller that has filing dates; without them `filed` reads
 *  "not supplied" rather than a zero that looks measured. */
export interface ClassFiling {
  taskClass: string;
  filedTs: string;
}

/** A merge rate is stated only over a population at or above the floor; below it the row says
 *  REFUSED and still names the denominator it would have divided by (P48). */
export type MergeRate =
  | { kind: "rate"; value: number; merged: number; denominator: number }
  | { kind: "refused"; merged: number; denominator: number; floor: number };

/** One row of the closure table. `lastMergeTs` is the `startTs` of the newest run credited as
 *  merged, because a credit record carries no timestamp of its own. */
export interface ClassClosure {
  taskClass: string;
  filed: number | "not supplied";
  merged: number;
  open: number;
  mergeRate: MergeRate;
  costPerMerge: number | null;
  lastMergeTs?: string;
}

/** PRIMARY CONTROL: the smallest population a merge rate is stated over (P48). */
export const CLOSURE_POPULATION_FLOOR = 5;

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function inWindow<T extends { startTs: string }>(runs: readonly T[], sinceTs: string | undefined): T[] {
  return sinceTs ? runs.filter((r) => r.startTs > sinceTs) : [...runs];
}

/**
 * One row per task class seen in the window, credited as merged, listed open, or filed.
 *
 * `merged` counts `shipped` credits joined to a class by run id, so a class is never credited
 * from the ledger verdict alone. The denominator is `filed` when filings are supplied, else
 * `merged + open`; a rate over a denominator below {@link CLOSURE_POPULATION_FLOOR} is refused.
 * `costPerMerge` divides every in-window run's cost, refused runs included, by `merged`, so
 * refusing more can never lower it; it is `null` at zero merges rather than a false 0.
 */
export function closureByClass(
  runs: readonly ClosureRun[],
  shipped: readonly ClosureShipped[],
  openTaskClasses: readonly string[],
  sinceTs: string | undefined,
  filings?: readonly ClassFiling[],
): ClassClosure[] {
  const windowed = inWindow(runs, sinceTs);
  const classOfRun = new Map<string, string>();
  const startOfRun = new Map<string, string>();
  for (const r of runs) {
    classOfRun.set(r.runId, r.taskClass ?? UNKNOWN_CLASS);
    startOfRun.set(r.runId, r.startTs);
  }
  const classes = new Set<string>();
  const mergedRunIds = new Map<string, string[]>();
  for (const s of shipped) {
    const c = classOfRun.get(s.runId) ?? UNKNOWN_CLASS;
    classes.add(c);
    mergedRunIds.set(c, [...(mergedRunIds.get(c) ?? []), s.runId]);
  }
  const costByClass = new Map<string, number>();
  for (const r of windowed) {
    const c = r.taskClass ?? UNKNOWN_CLASS;
    classes.add(c);
    costByClass.set(c, (costByClass.get(c) ?? 0) + r.costUsd);
  }
  const openByClass = new Map<string, number>();
  for (const c of openTaskClasses) {
    classes.add(c);
    openByClass.set(c, (openByClass.get(c) ?? 0) + 1);
  }
  const filedByClass = filings ? new Map<string, number>() : undefined;
  if (filings && filedByClass) {
    for (const f of filings) {
      if (sinceTs && !(f.filedTs > sinceTs)) continue;
      classes.add(f.taskClass);
      filedByClass.set(f.taskClass, (filedByClass.get(f.taskClass) ?? 0) + 1);
    }
  }
  const out: ClassClosure[] = [];
  for (const taskClass of [...classes].sort()) {
    const mergedIds = mergedRunIds.get(taskClass) ?? [];
    const merged = mergedIds.length;
    const open = openByClass.get(taskClass) ?? 0;
    const filed: number | "not supplied" = filedByClass ? (filedByClass.get(taskClass) ?? 0) : "not supplied";
    const denominator = typeof filed === "number" ? filed : merged + open;
    const mergeRate: MergeRate =
      denominator < CLOSURE_POPULATION_FLOOR
        ? { kind: "refused", merged, denominator, floor: CLOSURE_POPULATION_FLOOR }
        : { kind: "rate", value: round(merged / denominator), merged, denominator };
    const cost = costByClass.get(taskClass) ?? 0;
    const lastMergeTs = mergedIds
      .map((id) => startOfRun.get(id))
      .filter((ts): ts is string => typeof ts === "string")
      .sort()
      .at(-1);
    out.push({
      taskClass,
      filed,
      merged,
      open,
      mergeRate,
      costPerMerge: merged === 0 ? null : round(cost / merged),
      ...(lastMergeTs !== undefined ? { lastMergeTs } : {}),
    });
  }
  return out;
}

/** The merge-rate cell as prose: the rate with its denominator, or the refusal with the floor. */
export function mergeRateCell(rate: MergeRate): string {
  return rate.kind === "rate"
    ? `${rate.value} (${rate.merged} of ${rate.denominator})`
    : `REFUSED (population ${rate.denominator} below floor ${rate.floor}, P48)`;
}

/** The `## Closure by task class` section, a markdown table with one row per class. */
export function renderClosureByClass(rows: readonly ClassClosure[]): string {
  const head = ["## Closure by task class", ""];
  if (rows.length === 0) return [...head, "No task class observed, credited, listed open or filed in this window."].join("\n");
  return [
    ...head,
    "| class | filed | merged | open | merge rate | cost per merge | last merge |",
    "|---|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.taskClass} | ${r.filed} | ${r.merged} | ${r.open} | ${mergeRateCell(r.mergeRate)} | ` +
        `${r.costPerMerge === null ? "n/a (0 merged)" : `$${r.costPerMerge.toFixed(3)}`} | ${r.lastMergeTs ?? "(none)"} |`,
    ),
  ].join("\n");
}

/** The mapping row fields the guard population reads. `MastMappingRow` satisfies it. */
export interface GuardMappingRow {
  verdict: string;
  subtype?: string;
  category: string;
}

/** The mapping shape the guard population reads. `MastMapping` satisfies it structurally. */
export interface GuardMapping {
  rows: readonly GuardMappingRow[];
}

/** One prose-fallback row, retro.ts's `GuardReasonFallbackRow` shape. */
export interface GuardFallbackRow {
  verdict: string;
  pattern: RegExp;
  guard: string;
  check: string;
}

/** One row of the guard table. `zeroStreak` counts THIS cycle: a guard at zero here with a prior
 *  streak of N reads N+1, and a guard that fired reads 0. */
export interface GuardFireCount {
  guard: string;
  count: number;
  checks: string[];
  taskIds: string[];
  zeroStreak: number;
  retirementCandidate: boolean;
}

/** The fallback table, the prior marker's streaks, and an override of the retirement streak. */
export interface GuardFireOpts {
  fallbackRows?: readonly GuardFallbackRow[];
  priorZeroStreak?: Record<string, number>;
  retirementStreak?: number;
}

/** PRIMARY CONTROL: consecutive markers at zero before a guard is NAMED a retirement candidate
 *  (the rationale's own "ten cycles"). Naming is all this does; removal goes behind the goldens. */
export const GUARD_RETIREMENT_ZERO_STREAK = 10;

function mappingRowFor(mapping: GuardMapping, run: Pick<ClosureRun, "verdict" | "subtype">): GuardMappingRow | undefined {
  if (run.subtype) {
    const exact = mapping.rows.find((r) => r.verdict === run.verdict && r.subtype === run.subtype);
    if (exact) return exact;
  }
  return mapping.rows.find((r) => r.verdict === run.verdict && r.subtype === undefined);
}

/**
 * The guard one run fired, or undefined when it fired none. Structured `guard` first, then the
 * prose fallback, then an `infrastructure`-coded verdict named by {@link guardNameOfVerdict}.
 * The first two arms are `resolveGuardCheck`'s own order; the third is what lets a guard row
 * count a fire the older line shapes never named.
 */
export function guardFiredBy(
  run: Pick<ClosureRun, "verdict" | "subtype" | "reason" | "guard" | "check">,
  mapping: GuardMapping,
  fallbackRows: readonly GuardFallbackRow[],
): { guard: string; check: string } | undefined {
  if (run.guard) return { guard: run.guard, check: run.check ?? "unknown" };
  const row = fallbackRows.find((f) => f.verdict === run.verdict && run.reason && f.pattern.test(run.reason));
  if (row) return { guard: row.guard, check: row.check };
  if (mappingRowFor(mapping, run)?.category === "infrastructure") {
    return { guard: guardNameOfVerdict(run.verdict), check: "unknown" };
  }
  return undefined;
}

/** Every guard the mapping's `infrastructure` rows and the fallback table name, sorted. */
export function guardPopulation(mapping: GuardMapping, fallbackRows: readonly GuardFallbackRow[]): string[] {
  const names = new Set<string>();
  for (const f of fallbackRows) names.add(f.guard);
  for (const r of mapping.rows) {
    if (r.category !== "infrastructure") continue;
    const named = fallbackRows.find((f) => f.verdict === r.verdict);
    names.add(named ? named.guard : guardNameOfVerdict(r.verdict));
  }
  return [...names].sort();
}

/**
 * One row per guard in {@link guardPopulation}, ZERO ROWS INCLUDED, plus a row for any guard a
 * run named that the population did not, so nothing observed is dropped.
 *
 * TRAP: seeding rows from the fires alone omits every guard that did not fire, which is the
 * invisible-dead-guard defect this table exists to close. The falsifier removes the population
 * seed and expects one row from a mapping that names three.
 */
export function guardFireCounts(
  runs: readonly ClosureRun[],
  mapping: GuardMapping,
  sinceTs: string | undefined,
  opts: GuardFireOpts = {},
): GuardFireCount[] {
  const fallbackRows = opts.fallbackRows ?? [];
  const retirementStreak = opts.retirementStreak ?? GUARD_RETIREMENT_ZERO_STREAK;
  const fired = new Map<string, { checks: Set<string>; taskIds: Set<string>; count: number }>();
  for (const r of inWindow(runs, sinceTs)) {
    const gc = guardFiredBy(r, mapping, fallbackRows);
    if (!gc) continue;
    const entry = fired.get(gc.guard) ?? { checks: new Set<string>(), taskIds: new Set<string>(), count: 0 };
    entry.count += 1;
    entry.checks.add(gc.check);
    entry.taskIds.add(r.taskId);
    fired.set(gc.guard, entry);
  }
  const guards = [...new Set([...guardPopulation(mapping, fallbackRows), ...fired.keys()])].sort();
  return guards.map((guard) => {
    const entry = fired.get(guard);
    const count = entry?.count ?? 0;
    const zeroStreak = count === 0 ? (opts.priorZeroStreak?.[guard] ?? 0) + 1 : 0;
    return {
      guard,
      count,
      checks: entry ? [...entry.checks].sort() : [],
      taskIds: entry ? [...entry.taskIds].sort() : [],
      zeroStreak,
      retirementCandidate: zeroStreak >= retirementStreak,
    };
  });
}

/** The `guard_zero_streak` record the next marker carries, one entry per guard row. */
export function guardZeroStreakRecord(rows: readonly GuardFireCount[]): Record<string, number> {
  return Object.fromEntries(rows.map((r) => [r.guard, r.zeroStreak]));
}

/** The `## Guard fire counts since marker` section; a candidate row says what to verify first. */
export function renderGuardFireCounts(rows: readonly GuardFireCount[]): string {
  const head = [
    "## Guard fire counts since marker",
    "",
    "Every guard the MAST mapping's infrastructure rows and the prose fallback table name. A zero row is a guard that did not fire, never one left out.",
    "",
  ];
  if (rows.length === 0) return [...head, "No guard is named by the mapping or the fallback table."].join("\n");
  return [
    ...head,
    "| guard | fires | checks | tasks | markers at zero | note |",
    "|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.guard} | ${r.count} | ${r.checks.length ? r.checks.join(", ") : "(none)"} | ` +
        `${r.taskIds.length ? r.taskIds.join(", ") : "(none)"} | ${r.zeroStreak} | ` +
        `${r.retirementCandidate ? `candidate for retirement (zero for ${r.zeroStreak} markers): verify against the golden suite before removing` : ""} |`,
    ),
  ].join("\n");
}
