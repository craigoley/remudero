import { bodyVsDiffContractLines, IMPLEMENT_ROLE_LINES, outputContractLines, ratchetContractLines, commitMessageContractLines } from "./compaction.js";
import { GENERATED_LEDGER_CLASSES, isCompanionPath } from "./companion-paths.js";
import type { RemedyFileForGate } from "./ci-parity.js";
import { CI_LOG_FENCE_CLOSE, CI_LOG_FENCE_OPEN, neutralizeFenceMarkers } from "./fix-fence.js";
import { renderDoctrinePreamble } from "./learnings.js";
import { isInPlanScope, outOfPlanScopeFiles } from "./plan-architect.js";
import type { Task } from "./plan.js";
import { citation } from "./provenance.js";
import type { CriterionVerdict } from "./review.js";
import { describeCiLogUnavailable, REGENERABLE_ARTIFACT_GENERATORS, type ActionableGateFailure, type CiFailure, type MergeConflictEvidence } from "./sweep.js";
import { envelope } from "./untrusted-envelope.js";

/**
 * SCOPE-GUARDED BRANCH REFRESH (W1-T142, the `reset --soft` phantom-revert
 * near-miss): collapsing a stale worker branch with `git reset --soft
 * origin/main` forged a merge-base — the flattened commit's diff vs main
 * REVERTED files an unrelated merged PR had touched, and because main had not
 * re-touched them GitHub showed the PR as cleanly mergeable; the phantom
 * revert would have merged silently. Given the set of paths a refreshed
 * branch's diff touches and the task's declared `files` scope, returns the
 * OUT-OF-SCOPE paths (empty = clean, safe to push) — anything outside the
 * declared scope is either a phantom revert or scope creep.
 *
 * PURE: no git/network calls — `diffFiles` is the caller's already-computed
 * diff-file list, never read here. FAIL-CLOSED: an empty/undefined
 * `declaredFiles` scope refuses every non-empty diff (returns it verbatim)
 * rather than waving it through — a task with no declared scope can never
 * legitimize an out-of-scope push. An empty `diffFiles` is always clean
 * (nothing staged, nothing to refuse) regardless of the declared scope.
 */

/**
 * W1-T2650 admitted ONE hand-enumerated path (`scripts/source-size-baseline.json`, then
 * `lib/review.ts`'s `SCOPE_EXEMPT_GENERATED_ARTIFACTS`) so that gate's own printed remedy stopped
 * being refused by this guard. W1-T2651 generalizes the SOURCE of that admission: rather than a
 * second hand-maintained list this guard alone consulted, the exempt set is now read directly off
 * {@link REGENERABLE_ARTIFACT_GENERATORS} (lib/sweep.ts) — the repo's OWN registry of paths a
 * generator reproduces from the tree, already relied on by the merge-conflict rung (W1-T2548) and
 * named in {@link "./run-task.js".renderFixPrompt}'s DECLARED SCOPE carve-out (W1-T2651) with the
 * identical set, so a worker told it MAY commit a registry path is never the one this guard then
 * refuses. A sixth (or Nth) regenerable artifact registered there inherits the carve-out with no
 * second table to keep in sync.
 */

/**
 * W1-T2672 adds a SECOND, independent discount: {@link GENERATED_LEDGER_CLASSES}
 * (lib/companion-paths.ts) — the table `subsystemsOf`/`checkDocsAwareness` already read to say a
 * generated measurement file (a size ledger, a knowledge-budget derivation) is not a user-visible
 * concern. `REGENERABLE_ARTIFACT_GENERATORS` answers "can this be reproduced by a generator" and
 * happens to name `scripts/source-size-baseline.json`; it does NOT name
 * `scripts/knowledge-budget-baseline.json`, which `GENERATED_LEDGER_CLASSES` also covers — so a
 * task whose only out-of-scope path is that second ledger was still flagged before this change.
 * Consulting `isCompanionPath` against the shared table (rather than copying its regex here) means
 * a later row added to `GENERATED_LEDGER_CLASSES` is discounted here with no second edit.
 */

/**
 * The exemptions are only ever consulted ALONGSIDE a task's own declared scope (the
 * `!declaredFiles || declaredFiles.length === 0` branch above already returned): an undeclared
 * task still has every non-empty diff refused, ledger or registry path or not, so this never
 * widens the fail-closed default.
 */
export function scopeGuardOutOfScopeFiles(
  diffFiles: readonly string[],
  declaredFiles: readonly string[] | undefined,
): string[] {
  if (diffFiles.length === 0) return [];
  if (!declaredFiles || declaredFiles.length === 0) return [...diffFiles];
  const declared = new Set(declaredFiles);
  return diffFiles.filter(
    (f) =>
      !declared.has(f) &&
      !Object.hasOwn(REGENERABLE_ARTIFACT_GENERATORS, f) &&
      !isCompanionPath(f, GENERATED_LEDGER_CLASSES),
  );
}

/**
 * The scope-regime SELECTION {@link fixRungScopeStandDownReason} needs twice (once for the
 * current diff, once for the baseline it stands down against) and {@link renderFixPrompt}'s
 * INHERITED SCOPE line (W1-T2607) needs a third time, applied to that SAME baseline — factored
 * out here so every caller reads ONE implementation of "which regime, which predicate" rather
 * than a second copy that could drift (design note (i), W1-T2607). Plan-only tasks (every
 * declared file itself plan-scoped, {@link isInPlanScope}) are graded by plan-scope membership
 * ({@link outOfPlanScopeFiles}); everything else by exact declared-file membership
 * ({@link scopeGuardOutOfScopeFiles} — the SAME function the implement path's push-and-flag
 * disposition already uses, never a parallel reimplementation).
 *
 * Returns `[]` when `declaredFiles` is empty/undefined — a task with no declared scope gives
 * this predicate nothing to compare against, matching {@link fixRungScopeStandDownReason}'s own
 * silent (fail-OPEN) contract for that case. A caller that needs FAIL-CLOSED semantics on an
 * undeclared scope (the implement path) calls {@link scopeGuardOutOfScopeFiles} directly instead.
 *
 * PURE: no I/O, both inputs are the caller's own reads.
 */
