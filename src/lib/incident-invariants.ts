import type { EventLoopLag } from "./daemon-health.js";
import { queueDispatchRunStarts, type LedgerLine } from "./ledger.js";
import type { PrBlocker } from "./pr-blocker.js";

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
  /** W1-T8233: the ledger steps `bad` reads. A census asserts each has a writer outside this module, so a
   *  rule can never again watch a step nothing writes. */
  inputs: readonly string[];
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

/** W1-T13828: each row's parsed time, kept for as long as the row is: the live tail hands back the same row objects
 *  every minute, and parsing every row's time once per rule window held serve's loop. */
const rowTimes = new WeakMap<object, number | null>();
function rowTimeMs(row: IncidentInvariantRow): number | undefined {
  const held = rowTimes.get(row);
  if (held !== undefined) return held ?? undefined;
  const ts = row.ts;
  const parsed = typeof ts === "string" ? Date.parse(ts) : Number.NaN;
  const ms = Number.isFinite(parsed) ? parsed : null;
  rowTimes.set(row, ms);
  return ms ?? undefined;
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
export const SERVE_MEMORY_HEADROOM_RULE_ID = "serve-memory-headroom";
export const DAEMON_LOOP_SILENT_RULE_ID = "daemon-loop-silent";
/** W1-T13304: serve's container uses more steady CPU than an API layer should. */
export const SERVE_CPU_BUDGET_RULE_ID = "serve-cpu-budget";
/** W1-T13304: the supervisor's hourly row of its container's CPU, written by serve-supervisor.ts. */
export const SERVE_CPU_BUDGET_STEP = "serve.cpu_budget";
/** W1-T13304: the supervisor writes {@link SERVE_CPU_BUDGET_STEP} hourly (serve-supervisor.ts's SERVE_CPU_BUDGET_INTERVAL_MS). */
const SERVE_CPU_BUDGET_CADENCE_MS = 60 * 60_000;
/**
 * PRIMARY CONTROL (W1-T13304): the most CPU serve's container may use outside boots, in cores. MEASURED 2026-11-17
 * 01:05-01:10Z: 1.58 cores, while a thin API layer should idle near zero; Craig: "serve should not need this much cpu".
 */
export const SERVE_STEADY_CPU_BUDGET_CORES = 0.3;

/** Every step the daemon's own loop writes (`daemon.pulse`, `daemon.loop_lag`, ...) — the prefix
 *  `deriveLastPoll` reads. */
const DAEMON_STEP_PREFIX = "daemon.";

// W1-T5355: serve's memory sample (serve-memory.ts, which re-exports these) is defined HERE so the
// rule that reads it needs no import back into the module that imports this one.
export const SERVE_MEMORY_STEP = "serve.memory";
export const SERVE_MEMORY_RELIEVED_STEP = "serve.memory_relieved";
/** "Every few minutes": often enough to see a climb to the limit, rare enough that sizing every holder costs nothing. */
export const SERVE_MEMORY_SAMPLE_MS = 3 * 60_000;
/** Fractions of the container's own limit, so the same line holds at 2 GiB or 8 GiB. */
export const LEGACY_RELIEF_HEADROOM = 0.25;

/** The `dispatch.settled_set` step (dispatch-overlap.ts's `settledSetPayload`) already reports a
 *  `fulfilled` count per pass; this rule sums it across the window rather than re-deriving it. */
const DISPATCH_SETTLED_SET_STEP = "dispatch.settled_set";
/** W1-T8233: dispatch-stall used to read `queue.priority_snapshot`, which nothing ever wrote, so the rule
 *  could not fire (2026-10-11: a 52-minute recycle hold and four core pauses passed silently). It now reads
 *  the daemon's own hold rows — each says dispatchable work was being held back — and the implement
 *  `run.start` rows that prove work began. */
const RUN_START_STEP = "run.start";
const DISPATCH_CLAIM_STEP = "dispatch.claim";
const IMPLEMENT_RUN_TYPE = "implement";
const DAEMON_PAUSE_STEP = "daemon.pause";
const LANE_REFILL_HELD_STEP = "dispatch.lane_refill_held";
const LANE_IDLE_SUMMARY_STEP = "lane.idle_summary";
/** W1-T4102's `EventLoopLag` reading (daemon-health.ts), ledgered once a minute (declared before the rule
 *  table because a rule's `inputs` read it at module load). */
export const RUNTIME_LOOP_LAG_STEP = "runtime.loop_lag";

// PRIMARY CONTROL: the loop-lag rule's own bad/good line. W1-T4102's own bound: "a bare 401 took
// 1-20s" was already the incident; 500ms p99 is well inside "fine" and well outside "the event
// loop is fine."
export const LOOP_LAG_P99_BOUND_MS = 500;
/**
 * W1-T13203: one stall this long is an incident even when p99 stays low. The histogram behind p99 holds one sample
 * per loop turn, so serve's 887,447 ms freeze on 2026-11-16 (runtime.loop_lag 14:39:37Z: p99Ms 108.6) was one sample.
 */
export const LOOP_LAG_MAX_STALL_BOUND_MS = 30_000;
/** W1-T13203: the stall profiler's row (W1-T10074), on the same run_id as the runtime.loop_lag row it explains. */
export const RUNTIME_LOOP_STALL_PROFILE_STEP = "runtime.loop_stall_profile";

/** W1-T13203: up to three `function (file)` pairs from the profile row on the stalled minute's run_id. */
function stallTopFrames(window: readonly IncidentInvariantRow[], runId: unknown): string | undefined {
  if (typeof runId !== "string") return undefined;
  const profile = window.find((row) => row.step === RUNTIME_LOOP_STALL_PROFILE_STEP && row.run_id === runId);
  const frames = Array.isArray(profile?.top_inclusive) ? (profile.top_inclusive as unknown[]).slice(0, 3) : [];
  const named = frames.map((frame) => {
    const entry = (frame ?? {}) as Record<string, unknown>;
    const file = typeof entry.url === "string" ? entry.url.split("/").pop() : undefined;
    return `${typeof entry.function === "string" ? entry.function : "?"} (${file || "?"})`;
  });
  return named.length > 0 ? named.join(", ") : undefined;
}

/** W1-T8233: green work waiting is the sweep's own `sweep.disposed` row with the awaiting-arm blocker
 *  (`queue.merge_ready` was never written). Merges are ledgered as `verdict.merged`; `pr.merged` is kept
 *  as a second witness. */
const SWEEP_DISPOSED_STEP = "sweep.disposed";
/** W1-T9673: every blocker pr-blocker.ts returns, placed on purpose: true for a green PR waiting only on its arm,
 *  including a W1-T9633 security hold of a mergeable, unarmed PR. */
export const GREEN_WORK_WAITING_BLOCKER = {
  "awaiting-arm": true, "security-alert-hold": true, "security-unknown-hold": true,
  "awaiting-ci": false, "own-red": false, "base-red": false, "awaiting-review": false, "review-failed": false,
  "armed-idle": false, "conflict": false, "strikes-exhausted": false, "escalated": false,
  "stale-reviewer-withheld": false, "plan-proof-unrunnable": false, "held-draft": false, "operator-hold": false,
  "other": false,
} as const satisfies Record<PrBlocker, boolean>;
const VERDICT_MERGED_STEP = "verdict.merged";
const MERGE_STEP = "pr.merged";

/** The serve.memory rows in `window` that read a headroom: a null one (no cgroup) is no evidence. */
function headroomReadings(window: readonly IncidentInvariantRow[]): number[] {
  return window
    .filter((row) => row.step === SERVE_MEMORY_STEP && typeof row.headroom === "number" && Number.isFinite(row.headroom))
    .map((row) => row.headroom as number);
}

const RULES: readonly InvariantRule[] = [
  {
    id: DISPATCH_STALL_RULE_ID,
    // Two hours: dispatch.settled_set's own log line (daemon.ts, drain.ts) fires once per pass,
    // so a rule bound to a single miss would fire on ordinary dispatch spacing — this needs a
    // window wide enough that a truly quiet queue is the only way to read fulfilled=0 throughout.
    longMs: 2 * 60 * 60_000,
    inputs: [DAEMON_PAUSE_STEP, LANE_REFILL_HELD_STEP, LANE_IDLE_SUMMARY_STEP, RUN_START_STEP, DISPATCH_CLAIM_STEP, DISPATCH_SETTLED_SET_STEP],
    bad: (window) => {
      const held = window.filter(
        (row) =>
          row.step === DAEMON_PAUSE_STEP ||
          row.step === LANE_REFILL_HELD_STEP ||
          (row.step === LANE_IDLE_SUMMARY_STEP && numberField(row, "idle_minutes") > 0),
      ).length;
      // W1-T13249: a run its dispatch claim refused before spend started no work (the shared predicate).
      const implementStarts = queueDispatchRunStarts(window).filter(
        (row) => row.step === RUN_START_STEP && row.type === IMPLEMENT_RUN_TYPE,
      ).length;
      const fulfilled = window
        .filter((row) => row.step === DISPATCH_SETTLED_SET_STEP)
        .reduce((sum, row) => sum + numberField(row, "fulfilled"), 0);
      return {
        bad: held > 0 && implementStarts === 0 && fulfilled === 0,
        message: `dispatch hold rows=${held}, implement run starts=${implementStarts}, fulfilled dispatches=${fulfilled}`,
      };
    },
  },
  {
    id: REPEATED_REFUSAL_RULE_ID,
    longMs: 30 * 60_000,
    inputs: ["*_refused"],
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
    inputs: [RUNTIME_LOOP_LAG_STEP, RUNTIME_LOOP_STALL_PROFILE_STEP],
    bad: (window) => {
      const lags = window.filter((row) => row.step === RUNTIME_LOOP_LAG_STEP);
      const p99s = lags.map((row) => numberField(row, "p99Ms"));
      const maxP99 = p99s.length > 0 ? Math.max(...p99s) : 0;
      // W1-T13203: the longest single stall in the window, read beside the p99 test, never instead of it.
      let longest: IncidentInvariantRow | undefined;
      for (const row of lags) if (!longest || numberField(row, "maxMs") > numberField(longest, "maxMs")) longest = row;
      const maxStall = longest ? numberField(longest, "maxMs") : 0;
      const stalled = maxStall > LOOP_LAG_MAX_STALL_BOUND_MS;
      const top = stalled ? stallTopFrames(window, longest?.run_id) : undefined;
      return {
        bad: p99s.length > 0 && (maxP99 > LOOP_LAG_P99_BOUND_MS || stalled),
        message: `p99=${maxP99}ms over ${p99s.length} sample(s), bound=${LOOP_LAG_P99_BOUND_MS}ms` +
          (stalled ? `; max=${maxStall}ms, bound=${LOOP_LAG_MAX_STALL_BOUND_MS}ms` : "") + (top ? `; top: ${top}` : ""),
      };
    },
  },
  {
    id: NO_MERGES_WITH_GREEN_QUEUE_RULE_ID,
    longMs: 4 * 60 * 60_000,
    inputs: [SWEEP_DISPOSED_STEP, VERDICT_MERGED_STEP, MERGE_STEP],
    bad: (window) => {
      const green = new Set<string>();
      const byBlocker = new Map<string, Set<string>>();
      for (const row of window) {
        const blocker = row.blocker;
        if (row.step !== SWEEP_DISPOSED_STEP || typeof blocker !== "string" ||
          !Object.hasOwn(GREEN_WORK_WAITING_BLOCKER, blocker) || !GREEN_WORK_WAITING_BLOCKER[blocker as PrBlocker]) continue;
        const pr = row.pr_number;
        const key = typeof pr === "number" || typeof pr === "string" ? String(pr) : "unknown";
        green.add(key);
        byBlocker.set(blocker, (byBlocker.get(blocker) ?? new Set()).add(key));
      }
      const greenQueued = green.size;
      const named = [...byBlocker].map(([blocker, prs]) => `${blocker}=${prs.size}`).join(", ");
      const merges = window.filter((row) => row.step === VERDICT_MERGED_STEP || row.step === MERGE_STEP).length;
      return {
        bad: greenQueued > 0 && merges === 0,
        message: `green-queued=${greenQueued}${named ? ` (${named})` : ""}, merges=${merges}`,
      };
    },
  },
  {
    id: SERVE_MEMORY_HEADROOM_RULE_ID,
    // Short window = 1.5 sample periods, so it holds the latest sample even when the timer drifts.
    // It reads headroom alone: a relief with nothing to drop is exactly the case that must still fire.
    longMs: 18 * SERVE_MEMORY_SAMPLE_MS,
    inputs: [SERVE_MEMORY_STEP, SERVE_MEMORY_RELIEVED_STEP],
    bad: (window) => {
      const readings = headroomReadings(window);
      const best = readings.length > 0 ? Math.max(...readings) : 1;
      const reliefs = window.filter((row) => row.step === SERVE_MEMORY_RELIEVED_STEP).length;
      const last = window.filter((row) => row.step === SERVE_MEMORY_STEP).at(-1) ?? {};
      return {
        bad: readings.length > 0 && best < LEGACY_RELIEF_HEADROOM,
        message: `headroom at most ${Math.round(best * 100)}% over ${readings.length} sample(s), below ${LEGACY_RELIEF_HEADROOM * 100}%; ` +
          `reliefs=${reliefs}; last rss=${numberField(last, "rss_bytes")} unattributed=${numberField(last, "unattributed_bytes")}`,
      };
    },
  },
  {
    id: DAEMON_LOOP_SILENT_RULE_ID,
    // W1-T5651: the daemon's own stall signals are timers on the loop that stalled, so this rule reads
    // them from OUTSIDE it, in serve's process. Fifteen minutes clears every ordinary gap (the longest
    // measured non-stall gap is 12.3 min). A row in the window (serve's own minute row, which also
    // lands in the 75s short window) proves the ledger is live; an empty ledger is no evidence.
    longMs: 15 * 60_000,
    inputs: [`${DAEMON_STEP_PREFIX}*`, RUNTIME_LOOP_LAG_STEP],
    bad: (window) => {
      const daemonRows = window.filter((row) => stringField(row, "step")?.startsWith(DAEMON_STEP_PREFIX));
      const newest = window.at(-1);
      // Serve's own minute row is the proof that the ledger writer is alive: other rows (a lone
      // serve.memory sample, a refusal) say nothing about whether the daemon should be speaking.
      const serveAlive = window.some((row) => row.step === RUNTIME_LOOP_LAG_STEP);
      return {
        bad: serveAlive && daemonRows.length === 0,
        message: `no daemon.* row in ${window.length} row(s); newest step=${(newest && stringField(newest, "step")) ?? "unknown"}`,
      };
    },
  },
  {
    id: SERVE_CPU_BUDGET_RULE_ID,
    // Twelve rows long, so the short window (1/12th, 65 min) still holds the newest hourly row. Each row carries the
    // row before it (prev_steady_cores), so "two consecutive rows over budget" is one row's own test.
    longMs: 12 * (SERVE_CPU_BUDGET_CADENCE_MS + 5 * 60_000),
    inputs: [SERVE_CPU_BUDGET_STEP],
    bad: (window) => {
      const last = window.filter((row) => row.step === SERVE_CPU_BUDGET_STEP).at(-1);
      if (last === undefined) return { bad: false, message: "no serve.cpu_budget row in window" };
      // INVARIANT unreadable-is-unknown: a null (or absent) reading is no evidence, so it never fires.
      const steady = typeof last.steady_cores === "number" ? last.steady_cores : undefined;
      const prev = typeof last.prev_steady_cores === "number" ? last.prev_steady_cores : undefined;
      const top = Array.isArray(last.top) ? (last.top as unknown[]).slice(0, 3).map((c) => {
        const entry = (c ?? {}) as Record<string, unknown>;
        return `${String(entry.name)}=${typeof entry.cores === "number" ? entry.cores : "?"}`;
      }) : [];
      return {
        bad: steady !== undefined && prev !== undefined && steady > SERVE_STEADY_CPU_BUDGET_CORES && prev > SERVE_STEADY_CPU_BUDGET_CORES,
        message: `steady ${steady ?? "unread"} cores (previous hour ${prev ?? "unread"}), budget ${SERVE_STEADY_CPU_BUDGET_CORES}; top: ${top.join(", ") || "unread"}`,
      };
    },
  },
];

/** W1-T8233: every rule id and the ledger steps its `bad` reads (a trailing `*` is a step prefix, a leading
 *  `*` a suffix), for the census that asserts each has a writer. */
export const INCIDENT_RULE_INPUTS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  RULES.map((rule) => [rule.id, rule.inputs]),
);

