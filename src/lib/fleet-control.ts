import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { systemClock } from "./clock.js";
import { repoScopedTaskKey } from "./ledger.js";
import { assertLiveWriteAllowed } from "./live-write-guard.js";

/**
 * Fleet control set (MASTER-PLAN §4A/§4B) — `rmd stop|pause|resume`, plus the
 * quiet-hours toggle (W3-T5, MASTER-PLAN §7/§9).
 *
 * Flag files under `<root>/state/`, checked at the top of every drain tick
 * (lib/drain.ts, W1-T11 acceptance). Mirrors the eventual daemon/panel control
 * set (§4A): **Pause** is drain-and-hold — no new worker spawns, but an
 * in-flight task runs to FULL completion (through verdict and merge) so state
 * stays clean. **Stop** is the hard kill — checked FIRST, every tick, taking
 * precedence over PAUSE — but in this single-task-at-a-time drain loop (W1-T12's
 * daemon does not exist yet) it hits the SAME "no new spawn" boundary as PAUSE;
 * the two are logged distinctly (`drain.stop` vs `drain.pause`) so an operator
 * can tell "holding, resumable" from "operator pulled the plug" apart in the
 * ledger. `rmd resume` clears BOTH flags — the one command that always means go.
 *
 * **Quiet hours** is a THIRD, independent flag (W3-T5): "is now an OPTIONAL
 * wizard toggle, default OFF" (§9) — unlike STOP/PAUSE it does not gate the
 * drain loop. `dispatch-governor.ts` reads it for the daemon's dispatch-only
 * deferral, so new daemon spawns wait while drainage and in-flight work keep
 * completing. `rmd resume` deliberately does NOT touch it — quiet hours is a
 * schedule preference, not an emergency hold, so an operator resuming from a
 * STOP/PAUSE should not silently lose their quiet-hours setting.
 *
 * Plain flag files (not a lock — no liveness/staleness semantics like
 * drain-lock.ts/inflight-lock.ts): existence alone gates the loop, so a
 * corrupt/unreadable file still fails CLOSED (stopped/paused), never open.
 */

