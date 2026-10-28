import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixedClock } from "./clock.js";
import { writeAtomic } from "./fs-race-safe.js";
import { appendLedger, type LedgerLine } from "./ledger.js";
import { LEDGER_FILENAME } from "./ledger-path.js";
import { createLedgerRotationMemo, readLedgerUnionRecordsMemoized } from "./ledger-union.js";
import { ownHistoryBound } from "./fleet-flow-detectors.js";
import { infrastructureRefusal, PROOF_COLLECTED_NOTHING, PROOF_INCONCLUSIVE, streakRefusal } from "./non-worker-verdict.js";
import type {
  FleetFlowDetector,
  FleetFlowFinding,
  FleetFlowInput,
  FleetFlowPolicy,
  FleetFlowRow,
} from "./fleet-flow-detectors.js";

/**
 * W1-T8240: a task interrupted only by the harness is an incident.
 *
 * MEASURED 2026-10-11: W1-T7742 was breaker-blocked on yields, a claim race, a refused checkpoint push and
 * node_modules refusals; W1-T7837 sat handed off for 10.7 h while 66 other builds started; W1-T7952 was passed over
 * 31 times. The ledger held every signal and a person found each one.
 *
 * No fixed threshold. Two signals, each judged against the fleet's own history with `ownHistoryBound`:
 *   - STRANDED: time since the first start of the task's current episode with no `pr.opened` or merge, while every
 *     terminal verdict since then is non-worker. Bound: the p90 of start-to-PR spans of tasks that reached a PR.
 *   - PASSED OVER: fresh implement starts of equal-or-lower-priority tasks while the task was resumable (its last
 *     verdict a handoff or yield) or its breaker was tripped. Bound: the p90 pass-over count of resumable tasks that
 *     did resume.
 * A task with any attributable worker failure is out of scope: the breaker and the lifetime judge own that case.
 *
 * The bound is computed from the ledger rows the detector is handed, not from a learned store: the population (PR
 * spans, resume gaps) is observable in the ledger itself, and a polled live episode must never teach its own bound.
 */

export const STRANDED_TASK_DETECTOR_ID = "stranded-task";
export const STRANDED_TASK_FINDING = "stranded-task";
export const STRANDED_SPAN_POPULATION = "stranded-span";
export const PASSED_OVER_POPULATION = "pass-over";

const MS_PER_MINUTE = 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** PRIMARY CONTROL: how much ledger the bounds are learned from, and how many samples they need. */
export const STRANDED_TASK_POLICY: FleetFlowPolicy = {
  minSamples: 5,
  maxSamples: 288,
  longMs: 7 * DAY_MS,
};

/** Every ledger step this detector reads. */
export const STRANDED_TASK_INPUTS = [
  "run.start",
  "verdict",
  "pr.opened",
  "verdict.merged",
  "dispatch.circuit_broken",
  "dispatch.breaker_released",
  "dispatch.lifetime_pressure.infra_only",
  "worker_orphan_killed",
] as const;

/** The non-worker classes a terminal verdict can fall in; `undefined` is a worker-attributable outcome. */
export function nonWorkerVerdictClass(row: Record<string, unknown>): string | undefined {
  const reason = typeof row.reason === "string" ? row.reason : undefined;
  if (row.verdict === "handed_off") {
    return reason === "freshness_yield" || reason === "recycle_yield" ? "yield" : "handoff";
  }
  if (row.verdict === "no_pr" && (reason === "restart_checkpoint_failed" || reason === "restart_checkpoint_restore_failed")) {
    return "restart_checkpoint";
  }
  if (row.verdict === "blocked_inflight") return "claim_race";
  if (row.verdict === "failed" && row.stage === "worker.bounded_output") return "output_budget";
  if (row.verdict === "failed" && row.stage === "worktree.node_modules") return "node_modules";
  const refusal = infrastructureRefusal(row) ?? streakRefusal(row);
  if (refusal === undefined || refusal === "task_already_merged") return undefined;
  if (refusal === PROOF_INCONCLUSIVE) return PROOF_INCONCLUSIVE; // W1-T10742: the harness's, not a toolchain fault
  if (refusal === PROOF_COLLECTED_NOTHING) return PROOF_COLLECTED_NOTHING; // W1-T10919: the runner's scope, likewise
  return refusal === "blocked_git_fetch" ? "git_fetch" : "toolchain";
}

function rowMs(row: FleetFlowRow): number {
  if (typeof row.at_ms === "number" && Number.isFinite(row.at_ms)) return row.at_ms;
  return typeof row.ts === "string" ? Date.parse(row.ts) : NaN;
}

