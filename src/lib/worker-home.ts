import { execFileSync } from "node:child_process";

import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  renameSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { playwrightCacheRoot } from "./review.js";
import { defaultIsPidAlive } from "./drain-lock.js";
import { isHolderStale, reclaimStaleLock } from "./fs-race-safe.js";
import { parseInflightLockInfo } from "./inflight-lock.js";
import { DEFAULT_KEYCHAIN_PROVISION_LOCK_WAIT_MS, loadDefaultPolicy } from "./policy.js";
import { LEDGER_FILENAME } from "./ledger-path.js";

/**
 * The general shell-isolation mechanism (W1-T18, the OSS blocker). Every worker's HOME is redirected
 * to a Remudero-controlled scratch directory whose rc files this module writes empty, so a worker
 * shell can never source the operator's own dotfiles.
 *
 * INVARIANT: a worker HOME holds ONLY empty rc files Remudero wrote ({@link WORKER_HOME_RC_FILES})
 * plus the named grants symlinked back from the real HOME ({@link WORKER_HOME_SYMLINKS}) — never a
 * wholesale copy. Same allowlist discipline as env.ts's ANTHROPIC_* boundary.
 * INVARIANT: a worker home is never inside a git work tree. {@link materializeWorkerHome} refuses via
 * {@link gitWorkTreeAncestor} before writing anything, for a clone's `.git` directory and a linked
 * worktree's `.git` file alike.
 * TRAP: W1-T17's probe proves isolation per run but cannot manufacture it. Isolation used to hold
 * only because this host has no `~/.bashrc`; a populated one gave zero isolation (FIELD FINDING 11b).
 * TRAP: the macOS login keychain holding the OAuth token is HOME-relative, so the redirect hid it and
 * Claude Code exited "Not logged in" at $0 before any turn. Only that one keychain DB file is granted
 * back, never the whole `~/Library` (FIELD FINDING 11c).
 *
 * FALSIFIER: test/worker-home.test.ts, test/worker-home-per-run.test.ts. // Why:
 * docs/forensics/worker-home.md#module-header (W1-T18, W1-T2633, PR #8, PR #100).
 */

/** Empty-by-construction rc files a worker's HOME must hold — bash AND zsh conventions, so isolation
 *  does not depend on which shell a worker sources. INVARIANT: Remudero writes each as a zero-byte
 *  file and never consults the operator's real dotfiles. */
export const WORKER_HOME_RC_FILES: readonly string[] = [
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".profile",
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".zlogin",
];

/** One path a worker needs mirrored back from the real HOME into the redirected scratch HOME,
 *  symlinked rather than copied so it is always current. */
export interface WorkerHomeSymlink {
  /** Path relative to HOME, e.g. `.claude` or `.config/gh`. */
  relPath: string;
  /** Why this one path is granted back — never a wholesale HOME copy. */
  reason: string;
}

/** W1-T505: the credential-only sibling of the operator's real `.claude` that a worker's `.claude`
 *  grant prefers. INVARIANT: {@link workerHomePlan} resolves the grant to `<realHome>/.claude-fleet`
 *  when it exists and to the wholesale `.claude` when it does not, so upgrading before the sibling is
 *  populated breaks no host. // Why: docs/forensics/worker-home.md#the-claude-grant. */
export const WORKER_CLAUDE_CREDENTIAL_DIR_RELPATH = ".claude-fleet";

/** The explicit allowlist of real-HOME paths a worker needs back, symlinked individually. Mirrors
 *  env.ts's ALLOWLIST discipline: name each grant and its reason, never inherit HOME wholesale. */
/** The browser cache's path relative to HOME, derived from {@link playwrightCacheRoot} (lib/review.ts)
 *  rather than a second copy of its platform branch, so grant and resolver cannot disagree. INVARIANT:
 *  the empty env and sentinel HOME are deliberate — `ALLOWLIST` (lib/env.ts) passes no
 *  `PLAYWRIGHT_BROWSERS_PATH` into a spawn, so only the no-override branch is reachable.
 *  // Why: docs/forensics/worker-home.md#playwrightcacherelpath. */
export function playwrightCacheRelPath(platform: string = process.platform): string {
  const sentinel = "/__rmd_home__";
  return relative(sentinel, playwrightCacheRoot({}, platform, sentinel)).split(sep).join("/");
}

export const WORKER_HOME_SYMLINKS: readonly WorkerHomeSymlink[] = [
  {
    relPath: ".claude",
    reason:
      "Claude Code session/config state — narrowed (W1-T505) to prefer a credential-only sibling " +
      "(WORKER_CLAUDE_CREDENTIAL_DIR_RELPATH, e.g. ~/.claude-fleet) over the operator's whole .claude " +
      "(transcripts, history, settings, skills), falling back to today's wholesale grant only when that " +
      "sibling is absent. OAuth may read under HOME — unverified live, see LEARNINGS.md.",
  },
  { relPath: ".config/gh", reason: "gh CLI auth token, so a worker can open/merge PRs" },
  {
    relPath: playwrightCacheRelPath(),
    reason:
      "Playwright's browser cache is HOME-relative (playwrightCacheRoot, lib/review.ts, resolves its " +
      "no-override branch off HOME), so a redirected HOME hides the copy the image already installed " +
      "and every run downloads its own — MEASURED on the container at the great majority of a completed " +
      "worker home. READ-ONLY IN PRACTICE: on a populated cache every browser directory's mtime is its " +
      "INSTALL date and nothing under the tree is modified across repeated launches, so this grant adds " +
      "no writable path and no bind — it is a symlink inside the worker home, exactly like the four " +
      "beside it. AN ABSENT CACHE IS A SKIPPED GRANT, inherited from materializeWorkerHome's existing " +
      "contract: a target that does not exist is recorded `absent` and skipped silently, so a host " +
      "that never populated one still materializes a working home and the worker falls back to its own " +
      "directory. THE PINNED-BUILD CASE, DECIDED AND STATED: when the cache exists but lacks the pinned " +
      "revision, the install seam (ensureBrowsers, memoised per process) populates the SHARED tree. " +
      "That is bounded rather than free — Playwright installs into a per-REVISION directory and writes " +
      "its INSTALLATION_COMPLETE marker last, so a half-extracted directory reads as absent to a reader " +
      "and two runs on DIFFERENT revisions cannot collide; MEASURED on a populated cache, the markers " +
      "are present and there is no lock file, so the marker protects readers and not concurrent " +
      "writers. The residual is two runs installing the SAME missing revision at once, which is the " +
      "one case an enforcing predicate would have to cover and is left to its own task.",
  },
  { relPath: ".gitconfig", reason: "git author identity for commits the worker makes" },
  {
    relPath: "Library/Keychains/login.keychain-db",
    reason:
      "macOS login keychain holds the Claude Code OAuth token ('Claude Code-credentials'); the keychain is HOME-relative ($HOME/Library/Keychains/login.keychain-db), so a redirected HOME hides it and Claude Code exits 'Not logged in' at $0 before any turn (W1-T18 spawn deadlock, verified live). ONLY this single DB file is granted — not the whole ~/Library — and securityd still gates per-item access by code identity.",
  },
];

/** PURE plan of what {@link materializeWorkerHome} will do, so the redirection logic is unit-testable
 *  without touching the filesystem. INVARIANT: every `from` is under the redirected `workerHome` and
 *  every `to` under the real `realHome`, never `workerHome === realHome`. */
export interface WorkerHomePlan {
  workerHome: string;
  rcFiles: string[];
  symlinks: Array<{ from: string; to: string; reason: string }>;
  /** What ACTUALLY happened to each grant: a FAILED grant is not an OPTIONAL one. Populated by
   *  {@link materializeWorkerHome}; absent on the pure {@link workerHomePlan}. */
  outcomes?: WorkerHomeGrantOutcome[];
  /** W1-T981: whatever the `.claude` grant resolves to for THIS plan. The CLI's own `.claude.json`
   *  backups land here, so {@link materializeWorkerHome} sweeps it via
   *  {@link sweepClaudeConfigBackups}. Optional only so a hand-built fixture need not carry it. */
  claudeGrantTarget?: string;
  /** W1-T981: the outcome of sweeping `claudeGrantTarget`'s `.claude.json` backups, so that bound is
   *  OBSERVABLE on every materialization. Absent on the pure {@link workerHomePlan}. */
  claudeConfigBackupSweep?: ClaudeConfigBackupSweepSummary;
}

/** One grant's real outcome. INVARIANT: `absent` and `failed` stay distinguishable — the absent skip
 *  is a correct optional-grant path, while a failure is a silent loss of capability. */
export interface WorkerHomeGrantOutcome {
  relFrom: string;
  to: string;
  /** Only the two non-obvious states need saying. `absent` means the TARGET does not exist: an optional
   *  grant, skipped SILENTLY and correctly, since several are legitimately unavailable. `displaced`
   *  means a REAL DIRECTORY occupied the slot, was moved aside and the link was then created. */
  state: "linked" | "already" | "absent" | "displaced" | "failed";
  /** Where a `displaced` directory was moved to — kept, never deleted, so the thing that poisoned
   *  the slot is still inspectable afterwards. */
  displacedTo?: string;
  /** Why a `failed` grant failed — the error's own message, never a guess. */
  reason?: string;
}

