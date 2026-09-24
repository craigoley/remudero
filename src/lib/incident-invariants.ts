import type { EventLoopLag } from "./daemon-health.js";
import type { LedgerLine } from "./ledger.js";

/**
 * lib/incident-invariants.ts — W1-T4384, the SRE gardener's phase 2.
 *
 * THE WORST FAILURES THROW NOTHING. On 2026-09-23 the fleet built nothing for hours
 * (`dispatch.settled_set` fulfilled 0 while priority-1 work sat queued), the gateway's first
 * `/v1/status` after a restart blocked 85.8s (a boot CPU profile put 92% in synchronous `gh`
 * subprocesses — event-loop lag an exception-based APM never sees), and the ledger re-copied
 * itself 800 times — none of it raised. Nothing here waits for an exception; this module reads
 * the SAME ledger every other board/analytics reader tails and asks a small, declarative set of
 * "is this invariant broken" questions of it, on a timer, so a silent stall becomes a ledgered
 * `incident.event` (W1-T4383's shape) another surface (W1-T4385's SRE lane) can act on.
 *
 * MULTI-WINDOW BURN RATE (Google SRE's design, cited in this task's rationale): a rule fires only
 * when a LONG window burns AND a SHORT confirmation window (1/12th of the long window) also
 * burns. A single bad minute inside an otherwise fine two hours passes the long window's test but
 * fails the short one the instant it clears, so a blip never files — only a SUSTAINED condition,
 * present at BOTH time scales at once, does.
 *
 * PURE BY DESIGN: {@link evaluateIncidentInvariants} reads no clock, file or network. Its one impure
 * caller, serve.ts's startIncidentInvariantsMonitor, is a minute tick that ledgers `runtime.loop_lag`
 * then each finding over the tailed ledger — armed with NO client gate (a stall nobody watches is the
 * target), logging and swallowing each half's throw so one bad read never silences a later minute.
 *
 * FALSIFIER: test/incident-invariants.test.ts.
 */

/** A tailed ledger row, loosely typed exactly like {@link import("./status.js").LedgerLines}'
 *  element type: every existing ledger step decorates this with its own fields, and a rule reads
 *  only the ones it declared. `ts` and `step` are read defensively — a malformed or torn line
 *  simply never matches any rule, rather than throwing mid-evaluation. */
export type IncidentInvariantRow = Record<string, unknown>;

/** One rule's verdict over one window: never just a boolean — the message carries the measured
 *  values so a firing rule's ledger line is legible on its own, without a second lookup. */
interface RuleVerdict {
  bad: boolean;
  message: string;
}

/** A firing rule, ready to become an `incident.event` ledger row (design: "name is the rule id,
 *  message carries the measured values"). */
export interface InvariantFinding {
  ruleId: string;
  message: string;
  longMs: number;
  shortMs: number;
}

interface InvariantRule {
  id: string;
  /** The long window's width; the short confirmation window is always 1/12th of this. */
  longMs: number;
  bad: (window: readonly IncidentInvariantRow[]) => RuleVerdict;
}

