import { execFileSync } from "node:child_process";
import { execFileLoopBounded } from "./loop-bounded-child.js";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { describeActorEvidence, gatherActorEvidence, readActorEvidence, type ActorEvidence, type ActorEvidenceProbe } from "./actor-evidence.js";
import { fixedClock, systemClock } from "./clock.js";
import { repoScopedTaskKey } from "./ledger.js";
import { assertLiveWriteAllowed } from "./live-write-guard.js";

/**
 * Fleet controls (MASTER-PLAN §4A/§4B; W1-T11/W1-T12): STOP wins over PAUSE each
 * drain tick. PAUSE prevents new spawns while in-flight work completes through merge;
 * STOP is the hard-kill intent, logged separately, though the original single-task
 * drain observes both at the same spawn boundary. Resume clears both.
 * W3-T5 (§7/§9): quiet hours defaults OFF and independently defers daemon dispatch
 * via dispatch-governor.ts; drainage/in-flight work continue. Resume preserves it.
 * Flags under `<root>/state/` gate by existence, even when corrupt/unreadable:
 * fail closed, with no lock liveness/staleness semantics.
 */

export interface FleetControlInfo {
  actor_evidence?: ActorEvidence;
  reason?: string;
  requestedAt: string;
  pid: number;
  host: string;
  /** W1-T4429 design (i): PAUSE owner session supplements pid/host after the setter exits. */
  sessionId?: string;
  /** W1-T4429 design (i)/(ii): PAUSE expiry from --until or reason class; null means
   * indefinite (escalates, never lapses). See classifyPauseReason/evaluatePauseTier. */
  expiresAt?: string | null;
  indefinite?: boolean;
  /** W1-T7727: registry instance held by this root's PAUSE (pause-target.ts). */
  instance?: string;
}

export function stopFilePath(root: string): string {
  return join(root, "state", "STOP");
}

export function pauseFilePath(root: string): string {
  return join(root, "state", "PAUSE");
}

export function quietHoursFilePath(root: string): string {
  return join(root, "state", "QUIET_HOURS");
}

/** PAUSE-only metadata; omitted for STOP/quiet-hours to preserve their disk shape. */
interface PauseFlagExtra {
  actor_evidence: ActorEvidence;
  sessionId: string;
  expiresAt: string | null;
  indefinite: boolean;
  instance?: string;
}

function writeFlag(path: string, reason: string | undefined, extra?: PauseFlagExtra): FleetControlInfo {
  const info: FleetControlInfo = {
    reason,
    requestedAt: new Date().toISOString(),
    pid: process.pid,
    host: hostname(),
    ...(extra ? { sessionId: extra.sessionId, expiresAt: extra.expiresAt, indefinite: extra.indefinite, actor_evidence: extra.actor_evidence } : {}),
    ...(extra?.instance === undefined ? {} : { instance: extra.instance }),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(info, null, 2));
  return info;
}

/** Best-effort read; a missing/garbage file is `null` (the CALLER decides what that means). */
function readFlag(path: string): FleetControlInfo | null {
  try {
    const o = JSON.parse(readFileSync(path, "utf8"));
    return typeof o?.requestedAt === "string" ? (o as FleetControlInfo) : null;
  } catch {
    return null;
  }
}

function clearFlag(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false; // another actor cleared it concurrently — treat as already-clear
  }
}

/** `rmd stop [--reason <text>]` — write the STOP flag. */
export function requestStop(root: string, reason?: string): FleetControlInfo {
  return writeFlag(stopFilePath(root), reason);
}

// ── W1-T4429: OWNER, REASON AND EXPIRY (design (i)) ─────────────────────────────────────────────
//
// A PAUSE MUST NAME WHO SET IT, WHY, AND UNTIL WHEN. MEASURED 2026-09-24: a hold set at 02:42:32Z by
// pid 2770992 (gone within minutes) stood for four hours because nothing recorded an owner or an
// expiry — clearing it needed an operator to GUESS it was abandoned. Everything below computes the
// two facts `requestPause` (and the shared anchor `mintAnchor` mints alongside it) now records.

/** W1-T4429 design (i): reason classes select default TTLs. Incidents escalate sooner
 * than maintenance/releases; even the `other` floor catches the 2026-09-24 four-hour stall. */
export type PauseReasonClass = "incident" | "release" | "maintenance" | "other";

/** Class TTLs apply only without explicit --until, which always wins. */
export const PAUSE_DEFAULT_TTL_MS: Readonly<Record<PauseReasonClass, number>> = {
  incident: 60 * 60 * 1000,
  release: 4 * 60 * 60 * 1000,
  maintenance: 4 * 60 * 60 * 1000,
  other: 2 * 60 * 60 * 1000,
};

/** Keyword defaults only: unknown/missing reasons use `other` (shortest non-incident TTL).
 * Explicit --until overrides classification, preserving operator-specified holds. */
export function classifyPauseReason(reason: string | undefined): PauseReasonClass {
  const text = (reason ?? "").toLowerCase();
  if (/incident|outage|urgent|sev[\s-]?1|fire/.test(text)) return "incident";
  if (/release|deploy|rollout/.test(text)) return "release";
  if (/maintenance|migrat|upgrad/.test(text)) return "maintenance";
  return "other";
}

