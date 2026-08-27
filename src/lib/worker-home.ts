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
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { playwrightCacheRoot } from "./review.js";
import { defaultIsPidAlive } from "./drain-lock.js";
import { reclaimStaleLock } from "./fs-race-safe.js";
import { parseInflightLockInfo } from "./inflight-lock.js";

/**
 * GENERAL SHELL-ISOLATION MECHANISM (W1-T18 / OSS blocker).
 *
 * W1-T17's preflight probe (isolation.ts) PROVES isolation per run but cannot
 * MANUFACTURE it — until now, isolation held only because CLAUDE_CODE_SHELL=
 * /bin/bash sources `$HOME/.bashrc`, and THIS host happens to have none
 * (LEARNINGS.md, PR #8). A stranger's machine with a populated `~/.bashrc`
 * would get ZERO isolation from that config alone (FIELD FINDING 11b) — the
 * probe would catch it and fail the run closed, but every OSS user's first run
 * would trip the gate.
 *
 * This module manufactures isolation instead of hoping for an absent file:
 * every worker's HOME is redirected to a Remudero-controlled SCRATCH directory
 * (`<root>/worker-home`) that holds ONLY empty rc files Remudero itself wrote —
 * `$HOME/.bashrc` (and its zsh/bash siblings) can never be populated by the
 * operator, because it is never the operator's `$HOME` in the first place. The
 * things a worker genuinely needs from the real HOME (OAuth session, `gh`
 * auth, git identity) are symlinked back in explicitly, one path at a time —
 * never a wholesale HOME copy, the same allowlist discipline as env.ts's
 * ANTHROPIC_* boundary.
 *
 * WS-0 FIELD FINDING 11c — CORRECTED (W1-T18 live drill, this fix): the earlier
 * belief that "the Keychain OAuth token resolves off `USER`, not `HOME`" was
 * FALSE. USER is necessary but NOT sufficient: the macOS login keychain that
 * holds the `Claude Code-credentials` OAuth item is located HOME-RELATIVELY at
 * `$HOME/Library/Keychains/login.keychain-db`. So the moment HOME was redirected
 * to the scratch dir (which has no `Library/Keychains`), the keychain lookup hit
 * an empty path and Claude Code returned "Not logged in · Please run /login" —
 * exiting at $0 / 0 real turns BEFORE any tool ran, which is exactly why the
 * first post-#100 spawn (the containment probe) produced nothing (inside-write
 * absent, no denial, cost 0). The worker never started. The fix is the SAME
 * defensive symlink-back this module already does for `.claude`/`.config/gh`:
 * add `Library/Keychains/login.keychain-db` to the allowlist so the redirected
 * HOME resolves the real login keychain. This does NOT weaken isolation (the rc
 * files are still empty ⇒ 0 aliases/0 functions) or containment (keychain I/O is
 * mediated by `securityd` over XPC, not a direct file write into the sandbox
 * scope; the outside-cwd write is still OS-denied). Only the single keychain DB
 * file is granted — never the whole `~/Library`. Verified live: a trivial task
 * completes under the redirect, the containment probe passes, isolation stays
 * 0/0. See LEARNINGS.md and the drill (W1-T12e), now a real spawn-under-redirect.
 */

/** Empty-by-construction rc files a worker's HOME must hold — bash AND zsh
 * conventions, so isolation does not depend on which shell a worker's Bash
 * tool (or a direct `zsh` it spawns) happens to source. Remudero writes each
 * of these as a zero-byte file; the operator's real dotfiles are never
 * consulted, so their contents (or absence) cannot matter. */
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

/** One path a worker needs mirrored back from the real HOME into the
 * redirected scratch HOME, symlinked rather than copied (always current). */
export interface WorkerHomeSymlink {
  /** Path relative to HOME, e.g. `.claude` or `.config/gh`. */
  relPath: string;
  /** Why this one path is granted back — never a wholesale HOME copy. */
  reason: string;
}

/**
 * W1-T505: the credential-only sibling of the operator's real `.claude` that a worker's
 * `.claude` grant PREFERS. MEASURED at filing: the operator's whole `.claude` is 1.8GB —
 * 10,101 session transcripts, a `settings.json` that can inject env vars into the
 * operator's NEXT session, `history.jsonl`, `skills/`, `plugins/` — against the one thing a
 * worker actually needs, `.credentials.json` (509 bytes). When `<realHome>/.claude-fleet`
 * exists, {@link workerHomePlan} resolves the `.claude` grant to IT instead of the
 * operator's full `.claude`; when it does not exist, the grant falls back to today's
 * wholesale behaviour (see {@link workerHomePlan}) so no host is broken by upgrading before
 * this sibling has been populated (design points (ii)/(iv), W1-T505).
 */
export const WORKER_CLAUDE_CREDENTIAL_DIR_RELPATH = ".claude-fleet";

/**
 * The explicit allowlist of real-HOME paths a worker needs back, symlinked
 * individually. Mirrors env.ts's ALLOWLIST discipline: name each grant and its
 * reason, never inherit the rest of HOME wholesale.
 */
/**
 * The browser cache's path RELATIVE TO HOME, derived from the SAME resolver the launch path uses
 * ({@link playwrightCacheRoot}, `lib/review.ts`) rather than a second copy of its platform branch —
 * W1-T1063's design point, so the grant and the resolver cannot disagree.
 *
 * PASSING AN EMPTY ENV IS DELIBERATE. The no-override branch is the only one a worker can ever
 * take, because `ALLOWLIST` (`lib/env.ts`) passes PATH, HOME, TMPDIR, LANG, USER and the Claude
 * token and NOTHING ELSE into a spawn, so `PLAYWRIGHT_BROWSERS_PATH` cannot survive to be read.
 * That is the same reason `deploy/Dockerfile` gives for installing at the default path and setting
 * no variable at all, and it is why this grant — not a variable — is the mechanism.
 *
 * A SENTINEL HOME IS USED, NOT A REAL ONE, so the result is a pure relative path independent of
 * whose HOME is asked about: linux yields `.cache/ms-playwright`, darwin
 * `Library/Caches/ms-playwright`. BOTH PLATFORMS ARE COVERED — the fleet runs in the Linux
 * container, and the table already carries a macOS-specific entry beside this one.
 */
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

/**
 * PURE plan of what {@link materializeWorkerHome} will do — extracted so the
 * redirection logic is unit-testable without touching the filesystem. Every
 * `from` is under the redirected `workerHome`; every `to` is under the real
 * `realHome`, one explicit path at a time (never `workerHome === realHome`,
 * or the redirection grants nothing).
 */
export interface WorkerHomePlan {
  workerHome: string;
  rcFiles: string[];
  symlinks: Array<{ from: string; to: string; reason: string }>;
  /**
   * What ACTUALLY happened to each grant (W1-T442-adjacent, the seventh instance of this
   * repo's own law: a grant that FAILED is not a grant that was OPTIONAL). Populated by
   * {@link materializeWorkerHome}; absent on the pure {@link workerHomePlan}, which decides
   * nothing and touches no filesystem.
   */
  outcomes?: WorkerHomeGrantOutcome[];
  /**
   * W1-T981: whatever the `.claude` grant resolves to for THIS plan — the operator's whole
   * `.claude`, or W1-T505's narrowed credential-only sibling when populated. This is where the
   * CLI's own `.claude.json` backups land (see {@link CLAUDE_CONFIG_REL}), so
   * {@link materializeWorkerHome} sweeps it via {@link sweepClaudeConfigBackups}. Optional only
   * so a hand-built literal (e.g. a fixture testing {@link lostWorkerHomeGrants} in isolation)
   * need not carry it — {@link workerHomePlan} and {@link materializeWorkerHome} both always
   * populate it.
   */
  claudeGrantTarget?: string;
  /**
   * W1-T981: the outcome of sweeping `claudeGrantTarget`'s `.claude.json` backups, so that
   * bound is OBSERVABLE on every materialization rather than a silent background effect.
   * Populated by {@link materializeWorkerHome}; absent on the pure {@link workerHomePlan}.
   */
  claudeConfigBackupSweep?: ClaudeConfigBackupSweepSummary;
}

