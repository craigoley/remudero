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