export function outOfDeclaredScopeFiles(
  files: readonly string[],
  declaredFiles: readonly string[] | undefined,
): string[] {
  if (!declaredFiles || declaredFiles.length === 0) return [];
  return declaredFiles.every(isInPlanScope)
    ? outOfPlanScopeFiles([...files])
    : scopeGuardOutOfScopeFiles(files, declaredFiles);
}

// ── FIX-RUNG FAILURE-MODE TAXONOMY (W1-T94, W1-T76 follow-up) ────────────────
//
// GROUND TRUTH this taxonomy fixes: the rung's ONE prompt shape assumed every
// block was a reviewer-computed unmet set. Two live proofs said otherwise: (1)
// the Architect's own #157 mis-diagnosis read source WITHOUT the verbatim
// failure signal and produced a confidently-wrong code fix for what was really
// a PROOF-KEYWORD COVERAGE gap (the report just never mentioned the proof) —
// an automated fix worker with the same blindness thrashes the same way, at
// machine speed; (2) `blocked_ci` carries NO reviewer unmet-criteria at all —
// the failing signal IS the CI log — so the old single-shape prompt has
// nothing to render for it. MODE is derived DETERMINISTICALLY from the block
// evidence (policy-as-data, rule 2 — a table, mirroring sweep.ts's
// DISPOSITION_RULES), never an LLM classification and never an if/else chain:
// adding proof_exec-executed_fail or design-conformance later is a ROW in
// {@link FIX_MODE_RULES}, never a change to {@link deriveFixMode}'s loop.
// FLOOR-DEGRADED HONESTY (the #157 finding): "FLOOR DEGRADED: 0/N" on a
// PASSING review is W1-T72 working as designed — it is never a mode input and
// never a dispatch trigger here.
// ────────────────────────────────────────────────────────────────────────────

// `CiFailure` — one failing required CI check's name + the tail of its log,
// the `ci-log` mode's only input — is defined in lib/sweep.ts (imported above)
// because `OpenPrView` carries it and this module already imports OpenPrView
// from sweep.js; the reverse import would be circular (W1-T100).

/** The five known fix-rung failure modes. See the taxonomy note above. */
export type FixMode = "reviewer-unmet" | "body-coverage" | "ci-log" | "merge-conflict" | "gate-fix" | (string & {});

/**
 * The block evidence a fix dispatch derives its MODE from. `review` carries a
 * `blocked_review` verdict (reviewer-unmet / body-coverage); `ciFailures`
 * carries a `blocked_ci` block's failing check names + log tails (ci-log,
 * W1-T226: derived from PRESENCE of `ciFailures`, never from ABSENCE of
 * `review` — see {@link FIX_MODE_RULES} row 2); `mergeConflict` carries a
 * `conflicted` dispatch's conflicting-file evidence (W1-T106, the #170 DIRTY
 * strand) — no review or check can run at all until the conflict itself
 * resolves. `mergeConflict` still precludes the other two by construction
 * (nothing runs on an unmergeable ref). `review` and `ciFailures`, though,
 * MAY legitimately coexist — a review verdict sitting beside a red required
 * check is normal (the verdict may be stale, or simply irrelevant until the
 * check clears) — and when they do, `ciFailures`' presence wins: every
 * CURRENT caller (`runFixRung`, `buildFixRungDispatchArgs`,
 * `routeFix`/`runSweep`) still constructs them mutually exclusively as a
 * matter of caller discipline, but the mode table's own correctness no
 * longer depends on that discipline holding.
 */

/**
 * W1-T2236: `actionableGateFailures` carries the SAME structured, single-form remedy
 * {@link OpenPrView.actionableGateFailures} already names on the sweep side (W1-T923) — a
 * review can FAIL with `review.unmetCriteria` empty (every named criterion passed, or none
 * was ever checkable) while the reviewer's own reasons still name ONE unambiguous gate
 * failure (a changeset contradiction, test theater, a stale-criteria block). Before this
 * field existed that remedy was computed, said out loud in the sweep's own disposed-line
 * reason, and then DISCARDED at the dispatch boundary — `deriveFixMode`'s catch-all
 * `reviewer-unmet` row matched instead, and the prompt carried nothing but an empty list
 * (63% of that mode's measured dispatches, this task's own rationale). Populated ONLY when
 * `review.unmetCriteria` is empty (design note i) — never a widening of `unmetCriteria`,
 * never checked when it is non-empty (see {@link FIX_MODE_RULES}'s `gate-fix` row).
 */
export interface FixEvidence {
  review?: { unmetCriteria: CriterionVerdict[]; summary: string };
  ciFailures?: CiFailure[];
  /** W1-T106: the merge-conflict mode's ONLY input — conflicting files + both sides' log since merge-base. */
  mergeConflict?: MergeConflictEvidence;
  /** W1-T2236: the `gate-fix` mode's ONLY input — see this interface's own doc, above. */
  actionableGateFailures?: ActionableGateFailure[];
  /**
   * W1-T78: an operator's answer to a clarification question, carried VERBATIM
   * as an added constraint on the prompt — never paraphrased, never dropped.
   * Mode-agnostic: rendered ahead of whichever mode's own content follows.
   */
  constraint?: string;
}

interface FixModeRule {
  readonly mode: FixMode;
  readonly when: (e: FixEvidence) => boolean;
}

/**
 * THE MODE TABLE (policy-as-data, rule 2). Precedence is table order (first
 * match wins). W1-T2236: the terminal row (`reviewer-unmet`) is NAMED, never a
 * `when: () => true` catch-all — a rule that matches every unclassified shape can
 * never be wrong, which is exactly why it hid this task's own defect (63% of
 * measured `reviewer-unmet` dispatches carried zero unmet criteria). `deriveFixMode`
 * below still returns SOME mode for any input (its own total-function fallback), but
 * the TABLE itself no longer claims "unconditional" as a virtue.
 */

/**
 *   1. merge-conflict  — `evidence.mergeConflict` is set (W1-T106, the #170
 *                        DIRTY strand): the PR's merge state itself is dirty,
 *                        which precedes EVERYTHING else — no CI check even
 *                        runs on an unmergeable ref, so neither a review nor a
 *                        CI log can exist yet either. Checked FIRST so it is
 *                        never misclassified as ci-log (both leave `review`
 *                        undefined).
 */