/** The grants that were LOST or HEALED. INVARIANT: `absent` and the two healthy states are excluded
 *  deliberately — materialisation runs per spawn and per probe tick, so reporting every grant would be
 *  four rows a spawn, while `failed`/`displaced` are rare by construction. */
export function lostWorkerHomeGrants(plan: WorkerHomePlan): WorkerHomeGrantOutcome[] {
  return (plan.outcomes ?? []).filter((o) => o.state === "failed" || o.state === "displaced");
}

/** The HOME-relative slot Claude Code resolves its keychain through. */
const LOGIN_KEYCHAIN_REL = join("Library", "Keychains", "login.keychain-db");

/** The HOME-relative slot the `.claude` grant occupies — the one W1-T505 narrows. */
const CLAUDE_REL = ".claude";

/** W1-T981: the HOME-relative slot the CLI's OWN config file occupies — deliberately absent from
 *  {@link WORKER_HOME_SYMLINKS} and {@link WORKER_HOME_RC_FILES} alike. INVARIANT: every per-run home
 *  starts this slot empty and the CLI creates a fresh `.claude.json` itself, on every spawn; the
 *  "configuration file not found" notice IS that creation, not a race. TRAP: granting it back would
 *  share one mutable inode across every worker. // Why: docs/forensics/worker-home.md#claude_config_rel. */
export const CLAUDE_CONFIG_REL = ".claude.json";

export function workerHomePlan(opts: {
  workerHome: string;
  realHome: string;
  /** W1-T235: when set, the redirected HOME's `Library/Keychains/login.keychain-db` slot resolves to
   *  this dedicated, always-unlocked worker keychain, not the operator's real login keychain. TRAP:
   *  under the shared inode a LOCKED login keychain killed every headless spawn at $0 (2026-07-21). */
  workerKeychainPath?: string;
  /** W1-T505: injectable existence check, so the `.claude` narrowing below is unit-testable without
   *  touching the real filesystem. Defaults to the real `existsSync`. */
  exists?: (path: string) => boolean;
}): WorkerHomePlan {
  const exists = opts.exists ?? existsSync;
  // W1-T505: the `.claude` grant prefers `<realHome>/.claude-fleet` over the wholesale `.claude`,
  // falling back to it when that sibling is absent.
  const claudeCredentialDir = join(opts.realHome, WORKER_CLAUDE_CREDENTIAL_DIR_RELPATH);
  const narrowedClaudeTarget = exists(claudeCredentialDir) ? claudeCredentialDir : join(opts.realHome, CLAUDE_REL);

  return {
    workerHome: opts.workerHome,
    rcFiles: WORKER_HOME_RC_FILES.map((f) => join(opts.workerHome, f)),
    symlinks: WORKER_HOME_SYMLINKS.map((s) => {
      let to: string;
      if (opts.workerKeychainPath && s.relPath === LOGIN_KEYCHAIN_REL) {
        to = opts.workerKeychainPath;
      } else if (s.relPath === CLAUDE_REL) {
        to = narrowedClaudeTarget;
      } else {
        to = join(opts.realHome, s.relPath);
      }
      return { from: join(opts.workerHome, s.relPath), to, reason: s.reason };
    }),
    claudeGrantTarget: narrowedClaudeTarget,
  };
}

/** Filename prefix the CLI's own backup writer uses when it replaces `.claude.json`:
 *  `<prefix><epoch-ms>` under `<claudeGrantTarget>/backups/`. INVARIANT: this module never WRITES one
 *  — it only observes and reaps what the CLI leaves behind. */
export const CLAUDE_CONFIG_BACKUP_PREFIX = ".claude.json.backup.";

/** Where the CLI's own `.claude.json` backups land for a `.claude`-grant target: `backups/` under it,
 *  SHARED across every concurrent worker because the grant target is. */
export function claudeConfigBackupDir(claudeGrantTarget: string): string {
  return join(claudeGrantTarget, "backups");
}

/** Default bound for {@link sweepClaudeConfigBackups}: keep the newest 20 backups, reap the rest. A
 *  count cap rather than an age cap because these are written on every spawn, so an age-only bound
 *  would still grow without limit inside one busy day. */
export const DEFAULT_CLAUDE_CONFIG_BACKUP_MAX_KEEP = 20;

export interface ClaudeConfigBackupSweepSummary {
  removed: string[];
  kept: string[];
}

const claudeConfigBackupFsOps = { readdirSync, rmSync };
type ClaudeConfigBackupFsOps = typeof claudeConfigBackupFsOps;

/** W1-T981: bound and OBSERVE the CLI's `.claude.json` backups instead of letting them accumulate in
 *  the shared granted `.claude` directory. Keeps the `maxKeep` newest by the epoch in each filename.
 *  INVARIANT: best-effort and never throws — an absent `backups/` directory is a silent, correct
 *  no-op, so this adds no refusal path. */
export function sweepClaudeConfigBackups(
  claudeGrantTarget: string,
  opts: { maxKeep?: number; fsImpl?: Partial<ClaudeConfigBackupFsOps> } = {},
): ClaudeConfigBackupSweepSummary {
  const f = { ...claudeConfigBackupFsOps, ...opts.fsImpl };
  const maxKeep = opts.maxKeep ?? DEFAULT_CLAUDE_CONFIG_BACKUP_MAX_KEEP;
  const dir = claudeConfigBackupDir(claudeGrantTarget);
  const removed: string[] = [];
  const kept: string[] = [];

  let entries: string[];
  try {
    entries = f.readdirSync(dir);
  } catch {
    return { removed, kept }; // no backups dir yet — nothing to bound, best-effort
  }

  const byEpochDesc = entries
    .filter((name) => name.startsWith(CLAUDE_CONFIG_BACKUP_PREFIX))
    .map((name) => {
      const epoch = Number(name.slice(CLAUDE_CONFIG_BACKUP_PREFIX.length));
      return { name, epoch: Number.isFinite(epoch) ? epoch : 0 };
    })
    .sort((a, b) => b.epoch - a.epoch);

  byEpochDesc.forEach(({ name }, i) => {
    if (i < maxKeep) {
      kept.push(name);
      return;
    }
    try {
      f.rmSync(join(dir, name), { force: true });
      removed.push(name);
    } catch {
      kept.push(name); // a permissions hiccup on one entry never blocks the rest
    }
  });

  return { removed, kept };
}

/** `lstat`, not `stat`: a SYMLINK named `.git` must be judged as itself, never followed.
 *  `throwIfNoEntry: false` rather than a catch — a vanished entry answers "not a directory", which
 *  {@link isRepositoryShaped} reads as a worktree pointer and DISQUALIFIES, the fail-closed
 *  direction. A genuine read error (EACCES) still throws and reaches the caller: refusing loudly is
 *  this guard's contract, and swallowing it here would erase the one signal saying the answer is
 *  unknown. */
