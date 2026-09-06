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
 * INVARIANT: a forward-referencing whole-file `unit test:` path is legitimate for a queued task
 * by construction; the identical shape on a task in `opts.creditedIds` IS checked (W1-T2280),
 * since a credited task has no forward left to reference.
 * INVARIANT: an absent injected predicate means "no opinion", never a false offense.
 * INVARIANT: a `grep-path-absent` candidate whose symbol is found at another declared path is
 * RELOCATED, not reported as absent — see {@link ProofQueueAuditReport.relocated}.
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

/** The three ways a proof that parses as executable can still never resolve, plus a fourth that
 *  only exists for the credited pass (W1-T2280) — see {@link CREDITED_PROOF_QUEUE_AUDIT_CAUSES}. */
export type ProofQueueAuditCause =
  | "refused-parse"
  | "name-filtered-zero-match"
  | "grep-path-absent"
  | "credited-test-path-absent";

/** Every cause this module knows how to name, in report order. Fixed at three entries: the
 *  default open+unmerged report must render byte-identically to before `credited-test-path-absent`
 *  existed (W1-T2280 note v). A credited-pass caller renders {@link CREDITED_PROOF_QUEUE_AUDIT_CAUSES}. */
export const PROOF_QUEUE_AUDIT_CAUSES: readonly ProofQueueAuditCause[] = [
  "refused-parse",
  "name-filtered-zero-match",
  "grep-path-absent",
];

/** All four causes, for a caller auditing the CREDITED population (W1-T2280) — never used by the
 *  default open+unmerged report. */
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
}

/** Does this `grep:` criterion's symbol occur at some OTHER path the task itself declared in
 *  `files:`? Reuses {@link proofGrepTargets} (lib/status.ts) rather than re-deriving `task.files`
 *  filtering by hand. Returns the first declared path (other than `excludePath`) the predicate
 *  confirms, or `undefined` when none does. */
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

/**
 * Resolve every criterion's proof in `tasks` through the reviewer's own parser and (when
 * supplied) resolver, and report every one that can never resolve for anyone — never a
 * forward reference, which stays legitimate by construction (see the module doc). Pure: the
 * only I/O this function performs is through the two injected predicates above.
 */
export function proofQueueAudit(tasks: readonly Task[], opts: ProofQueueAuditOpts = {}): ProofQueueAuditReport {
  const offenders: ProofQueueAuditOffender[] = [];
  const relocated: ProofQueueAuditOffender[] = [];
  let criterionCount = 0;
  for (const task of tasks) {
    const credited = opts.creditedIds?.has(task.id) ?? false;
    (task.acceptance ?? []).forEach((c, criterionIndex) => {
      if (c.satisfied_by) return; // Architect-only; no proof text to resolve
      const proof = c.proof ?? "";
      criterionCount++;
      const trimmed = proof.trim();
      const whitelisted = parseWhitelistedProof(proof);
      const claim = c.claim ?? "";

      if (!whitelisted) {
        // A dialect-prefixed proof that still fails to parse is refused-parse; free prose never
        // promised execution and is proof-dialect's shape check to own, not this module's.
        // `demonstration:` is excluded — a legitimate, on-the-record non-execution (W1-T277).
        if (isDialectPrefixed(trimmed) && !isDemonstrationProof(trimmed)) {
          offenders.push({ taskId: task.id, criterionIndex, cause: "refused-parse", claim, proof });
        }
        return;
      }

      if (whitelisted.kind === "test") {
        // A literal path (nameFiltered unset) is the forward-reference shape — legitimate for a
        // queued task's not-yet-written test. Checked only when the task is credited (W1-T2280),
        // since a credited task has no forward left to reference.
        if (!whitelisted.nameFiltered) {
          if (credited && opts.pathExists && !opts.pathExists(whitelisted.label)) {
            offenders.push({ taskId: task.id, criterionIndex, cause: "credited-test-path-absent", claim, proof });
          }
          return;
        }
        if (!opts.resolveNameFilteredCandidates) return; // no predicate, no opinion
        const resolution = opts.resolveNameFilteredCandidates(whitelisted.label);
        // Only `absent` is positive evidence of a title matching nothing; `unresolvable` means
        // the lookup itself could not be trusted and is never read as an offense.
        if (resolution.status === "absent") {
          offenders.push({ taskId: task.id, criterionIndex, cause: "name-filtered-zero-match", claim, proof });
        }
        return;
      }

      // kind === "grep": args = [flags, "--", pattern, path] (parseDialectGrep, lib/review.ts).
      if (!opts.pathExists) return; // no predicate, no opinion
      const path = whitelisted.args[1] === "--" ? whitelisted.args[3] : undefined;
      const pattern = whitelisted.args[1] === "--" ? whitelisted.args[2] : undefined;
      if (path === undefined || opts.pathExists(path)) return;
      const relocatedTo =
        opts.symbolFoundAt && pattern !== undefined
          ? findRelocatedPath(task, pattern, path, opts.symbolFoundAt)
          : undefined;
      const offender: ProofQueueAuditOffender = { taskId: task.id, criterionIndex, cause: "grep-path-absent", claim, proof };
      if (relocatedTo !== undefined) {
        relocated.push({ ...offender, relocatedTo });
      } else {
        offenders.push(offender);
      }
    });
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
  return { taskCount: tasks.length, criterionCount, offenders, byCause, relocated };
}

/** One credited task's shard-file coverage fact, as the caller (run-task.ts) resolved it —
 *  never derived here (this module stays pure). See {@link creditedAmendmentVisibility}. */
export interface CreditedAmendmentFact {
  taskId: string;
  /** The repo-relative `plan/tasks.d/<id>-<slug>.yaml` this credited task's record lives in, or
   *  `undefined` when declared inline in the `plan/tasks.yaml` monolith — this signal is blind to
   *  those (W1-T2280 note ix). */
  shardPath: string | undefined;
}

export interface CreditedAmendmentReport {
  /** Credited tasks whose own shard file this signal COULD read. */
  measurable: number;
  /** Credited tasks declared inline in the monolith — blind to these by construction (note ix);
   *  printed alongside `measurable` so the coverage gap is visible rather than implied. */
  unmeasurable: number;
  /** Task ids amended after their own earliest merge credit with no follow-up shard filed in
   *  that same commit (W1-T2280 rationale (11)/(12)). Does not classify intent (note viii); it
   *  only reports "changed after credit, nothing filed alongside". */
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