/**
 *   2. ci-log         — W1-T226 (corrects W1-T224/W1-T94's original row):
 *                        gated on PRESENCE of `evidence.ciFailures`, never on
 *                        ABSENCE of `evidence.review`. A required check red is
 *                        the failing signal that actually blocks a merge —
 *                        GitHub will not merge past it no matter what a review
 *                        verdict sitting BESIDE it says, and that verdict may
 *                        itself be stale (computed before the push that broke
 *                        the check, or before a slower required check
 *                        settled). This is the SAME "ci-log wins" precedence
 *                        {@link DISPOSITION_RULES} row 5 (`isBlockedCi`,
 *                        sweep.ts) already established and W1-T138 broadened
 *                        to fire "regardless of the review verdict beside it"
 *                        — this row previously did not actually implement
 *                        that precedence: gating on `review === undefined`
 *                        meant ANY posted-or-computed verdict, pass or fail,
 *                        made the row miss and fall through to a
 *                        review-shaped mode, masking the check. Every CURRENT
 *                        caller (`runFixRung`, `buildFixRungDispatchArgs`,
 *                        `routeFix`/`runSweep`'s `dispatchFix`) already
 *                        constructs `review`/`ciFailures` mutually
 *                        exclusively, so this correction changes nothing
 *                        observable for them — it closes the table's OWN
 *                        latent gap, provable by calling {@link deriveFixMode}
 *                        directly with BOTH fields set (a review-failed AND
 *                        CI-red PR, PR 479's shape in the W1-T226 rationale)
 *                        rather than by any caller relying on that discipline
 *                        forever holding.
 */

/**
 *   3. gate-fix        — W1-T2236: `evidence.actionableGateFailures` is non-empty — a
 *                        review FAILED with `unmetCriteria` empty (design note i: every
 *                        named criterion may already read MET) while the reviewer's own
 *                        structured reasons still name ONE unambiguous gate failure (a
 *                        changeset contradiction, test theater, a stale-criteria block —
 *                        see {@link actionableGateFailuresFromReasons}, lib/sweep.ts).
 *                        Reached only when merge-conflict/ci-log above also missed. By
 *                        construction (every producer of `actionableGateFailures` checks
 *                        `unmetCriteria.length === 0` first) this NEVER matches beside a
 *                        non-empty `review.unmetCriteria`, so its ordering relative to
 *                        body-coverage below is inert — placed first because it is the
 *                        more specific, structured shape.
 */

/**
 *   4. body-coverage   — every unmet criterion's reason is a keyword-coverage
 *                        gap ("matched N/M proof keywords") and NONE was an
 *                        OBSERVED `executed_fail` (an actual failed run always
 *                        means real code broke — never treat that as body-only,
 *                        the #157/#143 lesson). Reached only when ci-log's row
 *                        above also missed (no `ciFailures`) — a red required
 *                        check outranks a body-coverage-shaped review too.
 */

/**
 *   5. reviewer-unmet  — a real reviewer-computed unmet set (W1-T76, unchanged):
 *                        `evidence.review.unmetCriteria` is non-empty. W1-T2236: NAMED,
 *                        not unconditional — see this doc block's own header, above. An
 *                        evidence shape that reaches NONE of these five rows (no unmet
 *                        criteria, no named gate failure, no CI/merge-conflict evidence) still
 *                        DISPATCHES on its FIRST such round — `deriveFixMode`'s fallback below
 *                        names `reviewer-unmet` for it, exactly as the old unconditional
 *                        catch-all did, so the review's own `summary` (never empty for a
 *                        failing review) still gives a fix worker something to act on that one
 *                        time, honoring `test/escalation-evidence-floor.test.ts` (W1-T487,
 *                        protected, not in this task's scope — every one of its blocked_review
 *                        fixtures pins this exact shape to dispatch-then-escalate on ITS one
 *                        and only round). `runFixRung`'s own pre-strike guard (site
 *                        `rung.empty_review_evidence`) stands the SAME shape down under a
 *                        named reason, rather than defaulting again, once it has already spent
 *                        one honest strike and recurs unchanged — see that guard's own doc.
 */
export const FIX_MODE_RULES: readonly FixModeRule[] = [
  {
    mode: "merge-conflict",
    when: (e) => e.mergeConflict !== undefined,
  },
  {
    mode: "ci-log",
    when: (e) => e.ciFailures !== undefined,
  },
  {
    mode: "gate-fix",
    when: (e) => (e.actionableGateFailures?.length ?? 0) > 0,
  },
  {
    mode: "body-coverage",
    when: (e) => {
      const unmet = e.review?.unmetCriteria ?? [];
      return (
        unmet.length > 0 &&
        unmet.every((c) => /matched \d+\/\d+ proof keywords/.test(c.reason)) &&
        !unmet.some((c) => c.proof_exec === "executed_fail")
      );
    },
  },
  {
    mode: "reviewer-unmet",
    when: (e) => (e.review?.unmetCriteria.length ?? 0) > 0,
  },
];

/**
 * Derive the fix mode from block evidence — pure, total, table-driven (rule
 * 2). `rules` is injectable (mirrors `deriveDisposition`'s `policy` param in
 * sweep.ts) so a test can prove a NEW table row derives a NEW mode with zero
 * change to this function.
 */
export function deriveFixMode(evidence: FixEvidence, rules: readonly FixModeRule[] = FIX_MODE_RULES): FixMode {
  const rule = rules.find((r) => r.when(evidence));
  return rule ? rule.mode : "reviewer-unmet";
}

