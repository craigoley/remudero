/**
 * lib/remedy-effect.ts — W1-T9060: every merged gardener remedy is measured against its cause, and a remedy whose
 * effect cannot be read is never called resolved.
 *
 * MEASURED 2026-10-13 (gardener loop audit): only ci-friction fed an effect back. The shared ladder
 * (`ladderOf`, flow-blocker and fix-lane) mapped an `unmeasurable` effect to `resolved`, so a remedy with no
 * before-evidence was closed as if it worked; flake-incident and gate measured nothing after merge; and a squash
 * body's `Remudero-Task:` line credited 38 of 1,541 `%(trailers)` lines.
 *
 * One module, three jobs: {@link mergeCredit} (when did the remedy's build land), {@link CauseMetric} (how a family
 * counts its cause in a window) and {@link measureRemedy} (the verdict). `unmeasurable` is a FOURTH verdict that
 * carries a reason; the caller keeps it measuring and, once the after-window is full, escalates it.
 */
import { CI_FRICTION_EFFECT_MAX_WINDOW_MS, judgeShareWindows, parseCiFrictionOrigin, type RemedyEffect, type RemedyRound, type RemedyVerdict, type ShareWindow } from "./ci-friction-remedy.js";

// ── Merge credit ───────────────────────────────────────────────────────────────────────────

/** The task id a `run-<taskId>-<epochMs>` session branch names, or undefined for any other branch. */
export function runBranchTaskId(branch: string): { taskId: string; epochMs: number } | undefined {
  const m = /^(?:refs\/heads\/)?(?:origin\/)?run-([A-Za-z0-9][A-Za-z0-9-]*?)-(\d{10,})$/.exec(branch);
  return m && m[1] !== "unfiled" ? { taskId: m[1]!, epochMs: Number(m[2]) } : undefined;
}

/** The three independent ways a merge is credited to a task id. Any ONE is enough; the earliest wins. */
export interface MergeCreditEvidence {
  /** Ledger rows: `task_id -> ms` of a `verdict.merged` / `pr.terminal merged` row. */
  ledger?: ReadonlyMap<string, number>;
  /** The squash body's `Remudero-Task:` line: `task_id -> ISO commit time`. */
  bodies?: ReadonlyMap<string, string>;
  /** Merged `run-<id>-<epoch>` branches: the branch names, with the time each one merged. */
  branches?: ReadonlyMap<string, number>;
}

/** `task_id -> ms` for every merge the ledger itself recorded. */
export function ledgerMergeTimes(records: readonly { step?: string; task_id?: string; ts?: string; state?: unknown; verdict?: unknown }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of records) {
    const merged = r.step === "verdict.merged" || (r.step === "pr.terminal" && r.state === "merged") || (r.step === "verdict" && r.verdict === "merged");
    const at = Date.parse(r.ts ?? "");
    if (!merged || typeof r.task_id !== "string" || !Number.isFinite(at)) continue;
    out.set(r.task_id, Math.min(at, out.get(r.task_id) ?? Infinity));
  }
  return out;
}

/** When the remedy's build merged: the UNION of ledger credit, the squash body's trailer line and a `run-<id>-<epoch>`
 *  branch. Undefined means NO source credits it, which the caller reads as `no-merge-credit`, never as "not merged yet". */
export function mergeCredit(taskId: string, evidence: MergeCreditEvidence): number | undefined {
  const times: number[] = [];
  const ledger = evidence.ledger?.get(taskId);
  if (ledger !== undefined && Number.isFinite(ledger)) times.push(ledger);
  const body = Date.parse(evidence.bodies?.get(taskId) ?? "");
  if (Number.isFinite(body)) times.push(body);
  for (const [branch, at] of evidence.branches ?? []) if (runBranchTaskId(branch)?.taskId === taskId && Number.isFinite(at)) times.push(at);
  return times.length ? Math.min(...times) : undefined;
}

// ── The metric a family supplies ───────────────────────────────────────────────────────────

/** A family's count of one cause in a window: `k` of the cause, `n` of everything its family counts. */
export type MetricWindow = ShareWindow | { unreadable: string };