function defaultIsDirectory(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

/** Is this `.git` entry actually a repository? A linked worktree's `.git` is a FILE carrying a
 *  `gitdir:` pointer, so anything that is not a directory disqualifies (fail-closed). A clone's
 *  `.git` DIRECTORY always carries `HEAD`.
 *
 *  AN EMPTY DIRECTORY NAMED `.git` IS NOT A REPOSITORY, and git itself agrees — `git -C /tmp
 *  rev-parse` on such a tree exits "not a repository". MEASURED 2026-09-06: an empty `/tmp/.git` on
 *  the fleet host made ALL of `/tmp` read as a work tree, so every worker home under it was refused
 *  with WorkerHomePlacementError. CI was green and the reviewer red, because only the fleet host
 *  carried the stray directory — a host-wide outage of worker-home materialization, invisible except
 *  as unexplained proof failures. */
function isRepositoryShaped(
  gitEntry: string,
  exists: (path: string) => boolean,
  isDirectory: (path: string) => boolean,
): boolean {
  if (!isDirectory(gitEntry)) return true;
  return exists(join(gitEntry, "HEAD"));
}

/** W1-T2633: PURE — walks `homePath`'s own ancestors, from `homePath` to the filesystem root, and
 *  returns the first `.git` entry found or `undefined`. INVARIANT: a `.git` entry is either a
 *  DIRECTORY (a clone) or a FILE (a linked worktree's `gitdir:` pointer) and both disqualify the home
 *  equally. Walking ancestors needs no repo path threaded through, so every caller gets the guard. */
export function gitWorkTreeAncestor(
  homePath: string,
  exists: (path: string) => boolean = existsSync,
  isDirectory: (path: string) => boolean = defaultIsDirectory,
): string | undefined {
  let dir = resolve(homePath);
  for (;;) {
    const gitEntry = join(dir, ".git");
    if (exists(gitEntry) && isRepositoryShaped(gitEntry, exists, isDirectory)) return gitEntry;
    const parent = dirname(dir);
    if (parent === dir) return undefined; // reached the filesystem root — no work tree found
    dir = parent;
  }
}

/** W1-T2633: thrown by {@link materializeWorkerHome} BEFORE anything is written, when the resolved
 *  worker home would land inside a git work tree. Refusing is the loud failure and writing is the
 *  silent one. `workerHome` and `gitAncestor` are carried on the error, so a caller can assert. */
export class WorkerHomePlacementError extends Error {
  override name = "WorkerHomePlacementError";
  constructor(
    public readonly workerHome: string,
    public readonly gitAncestor: string,
  ) {
    super(
      `worker home ${workerHome} resolves inside a git work tree (found ${gitAncestor}) — refusing ` +
        "to materialize rc files or symlinks into a tracked tree. A worker home must never be " +
        "inside a git work tree; point workerHomeRoot (or root) somewhere outside every checkout.",
    );
  }
}

/** Materialize a {@link WorkerHomePlan} on disk: guarantee every rc file exists and is EMPTY, and
 *  symlink each real-HOME path back in.
 *  INVARIANT: a stale rc file is truncated, never preserved — this directory is Remudero-owned, so a
 *  prior run's leftovers are debris and not operator content.
 *  INVARIANT: best-effort per symlink. An absent source is skipped rather than thrown, because
 *  isolation must not depend on every optional tool being installed; a correct link is left alone; one
 *  pointing elsewhere is replaced. W1-T2633: REFUSES when `opts.workerHome` is in a git work tree. */
export function materializeWorkerHome(opts: {
  workerHome: string;
  realHome: string;
  /** See {@link workerHomePlan} — the W1-T235 dedicated worker keychain. */
  workerKeychainPath?: string;
  /** See {@link workerHomePlan} — injectable for the W1-T505 `.claude` narrowing's tests. */
  exists?: (path: string) => boolean;
}): WorkerHomePlan {
  const gitAncestor = gitWorkTreeAncestor(opts.workerHome, opts.exists ?? existsSync);
  if (gitAncestor) {
    throw new WorkerHomePlacementError(opts.workerHome, gitAncestor);
  }

  const plan = workerHomePlan(opts);

  mkdirSync(plan.workerHome, { recursive: true });
  for (const rc of plan.rcFiles) {
    // Zero-byte by construction, every time — never appended to, never trusted to have been left
    // empty by something else.
    writeFileSync(rc, "");
  }

  const outcomes: WorkerHomeGrantOutcome[] = [];
  for (const link of plan.symlinks) {
    const relFrom = relative(plan.workerHome, link.from);
    if (!existsSync(link.to)) {
      // THE OPTIONAL-GRANT SKIP, deliberate and unchanged: the target genuinely is not on this host,
      // so there is nothing to grant. INVARIANT: this path stays silent — an error here would break
      // every host where a grant is unavailable by design.
      outcomes.push({ relFrom, to: link.to, state: "absent" });
      continue;
    }
    let displacedTo: string | undefined;
    try {
      const st = lstatSync(link.from);
      if (st.isSymbolicLink() && readlinkSync(link.from) === link.to) {
        outcomes.push({ relFrom, to: link.to, state: "already" });
        continue; // already correct
      }
      if (st.isDirectory() && !st.isSymbolicLink()) {
        // A REAL DIRECTORY IN THE SLOT. `unlinkSync` cannot remove one and `symlinkSync` then throws
        // EEXIST, so before this the directory won permanently and silently. MOVED ASIDE, NEVER
        // DELETED: it is written by the CLI we are granting to and is the only evidence of what
        // poisoned the slot. // Why: docs/forensics/worker-home.md#a-real-directory-in-the-slot.
        displacedTo = `${link.from}.displaced-${Date.now()}-${randomBytes(3).toString("hex")}`;
        renameSync(link.from, displacedTo);
      } else {
        // Something occupies the slot but points at the WRONG target (a stale symlink from a moved
        // real HOME, or debris) — clear it so the create below self-heals instead of no-oping EEXIST.
        unlinkSync(link.from);
      }
    } catch {
      // Does not exist yet, or could not be cleared — fall through to the create attempt below,
      // which is what reports the real outcome.
    }
    mkdirSync(dirname(link.from), { recursive: true });
    try {
      symlinkSync(link.to, link.from);
      outcomes.push(
        displacedTo
          ? { relFrom, to: link.to, state: "displaced", displacedTo }
          : { relFrom, to: link.to, state: "linked" },
      );
    } catch (e) {
      // Racing another worker materializing the same shared home, or debris that could not be
      // cleared — never fatal to isolation itself, since the rc files are what isolate. NO LONGER
      // SILENT: the target exists and we failed to reach it, which is a lost capability.
      outcomes.push({
        relFrom,
        to: link.to,
        state: "failed",
        reason: String((e as Error)?.message ?? e),
        ...(displacedTo ? { displacedTo } : {}),
      });
    }
  }

  // W1-T981: bound the CLI's own `.claude.json` backups at the SAME resolved grant target this call
  // just symlinked `.claude` toward, so the sweep tracks W1-T505's narrowing automatically.
  const claudeConfigBackupSweep = sweepClaudeConfigBackups(plan.claudeGrantTarget!);

  return { ...plan, outcomes, claudeConfigBackupSweep };
}

// ── W1-T170: per-run/per-spawn worker HOMES (the singleton does not survive concurrency) ──
// INVARIANT: every concurrent worker gets its own home, with its own empty rc files and its own
// keychain/.claude/.config/gh symlinks. TRAP: two overlapping spawns truncating and symlinking the
// SAME rc files and keychain slot turn #100's deterministic, already-fixed HOME-relative keychain miss
// into an intermittent one. // Why: docs/forensics/worker-home.md#per-run-worker-homes (W1-T170).

const workerHomeFsOps = { existsSync, rmSync, readdirSync, statSync, readFileSync };
type WorkerHomeFsOps = typeof workerHomeFsOps;

/** W1-T2463: the delimiter between a per-spawn worker home's `runId` component and its per-spawn
 *  uniqueness token. INVARIANT: a dot can never collide with a runId's own characters — every runId in
 *  this repo is `${wordOrTaskId}-${Date.now()}` — so {@link stripPerSpawnToken}'s split is
 *  unambiguous. */
const PER_SPAWN_TOKEN_SEP = ".";

/** W1-T2463: the reverse of {@link perRunWorkerHomeDir}'s `perSpawn` encoding — strips a trailing
 *  `${PER_SPAWN_TOKEN_SEP}<token>` so {@link sweepStaleWorkerHomes}'s lookups compare against the SAME
 *  id the spawn was given. A suffix with no separator round-trips unchanged. */
function stripPerSpawnToken(suffix: string): string {
  const i = suffix.indexOf(PER_SPAWN_TOKEN_SEP);
  return i === -1 ? suffix : suffix.slice(0, i);
}

/** The per-spawn worker HOME: `<workerHomeRoot>-<id>`, a SIBLING of the singleton root — never the
 *  root itself, never nested under it (see {@link isReapableWorkerHome}, which enforces that on reap).
 *  INVARIANT: no two overlapping spawns ever share a home. `id` prefers the caller's `runId` because
 *  it is durable and legible in `ps` and logs, but an absent one falls back to a fresh `randomUUID()`.
 *  W1-T2463: `opts.perSpawn` appends a token after `id`, so two spawns sharing one runId still get
 *  distinct homes. // Why: docs/forensics/worker-home.md#perrunworkerhomedir (W1-T170, W1-T2463). */
export function perRunWorkerHomeDir(
  workerHomeRoot: string,
  runId?: string,
  opts: { perSpawn?: boolean; spawnToken?: () => string } = {},
): string {
  const id = runId && runId.length > 0 ? runId : randomUUID();
  if (!opts.perSpawn) return `${workerHomeRoot}-${id}`;
  const token = (opts.spawnToken ?? randomUUID)();
  return `${workerHomeRoot}-${id}${PER_SPAWN_TOKEN_SEP}${token}`;
}

/** `true` IFF `target` is exactly `<root>-<nonempty-suffix>` — a per-spawn SIBLING of the singleton
 *  root, one segment, no traversal. INVARIANT: guards {@link reapWorkerHome} so a malformed target can
 *  never remove the singleton root or anything outside its own sibling. */
export function isReapableWorkerHome(root: string, target: string): boolean {
  const rootResolved = resolve(root);
  const t = resolve(target);
  if (t === rootResolved) return false; // never the singleton root itself
  const prefix = `${rootResolved}-`;
  if (!t.startsWith(prefix)) return false;
  const suffix = t.slice(prefix.length);
  return suffix.length > 0 && !suffix.includes("/");
}

export interface WorkerHomeReapResult {
  reaped: boolean;
  target?: string;
  reason?: string;
}

/** Best-effort reap of ONE per-spawn worker home, called at spawn teardown on EVERY exit path
 *  including a thrown error — the `withTempDir` discipline (W1-T115/W1-T131) applied to a resource
 *  that must not accumulate. Guarded by {@link isReapableWorkerHome}; never throws. */
export function reapWorkerHome(
  root: string,
  target: string,
  opts: { fsImpl?: Partial<WorkerHomeFsOps> } = {},
): WorkerHomeReapResult {
  try {
    const f = { ...workerHomeFsOps, ...opts.fsImpl };
    if (!isReapableWorkerHome(root, target)) return { reaped: false, target, reason: "guard-rejected" };
    if (!f.existsSync(target)) return { reaped: false, target, reason: "absent" };
    f.rmSync(target, { recursive: true, force: true });
    return { reaped: true, target };
  } catch (e) {
    return { reaped: false, target, reason: String((e as Error)?.message ?? e) };
  }
}

/** Default age ceiling for {@link sweepStaleWorkerHomes}: 24h — matches the other boot sweeps
 *  (lib/tmp.ts's `sweepStaleTempDirs`, lib/worker-scratch.ts's `sweepStaleWorkerScratch`). W1-T1064:
 *  this is the BACKSTOP for a candidate whose run id resolves to nothing, not the primary signal. */
export const DEFAULT_WORKER_HOME_SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface WorkerHomeSweepOpts {
  /** Reap a worker-home dir older than this, when its run id resolves to nothing — no live lock and
   *  no terminal ledger verdict. Default 24h. */
  maxAgeMs?: number;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
  fsImpl?: Partial<WorkerHomeFsOps>;
  /** W1-T1064: where `state/inflight/*.lock` files live — checked for a lock naming a candidate's run
   *  id BEFORE anything is removed, since a live lock keeps the home regardless of age. Defaults to
   *  `<dirname(root)>/state/inflight`, so every existing caller gets the predicate unchanged. */
  inflightDir?: string;
  /** W1-T1064: the ledger checked for a terminal `verdict` line naming a candidate's run id — the ONLY
   *  thing that authorises removing a home before the age ceiling. Defaults to
   *  `<dirname(root)>/state/ledger.ndjson`. */
  ledgerPath?: string;
  /** W1-T1064: print before clearing, always — called once per removal naming the home, its run id and
   *  the evidence that judged it dead, and once at the end of EVERY pass including the zero-removed
   *  case, so a pass that found nothing stale never reads the same as one that never ran. */
  log?: (step: string, fields: Record<string, unknown>) => void;
}

export interface WorkerHomeSweepSummary {
  removed: string[];
  kept: string[];
}

/** W1-T1064: `true` iff `inflightDir` holds a `*.lock` whose `run_id` names `runId` — a POSITIVE
 *  liveness signal that is file-based and survives a restart, unlike a live-pid check. INVARIANT: an
 *  ABSENT result proves nothing, because `sweepStaleInflightLocks` (inflight-lock.ts) reaps stale
 *  locks on its own schedule, so {@link sweepStaleWorkerHomes} uses this only to KEEP. */
function findLiveInflightLockForRun(inflightDir: string, runId: string, f: WorkerHomeFsOps): boolean {
  let entries: string[];
  try {
    entries = f.readdirSync(inflightDir);
  } catch {
    return false; // absent/unreadable inflight dir — proves nothing either way
  }
  for (const entry of entries) {
    if (!entry.endsWith(".lock")) continue;
    let raw: string;
    try {
      raw = f.readFileSync(join(inflightDir, entry), "utf8");
    } catch {
      continue; // vanished/unreadable between readdir and read — someone else's concern
    }
    const info = parseInflightLockInfo(raw);
    if (info && info.run_id === runId) return true;
  }
  return false;
}

/** W1-T1064: `true` iff `ledgerPath` holds a `step: "verdict"` line whose `run_id` names `runId` — the
 *  POSITIVE statement of death that authorises removing a home before the age ceiling. Every
 *  `run-task.ts` run stamps that exact shape on every terminal outcome, so this reads the SAME fact
 *  the daemon records, never a second notion of "done". */
function hasTerminalLedgerVerdict(ledgerPath: string, runId: string, f: WorkerHomeFsOps): boolean {
  let raw: string;
  try {
    raw = f.readFileSync(ledgerPath, "utf8");
  } catch {
    return false; // absent/unreadable ledger — nothing to find
  }
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // torn/unparseable line — dropped, same discipline readLedgerLines applies
    }
    const rec = parsed as { step?: unknown; run_id?: unknown };
    if (rec.step === "verdict" && rec.run_id === runId) return true;
  }
  return false;
}

