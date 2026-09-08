/**
 * lib/object-reaper.ts — reclaim UNREACHABLE git objects from a fleet repository.
 *
 * THE GAP: nothing has ever reclaimed a git OBJECT. A grep for gc/prune/repack across src/ returns
 * only `git worktree prune`, which is worktree-ADMIN cleanup. Measurements, and why the second-order
 * effects matter more than the bytes, are in plan/tasks.d/W1-T3090-*.yaml.
 *
 * TWO INDEPENDENT PROTECTIONS, which is the {@link file://./clone-reaper.ts} discipline — that
 * module records that an age test ALONE destroyed two working trees:
 *   (1) QUIET  — no registered worktree, no inflight lock, no open handle under `.git`. Any one
 *                failing REFUSES, and an absent or unreadable probe refuses rather than authorising.
 *   (2) EXPIRY — {@link OBJECT_PRUNE_EXPIRY} is ALWAYS passed. Even if (1) were wrong, an object a
 *                live worker created inside the window is ineligible.
 * Both must fail to cause harm.
 *
 * PRUNE ONLY, NEVER `gc`: gc repacks and can rewrite refs and reflogs, and the finding is about
 * UNREACHABLE objects, which prune alone removes.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** How old an unreachable object must be before it is eligible. The SECOND of the two barriers:
 *  it is what makes a wrong quiet verdict survivable, so it is never omitted and never zero. */
export const OBJECT_PRUNE_EXPIRY = "24.hours.ago";

/** Below this many loose objects the reap is not worth a subprocess. Reported, not silent. */
export const LOOSE_OBJECT_FLOOR = 5000;

export interface ObjectReapDeps {
  /** Registered worktrees for the repo. Non-empty REFUSES. */
  listWorktrees?: (repoDir: string) => readonly string[];
  /** Inflight lock files. Non-empty REFUSES. */
  listInflightLocks?: () => readonly string[];
  /** Open-handle count under `.git`. Non-zero REFUSES; unreadable must return >0 (fail closed). */
  openFileCount?: (dir: string) => number;
  /** Loose object count. */
  looseObjectCount?: (repoDir: string) => number;
  /** Runs the prune. Injected so a test can assert the ARGV, which is where the expiry lives. */
  runPrune?: (repoDir: string, args: readonly string[]) => void;
  /** SURVEY MODE. Every check the armed path runs still runs; nothing is spawned and nothing is
   *  removed. ONE PREDICATE, TWO OUTCOMES — a survey that reached different probes would report a
   *  decision nobody will ever make, which is the whole point of reading dispositions first. */
  dryRun?: boolean;
  /** Counts what a prune WOULD remove, for the survey. An ESTIMATE AT SURVEY TIME: the armed pass
   *  runs later, against a repo that has moved. */
  countPrunable?: (repoDir: string, args: readonly string[]) => number;
}

export interface ObjectReapResult {
  /** Objects removed, or 0 when refused OR surveying. */
  pruned: number;
  /** SURVEY ONLY: what a prune would have removed. Undefined on an armed pass. An estimate. */
  wouldPrune?: number;
  /** Present iff nothing was pruned. Names the cause in the operator's own vocabulary. */
  refusedBecause?: string;
  looseBefore: number;
}

/** Registered worktrees, excluding the main one. `git worktree list --porcelain` emits a
 *  `worktree <path>` line per entry; the FIRST is the repo itself and is never a reason to refuse. */
export function defaultListWorktrees(repoDir: string): readonly string[] {
  try {
    const out = execFileSync("git", ["-C", repoDir, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const paths = out
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length).trim());
    return paths.slice(1);
  } catch {
    return ["<unreadable>"]; // fail closed — an unreadable list is not an empty one
  }
}

/** `.lock` files under the fleet's inflight dir. Unreadable is NOT empty: it refuses. */
export function defaultListInflightLocks(inflightDir: string): readonly string[] {
  try {
    if (!existsSync(inflightDir)) return [];
    return readdirSync(inflightDir).filter((n) => n.endsWith(".lock"));
  } catch {
    return ["<unreadable>"]; // fail closed
  }
}

/** Loose (unpacked) object count from `git count-objects -v`. Unreadable reads as 0, which only
 *  ever causes a SKIP (below the floor), never a prune — the safe direction for this input. */
