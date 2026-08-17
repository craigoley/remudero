import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { appendLedger, type LedgerLine } from "./ledger.js";
import { installPolicyPath } from "./policy.js";
import { gatherRuns, type LedgerRecord, type RunSummary } from "./retro.js";

/**
 * W1-T931 COST-ANOMALY SENTINEL (fb-1785237559155-feef92, item 4) — see `plan/policy.yaml`'s
 * `costAnomaly` block for the full rationale. Both existing cost guards are ABSOLUTE:
 * `sweep.dailyCostCeilingUsd` gates the fleet's DAY, `budget_usd` gates a SINGLE run at $100 with
 * ten cycles of "0/31 trips" behind it — neither measures a run against its own kind, so an
 * expensive-but-under-both-ceilings run (the W1-T7 arc: $9.32 across strikes to a blocked
 * verdict, this task's own named fixture) is only ever visible by reading the ledger by hand.
 *
 * THIS MODULE REPORTS; IT NEVER ACTS (design note v) — every export here either computes a pure
 * finding or appends ONE `cost.anomaly` ledger row. Nothing here defers dispatch, stops a
 * worker, or blocks a merge; the runaway guards (`budget_usd`, the per-run turn limit) are
 * untouched.
 *
 * MEDIAN, NOT MEAN (design note iii): the mean is dragged by the very outlier being detected —
 * `plan/policy.yaml`'s own `autoTriage.maxPerDay` comment records this repo quoting a single
 * worst run as typical, overstating a real median by 2.04x. Every comparison below is against
 * the class's MEDIAN cost, computed by {@link median}.
 *
 * A THIN CLASS IS SILENT, NOT ANOMALOUS (design note ii): below `policy.minSamples` settled runs,
 * a class's own median is noise (n=1 or n=2 is not a median at all) and {@link
 * detectCostAnomalies} emits nothing for it — never a false alarm on an under-sampled class.
 *
 * THE THRESHOLD IS POLICY DATA (design note i): {@link loadCostAnomalyPolicy} reads
 * `plan/policy.yaml`'s `costAnomaly.multiplier`/`costAnomaly.minSamples` rows and enforces their
 * own committed `min`/`max` bounds — no source literal gates either figure. Both rows carry
 * `origin: "net-new"` (no prior src/ constant of either shape ever existed to lift), so this
 * module validates that origin spelling itself rather than sharing `src/lib/policy.ts`'s
 * `EXPECTED_ORIGIN_KIND` table — this task's declared files are `src/lib/cost-anomaly.ts`,
 * `src/lib/sweep.ts`, `src/lib/status-board.ts`, `plan/policy.yaml`, `test/cost-anomaly.test.ts`
 * (plan/tasks.d/W1-T931-cost-anomaly-sentinel.yaml), and `src/lib/policy.ts`'s shared schema is
 * deliberately not one of them — this row's own loader owns its own bound/origin enforcement
 * instead of widening that shared table.
 */

export const COST_ANOMALY_STEP = "cost.anomaly";

export class CostAnomalyPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CostAnomalyPolicyError";
  }
}

/** The two policy-data thresholds this sentinel reads from `plan/policy.yaml`'s `costAnomaly`
 *  block — see this module's header for why neither is a source literal. */
export interface CostAnomalyPolicy {
  /** A run costing more than this many times its class's median is an outlier. */
  multiplier: number;
  /** Below this many settled runs in a class, that class's median is not trusted at all
   *  (design note ii) — {@link detectCostAnomalies} emits nothing for it. */
  minSamples: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Read+validate one bounded numeric `{value, origin, min, max}` row — same discipline as
 *  `src/lib/policy.ts`'s `numberField` (finite bounds, `min <= max`, `value` inside them), plus
 *  this module's own `origin` check (see the header: `costAnomaly`'s two rows are net-new, never
 *  lifted, so `origin` must read exactly `"net-new"`). */
