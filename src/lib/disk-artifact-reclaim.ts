/**
 * src/lib/disk-artifact-reclaim.ts — reclaims REGENERABLE BUILD OUTPUT inside checkouts the fleet
 * must otherwise keep (W1-T3528).
 *
 * THE DEFECT. Three reclaim rungs already ship — `logDiskReclaimRung` (temp dirs, review clones,
 * worker homes), `runAdhocLaneReapRung` (ad-hoc lanes) and `object-reaper.ts` (loose git objects) —
 * and every one of them reaps a WHOLE TREE under a MANAGED ROOT. That leaves two objects
 * unreachable, measured on the Azure host at 88% full on 2026-09-13: a 379MB `coverage/` and an
 * 836MB `node_modules`, both inside hand-made checkouts in $HOME.
 *
 * WHY A WHOLE-TREE REAPER CANNOT FIX IT. The checkout holding the largest `node_modules` also held
 * 45 uncommitted files. Reaping that tree would destroy unpushed work, so every existing rung is
 * RIGHT to refuse it — and the regenerable half stays unreclaimable forever. Nothing in the repo
 * can express "delete the artifact, keep the tree", which is the one capability this module adds.
 *
 * SCOPE IS AN ALLOWLIST OF NAMES WHOSE CONTENTS REGENERATE, never a walk for large directories.
 * Size is not a reason to delete anything and is never consulted as one: the checkout above would
 * have been selected by size, and only the dirty-tree refusal saved it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { systemClock, type Clock } from "./clock.js";
import type { Config } from "./config.js";
import { readDiskFreeBytes } from "./daemon-health.js";

/** The only names this sweep will ever consider. Both regenerate from a committed manifest —
 *  `coverage/` from a test run, `node_modules/` from `npm ci` — so removing either costs time and
 *  never information. Adding a name here is a deliberate widening: anything whose contents are not
 *  reproducible from the repo belongs in a different rung. */
export const RECLAIMABLE_ARTIFACT_NAMES: readonly string[] = ["coverage", "node_modules"];

/** Only act under real pressure. Above this the sweep is a no-op, so a healthy host never has work
 *  deleted out from under it to save space it is not short of. */
export const DEFAULT_RECLAIM_BELOW_BYTES = 6 * 1024 * 1024 * 1024;

/** An artifact untouched for this long is not mid-build. Never sufficient alone — it sits alongside
 *  the dirty-tree and open-handle refusals, mirroring the review sweep's own doctrine that age
 *  cannot tell a stranded tree from a slow live one. */
export const DEFAULT_ARTIFACT_REAP_GRACE_MS = 6 * 60 * 60 * 1000;

/** WHY a candidate was reclaimed or kept — ledgered for every candidate, so a sweep that found
 *  nothing eligible is distinguishable from one that ran and saw nothing at all. */
export type ArtifactSweepReason =
  | "reclaimed"
  /** Free space is above the threshold — the sweep declined to act at all. */
  | "headroom-ok"
  /** Touched inside the grace window; may be a live build. Never the sole guard. */
  | "too-young"
  /** The enclosing checkout has uncommitted changes — refused, because a tree someone is working
   *  in is a tree whose build output they are probably about to use. */
  | "checkout-dirty"
  /** A process holds a file open beneath it. Fail-closed: "cannot tell" reads the same as "yes". */
  | "in-use"
  /** Free space, the checkout's git state, or the artifact's own mtime could not be read. An
   *  unanswerable question is never a yes. */
  | "unreadable"
  /** Every gate passed but the removal itself failed — best-effort, the pass continues. */
  | "removal-failed";

export interface ArtifactSweepOutcome {
  path: string;
  reason: ArtifactSweepReason;
}

export interface ArtifactSweepSummary {
  reclaimed: string[];
  kept: ArtifactSweepOutcome[];
  bytesReclaimed: number;
}

