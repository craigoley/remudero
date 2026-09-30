/**
 * Resolves the QUEUE's proofs against the filesystem: a `status: queued` task whose `unit
 * test:`/`grep:` proof resolves to zero real tests was previously indistinguishable from one
 * that will pass at review (W1-T229 sat 13 days that way). Calls the reviewer's own
 * {@link parseWhitelistedProof}/{@link resolveNameFilteredCandidates} (review.ts) directly, so
 * this can never disagree with what actually executes.
 *
 * INVARIANT: a report, never a gate — {@link proofQueueAudit} always returns and never throws,
 * and every caller (`rmd proof-queue-audit`, the adoption-debt minter, measurement-cadence.ts)
 * exits/reads 0 regardless of offender count. A ratchet over this report is separate, ratified
 * work, never smuggled in here.
 * INVARIANT: a forward reference is legitimate for a queued task in BOTH proof shapes — whole-file
 * path always, name-filtered title when `zeroMatchTitleIsReportable` calls it diagnostic (W1-T3513);
 * on a task in `opts.creditedIds` both ARE checked, unnarrowed — no forward is left (W1-T2280).
 * INVARIANT: an absent injected predicate means "no opinion", never a false offense.
 * INVARIANT: a `grep-path-absent` candidate whose symbol is found at another declared path is
 * RELOCATED, not reported as absent — see {@link ProofQueueAuditReport.relocated}.
 * INVARIANT: {@link ProofQueueAuditReport.resolvedFully} is where to LOOK, never a verdict: an open task with
 * at least one executable proof, all of which resolve here. Prose, `demonstration:`, `verify: human` and
 * retired tasks never appear. A task made moot by a refactor is invisible: its proof file never existed.
 * FALSIFIER: test/proof-queue-audit.test.ts, test/credited-task-proof-visibility.test.ts.
 */
// Why: full design history and the W1-T229/W1-T2280/W1-T2477 incidents — docs/forensics/proof-queue-audit.md#module-header.

import type { Task } from "./plan.js";
import {
  isDemonstrationProof,
  isDialectPrefixed,
  parseWhitelistedProof,
  type NameFilterResolution,
} from "./review.js";
import { proofGrepTargets } from "./status.js";
import { zeroMatchTitleIsReportable } from "./task-linter.js";

/** The three ways a proof that parses as executable can still never resolve, plus a fourth that
 *  only exists for the credited pass (W1-T2280) — see {@link CREDITED_PROOF_QUEUE_AUDIT_CAUSES}. */
export type ProofQueueAuditCause =
  | "refused-parse"
  | "name-filtered-zero-match"
  | "grep-path-absent"
  | "credited-test-path-absent";

/** Every cause the default report renders, in order. Three entries so it stays byte-identical to before
 *  `credited-test-path-absent` existed (W1-T2280 note v); the credited pass renders the four-entry list. */
export const PROOF_QUEUE_AUDIT_CAUSES: readonly ProofQueueAuditCause[] = [
  "refused-parse",
  "name-filtered-zero-match",
  "grep-path-absent",
];

/** All four causes, for the CREDITED population only (W1-T2280). */
export const CREDITED_PROOF_QUEUE_AUDIT_CAUSES: readonly ProofQueueAuditCause[] = [
  ...PROOF_QUEUE_AUDIT_CAUSES,
  "credited-test-path-absent",
];

/** One criterion whose proof cannot resolve against the filesystem, and why. */
export interface ProofQueueAuditOffender {
  taskId: string;
  /** 0-based index into `task.acceptance` — the criterion this proof belongs to. */
  criterionIndex: number;
  cause: ProofQueueAuditCause;
  claim: string;
  proof: string;
  /** Set only on a row moved into {@link ProofQueueAuditReport.relocated}: the repo-relative
   *  path, among this task's own declared `files:`, where the symbol was found instead (W1-T2280). */
  relocatedTo?: string;
}

export interface ProofQueueAuditReport {
  /** How many tasks {@link proofQueueAudit} was asked to check (the caller's population). */
  taskCount: number;
  /** How many non-`satisfied_by` criteria were examined across that population. */
  criterionCount: number;
  /** Every offender found, in encounter order — may name the same task more than once (one row
   *  per offending criterion). Never includes a row moved to {@link relocated}. */
  offenders: ProofQueueAuditOffender[];
  /** `offenders` split by cause, task ids DEDUPED and in first-seen order — a task with two
   *  zero-match criteria appears once in `["name-filtered-zero-match"]`, not twice. */
  byCause: Record<ProofQueueAuditCause, string[]>;
  // Why: the measured false-positive rate that motivated relocation over absence — docs/forensics/proof-queue-audit.md#proofqueueauditreportrelocated.
  /** A `grep-path-absent` candidate whose symbol was found at another path this task itself
   *  declared, so it lives here instead of `offenders`/`byCause` — never both (W1-T2280 note vii). */
  relocated: ProofQueueAuditOffender[];
  /** Open task ids whose executable proofs ALL resolve here: probably already built, not proven. */
  resolvedFully?: string[];
  /** `resolvedFully` with a merge credit: the reconcile lane has not flipped it, or a filing-shaped subject blocks it.
   *  Set only when `opts.creditedIds` is supplied. */
  resolvedFullyCredited?: string[];
  /** `resolvedFully` with NO merge credit: built by other means, or a proof that does not discriminate. */
  resolvedFullyUncredited?: string[];
}

