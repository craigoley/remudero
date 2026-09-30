/**
 * lib/workflow-mining.ts — W1-T4668. THE RETRO MINES PROCEDURES FROM LEDGER SIGNALS ONLY.
 *
 * `mineProceduralCandidates` (retro.ts, W1-T87/P13) groups merged runs by a FIXED signal table
 * (`clean_single_strike`, `fully_executed_proof`) and the drafted skill's Procedure section
 * restates the outcome those signals name — "resolve the task on the first attempt" — because
 * the miner never reads what a successful worker actually DID. Worker transcripts already exist:
 * `run-task.ts`'s `buildWorkerStateSensor` ledgers one `worker.activity` row per observed stream
 * event, carrying a real `tool_name` for every `tool-executing` event, per `run_id`, in
 * chronological (append) order — the exact step-by-step trace AWM
 * (https://arxiv.org/abs/2409.07429) and ACE (https://arxiv.org/abs/2510.04618) mine.
 *
 * This module compares the tool-call sequence of first-attempt-success runs against runs that
 * needed a `fix.dispatch` repair, for the SAME task shape, and extracts the steps every clean run
 * took that NO repaired run ever needed — design clause (i). Staging the result as a skill
 * draft's Procedure section is (ii), left to `skill-workshop.ts`. Clause (iii) is enforced HERE:
 * a shape with no step that distinguishes success from repair mines NOTHING for that shape.
 *
 * PURE — no LLM, no I/O (Rule 2: the signal set is DATA, mirroring `mineProceduralCandidates`'s
 * own discipline). Every input type is STRUCTURAL, duplicating the run-task.ts/retro.ts shapes
 * this reads rather than importing them, exactly as `retro-closure.ts` already does one file over
 * — so retro.ts (or any future caller) can hand this a real `RunSummary[]`/`LedgerRecord[]` with
 * zero conversion, and this file introduces no import back onto retro.ts.
 */

/** The run fields this module reads. `RunSummary` (retro.ts) satisfies it structurally. */
export interface TranscriptRun {
  runId: string;
  taskId: string;
  type: string;
  verdict: string;
}

/** The ledger-row fields this module reads. `LedgerRecord` (retro.ts) satisfies it structurally:
 *  its own index signature types every field but `ts`/`run_id`/`task_id`/`step` as `unknown`, so
 *  `event_kind`/`tool_name` are read defensively below rather than assumed to be strings. */
export interface TranscriptLedgerRow {
  run_id?: string;
  step?: string;
  [k: string]: unknown;
}

/** The `step` a real transcript row rides — see `WORKER_ACTIVITY_LEDGER_STEP` (src/run-task.ts).
 *  Duplicated as a literal rather than imported: this module reads the ledger's own wire shape,
 *  not run-task.ts's internals, and run-task.ts sits well above this file in the dependency
 *  graph. */
const WORKER_ACTIVITY_STEP = "worker.activity";

/** One MINED transcript workflow — a reusable step sequence shared by every first-attempt-success
 *  run of a task shape, with the steps repair never needed called out. */
export interface TranscriptWorkflow {
  taskType: string;
  /** The tool-call steps EVERY first-attempt-success run of this shape took, in the order the
   *  first such run took them, deduplicated to each tool's first appearance per run before the
   *  intersection is taken. Never a single run's idiosyncrasy: only what recurs across all of
   *  them survives. */
  steps: string[];
  /** The subset of {@link steps} that no repaired run of the SAME shape ever took — the steps
   *  that actually separate a clean pass from one that needed a `fix.dispatch` rung. Always
   *  non-empty: {@link mineTranscriptWorkflows} mines NOTHING for a shape where this would be
   *  empty (design clause iii). */
  distinguishingSteps: string[];
  /** The first-attempt-success run ids this workflow was distilled from, sorted. */
  runIds: string[];
  taskIds: string[];
  supportingRuns: number;
}

/** Count of `fix.dispatch` ledger lines per `run_id` — mirrors `fixDispatchCountByRun` (retro.ts)
 *  exactly, duplicated rather than imported for the same no-cycle reason the header names. */
function fixDispatchCounts(records: readonly TranscriptLedgerRow[]): Map<string, number> {
  return fixDispatchCountsAttributed(records);
}

/** Fix rounds per implementing run. Since 2026-08-13 the sweep dispatches fix rounds under its OWN run id
 *  (`DAEMON-…`: 2,023 rows, against 35 task-run-keyed ones last seen 2026-09-13), so keying by `run_id` alone
 *  credited every merged run with zero fixes. A row whose `run_id` is not a started run is attributed to the
 *  latest run of its `task_id` that started at or before it. */