/**
 * One grant's real outcome. `absent` and `failed` MUST stay distinguishable — the absent
 * skip is a deliberate, correct optional-grant path (the mini legitimately lacks several),
 * while a failure is a silent loss of capability that has already cost real money.
 */
export interface WorkerHomeGrantOutcome {
  relFrom: string;
  to: string;
  /**
   * - `linked`    — the symlink was created (or re-pointed) and now resolves to `to`.
   * - `already`   — it already pointed at `to`; nothing done.
   * - `absent`    — the TARGET does not exist. An optional grant, skipped SILENTLY and
   *                 correctly: several are legitimately unavailable on the mini.
   * - `displaced` — a REAL DIRECTORY occupied the slot; it was moved aside (see
   *                 {@link WorkerHomeGrantOutcome.displacedTo}) and the link created.
   * - `failed`    — the grant could not be made. The worker runs WITHOUT it.
   */
  state: "linked" | "already" | "absent" | "displaced" | "failed";
  /** Where a `displaced` directory was moved to — kept, never deleted, so the thing that
   *  poisoned the slot is still inspectable afterwards. */
  displacedTo?: string;
  /** Why a `failed` grant failed — the error's own message, never a guess. */
  reason?: string;
}

/**
 * The grants that were LOST or HEALED — everything a caller should surface, and nothing it
 * should not. `absent` and the two healthy states are excluded deliberately: materialisation
 * runs per spawn and per probe tick, so reporting every grant would be four rows a spawn, while
 * `failed`/`displaced` are rare by construction (a displaced slot heals once and then reads
 * `already`). That asymmetry is what lets this be reported at all without becoming noise.
 */
export function lostWorkerHomeGrants(plan: WorkerHomePlan): WorkerHomeGrantOutcome[] {
  return (plan.outcomes ?? []).filter((o) => o.state === "failed" || o.state === "displaced");
}

/** The HOME-relative slot Claude Code resolves its keychain through. */
const LOGIN_KEYCHAIN_REL = join("Library", "Keychains", "login.keychain-db");

/** The HOME-relative slot the `.claude` grant occupies — the one W1-T505 narrows. */
const CLAUDE_REL = ".claude";

/**
 * W1-T981: the HOME-relative slot the CLI's OWN config file occupies — the sibling of
 * {@link CLAUDE_REL} that is DELIBERATELY ABSENT from {@link WORKER_HOME_SYMLINKS} and
 * {@link WORKER_HOME_RC_FILES} alike. Disposition (A), "ACCEPT AND DOCUMENT", chosen over
 * seeding (B) or granting it back (C):
 *
 *   - Every per-run redirected HOME (perRunWorkerHomeDir) starts this slot empty, because
 *     nothing in this module writes it and it is not in the allowlist above. The CLI itself
 *     notices, on first use, and creates a fresh `.claude.json` from scratch — the
 *     "Claude configuration file not found at worker-home-<uuid>/.claude.json" notice every
 *     spawn logs IS that creation, not a transiently-lost file and not a race: the slot was
 *     never populated in the first place, on every spawn, by construction. See this task's
 *     filing (feedback#fb-1785775974389-e25033) for the four source citations that refute the
 *     race hypothesis.
 *   - GRANTING it back (option C, symlinking this slot the way {@link CLAUDE_REL} is) is
 *     REJECTED: unlike the credential file `.claude` already narrows toward (W1-T505), a real
 *     operator `.claude.json` carries mutable, per-process state
 *     (`hasAvailableSubscription`, `cachedUsageUtilization`, `modelAccessCache`,
 *     `autoCompactWindowsCache`, `machineID`, `oauthAccount` — FINDINGS.md:263-266) that every
 *     concurrent worker would then read AND WRITE through one shared inode — the same
 *     class of coupling W1-T170 introduced per-run homes to end, in a new slot.
 *   - SEEDING it (option B) is not done here either: nothing measured shows a worker loses
 *     capability running with no `.claude.json` — `resolveActiveAccountId`
 *     (src/lib/worker.ts:657) already defaults to the PARENT's real
 *     `join(homedir(), ".claude.json")`, never the worker's redirected one, so account/identity
 *     resolution is unaffected by this slot being virgin.
 *
 * WHERE THE CLI'S OWN BACKUP OF THE FILE IT REPLACES LANDS: `<claudeGrantTarget>/backups/
 * .claude.json.backup.<epoch>` (see {@link CLAUDE_CONFIG_BACKUP_PREFIX}), where
 * `claudeGrantTarget` is whatever the `.claude` grant currently resolves to — the operator's
 * whole `.claude`, or W1-T505's narrowed sibling once populated. Because that grant is a
 * symlink OUT of the redirected worker home into a directory every concurrent worker shares,
 * the backup write lands there too, not inside the throwaway worker home the per-run reap
 * (`reapWorkerHome`, src/lib/worker.ts:1039) already cleans up. {@link sweepClaudeConfigBackups}
 * is what keeps that shared, otherwise-unbounded write bounded and observable.
 */
export const CLAUDE_CONFIG_REL = ".claude.json";