function numberField(row: IncidentInvariantRow, key: string): number {
  const v = row[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function stringField(row: IncidentInvariantRow, key: string): string | undefined {
  const v = row[key];
  return typeof v === "string" ? v : undefined;
}

function rowTimeMs(row: IncidentInvariantRow): number | undefined {
  const ts = row.ts;
  if (typeof ts !== "string") return undefined;
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Rows strictly newer than `sinceMs`, at or before `nowMs` — half-open, so one instant is never
 *  double-counted across two adjacent windows. */
function rowsSince(rows: readonly IncidentInvariantRow[], sinceMs: number, nowMs: number): IncidentInvariantRow[] {
  return rows.filter((row) => {
    const t = rowTimeMs(row);
    return t !== undefined && t > sinceMs && t <= nowMs;
  });
}

// ── the rule table (design (ii)) ─────────────────────────────────────────────────────────────

export const DISPATCH_STALL_RULE_ID = "dispatch-stall";
export const REPEATED_REFUSAL_RULE_ID = "repeated-refusal";
export const LOOP_LAG_RULE_ID = "loop-lag";
export const NO_MERGES_WITH_GREEN_QUEUE_RULE_ID = "no-merges-with-green-queue";

/** The `dispatch.settled_set` step (dispatch-overlap.ts's `settledSetPayload`) already reports a
 *  `fulfilled` count per pass; this rule sums it across the window rather than re-deriving it. */
const DISPATCH_SETTLED_SET_STEP = "dispatch.settled_set";
/** Not yet ledgered by any writer in this repo (a queue-depth-by-priority snapshot is W1-T4385's
 *  own follow-up) — this rule reads the row shape it needs and simply never fires until something
 *  ledgers one, exactly like every other rule here degrades to "no evidence, no fire" on a cold
 *  ledger. */
const QUEUE_PRIORITY_SNAPSHOT_STEP = "queue.priority_snapshot";

// PRIMARY CONTROL: the loop-lag rule's own bad/good line. W1-T4102's own bound: "a bare 401 took
// 1-20s" was already the incident; 500ms p99 is well inside "fine" and well outside "the event
// loop is fine."
export const LOOP_LAG_P99_BOUND_MS = 500;

const MERGE_READY_STEP = "queue.merge_ready";
const MERGE_STEP = "pr.merged";

const RULES: readonly InvariantRule[] = [
  {
    id: DISPATCH_STALL_RULE_ID,
    // Two hours: dispatch.settled_set's own log line (daemon.ts, drain.ts) fires once per pass,
    // so a rule bound to a single miss would fire on ordinary dispatch spacing — this needs a
    // window wide enough that a truly quiet queue is the only way to read fulfilled=0 throughout.
    longMs: 2 * 60 * 60_000,
    bad: (window) => {
      const queuedPriorityOne = window
        .filter((row) => row.step === QUEUE_PRIORITY_SNAPSHOT_STEP)
        .reduce((max, row) => Math.max(max, numberField(row, "queuedPriority1")), 0);
      const fulfilled = window
        .filter((row) => row.step === DISPATCH_SETTLED_SET_STEP)
        .reduce((sum, row) => sum + numberField(row, "fulfilled"), 0);
      return {
        bad: queuedPriorityOne > 0 && fulfilled === 0,
        message: `queued priority-1 tasks=${queuedPriorityOne}, fulfilled dispatches=${fulfilled}`,
      };
    },
  },
  {
    id: REPEATED_REFUSAL_RULE_ID,
    longMs: 30 * 60_000,
    bad: (window) => {
      const counts = new Map<string, { step: string; reason: string; count: number }>();
      for (const row of window) {
        const step = stringField(row, "step");
        const reason = stringField(row, "reason");
        if (!step || !step.endsWith("_refused") || !reason) continue;
        const key = `${step}\u0000${reason}`;
        const entry = counts.get(key) ?? { step, reason, count: 0 };
        entry.count += 1;
        counts.set(key, entry);
      }
      let worst: { step: string; reason: string; count: number } | undefined;
      for (const entry of counts.values()) {
        if (!worst || entry.count > worst.count) worst = entry;
      }
      return {
        bad: (worst?.count ?? 0) >= 3,
        message: worst
          ? `${worst.step} reason=${worst.reason} x${worst.count}`
          : "no repeated refusal in window",
      };
    },
  },
  {
    id: LOOP_LAG_RULE_ID,
    // Fifteen minutes, sampled once a minute (serve.ts's timer) — enough samples that one noisy
    // minute cannot alone carry both the long AND the short (75s) window.
    longMs: 15 * 60_000,
    bad: (window) => {
      const p99s = window
        .filter((row) => row.step === RUNTIME_LOOP_LAG_STEP)
        .map((row) => numberField(row, "p99Ms"));
      const maxP99 = p99s.length > 0 ? Math.max(...p99s) : 0;
      return {
        bad: p99s.length > 0 && maxP99 > LOOP_LAG_P99_BOUND_MS,
        message: `p99=${maxP99}ms over ${p99s.length} sample(s), bound=${LOOP_LAG_P99_BOUND_MS}ms`,
      };
    },
  },
  {
    id: NO_MERGES_WITH_GREEN_QUEUE_RULE_ID,
    longMs: 4 * 60 * 60_000,
    bad: (window) => {
      const greenQueued = window
        .filter((row) => row.step === MERGE_READY_STEP)
        .reduce((max, row) => Math.max(max, numberField(row, "count")), 0);
      const merges = window.filter((row) => row.step === MERGE_STEP).length;
      return {
        bad: greenQueued > 0 && merges === 0,
        message: `green-queued=${greenQueued}, merges=${merges}`,
      };
    },
  },
];

/**
 * Evaluate every rule over `rows` at instant `nowMs`. A rule fires (and appears in the returned
 * array) only when BOTH its long window AND its short (1/12th) confirmation window are bad — see
 * this module's header. Pure and total: an empty/malformed `rows` never throws, it just yields no
 * evidence for any rule (design's own "no evidence, no fire" posture).
 */
export function evaluateIncidentInvariants(
  rows: readonly IncidentInvariantRow[],
  nowMs: number,
): InvariantFinding[] {
  const findings: InvariantFinding[] = [];
  for (const rule of RULES) {
    const shortMs = rule.longMs / 12;
    const long = rule.bad(rowsSince(rows, nowMs - rule.longMs, nowMs));
    const short = rule.bad(rowsSince(rows, nowMs - shortMs, nowMs));
    if (long.bad && short.bad) {
      findings.push({ ruleId: rule.id, message: long.message, longMs: rule.longMs, shortMs });
    }
  }
  return findings;
}

// ── ledger shapes (design: "posts a kind 'invariant' event") ────────────────────────────────

/** Reuses W1-T4383's own step/shape (`incident-events.ts`'s `IncidentKind` already declares
 *  `"invariant"`) rather than inventing a second incident row shape this evaluator's own consumer
 *  (W1-T4385) would have to special-case. */
export const INVARIANT_INCIDENT_STEP = "incident.event";
export const INVARIANT_INCIDENT_KIND = "invariant";
export const INVARIANT_INCIDENT_SOURCE = "gateway";

/** One {@link InvariantFinding} as the `incident.event` ledger row `serve.ts`'s timer appends. */
export function invariantFindingLedgerLine(finding: InvariantFinding, nowMs: number): LedgerLine {
  return {
    run_id: `INVARIANT-${nowMs}-${finding.ruleId}`,
    task_id: "INCIDENT",
    step: INVARIANT_INCIDENT_STEP,
    kind: INVARIANT_INCIDENT_KIND,
    source: INVARIANT_INCIDENT_SOURCE,
    name: finding.ruleId,
    message: finding.message,
  };
}

// ── event-loop lag (design (i)) ──────────────────────────────────────────────────────────────

/** W1-T4102's `EventLoopLag` reading (daemon-health.ts), ledgered once a minute. */
export const RUNTIME_LOOP_LAG_STEP = "runtime.loop_lag";

/** One {@link EventLoopLag} reading as the `runtime.loop_lag` ledger row serve.ts's timer
 *  appends — the design's "ledger `runtime.loop_lag` p99 once a minute", reusing the SAME
 *  histogram reading `/v1/daemon-health` already renders (daemon-health.ts's
 *  `createEventLoopLagMonitor`) rather than sampling a second histogram. */
export function eventLoopLagLedgerLine(lag: EventLoopLag, nowMs: number): LedgerLine {
  return {
    run_id: `RUNTIME-${nowMs}`,
    task_id: "INCIDENT",
    step: RUNTIME_LOOP_LAG_STEP,
    p50Ms: lag.p50Ms,
    p99Ms: lag.p99Ms,
    maxMs: lag.maxMs,
    windowMs: lag.windowMs,
  };
}