/** Boot-time backstop, mirroring worker-scratch.ts's `sweepStaleWorkerScratch`: reap `<root>-<id>`
 *  homes a crashed process could not reach its own {@link reapWorkerHome} call for. Never throws.
 *  THE PREDICATE (W1-T1064), in order: a live `state/inflight/` lock naming this run id
 *  ({@link findLiveInflightLockForRun}) keeps the home REGARDLESS OF AGE and its absence proves
 *  nothing; then a terminal `verdict` line ({@link hasTerminalLedgerVerdict}) removes it NOW; anything
 *  else falls back to `maxAgeMs`. TRAP: age alone let homes accumulate until the disk hit 100% and
 *  tore a ledger write mid-record. // Why: docs/forensics/worker-home.md#sweepstaleworkerhomes. */
export function sweepStaleWorkerHomes(root: string, opts: WorkerHomeSweepOpts = {}): WorkerHomeSweepSummary {
  const f = { ...workerHomeFsOps, ...opts.fsImpl };
  const now = opts.now ?? (() => Date.now());
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_WORKER_HOME_SWEEP_MAX_AGE_MS;
  const log = opts.log;
  const removed: string[] = [];
  const kept: string[] = [];
  const parent = dirname(root);
  const prefix = `${basename(root)}-`;
  const inflightDir = opts.inflightDir ?? join(parent, "state", "inflight");
  const ledgerPath = opts.ledgerPath ?? join(parent, "state", LEDGER_FILENAME);

  let entries: string[];
  try {
    entries = f.readdirSync(parent);
  } catch {
    return { removed, kept }; // parent unreadable/absent — best-effort
  }

  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const full = join(parent, name);
    let mtimeMs: number;
    let isDir: boolean;
    try {
      const st = f.statSync(full);
      isDir = st.isDirectory();
      mtimeMs = st.mtimeMs;
    } catch {
      continue; // vanished between readdir and stat — someone else's cleanup won
    }
    if (!isDir) {
      kept.push(name);
      continue;
    }

    // W1-T2463: a per-spawn home's suffix is `<runId>${PER_SPAWN_TOKEN_SEP}<token>` when its call site
    // opted in — strip the token so the lookups below compare against the SAME runId the spawn was
    // given. A pre-W1-T2463 suffix has no separator and round-trips unchanged.
    const runId = stripPerSpawnToken(name.slice(prefix.length));
    if (findLiveInflightLockForRun(inflightDir, runId, f)) {
      kept.push(name); // live run: kept however old — no age check at all (claim 2)
      continue;
    }
    if (hasTerminalLedgerVerdict(ledgerPath, runId, f)) {
      try {
        f.rmSync(full, { recursive: true, force: true });
        removed.push(name);
        log?.("worker_home_reap.removed", {
          name,
          run_id: runId,
          reason: "terminal-verdict",
          detail: `terminal ledger verdict for run ${runId}, no live inflight lock — removed before the age ceiling`,
        });
      } catch {
        kept.push(name); // a permissions hiccup on one entry never blocks the rest
      }
      continue; // dead run: age is irrelevant once a positive statement of death exists
    }

    // Run id resolves to nothing (no lock, no verdict) — mtime age is the backstop.
    if (now() - mtimeMs <= maxAgeMs) {
      kept.push(name); // recent mtime ⇒ possibly a live spawn this predicate could not resolve
      continue;
    }
    try {
      f.rmSync(full, { recursive: true, force: true });
      removed.push(name);
      log?.("worker_home_reap.removed", {
        name,
        run_id: runId,
        reason: "age-ceiling",
        detail: `no live lock or ledger verdict for run ${runId}; aged past the ${maxAgeMs}ms ceiling`,
      });
    } catch {
      kept.push(name); // a permissions hiccup on one entry never blocks the rest
    }
  }
  log?.("worker_home_reap.summary", { removed: removed.length, kept: kept.length });
  return { removed, kept };
}

// ── W1-T235: the dedicated worker keychain (WS-7 keychain-unlock gate) ──────
// TRAP: the login keychain holds the `Claude Code-credentials` OAuth item and locks with the
// operator's session, so under the pre-T235 symlink a lock killed every headless spawn at $0 before
// any turn — and, because a credential-dead worker makes zero writes, that death rendered as the
// generic "containment UNPROVEN" misdiagnosis (fired live 2026-07-21).
// INVARIANT: the fleet READS the operator's login keychain exactly once, at provisioning, and NEVER
// unlocks it; every path throws a named class. // Why: docs/forensics/worker-home.md#the-dedicated-worker-keychain.

/** The generic-password service name Claude Code stores its OAuth token under. */
export const WORKER_KEYCHAIN_SERVICE = "Claude Code-credentials";

/** Named failure classes for the credential rung — queryable, not prose. The first four are the macOS
 *  keychain rung's own (W1-T235); the next two are the NON-DARWIN file store's (see
 *  {@link classifyWorkerCredentialFile}), because a file has more ways to be wrong than a keychain and
 *  collapsing them would undo the taxonomy. The last is W1-T2398's: usable now, but too short. */
export type WorkerKeychainReasonClass =
  | "login-keychain-locked"
  | "credential-item-missing"
  | "worker-keychain-unlock-failed"
  | "provision-failed"
  | "credential-file-unreadable"
  | "credential-file-malformed"
  | "credential-too-short-for-run"
  /** R-3: the keychain PROVISIONING LOCK was still held by a holder judged live after this call
   *  waited out `keychainProvisionLockWaitMs`. Named separately from `provision-failed` on
   *  purpose: nothing was attempted and nothing is wrong with the credential — the spawn is
   *  refused because a peer (or an unreclaimable ghost of one) owns the store's lock, which is a
   *  different operator action from any other member of this union. */
  | "keychain-provision-lock-timeout";

/** A credential-NAMED failure out of the worker-keychain rung. INVARIANT: thrown BEFORE any worker
 *  spawns, so a locked or missing credential fails loudly at the spawn boundary instead of spawning a
 *  credential-dead worker whose zero-write death reads as "containment UNPROVEN" (2026-07-21). */
export class WorkerKeychainError extends Error {
  override name = "WorkerKeychainError";
  constructor(
    public readonly reasonClass: WorkerKeychainReasonClass,
    message: string,
  ) {
    super(message);
  }
}

