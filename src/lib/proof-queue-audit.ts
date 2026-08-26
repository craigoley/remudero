/**
 * lib/proof-queue-audit.ts — W1-T1053.
 *
 * THE DEFECT THIS CLOSES. Nothing resolved the QUEUE's proofs against the filesystem: a task
 * sitting `status: queued` whose `unit test:`/`grep:` proof resolves to ZERO real tests is
 * indistinguishable, by any existing instrument, from one that will pass at review time.
 * W1-T229 sat 13 days that way (`unit test: case added to test/review.test.ts`, a name-filtered
 * title that never matched, per `rmd check-proof`: "parse: OK - kind=test (name-filtered),
 * candidates: absent, verdict: no-match") and was caught only by a human reading it by hand.
 *
 * WHAT ALREADY EXISTS AND WHY IT DOES NOT COVER THIS. `proofNameResolutionViolations`
 * (lib/task-linter.ts, W1-T488) calls the reviewer's OWN `resolveNameFilteredCandidates` and
 * warns on exactly this shape — but it is NARROWED to a high-precision subset (a title carrying
 * a regex metacharacter, not a scenario narrative) to keep `rmd lint-plan`'s WARN stream legible,
 * and it has NO caller supplying `opts.resolveNameFilteredCandidates` in production, so it never
 * runs at all. `proofDialectViolations`/`proofResolvabilityViolations` (the same file, W1-T369's
 * `PROOF_DEBT_CEILING` population) are SHAPE checks only — a proof that PARSES cleanly, like
 * W1-T229's, reads zero violations from either. This module is the missing THIRD check: does a
 * proof that parses as executable actually RESOLVE to something, against the real checkout —
 * over the WHOLE open+unmerged queue, unnarrowed, every offender named.
 *
 * IT IS A REPORT, NOT A GATE, and that is the load-bearing half, not a hedge — the same posture
 * lib/emissions.ts and lib/host-parity.ts already document for their own instruments. No caller
 * may read this module's return value as a pass/fail signal: {@link proofQueueAudit} always
 * returns a report, never throws on what it finds, and `proofQueueAuditCommand` (src/run-task.ts)
 * always exits 0 regardless of how many offenders it names. Gating today would stop the queue
 * outright against a standing population of pre-existing violations (measured at nineteen,
 * W1-T497's recon), and a gate that produces even one false positive gets deleted within a week.
 * If the count is later driven toward a floor, a ratchet over THIS report is a separate, ratified
 * filing (the shape W1-T369 already established for proof-dialect/proof-resolvability) — never
 * smuggled in here.
 *
 * THREE CAUSES, so a class of offender is batchable rather than lost in one undifferentiated
 * number (the split W1-T305 already applies at review time, run one dispatch earlier here):
 *   - `refused-parse`            — the proof DECLARES an executable dialect (`grep:`/`unit
 *                                  test:`) but {@link parseWhitelistedProof} still refuses it
 *                                  (e.g. a `grep:` proof with no `in <path>` clause). Excludes
 *                                  `demonstration:`, which is a legitimate, on-the-record
 *                                  non-execution (W1-T277), never a defect.
 *   - `name-filtered-zero-match` — a `unit test: <title>` proof, name-filtered (not a literal
 *                                  path), whose title matches ZERO real tests today
 *                                  ({@link resolveNameFilteredCandidates} answers `absent`) —
 *                                  W1-T229's exact shape.
 *   - `grep-path-absent`         — a `grep: <pattern> in <path>` proof whose `<path>` does not
 *                                  exist in the checkout.
 *
 * A FORWARD REFERENCE STAYS LEGITIMATE FOR A QUEUED TASK — the one way this report can be wrong
 * enough to be deleted, and the one shape it is built to never touch FOR THAT POPULATION. A
 * whole-file `unit test: test/foo.test.ts` proof for an unimplemented task's not-yet-written test
 * is a normal, sanctioned authoring pattern (CLAUDE.md): `parseWhitelistedProof` compiles it as
 * `kind: "test"` with `nameFiltered` unset, so it never reaches {@link resolveNameFilteredCandidates}
 * at all. W1-T2280 MADE THIS CONDITIONAL, NOT DELETED (note vi): a task in `opts.creditedIds` has
 * already been credited merged, so the identical shape has no forward left to reference — its
 * absence is now the fourth cause, `credited-test-path-absent`, checked against `opts.pathExists`
 * the same way `grep-path-absent` already is. `opts.creditedIds` absent ⇒ this stays exactly the
 * unconditional exemption it always was.
 *
 * RELOCATION, SEPARATE FROM ABSENCE (W1-T2280 note vii). A `grep-path-absent` candidate whose
 * symbol is found at ANOTHER path the same task declared in `files:` (via `opts.symbolFoundAt`,
 * paired by {@link proofGrepTargets}, lib/status.ts) is MOVED into {@link
 * ProofQueueAuditReport.relocated} instead of `offenders`/`byCause` — never both. A signal that
 * cannot tell "the symbol is gone" from "the symbol moved file" measured an 80%+ false-positive
 * rate on the one population that motivated this (four of five `grep-zero` candidates were
 * relocations), and an instrument that noisy gets ignored, which reads identically to absent.
 *
 * THE REVIEWER'S OWN PARSER AND RESOLVER, CALLED DIRECTLY (never re-implemented):
 * {@link parseWhitelistedProof} and {@link resolveNameFilteredCandidates} (both lib/review.ts) —
 * the SAME functions `execWhitelistedProof` calls before ever spawning a real check. This report
 * can never disagree with what actually executes about what a proof's raw text resolves to.
 *
 * INJECTED, LIKE `opts.moduleExists` (lib/task-linter.ts): both `opts.resolveNameFilteredCandidates`
 * and `opts.pathExists` shell out / touch the real filesystem, so this module itself stays PURE —
 * no fs, no exec — and reads no disk on its own. Absent either predicate, the cause it would
 * answer is silently never reported ("no predicate ⇒ no opinion", the same contract
 * `callSiteViolations` (lib/task-linter.ts) already keeps for its own `opts.moduleExists`.
 * `proofQueueAuditCommand` (src/run-task.ts) is the one caller that supplies both, bound to a
 * real checkout — see that function for the ~207ms/proof cost this incurs (W1-T497's own
 * measurement of the identical resolver), which is why this stays an on-demand local verb and
 * goes nowhere near the PR path.
 *
 * SCOPE. `proofQueueAudit` takes whatever task population its caller hands it — it has no opinion
 * on "open" or "unmerged" itself (that line is `classifyFailingMergeEvidence` +
 * `defaultMergeEvidenceLog`, src/run-task.ts, the SAME offline no-network readers
 * `rmd lint-plan`'s whole-plan split and `test/plan-proof-debt.test.ts`'s
 * `deriveProofDebtPopulation` already use — never re-derived by hand here). The production caller
 * scopes to open, unmerged tasks; a test can hand it anything.
 */