export function workerHomePlan(opts: {
  workerHome: string;
  realHome: string;
  /**
   * W1-T235 (WS-7 keychain-unlock gate): when set, the redirected HOME's
   * `Library/Keychains/login.keychain-db` slot resolves to this DEDICATED,
   * always-unlocked worker keychain instead of the operator's real login
   * keychain — breaking the single-inode coupling under which a LOCKED login
   * keychain killed every headless spawn "Not logged in" at $0 (fired live
   * 2026-07-21). Unset ⇒ the pre-T235 grant to the real login keychain.
   */
  workerKeychainPath?: string;
  /**
   * W1-T505: injectable existence check, so the `.claude` narrowing below is
   * unit-testable without touching the real filesystem (same discipline as
   * `EnsureWorkerKeychainOpts.exists`). Defaults to the real `existsSync`.
   */
  exists?: (path: string) => boolean;
}): WorkerHomePlan {
  const exists = opts.exists ?? existsSync;
  // W1-T505: the `.claude` grant PREFERS a credential-only sibling the operator owns
  // (`<realHome>/.claude-fleet`) over the operator's whole `.claude`. Falls back to
  // today's wholesale grant when that sibling is absent — design point (ii)/(iv): no
  // host is broken by upgrading before the sibling has been populated.
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
 *  `<prefix><epoch-ms>` under `<claudeGrantTarget>/backups/` (see {@link CLAUDE_CONFIG_REL}'s
 *  doc for the full mechanism). Named here so {@link sweepClaudeConfigBackups} can recognise
 *  and bound them; this module never WRITES one — only observes and reaps what the CLI leaves
 *  behind. */
export const CLAUDE_CONFIG_BACKUP_PREFIX = ".claude.json.backup.";

/** Where the CLI's own `.claude.json` backups land for a given `.claude`-grant target —
 *  `backups/` underneath it, SHARED across every concurrent worker because the grant target
 *  is (today's wholesale operator `.claude`, or W1-T505's narrowed sibling once populated). */
export function claudeConfigBackupDir(claudeGrantTarget: string): string {
  return join(claudeGrantTarget, "backups");
}

/** Default bound for {@link sweepClaudeConfigBackups}: keep the newest 20 backups, reap the
 *  rest. A count cap rather than an age cap (unlike {@link DEFAULT_WORKER_HOME_SWEEP_MAX_AGE_MS})
 *  on purpose — these are written on every spawn, not once per boot, so an age-only bound would
 *  still grow without limit inside a single busy day. */
export const DEFAULT_CLAUDE_CONFIG_BACKUP_MAX_KEEP = 20;

export interface ClaudeConfigBackupSweepSummary {
  removed: string[];
  kept: string[];
}

const claudeConfigBackupFsOps = { readdirSync, rmSync };
type ClaudeConfigBackupFsOps = typeof claudeConfigBackupFsOps;

/**
 * W1-T981 design point (iv): bound and OBSERVE the CLI's `.claude.json` backups instead of
 * letting them accumulate silently in the shared granted `.claude` directory. Keeps the
 * `maxKeep` NEWEST backups (by the epoch embedded in each filename — the CLI's own ordering,
 * cheaper and more precise than an `mtime` stat per file) and reaps the rest. Best-effort and
 * never throws: an absent `backups/` directory (nothing has spawned against this grant target
 * yet) is a silent, correct no-op — the same discipline {@link sweepStaleWorkerHomes} already
 * applies to its own boot sweep, so this adds no new refusal path (design point (v)).
 */
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

/**
 * Materialize a {@link WorkerHomePlan} on disk: guarantee every rc file exists
 * and is EMPTY (truncating a stale one — this directory is Remudero-owned, so
 * a prior run's leftovers are debris, never operator content to preserve), and
 * symlink each real-HOME path back in.
 *
 * BEST-EFFORT per symlink: a source that does not exist on the real HOME
 * (e.g. no `gh` ever configured on this machine) is skipped rather than
 * thrown — isolation must not depend on every optional tool being installed.
 * An existing symlink already pointing at the right target is left alone
 * (idempotent across repeated spawns in the same run); one pointing anywhere
 * else is replaced (self-healing if the real HOME path moved).
 */
export function materializeWorkerHome(opts: {
  workerHome: string;
  realHome: string;
  /** See {@link workerHomePlan} — the W1-T235 dedicated worker keychain. */
  workerKeychainPath?: string;
  /** See {@link workerHomePlan} — injectable for the W1-T505 `.claude` narrowing's tests. */
  exists?: (path: string) => boolean;
}): WorkerHomePlan {
  const plan = workerHomePlan(opts);

  mkdirSync(plan.workerHome, { recursive: true });
  for (const rc of plan.rcFiles) {
    // Zero-byte by construction, every time — never appended to, never trusted
    // to have been left empty by something else.
    writeFileSync(rc, "");
  }

  const outcomes: WorkerHomeGrantOutcome[] = [];
  for (const link of plan.symlinks) {
    const relFrom = relative(plan.workerHome, link.from);
    if (!existsSync(link.to)) {
      // THE OPTIONAL-GRANT SKIP, DELIBERATE AND UNCHANGED. The target genuinely is not on this
      // host (several are legitimately absent on the mini), so there is nothing to grant. This
      // is the one silent path, and it must STAY silent — turning it into an error would break
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
        // A REAL DIRECTORY IN THE SLOT. `unlinkSync` cannot remove one, and the `symlinkSync`
        // below then throws EEXIST — so before this, the directory won PERMANENTLY and silently.
        // MEASURED in the Azure container: `worker-home-usage-probe/.claude` was a directory, the
        // usage probe therefore ran LOGGED OUT, and 33 of 33 probes read `stage: "parse"` against
        // a 207-byte cost summary instead of the account panel. Re-materialisation did not heal it.
        //
        // MOVED ASIDE, NOT DELETED, and the choice is argued rather than assumed:
        //   - RECURSIVE REMOVAL would work and is defensible — a worker home is machine-owned
        //     scratch this function creates, so nothing user-authored lives here. It is rejected
        //     because the directory is written BY THE CLI WE ARE GRANTING TO (it creates `.claude`
        //     when HOME is redirected and the grant is missing), and it is the only evidence of
        //     what poisoned the slot. This defect went undiagnosed precisely because there was no
        //     evidence; deleting it would rebuild that condition.
        //   - REFUSING LOUDLY is rejected: it converts a recoverable, self-healing state into a
        //     hard spawn failure on every host that has one, which is strictly worse than the
        //     silent degradation it replaces.
        // `rename` is atomic and the suffix is unique, so two workers racing the same shared home
        // cannot collide.
        displacedTo = `${link.from}.displaced-${Date.now()}-${randomBytes(3).toString("hex")}`;
        renameSync(link.from, displacedTo);
      } else {
        // Something occupies the slot but points at the WRONG target (a stale
        // symlink from a moved real HOME, or leftover debris) — clear it so the
        // create below can self-heal rather than silently no-op on EEXIST.
        unlinkSync(link.from);
      }
    } catch {
      // does not exist yet (or could not be cleared) — fall through to the create
      // attempt below regardless, which is what reports the real outcome.
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
      // Racing another worker materializing the same shared worker-home, or debris that could
      // not be cleared above — still never fatal to isolation itself (the rc files above are
      // what actually isolate). But it is NO LONGER SILENT: the target exists and we failed to
      // reach it, which is a lost capability, not an optional grant declined.
      outcomes.push({
        relFrom,
        to: link.to,
        state: "failed",
        reason: String((e as Error)?.message ?? e),
        ...(displacedTo ? { displacedTo } : {}),
      });
    }
  }

  // W1-T981 design point (iv): bound the CLI's own `.claude.json` backups at the SAME
  // resolved grant target this call just symlinked `.claude` toward, so the sweep tracks
  // W1-T505's narrowing automatically rather than needing a second update when it lands.
  // `workerHomePlan` (called just above via `plan = workerHomePlan(opts)`) always sets this.
  const claudeConfigBackupSweep = sweepClaudeConfigBackups(plan.claudeGrantTarget!);

  return { ...plan, outcomes, claudeConfigBackupSweep };
}

// ── W1-T170: per-run/per-spawn worker HOMES (the singleton does not survive concurrency) ──
//
// WS-2 names the failure mode by hand: "the singleton <root>/worker-home (W1-T18/
// #100/#102) does NOT survive concurrency; every concurrent worker needs its own
// worker-home-<runId> with its own empty rc + its own login.keychain-db/.claude/
// .config/gh symlinks. A shared home races on rc materialization and the keychain
// grant." Two overlapping spawns truncating/symlinking the SAME rc files and
// keychain slot is exactly the kind of interleaving that turns a deterministic,
// already-fixed bug (#100's HOME-relative keychain miss) into an intermittent one.
// NOT IN SCOPE, and unchanged by this section: WHAT is symlinked — the allowlist
// above, verbatim — only how many homes exist and who owns each.

const workerHomeFsOps = { existsSync, rmSync, readdirSync, statSync, readFileSync };
type WorkerHomeFsOps = typeof workerHomeFsOps;

/**
 * The per-spawn worker HOME: `<workerHomeRoot>-<id>`, a SIBLING of the
 * singleton root (never the root itself, never nested under it — see
 * {@link isReapableWorkerHome}, which enforces exactly that shape on reap).
 * `id` prefers the caller's `runId` when supplied (durable and legible in
 * `ps`/logs — the literal `worker-home-<runId>` WS-2 names), but generation
 * never DEPENDS on one being threaded through: the concurrency invariant —
 * no two overlapping spawns ever share a home — must hold even for a caller
 * that has not (yet) wired a runId through, so an absent/empty one falls
 * back to a fresh `randomUUID()` per call.
 */
