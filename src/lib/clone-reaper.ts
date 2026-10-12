/**
 * lib/clone-reaper.ts — reap the fleet's abandoned REVIEW CLONES from the scratch roots.
 *
 * THE LEAK, MEASURED (impl-EK, 2026-08-01). Reviewing a PR materialises a full standalone
 * clone of this repo into a scratch root and runs a real install in it. The clone is never
 * removed: 36 of them survive across `/private/tmp`, `/private/tmp/claude-<uid>` and
 * `os.tmpdir()`, totalling 5866 MiB — the single largest reclaimable consumer on this host,
 * on which macOS's own periodic tmp cleaner does not exist (`/etc/periodic/daily/` is absent),
 * so nothing has ever removed one. Each carries a REAL `node_modules` of ~463 MiB.
 *
 * WHY A CONTENT PREDICATE AND NOT A NAME GLOB. The observed names have no shared shape:
 * `review-w1t281`, `review933`, `review-933-repo`, `w1t176-review-23726`, `rv933b`, and bare
 * `tmp.J6RUGLgRaQ` from a shell `mktemp -d`. A glob wide enough to catch `tmp.*` would also
 * match every OTHER program's mktemp dir in a SHARED root that holds another application's
 * caches and other Claude sessions' scratchpads. So ownership is decided by CONTENT:
 * {@link isFleetReviewClone} requires a git clone of THIS repo. That predicate caught all 36,
 * including the `tmp.*` ones no glob would find, and matched nothing else in either root.
 *
 * WHY `.git` MUST BE A DIRECTORY. A `.git` FILE marks a LINKED WORKTREE whose object store and
 * admin dir live in the PARENT clone — `rm -rf` on one destroys work while leaving the admin
 * record behind, which is precisely how `reapStaleWorktrees` destroyed an agent's working tree
 * twice on 2026-07-31. Requiring a `.git` DIRECTORY restricts this reaper to STANDALONE clones,
 * which own their objects outright, so a reap here can never reach into another checkout.
 *
 * WHY LIVENESS IS NOT AN mtime TEST. An mtime age test alone is what made those two destructions
 * possible: a tree can be idle for hours while a process still holds it. {@link reapStaleClones}
 * requires BOTH that nothing has an open file anywhere under the directory (`lsof +D`) AND that
 * it is older than the age ceiling. Either check failing keeps the directory.
 */
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir as osTmpdir } from "node:os";
import { join, resolve } from "node:path";

import { systemClock } from "./clock.js";
import { killAfterGrace } from "./git-fetch-retry.js";
import { claudeScratchRoot, isReapableScratchTarget } from "./worker-scratch.js";

/** A clone is ours iff its `origin` remote names this repo. */
export const REMUDERO_ORIGIN_FRAGMENT = "craigoley/remudero";

/**
 * Age ceiling before an idle fleet clone is reapable. 24h, matching lib/tmp.ts's
 * `DEFAULT_TEMP_SWEEP_MAX_AGE_MS` and worker-scratch.ts's boot ceiling — the conservative end
 * of the range those two already established, and ~15x the 92.3-min longest observed task
 * wall-time, so no clone belonging to a running review is ever old enough to qualify even if
 * the liveness probe were to fail open.
 */
export const DEFAULT_CLONE_REAP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The fs surface this module uses, injectable so tests never touch a real root. */
export type CloneReapFs = Pick<
  typeof fs,
  "existsSync" | "lstatSync" | "statSync" | "readdirSync" | "realpathSync" | "rmSync"
>;

export interface CloneReapDeps {
  fsImpl?: CloneReapFs;
  /** `origin` remote URL of a directory, or null if it is not a git repo. */
  originOf?: (dir: string) => string | null;
  /** Count of open files anywhere under `dir` — 0 means nothing holds it. */
  openFileCount?: (dir: string) => number;
  /** {@link reapStaleClonesAsync} only, each preferred over its sync seam above. */
  fsAsync?: CloneReapFsAsync;
  originOfAsync?: (dir: string) => Promise<string | null | ProbeTimedOut>;
  openFileCountAsync?: (dir: string) => Promise<OpenFileProbe>;
  now?: () => number;
  maxAgeMs?: number;
  /** Report what would be reaped and delete NOTHING. */
  dryRun?: boolean;
}