import type { Task } from "./plan.js";
import {
  isDemonstrationProof,
  isDialectPrefixed,
  parseWhitelistedProof,
  type NameFilterResolution,
} from "./review.js";
import { proofGrepTargets } from "./status.js";

/**
 * The three ways a proof that PARSES/PROMISES executability can still never resolve against the
 * real checkout, plus a FOURTH that only exists for the CREDITED pass (W1-T2280): a whole-file
 * `unit test:` path is a legitimate forward reference for a QUEUED task (the test is not written
 * yet), but the same shape on a CREDITED task has no forward left to reference — its work is
 * already declared done. See the module doc above for what each of the first three names.
 */
export type ProofQueueAuditCause =
  | "refused-parse"
  | "name-filtered-zero-match"
  | "grep-path-absent"
  | "credited-test-path-absent";

/** Every cause this module knows how to name, in report order. UNCHANGED at three entries
 *  (W1-T2280 note v): the default open+unmerged report must render byte-identically to before,
 *  so `credited-test-path-absent` — reachable only via `opts.creditedIds` — is intentionally
 *  absent here. A credited-pass caller renders {@link CREDITED_PROOF_QUEUE_AUDIT_CAUSES} instead. */
export const PROOF_QUEUE_AUDIT_CAUSES: readonly ProofQueueAuditCause[] = [
  "refused-parse",
  "name-filtered-zero-match",
  "grep-path-absent",
];