/**
 * Render the fix worker's prompt. The prompt NAMES its derived MODE and
 * carries ONLY that mode's inputs — never a mix, never the other modes'
 * fields. `reviewer-unmet` and `body-coverage` both come from `evidence.review`
 * (the FULL unmet acceptance criteria + the reviewer's verbatim reasons, ALL AT
 * ONCE — the anti-ping-pong invariant, P21's golden, absorbed verbatim; never a
 * narrowed, one-criterion prompt). `ci-log` comes from `evidence.ciFailures`
 * instead — the failing check names + log tails, with no review-shaped input
 * at all. `merge-conflict` (W1-T106) comes from `evidence.mergeConflict` — the
 * conflicting file list + both sides' log since merge-base, with no
 * review-shaped or ci-log-shaped input at all. Both `resume` (round 1) and
 * `fresh` (round 2+) rounds get the identical full-set framing for their mode.
 *
 * A review can fail with an EMPTY `unmetCriteria` (judgeReview: `testTheater`
 * or `noCriteria` alone fails the state even when every named criterion is
 * met); `evidence.review.summary` is what keeps the prompt from going out with
 * nothing to act on in that case.
 */

/**
 * W1-T1227: `task.files` (W1-T322's widening of `runFixRung`'s own opts type) is now SURFACED
 * here too — every prior version of this prompt carried only `id`/`title`, so a fix worker had
 * no way to learn the PR's declared scope from its own instructions and could only infer it (or
 * not) from a failing check. See {@link fixRungScopeStandDownReason} for the belt-and-suspenders
 * half of this fix: a worker that ignores this line and pushes outside scope anyway is caught at
 * the NEXT pre-strike gate, before another strike compounds on top of it.
 */

/**
 * W1-T2651: before this, the DECLARED SCOPE sentence forbade EVERY path outside `task.files`,
 * mode-agnostically — including the one edit a failing gate had itself just printed as the fix
 * (`scripts/source-size-ratchet.mjs`'s own remedy for the source-size ceiling it enforces). A
 * worker that obeyed this prompt filed a Follow-up and left the PR red; a worker that obeyed the
 * gate instead was caught by {@link fixRungScopeStandDownReason}'s belt-and-suspenders half, which
 * stood the rung down over the very path the prompt would have called "not yours to widen" — no
 * lane in the fleet could clear it either way. The REGISTRY EXCEPTION clause below names the ONE
 * bounded carve-out: a path {@link REGENERABLE_ARTIFACT_GENERATORS} (lib/sweep.ts) declares may be
 * committed alongside the declared scope, and {@link scopeGuardOutOfScopeFiles} (which
 * `fixRungScopeStandDownReason` calls, via {@link outOfDeclaredScopeFiles}) now agrees — the SAME
 * registry, read once, never a second hand-maintained list either side could drift from. Rendered
 * only for a NON-plan-only task: a plan-only PR's scope regime is plan-membership
 * ({@link outOfPlanScopeFiles}), which this registry was never wired into (design note iii keeps
 * the two regimes untouched), so promising the exception there would tell a worker something the
 * pre-strike gate would still refuse.
 */
