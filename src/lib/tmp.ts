/**
 * lib/tmp.ts — rmd's own temp-dir hygiene (W1-T115).
 *
 * LIVE INCIDENT (2026-07-19 ops sweep): 26,711 leaked dirs accumulated under
 * `/tmp/claude-502` — `/System/Volumes/Data` dropped to 526Mi free of 228Gi,
 * ENOSPC-corrupting validation runs and breaking the Bash tool. The
 * self-reinforcing mechanism was every `mkdtempSync(join(tmpdir(), "rmd-…-"))`
 * call site rolling its own cleanup (or, at the `rmd-review-` site, none at
 * all) with no shared discipline and no backstop. This module is the fix:
 *
 *   (i)   ONE prefix ({@link RMD_TMP_PREFIX}) every rmd-owned temp dir uses,
 *         so a sweep can tell "ours" apart from unrelated tmp dirs.
 *   (ii)  ONE creation helper ({@link withTempDir}) that ALWAYS removes what
 *         it creates — success, thrown error, rejected promise, anything —
 *         so no call site can repeat the `rmd-review-` leak (a dir created
 *         and never removed on any path, including the error path).
 *   (iii) A boot-time sweep ({@link sweepStaleTempDirs}) that reaps any
 *         rmd-owned dir old enough that it cannot belong to an invocation
 *         still running — the backstop for whatever (i)/(ii) miss (a crash
 *         mid-invocation, a future call site that forgets the helper).
 *
 * Ledger reads were investigated as part of this task's rationale ("every
 * invocation copies the ledger into a temp dir") and found to already be
 * copy-free: `status.ts`'s `readLedgerLines` reads `ledger.ndjson` directly
 * via `readFileSync`, no temp copy involved. That part of the rationale
 * does not match the code; the regression test below pins the actually-true
 * invariant instead of the described-but-nonexistent one.
 */

// Default-export import (a plain, mutable object), not named bindings — the same
// reason status.ts imports `node:fs` this way (see its import comment): named ESM
// exports off `node:fs` are non-configurable, so `mock.method`/`defineProperty`
// against them throws instead of intercepting. Every call below is a property
// access AT CALL TIME (`fs.mkdtempSync(...)`, never destructured to a local const),
// so an external spy on the real module — e.g. a test proving "a completed
// invocation creates/removes exactly the dirs it should" without this module's
// own fixtures — can actually observe create/remove calls instead of the mock
// setup itself throwing.
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Every temp dir rmd creates is named `rmd-<kind>-<random>` under the OS tmp
 * root — the single shared prefix {@link sweepStaleTempDirs} keys on. */
export const RMD_TMP_PREFIX = "rmd-";

/** Create an rmd-owned temp dir named `rmd-<kind>-<random>`. Callers that need
 * the dir across an async boundary should prefer {@link withTempDir}, which
 * guarantees removal; use this directly only when the caller itself owns
 * a try/finally (e.g. because the dir must outlive a single function call). */
export function makeTempDir(kind: string): string {
  return fs.mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${kind}-`));
}

/**
 * Create an rmd-owned temp dir, run `fn` with its path, and ALWAYS remove it
 * afterward — the dir never survives past this call, on any path (return,
 * throw, or a rejected promise from an async `fn`). This is the fix for the
 * `rmd-review-` leak (a reviewer worker's throwaway cwd, created on every PR
 * review and never removed): callers should route ALL new rmd-owned temp
 * dirs through this helper rather than pairing `mkdtempSync` with a
 * hand-rolled `finally` at each call site.
 */
export async function withTempDir<T>(kind: string, fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = makeTempDir(kind);
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** What a boot sweep did, by dir name (not full path — the root is implicit). */
export interface TempSweepSummary {
  removed: string[];
  kept: string[];
}

export interface TempSweepOpts {
  /** Age ceiling (ms) — an rmd-owned dir older than this is reaped. Default 24h:
   * generous relative to any single rmd invocation (`withTempDir`-scoped dirs
   * live for one function call), so nothing still legitimately in flight is
   * ever mid-sweep collateral. */
  maxAgeMs?: number;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
  /** Root to scan (tests). Defaults to `os.tmpdir()`. */
  root?: string;
}

/** Default age ceiling for {@link sweepStaleTempDirs}: 24 hours. */
export const DEFAULT_TEMP_SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Boot-time reap of stale rmd-owned temp dirs (design point (iii)) — the
 * structural backstop for the 26,711-dir ENOSPC incident. Only touches
 * entries directly under `root` whose name starts with {@link RMD_TMP_PREFIX}
 * AND whose mtime is older than `maxAgeMs`; everything else (unrelated tmp
 * dirs, or an rmd-owned dir a concurrent invocation is still using) is left
 * alone. No liveness/pid check is needed the way `worker.ts`'s
 * `pruneStaleRuns` needs one for worktrees: rmd-owned temp dirs are never
 * meant to be long-lived (they exist for the span of one `withTempDir` call),
 * so age alone — with a ceiling generous relative to that span — is
 * sufficient to distinguish debris from anything genuinely in flight.
 * Best-effort throughout: an unreadable root, a vanished entry (another
 * process's own cleanup beat this sweep to it), or a permission error on one
 * entry never throws or blocks the rest of the sweep.
 */
export function sweepStaleTempDirs(opts: TempSweepOpts = {}): TempSweepSummary {
  const root = opts.root ?? tmpdir();
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_TEMP_SWEEP_MAX_AGE_MS;
  const now = opts.now ?? (() => Date.now());
  const removed: string[] = [];
  const kept: string[] = [];

  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return { removed, kept }; // unreadable tmp root — best-effort, never throws
  }

  for (const name of entries) {
    if (!name.startsWith(RMD_TMP_PREFIX)) continue;
    const full = join(root, name);
    let mtimeMs: number;
    let isDir: boolean;
    try {
      const st = fs.statSync(full);
      isDir = st.isDirectory();
      mtimeMs = st.mtimeMs;
    } catch {
      continue; // vanished between readdir and stat — someone else's cleanup won the race
    }
    if (!isDir) continue; // never touch a file, only rmd's own mkdtempSync dirs
    if (now() - mtimeMs <= maxAgeMs) {
      kept.push(name);
      continue;
    }
    try {
      fs.rmSync(full, { recursive: true, force: true });
      removed.push(name);
    } catch {
      kept.push(name); // a permissions hiccup on one entry never blocks boot
    }
  }
  return { removed, kept };
}