function numberRow(path: string, raw: unknown): number {
  if (!isPlainObject(raw)) {
    throw new CostAnomalyPolicyError(`policy.yaml: '${path}' must be a mapping with 'value'/'origin'/'min'/'max'.`);
  }
  const { value, origin, min, max } = raw as Record<string, unknown>;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CostAnomalyPolicyError(`policy.yaml: '${path}.value' must be a finite number, got ${JSON.stringify(value)}.`);
  }
  // Finite, not merely `typeof === "number"` — a `.nan`/`.inf` YAML bound would silently accept
  // any value (every comparison against NaN is false), the same regression src/lib/policy.ts's
  // own `numberField` guards against.
  if (typeof min !== "number" || typeof max !== "number" || !Number.isFinite(min) || !Number.isFinite(max)) {
    throw new CostAnomalyPolicyError(
      `policy.yaml: '${path}' must carry numeric finite 'min'/'max' bounds (got min=${JSON.stringify(min)}, max=${JSON.stringify(max)}).`,
    );
  }
  if (min > max) {
    throw new CostAnomalyPolicyError(`policy.yaml: '${path}' has min (${min}) > max (${max}) — an unsatisfiable bound.`);
  }
  if (value < min || value > max) {
    throw new CostAnomalyPolicyError(`policy.yaml: '${path}.value' (${value}) is out of its declared bound [${min}, ${max}].`);
  }
  if (origin !== "net-new") {
    throw new CostAnomalyPolicyError(
      `policy.yaml: '${path}.origin' must be exactly "net-new" (got ${JSON.stringify(origin)}) — no prior source ` +
        "literal of this shape ever existed to lift from; see this module's header.",
    );
  }
  return value;
}

/** Parse+validate an already-parsed `plan/policy.yaml` mapping's `costAnomaly` block. Pure — no
 *  I/O — so a test can drive a fixture object directly, mirroring `src/lib/policy.ts`'s
 *  `validatePolicy(raw)`. */
export function parseCostAnomalyPolicy(raw: unknown): CostAnomalyPolicy {
  if (!isPlainObject(raw)) throw new CostAnomalyPolicyError("policy.yaml must be a mapping.");
  const section = raw.costAnomaly;
  if (!isPlainObject(section)) throw new CostAnomalyPolicyError("policy.yaml: 'costAnomaly' must be a mapping.");
  const multiplier = numberRow("costAnomaly.multiplier", section.multiplier);
  const minSamples = numberRow("costAnomaly.minSamples", section.minSamples);
  return { multiplier, minSamples };
}

/** Load+validate `costAnomaly` off a `plan/policy.yaml` file at `policyYamlPath`. */
export function loadCostAnomalyPolicy(policyYamlPath: string): CostAnomalyPolicy {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(policyYamlPath, "utf8"));
  } catch (err) {
    throw new CostAnomalyPolicyError(`policy.yaml is not valid YAML (${policyYamlPath}): ${String(err)}`);
  }
  return parseCostAnomalyPolicy(raw);
}

let cachedDefaultCostAnomalyPolicy: CostAnomalyPolicy | undefined;

/**
 * The `costAnomaly` policy at `src/lib/policy.ts`'s `installPolicyPath()`, loaded once and
 * memoized for the process's lifetime — same "load once, hold it" shape as that module's own
 * `loadDefaultPolicy` (and the same caveat: a long-lived daemon holds its boot-time multiplier/
 * minSamples until it restarts; a retuned row lands on that process's next boot, per this task's
 * own note — "a running daemon will not pick up a retuned multiplier mid-flight").
 */
export function loadDefaultCostAnomalyPolicy(): CostAnomalyPolicy {
  if (!cachedDefaultCostAnomalyPolicy) cachedDefaultCostAnomalyPolicy = loadCostAnomalyPolicy(installPolicyPath());
  return cachedDefaultCostAnomalyPolicy;
}

/** The median of `values` — the ordinary "sort, take the middle (or average the middle two)"
 *  definition. `[]` is never passed by this module's own callers (every class here carries at
 *  least `policy.minSamples >= 1` runs by construction), so this throws rather than fabricate a
 *  0 a real empty class never earns. */