export function renderFixPrompt(opts: {
  task: { id: string; title: string; files?: readonly string[] };
  round: number;
  branch: string;
  evidence: FixEvidence;
  // W1-T2607: the changed-file list as it stood BEFORE this invocation's first strike — the SAME
  // baseline {@link fixRungScopeStandDownReason} exempts. Optional and best-effort: omitted (or
  // simply undefined, matching that guard's own fail-OPEN contract for an unreadable baseline)
  // means no inherited-scope line renders at all, never a guessed baseline.
  baselineDiffFiles?: readonly string[];
  // W1-T2653: the declared remedy file(s) of the check(s) THIS strike is addressing — the SAME
  // list the caller passed {@link fixRungScopeStandDownReason}'s 4th parameter, so instruction and
  // enforcement can never name a different set. Omitted (or empty) renders no GATE REMEDY line —
  // never a guessed remedy.
  reachableRemedyFiles?: readonly RemedyFileForGate[];
}): string {
  const mode = deriveFixMode(opts.evidence);
  const header = `You are a FIX worker for task ${opts.task.id} (${opts.task.title}) — round ${opts.round}.\nMODE: ${mode}.`;
  // W1-T78: an operator's clarification answer, when present, is carried
  // VERBATIM ahead of the mode-specific content — mode-agnostic, never dropped.
  const constraintBlock = opts.evidence.constraint
    ? [
        "",
        "OPERATOR CONSTRAINT (the clarification-question rung, W1-T78 — answered; carried verbatim):",
        opts.evidence.constraint,
      ]
    : [];
  // W1-T1227: named EXPLICITLY, mode-agnostic (every branch below splices this in), so the fix
  // worker cannot claim it was never told. Omitted only when the task declares no `files` scope
  // at all — silence here is never a licence, it is simply nothing to report.
  //
  // W1-T2607: paths this branch already carried before this invocation's first strike, that fall
  // outside the declared scope, computed with the SAME predicate {@link fixRungScopeStandDownReason}
  // exempts them by ({@link outOfDeclaredScopeFiles}) — never a second judgment on the same facts.
  // Empty whenever `baselineDiffFiles` was never captured (fail OPEN, matching that guard's own
  // discipline) or simply carries nothing out of scope; either way the block below renders no
  // INHERITED SCOPE line, matching the clean path's existing shape.
  const inheritedOutOfScope =
    opts.task.files && opts.task.files.length > 0 && opts.baselineDiffFiles
      ? outOfDeclaredScopeFiles(opts.baselineDiffFiles, opts.task.files)
      : [];
  // W1-T2651: the ONE bounded exception to "do not push it" — a path this repo's own generator
  // registry declares (the SAME registry {@link scopeGuardOutOfScopeFiles} now reads, never a
  // second list). Rendered only for a task whose declared scope is NOT plan-only: a plan-only PR
  // is graded by plan-scope membership instead ({@link outOfDeclaredScopeFiles}'s own regime
  // selection), which this registry was never wired into, so promising the exception there would
  // contradict the pre-strike gate that actually runs against that PR.
  const planOnlyTask = !!opts.task.files && opts.task.files.length > 0 && opts.task.files.every(isInPlanScope);
  const registryPaths = Object.keys(REGENERABLE_ARTIFACT_GENERATORS).sort();
  const scopeBlock =
    opts.task.files && opts.task.files.length > 0
      ? [
          "",
          `DECLARED SCOPE (W1-T1227): this task's PR may only touch: ${opts.task.files.join(", ")}. If the ` +
            `genuine fix requires a path outside that list, do NOT push it — say so in your REPORT's ` +
            `'## Follow-ups' section instead and leave the branch as-is; this task's declared scope is not ` +
            `yours to widen. A commit outside declared scope is PUSHED AND FLAGGED (\`scope_guard.overrun\`), ` +
            `not blocked — but the NEXT round's fix rung stands down on any NEW out-of-scope path THIS rung ` +
            `adds, so treat "do not push it" as the real rule, not a formality.`,
          // W1-T2653: named EXPLICITLY per failing check — a fix worker told only "some registry
          // permits some path" (the REGISTRY EXCEPTION line below) still has to trust that the gate
          // it is looking at is one of the ones covered; this line removes that inference by naming
          // the exact file AND the exact gate that declares it, scoped to what THIS strike is
          // actually repairing (never every gate's remedy, only the ones currently failing).
          // Rendered only for a NON-plan-only task, the SAME carve-out the REGISTRY EXCEPTION
          // clause below draws: `fixRungScopeStandDownReason` never folds `reachableRemedyFiles`
          // into a plan-only task's comparison set (design note iii), so promising the exception
          // there would tell a worker something the pre-strike gate would still refuse.
          ...(!planOnlyTask && (opts.reachableRemedyFiles ?? []).length > 0
            ? [
                `GATE REMEDY (W1-T2653): the failing check(s) this strike is addressing declare their own ` +
                  `remedy file(s), reachable for THIS repair only: ` +
                  (opts.reachableRemedyFiles ?? [])
                    .map((r) => `${r.path} (gate: ${r.job})`)
                    .join(", ") +
                  `. You MAY commit it/them alongside the declared scope above — the fix rung will NOT stand ` +
                  `down over it and no strike is spent for doing so. This is scoped to the check(s) actually ` +
                  `failing this round: a remedy file for a gate that is NOT currently failing still follows ` +
                  `the "do NOT push it" rule above verbatim.`,
              ]
            : []),
          ...(!planOnlyTask
            ? [
                `REGISTRY EXCEPTION (W1-T2651): the one bounded exception to "do not push it" is a path this ` +
                  `repo's own generator registry declares (REGENERABLE_ARTIFACT_GENERATORS, lib/sweep.ts — ` +
                  `currently ${registryPaths.join(", ")}). If the failing gate you are fixing names one of ` +
                  `those paths as its own remedy, you MAY commit it alongside the declared scope above — the ` +
                  `fix rung will NOT stand down over it and no strike is spent for doing so — but re-derive ` +
                  `any file-count or file-list claim in your REPORT/PR body afterward so it still matches the ` +
                  `diff you actually pushed. Every other path outside the declared list still follows the ` +
                  `"do NOT push it" rule above verbatim; this is not a general licence to widen scope.`,
              ]
            : []),
          ...(inheritedOutOfScope.length > 0
            ? [
                `INHERITED SCOPE (W1-T2607): this branch already carries path(s) outside the declared list ` +
                  `from an earlier round: ${inheritedOutOfScope.join(", ")}. They predate this invocation, ` +
                  `this rung is judged only on what IT adds, and neither removing them nor reporting them ` +
                  `again is required of this round.`,
              ]
            : []),
        ]
      : [];
  const footer = [
    "",
    `Amend the SAME branch (${opts.branch}) — do NOT open a new PR and do NOT create a fix/*`,
    // W1-T136/W1-T137 class: the fix rung authors its OWN commit message and, until now, was
    // told NOTHING about the format — #427/#428 blocked on a 111-char round-3 header. Same
    // literal the implement contract uses, so the two prompts cannot drift.
    ...commitMessageContractLines(),
    `branch (only a run-<taskId>-<epochMs> head is creditable).`,
    // W1-T2997: the fix rung needs this MORE than the implement contract does — it exists
    // because CI went red, and a ratchet an earlier round left unrecorded is the commonest reason.
    ...ratchetContractLines(),
    // W1-T464: this rung used to spread ciParityContractLines() here — the same
    // `rmd preflight --ci-parity` obligation the implement contract carried (W1-T295) — but the
    // orchestrator never gated on a preflight failure (run-task.ts's own handling of it has no
    // branch, no early return), so the ~15-17 minute step was paid on every fix round without
    // ever blocking one. Removed from BOTH prompts together (see lib/compaction.ts); the verb
    // itself (`rmd preflight --ci-parity`) is untouched and remains the hand route's own gate.
    `Then: \`git push origin HEAD\` (no -u) — never force-push. Your PR body`,
    `must substantiate EVERY task acceptance`,
    `criterion, not only the ones fixed here — the review floor judges the body against the`,
    // impl-FV: the SAME literal the implement contract carries, for the same reason
    // `commitMessageContractLines` above is shared — and this rung needs it MOST: it amends an
    // existing PR, so its body is the one most likely to have been written against an earlier diff.
    `FULL criteria set.`,
    ...bodyVsDiffContractLines(),
    `Anything you discover here that is OUT OF SCOPE for THIS fix — a`,
    `research question, a follow-up task, or an action someone should take — goes in an`,
    `OPTIONAL '## Follow-ups' section of your REPORT (W1-T105), never into the diff: one`,
    `typed entry per line, \`research:\` | \`task:\` | \`action:\`, its own one-line why inline.`,
    `End with a REPORT whose last line is exactly: PR_URL: <url>`,
  ];

  if (mode === "merge-conflict") {
    // W1-T106 (the #170 DIRTY strand): the conflicting file list + both
    // sides' log since merge-base come from `git` on a PR branch/head an
    // outside contributor could have authored — the SAME untrusted-content
    // threat model W1-T210 fenced for ci-log's `gh run view` output, so this
    // reuses the identical fence + neutralization rather than a parallel,
    // differently-worded control.
    const mc = opts.evidence.mergeConflict;
    const files = mc?.files ?? [];
    const fileList =
      files.length > 0
        ? files
            .map((f) => `- ${neutralizeFenceMarkers(f.path)} (ours -${f.oursDeleted} line(s), theirs -${f.theirsDeleted} line(s) since merge-base)`)
            .join("\n")
        : "(no conflicting file detail was captured — re-check the PR's mergeability for the current state.)";
    return [
      header,
      ...constraintBlock,
      ...scopeBlock,
      `This PR's merge state is DIRTY — GitHub cannot compute a clean merge ref, so NO check even`,
      `runs until the conflict is resolved; there is no review to react to either. Your target: MERGE`,
      `origin/main into this SAME branch (${opts.branch}) — never rebase, never force-push — resolve`,
      `the conflicting file(s) below, then push. The changed head re-judges through the normal gate.`,
      "",
      `MERGE DISCIPLINE (the #170 hand-resolution's own procedure — never deviate): resolve toward the`,
      `UNION of both sides ONLY where merge-base analysis shows a PURE CONCURRENT ADDITION — both`,
      `sides only ADDED content, neither deleted anything the other still relies on. If EITHER side`,
      `DELETED something in a conflicting file, or the conflict is SEMANTIC rather than a safe`,
      `textual union, REFUSE to resolve it yourself and escalate instead — a wrong auto-resolution`,
      `is worse than a strand.`,
      "",
      `REGENERABLE ARTIFACTS ARE THE EXCEPTION, AND THE UNION IS ALWAYS WRONG FOR THEM. If a`,
      `conflicting file is one a TOOL rewrites from the tree — a size or coverage ledger, a lockfile,`,
      `a generated reference doc, a plan index — do NOT merge it textually at all, in either`,
      `direction. Its correct content is a FUNCTION of the MERGED tree, so it is neither side, and`,
      `often not the larger of the two either. Resolve the OTHER files first, then RE-RUN THE COMMAND`,
      `THAT GENERATES IT and commit whatever that produces. Such a file names its own generator, or`,
      `the repo has a command that rewrites it: read the refusal text, or that file's own header.`,
      `MEASURED on this repo, three conflicts on scripts/source-size-baseline.json: the true merged`,
      `values were 3230, 32818 and 32748 against sides of 3136/3138, 32692/32713 and 32743/32718 —`,
      `taking either side, or the larger of the two, would have shipped a false ceiling every time.`,
      "",
      `Conflicting file(s):`,
      fileList,
      "",
      // W1-T2700: the envelope NESTS INSIDE the W1-T210 fence rather than replacing it — the two
      // are independent defences and this one does not depend on the other having run.
      // `neutralizeFenceMarkers` keeps the FIXED markers unforgeable; the envelope's boundary is
      // drawn fresh per call, so text written before it existed cannot close it at all.
      `${CI_LOG_FENCE_OPEN}`,
      envelope(
        [
          `log since merge-base — OUR side (this branch):`,
          neutralizeFenceMarkers(mc?.oursLog || "(not captured)"),
          "",
          `log since merge-base — THEIR side (origin/main):`,
          neutralizeFenceMarkers(mc?.theirsLog || "(not captured)"),
        ].join("\n"),
        "ci-log",
      ),
      `${CI_LOG_FENCE_CLOSE}`,
      ...footer,
    ].join("\n");
  }

  if (mode === "ci-log") {
    const failures = opts.evidence.ciFailures ?? [];
    // W1-T210: the check NAME and log tail both come from `gh run view
    // --log-failed` — attacker-influenceable CI output — so BOTH (never just
    // the tail) are neutralized against the fence marker and rendered INSIDE
    // the fence, labelled as data, rather than spliced bare between narrative
    // instruction lines. `check: `/`log tail:` labels stay OUTSIDE the value
    // but INSIDE the fence, matching the pre-existing `check: <name>` shape
    // the mode-fixture test above already asserts on.
    const rendered =
      failures.length > 0
        ? failures
            .map((f, i) => {
              // A named unavailability replaces the `log tail:` line entirely rather than sitting
              // beside an empty one: an empty `log tail:` is precisely the rendering that reads
              // as "this check printed nothing", which is the confusion this branch exists to
              // end. The cause text is authored HERE, never by CI, but it is still neutralized
              // and kept inside the fence — the check name beside it is attacker-influenceable,
              // and a reader must not have to know which half of a fenced block to trust.
              const body = f.logUnavailable
                ? `   ${neutralizeFenceMarkers(describeCiLogUnavailable(f.logUnavailable))}\n` +
                  `   TREAT THIS AS "I CANNOT SEE WHY THIS FAILED", NOT AS A CLEAN CHECK.\n`
                : `   log tail:\n${neutralizeFenceMarkers(f.logTail)}\n`;
              // W1-T2700: enveloped INSIDE the fence, per this rung's own composition note in the
              // merge-conflict branch above. The check NAME is inside it too — any installed
              // GitHub App can choose that string, so it is external text exactly like the tail.
              return (
                `${i + 1}. ${CI_LOG_FENCE_OPEN}\n` +
                envelope(`   check: ${neutralizeFenceMarkers(f.name)}\n` + body, "ci-log") +
                "\n" +
                CI_LOG_FENCE_CLOSE
              );
            })
            .join("\n\n")
        : "(no failing check detail was captured — re-check `gh pr checks` for the current state.)";
    return [
      header,
      ...constraintBlock,
      ...scopeBlock,
      `Required CI check(s) are FAILING — the failing signal here IS the CI log, not a reviewer`,
      `verdict. GitHub will not merge past a red required check no matter what any review verdict`,
      `says, and a review verdict sitting beside this one (if any exists at all — most often none`,
      `has run yet, since a review needs green CI first) may simply be STALE, computed before the`,
      `push that broke this check. Your target is making CI GREEN on the SAME branch; do not`,
      `expand scope beyond what the failing check(s) below require — do not touch acceptance`,
      `criteria or task scope to chase a reviewer verdict here.`,
      "",
      rendered,
      ...footer,
    ].join("\n");
  }

  if (mode === "gate-fix") {
    // W1-T2236: the ONE structured, single-form remedy the review floor already named —
    // NEVER an unmet acceptance criterion (every named criterion may already read MET; that
    // is exactly why this mode exists instead of `reviewer-unmet` rendering an empty list).
    const failures = opts.evidence.actionableGateFailures ?? [];
    const n = failures.length;
    const rendered =
      n > 0
        ? failures.map((f, i) => `${i + 1}. ${f.reason}`).join("\n")
        : "(no gate-failure detail was captured — re-check the review floor for the current state.)";
    return [
      header,
      ...constraintBlock,
      ...scopeBlock,
      `The review gate is FAILING on ${n} actionable gate failure${n === 1 ? "" : "s"} the reviewer named a`,
      `SINGLE, unambiguous remedy for — every named acceptance criterion may already read MET; this is NOT`,
      `an unmet-criterion gap. Resolve EACH remedy below exactly as named — the review floor has already`,
      `diagnosed it precisely; do not invent a different fix or re-litigate a criterion that already passed.`,
      "",
      rendered,
      ...footer,
    ].join("\n");
  }

  const unmet = opts.evidence.review?.unmetCriteria ?? [];
  const summary = opts.evidence.review?.summary ?? "";
  const n = unmet.length;
  const list =
    n > 0
      ? unmet
          .map(
            (c, i) =>
              `${i + 1}. claim: ${c.claim}\n   proof required: ${c.proof}\n   reviewer verdict: UNMET — ${c.reason}`,
          )
          .join("\n")
      : `(no single criterion is unmet — the review floor's overall verdict is: ${summary})`;

  if (mode === "body-coverage") {
    return [
      header,
      ...constraintBlock,
      ...scopeBlock,
      `The review gate is FAILING on ${n} unmet acceptance criteri${n === 1 ? "on" : "a"} whose reviewer`,
      `reason is a PROOF-KEYWORD COVERAGE gap — the report text never mentions the proof, this is`,
      `NOT an executed failure. The likely fix is the PR BODY's Acceptance block: add the`,
      `missing substantiation there FIRST. Change code ONLY if the body's claim would actually`,
      `be FALSE — never patch code just to satisfy keywords (the #157/#143 lesson). Review`,
      `summary: ${summary}`,
      "",
      list,
      ...footer,
    ].join("\n");
  }

  // reviewer-unmet (default, W1-T76 unchanged).
  return [
    header,
    ...constraintBlock,
    ...scopeBlock,
    `The review gate is FAILING (${n} UNMET acceptance criterion${n === 1 ? "" : "a"}). Resolve ALL`,
    `of them together in this ONE pass — never fix one and leave another; patching one criterion`,
    `at a time is exactly what causes an infinite ping-pong across review rounds. Review summary:`,
    `${summary}`,
    "",
    list,
    ...footer,
  ].join("\n");
}

