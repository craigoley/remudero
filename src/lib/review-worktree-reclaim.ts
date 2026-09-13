/**
 * src/lib/review-worktree-reclaim.ts — reclaims `review-PR*` worktrees a SIGKILL stranded
 * (W1-T3378).
 *
 * THE DEFECT. `materializeReviewWorktree`'s failure-path cleanup and `withMaterializedWorktree`'s
 * success-path teardown (src/run-task.ts, W1-T233) are both in-process `finally`/`catch` blocks —
 * neither runs when the process is SIGKILLed, and this fleet is hard-killed routinely (launchd
 * KeepAlive restarts, `launchctl kickstart -k`, an operator `pkill`, an OOM). A worktree stranded
 * that way is never revisited by anything: `git worktree prune` only removes a registration whose
 * DIRECTORY is gone, and these directories are very much present.
 *
 * THE FIX IS A LATER, OUT-OF-PROCESS SWEEP, not a better `finally`. {@link
 * sweepStrandedReviewWorktrees} runs once per daemon tick and reclaims any `review-PR*` directory
 * under `worktreesDir(config)` that (a) has aged past a grace window generous enough to protect a
 * genuinely slow live review, AND (b) holds no commit absent from its own remote. Age alone is
 * never sufficient (it cannot tell a stranded worktree from a slow live one) and neither is size —
 * both are refused by design; the unpushed-commit check is the one proof that actually answers
 * "would reclaiming this destroy shipped-nowhere work". An unreadable remote is never a yes.
 *
 * SCOPE IS EXACTLY `review-PR*`. The name pattern is the only filter: `coverage/`, `rmd-*` temp
 * dirs and any hand-cut lane never match it and are never even considered, let alone touched.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { systemClock, type Clock } from "./clock.js";
import type { Config } from "./config.js";
import { DEFAULT_WORKTREE_REAP_GRACE_MS, worktreesDir, worktreeRemove } from "./worker.js";

/** Exactly what `materializeReviewWorktree` mints (src/run-task.ts): `review-PR<n>-<epochMs>`.
 *  Anchored full-match, captured groups for the PR number and the creation instant — the sweep
 *  derives BOTH from the name alone, never from a walk of the tree's own mtimes, because a review
 *  worktree is a read-only checkout that nothing legitimately touches after creation. */
const REVIEW_WORKTREE_NAME = /^review-PR(\d+)-(\d+)$/;

/** Reused rather than a second policy constant: the same "a linked worktree might still be doing
 *  something" grace window {@link DEFAULT_WORKTREE_REAP_GRACE_MS} already protects the general
 *  worktree reaper with (plan/policy.yaml's `worktreeReapGraceMs`, 30 minutes) — comfortably above
 *  how long `rmd review`'s fetch + checkout + whitelisted-proof run ever takes. Exported so a test
 *  can assert the boundary without hand-duplicating the number. */
export const DEFAULT_REVIEW_WORKTREE_SWEEP_GRACE_MS = DEFAULT_WORKTREE_REAP_GRACE_MS;

/** WHY a candidate was reclaimed or kept — ledgered on every candidate, so a sweep that finds
 *  nothing eligible is distinguishable from one that ran and saw nothing at all (W1-T3378). */
export type ReviewWorktreeSweepReason =
  | "reclaimed"
  /** Younger than the grace window — may be a live review still running; never the sole guard. */
  | "too-young"
  /** HEAD carries a commit this sweep could not find on `origin` — refused, never assumed shipped. */
  | "unpushed-commits"
  /** The remote could not be read at all (network, auth, a vanished ref) — an unanswerable
   *  question is never a yes. */
  | "remote-unreadable"
  /** The candidate's own `.git` pointer, or its HEAD, could not be read or parsed. */
  | "git-unreadable"
  /** Every gate passed but the removal itself failed — best-effort, the pass continues. */
  | "removal-failed";

export interface ReviewWorktreeSweepOutcome {
  name: string;
  path: string;
  reason: ReviewWorktreeSweepReason;
}

export interface ReviewWorktreeSweepSummary {
  reclaimed: string[];
  kept: ReviewWorktreeSweepOutcome[];
}

export interface ReviewWorktreeSweepOptions {
  /** Directory names directly under `worktreesDir(config)`. Defaults to a real `readdirSync`. */
  listEntries?: (dir: string) => string[];
  isDirectory?: (path: string) => boolean;
  /** Shared clock port. Tests drive "later" without a real 30-minute wait; production uses the
   *  same system implementation every other time-aware module does. */
  clock?: Clock;
  /** Overrides {@link DEFAULT_REVIEW_WORKTREE_SWEEP_GRACE_MS}. */
  graceMs?: number;
  /** The candidate's OWN parent repoDir, resolved from its `.git` gitdir pointer (mirrors
   *  worker.ts's private `resolveWorktreeRepoDir` — duplicated here rather than exported, since
   *  this task's own scope is this module plus daemon.ts). `undefined` = unreadable/unparseable. */
  resolveRepoDir?: (worktreePath: string) => string | undefined;
  /** The worktree's own current HEAD sha. `undefined` = unreadable. */
  readHeadSha?: (worktreePath: string) => string | undefined;
  /** The PR's head sha as `origin` reports it RIGHT NOW (`refs/pull/<n>/head`), read fresh, never
   *  cached — a PR that has since advanced is honoured, not assumed stale. `undefined` means the
   *  remote could not be read at all: network failure, auth failure, or the ref is gone. */
  readRemoteHeadSha?: (repoDir: string, prNumber: number) => string | undefined;
  removeWorktree?: (repoDir: string, worktreePath: string) => void;
}

