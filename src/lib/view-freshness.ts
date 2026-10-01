/**
 * One freshness model for every view source (arch Phase 4, design D3 and §3, P4-T02).
 *
 * A source's `state` was frozen into its body when the worker built it, except for `ledger:`, which
 * serve re-judged per request. So a body built once and never rebuilt said `fresh` forever, and now's
 * `plan:` and `host-probe:` were hard-coded `fresh`. The console then parsed `reason` prose with a
 * regex, and read core's normal post-boot catch-up ("catching up: ... done in about S s") as stale.
 *
 * Now each source carries structured fields beside the prose: `kind`, `phase` (why it is not fresh),
 * `lagMs`, `etaMs` and `budgetMs`, the bound it is judged against. Serve judges EVERY source at request
 * time against the one table below, so a frozen body goes stale on schedule and says which source and
 * why. The fields are optional, so a v1 reader keeps working and no view's version moves.
 */
import type { SourceKind, SourcePhase, ViewSource } from "./views.js";

export type { SourceKind, SourcePhase };

/** The ledger projector's bound: a projector whose last good tick is older than this is behind. */
export const LEDGER_BUDGET_MS = 10_000;
/** GitHub's open snapshot is re-saved at least every minute while its gateway runs; three misses. */
export const GITHUB_BUDGET_MS = 180_000;
/** A checkout behind origin/main by a plan-touching commit for longer than this serves an old plan. */
export const PLAN_BUDGET_MS = 120_000;
/** Three missed host probes at the 60 s cadence. */
export const HOST_PROBE_BUDGET_MS = 180_000;
/** Three missed slow-lane passes at its 60 s cadence (inbox-view.ts's INBOX_CLASSIFY_INTERVAL_MS). */
export const SLOW_LANE_STORE_BUDGET_MS = 180_000;

/**
 * THE budget table: a source of this kind whose input is older than its budget is stale. A kind with
 * no row here is judged only by the state its producer gave it.
 */
export const SOURCE_BUDGET_MS: Partial<Record<SourceKind, number>> = {
  ledger: LEDGER_BUDGET_MS,
  github: GITHUB_BUDGET_MS,
  plan: PLAN_BUDGET_MS,
  "host-probe": HOST_PROBE_BUDGET_MS,
  "inbox-store": SLOW_LANE_STORE_BUDGET_MS,
  "feedback-store": SLOW_LANE_STORE_BUDGET_MS,
};

/** A source name's kind, from its `<kind>:<instance>` prefix, when that prefix is a known kind. */
export function sourceKindOf(name: string): SourceKind | undefined {
  const prefix = name.split(":")[0] as SourceKind;
  return KINDS.has(prefix) ? prefix : undefined;
}

const KINDS: ReadonlySet<string> = new Set<SourceKind>([
  "ledger", "read-model", "github", "plan", "host-probe", "analytics", "inbox-store", "feedback-store",
  "question-store", "incidents-store", "git", "account", "registry", "repositories",
]);

/** The structured fields every source gets from its name: its kind, instance and budget. */
export function describeSource(source: ViewSource): ViewSource {
  const kind = source.kind ?? sourceKindOf(source.name);
  if (kind === undefined) return source;
  const instance = source.instance ?? (source.name.includes(":") ? source.name.slice(source.name.indexOf(":") + 1) : undefined);
  const budgetMs = source.budgetMs ?? SOURCE_BUDGET_MS[kind];
  return { ...source, kind, ...(instance ? { instance } : {}), ...(budgetMs !== undefined ? { budgetMs } : {}) };
}

/**
 * Judges one source at `nowMs`: its lag is the age of its `asOf`, and a source its producer called
 * fresh whose lag exceeds its budget is stale, phase `behind`. A source already stale keeps its own
 * phase and reason. A source with no `asOf` or no budget is passed through, described.
 */
export function judgeSource(source: ViewSource, nowMs: number): ViewSource {
  const described = describeSource(source);
  const asOfMs = described.asOf === null ? Number.NaN : Date.parse(described.asOf);
  if (!Number.isFinite(asOfMs)) return described;
  const lagMs = Math.max(0, nowMs - asOfMs);
  const budgetMs = described.budgetMs;
  if (described.state !== "fresh" || budgetMs === undefined || lagMs <= budgetMs) return { ...described, lagMs };
  return {
    ...described,
    state: "stale",
    phase: described.phase ?? "behind",
    lagMs,
    reason: described.reason ?? `${described.kind ?? described.name} ${Math.round(lagMs / 1000)} s old (budget ${Math.round(budgetMs / 1000)} s)`,
  };
}