/** Resolve --until or class TTL; --indefinite gives null expiry and never lapses (design (ii)). */
export function resolvePauseExpiry(
  reason: string | undefined,
  until: string | undefined,
  now: Date,
): { expiresAt: string | null; indefinite: boolean } {
  if (until === "indefinite") return { expiresAt: null, indefinite: true };
  if (until) {
    const parsedMs = Date.parse(until);
    if (!Number.isNaN(parsedMs)) return { expiresAt: fixedClock(parsedMs).iso(), indefinite: false };
  }
  const ttlMs = PAUSE_DEFAULT_TTL_MS[classifyPauseReason(reason)];
  return { expiresAt: fixedClock(now.getTime() + ttlMs).iso(), indefinite: false };
}

/** W1-T4429 design (i): REMUDERO_SESSION_ID, else host-pid, supplements pid/host ownership. */
function resolvePauseOwnerSessionId(): string {
  const env = process.env.REMUDERO_SESSION_ID?.trim();
  return env ? env : `${hostname()}-${process.pid}`;
}

/** Explicit --until (ISO instant or "indefinite") and an injectable test clock. */
export interface RequestPauseOptions {
  actorProbe?: ActorEvidenceProbe;
  until?: string;
  now?: Date;
  /** W1-T7727 — the registry instance being paused, recorded in the flag. */
  instance?: string;
}

/**
 * Write the local PAUSE first, with owner/reason/expiry (W1-T4429 design (i)). Optional
 * deps also pushes that metadata in the shared anchor body. Local pause remains effective
 * when origin is unreachable; the shared push is best-effort. See requestFleetPause for CLI scope.
 */
export function requestPause(
  root: string,
  reason?: string,
  deps?: SharedPauseGitDeps,
  options?: RequestPauseOptions,
): FleetControlInfo {
  const now = options?.now ?? systemClock.date();
  const { expiresAt, indefinite } = resolvePauseExpiry(reason, options?.until, now);
  const sessionId = resolvePauseOwnerSessionId();
  const actor_evidence = gatherActorEvidence(options?.actorProbe);
  const info = writeFlag(pauseFilePath(root), reason, { sessionId, expiresAt, indefinite, instance: options?.instance, actor_evidence });
  if (deps) writeSharedPause(deps, { reason, expiresAt, indefinite, sessionId, actor_evidence });
  return info;
}

/** What {@link requestFleetPause} pushed: the same owner/reason/expiry a PAUSE flag records. */
export interface FleetPauseResult {
  actor_evidence: ActorEvidence;
  pushed: boolean;
  sessionId: string;
  expiresAt: string | null;
  indefinite: boolean;
}

/**
 * W1-T7727: explicit `rmd pause --fleet` pushes refs/rmd-pause/hold for every instance
 * sharing origin (core/site/console included), without a local flag. Default CLI pause
 * targets one instance via pause-target.ts. A failed fleet push held nothing: report failure.
 */
export function requestFleetPause(deps: SharedPauseGitDeps, reason?: string, options?: RequestPauseOptions): FleetPauseResult {
  const now = options?.now ?? systemClock.date();
  const { expiresAt, indefinite } = resolvePauseExpiry(reason, options?.until, now);
  const sessionId = resolvePauseOwnerSessionId();
  const actor_evidence = gatherActorEvidence(options?.actorProbe);
  return { pushed: writeSharedPause(deps, { reason, expiresAt, indefinite, sessionId, actor_evidence }), sessionId, expiresAt, indefinite, actor_evidence };
}

/** W1-T7727 — `rmd resume --fleet`: delete the fleet-wide hold, touching no instance's flags. */
export function resumeFleetWide(deps: SharedPauseGitDeps): boolean {
  return clearSharedPause(deps);
}

/** Gate predicate: existence alone, independent of whether the JSON parses (fail CLOSED). */
export function isStopped(root: string): boolean {
  return existsSync(stopFilePath(root));
}

/** Gate predicate: existence alone, independent of whether the JSON parses (fail CLOSED). */
export function isPaused(root: string): boolean {
  return existsSync(pauseFilePath(root));
}

/** Gate predicate: existence alone, independent of whether the JSON parses (fail CLOSED). */
export function isQuietHours(root: string): boolean {
  return existsSync(quietHoursFilePath(root));
}


/** Human-readable ledger/summary detail when STOPPED; `undefined` when not. */
export function stopDetail(root: string): string | undefined {
  if (!isStopped(root)) return undefined;
  const info = readFlag(stopFilePath(root));
  return info?.reason ? `STOP requested: ${info.reason}` : "STOP file present — run `rmd resume` to clear";
}

/** Human-readable ledger/summary detail when PAUSED; `undefined` when not. */
/** The detail {@link pauseDetail} renders for deploy/recycle-container.sh's own PAUSE (W1-T5127). */
const RECYCLE_PAUSE_DETAIL = "PAUSE requested: container recycle (deploy/recycle-container.sh)";

/** W1-T5804: whether an already-read PAUSE detail is the recycle's own. Exact match: an operator hold
 *  that merely mentions the script is still an operator hold. */
export function isRecyclePauseDetail(detail: string | undefined): boolean {
  const actorAt = detail?.lastIndexOf("; actor: ") ?? -1;
  return detail === RECYCLE_PAUSE_DETAIL || (actorAt >= 0 && detail?.slice(0, actorAt) === RECYCLE_PAUSE_DETAIL);
}

export function pauseActor(root: string): string | undefined {
  if (!isPaused(root)) return undefined;
  return describeActorEvidence(readFlag(pauseFilePath(root))?.actor_evidence);
}

