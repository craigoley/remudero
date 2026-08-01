/**
 * lib/status-board.ts — `rmd status` (W1-T279 half 1 + W1-T280 half 2, MASTER-PLAN §7/§5D).
 *
 * ONE READ MODEL, TWO RENDERERS. {@link buildStatusBoard} returns a plain data object
 * ({@link StatusBoardModel}); the text renderer ({@link renderStatusBoardText}) and `--json`
 * (a bare `JSON.stringify` of the same model, run-task.ts's `statusCommand`) both project THAT
 * — no second derivation, so the console's future Now tab (fb-1784770111145-cf7c24) can never
 * disagree with the terminal (the W1-T262 one-coherent-story discipline, applied to this
 * surface).
 *
 * TWO HALVES, ONE MODEL. LIVENESS/LATCHES/LAST CYCLE (W1-T279) are LOCAL TRUTH ONLY,
 * OFFLINE-SAFE — the filesystem, the ledger, or a launchd process query injected by the
 * caller, never a blocking network call; the `origin/main` comparison is a LOCAL
 * `git rev-parse` (no `git fetch`). BLOCKERS BY CLASS/QUEUE HEAD/INBOX/HEADROOM (W1-T280) are
 * DERIVED — mostly still ledger/plan-local (the dispatch circuit breaker, blocked-PR reasons,
 * headroom telemetry), except the two facts that generically need a live merge-state read
 * (QUEUE HEAD's dispatch eligibility, INBOX's dep-merged predicate), which go through the
 * SAME batched {@link GitHub} gateway every other command already reads through. GITHUB IS
 * DECORATION, NEVER A GATE (see {@link StatusBoardDeps.github}): a gateway failure — or none
 * configured at all — degrades ONLY the sections/rows that actually needed it to a stated
 * `unknownReason`, never a throw, never a silently-empty section indistinguishable from
 * "nothing to report". Where a fact cannot be resolved (a pid unreadable, `origin/main`
 * unresolvable, no `daemon.boot` line yet, no headroom telemetry yet) the model carries an
 * explicit `"unknown"` / absent field, never a zero or a healthy-looking default rendered as
 * fact (the W1-T262 honesty rule: an unknown that LOOKS healthy is exactly the ~17h
 * DEPLOY_FAILED-invisible failure this task exists to retire).
 *
 * RENDERS, NEVER SENSES. Every fact this module reports is already written down somewhere —
 * fleet-control.ts's STOP/PAUSE/QUIET_HOURS flags, deployer.ts's DEPLOY_FAILED/DEPLOY_AUTO
 * markers, inflight-lock.ts's per-task locks, fleet-control.ts's pending kicks/drain-now
 * markers, daemon.ts's own `daemon.boot`/`daemon.summary`/`daemon.headroom` ledger lines +
 * `detectDaemonCrashLoop`, status.ts's dispatch-circuit-breaker/GitHub-projection signals,
 * sweep.ts's already-named PR disposition/reason (the W1-T186 named-reason doctrine — this
 * module RENDERS that vocabulary and mints none of its own), and config.ts's headroom-governor
 * switch. This module reads and assembles; it invents no new sensor.
 *
 * NEXT ACTION TABLES are POLICY AS DATA (rule 2): each section's `nextAction` is picked by
 * scanning an ordered list of `{applies, action}` rules and taking the FIRST match — a new
 * condition is a new table row, never a new branch buried in a renderer. No rule matches, no
 * line: a board that always prints advice trains the operator to skip it.
 */

import { execFileSync } from "node:child_process";
// Imported as the module's DEFAULT export (a plain, mutable object), not as named bindings
// (`import { existsSync } from "node:fs"`) — the same load-bearing reason status.ts's own header
// comment documents: ESM named-export bindings off `node:fs` are non-configurable, so a test
// spying via `node:test`'s `mock.method` cannot intercept a call already bound to a named import
// at load time. Calling `fs.existsSync(...)` as a property access AT CALL TIME (never
// destructured to a local const) keeps every call a live lookup on this same mutable object, so
// a TOCTOU-race test (a marker present at `existsSync` but gone by `statSync`) can actually
// simulate it.
import fs from "node:fs";
import { join } from "node:path";
import {
  detectDaemonCrashLoop,
  DEFAULT_CRASHLOOP_WINDOW,
  type CrashLoopVerdict,
  type CrashLoopWindow,
} from "./daemon.js";
import { deployAutoPath, deployFailedAlertPath, sameCommit } from "./deployer.js";
import { defaultIsPidAlive } from "./drain-lock.js";
import { runnableCandidates, type MergedSet } from "./drain.js";
import { drainNowFilePath, pauseFilePath, pendingKicks, quietHoursFilePath, stopFilePath } from "./fleet-control.js";
import { readInflightLock } from "./inflight-lock.js";
import {
  classifyProposal,
  gitGrepAnchorTrue,
  isRatifiedInLedger,
  parseDraftCache,
  parseProposalRegistry,
  refusalReason,
  type DraftCache,
  type EvidenceAnchor,
  type InboxClassification,
  type Proposal,
  type ReadinessContext,
} from "./inbox.js";
import { loadPlan, type MergedResolver, type Plan } from "./plan.js";
import {
  DEFAULT_MAX_TASK_DISPATCHES,
  dispatchesWithoutNewOwnedPr,
  isDispatchBreakerTripped,
  projectPlan,
  readLedgerLines,
  type DeriveDeps,
  type GitHub,
  type LedgerReader,
  type StatusProjection,
} from "./status.js";
import { taskCardRuns } from "./task-card.js";

// ── The model ────────────────────────────────────────────────────────────────────────────────

export type ServiceName = "daemon" | "serve" | "deploy-supervisor";

/** One LIVENESS row. `bootedAt`/`bootedAgeMs`/`headSha` are populated ONLY for `"daemon"` — the
 *  only service that logs a `daemon.boot` heartbeat to the ledger today (W1-T126); `serve`/
 *  `"deploy-supervisor"` carry none of the three, which the text renderer shows as "unknown",
 *  never a fabricated zero. */
export interface ServiceLivenessRow {
  service: ServiceName;
  running: boolean;
  pid: number | null;
  bootedAt?: string;
  bootedAgeMs?: number;
  headSha?: string;
}

/** The running daemon's boot sha vs a LOCAL (no-fetch) read of `origin/main` — reuses W1-T126's
 *  own `sameCommit` equality (deployer.ts), never a second comparison. `"unknown"` when either
 *  side could not be resolved (no `daemon.boot` line yet, or `origin/main` unreadable offline). */
export type StaleFlag = { status: "unknown" } | { status: "fresh" } | { status: "stale"; headSha: string; originSha: string };

export interface LivenessSection {
  services: ServiceLivenessRow[];
  headVsOriginMain: StaleFlag;
  crashLoop: CrashLoopVerdict;
  nextAction?: string;
}

/** One active LATCH — only PRESENT markers become a row (an absent marker is not news). */
export interface LatchRow {
  name: string;
  ageMs?: number;
  consequence: string;
}

export interface LatchesSection {
  rows: LatchRow[];
  nextAction?: string;
}

/** The newest `daemon.summary` ledger line, read back loosely (never re-typed against
 *  `DaemonSummary`'s strict `DaemonStopReason` union — a future stop reason this board doesn't
 *  yet know about must still render, not vanish). */
