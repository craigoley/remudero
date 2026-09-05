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

/**
 * The JUDGE (MASTER-PLAN §12 rule 4 / rule 3B; task W1-T1C).
 *
 * Standing rule 4: green checks are NOT evidence. `ci` proves the code typechecks
 * and its tests pass; it says nothing about whether the task's ACCEPTANCE CRITERIA
 * were met. This module is the second half of the merge contract: after ci goes
 * green a FRESH-context REVIEW worker (never the implementer's session; read-only
 * tools + gh) verdicts each criterion against its stated PROOF and posts a commit
 * status `remudero-review`.
 *
 * THE VERDICT LOGIC IS A PURE FUNCTION ({@link judgeReview}) so the falsifier —
 * "does the reviewer actually FAIL a test-passing-but-acceptance-ignoring diff?"
 * — is a UNIT FIXTURE, proven before any live gate depends on it. The pure layer
 * is the mechanical FLOOR: it catches the failure modes that need no LLM (a proof
 * never pasted into the report; tests that assert nothing). A semantic verdict
 * from the LLM reviewer may only DOWNGRADE a criterion to failure, never rescue an
 * unpasted proof — proof must be pasted, not vibed.
 *
 * This module NEVER edits code and exposes no write path: the reviewer is
 * read-only + gh by construction (acceptance #3). It does NOT touch branch
 * protection — remudero-review is POSTED here but made REQUIRED by W1-T1D.
 */

/** The commit-status context string the merge gate keys on. Never change casually. */
export const REVIEW_CONTEXT = "remudero-review";

/** A commit-status state. GitHub statuses also allow `pending`/`error`; the gate uses these two. */
export type ReviewState = "success" | "failure";

/**
 * W1-T913: the wider range {@link postReviewStatus}/{@link postReviewStatusGuarded} may POST —
 * {@link ReviewState} widened with `pending`, kept as a SEPARATE type on purpose. `ReviewState`
 * is a JUDGED verdict (`ReviewVerdict.state`/`floorState`, `judgeReview`'s whole output shape) and
 * must never admit "pending" — the judge computes a verdict, it never computes "in progress".
 * `PostableReviewState` is strictly the POSTING surface: the DETECTION-time pending post this task
 * adds is a fact about timing (a review has started, not yet finished), never a verdict, so it
 * gets its own type rather than widening `ReviewState` everywhere that type is already used for
 * judged-verdict exhaustiveness.
 */
export type PostableReviewState = ReviewState | "pending";

/**
 * Stable identity for the material a review actually judges. The PR head binds the code/diff and
 * the exact body binds the authored acceptance claims and evidence. A new commit OR body edit
 * therefore earns a fresh retry budget, while comments, labels and other `updated_at` churn do
 * not. The bounded engine revision rearms the same evidence only after a material reviewer-contract
 * change; it is deliberately independent of boot commits, provider choice and model sampling. The
 * version prefix makes a future input expansion an explicit reset instead of silently colliding
 * with rows written under this contract.
 */
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

/**
 * Observed outcome of executing a criterion's proof against the PR head (W1-T65,
 * ratifies P15). Recorded per-criterion on {@link CriterionVerdict} and surfaced on
 * the `review.posted` ledger line + console summary (run-task.ts) so an OBSERVED
 * verdict is legible vs a KEYWORD one:
 *   executed_pass  — the proof's whitelisted test/grep ran and passed/matched on
 *                     the head. MEETS the criterion regardless of report keywords
 *                     (kills the #100 false-block: repo-state truth, unclaimed).
 *   executed_fail  — it ran and FAILED / found no match. OVERRIDES any keyword
 *                     coverage (kills the W1-T51 false-pass: a claim the repo
 *                     state refutes never merges on prose alone).
 *   not_executable — the proof is free prose (or no head checkout dir was given).
 *                     The keyword floor is UNCHANGED — this is the default for
 *                     every caller that predates this task.
 *   exec_error     — the whitelisted check threw or timed out. DEGRADES to the
 *                     keyword floor verdict computed alongside it, verbatim —
 *                     an environment hiccup must never silently hard-fail or
 *                     stall the fleet (Standing rule: no absent-check deadlock).
 *   executed_stale — (W1-T273, extended to `unit test:` proofs by W1-T362) a
 *                     proof matched/passed on the head, but the SAME check
 *                     ALSO matches/passes on the PR's MERGE-BASE — i.e. it
 *                     would have exited 0 before the task's work ever landed,
 *                     so it discriminates nothing (W1-T267's fifth criterion,
 *                     verbatim: `workerKeychainPaths` matched two unrelated
 *                     hits on the pre-work commit and was recorded as
 *                     substantiated regardless). A DOWNGRADE, not a failure —
 *                     see {@link preexistingProofHits}'s doc — it withdraws
 *                     the proof's positive override and falls back to the
 *                     keyword floor verbatim, exactly like `exec_error`
 *                     degrades, but recorded under its own name because the
 *                     cause is a proof-authoring gap, not an environment
 *                     hiccup. A `unit test:` proof that is simply ABSENT at
 *                     the base (the common, healthy TDD case — the whole
 *                     point of a forward-referencing test) or that fails
 *                     there is the OPPOSITE of this: it discriminates and
 *                     stays `executed_pass`, per W1-T362.
 *   base_unreadable — (W1-T460) the proof passed on the head, a base tree
 *                     DOES exist, but THIS proof's base blob could not be
 *                     read, so the staleness question was never actually
 *                     asked for it. Before W1-T460 the unread blob simply
 *                     produced an empty base file, the base grep found
 *                     nothing, and that silence was scored `discriminates`
 *                     ⇒ `executed_pass` — a read that FAILED reported as a
 *                     read that said NO, with the failure direction toward
 *                     CREDIT. Degrades to the keyword floor verbatim, like
 *                     `executed_stale`/`exec_error`, under its own name
 *                     because the cause is neither an authoring gap nor a
 *                     head-side hiccup. DISTINCT FROM the whole-base gap
 *                     (`base_unknown`, which keeps `executed_pass`): there,
 *                     no base tree exists and no proof could be checked;
 *                     here the tree exists and SIBLING proofs were genuinely
 *                     checked against it, so exempting this one is a
 *                     per-proof gap wearing a global gap's clothes.
 *   not_yet_built   — (W1-T456) an exact-path `unit test:` proof names a file that does not
 *                     exist on the PR head, but the SAME diff declares that exact path in a
 *                     plan shard's own `files:` list — a FORWARD REFERENCE, not a failure. Before
 *                     this, the missing file made `node --test` exit nonzero ("Could not find
 *                     '<path>'"), which this module read as a genuine `executed_fail` — HARD
 *                     BLOCKING a plan-filing PR whose acceptance criteria (quoting the task it is
 *                     filing) cite a test the IMPLEMENTATION, a later PR, will create. Degrades to
 *                     the keyword floor verbatim, exactly like `exec_error`/`executed_stale`
 *                     degrade, under its OWN name because the cause is neither an authoring gap
 *                     nor an environment hiccup — see {@link shardDeclaredFilesInDiff}'s doc.
 *                     NEVER assigned when the named path is simply absent and UNDECLARED — that
 *                     stays `executed_fail` (W1-T72's test-theater guard, unchanged): a forward
 *                     reference is a POSITIVE claim from the diff itself, never inferred from
 *                     absence alone.
 *                     (W1-T2737) ALSO assigned to a HOUSE-dialect `grep:` proof, on the same
 *                     terms plus one: its target path is declared in the diff's shard `files:`,
 *                     the executor already reported a failure (so "the symbol is absent" is
 *                     MEASURED, not predicted), and the diff changes no source
 *                     ({@link ProofExecContext.planOnlyDiff}). That third condition is not
 *                     decoration — see its doc for why the `unit test:` arm does not need one.
 *                     Reason: `callSiteViolations` (task-linter.ts) MANDATES exactly this proof
 *                     shape for a task creating a `src/` module, and grading the mandated remedy
 *                     `executed_fail` made the two gates unsatisfiable at once.
 *   stale_self_path — (W1-T1071) a `grep:` proof went `"stale"` (see `executed_stale` above)
 *                     and its target is BOTH a plan-shard path ({@link SHARD_PATH_RE}) AND a path
 *                     this diff's own task declares SOMETHING ELSE beside — the shape a proof
 *                     takes when it was authored to discriminate the FILING PR (grepping the
 *                     shard's own rationale text into its own plan/tasks.d/*.yaml) and is now
 *                     being read on the PR that BUILDS the task: the shard already merged, so the
 *                     same pattern matches the merge-base too, and `executed_stale`'s ordinary
 *                     degrade-to-keyword-floor would let a report that never engages the real
 *                     behaviour slip through on prose alone. UNLIKE every other stale/degrade
 *                     outcome above, this one is NOT a degrade: `met` is forced `false`
 *                     regardless of keyword coverage — a REFUSAL, named, telling the author the
 *                     proof was filing-time and must be rewritten to name the behaviour the diff
 *                     now builds. Reachable ONLY when {@link ProofExecContext.forwardReferenceFiles}
 *                     names a path other than the proof's own target — BY CONSTRUCTION, not by an
 *                     id allowlist, so a shard whose `files:` is nothing but its own plan path
 *                     (no code ever follows it) is exempt without being named: it has no OTHER
 *                     declared path, so this branch is never reached for it, and its self-path
 *                     grep keeps discriminating exactly as it always has. A grep proof whose
 *                     target is not a plan-shard path — an ordinary code grep gone stale for
 *                     unrelated reasons — is UNTOUCHED and keeps degrading to `executed_stale`.
 */
/**
 * WHY a criterion produced no executed outcome. Diagnostic only — it never affects `met`, `state`,
 * the keyword floor, or whether a verdict is capped. It exists so a CAPPED `0/N` says WHICH KIND it
 * is instead of collapsing four different causes into one reassuring green.
 *
 *   no-dialect          — the proof carries NO house-dialect prefix at all (ordinary prose). This
 *                          is the EXPECTED shape for a non-mechanical claim, never itself a defect.
 *   dialect-parse-error — (W1-T305) the proof STARTS with a house-dialect label (`grep:`/
 *                          `unit test:`) but its body fails to parse into a runnable check (e.g. a
 *                          `grep:` with no `in <path>` clause, a path-traversal/glob target, or a
 *                          `unit test:` path escaping the checkout). Distinct from `no-dialect` on
 *                          purpose: this proof's author WROTE an executable-check intent and got the
 *                          syntax wrong — an AUTHORING ERROR, not a prose claim that never asked to
 *                          be mechanically checked. Today's `not_executable` alone made these two
 *                          causes indistinguishable from the outside (design (2), the measurement
 *                          this task is filed against). Never assigned to a `demonstration:` proof —
 *                          that dialect is deliberately never executable, by design (W1-T277), which
 *                          is not an authoring error.
 *   prose-no-match      — the proof DID parse (a `unit test:` name-filtered check ran to
 *                          completion) and resolved to zero candidates, but its body reads as a
 *                          PROSE paraphrase rather than a fabricated bare test name (W1-T161/#349) —
 *                          degrades to the keyword floor rather than a false `executed_fail`.
 *   exec-error          — the whitelisted check threw or timed out (or a `unit test:`/`grep:`
 *                          proof's named PATH is simply absent on the checkout).
 *   runtime-broken       — (W1-T1077) a PURE-PATH (non-name-filtered) `unit test:` proof's file
 *                          DID exist and DID get spawned, but its TAP stdout's only `not ok` line
 *                          names the FILE ITSELF ({@link isFileWrapperResultName}) — no real
 *                          subtest inside it ever reported a verdict. A broken `--import` loader, an
 *                          uncaught module-load error: the run never reached a conclusion about the
 *                          CRITERION, so it is not evidence the criterion is unmet. Distinct from the
 *                          generic `exec-error` above (a timeout, ENOENT, or a genuinely absent path)
 *                          because THIS cause is diagnosable from the stream already in hand — see
 *                          {@link execWhitelistedProof}'s doc for the measured TAP shapes that tell
 *                          this apart from a genuine named-test failure (which stays `executed_fail`,
 *                          untouched, carrying no `proof_skip` at all).
 *   incomplete-run       — (W1-T2740) a PURE-PATH `unit test:` proof's run emitted at least one
 *                          REAL subtest result and then stopped WITHOUT node's trailing
 *                          `# duration_ms` summary ({@link hasFinalSummary}) — the one completion
 *                          signal this file already trusts for the name-filtered branch. The run
 *                          was cut off (a proof-timeout kill node reaped with numeric status 1,
 *                          an external SIGTERM, an OOM); its passing subtests are real but its
 *                          verdict about the CRITERION was never reached, so it degrades to the
 *                          keyword floor instead of minting an `executed_fail` that would override
 *                          it. Distinct from `runtime-broken` (a run that COMPLETED and printed a
 *                          summary, whose only `not ok` names the file wrapper) and from
 *                          `exec-error` (nothing to diagnose from the stream). A stream carrying a
 *                          REAL failing subtest is NOT this — an observed failure is evidence
 *                          whether or not the run later finished, and stays `executed_fail`.
 *   no-exec-context      — no PR-head checkout was supplied at all; execution was never attempted
 *                          for ANY criterion.
 *   forward-reference    — (W1-T456) an exact-path `unit test:` proof names a file ABSENT on the
 *                          PR head, but that SAME path is declared in a plan-shard's own `files:`
 *                          list ADDED by this very diff — a filing PR citing the acceptance
 *                          criteria of the task it is filing, whose test the IMPLEMENTATION (a
 *                          later PR) will create. Distinct from `exec-error` (an authoring/
 *                          environment gap): the proof named exactly what the shard promises,
 *                          never executed, keyword floor applied. See {@link
 *                          shardDeclaredFilesInDiff}'s doc for why the diff itself, not a
 *                          resolved task id, is the source of truth here — a filing PR
 *                          deliberately carries no `Remudero-Task:` trailer (#1527), so there is
 *                          no task id to resolve `files:` from.
 */
export type ProofSkipReason =
  | "no-dialect"
  | "dialect-parse-error"
  | "prose-no-match"
  | "exec-error"
  | "runtime-broken"
  | "incomplete-run"
  | "no-exec-context"
  | "forward-reference";

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
  /**
   * W1-T178 (verdict stability): `met` as computed by the mechanical/executed
   * floor, BEFORE any semantic downgrade is applied — the DETERMINISTIC part of
   * this criterion's verdict. Equal to `met` whenever semantic review didn't
   * force a downgrade. Populated by {@link judgeCriterion}; optional so every
   * OTHER `CriterionVerdict` literal in the codebase (ledger-reconstructed
   * placeholders in run-task.ts/sweep.ts, which never carry a semantic layer to
   * begin with) needs no update — {@link applyVerdictStability} falls back to
   * `met` when it is absent.
   */
  floorMet?: boolean;
  /**
   * W1-T166: copied verbatim from the judged {@link AcceptanceCriterion.holdout}.
   * `judgeReview`'s `state`/`floorState` fold a holdout criterion in exactly like
   * any other (the reviewer judges visible AND holdout); this flag exists so a
   * CALLER can still tell the two apart — {@link visibleCriteria} reads it to keep
   * a holdout criterion's claim/proof text out of every worker-facing surface
   * (the fix rung's unmet-criteria block, the `review.posted` ledger's
   * `unmet_criteria`/`reasons`, the posted commit-status description), while the
   * PASS/FAIL verdict itself never depends on which surface reads it.
   */
  holdout?: boolean;
}

/** The evidence the JUDGE reads: the PR diff, the implement REPORT, optional LLM verdicts. */
/**
 * The two reasons a report can fail to be the PR body, which are NOT the same fact and do not have
 * the same remedy. `never-fetched` means this code path never asked for the body -- the common
 * case, and nothing is wrong. `fetch-failed` means it asked and the read failed -- which has never
 * once been observed here. See {@link ReviewEvidence.reportSubstituteCause}.
 */
export type ReportSubstituteCause =
  /** No fetch was attempted. `fixMode` names the mode that does not read the body, when in hand: a
   *  reader who sees the mode can act; one told a fetch failed cannot. */
  | { kind: "never-fetched"; fixMode?: string }
  /** A fetch was attempted and threw. Distinct from the above BY CONSTRUCTION so the wording can
   *  stop implying this is what happened. */
  | { kind: "fetch-failed" };

export interface ReviewEvidence {
  /** The unified PR diff (as `gh pr diff` / `git diff` would produce). */
  diff: string;
  /** The implement worker's REPORT text (where proofs are pasted). */
  report: string;
  /**
   * (W1-T1100) True when `report` is NOT the PR body — `runTaskBody` (run-task.js) substitutes
   * the worker's own chat text after a failed `fetchPrBodyFn` read, so a `gh` outage degrades to
   * judging the worker's narrative rather than stalling the review (deliberate; that fallback is
   * NOT what this flag changes). Left unmarked, the substitute used to reach every consumer
   * exactly like a real body, with two OPPOSITE failure shapes measured live on #2395: {@link
   * bodyContradictsDiff} fails CLOSED, manufacturing a contradiction from prose that was never a
   * claim about the changeset, while `judgeCriterion`'s keyword-coverage floor fails OPEN, scoring
   * the worker's own narrative HIGHER than an honest body because it describes its own change in
   * the proof's own vocabulary. Both consumers read this flag below and refuse to judge a
   * substitute as though it were the body. Absent/false ⇒ byte-identical to pre-W1-T1100
   * behaviour — every caller/fixture that predates this task keeps trusting `report` as the real
   * body, exactly as it does today.
   */
  reportIsSubstitute?: boolean;
  /**
   * WHY `report` is not the body. The boolean above keeps its single meaning -- THIS IS NOT THE PR
   * BODY -- and every consumer that refuses to judge a substitute is right to read it that way;
   * this sibling exists so the REFUSAL TEXT can say which of two very different facts it rests on,
   * without widening the flag every consumer already reads.
   *
   * MEASURED 2026-08-25: the refusal said "substituted after a failed body fetch" on three rows and
   * no fetch had failed on any of them. `review.body_fetch_error` and `fix.body_fetch_error` both
   * read ZERO across 27 archives and 258,784 rows -- neither has ever fired on any host. The real
   * mechanism is that the fix rung fetches the body ONLY in `body-coverage` mode and defaults the
   * flag true for the other three, so on `ci-log`, `reviewer-unmet` and `merge-conflict` no fetch
   * is attempted at all. That string cost an operator recon hunting a transient GitHub read failure
   * and a body-size bound, and refuted both.
   *
   * Absent means the message stays silent on the cause rather than guessing one, which is the state
   * every caller predating this change gets.
   */
  reportSubstituteCause?: ReportSubstituteCause;
  /**
   * Optional per-criterion semantic verdicts from the fresh LLM reviewer,
   * index-aligned to the criteria list. `false` FORCES that criterion to fail;
   * `true`/`undefined` defer to the mechanical floor. Semantic can only
   * downgrade — it can never upgrade an unpasted proof to a pass.
   */
  semantic?: (boolean | undefined)[];
  /**
   * (W1-T2263) Optional per-criterion bounded clause the fresh reviewer attached to a FAIL
   * line — see {@link parseReviewerVerdictClauses}. Index-aligned to `criteria`/`semantic`,
   * same as it. Consulted by {@link judgeCriterion} ONLY where `semantic[i] === false`; absent
   * or `undefined` at an index leaves that criterion's downgrade reason exactly as it reads
   * with no clause. Never a second reviewer call — the clause is captured off the SAME
   * transcript {@link parseReviewerVerdicts} already parses `semantic` from.
   */
  semanticClauses?: (string | undefined)[];
  /**
   * The checkout dir whitelisted proofs execute in — MUST be the PR HEAD sha (the
   * runner's own worktree when judging its own run; a fresh checkout fetched at
   * the head sha on the `rmd review` path). NEVER the operator's working checkout
   * (HEAD DISCIPLINE, W1-T65 design). Absent ⇒ proof execution is skipped for
   * every criterion (`proof_exec` is `not_executable` throughout) — the keyword
   * floor is byte-identical to pre-W1-T65 behavior, which is what every caller
   * that predates this task (and every fixture below) gets by default.
   */
  headCheckoutDir?: string;
  /**
   * (W1-T273) A checkout of the PR's MERGE-BASE — the commit the PR branched
   * from, BEFORE the task's own work landed. Optional and independent of
   * `headCheckoutDir`'s own presence: the caller reaches it with one
   * `git merge-base` over a checkout the review already has (no new gateway,
   * no new network call — design doc, plan/tasks.d/W1-T273-*.yaml). Consulted
   * ONLY to test a `grep:` proof's pattern for non-discrimination (see
   * {@link preexistingProofHits}); absent ⇒ that check never runs and every
   * grep proof that passes on the head is `executed_pass` exactly as it was
   * before this task — byte-identical to every caller/fixture that predates it.
   */
  baseCheckoutDir?: string;
  /**
   * (W1-T460) The repo-relative paths whose base blob could NOT be read while `baseCheckoutDir`
   * was built — a GENUINE read failure (ENOBUFS on an oversized blob, a write that failed), never
   * the ordinary "absent at the base" forward reference, which is the healthy case and stays
   * silently carved out. Distinct from `baseCheckoutDir` being absent altogether: that is a GLOBAL
   * gap where no proof could be checked, whereas each path here names a proof that was exempted
   * while its SIBLINGS were genuinely checked against the very same base tree. Absent/empty ⇒
   * byte-identical to pre-W1-T460 behaviour.
   */
  baseUnreadablePaths?: ReadonlySet<string>;
  /**
   * (R-11) `true` when `baseCheckoutDir` is a REAL CHECKOUT of the merge-base — a detached git
   * worktree `buildBaseProofDir` (run-task.ts) added at that commit — rather than the blob-only
   * fallback it materialises when a worktree cannot be created. A `unit test:` proof can only be
   * re-run honestly in the former: in a directory holding nothing but the blobs `grep:` proofs
   * name, `node --test` finds no file and exits 1 with empty stdout, which the classifier used to
   * read as "did not pass at base ⇒ discriminates" and certify `executed_pass` on a test that
   * passes identically at both commits. FAILS CLOSED: absent (every caller that predates R-11)
   * ⇒ a `unit test:` proof's base outcome is `base_unknown`, never `discriminates`; `grep:` proofs
   * are unaffected either way, since a blob IS the file grep reads.
   */
  baseIsCheckout?: boolean;
  /**
   * Injected proof executor. Real callers omit this — {@link execWhitelistedProof}
   * (the real, whitelist-bounded shell-out) is the default. Tests inject a fake so
   * override/degrade semantics are proven without touching the filesystem or a
   * shell (acceptance: "unit test over an injected executor"). Also the executor
   * {@link preexistingProofHits} reuses against `baseCheckoutDir` — the SAME
   * function, just a different `cwd`, so an injected fake needs no special-casing
   * to cover both.
   */
  execProof?: ProofExecutor;
  /**
   * W1-T322 (SHIPS-UNWIRED advisory floor, design (ii)(b)): the task's DECLARED `files:` scope
   * (plan.ts `Task.files`) — used ONLY for the INVERSE-SCOPE advisory, the direction {@link
   * "../run-task.js".scopeGuardOutOfScopeFiles} cannot see (that guard flags a diff touching an
   * UNDECLARED file; this flags a declared file the diff never touched at all). Advisory only —
   * never affects `state`. Absent/empty ⇒ the inverse-scope check never fires (nothing declared,
   * nothing to compare against), matching every caller/fixture that predates this task.
   */
  taskDeclaredFiles?: string[];
  /**
   * W1-T322 (design (ii)(a)): task ids currently OPEN in the loaded plan (status not
   * `merged`/`done`) — consulted ONLY to verify a report's `SHIPS-UNWIRED: <id>` marker names a
   * real, still-open task before honouring it (an id that is absent from the plan, or already
   * merged/done, does not excuse the advisory). FAIL-CLOSED: absent ⇒ no marker can ever be
   * honoured (every claimed id reads as unverifiable), the same direction every other structural
   * check in this file defaults toward.
   */
  openTaskIds?: ReadonlySet<string>;
  /**
   * W1-T458 (the untrailered-implementation gap): task id → that OPEN task's declared `files:`
   * scope, for EVERY open task in the loaded plan — a richer sibling of {@link openTaskIds} (ids
   * only, no files), consulted ONLY to name which open task's scope an UNRESOLVED diff overlaps.
   * "Unresolved" is read off {@link taskDeclaredFiles} being absent/empty — the SAME resolved-task
   * signal {@link inverseScopeUntouchedFiles}/{@link scopeViolationFiles} already fail-closed on —
   * NEVER off whether the report/diff carries a `Remudero-Task:` trailer. That distinction is
   * load-bearing (#1731's rationale): `test/fixtures/golden-verdicts/scope-creep` injects {@link
   * taskDeclaredFiles} directly and carries no trailer in any fixture file, so a trigger keyed on
   * "no trailer in the body" would misfire on it and shift `golden.yaml`; keyed on "no task
   * resolved" it stays untouched, because that fixture's task IS resolved (declared files are
   * present) whether or not a trailer string appears anywhere. Absent/empty ⇒ the advisory never
   * fires — same fail-closed default as every W1-T322/W1-T401 advisory input, and byte-identical
   * to every caller/fixture that predates this task (no caller populates it yet; wiring the real
   * plan data through at the `rmd review`/dispatch call sites is follow-up work outside this
   * task's declared `src/run-task.ts`-free scope).
   */
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
  /** The offending symbol(s)/path(s), rendered `file::symbol` for `unwired_export`, bare repo
   *  paths for `inverse_scope`/`scope_violation` — never a bare "flagged" with nothing named
   *  (W1-T186 emitter discipline, the same one {@link ReviewVerdict.instrumentEntanglementPaths}
   *  follows). */
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
  /**
   * W1-T72 (W1-T65 follow-up — LEGIBILITY, not a blocking-behavior change): true
   * when NOTHING was observed on the PR head (no criterion's `proof_exec` is
   * `executed_pass`/`executed_fail`) while at least one non-`satisfied_by` proof
   * was WRITTEN in the house dialect (`grep: …` / `unit test: …` —
   * {@link isDialectPrefixed}) — i.e. a proof authored to be mechanically
   * checked never actually got checked, and the binding verdict fell back to
   * the blind keyword floor on EVERY criterion. `state`/`met` are UNCHANGED
   * either way — the keyword floor remains the binding fallback exactly as
   * W1-T65 shipped it. Whether a degraded floor should HOLD a risk:high PR is
   * the operator's doctrine call, explicitly out of scope here.
   */
  floorDegraded: boolean;
  /**
   * W1-T2743 — BOUNDED LEGIBILITY FOR DUPLICATE PROOF WORK. `proofUniqueRuns` counts distinct
   * (checkout, command, argv) triples this review actually executed — head and base separately;
   * `proofReuses` counts calls answered from an earlier observation in the SAME review. Counts
   * only: no command, no argv, no stdout, no environment and no key list, so a `review.posted` row
   * gains two integers rather than an unbounded payload.
   *
   * The #3744 shape reports 2 unique runs and 10 reuses with a base checkout available, where
   * `proof_exec: 6/6` previously hid twelve child spawns. `undefined` when no head checkout was
   * supplied and nothing could execute — never `0`, which would say "measured none" about a review
   * that never measured at all.
   */
  proofUniqueRuns?: number;
  proofReuses?: number;
  /**
   * W1-T178 (verdict stability): the rolled-up `state` as if NO semantic verdict
   * had been supplied at all — every criterion judged on `floorMet` (falling
   * back to `met` where `floorMet` is absent) plus the same `testTheater`/empty-
   * criteria rules `state` itself uses. This is the DETERMINISTIC anchor
   * {@link applyVerdictStability} consults: a semantic-only downgrade (this
   * failing while `floorState` still passes) is noise a re-review of an
   * unchanged, previously-PASSING head may not act on alone. Optional so every
   * other `ReviewVerdict` literal in the codebase (the fix rung's ledger-
   * reconstructed seed verdicts, run-task.ts) needs no update; only
   * {@link judgeReview} populates it, which is the only producer
   * `applyVerdictStability` is ever fed.
   */
  floorState?: ReviewState;
  /**
   * W1-T185 (closes a W1-T128 gap — MASTER-PLAN rule 22 fixture (iii): a PASS at
   * `proof_exec: 0/5`, directly beneath its own FLOOR DEGRADED banner, over a
   * diff satisfying one criterion in five with zero tests on a `tdd: strict`
   * task). True whenever the judged review's `proof_exec` set is ENTIRELY
   * `not_executable`/`exec_error` across every criterion that could have
   * attempted execution (`satisfied_by` criteria excluded — an Architect
   * override deliberately never attempts execution, which is not a capping
   * concern) — i.e. NOTHING was OBSERVED anywhere in this review. Computed
   * UNCONDITIONALLY, independent of `state`: it is a fact about what ran, not a
   * verdict on its own.
   *
   * CAPPED IS NOT FAIL (design, load-bearing): `capped` never forces `state` to
   * `"failure"` — mapping capped to failure would red every PR the moment one
   * proof is unparseable, halting the fleet, which is a worse failure than the
   * uncertified PASS it replaces (it would punish authors for a dialect gap
   * rather than surfacing it). What `capped` DOES change is the RENDERING: a
   * capped `state: "success"` never uses {@link passSummary}'s wording — never
   * "substantiated", never "no test theater" — because neither claim was
   * measured; see {@link cappedSummary}. It is a CLAIM either way; `capped`
   * says so honestly instead of dressing it as certified.
   *
   * The one place `capped` IS consequential: {@link decideAutoMergeArm} refuses
   * to arm auto-merge on ANY `capped` verdict (W1-T229 — regardless of the
   * task's `principles`; a prior version of this gate exempted every
   * non-tdd:strict task, which made prose the DEFAULT merge floor, since
   * `{tdd: strict}` is opt-in), unless an explicit, ledgered
   * {@link CappedOverride} is supplied — a separate decision layer from this
   * verdict's own `state`, so a capped verdict can still post as a
   * non-blocking commit status (criterion 3) while the ARMING path still
   * refuses it (criterion 2). Distinct from `floorDegraded` (W1-T72,
   * legibility-only, gated on a DIALECT-PREFIXED proof specifically): `capped`
   * fires on ANY zero-executed verdict, dialect-prefixed or not.
   */
  capped: boolean;
  /**
   * W1-T185 (closes the second W1-T128 gap): true when this verdict was judged
   * with NO `headCheckoutDir` — i.e. proof execution was never attempted for
   * ANY criterion, so `state` rests entirely on the keyword floor (+ optional
   * semantic downgrade). This is the case today for `rmd review`'s manual-PR
   * escape hatch (the operator's working checkout is never used as a PR-head
   * substitute — HEAD DISCIPLINE, W1-T65). Surfaced on the posted commit-status
   * summary, the ledger `review.posted` line, and the console `say()` output
   * (run-task.ts) so a keyword-only PASS is never mistaken for an OBSERVED one.
   * Purely a LEGIBILITY signal, like `floorDegraded` — it does not itself force
   * `state`, since a `not_executable`-only floor is the long-standing, correct
   * behavior for every criterion whose proof is free prose.
   */
  keywordOnly: boolean;
  /**
   * W1-T205 (the operator's standing rider on W1-T229's raised floor): true when
   * the diff touches ONLY plan-scope files (`plan/**`/`MASTER-PLAN.md` —
   * {@link isInPlanScope}, the SAME predicate `rmd plan`'s PROPOSED-outcome check
   * and the W1-T136 filing-PR emitter already use) and at least one file. A
   * plan-only PR files or amends a task; it never carries the code the task
   * describes, so it has NO executable proof to run — it is STRUCTURALLY and
   * PERMANENTLY `capped`, not degraded. FAILS CLOSED: an empty diff, or a diff
   * mixing even one src/test/other file into an otherwise plan-only change, is
   * NOT plan-only — the dangerous shape is a code change smuggled into a plan PR
   * to inherit the exemption below, so ambiguity resolves toward the full floor.
   *
   * The one place `planOnly` is consequential: {@link decideAutoMergeArm} treats
   * a `planOnly` CAPPED verdict as armable without an operator override — the
   * carve-out is an exemption from PROOF EXECUTION and, since W1-T2221, from the
   * SEMANTIC downgrade too (never from `state` itself: a plan-only PR whose
   * criteria are genuinely unmet — the deterministic FLOOR, pre-downgrade,
   * still fails). W1-T2221 closed a gap where `planOnly` was consulted only
   * behind `state === "success" && capped`: a filing whose declared proof path
   * happened to name a test that already exists on `main` RESOLVED and RAN,
   * the semantic lane downgraded it for judging a specification as if it were
   * an implementation, and the carve-out below was never reached at all. `state`
   * now rolls up a plan-only diff's criteria on `floorMet`, not the
   * semantically-downgraded `met` (see `unmetForState` in {@link judgeReview}),
   * so a plan-only PR is decided by the deterministic gates that already bind
   * it (lint-plan, the emitter's own structural checks, plan-index
   * regeneration, commitlint) — never by whether a proof happened to execute.
   * It also changes the RENDERING of a capped success (see {@link
   * planOnlySummary}) so the posted status reads as deterministically gated
   * rather than as proof-executed — never overstating what was checked.
   */
  planOnly: boolean;
  /**
   * W1-T58 (ratifies P3 via P8/RETRO-1784058021334, Standing rule 15 — "a worker
   * may never [edit its own criteria]"): true when the diff ITSELF adds or
   * removes a criterion field (`claim:`/`proof:`/`satisfied_by:`) in
   * `plan/tasks.yaml` or a `plan/tasks.d/*.yaml` shard (W1-T399) — see {@link
   * checkSatisfiedByGuard}, the same diff-derived predicate — while ALSO
   * touching something outside `plan/**` (`!planOnly`; the only Architect-vs-
   * worker signal this pure function has — a worker's own task diff is never
   * plan-only in this codebase, only `rmd plan` produces one, and that path
   * never reaches this field's consequence — see run-task.ts's `runFixRung`).
   * An ADDED field line trips this whether it grows an EXISTING criterion (a
   * `satisfied_by:`) or appends a WHOLE NEW criterion after the existing ones
   * (W1-T400 — PR #1295 reshaped its diff to append a criterion its own diff
   * already satisfied, and a pure append deleted nothing and grew no existing
   * field, so it tripped neither the original add-only `satisfied_by` check
   * nor the removed-field one). FORCES `state`/`floorState` to `"failure"`
   * exactly like `testTheater`: the tampering itself is the violation,
   * independent of whether any NAMED criterion mechanically passes (a worker
   * could edit its task record to match its diff and still have every
   * original criterion read "met"). Never suppressible by {@link
   * applyVerdictStability} (folded into `floorState` too) — this is a
   * deterministic diff fact, not a semantic reviewer opinion. A genuine
   * Architect correction (plan-only) never trips it, and neither does an
   * ordinary task filing — itself nothing but added claim/proof lines — for
   * the same reason: filing a task is plan-only.
   */
  criteriaTampered?: boolean;
  /**
   * W1-T274: claims the body ({@link ReviewEvidence.report}) makes about its
   * OWN changeset that are FALSE against the diff it actually shipped — see
   * {@link bodyContradictsDiff} for the exact recognised shapes (a stated
   * file count, a "no src/"/"plan-only"/"data-only" absence claim, a named
   * file in an "exactly N files: …" enumeration) and why anything outside
   * them is silence, never a verdict. `[]` when the body makes no such claim,
   * OR makes one this check cannot decide (criterion: "a body making no
   * changeset claim is neither passed nor failed by this check"). Non-empty
   * FORCES `state`/`floorState` to `"failure"` exactly like `testTheater`/
   * `criteriaTampered`: a body that contradicts its own diff is a false
   * statement the gate is being asked to merge on, not a legibility problem —
   * it fails the review, with the contradiction NAMED (see {@link
   * failSummary}), because an unexplained red is the shape that gets
   * overridden. Structural (diff+report-derived), never a semantic reviewer
   * opinion, so — like `criteriaTampered` — never suppressible by {@link
   * applyVerdictStability}. Optional so every OTHER `ReviewVerdict` literal in
   * the codebase (run-task.ts's ledger-reconstructed seed verdicts, every
   * fixture that predates this task) needs no update; only {@link
   * judgeReview} populates it.
   */
  changesetContradictions?: ChangesetClaimContradiction[];
  /**
   * W1-T1264 (design (i)/(ii)/(iii)): how many changeset claims {@link recognizeChangesetClaims}
   * RECOGNISED in this body — see its own doc for the exact definition. THE FIELD THAT MAKES A
   * SILENT `changesetContradictions: []` LEGIBLE: today that array reads identically whether the
   * body never made a changeset claim at all or made one that agreed with the diff. `0` here means
   * the former; `> 0` alongside an empty `changesetContradictions` means the latter — "checked, and
   * it agrees" — the one fact that array alone cannot express. Mirrors `changesetContradictions`'s
   * own withholding: `undefined` (never `0`) when {@link ReviewEvidence.reportIsSubstitute}
   * withholds the whole check, so a genuine zero is never confused with "not computed". Purely a
   * LEGIBILITY signal like `unwiredAdvisories`/`reachabilityScanned` — never folds into `state` or
   * `floorState` itself; only `changesetContradictions` (unchanged) does that. Optional for the
   * same reason every sibling field here is: every OTHER `ReviewVerdict` literal in the codebase
   * needs no update; only {@link judgeReview} populates it.
   */
  changesetClaimsRecognised?: number;
  /**
   * W1-T1264 design (iv): true when {@link recognizeChangesetClaims}'s quote-stripping pass
   * reached end-of-body still inside an open fence — see {@link
   * ChangesetClaimRecognition.fenceUnbalancedAtEof}'s doc for why that silently starves
   * `changesetClaimsRecognised`. Legibility only, like the field above; never forces `state`.
   * Mirrors `changesetClaimsRecognised`'s own substitute-withholding (`undefined`, not `false`,
   * when the check is withheld).
   */
  changesetFenceUnbalancedAtEof?: boolean;
  /**
   * W1-T297 (Standing rule 25 — INSTRUMENT CHANGES RIDE ALONE): true when the
   * diff changes at least one measurement-instrument path ({@link
   * INSTRUMENT_SURFACE} — a CI workflow's measurement wiring, a ratchet/
   * coverage script, a recorded baseline, or the mutation-scope config) AND
   * at least one src/ PRODUCT path (`test/` excluded — see {@link
   * isProductPath}) IN THE SAME PR. "the instrument is right" and "the code
   * is right" are two independently falsifiable claims; a diff that ships
   * both proves neither, because the code's own falsifiers were graded by
   * the very version of the instrument that shipped beside them (the
   * #585/#586 arc this task's rationale documents: a coverage flag, a
   * diff-coverage carve-out, and a re-captured baseline all rode inside
   * ordinary fix-rung strikes). FORCES `state`/`floorState` to `"failure"`
   * exactly like `criteriaTampered`/`changesetContradictions`: this is a
   * structural, diff-derived fact, never a semantic reviewer opinion, so —
   * like them — never suppressible by {@link applyVerdictStability}. An
   * instrument-only PR (even one carrying its own `test/` fixture, or a
   * `docs/` update) is the SANCTIONED shape and reads `false`; so does a
   * src-only, plan-only, or docs-only PR. See {@link
   * detectInstrumentEntanglement} for the pure predicate this folds in.
   */
  instrumentEntangled?: boolean;
  /**
   * The observed evidence behind a `true` {@link instrumentEntangled} —
   * the instrument paths found and the src/ product paths beside them
   * (W1-T186 emitter discipline: never a bare "entangled" with nothing
   * named). `undefined` whenever `instrumentEntangled` is `false`/absent.
   */
  instrumentEntanglementPaths?: { instrumentPaths: string[]; srcPaths: string[] };
  /**
   * W1-T322 (SHIPS-UNWIRED advisory floor). ADVISORY ONLY, by design (see the task's own
   * rationale for WHY: a blocking check that false-positives on a fleet doing ~50 PRs/day gets
   * routed around or deleted within a week — this floor ships WARN-ONLY and MEASURES; W1-T323
   * flips severity once a measured false-positive rate clears a stated threshold). This field
   * NEVER folds into `state`/`floorState`/`capped` — unlike every other structural field on this
   * interface (`criteriaTampered`, `changesetContradictions`, `instrumentEntangled`), which all
   * force `state` to `"failure"`. Empty array when nothing to advise. FOUR reason codes fire here
   * (a fifth, `net_state_claim`, is retro-time only — see {@link "./retro.js".netStateCapabilityAdvisories}):
   *   - `unwired_export`   — the diff adds an `export function` {@link scanUnreachedExports}
   *                          cannot find a real caller for, and the report carries neither a
   *                          `WIRED-AT: <file>::<symbol>` marker naming it nor a `SHIPS-UNWIRED:
   *                          <task-id>` marker naming a real, open task (see {@link
   *                          ReviewEvidence.openTaskIds}).
   *   - `inverse_scope`    — the task's declared `files:` scope (see {@link
   *                          ReviewEvidence.taskDeclaredFiles}) names a file this diff never
   *                          touched — the direction {@link "../run-task.js".scopeGuardOutOfScopeFiles}
   *                          (diff-touches-undeclared) cannot see.
   *   - `scope_violation`  — (W1-T401) the MIRROR direction: the diff touches a file OUTSIDE the
   *                          task's declared `files:` scope — the same comparison {@link
   *                          "../run-task.js".scopeGuardOutOfScopeFiles} makes, but that guard sits
   *                          behind exactly one of `gitPushRunBranch`'s nine call sites (the
   *                          orchestrator's fallback push, taken only when the worker's branch is
   *                          absent from origin) so it never runs on the ordinary path. This
   *                          advisory runs on EVERY review instead. ADVISORY, not a refusal
   *                          (design (ii)/(iii) — a measured majority of recent declared-scope
   *                          "violations" are legitimate: generator-gate artifacts, a task's own
   *                          plan shard, operator-instructed or review-ratified widenings), and
   *                          FAIL-CLOSED in the safe direction like `inverse_scope`: an absent or
   *                          empty declared scope has nothing to compare, so it never fires — unlike
   *                          {@link "../run-task.js".scopeGuardOutOfScopeFiles}, which treats "no
   *                          declared files" as "everything is out of scope" for its own (blocking,
   *                          fallback-only) purpose, a task declaring nothing is never treated here
   *                          as declaring everything.
   *   - `unresolved_task_scope` — (W1-T458, the #1731 near-miss) NO task resolved for this PR
   *                          (see {@link ReviewEvidence.taskDeclaredFiles}'s absent/empty
   *                          fail-closed contract, the SAME resolved-task signal `inverse_scope`/
   *                          `scope_violation` already read — never a literal "no trailer in the
   *                          body" check, which would misfire on the `scope-creep` golden fixture)
   *                          while the diff touches an implementation path (`src/`/`test/`) an
   *                          OPEN task's declared `files:` scope also names (see {@link
   *                          ReviewEvidence.openTaskDeclaredFiles}). AN INTERSECTION IS EVIDENCE,
   *                          NOT PROOF (a task's `files:` list is declared, not derived — it can
   *                          be stale in either direction), so the detail text is phrased as a
   *                          QUESTION the PR author answers (naming the suspected task and the
   *                          overlapping paths), never a claim that this PR IS that task. Restricted
   *                          to `src/`/`test/` paths specifically because the measured false-positive
   *                          rate over "touches any declared path" (52%, inflated by plan filings and
   *                          docs PRs that should earn no credit) collapses to ~11% once narrowed to a
   *                          declared `src/`/`test/` path — still an ADVISORY, never a refusal, at
   *                          that rate. FAIL-CLOSED like `inverse_scope`/`scope_violation`: an absent
   *                          or empty {@link ReviewEvidence.openTaskDeclaredFiles} has nothing to
   *                          compare, so it never fires.
   * The caller (run-task.ts) ledgers each entry as a `review.unwired_advisory` line naming the
   * PR, the reason code and the symbols — the dataset W1-T323's measurement reads.
   */
  unwiredAdvisories?: UnwiredAdvisory[];
  /**
   * W1-T1118: the reachability scan's EXAMINED count, riding this verdict so `review.posted`
   * (run-task.ts) can carry it without a second ledger line — see {@link
   * "./reachability.js".ReachabilityScanResult}'s doc for the three-state contract this exists to
   * separate:
   *   - a NUMBER — {@link scanUnreachedExports} ran and examined this many deduped added exported
   *     functions (0 is honest: the diff added none, not "the scan didn't run");
   *   - `null` — the scan did NOT run at all, the same `checkoutDir` skip {@link unwiredAdvisories}'s
   *     `unwired_export` code already degrades on (no head checkout to read).
   * OBSERVABILITY ONLY, exactly like `unwiredAdvisories` above: never folds into `state`,
   * `floorState` or `capped`, and its presence/value never changes which advisories fire or which
   * reason codes they carry.
   */
  reachabilityScanned?: number | null;
  /**
   * W1-T352 (DECISIONS.md ENTRY PROVENANCE FLOOR): the header text of every entry this diff ADDS
   * to DECISIONS.md (a `## …` line) that carries, among that SAME entry's own added lines,
   * NEITHER the machine auto-choose stamp NOR an operator-attribution line — see {@link
   * decisionsEntryProvenanceViolations} for the exact closed vocabulary and the diff-only scope.
   * `[]` when every newly-added entry is marked, or the diff adds no new entry header at all —
   * DECISIONS.md's own 35+ historical unmarked entries never fire, because only ADDED lines are
   * read (the incident this task closes: PR #1302 appended a bare `## … RULING:` header in
   * neither genre, and the operator overrode it within the hour, #1303).
   *
   * Non-empty FORCES `state`/`floorState` to `"failure"` exactly like `criteriaTampered`/
   * `changesetContradictions`/`instrumentEntangled`: this is a structural, diff-derived fact,
   * never a semantic reviewer opinion, so — like them — never suppressible by {@link
   * applyVerdictStability}. UNLIKE {@link unwiredAdvisories} above (W1-T322's deliberately
   * ADVISORY-ONLY precedent), this floor BLOCKS from day one: the task's rationale argues the
   * asymmetry directly — DECISIONS.md gains a couple of entries a week, not a ~50-PR/day surface;
   * the check is a deterministic string-presence test over ONE file, not a reachability
   * heuristic; and the harm of one unmarked binding entry slipping through propagates (MASTER-PLAN
   * cited PR #1302's ruling as settled within the hour, before the override landed).
   */
  unprovenancedDecisionsEntries?: string[];
  /**
   * W1-T166 (the reward-hacking measurement): visible-pass-rate minus
   * holdout-pass-rate, over this verdict's own criteria — `(visible criteria
   * met / visible criteria count) − (holdout criteria met / holdout criteria
   * count)`. A worker that can see (and so can optimize toward) only the
   * visible criteria is expected to pass them at a higher rate than the
   * holdout ones it never saw; a large positive gap is the SIGNAL SpecBench
   * names (reward-hacking against the visible test suite). `null` when the
   * gap is not MEASURABLE — no holdout criteria were declared (nothing to
   * compare against) or no visible criteria were declared (no baseline rate).
   * Never forces `state` — this is a MEASUREMENT ledgered per run
   * (`reward_hacking_gap`, run-task.ts), not itself a pass/fail gate. Optional
   * (mirrors `floorState`'s doc) so every OTHER `ReviewVerdict` literal in the
   * codebase (ledger-reconstructed placeholders in run-task.ts/sweep.ts, and
   * every fixture that predates this field) needs no update; only
   * {@link judgeReview} populates it — treat absent identically to `null`.
   */
  rewardHackingGap?: number | null;
  /**
   * W1-T305 (design (1)/(2) — "SIZE IT FIRST … make it countable, not a claim nobody reads"):
   * how many criteria in this review carry a {@link CriterionVerdict.proof_skip} — i.e. every
   * `not_executable`/`exec_error` criterion, over the SAME set `capped`/`floorDegraded` already
   * count (satisfied_by criteria excluded implicitly: they never set `proof_skip` at all). This
   * is `verdicts.filter(v => v.proof_skip !== undefined).length` over EVERY criterion (holdout
   * included in the count, matching how `capped`'s own executable-criteria count already folds
   * holdout in — the AGGREGATE NUMBER is never secret, only holdout TEXT is), so the class is
   * legible without re-deriving it from the ledger's `proof_exec` array by hand.
   */
  unexecutableCount?: number;
  /**
   * W1-T305: the OFFENDING PROOF TEXT for every unexecutable criterion counted above —
   * `criterion.proof`, never a paraphrase, so an operator reading the ledger row sees exactly
   * what was written. VISIBLE criteria only ({@link visibleCriteria}) — a holdout criterion's
   * proof text stays out of every worker-facing surface exactly like its claim/reason already do
   * (W1-T166); `unexecutableCount` above may therefore exceed `unexecutableProofs.length` when a
   * holdout criterion is among the unexecutable set.
   */
  unexecutableProofs?: string[];
  /**
   * W1-T305 (design (4) — "a body whose proofs are half-executable must not read the same as one
   * whose proofs all ran"): true when SOME but not ALL executable criteria (excluding
   * `satisfied_by`) actually executed (`proof_exec` is `executed_pass`/`executed_fail` — the
   * SAME "was anything OBSERVED" set `capped`'s own `executedCount` already counts) — the
   * 52-partial-head shape the rationale measured, distinct from `capped` (ALL zero-executed) and
   * from a fully-observed review (every executable criterion ran).
   * Never forces `state`; purely a LEGIBILITY signal like `capped`/`floorDegraded`, surfaced on
   * the posted PASS summary (see {@link passSummary}) so a partially-certified PASS is never
   * rendered identically to a fully-certified one.
   */
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

/**
 * Tokenise for keyword matching, NORMALISING identifier casing + separators so a
 * criterion and its proof compare case- and separator-insensitively:
 * `maxTurns` ≡ `max_turns` ≡ `max-turns`. camelCase is split into words BEFORE
 * lowercasing (otherwise `maxTurns`→`maxturns` never matches `max_turns`→`max`,
 * `turns`) — a real reviewer weakness that false-blocked PR #42 (W1-T5). This is a
 * FLOOR hardening; the deeper fix is observing repo state (W1-T3F), not keywords.
 */
function tokenize(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // split camelCase: maxTurns → max Turns
    .toLowerCase()
    .split(/[^a-z0-9]+/) // splits on _, -, space, punctuation alike
    .filter(Boolean);
}

/**
 * Distinctive keywords of a proof: tokens ≥4 chars, not stopwords, not bare
 * numbers. Placeholders like `<sha>` reduce to `sha` (len 3) and drop out, so a
 * proof's template noise does not pollute the responsiveness check.
 */
function proofKeywords(proof: string): string[] {
  return [
    ...new Set(
      tokenize(proof).filter((t) => t.length >= 4 && !STOPWORDS.has(t) && !/^\d+$/.test(t)),
    ),
  ];
}

/**
 * Fraction of a proof's distinctive keywords the report must echo before we
 * treat the proof as "responsively addressed". A missing/unpasted/non-responsive
 * proof scores near zero; a report that pastes the proof scores near one. This is
 * a FLOOR, not a semantic judge — the LLM reviewer does the real judging on top.
 *
 * W1-T219 (recon R-13(i)): was 0.34 — echoing barely a THIRD of a proof's
 * distinctive tokens read as "responsive", which a report can hit by accident
 * (shared vocabulary with the claim) with no real engagement with the proof at
 * all. Raised to a genuine MAJORITY: a report must echo more than half of a
 * proof's distinctive keywords to count as substantiating it.
 */
const MIN_COVERAGE = 0.6;

// ── Test-theater detection over a unified diff ─────────────────────────────

/** True once we are inside an added test file (per `+++ b/…test…` headers). */
function isTestPath(path: string): boolean {
  return /(^|\/)test(s)?\//.test(path) || /\.test\.[cm]?[jt]sx?$/.test(path) || /\.spec\./.test(path);
}

const ASSERTION_RE = /\b(assert|expect|should)\b|\.(is|ok|equal|deepEqual|match|throws|rejects)\(/;
/**
 * A NEW TEST CASE being declared among a diff's added lines — `test(`, `it(`,
 * `describe(`, including their `.only`/`.skip`/`.each` modifier forms. This is
 * what makes "added tests" something there is to judge at all; see
 * {@link detectTestTheater} for why its absence must not fire the no-assertion
 * arm. Matches the CALL, never a bare token, so a variable named `test` or a
 * comment mentioning one cannot smuggle an assertion-free case past the gate.
 */
const TEST_DECLARATION_RE = /\b(?:test|it|describe)\s*(?:\.\w+)?\s*\(/;

const NOOP_ASSERTION_RE =
  /assert(\.\w+)?\(\s*true\s*[),]|assert\.equal\(\s*true\s*,\s*true|expect\(\s*true\s*\)/;

/**
 * Fixture DATA under `test/fixtures/` is not test CODE, and this exclusion is
 * load-bearing rather than tidy-minded. A corpus of PLANTED violations
 * necessarily CONTAINS the very patterns this detector hunts — the W1-T423
 * golden-verdict corpus ships a `diff.patch` whose payload is `assert.ok(true)`,
 * and a `golden.yaml` whose prose QUOTES `assert(true), assert.equal(true, true),
 * expect(true)` to explain the rule it pins. `isTestPath` matches everything
 * under `test/`, so both read as added test code and #1613 — the PR adding that
 * corpus — failed as theater on its own fixtures. The failure is general, not a
 * one-off: the corpus README's growth rule asks every future judgment-changing
 * PR to add or update a golden, so every one of them would have hit this.
 *
 * Excluding fixtures does not blunt the detector. Nothing under `test/fixtures/`
 * is executed as this repository's own suite — it is input handed to a judge or
 * an executor — so a tautology there cannot be theater in the sense this check
 * exists to catch, which is a REAL test that asserts nothing. Test code proper,
 * including the golden suite's own driver at `test/golden-verdicts.test.ts`, is
 * outside `test/fixtures/` and is still scanned exactly as before.
 */
function isFixtureDataPath(path: string): boolean {
  return /(^|\/)test\/fixtures\//.test(path);
}

/**
 * Detect test theater: added test code that asserts nothing (or asserts a
 * tautology). Scans only ADDED lines inside test files, EXCLUDING fixture data
 * (see {@link isFixtureDataPath}). Returns false when the diff touches no test
 * file (nothing to judge) or when a real assertion is added.
 */
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
  // THE PLANTED-TAUTOLOGY ARM IS UNCONDITIONAL, AND STAYS ABOVE THE GUARD BELOW.
  // `assert(true)` is a deliberate act, not an absence, so it is refused whether or not the diff
  // declares a test case — smuggling one into an EXISTING case is precisely the shape that would
  // otherwise walk through the new guard.
  if (addedTestLines.some((l) => NOOP_ASSERTION_RE.test(l))) return true;
  // A DIFF THAT DECLARES NO NEW TEST CASE HAS ADDED NO TEST TO JUDGE.
  //
  // A unified diff renders a MODIFICATION as a `-`/`+` pair, and the loop above reads only the `+`
  // half, so an in-place rewrite of existing test code was indistinguishable from newly added test
  // code — and, carrying no assertion of its own, was refused as theater. MEASURED on #3922
  // (W1-T2775 tranche 1): 52 added test lines, every one a one-token `mkdtempSync` prefix rewrite,
  // zero test-case declarations, `testTheater = true` with all 36 check runs otherwise green and
  // every acceptance criterion met. That shape recurs in all 26 remaining W1-T2775 tranches and in
  // any rename, import reorder or lint fix touching a test file.
  //
  // This narrows ONLY the no-assertion arm, and it restores the rule this function's own doc
  // already states ("added test CODE that asserts nothing") rather than inventing a new one.
  // ITS COST, STATED RATHER THAN BURIED: lines appended INSIDE an existing test case, with no
  // assertion anywhere in the added set, no longer trip this arm. The alternative — pairing added
  // lines against removed ones so only genuinely new lines are judged — keeps that case covered,
  // but a unified diff carries no reliable pairing, trading a crisp rule for a heuristic that can
  // itself misfire; the operator ruled for the declaration gate (2026-09-04).
  if (!addedTestLines.some((l) => TEST_DECLARATION_RE.test(l))) return false;
  const hasRealAssertion = addedTestLines.some((l) => ASSERTION_RE.test(l));
  return !hasRealAssertion;
}

// ── Whitelisted proof execution (W1-T65, ratifies P15; grammar widened W1-T72) ──
//
// Lifts W1-T3F's whitelisted-proof execution — previously only the ADVISORY
// fresh-context reviewer's own judgment (buildReviewPrompt below tells the LLM to
// check out the head and run a proof's test/grep itself) — INTO this deterministic
// FLOOR, so the gate observes repo state whether or not that LLM reviewer ever
// completes. Two ORIGINAL strict shapes (W1-T65):
//   (1) a named TEST FILE path (`test/**/*.test.ts` or `.spec.*`), run via the
//       project's own test runner (`node --test --import tsx <path>`, exactly the
//       package.json `test` script scoped to one file);
//   (2) a literal, BACKTICK-FENCED `grep ...` command (e.g. `` `grep -n foo bar.ts` ``)
//       — fenced so a proof must be UNAMBIGUOUS to qualify; unfenced prose like
//       "grep of src shows X" is NOT this shape and stays on the keyword floor.
// PLUS the HOUSE DIALECT (W1-T72 — coverage: W1-T67/#123 and #125 both showed
// proof_exec 0/N because the acceptance proofs are actually written this way, not
// as fenced commands or bare paths):
//   (3) `grep: <pattern> in <path>` — a leading `grep:` label, the pattern
//       free text, followed by `in <path>` (a trailing token that looks like a
//       path — contains `/` or `.`, no whitespace), a FILE or a DIRECTORY
//       (searched recursively either way). REQUIRED (W1-T219, recon R-13(iii)):
//       no `in <path>` clause is not_executable, never a repo-wide default
//       search — a pattern matching one incidental line ANYWHERE is not
//       evidence for a SPECIFIC criterion, and `executed_pass` OVERRIDES
//       keyword coverage, so an unscoped match used to certify on nothing more
//       than accidental vocabulary overlap. A literal `*` in the path is
//       refused (not_executable): execFile never shells out, so nothing
//       expands a glob — a wildcard target can never resolve to a real file.
//   (4) `unit test: <file-or-test-name>` — a leading `unit test:` label, then
//       EITHER a literal test-file path (shape (1), reused verbatim) OR a bare
//       TEST NAME, run via `node --test --import tsx --test-name-pattern <name>
//       test/**/*.test.ts` (the SAME file glob the project's own `test` script
//       uses) — the whole suite, filtered.
// ALL FOUR are executed via execFile (never a shell), so proof TEXT can never
// inject shell metacharacters into a command line. The two LEGACY strict shapes
// ((1)/(2)) still refuse outright on `; & \` $ < >` or a newline as belt-and-braces
// (they are rare, and both are already unambiguous/fenced). The two HOUSE-DIALECT
// shapes ((3)/(4)) do NOT apply that blanket blocklist (W1-T128 — THE DEAD PROOF
// FLOOR): a dialect body is ordinary architect PROSE, and prose routinely contains
// a semicolon — that single character was refusing 158 of 269 dialect proofs
// measured live in this plan (101 of 126 at the 2026-07-19 baseline), none of them
// an actual injection risk, because execFile takes `args` as an array and never
// hands the string to a shell to interpret. A dialect body is refused ONLY for a
// hazard that survives execFile: path traversal (`..`) or a literal glob (`*`) in
// a grep TARGET, both still checked in {@link parseDialectGrep}. Anything that
// doesn't match any shape is not_executable — the keyword floor stands alone,
// unchanged, and (W1-T72, legibility) is flagged `floorDegraded` when it was
// written to be runnable (see {@link isDialectPrefixed}) but nothing on the
// review ended up executed.

/** A proof shape the floor is willing to mechanically execute. */
export interface WhitelistedProof {
  kind: "test" | "grep";
  /** argv[0] — passed to execFile, never a shell. */
  command: string;
  /** argv[1..] — proof text is never concatenated into a shell string. */
  args: string[];
  /** Human-legible label for reasons (the matched path, or the fenced command). */
  label: string;
  /**
   * W1-T72: true when `kind==="test"` was compiled from a bare TEST NAME (house
   * dialect `unit test: <name>`, not a literal file path) — i.e. `args`
   * includes `--test-name-pattern`. {@link execWhitelistedProof} uses this to
   * guard a node quirk: `--test-name-pattern` with ZERO matches still exits 0
   * (every file's own wrapper "passes" trivially even though nothing inside it
   * ran) — a named test that does not exist on the PR head must count as FAIL
   * (the proof named something the head does not observably contain, exactly
   * the existing "grep with no match" class), never a silent pass.
   */
  nameFiltered?: boolean;
  /**
   * W1-T2294: true only for `kind==="grep"` compiled by the LEGACY fenced `` `grep ...` ``
   * shape below (the `GREP_FENCE_RE` branch) rather than the house `grep:` dialect
   * ({@link parseDialectGrep}). The dialect form always compiles to the fixed `["-arn", "--",
   * pattern, path]` argv above — BRE, author-unselectable, no `-E` reachable — so it can never
   * read a pattern under two different regex engines. The legacy shape tokenises everything
   * after `grep` verbatim as argv (see {@link tokenizeFenced}), so an author's own flags —
   * including `-E`, switching the engine to POSIX EXTENDED — reach the executor unexamined.
   * This flag is how a consumer (task-linter.ts's engine-divergence check) tells the two
   * shapes apart without re-deriving it from `args` alone, which is not reliably recoverable
   * (a single-flag legacy invocation like `grep -arn -- pat path` has the identical `args`
   * shape as the dialect form's own compiled argv).
   */
  authorSelectedArgv?: boolean;
}

const TEST_PATH_RE = /\btest\/[\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?\b/;
const TEST_PATH_EXACT_RE = /^test\/[\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?$/;
const GREP_FENCE_RE = /`(grep\s+[^`]+)`/;
const UNSAFE_FENCE_CHARS_RE = /[;&`$<>\n]/;
/** The house-dialect PREFIXES a proof is WRITTEN in when it is meant to be
 * mechanically checked (W1-T72). Matched against the proof's leading text only
 * — a dialect label is how a proof STARTS, never something incidentally
 * mentioned mid-sentence. */
const DIALECT_GREP_RE = /^grep:\s*(.+)$/i;
const DIALECT_TEST_RE = /^unit test:\s*(.+)$/i;
/** W1-T277: the third house dialect — `demonstration: <what the operator must
 * do>` — is the honest OPPOSITE of `grep:`/`unit test:`: it names a proof the
 * harness DECLINES to check, on the record, rather than one it mechanically
 * runs. {@link parseWhitelistedProof} always refuses it (null, by
 * construction — there is nothing to execute); legality is a `verify:human`-
 * only restriction enforced by task-linter.ts, never here (review.ts has no
 * opinion on a task's `verify` field). */
const DIALECT_DEMO_RE = /^demonstration:\s*(.+)$/i;

/**
 * A markdown code span WRAPPING the whole string: N backticks, the body, then the SAME N backticks.
 * The `\1` backreference is what makes this safe — it only ever removes a matched pair at the two
 * ENDS, so an interior backtick (a `grep:` pattern searching for a template literal, say) is never
 * touched. `[\s\S]` rather than `.` so a multi-line span is handled; the inner `\s*` absorbs the
 * padding of the `` ` grep: … ` `` form CommonMark allows.
 */
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
/** The suite's per-process temp-dir reaper (W1-T131), passed on EVERY direct `node --test`
 * spawn this module builds — the same `--import` package.json's `test`/`test:ci`,
 * scripts/check.mjs and stryker.conf.json already pass. The proof executor omitted it, so
 * every proof execution leaked one OS-tmpdir dir per fixture in the loaded files: 53,310
 * `rmd-*` dirs, growing ~200/min, ENOSPC-crash-looped the daemon on 2026-08-03
 * (plan/feedback/fb-1785807201821-e4c9dc.yaml). Relative like every reference site: node
 * resolves `--import` from the spawn's cwd, which {@link execWhitelistedProof} pins to the
 * PR-head checkout — the file ships in that checkout. Must sort AFTER `--import tsx`: tsx's
 * loader is what lets node parse the `.ts` setup file at all. */
const TMP_HYGIENE_IMPORT = "./test/setup/tmp-hygiene.ts";

/**
 * True when a proof's TEXT is written in a recognised house dialect — either
 * meant to be mechanically executed (`grep:`/`unit test:`, W1-T72) or an
 * honest, on-the-record declaration that no execution will ever occur
 * (`demonstration:`, W1-T277) — independent of whether
 * {@link parseWhitelistedProof} actually accepted it (an unsafe/unparseable
 * dialect body, or a `demonstration:` body which is never executable by
 * construction, still returns null from that function). Used ONLY for the
 * `floorDegraded` legibility signal (W1-T72) — never affects execution.
 */
export function isDialectPrefixed(proof: string): boolean {
  const trimmed = proof.trim();
  return DIALECT_GREP_RE.test(trimmed) || DIALECT_TEST_RE.test(trimmed) || DIALECT_DEMO_RE.test(trimmed);
}

/**
 * True when a proof's TEXT is written in the `demonstration:` dialect
 * (W1-T277) — the single source of truth task-linter.ts imports rather than
 * redeclaring {@link DIALECT_DEMO_RE} itself, so the verify:human-only
 * legality restriction it enforces can never drift from what review.ts
 * actually recognises as this dialect.
 */
export function isDemonstrationProof(proof: string): boolean {
  return DIALECT_DEMO_RE.test(proof.trim());
}

/**
 * True when a proof's text carries a `grep:`/`unit test:` LABEL — under the SAME code-span
 * normalization {@link parseWhitelistedProof} itself applies (matchesDialectPrefix first, then
 * {@link stripCodeSpan} as a fallback), so a backtick-wrapped malformed proof is recognised
 * identically to a bare one. ONLY meaningful for a proof {@link parseWhitelistedProof} already
 * refused (returned null): it is what makes THAT refusal an AUTHORING ERROR
 * (`dialect-parse-error`, W1-T305) rather than ordinary prose (`no-dialect`) — the proof declared
 * an executable intent and its body's syntax is what parsing rejected (no `in <path>` clause, a
 * path-traversal/glob target, a `..`-escaping test path), not a claim that never asked to be
 * mechanically checked at all. Excludes `demonstration:`: that dialect is deliberately
 * unexecutable by design (W1-T277) — refusing it is the intended behavior, never a mistake.
 */
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

/**
 * Deterministic predicate (W1-T161, #349/W1-T149): does a name-filtered
 * `unit test:` proof BODY read as a long PROSE DESCRIPTION of behavior — the
 * house convention — rather than a short, bare TEST-NAME-shaped string?
 * {@link judgeCriterion} uses this ONLY to interpret a ZERO-MATCH outcome:
 *   - prose shape     -> `not_executable` (keyword floor stands, floorDegraded)
 *   - bare-name shape -> `executed_fail` (W1-T72's test-theater guard, PRESERVED)
 *
 * LIVE INCIDENT this fixes: #349/W1-T149's own proof read "a seeded task
 * dispatched N times with no new owned PR trips the per-task circuit breaker
 * at N+1 — exactly one needs-human escalation naming the loop, and zero
 * further dispatches (the W1-T29 x10 spin shape)" — a prose paraphrase of a
 * REAL, PASSING test titled "P29(ii) the W1-T29 x10 spin shape: …", worded
 * completely differently. `--test-name-pattern` matched zero tests on that
 * paraphrase, and the pre-fix rule minted an `executed_fail`, hard-blocking a
 * green-code PR until a human re-reviewed it by hand.
 *
 * A pure length/punctuation shape check over the body text — no model call,
 * so the same body always classifies the same way (acceptance #3). Threshold
 * picked from this repo's own convention: a bare, fabricated test-theater
 * title is written to LOOK like a real short title (one plain clause, no
 * internal punctuation), while a genuine prose description — like the #349
 * fixture above — routinely carries a comma/colon/dash/ellipsis/parenthetical
 * and/or runs well past a plausible title's length.
 */
export function looksLikeProseDescription(body: string): boolean {
  const trimmed = body.trim();
  if (trimmed.length > BARE_TEST_NAME_MAX_LEN) return true;
  return PROSE_PUNCTUATION_RE.test(trimmed);
}

/**
 * Split a `grep:` dialect body into its pattern + optional path. The path is
 * the trailing token after the LAST `\s+in\s+` boundary that itself looks like
 * a path/glob (contains `/`, `.`, or `*`, no whitespace) — this keeps
 * multi-word patterns like "wx flag present" intact while still correctly
 * splitting "... in src/lib/config.ts". No such boundary ⇒ the body carries no
 * TARGET at all and {@link parseDialectGrep} refuses it (W1-T219, below).
 */
const DIALECT_GREP_PATH_RE = /^(.*?)\s+in\s+(\S*[./*]\S*)$/i;

/**
 * (R-12) The one-line statement of what a `grep:` proof may target, quoted verbatim by every
 * surface that refuses a directory-shaped target: the parser (a `null`, so the proof never runs),
 * `rmd check-proof`'s refusal line, and the filing-time linter's `proof-grep-safety` violation —
 * so an author reads the same sentence wherever the refusal lands.
 */
export const GREP_PROOF_FILE_TARGET_REQUIREMENT =
  "a `grep:` proof must name a FILE (a path whose final segment carries an extension, e.g. " +
  "src/lib/plan.ts) — a directory target is not a proof of anything specific";

/**
 * (R-12) Does a `grep:` target NAME NO FILE — i.e. is it directory-shaped? Returns the refusal
 * reason, or `undefined` for a file-shaped target.
 *
 * THE DEFECT THIS CLOSES. The executor's `-r` made a directory target "work" at the head, and the
 * base-side check then materialised `git show <base>:<dir>` — which exits 0 with a TREE LISTING —
 * as a FILE at that path: the base grep over the listing found nothing, so the proof graded
 * `discriminates` → `executed_pass` even when the pattern already existed at the base (the
 * control, the same pattern against a file under that directory, read `executed_stale`), and a
 * sibling proof under the directory then hit `mkdirSync` ENOTDIR → `base_unreadable`. A directory
 * is also not a proof of anything SPECIFIC: `grep: foo in src` is W1-T219's refused whole-repo
 * search wearing a path.
 *
 * THE RULE IS TEXTUAL BECAUSE THE PARSE IS PURE (no cwd): the final path segment must carry an
 * extension. MEASURED over every `grep:` proof in `plan/tasks.d` (173 distinct targets at
 * 32415ea): 159 are blobs, 13 are absent forward references, and EXACTLY ONE is a tree —
 * `src/lib`, which is also the only extensionless final segment. So the rule and the defect have
 * the same single retrofit. COST, stated: an extensionless FILE (`bin/rmd`, `deploy/Dockerfile`)
 * is refused too; no proof in the plan names one, and the remedy is a proof against a file that
 * carries an extension. A dotted DIRECTORY (`plan/tasks.d`) passes this shape check and is caught
 * by {@link assertGrepTargetIsFile} against the real checkout instead.
 */
export function grepProofTargetNamesNoFile(path: string): string | undefined {
  const finalSegment = path.replace(/\/+$/, "").split("/").pop() ?? "";
  if (finalSegment.includes(".")) return undefined;
  return `target \`${path}\` names no file — ${GREP_PROOF_FILE_TARGET_REQUIREMENT}`;
}

/**
 * (R-12) WHY a `grep:` proof body failed to parse, as one sentence for a human — `undefined` when
 * the body parses (or is not a `grep:` proof at all). `rmd check-proof` prints it beside its
 * `parse: REFUSED` line, which used to name no cause; the parser itself keeps returning `null`
 * (its callers grade a `null` as prose/dialect-parse-error, and that contract is unchanged).
 */
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
  // W1-T128: no shell-metacharacter check on `pattern` — it becomes a single
  // argv element passed to execFile (never a shell), so `; & \` $ < >` are inert
  // here, and refusing prose for containing one was exactly the defect this
  // task fixes (see the module comment above). `--` (below) already stops a
  // pattern from being read as a grep FLAG regardless of its content.
  if (!pattern) return null;
  // W1-T219 (recon R-13(iii)): a `grep:` proof with NO `in <path>` clause used
  // to default to a recursive, whole-repo search — a pattern matching one
  // incidental line ANYWHERE certified the criterion (`executed_pass`
  // positively overrides keyword coverage), which is not evidence for a
  // SPECIFIC criterion. Rather than weaken that override (which is what makes
  // real observation trustworthy at all — see W1-T65/#100), require an
  // explicit target: no path ⇒ refuse (null), leaving the proof on the
  // keyword floor instead of mechanically executing an unscoped match.
  if (path === undefined) return null;
  // The grep TARGET is the one place a real hazard survives execFile: the executor runs
  // `grep -arn -- <pattern> <path>` with cwd pinned to the PR-head CHECKOUT, so a target naming a
  // file the review host can read but the checkout does not contain turns a proof into a
  // match/no-match ORACLE over that host's filesystem — and a body edit re-earns review on the
  // same head (see this repo's CLAUDE.md), so the oracle is repeatable a bit at a time.
  //
  // WHAT THIS LINE ACTUALLY REFUSES, STATED HONESTLY (R-18): the two escapes VISIBLE IN THE
  // PROOF TEXT — a `..` segment, and an ABSOLUTE path, which `resolve()` would honour verbatim
  // and which this check used to let straight through while its own comment claimed traversal out
  // of the checkout was refused. It CANNOT see the third escape: a target that resolves out
  // through a SYMLINK committed to the head. Nothing in the text distinguishes `escape/secret.txt`
  // from any ordinary in-tree path, so that one is refused where it is observable — against the
  // real filesystem, in {@link assertGrepTargetsInsideCheckout}, which
  // {@link execWhitelistedProof} calls before spawning grep.
  if (path.includes("..")) return null;
  if (isAbsolute(path)) return null;
  // No shell here (execFile) ⇒ no glob expansion — a literal '*' target can
  // never resolve to a real file and would always exit non-zero, silently
  // manufacturing a spurious executed_fail. Refuse rather than run it.
  if (path.includes("*")) return null;
  // (R-12) A DIRECTORY-SHAPED target is refused — see {@link grepProofTargetNamesNoFile} for the
  // rule and the measured retrofit. This parse has no cwd, so it can only see the SHAPE; a real
  // directory whose name happens to carry a dot (`plan/tasks.d`) is refused where it is
  // observable, against the checkout, in {@link assertGrepTargetIsFile}.
  if (grepProofTargetNamesNoFile(path) !== undefined) return null;
  // "-r" is a no-op on a plain FILE target (confirmed: `grep -rn pat
  // file.ts` behaves identically to `grep -n pat file.ts`). It used to be what
  // made a DIRECTORY target work at all; a directory target is refused since
  // R-12 (above), and "-r" is kept so the emitted argv stays byte-identical
  // for every file proof already written (test/proof-engine-declaration
  // pins the exact `["-arn", "--", pattern, path]` shape).
  // "-a" (treat binary as text) makes the verdict INDEPENDENT OF THE HOST'S GREP. Without it a
  // target carrying a raw NUL byte is judged "binary" and the two implementations DISAGREE —
  // MEASURED on this host against the same file and pattern: BSD grep 2.6.0-FreeBSD exits 0 with
  // "Binary file … matches", ugrep 7.5.0 exits 1 with no output. So `grep: export function
  // callSiteViolations in src/lib/task-linter.ts` (PR #1071) passes or fails according to which
  // binary the review host happens to resolve, which is not a proof. With "-a" both exit 0 and
  // print the matching line. Exactly 2 of this repo's 96 source files carry a NUL byte, and
  // task-linter.ts — the file this very check lives in — is one of them.
  //
  // DOWNSIDE, bounded: "-a" can only widen. It cannot invent a match — the pattern's bytes must
  // still occur in the file — and it changes nothing for a NUL-free target (verified). The one
  // new possibility is a genuinely binary target whose bytes happen to contain the pattern, which
  // requires the proof's author to have named a binary path explicitly. Note this is not even a
  // widening relative to BSD grep, which already reported exit 0 for that file; it is ugrep that
  // was silently reporting "no match", and "-a" removes the disagreement rather than adding
  // matches.
  return { kind: "grep", command: "grep", args: ["-arn", "--", pattern, path], label: `${pattern} in ${path}` };
}

/**
 * W1-T2737 — the TARGET PATH of a HOUSE-dialect `grep:` proof, or `undefined` for any other shape.
 *
 * {@link parseDialectGrep} compiles to a fixed `["-arn", "--", pattern, path]` argv, so the path is
 * the last element and nothing else can occupy it. The LEGACY fenced `` `grep ...` `` form passes
 * the author's own argv through ({@link WhitelistedProof.authorSelectedArgv}) — its last element is
 * whatever the author typed, and {@link proofEngineDivergenceViolations} already reports that shape
 * as engine-ambiguous — so this declines rather than guesses at a path.
 */
function dialectGrepTargetPath(w: WhitelistedProof): string | undefined {
  if (w.kind !== "grep" || w.authorSelectedArgv === true) return undefined;
  if (w.args.length !== 4 || w.args[0] !== "-arn" || w.args[1] !== "--") return undefined;
  return w.args[3];
}

/**
 * Compile a `unit test:` dialect body — either a literal test-file path (reuses
 * the exact-file shape verbatim) or a bare TEST NAME (name-filtered across the
 * whole suite glob).
 */
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
  // W1-T128: no shell-metacharacter check on a bare TEST NAME — it becomes the
  // single `--test-name-pattern` argv value passed to execFile (never a shell),
  // so `; & \` $ < >` are inert here too, and this branch names no file, so
  // there is no traversal/glob surface to guard either (see the module comment
  // above). A test name is ordinary prose and routinely contains a semicolon —
  // refusing it there was the single biggest cause of the dead proof floor.
  //
  // W1-T112 round-3 fix: `--test-name-pattern` compiles its argument as a REGEX
  // (`new RegExp(pattern)`), not a literal-substring match. A dialect proof is
  // ordinary architect prose describing a test's own title, and titles routinely
  // echo real syntax verbatim — e.g. "ProgramArguments end [rmd, digest]" — where
  // `[rmd, digest]` is an unescaped CHARACTER CLASS to the regex engine (matches
  // exactly one of the letters r/m/d/i/g/e/s/t or `, `), which can never match the
  // literal bracketed text it was quoting. That silently manufactures a FAIL for a
  // test that genuinely passed and is titled EXACTLY per the proof (empirically
  // confirmed live: `[rmd, digest]` in a proof never matches `[rmd, digest]` in a
  // title). Escaping regex metacharacters here makes the match what the dialect
  // was always meant to mean — "find the test named exactly this" — a literal
  // substring search, while remaining regex-CAPABLE for any proof author who
  // deliberately wants pattern semantics (rare, and not the common case this
  // dialect exists for).
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

/**
 * Parse a proof for a whitelisted, mechanically-executable shape. Returns `null`
 * for free prose (or an unsafe/unwhitelisted shape) — the caller then defers
 * entirely to the keyword floor, never attempting execution.
 */
/**
 * WHY this verdict is capped, as one short token for the ledger line and the posted status.
 *
 * A CAPPED `0/N` is four different situations wearing one face: proofs that never parsed, proofs
 * that parsed and named nothing, proofs whose execution errored, and a run that never had a checkout
 * to execute against. Telling them apart from the outside cost a full recon once (the markdown
 * code-span defect, PR #1037 0/4 and PR #1057 0/6); this makes the next one a one-line read.
 *
 * PURE and DIAGNOSTIC. It reads the verdicts it is given and returns a label — it never affects
 * `met`, `state`, the keyword floor, or whether the verdict is capped. Returns `undefined` when
 * nothing was capped, so the field is simply absent on a healthy verdict.
 */
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

/**
 * W1-T2544 — a `grep:` pattern WHOLLY enclosed in a matching pair of delimiters, which is a
 * Markdown formatting artifact and never what the author meant.
 *
 * `execWhitelistedProof` runs `grep -arn --` with NO `-F`, so a delimiter is a character that must
 * appear in the file. MEASURED on two consecutive retro cycles six hours apart: #3356 wrapped six
 * patterns in DOUBLE QUOTES and #3413 wrapped five in BACKTICKS; every wrapped pattern read 0 and
 * every bare one read 1 (and 0 at the merge base, so each discriminated once unwrapped). The
 * emitter wraps in whatever renders well in Markdown, so the delimiter is incidental and the check
 * must not special-case the two seen so far.
 *
 * DISTINCT FROM {@link parseWhitelistedProof}'s CODE-SPAN STRIP, which unwraps the WHOLE proof
 * (`` `grep: x in y` ``). This is the pattern INSIDE an otherwise well-formed proof
 * (`grep: `x` in y`), which parses perfectly and then matches nothing — so no parser can catch it.
 *
 * EXACT, NEVER A HEURISTIC (this gate refuses an author, so a false positive blocks a correct PR):
 * only a MATCHING pair with non-empty content between. A pattern that merely CONTAINS a delimiter,
 * or carries mismatched ones, returns undefined and passes untouched.
 */
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
  // House dialect (W1-T72) checked FIRST and EXCLUSIVELY: a proof WRITTEN with
  // a dialect label is handled ONLY by its own parser — success or refuse
  // (null) — and NEVER falls through to a legacy shape below. Falling through
  // would let a dialect body that fails ITS OWN safety check (or that names a
  // pattern which happens to contain a `test/*.test.ts`-shaped substring) get
  // silently reinterpreted via an unrelated legacy match over the same raw
  // text — e.g. `grep: TODO in test/foo.test.ts` must run the GREP, never get
  // swallowed by the legacy unanchored TEST_PATH_RE below into "run that whole
  // test file instead" (a different check than the one actually written).
  const trimmed = proof.trim();
  // A dialect proof wrapped in a markdown CODE SPAN is the same proof. `parseAcceptanceBlock`
  // extracts the bullet text verbatim, so an author who writes `` `grep: x in y` `` (rendering
  // identically to "grep: x in y" in every GitHub view) reached the matchers below with a leading
  // backtick, failed both, and fell through to `not_executable` — a CAPPED 0/N verdict on work
  // whose proofs are perfect. Measured: PR #1037 parsed 0/4 and PR #1057 0/6 this way, while
  // PR #1038's unwrapped proofs parsed 8/8.
  //
  // WHY THE STRIP IS A FALLBACK AND NOT AN ENTRY-POINT NORMALISATION. `GREP_FENCE_RE` (the legacy
  // W1-T65 shape, below) matches ``​`grep -rn x y`​`` and REQUIRES its backticks — stripping them up
  // front, here or in `parseAcceptanceBlock`, silently converts that proof to `null`. So the bare
  // text is tried first and the unwrapped text only if it fails, leaving every other consumer of
  // the extracted string — the claim text, `plan-pr-emitter`'s emptiness check, the legacy shapes —
  // reading exactly what the author wrote.
  const dialectSource = matchesDialectPrefix(trimmed) ? trimmed : stripCodeSpan(trimmed);
  const dialectTest = dialectSource.match(DIALECT_TEST_RE);
  if (dialectTest) return parseTestTarget(dialectTest[1]);
  const dialectGrep = dialectSource.match(DIALECT_GREP_RE);
  if (dialectGrep) return parseDialectGrep(dialectGrep[1]);
  // W1-T277: `demonstration:` is never executable, by construction — it names
  // an operator action, not an artifact this process can observe. Refuse
  // (null) rather than falling through to a legacy shape below; task-linter.ts
  // is what decides whether that null is a defect (verify:auto) or the whole
  // point (verify:human) — review.ts has no `verify` field to consult here.
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

/** Executes a {@link WhitelistedProof}'s argv and reports the outcome —
 * injectable so unit tests fake pass/fail/no-match/throw without touching the filesystem.
 * `"no-match"` (name-filtered proofs only): the run completed but ZERO tests matched the
 * pattern — the named test does not exist. That is NOT a failing test; the caller degrades
 * it to `not_executable` (the keyword floor), never a false `executed_fail`. */
export type ProofExecutor = (whitelisted: WhitelistedProof, cwd: string) => "pass" | "fail" | "no-match";

// W1-T112 round-4: 30s was observed live truncating a name-filtered proof's WHOLE-suite
// run before it ever reached the named test's file (see nameFilteredOutcome's doc
// comment) — widened for headroom. The truncation-detection fix above is the actual
// correctness guarantee; this just reduces how often it needs to engage.
// W1-T253 (P37 CONSUMERS) SUPERSEDES the exported literal this used to be: #916 exported
// `DEFAULT_PROOF_TIMEOUT_MS` so test/policy.test.ts's drift lock could compare the policy row
// against the literal. With the literal gone that comparison is impossible AND unnecessary —
// drift is structurally unreachable once the code reads the policy. policy.test.ts drops that
// one assertion (the other eight literals still exist and keep theirs); the stronger property
// is asserted in test/policy-consumers.test.ts.
//
// W1-T253 (P37 CONSUMERS): this is now a POLICY READ (plan/policy.yaml's `proofTimeoutMs`),
// never a source literal — the 60s above is DATA now, floored at load (policy.ts's
// `numberField`, min 60000 — the "30000 regression" the substrate refuses to accept), so a
// retune is a reviewed plan PR, not a code edit. `loadDefaultPolicy` self-locates
// plan/policy.yaml from this module's own install location (never cwd), so this default
// resolves identically no matter what directory `execWhitelistedProof` is called from.
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

/**
 * The ONLY env vars {@link defaultProofSpawner} lets through from whatever process happens to be
 * running the reviewer into a proof's child (W1-T499). `PATH` — a proof runs `node --test` in a
 * fresh worktree and shells out to `npm ci`, `grep` and a pinned Playwright CLI, all of which need
 * it to even be found (see {@link defaultProofSpawner}'s own doc for the "not `env: {}`" warning).
 * `HOME` — npm/git config and cache resolution (`~/.npmrc`, `~/.cache`, `~/.gitconfig`). The four
 * `GIT_CONFIG_*` names and `GIT_TERMINAL_PROMPT` — the git-identity variables
 * `test/entrypoint-boot.test.ts` already sets DELIBERATELY (see its `NO_GUESSED_IDENTITY` and its
 * `GIT_CONFIG_NOSYSTEM`/`GIT_TERMINAL_PROMPT` overrides) so that suite's own env narrowing keeps
 * working exactly as designed, rather than this allowlist silently shadowing it.
 *
 * Everything else — every `RMD_*` var a daemon happens to carry (e.g. `RMD_RESTART_THROTTLE_S`,
 * set by `deploy/host-update.sh` and read by `deploy/entrypoint.sh`, but present in NO GitHub
 * Actions workflow) chief among them — is EXCLUDED BY DEFAULT. That is the actual fix: a proof now
 * runs in a DECLARED environment instead of inheriting whichever orchestrator happened to launch
 * it, so the reviewer and CI can no longer reach different verdicts on the same sha for a reason
 * that has nothing to do with the diff.
 */
export const PROOF_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "GIT_TERMINAL_PROMPT",
] as const;

/** The `GIT_CONFIG_*` keys {@link buildProofEnv} only ever forwards TOGETHER (W1-T1096). The
 * allowlist names index 0 and nothing higher, so a parent's `GIT_CONFIG_COUNT` of two or more
 * describes pairs this allowlist cannot supply — git reads `GIT_CONFIG_COUNT` first and then
 * demands every `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` it names, so forwarding the count
 * without every pair it promises makes git exit 128 before doing any work, which is strictly
 * worse than forwarding no count at all (git's no-count fallback is its normal, working
 * resolution). */
const GIT_CONFIG_TRIPLE = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"] as const;

/** Build the DECLARED child environment {@link defaultProofSpawner} passes to a proof's process:
 * copies ONLY the {@link PROOF_ENV_ALLOWLIST} keys present on `parent` (default: this process's own
 * `process.env`, i.e. whatever orchestrator — daemon or a bare CLI invocation — is running the
 * reviewer), never `parent` wholesale. Exported so a test can compare the declared env two
 * differently-shaped orchestrator environments produce, without needing two real orchestrators.
 *
 * The {@link GIT_CONFIG_TRIPLE} is forwarded ONLY as a consistent unit (W1-T1096): this allowlist
 * can supply exactly one key/value pair (index 0), so the triple is only satisfiable when the
 * parent's `GIT_CONFIG_COUNT` is exactly `"1"` and both `GIT_CONFIG_KEY_0` and
 * `GIT_CONFIG_VALUE_0` are present — in every other shape (a higher count, or a count with no
 * index-0 pair) none of the three cross, never a partial forward that hands git a count it
 * cannot satisfy. */
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

/** Production {@link ProofSpawner}: no shell, stdout captured, hard timeout, and — since W1-T499 —
 *  a DECLARED env ({@link buildProofEnv}) rather than an implicit inherit of `process.env` whole.
 *  Before W1-T499 this passed no `env` key at all, so a proof silently inherited every variable the
 *  orchestrator happened to carry (daemon-only `RMD_*` vars chief among them — see
 *  {@link PROOF_ENV_ALLOWLIST}'s doc), which is exactly how the reviewer and CI could disagree on
 *  an identical sha. Exported (W1-T387) so `checkProofCommand` (src/run-task.ts) can wrap it to
 *  CAPTURE the raw stdout/exit status {@link execWhitelistedProof} observes — for its own
 *  diagnostics (argv, exit code, hit count) only, never for the verdict, which stays exactly what
 *  execWhitelistedProof decides.
 *
 *  `NODE_V8_COVERAGE: undefined` closes a side channel `buildProofEnv`'s allowlist alone can't:
 *  when THIS process itself has V8 coverage collection active (e.g. `coverage-ratchet`'s CI run),
 *  Node's own `child_process` module force-injects `NODE_V8_COVERAGE` into every spawned child —
 *  even one given an explicit `env` object that simply omits the key — because that omission reads
 *  as "unspecified", not "excluded". Naming the key here with an `undefined` value is the one form
 *  Node treats as an explicit exclusion, so a coverage-instrumented orchestrator (CI) and a
 *  non-instrumented one (the reviewer daemon) still hand a proof byte-identical envs. */
export const defaultProofSpawner: ProofSpawner = (command, args, cwd, timeoutMs) =>
  execFileSync(command, args as string[], {
    cwd,
    env: { ...buildProofEnv(), NODE_V8_COVERAGE: undefined },
    stdio: ["ignore", "pipe", "ignore"],
    timeout: timeoutMs,
    encoding: "utf8",
  });

/** `npm ci` a fresh checkout ONCE before its first test proof (design: "fresh
 * worktrees have no node_modules"). Best-effort: a failed/skipped install is never
 * a silent hard-fail here — the test command below will itself fail to run, which
 * surfaces as exec_error on that criterion, never a false pass. */
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

/**
 * The Chromium builds a `test` proof needs on THIS host, derived from the pinned
 * Playwright's own `browsers.json` — the same source `npx playwright install`
 * reads, so the two can never disagree about which revision is wanted.
 *
 * WHY THIS EXISTS (live incident, 2026-07-29, PR #892). `ci` runs
 * `npx playwright install --with-deps chromium` before EVERY test job
 * (.github/workflows/ci.yml). The review host runs it NEVER — its browser cache
 * is only ever populated by hand. So when #863 bumped `playwright` 1.61.1 →
 * 1.62.0, the wanted Chromium revision moved 1228 → 1234, the review host still
 * had only 1228, and every `chromium.launch()` in `test/serve.*.test.ts` died
 * with `Executable doesn't exist at …/chromium_headless_shell-1234/…`. Because a
 * whole-file `test` proof's verdict IS its exit code (see
 * {@link execWhitelistedProof}), that host-environment breakage was posted as
 * `executed_fail` — "proof executed and FAILED on the PR head" — on code that
 * `ci` was passing. W1-T202 burned FIVE identical FAIL rounds on it and its
 * author shipped two mitigations for a race that did not exist. This preflight
 * removes the asymmetry at its source: the review host installs what `ci`
 * installs, before it judges.
 *
 * Scoped to the Chromium family on purpose — `chromium` is the only browser this
 * repo's suites ever launch, and the only one `ci` installs. `ffmpeg` (also
 * pulled in by an `install chromium`) is deliberately NOT required here: it backs
 * video capture, which no proof uses, so demanding it would trigger a pointless
 * 180MB re-install on a cache that can already launch every test we have.
 *
 * The `-` → `_` rewrite is Playwright's own on-disk convention:
 * `chromium-headless-shell` rev 1234 lives in `chromium_headless_shell-1234`,
 * while `chromium` rev 1234 lives in `chromium-1234`.
 */
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

/**
 * Mirror `ci`'s browser-install step on the review host, ONCE per process, before
 * the first `test` proof runs. See {@link requiredChromiumDirs} for the incident
 * this closes.
 *
 * Best-effort by the same doctrine as {@link ensureDeps}: this never throws and
 * never decides a verdict. If the install fails or the manifest is unreadable,
 * the proof still runs and still reports whatever it reports — a preflight that
 * could itself fail a criterion would just relocate the false-FAIL problem it
 * exists to remove. What it returns is a FACT about what happened, so callers and
 * tests can assert on it:
 *   - `"ok"`          — every wanted build was already present; nothing spawned.
 *   - `"installed"`   — builds were missing and the install ran to completion.
 *   - `"failed"`      — builds were missing and the install threw.
 *   - `"unreadable"`  — the manifest could not be read, so "wanted" is unknown.
 */
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

/** The checkout's OWN Playwright CLI entry. Deliberately not `npx playwright`:
 * `npx` resolves a name, and on a cache miss will happily FETCH a different
 * Playwright than the one pinned in this checkout — which would install a browser
 * revision the tests do not want, i.e. the exact drift this preflight exists to
 * end. Running the pinned CLI with the already-running `node` binary pins both
 * halves. */
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

/**
 * Where Playwright keeps its browser builds. `PLAYWRIGHT_BROWSERS_PATH` wins when
 * set to a real path (it is how CI images relocate the cache); the literal `"0"`
 * means "inside node_modules" and is NOT a directory, so it falls through to the
 * platform default exactly as Playwright's own resolution does.
 */
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

/**
 * The three genuinely different answers to "which test file(s) could this
 * name-filtered proof's raw name live in?" — kept distinct because two of them
 * used to collapse into the same empty array, and acting on that ambiguity is
 * how a reviewer ends up accusing a plan author of naming a test that does not
 * exist when the truth is only that WE COULD NOT LOOK.
 *   - `resolved`  — grep found ≥1 candidate file. Narrow the run to just those.
 *   - `absent`    — a readable, non-empty test corpus was searched (proven by the
 *                   control probe in {@link resolveNameFilteredCandidates}) and
 *                   the name is in no test file, and no interpolated title could
 *                   plausibly render to it either. Positive evidence of absence;
 *                   safe to conclude `no-match` WITHOUT spawning the runner.
 *   - `unresolvable` — the lookup itself could not be trusted (grep missing,
 *                   `test/` absent or empty, the checkout never materialised, or
 *                   a template-literal title makes a fixed-string search
 *                   inconclusive). NOT evidence of anything: falls back to the
 *                   unchanged full-glob invocation.
 */
export type NameFilterResolution =
  | { status: "resolved"; files: string[] }
  | { status: "absent" }
  | { status: "unresolvable"; reason: string };

/** ERE matching a test declaration whose title is a TEMPLATE LITERAL carrying at
 * least one interpolation — the shape a fixed-string search structurally cannot
 * find, because the title that ends up in the TAP stream never appears verbatim
 * in the source. */
const INTERPOLATED_TITLE_RE = "(test|it|describe)\\(`[^`]*\\$\\{";

/** Shortest static run of a template title we will treat as identifying. Short
 * fragments (`" "`, `"'s "`, `": "`) appear in almost any prose and would make
 * every absent test look ambiguous, which would disable the fast path entirely. */
const MIN_STATIC_CHUNK_LEN = 12;

/** The literal (non-interpolated) runs of a template-literal test title, as seen
 * on one line of source: everything between the line's first and last backtick,
 * split on `${…}` holes. These are the ONLY substrings of the rendered title a
 * `grep -F` could ever have matched, so they are what we compare a proof's raw
 * name against when deciding whether an interpolated title might be its home. */
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

/**
 * Could `rawName` be the RENDERED title of some test declared with an
 * interpolated template literal? {@link resolveNameFilteredCandidates}'s
 * `grep -F` cannot see such a title (the source holds `${…}`, the TAP stream
 * holds the substituted value), so a zero-candidate result over a repo that
 * declares them is not automatically evidence of absence.
 *
 * Answers "maybe" only on positive evidence: some interpolated declaration has a
 * static chunk of real length that the proof's name actually contains. A repo
 * with no interpolated titles at all answers a confident "no" — that is the
 * common case and it keeps the fast path live. Only called once the corpus probe
 * has already established that the search itself is trustworthy.
 */
function couldBeInterpolatedTitle(cwd: string, rawName: string): boolean {
  let stdout: string;
  try {
    stdout = execFileSync("grep", ["-rhE", "--include=*.test.ts", "--", INTERPOLATED_TITLE_RE, "test"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
  } catch {
    // Only reached AFTER the corpus probe in resolveNameFilteredCandidates has already
    // established that grep runs and the test tree is readable, so a throw here can only
    // be grep's "no lines matched" — this repo declares no interpolated titles. A real
    // answer ("no"), not a failed lookup.
    return false;
  }
  return stdout.split("\n").some((line) => interpolatedTitleStaticChunks(line).some((c) => rawName.includes(c)));
}

/** `grep -rl -F` over the checkout's test files, as a plain list — or `null` when
 * grep did not produce one (no match, no `test/` tree, grep missing, unreadable
 * files). Deliberately does NOT interpret the exit code: MEASURED on macOS
 * 2026-07-29, BSD grep exits 1 with EMPTY stderr both for "searched, found
 * nothing" AND for "the directory does not exist", so the exit code cannot carry
 * that distinction. {@link resolveNameFilteredCandidates} draws it with a control
 * probe instead. */
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

/**
 * W1-T227: resolve the CANDIDATE test file(s) a name-filtered proof's raw name
 * could actually live in, so {@link execWhitelistedProof} can scope its `node
 * --test` invocation to just those files instead of blindly compiling
 * `--test-name-pattern` across the WHOLE suite glob ({@link TEST_GLOB}). Node
 * still LOADS every file in a glob before filtering by name regardless of how
 * few match — MEASURED live on a scratch clone of main: a narrowed run of one
 * proof against its own file alone completes in 0.2s; the full-glob load is
 * ~22s against a 60s timeout, leaving too little headroom on a machine already
 * running workers (the exact defect this task exists to close — the same
 * unchanged proof coins `executed_pass` on an idle host and `exec_error` on a
 * loaded one).
 *
 * Fixed-string (`grep -F`), never a regex: a name-filtered proof's raw name is
 * ordinary architect prose, not a pattern — the same reasoning
 * {@link parseTestTarget}'s `escapeRegExp` already applies to the
 * `--test-name-pattern` argument itself, applied here to the search that finds
 * candidate files.
 *
 * Returns a {@link NameFilterResolution}, not a bare list, because "found
 * nothing" and "could not look" are different claims about the world and only
 * the first of them licenses the caller's fast path. The line between them is
 * drawn by a CONTROL PROBE, not by grep's exit code: an identical search for the
 * empty pattern, which matches every line of every file it can read. If that
 * probe comes back with at least one test file then grep runs, `test/` exists,
 * it is readable, and it is non-empty — so a zero-hit search of the same corpus
 * is a real observation. If the probe comes back empty or throws, we did not
 * look at anything and say so. (The exit code cannot do this job: MEASURED on
 * macOS 2026-07-29, BSD grep exits 1 with empty stderr for BOTH "searched, found
 * nothing" and "that directory does not exist" — an earlier revision of this
 * function trusted exit 2 for the latter and was falsified by its own test.)
 */
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

/**
 * W1-T227's command builder: given a name-filtered proof's already-compiled
 * `baseArgs` (from {@link parseTestTarget}, trailing with {@link TEST_GLOB})
 * and the candidate file(s) {@link resolveNameFilteredCandidates} found, swap
 * the full glob for just those candidates. ZERO candidates returns `baseArgs`
 * verbatim, still globbed — reached ONLY for an `unresolvable` resolution,
 * where falling back to the unchanged (slow, possibly timing-out) full-glob run
 * is the honest thing to do because we have no evidence either way.
 *
 * Corrected 2026-07-29 (this file's own defect): the previous comment here
 * claimed zero candidates "CHANGES NOTHING" because "nameFilteredOutcome's
 * existing zero-match ⇒ 'fail' path fires identically either way (a wider
 * search finding nothing is exactly as conclusive as a narrower one)". BOTH
 * halves were false. Zero real matches on a COMPLETED run returns "no-match",
 * not "fail" (see {@link nameFilteredOutcome}), which the judge degrades to
 * `not_executable`. And the wider search does NOT finish: the full glob loads
 * every file including several that drive a real headless browser and hang
 * when the name filter matches none of their tests, so the run is killed at
 * the proof timeout and yields `exec_error` — no conclusion at all. That is
 * why {@link execWhitelistedProof} now decides `absent` BEFORE spawning
 * anything, and why only `unresolvable` still reaches this fallback.
 */
export function narrowNameFilteredArgs(baseArgs: readonly string[], candidateFiles: readonly string[]): string[] {
  if (candidateFiles.length === 0) return [...baseArgs];
  return [...baseArgs.filter((a) => a !== TEST_GLOB), ...candidateFiles];
}

/**
 * The REAL proof executor (production default): run a {@link WhitelistedProof}'s
 * argv, no shell, in `cwd`, with a HARD per-proof timeout — a hanging test must
 * never stall the required check into the absent-check deadlock class. Returns
 * `"pass"` on a clean exit 0; `"fail"` on a genuine clean nonzero exit — a
 * failing test, or a grep that LOOKED and found no match (exit 1): the proof
 * named something the PR head does not observably contain, which is the
 * criterion genuinely unmet, not an environment hiccup. THROWS when the
 * process never ran to a clean pass/fail exit at all — a timeout kill, a spawn
 * error like the command itself missing, so the caller surfaces `exec_error`
 * (a timeout must never be misjudged as an observed "fail") — AND (W1-T219,
 * recon R-13(iv)) when a `grep` proof exits 2: grep's own convention for
 * "could not look at all" (a since-renamed/missing target, a read error), as
 * opposed to exit 1's "looked and found nothing". Treating exit 2 as a genuine
 * FAIL false-blocked a criterion whose proof merely named a path that moved —
 * an environment/authoring problem, not evidence the criterion is unmet — so
 * it degrades to `exec_error` (the keyword floor) exactly like a thrown error.
 *
 * A PURE-PATH (single-file, non-name-filtered) `unit test:` PROOF'S OWN CLEAN
 * NONZERO EXIT ALSO THROWS NOW, when it is not a genuine named-test failure
 * (W1-T1077). MEASURED live on this exact command shape
 * (`node --test --import tsx --import <hygiene> <file>`): a genuinely FAILING
 * test reports a top-level `not ok` line naming the TEST'S OWN TITLE
 * (`code: 'ERR_ASSERTION'`); a BROKEN RUNTIME — an unresolvable `--import`
 * loader, an uncaught module-load error — reports a top-level `not ok` line
 * naming the FILE ITSELF (`not ok 1 - test/<file>.test.ts`,
 * `code: 'ERR_TEST_FAILURE'`), with no real subtest ever registering, and BOTH
 * shapes exit 1 identically. Before this fix the exit code alone decided
 * `"fail"` either way, so a run that never reached a verdict about the
 * criterion was refused as though it had. `pureTestNeverExecutedWrapperName`
 * reads the SAME TAP stdout already captured below for this reason: if every
 * `not ok` line is the file's own wrapper name ({@link isFileWrapperResultName},
 * the SAME predicate {@link nameFilteredOutcome} already uses for the
 * name-filtered branch below), the run never executed and this throws instead
 * of returning `"fail"` — degrading to `exec_error` at the caller exactly like
 * a timeout or a spawn error, never a false `executed_fail`. A genuine
 * `ERR_ASSERTION` on a real subtest is UNCHANGED: still `"fail"`, still hard.
 * An ABSENT file is also unchanged: `node --test` reports NO TAP output at all
 * for a missing path (measured: empty stdout, `Could not find '<path>'` on
 * stderr, which this function never reads), so
 * `pureTestNeverExecutedWrapperName` finds no wrapper name either and this
 * still falls through to `"fail"` — absence stays exactly as hard-refused as
 * before, outside W1-T456's own forward-reference carve-out (checked by the
 * caller, before this function is ever invoked).
 *
 * NAME-FILTERED PROOFS GO FURTHER STILL — the exit code is NEVER the verdict
 * for them, not even as a fallback (W1-T178, round 2): a bare TEST NAME
 * compiles to `--test-name-pattern` over the WHOLE suite glob
 * (`test/**\/*.test.ts`, {@link TEST_GLOB}), so the exit code reflects EVERY
 * file in that glob, not just the one named test a criterion cares about.
 * FIXTURE, hit live implementing this very task:
 * `test/serve.find.test.ts` runs its file-scope `after` (`browser.close()`)
 * even on a pattern that matched none of ITS tests, which turns the ENTIRE
 * glob's exit code nonzero.
 *
 * MECHANISM CORRECTED 2026-07-29, from live observation of that fixture. The
 * previous note here said "`before` is skipped, so `browser` is never
 * assigned". It is not skipped: `before` IS entered, `chromium.launch()` runs,
 * and a real `chrome-headless-shell` appears as a grandchild process. What
 * actually happens is a RACE — `after` fires at ~0.2ms, long before `launch()`
 * resolves, and throws on the still-undefined `browser`. Nothing ever closes
 * the browser that did launch, and its `--remote-debugging-pipe` holds the
 * event loop open, so the run does not merely exit nonzero: it HANGS until the
 * proof timeout kills it, leaking the browser. That is the cost this function's
 * fast path (below) exists to avoid, and it is why a zero-candidate name must
 * never be answered by running the glob "just to be sure".
 *
 * So for a name-filtered proof, the verdict is read from
 * {@link nameFilteredOutcome} parsing the TAP stream for the matched test's OWN
 * result line, never from the process exit code — on both the success path and
 * a thrown nonzero-exit's attached stdout.
 */
/**
 * (R-18) Thrown by {@link execWhitelistedProof} for a `grep:` proof whose argv names a target that
 * RESOLVES outside the checkout the proof is being run against. {@link judgeCriterion}'s catch maps
 * every throw to `exec_error` — the keyword floor, verbatim — so the refusal is CONTENT-INDEPENDENT:
 * the verdict reads the same whether the out-of-checkout file contains the pattern or not, which is
 * exactly what closes the one-bit oracle described in {@link assertGrepTargetsInsideCheckout}.
 * A `fail` here would leak the same bit in the other direction, so this is a throw, never a verdict.
 */
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

/**
 * (R-18) REFUSE a `grep:` proof whose argv would read OUTSIDE the checkout, before the spawn.
 *
 * THE DEFECT THIS CLOSES. {@link execWhitelistedProof} runs `grep` with cwd pinned to the PR-head
 * checkout, and grep FOLLOWS a symlink named on its own command line — so a symlink committed to
 * the head (`escape -> /`) makes any file the reviewer's uid can read a legal proof target, and the
 * proof's match/no-match verdict reports one bit about that file's CONTENT. Because a PR-body edit
 * re-earns review on the same head sha (CLAUDE.md, "A BODY REPAIR IS A NEW REVIEW INPUT"), that bit
 * is repeatable at will. {@link parseDialectGrep} refuses the two escapes it can SEE in the proof
 * text (`..`, an absolute path); a symlink is invisible there and the LEGACY fenced `` `grep …` ``
 * shape passes the author's own argv through untouched (`-f <file>` reads its PATTERNS from a file,
 * a second read of the same kind), so both are caught here instead, against the real filesystem.
 *
 * WHY EVERY NON-FLAG TOKEN, NOT JUST THE LAST ONE. The house dialect always compiles to
 * `["-arn", "--", pattern, path]`, but the legacy shape's argv is whatever the author typed, and
 * grep reads files from more than one position (`-f patternfile`, several trailing operands). A
 * token that does not exist on disk is SKIPPED rather than refused — a pattern is an ordinary
 * non-path string, and a genuinely missing target is already grep's own exit 2 ⇒ `exec_error`
 * (W1-T219), so nothing here needs to pre-empt it. `realpathSync` (not `resolve`) is what makes
 * this see through the symlink at all; `cwd` is realpath'd too so a checkout reached through a
 * symlinked parent (a `/tmp` fixture, a worktree under one) is not mistaken for an escape.
 */
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

/**
 * (R-12) Thrown by {@link execWhitelistedProof} for a house-dialect `grep:` proof whose target IS A
 * DIRECTORY in the checkout it is being run against. {@link grepProofTargetNamesNoFile} refuses the
 * directory SHAPE at parse (no extension on the final segment); a dotted directory name
 * (`plan/tasks.d`) passes that shape check, so it is refused here, against the real filesystem —
 * the same two-layer split R-18 uses for an out-of-checkout target. A throw, never a verdict:
 * {@link judgeCriterion}'s catch maps it to `exec_error` (the keyword floor), so a directory proof
 * is never certified `executed_pass` on the strength of `-r` finding one incidental line anywhere
 * beneath it, and never graded `discriminates` on a base tree it could not honestly be checked in.
 */
export class ProofTargetIsDirectoryError extends Error {
  constructor(readonly target: string) {
    super(`grep proof target \`${target}\` is a directory in this checkout — ${GREP_PROOF_FILE_TARGET_REQUIREMENT}`);
  }
}

/**
 * (R-12) Refuse a house-dialect `grep:` proof (`["-arn", "--", pattern, path]`) whose target
 * resolves to a directory under `cwd`. Restricted to that shape on purpose — the legacy fenced
 * `` `grep …` `` argv is the author's own and its operands are not reliably recoverable
 * (see `proofGrepPatternAndPath`, task-linter.ts). An ABSENT target is skipped: that is grep's
 * own exit 2 ⇒ `exec_error` (W1-T219), and pre-empting it here would change nothing.
 */
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
  // W1-T227: a name-filtered proof's `args` (from parseTestTarget) still carry
  // the FULL suite glob — resolve the actual candidate file(s) now, against
  // the real PR-head checkout, and narrow to just those before ever spawning
  // node. Not folded into parseWhitelistedProof itself: that function is a
  // pure parse with no `cwd`, and the candidate set can only be known against
  // a real checkout.
  let args = whitelisted.args as readonly string[];
  if (whitelisted.nameFiltered) {
    const resolution = resolveNameFilteredCandidates(cwd, whitelisted.label);
    // FAIL FAST on positive evidence of absence: no test file contains this name
    // and no interpolated title could render to it, so the glob run's only possible
    // finding is zero matches — the same "no-match" this returns, except reached by
    // loading 168 files, hanging on the browser-driving ones until the timeout kills
    // them, leaking a chrome-headless-shell, and then reporting `exec_error` (no
    // conclusion at all) instead. `unresolvable` is NOT evidence and never lands
    // here: it falls through to the unchanged full-glob invocation below.
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
    // W1-T2742: A TIMEOUT IS NOT A VERDICT, AND THE GUARD BELOW CANNOT SEE ONE. `execFileSync`
    // kills the child with SIGTERM at `timeoutMs`, but `node --test` TRAPS SIGTERM and shuts down
    // cleanly, so the error carries `status: 1`, `signal: null`, `killed: undefined` — MEASURED —
    // and reads as an ordinary nonzero exit. The line below therefore did not fire, and a proof
    // that merely ran longer than `proofTimeoutMs` was graded `executed_fail`, which OVERRIDES
    // keyword coverage and fails the PR on a criterion whose test passes. Node does set
    // `code: "ETIMEDOUT"` on the timeout error regardless of how the child exited, and that is the
    // one field that discriminates it, so it is checked FIRST and independently of `status`.
    // This restores what the doc comment above already promises: a timeout yields `exec_error` —
    // no conclusion at all — never a false `executed_fail`.
    if (err.code === "ETIMEDOUT") throw err; // ⇒ exec_error: ran out of time, concluded nothing
    if (typeof err.status !== "number") throw err; // killed by signal (timeout) / spawn error (ENOENT, …) ⇒ exec_error
    // A clean nonzero exit. For a name-filtered proof this does NOT necessarily
    // mean OUR named test failed (see the doc comment above) — read the TAP
    // stream node still attaches to the error rather than trusting the code.
    if (whitelisted.nameFiltered) {
      const stdout = typeof err.stdout === "string" ? err.stdout : (err.stdout?.toString("utf8") ?? "");
      return nameFilteredOutcome(stdout);
    }
    // W1-T219 (recon R-13(iv)): grep exit 2 means it could not even LOOK (a
    // since-renamed/missing target, a permission/read error) — distinct from
    // exit 1's "looked, found nothing". Only the latter is genuine evidence of
    // absence; the former degrades to exec_error (the keyword floor) rather
    // than false-blocking on an environment/authoring problem.
    if (whitelisted.kind === "grep" && err.status === 2) throw err;
    // W1-T1077: a PURE-PATH (non-name-filtered) `unit test:` proof's own clean nonzero exit is
    // NOT automatically a genuine fail either — see this function's doc comment for the measured
    // TAP shapes. Read the SAME stdout the name-filtered branch above already reads; only when
    // every `not ok` line is the file's own wrapper name (no real subtest ever reported) does the
    // run count as never-executed. An absent file reports NO TAP lines at all (stdout is empty),
    // so this finds no wrapper name and falls through to the unchanged `"fail"` below — absence
    // stays exactly as hard-refused as before.
    if (whitelisted.kind === "test" && !whitelisted.nameFiltered) {
      const stdout = typeof err.stdout === "string" ? err.stdout : (err.stdout?.toString("utf8") ?? "");
      // W1-T2740: AN INCOMPLETE RUN IS NOT A FAILING ONE, and it is read BEFORE the wrapper-name
      // classifier below on purpose — the two discriminators are orthogonal and this one is the
      // stronger. `runtime-broken` describes a run that COMPLETED (its fixture carries the
      // trailing summary) and whose only `not ok` names the file itself; a stream with NO summary
      // did not finish at all, whatever its `not ok` lines say, so classifying it by them would
      // name a cause the stream cannot support. MEASURED on PR #3719 (head 51d4958b): the proof
      // `unit test: test/retro-marker-atomic.test.ts` was posted `executed_fail` while the same
      // checkout passed all 33 tests in 127s unrestricted — killed at 60s, node reaped it with
      // `status: 1`, `signal: null`, no `not ok` line and no `# duration_ms`, so both guards above
      // (ETIMEDOUT, non-numeric status) missed it and the wrapper classifier found no wrapper.
      // NOT a request to raise `proofTimeoutMs`: a larger bound only moves the same false verdict
      // onto a slower file. The bound stays; its expiry now yields no conclusion instead of a lie.
      const completedResults = pureTestIncompleteRunResultCount(stdout);
      if (completedResults !== undefined) throw new PureProofIncompleteRunError(completedResults);
      const wrapperName = pureTestNeverExecutedWrapperName(stdout);
      if (wrapperName !== undefined) throw new PureProofNeverExecutedError(wrapperName);
    }
    return "fail"; // a single-file/grep proof's own nonzero exit is a genuine fail
  }
}

/**
 * (W1-T1077) Thrown by {@link execWhitelistedProof} for a pure-path `unit test:` proof whose only
 * failing TAP line names its own file wrapper ({@link pureTestNeverExecutedWrapperName}) — the run
 * never reached a verdict about the criterion. {@link judgeCriterion} recognises this via
 * `instanceof` and records BOTH the classification (`proof_skip: "runtime-broken"`) and the
 * wrapper name already parsed here — design (iv)'s "record the discriminator, not the stream": a
 * bounded fact on the ledger, never the raw TAP/stdout capture, which would be unbounded and would
 * carry the proof's runtime environment into a durable row.
 */
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

/**
 * (W1-T2740) Thrown by {@link execWhitelistedProof} for a pure-path `unit test:` proof whose run
 * emitted real subtest results and then stopped before node's trailing summary — an INCOMPLETE
 * execution, not a verdict. {@link judgeCriterion} recognises this via `instanceof` and records
 * `proof_skip: "incomplete-run"` plus the bounded discriminator already parsed here (how many real
 * results the stream did carry) — the same "record the discriminator, not the stream" rule
 * {@link PureProofNeverExecutedError} follows, for the same reason: a raw TAP capture is unbounded
 * and would carry the proof's runtime environment into a durable ledger row.
 */
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

/**
 * (W1-T2740) A pure-path `unit test:` proof's TAP stdout: the number of REAL (non-file-wrapper)
 * subtest results the stream carried when the run is INCOMPLETE — at least one real result
 * reported, NONE of them `not ok`, and no trailing summary ({@link hasFinalSummary}); `undefined`
 * otherwise. The three `undefined` cases are exactly the three shapes that must keep today's
 * behaviour, and each is a deliberate boundary of this task:
 *   - the stream HAS a final summary ⇒ the run completed; whatever it reports is a real answer,
 *     so {@link pureTestNeverExecutedWrapperName} and the caller's `"fail"` decide it, unchanged;
 *   - a REAL subtest reported `not ok` ⇒ an observed failure is evidence whether or not the run
 *     later finished — the same rule {@link nameFilteredOutcome} already applies to its own
 *     branch, so a genuine failure keeps overriding the keyword floor;
 *   - NO real result at all ⇒ nothing was observed to be incomplete. An ABSENT test path reports
 *     empty stdout (W1-T1077's own measurement), and empty stdout also has no final summary, so
 *     without this clause absence would be silently reclassified as a timeout — the one
 *     regression this task must not introduce.
 */
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

/**
 * (W1-T1077) A pure-path (single-file, non-name-filtered) `unit test:` proof's own TAP stdout: the
 * file's own wrapper name (`test/foo.test.ts`) when EVERY `not ok` line in the stream names the
 * file itself ({@link isFileWrapperResultName} — the SAME predicate {@link nameFilteredOutcome}
 * already applies to draw this exact line for the name-filtered branch, reused rather than
 * reimplemented) and no real subtest ever reported `not ok`; `undefined` otherwise — either a real
 * subtest genuinely failed (a real, named `executed_fail`, unchanged) or the stream carries no
 * `not ok` line at all (an absent file: MEASURED empty stdout, so nothing here to misread as a
 * wrapper failure — absence keeps falling through to the caller's ordinary `"fail"`, unchanged).
 */
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

/** The node test runner's own trailing summary block (`# tests N`, `# pass N`,
 * …, `# duration_ms N`) is written ONCE, after every file in the glob has
 * finished — it is the one reliable signal that a `--test-name-pattern` run
 * over {@link TEST_GLOB} ran to genuine completion rather than being cut off
 * mid-suite by {@link execWhitelistedProof}'s own timeout kill. */
function hasFinalSummary(stdout: string): boolean {
  return /^# duration_ms\b/m.test(stdout);
}

/**
 * Read a name-filtered `--test-name-pattern` run's TAP stdout for the verdict
 * of the REAL (non-file-wrapper) subtest(s) it actually matched, independent
 * of the overall process exit code (see {@link execWhitelistedProof}'s doc
 * comment for why the exit code alone is not trustworthy here).
 *   - zero real matches, run genuinely completed ⇒ "fail" (W1-T72 guard: a
 *     named test that does not exist on the PR head is unmet, never a silent
 *     pass via the trivial "0 children ⇒ ok" wrapper every non-matching file
 *     reports).
 *   - zero real matches, run was CUT SHORT before its trailing summary ⇒
 *     THROWS (W1-T112 round-4 fix). {@link TEST_GLOB} scopes a name-filtered
 *     proof to the WHOLE suite (100+ files, several driving a real headless
 *     browser), so {@link execWhitelistedProof}'s 30s timeout can fire before
 *     node ever reaches the one file the named test lives in — confirmed live
 *     against this exact repo: a timeout-killed run of this command reliably
 *     reports zero final-summary lines, i.e. genuinely never finished. On the
 *     old rule that truncation read identically to "test not found", ANY
 *     criterion whose test happened to sit late enough in the glob's
 *     (filesystem-order-dependent, not alphabetically guaranteed) discovery
 *     order intermittently failed for a test that demonstrably passes in
 *     isolation — the exact flap observed live on this PR's own head commit
 *     (fail → pass → fail, unchanged code). A truncated run is inconclusive,
 *     not evidence of absence: the caller's catch degrades it to exec_error
 *     (the keyword floor), never a manufactured FAIL.
 *   - at least one real match, none reporting `not ok` ⇒ "pass" (found before
 *     any truncation — real, positive evidence, kept even if the run was cut
 *     short afterward elsewhere in the glob).
 *   - at least one real match reporting `not ok` ⇒ "fail" — the named test
 *     genuinely failed, not merely swept up in unrelated collateral noise.
 * Collateral `not ok`/hookFailed lines from files the pattern never matched
 * (their names ARE file-wrapper names) are ignored entirely — they are not
 * evidence about the ONE test this proof named.
 */
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
    // ZERO tests matched the pattern and the run COMPLETED (a trailing summary is present, so
    // this is not a timeout). The named test does not exist — a proof-authoring mismatch, NOT a
    // failing test. Returning "fail" here (the pre-fix shape) minted a false `executed_fail` that
    // HARD-BLOCKED PRs whose real tests pass under a different name — #466/W1-T183 sat blocked a
    // day+ on exactly this. Report the distinct "no-match" so the caller degrades to the keyword
    // floor with a legible reason, never a false test failure.
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
   * base blob could NOT be read while `baseCwd` was built. A proof naming one of these was never
   * actually checked against the base, however healthy `baseCwd` itself looks, so it is graded
   * `base_unreadable` rather than credited with a discrimination nobody measured. Absent/empty ⇒
   * byte-identical to pre-W1-T460 behaviour for every proof. */
  baseUnreadablePaths?: ReadonlySet<string>;
  /** (R-11) mirrors {@link ReviewEvidence.baseIsCheckout} — `true` only when `baseCwd` is a real
   * checkout of the merge-base (a worktree), the one tree a `unit test:` proof can be re-run in.
   * Absent/false ⇒ every `unit test:` proof's base outcome is `base_unknown` (fail closed), and
   * `grep:` proofs behave exactly as before. */
  baseIsCheckout?: boolean;
  /** (W1-T456, DEFECT A) Repo-relative paths a `unit test:` proof may forward-reference without
   *  being scored `executed_fail` — the union of {@link shardDeclaredFilesInDiff}'s read of THIS
   *  diff's own added shard(s) and (when a task id resolved) that task's declared `files:`.
   *  Absent/empty ⇒ every exact-path `unit test:` proof naming an absent file stays
   *  `executed_fail`, byte-identical to pre-W1-T456 behavior. */
  forwardReferenceFiles?: ReadonlySet<string>;
  /**
   * (W1-T2737) True when THIS diff changes only plan/docs — a FILING PR. Supplied from the same
   * `planOnly` {@link judgeReview} already computes, never re-derived.
   *
   * WHY THE GREP CARVE-OUT NEEDS IT AND THE `unit test:` ONE DOES NOT. `forwardReferenceFiles` is
   * the union of this diff's own shard `files:` AND a resolved task's declared `files:`, so on the
   * BUILD PR the same paths are declared. The `unit test:` arm is filing-scoped by its
   * `!existsSync` half — once built, the suite exists and the carve-out stops applying. A
   * call-site grep has no equivalent tell: the CONSUMER file exists in both worlds and only the
   * CALL is missing. Without this flag the grep carve-out would excuse a build PR that shipped the
   * module unwired — the exact class W1-T2732 counted four of. Absent ⇒ treated as false, so every
   * caller that predates this task keeps today's grading byte for byte.
   */
  planOnlyDiff?: boolean;
}

/**
 * (W1-T273, extended to `unit test:` proofs by W1-T362) Does a proof that just
 * PASSED on the PR head ALSO pass on the PR's MERGE-BASE — i.e. would it have
 * exited 0 before the task's own work ever landed? THE LIVE DEFECT THIS
 * CLOSES (grep side): W1-T267's fifth criterion carried
 * `grep: workerKeychainPaths in src/run-task.ts`; run against the commit
 * BEFORE #1026 implemented the task, that pattern already returned two hits
 * (an import line, an unrelated daemon rung) and exited 0 — the review
 * executed criterion 5 and recorded it `executed_pass` on completely unbuilt
 * work. A proof is supposed to discriminate between done and not-done; one
 * that ALSO matches/passes at the merge-base discriminates nothing, and
 * `executed_pass` POSITIVELY OVERRIDES the keyword floor, so a
 * non-discriminating proof is strictly worse than a prose one (it certifies
 * with more confidence than the floor it replaces, on strictly less
 * evidence). THE SAME DEFECT, unit-test shape (W1-T362): a `unit test:`
 * proof that passes identically at head AND base proves the diff changed
 * nothing the test observes — recorded `executed_pass` regardless, exactly
 * as the grep case was before W1-T273.
 *
 * `kind: "test"` needs one more distinction `kind: "grep"` does not: a
 * `unit test:` proof legitimately names a test file/name that does not exist
 * yet at the merge-base (that is the whole point of TDD — the test is
 * written FORWARD-referencing the work). {@link classifyBaseProofOutcome}
 * treats "the base run did not pass" (absent, no-match, or a genuine
 * failure) as `"discriminates"` — the OPPOSITE of stale — never conflating
 * "did not exist before" with "already matched/passed before"; only the
 * second is the defect. A `kind: "grep"` proof's forward-reference case
 * (a path the branch itself creates) already falls out of the same rule:
 * `grep` simply finds no match on a path absent at the base.
 *
 * Returns `false` (never stale) whenever no `baseCwd` was supplied — this
 * check is purely additive and never runs, let alone downgrades anything, for
 * a caller that predates W1-T273's wiring — and whenever the base checkout
 * itself throws (an unreadable/absent merge-base checkout, or a base tree that
 * simply cannot run a `node --test` invocation at all) is an environment gap,
 * not a finding; degrades to "not stale" exactly like `exec_error` degrades
 * elsewhere in this module — never a silent hard-fail. (R-11) The base tree is
 * a real detached worktree at the merge-base since `buildBaseProofDir`
 * (run-task.ts) learned to add one; {@link materialiseBaseProofBlobs} is the
 * fallback for a worktree that cannot be created, and in that fallback a
 * `unit test:` proof is `base_unknown` by construction (see
 * {@link ProofExecContext.baseIsCheckout}).
 */
/**
 * Materialise, into a throwaway directory, ONLY the base-revision blobs a review's `grep:` proofs
 * name — the cheap stand-in for a second checkout that {@link preexistingProofHits} needs.
 *
 * (R-11) THE FALLBACK, NO LONGER THE DEFAULT. impl-GE chose blobs over a second worktree when only
 * a `grep:` proof could be judged stale (41 of 644 dialect proofs at the time). W1-T362 then
 * extended the staleness check to `unit test:` proofs — the other 599 — and a blob directory is a
 * tree `node --test` cannot run in, so every one of them was re-run in a directory with no
 * `package.json` and no `test/`, exited 1 with empty stdout, and was graded "discriminates".
 * `buildBaseProofDir` (run-task.ts) now adds a real detached worktree at the merge-base and reaches
 * this function ONLY when that worktree cannot be created; in that fallback a `unit test:` proof
 * is graded `base_unknown` (never `discriminates`) via {@link ProofExecContext.baseIsCheckout}.
 *
 * A PATH ABSENT AT THE BASE IS SIMPLY NOT WRITTEN, which is the FORWARD-REFERENCE case and must not
 * be confused with staleness: a proof naming a file the branch creates correctly finds nothing here,
 * so `grep` reports no match and the proof is NOT flagged. "Did not exist before" and "already
 * matched before" are opposite conditions; only the second is the defect.
 *
 * Best-effort throughout: an unresolvable rev or an absent path skips that one path rather than
 * throwing inside a review. A missing file degrades to "not stale", never to a false positive.
 *
 * (W1-T460) ABSENCE AND A BROKEN READ ARE NO LONGER THE SAME EVENT. This catch used to swallow
 * both — its own comment said so — and the three hops downstream turned that silence into credit:
 * the blob is not written, the base grep over the missing file returns no-match,
 * {@link classifyBaseProofOutcome} grades no-match as `"discriminates"`, and {@link judgeCriterion}
 * scores anything-but-`"stale"` as `executed_pass`. So a proof whose base read FAILED was recorded
 * as one PROVEN to discriminate. Absence keeps its carve-out (it is the healthy forward-reference
 * case every filing PR depends on — see {@link baseBlobErrorIsAbsence} for how the two are told
 * apart); a genuine read failure is now RETURNED, per path, so the proof it belongs to can be
 * graded honestly instead of silently upgraded.
 */
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

/**
 * (W1-T460) The compiled argv for a `grep:` proof is `["-arn", "--", <pattern>, <path>]` — the path
 * is the LAST element, taken from the COMPILER rather than re-parsed from the proof text, so the
 * two can never disagree. Shared by {@link materialiseBaseProofBlobs} (which keys the unreadable
 * set by it) and {@link classifyBaseProofOutcome} (which looks a proof up in that set), so a
 * materialised blob and the proof it belongs to are matched BY CONSTRUCTION rather than by two
 * hand-rolled extractions that could drift apart. `undefined` for any non-`grep:` proof: only
 * `grep:` proofs ever get a base blob materialised for them.
 */
function grepProofTargetPath(whitelisted: WhitelistedProof): string | undefined {
  if (whitelisted.kind !== "grep") return undefined;
  return whitelisted.args[whitelisted.args.length - 1];
}

/**
 * (W1-T1071) Is an ALREADY-STALE `grep:` proof a FILING-TIME SELF-PATH proof read on the diff
 * that BUILDS the task, rather than an ordinary code grep that happened to stop discriminating?
 * The house convention this recognises (measured live across the plan, `plan/tasks.d/*.yaml`):
 * a criterion whose proof greps a distinctive line of the shard's OWN rationale/design prose
 * back out of its OWN `plan/tasks.d/<id>-<slug>.yaml` — e.g. `grep: the outlier population has
 * more than one member in plan/tasks.d/W1-T1039-a-burned-id-becomes-the-ceiling.yaml`. That
 * proof is honest on the FILING PR (the shard's text is absent from the merge-base and present
 * on the head — it discriminates the ONE thing it can: "was this shard filed"). Once the shard
 * merges, the same pattern sits in the merge-base of every PR that comes after, including the
 * PR that builds the task the shard describes — `classifyBaseProofOutcome` correctly reports
 * `"stale"` there, and this predicate names WHY: the proof was never about the code at all.
 *
 * TWO conditions, both required, matching design (iv)/(v):
 *   1. The target is shaped like a plan-shard path ({@link SHARD_PATH_RE}) — an ordinary code
 *      grep (`grep: foo in src/lib/bar.ts`) that independently drifted stale is a DIFFERENT,
 *      pre-existing situation this task does not touch; it keeps degrading to `executed_stale`.
 *   2. `declaredFiles` — {@link ProofExecContext.forwardReferenceFiles}, this diff's OWN task's
 *      declared paths — names something OTHER than the target. This is the BY-CONSTRUCTION
 *      exemption design (v) requires for the shards whose entire deliverable IS their plan text:
 *      such a shard's `files:` holds nothing but that same plan path, so it never has a path
 *      "the proof does not name" and this predicate returns false for it, structurally, with no
 *      id ever hardcoded. A shard with a real code/test deliverable besides its plan path always
 *      has one, so the refusal below is reachable for exactly the 29-shard population this task
 *      is filed against and never for the 3 that are plan-text-only by design.
 */
function staleProofIsSelfPath(whitelisted: WhitelistedProof, declaredFiles: ReadonlySet<string> | undefined): boolean {
  const target = grepProofTargetPath(whitelisted);
  if (target === undefined || !SHARD_PATH_RE.test(target)) return false;
  if (!declaredFiles) return false;
  for (const p of declaredFiles) {
    if (p !== target) return true;
  }
  return false;
}

/**
 * (W1-T460) Did `git show <rev>:<path>` fail because the path is NOT IN THAT REV, or because the
 * read itself broke? MEASURED against the installed git (and locked by
 * test/base-blob-read-failure.test.ts Group 0, so a git upgrade that moves these shapes turns red
 * rather than silently reverting to "swallow everything"):
 *
 *   path absent at the rev  →  `code` undefined, `status` **128**  (git ran and answered "not there")
 *   maxBuffer overflow      →  `code` **"ENOBUFS"**, `status` null (the read never completed)
 *
 * `status === 128` with NO Node `code` is therefore git's own answer and the only shape treated as
 * absence. Git emits two different absence MESSAGES — `does not exist in '<rev>'` when the path is
 * absent from the worktree too, `exists on disk, but not in '<rev>'` when the branch created it —
 * but BOTH carry `status: 128`, so the distinction is cosmetic and this predicate deliberately
 * never reads the message text.
 *
 * FAILS CLOSED, and that direction is deliberate: anything unrecognised (a bare `Error`, a spawn
 * failure, a fake in a test) is a READ FAILURE, not absence. Mis-classifying a broken read as
 * absence re-creates the exact defect this task fixes — silent credit — while mis-classifying
 * absence as a broken read only withdraws a proof's positive override and falls back to the
 * keyword floor.
 */
export function baseBlobErrorIsAbsence(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const err = e as { status?: unknown; code?: unknown };
  // A Node error code always wins: `spawnSync` sets it only when the spawn/read itself failed.
  if (err.code !== undefined) return false;
  return err.status === 128;
}

/**
 * (W1-T362) The three ways a proof that already PASSED on the PR head can land when
 * {@link preexistingProofHits}/{@link judgeCriterion} re-run it against the PR's merge-base:
 *   "stale"         — the base run ALSO exits pass; the proof discriminates nothing (downgrade).
 *   "discriminates" — the base run exits anything else (fail / no-match / absent) — the proof
 *                      genuinely tells done from not-done; `executed_pass` stands.
 *   "base_unknown"  — the base run itself threw (unreadable/absent merge-base checkout, a
 *                      `unit test:` proof's base tree that cannot even run `node --test`, …) — an
 *                      environment gap, never evidence either way; `executed_pass` stands, exactly
 *                      like `exec_error` degrades elsewhere in this module. (R-11) ALSO every
 *                      `unit test:` proof whose `baseCwd` is not a real checkout (`baseIsCheckout`
 *                      absent or false — the blob-only fallback): the run is not attempted, because
 *                      "no file here" is not "did not pass before the work".
 *   "base_unreadable" — (W1-T460) a base tree EXISTS, but THIS proof's base blob never reached it
 *                      because {@link materialiseBaseProofBlobs} could not read it. The base run is
 *                      not even attempted: a grep over a blob that was never written answers "no
 *                      match" for a reason that has nothing to do with the PR, and grading that
 *                      silence `"discriminates"` is precisely the defect W1-T460 fixes.
 *
 * WHY THIS IS NOT `base_unknown`, THE CRUX OF W1-T460: `base_unknown` is a GLOBAL gap — no base
 * tree, so no proof in the review could be checked and letting `executed_pass` stand costs nothing
 * that was ever available. `base_unreadable` is a PER-PROOF gap: the tree is right there, sibling
 * proofs were genuinely discriminated against it, and only this one was exempted. Same shape, very
 * different facts, so they must not report as the same value.
 *
 * A SINGLE execution against `baseCwd` answers both "is it stale" and "why not, if not" — a second
 * base run would double this check's own cost on top of the base-run cost W1-T273 already pays.
 */
function classifyBaseProofOutcome(
  whitelisted: WhitelistedProof,
  exec: ProofExecutor,
  baseCwd: string,
  baseUnreadablePaths?: ReadonlySet<string>,
  baseIsCheckout?: boolean,
): "stale" | "discriminates" | "base_unknown" | "base_unreadable" {
  const target = grepProofTargetPath(whitelisted);
  if (target !== undefined && baseUnreadablePaths?.has(target)) return "base_unreadable";
  // (R-11) A `unit test:` proof can only be re-run in a REAL checkout of the base. In the blob-only
  // fallback (or for a caller that never said what `baseCwd` is) `node --test` finds no file, exits
  // 1 with empty stdout, and the executor returns "fail" — which the line below would grade
  // `discriminates`, certifying a test that passes identically at both commits. That run answered
  // nothing about the base, so it is `base_unknown`, never evidence. Fails closed on an absent flag.
  if (whitelisted.kind === "test" && baseIsCheckout !== true) return "base_unknown";
  try {
    // Only a run that genuinely COMPLETED with a non-pass result discriminates. A base run that
    // could not execute at all — a spawn ENOENT, a timeout (ETIMEDOUT), the two W1-T1077/W1-T2740
    // `PureProof…Error` classes for a runner that never reached a real subtest or stopped before
    // its summary (a base worktree whose `npm ci` priming failed lands here: `--import tsx` cannot
    // resolve, the file's own TAP wrapper is the only `not ok`) — THROWS out of `exec` and is
    // caught below as `base_unknown`. None of those is evidence that the proof told done from
    // not-done.
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
  /**
   * (W1-T1100) True when `reportTokens` was tokenized from a SUBSTITUTE — the worker's own chat
   * text, not the PR body — because `fetchPrBodyFn` failed. A worker naturally echoes a proof's
   * own vocabulary while describing the change it just made, so keyword coverage over a
   * substitute is not evidence the BODY substantiates anything; it is evidence the worker can
   * read its own diff. See {@link ReviewEvidence.reportIsSubstitute}'s doc for the measured #2395
   * fixture. Real, WHITELISTED proof EXECUTION below is unaffected — it observes repo state, not
   * report text, so it can still flip a criterion to `executed_pass` regardless of this flag.
   */
  reportSubstituted?: boolean,
  /**
   * (W1-T2263) A bounded trailing clause the fresh reviewer attached to a FAIL line naming
   * what would answer the claim — see {@link parseReviewerVerdictClauses}. Consulted ONLY
   * when `semantic === false && met` (the downgrade arm below): it never rescues a proof
   * (the arm stays downgrade-only) and never annotates a PASS (Q3 — the ask is a clause on
   * the existing FAIL line, not new prose elsewhere). `undefined` when the reviewer supplied
   * no clause, leaving today's constant reason text as the whole appended note.
   */
  semanticClause?: string,
  /** WHY `reportSubstituted` is true -- consulted ONLY for the refusal's wording, never for the
   *  verdict. See {@link ReviewEvidence.reportSubstituteCause}. */
  reportSubstituteCause?: ReportSubstituteCause,
  /**
   * WHICH TEXT OF THE CRITERION SUPPLIES THE FLOOR'S KEYWORDS. The floor's *source* is always the
   * REPORT (`reportTokens`, the PR body) — that is the only text the author writes independently
   * of the criterion, so it is the only text whose agreement is evidence of anything.
   *
   * W1-T2713 established the real defect and this parameter carries its fix: on a plan-only PR
   * whose criteria were resolved from the task SHARD, scoring `proofKeywords(criterion.proof)`
   * makes a test FILENAME's accidental vocabulary decide the only binding lane (MEASURED on
   * #3665: 4/6 = 0.667, clearing MIN_COVERAGE only because the path was named after four words
   * the body happened to use; rename the file and the same PR fails). `unit` and `test` are dead
   * weight in every such denominator.
   *
   * W1-T2713 SHIPPED THAT FIX AS `floorTokens = tokenize(claim + proof)` — drawing the floor from
   * the CRITERION ITSELF. A criterion trivially contains its own proof, so coverage was 1.0 BY
   * CONSTRUCTION and every resolved-shard criterion read `met` against ANY body, an EMPTY one
   * included (recon-2026-09-05 R-15). That defeats the shard's own third acceptance claim — "a
   * filing that genuinely fails to substantiate its criteria still fails" — and its falsifier,
   * which refuses any change that "exempts plan-only PRs from the floor entirely without a
   * control proving an unsubstantiated filing still fails". The floor may never read the text it
   * is judging.
   *
   * SO THE ARM KEEPS SCORING AGAINST THE BODY AND CHANGES ONLY WHICH KEYWORDS IT SCORES: the
   * CLAIM's. A claim is prose the author wrote about the change and a body is prose the author
   * wrote about the change — a fair pair — while the proof's filename is the accident W1-T2713
   * measured. An empty or unresponsive body now scores 0/N and FAILS, which is the property R-15
   * says was missing. All existing/direct callers default to `proof`; only {@link judgeReview}'s
   * narrow resolved-shard + plan-only arm selects `claim`.
   */
  floorKeywords: "proof" | "claim" = "proof",
): CriterionVerdict {
  const base = { claim: criterion.claim, proof: criterion.proof };

  // ARCHITECT-ONLY `satisfied_by`: a criterion already satisfied by an EARLIER PR is
  // MET, cited to that PR. The reviewer judges diff+report, never repo state, so
  // without this an earlier-PR criterion is permanently unsatisfiable by a later PR.
  // (Setting this is a human/Architect act in a plan PR — never a worker's own edit.)
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
    // W1-T219 (recon R-13(ii)): was an UNCONDITIONAL met=true — a proof written
    // entirely in short/stopword/numeric tokens (no distinctive anchor at all)
    // auto-passed with no report engagement whatsoever, fail-OPEN and reachable
    // by any author (accidentally or not; PR #123 had none). This mechanical
    // floor cannot observe anything for such a proof, so — the same
    // cannot-observe-implies-do-not-act move this codebase already makes on the
    // read path (W1-T119's `indeterminate`) — it resolves to UNMET/INDETERMINATE,
    // never a free pass. Per the module's own law ("a semantic verdict may only
    // downgrade, never rescue an unpasted proof"), `semantic` cannot rescue this
    // either: real, WHITELISTED execution below (a `grep:`/`unit test:` dialect
    // match) is the only thing that can still flip this to executed_pass —
    // OBSERVED repo-state evidence, never vibes.
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
      // W1-T1100 (design (iii)): the floor may not report substantiation off a substitute, in
      // EITHER direction of coverage — a high-coverage substitute is the #2395 fail-OPEN case
      // (the worker describes its own change in the proof's own words), not evidence the body
      // substantiates anything. Rest on what proofs actually EXECUTED (below, unaffected) and
      // name the missing body as the reason the floor cannot say more.
      met = false;
      // THE VERDICT IS UNCHANGED -- `met` is false in every branch below, and coverage stays
      // withheld in EITHER direction (the #2395 fail-open case this rule exists to refuse; the
      // 6/6-coverage row on 2026-08-25 is the proof it is working). Only the WORDING branches, and
      // it must not imply a fetch failed: on the measured population the fetch has never failed
      // once, while "this mode never reads the body" is the common case.
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

  // WHITELISTED PROOF EXECUTION (W1-T65 — lifts W1-T3F's observation into the
  // FLOOR): when a PR-head checkout dir is given AND the proof names an executable
  // check, RUN it and let the OBSERVED result override the keyword floor above in
  // BOTH directions:
  //   executed_pass ⇒ MET, even if the report never claimed it (kills #100).
  //   executed_fail ⇒ UNMET, even if the report keyword-claimed it (kills W1-T51).
  // exec_error DEGRADES to the keyword floor computed above, verbatim — never a
  // silent hard-fail, never a stall.
  let proofExec: ProofExecOutcome = "not_executable";
  // W1-DH: WHY a criterion did not execute. `proof_exec: "not_executable"` alone conflates a proof
  // that never PARSED with one that parsed and named nothing — and a CAPPED 0/N verdict looked
  // identical either way, which is what made the code-span defect above cost a whole recon to find.
  let proofSkip: ProofSkipReason | undefined;
  if (execCtx) {
    const whitelisted = parseWhitelistedProof(criterion.proof);
    if (whitelisted) {
      proofSkip = undefined;
      // W1-T456 (DEFECT A), checked BEFORE spawning anything: an exact-path `unit test:`
      // proof (never a name-filtered one — see the module doc's `not_yet_built` entry) whose
      // target is ABSENT on the head but DECLARED by this diff's own plan shard is a forward
      // reference to the implementation a LATER PR will add, not a failure. Spawning `node
      // --test` on it would exit nonzero ("Could not find '<path>'"), which the branch below
      // reads as a genuine `executed_fail` — exactly the hard block that made a filing PR
      // unrepairable. Gated on `!nameFiltered`: a bare test-NAME proof has no single target
      // path to look up in `files:`, so it is untouched and keeps today's behavior.
      const forwardReference =
        whitelisted.kind === "test" &&
        !whitelisted.nameFiltered &&
        execCtx.forwardReferenceFiles?.has(whitelisted.label) === true &&
        !existsSync(join(execCtx.cwd, whitelisted.label));
      // W1-T2737: the same forward-reference judgement for the dialect `callSiteViolations`
      // MANDATES. Computed here beside its `unit test:` sibling so the two conditions read
      // together, but CONSUMED only in the post-execution failure branch below — see there.
      // `planOnlyDiff` is the filing-scope half; an UNDECLARED path yields `undefined` and keeps
      // blocking, verbatim (W1-T456: "NEVER assigned when the named path is simply absent and
      // UNDECLARED").
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
              // W1-T460: the base tree exists and sibling proofs were checked against it, but THIS
              // proof's base blob never arrived — so its head-side pass proves nothing about
              // discrimination. Withdraw the positive override and fall back to the keyword floor
              // verbatim (`met`/`reason` as computed above), exactly like `executed_stale` degrades.
              // NOT a failure: we did not learn the proof is bad, we learned we never asked.
              proofExec = "base_unreadable";
              reason =
                `${reason} — NOTE: proof PASSED on the PR head ` +
                `(${whitelisted.kind}: ${whitelisted.label}) but its base blob could not be read, so the ` +
                `merge-base staleness check never ran for THIS proof (the base tree itself exists and ` +
                `other proofs were checked against it); positive override withdrawn, keyword floor applied`;
            } else if (baseOutcome === "stale" && staleProofIsSelfPath(whitelisted, execCtx.forwardReferenceFiles)) {
              // (W1-T1071) The stale match is not an ordinary non-discriminating grep — its
              // target is a plan-shard path (see `staleProofIsSelfPath`'s doc), and this diff's
              // own task declares a REAL path besides it, so this task has an implementing diff.
              // A self-path grep only ever discriminated by proving the shard's OWN filing text
              // was present — the exact thing that is now permanently true at the merge-base too.
              // `executed_stale`'s ordinary degrade would let a report that never engages the
              // real, now-built behaviour slip through on keyword coverage of the OLD plan prose.
              // Refuse instead, by name: `met` is forced false regardless of the keyword floor,
              // never merely withdrawn.
              proofExec = "stale_self_path";
              met = false;
              reason =
                `proof unmet: REFUSED — proof (${whitelisted.kind}: ${whitelisted.label}) is a filing-time ` +
                `self-path proof (it greps this diff's own plan shard, which now also matches at the PR's ` +
                `merge-base) — it discriminated the PR that FILED the task and cannot discriminate the PR ` +
                `that BUILDS it; rewrite this proof to name the behaviour this diff builds, not the plan ` +
                `text that filed it`;
            } else if (baseOutcome === "stale") {
              // The SAME check also matches/passes on the PR's MERGE-BASE — it
              // would have exited 0 before this task's work ever landed, so
              // its exit-0 here discriminates nothing. See
              // {@link classifyBaseProofOutcome}'s doc for the full design; `met`/
              // `reason` are LEFT UNTOUCHED (the keyword floor computed above
              // stands, verbatim) — the proof's positive override is withdrawn,
              // never converted into a failure.
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
            // ZERO tests matched the proof's name pattern (the run completed — see
            // nameFilteredOutcome). W1-T161/#349: this is EITHER a proof-authoring
            // mismatch (the house convention writes a `unit test:` proof as PROSE
            // describing a test's behavior, not its literal name — see
            // looksLikeProseDescription's doc comment for the #349 fixture) OR
            // genuine test theater (a proof naming a specific, fabricated test).
            // The two are told apart by a deterministic shape check over the body,
            // never by re-running anything or calling a model.
            if (looksLikeProseDescription(whitelisted.label)) {
              // A prose paraphrase, not a bare name: NOT a failing test. Degrade to
              // `not_executable` (the keyword floor stands as computed above —
              // `met`/`reason` from mechanical coverage), and ANNOTATE why, so an
              // author sees "names no matching test" rather than a misleading
              // "executed and FAILED" — a false block on green, test-passing code.
              proofExec = "not_executable";
              proofSkip = "prose-no-match";
              reason = `${reason} — NOTE: proof names no matching test (0 tests matched '${whitelisted.label}'); not executed, keyword floor applied`;
            } else {
              // W1-T72's test-theater guard, PRESERVED: the body reads as a bare,
              // concrete test NAME (short, no sentence punctuation) rather than a
              // prose description, and it matches nothing on the PR head — a
              // fabricated test name is theater and must FAIL, never silently
              // degrade to the keyword floor.
              proofExec = "executed_fail";
              met = false;
              reason = `proof names a specific test that does not exist on the PR head (0 tests matched '${whitelisted.label}') — test theater, not executed`;
            }
          } else if (grepForwardReferenceTarget !== undefined) {
            // W1-T2737: the grep half of W1-T456's carve-out. `callSiteViolations`
            // (task-linter.ts) REQUIRES a task creating a src/ module to carry
            // `grep: <symbol>( in <the file that calls it>` — the only dialect that can express
            // "a DIFFERENT file calls this symbol" — and on the filing that symbol cannot exist,
            // so the branch above graded the prescribed remedy `executed_fail` and failed the PR
            // on it. MEASURED on W1-T2716 (merged): that one proof failed the PR alone while its
            // six `unit test:` siblings read `not_yet_built`, and the author dropped the wiring
            // criterion to merge.
            //
            // REACHED ONLY AFTER EXECUTION, never before it, which is what makes "the symbol is
            // absent from that path on the head" the EXECUTOR's answer rather than a second
            // implementation of the match. A grep that can pass is therefore never intercepted.
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
            // plus the file-wrapper name execWhitelistedProof already parsed, so a `review.posted`
            // row can say WHICH of "real failure" / "broken runtime" a failed pure-path proof was,
            // never the raw TAP capture (unbounded, and it would carry the run's environment into
            // a durable ledger row).
            proofSkip = "runtime-broken";
            reason =
              `${reason} — NOTE: proof's file (${e.wrapperName}) never reached a real subtest — its ` +
              `own TAP wrapper reported the failure (a broken runtime: an unresolvable --import ` +
              `loader, an uncaught module-load error, …), not the named test; not executed, keyword ` +
              `floor applied`;
          } else if (e instanceof PureProofIncompleteRunError) {
            // W1-T2740, the same design rule as the sibling arm above: record the DISCRIMINATOR,
            // never the stream. The bounded fact is that node's own completion signal is absent
            // after N real results — enough for a `review.posted` row to say WHY a pure-path proof
            // reached no conclusion, without carrying the TAP capture into a durable row.
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

  // Semantic can only DOWNGRADE: an explicit `false` fails the criterion even if
  // it was mechanically substantiated (or executed-pass); it can never rescue an
  // unpasted / executed-fail proof.
  //
  // W1-T2263: APPEND to the floor's accumulated `reason`, never replace it — every earlier
  // branch above built `reason` up (mechanical coverage, execution outcome, a dialect note in
  // this same `${reason} — NOTE: …` idiom), and a bare overwrite here threw all of that away in
  // the one branch where an author most needs to know what was weighed. When the reviewer's
  // FAIL line carried a bounded trailing clause (`semanticClause`, threaded from
  // {@link parseReviewerVerdictClauses}), it rides along after the downgrade note so the row
  // can name what would answer the claim, not just that it didn't.
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

/** One acceptance criterion of a MERGED task whose proof is in an executable
 *  dialect (`grep:` / `unit test:` / a legacy bare test path or fenced grep) but did
 *  NOT resolve to a runnable check, or resolved and did not pass — merge credit was
 *  given per TASK, so this is the gap {@link judgeReview} itself cannot see once the
 *  task is already merged and off its desk. */
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

/** One acceptance criterion of a merged task whose proof carries NO whitelisted
 *  dialect at all (W1-T64's own two criteria are exactly this shape) — prose, and
 *  therefore structurally unauditable by this or any mechanical check. Reported in
 *  its OWN bucket so its size is legible; NEVER folded into {@link MergedClaimFinding}
 *  (that would misreport "unauditable" as "broken") and NEVER treated as passing
 *  (that would misreport "unauditable" as "verified") — design (4).
 */
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

/** Plain-language cause for a {@link MergedClaimFinding}, read off the SAME
 *  {@link ProofExecOutcome}/{@link ProofSkipReason} pair {@link judgeCriterion} already
 *  computed — never a second, independently-worded classification that could disagree
 *  with the executor's own verdict.
 *
 *  NOTE on `"executed_stale"`: {@link auditMergedTaskClaims} calls {@link judgeCriterion}
 *  with an `execCtx` that never carries a `baseCwd` (there is no single, well-defined
 *  "PR base" for an already-merged task audited standalone against the current
 *  checkout — {@link preexistingProofHits}'s own doc says it always returns `false`,
 *  never stale, when `baseCwd` is absent). That makes `"executed_stale"` structurally
 *  unreachable through THIS caller, so it is intentionally folded into the same
 *  generic `default` wording below rather than carrying a dedicated, untestable case.
 *  `"base_unreadable"` (W1-T460) is unreachable here for the SAME reason and folded the same
 *  way: it is only ever assigned alongside a `baseCwd`, which this caller never supplies. */
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

/**
 * W1-T302: a CLAIM-LEVEL audit over MERGED tasks. Merge credit is derived per TASK
 * (deriveStatus/{@link projectPlan}), never per CRITERION, so a multi-claim task whose
 * PR satisfied only SOME of its acceptance criteria reads identically to one that
 * satisfied all of them — the gap W1-T64 fell into (its mount-budget claim shipped;
 * its `commitsAhead` guard claim's own status is invisible to every existing check
 * because that claim's proof is prose, not because anyone verified it either way).
 *
 * REUSES the reviewer's OWN parser+executor ({@link parseWhitelistedProof} via
 * {@link judgeCriterion}, the exact machinery `rmd check-proof` and the live gate both
 * run) rather than re-implementing a second matcher that could disagree with it
 * (design (1)). Called with an EMPTY report-token set and no semantic verdict: there
 * is no PR report to score keyword coverage against once a task is already merged —
 * only `verdict.proof_exec`/`proof_skip`, which `judgeCriterion` computes purely from
 * executing the proof, are read here; `verdict.met`/`reason` (keyword-floor artifacts
 * of a report that does not exist in this context) are deliberately ignored.
 *
 * An ARCHITECT-set `satisfied_by` criterion is skipped outright — it is already,
 * deliberately, credited to an earlier merge, never a hole this audit should surface.
 *
 * REPORT ONLY (design (2)): callers use this list to FILE follow-up tasks, never to
 * mechanically close or reopen the merged task itself — an unresolved proof is
 * frequently a stale proof, not missing work, and only a human can tell those apart.
 */
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

/**
 * A body's own claim about its changeset that {@link bodyContradictsDiff}
 * proved false against the diff it actually shipped.
 */
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

/**
 * A path-SHAPED token: contains a `/` (directory) or a `.` (file extension) —
 * never a bare English word. This is the guard that keeps `bodyContradictsDiff`
 * silent on "no bugs"/"no issues"/"no regressions" (nothing to check a diff
 * against) while still catching "no src/"/"no docs/ORIENTATION.md".
 */
function looksLikePath(token: string): boolean {
  return /[./]/.test(token);
}

/** Words that mark a sentence as being ABOUT THE CHANGESET rather than about anything else a body
 *  might count files for. Kept as DATA so widening it is a one-line review, not a regex rewrite. */
const CHANGESET_CONTEXT_RE =
  /\b(?:diff|diffs|changed|changes|change|changeset|touch|touches|touched|modif\w*|edits?|edited|adds?|added|deletes?|deleted|removes?|removed|numstat|--stat|git\s+show|this\s+pr|the\s+pr)\b/i;

/**
 * Is the "exactly N files" match at `index` in a sentence ABOUT THE CHANGESET?
 *
 * Looks BACKWARD only, and only to the start of the current sentence — a changeset word in the
 * NEXT sentence says nothing about this claim, and scanning the whole body would re-create the
 * unanchored match this exists to prevent (every PR body says "changed" somewhere).
 */
/**
 * W1-T2534 — IS THE MATCH INSIDE AN INLINE QUOTED SPAN? A quotation is not an assertion, and
 * W1-T308 already established that for BLOCK-level quotation: {@link stripQuotedRegions} blanks
 * fenced blocks and blockquote lines. It does NOT touch an INLINE span, so a body REPORTING
 * another PR's count read identically to one making that count itself.
 *
 * MEASURED — the exact sentence that refused #3388, and again #3408 whose entire subject is this
 * detector:
 *     Adding the baseline line changes the diff — so a body that said "exactly 4 files" is now false.
 * `claimsChangesetContext` scans BACKWARD to the sentence start, finds "changes the diff", and
 * reads the quoted count as this body's own claim. Three PR bodies in one session were refused
 * this way, including the one documenting the trap.
 *
 * COUNTS DELIMITERS ON THE MATCH'S OWN LINE, never across lines: a stray unmatched quote earlier
 * in a long body must not silence every claim after it. An ODD count before the match means the
 * match sits inside an open span. Backtick and double quote only — an apostrophe is ordinary
 * English punctuation and counting it would silence half of any body that uses contractions.
 *
 * W1-T2549: this is the ONE predicate for "is this match quoted", shared by every arm of {@link
 * bodyContradictsDiff} rather than copied per arm — {@link claimsChangesetContext} (count) called
 * it first; {@link shorthandIsAboutChangeset} (label, copular, attributive) now hoists the same
 * call rather than reimplementing it, so all four arms agree on what counts as a quotation.
 */
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

/**
 * Is a `no <token>` claim ABOUT THE CHANGESET? `rest` is the report text immediately AFTER the
 * matched `no <token>`.
 *
 * WHY THIS IS NOT {@link claimsChangesetContext}. The obvious fix — reuse the helper #1077 built —
 * is wrong here, and measurably so. That helper looks BACKWARD, because a count claim carries its
 * context before it ("This PR changes exactly one file"). A `no <token>` claim carries it AFTER.
 * Measured against the real bodies:
 *
 *   #974  "Plan-only, no code touched | `git show --stat` lists three files"   backward ⇒ SILENT ✗
 *   #1025 `the body's own "data-only: no code" claim false`                     backward ⇒ SILENT ✗
 *   FP    "This change introduces no code duplication anywhere."                backward ⇒ FIRE   ✗
 *
 * Backward-looking would have broken BOTH preservation cases and still fired on the false positive,
 * because "This change introduces …" contains a changeset word while "Data-only: …" does not. The
 * direction is the whole point.
 *
 * THE RULE, in one sentence: a `no <token>` claim counts only when the TOKEN ENDS THE CLAIM — what
 * immediately follows is punctuation, end of line, or a changeset word — because an ordinary word
 * following the token makes the token a MODIFIER of that word ("no code DUPLICATION", "no src/
 * DIRECTORY convention") rather than the thing claimed absent.
 *
 * IT IS A HEURISTIC ABOUT ENGLISH COMPOUND NOUNS, and stating that plainly matters. "no code
 * changes" and "no code duplication" are grammatically identical; only the head noun differs, so
 * the classifier is the head-noun test and nothing deeper. It fails toward SILENCE — "no code was
 * changed" reads as a modifier and stays silent, a missed contradiction — which is the direction
 * this function's own doc demands: "ANYTHING THIS CANNOT DECIDE IS SILENCE, NOT A VERDICT … A
 * checker that guesses at natural language would be a worse tripwire than the gap it closes."
 * A missed contradiction costs one bad PR body; a false positive strands a correct PR indefinitely,
 * because a PR that files no task logs `sweep.fix.no_task` every tick and nothing ever retries it.
 *
 * Scoped to the SAME LINE (`[ \t]*`, never `\s*`): a word on the next line belongs to another
 * sentence and says nothing about this claim — the same reasoning that keeps
 * {@link claimsChangesetContext} inside its own sentence.
 *
 * THE HEAD NOUN CAN STILL BE MADE THE SUBJECT OF A NEED-CLAUSE NAMING SOMETHING ELSE (W1-T328).
 * The head-noun test above is one word wide: it sees "no code CHANGE" and stops, so it cannot
 * tell "no code changes" (a direct claim about the diff) from "no code change WAS NEEDED FOR
 * <something else>" (a clause whose grammatical subject is "no code change" but whose REASON —
 * the thing actually being talked about — is the "for X"/"to X" that follows). LIVE FIXTURE
 * (#1249, W1-T313): "it already forwards FeedbackEntry wholesale, so no code change was needed
 * for this task's tests to prove the console-rendering path" — a remark about panel-graph.ts,
 * which was NOT in the diff — fired because "change" is a changeset word, over a diff of
 * `src/lib/escalate.ts`, `src/lib/feedback.ts`, `src/lib/serve.ts`, `test/decision-summary.test.ts`
 * (none of them panel-graph.ts). Reproduced against the pre-fix function: FIRES. The PR needed a
 * human to hand-edit the sentence before remudero-review would pass it — exactly the costlier
 * direction this file's own doc calls out: "A missed contradiction costs one bad PR body; a false
 * positive strands a correct PR indefinitely."
 *
 * NARROWLY: only a "was/is/were/are needed/required/necessary FOR/TO …" tail flips the verdict to
 * silence — not bare "was needed." alone, which still reads as a direct (if oddly phrased) claim
 * about the diff. This is deliberately narrow, not a general parse: it targets the one construction
 * observed to misfire, and nothing wider.
 *
 * A CLOSING DELIMITER RIGHT AFTER THE TOKEN IS NOT END-OF-SENTENCE (W1-T395). The rule above says
 * "punctuation … the token IS the claim", but that was measured for punctuation that genuinely ENDS
 * a sentence — comma, period, semicolon, end of line, end of input. A closing delimiter ends a SPAN,
 * not a sentence, and real prose keeps going after it on the same line: "the docs say `no code` was
 * ever generated automatically" is no more a direct claim than "no code duplication anywhere" is —
 * both have an ordinary word right after the token, one of them just has a backtick in between.
 * Before this fix the backtick alone hit the "punctuation ends it" branch and the claim fired
 * unanchored; measured the same way with a paren or a straight quote in the backtick's place.
 * {@link NEXT_WORD_RE} therefore skips a closing delimiter (and the horizontal whitespace around
 * it) before testing for a following word, so a delimited claim is judged by the exact same
 * word-or-sentence-end test as the bare form — narrower, not weaker: a changeset word after the
 * delimiter still fires, same as it always did.
 */
const NEED_CLAUSE_RE = /^\s+(?:was|is|were|are)\s+(?:needed|required|necessary)\s+(?:for|to)\b/i;

// Enumerated, not "skip all punctuation" — a blanket skip would swallow the sentence-end case
// (comma, period, semicolon, end of line/input) that the "punctuation ends it" branch below still
// needs, turning a true positive into silence. Each character here CLOSES A SPAN rather than a
// sentence, so what follows it can still be the real continuation of the same claim:
//   `        closes inline code             ("no code` was clean")
//   " and '  close a quotation              ("no code" was clean / 'no code' was clean)
//   )        closes a parenthetical aside   ("no code) was clean")
// Left out: ] and } — unmeasured, no fixture exercises a claim inside a bracket/brace span; add
// them if a real one turns up rather than guessing now.
const NEXT_WORD_RE = /^[ \t`"')]*([A-Za-z][A-Za-z0-9_-]*)/;

export function noClaimIsAboutChangeset(rest: string): boolean {
  const next = NEXT_WORD_RE.exec(rest);
  if (!next) return true; // punctuation, end of line, or end of input — the token IS the claim
  if (!CHANGESET_CONTEXT_RE.test(next[1])) return false;
  // The head noun alone says "about the changeset" — but see whether it is itself the subject of a
  // NEED-clause naming something else (the W1-T328 fixture above) before trusting that.
  return !NEED_CLAUSE_RE.test(rest.slice(next[0].length));
}

/**
 * A SELF-REFERENTIAL SUBJECT immediately followed by a linking verb — "This PR is …", "The diff
 * was …", "This change is …", "It was …". The optional noun is what separates a claim from an
 * explanation: "a merged PR is plan-only" carries a linking verb too, but its subject is a
 * GENERIC PR rather than this one, so no determiner from this set precedes it and it does not
 * match. Anchored at `$` by its one caller, so the verb must be IMMEDIATELY before the shorthand.
 */
const SELF_REFERENTIAL_CLAIM_RE =
  /\b(?:this|these|it|the)(?:\s+(?:pr|diff|changeset|changes|change|commit|patch|revert))?\s+(?:is|are|was|were)\s+[*_`]*$/i;

/** The word a shorthand MODIFIES, if it modifies one: `[ \t]+` and never `\s+`, because a word on
 *  the NEXT line belongs to another sentence (the rule `noClaimIsAboutChangeset`'s own scan already
 *  follows), and a leading `[*_`]*` so markdown emphasis does not hide the noun. */
const SHORTHAND_HEAD_NOUN_RE = /^[*_`]*[ \t]+([A-Za-z][A-Za-z0-9_-]*)/;

/**
 * Is a house-shorthand claim (`plan-only` / `data-only`) at `index` ABOUT THE CHANGESET?
 *
 * THREE GRAMMATICAL RELATIONS, none of them "a changeset word appears somewhere nearby". Each is a
 * way English predicates the shorthand OF the change; prose that merely NAMES the concept matches
 * none of them and stays silent, which is what {@link bodyContradictsDiff}'s own contract demands:
 * "ANYTHING THIS CANNOT DECIDE IS SILENCE, NOT A VERDICT … A checker that guesses at natural
 * language would be a worse tripwire than the gap it closes."
 *   LABEL — `data-only: no code.` (#1025's own body). The colon makes it the subject of the line.
 *   COPULAR — `This PR is plan-only.` ({@link SELF_REFERENTIAL_CLAIM_RE}).
 *   ATTRIBUTIVE — `plan-only change`, `Plan-only edit`: the head noun it modifies IS the changeset.
 *
 * WHAT THIS REPLACED, AND WHY (W1-T413 → this change). The first two arms below are W1-T413's,
 * unaltered. The third replaces its two SENTENCE-SCOPED arms — a backward
 * {@link claimsChangesetContext} and a forward scan to the sentence end — which between them fired
 * whenever ANY changeset word shared a sentence with the shorthand, in EITHER direction and
 * whatever the sentence was about. W1-T413 asserted that limit rather than hiding it
 * (test/changeset-shorthand-anchor.test.ts: "THE RESIDUAL LIMIT … the honest repair is to write
 * such a sentence without the word") and judged narrowing further to be the greater risk.
 *
 * THE MEASUREMENT THAT CHANGES THAT CALCULUS, taken on a real PR rather than imagined: a body
 * cannot DESCRIBE this rule without tripping it, and the bodies that most need to describe it are
 * PRs changing plan-only handling. #1562 (W1-T427) wrote its own task's acceptance criterion
 * verbatim — "a diff touching any enforcement-data path loses the plan-only carve-out …" — and the
 * BACKWARD arm read that as the PR claiming exemption, forcing `state: "failure"` on a two-file
 * `src/`-touching diff. THE CORRECT WORDING IS THE ONE THAT TRIPPED IT. Against that, every
 * recorded true positive rides an arm kept here: #1025's `data-only: no code` is the LABEL form
 * (#974's was the file-COUNT check, a different predicate entirely), and every fixture in
 * test/changeset-shorthand-anchor.test.ts, test/body-contradicts-diff.test.ts,
 * test/body-vs-diff-contract.test.ts and test/gate-properties.test.ts that pins a real claim is a
 * label, a copular or an attributive one. The sentence-scoped arms have NO recorded true positive.
 * (Runtime firings are UNMEASURED — the ledger is unreachable — so that is a claim about the
 * repo's recorded fixtures and incidents, not about production counts.)
 *
 * NOT {@link noClaimIsAboutChangeset}, though it is the obvious sibling. Its contract treats "no
 * next word at all" as "the token IS the claim", which is right for `no <token>` and exactly wrong
 * here: a path like `test/trailer-credit-plan-only.test.ts` continues with `.test.ts`, so that
 * helper reports TRUE and the filename fires. Requiring real whitespace before the head noun is
 * what keeps a path silent.
 */
/**
 * W1-T2533 — A DENIED CLAIM IS NOT A CLAIM. The label arm decides on the COLON alone and never
 * reads what follows, so a body that answers the scope question HONESTLY IN THE NEGATIVE was
 * refused for having made the claim it just denied.
 *
 * MEASURED on #3373, whose body said `Plan-only: no.` — the correct answer, correctly stating the
 * PR is NOT plan-only — and was refused for it. A reader who answers truthfully is punished, which
 * is the one shape a scope detector must never punish.
 *
 * THE DISCRIMINATOR IS EXACT, AND THE HARD CASE IS WHY. `Plan-only: no code, only the shard.` is an
 * ASSERTION whose elaboration merely BEGINS with a negative word — it says what the scope IS, and
 * must stay refused. So:
 *   - `no`/`nope` counts as a denial only when nothing follows it but punctuation or end of line,
 *     because `no <noun>` describes content rather than answering the question;
 *   - `not` counts always, since it negates whatever follows ("not this time", "not really").
 * That single distinction separates every observed denial from every observed assertion.
 */
export const DENIED_LABEL_ANSWER_RE = /^[*_`'")\]\s]*:\s*(?:(?:no|nope)(?![ \t]*[\w])|not\b)/i;

/**
 * W1-T2533 — the ATTRIBUTIVE form of the same denial: "this is NOT a plan-only change". The
 * attributive arm reads only the noun the shorthand modifies, so it cannot see a negator sitting
 * in front of the whole noun phrase.
 *
 * Bounded to the words IMMEDIATELY before the shorthand, for the same reason the copular arm is
 * (SELF_REFERENTIAL_CLAIM_RE): a negator anywhere-in-sentence would silence a genuine claim that
 * merely shares a sentence with an unrelated negation.
 */
export const DENIED_ATTRIBUTIVE_RE = /\b(?:not|never|isn't|aren't|wasn't)\s+(?:a|an|the)?\s*$/i;
/**
 * W1-T2549 — THE SAME GUARD, HOISTED, NOT REIMPLEMENTED. W1-T2534 gave the count arm
 * ({@link claimsChangesetContext}) a check for an inline-quoted span — {@link isInsideInlineQuote}
 * — but left this function's three arms (label, copular, attributive) uncovered, so a body that
 * QUOTED a scope label — reporting what another PR's body said, or citing the trigger string this
 * very detector documents — was still read as this body's own claim.
 *
 * MEASURED, the same 2026-08-31 session that found the count-arm gap: #3422's second body (after
 * its first, count-arm body was fixed per W1-T2534) quoted the LABEL form and was refused for it,
 * and #3421's measurement table — reproducing this detector's own trigger strings — was only made
 * to pass by moving it into a FENCED block, W1-T308's block-level escape hatch. The literals were
 * byte-identical; only the wrapper changed, which is the inconsistency this guard removes.
 *
 * Checked FIRST, exactly as the count arm checks it first: no amount of colon/linking-verb/head-
 * noun shape below turns a quotation into an assertion. This is the ONE call, not a second copy —
 * a second implementation is exactly how the count arm and this one drifted apart the first time.
 */
function shorthandIsAboutChangeset(report: string, index: number, length: number): boolean {
  if (isInsideInlineQuote(report, index)) return false;
  const rest = report.slice(index + length);
  // THE LABEL FORM IS A CLAIM, and it is the one the house style actually writes: `data-only: no
  // code.` (#1025's own body) and `**Plan-only**: one file added`. A colon immediately after the
  // shorthand — through any markdown emphasis — makes it the SUBJECT of the line rather than a
  // word inside one, and that is decidable without guessing at the elaboration that follows, which
  // often carries no changeset verb at all ("no code", "no src"). A path never continues with a
  // colon, so `test/trailer-credit-plan-only.test.ts` stays silent.
  //
  // W1-T2549 NARROWED W1-T395's SCOPE, IT DID NOT REVERSE IT. W1-T395's invariant — a CLOSING
  // DELIMITER merely ends a SPAN, not a sentence, so `**Plan-only**:` and `(Plan-only):` still read
  // as a label — still holds for markdown EMPHASIS (`*`, `_`, backtick pairs used as styling) and
  // for a bracketing aside (`(…)`). It no longer extends to a QUOTE character (`"` or a lone
  // backtick) that leaves the span open on this line: that shape is now caught by the
  // `isInsideInlineQuote` guard above, before this delimiter class ever runs, because that is
  // indistinguishable from the inline quotation the count arm already exempts. See
  // test/changeset-shorthand-anchor.test.ts for the fixtures that split on this line.
  //
  // THE DELIMITER CLASS IS THE LABEL ARM'S OWN, not a shared helper's. W1-T395 established that a
  // CLOSING DELIMITER "merely ends a SPAN" rather than a sentence, so `**Plan-only**:` and
  // `(Plan-only):` still reach the colon and read as a label (test/review-absence-anchor-delimiter
  // .test.ts). A QUOTE delimiter (`"` or a lone backtick) is no longer decided down here at all —
  // W1-T2549's guard above returns false for it before this line ever runs, because a body that
  // opened a quote span before the shorthand is reporting, not asserting. This class therefore
  // never needs to special-case a quote character; the guard above already removed it from view.
  if (/^[*_`'")\]\s]*:/.test(rest)) {
    // W1-T2533: ...unless the body ANSWERED the question negatively. See DENIED_LABEL_ANSWER_RE
    // for why `no <noun>` is still an assertion while `no.` and `not …` are denials.
    return !DENIED_LABEL_ANSWER_RE.test(rest);
  }
  // THE COPULAR FORM IS A CLAIM: "This is plan-only.", "The diff is data-only." A linking verb
  // immediately before the shorthand makes it the PREDICATE of whatever the sentence is about, and
  // in a PR body that subject is the change. Deliberately IMMEDIATE rather than anywhere-in-
  // sentence, which is what separates it from the two shapes that must stay silent: "makes a
  // triage PR plan-only by construction" (about the LANE) and "described its revert as data-only"
  // (about ANOTHER PR) both name the concept without predicating it of this diff.
  if (SELF_REFERENTIAL_CLAIM_RE.test(report.slice(0, index))) return true;
  // THE ATTRIBUTIVE FORM IS A CLAIM when — and only when — the noun the shorthand modifies is
  // ITSELF the changeset: "plan-only change", "Plan-only edit", "a data-only diff". That is the
  // distinction the old forward scan could not draw, because it read the whole rest of the
  // sentence: in "the plan-only CARVE-OUT exempts a plan-scope DIFF", the modified noun is
  // `carve-out` and `diff` is an object three words later — one sentence, two entirely different
  // subjects. Reading only the modified noun keeps every real claim and drops the description.
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

/**
 * A QUOTATION IS NOT AN ASSERTION (W1-T308). `bodyContradictsDiff` scans the whole body for the
 * claim shape, so a blockquote or a fenced code block quoting ANOTHER PR's body — or a body's own
 * earlier, since-fixed claim — read identically to this PR's own assertion. LIVE FIXTURES: #1194
 * (the backtick fix) quoted #1192's failing fixture verbatim inside a blockquote and was failed
 * over a two-file diff; #1206 (filing W1-T307) cited #1202's body the same way and was failed over
 * a one-file plan shard. Both passed only once the quotation was paraphrased, with no change to
 * any code or to the diff — the workaround silently destroys the most useful record of what went
 * wrong.
 *
 * Blanks blockquote lines (`> …`) and the full contents of fenced code blocks (``` … ```),
 * preserving every other character's position — including newlines — so match indices returned
 * against this text line up exactly with the original body for backward/forward scans like
 * {@link claimsChangesetContext} and {@link noClaimIsAboutChangeset}, and so a REAL, unquoted claim
 * elsewhere in the same body (before or after a quoted one) is untouched and still read.
 *
 * DELIBERATELY NARROW: only blockquote lines and fences. Widening the exclusion (e.g. inline
 * `code spans`, which the enumeration cleanup already unwraps) would let a real contradiction hide
 * behind a single backtick — strictly worse than today's over-firing.
 *
 * ALSO REPORTS `fenceUnbalancedAtEof` (W1-T1264 design (iv)): whether `inFence` is STILL true once
 * every line has been walked — i.e. the body opened a fence and never closed it. An unbalanced
 * fence blanks the ENTIRE REMAINDER OF THE BODY, from the stray delimiter to EOF, so every later
 * claim goes unread the same way a genuinely-quoted one does. That is silent and indistinguishable
 * from "no more claims" today; {@link recognizeChangesetClaims} names it instead of swallowing it.
 */
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

/**
 * Does an enumeration TOKEN correspond to a member of `diffFiles` (W1-T2224)? Replaces a shape
 * guess ("does the token look like a path, then does it exactly equal a member") with a contract
 * check against `diffFiles` itself — the thing the caller already holds and the token is actually
 * being judged against.
 *
 * THE THIRD FALSE POSITIVE ON THE SAME LINE. `looksLikePath` (any `.` or `/`) plus exact-string
 * `includes` already needed two patches for two wrappers: backticks (PR #1192, W1-T288) and a
 * trailing paren (PR #1209, W1-T304), both REAL, CORRECTLY-enumerated paths whose exact TEXT
 * stopped matching once something else was pasted around them. A compact diffstat token — a
 * numstat triple, a `--stat` line joined by a `|`, a path with a trailing `+N/-M` — is the same
 * shape of failure: the real path is still IN the token, just with extra characters glued to one
 * end, and no fixed strip class can anticipate every glue the next body will use.
 *
 * THREE WAYS A TOKEN NAMES A REAL FILE, each checked against `diffFiles` rather than inferred from
 * punctuation:
 *   (a) EXACT — the token (after the existing wrapper-strip) IS a `diffFiles` member;
 *   (b) SUFFIX/BASENAME — the token is the final path segment, or a trailing path suffix, of
 *       EXACTLY ONE `diffFiles` member — the shorthand a body writes when it drops the leading
 *       directories ("review.ts" for "src/lib/review.ts");
 *   (c) EMBEDDED — EXACTLY ONE `diffFiles` member appears INTACT inside the token — the shape a
 *       diffstat token takes when it is pasted NEXT TO, rather than instead of, the real path
 *       ("12/3/src/lib/review.ts", "src/lib/review.ts|12+++++-----").
 * "Exactly one" in (b) and (c): an AMBIGUOUS match (two different `diffFiles` members both fit)
 * is treated as no match at all — silence over a wrong guess, never the reverse.
 *
 * A token matching NONE of these is a genuinely wrong (or unrelated, e.g. a bare version number)
 * name and still contradicts — test/count-arm-diffstat-token.test.ts's "genuinely wrong file" case,
 * and test/body-contradicts-diff.test.ts's `NOT-IN-DIFF.ts`/`ABSENT.ts` fixtures, both unchanged.
 */
function enumeratedTokenMatchesChangeset(token: string, diffFiles: readonly string[]): boolean {
  if (diffFiles.includes(token)) return true;
  const bySuffix = diffFiles.filter((f) => f === token || f.endsWith(`/${token}`));
  if (bySuffix.length === 1) return true;
  const byEmbed = diffFiles.filter((f) => f.length > 0 && token.includes(f));
  return byEmbed.length === 1;
}

/**
 * THE NARROW, FALSIFIABLE CHECK (W1-T274). Two PRs merged THIS WEEK on bodies
 * that contradicted their own diffs — #974 claimed "exactly one file:
 * MASTER-PLAN.md. No src/, no test/, no docs/ORIENTATION.md" over a 3-file
 * diff that DID touch docs/ORIENTATION.md (load-bearing because the body NAMED
 * the very file the diff touched — NOT because of plan scope: `isInPlanScope`
 * returns TRUE for docs/ORIENTATION.md, which plan-architect.ts calls "the
 * single regenerated doc", so #974 kept its planOnly carve-out and this check
 * is what caught it. test/arm-outcome-five-sites.test.ts asserts that scope
 * membership directly; an earlier revision of this comment claimed the
 * opposite and contradicted that passing test);
 * #1025 claimed "data-only: no code" while reverting 6 src/ + 2 test/ files.
 * Both landed because `judgeReview` already held the parsed changeset
 * (`diffFiles`) and the body (`evidence.report`) in the same function and
 * compared neither against the other. This closes exactly that gap:
 *
 *   (a) a stated FILE COUNT ("exactly N files") that disagrees with
 *       `diffFiles.length`;
 *   (b) a claim that a path/directory is absent ("no src/", "no test/", a
 *       named file, "plan-only", "data-only") when `diffFiles` contains a
 *       member of it;
 *   (c) a file NAMED in an "exactly N files: a, b" enumeration that
 *       `diffFiles` does not actually contain.
 *
 * DELIBERATELY NOT general claim-verification: whether the diff is CORRECT,
 * or whether a claim about BEHAVIOUR (as opposed to the changeset itself)
 * holds, is out of scope. ANYTHING THIS CANNOT DECIDE IS SILENCE, NOT A
 * VERDICT — prose these patterns do not recognise returns `[]`, the exact
 * same shape as a body making no changeset claim at all. A checker that
 * guesses at natural language would be a worse tripwire than the gap it
 * closes.
 */
export function recognizeChangesetClaims(report: string, diffFiles: string[]): ChangesetClaimRecognition {
  const out: ChangesetClaimContradiction[] = [];
  // W1-T1264: how many claim-shaped tokens, across every arm below, RECOGNISED as being about the
  // changeset — regardless of whether they went on to agree or disagree with `diffFiles`. See
  // {@link ChangesetClaimRecognition.recognisedCount}'s own doc for why this is the fix: a
  // recognised-and-consistent claim increments this WITHOUT ever reaching `out` below, which is
  // the one fact `bodyContradictsDiff`'s `[]` alone could never distinguish from "never read a
  // claim at all". Incremented at the SAME point each arm below decides a match is a genuine claim
  // (past its own subject anchor) — never at the point it decides that claim is FALSE.
  let recognisedCount = 0;
  // W1-T308: scan the QUOTED-STRIPPED text throughout, never the raw `report` — see
  // {@link stripQuotedRegions}. Length- and newline-preserving, so every index below still lines up
  // with the original body. `fenceUnbalancedAtEof` (W1-T1264) rides along unused until the return
  // below — the arms never branch on it, only the caller reports it.
  const { scan, fenceUnbalancedAtEof } = stripQuotedRegions(report);

  // (a) / (c): "exactly N files[: a, b, c]" — the count itself, and (when a
  // count is right but a named file is missing) the enumerated list.
  //
  // THE COUNT CLAIM MUST BE ABOUT THE CHANGESET (fixed after PR #1077). The bare pattern has no
  // SUBJECT: "exactly one file" reads identically whether the sentence is about the diff or about
  // something else entirely. LIVE FIXTURE — PR #1077 wrote "Each unit-test proof resolves to
  // exactly one file and matches exactly 1 test", a statement about PROOF CANDIDATE RESOLUTION,
  // and was posted `failure` over a 7-file diff. Its verdict recorded `proof_exec` 5/5
  // `executed_pass`, `unmet_criteria: []`, `test_theater: false`, `capped: false` — every
  // criterion substantiated, the PR blocked anyway, and no rung retried it.
  //
  // That is precisely the failure this function's own doc comment forbids: "ANYTHING THIS CANNOT
  // DECIDE IS SILENCE, NOT A VERDICT … A checker that guesses at natural language would be a
  // worse tripwire than the gap it closes." An unanchored count IS a guess at natural language.
  //
  // So a count claim now counts only when it is TIED TO THE CHANGESET, by either:
  //   (i)  an enumeration — "exactly one file: MASTER-PLAN.md" — which is unambiguous and is the
  //        shape #974 actually used (the PR this check was built for; still caught), or
  //   (ii) a changeset word in the run-up to the phrase ("changed", "touches", "diff", "modifies",
  //        "git show --stat listed …"), which is how a body states the claim in prose.
  // Anything else is silence, exactly as an unrecognised sentence already was.
  const countRe = /\bexactly\s+(\w+)\s+files?\b(?:\s*:\s*([^\s,]+(?:\s*,\s*[^\s,]+)*))?/gi;
  for (const m of scan.matchAll(countRe)) {
    const claimed = parseClaimedCount(m[1]);
    if (claimed === undefined) continue;
    if (!m[2] && !claimsChangesetContext(scan, m.index ?? 0)) continue;
    recognisedCount++; // past both the parse and the subject anchor — a genuine claim, true or not
    let contradicted = claimed !== diffFiles.length;
    if (!contradicted && m[2]) {
      // MARKDOWN QUOTING IS STRIPPED BEFORE THE COMPARISON. A body writes a path the way this
      // repo's own house style writes one — in backticks — so the enumeration items arrive as
      // "`src/lib/serve.ts`" while `diffFiles` holds bare paths. `includes` then fails on every
      // correctly-enumerated file and the PR is failed for a claim that is TRUE.
      //
      // LIVE FIXTURE (PR #1192, W1-T288): body said "This PR touches exactly 3 files:
      // `src/lib/panel-actions.ts`, `src/lib/serve.ts`, `test/control-status-daemon-liveness.test.ts`."
      // over a diff of exactly those three. Reported 1 contradiction; with backticks stripped
      // from the same body and the same diff, 0. Nothing else about the claim was wrong.
      //
      // WRAPPING PUNCTUATION COMES OFF FROM BOTH ENDS, AS A CLASS — not backticks then a full
      // stop. #1194 shipped exactly that narrower pair and it was incomplete: it handled
      // "…test.ts`." and NOT "…test.ts`)".
      //
      // SECOND LIVE FIXTURE (PR #1209, W1-T304): the enumeration was parenthesised, so the final
      // item arrived as "`test/review-failure-reason-ledgered.test.ts`)". The old cleanup stripped
      // `[.\s]+$` (no match — the last character is a paren), then backticks anchored at the ends
      // (no match — the last character is still a paren), leaving the item unchanged and the PR
      // failed for a claim that was TRUE. Reproduced against the installed build before this edit.
      //
      // A single character class from each end handles quoting and punctuation in either order,
      // which is what makes it robust to the next wrapper rather than to the two seen so far.
      // `looksLikePath` still requires a `.` or `/`, so an over-strip cannot invent a match.
      //
      // MEMBERSHIP ITSELF IS A CONTRACT CHECK, NOT A THIRD WRAPPER (W1-T2224). The strip above
      // still only removes a known class of QUOTING/BRACKETING punctuation; a compact diffstat
      // token (a numstat triple, a `--stat` line joined by `|`, a trailing `+N/-M`) is not quoted
      // or bracketed — the real path is glued to unrelated characters that no strip class should
      // chase. {@link enumeratedTokenMatchesChangeset} decides by what `diffFiles` actually
      // contains instead: see its own doc for why an unmatched token still contradicts.
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
    // ANCHOR (the sibling of #1077's, in the other direction — see noClaimIsAboutChangeset).
    // Predicate (b) was never anchored, and fired six times today on prose whose subject was not
    // the changeset: "This change introduces no code duplication anywhere" produced `claim: "no
    // code"` against any source-touching diff, in a repo that runs a jscpd duplication gate.
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
  // THE HOUSE SHORTHANDS NEED THE SAME SUBJECT ANCHOR THE COUNT CLAIM GOT, and for the same
  // reason: `/\bplan-only\b/i.test(scan)` has no SUBJECT, so it fires on the WORD wherever it
  // appears — including inside a path. MEASURED on this very PR: the test file W1-T413's own
  // acceptance criteria name is `test/trailer-credit-plan-only.test.ts`, and `\b` matches around
  // `plan-only` between the `-` and the `.`, so merely quoting the required proof made the body
  // "claim" its src-touching diff was plan-only and forced `state: "failure"`. Writing ABOUT the
  // concept did the same. That is the guess-at-natural-language this function's own doc forbids.
  //
  // ANCHORED BACKWARD, with {@link claimsChangesetContext} — the count claim's helper, not a third
  // notion. These shorthands carry their context BEFORE them the way a count does ("this PR is
  // plan-only", "the diff is data-only"), which is the opposite of a `no <token>` claim and why
  // {@link noClaimIsAboutChangeset} is the wrong sibling to reuse here.
  //
  // BOTH ARMS, deliberately. `data-only` is the identical shape one line down; fixing only the arm
  // that bit today would leave its twin to bite next, which is the one-organ-disagreeing-with-
  // another pattern this repo keeps paying for.
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

/**
 * Everything {@link bodyContradictsDiff} decides, PLUS the two facts (W1-T1264) that make its
 * silence legible: how many claim-shaped tokens were RECOGNISED at all, and whether the
 * quote-stripping pass reached end-of-body still inside an open fence. See {@link
 * recognizeChangesetClaims}'s own doc for how these are produced — nothing here changes WHEN a
 * claim is recognised or WHEN it disagrees with the diff, only what is counted alongside it.
 */
export interface ChangesetClaimRecognition {
  /**
   * How many claim-shaped tokens, across every arm {@link bodyContradictsDiff}'s own doc
   * enumerates, were RECOGNISED — matched an arm's shape AND passed that arm's own subject
   * anchor ({@link claimsChangesetContext} / {@link noClaimIsAboutChangeset} / {@link
   * shorthandIsAboutChangeset}) — regardless of whether the claim went on to AGREE or DISAGREE
   * with `diffFiles`. `contradictions.length` is always <= this number: a recognised claim that
   * AGREES with the diff is counted here and never appears in `contradictions` at all — design
   * (ii)'s "checked, and it agrees", the one fact no other field can express. A `0` here paired
   * with an empty `contradictions` means the body made no claim any arm recognises; see {@link
   * CHANGESET_CLAIM_FALSIFIER_NOTE} for how an author tells that apart from "checked, and it
   * agrees" — both currently render `changesetContradictions: []` on the posted verdict.
   */
  recognisedCount: number;
  /** Identical to {@link bodyContradictsDiff}'s own return value — the FALSE-claim subset. */
  contradictions: ChangesetClaimContradiction[];
  /**
   * W1-T1264 design (iv): true when {@link stripQuotedRegions}'s fence-toggle state was still
   * OPEN once every line of the body had been walked — an unbalanced ``` delimiter blanks the
   * remainder of the body to EOF (rationale (5)), so every later claim silently goes unread and
   * `recognisedCount` under-counts without saying why. NAMED here, never auto-repaired: guessing
   * the author's intent by closing the fence or re-scanning the blanked region is exactly what
   * design (iv) forbids — {@link stripQuotedRegions}'s own strip pass is otherwise correct.
   */
  fenceUnbalancedAtEof: boolean;
}

/**
 * THE FALSIFIER TECHNIQUE (rationale (6), W1-T1264) — stated beside the gate it describes, not
 * passed on by word of mouth. A `recognisedCount` of `0` does NOT mean a claim was true; it means
 * this detector never read one, and prints identically to a claim it read and found correct.
 * Telling the two apart: reword the SAME claim into a deliberately FALSE variant of the identical
 * shape (bump an "exactly N files" count, or negate a "no <path>" claim) and re-run. If the false
 * variant ALSO recognises as `0`, the gate is blind to that WORDING — reach for one of the
 * recognised shapes {@link bodyContradictsDiff}'s own doc enumerates instead. If the false variant
 * fires a contradiction, the original claim was read, and it was true.
 */
export const CHANGESET_CLAIM_FALSIFIER_NOTE =
  "A changeset-claims-recognised count of 0 does not mean your claim was true — it means this " +
  "check never read it, and that prints identically to a claim it read and found correct. To tell " +
  "the two apart, reword the SAME claim into a deliberately FALSE variant of the identical shape " +
  "(bump an \"exactly N files\" count, or negate a \"no <path>\" claim) and re-run: if the false " +
  "variant also recognises as 0, the gate is blind to that wording; if it fires a contradiction, " +
  "your original claim was read, and it was true.";

/**
 * THE NARROW, FALSIFIABLE CHECK's own return value — the FALSE-claim subset of {@link
 * recognizeChangesetClaims}'s fuller computation, unchanged in shape and behaviour from before
 * W1-T1264 (every existing caller/fixture keeps working byte-for-byte). Prefer {@link
 * recognizeChangesetClaims} at any NEW call site that can use `recognisedCount` — `judgeReview`
 * (this file) and `deriveChangesetClaimUpdate` (run-task.ts) both do, so the SAME count reaches
 * both surfaces an author reads (design (iii)) — this wrapper exists only so every caller that
 * wants just the contradictions (most of this file's own doc comments, every existing test) never
 * has to unwrap an object it does not need.
 */
export function bodyContradictsDiff(report: string, diffFiles: string[]): ChangesetClaimContradiction[] {
  return recognizeChangesetClaims(report, diffFiles).contradictions;
}

/**
 * Whether `diffFiles` is EMPTY against its own DECLARED SCOPE — the specific paths a PR claims to
 * touch, never the whole tree (W1-T963, the empty-diff-triage-merge incident: #2075/#2077/#2078
 * merged and passed review despite changing nothing, because nothing downstream ever asked this
 * question). `scopeFiles` absent/empty means nothing was declared, so there is nothing to check —
 * this NEVER manufactures a refusal for an ordinary PR with no declared scope, only for a caller
 * that explicitly names one (a triage PR's own feedback entry, e.g.).
 *
 * `bodyContradictsDiff` above answers a DIFFERENT question — "does the body's PROSE contradict
 * `diffFiles`" — and is vacuously satisfied when `diffFiles` is empty (nothing to contradict). This
 * is the complement: a purely structural check with no report/prose involved at all, so an empty
 * diff can be refused even when the body never claims anything about the changeset.
 *
 * SCOPED, NOT WHOLE-TREE (design (iv)): `nonPlanFilesInDiff`/`diffCitesFeedback` (lib/triage.js)
 * are the closest existing precedent — both already inspect a triage diff structurally, never via
 * prose. This generalizes their shape to "touches none of its own declared paths" rather than
 * "touches something outside plan/", which is the complementary structural gap those two leave
 * open: a diff can be simultaneously plan-only, feedback-citing (in the STALE PR-body sense) AND
 * empty against the one path that actually matters, which is exactly what happened live.
 */
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

/**
 * SCOPE-EXEMPT GENERATED ARTIFACTS (W1-T2650): the ONE enumerated set both the push/fix-rung
 * scope guard ({@link "../run-task.js".scopeGuardOutOfScopeFiles}, via its re-export here) and
 * this reviewer's own {@link scopeViolationFiles} consult — so a PR admitted by one is never
 * refused by the other, which is the whole invariant this task exists to restore (rationale
 * "ATOMIC ACROSS TWO STEMS"). `scripts/source-size-ratchet.mjs` prints the exact edit that clears
 * a breach — `edit scripts/source-size-baseline.json and set: "<path>": <bucket>,` — and says
 * doing so in the SAME PR that caused the growth is the ordinary, safe outcome (citing the
 * W1-T2526 instrument-isolation exemption). Before this set existed, a task that legitimately grew
 * a source file had no declared-scope path that let it record its own ceiling: the push/fix-rung
 * guard flagged the edit as out-of-scope and the fix rung stood itself down rather than dispatch
 * it, so the only outs were a scope amendment or a deferred follow-up — and a deferred baseline
 * number has a shelf life measured in hours once a sibling task is concurrently rewriting the same
 * entries (see this task's own rationale, the W1-T2516 follow-up that expired in under a day).
 *
 * EXACT PATHS, HAND-ENUMERATED, NEVER A PATTERN — the same discipline this file's instrument-
 * entanglement exemption set (below, a DIFFERENT gate: instrument isolation, not declared-file
 * scope) already holds: this is DATA, not a new code branch, and adding an artifact is a one-line
 * row edit here that both consumers see with no second copy anywhere else (this task's own
 * acceptance criterion 4). NOT A RELAXATION OF EITHER GUARD'S FAIL-CLOSED
 * DIRECTION: {@link scopeGuardOutOfScopeFiles}'s "empty/absent declared scope refuses everything"
 * branch returns before this set is ever consulted (an undeclared task still refuses every
 * non-empty diff, exempt artifact or not), and every path OUTSIDE this set is refused by both
 * guards exactly as before.
 */
export const SCOPE_EXEMPT_GENERATED_ARTIFACTS: ReadonlySet<string> = new Set([
  // W1-T2650: the per-file source-size LEDGER `scripts/source-size-ratchet.mjs` itself prints as
  // the remedy for a breach it caused — see the doc above for why deferring this one to a
  // follow-up task is unsafe rather than merely inconvenient.
  "scripts/source-size-baseline.json",
]);

/**
 * INVERSE-SCOPE (design (ii)(b), the #839 class): the mirror of {@link
 * "../run-task.js".scopeGuardOutOfScopeFiles}, in the OTHER direction. That guard (diff → declared)
 * fires only on the orchestrator's fallback push path and flags a diff touching a file OUTSIDE the
 * task's declared scope. This is declared → diff: a file the task's `files:` list NAMES that the
 * diff never actually touched at all — visible from EVERY review, not just that one narrow push
 * path, because the review-side walk sees every PR. FAIL-CLOSED in the safe direction: an absent
 * or empty declared scope has nothing to compare, so it never fires (a task with no declared
 * scope is not this check's business — {@link scopeGuardOutOfScopeFiles} already owns that case).
 */
function inverseScopeUntouchedFiles(diffFiles: readonly string[], declaredFiles: readonly string[] | undefined): string[] {
  if (!declaredFiles || declaredFiles.length === 0) return [];
  const touched = new Set(diffFiles);
  return declaredFiles.filter((f) => !touched.has(f));
}

/**
 * SCOPE-VIOLATION (W1-T401, design (i)-(iv)): the same comparison {@link
 * "../run-task.js".scopeGuardOutOfScopeFiles} makes (diff → declared, flagging a file the diff
 * touches that the task never declared) but run at REVIEW TIME, where every PR is seen — not just
 * the one push site (behind `if (!branchOnOrigin)`) that guard actually runs at. ADVISORY, not a
 * refusal (see {@link ReviewVerdict.unwiredAdvisories}'s doc for why: a measured majority of
 * recent trailer-bearing merges would have widened past their declared scope for legitimate
 * reasons — a generator-gate artifact, a task's own plan shard, an operator-instructed or
 * review-ratified widening).
 *
 * DELIBERATELY DIFFERENT FROM {@link "../run-task.js".scopeGuardOutOfScopeFiles} ON ONE POINT:
 * that guard treats an absent/empty declared scope as "everything is out of scope" (a REFUSE-by-
 * default posture that fits its own narrow, blocking purpose). This advisory does not — an absent
 * or empty declared scope has nothing to compare, so it never fires, matching {@link
 * inverseScopeUntouchedFiles}'s own fail-closed direction. A task declaring nothing is not treated
 * as declaring everything.
 *
 * W1-T2650: also subtracts {@link SCOPE_EXEMPT_GENERATED_ARTIFACTS} — the SAME enumerated set
 * {@link "../run-task.js".scopeGuardOutOfScopeFiles} subtracts, so a PR this reviewer admits
 * (no `scope_violation` advisory) is never the one the push/fix-rung guard refuses, and vice
 * versa. Only reached once `declaredFiles` is known non-empty (the branch above already returned
 * for an undeclared task), so this never widens the guard's fail-closed default.
 */
function scopeViolationFiles(diffFiles: readonly string[], declaredFiles: readonly string[] | undefined): string[] {
  if (!declaredFiles || declaredFiles.length === 0) return [];
  const declared = new Set(declaredFiles);
  return diffFiles.filter((f) => !declared.has(f) && !SCOPE_EXEMPT_GENERATED_ARTIFACTS.has(f));
}

/**
 * IMPLEMENTATION-SHAPED (W1-T458 design (ii)): true for a path this advisory's overlap check
 * counts at all — `src/` or `test/` only. Narrowing to these two prefixes is what turns the raw
 * "touches ANY declared path" false-positive rate (measured 52% — inflated by plan filings and
 * docs PRs that legitimately touch a declared plan/doc path and should earn no task credit) into
 * the honest ~11% ("touches a declared `src/`/`test/` path") the design's advisory-not-refusal
 * call rests on.
 */
function isImplementationPath(path: string): boolean {
  return path.startsWith("src/") || path.startsWith("test/");
}

/**
 * UNRESOLVED-TASK-SCOPE (W1-T458, the #1731 near-miss — design (i)/(iii)): given the diff's own
 * file list and EVERY open task's declared scope, name the open task(s) whose `files:` this diff
 * overlaps — but ONLY when no task has been resolved for this PR at all. "Resolved" is read off
 * `taskDeclaredFiles` being present/non-empty, the SAME signal {@link inverseScopeUntouchedFiles}/
 * {@link scopeViolationFiles} already fail-close on — deliberately NEVER a literal scan of `report`
 * for a `Remudero-Task:` trailer (design (iii): `test/fixtures/golden-verdicts/scope-creep`
 * injects `taskDeclaredFiles` directly and carries no trailer in any fixture file at all; a
 * trigger keyed on "no trailer in the body" would misfire on it and shift `golden.yaml`, while
 * this one — keyed on "no task resolved" — correctly stays silent, because that fixture's task IS
 * resolved).
 *
 * Only counts an overlap through an {@link isImplementationPath} path (design (ii)'s ~11% figure).
 * FAIL-CLOSED like its siblings: a resolved task, or an absent/empty `openTaskDeclaredFiles`, has
 * nothing (or no reason) to compare, so this never fires.
 */
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

/**
 * Assemble this review's {@link UnwiredAdvisory} list (design (ii)) — ADVISORY ONLY, never
 * consulted by `state`. `checkoutDir` mirrors {@link ReviewEvidence.headCheckoutDir}'s own
 * "absent ⇒ skip" contract: the `unwired_export` reason needs real files to read, so it is
 * silently skipped (not a false "nothing to advise") when no checkout was supplied — exactly the
 * degradation {@link judgeCriterion}'s own `execCtx` already applies to proof execution.
 * `inverse_scope`/`scope_violation`/`unresolved_task_scope` need no checkout (each is a pure
 * diff-files/declared-files comparison) and always run.
 *
 * Also returns `reachabilityScanned` (W1-T1118, see {@link ReviewVerdict.reachabilityScanned}'s
 * doc): the scan's own `examined` count when `checkoutDir` was present, `null` when the
 * `if (checkoutDir)` guard skipped it — read off {@link scanUnreachedExports}'s result, never a
 * second diff walk.
 */
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

/**
 * THE CLOSED VOCABULARY (design (ii)), derived from the corpus itself — never invented — matched
 * case-insensitively as a plain substring over an entry's OWN added lines:
 *   (a) the machine auto-choose stamp, e.g. "Chosen (RECOMMENDED, auto): `docs/spike-hello.md`";
 *   (b) the hand-record line's surface forms actually in use in DECISIONS.md — "*Operator-authored,
 *       not a machine auto-choose resolution…*", "Operator direction record (not an auto-choose
 *       resolution)…", and "*Operator-ruled closure, recorded at the operator's instruction…*"
 *       (whose header parenthetical reads "OPERATOR-RULED");
 *   (c) an explicit operator-attribution sentence — the #1303 amendment's own words: "**The
 *       operator has overridden the N=1 ruling.**".
 * Pinned by test/review.test.ts so a future edit to this list is a deliberate, reviewed change,
 * never a silent narrowing/widening of what counts as provenance.
 */
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

/**
 * DECISIONS.md ENTRY PROVENANCE FLOOR (W1-T352): every entry header (`## …`) a diff ADDS to
 * DECISIONS.md must carry, among that SAME entry's own added lines, either the machine stamp or
 * an operator-attribution line — see {@link DECISIONS_PROVENANCE_MARKERS}. Returns the header
 * text of every offending new entry (`[]` when every new entry is marked, or the diff adds none).
 *
 * READS THE DIFF, NOT THE FILE (design (i)): only lines this diff itself ADDS are consulted — via
 * {@link walkDiff}, the same diff-walker every other structural check in this file already uses —
 * so DECISIONS.md's own historical unmarked entries (e.g. the 2026-07-20 menu-bar deferral) never
 * fire, and a PR that edits DECISIONS.md without adding a NEW `## ` header (a typo fix, a
 * rollback-pointer amendment to an existing entry) never fires either: nothing here is ADDED. An
 * existing header line that merely surfaces as unchanged CONTEXT around an edit is not an ADD
 * line either, for the same reason.
 *
 * An entry's own added-line SPAN runs from its `## ` header to the next added `## ` header (or the
 * end of the diff's DECISIONS.md hunk) — the natural unit a single `DECISION_REQUEST` resolution
 * or a hand-recorded ruling occupies, matching how the corpus itself is laid out.
 *
 * NO SEMANTIC CLASSIFICATION (design (iii)): this never asks whether an entry IS a binding ruling
 * — only whether it carries ONE of the two provenance genres. A descriptive/no-op entry that adds
 * the stamp passes exactly like a genuine ruling that adds it; requiring the mark on every new
 * entry is what makes the distinction moot.
 */
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

/**
 * The pure verdict function (acceptance #2). Given the acceptance criteria and
 * the evidence (diff + report [+ optional semantic verdicts]), roll up a single
 * `remudero-review` state. FAIL-CLOSED: empty criteria, any unmet criterion, or
 * test theater all yield `failure`.
 */
/**
 * W1-T2472: THE one definition of "this changeset is plan-only", extracted so two callers cannot
 * drift. {@link judgeReview} uses it for the W1-T205 classification; run-task.ts's reviewer-spawn
 * gate uses {@link planOnlyDiff} to answer the same question BEFORE the advisory spawn.
 *
 * Deliberately takes both already-computed inputs rather than a diff: judgeReview holds
 * `diffFiles` and `enforcementData` for other checks, and re-deriving them here would walk the
 * diff a second time on every review.
 */
function planOnlyFromFiles(diffFiles: string[], enforcementData: string[]): boolean {
  return diffFiles.length > 0 && diffFiles.every(isInPlanScope) && enforcementData.length === 0;
}

/**
 * {@link planOnlyFromFiles} over a raw unified diff — the form run-task.ts's spawn gate needs,
 * since it has the diff text and not judgeReview's intermediates. Same predicate, one definition:
 * a change to plan-only classification lands in both callers or in neither.
 */
export function planOnlyDiff(diff: string): boolean {
  const diffFiles = changedFiles(walkDiff(diff));
  return planOnlyFromFiles(diffFiles, enforcementDataInDiff(diffFiles));
}

/**
 * W1-T2743 — ONE REVIEW, ONE EXECUTION PER UNIQUE PROOF.
 *
 * OBSERVED ON PR #3744 AT HEAD 5af85ec9. All six of its acceptance criteria named the
 * byte-identical proof `unit test: test/a-gate-shaped-instrument-that-nothing-invokes.test.ts`,
 * and the posted `review.posted` row carried six proof outcomes in order: one `executed_fail`,
 * then five `executed_pass`. That cannot describe six different facts — it is six samples of ONE
 * fact taken inside one supposedly atomic judgment, and the first sample alone failed the commit
 * status. (The path completed 22/22 in under a second in a clean clone and again in the daemon's
 * retained Azure worktree at the same sha; `execWhitelistedProof` called directly there returned
 * `pass` in 838ms. That does not prove the first live sample could never fail — it proves
 * repeating an identical proof MANUFACTURED contradictory evidence.)
 *
 * WHY IT HAPPENED. `judgeReview` maps every criterion through {@link judgeCriterion} with one
 * shared {@link ProofExecContext}, but that context carried the RAW executor, so each criterion
 * spawned its proof again. A passing proof is also re-run against the merge base for staleness
 * ({@link classifyBaseProofOutcome}), so N criteria citing one path could cost as many as 2N child
 * processes. `ensureDeps` and the browser preflight have process latches; the proof command itself
 * did not.
 *
 * THE IDENTITY IS SAFE BECAUSE IT IS ENTIRELY INSIDE ONE CALL. The key is checkout path plus
 * executable plus exact argv. `cwd` is IN THE KEY, so a head observation and a merge-base
 * observation of the same command can never alias — the one aliasing that would actually corrupt a
 * verdict, since staleness is decided by comparing exactly those two. And because the memo lives
 * and dies inside one `judgeReview` invocation, no sha can inherit another sha's result and there
 * is no invalidation policy to get wrong. THIS IS NOT A CROSS-REVIEW CACHE: a new head, body,
 * base, process or later review is a new observation and runs again.
 *
 * A THROW IS AN OBSERVATION TOO. `exec_error` (a timeout, an ENOENT, W1-T1077's broken runtime,
 * W1-T2740's truncated run) is terminal for that command in this checkout, so the memo replays the
 * SAME rejection rather than re-running and possibly disagreeing with itself. Retrying a transient
 * inside one atomic judgment is precisely the defect.
 */
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
  // `taskDeclaredFiles` is the existing resolved-task signal throughout this module. On the only
  // arm changed here — a plan-only diff — it means the criteria were loaded from the task shard,
  // not parsed from the PR body, so the proof arrived with the criteria and its filename cannot
  // be evidence about the body (W1-T2713). Implementing PRs and unresolved/body-derived filings
  // keep the proof-keyword floor byte-for-byte. BOTH arms score against the report — see
  // judgeCriterion's `floorKeywords` doc for why no arm may read the criterion itself (R-15).
  const floorKeywords = planOnly && (evidence.taskDeclaredFiles?.length ?? 0) > 0 ? "claim" : "proof";
  // W1-T456 (DEFECT A): read straight off THIS diff, never off a resolved task id — see
  // shardDeclaredFilesInDiff's doc for why a filing PR (no Remudero-Task: trailer, #1527) has
  // no task id to look `files:` up against otherwise. Union'd with a resolved task's own
  // declared files (evidence.taskDeclaredFiles) so a plain implementing PR loses nothing.
  const forwardReferenceFiles = new Set([...shardDeclaredFilesInDiff(evidence.diff), ...(evidence.taskDeclaredFiles ?? [])]);
  // Absent headCheckoutDir ⇒ execCtx is undefined ⇒ every criterion is
  // not_executable and the keyword floor is byte-identical to pre-W1-T65 —
  // exactly what every fixture/caller that predates this task still gets.
  // W1-T2743: ONE memo per judgeReview call, wrapping whichever executor this review would have
  // used — the injected one in tests, `execWhitelistedProof` in production. Built here rather than
  // inside judgeCriterion so that function stays byte-compatible for its audit/test callers
  // (auditMergedTaskClaims calls it one criterion at a time and must keep spawning per call).
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

  // W1-T274: see {@link ReviewVerdict.changesetContradictions}'s doc. A pure
  // comparison of two values already computed above (`evidence.report`,
  // `diffFiles`) — no new fetch, no new gateway.
  //
  // W1-T1100 (design (ii)): a detector that exists to compare the BODY's claims against the diff
  // must REFUSE on a substitute, not judge one — a body-vs-diff check is impossible without the
  // body, so this withholds the check entirely rather than manufacturing a contradiction from
  // prose that was never a claim about the changeset (measured live on #2395: "No code." fired
  // against a one-file diff whose real, unreadable-that-day body never said it).
  // W1-T1264: ONE call now produces both `changesetContradictions` AND the recognition count that
  // makes an empty `changesetContradictions` legible — see {@link
  // ReviewVerdict.changesetClaimsRecognised}'s doc. Withheld together with `changesetContradictions`
  // on a substitute report, for the identical reason: `undefined`/`undefined`, never `0`/`false`,
  // so "not computed" is never confused with "computed and found nothing".
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
  // W1-T2221: on a plan-only diff, `state` is decided on the FLOOR (mechanical/executed,
  // pre-downgrade) — a semantic downgrade alone must never fail a filing that has no code
  // for the semantic lane to judge (design (ii)). `planOnly` is the exemption, never "a
  // proof happened not to execute" — the same shape `criteriaTampered` above already uses,
  // and the one W1-T2221's rationale (6) says must not be re-derived from execution facts.
  // A code diff (`planOnly` false) is byte-identical to today: `unmetForState === unmet`.
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

  // W1-T166: the reward-hacking measurement, over ALL criteria — visible AND
  // holdout fold into `state` identically above; this is a SEPARATE per-run
  // MEASUREMENT of the gap between them, never a gate. `null` when either side
  // has nothing to measure (no holdout criteria declared, or no visible ones).
  const visibleVerdicts = visibleCriteria(verdicts);
  const holdoutVerdicts = verdicts.filter((v) => v.holdout);
  const visiblePassRate = visibleVerdicts.length > 0 ? visibleVerdicts.filter((v) => v.met).length / visibleVerdicts.length : null;
  const holdoutPassRate = holdoutVerdicts.length > 0 ? holdoutVerdicts.filter((v) => v.met).length / holdoutVerdicts.length : null;
  const rewardHackingGap = visiblePassRate !== null && holdoutPassRate !== null ? visiblePassRate - holdoutPassRate : null;

  // W1-T178 (verdict stability): the SAME rollup, but ignoring semantic entirely
  // — every criterion judged on its `floorMet` (mechanical/executed, pre-
  // downgrade). `testTheater`/`noCriteria`/`criteriaTampered`/
  // `changesetContradictions` are all structural (diff-derived), never
  // semantic, so they bind the floor exactly as they bind `state` — a
  // criteriaTampered or changeset-contradiction failure can never be
  // suppressed by verdict stability (W1-T178), which only ever forgives a
  // SEMANTIC downgrade. This is the anchor a re-review of an unchanged head
  // checks before trusting a downgrade.
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

  // W1-T72 (W1-T65 follow-up, legibility): nothing was OBSERVED on the PR head
  // anywhere in this review, yet at least one proof was WRITTEN to be runnable
  // (house dialect) — the binding verdict fell back to the blind keyword floor
  // on EVERY criterion, not because the proofs were legitimately prose. A
  // `satisfied_by` criterion is excluded: it never attempts execution BY
  // DESIGN (an Architect override), which is not a keyword-floor fallback.
  const executedCount = verdicts.filter(
    (v) => v.proof_exec === "executed_pass" || v.proof_exec === "executed_fail",
  ).length;
  const floorDegraded =
    executedCount === 0 && criteria.some((c) => !c.satisfied_by && isDialectPrefixed(c.proof));

  // W1-T185 (closes a W1-T128 gap — MASTER-PLAN rule 22 fixture (iii)): CAPPED
  // is a FACT about what ran, computed UNCONDITIONALLY — never gated on
  // `state`, never forcing it either (CAPPED IS NOT FAIL, criterion 3; see
  // {@link ReviewVerdict.capped}'s doc). `satisfied_by`-only criteria are
  // excluded from the "could have executed" set (an Architect override that
  // deliberately never attempts execution is not a capping concern); a review
  // with no executable criteria at all is never capped (nothing to observe).
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

  // W1-T185 (closes the second W1-T128 gap): this verdict never attempted
  // execution for ANY criterion (no `headCheckoutDir` was given at all) — the
  // case today when `rmd review`'s worktree materialization fails or is
  // skipped (the operator's working checkout is never substituted — HEAD
  // DISCIPLINE, W1-T65). Purely legibility: `state` is unaffected here (a
  // `not_executable`-only floor is the correct, long-standing behavior for
  // free-prose proofs), but the posted status/ledger/console must say so
  // plainly rather than let a keyword-only PASS read as an observed one.
  const keywordOnly = execCtx === undefined;

  // W1-T205: PLAN-ONLY CLASSIFICATION (`diffFiles`/`planOnly` — computed above,
  // ahead of `state`, so the W1-T58 guard could consult it). Reuses the review
  // path's OWN existing diff-walker (`changedFiles(walkDiff(...))` — the same
  // one {@link checkOneConcern} already uses to name a diff's changed files)
  // plus plan-architect's own plan-scope predicate ({@link isInPlanScope} — the
  // SAME guard `rmd plan`'s PROPOSED-outcome check and the W1-T136 filing-PR
  // emitter use) rather than inventing a third, divergent notion of "plan-only".
  // FAILS CLOSED: an empty diff, or one touching even a single file outside
  // `plan/**`/`MASTER-PLAN.md`, is NOT plan-only — see {@link
  // ReviewVerdict.planOnly}'s doc for why that direction is load-bearing.

  // A capped `state: "success"` NEVER uses passSummary's "substantiated"/"no
  // test theater" wording (criterion 1) — neither claim was measured. A
  // capped `state: "failure"` already renders via failSummary, which carries
  // its own specific unmet-criterion reason and never those two phrases
  // either, so no extra branch is needed there. A PLAN-ONLY success renders
  // via {@link planOnlySummary} instead of {@link cappedSummary}/{@link
  // passSummary} — see {@link ReviewVerdict.planOnly}'s doc (W1-T205): "0
  // proofs executed" is not a degradation for a PR with nothing executable to
  // point at, so the status must read as deterministically gated, never as an
  // uncertified claim.
  //
  // W1-T2221: `planOnly` is now consulted BEFORE `capped`, not behind it — a
  // plan-only diff whose declared proof path happened to resolve and RUN
  // (`capped` false) still reaches {@link planOnlySummary}, exactly like one
  // that executed nothing (`capped` true). Previously this branch was only
  // reachable through `capped`'s `true` arm, so a proof that resolved routed
  // a plan-only filing into `passSummary`/`failSummary` — the semantic-lane
  // verdict of a diff with no code for that lane to judge (design (i)/(ii)).
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
          // W1-T166: only VISIBLE unmet claims name themselves in the posted
          // summary — a holdout claim never reaches this text (see failSummary's
          // own doc for why: it becomes the commit-status description AND the
          // ledger's failure text, both worker-`gh`-readable).
          //
          // W1-T2221: `unmetForState` (not `unmet`) so a plan-only diff's failure text names
          // only genuine FLOOR failures, never a criterion that is merely semantically
          // downgraded while its floor already passed — `unmetForState === unmet` on a code
          // diff, so this is a no-op there (design (iv)).
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

/** The exact PASS status-description text, shared by {@link judgeReview} and a
 * verdict-stability suppression ({@link applyVerdictStability}) so a suppressed
 * downgrade posts a summary byte-identical to a review that passed outright —
 * never a "success" state paired with failure-shaped prose. `keywordOnly`
 * (W1-T185) appends an explicit "(keyword-only)" tag so a PASS with no proof
 * ever executed is never mistaken for an OBSERVED one — e.g. on the commit
 * status GitHub renders for `rmd review`'s manual-PR path. {@link
 * applyVerdictStability} passes the SUPPRESSED verdict's own `keywordOnly`
 * through unchanged, so a re-review that was keyword-only stays labeled that
 * way even when its semantic downgrade is suppressed back to success.
 *
 * `partial` (W1-T305, design (4)) appends an explicit "(PARTIAL: X/Y)" tag whenever SOME but not
 * ALL executable criteria were observed — never present alongside `keywordOnly` (that flag implies
 * ZERO executed anywhere, which routes through {@link cappedSummary} instead, never here), so a
 * partially-certified PASS is never rendered identically to a fully-certified one. */
function passSummary(criteriaCount: number, keywordOnly = false, partial?: { executed: number; executable: number }): string {
  return (
    `remudero-review: PASS — ${criteriaCount} criteria substantiated, no test theater` +
    (partial ? ` (PARTIAL: ${partial.executed}/${partial.executable} proofs executed on the PR head)` : "") +
    (keywordOnly ? " (keyword-only: no proof was executed on the PR head)" : "")
  );
}

/** The CAPPED status-description text (W1-T185) — posted whenever a verdict
 * that would otherwise render as a clean PASS observed zero proof executions.
 * Deliberately contains neither "substantiated" nor "no test theater"
 * (criterion 1's falsifier, verbatim: PR #411 posted PASS text at
 * `proof_exec: 0/5` directly beneath its own FLOOR DEGRADED banner) — CAPPED
 * means "not certified", never "rejected" (criterion 3: this is still a
 * `state: "success"` commit status, never a red check). `keywordOnly`
 * (W1-T185, gap 2) appends the same explicit tag {@link passSummary} does, so
 * a materialization-failure fallback names BOTH facts in one description
 * (criterion 5). */
function cappedSummary(criteriaCount: number, keywordOnly = false, enforcementData: string[] = []): string {
  return (
    `remudero-review: CAPPED — 0/${criteriaCount} proofs executed; not certified ` +
    `(a keyword match is a claim, not evidence)` +
    (keywordOnly ? " (keyword-only: no proof was executed on the PR head)" : "") +
    // W1-T427: a plan-scope diff that is nonetheless NOT plan-only must SAY WHY on the status
    // itself. This is the only rendering an operator sees for the denial, and an unexplained red
    // is the shape that gets overridden ({@link failSummary}'s own reasoning) — here it would
    // read as the carve-out mysteriously failing rather than as the category doing its job. The
    // capped-SUCCESS path is the one that matters: a failing review already renders its own
    // specific reason via {@link failSummary}, and {@link ReviewVerdict.planOnly} is consequential
    // only for a capped success (the arm) anyway.
    (enforcementData.length > 0
      ? ` (ENFORCEMENT_DATA: ${enforcementData.join(", ")} — the plan-only carve-out does not ` +
        `apply to the data the gates themselves obey)`
      : "")
  );
}

/** The PLAN-ONLY status-description text (W1-T205) — posted in place of {@link
 * cappedSummary} whenever a capped success's diff is plan-only (see {@link
 * ReviewVerdict.planOnly}). Deliberately never says "CAPPED" or "not certified":
 * those words read as something going wrong, and for a plan-only PR nothing
 * did — filing or amending a task has no code to run a proof against, so "0
 * proofs executed" is its permanent, correct shape, not a degradation. Names
 * what actually gated the PR (lint-plan + the W1-T136 plan-PR emitter's own
 * structural checks + plan-index regeneration) so an operator reading the
 * status is told the truth either way (standing rule 22: state the verdict
 * honestly, claimed versus evidenced) — never that a proof executed, but also
 * never that this PR's honest structural shape is a failure mode. */
function planOnlySummary(criteriaCount: number): string {
  return (
    `remudero-review: PASS — plan-only PR (${criteriaCount} criteria), gated deterministically ` +
    `(lint-plan + the plan-PR emitter + plan-index checks); no proof execution attempted, ` +
    `by design (W1-T205)`
  );
}

// ── VERDICT STABILITY (W1-T178) ─────────────────────────────────────────────
//
// FIXTURE this fixes: PR #388 posted remudero-review=success at 20:28:27Z then
// =failure at 20:30:47Z against the IDENTICAL head sha 1fbea36…, no new commit
// in between. The second (wrong) verdict burned fix-rung strike 2 and drove
// escalation #395 a second later — the flip was the PROXIMATE CAUSE of the
// strike-out, not a cosmetic flap.
//
// RULE: a re-review of an UNCHANGED head sha whose deterministic FLOOR still
// passes may not render a verdict WORSE than its predecessor. The semantic
// lane's downgrade on that input is noise — nothing changed for it to have
// newly observed. A legitimate downgrade always cites NEW INFORMATION: a
// changed head sha, or the mechanical floor itself failing — either bypasses
// this rule entirely and the computed verdict posts unmodified.
//
// ASYMMETRIC BY DESIGN — do not "fix" this into a general sha-pinned-verdict
// rule; see W1-T102. Only a SUCCESS→failure transition on an unchanged sha is
// suppressed. A failure→success transition (an UPGRADE) always posts as
// computed, which is exactly the path W1-T102 opened for body-only fixes to be
// recognised. Pinning symmetrically would re-create the #177 stale-status
// exhaustion T102 fixed.
// ────────────────────────────────────────────────────────────────────────────

/** The most recent `review.posted` verdict recovered from the ledger for a PR
 * — {@link applyVerdictStability}'s `prior` argument. */
export interface PriorReviewVerdict {
  headSha: string;
  state: ReviewState;
  /**
   * W1-T229's `capped` as it was RECORDED on the `review.posted` line — read back rather than
   * recomputed, so the arming path judges the same fact the review posted. It has always been
   * written ({@link reviewLedgerLegibilityFields}); nothing read it, so a CAPPED verdict — which
   * posts `state: "success"` because CAPPED IS NOT FAIL — armed on the strength of that success
   * alone, on every lane routed through {@link decideArmFromLedgerVerdict}.
   *
   * ABSENT MEANS NOT CAPPED (operator ruling, binding). Lines older than the field carry no
   * `capped` key at all, and failing closed on them would refuse to arm across the entire
   * pre-field history — the shape of a governor that could not read usage and idled the fleet
   * for three hours. An unreadable field fails OPEN here; {@link cappedFieldAbsent} keeps that
   * choice legible rather than silent.
   */
  capped: boolean;
  /** Recorded `plan_only`. Carried because {@link decideAutoMergeArm}'s W1-T205 carve-out reads
   *  it; same absent-means-false rule. */
  planOnly: boolean;
  /** True when the ledger line carried no `capped` key at all, so {@link capped} above is the
   *  fail-open DEFAULT rather than a recorded fact. Surfaced in the arm decision's own reason
   *  string — no new ledger step, so a polling lane cannot amplify it into per-tick noise. */
  cappedFieldAbsent?: true;
  /**
   * W1-T1020: recorded `partially_executed`, read back the same way `capped`/`planOnly` already
   * are — so {@link decideAutoMergeArm} judges the SAME partial-execution fact the review
   * actually posted, instead of the always-false default it silently took before this field was
   * threaded through. Written unconditionally by {@link reviewLedgerLegibilityFields} (never
   * absent on a line that carries `partially_executed` at all), so ABSENT MEANS NOT PARTIAL —
   * the same fail-open default `capped` uses for lines older than the field. OPTIONAL (not a
   * bare `boolean` like `capped`/`planOnly`) purely so every existing `PriorReviewVerdict`
   * fixture across the suite that predates this field keeps compiling byte-for-byte; every
   * caller must still treat a missing value as `false`, never as "unknown, so skip the check".
   */
  partiallyExecuted?: boolean;
}

/** Result of applying the W1-T178 verdict-stability rule to a freshly computed verdict. */
export interface VerdictStabilityResult {
  /** The verdict to actually POST — identical to `computed` unless a downgrade was suppressed. */
  verdict: ReviewVerdict;
  /** True when a semantic-lane downgrade on unchanged input was suppressed this call. */
  suppressed: boolean;
}

/**
 * Recover the most recent `review.posted` verdict for `taskId` from ledger
 * lines, "last one wins" — the SAME scanning idiom `unmetFromLedger`
 * (run-task.ts) and every other precedence helper in this codebase already
 * use, applied to the same `review.posted` line that carries `head_sha` +
 * `state`. No new storage: the ledger already records every posted verdict.
 */
export function priorReviewVerdictFromLedger(
  lines: ReadonlyArray<Record<string, unknown>>,
  taskId: string,
): PriorReviewVerdict | undefined {
  let prior: PriorReviewVerdict | undefined;
  for (const line of lines) {
    if (line.step !== "review.posted" || line.task_id !== taskId) continue;
    if (typeof line.head_sha !== "string") continue;
    if (line.state !== "success" && line.state !== "failure") continue;
    // `capped`/`plan_only` are read back from the SAME line that carried `state`, never
    // recomputed — the arming path must judge the verdict that was actually posted. A
    // non-boolean (absent on a pre-W1-T185 line, or malformed) is the fail-open default,
    // recorded via `cappedFieldAbsent` so the decision can say it took that default.
    const cappedRecorded = typeof line.capped === "boolean" ? line.capped : undefined;
    prior = {
      headSha: line.head_sha,
      state: line.state,
      capped: cappedRecorded ?? false,
      planOnly: typeof line.plan_only === "boolean" ? line.plan_only : false,
      ...(cappedRecorded === undefined ? { cappedFieldAbsent: true as const } : {}),
      // W1-T1020: same "absent means false" rule as `capped`/`plan_only`, but — like
      // `cappedFieldAbsent` above — spread in ONLY when the line actually carries the key, so a
      // line older than W1-T305 (or any fixture built before this field existed) reconstructs a
      // byte-identical object rather than gaining a new `partiallyExecuted: false` key nobody
      // asked for.
      ...(typeof line.partially_executed === "boolean" ? { partiallyExecuted: line.partially_executed } : {}),
    };
  }
  return prior;
}

/**
 * Apply the W1-T178 verdict-stability rule (see block comment above) to a
 * freshly `judgeReview`-computed verdict. Pure — the falsifier this exists to
 * prove is a unit fixture, exactly like `judgeReview` itself.
 */
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

  // The floor passed ⇒ every criterion's floorMet is true; rebuild the criteria
  // list off the floor result so the posted verdict stays internally consistent
  // (a "success" state whose criteria all read met, not a success sitting next
  // to a criteria array that still shows a semantic "unmet").
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

/**
 * The LOUD console annotation for a degraded floor (W1-T72, design (i)) —
 * printed once per review when {@link ReviewVerdict.floorDegraded} is true.
 * `criteriaCount` is the total number of criteria judged (the "N" in "0/N").
 * Pure + exported so the exact text is a unit-testable falsifier, independent
 * of the console call site (run-task.ts).
 */
export function floorDegradedAnnotation(criteriaCount: number): string {
  return (
    `FLOOR DEGRADED: 0/${criteriaCount} proofs executed; keyword floor was binding — ` +
    `a dialect-prefixed proof ('grep: …' / 'unit test: …') was written to be runnable ` +
    `but nothing was observed on the PR head.`
  );
}

/**
 * True when a task's `principles` field (plan/tasks.yaml `principles: {tdd:
 * strict}`) declares `tdd: strict`. The ONLY input {@link judgeReview} consults
 * to decide whether a zero-executed verdict is CAPPED (W1-T185) — a task that
 * never declared tdd:strict never gets capped, because it never claimed
 * executed proof was mandatory in the first place.
 */
export function isTddStrict(principles?: Record<string, unknown>): boolean {
  return principles?.tdd === "strict";
}

/**
 * The LOUD console annotation for a CAPPED verdict (W1-T185) — printed once per
 * review when {@link ReviewVerdict.capped} is true. Mirrors
 * {@link floorDegradedAnnotation}: pure + exported so the exact text is a
 * unit-testable falsifier, independent of the console call site (run-task.ts).
 *
 * W1-T1085 — `planOnly` APPENDED LAST AND DEFAULTED, so no existing caller shifts. The posted
 * STATUS has been a three-way branch since W1-T205 (plan-only capped renders
 * {@link planOnlySummary}, capped renders {@link cappedSummary}, uncapped renders
 * {@link passSummary}) while this annotation stayed two-way, so one run emitted two contradictory
 * sentences about the same verdict. Every clause of the capped wording is FALSE for a plan-only
 * PR: it IS certified, by the deterministic gates the status names; it does NOT refuse to arm
 * ({@link decideAutoMergeArm} branches on `planOnly` and returns `arm: true`); and the override it
 * points at is never reached, because that branch returns above the override branch — so the
 * advice cannot be followed even in principle.
 *
 * THE CAPPED WORDING IS UNCHANGED where proof was expected and did not run. This adds a second
 * arm; it does not weaken the first.
 */
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

/**
 * W1-T1085 — is the CAPPED DEGRADATION WORDING actually true of this verdict? `reviewCommand`
 * (run-task.ts) has TWO further call sites beyond {@link cappedAnnotation}, both gated on `capped`
 * alone: the `— CAPPED: not certified (0 proofs executed)` suffix on its posted-status line, and
 * the `--override-capped-by` hint below it. Both are false for a plan-only PR, the second for a
 * structural reason: {@link decideAutoMergeArm} checks `planOnly` BEFORE the override branch, so
 * such a verdict never reaches an override even when one is present, and `resolveAutoMergeArm`
 * deliberately excludes `planOnly` from override-ledgering so the decision is not misattributed —
 * which makes the hint advice that cannot be followed even in principle.
 *
 * A pure predicate rather than an inline condition at each `console.log`, so both arms are
 * falsifiable on their own. Both sites stay exactly as they are for a capped CODE PR, which is
 * the case the wording was written for.
 */
export function cappedWordingApplies(verdict: { capped?: boolean; planOnly?: boolean }): boolean {
  return verdict.capped === true && verdict.planOnly !== true;
}

// ── THE AUTO-MERGE ARMING PATH (W1-T185, closes gap 1's criteria 2-3) ───────
//
// GAP: `judgeReview`'s `state`/`capped` alone cannot express "cannot arm
// unattended" without ALSO reddening every PR the moment a proof is
// unparseable (criterion 3 forbids exactly that). So arming is a SEPARATE
// decision layer, consulted by the CALLER right before it would otherwise
// call `armAutoMerge` — never folded into `state`/`floorState`.
// ────────────────────────────────────────────────────────────────────────────

/**
 * An explicit, human-granted exception to "a CAPPED verdict cannot arm
 * auto-merge" (design: "an override is a decision someone made, and it must
 * be attributable"). Never inferred, never anonymous — `by` names WHO.
 * Granted via `rmd review <pr> --override-capped-by/
 * --override-capped-reason` (run-task.ts) and recovered from the ledger by
 * {@link cappedOverrideFromLedger}.
 *
 * W1-T219 (recon R-14): `headSha` BINDS the override to the PR head it was
 * granted against. Before this field existed, the override was an
 * unauthenticated free string — `cappedOverrideFromLedger` matched on
 * `task_id` alone, "last one wins" over an append-only, unlocked ledger — so
 * one appended line armed auto-merge on a CAPPED verdict for ANY later head of
 * that task, including a different diff the operator never saw when they
 * granted it. `cappedOverrideFromLedger` now refuses to return an override
 * whose `headSha` does not match the verdict currently being judged, so a
 * stale or forged append cannot outlive the diff it was judged on. Optional on
 * this TYPE only so a caller that already holds a hand-attributed override
 * (e.g. {@link decideAutoMergeArm}'s own unit fixtures, which test the arming
 * decision in isolation from ledger recovery) needn't fabricate one — the
 * binding is actually ENFORCED at recovery time, in
 * {@link cappedOverrideFromLedger} itself.
 */
export interface CappedOverride {
  by: string;
  reason: string;
  headSha?: string;
}

/** The auto-merge arming path's decision (W1-T185). */
export interface ArmDecision {
  arm: boolean;
  reason: string;
  /** W1-T2579 — set ONLY when a band row that matched the resolved verdict class was itself
   *  malformed (an unrecognized `verdict`, never a missing/mismatched `class` — that is simply
   *  "no matching row", not malformed). `arm`/`reason` are left EXACTLY as the band table had
   *  never been consulted at all (the fail-inert arithmetic contract, design (ii)) — this field
   *  is the "named" half of "a malformed band row is inert and NAMED rather than disarming or
   *  holding anything", carried out-of-band so it can never perturb the byte-equality the
   *  absent/empty-table falsifier checks on `arm`/`reason` alone. */
  bandWarning?: string;
}

/**
 * W1-T2579 — resolve which {@link ArmCalibrationBandRow} class an already-arming (uncapped)
 * verdict belongs to, mirroring `verdict-calibration.ts`'s own {@link
 * import("./verdict-calibration.js").VerdictClass} split (this file never imports that module —
 * these two string literals are the same taxonomy, kept independent so this arming seam never
 * takes a dependency on the measurement module it is deliberately downstream of, not coupled to).
 * The THIRD class, `"degraded-arm"` (CAPPED), is never returned here — {@link
 * decideAutoMergeArm} never calls this resolver on the capped branch at all (design (iii): the
 * capped class is refused band eligibility BY CONSTRUCTION, at the call site).
 */
type BandEligibleVerdictClass = "full-pass" | "keyword-floor";

/**
 * W1-T2579 — apply an operator-ratified {@link PolicyValues.armCalibrationBands} table to an
 * ALREADY-ARMING decision. Pure: never mutates `base`, never consults anything but its own
 * arguments. `bands` is treated defensively (typed as an array of the shape policy.ts's loader
 * produces, but a caller — including this module's own unit fixtures — may hand it a row the
 * loader would have refused) — see the malformed-row branch below for exactly what "defensive"
 * means here.
 *
 * - No row names `verdictClass` (table absent, empty, every row a different class, or a class
 *   the table does not name at all) → `base` returns UNCHANGED, byte-for-byte — the arithmetic
 *   contract this whole feature is gated on.
 * - The first matching row's `verdict === "hold"` → refuses, naming the class in the reason
 *   (`calibration-band:<class>`) — an operator-ratified hold is a REFUSAL, not a mere note, so
 *   the reason states it as one, exactly like every other refusal reason in this file.
 * - `verdict === "notify"` → `base.arm` is untouched (band ⊆ {hold, notify}; notify only ever
 *   narrows an already-true `arm` to "true, annotated" — it can never flip a refusal to an arm,
 *   which design (iii) forbids); the reason gains the band's class and, when present, its `note`.
 * - Anything else (a `verdict` that is neither `"hold"` nor `"notify"` — reachable only via a
 *   caller-injected `bands` array, since policy.ts's own loader refuses this shape at load) is a
 *   MALFORMED row: `base` returns UNCHANGED (arm AND reason, matching the absent/empty case
 *   exactly), but `bandWarning` names which class's row was ignored and why — inert, never
 *   disarming or holding, but never silent either.
 */
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

/**
 * Decide whether the auto-merge arming path may proceed, given a freshly
 * computed review verdict, whether the task under review declares
 * `principles: {tdd: strict}`, and an optional operator override. Pure.
 *
 * - `state !== "success"` → refuse. The ordinary required-check gate;
 *   unrelated to capping (a genuinely failing review was ALWAYS refused).
 * - W1-T229: A CAPPED verdict (zero proofs executed) refuses to arm
 *   UNCONDITIONALLY, regardless of `tddStrict` — a prior version of this
 *   function armed any capped, non-tdd:strict PR exactly as if it were an
 *   ordinary PASS, which made "declare tdd:strict" the ONLY thing standing
 *   between zero executed proof and an unattended merge, and tdd:strict is
 *   not the default. `tddStrict` is retained purely for override-provenance
 *   bookkeeping ({@link resolveAutoMergeArm}), never for gating.
 * - W1-T205 (the operator's standing rider on W1-T229): a `planOnly` CAPPED
 *   verdict arms WITHOUT needing an override. Checked BEFORE the override
 *   branch so a plan-only PR's arm reason always names the carve-out, never
 *   an override that was never actually consulted (also why {@link
 *   resolveAutoMergeArm} excludes `planOnly` from its override-ledgering
 *   condition — logging "override used" for a decision an override never
 *   drove would misattribute it). Plan-only PRs are STRUCTURALLY capped —
 *   filing or amending a task has no code to run a proof against — so
 *   "capped never arms without an override" would block every retro, approve
 *   and filing PR forever; this is an exemption from PROOF EXECUTION only,
 *   never from `state` (an unmet plan-only PR still refuses above).
 * - An override permits arming, on any other capped verdict. Whether the
 *   caller actually LEDGERS that override is {@link resolveAutoMergeArm}'s
 *   job, not this pure predicate's — keeping this function side-effect-free
 *   is what makes "refuses without an override; permits with one" a single
 *   unit fixture (acceptance criterion 2), independent of ledger/CLI
 *   plumbing.
 * - W1-T1020: an UNCAPPED verdict that only observed SOME of its executable
 *   criteria (`partiallyExecuted`) still arms — legibility never becomes a
 *   new refusal — but its reason NAMES the partial shape instead of
 *   asserting a full PASS. The fraction is named only when the caller's
 *   verdict actually carries the counts (`executedProofCount`/
 *   `executableProofCount`); a caller that only has the recorded BOOLEAN
 *   (the ledger-reconstruction path, {@link priorReviewVerdictFromLedger})
 *   still gets a reason that says "partial", just without the numerator. A
 *   verdict with no `partiallyExecuted` field at all (an older caller that
 *   never threaded it through) is indistinguishable from "not partial" and
 *   keeps today's unqualified "verdict is a full PASS" — absent means
 *   unknown, and unknown must never regress to a WORSE (refusing) outcome,
 *   matching every other absent-field default in this file.
 * - W1-T2579: AFTER the full-pass/partial-pass decision is computed (i.e. only on the
 *   already-arming, uncapped path — the CAPPED branch below, including its `planOnly`/
 *   `override` arms, is NEVER reached by the band table; design (iii)'s "the capped class is
 *   not band-eligible"), the resolved verdict class (`full-pass`/`keyword-floor`) is looked up
 *   in `bands` (an operator-ratified {@link PolicyValues.armCalibrationBands} row) via {@link
 *   applyCalibrationBand}. A `hold` band refuses; a `notify` band arms and annotates; no match
 *   (table absent, empty, or naming a different class) leaves the decision UNCHANGED. `bands`
 *   defaults to the COMMITTED `plan/policy.yaml` table ({@link loadDefaultPolicy}) — ships
 *   empty, so every call site that omits this parameter keeps today's behavior byte-for-byte
 *   (test/arm-calibration-bands.test.ts) — but stays directly injectable (same "defaulted
 *   parameter, `?? loadDefaultPolicy()`" seam this file's `proofTimeoutMs` default already
 *   uses) so a unit fixture never touches disk to exercise a ratified band.
 */
export function decideAutoMergeArm(
  verdict: Pick<ReviewVerdict, "state" | "capped" | "planOnly"> &
    Partial<Pick<ReviewVerdict, "partiallyExecuted" | "executedProofCount" | "executableProofCount">>,
  tddStrict: boolean,
  override?: CappedOverride,
  // W1-T947 (DECISIONS.md's 2026-08-16 ruling, W1-T919: the fleet gates on IRREVERSIBILITY, not
  // outwardness): a DIFF-DERIVED classification, never the static `risk:` field (that
  // non-consultation is a standing ruling this preserves, not reverses). Appended LAST, exactly
  // like `override` above, so no positional caller shifts — every existing call site that omits
  // it keeps today's behavior byte-for-byte.
  irreversible?: boolean,
  // W1-T2579: THE RATIFIED BAND TABLE. Appended LAST, exactly like `irreversible` above, so no
  // positional caller shifts. `undefined` (every existing call site) resolves to the COMMITTED
  // `plan/policy.yaml` row via `loadDefaultPolicy()` — ships `[]`, so omitting this parameter
  // keeps today's behavior byte-for-byte. A caller (this file's own unit fixtures included) that
  // wants a specific table injects one directly, never touching disk.
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

/**
 * The auto-merge arming path, WITH its ledger side effect (W1-T185, criterion
 * 2's "writes an attributable ledger line naming the overrider"). Wraps
 * {@link decideAutoMergeArm}: when arming succeeds ONLY because an override
 * was supplied for a genuinely capped verdict (W1-T229: any capped verdict,
 * not just a tdd:strict one), this logs `automerge.capped_override_used`
 * naming who — an override that arms silently is exactly the #411 hazard
 * this task closes (auto-merge armed unattended, no human reading the diff).
 * `log` is injected so the whole contract — refuse without an override, arm +
 * LEDGER with one — is a single unit fixture; `run-task.ts`'s `runTaskBody`
 * is the real caller.
 */
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
//
// Today `gh` runs OUTSIDE the sandbox with the operator's own ambient
// credential (recon R-3/R-6), and that credential is the ONLY thing on the
// machine that can post a commit status — so any identity that can shell out
// to `gh` (including a worker) can post its own `remudero-review=success` and
// satisfy its own merge gate. This section closes the read-back half: at ARM
// TIME, whoever is about to trust a live `remudero-review` status must first
// ask GitHub WHO posted it (the commit-status API's `creator.login`, which
// GitHub attributes from the authenticating credential — a worker cannot make
// this say anything but its own identity, unlike the state/description/context
// fields, which are just request payload). The credential half (a dedicated
// identity {@link postReviewStatus} authenticates as, which workers never
// hold) and the deny-floor half (hooks/deny-floor.sh refusing a worker's own
// status-POST attempt) are the other two parts of the same property.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Env var naming the GitHub login the dedicated `remudero-review` reviewer
 * identity authenticates as (a fine-grained PAT or GitHub App installation
 * token's own login/slug — e.g. `remudero-reviewer[bot]`). Read by the
 * orchestrator ONLY (never shipped to a worker's environment — the same
 * containment property `~/.config/remudero/**` already gets in
 * `settings/worker.json`'s deny-list); {@link resolveReviewProvenance}'s
 * caller supplies it explicitly so the pure function never reaches into
 * `process.env` itself.
 */
export const REVIEWER_IDENTITY_ENV = "REMUDERO_REVIEWER_LOGIN";

/**
 * Env var naming the dedicated reviewer identity's own credential.
 * {@link postReviewStatus} uses it (as `GH_TOKEN`, overriding whatever `gh`
 * would otherwise resolve from the ambient environment) when set, so the
 * ONE status that must carry unforgeable provenance is posted by an identity
 * distinct from the operator/worker credential every other `gh` call on the
 * machine shares. Unset ⇒ `postReviewStatus` falls back to ambient `gh` auth,
 * byte-identical to pre-W1-T203 behavior — the same bootstrap-ordering
 * doctrine `docs/review-gate.md` already documents for `ci-gate`: a
 * provenance gate armed before the dedicated identity exists would deadlock
 * every merge, so this ships DARK until an operator provisions the identity
 * and sets both env vars.
 */
export const REVIEWER_TOKEN_ENV = "REMUDERO_REVIEWER_TOKEN";

// ── THE PIN PRECONDITION (W1-T2442) ─────────────────────────────────────────
//
// `required_status_checks.checks[].app_id` is the ONLY thing that turns a required context from
// "satisfied by convention" into "satisfied by a pinned identity" — a null `app_id` is not a
// weaker pin, it is NO pin (any repo-scoped token satisfies it). Pinning `remudero-review` is the
// obvious next step, but Q2 of this task's own rationale records why it is not yet safe: pinning
// before the reviewer identity is provisioned AND observed live would make the gate fail closed
// with no signal (every fleet-posted status rejected for a mismatched app, symptom-free). This
// section is a PURE READER of that precondition — it never provisions a credential, never writes
// branch protection, never scopes a token (all three explicitly out of scope by operator
// instruction). What it answers: is pinning safe to apply YET, given the reviewer identity's
// CURRENT posture — so that when the credential backlog (W1-T203/W1-T990) is picked up, the
// answer is measured rather than argued.
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

/**
 * Acceptance criterion 1: names every required context whose `app_id` is `null` (unpinned —
 * satisfied by any repo-scoped token) and omits any context that already carries a real,
 * non-null `app_id` (an app-pinned one, e.g. `ci-gate`'s `15368`). Pure; reads only `checks[]`.
 */
export function unpinnedRequiredContexts(snapshot: RequiredStatusChecksSnapshot): string[] {
  return snapshot.checks.filter((c) => c.app_id === null || c.app_id === undefined).map((c) => c.context);
}

/**
 * Acceptance criterion 2: the reviewer identity's posture, resolved to EXACTLY three states —
 * never collapsed to a boolean, and never allowed to *guess* "provisioned" from a read it could
 * not actually perform:
 *
 * - `"dark"` — neither {@link REVIEWER_TOKEN_ENV} nor {@link REVIEWER_IDENTITY_ENV} is set. The
 *   documented default this ships in (the comment above {@link REVIEWER_TOKEN_ENV}) — a real,
 *   successful read that found nothing, same "absent, not a failure" shape `resolveReviewProvenance`
 *   already uses above.
 * - `"unknown"` — the read itself failed (`readEnvVar` threw, e.g. an unreadable environment) OR
 *   only ONE of the two vars is set (an inconsistent, half-configured state that is neither the
 *   documented dark default nor a genuine provisioning). Degrading a failed/partial read to
 *   `"unknown"` rather than guessing either neighbor is the point: it can NEVER render as
 *   `"provisioned"` off an environment this function could not actually confirm.
 * - `"provisioned"` — BOTH vars are set (non-empty). The only state {@link reviewGatePinPrecondition}
 *   treats as safe to pin against.
 *
 * Pure — `readEnvVar` is supplied by the caller so this never reaches into `process.env` itself
 * (same discipline {@link REVIEWER_IDENTITY_ENV}'s own doc records for `resolveReviewProvenance`).
 */
export function reviewerIdentityPosture(readEnvVar: (name: string) => string | undefined): ReviewerIdentityPosture {
  let token: string | undefined;
  let login: string | undefined;
  try {
    token = readEnvVar(REVIEWER_TOKEN_ENV);
    login = readEnvVar(REVIEWER_IDENTITY_ENV);
  } catch {
    // W1-T2295 route (iv) — THE REASON, STATED, because the return value alone cannot carry it.
    // A throwing `readEnvVar` (an unreadable environment, an injected seam that refuses) and a
    // successful read that found nothing are DIFFERENT facts, and this function already renders
    // them differently: the failed read is `"unknown"`, the successful empty read is `"dark"`.
    // The distinction is real and deliberate; it is simply invisible to the ratchet's detector,
    // which sees a bare string literal with no `reason:`/`ok:` key to inspect. Nothing is erased
    // here — `"unknown"` can never be mistaken for `"provisioned"`, which is the whole point of
    // the three-state split this function's own doc describes above.
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

/**
 * THE PRECONDITION READER (acceptance criteria 3-5). A pure statement of whether pinning
 * `remudero-review`'s `app_id` is safe to apply YET — never the pin itself, never a credential.
 *
 * - Reviewer identity `"dark"` or `"unknown"` ⇒ ALWAYS `"unsafe"`, naming {@link REVIEWER_TOKEN_ENV}
 *   in the reason (criterion 3) regardless of which/how-many contexts are currently unpinned —
 *   an unconfirmed identity is unconfirmed whether there is one unpinned context or none.
 * - Reviewer identity `"provisioned"` ⇒ `"safe"` — including the falsifier (criterion 5) where
 *   the context in question is ALREADY app-pinned: this reader is not hardcoded to `"unsafe"`,
 *   and a provisioned identity paired with an already-pinned context is the plainest possible
 *   safe state.
 *
 * `reviewerCredentialPresent` reports presence derived from `reviewerIdentity` alone on every
 * arm (criterion 4) — this function is never handed a token or login value, only the posture
 * {@link reviewerIdentityPosture} already resolved, so no value can leak through it.
 */
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

/**
 * One fetched `remudero-review` commit-status entry — the two fields
 * {@link resolveReviewProvenance} needs off GitHub's "get the combined status
 * for a ref" response (`.statuses[]`, already deduped to the latest post per
 * context by GitHub itself). `undefined` means no status has ever been posted
 * under this context for the sha in question.
 */
export interface ReviewStatusEntry {
  /**
   * W1-T913: widened to {@link PostableReviewState} — a LIVE read off GitHub can genuinely be
   * `pending` now that {@link postReviewPending} posts one. {@link decideAutoMergeArmAtSha}'s own
   * doc covers why a pending is never armed and never confused with the untrusted-poster/absent
   * case.
   */
  state: PostableReviewState;
  /**
   * GitHub's `creator.login` for this status — the one field a poster cannot
   * spoof (server-attributed from the authenticating credential, never from
   * the request body). `undefined` only if GitHub's response is itself
   * malformed/incomplete; treated the same as a mismatched login (untrusted).
   */
  posterLogin?: string;
}

/**
 * THE PROVENANCE GATE (acceptance criteria 1-3). Resolve what a fetched
 * `remudero-review` status ACTUALLY proves, gated on WHO posted it:
 *
 * - No status at all → `"absent"`.
 * - A status posted by anyone OTHER than `trustedLogin` → `"absent"` —
 *   REGARDLESS of its `state`. This is deliberate and covers BOTH forge
 *   directions: an untrusted `success` must not rescue a merge a genuine
 *   review would have failed (criterion 1), and an untrusted `failure` must
 *   not BLOCK a merge a genuine review would have passed (criterion 2) — the
 *   design's "treat a forged verdict as absent, never as a fail": mapping a
 *   hostile poster's `failure` to a real failure converts the forge vector
 *   into a denial-of-service vector, which is worse (an attacker can already
 *   forge `success`; letting them ALSO forge `failure` costs the operator a
 *   legitimate merge instead of only a hostile one).
 * - A status posted by `trustedLogin` → its own `state`, unchanged — the
 *   autonomous merge path is byte-identical to pre-W1-T203 for every
 *   non-forged PR (criterion 3). W1-T913: this now includes a trusted
 *   `pending` passing straight through, unfiltered by provenance — it is
 *   {@link decideAutoMergeArmAtSha} below that keeps a `pending` from ever
 *   being read as a verdict, never this function pretending it is "absent".
 *
 * Pure and case-insensitive on the login compare (GitHub logins are
 * case-insensitive for uniqueness, so a byte-exact compare would be a false
 * mismatch waiting to happen).
 */
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

/**
 * The "at arm time" half of the property (acceptance criteria 1-3): whatever
 * a caller computed in-process, THIS is what decides whether the LIVE status
 * on GitHub — read back and filtered by who posted it — still says a genuine
 * reviewer passed the PR. Deliberately narrow and orthogonal to
 * {@link decideAutoMergeArm}'s capped/override layer (which reasons about a
 * verdict computed BEFORE anything could have been posted, and is unaffected
 * by this gate): this function only ever answers "is the CURRENTLY-LIVE
 * remudero-review, filtered by provenance, a success" — a caller arms only
 * when BOTH this AND {@link decideAutoMergeArm} say yes.
 *
 * An absent/untrusted resolution refuses with a reason that never says
 * "failure" — {@link decideAutoMergeArm}'s "not success" wording is reserved
 * for a GENUINE failing review, so a forged or missing status is never
 * confused with one in a log line or an escalation (criterion 2: a hostile or
 * buggy poster's `failure` is exactly as inert here as its `success` would
 * be — neither can move this decision off "wait for a real one").
 */
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
  // W1-T913 (design (e)): a trusted PENDING is neither "success" nor "failure" nor "absent" — it
  // is a review genuinely in progress. NAMED explicitly, ahead of the untrusted-poster/no-status
  // fallback below, so a pending is never worded as if it were forged or missing (it is neither)
  // and never as a failure (arming stays withheld exactly the same either way, but the REASON
  // must stay honest — "never read as a verdict in either direction" is the falsifier).
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
//
// #449's incident: the `remudero-review` commit status took SEVEN contradictory
// writes on one sha (including a keyword-only CAPPED success overwriting an
// executed failure), with one write 85 SECONDS AFTER the PR merged. GitHub's
// commit-status API is a mutable, last-write-wins channel that anything holding
// `gh` can post to — the W1-T203 provenance gate above closes one forge vector,
// but it is DARK in production (REVIEWER_IDENTITY_ENV is unset), so today the
// channel is exactly as trusted as before W1-T203 shipped. The house doctrine
// already answers this in the other direction: task status derives from GitHub
// rather than tasks.yaml because the yaml field proved decorative. Here the fix
// runs the other way — the arm decision derives from the orchestrator's OWN
// ledgered verdict because the status channel proved decorative AND writable,
// strictly worse than decorative. The status stays posted (branch protection,
// display) but from here on it is never an INPUT to this decision.
// ────────────────────────────────────────────────────────────────────────────

/**
 * THE ARM DECISION (W1-T230). Given the most recent `review.posted` verdict
 * this orchestrator itself ledgered for a task ({@link priorReviewVerdictFromLedger})
 * and the CURRENT live head sha, decide whether to arm auto-merge. Pure — the
 * whole point is that a fresh process can re-derive this identically from
 * nothing but the ledger + the live head, never from in-process memory
 * (acceptance criterion 3: a resumed pass arms from the prior pass's ledgered
 * verdict, with no in-memory state).
 *
 * - No record at all → refuse. FAIL CLOSED: a head with no ledgered verdict is
 *   left unarmed, the same shape as "no verdict yet" (acceptance criterion 1 —
 *   a forged/live-only `remudero-review` success with no ledger backing must
 *   arm nothing).
 * - A record for a DIFFERENT sha → refuse. This is the sha binding that makes
 *   push-invalidates-review real at the decision layer, not only at display
 *   (acceptance criterion 4): a verdict ledgered before a subsequent push must
 *   never arm the new head.
 * - A record for THIS sha whose state isn't "success" → refuse (a genuine
 *   ledgered failure blocks exactly as before).
 * - A record for THIS sha that is "success" → arm — regardless of whatever the
 *   live status channel currently says, including a stubbed-unavailable read
 *   (acceptance criterion 2).
 */
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
  // The two checks above are W1-T230's and stay here: they decide WHICH verdict may be trusted
  // (one exists, and it is for THIS head). They say nothing about whether that verdict is good
  // enough to merge on — and this function used to answer that itself, with `state === "success"`
  // and nothing else. That was a SECOND, weaker copy of a policy `decideAutoMergeArm` already
  // owns: it refuses a CAPPED verdict (W1-T229), carves out plan-only PRs (W1-T205), and honours
  // a ledgered operator override. A CAPPED verdict posts `success`, so the copy here armed
  // unproven work on every lane that routes through this function — sweep, dep-review, retro,
  // triage, plan, approve — while the other copy refused it. Two implementations of one rule is
  // a defect this repo has already paid for twice; delegating deletes the copy rather than
  // teaching it the same lesson again.
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

/**
 * Recover the most recent `automerge.capped_override_granted` ledger line for
 * `taskId`, "last one wins" — the SAME scanning idiom {@link
 * priorReviewVerdictFromLedger} and every other precedence helper in this
 * codebase already use. Written by `rmd review <pr>
 * --override-capped-by/--override-capped-reason` (run-task.ts); consulted by
 * the arming path ({@link decideAutoMergeArm}) before refusing a CAPPED
 * verdict.
 *
 * W1-T219 (recon R-14): HEAD-BOUND, mirroring {@link decideArmFromLedgerVerdict}'s
 * W1-T230 head-pinning above. `headSha` — the CURRENT verdict's head, supplied
 * by the caller — is now REQUIRED to match the granted line's own `head_sha`
 * exactly, or the line is skipped as if it were never there. Before this, the
 * override was scoped to `taskId` alone: on an append-only, unauthenticated
 * ledger, ANYTHING able to append one `automerge.capped_override_granted` line
 * armed auto-merge on a CAPPED verdict for every later head of that task —
 * including a push the operator granting the override never saw. A line
 * missing `head_sha` (a pre-W1-T219 grant) is likewise never matched: a
 * binding that cannot be verified is treated as absent, never as a pass.
 */
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

/**
 * W1-T1000002 — AN OPERATOR MERGE HOLD, THE SAME LEDGERED SHAPE {@link CappedOverride} ALREADY
 * IS, WITH THE SIGN FLIPPED. A `CappedOverride` is a human's permission to arm anyway; this is a
 * human's REFUSAL to let anything arm at all — "who" and "why" named the same way.
 *
 * DELIBERATELY NOT SHA-BOUND, unlike {@link CappedOverride}: `cappedOverrideFromLedger` expires
 * on a new head because a new diff deserves a fresh judgement, but a hold is a decision about the
 * PR (or the whole fleet) standing right now, not about any one diff — a routine `git push` must
 * never silently lift it, or an operator who believes work is frozen would have no way to know
 * otherwise. Cleared by nothing but an explicit `automerge.hold_released` row; never by time,
 * never by a new commit.
 */
export interface AutomergeHold {
  /** Who engaged the hold — never inferred, never anonymous, mirroring {@link CappedOverride.by}. */
  by: string;
  /** Why — mirroring {@link CappedOverride.reason}. */
  reason: string;
}

/**
 * Recover the current auto-merge hold for `prNumber`, "last one wins" — the SAME scanning idiom
 * {@link cappedOverrideFromLedger} and every other precedence helper in this codebase already
 * use, over the WHOLE ledger rather than a sha-bound window (see {@link AutomergeHold}'s own doc
 * for why). Written by an operator verb as `automerge.hold_engaged` / `automerge.hold_released`,
 * each carrying `by`/`reason` (a hold with either missing is refused at write time — the row
 * itself is the only notification anyone gets, so an anonymous or reasonless one is worse than
 * none).
 *
 * PR-SCOPED OR FLEET-SCOPED: a row carrying no `pr_number` is FLEET-WIDE and applies to every PR
 * this function is ever asked about; a row carrying one applies only to that PR. Both kinds are
 * folded into the SAME chronological scan — whichever kind (fleet or this-PR) was written most
 * recently decides this PR's current state, exactly like `cappedOverrideFromLedger`'s single
 * `found` accumulator, just widened to two applicability tests instead of one exact match.
 *
 * Consulted by sweep.ts's `alreadyDone` for `disposition: "mergeable"` (a held PR is refused,
 * never armed, and never counted as a dedup key so it re-derives whole once released — see that
 * call site's own doc) and by run-task.ts's `attemptArm`, the ONE completion both the ledger-
 * gated `armAutoMerge` and the ungated `armAutoMergeAtOpen` reach — closing the at-open race a
 * converging disarm alone cannot (see design (v) of W1-T1000002's task record).
 */
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

/**
 * The LOUD console annotation for a keyword-only verdict (W1-T185 — closes the
 * second W1-T128 gap) — printed once per review when {@link
 * ReviewVerdict.keywordOnly} is true and the verdict was NOT already capped
 * (a capped verdict's own annotation already says nothing was executed; this
 * would be redundant). Mirrors {@link floorDegradedAnnotation}.
 */
export function keywordOnlyAnnotation(): string {
  return (
    `KEYWORD-ONLY: no PR-head checkout was given, so no proof was executed for any ` +
    `criterion — this verdict rests entirely on keyword coverage (+ optional semantic ` +
    `downgrade), never on OBSERVED repo state.`
  );
}

/**
 * W1-T304: the stable, COUNTABLE key naming WHICH structural path forced a
 * `state: "failure"` verdict. Before this, `review.posted` carried `state:
 * "failure"` with `reasons: []` whenever the failing path was NOT an unmet
 * named criterion (`bodyContradictsDiff`'s changeset-contradiction path, the
 * measured PR #1193 case: every criterion substantiated, every proof
 * executed and passed, yet the review still failed) — the reason existed
 * only inside the posted commit-status description (a 140-char field that
 * truncates it), so `grep -a` over the ledger for that failure class returns
 * ZERO and the predicate can never be counted, audited, or tuned.
 *
 * Mirrors {@link failSummary}'s own precedence exactly (both read the SAME
 * structural facts off the SAME verdict) so the class named here always
 * matches the prose {@link failSummary} would have rendered for this verdict
 * — never a second, divergent notion of "why this failed":
 *   - `no_criteria`            — {@link ReviewVerdict.criteria} is empty.
 *   - `criteria_tampered`      — {@link ReviewVerdict.criteriaTampered}.
 *   - `changeset_contradiction`— {@link ReviewVerdict.changesetContradictions}
 *                                 non-empty (the bodyContradictsDiff path).
 *   - `instrument_entangled`   — {@link ReviewVerdict.instrumentEntangled}.
 *   - `holdout_unmet`          — every VISIBLE criterion passed, but a
 *                                 reviewer-only holdout criterion did not.
 *   - `test_theater`           — every criterion passed, but added tests
 *                                 assert nothing.
 *   - `unmet_criteria`         — at least one visible named criterion failed
 *                                 (the ordinary case; already fully named via
 *                                 the ledger's own `unmet_criteria`/`reasons`
 *                                 arrays — this class exists so THAT path is
 *                                 counted by the same key space as every
 *                                 other one, not because it was gapped).
 * Returns `undefined` on a passing verdict — there is no failure to class.
 */
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

/**
 * The `capped`/`keywordOnly`/`planOnly` facts the `review.posted` ledger line
 * records (W1-T185, criterion 5: "when materialization is impossible the verdict
 * is EXPLICITLY marked keyword-only, in both the posted status and the ledger —
 * silent keyword-only posting is unreachable"). Pure + exported so run-task.ts's
 * `log("review.posted", …)` call and a unit test both read the SAME fields
 * off the SAME verdict, rather than the ledger line risking a hand-copied
 * projection that could silently drift from what {@link cappedSummary}/
 * {@link planOnlySummary}/{@link passSummary} actually rendered on the posted
 * status.
 *
 * `plan_only` joined the line so the LEDGER carries every input
 * {@link decideAutoMergeArm} needs — `capped` alone cannot distinguish the
 * structural, permanently-capped plan-only shape (which ARMS, W1-T205) from a
 * proof-failure capped verdict (which does not, W1-T229). {@link
 * postedArmFactsFromLedger} is the reader; `sweep.ts`'s reconciliation is why it
 * has to be on the ledger at all — that path never holds the verdict object,
 * only what was written down about it.
 *
 * W1-T304: `failure_class`/`failure_reason` ride alongside on any `state:
 * "failure"` verdict — the SAME `reviewFailureClass` key plus the verdict's
 * own `summary` (the FULL rendered failure text {@link failSummary} produced,
 * not the 140-char-truncated string the commit status itself is capped to —
 * `reviewPostedDescription`'s only further edit is appending a capped/degraded
 * suffix, which is already separately ledgered via `capped`/`capped_reason`/
 * `degraded_reason`, so `summary` alone is the full reason for THIS field).
 * Absent on a passing verdict, exactly like `capped_reason` — this is
 * PURELY for counting/audit (retro.ts-style mining of `review.posted`); no
 * DECISION in this codebase reads it, so it needs no entry in
 * `DECISION_RELEVANT_LEDGER_STEPS` (that set is keyed by ledger STEP name —
 * `"review.posted"` is already unconditionally retained — not by field).
 *
 * W1-T305: `unexecutable_count`/`unexecutable_proofs`/`partially_executed` ride alongside,
 * UNCONDITIONALLY (0/[]/false on a healthy review, never absent) — the same "make the class
 * countable, never a claim nobody reads" doctrine as the rest of this line, applied to the gap
 * this task measured: 418 of 821 code-review heads executed ZERO proofs and posted `success`
 * anyway on the keyword floor, indistinguishable on the ledger from a review that certified
 * everything. See {@link ReviewVerdict.unexecutableCount}/`.unexecutableProofs`/
 * `.partiallyExecuted`'s own docs for exactly what each counts.
 */
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

/**
 * W1-T1016: the `reasons` array the `review.posted` ledger line carries — a per-VISIBLE-
 * unmet-criterion reason, plus `"test theater: added tests assert nothing"` when
 * {@link ReviewVerdict.testTheater} fires (the SAME rule run-task.ts's
 * `log("review.posted", …)` call used to compute inline), now pure + exported for the same
 * reason {@link reviewLedgerLegibilityFields} above is: a unit test reads the exact fields
 * the ledger line writes, never a hand-copied guess.
 *
 * THE ROUTING GAP THIS FUNCTION CLOSES: the changeset-contradiction path
 * (`bodyContradictsDiff`) fails the verdict WITHOUT unmet-ing any NAMED criterion — every
 * criterion can read `met: true`, the measured #1193 shape {@link reviewFailureClass}'s own
 * doc records — so the per-criterion rule above alone still returns `[]` for it.
 * `actionableGateFailuresFromReasons` (lib/sweep.ts) only ever qualifies a row at
 * `reasons.length === 1`, so an empty array here means this failure shape could never route
 * to the `blocked-fixable` disposition row that already exists for it (lib/sweep.ts's
 * `DISPOSITION_RULES`, third `blocked-fixable` row) — it fell to `blocked-ambiguous` and
 * reached a human instead, even though the single reason is already computed
 * (`verdict.summary`, ALSO ledgered as `failure_reason` by {@link reviewLedgerLegibilityFields}
 * above).
 *
 * The fallback below ONLY fires when nothing else already claimed the array
 * (`reasons.length === 0`) AND a changeset contradiction is present — deliberately narrower
 * than "any empty-reasons failure": a genuine multi-cause failure must stay unrouted, and this
 * never concatenates or flattens several contradictions into one entry (`verdict.summary` is
 * already the single, `failSummary`-rendered line for however many contradictions fired).
 */
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

/**
 * The arming-relevant facts of the review verdict posted for ONE EXACT head —
 * {@link decideAutoMergeArm}'s `verdict` argument, recovered from the ledger by
 * a caller that never held the verdict object itself (`lib/sweep.ts`'s
 * independent "checks green + review success ⇒ arm" reconciliation). Same "last
 * one wins" scan idiom as {@link lastPostedReviewStatusFromLedger} and
 * {@link cappedOverrideFromLedger}; HEAD-BOUND for the same W1-T219/W1-T230
 * reason — a verdict judged against an older push says nothing about the head
 * about to be armed.
 *
 * TWO DIFFERENT ABSENCES, TWO DIFFERENT ANSWERS — this is the whole safety
 * argument, and the two cases are NOT symmetric:
 *
 *   (a) NO RECOVERABLE VERDICT AT ALL — no matching line, or one whose `capped`
 *       is not a boolean. Returns `undefined`: "no evidence". The caller arms
 *       exactly as it did before this function existed. A rotated ledger, a PR
 *       reviewed on another machine, or a verdict this ledger simply never saw
 *       must never strand a PR whose `remudero-review` status GitHub reports as
 *       success — that would be a fleet-wide stall triggered by log rotation.
 *
 *   (b) A VERDICT IS RECOVERABLE BUT `plan_only` IS ABSENT (a line written by a
 *       binary older than the field). `planOnly` reads FALSE — so a `capped`
 *       verdict from that era REFUSES. It is tempting to call this "unknown, so
 *       arm", but that reopens the exact hole for every pre-existing capped
 *       line, and the two outcomes are not equally bad: an unattended merge of
 *       a diff with zero executed proof is irreversible, while the cost of
 *       refusing is that the PR sits open and unarmed until someone runs
 *       `rmd review <n>` (which re-posts the verdict WITH `plan_only`, after
 *       which the W1-T205 carve-out applies normally). This mirrors sweep.ts's
 *       own standing ruling on the conflict rung: "a wrong auto-resolution is
 *       worse than a strand".
 *
 * The transitional exposure of (b) is bounded and was MEASURED before shipping:
 * a plan PR is armed at open by its own emitter (`armAutoMerge` directly,
 * bypassing this gate entirely — see review.test.ts's W1-T229 criterion-2
 * structural fixture), so it only reaches this decision at all when that at-open
 * arm failed; at the time this landed, zero open PRs carried a legacy capped
 * line for their current head.
 */
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

/**
 * Build a failure summary that TEACHES: it NAMES the first unmet criterion (not
 * just a count — the W1-T2/PR #18 refusal said "1 criterion/criteria unmet" and
 * cost a human round-trip to work out WHICH). The first unmet claim is included in
 * full or truncated with an ellipsis, plus `(+N more)` when others are unmet, kept
 * within the status-description length limit. The full unmet list lives in the
 * ledger `review.posted` line and the PR review comment (run-task.ts).
 *
 * `criteriaTampered` (W1-T58, Standing rule 15) takes priority over the
 * `unmetClaims.length === 0` test-theater fallback below it — a diff can trip
 * the rule-15 guard alone, with every NAMED criterion still reading "met" and
 * `testTheater` false, so that fallback's assumption ("empty unmet ⇒ it must be
 * test theater") no longer holds unconditionally.
 *
 * `unmetClaims` is caller-filtered to VISIBLE criteria only (W1-T166): this
 * summary becomes the posted commit-status description AND the `review.posted`
 * ledger's failure text, both reachable by the very worker a holdout criterion
 * must stay hidden from (a worker has full `gh` access and can trivially read
 * either). `hiddenUnmetCount` — the count of unmet HOLDOUT criteria the caller
 * deliberately left out of `unmetClaims` — is surfaced as a bare count so a
 * "visible-pass, holdout-fail" verdict (criterion 2) still reads as an honest,
 * actionable FAIL rather than a misleading "test theater"/empty-unmet fallback,
 * without ever naming which holdout criterion or what its claim/proof said.
 *
 * `changesetContradictions` (W1-T274) takes priority right after
 * `criteriaTampered` — both are diff/report-derived structural facts, not
 * semantic reviewer opinion, so both preempt the ordinary unmet-criteria text.
 * The message NAMES which claim was contradicted and which actual changed
 * files refute it (acceptance: "the failure names the contradicted claim and
 * the files that refute it") — an unexplained red is the shape that gets
 * overridden, so a bare "changeset contradiction" with no specifics would
 * defeat the point.
 *
 * `instrumentEntanglement` (W1-T297, Standing rule 25) takes priority right
 * after `changesetContradictions` — the same reasoning: a structural,
 * diff-derived fact that preempts the ordinary unmet-criteria text. The
 * message NAMES the instrument paths found and the src paths beside them
 * (W1-T186 emitter discipline) AND STATES THE RESOLUTION — split the PR (land
 * the instrument change alone, then rebase) or revert the instrument hunk —
 * because a rule that only refuses re-teaches nothing and gets worked around.
 *
 * `unprovenancedDecisionsEntries` (W1-T352) takes priority right after
 * `instrumentEntanglement` — the same reasoning again: a structural,
 * diff-derived fact over the DECISIONS.md entries this PR itself adds. The
 * message NAMES the unmarked entry's own header and STATES the two accepted
 * genres (the machine stamp, an operator-attribution line) so the fix is a
 * one-line addition, not a guessing game.
 */
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
    // ⚠ THIS STRING IS CAPPED AT 140 CHARS BY THE COMMIT-STATUS API (`description.slice(0, 140)`,
    // `postCommitStatus` below), and the message it replaces was 145. That is the whole reason the
    // refusal "named no remedy": the remedy was never absent from the source, it was SLICED OFF —
    // GitHub rendered `… Standing rule 15 (a worker may n`, cut mid-word. Appending a remedy to the
    // old text would therefore have been invisible, which is the same defect stated twice.
    //
    // So this branch says the ONE thing that fits and is actionable — the PR SHAPE to change — and
    // the full two-part remedy rides `checkSatisfiedByGuard`'s advisory `reason`, which has no cap
    // and whose own doc already commits to reaching the operator verbatim. MEASURED: this renders
    // at 133 characters, so it arrives whole. It keeps the rule's CANONICAL name — five suites
    // pin `Standing rule 15`, and shortening it to `rule 15` broke all five.
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

/**
 * Render the prompt for a FRESH-context REVIEW worker (acceptance #1/#3). The
 * worker is read-only + gh: it reads the PR diff, the task's acceptance criteria,
 * and the implement REPORT, and verdicts each criterion against its proof. It
 * does NOT post the `remudero-review` commit status itself — the deny-floor
 * (W1-T203) refuses any `gh api -X POST .../statuses/...` call from a worker,
 * so the reviewer only emits `REVIEW_VERDICT` lines and the ORCHESTRATOR posts
 * the authoritative status after folding them in (see reviewerVerdictContract,
 * parseReviewerVerdicts). It is told NEVER to edit code — and the runner spawns
 * it with a read-only settings profile, so this is belt-and-braces.
 *
 * The reviewer verifies against REPO STATE, not diff+report alone: when a proof
 * names an EXECUTABLE check (a test to run, a grep/command over the source), the
 * reviewer receives an already-materialized disposable PR-head checkout and RUNS
 * that check, verdicting on the OBSERVED result — the report's word that a test
 * passes or a grep matches is not proof it does. Running tests/greps against the
 * checked-out head is read-only in spirit:
 * it never edits the PR's code and never changes the head sha it judges.
 */
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

/**
 * Machine-readable verdict contract appended to the fresh reviewer's prompt so
 * its per-criterion judgment can be folded into the deterministic verdict as a
 * SEMANTIC downgrade (never an upgrade — {@link judgeReview}). The reviewer emits
 * one `REVIEW_VERDICT <n>: PASS|FAIL` line per criterion. This is advisory: the
 * mechanical floor is the binding gate (Standing rules 2/4/12), so a reviewer
 * that emits nothing parseable simply leaves the floor untouched — never a stall,
 * never a deadlock.
 */
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

/**
 * (W1-T2263) Widened off the original bare `REVIEW_VERDICT\s+(\d+)\s*:\s*(PASS|FAIL)\b` — adds
 * a trailing capture group for whatever the reviewer wrote after the token, SAME LINE ONLY
 * (the character class excludes `\r`/`\n`, so a clause can never span lines by construction).
 * {@link parseReviewerVerdicts} still reads only groups 1/2 from this, so its own return value
 * is byte-identical to before the widening; {@link parseReviewerVerdictClauses} is the new
 * reader of group 3. One regex, two readers, so they can never disagree about which line matched.
 */
const REVIEW_VERDICT_LINE_RE = /REVIEW_VERDICT\s+(\d+)\s*:\s*(PASS|FAIL)\b([^\r\n]*)/gi;

/**
 * Parse the reviewer's `REVIEW_VERDICT <n>: PASS|FAIL` lines into a semantic
 * array index-aligned to the criteria (length `count`). `FAIL` ⇒ `false` (forces
 * that criterion to fail); `PASS`/absent ⇒ `undefined` (defer to the mechanical
 * floor). Advisory + downgrade-only, so an unparseable reviewer output yields an
 * all-`undefined` array — the floor stands alone, fail-closed. Case-insensitive;
 * tolerant of surrounding prose.
 */
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

/** Pull the bounded clause off a FAIL line's own trailing text (everything after the
 *  `PASS|FAIL` token, already confined to one line by {@link REVIEW_VERDICT_LINE_RE}'s
 *  character class). {@link reviewerVerdictContract}'s own example shows a parenthetical
 *  after the token (`FAIL   (proof missing, unpasted, or non-responsive)`), so a leading
 *  `(...)` is unwrapped when present; freeform trailing prose (no parens) is accepted as-is.
 *  Returns `undefined` for empty/whitespace-only trailing text — a plain `FAIL` with nothing
 *  after it. */
function extractBoundedClause(trailing: string): string | undefined {
  const s = trailing.trim();
  if (!s) return undefined;
  const paren = s.match(/^\(([^)]*)\)/);
  const inner = (paren ? paren[1] : s).trim();
  if (!inner) return undefined;
  return inner.length > REVIEWER_CLAUSE_MAX_CHARS ? `${inner.slice(0, REVIEWER_CLAUSE_MAX_CHARS).trimEnd()}…` : inner;
}

/**
 * (W1-T2263) Companion to {@link parseReviewerVerdicts}, reading the SAME transcript and the
 * SAME widened regex for the bounded clause a FAIL line may carry naming what would answer the
 * claim — no second question, no second spawn (the transcript is already in hand wherever
 * `parseReviewerVerdicts` is called). Index-aligned to `count`, exactly like
 * `parseReviewerVerdicts`'s own return. `undefined` at an index when that criterion's line was
 * PASS, absent, or a FAIL with no trailing clause — a PASS line is never annotated (Q3: the
 * reviewer keeps no new channel besides the bounded FAIL clause). `parseReviewerVerdicts`'s own
 * return value is unaffected by anything this function does — they are two independent readers
 * of one regex pass, so a caller that only wants today's booleans keeps getting exactly that.
 */
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

/**
 * Parse an `Acceptance:` block out of a PR body, for manual plan/doc PRs that
 * carry no task id. The block is a header line — `Acceptance:` (optionally as
 * markdown `**Acceptance:**` or `## Acceptance`) — followed by bullet lines. Two
 * bullet shapes are recognized, both index-aligned one-per-criterion:
 *
 *   1. Single-line: `- <claim> | <proof>` (see {@link acceptanceSeparator} for which `|`
 *      separates claim from proof; no `|` keeps the whole line as the claim with an empty
 *      proof).
 *   2. Multi-line (the house format actually emitted by plan/doc PRs, #277/#280):
 *      `- claim: "<claim>"` followed by an INDENTED, non-bullet `proof: "<proof>"`
 *      continuation line, which attaches to that same criterion rather than ending
 *      the block — so a body with N such pairs yields N criteria, not just the first.
 *
 * Parsing stops at the first line, after the bullets begin, that is neither a new
 * bullet nor a recognized continuation of the current one — a blank line, a new
 * heading, a trailer, or a resumed prose paragraph.
 *
 * Returns `[]` when there is no block — and an empty criteria list FAILS CLOSED in
 * {@link judgeReview} (nothing to judge is never a pass). A manual PR that wants to
 * merge must therefore STATE what it is claiming and how it is proven; silence is
 * a failure, not a bypass.
 */
/** The Acceptance HEADER line: `Acceptance:`, `**Acceptance:**`, `## Acceptance`, `Acceptance
 *  criteria:`. Extracted as a shared constant so {@link parseAcceptanceBlock} and
 *  {@link acceptanceBlockDiagnostics} can never disagree about where a block begins — a
 *  diagnostic that recognised a different header than the parser would report on a block the
 *  parser never read. Semantics are byte-for-byte what the parser used inline before. */
const ACCEPTANCE_HEADER_RE = /^\s*#{0,6}\s*\**\s*acceptance(\s+criteria)?\b\s*\**\s*:?\s*\**\s*$/i;

/** A criterion BULLET. Shared with {@link acceptanceBlockDiagnostics} for the same reason as
 *  {@link ACCEPTANCE_HEADER_RE}. Unchanged from the parser's previous inline literal. */
const ACCEPTANCE_BULLET_RE = /^\s*(?:[-*]|\d+[.)])\s+(.*\S)\s*$/;

/**
 * Where a single-line bullet's claim ends and its proof begins — index plus separator width, or
 * null when the bullet carries no `|` at all.
 *
 * THE SEPARATOR IS THE ONE THAT YIELDS AN EXECUTABLE PROOF. Splitting at the FIRST bare `|` (what
 * this did before) truncated any claim carrying a pipe of its own — a `|| true` the claim quotes,
 * a BRE alternation, a markdown table fragment — and handed the remainder to the proof, where
 * `parseWhitelistedProof` refused it as prose. The criterion then fell SILENTLY to the keyword
 * floor: no dialect error, no empty proof, `acceptanceAuthorTimeCheck` still `ok`, and nothing
 * anywhere said the proof had stopped executing. `plan/tasks.d/W1-T2781-*.yaml` carries exactly
 * such a claim today, so this was live in the plan, not hypothetical.
 *
 * WHY NOT SIMPLY THE LAST ` | `. That repairs a pipe in the CLAIM and breaks a pipe in the PROOF —
 * `grep:` hands its pattern to execFile as one argv element, so a pattern may hold a ` | ` of its
 * own, and the last one then lands INSIDE the proof. Both readings are guesses about which pipe an
 * author meant; the dialect prefix is the one piece of evidence that is not a guess. So: the
 * historical first-bare-`|` split is tried FIRST and kept whenever it already produces a dialect
 * proof (every body that parses today does, which is what keeps this byte-for-byte compatible),
 * then each ` | ` right-to-left, and only if NO split yields an executable proof does it fall back
 * to the last ` | ` (else the first bare `|`) — the same degraded, keyword-floor reading as before.
 */
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
  /** Index-aligned with `criteria`: for a `claim:`-labelled bullet that was NONETHELESS split at a
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
      // The bullet above was a `claim:` label carrying a separator of its own, and THIS line is
      // the proof — so that split was a false positive. Restore the claim as written and take the
      // proof from here. Consumed ONCE (the entry is cleared): a SECOND `proof:` line under the
      // same bullet is still unrecognized and still ends the block, exactly as before.
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

/**
 * Compare what an author WROTE in an Acceptance block against what {@link parseAcceptanceBlock}
 * actually resolves, and report the difference.
 *
 * WHY THIS EXISTS, measured. `parseAcceptanceBlock` treats any indented line that is not `proof:`
 * as the END of the block. So a claim WRAPPED onto a second line — the most natural thing an author
 * does to a long claim — silently truncates: a body with three criteria parses to ONE, with an
 * EMPTY proof, and the review then judges a PR against a criterion the author never meant to stand
 * alone. Reproduced at this sha: written 3, parsed 1, emptyProofs 1, against a no-wrap control of
 * written 3, parsed 3, emptyProofs 0.
 *
 * That is the same overloaded-zero shape as the `grep:` traps this repo has already paid for twice
 * (a pattern wrapping across a YAML line matches nothing; a case-mismatched pattern returns nothing).
 * All three are LINE-ORIENTED PARSERS MEETING WRAPPED TEXT, and all three fail by returning FEWER
 * things rather than raising.
 *
 * DELIBERATELY DOES NOT CHANGE `parseAcceptanceBlock`. Making the parser reject would fail bodies
 * that merge today — including any whose trailing prose happens to sit under the block — so the
 * parser keeps its permissive contract and this reports the discrepancy instead. The check belongs
 * where a body is AUTHORED, not where it is judged.
 *
 * `bulletsWritten` counts with the parser's OWN {@link ACCEPTANCE_BULLET_RE}, and scanning stops at
 * the first line that is neither a bullet nor an indented continuation nor a tolerated leading
 * blank — so a `## Validation` section after the block is not miscounted as more criteria.
 */
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

/**
 * W1-T2624: THE SINGLE ANSWER to "which id does this body name" — anchored, LAST-WINS. Last-wins
 * is not a new decision here: it is W1-T70's ratified reading of the worker prompt's own contract
 * ("Include this exact trailer as the LAST line of the PR body"), and it is what `ensureTaskTrailer`
 * (run-task.ts) — which appends its stamp at the END of the body, unconditionally — produces by
 * construction. Before this change, `acceptanceAuthorTimeCheck` and `resolvePlanCriteriaAtHead`
 * below each ran their OWN anchored-but-first-wins `.exec()`, disagreeing with run-task.ts's
 * `reviewTaskIdFromBody` (last-wins) on any body carrying two anchored trailers — this function
 * replaces all three call sites so there is exactly one implementation of the tie-break.
 *
 * review.ts is the leaf; run-task.ts already imports FROM it (never the reverse), so this lives
 * here and `reviewTaskIdFromBody` becomes a thin re-export over it rather than a second,
 * independently-drifting regex.
 */
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

/**
 * THE AUTHOR-TIME ENTRY POINT (design item ii, W1-T952) onto {@link acceptanceBlockDiagnostics} —
 * the same diagnostic `rmd check-acceptance` already prints, callable BEFORE a PR pays for a CI
 * cycle + review's generic "no acceptance criteria to judge (fail closed)" to discover the same
 * thing. See `PR_AUTHORING_PATHS` below for WHICH of this repo's PR-authoring paths this can
 * actually run on before the PR is judged — design item (i)'s recorded coverage statement.
 *
 * TWO CALL SHAPES, matching the two ways `reviewCommand` (src/run-task.ts) itself resolves
 * criteria (never changed here — design item vi):
 *
 *   1. `opts.expectedTaskId` GIVEN — the caller already knows which task this PR is for (e.g.
 *      `dispatchAlertFixRun`, which mints a synthetic id that never resolves in `plan/tasks.yaml`,
 *      so the body is the ONLY thing review can ever judge from). The `Remudero-Task:` trailer is
 *      checked FIRST and independently of the body's own Acceptance block: a PR whose body has a
 *      healthy Acceptance block but the WRONG (or no) trailer for `expectedTaskId` is still a
 *      defect — `findMergedByTrailer` credits merge-done off that trailer, so a silent mismatch
 *      is a different failure (permanent non-credit) from a review-time refusal, and is named
 *      as its own category (`no-trailer`) rather than folded into the body checks below.
 *   2. `opts.expectedTaskId` OMITTED — the general case (`rmd check-acceptance`'s own population,
 *      and any trailer-bearing body whose plan lookup this function cannot see): ANY resolvable
 *      `Remudero-Task:` trailer is accepted at face value (plan-side resolution is out of scope
 *      here — design item vi, and re-deriving `loadPlan`'s own lookup would duplicate
 *      `reviewCommand`'s logic rather than read it), else the body's own Acceptance block must be
 *      judgeable (the #277/#280 "manual plan/doc PR, no task id" shape `parseAcceptanceBlock`'s
 *      own doc names is legitimate and must not be flagged).
 *
 * Priority when more than one defect is present, in the SAME order rationale (1) states them:
 * no-header, no-trailer, unparseable, empty-proofs.
 */
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

  // W1-T2297 — THE EXEMPTION MUST BE TRUE, NOT MERELY CLAIMED. This arm's whole warrant is that
  // criteria come from the plan record instead of the body, so the body's own block need not be
  // judgeable. That warrant fails when the trailer names nothing the plan declares: the reviewer
  // then falls back to the body, and a body this gate never looked at ships with whatever its block
  // actually parses to.
  //
  // MEASURED on #2908: `Remudero-Task: RETRO-1787714349337` resolves to ZERO ids across
  // `plan/tasks.yaml` and every `plan/tasks.d/` shard (control: `W1-T2244` resolves), the gate
  // returned ok with "criteria resolve from plan/tasks.yaml", and the body's block gave
  // `bullets written: 5, criteria parsed: 1` — four criteria the reviewer could not see.
  //
  // `trailerResolves` OMITTED is today's behaviour byte for byte: a caller with no way to consult
  // the plan trusts the trailer exactly as it always has, and only a caller that CAN resolve gets
  // the stricter reading. Falling through re-uses the diagnostics arms below verbatim rather than
  // adding a second spelling of "this block is unreadable" — two spellings of one fact drift.
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

  // W1-T2544 — REPORTED, NEVER REFUSED. Both signals below are real and both are ADVISORY, because
  // this gate is pure (no filesystem) and `acceptance-author-gate` is a REQUIRED check: a false
  // refusal blocks a correct PR.
  //
  // WHY THE WRAP CANNOT BE REFUSED, THOUGH IT IS USUALLY WRONG. `execWhitelistedProof` greps with
  // no `-F`, so a delimiter is a character that must appear in the file — and MEASURED on two
  // retro cycles six hours apart (#3356 in double quotes, #3413 in backticks) every wrapped
  // pattern read 0. But a wholly-wrapped pattern CAN be correct: MASTER-PLAN.md is full of Markdown
  // code spans, and a JSON file genuinely contains `"key"`. Only reading the target file separates
  // the two, which this function cannot do. W1-T1060/#3191 settled the same boundary from the other
  // side — this gate judges SHAPE, and dialect is a REVIEW verdict, not a gate defect.
  //
  // SO THE VALUE IS THE EARLY WARNING, NOT A BLOCK: the author (or the fix rung) sees the ceiling
  // while the sha is still live, instead of after a verdict that can never be re-judged on it.
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
//
// THE DEFECT. run-task.ts's `resolvePlanCriteriaForReview` (`reviewCommand`'s only call site)
// resolves a trailered PR's criteria via `loadPlan(planPath)` — a read of the CONTAINER's
// checked-out working tree, i.e. whatever sha the daemon last booted onto. The daemon restarts
// on freshness continuously (W1-T126, not re-filed here), so a `plan/tasks.d/` shard that merges
// between two boots is invisible to that read even though it is reachable from the very PR head
// this reviewer is about to judge — `acceptanceAuthorTimeCheck`'s sibling in run-task.ts then
// posts "no acceptance criteria to judge (fail closed)" on evidence that was never absent, only
// unread (measured on #3168; see plan/tasks.d/W1-T2432-*.yaml rationale (1)-(2)).

/** A DIVERGENCE between the trailer this body carries and the plan {@link loadPlanAtRef} could
 *  load AT THE PR's HEAD — the head-resolved sibling of run-task.ts's own (unexported)
 *  `ResolverDivergence`. Set ONLY when `loadPlanAtRef` itself throws (a duplicate id, an
 *  unreadable git object at `headSha`) — never merely because `taskId` is absent from a plan
 *  that loaded fine, the same distinction `resolvePlanCriteriaForReview` draws. */
/**
 * W1-T2511: WHICH cause made a head sha unreadable, decided by one probe rather than inferred from
 * git's message — which cannot tell them apart.
 *
 * `git show <sha>:<path>` emits the same "path '…' exists on disk, but not in '<sha>'" for an
 * object that was never fetched and for a commit that is present but genuinely lacks the path.
 * MEASURED, file present on disk in both cases, one of them using a real sha in a repo that had
 * never heard of it — byte-identical output. So the distinction has to be asked for separately.
 *
 * `git cat-file -e <sha>^{commit}` asks exactly that and nothing else: it exits 0 when the commit
 * object is present locally and non-zero when it is not. A probe that itself cannot run yields
 * `"undetermined"` — never a guess, because a wrong cause here sends the next reader at the wrong
 * defect entirely.
 */
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
    // DISTINGUISH THE PROBE FAILING FROM THE PROBE ANSWERING "no". `cat-file -e` exits non-zero to
    // MEAN "absent", which is an answer; anything that prevents it running at all (no git, an
    // unreadable repoRoot, an injected runner that throws for its own reasons) is not. The
    // discriminator is whether the error carries a numeric exit status, which a real non-zero exit
    // does and a spawn failure does not.
    const status = (e as { status?: unknown } | null)?.status;
    return typeof status === "number" ? "absent-object" : "undetermined";
  }
}

export interface PlanCriteriaAtHeadDivergence {
  taskId: string;
  reason: string;
  /** W1-T2511: WHICH cause produced `reason`, because git's own message cannot say. `git show
   *  <sha>:<path>` emits a BYTE-IDENTICAL "path '…' exists on disk, but not in '<sha>'" whether
   *  the object is absent from local storage or present with that path genuinely missing from its
   *  tree — MEASURED on both, in a throwaway repo, using a real sha the repo had never seen.
   *  `absent-object` means the sha was never fetched here (the W1-T2511 ordering defect, and the
   *  case that resolves itself once the hoisted fetch runs); `readable-object` means the commit is
   *  present and the plan file really is not in it, which is a different problem entirely.
   *  `undetermined` when the probe itself could not run — never guessed. */
  cause?: "absent-object" | "readable-object" | "undetermined";
}

/** {@link resolvePlanCriteriaAtHead}'s result — same shape as run-task.ts's
 *  `resolvePlanCriteriaForReview` for FOUR of its five declared fields
 *  (criteria/source/taskDeclaredFiles/divergence), so swapping one call for the other at a future
 *  call site is a like-for-like replacement for those four, not a rewrite. The fifth,
 *  `openTaskIds`, is NOT produced here — W1-T2623 proves-and-locks that omission as behaviorally
 *  identical to the replaced resolver's own projection-less (empty-set) value at its one consumer,
 *  rather than restoring it (see resolvePlanCriteriaForReview's own comment on why: a real value
 *  would need a second, independent GitHub read this reviewer does not otherwise need). See
 *  test/resolver-swap-field-parity.test.ts for the mechanical guard over ALL five fields, never
 *  just these four. */
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

/**
 * THE FIX (W1-T2432, remedy (a) of the two the filing priced). Resolve a trailered PR body's
 * judging criteria from the plan AS IT STANDS AT THE PR's OWN HEAD SHA — `git show
 * <headSha>:<planRelPath>` plus a `git ls-tree` of the sibling `tasks.d/` at that same sha, via
 * {@link loadPlanAtRef} (W1-T2220's already-shipped remedy (c), reused rather than re-invented:
 * the filing's rationale (3) names exactly this as the reason remedy (a) is priced as "may be
 * free") — rather than the container's checked-out working tree. THIS MAY BE FREE per that
 * rationale: the caller already holds `headSha` off the PR view it just fetched, and `runGit`
 * shells out to the LOCAL git objects a real checkout/clone already has, so resolving here costs
 * no second network fetch (claim 6).
 *
 * NAMED COST, UNCHANGED FROM `loadPlanAtRef`'s OWN: this reads the sha's COMMITTED objects, so a
 * shard merging into `plan/tasks.d/` after `headSha` (i.e. after the PR's own base parent) is
 * still invisible here — a strictly smaller window than today's boot-to-boot one, never zero
 * (rationale (3)). That residual window is NOT this task's concern.
 *
 * The `Remudero-Task:` trailer is extracted HERE via {@link extractTaskTrailerId} — the SAME
 * anchored, last-wins extractor {@link acceptanceAuthorTimeCheck} above uses and run-task.ts's
 * `reviewTaskIdFromBody` re-exports (W1-T2624 corrected this comment: it used to claim this read
 * the trailer via the same ANCHOR as `reviewTaskIdFromBody` while actually taking the FIRST match
 * against that function's LAST — same anchor, opposite tie-break, two spellings of "find the
 * trailer" rather than the one this sentence claimed. It is now genuinely one spelling, not two.)
 *
 * NEVER WIRED HERE, on purpose. Standing rule — one concern per PR — and this task's own file
 * list (`src/lib/review.ts` + its unit test) deliberately excludes `src/run-task.ts`: swapping
 * `reviewCommand`'s call from `resolvePlanCriteriaForReview` to this function, so a live review
 * actually benefits, is a follow-up plumbing change over a contract this function proves
 * standalone first.
 *
 * SYNCHRONOUS BY CONSTRUCTION (claim 6): no `Promise`, no timer, no retry loop between resolving
 * criteria and handing them to {@link judgeReview} — a caller can do both in the same tick. Each
 * blob {@link loadPlanAtRef} needs is read exactly once (one `git show` for the monolith, one
 * `git ls-tree` for the shard directory, and ONE `git cat-file --batch` for every shard in it —
 * never one spawn per shard), never re-fetched.
 */
/**
 * W1-T2623: the OBJECT IDENTITY of the plan bytes THIS resolve actually read — restoring, on the
 * at-head path, the read-identity assertion {@link "./task-linter.js".formatReadIdentity} already
 * prints for the working-tree path (run-task.ts's `resolvePlanCriteriaForReview`, and lint-plan
 * alongside it). Without this, the operator-visible `criteria from …` line named a task id and a
 * count but never WHICH plan bytes were actually gated — a `source` string that looked like a
 * read-identity assertion but was not one.
 *
 * At a fixed sha the plan is a content-addressed git object, so identity is the git OID rather
 * than a hash of a working-tree file: `git rev-parse <sha>:<path>` answers it in one LOCAL call,
 * on objects the caller's own hoisted fetch (W1-T2511) already arranged to be present — the same
 * cheapest-sound-form this task's own design note names. The shard set `loadPlanAtRef` also
 * consults is named too, as ONE tree oid (`git rev-parse <sha>:<tasks.d dir>`) rather than one
 * blob oid per shard — a tree oid already hashes every shard's name AND content in a single call,
 * cheaper than enumerating shards and exactly as sensitive to a shard changing.
 *
 * NEVER THROWS: an unreadable object here should not happen — {@link loadPlanAtRef} above already
 * read these same bytes successfully — but a probe failure degrades to `undefined` rather than
 * losing the whole `source` line over a legibility extra; the caller falls back to the
 * task-id/count form. No `tasks.d/` at this ref (the pre-sharding case `loadPlanAtRef` itself
 * tolerates) degrades the same way: the shard segment is simply omitted, never fabricated.
 */
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
    // A duplicate id or an unreadable git object at headSha — named, never swallowed into a
    // silent empty plan (mirrors resolvePlanCriteriaForReview's own divergence shape).
    //
    // W1-T2511: and the reason ALONE cannot say which it was, because git will not. One extra
    // `cat-file -e` separates the two causes that matter, so whoever reads the next divergence is
    // not left re-running probes to find out whether the sha was simply never fetched.
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

/**
 * EVERY PATH BY WHICH A PR BODY IS AUTHORED IN THIS REPO, read from source (design item i,
 * W1-T952), with coverage stated for each rather than assumed. `reachable: false` rows are the
 * load-bearing ones: an in-repo check cannot reach a PR opened by a human over REST, `gh pr
 * create` directly, or an MCP client, because none of those execute repo code — no future change
 * closes that gap without a SERVER-SIDE check (out of scope here, design item vi's boundary
 * extended: this task adds a pre-open-adjacent refusal, not a new gate).
 *
 * `reachable: true, wiredByThisChange: false` rows are DELIBERATE, not an oversight: `openPlanPr`
 * and the retro sync PR are already judgeable/repaired by construction (see their own reasons),
 * and `runTask`'s implement-dispatch path (the vast majority of task PRs, including the one that
 * filed this very task) resolves criteria from `plan/tasks.yaml` via the `Remudero-Task:` trailer
 * `ensureTaskTrailer` already stamps unconditionally — so a defective body is USUALLY harmless
 * there (the plan is authoritative), and wiring a second check into that large, already
 * heavily-depended-on function for a residual case is left as a follow-up rather than widening
 * this one-concern diff (Standing rule — one concern per PR).
 */
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
/**
 * Layer 2 of the three-tier gate stack: a set of deterministic JUDGMENT items the
 * reviewer runs over a PR's (diff, report). It ADVISES — the GitHub-enforced gate
 * (layer 1) decides (Standing rule 3B) — so each item is a PURE predicate whose
 * falsifier is a unit fixture, never an LLM call. The four items are, verbatim
 * from §5 layer 2:
 *   1. ONE CONCERN per PR
 *   2. ALL CALLERS AUDITED (partial-fix drift — a change that fixes one call site
 *      and orphans the rest)
 *   3. TEST THEATER (assertions that assert nothing)
 *   4. REFACTOR-PHASE HONESTY (a "refactor" that changes behavior)
 * plus a fifth item, DOCS AWARENESS (§12A — the anti-rot mechanism, W1-T30): a
 * diff changing user-visible behavior (CLI surface, config, gate, verdicts) must
 * update `docs/` OR state why not in the REPORT — this is the Tier-B half of
 * "docs are not evidence unless CI proves they match the code"; Tier A (generated
 * docs, byte-equality in CI) is a separate, later mechanism (W1-T47/T48).
 * plus a sixth item, TROUBLESHOOTING COVERAGE (§12A Tier B, W1-T50): a diff that
 * ADDS a new `operator_impact: true` entry to `learnings/failures.yaml` must also
 * touch `docs/troubleshooting.md` with that entry's id, OR state why not in the
 * REPORT — the same awareness-layer pattern as DOCS AWARENESS, narrowed to the
 * failures corpus so an operator-impacting incident always gets a symptom/cause/
 * fix write-up, not just an internal learning.
 * plus the GUARD: no worker-authored `satisfied_by` (a diff that ADDS a
 * `satisfied_by` line to plan/tasks.yaml FAILS unless the PR is plan-only AND
 * human-authored — `satisfied_by` is Architect-only; a worker adding it to its own
 * blocking criterion is editing the criteria to match the diff, Standing rule 15).
 *
 * These are COARSE, diff-scoped heuristics by design: they advise, they do not
 * decide, and they never edit. Each is independently exported so its fixture can
 * falsify it in isolation.
 */

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
  /**
   * The PR is NOT a dispatched worker run editing its own task — the exemption half
   * of {@link checkSatisfiedByGuard}.
   *
   * DERIVED FROM THE HEAD REF, never asserted: `runReview` sets it from `headRefName`
   * via {@link "../run-task.js".isDispatchedRunBranch} — a dispatched run always pushes
   * to `run-<taskId>-<epochMs>`, and no hand-opened branch takes that shape. That is the
   * only authorship signal the review path actually holds, so it is the only one claimed.
   *
   * ABSENT ⇒ FALSE, never "unknown-so-allow". The one call site that cannot supply a head
   * ref is `runFixRung`'s, which is BY CONSTRUCTION a dispatched run amending its own run
   * branch — the exact case the exemption must not cover — so failing closed there is both
   * safe and correct rather than merely conservative.
   *
   * Until W1-T385 NOTHING IN THE TREE SET THIS FIELD. It was permanently `undefined`, so
   * the exemption could never fire and the advisory reported a worker-authored edit on
   * hand-opened plan-only PRs — the opposite of the truth, on the one rule where a false
   * authorship claim is most misleading.
   */
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
      // W1-T389: a DELETED file's `+++` line is `+++ /dev/null`, and letting it overwrite
      // `file` tagged every removed line `/dev/null` — which `changedFiles` then filtered
      // out, so a pure deletion contributed NOTHING to the reviewer's changed-file list.
      // The `diff --git a/<path> b/<path>` header one branch above already set the real
      // path, so KEEP IT rather than clobbering it with the sentinel. Fixed here, in the
      // walker, rather than at each consumer: there are four, and patching them one at a
      // time is how the next one inherits the bug.
      //
      // The `---` direction needs no equivalent: an ADDED file's `--- /dev/null` is skipped
      // by the branch below rather than assigned, so additions were never affected. That is
      // asserted rather than assumed — see test/review-deletion-blind.test.ts.
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

/**
 * (W1-T456, DEFECT A) Repo-relative paths a plan-shard ADDS to its own `files:` scope, read
 * straight off the ADDED lines of THIS diff — never off a resolved task id.
 *
 * WHY THE DIFF, NOT A RESOLVED TASK. A plan-FILING PR deliberately carries no
 * `Remudero-Task:` trailer (#1527's correctness rule — crediting a filing PR would mark
 * the task it just filed DONE before it is ever built), so `judgeReview` has no task id to
 * look `files:` up against for exactly the PRs this function exists to help. The shard the
 * PR is filing is sitting right there in the diff it is being reviewed against, complete
 * with its own declared `files:` — reading it from the ADDED lines needs no plan load, no
 * task id, and cannot be spoofed by a DELETED line (a shard being narrowed, not widened).
 *
 * Deliberately narrow: only a bare, single-line `files: [...]` (the house convention, see
 * {@link SHARD_FILES_LINE_RE}'s doc) inside an added/modified `plan/tasks.d/*.yaml` or
 * `plan/tasks.yaml` hunk counts. A block-style list or a shard this diff does not touch
 * contributes nothing — under-matching here only means a real forward reference falls back
 * to `executed_fail` (today's byte-identical behavior, never a new false pass); it can never
 * manufacture a forward-reference exemption for a path no shard in this diff actually named.
 */
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

/**
 * The concern a changed file belongs to, keyed by its source STEM: `src/lib/foo.ts`
 * and its co-located `test/foo.test.ts` are the SAME concern (`foo`). Non-source
 * files (docs, plan, config) carry no concern and return null.
 */
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

/**
 * ONE CONCERN: a PR should cluster around a single source module. Two or more
 * distinct product/test STEMS is the partial-fix-drift smell of a multi-concern PR.
 *
 * W1-T2823 — THE COMPANION DISCOUNT, READ FROM THE SHARED TABLE. {@link concernStem} keys a
 * concern to a BASENAME, and its collapse rule is written for a `src/lib/foo.ts` +
 * `test/foo.test.ts` pairing. This repo does not name suites that way: a falsifier is named after
 * the CLAIM it proves, so a PR's own suite contributed a second stem and the arm fired on 36 of
 * the 43 judged commits in an 80-commit sample of origin/main (83.7%). An advisory the fix rung
 * CONSUMES that is wrong five times in six is worse than no input, because the ~15% where the arm
 * is RIGHT cannot be told apart from the rest.
 *
 * The discount is {@link COMPANION_PATH_CLASSES} — the table W1-T2547 extracted so "BOTH
 * task-linter.ts and review.ts can read it", named in its own header for THIS consumer — and not
 * a fourth basename heuristic private to the rubric, which would relocate the drift rather than
 * remove it (W1-T457: give the consumer the rule the other gate already has).
 *
 * TWO PASSES, mirroring {@link "./task-linter.js".subsystemsOf} rather than re-deriving it:
 * companions are collected SEPARATELY and folded in only if nothing else survives, so a test-only
 * diff still scores its stems instead of collapsing to zero concerns and passing vacuously.
 *
 * LOOSE, NOT TIGHT, AND MEASURED BOTH WAYS BEFORE CHOOSING. The alternative was W1-T2525's
 * `ownFalsifierSlug` narrowing — discount only the suite whose stem equals the task's own shard
 * slug. Over the same 43 commits: 36 today, 19 under this rule, 33 under the slug narrowing. They
 * differ on 6 commits and the slug narrowing is wrong on every one, because a shard slug is
 * derived from the task TITLE and truncated while a falsifier is named after the CLAIM, so it
 * flags the PR's own suite. It would also need the `Remudero-Task:` trailer, a dependency this arm
 * does not have.
 */
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

/**
 * REFACTOR-PHASE HONESTY: if the change is LABELLED a refactor (the report says so)
 * it must not change behavior. A pure refactor MOVES behavior-bearing lines verbatim
 * — every ADDED behavior line also appears (trimmed) among the REMOVED ones. A behavior
 * line that is added with no matching removal is net-new logic: dishonest for a refactor.
 */
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

/**
 * Modules that constitute "user-visible behavior" in the §12A sense — CLI
 * surface, config, gate, or verdicts. Diff-scoped path heuristic, same spirit
 * as {@link concernStem}: coarse, not a semantic understanding of the change.
 *
 * W1-T212 (recon R-15): a diff that edits WHAT a quality gate measures — a CI
 * workflow, a ratchet script, or a ratchet's recorded baseline/threshold — is
 * exactly as "user-visible" as editing the gate code itself: it can weaken the
 * measurement the gate is trusted to enforce, silently, with no reviewer
 * prompted to notice. Before this, `.github/workflows/`, `scripts/*-ratchet.mjs`,
 * every `scripts/*-baseline.json` floor, and `stryker.conf.json`'s mutation
 * scope were ALL outside this regex, so a PR lowering a coverage/mutation floor
 * or deleting a required check from `ci-gate.yml` cleared docs-awareness
 * silently (`no CLI/config/gate/verdict surface changed`).
 */
/**
 * The measurement-INSTRUMENT surface (W1-T297, Standing rule 25): paths a
 * diff can touch to change WHAT a CI gate measures, rather than what the gate
 * concludes about a change. ONE PATH SET, EXPORTED — {@link
 * USER_VISIBLE_SURFACE_RE}'s instrument arm (W1-T212's docs-awareness rung)
 * and {@link detectInstrumentEntanglement} (this task's BINDING isolation
 * gate) are both DERIVED FROM THIS constant so the two surfaces can never
 * drift apart into a second, hand-maintained copy. Membership: `.github/
 * workflows/` (CI measurement wiring), every `scripts/*-ratchet.mjs` (ratchet
 * gate scripts), `scripts/diff-coverage.mjs` (coverage's own text-awareness
 * carve-outs — the W1-T210 fixture this task's rationale names), every
 * `scripts/*-baseline.json` (recorded floors/caps),
 * `scripts/mutation-relevant-paths.json` (mutation-ratchet's diff-scoping
 * config), and `stryker.conf.json` (mutation scope/config). STAYS the SOLE
 * BLOCKING authority for {@link detectInstrumentEntanglement} — a wrong or
 * incomplete derivation must never itself refuse a PR.
 *
 * THIS LIST IS HAND-ENUMERATED, and a hand enumeration goes stale (W1-T402:
 * it shipped missing eleven gate-rule files' worth of coverage, found only by
 * a one-time hand re-check four days later). Rather than a comment ASKING a
 * human to re-verify membership — the carrier that failed here — {@link
 * INSTRUMENT_SURFACE_EXCLUSIONS} plus
 * test/instrument-surface-completeness.test.ts derive candidate gate-rule
 * paths from the live tree on every run and fail loudly the moment one is
 * neither covered here NOR excused there. That alarm never blocks a PR by
 * itself (only this constant does); it only stops a future gap from going as
 * unexamined as this one did.
 */
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
  // W1-T1060: the author-time acceptance gate's rule logic (reads the pull_request event payload,
  // exempts one bot login, then defers to the unmodified acceptanceAuthorTimeCheck below) — behind
  // its own unconditional pull_request job (.github/workflows/acceptance-author-gate.yml, already
  // covered by the "^\\.github/workflows/" entry above; this line is the script that job's `run:`
  // step calls). Same shape as the two entries directly above.
  "^scripts/acceptance-author-gate\\.mjs$",
  // W1-T2428: the fast lane's diff classifier. It decides which suites the `ci` and
  // `coverage-ratchet` jobs RUN, so a diff touching it changes what those gates measure — the
  // definition of this surface. Same shape as the three entries directly above: rule logic called
  // from a `run:` step of an unconditional, required ci.yml job.
  "^scripts/diff-class\\.mjs$",
];

const INSTRUMENT_SURFACE_RE = new RegExp(INSTRUMENT_SURFACE.join("|"));

/**
 * Deliberate exclusions from the {@link INSTRUMENT_SURFACE} completeness
 * alarm (test/instrument-surface-completeness.test.ts, W1-T402) — every
 * candidate that alarm's tree-derivation can find which is NOT covered by
 * {@link INSTRUMENT_SURFACE} above, mapped to the reason it earns a pass
 * rather than a report. A bare path list would rebuild the exact silent gap
 * this alarm exists to close (clause (iv) of W1-T402's design) — the reason
 * is what a reviewer actually reads, and the alarm itself refuses to honour
 * an entry whose reason is empty or whitespace-only. NEVER READ BY {@link
 * detectInstrumentEntanglement} — this map informs the alarm only; the
 * BLOCKING verdict is decided by {@link INSTRUMENT_SURFACE} alone.
 *
 * Two shapes of reason:
 *  - VERIFIED NON-INSTRUMENT: the candidate is real but is not gate-
 *    measurement logic — data/content a gate validates (not the rule that
 *    validates it), a generated artifact, a lockfile, ops/dev tooling no CI
 *    job invokes, or a fixture whose own falsifier test would catch tampering.
 *  - KNOWN GAP, WIDENING DEFERRED: the candidate genuinely IS gate-rule logic
 *    (recon guard-reach-2026-08-07 found eleven of these; this alarm's own
 *    derivation found three more it missed: generate-api-client.mjs,
 *    test-with-retry.mjs, tsconfig.json). Adding these to the BLOCKING
 *    INSTRUMENT_SURFACE list widens what refuses a PR, which W1-T402's design
 *    (clause v) requires measuring against real merged diffs first — a
 *    follow-up, not silently skipped here.
 */
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
  // W1-T2763 — THE SAME CLASSIFICATION AS ITS SIBLING DIRECTLY ABOVE, which this generator was
  // built to mirror. `macro-skills:check` is not a `.github/workflows/` `run:` step: it reaches CI
  // only through test/operator-macros-are-generated.test.ts inside `npm test`, exactly as
  // `cli-reference:check` does. So a diff cannot change what a workflow-level gate MEASURES by
  // touching this file. What it does gate is drift between settings/macros.yaml and the generated
  // `.claude/skills/` tree — operator-facing macro text, loaded by no daemon path (`spawnWorker`
  // passes `settingSources: []`) and carrying no gate rule of its own.
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

/**
 * ENFORCEMENT DATA (W1-T427): the files under `plan/**` that the fleet's own gates OBEY, as
 * opposed to the plan paperwork those gates are applied TO — each mapped to WHAT IT ENFORCES,
 * because a reviewer reads reasons, not lists (the {@link INSTRUMENT_SURFACE_EXCLUSIONS}
 * discipline, applied to a category on day one rather than retrofitted onto it later).
 *
 * WHY THE CATEGORY EXISTS. {@link isInPlanScope} is `MASTER-PLAN.md || ORIENTATION || plan/**`,
 * and {@link ReviewVerdict.planOnly}'s W1-T205 carve-out exempts a plan-scope-only diff from
 * proof execution. That is right for a task filing and wrong for these four, because plan scope
 * is not all paperwork: a PR that blunts an assertion in `plan/claims.yaml` RIDES the carve-out
 * that skips the very floor which would catch it, and the claims gate then certifies the blunted
 * assertion green ever after. Of the mapped guard gaps this is the only one that QUIETS ITS OWN
 * ALARM — the others fail loudly eventually (an out-of-scope file shows up in a diff; a bad
 * design produces a PR someone reads) — so it is closed BEFORE an incident rather than after.
 * FILED ASSUMED: no blunting incident exists, and W1-T427's shard says so in as many words
 * rather than implying one.
 *
 * THE SCOPE PREDICATE IS DELIBERATELY UNTOUCHED. Pulling these files out of `plan/**` was
 * weighed and rejected on measured churn: `plan/policy.yaml` alone carries 20 commits, and plan
 * scope feeds triage, filing rules and scope classification besides this carve-out —
 * reclassifying a file every consumer reads, to fix ONE consumer's blind spot, is the wide fix.
 * The narrow one is here, in the carve-out itself.
 *
 * MEASURED COST, so the denial is calibrated rather than assumed (local history at a7b88cd): 27
 * commits touch these four files and exactly THREE are plan-scope-only — all three single-file
 * `chore(policy)` edits to `plan/policy.yaml`. Those three would newly need a human merge in
 * place of an unattended arm. The other 24 already carried a `src/` or `test/` file and were
 * never plan-only, so this changes nothing for them. Routine `plan/tasks.yaml`/`plan/tasks.d`
 * filings are untouched and keep the carve-out whole.
 *
 * ONE FILE IS IN BOTH MAPS AND THAT IS NOT A CONTRADICTION: `plan/claims.yaml` sits in
 * {@link INSTRUMENT_SURFACE_EXCLUSIONS} as "claim DATA the claims gate validates, not the
 * checker's rule logic". That answers a DIFFERENT question — whether editing it is a
 * MEASUREMENT-INSTRUMENT change that must ride alone (Standing rule 25; it is not, the rule
 * logic is `scripts/claims-check.mjs`). Whether editing it may skip the proof floor is this
 * map's question, and the answer is no.
 *
 * EXACT PATHS, never prefixes: membership widens by an edit a reviewer reads, not by a regex
 * that quietly grows. New arrivals are caught by the completeness alarm in
 * test/enforcement-data-carveout.test.ts — not by a comment asking someone to re-check, which is
 * the carrier that failed for {@link INSTRUMENT_SURFACE} (W1-T402).
 */
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

/**
 * Deliberate exclusions from the {@link ENFORCEMENT_DATA} completeness alarm
 * (test/enforcement-data-carveout.test.ts) — every candidate that alarm's tree-derivation finds
 * which is NOT enforcement data, mapped to the reason it earns a pass rather than a report.
 * Exactly the {@link INSTRUMENT_SURFACE_EXCLUSIONS} contract: the alarm refuses to honour an
 * entry whose reason is empty or whitespace-only, because a bare path list would rebuild the
 * silent gap the alarm exists to close. NEVER READ BY {@link enforcementDataInDiff} — this map
 * informs the alarm only; what a diff actually loses the carve-out for is decided by
 * {@link ENFORCEMENT_DATA} alone.
 *
 * A key ending in `/` excuses a whole RECORD STORE — a directory the fleet reads by globbing,
 * never by naming a member. Those three hold 331 of the 337 tracked data files under `plan/`,
 * and their members are the paperwork the carve-out exists for; per-file entries would be noise
 * that hides the four real ones. They are candidates at all only because src/ PROSE cites
 * individual members as examples (DERIVED, not assumed: all three of today's such candidates
 * resolve to citations — doc comments in ci-parity.ts, review.ts and triage.ts, and PROMPT TEXT
 * in plan-architect.ts and triage.ts naming a shard as a structural model. A citation is not a
 * read, and neither is a prompt).
 */
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

/**
 * The enforcement-data paths a changed-file list touches, in diff order (W1-T427) — the OBSERVED
 * EVIDENCE named on the posted status by {@link cappedSummary}, not just a boolean (W1-T186
 * emitter discipline: an operator must be told WHICH file cost the carve-out).
 *
 * EXACT membership via `Object.hasOwn`, so an inherited `Object.prototype` key can never make a
 * path look like enforcement data, and no path can be matched by a prefix nobody declared.
 */
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

/**
 * A "product" path for entanglement purposes (W1-T297): under `src/` and NOT
 * itself a test file. `test/` files must NOT count as the product half of an
 * entanglement — the design's own carve-out — or an instrument-only PR could
 * never carry the fixture that proves it (`test/diff-coverage.test.ts` is
 * exactly the file W1-T212 shipped for this purpose).
 */
function isProductPath(path: string): boolean {
  return path.startsWith("src/") && !isTestPath(path);
}

/**
 * ENTANGLEMENT-EXEMPT INSTRUMENTS (prerequisite for W1-T941, Standing rule 25's own deferred
 * decision): {@link INSTRUMENT_SURFACE}'s doc names what the isolation rule protects — "the
 * code's own falsifiers were graded by the very version of the instrument that shipped beside
 * them", i.e. a GATE that decides OTHER PRs' pass/fail. A `scripts/*-baseline.json` matches the
 * surface by filename alone, with no regard for whether anything in `.github/workflows/` actually
 * READS it as a ratchet. A baseline nothing in CI reads has no grading power over anything — it is
 * a recorded derivation an unrelated PINNED CONSTANT cites, falsified by its OWN test/ fixture in
 * the SAME diff (exactly {@link detectInstrumentEntanglement}'s own "instrument + its own test/
 * falsifier" sanctioned shape), except that pin is one product-code line, not a whole file, so it
 * cannot be isolated into an instrument-only PR the way a full ratchet script/workflow pair can.
 *
 * EXACT PATHS, HAND-ENUMERATED, NEVER A PATTERN — the opposite failure mode from
 * {@link INSTRUMENT_SURFACE} (W1-T402: a hand enumeration went stale by DROPPING coverage). This
 * list can only ever NARROW what {@link INSTRUMENT_SURFACE} already claims for a named, reviewed
 * path; a new baseline this list has never heard of gets the safe default — full entanglement
 * blocking — never a silent gap on the other side. Adding an entry is a deliberate, reviewed
 * decision, like every other line on the instrument surface; the day a `.github/workflows/` job
 * starts reading a listed path as a pass/fail ratchet, remove it — the entanglement risk the rule
 * exists to catch would then genuinely apply.
 */
export const ENTANGLEMENT_EXEMPT_INSTRUMENTS: ReadonlySet<string> = new Set([
  // W1-T941: the knowledge-budget cap's derivation record. No workflow job ratchets against it;
  // its only reader is the pinned DEFAULT_KNOWLEDGE_BUDGET_CHARS constant (src/lib/learnings.ts)
  // and test/knowledge-budget-derivation.test.ts's own falsifier, both landing beside it.
  "scripts/knowledge-budget-baseline.json",
  // W1-T2526: the per-file source-size LEDGER. THIS ENTRY DOES NOT FIT THE REASON ABOVE, AND
  // SAYS SO RATHER THAN PRETENDING IT DOES. `scripts/source-size-ratchet.mjs` IS read in CI (via
  // test/a-source-file-cannot-outgrow-its-baseline.test.ts's "the shipped tree passes its own
  // recorded baseline", inside the unconditional `ci` job), so the knowledge-budget entry's
  // "nothing ratchets against it" reason is false here and is deliberately not reused.
  //
  // THE REASON THAT DOES APPLY IS THE LEDGER/FLOOR DISTINCTION. Standing rule 25's premise, in
  // detectInstrumentEntanglement's own words, is that "the code's own falsifiers were graded by
  // the very version of the instrument that shipped beside them". A SCORE FLOOR
  // (scripts/mutation-baseline.json, the coverage floors) grades falsifiers: lower it and a
  // weakened test suite passes, which is exactly the hazard, and those stay blocking. This file
  // grades nothing. It records how long each source file currently is. Raising an entry cannot
  // make a failing falsifier pass, cannot hide a bug, and cannot change any verdict about the
  // code's correctness -- it can only permit one named file to be longer, and the growth that
  // made it necessary is in the same diff, line for line, where a reviewer already reads it.
  //
  // AND WITHOUT THIS THE GATE IS UNSATISFIABLE, MEASURED. The ratchet's own header names the only
  // sanctioned way to move a ceiling up ("a human raising scripts/source-size-baseline.json by
  // hand, on the record"), so EVERY PR that grows a src/ file must carry both halves and was
  // refused. Pre-raising in a separate instrument-only PR is not an escape either:
  // evaluateSourceSizeRatchet classifies a recorded value above the measured one as `shrunk` and
  // writes it back DOWN on the next otherwise-clean run. On 2026-08-31 the ledger went stale on
  // five consecutive merges and left `main` itself red on this gate; #3352 was the repair, and it
  // could only ever arrive one PR late.
  //
  // NARROWER ALTERNATIVE, DELIBERATELY NOT TAKEN HERE. The precise carve-out is on the SHAPE of
  // the hunk -- exempt an edit to this file only when every changed line is a `"path": N` ceiling
  // entry -- which would keep the rule's full force over any OTHER edit to it. That is a bigger
  // change than the deadlock could wait for; if this blanket entry proves too wide, that is the
  // replacement, not a wider pattern.
  "scripts/source-size-baseline.json",
]);

/**
 * INSTRUMENT ISOLATION (W1-T297, Standing rule 25): true when `diffFiles`
 * contains at least one {@link INSTRUMENT_SURFACE} path AND at least one
 * {@link isProductPath} src/ path — the ENTANGLEMENT predicate, not mere
 * instrument-touching. An instrument-only diff (optionally with its own
 * `test/` falsifier and/or a `docs/` update) is the sanctioned shape and
 * returns `entangled: false`; so does a src-only, plan-only, or docs-only
 * diff. `instrumentPaths`/`srcPaths` are the OBSERVED EVIDENCE named in the
 * failure text and the fix rung's escalation (W1-T186 emitter discipline).
 *
 * {@link ENTANGLEMENT_EXEMPT_INSTRUMENTS} is subtracted FIRST, before either array is built — a
 * path on that list never counts as `instrumentPaths` evidence, exactly as if it were never on
 * {@link INSTRUMENT_SURFACE} at all (it stays on that surface for every OTHER purpose: docs
 * awareness, the completeness alarm, `USER_VISIBLE_SURFACE_RE`).
 */
/**
 * DECLARATIONS WHOSE DATA HAS GRADING POWER OVER OTHER PRs. A changed line inside one of these
 * counts as EXECUTABLE even when it is a bare string literal, because adding a path here is not
 * documentation — it decides what {@link detectInstrumentEntanglement} treats as an instrument,
 * and what it exempts. Without this carve-out the literal-only rule below would let a diff
 * register (or exempt) its own instrument in the same breath as editing it, which is precisely
 * the "an instrument edited to pass the code it judges" risk Standing rule 25 exists to stop.
 * Matched against the enclosing declaration git names in the hunk header, never against the
 * line's own text — the line is a bare string in every case and carries no signal of its own.
 */
const GRADING_POWER_DECLARATIONS: readonly string[] = [
  "INSTRUMENT_SURFACE",
  "INSTRUMENT_SURFACE_EXCLUSIONS",
  "ENTANGLEMENT_EXEMPT_INSTRUMENTS",
  "ENFORCEMENT_DATA",
];

/**
 * Does one changed line carry code an instrument could actually mis-grade?
 *
 * NON-EXECUTABLE, and why each shape qualifies: a blank line; a `//` line comment; a JSDoc or
 * block-comment body line (this codebase opens every one with `*`); and a line whose entire
 * non-comment content is string or template-literal text plus punctuation — the usage-table and
 * doc-literal shape. What survives the strip is what a reviewer's falsifiers could be graded on.
 *
 * FAIL-CLOSED BY CONSTRUCTION. Anything this cannot confidently classify — an unusual comment
 * style, a line that is half literal and half call — keeps an identifier after the strip and is
 * therefore EXECUTABLE. The rule only ever subtracts shapes it can positively recognise.
 *
 * TYPE-ONLY DECLARATIONS ARE DELIBERATELY NOT EXEMPTED HERE. A type member (`x?: T;`) and a value
 * in an object literal (`x: t,`) are the same bytes; separating them needs a parser, not a regex,
 * and guessing wrong on a Rule 25 gate fails OPEN. They stay executable until something can read
 * them properly.
 */
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

/**
 * Does this file's half of the patch change executable code, or only prose?
 *
 * Reads the hunk headers git already emits (`@@ … @@ <enclosing declaration>`) so a bare string
 * added to a {@link GRADING_POWER_DECLARATIONS} table is never mistaken for a usage line.
 *
 * `true` when the patch cannot be read for this file at all — an absent or unparseable diff must
 * never quietly exempt a path (the same fail-closed direction {@link changedLineIsExecutable}
 * takes line by line).
 */
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
//
// THE CIRCULARITY. A census gate is only real once `src/lib/ci-parity.ts` knows about it (a
// `src/` registration), and its rule logic is a `scripts/<name>.mjs` file. When that filename
// happens to match {@link INSTRUMENT_SURFACE}'s `^scripts/[^/]*-ratchet\.mjs$` entry, the two
// necessarily land in one diff and {@link detectInstrumentEntanglement} refuses it as entangled
// (#3331) — there is no ordering that avoids this directly: ship the script alone and a
// DIFFERENT floor (instrument-surface-completeness) refuses it as an undeclared surface (#3335)
// instead.
//
// WHY THE INTRODUCING COMMIT IS NOT WHAT RULE 25 WAS WRITTEN TO CATCH. The rule's premise,
// stated at {@link detectInstrumentEntanglement}'s own doc, is that "the code's own falsifiers
// were graded by the very version of the instrument that shipped beside them" — a claim about an
// EXISTING instrument being changed alongside the product it measures. A script that has never
// existed before this diff, registered for the first time in this same diff, has no prior
// version anything could have been mis-graded against.
//
// THE CARVE-OUT, NARROW BY CONSTRUCTION. Both halves must be NEW in the SAME diff: the script
// itself has no prior version (a brand-new file, not a rename or an edit of one that already
// shipped), AND `src/lib/ci-parity.ts` carries a newly ADDED line naming its stem. Either half
// missing — an existing script re-registered, a new script whose registration is not part of
// this diff, or a new script alongside an unrelated `src/` edit — gets NO carve-out and stays
// governed by the ordinary entanglement predicate below (acceptance claims 2-4). The predicate
// never inspects the matched {@link INSTRUMENT_SURFACE} pattern itself, so the outcome does not
// depend on whether the filename happens to match the `-ratchet` shape (claim 5), and it never
// reads {@link INSTRUMENT_SURFACE_EXCLUSIONS} — that map stays advisory, informing a DIFFERENT
// alarm only (claim 6, same discipline as {@link ENTANGLEMENT_EXEMPT_INSTRUMENTS} above).
//
// NOT SUBTRACTED FROM THE RETURNED EVIDENCE. Unlike {@link ENTANGLEMENT_EXEMPT_INSTRUMENTS} (which
// removes an exempt path from `instrumentPaths` as if it were never on the surface at all), a
// carved-out introducing commit keeps its raw `instrumentPaths`/`srcPaths` evidence intact — the
// script and the registration are real changes, just not the shape Rule 25 exists to catch. Only
// the `entangled` verdict itself is affected. This is deliberate: it is what lets the raw
// instrument+src evidence be read back out as the negative control (claim 7) that the carve-out
// is doing real work, rather than the fixture being vacuously non-entangled to begin with.
//
// PATH-ONLY CALLERS GET NO CARVE-OUT, THE SAME FAIL-CLOSED DEFAULT `srcChangeIsExecutable` TAKES
// ABOVE. Telling a brand-new file from an edited one needs the patch; a caller that cannot supply
// `diff` gets today's stricter, path-only reading — never a silently widened exemption.

/** The path a census gate's registration lives at (#3331/#3335's own shared root cause). */
const CENSUS_REGISTRATION_PATH = "src/lib/ci-parity.ts";

/**
 * True when `file` is a brand-new addition in this diff — a `diff --git` block carrying git's
 * own `new file mode` marker, or (equivalently, and just as authoritative) a `--- /dev/null`
 * source side. Neither a rename (git emits `rename from`/`rename to`, not `new file mode`) nor an
 * ordinary edit of a file that already existed qualifies.
 */
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

/**
 * True when `scriptFile` (already known to be on {@link INSTRUMENT_SURFACE}) is a newly
 * introduced census gate in `diff`: see the section doc above for the full design. Requires the
 * script to be brand-new ({@link fileIsNewInDiff}) AND `src/lib/ci-parity.ts` to carry a newly
 * ADDED line naming its stem — an unrelated, pre-existing registration entry that merely mentions
 * the stem in a comment or context line does not count, only an add.
 */
/** The one workflow {@link CI_PARITY_TABLE} mirrors — see test/preflight-ci-parity.test.ts, which
 *  asserts that table against THIS file in both directions. */
const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";

/**
 * W1-T2738 — a ci.yml JOB introduced by this diff, keyed on the REGISTERED UNIT rather than on the
 * instrument FILE. `.github/workflows/ci.yml` has existed since the repo did, so
 * {@link fileIsNewInDiff} is false for it however new the job is — which is the single fact that
 * put a new ci.yml job outside W1-T2521's carve-out.
 *
 * A JOB IS INTRODUCED WHEN TWO ADDS AGREE ON ONE NAME: ci.yml gains a job key, and
 * `src/lib/ci-parity.ts` gains a line registering THAT name. Requiring the pair is not belt-and-
 * braces, it is the discrimination — `on:`'s own children (`pull_request:`, `push:`) are indented
 * exactly like a job key, so the shape alone cannot tell a new trigger from a new job, and nothing
 * ever registers a trigger in the parity table. Co-presence is not enough either: the registered
 * name must be the name ci.yml added, or a diff that adds one job while registering a different
 * one would carve out the wrong unit.
 *
 * THE PARITY TABLE IS WHY THIS PAIR IS FORCED RATHER THAN MERELY CONVENTIONAL.
 * test/preflight-ci-parity.test.ts refuses an entry for a job ci.yml does not define AND a real job
 * with no entry, and both fail on `main` rather than only on a PR — so the two adds cannot be split
 * across PRs in either order. With entanglement closing the third ordering, refusing this shape
 * left a new ci.yml job with no admissible sequence at all.
 */
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
  // A PATH ON THE INSTRUMENT SURFACE IS NOT PRODUCT CODE, EVEN WHEN IT LIVES UNDER `src/`.
  //
  // WHY THIS SUBTRACTION EXISTS. `isProductPath` is unconditionally `src/` and not `test/`, so
  // before this line a `src/` file named by {@link INSTRUMENT_SURFACE} landed in BOTH arrays and
  // `entangled` was true on that one file plus a workflow — with nothing else in the diff. That made
  // the exemption INEXPRESSIBLE: adding any `src/` path to the surface could never change a verdict,
  // because the same path re-entered as product. MEASURED on #1863's real file list with a candidate
  // path added to the surface: still `entangled: true`.
  //
  // AND IT PRESERVES THE RULE'S REASON RATHER THAN MUTING IT. The premise is that "the code's own
  // falsifiers were graded by the very version of the instrument that shipped beside them" — which is
  // a statement about PRODUCT code and the instrument measuring it. A file that IS the instrument has
  // no product falsifiers of its own to be mis-graded; it is the measuring device, not the measured.
  // So subtracting it is faithful to the premise, not a relaxation of it. Everything genuinely
  // product-shaped still counts: `src/lib/review.ts` is not on the surface and stays product, which
  // is what keeps the reviewer subject to its own rule.
  //
  // INERT AT THIS SHA, DELIBERATELY. No pattern in {@link INSTRUMENT_SURFACE} matches anything under
  // `src/` today, so this subtraction removes nothing from any present diff and changes no verdict —
  // it only makes a future exemption POSSIBLE to express. Granting one is a separate decision and is
  // NOT taken here.
  //
  // AND THE `src/` HALF MUST CARRY EXECUTABLE CONTENT (`diff` supplied). The rule's premise is that
  // "the code's own falsifiers were graded by the very version of the instrument that shipped
  // beside them" — which presupposes there IS code to grade. A `src/` hunk that appends a sentence
  // to a usage string, or a comment, has no falsifiers an instrument could mis-grade, so counting
  // it names an entanglement that cannot exist. MEASURED: #2884 was split by hand over one appended
  // usage sentence and both halves then passed unchanged; a later lane DUPLICATED a helper across
  // two `.mjs` files rather than register a path on {@link INSTRUMENT_SURFACE}, because that meant
  // editing this file and tripping this rule — the rule had begun shaping code to avoid itself.
  //
  // OMITTING `diff` KEEPS TODAY'S BEHAVIOUR EXACTLY. A caller that cannot supply the patch gets the
  // path-only reading it has always got — strictly the stricter of the two, so a caller that
  // forgets fails closed rather than silently widening the exemption.
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

/**
 * A reason the report STATES for why no doc update accompanies a surface
 * change — the report's own words, not inferred. Requires the "no doc(s)
 * change/update" phrase to be followed by an actual reason (a `because`/`:`/
 * dash then more text) — a bare "no docs update" with nothing after it has not
 * stated why, so it does not count as an excuse.
 */
const STATED_REASON_RE = /\bno\s+docs?\s+(?:change|update)\b[^.\n]{0,6}(?:because|:|-|—)\s*\S/i;

/**
 * DOCS AWARENESS: a diff touching a CLI/config/gate/verdict surface must also
 * touch `docs/`, or the report must state why not. Silence is a fail — exactly
 * the drift the awareness layer exists to catch (a behavior-changing diff with
 * no doc update and no stated reason).
 */
export function checkDocsAwareness(diff: string, report?: string): RubricItemResult {
  const files = changedFiles(walkDiff(diff));
  const rawSurfaceTouched = files.filter((f) => USER_VISIBLE_SURFACE_RE.test(f));
  // W1-T2547: a GENERATED LEDGER (e.g. scripts/source-size-baseline.json) matches the instrument
  // surface by filename alone, same as it does for {@link detectInstrumentEntanglement}, but it
  // records a measurement and has no user-visible surface to document — see
  // task-linter.ts's GENERATED_LEDGER_CLASSES for the shared table and full reasoning. Subtracted
  // here ONLY; a diff that also touches a REAL surface still reports on that surface below.
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

/**
 * The ids of entries NEWLY ADDED (not merely edited) to `learnings/failures.yaml`
 * that carry `operator_impact: true`. "Newly added" is diff-scoped exactly like
 * {@link checkCallersAudited}'s add/del pairing: a `- id: <id>` line that appears
 * only on an ADD line (never as an unchanged context line, and never on a DEL
 * line) starts a brand-new entry; a field added to an EXISTING entry leaves the
 * `- id:` line itself on a context line. Each new entry's span runs from its
 * `- id:` add-line to the next `- id:` add-line (or end of the file's lines).
 */
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

/**
 * A reason the report STATES for why a new operator-impacting failure has no
 * troubleshooting entry — same shape as {@link STATED_REASON_RE}, scoped to this
 * item's own excuse phrase so the two items' excuses can't be confused for each
 * other.
 */
const TROUBLESHOOTING_STATED_REASON_RE =
  /\bno\s+troubleshooting\s+entry\b[^.\n]{0,6}(?:because|:|-|—)\s*\S/i;

/**
 * TROUBLESHOOTING COVERAGE: a diff that adds a new `operator_impact: true` entry
 * to `learnings/failures.yaml` must also touch `docs/troubleshooting.md` naming
 * that entry's id, or the report must state why not. Mirrors DOCS AWARENESS
 * (Item 5) one level narrower: the failures corpus specifically, so an
 * operator-visible incident always gets a symptom/cause/fix write-up.
 */
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

/**
 * The ids of entries NEWLY ADDED (not merely edited) to `learnings/failures.yaml`
 * that carry `drill_obligating: true`. Same diff-scoped "newly added" rule as
 * {@link newOperatorImpactfulFailureIds}: a `- id: <id>` line present only on an
 * ADD line (never as context, never on a DEL line) starts a brand-new entry; a
 * field added to an EXISTING entry leaves the `- id:` line itself on a context
 * line, so it is a modification, not a new entry. Each new entry's span runs
 * from its `- id:` add-line to the next `- id:` add-line (or end of file).
 */
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

/**
 * A reason the report STATES for why a new drill-obligating failure has no
 * drill-table touch — same shape as {@link TROUBLESHOOTING_STATED_REASON_RE},
 * scoped to this item's own excuse phrase so the two items' excuses can't be
 * confused for each other.
 */
const DRILL_STATED_REASON_RE = /\bno\s+drill\s+(?:table\s+)?entry\b[^.\n]{0,6}(?:because|:|-|—)\s*\S/i;

/**
 * DRILL COVERAGE: a diff that adds a new `drill_obligating: true` entry to
 * `learnings/failures.yaml` must also touch `scripts/recovery-drill.mjs` (the
 * `RECOVERY_PATHS` table W1-T366/W1-T938 built), or the report must state why
 * not. Mirrors TROUBLESHOOTING COVERAGE (Item 6) exactly, one field over: the
 * postmortem's last step becomes "add it to the drill" instead of "write up
 * the symptom" — same diff-only derivation, same stated-reason escape hatch,
 * same "flag or say why not" polarity.
 */
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

/**
 * True for `plan/tasks.yaml` itself OR a `plan/tasks.d/<id>-<slug>.yaml` (or `.yml`) shard
 * (W1-T399): every task record lives in one of the two, `loadPlan` (plan.ts) merges both into
 * one view, and the monolith has been frozen to new filings since PR #1060 — of the last twenty
 * merged implementation PRs, nineteen worked a shard task. A predicate keyed on the monolith path
 * alone is therefore blind to nearly the whole population Standing rule 15 exists to protect.
 * Matched STRUCTURALLY (a `plan/tasks.d/` prefix, exactly one path segment, a `.yaml`/`.yml`
 * suffix) rather than a loose glob, so it does not also admit a `plan/tasks.d/README.md` or a
 * nested path {@link loadPlan}'s own shard reader (`listShardFiles`) never recurses into.
 *
 * BOTH EXTENSIONS, NOT JUST `.yaml` (R-14, docs/audits/recon-2026-09-05.md): `listShardFiles`
 * (plan.ts) and `materializeOriginShards` (run-task.ts) both load `.yaml` OR `.yml` shards, so a
 * `.yml` shard's criteria are as live as a `.yaml` one's — but this predicate accepted only
 * `.yaml` until this fix, so an identical criterion-editing diff tripped Rule 15 on a `.yaml`
 * shard and passed silently on a byte-identical `.yml` one. Mirrors `SHARD_PATH_RE`'s existing
 * `.ya?ml` above and `TASKS_SHARD_PATH_RE` in task-linter.ts, widened by the same fix.
 */
function isTaskRecordPath(file: string): boolean {
  return /(^|\/)plan\/tasks\.yaml$/.test(file) || /(^|\/)plan\/tasks\.d\/[^/]+\.ya?ml$/.test(file);
}

/**
 * plan/tasks.yaml OR plan/tasks.d/*.ya?ml lines belonging to a criterion's own field, of the
 * given diff kind — INCLUDING a criterion field's block-scalar CONTINUATION lines (R-16,
 * docs/audits/recon-2026-09-05.md).
 *
 * Before this fix the match was a bare per-line regex (`^\s*(claim|proof|satisfied_by)\s*:`),
 * which sees only a field's OWN header line. A field written as a YAML block scalar —
 * `proof: >-` followed by indented continuation lines carrying the actual text — has NO `:` on
 * those continuation lines at all, so an edit confined to them tripped neither
 * `criterionFieldTampered` disjunct: `guard.passes` on a diff that rewrites what a criterion's
 * proof literally says. Zero block-scalar proofs exist in the corpus today (every proof in
 * `plan/tasks.d/` is single-line), but the loader accepts them (js-yaml has no opinion on scalar
 * style) and nothing stops a future shard, hand-authored or machine-generated, from using one.
 *
 * FIXED BY WALKING THE DIFF'S OWN LINE ORDER as a tiny YAML-indent state machine, using every
 * line the diff carries — `ctx` included — to track which field currently "owns" a deeper
 * indent, mirroring the design note in the R-16 build brief: "walk the diff hunk's context to
 * find the nearest preceding field line at a shallower indent". A single `openScalar` slot
 * (rather than a full nested stack) suffices because at any point in a top-to-bottom walk only
 * one block scalar can be currently open — a shallower field header always closes it (a DEDENT),
 * so there is never more than one active owner to disambiguate.
 *
 * FAIL CLOSED, NEVER OPEN, when the owning field's own header line falls entirely outside this
 * diff's hunk context (so no `openScalar` was ever recorded for it): any add/del line indented
 * deeper than the nearest KNOWN `acceptance:` line, with no recognized owner, is still counted —
 * per the build brief's own instruction — rather than silently passing an edit this walk cannot
 * positively clear. A line outside any `acceptance:` block (e.g. a top-level `rationale: >-`
 * continuation, which sits OUTSIDE `acceptance:` in the schema — plan.ts's `Task.rationale`) is
 * never swept in by this fallback, which is what keeps a non-criterion field's edit unflagged
 * (proven by `rule15-guard-sees-yml-and-block-scalars.test.ts`'s falsifier (iii)).
 */
function planTasksCriterionFieldLines(lines: DiffLine[], kind: "add" | "del"): DiffLine[] {
  // Function-local (never module-scope): a YAML mapping-key line, however it is indented —
  // `<indent><"- "?><key>:<rest>` — matched once so a computed indent (dash included) and the
  // key/rest are never derived two different ways. Requires `key` to be followed immediately by
  // `:` (no intervening whitespace), which is what keeps a `unit test: <title>` or `grep:
  // <pattern> in <path>` proof-dialect CONTENT line (a space before its colon) from ever being
  // misread as a fresh field header — see the block-scalar walk below.
  const fieldLineRe = /^(\s*)(-\s+)?([A-Za-z_][\w-]*)\s*:\s*(.*)$/;
  // True when a field's own value (the text after its `:`) is a YAML block-scalar opener —
  // `|`/`>` with an optional chomping (`+`/`-`) and/or explicit indent-indicator digit, and
  // NOTHING else on the line. That is the only shape whose CONTINUATION lines carry no `key:`
  // prefix of their own, which is exactly the shape Rule 15 must still see into (R-16).
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

/**
 * RULE 15's shared diff-derived predicate (W1-T58, ratifies P3 via P8/
 * RETRO-1784058021334; originally W1-T3E's narrower `satisfied_by`-only check;
 * W1-T400 widened the ADD side from `satisfied_by`-only to any criterion
 * field): true when a diff either ADDS a `claim:`/`proof:`/`satisfied_by:`
 * line, or REMOVES an existing one, in `plan/tasks.yaml` or a
 * `plan/tasks.d/*.yaml` shard (W1-T399).
 *
 * A removed field line is present whether the field's TEXT changed (an edit)
 * or the whole criterion was deleted. An added field line is present whether
 * an EXISTING criterion gained a field (e.g. a `satisfied_by:`) or a WHOLE
 * NEW criterion — a fresh `claim:`/`proof:` pair — was APPENDED after the
 * existing ones: a pure append deletes nothing and, before W1-T400, added no
 * `satisfied_by:` either, so it tripped neither disjunct and let a diff add a
 * criterion its own changes already satisfied instead of editing one (PR
 * #1295 did exactly this). Both shapes read as "the criteria no longer say
 * what the Architect wrote". Diff-derived ONLY: callers apply their OWN
 * exemption on top ({@link checkSatisfiedByGuard}: `planOnly && humanAuthored`;
 * {@link judgeReview}: `planOnly` alone — the one signal that pure function
 * has, and the reason this widening does not also catch an ordinary task
 * filing: a filing is nothing but added claim/proof lines, but it is
 * plan-only, so the exemption — not this predicate — is what keeps it clean).
 */
function criterionFieldTampered(diff: string): boolean {
  const lines = walkDiff(diff);
  const addedField = planTasksCriterionFieldLines(lines, "add").length > 0;
  const removedField = planTasksCriterionFieldLines(lines, "del").length > 0;
  return addedField || removedField;
}

/**
 * THE RULE-15 GUARD: `satisfied_by` and criteria text are Architect-only
 * (plan.ts / Standing rule 15 — "a worker may never [correct a mis-specified
 * task]"). A diff that ADDS a `claim:`/`proof:`/`satisfied_by:` field — an
 * EXISTING criterion gaining one, or a WHOLE NEW criterion appended after the
 * existing ones (W1-T400) — OR EDITS/REMOVES an existing criterion's field, in
 * `plan/tasks.yaml` or a `plan/tasks.d/*.yaml` shard (W1-T399), FAILS unless
 * the PR is plan-only AND human-authored — a worker doing any of these to its
 * own blocking criteria is "editing the criteria to match the diff", a failed
 * task, not a merge, whether the edit shape is a modification or an append
 * that passes by construction. W1-T58 broadened this from W1-T3E's original
 * add-only `satisfied_by` check to cover the full "edits its criteria" shape
 * the rule actually names; W1-T400 closed the remaining append gap.
 */
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
  // NAME THE CONDITION THAT FAILED, NEVER GUESS THE AUTHOR (W1-T385). This message is
  // ADVISORY and reaches the operator verbatim, so a claim it cannot substantiate costs
  // a re-derivation: the single old wording asserted "worker-authored … outside a
  // plan-only human PR" on every refusal, which was false in BOTH directions on a
  // plan-only hand-opened PR — it named an author the review path could not know AND
  // denied a plan-only property the same call had just computed as true.
  const edit =
    "plan/tasks.yaml's (or a plan/tasks.d/ shard's) acceptance criteria were added/edited (an added " +
    "claim/proof/satisfied_by field — including a whole new criterion appended after the existing ones — " +
    "or an edited/removed one)";
  // THE FULL REMEDY LIVES HERE, and deliberately not in `failSummary` above: that string is the
  // commit-status description and is cut at 140 characters, while this `reason` has no cap and this
  // function's own doc already commits to it reaching the operator verbatim.
  //
  // IT HAS TWO HALVES BECAUSE ONE IS NOT ENOUGH, and that is measured rather than assumed. Telling
  // an author only to SPLIT the filing converts one refusal into another: #3626, #3631, #3636 and
  // #3669 each split correctly and were then refused anyway, because a filing PR's proofs name a
  // test the implementation has not written yet, grade `not_yet_built`, and leave the KEYWORD FLOOR
  // to judge the body against each proof's own text. #3669 scored 2 of 5 proof keywords against
  // MIN_COVERAGE 0.6 and all seven of its criteria read UNMET on a shard nothing was wrong with.
  //
  // The floor was RIGHT in every one of those cases and must not be relaxed to accommodate them: a
  // claim about the ACT of filing has no support in a diff that IS the shard. What the author needs
  // is the second sentence — substantiate each criterion by NAMING the proof that will carry it.
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

/**
 * Run the full rubric — the four §5 layer-2 judgment items plus DOCS AWARENESS,
 * TROUBLESHOOTING COVERAGE, DRILL COVERAGE, and the satisfied_by guard — over a
 * (diff, report) and PR-level facts. ADVISORY: `pass` rolls up all items, but
 * the binding gate is layer 1. `failures` names exactly which items tripped.
 */
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

/**
 * W1-T359: render {@link judgeRubric}'s failing items as a clearly-labeled
 * ADVISORY section for the posted review — `undefined` when the rubric has no
 * failures, so a clean rubric adds nothing to the review body. The header
 * spells out, in the text itself, that this section never changes
 * `remudero-review`'s verdict (Standing rules 2/12: an LLM/heuristic may
 * RECOMMEND, only code ENFORCES) — the one property the acceptance's
 * falsifier checks structurally at the call site (independence from
 * `judgeReview`'s inputs/output), this doc note checks in the rendered text
 * itself so a reader of the PR comment never mistakes it for a gate.
 */
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

/**
 * W1-T434: render this review's `scope_violation` advisory — the one {@link scopeViolationFiles}
 * already computed for {@link ReviewVerdict.unwiredAdvisories} — as a PR-comment section, so a
 * declared-scope overrun reaches the human gate instead of only the ledger. `undefined` when the
 * diff stayed inside the task's declared `files:` (or the task declared nothing), so a clean PR
 * adds nothing to the comment.
 *
 * READS THE ADVISORY, NEVER RECOMPUTES IT. The comparison has exactly one home
 * ({@link scopeViolationFiles}); this is a formatter over its result, the same relationship
 * {@link rubricAdvisorySection} has to {@link judgeRubric}. A second walk here could drift from
 * the one the ledger's `review.unwired_advisory` line reports, and then the PR comment and the
 * ledger would disagree about the same PR.
 *
 * WHY THIS EXISTS AT ALL, AND WHY IT IS ADVISORY. Until W1-T434 the push-site guard ({@link
 * "../run-task.js".scopeGuardOutOfScopeFiles}) answered an overrun by REFUSING the push: the
 * branch never reached origin and died with the reaped worktree, so the evidence an operator
 * would need to tell a phantom revert from an under-declared `files:` was destroyed by the same
 * action that reported it. The branch is now pushed and the overrun flagged — here, and on the
 * `scope_guard.overrun` ledger line. ADVISORY because a measured majority of declared-scope
 * widenings are legitimate (W1-T401's settlement: generator-gate artifacts, a task's own plan
 * shard, operator-instructed or review-ratified widenings); like {@link rubricAdvisorySection}
 * the header says so in the rendered text itself, so no reader mistakes it for a gate.
 */
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

/**
 * Render this review's `unwired_export` advisory — the one {@link unwiredAdvisoriesFor} already
 * computed for {@link ReviewVerdict.unwiredAdvisories} — as a PR-comment section, so an export
 * added with nothing reaching it lands at the human gate instead of only the ledger. `undefined`
 * when every added export is reachable or carries a marker, so a clean PR adds nothing.
 *
 * THE SIBLING OF {@link scopeAdvisorySection}, BUILT THE SAME WAY AND FOR THE SAME REASON. Of the
 * four {@link UnwiredAdvisory} reason codes only `scope_violation` reached the gate; the other
 * three were computed, ledgered on `review.unwired_advisory`, and never rendered. MEASURED over
 * the 60 most recently merged PRs (2026-08-26): 14 added at least one exported symbol, 35 symbols
 * were examined, and 1 PR — #2952, adding `boardReviewMarkerPath` and `recordBoardReviewFire`
 * with nothing referencing either — carried an `unwired_export` nobody saw. That is the same
 * defect W1-T434 fixed for `scope_violation`, one code over.
 *
 * READS THE ADVISORY, NEVER RECOMPUTES IT — the reachability walk has exactly one home ({@link
 * "./reachability.js".scanUnreachedExports}), and this is a formatter over its result, the same
 * relationship {@link scopeAdvisorySection} has to {@link scopeViolationFiles}. A second walk
 * here could drift from the one `review.unwired_advisory` reports, and then the PR comment and
 * the ledger would disagree about the same PR.
 *
 * ADVISORY AND NON-BLOCKING, DELIBERATELY. An unreached export is not by itself a fault: a symbol
 * shipped one PR ahead of its caller is a normal split, which is why the `WIRED-AT`/
 * `SHIPS-UNWIRED` markers exist and why {@link unwiredAdvisoriesFor} honours them before flagging
 * anything. Like {@link scopeAdvisorySection} the header says "advisory" in the rendered text, so
 * no reader mistakes it for a gate. Whether this should ever BLOCK is W1-T323's open operator
 * adjudication, which carries its own numeric criterion — this renderer does not preempt it, and
 * adds no row to `DECISION_RELEVANT_LEDGER_STEPS`.
 *
 * Symbols are deduped so a symbol named by more than one advisory on the same head renders once.
 */
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

/**
 * Render this review's `inverse_scope` advisory — the one {@link inverseScopeUntouchedFiles}
 * already computed for {@link ReviewVerdict.unwiredAdvisories} — as a PR-comment section, so a
 * declared path the diff never touched reaches the human gate instead of only the ledger.
 * `undefined` when the diff touched every path the task declared (or the task declared nothing),
 * so a clean PR adds nothing to the comment.
 *
 * THE THIRD OF THE THREE, BUILT EXACTLY LIKE ITS TWO SIBLINGS. W1-T434 rendered
 * `scope_violation`; #3021 rendered `unwired_export` for the same reason one code over; this is
 * `inverse_scope`, invisible on the identical grounds. MEASURED over the 60 most recently merged
 * PRs, driven through the real {@link unwiredAdvisoriesFor} with production argument shapes:
 * `scope_violation` 5 (8%), `inverse_scope` 2 (3%), `unwired_export` 1 (2%). A 3% code that no
 * reader ever sees is the same defect as the 2% one, not a smaller one.
 *
 * THE FOURTH CODE IS DELIBERATELY NOT RENDERED. `unresolved_task_scope` measured 0, and not
 * because it is rare: {@link unresolvedTaskScopeOverlaps} returns empty unless {@link
 * ReviewEvidence.openTaskDeclaredFiles} is populated, and that field has NO producer anywhere in
 * `src/` — its only assignments repo-wide are in tests (control: its wired sibling {@link
 * ReviewEvidence.openTaskIds} is populated at three `src/` sites). A renderer behind an
 * unpopulated field would be dead code, and whether to wire the producer at all is an open
 * operator decision, not this formatter's to presume.
 *
 * READS THE ADVISORY, NEVER RECOMPUTES IT. The declared-versus-touched comparison has exactly one
 * home ({@link inverseScopeUntouchedFiles}); this is a formatter over its result, the same
 * relationship {@link scopeAdvisorySection} has to {@link scopeViolationFiles}. A second walk here
 * could drift from the one `review.unwired_advisory` reports, and then the PR comment and the
 * ledger would disagree about the same PR.
 *
 * ADVISORY AND NON-BLOCKING. An undertouched scope is not by itself a fault — a task whose
 * `files:` list was written ahead of the work, or split across more than one PR, looks identical
 * here. Like both siblings the header says "advisory" in the rendered text. Whether any of this
 * should BLOCK is W1-T323's open operator adjudication, which carries its own numeric criterion;
 * this does not preempt it and adds no ledger registration.
 *
 * Paths are deduped so a path named by more than one advisory on the same head renders once.
 */
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

/**
 * The observable OUTCOME of the fresh advisory reviewer spawn, surfaced on the
 * `review.posted` ledger line and the console review summary. Before this, a
 * floor-only PASS (the LLM reviewer walled `error_max_turns` on an undeclared
 * `maxTurns: 12` cap, or was never spawned at all) was byte-identical in the
 * ledger to a review the reviewer actually COMPLETED — an operator could not
 * tell "remudero-review=success, verified" from "remudero-review=success,
 * mechanical floor only" (P10-a). `judgeReview`'s binding verdict is unaffected
 * either way (Standing rules 2/4/12); this is purely a LEGIBILITY signal.
 */
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
  /**
   * W1-T2472: true when the spawn was skipped because the changeset is PLAN-ONLY.
   *
   * WHY THIS IS A DISTINCT VALUE AND NOT JUST `attempted: false`. `not_attempted` already carries
   * two documented causes — `spawnReviewer===false` and "no criteria to judge" — and this adds a
   * THIRD, structurally different one: criteria exist and a reviewer would have been dispatched,
   * but the diff has no code for the advisory lane to judge (W1-T205). Folding it into
   * `not_attempted` would make the ledger unable to answer "how often does the skip fire", which
   * is the only way to measure the change that introduced it, and would silently widen a value
   * whose own doc enumerates its causes. The verdict is unaffected either way — like every other
   * `reviewerOutcome`, this is purely a LEGIBILITY signal (P10-a).
   */
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

/**
 * Post the `remudero-review` commit status to a PR head sha. Thin wrapper over
 * the exact `gh api` call from the design; mirrors the other gh helpers in
 * lib/worker.ts (untested by unit — it shells out). WRITE-scoped to a commit
 * STATUS only; it can never edit code.
 *
 * W1-T203 (i): when {@link REVIEWER_TOKEN_ENV} is set, this `gh` invocation
 * authenticates as the dedicated reviewer identity (`GH_TOKEN` overrides
 * whatever `gh` would otherwise pick up from ambient auth) rather than
 * whatever credential the operator/workers share — the one thing that makes
 * {@link resolveReviewProvenance}'s login compare meaningful at arm time.
 * Unset ⇒ falls back to ambient `gh` auth, byte-identical to before this
 * task (see the env var's own doc comment for the bootstrap-ordering
 * rationale). The token itself never reaches this function via an argument —
 * only via the orchestrator's OWN process env, which a worker's sandboxed
 * env/HOME cannot read (`settings/worker.json` already denies
 * `~/.config/remudero/**`).
 */
/**
 * W1-T135: total attempts (first try + retries) before a TRANSIENT gh-status-post
 * error gives up — one initial attempt plus 3 retries, the same retry BOUND
 * classify.ts's {@link "./classify.js".MAX_TRANSIENT_RETRIES} uses for the
 * unrelated fix-rung attempt loop (independent counters, same "3 retries" policy
 * so the two don't drift apart for no reason).
 */
export const POST_REVIEW_STATUS_MAX_ATTEMPTS = 4;

/** Base delay (ms) for {@link postReviewStatus}'s exponential backoff between
 * retries — attempt N's wait is `POST_REVIEW_STATUS_BASE_DELAY_MS * 2**(N-1)`. */
export const POST_REVIEW_STATUS_BASE_DELAY_MS = 500;

/**
 * Injectable dependencies for {@link postReviewStatus}'s retry-with-backoff —
 * mirrors classify.ts's `DiagnoseThenRetryDeps` DI shape (optional, real
 * defaults; tests override to avoid a real `gh` spawn / real waiting).
 */
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

/** Exported (not just internal) so a unit test can PATH-stub `gh` and drive
 * this exact real invocation directly — the same "temp-dir fake gh on PATH"
 * pattern `realArmDeps` tests already use in run-task.test.ts — rather than
 * only ever exercising it indirectly through {@link postReviewStatus}'s
 * injectable `exec`, which would leave this one-line real wrapper itself
 * permanently uncovered by the diff-coverage ratchet. */
export function execGhStatusPost(args: string[], env: NodeJS.ProcessEnv): void {
  execFileSync("gh", args, { stdio: "pipe", env, encoding: "utf8" });
}

/** The text a thrown `gh`/execFileSync error carries — stderr first (that's
 * where `gh api`'s own "gh: <message> (HTTP <code>)" error lands), falling
 * back to stdout, then the Error's own message. Mirrors the stderr/stdout
 * extraction {@link execWhitelistedProof} already does for the same
 * execFileSync error shape. */
function ghErrorText(e: unknown): string {
  const err = e as NodeJS.ErrnoException & { stderr?: string | Buffer | null; stdout?: string | Buffer | null };
  const asString = (v: string | Buffer | null | undefined) => (typeof v === "string" ? v : (v?.toString("utf8") ?? ""));
  const message = e instanceof Error ? e.message : String(e);
  return [asString(err?.stderr), asString(err?.stdout), message].filter(Boolean).join("\n");
}

/**
 * W1-T135 (LIVE INCIDENT 2026-07-20): this used to be a bare `execFileSync`
 * with no error handling at all — a single transient 503 posting the status
 * threw and crashed run W1-T132-1784508142857 mid-fix-rung, the root cause of
 * escalation #283. Now: a TRANSIENT error ({@link classifyFailure} over the
 * `gh` error text — GitHub 5xx, network blips, rate-limit backpressure; the
 * SAME classifier the fix-rung retry loop uses, so "is this transient" never
 * drifts between the two call sites) is retried with exponential backoff, up
 * to {@link POST_REVIEW_STATUS_MAX_ATTEMPTS} attempts total. A PERMANENT error
 * (a 404/422, or any text `classifyFailure` doesn't recognize as transient —
 * fail-closed, same as classify.ts) is never retried; it throws on the first
 * attempt. Either way, once attempts are exhausted this function THROWS the
 * last error — it has no ledger access of its own, so "ledger-and-continue on
 * exhaustion" is {@link postReviewStatusGuarded}'s job (the sole caller in
 * production): it catches this throw, ledgers `review.post_failed`, and
 * returns `{posted:false}` instead of letting the exception crash the run.
 */
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

// ── W1-T228: the status CHANNEL is last-write-wins across uncoordinated
// posters ────────────────────────────────────────────────────────────────
//
// GROUND TRUTH this hardens (plan/tasks.yaml W1-T228): PR 449 head 833561d
// took SEVEN `remudero-review` writes in one day. An EXECUTED verdict (2/6
// proofs run, FAILED) at 18:02:31 was overwritten by a KEYWORD-ONLY CAPPED
// success (0/6 executed) at 18:10:42 — weaker evidence clobbered stronger
// evidence on an IDENTICAL sha. A THIRD write landed at 18:16:20, ~85s AFTER
// the PR merged at 18:14:55 — the channel accepted a write against a closed
// lifecycle. W1-T230 already took the ARM decision off this channel onto the
// orchestrator's own ledger; this hardens the CHANNEL itself, regardless of
// the arm path, because the posted status is what branch protection reads,
// what the board renders, and what an operator opens a PR to see.
//
// ONE POST SITE enforces FIVE RULES — {@link postReviewStatusGuarded} is the
// only call path `run-task.ts` uses from here on (the raw {@link
// postReviewStatus} above becomes an internal implementation detail + the
// injectable "real poster" in tests):
//   (i)   PRECEDENCE — a keyword-only/CAPPED verdict (no criterion's proof
//         actually EXECUTED) never overwrites an executed-evidence verdict
//         for the SAME sha. Executed may overwrite executed (a later real
//         run supersedes an earlier one) — {@link decideReviewStatusPost}.
//   (ii)  LIFECYCLE — no status writes to a merged or closed PR. Refused,
//         and the refusal is ledgered (never silently dropped).
//   (iii) SERIALIZATION — per task (== per PR; every real caller already
//         keys its `review.posted` ledger lines by task id), via the SAME
//         O_EXCL create-or-fail primitive drain-lock.ts/inflight-lock.ts use
//         ({@link acquireReviewStatusLock}) — adapted from a SINGLETON GUARD
//         (refuse a second concurrent holder) to a MUTEX (wait for the
//         holder, then proceed): the drain/inflight locks guard a whole RUN;
//         this guards one short read-decide-write critical section.
//   (iv)  RESILIENCE (W1-T135) — {@link postReviewStatus} itself retries a
//         TRANSIENT gh error (5xx, network) with backoff; if it still throws
//         (retries exhausted, or a PERMANENT 4xx that was never retried),
//         this guarded site catches it, ledgers `review.post_failed` with
//         the would-be verdict, and returns `{posted:false}` — a status-post
//         hiccup degrades, it never crashes the run (the W1-T113 class,
//         applied here; LIVE INCIDENT: a bare 503 crashed run
//         W1-T132-1784508142857 mid-fix-rung, escalation #283).
//   (v)   SUBJECT FRESHNESS (W1-T2793) — when a caller identifies the exact
//         head+body it judged, the lifecycle read also identifies the CURRENT
//         head+body. A verdict whose input no longer matches is refused rather
//         than overwriting the sha-scoped GitHub status for a different body.
// READ BEFORE WRITE, HONESTLY: precedence needs the CURRENT posted state, so
// {@link postReviewStatusGuarded} reads the ledger and the live PR lifecycle/input
// AFTER acquiring the lock, never before — a read taken before the lock is
// exactly the TOCTOU gap the lock exists to close.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Whether ANY criterion's proof actually EXECUTED on this sha ("executed"),
 * or the verdict rests entirely on the ABSENCE of that evidence
 * ("no_evidence" — keyword-only and CAPPED are both this tier: neither ever
 * observed the repo state). Evidence outranks its absence, one-directionally
 * — see {@link decideReviewStatusPost}.
 */
export type ReviewEvidenceStrength = "executed" | "no_evidence";

export function reviewEvidenceStrength(
  criteria: ReadonlyArray<Pick<CriterionVerdict, "proof_exec">>,
): ReviewEvidenceStrength {
  const executed = criteria.some((c) => c.proof_exec === "executed_pass" || c.proof_exec === "executed_fail");
  return executed ? "executed" : "no_evidence";
}

/**
 * The most recent `review.posted` line's sha/state/evidence for `taskId` —
 * {@link decideReviewStatusPost}'s `prior` argument. Deliberately separate
 * from {@link PriorReviewVerdict} (the W1-T178/W1-T230 shape): those
 * consumers never needed evidence strength, and giving this task its own
 * type keeps their contracts untouched. Same "last one wins" scan idiom as
 * {@link priorReviewVerdictFromLedger} and `unmetFromLedger` (run-task.ts) —
 * `evidence` is derived from the SAME `proof_exec` array `run-task.ts`
 * already ledgers on every `review.posted` line (no new ledger field).
 */
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

/**
 * W1-T913 — THE OWNERSHIP RECORD design (b) requires: a `remudero-review=pending` post is
 * distinguishable from "reviewed", and traceable to the run that posted it, via a `ts`-stamped
 * ledger line ({@link postReviewPending} writes `review.pending_posted`) — deliberately a
 * DIFFERENT step than `review.posted` (which {@link lastPostedReviewStatusFromLedger} scans and
 * which never carries a non-terminal `state`), so a pending post can never be mistaken for a
 * terminal verdict by that function's own W1-T228 precedence read. `runId`/`postedAt` are what
 * `sweep.ts`'s stuck-pending remedy needs: a pending whose owner is long gone (or simply old) must
 * remain something the sweep can re-drive rather than read as "already attended to" forever.
 */
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

/**
 * Classify a pending review's durable owner identity without inventing certainty. The shared
 * {@link isHolderStale} predicate owns PID reuse, container replacement and boot-time semantics;
 * this adapter only rejects incomplete records and distinguishes a same-host non-stale result
 * from a foreign holder that this process cannot prove active or dead.
 */
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

/**
 * The CURRENT PR lifecycle {@link decideReviewStatusPost}'s LIFECYCLE rule
 * checks against — fetched FRESH (never a snapshot from before ci/the
 * reviewer spawn ran) by {@link postReviewStatusGuarded}.
 */
export interface PrLifecycleState {
  merged: boolean;
  closed: boolean;
  /** Content address of the live head+body returned by the SAME single-PR REST read. Optional
   *  only for legacy/injected callers that can observe lifecycle but not the review subject. */
  reviewInputDigest?: string;
}

/**
 * ANCHORED ON `/pull/<n>`, mirroring `run-task.ts`'s own `prUrlTarget` — duplicated locally
 * rather than imported because `run-task.ts` imports FROM `./review.js` (this module), so an
 * import the other way would be circular. Returns `undefined` — never a guess — on anything
 * that is not a PR URL.
 */
function prLifecycleUrlTarget(prUrl: string): { owner: string; repo: string; number: number } | undefined {
  const m = /^https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(prUrl.trim());
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : undefined;
}

/**
 * W1-T522: real fetcher, now REST (`GET /repos/{o}/{r}/pulls/{n}`), never `gh pr view --json
 * state` (GraphQL) — {@link postReviewStatusGuarded}'s default; tests inject a fake `fetch`
 * instead of a fake `fetchLifecycle` closure, mirroring `ghLiveState`'s (run-task.ts, W1-T511)
 * own shape.
 *
 * THE FAILING SITE IS NOT THE ONE ANYBODY NAMED: this is the ONLY `gh pr view <url> --json
 * state` call in the fleet's review-posting path (the other GraphQL `state` reader,
 * `ghLiveStateByNumber`, takes a number+repo, not a URL — see run-task.ts), and it was the one
 * actually observed failing with `GraphQL: API rate limit already exceeded` on 2026-08-15.
 *
 * Reuses {@link prStateFromRest} — the SAME REST fold `liveStateFromRest` composes — so
 * REST's two-valued `state`/`merged` fold is still decided in exactly one place. THE TWO-VALUED FOLD
 * IS BENIGN HERE: a naive `.state`-only read would mislabel a MERGED PR as merely `closed`, but
 * `decideReviewStatusPost` (below) refuses posting on merged OR closed alike, so folding merged
 * into `MERGED` (rather than leaving it `CLOSED`) changes no caller-visible decision here — see
 * `prStateFromRest`'s own doc (open-prs-rest.ts) for why the same fold is NOT survivable at
 * `terminalStateReason` (sweep.ts), which this function does not touch.
 */
export function fetchPrLifecycle(prUrl: string, fetch: GhApiFetcher = ghJson): PrLifecycleState {
  const target = prLifecycleUrlTarget(prUrl);
  if (!target) {
    throw new Error(
      `fetchPrLifecycle: cannot resolve owner/repo/number from ${JSON.stringify(prUrl)} — refusing to fall ` +
        "back to `gh pr view --json state`, whose GraphQL budget exhaustion is the defect this read was moved off",
    );
  }
  // W1-T2793: retain the head+body identity from this SAME response before folding lifecycle.
  // This adds no GitHub call and stores/logs neither body nor transcript. The optional spread
  // keeps malformed/legacy fixtures on their historical lifecycle-only contract; the real
  // single-PR response carries both fields.
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
//
// GROUND TRUTH: the `remudero-review` commit status (above) is last-write-wins — a head carries
// exactly one context regardless of how many times it is rewritten, so a repeat write is cheap
// and this task leaves it untouched. A `gh pr comment` APPENDS. #3140 accumulated TEN
// byte-identical failure comments across ten consecutive sweep passes (21:06:02–21:18:57, one
// unmoved head) because nothing anywhere compared the verdict about to be written against the one
// already standing: `reviewPostRefusedFor` (run-task.ts) keys only on `review.post_refused`, on
// the stated assumption that a DELIVERED post always flips the live rollup away from a
// re-postable state — true for the status row {@link decideReviewStatusPost} reads, silent about
// the comment thread itself.
//
// The fix is ONE comparison at the single site that writes the comment
// ({@link postReviewCommentGuarded}, `runReview`'s only call path in run-task.ts from here on):
// refuse to append when the body about to be written is BYTE-IDENTICAL to the newest comment
// already standing on that PR. NO ledger, NO timer/pacing/backoff (the W1-T1066 polling-lockout
// class this task's rationale explicitly refuses) — the discriminator is the verdict's own bytes
// against a FRESH read of GitHub's live state on every call, exactly like the status row's own
// lifecycle re-read above. Nothing here suppresses the status write, and nothing here changes
// disposition/arm/cap logic — the sweep's `post-review` admission row stays exactly as it is
// because it is correct (this task's own rationale, Q1).
// ────────────────────────────────────────────────────────────────────────────

/** One comment {@link fetchNewestPrComment} reads back off GitHub — only the two fields the
 * byte-compare below needs. */
export interface PrCommentRecord {
  body: string;
  created_at: string;
}

/**
 * The NEWEST comment on `prUrl` by `created_at`, or `undefined` when the PR has no comments yet or
 * its owner/repo/number can't be parsed (defensive — not reachable from a real PR URL). REST only
 * (`GET repos/{o}/{r}/issues/{number}/comments`), never `gh pr view --json comments` (GraphQL) —
 * same reasoning as {@link fetchPrLifecycle}, reusing its {@link prLifecycleUrlTarget} parse.
 * `per_page=100` with no further pagination, the same single-page simplification this module's
 * other single-PR REST readers already make (e.g. {@link fetchPrLifecycle}) — a PR carrying over
 * 100 comments is not a shape this fleet's own review flow produces.
 */
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

/**
 * THE comparison this task's rationale (Q1) found nowhere in `src/`: "NOTHING COMPARES THE NEW
 * VERDICT AGAINST THE STANDING ONE." This is that comparison, and the only place it happens.
 * Byte-exact, never fuzzy/trimmed/hashed — a verdict that changed by even one byte (a different
 * unmet-criteria ordinal, an added rubric line) is a DIFFERENT verdict and must still post. This
 * is the same distinction the shard's ledger measurement drew between PR #3140 (an unmoved head,
 * exit unchanged across ten posts — a real repeat) and PR #2434 (18 posts on one head, but exits
 * `[0, 1]` — a genuinely changed verdict, correctly excluded from the repeat count).
 */
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

/**
 * THE ONE POST SITE for a review-verdict PR comment (W1-T2419) — `runReview`'s (run-task.ts) only
 * call path from here on, replacing the old bare `execFileSync("gh", ["pr", "comment", ...])`.
 * Refuses to append (`{posted: false, reason: "duplicate"}`) when `body` is byte-identical to the
 * newest comment already standing on `prUrl`, per {@link isDuplicateReviewComment} — the fix this
 * task makes. Every other case posts exactly as the old call did, including its best-effort
 * failure contract: a `gh` error (fetching the standing comment OR posting the new one) is
 * swallowed rather than thrown — the status + ledger already carry the verdict, so a comment
 * hiccup must never crash the run, same as before this task.
 */
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

/**
 * THE PURE W1-T228 GATE — the falsifier this task exists to prove is a unit
 * fixture, exactly like {@link judgeReview}/{@link decideArmFromLedgerVerdict}.
 * Order matters: LIFECYCLE is checked FIRST — a merged/closed PR refuses
 * regardless of precedence, since arguing about which verdict is "stronger"
 * on a PR nobody can act on anymore is moot.
 */
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

/**
 * Acquire the per-task review-status MUTEX — the SAME O_EXCL create-or-fail
 * primitive {@link import("./drain-lock.js").acquireDrainLock}/{@link
 * import("./inflight-lock.js").acquireInflightLock} use (creation is atomic,
 * so two racing acquirers hitting the create fresh cannot both win it; a stale
 * lock — holder pid dead, or the file unreadable/garbage — is reclaimed via
 * {@link reclaimStaleLock}, whose delete is conditioned on the lock's on-disk
 * identity, so two reclaimers of the SAME dead lock cannot both come away
 * believing they hold it either, W1-T289), adapted from a SINGLETON GUARD to a
 * MUTEX: where those THROW immediately when a live holder is found, this
 * WAITS (bounded by `timeoutMs`) and retries — the callers here are N
 * uncoordinated posters that must all eventually run their own
 * read-decide-write, never a second run of the same long-lived task that
 * should simply refuse to start.
 */
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
  /**
   * Fresh lifecycle read for THIS attempt — real callers pass
   * `() => fetchPrLifecycle(prUrl)`; tests inject a fake. Called INSIDE the
   * lock, never before (see the module doc comment above).
   */
  fetchLifecycle: () => PrLifecycleState;
  /** Injected raw poster (tests). Defaults to {@link postReviewStatus} (which
   * already retries a TRANSIENT gh error internally — see the module doc
   * comment's rule (iv)). May return a Promise (the default does) or `void`
   * (existing sync test fakes keep working unchanged). */
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

/**
 * THE single call path for posting `remudero-review` from here on (W1-T228).
 * Acquires the per-task lock, reads the ledger + live PR lifecycle FRESH
 * (inside the lock — read-before-write, honestly racy without it), decides
 * via the pure {@link decideReviewStatusPost}, and either posts (delegating
 * to the raw {@link postReviewStatus}) or refuses — EVERY attempt is
 * ledgered, including refusals (`review.post_refused`), so a refused write
 * leaves a trace instead of the same silent blindness this task fixes.
 *
 * W1-T135: a post that still THROWS (transient retries exhausted inside
 * {@link postReviewStatus}, or a permanent error it never retried) is caught
 * HERE, never left to propagate — it is ledgered as `review.post_failed`
 * (carrying the verdict that could not be posted) and this function returns
 * `{posted:false}` like an ordinary refusal, so every caller's existing
 * `if (!posted.posted) { ... }` handling already degrades gracefully instead
 * of the whole run crashing (the LIVE INCIDENT this task exists to fix).
 */
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

/**
 * THE ONE PENDING-POST ENTRY POINT (design (a)/(d)) — every detector (`runReview`'s own start,
 * `reviewCommand`'s own start, and transitively the sweep's post-review dispatch, which calls
 * `reviewCommand`) calls this ONCE, at DETECTION, before the worktree/proof/reviewer-spawn work a
 * review's own latency is spent on. Goes through {@link postReviewStatusGuarded} — the SAME single
 * guarded post site the terminal verdict uses — never a second raw `gh api .../statuses/...` call,
 * so the W1-T135 retry, W1-T228 lifecycle refusal and W1-T203 reviewer identity all still apply to
 * a pending post exactly as they do to a terminal one.
 *
 * TWO REFUSALS, BOTH DECIDED HERE (before ever touching the lock/network), NEITHER a decision
 * {@link postReviewStatusGuarded}'s own precedence rule can make on its own:
 *
 *   1. NEVER REGRESS A TERMINAL VERDICT FOR THE SAME REVIEW INPUT TO PENDING. {@link decideReviewStatusPost}'s precedence
 *      rule only refuses `executed -> no_evidence` on the SAME head; a pending attempt is always
 *      `no_evidence`, so a prior `no_evidence` TERMINAL verdict (a keyword-only/CAPPED success or
 *      failure) for this exact head would sail through that rule and get overwritten by a pending
 *      — a real posted verdict regressing to "in progress" on the SAME sha it already judged. This
 *      function refuses that itself when head+body identity matches. A changed body on the same
 *      head is a fresh input and may post pending again.
 *   2. IDEMPOTENT PER INPUT: a `review.pending_posted` line already recorded for this exact
 *      head+body digest is a no-op, regardless of which run owns it. A dead owner's stuck pending is re-driven by the sweep recognizing the pending is
 *      stale (see `sweep.ts`'s `reviewPendingIsStale`/the extended post-review disposition row),
 *      never by this function racing a second pending post against the first.
 *
 * The posted status carries the posting `run_id` in its description (design (c)'s traceability
 * handle) AND on the `review.pending_posted` ledger line this function writes on a successful
 * post — the SAME line {@link lastPendingReviewStatusFromLedger} reads back, and the one
 * `sweep.ts`'s `OpenPrView.reviewPendingSince` producer (`buildOpenPrViews`, run-task.ts) derives
 * its staleness clock from.
 */
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