export interface FleetControlInfo {
  reason?: string;
  requestedAt: string;
  pid: number;
  host: string;
  /** W1-T4429 — design (i)'s "owner (session/host/pid)": a session id alongside pid/host, so a hold
   *  outliving the process that set it still names something more specific than a bare pid a daemon
   *  cycle later cannot even confirm ever existed. Only ever set on a PAUSE (see {@link requestPause}). */
  sessionId?: string;
  /** W1-T4429 — design (i): an explicit `--until`, or a default derived from the reason's class (see
   *  {@link classifyPauseReason}). `null` marks an INDEFINITE hold — never lapses, only escalates
   *  (design (ii), {@link evaluatePauseTier}). Only ever set on a PAUSE. */
  expiresAt?: string | null;
  indefinite?: boolean;
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

/** The extra fields only a PAUSE flag ever carries (see {@link FleetControlInfo}'s own doc) — STOP and
 *  quiet-hours keep calling {@link writeFlag} with this omitted, so their on-disk shape is unchanged. */
interface PauseFlagExtra {
  sessionId: string;
  expiresAt: string | null;
  indefinite: boolean;
}

function writeFlag(path: string, reason: string | undefined, extra?: PauseFlagExtra): FleetControlInfo {
  const info: FleetControlInfo = {
    reason,
    requestedAt: new Date().toISOString(),
    pid: process.pid,
    host: hostname(),
    ...(extra ? { sessionId: extra.sessionId, expiresAt: extra.expiresAt, indefinite: extra.indefinite } : {}),
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

/** Reason CLASSES pick a default hold duration (design (i): "a default derived from the reason
 *  class") — policy data, never a single flat number: a fast-moving incident should escalate soon
 *  if its setter goes quiet, while a planned maintenance/release window is legitimately longer-lived.
 *  `other` is the floor — MEASURED 2026-09-24's four-hour stall would have crossed even the floor. */
export type PauseReasonClass = "incident" | "release" | "maintenance" | "other";

/** Default hold duration (ms) per {@link PauseReasonClass} — see that type's own doc for why this is
 *  a table, not a literal. Only ever consulted when `requestPause`'s caller supplies no explicit
 *  `--until`; an explicit one always wins outright. */
export const PAUSE_DEFAULT_TTL_MS: Readonly<Record<PauseReasonClass, number>> = {
  incident: 60 * 60 * 1000,
  release: 4 * 60 * 60 * 1000,
  maintenance: 4 * 60 * 60 * 1000,
  other: 2 * 60 * 60 * 1000,
};

/** A crude keyword sniff over the operator's own `--reason` text — good enough to pick a DEFAULT
 *  duration; an explicit `--until` always overrides it, so a misclassification only ever costs the
 *  unattended default, never a hold an operator actually specified. Unclassifiable text (including
 *  no reason at all) is `"other"`, the shortest non-incident default. */
export function classifyPauseReason(reason: string | undefined): PauseReasonClass {
  const text = (reason ?? "").toLowerCase();
  if (/incident|outage|urgent|sev[\s-]?1|fire/.test(text)) return "incident";
  if (/release|deploy|rollout/.test(text)) return "release";
  if (/maintenance|migrat|upgrad/.test(text)) return "maintenance";
  return "other";
}

/** {@link requestPause}'s resolved expiry: `expiresAt: null` + `indefinite: true` for a hold declared
 *  `--indefinite` (design (ii): "only escalates, never lapses"); otherwise an ISO instant, either the
 *  caller's own explicit `until` or `now` plus {@link PAUSE_DEFAULT_TTL_MS}'s class default. */
export function resolvePauseExpiry(
  reason: string | undefined,
  until: string | undefined,
  now: Date,
): { expiresAt: string | null; indefinite: boolean } {
  if (until === "indefinite") return { expiresAt: null, indefinite: true };
  if (until) {
    const parsed = new Date(until);
    if (!Number.isNaN(parsed.getTime())) return { expiresAt: parsed.toISOString(), indefinite: false };
  }
  const ttlMs = PAUSE_DEFAULT_TTL_MS[classifyPauseReason(reason)];
  return { expiresAt: new Date(now.getTime() + ttlMs).toISOString(), indefinite: false };
}

/** The owner half of design (i): pid/host, exactly as {@link writeFlag} already recorded, plus a
 *  session id — `$REMUDERO_SESSION_ID` when the caller (a dispatched worker, MASTER-PLAN's own
 *  session convention) set one, else a `host-pid` fallback that is still strictly more specific than
 *  a bare pid a later tick cannot even confirm ever ran on THIS host. */
function resolvePauseOwnerSessionId(): string {
  const env = process.env.REMUDERO_SESSION_ID?.trim();
  return env ? env : `${hostname()}-${process.pid}`;
}

/** {@link requestPause}'s optional third argument set — an explicit `--until` (an ISO instant, or the
 *  literal `"indefinite"`), and an injectable clock for a deterministic test. */
export interface RequestPauseOptions {
  until?: string;
  now?: Date;
}

/**
 * `rmd pause [--reason <text>] [--until <instant>|--until indefinite]` — write the PAUSE flag.
 * `deps`, when supplied (the real CLI path — see the SHARED CROSS-HOST PAUSE section below), also
 * pushes the shared hold to `origin`, carrying the SAME owner/reason/expiry in the anchor commit's
 * body (design (i): "in the ref's commit body"), so a daemon on another host sees not just THAT the
 * fleet is held but WHO held it, WHY, and UNTIL WHEN. BEST-EFFORT: the local write above ALWAYS
 * lands first and ALWAYS succeeds on its own — design (i) — so a host that cannot reach origin
 * still pauses itself; the shared push merely widens who else notices.
 */
export function requestPause(
  root: string,
  reason?: string,
  deps?: SharedPauseGitDeps,
  options?: RequestPauseOptions,
): FleetControlInfo {
  const now = options?.now ?? new Date();
  const { expiresAt, indefinite } = resolvePauseExpiry(reason, options?.until, now);
  const sessionId = resolvePauseOwnerSessionId();
  const info = writeFlag(pauseFilePath(root), reason, { sessionId, expiresAt, indefinite });
  if (deps) writeSharedPause(deps, { reason, expiresAt, indefinite, sessionId });
  return info;
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
export function pauseDetail(root: string): string | undefined {
  if (!isPaused(root)) return undefined;
  const info = readFlag(pauseFilePath(root));
  return info?.reason ? `PAUSE requested: ${info.reason}` : "PAUSE file present — run `rmd resume` to clear";
}

/**
 * `rmd quiet-hours on|off` / the panel's quiet-hours toggle (W3-T5) — flip the flag. Unlike
 * STOP/PAUSE this is a plain boolean preference, not an emergency hold, so it has no
 * "request with a reason that survives to a detail string" shape: `on` writes the flag,
 * `off` clears it, and the return value is simply the resulting state.
 */
export function setQuietHours(root: string, enabled: boolean): boolean {
  if (enabled) {
    writeFlag(quietHoursFilePath(root), undefined);
    return true;
  }
  clearFlag(quietHoursFilePath(root));
  return false;
}


/**
 * AUTO-CONSUME the STOP flag (one-shot lifecycle). STOP exists only to halt the CURRENTLY
 * running drain; the drain that observed it clears it as it terminates (drainCommand /
 * daemonCommand finally), so STOP can NEVER silently block a future drain — unlike PAUSE,
 * which is a persistent maintenance hold cleared ONLY by `rmd resume`. Clears STOP alone,
 * never PAUSE. Idempotent (returns false when there was nothing to consume).
 */
export function consumeStop(root: string): boolean {
  return clearFlag(stopFilePath(root));
}

export interface ResumeResult {
  clearedStop: boolean;
  clearedPause: boolean;
  /** Only present when `resumeFleet` was called with `deps` — whether the shared-hold ref push
   *  landed. Omitted (not `false`) when `deps` was not supplied, so every existing caller that
   *  never passed one keeps getting back exactly `{clearedStop, clearedPause}`. */
  clearedSharedPause?: boolean;
}

/**
 * `rmd resume` — clear BOTH flags. Idempotent; a resume with nothing to clear is not an error.
 * `deps`, when supplied (the real CLI path), also clears the shared cross-host hold — design (iv):
 * `rmd resume` remains the ONLY thing that clears a pause, local or shared alike. BEST-EFFORT for
 * the same reason `requestPause`'s push is: the local clears above always run first and always
 * land regardless of whether origin is reachable, so an operator resuming a disconnected host
 * still gets THEIR OWN host moving again.
 */
export function resumeFleet(root: string, deps?: SharedPauseGitDeps): ResumeResult {
  const clearedStop = clearFlag(stopFilePath(root));
  const clearedPause = clearFlag(pauseFilePath(root));
  if (!deps) return { clearedStop, clearedPause };
  return { clearedStop, clearedPause, clearedSharedPause: clearSharedPause(deps) };
}

// ── SHARED CROSS-HOST PAUSE (W1-T1216) ────────────────────────────────────────────────────────
//
// THE GAP THIS CLOSES. `pauseFilePath`/`pauseDetail` above are keyed to `root`, and `root` (via
// `config.root`) resolves DIFFERENTLY per host — `join(homedir(), "Remudero")` on a mini is not
// the same directory an Azure container resolves from identical code — and `state/` is
// gitignored, so the file can never travel by the one channel every host already shares. A PAUSE
// written on one host is therefore invisible to a daemon checking `pauseDetail` on another.
//
// AN ADDITION, NEVER A REPLACEMENT (design (i)). `pauseDetail`/`isPaused`/`pauseFilePath` above
// are UNCHANGED — a disconnected host must still be able to pause itself with zero network
// dependency, and `checkSharedPause` below always consults the local file FIRST, only falling
// through to a remote read when the local file is silent.
//
// A GIT REF IS THE SHARED SUBSTRATE (rationale (9)/(10)), mirroring `triageClaimRef`
// (lib/auto-triage.ts) and `refs/rmd-id/` (task-id-reservation.ts) — the same namespace family,
// same "`git ls-remote`, never `git clone`/`git fetch`" cost profile. Unlike a triage claim this
// is fleet-WIDE, not per-entry, so there is exactly one ref, and there is no contention to referee
// — two operators pausing at once both want the same outcome (held), so whichever push lands
// first is fine.
//
// UNREACHABLE MEANS HELD (design (ii)). `readSharedPause` discriminates ABSENT (status 0, no
// stdout) from HELD (status 0, some stdout) from UNREACHABLE (nonzero status) — measured
// (rationale (10)): an absent ref exits 0 with zero lines, an unreachable remote exits 128, a
// present ref exits 0 with one line. `checkSharedPause` below folds UNREACHABLE into "paused",
// never into "clear" — a failed read is never scored free, the same principle
// `reserveTaskIdRemote` applies in the opposite direction (there: refuses to MINT; here: refuses
// to DISPATCH).
//
// STOP IS UNTOUCHED (design (iii)). Nothing below adds a shared ref for STOP: it exists only to
// halt the drain that observes it, auto-clears as that drain exits (`consumeStop`, above), and has
// no cross-host question to answer — giving it a shared marker would turn a one-shot into
// something that can outlive its own drain.

/** The single ref the shared cross-host PAUSE hold lives at — fleet-WIDE, unlike
 *  `triageClaimRef`'s per-entry `refs/rmd-triage/<id>`, because there is exactly one hold to ask
 *  about. Under `refs/rmd-pause/`, matching the `refs/rmd-id/`/`refs/rmd-triage/` convention: a
 *  namespace `git clone`/`git fetch` does not replicate by default and `git ls-remote --heads`
 *  (which `reapBranchesCommand` enumerates) does not see, so it costs nothing on every branch
 *  sweep already walking the remote. */
export function sharedPauseRef(): string {
  return "refs/rmd-pause/hold";
}

/** What a read of the shared hold found. `"unreachable"` is a FAILED READ of the world and must
 *  never be treated as `"absent"` — see the module header's UNREACHABLE MEANS HELD note. */
export type SharedPauseRead = "absent" | "held" | "unreachable";

/** The one I/O seam {@link readSharedPause}/{@link writeSharedPause}/{@link clearSharedPause}
 *  share. Mirrors {@link TriageClaimReserver} (lib/auto-triage.ts) in shape and in its own
 *  contract: `run` must NEVER throw — an unreachable remote is an OUTCOME (a non-zero status),
 *  because a throw at this seam is indistinguishable from a programmer error to the caller. */
/** W1-T4429 — the owner/reason/expiry `mintAnchor` embeds in the anchor commit's BODY (design (i)),
 *  alongside the pid/host/timestamp line it already wrote. Every field optional: a caller that omits
 *  it (any test fixture predating this task) reproduces the exact legacy one-line message. */
export interface SharedPauseMintInfo {
  reason?: string;
  sessionId?: string;
  /** `null` marks an INDEFINITE hold (design (ii)) — mints an `expires: indefinite` line instead of
   *  an instant. `undefined` (the field omitted) mints no `expires:` line at all. */
  expiresAt?: string | null;
  indefinite?: boolean;
}

export interface SharedPauseGitDeps {
  /** Runs a git argv against `origin`; returns its exit status and stdout, verbatim. */
  run(args: string[]): { status: number; stdout: string };
  /** A payload usable as the ref's target commit. Mirrors {@link TriageClaimReserver.mintAnchor}:
   *  the real implementation mints an orphan commit over the empty tree; a test may return any
   *  fixed string, since a fake remote need not validate real git object shape. W1-T4429: `info`,
   *  when supplied, is embedded in the commit's body — see {@link SharedPauseMintInfo}. */
  mintAnchor(info?: SharedPauseMintInfo): string;
}

/** PRIMARY CONTROL: a shared-pause read is a scheduler health probe, not an unbounded dependency.
 *
 * A shared-pause read is a scheduler health probe, not an unbounded dependency.  The daemon calls
 * it from its tick path, so a credential helper, DNS lookup, or GitHub transport stall must return
 * a named `unreachable` outcome and let the loop continue rather than freezing every review lane.
 * Keep this below the daemon's normal poll cadence while leaving enough room for one ordinary Git
 * round trip; callers can still inject a fake `run` without paying a timer in tests.
 */
export const SHARED_PAUSE_GIT_TIMEOUT_MS = 10_000;

/**
 * The real (non-test) {@link SharedPauseGitDeps} — a live `git`, scoped to `repoRoot` exactly
 * like `gitTriageClaimReserver`'s own calls (lib/auto-triage.ts). `mintAnchor` reuses that
 * function's own recipe (`hash-object` the empty tree, `commit-tree` an orphan commit over it)
 * rather than inventing a second one, so a stuck hold is inspectable with the same `git show` an
 * operator already knows to reach for on a stuck triage claim.
 */
export function realSharedPauseGitDeps(repoRoot: string): SharedPauseGitDeps {
  const run = (args: string[]): { status: number; stdout: string } => {
    // `repoRoot` follows the cwd, so a test driving `rmd pause`/`resume` from a fleet worktree
    // targets the LIVE origin; 2026-09-24 a worker's test run held every daemon for 32 minutes.
    if (args[0] === "push") assertLiveWriteAllowed("git-push", `${args.at(-1)} on ${repoRoot}'s origin`);
    try {
      const stdout = execFileSync("git", ["-C", repoRoot, ...args], {
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
      return run(["commit-tree", tree, "-m", lines.join("\n")]).stdout.trim();
    },
  };
}

/** One `ls-remote` outcome, carrying the sha `readSharedPause` (below) throws away — the seam
 *  {@link checkSharedPause} uses to recover WHO set the hold instead of just THAT it is held. */
interface SharedPauseLsRemote {
  status: number;
  /** The ref's current sha, when the read succeeded and the ref exists. */
  sha?: string;
}

function lsRemoteSharedPause(deps: SharedPauseGitDeps): SharedPauseLsRemote {
  const res = deps.run(["ls-remote", "origin", sharedPauseRef()]);
  if (res.status !== 0) return { status: res.status };
  const line = res.stdout.trim().split("\n")[0] ?? "";
  const sha = line.split("\t")[0]?.trim();
  return { status: 0, sha: sha || undefined };
}

/**
 * `git ls-remote origin <ref>`, classified into the three outcomes rationale (10) measured.
 * PURE given `deps` — the network round trip is `deps.run`'s problem, not this function's.
 */
export function readSharedPause(deps: SharedPauseGitDeps): SharedPauseRead {
  const res = lsRemoteSharedPause(deps);
  if (res.status !== 0) return "unreachable";
  return res.sha ? "held" : "absent";
}

/** The pid/host/timestamp {@link realSharedPauseGitDeps}'s `mintAnchor` embeds in the anchor
 *  commit's message. Every field is a raw string off the commit — no parsing beyond splitting the
 *  message apart, so a reader never has to trust anything the writer didn't already commit.
 *  W1-T4429: `sessionId`/`reason`/`expiresAt`/`indefinite` recover the extra lines
 *  {@link SharedPauseMintInfo} adds (design (i)) — every one optional, since an anchor minted before
 *  this task (or by a test fixture that supplies no `info`) carries only the first line. */
export interface SharedPauseAnchorInfo {
  pid: string;
  host: string;
  timestamp: string;
  sessionId?: string;
  reason?: string;
  /** `null` when the anchor's `expires:` line reads `indefinite`; `undefined` when the anchor has
   *  no `expires:` line at all (a legacy anchor, or one deliberately minted without one). */
  expiresAt?: string | null;
  indefinite?: boolean;
}

/** Matches the exact message `mintAnchor` mints: `rmd-pause hold <pid>@<host> <ISO timestamp>`.
 *  `^`/`m` so it finds the message line regardless of the `tree`/`author`/`committer` header
 *  lines `cat-file -p` prints ahead of it. */
const ANCHOR_MESSAGE_RE = /^rmd-pause hold (\S+)@(\S+) (\S+)\s*$/m;
// Exported (never only module-private) so a test can drive each one's own unhealthy arm directly —
// a hold minted before W1-T4429 (or by anything that never wrote these lines) is the ordinary case
// these three must correctly read as ABSENT, not just match the happy path.
export const ANCHOR_SESSION_RE = /^session: (.+)$/m;
export const ANCHOR_REASON_RE = /^reason: (.+)$/m;
export const ANCHOR_EXPIRES_RE = /^expires: (.+)$/m;

/**
 * Best-effort recovery of {@link SharedPauseAnchorInfo} off a hold's anchor commit — the payload
 * `mintAnchor` already minted and every reader before this one discarded (see the module header's
 * "already computed and discarded" note). `null` on ANY failure to recover it: an unreachable
 * remote, a GC'd/missing object, or a commit whose message doesn't match the expected shape (an
 * anchor minted by something other than {@link realSharedPauseGitDeps}). A caller that gets `null`
 * still knows the ref is held — {@link checkSharedPause} never lets a failed anchor read degrade
 * "held" into "absent". The `session:`/`reason:`/`expires:` lines (design (i)) are read
 * independently of the first line and of each other — an anchor minted without `info` (or by
 * something older than W1-T4429) still resolves the pid/host/timestamp it always did, with the new
 * fields simply absent.
 */
export function readSharedPauseAnchor(sha: string, deps: SharedPauseGitDeps): SharedPauseAnchorInfo | null {
  const res = deps.run(["cat-file", "-p", sha]);
  if (res.status !== 0) return null;
  const m = ANCHOR_MESSAGE_RE.exec(res.stdout);
  if (!m) return null;
  const info: SharedPauseAnchorInfo = { pid: m[1]!, host: m[2]!, timestamp: m[3]! };
  const session = ANCHOR_SESSION_RE.exec(res.stdout);
  if (session) info.sessionId = session[1]!.trim();
  const reason = ANCHOR_REASON_RE.exec(res.stdout);
  if (reason) info.reason = reason[1]!.trim();
  const expires = ANCHOR_EXPIRES_RE.exec(res.stdout);
  if (expires) {
    const raw = expires[1]!.trim();
    if (raw === "indefinite") {
      info.indefinite = true;
      info.expiresAt = null;
    } else {
      info.expiresAt = raw;
    }
  }
  return info;
}

/** Create-or-update {@link sharedPauseRef}. Who "wins" a race between two operators pausing at
 *  once does not matter — the outcome either way is "held" — so unlike a triage claim this never
 *  needs create-if-absent semantics. Returns whether the push landed; callers treat a failure as
 *  BEST-EFFORT (see {@link requestPause}'s doc). W1-T4429: `info`, when supplied, rides straight
 *  through to `deps.mintAnchor` — see {@link SharedPauseMintInfo}. */
export function writeSharedPause(deps: SharedPauseGitDeps, info?: SharedPauseMintInfo): boolean {
  const anchor = deps.mintAnchor(info);
  return deps.run(["push", "origin", `${anchor}:${sharedPauseRef()}`]).status === 0;
}

/** Delete {@link sharedPauseRef}. Returns whether the delete landed; callers treat a failure as
 *  BEST-EFFORT (see {@link resumeFleet}'s doc) — design (iv) still holds because the LOCAL clear
 *  `resumeFleet` performs always runs first and always lands. */
export function clearSharedPause(deps: SharedPauseGitDeps): boolean {
  return deps.run(["push", "origin", `:${sharedPauseRef()}`]).status === 0;
}

/**
 * Per-`deps`, per-sha memo of {@link readSharedPauseAnchor}'s verdict (W1-T3622). Keyed on the
 * `SharedPauseGitDeps` instance rather than global to the module: production wires exactly one
 * live instance for the process's whole lifetime (`run-task.ts`'s `realDeps()` memoizes
 * `composeRealDeps`'s `ComposedRealGraph` behind a module-level `??=`), so this still resolves an
 * unreachable anchor ONCE per sha for real — but a WeakMap keyed on `deps` also means two
 * unrelated test fixtures that happen to mint the same literal sha string never share a verdict,
 * with no manual reset required between tests. A `null` (unreadable) verdict is memoized exactly
 * like a resolved one — the sha that failed to resolve cannot start resolving later on its own,
 * so there is nothing to gain by re-paying the read, only the cost of stopping.
 */
const sharedPauseAnchorMemos = new WeakMap<SharedPauseGitDeps, Map<string, SharedPauseAnchorInfo | null>>();

/**
 * {@link readSharedPauseAnchor}, memoized per {@link sharedPauseAnchorMemos}. Design: "resolve
 * once, remember the verdict against the ref's sha, and re-attempt only when that sha changes" —
 * a hold's anchor sha is immutable once minted, so a verdict for a given sha can never go stale;
 * only a NEW hold (a new sha, from a fresh `writeSharedPause`) is worth reading again.
 */
function resolveSharedPauseAnchor(sha: string, deps: SharedPauseGitDeps): SharedPauseAnchorInfo | null {
  let memo = sharedPauseAnchorMemos.get(deps);
  if (!memo) {
    memo = new Map();
    sharedPauseAnchorMemos.set(deps, memo);
  }
  if (memo.has(sha)) return memo.get(sha)!;
  const info = readSharedPauseAnchor(sha, deps);
  memo.set(sha, info);
  return info;
}

/**
 * THE DAEMON'S PER-TICK SUPPLIER — wired at BOTH `checkPause` call sites in `src/run-task.ts`
 * (the task shard's own note on why the flag and its only reader are declared apart: the flag
 * lives here, its only reader lives there).
 *
 * LOCAL FIRST, NEVER REPLACED (design (i), rationale (3)): `pauseDetail`'s existing host-local
 * read wins outright the moment it finds a flag — no network call, no behaviour change for a host
 * that already knows. Only when the local file is silent does this fall through to the shared
 * ref, so a disconnected host that has paused ITSELF is unaffected by this function existing.
 *
 * UNREACHABLE READS AS HELD (design (ii)): `readSharedPause` returning `"unreachable"` produces a
 * truthy detail string, exactly like a real hold — never `undefined`. A failed read is never
 * scored free. Nothing here compares the anchor's timestamp against the clock, either — a hold
 * never expires on elapsed time alone; `resumeFleet` is the only thing that clears it.
 *
 * NAMES THE SETTER (W1-T2262): a `"held"` read now recovers {@link readSharedPauseAnchor} (via
 * the {@link resolveSharedPauseAnchor} memo, W1-T3622) off the same sha `ls-remote` just returned
 * and, when that recovers, renders WHO set the hold (pid, host, timestamp) instead of the old
 * "(set from another host)" — an anonymous fleet-wide halt is what this closes.
 *
 * UNATTRIBUTABLE IS ITS OWN CONDITION (W1-T3622): an anchor that fails to recover (unreachable,
 * GC'd, minted by something that didn't use the expected message shape) still renders a HELD
 * detail — it degrades the ATTRIBUTION, never the VERDICT — but the detail names itself
 * "UNATTRIBUTABLE" rather than reusing the ordinary "set by pid ..." phrasing, because "someone
 * paused this and I can tell you who" and "something is holding the fleet and nobody can say who"
 * are different operator instructions. The read behind that verdict pays the `cat-file` round
 * trip (and whatever fallback follows a local miss) exactly ONCE per sha, not once per tick — see
 * {@link resolveSharedPauseAnchor}.
 */
export function checkSharedPause(root: string, deps: SharedPauseGitDeps): string | undefined {
  const local = pauseDetail(root);
  if (local) return local;
  const ls = lsRemoteSharedPause(deps);
  if (ls.status === 0 && ls.sha) {
    const anchor = resolveSharedPauseAnchor(ls.sha, deps);
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
        `${anchor.timestamp}${reasonPart}${untilPart} — run \`rmd resume\` to clear`
      );
    }
    return (
      `PAUSE held on ${sharedPauseRef()} — UNATTRIBUTABLE (anchor ${ls.sha} unreadable, setter ` +
      "cannot be recovered) — run `rmd resume` to clear"
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

/** Everything {@link evaluatePauseTier} needs to classify ONE hold, at ONE instant — every field a
 *  plain value, so the daemon (or a test) can drive it over a fabricated timeline with no I/O. */
export interface PauseTierInput {
  /** When the hold was set — {@link SharedPauseAnchorInfo.timestamp} or a local flag's
   *  `requestedAt`. */
  setAt: string;
  /** `null` for an indefinite hold; see {@link SharedPauseMintInfo.expiresAt}. */
  expiresAt: string | null;
  indefinite: boolean;
  /** Whether the setter's own process is still alive. `"unknown"` when liveness cannot be checked
   *  (e.g. the hold was set on a different host than the one evaluating it) and is never treated as
   *  dead — an unattributable/unverifiable setter is not evidence of an orphan. */
  setterAlive: boolean | "unknown";
  now: Date;
}

/**
 * Classify ONE hold against design (ii)'s tiers. PURE: no read, no write, no clock of its own — the
 * caller supplies `now` (real or fabricated) and every other field is a value already recovered off
 * the hold (its anchor, or its local flag). See the section header above for what each tier means
 * and {@link daemon.ts}'s `stepPauseHoldGovernor` for the caller that acts on a transition.
 */
export function evaluatePauseTier(input: PauseTierInput): PauseTier {
  const { setAt, expiresAt, indefinite, setterAlive, now } = input;
  const nowMs = now.getTime();
  if (!indefinite && expiresAt) {
    const expiryMs = new Date(expiresAt).getTime();
    if (Number.isFinite(expiryMs)) {
      if (nowMs >= expiryMs) return "lapsed";
      const setAtMs = new Date(setAt).getTime();
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
  /** W1-T429: the repo this kick targets, when the caller supplied one — `undefined` for a
   *  legacy/unscoped marker (pre-existing on disk, or written by a caller not yet threading a
   *  repo through). See {@link kickFilePath}'s doc for why this is what keeps two repos sharing
   *  a task id from colliding on the SAME marker filename. */
  repo?: string;
}

/** A "Drain now" request, parsed off the `DRAIN_REQUESTED` marker. */
export interface DrainNowRequest {
  origin: string;
  requestedAt: string;
}

/**
 * Task ids that may become a marker FILENAME. Deliberately strict (the plan's own
 * `W1-T###`/`SBX-T#` shape plus a safe superset) so a hostile or malformed id can
 * never traverse out of `state/` (`/`, `..`, NUL, whitespace all rejected). Enforced
 * fail-closed on BOTH write (`requestKick` throws) and read (`pendingKicks` skips).
 */
const SAFE_TASK_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126})$/;

/** True iff `taskId` is safe to embed in a marker filename (see {@link SAFE_TASK_ID}). */
export function isSafeTaskId(taskId: unknown): taskId is string {
  return typeof taskId === "string" && SAFE_TASK_ID.test(taskId) && !taskId.includes("..");
}

/** Repo names that may become part of a marker FILENAME (W1-T429) — the same shape discipline
 *  {@link SAFE_TASK_ID} applies to a task id, so a hostile/malformed repo string can never
 *  traverse out of `state/` either. Enforced fail-closed on write ({@link requestKick} throws). */
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

/**
 * W1-T429: `repo` is OPTIONAL and, when supplied, folds into the marker filename via
 * {@link repoScopedTaskKey} — `KICK_REQUESTED-<repo>:<taskId>` instead of the legacy
 * `KICK_REQUESTED-<taskId>` — so two repos sharing a task-id scheme (the fleet's plans do; a
 * wild-trails W1-T12 and this repo's W1-T12 are the SAME bare id) get DISTINCT marker files
 * instead of one console click silently overwriting/consuming the other's pending kick. Omitting
 * `repo` (every caller today) reproduces the exact legacy path unchanged.
 */
export function kickFilePath(root: string, taskId: string, repo?: string): string {
  return join(root, "state", `${KICK_PREFIX}${repoScopedTaskKey(repo, taskId)}`);
}

export function drainNowFilePath(root: string): string {
  return join(root, "state", "DRAIN_REQUESTED");
}

/**
 * Write a `KICK_REQUESTED-<taskId>` marker (the console's "Run" button); `KICK_REQUESTED-
 * <repo>:<taskId>` when `repo` is supplied (W1-T429). Throws on an unsafe task id OR repo
 * BEFORE any write — a malformed id/repo performs no side effect, ever. Overwriting an existing
 * marker for the same (repo, taskId) is idempotent (still one pending kick).
 */
export function requestKick(root: string, taskId: string, origin: string, repo?: string): KickRequest {
  if (!isSafeTaskId(taskId)) throw new Error(`requestKick: unsafe task id ${JSON.stringify(taskId)}`);
  if (repo !== undefined && !isSafeRepoName(repo)) throw new Error(`requestKick: unsafe repo ${JSON.stringify(repo)}`);
  const req: KickRequest = { taskId, origin, requestedAt: new Date().toISOString(), ...(repo !== undefined ? { repo } : {}) };
  const path = kickFilePath(root, taskId, repo);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(req, null, 2));
  return req;
}

/**
 * Every pending kick, oldest-first (by `requestedAt`). PEEK ONLY — does not delete; the
 * daemon clears each with {@link clearKick} as it dispatches or refuses it, so a runnable
 * kick it can't service this cycle survives to the next. A file whose JSON is garbage, or
 * whose id no longer parses as safe, is skipped (fail-closed), never dispatched.
 */
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
