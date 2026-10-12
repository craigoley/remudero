/**
 * The workstreams view's per-task projection reuse: a task whose inputs cannot have moved since its projection was
 * derived is handed back to `projectPlan` ({@link DeriveDeps.reuseProjection}) instead of re-derived. Each ring insert
 * re-derived all ~3,400 tasks, ~85% of a warm rebuild, while the rows that moved named one (replay, PR description).
 *
 * WHAT MOVES A PROJECTION — each rule fails a test in workstreams-projection-reuse.test.ts when deleted, and the
 * first three are where board.ts's incremental pass alone went stale in replay:
 * - the credit store and override file, which projectPlan reads each pass and which fail soft to empty: their stat
 *   identity, taken BEFORE the read, so a write landing between the two re-derives next pass, never pins a stale one;
 * - rows read whole-ledger whatever task they name: `daemon.boot` and every `plan_only` row (looked up by PR url);
 * - a task's own rows, named in `task_id` OR `task`, as buildLedgerIndex files them;
 * - the plan and gateway objects: threadPlan and snapshotGithub answer one per generation, so identity is it;
 * - the clock: a projection that ages with it, an independent-failure block (its 6 h cooldown), and a lone run.start
 *   the ledger's newest row can settle (orphanedRunIds);
 * - a failed or truncated read: nothing is reused under it, nor after it from it — one gateway recovers in place.
 * TRAP: the view wires no `inflightHolder`; a caller that does makes liveness an input no ledger row records, and must
 * never reuse such a task.
 *
 * Every {@link WORKSTREAMS_REUSE_AUDIT_MS} one build reuses nothing and logs `workstreams.reuse_audit`, comparing
 * what reuse would have answered with what it derived; it then holds the derived ones, so a drift heals in that pass.
 */
import { statSync } from "node:fs";
import { canonicalProjection } from "./board-projection.js";
import { projectionAgesWithTheClock } from "./board.js";
import type { Plan, Task } from "./plan.js";
import { DEFAULT_LIVENESS_BOUND_MS, type GitHub, type StatusProjection } from "./status.js";

/** How often a build derives every task and audits what reuse would have answered. */
export const WORKSTREAMS_REUSE_AUDIT_MS = 10 * 60_000;

type Row = Record<string, unknown>;

export interface ProjectionReuseInputs {
  plan: Plan;
  github: GitHub;
  /** The live rows this pass's projection reads. */
  live: ReadonlyArray<Row>;
  creditStorePath: string;
  creditOverridePath: string;
}

export interface ProjectionReuseAudit {
  compared: number;
  mismatches: number;
  /** Task ids and the fields that differed: never a projection's values. */
  sample: Array<{ taskId: string; fields: string[] }>;
}

export interface ProjectionReusePass {
  reuseProjection: (task: Task) => StatusProjection | undefined;
  /** Holds this pass's projections for the next; returns how many were reused, and the audit when one ran. */
  capture(byId: ReadonlyMap<string, StatusProjection>): { reused: number; derived: number; audit?: ProjectionReuseAudit };
}

