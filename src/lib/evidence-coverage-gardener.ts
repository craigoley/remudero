import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import {
  BENCHMARK_QUALITY_VERSION,
  deriveBenchmarkEvidence,
  type BenchmarkAssignmentEvidence,
  type BenchmarkEvidenceSnapshot,
  type BenchmarkTerminalEvidence,
} from "./benchmark-evidence.js";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import { captureFeedback, feedbackEntryPath, feedbackEntryRepoPath, readFeedbackEntry } from "./feedback.js";
import { landFeedbackStatusContent, type LandFeedbackOpts } from "./feedback-landing.js";
import { writeAtomic } from "./fs-race-safe.js";
import { readLedgerUnionRecordsSync } from "./ledger-union.js";

/**
 * lib/evidence-coverage-gardener.ts (W1-T4622) — an evidence gap becomes work.
 *
 * benchmark-quality-v1 (benchmark-evidence.ts) measures per-field missingness and join coverage, but
 * nothing watched it: the fix lane's missing served model, the reviewer's missing assignment and the
 * transcript's wrong label were each found by a one-off census. This gardener reads that projection
 * PER LANE on a cadence and, when a lane's coverage of a required field falls below its own trailing
 * baseline, sits under the field's absolute floor, or is absent outright, files or updates ONE
 * dedup-keyed feedback follow-up naming the lane, the field, the denominator and the first-seen time.
 * A reading under the floor never becomes a baseline (W1-T4640): a lane that was broken from its
 * first pass would otherwise be adopted as healthy and never filed.
 *
 * IT NEVER GATES. It returns no verdict any merge, review or dispatch path reads; a gap is feedback
 * for triage to turn into a task. Its OWN failures are visible: a filer that throws is logged and the
 * gap retried next pass, and a ledger it cannot read completely is itself filed as repair work.
 */

/** The fields every run must leave usable evidence for: the assignment join, the outcome join, the
 *  served model, measured tokens and cost. */
export const EVIDENCE_COVERAGE_FIELDS = ["assignment", "outcome", "servedModel", "tokens", "cost"] as const;
export type EvidenceCoverageField = (typeof EVIDENCE_COVERAGE_FIELDS)[number];

/** PRIMARY CONTROL (W1-T4640): the floor for the assignment and outcome joins. In-flight rows cost a healthy join
 *  up to a drop tolerance (best measured 0.91-1.0); the audit's broken joins read 0.002-0.68. */
export const EVIDENCE_COVERAGE_JOIN_FLOOR = 0.8;

/** PRIMARY CONTROL (W1-T4640): the floor for served model, tokens and cost, judged over joined calls that no
 *  in-flight row depresses: healthy lanes read 0.93-1.0 on them, run-task's served model 0.48. */
export const EVIDENCE_COVERAGE_MEASURED_FLOOR = 0.9;

/** PRIMARY CONTROL: each required field's absolute floor — under it a lane-field is a gap whatever its
 *  baseline, and the reading never becomes one. */
export const EVIDENCE_COVERAGE_FLOORS: Readonly<Record<EvidenceCoverageField, number>> = {
  assignment: EVIDENCE_COVERAGE_JOIN_FLOOR,
  outcome: EVIDENCE_COVERAGE_JOIN_FLOOR,
  servedModel: EVIDENCE_COVERAGE_MEASURED_FLOOR,
  tokens: EVIDENCE_COVERAGE_MEASURED_FLOOR,
  cost: EVIDENCE_COVERAGE_MEASURED_FLOOR,
};

/** PRIMARY CONTROL: a lane-field whose denominator is below this is reported insufficient, never a
 *  gap — a thin lane's ratio swings on one row and would file noise. */
export const EVIDENCE_COVERAGE_MIN_DENOMINATOR = 20;

/** PRIMARY CONTROL: how far (absolute ratio) coverage must fall under the trailing baseline to be a
 *  gap — in-flight assignments without a terminal yet depress a window by a few points when healthy. */