export function pauseDetail(root: string): string | undefined {
  if (!isPaused(root)) return undefined;
  const info = readFlag(pauseFilePath(root));
  const detail = info?.reason ? `PAUSE requested: ${info.reason}` : "PAUSE file present — run `rmd resume` to clear";
  // Legacy recycle scripts write a machine-consumed sentinel; pauseActor and the board still expose its missing actor.
  if (detail === RECYCLE_PAUSE_DETAIL && info?.actor_evidence === undefined) return detail;
  return `${detail}; actor: ${describeActorEvidence(info?.actor_evidence)}`;
}

/** W3-T5: quiet-hours on/off writes/clears an independent preference; returns its new state. */
export function setQuietHours(root: string, enabled: boolean): boolean {
  if (enabled) {
    writeFlag(quietHoursFilePath(root), undefined);
    return true;
  }
  clearFlag(quietHoursFilePath(root));
  return false;
}


/** One-shot STOP: the observing drain clears it in drainCommand/daemonCommand finally,
 * so it cannot block a future drain. PAUSE persists until resume. Idempotent; clears only STOP. */
export function consumeStop(root: string): boolean {
  return clearFlag(stopFilePath(root));
}

export interface ResumeResult {
  clearedStop: boolean;
  clearedPause: boolean;
  /** Shared delete result only when deps was supplied; otherwise omitted, preserving legacy shape. */
  clearedSharedPause?: boolean;
}

/**
 * Idempotently clear one instance's STOP/PAUSE first, even offline. W1-T7727: CLI resume
 * supplies no deps; fleet resume uses resumeFleetWide. Explicit deps preserves W1-T1216's
 * best-effort shared delete after local clears. Quiet hours is untouched.
 */
export function resumeFleet(root: string, deps?: SharedPauseGitDeps): ResumeResult {
  const clearedStop = clearFlag(stopFilePath(root));
  const clearedPause = clearFlag(pauseFilePath(root));
  if (!deps) return { clearedStop, clearedPause };
  return { clearedStop, clearedPause, clearedSharedPause: clearSharedPause(deps) };
}

// ── SHARED CROSS-HOST PAUSE (W1-T1216) ────────────────────────────────────────
// Local state/ is gitignored and root differs across mini/Azure hosts; local PAUSE cannot travel.
// Design (i): shared control supplements offline local control. Local operator holds win first.
// Rationale (9)/(10): one fleet ref mirrors auto-triage.ts/task-id-reservation.ts namespaces,
// using ls-remote rather than clone/fetch. Concurrent pausers both want held; either push wins.
// Design (ii): measured absent=exit 0/no lines, held=exit 0/one line, unreachable=exit 128.
// Unreachable holds dispatch, just as reserveTaskIdRemote refuses to mint after a failed read.
// Design (iii): STOP stays local/one-shot (consumeStop); sharing it could outlive its drain.

/** Single fleet hold, outside heads/default clone/fetch namespaces (like refs/rmd-id/
 * and refs/rmd-triage/); invisible to reapBranchesCommand's ls-remote --heads sweep. */
export function sharedPauseRef(): string {
  return "refs/rmd-pause/hold";
}

/** Failed reads are unreachable, never absent; see W1-T1216 design (ii) above. */
export type SharedPauseRead = "absent" | "held" | "unreachable";

/** Shared I/O contract (like auto-triage.ts's TriageClaimReserver): run must return
 * nonzero for unreachable, never throw; throws are indistinguishable from programmer errors. */
/** W1-T4429 design (i): optional anchor-body metadata beside the legacy pid/host/time line.
 * Omitting info preserves the legacy one-line message. */
export interface SharedPauseMintInfo {
  actor_evidence?: ActorEvidence;
  reason?: string;
  sessionId?: string;
  /** null emits `expires: indefinite` (design (ii)); undefined emits no expires line. */
  expiresAt?: string | null;
  indefinite?: boolean;
}

export interface SharedPauseGitDeps {
  /** Runs a git argv against `origin`; returns its exit status and stdout, verbatim. */
  run(args: string[]): { status: number; stdout: string };
  /** Nonblocking read leaf. Production supplies this; synchronous fixtures retain their seam. */
  runAsync?(args: string[]): Promise<{ status: number; stdout: string }>;
  /** Mint an orphan commit over the empty tree, like TriageClaimReserver.mintAnchor;
   * fakes may return a fixed string. W1-T4429: optional info goes in the commit body. */
  mintAnchor(info?: SharedPauseMintInfo): string;
}

/** PRIMARY CONTROL: shared-pause reads are bounded scheduler health probes. Credential,
 * DNS or transport stalls must return unreachable without freezing review lanes. Keep below
 * normal daemon poll cadence, allowing an ordinary Git round trip; tests may inject run. */
export const SHARED_PAUSE_GIT_TIMEOUT_MS = 10_000;

/** Live git scoped to repoRoot. Reuse gitTriageClaimReserver's empty-tree hash-object /
 * orphan commit-tree recipe so operators can inspect a stuck hold with familiar git show. */
