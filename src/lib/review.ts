import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join, resolve, sep as pathSep } from "node:path";
import { classifyFailure } from "./classify.js";
import { defaultIsPidAlive } from "./drain-lock.js";
import { isHolderStale, reclaimStaleLock, type IsHolderStaleOpts } from "./fs-race-safe.js";
import { appendLedger } from "./ledger.js";
import { prStateFromRest, singlePrRestArgs, type GhApiFetcher, type RestPullRow } from "./open-prs-rest.js";
import { isInPlanScope } from "./plan-architect.js";
import { loadPlanAtRef, visibleCriteria, type AcceptanceCriterion, type TaskRisk } from "./plan.js";
import { scanUnreachedExports, type UnreachedExport } from "./reachability.js";
import { loadDefaultPolicy, type ArmCalibrationBandRow } from "./policy.js";
import { readLedgerLines } from "./status.js";
import {
  COMPANION_PATH_CLASSES,
  type CompanionPathClass,
  GENERATED_LEDGER_CLASSES,
  isCompanionPath,
} from "./companion-paths.js";
import { ghJson } from "./worker.js";

/** The JUDGE (MASTER-PLAN §12 rule 4 / rule 3B; W1-T1C) — the second half of the merge contract. Standing rule 4:
 * green checks are NOT evidence, so after `ci` goes green a fresh-context REVIEW worker (never the implementer's
 * session; read-only tools plus gh) verdicts each criterion against its stated PROOF and posts a `remudero-review`
 * status. INVARIANTS: {@link judgeReview} is PURE, so its falsifier is a unit fixture; the pure layer is the
 * mechanical FLOOR; a semantic verdict may only DOWNGRADE, never rescue an unpasted proof — proof must be pasted, not
 * vibed; and this module never edits code and exposes no write path (acceptance #3). */

/** The commit-status context string the merge gate keys on. Never change casually. */
export const REVIEW_CONTEXT = "remudero-review";

/** A commit-status state. GitHub statuses also allow `pending`/`error`; the gate uses these two. */
export type ReviewState = "success" | "failure";

/** The wider range {@link postReviewStatus} may POST: {@link ReviewState} plus `pending`, kept a
 *  SEPARATE type because `ReviewState` is a JUDGED verdict and must never admit "in progress". A
 *  detection-time pending post is a fact about timing, so it gets its own type rather than widening
 *  the one every exhaustive switch over a judged verdict already reads (W1-T913). */
export type PostableReviewState = ReviewState | "pending";

/** Stable identity for the material a review judges: the PR head binds the diff, the exact body the authored claims,
 *  so a new commit OR a body edit earns a fresh retry budget while comments, labels and other `updated_at` churn do
 *  not. The revision rearms the same evidence only after a material reviewer-contract change, deliberately
 *  independent of boot commits, provider choice and model sampling. */
export const REVIEW_ENGINE_REVISION = "w1-t2868-exact-head-materialization-v1";

export function reviewInputDigest(
  headSha: string,
  body: string,
  engineRevision: string = REVIEW_ENGINE_REVISION,
): string {
  const encoded = JSON.stringify({ version: 2, engineRevision, headSha, body });
  return `v2:${createHash("sha256").update(encoded, "utf8").digest("hex")}`;
}

export const REVIEW_DECISION_POLICY_REVISION = "review-policy-v1";

export interface ReviewDecisionDigestInput {
  headSha: string;
  diff: string;
  report: string;
  body?: string;
  acceptance: readonly AcceptanceCriterion[];
  declaredFiles?: readonly string[];
  policyRevision?: string;
  engineRevision?: string;
}

/** Content address of every material input to one review decision; model output is excluded. */
export function reviewDecisionDigest(input: ReviewDecisionDigestInput): string {
  const acceptance = input.acceptance.map((c) => ({
    claim: c.claim,
    proof: c.proof,
    satisfied_by: c.satisfied_by ?? null,
    holdout: c.holdout === true,
  }));
  const encoded = JSON.stringify({
    version: 2,
    engineRevision: input.engineRevision ?? REVIEW_ENGINE_REVISION,
    policyRevision: input.policyRevision ?? REVIEW_DECISION_POLICY_REVISION,
    headSha: input.headSha,
    diff: input.diff,
    report: input.report,
    body: input.body ?? null,
    acceptance,
    declaredFiles: input.declaredFiles ?? [],
  });
  return `v2:${createHash("sha256").update(encoded, "utf8").digest("hex")}`;
}

export interface ReviewEvaluatorProvenance {
  provider: string | null;
  requestedModel: string | null;
  servedModel: string | null;
  effort: string | null;
  sessionId: string | null;
}

export interface ReviewDecisionTerminal {
  state: ReviewState;
  verdict: ReviewVerdict;
  reviewerOutcome: string;
  evaluatorProvenance: ReviewEvaluatorProvenance;
}

export function lastReviewDecisionTerminal(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string,
  prUrl: string,
  digest: string,
): ReviewDecisionTerminal | undefined {
  let terminal: ReviewDecisionTerminal | undefined;
  for (const line of lines) {
    if (line.step !== "review.posted" || line.task_id !== taskId || line.pr_url !== prUrl || line.review_decision_digest !== digest) continue;
    const verdict = line.decision_verdict as ReviewVerdict | undefined;
    if (!verdict || (verdict.state !== "success" && verdict.state !== "failure") || !Array.isArray(verdict.criteria)) continue;
    terminal = {
      state: verdict.state,
      verdict,
      reviewerOutcome: typeof line.reviewer_outcome === "string" ? line.reviewer_outcome : "unknown",
      evaluatorProvenance: (line.evaluator_provenance as ReviewEvaluatorProvenance | undefined) ?? {
        provider: null, requestedModel: null, servedModel: null, effort: null, sessionId: null,
      },
    };
  }
  return terminal;
}

export type ReviewDecisionClaim =
  | { kind: "owned"; release: () => void }
  | { kind: "in_flight" }
  | { kind: "replay"; terminal: ReviewDecisionTerminal };

/** Acquire-before-read closes the terminal-check/create race; a live owner makes the loser stand down. */
export async function claimReviewDecision(opts: {
  ledgerPath: string;
  taskId: string;
  prUrl: string;
  digest: string;
  lockOpts?: AcquireReviewStatusLockOpts;
}): Promise<ReviewDecisionClaim> {
  const lockPath = join(dirname(opts.ledgerPath), "review-decision-claims", `${opts.digest.replace(":", "-")}.lock`);
  let handle: ReviewStatusLockHandle;
  try {
    handle = await acquireReviewStatusLock(lockPath, { timeoutMs: 0, ...opts.lockOpts });
  } catch (error) {
    if (error instanceof ReviewStatusLockTimeoutError) return { kind: "in_flight" };
    throw error;
  }
  const terminal = lastReviewDecisionTerminal(readLedgerLines(opts.ledgerPath), opts.taskId, opts.prUrl, opts.digest);
  if (terminal) {
    handle.release();
    return { kind: "replay", terminal };
  }
  return { kind: "owned", release: () => handle.release() };
}

/** WHY a criterion produced no executed outcome (W1-T305). Diagnostic only: it never affects `met`,
 * `state`, the keyword floor or capping. It exists so a CAPPED `0/N` says WHICH KIND of nothing it is. `no-dialect`
 * no house prefix (expected for a non-mechanical claim); `dialect-parse-error` an AUTHORING error; `prose-no-match`
 * zero candidates but the body reads as prose (W1-T161/#349); `exec-error` threw, timed out, or its named PATH is
 * absent; `runtime-broken` the only `not ok` names the FILE ITSELF (W1-T1077); `incomplete-run` results then no `#
 * duration_ms` summary (W1-T2740); `no-exec-context` no PR-head checkout; `forward-reference` absent on the head but
 * declared by this diff's own shard, the DIFF being the source of truth because a filing PR carries no
 * `Remudero-Task:` trailer (W1-T456, #1527) — see {@link shardDeclaredFilesInDiff}. */
export type ProofSkipReason =
  | "no-dialect"
  | "dialect-parse-error"
  | "prose-no-match"
  | "exec-error"
  | "runtime-broken"
  | "incomplete-run"
  | "no-exec-context"
  | "forward-reference";

// Why: `workerKeychainPaths` matched two unrelated hits on the pre-work commit and was scored substantiated anyway
// (W1-T267's fifth criterion) — docs/forensics/review.md.
/** Observed outcome of executing a criterion's proof against the PR head (W1-T65, ratifies P15).
 * Recorded per criterion on {@link CriterionVerdict} and surfaced on the `review.posted` ledger line and console
 * summary, so an OBSERVED verdict reads apart from a KEYWORD one. `executed_pass` ran and passed, meeting the
 * criterion whatever the report says; `executed_fail` ran and failed or matched nothing, and OVERRIDES keyword
 * coverage; `not_executable` is prose or no head checkout, leaving the keyword floor unchanged; `exec_error` threw or
 * timed out and degrades to that floor verbatim, since an environment hiccup must never hard-fail the fleet. THE
 * DEGRADES THAT ARE NOT FAILURES: `executed_stale` (W1-T273, extended to `unit test:` proofs by W1-T362) also passes
 * on the MERGE-BASE, so it discriminates nothing, while a `unit test:` proof ABSENT or failing at base is the healthy
 * forward-referencing TDD case and stays `executed_pass`; `base_unreadable` (W1-T460) is THIS proof's base blob
 * unreadable, distinct from the whole-base gap `base_unknown`, which keeps `executed_pass` because there no tree
 * exists at all; `not_yet_built` (W1-T456) is an exact-path `unit test:` proof naming a file absent on the head that
 * this same diff declares in a plan shard's `files:`, NEVER a path merely absent and undeclared, which stays
 * `executed_fail` (W1-T72's test-theater guard), and (W1-T2737) a house `grep:` proof on the same terms plus a
 * MEASURED executor failure and a source-free diff, because `callSiteViolations` (task-linter.ts) mandates that proof
 * shape and grading the mandated remedy `executed_fail` made two gates unsatisfiable at once. `stale_self_path`
 * (W1-T1071) is THE ONE OUTCOME HERE THAT REFUSES — `met` is forced false, never degraded — for a `grep:` proof gone
 * stale whose target is BOTH a plan-shard path ({@link SHARD_PATH_RE}) and a path this diff's task declares something
 * else beside: the filing-time proof shape, read on the PR that BUILDS the task. Reachable only when {@link
 * ProofExecContext.forwardReferenceFiles} names a path other than the proof's own target, so a shard whose `files:`
 * is nothing but its own plan path is exempt by construction, not by an id allowlist; an
 * ordinary code grep gone stale keeps degrading to `executed_stale`. */
export type ProofExecOutcome =
  | "executed_pass"
  | "executed_fail"
  | "not_executable"
  | "exec_error"
  | "executed_stale"
  | "base_unreadable"
  | "not_yet_built"
  | "stale_self_path";

/** One criterion's verdict against its stated proof. */
export interface CriterionVerdict {
  claim: string;
  proof: string;
  met: boolean;
  reason: string;
  /** See {@link ProofExecOutcome}. Always present — `not_executable` is the safe
   * default when the proof is prose, or no PR-head checkout was supplied. */
  proof_exec: ProofExecOutcome;
  /** See {@link ProofSkipReason}. Absent when the proof executed. */
  proof_skip?: ProofSkipReason;
  /** `met` as computed by the mechanical floor, BEFORE any semantic downgrade — the deterministic
   *  half of this verdict (W1-T178). Optional so every other `CriterionVerdict` literal
   *  (ledger-reconstructed placeholders in run-task.ts/sweep.ts, which carry no semantic layer)
   *  needs no update; {@link applyVerdictStability} falls back to `met`. */
  floorMet?: boolean;
  /** Copied verbatim from {@link AcceptanceCriterion.holdout} (W1-T166). The verdict folds a
   *  holdout criterion in like any other; this flag exists only so {@link visibleCriteria} can keep
   *  its claim and proof text off every worker-facing surface. */
  holdout?: boolean;
}

/** The two reasons a report can fail to be the PR body, which are NOT the same fact and have
 *  different remedies: `never-fetched` means this path never asked (the common case, nothing wrong),
 *  `fetch-failed` means it asked and the read failed — never once observed here. */
export type ReportSubstituteCause =
  /** No fetch was attempted. `fixMode` names the mode that does not read the body, when in hand: a
   *  reader who sees the mode can act; one told a fetch failed cannot. */
  | { kind: "never-fetched"; fixMode?: string }
  /** A fetch was attempted and threw. Distinct from the above BY CONSTRUCTION so the wording can
   *  stop implying this is what happened. */
  | { kind: "fetch-failed" };

/** The evidence the JUDGE reads: the PR diff, the implement REPORT, optional LLM verdicts. */
export interface ReviewEvidence {
  /** The unified PR diff (as `gh pr diff` / `git diff` would produce). */
  diff: string;
  /** The implement worker's REPORT text (where proofs are pasted). */
  report: string;
  /** True when `report` is NOT the PR body (W1-T1100): `runTaskBody` (run-task.js) substitutes the worker's own chat
   *  text after a failed body read, so an outage degrades to judging the narrative rather than stalling the review.
   *  // Why: unmarked, a substitute failed two OPPOSITE ways on #2395 — {@link bodyContradictsDiff} manufactured a
   *  // contradiction, while the keyword floor scored the narrative HIGHER than an honest body. */
  reportIsSubstitute?: boolean;
  /** WHY `report` is not the body. The boolean above keeps its one meaning — THIS IS NOT THE PR BODY — and this
   *  names which of two very different facts the REFUSAL TEXT rests on; absent leaves the message silent rather than
   *  guessing.
   *  // Why: the refusal claimed a failed body fetch on rows where none had failed and
   *  // `review.body_fetch_error`/`fix.body_fetch_error` read ZERO across the ledger, the real cause being that the
   *  // fix rung fetches the body only in `body-coverage` mode, so `ci-log`, `reviewer-unmet` and
   *  // `merge-conflict` never attempt one (2026-08-25). */
  reportSubstituteCause?: ReportSubstituteCause;
  /** Optional per-criterion semantic verdicts from the fresh LLM reviewer, index-aligned to the
   *  criteria list. `false` FORCES that criterion to fail; `true`/`undefined` defer to the
   *  mechanical floor. Semantic can only downgrade, never upgrade an unpasted proof to a pass. */
  semantic?: (boolean | undefined)[];
  /** Optional per-criterion bounded clause the reviewer attached to a FAIL line (W1-T2263) — see
   *  {@link parseReviewerVerdictClauses}. Index-aligned to `criteria`/`semantic`, read ONLY where
   *  `semantic[i] === false`, and never a second reviewer call: it is captured off the SAME
   *  transcript {@link parseReviewerVerdicts} already parses. */
  semanticClauses?: (string | undefined)[];
  /** The checkout whitelisted proofs execute in — MUST be the PR HEAD sha, NEVER the operator's
   *  working checkout (HEAD DISCIPLINE, W1-T65). Absent ⇒ execution is skipped for every criterion
   *  and the keyword floor is byte-identical to pre-W1-T65 behaviour. */
  headCheckoutDir?: string;
  /** A checkout of the PR's MERGE-BASE (W1-T273), independent of `headCheckoutDir`: the caller
   *  reaches it with one `git merge-base` over a checkout the review already has, so no new gateway
   *  and no network call. Consulted only to test a proof for non-discrimination; absent ⇒ that
   *  check never runs and a proof passing on the head stays `executed_pass`. */
  baseCheckoutDir?: string;
  /** Repo-relative paths whose base blob could NOT be read while `baseCheckoutDir` was built
   *  (W1-T460) — a GENUINE read failure, never the healthy "absent at the base" forward reference.
   *  Distinct from `baseCheckoutDir` being absent, a global gap: each path here names a proof
   *  exempted while its siblings were checked against the very same tree. */
  baseUnreadablePaths?: ReadonlySet<string>;
  /** True when `baseCheckoutDir` is a REAL CHECKOUT of the merge-base — a detached worktree `buildBaseProofDir`
   *  (run-task.ts) added — rather than the blob-only fallback (R-11), the one tree a `unit test:` proof can be re-run
   *  in honestly. FAILS CLOSED: absent ⇒ `base_unknown`, never `discriminates`; `grep:` proofs are unaffected, since
   *  a blob IS the file grep reads.
   *  // Why: in a blob-only directory `node --test` finds no file and exits 1 with empty stdout, read as "did not
   *  // pass at base ⇒ discriminates" and certifying a test that passes at both commits. */
  baseIsCheckout?: boolean;
  /** Injected proof executor; real callers omit it and get {@link execWhitelistedProof}. Tests
   *  inject a fake so override and degrade semantics are proven without a filesystem or a shell. It
   *  is also the executor {@link preexistingProofHits} reuses against `baseCheckoutDir` — the same
   *  function at a different `cwd`, so one fake covers both sides. */
  execProof?: ProofExecutor;
  /** The task's DECLARED `files:` scope (W1-T322) — read ONLY for the INVERSE-SCOPE advisory, the
   *  direction {@link "../run-task.js".scopeGuardOutOfScopeFiles} cannot see: that guard flags a
   *  diff touching an UNDECLARED file, this flags a declared file the diff never touched. Advisory
   *  only, never affects `state`. Absent ⇒ it never fires. */
  taskDeclaredFiles?: string[];
  /** Task ids currently OPEN in the loaded plan (W1-T322), consulted only to check that a report's
   *  `SHIPS-UNWIRED: <id>` marker names a real, still-open task before it is honoured. FAIL-CLOSED:
   *  absent ⇒ no marker can be honoured, because every claimed id reads as unverifiable. */
  openTaskIds?: ReadonlySet<string>;
  /** Task id → that OPEN task's declared `files:` scope (W1-T458), consulted only to name which open task's scope an
   *  UNRESOLVED diff overlaps. "Unresolved" is read off {@link taskDeclaredFiles} being empty, NEVER off whether a
   *  `Remudero-Task:` trailer appears; absent ⇒ never fires.
   *  // Why: keyed on the trailer it would misfire on test/fixtures/golden-verdicts/scope-creep (#1731). */
  openTaskDeclaredFiles?: ReadonlyMap<string, readonly string[]>;
}

/** See {@link ReviewVerdict.unwiredAdvisories}'s doc for what each code means and why
 *  `net_state_claim` never appears here (retro-time only). */
export type UnwiredReasonCode =
  | "unwired_export"
  | "inverse_scope"
  | "scope_violation"
  | "net_state_claim"
  | "unresolved_task_scope";

/** One SHIPS-UNWIRED advisory line (W1-T322) — see {@link ReviewVerdict.unwiredAdvisories}. */
export interface UnwiredAdvisory {
  reasonCode: UnwiredReasonCode;
  /** The offending symbol(s)/path(s), rendered `file::symbol` for `unwired_export`, bare repo paths
   *  for `inverse_scope`/`scope_violation` — never a bare "flagged" with nothing named (W1-T186
   *  emitter discipline, the same {@link ReviewVerdict.instrumentEntanglementPaths} follows). */
  symbols: string[];
  /** Human-readable detail — the exact text the ledger line and any console annotation render. */
  detail: string;
}

/** The rolled-up review verdict — exactly what {@link postReviewStatus} posts. */
export interface ReviewVerdict {
  state: ReviewState;
  criteria: CriterionVerdict[];
  /** True when the diff adds tests that assert nothing (a global fail signal). */
  testTheater: boolean;
  /** One-line human summary, safe to use as the commit-status description. */
  summary: string;
  /** True when NOTHING was observed on the PR head while at least one non-`satisfied_by` proof WAS written in the
   *  house dialect ({@link isDialectPrefixed}) — a proof authored to be mechanically checked never got checked, and
   *  the verdict fell back to the blind keyword floor everywhere. LEGIBILITY ONLY (W1-T72): `state`/`met` are
   *  unchanged, and whether a degraded floor should HOLD a risk:high PR is the operator's call, out of scope here. */
  floorDegraded: boolean;
  /** Distinct (checkout, command, argv) triples this review executed, head and base counted separately;
   *  `proofReuses` counts calls answered from an earlier observation in the SAME review (W1-T2743). Counts only, so
   *  the row gains two integers rather than an unbounded payload. `undefined`, never `0`, when no head checkout was
   *  supplied. #3744 reads 2 unique runs and 10 reuses, where `proof_exec: 6/6` had hidden twelve child spawns. */
  proofUniqueRuns?: number;
  proofReuses?: number;
  /** The rolled-up `state` as if NO semantic verdict had been supplied: every criterion judged on
   *  `floorMet`, plus the same structural rules `state` uses (W1-T178). The deterministic anchor
   *  {@link applyVerdictStability} consults, since a semantic-only downgrade is noise a re-review of
   *  an unchanged, previously-passing head may not act on alone. */
  floorState?: ReviewState;
  /** True when this review's `proof_exec` set is ENTIRELY `not_executable`/`exec_error` across every criterion that
   *  could have executed — nothing was OBSERVED anywhere (W1-T185), `satisfied_by` excluded. CAPPED IS NOT FAIL, and
   *  that is load-bearing: mapping it to failure would red every PR the moment one proof is unparseable. It changes
   *  the RENDERING, and one decision — {@link decideAutoMergeArm} refuses to arm on ANY capped verdict absent a
   *  ledgered {@link CappedOverride}.
   *  // Why: an earlier gate exempted every non-`{tdd: strict}` task, making prose the DEFAULT merge floor. */
  capped: boolean;
  /** True when this verdict was judged with NO `headCheckoutDir`, so execution was never attempted
   *  and `state` rests entirely on the keyword floor (W1-T185) — today `rmd review`'s manual-PR
   *  escape hatch, since the operator's working checkout is never a PR-head substitute (HEAD
   *  DISCIPLINE, W1-T65). Purely LEGIBILITY, surfaced on the status, ledger and console so a
   *  keyword-only PASS is never mistaken for an observed one. */
  keywordOnly: boolean;
  /** True when the diff touches ONLY plan-scope files ({@link isInPlanScope}) and at least one file (W1-T205): such
   *  a PR carries no code and so no executable proof, making it STRUCTURALLY capped rather than degraded. FAILS
   *  CLOSED — one src/test file mixed in is NOT plan-only, because the dangerous shape is code smuggled into a plan
   *  PR for the exemption. {@link decideAutoMergeArm} arms such a verdict without an override, an exemption from
   *  PROOF EXECUTION and (since W1-T2221) the SEMANTIC downgrade, never from `state`.
   *  // Why: a filing whose proof path named a test already on `main` RAN and the carve-out was never reached. */
  planOnly: boolean;
  /** True when the diff ITSELF adds or removes a criterion field (`claim:`/`proof:`/`satisfied_by:`) in
   *  `plan/tasks.yaml` or a `plan/tasks.d/*.yaml` shard (W1-T399) while ALSO touching something outside `plan/**` —
   *  Standing rule 15 (W1-T58, ratifies P3 via P8/RETRO-1784058021334). FORCES `state` to `"failure"` like
   *  `testTheater`, never suppressible; an ordinary task filing never trips it, because filing is plan-only.
   *  // Why: #1295 appended a criterion its own diff already satisfied, and a pure append deleted nothing and grew
   *  // no existing field, so it tripped neither disjunct (W1-T400). */
  criteriaTampered?: boolean;
  /** Claims the body makes about its OWN changeset that are FALSE against the diff it shipped (W1-T274) — a stated
   *  file count, a "no src/"/"plan-only"/"data-only" absence claim, or a named file in an "exactly N files: …"
   *  enumeration; see {@link bodyContradictsDiff} for why anything outside them is silence. Non-empty FORCES `state`
   *  to `"failure"`, because a body contradicting its own diff is a false statement the gate is asked to merge on,
   *  and the contradiction is NAMED ({@link failSummary}) since an unexplained red is the shape that gets
   *  overridden. */
  changesetContradictions?: ChangesetClaimContradiction[];
  /** How many changeset claims {@link recognizeChangesetClaims} RECOGNISED (W1-T1264) — THE FIELD
   *  THAT MAKES A SILENT `changesetContradictions: []` LEGIBLE, since that array reads identically
   *  whether the body made no claim or made one that agreed. `0` is the former, `> 0` beside an
   *  empty array is "checked, and it agrees", and `undefined` (never `0`) means the check was
   *  withheld on a substitute report. Legibility only. */
  changesetClaimsRecognised?: number;
  /** True when {@link recognizeChangesetClaims}'s quote-stripping pass reached end-of-body still
   *  inside an open fence (W1-T1264 design (iv)) — see {@link
   *  ChangesetClaimRecognition.fenceUnbalancedAtEof} for why that silently starves
   *  `changesetClaimsRecognised`. Legibility only; `undefined`, not `false`, when withheld. */
  changesetFenceUnbalancedAtEof?: boolean;
  /** True when the diff changes at least one {@link INSTRUMENT_SURFACE} path AND at least one `src/` PRODUCT path
   *  (`test/` excluded, {@link isProductPath}) in the SAME PR — Standing rule 25, INSTRUMENT CHANGES RIDE ALONE
   *  (W1-T297) — because a diff shipping both proves neither: the code's falsifiers were graded by the very version
   *  of the instrument beside them. FORCES `state` to `"failure"`, never suppressible; an instrument-only PR is the
   *  SANCTIONED shape.
   *  // Why: a coverage flag, a diff-coverage carve-out and a re-captured baseline all rode inside ordinary fix-rung
   *  // strikes (#585/#586; docs/forensics/review.md). */
  instrumentEntangled?: boolean;
  /** The observed evidence behind a `true` {@link instrumentEntangled} — the instrument paths found
   *  and the `src/` product paths beside them (W1-T186 emitter discipline: never a bare "entangled"
   *  with nothing named). `undefined` whenever `instrumentEntangled` is `false`/absent. */
  instrumentEntanglementPaths?: { instrumentPaths: string[]; srcPaths: string[] };
  /** The SHIPS-UNWIRED advisory floor (W1-T322). ADVISORY ONLY: never folds into
   * `state`/`floorState`/`capped`; W1-T323 flips severity once a measured false-positive rate clears a threshold.
   * `unwired_export` — an added `export function` {@link scanUnreachedExports} finds no caller for, with no
   * `WIRED-AT: <file>::<symbol>` or `SHIPS-UNWIRED: <task-id>` naming a real open task ({@link
   * ReviewEvidence.openTaskIds}). `inverse_scope` — the declared scope ({@link ReviewEvidence.taskDeclaredFiles})
   * names a file the diff never touched; `scope_violation` (W1-T401) is its MIRROR, run on every review;
   * `unresolved_task_scope` (W1-T458) is phrased as a QUESTION because AN INTERSECTION IS EVIDENCE, NOT PROOF. All
   * four FAIL CLOSED and ledger `review.unwired_advisory`.
   * // Why: a blocking check that false-positives on ~50 PRs/day gets routed around within a week. */
  unwiredAdvisories?: UnwiredAdvisory[];
  /** The reachability scan's EXAMINED count, riding this verdict so `review.posted` carries it
   *  without a second ledger line (W1-T1118). A NUMBER means {@link scanUnreachedExports} ran (`0` is
   *  honest, the diff added none); `null` means it did NOT run, the same `checkoutDir` skip
   *  `unwired_export` degrades on. OBSERVABILITY ONLY: it never changes which advisories fire. */
  reachabilityScanned?: number | null;
  /** The header text of every entry this diff ADDS to DECISIONS.md carrying neither the machine
   *  auto-choose stamp nor an operator-attribution line among that entry's own added lines (W1-T352;
   *  {@link decisionsEntryProvenanceViolations} holds the closed vocabulary). Only ADDED lines are read,
   *  so historical unmarked entries never fire. Non-empty FORCES `state` to `"failure"`, never
   *  suppressible, and UNLIKE {@link unwiredAdvisories} it BLOCKS from day one.
   *  // Why: #1302 appended a bare `## … RULING:` header in neither genre (#1303). */
  unprovenancedDecisionsEntries?: string[];
  /** Visible-pass-rate minus holdout-pass-rate over this verdict's criteria (W1-T166). A worker that
   *  can see, and so optimise toward, only the visible criteria is expected to pass them at a higher
   *  rate than the holdout ones it never saw, so a large positive gap is the signal SpecBench names.
   *  `null` when not MEASURABLE, and never forces `state`: a measurement ledgered as
   *  `reward_hacking_gap`. Treat absent as `null`. */
  rewardHackingGap?: number | null;
  /** How many criteria carry a {@link CriterionVerdict.proof_skip} — every
   *  `not_executable`/`exec_error` one, over the SAME set `capped`/`floorDegraded` count (W1-T305).
   *  Holdout criteria are counted: the AGGREGATE NUMBER is never secret, only holdout TEXT is. */
  unexecutableCount?: number;
  /** The OFFENDING PROOF TEXT for every unexecutable criterion counted above — `criterion.proof`,
   *  never a paraphrase (W1-T305). VISIBLE criteria only ({@link visibleCriteria}), so
   *  `unexecutableCount` may exceed this array's length when a holdout criterion is among them. */
  unexecutableProofs?: string[];
  /** True when SOME but not ALL executable criteria actually executed (W1-T305 design (4)) — the
   *  same "was anything OBSERVED" set `capped`'s count reads. Distinct from `capped` (all zero) and
   *  from a fully observed review. Never forces `state`; surfaced on {@link passSummary} so a
   *  partially certified PASS is never rendered identically to a fully certified one. */
  partiallyExecuted?: boolean;
  /** W1-T305: how many criteria (of `executableProofCount`) actually executed — the numerator
   *  {@link partiallyExecuted} and the posted "PARTIAL: X/Y" annotation are both derived from. */
  executedProofCount?: number;
  /** W1-T305: how many criteria COULD have executed (every criterion except `satisfied_by`) —
   *  the SAME set `capped` already counts against, exposed here so `passSummary`'s partial
   *  annotation and any later consumer read it rather than re-deriving it. */
  executableProofCount?: number;
}

// ── Tokenisation (deterministic, dependency-free) ──────────────────────────

/** Generic words that carry no proof-specific signal — excluded from keywords. */
const STOPWORDS = new Set([
  "shows",
  "show",
  "with",
  "real",
  "that",
  "this",
  "used",
  "over",
  "into",
  "from",
  "each",
  "their",
  "than",
  "then",
  "them",
  "were",
  "will",
  "have",
  "has",
  "the",
  "and",
  "for",
  "are",
  "was",
  "not",
  "any",
  "per",
]);

/** Tokenise for keyword matching, normalising identifier casing and separators so `maxTurns` ≡
 *  `max_turns` ≡ `max-turns`. camelCase splits BEFORE lowercasing, or `maxTurns`→`maxturns` never
 *  matches `max_turns` — a real reviewer weakness that false-blocked PR #42 (W1-T5). A FLOOR
 *  hardening; the deeper fix is observing repo state (W1-T3F), not keywords. */
function tokenize(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // split camelCase: maxTurns → max Turns
    .toLowerCase()
    .split(/[^a-z0-9]+/) // splits on _, -, space, punctuation alike
    .filter(Boolean);
}

/** Distinctive keywords of a proof: tokens ≥4 chars, not stopwords, not bare numbers. Placeholders
 *  like `<sha>` reduce to `sha` (len 3) and drop out, so template noise does not pollute the responsiveness check. */
function proofKeywords(proof: string): string[] {
  return [
    ...new Set(
      tokenize(proof).filter((t) => t.length >= 4 && !STOPWORDS.has(t) && !/^\d+$/.test(t)),
    ),
  ];
}

/** Fraction of a proof's distinctive keywords the report must echo before the proof counts as
 *  responsively addressed. A FLOOR, not a semantic judge.
 *  // Why: at 0.34, echoing barely a THIRD of a proof's tokens read as responsive, which a report
 *  // can hit by accident through shared vocabulary with the claim (W1-T219, recon R-13(i)). */
const MIN_COVERAGE = 0.6;

// ── Test-theater detection over a unified diff ─────────────────────────────

/** True once we are inside an added test file (per `+++ b/…test…` headers). */
function isTestPath(path: string): boolean {
  return /(^|\/)test(s)?\//.test(path) || /\.test\.[cm]?[jt]sx?$/.test(path) || /\.spec\./.test(path);
}

const ASSERTION_RE = /\b(assert|expect|should)\b|\.(is|ok|equal|deepEqual|match|throws|rejects)\(/;
/** A NEW TEST CASE declared among a diff's added lines — `test(`, `it(`, `describe(`, including
 *  `.only`/`.skip`/`.each`. This is what makes "added tests" something to judge at all; see
 *  {@link detectTestTheater} for why its absence must not fire the no-assertion arm. Matches the
 *  CALL, never a bare token, so a variable named `test` cannot smuggle a case past the gate. */
const TEST_DECLARATION_RE = /\b(?:test|it|describe)\s*(?:\.\w+)?\s*\(/;

const NOOP_ASSERTION_RE =
  /assert(\.\w+)?\(\s*true\s*[),]|assert\.equal\(\s*true\s*,\s*true|expect\(\s*true\s*\)/;

/** Fixture DATA under `test/fixtures/` is not test CODE, and the exclusion is load-bearing: a corpus of PLANTED
 * violations necessarily CONTAINS the patterns this detector hunts, and `isTestPath` matches everything under
 * `test/`. It does not blunt the detector, because nothing there runs as this repository's own suite; test code
 * proper, `test/golden-verdicts.test.ts` included, is still scanned.
 * // Why: #1613 failed as theater on its own fixtures — a `diff.patch` whose payload is `assert.ok(true)`, and a
 * // `golden.yaml` quoting `assert(true), assert.equal(true, true), expect(true)`. */
function isFixtureDataPath(path: string): boolean {
  return /(^|\/)test\/fixtures\//.test(path);
}

/** Detect test theater: added test code that asserts nothing, or asserts a tautology. Scans only
 *  ADDED lines inside test files, EXCLUDING fixture data ({@link isFixtureDataPath}). False when the
 *  diff touches no test file, or when a real assertion is added. */
export function detectTestTheater(diff: string): boolean {
  let inTestFile = false;
  const addedTestLines: string[] = [];
  for (const line of diff.split("\n")) {
    // File headers (`+++ b/path`) precede their `+`-prefixed body lines.
    if (line.startsWith("+++ ")) {
      const path = line.replace(/^\+\+\+\s+(?:b\/)?/, "").trim();
      inTestFile = isTestPath(path) && !isFixtureDataPath(path);
      continue;
    }
    if (line.startsWith("diff --git")) {
      // A `diff --git a/x b/y` header names both paths; use the `b/` side.
      const m = line.match(/\sb\/(\S+)\s*$/);
      inTestFile = m ? isTestPath(m[1]) && !isFixtureDataPath(m[1]) : false;
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (inTestFile && line.startsWith("+")) addedTestLines.push(line.slice(1));
  }
  if (addedTestLines.length === 0) return false;
  // THE PLANTED-TAUTOLOGY ARM IS UNCONDITIONAL, AND STAYS ABOVE THE GUARD BELOW. `assert(true)` is a deliberate act,
  // not an absence, so it is refused whether or not the diff declares a test case — smuggling one into an EXISTING
  // case is precisely the shape that would walk through that guard.
  if (addedTestLines.some((l) => NOOP_ASSERTION_RE.test(l))) return true;
  // A DIFF THAT DECLARES NO NEW TEST CASE HAS ADDED NO TEST TO JUDGE. A unified diff renders a MODIFICATION as a
  // `-`/`+` pair and the loop above reads only the `+` half, so an in-place rewrite of existing test code was
  // indistinguishable from newly added code and, carrying no assertion, was refused as theater. ITS COST, STATED
  // RATHER THAN BURIED: lines appended INSIDE an existing test case, with no assertion in the added set, no longer
  // trip the arm — the operator ruled for the declaration gate over an unreliable pairing (2026-09-04).
  // // Why: #3922 measured 52 added test lines, zero test-case declarations, `testTheater = true`, 36 green checks.
  if (!addedTestLines.some((l) => TEST_DECLARATION_RE.test(l))) return false;
  const hasRealAssertion = addedTestLines.some((l) => ASSERTION_RE.test(l));
  return !hasRealAssertion;
}

// ── Whitelisted proof execution (W1-T65, ratifies P15; grammar widened W1-T72) ──
// The deterministic FLOOR that replaced W1-T3F's advisory-LLM judgment. Four shapes execute; anything else is
// not_executable and the keyword floor stands: a named TEST FILE path run through `node --test --import tsx <path>`;
// a literal, BACKTICK-FENCED `grep ...`; `grep: <pattern> in <path>`, whose `in <path>` clause is REQUIRED (W1-T219,
// recon R-13(iii)) because a repo-wide search would let one incidental match certify a criterion while
// `executed_pass` OVERRIDES keyword coverage; and `unit test: <file-or-test-name>`. INVARIANT: all four run through
// execFile, never a shell, so proof TEXT cannot inject shell metacharacters; the legacy shapes still refuse `; & \ $
// < >`, the house shapes deliberately do not and are refused only for `..` traversal or a glob in a grep target.
// // Why: a semicolon in ordinary prose refused 158 of 269 dialect proofs (W1-T128; docs/forensics/review.md).

/** A proof shape the floor is willing to mechanically execute. */
export interface WhitelistedProof {
  kind: "test" | "grep";
  /** argv[0] — passed to execFile, never a shell. */
  command: string;
  /** argv[1..] — proof text is never concatenated into a shell string. */
  args: string[];
  /** Human-legible label for reasons (the matched path, or the fenced command). */
  label: string;
  /** True when `kind==="test"` was compiled from a bare TEST NAME rather than a file path (house
   *  dialect `unit test: <name>`), so `args` includes `--test-name-pattern` (W1-T72). TRAP {@link
   *  execWhitelistedProof} guards with it: that flag with ZERO matches still exits 0, because every
   *  file's own wrapper passes trivially, and a named test absent from the head must count as FAIL —
   *  exactly the "grep with no match" class — never a silent pass. */
  nameFiltered?: boolean;
  /** True only for a `kind==="grep"` compiled by the LEGACY fenced `` `grep ...` `` shape rather than the house
   *  dialect (W1-T2294). The dialect form always compiles to the fixed `["-arn", "--", pattern, path]` argv — BRE,
   *  author-unselectable — while the legacy shape passes an author's own flags, `-E` among them, through unexamined.
   *  This is how task-linter.ts's engine-divergence check tells the two apart; `args` alone cannot. */
  authorSelectedArgv?: boolean;
}

const TEST_PATH_RE = /\btest\/[\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?\b/;
const TEST_PATH_EXACT_RE = /^test\/[\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?$/;
const GREP_FENCE_RE = /`(grep\s+[^`]+)`/;
const UNSAFE_FENCE_CHARS_RE = /[;&`$<>\n]/;
/** The house-dialect PREFIXES a proof is WRITTEN in when it is meant to be mechanically checked
 *  (W1-T72). Matched against the proof's leading text only: a dialect label is how a proof STARTS,
 *  never something incidentally mentioned mid-sentence. */
const DIALECT_GREP_RE = /^grep:\s*(.+)$/i;
const DIALECT_TEST_RE = /^unit test:\s*(.+)$/i;
/** The third house dialect (W1-T277) — `demonstration: <what the operator must do>` — is the honest
 *  OPPOSITE of `grep:`/`unit test:`: it names a proof the harness DECLINES to check, on the record.
 *  {@link parseWhitelistedProof} always refuses it, there being nothing to execute; its
 *  `verify:human`-only legality is enforced by task-linter.ts, since review.ts has no opinion on a
 *  task's `verify` field. */
const DIALECT_DEMO_RE = /^demonstration:\s*(.+)$/i;

/** A markdown code span WRAPPING the whole string: N backticks, the body, the SAME N backticks. The
 *  `\1` backreference is what makes it safe — only a matched pair at the two ENDS is removed, so an
 *  interior backtick is never touched. `[\s\S]` rather than `.` handles a multi-line span; the
 *  inner `\s*` absorbs the padding CommonMark allows. */
const WRAPPING_CODE_SPAN_RE = /^(`+)\s*([\s\S]*?)\s*\1$/;

/** Unwrap a whole-string code span, once. Returns the input unchanged when it is not wrapped. */
function stripCodeSpan(s: string): string {
  const m = s.match(WRAPPING_CODE_SPAN_RE);
  return m ? m[2].trim() : s;
}

/** Does this text already lead with a dialect label? Used to keep the bare form on its fast path. */
function matchesDialectPrefix(s: string): boolean {
  return DIALECT_TEST_RE.test(s) || DIALECT_GREP_RE.test(s) || DIALECT_DEMO_RE.test(s);
}
/** The project's own `test` script glob (package.json) — reused verbatim so a
 * name-filtered run scopes to exactly the suite `npm test` would run. */
const TEST_GLOB = "test/**/*.test.ts";
/** The suite's per-process temp-dir reaper (W1-T131), passed on EVERY direct `node --test` spawn this module builds.
 *  Relative like every reference site, because node resolves `--import` from the spawn's cwd, which {@link
 *  execWhitelistedProof} pins to the PR-head checkout; must sort AFTER `--import tsx`, whose loader lets node parse
 *  the `.ts` setup file at all.
 *  // Why: the proof executor omitted it and leaked one OS-tmpdir dir per fixture — 53,310 `rmd-*` dirs growing
 *  // ~200/min ENOSPC-crash-looped the daemon (2026-08-03, plan/feedback/fb-1785807201821-e4c9dc.yaml). */
const TMP_HYGIENE_IMPORT = "./test/setup/tmp-hygiene.ts";

/** True when a proof's TEXT is written in a recognised house dialect — meant to be executed
 *  (`grep:`/`unit test:`, W1-T72) or an on-the-record declaration that no execution will occur
 *  (`demonstration:`, W1-T277). Independent of whether {@link parseWhitelistedProof} accepted it.
 *  Used ONLY for the `floorDegraded` legibility signal; it never affects execution. */
export function isDialectPrefixed(proof: string): boolean {
  const trimmed = proof.trim();
  return DIALECT_GREP_RE.test(trimmed) || DIALECT_TEST_RE.test(trimmed) || DIALECT_DEMO_RE.test(trimmed);
}

/** True when a proof's TEXT is written in the `demonstration:` dialect (W1-T277) — the single source
 *  of truth task-linter.ts imports rather than redeclaring {@link DIALECT_DEMO_RE}, so the
 *  verify:human-only legality it enforces cannot drift from what review.ts recognises. */
export function isDemonstrationProof(proof: string): boolean {
  return DIALECT_DEMO_RE.test(proof.trim());
}

/** True when a proof's text carries a `grep:`/`unit test:` LABEL, under the same code-span
 *  normalisation {@link parseWhitelistedProof} applies. ONLY meaningful for a proof that function
 *  already refused: it is what makes THAT refusal an AUTHORING ERROR (`dialect-parse-error`,
 *  W1-T305) rather than ordinary prose. Excludes `demonstration:`, whose refusal is intended. */
function isMalformedDialectProof(proof: string): boolean {
  const trimmed = proof.trim();
  const dialectSource = matchesDialectPrefix(trimmed) ? trimmed : stripCodeSpan(trimmed);
  if (DIALECT_DEMO_RE.test(dialectSource)) return false;
  return DIALECT_GREP_RE.test(dialectSource) || DIALECT_TEST_RE.test(dialectSource);
}

/** Sentence-level punctuation a bare test-name title would not carry: a
 * comma, colon, semicolon, parenthetical aside, an em/en dash, or an
 * ellipsis. Any one of these marks a body as PROSE, not a plain title. */
const PROSE_PUNCTUATION_RE = /[,;:()]|--|—|–|\.\.\./;
/** Above this length a body reads as a description, not a plausible bare
 * test title, regardless of punctuation (a title this long is prose). */
const BARE_TEST_NAME_MAX_LEN = 60;

/** Does a name-filtered `unit test:` proof BODY read as a long PROSE DESCRIPTION of behaviour — the house convention
 *  — rather than a short, bare TEST-NAME-shaped string (W1-T161, #349/W1-T149)? {@link judgeCriterion} uses it ONLY
 *  to interpret a ZERO-MATCH outcome: prose degrades to `not_executable`, a bare name stays `executed_fail`
 *  (W1-T72's guard, preserved). A pure length and punctuation check, no model call.
 *  // Why: #349's own proof paraphrased a REAL, PASSING test in different words, matched zero tests, and minted an
 *  // `executed_fail` that hard-blocked a green PR (W1-T149). */
export function looksLikeProseDescription(body: string): boolean {
  const trimmed = body.trim();
  if (trimmed.length > BARE_TEST_NAME_MAX_LEN) return true;
  return PROSE_PUNCTUATION_RE.test(trimmed);
}

/** Split a `grep:` body into pattern and optional path. The path is the trailing token after the
 *  LAST `\s+in\s+` boundary that itself looks like a path or glob, which keeps a multi-word pattern
 *  intact while still splitting "... in src/lib/config.ts". No such boundary means the body carries
 *  no TARGET and {@link parseDialectGrep} refuses it (W1-T219). */
const DIALECT_GREP_PATH_RE = /^(.*?)\s+in\s+(\S*[./*]\S*)$/i;

/** (R-12) The one-line statement of what a `grep:` proof may target, quoted verbatim by every
 *  surface that refuses a directory-shaped target — the parser, `rmd check-proof`'s refusal line,
 *  and the filing-time linter's `proof-grep-safety` violation — so an author reads the same
 *  sentence wherever the refusal lands. */
export const GREP_PROOF_FILE_TARGET_REQUIREMENT =
  "a `grep:` proof must name a FILE (a path whose final segment carries an extension, e.g. " +
  "src/lib/plan.ts) — a directory target is not a proof of anything specific";

/** Does a `grep:` target NAME NO FILE — is it directory-shaped (R-12)? A directory is not proof of anything
 * SPECIFIC: `grep: foo in src` is W1-T219's refused whole-repo search wearing a path. THE RULE IS TEXTUAL BECAUSE THE
 * PARSE IS PURE — the final segment must carry an extension — so an extensionless FILE (`bin/rmd`) is refused too and
 * a dotted DIRECTORY (`plan/tasks.d`) is caught by {@link assertGrepTargetIsFile} instead.
 * // Why: `-r` made a directory target work at head while the base check materialised a TREE LISTING as a FILE,
 * // grading `discriminates` even where the pattern existed at base (docs/forensics/review.md). */
export function grepProofTargetNamesNoFile(path: string): string | undefined {
  const finalSegment = path.replace(/\/+$/, "").split("/").pop() ?? "";
  if (finalSegment.includes(".")) return undefined;
  return `target \`${path}\` names no file — ${GREP_PROOF_FILE_TARGET_REQUIREMENT}`;
}

/** WHY a `grep:` proof body failed to parse, as one sentence for a human (R-12) — `undefined` when
 *  it parses or is not a `grep:` proof. `rmd check-proof` prints it beside its `parse: REFUSED`
 *  line, which used to name no cause. The parser still returns `null` and its callers still grade
 *  that as prose/`dialect-parse-error`: that contract is unchanged. */
export function explainGrepProofRefusal(proof: string): string | undefined {
  const m = proof.trim().match(/^grep:\s*([\s\S]*)$/i);
  if (!m) return undefined;
  const trimmed = m[1].trim();
  if (!trimmed) return "empty `grep:` body — nothing to search for";
  const withPath = trimmed.match(DIALECT_GREP_PATH_RE);
  if (!withPath) return "no `in <path>` clause — a `grep:` proof needs an explicit file target (W1-T219)";
  const path = withPath[2];
  if (path.includes("..")) return `target \`${path}\` traverses out of the checkout (\`..\`)`;
  if (isAbsolute(path)) return `target \`${path}\` is an absolute path — a proof may only read files the PR head contains`;
  if (path.includes("*")) return `target \`${path}\` carries a glob (\`*\`), which execFile never expands`;
  return grepProofTargetNamesNoFile(path);
}

function parseDialectGrep(body: string): WhitelistedProof | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  const withPath = trimmed.match(DIALECT_GREP_PATH_RE);
  const pattern = (withPath ? withPath[1] : trimmed).trim();
  const path = withPath ? withPath[2] : undefined;
  // No shell-metacharacter check on `pattern` (W1-T128): it becomes a single argv element passed to execFile, never a
  // shell, so `; & \` $ < >` are inert here, and refusing prose for carrying one was the defect that task fixed. `--`
  // below already stops a pattern being read as a flag.
  if (!pattern) return null;
  // A `grep:` proof with NO `in <path>` clause is refused (W1-T219, recon R-13(iii)). It used to default to a
  // recursive whole-repo search, where one incidental match ANYWHERE certified the criterion, because `executed_pass`
  // positively overrides keyword coverage — and weakening that override is what would make real observation
  // untrustworthy (W1-T65/#100), so the target is required instead and an unscoped proof stays on the keyword floor.
  if (path === undefined) return null;
  // The grep TARGET is the one place a real hazard survives execFile: the executor runs
  // `grep -arn -- <pattern> <path>` with cwd pinned to the PR-head CHECKOUT, so a target naming a file the review
  // host can read but the checkout does not contain turns a proof into a match/no-match ORACLE over that host
  // filesystem, repeatable because a body edit re-earns review on the same head. WHAT THIS LINE REFUSES, STATED
  // HONESTLY (R-18): the two escapes VISIBLE IN THE PROOF TEXT, a `..` segment and an ABSOLUTE path. A target
  // resolving out through a SYMLINK is invisible here — nothing distinguishes `escape/secret.txt` from an in-tree
  // path — and is refused against the real filesystem in {@link assertGrepTargetsInsideCheckout}.
  if (path.includes("..")) return null;
  if (isAbsolute(path)) return null;
  // No shell here (execFile) ⇒ no glob expansion — a literal '*' target can
  // never resolve to a real file and would always exit non-zero, silently
  // manufacturing a spurious executed_fail. Refuse rather than run it.
  if (path.includes("*")) return null;
  // (R-12) A DIRECTORY-SHAPED target is refused — see {@link grepProofTargetNamesNoFile}. This parse has no cwd, so
  // it can only see the SHAPE; a real directory whose name carries a dot (`plan/tasks.d`) is refused against the
  // checkout, in {@link assertGrepTargetIsFile}.
  if (grepProofTargetNamesNoFile(path) !== undefined) return null;
  // `-r` is a no-op on a plain FILE target, kept only so the emitted argv stays byte-identical for every file proof
  // already written (test/proof-engine-declaration pins `["-arn", "--", pattern, path]`). `-a` makes the verdict
  // INDEPENDENT OF THE HOST'S GREP: without it a NUL byte makes BSD grep exit 0 with "Binary file … matches" where
  // ugrep exits 1, and it can only widen.
  // // Why: `grep: export function callSiteViolations in src/lib/task-linter.ts` (#1071) hit exactly
  // // that, and task-linter.ts is one of the two source files carrying a NUL byte.
  return { kind: "grep", command: "grep", args: ["-arn", "--", pattern, path], label: `${pattern} in ${path}` };
}

/** The TARGET PATH of a HOUSE-dialect `grep:` proof, or `undefined` for any other shape (W1-T2737).
 *  {@link parseDialectGrep} compiles to a fixed `["-arn", "--", pattern, path]` argv, so the path is
 *  the last element and nothing else can occupy it; the LEGACY fenced form passes the author's own
 *  argv through, which {@link proofEngineDivergenceViolations} already reports as engine-ambiguous,
 *  so this declines rather than guessing. */
function dialectGrepTargetPath(w: WhitelistedProof): string | undefined {
  if (w.kind !== "grep" || w.authorSelectedArgv === true) return undefined;
  if (w.args.length !== 4 || w.args[0] !== "-arn" || w.args[1] !== "--") return undefined;
  return w.args[3];
}

/** Compile a `unit test:` dialect body — either a literal test-file path (reusing the exact-file
 *  shape verbatim) or a bare TEST NAME, name-filtered across the whole suite glob. */
function parseTestTarget(body: string): WhitelistedProof | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  if (TEST_PATH_EXACT_RE.test(trimmed)) {
    if (trimmed.includes("..")) return null; // no path traversal out of the checkout
    return {
      kind: "test",
      command: "node",
      args: ["--test", "--import", "tsx", "--import", TMP_HYGIENE_IMPORT, trimmed],
      label: trimmed,
    };
  }
  // No shell-metacharacter check on a bare TEST NAME (W1-T128): it is one `--test-name-pattern` argv value passed to
  // execFile and this branch names no file, so there is no traversal or glob surface; refusing prose for a semicolon
  // was the biggest single cause of the dead proof floor. TRAP (W1-T112 round 3): that flag compiles its argument as
  // a REGEX, so a title echoing real syntax becomes an unescaped CHARACTER CLASS and manufactures a FAIL.
  return {
    kind: "test",
    command: "node",
    args: [
      "--test",
      "--import",
      "tsx",
      "--import",
      TMP_HYGIENE_IMPORT,
      "--test-name-pattern",
      escapeRegExp(trimmed),
      TEST_GLOB,
    ],
    label: trimmed,
    nameFiltered: true,
  };
}

/** Tokenise a fenced shell-like command, honoring simple `"…"` / `'…'` quoting. No
 * escape sequences (a proof needing one is simply not whitelisted — fine). */
function tokenizeFenced(s: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) tokens.push(m[1] ?? m[2] ?? m[3]);
  return tokens;
}

/** Parse a proof for a whitelisted, mechanically-executable shape. `null` for free prose or an unsafe shape — the
 *  caller then defers entirely to the keyword floor. */
/** WHY this verdict is capped, as one short token for the ledger line and the posted status. A CAPPED `0/N` is four
 *  situations wearing one face: proofs that never parsed, proofs that parsed and named nothing, proofs whose
 *  execution errored, and a run with no checkout. PURE and DIAGNOSTIC.
 *  // Why: telling those four apart from outside cost a full recon once — the markdown code-span defect behind
 *  // #1037's 0/4 and #1057's 0/6 (docs/forensics/review.md). */
export function cappedReason(
  criteria: ReadonlyArray<Pick<CriterionVerdict, "proof_exec" | "proof_skip">>,
): string | undefined {
  const skipped = criteria.filter((c) => c.proof_skip !== undefined);
  if (skipped.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const c of skipped) counts.set(c.proof_skip!, (counts.get(c.proof_skip!) ?? 0) + 1);
  // Deterministic: highest count first, then alphabetically, so the same verdict always renders the
  // same string (a ledger field that reorders itself is not comparable across runs).
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, n]) => `${reason}:${n}`)
    .join(",");
}

/** A `grep:` pattern WHOLLY enclosed in a matching pair of delimiters (W1-T2544) — a Markdown artifact, never what
 *  the author meant, since `grep -arn --` runs with no `-F` and a delimiter is then a character that must appear in
 *  the file. DISTINCT FROM {@link parseWhitelistedProof}'s code-span strip, which unwraps the WHOLE proof: this is
 *  the pattern INSIDE an otherwise well-formed proof, which parses perfectly and then matches nothing. EXACT, NEVER
 *  A HEURISTIC.
 *  // Why: two retro cycles six hours apart wrapped patterns in double quotes (#3356) and backticks (#3413); every
 *  // wrapped pattern read 0 and every bare one read 1. */
export function wrappedGrepPattern(proof: string): { delimiter: string; bare: string } | undefined {
  const m = /^\s*grep:\s*(.+?)\s+in\s+\S+\s*$/.exec(proof ?? "");
  if (!m) return undefined;
  const pattern = m[1].trim();
  for (const d of ["`", '"', "'"]) {
    if (pattern.length > 2 && pattern.startsWith(d) && pattern.endsWith(d)) {
      const bare = pattern.slice(1, -1);
      // A delimiter surviving inside the stripped text means this was not a simple wrap.
      if (bare.length > 0 && !bare.includes(d)) return { delimiter: d, bare };
    }
  }
  return undefined;
}
export function parseWhitelistedProof(proof: string): WhitelistedProof | null {
  // House dialect (W1-T72) checked FIRST and EXCLUSIVELY: a proof with a dialect label is handled ONLY by its own
  // parser and never falls through to a legacy shape. Falling through would let a dialect body that fails its own
  // safety check — or names a pattern containing a `test/*.test.ts`-shaped substring — be reinterpreted by an
  // unrelated legacy match: `grep: TODO in test/foo.test.ts` must run the GREP, not "run that whole test file
  // instead".
  const trimmed = proof.trim();
  // A dialect proof wrapped in a markdown CODE SPAN is the same proof. `parseAcceptanceBlock` extracts bullet text
  // verbatim, so `` `grep: x in y` `` reached the matchers with a leading backtick and fell through to
  // `not_executable` — a CAPPED 0/N verdict on perfect proofs. THE STRIP IS A FALLBACK, NOT AN ENTRY-POINT
  // NORMALISATION, because `GREP_FENCE_RE` REQUIRES its backticks: bare text is tried first.
  // // Why: #1037 parsed 0/4 and #1057 0/6 that way while #1038's unwrapped proofs parsed 8/8.
  const dialectSource = matchesDialectPrefix(trimmed) ? trimmed : stripCodeSpan(trimmed);
  const dialectTest = dialectSource.match(DIALECT_TEST_RE);
  if (dialectTest) return parseTestTarget(dialectTest[1]);
  const dialectGrep = dialectSource.match(DIALECT_GREP_RE);
  if (dialectGrep) return parseDialectGrep(dialectGrep[1]);
  // `demonstration:` is never executable by construction (W1-T277) — it names an operator action, not an artifact
  // this process can observe. Refuse rather than falling through to a legacy shape; task-linter.ts decides whether
  // that null is a defect (verify:auto) or the whole point (verify:human), since review.ts has no `verify` field to
  // consult.
  if (DIALECT_DEMO_RE.test(dialectSource)) return null;

  // Legacy strict shapes (W1-T65) — only reached when the proof carries no
  // dialect label at all.
  const testMatch = proof.match(TEST_PATH_RE);
  if (testMatch) {
    const path = testMatch[0];
    if (path.includes("..")) return null; // no path traversal out of the checkout
    return {
      kind: "test",
      command: "node",
      args: ["--test", "--import", "tsx", "--import", TMP_HYGIENE_IMPORT, path],
      label: path,
    };
  }

  const grepMatch = proof.match(GREP_FENCE_RE);
  if (grepMatch) {
    const fenced = grepMatch[1];
    if (UNSAFE_FENCE_CHARS_RE.test(fenced)) return null; // shell metacharacters ⇒ refuse, not sanitize
    const tokens = tokenizeFenced(fenced);
    if (tokens[0] !== "grep" || tokens.length < 2) return null;
    return { kind: "grep", command: "grep", args: tokens.slice(1), label: fenced, authorSelectedArgv: true };
  }
  return null;
}

/** Executes a {@link WhitelistedProof}'s argv and reports the outcome — injectable so unit tests
 *  fake pass/fail/no-match/throw without touching the filesystem. `"no-match"` (name-filtered proofs
 *  only) means the run completed but ZERO tests matched: NOT a failing test, so the caller degrades
 *  it to `not_executable` rather than a false `executed_fail`. */
export type ProofExecutor = (whitelisted: WhitelistedProof, cwd: string) => "pass" | "fail" | "no-match";

// The proof timeout is a POLICY READ (plan/policy.yaml's `proofTimeoutMs`), never a source literal (W1-T253, P37
// CONSUMERS), floored at load by policy.ts's `numberField`, so a retune is a reviewed plan PR rather than a code
// edit, and `loadDefaultPolicy` self-locates the file from this module's install location. Drift against a source
// literal is structurally unreachable once the code reads the policy, so test/policy.test.ts drops its one drift
// assertion and test/policy-consumers.test.ts asserts the stronger property.
// // Why: 30s was observed truncating a name-filtered proof's whole-suite run (W1-T112 round 4).
function defaultProofTimeoutMs(): number {
  return loadDefaultPolicy().values.proofTimeoutMs;
}
const npmCiPrimed = new Set<string>();
/** Process-wide latch for {@link ensureBrowsersOnce} — see its doc comment for why
 * this is NOT keyed by cwd the way {@link npmCiPrimed} is. */
let browserPreflightDone = false;

/** The ONE process spawn a proof execution performs — the test/grep run itself.
 * Injectable so a test can prove, by COUNTING, that a fast-failed proof never
 * spawns the runner at all; timing that would only prove it was quick. */
export type ProofSpawner = (command: string, args: readonly string[], cwd: string, timeoutMs: number) => string;

/** The ONLY env vars {@link defaultProofSpawner} lets through into a proof's child (W1-T499): `PATH`, `HOME`, and the
 * four `GIT_CONFIG_*` names plus `GIT_TERMINAL_PROMPT`, which `test/entrypoint-boot.test.ts` sets DELIBERATELY.
 * Everything else is EXCLUDED BY DEFAULT — every `RMD_*` var a daemon carries, `RMD_RESTART_THROTTLE_S` the example
 * that measured it — so the reviewer and CI cannot disagree on one sha for a reason unrelated to the diff. */
export const PROOF_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "GIT_TERMINAL_PROMPT",
] as const;

/** The `GIT_CONFIG_*` keys {@link buildProofEnv} only ever forwards TOGETHER (W1-T1096). This allowlist names index 0
 *  and nothing higher, so a parent's `GIT_CONFIG_COUNT` of two or more describes pairs it cannot supply — and git
 *  reads the count first, then demands every `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` it names, so forwarding a
 *  count without its pairs makes git exit 128 before doing any work: strictly worse than forwarding no count. */
const GIT_CONFIG_TRIPLE = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"] as const;

/** Build the DECLARED child environment {@link defaultProofSpawner} passes to a proof: only the {@link
 *  PROOF_ENV_ALLOWLIST} keys present on `parent`, never `parent` wholesale. Exported so a test can compare the env
 *  two differently-shaped orchestrator environments produce. INVARIANT: the {@link GIT_CONFIG_TRIPLE} crosses only as
 *  a consistent unit (W1-T1096) — never a partial forward. */
export function buildProofEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  const tripleIsConsistent =
    parent.GIT_CONFIG_COUNT === "1" &&
    typeof parent.GIT_CONFIG_KEY_0 === "string" &&
    typeof parent.GIT_CONFIG_VALUE_0 === "string";
  for (const key of PROOF_ENV_ALLOWLIST) {
    if ((GIT_CONFIG_TRIPLE as readonly string[]).includes(key) && !tripleIsConsistent) continue;
    const val = parent[key];
    if (typeof val === "string") child[key] = val;
  }
  return child;
}

/** Production {@link ProofSpawner}: no shell, stdout captured, hard timeout, and a DECLARED env ({@link
 *  buildProofEnv}) rather than an implicit inherit of `process.env` (W1-T499). Exported (W1-T387) so
 *  `checkProofCommand` can wrap it for diagnostics, never for the verdict. TRAP: `NODE_V8_COVERAGE: undefined`
 *  closes a side channel the allowlist cannot, because Node force-injects that var into every child even when given
 *  an `env` that omits the key.
 *  // Why: passing no `env` key let a proof inherit the orchestrator's whole environment (W1-T499). */
export const defaultProofSpawner: ProofSpawner = (command, args, cwd, timeoutMs) =>
  execFileSync(command, args as string[], {
    cwd,
    env: { ...buildProofEnv(), NODE_V8_COVERAGE: undefined },
    stdio: ["ignore", "pipe", "ignore"],
    timeout: timeoutMs,
    encoding: "utf8",
  });

/** `npm ci` a fresh checkout ONCE before its first test proof, since fresh worktrees have no
 *  node_modules. Best-effort: a failed or skipped install is never a silent hard-fail here, because
 *  the test command will itself fail to run and surface as exec_error, never a false pass. */
function ensureDeps(cwd: string): void {
  if (npmCiPrimed.has(cwd)) return;
  npmCiPrimed.add(cwd); // mark attempted regardless of outcome — never retry-storm a cwd
  if (!existsSync(join(cwd, "package.json")) || existsSync(join(cwd, "node_modules"))) return;
  try {
    execFileSync("npm", ["ci"], { cwd, stdio: "pipe", timeout: 120_000 });
  } catch {
    /* best-effort priming; see doc comment above */
  }
}

/** The Chromium builds a `test` proof needs on THIS host, derived from the pinned Playwright's own `browsers.json` —
 * the same source `npx playwright install` reads, so the two cannot disagree. Scoped to the Chromium family, the only
 * browser this repo's suites launch; the `-` → `_` rewrite is Playwright's on-disk convention, so
 * `chromium-headless-shell` rev 1234 lives in `chromium_headless_shell-1234` and `chromium` rev 1234 in
 * `chromium-1234`.
 * // Why: `ci` installs before every test job and the review host never did, so #863's bump made every
 * // `chromium.launch()` die and post `executed_fail` on code `ci` was passing (#892). */
export function requiredChromiumDirs(browsersJsonText: string): string[] {
  const parsed = JSON.parse(browsersJsonText) as { browsers?: { name?: string; revision?: string | number; installByDefault?: boolean }[] };
  const wanted = [];
  for (const b of parsed.browsers ?? []) {
    if (b.installByDefault !== true) continue; // tip-of-tree channels are opt-in; never auto-fetch one
    if (b.name !== "chromium" && b.name !== "chromium-headless-shell") continue;
    if (b.revision === undefined) continue;
    wanted.push(`${b.name.replace(/-/g, "_")}-${b.revision}`);
  }
  return wanted;
}

/** Everything {@link ensureBrowsers} touches outside itself, injected so the
 * decision logic is provable without a filesystem, a network fetch, or a 180MB
 * download. */
export interface BrowserPreflightDeps {
  /** The pinned Playwright's `browsers.json`, or null when it could not be read
   * (no `node_modules` yet, a truncated install) — NOT evidence of anything. */
  browsersJsonText: string | null;
  /** True when `<cacheRoot>/<dir>` holds a COMPLETE install. Playwright writes an
   * `INSTALLATION_COMPLETE` marker last, so a half-extracted directory that would
   * fail to launch reads as absent here rather than as present. */
  isInstalled: (dir: string) => boolean;
  /** Fetch the missing builds (production: `npx playwright install chromium`). */
  install: () => void;
  log?: (msg: string) => void;
}

/** Mirror `ci`'s browser-install step on the review host, ONCE per process, before the first `test` proof runs — see
 *  {@link requiredChromiumDirs} for the incident this closes. Best-effort by the same doctrine as {@link ensureDeps}:
 *  it never throws and never decides a verdict, because a preflight that could fail a criterion would relocate the
 *  false-FAIL problem it removes. Returns a FACT: `"ok"`, `"installed"`, `"failed"`, or `"unreadable"`. */
export function ensureBrowsers(deps: BrowserPreflightDeps): "ok" | "installed" | "failed" | "unreadable" {
  if (deps.browsersJsonText === null) return "unreadable";
  let required: string[];
  try {
    required = requiredChromiumDirs(deps.browsersJsonText);
  } catch {
    return "unreadable"; // malformed manifest — same "we cannot know" class as an unreadable one
  }
  const missing = required.filter((dir) => !deps.isInstalled(dir));
  if (missing.length === 0) return "ok";
  deps.log?.(`(browser preflight: installing Chromium for the pinned Playwright — missing ${missing.join(", ")})`);
  try {
    deps.install();
  } catch (e) {
    deps.log?.(`(browser preflight: install FAILED — ${String((e as Error)?.message ?? e)}; browser proofs may report exec_error)`);
    return "failed";
  }
  return "installed";
}

/** Production {@link ensureBrowsers} wiring, memoised per process — the browser
 * cache is HOST-global (not per-checkout like `node_modules`), so one check per
 * review process covers every proof it goes on to run. */
function ensureBrowsersOnce(cwd: string): void {
  if (browserPreflightDone) return;
  browserPreflightDone = true; // attempted regardless of outcome — never retry-storm a download
  const manifest = join(cwd, "node_modules", "playwright-core", "browsers.json");
  ensureBrowsers({
    browsersJsonText: existsSync(manifest) ? readFileSync(manifest, "utf8") : null,
    isInstalled: (dir) => existsSync(join(playwrightCacheRoot(), dir, "INSTALLATION_COMPLETE")),
    install: () => installPinnedChromium(cwd),
    log: (m) => console.log(m),
  });
}

/** The checkout's OWN Playwright CLI entry. Deliberately not `npx playwright`: `npx` resolves a
 *  name and on a cache miss will happily FETCH a different Playwright than the one pinned here,
 *  installing a browser revision the tests do not want — the exact drift this preflight exists to
 *  end. Running the pinned CLI with the already-running `node` binary pins both halves. */
export function pinnedPlaywrightCli(cwd: string): string {
  return join(cwd, "node_modules", "playwright", "cli.js");
}

// diff-cov: process-boundary — the irreducible browser download. A unit test cannot execute a
// 180MB fetch; the argv it builds is asserted by pinnedPlaywrightCli's own tests, and every
// decision about WHETHER to call this lives in ensureBrowsers, which is fully covered.
function installPinnedChromium(cwd: string): void {
  execFileSync(process.execPath, [pinnedPlaywrightCli(cwd), "install", "chromium"], {
    cwd,
    stdio: "pipe",
    timeout: 600_000,
  });
}

/** Where Playwright keeps its browser builds. `PLAYWRIGHT_BROWSERS_PATH` wins when set to a real
 *  path, which is how CI images relocate the cache; the literal `"0"` means "inside node_modules"
 *  and is NOT a directory, so it falls through to the platform default exactly as Playwright's own
 *  resolution does. */
export function playwrightCacheRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  home: string = homedir(),
): string {
  const override = env.PLAYWRIGHT_BROWSERS_PATH;
  if (override !== undefined && override !== "" && override !== "0") return override;
  if (platform === "darwin") return join(home, "Library", "Caches", "ms-playwright");
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "ms-playwright");
  return join(home, ".cache", "ms-playwright");
}

/** The three genuinely different answers to "which test file(s) could this name-filtered proof's raw name live in?",
 * kept distinct because two used to collapse into one empty array — acting on that ambiguity is how a reviewer
 * accuses an author of naming a test that does not exist when the truth is that WE COULD NOT LOOK. `resolved`: narrow
 * the run. `absent`: a readable, non-empty corpus was searched (control probe) and the name is in no file, so
 * `no-match` is safe. `unresolvable`: NOT evidence; fall back. */
export type NameFilterResolution =
  | { status: "resolved"; files: string[] }
  | { status: "absent" }
  | { status: "unresolvable"; reason: string };

/** ERE matching a test declaration whose title is a TEMPLATE LITERAL carrying at least one
 *  interpolation — the shape a fixed-string search structurally cannot find, because the title that
 *  reaches the TAP stream never appears verbatim in the source. */
const INTERPOLATED_TITLE_RE = "(test|it|describe)\\(`[^`]*\\$\\{";

/** Shortest static run of a template title we will treat as identifying. Short
 * fragments (`" "`, `"'s "`, `": "`) appear in almost any prose and would make
 * every absent test look ambiguous, which would disable the fast path entirely. */
const MIN_STATIC_CHUNK_LEN = 12;

/** The literal (non-interpolated) runs of a template-literal test title on one line of source:
 *  everything between the line's first and last backtick, split on `${…}` holes. These are the ONLY
 *  substrings of the rendered title a `grep -F` could have matched, so they are what a proof's raw
 *  name is compared against when deciding whether an interpolated title might be its home. */
export function interpolatedTitleStaticChunks(sourceLine: string): string[] {
  const first = sourceLine.indexOf("`");
  const last = sourceLine.lastIndexOf("`");
  if (first < 0 || last <= first) return [];
  return sourceLine
    .slice(first + 1, last)
    .split(/\$\{[^}]*\}/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length >= MIN_STATIC_CHUNK_LEN);
}

/** Could `rawName` be the RENDERED title of a test declared with an interpolated template literal?
 *  {@link resolveNameFilteredCandidates}'s `grep -F` cannot see one — the source holds `${…}`, the
 *  TAP stream the substituted value — so zero candidates over a repo that declares them is not
 *  automatically evidence of absence. Answers "maybe" only on positive evidence: some interpolated
 *  declaration has a static chunk of real length that the name contains. */
function couldBeInterpolatedTitle(cwd: string, rawName: string): boolean {
  let stdout: string;
  try {
    stdout = execFileSync("grep", ["-rhE", "--include=*.test.ts", "--", INTERPOLATED_TITLE_RE, "test"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
  } catch {
    // Only reached AFTER the corpus probe has established that grep runs and the test tree is readable, so a throw
    // here can only be grep's "no lines matched" — a real answer ("no"), not a failed lookup.
    return false;
  }
  return stdout.split("\n").some((line) => interpolatedTitleStaticChunks(line).some((c) => rawName.includes(c)));
}

/** `grep -rl -F` over the checkout's test files as a plain list, or `null` when grep produced none.
 *  Deliberately does NOT interpret the exit code: BSD grep exits 1 with EMPTY stderr both for
 *  "searched, found nothing" and for "the directory does not exist" (measured 2026-07-29), so the
 *  exit code cannot carry that distinction — {@link resolveNameFilteredCandidates} draws it with a
 *  control probe instead. */
function grepFilesContaining(cwd: string, fixedPattern: string): string[] | null {
  try {
    const stdout = execFileSync("grep", ["-rl", "-F", "--include=*.test.ts", "--", fixedPattern, "test"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

/** Resolve the CANDIDATE test file(s) a name-filtered proof's raw name could live in (W1-T227), so
 * {@link execWhitelistedProof} can scope its `node --test` run rather than compiling `--test-name-pattern` across the
 * whole {@link TEST_GLOB}, which node LOADS entirely before filtering. Fixed-string (`grep -F`), never a regex.
 * INVARIANT: "found nothing" and "could not look" are different claims and only the first licenses the caller's fast
 * path, so this returns a {@link NameFilterResolution}; the line is drawn by a CONTROL PROBE, never grep's exit code.
 * // Why: a narrowed run completes in 0.2s against a ~22s full-glob load on a 60s timeout, so one proof coins `executed_pass` on an idle host and `exec_error` on a loaded one (W1-T227). */
export function resolveNameFilteredCandidates(cwd: string, rawName: string): NameFilterResolution {
  const hits = grepFilesContaining(cwd, rawName);
  if (hits && hits.length > 0) return { status: "resolved", files: hits };
  // Zero hits. Everything below decides whether that is EVIDENCE or IGNORANCE.
  const corpus = grepFilesContaining(cwd, "");
  if (!corpus || corpus.length === 0)
    return { status: "unresolvable", reason: "no readable test corpus to search (grep, test/, or the checkout)" };
  // We could look, and did. Rule out the one thing a fixed-string search is
  // structurally blind to (TRAP 2): a title built from a template literal, which
  // never appears verbatim in the source that declares it.
  if (couldBeInterpolatedTitle(cwd, rawName))
    return { status: "unresolvable", reason: "an interpolated test title could render to this name" };
  return { status: "absent" };
}

/** W1-T227's command builder: swap the full {@link TEST_GLOB} in a compiled `baseArgs` for the candidates {@link
 *  resolveNameFilteredCandidates} found. ZERO candidates returns `baseArgs` verbatim, reached ONLY for an
 *  `unresolvable` resolution, where the slower run is honest.
 *  // Why: an earlier comment claimed zero candidates changes nothing; both halves were false — zero real matches on
 *  // a COMPLETED run returns `no-match`, not `fail`, and the wider search does NOT finish, because the full glob
 *  // loads files that drive a real headless browser and hang (2026-07-29). */
export function narrowNameFilteredArgs(baseArgs: readonly string[], candidateFiles: readonly string[]): string[] {
  if (candidateFiles.length === 0) return [...baseArgs];
  return [...baseArgs.filter((a) => a !== TEST_GLOB), ...candidateFiles];
}

/** The REAL proof executor: run a {@link WhitelistedProof}'s argv, no shell, in `cwd`, under a hard per-proof
 * timeout, so a hanging test can never stall the required check into the absent-check deadlock class. `"pass"` on a
 * clean exit 0; `"fail"` on a genuine clean nonzero exit. IT THROWS, so the caller surfaces `exec_error` and the
 * keyword floor, whenever the process never reached a clean verdict: a timeout kill or spawn error; a `grep` exit 2,
 * "could not look at all" as opposed to exit 1's "looked and found nothing" (W1-T219, recon R-13(iv)); or a PURE-PATH
 * `unit test:` proof's nonzero exit that is NOT a named-test failure (W1-T1077) — a failing test's `not ok` names the
 * TEST'S OWN TITLE, a broken runtime's names the FILE ITSELF, and BOTH exit 1. An ABSENT file stays `"fail"`.
 * NAME-FILTERED PROOFS NEVER USE THE EXIT CODE (W1-T178 round 2); the verdict comes from {@link nameFilteredOutcome}.
 * // Why: `test/serve.find.test.ts` runs its file-scope `after` when the pattern matched none of its tests. */
/** (R-18) Thrown for a `grep:` proof whose argv names a target that RESOLVES outside the checkout. {@link
 *  judgeCriterion} maps every throw to `exec_error`, so the refusal is CONTENT-INDEPENDENT, which is what closes the
 *  one-bit oracle {@link assertGrepTargetsInsideCheckout} describes. */
export class ProofTargetOutsideCheckoutError extends Error {
  constructor(
    readonly token: string,
    readonly resolvedPath: string,
    readonly checkoutDir: string,
  ) {
    super(
      `grep proof target \`${token}\` resolves to ${resolvedPath}, which is outside the checkout ` +
        `(${checkoutDir}) — a proof may only read files the PR head itself contains, so this run ` +
        "concluded nothing about the criterion (a symlink committed to the head, or an absolute " +
        "path in a legacy fenced invocation, is the usual cause)",
    );
  }
}

/** (R-18) REFUSE a `grep:` proof whose argv would read OUTSIDE the checkout, before the spawn. TRAP: grep FOLLOWS a
 * symlink named on its own command line, so one committed to the head (`escape -> /`) makes any file the reviewer's
 * uid can read a legal target, and the verdict reports one bit about its CONTENT — repeatable at will, because a
 * PR-body edit re-earns review on the same head sha (CLAUDE.md, "A BODY REPAIR IS A NEW REVIEW INPUT"). EVERY
 * NON-FLAG TOKEN IS CHECKED, since the legacy argv is whatever the author typed; a token absent from disk is
 * SKIPPED, because a missing target is already grep's exit 2. `realpathSync`, not `resolve`, sees through it. */
function assertGrepTargetsInsideCheckout(args: readonly string[], cwd: string): void {
  let root: string;
  try {
    root = realpathSync(cwd);
  } catch {
    root = resolve(cwd); // an unreadable cwd is the spawn's problem to report, not this check's
  }
  for (const token of args) {
    if (token.startsWith("-")) continue; // a flag, never a path operand (`--` included)
    let resolved: string;
    try {
      resolved = realpathSync(resolve(root, token));
    } catch {
      continue; // not a file on disk ⇒ a pattern, or an absent target grep itself reports (exit 2)
    }
    if (resolved === root || resolved.startsWith(root + pathSep)) continue;
    throw new ProofTargetOutsideCheckoutError(token, resolved, root);
  }
}

/** (R-12) Thrown for a house-dialect `grep:` proof whose target IS A DIRECTORY in the checkout.
 *  {@link grepProofTargetNamesNoFile} refuses the directory SHAPE at parse; a dotted name
 *  (`plan/tasks.d`) passes that check and is refused here against the real filesystem — the same
 *  two-layer split R-18 uses. A throw, never a verdict, so a directory proof is never certified
 *  `executed_pass` on `-r` finding one incidental line beneath it. */
export class ProofTargetIsDirectoryError extends Error {
  constructor(readonly target: string) {
    super(`grep proof target \`${target}\` is a directory in this checkout — ${GREP_PROOF_FILE_TARGET_REQUIREMENT}`);
  }
}

/** (R-12) Refuse a house-dialect `grep:` proof whose target resolves to a directory under `cwd`.
 *  Restricted to that shape on purpose: the legacy fenced argv is the author's own and its operands
 *  are not reliably recoverable. An ABSENT target is skipped — that is grep's own exit 2 ⇒
 *  `exec_error` (W1-T219), and pre-empting it here would change nothing. */
function assertGrepTargetIsFile(args: readonly string[], cwd: string): void {
  if (args[1] !== "--" || args.length !== 4) return;
  const target = args[3];
  let isDirectory: boolean;
  try {
    isDirectory = statSync(join(cwd, target)).isDirectory();
  } catch {
    return; // absent ⇒ grep's own exit 2 reports it (exec_error), exactly as before
  }
  if (isDirectory) throw new ProofTargetIsDirectoryError(target);
}

export function execWhitelistedProof(
  whitelisted: WhitelistedProof,
  cwd: string,
  timeoutMs = defaultProofTimeoutMs(),
  spawn: ProofSpawner = defaultProofSpawner,
): "pass" | "fail" | "no-match" {
  // A name-filtered proof's `args` still carry the FULL suite glob, so resolve the candidate file(s) now, against the
  // real PR-head checkout, and narrow before spawning node (W1-T227). Not folded into parseWhitelistedProof: that is
  // a pure parse with no `cwd`, and the candidate set can only be known against a real checkout.
  let args = whitelisted.args as readonly string[];
  if (whitelisted.nameFiltered) {
    const resolution = resolveNameFilteredCandidates(cwd, whitelisted.label);
    // FAIL FAST on positive evidence of absence: no test file contains this name and no interpolated title could
    // render to it, so the glob run's only possible finding is the same "no-match" — reached instead by loading 168
    // files, hanging on the browser-driving ones until the timeout kills them, leaking a chrome-headless-shell, and
    // reporting `exec_error`. `unresolvable` is NOT evidence and never lands here; it falls through to the full glob.
    if (resolution.status === "absent") return "no-match";
    args = narrowNameFilteredArgs(whitelisted.args, resolution.status === "resolved" ? resolution.files : []);
  }
  // AFTER the fast path on purpose: priming a checkout's node_modules is only
  // worth 120s of `npm ci` if we are actually going to run node. `ensureDeps` is
  // memoised per cwd, so a later proof in the same checkout still primes it.
  if (whitelisted.kind === "test") {
    ensureDeps(cwd);
    // Same "only when we are actually going to run node" placement as ensureDeps,
    // and for the same reason: a `grep` proof never launches a browser. See
    // requiredChromiumDirs for the false-FAIL incident this closes (PR #892).
    ensureBrowsersOnce(cwd);
  }
  // R-18: BEFORE the spawn, and outside the try on purpose — a target outside the checkout is not
  // an execution outcome to be classified below, it is a refusal to run the proof at all.
  if (whitelisted.kind === "grep") {
    assertGrepTargetsInsideCheckout(args, cwd);
    assertGrepTargetIsFile(args, cwd); // R-12: same placement, same reason — a refusal, not an outcome
  }
  try {
    const stdout = spawn(whitelisted.command, args, cwd, timeoutMs);
    if (whitelisted.nameFiltered) return nameFilteredOutcome(stdout);
    return "pass";
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { status?: number | null; stdout?: string | Buffer | null };
    // A TIMEOUT IS NOT A VERDICT, AND THE GUARD BELOW CANNOT SEE ONE (W1-T2742). `execFileSync` kills the child with
    // SIGTERM at `timeoutMs`, but `node --test` TRAPS SIGTERM and shuts down cleanly, so the error carries `status:
    // 1`, `signal: null`, `killed: undefined` — MEASURED — and reads as an ordinary nonzero exit, grading a merely
    // slow proof `executed_fail`. Node sets `code: "ETIMEDOUT"` regardless, so it is checked FIRST.
    if (err.code === "ETIMEDOUT") throw err; // ⇒ exec_error: ran out of time, concluded nothing
    if (typeof err.status !== "number") throw err; // killed by signal (timeout) / spawn error (ENOENT, …) ⇒ exec_error
    // A clean nonzero exit. For a name-filtered proof this does NOT necessarily
    // mean OUR named test failed (see the doc comment above) — read the TAP
    // stream node still attaches to the error rather than trusting the code.
    if (whitelisted.nameFiltered) {
      const stdout = typeof err.stdout === "string" ? err.stdout : (err.stdout?.toString("utf8") ?? "");
      return nameFilteredOutcome(stdout);
    }
    // grep exit 2 means it could not even LOOK — a renamed or missing target, a read error — distinct from exit 1's
    // "looked, found nothing" (W1-T219, recon R-13(iv)). Only the latter is evidence of absence; the former degrades
    // to exec_error rather than false-blocking on an environment or authoring problem.
    if (whitelisted.kind === "grep" && err.status === 2) throw err;
    // A PURE-PATH `unit test:` proof's clean nonzero exit is not automatically a genuine fail either (W1-T1077) — see
    // this function's doc for the measured TAP shapes. Read the SAME stdout the name-filtered branch reads; only when
    // every `not ok` line is the file's own wrapper name does the run count as never-executed. An absent file reports
    // no TAP lines at all, so this finds no wrapper name and falls through to the unchanged `"fail"`.
    if (whitelisted.kind === "test" && !whitelisted.nameFiltered) {
      const stdout = typeof err.stdout === "string" ? err.stdout : (err.stdout?.toString("utf8") ?? "");
      // AN INCOMPLETE RUN IS NOT A FAILING ONE (W1-T2740), read BEFORE the wrapper-name classifier on purpose: the
      // two discriminators are orthogonal and this one is stronger. `runtime-broken` describes a run that COMPLETED
      // and whose only `not ok` names the file itself; a stream with NO summary did not finish at all. NOT a request
      // to raise `proofTimeoutMs`: a larger bound only moves the same false verdict onto a slower file.
      // // Why: on #3719 `unit test: test/retro-marker-atomic.test.ts` posted `executed_fail` while the same
      // // checkout passed all 33 tests in 127s unrestricted — killed at 60s, no `not ok`, no `# duration_ms`.
      const completedResults = pureTestIncompleteRunResultCount(stdout);
      if (completedResults !== undefined) throw new PureProofIncompleteRunError(completedResults);
      const wrapperName = pureTestNeverExecutedWrapperName(stdout);
      if (wrapperName !== undefined) throw new PureProofNeverExecutedError(wrapperName);
    }
    return "fail"; // a single-file/grep proof's own nonzero exit is a genuine fail
  }
}

/** (W1-T1077) Thrown for a pure-path `unit test:` proof whose only failing TAP line names its own file wrapper — the
 *  run never reached a verdict about the criterion. {@link judgeCriterion} recognises it by `instanceof` and records
 *  `proof_skip: "runtime-broken"` plus the wrapper name parsed here: design (iv)'s "record the discriminator, not the
 *  stream", so the ledger carries a bounded fact rather than an unbounded TAP capture. */
class PureProofNeverExecutedError extends Error {
  constructor(readonly wrapperName: string) {
    super(
      `pure-path proof's file (${wrapperName}) never reached a real subtest — only its own TAP ` +
        "wrapper reported `not ok`, meaning the file failed to load/run as a whole (a broken " +
        "runtime: an unresolvable --import loader, an uncaught module-load error, …), not that the " +
        "test it names actually failed",
    );
  }
}

/** (W1-T2740) Thrown for a pure-path `unit test:` proof whose run emitted real subtest results and
 *  then stopped before node's trailing summary — an INCOMPLETE execution, not a verdict.
 *  {@link judgeCriterion} records `proof_skip: "incomplete-run"` plus the bounded discriminator,
 *  the same rule {@link PureProofNeverExecutedError} follows, for the same reason. */
class PureProofIncompleteRunError extends Error {
  constructor(readonly completedResults: number) {
    super(
      `pure-path proof's run reported ${completedResults} passing subtest(s) and then stopped ` +
        "before node's trailing `# duration_ms` summary — the run was cut off (a proof-timeout " +
        "kill reaped with a numeric status, an external signal, an OOM), so it never reached a " +
        "verdict about the criterion; inconclusive, not a failing test",
    );
  }
}

/** (W1-T2740) How many REAL (non-file-wrapper) subtest results a pure-path proof's TAP stdout carried when the run
 * is INCOMPLETE — at least one real result, NONE `not ok`, no trailing summary ({@link hasFinalSummary}). The three
 * `undefined` cases keep today's behaviour: a stream WITH a summary completed; a REAL `not ok` is an observed failure
 * either way; and NO real result means nothing was observed — an ABSENT path reports empty stdout, which would
 * otherwise read as a timeout. */
function pureTestIncompleteRunResultCount(stdout: string): number | undefined {
  if (hasFinalSummary(stdout)) return undefined; // the run reached its own completion signal
  let completed = 0;
  for (const line of stdout.split("\n")) {
    const m = TAP_RESULT_LINE_RE.exec(line);
    if (!m || isFileWrapperResultName(m[2])) continue; // a file's own trivial wrapper is not a real result
    if (m[1] === "not ok") return undefined; // a real subtest genuinely failed — evidence, not truncation
    completed += 1;
  }
  return completed > 0 ? completed : undefined;
}

/** (W1-T1077) A pure-path proof's own file wrapper name when EVERY `not ok` line in its TAP stdout
 *  names the file itself ({@link isFileWrapperResultName}, the same predicate {@link
 *  nameFilteredOutcome} uses) and no real subtest reported `not ok`. `undefined` otherwise: either a
 *  real subtest failed, or the stream carries no `not ok` at all (an absent file's measured empty
 *  stdout), so absence keeps falling through to the caller's ordinary `"fail"`. */
function pureTestNeverExecutedWrapperName(stdout: string): string | undefined {
  let wrapperName: string | undefined;
  for (const line of stdout.split("\n")) {
    const m = TAP_RESULT_LINE_RE.exec(line);
    if (!m || m[1] !== "not ok") continue;
    if (!isFileWrapperResultName(m[2])) return undefined; // a real subtest failed — genuine fail, untouched
    wrapperName = m[2];
  }
  return wrapperName;
}

/** A file's own trivial TAP wrapper line (`ok N - test/foo.test.ts`) reporting
 * itself when NONE of its internal tests matched `--test-name-pattern` — not a
 * real match, whichever way it reports. */
function isFileWrapperResultName(name: string): boolean {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name.trim());
}

/** `(not )?ok <n> - <name>` — a node TAP result line, possibly indented for a
 * nested subtest. Captures the pass/fail marker and the reported name. */
const TAP_RESULT_LINE_RE = /^\s*(ok|not ok) \d+ - (.+?)\s*$/;

/** The node test runner's trailing summary block (`# tests N`, `# pass N`, …, `# duration_ms N`) is
 *  written ONCE, after every file in the glob finishes. It is the one reliable signal that a
 *  `--test-name-pattern` run over {@link TEST_GLOB} ran to genuine completion rather than being cut
 *  off mid-suite by {@link execWhitelistedProof}'s own timeout kill. */
function hasFinalSummary(stdout: string): boolean {
  return /^# duration_ms\b/m.test(stdout);
}

/** Read a name-filtered run's TAP stdout for the verdict of the REAL (non-file-wrapper) subtests it matched,
 * independent of the process exit code. Zero real matches on a COMPLETED run ⇒ "fail" (W1-T72's guard: a named test
 * absent from the head is unmet, never a silent pass via the trivial "0 children ⇒ ok" wrapper). Zero real matches on
 * a run CUT SHORT before its trailing summary ⇒ THROWS (W1-T112 round 4), truncation being inconclusive rather than
 * evidence of absence. Collateral `not ok` lines from files the pattern never matched are ignored: their names ARE
 * wrapper names.
 * // Why: on the old rule truncation read identically to "test not found", so a criterion whose test sat late in
 * // discovery order flapped fail → pass → fail on this PR's own head commit, unchanged code. */
export function nameFilteredOutcome(stdout: string): "pass" | "fail" | "no-match" {
  let matched = false;
  let anyRealFailure = false;
  for (const line of stdout.split("\n")) {
    const m = TAP_RESULT_LINE_RE.exec(line);
    if (!m) continue;
    if (isFileWrapperResultName(m[2])) continue; // a file's own trivial wrapper, not a real match
    matched = true;
    if (m[1] === "not ok") anyRealFailure = true;
  }
  if (!matched) {
    if (!hasFinalSummary(stdout)) {
      throw new Error(
        "name-filtered proof run was truncated before its trailing summary (proof timeout) — " +
          "inconclusive, not evidence the named test is missing",
      );
    }
    // ZERO tests matched and the run COMPLETED (a trailing summary is present, so this is not a timeout). The named
    // test does not exist — a proof-authoring mismatch, NOT a failing test.
    // // Why: returning "fail" here minted a false `executed_fail` that hard-blocked PRs whose real
    // // tests pass under a different name; #466/W1-T183 sat blocked a day or more on it.
    return "no-match";
  }
  return anyRealFailure ? "fail" : "pass";
}

// ── The pure JUDGE ─────────────────────────────────────────────────────────

/** PR-head checkout a criterion's proof may be executed against (W1-T65). */
export interface ProofExecContext {
  cwd: string;
  exec?: ProofExecutor;
  /** (W1-T273) mirrors {@link ReviewEvidence.baseCheckoutDir} — the merge-base
   * checkout a `grep:` proof's pattern is re-run against to test for
   * non-discrimination. Absent ⇒ {@link preexistingProofHits} always reports
   * `false` and every grep proof that passes on `cwd` stays `executed_pass`. */
  baseCwd?: string;
  /** (W1-T460) mirrors {@link ReviewEvidence.baseUnreadablePaths} — the repo-relative paths whose
   *  base blob could NOT be read while `baseCwd` was built. A proof naming one was never actually
   *  checked against the base, however healthy `baseCwd` looks, so it is graded `base_unreadable`
   *  rather than credited with a discrimination nobody measured. */
  baseUnreadablePaths?: ReadonlySet<string>;
  /** (R-11) mirrors {@link ReviewEvidence.baseIsCheckout} — `true` only when `baseCwd` is a real
   * checkout of the merge-base (a worktree), the one tree a `unit test:` proof can be re-run in.
   * Absent/false ⇒ every `unit test:` proof's base outcome is `base_unknown` (fail closed), and
   * `grep:` proofs behave exactly as before. */
  baseIsCheckout?: boolean;
  /** (W1-T456, DEFECT A) Repo-relative paths a `unit test:` proof may forward-reference without
   *  being scored `executed_fail` — the union of {@link shardDeclaredFilesInDiff}'s read of THIS
   *  diff's own added shard(s) and, when a task id resolved, that task's declared `files:`. */
  forwardReferenceFiles?: ReadonlySet<string>;
  /** True when THIS diff changes only plan/docs — a FILING PR (W1-T2737), supplied from the same `planOnly` {@link
   *  judgeReview} computes, never re-derived. WHY THE GREP CARVE-OUT NEEDS IT AND THE `unit test:` ONE DOES NOT: on
   *  the BUILD PR the same paths are declared either way, but the `unit test:` arm is filing-scoped by its
   *  `!existsSync` half, while a call-site grep has no equivalent tell — the CONSUMER file exists in both worlds and
   *  only the CALL is missing. Without this flag the grep carve-out would excuse a build PR that shipped the module
   *  unwired, the class W1-T2732 counted four of. */
  planOnlyDiff?: boolean;
}

/** (W1-T273, extended to `unit test:` proofs by W1-T362) Does a proof that just PASSED on the PR head ALSO pass on
 * the MERGE-BASE? INVARIANT: a proof must discriminate done from not-done, and one that also passes at base
 * discriminates nothing while `executed_pass` POSITIVELY OVERRIDES the keyword floor — strictly worse than a prose
 * proof. `kind: "test"` needs one distinction `grep` does not: a `unit test:` proof legitimately names a file absent
 * at base (that is TDD), so {@link classifyBaseProofOutcome} treats "the base run did not pass" as `"discriminates"`.
 * // Why: W1-T267's fifth criterion grepped a symbol that already returned two hits before #1026. */
/** Materialise, into a throwaway directory, ONLY the base-revision blobs a review's `grep:` proofs name. (R-11) THE
 * FALLBACK, NO LONGER THE DEFAULT: `buildBaseProofDir` adds a real detached worktree and reaches this only when that
 * fails, where a `unit test:` proof is graded `base_unknown`. A PATH ABSENT AT THE BASE IS SIMPLY NOT WRITTEN — the
 * FORWARD-REFERENCE case, not staleness. (W1-T460) ABSENCE AND A BROKEN READ ARE NO LONGER THE SAME EVENT: a read
 * failure is RETURNED per path while absence keeps its carve-out ({@link baseBlobErrorIsAbsence}).
 * // Why: a blob directory is a tree `node --test` cannot run in, so 599 unit-test proofs graded "discriminates". */
export function materialiseBaseProofBlobs(
  criteria: ReadonlyArray<{ proof?: string }>,
  baseRev: string,
  showBlob: (rev: string, repoRelPath: string) => string,
  writeBlob: (repoRelPath: string, contents: string) => void,
): { written: number; unreadable: string[] } {
  let written = 0;
  const unreadable: string[] = [];
  const seen = new Set<string>();
  for (const c of criteria) {
    const parsed = c.proof ? parseWhitelistedProof(c.proof) : null;
    if (!parsed) continue;
    const repoRelPath = grepProofTargetPath(parsed);
    if (!repoRelPath || seen.has(repoRelPath)) continue;
    seen.add(repoRelPath);

    let contents: string;
    try {
      contents = showBlob(baseRev, repoRelPath);
    } catch (e) {
      // ABSENT AT BASE (forward reference) — the healthy case: leave it out, grep then finds
      // nothing, and the proof correctly reads as discriminating.
      if (baseBlobErrorIsAbsence(e)) continue;
      // THE READ ITSELF BROKE. Nothing can be concluded about the base for this path.
      unreadable.push(repoRelPath);
      continue;
    }
    try {
      writeBlob(repoRelPath, contents);
      written++;
    } catch {
      // The blob read fine but never reached the base tree, so the base grep would be just as
      // uninformative as a failed read — same fact, same honest outcome.
      unreadable.push(repoRelPath);
    }
  }
  return { written, unreadable };
}

/** (W1-T460) A `grep:` proof's compiled argv is `["-arn", "--", <pattern>, <path>]`, so the path is the LAST element
 *  — taken from the COMPILER rather than re-parsed from the proof text, so the two can never disagree. Shared by
 *  {@link materialiseBaseProofBlobs}, which keys the unreadable set by it, and {@link classifyBaseProofOutcome},
 *  which looks a proof up in that set, so blob and proof are matched BY CONSTRUCTION. */
function grepProofTargetPath(whitelisted: WhitelistedProof): string | undefined {
  if (whitelisted.kind !== "grep") return undefined;
  return whitelisted.args[whitelisted.args.length - 1];
}

/** (W1-T1071) Is an ALREADY-STALE `grep:` proof a FILING-TIME SELF-PATH proof read on the diff that BUILDS the task?
 * The house convention it recognises, measured across `plan/tasks.d/*.yaml`: a proof grepping a distinctive line of
 * the shard's OWN rationale back out of its own `plan/tasks.d/<id>-<slug>.yaml`, honest on the FILING PR and
 * permanently stale afterwards. TWO conditions, both required: the target is shaped like a plan-shard path ({@link
 * SHARD_PATH_RE}), and `declaredFiles` names something OTHER than it — the BY-CONSTRUCTION exemption for shards whose
 * entire deliverable IS their plan text, with no id ever hardcoded. */
function staleProofIsSelfPath(whitelisted: WhitelistedProof, declaredFiles: ReadonlySet<string> | undefined): boolean {
  const target = grepProofTargetPath(whitelisted);
  if (target === undefined || !SHARD_PATH_RE.test(target)) return false;
  if (!declaredFiles) return false;
  for (const p of declaredFiles) {
    if (p !== target) return true;
  }
  return false;
}

/** (W1-T460) Did `git show <rev>:<path>` fail because the path is NOT IN THAT REV, or because the read
 * itself broke? Measured against the installed git and locked by test/base-blob-read-failure.test.ts Group 0, so a
 * git upgrade that moves these shapes turns red: path absent at the rev → `code` undefined, `status` **128** (git ran
 * and answered "not there"); maxBuffer overflow → `code` **"ENOBUFS"**, `status` null. Git emits two absence MESSAGES
 * — one saying the path " does not exist in " '<rev>' at all, one saying it exists on disk but not in '<rev>' — but
 * both carry `status: 128`, so this never reads the text. FAILS CLOSED: anything unrecognised is a READ FAILURE,
 * because mis-classifying one as
 * absence re-creates the silent credit this task fixes. */
export function baseBlobErrorIsAbsence(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const err = e as { status?: unknown; code?: unknown };
  // A Node error code always wins: `spawnSync` sets it only when the spawn/read itself failed.
  if (err.code !== undefined) return false;
  return err.status === 128;
}

/** (W1-T362) The four ways a proof that already PASSED on the head can land when re-run against the merge-base.
 * `"stale"` — the base run ALSO passes, so it discriminates nothing. `"discriminates"` — anything else, so
 * `executed_pass` stands. `"base_unknown"` — the base run threw, an environment gap and never evidence; (R-11) also
 * every `unit test:` proof whose `baseCwd` is not a real checkout, because "no file here" is not "did not pass before
 * the work". `"base_unreadable"` — (W1-T460) a base tree EXISTS but {@link materialiseBaseProofBlobs} could not read
 * this proof's blob. THAT LAST IS NOT `base_unknown`: that is a GLOBAL gap, this a PER-PROOF one. */
function classifyBaseProofOutcome(
  whitelisted: WhitelistedProof,
  exec: ProofExecutor,
  baseCwd: string,
  baseUnreadablePaths?: ReadonlySet<string>,
  baseIsCheckout?: boolean,
): "stale" | "discriminates" | "base_unknown" | "base_unreadable" {
  const target = grepProofTargetPath(whitelisted);
  if (target !== undefined && baseUnreadablePaths?.has(target)) return "base_unreadable";
  // (R-11) A `unit test:` proof can only be re-run in a REAL checkout of the base. In the blob-only fallback
  // `node --test` finds no file, exits 1 with empty stdout, and the executor returns "fail" — which the line below
  // would grade `discriminates`, certifying a test that passes identically at both commits. That run answered nothing
  // about the base, so it is `base_unknown`. Fails closed on an absent flag.
  if (whitelisted.kind === "test" && baseIsCheckout !== true) return "base_unknown";
  try {
    // Only a run that genuinely COMPLETED with a non-pass result discriminates. A base run that could not execute at
    // all — a spawn ENOENT, a timeout, or the two `PureProof…Error` classes for a runner that never reached a real
    // subtest (a base worktree whose `npm ci` priming failed lands here: `--import tsx` cannot resolve, and the
    // file's own TAP wrapper is the only `not ok`) — THROWS out of `exec` and is caught below as `base_unknown`.
    return exec(whitelisted, baseCwd) === "pass" ? "stale" : "discriminates";
  } catch {
    return "base_unknown";
  }
}

export function preexistingProofHits(
  whitelisted: WhitelistedProof,
  exec: ProofExecutor,
  baseCwd: string | undefined,
  baseUnreadablePaths?: ReadonlySet<string>,
  baseIsCheckout?: boolean,
): boolean {
  if (baseCwd === undefined) return false;
  // Only `"stale"` is a hit, so an unreadable base blob answers `false` here exactly like every
  // other non-stale outcome — this guard never manufactures a false positive (W1-T460 changes
  // WHICH outcome is reported, never this function's never-a-false-positive contract).
  return classifyBaseProofOutcome(whitelisted, exec, baseCwd, baseUnreadablePaths, baseIsCheckout) === "stale";
}

/** Verdict one criterion against its proof, given the report + optional semantic. */
export function judgeCriterion(
  criterion: AcceptanceCriterion,
  reportTokens: Set<string>,
  semantic?: boolean,
  execCtx?: ProofExecContext,
  /** True when `reportTokens` came from a SUBSTITUTE — the worker's own chat text, not the PR body
   *  (W1-T1100). A worker echoes a proof's vocabulary while describing the change it just made, so
   *  coverage over a substitute is evidence the worker can read its own diff, not that the BODY
   *  substantiates anything. Whitelisted proof EXECUTION is unaffected: it observes repo state. */
  reportSubstituted?: boolean,
  /** A bounded trailing clause the reviewer attached to a FAIL line naming what would answer the
   * claim (W1-T2263). Consulted ONLY where `semantic === false && met`: it never rescues a proof
   * and never annotates a PASS. `undefined` leaves today's constant reason text as the whole note. */
  semanticClause?: string,
  /** WHY `reportSubstituted` is true -- consulted ONLY for the refusal's wording, never for the
   *  verdict. See {@link ReviewEvidence.reportSubstituteCause}. */
  reportSubstituteCause?: ReportSubstituteCause,
  /** WHICH TEXT OF THE CRITERION SUPPLIES THE FLOOR'S KEYWORDS. The floor's SOURCE is always the REPORT — the only
   * text the author writes independently of the criterion. INVARIANT: the floor may never read the text it is
   * judging. So the arm changes only WHICH keywords it scores: the CLAIM's, a fair pair of author-written prose,
   * where the proof's filename is the accident measured on #3665.
   * // Why: W1-T2713 shipped `floorTokens = tokenize(claim + proof)`, so coverage was 1.0 by construction and every
   * // resolved-shard criterion read `met` against any body, an empty one included (recon-2026-09-05 R-15). */
  floorKeywords: "proof" | "claim" = "proof",
): CriterionVerdict {
  const base = { claim: criterion.claim, proof: criterion.proof };

  // ARCHITECT-ONLY `satisfied_by`: a criterion already satisfied by an EARLIER PR is MET, cited to that PR. The
  // reviewer judges diff and report, never repo state, so without this an earlier-PR criterion is permanently
  // unsatisfiable by a later one. Setting it is a human act in a plan PR.
  if (criterion.satisfied_by) {
    return {
      ...base,
      met: true,
      reason: `satisfied by ${criterion.satisfied_by} (prior merge)`,
      proof_exec: "not_executable",
      holdout: !!criterion.holdout,
    };
  }

  // R-15: `floorTokens` is ALWAYS `reportTokens`. There is no arm that lets the floor read the
  // criterion it is judging — that is what made coverage 1.0 by construction. Only the KEYWORD
  // side varies, and both alternatives are text the criterion supplies, scored against the body.
  const kws = floorKeywords === "claim" ? proofKeywords(criterion.claim) : proofKeywords(criterion.proof);
  const floorTokens = reportTokens;

  // Mechanical floor: is the proof responsively present in the authoritative source?
  let met: boolean;
  let reason: string;
  if (kws.length === 0) {
    // A proof written entirely in short, stopword or numeric tokens has no distinctive anchor, and this used to be an
    // UNCONDITIONAL met=true: fail-OPEN, reachable by any author (W1-T219, recon R-13(ii); #123 had none). The floor
    // cannot observe anything for such a proof, so it resolves to UNMET, the same cannot-observe-implies-do-not-act
    // move W1-T119's `indeterminate` makes. `semantic` cannot rescue it; only real WHITELISTED execution below can.
    met = false;
    reason =
      `proof unmet: INDETERMINATE — no mechanical anchors in ${floorKeywords} text to check the report ` +
      "against (a claim with nothing distinctive to verify is not evidence; requires an executable proof)";
  } else {
    const covered = kws.filter((k) => floorTokens.has(k));
    const coverage = covered.length / kws.length;
    // R-15: this rule is no longer gated on the arm. Both arms now score against the report, so a
    // report that is NOT the body cannot substantiate either of them — the W1-T1100 refusal below
    // applies to a claim-keyword floor for exactly the reason it applies to a proof-keyword one.
    if (reportSubstituted) {
      // The floor may not report substantiation off a substitute, in EITHER direction of coverage (W1-T1100 design
      // (iii)): a high-coverage substitute is the #2395 fail-OPEN case, where the worker describes its own change in
      // the proof's own words. Rest on what proofs actually EXECUTED and name the missing body as the reason the
      // floor cannot say more.
      met = false;
      // THE VERDICT IS UNCHANGED — `met` is false in every branch below and coverage stays withheld in either
      // direction. Only the WORDING branches, and it must not imply a fetch failed: on the measured population the
      // fetch has never failed once, while "this mode never reads the body" is the common case.
      const withheld = `so keyword coverage (${covered.length}/${kws.length} ${floorKeywords} keywords) is withheld as substantiation`;
      if (reportSubstituteCause?.kind === "never-fetched") {
        const who = reportSubstituteCause.fixMode
          ? `the "${reportSubstituteCause.fixMode}" fix mode does not fetch it`
          : "this code path does not fetch it";
        reason = `proof unmet: the PR body was NOT read — ${who}, so this is the worker's own text rather than the body, ${withheld}`;
      } else if (reportSubstituteCause?.kind === "fetch-failed") {
        reason = `proof unmet: the PR body was fetched and the read FAILED, so this is the worker's own text rather than the body, ${withheld}`;
      } else {
        reason = `proof unmet: this is the worker's own text rather than the PR body (cause not recorded), ${withheld}`;
      }
    } else if (coverage < MIN_COVERAGE) {
      met = false;
      reason = `proof unmet: report does not substantiate it (matched ${covered.length}/${kws.length} ${floorKeywords} keywords)`;
    } else {
      met = true;
      reason = `proof substantiated in report (matched ${covered.length}/${kws.length} ${floorKeywords} keywords)`;
    }
  }

  // WHITELISTED PROOF EXECUTION (W1-T65, lifting W1-T3F's observation into the FLOOR): given a PR-head checkout and
  // an executable proof, RUN it and let the OBSERVED result override the keyword floor in BOTH directions —
  // `executed_pass` means MET even if the report never claimed it (kills #100), `executed_fail` means UNMET even if
  // the report keyword-claimed it (kills W1-T51). `exec_error` degrades to the keyword floor: never a silent
  // hard-fail.
  let proofExec: ProofExecOutcome = "not_executable";
  // W1-DH: WHY a criterion did not execute. `proof_exec: "not_executable"` alone conflates a proof
  // that never PARSED with one that parsed and named nothing — and a CAPPED 0/N verdict looked
  // identical either way, which is what made the code-span defect above cost a whole recon to find.
  let proofSkip: ProofSkipReason | undefined;
  if (execCtx) {
    const whitelisted = parseWhitelistedProof(criterion.proof);
    if (whitelisted) {
      proofSkip = undefined;
      // Checked BEFORE spawning anything (W1-T456, DEFECT A): an exact-path `unit test:` proof whose target is ABSENT
      // on the head but DECLARED by this diff's own plan shard is a forward reference, not a failure. Spawning
      // `node --test` on it exits nonzero, which the branch below reads as a genuine `executed_fail` — the hard block
      // that made a filing PR unrepairable. Gated on `!nameFiltered`: a bare test-NAME proof has no target path.
      const forwardReference =
        whitelisted.kind === "test" &&
        !whitelisted.nameFiltered &&
        execCtx.forwardReferenceFiles?.has(whitelisted.label) === true &&
        !existsSync(join(execCtx.cwd, whitelisted.label));
      // The same forward-reference judgement for the dialect `callSiteViolations` mandates (W1-T2737). Computed here
      // beside its `unit test:` sibling so the two conditions read together, but CONSUMED only in the post-execution
      // failure branch below. `planOnlyDiff` is the filing-scope half; an UNDECLARED path yields `undefined` and
      // keeps blocking, verbatim.
      const grepTarget = dialectGrepTargetPath(whitelisted);
      const grepForwardReferenceTarget =
        execCtx.planOnlyDiff === true && grepTarget !== undefined && execCtx.forwardReferenceFiles?.has(grepTarget) === true
          ? grepTarget
          : undefined;
      if (forwardReference) {
        proofExec = "not_yet_built";
        proofSkip = "forward-reference";
        reason =
          `${reason} — NOTE: proof names ${whitelisted.label}, absent on the PR head but declared in ` +
          `this diff's own plan shard \`files:\` — a forward reference to work not yet built, not a ` +
          `failure; not executed, keyword floor applied`;
      } else {
        const exec = execCtx.exec ?? execWhitelistedProof;
        try {
          const outcome = exec(whitelisted, execCtx.cwd);
          if (outcome === "pass") {
            // W1-T273 (grep) / W1-T362 (extended to `unit test:`): re-run the SAME
            // whitelisted check against the PR's merge-base — one execution answers
            // both "is this stale" and, if not, why not (see classifyBaseProofOutcome).
            const baseOutcome =
              execCtx.baseCwd !== undefined
                ? classifyBaseProofOutcome(whitelisted, exec, execCtx.baseCwd, execCtx.baseUnreadablePaths, execCtx.baseIsCheckout)
                : undefined;
            if (baseOutcome === "base_unreadable") {
              // The base tree exists and siblings were checked against it, but THIS proof's base
              // blob never arrived, so its head-side pass proves nothing about discrimination
              // (W1-T460). Withdraw the positive override and fall back to the keyword floor
              // verbatim, exactly as `executed_stale` degrades. NOT a failure: we did not learn
              // the proof is bad, we learned we never asked.
              proofExec = "base_unreadable";
              reason =
                `${reason} — NOTE: proof PASSED on the PR head ` +
                `(${whitelisted.kind}: ${whitelisted.label}) but its base blob could not be read, so the ` +
                `merge-base staleness check never ran for THIS proof (the base tree itself exists and ` +
                `other proofs were checked against it); positive override withdrawn, keyword floor applied`;
            } else if (baseOutcome === "stale" && staleProofIsSelfPath(whitelisted, execCtx.forwardReferenceFiles)) {
              // (W1-T1071) The stale match is not an ordinary non-discriminating grep: its target is a plan-shard
              // path and this diff's own task declares a REAL path besides it, so the task has an implementing diff.
              // A self-path grep only ever discriminated by proving the shard's own filing text was present —
              // permanently true at the merge-base now — so the ordinary degrade would let a report that never
              // engages the built behaviour through on keyword coverage of the OLD plan prose.
              proofExec = "stale_self_path";
              met = false;
              reason =
                `proof unmet: REFUSED — proof (${whitelisted.kind}: ${whitelisted.label}) is a filing-time ` +
                `self-path proof (it greps this diff's own plan shard, which now also matches at the PR's ` +
                `merge-base) — it discriminated the PR that FILED the task and cannot discriminate the PR ` +
                `that BUILDS it; rewrite this proof to name the behaviour this diff builds, not the plan ` +
                `text that filed it`;
            } else if (baseOutcome === "stale") {
              // The same check also passes on the MERGE-BASE, so its exit 0 here discriminates
              // nothing — see {@link classifyBaseProofOutcome}. `met`/`reason` are LEFT UNTOUCHED
              // and the keyword floor stands verbatim: the positive override is withdrawn, never
              // converted into a failure.
              proofExec = "executed_stale";
              reason =
                `${reason} — NOTE: proof also matches the PR's merge-base ` +
                `(${whitelisted.kind}: ${whitelisted.label}); non-discriminating, ` +
                `positive override withdrawn, keyword floor applied`;
            } else {
              proofExec = "executed_pass";
              met = true;
              reason = `proof executed and PASSED on the PR head (${whitelisted.kind}: ${whitelisted.label})`;
              // W1-T362: record the base-run outcome on the verdict for a `unit test:`
              // proof specifically (grep's reason text stays byte-identical to its
              // shipped W1-T273 shape — that check is not in this task's scope).
              if (whitelisted.kind === "test" && baseOutcome === "discriminates") {
                reason +=
                  ` — NOTE: also re-run against the PR's merge-base and did NOT pass there ` +
                  `(absent, no-match, or a genuine failure); the proof discriminates, executed_pass stands`;
              } else if (whitelisted.kind === "test" && baseOutcome === "base_unknown") {
                reason +=
                  ` — NOTE: re-run against the PR's merge-base for staleness could not complete ` +
                  `(base_unknown, an environment gap: ` +
                  (execCtx.baseIsCheckout === true
                    ? `the base run itself could not execute`
                    : `no merge-base checkout could be materialised, and a unit test cannot be re-run against blobs`) +
                  `); executed_pass stands, downgrade withheld — no discrimination was measured`;
              }
            }
          } else if (outcome === "no-match") {
            // ZERO tests matched the name pattern on a COMPLETED run. EITHER a proof-authoring mismatch — the house
            // convention writes a `unit test:` proof as PROSE describing behaviour, see {@link
            // looksLikeProseDescription} — OR genuine test theater, a proof naming a specific, fabricated test
            // (W1-T161/#349). Told apart by a deterministic shape check, never by re-running or calling a model.
            if (looksLikeProseDescription(whitelisted.label)) {
              // A prose paraphrase, not a bare name: NOT a failing test. Degrade to
              // `not_executable`, the keyword floor standing as computed, and ANNOTATE why, so an
              // author sees "names no matching test" rather than a misleading "executed and
              // FAILED" — a false block on green, test-passing code.
              proofExec = "not_executable";
              proofSkip = "prose-no-match";
              reason = `${reason} — NOTE: proof names no matching test (0 tests matched '${whitelisted.label}'); not executed, keyword floor applied`;
            } else {
              // W1-T72's test-theater guard, PRESERVED: the body reads as a bare, concrete test
              // NAME rather than prose, and matches nothing on the head. A fabricated test name is
              // theater and must FAIL, never silently degrade to the keyword floor.
              proofExec = "executed_fail";
              met = false;
              reason = `proof names a specific test that does not exist on the PR head (0 tests matched '${whitelisted.label}') — test theater, not executed`;
            }
          } else if (grepForwardReferenceTarget !== undefined) {
            // The grep half of W1-T456's carve-out (W1-T2737). `callSiteViolations` (task-linter.ts)
            // REQUIRES a task creating a src/ module to carry `grep: <symbol>( in <the file that calls
            // it>` — the only dialect that can express "a DIFFERENT file calls this symbol" — and on the
            // filing that symbol cannot exist, so the branch above graded the prescribed remedy
            // `executed_fail`. REACHED ONLY AFTER EXECUTION, which makes "the symbol is absent from that
            // path on the head" the EXECUTOR's answer rather than a second implementation of the match.
            // // Why: on W1-T2716 that proof failed the PR alone and the author dropped the criterion.
            proofExec = "not_yet_built";
            proofSkip = "forward-reference";
            reason =
              `${reason} — NOTE: proof greps ${grepForwardReferenceTarget}, declared in this diff's own ` +
              `plan shard \`files:\` while this diff changes no source — a forward reference to wiring ` +
              `not yet built, not a failure; keyword floor applied`;
          } else {
            proofExec = "executed_fail";
            met = false;
            reason = `proof executed and FAILED on the PR head (${whitelisted.kind}: ${whitelisted.label}) — overrides any keyword coverage`;
          }
        } catch (e) {
          proofExec = "exec_error"; // met/reason stay EXACTLY the keyword-floor verdict for every OTHER thrown cause
          if (e instanceof PureProofNeverExecutedError) {
            // W1-T1077 design (iv): record the DISCRIMINATOR, not the stream — the classification
            // plus the wrapper name the executor already parsed, so a `review.posted` row can say
            // which of "real failure" or "broken runtime" a failed pure-path proof was, never the
            // raw TAP capture, which is unbounded and would carry the run's environment into a durable row.
            proofSkip = "runtime-broken";
            reason =
              `${reason} — NOTE: proof's file (${e.wrapperName}) never reached a real subtest — its ` +
              `own TAP wrapper reported the failure (a broken runtime: an unresolvable --import ` +
              `loader, an uncaught module-load error, …), not the named test; not executed, keyword ` +
              `floor applied`;
          } else if (e instanceof PureProofIncompleteRunError) {
            // W1-T2740, the same rule as the sibling arm: record the DISCRIMINATOR, never the
            // stream. The bounded fact is that node's completion signal is absent after N real
            // results — enough to say WHY a pure-path proof reached no conclusion.
            proofSkip = "incomplete-run";
            reason =
              `${reason} — NOTE: proof's run reported ${e.completedResults} passing subtest(s) and ` +
              `then stopped before node's trailing summary — an incomplete run (cut off by a ` +
              `timeout kill, an external signal, or an OOM), so it never reached a verdict about ` +
              `this criterion; not executed, keyword floor applied`;
          } else {
            proofSkip = "exec-error";
          }
        }
      }
    } else if (isMalformedDialectProof(criterion.proof)) {
      // W1-T305: a proof declaring a dialect label (`grep:`/`unit test:`) that still failed to
      // parse is an AUTHORING ERROR, never silently the same bucket as a proof that read as
      // ordinary prose from the start — see isMalformedDialectProof's doc.
      proofSkip = "dialect-parse-error";
      reason =
        `${reason} — NOTE: proof declares a dialect prefix (grep:/unit test:) but its body does ` +
        `not parse into a runnable check (authoring error — malformed syntax, not free prose); ` +
        `not executed, keyword floor applied`;
    } else {
      proofSkip = "no-dialect";
    }
  } else {
    proofSkip = "no-exec-context";
  }

  // W1-T178 (verdict stability): capture the DETERMINISTIC floor's own verdict
  // — mechanical keyword coverage, overridden by whitelisted execution where
  // applicable — BEFORE the semantic layer below gets a chance to downgrade it.
  const floorMet = met;

  // Semantic can only DOWNGRADE: an explicit `false` fails the criterion even if it was mechanically substantiated,
  // and can never rescue an unpasted or executed-fail proof. W1-T2263: APPEND to the floor's accumulated `reason`,
  // never replace it — a bare overwrite threw away everything earlier branches built in the one branch where an
  // author most needs to know what was weighed. A bounded `semanticClause` rides after the downgrade note.
  if (semantic === false && met) {
    met = false;
    const downgradeNote = "reviewer judged the proof non-responsive (semantic downgrade)";
    reason = semanticClause ? `${reason} — NOTE: ${downgradeNote}: ${semanticClause}` : `${reason} — NOTE: ${downgradeNote}`;
  }

  return { ...base, met, reason, proof_exec: proofExec, proof_skip: proofSkip, floorMet, holdout: !!criterion.holdout };
}

/** The slice of {@link Task} the merged-claim audit needs — just enough to name a
 *  finding without importing all of `plan.js`'s Task surface. Any object with these
 *  two fields (a real {@link Task}, or a test fixture) satisfies it. */
export interface AuditableMergedTask {
  id: string;
  acceptance?: ReadonlyArray<AcceptanceCriterion>;
}

/** One acceptance criterion of a MERGED task whose proof is in an executable dialect but did NOT
 *  resolve to a runnable check, or resolved and did not pass. Merge credit is given per TASK, so
 *  this is the gap {@link judgeReview} cannot see once the task is off its desk. */
export interface MergedClaimFinding {
  taskId: string;
  claim: string;
  proof: string;
  proofExec: ProofExecOutcome;
  /** Plain-language cause, independent of {@link CriterionVerdict.reason}'s keyword-floor
   *  phrasing — there is no PR report to score keyword coverage against here, only the
   *  proof's own execution outcome. */
  reason: string;
}

/** One acceptance criterion of a merged task whose proof carries NO whitelisted dialect at all —
 *  prose, and so structurally unauditable by any mechanical check. Reported in its OWN bucket so
 *  its size is legible: folding it into {@link MergedClaimFinding} would misreport "unauditable" as
 *  "broken", and treating it as passing would misreport it as "verified" (design (4)). */
export interface MergedClaimUncheckable {
  taskId: string;
  claim: string;
  proof: string;
}

/** The full report {@link auditMergedTaskClaims} returns — REPORT ONLY, per design (2):
 *  nothing here closes, reopens, or re-scores a task; it just makes the gap visible. */
export interface MergedClaimAuditReport {
  findings: MergedClaimFinding[];
  uncheckable: MergedClaimUncheckable[];
  tasksAudited: number;
  /** Criteria whose proof DID parse to a whitelisted dialect and were actually run —
   *  i.e. `findings.length` plus every executable criterion that passed cleanly. */
  executableClaimsChecked: number;
}

/** Plain-language cause for a {@link MergedClaimFinding}, read off the SAME {@link ProofExecOutcome}/{@link
 *  ProofSkipReason} pair {@link judgeCriterion} computed — never a second classification that could disagree.
 *  `"executed_stale"` and `"base_unreadable"` are structurally unreachable here, since {@link auditMergedTaskClaims}
 *  supplies no `baseCwd`, so they fold into the generic `default` wording rather than untestable cases. */
function describeUnresolvedOrFailing(proofExec: ProofExecOutcome, proofSkip: ProofSkipReason | undefined): string {
  switch (proofExec) {
    case "executed_fail":
      return "proof executed and FAILED against the current checkout";
    case "exec_error":
      return "proof named a whitelisted check that failed to execute (timeout, spawn error, or missing target)";
    default:
      if (proofSkip === "prose-no-match") return "proof names a unit test that matches nothing on the current checkout (0 matches)";
      // W1-T305: a dialect-labelled proof that never parsed is an AUTHORING ERROR, not the same
      // "cannot resolve either way" shape a genuinely unresolved check reports.
      if (proofSkip === "dialect-parse-error") {
        return "proof declares a dialect prefix (grep:/unit test:) but its body does not parse into a runnable check — authoring error";
      }
      return "proof did not resolve to a passing, runnable check";
  }
}

/** A CLAIM-LEVEL audit over MERGED tasks (W1-T302). Merge credit is derived per TASK
 * (deriveStatus/{@link projectPlan}), never per CRITERION, so a multi-claim task whose PR satisfied only SOME of its
 * criteria reads identically to one that satisfied all — the gap W1-T64 fell into. REUSES the reviewer's OWN parser
 * and executor via {@link judgeCriterion} rather than a second matcher that could disagree, with an empty
 * report-token set and no semantic verdict: only `proof_exec`/`proof_skip` are read, and an Architect-set
 * `satisfied_by` criterion is skipped. REPORT ONLY: callers FILE follow-up tasks from this list, never mechanically
 * close or reopen the merged task, because an unresolved proof
 * is frequently a stale proof. */
export function auditMergedTaskClaims(
  tasks: ReadonlyArray<AuditableMergedTask>,
  cwd: string,
  exec?: ProofExecutor,
): MergedClaimAuditReport {
  const findings: MergedClaimFinding[] = [];
  const uncheckable: MergedClaimUncheckable[] = [];
  let executableClaimsChecked = 0;
  const noReportTokens = new Set<string>();

  for (const task of tasks) {
    for (const criterion of task.acceptance ?? []) {
      if (criterion.satisfied_by) continue; // already credited to an earlier merge — not a hole.
      const verdict = judgeCriterion(criterion, noReportTokens, undefined, { cwd, exec });
      if (verdict.proof_skip === "no-dialect") {
        uncheckable.push({ taskId: task.id, claim: criterion.claim, proof: criterion.proof });
        continue;
      }
      executableClaimsChecked++;
      if (verdict.proof_exec !== "executed_pass") {
        findings.push({
          taskId: task.id,
          claim: criterion.claim,
          proof: criterion.proof,
          proofExec: verdict.proof_exec,
          reason: describeUnresolvedOrFailing(verdict.proof_exec, verdict.proof_skip),
        });
      }
    }
  }

  return { findings, uncheckable, tasksAudited: tasks.length, executableClaimsChecked };
}

/** A body's own claim about its changeset that {@link bodyContradictsDiff} proved false against the
 *  diff it actually shipped. */
export interface ChangesetClaimContradiction {
  /** The exact phrase from the report/body asserting the (false) claim. */
  claim: string;
  /** The diff's actual changed files that refute the claim. */
  files: string[];
}

const WORD_NUMBERS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

/** Parse "one" / "3" / "ten" into a number; undefined for anything else. */
function parseClaimedCount(word: string): number | undefined {
  const lower = word.toLowerCase();
  if (lower in WORD_NUMBERS) return WORD_NUMBERS[lower];
  return /^\d+$/.test(word) ? Number(word) : undefined;
}

/** A path-SHAPED token: it contains a `/` or a `.`, never a bare English word. This guard keeps
 * `bodyContradictsDiff` silent on "no bugs"/"no issues"/"no regressions", which give it nothing to
 * check a diff against, while still catching "no src/"/"no docs/ORIENTATION.md". */
function looksLikePath(token: string): boolean {
  return /[./]/.test(token);
}

/** Words that mark a sentence as being ABOUT THE CHANGESET rather than about anything else a body
 *  might count files for. Kept as DATA so widening it is a one-line review, not a regex rewrite. */
const CHANGESET_CONTEXT_RE =
  /\b(?:diff|diffs|changed|changes|change|changeset|touch|touches|touched|modif\w*|edits?|edited|adds?|added|deletes?|deleted|removes?|removed|numstat|--stat|git\s+show|this\s+pr|the\s+pr)\b/i;

/** Is the "exactly N files" match at `index` in a sentence ABOUT THE CHANGESET? Looks BACKWARD only,
 *  and only to the start of the current sentence, because scanning the whole body would re-create the
 *  unanchored match this prevents. */
/** (W1-T2534) IS THE MATCH INSIDE AN INLINE QUOTED SPAN? A quotation is not an assertion, which
 * W1-T308 established for BLOCK-level quotation, but {@link stripQuotedRegions} does not touch an INLINE span. COUNTS
 * DELIMITERS ON THE MATCH'S OWN LINE, never across lines, and backtick and double quote only, since an apostrophe is
 * ordinary punctuation. W1-T2549 made this the ONE predicate every arm of {@link bodyContradictsDiff} shares.
 * // Why: three PR bodies in one session were refused on this sentence (#3388, #3408). */
function isInsideInlineQuote(report: string, index: number): boolean {
  const lineStart = report.lastIndexOf("\n", index - 1) + 1;
  const before = report.slice(lineStart, index);
  for (const d of ['"', "`"]) {
    let n = 0;
    for (const ch of before) if (ch === d) n++;
    if (n % 2 === 1) return true;
  }
  return false;
}
export function claimsChangesetContext(report: string, index: number): boolean {
  // W1-T2534: a claim inside an inline quoted span is a MENTION of someone else's claim, never
  // this body's own — the inline sibling of W1-T308's block-level rule. Checked FIRST, because no
  // amount of surrounding changeset context turns a quotation into an assertion.
  if (isInsideInlineQuote(report, index)) return false;
  const before = report.slice(0, index);
  // Sentence start: the last terminator, newline, or list-bullet before the claim.
  const start = Math.max(
    before.lastIndexOf(". "),
    before.lastIndexOf("\n"),
    before.lastIndexOf("! "),
    before.lastIndexOf("? "),
  );
  return CHANGESET_CONTEXT_RE.test(before.slice(start + 1));
}

/** Is a `no <token>` claim ABOUT THE CHANGESET? THE RULE: it counts only when the TOKEN ENDS IT — what follows is
 * punctuation, end of line, or a changeset word — because an ordinary word after the token makes it a MODIFIER ("no
 * code DUPLICATION"). Scoped to the SAME LINE. A HEURISTIC ABOUT ENGLISH COMPOUND NOUNS, so it FAILS TOWARD SILENCE:
 * a missed contradiction costs one bad PR body, while a false positive strands a correct PR indefinitely, since a PR
 * that files no task logs `sweep.fix.no_task` every tick and nothing retries it. NOT {@link claimsChangesetContext},
 * which looks BACKWARD because a count claim carries its context first. TWO NARROW EXCEPTIONS, each for one observed
 * misfire: (W1-T328) a "was/is/were/are needed/required/necessary FOR/TO …" tail flips to silence, and (W1-T395) a
 * CLOSING DELIMITER right after the token ends a SPAN, so {@link NEXT_WORD_RE} skips one first.
 * // Why: #1249's "no code change was needed" named panel-graph.ts, absent from its own diff of src/lib/escalate.ts, src/lib/feedback.ts and src/lib/serve.ts. */
const NEED_CLAUSE_RE = /^\s+(?:was|is|were|are)\s+(?:needed|required|necessary)\s+(?:for|to)\b/i;

// Enumerated, not "skip all punctuation": a blanket skip would swallow the sentence-end case the "punctuation ends
// it" branch still needs, turning a true positive into silence. Each character here CLOSES A SPAN rather than a
// sentence, so what follows can be the same claim continuing. Left out: `]` and `}`, unmeasured — add them when a
// real fixture turns up rather than guessing.
const NEXT_WORD_RE = /^[ \t`"')]*([A-Za-z][A-Za-z0-9_-]*)/;

export function noClaimIsAboutChangeset(rest: string): boolean {
  const next = NEXT_WORD_RE.exec(rest);
  if (!next) return true; // punctuation, end of line, or end of input — the token IS the claim
  if (!CHANGESET_CONTEXT_RE.test(next[1])) return false;
  // The head noun alone says "about the changeset" — but see whether it is itself the subject of a
  // NEED-clause naming something else (the W1-T328 fixture above) before trusting that.
  return !NEED_CLAUSE_RE.test(rest.slice(next[0].length));
}

/** A SELF-REFERENTIAL SUBJECT immediately followed by a linking verb — "This PR is …", "The diff
 *  was …". The optional noun separates a claim from an explanation: "a merged PR is plan-only"
 *  carries a linking verb too, but its subject is a GENERIC PR, so no determiner from this set
 *  precedes it. Anchored at `$` by its one caller, so the verb must be IMMEDIATELY before it. */
const SELF_REFERENTIAL_CLAIM_RE =
  /\b(?:this|these|it|the)(?:\s+(?:pr|diff|changeset|changes|change|commit|patch|revert))?\s+(?:is|are|was|were)\s+[*_`]*$/i;

/** The word a shorthand MODIFIES, if it modifies one: `[ \t]+` and never `\s+`, because a word on
 *  the NEXT line belongs to another sentence (the rule `noClaimIsAboutChangeset`'s own scan already
 *  follows), and a leading `[*_`]*` so markdown emphasis does not hide the noun. */
const SHORTHAND_HEAD_NOUN_RE = /^[*_`]*[ \t]+([A-Za-z][A-Za-z0-9_-]*)/;

/** Is a house-shorthand claim (`plan-only` / `data-only`) at `index` ABOUT THE CHANGESET? THREE GRAMMATICAL
 * RELATIONS, none of them "a changeset word appears nearby". LABEL: `data-only: no code.` (#1025's own body), where
 * the colon makes it the subject of the line. COPULAR: `This PR is plan-only.` ({@link SELF_REFERENTIAL_CLAIM_RE}).
 * ATTRIBUTIVE: `plan-only change`, where the head noun it modifies IS the changeset. NOT {@link
 * noClaimIsAboutChangeset}, whose contract treats "no next word at all" as "the token IS the claim": a path like
 * `test/trailer-credit-plan-only.test.ts` continues with `.test.ts`, so requiring real whitespace before the head
 * noun keeps a path silent.
 * // Why: the SENTENCE-SCOPED arms this replaced read #1562's own quoted criterion as claiming exemption — THE CORRECT WORDING IS THE ONE THAT TRIPPED IT (W1-T413). */
/** (W1-T2533) A DENIED CLAIM IS NOT A CLAIM. The label arm decides on the COLON alone, so a body answering the scope
 *  question HONESTLY IN THE NEGATIVE was refused for the claim it just denied — #3373's body said `Plan-only: no.`
 *  THE DISCRIMINATOR IS EXACT: `Plan-only: no code, only the shard.` is an ASSERTION whose elaboration merely begins
 *  with a negative word, so `no`/`nope` counts as a denial only when nothing but punctuation follows, `not` always. */
export const DENIED_LABEL_ANSWER_RE = /^[*_`'")\]\s]*:\s*(?:(?:no|nope)(?![ \t]*[\w])|not\b)/i;

/** (W1-T2533) The ATTRIBUTIVE form of the same denial: "this is NOT a plan-only change". That arm
 *  reads only the noun the shorthand modifies, so it cannot see a negator in front of the whole noun
 *  phrase. Bounded to the words IMMEDIATELY before the shorthand, like the copular arm: a negator
 *  anywhere-in-sentence would silence a genuine claim sharing a sentence with an unrelated one. */
export const DENIED_ATTRIBUTIVE_RE = /\b(?:not|never|isn't|aren't|wasn't)\s+(?:a|an|the)?\s*$/i;
/** (W1-T2549) THE SAME GUARD, HOISTED, NOT REIMPLEMENTED. W1-T2534 gave the count arm an inline-quoted-span check
 * ({@link isInsideInlineQuote}) and left this function's three arms uncovered, so a body that QUOTED a scope label
 * was still read as its own claim. Checked FIRST, and THE ONE CALL, not a second copy — a second implementation is
 * how the arms drifted apart the first time.
 * // Why: #3422's second body quoted the LABEL form and was refused; #3421's measurement table only passed once
 * // moved into a FENCED block, the literals byte-identical (2026-08-31). */
function shorthandIsAboutChangeset(report: string, index: number, length: number): boolean {
  if (isInsideInlineQuote(report, index)) return false;
  const rest = report.slice(index + length);
  // THE LABEL FORM IS A CLAIM, and the one the house style writes: `data-only: no code.` (#1025's own body) and
  // `**Plan-only**: one file added`. A colon immediately after the shorthand, through any markdown emphasis, makes it
  // the SUBJECT of the line, and a path never continues with a colon, so `test/trailer-credit-plan-only.test.ts`
  // stays silent. W1-T2549 NARROWED W1-T395's SCOPE, IT DID NOT REVERSE IT: a CLOSING DELIMITER ends a SPAN, not a
  // sentence, so `**Plan-only**:` still reads as a label (test/review-absence-anchor-delimiter.test.ts), but a QUOTE
  // character leaving the span open is caught by `isInsideInlineQuote` first. See
  // test/changeset-shorthand-anchor.test.ts.
  if (/^[*_`'")\]\s]*:/.test(rest)) {
    // W1-T2533: ...unless the body ANSWERED the question negatively. See DENIED_LABEL_ANSWER_RE
    // for why `no <noun>` is still an assertion while `no.` and `not …` are denials.
    return !DENIED_LABEL_ANSWER_RE.test(rest);
  }
  // THE COPULAR FORM IS A CLAIM: "This is plan-only.", "The diff is data-only." A linking verb immediately before the
  // shorthand makes it the PREDICATE of what the sentence is about, and in a PR body that subject is the change.
  // Deliberately IMMEDIATE rather than anywhere-in-sentence, which is what separates it from "makes a triage PR
  // plan-only by construction" (about the LANE) and "described its revert as data-only" (about ANOTHER PR).
  if (SELF_REFERENTIAL_CLAIM_RE.test(report.slice(0, index))) return true;
  // THE ATTRIBUTIVE FORM IS A CLAIM when, and only when, the noun the shorthand modifies is ITSELF the changeset:
  // "plan-only change", "a data-only diff". The old forward scan could not draw that line because it read the whole
  // rest of the sentence: in "the plan-only CARVE-OUT exempts a plan-scope DIFF" the modified noun is `carve-out` and
  // `diff` is an object three words later.
  const head = SHORTHAND_HEAD_NOUN_RE.exec(rest);
  if (head === null || !CHANGESET_CONTEXT_RE.test(head[1])) return false;
  // W1-T2533: "this is NOT a plan-only change" modifies the changeset AND denies it. The negator
  // sits in front of the whole noun phrase, where the head-noun read cannot see it.
  return !DENIED_ATTRIBUTIVE_RE.test(report.slice(0, index));
}

/** Does `file` fall under the claimed-absent `path` (an exact file, or a directory prefix)? */
function fileUnderClaimedPath(file: string, path: string): boolean {
  const normalized = path.replace(/\/$/, "");
  return file === normalized || file.startsWith(`${normalized}/`);
}

/** A QUOTATION IS NOT AN ASSERTION (W1-T308). `bodyContradictsDiff` scans the whole body for the claim shape, so a
 * blockquote or fenced block quoting ANOTHER PR's body read identically to its own assertion. Blanks blockquote lines
 * and fenced-block contents, preserving every other character's position so match indices still line up. DELIBERATELY
 * NARROW: widening to inline code spans would let a real contradiction hide behind a single backtick. ALSO REPORTS
 * `fenceUnbalancedAtEof` (W1-T1264 (iv)), since an unbalanced fence blanks the REMAINDER of the body.
 * // Why: #1194 quoted #1192's failing fixture and was failed over a two-file diff; #1206 did the same (#1202). */
function stripQuotedRegions(report: string): { scan: string; fenceUnbalancedAtEof: boolean } {
  let inFence = false;
  const scan = report
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return " ".repeat(line.length);
      }
      if (inFence || /^\s*>/.test(line)) return " ".repeat(line.length);
      return line;
    })
    .join("\n");
  return { scan, fenceUnbalancedAtEof: inFence };
}

/** Does an enumeration TOKEN correspond to a member of `diffFiles` (W1-T2224)? Replaces a shape guess with a
 * contract check against `diffFiles` itself. THREE WAYS A TOKEN NAMES A REAL FILE: (a) EXACT; (b) SUFFIX/BASENAME,
 * the final segment or trailing suffix of EXACTLY ONE member ("review.ts" for "src/lib/review.ts"); (c) EMBEDDED,
 * EXACTLY ONE member appearing INTACT inside it ("src/lib/review.ts|12+++++"). "Exactly one" is load-bearing: an
 * AMBIGUOUS match is no match.
 * // Why: THE THIRD FALSE POSITIVE ON THE SAME LINE — `includes` already needed patches for backticks (#1192) and a
 * // trailing paren (#1209), both REAL paths whose TEXT stopped matching once something was pasted around them. */
function enumeratedTokenMatchesChangeset(token: string, diffFiles: readonly string[]): boolean {
  if (diffFiles.includes(token)) return true;
  const bySuffix = diffFiles.filter((f) => f === token || f.endsWith(`/${token}`));
  if (bySuffix.length === 1) return true;
  const byEmbed = diffFiles.filter((f) => f.length > 0 && token.includes(f));
  return byEmbed.length === 1;
}

/** THE NARROW, FALSIFIABLE CHECK (W1-T274): does the body claim something about its OWN changeset that
 * the diff refutes? Three recognised shapes: (a) a stated FILE COUNT disagreeing with `diffFiles.length`; (b) a claim
 * that a path or directory is absent ("no src/", a named file, "plan-only", "data-only") when `diffFiles` contains a
 * member of it; (c) a file NAMED in an "exactly N files: a, b" enumeration that `diffFiles` does not contain.
 * ANYTHING THIS CANNOT DECIDE IS SILENCE, NOT A VERDICT, because a checker that guesses at natural language would be
 * a worse tripwire than the gap it closes.
 * // Why: #974 claimed "exactly one file: MASTER-PLAN.md. No src/, no test/, no docs/ORIENTATION.md" over a 3-file diff that DID touch it; #1025 claimed "data-only: no code" while reverting 8 files. */
export function recognizeChangesetClaims(report: string, diffFiles: string[]): ChangesetClaimRecognition {
  const out: ChangesetClaimContradiction[] = [];
  // How many claim-shaped tokens, across every arm below, were RECOGNISED as being about the changeset — whether or
  // not they went on to disagree with `diffFiles` (W1-T1264). A recognised-and-consistent claim increments this
  // WITHOUT reaching `out`, the one fact `bodyContradictsDiff`'s `[]` could never distinguish from "never read a
  // claim at all". Incremented where each arm decides a match is a genuine claim, never where it decides it false.
  let recognisedCount = 0;
  // Scan the QUOTED-STRIPPED text throughout, never the raw `report` (W1-T308). Length- and newline-preserving, so
  // every index below lines up with the original body. `fenceUnbalancedAtEof` rides along unused until the return:
  // the arms never branch on it, only the caller reports it.
  const { scan, fenceUnbalancedAtEof } = stripQuotedRegions(report);

  // (a) / (c): "exactly N files[: a, b, c]" — the count itself, and the enumerated list when a count is right but a
  // named file is missing. THE COUNT CLAIM MUST BE ABOUT THE CHANGESET, since the bare pattern has no SUBJECT, so it
  // counts only when TIED to one, by an enumeration ("exactly one file: MASTER-PLAN.md", #974's shape) or a changeset
  // word in the run-up; anything else is silence.
  // // Why: #1077's "exactly one file and matches exactly 1 test" posted `failure` with 5/5 `executed_pass`, `unmet_criteria: []` and no rung to retry it.
  const countRe = /\bexactly\s+(\w+)\s+files?\b(?:\s*:\s*([^\s,]+(?:\s*,\s*[^\s,]+)*))?/gi;
  for (const m of scan.matchAll(countRe)) {
    const claimed = parseClaimedCount(m[1]);
    if (claimed === undefined) continue;
    if (!m[2] && !claimsChangesetContext(scan, m.index ?? 0)) continue;
    recognisedCount++; // past both the parse and the subject anchor — a genuine claim, true or not
    let contradicted = claimed !== diffFiles.length;
    if (!contradicted && m[2]) {
      // MARKDOWN QUOTING IS STRIPPED BEFORE THE COMPARISON, because a body writes a path in backticks while
      // `diffFiles` holds bare paths, so `includes` fails on every correctly enumerated file. WRAPPING PUNCTUATION
      // COMES OFF FROM BOTH ENDS, AS A CLASS, which makes it robust to the next wrapper; `looksLikePath` still
      // requires a `.` or `/`, so an over-strip cannot invent a match. MEMBERSHIP ITSELF IS A CONTRACT CHECK, NOT A
      // THIRD WRAPPER (W1-T2224) — see {@link enumeratedTokenMatchesChangeset}.
      // // Why: #1192 enumerated three backticked paths and reported one contradiction; with backticks stripped, zero. #1209 then parenthesised its enumeration.
      const named = m[2]
        .split(",")
        .map((s) =>
          s
            .trim()
            .replace(/^[`'"([\]]+/, "")
            .replace(/[`'")\].,;:\s]+$/, ""),
        )
        .filter(looksLikePath);
      contradicted = named.some((f) => !enumeratedTokenMatchesChangeset(f, diffFiles));
    }
    if (contradicted) out.push({ claim: m[0].trim(), files: [...diffFiles] });
  }

  // (b): "no <path>" claims, plus the "plan-only"/"data-only" house shorthands.
  const noPathRe = /\bno\s+([A-Za-z0-9_./-]+)/gi;
  for (const m of scan.matchAll(noPathRe)) {
    const token = m[1].replace(/[,.\s]+$/, "");
    // ANCHOR, the sibling of the count arm's in the other direction (see noClaimIsAboutChangeset). Predicate (b) was
    // never anchored and fired six times in one day on prose whose subject was not the changeset: "This change
    // introduces no code duplication anywhere" produced `claim: "no code"` against any source-touching diff, in a
    // repo that runs a jscpd duplication gate.
    if (!noClaimIsAboutChangeset(scan.slice((m.index ?? 0) + m[0].length))) continue;
    let violators: string[];
    if (token.toLowerCase() === "code") {
      violators = diffFiles.filter((f) => f.startsWith("src/") || isTestPath(f));
    } else if (looksLikePath(token)) {
      violators = diffFiles.filter((f) => fileUnderClaimedPath(f, token));
    } else {
      continue; // "no bugs", "no issues" — not a changeset claim; stay silent
    }
    recognisedCount++; // past the anchor AND the path-shaped guard — a genuine claim, true or not
    if (violators.length > 0) out.push({ claim: m[0].trim(), files: violators });
  }
  // THE HOUSE SHORTHANDS NEED THE SAME SUBJECT ANCHOR THE COUNT CLAIM GOT: `/\bplan-only\b/i` has no SUBJECT, so it
  // fires on the WORD wherever it appears, including inside a path. ANCHORED BACKWARD with {@link
  // claimsChangesetContext}, the count claim's own helper — these shorthands carry their context BEFORE them, the
  // opposite of a `no <token>` claim. BOTH ARMS, deliberately: `data-only` is the identical shape one line down.
  // // Why: W1-T413's own criteria name `test/trailer-credit-plan-only.test.ts`, and `\b` matches around
  // // `plan-only` between the `-` and the `.`, so quoting the required proof forced failure.
  for (const m of scan.matchAll(/\bplan-only\b/gi)) {
    if (!shorthandIsAboutChangeset(scan, m.index ?? 0, m[0].length)) continue;
    const violators = diffFiles.filter((f) => !isInPlanScope(f));
    recognisedCount++; // one recognised claim per kind, matching the one-contradiction-per-kind break
    if (violators.length > 0) out.push({ claim: "plan-only", files: violators });
    break; // one contradiction per claim kind, exactly as the unanchored test produced
  }
  for (const m of scan.matchAll(/\bdata-only\b/gi)) {
    if (!shorthandIsAboutChangeset(scan, m.index ?? 0, m[0].length)) continue;
    recognisedCount++;
    const violators = diffFiles.filter((f) => f.startsWith("src/") || isTestPath(f));
    if (violators.length > 0) out.push({ claim: "data-only", files: violators });
    break;
  }

  return { recognisedCount, contradictions: out, fenceUnbalancedAtEof };
}

/** Everything {@link bodyContradictsDiff} decides, plus the two facts (W1-T1264) that make its
 *  silence legible: how many claim-shaped tokens were RECOGNISED at all, and whether the
 *  quote-stripping pass reached end-of-body still inside an open fence. Nothing here changes WHEN a
 *  claim is recognised or when it disagrees, only what is counted alongside it. */
export interface ChangesetClaimRecognition {
  /** How many claim-shaped tokens were RECOGNISED — matched an arm's shape AND passed its subject anchor — whether
   *  or not the claim then agreed with `diffFiles`. `contradictions.length` is always <= this: a recognised claim
   *  that AGREES is counted here and never appears there, which is "checked, and it agrees". A `0` beside an empty
   *  `contradictions` means no arm recognised a claim; {@link CHANGESET_CLAIM_FALSIFIER_NOTE} tells them apart. */
  recognisedCount: number;
  /** Identical to {@link bodyContradictsDiff}'s own return value — the FALSE-claim subset. */
  contradictions: ChangesetClaimContradiction[];
  /** True when {@link stripQuotedRegions}'s fence toggle was still OPEN after every line was walked
   *  (W1-T1264 design (iv)). An unbalanced ``` delimiter blanks the body to EOF, so every later
   *  claim goes unread and `recognisedCount` under-counts without saying why. NAMED here, never
   *  auto-repaired: guessing the author's intent by closing the fence is what design (iv) forbids. */
  fenceUnbalancedAtEof: boolean;
}

/** THE FALSIFIER TECHNIQUE (W1-T1264 rationale (6)), stated beside the gate it describes. A `recognisedCount` of `0`
 *  does not mean a claim was true; it means this detector never read one, and prints identically to a claim it read
 *  and found correct. To tell them apart, reword the SAME claim into a deliberately FALSE variant of the identical
 *  shape and re-run: still `0` means the gate is blind to that WORDING, a contradiction means it was read and true. */
export const CHANGESET_CLAIM_FALSIFIER_NOTE =
  "A changeset-claims-recognised count of 0 does not mean your claim was true — it means this " +
  "check never read it, and that prints identically to a claim it read and found correct. To tell " +
  "the two apart, reword the SAME claim into a deliberately FALSE variant of the identical shape " +
  "(bump an \"exactly N files\" count, or negate a \"no <path>\" claim) and re-run: if the false " +
  "variant also recognises as 0, the gate is blind to that wording; if it fires a contradiction, " +
  "your original claim was read, and it was true.";

/** The FALSE-claim subset of {@link recognizeChangesetClaims}, unchanged from before W1-T1264.
 *  Prefer {@link recognizeChangesetClaims} at any NEW call site that can use `recognisedCount` —
 *  `judgeReview` and `deriveChangesetClaimUpdate` (run-task.ts) both do, so the same count reaches
 *  both surfaces an author reads. This wrapper exists only so a caller wanting just the
 *  contradictions never has to unwrap an object it does not need. */
export function bodyContradictsDiff(report: string, diffFiles: string[]): ChangesetClaimContradiction[] {
  return recognizeChangesetClaims(report, diffFiles).contradictions;
}

/** Is `diffFiles` EMPTY against its own DECLARED SCOPE — the paths a PR claims to touch, never the whole tree
 * (W1-T963)? `scopeFiles` absent or empty means nothing was declared, so this never manufactures a refusal for an
 * ordinary PR. `bodyContradictsDiff` answers a DIFFERENT question and is vacuously satisfied by an empty diff; this
 * is the complement — purely structural, no prose — generalising `nonPlanFilesInDiff`/`diffCitesFeedback`
 * (lib/triage.js) from "touches something outside plan/" to "touches none of its own declared paths", the
 * complementary structural gap those two leave open.
 * // Why: #2075/#2077/#2078 merged and passed review despite changing nothing. */
export function diffEmptyAgainstScope(diffFiles: readonly string[], scopeFiles: readonly string[]): boolean {
  if (scopeFiles.length === 0) return false;
  const touched = new Set(diffFiles);
  return !scopeFiles.some((f) => touched.has(f));
}

// ── SHIPS-UNWIRED advisory floor (W1-T322) ─────────────────────────────────

const WIRED_AT_RE = /\bWIRED-AT:\s*([^\s:]+)::(\w+)/g;
const SHIPS_UNWIRED_RE = /\bSHIPS-UNWIRED:\s*([^\s,;]+)/g;

/** Every `file::symbol` pair the report claims is wired — scanned over the WHOLE report (a
 *  marker can sit anywhere in the body, unlike {@link bodyContradictsDiff}'s quoted-region
 *  concern, which is about a CLAIM being mistaken for an assertion; a marker line is never
 *  something a body would legitimately quote from another PR). */
function wiredAtPairs(report: string): Set<string> {
  const out = new Set<string>();
  for (const m of report.matchAll(WIRED_AT_RE)) out.add(`${m[1]}::${m[2]}`);
  return out;
}

/** Every task id a `SHIPS-UNWIRED:` marker names, trailing punctuation stripped (the same
 *  wrapping-punctuation class {@link bodyContradictsDiff}'s enumeration cleanup strips). */
function shipsUnwiredIds(report: string): string[] {
  return [...report.matchAll(SHIPS_UNWIRED_RE)].map((m) => m[1].replace(/[.,;:)"'`]+$/, ""));
}

/** SCOPE-EXEMPT GENERATED ARTIFACTS (W1-T2650): the ONE enumerated set both the push/fix-rung scope guard ({@link
 * "../run-task.js".scopeGuardOutOfScopeFiles}) and this reviewer's own {@link scopeViolationFiles} consult, so a PR
 * admitted by one is never refused by the other. EXACT PATHS, HAND-ENUMERATED, NEVER A PATTERN, and NOT A RELAXATION
 * of either guard's fail-closed direction.
 * // Why: `scripts/source-size-ratchet.mjs` prints the exact edit that clears a breach — `edit
 * // scripts/source-size-baseline.json and set: "<path>": <bucket>,` — but the push-side guard flagged that edit as
 * // out-of-scope and the fix rung stood down rather than dispatch it. */
export const SCOPE_EXEMPT_GENERATED_ARTIFACTS: ReadonlySet<string> = new Set([
  // W1-T2650: the per-file source-size LEDGER `scripts/source-size-ratchet.mjs` itself prints as
  // the remedy for a breach it caused — see the doc above for why deferring this one to a
  // follow-up task is unsafe rather than merely inconvenient.
  "scripts/source-size-baseline.json",
]);

/** INVERSE-SCOPE (design (ii)(b), the #839 class): the mirror of {@link
 *  "../run-task.js".scopeGuardOutOfScopeFiles}, which runs diff → declared only on the
 *  orchestrator's fallback push path. This runs declared → diff: a file the task's `files:` NAMES
 *  that the diff never touched, visible from EVERY review. FAIL-CLOSED — an absent or empty declared
 *  scope has nothing to compare, and that case belongs to `scopeGuardOutOfScopeFiles`. */
function inverseScopeUntouchedFiles(diffFiles: readonly string[], declaredFiles: readonly string[] | undefined): string[] {
  if (!declaredFiles || declaredFiles.length === 0) return [];
  const touched = new Set(diffFiles);
  return declaredFiles.filter((f) => !touched.has(f));
}

/** SCOPE-VIOLATION (W1-T401): the same diff → declared comparison {@link
 * "../run-task.js".scopeGuardOutOfScopeFiles} makes, run at REVIEW TIME where every PR is seen rather than at the one
 * push site that guard sits behind. ADVISORY, not a refusal. DELIBERATELY DIFFERENT ON ONE POINT: that guard treats
 * an absent declared scope as "everything is out of scope" and this does not. W1-T2650: also subtracts {@link
 * SCOPE_EXEMPT_GENERATED_ARTIFACTS}, the SAME set it subtracts. */
function scopeViolationFiles(diffFiles: readonly string[], declaredFiles: readonly string[] | undefined): string[] {
  if (!declaredFiles || declaredFiles.length === 0) return [];
  const declared = new Set(declaredFiles);
  return diffFiles.filter((f) => !declared.has(f) && !SCOPE_EXEMPT_GENERATED_ARTIFACTS.has(f));
}

/** IMPLEMENTATION-SHAPED (W1-T458 design (ii)): `src/` or `test/` only. Narrowing to these two
 *  prefixes is what turns the raw "touches ANY declared path" false-positive rate — 52%, inflated by
 *  plan filings and docs PRs that legitimately touch a declared path and should earn no task credit
 *  — into the honest ~11% the advisory-not-refusal call rests on. */
function isImplementationPath(path: string): boolean {
  return path.startsWith("src/") || path.startsWith("test/");
}

/** UNRESOLVED-TASK-SCOPE (W1-T458, the #1731 near-miss): name the open task(s) whose declared `files:` this diff
 *  overlaps, but ONLY when no task resolved for this PR at all. "Resolved" is read off `taskDeclaredFiles` being
 *  non-empty, the signal its siblings fail-close on, never a literal scan for a `Remudero-Task:` trailer. Counts an
 *  overlap only through an {@link isImplementationPath}; FAIL-CLOSED like its siblings.
 *  // Why: `test/fixtures/golden-verdicts/scope-creep` injects `taskDeclaredFiles` directly and carries no trailer,
 *  // so a trigger keyed on the trailer would misfire and shift its `golden.yaml` (design (iii)). */
function unresolvedTaskScopeOverlaps(
  diffFiles: readonly string[],
  taskDeclaredFiles: readonly string[] | undefined,
  openTaskDeclaredFiles: ReadonlyMap<string, readonly string[]> | undefined,
): Map<string, string[]> {
  const taskResolved = !!taskDeclaredFiles && taskDeclaredFiles.length > 0;
  const matches = new Map<string, string[]>();
  if (taskResolved || !openTaskDeclaredFiles || openTaskDeclaredFiles.size === 0) return matches;

  const implementationDiffFiles = new Set(diffFiles.filter(isImplementationPath));
  if (implementationDiffFiles.size === 0) return matches;

  for (const [taskId, files] of openTaskDeclaredFiles) {
    const overlap = files.filter((f) => implementationDiffFiles.has(f));
    if (overlap.length > 0) matches.set(taskId, overlap);
  }
  return matches;
}

/** Assemble this review's {@link UnwiredAdvisory} list — ADVISORY ONLY, never consulted by `state`. `checkoutDir`
 *  mirrors {@link ReviewEvidence.headCheckoutDir}'s "absent ⇒ skip" contract, since `unwired_export` needs real files
 *  to read and a false "nothing to advise" would be worse; the three scope reasons are pure file-list comparisons and
 *  always run. Also returns `reachabilityScanned` (W1-T1118), read off {@link scanUnreachedExports}. */
function unwiredAdvisoriesFor(
  diff: string,
  report: string,
  diffFiles: string[],
  checkoutDir: string | undefined,
  taskDeclaredFiles: string[] | undefined,
  openTaskIds: ReadonlySet<string> | undefined,
  openTaskDeclaredFiles: ReadonlyMap<string, readonly string[]> | undefined,
): { advisories: UnwiredAdvisory[]; reachabilityScanned: number | null } {
  const out: UnwiredAdvisory[] = [];
  let reachabilityScanned: number | null = null;

  if (checkoutDir) {
    const { unreached, examined } = scanUnreachedExports(diff, checkoutDir);
    reachabilityScanned = examined;
    if (unreached.length > 0) {
      const wired = wiredAtPairs(report);
      const knownOpenIds = openTaskIds ?? new Set<string>();
      const honouredByTaskMarker = shipsUnwiredIds(report).some((id) => knownOpenIds.has(id));
      const stillUnmarked = honouredByTaskMarker
        ? []
        : unreached.filter((u) => !wired.has(`${u.file}::${u.name}`));
      if (stillUnmarked.length > 0) {
        const named = stillUnmarked.map((u) => `${u.file}::${u.name}`);
        out.push({
          reasonCode: "unwired_export",
          symbols: named,
          detail: `unreached export(s) added with no WIRED-AT/SHIPS-UNWIRED marker: ${named.join(", ")}`,
        });
      }
    }
  }

  const untouched = inverseScopeUntouchedFiles(diffFiles, taskDeclaredFiles);
  if (untouched.length > 0) {
    out.push({
      reasonCode: "inverse_scope",
      symbols: untouched,
      detail: `task declares file(s) this diff never touched: ${untouched.join(", ")}`,
    });
  }

  const violating = scopeViolationFiles(diffFiles, taskDeclaredFiles);
  if (violating.length > 0) {
    out.push({
      reasonCode: "scope_violation",
      symbols: violating,
      detail: `diff touches file(s) outside the task's declared scope: ${violating.join(", ")}`,
    });
  }

  const unresolvedOverlaps = unresolvedTaskScopeOverlaps(diffFiles, taskDeclaredFiles, openTaskDeclaredFiles);
  if (unresolvedOverlaps.size > 0) {
    const named = [...unresolvedOverlaps.entries()].map(([taskId, files]) => `${taskId}: ${files.join(", ")}`);
    const symbols = [...new Set([...unresolvedOverlaps.values()].flat())].sort();
    out.push({
      reasonCode: "unresolved_task_scope",
      symbols,
      // A QUESTION, never a claim (design note): this is an overlap the gate cannot verify, not
      // an assertion that this PR IS one of the named tasks.
      detail:
        `no task resolved for this PR, and this diff touches file(s) declared by open task(s) — ` +
        `${named.join("; ")} — is one of these the task this PR implements? if so, add a ` +
        `"Remudero-Task: <id>" trailer to the PR body so merge credit resolves.`,
    });
  }

  return { advisories: out, reachabilityScanned };
}

// ── DECISIONS.md entry provenance floor (W1-T352) ──────────────────────────

/** The one file this floor watches — never any other markdown file's headers. */
const DECISIONS_MD_PATH = "DECISIONS.md";

/** An added entry header: DECISIONS.md's own convention is a level-2 ATX header
 *  (`## <date> — <title>`) per entry; a deeper header (`### …`) is prose inside
 *  one entry, not the start of a new one. */
const DECISIONS_ENTRY_HEADER_RE = /^##\s+/;

/** THE CLOSED VOCABULARY (W1-T352 design (ii)), derived from the corpus and never invented, matched
 *  case-insensitively as a plain substring over an entry's OWN added lines: the machine auto-choose
 *  stamp, the hand-record line's surface forms already in use, and an explicit operator-attribution
 *  sentence in the #1303 amendment's own words. Pinned by test/review.test.ts, so an edit here is a
 *  deliberate, reviewed change rather than a silent narrowing. */
const DECISIONS_PROVENANCE_MARKERS: readonly string[] = [
  "chosen (recommended, auto)",
  "operator-authored",
  "operator direction record",
  "operator-ruled",
  "the operator has overridden",
];

/** True when at least one of an entry's own added lines carries a {@link DECISIONS_PROVENANCE_MARKERS} marker. */
function decisionsEntryHasProvenance(addedLines: readonly string[]): boolean {
  const joined = addedLines.join("\n").toLowerCase();
  return DECISIONS_PROVENANCE_MARKERS.some((marker) => joined.includes(marker));
}

/** DECISIONS.md ENTRY PROVENANCE FLOOR (W1-T352): every entry header (`## …`) a diff ADDS must carry, among that
 * entry's own added lines, either the machine stamp or an operator-attribution line ({@link
 * DECISIONS_PROVENANCE_MARKERS}). READS THE DIFF, NOT THE FILE (design (i)): only ADDED lines are consulted, so
 * historical unmarked entries never fire, nor does a PR that edits the file without adding a `## ` header. An entry's
 * span runs to the next added header or the end of the hunk. NO SEMANTIC CLASSIFICATION (design (iii)): requiring the
 * mark on every new entry makes "is this a binding ruling?" moot. */
export function decisionsEntryProvenanceViolations(diff: string): string[] {
  const lines = walkDiff(diff).filter((l) => l.file === DECISIONS_MD_PATH);
  const violations: string[] = [];
  let header: string | null = null;
  let added: string[] = [];
  const flush = () => {
    if (header !== null && !decisionsEntryHasProvenance(added)) violations.push(header);
    header = null;
    added = [];
  };
  for (const l of lines) {
    if (l.kind !== "add") continue;
    if (DECISIONS_ENTRY_HEADER_RE.test(l.text)) {
      flush();
      header = l.text.trim();
      added = [l.text];
      continue;
    }
    if (header !== null) added.push(l.text);
  }
  flush();
  return violations;
}

/** The pure verdict function (acceptance #2). Given the acceptance criteria and the evidence, roll up a single
 *  `remudero-review` state. FAIL-CLOSED: empty criteria, any unmet criterion, or test theater all yield `failure`. */
/** W1-T2472: THE one definition of "this changeset is plan-only", extracted so two callers cannot drift — {@link
 *  judgeReview} for the W1-T205 classification, and run-task.ts's reviewer-spawn gate via {@link planOnlyDiff}. Takes
 *  both already-computed inputs rather than a diff, because judgeReview holds them and re-deriving would walk the
 *  diff a second time. */
function planOnlyFromFiles(diffFiles: string[], enforcementData: string[]): boolean {
  return diffFiles.length > 0 && diffFiles.every(isInPlanScope) && enforcementData.length === 0;
}

/** {@link planOnlyFromFiles} over a raw unified diff — the form run-task.ts's spawn gate needs,
 *  since it holds the diff text and not judgeReview's intermediates. Same predicate, one definition:
 *  a change to plan-only classification lands in both callers or in neither. */
export function planOnlyDiff(diff: string): boolean {
  const diffFiles = changedFiles(walkDiff(diff));
  return planOnlyFromFiles(diffFiles, enforcementDataInDiff(diffFiles));
}

/** W1-T2743 — ONE REVIEW, ONE EXECUTION PER UNIQUE PROOF. TRAP: `judgeReview` maps every criterion
 * through {@link judgeCriterion} with one shared {@link ProofExecContext} that carried the RAW executor, so each
 * criterion spawned its proof again, and a passing proof is re-run against the merge base for staleness — N criteria
 * citing one path could cost 2N child processes. INVARIANT: the key is checkout path plus executable plus exact argv,
 * and `cwd` IS in the key, so a head and a merge-base observation can never alias; the memo dies with the call, so
 * this is NOT A CROSS-REVIEW CACHE, and a THROW IS AN OBSERVATION TOO, replayed rather than re-run.
 * // Why: all six criteria of #3744 named the byte-identical proof and posted six samples of ONE fact. */
export interface ProofExecutionMemo {
  /** The wrapped executor to hand {@link ProofExecContext.exec}. */
  exec: ProofExecutor;
  /** Distinct (cwd, command, argv) triples actually executed — head and base counted separately. */
  uniqueRuns: () => number;
  /** How many calls were answered from a prior observation instead of spawning. */
  reuses: () => number;
}

export function memoizeProofExecutor(exec: ProofExecutor): ProofExecutionMemo {
  // Two maps rather than one sentinel-bearing map: a cached THROW and a cached "no-match" must not
  // be distinguishable only by a value that could itself be a legitimate result.
  const returned = new Map<string, "pass" | "fail" | "no-match">();
  const thrown = new Map<string, unknown>();
  let uniqueRuns = 0;
  let reuses = 0;
  const keyOf = (w: WhitelistedProof, cwd: string): string =>
    // `cwd` FIRST and delimited: the head/base separation is the load-bearing half of this key.
    JSON.stringify([cwd, w.command, [...w.args]]);
  return {
    exec: (whitelisted, cwd) => {
      const key = keyOf(whitelisted, cwd);
      if (thrown.has(key)) {
        reuses += 1;
        throw thrown.get(key);
      }
      if (returned.has(key)) {
        reuses += 1;
        return returned.get(key) as "pass" | "fail" | "no-match";
      }
      uniqueRuns += 1;
      try {
        const outcome = exec(whitelisted, cwd);
        returned.set(key, outcome);
        return outcome;
      } catch (e) {
        thrown.set(key, e);
        throw e;
      }
    },
    uniqueRuns: () => uniqueRuns,
    reuses: () => reuses,
  };
}

export function judgeReview(
  criteria: AcceptanceCriterion[],
  evidence: ReviewEvidence,
): ReviewVerdict {
  const reportTokens = new Set(tokenize(evidence.report));
  // W1-T205/W1-T427/W1-T2472: compute plan-only before grading so W1-T2713 can choose which of
  // the criterion's texts supplies the floor's keywords. The predicate and inputs are unchanged;
  // this is only a move ahead of the consumer that now needs them.
  const diffFiles = changedFiles(walkDiff(evidence.diff));
  const enforcementData = enforcementDataInDiff(diffFiles);
  const planOnly = planOnlyFromFiles(diffFiles, enforcementData);
  // `taskDeclaredFiles` is the resolved-task signal throughout this module. On the only arm changed here — a
  // plan-only diff — it means the criteria were loaded from the task shard rather than parsed from the PR body, so
  // the proof arrived with the criteria and its filename cannot be evidence about the body (W1-T2713). BOTH arms
  // score against the report; see judgeCriterion's `floorKeywords` doc for why no arm may read the criterion itself
  // (R-15).
  const floorKeywords = planOnly && (evidence.taskDeclaredFiles?.length ?? 0) > 0 ? "claim" : "proof";
  // Read straight off THIS diff, never off a resolved task id (W1-T456, DEFECT A): a filing PR carries no
  // `Remudero-Task:` trailer (#1527), so there is no id to look `files:` up against. Unioned with a resolved task's
  // own declared files so a plain implementing PR loses nothing.
  const forwardReferenceFiles = new Set([...shardDeclaredFilesInDiff(evidence.diff), ...(evidence.taskDeclaredFiles ?? [])]);
  // Absent headCheckoutDir ⇒ execCtx undefined ⇒ every criterion is not_executable and the keyword floor is
  // byte-identical to pre-W1-T65. W1-T2743: ONE memo per judgeReview call, wrapping whichever executor this review
  // would have used. Built here rather than inside judgeCriterion so that function stays byte-compatible for its
  // audit callers, which must keep spawning per call.
  const proofMemo = evidence.headCheckoutDir ? memoizeProofExecutor(evidence.execProof ?? execWhitelistedProof) : undefined;
  const execCtx: ProofExecContext | undefined = evidence.headCheckoutDir
    ? {
        cwd: evidence.headCheckoutDir,
        exec: proofMemo?.exec,
        baseCwd: evidence.baseCheckoutDir,
        baseUnreadablePaths: evidence.baseUnreadablePaths,
        baseIsCheckout: evidence.baseIsCheckout,
        forwardReferenceFiles,
        // W1-T2737: the SAME `planOnly` computed above — one derivation, so the reviewer's
        // scope judgement and the forward-reference carve-out can never disagree.
        planOnlyDiff: planOnly,
      }
    : undefined;
  const verdicts = criteria.map((c, i) =>
    judgeCriterion(
      c,
      reportTokens,
      evidence.semantic?.[i],
      execCtx,
      evidence.reportIsSubstitute,
      evidence.semanticClauses?.[i],
      evidence.reportSubstituteCause,
      floorKeywords,
    ),
  );
  const testTheater = detectTestTheater(evidence.diff);

  // W1-T58 (Standing rule 15 — RATIFIES P3): see {@link ReviewVerdict.criteriaTampered}'s
  // doc for the full design. `!planOnly` is the exemption — a genuine Architect
  // plan-only correction is never this function's business to fail.
  const criteriaTampered = !planOnly && criterionFieldTampered(evidence.diff);

  // A pure comparison of two values already computed above — no new fetch, no new gateway (W1-T274). W1-T1100 design
  // (ii): a detector comparing the BODY's claims against the diff must REFUSE on a substitute rather than judge one
  // (#2395). W1-T1264: one call produces both the contradictions and the recognition count, withheld together —
  // `undefined`, never `0`/`false` — so "not computed" is never confused with "found nothing".
  const changesetRecognition = evidence.reportIsSubstitute ? undefined : recognizeChangesetClaims(evidence.report, diffFiles);
  const changesetContradictions = changesetRecognition?.contradictions ?? [];

  // W1-T297 (Standing rule 25): see {@link ReviewVerdict.instrumentEntangled}'s
  // doc. Reuses the SAME `diffFiles` every other structural check above
  // already computed — no new diff walk.
  const instrumentEntanglement = detectInstrumentEntanglement(diffFiles, evidence.diff);
  const instrumentEntangled = instrumentEntanglement.entangled;

  // W1-T352 (DECISIONS.md entry provenance floor): see {@link
  // ReviewVerdict.unprovenancedDecisionsEntries}'s doc for the full design — BLOCKING, unlike the
  // W1-T322 advisory floor computed right below it.
  const unprovenancedDecisionsEntries = decisionsEntryProvenanceViolations(evidence.diff);

  // W1-T322 (SHIPS-UNWIRED advisory floor): computed alongside the structural checks above but
  // folded into NEITHER `state` NOR `floorState` below — see {@link ReviewVerdict.unwiredAdvisories}'s
  // doc for why (ADVISORY ONLY, by design, until W1-T323's measured flip).
  const { advisories: unwiredAdvisories, reachabilityScanned } = unwiredAdvisoriesFor(
    evidence.diff,
    evidence.report,
    diffFiles,
    evidence.headCheckoutDir,
    evidence.taskDeclaredFiles,
    evidence.openTaskIds,
    evidence.openTaskDeclaredFiles,
  );

  const unmet = verdicts.filter((v) => !v.met);
  const noCriteria = criteria.length === 0;
  // W1-T2221: hoisted ahead of `state` (was previously computed only for `floorState`,
  // below) so `state` itself can consult it on a plan-only diff — see `unmetForState`.
  const floorUnmet = verdicts.filter((v) => !(v.floorMet ?? v.met));
  // On a plan-only diff, `state` is decided on the FLOOR: a semantic downgrade alone must never fail a filing that
  // has no code for the semantic lane to judge (W1-T2221 design (ii)). `planOnly` is the exemption, never "a proof
  // happened not to execute" — the same shape `criteriaTampered` uses, and the one rationale (6) says must not be
  // re-derived from execution facts. A code diff is byte-identical to today: `unmetForState === unmet`.
  const unmetForState = planOnly ? floorUnmet : unmet;
  const state: ReviewState =
    noCriteria ||
    unmetForState.length > 0 ||
    testTheater ||
    criteriaTampered ||
    changesetContradictions.length > 0 ||
    instrumentEntangled ||
    unprovenancedDecisionsEntries.length > 0
      ? "failure"
      : "success";

  // The reward-hacking measurement, over ALL criteria (W1-T166): visible and holdout fold into `state` identically
  // above, and this is a SEPARATE per-run measurement of the gap between them, never a gate. `null` when either side
  // has nothing to measure.
  const visibleVerdicts = visibleCriteria(verdicts);
  const holdoutVerdicts = verdicts.filter((v) => v.holdout);
  const visiblePassRate = visibleVerdicts.length > 0 ? visibleVerdicts.filter((v) => v.met).length / visibleVerdicts.length : null;
  const holdoutPassRate = holdoutVerdicts.length > 0 ? holdoutVerdicts.filter((v) => v.met).length / holdoutVerdicts.length : null;
  const rewardHackingGap = visiblePassRate !== null && holdoutPassRate !== null ? visiblePassRate - holdoutPassRate : null;

  // The SAME rollup, ignoring semantic entirely — every criterion judged on `floorMet` (W1-T178).
  // `testTheater`/`noCriteria`/`criteriaTampered`/`changesetContradictions` are all structural, so they bind the
  // floor exactly as they bind `state`: a tampering or contradiction failure can never be suppressed by verdict
  // stability, which only ever forgives a SEMANTIC downgrade. The anchor a re-review of an unchanged head checks.
  const floorState: ReviewState =
    noCriteria ||
    floorUnmet.length > 0 ||
    testTheater ||
    criteriaTampered ||
    changesetContradictions.length > 0 ||
    instrumentEntangled ||
    unprovenancedDecisionsEntries.length > 0
      ? "failure"
      : "success";

  // Nothing was OBSERVED on the head anywhere in this review, yet at least one proof was WRITTEN to be runnable
  // (W1-T72): the binding verdict fell back to the blind keyword floor on EVERY criterion, not because the proofs
  // were legitimately prose. A `satisfied_by` criterion is excluded — an Architect override never attempts execution
  // BY DESIGN.
  const executedCount = verdicts.filter(
    (v) => v.proof_exec === "executed_pass" || v.proof_exec === "executed_fail",
  ).length;
  const floorDegraded =
    executedCount === 0 && criteria.some((c) => !c.satisfied_by && isDialectPrefixed(c.proof));

  // CAPPED is a FACT about what ran, computed UNCONDITIONALLY — never gated on `state` and never forcing it (CAPPED
  // IS NOT FAIL; see {@link ReviewVerdict.capped}). W1-T185 closes a W1-T128 gap, MASTER-PLAN rule 22 fixture (iii).
  // `satisfied_by`-only criteria are excluded from the "could have executed" set, and a review with no executable
  // criteria at all is never capped.
  const executableCriteria = criteria.filter((c) => !c.satisfied_by);
  const capped = executableCriteria.length > 0 && executedCount === 0;

  // W1-T305 (design (4)): SOME but not ALL executable criteria were observed — the 52-partial-head
  // shape the rationale measured, distinct from `capped` (zero observed anywhere).
  const partiallyExecuted = executableCriteria.length > 0 && executedCount > 0 && executedCount < executableCriteria.length;

  // W1-T305 (design (1)/(2)): the unexecutable class, made countable. `unexecutableCount` folds
  // holdout criteria in (an aggregate NUMBER, never secret — matches `capped`'s own scope);
  // `unexecutableProofs` is VISIBLE-only text (holdout proof text stays worker-invisible, W1-T166).
  const unexecutableCount = verdicts.filter((v) => v.proof_skip !== undefined).length;
  const unexecutableProofs = visibleVerdicts.filter((v) => v.proof_skip !== undefined).map((v) => v.proof);

  // This verdict never attempted execution for ANY criterion — no `headCheckoutDir` was given (W1-T185, the second
  // W1-T128 gap), today's case when `rmd review`'s worktree materialisation fails or is skipped; the operator's
  // working checkout is never substituted (HEAD DISCIPLINE, W1-T65). Purely legibility — `state` is unaffected — but
  // the status, ledger and console must say so rather than let a keyword-only PASS read as an observed one.
  const keywordOnly = execCtx === undefined;

  // PLAN-ONLY CLASSIFICATION (W1-T205), computed ahead of `state` so the W1-T58 guard can consult it. Reuses the
  // review path's OWN diff-walker and plan-architect's own {@link isInPlanScope} — the same guard `rmd plan`'s
  // PROPOSED-outcome check and the W1-T136 filing-PR emitter use — rather than a third, divergent notion. FAILS
  // CLOSED: an empty diff, or one touching a single file outside `plan/**`/`MASTER-PLAN.md`, is NOT plan-only.

  // A capped `state: "success"` NEVER uses passSummary's "substantiated"/"no test theater" wording: neither claim was
  // measured. A PLAN-ONLY success renders via {@link planOnlySummary}, because "0 proofs executed" is not a
  // degradation for a PR with nothing executable to point at. W1-T2221: `planOnly` is consulted BEFORE `capped`, so a
  // plan-only diff whose declared proof path happened to resolve and RUN still reaches that summary.
  const summary =
    state === "success"
      ? planOnly
        ? planOnlySummary(verdicts.length)
        : capped
          ? cappedSummary(verdicts.length, keywordOnly, enforcementData)
          : passSummary(
              verdicts.length,
              keywordOnly,
              // W1-T305 (design (4)): a partially-observed PASS never renders identically to a fully-
              // observed one — the fraction actually executed rides on the same commit-status text.
              partiallyExecuted ? { executed: executedCount, executable: executableCriteria.length } : undefined,
            )
      : failSummary(
          // Only VISIBLE unmet claims name themselves in the posted summary (W1-T166); a holdout
          // claim never reaches this text, which becomes both the commit-status description and the
          // ledger's failure text, each worker-readable. W1-T2221 uses `unmetForState`, not `unmet`,
          // so a plan-only diff's failure text names only genuine FLOOR failures — a no-op on a code
          // diff, where the two are equal.
          visibleCriteria(unmetForState).map((v) => v.claim),
          testTheater,
          noCriteria,
          criteriaTampered,
          unmetForState.length - visibleCriteria(unmetForState).length,
          changesetContradictions,
          instrumentEntangled ? instrumentEntanglement : undefined,
          unprovenancedDecisionsEntries,
        );

  return {
    state,
    criteria: verdicts,
    testTheater,
    summary,
    floorDegraded,
    // W1-T2743: `undefined` when nothing could execute (no head checkout), never 0 — "measured
    // none" and "never measured" are different facts and a ledger row must not conflate them.
    proofUniqueRuns: proofMemo?.uniqueRuns(),
    proofReuses: proofMemo?.reuses(),
    floorState,
    capped,
    keywordOnly,
    planOnly,
    criteriaTampered,
    changesetContradictions,
    changesetClaimsRecognised: changesetRecognition?.recognisedCount,
    changesetFenceUnbalancedAtEof: changesetRecognition?.fenceUnbalancedAtEof,
    instrumentEntangled,
    instrumentEntanglementPaths: instrumentEntangled
      ? { instrumentPaths: instrumentEntanglement.instrumentPaths, srcPaths: instrumentEntanglement.srcPaths }
      : undefined,
    unprovenancedDecisionsEntries,
    unwiredAdvisories,
    reachabilityScanned,
    rewardHackingGap,
    unexecutableCount,
    unexecutableProofs,
    partiallyExecuted,
    executedProofCount: executedCount,
    executableProofCount: executableCriteria.length,
  };
}

/** The exact PASS status-description text, shared by {@link judgeReview} and a verdict-stability suppression so a
 *  suppressed downgrade posts a summary byte-identical to a review that passed outright, never a "success" state
 *  paired with failure-shaped prose. `keywordOnly` (W1-T185) appends a tag so a PASS with no proof ever executed is
 *  not mistaken for an OBSERVED one; `partial` (W1-T305 design (4)) appends "(PARTIAL: X/Y)" when SOME but not all
 *  executable criteria were observed — never alongside `keywordOnly`, which implies zero executed and routes through
 *  {@link cappedSummary}. */
function passSummary(criteriaCount: number, keywordOnly = false, partial?: { executed: number; executable: number }): string {
  return (
    `remudero-review: PASS — ${criteriaCount} criteria substantiated, no test theater` +
    (partial ? ` (PARTIAL: ${partial.executed}/${partial.executable} proofs executed on the PR head)` : "") +
    (keywordOnly ? " (keyword-only: no proof was executed on the PR head)" : "")
  );
}

/** The CAPPED status-description text (W1-T185), posted whenever a verdict that would otherwise render as a clean
 *  PASS observed zero proof executions. Deliberately contains neither "substantiated" nor "no test theater": CAPPED
 *  means "not certified", never "rejected", and this is still a `state: "success"` status. `keywordOnly` appends the
 *  same tag {@link passSummary} does.
 *  // Why: criterion 1's falsifier is #411, which posted PASS text at `proof_exec: 0/5` directly beneath its own
 *  // FLOOR DEGRADED banner. */
function cappedSummary(criteriaCount: number, keywordOnly = false, enforcementData: string[] = []): string {
  return (
    `remudero-review: CAPPED — 0/${criteriaCount} proofs executed; not certified ` +
    `(a keyword match is a claim, not evidence)` +
    (keywordOnly ? " (keyword-only: no proof was executed on the PR head)" : "") +
    // A plan-scope diff that is nonetheless NOT plan-only must SAY WHY on the status itself (W1-T427). This is the
    // only rendering an operator sees for the denial, and an unexplained red is the shape that gets overridden — here
    // it would read as the carve-out mysteriously failing rather than as the category doing its job. The
    // capped-SUCCESS path is the one that matters: a failing review already renders its own reason via {@link
    // failSummary}.
    (enforcementData.length > 0
      ? ` (ENFORCEMENT_DATA: ${enforcementData.join(", ")} — the plan-only carve-out does not ` +
        `apply to the data the gates themselves obey)`
      : "")
  );
}

/** The PLAN-ONLY status-description text (W1-T205), posted in place of {@link cappedSummary} whenever a capped
 *  success's diff is plan-only. Deliberately never says "CAPPED" or "not certified": those read as something going
 *  wrong, and nothing did — filing a task has no code to run a proof against, so "0 proofs executed" is its
 *  permanent, correct shape. Names what actually gated the PR, so an operator is told the truth (standing rule 22). */
function planOnlySummary(criteriaCount: number): string {
  return (
    `remudero-review: PASS — plan-only PR (${criteriaCount} criteria), gated deterministically ` +
    `(lint-plan + the plan-PR emitter + plan-index checks); no proof execution attempted, ` +
    `by design (W1-T205)`
  );
}

// ── VERDICT STABILITY (W1-T178) ─────────────────────────────────────────────
// RULE: a re-review of an UNCHANGED head sha whose deterministic FLOOR still passes may not render a verdict WORSE
// than its predecessor. The semantic lane's downgrade on that input is noise; a legitimate downgrade always cites NEW
// INFORMATION — a changed head sha, or the floor itself failing — and either bypasses this rule. ASYMMETRIC BY
// DESIGN: do not "fix" this into a general sha-pinned-verdict rule (W1-T102). Only a SUCCESS→failure transition on an
// unchanged sha is suppressed; a failure→success UPGRADE always posts as computed, and pinning symmetrically would
// re-create the #177 stale-status exhaustion T102 fixed.
// // Why: #388 posted success then failure on the identical head sha, burning fix-rung strike 2 (#395).
// ────────────────────────────────────────────────────────────────────────────

/** The most recent `review.posted` verdict recovered from the ledger for a PR
 * — {@link applyVerdictStability}'s `prior` argument. */
export interface PriorReviewVerdict {
  headSha: string;
  state: ReviewState;
  /** W1-T229's `capped` as RECORDED on the `review.posted` line — read back rather than recomputed, so the arming
   *  path judges the same fact the review posted. It was always written; nothing read it, so a CAPPED verdict —
   *  which posts `state: "success"` because CAPPED IS NOT FAIL — armed on the strength of that success alone. ABSENT
   *  MEANS NOT CAPPED (operator ruling, binding): lines older than the field carry no key, and failing closed would
   *  refuse to arm across the entire pre-field history. {@link cappedFieldAbsent} keeps that fail-open choice
   *  legible. */
  capped: boolean;
  /** Recorded `plan_only`. Carried because {@link decideAutoMergeArm}'s W1-T205 carve-out reads
   *  it; same absent-means-false rule. */
  planOnly: boolean;
  /** True when the ledger line carried no `capped` key at all, so {@link capped} above is the
   *  fail-open DEFAULT rather than a recorded fact. Surfaced in the arm decision's own reason
   *  string — no new ledger step, so a polling lane cannot amplify it into per-tick noise. */
  cappedFieldAbsent?: true;
  /** Recorded `partially_executed`, read back the way `capped`/`planOnly` are (W1-T1020), so {@link
   *  decideAutoMergeArm} judges the fact the review posted rather than the always-false default it
   *  silently took. Written unconditionally, so ABSENT MEANS NOT PARTIAL. Optional purely so
   *  fixtures predating the field keep compiling; a missing value is `false`, never "unknown". */
  partiallyExecuted?: boolean;
}

/** Result of applying the W1-T178 verdict-stability rule to a freshly computed verdict. */
export interface VerdictStabilityResult {
  /** The verdict to actually POST — identical to `computed` unless a downgrade was suppressed. */
  verdict: ReviewVerdict;
  /** True when a semantic-lane downgrade on unchanged input was suppressed this call. */
  suppressed: boolean;
}

/** Recover the most recent `review.posted` verdict for `taskId` from ledger lines, last one wins —
 * the same scanning idiom `unmetFromLedger` (run-task.ts) and every other precedence helper here
 * already use, over the same line that carries `head_sha` and `state`. No new storage. */
export function priorReviewVerdictFromLedger(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string,
): PriorReviewVerdict | undefined {
  let prior: PriorReviewVerdict | undefined;
  for (const line of lines) {
    if (line.step !== "review.posted" || line.task_id !== taskId) continue;
    if (typeof line.head_sha !== "string") continue;
    if (line.state !== "success" && line.state !== "failure") continue;
    // `capped`/`plan_only` are read back from the SAME line that carried `state`, never recomputed: the arming path
    // must judge the verdict that was actually posted. A non-boolean is the fail-open default, recorded via
    // `cappedFieldAbsent` so the decision can say it took that.
    const cappedRecorded = typeof line.capped === "boolean" ? line.capped : undefined;
    prior = {
      headSha: line.head_sha,
      state: line.state,
      capped: cappedRecorded ?? false,
      planOnly: typeof line.plan_only === "boolean" ? line.plan_only : false,
      ...(cappedRecorded === undefined ? { cappedFieldAbsent: true as const } : {}),
      // Same "absent means false" rule as `capped`/`plan_only` (W1-T1020), but spread in ONLY when the line carries
      // the key, so an older line reconstructs a byte-identical object rather than gaining a `partiallyExecuted:
      // false` key nobody asked for.
      ...(typeof line.partially_executed === "boolean" ? { partiallyExecuted: line.partially_executed } : {}),
    };
  }
  return prior;
}

/** Apply the W1-T178 verdict-stability rule (see the block comment above) to a freshly computed
 * verdict. Pure — the falsifier this exists to prove is a unit fixture, like `judgeReview` itself. */
export function applyVerdictStability(
  computed: ReviewVerdict,
  headSha: string,
  prior: PriorReviewVerdict | undefined,
): VerdictStabilityResult {
  const floorState = computed.floorState ?? computed.state; // no floor info ⇒ never suppress
  const isUnchangedSemanticDowngrade =
    prior !== undefined &&
    prior.headSha === headSha &&
    prior.state === "success" &&
    computed.state === "failure" &&
    floorState === "success";
  if (!isUnchangedSemanticDowngrade) return { verdict: computed, suppressed: false };

  // The floor passed, so every criterion's floorMet is true; rebuild the criteria list off the floor result so the
  // posted verdict stays internally consistent — never a "success" state sitting beside a criteria array that still
  // shows a semantic "unmet".
  const criteria = computed.criteria.map((c) => {
    const floorMet = c.floorMet ?? c.met;
    return c.met === floorMet
      ? c
      : {
          ...c,
          met: floorMet,
          reason:
            `${c.reason} — semantic downgrade suppressed: deterministic floor still passes on ` +
            `unchanged head ${headSha.slice(0, 7)} (verdict-stability, W1-T178)`,
        };
  });
  return {
    verdict: {
      ...computed,
      state: "success",
      criteria,
      summary: passSummary(
        criteria.length,
        computed.keywordOnly,
        // W1-T305: the suppressed rebuild carries the SAME partial-execution facts `computed`
        // already measured (suppression only replaces `state`/`criteria`/`summary`, never
        // re-executes anything), so a re-review's "PARTIAL" tag survives verdict stability too.
        computed.partiallyExecuted
          ? { executed: computed.executedProofCount ?? 0, executable: computed.executableProofCount ?? 0 }
          : undefined,
      ),
    },
    suppressed: true,
  };
}

/** The LOUD console annotation for a degraded floor (W1-T72 design (i)), printed once per review.
 * `criteriaCount` is the "N" in "0/N". Pure and exported so the exact text is a unit-testable
 * falsifier, independent of the console call site in run-task.ts. */
export function floorDegradedAnnotation(criteriaCount: number): string {
  return (
    `FLOOR DEGRADED: 0/${criteriaCount} proofs executed; keyword floor was binding — ` +
    `a dialect-prefixed proof ('grep: …' / 'unit test: …') was written to be runnable ` +
    `but nothing was observed on the PR head.`
  );
}

/** True when a task's `principles: {tdd: strict}` is declared. The ONLY input {@link judgeReview}
 * consults to decide whether a zero-executed verdict is CAPPED (W1-T185): a task that never
 * declared tdd:strict is never capped, because it never claimed executed proof was mandatory. */
export function isTddStrict(principles?: Record<string, unknown>): boolean {
  return principles?.tdd === "strict";
}

/** The LOUD console annotation for a CAPPED verdict (W1-T185), printed once per review. Mirrors
 * {@link floorDegradedAnnotation}: pure and exported so the exact text is a unit-testable falsifier. W1-T1085
 * appended `planOnly` LAST and defaulted, so no caller shifts. Every clause of the capped wording is FALSE for a
 * plan-only PR: it IS certified by the gates the status names, it does NOT refuse to arm, and the override it points
 * at is never reached, because {@link decideAutoMergeArm} returns above that branch. THE CAPPED WORDING IS UNCHANGED
 * where proof was expected and did not run.
 * // Why: the posted STATUS has been three-way since W1-T205 while this annotation stayed two-way. */
export function cappedAnnotation(criteriaCount: number, planOnly = false): string {
  if (planOnly) {
    // Mirrors {@link planOnlySummary}'s own ruling — never "CAPPED", never "not certified":
    // those words read as something going wrong, and for a plan-only PR nothing did.
    return (
      `PLAN-ONLY: 0/${criteriaCount} proofs executed and none was expected — filing or amending a ` +
      `task has no code to run a proof against, so this is its permanent, correct shape (W1-T205). ` +
      `Gated deterministically by lint-plan, the plan-PR emitter and the plan-index checks; ` +
      `auto-merge arming is unaffected.`
    );
  }
  return (
    `CAPPED: 0/${criteriaCount} proofs executed — not certified (a keyword match is a claim, ` +
    `never evidence). This refuses to arm auto-merge (see decideAutoMergeArm) until proof ` +
    `executes or an operator grants an explicit, ledgered override.`
  );
}

/** W1-T1085 — is the CAPPED DEGRADATION WORDING actually true of this verdict? `reviewCommand` has two further call
 *  sites beyond {@link cappedAnnotation}, both gated on `capped` alone: the "not certified" suffix and the
 *  `--override-capped-by` hint. Both are false for a plan-only PR, the second structurally — {@link
 *  decideAutoMergeArm} checks `planOnly` BEFORE the override branch, and `resolveAutoMergeArm` excludes `planOnly`
 *  from override-ledgering. A pure predicate rather than an inline condition, so both arms are falsifiable on their
 *  own; both sites are unchanged for a capped CODE PR. */
export function cappedWordingApplies(verdict: { capped?: boolean; planOnly?: boolean }): boolean {
  return verdict.capped === true && verdict.planOnly !== true;
}

// ── THE AUTO-MERGE ARMING PATH (W1-T185, closes gap 1's criteria 2-3) ───────
// GAP: `judgeReview`'s `state`/`capped` alone cannot express "cannot arm unattended" without also reddening every PR
// the moment a proof is unparseable, which criterion 3 forbids. So arming is a SEPARATE decision layer, consulted
// right before the caller would call `armAutoMerge`, and never folded into `state`/`floorState`.

/** An explicit, human-granted exception to "a CAPPED verdict cannot arm auto-merge". Never inferred,
 * never anonymous — `by` names WHO. Granted through `rmd review <pr> --override-capped-by` and recovered by {@link
 * cappedOverrideFromLedger}. INVARIANT: `headSha` BINDS the override to the PR head it was granted against (W1-T219,
 * recon R-14). Before it existed the override was an unauthenticated free string matched on `task_id` alone over an
 * append-only, unlocked ledger, so one appended line armed auto-merge on a CAPPED verdict for ANY later head of that
 * task. Optional on this TYPE only, so a caller
 * holding a hand-attributed override need not fabricate one; the binding is ENFORCED at recovery time. */
export interface CappedOverride {
  by: string;
  reason: string;
  headSha?: string;
}

/** The auto-merge arming path's decision (W1-T185). */
export interface ArmDecision {
  arm: boolean;
  reason: string;
  /** Set ONLY when a band row matching the resolved verdict class was itself malformed — an unrecognised `verdict`,
   *  never a missing or mismatched `class`, which is simply "no matching row" (W1-T2579). `arm`/`reason` are left
   *  EXACTLY as if the table had never been consulted (the fail-inert contract, design (ii)); this field is the
   *  "named" half of "a malformed band row is inert and NAMED", carried out-of-band. */
  bandWarning?: string;
}

/** Resolve which {@link ArmCalibrationBandRow} class an already-arming (uncapped) verdict belongs to (W1-T2579),
 *  mirroring `verdict-calibration.ts`'s own split. This file never imports that module: the same taxonomy, kept
 *  independent so this arming seam takes no dependency on the measurement module it is downstream of. The third
 *  class, `"degraded-arm"`, is never returned — design (iii) refuses it band eligibility BY CONSTRUCTION. */
type BandEligibleVerdictClass = "full-pass" | "keyword-floor";

/** Apply an operator-ratified {@link PolicyValues.armCalibrationBands} table to an ALREADY-ARMING
 * decision (W1-T2579). Pure, and defensive about `bands`, because a caller may hand it a row policy.ts's loader would
 * have refused. No row names `verdictClass` → `base` returns UNCHANGED, byte for byte. `verdict === "hold"` →
 * refuses, naming the class (`calibration-band:<class>`), because an operator-ratified hold is a REFUSAL, not a note.
 * `"notify"` → `base.arm` untouched, since it only narrows an already-true `arm` to "true, annotated". Anything else
 * is a MALFORMED row: `base` returns unchanged, matching the absent case exactly, but `bandWarning` names which
 * class's row was ignored —
 * inert, never silent. */
function applyCalibrationBand(
  base: ArmDecision,
  verdictClass: BandEligibleVerdictClass,
  bands: readonly ArmCalibrationBandRow[],
): ArmDecision {
  const row = bands.find((r) => r && typeof r === "object" && (r as { class?: unknown }).class === verdictClass);
  if (!row) return base;
  if (row.verdict === "hold") {
    return {
      arm: false,
      reason:
        `calibration-band:${verdictClass} — an operator-ratified band holds this class ` +
        `(underlying verdict: ${base.reason})`,
    };
  }
  if (row.verdict === "notify") {
    const note = typeof row.note === "string" && row.note.trim().length > 0 ? ` — ${row.note}` : "";
    return {
      arm: base.arm,
      reason: `${base.reason} (calibration-band:${verdictClass} notify${note})`,
    };
  }
  // Malformed: a row matched this class but its `verdict` is neither "hold" nor "notify" — only
  // reachable when a caller hands decideAutoMergeArm a `bands` array that bypassed policy.ts's
  // own loader (which refuses this shape at load, per ArmCalibrationBandRow's own doc).
  return {
    ...base,
    bandWarning:
      `calibration-band:${verdictClass} row is malformed (verdict must be "hold" or "notify", ` +
      `got ${JSON.stringify((row as { verdict?: unknown }).verdict)}) — ignored, decision unchanged`,
  };
}

/** Decide whether the auto-merge arming path may proceed, given a freshly computed verdict, whether the task
 * declares `principles: {tdd: strict}`, and an optional operator override. Pure.
 * - `state !== "success"` → refuse. The ordinary required-check gate, unrelated to capping.
 * - A CAPPED verdict refuses UNCONDITIONALLY, regardless of `tddStrict`, retained purely for override-provenance
 *   bookkeeping (W1-T229). A prior version armed any capped, non-tdd:strict PR exactly like an ordinary PASS.
 * - A `planOnly` CAPPED verdict arms WITHOUT an override (W1-T205), checked BEFORE the override branch so the arm
 *   reason names the carve-out. Such PRs are STRUCTURALLY capped, so the rule would otherwise block every retro,
 *   approve and filing PR forever; an exemption from PROOF EXECUTION only, never from `state`.
 * - An override permits arming on any other capped verdict; LEDGERING it is {@link resolveAutoMergeArm}'s job.
 * - An UNCAPPED verdict that observed only SOME executable criteria still arms, but its reason NAMES the partial
 *   shape (W1-T1020); absent `partiallyExecuted` keeps today's wording, since unknown must never regress.
 * - AFTER that, and only on the already-arming uncapped path, the resolved class is looked up in `bands` via {@link
 *   applyCalibrationBand}, defaulting to the committed `plan/policy.yaml` table — it ships empty, so every call site
 *   omitting it keeps today's behaviour byte-for-byte (test/arm-calibration-bands.test.ts). */
export function decideAutoMergeArm(
  verdict: Pick<ReviewVerdict, "state" | "capped" | "planOnly"> &
    Partial<Pick<ReviewVerdict, "partiallyExecuted" | "executedProofCount" | "executableProofCount">>,
  tddStrict: boolean,
  override?: CappedOverride,
  // A DIFF-DERIVED classification, never the static `risk:` field — the fleet gates on IRREVERSIBILITY, not
  // outwardness (W1-T947; DECISIONS.md 2026-08-16, W1-T919). That non-consultation is a standing ruling this
  // preserves. Appended LAST, so no positional caller shifts and every existing call site keeps today's behaviour
  // byte-for-byte.
  irreversible?: boolean,
  // THE RATIFIED BAND TABLE (W1-T2579). Appended LAST, like `irreversible` above, so no positional caller shifts.
  // `undefined` resolves to the committed `plan/policy.yaml` row, which ships `[]`, so omitting this parameter keeps
  // today's behaviour byte-for-byte. A caller wanting a specific table injects one directly, never touching disk.
  bands?: readonly ArmCalibrationBandRow[],
): ArmDecision {
  // Checked BEFORE `state`, `capped` and `override` — irreversibility is a hard refusal an
  // operator override can never buy back (the CAPPED override two branches down answers "was
  // enough proof executed", a different question from "can this diff's effect be undone").
  if (irreversible) {
    return {
      arm: false,
      reason:
        "diff classified IRREVERSIBLE (W1-T919: the fleet gates on irreversibility, not outwardness) — " +
        "auto-merge refuses regardless of the review verdict; an operator must arm this manually",
    };
  }
  if (verdict.state !== "success") {
    return { arm: false, reason: "remudero-review is not success" };
  }
  if (!verdict.capped) {
    const resolvedBands = bands ?? loadDefaultPolicy().values.armCalibrationBands;
    if (verdict.partiallyExecuted) {
      const hasCounts = typeof verdict.executedProofCount === "number" && typeof verdict.executableProofCount === "number";
      const base: ArmDecision = {
        arm: true,
        reason: hasCounts
          ? `verdict is a PARTIAL PASS (${verdict.executedProofCount}/${verdict.executableProofCount} executable ` +
            "criteria executed) — arms unchanged; legibility never becomes a refusal (W1-T1020)"
          : "verdict is a PARTIAL PASS (some, not all, executable criteria executed) — arms unchanged; " +
            "legibility never becomes a refusal (W1-T1020)",
      };
      return applyCalibrationBand(base, "keyword-floor", resolvedBands);
    }
    return applyCalibrationBand({ arm: true, reason: "verdict is a full PASS" }, "full-pass", resolvedBands);
  }
  if (verdict.planOnly) {
    return {
      arm: true,
      reason:
        "plan-only PR — structurally has no executable proof (filing/amending a task, not implementing " +
        "one); gated deterministically by lint-plan + the plan-PR emitter + plan-index checks, not by " +
        "proof execution (W1-T205 carve-out on the W1-T229 floor)",
    };
  }
  if (override) {
    return { arm: true, reason: `CAPPED override granted by ${override.by}: ${override.reason}` };
  }
  return {
    arm: false,
    reason:
      "CAPPED verdict (zero proofs executed) — refuses to arm auto-merge without executed proof " +
      "or an explicit, ledgered operator override",
  };
}

/** The auto-merge arming path WITH its ledger side effect (W1-T185, criterion 2). Wraps {@link decideAutoMergeArm}:
 *  when arming succeeds ONLY because an override was supplied for a genuinely capped verdict, this logs
 *  `automerge.capped_override_used` naming who. `log` is injected so the whole contract is a single unit fixture;
 *  run-task.ts is the real caller.
 *  // Why: an override that arms silently is the #411 hazard this task closes — auto-merge armed unattended, with
 *  // no human reading the diff. */
export function resolveAutoMergeArm(
  verdict: Pick<ReviewVerdict, "state" | "capped" | "planOnly"> &
    Partial<Pick<ReviewVerdict, "partiallyExecuted" | "executedProofCount" | "executableProofCount">>,
  tddStrict: boolean,
  override: CappedOverride | undefined,
  log: (step: string, extra?: Record<string, unknown>) => void,
  // W1-T947: threaded straight through to {@link decideAutoMergeArm} — see its own doc.
  irreversible?: boolean,
  // W1-T2579: threaded straight through to {@link decideAutoMergeArm} — see its own doc.
  bands?: readonly ArmCalibrationBandRow[],
): ArmDecision {
  const decision = decideAutoMergeArm(verdict, tddStrict, override, irreversible, bands);
  // W1-T205: excludes `planOnly` — decideAutoMergeArm checks the carve-out BEFORE the
  // override branch, so a planOnly arm never actually consulted `override` even when one
  // happens to be present; logging "override used" here would misattribute the decision.
  if (decision.arm && override && verdict.capped && !verdict.planOnly) {
    log("automerge.capped_override_used", { by: override.by, reason: override.reason });
  }
  return decision;
}

// ── Status-provenance gate (W1-T203 — THE FORGE ATTACK) ─────────────────────
// `gh` runs OUTSIDE the sandbox with the operator's own ambient credential (recon R-3/R-6), and that credential is
// the only thing on the machine that can post a commit status — so any identity that can shell out to `gh`, a worker
// included, can post its own `remudero-review=success` and satisfy its own merge gate. This section closes the
// read-back half: at ARM TIME, whoever trusts a live status must first ask GitHub WHO posted it. GitHub attributes
// `creator.login` from the authenticating credential, unlike the state, description and context fields, which are
// request payload. The other two parts are the credential half ({@link postReviewStatus}'s dedicated identity) and
// hooks/deny-floor.sh.
// ────────────────────────────────────────────────────────────────────────────

/** Env var naming the GitHub login the dedicated `remudero-review` reviewer identity authenticates as — a
 *  fine-grained PAT or App token's own login, e.g. `remudero-reviewer[bot]`. Read by the orchestrator ONLY, never
 *  shipped to a worker's environment, the same containment `~/.config/remudero/**` gets in `settings/worker.json`'s
 *  deny-list. {@link resolveReviewProvenance}'s caller supplies it explicitly, so that pure function stays pure. */
export const REVIEWER_IDENTITY_ENV = "REMUDERO_REVIEWER_LOGIN";

/** Env var naming the dedicated reviewer identity's own credential. {@link postReviewStatus} uses it as `GH_TOKEN`,
 *  overriding whatever `gh` would resolve, so the ONE status that must carry unforgeable provenance is posted by an
 *  identity distinct from the credential every other `gh` call shares. Unset ⇒ ambient auth, byte-identical to
 *  pre-W1-T203: the bootstrap-ordering doctrine `docs/review-gate.md` documents for `ci-gate`. This ships DARK. */
export const REVIEWER_TOKEN_ENV = "REMUDERO_REVIEWER_TOKEN";

// ── THE PIN PRECONDITION (W1-T2442) ─────────────────────────────────────────
// `required_status_checks.checks[].app_id` is the only thing that turns a required context from "satisfied by
// convention" into "satisfied by a pinned identity" — a null `app_id` is not a weaker pin, it is NO pin, satisfied by
// any repo-scoped token. Pinning `remudero-review` is the obvious next step, and Q2 of this task's rationale records
// why it is not yet safe: pinning before the reviewer identity is provisioned AND observed live would make the gate
// fail closed with no signal, symptom-free. This section is a PURE READER, so when the credential backlog
// (W1-T203/W1-T990) is picked up the answer is measured rather than argued.
// ────────────────────────────────────────────────────────────────────────────

/** One entry off GitHub's `required_status_checks.checks[]` — the array that actually carries
 *  the pin (`contexts[]` is the deprecated name-only mirror and carries no `app_id` at all). */
export interface RequiredStatusCheckEntry {
  context: string;
  /** `null` ⇒ NOT pinned — satisfied by whichever actor posts the context, regardless of
   *  identity. A real pin is the GitHub App's numeric `app_id` (never the bot user id — see this
   *  task's own rationale Q2 on why `.creator.id`/`.actor_id` are a different, invalid number). */
  app_id: number | null;
}

/** The shape {@link unpinnedRequiredContexts} and {@link reviewGatePinPrecondition} read off a
 *  branch protection `required_status_checks` payload. `contexts` is carried for fidelity with
 *  the live API shape but never consulted — only `checks[]` carries the pin. */
export interface RequiredStatusChecksSnapshot {
  contexts?: readonly string[];
  checks: readonly RequiredStatusCheckEntry[];
}

/** Acceptance criterion 1: names every required context whose `app_id` is `null` — unpinned,
 * satisfied by any repo-scoped token — and omits any context already carrying a real `app_id`.
 * Pure; reads only `checks[]`. */
export function unpinnedRequiredContexts(snapshot: RequiredStatusChecksSnapshot): string[] {
  return snapshot.checks.filter((c) => c.app_id === null || c.app_id === undefined).map((c) => c.context);
}

/** Acceptance criterion 2: the reviewer identity's posture, in EXACTLY three states, never collapsed to a boolean
 * and never allowed to guess "provisioned" from a read it could not perform. `"dark"` — neither env var is set, the
 * documented default, a successful read that found none. `"unknown"` — the read itself failed, OR only ONE var is
 * set, an inconsistent half-configured state; degrading rather than guessing is the point, so it can NEVER render as
 * `"provisioned"` off an unconfirmed environment. `"provisioned"` — both set, the only state {@link
 * reviewGatePinPrecondition} treats as safe. Pure — `readEnvVar` is supplied, so this never reaches `process.env`. */
export function reviewerIdentityPosture(readEnvVar: (name: string) => string | undefined): ReviewerIdentityPosture {
  let token: string | undefined;
  let login: string | undefined;
  try {
    token = readEnvVar(REVIEWER_TOKEN_ENV);
    login = readEnvVar(REVIEWER_IDENTITY_ENV);
  } catch {
    // THE REASON, STATED, because the return value alone cannot carry it (W1-T2295 route (iv)). A throwing
    // `readEnvVar` and a successful read that found nothing are DIFFERENT facts: the failed read is `"unknown"`, the
    // successful empty read is `"dark"`. Nothing is erased — `"unknown"` can never be mistaken for `"provisioned"`,
    // which is the whole point of the three-state split.
    return "unknown";
  }
  const tokenSet = typeof token === "string" && token.trim().length > 0;
  const loginSet = typeof login === "string" && login.trim().length > 0;
  if (tokenSet && loginSet) return "provisioned";
  if (!tokenSet && !loginSet) return "dark";
  return "unknown";
}

export type ReviewerIdentityPosture = "provisioned" | "dark" | "unknown";

/** Whether {@link reviewGatePinPrecondition} could confirm the reviewer credential is present —
 *  presence only, NEVER the value (the value is never even an input to this reader). Mirrors
 *  {@link ReviewerIdentityPosture} 1:1 so the two can never disagree about which arm produced them. */
export type ReviewerCredentialPresence = "present" | "absent" | "unknown";

/** `"safe"` ⇒ pinning the currently-unpinned context(s) would not fail the gate closed.
 *  `"unsafe"` ⇒ pinning now risks exactly the no-signal failure Q2 of this task's rationale
 *  records: every fleet-posted status silently rejected for a mismatched app. */
export type ReviewGatePinVerdict = "safe" | "unsafe";

export interface ReviewGatePinPrecondition {
  verdict: ReviewGatePinVerdict;
  reviewerIdentity: ReviewerIdentityPosture;
  /** Presence only — see {@link ReviewerCredentialPresence}. */
  reviewerCredentialPresent: ReviewerCredentialPresence;
  /** Contexts {@link unpinnedRequiredContexts} found on the snapshot passed in. */
  unpinnedContexts: readonly string[];
  /** Human-readable justification. Always names {@link REVIEWER_TOKEN_ENV} when the verdict is
   *  `"unsafe"` on identity grounds (acceptance criterion 3) — never the credential's value. */
  reason: string;
}

/** THE PRECONDITION READER (acceptance criteria 3-5): a pure statement of whether pinning `remudero-review`'s
 *  `app_id` is safe to apply YET — never the pin itself, never a credential. Identity `"dark"` or `"unknown"` ⇒
 *  ALWAYS `"unsafe"`, naming {@link REVIEWER_TOKEN_ENV}; `"provisioned"` ⇒ `"safe"`, including criterion 5's
 *  falsifier where the context is ALREADY app-pinned. `reviewerCredentialPresent` derives from the posture alone. */
export function reviewGatePinPrecondition(
  snapshot: RequiredStatusChecksSnapshot,
  reviewerIdentity: ReviewerIdentityPosture,
): ReviewGatePinPrecondition {
  const unpinnedContexts = unpinnedRequiredContexts(snapshot);
  const reviewerCredentialPresent: ReviewerCredentialPresence =
    reviewerIdentity === "provisioned" ? "present" : reviewerIdentity === "dark" ? "absent" : "unknown";

  if (reviewerIdentity !== "provisioned") {
    const why =
      reviewerIdentity === "dark"
        ? `the reviewer identity is dark — ${REVIEWER_TOKEN_ENV} is not set`
        : `the reviewer identity is unknown — ${REVIEWER_TOKEN_ENV} could not be confirmed set`;
    return {
      verdict: "unsafe",
      reviewerIdentity,
      reviewerCredentialPresent,
      unpinnedContexts,
      reason:
        `pin is UNSAFE: ${why}, so pinning ` +
        `${unpinnedContexts.length > 0 ? unpinnedContexts.join(", ") : "a required context"} now risks the gate ` +
        `failing closed with no signal (every fleet-posted status rejected for a mismatched app)`,
    };
  }

  return {
    verdict: "safe",
    reviewerIdentity,
    reviewerCredentialPresent,
    unpinnedContexts,
    reason:
      unpinnedContexts.length > 0
        ? `pin is SAFE: the reviewer identity is provisioned (${REVIEWER_TOKEN_ENV} set) — ` +
          `${unpinnedContexts.join(", ")} may now be pinned to the app id`
        : `pin is SAFE: the reviewer identity is provisioned and every required context is already app-pinned`,
  };
}

/** One fetched `remudero-review` commit-status entry — the two fields {@link
 * resolveReviewProvenance} needs off GitHub's combined-status response, already deduped to the latest post per
 * context by GitHub itself. `undefined` means no status has ever been posted under
 * this context for the sha. */
export interface ReviewStatusEntry {
  /** Widened to {@link PostableReviewState} (W1-T913): a LIVE read off GitHub can genuinely be
   * `pending` now that {@link postReviewPending} posts one. {@link decideAutoMergeArmAtSha} covers
   * why a pending is never armed and never confused with the untrusted-poster or absent case. */
  state: PostableReviewState;
  /** GitHub's `creator.login` for this status — the one field a poster cannot spoof, since it is
   * server-attributed from the authenticating credential rather than the request body. `undefined`
   * only if GitHub's response is malformed, and treated the same as a mismatched login. */
  posterLogin?: string;
}

/** THE PROVENANCE GATE (acceptance criteria 1-3). Resolve what a fetched `remudero-review` status
 * ACTUALLY proves, gated on WHO posted it. No status at all → `"absent"`. A status posted by anyone OTHER than
 * `trustedLogin` → `"absent"`, REGARDLESS of its `state`, which covers both forge directions: an untrusted `success`
 * must not rescue a merge a genuine review would have failed, and an untrusted `failure` must not BLOCK one it would
 * have passed, since that converts a forge vector into a denial-of-service vector. A status posted by `trustedLogin`
 * → its own `state`, unchanged; W1-T913: a trusted `pending` passes straight through, and {@link
 * decideAutoMergeArmAtSha} keeps it from being read
 * as a verdict. Case-insensitive on the login compare, since GitHub logins are case-insensitive. */
export function resolveReviewProvenance(
  entry: ReviewStatusEntry | undefined,
  trustedLogin: string,
): PostableReviewState | "absent" {
  if (!entry) return "absent";
  if (!entry.posterLogin || entry.posterLogin.trim().toLowerCase() !== trustedLogin.trim().toLowerCase()) {
    return "absent";
  }
  return entry.state;
}

/** The "at arm time" half of the property: whatever a caller computed in-process, THIS decides whether the LIVE
 *  status on GitHub — read back and filtered by who posted it — still says a genuine reviewer passed. Deliberately
 *  narrow and orthogonal to {@link decideAutoMergeArm}'s capped/override layer, which reasons about a verdict
 *  computed before anything could have been posted, so a caller arms only when BOTH say yes. An absent or untrusted
 *  resolution refuses with a reason that never says "failure": that wording is reserved for a GENUINE failing
 *  review, so a forged or missing status is never confused with one in a log line or an escalation. */
export function decideAutoMergeArmAtSha(entry: ReviewStatusEntry | undefined, trustedLogin: string): ArmDecision {
  const resolved = resolveReviewProvenance(entry, trustedLogin);
  if (resolved === "success") {
    return {
      arm: true,
      reason: `remudero-review=success at this sha, posted by the trusted reviewer identity ('${trustedLogin}')`,
    };
  }
  if (resolved === "failure") {
    return { arm: false, reason: "remudero-review is not success" };
  }
  // A trusted PENDING is neither "success" nor "failure" nor "absent": it is a review genuinely in progress (W1-T913
  // design (e)). NAMED explicitly, ahead of the untrusted-poster fallback, so a pending is never worded as if it were
  // forged, missing or failing. Arming stays withheld either way, but the REASON must stay honest — "never read as a
  // verdict in either direction".
  if (resolved === "pending") {
    return {
      arm: false,
      reason:
        "remudero-review is pending at this sha (review in progress, posted by the trusted reviewer " +
        "identity) — waiting for a terminal verdict, not read as a pass or a fail",
    };
  }
  return {
    arm: false,
    reason: entry
      ? `remudero-review at this sha was posted by '${entry.posterLogin ?? "unknown"}', not the trusted ` +
        `reviewer identity ('${trustedLogin}') — treated as ABSENT, not as a failure, so a forged or ` +
        `mistaken poster can never itself block a merge a genuine reviewer would pass`
      : "no remudero-review status found for this sha — treated as ABSENT, arming withheld",
  };
}

// ── THE LEDGER-KEYED ARM DECISION (W1-T230 — THE STATUS CHANNEL PROVED DECORATIVE) ──
// GitHub's commit-status API is a mutable, last-write-wins channel anything holding `gh` can post to, and the W1-T203
// provenance gate above is DARK in production, so the channel is exactly as trusted as before it shipped. House
// doctrine already answers this in the other direction — task status derives from GitHub rather than tasks.yaml
// because the yaml field proved decorative. Here it runs the other way: the arm decision derives from the
// orchestrator's OWN ledgered verdict. The status stays posted for branch protection and display, but is never an
// INPUT to this decision.
// // Why: #449 took SEVEN contradictory writes on one sha, one of them 85 seconds AFTER the PR merged.
// ────────────────────────────────────────────────────────────────────────────

/** THE ARM DECISION (W1-T230). Given the most recent `review.posted` verdict this orchestrator ledgered for a task
 * and the CURRENT live head sha, decide whether to arm auto-merge. Pure, so a fresh process re-derives it identically
 * from nothing but the ledger and the live head. No record at all → refuse, FAIL CLOSED, because a forged live-only
 * success with no ledger backing must arm nothing. A record for a DIFFERENT sha → refuse: the sha binding that makes
 * push-invalidates-review real at the decision layer, not only at display. A record for THIS sha arms only on
 * "success", regardless of what the live status channel currently says. */
export function decideArmFromLedgerVerdict(
  prior: PriorReviewVerdict | undefined,
  headSha: string,
  // Appended LAST so no positional caller shifts. Without it, delegating below would silently
  // drop the operator's `rmd review --override-capped-by` escape hatch on this path.
  override?: CappedOverride,
): ArmDecision {
  if (!prior) {
    return {
      arm: false,
      reason: "no ledgered review.posted verdict found for this task — arming withheld (W1-T230, fail closed)",
    };
  }
  if (prior.headSha !== headSha) {
    return {
      arm: false,
      reason:
        `ledgered verdict is for a different head (${prior.headSha.slice(0, 7)}), not the current head ` +
        `(${headSha.slice(0, 7)}) — a push after the verdict was posted must not arm the new head (W1-T230)`,
    };
  }
  // ── ONE RULE, ONE IMPLEMENTATION ──────────────────────────────────────────────────────────
  // The two checks above are W1-T230's and stay here: they decide WHICH verdict may be trusted, not whether it is
  // good enough to merge on. This function used to answer that itself with `state === "success"` and nothing else — a
  // SECOND, weaker copy of a policy {@link decideAutoMergeArm} already owns. A CAPPED verdict posts `success`, so the
  // copy here armed unproven work on every lane routing through it while the other copy refused it.
  const decision = decideAutoMergeArm(
    { state: prior.state, capped: prior.capped, planOnly: prior.planOnly, partiallyExecuted: prior.partiallyExecuted },
    false,
    override,
  );
  if (!prior.cappedFieldAbsent) return decision;
  // The fail-open default is legible in the decision's own reason — which every caller already
  // records — instead of a new ledger step a polling lane would re-emit every tick.
  return {
    ...decision,
    reason: `${decision.reason} [the ledgered verdict carried no 'capped' field (a line older than W1-T185); treated as NOT capped]`,
  };
}

/** Recover the most recent `automerge.capped_override_granted` line for `taskId`, last one wins — the
 * same scanning idiom its siblings use. Written by `rmd review <pr> --override-capped-by`, consulted by {@link
 * decideAutoMergeArm} before refusing a CAPPED verdict. HEAD-BOUND (W1-T219, recon R-14): the current verdict's head
 * must match the granted line's own `head_sha` exactly, or the line is skipped as if it were never there. Scoped to
 * `taskId` alone, anything able to append one line to an unauthenticated ledger armed auto-merge on a CAPPED verdict
 * for every later head of that task. A line
 * missing `head_sha` is likewise never matched: a binding that cannot be verified is absent. */
export function cappedOverrideFromLedger(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string,
  headSha: string,
): CappedOverride | undefined {
  let found: CappedOverride | undefined;
  for (const line of lines) {
    if (line.step !== "automerge.capped_override_granted" || line.task_id !== taskId) continue;
    if (typeof line.by !== "string" || typeof line.reason !== "string") continue;
    if (typeof line.head_sha !== "string" || line.head_sha !== headSha) continue;
    found = { by: line.by, reason: line.reason, headSha: line.head_sha };
  }
  return found;
}

/** AN OPERATOR MERGE HOLD (W1-T1000002) — the ledgered shape {@link CappedOverride} is with the sign flipped: that
 * is a human's permission to arm anyway, this a human's REFUSAL to let anything arm, "who" and "why" named the same.
 * DELIBERATELY NOT SHA-BOUND, unlike the override: a hold is a decision standing right now, and a routine `git push`
 * must never silently lift it. Cleared by nothing but an explicit `automerge.hold_released` row. */
export interface AutomergeHold {
  /** Who engaged the hold — never inferred, never anonymous, mirroring {@link CappedOverride.by}. */
  by: string;
  /** Why — mirroring {@link CappedOverride.reason}. */
  reason: string;
}

/** Recover the current auto-merge hold for `prNumber`, last one wins, over the WHOLE ledger rather than
 * a sha-bound window (see {@link AutomergeHold}). Written by an operator verb as
 * `automerge.hold_engaged`/`automerge.hold_released`, each carrying `by`/`reason`; a hold missing either is refused
 * at write time, because the row is the only notification anyone gets. PR-SCOPED OR FLEET-SCOPED: a row with no
 * `pr_number` is FLEET-WIDE, one with a number applies only to that PR, and both fold into the SAME chronological
 * scan. Consulted by sweep.ts's `alreadyDone` for `disposition: "mergeable"` — a held PR is refused, never armed,
 * never a dedup key — and by run-task.ts's
 * `attemptArm`, the ONE completion both arm paths reach, which closes the at-open race. */
export function automergeHoldFromLedger(
  lines: ReadonlyArray<Record<string, unknown>>,
  prNumber: number,
): AutomergeHold | undefined {
  let held: AutomergeHold | undefined;
  for (const line of lines) {
    const scopedToThisPr = typeof line.pr_number !== "number" || line.pr_number === prNumber;
    if (!scopedToThisPr) continue;
    if (line.step === "automerge.hold_engaged") {
      if (typeof line.by === "string" && typeof line.reason === "string" && line.by && line.reason) {
        held = { by: line.by, reason: line.reason };
      }
      continue;
    }
    if (line.step === "automerge.hold_released") {
      held = undefined;
    }
  }
  return held;
}

/** The LOUD console annotation for a keyword-only verdict (W1-T185), printed once per review when
 * {@link ReviewVerdict.keywordOnly} is true and the verdict was NOT already capped — a capped
 * verdict's own annotation already says nothing executed. Mirrors {@link floorDegradedAnnotation}. */
export function keywordOnlyAnnotation(): string {
  return (
    `KEYWORD-ONLY: no PR-head checkout was given, so no proof was executed for any ` +
    `criterion — this verdict rests entirely on keyword coverage (+ optional semantic ` +
    `downgrade), never on OBSERVED repo state.`
  );
}

/** The stable, COUNTABLE key naming WHICH structural path forced a `state: "failure"` (W1-T304): `no_criteria`,
 * `criteria_tampered`, `changeset_contradiction`, `instrument_entangled`, `holdout_unmet`, `test_theater`,
 * `unmet_criteria`. `undefined` on a passing verdict. Mirrors {@link failSummary}'s precedence exactly — both read
 * the SAME facts off the SAME verdict — so the class always matches the prose failSummary would render.
 * // Why: `review.posted` carried `state: "failure"` with `reasons: []` whenever the failing path was not an unmet
 * // named criterion, so a ledger grep for that class returned ZERO — measured on #1193. */
export function reviewFailureClass(
  verdict: Pick<ReviewVerdict, "criteriaTampered" | "changesetContradictions" | "instrumentEntangled"> & {
    criteria: ReadonlyArray<Pick<CriterionVerdict, "met" | "holdout">>;
  },
): "no_criteria" | "criteria_tampered" | "changeset_contradiction" | "instrument_entangled" | "holdout_unmet" | "test_theater" | "unmet_criteria" {
  if (verdict.criteria.length === 0) return "no_criteria";
  if (verdict.criteriaTampered) return "criteria_tampered";
  if ((verdict.changesetContradictions?.length ?? 0) > 0) return "changeset_contradiction";
  if (verdict.instrumentEntangled) return "instrument_entangled";
  const unmet = verdict.criteria.filter((c) => !c.met);
  const visibleUnmet = visibleCriteria(unmet);
  if (visibleUnmet.length > 0) return "unmet_criteria";
  // Neither structural fact above fired and no VISIBLE criterion is unmet, yet
  // `judgeReview` still folded this verdict to failure — the only two triggers
  // left in its OR-chain are a holdout-only miss or test theater.
  if (unmet.length > visibleUnmet.length) return "holdout_unmet";
  return "test_theater";
}

/** The facts the `review.posted` ledger line records about what was and was not observed (W1-T185 criterion 5: a
 * keyword-only verdict is EXPLICITLY marked in both the status and the ledger). Pure and exported so run-task.ts's
 * `log("review.posted", …)` call and a unit test read the SAME fields off the SAME verdict, never a hand-copied
 * projection. `plan_only` joined the line so the LEDGER carries every input {@link decideAutoMergeArm} needs, since
 * `capped` alone cannot distinguish the permanently-capped plan-only shape (which ARMS) from a proof-failure capped
 * verdict (which does not). W1-T304: `failure_class`/`failure_reason` ride alongside on any failing verdict, PURELY
 * for audit. W1-T305: `unexecutable_count`/`unexecutable_proofs`/`partially_executed` ride alongside unconditionally.
 * // Why: 418 of 821 code-review heads executed ZERO proofs and posted `success` on the keyword floor. */
export function reviewLedgerLegibilityFields(
  verdict: Pick<ReviewVerdict, "capped" | "keywordOnly" | "planOnly"> &
    Partial<
      Pick<
        ReviewVerdict,
        | "criteria"
        | "state"
        | "summary"
        | "criteriaTampered"
        | "changesetContradictions"
        | "instrumentEntangled"
        | "unexecutableCount"
        | "unexecutableProofs"
        | "partiallyExecuted"
        | "proofUniqueRuns"
        | "proofReuses"
      >
    >,
): {
  capped: boolean;
  keyword_only: boolean;
  plan_only: boolean;
  capped_reason?: string;
  unexecutable_count: number;
  unexecutable_proofs: string[];
  partially_executed: boolean;
  proof_unique_runs?: number;
  proof_reuses?: number;
  failure_class?: string;
  failure_reason?: string;
} {
  // `capped_reason` rides alongside `capped` rather than in its own line, so the ONE record that
  // says a verdict was capped also says why. Absent (never null/"") on an uncapped verdict, so the
  // existing ledger shape is byte-identical for every healthy review.
  const reason = verdict.capped && verdict.criteria ? cappedReason(verdict.criteria) : undefined;
  const failed = verdict.state === "failure" && verdict.criteria !== undefined && verdict.summary !== undefined;
  return {
    capped: verdict.capped,
    keyword_only: verdict.keywordOnly,
    plan_only: verdict.planOnly,
    ...(reason ? { capped_reason: reason } : {}),
    // W1-T305 (design (2)): the unexecutable class's COUNT and OFFENDING TEXT ride on the ledger
    // line UNCONDITIONALLY — 0/[] on a healthy review, never absent, so a consumer counting this
    // class across the fleet never has to special-case "the field wasn't there".
    unexecutable_count: verdict.unexecutableCount ?? 0,
    unexecutable_proofs: verdict.unexecutableProofs ?? [],
    // W1-T305 (design (4)): SOME-but-not-ALL executed, unconditional like `capped`/`keyword_only`.
    partially_executed: verdict.partiallyExecuted ?? false,
    // W1-T2743: two integers, and CONDITIONAL rather than defaulted to 0 — a review with no head
    // checkout measured nothing, and "measured none" is a different fact from "never measured".
    // Bounded by construction: counts only, never the commands or keys they were derived from.
    ...(verdict.proofUniqueRuns === undefined ? {} : { proof_unique_runs: verdict.proofUniqueRuns }),
    ...(verdict.proofReuses === undefined ? {} : { proof_reuses: verdict.proofReuses }),
    ...(failed
      ? {
          failure_class: reviewFailureClass({
            criteria: verdict.criteria!,
            criteriaTampered: verdict.criteriaTampered,
            changesetContradictions: verdict.changesetContradictions,
            instrumentEntangled: verdict.instrumentEntangled,
          }),
          failure_reason: verdict.summary!,
        }
      : {}),
  };
}

/** The `reasons` array the `review.posted` line carries (W1-T1016): one per VISIBLE unmet criterion,
 * plus a test-theater entry when {@link ReviewVerdict.testTheater} fires — the rule run-task.ts used to compute
 * inline, now pure and exported so a unit test reads the exact fields the ledger writes. THE ROUTING GAP THIS CLOSES:
 * the changeset-contradiction path fails the verdict WITHOUT unmet-ing any NAMED criterion, so the per-criterion rule
 * alone returns `[]`, and `actionableGateFailuresFromReasons` (lib/sweep.ts) only qualifies a row at
 * `reasons.length === 1` — so that shape could never route to the `blocked-fixable` row that exists for it and fell
 * to `blocked-ambiguous`. The fallback fires ONLY when nothing else claimed the array AND a contradiction is present,
 * since a genuine multi-cause failure must
 * stay unrouted. */
export function reviewLedgerReasons(
  verdict: Pick<ReviewVerdict, "testTheater" | "summary"> &
    Partial<Pick<ReviewVerdict, "changesetContradictions">> & {
      criteria: ReadonlyArray<Pick<CriterionVerdict, "met" | "holdout" | "reason">>;
    },
): string[] {
  const unmet = verdict.criteria.filter((c) => !c.met);
  const reasons = visibleCriteria(unmet).map((c) => c.reason);
  if (verdict.testTheater) reasons.push("test theater: added tests assert nothing");
  if (reasons.length === 0 && (verdict.changesetContradictions?.length ?? 0) > 0) {
    reasons.push(verdict.summary);
  }
  return reasons;
}

/** The arming-relevant facts of the verdict posted for ONE EXACT head — {@link decideAutoMergeArm}'s `verdict`
 * argument, recovered from the ledger by a caller that never held the verdict object. Same last-one-wins scan as its
 * siblings, HEAD-BOUND for the same W1-T219/W1-T230 reason. TWO DIFFERENT ABSENCES, TWO DIFFERENT ANSWERS, and they
 * are NOT symmetric. (a) NO RECOVERABLE VERDICT AT ALL → `undefined`, "no evidence", and the caller arms as it did
 * before this function existed, because a rotated ledger or a PR reviewed on another machine must never strand a PR
 * GitHub reports as success. (b) A VERDICT IS RECOVERABLE BUT `plan_only` IS ABSENT → `planOnly` reads FALSE, so a
 * `capped` verdict from that era REFUSES: "unknown, so arm" reopens the hole for every pre-existing capped line, and
 * an unattended merge with zero executed proof is irreversible while refusing only costs a PR sitting open. At the
 * time this landed zero open PRs carried a legacy capped line for their current head. */
export interface PostedArmFacts {
  capped: boolean;
  planOnly: boolean;
}

export function postedArmFactsFromLedger(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string | undefined,
  headSha: string | undefined,
): PostedArmFacts | undefined {
  if (!taskId || !headSha) return undefined;
  let facts: PostedArmFacts | undefined;
  for (const line of lines) {
    if (line.step !== "review.posted" || line.task_id !== taskId) continue;
    if (typeof line.head_sha !== "string" || line.head_sha !== headSha) continue;
    if (typeof line.capped !== "boolean") continue;
    // `plan_only` absent ⇒ false ⇒ a capped legacy verdict refuses. See (b) above.
    facts = { capped: line.capped, planOnly: line.plan_only === true };
  }
  return facts;
}

/** Max length of a GitHub commit-status description (postReviewStatus also truncates). */
const STATUS_DESC_MAX = 140;
const FAIL_PREFIX = "remudero-review: FAIL — ";

/** Build a failure summary that TEACHES: it NAMES the first unmet criterion rather than a bare count, truncating
 * with an ellipsis and `(+N more)` inside the status-description limit, with the full list in the `review.posted`
 * line and the PR review comment.
 * // Why: the W1-T2/#18 refusal said "1 criterion/criteria unmet" and cost a human round-trip.
 * PRECEDENCE, all structural and diff-derived, each preempting the ordinary unmet-criteria text and each NAMING its
 * specifics, because an unexplained red is the shape that gets overridden: `criteriaTampered` (Standing rule 15)
 * comes first, ahead of the empty-unmet test-theater fallback, since a diff can trip the rule-15 guard alone with
 * every named criterion still met; `changesetContradictions` names which claim was contradicted and which files
 * refute it; `instrumentEntanglement` (Standing rule 25) names the instrument and src paths AND STATES THE
 * RESOLUTION; `unprovenancedDecisionsEntries` names the unmarked header and the two accepted genres. `unmetClaims` is
 * caller-filtered to VISIBLE criteria only (W1-T166), and `hiddenUnmetCount` surfaces unmet HOLDOUT criteria as a
 * bare count, because this text is readable by the very worker a holdout criterion must stay hidden from. */
export function failSummary(
  unmetClaims: string[],
  testTheater: boolean,
  noCriteria: boolean,
  criteriaTampered = false,
  hiddenUnmetCount = 0,
  changesetContradictions: ChangesetClaimContradiction[] = [],
  instrumentEntanglement?: { instrumentPaths: string[]; srcPaths: string[] },
  unprovenancedDecisionsEntries: string[] = [],
): string {
  if (noCriteria) return `${FAIL_PREFIX}no acceptance criteria to judge (fail closed)`;
  if (criteriaTampered) {
    // ⚠ THIS STRING IS CAPPED AT 140 CHARS BY THE COMMIT-STATUS API, and the message it replaces was 145 — SLICED OFF
    // mid-word, which is why the refusal "named no remedy" and why appending one would have been invisible. This
    // branch says the ONE actionable thing that fits, the PR SHAPE to change; the full two-part remedy rides
    // `checkSatisfiedByGuard`'s uncapped advisory `reason`. MEASURED: 133 characters. Five suites pin `Standing rule
    // 15`.
    return `${FAIL_PREFIX}Standing rule 15: a criterion was added/edited beside non-plan files — file the shard in its own plan-only PR`;
  }
  if (changesetContradictions.length > 0) {
    const first = changesetContradictions[0];
    const more = changesetContradictions.length > 1 ? ` (+${changesetContradictions.length - 1} more)` : "";
    const filesBudget = 3;
    const filesText =
      first.files.slice(0, filesBudget).join(", ") +
      (first.files.length > filesBudget ? `, +${first.files.length - filesBudget} more` : "");
    return `${FAIL_PREFIX}body contradicts its own diff: claimed "${first.claim}", actual changed files: ${filesText}${more}`;
  }
  if (instrumentEntanglement) {
    return (
      `${FAIL_PREFIX}entangled: instrument path(s) ${instrumentEntanglement.instrumentPaths.join(", ")} changed ` +
      `alongside src/ path(s) ${instrumentEntanglement.srcPaths.join(", ")} in the same PR — split it: land the ` +
      `instrument change in its own PR, then rebase this one onto it (or revert the instrument hunk here)`
    );
  }
  if (unprovenancedDecisionsEntries.length > 0) {
    const first = unprovenancedDecisionsEntries[0];
    const more =
      unprovenancedDecisionsEntries.length > 1 ? ` (+${unprovenancedDecisionsEntries.length - 1} more)` : "";
    return (
      `${FAIL_PREFIX}DECISIONS.md entry added with no provenance mark: "${first}"${more} — needs ` +
      `"Chosen (RECOMMENDED, auto)" or an operator-attribution line (e.g. "Operator-authored")`
    );
  }
  if (unmetClaims.length === 0 && hiddenUnmetCount > 0) {
    return (
      `${FAIL_PREFIX}${hiddenUnmetCount} holdout criteri${hiddenUnmetCount === 1 ? "on" : "a"} unmet ` +
      `(reviewer-only — not disclosed to the worker)${testTheater ? "; test theater" : ""}`
    );
  }
  if (unmetClaims.length === 0) return `${FAIL_PREFIX}test theater: added tests assert nothing`;
  const more = unmetClaims.length > 1 ? ` (+${unmetClaims.length - 1} more)` : "";
  const theater = testTheater ? "; test theater" : "";
  const budget = Math.max(24, STATUS_DESC_MAX - (FAIL_PREFIX.length + "unmet: ".length + more.length + theater.length));
  const first = unmetClaims[0];
  const claim = first.length > budget ? `${first.slice(0, budget - 1).trimEnd()}…` : first;
  return `${FAIL_PREFIX}unmet: ${claim}${more}${theater}`;
}

// ── The fresh-context reviewer prompt (read-only + gh, never edits) ─────────

export interface ReviewPromptInput {
  task: { id: string; acceptance?: AcceptanceCriterion[] };
  prUrl: string;
  owner: string;
  repo: string;
  headSha: string;
}

/** Render the prompt for a FRESH-context REVIEW worker (acceptance #1/#3). The worker is read-only plus gh: it reads
 * the diff, the criteria and the implement REPORT, and verdicts each criterion against its proof. It does NOT post
 * the status — the deny-floor (W1-T203) refuses any status POST from a worker — so it emits `REVIEW_VERDICT` lines
 * and the ORCHESTRATOR posts the authoritative one. INVARIANT: the reviewer verifies against REPO STATE, not diff
 * plus report alone; when a proof names an executable check it receives an already-materialised disposable PR-head
 * checkout and RUNS it, verdicting on the OBSERVED result. Read-only in spirit: it never edits the PR's code and
 * never changes the head sha it judges. */
export function buildReviewPrompt(input: ReviewPromptInput): string {
  const criteria = (input.task.acceptance ?? [])
    .map((c, i) => `  ${i + 1}. CLAIM: ${c.claim}\n     PROOF: ${c.proof}`)
    .join("\n");

  return [
    `You are a REVIEW worker with FRESH context — you are NOT the implementer and`,
    `have none of their session. You are READ-ONLY: you may inspect the repo and`,
    `use \`gh\`, but you must NEVER edit, modify, or write any code or file. The PR`,
    `head sha must be unchanged by your review. Running the PR's tests or grepping`,
    `its source to verify a proof is allowed and expected — that is inspection, not`,
    `editing — as long as you never change the code or the head sha.`,
    ``,
    `TASK UNDER REVIEW: ${input.task.id}`,
    `PR: ${input.prUrl}`,
    ``,
    `Do this:`,
    `1. Read the PR diff:            gh pr diff ${input.prUrl}`,
    `2. Read the implement REPORT (the PR body / last worker message).`,
    `3. Your cwd is already a THROWAWAY Git checkout pinned to the PR head`,
    `   (${input.headSha}). Verify that exact value with: git rev-parse HEAD.`,
    `   Do not materialize another copy, contact a remote, switch revisions, or`,
    `   otherwise change the checkout. If the observed HEAD differs, verdict every criterion FAILURE`,
    `   and report the mismatch; never inspect a different revision.`,
    `4. For EACH acceptance criterion below, verdict its stated PROOF. When the`,
    `   proof names an EXECUTABLE check — a test (RUN it), a grep/command over the`,
    `   source — RUN that check against the checked-out PR head and verdict on the`,
    `   OBSERVED result (repo state), NOT merely on whether the REPORT pasted it. A`,
    `   proof that is missing, unpasted, or non-responsive = FAILURE; a proof whose`,
    `   test FAILS, or whose grep/command does not match on the PR head, = FAILURE.`,
    `   Test theater (assertions that assert nothing) = FAILURE.`,
    `5. When an implementation introduces a new input, field, option, or configuration`,
    `   value, trace each new input backwards through the production caller to the`,
    `   material producer that supplies its runtime value. Test fixtures that inject the`,
    `   value while no production producer supplies it = FAILURE. A production path that`,
    `   always takes a fallback instead of the claimed behavior = FAILURE. A grep proving`,
    `   that a call site names the new function is not proof that its runtime value can`,
    `   reach that function; verify the data path, not only symbol reachability.`,
    ``,
    `ACCEPTANCE CRITERIA:`,
    criteria || "  (none stated — treat as FAILURE: nothing to verify)",
    ``,
    `Do NOT post the \`${REVIEW_CONTEXT}\` commit status yourself — a worker`,
    `\`gh api -X POST .../statuses/...\` call is refused by the deny-floor`,
    `(W1-T203); it would simply fail. Instead, emit your per-criterion`,
    `REVIEW_VERDICT lines (below) and the ORCHESTRATOR will post the`,
    `authoritative status on sha ${input.headSha} after folding them in.`,
    ``,
    `End with a REPORT: the per-criterion verdicts and your reasoning for each.`,
  ].join("\n");
}

/** Machine-readable verdict contract appended to the reviewer's prompt so its per-criterion judgment
 *  folds into the deterministic verdict as a SEMANTIC downgrade, never an upgrade. The reviewer emits
 *  one `REVIEW_VERDICT <n>: PASS|FAIL` line per criterion. Advisory: the mechanical floor is the
 *  binding gate (Standing rules 2/4/12), so a reviewer that emits nothing parseable leaves the floor
 *  untouched — never a stall, never a deadlock. */
export function reviewerVerdictContract(count: number): string {
  return [
    ``,
    `MACHINE-READABLE OUTPUT (required — this is what the orchestrator posts`,
    `the status from, since you do not post it yourself): emit`,
    `EXACTLY one line per criterion, in this form and nothing else on the line:`,
    `  REVIEW_VERDICT <n>: PASS   (proof is responsive and substantiated)`,
    `  REVIEW_VERDICT <n>: FAIL   (proof missing, unpasted, or non-responsive)`,
    `for n = 1..${count}. These are folded into the deterministic verdict and may`,
    `only DOWNGRADE a criterion to failure, never rescue an unpasted proof.`,
  ].join("\n");
}

/** (W1-T2263) Widened off the original bare verdict-line pattern with a trailing capture group for whatever the
 *  reviewer wrote after the token, SAME LINE ONLY — the character class excludes `\r`/`\n`, so a clause can never
 *  span lines by construction. {@link parseReviewerVerdicts} still reads only groups 1 and 2, so its return is
 *  byte-identical; {@link parseReviewerVerdictClauses} reads group 3. One regex, two readers, so they cannot disagree. */
const REVIEW_VERDICT_LINE_RE = /REVIEW_VERDICT\s+(\d+)\s*:\s*(PASS|FAIL)\b([^\r\n]*)/gi;

/** Parse the reviewer's `REVIEW_VERDICT <n>: PASS|FAIL` lines into a semantic array index-aligned to
 *  the criteria. `FAIL` ⇒ `false`, forcing that criterion to fail; `PASS` or absent ⇒ `undefined`,
 *  deferring to the mechanical floor. Advisory and downgrade-only, so unparseable output yields an
 *  all-`undefined` array and the floor stands alone, fail-closed. */
export function parseReviewerVerdicts(text: string, count: number): (boolean | undefined)[] {
  const semantic: (boolean | undefined)[] = new Array(count).fill(undefined);
  for (const m of text.matchAll(REVIEW_VERDICT_LINE_RE)) {
    const n = Number(m[1]) - 1;
    if (n < 0 || n >= count) continue;
    // Only ever record a downgrade; a PASS leaves the floor to decide.
    if (m[2].toUpperCase() === "FAIL") semantic[n] = false;
  }
  return semantic;
}

/** Longest clause {@link parseReviewerVerdictClauses} carries into a criterion's reason — long
 *  enough to name a remedy, short enough that an overlong or runaway line can't reach the
 *  ledger whole (W1-T2263 acceptance: "bounded ... rather than carried whole"). */
const REVIEWER_CLAUSE_MAX_CHARS = 160;

/** Pull the bounded clause off a FAIL line's trailing text, already confined to one line by
 *  {@link REVIEW_VERDICT_LINE_RE}. {@link reviewerVerdictContract}'s own example shows a
 *  parenthetical after the token — `FAIL   (proof missing, unpasted, or non-responsive)` — so a
 *  leading `(...)` is unwrapped when present and freeform trailing prose is accepted as-is.
 *  `undefined` for whitespace-only text: a plain `FAIL` with nothing after it. */
function extractBoundedClause(trailing: string): string | undefined {
  const s = trailing.trim();
  if (!s) return undefined;
  const paren = s.match(/^\(([^)]*)\)/);
  const inner = (paren ? paren[1] : s).trim();
  if (!inner) return undefined;
  return inner.length > REVIEWER_CLAUSE_MAX_CHARS ? `${inner.slice(0, REVIEWER_CLAUSE_MAX_CHARS).trimEnd()}…` : inner;
}

/** (W1-T2263) Companion to {@link parseReviewerVerdicts}, reading the SAME transcript through the SAME regex for the
 *  bounded clause a FAIL line may carry — no second question, no second spawn. Index-aligned to `count` like its
 *  sibling. `undefined` at an index whose line was PASS, absent, or a FAIL with no clause: a PASS line is never
 *  annotated. Two independent readers of one regex pass. */
export function parseReviewerVerdictClauses(text: string, count: number): (string | undefined)[] {
  const clauses: (string | undefined)[] = new Array(count).fill(undefined);
  for (const m of text.matchAll(REVIEW_VERDICT_LINE_RE)) {
    const n = Number(m[1]) - 1;
    if (n < 0 || n >= count) continue;
    if (m[2].toUpperCase() !== "FAIL") continue; // PASS lines never gain a clause.
    const clause = extractBoundedClause(m[3]);
    if (clause) clauses[n] = clause;
  }
  return clauses;
}

// ── Acceptance criteria from a PR body (manual plan/doc PRs) ───────────────

/** Strip a single layer of matching `"..."` or `'...'` quotes, if present. */
function stripQuotes(s: string): string {
  const m = s.match(/^(["'])([\s\S]*)\1$/);
  return m ? m[2] : s;
}

/** Parse an `Acceptance:` block out of a PR body, for manual plan or doc PRs carrying no task id. TWO bullet shapes
 * parse, both index-aligned one per criterion: single-line `- <claim> | <proof>`, where {@link acceptanceSeparator}
 * decides which `|` separates them and no `|` keeps the whole line as the claim with an empty proof; and multi-line
 * `- claim: "<claim>"` followed by an INDENTED, non-bullet `proof: "<proof>"` continuation, which attaches to that
 * criterion rather than ending the block, so a body with N such pairs yields N criteria and not just the first (the
 * house format, #277/#280). Parsing stops at the first line, after the bullets begin, that is neither a new bullet
 * nor a recognised continuation. FAILS CLOSED: `[]` when there is no block, and empty criteria never pass. */
/** The Acceptance HEADER line. Extracted as a shared constant so {@link parseAcceptanceBlock} and {@link
 *  acceptanceBlockDiagnostics} can never disagree about where a block begins. */
const ACCEPTANCE_HEADER_RE = /^\s*#{0,6}\s*\**\s*acceptance(\s+criteria)?\b\s*\**\s*:?\s*\**\s*$/i;

/** A criterion BULLET. Shared with {@link acceptanceBlockDiagnostics} for the same reason as
 *  {@link ACCEPTANCE_HEADER_RE}. Unchanged from the parser's previous inline literal. */
const ACCEPTANCE_BULLET_RE = /^\s*(?:[-*]|\d+[.)])\s+(.*\S)\s*$/;

/** Where a single-line bullet's claim ends and its proof begins — index plus separator width, or null
 * when the bullet carries no `|`. THE SEPARATOR IS THE ONE THAT YIELDS AN EXECUTABLE PROOF. NOT SIMPLY THE LAST ` |
 * `, which repairs a pipe in the CLAIM and breaks one in the PROOF, since a `grep:` pattern is one argv element and
 * may hold a ` | ` of its own: both readings guess at which pipe an author meant, and the dialect prefix is the one
 * piece of evidence that is not a guess. So the historical first-bare-`|` split is tried FIRST and kept whenever it
 * already yields a dialect proof, then each ` | ` right-to-left, and only if NO split yields an executable proof does
 * it fall back as before.
 * // Why: splitting at the FIRST bare `|` truncated any claim carrying a pipe of its own, so the
 * // criterion fell SILENTLY to the keyword floor; `plan/tasks.d/W1-T2781-*.yaml` carries such a claim. */
function acceptanceSeparator(item: string): { index: number; width: number } | null {
  const bare = item.indexOf("|");
  if (bare < 0) return null;
  const spaced: { index: number; width: number }[] = [];
  for (let i = item.indexOf(" | "); i >= 0; i = item.indexOf(" | ", i + 1)) spaced.push({ index: i, width: 3 });
  const yieldsExecutableProof = (sep: { index: number; width: number }): boolean => {
    const rhs = item.slice(sep.index + sep.width).trim();
    return rhs.length > 0 && (matchesDialectPrefix(rhs) || matchesDialectPrefix(stripCodeSpan(rhs)));
  };
  const legacy = { index: bare, width: 1 };
  if (yieldsExecutableProof(legacy)) return legacy;
  for (let k = spaced.length - 1; k >= 0; k--) {
    if (yieldsExecutableProof(spaced[k])) return spaced[k];
  }
  return spaced.length ? spaced[spaced.length - 1] : legacy;
}

export function parseAcceptanceBlock(body: string): AcceptanceCriterion[] {
  const lines = (body ?? "").split("\n");
  const criteria: AcceptanceCriterion[] = [];
  /** Index-aligned with `criteria`: for a `claim:`-labelled bullet nonetheless split at a
   *  separator, the claim text as written BEFORE that split. An indented `proof:` continuation
   *  below such a bullet proves the split was a false positive — the proof lives on that line, so
   *  the pipe belonged to the claim — and restores this. Undefined for every other bullet. */
  const unsplitLabelledClaims: (string | undefined)[] = [];
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    // Header: "Acceptance:", "**Acceptance:**", "## Acceptance", "Acceptance criteria:".
    if (!inBlock) {
      if (ACCEPTANCE_HEADER_RE.test(line)) {
        inBlock = true;
      }
      continue;
    }
    const bullet = line.match(ACCEPTANCE_BULLET_RE);
    if (bullet) {
      const item = bullet[1].trim();
      const sep = acceptanceSeparator(item);
      let claim = (sep ? item.slice(0, sep.index) : item).trim();
      const proof = sep ? item.slice(sep.index + sep.width).trim() : "";
      // "- claim: <text>" form: strip the label and any surrounding quotes.
      const claimLabel = claim.match(/^claim\s*:\s*(.*)$/i);
      if (claimLabel) claim = stripQuotes(claimLabel[1].trim());
      if (!claim) continue;
      criteria.push({ claim, proof });
      const whole = claimLabel && proof ? item.match(/^claim\s*:\s*(.*)$/i) : null;
      unsplitLabelledClaims[criteria.length - 1] = whole ? stripQuotes(whole[1].trim()) : undefined;
      continue;
    }
    // An indented, non-bullet "proof:" line right under a "- claim: ..." bullet is a
    // CONTINUATION of that criterion, not a terminator — attach it and keep scanning
    // for further bullets instead of dropping every criterion after the first.
    if (criteria.length > 0 && /^\s+\S/.test(line)) {
      const proofLabel = line.trim().match(/^proof\s*:\s*(.*)$/i);
      const last = criteria[criteria.length - 1];
      if (proofLabel && !last.proof) {
        last.proof = stripQuotes(proofLabel[1].trim());
        continue;
      }
      // The bullet above was a `claim:` label carrying a separator of its own and THIS line is the proof, so that
      // split was a false positive: restore the claim as written and take the proof from here. Consumed ONCE — a
      // SECOND `proof:` line under the same bullet is still unrecognised and still ends the block, exactly as before.
      const unsplit = proofLabel ? unsplitLabelledClaims[criteria.length - 1] : undefined;
      if (proofLabel && unsplit !== undefined) {
        last.claim = unsplit;
        last.proof = stripQuotes(proofLabel[1].trim());
        unsplitLabelledClaims[criteria.length - 1] = undefined;
        continue;
      }
    }
    // A blank line before any bullet is tolerated (header, then a gap, then bullets);
    // once bullets have begun, any blank or unrecognized line ends the block.
    if (line.trim() === "" && criteria.length === 0) continue;
    break;
  }
  return criteria;
}

/** {@link acceptanceBlockDiagnostics}'s report. */
export interface AcceptanceBlockDiagnostics {
  /** Was an Acceptance HEADER found at all? False ⇒ the parser resolves nothing and review fails closed. */
  headerFound: boolean;
  /** Criterion BULLETS the author wrote under that header, counted with the parser's own bullet regex. */
  bulletsWritten: number;
  /** Criteria {@link parseAcceptanceBlock} actually resolved. */
  criteriaParsed: number;
  /** Parsed criteria whose proof is empty — a claim with nothing to execute. */
  emptyProofs: number;
  /** The 1-based index of the first bullet the parser did NOT reach, when it stopped early. */
  truncatedAtBullet?: number;
  /** true ⇒ the body does not say what the author wrote: absent header, dropped bullets, or an empty proof. */
  defective: boolean;
}

/** Compare what an author WROTE in an Acceptance block against what {@link parseAcceptanceBlock} resolves, and
 * report the difference. TRAP: the parser treats any indented line that is not `proof:` as the END of the block, so a
 * claim WRAPPED onto a second line silently truncates, and the review judges a PR against a criterion the author
 * never meant to stand alone. Reproduced: written 3, parsed 1, emptyProofs 1, against a no-wrap control of written 3,
 * parsed 3, emptyProofs 0 — the same overloaded-zero shape as the `grep:` traps this repo has paid for twice, where
 * LINE-ORIENTED PARSERS MEET WRAPPED TEXT and fail by returning FEWER things than raising. DELIBERATELY DOES NOT
 * CHANGE `parseAcceptanceBlock`, since making the parser reject would fail bodies that merge today. `bulletsWritten`
 * counts with the parser's OWN {@link ACCEPTANCE_BULLET_RE} and stops at the first line that is neither a bullet, a
 * continuation, nor a tolerated leading blank, so a `## Validation` section is not miscounted. */
export function acceptanceBlockDiagnostics(body: string): AcceptanceBlockDiagnostics {
  const parsed = parseAcceptanceBlock(body);
  const lines = (body ?? "").split("\n");
  let inBlock = false;
  let bulletsWritten = 0;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (!inBlock) {
      if (ACCEPTANCE_HEADER_RE.test(line)) inBlock = true;
      continue;
    }
    if (ACCEPTANCE_BULLET_RE.test(line)) {
      bulletsWritten++;
      continue;
    }
    // An indented continuation (wrapped claim OR a `proof:` line) belongs to the current bullet.
    if (bulletsWritten > 0 && /^\s+\S/.test(line)) continue;
    if (line.trim() === "" && bulletsWritten === 0) continue;
    break;
  }
  const emptyProofs = parsed.filter((c) => !c.proof).length;
  const headerFound = inBlock;
  return {
    headerFound,
    bulletsWritten,
    criteriaParsed: parsed.length,
    emptyProofs,
    truncatedAtBullet: parsed.length < bulletsWritten ? parsed.length + 1 : undefined,
    defective: !headerFound || parsed.length !== bulletsWritten || emptyProofs > 0,
  };
}

// ── AUTHOR-TIME acceptance check (W1-T952) ──────────────────────────────────

/** THE SINGLE ANSWER to "which id does this body name" — anchored, LAST-WINS (W1-T2624). Last-wins is W1-T70's
 *  ratified reading of the worker prompt's own contract, and what `ensureTaskTrailer` (run-task.ts) produces by
 *  construction, appending its stamp at the END of the body. Before this, two callers here each ran their own
 *  anchored-but-first-wins match, disagreeing with run-task.ts's last-wins `reviewTaskIdFromBody` on any body
 *  carrying two anchored trailers. review.ts is the leaf and run-task.ts imports FROM it, so this lives here and
 *  `reviewTaskIdFromBody` becomes a thin re-export rather than a second drifting regex. */
export function extractTaskTrailerId(body: string): string | undefined {
  const matches = [...(body ?? "").matchAll(/^Remudero-Task:\s*(\S+)\s*$/gm)];
  return matches.length ? matches[matches.length - 1][1] : undefined;
}

/** The four defects {@link acceptanceAuthorTimeCheck} names — design item (iii), W1-T952:
 *  "the diagnostic must say WHICH of the four it is", never a generic refusal. */
export type AcceptanceAuthorTimeDefect = "no-header" | "no-trailer" | "unparseable" | "empty-proofs";

/** {@link acceptanceAuthorTimeCheck}'s verdict. */
export interface AcceptanceAuthorTimeResult {
  /** false ⇒ `remudero-review` will fail CLOSED on this body ("no acceptance criteria to judge"). */
  ok: boolean;
  /** Which of the four, only when `!ok`. */
  defect?: AcceptanceAuthorTimeDefect;
  /** Human-readable — names the defect, not just that one exists (rationale (5)). */
  message: string;
}

/** THE AUTHOR-TIME ENTRY POINT (W1-T952 design item ii) onto {@link acceptanceBlockDiagnostics} — the same
 * diagnostic `rmd check-acceptance` prints, callable BEFORE a PR pays for a CI cycle and review's generic
 * "no acceptance criteria to judge (fail closed)" to discover the same thing. See {@link PR_AUTHORING_PATHS} for
 * which authoring paths it can actually run on. TWO CALL SHAPES, matching how `reviewCommand` resolves criteria. With
 * `expectedTaskId` GIVEN, the `Remudero-Task:` trailer is checked FIRST and independently of the body's block: a
 * healthy block with the WRONG trailer is still a defect, because `findMergedByTrailer` credits merge-done off that
 * trailer, so a silent mismatch is permanent non-credit and gets its own `no-trailer` category. OMITTED, ANY
 * resolvable trailer is accepted at face value. Priority: no-header, no-trailer, unparseable, empty-proofs. */
export function acceptanceAuthorTimeCheck(
  body: string,
  opts: { expectedTaskId?: string; trailerResolves?: (taskId: string) => boolean } = {},
): AcceptanceAuthorTimeResult {
  const text = body ?? "";
  const trailerId = extractTaskTrailerId(text);

  if (opts.expectedTaskId !== undefined) {
    if (trailerId === opts.expectedTaskId) {
      return { ok: true, message: `Remudero-Task: ${opts.expectedTaskId} trailer present — credits this task on merge` };
    }
    return {
      ok: false,
      defect: "no-trailer",
      message:
        `no "Remudero-Task: ${opts.expectedTaskId}" trailer line (` +
        (trailerId !== undefined ? `found "Remudero-Task: ${trailerId}" instead` : "none found") +
        `) — findMergedByTrailer will never credit ${opts.expectedTaskId} on merge, even if review itself ` +
        "passes off a body-level Acceptance block.",
    };
  }

  // THE EXEMPTION MUST BE TRUE, NOT MERELY CLAIMED (W1-T2297). This arm's whole warrant is that criteria come from
  // the plan record rather than the body, and that fails when the trailer names nothing the plan declares: the
  // reviewer falls back to the body, and a body this gate never looked at ships with whatever its block parses to.
  // `trailerResolves` OMITTED is today's behaviour byte for byte, so only a caller that CAN resolve gets the stricter
  // reading; falling through re-uses the diagnostics arms below rather than adding a second spelling of "this block
  // is unreadable".
  // // Why: on #2908 a trailer resolved to ZERO ids and the body's block gave `bullets written: 5, criteria parsed: 1` — four criteria unseen.
  if (trailerId !== undefined && (opts.trailerResolves === undefined || opts.trailerResolves(trailerId))) {
    return { ok: true, message: `Remudero-Task: ${trailerId} trailer present — criteria resolve from plan/tasks.yaml` };
  }

  const d = acceptanceBlockDiagnostics(text);
  if (!d.headerFound) {
    return {
      ok: false,
      defect: "no-header",
      message:
        "no `## Acceptance` header and no `Remudero-Task:` trailer — review has nothing to resolve criteria " +
        "from and fails CLOSED. Add a bare `## Acceptance` (or `Acceptance:`) header followed by bullets, or " +
        "a `Remudero-Task: <id>` trailer line.",
    };
  }
  if (d.truncatedAtBullet !== undefined) {
    return {
      ok: false,
      defect: "unparseable",
      message:
        `${d.bulletsWritten} bullet(s) written but only ${d.criteriaParsed} parsed — the block ends before ` +
        `bullet ${d.truncatedAtBullet}. A claim WRAPPED onto a second line truncates everything after it; ` +
        "keep each claim on ONE line.",
    };
  }
  if (d.emptyProofs > 0 || d.criteriaParsed === 0) {
    return {
      ok: false,
      defect: "empty-proofs",
      message: `${d.emptyProofs || d.bulletsWritten} criterion/criteria have no proof — a claim with nothing to execute.`,
    };
  }

  // REPORTED, NEVER REFUSED (W1-T2544). Both signals below are ADVISORY, because this gate is pure and
  // `acceptance-author-gate` is a REQUIRED check: a false refusal blocks a correct PR. A wholly-wrapped `grep:`
  // pattern is usually wrong — every one measured across two retro cycles read 0 — but CAN be correct, and only
  // reading the target file separates them (W1-T1060/#3191 settled the boundary). THE VALUE IS THE EARLY WARNING.
  const criteria = parseAcceptanceBlock(text);
  const wrapped = criteria
    .map((c, i) => ({ i: i + 1, w: wrappedGrepPattern(c.proof ?? "") }))
    .filter((r) => r.w !== undefined);
  const inert = criteria.filter((c) => parseWhitelistedProof(c.proof ?? "") === null).length;
  const notes: string[] = [];
  if (wrapped.length > 0) {
    const f = wrapped[0];
    notes.push(
      `${wrapped.length} grep proof(s) wrap their pattern in ${f.w!.delimiter} — the executor greps ` +
        `with no -F, so unless the file really contains those delimiters the pattern reads 0. If it ` +
        `does not, criterion ${f.i} should read: grep: ${f.w!.bare} in <path>`,
    );
  }
  if (inert > 0) {
    notes.push(
      `${inert} of ${criteria.length} proof(s) cannot execute (no runnable dialect), so the verdict ` +
        `caps at proof_exec ${criteria.length - inert}/${criteria.length} and cannot arm auto-merge ` +
        "without an operator override",
    );
  }
  if (notes.length > 0) return { ok: true, message: `Acceptance block is judgeable — but ${notes.join("; ")}.` };
  return { ok: true, message: "Acceptance block is judgeable" };
}

// ── CRITERIA RESOLUTION AT THE PR's OWN HEAD (W1-T2432) ─────────────────────
// THE DEFECT: run-task.ts's `resolvePlanCriteriaForReview` resolves a trailered PR's criteria from the CONTAINER's
// checked-out working tree, i.e. whatever sha the daemon last booted onto. The daemon restarts on freshness
// continuously, so a `plan/tasks.d/` shard merging between two boots is invisible to that read even though it is
// reachable from the very PR head being judged — and review then posts
// "no acceptance criteria to judge (fail closed)" on evidence that was never absent, only unread (measured on #3168).

/** A DIVERGENCE between the trailer this body carries and the plan {@link loadPlanAtRef} could load
 *  AT THE PR's HEAD — the head-resolved sibling of run-task.ts's own `ResolverDivergence`. Set ONLY
 *  when `loadPlanAtRef` itself throws, never merely because `taskId` is absent from a plan that
 *  loaded fine, the same distinction `resolvePlanCriteriaForReview` draws. */
/** WHICH cause made a head sha unreadable, decided by one probe rather than inferred from git's
 *  message, which cannot tell them apart (W1-T2511). `git show <sha>:<path>` emits the same "exists on
 *  disk, but not in '<sha>'" for an object never fetched and for a commit present but genuinely lacking
 *  the path — MEASURED byte-identical. `git cat-file -e <sha>^{commit}` asks exactly that; a probe that
 *  cannot run yields `"undetermined"`, never a guess, because a wrong cause sends the next reader at the
 *  wrong defect entirely. */
export function classifyHeadShaAvailability(
  repoRoot: string,
  headSha: string,
  runGit?: (args: string[]) => string,
): "absent-object" | "readable-object" | "undetermined" {
  const git =
    runGit ??
    ((args: string[]) => execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: "pipe" }));
  try {
    git(["cat-file", "-e", `${headSha}^{commit}`]);
    return "readable-object";
  } catch (e) {
    // DISTINGUISH THE PROBE FAILING FROM THE PROBE ANSWERING "no". `cat-file -e` exits non-zero to MEAN "absent",
    // which is an answer; anything preventing it running at all is not. The discriminator is whether the error
    // carries a numeric exit status, which a real non-zero exit does and a spawn failure does not.
    const status = (e as { status?: unknown } | null)?.status;
    return typeof status === "number" ? "absent-object" : "undetermined";
  }
}

export interface PlanCriteriaAtHeadDivergence {
  taskId: string;
  reason: string;
  /** WHICH cause produced `reason`, because git's own message cannot say (W1-T2511) — byte-identical whether the
   *  object is absent from local storage or present with the path genuinely missing from its tree. `absent-object`
   *  is the W1-T2511 ordering defect, resolved once the hoisted fetch runs; `readable-object` is a different problem;
   *  `undetermined` when the probe itself could not run — never guessed. */
  cause?: "absent-object" | "readable-object" | "undetermined";
}

/** {@link resolvePlanCriteriaAtHead}'s result — the same shape as run-task.ts's `resolvePlanCriteriaForReview` for
 *  four of its five declared fields, so swapping one call for the other is like-for-like. The fifth, `openTaskIds`,
 *  is NOT produced here: W1-T2623 locks that omission as behaviourally identical to the replaced resolver's own
 *  empty-set value at its one consumer. See test/resolver-swap-field-parity.test.ts for the guard over ALL five. */
export interface PlanCriteriaAtHeadResult {
  criteria: AcceptanceCriterion[];
  /** The `Remudero-Task:` trailer's id, when the body carried one. `undefined` when it did not
   *  (claim 4: an untrailered body is unchanged — this function never touches git for it). */
  taskId?: string;
  taskDeclaredFiles?: string[];
  /** Routing/spend metadata from the same task record at the same head as {@link criteria}. */
  taskRisk?: TaskRisk;
  taskBudgetUsd?: number;
  source?: string;
  divergence?: PlanCriteriaAtHeadDivergence;
}

/** THE FIX (W1-T2432, remedy (a)). Resolve a trailered PR body's judging criteria from the plan AS IT STANDS AT THE
 * PR's OWN HEAD SHA, via {@link loadPlanAtRef}, instead of the container's checked-out working tree. No second
 * network fetch: `runGit` shells out to LOCAL git objects. NAMED COST: this reads the sha's COMMITTED objects, so a
 * shard merging after `headSha` is still invisible — a strictly smaller window than the boot-to-boot one, never zero.
 * The trailer comes from {@link extractTaskTrailerId}, the SAME anchored, last-wins extractor its siblings use. NEVER
 * WIRED HERE, on purpose: one concern per PR. SYNCHRONOUS, and each blob is read exactly once. */
/** W1-T2623: the OBJECT IDENTITY of the plan bytes THIS resolve actually read — restoring, on the at-head path, the
 * read-identity assertion {@link "./task-linter.js".formatReadIdentity} already prints for the working-tree path,
 * without which `criteria from …` named a task id and a count but never WHICH plan bytes were gated. At a fixed sha
 * the plan is content-addressed, so identity is the git OID from one LOCAL `git rev-parse <sha>:<path>`; the shard
 * set is ONE tree oid rather than a blob oid per shard. NEVER THROWS — a probe failure degrades to `undefined`. */
function formatPlanReadIdentityAtHead(
  runGit: (args: string[]) => string,
  headSha: string,
  planRelPath: string,
): string | undefined {
  let blobOid: string;
  try {
    blobOid = runGit(["rev-parse", `${headSha}:${planRelPath}`]).trim();
  } catch {
    // Identity is optional legibility: the criteria bytes already resolved, so preserve the
    // pre-W1-T2623 source string instead of turning a failed local OID probe into review failure.
    return undefined;
  }
  const shardRelDir = join(dirname(planRelPath), "tasks.d");
  let shardSuffix = "";
  try {
    const treeOid = runGit(["rev-parse", `${headSha}:${shardRelDir}`]).trim();
    shardSuffix = ` + ${shardRelDir}/@${treeOid.slice(0, 12)}`;
  } catch {
    // No tasks.d/ at this ref — the same tolerance loadPlanAtRef itself applies to the shard dir.
  }
  return `${planRelPath}@${blobOid.slice(0, 12)}${shardSuffix}`;
}

export function resolvePlanCriteriaAtHead(
  body: string,
  repoRoot: string,
  planRelPath: string,
  headSha: string,
  // `stdin` is OPTIONAL and forwarded straight to `loadPlanAtRef`: the shard read is one
  // `git cat-file --batch`, which takes its object list there. An existing `(args) => string`
  // fake stays assignable, but one that means to serve the shard read must now honour stdin.
  runGit?: (args: string[], stdin?: string) => string,
): PlanCriteriaAtHeadResult {
  const taskId = extractTaskTrailerId(body ?? "");
  // CLAIM 4: no anchored trailer ⇒ unchanged — nothing to resolve, and no git object is ever
  // touched to find that out. The caller's existing PR-body `## Acceptance` fallback (unchanged
  // by this function) is what recovers criteria here, exactly as it does today.
  if (taskId === undefined) return { criteria: [] };

  // Mirrors loadPlanAtRef's OWN default (plan.ts) exactly, including its `maxBuffer` — never a
  // second, differently-configured git runner for the read-identity probes below.
  const gitRunner =
    runGit ??
    ((args: string[], stdin?: string) =>
      execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", maxBuffer: 1 << 26, input: stdin }));

  try {
    const plan = runGit === undefined ? loadPlanAtRef(repoRoot, planRelPath, headSha) : loadPlanAtRef(repoRoot, planRelPath, headSha, runGit);
    const t = plan.byId.get(taskId);
    // CLAIM 3: a task that resolves but declares no (or empty) acceptance — or a trailer whose
    // id resolves nowhere in the plan at this head — both read as `criteria: []`, same fail-closed
    // shape `judgeReview` already refuses to pass (claim 3 is proven at that composition, not here).
    const criteria = t?.acceptance?.length ? t.acceptance : [];
    // W1-T2623: the read-identity probes only run when there is a `source` line to append them
    // to — no extra git calls spent naming bytes nobody is about to be told were read.
    const identity = criteria.length ? formatPlanReadIdentityAtHead(gitRunner, headSha, planRelPath) : undefined;
    return {
      criteria,
      taskId,
      taskDeclaredFiles: t?.files,
      taskRisk: t?.risk,
      taskBudgetUsd: t?.budget_usd,
      source: criteria.length
        ? `plan at ${headSha} task ${taskId} (${criteria.length} criteria)` + (identity ? ` — read: ${identity}` : "")
        : undefined,
    };
  } catch (e) {
    // A duplicate id or an unreadable git object at headSha — named, never swallowed into a silent empty plan
    // (mirrors resolvePlanCriteriaForReview's own divergence shape). W1-T2511: the reason ALONE cannot say which it
    // was, because git will not, so one extra `cat-file -e` separates the two causes that matter and the next reader
    // need not re-run probes.
    return {
      criteria: [],
      taskId,
      divergence: {
        taskId,
        reason: String((e as Error)?.message ?? e),
        cause: classifyHeadShaAvailability(repoRoot, headSha, runGit),
      },
    };
  }
}

/** One PR-authoring path's coverage — design item (i), W1-T952: "write down which the fix COVERS
 *  and which it CANNOT... A fix that silently covers only the in-repo path and claims the defect
 *  closed is the failure this item exists to prevent." */
export interface PrAuthoringPathCoverage {
  /** Stable, short identifier — the function/flow this row is about. */
  path: string;
  /** Can an in-repo, author-time check technically run on this path's PR body before CI/review? */
  reachable: boolean;
  /** Does THIS change (W1-T952) actually call {@link acceptanceAuthorTimeCheck} on this path? */
  wiredByThisChange: boolean;
  /** Why, cited against source — never asserted. */
  reason: string;
}

/** EVERY PATH BY WHICH A PR BODY IS AUTHORED IN THIS REPO, read from source (W1-T952 design item i), with coverage
 * stated for each rather than assumed. `reachable: false` rows are the load-bearing ones: an in-repo check cannot
 * reach a PR opened by a human over REST, by `gh pr create`, or by an MCP client, because none of those execute repo
 * code, and no future change closes that gap without a SERVER-SIDE check. `reachable: true, wiredByThisChange: false`
 * rows are DELIBERATE: `openPlanPr` and the retro sync PR are judgeable by construction, and `runTask`'s
 * implement-dispatch path resolves criteria from `plan/tasks.yaml` via the trailer `ensureTaskTrailer` stamps. */
export const PR_AUTHORING_PATHS: readonly PrAuthoringPathCoverage[] = [
  {
    path: "openPlanPr (src/run-task.ts) — rmd approve's plan-ratification PR",
    reachable: true,
    wiredByThisChange: false,
    reason:
      "body is assembled by buildPlanPrBody/renderAcceptanceBlock (lib/plan-pr-emitter.ts), " +
      "GUARANTEED to round-trip through parseAcceptanceBlock by construction (renderAcceptanceBlock " +
      "throws on an empty criteria list rather than ever emitting an unjudgeable block) — a dynamic " +
      "check here could only ever pass, so wiring one adds cost without added coverage.",
  },
  {
    path: "rmd retro's plan-only sync PR (repairRetroAcceptanceBlock, src/run-task.ts)",
    reachable: true,
    wiredByThisChange: false,
    reason:
      "ALREADY WIRED, pre-existing (not this change): fetches the just-opened PR body and repairs it " +
      "via ensureJudgeableBody, using the same bodyNeedsAcceptanceRepair predicate this task's check " +
      "composes with — ensureJudgeableBody REPAIRS (appends a fallback claim); this task's diagnostic " +
      "instead NAMES the defect without rewriting the author's text, a deliberate difference (see the " +
      "alert-fix row below).",
  },
  {
    path: "rmd alert-fix's ephemeral single-alert fix PR (dispatchAlertFixRun, src/run-task.ts)",
    reachable: true,
    wiredByThisChange: true,
    reason:
      "THIS CHANGE'S DELIVERABLE. alertTaskId (alertFixPrompt) mints a synthetic id that NEVER " +
      "resolves in plan/tasks.yaml, so the worker-authored body is the ONLY source review can judge " +
      "from — nothing checked it before review paid for a CI cycle to find out. Wired right after " +
      "ensureTaskTrailer (the one point this lane already reads the PR back), calling " +
      "acceptanceAuthorTimeCheck and NAMING the defect rather than silently repairing it: this is a " +
      "fully-automated, unattended lane with no human reading the body before merge, so fabricating a " +
      "fallback claim (retro's approach) would misrepresent the fix rather than merely fail to praise it.",
  },
  {
    path: "runTask's implement-task dispatch (src/run-task.ts) — the standard `rmd run`/drain path",
    reachable: true,
    wiredByThisChange: false,
    reason:
      "reachable (the orchestrator reads the worker-opened PR back via ensureTaskTrailer/ " +
      "checkPrOwnership before CI-wait/review), but NOT wired here: ensureTaskTrailer unconditionally " +
      "stamps a Remudero-Task trailer for a REAL, plan-filed task id, and reviewCommand's own plan " +
      "lookup (loadPlan already merges plan/tasks.d/ shards) resolves criteria from there regardless " +
      "of body shape — so a defective body is usually harmless on this path, and the residual risk " +
      "(the filed task's own plan record missing or empty acceptance:) is a plan-authoring defect, " +
      "not a PR-authoring one. Left as a follow-up rather than widening this diff into run-task.ts's " +
      "largest, most-depended-on function for a case this task's own filing does not reproduce.",
  },
  {
    path: "a human or agent running `gh pr create` (or the REST endpoint) directly, outside any rmd command",
    reachable: false,
    wiredByThisChange: false,
    reason: "executes no repo code before the PR exists — an in-repo check cannot run before a call that never entered this repo's process.",
  },
  {
    path: "an MCP client opening a PR directly against the GitHub API",
    reachable: false,
    wiredByThisChange: false,
    reason: "same as the hand-gh-cli row: a third-party client speaking the GitHub API never invokes this repo's code, in-repo or otherwise.",
  },
];

// ── The reviewer RUBRIC (MASTER-PLAN §5 layer 2 — advisory judgment) ────────
/** Layer 2 of the three-tier gate stack: deterministic JUDGMENT items the reviewer runs over a PR's diff and report.
 * It ADVISES; the GitHub-enforced gate decides (Standing rule 3B). Each item is a PURE predicate whose falsifier is a
 * unit fixture, never an LLM call, and each is exported separately. COARSE, diff-scoped heuristics by design. The
 * four §5 items: ONE CONCERN per PR; ALL CALLERS AUDITED (a change that fixes one call site and orphans the rest);
 * TEST THEATER; REFACTOR-PHASE HONESTY. Plus DOCS AWARENESS (§12A, W1-T30): a diff changing user-visible behaviour
 * must update `docs/` or state why not in the REPORT. Plus TROUBLESHOOTING COVERAGE (§12A, W1-T50): a diff ADDING an
 * `operator_impact: true` entry to `learnings/failures.yaml` must also touch `docs/troubleshooting.md` with that id,
 * or say why not. Plus the GUARD: a diff ADDING a `satisfied_by` line fails unless the PR is plan-only AND
 * human-authored, because that field is Architect-only (rule 15). */

/** The stable key of one rubric judgment item (used in verdicts + summaries). */
export type RubricKey =
  | "one-concern"
  | "callers-audited"
  | "test-theater"
  | "refactor-honesty"
  | "docs-awareness"
  | "troubleshooting-coverage"
  | "drill-coverage"
  | "satisfied-by-guard";

/** One rubric item's verdict over a (diff, report). */
export interface RubricItemResult {
  key: RubricKey;
  pass: boolean;
  reason: string;
}

/** PR-level facts the satisfied_by guard needs (unknowable from the diff alone). */
export interface RubricPrMeta {
  /** The PR touches ONLY plan/docs (no product code) — an Architect plan PR. */
  planOnly?: boolean;
  /** The PR is NOT a dispatched worker run editing its own task — the exemption half of {@link
   *  checkSatisfiedByGuard}. DERIVED FROM THE HEAD REF, never asserted: `runReview` sets it from `headRefName` via
   *  {@link "../run-task.js".isDispatchedRunBranch}, because a dispatched run always pushes to
   *  `run-<taskId>-<epochMs>` and no hand-opened branch takes that shape. ABSENT ⇒ FALSE, never
   *  "unknown-so-allow": the one call site that cannot supply a head ref is `runFixRung`'s, BY
   *  CONSTRUCTION a dispatched run amending its own branch, the exact case the exemption must not cover.
   *  // Why: until W1-T385 nothing set this field, so the exemption could never fire. */
  humanAuthored?: boolean;
}

/** Everything the rubric judges: the diff, the implement report, and PR-level facts. */
export interface RubricInput extends RubricPrMeta {
  diff: string;
  report?: string;
}

/** The rolled-up rubric verdict — all items plus the guard. */
export interface RubricResult {
  items: RubricItemResult[];
  failures: RubricItemResult[];
  pass: boolean;
}

// One classified line of a unified diff.
interface DiffLine {
  file: string;
  kind: "add" | "del" | "ctx";
  text: string;
}

/** Walk a unified diff into classified (file, kind, text) lines. Dependency-free. */
function walkDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let file = "";
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git")) {
      const m = raw.match(/\sb\/(\S+)\s*$/);
      file = m ? m[1] : "";
      continue;
    }
    if (raw.startsWith("+++ ")) {
      // A DELETED file's `+++` line is `+++ /dev/null`, and letting it overwrite `file` tagged every removed line
      // `/dev/null`, which `changedFiles` then filtered out — so a pure deletion contributed NOTHING to the
      // reviewer's changed-file list (W1-T389). The `diff --git` header one branch above already set the real path,
      // so KEEP IT. Fixed here in the walker rather than at each of the four consumers, which is how the next one
      // inherits the bug. The `---` direction needs no equivalent, since an ADDED file's `--- /dev/null` is skipped
      // rather than assigned — asserted, not assumed, by test/review-deletion-blind.test.ts.
      const plus = raw.replace(/^\+\+\+\s+(?:b\/)?/, "").trim();
      if (plus !== "/dev/null") file = plus;
      continue;
    }
    if (raw.startsWith("--- ") || raw.startsWith("@@")) continue;
    if (raw.startsWith("+")) out.push({ file, kind: "add", text: raw.slice(1) });
    else if (raw.startsWith("-")) out.push({ file, kind: "del", text: raw.slice(1) });
    else out.push({ file, kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw });
  }
  return out;
}

/** A plan-shard's own `files:` line, house convention: a single flow-style YAML array,
 *  `  files: [a/b.ts, c/d.ts]` — verified against every shard under `plan/tasks.d/` at
 *  W1-T456's own commit (grep `^  files:`): all single-line, none block-style. */
const SHARD_FILES_LINE_RE = /^\s*files:\s*\[(.*)\]\s*$/;
/** A diff-touched path this repo's task shards live at — `plan/tasks.yaml` (the
 *  monolith some flows still write) or `plan/tasks.d/<id>.yaml` (the sharded form). */
const SHARD_PATH_RE = /^plan\/(tasks\.yaml|tasks\.d\/[^/]+\.ya?ml)$/;

/** (W1-T456, DEFECT A) Repo-relative paths a plan-shard ADDS to its own `files:` scope, read straight
 * off the ADDED lines of THIS diff, never off a resolved task id — because a plan-FILING PR deliberately carries no
 * `Remudero-Task:` trailer (#1527: crediting one would mark the task it just filed DONE before it is built), so
 * `judgeReview` has no id for exactly the PRs this helps. The shard is sitting in the diff being reviewed, complete
 * with its declared `files:`, and reading it from the ADDED lines needs no plan load and cannot be spoofed by a
 * DELETED line. Deliberately narrow: only a bare, single-line `files: [...]` ({@link SHARD_FILES_LINE_RE}) counts,
 * and under-matching only means a real forward
 * reference falls back to `executed_fail`, today's behaviour. */
export function shardDeclaredFilesInDiff(diff: string): Set<string> {
  const declared = new Set<string>();
  for (const line of walkDiff(diff)) {
    if (line.kind !== "add" || !SHARD_PATH_RE.test(line.file)) continue;
    const m = line.text.match(SHARD_FILES_LINE_RE);
    if (!m) continue;
    for (const raw of m[1].split(",")) {
      const path = raw.trim();
      if (path) declared.add(path);
    }
  }
  return declared;
}

// ── Item 1: ONE CONCERN per PR ─────────────────────────────────────────────

/** The concern a changed file belongs to, keyed by its source STEM: `src/lib/foo.ts` and its
 *  co-located `test/foo.test.ts` are the SAME concern (`foo`). Non-source files carry none. */
function concernStem(path: string): string | null {
  const isSource = /^src\//.test(path) || /(^|\/)test(s)?\//.test(path) || /\.(test|spec)\./.test(path);
  if (!isSource) return null;
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.(test|spec)\.[cm]?[jt]sx?$/, "").replace(/\.[cm]?[jt]sx?$/, "");
}

/** Distinct files with at least one changed (add/del) line. */
function changedFiles(lines: DiffLine[]): string[] {
  const files = new Set<string>();
  for (const l of lines) {
    if ((l.kind === "add" || l.kind === "del") && l.file && l.file !== "/dev/null") files.add(l.file);
  }
  return [...files];
}

/** ONE CONCERN: a PR should cluster around a single source module, and two or more distinct product or test STEMS is
 * the partial-fix-drift smell of a multi-concern PR. TRAP (W1-T2823): {@link concernStem} keys a concern to a
 * BASENAME and its collapse rule assumes a `src/lib/foo.ts` + `test/foo.test.ts` pairing, but this repo names a
 * falsifier after the CLAIM it proves — so a PR's own suite contributed a second stem and the arm fired on 36 of 43
 * judged commits in an 80-commit sample of origin/main (83.7%). An advisory the fix rung CONSUMES that is wrong five
 * times in six is worse than no input. THE COMPANION DISCOUNT IS {@link COMPANION_PATH_CLASSES} — the shared table
 * W1-T2547 extracted so both task-linter.ts and review.ts read it. TWO PASSES, mirroring {@link
 * "./task-linter.js".subsystemsOf}: companions fold in only if nothing else survives.
 * // Why: W1-T2525's `ownFalsifierSlug` narrowing scored 33 of the same 43 against this rule's 19. */
export function checkOneConcern(
  diff: string,
  companionClasses: ReadonlyArray<CompanionPathClass> = COMPANION_PATH_CLASSES,
): RubricItemResult {
  const stems = new Set<string>();
  const companions = new Set<string>();
  for (const f of changedFiles(walkDiff(diff))) {
    const s = concernStem(f);
    if (!s) continue;
    if (isCompanionPath(f, companionClasses)) companions.add(s);
    else stems.add(s);
  }
  // A diff of companions ONLY still counts them — see the two-pass note above.
  if (stems.size === 0) for (const s of companions) stems.add(s);
  if (stems.size > 1) {
    return {
      key: "one-concern",
      pass: false,
      reason: `PR spans ${stems.size} concerns (${[...stems].sort().join(", ")}); one concern per PR — split it`,
    };
  }
  return {
    key: "one-concern",
    pass: true,
    reason: stems.size === 1 ? `single concern (${[...stems][0]})` : "no product-source change to concern-check",
  };
}

// ── Item 2: ALL CALLERS AUDITED (partial-fix drift) ────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Count top-level (comma-separated) items in an argument/parameter string. */
function countTopLevel(inner: string): number {
  const s = inner.trim();
  if (s === "") return 0;
  let depth = 0;
  let count = 1;
  for (const ch of s) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) count++;
  }
  return count;
}

/** Parse a single-line function/arrow definition into its name + parameter count. */
function parseDef(line: string): { name: string; params: number } | null {
  let m = line.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/);
  if (m) return { name: m[1], params: countTopLevel(m[2]) };
  m = line.match(/(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/);
  if (m) return { name: m[1], params: countTopLevel(m[2]) };
  return null;
}

/** Count the args at the FIRST call `name(...)` on a line, or null if not called. */
function callArgCount(line: string, name: string): number | null {
  const m = line.match(new RegExp(`(?<![\\w$])${escapeRegExp(name)}\\s*\\(`));
  if (m?.index === undefined) return null;
  const open = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = open; i < line.length; i++) {
    if (line[i] === "(") depth++;
    else if (line[i] === ")") {
      depth--;
      if (depth === 0) return countTopLevel(line.slice(open + 1, i));
    }
  }
  return null; // unterminated call on this line — cannot judge arity
}

/**
 * ALL CALLERS AUDITED: when a function's definition GAINS a parameter in the diff,
 * every call site must be updated too. A call left on an UNCHANGED (context) line
 * with the old (too-few) arity is an orphaned sibling — partial-fix drift.
 */
export function checkCallersAudited(diff: string): RubricItemResult {
  const lines = walkDiff(diff);
  const removedDefs = new Map<string, number>();
  const addedDefs = new Map<string, number>();
  for (const l of lines) {
    const d = parseDef(l.text);
    if (!d) continue;
    if (l.kind === "del") removedDefs.set(d.name, d.params);
    else if (l.kind === "add") addedDefs.set(d.name, d.params);
  }
  const gained = [...addedDefs].filter(([n, p]) => {
    const old = removedDefs.get(n);
    return old !== undefined && p > old;
  });
  for (const [name, need] of gained) {
    for (const l of lines) {
      if (l.kind !== "ctx") continue; // an unchanged caller = one the diff did not audit
      if (parseDef(l.text)?.name === name) continue; // the definition line itself is not a call
      const args = callArgCount(l.text, name);
      if (args !== null && args < need) {
        return {
          key: "callers-audited",
          pass: false,
          reason: `partial-fix drift: ${name}() gained a parameter but an unaudited caller still passes ${args} arg(s)`,
        };
      }
    }
  }
  return {
    key: "callers-audited",
    pass: true,
    reason: gained.length ? "every call site updated to the new signature" : "no signature change to audit",
  };
}

// ── Item 3: TEST THEATER ───────────────────────────────────────────────────

/** TEST THEATER as a rubric item — wraps {@link detectTestTheater}. */
export function checkTestTheater(diff: string): RubricItemResult {
  const theater = detectTestTheater(diff);
  return {
    key: "test-theater",
    pass: !theater,
    reason: theater ? "test theater: added tests assert nothing" : "no test theater detected",
  };
}

// ── Item 4: REFACTOR-PHASE HONESTY ─────────────────────────────────────────

// Lines that carry behavior: control flow, returns/throws, comparisons, boolean logic.
const BEHAVIOR_RE = /\breturn\b|\bif\s*\(|\belse\b|\bthrow\b|\bswitch\b|\bwhile\s*\(|\bfor\s*\(|[!=<>]==?|&&|\|\|/;

function isCommentOrBlank(text: string): boolean {
  const s = text.trim();
  return s === "" || s.startsWith("//") || s.startsWith("*") || s.startsWith("/*");
}

/** REFACTOR-PHASE HONESTY: if the change is LABELLED a refactor (the report says so) it must not change behavior. A
 * pure refactor MOVES behavior-bearing lines verbatim — every ADDED behavior line also appears (trimmed) among the
 * REMOVED ones. A behavior line that is added with no matching removal is net-new logic: dishonest for a refactor. */
export function checkRefactorHonesty(diff: string, report?: string): RubricItemResult {
  const labelled = /\brefactor/i.test(report ?? "");
  if (!labelled) return { key: "refactor-honesty", pass: true, reason: "change is not labelled a refactor" };
  const removed = new Set<string>();
  const added: string[] = [];
  for (const l of walkDiff(diff)) {
    if (isTestPath(l.file) || isCommentOrBlank(l.text) || !BEHAVIOR_RE.test(l.text)) continue;
    if (l.kind === "del") removed.add(l.text.trim());
    else if (l.kind === "add") added.push(l.text.trim());
  }
  const novel = added.find((a) => !removed.has(a));
  if (novel) {
    return {
      key: "refactor-honesty",
      pass: false,
      reason: `labelled a refactor but changes behavior (new logic: ${novel.slice(0, 60)})`,
    };
  }
  return { key: "refactor-honesty", pass: true, reason: "labelled a refactor; no behavior-bearing line changed" };
}

// ── Item 5: DOCS AWARENESS (§12A anti-rot mechanism, W1-T30) ───────────────

/** Modules that constitute "user-visible behavior" in the §12A sense — CLI surface, config, gate, or verdicts. A
 *  diff-scoped path heuristic, coarse by design like {@link concernStem}.
 *  // Why: before W1-T212 (recon R-15) a PR lowering a coverage floor cleared docs-awareness silently. */
/** The measurement-INSTRUMENT surface (W1-T297, Standing rule 25): paths a diff can touch to change WHAT a CI gate
 * measures, rather than what the gate concludes about a change. ONE PATH SET, EXPORTED — {@link
 * USER_VISIBLE_SURFACE_RE}'s instrument arm and {@link detectInstrumentEntanglement} are both DERIVED FROM THIS, so
 * the two cannot drift into a second hand-maintained copy. Membership: `.github/workflows/`, every
 * `scripts/*-ratchet.mjs`, `scripts/diff-coverage.mjs`, every `scripts/*-baseline.json`,
 * `scripts/mutation-relevant-paths.json`, and `stryker.conf.json`. STAYS the SOLE BLOCKING authority: a wrong or
 * incomplete derivation must never itself refuse a PR. THIS LIST IS HAND-ENUMERATED and goes stale — W1-T402 shipped
 * missing eleven gate-rule files — so {@link INSTRUMENT_SURFACE_EXCLUSIONS} plus
 * test/instrument-surface-completeness.test.ts derive candidates from the live tree on every run. */
export const INSTRUMENT_SURFACE: readonly string[] = [
  "^\\.github/workflows/",
  "^scripts/[^/]*-ratchet\\.mjs$",
  "^scripts/diff-coverage\\.mjs$",
  "^scripts/[^/]*-baseline\\.json$",
  "^scripts/mutation-relevant-paths\\.json$",
  "^stryker\\.conf\\.json$",
  // W1-T1048: the task-id existence gate's rule logic, behind a required, unconditional ci.yml job.
  "^scripts/task-id-existence-check\\.mjs$",
  // W1-T1051: the assertion-discrimination gate's rule logic, behind a required, unconditional
  // ci.yml job — same shape as the task-id existence entry directly above.
  "^scripts/assertion-discrimination-check\\.mjs$",
  // W1-T1060: the author-time acceptance gate's rule logic, behind its own unconditional pull_request job
  // (.github/workflows/acceptance-author-gate.yml, already covered by the workflows entry above; this line is the
  // script that job's `run:` step calls).
  "^scripts/acceptance-author-gate\\.mjs$",
  // W1-T2428: the fast lane's diff classifier. It decides which suites the `ci` and `coverage-ratchet` jobs RUN, so a
  // diff touching it changes what those gates measure.
  "^scripts/diff-class\\.mjs$",
];

const INSTRUMENT_SURFACE_RE = new RegExp(INSTRUMENT_SURFACE.join("|"));

/** Deliberate exclusions from the {@link INSTRUMENT_SURFACE} completeness alarm
 * (test/instrument-surface-completeness.test.ts, W1-T402): every candidate that alarm finds which {@link
 * INSTRUMENT_SURFACE} does not cover, mapped to the reason it earns a pass rather than a report. A bare path list
 * would rebuild the exact silent gap the alarm closes, so it refuses an entry whose reason is blank. NEVER READ BY
 * {@link detectInstrumentEntanglement}. Two shapes of reason: VERIFIED NON-INSTRUMENT — real, but not
 * gate-measurement logic; and KNOWN GAP, WIDENING DEFERRED — genuinely gate-rule logic (recon guard-reach-2026-08-07
 * found eleven), where widening what refuses a PR must be
 * measured against real merged diffs first. */
export const INSTRUMENT_SURFACE_EXCLUSIONS: Readonly<Record<string, string>> = {
  // ── verified non-instrument: content/data a gate validates, not the rule that validates it ──
  "openapi/daemon.yaml":
    "the daemon's API schema (content) — scripts/generate-api-client.mjs is the enforcement logic and is tracked below",
  "plan/claims.yaml": "claim DATA the claims gate validates, not the checker's rule logic",
  "plan/tasks.yaml": "plan/task DATA, not gate logic",
  "plan/plan-index.json": "a generated index artifact, and its :check mode is not wired into any CI workflow",
  "package-lock.json": "a dependency lockfile, not gate logic",
  // ── verified non-instrument: ops/dev tooling with no CI-gate role ──
  "scripts/check.mjs": "local dev convenience (`npm run check`), never invoked by any CI workflow",
  "scripts/clock-shift.mjs": "clock-drift ops tool for clock-sweep.yml, not a quality gate",
  "scripts/clock-sweep.mjs": "clock-drift ops tool for clock-sweep.yml, not a quality gate",
  "deploy/recycle-container.sh":
    "container-recycle ops runbook script with no CI-gate role — derived only because the task-id-existence " +
    "job's comment cites it as the defect's worked example, which is prose, not a reference",
  "deploy/entrypoint.sh":
    "container image asset copied by deploy/Dockerfile; its workflow reference is a push.paths build trigger, " +
    "not CI gate-rule logic",
  "scripts/fleet-heartbeat.sh": "monitoring script for fleet-heartbeat-watch.yml, not a quality gate",
  "scripts/needs-human-issue.mjs": "issue-filing ops tool, not a quality gate",
  "scripts/recovery-drill.mjs": "ops drill script for recovery-drill.yml, not a quality/measurement gate",
  "scripts/generate-capability-snapshot.mjs": "its :check mode is not wired into any CI workflow",
  // ── known gap, widening deferred: real gate-rule logic, not yet promoted to the BLOCKING list ──
  "scripts/unwired-gate-check.mjs":
    "KNOWN GAP, WIDENING DEFERRED (W1-T2735) — genuinely gate-rule logic: it refuses a tracked " +
    "`scripts/` executable whose basename claims to be a gate (`-check`/`-gate`) while no " +
    ".github/workflows/ `run:` step and no package.json script invokes it, holding its inline " +
    "ALLOWANCE to shrink-only so a recorded row cannot outlive the wiring it defers. It is NOT " +
    "promoted to INSTRUMENT_SURFACE here for the same reason scripts/worker-branch-shape.mjs above " +
    "is not: W1-T402 design clause (v) requires measuring a widening against real merged diffs " +
    "first, and promoting it in the PR that introduces it would entangle that PR with its own " +
    "registration. The circularity is sharper here than anywhere else on this list — this script's " +
    "whole subject is instruments that no surface invokes, so a promotion would put it on the " +
    "surface it polices.",
  "scripts/worker-branch-shape.mjs":
    "KNOWN GAP, WIDENING DEFERRED (W1-T2491) — genuinely gate-rule logic: it refuses a branch that " +
    "CLAIMS a task without carrying the run-<taskId>-<epochMs> shape seven modules read for dispatch " +
    "visibility and merge credit, and it is registered as a ci-parity census entry. It is NOT promoted " +
    "to INSTRUMENT_SURFACE here because W1-T402 design clause (v) requires measuring a widening against " +
    "real merged diffs first, and promoting it in the same PR that introduces it would make that PR " +
    "entangled with its own src/lib/ci-parity.ts registration — the circularity #3331 hit from the other " +
    "side, where a *-ratchet.mjs filename matched the blocking pattern automatically.",
  "scripts/mkdtemp-callsite-check.mjs":
    "KNOWN GAP, WIDENING DEFERRED (W1-T2773) — genuinely gate-rule logic: it refuses a " +
    "`mkdtempSync(join(tmpdir(), <expr>))` callsite whose prefix `sweepStaleTempDirs` cannot prove " +
    "reapable, enforced at author (commit) time via hooks/pre-commit and exposed as the " +
    "`mkdtemp-callsite-check` package.json script. It is NOT promoted to INSTRUMENT_SURFACE here " +
    "because W1-T402 design clause (v) requires measuring a widening against real merged diffs " +
    "first, and promoting it in the same PR that introduces it would entangle that PR with its own " +
    "registration — the same circularity scripts/unwired-gate-check.mjs and " +
    "scripts/worker-branch-shape.mjs above record for themselves.",
  "scripts/generate-cli-reference.mjs": "its :check mode is not wired into any CI workflow",
  // W1-T2763 — THE SAME CLASSIFICATION AS ITS SIBLING ABOVE, which this generator mirrors. `macro-skills:check` is
  // not a workflow `run:` step: it reaches CI only through test/operator-macros-are-generated.test.ts inside
  // `npm test`, exactly as `cli-reference:check` does, so a diff cannot change what a workflow-level gate MEASURES by
  // touching it. What it gates is drift between settings/macros.yaml and the generated `.claude/skills/` tree.
  "scripts/generate-macro-skills.mjs":
    "its --check mode is not wired into any CI workflow — it reaches CI through `npm test` only, " +
    "the same route scripts/generate-cli-reference.mjs above takes, and the drift it gates is over " +
    "generated operator macro text rather than over any gate's own rule",
  "scripts/generate-docs-index.mjs": "its :check mode is not wired into any CI workflow",
  "scripts/generate-learnings-index.mjs": "its :check mode is not wired into any CI workflow",
  "scripts/generate-plan-index.mjs": "its :check mode is not wired into any CI workflow",
  // ── verified non-instrument: self-falsifying fixture ──
  "scripts/strict-probe.ts":
    "a fixture consumed only by its own falsifier test/strict-probe.test.ts; removing its deliberate " +
    "violation flips that test's own assertion, so it cannot silently loosen tsconfig.json's strict gate",
  // ── known instrument-surface gaps: widening the BLOCKING list deferred pending a blast-radius
  //    measurement against real merged diffs (W1-T402 design clause v), not silently missed ──
  ".dependency-cruiser.cjs": "dependency-cruiser fitness rules (depcruise job) — widening deferred, see above",
  ".github/codeql/codeql-config.yml": "CodeQL scan config — widening deferred, see above",
  ".github/scripts/containment-diff-trigger.ts": "the containment probe's trigger logic — widening deferred, see above",
  ".github/scripts/leak-grep.sh": "the leak-grep secret tripwire — widening deferred, see above",
  ".jscpd.json": "the duplication threshold (jscpd-gate job) — widening deferred, see above",
  "commitlint.config.mjs": "commitlint's own rule config — widening deferred, see above",
  "package.json": "defines every `npm run <script>` a gate job invokes — widening deferred, see above",
  "scripts/claims-check.mjs": "the claims gate script — widening deferred, see above",
  "scripts/generate-api-client.mjs": "api-client-drift's regeneration + comparison logic — widening deferred, see above",
  "scripts/learnings-assert-check.mjs": "the learnings-assert gate script — widening deferred, see above",
  "scripts/mutation-nightly-scope.json": "mutation-nightly's sampling scope config — widening deferred, see above",
  "scripts/no-hand-rolled-fetch-check.mjs": "the no-hand-rolled-fetch gate script — widening deferred, see above",
  "scripts/test-with-retry.mjs":
    "wraps the ci/coverage-ratchet jobs' actual test pass/fail determination — widening deferred, see above",
  "tsconfig.json": "the TS strict-mode config the Typecheck step compiles against — widening deferred, see above",
};

/** ENFORCEMENT DATA (W1-T427): the files under `plan/**` the fleet's own gates OBEY, as opposed to the plan
 * paperwork those gates are applied TO — each mapped to WHAT IT ENFORCES, because a reviewer reads reasons, not
 * lists. WHY THE CATEGORY EXISTS: {@link isInPlanScope} is `MASTER-PLAN.md || ORIENTATION || plan/**`, and {@link
 * ReviewVerdict.planOnly}'s carve-out exempts a plan-scope-only diff from proof execution — right for a task filing
 * and wrong for these four, because a PR that blunts an assertion in `plan/claims.yaml` RIDES the carve-out that
 * skips the floor which would catch it. Of the mapped guard gaps this is the only one that QUIETS ITS OWN ALARM, so
 * it is closed BEFORE an incident; FILED ASSUMED. THE SCOPE PREDICATE IS DELIBERATELY UNTOUCHED. ONE FILE IS IN BOTH
 * MAPS AND THAT IS NOT A CONTRADICTION: `plan/claims.yaml` sits in {@link INSTRUMENT_SURFACE_EXCLUSIONS} as claim
 * DATA, not the checker's rule logic. EXACT PATHS, never prefixes; new arrivals are caught by
 * test/enforcement-data-carveout.test.ts. */
export const ENFORCEMENT_DATA: Readonly<Record<string, string>> = {
  "plan/claims.yaml":
    "the falsifiable self-checks scripts/claims-check.mjs runs on every PR — blunting an assertion " +
    "here is the self-concealing edit this whole category exists to catch",
  "plan/policy.yaml":
    "the fleet's operating constants AS DATA — src/lib/policy.ts's loadPolicy feeds dispatch lanes, " +
    "cost ceilings and cadence governors from it, so an edit changes what the fleet OBEYS",
  "plan/alert-policy.yaml":
    "the scanner-alert lane's policy AS DATA — its own header states that editing this file alone " +
    "changes what the lane does, with no code change required",
  "plan/mast-mapping.yaml":
    "the deterministic verdict -> MAST classifier, whose own header reads 'this table is the " +
    "classifier: a ledger verdict class is NEVER LLM-judged ... only looked up here'",
};

/** Deliberate exclusions from the {@link ENFORCEMENT_DATA} completeness alarm
 * (test/enforcement-data-carveout.test.ts): every candidate that alarm finds which is NOT enforcement data, mapped to
 * the reason it earns a pass. Exactly the {@link INSTRUMENT_SURFACE_EXCLUSIONS} contract — a blank reason is refused
 * — and NEVER READ BY {@link enforcementDataInDiff}. A key ending in `/` excuses a whole RECORD STORE, a directory
 * the fleet reads by globbing rather than by naming a member: those three hold 331 of the 337 tracked data files
 * under `plan/`, and per-file entries would hide the four real ones. They are candidates at all only because src/
 * PROSE cites individual members as
 * examples, which is DERIVED rather than assumed — a citation is not a read. */
export const ENFORCEMENT_DATA_EXCLUSIONS: Readonly<Record<string, string>> = {
  "plan/tasks.d/":
    "the task shards themselves — filing and amending tasks is exactly what the plan-only carve-out is for",
  "plan/feedback/":
    "the feedback inbox: entries triage reads and dispositions, never rules that gate a PR",
  "plan/decisions.d/":
    "recorded decision entries — provenance the DECISIONS floor validates, not a gate's own thresholds",
  "plan/tasks.yaml":
    "the task monolith, the same paperwork as a shard; denying it the carve-out would tax every filing",
  "plan/plan-index.json":
    "a GENERATED projection (scripts/generate-plan-index.mjs regenerates it), not hand-authored enforcement data",
};

/** The enforcement-data paths a changed-file list touches, in diff order (W1-T427) — the OBSERVED
 * EVIDENCE named on the posted status by {@link cappedSummary}, not just a boolean (W1-T186 emitter discipline: an
 * operator must be told WHICH file cost the carve-out). EXACT membership via
 * `Object.hasOwn`, so an inherited prototype key can never make a path look like enforcement data. */
export function enforcementDataInDiff(diffFiles: string[]): string[] {
  return diffFiles.filter((f) => Object.hasOwn(ENFORCEMENT_DATA, f));
}

const USER_VISIBLE_SURFACE_RE = new RegExp(
  [
    "^bin/", // the CLI entry point
    "^src/run-task\\.ts$", // CLI dispatcher / orchestrator
    "^src/spike\\.ts$", // CLI entry (spike mode)
    "^src/lib/(config|settings|mounts)\\.ts$", // config surface
    "^src/lib/(review|task-linter)\\.ts$", // gate surface
    "^src/lib/(run-result|status|ledger|flight-judge)\\.ts$", // verdict surface
    ...INSTRUMENT_SURFACE, // measurement-instrument surface (shared, see its own doc)
  ].join("|"),
);

/** A "product" path for entanglement purposes (W1-T297): under `src/` and NOT itself a test file.
 * `test/` files must NOT count as the product half — the design's own carve-out — or an instrument-only PR could
 * never carry the fixture that proves it, which is exactly what
 * `test/diff-coverage.test.ts` was shipped for. */
function isProductPath(path: string): boolean {
  return path.startsWith("src/") && !isTestPath(path);
}

/** ENTANGLEMENT-EXEMPT INSTRUMENTS (prerequisite for W1-T941). {@link INSTRUMENT_SURFACE} names what the isolation
 * rule protects: a GATE that decides OTHER PRs' pass/fail. A `scripts/*-baseline.json` matches that surface by
 * FILENAME alone, with no regard for whether anything in `.github/workflows/` reads it as a ratchet, and a baseline
 * nothing in CI reads has no grading power. EXACT PATHS, HAND-ENUMERATED, NEVER A PATTERN — the opposite failure mode
 * from {@link INSTRUMENT_SURFACE}, where a hand enumeration went stale by DROPPING coverage (W1-T402). This list can
 * only ever NARROW that surface, for a named, reviewed path; a new baseline gets full entanglement blocking. */
export const ENTANGLEMENT_EXEMPT_INSTRUMENTS: ReadonlySet<string> = new Set([
  // W1-T941: the knowledge-budget cap's derivation record. No workflow job ratchets against it;
  // its only reader is the pinned DEFAULT_KNOWLEDGE_BUDGET_CHARS constant (src/lib/learnings.ts)
  // and test/knowledge-budget-derivation.test.ts's own falsifier, both landing beside it.
  "scripts/knowledge-budget-baseline.json",
  // W1-T2526: the per-file source-size LEDGER. THIS ENTRY DOES NOT FIT THE REASON ABOVE AND SAYS SO RATHER THAN
  // PRETENDING IT DOES — `scripts/source-size-ratchet.mjs` IS read in CI, through
  // test/a-source-file-cannot-outgrow-its-baseline.test.ts inside the unconditional `ci` job. THE REASON THAT DOES
  // APPLY IS THE LEDGER/FLOOR DISTINCTION: a SCORE FLOOR (scripts/mutation-baseline.json, the coverage floors) grades
  // falsifiers, so lowering it lets a weakened suite pass, while this file grades nothing — raising an entry cannot
  // make a failing falsifier pass. AND WITHOUT THIS THE GATE IS UNSATISFIABLE, MEASURED: every PR that grows a src/
  // file must carry both halves and was refused, and pre-raising separately is no escape because
  // `evaluateSourceSizeRatchet` writes a too-high value back DOWN on the next clean run.
  // // Why: on 2026-08-31 the ledger went stale on five consecutive merges and left `main` itself red (#3352).
  "scripts/source-size-baseline.json",
]);

/** INSTRUMENT ISOLATION (W1-T297, Standing rule 25): true when `diffFiles` holds at least one {@link
 *  INSTRUMENT_SURFACE} path AND at least one {@link isProductPath} src/ path — the ENTANGLEMENT predicate, not mere
 *  instrument-touching. An instrument-only diff, optionally with its own `test/` falsifier or a `docs/` update, is
 *  the sanctioned shape and returns `false`, as does a src-only, plan-only or docs-only diff.
 *  `instrumentPaths`/`srcPaths` are the OBSERVED EVIDENCE named in the failure text (W1-T186 emitter discipline), and
 *  {@link ENTANGLEMENT_EXEMPT_INSTRUMENTS} is subtracted FIRST, before either array is built. */
/** DECLARATIONS WHOSE DATA HAS GRADING POWER OVER OTHER PRs. A changed line inside one counts as EXECUTABLE even
 *  when it is a bare string literal, because adding a path here decides what {@link detectInstrumentEntanglement}
 *  treats as an instrument and what it exempts. Without this carve-out the literal-only rule below would let a diff
 *  register or exempt its own instrument in the same breath as editing it, precisely the risk Standing rule 25 stops.
 *  Matched against the enclosing declaration git names in the hunk header, never the line's own text. */
const GRADING_POWER_DECLARATIONS: readonly string[] = [
  "INSTRUMENT_SURFACE",
  "INSTRUMENT_SURFACE_EXCLUSIONS",
  "ENTANGLEMENT_EXEMPT_INSTRUMENTS",
  "ENFORCEMENT_DATA",
];

/** Does one changed line carry code an instrument could actually mis-grade? NON-EXECUTABLE shapes: a blank line; a
 *  `//` line comment; a JSDoc or block-comment body line (this codebase opens every one with `*`); and a line whose
 *  entire non-comment content is string or template-literal text plus punctuation. FAIL-CLOSED BY CONSTRUCTION:
 *  anything it cannot confidently classify keeps an identifier after the strip and is therefore EXECUTABLE.
 *  TYPE-ONLY DECLARATIONS ARE DELIBERATELY NOT EXEMPTED — a type member (`x?: T;`) and a value in an object literal
 *  (`x: t,`) are the same bytes, separating them needs a parser rather than a regex, and guessing wrong fails OPEN. */
export function changedLineIsExecutable(text: string): boolean {
  const t = text.trim();
  if (t === "") return false;
  if (t.startsWith("//")) return false;
  if (t.startsWith("*") || t.startsWith("/*")) return false;
  // Strip literal CONTENTS (keeping the quotes as punctuation) so a usage sentence cannot look
  // like code, then strip a trailing line comment. Escapes are honoured so an embedded quote
  // cannot end the literal early and leak its tail into the executable residue.
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) { quote = null; out += c; }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; continue; }
    if (c === "/" && t[i + 1] === "/") break;
    out += c;
  }
  // An identifier or keyword surviving the strip is executable content; punctuation alone
  // (`,` `;` `+` from the diff marker already removed by the caller) is not.
  return /[A-Za-z0-9_$]/.test(out);
}

/** Does this file's half of the patch change executable code, or only prose? Reads the hunk headers
 *  git already emits, so a bare string added to a {@link GRADING_POWER_DECLARATIONS} table is never
 *  mistaken for a usage line. `true` when the patch cannot be read for this file at all — an absent
 *  or unparseable diff must never quietly exempt a path. */
export function srcChangeIsExecutable(diff: string, file: string): boolean {
  let current = "";
  let context = "";
  let sawChangedLine = false;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git")) {
      const m = raw.match(/\sb\/(\S+)\s*$/);
      current = m ? m[1] : "";
      context = "";
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const plus = raw.replace(/^\+\+\+\s+(?:b\/)?/, "").trim();
      if (plus !== "/dev/null") current = plus;
      continue;
    }
    if (raw.startsWith("@@")) {
      context = raw.slice(raw.indexOf("@@", 2) + 2);
      continue;
    }
    if (raw.startsWith("--- ")) continue;
    if (current !== file) continue;
    if (!raw.startsWith("+") && !raw.startsWith("-")) continue;
    sawChangedLine = true;
    if (GRADING_POWER_DECLARATIONS.some((d) => context.includes(d))) return true;
    if (changedLineIsExecutable(raw.slice(1))) return true;
  }
  // No changed line for this file anywhere in the patch ⇒ the patch does not describe it.
  return !sawChangedLine;
}

// ── W1-T2521: CENSUS-GATE INTRODUCING-COMMIT CARVE-OUT ──────────────────────────────────────
// THE CIRCULARITY. A census gate is only real once `src/lib/ci-parity.ts` knows about it, and its rule logic is a
// `scripts/<name>.mjs` file. When that filename matches {@link INSTRUMENT_SURFACE}'s `^scripts/[^/]*-ratchet\.mjs$`
// entry the two necessarily land in one diff and {@link detectInstrumentEntanglement} refuses it (#3331); ship the
// script alone and instrument-surface-completeness refuses it as an undeclared surface (#3335). Rule 25's premise is
// about an EXISTING instrument changed alongside the product it measures, and a script that never existed before this
// diff has no prior version to be mis-graded against. THE CARVE-OUT IS NARROW BY CONSTRUCTION: both halves must be
// NEW in the SAME diff, either half missing gets NO carve-out, and the predicate never inspects the matched pattern
// or reads {@link INSTRUMENT_SURFACE_EXCLUSIONS}. NOT SUBTRACTED FROM THE RETURNED EVIDENCE, unlike {@link
// ENTANGLEMENT_EXEMPT_INSTRUMENTS}: only the `entangled` verdict is affected, which leaves the raw evidence readable
// as the negative control. PATH-ONLY CALLERS GET NO CARVE-OUT, `srcChangeIsExecutable`'s fail-closed default.

/** The path a census gate's registration lives at (#3331/#3335's own shared root cause). */
const CENSUS_REGISTRATION_PATH = "src/lib/ci-parity.ts";

/** True when `file` is a brand-new addition in this diff — a `diff --git` block carrying git's own
 * `new file mode` marker, or, equivalently and just as authoritatively, a `--- /dev/null` source
 * side. Neither a rename (git emits `rename from`/`rename to`) nor an ordinary edit qualifies. */
function fileIsNewInDiff(diff: string, file: string): boolean {
  for (const block of diff.split(/(?=^diff --git )/m)) {
    const header = block.match(/^diff --git a\/\S+ b\/(\S+)/);
    if (!header || header[1] !== file) continue;
    return /^new file mode\b/m.test(block) || /^--- \/dev\/null\s*$/m.test(block);
  }
  return false;
}

/** The bare stem a `scripts/<stem>.mjs` (or `.ts`/`.sh`/`.json`) path reduces to — the shape a
 *  `src/lib/ci-parity.ts` registration entry actually cites (e.g. `script: "source-size-ratchet"`
 *  for `scripts/source-size-ratchet.mjs`), never the full path with its directory and extension. */
function scriptStem(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.(mjs|[cm]?[jt]s|sh|json)$/, "");
}

/** True when `scriptFile`, already known to be on {@link INSTRUMENT_SURFACE}, is a newly introduced census gate in
 *  `diff` — see the section doc above. Requires the script to be brand-new ({@link fileIsNewInDiff}) AND
 *  `src/lib/ci-parity.ts` to carry a newly ADDED line naming its stem; a pre-existing registration mentioned in a
 *  comment or context line does not count. */
/** The one workflow {@link CI_PARITY_TABLE} mirrors — see test/preflight-ci-parity.test.ts, which asserts that table
 *  against THIS file in both directions. */
const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";

/** A ci.yml JOB introduced by this diff, keyed on the REGISTERED UNIT rather than the instrument FILE
 * (W1-T2738). `.github/workflows/ci.yml` has existed since the repo did, so {@link fileIsNewInDiff} is false for it
 * however new the job is — the single fact that put a new ci.yml job outside W1-T2521's carve-out. A JOB IS
 * INTRODUCED WHEN TWO ADDS AGREE ON ONE NAME: ci.yml gains a job key, and `src/lib/ci-parity.ts` gains a line
 * registering THAT name. The pair is the discrimination, not belt-and-braces — `on:`'s own children are
 * indented exactly like a job key — and co-presence is not enough, since a diff adding one job while registering
 * another would carve out the wrong unit.
 * // Why: test/preflight-ci-parity.test.ts refuses both halves alone and fails on `main` rather than
 * // only on a PR, so with entanglement closing the third ordering a new ci.yml job had no
 * // admissible sequence at all. */
function isIntroducingCiYmlJob(diff: string, diffFiles: string[]): boolean {
  if (!diffFiles.includes(CENSUS_REGISTRATION_PATH)) return false;
  const lines = walkDiff(diff);
  const addedJobs = lines
    .filter((l) => l.file === CI_WORKFLOW_PATH && l.kind === "add")
    .map((l) => /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l.text)?.[1])
    .filter((name): name is string => name !== undefined);
  if (addedJobs.length === 0) return false;
  const parityAdds = lines.filter((l) => l.file === CENSUS_REGISTRATION_PATH && l.kind === "add");
  return addedJobs.some((job) => parityAdds.some((l) => l.text.includes(`job: "${job}"`)));
}

function isIntroducingCensusGate(diff: string, diffFiles: string[], scriptFile: string): boolean {
  if (!diffFiles.includes(CENSUS_REGISTRATION_PATH)) return false;
  // W1-T2738: ci.yml registers JOBS, not files, so its introducing-commit test is a different
  // question — asked in full by the helper above rather than folded into the file-newness check
  // below, which it would always fail.
  if (scriptFile === CI_WORKFLOW_PATH) return isIntroducingCiYmlJob(diff, diffFiles);
  if (!fileIsNewInDiff(diff, scriptFile)) return false;
  const stem = scriptStem(scriptFile);
  return walkDiff(diff).some((l) => l.file === CENSUS_REGISTRATION_PATH && l.kind === "add" && l.text.includes(stem));
}

export function detectInstrumentEntanglement(
  diffFiles: string[],
  diff?: string,
): { entangled: boolean; instrumentPaths: string[]; srcPaths: string[] } {
  const instrumentPaths = diffFiles.filter(
    (f) => INSTRUMENT_SURFACE_RE.test(f) && !ENTANGLEMENT_EXEMPT_INSTRUMENTS.has(f),
  );
  // A PATH ON THE INSTRUMENT SURFACE IS NOT PRODUCT CODE, EVEN WHEN IT LIVES UNDER `src/`. `isProductPath` is
  // unconditionally `src/` and not `test/`, so before this line a `src/` file named by {@link INSTRUMENT_SURFACE}
  // landed in BOTH arrays and `entangled` was true on that one file plus a workflow, which made the exemption
  // INEXPRESSIBLE. MEASURED on #1863's real file list with a candidate path added: still `entangled: true`. IT
  // PRESERVES THE RULE'S REASON RATHER THAN MUTING IT, since a file that IS the instrument has no product falsifiers
  // of its own; `src/lib/review.ts` is not on the surface and stays product. INERT AT THIS SHA. AND THE `src/` HALF
  // MUST CARRY EXECUTABLE CONTENT when `diff` is supplied; omitting `diff` keeps the path-only reading.
  // // Why: #2884 was split by hand over one appended sentence; a later lane DUPLICATED a helper rather than register a path — the rule had begun shaping code to avoid itself.
  const srcPaths = diffFiles.filter(
    (f) => isProductPath(f) && !INSTRUMENT_SURFACE_RE.test(f) && (diff === undefined || srcChangeIsExecutable(diff, f)),
  );
  // W1-T2521: subtract a newly introduced census gate (script + its own first registration,
  // both new in THIS diff — see the section doc above `CENSUS_REGISTRATION_PATH`) from the
  // ENTANGLEMENT VERDICT only; `instrumentPaths`/`srcPaths` stay the raw, unedited evidence.
  const introducedGates = diff === undefined ? [] : instrumentPaths.filter((f) => isIntroducingCensusGate(diff, diffFiles, f));
  const effectiveInstrumentPaths = introducedGates.length === 0 ? instrumentPaths : instrumentPaths.filter((f) => !introducedGates.includes(f));
  const effectiveSrcPaths = introducedGates.length === 0 ? srcPaths : srcPaths.filter((f) => f !== CENSUS_REGISTRATION_PATH);
  return {
    entangled: effectiveInstrumentPaths.length > 0 && effectiveSrcPaths.length > 0,
    instrumentPaths,
    srcPaths,
  };
}

/** True when a changed path is anywhere under a `docs/` directory. */
function isDocsPath(path: string): boolean {
  return /(^|\/)docs\//.test(path);
}

/** A reason the report STATES for why no doc update accompanies a surface change — the report's own
 * words, not inferred. Requires the "no doc(s) change/update" phrase to be followed by an actual
 * reason, so a bare "no docs update" with nothing after it has not stated why and does not count. */
const STATED_REASON_RE = /\bno\s+docs?\s+(?:change|update)\b[^.\n]{0,6}(?:because|:|-|—)\s*\S/i;

/** DOCS AWARENESS: a diff touching a CLI, config, gate or verdict surface must also touch `docs/`,
 * or the report must state why not. Silence is a fail — exactly the drift the awareness layer exists to catch. */
export function checkDocsAwareness(diff: string, report?: string): RubricItemResult {
  const files = changedFiles(walkDiff(diff));
  const rawSurfaceTouched = files.filter((f) => USER_VISIBLE_SURFACE_RE.test(f));
  // A GENERATED LEDGER (e.g. scripts/source-size-baseline.json) matches the instrument surface by filename alone, as
  // it does for {@link detectInstrumentEntanglement}, but it records a measurement and has no user-visible surface to
  // document (W1-T2547; see task-linter.ts's GENERATED_LEDGER_CLASSES for the shared table). Subtracted HERE ONLY: a
  // diff that also touches a REAL surface still reports on that surface below.
  const ledgerTouched = rawSurfaceTouched.filter((f) => isCompanionPath(f, GENERATED_LEDGER_CLASSES));
  const surfaceTouched = rawSurfaceTouched.filter((f) => !isCompanionPath(f, GENERATED_LEDGER_CLASSES));
  if (surfaceTouched.length === 0) {
    if (ledgerTouched.length > 0) {
      return {
        key: "docs-awareness",
        pass: true,
        reason: `generated size ledger only (${ledgerTouched.join(", ")}) — not a user-visible surface`,
      };
    }
    return { key: "docs-awareness", pass: true, reason: "no CLI/config/gate/verdict surface changed" };
  }
  if (files.some(isDocsPath)) {
    return {
      key: "docs-awareness",
      pass: true,
      reason: `docs/ updated alongside surface change (${surfaceTouched.join(", ")})`,
    };
  }
  if (STATED_REASON_RE.test(report ?? "")) {
    return { key: "docs-awareness", pass: true, reason: "report states why no doc update was needed" };
  }
  return {
    key: "docs-awareness",
    pass: false,
    reason: `user-visible surface changed (${surfaceTouched.join(", ")}) with no docs/ update and no stated reason`,
  };
}

// ── Item 6: TROUBLESHOOTING COVERAGE (§12A Tier B, W1-T50) ─────────────────

const FAILURES_LEARNINGS_PATH = "learnings/failures.yaml";
const TROUBLESHOOTING_DOC_PATH = "docs/troubleshooting.md";

/** One `- id: <id>` list-item start line in a learnings shard. */
const LEARNING_ID_LINE_RE = /^-\s*id:\s*(\S+)\s*$/;

/** The ids of entries NEWLY ADDED, not merely edited, to `learnings/failures.yaml` carrying
 *  `operator_impact: true`. "Newly added" is diff-scoped exactly like {@link
 *  checkCallersAudited}'s add/del pairing: a `- id: <id>` line appearing only on an ADD line starts
 *  a brand-new entry, while a field added to an EXISTING entry leaves that line on a context line.
 *  Each entry's span runs to the next `- id:` add-line or the end of the file's lines. */
function newOperatorImpactfulFailureIds(lines: DiffLine[]): string[] {
  const failureLines = lines.filter((l) => l.file === FAILURES_LEARNINGS_PATH);
  const ids: string[] = [];
  let current: { id: string; operatorImpact: boolean } | null = null;
  const flush = () => {
    if (current?.operatorImpact) ids.push(current.id);
    current = null;
  };
  for (const l of failureLines) {
    if (l.kind !== "add") continue;
    const idMatch = l.text.match(LEARNING_ID_LINE_RE);
    if (idMatch) {
      flush();
      current = { id: idMatch[1], operatorImpact: false };
      continue;
    }
    if (current && /^\s*operator_impact:\s*true\s*$/.test(l.text)) {
      current.operatorImpact = true;
    }
  }
  flush();
  return ids;
}

/** A reason the report STATES for why a new operator-impacting failure has no troubleshooting entry
 * — the same shape as {@link STATED_REASON_RE}, scoped to this item's own excuse phrase so the two
 * items' excuses cannot be confused for each other. */
const TROUBLESHOOTING_STATED_REASON_RE =
  /\bno\s+troubleshooting\s+entry\b[^.\n]{0,6}(?:because|:|-|—)\s*\S/i;

/** TROUBLESHOOTING COVERAGE: a diff adding a new `operator_impact: true` entry to
 * `learnings/failures.yaml` must also touch `docs/troubleshooting.md` naming that entry's id, or the report must
 * state why not. Mirrors DOCS AWARENESS one level narrower — the failures corpus
 * specifically — so an operator-visible incident always gets a symptom, cause and fix write-up. */
export function checkTroubleshootingCoverage(diff: string, report?: string): RubricItemResult {
  const lines = walkDiff(diff);
  const newIds = newOperatorImpactfulFailureIds(lines);
  if (newIds.length === 0) {
    return {
      key: "troubleshooting-coverage",
      pass: true,
      reason: "no new operator_impact:true entry added to learnings/failures.yaml",
    };
  }
  const docsLines = lines.filter((l) => l.file === TROUBLESHOOTING_DOC_PATH && l.kind === "add");
  const missing = newIds.filter((id) => !docsLines.some((l) => l.text.includes(id)));
  if (missing.length === 0) {
    return {
      key: "troubleshooting-coverage",
      pass: true,
      reason: `docs/troubleshooting.md updated for ${newIds.join(", ")}`,
    };
  }
  if (TROUBLESHOOTING_STATED_REASON_RE.test(report ?? "")) {
    return {
      key: "troubleshooting-coverage",
      pass: true,
      reason: "report states why no troubleshooting entry was needed",
    };
  }
  return {
    key: "troubleshooting-coverage",
    pass: false,
    reason: `new operator-impacting failure(s) with no docs/troubleshooting.md entry and no stated reason: ${missing.join(", ")}`,
  };
}

// ── Item 7: DRILL COVERAGE (§5D, W1-T939) ───────────────────────────────────

const RECOVERY_DRILL_PATH = "scripts/recovery-drill.mjs";

/** The ids of entries NEWLY ADDED to `learnings/failures.yaml` carrying `drill_obligating: true`.
 * Same diff-scoped rule as {@link newOperatorImpactfulFailureIds}: a `- id: <id>` line present only on an ADD line
 * starts a brand-new entry, while a field added to an existing entry leaves that
 * line on a context line and is a modification. */
function newDrillObligatingFailureIds(lines: DiffLine[]): string[] {
  const failureLines = lines.filter((l) => l.file === FAILURES_LEARNINGS_PATH);
  const ids: string[] = [];
  let current: { id: string; drillObligating: boolean } | null = null;
  const flush = () => {
    if (current?.drillObligating) ids.push(current.id);
    current = null;
  };
  for (const l of failureLines) {
    if (l.kind !== "add") continue;
    const idMatch = l.text.match(LEARNING_ID_LINE_RE);
    if (idMatch) {
      flush();
      current = { id: idMatch[1], drillObligating: false };
      continue;
    }
    if (current && /^\s*drill_obligating:\s*true\s*$/.test(l.text)) {
      current.drillObligating = true;
    }
  }
  flush();
  return ids;
}

/** A reason the report STATES for why a new drill-obligating failure has no drill-table touch — the
 * same shape as {@link TROUBLESHOOTING_STATED_REASON_RE}, scoped to this item's own excuse phrase. */
const DRILL_STATED_REASON_RE = /\bno\s+drill\s+(?:table\s+)?entry\b[^.\n]{0,6}(?:because|:|-|—)\s*\S/i;

/** DRILL COVERAGE: a diff adding a new `drill_obligating: true` entry to `learnings/failures.yaml`
 *  must also touch `scripts/recovery-drill.mjs` (the `RECOVERY_PATHS` table W1-T366/W1-T938 built),
 *  or the report must state why not. Mirrors TROUBLESHOOTING COVERAGE one field over — the
 *  postmortem's last step becomes "add it to the drill" — with the same derivation and escape hatch. */
export function checkDrillCoverage(diff: string, report?: string): RubricItemResult {
  const lines = walkDiff(diff);
  const newIds = newDrillObligatingFailureIds(lines);
  if (newIds.length === 0) {
    return {
      key: "drill-coverage",
      pass: true,
      reason: "no new drill_obligating:true entry added to learnings/failures.yaml",
    };
  }
  const drillLines = lines.filter((l) => l.file === RECOVERY_DRILL_PATH && l.kind === "add");
  const missing = newIds.filter((id) => !drillLines.some((l) => l.text.includes(id)));
  if (missing.length === 0) {
    return {
      key: "drill-coverage",
      pass: true,
      reason: `scripts/recovery-drill.mjs updated for ${newIds.join(", ")}`,
    };
  }
  if (DRILL_STATED_REASON_RE.test(report ?? "")) {
    return {
      key: "drill-coverage",
      pass: true,
      reason: "report states why no drill entry was needed",
    };
  }
  return {
    key: "drill-coverage",
    pass: false,
    reason: `new drill-obligating failure(s) with no scripts/recovery-drill.mjs entry and no stated reason: ${missing.join(", ")}`,
  };
}

// ── The GUARD: no worker-authored criteria edit (rule 15) ──────────────────

/** True for `plan/tasks.yaml` itself OR a `plan/tasks.d/<id>-<slug>.yaml` (or `.yml`) shard (W1-T399).
 * Every task record lives in one of the two, `loadPlan` merges both into one view, and the monolith has been frozen
 * to new filings since #1060 — of the last twenty merged implementation PRs, nineteen worked a shard task, so a
 * predicate keyed on the monolith alone is blind to nearly the whole population Standing rule 15 protects. Matched
 * STRUCTURALLY rather than by a loose glob, so it admits no `plan/tasks.d/README.md` or nested path `listShardFiles`
 * never recurses into. Mirrors `SHARD_PATH_RE` and `TASKS_SHARD_PATH_RE`.
 * // Why: `listShardFiles` (plan.ts) loads `.yaml` OR `.yml` while this accepted only `.yaml`, so an
 * // identical criterion-editing diff tripped Rule 15 on one and passed silently on the other (R-14,
 * // docs/audits/recon-2026-09-05.md). */
function isTaskRecordPath(file: string): boolean {
  return /(^|\/)plan\/tasks\.yaml$/.test(file) || /(^|\/)plan\/tasks\.d\/[^/]+\.ya?ml$/.test(file);
}

/** plan/tasks.yaml OR plan/tasks.d/*.ya?ml lines belonging to a criterion's own field, of the given diff kind —
 * INCLUDING a criterion field's block-scalar CONTINUATION lines (R-16, docs/audits/recon-2026-09-05.md). TRAP: the
 * match was a bare per-line regex that sees only a field's OWN header line, so a field written as a YAML block scalar
 * — `proof: >-` plus indented continuations carrying the actual text, with NO `:` on those lines — let an edit
 * confined to them trip neither `criterionFieldTampered` disjunct: the guard passed on a diff rewriting what a
 * criterion's proof literally says. FIXED BY WALKING THE DIFF'S OWN LINE ORDER as a tiny YAML-indent state machine,
 * `ctx` lines included; a single `openScalar` slot suffices. FAILS CLOSED when the owning field's header falls
 * outside the hunk: any add or del line indented deeper than the nearest KNOWN `acceptance:` line is still counted,
 * while a line outside any `acceptance:` block is never swept in. */
function planTasksCriterionFieldLines(lines: DiffLine[], kind: "add" | "del"): DiffLine[] {
  // Function-local, never module-scope: a YAML mapping-key line however indented, matched once so that a computed
  // indent and the key/rest are never derived two different ways. Requires `key` to be followed IMMEDIATELY by `:`,
  // which is what keeps a `unit test: <title>` or `grep: <pattern> in <path>` proof-dialect CONTENT line, whose colon
  // has a space before it, from ever being misread as a fresh field header.
  const fieldLineRe = /^(\s*)(-\s+)?([A-Za-z_][\w-]*)\s*:\s*(.*)$/;
  // True when a field's own value is a YAML block-scalar opener — `|`/`>` with an optional chomping indicator and/or
  // explicit indent digit, and NOTHING else on the line. That is the only shape whose CONTINUATION lines carry no
  // `key:` prefix, which is exactly what Rule 15 must see into.
  const blockScalarOpenerRe = /^[|>][+-]?\d*$/;
  // The three fields Rule 15 protects (W1-T58/W1-T400) — see criterionFieldTampered above.
  const criterionFieldNames = new Set(["claim", "proof", "satisfied_by"]);

  const out: DiffLine[] = [];
  let currentFile = "";
  let openScalar: { indent: number; name: string } | null = null;
  let acceptanceIndent: number | null = null;

  for (const l of lines) {
    if (l.file !== currentFile) {
      currentFile = l.file;
      openScalar = null;
      acceptanceIndent = null;
    }
    if (!isTaskRecordPath(l.file)) continue;

    const rawIndent = /^(\s*)(-\s+)?/.exec(l.text);
    const indent = (rawIndent?.[1]?.length ?? 0) + (rawIndent?.[2]?.length ?? 0);

    // Still inside a previously-opened block scalar's continuation — classify by its OWNER and
    // never reinterpret this line as a fresh field header, however "key:"-shaped its content
    // looks (a `grep:` proof-dialect content line is exactly this shape).
    if (openScalar !== null && indent > openScalar.indent) {
      if (l.kind === kind && l.text.trim() !== "" && criterionFieldNames.has(openScalar.name)) {
        out.push(l);
      }
      continue;
    }
    if (openScalar !== null) openScalar = null; // dedented to <= the scalar's own indent — closed

    const m = fieldLineRe.exec(l.text);
    if (m) {
      const name = m[3];
      const rest = m[4].trim();
      if (blockScalarOpenerRe.test(rest)) openScalar = { indent, name };
      if (name === "acceptance" && (acceptanceIndent === null || indent < acceptanceIndent)) {
        acceptanceIndent = indent;
      }
      if (criterionFieldNames.has(name) && l.kind === kind) out.push(l);
      continue;
    }

    // Neither a field header nor a tracked scalar's continuation — the owning field header must
    // sit outside this diff's hunk context. Fail closed under a KNOWN acceptance: block only.
    if (acceptanceIndent !== null && indent > acceptanceIndent && l.text.trim() !== "" && l.kind === kind) {
      out.push(l);
    }
  }
  return out;
}

/** RULE 15's shared diff-derived predicate (W1-T58, ratifies P3 via P8/RETRO-1784058021334): true
 * when a diff either ADDS a `claim:`/`proof:`/`satisfied_by:` line or REMOVES an existing one, in `plan/tasks.yaml`
 * or a `plan/tasks.d/*.yaml` shard (W1-T399). A removed field line is present whether the TEXT changed or the whole
 * criterion was deleted; an added one is present whether an EXISTING criterion gained a field or a WHOLE NEW
 * criterion was APPENDED. Both read as "the criteria no longer say what the Architect wrote". Diff-derived ONLY:
 * callers apply their OWN exemption on top — {@link checkSatisfiedByGuard} uses `planOnly && humanAuthored`, {@link
 * judgeReview} `planOnly` alone.
 * // Why: a pure append tripped neither disjunct before W1-T400 widened the ADD side (#1295). */
function criterionFieldTampered(diff: string): boolean {
  const lines = walkDiff(diff);
  const addedField = planTasksCriterionFieldLines(lines, "add").length > 0;
  const removedField = planTasksCriterionFieldLines(lines, "del").length > 0;
  return addedField || removedField;
}

/** THE RULE-15 GUARD: `satisfied_by` and criteria text are Architect-only (Standing rule 15 — a worker may never
 *  correct a mis-specified task). A diff that ADDS a `claim:`/`proof:`/`satisfied_by:` field — an existing criterion
 *  gaining one, or a whole new criterion appended (W1-T400) — or EDITS or REMOVES an existing criterion's field, in
 *  `plan/tasks.yaml` or a `plan/tasks.d/*.yaml` shard (W1-T399), FAILS unless the PR is plan-only AND human-authored.
 *  A worker doing any of these to its own blocking criteria is editing the criteria to match the diff: a failed task,
 *  not a merge. */
export function checkSatisfiedByGuard(diff: string, meta: RubricPrMeta = {}): RubricItemResult {
  if (!criterionFieldTampered(diff)) {
    return {
      key: "satisfied-by-guard",
      pass: true,
      reason: "no criterion field added or edited in plan/tasks.yaml or a plan/tasks.d/ shard",
    };
  }
  if (meta.planOnly && meta.humanAuthored) {
    return {
      key: "satisfied-by-guard",
      pass: true,
      reason: "criterion field added/edited in a plan-only PR off a non-run branch (Architect-only — allowed)",
    };
  }
  // NAME THE CONDITION THAT FAILED, NEVER GUESS THE AUTHOR (W1-T385). This message is ADVISORY and reaches the
  // operator verbatim, so a claim it cannot substantiate costs a re-derivation: the single old wording asserted
  // "worker-authored … outside a plan-only human PR" on every refusal, false in BOTH directions on a plan-only
  // hand-opened PR — naming an author the review path could not know AND denying a property it had just computed
  // true.
  const edit =
    "plan/tasks.yaml's (or a plan/tasks.d/ shard's) acceptance criteria were added/edited (an added " +
    "claim/proof/satisfied_by field — including a whole new criterion appended after the existing ones — " +
    "or an edited/removed one)";
  // THE FULL REMEDY LIVES HERE, deliberately not in `failSummary`: that string is the commit-status description and
  // is cut at 140 characters, while this `reason` has no cap. IT HAS TWO HALVES BECAUSE ONE IS NOT ENOUGH, and that
  // is measured: telling an author only to SPLIT the filing converts one refusal into another. The floor was RIGHT in
  // every one of those cases and must not be relaxed — a claim about the ACT of filing has no support in a diff that
  // IS the shard — so what the author needs is the second sentence, substantiate each criterion by NAMING the proof
  // that will carry it.
  // // Why: #3626, #3631, #3636 and #3669 each split correctly and were refused anyway; #3669 scored 2 of 5 proof keywords against MIN_COVERAGE 0.6 and all seven criteria read UNMET.
  const remedy =
    "REMEDY: file the shard in its own plan-only PR (no src/ or test/ file in that diff), then build " +
    "it in a second PR. In the filing PR's body, substantiate each criterion by NAMING the proof that " +
    "will carry it (e.g. `unit test: test/<file>.test.ts`) — its proofs are not yet built, so the " +
    "keyword floor judges your body against each proof's own text, and a body that describes the act " +
    "of filing instead of the shard's contents is refused on a shard nothing is wrong with.";
  return {
    key: "satisfied-by-guard",
    pass: false,
    reason: meta.planOnly
      ? `${edit} on a dispatched run branch — a worker editing its own criteria to match the diff (Standing rule 15). ${remedy}`
      : `${edit} in a PR that is not plan-only, so the Architect carve-out does not apply (Standing rule 15). ${remedy}`,
  };
}

/** Run the full rubric — the four §5 layer-2 judgment items plus DOCS AWARENESS, TROUBLESHOOTING
 * COVERAGE, DRILL COVERAGE and the satisfied_by guard — over a diff, a report and PR-level facts. ADVISORY: `pass`
 * rolls up all items, but the binding gate is layer 1. `failures` names exactly
 * which items tripped. */
export function judgeRubric(input: RubricInput): RubricResult {
  const items: RubricItemResult[] = [
    checkOneConcern(input.diff),
    checkCallersAudited(input.diff),
    checkTestTheater(input.diff),
    checkRefactorHonesty(input.diff, input.report),
    checkDocsAwareness(input.diff, input.report),
    checkTroubleshootingCoverage(input.diff, input.report),
    checkDrillCoverage(input.diff, input.report),
    checkSatisfiedByGuard(input.diff, { planOnly: input.planOnly, humanAuthored: input.humanAuthored }),
  ];
  const failures = items.filter((i) => !i.pass);
  return { items, failures, pass: failures.length === 0 };
}

/** Render {@link judgeRubric}'s failing items as a clearly-labelled ADVISORY section for the posted review
 *  (W1-T359) — `undefined` when the rubric has no failures. The header spells out, in the text itself, that this
 *  section never changes `remudero-review`'s verdict (Standing rules 2/12: an LLM or heuristic may RECOMMEND, only
 *  code ENFORCES). The falsifier checks that independence at the call site; this note checks it in the text. */
export function rubricAdvisorySection(rubric: RubricResult): string | undefined {
  if (rubric.failures.length === 0) return undefined;
  const lines = rubric.failures.map((f) => `- **${f.key}**: ${f.reason}`);
  return (
    `**Rubric (advisory — does not affect remudero-review's verdict)**\n\n` +
    `Layer-2 judgment items MASTER-PLAN §5 asks that no acceptance criterion can: ` +
    `one concern per PR, callers audited, test theater, refactor-phase honesty, docs/` +
    `troubleshooting/drill awareness, and the satisfied_by guard. These are observations for the ` +
    `operator and the fix rung — never a blocking condition.\n\n${lines.join("\n")}`
  );
}

/** Render this review's `scope_violation` advisory — the one {@link scopeViolationFiles} already
 * computed — as a PR-comment section, so a declared-scope overrun reaches the human gate instead of only the ledger
 * (W1-T434). READS THE ADVISORY, NEVER RECOMPUTES IT: the comparison has exactly one home, and a second walk could
 * drift, leaving the PR comment and the ledger disagreeing about the same PR. ADVISORY, because a measured majority
 * of declared-scope widenings are legitimate (W1-T401).
 * // Why: until W1-T434 the push-site guard answered an overrun by REFUSING the push, so the branch
 * // died with the reaped worktree — the evidence needed to tell a phantom revert from an
 * // under-declared `files:` was destroyed by the same action that reported it. */
export function scopeAdvisorySection(advisories: readonly UnwiredAdvisory[] | undefined): string | undefined {
  const paths = (advisories ?? []).filter((a) => a.reasonCode === "scope_violation").flatMap((a) => a.symbols);
  if (paths.length === 0) return undefined;
  return (
    `**Declared scope (advisory — does not affect remudero-review's verdict)**\n\n` +
    `This diff touches ${paths.length === 1 ? "a file" : "files"} the task's \`files:\` list does not ` +
    `declare. That is not by itself a fault — a generator-gate artifact, the task's own plan shard, ` +
    `and an operator-instructed or review-ratified widening all look identical here. It is flagged ` +
    `so the overrun is visible at the gate rather than only in the ledger, and never blocks:\n\n` +
    `${paths.map((p) => `- \`${p}\``).join("\n")}\n\n` +
    `If the widening is legitimate, add the path(s) to the task's \`files:\`. If it is not, this is ` +
    `where a reverted-by-accident file (the \`reset --soft\` shape W1-T142 was built for) shows up.`
  );
}

/** Render this review's `unwired_export` advisory — the one {@link unwiredAdvisoriesFor} already
 * computed — as a PR-comment section, so an export added with nothing reaching it lands at the human gate instead of
 * only the ledger. THE SIBLING OF {@link scopeAdvisorySection}, BUILT THE SAME WAY: of the four {@link
 * UnwiredAdvisory} reason codes only `scope_violation` reached the gate. READS THE ADVISORY, NEVER RECOMPUTES IT.
 * ADVISORY AND NON-BLOCKING, DELIBERATELY: an unreached export is not by itself a fault, since a symbol shipped one
 * PR ahead of its caller is a normal split — which is why the `WIRED-AT` and `SHIPS-UNWIRED` markers exist — and
 * whether it should ever BLOCK is W1-T323's open adjudication, so this adds no row to
 * `DECISION_RELEVANT_LEDGER_STEPS`.
 * // Why: over the 60 most recently merged PRs, 14 added an exported symbol and #2952 carried an
 * // `unwired_export` nobody saw. */
export function unwiredExportAdvisorySection(advisories: readonly UnwiredAdvisory[] | undefined): string | undefined {
  const symbols = [
    ...new Set((advisories ?? []).filter((a) => a.reasonCode === "unwired_export").flatMap((a) => a.symbols)),
  ];
  if (symbols.length === 0) return undefined;
  return (
    `**Unwired exports (advisory — does not affect remudero-review's verdict)**\n\n` +
    `This diff adds ${symbols.length === 1 ? "an exported symbol" : "exported symbols"} that nothing ` +
    `in the checkout reaches, with no \`WIRED-AT\` or \`SHIPS-UNWIRED\` marker. That is not by itself a ` +
    `fault — a symbol shipped one PR ahead of its caller looks identical here. It is flagged so the ` +
    `gap is visible at the gate rather than only in the ledger, and never blocks:\n\n` +
    `${symbols.map((s) => `- \`${s}\``).join("\n")}\n\n` +
    `If the caller lands separately, add a \`SHIPS-UNWIRED: <task-id>\` or \`WIRED-AT: <file>::<symbol>\` ` +
    `marker to the PR body. If it does not, this is where an export that was never actually wired up ` +
    `shows up — the half-landed shape that otherwise merges silently.`
  );
}

/** Render this review's `inverse_scope` advisory — the one {@link inverseScopeUntouchedFiles} already
 * computed — as a PR-comment section, so a declared path the diff never touched reaches the human gate instead of
 * only the ledger. THE THIRD OF THE THREE, BUILT EXACTLY LIKE ITS SIBLINGS, and invisible on identical grounds:
 * measured over the 60 most recently merged PRs, `scope_violation` 5 (8%), `inverse_scope` 2 (3%), `unwired_export` 1
 * (2%). THE FOURTH CODE IS DELIBERATELY NOT RENDERED: `unresolved_task_scope` measured 0, and not because it is rare
 * — {@link unresolvedTaskScopeOverlaps} returns empty unless {@link ReviewEvidence.openTaskDeclaredFiles} is
 * populated, and that field has NO
 * producer anywhere in `src/`. A renderer behind an unpopulated field would be dead code. ADVISORY. */
export function inverseScopeAdvisorySection(advisories: readonly UnwiredAdvisory[] | undefined): string | undefined {
  const paths = [
    ...new Set((advisories ?? []).filter((a) => a.reasonCode === "inverse_scope").flatMap((a) => a.symbols)),
  ];
  if (paths.length === 0) return undefined;
  return (
    `**Untouched declared scope (advisory — does not affect remudero-review's verdict)**\n\n` +
    `The task declares ${paths.length === 1 ? "a file" : "files"} this diff never touched. That is ` +
    `not by itself a fault — a \`files:\` list written ahead of the work, or work split across more ` +
    `than one PR, looks identical here. It is flagged so the gap is visible at the gate rather than ` +
    `only in the ledger, and never blocks:\n\n` +
    `${paths.map((p) => `- \`${p}\``).join("\n")}\n\n` +
    `If the remaining ${paths.length === 1 ? "path lands" : "paths land"} in a later PR, no action is ` +
    `needed. If the declaration was wrong, narrow the task's \`files:\` — this is where a scope that ` +
    `was never actually built shows up, and where a task claims ground it never touched.`
  );
}

// ── reviewer_outcome (W1-T63/P10-a — the reviewer stops walling silently) ──

/** The observable OUTCOME of the fresh advisory reviewer spawn, surfaced on the `review.posted` ledger line and the
 *  console summary. `judgeReview`'s binding verdict is unaffected either way (Standing rules 2/4/12); this is purely
 *  a LEGIBILITY signal (P10-a).
 *  // Why: a floor-only PASS — the LLM reviewer walling `error_max_turns`, or never being spawned — was
 *  // byte-identical in the ledger to a review the reviewer actually COMPLETED. */
export function reviewerOutcome(opts: {
  /** false when spawnReviewer===false or there were no criteria to judge — the
   * reviewer was never dispatched, by design, not by failure. */
  attempted: boolean;
  /** The reviewer WorkerResult.subtype, when a spawn actually ran to a terminal
   * state ("success" | "error_max_turns" | …). */
  subtype?: string;
  /** true when the spawn itself THREW (e.g. before yielding any result) —
   * distinct from a subtype, since there is none to report. */
  spawnError?: boolean;
  /** True when the spawn was skipped because the changeset is PLAN-ONLY (W1-T2472). A DISTINCT VALUE, NOT JUST
   *  `attempted: false`: that already carries two documented causes, and this is a structurally different third —
   *  criteria exist and a reviewer would have been dispatched, but the diff has no code for the advisory lane to
   *  judge. Folding it in would make the ledger unable to answer how often the skip fires. */
  planOnlySkip?: boolean;
}): string {
  // Checked BEFORE `attempted` so the plan-only skip is never reported as the generic
  // "never dispatched" case it would otherwise be indistinguishable from.
  if (opts.planOnlySkip) return "not_attempted_plan_only";
  if (!opts.attempted) return "not_attempted";
  if (opts.spawnError) return "spawn_error";
  return opts.subtype ?? "unknown";
}

// ── gh poster (runs outside the sandbox; TLS fails under Seatbelt) ──────────

/** Post the `remudero-review` commit status to a PR head sha. A thin wrapper over the `gh api` call from the design,
 * mirroring the other gh helpers in lib/worker.ts. WRITE-scoped to a commit STATUS only; it can never edit code.
 * W1-T203 (i): when {@link REVIEWER_TOKEN_ENV} is set this authenticates as the dedicated reviewer identity,
 * `GH_TOKEN` overriding ambient auth — the one thing that makes {@link resolveReviewProvenance}'s login compare
 * meaningful at arm time. Unset falls back to ambient auth, byte-identical to before that task. The token never
 * reaches this function as an argument, only via the orchestrator's OWN process env. */
/** Total attempts, first try plus retries, before a TRANSIENT gh-status-post error gives up (W1-T135) — the same
 *  bound classify.ts's {@link "./classify.js".MAX_TRANSIENT_RETRIES} uses for the unrelated fix-rung loop:
 *  independent counters, one policy so the two do not drift. */
export const POST_REVIEW_STATUS_MAX_ATTEMPTS = 4;

/** Base delay (ms) for {@link postReviewStatus}'s exponential backoff between
 * retries — attempt N's wait is `POST_REVIEW_STATUS_BASE_DELAY_MS * 2**(N-1)`. */
export const POST_REVIEW_STATUS_BASE_DELAY_MS = 500;

/** Injectable dependencies for {@link postReviewStatus}'s retry-with-backoff — the same DI shape
 * classify.ts's `DiagnoseThenRetryDeps` uses: optional, with real defaults, so tests override to
 * avoid a real `gh` spawn or real waiting. */
export interface PostReviewStatusRetryOpts {
  /** Total attempts before giving up on a TRANSIENT error. Default {@link POST_REVIEW_STATUS_MAX_ATTEMPTS}. */
  maxAttempts?: number;
  /** Backoff before the NEXT attempt, given the just-failed attempt number (1-based). Default: exponential off {@link POST_REVIEW_STATUS_BASE_DELAY_MS}. */
  backoffMs?: (failedAttempt: number) => number;
  /** Injectable sleep (tests skip real waiting). Default: a real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable `gh` invocation — the "gh gateway" a unit test simulates without shelling out. Defaults to the real `execFileSync("gh", ...)` POST below. */
  exec?: (args: string[], env: NodeJS.ProcessEnv) => void;
}

/** Exported, not just internal, so a unit test can PATH-stub `gh` and drive this exact real
 *  invocation directly — the same temp-dir fake-gh pattern `realArmDeps` tests use — rather than
 *  only exercising it through {@link postReviewStatus}'s injectable `exec`, which would leave this
 *  one-line real wrapper permanently uncovered by the diff-coverage ratchet. */
export function execGhStatusPost(args: string[], env: NodeJS.ProcessEnv): void {
  execFileSync("gh", args, { stdio: "pipe", env, encoding: "utf8" });
}

/** The text a thrown `gh`/execFileSync error carries — stderr first, where `gh api`'s own
 *  "gh: <message> (HTTP <code>)" lands, falling back to stdout and then the Error's own message.
 *  Mirrors the extraction {@link execWhitelistedProof} already does for the same error shape. */
function ghErrorText(e: unknown): string {
  const err = e as NodeJS.ErrnoException & { stderr?: string | Buffer | null; stdout?: string | Buffer | null };
  const asString = (v: string | Buffer | null | undefined) => (typeof v === "string" ? v : (v?.toString("utf8") ?? ""));
  const message = e instanceof Error ? e.message : String(e);
  return [asString(err?.stderr), asString(err?.stdout), message].filter(Boolean).join("\n");
}

/** Post the status with bounded retry. A TRANSIENT error — GitHub 5xx, a network blip, rate-limit
 * backpressure, classified by {@link classifyFailure} over the `gh` error text, the SAME classifier the fix-rung
 * retry loop uses so "is this transient" never drifts — is retried with exponential backoff up to {@link
 * POST_REVIEW_STATUS_MAX_ATTEMPTS}. A PERMANENT error, or any text the classifier does not recognise as transient,
 * throws on the first attempt: fail-closed. Once attempts are exhausted this THROWS the last error; it has no ledger
 * access, so ledger-and-continue is {@link postReviewStatusGuarded}'s job.
 * // Why: a bare `execFileSync` here let a single transient 503 crash a run mid-fix-rung (#283, W1-T135). */
export async function postReviewStatus(
  opts: {
    owner: string;
    repo: string;
    sha: string;
    state: PostableReviewState;
    description?: string;
  },
  retryOpts: PostReviewStatusRetryOpts = {},
): Promise<void> {
  const args = [
    "api",
    "-X",
    "POST",
    `repos/${opts.owner}/${opts.repo}/statuses/${opts.sha}`,
    "-f",
    `context=${REVIEW_CONTEXT}`,
    "-f",
    `state=${opts.state}`,
  ];
  if (opts.description) args.push("-f", `description=${opts.description.slice(0, 140)}`);
  const reviewerToken = process.env[REVIEWER_TOKEN_ENV];
  const env = reviewerToken ? { ...process.env, GH_TOKEN: reviewerToken, GITHUB_TOKEN: reviewerToken } : process.env;

  const maxAttempts = retryOpts.maxAttempts ?? POST_REVIEW_STATUS_MAX_ATTEMPTS;
  const backoffMs = retryOpts.backoffMs ?? ((failedAttempt) => POST_REVIEW_STATUS_BASE_DELAY_MS * 2 ** (failedAttempt - 1));
  const sleep = retryOpts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const exec = retryOpts.exec ?? execGhStatusPost;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      exec(args, env);
      return;
    } catch (e) {
      const transient = classifyFailure({ text: ghErrorText(e) }) === "transient";
      if (!transient || attempt >= maxAttempts) throw e; // permanent, or transient-but-exhausted: surface once
      await sleep(backoffMs(attempt));
    }
  }
}

// ── W1-T228: the status CHANNEL is last-write-wins across uncoordinated posters ──────────────
// W1-T230 took the ARM decision off this channel onto the orchestrator's own ledger; this hardens the CHANNEL itself,
// because the posted status is what branch protection reads and what an operator sees. ONE POST SITE enforces FIVE
// RULES, and {@link postReviewStatusGuarded} is the only call path run-task.ts uses from here on. (i) PRECEDENCE — a
// keyword-only or CAPPED verdict never overwrites an executed-evidence verdict for the SAME sha ({@link
// decideReviewStatusPost}). (ii) LIFECYCLE — no status writes to a merged or closed PR; refused, and
// the refusal is ledgered. (iii) SERIALIZATION — per task, via the SAME O_EXCL create-or-fail primitive drain-lock.ts
// and inflight-lock.ts use ({@link acquireReviewStatusLock}), adapted from a SINGLETON GUARD to a MUTEX: those guard
// a whole RUN, this one short read-decide-write critical section. (iv) RESILIENCE (W1-T135) — a throw is caught,
// ledgered `review.post_failed`, `{posted:false}` returned. (v) SUBJECT FRESHNESS (W1-T2793) — a verdict whose head
// and body no longer match the lifecycle read's is refused. READ BEFORE WRITE: precedence needs the CURRENT posted
// state, so the site reads ledger and lifecycle AFTER the lock — a read before it is the TOCTOU gap.
// // Why: PR 449 head 833561d took SEVEN writes in one day, one ~85s AFTER the PR merged.

/** Whether ANY criterion's proof actually EXECUTED on this sha, or the verdict rests entirely on the
 * ABSENCE of that evidence — keyword-only and CAPPED are both `no_evidence`, since neither observed
 * repo state. Evidence outranks its absence, one-directionally; see {@link decideReviewStatusPost}. */
export type ReviewEvidenceStrength = "executed" | "no_evidence";

export function reviewEvidenceStrength(
  criteria: ReadonlyArray<Pick<CriterionVerdict, "proof_exec">>,
): ReviewEvidenceStrength {
  const executed = criteria.some((c) => c.proof_exec === "executed_pass" || c.proof_exec === "executed_fail");
  return executed ? "executed" : "no_evidence";
}

/** The most recent `review.posted` line's sha, state and evidence for `taskId` — {@link
 *  decideReviewStatusPost}'s `prior` argument. Deliberately separate from {@link
 *  PriorReviewVerdict}, whose consumers never needed evidence strength, so their contracts stay
 *  untouched. Same last-one-wins scan as its siblings, with `evidence` derived from the SAME
 *  `proof_exec` array run-task.ts already ledgers — no new ledger field. */
export interface PostedReviewStatusRecord {
  headSha: string;
  state: ReviewState;
  evidence: ReviewEvidenceStrength;
}

function postedReviewStatusRecord(line: Record<string, unknown>): PostedReviewStatusRecord | undefined {
  if (typeof line.head_sha !== "string") return undefined;
  if (line.state !== "success" && line.state !== "failure") return undefined;
  const proofExec: unknown[] = Array.isArray(line.proof_exec) ? (line.proof_exec as unknown[]) : [];
  const executed = proofExec.some((p) => p === "executed_pass" || p === "executed_fail");
  return { headSha: line.head_sha, state: line.state, evidence: executed ? "executed" : "no_evidence" };
}

export function lastPostedReviewStatusFromLedger(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string,
): PostedReviewStatusRecord | undefined {
  let prior: PostedReviewStatusRecord | undefined;
  for (const line of lines) {
    if (line.step !== "review.posted" || line.task_id !== taskId) continue;
    prior = postedReviewStatusRecord(line) ?? prior;
  }
  return prior;
}

function lastPostedReviewStatusForInput(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string,
  prUrl: string,
  headSha: string,
  inputDigest: string,
): PostedReviewStatusRecord | undefined {
  let prior: PostedReviewStatusRecord | undefined;
  for (const line of lines) {
    if (
      line.step !== "review.posted" ||
      line.task_id !== taskId ||
      line.pr_url !== prUrl ||
      line.head_sha !== headSha ||
      line.review_input_digest !== inputDigest
    ) {
      continue;
    }
    prior = postedReviewStatusRecord(line) ?? prior;
  }
  return prior;
}

/** THE OWNERSHIP RECORD design (b) requires (W1-T913): a `remudero-review=pending` post is distinguishable from
 *  "reviewed" and traceable to the run that posted it, via a `ts`-stamped ledger line. Deliberately a DIFFERENT step
 *  from `review.posted`, which {@link lastPostedReviewStatusFromLedger} scans and which never carries a non-terminal
 *  `state`, so a pending can never be mistaken for a terminal verdict by that precedence read. `runId`/`postedAt`
 *  are what sweep.ts's stuck-pending remedy needs: a pending whose owner is long gone must stay re-drivable rather
 *  than read as "already attended to" forever. */
export interface PendingReviewStatusRecord {
  headSha: string;
  /** The `run_id` that posted this pending — the traceability handle design (c) calls for. */
  runId: string;
  /** The ledger's own `ts` on the `review.pending_posted` line — the staleness clock. */
  postedAt: string;
  /** Process identity captured by new writers. Absent on legacy/incomplete rows. */
  ownerPid?: number;
  /** The ledger writer's host stamp, retained as the holder's host identity. */
  ownerHost?: string;
  /** When this process claimed ownership of the pending review. */
  ownerStartedAt?: string;
}

function pendingReviewStatusRecord(line: Record<string, unknown>): PendingReviewStatusRecord | undefined {
  if (typeof line.head_sha !== "string") return undefined;
  return {
    headSha: line.head_sha,
    runId: typeof line.run_id === "string" ? line.run_id : "",
    postedAt: typeof line.ts === "string" ? line.ts : "",
    ...(typeof line.owner_pid === "number" && Number.isInteger(line.owner_pid) && line.owner_pid > 0
      ? { ownerPid: line.owner_pid }
      : {}),
    ...(typeof line.host === "string" && line.host.length > 0 ? { ownerHost: line.host } : {}),
    ...(typeof line.owner_started_at === "string" ? { ownerStartedAt: line.owner_started_at } : {}),
  };
}

export function lastPendingReviewStatusFromLedger(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string | undefined,
): PendingReviewStatusRecord | undefined {
  if (!taskId) return undefined;
  let prior: PendingReviewStatusRecord | undefined;
  for (const line of lines) {
    if (line.step !== "review.pending_posted" || line.task_id !== taskId) continue;
    prior = pendingReviewStatusRecord(line) ?? prior;
  }
  return prior;
}

export type PendingReviewOwnerAssessment = "active" | "dead" | "unknown";

export interface AssessPendingReviewOwnerOpts extends IsHolderStaleOpts {
  /** Test seam proving this path delegates the complete holder identity to the shared primitive. */
  isStale?: typeof isHolderStale;
}

/** Classify a pending review's durable owner identity without inventing certainty. The shared {@link
 * isHolderStale} predicate owns PID reuse, container replacement and boot-time semantics; this adapter only rejects
 * incomplete records and distinguishes a same-host non-stale result from a
 * foreign holder this process cannot prove active or dead. */
export function assessPendingReviewOwner(
  record: PendingReviewStatusRecord,
  opts: AssessPendingReviewOwnerOpts,
): PendingReviewOwnerAssessment {
  if (
    record.ownerPid === undefined ||
    record.ownerHost === undefined ||
    record.ownerStartedAt === undefined ||
    Number.isNaN(Date.parse(record.ownerStartedAt))
  ) {
    return "unknown";
  }
  const holder = { pid: record.ownerPid, host: record.ownerHost, startedAt: record.ownerStartedAt };
  if ((opts.isStale ?? isHolderStale)(holder, opts)) return "dead";
  const currentHost = (opts.hostname ?? hostname)();
  return record.ownerHost === currentHost ? "active" : "unknown";
}

/** The CURRENT PR lifecycle {@link decideReviewStatusPost}'s LIFECYCLE rule checks against — fetched
 * FRESH by {@link postReviewStatusGuarded}, never a snapshot taken before ci or the reviewer ran. */
export interface PrLifecycleState {
  merged: boolean;
  closed: boolean;
  /** Content address of the live head+body returned by the SAME single-PR REST read. Optional
   *  only for legacy/injected callers that can observe lifecycle but not the review subject. */
  reviewInputDigest?: string;
}

/** ANCHORED ON `/pull/<n>`, mirroring run-task.ts's own `prUrlTarget` — duplicated locally rather
 * than imported, because run-task.ts imports FROM this module and an import the other way would be
 * circular. Returns `undefined`, never a guess, on anything that is not a PR URL. */
function prLifecycleUrlTarget(prUrl: string): { owner: string; repo: string; number: number } | undefined {
  const m = /^https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(prUrl.trim());
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : undefined;
}

/** W1-T522: the real fetcher, now REST (`GET /repos/{o}/{r}/pulls/{n}`) rather than `gh pr view --json
 * state` (GraphQL) — {@link postReviewStatusGuarded}'s default. Tests inject a fake `fetch` instead of a fake
 * closure, mirroring `ghLiveState`'s shape. Reuses {@link prStateFromRest}, the SAME fold `liveStateFromRest`
 * composes. THE FOLD IS BENIGN HERE: a naive `.state`-only read would mislabel a MERGED PR as merely `closed`, but
 * {@link decideReviewStatusPost} refuses posting on merged OR closed alike — unlike at `terminalStateReason`
 * (sweep.ts), which this function does not touch.
 * // Why: this was the one call observed failing with `GraphQL: API rate limit already exceeded`. */
export function fetchPrLifecycle(prUrl: string, fetch: GhApiFetcher = ghJson): PrLifecycleState {
  const target = prLifecycleUrlTarget(prUrl);
  if (!target) {
    throw new Error(
      `fetchPrLifecycle: cannot resolve owner/repo/number from ${JSON.stringify(prUrl)} — refusing to fall ` +
        "back to `gh pr view --json state`, whose GraphQL budget exhaustion is the defect this read was moved off",
    );
  }
  // W1-T2793: retain the head and body identity from this SAME response before folding lifecycle. This adds no GitHub
  // call and stores or logs neither body nor transcript. The optional spread keeps malformed or legacy fixtures on
  // their historical lifecycle-only contract.
  const row = fetch(singlePrRestArgs(target.owner, target.repo, target.number)) as RestPullRow;
  const state = prStateFromRest(row);
  const headSha = row.head?.sha;
  const currentInput =
    (row.state === "open" || row.state === "closed") &&
    typeof headSha === "string" &&
    headSha !== "" &&
    (typeof row.body === "string" || row.body === null)
      ? reviewInputDigest(headSha, row.body ?? "")
      : undefined;
  return {
    merged: state === "MERGED",
    closed: state === "CLOSED",
    ...(currentInput !== undefined ? { reviewInputDigest: currentInput } : {}),
  };
}

// ── W1-T2419: the COMMENT channel is append-only, unlike the status row above ─────────────────
// The `remudero-review` commit status is last-write-wins, so a repeat write is cheap and this task leaves it
// untouched. A `gh pr comment` APPENDS. The fix is ONE comparison at the single site that writes the comment ({@link
// postReviewCommentGuarded}): refuse to append when the body is BYTE-IDENTICAL to the newest comment already
// standing. NO ledger, NO timer, pacing or backoff — the polling-lockout class this task's rationale explicitly
// refuses — because the discriminator is the verdict's own bytes against a FRESH read of GitHub's live state.
// // Why: #3140 accumulated TEN byte-identical failure comments on one unmoved head, because
// // `reviewPostRefusedFor` (run-task.ts) keys only on `review.post_refused`.

/** One comment {@link fetchNewestPrComment} reads back off GitHub — only the two fields the
 * byte-compare below needs. */
export interface PrCommentRecord {
  body: string;
  created_at: string;
}

/** The NEWEST comment on `prUrl` by `created_at`, or `undefined` when the PR has none or its owner/repo/number
 * cannot be parsed (defensive — not reachable from a real PR URL). REST only (`GET
 * repos/{o}/{r}/issues/{number}/comments`), never GraphQL — the same reasoning as {@link fetchPrLifecycle}, reusing
 * its {@link prLifecycleUrlTarget} parse. `per_page=100`, the single-page simplification its siblings make. */
export function fetchNewestPrComment(prUrl: string, fetch: GhApiFetcher = ghJson): PrCommentRecord | undefined {
  const target = prLifecycleUrlTarget(prUrl);
  if (!target) return undefined;
  const rows = fetch([
    "api",
    `repos/${target.owner}/${target.repo}/issues/${target.number}/comments?per_page=100`,
  ]) as unknown;
  if (!Array.isArray(rows)) return undefined;
  let newest: PrCommentRecord | undefined;
  for (const row of rows as Array<{ body?: unknown; created_at?: unknown }>) {
    if (typeof row?.body !== "string" || typeof row?.created_at !== "string") continue;
    if (!newest || row.created_at > newest.created_at) newest = { body: row.body, created_at: row.created_at };
  }
  return newest;
}

/** THE comparison this task's rationale found nowhere in `src/`: nothing compared the new verdict against the
 * standing one. This is that comparison, and its only home. Byte-exact, never fuzzy, trimmed or hashed — a verdict
 * that changed by one byte is a DIFFERENT verdict and must still post, the distinction the shard's ledger drew
 * between #3140 (ten posts, exit unchanged: a real repeat) and #2434 (18 posts, exits `[0, 1]`: correctly excluded). */
export function isDuplicateReviewComment(newBody: string, standing: PrCommentRecord | undefined): boolean {
  return standing !== undefined && standing.body === newBody;
}

/** Injectable seam for {@link postReviewCommentGuarded} — mirrors every other guarded-write DI
 * shape in this module: real defaults, tests override to avoid a real `gh` spawn/network. */
export interface PostReviewCommentDeps {
  /** Defaults to {@link fetchNewestPrComment} via {@link ghJson}. */
  fetchNewest?: (prUrl: string) => PrCommentRecord | undefined;
  /** Defaults to a real `gh pr comment <prUrl> --body <body>`. */
  postComment?: (prUrl: string, body: string) => void;
}

/** Exported so a unit test can PATH-stub `gh` and drive this exact real invocation directly,
 * mirroring {@link execGhStatusPost}'s own reasoning: it keeps this one-line real wrapper from
 * being permanently uncovered by the diff-coverage ratchet. */
export function execGhPrComment(prUrl: string, body: string): void {
  execFileSync("gh", ["pr", "comment", prUrl, "--body", body], { stdio: "pipe" });
}

/** THE ONE POST SITE for a review-verdict PR comment (W1-T2419) — `runReview`'s only call path from here on,
 * replacing a bare `execFileSync("gh", ["pr", "comment", ...])`. Refuses to append when `body` is byte-identical to
 * the newest standing comment ({@link isDuplicateReviewComment}). Otherwise it posts exactly as the old call did,
 * best-effort failure contract included: a `gh` error is swallowed, since status and ledger already carry the verdict. */
export function postReviewCommentGuarded(
  prUrl: string,
  body: string,
  deps: PostReviewCommentDeps = {},
): { posted: boolean; reason?: "duplicate" | "gh_error" } {
  const fetchNewest = deps.fetchNewest ?? ((url: string) => fetchNewestPrComment(url));
  const postComment = deps.postComment ?? execGhPrComment;
  let standing: PrCommentRecord | undefined;
  try {
    standing = fetchNewest(prUrl);
  } catch {
    standing = undefined; // best-effort read: an unreadable comment list must never block the post below
  }
  if (isDuplicateReviewComment(body, standing)) return { posted: false, reason: "duplicate" };
  try {
    postComment(prUrl, body);
    return { posted: true };
  } catch {
    return { posted: false, reason: "gh_error" }; // best-effort — status + ledger already carry the verdict
  }
}

/** One posting attempt {@link decideReviewStatusPost} judges. */
export interface ReviewStatusPostAttempt {
  headSha: string;
  state: PostableReviewState;
  evidence: ReviewEvidenceStrength;
  /** Exact head+body judged by this attempt. Absent preserves the legacy lifecycle-only gate. */
  reviewInputDigest?: string;
}

export type ReviewStatusDecision = { post: true } | { post: false; reason: string };

/** THE PURE W1-T228 GATE — the falsifier this task exists to prove is a unit fixture, exactly like
 * {@link judgeReview}. Order matters: LIFECYCLE is checked FIRST, because arguing about which
 * verdict is stronger on a PR nobody can act on any more is moot. */
export function decideReviewStatusPost(
  attempt: ReviewStatusPostAttempt,
  prior: PostedReviewStatusRecord | undefined,
  lifecycle: PrLifecycleState,
): ReviewStatusDecision {
  if (lifecycle.merged || lifecycle.closed) {
    return {
      post: false,
      reason:
        `PR is already ${lifecycle.merged ? "merged" : "closed"} — refusing to post remudero-review against ` +
        `a closed lifecycle (W1-T228 lifecycle rule)`,
    };
  }
  if (
    attempt.reviewInputDigest !== undefined &&
    lifecycle.reviewInputDigest !== undefined &&
    attempt.reviewInputDigest !== lifecycle.reviewInputDigest
  ) {
    return {
      post: false,
      reason:
        `review input changed after this verdict started — refusing to overwrite ${attempt.headSha.slice(0, 7)}'s ` +
        `status for a different head+body subject (W1-T2793 subject-freshness rule)`,
    };
  }
  if (
    prior !== undefined &&
    prior.headSha === attempt.headSha &&
    prior.evidence === "executed" &&
    attempt.evidence === "no_evidence"
  ) {
    return {
      post: false,
      reason:
        `refusing to overwrite an executed-evidence ${prior.state} verdict for ${attempt.headSha.slice(0, 7)} ` +
        `with a keyword-only/CAPPED verdict (W1-T228 precedence: evidence outranks its absence)`,
    };
  }
  return { post: true };
}

// ── W1-T228 serialization: an O_EXCL MUTEX (not a singleton guard) ────────

export interface ReviewStatusLockInfo {
  pid: number;
  host: string;
  startedAt: string;
}

export class ReviewStatusLockTimeoutError extends Error {
  constructor(
    public readonly lockPath: string,
    public readonly holder: ReviewStatusLockInfo,
  ) {
    super(
      `timed out waiting for the review-status lock ${lockPath} (held by pid ${holder.pid} on ` +
        `${holder.host}, since ${holder.startedAt})`,
    );
    this.name = "ReviewStatusLockTimeoutError";
  }
}

/** Parse raw lock file contents into a holder record, or `null` for garbage/unshaped JSON
 *  (shared with {@link reclaimStaleLock}'s `parseHolder`). */
function parseReviewStatusLockInfo(raw: string): ReviewStatusLockInfo | null {
  try {
    const o = JSON.parse(raw);
    return typeof o?.pid === "number" ? (o as ReviewStatusLockInfo) : null;
  } catch {
    return null;
  }
}

function reviewStatusLockDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface AcquireReviewStatusLockOpts {
  /** Override the recorded holder identity (tests). Defaults to this process. */
  info?: Partial<ReviewStatusLockInfo>;
  /** Injectable liveness probe (tests). Defaults to {@link defaultIsPidAlive}. */
  isPidAlive?: (pid: number) => boolean;
  /** Poll cadence while a LIVE holder blocks acquisition (tests speed this up). */
  retryMs?: number;
  /** Give up and throw {@link ReviewStatusLockTimeoutError} after this long. */
  timeoutMs?: number;
  /** Called when a reclaim attempt loses the race (see {@link reclaimStaleLock}). Defaults
   *  to a `console.error` trace; tests override it to observe the event directly. */
  onLostReclaim?: (detail: { lockPath: string; reason: string }) => void;
  /** TEST-ONLY seam forwarded to {@link reclaimStaleLock}'s `beforeDelete` — lets a test
   *  force a second reclaimer's whole acquire to complete inside this call's reclaim
   *  window. Never set outside tests. */
  __beforeReclaimDelete?: () => void;
}

export interface ReviewStatusLockHandle {
  readonly path: string;
  /** Remove the lock. Idempotent — safe to call from a finally. */
  release(): void;
}

/** Acquire the per-task review-status MUTEX — the SAME O_EXCL create-or-fail primitive
 * {@link import("./drain-lock.js").acquireDrainLock} and {@link import("./inflight-lock.js").acquireInflightLock}
 * use. Creation is atomic, so two racing acquirers cannot both win it, and a stale lock (holder pid dead, or the file
 * unreadable) is reclaimed via {@link reclaimStaleLock}, whose delete is conditioned on the lock's on-disk identity,
 * so two reclaimers of the SAME dead lock cannot both believe they hold it (W1-T289). Adapted from a SINGLETON GUARD
 * to a MUTEX: where those THROW on finding a live holder, this WAITS (bounded by `timeoutMs`) and retries, because
 * the callers here are N uncoordinated posters that must all eventually run their own read-decide-write. */
export async function acquireReviewStatusLock(
  lockPath: string,
  opts: AcquireReviewStatusLockOpts = {},
): Promise<ReviewStatusLockHandle> {
  const isAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const retryMs = opts.retryMs ?? 50;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const info: ReviewStatusLockInfo = {
    pid: opts.info?.pid ?? process.pid,
    host: opts.info?.host ?? hostname(),
    startedAt: opts.info?.startedAt ?? new Date().toISOString(),
  };
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      // O_EXCL: create-or-fail. Winner writes its identity; there is no TOCTOU gap.
      const fd = openSync(lockPath, "wx");
      writeSync(fd, JSON.stringify(info, null, 2));
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const result = reclaimStaleLock(lockPath, {
        parseHolder: parseReviewStatusLockInfo,
        isStale: (held) => !isAlive(held.pid),
        onLostReclaim: opts.onLostReclaim,
        beforeDelete: opts.__beforeReclaimDelete,
      });
      if (result.outcome === "live") {
        if (Date.now() >= deadline) throw new ReviewStatusLockTimeoutError(lockPath, result.holder);
        await reviewStatusLockDelay(retryMs); // MUTEX: wait + retry, never throw on a live holder
        continue;
      }
      // "missing" | "reclaimed" | "lost" → loop back and retry the atomic create.
    }
  }

  let released = false;
  return {
    path: lockPath,
    release() {
      if (released) return;
      released = true;
      try {
        unlinkSync(lockPath);
      } catch {
        // already gone — idempotent
      }
    },
  };
}

// ── W1-T228: the single guarded post site ─────────────────────────────────

export interface PostReviewStatusGuardedOpts {
  owner: string;
  repo: string;
  sha: string;
  state: PostableReviewState;
  description?: string;
  /** The PR the lock/ledger key off — every real caller already keys its
   * `review.posted` ledger lines by this same id (the task id, or the
   * `dep-review-PR<n>`/`PR-<n>` synthetic ids `run-task.ts` falls back to). */
  taskId: string;
  evidence: ReviewEvidenceStrength;
  ledgerPath: string;
  runId: string;
  /** Optional review-input attribution copied onto refusal/failure rows. Callers that know the
   * PR body supply both fields so retry dedup can distinguish changed input on an unchanged sha. */
  prUrl?: string;
  reviewInputDigest?: string;
  reviewDecisionDigest?: string;
  reviewEngineRevision?: string;
  evaluatorProvenance?: ReviewEvaluatorProvenance;
  /** Fresh lifecycle read for THIS attempt — real callers pass `() => fetchPrLifecycle(prUrl)`,
   * tests inject a fake. Called INSIDE the lock, never before (see the module doc above). */
  fetchLifecycle: () => PrLifecycleState;
  /** Injected raw poster for tests. Defaults to {@link postReviewStatus}, which already retries a
   *  TRANSIENT gh error internally (rule (iv) above). May return a Promise, as the default does, or
   *  `void`, so existing sync test fakes keep working. */
  post?: (o: {
    owner: string;
    repo: string;
    sha: string;
    state: PostableReviewState;
    description?: string;
  }) => void | Promise<void>;
  lockOpts?: AcquireReviewStatusLockOpts;
}

export interface PostReviewStatusGuardedResult {
  posted: boolean;
  conflict?: boolean;
  replayed?: boolean;
  effectiveState?: ReviewState;
  /** Present only when `posted` is false — either {@link decideReviewStatusPost}
   * refused the write (see `review.post_refused`), or the post itself failed
   * after retries/as a permanent error (see `review.post_failed`, W1-T135). */
  reason?: string;
}

/** THE single call path for posting `remudero-review` from here on (W1-T228). Acquires the per-task
 * lock, reads the ledger and live PR lifecycle FRESH inside it, decides via the pure {@link decideReviewStatusPost},
 * and either posts or refuses. EVERY attempt is ledgered, refusals included (`review.post_refused`), so a refused
 * write leaves a trace instead of silent blindness. W1-T135: a post that still THROWS — transient retries exhausted
 * inside {@link postReviewStatus}, or a permanent error it never retried — is caught HERE, ledgered as
 * `review.post_failed` carrying the verdict that could not be posted, and returned as `{posted:false}` like an
 * ordinary refusal, so every caller's existing
 * handling degrades gracefully instead of the run crashing. */
export async function postReviewStatusGuarded(
  opts: PostReviewStatusGuardedOpts,
): Promise<PostReviewStatusGuardedResult> {
  const post = opts.post ?? postReviewStatus;
  const lockDir = join(dirname(opts.ledgerPath), "review-status-locks");
  const lockPath = join(lockDir, `${opts.taskId}.lock`);
  const handle = await acquireReviewStatusLock(lockPath, opts.lockOpts);
  try {
    // READ BEFORE WRITE, INSIDE THE LOCK — a read taken before acquiring the
    // lock would leave open exactly the TOCTOU gap the lock exists to close.
    const lines = readLedgerLines(opts.ledgerPath);
    const prior =
      opts.prUrl !== undefined && opts.reviewInputDigest !== undefined
        ? lastPostedReviewStatusForInput(lines, opts.taskId, opts.prUrl, opts.sha, opts.reviewInputDigest)
        : lastPostedReviewStatusFromLedger(lines, opts.taskId);
    const lifecycle = opts.fetchLifecycle();
    const priorDecision = opts.prUrl !== undefined && opts.reviewDecisionDigest !== undefined
      ? lastReviewDecisionTerminal(lines, opts.taskId, opts.prUrl, opts.reviewDecisionDigest)
      : undefined;
    if (!lifecycle.merged && !lifecycle.closed && priorDecision) {
      if (priorDecision.state === opts.state) {
        return { posted: false, replayed: true, effectiveState: priorDecision.state, reason: "terminal verdict already exists for this review decision" };
      }
      const reason = `contradictory ${opts.state} attempted after terminal ${priorDecision.state} for review decision ${opts.reviewDecisionDigest}`;
      appendLedger(opts.ledgerPath, {
        run_id: opts.runId, task_id: opts.taskId, step: "review.verdict_conflict",
        pr_url: opts.prUrl, head_sha: opts.sha, review_decision_digest: opts.reviewDecisionDigest,
        ...(opts.reviewEngineRevision !== undefined ? { review_engine_revision: opts.reviewEngineRevision } : {}),
        prior_state: priorDecision.state, attempted_state: opts.state,
        prior_evaluator: priorDecision.evaluatorProvenance,
        attempted_evaluator: opts.evaluatorProvenance ?? null,
      });
      try {
        await post({ owner: opts.owner, repo: opts.repo, sha: opts.sha, state: "failure", description: "remudero-review: conflicting verdicts for identical decision input — operator adjudication required" });
        return { posted: true, conflict: true, effectiveState: "failure", reason };
      } catch (error) {
        appendLedger(opts.ledgerPath, {
          run_id: opts.runId, task_id: opts.taskId, step: "review.post_failed", head_sha: opts.sha,
          attempted_state: "failure", review_decision_digest: opts.reviewDecisionDigest, error: String(error),
          ...(opts.reviewEngineRevision !== undefined ? { review_engine_revision: opts.reviewEngineRevision } : {}),
        });
      }
      return { posted: false, conflict: true, effectiveState: "failure", reason };
    }
    const decision = decideReviewStatusPost(
      {
        headSha: opts.sha,
        state: opts.state,
        evidence: opts.evidence,
        ...(opts.reviewInputDigest !== undefined ? { reviewInputDigest: opts.reviewInputDigest } : {}),
      },
      prior,
      lifecycle,
    );
    if (!decision.post) {
      appendLedger(opts.ledgerPath, {
        run_id: opts.runId,
        task_id: opts.taskId,
        step: "review.post_refused",
        head_sha: opts.sha,
        attempted_state: opts.state,
        evidence: opts.evidence,
        reason: decision.reason,
        ...(opts.prUrl !== undefined ? { pr_url: opts.prUrl } : {}),
        ...(opts.reviewInputDigest !== undefined ? { review_input_digest: opts.reviewInputDigest } : {}),
        ...(opts.reviewEngineRevision !== undefined ? { review_engine_revision: opts.reviewEngineRevision } : {}),
      });
      return { posted: false, reason: decision.reason };
    }
    try {
      await post({ owner: opts.owner, repo: opts.repo, sha: opts.sha, state: opts.state, description: opts.description });
    } catch (e) {
      // W1-T135 exhaustion path: ledger-and-continue, never crash the run.
      const message = e instanceof Error ? e.message : String(e);
      appendLedger(opts.ledgerPath, {
        run_id: opts.runId,
        task_id: opts.taskId,
        step: "review.post_failed",
        head_sha: opts.sha,
        attempted_state: opts.state,
        evidence: opts.evidence,
        description: opts.description,
        error: message,
        ...(opts.prUrl !== undefined ? { pr_url: opts.prUrl } : {}),
        ...(opts.reviewInputDigest !== undefined ? { review_input_digest: opts.reviewInputDigest } : {}),
        ...(opts.reviewEngineRevision !== undefined ? { review_engine_revision: opts.reviewEngineRevision } : {}),
      });
      return {
        posted: false,
        reason: `posting remudero-review failed and was not applied (see the review.post_failed ledger line): ${message}`,
      };
    }
    return { posted: true };
  } finally {
    handle.release();
  }
}

// ── W1-T913: post remudero-review=pending at DETECTION, before judging ──────

export interface PostReviewPendingOpts {
  owner: string;
  repo: string;
  sha: string;
  /** The PR the ledger/lock key off — same convention as {@link PostReviewStatusGuardedOpts.taskId}. */
  taskId: string;
  runId: string;
  ledgerPath: string;
  prUrl?: string;
  reviewInputDigest?: string;
  reviewEngineRevision?: string;
  fetchLifecycle: () => PrLifecycleState;
  /** Injected raw poster (tests) — forwarded to {@link postReviewStatusGuarded} unchanged. */
  post?: PostReviewStatusGuardedOpts["post"];
  lockOpts?: AcquireReviewStatusLockOpts;
  /** Injectable only so the durable owner record is deterministic in tests. */
  ownerIdentity?: { pid: number; startedAt: string };
}

export interface PostReviewPendingResult {
  posted: boolean;
  reason?: string;
}

/** THE ONE PENDING-POST ENTRY POINT (design (a)/(d)): every detector — `runReview`'s own start, `reviewCommand`'s own
 * start, and transitively the sweep's post-review dispatch — calls this ONCE, at DETECTION, before the worktree,
 * proof and reviewer-spawn work a review's latency is spent on. It goes through {@link postReviewStatusGuarded}, so
 * the W1-T135 retry, the W1-T228 lifecycle refusal and the W1-T203 reviewer identity all apply. TWO REFUSALS, BOTH
 * DECIDED HERE before touching the lock or network. (1) NEVER REGRESS A TERMINAL VERDICT FOR THE SAME REVIEW INPUT TO
 * PENDING: {@link decideReviewStatusPost}'s precedence only refuses `executed -> no_evidence`, and a pending attempt
 * is always `no_evidence`, so a prior `no_evidence` TERMINAL verdict for this head would sail through; a changed body
 * is a fresh input and may post again. (2) IDEMPOTENT PER INPUT: a `review.pending_posted` line for this exact
 * head+body digest is a no-op, and a dead owner's stuck pending is re-driven by the sweep recognising staleness
 * rather than by racing. The posted status carries the posting `run_id`, which is what sweep.ts's
 * `OpenPrView.reviewPendingSince` producer derives its staleness clock from. */
export async function postReviewPending(opts: PostReviewPendingOpts): Promise<PostReviewPendingResult> {
  const lines = readLedgerLines(opts.ledgerPath);
  const hasInputIdentity = opts.prUrl !== undefined && opts.reviewInputDigest !== undefined;
  const priorTerminal = hasInputIdentity
    ? lastPostedReviewStatusForInput(lines, opts.taskId, opts.prUrl!, opts.sha, opts.reviewInputDigest!)
    : lastPostedReviewStatusFromLedger(lines, opts.taskId);
  if (priorTerminal && priorTerminal.headSha === opts.sha) {
    return {
      posted: false,
      reason:
        `a terminal ${priorTerminal.state} verdict is already posted for ${opts.sha.slice(0, 7)} — never ` +
        "regressing it to pending (W1-T913)",
    };
  }
  let priorPending = hasInputIdentity ? undefined : lastPendingReviewStatusFromLedger(lines, opts.taskId);
  if (hasInputIdentity) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (
        line.step !== "review.pending_posted" ||
        line.task_id !== opts.taskId ||
        line.pr_url !== opts.prUrl ||
        line.head_sha !== opts.sha ||
        line.review_input_digest !== opts.reviewInputDigest
      ) {
        continue;
      }
      priorPending = pendingReviewStatusRecord(line);
      break;
    }
  }
  if (priorPending && priorPending.headSha === opts.sha) {
    return {
      posted: false,
      reason:
        `remudero-review is already pending for ${opts.sha.slice(0, 7)} (owned by run ${priorPending.runId}) ` +
        "— no-op (W1-T913 idempotent-per-input)",
    };
  }
  const description = `remudero-review: review in progress (owned by run ${opts.runId})`.slice(0, 140);
  const ownerIdentity = opts.ownerIdentity ?? { pid: process.pid, startedAt: new Date().toISOString() };
  const result = await postReviewStatusGuarded({
    owner: opts.owner,
    repo: opts.repo,
    sha: opts.sha,
    state: "pending",
    description,
    taskId: opts.taskId,
    // A pending attempt has, by construction, observed nothing yet — always `no_evidence`.
    evidence: "no_evidence",
    ledgerPath: opts.ledgerPath,
    runId: opts.runId,
    prUrl: opts.prUrl,
    reviewInputDigest: opts.reviewInputDigest,
    reviewEngineRevision: opts.reviewEngineRevision,
    fetchLifecycle: opts.fetchLifecycle,
    post: opts.post,
    lockOpts: opts.lockOpts,
  });
  if (result.posted) {
    appendLedger(opts.ledgerPath, {
      run_id: opts.runId,
      task_id: opts.taskId,
      step: "review.pending_posted",
      head_sha: opts.sha,
      owner_pid: ownerIdentity.pid,
      owner_started_at: ownerIdentity.startedAt,
      ...(opts.prUrl !== undefined ? { pr_url: opts.prUrl } : {}),
      ...(opts.reviewInputDigest !== undefined ? { review_input_digest: opts.reviewInputDigest } : {}),
      ...(opts.reviewEngineRevision !== undefined ? { review_engine_revision: opts.reviewEngineRevision } : {}),
    });
  }
  return result;
}