export const EVIDENCE_COVERAGE_DROP_TOLERANCE = 0.1;

/** PRIMARY CONTROL: the cadence. A pass reads the windowed ledger union, so the daemon's poll tick
 *  only checks the state file's `lastPassAt` until this has elapsed. */
export const EVIDENCE_COVERAGE_PASS_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The trailing window each pass measures. */
export const EVIDENCE_COVERAGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** BACKSTOP: the most follow-ups one pass files or updates. A systemic loss (a writer that stopped
 *  stamping a field everywhere) would otherwise open lanes x fields entries at once; the rest are
 *  deferred to the next pass, never dropped. */
export const EVIDENCE_COVERAGE_MAX_FILINGS_PER_PASS = 5;

export const EVIDENCE_COVERAGE_POLICY_VERSION = "evidence-coverage-v1";

const SOURCE_FOLLOWUP_ID = "evidence-coverage-gardener-source";
const EVIDENCE_STEPS = ["run.start", "worker.assignment", "worker.attempt", "verdict"] as const;
const FIELD_SLUG: Record<EvidenceCoverageField, string> = {
  assignment: "assignment",
  outcome: "outcome",
  servedModel: "served-model",
  tokens: "tokens",
  cost: "cost",
};
const FIELD_DENOMINATOR: Record<EvidenceCoverageField, string> = {
  assignment: "terminal worker results (joined to an assignment, or carrying no id or no match)",
  outcome: "assignments (a joined terminal outcome is the numerator)",
  servedModel: "joined worker calls",
  tokens: "joined worker calls",
  cost: "joined worker calls",
};

type Row = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function obj(value: unknown): Row | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : undefined;
}

function nonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

interface LaneAccumulator {
  assignments: Map<string, BenchmarkAssignmentEvidence>;
  joined: Map<string, BenchmarkTerminalEvidence>;
  unmatched: Map<string, BenchmarkTerminalEvidence>;
  assignmentRowsSeen: number;
  terminalRowsSeen: number;
  invalidAssignmentRows: number;
  terminalsWithoutAssignmentId: number;
  duplicateAssignmentRows: number;
  duplicateTerminalRows: number;
}

function assignmentOf(row: Row, run: { taskClass?: string; risk?: string } | undefined): BenchmarkAssignmentEvidence | undefined {
  const raw = obj(row.worker_assignment);
  const selected = obj(raw?.selected);
  const id = str(raw?.id);
  const provider = str(selected?.provider);
  const model = str(selected?.model);
  if (!id || !provider || !model) return undefined;
  const requestedModel = str(obj(raw?.requested)?.model);
  const effort = str(selected?.effort);
  return {
    id,
    provider,
    selectedModel: model,
    ...(requestedModel ? { requestedModel } : {}),
    ...(effort ? { effort } : {}),
    ...(run?.taskClass ? { taskClass: run.taskClass } : {}),
    ...(run?.risk ? { risk: run.risk } : {}),
  };
}

function terminalOf(row: Row): BenchmarkTerminalEvidence {
  const tokens = obj(row.tokens);
  const durationMs = nonnegative(row.worker_duration_ms);
  const costUsd = nonnegative(row.total_cost_usd);
  const billingMode = row.billing_mode === "api" || row.billing_mode === "subscription" ? row.billing_mode : undefined;
  return {
    ...(typeof row.success === "boolean" ? { success: row.success } : {}),
    servedModel: str(row.served_model) ?? null,
    tokensMeasured: nonnegative(tokens?.input) !== undefined && nonnegative(tokens?.output) !== undefined,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(billingMode ? { billingMode } : {}),
  };
}

/**
 * The benchmark-quality projection split by lane: the same join analytics-route.ts builds over the
 * whole union, keyed by each row's `lane` (else its run's `run.start` type, else `unknown`). A terminal
 * joins its ASSIGNMENT's lane; one that joins nothing stays in its own row's lane. An attempt wins
 * over a verdict for the same assignment, as analytics-route.ts's terminal merge does.
 */
