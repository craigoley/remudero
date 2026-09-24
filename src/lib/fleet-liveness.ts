/**
 * W1-T4418 — A SILENT DAEMON IS NOTICED BY ANOTHER.
 *
 * On 2026-09-23 remudero-console-daemon exited at `loadPlan` every ~2.5 min from 21:14Z to about
 * 00:30Z. Each boot wrote only `cli.invoked` (verb daemon), `daemon.target`, `daemon.paths` and
 * `github_app.token_refreshed`, never a `sweep.summary`, and nothing escalated: every invariant that
 * could have noticed reads the instance's OWN ledger from inside the instance that was down.
 *
 * This module is the outside observer's judgement, pure over rows another process read. It needs
 * the ledgers of every OTHER instance, which only the gateway container mounts, so
 * instance-gateway.ts runs it (see `checkInstanceLiveness`).
 */
import { fixedClock } from "./clock.js";
import { DEFAULT_POLL_INTERVAL_MS } from "./poll-interval.js";
import type { Escalation } from "./escalate.js";
import { readLedgerUnionRecordsSync, realLedgerFs, type LedgerGrepFsDeps } from "./ledger-union.js";
import { RmdError } from "./errors.js";

/** One watched instance: its registry name, `owner/name` repo, and the state dir holding its ledger. */
export interface LivenessInstance {
  name: string;
  repo: string;
  stateDir: string;
}

export type LivenessRow = Record<string, unknown>;

/** Rows at or after `sinceMs` for one instance. Throws when the ledger cannot be read at all. */
export type ReadLastRows = (instance: LivenessInstance, sinceMs: number) => LivenessRow[];

export interface InstanceLiveness {
  instance: string;
  repo: string;
  state: "up" | "down" | "held";
  /** Age of the newest `sweep.summary` in the window; undefined when there is none in it. */
  lastSweepAgeMs?: number;
  /** Distinct daemon processes that booted in the trailing hour. */
  bootsLastHour: number;
  /** Of those, how many booted after the newest heartbeat, so none of them ever ticked. */
  bootsSinceHeartbeat: number;
  pollIntervalMs: number;
  staleBoundMs: number;
  /** The newest ledgered boot-error text in the window, if any. */
  bootError?: string;
  /** Why the instance is DOWN (or HELD); empty when up. */
  reasons: string[];
}

/** The window every row is read over: the trailing hour the boot count is reported against. */
export const LIVENESS_WINDOW_MS = 60 * 60_000;

/**
 * PRIMARY CONTROL. STALE = no heartbeat for this many of the instance's own poll intervals.
 * DERIVED from the three fleet ledgers, 2026-09-17..24, all at `poll_interval_ms` 60 000: the gap
 * between consecutive `sweep.summary` rows had p99 2.9 / 2.3 / 8.2 min and p99.9 8.0 / 4.8 / 19.6
 * min (console / site / core). 30 intervals sits above the worst healthy p99.9 (core's 19.6, whose
 * long passes this must tolerate if the core is ever watched) and still fires 30 min into an
 * outage — the 2026-09-23 one ran 198 min.
 */
export const STALE_HEARTBEAT_POLL_MULTIPLE = 30;

/**
 * PRIMARY CONTROL. DOWN = more than this many boots with no heartbeat between them. DERIVED from
 * the same corpus: the longest healthy run was 4 on console and site and 3 on core, and every
 * longer run was an outage (console 7, 19, 40 and 84 — the last is 2026-09-23). At that crash
 * loop's ~2.5 min cadence this fires about 15 min in, before the stale rule does.
 */
export const MAX_BOOTS_WITHOUT_HEARTBEAT = 5;

