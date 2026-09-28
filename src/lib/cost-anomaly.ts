import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { appendLedger, type LedgerLine } from "./ledger.js";
import { createLedgerRotationMemo, readLedgerUnionRecordsMemoized, realLedgerFs, type LedgerGrepFsDeps, type LedgerRotationMemo } from "./ledger-union.js";
import { installPolicyPath } from "./policy.js";
import { gatherRuns, type LedgerRecord, type RunSummary } from "./retro.js";
import { THROWN_RUN_VERDICT_STAGES } from "./status.js";

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
  /** W1-T4709: settled runs {@link isNeverWorkedVerdict} kept out of the median; absent when none. */
  excludedCount?: number;
}

/** W1-T4709: a verdict that ended a run which never did any work — a thrown/deferred run's stage
 *  (the set itself, never a copy) or an operator backfill. Its span and cost are setup only. */
export function isNeverWorkedVerdict(line: LedgerRecord | undefined): boolean {
  if (!line) return false;
  if (line.backfilled === true) return true;
  return typeof line.stage === "string" && THROWN_RUN_VERDICT_STAGES.has(line.stage);
}

/** W1-T4709: run ids whose FIRST `verdict` row (the one `gatherRuns` reads) never worked. */
export function neverWorkedRunIds(records: readonly LedgerRecord[]): Set<string> {
  const seen = new Set<string>();
  const out = new Set<string>();
  for (const r of records) {
    if (r.step !== "verdict" || typeof r.run_id !== "string" || seen.has(r.run_id)) continue;
    seen.add(r.run_id);
    if (isNeverWorkedVerdict(r)) out.add(r.run_id);
  }
  return out;
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
export function detectCostAnomalies(
  runs: readonly RunSummary[],
  policy: CostAnomalyPolicy,
  neverWorked: ReadonlySet<string> = new Set(),
): CostAnomalyFinding[] {
  const settled = runs.filter((r) => r.verdict !== "incomplete");
  const byClass = new Map<string, RunSummary[]>();
  const excludedByClass = new Map<string, number>();
  for (const r of settled) {
    const key = r.taskClass ?? "unknown";
    if (neverWorked.has(r.runId)) {
      excludedByClass.set(key, (excludedByClass.get(key) ?? 0) + 1);
      continue;
    }
    const arr = byClass.get(key) ?? [];
    arr.push(r);
    byClass.set(key, arr);
  }
  const out: CostAnomalyFinding[] = [];
  for (const [taskClass, rs] of byClass) {
    // (ii) A THIN CLASS IS SILENT, NOT ANOMALOUS.
    if (rs.length < policy.minSamples) continue;
    const med = median(rs.map((r) => r.costUsd));
    const excluded = excludedByClass.get(taskClass) ?? 0;
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
          ...(excluded > 0 ? { excludedCount: excluded } : {}),
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
export function pendingCostAnomalies(
  records: readonly LedgerRecord[],
  policy: CostAnomalyPolicy,
  alreadyReported: ReadonlySet<string> = new Set(),
): CostAnomalyFinding[] {
  const already = alreadyLedgeredCostAnomalyRunIds(records);
  const runs = gatherRuns(records as LedgerRecord[]);
  return detectCostAnomalies(runs, policy, neverWorkedRunIds(records)).filter((f) => !already.has(f.runId) && !alreadyReported.has(f.runId));
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
    ...(finding.excludedCount !== undefined ? { excluded_count: finding.excludedCount } : {}),
  };
}

export interface CostAnomalyDeps {
  ledgerPath: string;
  /** Defaults to the real `appendLedger` — injectable so a test spies on writes instead of
   *  touching disk (same shape as `src/lib/ledger.ts`'s `LedgerWriterDeps`). */
  writeLedger?: (path: string, line: LedgerLine) => void;
  /** W1-T4702: run ids already reported in rows `records` no longer holds (the rotated archives). */
  alreadyReported?: ReadonlySet<string>;
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
  const pending = pendingCostAnomalies(records, policy, deps.alreadyReported);
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
      `"${finding.taskClass}"'s median $${finding.medianCostUsd} (×${finding.multiplier}, n=${finding.sampleSize}` +
      `${finding.excludedCount !== undefined ? `, excluded=${finding.excludedCount}` : ""})`,
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
  /** W1-T4709: its verdict {@link isNeverWorkedVerdict} — settled, but no sample of the class. */
  neverWorked?: true;
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
      ...(isNeverWorkedVerdict(verdictLine) ? { neverWorked: true as const } : {}),
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
  /** W1-T4709: settled runs kept out of `medianMs` ({@link isNeverWorkedVerdict}); absent when none. */
  excludedCount?: number;
}

export const RUNNING_LONG_STEP = "run.running_long";

/** One class's settled spans (`run.start` -> `verdict`) and how many never-worked runs it left out. */
export interface SettledSpans {
  spansMs: number[];
  excluded: number;
}

/** W1-T4709: THE settled-span fold — per class, every settled span except a never-worked run's,
 *  which is counted in `excluded` instead so the sample size stays honest. */
export function settledSpansByClass(records: readonly LedgerRecord[]): Map<string, SettledSpans> {
  return settledSpansOf(runClocks(records));
}

function settledSpansOf(clocks: readonly RunClock[]): Map<string, SettledSpans> {
  const out = new Map<string, SettledSpans>();
  for (const c of clocks) {
    if (c.endMs === undefined) continue;
    const durationMs = c.endMs - c.startMs;
    if (durationMs < 0) continue; // a torn/out-of-order pair — never a negative duration
    const entry = out.get(c.taskClass) ?? { spansMs: [], excluded: 0 };
    if (c.neverWorked) entry.excluded++;
    else entry.spansMs.push(durationMs);
    out.set(c.taskClass, entry);
  }
  return out;
}

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
  const settledByClass = settledSpansOf(clocks);
  const out: RunningLongFinding[] = [];
  for (const c of clocks) {
    if (c.endMs !== undefined) continue; // only a run STILL RUNNING is ever a candidate
    const settled = settledByClass.get(c.taskClass);
    const durations = settled?.spansMs;
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
        ...(settled.excluded > 0 ? { excludedCount: settled.excluded } : {}),
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
export function pendingRunningLong(
  records: readonly LedgerRecord[],
  policy: CostAnomalyPolicy,
  nowMs: number,
  alreadyReported: ReadonlySet<string> = new Set(),
): RunningLongFinding[] {
  const already = alreadyLedgeredRunningLongRunIds(records);
  return detectRunningLong(records, policy, nowMs).filter((f) => !already.has(f.runId) && !alreadyReported.has(f.runId));
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
    ...(finding.excludedCount !== undefined ? { excluded_count: finding.excludedCount } : {}),
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
  const pending = pendingRunningLong(records, policy, nowMs, deps.alreadyReported);
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
      `"${finding.taskClass}"'s median ${finding.medianMs}ms (×${finding.multiplier}, n=${finding.sampleSize}` +
      `${finding.excludedCount !== undefined ? `, excluded=${finding.excludedCount}` : ""})`,
  });
}

// ── W1-T4702: "reported once" must survive rotation ─────────────────────────────────────────
//
// Both sentinels' dedupe markers leave the live file: `rotateLedger` archives every
// `run.running_long` row (it is not a retained step) and keeps only the newest 200 `cost.anomaly`
// rows. The run's own `run.start` stays live, so a live-only dedupe re-reported it after every
// rotation: 103,010 running_long rows and as many incident events for 201 runs (2026-09-25..28).

/** The steps whose rows mean "this run was already reported" — read from the archive∪live union. */
export const REPORTED_ONCE_STEPS: readonly string[] = [COST_ANOMALY_STEP, RUNNING_LONG_STEP];

/** Memo reducer: one `{step, run_id}` row per reported run, so a warm union holds ids, not rows. */
export function reportedOnceRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    if (typeof row.step !== "string" || !REPORTED_ONCE_STEPS.includes(row.step) || typeof row.run_id !== "string") continue;
    const key = `${row.step}\u0000${row.run_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ step: row.step, run_id: row.run_id });
  }
  return out;
}

/** Already-reported run ids per sentinel. `complete: false` means the union could not be read whole,
 *  and the caller must then report nothing new (fail closed) rather than re-report. */
export interface ReportedAnomalies {
  complete: boolean;
  costAnomaly: ReadonlySet<string>;
  runningLong: ReadonlySet<string>;
  reason?: string;
}

const reportedOnceMemos = new Map<string, LedgerRotationMemo>();

/**
 * Every run id either sentinel ever reported, over EVERY rotation plus `liveRows` (the caller's own
 * live read). Rotations are immutable, so each is parsed once per process (a cold full corpus took
 * 7 s, a warm pass reads only the memo). An unlistable state directory or an unreadable archive is
 * incomplete: an absent report there is unknown, not absent.
 */
export async function readReportedAnomalies(
  stateDir: string,
  liveRows: readonly LedgerRecord[],
  fsDeps: LedgerGrepFsDeps = realLedgerFs,
): Promise<ReportedAnomalies> {
  const incomplete = (reason: string): ReportedAnomalies => ({ complete: false, costAnomaly: new Set(), runningLong: new Set(), reason });
  try {
    fsDeps.readdirSync(stateDir);
  } catch (e) {
    return incomplete(`state directory unreadable: ${stateDir}: ${String((e as Error)?.message ?? e)}`);
  }
  let memo = reportedOnceMemos.get(stateDir);
  if (memo === undefined) {
    memo = createLedgerRotationMemo(reportedOnceRows);
    reportedOnceMemos.set(stateDir, memo);
  }
  const read = await readLedgerUnionRecordsMemoized(
    stateDir,
    memo,
    { step: REPORTED_ONCE_STEPS, refuseIncomplete: true, readLiveRecords: () => liveRows as Iterable<Record<string, unknown>> },
    fsDeps,
  );
  if (!read.ok) return incomplete(`unreadable ledger archive(s): ${read.unread.join(", ")}`);
  return {
    complete: true,
    costAnomaly: alreadyLedgeredCostAnomalyRunIds(read.rows),
    runningLong: alreadyLedgeredRunningLongRunIds(read.rows),
  };
}