export function realSharedPauseGitDeps(repoRoot: string): SharedPauseGitDeps {
  const argv = (args: string[]): string[] => ["-C", repoRoot, ...args];
  const run = (args: string[]): { status: number; stdout: string } => {
    // `repoRoot` follows the cwd, so a test driving `rmd pause`/`resume` from a fleet worktree
    // targets the LIVE origin; 2026-09-24 a worker's test run held every daemon for 32 minutes.
    if (args[0] === "push") assertLiveWriteAllowed("git-push", `${args.at(-1)} on ${repoRoot}'s origin`);
    try {
      const stdout = execFileSync("git", argv(args), {
        encoding: "utf8",
        timeout: SHARED_PAUSE_GIT_TIMEOUT_MS,
        killSignal: "SIGTERM",
      });
      return { status: 0, stdout };
    } catch (e) {
      // `execFileSync` reports a timeout with `status: null` and `code: "ETIMEDOUT"`; preserve
      // the existing non-zero outcome contract rather than letting a timed read throw through the
      // daemon tick.  `checkSharedPause` will hold dispatch fail-closed, but the loop remains alive.
      const status = typeof (e as { status?: number })?.status === "number" ? (e as { status: number }).status : 1;
      return { status, stdout: "" };
    }
  };
  return {
    run,
    runAsync: (args) => new Promise((resolve) => {
      if (args[0] === "push") assertLiveWriteAllowed("git-push", `${args.at(-1)} on ${repoRoot}'s origin`);
      execFileLoopBounded("git", argv(args), {
        encoding: "utf8",
        timeout: SHARED_PAUSE_GIT_TIMEOUT_MS,
        killSignal: "SIGTERM",
      }).then(
        ({ stdout }) => resolve({ status: 0, stdout }),
        // Exit failures, timeouts and spawn failures all mean the read was unreachable.
        (error: { code?: unknown }) => resolve({ status: typeof error.code === "number" ? error.code : 1, stdout: "" }),
      );
    }),
    mintAnchor(info?: SharedPauseMintInfo) {
      const tree = run(["hash-object", "-t", "tree", "/dev/null"]).stdout.trim();
      // The FIRST line is the exact legacy shape (`ANCHOR_MESSAGE_RE` below still matches it
      // unmodified); every field `info` supplies (design (i): owner/reason/expiry, "in the ref's
      // commit body") is one MORE line, so an anchor minted with no `info` at all — every fixture
      // that predates W1-T4429 — mints the identical one-line message it always did.
      const lines = [`rmd-pause hold ${process.pid}@${hostname()} ${new Date().toISOString()}`];
      if (info?.sessionId) lines.push(`session: ${info.sessionId}`);
      if (info?.reason) lines.push(`reason: ${info.reason}`);
      if (info?.indefinite) lines.push(`expires: indefinite`);
      else if (info?.expiresAt) lines.push(`expires: ${info.expiresAt}`);
      if (info?.actor_evidence) lines.push(`actor: ${JSON.stringify(info.actor_evidence)}`);
      return run(["commit-tree", tree, "-m", lines.join("\n")]).stdout.trim();
    },
  };
}

/** ls-remote status plus sha, retained for checkSharedPause's setter attribution. */
interface SharedPauseLsRemote {
  status: number;
  /** The ref's current sha, when the read succeeded and the ref exists. */
  sha?: string;
}

function lsRemoteSharedPause(deps: SharedPauseGitDeps): SharedPauseLsRemote {
  return parseSharedPauseLsRemote(deps.run(["ls-remote", "origin", sharedPauseRef()]));
}

function parseSharedPauseLsRemote(res: { status: number; stdout: string }): SharedPauseLsRemote {
  if (res.status !== 0) return { status: res.status };
  const line = res.stdout.trim().split("\n")[0] ?? "";
  const sha = line.split("\t")[0]?.trim();
  return { status: 0, sha: sha || undefined };
}

/** Classify ls-remote per rationale (10); pure given deps, which owns network I/O. */
export function readSharedPause(deps: SharedPauseGitDeps): SharedPauseRead {
  const res = lsRemoteSharedPause(deps);
  if (res.status !== 0) return "unreachable";
  return res.sha ? "held" : "absent";
}

/** Raw anchor message fields; W1-T4429 metadata is optional for legacy/no-info anchors.
 * Parsing only splits committed text; it does not reinterpret the writer's values. */
export interface SharedPauseAnchorInfo {
  actor_evidence?: ActorEvidence;
  pid: string;
  host: string;
  timestamp: string;
  sessionId?: string;
  reason?: string;
  /** null for `expires: indefinite`; undefined for a legacy/omitted expires line. */
  expiresAt?: string | null;
  indefinite?: boolean;
}

/** Exact mintAnchor message; ^/m skips cat-file -p's tree/author/committer headers. */
const ANCHOR_MESSAGE_RE = /^rmd-pause hold (\S+)@(\S+) (\S+)\s*$/m;
// Exported (never only module-private) so a test can drive each one's own unhealthy arm directly —
// a hold minted before W1-T4429 (or by anything that never wrote these lines) is the ordinary case
// these three must correctly read as ABSENT, not just match the happy path.
export const ANCHOR_SESSION_RE = /^session: (.+)$/m;
export const ANCHOR_REASON_RE = /^reason: (.+)$/m;
export const ANCHOR_EXPIRES_RE = /^expires: (.+)$/m;

/**
 * Recover anchor metadata; return null for unreachable/missing/GC'd objects or malformed
 * messages. checkSharedPause still holds on null. W1-T4429 session/reason/expiry lines
 * parse independently: legacy anchors retain pid/host/time with optional fields absent.
 */
export function readSharedPauseAnchor(sha: string, deps: SharedPauseGitDeps): SharedPauseAnchorInfo | null {
  const res = deps.run(["cat-file", "-p", sha]);
  if (res.status !== 0) return null;
  return parseSharedPauseAnchor(res.stdout);
}