/** Only a ledger row a daemon writes by finishing a tick. A paused daemon ticks without sweeping. */
const HEARTBEAT_STEPS = new Set(["sweep.summary", "daemon.pause"]);
/** The ledgered form of a boot failure. The 2026-09-23 PlanError reached stderr only. */
const BOOT_ERROR_STEPS = new Set(["cli.unhandled_rejection"]);
const LIVENESS_ROW = /"step":"(sweep\.summary|daemon\.(start|pause|stop|quota)|cli\.(invoked|unhandled_rejection))"/;

function tsOf(row: LivenessRow): number {
  return typeof row.ts === "string" ? Date.parse(row.ts) : Number.NaN;
}

function isBoot(row: LivenessRow): boolean {
  return row.step === "daemon.start" || (row.step === "cli.invoked" && row.verb === "daemon");
}

/**
 * Boot instants. Every `cli.invoked` daemon row is a boot; a `daemon.start` is the SAME boot when
 * the boot row just before it is that process's `cli.invoked`, and its own boot otherwise. Not keyed
 * on (host, pid) alone: a restarted container keeps its hostname and reuses pid 88.
 */
function bootTimes(rows: readonly LivenessRow[]): number[] {
  const boots = rows.filter((row) => isBoot(row) && !Number.isNaN(tsOf(row))).sort((a, b) => tsOf(a) - tsOf(b));
  const out: number[] = [];
  let previous: LivenessRow | undefined;
  for (const row of boots) {
    const pairsPrevious =
      row.step === "daemon.start" && previous?.step === "cli.invoked" && previous.host === row.host && previous.actor_pid === row.actor_pid;
    if (!pairsPrevious) out.push(tsOf(row));
    previous = pairsPrevious ? undefined : row;
  }
  return out;
}

function newest(rows: readonly LivenessRow[], match: (row: LivenessRow) => boolean): LivenessRow | undefined {
  let best: LivenessRow | undefined;
  for (const row of rows) {
    if (match(row) && !Number.isNaN(tsOf(row)) && (best === undefined || tsOf(row) > tsOf(best))) best = row;
  }
  return best;
}

function minutes(ms: number): string {
  return `${Math.round(ms / 60_000)} min`;
}

/** Judge one instance from its rows in the window. Pure: the caller reads and supplies them. */
export function judgeInstanceLiveness(instance: LivenessInstance, rows: readonly LivenessRow[], nowMs: number): InstanceLiveness {
  const polled = newest(rows, (r) => typeof r.poll_interval_ms === "number" && r.poll_interval_ms > 0);
  const pollIntervalMs = polled ? (polled.poll_interval_ms as number) : DEFAULT_POLL_INTERVAL_MS;
  const staleBoundMs = pollIntervalMs * STALE_HEARTBEAT_POLL_MULTIPLE;
  const sweep = newest(rows, (r) => r.step === "sweep.summary");
  const heartbeat = newest(rows, (r) => HEARTBEAT_STEPS.has(String(r.step)));
  const stop = newest(rows, (r) => r.step === "daemon.stop");
  const bootError = newest(rows, (r) => BOOT_ERROR_STEPS.has(String(r.step)) && typeof r.error === "string");
  const boots = bootTimes(rows);
  const heartbeatMs = heartbeat ? tsOf(heartbeat) : Number.NEGATIVE_INFINITY;
  const result: InstanceLiveness = {
    instance: instance.name,
    repo: instance.repo,
    state: "up",
    ...(sweep ? { lastSweepAgeMs: nowMs - tsOf(sweep) } : {}),
    bootsLastHour: boots.filter((ms) => ms >= nowMs - LIVENESS_WINDOW_MS).length,
    bootsSinceHeartbeat: boots.filter((ms) => ms > heartbeatMs).length,
    pollIntervalMs,
    staleBoundMs,
    ...(bootError ? { bootError: bootError.error as string } : {}),
    reasons: [],
  };
  if (stop && tsOf(stop) > heartbeatMs) {
    // An operator STOP is a deliberate hold, not an outage: say so rather than page about it.
    return { ...result, state: "held", reasons: [`stopped by the operator: ${String(stop.detail ?? "STOP flag")}`] };
  }
  if (heartbeat ? nowMs - heartbeatMs > staleBoundMs : staleBoundMs <= LIVENESS_WINDOW_MS) {
    result.reasons.push(
      heartbeat
        ? `no sweep for ${minutes(nowMs - heartbeatMs)}, past its bound of ${minutes(staleBoundMs)} (${STALE_HEARTBEAT_POLL_MULTIPLE} × its ${minutes(pollIntervalMs)} poll)`
        : `no sweep at all in the trailing ${minutes(LIVENESS_WINDOW_MS)} (bound ${minutes(staleBoundMs)})`,
    );
  }
  if (result.bootsSinceHeartbeat > MAX_BOOTS_WITHOUT_HEARTBEAT) {
    result.reasons.push(`booted ${result.bootsSinceHeartbeat} times with no sweep between (bound ${MAX_BOOTS_WITHOUT_HEARTBEAT})`);
  }
  return result.reasons.length > 0 ? { ...result, state: "down" } : result;
}