export interface CauseMetric {
  /** `ci-friction`, `flow-blocker`, `fix-lane`, `flake-incident`, ... */
  family: string;
  /** The cause key and rung an origin names; undefined means the origin no longer parses (key drift). */
  parseOrigin: (origin: string) => { key: string; rung: number } | undefined;
  /** The cause's count in `[fromMs, toMs)`. `{unreadable}` when the evidence could not be read. */
  window: (key: string, fromMs: number, toMs: number) => MetricWindow;
  /** The nouns a reason line uses: `{noun: "round", share: "share of fix rounds"}`. */
  label: { noun: string; share: string; sampleUnit?: "count" };
}

export type UnmeasurableWhy = "no-merge-credit" | "no-before-evidence" | "metric-unreadable" | "key-drift";

export interface MeasuredRemedy {
  verdict: RemedyVerdict;
  effect: RemedyEffect;
  /** Present exactly when the verdict is `unmeasurable`. */
  why?: UnmeasurableWhy;
  /** The after-window has run its full length: waiting longer cannot add evidence an unmeasurable cause lacks. */
  afterFull: boolean;
  /** The before-window had to be widened beyond the after-window's length to find the cause. */
  widened: boolean;
  /** An unmeasurable remedy whose after-window is full: the caller escalates "effect unverifiable" and never resolves it. */
  escalate: boolean;
}

/** How far back a widened before-window reads, in multiples of the longest measuring window. */
const WIDEN_FACTOR = 3;

const empty = (): ShareWindow => ({ k: 0, n: 0 });

/**
 * The verdict for a merged remedy. `credit` and `debit` are the ones the caller may act on, `pending` keeps measuring,
 * and `unmeasurable{why}` ALSO keeps measuring: it re-reads (widening the credit read upstream, then the before-window
 * here) and, once the after-window is full, escalates. It never resolves and never credits.
 */
export function measureRemedy(task: { id: string; origin: string }, metric: CauseMetric, credit: number | undefined, now: number): MeasuredRemedy {
  const unmeasurable = (why: UnmeasurableWhy, reason: string, before = empty(), after = empty(), windowDays = 0, afterFull = false, widened = false): MeasuredRemedy => ({
    verdict: "unmeasurable", why, afterFull, widened, escalate: afterFull,
    effect: { verdict: "unmeasurable", before, after, windowDays, z: 0, reason: `${why}: ${reason}` },
  });
  if (credit === undefined || !Number.isFinite(credit)) return unmeasurable("no-merge-credit", `${task.id} has no ledger, squash-body or run-branch merge credit`);
  const parsed = metric.parseOrigin(task.origin);
  if (!parsed) return unmeasurable("key-drift", `${task.id} origin "${task.origin}" no longer parses as a ${metric.family} cause`);
  const span = Math.min(Math.max(0, now - credit), CI_FRICTION_EFFECT_MAX_WINDOW_MS);
  const afterFull = now - credit >= CI_FRICTION_EFFECT_MAX_WINDOW_MS;
  const windowDays = Math.round((span / 86_400_000) * 10) / 10;
  const after = metric.window(parsed.key, now - span, now + 1);
  let before = metric.window(parsed.key, credit - span, credit);
  if ("unreadable" in before) return unmeasurable("metric-unreadable", before.unreadable, empty(), empty(), windowDays, afterFull);
  if ("unreadable" in after) return unmeasurable("metric-unreadable", after.unreadable, before, empty(), windowDays, afterFull);
  let widened = false;
  if (before.k === 0 || before.n === 0) {
    const wide = metric.window(parsed.key, credit - WIDEN_FACTOR * CI_FRICTION_EFFECT_MAX_WINDOW_MS, credit);
    if ("unreadable" in wide) return unmeasurable("metric-unreadable", wide.unreadable, before, after, windowDays, afterFull);
    if (wide.k > 0 && wide.n > 0) { before = wide; widened = true; }
  }
  if (before.k === 0 || before.n === 0) {
    const e = judgeShareWindows(before, after, windowDays, parsed.key, metric.label);
    return unmeasurable("no-before-evidence", e.reason, before, after, windowDays, afterFull);
  }
  const effect = judgeShareWindows(before, after, windowDays, parsed.key, metric.label);
  return { verdict: effect.verdict, effect: widened ? { ...effect, reason: `${effect.reason} (before-window widened)` } : effect, afterFull, widened, escalate: false };
}