function parseSharedPauseAnchor(stdout: string): SharedPauseAnchorInfo | null {
  const m = ANCHOR_MESSAGE_RE.exec(stdout);
  if (!m) return null;
  const info: SharedPauseAnchorInfo = { pid: m[1]!, host: m[2]!, timestamp: m[3]! };
  const session = ANCHOR_SESSION_RE.exec(stdout);
  if (session) info.sessionId = session[1]!.trim();
  const reason = ANCHOR_REASON_RE.exec(stdout);
  if (reason) info.reason = reason[1]!.trim();
  const expires = ANCHOR_EXPIRES_RE.exec(stdout);
  if (expires) {
    const raw = expires[1]!.trim();
    if (raw === "indefinite") {
      info.indefinite = true;
      info.expiresAt = null;
    } else {
      info.expiresAt = raw;
    }
  }
  const actorLine = /^actor: (.+)$/m.exec(stdout);
  if (actorLine) {
    try {
      const actor = readActorEvidence(JSON.parse(actorLine[1]!));
      if (actor) info.actor_evidence = actor;
    } catch (err) {
      // Malformed actor metadata leaves the safety hold intact and its actor explicitly unrecorded.
      void err;
    }
  }
  return info;
}

/** Push sharedPauseRef; concurrent pausers both want held, so no create-if-absent needed.
 * Returns push success. requestPause treats failure as best-effort; requestFleetPause reports it.
 * W1-T4429: pass optional info through to mintAnchor. */
export function writeSharedPause(deps: SharedPauseGitDeps, info?: SharedPauseMintInfo): boolean {
  const anchor = deps.mintAnchor(info);
  // An empty source in <source>:<ref> is Git's delete syntax, not a pause.
  if (anchor.trim() === "") return false;
  return deps.run(["push", "origin", `${anchor}:${sharedPauseRef()}`]).status === 0;
}

/** Return shared-delete success. resumeFleet's local clears already ran (design (iv));
 * a failed best-effort delete cannot undo them. */
export function clearSharedPause(deps: SharedPauseGitDeps): boolean {
  return deps.run(["push", "origin", `:${sharedPauseRef()}`]).status === 0;
}

/** W1-T3622: cache attribution (including null) per deps/sha. Production realDeps memoizes
 * one ComposedRealGraph via ??= for its lifetime; WeakMap isolates unrelated fixtures even
 * with identical fake shas. Retry only on a changed sha, never on elapsed time. */
const sharedPauseAnchorMemos = new WeakMap<SharedPauseGitDeps, Map<string, SharedPauseAnchorInfo | null>>();

/** Resolve once per immutable anchor sha; only a fresh hold warrants a new read. */
function sharedPauseAnchorMemo(deps: SharedPauseGitDeps): Map<string, SharedPauseAnchorInfo | null> {
  let memo = sharedPauseAnchorMemos.get(deps);
  if (!memo) {
    memo = new Map();
    sharedPauseAnchorMemos.set(deps, memo);
  }
  return memo;
}

function resolveSharedPauseAnchor(sha: string, deps: SharedPauseGitDeps): SharedPauseAnchorInfo | null {
  const memo = sharedPauseAnchorMemo(deps);
  if (memo.has(sha)) return memo.get(sha)!;
  const info = readSharedPauseAnchor(sha, deps);
  memo.set(sha, info);
  return info;
}

/** Refresh cadence independent of daemon poll cadence; slow reads never overlap. */
export const SHARED_PAUSE_REFRESH_MS = 1_000;

interface SharedPauseRefresh {
  detail: string | undefined;
  nextReadAt: number;
  inFlight: boolean;
  pending?: Promise<void>;
  timer?: NodeJS.Timeout;
  stopped?: boolean;
}

const sharedPauseRefreshes = new WeakMap<SharedPauseGitDeps, SharedPauseRefresh>();

async function refreshSharedPause(deps: SharedPauseGitDeps, state: SharedPauseRefresh): Promise<void> {
  try {
    const ls = parseSharedPauseLsRemote(await deps.runAsync!(["ls-remote", "origin", sharedPauseRef()]));
    let anchor: SharedPauseAnchorInfo | null = null;
    if (ls.status === 0 && ls.sha) {
      const memo = sharedPauseAnchorMemo(deps);
      if (!memo.has(ls.sha)) {
        try {
          const res = await deps.runAsync!(["cat-file", "-p", ls.sha]);
          memo.set(ls.sha, res.status === 0 ? parseSharedPauseAnchor(res.stdout) : null);
        } catch (error) {
          // An anchor read failure loses attribution, never the known held verdict.
          memo.set(ls.sha, null);
        }
      }
      anchor = memo.get(ls.sha)!;
    }
    state.detail = sharedPauseReadDetail(ls, anchor);
  } catch (error) {
    // A rejected read has no verdict either: hold exactly as for a nonzero git exit.
    state.detail = sharedPauseReadDetail({ status: 1 }, null);
  } finally {
    state.inFlight = false;
    if (!state.stopped) {
      state.timer = setTimeout(() => beginSharedPauseRefresh(deps, state),
        Math.max(0, state.nextReadAt - systemClock.now()));
      state.timer.unref();
    }
  }
}

function beginSharedPauseRefresh(deps: SharedPauseGitDeps, state: SharedPauseRefresh): void {
  clearTimeout(state.timer);
  state.inFlight = true;
  state.nextReadAt = systemClock.now() + SHARED_PAUSE_REFRESH_MS;
  state.pending = refreshSharedPause(deps, state);
}