export function perRunWorkerHomeDir(workerHomeRoot: string, runId?: string): string {
  const id = runId && runId.length > 0 ? runId : randomUUID();
  return `${workerHomeRoot}-${id}`;
}

/**
 * `true` IFF `target` is exactly `<root>-<nonempty-suffix>` — a per-spawn
 * SIBLING of the singleton root, one segment, no traversal. Guards
 * {@link reapWorkerHome} so a malformed target can never remove the
 * singleton root itself or anything outside its own sibling — the same
 * one-segment-below/beside-root discipline worker-scratch.ts's
 * `isReapableScratchTarget` already applies to the identical class of
 * mistake (a reap that escapes its own resource).
 */
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

/**
 * Best-effort reap of ONE per-spawn worker home. Called at spawn teardown on
 * EVERY exit path, including a thrown error — the same `withTempDir`
 * discipline (W1-T115/W1-T131) rmd already applies to its other throwaway
 * resources, now covering a resource that must not accumulate across
 * concurrent or serial spawns. Guarded by {@link isReapableWorkerHome};
 * existence-checked; never throws.
 */
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

/** Default age ceiling for {@link sweepStaleWorkerHomes}: 24h — matches the
 * other boot sweeps (lib/tmp.ts's `sweepStaleTempDirs`, lib/worker-scratch.ts's
 * `sweepStaleWorkerScratch`). W1-T1064: this is now the BACKSTOP for a candidate whose
 * run id resolves to nothing, not the primary signal — see {@link sweepStaleWorkerHomes}'s
 * doc for the predicate that runs before it. */
export const DEFAULT_WORKER_HOME_SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface WorkerHomeSweepOpts {
  /** Reap a worker-home dir older than this, when its run id resolves to nothing (no
   *  live lock, no terminal ledger verdict). Default 24h. */
  maxAgeMs?: number;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
  fsImpl?: Partial<WorkerHomeFsOps>;
  /**
   * W1-T1064: where `state/inflight/*.lock` files live — checked for a lock naming a
   * candidate's run id BEFORE anything is removed (a live lock keeps the home
   * regardless of age; design bullet 2, plan/tasks.d/W1-T1064). Defaults to
   * `<dirname(root)>/state/inflight`, mirroring config.ts's own documented relationship
   * between `workerHomeDir` (`<config.root>/worker-home`, unless a `workerHomeRoot`
   * override is configured) and `config.root` — every EXISTING caller of
   * {@link sweepStaleWorkerHomes} passes only `root`, so this default is what makes the
   * sharpened predicate apply with no call-site change. A caller running a custom
   * `workerHomeRoot` should pass this explicitly.
   */
  inflightDir?: string;
  /**
   * W1-T1064: the ledger checked for a terminal `verdict` line naming a candidate's run
   * id — the ONLY thing that authorises removing a home before the age ceiling (design
   * bullet 3). Defaults to `<dirname(root)>/state/ledger.ndjson`, the same
   * `workerHomeDir`-relative assumption {@link inflightDir} makes.
   */
  ledgerPath?: string;
  /**
   * W1-T1064: "PRINT BEFORE CLEARING, ALWAYS" (the task design's own words) — called once
   * per removal naming the home, its run id and the evidence that judged it dead, and
   * once more at the end of EVERY pass (including the zero-removed case), so a pass that
   * ran and found nothing stale is no longer indistinguishable from one that never ran.
   * Optional and unwired by any existing caller — every current call site is therefore
   * unaffected by this addition.
   */
  log?: (step: string, fields: Record<string, unknown>) => void;
}

export interface WorkerHomeSweepSummary {
  removed: string[];
  kept: string[];
}

/**
 * W1-T1064: `true` iff `inflightDir` holds a `*.lock` file whose `run_id` names `runId`
 * — a POSITIVE liveness signal that is file-based and survives a restart (design bullet
 * 2), unlike a live-pid check (bullet 1), which the moment right after a restart makes
 * unreliable on its own (pids are reassigned right when workers are being respawned).
 * `sweepStaleInflightLocks` (inflight-lock.ts) reaps stale locks on its own schedule, so
 * this function's ABSENT result must never be read as "the run ended" — only a PRESENT
 * result means anything, which is why {@link sweepStaleWorkerHomes} only ever uses this
 * to KEEP, never to authorise a removal.
 */
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

/**
 * W1-T1064: `true` iff `ledgerPath` holds a `step: "verdict"` line whose `run_id` names
 * `runId` — the POSITIVE statement of death (design bullet 3) that authorises
 * {@link sweepStaleWorkerHomes} to remove a home before the age ceiling. Every
 * `run-task.ts` run's `log` closure stamps this exact `{run_id, step: "verdict"}` shape
 * on every terminal outcome (`log("verdict", ...)`), so this reads the SAME fact the
 * daemon itself already records, never a second notion of "done".
 */
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

/**
 * Boot-time backstop (mirrors worker-scratch.ts's `sweepStaleWorkerScratch`
 * and tmp.ts's `sweepStaleTempDirs`): reap `<root>-<id>` worker-home dirs a
 * crashed/killed process could not reach its own {@link reapWorkerHome} call
 * for — the daemon boot sweep this task's design calls for, so a home
 * orphaned by an ended run does not accumulate across boots. Scans `root`'s
 * PARENT directory for siblings matching `<basename(root)>-`.
 *
 * W1-T1064 — THE PREDICATE, SHARPENED. Age alone let a day's worth of ~24h-old homes
 * (mostly a per-run Playwright browser cache) accumulate until the disk hit 100% and
 * tore a ledger write mid-record. Age is now the BACKSTOP, not the primary signal, for a
 * candidate whose run id (the `<id>` in `<root>-<id>`) resolves to nothing:
 *
 *   1. A LIVE `state/inflight/` lock naming this run id (see
 *      {@link findLiveInflightLockForRun}) keeps the home REGARDLESS OF AGE — file-based,
 *      so unlike a pid check it survives a restart. Its ABSENCE proves nothing (the lock
 *      sweep reaps stale locks on its own) and never authorises a removal by itself.
 *   2. Only once no live lock was found: a TERMINAL `verdict` ledger line naming this run
 *      id (see {@link hasTerminalLedgerVerdict}) is a POSITIVE statement that the run
 *      finished, and removes the home NOW, before the age ceiling.
 *   3. Anything else — no lock, no verdict; an orphan from a `kill -9` or a crash before
 *      any verdict was written — falls back to `maxAgeMs`, exactly the pre-existing
 *      mtime-only behavior.
 *
 * `inflightDir`/`ledgerPath` default off `dirname(root)` (see {@link WorkerHomeSweepOpts}),
 * so every EXISTING caller — `run-task.ts`'s boot rung and `logDiskReclaimRung` both call
 * `sweepStaleWorkerHomes(root)` with no other args — gets the sharpened predicate for
 * free, with no call-site change required.
 *
 * Every removal is named via the optional `log` (home, run id, evidence), and the pass
 * reports once more at the end EVEN WHEN NOTHING WAS REMOVED (design: "say so when
 * nothing was eligible"), so silence never again reads the same as "never ran".
 *
 * Best-effort throughout; never throws.
 */
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
  const ledgerPath = opts.ledgerPath ?? join(parent, "state", "ledger.ndjson");

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

    const runId = name.slice(prefix.length);
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
//
// The login keychain holds the `Claude Code-credentials` OAuth item and locks
// with the operator's session (cold boot, `security lock-keychain`, screen
// policy). Under the pre-T235 symlink the redirected HOME resolved the REAL
// login keychain, so a lock killed every headless spawn "Not logged in" at $0
// before any turn — and, because a credential-dead worker makes zero writes,
// the death rendered as the generic "containment UNPROVEN" misdiagnosis
// (fired live 2026-07-21, two spawns, two days of theory).
//
// This section provisions a DEDICATED keychain holding a COPY of the item,
// configured to never auto-lock and unlocked by the harness itself with a
// password persisted 0600 under the config state dir. The operator's login
// keychain is READ exactly once (at provisioning, while it is unlocked) and
// is NEVER unlocked by the fleet — option (i) of the task's design space,
// chosen for the smallest blast radius. Every failure path out of this rung
// throws a {@link WorkerKeychainError} carrying a named reason CLASS, so a
// credential failure can never again render as a containment finding.