/** A file's identity: device, inode, size, mtime, ctime (which a chmod moves) and mode — or the error stat met. */
export function fileIdentity(path: string): string {
  try {
    const st = statSync(path, { bigint: true });
    return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.mode}`;
  } catch (error) {
    // deliberate: the failure IS the identity, never erased — a missing store, a directory and an unreadable one each
    // read as their own value, distinct from every present file's, so a failed read and its recovery both re-derive.
    return `!${(error as NodeJS.ErrnoException).code ?? "unknown"}`;
  }
}

const FNV_OFFSET = 0x811c9dc5;
function fold(hash: number, text: string): number {
  let h = hash;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

interface TaskStamp {
  count: number;
  hash: number;
}
const NO_ROWS: TaskStamp = { count: 0, hash: FNV_OFFSET };

interface Held {
  global: string;
  plan: Plan;
  github: GitHub;
  /** Derived under a failed or truncated read: never handed back, even once the same gateway recovers. */
  dark: boolean;
  newestMs: number;
  byTask: Map<string, { stamp: TaskStamp; projection: StatusProjection }>;
}

interface Stamps {
  global: string;
  byTask: Map<string, TaskStamp>;
  newestMs: number;
  lastRunStartMs: Map<string, number>;
}

/** One walk of the live rows: each task's stamp, the cross-task rows' stamp, the newest row and each task's last run.start. */
function stampsOf(inputs: ProjectionReuseInputs, identity: (path: string) => string): Stamps {
  const credit = identity(inputs.creditStorePath);
  const overrides = identity(inputs.creditOverridePath);
  const byTask = new Map<string, TaskStamp>();
  const lastRunStartMs = new Map<string, number>();
  let crossCount = 0;
  let crossHash = FNV_OFFSET;
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const row of inputs.live) {
    // A row's cheap identity, as board.ts folds it: the ledger is append-only, so step and time name it.
    const id = `${String(row.step ?? "")} ${String(row.ts ?? "")}`;
    const ms = typeof row.ts === "string" ? Date.parse(row.ts) : Number.NaN;
    if (ms > newestMs) newestMs = ms;
    if (row.step === "daemon.boot" || row.plan_only === true) {
      crossCount += 1;
      crossHash = fold(crossHash, id);
    }
    const taskId = typeof row.task_id === "string" ? row.task_id : undefined;
    const task = typeof row.task === "string" && row.task !== taskId ? row.task : undefined;
    for (const named of [taskId, task]) {
      if (named === undefined) continue;
      const stamp = byTask.get(named) ?? { ...NO_ROWS };
      stamp.count += 1;
      stamp.hash = fold(stamp.hash, id);
      byTask.set(named, stamp);
    }
    if (row.step === "run.start" && taskId !== undefined && ms > (lastRunStartMs.get(taskId) ?? Number.NEGATIVE_INFINITY)) lastRunStartMs.set(taskId, ms);
  }
  return { global: [credit, overrides, crossCount, crossHash].join("|"), byTask, newestMs, lastRunStartMs };
}

function differingFields(a: StatusProjection, b: StatusProjection | undefined): string[] {
  const left = a as unknown as Record<string, unknown>;
  const right = (b ?? {}) as Record<string, unknown>;
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((k) => canonicalProjection({ [k]: left[k] } as never) !== canonicalProjection({ [k]: right[k] } as never))
    .sort();
}

/** The reuse one view holds, per instance. `identity` is a seam: production stats the real files. */
export function createWorkstreamsProjectionReuse(opts: { identity?: (path: string) => string } = {}): {
  pass(instance: string, inputs: ProjectionReuseInputs, options?: { audit?: boolean }): ProjectionReusePass;
} {
  const identity = opts.identity ?? fileIdentity;
  const held = new Map<string, Held>();
  return {
    pass(instance, inputs, options = {}) {
      const stamps = stampsOf(inputs, identity);
      const prior = held.get(instance);
      const dark = inputs.github.readFailed?.() === true || inputs.github.readTruncated?.() === true;
      const usable =
        prior !== undefined &&
        !dark &&
        !prior.dark &&
        prior.global === stamps.global &&
        prior.plan === inputs.plan &&
        prior.github === inputs.github &&
        // A live file whose newest row went back was rotated or replaced: nothing held describes it.
        !(stamps.newestMs < prior.newestMs);
      const ledgerMoved = prior !== undefined && stamps.newestMs > prior.newestMs;
      const audit = options.audit === true;
      /** What reuse would have answered, per task, in an audit pass. */
      const candidates = new Map<string, StatusProjection>();
      let reused = 0;
      const reuseProjection = (task: Task): StatusProjection | undefined => {
        const h = usable ? prior!.byTask.get(task.id) : undefined;
        if (h === undefined) return undefined;
        if (projectionAgesWithTheClock(h.projection)) return undefined;
        // The environmental block's 6 h cooldown reads the clock: replayed, a reused block outlived its cooldown.
        if (h.projection.independentFailureBlocked === true) return undefined;
        const stamp = stamps.byTask.get(task.id) ?? NO_ROWS;
        if (stamp.count !== h.stamp.count || stamp.hash !== h.stamp.hash) return undefined;
        // orphanedRunIds measures a lone run.start against the newest row anywhere, so a newer row can settle it.
        if (ledgerMoved && (stamps.lastRunStartMs.get(task.id) ?? Number.NEGATIVE_INFINITY) + DEFAULT_LIVENESS_BOUND_MS > prior!.newestMs) return undefined;
        if (audit) {
          candidates.set(task.id, h.projection);
          return undefined;
        }
        reused += 1;
        return h.projection;
      };
      return {
        reuseProjection,
        capture(byId) {
          let auditResult: ProjectionReuseAudit | undefined;
          if (audit) {
            const sample: ProjectionReuseAudit["sample"] = [];
            let mismatches = 0;
            for (const [taskId, would] of candidates) {
              const derived = byId.get(taskId);
              if (canonicalProjection(would) === canonicalProjection(derived)) continue;
              mismatches += 1;
              if (sample.length < 5) sample.push({ taskId, fields: differingFields(would, derived) });
            }
            auditResult = { compared: candidates.size, mismatches, sample };
          }
          const byTask = new Map<string, { stamp: TaskStamp; projection: StatusProjection }>();
          // Rebuilt, not merged: a task that left the plan leaves the memo with it. A drifted audit holds what it
          // derived, which is already correct, so the heal is this same rebuild.
          for (const task of inputs.plan.tasks) {
            const projection = byId.get(task.id);
            if (projection !== undefined) byTask.set(task.id, { stamp: stamps.byTask.get(task.id) ?? NO_ROWS, projection });
          }
          held.set(instance, { global: stamps.global, plan: inputs.plan, github: inputs.github, dark, newestMs: stamps.newestMs, byTask });
          return { reused, derived: inputs.plan.tasks.length - reused, ...(auditResult ? { audit: auditResult } : {}) };
        },
      };
    },
  };
}