export function benchmarkEvidenceByLane(rows: readonly Row[], asOf: string): Map<string, BenchmarkEvidenceSnapshot> {
  const runs = new Map<string, { type?: string; taskClass?: string; risk?: string }>();
  for (const row of rows) {
    const runId = str(row.run_id);
    if (row.step === "run.start" && runId) runs.set(runId, { type: str(row.type), taskClass: str(row.task_class), risk: str(row.risk) });
  }
  const runOf = (row: Row) => runs.get(str(row.run_id) ?? "");
  const laneOf = (row: Row) => str(row.lane) ?? runOf(row)?.type ?? "unknown";
  const lanes = new Map<string, LaneAccumulator>();
  const accumulator = (lane: string): LaneAccumulator => {
    let acc = lanes.get(lane);
    if (!acc) {
      acc = {
        assignments: new Map(), joined: new Map(), unmatched: new Map(),
        assignmentRowsSeen: 0, terminalRowsSeen: 0, invalidAssignmentRows: 0,
        terminalsWithoutAssignmentId: 0, duplicateAssignmentRows: 0, duplicateTerminalRows: 0,
      };
      lanes.set(lane, acc);
    }
    return acc;
  };
  const assignmentLane = new Map<string, string>();
  const attempts = new Map<string, { lane: string; terminal: BenchmarkTerminalEvidence }>();
  const verdicts = new Map<string, { lane: string; terminal: BenchmarkTerminalEvidence }>();

  for (const row of rows) {
    if (row.step === "worker.assignment") {
      const lane = laneOf(row);
      const acc = accumulator(lane);
      acc.assignmentRowsSeen += 1;
      const parsed = assignmentOf(row, runOf(row));
      if (!parsed) acc.invalidAssignmentRows += 1;
      else if (assignmentLane.has(parsed.id)) acc.duplicateAssignmentRows += 1;
      else {
        assignmentLane.set(parsed.id, lane);
        acc.assignments.set(parsed.id, parsed);
      }
    } else if (row.step === "worker.attempt" || (row.step === "verdict" && (str(row.selection_assignment_id) || str(row.model)))) {
      const lane = laneOf(row);
      const acc = accumulator(lane);
      acc.terminalRowsSeen += 1;
      const id = str(row.selection_assignment_id);
      const store = row.step === "worker.attempt" ? attempts : verdicts;
      if (!id || row.assignment_observed === false) acc.terminalsWithoutAssignmentId += 1;
      else if (store.has(id)) acc.duplicateTerminalRows += 1;
      else store.set(id, { lane, terminal: terminalOf(row) });
    }
  }
  for (const [id, entry] of new Map([...verdicts, ...attempts])) {
    const lane = assignmentLane.get(id);
    if (lane !== undefined) accumulator(lane).joined.set(id, entry.terminal);
    else accumulator(entry.lane).unmatched.set(id, entry.terminal);
  }

  const out = new Map<string, BenchmarkEvidenceSnapshot>();
  for (const [lane, acc] of lanes) {
    out.set(lane, deriveBenchmarkEvidence({
      assignments: acc.assignments,
      joinedTerminals: acc.joined,
      unmatchedTerminals: acc.unmatched,
      assignmentRowsSeen: acc.assignmentRowsSeen,
      terminalRowsSeen: acc.terminalRowsSeen,
      invalidAssignmentRows: acc.invalidAssignmentRows,
      terminalsWithoutAssignmentId: acc.terminalsWithoutAssignmentId,
      duplicateAssignmentRows: acc.duplicateAssignmentRows,
      duplicateTerminalRows: acc.duplicateTerminalRows,
      asOf,
      latestSourceAt: null,
    }));
  }
  return out;
}

export interface CoverageCount {
  observed: number;
  denominator: number;
}

/** One lane's coverage of each required field, read off its benchmark-quality snapshot. The terminal
 *  fields are judged over JOINED calls only — an assignment still running is the outcome join's gap,
 *  not a missing served model. */