/** The generic-password service name Claude Code stores its OAuth token under. */
export const WORKER_KEYCHAIN_SERVICE = "Claude Code-credentials";

/** Named failure classes for the credential rung — queryable, not prose.
 *
 * The first four are the macOS keychain rung's own (W1-T235). The next two are the
 * NON-DARWIN file store's (recon-cloud-workers-spike, stop 6): a keychain either yields a
 * secret or does not, but a file has more ways to be wrong than that, and collapsing them
 * would put this rung back in the position the whole taxonomy exists to avoid. See
 * {@link classifyWorkerCredentialFile} for which observation earns which class. The last
 * is W1-T2398's: the credential IS usable right now but its recorded expiry cannot
 * outlive the caller's own `expectedRunMs` — a distinct fact from all of the above, none
 * of which speak to run length at all. */
export type WorkerKeychainReasonClass =
  | "login-keychain-locked"
  | "credential-item-missing"
  | "worker-keychain-unlock-failed"
  | "provision-failed"
  | "credential-file-unreadable"
  | "credential-file-malformed"
  | "credential-too-short-for-run";

/**
 * A credential-NAMED failure out of the worker-keychain rung. Thrown BEFORE
 * any worker spawns, so a locked/missing credential fails loudly at the spawn
 * boundary instead of spawning a credential-dead worker whose zero-write death
 * reads as "containment UNPROVEN" (the 2026-07-21 misdiagnosis).
 */
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
  /**
   * The 0600 sidecar recording which account identity (an `EnsureWorkerKeychainOpts.accountId`
   * NAME — never a secret) this store was last provisioned for. `ensureWorkerKeychain` reads it
   * to detect an identity change under the unlabelled default path; a caller that never supplies
   * `accountId` never touches this file, so pre-W1-T265 behavior is unchanged.
   */
  identityPath: string;
  /**
   * W1-T293: the 0600 sidecar recording the copied credential's OWN `claudeAiOauth.expiresAt`
   * (a plain epoch-ms NUMBER — never the secret) as of the last (re-)provision. `ensureWorkerKeychain`
   * reads it to detect the credential going stale WITHOUT re-reading the login keychain or the
   * worker store's own secret on every call — see `EnsureWorkerKeychainOpts.now`'s doc. Written on
   * every (re-)provision regardless of whether `accountId` is supplied (independent of the identity
   * sidecar above); absent when the credential carried no parseable expiry field, in which case the
   * expiry gate reports "unknown" rather than inventing one.
   */
  expiryPath: string;
}

/**
 * Canonical locations under the config state dir (`<config.root>/state`).
 *
 * `accountLabel` is an OPTIONAL, operator-chosen NAME (never a token, never derived from a
 * credential — see billingMode(childEnvKeys)'s NAME-only discipline, env.ts:173) that partitions
 * the store per Anthropic account: `remudero-worker-<label>.keychain-db` /
 * `worker-keychain-password-<label>` instead of the legacy unlabelled pair. Omitted ⇒ the
 * legacy unlabelled paths, byte-for-byte, so an unconfigured install is unaffected. This is
 * independent of `EnsureWorkerKeychainOpts.accountId` (below): a label picks WHICH FILE a store
 * lives at; `accountId` is the value compared to detect the SAME file's identity drifting out
 * from under it. An operator may use either, both, or neither.
 */
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
  /** Apps granted per-item access to the copied credential (`-T`), e.g. the
   * claude binary. Never `-A` (any-app). */
  grantApps?: string[];
  runner?: SecurityRunner;
  exists?: (path: string) => boolean;
  /**
   * W1-T265: the Anthropic account identity active for THIS call — an
   * `accountUuid`/`emailAddress` NAME, never a secret, and NEVER the worker keychain
   * item's own `acct` attribute: account-usage.ts measured that value to be the OS
   * username, identical across an Anthropic account switch, so it cannot discriminate
   * accounts. The caller (worker.ts) resolves it fresh from `~/.claude.json` via
   * account-usage.ts's `readAccountUsageFile` — the same non-keychain source the
   * console's account panel already trusts for this reason.
   *
   * Compared, name-to-name, against `identityPath`'s recorded value: a mismatch (or a
   * store with no recorded identity at all — e.g. one provisioned before this option
   * existed) re-provisions rather than silently reusing a stale copy. Omitted ⇒ the
   * identity check never runs and `identityPath` is never touched — pre-W1-T265
   * behavior (provision once, never re-checked) is unchanged. Appended LAST — no
   * positional caller shifts.
   */
  accountId?: string;
  /**
   * W1-T293 arm (2): injectable clock for the credential-expiry sidecar gate below.
   * Omitted ⇒ `Date.now`. Tests inject a fixed value for deterministic expiry math.
   * Appended LAST — no positional caller shifts.
   */
  now?: () => number;
  /**
   * W1-T293 arm (2): a token AT OR WITHIN this window of its recorded `expiresAt` is
   * treated as already stale, so a spawn never races a token that expires mid-run.
   * Omitted ⇒ `DEFAULT_CREDENTIAL_EXPIRY_SKEW_MS`. Appended LAST — no positional
   * caller shifts.
   */
  credentialExpirySkewMs?: number;
  /**
   * W1-T293 arm (3): set by the caller when the PRIOR spawn died on the containment
   * preflight's expiry-named reason (W1-T292's `spawn_credential_expired`, once that
   * task wires it through) — forces THIS call to re-provision even when arm (2)'s own
   * before-the-fact sidecar read saw nothing wrong (the token expired mid-run, after
   * the last check). `ensureWorkerKeychain` never sets this itself; it is purely a
   * caller-supplied hint. Appended LAST — no positional caller shifts.
   */
  priorSpawnCredentialExpired?: boolean;
  /**
   * W1-T2398: how long (ms) the caller expects THIS run to take — the dispatcher's own
   * estimate (e.g. the task's `budget_usd` translated to a turn/time cap), never derived
   * in here. Omitted ⇒ behavior is BYTE-FOR-BYTE what it was before this option existed:
   * `DEFAULT_CREDENTIAL_EXPIRY_SKEW_MS` (or `credentialExpirySkewMs`) alone is the margin,
   * and this function never refuses on run length.
   *
   * Supplied, it does two things, both scoped to the ALREADY-RUNNING gate below — no new
   * fetch, no re-authentication, no pacing/sleep of any kind:
   *  (1) it WIDENS the effective skew fed to {@link classifyCredentialSidecar} to
   *      `Math.max(credentialExpirySkewMs ?? DEFAULT_CREDENTIAL_EXPIRY_SKEW_MS,
   *      expectedRunMs)`, so a credential that would expire mid-run is classified
   *      `"expired"` and re-provisioned from the login keychain exactly as any other
   *      expiry is — the fixed constant becomes a FLOOR, not the whole margin;
   *  (2) AFTER that (re-)provisioning attempt — or immediately, on the steady-state path
   *      that never needed one — it compares the credential this call is about to hand
   *      out against `expectedRunMs` one last time and THROWS {@link WorkerKeychainError}
   *      (`credential-too-short-for-run`) if even the freshest available copy still can't
   *      outlast the run, refusing the spawn before it starts rather than starting one
   *      doomed to lose auth partway through. A credential that carries no recorded
   *      expiry is never invented one for this comparison — {@link extractCredentialExpiryMs}'s
   *      "never invent a field" contract holds, and the check is simply skipped.
   * Appended LAST — no positional caller shifts.
   */
  expectedRunMs?: number;
}

