/**
 * BRANCH REAPER — the declared guard list (W1-T447), the branch-citation scan and the reverse-drift
 * planner, extracted verbatim from run-task.ts. A MOVE, NOT A REDESIGN: every declaration below is
 * byte-identical to the one it replaces and no signature changed.
 *
 * WHY THIS BOUNDARY AND NOT A LARGER ONE: `reapBranchesCommand` — the CLI verb these feed — stays in
 * run-task.ts deliberately. It calls `repoRoot`, `resolveOwnerRepo`, `unknownArgError` and
 * `commandSyntax`, which are declared in run-task.ts with 223, 60, 48 and 18 uses across the file.
 * Importing those here would make run-task.ts -> branch-reaper.ts -> run-task.ts a cycle; moving them
 * would drag the whole CLI plumbing layer along. This region references all four ZERO times, which is
 * the entire reason it is separable when its own caller is not.
 *
 * `remoteBranchNames`, `branchCitationPattern`, `parseBranchCitationHits` and `declaredGuardsBlockSpan`
 * were module-private and are exported here only because the file boundary now sits between them and
 * `reapBranchesCommand`. That widening is forced by the split, not a design change; `escapeEre` and
 * `RUN_TASK_BRANCH_TOKEN_SRC` have no caller outside this file and stay private.
 *
 * THIS MODULE IMPORTS NOTHING — not a node builtin, not another `src/lib` module. Every declaration
 * here is pure or takes its effects as an injected parameter: `remoteBranchNames` receives its `exec`,
 * `declaredGuardsBlockSpan` receives file TEXT rather than reading a path, and `planReverseBranchDrift`
 * is a pure function of the facts handed to it. That is not incidental tidiness — a module with no
 * imports cannot be one end of a cycle, which is what makes this the safe first region to move.
 */
/**
 * The declared guard list (W1-T447) — branches the fleet must never delete, DECLARED so the
 * decision is reviewable, alongside the name grep that derives the same answer independently.
 *
 * NEITHER SIGNAL IS SUFFICIENT ALONE, which is why both run. A declared list rots: it is a
 * convention that binds only while someone maintains it. A name grep cannot see a branch
 * referenced only through a VARIABLE — `LANDING_BRANCH` recreates `feedback-landing` on the next
 * `landFeedback`, and when no such branch exists there is nothing for a grep over branch names to
 * find. So the grep is the primary signal, this list is the reviewed one, and a branch the grep
 * guards that this list omits is REPORTED as drift rather than swept in silence.
 */
export const DECLARED_BRANCH_GUARDS: readonly string[] = [
  "main",
  // ── THE HEARTBEAT TRANSPORTS — ONE BRANCH PER HOST, each a parentless root commit force-pushed
  // every ~5 min. All three are named by `.github/workflows/fleet-heartbeat-watch.yml` and/or
  // `scripts/fleet-heartbeat.sh`, so `namedInSource` guards them and each OWES a declaration here.
  "heartbeat-mini", // the mini's, since its cron moved to RMD_HEARTBEAT_BRANCH=heartbeat-mini
  "heartbeat-azure", // Azure's — DECLARED LATE: #1798 added it to the watcher without declaring it
  // here, so `rmd reap-branches` exited 1 naming it. Measured on the live repo before this change:
  // "1 branch(es) are named in source but MISSING from DECLARED_BRANCH_GUARDS: heartbeat-azure".
  //
  // `heartbeat` STAYS, THOUGH NOTHING WRITES OR WATCHES IT ANY MORE. `namedInSource` is
  // `git grep -l -F` — a SUBSTRING match — and the string "heartbeat" occurs in 18 files under
  // src/, scripts/, deploy/ and .github/ (re-derived at this commit; an earlier note said 5, which
  // was an artifact of a `head -5` on the measuring command, not a count). So the grep guards it
  // permanently no matter what the workflow says, and REMOVING this line would manufacture exactly
  // the drift alarm the two entries above exist to clear.
  "heartbeat",
  "feedback-landing", // LANDING_BRANCH — recreated by landFeedback, often absent between landings
  "decisions-landing", // DECISIONS_LANDING_BRANCH
  // Cited by doc comments in drain-lock.ts, inflight-lock.ts, worker.ts and run-task.ts as the
  // forensic record behind those guards — deleting them dangles four citations. DECLARED after
  // the drift alarm below reported them on the live repo, which is the alarm working as intended.
  "diag/drain-concurrency",
  "diag/drain-sequential-await",
];

/** Every remote branch name, newest-agnostic — `git ls-remote --heads`, parsed. */
export function remoteBranchNames(exec: (cmd: string, args: string[]) => string): string[] {
  return exec("git", ["ls-remote", "--heads", "origin"])
    .split("\n")
    .map((l) => l.split("refs/heads/")[1])
    .filter((n): n is string => Boolean(n && n.trim()))
    .map((n) => n.trim());
}

