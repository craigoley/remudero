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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Clock, systemClock } from "./clock.js";

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
  /** W1-T4022: where the CONSECUTIVE REFUSAL streak is persisted (design (iii)). Undefined skips
   *  streak tracking entirely — a test with no interest in it never has to plumb one through, and
   *  the below-the-floor early return (a different condition from "the fleet is busy") never
   *  touches this file at all. Read+written on every call so a permanent block is distinguishable
   *  from a single busy tick across process restarts, not just within one. */
  streakPath?: string;
  /** Injectable clock for the streak's `refusingSinceIso` timestamp. */
  clock?: Clock;
}

/** Persisted at {@link ObjectReapDeps.streakPath}: how many CONSECUTIVE REFUSALS the quiet
 *  predicate has produced, and since when. A refusal names WHICH condition; this names for HOW
 *  LONG, so "refused once" and "has refused every time for three weeks" stop reading identically. */
export interface RefusalStreak {
  consecutiveRefusals: number;
  /** ISO timestamp the CURRENT streak began, or `null` while it is zero. */
  refusingSinceIso: string | null;
}

export interface ObjectReapResult {
  /** Objects removed, or 0 when refused OR surveying. */
  pruned: number;
  /** SURVEY ONLY: what a prune would have removed. Undefined on an armed pass. An estimate. */
  wouldPrune?: number;
  /** Present iff nothing was pruned. Names the cause in the operator's own vocabulary. */
  refusedBecause?: string;
  looseBefore: number;
  /** Present iff {@link ObjectReapDeps.streakPath} was supplied. The updated streak AFTER this
   *  call's own outcome is folded in. */
  consecutiveRefusals?: number;
  refusingSinceIso?: string;
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
 *
 * W1-T4022 never weakened any of the three conditions below to make the gate passable — that is
 * precisely the change the task exists to refuse (its own falsifier says so). What changed sits
 * entirely OUTSIDE this function: the DEFAULT open-file counter production actually wires (was a
 * fail-closed `() => 1` nothing ever replaced, so the third arm refused unconditionally) and the
 * DEFAULT policy load the rung reads (was `config.root`'s absent `plan/policy.yaml`, thrown and
 * silently swallowed, so the rung never reached this predicate at all). This predicate itself is
 * called TWICE per armed pass — once here, once more immediately before the destructive git call,
 * bracketing a quiesced window (see {@link reapGitObjects}) — never sampled less, never relaxed.
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

/** Read the streak at `path`. Absent or malformed reads as a fresh, zero streak — a corrupt or
 *  missing state file must never crash the rung; it just loses count, which is recoverable the
 *  next time the predicate refuses. */
export function readRefusalStreak(path: string): RefusalStreak {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<RefusalStreak>;
    if (typeof raw.consecutiveRefusals === "number" && Number.isFinite(raw.consecutiveRefusals)) {
      return {
        consecutiveRefusals: raw.consecutiveRefusals,
        refusingSinceIso: typeof raw.refusingSinceIso === "string" ? raw.refusingSinceIso : null,
      };
    }
  } catch {
    // absent, unreadable, or malformed — start a fresh streak rather than throwing out of a rung
  }
  return { consecutiveRefusals: 0, refusingSinceIso: null };
}

/** Best-effort write: a streak file this process cannot write costs an undercount next tick,
 *  never a blocked reap — this is telemetry, not the refusal decision itself. */
export function writeRefusalStreak(path: string, streak: RefusalStreak): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(streak));
  } catch {
    // best-effort — losing the streak file costs an undercount, never blocks the reap
  }
}

/**
 * Fold ONE outcome into the persisted consecutive-refusal streak: `refused` extends it (or starts
 * it, stamping `refusingSinceIso` with `nowIso` the first time), anything else resets it to zero.
 * So a refusal records how long the rung has been refusing: it persists consecutive refusals and
 * the moment the streak began, turning "refused once" and "has refused every tick for three
 * weeks" into two different, readable numbers instead of the same bare fact.
 */
export function recordRefusalStreak(path: string, refused: boolean, nowIso: string): RefusalStreak {
  const prior = readRefusalStreak(path);
  const next: RefusalStreak = refused
    ? { consecutiveRefusals: prior.consecutiveRefusals + 1, refusingSinceIso: prior.refusingSinceIso ?? nowIso }
    : { consecutiveRefusals: 0, refusingSinceIso: null };
  writeRefusalStreak(path, next);
  return next;
}

