import { fixDispatchCountByRun } from "./retro.js";

/**
 * lib/knowledge-gaps.ts (W1-T4243) — where the learnings corpus is SILENT on the runs that fail.
 *
 * A run whose `learnings.injected` row matched nothing had no knowledge to lean on. Measured by replaying
 * `selectLearnings` over all 2,207 plan records at 50de4b6a, 652 (30%) match zero learnings. Silence alone
 * says little: an area where EVERY run matches nothing is quiet, not blind. So an area is `blind` only when
 * its FAILED runs got nothing clearly more often than its CLEAN runs. Clean is the retro's
 * `clean_single_strike`: merged with zero `fix.dispatch`; every other terminal verdict is failed here.
 *
 * External pattern (research:agent-memory-scan-2026-09-23): Brainfish treats failed searches as the
 * authoring backlog; this is the measured version keyed by outcome. SURFACE, DO NOT ACT — it files nothing
 * (W1-T4014 measured the learning loop producing ~7 proposals a day and releasing 0).
 */

/** The ledger step the knowledge-measurement rung writes and the digest renders. */
export const KNOWLEDGE_MEASURED_STEP = "knowledge.measured";
/** Fewer runs than this in either the clean or the failed group reads `unmeasurable`. */
export const KNOWLEDGE_GAP_FLOOR = 5;
/** A zero-match rate difference (failed minus clean) this large is `blind`; a failed-run rate below it is
 *  `covered`. */
export const KNOWLEDGE_GAP_MARGIN = 0.2;

export type KnowledgeGapVerdict = "blind" | "covered" | "no-association" | "unmeasurable";

export interface KnowledgeGapArea {
  area: string;
  clean: number;
  failed: number;
  silentClean: number;
  silentFailed: number;
  verdict: KnowledgeGapVerdict;
}

export interface KnowledgeGapReport {
  /** Earliest and latest `ts` among the runs that contributed. */
  window?: { from: string; to: string };
  /** Runs with a readable injected row, a terminal verdict, and a task found in the plan. */
  runs: number;
  excludedNoVerdict: number;
  /** Wipe-test arms that saw no learnings by design; counting them as silent would invent a gap. */
  excludedMasked: number;
  /** Injected rows carrying neither `matched_ids` nor `matched`, so silence cannot be read. */
  excludedUnreadable: number;
  /** Runs whose task id is not in the plan. */
  unmapped: number;
  /** Runs whose task declares no files, so no area can be named. */
  noFiles: number;
  areas: KnowledgeGapArea[];
}

/** A file's code area: its first two directories (`src/lib/x.ts` -> `src/lib`), its one directory
 *  (`src/run-task.ts` -> `src`), or the file itself at the root (`package.json`). */
export function knowledgeArea(path: string): string {
  const parts = path.replace(/^\.\//, "").split("/").filter((p) => p.length > 0);
  if (parts.length >= 3) return `${parts[0]}/${parts[1]}`;
  if (parts.length === 2) return parts[0]!;
  return parts[0] ?? path;
}

/** Whether an injected row matched nothing; `undefined` when the row cannot say. */
function silentOf(row: Record<string, unknown>): boolean | undefined {
  const dropped = Array.isArray(row.dropped) ? row.dropped.length : 0;
  if (Array.isArray(row.matched_ids)) return row.matched_ids.length === 0 && dropped === 0;
  if (typeof row.matched === "number") return row.matched === 0 && dropped === 0;
  return undefined;
}

function verdictFor(a: Omit<KnowledgeGapArea, "verdict">, floor: number, margin: number): KnowledgeGapVerdict {
  if (a.clean < floor || a.failed < floor) return "unmeasurable";
  const failedRate = a.silentFailed / a.failed;
  if (failedRate - a.silentClean / a.clean >= margin) return "blind";
  if (failedRate < margin) return "covered";
  return "no-association";
}

/** Fold ledger rows (read through the ledger union by the caller) into a per-area silence report. A run's
 *  outcome is its LAST `verdict` row; its silence is its FIRST `learnings.injected` row. */
export function foldKnowledgeGaps(
  rows: Iterable<Record<string, unknown>>,
  taskFilesById: ReadonlyMap<string, readonly string[]>,
  opts: { floor?: number; margin?: number } = {},
): KnowledgeGapReport {
  const floor = opts.floor ?? KNOWLEDGE_GAP_FLOOR;
  const margin = opts.margin ?? KNOWLEDGE_GAP_MARGIN;
  const all = [...rows];
  const verdictByRun = new Map<string, string>();
  const injectedByRun = new Map<string, Record<string, unknown>>();
  for (const r of all) {
    if (typeof r.run_id !== "string") continue;
    if (r.step === "verdict" && typeof r.verdict === "string") verdictByRun.set(r.run_id, r.verdict);
    if (r.step === "learnings.injected" && !injectedByRun.has(r.run_id)) injectedByRun.set(r.run_id, r);
  }
  const fixes = fixDispatchCountByRun(
    all.flatMap((r) => (r.step === "fix.dispatch" && typeof r.run_id === "string" ? [{ step: r.step, run_id: r.run_id }] : [])),
  );

  const report: KnowledgeGapReport = {
    runs: 0,
    excludedNoVerdict: 0,
    excludedMasked: 0,
    excludedUnreadable: 0,
    unmapped: 0,
    noFiles: 0,
    areas: [],
  };
  const byArea = new Map<string, Omit<KnowledgeGapArea, "verdict">>();
  let from: string | undefined;
  let to: string | undefined;
  for (const [runId, row] of injectedByRun) {
    if (row.masked === true) {
      report.excludedMasked++;
      continue;
    }
    const verdict = verdictByRun.get(runId);
    if (verdict === undefined) {
      report.excludedNoVerdict++;
      continue;
    }
    const silent = silentOf(row);
    if (silent === undefined) {
      report.excludedUnreadable++;
      continue;
    }
    const files = typeof row.task_id === "string" ? taskFilesById.get(row.task_id) : undefined;
    if (files === undefined) {
      report.unmapped++;
      continue;
    }
    const areas = [...new Set(files.map(knowledgeArea))];
    if (areas.length === 0) {
      report.noFiles++;
      continue;
    }
    report.runs++;
    if (typeof row.ts === "string") {
      if (from === undefined || row.ts < from) from = row.ts;
      if (to === undefined || row.ts > to) to = row.ts;
    }
    const clean = verdict === "merged" && (fixes.get(runId) ?? 0) === 0;
    for (const area of areas) {
      const a = byArea.get(area) ?? { area, clean: 0, failed: 0, silentClean: 0, silentFailed: 0 };
      if (clean) {
        a.clean++;
        if (silent) a.silentClean++;
      } else {
        a.failed++;
        if (silent) a.silentFailed++;
      }
      byArea.set(area, a);
    }
  }
  if (from !== undefined && to !== undefined) report.window = { from, to };
  report.areas = [...byArea.values()]
    .map((a) => ({ ...a, verdict: verdictFor(a, floor, margin) }))
    .sort((x, y) => (x.area < y.area ? -1 : x.area > y.area ? 1 : 0));
  return report;
}
