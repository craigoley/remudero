/**
 * lib/procedure-census.ts — which tool-call steps clean runs repeat, per task type, and how that differs from repaired
 * runs. A READ-ONLY measurement for `rmd procedures`: it compiles nothing and changes no runtime behavior.
 *
 * Since 2026-10-13 every `worker.activity` row of a tool call carries `tool_signature` (tool-step-signature.ts):
 * `Bash:<program> [<subcommand>]`, `<FileTool>:<repo-relative path>` or `<outside>`, or the bare tool name. The
 * transcript miner (workflow-mining.ts) reads only the bare `tool_name`, which every run shares, so it can almost
 * never name a step that separates a first-attempt success from a repaired run. This census reads the signature,
 * coarsened so one file is not one step, and reports shares rather than an all-or-nothing intersection.
 *
 * A census over rows that carry no signature would read as "nothing recurs". {@link ProcedureCensus.signatureCoverage}
 * is the control that says which of the two it is.
 *
 * PURE: no I/O and no clock reads. Every input type is structural, as in workflow-mining.ts, so retro.ts's
 * `RunSummary[]` and `LedgerRecord[]` pass with no conversion.
 */
import { fixDispatchCountsAttributed, type TranscriptLedgerRow, type TranscriptRun } from "./workflow-mining.js";

/** The `step` a worker's tool-call rows ride (`WORKER_ACTIVITY_LEDGER_STEP`, src/run-task.ts), duplicated as
 *  workflow-mining.ts duplicates it: this module reads the ledger's wire shape, not run-task.ts. */
const WORKER_ACTIVITY_STEP = "worker.activity";
const TOOL_EXECUTING = "tool-executing";

/** A file-tool signature's path when it names no file to coarsen. */
const VERBATIM_PATHS: ReadonlySet<string> = new Set(["<outside>", "."]);

/** How many directory segments a nested path keeps. */
const KEPT_DIRECTORIES = 2;

export const PROCEDURE_CENSUS_DEFAULTS = {
  /** A step is universal for a task type when at least this share of its clean runs took it... */
  universalMinShare: 0.8,
  /** ...and only once the type has at least this many clean runs: four runs are an anecdote. */
  universalMinCleanRuns: 5,
  /** A contiguous sequence is reported when at least this share of clean runs contains it. */
  sequenceMinShare: 0.5,
  sequenceLimit: 10,
  liftLimit: 10,
} as const;

/** One step's spread across a task type's merged runs. */
export interface ProcedureStepShare {
  step: string;
  /** Fraction of the type's clean runs that took this step. */
  cleanShare: number;
  /** Fraction of the type's repaired runs that took it; null when the type has no repaired run. */
  repairedShare: number | null;
  /** `cleanShare - repairedShare`; null when the type has no repaired run. */
  lift: number | null;
}

/** A contiguous run of 2 or 3 steps and the share of clean runs whose step list contains it. */
export interface ProcedureSequence {
  steps: string[];
  share: number;
}

export interface ProcedureTypeCensus {
  taskType: string;
  /** Merged runs with zero fix rounds. */
  cleanRuns: number;
  /** Merged runs with one or more fix rounds. */
  repairedRuns: number;
  /** Every step seen in a clean run: highest clean share first, then by name. */
  steps: ProcedureStepShare[];
  /** Steps at or above the universal share, empty below the clean-run floor. */
  universal: string[];
  sequences: ProcedureSequence[];
}

export interface ProcedureCensus {
  /** The CONTROL: every tool-call row of the merged runs, and how many carry a `tool_signature`. */
  signatureCoverage: { toolRows: number; withSignature: number };
  mergedRuns: number;
  thresholds: { universalMinShare: number; universalMinCleanRuns: number; sequenceMinShare: number };
  taskTypes: ProcedureTypeCensus[];
}

/**
 * One tool-call signature as a census step. Bash signatures and bare tool names pass through. A file-tool signature
 * keeps a top-level path, `<outside>` and `.` verbatim; a nested path keeps its first two directories and the file's
 * full extension (from the basename's first `.`), with the basename replaced by `*`:
 * `Read:src/lib/review.ts` → `Read:src/lib/*.ts`, `Edit:test/ci/x.test.ts` → `Edit:test/ci/*.test.ts`.
 */
export function normalizeProcedureStep(raw: string): string {
  const colon = raw.indexOf(":");
  if (colon < 0 || raw.startsWith("Bash:")) return raw;
  const tool = raw.slice(0, colon);
  const path = raw.slice(colon + 1);
  const segments = path.split("/");
  if (VERBATIM_PATHS.has(path) || segments.length === 1) return raw;
  const base = segments[segments.length - 1]!;
  const dot = base.indexOf(".");
  const extension = dot < 0 ? "" : base.slice(dot);
  return `${tool}:${segments.slice(0, Math.min(KEPT_DIRECTORIES, segments.length - 1)).join("/")}/*${extension}`;
}