/**
 * W1-T2436 (capability 2 of 3): the prompt for the worker THIS rung dispatches when an entangled
 * PR's own review names the DISJOINT instrument/src split (`review.instrumentEntanglementPaths`,
 * `detectInstrumentEntanglement`'s own `instrumentPaths`/`srcPaths`, lib/review.ts). Rationale (4):
 * "the worker is handed the instrument half and the source half ... and authors whatever the
 * prerequisite needs to stand alone" — a human did exactly this twice (#3082, #3186), each time
 * AUTHORING new code the original PR never carried, which is why this is a worker dispatch and
 * never a mechanical `git mv`/partition (rationale (3): a partition's own PR failed its own CI in
 * both cases on record).
 *
 * PURE: no I/O, no git, no gh — the worker itself carries out every git/gh step this text
 * describes, exactly like every other fix-rung dispatch's prompt (`renderFixPrompt`).
 */
export function renderPrerequisitePrPrompt(args: {
  task: { id: string; title: string };
  branch: string;
  prUrl: string;
  instrumentPaths: readonly string[];
  srcPaths: readonly string[];
}): string {
  return [
    `Task ${args.task.id} (${args.task.title})'s own pull request ${args.prUrl} (branch \`${args.branch}\`) was ` +
      `refused by the blocked_review fix rung under Standing rule 25: it changes measurement-instrument ` +
      `path(s) alongside src/ path(s) in the SAME diff, and no worker may resolve that by writing more code ` +
      `into that PR.`,
    "",
    "Your job is DIFFERENT: open a NEW, SEPARATE pull request — the prerequisite — that carries ONLY the " +
      "instrument-surface change below, standing on its own and passing its own CI. Do this:",
    "",
    "1. Starting from a fresh branch off `origin/main` (never the branch above — leave it untouched), bring " +
      "over ONLY these instrument-surface path(s), exactly as they read on that branch right now:",
    ...args.instrumentPaths.map((p) => `   - ${p}`),
    "2. These src/ path(s) belong to the ORIGINAL pull request and must NOT appear in your new one:",
    ...args.srcPaths.map((p) => `   - ${p}`),
    "3. Author WHATEVER this prerequisite needs to stand on its own — new tests, new supporting code, " +
      "anything the instrument-surface change requires to pass CI by itself. Do not assume the split is " +
      "mechanical: a plain `git mv`/cherry-pick of the same hunk has already been tried twice and failed CI " +
      "both times.",
    "4. Push your branch and open the pull request against `main` with `gh pr create`.",
    "5. Leave the ORIGINAL branch/PR entirely alone — no push, no edit, no comment on it.",
    "",
    "End your REPORT with a line reading exactly: PR_URL: <the new pull request's url>",
    "If you cannot produce a pull request that passes its own CI, say so plainly in your REPORT instead of " +
      "opening one that does not.",
  ].join("\n");
}

