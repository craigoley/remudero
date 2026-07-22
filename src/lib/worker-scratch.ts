/**
 * lib/worker-scratch.ts — reap the Claude Agent CLI's per-worker scratchpad.
 *
 * THE LEAK. The CLI the Agent SDK spawns (`claude.exe`) creates a per-session
 * scratchpad at a FIXED per-uid root — `<tmpdir>/claude-<uid>/<sanitized-cwd>/…`
 * — and does NOT remove it on a non-graceful exit (max_turns kill, headroom idle,
 * kill-9 + launchd restart). rmd spawns >=4 workers per task (build, review,
 * containment probe, isolation probe), each with a UNIQUE cwd, so each mints a new
 * scratchpad tree and `/private/tmp/claude-<uid>/` grew unbounded (~17G/hour,
 * filling a 228G disk to 100%). rmd removes only the git worktree
 * ({@link worktreeRemove}), never the matching scratchpad, and lib/tmp.ts's sweep
 * is blind to it on two axes: wrong root (it scans os.tmpdir() = /var/folders/…,
 * never /private/tmp/claude-<uid>/) and wrong prefix (it keys on `rmd-`, but these
 * dirs are named `-<sanitized-cwd>`).
 *
 * STEP 0 — algorithm VERIFIED against the SDK + CLI, not assumed from the recon:
 *   ROOT  (OBSERVED, @anthropic-ai/claude-agent-sdk/extractFromBunfs.js:26-52):
 *         `tmpdir()/claude-${getuid()}`, where the SDK's tmpdir() is
 *         `process.env.CLAUDE_CODE_TMPDIR || (darwin ? "/tmp" : os.tmpdir())`.
 *         On macOS "/tmp" resolves through a symlink to "/private/tmp".
 *   UID   (OBSERVED, extractFromBunfs.js:52,58): `process.getuid()`.
 *   SLUG  (OBSERVED, claude.exe): the CLI's own docs name it `<sanitized-cwd>`
 *         (durable twin: `~/.claude/projects/<sanitized-cwd>/`). The transform is a
 *         `String.replace(/[^A-Za-z0-9…]/g, "-")` family — several variants are
 *         embedded in the bun-compiled binary and the exact one could not be
 *         isolated — and the cwd is REALPATH'd FIRST (proven by the observed
 *         `-private-var-folders-…` slug for a `/var/folders/…` cwd). For every rmd
 *         worker cwd (chars ⊆ [A-Za-z0-9/-]) all variants converge to
 *         `realpath(cwd)` with each "/" → "-", which is what {@link scratchSlugForCwd}
 *         computes.
 *
 * SAFETY. Because the exact regex is not isolable in the compiled binary, the reap
 * NEVER blindly deletes a constructed path. It (i) GUARDS that the target resolves
 * to exactly ONE segment strictly below the claude-<uid> root, so it is
 * structurally incapable of escaping that root, and (ii) only removes an entry that
 * ACTUALLY EXISTS — a mis-derived slug matches nothing and no-ops. A missed orphan
 * (e.g. a future cwd containing "." where a variant would differ) is caught by the
 * STEP 2 boot sweep on age. Every function here is best-effort and never throws:
 * teardown must not fail because a scratch dir could not be reaped.
 */
import fs from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve, sep } from "node:path";

export interface ScratchOpts {
  /** Env to read CLAUDE_CODE_TMPDIR from (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** Platform (default process.platform) — selects the darwin "/tmp" base. */
  platform?: NodeJS.Platform;
  /** uid override (default process.getuid()). */
  uid?: number;
  /** Injectable fs (tests). Defaults to node:fs. */
  fsImpl?: Pick<typeof fs, "realpathSync" | "existsSync" | "rmSync" | "readdirSync" | "statSync">;
}

/**
 * The `claude-<uid>` scratch root the CLI writes under, canonicalized (realpath) so
 * the macOS `/tmp`→`/private/tmp` symlink matches realpath'd child targets. Returns
 * `null` on a non-POSIX host (no `getuid` — the CLI uses `claude`, out of scope).
 */
export function claudeScratchRoot(opts: ScratchOpts = {}): string | null {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const uid = opts.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  if (uid === undefined) return null;
  const f = opts.fsImpl ?? fs;
  const base = env.CLAUDE_CODE_TMPDIR || (platform === "darwin" ? "/tmp" : tmpdir());
  const root = resolve(base, `claude-${uid}`);
  try {
    return f.realpathSync(root);
  } catch {
    return root; // not created yet — the un-resolved form is fine for a nothing-to-reap path
  }
}

