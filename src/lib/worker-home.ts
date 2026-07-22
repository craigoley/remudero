import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
 * The explicit allowlist of real-HOME paths a worker needs back, symlinked
 * individually. Mirrors env.ts's ALLOWLIST discipline: name each grant and its
 * reason, never inherit the rest of HOME wholesale.
 */
export const WORKER_HOME_SYMLINKS: readonly WorkerHomeSymlink[] = [
  { relPath: ".claude", reason: "Claude Code session/config state (OAuth may read under HOME — unverified live, see LEARNINGS.md)" },
  { relPath: ".config/gh", reason: "gh CLI auth token, so a worker can open/merge PRs" },
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
}

/** The HOME-relative slot Claude Code resolves its keychain through. */
const LOGIN_KEYCHAIN_REL = join("Library", "Keychains", "login.keychain-db");

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
}): WorkerHomePlan {
  return {
    workerHome: opts.workerHome,
    rcFiles: WORKER_HOME_RC_FILES.map((f) => join(opts.workerHome, f)),
    symlinks: WORKER_HOME_SYMLINKS.map((s) => ({
      from: join(opts.workerHome, s.relPath),
      to:
        opts.workerKeychainPath && s.relPath === LOGIN_KEYCHAIN_REL
          ? opts.workerKeychainPath
          : join(opts.realHome, s.relPath),
      reason: s.reason,
    })),
  };
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
}): WorkerHomePlan {
  const plan = workerHomePlan(opts);

  mkdirSync(plan.workerHome, { recursive: true });
  for (const rc of plan.rcFiles) {
    // Zero-byte by construction, every time — never appended to, never trusted
    // to have been left empty by something else.
    writeFileSync(rc, "");
  }

  for (const link of plan.symlinks) {
    if (!existsSync(link.to)) continue; // optional grant; nothing to link
    try {
      const st = lstatSync(link.from);
      if (st.isSymbolicLink() && readlinkSync(link.from) === link.to) continue; // already correct
      // Something occupies the slot but points at the WRONG target (a stale
      // symlink from a moved real HOME, or leftover debris) — clear it so the
      // create below can self-heal rather than silently no-op on EEXIST.
      unlinkSync(link.from);
    } catch {
      // does not exist yet (or wasn't removable, e.g. a real directory) — fall
      // through to the create attempt below regardless.
    }
    mkdirSync(dirname(link.from), { recursive: true });
    try {
      symlinkSync(link.to, link.from);
    } catch {
      // Racing another worker materializing the same shared worker-home, or
      // debris that could not be cleared above — best-effort, never fatal to
      // isolation itself (the rc files above are what actually isolate).
    }
  }

  return plan;
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

/** Named failure classes for the credential rung — queryable, not prose. */
export type WorkerKeychainReasonClass =
  | "login-keychain-locked"
  | "credential-item-missing"
  | "worker-keychain-unlock-failed"
  | "provision-failed";

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
}

/** Canonical locations under the config state dir (`<config.root>/state`). */
export function workerKeychainPaths(stateDir: string): WorkerKeychainPaths {
  return {
    keychainPath: join(stateDir, "remudero-worker.keychain-db"),
    passwordPath: join(stateDir, "worker-keychain-password"),
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
}

export interface WorkerKeychainSummary {
  keychainPath: string;
  /** `true` when THIS call created + populated the keychain. */
  provisioned: boolean;
  unlocked: true;
}

function classifyLoginReadError(err: unknown): WorkerKeychainReasonClass {
  const text = String((err as Error)?.message ?? err);
  if (/interaction is not allowed/i.test(text)) return "login-keychain-locked";
  if (/could not be found/i.test(text)) return "credential-item-missing";
  return "provision-failed";
}

/**
 * Guarantee the dedicated worker keychain exists, holds the credential item,
 * never auto-locks, and is UNLOCKED — the invariant a headless spawn needs.
 *
 * Provisioning (first call only) reads the item out of the login keychain,
 * which therefore must be unlocked AT THAT MOMENT (an interactive session, or
 * the explicit operator provisioning step in this task's PR). Every later
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
  if (!exists(opts.keychainPath)) {
    // Read the item (attributes, then secret) BEFORE creating anything, so a
    // locked/missing credential leaves no half-provisioned keychain behind.
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
      throw new WorkerKeychainError(
        "provision-failed",
        `worker-keychain provisioning failed while creating/populating ${opts.keychainPath}: ` +
          String((err as Error)?.message ?? err),
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

  return { keychainPath: opts.keychainPath, provisioned, unlocked: true };
}