/**
 * Reclaim `review-PR*` worktrees under `worktreesDir(config)` that this process did not create and
 * no `finally` is pending for. Called once per daemon tick (src/lib/daemon.ts); see this module's
 * header for the full defect and design.
 */
export function sweepStrandedReviewWorktrees(
  config: Config,
  log: (step: string, extra?: Record<string, unknown>) => void,
  opts: ReviewWorktreeSweepOptions = {},
): ReviewWorktreeSweepSummary {
  const root = worktreesDir(config);
  const listEntries = opts.listEntries ?? ((dir: string) => readdirSync(dir));
  const isDirectory =
    opts.isDirectory ??
    ((p: string) => {
      try {
        return statSync(p).isDirectory();
      } catch (e) {
        // Bind + carry, never a bare erasure: a vanished-mid-loop entry and a genuinely unreadable
        // one both read `false` to the caller, but the reason still reaches the console.
        console.error(`review-worktree-reclaim: could not stat ${p} (${String((e as Error)?.message ?? e)})`);
        return false;
      }
    });
  const clock = opts.clock ?? systemClock;
  const graceMs = opts.graceMs ?? DEFAULT_REVIEW_WORKTREE_SWEEP_GRACE_MS;
  const resolveRepoDir = opts.resolveRepoDir ?? defaultResolveRepoDir;
  const readHeadSha = opts.readHeadSha ?? defaultReadHeadSha;
  const readRemoteHeadSha = opts.readRemoteHeadSha ?? defaultReadRemoteHeadSha;
  const removeWorktree = opts.removeWorktree ?? worktreeRemove;

  const reclaimed: string[] = [];
  const kept: ReviewWorktreeSweepOutcome[] = [];
  const keep = (name: string, path: string, reason: ReviewWorktreeSweepReason, extra: Record<string, unknown> = {}): void => {
    kept.push({ name, path, reason });
    log("review_worktree.sweep.kept", { name, reason, ...extra });
  };

  let names: string[];
  try {
    names = listEntries(root);
  } catch {
    return { reclaimed, kept }; // unreadable root — best-effort, matches reapStaleWorktrees
  }

  for (const name of names) {
    const m = REVIEW_WORKTREE_NAME.exec(name);
    if (!m) continue; // closed to review worktrees BY CONSTRUCTION — coverage/, rmd-*, anything else is never a candidate
    const prNumber = Number(m[1]);
    const createdAtMs = Number(m[2]);
    const path = join(root, name);
    if (!isDirectory(path)) continue;

    if (clock.now() - createdAtMs < graceMs) {
      keep(name, path, "too-young");
      continue;
    }

    const repoDir = resolveRepoDir(path);
    if (!repoDir) {
      keep(name, path, "git-unreadable");
      continue;
    }
    const localHead = readHeadSha(path);
    if (!localHead) {
      keep(name, path, "git-unreadable");
      continue;
    }
    const remoteHead = readRemoteHeadSha(repoDir, prNumber);
    if (remoteHead === undefined) {
      keep(name, path, "remote-unreadable");
      continue;
    }
    if (remoteHead !== localHead) {
      keep(name, path, "unpushed-commits");
      continue;
    }

    try {
      removeWorktree(repoDir, path);
      reclaimed.push(name);
      log("review_worktree.sweep.reclaimed", { name });
    } catch (e) {
      keep(name, path, "removal-failed", { error: String((e as Error)?.message ?? e) });
    }
  }

  return { reclaimed, kept };
}

/** Resolve a linked worktree's parent repoDir from its OWN `.git` gitdir pointer — the same
 *  technique worker.ts's `resolveWorktreeRepoDir` uses, never a fixed/assumed path (the
 *  multi-checkout lesson: these worktrees register against the OPERATOR checkout, not necessarily
 *  `repos/<repo>`). */
function defaultResolveRepoDir(worktreePath: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(worktreePath, ".git"), "utf8");
  } catch (e) {
    console.error(
      `review-worktree-reclaim: could not read ${join(worktreePath, ".git")} (${String((e as Error)?.message ?? e)})`,
    );
    return undefined;
  }
  const m = raw.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!m) return undefined;
  const marker = `${sep}.git${sep}worktrees${sep}`;
  const idx = m[1].indexOf(marker);
  return idx === -1 ? undefined : m[1].slice(0, idx);
}

function defaultReadHeadSha(worktreePath: string): string | undefined {
  try {
    return execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (e) {
    console.error(`review-worktree-reclaim: could not read HEAD at ${worktreePath} (${String((e as Error)?.message ?? e)})`);
    return undefined;
  }
}

/** `git ls-remote` — a read-only, no-object-transfer question to `origin` about the PR's CURRENT
 *  head, matching the exact ref `materializeReviewWorktree` fetched from (`refs/pull/<n>/head`).
 *  Any failure (network, auth, the ref gone) or an empty answer is `undefined`, never a guess. */
function defaultReadRemoteHeadSha(repoDir: string, prNumber: number): string | undefined {
  let out: string;
  try {
    out = execFileSync("git", ["-C", repoDir, "ls-remote", "origin", `refs/pull/${prNumber}/head`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    console.error(
      `review-worktree-reclaim: could not ls-remote origin refs/pull/${prNumber}/head in ${repoDir} ` +
        `(${String((e as Error)?.message ?? e)})`,
    );
    return undefined;
  }
  const sha = out.split(/\s+/)[0]?.trim();
  return sha ? sha : undefined;
}