export function laneFieldCoverage(snapshot: BenchmarkEvidenceSnapshot): Record<EvidenceCoverageField, CoverageCount> {
  const joinedCalls = (field: "servedModel" | "tokens" | "cost"): CoverageCount => ({
    observed: snapshot.coverage[field].observed,
    denominator: snapshot.coverage[field].observed + snapshot.coverage[field].notRecorded,
  });
  return {
    assignment: { observed: snapshot.joinedTerminalOutcomes, denominator: snapshot.joinedTerminalOutcomes + snapshot.terminalsWithoutAssignment },
    outcome: { observed: snapshot.coverage.outcome.observed, denominator: snapshot.coverage.outcome.denominator },
    servedModel: joinedCalls("servedModel"),
    tokens: joinedCalls("tokens"),
    cost: joinedCalls("cost"),
  };
}

export type CoverageGapKind = "absent" | "below-baseline" | "below-floor";
export type CoverageCellVerdict =
  | { kind: "insufficient" }
  | { kind: "healthy"; ratio: number }
  | { kind: "gap"; gap: CoverageGapKind };

/** The pure decision for one lane-field: thin is insufficient; zero coverage is absent whatever the
 *  baseline; a fall of more than the tolerance under the baseline is a gap; a reading under `floor`
 *  is a `below-floor` gap with or without a baseline; anything else is healthy and becomes the new
 *  baseline. A drop from a healthy baseline keeps the more specific `below-baseline` name even when
 *  it also lands under the floor. `floor` defaults to 0 (no floor); the gardener always passes the
 *  field's {@link EVIDENCE_COVERAGE_FLOORS} entry. */
export function judgeCoverageCell(count: CoverageCount, baseline: number | undefined, floor = 0): CoverageCellVerdict {
  if (count.denominator < EVIDENCE_COVERAGE_MIN_DENOMINATOR) return { kind: "insufficient" };
  const ratio = count.observed / count.denominator;
  if (count.observed === 0) return { kind: "gap", gap: "absent" };
  if (baseline !== undefined && ratio < baseline - EVIDENCE_COVERAGE_DROP_TOLERANCE) return { kind: "gap", gap: "below-baseline" };
  if (ratio < floor) return { kind: "gap", gap: "below-floor" };
  return { kind: "healthy", ratio };
}

/** The stable dedup key — also the feedback entry's id, so a repeat pass addresses the same file. */
export function evidenceCoverageFollowupId(lane: string, field: EvidenceCoverageField): string {
  const slug = lane.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "unknown";
  return `evidence-coverage-${slug}-${FIELD_SLUG[field]}`;
}

export function evidenceCoverageStatePath(stateDir: string): string {
  return join(stateDir, "evidence-coverage-gardener.json");
}

interface OpenGap {
  kind: CoverageGapKind;
  firstSeenAt: string;
  /** What the follow-up last said, so an unchanged gap is not re-landed every pass. */
  filedDigest?: string;
}

interface CoverageCell {
  baseline?: number;
  baselineAt?: string;
  gap?: OpenGap;
}

interface EvidenceCoverageState {
  version: 1;
  lastPassAt?: string;
  cells: Record<string, CoverageCell>;
  source?: OpenGap & { reason: string };
}

function readState(path: string, log: EvidenceCoverageInput["log"]): EvidenceCoverageState {
  if (!existsSync(path)) return { version: 1, cells: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as EvidenceCoverageState;
    return { version: 1, cells: parsed.cells ?? {}, ...(parsed.lastPassAt ? { lastPassAt: parsed.lastPassAt } : {}), ...(parsed.source ? { source: parsed.source } : {}) };
  } catch (e) {
    const reason = "an unreadable state file restarts every baseline empty; the next healthy pass re-learns it";
    log("evidence_coverage.state_unreadable", { reason, error: String((e as Error)?.message ?? e) });
    return { version: 1, cells: {} };
  }
}

/** A baseline adopted under its field's floor — by a pass that predates the floor — is dropped, so the
 *  lane is judged against the floor alone until a reading clears it. Returns the cells it changed. */