export interface LastCycleSummary {
  attempted: string[];
  merged: string[];
  stopReason: string;
  stopDetail?: string;
  costUsd: number;
  ticks: number;
}

export interface LastCycleSection {
  found: boolean;
  summary?: LastCycleSummary;
  ts?: string;
  ageMs?: number;
  nextAction?: string;
}

// ── BLOCKERS BY CLASS (W1-T280) — each class in its OWN vocabulary, never a generic "blocked"
// bucket (design fence: the board mints no blocker taxonomy that named-reason/breaker signals
// don't already carry) ──────────────────────────────────────────────────────────────────────

/** The streak dispatch-circuit-breaker (status.ts's `isDispatchBreakerTripped`) tripped for
 *  this task — the SAME ledger signal drain.ts/daemon.ts already gate dispatch on, re-read
 *  here, never re-implemented. `resetNote` states the breaker's OWN reset condition (a fresh
 *  owned PR resets the streak to 0) — the only "ETA" this ledger-derived signal actually
 *  carries; there is no time-based reset to compute. */
export interface CircuitBrokenBlocker {
  kind: "circuit_broken";
  taskId: string;
  dispatchCount: number;
  maxDispatches: number;
  resetNote: string;
}

/** This task's most recent dispatch was flagged INDETERMINATE (the ledger's own
 *  `dispatch.indeterminate` line — daemon.ts/drain.ts's existing `isIndeterminate` gate,
 *  itself either a GitHub-read failure or a ledger-count regression) — a PURE ledger read, so
 *  it renders regardless of GitHub reachability (the daemon already ledgers this; "visible to
 *  nobody without a ledger dig" is the falsifier this class exists to retire). `ghWindowNote`
 *  is ENRICHED, opportunistically, with the classified GitHub failure reason (status.ts's
 *  `StatusProjection.unavailableReason`, from the SAME batched `projectPlan` pass QUEUE
 *  HEAD/INBOX read) when a reachable gateway confirms the read is STILL indeterminate right
 *  now; otherwise it names the ledger fact alone — either way, "the gateway could not decide"
 *  never reads as "the task is broken". */
export interface IndeterminateBlocker {
  kind: "indeterminate";
  taskId: string;
  ghWindowNote: string;
}

/** An open PR the sweep reconciler (sweep.ts's `runSweep`) already disposed into a non-
 *  progressing class — RENDERS the vocabulary its own `sweep.disposed` ledger line already
 *  minted (the W1-T186 named-reason doctrine), never a second taxonomy. `reason` reads
 *  "reason not named" — never a blank — when the ledger line itself carries none. */
export interface BlockedPrBlocker {
  kind: "blocked_pr";
  taskId?: string;
  prNumber: number;
  prUrl?: string;
  disposition: string;
  reason: string;
}

export type BlockerRow = CircuitBrokenBlocker | IndeterminateBlocker | BlockedPrBlocker;

/** Every class here is a PURE ledger read — ALWAYS present in full regardless of GitHub
 *  reachability (GitHub only ever ENRICHES the `indeterminate` class's note, never gates its
 *  presence). See status-board.ts's own header doc: GitHub is decoration, never a gate. */
export interface BlockersSection {
  rows: BlockerRow[];
  nextAction?: string;
}

// ── QUEUE HEAD (W1-T280) — the next dispatchables, with the four-re-dispatch falsifier named
// as a per-row flag (attempt count + observed per-cycle cost) ─────────────────────────────────

export interface QueueHeadRow {
  taskId: string;
  title: string;
  /** status.ts's `dispatchesWithoutNewOwnedPr` — the SAME streak count the circuit breaker
   *  itself trips on, so this row's number and BLOCKERS' `circuit_broken` class can never
   *  disagree about what "close to tripping" means. */
  attempts: number;
  /** True once `attempts` is at or near the streak breaker's threshold — the four-re-dispatch
   *  incident (07-24) becomes a line the operator reads in one second, before the fifth
   *  dispatch trips the breaker and forces an escalation. */
  perpetual: boolean;
  /** The most recent costed run's `cost_usd` (task-card.ts's `taskCardRuns`) — present only
   *  when `perpetual` is true, so repeated spend cannot stay invisible. */
  observedPerCycleCostUsd?: number;
}

export interface QueueHeadSection {
  rows: QueueHeadRow[];
  /** Present when dispatch eligibility (merge state) could not be resolved — no reachable
   *  GitHub gateway, so nothing here would be trustworthy enough to print as "next up". */
  unknownReason?: string;
  nextAction?: string;
}

// ── INBOX (W1-T280) — ready/not-ready COUNTS from inbox.ts's own InboxState; `rmd inbox`
// remains the detail surface, this board only summarizes ─────────────────────────────────────

export interface InboxSection {
  readyCount: number;
  notReadyCount: number;
  /** inbox.ts's `refusalReason` for the FIRST not-ready proposal only (registry order) — the
   *  board summarizes, it does not replace `rmd inbox`. */
  headNotReadyReason?: string;
  /** Present when classification could not be resolved — no reachable GitHub gateway for the
   *  dep-merged predicate, or no plan/tasks.yaml to resolve dependency ids against. */
  unknownReason?: string;
  nextAction?: string;
}

// ── HEADROOM (W1-T280) — the newest `daemon.headroom` telemetry line PLUS enforcement on/off
// from the SAME switch the daemon reads ────────────────────────────────────────────────────────

export interface HeadroomTelemetry {
  window: string;
  percentUsed: number;
  limitPct: number;
  resetsAt?: string;
  /** The daemon's own "governor disabled — telemetry only" note (config.ts ruling
   *  fb-1784894405468-a4153e), carried verbatim when the ledger line has one. */
  note?: string;
}

export interface HeadroomSection {
  found: boolean;
  telemetry?: HeadroomTelemetry;
  ts?: string;
  ageMs?: number;
  /** config.ts's `resolveHeadroomEnabled` — the SAME switch the daemon reads, never a second
   *  derivation. Present unconditionally: this is a LOCAL config read, never gated on GitHub. */
  enforced: boolean;
  nextAction?: string;
}

export interface StatusBoardModel {
  generatedAt: string;
  liveness: LivenessSection;
  latches: LatchesSection;
  lastCycle: LastCycleSection;
  blockers: BlockersSection;
  queueHead: QueueHeadSection;
  inbox: InboxSection;
  headroom: HeadroomSection;
}

// ── Deps ─────────────────────────────────────────────────────────────────────────────────────