export interface ArtifactSweepOptions {
  /** Directory whose immediate children are candidate checkouts. Defaults to `config.root`'s
   *  parent, which is where hand-made checkouts sit beside the managed one. */
  scanRoot?: () => string;
  listEntries?: (dir: string) => string[];
  isDirectory?: (path: string) => boolean;
  /** True when `path` looks like a git checkout (a `.git` file or directory). */
  isCheckout?: (path: string) => boolean;
  clock?: Clock;
  graceMs?: number;
  reclaimBelowBytes?: number;
  /** Free bytes on the filesystem being swept — NOT the state volume, which on the measured host
   *  is a different device with 65G free. `undefined` = unreadable. */
  freeBytes?: (path: string) => number | undefined;
  /** Count of `git status --porcelain` lines in the enclosing checkout. `undefined` = unreadable. */
  countDirtyFiles?: (checkoutPath: string) => number | undefined;
  /** Whether any process holds a file open beneath `path`. `undefined` = could not tell. */
  isInUse?: (path: string) => boolean | undefined;
  /** Artifact mtime in epoch ms. `undefined` = unreadable. */
  modifiedAtMs?: (path: string) => number | undefined;
  /** Bytes the artifact occupies, for the ledger. Best-effort: 0 when unreadable. */
  sizeBytes?: (path: string) => number;
  removeDir?: (path: string) => void;
}

/**
 * Reclaim regenerable build output under {@link ArtifactSweepOptions.scanRoot}. Called once per
 * daemon tick; see this module's header for the full defect and design.
 *
 * NEVER RUNS `git worktree prune`, AND THAT OMISSION IS DELIBERATE. From the host, worktrees that
 * are ALIVE inside the container register under container-side `/home/node/...` paths that do not
 * exist here, so git reports every one of them `prunable`. A prune from this side would delete the
 * registrations of live worktrees. Do not "fix" this by adding one.
 */
export function sweepReclaimableArtifacts(
  config: Config,
  log: (step: string, extra?: Record<string, unknown>) => void,
  opts: ArtifactSweepOptions = {},
): ArtifactSweepSummary {
  const scanRoot = (opts.scanRoot ?? (() => join(config.root, "..")))();
  const listEntries = opts.listEntries ?? ((dir: string) => readdirSync(dir));
  const isDirectory = opts.isDirectory ?? defaultIsDirectory;
  const isCheckout = opts.isCheckout ?? ((p: string) => existsSync(join(p, ".git")));
  const clock = opts.clock ?? systemClock;
  const graceMs = opts.graceMs ?? DEFAULT_ARTIFACT_REAP_GRACE_MS;
  const reclaimBelowBytes = opts.reclaimBelowBytes ?? DEFAULT_RECLAIM_BELOW_BYTES;
  const freeBytes = opts.freeBytes ?? ((p: string) => readDiskFreeBytes(p));
  const countDirtyFiles = opts.countDirtyFiles ?? defaultCountDirtyFiles;
  const isInUse = opts.isInUse ?? defaultIsInUse;
  const modifiedAtMs = opts.modifiedAtMs ?? defaultModifiedAtMs;
  const sizeBytes = opts.sizeBytes ?? defaultSizeBytes;
  const removeDir = opts.removeDir ?? ((p: string) => rmSync(p, { recursive: true, force: true }));

  const reclaimed: string[] = [];
  const kept: ArtifactSweepOutcome[] = [];
  let bytesReclaimed = 0;
  const keep = (path: string, reason: ArtifactSweepReason, extra: Record<string, unknown> = {}): void => {
    kept.push({ path, reason });
    log("disk_artifact.sweep.kept", { path, reason, ...extra });
  };

  // THE HEADROOM GATE READS THE FILESYSTEM BEING SWEPT. Reading the state root instead would
  // answer about a 126G volume at 46% and this sweep would never fire on the disk that is full.
  const free = freeBytes(scanRoot);
  if (free === undefined) {
    keep(scanRoot, "unreadable", { what: "statfs" });
    return { reclaimed, kept, bytesReclaimed };
  }
  if (free >= reclaimBelowBytes) {
    keep(scanRoot, "headroom-ok", { freeBytes: free, reclaimBelowBytes });
    return { reclaimed, kept, bytesReclaimed };
  }

  let names: string[];
  try {
    names = listEntries(scanRoot);
  } catch {
    return { reclaimed, kept, bytesReclaimed }; // unreadable root — best-effort, matches reapStaleWorktrees
  }

  for (const name of names) {
    const checkout = join(scanRoot, name);
    if (!isDirectory(checkout)) continue;
    if (!isCheckout(checkout)) continue; // not a checkout — never a candidate, never ledgered as one

    const present = RECLAIMABLE_ARTIFACT_NAMES.map((a) => join(checkout, a)).filter(
      (p) => isDirectory(p),
    );
    if (present.length === 0) continue;

    // ONE dirty read per checkout, not one per artifact: the answer is a property of the tree.
    const dirty = countDirtyFiles(checkout);
    if (dirty === undefined) {
      for (const p of present) keep(p, "unreadable", { what: "git-status" });
      continue;
    }
    if (dirty > 0) {
      for (const p of present) keep(p, "checkout-dirty", { dirtyFiles: dirty });
      continue;
    }

    for (const path of present) {
      const mtime = modifiedAtMs(path);
      if (mtime === undefined) {
        keep(path, "unreadable", { what: "mtime" });
        continue;
      }
      if (clock.now() - mtime < graceMs) {
        keep(path, "too-young");
        continue;
      }
      // FAIL CLOSED: `undefined` means the question could not be answered, which is treated
      // exactly like "yes, in use". A reclaimer that guesses here deletes a live worker's tree.
      if (isInUse(path) !== false) {
        keep(path, "in-use");
        continue;
      }
      const bytes = sizeBytes(path);
      try {
        removeDir(path);
        reclaimed.push(path);
        bytesReclaimed += bytes;
        log("disk_artifact.sweep.reclaimed", { path, bytes });
      } catch (e) {
        keep(path, "removal-failed", { error: String((e as Error)?.message ?? e) });
      }
    }
  }

  return { reclaimed, kept, bytesReclaimed };
}

function defaultIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch (e) {
    console.error(
      `disk-artifact-reclaim: could not stat ${path} while checking for a directory (${String((e as Error)?.message ?? e)})`,
    );
    return false;
  }
}

function defaultModifiedAtMs(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch (e) {
    console.error(`disk-artifact-reclaim: could not stat ${path} (${String((e as Error)?.message ?? e)})`);
    return undefined;
  }
}

/** `git status --porcelain` line count. Any failure is `undefined` — an unreadable tree is never
 *  reported as clean, because "clean" is what authorises deletion. */
function defaultCountDirtyFiles(checkoutPath: string): number | undefined {
  try {
    const out = execFileSync("git", ["-C", checkoutPath, "status", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.split("\n").filter((l) => l.trim() !== "").length;
  } catch (e) {
    console.error(
      `disk-artifact-reclaim: could not read git status in ${checkoutPath} (${String((e as Error)?.message ?? e)})`,
    );
    return undefined;
  }
}

/** Whether any process holds a file open beneath `path`, via `lsof +D`. Exit 1 with no output is
 *  lsof's "nothing found" and is the ONLY reading that returns `false`; every other outcome —
 *  lsof missing, permission denied, a timeout — returns `undefined` and is refused upstream. */
function defaultIsInUse(path: string): boolean | undefined {
  try {
    const out = execFileSync("lsof", ["+D", path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.trim() !== "";
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    const stderr = err.stderr?.trim() ?? "";
    if (err.status === 1 && stderr === "") return false; // clean "no open files"
    return undefined;
  }
}

function defaultSizeBytes(path: string): number {
  try {
    const out = execFileSync("du", ["-sk", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const kb = Number(out.split(/\s+/)[0]);
    return Number.isFinite(kb) ? kb * 1024 : 0;
  } catch (e) {
    console.error(
      `disk-artifact-reclaim: could not measure size of ${path} (${String((e as Error)?.message ?? e)}) — ledgering 0 bytes, best-effort`,
    );
    return 0;
  }
}