function discardSubFloorBaselines(state: EvidenceCoverageState): string[] {
  const discarded: string[] = [];
  for (const [key, cell] of Object.entries(state.cells)) {
    const floor = EVIDENCE_COVERAGE_FLOORS[key.slice(key.lastIndexOf("/") + 1) as EvidenceCoverageField] ?? 0;
    if (cell.baseline === undefined || cell.baseline >= floor) continue;
    delete cell.baseline;
    delete cell.baselineAt;
    discarded.push(key);
  }
  return discarded;
}

export interface EvidenceCoverageFollowup {
  /** The dedup key and feedback id. */
  id: string;
  /** `file` the first time this gap is reported, `update` while it persists. */
  action: "file" | "update";
  lane: string;
  field: EvidenceCoverageField | "source";
  raw: string;
}

export type EvidenceCoverageFiler = (followup: EvidenceCoverageFollowup) => void;

export type EvidenceRowsRead = { ok: true; rows: readonly Row[] } | { ok: false; reason: string };

export interface EvidenceCoverageInput {
  stateDir: string;
  /** The evidence rows at or after `sinceTs`; `ok: false` when the source could not be read whole. */
  readRows: (sinceTs: string) => EvidenceRowsRead;
  file: EvidenceCoverageFiler;
  log: (step: string, extra?: Record<string, unknown>) => void;
  clock?: Clock;
}

export interface EvidenceCoverageGap extends CoverageCount {
  lane: string;
  field: EvidenceCoverageField;
  kind: CoverageGapKind;
  baseline?: number;
  /** The field's absolute floor, carried on every gap so a `below-floor` follow-up can name it. */
  floor: number;
  firstSeenAt: string;
}

export interface EvidenceCoveragePass {
  ran: boolean;
  skipped?: "not-due";
  sourceUnavailable?: string;
  gaps: EvidenceCoverageGap[];
  insufficient: Array<{ lane: string; field: EvidenceCoverageField; denominator: number }>;
  filed: string[];
  updated: string[];
  failed: string[];
  deferred: number;
}

function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function gapFollowupRaw(gap: EvidenceCoverageGap): string {
  const ratio = gap.denominator > 0 ? gap.observed / gap.denominator : 0;
  const judged = gap.kind === "absent"
    ? "the field is absent: no row in the window records it"
    : gap.kind === "below-floor"
      ? `below the field's ${pct(gap.floor)} floor — a chronic gap no baseline excuses`
      : `trailing baseline ${pct(gap.baseline ?? 0)} — below it by more than ${pct(EVIDENCE_COVERAGE_DROP_TOLERANCE)}`;
  return [
    `Evidence coverage gap (${EVIDENCE_COVERAGE_POLICY_VERSION}, over ${BENCHMARK_QUALITY_VERSION}): lane \`${gap.lane}\`, field \`${gap.field}\`.`,
    `Coverage: ${gap.observed}/${gap.denominator} ${FIELD_DENOMINATOR[gap.field]} (${pct(ratio)}) in the trailing ${EVIDENCE_COVERAGE_WINDOW_MS / 86_400_000}-day window; ${judged}.`,
    `First seen: ${gap.firstSeenAt}.`,
    "",
    "This follow-up never gates a PR or blocks work. Restore the field at the lane's ledger write site " +
      "(src/lib/benchmark-evidence.ts names what each field reads), or record why this lane legitimately " +
      "lacks it. The evidence-coverage gardener updates this entry in place while the gap persists.",
  ].join("\n");
}

function sourceFollowupRaw(reason: string, firstSeenAt: string): string {
  return [
    `Evidence-coverage gardener (${EVIDENCE_COVERAGE_POLICY_VERSION}) could not read its source: ${reason}.`,
    `First seen: ${firstSeenAt}.`,
    "",
    "While this persists no lane's evidence coverage is being watched. Repair the ledger union read " +
      "(an unreadable rotation is named by `rmd ledger-grep`'s coverage report); this never gates a PR.",
  ].join("\n");
}