/** Why THIS call did (or didn't) provision — the switch's audit trail (W1-T265),
 * now also naming a same-account copy that went stale on its own clock (W1-T293). */
export type WorkerKeychainProvisionReason = "absent" | "identity-changed" | "credential-expired" | "skipped";

export interface WorkerKeychainSummary {
  keychainPath: string;
  /** `true` when THIS call created + populated the keychain. */
  provisioned: boolean;
  unlocked: true;
  /**
   * The `accountId` this call compared/stamped, mirrored from the opt of the same
   * name — a NAME, never a credential value. `undefined` when the caller never
   * supplied one (identity checking is opt-in).
   */
  account_label?: string;
  /** `"absent"` (nothing existed) | `"identity-changed"` (mismatch) | `"skipped"` (matched, or no accountId supplied). */
  reason: WorkerKeychainProvisionReason;
  /**
   * W1-T2398: `recordedExpiresAt - now` for the credential THIS call is handing out,
   * measured at the moment of the check below — independent of whether
   * `opts.expectedRunMs` was ever supplied, so the rate this shard's own rationale
   * could not measure from a ledger becomes answerable off-host purely by a caller
   * logging this field. `undefined` exactly when no numeric expiry is known for this
   * credential (no sidecar, or a credential that never carried an `expiresAt`) — never
   * invented.
   */
  observedHeadroomMs?: number;
}

function classifyLoginReadError(err: unknown): WorkerKeychainReasonClass {
  const text = String((err as Error)?.message ?? err);
  if (/interaction is not allowed/i.test(text)) return "login-keychain-locked";
  if (/could not be found/i.test(text)) return "credential-item-missing";
  return "provision-failed";
}

/** Default FLOOR (not the whole margin — see `EnsureWorkerKeychainOpts.expectedRunMs`,
 * W1-T2398) for the arm-2 expiry gate below: a stored token AT OR WITHIN this window of
 * its recorded `expiresAt` is treated as already stale. On its own this constant answers
 * only "is this credential expired NOW", never "will it still be valid when this run
 * ENDS" — a spawn holding six minutes of credential would pass a bare five-minute check
 * and lose it six minutes in. `deriveProvisionGate` widens the effective margin to
 * `Math.max(this, expectedRunMs)` when a caller supplies `expectedRunMs`, so a credential
 * that cannot outlive its own run is caught instead of handed out. */
export const DEFAULT_CREDENTIAL_EXPIRY_SKEW_MS = 5 * 60 * 1000;

/**
 * Pure: pull `claudeAiOauth.expiresAt` (epoch ms) out of the RAW secret the login
 * keychain's `Claude Code-credentials` item carries. VERIFIED FROM SOURCE (a live
 * host's `~/.claude/.credentials.json`, byte-identical shape to what
 * `find-generic-password -w` returns and what `add-generic-password -w` copies
 * verbatim into the worker store): `{"claudeAiOauth":{"accessToken":...,
 * "expiresAt":<epoch-ms>,...}}`. Returns `undefined` for anything that doesn't parse
 * to that shape — callers must never invent a field when this comes back empty;
 * W1-T293's arm (3) (a caller-supplied hint) is the only fallback when a credential
 * genuinely carries no expiry.
 */
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

/** Pure: parse a RECORDED expiry-sidecar value into its epoch-ms number, or
 *  `undefined` for anything that isn't one (absent, empty, non-numeric) — the same
 *  three non-answers {@link classifyCredentialSidecar} folds into `"unknown"`/`"broken"`,
 *  factored out so W1-T2398's headroom read (below) shares the exact parse, never a
 *  second hand-rolled copy of it. */
function parseSidecarExpiryMs(recorded: string | undefined): number | undefined {
  if (recorded === undefined) return undefined;
  const trimmed = recorded.trim();
  if (trimmed === "") return undefined;
  const expiresAt = Number(trimmed);
  return Number.isFinite(expiresAt) ? expiresAt : undefined;
}

/**
 * Pure: classify a RECORDED expiry-sidecar value (never the credential itself — see
 * `WorkerKeychainPaths.expiryPath`'s doc) against a clock + skew. `undefined` (no
 * sidecar file — predates this feature, or the credential carried no expiry field at
 * provisioning time) is `"unknown"`: arm (2) has nothing to say, and only arm (3)'s
 * explicit hint can force a re-provision. A present-but-empty/non-numeric value is
 * `"broken"` — the #29896 wipe shape's signature at the sidecar layer — never read
 * as healthy.
 */
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

// ── recon-cloud-workers-spike stop 6: the NON-DARWIN credential rung ────────────────────────
//
// WHAT THIS CLOSES, stated precisely, because the obvious framing is wrong. A credential-dead
// worker is NOT silent on Linux today: `probeContainment` (containment.ts) is a once-per-run
// preflight on EVERY platform, and it already classifies the death as `spawn_credential_expired`
// or `spawn_credential_failure`. What Linux lacks is the DARWIN rung's timing and its cost —
// `ensureWorkerKeychain` reads the credential BEFORE anything spawns, so a broken one costs a
// file read; without it the same fact is bought with a probe worker, on every dispatch attempt,
// forever, because nothing upstream ever learns.
//
// EXPIRY IS DELIBERATELY NOT A FAILURE HERE, and this is the load-bearing decision. On darwin an
// expired credential TRIGGERS RE-PROVISIONING from the login keychain — it is a repair path, not
// a refusal. On Linux the file IS the source; there is nothing to re-provision from, and the CLI
// maintains its own refresh. Throwing on `expiresAt` in the past would therefore be a bound
// firing on a condition that may be perfectly healthy, which is this repo's most-repeated defect
// (W1-T312, W1-T380, W1-T382). A genuinely dead token is still caught, loudly and by name, by
// the containment probe that already runs. This rung refuses only what is UNAMBIGUOUSLY unusable.

/** Where the non-darwin credential store lives — the path the CLI documents, and the SAME
 *  directory `WORKER_HOME_SYMLINKS` already grants into every per-run worker HOME (measured
 *  at spawn time: the grant materialises and the file is readable from inside the worker). */
export function workerCredentialFilePath(realHome: string): string {
  return join(realHome, ".claude", ".credentials.json");
}

/** {@link classifyWorkerCredentialFile}'s verdict. `usable` carries the expiry when the file
 *  states one — `undefined` means the file simply does not say, which is NOT a failure (see
 *  {@link extractCredentialExpiryMs}'s own "never invent a field" contract). */
export type WorkerCredentialFileVerdict =
  | { kind: "usable"; expiresAtMs?: number }
  | { kind: "unusable"; reasonClass: WorkerKeychainReasonClass; detail: string };