/** Why a candidate was kept, or that it was reaped. */
export type CloneDisposition =
  | "reaped"
  | "would-reap"
  | "not-a-fleet-clone"
  | "symlink"
  | "outside-root"
  | "in-use"
  | "too-recent"
  | "remove-failed"
  | "probe-timed-out"; // awaited survey only: a probe was killed at its bound, so the dir is kept

export interface CloneCandidate {
  path: string;
  disposition: CloneDisposition;
  bytes: number;
  ageMs: number;
}

export interface CloneReapSummary {
  candidates: CloneCandidate[];
  reaped: string[];
  bytesReclaimed: number;
  dryRun: boolean;
}

export type CloneReapFsAsync = Pick<typeof fsp, "lstat" | "readdir" | "rm">;

/** BACKSTOP on an awaited `lsof +D` (and `origin` read). MEASURED 2026-10-06: 0.6 s over a 20,943-file
 *  `.git`; lsof stats every file, so the 141,536-object store projects to ~4 s. ~15x that for a loaded host. */
export const OPEN_FILE_PROBE_TIMEOUT_MS = 60_000;

export const PROBE_TIMED_OUT = "timed_out" as const;
export type ProbeTimedOut = typeof PROBE_TIMED_OUT;

/** The count an awaited probe read, or the bound it was killed at — never a count it did not read. */
export type OpenFileProbe = { count: number } | { timedOutAfterMs: number };

/** `exitCode` is null when the child never ran or died by a signal. */
interface BoundedRun {
  stdout: string;
  exitCode: number | null;
  timedOut: boolean;
}

/** One awaited spawn: SIGTERM at `timeoutMs`, SIGKILL after the grace. Never rejects. */
function runBounded(file: string, args: readonly string[], timeoutMs: number): Promise<BoundedRun> {
  return new Promise((resolve) => {
    let timedOut = false;
    const child = execFile(file, [...args], { encoding: "utf8" }, (err, stdout) => {
      clearTimeout(timer);
      const code = (err as { code?: unknown } | null)?.code;
      resolve({ stdout, timedOut, exitCode: err === null ? 0 : typeof code === "number" ? code : null });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killAfterGrace(child);
    }, timeoutMs);
  });
}

function nonEmptyLineCount(out: string): number {
  return out.split("\n").filter((l) => l.trim().length > 0).length;
}