export interface WorkerKeychainPaths {
  /** The dedicated worker keychain DB file. */
  keychainPath: string;
  /** The 0600 file persisting the keychain's password across boots. */
  passwordPath: string;
  /** The 0600 sidecar recording which account identity (an `EnsureWorkerKeychainOpts.accountId` NAME,
   *  never a secret) this store was last provisioned for. A caller that never supplies `accountId`
   *  never touches this file. */
  identityPath: string;
  /** W1-T293: the 0600 sidecar recording the copied credential's OWN `claudeAiOauth.expiresAt` (a
   *  plain epoch-ms NUMBER, never the secret), so `ensureWorkerKeychain` detects staleness without
   *  re-reading the login keychain on every call. Absent when the credential carried no parseable
   *  expiry, in which case the gate reports "unknown". */
  expiryPath: string;
}

/** Canonical locations under the config state dir (`<config.root>/state`). `accountLabel` is an
 *  OPTIONAL, operator-chosen NAME — never a token, never derived from a credential — that partitions
 *  the store per Anthropic account; omitted ⇒ the legacy unlabelled paths, byte for byte. INVARIANT: a
 *  label picks WHICH FILE a store lives at, while `accountId` detects that file's identity drifting. */
export function workerKeychainPaths(stateDir: string, accountLabel?: string): WorkerKeychainPaths {
  const suffix = accountLabel ? `-${accountLabel}` : "";
  return {
    keychainPath: join(stateDir, `remudero-worker${suffix}.keychain-db`),
    passwordPath: join(stateDir, `worker-keychain-password${suffix}`),
    identityPath: join(stateDir, `worker-keychain-account${suffix}`),
    expiryPath: join(stateDir, `worker-keychain-expiry${suffix}`),
  };
}

/** Injectable `security(1)` invoker — tests record argv; the default shells out. */
export type SecurityRunner = (argv: string[]) => string;