export function defaultLooseObjectCount(repoDir: string): number {
  try {
    const out = execFileSync("git", ["-C", repoDir, "count-objects", "-v"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = /^count: (\d+)$/m.exec(out);
    return m ? Number(m[1]) : 0;
  } catch {
    // Unreadable reads as 0, and 0 is BELOW the floor, so an unreadable count can only ever cause
    // a SKIP — never a prune. That is the safe direction for this input, unlike the probes above,
    // where unreadable must read as "held".
    return 0;
  }
}

/**
 * The QUIET predicate, as its own function so every arm is separately testable and each refusal
 * carries the cause a reader needs. Returns `undefined` when it is safe to proceed.
 */
export function objectReapRefusal(
  repoDir: string,
  inflightDir: string,
  deps: ObjectReapDeps = {},
): string | undefined {
  const worktrees = (deps.listWorktrees ?? defaultListWorktrees)(repoDir);
  if (worktrees.length > 0) {
    return `${worktrees.length} worktree(s) registered — a prune racing a worker can remove an object it is about to reference`;
  }
  const locks = (deps.listInflightLocks ?? (() => defaultListInflightLocks(inflightDir)))();
  if (locks.length > 0) {
    return `${locks.length} inflight lock(s) held — the fleet is mid-dispatch`;
  }
  const open = (deps.openFileCount ?? (() => 1))(join(repoDir, ".git"));
  if (open > 0) {
    return `${open} open handle(s) under .git — a live process holds the object store`;
  }
  return undefined;
}

/**
 * Reclaim unreachable objects, or refuse with a named cause.
 *
 * ORDER IS LOAD-BEARING: `.git/gc.log` is removed ONLY on a pass that is about to prune. Removing
 * it on a refused pass would re-arm git's UNSUPERVISED automatic cleanup, which is precisely what
 * the operator's standing rule exists to prevent — the opposite of this function's purpose.
 */
/** How many objects `git prune -n` would remove. Unreadable reads as 0 — a survey that cannot
 *  measure reports nothing, and reporting nothing is never mistaken for authorising something. */
export function defaultCountPrunable(repoDir: string, args: readonly string[]): number {
  try {
    const out = execFileSync("git", ["-C", repoDir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split("\n").filter((l) => l.trim().length > 0).length;
  } catch {
    // A survey that cannot measure reports nothing. Reporting nothing is never mistaken for
    // authorising something: this value is ledgered, never compared against a threshold.
    return 0;
  }
}

export function reapGitObjects(
  repoDir: string,
  inflightDir: string,
  deps: ObjectReapDeps = {},
): ObjectReapResult {
  const looseBefore = (deps.looseObjectCount ?? defaultLooseObjectCount)(repoDir);
  if (looseBefore < LOOSE_OBJECT_FLOOR) {
    return { pruned: 0, looseBefore, refusedBecause: `only ${looseBefore} loose object(s), below the ${LOOSE_OBJECT_FLOOR} floor` };
  }
  const refusal = objectReapRefusal(repoDir, inflightDir, deps);
  if (refusal !== undefined) return { pruned: 0, looseBefore, refusedBecause: refusal };

  // SURVEY: past every refusal above, so the disposition reported is the decision the armed path
  // would have made. Returns BEFORE gc.log is touched and before anything is spawned.
  if (deps.dryRun === true) {
    const count = deps.countPrunable ?? defaultCountPrunable;
    return { pruned: 0, wouldPrune: count(repoDir, ["prune", "-n", `--expire=${OBJECT_PRUNE_EXPIRY}`]), looseBefore };
  }
  // Only now, with the prune committed to, does the auto-gc suppressor come off.
  try {
    rmSync(join(repoDir, ".git", "gc.log"), { force: true });
  } catch {
    // best-effort: a gc.log we cannot remove costs a warning, never the prune
  }
  const run = deps.runPrune ?? ((dir, args) => {
    execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "ignore", "ignore"] });
  });
  run(repoDir, ["prune", `--expire=${OBJECT_PRUNE_EXPIRY}`]);
  const looseAfter = (deps.looseObjectCount ?? defaultLooseObjectCount)(repoDir);
  return { pruned: Math.max(0, looseBefore - looseAfter), looseBefore };
}
