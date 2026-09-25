import { createHash } from "node:crypto";
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
 * W1-T4417 — A FINDING NOBODY SEES IS NOT A REPORT: a `cost.anomaly` row sat in the ledger eight
 * times over for one run and reached no one. {@link costAnomalyIncidentEvent} builds (never
 * writes — `sweep.ts` appends it) the SAME KIND of `incident.event` row the W1-T4383 ingest
 * route ledgers, fingerprinted by `kind` + `name` ALONE (never the per-run message), so every
 * anomaly in one task CLASS collapses to ONE fingerprint the SRE gardener triages, not one per
 * run. {@link detectRunningLong}/{@link recordRunningLong} are this same idea's other half: an
 * IN-FLIGHT run (no `verdict` line yet) compared to its class's median SETTLED duration — past
 * the multiplier it ledgers ONE `run.running_long` row (idempotent per run id, exactly like
 * `cost.anomaly`) and {@link runningLongIncidentEvent} builds its own incident event the same way.
 * Neither detector stops the run itself — still just a report.
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
   *  touching disk (same shape as `src/lib/ledger.ts`'s `LedgerWriterDeps`). */
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

// ── W1-T4417: route a finding into the SRE gardener's incident ingest (W1-T4383) ────────────────
//
// No separate in-process writer lives in `incident-events.ts` today — that module's whole write
// surface is one HTTP route handler (validate -> scrub -> fingerprint -> ledger, inline). Rather
// than widen this task's declared files to add one there, {@link incidentEventLine} builds the
// SAME SHAPE of row directly: `task_id: "INCIDENT"` (the registered pseudo sender,
// producer-identity.ts), `step: "incident.event"`, and a `fingerprint`/`kind`/`name` triple
// `sre-lane.ts`'s `incidentEventFromLedgerRow` already knows how to read. The fingerprint is
// deliberately basis'd on `kind` + `name` ONLY — never the per-run `message` — so every finding
// in one task CLASS (the `name`'s own suffix) collapses to ONE fingerprint, "grouped by class,
// not by task" (this task's own design note i).
const ANOMALY_INCIDENT_KIND = "anomaly";

function incidentEventLine(input: { runId: string; name: string; message: string }): LedgerLine {
  const fingerprint = createHash("sha256").update(`${ANOMALY_INCIDENT_KIND}\u0000${input.name}`, "utf8").digest("hex");
  return {
    run_id: `INCIDENT-${input.runId}`,
    task_id: "INCIDENT",
    step: "incident.event",
    fingerprint,
    source: "daemon",
    kind: ANOMALY_INCIDENT_KIND,
    name: input.name,
    message: input.message,
  };
}

/** Build (never write — `sweep.ts` appends it where it records anomalies) the one incident event
 *  a NEW `cost.anomaly` finding earns: `name` carries only the task CLASS, so two findings in the
 *  same class fingerprint identically no matter which run/task each names. */
export function costAnomalyIncidentEvent(finding: CostAnomalyFinding): LedgerLine {
  return incidentEventLine({
    runId: finding.runId,
    name: `cost.anomaly:${finding.taskClass}`,
    message:
      `task ${finding.taskId} (run ${finding.runId}) cost $${finding.costUsd} against class ` +
      `"${finding.taskClass}"'s median $${finding.medianCostUsd} (×${finding.multiplier}, n=${finding.sampleSize})`,
  });
}

// ── W1-T4417 RUNNING-LONG SENTINEL ───────────────────────────────────────────────────────────
//
// The OTHER half of "a runaway run": cost is only visible once a run SETTLES, but a run stuck
// mid-flight is invisible to `detectCostAnomalies` by construction (design note: "an in-flight
// run's partial cost neither anchors a class's median nor is itself judged against one"). This
// compares elapsed WALL-CLOCK time instead, against the SAME class's median duration taken over
// its own SETTLED runs (`run.start` -> `verdict` ts span) — same multiplier/minSamples policy,
// same "a thin class is silent" floor, same "one row per run" idempotence as the cost sentinel.

/** One run's own start/settle timestamps, off the raw ledger — kept private: `retro.ts`'s
 *  `RunSummary` carries no duration field, and widening it is out of this task's declared files. */
interface RunClock {
  runId: string;
  taskId: string;
  taskClass: string;
  startMs: number;
  /** The terminal `verdict` line's ts, in ms — `undefined` while the run is still in flight. */
  endMs?: number;
}

function runClocks(records: readonly LedgerRecord[]): RunClock[] {
  const byRun = new Map<string, LedgerRecord[]>();
  for (const r of records) {
    if (typeof r.run_id !== "string") continue;
    const arr = byRun.get(r.run_id) ?? [];
    arr.push(r);
    byRun.set(r.run_id, arr);
  }
  const out: RunClock[] = [];
  for (const [runId, lines] of byRun) {
    const start = lines.find((l) => l.step === "run.start");
    if (!start || typeof start.ts !== "string") continue; // a torn fragment — skip, same as gatherRuns
    const startMs = Date.parse(start.ts);
    if (!Number.isFinite(startMs)) continue;
    const verdictLine = lines.find((l) => l.step === "verdict");
    const endMs = verdictLine && typeof verdictLine.ts === "string" ? Date.parse(verdictLine.ts) : undefined;
    out.push({
      runId,
      taskId: String(start.task_id ?? ""),
      taskClass: typeof start.task_class === "string" ? start.task_class : "unknown",
      startMs,
      ...(endMs !== undefined && Number.isFinite(endMs) ? { endMs } : {}),
    });
  }
  return out;
}

/** One in-flight run flagged against its own class's median SETTLED duration — the duration
 *  analogue of {@link CostAnomalyFinding}. */
export interface RunningLongFinding {
  runId: string;
  taskId: string;
  taskClass: string;
  elapsedMs: number;
  medianMs: number;
  multiplier: number;
  /** How many SETTLED runs `medianMs` was computed over. */
  sampleSize: number;
}

export const RUNNING_LONG_STEP = "run.running_long";

/**
 * PURE fold, mirroring {@link detectCostAnomalies}'s shape exactly but over DURATION instead of
 * cost: computes each class's median span (`run.start` -> `verdict`) over its own SETTLED runs,
 * then flags every run STILL IN FLIGHT (no `verdict` line yet, so `endMs === undefined`) whose
 * elapsed time as of `nowMs` exceeds `median * policy.multiplier` — never a settled run (once it
 * has a verdict it is no longer a candidate at all, "reported once while it still runs"), and
 * never a class under `policy.minSamples` settled runs (design note ii, same floor as cost).
 */
export function detectRunningLong(records: readonly LedgerRecord[], policy: CostAnomalyPolicy, nowMs: number): RunningLongFinding[] {
  const clocks = runClocks(records);
  const settledByClass = new Map<string, number[]>();
  for (const c of clocks) {
    if (c.endMs === undefined) continue;
    const durationMs = c.endMs - c.startMs;
    if (durationMs < 0) continue; // a torn/out-of-order pair — never a negative duration
    const arr = settledByClass.get(c.taskClass) ?? [];
    arr.push(durationMs);
    settledByClass.set(c.taskClass, arr);
  }
  const out: RunningLongFinding[] = [];
  for (const c of clocks) {
    if (c.endMs !== undefined) continue; // only a run STILL RUNNING is ever a candidate
    const durations = settledByClass.get(c.taskClass);
    if (!durations || durations.length < policy.minSamples) continue;
    const medianMs = median(durations);
    const elapsedMs = nowMs - c.startMs;
    if (elapsedMs > medianMs * policy.multiplier) {
      out.push({
        runId: c.runId,
        taskId: c.taskId,
        taskClass: c.taskClass,
        elapsedMs,
        medianMs: Math.round(medianMs),
        multiplier: policy.multiplier,
        sampleSize: durations.length,
      });
    }
  }
  out.sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  return out;
}

/** Every run id this ledger has ALREADY recorded a `run.running_long` row for — mirrors {@link
 *  alreadyLedgeredCostAnomalyRunIds} exactly, one row per run id, ever. */
export function alreadyLedgeredRunningLongRunIds(records: readonly LedgerRecord[]): Set<string> {
  const out = new Set<string>();
  for (const r of records) {
    if (r.step === RUNNING_LONG_STEP && typeof r.run_id === "string") out.add(r.run_id);
  }
  return out;
}

/** {@link detectRunningLong} filtered against {@link alreadyLedgeredRunningLongRunIds} — a
 *  repeated pass over the same (now-ledgered) run returns nothing new for it, mirroring {@link
 *  pendingCostAnomalies}. */
export function pendingRunningLong(records: readonly LedgerRecord[], policy: CostAnomalyPolicy, nowMs: number): RunningLongFinding[] {
  const already = alreadyLedgeredRunningLongRunIds(records);
  return detectRunningLong(records, policy, nowMs).filter((f) => !already.has(f.runId));
}

/** Build (never write) the ledger line for one running-long finding — mirrors {@link costAnomalyLine}. */
export function runningLongLine(finding: RunningLongFinding): LedgerLine {
  return {
    run_id: finding.runId,
    task_id: finding.taskId,
    step: RUNNING_LONG_STEP,
    task_class: finding.taskClass,
    elapsed_ms: finding.elapsedMs,
    median_ms: finding.medianMs,
    multiplier: finding.multiplier,
    sample_size: finding.sampleSize,
  };
}

/** The ONE effectful entry point for the running-long sentinel — mirrors {@link
 *  recordCostAnomalies} exactly, down to the same {@link CostAnomalyDeps} shape (a ledger sink,
 *  nothing else). Appends exactly one `run.running_long` row per pending finding. */
export function recordRunningLong(
  records: readonly LedgerRecord[],
  policy: CostAnomalyPolicy,
  nowMs: number,
  deps: CostAnomalyDeps,
): RunningLongFinding[] {
  const pending = pendingRunningLong(records, policy, nowMs);
  const writeLedger = deps.writeLedger ?? appendLedger;
  for (const finding of pending) writeLedger(deps.ledgerPath, runningLongLine(finding));
  return pending;
}

/** Build (never write) the one incident event a NEW `run.running_long` finding earns — same
 *  class-grouped fingerprint discipline as {@link costAnomalyIncidentEvent}. */
export function runningLongIncidentEvent(finding: RunningLongFinding): LedgerLine {
  return incidentEventLine({
    runId: finding.runId,
    name: `run.running_long:${finding.taskClass}`,
    message:
      `task ${finding.taskId} (run ${finding.runId}) has run ${finding.elapsedMs}ms against class ` +
      `"${finding.taskClass}"'s median ${finding.medianMs}ms (×${finding.multiplier}, n=${finding.sampleSize})`,
  });
}