/**
 * The CLI's `<sanitized-cwd>` slug for a worker cwd: `realpath(cwd)` with every
 * non-`[A-Za-z0-9_-]` char (in practice, every "/") replaced by "-". realpath-first
 * so `/var/folders/…` and `/tmp/…` cwds resolve to their `/private/…` form exactly
 * as the CLI records them.
 */
export function scratchSlugForCwd(cwd: string, opts: ScratchOpts = {}): string {
  const f = opts.fsImpl ?? fs;
  let real = cwd;
  try {
    real = f.realpathSync(cwd);
  } catch {
    /* cwd already torn down — derive from the string as given (best-effort) */
  }
  return real.replace(/[^A-Za-z0-9_-]/g, "-");
}

/**
 * The GUARD, exported so a fixture can falsify it in isolation. `true` IFF `target`
 * is exactly one segment strictly below `root` — no traversal, no root itself, no
 * grandchild. A force-delete is only ever attempted on a target that passes this.
 */
export function isReapableScratchTarget(root: string, target: string): boolean {
  const rootResolved = resolve(root);
  const t = resolve(target);
  const rel = relative(rootResolved, t);
  if (!rel) return false; // target === root
  if (rel === ".." || rel.startsWith(".." + sep)) return false; // outside root
  if (rel.includes(sep)) return false; // deeper than a direct child
  return true;
}

export interface ReapResult {
  reaped: boolean;
  target?: string;
  reason?: string;
}

/**
 * Best-effort reap of ONE worker's scratchpad, keyed by its cwd. Called in the
 * orchestrator at that worker's teardown — the orchestrator survives a killed
 * worker, so this reaps the non-graceful orphans that are the actual leak. Guarded
 * + existence-checked; never throws.
 */
export function reapWorkerScratch(cwd: string, opts: ScratchOpts = {}): ReapResult {
  try {
    const f = opts.fsImpl ?? fs;
    const root = claudeScratchRoot(opts);
    if (!root) return { reaped: false, reason: "no-posix-uid" };
    const slug = scratchSlugForCwd(cwd, opts);
    if (!slug || /^-*$/.test(slug)) return { reaped: false, reason: "empty-slug" };
    const target = resolve(root, slug);
    if (!isReapableScratchTarget(root, target)) return { reaped: false, target, reason: "guard-outside-root" };
    if (!f.existsSync(target)) return { reaped: false, target, reason: "absent" };
    f.rmSync(target, { recursive: true, force: true });
    return { reaped: true, target };
  } catch (e) {
    return { reaped: false, reason: String((e as Error)?.message ?? e) };
  }
}

/** Default age ceiling for {@link sweepStaleWorkerScratch}: 24h — matches lib/tmp.ts. */
export const DEFAULT_SCRATCH_SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface ScratchSweepOpts extends ScratchOpts {
  /** Reap a scratchpad dir older than this. Default 24h (generous vs any session). */
  maxAgeMs?: number;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
}

export interface ScratchSweepSummary {
  removed: string[];
  kept: string[];
}

/**
 * STEP 2 backstop — boot sweep of the `claude-<uid>` root. Reaps scratchpad dirs
 * older than `maxAgeMs`, the orphans a CRASHED ORCHESTRATOR could not reap at
 * teardown (STEP 1 covers the common killed-worker case immediately). Same 24h
 * generosity as lib/tmp.ts's sweep, so a long-running LIVE session (recent mtime)
 * is never collateral. Same one-segment-below-root guard as the per-task reap. Best
 * effort throughout: an unreadable root or a per-entry error never throws.
 */
export function sweepStaleWorkerScratch(opts: ScratchSweepOpts = {}): ScratchSweepSummary {
  const f = opts.fsImpl ?? fs;
  const now = opts.now ?? (() => Date.now());
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_SCRATCH_SWEEP_MAX_AGE_MS;
  const removed: string[] = [];
  const kept: string[] = [];
  const root = claudeScratchRoot(opts);
  if (!root) return { removed, kept };

  let entries: string[];
  try {
    entries = f.readdirSync(root);
  } catch {
    return { removed, kept }; // root not created yet / unreadable — best-effort
  }

  for (const name of entries) {
    const full = resolve(root, name);
    if (!isReapableScratchTarget(root, full)) {
      kept.push(name);
      continue;
    }
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
      kept.push(name); // recent mtime ⇒ a live session may still own it
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