const defaultSecurityRunner: SecurityRunner = (argv) =>
  execFileSync("security", argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export interface EnsureWorkerKeychainOpts extends WorkerKeychainPaths {
  /** The operator's real login keychain (read ONCE, at provisioning only). */
  loginKeychainPath: string;
  /** Apps granted per-item access to the copied credential (`-T`), e.g. the claude binary. Never `-A` (any-app). */
  grantApps?: string[];
  runner?: SecurityRunner;
  exists?: (path: string) => boolean;
  /** W1-T265: the Anthropic account identity active for THIS call — an `accountUuid`/`emailAddress`
   *  NAME, never a secret. TRAP: never the keychain item's own `acct` attribute, which
   *  account-usage.ts measured to be the OS username, identical across an account switch; the caller
   *  resolves it fresh from `~/.claude.json`. A mismatch against `identityPath` re-provisions. */
  accountId?: string;
  /** W1-T293: injectable clock for the credential-expiry sidecar gate below. Omitted ⇒ `Date.now`.
   *  Appended LAST, like every option below it — no positional caller shifts. */
  now?: () => number;
  /** W1-T293: a token AT OR WITHIN this window of its recorded `expiresAt` is treated as already
   *  stale, so a spawn never races a token that expires mid-run. Omitted ⇒
   *  {@link DEFAULT_CREDENTIAL_EXPIRY_SKEW_MS}. */
  credentialExpirySkewMs?: number;
  /** W1-T293 arm (3): set by the caller when the PRIOR spawn died on the containment preflight's
   *  expiry-named reason — forces THIS call to re-provision even when arm (2)'s sidecar read saw
   *  nothing wrong, because the token expired mid-run. Purely a caller-supplied hint. */
  priorSpawnCredentialExpired?: boolean;
  /** W1-T2398: how long (ms) the caller expects THIS run to take — the dispatcher's own estimate, never
   *  derived in here. Omitted ⇒ behavior is byte-for-byte what it was before this option, and this
   *  function never refuses on run length. Supplied, it does two things inside the already-running gate
   *  below, with no new fetch and no re-authentication. (1) It WIDENS the skew fed to
   *  {@link classifyCredentialSidecar} to `Math.max(skew, expectedRunMs)`, so the constant becomes a
   *  FLOOR. (2) It then THROWS `credential-too-short-for-run` rather than spawning doomed to lose auth. */
  expectedRunMs?: number;
}

/** Why THIS call did (or didn't) provision — the switch's audit trail (W1-T265), now also naming a
 *  same-account copy that went stale on its own clock (W1-T293). */
export type WorkerKeychainProvisionReason = "absent" | "identity-changed" | "credential-expired" | "skipped";

export interface WorkerKeychainSummary {
  keychainPath: string;
  /** `true` when THIS call created + populated the keychain. */
  provisioned: boolean;
  unlocked: true;
  /** The `accountId` this call compared and stamped, mirrored from the opt of the same name — a NAME,
   *  never a credential value. `undefined` when the caller never supplied one. */
  account_label?: string;
  /** `"absent"` (nothing existed) | `"identity-changed"` (mismatch) | `"skipped"` (matched, or no accountId supplied). */
  reason: WorkerKeychainProvisionReason;
  /** W1-T2398: `recordedExpiresAt - now` for the credential THIS call is handing out, measured at the
   *  check below and independent of whether `opts.expectedRunMs` was supplied, so a caller logging this
   *  field makes the rate answerable off-host. `undefined` exactly when no numeric expiry is known. */
  observedHeadroomMs?: number;
}

function classifyLoginReadError(err: unknown): WorkerKeychainReasonClass {
  const text = String((err as Error)?.message ?? err);
  if (/interaction is not allowed/i.test(text)) return "login-keychain-locked";
  if (/could not be found/i.test(text)) return "credential-item-missing";
  return "provision-failed";
}

/** Default FLOOR, not the whole margin — see `EnsureWorkerKeychainOpts.expectedRunMs` (W1-T2398). A
 *  stored token AT OR WITHIN this window of its recorded `expiresAt` is treated as already stale.
 *  TRAP: on its own this answers only "is this credential expired NOW" — a spawn holding six minutes
 *  of credential passes a bare five-minute check and loses it six minutes in. */
export const DEFAULT_CREDENTIAL_EXPIRY_SKEW_MS = 5 * 60 * 1000;

/** Pure: pull `claudeAiOauth.expiresAt` (epoch ms) out of the RAW secret the login keychain's
 *  `Claude Code-credentials` item carries. VERIFIED FROM SOURCE against a live host's
 *  `~/.claude/.credentials.json`, byte-identical to what `find-generic-password -w` returns.
 *  INVARIANT: `undefined` for anything else, and callers must never invent a field for it. */
export function extractCredentialExpiryMs(secret: string): number | undefined {
  if (!secret || secret.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    return undefined;
  }
  const expiresAt = (parsed as { claudeAiOauth?: { expiresAt?: unknown } } | null)?.claudeAiOauth?.expiresAt;
  return typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : undefined;
}

/** Verdict of the cheap, sidecar-only arm-2 staleness read, below. */
export type CredentialSidecarVerdict = "unknown" | "fresh" | "expired" | "broken";

/** Pure: parse a RECORDED expiry-sidecar value into its epoch-ms number, or `undefined` for anything
 *  that isn't one. Factored out so {@link classifyCredentialSidecar} and W1-T2398's headroom read
 *  share the exact parse, never a second hand-rolled copy. */
function parseSidecarExpiryMs(recorded: string | undefined): number | undefined {
  if (recorded === undefined) return undefined;
  const trimmed = recorded.trim();
  if (trimmed === "") return undefined;
  const expiresAt = Number(trimmed);
  return Number.isFinite(expiresAt) ? expiresAt : undefined;
}

/** Pure: classify a RECORDED expiry-sidecar value (never the credential itself) against a clock and
 *  skew. `undefined` — no sidecar file — is `"unknown"`: arm (2) has nothing to say and only arm (3)'s
 *  explicit hint can force a re-provision. INVARIANT: a present-but-empty or non-numeric value is
 *  `"broken"` — the #29896 wipe shape at the sidecar layer — and never reads as healthy. */
export function classifyCredentialSidecar(
  recorded: string | undefined,
  opts: { nowMs: number; skewMs: number },
): CredentialSidecarVerdict {
  if (recorded === undefined) return "unknown";
  if (recorded.trim() === "") return "broken";
  const expiresAt = parseSidecarExpiryMs(recorded);
  if (expiresAt === undefined) return "broken";
  return opts.nowMs + opts.skewMs >= expiresAt ? "expired" : "fresh";
}

// ── recon-cloud-workers-spike stop 6: the NON-DARWIN credential rung ────────
// WHAT THIS CLOSES: a credential-dead worker is not silent on Linux — `probeContainment`
// (containment.ts) already classifies the death. What Linux lacks is the darwin rung's TIMING and
// COST: reading the credential before anything spawns costs a file read, not a probe worker on every
// dispatch attempt, forever. INVARIANT: expiry is NOT a failure here. On darwin an expired credential
// triggers re-provisioning; on Linux the file IS the source and the CLI refreshes it, so throwing on
// a past `expiresAt` would fire a bound on a healthy condition (W1-T312, W1-T380, W1-T382).

/** Where the non-darwin credential store lives — the path the CLI documents, and the SAME directory
 *  `WORKER_HOME_SYMLINKS` already grants into every per-run worker HOME (measured at spawn time: the
 *  grant materialises and the file is readable from inside the worker). */
export function workerCredentialFilePath(realHome: string): string {
  return join(realHome, ".claude", ".credentials.json");
}

/** {@link classifyWorkerCredentialFile}'s verdict. `usable` carries the expiry when the file states
 *  one — `undefined` means the file does not say, which is NOT a failure (see
 *  {@link extractCredentialExpiryMs}'s "never invent a field" contract). */
export type WorkerCredentialFileVerdict =
  | { kind: "usable"; expiresAtMs?: number }
  | { kind: "unusable"; reasonClass: WorkerKeychainReasonClass; detail: string };

/** PURE (given a reader): classify the non-darwin credential file. Four observations, four answers,
 *  none collapsed — the same null/empty discipline `readLedgerLines` and `GitHub.readFailed` keep.
 *  ENOENT is `credential-item-missing`, the SAME class the darwin rung uses because it is the same
 *  fact; any other throw is `credential-file-unreadable`, because a permissions problem is not an
 *  absence; non-JSON bytes are `credential-file-malformed`, as is JSON with no `claudeAiOauth` object.
 *  TRAP: a file was observed holding only an `mcpOAuth` section, which a file-exists check waves
 *  through. Anything else is `usable`; expiry is reported, never refused. */
export function classifyWorkerCredentialFile(read: () => string): WorkerCredentialFileVerdict {
  let raw: string;
  try {
    raw = read();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === "ENOENT"
      ? { kind: "unusable", reasonClass: "credential-item-missing", detail: "no credential file at that path" }
      : { kind: "unusable", reasonClass: "credential-file-unreadable", detail: `read failed (${code ?? "unknown"})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "unusable", reasonClass: "credential-file-malformed", detail: "file is not valid JSON" };
  }
  const oauth = (parsed as { claudeAiOauth?: unknown } | null)?.claudeAiOauth;
  if (typeof oauth !== "object" || oauth === null) {
    return {
      kind: "unusable",
      reasonClass: "credential-file-malformed",
      detail: "file parses but carries no claudeAiOauth section — it holds no Claude credential",
    };
  }
  // REUSED, never re-derived: the SAME extractor the darwin sidecar path runs against the keychain
  // secret, which its own doc records as byte-identical in shape to this file.
  return { kind: "usable", expiresAtMs: extractCredentialExpiryMs(raw) };
}

/** The non-darwin analogue of {@link ensureWorkerKeychain}'s refusal half: throw
 *  {@link WorkerKeychainError} with a named class BEFORE any worker spawns, so an unusable credential
 *  costs a file read rather than a probe worker. INVARIANT: `read` is injectable for tests, but the
 *  default is the real `readFileSync` and the suite drives THAT against real fixtures. */
export function assertWorkerCredentialFile(
  path: string,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
  envToken: string | undefined = process.env.CLAUDE_CODE_OAUTH_TOKEN,
): number | undefined {
  const verdict = classifyWorkerCredentialFile(() => read(path));
  // A TOKEN IS A CREDENTIAL TOO (impl-ED). INVARIANT: the refusal below still fires when NEITHER
  // credential exists — what was wrong was the guard's REACH, not the guard: it tested only for the
  // `/login` file and so refused every container authenticated the one way a container can be. The
  // CLI's documented precedence ranks this env var ABOVE the `/login` credential. KNOWN GAP, not
  // solved here: a bare token carries no `claudeAiOauth.expiresAt`, so the fleet's expiry machinery is
  // BLIND to it — a worker runs for a year, then every dispatch fails at once, with no warning.
  if (verdict.kind === "unusable" && typeof envToken === "string" && envToken.length > 0) {
    return undefined;
  }
  if (verdict.kind === "unusable") {
    throw new WorkerKeychainError(
      verdict.reasonClass,
      `worker credential: ${verdict.detail} (${path}) — refusing to spawn a credential-dead worker`,
    );
  }
  return verdict.expiresAtMs;
}

// W1-T293 arm (6): NO HOT LOOP. Module-level and per-boot, so a daemon whose LOGIN token is dead
// escalates ONCE per keychainPath and every later credential-expired call in the same boot fails fast
// on the remembered reason class without touching `security` again. Scoped to the credential-expired
// trigger only: the absent and identity-changed arms keep their unbounded behavior.
const MAX_CREDENTIAL_RECOVERY_ATTEMPTS = 1;
const credentialRecoveryFailures = new Map<string, { count: number; lastReasonClass: WorkerKeychainReasonClass }>();

// ── W1-T339: serialize ONLY the provisioning branch, not the whole function ────
// WHAT IS ALREADY SAFE: the password write is atomic (`wx`) and converges losers onto the winner's
// password, and the steady-state read path costs one fs read and two idempotent `security` calls.
// WHAT IS NOT: the provisioning branch DELETES and recreates the store, so two lanes both deciding to
// (re-)provision would have one lane's `rmSync` pull the store out from under the other mid-write,
// which presents as flaky auth rather than as a lock bug. INVARIANT: unlike `acquireInflightLock`,
// a live holder here means "a peer is provisioning THIS keychain right now", so this lock WAITS and
// converges rather than throwing. // Why: docs/forensics/worker-home.md#the-provisioning-lock.

/** `<keychainPath>.provision.lock` — co-located with the store it guards, so the lock is scoped per
 *  keychain (a labelled per-account store never serializes against an unrelated one) and is
 *  discoverable next to the file it protects. */
export function keychainProvisionLockPath(keychainPath: string): string {
  return `${keychainPath}.provision.lock`;
}

interface KeychainProvisionLockInfo {
  pid: number;
  /** `os.hostname()` of the process that wrote the lock. RECORDED SINCE R-3, and the reason is
   *  {@link isHolderStale}'s rung 1: a pid is only ever meaningful on the host that assigned it,
   *  so without this field every liveness probe below answers a question about OUR process table
   *  that says nothing about the recorded holder. OPTIONAL on the READ side — a lock written
   *  before this field existed carries none, and `isHolderStale` skips its host rung for exactly
   *  that shape rather than inventing an identity for it. */
  host?: string;
  startedAt: string;
}

function parseKeychainProvisionLockInfo(raw: string): KeychainProvisionLockInfo | null {
  try {
    const o = JSON.parse(raw);
    return typeof o?.pid === "number" ? (o as KeychainProvisionLockInfo) : null;
  } catch {
    return null;
  }
}

/** Blocking synchronous sleep (`ensureWorkerKeychain` is synchronous end to end, so the wait loop
 *  below cannot `await`). `Atomics.wait` on a throwaway `SharedArrayBuffer` is the standard Node idiom
 *  — no native dependency, no busy-spin burning CPU between polls. */
function defaultSleepSyncMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** How often a waiting loser re-checks whether the provisioning lock has freed up. */
const KEYCHAIN_PROVISION_LOCK_POLL_MS = 20;

export interface KeychainProvisionLockHandle {
  readonly path: string;
  /** Idempotent — safe from a `finally`. */
  release(): void;
}

export interface AcquireKeychainProvisionLockOpts {
  /** Injectable liveness probe, forwarded to {@link isHolderStale} (tests). Defaults to
   *  {@link defaultIsPidAlive}. */
  isPidAlive?: (pid: number) => boolean;
  /** Injectable process-start-time probe, forwarded to {@link isHolderStale} (tests). Defaults to
   *  fs-race-safe.ts's own `defaultGetProcessStartTime`. */
  getProcessStartTime?: (pid: number) => number | null;
  /** This host's own identity, forwarded to {@link isHolderStale}'s rung 1 (tests). Defaults to
   *  `os.hostname()` — the SAME writer this function records, so the two agree by construction. */
  hostname?: () => string;
  /** Whether THIS process is containerised, forwarded to {@link isHolderStale}'s rung 1 (tests).
   *  Defaults to fs-race-safe.ts's own `defaultInContainer`. */
  inContainer?: () => boolean;
  /** Injectable blocking sleep between polls (tests). Defaults to {@link defaultSleepSyncMs}. */
  sleepSyncMs?: (ms: number) => void;
  /** Injectable clock for the wait deadline below (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** How long (ms) this call may wait on a LIVE holder before throwing. Omitted ⇒
   *  plan/policy.yaml's `keychainProvisionLockWaitMs` row, falling back to
   *  {@link DEFAULT_KEYCHAIN_PROVISION_LOCK_WAIT_MS} when that file cannot be read at all. */
  waitDeadlineMs?: number;
  /** TEST-ONLY seam standing in for the committed-policy READ itself, so a test can drive the
   *  branch where that read FAILS. `loadDefaultPolicy` resolves from `import.meta.url` and
   *  memoizes for the process lifetime, so its failure path is unreachable from a test by any
   *  other means — and an unreachable catch arm is this repo's own recorded coverage trap
   *  (#978). Same `__`-prefixed convention `acquireInflightLock`'s `__beforeReclaimDelete` uses;
   *  never set outside tests. */
  __readCommittedWaitMs?: () => number;
}

/**
 * THE WAIT DEADLINE, resolved from policy through the `??` seam this repo's other policy
 * consumers use (`test/config-reader-seams.test.ts` enforces that shape).
 *
 * WRAPPED, AND THE WRAPPING IS LOAD-BEARING. `loadDefaultPolicy` THROWS on an absent or malformed
 * install policy, and this lock is held on the daemon's own boot path — turning "no readable
 * policy.yaml" into a thrown boot failure would be a worse defect than the one this deadline
 * fixes, and turning it into an unbounded wait would be the SAME one. So an unreadable policy
 * falls back to the committed default, which is the same figure the row itself carries. Same
 * shape, and the same reason, as `serveCommand`'s own `githubEventWakePolicy` read (W1-T2568).
 */
export function resolveKeychainProvisionLockWaitMs(opts: AcquireKeychainProvisionLockOpts): number {
  try {
    return opts.waitDeadlineMs ?? opts.__readCommittedWaitMs?.() ?? loadDefaultPolicy().values.keychainProvisionLockWaitMs;
  } catch (e) {
    // RECORDED, never swallowed: falling back is correct here, but "the committed policy could not
    // be read at all" is a fact about the install, not a routine outcome, and the only place it
    // could otherwise surface is a bound that silently stopped being the operator's. Same
    // visible-trace precedent `reclaimStaleLock`'s own onReclaim/onLostReclaim defaults set.
    console.error(
      `[keychain-provision-lock] could not read the committed keychainProvisionLockWaitMs ` +
        `(${e instanceof Error ? e.message : String(e)}); waiting with the built-in default ` +
        `${DEFAULT_KEYCHAIN_PROVISION_LOCK_WAIT_MS}ms instead`,
    );
    // No `opts.waitDeadlineMs ??` here: `??` short-circuits, so a caller-supplied deadline never
    // reaches `loadDefaultPolicy` at all and this branch is only ever entered with none.
    return DEFAULT_KEYCHAIN_PROVISION_LOCK_WAIT_MS;
  }
}

/** Acquire the exclusive provisioning lock for `keychainPath`, WAITING (never letting the caller
 *  proceed uncoordinated) while a live peer holds it — but only up to a DEADLINE, past which it
 *  throws {@link WorkerKeychainError} naming the holder it waited on.
 *  INVARIANT: a stale lock — its holder judged dead by the shared {@link isHolderStale}, or its file
 *  unreadable — is reclaimed via {@link reclaimStaleLock}, so a crashed provisioner cannot wedge every
 *  later dispatch. TRAP (R-3): judging staleness by `!isPidAlive(held.pid)` alone let a REUSED pid
 *  read as live forever, and the wait itself had no bound — `Atomics.wait` blocks the daemon's EVENT
 *  LOOP, so an unreclaimable lock froze the whole process. The uncontended path is unchanged: no
 *  policy read, no clock sample, no deadline until this call meets a live holder.
 *  // Why: docs/forensics/worker-home.md#acquirekeychainprovisionlock (R-3, W1-T339, W1-T368). */
export function acquireKeychainProvisionLock(
  keychainPath: string,
  opts: AcquireKeychainProvisionLockOpts = {},
): KeychainProvisionLockHandle {
  const isAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const sleep = opts.sleepSyncMs ?? defaultSleepSyncMs;
  const now = opts.now ?? Date.now;
  const lockPath = keychainProvisionLockPath(keychainPath);
  const info: KeychainProvisionLockInfo = {
    pid: process.pid,
    host: (opts.hostname ?? hostname)(),
    startedAt: new Date(now()).toISOString(),
  };
  mkdirSync(dirname(lockPath), { recursive: true });

  // Set on the FIRST live holder this call meets, never before — see the doc above on keeping the
  // uncontended path free of both the policy read and the clock sample.
  let waitDeadlineAt: number | undefined;

  for (;;) {
    try {
      const fd = openSync(lockPath, "wx"); // create-or-fail; no TOCTOU gap
      writeSync(fd, JSON.stringify(info, null, 2));
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const result = reclaimStaleLock(lockPath, {
        parseHolder: parseKeychainProvisionLockInfo,
        isStale: (held) =>
          isHolderStale(held, {
            isPidAlive: isAlive,
            getProcessStartTime: opts.getProcessStartTime,
            hostname: opts.hostname,
            inContainer: opts.inContainer,
          }),
      });
      if (result.outcome === "live") {
        // A live peer is provisioning THIS store right now — WAIT and re-check rather than proceeding
        // alongside it. Its own release, or the next pass reclaiming its now-stale lock, is what
        // ordinarily ends this; the deadline is what ends it when neither ever happens.
        if (waitDeadlineAt === undefined) waitDeadlineAt = now() + resolveKeychainProvisionLockWaitMs(opts);
        if (now() >= waitDeadlineAt) {
          const held = result.holder;
          throw new WorkerKeychainError(
            "keychain-provision-lock-timeout",
            `worker-keychain provisioning lock ${lockPath} is still held after waiting for it: holder pid ` +
              `${held.pid}${held.host ? ` on host ${held.host}` : " (no host recorded)"}, started ${held.startedAt}. ` +
              `Refusing to wait longer — this wait is synchronous and blocks the daemon's event loop, so an ` +
              `unbounded one freezes the process outright. If that holder is genuinely gone, removing ${lockPath} ` +
              `releases it; if it is on another host, this process is correct never to reclaim it.`,
          );
        }
        sleep(KEYCHAIN_PROVISION_LOCK_POLL_MS);
        continue;
      }
      // "missing" | "reclaimed" | "lost" → loop back and retry the atomic create.
    }
  }

  let released = false;
  return {
    path: lockPath,
    release() {
      if (released) return;
      released = true;
      try {
        unlinkSync(lockPath);
      } catch {
        // already gone — idempotent
      }
    },
  };
}

