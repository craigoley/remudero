import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { repoScopedTaskKey } from "./ledger.js";

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
 * drain loop by itself (the scheduler that reads it to throttle spawns is
 * later work, same "mechanism now, consumer later" split as lib/board.ts);
 * `setQuietHours` only flips the flag a future consumer reads. `rmd resume`
 * deliberately does NOT touch it — quiet hours is a schedule preference, not
 * an emergency hold, so an operator resuming from a STOP/PAUSE should not
 * silently lose their quiet-hours setting.
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

function writeFlag(path: string, reason: string | undefined): FleetControlInfo {
  const info: FleetControlInfo = {
    reason,
    requestedAt: new Date().toISOString(),
    pid: process.pid,
    host: hostname(),
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

/**
 * `rmd pause [--reason <text>]` — write the PAUSE flag. `deps`, when supplied (the real CLI path
 * — see the SHARED CROSS-HOST PAUSE section below), also pushes the shared hold to `origin` so a
 * daemon on another host sees it. BEST-EFFORT: the local write above ALWAYS lands first and
 * ALWAYS succeeds on its own — design (i) — so a host that cannot reach origin still pauses
 * itself; the shared push merely widens who else notices.
 */
export function requestPause(root: string, reason?: string, deps?: SharedPauseGitDeps): FleetControlInfo {
  const info = writeFlag(pauseFilePath(root), reason);
  if (deps) writeSharedPause(deps);
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
export interface SharedPauseGitDeps {
  /** Runs a git argv against `origin`; returns its exit status and stdout, verbatim. */
  run(args: string[]): { status: number; stdout: string };
  /** A payload usable as the ref's target commit. Mirrors {@link TriageClaimReserver.mintAnchor}:
   *  the real implementation mints an orphan commit over the empty tree; a test may return any
   *  fixed string, since a fake remote need not validate real git object shape. */
  mintAnchor(): string;
}

/**
 * The real (non-test) {@link SharedPauseGitDeps} — a live `git`, scoped to `repoRoot` exactly
 * like `gitTriageClaimReserver`'s own calls (lib/auto-triage.ts). `mintAnchor` reuses that
 * function's own recipe (`hash-object` the empty tree, `commit-tree` an orphan commit over it)
 * rather than inventing a second one, so a stuck hold is inspectable with the same `git show` an
 * operator already knows to reach for on a stuck triage claim.
 */
export function realSharedPauseGitDeps(repoRoot: string): SharedPauseGitDeps {
  const run = (args: string[]): { status: number; stdout: string } => {
    try {
      const stdout = execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
      return { status: 0, stdout };
    } catch (e) {
      const status = typeof (e as { status?: number })?.status === "number" ? (e as { status: number }).status : 1;
      return { status, stdout: "" };
    }
  };
  return {
    run,
    mintAnchor() {
      const tree = run(["hash-object", "-t", "tree", "/dev/null"]).stdout.trim();
      const msg = `rmd-pause hold ${process.pid}@${hostname()} ${new Date().toISOString()}`;
      return run(["commit-tree", tree, "-m", msg]).stdout.trim();
    },
  };
}

/**
 * `git ls-remote origin <ref>`, classified into the three outcomes rationale (10) measured.
 * PURE given `deps` — the network round trip is `deps.run`'s problem, not this function's.
 */
export function readSharedPause(deps: SharedPauseGitDeps): SharedPauseRead {
  const res = deps.run(["ls-remote", "origin", sharedPauseRef()]);
  if (res.status !== 0) return "unreachable";
  return res.stdout.trim() ? "held" : "absent";
}

/** Create-or-update {@link sharedPauseRef}. Who "wins" a race between two operators pausing at
 *  once does not matter — the outcome either way is "held" — so unlike a triage claim this never
 *  needs create-if-absent semantics. Returns whether the push landed; callers treat a failure as
 *  BEST-EFFORT (see {@link requestPause}'s doc). */
export function writeSharedPause(deps: SharedPauseGitDeps): boolean {
  const anchor = deps.mintAnchor();
  return deps.run(["push", "origin", `${anchor}:${sharedPauseRef()}`]).status === 0;
}

/** Delete {@link sharedPauseRef}. Returns whether the delete landed; callers treat a failure as
 *  BEST-EFFORT (see {@link resumeFleet}'s doc) — design (iv) still holds because the LOCAL clear
 *  `resumeFleet` performs always runs first and always lands. */
export function clearSharedPause(deps: SharedPauseGitDeps): boolean {
  return deps.run(["push", "origin", `:${sharedPauseRef()}`]).status === 0;
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
 * scored free.
 */
export function checkSharedPause(root: string, deps: SharedPauseGitDeps): string | undefined {
  const local = pauseDetail(root);
  if (local) return local;
  const shared = readSharedPause(deps);
  if (shared === "held") {
    return `PAUSE held on ${sharedPauseRef()} (set from another host) — run \`rmd resume\` to clear`;
  }
  if (shared === "unreachable") {
    return (
      `cannot reach origin to read ${sharedPauseRef()} — holding rather than dispatching ` +
      `optimistically (an unreachable remote is never read as clear)`
    );
  }
  return undefined;
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