/** Real `origin` lookup. Never throws — a non-repo directory yields null. */
export function defaultOriginOf(dir: string): string | null {
  try {
    return execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Real liveness probe: how many open files `lsof` reports anywhere under `dir`. A non-zero
 * count means a live process holds the tree. FAIL-CLOSED: if `lsof` cannot be run at all we
 * return 1 ("something holds it") rather than 0, so a probe failure keeps the directory
 * instead of authorising a delete. `lsof +D` exits non-zero when it finds nothing, so a
 * non-zero exit with empty output is the genuine "nothing holds it" answer.
 */
export function defaultOpenFileCount(dir: string): number {
  try {
    const out = execFileSync("lsof", ["+D", dir], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n").filter((l) => l.trim().length > 0).length;
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    if (typeof err.status === "number") {
      const out = err.stdout ?? "";
      return out.split("\n").filter((l) => l.trim().length > 0).length;
    }
    return 1; // lsof missing or unrunnable — fail closed, treat as held
  }
}

/** {@link defaultOriginOf}, awaited; killed at its bound it answers {@link PROBE_TIMED_OUT}, never null. */
export async function defaultOriginOfAsync(dir: string, timeoutMs = OPEN_FILE_PROBE_TIMEOUT_MS): Promise<string | null | ProbeTimedOut> {
  const r = await runBounded("git", ["-C", dir, "remote", "get-url", "origin"], timeoutMs);
  if (r.timedOut) return PROBE_TIMED_OUT;
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

/** {@link defaultOpenFileCount}, awaited and bounded; same answers, 1 (held) when lsof cannot run. Kept
 *  `+D`: `+d` misses `objects/xx/` handles, and `/proc/<pid>/fd` is Linux-only and misses cwd/mmap. */
export async function defaultOpenFileCountAsync(dir: string, timeoutMs = OPEN_FILE_PROBE_TIMEOUT_MS): Promise<OpenFileProbe> {
  const r = await runBounded("lsof", ["+D", dir], timeoutMs);
  if (r.timedOut) return { timedOutAfterMs: timeoutMs };
  return { count: r.exitCode === null ? 1 : nonEmptyLineCount(r.stdout) };
}

/**
 * Total bytes under `dir`, never following a symlink (a link's target is somebody else's
 * bytes and is not reclaimed by removing the link). Best-effort: an unreadable entry
 * contributes 0 rather than throwing.
 */
export function dirSizeBytes(dir: string, fsImpl: CloneReapFs = fs): number {
  let total = 0;
  let entries: string[];
  try {
    entries = fsImpl.readdirSync(dir) as unknown as string[];
  } catch {
    return 0;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st: fs.Stats;
    try {
      st = fsImpl.lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue; // never follow, never count somebody else's tree
    if (st.isDirectory()) {
      total += dirSizeBytes(full, fsImpl);
      continue;
    }
    total += st.size;
  }
  return total;
}

/**
 * The OWNERSHIP PREDICATE. Returns the inner clone directory when `dir` is a fleet review
 * clone, else null. Accepts both observed layouts — `<dir>/repo/.git` (every one of the 36)
 * and a bare `<dir>/.git` — and in BOTH requires `.git` to be a DIRECTORY, so a linked
 * worktree can never qualify. See this module's header for why that distinction is the
 * safety property and not a detail.
 */
export function isFleetReviewClone(dir: string, deps: CloneReapDeps = {}): string | null {
  const fsImpl = deps.fsImpl ?? fs;
  const originOf = deps.originOf ?? defaultOriginOf;
  for (const inner of [join(dir, "repo"), dir]) {
    let gitIsDir = false;
    try {
      gitIsDir = fsImpl.lstatSync(join(inner, ".git")).isDirectory();
    } catch {
      continue;
    }
    if (!gitIsDir) continue;
    const origin = originOf(inner);
    if (origin && origin.includes(REMUDERO_ORIGIN_FRAGMENT)) return inner;
  }
  return null;
}

/**
 * Survey one scratch root and decide every direct child, deleting nothing. This is the
 * function the `--dry-run` operator report and the live reap both drive, so what the operator
 * reads is produced by the same code that acts.
 */
export function surveyRoot(root: string, deps: CloneReapDeps = {}): CloneCandidate[] {
  const fsImpl = deps.fsImpl ?? fs;
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_CLONE_REAP_MAX_AGE_MS;
  const openFileCount = deps.openFileCount ?? defaultOpenFileCount;
  const out: CloneCandidate[] = [];

  let entries: string[];
  try {
    entries = fsImpl.readdirSync(root) as unknown as string[];
  } catch {
    return out; // root absent or unreadable — nothing to survey, never throws
  }

  for (const name of entries) {
    const full = resolve(root, name);
    // CONTAINMENT, first and unconditionally: exactly one segment strictly below root.
    if (!isReapableScratchTarget(root, full)) {
      out.push({ path: full, disposition: "outside-root", bytes: 0, ageMs: 0 });
      continue;
    }
    let st: fs.Stats;
    try {
      st = fsImpl.lstatSync(full);
    } catch {
      continue; // vanished between readdir and lstat — somebody else's cleanup won
    }
    // A SYMLINK IS NEVER A CANDIDATE. Removing it reclaims nothing and following it would
    // leave the reap root entirely — the 2026-07-29 accident that emptied the shared
    // node_modules under a live daemon.
    if (st.isSymbolicLink()) {
      out.push({ path: full, disposition: "symlink", bytes: 0, ageMs: 0 });
      continue;
    }
    if (!st.isDirectory()) continue;
    if (!isFleetReviewClone(full, deps)) {
      out.push({ path: full, disposition: "not-a-fleet-clone", bytes: 0, ageMs: 0 });
      continue;
    }
    const ageMs = now() - st.mtimeMs;
    const bytes = dirSizeBytes(full, fsImpl);
    if (openFileCount(full) > 0) {
      out.push({ path: full, disposition: "in-use", bytes, ageMs });
      continue;
    }
    if (ageMs <= maxAgeMs) {
      out.push({ path: full, disposition: "too-recent", bytes, ageMs });
      continue;
    }
    out.push({ path: full, disposition: "would-reap", bytes, ageMs });
  }
  return out;
}

/**
 * Reap every stale, idle, fleet-owned clone under `roots`. With `dryRun` the survey is
 * returned untouched and nothing is removed. Best-effort per entry: one failed removal is
 * recorded and never aborts the rest.
 */
export function reapStaleClones(roots: readonly string[], deps: CloneReapDeps = {}): CloneReapSummary {
  const fsImpl = deps.fsImpl ?? fs;
  const dryRun = deps.dryRun === true;
  const candidates: CloneCandidate[] = [];
  const reaped: string[] = [];
  let bytesReclaimed = 0;

  for (const root of roots) {
    for (const c of surveyRoot(root, deps)) {
      if (c.disposition !== "would-reap" || dryRun) {
        candidates.push(c);
        continue;
      }
      try {
        fsImpl.rmSync(c.path, { recursive: true, force: true });
        reaped.push(c.path);
        bytesReclaimed += c.bytes;
        candidates.push({ ...c, disposition: "reaped" });
      } catch {
        candidates.push({ ...c, disposition: "remove-failed" });
      }
    }
  }
  return { candidates, reaped, bytesReclaimed, dryRun };
}

/**
 * The scratch roots abandoned review clones were MEASURED in on 2026-08-01: `os.tmpdir()`
 * (30 of 36), the darwin `/private/tmp` (5), and the SDK's `claude-<uid>` scratchpad root (1).
 * Deduped and existence-filtered, so a root that is absent on this platform is simply not
 * surveyed. `claudeScratchRoot` is reused from worker-scratch.ts rather than re-derived —
 * that module already resolves the CLAUDE_CODE_TMPDIR / darwin-"/tmp" / realpath rules.
 */
export function cloneReapRoots(opts: { platform?: NodeJS.Platform; fsImpl?: CloneReapFs } = {}): string[] {
  const platform = opts.platform ?? process.platform;
  const fsImpl = opts.fsImpl ?? fs;
  const scratch = claudeScratchRoot();
  const roots = [osTmpdir(), ...(platform === "darwin" ? ["/private/tmp"] : []), ...(scratch ? [scratch] : [])];
  const seen = new Set<string>();
  return roots.filter((r) => {
    if (seen.has(r)) return false;
    seen.add(r);
    return fsImpl.existsSync(r);
  });
}

/** Compact per-disposition tally for the ledger line and the operator report. */
export function tallyDispositions(candidates: readonly CloneCandidate[]): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const c of candidates) tally[c.disposition] = (tally[c.disposition] ?? 0) + 1;
  return tally;
}

/** {@link dirSizeBytes}, awaited: the same walk, never following a symlink. */
export async function dirSizeBytesAsync(dir: string, fsa: CloneReapFsAsync = fsp): Promise<number> {
  let entries: string[];
  try {
    entries = await fsa.readdir(dir);
  } catch {
    return 0; // unreadable contributes 0, as the sync walk counts it
  }
  let total = 0;
  for (const name of entries) {
    const full = join(dir, name);
    let st: fs.Stats;
    try {
      st = await fsa.lstat(full);
    } catch {
      continue; // unstattable contributes 0, as the sync walk skips it
    }
    if (st.isSymbolicLink()) continue;
    total += st.isDirectory() ? await dirSizeBytesAsync(full, fsa) : st.size;
  }
  return total;
}

/** The awaited probes; an injected sync probe (tests) still answers, wrapped. */
function asyncProbes(deps: CloneReapDeps): {
  originOf: (dir: string) => Promise<string | null | ProbeTimedOut>;
  openFileCount: (dir: string) => Promise<OpenFileProbe>;
} {
  const { originOf, openFileCount } = deps;
  return {
    originOf: deps.originOfAsync ?? (originOf ? async (d) => originOf(d) : defaultOriginOfAsync),
    openFileCount: deps.openFileCountAsync ?? (openFileCount ? async (d) => ({ count: openFileCount(d) }) : defaultOpenFileCountAsync),
  };
}

/** {@link isFleetReviewClone}, awaited; a timed-out `origin` read answers {@link PROBE_TIMED_OUT}. */
export async function isFleetReviewCloneAsync(dir: string, deps: CloneReapDeps = {}): Promise<string | null | ProbeTimedOut> {
  const fsa = deps.fsAsync ?? fsp;
  const { originOf } = asyncProbes(deps);
  for (const inner of [join(dir, "repo"), dir]) {
    let gitIsDir = false;
    try {
      gitIsDir = (await fsa.lstat(join(inner, ".git"))).isDirectory();
    } catch {
      continue; // no .git at this layout, as the sync predicate skips it
    }
    if (!gitIsDir) continue;
    const origin = await originOf(inner);
    if (origin === PROBE_TIMED_OUT) return PROBE_TIMED_OUT;
    if (origin && origin.includes(REMUDERO_ORIGIN_FRAGMENT)) return inner;
  }
  return null;
}

/** {@link surveyRoot} OFF THE EVENT LOOP: the same dispositions in the same order, all awaited. */
export async function surveyRootAsync(root: string, deps: CloneReapDeps = {}): Promise<CloneCandidate[]> {
  const fsa = deps.fsAsync ?? fsp;
  const now = deps.now ?? systemClock.now;
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_CLONE_REAP_MAX_AGE_MS;
  const { openFileCount } = asyncProbes(deps);
  const out: CloneCandidate[] = [];
  let entries: string[];
  try {
    entries = await fsa.readdir(root);
  } catch {
    return out; // root absent or unreadable, as the sync survey answers
  }
  for (const name of entries) {
    const full = resolve(root, name);
    if (!isReapableScratchTarget(root, full)) {
      out.push({ path: full, disposition: "outside-root", bytes: 0, ageMs: 0 });
      continue;
    }
    let st: fs.Stats;
    try {
      st = await fsa.lstat(full);
    } catch {
      continue; // vanished between readdir and lstat, as the sync survey skips it
    }
    if (st.isSymbolicLink()) {
      out.push({ path: full, disposition: "symlink", bytes: 0, ageMs: 0 });
      continue;
    }
    if (!st.isDirectory()) continue;
    const clone = await isFleetReviewCloneAsync(full, deps);
    if (clone === null) {
      out.push({ path: full, disposition: "not-a-fleet-clone", bytes: 0, ageMs: 0 });
      continue;
    }
    const ageMs = now() - st.mtimeMs;
    if (clone === PROBE_TIMED_OUT) {
      out.push({ path: full, disposition: "probe-timed-out", bytes: 0, ageMs });
      continue;
    }
    const bytes = await dirSizeBytesAsync(full, fsa);
    const probe = await openFileCount(full);
    if ("timedOutAfterMs" in probe) {
      out.push({ path: full, disposition: "probe-timed-out", bytes, ageMs });
      continue;
    }
    if (probe.count > 0) {
      out.push({ path: full, disposition: "in-use", bytes, ageMs });
      continue;
    }
    out.push({ path: full, disposition: ageMs <= maxAgeMs ? "too-recent" : "would-reap", bytes, ageMs });
  }
  return out;
}

/** {@link reapStaleClones} OFF THE EVENT LOOP: the same survey and per-entry best-effort removal. */
export async function reapStaleClonesAsync(roots: readonly string[], deps: CloneReapDeps = {}): Promise<CloneReapSummary> {
  const fsa = deps.fsAsync ?? fsp;
  const dryRun = deps.dryRun === true;
  const candidates: CloneCandidate[] = [];
  const reaped: string[] = [];
  let bytesReclaimed = 0;
  for (const root of roots) {
    for (const c of await surveyRootAsync(root, deps)) {
      if (c.disposition !== "would-reap" || dryRun) {
        candidates.push(c);
        continue;
      }
      try {
        await fsa.rm(c.path, { recursive: true, force: true });
        reaped.push(c.path);
        bytesReclaimed += c.bytes;
        candidates.push({ ...c, disposition: "reaped" });
      } catch {
        candidates.push({ ...c, disposition: "remove-failed" }); // named, as the sync reap records it
      }
    }
  }
  return { candidates, reaped, bytesReclaimed, dryRun };
}
