import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

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

const workerHomeFsOps = { existsSync, rmSync, readdirSync, statSync };
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
 * `sweepStaleWorkerScratch`). */
export const DEFAULT_WORKER_HOME_SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface WorkerHomeSweepOpts {
  /** Reap a worker-home dir older than this. Default 24h. */
  maxAgeMs?: number;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
  fsImpl?: Partial<WorkerHomeFsOps>;
}

export interface WorkerHomeSweepSummary {
  removed: string[];
  kept: string[];
}

/**
 * Boot-time backstop (mirrors worker-scratch.ts's `sweepStaleWorkerScratch`
 * and tmp.ts's `sweepStaleTempDirs`): reap `<root>-<id>` worker-home dirs a
 * crashed/killed process could not reach its own {@link reapWorkerHome} call
 * for — the daemon boot sweep this task's design calls for, so a home
 * orphaned by an ended run does not accumulate across boots. Scans `root`'s
 * PARENT directory for siblings matching `<basename(root)>-`, reaping only
 * ones older than `maxAgeMs`: `materializeWorkerHome` touches a home's mtime
 * on every use, so a home belonging to a still-running spawn is always
 * recent and never collateral. Best-effort throughout; never throws.
 */
export function sweepStaleWorkerHomes(root: string, opts: WorkerHomeSweepOpts = {}): WorkerHomeSweepSummary {
  const f = { ...workerHomeFsOps, ...opts.fsImpl };
  const now = opts.now ?? (() => Date.now());
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_WORKER_HOME_SWEEP_MAX_AGE_MS;
  const removed: string[] = [];
  const kept: string[] = [];
  const parent = dirname(root);
  const prefix = `${basename(root)}-`;

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
    if (now() - mtimeMs <= maxAgeMs) {
      kept.push(name); // recent mtime ⇒ a live spawn may still own it
      continue;
    }
    try {
      f.rmSync(full, { recursive: true, force: true });
      removed.push(name);
    } catch {
      kept.push(name); // a permissions hiccup on one entry never blocks the rest
    }
  }
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
}

function classifyLoginReadError(err: unknown): WorkerKeychainReasonClass {
  const text = String((err as Error)?.message ?? err);
  if (/interaction is not allowed/i.test(text)) return "login-keychain-locked";
  if (/could not be found/i.test(text)) return "credential-item-missing";
  return "provision-failed";
}

/** Default skew for the arm-2 expiry gate below: a stored token AT OR WITHIN this
 * window of its recorded `expiresAt` is treated as already stale, so a spawn never
 * races a token that expires mid-run. */
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
  const trimmed = recorded.trim();
  if (trimmed === "") return "broken";
  const expiresAt = Number(trimmed);
  if (!Number.isFinite(expiresAt)) return "broken";
  return opts.nowMs + opts.skewMs >= expiresAt ? "expired" : "fresh";
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

  // W1-T265 IDENTITY-AWARE GATE. Opt-in: only runs when the caller supplies
  // `accountId`, so a caller that never does (every pre-W1-T265 call site) sees
  // byte-for-byte the old `!exists` gate. A store with NO recorded identity —
  // absent `identityPath`, e.g. one provisioned before this option existed —
  // counts as a mismatch: the safer failure here is an extra re-provision, never
  // a silent skip that keeps spending whichever account happened to provision
  // first (this task's whole rationale).
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

  // W1-T293 arms (2)+(3): EXPIRY-AWARE, at the seam W1-T265 already built. Only
  // worth asking when identity alone hasn't already decided to re-provision. Arm
  // (2) reads ONLY the small `expiryPath` sidecar (a NAME-like numeric timestamp
  // recorded at provisioning time — never the credential secret itself, and never
  // a `security` call), so the steady-state (fresh, matching) spawn path costs one
  // fs read: no credential read, no extra unlock. Arm (3) is the caller's hint that
  // the PRIOR spawn died on the expiry-named preflight reason — forces a
  // re-provision even when arm (2) alone saw nothing wrong (a token that expired
  // mid-run, after the last check).
  let credentialExpired = false;
  let credentialSidecarBroken = false;
  if (storeExists && !identityChanged) {
    if (opts.priorSpawnCredentialExpired) {
      credentialExpired = true;
    } else {
      let recorded: string | undefined;
      try {
        recorded = readFileSync(opts.expiryPath, "utf8");
      } catch {
        recorded = undefined; // no sidecar — predates this feature, or the credential carried no expiry field
      }
      const verdict = classifyCredentialSidecar(recorded, {
        nowMs: (opts.now ?? Date.now)(),
        skewMs: opts.credentialExpirySkewMs ?? DEFAULT_CREDENTIAL_EXPIRY_SKEW_MS,
      });
      if (verdict === "expired") credentialExpired = true;
      else if (verdict === "broken") credentialSidecarBroken = true; // present-but-empty/unparseable never reads as healthy
    }
  }
  // A broken sidecar means THIS store cannot be trusted — the same remedy as never
  // having provisioned it at all.
  const treatAsAbsent = !storeExists || credentialSidecarBroken;

  // Arm (6): fail fast, without touching the login keychain again, once a
  // credential-expiry recovery has already failed once this boot for this path.
  if (credentialExpired) {
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

  if (treatAsAbsent || identityChanged || credentialExpired) {
    // A mismatch/staleness verdict means a LIVE keychain file may be sitting at
    // this path already — `create-keychain` refuses to overwrite one, so it must
    // go first. Nothing to remove when the store was simply absent.
    if (storeExists) {
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
      if (credentialExpired) {
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
      if (credentialExpired) {
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
    if (credentialExpired) credentialRecoveryFailures.delete(opts.keychainPath); // a successful recovery clears the boot-scoped cap
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
    reason: treatAsAbsent
      ? "absent"
      : identityChanged
        ? "identity-changed"
        : credentialExpired
          ? "credential-expired"
          : "skipped",
  };
}
