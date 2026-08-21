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
 * A FORWARD REFERENCE STAYS LEGITIMATE — the one way this report can be wrong enough to be
 * deleted, and the one shape it is built to never touch. A whole-file `unit test:
 * test/foo.test.ts` proof for an unimplemented task's not-yet-written test is a normal, sanctioned
 * authoring pattern (CLAUDE.md): `parseWhitelistedProof` compiles it as `kind: "test"` with
 * `nameFiltered` unset, so it never reaches {@link resolveNameFilteredCandidates} at all — this
 * module has no code path that can report it.
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

/** The three ways a proof that PARSES/PROMISES executability can still never resolve against the
 *  real checkout — see the module doc above for what each names. */
export type ProofQueueAuditCause = "refused-parse" | "name-filtered-zero-match" | "grep-path-absent";

/** Every cause this module knows how to name, in report order. */
export const PROOF_QUEUE_AUDIT_CAUSES: readonly ProofQueueAuditCause[] = [
  "refused-parse",
  "name-filtered-zero-match",
  "grep-path-absent",
];

/** One criterion whose proof cannot resolve against the filesystem, and why. */
export interface ProofQueueAuditOffender {
  taskId: string;
  /** 0-based index into `task.acceptance` — the criterion this proof belongs to. */
  criterionIndex: number;
  cause: ProofQueueAuditCause;
  claim: string;
  proof: string;
}

export interface ProofQueueAuditReport {
  /** How many tasks {@link proofQueueAudit} was asked to check (the caller's population). */
  taskCount: number;
  /** How many non-`satisfied_by` criteria were examined across that population. */
  criterionCount: number;
  /** Every offender found, in encounter order — may name the same task more than once (one row
   *  per offending criterion). */
  offenders: ProofQueueAuditOffender[];
  /** `offenders` split by cause, task ids DEDUPED and in first-seen order — a task with two
   *  zero-match criteria appears once in `["name-filtered-zero-match"]`, not twice. */
  byCause: Record<ProofQueueAuditCause, string[]>;
}

export interface ProofQueueAuditOpts {
  /** The reviewer's OWN `resolveNameFilteredCandidates` (lib/review.ts), bound to a real
   *  checkout by the caller — see the module doc's "INJECTED" paragraph. Absent ⇒
   *  `name-filtered-zero-match` is never reported. */
  resolveNameFilteredCandidates?: (rawName: string) => NameFilterResolution;
  /** Does a repo-relative path exist in the checkout the caller bound this to? Absent ⇒
   *  `grep-path-absent` is never reported. Mirrors `LintOpts.moduleExists`
   *  (lib/task-linter.ts) — same "no predicate, no opinion" contract. */
  pathExists?: (repoRelPath: string) => boolean;
}

/**
 * Resolve every criterion's proof in `tasks` through the reviewer's own parser and (when
 * supplied) resolver, and report every one that can never resolve for anyone — never a
 * forward reference, which stays legitimate by construction (see the module doc). Pure: the
 * only I/O this function performs is through the two injected predicates above.
 */
export function proofQueueAudit(tasks: readonly Task[], opts: ProofQueueAuditOpts = {}): ProofQueueAuditReport {
  const offenders: ProofQueueAuditOffender[] = [];
  let criterionCount = 0;
  for (const task of tasks) {
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
        // legitimate proof for a test not yet written (CLAUDE.md) and NEVER reported, by
        // construction: it never reaches resolveNameFilteredCandidates below at all.
        if (!whitelisted.nameFiltered) return;
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
      if (path !== undefined && !opts.pathExists(path)) {
        offenders.push({ taskId: task.id, criterionIndex, cause: "grep-path-absent", claim, proof });
      }
    });
  }

  const byCause: Record<ProofQueueAuditCause, string[]> = {
    "refused-parse": [],
    "name-filtered-zero-match": [],
    "grep-path-absent": [],
  };
  for (const o of offenders) {
    if (!byCause[o.cause].includes(o.taskId)) byCause[o.cause].push(o.taskId);
  }
  return { taskCount: tasks.length, criterionCount, offenders, byCause };
}