export interface ProofQueueAuditOpts {
  /** The reviewer's own `resolveNameFilteredCandidates` (lib/review.ts), bound to a real
   *  checkout by the caller. Absent ⇒ `name-filtered-zero-match` is never reported. */
  resolveNameFilteredCandidates?: (rawName: string) => NameFilterResolution;
  /** Does a repo-relative path exist in the checkout the caller bound this to? Absent ⇒
   *  `grep-path-absent` (and `credited-test-path-absent`) is never reported. Mirrors
   *  `LintOpts.moduleExists` (lib/task-linter.ts) — same "no predicate, no opinion" contract. */
  pathExists?: (repoRelPath: string) => boolean;
  /** The merge-credited task ids (W1-T2280), read by the caller via `readMergeCreditedTaskIds`/
   *  `isMergeCreditLine` (lib/status.ts). Absent ⇒ no task is ever treated as credited. */
  creditedIds?: ReadonlySet<string>;
  /** Does `symbol` occur in `path`'s real file contents, in the checkout the caller bound this
   *  to? Injected so this module stays pure (no fs, no exec). Absent ⇒ a `grep-path-absent`
   *  candidate is never checked for relocation and is reported as plain absence. */
  symbolFoundAt?: (symbol: string, path: string) => boolean;
  /** Does the basic-regex `pattern` match a line of `path` at the checkout? `false` covers no match AND an
   *  unreadable file: either way the task is not named. Absent ⇒ no `grep:` proof counts as resolved. */
  grepMatches?: (pattern: string, path: string) => boolean;
}

const SETTLED_STATUSES = new Set<Task["status"]>(["blocked", "merged", "done"]);

/** The first path, other than `excludePath`, among this task's own `files:` where the predicate finds
 *  the `grep:` symbol ({@link proofGrepTargets}, lib/status.ts), or `undefined`. */
function findRelocatedPath(
  task: Task,
  symbol: string,
  excludePath: string,
  symbolFoundAt: (symbol: string, path: string) => boolean,
): string | undefined {
  for (const target of proofGrepTargets(task)) {
    if (target.symbol !== symbol || target.path === excludePath) continue;
    if (symbolFoundAt(target.symbol, target.path)) return target.path;
  }
  return undefined;
}

/** Calls an injected predicate; a throw is ignorance (`undefined`), never an offense or a resolution. */
function ask<A extends unknown[], R>(f: ((...a: A) => R) | undefined, ...a: A): R | undefined {
  try {
    return f?.(...a);
  } catch {
    // A throw and "no opinion" coincide for every reader here: neither offends nor resolves.
    return undefined;
  }
}

/** Reports every proof in `tasks` that can never resolve (never a forward reference, see the module
 *  doc) and names the open tasks whose executable proofs all resolve. Pure; a throwing predicate is ignorance. */