export function fixDispatchCountsAttributed(records: readonly TranscriptLedgerRow[]): Map<string, number> {
  const starts = new Map<string, Array<{ runId: string; ts: string }>>();
  const started = new Set<string>();
  for (const r of records) {
    if (r.step !== "run.start" || !r.run_id || typeof r.task_id !== "string" || typeof r.ts !== "string") continue;
    started.add(r.run_id);
    const list = starts.get(r.task_id) ?? [];
    list.push({ runId: r.run_id, ts: r.ts });
    starts.set(r.task_id, list);
  }
  for (const list of starts.values()) list.sort((a, b) => a.ts.localeCompare(b.ts));
  const out = new Map<string, number>();
  for (const r of records) {
    if (r.step !== "fix.dispatch" || !r.run_id) continue;
    let runId: string | undefined = started.has(r.run_id) ? r.run_id : undefined;
    if (!runId && typeof r.task_id === "string" && typeof r.ts === "string") {
      const ts = r.ts;
      runId = (starts.get(r.task_id) ?? []).filter((s) => s.ts <= ts).at(-1)?.runId;
    }
    const key = runId ?? r.run_id;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/**
 * The ordered, de-duplicated tool-call sequence for ONE run: every `tool_name` off a
 * `worker.activity` row whose `event_kind` is `"tool-executing"` for this `run_id`, in ledger
 * (append, i.e. chronological) order, keeping only each tool's FIRST occurrence — a worker
 * calling `Read` five times in a row is one step, not five.
 */
export function toolStepsForRun(records: readonly TranscriptLedgerRow[], runId: string): string[] {
  const steps: string[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    if (r.step !== WORKER_ACTIVITY_STEP || r.run_id !== runId) continue;
    if (r.event_kind !== "tool-executing") continue;
    const name = typeof r.tool_name === "string" ? r.tool_name : undefined;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    steps.push(name);
  }
  return steps;
}

/**
 * MINE merged runs for a per-task-shape workflow: the tool-call steps shared by every
 * first-attempt-success run (zero `fix.dispatch` lines) of that `type`, minus whatever a
 * REPAIRED run of the same `type` (one or more `fix.dispatch` lines) also touched. A shape needs
 * at least `opts.threshold` (default 2, matching `mineProceduralCandidates`'s own floor — one
 * clean run is an anecdote) success runs AND at least one repaired run to compare against: with
 * no repair transcript to compare, nothing distinguishes success FROM it, so nothing is mined
 * for that shape.
 *
 * Pure over the summaries plus raw records: no LLM, no I/O — identical discipline to
 * `mineProceduralCandidates` (retro.ts), one file over.
 */
export function mineTranscriptWorkflows(
  runs: readonly TranscriptRun[],
  records: readonly TranscriptLedgerRow[],
  opts: { threshold?: number } = {},
): TranscriptWorkflow[] {
  const threshold = opts.threshold ?? 2;
  const fixCounts = fixDispatchCounts(records);

  const successByType = new Map<string, TranscriptRun[]>();
  const repairedByType = new Map<string, TranscriptRun[]>();
  for (const r of runs) {
    if (r.verdict !== "merged") continue;
    const count = fixCounts.get(r.runId) ?? 0;
    const bucket = count === 0 ? successByType : repairedByType;
    const arr = bucket.get(r.type) ?? [];
    arr.push(r);
    bucket.set(r.type, arr);
  }

  const out: TranscriptWorkflow[] = [];
  const taskTypes = [...successByType.keys()].sort();
  for (const taskType of taskTypes) {
    const successRuns = successByType.get(taskType) ?? [];
    if (successRuns.length < threshold) continue; // one clean run is an anecdote, not a workflow
    const repairedRuns = repairedByType.get(taskType) ?? [];
    if (repairedRuns.length === 0) continue; // nothing repaired to distinguish success FROM

    const successSequences = successRuns.map((r) => toolStepsForRun(records, r.runId));
    // Steps EVERY success run of this shape took — a tool one run happened to reach for is not
    // "the workflow"; only what recurs across every clean run is.
    const commonSteps = successSequences[0]!.filter((step) => successSequences.every((seq) => seq.includes(step)));

    const repairedToolNames = new Set<string>();
    for (const r of repairedRuns) {
      for (const step of toolStepsForRun(records, r.runId)) repairedToolNames.add(step);
    }

    const distinguishingSteps = commonSteps.filter((step) => !repairedToolNames.has(step));
    if (distinguishingSteps.length === 0) continue; // design clause iii — refuse to stage this shape

    out.push({
      taskType,
      steps: commonSteps,
      distinguishingSteps,
      runIds: [...new Set(successRuns.map((r) => r.runId))].sort(),
      taskIds: [...new Set(successRuns.map((r) => r.taskId))].sort(),
      supportingRuns: successRuns.length,
    });
  }
  return out;
}

/** Render one mined workflow's distinguishing steps as Procedure-section bullet lines, each named
 *  as what it is: a step observed in every first-attempt-success transcript for this shape and
 *  absent from every repaired one — never a bare tool name with no evidentiary claim attached. */
export function renderTranscriptWorkflowSteps(workflow: TranscriptWorkflow): string[] {
  return workflow.distinguishingSteps.map(
    (step) =>
      `- Call \`${step}\` — observed in every first-attempt-success transcript for this shape, absent from every repaired one.`,
  );
}