export const INCIDENT_LONGEST_WINDOW_MS = Math.max(...RULES.map((rule) => rule.longMs));

/** W1-T13828: whether a step is one of a rule's declared inputs: an exact step, `*suffix` or `prefix*`. */
function stepMatches(step: unknown, inputs: readonly string[]): boolean {
  if (typeof step !== "string") return false;
  return inputs.some((input) => input.startsWith("*") ? step.endsWith(input.slice(1))
    : input.endsWith("*") ? step.startsWith(input.slice(0, -1)) : step === input);
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function incidentStepPattern(wildcard: string): string {
  return [...new Set(RULES.flatMap((rule) => rule.inputs))].map((input) =>
    input.startsWith("*") ? wildcard + escapeRegExp(input.slice(1))
      : input.endsWith("*") ? escapeRegExp(input.slice(0, -1)) + wildcard : escapeRegExp(input),
  ).join("|");
}
const plainIncidentField = new RegExp(`"step"[ \\t\\r\\n]*:[ \\t\\r\\n]*"(?:${incidentStepPattern('[^"]*')})"`);

// Consume quoted strings as units, so braces and brackets inside them never change the nesting depth.
const jsonString = String.raw`"[^"\\]*(?:\\.[^"\\]*)*"`;
const jsonTokens = new RegExp(String.raw`[\[\]{}]|(${jsonString})([ \t\r\n]*:[ \t\r\n]*(${jsonString})?)?`, "g");
const jsonEscapes: Readonly<Record<string, string>> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

function decodeJsonString(token: string): string {
  return token.slice(1, -1).replace(/\\(?:u([\da-fA-F]{4})|(["\\/bfnrt]))/g, (_, hex, escape) =>
    hex === undefined ? jsonEscapes[escape] ?? escape : String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function topLevelStep(line: string): string | undefined {
  if (!line.trimStart().startsWith("{")) return undefined;
  let depth = 0;
  let step: string | undefined;
  for (const [token, key, field, value] of line.matchAll(jsonTokens)) {
    if (token === "{" || token === "[") depth += 1;
    else if (token === "}" || token === "]") {
      depth -= 1;
      if (depth === 0) break;
    } else if (depth === 1 && field !== undefined &&
      (key === '"step"' || (key.includes("\\") && decodeJsonString(key) === "step"))) {
      // JSON.parse uses the last occurrence of a repeated key.
      step = value === undefined ? undefined : decodeJsonString(value);
    }
  }
  return step;
}

class IncidentInputLine extends RegExp {
  override test(line: string): boolean {
    // Reject ordinary unrelated lines before scanning their JSON tokens. Escapes can change keys or values.
    if (!line.includes("\\") && !plainIncidentField.test(line)) return false;
    const step = topLevelStep(line);
    return step !== undefined && super.test(step);
  }
}

/** W1-T13828: test the top-level step against every rule's inputs before the tail parses the row. */
export const INCIDENT_INPUT_LINE: RegExp = new IncidentInputLine(`^(?:${incidentStepPattern("[\\s\\S]*")})$`);

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
    // W1-T13828: a rule reads only its declared inputs, so each window scans those rows, not the whole tail.
    const inputs = rows.filter((row) => stepMatches(row.step, rule.inputs));
    const long = rule.bad(rowsSince(inputs, nowMs - rule.longMs, nowMs));
    const short = rule.bad(rowsSince(inputs, nowMs - shortMs, nowMs));
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

/** W1-T10074: one row of serve's loop-stall profiler (loop-stall-profiler.ts) — its profile or its failure — on the
 *  SAME run and task as the {@link eventLoopLagLedgerLine} row it explains, so one grep reads a stalled minute's lag
 *  beside the frames that held it. `step` comes after the fields, so no field can rename the row. */
export function loopStallLedgerLine(step: string, fields: Record<string, unknown> | undefined, nowMs: number): LedgerLine {
  return { ...fields, run_id: `RUNTIME-${nowMs}`, task_id: "INCIDENT", step };
}