/**
 * One pass. Skips until the cadence interval has elapsed since the last pass; reads the trailing
 * window; judges every lane-field against its stored baseline; files or updates at most
 * {@link EVIDENCE_COVERAGE_MAX_FILINGS_PER_PASS} follow-ups; writes the state atomically. Never
 * throws for a filer failure, and returns nothing a gate could read as a verdict.
 */
export function runEvidenceCoverageGardener(deps: EvidenceCoverageInput): EvidenceCoveragePass {
  const clock = deps.clock ?? systemClock;
  const now = clock.now();
  const nowIso = clock.iso();
  const statePath = evidenceCoverageStatePath(deps.stateDir);
  const state = readState(statePath, deps.log);
  const result: EvidenceCoveragePass = { ran: true, gaps: [], insufficient: [], filed: [], updated: [], failed: [], deferred: 0 };
  if (state.lastPassAt && now - Date.parse(state.lastPassAt) < EVIDENCE_COVERAGE_PASS_INTERVAL_MS) {
    return { ...result, ran: false, skipped: "not-due" };
  }
  const discarded = discardSubFloorBaselines(state);
  if (discarded.length > 0) deps.log("evidence_coverage.baseline_discarded", { cells: discarded, reason: "a baseline under its field's floor is a chronic gap, not a healthy reading" });

  let budget = EVIDENCE_COVERAGE_MAX_FILINGS_PER_PASS;
  const fileOnce = (open: OpenGap, digest: string, followup: Omit<EvidenceCoverageFollowup, "action">): void => {
    if (open.filedDigest === digest) return;
    if (budget <= 0) {
      result.deferred += 1;
      return;
    }
    budget -= 1;
    const action = open.filedDigest === undefined ? "file" : "update";
    try {
      deps.file({ ...followup, action });
      open.filedDigest = digest;
      (action === "file" ? result.filed : result.updated).push(followup.id);
      deps.log("evidence_coverage.filed", { id: followup.id, action, lane: followup.lane, field: followup.field });
    } catch (e) {
      const reason = "a failed filing leaves the gap unfiled so the next pass retries it";
      result.failed.push(followup.id);
      deps.log("evidence_coverage.filing_failed", { id: followup.id, lane: followup.lane, field: followup.field, reason, error: String((e as Error)?.message ?? e) });
    }
  };

  let read: EvidenceRowsRead;
  try {
    read = deps.readRows(fixedClock(now - EVIDENCE_COVERAGE_WINDOW_MS).iso());
  } catch (e) {
    const reason = "a thrown source read is the gardener's own failure and is filed as repair work";
    read = { ok: false, reason: `${reason}: ${String((e as Error)?.message ?? e)}` };
  }

  if (!read.ok) {
    const source = state.source?.reason === read.reason ? state.source : { reason: read.reason, kind: "absent" as const, firstSeenAt: nowIso };
    state.source = source;
    result.sourceUnavailable = read.reason;
    deps.log("evidence_coverage.source_unavailable", { reason: read.reason });
    fileOnce(source, read.reason, { id: SOURCE_FOLLOWUP_ID, lane: "*", field: "source", raw: sourceFollowupRaw(read.reason, source.firstSeenAt) });
  } else {
    if (state.source) deps.log("evidence_coverage.source_recovered", { reason: state.source.reason });
    delete state.source;
    const byLane = benchmarkEvidenceByLane(read.rows, nowIso);
    for (const lane of [...byLane.keys()].sort()) {
      const coverage = laneFieldCoverage(byLane.get(lane)!);
      for (const field of EVIDENCE_COVERAGE_FIELDS) {
        const key = `${lane}/${field}`;
        const cell = state.cells[key] ?? {};
        const count = coverage[field];
        const floor = EVIDENCE_COVERAGE_FLOORS[field];
        const verdict = judgeCoverageCell(count, cell.baseline, floor);
        if (verdict.kind === "insufficient") {
          result.insufficient.push({ lane, field, denominator: count.denominator });
          continue;
        }
        if (verdict.kind === "healthy") {
          if (cell.gap) deps.log("evidence_coverage.recovered", { lane, field, first_seen_at: cell.gap.firstSeenAt });
          state.cells[key] = { baseline: verdict.ratio, baselineAt: nowIso };
          continue;
        }
        const open: OpenGap = cell.gap?.kind === verdict.gap ? cell.gap : { kind: verdict.gap, firstSeenAt: cell.gap?.firstSeenAt ?? nowIso, ...(cell.gap?.filedDigest ? { filedDigest: cell.gap.filedDigest } : {}) };
        state.cells[key] = { ...cell, gap: open };
        const gap: EvidenceCoverageGap = { lane, field, kind: open.kind, ...count, floor, firstSeenAt: open.firstSeenAt, ...(cell.baseline !== undefined ? { baseline: cell.baseline } : {}) };
        result.gaps.push(gap);
        // The digest moves on a whole-percent change, not on every new row, so a persisting gap
        // re-lands a handful of times rather than once per pass.
        const digest = `${open.kind}|${open.firstSeenAt}|${Math.round((count.observed / count.denominator) * 100)}`;
        fileOnce(open, digest, { id: evidenceCoverageFollowupId(lane, field), lane, field, raw: gapFollowupRaw(gap) });
      }
    }
  }

  state.lastPassAt = nowIso;
  writeAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
  deps.log("evidence_coverage.pass", {
    gaps: result.gaps.length,
    insufficient: result.insufficient.length,
    filed: result.filed.length,
    updated: result.updated.length,
    failed: result.failed.length,
    deferred: result.deferred,
    source_unavailable: result.sourceUnavailable ?? null,
  });
  return result;
}