/** All four causes, for a caller auditing the CREDITED population (W1-T2280) — never used by the
 *  default open+unmerged report (see {@link PROOF_QUEUE_AUDIT_CAUSES}'s own doc for why). */
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
  /**
   * W1-T2280: set ONLY on a row moved into {@link ProofQueueAuditReport.relocated} — the repo-
   * relative path, among this task's OWN declared `files:`, where `opts.symbolFoundAt` found the
   * same symbol the absent path's proof named. Absent on every row still living in `offenders`.
   */
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
  /**
   * W1-T2280 note (vii): a `grep-path-absent` candidate whose symbol was found at ANOTHER path
   * this task itself declared (via `opts.symbolFoundAt`, paired by {@link proofGrepTargets}) is
   * RELOCATED, not absent, and lives here instead of in `offenders`/`byCause` — a signal that
   * cannot separate "gone" from "moved" was measured at an 80%+ false-positive rate on the one
   * population it had and would be ignored, which is the same as reporting nothing.
   */
  relocated: ProofQueueAuditOffender[];
}

export interface ProofQueueAuditOpts {
  /** The reviewer's OWN `resolveNameFilteredCandidates` (lib/review.ts), bound to a real
   *  checkout by the caller — see the module doc's "INJECTED" paragraph. Absent ⇒
   *  `name-filtered-zero-match` is never reported. */
  resolveNameFilteredCandidates?: (rawName: string) => NameFilterResolution;
  /** Does a repo-relative path exist in the checkout the caller bound this to? Absent ⇒
   *  `grep-path-absent` (and `credited-test-path-absent`) is never reported. Mirrors
   *  `LintOpts.moduleExists` (lib/task-linter.ts) — same "no predicate, no opinion" contract. */
  pathExists?: (repoRelPath: string) => boolean;
  /**
   * W1-T2280: the merge-credited task ids, read by the caller through the SAME reader the
   * dispatcher already trusts (`readMergeCreditedTaskIds`/`isMergeCreditLine`, lib/status.ts —
   * never a second hand-copy of what a merge credit looks like, note x). Absent ⇒ today's
   * behaviour, byte-identical: no task is ever treated as credited.
   */
  creditedIds?: ReadonlySet<string>;
  /**
   * Does `symbol` occur in `path`'s real file contents, in the checkout the caller bound this
   * to? Injected so this module stays pure (no fs, no exec) — see the module doc's "INJECTED"
   * paragraph. Absent ⇒ a `grep-path-absent` candidate is never checked for relocation and is
   * reported as plain absence, the conservative default.
   */
  symbolFoundAt?: (symbol: string, path: string) => boolean;
}