/**
 * PURE (given a reader): classify the non-darwin credential file. Four observations, four
 * answers, none of them collapsed — the same null/empty discipline `readLedgerLines`' `present`
 * and `GitHub.readFailed` already keep elsewhere in this codebase:
 *
 *  - the reader throws ENOENT      → `credential-item-missing`, the SAME class the darwin rung
 *                                    uses for "no credential item", because it is the same fact.
 *  - the reader throws anything else → `credential-file-unreadable` (EACCES, EISDIR, EIO). A
 *                                    permissions problem is not an absence and must not read as one.
 *  - the bytes are not JSON        → `credential-file-malformed`.
 *  - the JSON parses but carries no `claudeAiOauth` object → `credential-file-malformed`, with a
 *                                    detail naming the missing block. THIS IS NOT HYPOTHETICAL: a
 *                                    real `.credentials.json` was observed carrying only an
 *                                    `mcpOAuth` section and no Claude credential at all, which a
 *                                    file-exists check would wave straight through.
 *
 * Anything else is `usable`. Expiry is reported, never refused — see the note above.
 */
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
  // REUSED, never re-derived: the SAME extractor the darwin sidecar path already runs against the
  // keychain secret, which its own doc records as byte-identical in shape to this file.
  return { kind: "usable", expiresAtMs: extractCredentialExpiryMs(raw) };
}

/**
 * The non-darwin analogue of {@link ensureWorkerKeychain}'s refusal half: throw
 * {@link WorkerKeychainError} with a named class BEFORE any worker spawns, so an unusable
 * credential costs a file read rather than a probe worker. Returns the expiry the file states
 * (or `undefined`) so a caller can carry it without re-reading.
 *
 * `read` is injectable for unit tests, but the production default is the real `readFileSync`
 * and the suite drives THAT against real fixture files — a test that only ever supplies its own
 * reader would prove nothing about the path that actually ships.
 */
export function assertWorkerCredentialFile(
  path: string,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
  envToken: string | undefined = process.env.CLAUDE_CODE_OAUTH_TOKEN,
): number | undefined {
  const verdict = classifyWorkerCredentialFile(() => read(path));
  // A TOKEN IS A CREDENTIAL TOO (impl-ED). This guard exists because a credential-dead worker makes
  // zero writes and its $0 death reads as containment UNPROVEN rather than as an auth failure — that
  // reasoning is untouched and the refusal below still fires when NEITHER credential exists. What was
  // wrong was the guard's REACH, not the guard: it tested only for the `/login` file, so it refused
  // every container authenticated the one way a container can be. The CLI's own documented precedence
  // ranks this env var ABOVE the `/login` credential, so a worker holding it is authenticated
  // whatever the file says.
  //
  // EXPIRY IS A KNOWN GAP AND IS DELIBERATELY NOT SOLVED HERE. A bare token carries no
  // `claudeAiOauth.expiresAt`, so {@link extractCredentialExpiryMs} cannot read one and `undefined`
  // is the honest answer rather than a guess. The consequence, stated so it is not rediscovered: the
  // fleet's expiry machinery is BLIND to a token-authenticated worker — it runs for a year and then
  // every dispatch fails at once, with no advance warning from the sidecar classifier or the
  // re-provision path. `apiKeyHelper` is the vendor-documented seam if unattended recovery is ever
  // wanted; building rotation here would be a second concern.
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

// W1-T293 arm (6): NO HOT LOOP. A daemon whose LOGIN token is itself dead must not
// re-read it once per spawn forever — module-level (per-boot: resets only on process
// restart, never persisted to disk) so a permanently dead login token escalates ONCE
// per keychainPath, and every later credential-expired call in the SAME boot fails
// fast on the remembered reason class without touching `security` again. Scoped to
// the credential-expired trigger only: arms (1)/(4)/(5) (absent, identity-changed)
// keep their pre-existing, unbounded behavior byte-for-byte — this never bounds those.
const MAX_CREDENTIAL_RECOVERY_ATTEMPTS = 1;
const credentialRecoveryFailures = new Map<string, { count: number; lastReasonClass: WorkerKeychainReasonClass }>();

// ── W1-T339: serialize ONLY the provisioning branch, not the whole function ────
//
// WHAT IS SAFE ALREADY (unaffected by this section): the password write above is
// atomic (`wx`) and converges losers onto the winner's password; the steady-state
// read path (present, identity-matching, unexpired store) costs one fs read and two
// IDEMPOTENT `security` calls (`unlock-keychain`/`set-keychain-settings`) that never
// touch this lock at all.
//
// WHAT IS NOT SAFE: the provisioning branch DELETES and recreates the keychain store
// (`rmSync` + `create-keychain` + `add-generic-password`). Two concurrent daemon
// lanes that BOTH decide to (re-)provision the SAME store — a cold-boot racing a
// spawn, or two lanes hitting an identity/expiry change together — would otherwise
// have one lane's `rmSync` pull the store out from under the other mid-write, which
// presents as flaky auth rather than as a lock bug.
//
// SAME SHAPE AS `acquireInflightLock`/`acquireDrainLock` (create-or-fail `wx`, no
// TOCTOU gap, stale-holder reclaim via the shared `reclaimStaleLock` identity check —
// W1-T289) with ONE deliberate difference: those two THROW when a live holder is
// found, because "another instance of the same thing is already running" is meant to
// abort the caller. Here a live holder means "a peer is provisioning THIS keychain
// right now" — the correct action is to WAIT for it and converge on its result, never
// throw and never proceed uncoordinated (this task's design point (iv)). So this lock
// polls instead of failing fast on EEXIST-with-a-live-holder.

/** `<keychainPath>.provision.lock` — co-located with the store it guards, so the lock
 *  is scoped per keychain (a labelled per-account store never serializes against an
 *  unrelated one) and is discoverable next to the file it protects. */
export function keychainProvisionLockPath(keychainPath: string): string {
  return `${keychainPath}.provision.lock`;
}

interface KeychainProvisionLockInfo {
  pid: number;
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

/** Blocking synchronous sleep (`ensureWorkerKeychain` is fully synchronous end to
 *  end, so the wait loop below cannot `await`). `Atomics.wait` on a throwaway
 *  `SharedArrayBuffer` is the standard Node idiom for this — no native dependency,
 *  no busy-spin burning CPU between polls. */
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

/**
 * Acquire the exclusive provisioning lock for `keychainPath`, WAITING (never
 * throwing, never letting the caller proceed uncoordinated) while a live peer holds
 * it. A stale lock — its holder's pid no longer alive, or its file unreadable/garbage
 * — is reclaimed via the same identity-safe {@link reclaimStaleLock} every other lock
 * in this repo uses, so a crashed provisioner's abandoned lock cannot wedge every
 * later dispatch (this task's design point (v)): the very next call to reach EEXIST
 * on it takes it over.
 */
function acquireKeychainProvisionLock(
  keychainPath: string,
  opts: { isPidAlive?: (pid: number) => boolean; sleepSyncMs?: (ms: number) => void } = {},
): KeychainProvisionLockHandle {
  const isAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const sleep = opts.sleepSyncMs ?? defaultSleepSyncMs;
  const lockPath = keychainProvisionLockPath(keychainPath);
  const info: KeychainProvisionLockInfo = { pid: process.pid, startedAt: new Date().toISOString() };
  mkdirSync(dirname(lockPath), { recursive: true });

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
        isStale: (held) => !isAlive(held.pid),
      });
      if (result.outcome === "live") {
        // A live peer is provisioning THIS store right now — WAIT and re-check,
        // never throw and never proceed alongside it. Its own release (or, if it
        // crashes, the next pass reclaiming its now-stale lock) is what ends this.
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
  /**
   * W1-T2398: the sidecar's recorded expiry (epoch ms), parsed independently of the
   * skew comparison above — present whenever the store exists, identity hasn't
   * changed, and the sidecar holds a well-formed number, EVEN when the credential is
   * nowhere near stale. `undefined` when there is nothing to read or nothing
   * parseable — never invented. Lets a caller measure headroom on the steady-state
   * path, where nothing else here touches the sidecar at all.
   */
  recordedExpiresAtMs?: number;
}

/**
 * Pure(ish) — reads `identityPath`/`expiryPath` but writes nothing — extraction of
 * the W1-T265 identity gate + W1-T293 expiry gate so it can be evaluated TWICE
 * (W1-T339): once before the provisioning lock (to decide whether this call needs the
 * lock at all — the steady-state majority never does), and again immediately after
 * acquiring it, because a concurrent winner may have already (re-)provisioned while
 * this call was waiting. The second evaluation is what lets a loser CONVERGE on the
 * winner's result instead of redundantly re-provisioning on top of it.
 */
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
    // Read + parse ONCE, unconditionally — W1-T2398's headroom (below) needs the
    // parsed value even on the arm-(3)-forced path, which used to skip this read
    // entirely because it had nothing left to decide with it.
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
      // W1-T2398: DEFAULT_CREDENTIAL_EXPIRY_SKEW_MS (or a caller-supplied override) is
      // a FLOOR, never the whole margin — widened to the caller's own expected run
      // length so a credential that would expire mid-run reads "expired" here exactly
      // like one that is already stale, and takes the same re-provision path below.
      const skewMs = Math.max(opts.credentialExpirySkewMs ?? DEFAULT_CREDENTIAL_EXPIRY_SKEW_MS, opts.expectedRunMs ?? 0);
      const verdict = classifyCredentialSidecar(recorded, { nowMs: (opts.now ?? Date.now)(), skewMs });
      if (verdict === "expired") credentialExpired = true;
      else if (verdict === "broken") credentialSidecarBroken = true; // present-but-empty/unparseable never reads as healthy
    }
  }
  // A broken sidecar means THIS store cannot be trusted — the same remedy as never
  // having provisioned it at all.
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