/**
 * Render the RECON worker's prompt (W1-T37, W1-T2632): fixed read-only instructions, optional
 * task identity, optional task-record pointer, the generated PLAN INDEX, and operator notes.
 *
 * The plan body is not shipped to workers; `planIndexBlock` names retrievable headings. `task` and
 * `recordPath` default to absent so older callers stay byte-identical, and an unresolvable record
 * path omits only the pointer.
 */
export function renderReconPrompt(
  planIndexBlock: string,
  operatorNotesBlock = "",
  task?: Pick<Task, "id" | "title">,
  recordPath?: string,
): string {
  return [
    "You are a RECON worker. Do NOT modify anything. Inspect the current git " +
      "repository read-only (git remote -v, git log --oneline -5, ls). Output one report:\n" +
      "RECON REPORT\nOBSERVED: <commands + key output>\nINFERRED: <conclusions>\n" +
      "COULDN'T-VERIFY: <unconfirmed>\n" +
      // W1-T105: recon is read-only and out-of-scope by construction, so a genuine
      // discovery worth the plan's attention (not just this task's own INFERRED)
      // still has a place to land, never invented into a diff you cannot make.
      "Optionally, after the report, add a '## Follow-ups' section — one typed entry\n" +
      "per line, its own one-line why inline: `research: <what, why>` | `task: <what, why>` |\n" +
      "`action: <what, why>` — for anything discovered that is out of THIS recon's scope.",
    task ? `TASK: ${task.id} — ${task.title}` : "",
    task && recordPath
      ? `YOUR TASK'S OWN RECORD IS AT ${recordPath} — the design, rationale and acceptance ` +
        "criteria for the task above live there, one `Read` away; this recon need not guess them."
      : "",
    planIndexBlock,
    operatorNotesBlock,
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
}

/**
 * Render the DIAGNOSE worker's prompt (W1-T7B — the two-strikes dispatch, §4). EVIDENCE-ONLY,
 * mirroring `renderReconPrompt`'s own read-only contract: two prior implement attempts at the
 * SAME task both failed (a strike each), and this worker's job is to explain WHY — never to
 * patch, commit, or push. It runs in the SAME worktree the failing attempts left behind (the
 * real call site passes the same `cwd: worktreePath` recon already uses), so `git diff`/`git
 * status`/the failing test or build output are all still on disk to inspect.
 *
 * Its report becomes the NEXT (diagnose-informed) attempt's `findings` — `classify.js`'s
 * `runDiagnoseThenRetry` threads whatever text this worker returns straight into the next
 * `attempt(findings)` call, so the third patch is never blind (acceptance #2).
 */
export function renderDiagnosePrompt(task: Pick<Task, "id" | "title">, failureEvidence: string): string {
  return [
    "You are a DIAGNOSE worker. Do NOT modify, commit, or push ANYTHING — this is a read-only " +
      "investigation. Two prior attempts at the task below both failed. Inspect the current " +
      "worktree (git status, git diff, git log, re-run whatever failed) and explain the ROOT " +
      "CAUSE — never propose or write a patch; that is the NEXT worker's job, informed by your " +
      "report.",
    `TASK: ${task.id} — ${task.title}`,
    `## PRIOR FAILURE EVIDENCE\n${failureEvidence || "(no evidence captured)"}`,
    "Output exactly one report:\nDIAGNOSE REPORT\nROOT CAUSE: <your best-evidenced explanation>\n" +
      "EVIDENCE: <the specific commands/output that support it>\n" +
      "SUGGESTED APPROACH: <a concrete next step for the retry — description only, no code>",
  ].join("\n\n");
}

/**
 * Render the implement prompt: cited CONTEXT + TASK + explicit output contract.
 *
 * Cache-aware assembly keeps stable doctrine/rule headlines before per-task context, recon,
 * operator notes and matched learnings. Every line in the CONTEXT block is already
 * provenance-tagged, so the whole block still lints clean regardless of ordering.
 *
 * `implementPromptParts` is shared with the prompt manifest call site, so the fingerprinted parts
 * cannot drift from the bytes the worker actually receives.
 */
export function implementPromptParts(
  task: Task,
  reconContext: string,
  runId: string,
  matchedLearnings = "",
  operatorNotesBlock = "",
  // W1-T2761: policy-gated headline index (`buildRuleHeadlinesPart`, below) — "" when the
  // `workerRuleHeadlines.enabled` row is absent or off, the default for every existing caller
  // that never passes this argument at all.
  ruleHeadlinesPart = "",
): Array<{ name: string; value: string }> {
  const contextClaims = (task.context ?? [])
    .map((c) => `- ${c.claim} ${citation(c.src)}`)
    .join("\n");
  const body = (task.prompt ?? task.title)
    .split("${RUN_ID}").join(runId)
    .split("${TASK_ID}").join(task.id);
  return [
    { name: "doctrine", value: renderDoctrinePreamble() },
    // W1-T2761, design (ii): directly after doctrine — the other STABLE half of the CONTEXT
    // block. It changes only when CLAUDE.md's own headline set moves, never per-task/per-run,
    // so it precedes every volatile/per-task part exactly as renderDoctrinePreamble does.
    { name: "rule_headlines", value: ruleHeadlinesPart },
    { name: "task_claims", value: contextClaims },
    { name: "recon", value: reconContext },
    { name: "operator_notes", value: operatorNotesBlock },
    { name: "matched_learnings", value: matchedLearnings },
    { name: "task_body", value: body },
  ];
}

export function renderImplementPrompt(
  task: Task,
  reconContext: string,
  runId: string,
  matchedLearnings = "",
  operatorNotesBlock = "",
  ruleHeadlinesPart = "",
): string {
  const parts = implementPromptParts(task, reconContext, runId, matchedLearnings, operatorNotesBlock, ruleHeadlinesPart);
  const partValue = (name: string) => parts.find((p) => p.name === name)!.value;

  return [
    // THE ROLE, FIRST — mirroring `renderReconPrompt`, whose own first sentence is "You are a RECON
    // worker." Above `# CONTEXT` on purpose: `extractContext` starts at that heading, so this text
    // is outside the provenance linter's region and carries no citation, while the recon relay
    // below it stays a cited CONTEXT claim exactly as before.
    ...IMPLEMENT_ROLE_LINES,
    "",
    "# CONTEXT",
    partValue("doctrine"),
    // W1-T2761: an empty part (the row absent/off) contributes NOTHING — not even a blank line —
    // so a disabled row renders BYTE-IDENTICAL to every render before this task existed.
    ...(partValue("rule_headlines") ? [partValue("rule_headlines")] : []),
    partValue("task_claims"),
    partValue("recon"),
    partValue("operator_notes"),
    partValue("matched_learnings"),
    "",
    "# TASK",
    partValue("task_body"),
    "",
    // Shared verbatim with the post-compaction ANCHOR (compaction.ts,
    // MASTER-PLAN §8B / W1-T36) — ONE source of literal text so the anchor
    // re-injected after a compaction is provably byte-identical to what the
    // worker was told at turn 0, never a re-derived/paraphrased copy.
    ...outputContractLines(task.id),
  ].join("\n");
}