/**
 * Does this `grep:` criterion's symbol occur at some OTHER path the task itself declared in
 * `files:`? Reuses {@link proofGrepTargets} (lib/status.ts) — the pairing primitive W1-T506
 * already built for exactly this "symbol paired with every declared path" shape (W1-T2280
 * rationale (14): built, and until now unused outside its own test file) — rather than
 * re-deriving `task.files` filtering by hand. Returns the first declared path (other than
 * `excludePath`) the predicate confirms, or `undefined` when none does (including when the
 * predicate is absent, per the "no predicate, no opinion" contract on the caller's opts).
 */
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
        // refused-parse: the proof DECLARED an executable dialect and parseWhitelistedProof
        // still refused it. A proof carrying no dialect prefix at all (free prose) never
        // promised execution and is out of scope for this module — proof-dialect
        // (lib/task-linter.ts) already owns that shape check. `demonstration:` is excluded:
        // it is a legitimate, on-the-record non-execution (W1-T277), never a defect.
        if (isDialectPrefixed(trimmed) && !isDemonstrationProof(trimmed)) {
          offenders.push({ taskId: task.id, criterionIndex, cause: "refused-parse", claim, proof });
        }
        return;
      }

      if (whitelisted.kind === "test") {
        // A literal test-file PATH (nameFiltered unset) is the forward-reference shape — a
        // legitimate proof for a QUEUED task's test not yet written (CLAUDE.md), never reported
        // by construction. W1-T2280 note (vi): the exemption is CONDITIONAL, not deleted — a
        // CREDITED task's identical shape has no forward left to reference, so it IS checked.
        if (!whitelisted.nameFiltered) {
          if (credited && opts.pathExists && !opts.pathExists(whitelisted.label)) {
            offenders.push({ taskId: task.id, criterionIndex, cause: "credited-test-path-absent", claim, proof });
          }
          return;
        }
        if (!opts.resolveNameFilteredCandidates) return; // no predicate, no opinion
        const resolution = opts.resolveNameFilteredCandidates(whitelisted.label);
        // Only `absent` is POSITIVE evidence of a title matching nothing (see
        // NameFilterResolution's own doc, lib/review.ts) — `unresolvable` means the lookup
        // itself could not be trusted and is never read as an offense.
        if (resolution.status === "absent") {
          offenders.push({ taskId: task.id, criterionIndex, cause: "name-filtered-zero-match", claim, proof });
        }
        return;
      }

      // kind === "grep": args = [flags, "--", pattern, path] (parseDialectGrep, lib/review.ts —
      // the same shape test/plan-proof-debt.test.ts's proofResolvesToCandidate reads).
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
   *  `undefined` when it is declared inline in the `plan/tasks.yaml` monolith instead — the
   *  amendment signal has no per-file history to read for those (W1-T2280 note ix: MEASURED and
   *  printed, never silently dropped). */
  shardPath: string | undefined;
}

export interface CreditedAmendmentReport {
  /** Credited tasks whose own shard file this signal COULD read. */
  measurable: number;
  /** Credited tasks declared inline in the monolith — this signal is BLIND to these, by
   *  construction (note ix); printed alongside `measurable` so the coverage gap is visible
   *  rather than implied. */
  unmeasurable: number;
  /** Task ids amended after their own earliest merge credit with no follow-up shard filed in
   *  that SAME commit (W1-T2280 rationale (11)/(12)). Never includes a retraction-shaped
   *  amendment differently from a criteria-adding one — this signal does not classify intent
   *  (note viii); it only reports "changed after credit, nothing filed alongside". */
  flagged: string[];
}

/**
 * W1-T2280: names a credited task whose OWN shard was touched by a commit after its earliest
 * merge credit, with no new `plan/tasks.d/*.yaml` shard added in that SAME commit (the follow-up
 * escape hatch W1-T2217 used, rationale (11)) — Standing rule 21's post-merge-amendment gate only
 * fires at PR-review time on the amending PR itself; nothing re-checks a MERGED task's shard
 * later, so a rationale-only amendment (which trips no criterion-added trigger, note (xii) of
 * `postMergeAmendmentViolations`) lands invisibly. THIS IS A REPORT, NOT A GATE, same posture as
 * {@link proofQueueAudit}: no `status:` moves, nothing re-queues (note iii).
 *
 * PURE: all git/ledger I/O is the caller's, through `opts.amendedSinceCredit` — the same
 * "injected predicate, no fs of its own" contract {@link ProofQueueAuditOpts} already keeps.
 */
export function creditedAmendmentVisibility(
  facts: readonly CreditedAmendmentFact[],
  opts: {
    /**
     * Was `shardPath` touched by a commit strictly after this task's earliest merge-credit
     * timestamp, and did that SAME commit also add a brand-new `plan/tasks.d/*.yaml` shard
     * (other than `shardPath` itself)? `undefined` ⇒ the evidence could not be read (an
     * unreadable/shallow checkout, no recorded credit timestamp) — FAIL OPEN, never a false
     * flag, the same polarity {@link ProofQueueAuditOpts}'s predicates already keep.
     */
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