/** What {@link deriveProvisionGate} decided, read-only — never mutates anything. */
interface ProvisionGate {
  identityChanged: boolean;
  credentialExpired: boolean;
  credentialSidecarBroken: boolean;
  treatAsAbsent: boolean;
  needsProvisioning: boolean;
  /** W1-T2398: the sidecar's recorded expiry (epoch ms), parsed independently of the skew comparison —
   *  present whenever the store exists, identity hasn't changed, and the sidecar holds a well-formed
   *  number, even when the credential is nowhere near stale. `undefined` when there is nothing
   *  parseable; never invented. Lets a caller measure headroom on the steady-state path. */
  recordedExpiresAtMs?: number;
}

/** Pure(ish) — reads `identityPath`/`expiryPath` but writes nothing — the W1-T265 identity gate and
 *  W1-T293 expiry gate, extracted (W1-T339) so they can be evaluated TWICE: before the provisioning
 *  lock, to decide whether this call needs it at all, and again after acquiring it, because a
 *  concurrent winner may have re-provisioned meanwhile. That is what lets a loser CONVERGE. */
function deriveProvisionGate(opts: EnsureWorkerKeychainOpts, storeExists: boolean): ProvisionGate {
  let identityChanged = false;
  if (storeExists && opts.accountId !== undefined) {
    let recordedId: string | undefined;
    try {
      recordedId = readFileSync(opts.identityPath, "utf8");
    } catch {
      recordedId = undefined;
    }
    identityChanged = recordedId !== opts.accountId;
  }

  let credentialExpired = false;
  let credentialSidecarBroken = false;
  let recordedExpiresAtMs: number | undefined;
  if (storeExists && !identityChanged) {
    // Read + parse ONCE, unconditionally — W1-T2398's headroom below needs the parsed value even on
    // the arm-(3)-forced path, which used to skip this read.
    let recorded: string | undefined;
    try {
      recorded = readFileSync(opts.expiryPath, "utf8");
    } catch {
      recorded = undefined; // no sidecar — predates this feature, or the credential carried no expiry field
    }
    recordedExpiresAtMs = parseSidecarExpiryMs(recorded);
    if (opts.priorSpawnCredentialExpired) {
      credentialExpired = true;
    } else {
      // W1-T2398: the skew constant (or a caller override) is a FLOOR, never the whole margin —
      // widened to the caller's expected run length so a credential that would expire mid-run reads
      // "expired" here exactly like one already stale, and takes the same re-provision path.
      const skewMs = Math.max(opts.credentialExpirySkewMs ?? DEFAULT_CREDENTIAL_EXPIRY_SKEW_MS, opts.expectedRunMs ?? 0);
      const verdict = classifyCredentialSidecar(recorded, { nowMs: (opts.now ?? Date.now)(), skewMs });
      if (verdict === "expired") credentialExpired = true;
      else if (verdict === "broken") credentialSidecarBroken = true; // present-but-empty/unparseable never reads as healthy
    }
  }
  // A broken sidecar means THIS store cannot be trusted — the same remedy as never having provisioned it at all.
  const treatAsAbsent = !storeExists || credentialSidecarBroken;
  return {
    identityChanged,
    credentialExpired,
    credentialSidecarBroken,
    treatAsAbsent,
    needsProvisioning: treatAsAbsent || identityChanged || credentialExpired,
    recordedExpiresAtMs,
  };
}

/** Guarantee the dedicated worker keychain exists, holds the credential item, never auto-locks, and
 *  is UNLOCKED — the invariant a headless spawn needs. INVARIANT: provisioning reads the item out of
 *  the login keychain, which must therefore be unlocked AT THAT MOMENT. It runs on the first call
 *  ever, and — when `opts.accountId` is supplied (W1-T265) — on any later call whose `accountId` no
 *  longer matches what the store was provisioned for. Every other call, including a cold-boot daemon
 *  while the login keychain is LOCKED, touches only the worker keychain. */
