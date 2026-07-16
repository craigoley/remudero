import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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
 * WS-0 FIELD FINDING 11c: the Keychain OAuth token resolves off `USER`, not
 * `HOME` — env.ts already grants USER unconditionally, independent of this
 * redirection. Whether Claude Code ALSO reads state under `~/.claude/` that a
 * redirected HOME would need symlinked is unverified live (no subscription
 * OAuth in CI — Standing rule 18/20); this module symlinks `.claude` back in
 * as a defensive default either way. See LEARNINGS.md for the recorded
 * decision and the fallback if live drilling (W1-T12e) finds it insufficient.
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

export function workerHomePlan(opts: { workerHome: string; realHome: string }): WorkerHomePlan {
  return {
    workerHome: opts.workerHome,
    rcFiles: WORKER_HOME_RC_FILES.map((f) => join(opts.workerHome, f)),
    symlinks: WORKER_HOME_SYMLINKS.map((s) => ({
      from: join(opts.workerHome, s.relPath),
      to: join(opts.realHome, s.relPath),
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
export function materializeWorkerHome(opts: { workerHome: string; realHome: string }): WorkerHomePlan {
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