/** Merge a streak update into a result, if and only if the caller asked for one via
 *  {@link ObjectReapDeps.streakPath} — a caller with no interest in the streak gets back exactly
 *  the shape it always did. */
function withStreak(deps: ObjectReapDeps, refused: boolean, result: ObjectReapResult): ObjectReapResult {
  if (!deps.streakPath) return result;
  const nowIso = (deps.clock ?? systemClock).iso();
  const streak = recordRefusalStreak(deps.streakPath, refused, nowIso);
  return {
    ...result,
    consecutiveRefusals: streak.consecutiveRefusals,
    ...(streak.refusingSinceIso !== null ? { refusingSinceIso: streak.refusingSinceIso } : {}),
  };
}

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

/**
 * Reclaim unreachable objects, or refuse with a named cause.
 *
 * ORDER IS LOAD-BEARING: `.git/gc.log` is removed ONLY on a pass that is about to prune. Removing
 * it on a refused pass would re-arm git's UNSUPERVISED automatic cleanup, which is precisely what
 * the operator's standing rule exists to prevent — the opposite of this function's purpose.
 *
 * THE QUIESCED WINDOW (design (ii), W1-T4022). `objectReapRefusal` above is a single sample at
 * one instant; a working fleet registers a worktree or an inflight lock on ITS OWN cadence, not
 * this rung's, so trusting one sample for the whole operation is "hoping to observe a quiet
 * moment that a working host never offers". Rather than wait for a longer or more frequent
 * sample of the SAME kind, this CREATES the window instead: past the first check, immediately
 * before the one subprocess that deletes anything, the identical three-condition predicate is
 * re-run. Both ends must read quiet — the object that gets removed is the state AT the moment of
 * deletion, never a stale sample from moments earlier. Neither check is weaker than the other;
 * neither ever counts as a substitute for the other.
 */
export function reapGitObjects(
  repoDir: string,
  inflightDir: string,
  deps: ObjectReapDeps = {},
): ObjectReapResult {
  const looseBefore = (deps.looseObjectCount ?? defaultLooseObjectCount)(repoDir);
  if (looseBefore < LOOSE_OBJECT_FLOOR) {
    // Below the floor is "not worth a subprocess", a different condition from "the fleet is
    // busy" — it never touches the refusal streak (see recordRefusalStreak's own doc), so a run
    // of small-but-quiet ticks cannot masquerade as a long busy streak, or vice versa.
    return { pruned: 0, looseBefore, refusedBecause: `only ${looseBefore} loose object(s), below the ${LOOSE_OBJECT_FLOOR} floor` };
  }
  const refusal = objectReapRefusal(repoDir, inflightDir, deps);
  if (refusal !== undefined) return withStreak(deps, true, { pruned: 0, looseBefore, refusedBecause: refusal });

  // SURVEY: past every refusal above, so the disposition reported is the decision the armed path
  // would have made. Returns BEFORE gc.log is touched and before anything is spawned.
  if (deps.dryRun === true) {
    const count = deps.countPrunable ?? defaultCountPrunable;
    return withStreak(deps, false, {
      pruned: 0,
      wouldPrune: count(repoDir, ["prune", "-n", `--expire=${OBJECT_PRUNE_EXPIRY}`]),
      looseBefore,
    });
  }

  // THE SECOND END OF THE QUIESCED WINDOW — see this function's own doc comment above. Checked
  // BEFORE gc.log is touched: a refusal here must leave the auto-gc suppressor exactly where the
  // first refusal above would have left it.
  const windowRefusal = objectReapRefusal(repoDir, inflightDir, deps);
  if (windowRefusal !== undefined) {
    return withStreak(deps, true, {
      pruned: 0,
      looseBefore,
      refusedBecause: `quiesced window closed before the prune: ${windowRefusal}`,
    });
  }

  // Only now, with the prune committed to (both ends of the quiesced window read quiet), does the
  // auto-gc suppressor come off.
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
  return withStreak(deps, false, { pruned: Math.max(0, looseBefore - looseAfter), looseBefore });
}