export interface StatusBoardDeps {
  /**
   * Per-service running/pid. `launchctl print` lives at the CLI layer (run-task.ts's own
   * `queryLaunchdService` + `DAEMON_LABEL`/`SERVE_LABEL`/`SUPERVISOR_LABEL`) — this module never
   * shells to launchd itself (Rule 16: lib/ stays a thin, injectable seam over that). Required;
   * no default exists inside lib/.
   */
  queryService: (service: ServiceName) => { running: boolean; pid: number | null };
  /** The checkout to compare against `origin/main` (the daemon's own repoRoot). */
  repoDir: string;
  /** Ledger reader; defaults to status.ts's real `readLedgerLines`. */
  readLedger?: LedgerReader;
  /** LOCAL (no-fetch) resolution of `origin/main`'s sha — offline-safe by construction. Defaults
   *  to `git rev-parse origin/main` in `repoDir`; returns `undefined` (never throws) when it
   *  cannot be resolved (no git, not a repo, no such ref, network-off has no bearing since this
   *  never fetches). */
  resolveOriginMainSha?: (repoDir: string) => string | undefined;
  /** Clock; defaults to `Date.now`. Injectable so a test can assert an exact age. */
  now?: () => number;
  /** Crash-loop window/threshold; defaults to daemon.ts's `DEFAULT_CRASHLOOP_WINDOW`. */
  crashLoopWindow?: CrashLoopWindow;
  /** Pid-liveness probe for inflight-lock rows; defaults to drain-lock.ts's real check. */
  isPidAlive?: (pid: number) => boolean;

  // ── W1-T280 (DERIVED half) ────────────────────────────────────────────────────────────────

  /** Local (offline) `plan/tasks.yaml` read — the DAG source QUEUE HEAD and INBOX resolve
   *  against (and BLOCKERS' `indeterminate` class opportunistically enriches its note from,
   *  when reachable). Defaults to `loadPlan(join(repoDir, "plan", "tasks.yaml"))`; `undefined`
   *  (never a throw) when unreadable, degrading QUEUE HEAD/INBOX to a stated `unknownReason` —
   *  BLOCKERS is a pure ledger read and needs no plan at all, unaffected either way. */
  plan?: Plan;
  /**
   * The batched GitHub gateway (status.ts's `buildBatchedGithub`) backing every remote fact
   * QUEUE HEAD's dispatch eligibility and INBOX's dep-merged predicate read — read through ONCE
   * per render (`projectPlan`'s own batching), never per row. Omitted, or reporting
   * `readFailed()` after that one batched pass, degrades exactly those two sections to a
   * stated `unknownReason` — never a throw, never a fail-closed board. LIVENESS/LATCHES/LAST
   * CYCLE and BLOCKERS BY CLASS (a pure ledger read, always in full — GitHub only ever
   * ENRICHES its `indeterminate` class's note, never gates the row's presence) are UNAFFECTED
   * (GitHub is decoration, never a gate).
   */
  github?: GitHub;
  /** Local (no-network) evidence-anchor grep for INBOX; defaults to inbox.ts's
   *  `gitGrepAnchorTrue(repoDir, "origin/main", anchor)`. */
  grepAnchorTrue?: (anchor: EvidenceAnchor) => boolean;
  /** `state/inbox-proposals.json` reader; defaults to the real file under `root`, parsed by
   *  inbox.ts's own fail-soft-to-empty `parseProposalRegistry`. */
  readProposalRegistry?: () => Proposal[];
  /** `state/inbox-drafts.json` reader; defaults to the real file under `root`, parsed by
   *  inbox.ts's own fail-soft-to-empty `parseDraftCache`. */
  readDraftCache?: () => DraftCache;
  /**
   * The headroom-governor switch (config.ts's `resolveHeadroomEnabled(config)`) — a
   * config-file read, so injected exactly like `queryService` rather than re-derived inside
   * lib/ (Rule 16: this module stays a thin seam over the CLI layer's own config load). The
   * real wiring passes `() => resolveHeadroomEnabled(config)`, the SAME switch the daemon
   * itself reads every tick. Omitted falls back to the product default (`true`, governor ON)
   * rather than fabricating "off".
   */
  resolveHeadroomEnabled?: () => boolean;
  /** Max rows QUEUE HEAD and BLOCKERS' blocked-PR class each show; defaults to 5. */
  queueHeadLimit?: number;
}

// ── origin/main (local, no fetch) ───────────────────────────────────────────────────────────