function median(values: readonly number[]): number {
  if (values.length === 0) throw new CostAnomalyPolicyError("median: cannot be taken over zero values.");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** One run's cost flagged against its own class's median — everything a NEEDS ME row (design
 *  note vii's other required half) needs to name: the run, its class, its cost, and the median
 *  it exceeded. */
export interface CostAnomalyFinding {
  runId: string;
  taskId: string;
  taskClass: string;
  costUsd: number;
  medianCostUsd: number;
  multiplier: number;
  /** How many settled runs `medianCostUsd` was computed over — carried so a reader can judge
   *  the median's own weight without a second ledger read. */
  sampleSize: number;
}

/**
 * PURE fold: groups SETTLED runs (`verdict !== "incomplete"` — an in-flight run's partial cost
 * neither anchors a class's median nor is itself judged against one) by `taskClass` (`"unknown"`
 * for a run with none, mirroring `src/lib/retro.ts`'s `aggregateByClass`), computes each class's
 * MEDIAN cost (design note iii), and flags every run in a class that has reached
 * `policy.minSamples` settled runs whose own cost exceeds `median * policy.multiplier`. A class
 * under the sample floor contributes NO findings at all (design note ii) — silence, not a guess.
 *
 * Deliberately no ledger-dedup here — that is {@link pendingCostAnomalies}'s job, so this
 * function stays a pure, re-derivable-from-scratch reduction over `runs` alone, testable without
 * any ledger shape at all.
 */
export function detectCostAnomalies(runs: readonly RunSummary[], policy: CostAnomalyPolicy): CostAnomalyFinding[] {
  const settled = runs.filter((r) => r.verdict !== "incomplete");
  const byClass = new Map<string, RunSummary[]>();
  for (const r of settled) {
    const key = r.taskClass ?? "unknown";
    const arr = byClass.get(key) ?? [];
    arr.push(r);
    byClass.set(key, arr);
  }
  const out: CostAnomalyFinding[] = [];
  for (const [taskClass, rs] of byClass) {
    // (ii) A THIN CLASS IS SILENT, NOT ANOMALOUS.
    if (rs.length < policy.minSamples) continue;
    const med = median(rs.map((r) => r.costUsd));
    for (const r of rs) {
      if (r.costUsd > med * policy.multiplier) {
        out.push({
          runId: r.runId,
          taskId: r.taskId,
          taskClass,
          costUsd: round2(r.costUsd),
          medianCostUsd: round2(med),
          multiplier: policy.multiplier,
          sampleSize: rs.length,
        });
      }
    }
  }
  out.sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  return out;
}

/** Every run id this ledger has ALREADY recorded a `cost.anomaly` row for — {@link
 *  pendingCostAnomalies}'s dedup set (design note iv: "ONE ROW PER RUN, IDEMPOTENT"). */
export function alreadyLedgeredCostAnomalyRunIds(records: readonly LedgerRecord[]): Set<string> {
  const out = new Set<string>();
  for (const r of records) {
    if (r.step === COST_ANOMALY_STEP && typeof r.run_id === "string") out.add(r.run_id);
  }
  return out;
}

/**
 * {@link detectCostAnomalies} over `records`' own runs ({@link gatherRuns}), filtered against
 * {@link alreadyLedgeredCostAnomalyRunIds} — a repeated pass over the SAME ledger returns `[]`
 * the second time (design note iv), because every finding it would otherwise re-derive already
 * carries a `cost.anomaly` row for that run id.
 */
export function pendingCostAnomalies(records: readonly LedgerRecord[], policy: CostAnomalyPolicy): CostAnomalyFinding[] {
  const already = alreadyLedgeredCostAnomalyRunIds(records);
  const runs = gatherRuns(records as LedgerRecord[]);
  return detectCostAnomalies(runs, policy).filter((f) => !already.has(f.runId));
}

/** Build (never write) the ledger line for one finding — pure, same builder/writer split as
 *  `src/lib/retro.ts`'s `mutationGateVerdictLine`/`recordMutationGateVerdict`. */
export function costAnomalyLine(finding: CostAnomalyFinding): LedgerLine {
  return {
    run_id: finding.runId,
    task_id: finding.taskId,
    step: COST_ANOMALY_STEP,
    task_class: finding.taskClass,
    cost_usd: finding.costUsd,
    median_cost_usd: finding.medianCostUsd,
    multiplier: finding.multiplier,
    sample_size: finding.sampleSize,
  };
}

export interface CostAnomalyDeps {
  ledgerPath: string;
  /** Defaults to the real `appendLedger` — injectable so a test spies on writes instead of
   *  touching disk (same shape as `src/lib/retro.ts`'s `MutationGateVerdictDeps`). */
  writeLedger?: (path: string, line: LedgerLine) => void;
}

/**
 * The ONE effectful entry point: appends exactly one `cost.anomaly` row per pending finding and
 * returns what it wrote. NO OTHER SIDE EFFECT — no dispatch call, no merge call, no worker
 * control of any kind (design note v: "it reports; it never acts") — {@link CostAnomalyDeps}
 * carries nothing but a ledger sink, by construction there is nothing else this function could
 * gate even if it wanted to.
 */
export function recordCostAnomalies(
  records: readonly LedgerRecord[],
  policy: CostAnomalyPolicy,
  deps: CostAnomalyDeps,
): CostAnomalyFinding[] {
  const pending = pendingCostAnomalies(records, policy);
  const writeLedger = deps.writeLedger ?? appendLedger;
  for (const finding of pending) writeLedger(deps.ledgerPath, costAnomalyLine(finding));
  return pending;
}