function taskOf(row: FleetFlowRow): string | undefined {
  const id = row.step === "dispatch.circuit_broken" ? row.task : row.task_id;
  return typeof id === "string" && id !== "" && id !== "INCIDENT" ? id : undefined;
}

interface Episode {
  startMs: number;
  causes: Map<string, number>;
  worker: boolean;
  breaker: boolean;
  /** When the task last became resumable (a handoff or yield verdict, or a breaker trip); cleared by a new start. */
  resumableSinceMs: number | undefined;
}

export interface StrandedTaskOptions {
  /** A task's plan priority (lower dispatches sooner); undefined when unknown, which counts as comparable. */
  priorityOf?: (taskId: string) => number | undefined;
}

/** A value for a runbook's `key=value` subject: whitespace-free, so `\S+` reads all of it. */
function token(value: string): string {
  const cleaned = value.trim().replace(/\s+/g, "_");
  return cleaned.length === 0 ? "unnamed" : cleaned;
}

export function strandedTaskDetector(options: StrandedTaskOptions = {}): FleetFlowDetector {
  const policy = STRANDED_TASK_POLICY;
  return {
    id: STRANDED_TASK_DETECTOR_ID,
    inputs: STRANDED_TASK_INPUTS,
    policy,
    evaluate(rows, nowMs): readonly FleetFlowFinding[] {
      const timeline = rows.filter((r) => Number.isFinite(rowMs(r)) && rowMs(r) <= nowMs)
        .sort((a, b) => rowMs(a) - rowMs(b));
      const open = new Map<string, Episode>();
      const spans: number[] = [];
      const gaps: number[] = [];
      const fresh: { ms: number; task: string }[] = [];
      const priorityOf = options.priorityOf ?? (() => undefined);
      // Fresh implement starts by OTHER tasks of equal or lower priority (a higher number) in (fromMs, toMs].
      const passedOver = (task: string, fromMs: number, toMs: number): number => {
        const mine = priorityOf(task);
        return fresh.filter((s) => s.task !== task && s.ms > fromMs && s.ms <= toMs &&
          (mine === undefined || (priorityOf(s.task) ?? Number.POSITIVE_INFINITY) >= mine)).length;
      };
      for (const row of timeline) {
        const task = taskOf(row);
        if (task === undefined) continue;
        const ms = rowMs(row);
        const episode = open.get(task);
        switch (row.step) {
          case "run.start": {
            if (row.type !== "implement") break;
            if (!episode) {
              fresh.push({ ms, task });
              open.set(task, { startMs: ms, causes: new Map(), worker: false, breaker: false, resumableSinceMs: undefined });
            } else if (episode.resumableSinceMs !== undefined && !episode.worker) {
              gaps.push(passedOver(task, episode.resumableSinceMs, ms));
              episode.resumableSinceMs = undefined;
            }
            break;
          }
          case "pr.opened":
            if (episode) spans.push((ms - episode.startMs) / MS_PER_MINUTE);
            open.delete(task);
            break;
          case "verdict.merged":
          case "dispatch.breaker_released":
            open.delete(task);
            break;
          case "dispatch.circuit_broken":
            if (episode) {
              episode.breaker = true;
              episode.resumableSinceMs ??= ms;
            }
            break;
          case "dispatch.lifetime_pressure.infra_only":
            episode?.causes.set("lifetime_infra_only", (episode.causes.get("lifetime_infra_only") ?? 0) + 1);
            break;
          case "worker_orphan_killed":
            episode?.causes.set("orphaned", (episode.causes.get("orphaned") ?? 0) + 1);
            break;
          case "verdict": {
            if (row.verdict === "merged" || row.verdict === "task_already_merged") {
              open.delete(task);
              break;
            }
            if (!episode) break;
            const cause = nonWorkerVerdictClass(row);
            if (cause === undefined) {
              episode.worker = true;
              break;
            }
            episode.causes.set(cause, (episode.causes.get(cause) ?? 0) + 1);
            if (cause === "yield" || cause === "handoff") episode.resumableSinceMs ??= ms;
            break;
          }
          default:
            break;
        }
      }

      const strandedBound = ownHistoryBound(spans, policy);
      const passBound = ownHistoryBound(gaps, policy);
      const out: FleetFlowFinding[] = [];
      for (const [task, episode] of open) {
        if (episode.worker || episode.causes.size === 0) continue;
        const minutes = (nowMs - episode.startMs) / MS_PER_MINUTE;
        const passes = episode.resumableSinceMs === undefined ? 0 : passedOver(task, episode.resumableSinceMs, nowMs);
        const strandedFires = strandedBound !== undefined && minutes > strandedBound;
        const passFires = passBound !== undefined && passes > passBound;
        if (!strandedFires && !passFires) continue;
        const causes = [...episode.causes].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k}:${n}`).join(",");
        const since = fixedClock(episode.startMs).iso();
        const subject = `task=${token(task)} since=${since} causes=${causes} breaker=${episode.breaker ? "tripped" : "clear"} ` +
          `passed_over=${passes}`;
        const measured = Math.round((strandedFires ? minutes : passes) * 100) / 100;
        out.push({
          name: STRANDED_TASK_FINDING,
          subject,
          measured,
          bound: strandedFires ? strandedBound : passBound,
          population: strandedFires ? STRANDED_SPAN_POPULATION : PASSED_OVER_POPULATION,
          message: `${subject} stranded_minutes=${Math.round(minutes * 100) / 100} ` +
            `stranded_bound=${strandedBound ?? "none"} pass_over_bound=${passBound ?? "none"} — ` +
            "no worker failure, interrupted only by the harness, beyond the fleet's own history",
        });
      }
      return out;
    },
  };
}

interface StrandedMemory {
  emitted: { key: string; ts: number }[];
}

const strandedReaders = new Map<string, ReturnType<typeof createLedgerRotationMemo>>();

function memoryPath(stateDir: string): string {
  return join(stateDir, "stranded-task-detector.json");
}

function readMemory(path: string): StrandedMemory {
  if (!existsSync(path)) return { emitted: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as StrandedMemory;
  if (!parsed || !Array.isArray(parsed.emitted)) throw new Error(`Invalid stranded-task memory: ${path}`);
  return parsed;
}

/**
 * Judge the stranded-task detector and write one `incident.event` per newly stranded episode. It keeps its own
 * dedupe memory beside, not inside, the shared fleet-flow store: that store is rewritten whole by the shared
 * evaluator each pass, and a detector whose bound comes from the ledger has no learned history to lose.
 */
export async function evaluateStrandedTaskDetectors(input: FleetFlowInput): Promise<LedgerLine[]> {
  const detector = input.detectors.find((d) => d.id === STRANDED_TASK_DETECTOR_ID);
  if (!detector) return [];
  const policy = detector.policy;
  const sinceMs = input.nowMs - policy.longMs;
  let rows: readonly FleetFlowRow[];
  if (input.readRows) rows = await input.readRows(sinceMs, input.nowMs);
  else {
    const inputs = [...detector.inputs];
    const key = JSON.stringify([input.stateDir, inputs]);
    let memo = strandedReaders.get(key);
    if (!memo) {
      const pattern = new RegExp(`"step"\\s*:\\s*"(?:${inputs.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})"`);
      memo = createLedgerRotationMemo((records) => records.filter((r) => typeof r.step === "string" && inputs.includes(r.step)), { pattern });
      strandedReaders.set(key, memo);
    }
    const result = await readLedgerUnionRecordsMemoized(input.stateDir, memo, {
      since: fixedClock(sinceMs).iso(), rotationWindowMs: policy.longMs, step: inputs, refuseIncomplete: true,
    });
    if (!result.ok) throw new Error(`Stranded-task ledger unreadable: ${result.unread.join(", ")}`);
    rows = result.rows;
  }
  const findings = detector.evaluate(rows, input.nowMs, []);
  const path = memoryPath(input.stateDir);
  const memory = readMemory(path);
  const quietMs = policy.longMs / 12;
  const emitted = memory.emitted.filter((e) => e.ts > input.nowMs - quietMs && e.ts <= input.nowMs);
  const events: LedgerLine[] = [];
  for (const finding of findings) {
    // One incident per task episode: the subject's counts grow every pass, its task and start do not.
    const identity = finding.subject.split(/\s+/).slice(0, 2).join(" ");
    if (emitted.some((e) => e.key === identity)) continue;
    const event: LedgerLine = {
      run_id: `FLOW-${input.nowMs}-${detector.id}`, task_id: "INCIDENT", step: "incident.event",
      source: "sre-lane", kind: "flow", name: finding.name,
      fingerprint: createHash("sha256").update(`flow\u0000${finding.name}\u0000${identity}`, "utf8").digest("hex"),
      subject: finding.subject, population: finding.population, measured: finding.measured, bound: finding.bound,
      message: finding.message,
    };
    if (input.writeEvent) input.writeEvent(event);
    else appendLedger(join(input.stateDir, LEDGER_FILENAME), event, { clock: fixedClock(input.nowMs) });
    events.push(event);
    emitted.push({ key: identity, ts: input.nowMs });
  }
  writeAtomic(path, JSON.stringify({ emitted }) + "\n");
  return events;
}