/** Await the first verdict at command startup without blocking other event-loop work. */
export async function prepareSharedPause(root: string, deps: SharedPauseGitDeps): Promise<void> {
  checkSharedPause(root, deps);
  await sharedPauseRefreshes.get(deps)?.pending;
}

/** Stop refreshes at command exit, including a read that completes after shutdown. */
export function disposeSharedPauseRefresh(deps: SharedPauseGitDeps): void {
  const state = sharedPauseRefreshes.get(deps);
  if (!state) return;
  state.stopped = true;
  clearTimeout(state.timer);
  sharedPauseRefreshes.delete(deps);
}

/**
 * Daemon/drain supplier: local operator holds win immediately; a recycle hold still consults
 * the shared ref. Production answers from its last completed asynchronous read, refreshing
 * every {@link SHARED_PAUSE_REFRESH_MS}. Startup awaits {@link prepareSharedPause}; a caller
 * with no completed verdict holds until a read proves absence. Synchronous fixtures retain
 * their original seam. Held and unreachable verdicts hold dispatch; unreadable anchors hold
 * as UNATTRIBUTABLE. Attribution is memoized per sha, and elapsed time never clears a hold.
 */
export function checkSharedPause(root: string, deps: SharedPauseGitDeps): string | undefined {
  const local = pauseDetail(root);
  // W1-T5804: a recycle's own PAUSE lets the daemon arm and merge, so it must never mask an operator's
  // shared hold. A held (or unreachable) shared read wins over the recycle flag.
  if (local && !isRecyclePauseDetail(local)) return local;
  if (deps.runAsync) {
    let state = sharedPauseRefreshes.get(deps);
    if (!state) {
      // No completed read is not evidence of absence: first-read dispatch stays held.
      state = { detail: sharedPauseReadDetail({ status: 1 }, null), nextReadAt: 0, inFlight: false };
      sharedPauseRefreshes.set(deps, state);
    }
    const now = systemClock.now();
    if (!state.inFlight && now >= state.nextReadAt) {
      beginSharedPauseRefresh(deps, state);
    }
    return state.detail ?? local;
  }
  const ls = lsRemoteSharedPause(deps);
  return sharedPauseReadDetail(ls, ls.sha ? resolveSharedPauseAnchor(ls.sha, deps) : null) ?? local;
}

function sharedPauseReadDetail(ls: SharedPauseLsRemote, anchor: SharedPauseAnchorInfo | null): string | undefined {
  if (ls.status === 0 && ls.sha) {
    if (anchor) {
      // W1-T4429: reason/expiry ride along when the anchor carries them (design (i)) — a bare
      // "set by pid ..." told an operator WHO but never WHY or UNTIL WHEN.
      const reasonPart = anchor.reason ? ` — reason: ${anchor.reason}` : "";
      const untilPart = anchor.indefinite
        ? " — INDEFINITE (escalates, never lapses)"
        : anchor.expiresAt
          ? ` — until ${anchor.expiresAt}`
          : "";
      return (
        `PAUSE held on ${sharedPauseRef()} — set by pid ${anchor.pid}@${anchor.host} at ` +
        `${anchor.timestamp}${reasonPart}${untilPart}; actor: ${describeActorEvidence(anchor.actor_evidence)} — run \`rmd resume --fleet\` to clear`
      );
    }
    return (
      `PAUSE held on ${sharedPauseRef()} — UNATTRIBUTABLE (anchor ${ls.sha} unreadable, setter ` +
      "cannot be recovered) — run `rmd resume --fleet` to clear"
    );
  }
  if (ls.status !== 0) {
    return (
      `cannot reach origin to read ${sharedPauseRef()} — holding rather than dispatching ` +
      `optimistically (an unreachable remote is never read as clear)`
    );
  }
  return undefined;
}

// ── W1-T4429: TIERED, SELF-HEALING ESCALATION (design (ii)) ────────────────────────────────────
//
// NEVER ONE HARD CUTOFF. A pause whose setter is gone must not silently stand forever (the
// MEASURED four-hour stall this task exists to close), but it must also never vanish out from
// under a genuinely deliberate, still-live hold. Three tiers, evaluated fresh every time (no
// internal state — a caller ledgers a TRANSITION, this function only classifies "as of now"):
//   - `orphaned`    — the setter's own process is confirmed dead.
//   - `needs_human` — the hold has stood past HALF its own remaining window; a human is paged,
//                     the hold is NOT yet touched.
//   - `lapsed`      — the hold has run out its full window; THIS is the one tier a caller may act
//                     on by clearing the hold (see daemon.ts's `stepPauseHoldGovernor`).
// An `indefinite` hold (design (ii): "--indefinite only escalates, never lapses") has no expiry to
// measure `needs_human`/`lapsed` against, so it can only ever read `orphaned` or `held`.

export type PauseTier = "held" | "orphaned" | "needs_human" | "lapsed";

/** Pure input for one hold at one instant; supports fabricated timelines without I/O. */
export interface PauseTierInput {
  /** SharedPauseAnchorInfo.timestamp or local requestedAt. */
  setAt: string;
  /** `null` for an indefinite hold; see {@link SharedPauseMintInfo.expiresAt}. */
  expiresAt: string | null;
  indefinite: boolean;
  /** Unknown liveness (e.g. another host) is never evidence of a dead/orphaned setter. */
  setterAlive: boolean | "unknown";
  now: Date;
}

/** Pure W1-T4429 design (ii) classifier: caller supplies now and recovered hold values.
 * daemon.ts's stepPauseHoldGovernor acts on tier transitions; see tier semantics above. */