const isToolCall = (r: TranscriptLedgerRow): boolean => r.step === WORKER_ACTIVITY_STEP && r.event_kind === TOOL_EXECUTING;

/**
 * The ordered census steps of ONE run: each `tool-executing` `worker.activity` row of `runId`, in ledger order, as
 * {@link normalizeProcedureStep} of its `tool_signature`, or its bare `tool_name` when the row carries no signature
 * (every row before 2026-10-13). Each step's first occurrence only.
 */
export function procedureStepsForRun(records: readonly TranscriptLedgerRow[], runId: string): string[] {
  const steps: string[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    if (r.run_id !== runId || !isToolCall(r)) continue;
    const signature = typeof r.tool_signature === "string" && r.tool_signature.length > 0 ? r.tool_signature : undefined;
    const step = signature !== undefined ? normalizeProcedureStep(signature) : typeof r.tool_name === "string" ? r.tool_name : "";
    if (step === "" || seen.has(step)) continue;
    seen.add(step);
    steps.push(step);
  }
  return steps;
}

const share = (count: number, of: number): number => Math.round((count / of) * 10000) / 10000;
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const SEQUENCE_SEPARATOR = "\u0000";

/** How many of `lists` contain each key that `keysOf` yields for a list, each list counted once per key. */
function presence(lists: readonly string[][], keysOf: (list: string[]) => string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const list of lists) {
    for (const key of new Set(keysOf(list))) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Every contiguous window of 2 and 3 steps, joined by {@link SEQUENCE_SEPARATOR}. */
function windows(list: string[]): string[] {
  const out: string[] = [];
  for (const size of [2, 3]) {
    for (let i = 0; i + size <= list.length; i++) out.push(list.slice(i, i + size).join(SEQUENCE_SEPARATOR));
  }
  return out;
}

/**
 * The census over `runs` and the ledger `records` they came from. Only merged runs count. Each task type splits into
 * CLEAN (zero fix rounds) and REPAIRED (one or more), by {@link fixDispatchCountsAttributed} — the retro's own
 * attribution, which credits a daemon-run fix round to the task's latest started run.
 */
export function buildProcedureCensus(
  runs: readonly TranscriptRun[],
  records: readonly TranscriptLedgerRow[],
  opts: { universalMinShare?: number; universalMinCleanRuns?: number } = {},
): ProcedureCensus {
  const universalMinShare = opts.universalMinShare ?? PROCEDURE_CENSUS_DEFAULTS.universalMinShare;
  const universalMinCleanRuns = opts.universalMinCleanRuns ?? PROCEDURE_CENSUS_DEFAULTS.universalMinCleanRuns;
  const { sequenceMinShare, sequenceLimit } = PROCEDURE_CENSUS_DEFAULTS;
  const merged = runs.filter((r) => r.verdict === "merged");
  const mergedIds = new Set(merged.map((r) => r.runId));

  // One pass groups the tool-call rows by run, so each run's steps cost its own rows, not the whole ledger.
  const toolRowsByRun = new Map<string, TranscriptLedgerRow[]>();
  const signatureCoverage = { toolRows: 0, withSignature: 0 };
  for (const r of records) {
    if (!isToolCall(r) || r.run_id === undefined || !mergedIds.has(r.run_id)) continue;
    signatureCoverage.toolRows += 1;
    if (typeof r.tool_signature === "string" && r.tool_signature.length > 0) signatureCoverage.withSignature += 1;
    const rows = toolRowsByRun.get(r.run_id) ?? [];
    rows.push(r);
    toolRowsByRun.set(r.run_id, rows);
  }

  const fixCounts = fixDispatchCountsAttributed(records);
  const byType = new Map<string, { clean: string[][]; repaired: string[][] }>();
  for (const r of merged) {
    const group = byType.get(r.type) ?? { clean: [], repaired: [] };
    const steps = procedureStepsForRun(toolRowsByRun.get(r.runId) ?? [], r.runId);
    ((fixCounts.get(r.runId) ?? 0) === 0 ? group.clean : group.repaired).push(steps);
    byType.set(r.type, group);
  }

  const taskTypes: ProcedureTypeCensus[] = [...byType.keys()].sort(byName).map((taskType) => {
    const { clean, repaired } = byType.get(taskType)!;
    const inClean = presence(clean, (list) => list);
    const inRepaired = presence(repaired, (list) => list);
    const steps: ProcedureStepShare[] = [...inClean.entries()]
      .sort(([a, x], [b, y]) => y - x || byName(a, b))
      .map(([step, count]) => {
        const cleanShare = share(count, clean.length);
        const repairedShare = repaired.length === 0 ? null : share(inRepaired.get(step) ?? 0, repaired.length);
        return { step, cleanShare, repairedShare,
          lift: repairedShare === null ? null : Math.round((cleanShare - repairedShare) * 10000) / 10000 };
      });
    const universal = clean.length < universalMinCleanRuns ? []
      : steps.filter((s) => (inClean.get(s.step) ?? 0) / clean.length >= universalMinShare).map((s) => s.step);
    const sequences = [...presence(clean, windows).entries()]
      .filter(([, count]) => count / clean.length >= sequenceMinShare)
      .map(([key, count]) => ({ key, count, steps: key.split(SEQUENCE_SEPARATOR) }))
      .sort((a, b) => b.count - a.count || b.steps.length - a.steps.length || byName(a.key, b.key))
      .slice(0, sequenceLimit)
      .map(({ steps: seq, count }) => ({ steps: seq, share: share(count, clean.length) }));
    return { taskType, cleanRuns: clean.length, repairedRuns: repaired.length, steps, universal, sequences };
  });

  return { signatureCoverage, mergedRuns: merged.length,
    thresholds: { universalMinShare, universalMinCleanRuns, sequenceMinShare }, taskTypes };
}

const percent = (value: number): string => `${Math.round(value * 100)}%`;
const code = (step: string): string => `\`${step}\``;

/** The census as plain markdown for an operator: the window, the signature-coverage control FIRST, then each task
 *  type's run counts, universal steps, highest positive lifts and top sequences. */
export function renderProcedureCensus(census: ProcedureCensus, window: { sinceTs: string; untilTs: string }): string {
  const { toolRows, withSignature } = census.signatureCoverage;
  const { universalMinShare, universalMinCleanRuns, sequenceMinShare } = census.thresholds;
  const lines = [
    "# Procedure census",
    "",
    `Window: ${window.sinceTs} to ${window.untilTs}. Merged runs: ${census.mergedRuns}.`,
    "",
    "## Signature coverage (control)",
    "",
    `- ${withSignature} of ${toolRows} tool-call rows carry a tool_signature` +
      (toolRows > 0 ? ` (${percent(withSignature / toolRows)}).` : "."),
  ];
  if (withSignature === 0) {
    lines.push("- WARNING: no tool-call row in this window carries a tool_signature, so every step below is a bare tool " +
      "name. An empty or uniform census here means the signatures are missing, not that nothing recurs.");
  }
  for (const t of census.taskTypes) {
    lines.push("", `## ${t.taskType}`, "", `- Clean runs (zero fix rounds): ${t.cleanRuns}. Repaired runs: ${t.repairedRuns}.`);
    lines.push("", `Universal steps (in at least ${percent(universalMinShare)} of clean runs, from ${universalMinCleanRuns} clean runs):`);
    if (t.cleanRuns < universalMinCleanRuns) lines.push(`- none: ${t.cleanRuns} clean run(s) is below the floor of ${universalMinCleanRuns}.`);
    else if (t.universal.length === 0) lines.push("- none.");
    else for (const step of t.universal) lines.push(`- ${code(step)}`);

    lines.push("", "Highest positive lift (clean share minus repaired share):");
    const lifted = t.steps
      .filter((s): s is ProcedureStepShare & { lift: number; repairedShare: number } => s.lift !== null && s.lift > 0)
      .sort((a, b) => b.lift - a.lift || byName(a.step, b.step))
      .slice(0, PROCEDURE_CENSUS_DEFAULTS.liftLimit);
    if (t.repairedRuns === 0) lines.push("- none: no repaired run to compare against.");
    else if (lifted.length === 0) lines.push("- none: no step is more common in clean runs than in repaired ones.");
    else {
      for (const s of lifted) {
        lines.push(`- ${code(s.step)}: +${s.lift.toFixed(2)} (clean ${percent(s.cleanShare)}, repaired ${percent(s.repairedShare)})`);
      }
    }

    lines.push("", `Top sequences (contiguous, in at least ${percent(sequenceMinShare)} of clean runs):`);
    if (t.sequences.length === 0) lines.push("- none.");
    else for (const s of t.sequences) lines.push(`- ${s.steps.map(code).join(" → ")}: ${percent(s.share)}`);
  }
  return lines.join("\n");
}