export function proofQueueAudit(tasks: readonly Task[], opts: ProofQueueAuditOpts = {}): ProofQueueAuditReport {
  const offenders: ProofQueueAuditOffender[] = [];
  const relocated: ProofQueueAuditOffender[] = [];
  const resolvedFully: string[] = [];
  let criterionCount = 0;
  for (const task of tasks) {
    const credited = opts.creditedIds?.has(task.id) ?? false;
    let executable = 0;
    let resolved = 0;
    (task.acceptance ?? []).forEach((c, criterionIndex) => {
      if (c.satisfied_by) return; // Architect-only; no proof text to resolve
      const proof = c.proof ?? "";
      criterionCount++;
      const trimmed = proof.trim();
      const whitelisted = parseWhitelistedProof(proof);
      const claim = c.claim ?? "";

      if (!whitelisted) {
        // Dialect-prefixed but unparseable is refused-parse; free prose is proof-dialect's to own.
        // `demonstration:` is a legitimate, on-the-record non-execution (W1-T277).
        if (isDialectPrefixed(trimmed) && !isDemonstrationProof(trimmed)) {
          executable++;
          offenders.push({ taskId: task.id, criterionIndex, cause: "refused-parse", claim, proof });
        }
        return;
      }
      executable++;

      if (whitelisted.kind === "test") {
        // A literal path is the forward-reference shape; only a credited task has no forward left (W1-T2280).
        if (!whitelisted.nameFiltered) {
          const exists = ask(opts.pathExists, whitelisted.label);
          if (exists) resolved++;
          if (credited && exists === false) {
            offenders.push({ taskId: task.id, criterionIndex, cause: "credited-test-path-absent", claim, proof });
          }
          return;
        }
        const resolution = ask(opts.resolveNameFilteredCandidates, whitelisted.label); // no predicate, no opinion
        if (!resolution) return;
        if (resolution.status === "resolved") resolved++;
        // Only `absent` is evidence of a title matching nothing; `unresolvable` is never an offense.
        if (resolution.status === "absent" && (credited || zeroMatchTitleIsReportable(whitelisted.label))) {
          offenders.push({ taskId: task.id, criterionIndex, cause: "name-filtered-zero-match", claim, proof });
        }
        return;
      }

      // kind === "grep": args = [flags, "--", pattern, path] (parseDialectGrep, lib/review.ts).
      const path = whitelisted.args[1] === "--" ? whitelisted.args[3] : undefined;
      const pattern = whitelisted.args[1] === "--" ? whitelisted.args[2] : undefined;
      if (path === undefined) return;
      const exists = ask(opts.pathExists, path);
      if (exists !== false) {
        // A plan record quoting its own proof would match itself; a fenced grep carries its own flags.
        const own = path.startsWith("plan/") || whitelisted.authorSelectedArgv === true;
        if (exists && !own && pattern !== undefined && ask(opts.grepMatches, pattern, path)) resolved++;
        return;
      }
      const relocatedTo =
        opts.symbolFoundAt && pattern !== undefined
          ? findRelocatedPath(task, pattern, path, (sym, at) => ask(opts.symbolFoundAt, sym, at) === true)
          : undefined;
      const offender: ProofQueueAuditOffender = { taskId: task.id, criterionIndex, cause: "grep-path-absent", claim, proof };
      if (relocatedTo !== undefined) {
        relocated.push({ ...offender, relocatedTo });
      } else {
        offenders.push(offender);
      }
    });
    const open = !SETTLED_STATUSES.has(task.status) && task.verify !== "human" && !task.retirement;
    if (open && executable > 0 && resolved === executable) resolvedFully.push(task.id);
  }

  const byCause: Record<ProofQueueAuditCause, string[]> = {
    "refused-parse": [],
    "name-filtered-zero-match": [],
    "grep-path-absent": [],
    "credited-test-path-absent": [],
  };
  for (const o of offenders) {
    if (!byCause[o.cause].includes(o.taskId)) byCause[o.cause].push(o.taskId);
  }
  const report: ProofQueueAuditReport = { taskCount: tasks.length, criterionCount, offenders, byCause, relocated, resolvedFully };
  const creditedIds = opts.creditedIds;
  if (creditedIds) {
    report.resolvedFullyCredited = resolvedFully.filter((id) => creditedIds.has(id));
    report.resolvedFullyUncredited = resolvedFully.filter((id) => !creditedIds.has(id));
  }
  return report;
}

/** One credited task's shard-file coverage fact, as the caller (run-task.ts) resolved it —
 *  never derived here (this module stays pure). See {@link creditedAmendmentVisibility}. */
export interface CreditedAmendmentFact {
  taskId: string;
  /** This task's `plan/tasks.d/<id>-<slug>.yaml`, or `undefined` when inline in the monolith,
   *  which this signal cannot see (W1-T2280 note ix). */
  shardPath: string | undefined;
}

export interface CreditedAmendmentReport {
  /** Credited tasks whose own shard file this signal COULD read. */
  measurable: number;
  /** Credited tasks inline in the monolith, unreadable by construction (note ix); printed beside `measurable`. */
  unmeasurable: number;
  /** Task ids amended after their earliest merge credit with no follow-up shard in that commit
   *  (W1-T2280 rationale (11)/(12)); intent is not classified (note viii). */
  flagged: string[];
}

// Why: the Standing rule 21 gate-gap this report closes, in full — docs/forensics/proof-queue-audit.md#creditedamendmentvisibility.
/**
 * Names a credited task whose own shard was touched by a commit after its earliest merge
 * credit, with no new `plan/tasks.d/*.yaml` shard added in that same commit (W1-T2280) —
 * Standing rule 21's post-merge-amendment gate only fires at PR-review time on the amending PR
 * itself, so a later rationale-only amendment lands invisibly otherwise. A report, not a gate,
 * same posture as {@link proofQueueAudit}: no `status:` moves, nothing re-queues.
 *
 * PURE: all git/ledger I/O is the caller's, through `opts.amendedSinceCredit`.
 */
export function creditedAmendmentVisibility(
  facts: readonly CreditedAmendmentFact[],
  opts: {
    /** Was `shardPath` touched by a commit strictly after this task's earliest merge-credit
     *  timestamp, with that same commit also adding a brand-new shard? `undefined` ⇒ the
     *  evidence could not be read — fail open, never a false flag. */
    amendedSinceCredit: (taskId: string, shardPath: string) => { amended: boolean; followUpFiled: boolean } | undefined;
  },
): CreditedAmendmentReport {
  let measurable = 0;
  let unmeasurable = 0;
  const flagged: string[] = [];
  for (const f of facts) {
    if (f.shardPath === undefined) {
      unmeasurable++;
      continue;
    }
    measurable++;
    const evidence = opts.amendedSinceCredit(f.taskId, f.shardPath);
    if (!evidence) continue; // evidence unavailable — fail open, never a guess
    if (evidence.amended && !evidence.followUpFiled) flagged.push(f.taskId);
  }
  return { measurable, unmeasurable, flagged };
}