export function evaluatePauseTier(input: PauseTierInput): PauseTier {
  const { setAt, expiresAt, indefinite, setterAlive, now } = input;
  const nowMs = now.getTime();
  if (!indefinite && expiresAt) {
    const expiryMs = Date.parse(expiresAt);
    if (Number.isFinite(expiryMs)) {
      if (nowMs >= expiryMs) return "lapsed";
      const setAtMs = Date.parse(setAt);
      if (Number.isFinite(setAtMs)) {
        const halfwayMs = setAtMs + (expiryMs - setAtMs) / 2;
        if (nowMs >= halfwayMs) return "needs_human";
      }
    }
  }
  if (setterAlive === false) return "orphaned";
  return "held";
}

// ── CONSOLE WRITE-ACTION MARKERS (fb-1784988460437-9daa9b) ──────────────────────
//
// Operator write-actions on the console's UP NEXT panel use the SAME marker-file
// pattern as STOP/PAUSE and DEPLOY_REQUESTED (deployer.ts) — the console NEVER
// manages a process; it drops a marker the running daemon consumes at its next
// poll. Two kinds:
//   - `state/KICK_REQUESTED-<taskId>` — "Run this queued task now." One file per
//     task id, so several kicks coexist and are dispatched over successive cycles.
//   - `state/DRAIN_REQUESTED` — "run one dispatch cycle immediately."
// Each marker carries the caller's `origin` (bearerTokenId, panel-actions.ts) —
// the arm-identity captured AT BIRTH — so the daemon's consume-time ledger line
// names the console as actor without the daemon ever seeing the raw token.

/** A queued-task "Run now" request, parsed off a `KICK_REQUESTED-<taskId>` (or, once
 *  repo-scoped, `KICK_REQUESTED-<repo>:<taskId>`) marker. */
export interface KickRequest {
  taskId: string;
  /** The console actor id (a bearer-token hash), carried from write to consume. */
  origin: string;
  requestedAt: string;
  /** W1-T429: optional repo scope; absent for legacy markers/callers. See kickFilePath. */
  repo?: string;
}

/** A "Drain now" request, parsed off the `DRAIN_REQUESTED` marker. */
export interface DrainNowRequest {
  origin: string;
  requestedAt: string;
}

/** Safe marker filenames: plan W1-T###/SBX-T# plus safe superset; reject slash, .., NUL,
 * whitespace. Fail closed on write (requestKick throws) and read (pendingKicks skips). */
const SAFE_TASK_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126})$/;

/** True iff `taskId` is safe to embed in a marker filename (see {@link SAFE_TASK_ID}). */
export function isSafeTaskId(taskId: unknown): taskId is string {
  return typeof taskId === "string" && SAFE_TASK_ID.test(taskId) && !taskId.includes("..");
}

/** W1-T429: safe repo filename component, like SAFE_TASK_ID; requestKick rejects traversal. */
const SAFE_REPO_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})$/;

/** True iff `repo` is safe to embed in a marker filename (see {@link SAFE_REPO_NAME}). */
export function isSafeRepoName(repo: unknown): repo is string {
  return typeof repo === "string" && SAFE_REPO_NAME.test(repo) && !repo.includes("..");
}

const KICK_PREFIX = "KICK_REQUESTED-";

// ── CONSOLE PR-ACTION MARKERS ──────────────────────────────────────────────
//
// A selected-repository console never starts a host process. It writes one bounded request the
// repository's daemon consumes at its next normal poll, mirroring `KICK_REQUESTED-*` above. The
// marker contains no command, URL, token, or transcript: only the fixed action, the positive PR
// number and the hashed caller identity that panel-actions.ts captured at birth.

export type PrActionName = "fix" | "review";

export interface PrActionRequest {
  action: PrActionName;
  prNumber: number;
  origin: string;
  requestedAt: string;
  /** W1-T4077: the display name the console reports for who clicked — audit only, never an authorisation input. */
  operator?: string;
}

const PR_ACTION_PREFIX = "PR_ACTION_REQUESTED-";

export function isPrActionName(value: unknown): value is PrActionName {
  return value === "fix" || value === "review";
}

function isSafePrNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** The one marker identity for one operator action against one pull request. */
export function prActionFilePath(root: string, action: PrActionName, prNumber: number): string {
  if (!isPrActionName(action)) throw new Error(`prActionFilePath: unsafe action ${JSON.stringify(action)}`);
  if (!isSafePrNumber(prNumber)) throw new Error(`prActionFilePath: unsafe PR number ${JSON.stringify(prNumber)}`);
  return join(root, "state", `${PR_ACTION_PREFIX}${action}-${prNumber}`);
}

/**
 * Record one idempotent PR action request. Re-requesting the exact action for the exact PR updates
 * its observed request time but cannot create a second concurrent daemon action.
 */
export function requestPrAction(
  root: string,
  action: PrActionName,
  prNumber: number,
  origin: string,
  operator?: string,
): PrActionRequest {
  const request: PrActionRequest = { action, prNumber, origin, requestedAt: systemClock.iso(), ...(operator ? { operator } : {}) };
  const path = prActionFilePath(root, action, prNumber);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(request, null, 2));
  return request;
}

/**
 * Read action requests oldest first without consuming them. The daemon keeps a marker while an
 * established fix/review command is running, so a duplicate click cannot start a parallel worker.
 * Malformed markers are withheld rather than reinterpreted as a host command.
 */