function defaultResolveOriginMainSha(repoDir: string): string | undefined {
  try {
    const sha = execFileSync("git", ["-C", repoDir, "rev-parse", "origin/main"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

// ── Ledger derivation ────────────────────────────────────────────────────────────────────────

interface BootInfo {
  ts?: string;
  headSha?: string;
  /** Every `daemon.boot` line's own `ts`, oldest-or-newest order irrelevant — {@link
   *  detectDaemonCrashLoop} sorts internally. Feeds the crash-loop check without a second scan. */
  allTimestamps: string[];
}

function deriveDaemonBoots(lines: ReadonlyArray<Record<string, unknown>>): BootInfo {
  let bestTs: string | undefined;
  let bestParsed = -Infinity;
  let bestHeadSha: string | undefined;
  const allTimestamps: string[] = [];
  for (const line of lines) {
    if (line.step !== "daemon.boot") continue;
    const ts = typeof line.ts === "string" ? line.ts : undefined;
    if (ts) allTimestamps.push(ts);
    const parsed = ts ? Date.parse(ts) : NaN;
    if (!Number.isFinite(parsed) || parsed < bestParsed) continue;
    bestParsed = parsed;
    bestTs = ts;
    bestHeadSha = typeof line.head_sha === "string" ? line.head_sha : undefined;
  }
  return { ts: bestTs, headSha: bestHeadSha, allTimestamps };
}

function deriveLastCycle(lines: ReadonlyArray<Record<string, unknown>>): { ts?: string; summary?: LastCycleSummary } {
  let bestTs: string | undefined;
  let bestParsed = -Infinity;
  let bestSummary: LastCycleSummary | undefined;
  for (const line of lines) {
    if (line.step !== "daemon.summary") continue;
    const ts = typeof line.ts === "string" ? line.ts : undefined;
    const parsed = ts ? Date.parse(ts) : NaN;
    if (!Number.isFinite(parsed) || parsed < bestParsed) continue;
    bestParsed = parsed;
    bestTs = ts;
    bestSummary = {
      attempted: Array.isArray(line.attempted) ? (line.attempted as unknown[]).filter((x): x is string => typeof x === "string") : [],
      merged: Array.isArray(line.merged) ? (line.merged as unknown[]).filter((x): x is string => typeof x === "string") : [],
      stopReason: typeof line.stopReason === "string" ? line.stopReason : "unknown",
      stopDetail: typeof line.stopDetail === "string" ? line.stopDetail : undefined,
      costUsd: typeof line.costUsd === "number" ? line.costUsd : 0,
      ticks: typeof line.ticks === "number" ? line.ticks : 0,
    };
  }
  return { ts: bestTs, summary: bestSummary };
}

// ── LATCHES table (DATA — a marker added later is a row, not a branch) ─────────────────────────

function readJsonMarker(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null; // absent, or present-but-unparseable — either way, no extra detail to show
  }
}

/** AGE for a marker file: prefer its own `requestedAt`/`at` JSON field; fall back to the file's
 *  mtime (e.g. DEPLOY_AUTO, a bare touch file with no JSON body at all). */
function markerAgeMs(path: string, json: Record<string, unknown> | null, nowMs: number): number | undefined {
  const iso = typeof json?.requestedAt === "string" ? json.requestedAt : typeof json?.at === "string" ? json.at : undefined;
  const parsed = iso ? Date.parse(iso) : NaN;
  if (Number.isFinite(parsed)) return Math.max(0, nowMs - parsed);
  try {
    return Math.max(0, nowMs - fs.statSync(path).mtimeMs);
  } catch {
    return undefined;
  }
}

interface StaticLatchDef {
  name: string;
  path: (root: string) => string;
  consequence: (json: Record<string, unknown> | null) => string;
}

/** Ordered by operational urgency — also the order rows render in (most-actionable first). */
const STATIC_LATCHES: readonly StaticLatchDef[] = [
  {
    name: "DEPLOY_FAILED",
    path: deployFailedAlertPath,
    consequence: (json) => {
      const message = typeof json?.message === "string" ? json.message : "a deploy failed its health-check";
      const failedHead = typeof json?.failedHead === "string" ? json.failedHead.slice(0, 12) : undefined;
      return (
        `the checkout was rolled back — the daemon is running the PRIOR head (${message}` +
        `${failedHead ? `; failed head ${failedHead}` : ""})`
      );
    },
  },
  {
    name: "STOP",
    path: stopFilePath,
    consequence: (json) => {
      const reason = typeof json?.reason === "string" ? json.reason : undefined;
      return (
        `the running drain/daemon halts within one tick${reason ? ` (${reason})` : ""}` +
        ` — one-shot, auto-clears when that run ends`
      );
    },
  },
  {
    name: "PAUSE",
    path: pauseFilePath,
    consequence: (json) => {
      const reason = typeof json?.reason === "string" ? json.reason : undefined;
      return `no new task spawns until \`rmd resume\`${reason ? ` (${reason})` : ""} — any in-flight task still completes`;
    },
  },
  {
    name: "QUIET_HOURS",
    path: quietHoursFilePath,
    consequence: () => "quiet-hours preference is set (an optional throttle a future scheduler consumer reads)",
  },
  {
    name: "DEPLOY_AUTO",
    path: deployAutoPath,
    consequence: () => "the supervisor auto-deploys any new origin/main HEAD once health-checked, without a manual `rmd deploy`",
  },
];

function buildLatchRows(root: string, nowMs: number, isPidAlive: (pid: number) => boolean): LatchRow[] {
  const rows: LatchRow[] = [];

  for (const def of STATIC_LATCHES) {
    const path = def.path(root);
    if (!fs.existsSync(path)) continue;
    const json = readJsonMarker(path);
    rows.push({ name: def.name, ageMs: markerAgeMs(path, json, nowMs), consequence: def.consequence(json) });
  }

  // Inflight locks — one row per LIVE lock (a dead-pid lock is stale debris, not an active
  // latch — mirrors run-task.ts's own liveInflightRuns definition of "in flight").
  const inflightDir = join(root, "state", "inflight");
  try {
    for (const entry of fs.readdirSync(inflightDir)) {
      if (!entry.endsWith(".lock")) continue;
      const taskId = entry.slice(0, -".lock".length);
      const info = readInflightLock(inflightDir, taskId);
      if (!info || !isPidAlive(info.pid)) continue;
      const parsed = Date.parse(info.startedAt);
      rows.push({
        name: `inflight:${taskId}`,
        ageMs: Number.isFinite(parsed) ? Math.max(0, nowMs - parsed) : undefined,
        consequence: `a run of ${taskId} is in flight (pid ${info.pid}, run ${info.run_id}) — a second dispatch of the same task is refused until this releases`,
      });
    }
  } catch {
    // no state/inflight dir yet — nothing in flight
  }

  // Pending kicks — the console's "Run now" marker, one per queued task id.
  for (const kick of pendingKicks(root)) {
    const parsed = Date.parse(kick.requestedAt);
    rows.push({
      name: `kick:${kick.taskId}`,
      ageMs: Number.isFinite(parsed) ? Math.max(0, nowMs - parsed) : undefined,
      consequence: `${kick.taskId} will be dispatched at the daemon's next poll, if runnable`,
    });
  }

  // drain-now — PEEK ONLY, never consume (consuming is exclusively the daemon's own job;
  // a status read must never have the side effect of erasing the very request it reports).
  const drainNowPath = drainNowFilePath(root);
  if (fs.existsSync(drainNowPath)) {
    const json = readJsonMarker(drainNowPath);
    rows.push({
      name: "drain-now",
      ageMs: markerAgeMs(drainNowPath, json, nowMs),
      consequence: "the daemon runs one dispatch cycle immediately at its next poll",
    });
  }

  return rows;
}

// ── NEXT ACTION tables (policy as data — rule 2) ────────────────────────────────────────────────

interface NextActionRule<TCtx> {
  applies: (ctx: TCtx) => boolean;
  action: (ctx: TCtx) => string;
}

function pickNextAction<TCtx>(rules: readonly NextActionRule<TCtx>[], ctx: TCtx): string | undefined {
  for (const rule of rules) {
    if (rule.applies(ctx)) return rule.action(ctx);
  }
  return undefined;
}

interface LivenessCtx {
  services: ServiceLivenessRow[];
  headVsOriginMain: StaleFlag;
  crashLoop: CrashLoopVerdict;
}

const LIVENESS_NEXT_ACTIONS: readonly NextActionRule<LivenessCtx>[] = [
  {
    // Incident (b): a crash-loop must read as a named condition, never "queue not processing".
    applies: (ctx) => ctx.crashLoop.breached,
    action: (ctx) =>
      `crash-loop: ${ctx.crashLoop.windowBoots.length} boots in the last ${Math.round(ctx.crashLoop.windowMs / 60_000)}m — investigate the boot cause before restarting anything`,
  },
  {
    applies: (ctx) => ctx.headVsOriginMain.status === "stale",
    action: (ctx) => {
      const s = ctx.headVsOriginMain as { status: "stale"; headSha: string; originSha: string };
      return (
        `the daemon is running stale code (${s.headSha.slice(0, 12)} vs origin/main ${s.originSha.slice(0, 12)})` +
        ` — \`rmd deploy\` to fast-forward + restart at the next idle gap`
      );
    },
  },
  {
    applies: (ctx) => !ctx.services.find((s) => s.service === "daemon")?.running,
    action: () => "the daemon is not running — `rmd up` (or `rmd daemon ...`) to resume the fleet",
  },
];

const LATCHES_NEXT_ACTIONS: readonly NextActionRule<LatchesSection>[] = [
  {
    // Incident (a): DEPLOY_FAILED must never sit invisible again.
    applies: (ctx) => ctx.rows.some((r) => r.name === "DEPLOY_FAILED"),
    action: () => "inspect state/DEPLOY_FAILED and re-deploy once fixed (`rmd deploy`)",
  },
  {
    applies: (ctx) => ctx.rows.some((r) => r.name === "STOP"),
    action: () => "STOP is set — no action needed unless unexpected; it auto-clears when the halted run ends",
  },
  {
    applies: (ctx) => ctx.rows.some((r) => r.name === "PAUSE"),
    action: () => "no new work will dispatch — `rmd resume` when ready to continue",
  },
];

const LAST_CYCLE_NEXT_ACTIONS: readonly NextActionRule<LastCycleSection>[] = [
  {
    applies: (ctx) => ctx.found && ctx.summary?.stopReason === "blocked",
    action: (ctx) => `the last cycle stopped BLOCKED${ctx.summary?.stopDetail ? ` — ${ctx.summary.stopDetail}` : ""} — resolve the blocking task before the next cycle`,
  },
  {
    applies: (ctx) => ctx.found && ctx.summary?.stopReason === "error",
    action: (ctx) => `the last cycle stopped on an unexpected ERROR${ctx.summary?.stopDetail ? ` — ${ctx.summary.stopDetail}` : ""} — check the ledger around this run`,
  },
];

// ── W1-T280 helpers — plan/GitHub read (once) ───────────────────────────────────────────────

function tryLoadDefaultPlan(repoDir: string): Plan | undefined {
  try {
    return loadPlan(join(repoDir, "plan", "tasks.yaml"));
  } catch {
    return undefined; // no tasks.yaml at repoDir (offline checkout, test fixture, ...) — never a throw
  }
}

function readTextFileIfExists(path: string): string | undefined {
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** ONE batched projection pass over the whole plan (status.ts's `projectPlan`, which itself
 *  fetches GitHub exactly once and shares it across every task) — the single remote read that
 *  backs QUEUE HEAD's dispatch eligibility, INBOX's dep-merged predicate, and BLOCKERS'
 *  `indeterminate` class. Returns `undefined` projections with a stated `unknownReason` when
 *  no plan or no reachable gateway backs this render — NEVER a throw, never a per-row fetch. */
function projectPlanOnce(
  plan: Plan | undefined,
  github: GitHub | undefined,
  ledgerPath: string,
  lines: Array<Record<string, unknown>>,
  now: () => number,
): { projections?: Map<string, StatusProjection>; unknownReason?: string } {
  if (!plan) return { unknownReason: "plan/tasks.yaml is unreadable — dispatch eligibility cannot be resolved" };
  if (!github) return { unknownReason: "no GitHub gateway configured for this read" };
  const deriveDeps: DeriveDeps = { ledgerPath, github, readLedger: () => lines, now };
  let projections: Map<string, StatusProjection> | undefined;
  try {
    projections = projectPlan(plan, deriveDeps);
  } catch (e) {
    return { unknownReason: `GitHub projection failed unexpectedly (${String((e as Error)?.message ?? e)})` };
  }
  if (github.readFailed?.()) {
    const reason = github.readFailureReason?.() ?? "unknown";
    return { unknownReason: `GitHub gateway unreachable (${reason})` };
  }
  return { projections };
}

// ── BLOCKERS BY CLASS derivation ────────────────────────────────────────────────────────────

/** Every distinct task id the ledger has EVER dispatched — the circuit-broken class needs no
 *  plan at all, just the ledger's own `run.start` history (mirrors `dispatchesWithoutNewOwnedPr`'s
 *  own task-id-agnostic scan). */
function distinctDispatchedTaskIds(lines: Array<Record<string, unknown>>): string[] {
  const ids = new Set<string>();
  for (const line of lines) {
    if (line.step === "run.start" && typeof line.task_id === "string") ids.add(line.task_id);
  }
  return [...ids];
}

function deriveCircuitBrokenBlockers(lines: Array<Record<string, unknown>>): CircuitBrokenBlocker[] {
  const out: CircuitBrokenBlocker[] = [];
  for (const taskId of distinctDispatchedTaskIds(lines)) {
    if (!isDispatchBreakerTripped(lines, taskId)) continue;
    const dispatchCount = dispatchesWithoutNewOwnedPr(lines, taskId);
    out.push({
      kind: "circuit_broken",
      taskId,
      dispatchCount,
      maxDispatches: DEFAULT_MAX_TASK_DISPATCHES,
      resetNote: `resets only on a fresh owned PR for ${taskId} — ${dispatchCount}/${DEFAULT_MAX_TASK_DISPATCHES} dispatches since the last one`,
    });
  }
  return out;
}

/** The newest `dispatch.indeterminate {task}` ledger line per task id — a PURE ledger read
 *  (never gated on GitHub reachability). Skips a task the batched projection (when reachable)
 *  already confirms MERGED — landed work is no longer news, no matter what an older ledger
 *  line says. `ghWindowNote` is ENRICHED with the classified failure reason when that SAME
 *  projection confirms the task is STILL indeterminate right now; otherwise it names the
 *  ledger fact alone (never blank, never silently upgraded to "the task is broken"). */
function deriveIndeterminateBlockers(
  lines: Array<Record<string, unknown>>,
  projections: Map<string, StatusProjection> | undefined,
): IndeterminateBlocker[] {
  const out: IndeterminateBlocker[] = [];
  const seen = new Set<string>();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.step !== "dispatch.indeterminate" || typeof line.task_id !== "string") continue;
    const taskId = line.task_id;
    if (seen.has(taskId)) continue; // only the NEWEST occurrence per task
    seen.add(taskId);
    if (projections?.get(taskId)?.merged) continue; // landed since — no longer news
    const p = projections?.get(taskId);
    const ghWindowNote =
      p?.indeterminate && p.unavailableReason
        ? `the GitHub read could not decide (${p.unavailableReason}${p.githubUnobservableSince ? `, unobservable since ${p.githubUnobservableSince}` : ""}) — a gateway window, not a claim that the task itself is broken`
        : "flagged indeterminate at its last dispatch attempt (ledger: dispatch.indeterminate) — a gateway/ledger window, not a claim that the task itself is broken";
    out.push({ kind: "indeterminate", taskId, ghWindowNote });
  }
  return out;
}

/** sweep.ts's `runSweep` dispositions that mean "not progressing" — the SAME vocabulary
 *  sweep.ts already minted (W1-T186), never a second taxonomy. `"mergeable"`/`"post-review"`/
 *  `"dep-review"`/`"wait"` are ordinary in-progress states, not blockers. */
const BLOCKED_PR_DISPOSITIONS: ReadonlySet<string> = new Set(["blocked-fixable", "blocked-ambiguous", "conflicted", "stale"]);

function deriveBlockedPrBlockers(lines: Array<Record<string, unknown>>, limit: number): BlockedPrBlocker[] {
  // Newest `sweep.disposed` line per PR number wins — ledger append order, later overwrites earlier.
  const latestByPr = new Map<number, Record<string, unknown>>();
  for (const line of lines) {
    if (line.step !== "sweep.disposed") continue;
    if (typeof line.pr_number !== "number") continue;
    latestByPr.set(line.pr_number, line);
  }
  const rows: BlockedPrBlocker[] = [];
  for (const [prNumber, line] of latestByPr) {
    const disposition = typeof line.disposition === "string" ? line.disposition : undefined;
    if (!disposition || !BLOCKED_PR_DISPOSITIONS.has(disposition)) continue;
    const reason = typeof line.reason === "string" && line.reason.trim().length > 0 ? line.reason : "reason not named";
    const taskId = typeof line.task_id === "string" && line.task_id !== "SWEEP" ? line.task_id : undefined;
    rows.push({
      kind: "blocked_pr",
      taskId,
      prNumber,
      prUrl: typeof line.pr_url === "string" ? line.pr_url : undefined,
      disposition,
      reason,
    });
  }
  rows.sort((a, b) => {
    const tsA = typeof latestByPr.get(a.prNumber)?.ts === "string" ? (latestByPr.get(a.prNumber)!.ts as string) : "";
    const tsB = typeof latestByPr.get(b.prNumber)?.ts === "string" ? (latestByPr.get(b.prNumber)!.ts as string) : "";
    return tsB.localeCompare(tsA); // newest-disposed first
  });
  return rows.slice(0, limit);
}

function deriveBlockers(
  lines: Array<Record<string, unknown>>,
  projections: Map<string, StatusProjection> | undefined,
  limit: number,
): BlockersSection {
  const circuitBroken = deriveCircuitBrokenBlockers(lines);
  const blockedPrs = deriveBlockedPrBlockers(lines, limit);
  const indeterminate = deriveIndeterminateBlockers(lines, projections);
  const rows: BlockerRow[] = [...circuitBroken, ...indeterminate, ...blockedPrs];
  const section: BlockersSection = { rows };
  section.nextAction = pickNextAction(BLOCKERS_NEXT_ACTIONS, section);
  return section;
}

const BLOCKERS_NEXT_ACTIONS: readonly NextActionRule<BlockersSection>[] = [
  {
    applies: (ctx) => ctx.rows.some((r): r is CircuitBrokenBlocker => r.kind === "circuit_broken"),
    action: (ctx) => {
      const r = ctx.rows.find((row): row is CircuitBrokenBlocker => row.kind === "circuit_broken")!;
      return `${r.taskId}'s dispatch circuit is broken — ${r.resetNote}; investigate before it re-dispatches again`;
    },
  },
  {
    applies: (ctx) => ctx.rows.some((r): r is BlockedPrBlocker => r.kind === "blocked_pr"),
    action: (ctx) => {
      const r = ctx.rows.find((row): row is BlockedPrBlocker => row.kind === "blocked_pr")!;
      return `PR #${r.prNumber} is blocked (${r.disposition}): ${r.reason}`;
    },
  },
  {
    applies: (ctx) => ctx.rows.some((r): r is IndeterminateBlocker => r.kind === "indeterminate"),
    action: (ctx) => {
      const r = ctx.rows.find((row): row is IndeterminateBlocker => row.kind === "indeterminate")!;
      return `${r.taskId}'s GitHub read is indeterminate — ${r.ghWindowNote}`;
    },
  },
];

// ── QUEUE HEAD derivation ────────────────────────────────────────────────────────────────────

/** One dispatch away from the streak breaker's own threshold — "at or near" per the design's
 *  own wording, so a perpetual-attempt task is flagged BEFORE it trips and forces an
 *  escalation, not only after. */
const PERPETUAL_ATTEMPT_THRESHOLD = DEFAULT_MAX_TASK_DISPATCHES - 1;

function deriveQueueHead(
  plan: Plan | undefined,
  lines: Array<Record<string, unknown>>,
  projections: Map<string, StatusProjection> | undefined,
  ghUnknownReason: string | undefined,
  limit: number,
): QueueHeadSection {
  if (!plan || !projections || ghUnknownReason) {
    const section: QueueHeadSection = { rows: [], unknownReason: ghUnknownReason ?? "plan/tasks.yaml is unreadable" };
    section.nextAction = pickNextAction(QUEUE_HEAD_NEXT_ACTIONS, section);
    return section;
  }
  const isMerged: MergedSet = (id) => projections.get(id)?.merged === true;
  const isIndeterminate = (id: string) => projections.get(id)?.indeterminate === true;
  const isCircuitTripped = (id: string) => isDispatchBreakerTripped(lines, id);
  const candidates = runnableCandidates(plan, isMerged, limit, { isIndeterminate, isCircuitTripped });
  const rows: QueueHeadRow[] = candidates.map((t) => {
    const attempts = dispatchesWithoutNewOwnedPr(lines, t.id);
    const perpetual = attempts >= PERPETUAL_ATTEMPT_THRESHOLD;
    const row: QueueHeadRow = { taskId: t.id, title: t.title, attempts, perpetual };
    if (perpetual) {
      const runs = taskCardRuns(lines as Array<Record<string, unknown>>, t.id);
      const lastCosted = [...runs].reverse().find((r) => r.costUsd !== undefined);
      if (lastCosted) row.observedPerCycleCostUsd = lastCosted.costUsd;
    }
    return row;
  });
  const section: QueueHeadSection = { rows };
  section.nextAction = pickNextAction(QUEUE_HEAD_NEXT_ACTIONS, section);
  return section;
}

const QUEUE_HEAD_NEXT_ACTIONS: readonly NextActionRule<QueueHeadSection>[] = [
  { applies: (ctx) => ctx.unknownReason !== undefined, action: (ctx) => `queue head is unknown — ${ctx.unknownReason}` },
  {
    applies: (ctx) => ctx.rows.some((r) => r.perpetual),
    action: (ctx) => {
      const r = ctx.rows.find((row) => row.perpetual)!;
      const cost = r.observedPerCycleCostUsd !== undefined ? `~$${r.observedPerCycleCostUsd.toFixed(2)}/cycle` : "an unknown per-cycle cost";
      return `${r.taskId} has re-dispatched ${r.attempts} times with nothing new merged (${cost}) — investigate before it trips the circuit breaker`;
    },
  },
];

// ── INBOX derivation ─────────────────────────────────────────────────────────────────────────

function deriveInbox(
  plan: Plan | undefined,
  lines: Array<Record<string, unknown>>,
  projections: Map<string, StatusProjection> | undefined,
  ghUnknownReason: string | undefined,
  readProposalRegistry: () => Proposal[],
  readDraftCache: () => DraftCache,
  grepAnchorTrue: (a: EvidenceAnchor) => boolean,
): InboxSection {
  if (!plan || !projections || ghUnknownReason) {
    const section: InboxSection = { readyCount: 0, notReadyCount: 0, unknownReason: ghUnknownReason ?? "plan/tasks.yaml is unreadable" };
    section.nextAction = pickNextAction(INBOX_NEXT_ACTIONS, section);
    return section;
  }
  const proposals = readProposalRegistry();
  const drafts = readDraftCache();
  const isMerged: MergedResolver = (t) => projections.get(t.id)?.merged === true;
  const ctx: ReadinessContext = {
    plan,
    isMerged,
    grepAnchorTrue,
    openProposalIds: new Set(proposals.map((p) => p.id)),
    isRatified: (id) => isRatifiedInLedger(lines, id),
  };
  const classifications: InboxClassification[] = proposals.map((p) => classifyProposal(p, drafts[p.id], ctx));
  const readyCount = classifications.filter((c) => c.state === "ready").length;
  const notReadyCount = classifications.length - readyCount;
  const headNotReady = classifications.find((c) => c.state !== "ready");
  const section: InboxSection = {
    readyCount,
    notReadyCount,
    headNotReadyReason: headNotReady ? refusalReason(headNotReady) : undefined,
  };
  section.nextAction = pickNextAction(INBOX_NEXT_ACTIONS, section);
  return section;
}

const INBOX_NEXT_ACTIONS: readonly NextActionRule<InboxSection>[] = [
  { applies: (ctx) => ctx.unknownReason !== undefined, action: (ctx) => `inbox readiness is unknown — ${ctx.unknownReason}` },
  { applies: (ctx) => ctx.readyCount > 0, action: (ctx) => `${ctx.readyCount} proposal(s) ready — \`rmd approve <id>\`` },
  {
    applies: (ctx) => ctx.notReadyCount > 0 && ctx.headNotReadyReason !== undefined,
    action: (ctx) => `next proposal not ready: ${ctx.headNotReadyReason}`,
  },
];

// ── HEADROOM derivation ──────────────────────────────────────────────────────────────────────

function deriveHeadroomLatest(lines: Array<Record<string, unknown>>): { ts?: string; telemetry?: HeadroomTelemetry } {
  let bestTs: string | undefined;
  let bestParsed = -Infinity;
  let best: HeadroomTelemetry | undefined;
  for (const line of lines) {
    if (line.step !== "daemon.headroom") continue;
    const ts = typeof line.ts === "string" ? line.ts : undefined;
    const parsed = ts ? Date.parse(ts) : NaN;
    if (!Number.isFinite(parsed) || parsed < bestParsed) continue;
    bestParsed = parsed;
    bestTs = ts;
    best = {
      window: typeof line.window === "string" ? line.window : "unknown window",
      percentUsed: typeof line.percent_used === "number" ? line.percent_used : 0,
      limitPct: typeof line.limit_pct === "number" ? line.limit_pct : 0,
      resetsAt: typeof line.resets_at === "string" ? line.resets_at : undefined,
      note: typeof line.note === "string" ? line.note : undefined,
    };
  }
  return { ts: bestTs, telemetry: best };
}

function deriveHeadroom(lines: Array<Record<string, unknown>>, nowMs: number, enforced: boolean): HeadroomSection {
  const { ts, telemetry } = deriveHeadroomLatest(lines);
  const tsParsed = ts ? Date.parse(ts) : NaN;
  const section: HeadroomSection = {
    found: telemetry !== undefined,
    telemetry,
    ts,
    ageMs: Number.isFinite(tsParsed) ? Math.max(0, nowMs - tsParsed) : undefined,
    enforced,
  };
  section.nextAction = pickNextAction(HEADROOM_NEXT_ACTIONS, section);
  return section;
}

const HEADROOM_NEXT_ACTIONS: readonly NextActionRule<HeadroomSection>[] = [
  { applies: (ctx) => !ctx.found, action: () => "no headroom telemetry yet — it appears after the daemon's first tick" },
  { applies: (ctx) => !ctx.enforced, action: () => "headroom governor is OFF — telemetry only, dispatch is never throttled on it" },
  {
    applies: (ctx) => ctx.found && ctx.enforced && (ctx.telemetry?.percentUsed ?? 0) >= (ctx.telemetry?.limitPct ?? 100),
    action: (ctx) => `headroom at/over its ${ctx.telemetry?.limitPct}% ceiling — dispatch is throttled until ${ctx.telemetry?.resetsAt ?? "the next reset"}`,
  },
];

// ── buildStatusBoard — the ONE read model ───────────────────────────────────────────────────────

export function buildStatusBoard(root: string, ledgerPath: string, deps: StatusBoardDeps): StatusBoardModel {
  const now = deps.now ?? Date.now;
  const nowMs = now();
  const readLedger = deps.readLedger ?? readLedgerLines;
  const resolveOriginMainSha = deps.resolveOriginMainSha ?? defaultResolveOriginMainSha;
  const crashLoopWindow = deps.crashLoopWindow ?? DEFAULT_CRASHLOOP_WINDOW;
  const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;

  const lines = readLedger(ledgerPath);
  const boots = deriveDaemonBoots(lines);
  const lastCycleRaw = deriveLastCycle(lines);

  // ── LIVENESS ──
  const services: ServiceLivenessRow[] = (["daemon", "serve", "deploy-supervisor"] as const).map((service) => {
    const q = deps.queryService(service);
    const row: ServiceLivenessRow = { service, running: q.running, pid: q.pid };
    if (service === "daemon") {
      row.bootedAt = boots.ts;
      const parsed = boots.ts ? Date.parse(boots.ts) : NaN;
      row.bootedAgeMs = Number.isFinite(parsed) ? Math.max(0, nowMs - parsed) : undefined;
      row.headSha = boots.headSha;
    }
    return row;
  });

  // "the sha the LIVE process booted at" presupposes a live process — a daemon that is not
  // currently running has no running HEAD to compare, no matter what its last recorded boot
  // said (that boot could be hours stale itself). Gated on `running`, not merely "has a
  // daemon.boot line ever", so this never reports fresh/stale for a daemon that isn't up.
  const daemonRow = services.find((s) => s.service === "daemon")!;
  let headVsOriginMain: StaleFlag = { status: "unknown" };
  if (daemonRow.running && boots.headSha) {
    const originSha = resolveOriginMainSha(deps.repoDir);
    if (originSha) {
      headVsOriginMain = sameCommit(boots.headSha, originSha) ? { status: "fresh" } : { status: "stale", headSha: boots.headSha, originSha };
    }
  }

  const crashLoop = detectDaemonCrashLoop(boots.allTimestamps, crashLoopWindow);

  const livenessCtx: LivenessCtx = { services, headVsOriginMain, crashLoop };
  const liveness: LivenessSection = {
    services,
    headVsOriginMain,
    crashLoop,
    nextAction: pickNextAction(LIVENESS_NEXT_ACTIONS, livenessCtx),
  };

  // ── LATCHES ──
  const rows = buildLatchRows(root, nowMs, isPidAlive);
  const latchesSection: LatchesSection = { rows, nextAction: undefined };
  latchesSection.nextAction = pickNextAction(LATCHES_NEXT_ACTIONS, latchesSection);

  // ── LAST CYCLE ──
  const lastCycleTsParsed = lastCycleRaw.ts ? Date.parse(lastCycleRaw.ts) : NaN;
  const lastCycle: LastCycleSection = {
    found: lastCycleRaw.summary !== undefined,
    summary: lastCycleRaw.summary,
    ts: lastCycleRaw.ts,
    ageMs: Number.isFinite(lastCycleTsParsed) ? Math.max(0, nowMs - lastCycleTsParsed) : undefined,
  };
  lastCycle.nextAction = pickNextAction(LAST_CYCLE_NEXT_ACTIONS, lastCycle);

  // ── W1-T280 (DERIVED half) ──
  const plan = deps.plan ?? tryLoadDefaultPlan(deps.repoDir);
  const { projections, unknownReason: ghUnknownReason } = projectPlanOnce(plan, deps.github, ledgerPath, lines, now);
  const queueHeadLimit = deps.queueHeadLimit ?? 5;

  const blockers = deriveBlockers(lines, projections, queueHeadLimit);
  const queueHead = deriveQueueHead(plan, lines, projections, ghUnknownReason, queueHeadLimit);
  const grepAnchorTrue = deps.grepAnchorTrue ?? ((a: EvidenceAnchor) => gitGrepAnchorTrue(deps.repoDir, "origin/main", a));
  const readProposalRegistry =
    deps.readProposalRegistry ?? (() => parseProposalRegistry(readTextFileIfExists(join(root, "state", "inbox-proposals.json"))));
  const readDraftCache = deps.readDraftCache ?? (() => parseDraftCache(readTextFileIfExists(join(root, "state", "inbox-drafts.json"))));
  const inbox = deriveInbox(plan, lines, projections, ghUnknownReason, readProposalRegistry, readDraftCache, grepAnchorTrue);
  const headroom = deriveHeadroom(lines, nowMs, (deps.resolveHeadroomEnabled ?? (() => true))());

  return {
    generatedAt: new Date(nowMs).toISOString(),
    liveness,
    latches: latchesSection,
    lastCycle,
    blockers,
    queueHead,
    inbox,
    headroom,
  };
}

// ── renderStatusBoardText — the TEXT renderer, projecting the SAME model `--json` emits ──────────

function formatAgeMs(ms: number | undefined): string {
  if (ms === undefined) return "unknown";
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${sec}s`;
  return `${sec}s`;
}

function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 12) : "unknown";
}

function renderLivenessBlock(l: LivenessSection): string[] {
  const out = ["── LIVENESS ─────────────────────────────────────────────"];
  for (const s of l.services) {
    const bootPart =
      s.service === "daemon" ? ` — boot ${s.bootedAt ? `${formatAgeMs(s.bootedAgeMs)} ago` : "unknown"} (${shortSha(s.headSha)})` : "";
    out.push(`${s.service.padEnd(16)}: ${s.running ? `running (pid ${s.pid ?? "unknown"})` : "not running"}${bootPart}`);
  }
  const stale = l.headVsOriginMain;
  out.push(
    `head vs origin/main : ${
      stale.status === "unknown" ? "unknown" : stale.status === "fresh" ? "fresh" : `STALE (${shortSha(stale.headSha)} vs ${shortSha(stale.originSha)})`
    }`,
  );
  out.push(
    `crash-loop           : ${
      l.crashLoop.breached ? `BREACHED (${l.crashLoop.windowBoots.length} boots in ${Math.round(l.crashLoop.windowMs / 60_000)}m)` : "clear"
    }`,
  );
  if (l.nextAction) out.push(`next action: ${l.nextAction}`);
  return out;
}

function renderLatchesBlock(latches: LatchesSection): string[] {
  const out = ["── LATCHES ──────────────────────────────────────────────"];
  if (!latches.rows.length) {
    out.push("no active latches");
  } else {
    for (const r of latches.rows) out.push(`${r.name}, ${formatAgeMs(r.ageMs)} — ${r.consequence}`);
  }
  if (latches.nextAction) out.push(`next action: ${latches.nextAction}`);
  return out;
}

function renderLastCycleBlock(lc: LastCycleSection): string[] {
  const out = ["── LAST CYCLE ───────────────────────────────────────────"];
  if (!lc.found || !lc.summary) {
    out.push("no cycle recorded");
  } else {
    const s = lc.summary;
    out.push(`attempted : ${s.attempted.length ? s.attempted.join(", ") : "(none)"}`);
    out.push(`merged    : ${s.merged.length ? s.merged.join(", ") : "(none)"}`);
    out.push(`stopped   : ${s.stopReason}${s.stopDetail ? ` — ${s.stopDetail}` : ""}`);
    out.push(`cost      : notional $${s.costUsd.toFixed(4)}`);
    out.push(`ticks     : ${s.ticks}`);
    out.push(`age       : ${formatAgeMs(lc.ageMs)} ago`);
  }
  if (lc.nextAction) out.push(`next action: ${lc.nextAction}`);
  return out;
}

function renderBlockersBlock(b: BlockersSection): string[] {
  const out = ["── BLOCKERS BY CLASS ────────────────────────────────────"];
  const circuitBroken = b.rows.filter((r): r is CircuitBrokenBlocker => r.kind === "circuit_broken");
  const blockedPrs = b.rows.filter((r): r is BlockedPrBlocker => r.kind === "blocked_pr");
  const indeterminate = b.rows.filter((r): r is IndeterminateBlocker => r.kind === "indeterminate");
  if (circuitBroken.length === 0 && blockedPrs.length === 0 && indeterminate.length === 0) {
    out.push("no blockers");
  }
  for (const r of circuitBroken) out.push(`circuit-broken : ${r.taskId} — ${r.resetNote}`);
  for (const r of blockedPrs) out.push(`blocked PR     : #${r.prNumber}${r.taskId ? ` (${r.taskId})` : ""} [${r.disposition}] — ${r.reason}`);
  for (const r of indeterminate) out.push(`indeterminate  : ${r.taskId} — ${r.ghWindowNote}`);
  if (b.nextAction) out.push(`next action: ${b.nextAction}`);
  return out;
}

function renderQueueHeadBlock(q: QueueHeadSection): string[] {
  const out = ["── QUEUE HEAD ───────────────────────────────────────────"];
  if (q.unknownReason) {
    out.push(`unknown — ${q.unknownReason}`);
  } else if (q.rows.length === 0) {
    out.push("nothing dispatchable");
  } else {
    for (const r of q.rows) {
      const cost = r.observedPerCycleCostUsd !== undefined ? `, ~$${r.observedPerCycleCostUsd.toFixed(4)}/cycle` : "";
      const flag = r.perpetual ? ` — PERPETUAL (attempts ${r.attempts}${cost})` : ` (attempts ${r.attempts})`;
      out.push(`${r.taskId} — ${r.title}${flag}`);
    }
  }
  if (q.nextAction) out.push(`next action: ${q.nextAction}`);
  return out;
}

function renderInboxBlock(i: InboxSection): string[] {
  const out = ["── INBOX ────────────────────────────────────────────────"];
  if (i.unknownReason) {
    out.push(`unknown — ${i.unknownReason}`);
  } else {
    out.push(`ready: ${i.readyCount}, not ready: ${i.notReadyCount}`);
    if (i.headNotReadyReason) out.push(`head not-ready reason: ${i.headNotReadyReason}`);
  }
  if (i.nextAction) out.push(`next action: ${i.nextAction}`);
  return out;
}

function renderHeadroomBlock(h: HeadroomSection): string[] {
  const out = ["── HEADROOM ─────────────────────────────────────────────"];
  out.push(`enforcement : ${h.enforced ? "ON" : "OFF"}`);
  if (!h.found || !h.telemetry) {
    out.push("no headroom telemetry yet");
  } else {
    const t = h.telemetry;
    out.push(`window      : ${t.window}`);
    out.push(`used        : ${t.percentUsed}% (limit ${t.limitPct}%)`);
    if (t.resetsAt) out.push(`resets at   : ${t.resetsAt}`);
    if (t.note) out.push(`note        : ${t.note}`);
    out.push(`age         : ${formatAgeMs(h.ageMs)} ago`);
  }
  if (h.nextAction) out.push(`next action: ${h.nextAction}`);
  return out;
}

/** The text projection of {@link StatusBoardModel} — every field it prints comes off the model
 *  passed in, never a fresh read, so `--json` and the default text output can never disagree
 *  (they are the SAME derivation, rendered twice). */
export function renderStatusBoardText(model: StatusBoardModel): string {
  const lines: string[] = [`### rmd status — ${model.generatedAt}`, ""];
  lines.push(...renderLivenessBlock(model.liveness), "");
  lines.push(...renderLatchesBlock(model.latches), "");
  lines.push(...renderLastCycleBlock(model.lastCycle), "");
  lines.push(...renderBlockersBlock(model.blockers), "");
  lines.push(...renderQueueHeadBlock(model.queueHead), "");
  lines.push(...renderInboxBlock(model.inbox), "");
  lines.push(...renderHeadroomBlock(model.headroom));
  return lines.join("\n");
}