// ── Metrics ────────────────────────────────────────────────────────────────────────────────

const inWindow = (atMs: number, from: number, to: number): boolean => Number.isFinite(atMs) && atMs >= from && atMs < to;

/** ci-friction: the cause's share of fix rounds. */
export function ciFrictionRoundsMetric(rounds: readonly RemedyRound[]): CauseMetric {
  return {
    family: "ci-friction", label: { noun: "round", share: "share of fix rounds", sampleUnit: "count" },
    parseOrigin: origin => parseCiFrictionOrigin(origin),
    window: (key, from, to) => {
      const w = empty();
      for (const r of rounds) {
        if (!inWindow(r.at === undefined ? NaN : Date.parse(r.at), from, to)) continue;
        w.n += 1;
        if (r.causeKey === key) w.k += 1;
      }
      return w;
    },
  };
}

/** A priced span of PR-hours charged to one cause (a flow or fix-lane episode's charge). */
export interface HoursCharge { key: string; start: number; end: number }

/** flow-blocker and fix-lane: the cause's share of PR-hours, by the overlap of each charge with the window. */
export function prHoursMetric(family: string, prefix: string, charges: readonly HoursCharge[]): CauseMetric {
  const head = `${prefix}:`;
  return {
    family, label: { noun: "PR-hour", share: "share of PR-hours" },
    parseOrigin: origin => {
      const m = origin.startsWith(head) ? /^(.+?)(?:#r(\d+))?$/.exec(origin.slice(head.length)) : null;
      return m ? { key: m[1]!, rung: m[2] === undefined ? 1 : Number(m[2]) } : undefined;
    },
    window: (key, from, to) => {
      const w = empty();
      for (const c of charges) {
        const hours = Math.max(0, Math.min(c.end, to) - Math.max(c.start, from)) / 3_600_000;
        w.n += hours;
        if (c.key === key) w.k += hours;
      }
      return w;
    },
  };
}

/** One ledger row the flake metric reads: a `test.flake_retry` for a file on PRs, or a PR that reached a terminal state. */
export interface FlakeLedgerRow { step?: string; ts?: string; file?: unknown; pr_numbers?: unknown; pr_number?: unknown }

/**
 * flake-incident: the share of PRs that reached CI in the window which a flake on the remedy's FILE failed. A PR that
 * touches the file is not an unrelated failure, so `touchesFile` drops it. The denominator is every PR the ledger saw
 * finish (`pr.terminal`) or flake in the window, so a file that STOPS failing reads as a fall, not as an empty window.
 */
export function flakeIncidentMetric(rows: readonly FlakeLedgerRow[], touchesFile: (pr: number, file: string) => boolean = () => false): CauseMetric {
  const prs = (v: unknown): number[] => (Array.isArray(v) ? v : [v]).filter((n): n is number => Number.isSafeInteger(n) && (n as number) > 0);
  return {
    family: "flake-incident", label: { noun: "PR", share: "share of PRs failed by the file", sampleUnit: "count" },
    parseOrigin: origin => {
      if (!origin.startsWith("flake-incident:")) return undefined;
      const file = origin.slice("flake-incident:".length).split("#")[0]!;
      return file ? { key: file, rung: 1 } : undefined;
    },
    window: (file, from, to) => {
      const hit = new Set<number>(), all = new Set<number>();
      for (const r of rows) {
        if (!inWindow(Date.parse(r.ts ?? ""), from, to)) continue;
        if (r.step === "test.flake_retry") {
          for (const pr of prs(r.pr_numbers)) {
            all.add(pr);
            if (r.file === file && !touchesFile(pr, file)) hit.add(pr);
          }
        } else if (r.step === "pr.terminal") for (const pr of prs(r.pr_number)) all.add(pr);
      }
      return { k: hit.size, n: all.size };
    },
  };
}
