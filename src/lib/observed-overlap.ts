/**
 * The live producer for `partitionByFileOverlap`'s `observedByTask` (dispatch-overlap.ts), and the
 * shadow comparison it feeds.
 *
 * WHY. Overlap was judged on declared `files:` alone: nothing produced an observed scope, and a
 * task whose PR is already open is not in the partition at all. On 2026-11-01 the
 * W1-T9794/9795/9796 family (#15656, #15638, #15679) conflicted pairwise on src/run-task.ts and a
 * shared compress test, and #15532 and #15679 went dirty on the same file; each conflict cost a
 * fix round of CI and review. An open PR's changed files are the scope it really holds.
 *
 * COST. No new GitHub read: the open rows are the batch `projectPlan` already fetched each pass,
 * and the file lists come from the gateway's `changedFiles`, which `openSiblingBuild` already asks
 * for every open PR, served by the non-blocking cache keyed on the PR's head
 * (changed-files-cache.ts). An unread list is absent here, never a guess.
 *
 * SHADOW FIRST. {@link observedOverlapShadow} names the candidates the observed scope WOULD hold
 * back; the daemon ledgers them as `dispatch.overlap_shadow` and holds them only when
 * `sweep.observedOverlap.mode` is `enforce` (policy.ts; absent reads `shadow`).
 *
 * FALSIFIER: test/an-open-pr-head-holds-the-files-it-changed.test.ts.
 */
import {
  partitionByFileOverlap,
  type ObservedScope,
  type ObservedScopeByTask,
  type OverlapPartition,
} from "./dispatch-overlap.js";
import type { Task } from "./plan.js";
import { prOwningTaskIds, type PrRef } from "./status.js";

/** The ledger step for the shadow comparison. */
export const OVERLAP_SHADOW_STEP = "dispatch.overlap_shadow";

/** One open PR whose changed files entered a task's observed scope. */
export interface OpenPrScopeSource {
  pr: number;
  headRefOid?: string;
  files: readonly string[];
}

export interface ObservedOpenPrScope {
  observedByTask: ObservedScopeByTask;
  /** Per task, the open PRs its observed scope came from. */
  sourcesByTask: ReadonlyMap<string, readonly OpenPrScopeSource[]>;
  /** Open PRs mapped to a task. */
  openPrsMapped: number;
  /** Mapped open PRs whose file list was not readable this pass. */
  unreadablePrs: number[];
}

/**
 * Builds the observed scope from the open PR rows: each PR maps to its task(s) by
 * {@link prOwningTaskIds}, and the files of its head join that task's scope. `undefined` when the
 * open rows are unreadable, so a failed board read never reads as "no open PR holds anything".
 */
export function observedScopeFromOpenPrs(
  openPrs: readonly PrRef[] | null | undefined,
  changedFiles: (prUrl: string) => readonly string[] | undefined,
): ObservedOpenPrScope | undefined {
  if (!openPrs) return undefined;
  const files = new Map<string, Set<string>>();
  const sources = new Map<string, OpenPrScopeSource[]>();
  const unreadablePrs: number[] = [];
  let openPrsMapped = 0;
  for (const pr of [...openPrs].sort((a, b) => a.number - b.number)) {
    if (pr.state.toUpperCase() !== "OPEN") continue;
    const owners = prOwningTaskIds(pr);
    if (owners.length === 0) continue;
    openPrsMapped++;
    const changed = changedFiles(pr.url);
    if (!changed || changed.length === 0) {
      unreadablePrs.push(pr.number);
      continue;
    }
    for (const task of owners) {
      const set = files.get(task) ?? new Set<string>();
      for (const f of changed) set.add(f);
      files.set(task, set);
      const list = sources.get(task) ?? [];
      list.push({ pr: pr.number, ...(pr.headRefOid ? { headRefOid: pr.headRefOid } : {}), files: [...changed] });
      sources.set(task, list);
    }
  }
  const observedByTask = new Map<string, ObservedScope>([...files].map(([task, set]) => [task, { files: [...set].sort() }]));
  return { observedByTask, sourcesByTask: sources, openPrsMapped, unreadablePrs };
}

/** One candidate the observed scope would hold back that the declared-only partition dispatches. */
export interface OverlapShadowHold {
  task: string;
  blockedBy: string;
  /** The open PR whose changed files caused the hold, or null when the blocker has none. */
  pr: number | null;
  paths: string[];
}

export interface OverlapShadow {
  /** `base.dispatch` less every held candidate: only ever narrower than `base`. */
  dispatch: Task[];
  holds: OverlapShadowHold[];
}

/** A stand-in for a task whose open PR sits outside the pass: it holds exactly its PR's files. */
function openPrHolder(id: string, files: readonly string[]): Task {
  return { id, title: id, repo: "", depends_on: [], type: "implement", verify: "auto", risk: "low", status: "queued", attempts: 0, files: [...files] };
}

/**
 * Re-partitions the pass with every open PR's task placed first, holding its observed files, and
 * names each candidate `base` dispatched that this partition defers. `base` must be the
 * declared-only partition of `[...occupied, ...candidates]` the caller already acts on.
 */
export function observedOverlapShadow(
  candidates: readonly Task[],
  occupied: readonly Task[],
  scope: ObservedOpenPrScope,
  base: OverlapPartition,
): OverlapShadow {
  const inPass = new Set([...occupied, ...candidates].map((t) => t.id));
  const holders = [...scope.observedByTask]
    .filter(([id]) => !inPass.has(id))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, s]) => openPrHolder(id, s.files));
  const shadow = partitionByFileOverlap([...holders, ...occupied, ...candidates], scope.observedByTask);
  const occupiedIds = new Set(occupied.map((t) => t.id));
  const holds: OverlapShadowHold[] = [];
  for (const task of base.dispatch) {
    if (occupiedIds.has(task.id) || shadow.dispatch.some((t) => t.id === task.id)) continue;
    const deferral = shadow.serialized.find((d) => d.task === task.id);
    const blockedBy = deferral?.blockedBy ?? "";
    const paths = deferral?.paths ?? [];
    const pr = (scope.sourcesByTask.get(blockedBy) ?? scope.sourcesByTask.get(task.id) ?? [])
      .find((s) => s.files.some((f) => paths.includes(f)))?.pr ?? null;
    holds.push({ task: task.id, blockedBy, pr, paths });
  }
  const held = new Set(holds.map((h) => h.task));
  return { dispatch: base.dispatch.filter((t) => !held.has(t.id)), holds };
}

/** Paths named per hold in the ledger row; the full count is carried beside them. */
const LEDGER_PATHS_PER_HOLD = 20;

/** The `dispatch.overlap_shadow` payload. `mode` says whether the holds were acted on. */
export function overlapShadowPayload(
  shadow: OverlapShadow,
  scope: ObservedOpenPrScope,
  mode: "shadow" | "enforce",
): Record<string, unknown> {
  return {
    mode,
    acted: mode === "enforce",
    open_prs_mapped: scope.openPrsMapped,
    unreadable_prs: scope.unreadablePrs,
    observed_tasks: scope.observedByTask.size,
    holds: shadow.holds.map((h) => ({
      task: h.task,
      blocked_by: h.blockedBy,
      pr: h.pr,
      paths: h.paths.slice(0, LEDGER_PATHS_PER_HOLD),
      path_count: h.paths.length,
    })),
  };
}