/** The production filer: a new gap is captured as a feedback entry under its dedup id; an entry that
 *  already exists is updated in place — its `raw` only, status untouched — through the landing path,
 *  because a local rewrite of a tracked entry is checkout dirt (feedback.ts's `setFeedbackStatus`). */
export function feedbackEvidenceCoverageFiler(root: string, land: LandFeedbackOpts = {}): EvidenceCoverageFiler {
  return (followup) => {
    if (existsSync(feedbackEntryPath(root, followup.id))) {
      const entry = readFeedbackEntry(root, followup.id);
      landFeedbackStatusContent(root, feedbackEntryRepoPath(followup.id), stringifyYaml({ ...entry, raw: followup.raw }), land);
      return;
    }
    captureFeedback(root, { raw: followup.raw, origin: "cli", id: followup.id, land });
  };
}

/** The daemon's deps (src/run-task.ts): the windowed ledger union, refused whole when any file in the
 *  window is unreadable, and feedback filed into the daemon's own checkout. */
export function daemonEvidenceCoverageInput(input: { stateDir: string; root: string; log: EvidenceCoverageInput["log"] }): EvidenceCoverageInput {
  return {
    stateDir: input.stateDir,
    readRows: (sinceTs) => {
      const read = readLedgerUnionRecordsSync(input.stateDir, { sinceTs, step: EVIDENCE_STEPS, refuseIncomplete: true });
      return read.ok ? { ok: true, rows: read.rows } : { ok: false, reason: `ledger union incomplete: ${read.unread.length} unread` };
    },
    file: feedbackEvidenceCoverageFiler(input.root),
    log: input.log,
  };
}

/** Run a pass on its own timer beside the main loop, the `(intervalMs) => {stop}` shape the daemon's
 *  `gardens` list takes. The pass is synchronous, so two never overlap; a thrown pass is logged. */
export function startEvidenceCoverageGardener(
  run: () => EvidenceCoveragePass,
  log: EvidenceCoverageInput["log"],
  intervalMs: number,
): { stop: () => void } {
  const tick = () => {
    try {
      run();
    } catch (e) {
      const reason = "a pass that throws is logged and the next tick tries again";
      log("evidence_coverage.gardener_failed", { reason, error: String((e as Error)?.message ?? e) });
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