/**
 * The ephemeral run-task branch convention: `run-<taskId>-<epochMs>`. A citation of this shape
 * can dangle long after the branch itself is deleted (W1-T2226 rationale (2)/(3)): the branch is
 * cited by a comment or doc example, the task lands and its branch is gone, and nothing edits the
 * citation to match. (Do not use a live run branch as the doc example here — the whole point of
 * this constant is that such an example outlives the branch it names.)
 */
const RUN_TASK_BRANCH_TOKEN_SRC = "run-[A-Za-z0-9]+-T[0-9]+-[0-9]{10,}";

/** Escape a literal string for use inside a POSIX ERE (`git grep -E`) alternation. */
function escapeEre(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * ONE ENUMERATION (W1-T2226 design (i)): a single pattern grep for every branch-shaped token —
 * the run-task convention above, plus every `DECLARED_BRANCH_GUARDS` name literally — across the
 * same four roots `namedInSource` already reads. Both reverse comparisons below are differences
 * over this one list; there is no second enumeration.
 */
export function branchCitationPattern(declaredGuards: readonly string[]): string {
  const alternation = [RUN_TASK_BRANCH_TOKEN_SRC, ...declaredGuards.map(escapeEre)].join("|");
  return `\\b(${alternation})\\b`;
}

/** One `git grep -n -o -E` hit: the file, its 1-indexed line, and the matched token. */
export interface BranchCitationHit {
  file: string;
  line: number;
  name: string;
}

/** Parse `git grep -n -o -E` output (`path:line:match`, one per line) into hits. */
export function parseBranchCitationHits(raw: string): BranchCitationHit[] {
  const hits: BranchCitationHit[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const m = /^([^:]+):(\d+):(.*)$/.exec(line);
    if (!m) continue;
    hits.push({ file: m[1], line: Number(m[2]), name: m[3] });
  }
  return hits;
}

/**
 * `DECLARED_BRANCH_GUARDS`'s own [start, end] line span (1-indexed, inclusive) inside
 * `src/run-task.ts`'s CURRENT text, found dynamically rather than hardcoded — W1-T2226
 * rationale (5): the declaration lives in a grepped root, so every declared name reads
 * `namedInSource: true` by virtue of its own declaration, and a reverse check that fails to
 * exclude this exact span can never report an orphan. Returns `undefined` if the marker moved or
 * the text doesn't contain it, in which case the caller excludes nothing rather than guessing.
 */
export function declaredGuardsBlockSpan(fileText: string): { start: number; end: number } | undefined {
  const lines = fileText.split("\n");
  const startIdx = lines.findIndex((l) => l.includes("export const DECLARED_BRANCH_GUARDS"));
  if (startIdx === -1) return undefined;
  for (let i = startIdx; i < lines.length; i++) {
    if (lines[i].trim() === "];") return { start: startIdx + 1, end: i + 1 };
  }
  return undefined;
}

/** The two reverse comparisons a forward-only `namedInSource` scan cannot make (W1-T2226). */
export interface ReverseBranchDrift {
  /** Cited in source, absent from the remote listing AND undeclared — dangling. */
  danglingCitations: string[];
  /** Declared, but never cited anywhere outside its own declaration — orphaned. */
  orphanDeclarations: string[];
}

/**
 * PURE: given the citation hits already gathered from source (with the declaration block's own
 * span so its self-citations can be excluded), the remote branch listing, and the declared list,
 * report both directions of drift a forward-only comparison misses.
 *
 * (a) = citations − remote − declared. Declared names are subtracted too, not only remote ones
 * (design (iii)): an ephemeral declared branch like `feedback-landing` is legitimately cited and
 * absent between landings (rationale (9)), so the declared set is the correct suppression list
 * for this arm as well as the forward one.
 *
 * (b) = declared − citations, with the declaration block's own citation of its own names excluded
 * first — rationale (5), the load-bearing half of this direction: without the exclusion every
 * declared name is trivially "cited" by its own entry and no orphan can ever be reported.
 */
export function planReverseBranchDrift(
  citations: readonly BranchCitationHit[],
  remoteNames: readonly string[],
  declaredGuards: readonly string[],
  declarationBlock: { file: string; start: number; end: number } | undefined,
): ReverseBranchDrift {
  const remote = new Set(remoteNames);
  const declared = new Set(declaredGuards);
  const cited = new Set<string>();
  for (const hit of citations) {
    if (
      declarationBlock &&
      hit.file === declarationBlock.file &&
      hit.line >= declarationBlock.start &&
      hit.line <= declarationBlock.end
    ) {
      continue; // the declaration's own line(s) never count as a citation of the name it declares
    }
    cited.add(hit.name);
  }
  const danglingCitations = [...cited].filter((n) => !remote.has(n) && !declared.has(n)).sort();
  const orphanDeclarations = declaredGuards.filter((n) => !cited.has(n));
  return { danglingCitations, orphanDeclarations };
}

/**
 * `rmd reap-branches` — the DRY RUN. Reports which remote branches WOULD be deletable, which are
 * guarded and why, and which are held; ledgers the answer; and DELETES NOTHING.
 *
 * IT DELETES NOTHING ON PURPOSE, and that is the deliverable rather than a staging step. Deletion
 * is irreversible from the fleet's side — restoring needs the sha — and this repo has four bounds
 * that fired on healthy conditions; a fifth that removed branches would be the worst of them. The
 * operator gets the one command that replaces a hand sweep, which is the actual goal, without the
 * fleet ever holding the delete.
 *
 * THE MANIFEST IS PRINTED, sha and name together, because that is the only thing that makes a
 * future deleting version reversible (`git push origin <sha>:refs/heads/<name>`). It goes to
 * STDOUT, never `state/` — that path is gitignored and is where 29 cited reports went to die.
 *
 * EXITS NON-ZERO ON DRIFT: a branch the name grep guards that `DECLARED_BRANCH_GUARDS` omits fails
 * the run rather than being reported in passing, the `ci-parity:drift` shape.
 */

// ── the orphaned-head COUNT (W1-T2690) ────────────────────────────────────────────────────────

/**
 * W1-T448 priced the REAP (~8 `gh api` `state=all` pages, 6.4s) and ruled — correctly, and this
 * does not re-litigate it — that wiring it into every sweep pass costs too much for an answer
 * that "only changes when a branch is created or merged." IT NEVER PRICED THE CHECK FOR WHETHER
 * IT IS TIME TO RUN THE MANUAL VERB. Measured 2026-09-02: `remoteBranchNames`'s own
 * `git ls-remote --heads origin` answers that in 670ms as ONE request, no `gh api` page at all.
 * The count below is that cheap question, kept deliberately separate from `planBranchReap`
 * (`lib/status.ts`): it counts, it classifies no guard, and it deletes nothing — same "reports
 * only" position as `reapBranchesCommand` two doc-comments up.
 *
 * ANCESTRY ALONE OVERCOUNTS AS "SAFE" HERE, which is why it is a conjunct and never the whole
 * test: `main` only squash-merges (measured: eight consecutive single-parent commits on it), so a
 * genuinely merged branch is never `main`'s ancestor either — `git merge-base --is-ancestor`
 * returns false for it exactly as it does for one still mid-flight. A head counts ORPHANED only
 * when BOTH hold: no open PR (an in-flight or just-closed-without-merge branch keeps its credit
 * path) AND absent from the base's history (the one thing ancestry legitimately answers: this
 * ref's commits were never folded in by a non-squash path, e.g. a fast-forward).
 */
export interface OrphanedHeadCounts {
  readonly kind: "counted";
  /** Every name one `git ls-remote --heads origin` returned — guards, non-run branches, all of it. */
  readonly totalHeads: number;
  /** The subset matching the `run-<taskId>-<epochMs>` dispatch shape — the only shape this counts
   *  as a candidate at all. `main`, the heartbeats and every other `DECLARED_BRANCH_GUARDS` entry
   *  are excluded by the shape test itself; there is no second lookup against that list here. */
  readonly runShapedHeads: number;
  /** Run-shaped heads with no open PR AND absent from the base's history — the number this task
   *  exists to make available; a manual verb with nothing bounding it is a decision that quietly
   *  stops being executed. */
  readonly orphanedHeads: number;
}

/** The one state a healthy-looking zero must never stand in for. An unreadable remote listing
 *  reports its own reason and stops — {@link classifyReadFailure} (`lib/doctor.ts`) draws the same
 *  line for the same reason: an absence of information is never counted as an absence of orphans. */
export interface OrphanedHeadCountUnreadable {
  readonly kind: "cannot-determine";
  readonly reason: string;
}

export type OrphanedHeadReading = OrphanedHeadCounts | OrphanedHeadCountUnreadable;

const RUN_TASK_BRANCH_TOKEN = new RegExp(`^${RUN_TASK_BRANCH_TOKEN_SRC}$`);

/**
 * PURE: given a remote listing already in hand, how many of its run-shaped heads are orphaned.
 * `openPrHeads` and `isInBaseHistory` are both injected — like every export in this file, this
 * performs no `exec` of its own — so a caller supplies `buildOpenPrViews`'s open heads and a
 * `git merge-base --is-ancestor` probe (or fixtures of either) without this module importing
 * either one.
 */
export function countOrphanedHeads(
  remoteNames: readonly string[],
  openPrHeads: ReadonlySet<string>,
  isInBaseHistory: (name: string) => boolean,
): OrphanedHeadCounts {
  const runShaped = remoteNames.filter((n) => RUN_TASK_BRANCH_TOKEN.test(n));
  const orphaned = runShaped.filter((n) => !openPrHeads.has(n) && !isInBaseHistory(n));
  return {
    kind: "counted",
    totalHeads: remoteNames.length,
    runShapedHeads: runShaped.length,
    orphanedHeads: orphaned.length,
  };
}

/**
 * The end-to-end read: one `git ls-remote --heads origin` (via {@link remoteBranchNames}) plus the
 * two injected predicates {@link countOrphanedHeads} takes. An `exec` failure — remote
 * unreachable, auth stale, whatever the cause — resolves to `cannot-determine`, NEVER to
 * `countOrphanedHeads([], ...)`'s healthy-looking zero: a manual verb with no signal is exactly
 * the failure mode this task exists to fix, and a silently-false zero would recreate it.
 */
export function readOrphanedHeadCount(
  exec: (cmd: string, args: string[]) => string,
  openPrHeads: ReadonlySet<string>,
  isInBaseHistory: (name: string) => boolean,
): OrphanedHeadReading {
  let remoteNames: string[];
  try {
    remoteNames = remoteBranchNames(exec);
  } catch (e) {
    return { kind: "cannot-determine", reason: e instanceof Error ? e.message : String(e) };
  }
  return countOrphanedHeads(remoteNames, openPrHeads, isInBaseHistory);
}


// ── the PRUNE (W1-T3020) ─────────────────────────────────────────────────────────────────────────

/** One deletable branch and the sha that makes its deletion reversible. */
export interface BranchManifestEntry {
  readonly name: string;
  /** `"unknown"` when `git rev-parse` could not resolve the ref — see {@link pruneDeletableBranches}. */
  readonly sha: string;
}

export interface BranchPruneOutcome {
  readonly deleted: readonly string[];
  /** Named and NOT attempted, each with the reason it was left alone. */
  readonly skipped: readonly { readonly name: string; readonly reason: string }[];
  /** A chunk whose push failed, carrying every name in it — those branches still exist. */
  readonly failed: readonly { readonly names: readonly string[]; readonly error: string }[];
}

/**
 * Delete the branches a {@link BranchManifestEntry} manifest names. THE EXECUTING HALF of
 * `reapBranchesCommand`, kept here for the same reason every other declaration in this module is:
 * it takes its one effect as an injected `exec`, so a test drives the real decision logic —
 * including a failing push — without touching a remote.
 *
 * IT DELETES ONLY WHAT IT IS GIVEN. Every guard, hold and undetermined decision was already made by
 * `planBranchReap` (`lib/status.ts`); this function re-derives none of it and cannot widen the set.
 * That split is deliberate: the classification is the reviewed part, and a deleter that also
 * classified could disagree with the dry run the operator just read.
 *
 * A `sha` OF `"unknown"` IS SKIPPED, NEVER DELETED. The manifest's whole purpose is that
 * `git push origin <sha>:refs/heads/<name>` restores what this removes; a ref whose sha would not
 * resolve has no such line, so deleting it would be the one irreversible case. The dry run already
 * prints `unknown` for a branch that vanished mid-run, and this is the same condition read as a
 * refusal rather than a cosmetic label.
 *
 * PUSHES IN CHUNKS, because one refspec git rejects fails the WHOLE push: a single 143-ref command
 * turns one stale ref into zero deletions, while a chunk confines that to its own group and the
 * outcome names the survivors. The default is deliberately modest for the same reason.
 */
export function pruneDeletableBranches(
  manifest: readonly BranchManifestEntry[],
  exec: (cmd: string, args: string[]) => string,
  opts: { readonly chunkSize?: number } = {},
): BranchPruneOutcome {
  const chunkSize = Math.max(1, opts.chunkSize ?? 25);
  const deleted: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const failed: { names: readonly string[]; error: string }[] = [];

  const deletable: BranchManifestEntry[] = [];
  for (const entry of manifest) {
    if (entry.sha === "unknown" || entry.sha === "") {
      skipped.push({ name: entry.name, reason: "sha unresolvable — deletion would not be reversible" });
      continue;
    }
    deletable.push(entry);
  }

  for (let i = 0; i < deletable.length; i += chunkSize) {
    const chunk = deletable.slice(i, i + chunkSize);
    try {
      exec("git", ["push", "origin", "--delete", ...chunk.map((e) => e.name)]);
      for (const e of chunk) deleted.push(e.name);
    } catch (err) {
      // The whole chunk survives: git applies a rejected push atomically per invocation, so naming
      // the group is the honest report — claiming any individual name deleted would be a guess.
      failed.push({ names: chunk.map((e) => e.name), error: String((err as Error)?.message ?? err) });
    }
  }

  return { deleted, skipped, failed };
}