/**
 * Guarantee the dedicated worker keychain exists, holds the credential item,
 * never auto-locks, and is UNLOCKED — the invariant a headless spawn needs.
 *
 * Provisioning reads the item out of the login keychain, which therefore must
 * be unlocked AT THAT MOMENT (an interactive session, or the explicit operator
 * provisioning step in this task's PR). It runs on the FIRST call ever
 * (`identityPath`/`keychainPath` absent), and — when `opts.accountId` is
 * supplied (W1-T265) — again on any LATER call whose `accountId` no longer
 * matches the value the store was last provisioned for, e.g. the operator
 * logged the fleet user into a second Anthropic subscription. Every other
 * call — including a cold-boot daemon while the login keychain is LOCKED —
 * touches only the worker keychain. Failures throw {@link WorkerKeychainError}
 * with a named class; the password never rides an error message.
 */
export function ensureWorkerKeychain(opts: EnsureWorkerKeychainOpts): WorkerKeychainSummary {
  const runner = opts.runner ?? defaultSecurityRunner;
  const exists = opts.exists ?? existsSync;

  // ATOMIC create-or-read (CodeQL alert #71, js/file-system-race): a check-then-act
  // (existsSync → write) let two concurrent first-provisioners (daemon boot racing a
  // spawn) each generate a DIFFERENT password — last writer wins the file, and the
  // keychain ends up keyed to a password the file no longer holds. `flag: "wx"`
  // (O_CREAT|O_EXCL) makes creation exclusive in ONE syscall, mode 0600 applied at
  // create: the loser gets EEXIST and reads the winner's password instead of
  // inventing a second one. No exists() check — there is nothing to go stale.
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

  // W1-T265 identity gate + W1-T293 expiry gate, both folded into `deriveProvisionGate`
  // (W1-T339) — see its doc for why this is evaluated TWICE. This FIRST evaluation is
  // read-only and lock-free: the overwhelming majority of calls (steady state — a
  // present, identity-matching, unexpired store) find `needsProvisioning: false` right
  // here and never touch the provisioning lock below at all.
  let gate = deriveProvisionGate(opts, storeExists);
  // W1-T2398: the expiry of the credential THIS call will ultimately hand out —
  // starts as whatever the (pre-lock) gate above just read, gets refreshed after a
  // peer-converge re-derive, and gets overwritten with the freshly-copied secret's
  // OWN expiry when this call is the one that actually (re-)provisions below.
  let finalExpiresAtMs = gate.recordedExpiresAtMs;

  // Arm (6): fail fast, without touching the login keychain again, once a
  // credential-expiry recovery has already failed once this boot for this path.
  // Checked before the lock — a cheap in-memory read — so a permanently-dead login
  // token throws immediately instead of queueing behind the provisioning lock first.
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

  // W1-T339: SERIALIZE ONLY THE PROVISIONING BRANCH. A call whose gate above already
  // says "nothing to do" never acquires this lock — the steady-state path stays
  // exactly as lock-free as it was before this task.
  if (gate.needsProvisioning) {
    const lock = acquireKeychainProvisionLock(opts.keychainPath);
    try {
      // RE-DERIVE, now holding the lock: a concurrent winner may have finished
      // (re-)provisioning this exact store while this call was waiting for it. A
      // loser that skipped this re-check would redundantly re-provision on top of
      // what its peer just wrote — the exact hazard this lock exists to prevent.
      gate = deriveProvisionGate(opts, exists(opts.keychainPath));
      finalExpiresAtMs = gate.recordedExpiresAtMs;

      if (gate.needsProvisioning) {
        // A mismatch/staleness verdict means a LIVE keychain file may be sitting at
        // this path already — `create-keychain` refuses to overwrite one, so it
        // must go first. Nothing to remove when the store was simply absent.
        if (exists(opts.keychainPath)) {
          try {
            rmSync(opts.keychainPath, { force: true });
          } catch {
            // best-effort; a real removal failure surfaces below as provision-failed
            // when create-keychain hits the file it couldn't clear.
          }
        }
        // Read the item (attributes, then secret) BEFORE creating anything, so a
        // locked/missing credential leaves no half-provisioned keychain behind. The
        // `acct` attribute is copied over UNCHANGED, exactly as before W1-T265 —
        // account-usage.ts measured it to be the OS username, identical across an
        // Anthropic account switch, so it is preserved here as informational
        // provenance only. It is NEVER used for the identity comparison above,
        // which compares `opts.accountId` against `identityPath`'s own sidecar
        // record instead — a separate, purpose-built value.
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
        // W1-T293: record the freshly-copied secret's OWN expiry (never the secret
        // itself) for the NEXT call's cheap arm-2 read. No parseable
        // `claudeAiOauth.expiresAt` on this credential ⇒ clear any stale sidecar from a
        // PREVIOUS copy rather than misattributing its timestamp to this one — arm (2)
        // then correctly reports "unknown" (arm (3) remains available).
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
        // W1-T2398: this IS the freshest copy this call can produce — the value the
        // headroom check below must reason about, not the (possibly now-stale)
        // pre-provision reading `finalExpiresAtMs` already held.
        finalExpiresAtMs = expiresAtMs;
      }
      // else: a concurrent peer already (re-)provisioned this exact store while this
      // call waited for the lock — CONVERGE on its result rather than redoing the
      // work. `gate` was just re-derived against the now-current store, so the
      // `reason` computed below correctly reports the peer's outcome (typically
      // "skipped": present, identity-matching, unexpired).
    } finally {
      lock.release();
    }
  }

  // W1-T2398: the LAST gate, after any (re-)provisioning attempt above has had its
  // chance to fetch a fresher copy — refuse BEFORE this credential is ever unlocked
  // or handed to a spawn, never after. `finalExpiresAtMs` is `undefined` exactly when
  // no numeric expiry is known at all (no sidecar, or a credential that never carried
  // one) — the comparison is skipped rather than inventing a deadline, same discipline
  // as {@link extractCredentialExpiryMs}'s own contract.
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
    // Re-pin on every call: settings are state, and a drifted auto-lock would
    // resurrect the exact failure this rung exists to remove.
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
