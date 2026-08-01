/**
 * lib/status-board.ts — `rmd status`, half 1 of 2 (W1-T279, MASTER-PLAN §7/§5D).
 *
 * ONE READ MODEL, TWO RENDERERS. {@link buildStatusBoard} returns a plain data object
 * ({@link StatusBoardModel}); the text renderer ({@link renderStatusBoardText}) and `--json`
 * (a bare `JSON.stringify` of the same model, run-task.ts's `statusCommand`) both project THAT
 * — no second derivation, so the console's future Now tab (fb-1784770111145-cf7c24) can never
 * disagree with the terminal (the W1-T262 one-coherent-story discipline, applied to this
 * surface).
 *
 * LOCAL TRUTH ONLY, OFFLINE-SAFE. Every read here is the filesystem, the ledger, or a launchd
 * process query injected by the caller — never a blocking network call. The `origin/main`
 * comparison below is a LOCAL `git rev-parse` (no `git fetch`), deliberately: this half must
 * exit 0 with the daemon down and the network off. Where a fact cannot be resolved (a pid
 * unreadable, `origin/main` unresolvable, no `daemon.boot` line yet) the model carries an
 * explicit `"unknown"` / absent field, never a zero or a healthy-looking default rendered as
 * fact (the W1-T262 honesty rule: an unknown that LOOKS healthy is exactly the ~17h
 * DEPLOY_FAILED-invisible failure this task exists to retire).
 *
 * RENDERS, NEVER SENSES. Every fact this module reports is already written down somewhere —
 * fleet-control.ts's STOP/PAUSE/QUIET_HOURS flags, deployer.ts's DEPLOY_FAILED/DEPLOY_AUTO
 * markers, inflight-lock.ts's per-task locks, fleet-control.ts's pending kicks/drain-now
 * markers, and daemon.ts's own `daemon.boot`/`daemon.summary` ledger lines +
 * `detectDaemonCrashLoop`. This module reads and assembles; it invents no new sensor.
 *
 * NEXT ACTION TABLES are POLICY AS DATA (rule 2): each section's `nextAction` is picked by
 * scanning an ordered list of `{applies, action}` rules and taking the FIRST match — a new
 * condition is a new table row, never a new branch buried in a renderer. No rule matches, no
 * line: a board that always prints advice trains the operator to skip it.
 *
 * SCOPE FENCE: the derived/remote half (BLOCKERS BY CLASS, QUEUE HEAD, INBOX, HEADROOM) is
 * W1-T280 and APPENDS to this same model — this module ships no GitHub read.
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
import { drainNowFilePath, pauseFilePath, pendingKicks, quietHoursFilePath, stopFilePath } from "./fleet-control.js";
import { readInflightLock } from "./inflight-lock.js";
import { readLedgerLines, type LedgerReader } from "./status.js";

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

export interface StatusBoardModel {
  generatedAt: string;
  liveness: LivenessSection;
  latches: LatchesSection;
  lastCycle: LastCycleSection;
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

  return {
    generatedAt: new Date(nowMs).toISOString(),
    liveness,
    latches: latchesSection,
    lastCycle,
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

/** The text projection of {@link StatusBoardModel} — every field it prints comes off the model
 *  passed in, never a fresh read, so `--json` and the default text output can never disagree
 *  (they are the SAME derivation, rendered twice). */
export function renderStatusBoardText(model: StatusBoardModel): string {
  const lines: string[] = [`### rmd status — ${model.generatedAt}`, ""];
  lines.push(...renderLivenessBlock(model.liveness), "");
  lines.push(...renderLatchesBlock(model.latches), "");
  lines.push(...renderLastCycleBlock(model.lastCycle));
  return lines.join("\n");
}