/** Every instance's liveness, each from its own rows over the trailing window. */
export function evaluateFleetLiveness(instances: readonly LivenessInstance[], readLastRows: ReadLastRows, nowMs: number): InstanceLiveness[] {
  return instances.map((instance) => judgeInstanceLiveness(instance, readLastRows(instance, nowMs - LIVENESS_WINDOW_MS), nowMs));
}

export class LivenessLedgerUnreadableError extends RmdError {
  constructor(stateDir: string) {
    super("registry", 1, `no ledger is readable under ${stateDir}`, { stateDir });
    this.name = "LivenessLedgerUnreadableError";
  }
}

/**
 * The default reader: the live ledger plus every rotation cut inside the window, through the ledger
 * union (compaction MOVES rows into archives — the 2026-09-23 crash-loop rows sat in one by 02:06Z).
 * A missing live ledger throws rather than reading as "no sweep", which would page about a mount.
 */
export function readLivenessRows(instance: LivenessInstance, sinceMs: number, fsDeps: LedgerGrepFsDeps = realLedgerFs): LivenessRow[] {
  const read = readLedgerUnionRecordsSync(instance.stateDir, { sinceTs: fixedClock(sinceMs).iso(), pattern: LIVENESS_ROW }, fsDeps);
  if (!read.liveFileRead) throw new LivenessLedgerUnreadableError(instance.stateDir);
  return read.rows;
}

/** The ONE needs-human escalation a DOWN instance opens; its summary is stable so dedup holds. */
export function livenessEscalation(down: InstanceLiveness): Escalation {
  const age = down.lastSweepAgeMs === undefined ? `none in the trailing ${minutes(LIVENESS_WINDOW_MS)}` : `${minutes(down.lastSweepAgeMs)} ago`;
  return {
    class: "BLOCKED",
    taskId: `FLEET-${down.instance}`,
    summary: `Fleet instance ${down.instance} is down: its daemon is not sweeping`,
    detail: [
      `The gateway's liveness watch judged instance \`${down.instance}\` (${down.repo}) DOWN: ${down.reasons.join("; ")}.`,
      ``,
      `- last sweep.summary: ${age}`,
      `- daemon boots in the trailing hour: ${down.bootsLastHour} (${down.bootsSinceHeartbeat} with no sweep since)`,
      `- boot error: ${down.bootError ?? "none ledgered — the daemon's stderr (docker logs) holds it"}`,
    ].join("\n"),
    options: [
      { label: "Fix the boot failure", detail: "Read the boot error above or the container's logs, and land the fix on the instance's main." },
      { label: "Stop the instance", detail: "Set its STOP flag if it should stay down; the watch then reads it as held, not down." },
    ],
    recommendation: "Fix the boot failure",
    headDedup: "independent",
    consequence: "The instance merges and reviews nothing until its daemon sweeps again.",
  };
}