export function pendingPrActions(root: string): PrActionRequest[] {
  const dir = join(root, "state");
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.startsWith(PR_ACTION_PREFIX));
  } catch {
    // The state directory has not been initialized, so there are no durable requests to consume.
    return [];
  }
  const requests: PrActionRequest[] = [];
  for (const name of names) {
    try {
      const value = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (isPrActionName(value?.action) && isSafePrNumber(value?.prNumber) && typeof value?.origin === "string" && typeof value?.requestedAt === "string") {
        requests.push({
          action: value.action,
          prNumber: value.prNumber,
          origin: value.origin,
          requestedAt: value.requestedAt,
          ...(typeof value?.operator === "string" ? { operator: value.operator } : {}),
        });
      }
    } catch {
      // A corrupt state marker is not actionable. Leave it in place for forensic inspection.
    }
  }
  return requests.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

/** W1-T4077: the operator's off switch for one console PR action — a state marker, the same instant, no-PR
 *  pattern as PAUSE. Both actions are on unless their marker exists. */
export function prActionSwitchOffPath(root: string, action: PrActionName): string {
  if (!isPrActionName(action)) throw new Error(`prActionSwitchOffPath: unsafe action ${JSON.stringify(action)}`);
  return join(root, "state", `CONSOLE_PR_ACTION_OFF-${action}`);
}

export function isPrActionSwitchedOff(root: string, action: PrActionName): boolean {
  return existsSync(prActionSwitchOffPath(root, action));
}

/** Clear the one marker the daemon just reached a terminal outcome for. */
export function clearPrAction(root: string, action: PrActionName, prNumber: number): boolean {
  return clearFlag(prActionFilePath(root, action, prNumber));
}

/** W1-T429: optional repoScopedTaskKey yields KICK_REQUESTED-<repo>:<taskId>, preventing
 * shared ids (e.g. wild-trails/this repo's W1-T12) from overwriting/consuming each other's kicks.
 * Omitted repo preserves the legacy KICK_REQUESTED-<taskId> path. */
export function kickFilePath(root: string, taskId: string, repo?: string): string {
  return join(root, "state", `${KICK_PREFIX}${repoScopedTaskKey(repo, taskId)}`);
}

export function drainNowFilePath(root: string): string {
  return join(root, "state", "DRAIN_REQUESTED");
}

/** Write one idempotent kick per (repo, taskId). W1-T429 adds optional repo scope.
 * Reject unsafe task/repo before any side effect. */
export function requestKick(root: string, taskId: string, origin: string, repo?: string): KickRequest {
  if (!isSafeTaskId(taskId)) throw new Error(`requestKick: unsafe task id ${JSON.stringify(taskId)}`);
  if (repo !== undefined && !isSafeRepoName(repo)) throw new Error(`requestKick: unsafe repo ${JSON.stringify(repo)}`);
  const req: KickRequest = { taskId, origin, requestedAt: new Date().toISOString(), ...(repo !== undefined ? { repo } : {}) };
  const path = kickFilePath(root, taskId, repo);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(req, null, 2));
  return req;
}

/** Peek oldest-first without deleting; daemon clearKick dispatches/refuses individually,
 * leaving unserviceable kicks for later cycles. Skip unsafe ids/garbage JSON fail-closed. */
export function pendingKicks(root: string): KickRequest[] {
  const dir = join(root, "state");
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.startsWith(KICK_PREFIX));
  } catch {
    return []; // no state dir yet ⇒ no kicks
  }
  const out: KickRequest[] = [];
  for (const name of names) {
    try {
      const o = JSON.parse(readFileSync(join(dir, name), "utf8"));
      const repo = isSafeRepoName(o?.repo) ? o.repo : undefined;
      if (isSafeTaskId(o?.taskId) && typeof o?.origin === "string" && typeof o?.requestedAt === "string") {
        out.push({ taskId: o.taskId, origin: o.origin, requestedAt: o.requestedAt, ...(repo !== undefined ? { repo } : {}) });
      }
    } catch {
      // garbage marker — leave it for an operator to notice; never dispatch off it.
    }
  }
  return out.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

/** Delete one kick marker (consumed-once). Idempotent; a concurrent clear is not an error.
 *  W1-T429: pass the SAME `repo` the marker was requested with (if any) — omitting it clears the
 *  legacy/unscoped path, which is a DIFFERENT file from a repo-scoped marker's. */
export function clearKick(root: string, taskId: string, repo?: string): boolean {
  return clearFlag(kickFilePath(root, taskId, repo));
}

/** Write the `DRAIN_REQUESTED` marker (the console's "Drain now" button). */
export function requestDrainNow(root: string, origin: string): DrainNowRequest {
  const req: DrainNowRequest = { origin, requestedAt: new Date().toISOString() };
  const path = drainNowFilePath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(req, null, 2));
  return req;
}

/** Read + DELETE the `DRAIN_REQUESTED` marker (consumed-once). `null` when none/garbage. */
export function consumeDrainNow(root: string): DrainNowRequest | null {
  const path = drainNowFilePath(root);
  if (!existsSync(path)) return null;
  let parsed: DrainNowRequest | null = null;
  try {
    const o = JSON.parse(readFileSync(path, "utf8"));
    if (typeof o?.origin === "string" && typeof o?.requestedAt === "string") {
      parsed = { origin: o.origin, requestedAt: o.requestedAt };
    }
  } catch {
    parsed = null;
  }
  clearFlag(path); // consumed-once regardless of parse outcome — a garbage marker never lingers
  return parsed;
}