export function ensureWorkerKeychain(opts: EnsureWorkerKeychainOpts): WorkerKeychainSummary {
  const runner = opts.runner ?? defaultSecurityRunner;
  const exists = opts.exists ?? existsSync;

  // ATOMIC create-or-read (CodeQL alert #71, js/file-system-race). TRAP: a check-then-act let two
  // concurrent first-provisioners each generate a DIFFERENT password — last writer wins the file and
  // the keychain ends up keyed to a password the file no longer holds. `flag: "wx"` makes creation
  // exclusive in ONE syscall at mode 0600, so the loser gets EEXIST and reads the winner's password.
  let password = randomBytes(32).toString("hex");
  mkdirSync(dirname(opts.passwordPath), { recursive: true });
  try {
    writeFileSync(opts.passwordPath, password, { mode: 0o600, flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
    password = readFileSync(opts.passwordPath, "utf8"); // a concurrent provisioner won — converge on its password
  }

  let provisioned = false;
  const storeExists = exists(opts.keychainPath);

  // W1-T265 identity gate + W1-T293 expiry gate, folded into `deriveProvisionGate` (W1-T339). This
  // FIRST evaluation is read-only and lock-free: the steady-state majority find
  // `needsProvisioning: false` here and never touch the lock below.
  let gate = deriveProvisionGate(opts, storeExists);
  // W1-T2398: the expiry of the credential THIS call will hand out — starts as whatever the pre-lock
  // gate read, is refreshed after a peer-converge re-derive, and is overwritten with the freshly
  // copied secret's OWN expiry when this call is the one that (re-)provisions.
  let finalExpiresAtMs = gate.recordedExpiresAtMs;

  // Arm (6): fail fast, without touching the login keychain again, once a credential-expiry recovery
  // has already failed once this boot for this path. Checked before the lock, so a permanently dead
  // login token throws immediately instead of queueing behind the provisioning lock.
  if (gate.credentialExpired) {
    const prior = credentialRecoveryFailures.get(opts.keychainPath);
    if (prior && prior.count >= MAX_CREDENTIAL_RECOVERY_ATTEMPTS) {
      throw new WorkerKeychainError(
        prior.lastReasonClass,
        `worker-keychain credential-expiry recovery already failed ${prior.count} time(s) this boot for ` +
          `${opts.keychainPath} (last: ${prior.lastReasonClass}) — not re-reading the login keychain again ` +
          `until the process restarts. A permanently dead login token escalates ONCE, never re-copies a dead ` +
          `token on every spawn.`,
      );
    }
  }

  // W1-T339: SERIALIZE ONLY THE PROVISIONING BRANCH. A call whose gate above says "nothing to do"
  // never acquires this lock — the steady-state path stays as lock-free as it was before.
  if (gate.needsProvisioning) {
    const lock = acquireKeychainProvisionLock(opts.keychainPath);
    try {
      // RE-DERIVE, now holding the lock: a concurrent winner may have finished (re-)provisioning this
      // exact store while this call was waiting for it. A loser that skipped this re-check would
      // redundantly re-provision on top of what its peer just wrote — the hazard this lock prevents.
      gate = deriveProvisionGate(opts, exists(opts.keychainPath));
      finalExpiresAtMs = gate.recordedExpiresAtMs;

      if (gate.needsProvisioning) {
        // A mismatch or staleness verdict means a LIVE keychain file may already sit at this path, and
        // `create-keychain` refuses to overwrite one, so it must go first.
        if (exists(opts.keychainPath)) {
          try {
            rmSync(opts.keychainPath, { force: true });
          } catch {
            // Best-effort; a real removal failure surfaces below as provision-failed when
            // create-keychain hits the file it could not clear.
          }
        }
        // Read the item (attributes, then secret) BEFORE creating anything, so a locked or missing
        // credential leaves no half-provisioned keychain behind. INVARIANT: the `acct` attribute is
        // copied over unchanged as informational provenance ONLY — account-usage.ts measured it to be
        // the OS username, identical across an account switch — and is never the identity compared.
        let attrs: string;
        let secret: string;
        try {
          attrs = runner(["find-generic-password", "-s", WORKER_KEYCHAIN_SERVICE, opts.loginKeychainPath]);
          secret = runner([
            "find-generic-password",
            "-s",
            WORKER_KEYCHAIN_SERVICE,
            "-w",
            opts.loginKeychainPath,
          ]).replace(/\n$/, "");
        } catch (err) {
          const reasonClass = classifyLoginReadError(err);
          if (gate.credentialExpired) {
            credentialRecoveryFailures.set(opts.keychainPath, {
              count: (credentialRecoveryFailures.get(opts.keychainPath)?.count ?? 0) + 1,
              lastReasonClass: reasonClass,
            });
          }
          throw new WorkerKeychainError(
            reasonClass,
            `worker-keychain provisioning could not read the '${WORKER_KEYCHAIN_SERVICE}' item from the login keychain ` +
              `(${reasonClass}): ${String((err as Error)?.message ?? err)}. ` +
              `Provision while the login keychain is unlocked (an interactive session), then headless spawns no longer need it.`,
          );
        }
        const account = attrs.match(/"acct"<blob>="([^"]*)"/)?.[1] ?? "";
        try {
          runner(["create-keychain", "-p", password, opts.keychainPath]);
          // No -l (lock on sleep) / no -u (lock after timeout): never auto-locks.
          runner(["set-keychain-settings", opts.keychainPath]);
          const grants = (opts.grantApps ?? []).flatMap((app) => ["-T", app]);
          runner([
            "add-generic-password",
            "-a",
            account,
            "-s",
            WORKER_KEYCHAIN_SERVICE,
            "-w",
            secret,
            ...grants,
            opts.keychainPath,
          ]);
          provisioned = true;
        } catch (err) {
          if (gate.credentialExpired) {
            credentialRecoveryFailures.set(opts.keychainPath, {
              count: (credentialRecoveryFailures.get(opts.keychainPath)?.count ?? 0) + 1,
              lastReasonClass: "provision-failed",
            });
          }
          throw new WorkerKeychainError(
            "provision-failed",
            `worker-keychain provisioning failed while creating/populating ${opts.keychainPath}: ` +
              String((err as Error)?.message ?? err),
          );
        }
        if (gate.credentialExpired) credentialRecoveryFailures.delete(opts.keychainPath); // a successful recovery clears the boot-scoped cap
        if (opts.accountId !== undefined) {
          mkdirSync(dirname(opts.identityPath), { recursive: true });
          writeFileSync(opts.identityPath, opts.accountId, { mode: 0o600 });
        }
        // W1-T293: record the freshly-copied secret's OWN expiry (never the secret itself) for the
        // next call's cheap arm-2 read. No parseable `claudeAiOauth.expiresAt` ⇒ clear any stale
        // sidecar rather than misattributing a PREVIOUS copy's timestamp to this one.
        const expiresAtMs = extractCredentialExpiryMs(secret);
        if (expiresAtMs !== undefined) {
          writeFileSync(opts.expiryPath, String(expiresAtMs), { mode: 0o600 });
        } else {
          try {
            unlinkSync(opts.expiryPath);
          } catch {
            // already absent — fine
          }
        }
        // W1-T2398: this IS the freshest copy this call can produce — the value the headroom check
        // below must reason about, not the possibly-stale pre-provision reading.
        finalExpiresAtMs = expiresAtMs;
      }
      // else: a concurrent peer already (re-)provisioned this exact store while this call waited —
      // CONVERGE on its result rather than redoing the work. `gate` was just re-derived, so the
      // `reason` below correctly reports the peer's outcome.
    } finally {
      lock.release();
    }
  }

  // W1-T2398: the LAST gate, after any (re-)provisioning above has had its chance to fetch a fresher
  // copy — refuse BEFORE this credential is unlocked or handed to a spawn, never after.
  // `finalExpiresAtMs` is `undefined` exactly when no numeric expiry is known, and the comparison is
  // then skipped rather than inventing a deadline.
  let observedHeadroomMs: number | undefined;
  if (finalExpiresAtMs !== undefined) {
    observedHeadroomMs = finalExpiresAtMs - (opts.now ?? Date.now)();
    if (opts.expectedRunMs !== undefined && observedHeadroomMs < opts.expectedRunMs) {
      throw new WorkerKeychainError(
        "credential-too-short-for-run",
        `worker credential ${opts.keychainPath} has ${observedHeadroomMs}ms of headroom before its recorded ` +
          `expiry, less than the ${opts.expectedRunMs}ms this run is expected to take — refusing to spawn a ` +
          `worker whose credential cannot outlive its own run`,
      );
    }
  }

  try {
    runner(["unlock-keychain", "-p", password, opts.keychainPath]);
    // Re-pin on every call: settings are state, and a drifted auto-lock would resurrect the exact
    // failure this rung exists to remove.
    runner(["set-keychain-settings", opts.keychainPath]);
  } catch (err) {
    const raw = String((err as Error)?.message ?? err);
    throw new WorkerKeychainError(
      "worker-keychain-unlock-failed",
      `worker keychain ${opts.keychainPath} could not be unlocked: ` + raw.split(password).join("<redacted>"),
    );
  }

  return {
    keychainPath: opts.keychainPath,
    provisioned,
    unlocked: true,
    account_label: opts.accountId,
    reason: gate.treatAsAbsent
      ? "absent"
      : gate.identityChanged
        ? "identity-changed"
        : gate.credentialExpired
          ? "credential-expired"
          : "skipped",
    observedHeadroomMs,
  };
}
