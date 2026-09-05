import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { diagnoseBodyDefects } from "./body-repair.js";
import { appendLedger } from "./ledger.js";
import { readLedgerLines, readMergeCreditedTaskIds, taskIdFromRunBranch } from "./status.js";
import { installPolicyPath, loadDefaultPolicy, PolicyError } from "./policy.js";
import { loadDefaultCostAnomalyPolicy, recordCostAnomalies, type CostAnomalyPolicy } from "./cost-anomaly.js";
import {
  automergeHoldFromLedger,
  cappedOverrideFromLedger,
  decideAutoMergeArm,
  postedArmFactsFromLedger,
  REVIEW_CONTEXT,
} from "./review.js";
import type { ArmDecision, AutomergeHold, CriterionVerdict } from "./review.js";
import type { QuestionEntry } from "./worker.js";
import {
  FLEET_NOTICE_LABEL,
  NEEDS_HUMAN_LABEL,
  type AskType,
  type EscalationClass,
  type IssueGateway,
  type OpenIssue,
} from "./escalate.js";
import { GhPaceFloorStandDownError } from "./open-prs-rest.js";
// W1-T2384: the supersession types moved to a leaf that imports NOTHING, so open-prs-rest.ts
// can declare the producer without closing the type cycle this module's VALUE import above
// would otherwise complete — see supersession.ts's own header for the measured before/after.
// Re-exported below so every existing `from "…/sweep.js"` call site keeps working untouched.
import type {
  SupersessionDiffFinding,
  SupersessionEvidence,
  SupersessionStatus,
  SupersessionVerdict,
} from "./supersession.js";
export type { SupersessionDiffFinding, SupersessionEvidence, SupersessionStatus, SupersessionVerdict };
import type { ConflictFileDiff, MergeConflictEvidence, MergeState } from "./merge-state.js";
import type { WorkflowRunObservation } from "./workflow-run.js";
import type { ReviewCapacityPolicy } from "./review-capacity.js";
// Re-exported so existing `import type { … } from "./sweep.js"` call sites keep working.
export type { ConflictFileDiff, MergeConflictEvidence, MergeState } from "./merge-state.js";
// W1-T2340: declared in a leaf module so `open-prs-rest.ts`'s producer can import it without
// closing an open-prs-rest <-> sweep cycle — see workflow-run.ts's own doc.
export type { WorkflowRunObservation } from "./workflow-run.js";

// Why: the pipeline was edge-triggered, so a verdict fired once and a missing consumer stranded
// the PR open-and-orphaned (#111/#113/#123) — docs/forensics/sweep.md.
/**
 * lib/sweep.ts — the level-triggered PR-pipeline reconciler (W1-T77, ratifies P22 core).
 *
 * Every daemon poll and every `rmd sweep` re-derives each open PR's disposition fresh from
 * observed state, then takes the one gated action. The predicate is a pure function of observed
 * state and the exported {@link SweepPolicy} table (rule 2) — never an LLM judgment, never a
 * literal in a branch. Each PR gets exactly one {@link Disposition}; {@link DISPOSITION_RULES}
 * carries the rows and each row's own doc states its trap.
 *
 * HUNG WORKERS ARE OUT OF SCOPE: worker liveness is run-state, not PR-state.
 *
 * Invariants:
 *   - {@link deriveDisposition} is TOTAL — no open PR ends a sweep with disposition=none.
 *   - Idempotence: dispositions re-derive every pass, but actions dedup against the shared
 *     ledger, so an unchanged pass dispatches nothing. Fix dispatch is also keyed on the head
 *     sha, so a new push re-earns a strike up to the cap.
 *   - Every disposition writes one `sweep.disposed` ledger line.
 *   - Repetition is signalled, never cached: a repeated (disposition, head_sha) pair escalates
 *     ONCE at {@link SweepPolicy.repeatDispositionBound} (W1-T2345).
 *   - Every external effect is injected; this module never calls gh, git or the network.
 */

/** One of the dispositions every open PR is reconciled into. */
export type Disposition =
  | "mergeable"
  | "blocked-fixable"
  | "stale"
  | "blocked-ambiguous"
  | "dep-review"
  | "post-review"
  | "conflicted"
  | "wait";

/**
 * W1-T920 — a THREE-VALUED finding: "unreadable" is never collapsed into "unique".
 *   - `"superseded"` — evidence REQUIRED ({@link SupersessionEvidence}); the bare label is
 *     unauditable. The ONLY value that may gate a CLOSE.
 *   - `"unique"` — a POSITIVE "checked, none found", not a default. W1-T932 lets a row read it
 *     to make a bare-number `supersededBy` match YIELD, never to close anything.
 *   - `"indeterminate"` — the read failed. NEVER acts on any disposition.
 */

/**
 * W1-T920 — the diff finding carries its OWN corpus control. A zero-hunk read is
 * indistinguishable from a broken read on the hunk count alone, so `rawLineCount` is the
 * control: a verdict built from a zero-length raw read must never claim `"superseded"`.
 * // Why: the #1955 hand-diagnosis measured that shape — docs/forensics/sweep.md.
 */

/**
 * W1-T920 (design note v) — the evidence a `"superseded"` verdict NAMES, never a bare label.
 * This is what made the #1955 diagnosis checkable in one read: the superseding PR number, the
 * shared task id, and the diff finding with its own control, together in one place.
 */

/**
 * W1-T920 — one open PR's supersession finding, READ and never computed by the disposition.
 * Scope note: the DETECTOR that populates this is a separate, out-of-scope shard. This type and
 * the row reading it are the full wired mechanism, but nothing in the real gateway sets one yet.
 */

/**
 * One failing required CI check's name + the tail of its log — the W1-T94
 * ci-log fix mode's ONLY input. Defined HERE (not in run-task.ts, which
 * imports it) because {@link OpenPrView} carries it and run-task.ts already
 * imports OpenPrView from this module — the reverse import would be circular.
 */
export interface CiFailure {
  name: string;
  logTail: string;
  /**
   * The commit sha this failure is attributable to, when the read can identify one (W1-T186).
   * `undefined` in the ordinary case, where the check failed against the PR's own head.
   * // Why: commitlint lints the whole base..head RANGE, so a required check can be tripped by a
   * // commit that is not the PR's own (#420) — docs/forensics/sweep.md.
   */
  sha?: string;
  /**
   * `true` when `sha` is OBSERVED to be outside this PR's own commit range — the #420 shape.
   * `undefined`/`false` otherwise, including when it is simply unknown: NEVER asserted without
   * positive evidence (fail toward "assume it's the PR's own", never invent an exoneration the
   * read cannot support).
   */
  outsidePrRange?: boolean;
  /**
   * WHY {@link logTail} is empty, when it is. Present ONLY when it is empty and a cause was
   * observed, ABSENT whenever a tail was captured — so `logUnavailable !== undefined` is a sound
   * test for "the log could not be read" and never fires on a real tail.
   * // Why: every way of failing used to collapse into one empty tail (W1-T2291).
   */
  logUnavailable?: CiLogUnavailableCause;
  /**
   * WHICH SOURCE filled {@link logTail}. `"annotations"` is the fallback, used ONLY when the log
   * read came back empty or failed, so a readable log can never be displaced by it. ABSENT
   * whenever `logTail` is empty — the exact condition under which {@link logUnavailable} is
   * present. The two are complements, never both meaningful at once.
   */
  tailSource?: CiTailSource;
  /**
   * WHAT THE ANNOTATION FALLBACK DID, when reached — absent entirely when the log answered.
   * // Why: kept separate from {@link logUnavailable} on purpose, because a fallback that
   * // overwrote the named cause would take back the answer W1-T2291 gave.
   */
  annotationFallback?: CiAnnotationFallback;
}

/**
 * W1-T2671/W1-T2789 — the two independently-observed facts required before a red branch may be
 * refreshed from its base. Optional fields are an honest unreadable result, never zero/empty.
 */
export interface RedBaseRefreshFacts {
  behindBy?: number;
  baseChangedFiles?: string[];
}

export interface RedBaseRefreshDecision {
  refresh: boolean;
  behindBy?: number;
  failingTestFiles: string[];
  failingSourceFiles: string[];
  matchingBaseFiles: string[];
}

// Locate the distinctive suffix with no nested repetition, then recover its ordinary path prefix
// by walking left. Keeping prefix discovery out of the regexp makes runtime linear even when a
// hostile or corrupted CI log contains thousands of path-like delimiters.
const CI_TEST_PATH_SUFFIX = /\b(?:test|tests|__tests__)[\\/][A-Za-z0-9._@%+~\\/-]+\.(?:[cm]?[jt]sx?)/gi;
const CI_PATH_PREFIX_CHAR = /[A-Za-z0-9._:@%+~\\/-]/;

/** Extract only test-file paths from the CI evidence the fix rung receives. */
export function failingTestFilesFromCiFailures(failures: readonly CiFailure[]): string[] {
  const paths = new Set<string>();
  for (const failure of failures) {
    for (const text of [failure.name, failure.logTail]) {
      for (const match of text.matchAll(CI_TEST_PATH_SUFFIX)) {
        let start = match.index;
        while (start > 0 && CI_PATH_PREFIX_CHAR.test(text[start - 1])) start--;
        const end = match.index + match[0].length;
        paths.add(text.slice(start, end).replace(/^file:\/\//, "").replaceAll("\\", "/"));
      }
    }
  }
  return [...paths];
}

/** Extract source paths only from the existing, distinctive diff-coverage report. */
export function failingSourceFilesFromCiFailures(failures: readonly CiFailure[]): string[] {
  const report = diffCoverageReport(failures);
  if (!report) return [];
  return [...new Set(report.uncovered.map((pathLine) => pathLine.replace(/:\d+$/, "").replaceAll("\\", "/")))];
}

/** Exact repository path, or that complete path below an observed checkout prefix. */
function observedPathMatchesRepositoryPath(observedPath: string, repositoryPath: string): boolean {
  return observedPath === repositoryPath || observedPath.endsWith(`/${repositoryPath}`);
}

/**
 * W1-T2671/W1-T2789 — the ONE pure exact-path decision shared by the fix rung and sweep-level
 * pre-exhaustion release. Neither caller may reinterpret a weak behind/path signal differently.
 */
export function decideRedBaseRefresh(
  failures: readonly CiFailure[],
  facts: RedBaseRefreshFacts,
): RedBaseRefreshDecision {
  const failingTestFiles = failingTestFilesFromCiFailures(failures);
  const failingSourceFiles = failingSourceFilesFromCiFailures(failures);
  const baseChangedFiles = facts.baseChangedFiles;
  const matchingBaseFiles =
    facts.behindBy !== undefined && facts.behindBy > 0 && baseChangedFiles !== undefined
      ? baseChangedFiles.filter((baseFile) =>
          [...failingTestFiles, ...failingSourceFiles].some((failureFile) =>
            observedPathMatchesRepositoryPath(failureFile, baseFile),
          ),
        )
      : [];
  return {
    refresh: matchingBaseFiles.length > 0,
    behindBy: facts.behindBy,
    failingTestFiles,
    failingSourceFiles,
    matchingBaseFiles,
  };
}

/** The sources {@link CiFailure.logTail} can come from, in preference order. */
export type CiTailSource = "log" | "annotations";

/** The outcome of the annotation fallback, recorded rather than folded into the log's own cause. */
export type CiAnnotationFallback =
  | { outcome: "recovered" }
  | { outcome: "empty" }
  | { outcome: "failed"; detail: string };

/**
 * The closed set of reasons a log tail came back empty — a NAMED outcome, never an absence.
 * `no-job-id`: no Actions job id, so no read was attempted. `fetch-failed`: a read was attempted
 * and failed, `detail` carrying the error as observed. `empty-log`: the read SUCCEEDED and the
 * job printed nothing.
 */
/**
 * BACKSTOP on a `fetch-failed` detail's length, not a primary control — what the fix prompt
 * renders is. Set far above any observed message, so truncating is evidence of something unusual.
 */
export const MAX_CI_LOG_FAILURE_DETAIL = 500;

export type CiLogUnavailableCause =
  | { kind: "no-job-id" }
  | { kind: "fetch-failed"; detail: string }
  | { kind: "empty-log" };

/**
 * One sentence naming why a log tail is missing, for BOTH consumers — the fix prompt in
 * run-task.ts and this module's own escalation text — so the two can never drift into describing
 * the same cause differently. No branch can be mistaken for a check that simply printed nothing,
 * except the one branch that means exactly that.
 */
export function describeCiLogUnavailable(cause: CiLogUnavailableCause): string {
  switch (cause.kind) {
    case "no-job-id":
      return "log NOT read: this check reported no Actions job id, so no log fetch was attempted";
    case "fetch-failed":
      return `log NOT read: the log fetch was attempted and FAILED (${cause.detail})`;
    case "empty-log":
      return "log read successfully, but the job printed no failing output";
  }
}

/**
 * PURE, DETERMINISTIC classification (rule 2) of whether a conflict is safe to auto-resolve
 * toward the union of both sides: every conflicting file must show ZERO deletions on BOTH sides
 * since the merge-base. A single deletion on either side — or no file evidence at all — fails
 * CLOSED to `false`. A wrong auto-resolution is worse than a strand (design note iii).
 */
export function isPureConcurrentAddition(files: readonly ConflictFileDiff[]): boolean {
  return files.length > 0 && files.every((f) => f.oursDeleted === 0 && f.theirsDeleted === 0);
}

/**
 * W1-T2548 — THE DECLARED GENERATOR REGISTRY. For a path this table names, re-running the
 * generator on the MERGED tree is correct by construction, so the resolution is not a merge at
 * all. A path absent from the table stays refused: admission is bounded by a list a human wrote,
 * never an inference. Each value is the `package.json` script name — DATA (rule 2).
 * // Why: every conflict this repo has produced is a same-key VALUE change — docs/forensics/sweep.md.
 */
export const REGENERABLE_ARTIFACT_GENERATORS: Readonly<Record<string, string>> = Object.freeze({
  "scripts/source-size-baseline.json": "source-size-ratchet",
  "plan/plan-index.json": "plan-index",
  "docs/docs-index.json": "docs-index",
  "learnings/index.json": "learnings-index",
  "docs/cli-reference.md": "cli-reference",
  "MASTER-PLAN.md": "capability-snapshot",
  "packages/api-client/src/schema.d.ts": "api-client:generate",
});

/**
 * W1-T2548 — PURE, DETERMINISTIC classification (rule 2) of whether EVERY conflicting path carries
 * a declared generator, admitted alongside and never instead of {@link isPureConcurrentAddition}.
 * Requires ALL files registered: a conflict straddling a hand-written path is refused WHOLE.
 * Deletions are irrelevant here — the generator re-run supersedes both recorded values regardless.
 */
export function isRegenerableArtifactConflict(
  files: readonly ConflictFileDiff[],
  generators: Readonly<Record<string, string>> = REGENERABLE_ARTIFACT_GENERATORS,
): boolean {
  return files.length > 0 && files.every((f) => Object.hasOwn(generators, f.path));
}

/** W1-T2548 — the conflicting path(s), if any, this table declares no generator for — the
 *  diagnosability half of acceptance 5: a refusal names WHICH path broke admission rather than
 *  making a reader re-derive it from the registry by hand. */
function undeclaredGeneratorPaths(
  files: readonly ConflictFileDiff[],
  generators: Readonly<Record<string, string>>,
): string[] {
  return files.filter((f) => !Object.hasOwn(generators, f.path)).map((f) => f.path);
}

/**
 * W1-T2536/W1-T2548 — WHICH refusal disjunct actually fired, as a phrase for the row's `reason`:
 * a deletion, no captured evidence, admission disabled, or the MIXED case whose paths straddle
 * {@link REGENERABLE_ARTIFACT_GENERATORS}. The disabled arm is unreachable at the shipped default
 * and written anyway, because the flag is policy DATA an operator may set false.
 * // Why: the row once said "involves a deletion" unconditionally — docs/forensics/sweep.md.
 */
export function conflictRefusalCause(
  files: readonly ConflictFileDiff[],
  policy: Pick<SweepPolicy, "mergeConflictAdmissionEnabled">,
  generators: Readonly<Record<string, string>> = REGENERABLE_ARTIFACT_GENERATORS,
): string {
  if (files.length === 0) return "no file evidence was captured";
  if (files.some((f) => f.oursDeleted > 0 || f.theirsDeleted > 0)) {
    const undeclared = undeclaredGeneratorPaths(files, generators);
    // Name the offending path(s) only when the conflict STRADDLES the registry. Where no path is
    // declared — the dominant hand-written-source shape — the plain "involves a deletion" stands,
    // because naming the registry's absence would tell the reader nothing new (W1-T2548).
    if (undeclared.length > 0 && undeclared.length < files.length) {
      return `involves a deletion, and ${undeclared.join(", ")} ${undeclared.length === 1 ? "has" : "have"} no declared generator`;
    }
    return "involves a deletion";
  }
  if (policy.mergeConflictAdmissionEnabled !== true) {
    return "auto-resolution admission is disabled (mergeConflictAdmissionEnabled)";
  }
  return "not classifiable as a pure concurrent addition";
}

/**
 * W1-T78 policy (rule 2) — how many strikes a fix-rung RE-DISPATCH gets once an operator answers
 * a clarification question. Nested inside {@link SweepPolicy}, the same config object every
 * `runSweep` caller already threads, rather than a second separately-sourced policy object.
 */
export interface ClarifyPolicy {
  /** true (default): the answer resets the counter to a FRESH strikeCap. false: exactly one bounded extra strike. */
  resetStrikeCounterOnAnswer: boolean;
}

/** The default clarify policy — an answer earns a fresh full strikeCap. */
export const DEFAULT_CLARIFY_POLICY: ClarifyPolicy = { resetStrikeCounterOnAnswer: true };

/**
 * Tunable thresholds as DATA (rule 2) — never inlined constants in the predicate.
 * A test overrides these to prove policy is data (acceptance 3): tightening
 * `staleDays` flips a fixture PR's disposition with zero sweep-code changes.
 */
export interface SweepPolicy {
  /** No activity in >= this many days ⇒ the PR is abandoned -> close. */
  staleDays: number;
  /** Max fix-rung strikes before a failing review escalates instead of fixing. */
  strikeCap: number;
  /** W1-T78: re-dispatch strike-cap policy once an operator answers a clarification question. */
  clarify: ClarifyPolicy;
  /**
   * W1-T121 QUEUE GOVERNOR — a WIP limit on DISPATCH ONLY: at or above this many open PRs, new
   * dispatch is deferred. Drainage (sweep/heal/arm/merge, at any depth) is never gated.
   * See {@link checkQueueGovernor}, this row's consumer.
   * // Why: the 23-open-PR incident. Detail in docs/forensics/sweep.md.
   */
  wipLimit: number;
  /**
   * W1-T172 (P19) — concurrent dispatch LANES a drain pass may fill, bounded by {@link wipLimit}:
   * the governor is the CEILING, lanes only raise the rate it fills. Sourced from
   * `plan/policy.yaml`, so retuning is a data edit.
   * // Why: this also bounded the REVIEW lane until W1-T1049 split it out, which pinned drainage
   * // to a dispatch-only ruling and let two ceilings add — docs/forensics/sweep.md.
   */
  dispatchLanes: number;
  /**
   * W1-T1049 — THE REVIEW LANE'S OWN CONCURRENCY BUDGET. Floored at 1 in `runSweep`, so a
   * misconfigured 0 can never mean "review nothing". A CEILING, NEVER A TARGET: it bounds only
   * the reviews a pass already found eligible. Read directly off `plan/policy.yaml`.
   * // Why: this used to be a second read of {@link dispatchLanes}, and the two ceilings added to
   * // 6 workers on a host that fits about 4 — docs/forensics/sweep.md.
   */
  reviewLanes: number;
  /** Existing policy-row bounds plus the adaptive host/provider feedback thresholds. */
  reviewLaneMin: number;
  reviewLaneMax: number;
  reviewCapacity: ReviewCapacityPolicy;
  /**
   * W1-T148 COST GOVERNOR — a DAILY spend ceiling on DISPATCH ONLY. Drainage is never gated by it:
   * stranding in-flight work to save money is a worse failure than the spend. Distinct from the
   * PER-RUN cap — this is the cross-run daily total that cap cannot see.
   * // Why: the $206/60-run spin loop, 60 runs each under their own per-run cap.
   */
  dailyCostCeilingUsd: number;
  /**
   * W1-T1038 — a DAILY-GOVERNOR TWIN of {@link dailyCostCeilingUsd}: same dispatch-only shape, but
   * the OPPOSITE fail direction on an unreadable observation, enforced at the composition point.
   * SHIPS AT 0 — inert until an operator raises it against a measured figure that does not exist yet.
   */
  memoryFloorMib: number;
  /**
   * W1-T114 — the STALENESS CEILING for the WAIT disposition: pending inside it means wait, at or
   * beyond it the escalate path. A fixture proves this is data by lowering it and flipping a wait
   * with zero code changes. Generous enough for the slowest required check to settle; a check
   * still pending past that IS ambiguity, not merely in-flight.
   */
  pendingCeilingMinutes: number;
  /**
   * How long an otherwise-mergeable PR may sit with a COMPLETELY EMPTY check rollup before the
   * ABSENT-check-suite remedy fires. This is the ABSENT-vs-PENDING discriminator's time half —
   * see {@link absentChecksRepushDecision} for why a time bound is required at all.
   */
  absentCeilingMinutes: number;
  /**
   * Retry threshold for ONE UNCHANGED review input — not a lifetime budget over historical heads.
   * Only completed judgments for the exact PR URL + head + body digest count; a new commit or body
   * edit resets it to zero, and refusals never consume it.
   * // Why: W1-T1018 — reaching the cap no longer stops re-dispatch, because a bound firing on a
   * // HEALTHY condition walled good PRs off forever. See {@link reviewOrphanBackoffMinutes}.
   */
  reviewOrphanCap: number;
  /**
   * W1-T1018 — THE ELAPSED-TIME BACKOFF that replaced permanent cessation: once an unchanged input
   * reaches the cap the sweep still escalates, but the lane resumes after this long. KEYED TO
   * ELAPSED TIME, NEVER ATTEMPT COUNT — a delay keyed to attempts is a budget with pauses, which
   * exhausts monotonically and still ends in permanent silence.
   */
  reviewOrphanBackoffMinutes: number;
  /**
   * W1-T905 — "repair the instance, FILE THE CLASS". A classified surface that at least this many
   * DISTINCT PRs have been repaired for inside {@link repairFilingWindowDays} is due for exactly
   * one `repair#<surface>` §7B entry. One occurrence is a repair, a recurrence is a defect — so
   * the row's own `plan/policy.yaml` bound (min 2) forecloses filing on the first repair.
   */
  repairFilingThreshold: number;
  /** W1-T905 — the RECURRENCE WINDOW (days) {@link repairFilingThreshold} counts distinct-PR
   *  repairs within. See {@link dueRepairFilings}. */
  repairFilingWindowDays: number;
  /**
   * W1-T920 — gates the SUPERSESSION row in {@link DISPOSITION_RULES}. `false` (the default)
   * means `supersessionVerdict` is never consulted and the row never matches, byte-for-byte
   * today's behaviour. `true` lets a `"superseded"` verdict — never a bare "unique" or
   * "indeterminate", never the PR's own resemblance to another — close the PR.
   */
  supersessionDisposalEnabled: boolean;
  /**
   * W1-T932 — gates whether a `"unique"` verdict lets the BARE-NUMBER `stale` row YIELD, so a
   * concept PR is not disposed stale merely because a higher-numbered sibling is open. Reads ONLY
   * `status === "unique"` and FAILS CLOSED; `false` preserves today's behaviour byte-for-byte.
   * // Why: a SEPARATE flag from {@link supersessionDisposalEnabled} — the blast radii differ.
   */
  conceptCoexistenceEnabled: boolean;
  /**
   * W1-T984/W1-T2536 — GATES THE `conflicted` ROW. Shipped OFF awaiting a semantic predicate;
   * turned ON because that predicate cannot live here — GitHub's COMPARE API never carries a
   * HUNK, so only the dispatched fix worker, which merges in a worktree, can decide disjointness.
   *
   * WHAT MAKES ADMITTING SAFE IS THE FENCE DOWNSTREAM, NOT THE PREDICATE UPSTREAM: a wrong
   * resolution mints a NEW HEAD, and `remudero-review` is a required per-sha status, so the worst
   * case is a red PR that escalates. "A wrong auto-resolution is worse than a strand" stays
   * enforced — by the gate, which can SEE the resolution. // Why: docs/forensics/sweep.md.
   */
  mergeConflictAdmissionEnabled: boolean;
  /**
   * W1-T2345 — THE UNBOUNDED-IDENTICAL-DISPOSITION BOUND: a repeated (disposition, head_sha) pair
   * escalates once at this many consecutive rows. See {@link repeatDispositionStreaksFromLedger}
   * for why the key excludes the rendered `reason`.
   *
   * ONCE PER HEAD PER ROTATION WINDOW, NOT ONCE PER HEAD (W1-T2382): rotation prefers the last
   * `acted: true` row while the marker rides an `acted: false` one, so the evidence is SELECTED
   * AGAINST and the bound re-arms. The window is BYTE-DRIVEN, so it is shortest when the fleet is
   * busiest. NEVER PRE-EMPTS {@link pendingCeilingMinutes}.
   * // Why: 50 is derived against the merge-time population — docs/forensics/sweep.md.
   */
  repeatDispositionBound: number;
  /**
   * W1-T2439 — HOW MANY PLAN-FILING PRs THE NON-SPAWNING REVIEW LANE MAY ADMIT PER LIGHT PASS.
   * The spawning lane is bounded by {@link reviewLanes} instead.
   *
   * THE NUMBER IS DERIVED, NOT PICKED, from three measured quantities: a deterministic review
   * costs five GitHub calls, a pass runs about 60 times an hour, and the queue is two deep at the
   * median. // Why: the daemon hit "API rate limit already exceeded" — docs/forensics/sweep.md.
   */
  planFilingAdmissionBound: number;
}

/**
 * The shipped default policy. A BOUNDED FAIL-SAFE (rule 2): an absent value falls back to a
 * bounded default, never to unbounded spend.
 *
 * THE COST CEILING'S TRADE-OFF MUST NOT BE MISREAD: it bounds RUNAWAY spend, not a budget, and
 * would not by itself have caught the incident the original figure was chosen against. The
 * per-run cap and the headroom governor are the other two limits.
 *
 * Several rows are COLLECTED from `plan/policy.yaml` rather than written as source literals, so a
 * plan-reviewed edit retunes them with no code change. Each was a RELOCATION, never a retune.
 * // Why: this object is FROZEN AT IMPORT (W1-T331) — docs/forensics/sweep.md.
 */
const POLICY_SWEEP = loadDefaultPolicy().values.sweep;

/**
 * W1-T1049 — reads `plan/policy.yaml`'s `sweep.reviewLanes` row DIRECTLY, never through
 * `policy.ts`'s schema, which is deliberately outside this task's declared files. Validated the
 * same way every other bounded numeric row is, so a malformed row fails LOUD at load rather than
 * falling back silently and masking a bad edit (rule 2).
 */
export function validateReviewLanesRow(row: unknown): number {
  if (typeof row !== "object" || row === null) {
    throw new PolicyError(`policy.yaml: 'sweep.reviewLanes' must be a mapping with 'value'/'origin'/'min'/'max'.`);
  }
  const { value, min, max } = row as Record<string, unknown>;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PolicyError(`policy.yaml: 'sweep.reviewLanes.value' must be a finite number, got ${JSON.stringify(value)}.`);
  }
  if (typeof min !== "number" || typeof max !== "number" || !Number.isFinite(min) || !Number.isFinite(max)) {
    throw new PolicyError(
      `policy.yaml: 'sweep.reviewLanes' must carry numeric 'min' and 'max' bounds — finite ones ` +
        `(got min=${JSON.stringify(min)}, max=${JSON.stringify(max)}).`,
    );
  }
  if (min > max) {
    throw new PolicyError(`policy.yaml: 'sweep.reviewLanes' has min (${min}) > max (${max}) — an unsatisfiable bound.`);
  }
  if (value < min || value > max) {
    throw new PolicyError(
      `policy.yaml: 'sweep.reviewLanes.value' (${value}) is out of its declared bound [${min}, ${max}].`,
    );
  }
  return value;
}

const REVIEW_CAPACITY_FIELDS = [
  "hostWorkerBudget",
  "workerMemoryReserveMib",
  "healthyWindowSamples",
  "sampleCadenceMs",
  "telemetryCadenceMs",
  "cpuPsiLowPct",
  "cpuPsiHighPct",
  "memoryPsiLowPct",
  "memoryPsiHighPct",
  "providerAllowancePct",
  "settlementWindowMs",
  "unhealthySettlementThreshold",
  "minHealthySettlements",
  "latencyExpansionRatio",
] as const satisfies readonly (keyof ReviewCapacityPolicy)[];

/** Direct bounded-row loader for W1-T2853's nested review-capacity policy. */
export function validateReviewCapacityPolicy(raw: unknown): ReviewCapacityPolicy {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PolicyError("policy.yaml: 'sweep.reviewCapacity' must be a mapping of bounded numeric rows.");
  }
  const output = {} as Record<keyof ReviewCapacityPolicy, number>;
  for (const field of REVIEW_CAPACITY_FIELDS) {
    const row = (raw as Record<string, unknown>)[field];
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new PolicyError(`policy.yaml: 'sweep.reviewCapacity.${field}' must be a bounded numeric row.`);
    }
    const { value, min, max } = row as Record<string, unknown>;
    if (
      typeof value !== "number" || !Number.isFinite(value) ||
      typeof min !== "number" || !Number.isFinite(min) ||
      typeof max !== "number" || !Number.isFinite(max)
    ) {
      throw new PolicyError(`policy.yaml: 'sweep.reviewCapacity.${field}' must carry finite value/min/max numbers.`);
    }
    if (min > max) {
      throw new PolicyError(`policy.yaml: 'sweep.reviewCapacity.${field}' has min (${min}) > max (${max}).`);
    }
    if (value < min || value > max) {
      throw new PolicyError(
        `policy.yaml: 'sweep.reviewCapacity.${field}.value' (${value}) is out of its declared bound [${min}, ${max}].`,
      );
    }
    output[field] = value;
  }
  if (output.cpuPsiLowPct >= output.cpuPsiHighPct || output.memoryPsiLowPct >= output.memoryPsiHighPct) {
    throw new PolicyError("policy.yaml: review-capacity PSI low watermarks must be below their high watermarks.");
  }
  for (const field of ["hostWorkerBudget", "healthyWindowSamples", "unhealthySettlementThreshold", "minHealthySettlements"] as const) {
    if (!Number.isInteger(output[field]) || output[field] < 1) {
      throw new PolicyError(`policy.yaml: 'sweep.reviewCapacity.${field}.value' must be a positive integer.`);
    }
  }
  if (output.sampleCadenceMs <= 0 || output.telemetryCadenceMs <= 0 || output.settlementWindowMs <= 0) {
    throw new PolicyError("policy.yaml: review-capacity cadence/window values must be positive.");
  }
  if (output.latencyExpansionRatio <= 1) {
    throw new PolicyError("policy.yaml: 'sweep.reviewCapacity.latencyExpansionRatio.value' must be greater than 1.");
  }
  return output;
}

/** Reads the row {@link validateReviewLanesRow} validates. Split from it so every refusal arm
 *  above is reachable from a test without a temp policy file on disk — the file read stays here,
 *  the decisions stay there. */
function loadReviewPolicy(): { value: number; min: number; max: number; capacity: ReviewCapacityPolicy } {
  const path = installPolicyPath();
  const raw = parseYaml(readFileSync(path, "utf8")) as {
    sweep?: { reviewLanes?: unknown; reviewCapacity?: unknown };
  } | null;
  const value = validateReviewLanesRow(raw?.sweep?.reviewLanes);
  const row = raw?.sweep?.reviewLanes as Record<string, unknown>;
  return {
    value,
    min: row.min as number,
    max: row.max as number,
    capacity: validateReviewCapacityPolicy(raw?.sweep?.reviewCapacity),
  };
}
const REVIEW_POLICY = loadReviewPolicy();

export const DEFAULT_SWEEP_POLICY: SweepPolicy = {
  staleDays: POLICY_SWEEP.staleDays,
  strikeCap: POLICY_SWEEP.strikeCap,
  clarify: DEFAULT_CLARIFY_POLICY,
  wipLimit: POLICY_SWEEP.wipLimit,
  dispatchLanes: POLICY_SWEEP.dispatchLanes,
  reviewLanes: REVIEW_POLICY.value,
  reviewLaneMin: REVIEW_POLICY.min,
  reviewLaneMax: REVIEW_POLICY.max,
  reviewCapacity: REVIEW_POLICY.capacity,
  dailyCostCeilingUsd: POLICY_SWEEP.dailyCostCeilingUsd,
  // W1-T1038: collected off plan/policy.yaml's own row (POLICY_SWEEP, above), the same relocation
  // dailyCostCeilingUsd/wipLimit/dispatchLanes already made — never a source literal.
  memoryFloorMib: POLICY_SWEEP.memoryFloorMib,
  pendingCeilingMinutes: 60,
  // 10 minutes: an order of magnitude above the observed push->first-check-registers latency
  // (seconds), and far below the 7h45m #921 sat in its silent loop.
  absentCeilingMinutes: 10,
  reviewOrphanCap: 2,
  // W1-T1018: 2 hours — long enough that a genuine repair (a base fix, a contradiction fix, an
  // operator's own intervention) has real time to land before the lane retries again, short
  // enough that a PR which does heal is not left silent for a whole day waiting on it.
  reviewOrphanBackoffMinutes: 120,
  repairFilingThreshold: POLICY_SWEEP.repairFilingThreshold,
  repairFilingWindowDays: POLICY_SWEEP.repairFilingWindowDays,
  supersessionDisposalEnabled: POLICY_SWEEP.supersessionDisposal,
  // W1-T932: NOT sourced from plan/policy.yaml (see the field's own doc, above) — a hardcoded
  // literal, off, exactly like `pendingCeilingMinutes` above it in this same object.
  conceptCoexistenceEnabled: false,
  // W1-T984 filed this OFF; W1-T2536 turns it ON — see the field's own doc for why the semantic
  // predicate W1-T984 waited for cannot live here, and what fences a wrong resolution instead.
  // Still NOT sourced from plan/policy.yaml: a hardcoded literal, the same choice
  // `conceptCoexistenceEnabled` just above already made.
  mergeConflictAdmissionEnabled: true,
  // W1-T2345: NOT sourced from plan/policy.yaml (see the field's own doc, above) — a hardcoded
  // literal, 50, derived against the merge-time population measured 2026-08-26 (see the field's
  // own doc for the full derivation), never a round number picked because it looked safe.
  repeatDispositionBound: 50,
  planFilingAdmissionBound: 3,
};

/**
 * W1-T923 — one GATE failure whose remedy is a SINGLE, unambiguous form, so the fix rung can act
 * on it directly. Never an unmet acceptance criterion — see {@link OpenPrView.actionableGateFailures}.
 * `reason` is carried VERBATIM from the ledger's structured `reasons` array, never parsed out of
 * `failure_reason` prose: structured, or honestly absent, never a regex over free text.
 */
export interface ActionableGateFailure {
  reason: string;
}

/**
 * One open PR's OBSERVED state, as the sweep sees it — the input to the pure
 * predicate. The real gateway builds this from `gh pr list --state open --json …`
 * + the review/CI derivation status.ts already does; tests inject fixtures.
 */
export interface OpenPrView {
  prNumber: number;
  prUrl: string;
  /** The task this PR credits (its `Remudero-Task:` trailer), if resolved. */
  taskId?: string;
  /** Rolled-up remudero-review state on the head. */
  reviewState: "success" | "failure" | "pending" | "none";
  /** Rolled-up required-checks state on the head. */
  checksState: "green" | "red" | "pending" | "none";
  /**
   * W1-T114 — ISO-8601 start of the NEWEST required check on this head, the WAIT disposition's
   * only time input. Populated when `checksState === "pending"`, undefined otherwise. Absent
   * means the WAIT and stale-pending rows never match, failing toward the catch-all escalate
   * rather than an indefinite silent wait on state we cannot date.
   */
  checksPendingSince?: string;
  /**
   * W1-T913 — when the current head's pending was posted, the staleness clock the post-review row
   * needs. `undefined` reads as STALE rather than fresh: re-driving a finished review is
   * idempotent, stranding one whose state we cannot date is not.
   * // Why: a naive pending post makes `reviewState` read "pending" forever, so a row keyed on
   * // "none" alone would never offer the head again — docs/forensics/sweep.md.
   */
  reviewPendingSince?: string;
  /**
   * W1-T2844 — positive local-process evidence that the CURRENT head's pending review owner no
   * longer exists. `undefined` covers live owners as well as legacy, incomplete and foreign-host
   * identities that cannot be proved dead; those retain {@link reviewPendingIsStale}'s existing
   * timeout behavior. Only the real gateway sets this, from the durable pending ledger row.
   */
  reviewPendingOwnerDead?: boolean;
  /**
   * W1-T2299 — when the current `reviewState` reading was posted, read off the same rollup entry
   * already scanned, at no extra request.
   *
   * NOT A BODY-EDIT TIMESTAMP, AND MUST NEVER BE DOCUMENTED AS ONE: GitHub exposes no
   * body-specific time field, so this detects ACTIVITY AFTER A VERDICT. A gaming edit buys a
   * re-judgement, not a pass. `undefined` fails closed, treated as NOT superseded.
   */
  reviewVerdictPostedAt?: string;
  /**
   * The unmet acceptance criteria from a failing review, `[]` otherwise. For a task-id-less PR,
   * `buildOpenPrViews` populates this from the ledger under the same synthetic `PR-<n>` id
   * `reviewCommand` already uses. A non-empty list routes to `blocked-fixable`; it does not make
   * the PR attributable to a plan task or widen {@link criteriaRecoverable} below.
   */
  unmetCriteria: CriterionVerdict[];
  /**
   * W1-T440 — true when a trailer resolved a task id, so {@link unmetCriteria} is attributable to
   * a plan task. Row 7 reads it only after both fixable lists are empty, to say WHICH empty a
   * failing review is. `undefined` is treated as `true`, so this is additive.
   * // Why: deliberately NOT widened by the synthetic-key read — widening would read as crediting
   * // an unattributed PR, which #1527 forbids and a test locks.
   */
  criteriaRecoverable?: boolean;
  /**
   * W1-T923 — a SIBLING list to {@link unmetCriteria}, never a widening of it: what a GATE
   * failure's own structured remedy populates. ONE ENTRY PER SINGLE-FORM REMEDY ONLY — a remedy
   * offering a CHOICE is EXCLUDED entirely, never included-but-flagged, because a worker picking
   * the wrong option misattributes a ratified ruling. NEVER KEYED ON `failure_class`.
   * // Why: #1991 passed every criterion yet named its exact remedy — docs/forensics/sweep.md.
   */
  actionableGateFailures?: ActionableGateFailure[];
  /** Fix-rung strikes ALREADY attempted for this PR (from the ledger). */
  priorStrikes: number;
  /** A NEWER open PR crediting the same task supersedes this one. */
  supersededBy?: number;
  /**
   * W1-T920 — a {@link SupersessionVerdict} for this PR, gated and default OFF. Distinct from
   * {@link supersededBy}: that is a bare NUMBER matched on a shared trailer, the IDENTITY match
   * design note (ii) forbids relying on alone. This carries a REASON, and the rows reading it read
   * ONLY `status`, never the PR's own fields. Three consumer rows: close on `"superseded"`, yield
   * on `"unique"` behind its own flag, and W1-T2779's unconditional yield on `"complementary"`.
   * SCOPE (honest): fully wired but unpopulated, so neither flag changes production today.
   */
  supersessionVerdict?: SupersessionVerdict;
  /** ISO-8601 timestamp of the PR's last activity (for the stale window). */
  lastActivityAt: string;
  /**
   * W1-T1201 — read ONLY by {@link deriveDisposition}'s age clamp: A PR CANNOT BE IDLE LONGER THAN
   * IT HAS EXISTED. Absent or unparseable reads as NO bound, never as "just created".
   * // Why: eleven live PRs, hours old, were closed "no activity in 400d" by a shifted clock.
   */
  createdAt?: string;
  /** The head commit sha — keys fix-dispatch idempotence (a new push re-earns a strike). */
  headSha: string;
  /** The head BRANCH name. Needed by the ABSENT-check-suite remedy, which pushes an empty
   *  commit to this branch to mint a fresh head sha. Already fetched by the real gateway
   *  (`isDependabot` reads the same field); optional so every existing fixture stays valid. */
  headRefName?: string;
  /** Observed: is GitHub auto-merge already armed on this PR? */
  autoMergeArmed: boolean;
  /** Head ref starts with `dependabot/` — routed to the W1-T54 dep-review lane
   * (its own deterministic judge), NEVER the fix rung (which would push commits
   * onto a Dependabot branch) and never the clarification rung. */
  isDependabot?: boolean;
  /**
   * W1-T528 — the operator's hold, and once auto-merge is armed the ONLY veto
   * {@link selectUpdateBranchTarget} still checks for itself. The check is `=== true`, so an
   * absent field leaves a PR eligible. That fail-open direction is narrow and deliberate: GitHub
   * refuses to arm a draft and only ARMED PRs reach here, so the exposure is an operator drafting
   * an already-armed PR. Unlike {@link RestPullRow.merged}, `draft` IS in GitHub's list schema.
   */
  isDraft?: boolean;
  /**
   * W1-T196 — true when this PR files new tasks and so deliberately carries NO trailer; crediting
   * a filing PR's own trailer would mark the task DONE on merge, before it is built. MUST be a
   * POSITIVE signal from the emitter's own output — never inferred from the absent trailer, which
   * would swallow a genuinely broken one, and never from the diff touching only `plan/**`.
   * SCOPE (honest): wired and tested, but no producer sets it, so every unattributable PR keeps
   * escalating — fail-open toward surfacing.
   */
  isPlanFiling?: boolean;
  /** The failing review's one-line summary (context for fix/escalate). */
  reviewSummary?: string;
  /**
   * Failing required-check name and log-tail evidence — the W1-T94 ci-log fix mode's input
   * (W1-T100, the #170 fix). Populated when `checksState === "red"`, or when a child named by
   * ci-gate's checked-in REQUIRED contract concluded red while the aggregate is still pending.
   * `[]`/undefined degrades the fix prompt to "no detail captured", never a crash.
   */
  ciFailures?: CiFailure[];
  /**
   * W1-T1223 — required checks whose LATEST attempt is CANCELLED with no later attempt on this
   * head, distinct from a genuine failure ({@link ciFailures} names both; this names only the
   * cancellations). Populated alongside `ciFailures` when `checksState === "red"`. Never makes
   * `checksState` anything but "red" — see {@link CancelledRequiredCheck}.
   */
  cancelledRequiredChecks?: CancelledRequiredCheck[];
  /** W1-T2504/W1-T2599 — concluded red children from ci-gate's checked-in REQUIRED contract. */
  redRequiredChecks?: string[];
  /**
   * W1-T2340 — this head's own workflow runs, the raw input {@link stalledRunReason} reads.
   * `undefined` when the listing could not be fetched, never degrading to `[]`, which would read
   * as "GitHub scheduled nothing" instead of "we could not check". NOT YET POPULATED by the real
   * gateway, so the new disposition row never fires for existing callers.
   */
  workflowRuns?: readonly WorkflowRunObservation[];
  /**
   * GitHub's own merge-conflict state, simplified (W1-T106, the #170 DIRTY
   * strand) — see {@link MergeState}'s own doc. `undefined`/`"unknown"` never
   * disposition CONFLICTED (fail-closed): only an OBSERVED `"dirty"` does.
   */
  mergeState?: MergeState;
  /**
   * GitHub's OWN raw `mergeable`, observed verbatim (W1-T186), carried ALONGSIDE the simplified
   * {@link mergeState} rather than replacing it — so the escalation can name the exact fact
   * GitHub reported rather than the bucket it was sorted into. `undefined` when unread.
   * // Why: a dirty PR registers ZERO check runs, so an escalation reading only checks and review
   * // had to misdescribe it (#412/#413).
   */
  mergeable?: boolean;
  /**
   * GitHub's OWN raw `mergeable_state` string ("clean" | "dirty" | "blocked" | "behind" |
   * "unstable" | "unknown" | ...), observed verbatim (W1-T186, alongside {@link mergeable}
   * above) — the escalation names THIS exact reported value, never just the simplified
   * {@link MergeState} bucket it was derived into.
   */
  mergeableState?: string;
  /**
   * The merge-conflict fix mode's input — the conflicting file list + both
   * sides' log since merge-base (W1-T94's new mode, design note iii).
   * Populated when `mergeState === "dirty"`; `undefined` otherwise (mirrors
   * how `ciFailures` is populated only when `checksState === "red"`).
   */
  mergeConflict?: MergeConflictEvidence;
  /**
   * What each recorded fix-rung strike TRIED for this PR's task, ledger
   * ground truth only (W1-T78) — the clarification-question rung's "what the
   * fix worker tried per strike" input. `[]`/undefined when no strike is
   * recorded (e.g. the terminal catch-all, which never dispatched a fix).
   */
  strikeHistory?: StrikeAttempt[];
  /**
   * An operator's answer to a prior clarification question (W1-T78). Its `constraint` feeds the
   * next fix dispatch VERBATIM, never a silent guess, and routes the PR to `blocked-fixable` even
   * at cap, so the answer re-arms the rung rather than immediately re-exhausting it.
   * SCOPE (honest): wired end-to-end and tested, but nothing populates it, so every
   * blocked-ambiguous PR keeps asking and never silently re-arms itself.
   */
  pendingAnswer?: { constraint: string; resetStrikeCounter?: boolean };
  /**
   * W1-T176 — true when the ledger already carries a refusal for this exact task/PR/head/body
   * input. This separates a FIRST-SEEN zero-runs required check, which still routes to
   * post-review because an absent required check is mechanically decidable, from a SECOND absence
   * for the unchanged input, which escalates rather than retrying a lane that already declined.
   * A transient `gh` error deliberately does NOT set this — a network hiccup must keep retrying.
   * A new commit or body edit re-earns one attempt; `undefined` never escalates by omission.
   */
  reviewPostRefused?: boolean;
  /**
   * W1-T176 — true when THIS pass could not read branch protection's required-contexts list.
   * Gates the zero-runs discriminator rows OFF: without that list we cannot POSITIVELY confirm
   * the review is required here, and calling its absence a decidable "post it" would assume
   * permissive on missing information. `true` routes the PR to the catch-all, which still
   * classifies it blocked-ambiguous, never mergeable.
   */
  requiredContextsUnreadable?: boolean;
  /**
   * W1-T2399 — WHY the required-contexts read was unreadable, captured where the read happens and
   * carried here so the escalation can name it without a second GitHub call. Present only on a
   * genuine read failure; protection that readably declares NO required contexts leaves this
   * undefined, which is the point of the split.
   */
  requiredContextsReadFailure?: { branch: string; reason: string };
  /**
   * W1-T225 — true when the ledger carries a review outcome for this task at an EARLIER head: the
   * PR has been reviewed, just not on the head being looked at now. Changes only the REASON the
   * post-review row states, never the dispatch — either way the remedy is a FRESH verdict for
   * this head, and a verdict from a superseded head is never copied forward.
   */
  reviewOrphanedByPush?: boolean;
  /**
   * Completed judgments for the exact current input: task key, PR URL, head sha and body digest.
   * A new commit or body edit resets this to zero; refusals and legacy rows never count.
   * Recovering from a GitHub FAILURE with no matching judgment additionally requires an explicit
   * zero and {@link reviewInputDigest}, so an unwired caller can never be mistaken for evidence
   * that the ledger is missing a run.
   */
  priorReviewAttemptsForInput?: number;
  /**
   * Most recent completed `review.posted` timestamp for the same exact input counted above.
   * Refusals do not move this clock because they never judged the content. Undefined means no
   * completed attempt is known; {@link reviewInputBackoffElapsed} then fails toward escalation.
   */
  reviewInputLastAttemptAt?: string;
  /** Versioned digest of the current head+body review input. Real gateway views always populate
   * it; omitted test/legacy callers retain the historical per-head outcome-dedup behavior. */
  reviewInputDigest?: string;
}

/** The disposition derived for one PR, plus a stated human reason. */
export interface DispositionResult {
  disposition: Disposition;
  reason: string;
}

/**
 * One PR status-check-rollup entry, structurally — a CheckRun or StatusContext as
 * `gh pr list/view --json statusCheckRollup` reports it. Names ONLY the fields
 * {@link checksStateFromRollup} reads, so this deterministic core never depends on run-task.ts's
 * richer `RollupCheck` shape, which stays structurally assignable here without an import.
 */
export interface RollupCheckEntry {
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  /**
   * When this attempt started (W1-T457). gh's own JSON exporter (cli/cli's `export_pr.go`)
   * populates this for BOTH rollup node shapes — a CheckRun's own `startedAt`, and a
   * StatusContext's mapped from `createdAt` — so it is present on every entry the real gateway
   * reports, and is what {@link dedupeRollupByLatestAttempt} sorts on.
   */
  startedAt?: string;
}

/**
 * Conclusions GitHub's OWN merge-eligibility treats as SATISFYING a required check (W1-T103):
 * SKIPPED and NEUTRAL count as green, so only a genuinely unresolved check holds "pending".
 * EXPORTED so the poll loops read the SAME ok-set this file's predicate reads, rather than a
 * narrower private test that read a cleanly-concluded NEUTRAL as still pending.
 */
export const REQUIRED_CHECK_OK = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);

/**
 * Conclusions that veto a required check outright. EXPORTED (W1-T457) so the failing-list PRODUCER
 * filters on the exact same set this file's PREDICATE vetoes on and the two cannot drift. STALE is
 * folded in here rather than given a fifth `checksState` member, exactly as CANCELLED is: it means
 * "this reading is void". // Why: the drift and STALE's years unclassified — docs/forensics/sweep.md.
 */
export const REQUIRED_CHECK_FAIL = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
]);

/**
 * Group rollup entries by check name or status context and keep ONLY the latest
 * {@link RollupCheckEntry.startedAt} — the SAME rule ci-gate's own dedupe applies one surface
 * over, copied rather than reinvented. An entry with no `startedAt` sorts OLDER, and a tie keeps
 * the LAST encountered: the contract is only that duplicates collapse to one row per key.
 * // Why: a sha accumulates one entry PER ATTEMPT, so a superseded CANCELLED entry read "red"
 * // forever and could never be outvoted by its own successor — docs/forensics/sweep.md.
 */
export function dedupeRollupByLatestAttempt<T extends RollupCheckEntry>(rollup: readonly T[]): T[] {
  const latest = new Map<string, T>();
  for (const c of rollup) {
    const key = c.name ?? c.context ?? "";
    const prior = latest.get(key);
    if (!prior || (c.startedAt ?? "") >= (prior.startedAt ?? "")) latest.set(key, c);
  }
  return [...latest.values()];
}

/**
 * Aggregate ONLY the REQUIRED contexts into `checksState` (W1-T103). `requiredContexts` is branch
 * protection's OWN list, threaded in rather than hardcoded (rule 2); non-required contexts stay in
 * the raw rollup for other consumers but never vote here.
 *
 * UNREADABLE PROTECTION FAILS CLOSED — every reported context counts, because an unreadable rule
 * must never manufacture a false green. `remudero-review` IS EXCLUDED UNCONDITIONALLY (W1-T394),
 * even in that fallback: it is a commit status carrying the REVIEW verdict, and counting it here
 * made a red review indistinguishable from red CI. DEDUPED before judging, so only the latest
 * attempt votes. // Why: the #170 and #1441 incidents — docs/forensics/sweep.md.
 */
export function checksStateFromRollup(
  rollup: RollupCheckEntry[] | undefined,
  requiredContexts: Iterable<string> | undefined,
): OpenPrView["checksState"] {
  const all = (rollup ?? []).filter((c) => c.name !== REVIEW_CONTEXT && c.context !== REVIEW_CONTEXT);
  if (all.length === 0) return "none";
  const required = new Set(requiredContexts ?? []);
  const knownRequired = required.size > 0;
  // Dedupe to ONE entry per check name — the LATEST attempt — before judging. Dedup cannot change
  // whether `gate` is empty (grouping merges rows sharing a key, it never drops a key), so the
  // "required but not yet registered" distinction just below is unaffected (W1-T457).
  const gate = dedupeRollupByLatestAttempt(
    knownRequired ? all.filter((c) => required.has(c.name ?? "") || required.has(c.context ?? "")) : all,
  );
  // Required contexts are configured but none has registered on this head yet
  // (e.g. the workflow hasn't started) — waiting, not "no checks at all".
  if (gate.length === 0) return knownRequired ? "pending" : "none";
  // ONE OK-SET, KNOWN CONTEXTS OR NOT. This used to narrow to SUCCESS alone whenever the required
  // list was unreadable, but REQUIRED_CHECK_OK's doc is a claim about GITHUB'S merge-eligibility
  // semantics, which do not change because OUR token could not read branch protection.
  // NOT WIDENED TO A NEW `unknown` state, deliberately: a fifth member every existing row silently
  // fails to match is the false-predicate-falls-through shape that produced the issue storm.
  // Why: the measured cost of the asymmetry is in docs/forensics/sweep.md.
  const ok = REQUIRED_CHECK_OK;
  let anyPending = false;
  for (const c of gate) {
    const s = (c.state ?? c.conclusion ?? c.status ?? "").toUpperCase();
    if (REQUIRED_CHECK_FAIL.has(s)) return "red";
    if (!ok.has(s)) anyPending = true;
  }
  return anyPending ? "pending" : "green";
}

/**
 * W1-T1223 — one required check whose LATEST attempt is CANCELLED. `checksState` stays "red"
 * exactly as for a genuine failure; a fifth member is refused for the reason
 * {@link checksStateFromRollup} gives. This is the SEPARATE observable naming which red check is
 * an ABSENT verdict rather than a bad one, so the job can be re-queued instead of a worker
 * dispatched against a diff with no defect.
 */
export interface CancelledRequiredCheck {
  name: string;
  /**
   * GitHub Actions job id, parsed by the real gateway (run-task.ts) from the rollup's own
   * `detailsUrl` — the re-queue target is the JOB (design iv), never the workflow run.
   * `undefined` when no job id could be read; the real `requeueCheck` wiring then degrades to a
   * named no-op rather than guessing a target.
   */
  jobId?: string;
  /**
   * W1-T2431 — GitHub's OWN `run_attempt`, read off the SAME rollup {@link jobId} is parsed from:
   * no new gateway, no new credential. This is a SURFACE the fleet does not write, so it counts an
   * operator's own re-run too. SCOPE: no producer sets it, so it is always `undefined` today —
   * a WIDENING of the `true` case, never a replacement that could narrow it.
   */
  runAttempt?: number;
}

/**
 * W1-T2431 — whether this check's run has already been re-run, read off GitHub's own
 * `runAttempt` rather than a ledger row the fleet wrote about its own action. Being ground truth
 * it reads true for ANY actor, the distinction a fleet-keyed ledger cannot make, and it survives
 * rotation because it is not a ledger row at all. `undefined` or `<= 1` reads as "not yet re-run":
 * an unread value must never MANUFACTURE a prior re-queue. Callers OR this with the ledger set.
 */
export function cancelledCheckAlreadyRequeuedFromSurface(runAttempt: number | undefined): boolean {
  return typeof runAttempt === "number" && runAttempt > 1;
}

/**
 * W1-T1223 — which check has a LATEST (deduped) attempt that is CANCELLED. A genuinely FAILING
 * check is never named: only the literal CANCELLED conclusion separates "nobody reached a verdict"
 * from "a verdict came back bad". An unreadable `requiredContexts` names nothing, since a live CI
 * mutation must never be attempted from an unreadable gate. W1-T2283: a named check no longer has
 * to be a member of `required`, bringing the arm that ACTS into agreement with the miner that
 * already SEES. // Why: the old filter-then-test order could never reach a positive result.
 */
export function cancelledRequiredCheckNames(
  rollup: RollupCheckEntry[] | undefined,
  requiredContexts: Iterable<string> | undefined,
): string[] {
  const required = new Set(requiredContexts ?? []);
  if (required.size === 0) return [];
  const all = (rollup ?? []).filter((c) => c.name !== REVIEW_CONTEXT && c.context !== REVIEW_CONTEXT);
  const gate = dedupeRollupByLatestAttempt(all);
  return gate
    .filter((c) => (c.state ?? c.conclusion ?? c.status ?? "").toUpperCase() === "CANCELLED")
    .map((c) => c.name ?? c.context ?? "unknown");
}

export const redQualityGateNames = (rollup: RollupCheckEntry[] | undefined, requiredCheckNames: Iterable<string> | undefined): string[] => dedupeRollupByLatestAttempt((rollup ?? []).filter((c) => c.name !== REVIEW_CONTEXT && c.context !== REVIEW_CONTEXT && ([...(requiredCheckNames ?? [])].includes(c.name ?? "") || [...(requiredCheckNames ?? [])].includes(c.context ?? "")))).filter((c) => REQUIRED_CHECK_FAIL.has((c.state ?? c.conclusion ?? c.status ?? "").toUpperCase())).map((c) => c.name ?? c.context ?? "unknown"); // W1-T2504

/** Job-level statuses {@link stalledRunReason} treats as that job having reached a final state. */
const JOB_TERMINAL_STATUSES = new Set(["completed"]);

/**
 * W1-T2340 — names the reason a head's workflow runs read as STALLED rather than pending.
 *
 * THE DISCRIMINATOR: a job whose STATUS is non-terminal inside a run whose CONCLUSION is terminal
 * — pinned by a run that will schedule nothing further. NOT an absence of jobs, the reading
 * measurement falsified. NEEDS NO THRESHOLD, so this takes no `policy` or `now` parameter at all.
 * A run still in progress is untouched, and every unreadable input FAILS TOWARD "NOT STALLED".
 * PURE and SYNCHRONOUS: nothing here fetches, waits or schedules a second look.
 */
export function stalledRunReason(runs: readonly WorkflowRunObservation[] | undefined): string | undefined {
  if (runs === undefined) return undefined;
  for (const run of runs) {
    const conclusion = (run.conclusion ?? "").trim();
    if (conclusion === "") continue; // run still in progress — untouched, not this function's concern
    const stuck = (run.jobs ?? []).find((j) => !JOB_TERMINAL_STATUSES.has((j.status ?? "").toLowerCase()));
    if (stuck) {
      return (
        `a job is still "${stuck.status ?? "unstarted"}" but its own run already concluded "${conclusion}" — ` +
        `a terminal run schedules nothing further, so that job will never move`
      );
    }
  }
  return undefined;
}

/**
 * W1-T1278 — of the checks a fix rung believes are red, possibly stale, which are STILL red on a
 * FRESH rollup read. A name is dropped ONLY for an observed `startedAt` with a currently
 * NON-TERMINAL status — a later attempt executing RIGHT NOW. That is deliberately narrower than
 * "no longer red", because one notch wider is "never fix a red PR", and inferring in-flight from a
 * name or a retry count would be GUESSING. A name absent from the fresh rollup is NEVER dropped:
 * an unreadable rollup must never manufacture a stand-down.
 */
export function stillRedRequiredNames(redNames: readonly string[], rollup: RollupCheckEntry[] | undefined): string[] {
  if (redNames.length === 0) return [];
  const all = (rollup ?? []).filter((c) => c.name !== REVIEW_CONTEXT && c.context !== REVIEW_CONTEXT);
  const deduped = dedupeRollupByLatestAttempt(all);
  const byKey = new Map(deduped.map((c) => [c.name ?? c.context ?? "", c] as const));
  return redNames.filter((name) => {
    const fresh = byKey.get(name);
    if (!fresh || !fresh.startedAt) return true; // unreadable/absent — fail open, still red
    const s = (fresh.state ?? fresh.conclusion ?? fresh.status ?? "").toUpperCase();
    const inFlight = !REQUIRED_CHECK_OK.has(s) && !REQUIRED_CHECK_FAIL.has(s);
    return !inFlight; // an OBSERVED later attempt still running is the ONLY thing dropped
  });
}

/** One re-queue/escalate decision for one cancelled required check. */
export interface CancelledCheckRequeueDecision {
  requeue: boolean;
  escalate: boolean;
  reason: string;
}

/**
 * W1-T1223 — BOUNDED BY A LEDGERED RECORD, NEVER A CLOCK OR AN IN-MEMORY COUNTER. Zero priors
 * re-queues once; a SECOND observation of the same pair escalates instead of repeating. No timer
 * and no retry budget: one re-queue is either sufficient, for a preempted runner, or diagnostic,
 * for a fault re-queueing cannot reach.
 */
export function cancelledCheckRequeueDecision(alreadyRequeued: boolean): CancelledCheckRequeueDecision {
  if (alreadyRequeued) {
    return {
      requeue: false,
      escalate: true,
      reason: "already re-queued once on this head sha and cancelled again — a second cancellation is beyond what re-queueing can reach",
    };
  }
  return {
    requeue: true,
    escalate: false,
    reason: "latest attempt was cancelled with no later attempt on this head — re-queueing the job once",
  };
}

/** The ledger step {@link requeuedCheckKeysFromLedger} reads back — one row per re-queue attempt. */
export const CHECK_REQUEUE_STEP = "sweep.check_requeued";

/**
 * W1-T1223 — every `${headSha}@${checkName}` pair the ledger already records a
 * {@link CHECK_REQUEUE_STEP} row for. `runSweep` writes the row BEFORE calling
 * `deps.requeueCheck`, so a pass crashing between the write and the GitHub call still bounds the
 * next pass toward escalating — the safer direction for an action that mutates CI state unattended.
 */
export function requeuedCheckKeysFromLedger(lines: Array<Record<string, unknown>>): Set<string> {
  const out = new Set<string>();
  for (const l of lines) {
    if (l.step === CHECK_REQUEUE_STEP && typeof l.head_sha === "string" && typeof l.check_name === "string") {
      out.add(`${l.head_sha}@${l.check_name}`);
    }
  }
  return out;
}

// ── W1-T2204 — MAIN'S OWN CHECK ROLLUP HAS NO READER ─────────────────────────────────────────
//
// Every predicate above reads a PR's rollup; nothing reads the DEFAULT BRANCH's own. This section
// is that reader — a pure transform to a NAMED observation of main's health — plus two decisions
// kept separate: whether to escalate, and whether that escalation may by itself stand down
// dispatch of unrelated tasks (it may not).
//
// WHY "pending" ISN'T ENOUGH: SKIPPED counts as green for a PR but is a DIFFERENT question for
// main, where a push can register a job SKIPPED because the workflow never asked. Skipped and
// known-vacuous names are collected as non-evidence and can never make the verdict green.

/**
 * Check names KNOWN, from the workflow's own guard, to conclude SUCCESS on a push having executed
 * no real work. The check-runs API carries no field for "did this job do anything", so this is a
 * NAMED, CITED allowlist (policy-as-data, rule 2), never a general detector. A future
 * vacuous-on-push job is added here BY NAME, never by inventing detection logic.
 */
export const PUSH_VACUOUS_SUCCESS_CHECK_NAMES: ReadonlySet<string> = new Set(["coverage-ratchet"]);

/**
 * Main's health read off its own rollup — the default-branch sibling of `checksState`. Three
 * members only: "green" (a required check GENUINELY concluded passing, none failed, none
 * outstanding), "red" (never auto-acted on beyond an escalation; a revert is forbidden outright),
 * and "undetermined" (still running, or every concluded check skipped or known-vacuous). The last
 * is NEVER collapsed into "green" — that collapse is the vacuous pass this reader exists to refuse.
 */
export type MainHealthState = "green" | "red" | "undetermined";

/** One named observation of main's own check rollup (acceptance 1) — never a bare boolean. */
export interface MainHealthObservation {
  readonly state: MainHealthState;
  /** The head sha the rollup was read against. */
  readonly sha: string;
  /** Human-readable reason the state landed where it did — carried into any escalation. */
  readonly reason: string;
  /** Required check names whose latest (deduped) attempt concluded with a failing conclusion. */
  readonly failingChecks: readonly string[];
  /** Required check names skipped, or known-vacuous-success — excluded from evidence either way. */
  readonly nonEvidenceChecks: readonly string[];
  /** Required check names with no terminal conclusion yet. */
  readonly pendingChecks: readonly string[];
}

/**
 * Read main's rollup into a {@link MainHealthObservation}, reusing the exact dedupe and
 * required-contexts filter {@link checksStateFromRollup} applies so the two can never disagree
 * about which entries are in play — but judging them against a STRICTER question: skipped and
 * known-vacuous members never count as evidence, and an outstanding check reads "undetermined".
 * An unreadable protection rule degrades toward the narrower gate, never a false positive.
 */
export function mainHealthFromRollup(
  sha: string,
  rollup: readonly RollupCheckEntry[] | undefined,
  requiredContexts: Iterable<string> | undefined,
  vacuousSuccessNames: ReadonlySet<string> = PUSH_VACUOUS_SUCCESS_CHECK_NAMES,
): MainHealthObservation {
  const all = (rollup ?? []).filter((c) => c.name !== REVIEW_CONTEXT && c.context !== REVIEW_CONTEXT);
  const required = new Set(requiredContexts ?? []);
  const knownRequired = required.size > 0;
  const gate = dedupeRollupByLatestAttempt(
    knownRequired ? all.filter((c) => required.has(c.name ?? "") || required.has(c.context ?? "")) : all,
  );

  if (gate.length === 0) {
    return {
      state: "undetermined",
      sha,
      reason: knownRequired
        ? "required checks are configured but none have registered yet on main's head — undetermined, not green"
        : "no check-run rollup observed for main's head — undetermined, not green",
      failingChecks: [],
      nonEvidenceChecks: [],
      pendingChecks: [],
    };
  }

  const failingChecks: string[] = [];
  const nonEvidenceChecks: string[] = [];
  const pendingChecks: string[] = [];
  let evidenceOfGreen = false;
  for (const c of gate) {
    const name = c.name ?? c.context ?? "unknown";
    const s = (c.state ?? c.conclusion ?? c.status ?? "").toUpperCase();
    if (REQUIRED_CHECK_FAIL.has(s)) {
      failingChecks.push(name);
    } else if (s === "SKIPPED" || vacuousSuccessNames.has(name)) {
      nonEvidenceChecks.push(name);
    } else if (s !== "SUCCESS" && s !== "NEUTRAL") {
      pendingChecks.push(name);
    } else {
      evidenceOfGreen = true;
    }
  }

  if (failingChecks.length > 0) {
    return {
      state: "red",
      sha,
      reason: `required check(s) concluded failing on main: ${failingChecks.join(", ")}`,
      failingChecks,
      nonEvidenceChecks,
      pendingChecks,
    };
  }
  if (pendingChecks.length > 0) {
    return {
      state: "undetermined",
      sha,
      reason: `required check(s) still pending on main, not yet concluded: ${pendingChecks.join(", ")} — undetermined, not green`,
      failingChecks,
      nonEvidenceChecks,
      pendingChecks,
    };
  }
  if (!evidenceOfGreen) {
    return {
      state: "undetermined",
      sha,
      reason: `every required check on main's head was skipped or a known vacuous pass (${
        nonEvidenceChecks.join(", ") || "none"
      }) — no genuine evidence the trunk is healthy, so undetermined rather than green`,
      failingChecks,
      nonEvidenceChecks,
      pendingChecks,
    };
  }
  return {
    state: "green",
    sha,
    reason:
      nonEvidenceChecks.length > 0
        ? `required check(s) genuinely passed on main, excluding non-evidence entries: ${nonEvidenceChecks.join(", ")}`
        : "required check(s) genuinely passed on main",
    failingChecks,
    nonEvidenceChecks,
    pendingChecks,
  };
}

/**
 * Which existing escalation class carries a red-trunk finding. MANUAL is the fit, not a fourth
 * class: it already covers something genuinely off that only a human can rule on. BLOCKED is the
 * wrong shape (a specific PR's rung exhausted) and so is HARD_STOP (destructive ops, spend,
 * secrets) — this call site never takes an action, it only reports.
 */
export function mainHealthEscalationClass(): EscalationClass {
  return "MANUAL";
}

/** Whether, and how, a {@link MainHealthObservation} should escalate. Never a revert (Q3). */
export interface MainHealthEscalationDecision {
  readonly escalate: boolean;
  readonly class?: EscalationClass;
  readonly reason: string;
}

/**
 * A red trunk produces an escalation inside the existing taxonomy and NOTHING else: never a merge,
 * never a revert, just a decision object. Anything short of "red", including "undetermined", does
 * not escalate — an in-flight or vacuous rollup is evidence of an incomplete read, not a problem.
 */
export function mainHealthEscalationDecision(observation: MainHealthObservation): MainHealthEscalationDecision {
  if (observation.state !== "red") {
    return {
      escalate: false,
      reason: `main's own check state is "${observation.state}", not red — nothing to escalate: ${observation.reason}`,
    };
  }
  return {
    escalate: true,
    class: mainHealthEscalationClass(),
    reason: `main (${observation.sha}) is red — never auto-reverted, an operator ruling decides next steps: ${observation.reason}`,
  };
}

/**
 * The asymmetry, held as its own boolean rather than folded into
 * {@link mainHealthEscalationDecision}: a red trunk escalates, but that escalation must NEVER by
 * itself stop dispatch of unrelated tasks — a watcher that halts the queue on any red trunk
 * converts one broken test into a full stop, which is worse. `operatorRuling` is the ledgered
 * decision an operator actually recorded; omitting it is exactly "no ruling recorded yet", so
 * without an explicit `true` this always returns `false`, red trunk or not.
 */
export function mainHealthShouldStandDownDispatch(observation: MainHealthObservation, operatorRuling?: boolean): boolean {
  return observation.state === "red" && operatorRuling === true;
}

// ── W1-T1275 — THE REQUIRED ROLLUP NEVER RECOMPUTES ONCE ITS OWN RUN CONCLUDES ───────────────
//
// ci-gate.yml dedupes by name and re-reads inside a bounded grace window, but every re-read lives
// INSIDE that one run: once it posts a terminal conclusion nothing brings it back. This section is
// the pure detection and the ledgered bound; the real Actions call is the caller's wiring. The
// check named "ci-gate" IS what branch protection requires — its siblings are what CI-GATE ITSELF
// treats as required, never a second GitHub-side requirement to track.
// Why: #2612 held a green suite behind a stale failure for 155.4 minutes.
export const CI_GATE_CHECK_NAME = "ci-gate";

/**
 * #2918 — `ci-gate` REPORTED AS A FAILURE IT CANNOT BE. It is a DOWNSTREAM AGGREGATOR: red
 * BECAUSE a sibling is red, green when its inputs are. A list naming both it and the sibling that
 * caused it reports two failures where there is one, and a worker handed the second can only chase
 * a symptom.
 *
 * THE ONE CASE THAT IS KEPT is `ci-gate` failing ALONE — the stale-verdict shape
 * {@link staleCiGateTransition} names — so this never empties a non-empty list. PURE, and not a
 * change to what a check REPORTS: it narrows what the fleet is TOLD failed, never what CI decided.
 * // Why: attributed to the PR, not a task, deliberately — docs/forensics/sweep.md.
 */
export function withoutDownstreamGateFailure(failures: readonly CiFailure[]): CiFailure[] {
  const others = failures.filter((f) => f.name !== CI_GATE_CHECK_NAME);
  // Nothing else failed ⇒ the gate IS the signal. Also covers the empty list unchanged.
  if (others.length === 0) return [...failures];
  return others;
}

/**
 * W1-T1275 — the ONE (head, sibling-transition) shape that makes `ci-gate`'s concluded verdict
 * stale: its own latest deduped attempt concluded a NON-SUCCESS terminal state, and a required
 * sibling's latest attempt is a terminal SUCCESS that STARTED AFTER ci-gate's did — proof the
 * sibling flipped on this same head after the gate had already read. `jobId` is ci-gate's OWN,
 * never the sibling's: the AGGREGATOR is re-driven, since the sibling already succeeded.
 */
export interface StaleCiGateTransition {
  jobId?: string;
  /** The required sibling whose later terminal success makes ci-gate's own verdict stale. */
  siblingName: string;
  /** That sibling's latest-attempt `startedAt` (ISO) — names WHICH transition (design iv), and
   *  is what {@link ciGateReaggregateKey} bounds the recompute to firing once for. */
  siblingStartedAt: string;
}

/**
 * W1-T1275 — detect the ONE shape design note iii pins, and NOTHING wider. `ci-gate` must have a
 * CONCLUDED failing attempt, since a still-pending gate has no verdict to be stale, and only a
 * literal SUCCESS started STRICTLY LATER qualifies as the sibling. A genuinely failing suite is
 * never re-run by this path. Read-only over the shared dedupe: the gate's own attempt resolution
 * is unchanged.
 */
export function staleCiGateTransition(rollup: RollupCheckEntry[] | undefined): StaleCiGateTransition | undefined {
  const all = (rollup ?? []).filter((c) => c.name !== REVIEW_CONTEXT && c.context !== REVIEW_CONTEXT);
  if (all.length === 0) return undefined;
  const deduped = dedupeRollupByLatestAttempt(all);
  const gate = deduped.find((c) => (c.name ?? c.context ?? "") === CI_GATE_CHECK_NAME);
  if (!gate || !gate.startedAt) return undefined;
  const gateState = (gate.state ?? gate.conclusion ?? gate.status ?? "").toUpperCase();
  if (!REQUIRED_CHECK_FAIL.has(gateState)) return undefined;

  let latest: RollupCheckEntry | undefined;
  for (const c of deduped) {
    if ((c.name ?? c.context ?? "") === CI_GATE_CHECK_NAME) continue;
    const state = (c.state ?? c.conclusion ?? c.status ?? "").toUpperCase();
    if (state !== "SUCCESS") continue;
    if (!c.startedAt || c.startedAt <= gate.startedAt) continue;
    if (!latest || c.startedAt > (latest.startedAt ?? "")) latest = c;
  }
  if (!latest) return undefined;
  return { siblingName: latest.name ?? latest.context ?? "unknown", siblingStartedAt: latest.startedAt! };
}

/** The (head, sibling-transition) identity {@link CI_GATE_REAGGREGATE_STEP}'s rows are keyed on.
 *  Two DIFFERENT transitions on one head are two DIFFERENT keys, each earning its own bounded
 *  recompute (W1-T1275, design iv). */
export function ciGateReaggregateKey(headSha: string, transition: StaleCiGateTransition): string {
  return `${headSha}@${transition.siblingName}@${transition.siblingStartedAt}`;
}

/** One recompute decision for one observed stale transition. */
export interface CiGateReaggregateDecision {
  reaggregate: boolean;
  reason: string;
}

/**
 * W1-T1275 — BOUNDED BY A LEDGERED RECORD, never a clock or an in-memory counter, mirroring
 * {@link cancelledCheckRequeueDecision}. Zero priors for this exact (head, sibling-transition)
 * pair re-drives the gate's job once; a repeat observation never repeats the Actions call. At
 * most once per head and transition — which makes a re-run storm impossible by construction.
 */
export function ciGateReaggregateDecision(alreadyReaggregated: boolean): CiGateReaggregateDecision {
  if (alreadyReaggregated) {
    return {
      reaggregate: false,
      reason: "already re-driven once for this exact sibling transition on this head — never repeated",
    };
  }
  return {
    reaggregate: true,
    reason: "ci-gate concluded non-success and a required sibling later reached a terminal success on the same head",
  };
}

/** The ledger step {@link reaggregatedCiGateKeysFromLedger} reads back — one row per recompute. */
export const CI_GATE_REAGGREGATE_STEP = "sweep.ci_gate_reaggregated";

/**
 * W1-T1275 — every transition key the ledger already records a {@link CI_GATE_REAGGREGATE_STEP}
 * row for. `runSweep` writes the row BEFORE calling `deps.reaggregateCiGate`, the same ordering
 * {@link requeuedCheckKeysFromLedger} uses for the same reason: a pass crashing between the write
 * and the GitHub call still bounds the next pass toward standing down.
 */
export function reaggregatedCiGateKeysFromLedger(lines: Array<Record<string, unknown>>): Set<string> {
  const out = new Set<string>();
  for (const l of lines) {
    if (
      l.step === CI_GATE_REAGGREGATE_STEP &&
      typeof l.head_sha === "string" &&
      typeof l.sibling_name === "string" &&
      typeof l.sibling_started_at === "string"
    ) {
      out.add(`${l.head_sha}@${l.sibling_name}@${l.sibling_started_at}`);
    }
  }
  return out;
}

const MS_PER_DAY = 86_400_000;

/**
 * The blocked_ci shape (W1-T100, broadened by W1-T138): a required check is red. The failing
 * signal IS the CI log, and it takes PRECEDENCE over any review verdict beside it, because GitHub
 * will not merge past a red required check whatever the review says. The original also required
 * `reviewState === "none"`, which is too narrow: a slower check can settle red after review ran.
 *
 * `checksState` is red ONLY for a required CHECK RUN failure — the review status is excluded
 * (W1-T394) — so a red review can never make this true. EXPORTED so every caller imports this ONE
 * definition rather than a hand-copy that would drift on the next refinement.
 * // Why: strikes were burnt re-litigating a review while the blocking check sat untouched.
 */
export function isBlockedCi(pr: OpenPrView): boolean {
  return pr.checksState === "red" || (pr.redRequiredChecks?.length ?? 0) > 0; // W1-T2504
}

/**
 * W1-T1269 — does the CURRENT unmet-criteria set repeat, claim-for-claim, what the most recent
 * strike was already dispatched to resolve? THE EARLIER STOP, never a longer leash: a dispatch
 * that could only reproduce a strike already proven to add nothing is preempted before the cap.
 *
 * KEYED ON IDENTITY, NEVER ON COUNT, and STOPS ONLY ON AN EXACT MATCH — the stronger
 * inclusion-descent rule is REFUSED, because it would also stop a strike that swapped which
 * criteria are unmet, which is lateral progress. FAILS CLOSED on an empty or absent claim set.
 */
export function fixRungRepeatsIdenticalFailure(pr: OpenPrView): boolean {
  const history = pr.strikeHistory ?? [];
  const priorClaims = history[history.length - 1]?.unmetClaims;
  if (!priorClaims || priorClaims.length === 0) return false;
  const currentClaims = pr.unmetCriteria.map((c) => c.claim);
  if (currentClaims.length === 0 || currentClaims.length !== priorClaims.length) return false;
  const priorSet = new Set(priorClaims);
  return currentClaims.every((c) => priorSet.has(c));
}

/**
 * W1-T923 — given the STRUCTURED `reasons` a gate failure carried, decide whether it names a
 * SINGLE, unambiguous remedy. Exactly one is copied through VERBATIM; zero, or two or more, are
 * excluded ENTIRELY rather than flagged, because a worker acting on the wrong one of several named
 * options misattributes a ratified ruling. Reads NOTHING about `failure_class`, so a
 * judgement-classed row qualifies exactly like any other, by construction.
 */
export function actionableGateFailuresFromReasons(reasons: readonly string[]): ActionableGateFailure[] {
  return reasons.length === 1 ? [{ reason: reasons[0] }] : [];
}

/**
 * W1-T527 — WHY a PR is red, which {@link isBlockedCi} deliberately does not ask. Four causes
 * reached the identical dispatch, and only ONE is the fix rung's territory:
 *
 *   - `base-caused`   — the same check failing on EVERY open PR this pass; a property of main,
 *                       not of any diff, so no edit to those diffs would help.
 *   - `gate-conflict` — an unsatisfiable condition (Standing rule 25), NON-SUPPRESSIBLE, so no
 *                       re-review softens it and no patch satisfies both gates.
 *   - `environment`   — a near-total failure ratio inside ONE check repeating a single message.
 *   - `in-diff`       — the residue, and the fix rung's existing territory, unchanged.
 *
 * PRECEDENCE IS THE SHARD'S, NOT AN OPTIMISATION: base-caused is asked FIRST because it exonerates
 * every diff at once. PURE FOLD, NO I/O — a classifier costing a network read per PR is not worth
 * having.
 */
export type RedCause = "base-caused" | "gate-conflict" | "environment" | "in-diff";

/**
 * The Standing rule 25 refusal text `renderReviewSummary` emits. Matched as TEXT because the
 * structured `ReviewVerdict.instrumentEntangled` boolean is not carried on {@link OpenPrView} —
 * see {@link namesUnsatisfiableGate} for what that costs and why it is still safe.
 */
const UNSATISFIABLE_GATE_MARKER = /entangled: instrument path\(s\)/i;

/** A log tail shorter than this cannot establish a ratio — too few lines to be near-total. */
const ENVIRONMENT_MIN_TAIL_LINES = 4;
/** The share of log-tail lines that must be the SAME line before one message is "near-total". */
const ENVIRONMENT_REPEAT_RATIO = 0.9;

/**
 * The required check failing on EVERY open PR in this pass, or `undefined`.
 *
 * THE VACUITY GUARD IS THE LOAD-BEARING PART: with a single open PR the claim is trivially true of
 * its own failure, so a lone broken diff would exonerate itself. Fewer than two returns
 * `undefined`. Any PR NOT failing this check also yields `undefined` — a base outage reddens all
 * of them, so a survivor is evidence AGAINST the base, and that fails toward dispatching.
 */
export function baseCausedCheckName(pr: OpenPrView, allPrs: readonly OpenPrView[]): string | undefined {
  const own = pr.ciFailures ?? [];
  if (own.length === 0) return undefined;
  if (allPrs.length < 2) return undefined;
  for (const failure of own) {
    const onEveryPr = allPrs.every((other) =>
      (other.ciFailures ?? []).some((candidate) => candidate.name === failure.name),
    );
    if (onEveryPr) return failure.name;
  }
  return undefined;
}

/**
 * True when the review named a condition no patch can satisfy (Standing rule 25 entanglement).
 * READS BOTH CARRIERS BECAUSE ONE IS CURRENTLY INERT, worth stating rather than hiding.
 *
 * THE SAFETY PROPERTY IS STRUCTURAL, NOT DETECTIVE: a rule-25 refusal fails the review COMMIT
 * STATUS, which `checksState` excludes, so such a PR is review-red and never checks-red. The
 * stand-down fires only on `ciFailures`, so a gate conflict cannot be stood down even if this
 * returns false. Detection changes the ledger's reason text, not whether the escalation survives.
 */
export function namesUnsatisfiableGate(pr: OpenPrView): boolean {
  if (pr.reviewSummary && UNSATISFIABLE_GATE_MARKER.test(pr.reviewSummary)) return true;
  return pr.unmetCriteria.some((criterion) => UNSATISFIABLE_GATE_MARKER.test(criterion.reason));
}

/**
 * The check whose log tail is one message repeated near-totally, or `undefined`.
 * `findSiblingDisagreements` is the other half of this discriminator and is DELIBERATELY NOT
 * CALLED: it needs BOTH poles, and {@link OpenPrView} carries failures only. Reimplementing its
 * fold here is what its own doc forbids, so the ratio arm carries this class alone and the sibling
 * arm is named as available work rather than faked.
 */
export function environmentFaultCheckName(pr: OpenPrView): string | undefined {
  for (const failure of pr.ciFailures ?? []) {
    const lines = failure.logTail
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length < ENVIRONMENT_MIN_TAIL_LINES) continue;
    const counts = new Map<string, number>();
    for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
    let mostRepeated = 0;
    for (const count of counts.values()) if (count > mostRepeated) mostRepeated = count;
    if (mostRepeated / lines.length >= ENVIRONMENT_REPEAT_RATIO) return failure.name;
  }
  return undefined;
}

/**
 * The pure fold itself — see {@link RedCause} for the four classes and why this order.
 */
export function classifyRedCause(pr: OpenPrView, allPrs: readonly OpenPrView[]): RedCause {
  if (baseCausedCheckName(pr, allPrs) !== undefined) return "base-caused";
  if (namesUnsatisfiableGate(pr)) return "gate-conflict";
  if (environmentFaultCheckName(pr) !== undefined) return "environment";
  return "in-diff";
}

/**
 * The two classes the fix rung cannot reach, and therefore the only two that change behaviour.
 * `in-diff` dispatches exactly as before; `gate-conflict` refuses and escalates byte-identically.
 * A stand-down leaves `acted:false`, and `priorActionsFromLedger` skips those rows — so no strike
 * is spent and the PR is re-derived fresh next pass.
 */
export function redCauseStandsDown(cause: RedCause): boolean {
  return cause === "base-caused" || cause === "environment";
}

/**
 * The stand-down reason carried on the EXISTING `sweep.disposed` line, not a new ledger step.
 * This class is READ by the dispatch decision itself, which is what makes it an actor rather than
 * a fourth dead signal beside `daemon.tree_dirty` and `CiFailure.outsidePrRange`.
 */
export function describeRedCause(cause: RedCause, pr: OpenPrView, allPrs: readonly OpenPrView[]): string {
  if (cause === "base-caused") {
    const name = baseCausedCheckName(pr, allPrs) ?? "a required check";
    return `red cause: base-caused — ${name} is failing on all ${allPrs.length} open PRs this pass, so it is not this diff; no strike spent`;
  }
  const name = environmentFaultCheckName(pr) ?? "a required check";
  return `red cause: environment — ${name} repeats one message across its whole log tail, an environment fault rather than a diff defect; no strike spent`;
}

/**
 * W1-T2620 — per PR, the `main_tip_sha` most recently recorded on a base-caused `sweep.disposed`
 * row: the marker this task rides on the EXISTING step, never a fourth ledger signal.
 * `undefined` for a PR never observed base-caused, since nothing has advanced without a baseline.
 * Reads `main_tip_sha` alone, never prose: that field is written only from the base-caused branch,
 * so no text match is needed to tell those rows apart.
 */
export function lastBaseCausedTipFromLedger(lines: readonly Record<string, unknown>[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of lines) {
    if (line.step !== "sweep.disposed") continue;
    if (typeof line.pr_number !== "number") continue;
    if (typeof line.main_tip_sha !== "string") continue;
    // Ledger lines are append-ordered — the LAST match for a given PR is its most recent.
    out.set(line.pr_number, line.main_tip_sha);
  }
  return out;
}

/**
 * W1-T2620 — AT MOST ONE base-caused PR released per pass, oldest activity first. THE RELEASE
 * CONDITION IS "main has moved since this PR last stood down", never "the cause is known". A PR
 * with no prior record is NOT eligible: with no baseline nothing has advanced, so it stands down
 * and gets its first tip recorded. Ordered by the SAME comparator the other selectors use, so a
 * loser is strictly older next pass and cannot starve.
 */
export function selectBaseCausedRelease(
  prs: readonly OpenPrView[],
  mainTipSha: string,
  lastBaseCausedTipByPr: ReadonlyMap<number, string>,
  now: number,
): OpenPrView | undefined {
  const eligible = prs.filter((pr) => {
    if (classifyRedCause(pr, prs) !== "base-caused") return false;
    const lastTip = lastBaseCausedTipByPr.get(pr.prNumber);
    return lastTip !== undefined && lastTip !== mainTipSha;
  });
  if (eligible.length === 0) return undefined;
  return oldestActivityFirst(eligible, now);
}

export interface StaleBaseReleaseTarget {
  pr: OpenPrView;
  decision: RedBaseRefreshDecision;
  mainTipSha: string;
}

/** Successful queue-maintenance releases, keyed on every input the write depended on. */
export function staleBaseReleaseKeysFromLedger(lines: readonly Record<string, unknown>[]): Set<string> {
  const keys = new Set<string>();
  for (const line of lines) {
    // A successful red-base refresh is still the existing update-branch action. Reuse its
    // decision-relevant, rotation-safe marker; `main_tip_sha` distinguishes this lane from the
    // stale-gate updater, whose rows do not carry that input.
    if (line.step !== "sweep.update_branch.updated") continue;
    if (typeof line.pr_number !== "number" || typeof line.head_sha !== "string" || typeof line.main_tip_sha !== "string") continue;
    keys.add(`${line.pr_number}@${line.head_sha}@${line.main_tip_sha}`);
  }
  return keys;
}

/**
 * W1-T2789 — choose at most one strike-exhausted, checks-red PR whose exact failing path changed
 * on a positively newer base. Candidates are inspected oldest-first, and only a successful prior
 * release of this exact `(PR, head, main tip)` suppresses it. An unreadable comparison abstains.
 */
export async function selectStaleBaseRelease(
  prs: readonly OpenPrView[],
  policy: SweepPolicy,
  now: number,
  mainTipSha: string | undefined,
  priorReleaseKeys: ReadonlySet<string>,
  readFacts: ((pr: OpenPrView) => RedBaseRefreshFacts | Promise<RedBaseRefreshFacts>) | undefined,
  onReadError: (pr: OpenPrView, error: unknown) => void = () => {},
): Promise<StaleBaseReleaseTarget | undefined> {
  if (mainTipSha === undefined || readFacts === undefined) return undefined;
  const remaining = prs.filter((pr) => {
    if (!isBlockedCi(pr) || (pr.ciFailures?.length ?? 0) === 0) return false;
    if (deriveDisposition(pr, policy, now).disposition !== "blocked-ambiguous") return false;
    if (pr.priorStrikes < fixCeilingInForce(pr, policy.strikeCap, policy.clarify)) return false;
    return !priorReleaseKeys.has(`${pr.prNumber}@${pr.headSha}@${mainTipSha}`);
  });
  while (remaining.length > 0) {
    const candidate = oldestActivityFirst(remaining, now)!;
    remaining.splice(remaining.indexOf(candidate), 1);
    try {
      const decision = decideRedBaseRefresh(candidate.ciFailures ?? [], await readFacts(candidate));
      if (decision.refresh) return { pr: candidate, decision, mainTipSha };
    } catch (error) {
      // Deliberate fail-closed read: attribute the outage, skip this candidate, and preserve the
      // ordinary blocked disposition. A missing compare must never manufacture update authority.
      onReadError(candidate, error);
    }
  }
  return undefined;
}

/**
 * The named "why is this actually blocked" states an escalation must distinguish (W1-T186), never
 * a single overloaded `checksState`/`reviewState` pair. Exactly one applies, or none for an
 * ordinary review-failure block:
 *   - CONFLICTED: observed dirty. Zero check runs is EXPECTED — GitHub does not start checks on an
 *     unmergeable ref. Action: merge main into the branch.
 *   - FAILING: a required check ran and CONCLUDED failure. Action: name it.
 *   - ABSENT: a required context has ZERO observed runs on an otherwise-mergeable PR. Action: post it.
 *   - PENDING: checks exist and are still running. Action: wait, then escalate past the ceiling.
 *   - GATE_UNREADABLE (W1-T2399): the repo-wide protection read failed — a fact about the REPO,
 *     not this PR's checks, and reported as ABSENT before, contradicting its own green checks.
 *
 * CHECKED IN THIS ORDER, CONFLICTED FIRST: reading "none" before "dirty" mis-sorts a conflicted PR
 * as ABSENT and posts a check that can never run until the conflict resolves (#412/#413).
 */
export type ObservedBlockerState = "CONFLICTED" | "FAILING" | "ABSENT" | "PENDING" | "GATE_UNREADABLE";

export function observedBlockerState(pr: OpenPrView): ObservedBlockerState | undefined {
  if (pr.mergeState === "dirty" || pr.mergeable === false) return "CONFLICTED";
  // CHECKED BEFORE reviewState, mirroring DISPOSITION_RULES row 4/5's own "ci-log wins"
  // precedence (a review verdict beside a red required check may be STALE — computed before the
  // push that broke it): FAILING fires regardless of what the review says.
  if (pr.checksState === "red") return "FAILING";
  // A failing REVIEW (checks not red) already names its own block via the criterion/contradictory
  // text — PENDING/ABSENT below would misframe that as "wait" or "post the check" when the
  // review verdict is the actual thing blocking merge.
  if (pr.reviewState === "failure") return undefined;
  if (pr.checksState === "pending") return "PENDING";
  if (pr.checksState === "none") return "ABSENT";
  // W1-T2399 — CHECKED BEFORE THE W1-T176 SHAPE BELOW, because when the repo-wide read failed we
  // do not KNOW that any context is absent: `checksState` is green, so the PR's own checks plainly
  // ran. Reporting ABSENT here asserts zero observed check runs on a head that has them, which is
  // the false sentence this task exists to remove. The DISPOSITION is untouched — a PR reaching
  // here still falls to the same terminal catch-all and still escalates (W1-T176 boundary (ii)).
  if (pr.checksState === "green" && pr.reviewState === "none" && pr.requiredContextsUnreadable === true) {
    return "GATE_UNREADABLE";
  }
  // The W1-T176 shape: every OTHER required context is green, but remudero-review specifically
  // has zero observed runs — invisible to the branch above because overall checksState reads
  // "green", not "none" (only the one required context is absent).
  if (pr.checksState === "green" && pr.reviewState === "none") return "ABSENT";
  return undefined;
}

/** Why the ABSENT-check-suite remedy did or did not fire, so both outcomes are legible. */
export type AbsentRepushDecision =
  | { repush: true; reason: string }
  | { repush: false; reason: string };

/** How many empty-commit re-pushes ONE PR may earn before the remedy stands down and the
 *  ordinary escalation takes over. Mirrors `fixStrikeCap`'s role for the fix rung: a bound on
 *  a remedy that would otherwise retry forever on a PR GitHub simply never schedules. */
export const ABSENT_REPUSH_CAP = 1;

/**
 * THE ABSENT-CHECK-SUITE REMEDY'S DECISION (W1-T186 follow-up). PURE: every inch of evidence is a
 * parameter, so the real cases are fixtures rather than a live experiment. GitHub sometimes creates
 * NO check-suite for a pushed sha, and pushing a fresh sha created them immediately every time.
 *
 * THE DISCRIMINATOR IS ABSENT vs PENDING, and BOTH halves are required, because re-pushing a PR
 * whose checks merely have not STARTED cancels in-flight runs and resets the review. STRUCTURE
 * reuses {@link checksStateFromRollup}: only a COMPLETELY EMPTY rollup reads "none". TIME bounds
 * the seconds before the first context registers, clocked on `lastActivityAt` — anything else
 * advancing it only makes the PR look YOUNGER, so the error direction is toward doing nothing.
 *
 * The W1-T176 sub-shape and a PASSING REVIEW are both DELIBERATELY EXCLUDED: the review is posted
 * per head sha, so minting a new sha discards the expensive artifact in this system.
 * // Why: #921 escalated 244 times over 7h45m with no remedy — docs/forensics/sweep.md.
 */
/**
 * W1-T1103 — minutes since this head was last pushed. Factored out so the NOT-YET-SCHEDULED row
 * reads the IDENTICAL clock: "re-push yet?" and "escalate yet?" are one question about one input.
 */
export function absentAgeMinutes(pr: OpenPrView, now: number): number | undefined {
  const pushedAt = Date.parse(pr.lastActivityAt);
  if (Number.isNaN(pushedAt)) return undefined;
  return (now - pushedAt) / 60_000;
}

export function absentChecksRepushDecision(
  pr: OpenPrView,
  policy: SweepPolicy,
  now: number,
  priorRepushes: { count: number; shas: ReadonlySet<string> },
): AbsentRepushDecision {
  if (observedBlockerState(pr) !== "ABSENT") {
    return { repush: false, reason: "not the ABSENT state" };
  }
  // Structure half — excludes the W1-T176 green+review-none sub-shape by construction.
  if (pr.checksState !== "none") {
    return {
      repush: false,
      reason: `ABSENT via the review-only shape (checksState=${pr.checksState}) — the post-review lane owns this, not a re-push`,
    };
  }
  // A certification already earned must never be thrown away to chase a check suite.
  if (pr.reviewState === "success") {
    return { repush: false, reason: "review already PASSED on this head — a re-push would discard the certification" };
  }
  if (!pr.headRefName) {
    return { repush: false, reason: "head branch name not observed — nothing to push to" };
  }
  // Time half.
  const ageMin = absentAgeMinutes(pr, now);
  if (ageMin === undefined) {
    return { repush: false, reason: "head age unreadable — never re-push on state we cannot date" };
  }
  if (ageMin < policy.absentCeilingMinutes) {
    return {
      repush: false,
      reason: `checks may still be starting (${ageMin.toFixed(1)}m < ${policy.absentCeilingMinutes}m ceiling) — waiting`,
    };
  }
  // Idempotence within a head: sha-keyed, the SAME shape `prior.fixed` uses and #968 gave
  // `prior.armed`. Without it a single stuck head would earn a fresh commit every pass.
  if (priorRepushes.shas.has(`${pr.prNumber}@${pr.headSha}`)) {
    return { repush: false, reason: `already re-pushed this head (${pr.headSha.slice(0, 7)})` };
  }
  // The BOUND, per PR rather than per head — a re-push MINTS a new sha, so a sha key alone
  // would license an unbounded chain of commits on a PR GitHub never schedules.
  if (priorRepushes.count >= ABSENT_REPUSH_CAP) {
    return {
      repush: false,
      reason: `ABSENT re-push cap reached (${priorRepushes.count}/${ABSENT_REPUSH_CAP}) — escalating instead`,
    };
  }
  return {
    repush: true,
    reason:
      `zero check runs on head ${pr.headSha.slice(0, 7)} after ${ageMin.toFixed(0)}m (ceiling ` +
      `${policy.absentCeilingMinutes}m) — GitHub created no check-suite; minting a fresh head sha`,
  };
}

/**
 * Name the FAILING check(s) + the sha each ran against (W1-T186) — "checks red" is not
 * actionable, "commitlint failed on 0e63429" is. Falls back to a generic sentence when no
 * per-check detail was captured (never silent, never a crash), and — the #420 fixture — says so
 * explicitly when a check's own sha is OBSERVED to sit outside this PR's own commit range.
 */
function describeCiFailures(pr: OpenPrView): string {
  const failures = pr.ciFailures ?? [];
  if (failures.length === 0) {
    return (pr.redRequiredChecks ?? []).length > 0 ? `required check(s) already concluded red on head ${pr.headSha.slice(0, 7)} while ci-gate's own aggregate still reads "${pr.checksState}": ${(pr.redRequiredChecks ?? []).join(", ")}` : `a required check failed on head ${pr.headSha.slice(0, 7)} (no failing-check detail captured)`; // W1-T2504
  }
  return failures
    .map((f) => {
      const sha = (f.sha ?? pr.headSha).slice(0, 7);
      const rangeNote = f.outsidePrRange
        ? " — NOT one of this PR's own commits; only present on the base branch"
        : "";
      // the named-log-outcome change: an escalation that names a check but no reason reads as "it failed and we saw
      // why"; it is the operator, not the reader, who then discovers the log was never read at
      // all. Say so in the SAME sentence that names the check, via the one shared renderer.
      const logNote = f.logUnavailable ? ` — ${describeCiLogUnavailable(f.logUnavailable)}` : "";
      return `${f.name} failed on ${sha}${rangeNote}${logNote}`;
    })
    .join("; ");
}

/** The `mergeable`/`mergeableState` facts line every escalation carries when observed (W1-T186,
 *  acceptance 2) — "" when neither was read, so callers can omit it cleanly. */
function mergeableFactLine(pr: OpenPrView): string {
  if (pr.mergeable === undefined && pr.mergeableState === undefined) return "";
  return `observed mergeable=${pr.mergeable ?? "unknown"}, mergeableState=${pr.mergeableState ?? "unknown"}`;
}

/**
 * Render the named observed-blocker facts (W1-T186) prepended to every clarification question, so
 * the operator sees WHICH state fired and the facts supporting it. "" when none was named.
 *
 * FALSIFIER-SHAPED CONSTRAINT: the CONFLICTED branch must never contain the word "CI" or the token
 * "blocked_ci" — both are FALSE for a conflicted PR, and #412/#413 is exactly an escalation that
 * said so for a PR that was neither.
 */
function renderObservedFacts(pr: OpenPrView, state: ObservedBlockerState | undefined): string {
  const mergeableFact = mergeableFactLine(pr);
  const suffix = mergeableFact ? ` (${mergeableFact})` : "";
  switch (state) {
    case "CONFLICTED":
      return (
        `[CONFLICTED]${suffix} this PR cannot merge as observed; zero check runs here is EXPECTED ` +
        `(GitHub does not start checks on an unmergeable ref), not a signal that anything is blocked or ` +
        `pending review. Remedy: merge origin/main into the branch to resolve the conflict, then push to ` +
        `re-trigger checks.`
      );
    case "FAILING":
      return `[FAILING]${suffix} ${describeCiFailures(pr)}.`;
    case "ABSENT":
      return (
        `[ABSENT]${suffix} the required check has ZERO observed check runs on head ` +
        `${pr.headSha.slice(0, 7)} — it has not started at all, not merely running slowly.`
      );
    case "GATE_UNREADABLE": {
      // W1-T2399: names the REPO-WIDE read as the observed blocker, including the branch it could
      // not read and the classified reason, rather than asserting anything about this PR's checks.
      const f = pr.requiredContextsReadFailure;
      const where = f ? `branch protection on \`${f.branch}\`` : "branch protection";
      const why = f ? ` — ${f.reason}` : "";
      return (
        `[GATE_UNREADABLE]${suffix} this PR's own checks are GREEN on head ${pr.headSha.slice(0, 7)}; ` +
        `what could not be read is ${where}${why}, a REPO-WIDE read that this sweep pass makes once. ` +
        `An unreadable gate is never assumed permissive (W1-T176), so the merge is held — but nothing ` +
        `here is a claim about this PR's check runs. Remedy: restore the protection read (token scope, ` +
        `\`gh\` availability, network), then the next pass disposes this PR on its real state.`
      );
    }
    case "PENDING":
      return `[PENDING]${suffix} required checks are still running on head ${pr.headSha.slice(0, 7)}.`;
    default:
      return mergeableFact ? `(${mergeableFact})` : "";
  }
}

/**
 * One row of the POLICY-AS-DATA table (rule 2): an observed-state predicate, the disposition it
 * produces, and the stated reason. Selection lives in {@link DISPOSITION_RULES} — a data
 * structure, never imperative branches — the same shape the dep and alert lanes use. Adding,
 * removing or reordering a disposition is a TABLE edit, never a code branch.
 */
interface DispositionRule {
  readonly disposition: Disposition;
  /**
   * Observed-state predicate over the PR and the tunable {@link SweepPolicy} thresholds. `now` is
   * the same sweep-pass clock {@link ageDays} came from, threaded so the WAIT and stale-pending
   * rows derive the pending age without a second, independently-sourced clock.
   */
  readonly when: (pr: OpenPrView, policy: SweepPolicy, ageDays: number, now: number) => boolean;
  readonly reason: (pr: OpenPrView, policy: SweepPolicy, ageDays: number, now: number) => string;
}

/**
 * W1-T114 — minutes checks have been pending on this head, or `undefined` when there is nothing to
 * date. PURE and fail-toward-undefined: never guesses an age observed state cannot support.
 *
 * THE FALLBACK IS THE WHOLE FIX: `checksPendingSince` was never wired by any producer, so both
 * rows required a value that was always `undefined` and every pending PR escalated.
 * `lastActivityAt` IS populated, so the bound goes live with no gateway change. It is A CEILING ON
 * WAITING, NOT A LICENCE TO IGNORE — past the ceiling the stale-pending row still escalates, and
 * the precise field wins when present so wiring it later is a pure upgrade.
 * // Why: the dead bound produced 57 needs-human issues in one day — docs/forensics/sweep.md.
 */
function pendingAgeMinutes(pr: OpenPrView, now: number): number | undefined {
  const raw = pr.checksPendingSince ?? pr.lastActivityAt;
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return undefined;
  return (now - parsed) / 60_000;
}

/**
 * W1-T913 — minutes `remudero-review` has read PENDING on this head, posted by this system
 * itself, or `undefined` when there is nothing to date. Mirrors {@link pendingAgeMinutes}'s
 * fallback discipline exactly: the precise field wins when present, `lastActivityAt` stands in
 * otherwise, so a pending PR is never stranded because a producer lagged or a rotation ate its row.
 */
function reviewPendingAgeMinutes(pr: OpenPrView, now: number): number | undefined {
  const raw = pr.reviewPendingSince ?? pr.lastActivityAt;
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return undefined;
  return (now - parsed) / 60_000;
}

/**
 * W1-T913 — is a currently-PENDING review old enough that the sweep should stop trusting it and
 * offer this head to the post-review lane again? Reuses `policy.pendingCeilingMinutes` rather than
 * a second threshold that could drift from it.
 *
 * UNDATED READS STALE — the OPPOSITE direction from the re-push remedy's caution, which exists
 * because a wrong re-push discards a real in-flight run. Re-offering this head risks no such loss:
 * a redundant pending post is a no-op. A pending that no path can re-drive does not ship.
 */
function reviewPendingIsStale(pr: OpenPrView, policy: SweepPolicy, now: number): boolean {
  const age = reviewPendingAgeMinutes(pr, now);
  return age === undefined || age >= policy.pendingCeilingMinutes;
}

/**
 * W1-T1018 — the ELAPSED-TIME BACKOFF replacing permanent cessation. Has enough wall-clock time
 * passed since this input's last completed judgment for the cap row to YIELD?
 *
 * ESCALATE AND KEEP GOING, NEVER ESCALATE INSTEAD OF GOING: the cap still fires the first time,
 * then the lane resumes once the backoff elapses — never a permanent wall, only a paced one. The
 * reset is structural, since a new head or body creates another digest. FAILS TOWARD ESCALATING,
 * never toward silent retrying, which is the dangerous direction.
 */
export function reviewInputBackoffElapsed(pr: OpenPrView, policy: SweepPolicy, now: number): boolean {
  if (!pr.reviewInputLastAttemptAt) return false;
  const last = Date.parse(pr.reviewInputLastAttemptAt);
  if (Number.isNaN(last)) return false;
  return now - last >= policy.reviewOrphanBackoffMinutes * 60_000;
}

/**
 * W1-T2299 — THE SUPERSEDED-INPUT DETECTOR: has anything happened to this PR AFTER its current
 * verdict was posted? NAMED FOR WHAT IT DETECTS — "activity", never "a body edit", since GitHub
 * carries no body-specific timestamp. That coarseness is tolerable because the consumer ALSO
 * requires zero judgments for the current digest, which only a real correction resets.
 * FAILS CLOSED: a missing timestamp reads `false`, so "cannot tell" is never treated as "it did".
 */
export function reviewVerdictOvertakenByActivity(pr: OpenPrView): boolean {
  if (!pr.reviewVerdictPostedAt) return false;
  const verdictAt = Date.parse(pr.reviewVerdictPostedAt);
  if (Number.isNaN(verdictAt)) return false;
  const activityAt = Date.parse(pr.lastActivityAt);
  if (Number.isNaN(activityAt)) return false;
  return activityAt > verdictAt;
}

/**
 * THE POLICY TABLE — ordered rules mapping observed PR-state to a disposition. Precedence is TABLE
 * ORDER, first match wins, and the terminal row matches unconditionally, so the "no disposition is
 * ever none" invariant is STRUCTURAL rather than a branch. Because the mapping is DATA, a test or
 * a policy edit flips a disposition with no change to {@link deriveDisposition}. Each row's own
 * comment states its trap and citation; this is the index.
 *
 *   0.   VERDICT-SUPERSEDED (W1-T920) — a `"superseded"` verdict closes. Reads ONLY `status`.
 *   1.   SUPERSEDED — a newer PR credits the same task; close. YIELDS on `"unique"` (W1-T932).
 *   2.   STALE — no activity in >= `policy.staleDays`; close.
 *   3.   ANSWERED (W1-T78) — an operator's answer re-arms the rung past the original cap.
 *   3.5. VERDICT OVERTAKEN BY ACTIVITY (W1-T2299) — activity since the verdict, zero judgments
 *        for the current digest; re-run the lane.
 *   3.6. UNOWNED FAILURE RECOVERY — a failure the ledger has no judgment for; re-run once.
 *   4.   FAILING + strikes exhausted -> escalate. Covers blocked_ci: one counter, one route.
 *   5.   blocked_ci — a required check is red, strikes left -> ci-log fix mode. ORDERED BEFORE the
 *        review rows, because a verdict beside a red required check may be STALE.
 *   5.5. Unmet criteria repeat claim-for-claim (W1-T1269) -> escalate BEFORE the cap.
 *   6.   FAILING + actionable unmet criteria -> fix rung. Also a GATE failure naming a
 *        single-form remedy (W1-T923) — a third disjunct, never a separate row.
 *   7.   FAILING + no actionable criteria (contradictory) -> escalate.
 *   7.5. CONFLICTED (W1-T106) — ABOVE mergeable, so a conflicting PR is NEVER armed however green.
 *        Only a pure-addition or declared-generator conflict auto-resolves; the rest escalate.
 *   8.   CI GREEN + REVIEW SUCCESS, POSITIVELY matched only -> mergeable (arm).
 *   8.5. ZERO-RUNS REQUIRED CHECK (W1-T176) — first sighting posts the review; a SECOND absence
 *        after a refusal escalates, checked first so a refused head never loops.
 *   8.6. REVIEW ORPHANED BY A PUSH (W1-T225) — same dispatch, a reason naming the orphaning. At
 *        cap it escalates only while {@link reviewInputBackoffElapsed} reads false.
 *   8.7. STALLED-BY-A-TERMINAL-RUN (W1-T2340) — the run that pinned the job has concluded, so
 *        nothing is left to wait for. Ordered before WAIT for that reason.
 *   9.   WAIT (W1-T114) — pending with a datable, in-window start; no action, ledgered.
 *  10.   STALE-PENDING — the same predicate past the ceiling; escalate naming the elapsed minutes.
 *  11.   TERMINAL catch-all (W1-T93) — the LEAST permissive disposition, never the most.
 *        `mergeable` is only ever positively matched at row 8, never reached as a fallback.
 */
export const DISPOSITION_RULES: readonly DispositionRule[] = [
  {
    // W1-T920 (DECISIONS.md #1987) — ROUTED THROUGH THE EXISTING "stale" disposition, never a new
    // one: that case already closes reversibly and already writes ONE `sweep.disposed` row, and
    // no new ledger step ships without a named reader. A NEW ROW, not a change to the bare-number
    // row below: this one matches a REASON-bearing verdict, gated and default OFF, and reads
    // NOTHING about the PR but `status`. `"unique"` and `"indeterminate"` are both inert here.
    disposition: "stale",
    when: (pr, policy) => policy.supersessionDisposalEnabled === true && pr.supersessionVerdict?.status === "superseded",
    // Guards `evidence` defensively (never a `!` assertion) even though `when` above already
    // requires `status === "superseded"`: a malformed verdict must degrade to a legible reason,
    // never throw and abort the whole sweep pass over one bad producer.
    reason: (pr) => {
      const ev = pr.supersessionVerdict?.evidence;
      if (!ev) return `superseded — but the verdict carried no evidence (${pr.supersessionVerdict?.detail ?? "malformed verdict"})`;
      return (
        `superseded by #${ev.supersedingPrNumber} (task ${ev.taskId}) — diff: ${ev.diff.matchedHunks} hunk(s) ` +
        `over ${ev.diff.rawLineCount} raw line(s) [corpus control]`
      );
    },
  },
  {
    // W1-T932 — LETS THIS ROW YIELD, NEVER DISABLES IT: a guard that works for ordinary duplicate
    // PRs must keep working, and an ordinary duplicate carries no verdict at all, so the added
    // clause is false for it and this row matches as it always has. Gated behind
    // `conceptCoexistenceEnabled`, a SEPARATE flag from row 0's. Reads ONLY `status === "unique"`,
    // never `"indeterminate"` or an absent verdict — fail CLOSED to today's arithmetic.
    disposition: "stale",
    when: (pr, policy) =>
      pr.supersededBy != null &&
      pr.supersessionVerdict?.status !== "complementary" &&
      !(policy.conceptCoexistenceEnabled === true && pr.supersessionVerdict?.status === "unique"),
    reason: (pr) => `superseded-by #${pr.supersededBy}`,
  },
  {
    disposition: "stale",
    when: (_pr, policy, ageDays) => ageDays >= policy.staleDays,
    reason: (_pr, policy, ageDays) =>
      `abandoned — no activity in ${Math.floor(ageDays)}d (>= ${policy.staleDays}d threshold)`,
  },
  {
    // W1-T54's dep lane, ROUTED. Before this row dep PRs sat ungated until an operator ran
    // `rmd dep-review` by hand, and the failure rows below would misroute them — a ci-log fix rung
    // must never push commits onto a Dependabot branch. The lane holds on red checks and escalates
    // majors, so routing is safe in every state; superseded and stale above still close first.
    disposition: "dep-review",
    when: (pr) => pr.isDependabot === true,
    reason: (pr) => `dependabot PR — dep-review lane (checks ${pr.checksState}, review ${pr.reviewState})`,
  },
  {
    // W1-T78: an operator's answer RE-ARMS the fix rung, but only within its own strike
    // allowance, so a bad answer still eventually escalates rather than looping. W1-T100
    // generalised it to the blocked_ci shape via the same `isBlockedCi` rows 4 and 5 share —
    // without that, a strike-exhausted blocked_ci PR could never be re-armed by an answer.
    disposition: "blocked-fixable",
    when: (pr, policy) => {
      if (!pr.pendingAnswer) return false;
      const reviewShape = pr.reviewState === "failure" && pr.unmetCriteria.length > 0;
      if (!reviewShape && !isBlockedCi(pr)) return false;
      const clarify: ClarifyPolicy = {
        resetStrikeCounterOnAnswer: pr.pendingAnswer.resetStrikeCounter ?? policy.clarify.resetStrikeCounterOnAnswer,
      };
      // `strikeCapForAnswer` returns the ADDITIONAL strikes an answer grants, so the cumulative
      // ceiling is the ORIGINAL cap plus that allowance — never an unconditional bypass of the
      // ledger's running count.
      return pr.priorStrikes < policy.strikeCap + strikeCapForAnswer(policy.strikeCap, clarify);
    },
    reason: (pr) =>
      `operator answered the clarification question — re-dispatching the fix rung with the added constraint (strike ${pr.priorStrikes + 1})`,
  },
  {
    // W1-T2299 — A CORRECTED INPUT CAN REACH THE REVIEWER THAT JUDGED THE OLD ONE. Rows 4/6/7 claim
    // every failing PR and none reads a timestamp, so a posted FAILURE used to make a head
    // permanently unofferable. Requires STRICT ZERO judgments for this exact head+body digest, so
    // coarse activity leaving the digest unchanged falls through to those rows.
    //
    // THE REVIEWER KEEPS ITS TEETH — only WHICH INPUT is judged changes, and a fresh verdict is
    // posted from scratch, so a re-offered head can still fail. NOT AUTHORITY TO OVERWRITE A
    // DIFFERENT BODY (W1-T2793): the guarded status site re-compares the digest before publishing.
    disposition: "post-review",
    when: (pr) =>
      pr.checksState === "green" &&
      pr.requiredContextsUnreadable !== true &&
      pr.reviewState === "failure" &&
      reviewVerdictOvertakenByActivity(pr) &&
      pr.priorReviewAttemptsForInput === 0,
    reason: (pr) =>
      `checks green, remudero-review failed but the PR has seen activity since that verdict was posted ` +
      `(GitHub's PR object carries no body-specific timestamp, so this is activity-after-a-verdict, not ` +
      `provably a body edit), and the exact current input has no completed judgment — re-running ` +
      `the review lane on #${pr.prNumber} to judge the current input; ` +
      `a fresh verdict is posted and the prior one is never carried forward`,
  },
  {
    // GitHub can carry an exact-head remudero-review FAILURE this daemon never ledgered — an
    // externally posted status, lost state, or a host move. The generic failure rows recover
    // structured reasons only from `review.posted`, so with no matching row they escalated
    // "contradictory" forever. Requiring STRICT zero, not undefined, keeps legacy callers
    // byte-identical; `reviewPostRefused` makes the recovery one-shot for an unchanged input.
    disposition: "post-review",
    when: (pr) =>
      pr.checksState === "green" &&
      pr.requiredContextsUnreadable !== true &&
      pr.reviewState === "failure" &&
      pr.reviewInputDigest !== undefined &&
      pr.priorReviewAttemptsForInput === 0 &&
      pr.reviewPostRefused !== true,
    reason: (pr) =>
      `checks green, remudero-review reports failure but the ledger has no matching completed ` +
      `review.posted evidence for this exact input — re-running the authoritative reviewer on ` +
      `#${pr.prNumber} to restore authoritative evidence in structured form; one exact-input post refusal stops retries`,
  },
  {
    // W1-T100: the exhaustion check now covers BOTH failure shapes — a failing
    // review AND a blocked_ci PR (checks red) — off the SAME strike counter/cap
    // (design note iv: one ladder, one exhaustion route).
    disposition: "blocked-ambiguous",
    when: (pr, policy) => (pr.reviewState === "failure" || isBlockedCi(pr)) && pr.priorStrikes >= policy.strikeCap,
    // W1-T186: once checks are the reason strikes exhausted, NAME the check and sha here too, so
    // the ledgered reason never reads as the generic, uninvestigable "fix strikes exhausted".
    //
    // W1-T2452: the denominator is {@link fixCeilingInForce}, NEVER the bare `policy.strikeCap` —
    // an answered PR renders against its EXTENDED ceiling, so reaching it reads as exactly that
    // rather than an impossible overshoot of the base cap.
    reason: (pr, policy) => {
      const ceiling = fixCeilingInForce(pr, policy.strikeCap, policy.clarify);
      return isBlockedCi(pr)
        ? `fix strikes exhausted (${pr.priorStrikes}/${ceiling}) — ${describeCiFailures(pr)} — escalating`
        : `fix strikes exhausted (${pr.priorStrikes}/${ceiling}) — escalating`;
    },
  },
  {
    // W1-T100, broadened and PROMOTED ahead of the review-failing rows by W1-T138: blocked_ci is
    // POSITIVELY fixable — never the catch-all's escalate, and never re-litigated as a
    // review-unmet block just because a possibly stale verdict also sits on this head. The
    // exhausted case already matched row 4, so only a non-exhausted checks-red PR reaches here.
    // Fix FIRST, ask only after exhaustion.
    disposition: "blocked-fixable",
    when: (pr) => isBlockedCi(pr),
    // W1-T2452: denominator is {@link fixCeilingInForce}, not the bare `policy.strikeCap` — see
    // that function's own doc; keeps this ratio naming the SAME ceiling the dispatch site
    // (`dispatchFix`, run-task.ts) actually budgets against.
    reason: (pr, policy) => `${pr.checksState === "red" ? "required checks red" : describeCiFailures(pr)} — ci-log fix, strike ${pr.priorStrikes + 1}/${fixCeilingInForce(pr, policy.strikeCap, policy.clarify)}`, // W1-T2504: "red" is byte-identical; else names the specific check.
  },
  {
    // W1-T1269 — AN EARLIER STOP, NEVER A LONGER LEASH. Ordered after row 4 (a PR at the cap
    // keeps that row's own reason) and after row 5 (checks-red still gets ci-log first), but
    // strictly before row 6, so a dispatch that would only reproduce a strike already proven to
    // add nothing is preempted the first time it recurs. `fixRungRepeatsIdenticalFailure` fails
    // CLOSED until a producer populates `StrikeAttempt.unmetClaims`, so this row is inert today.
    disposition: "blocked-ambiguous",
    when: (pr) => pr.reviewState === "failure" && fixRungRepeatsIdenticalFailure(pr),
    reason: (pr, policy) =>
      `fix strike repeated the identical unmet criteria (strike ${pr.priorStrikes}/${policy.strikeCap}) — ` +
      `no further strike can add information — escalating before the cap`,
  },
  {
    // Reached only when checks are NOT red (row 5 claimed that) and the unmet set is not a proven
    // repeat (row 5.5 claimed that) — a pure review-shaped block. Genuinely REACHABLE for a review
    // failure (W1-T394): `checksState` never goes red off `remudero-review` alone, so a
    // checks-green PR whose review fails lands here rather than being claimed by row 5.
    //
    // W1-T923 adds a THIRD disjunct, never a new rule: a GATE failure with empty `unmetCriteria`
    // that named a single-form remedy routes here exactly like a criterion failure. When
    // `unmetCriteria` is non-empty this row is byte-identical to before that task.
    disposition: "blocked-fixable",
    when: (pr) => pr.reviewState === "failure" && (pr.unmetCriteria.length > 0 || (pr.actionableGateFailures?.length ?? 0) > 0),
    // W1-T2452: denominator is {@link fixCeilingInForce} in both branches — see that
    // function's own doc; keeps this ratio naming the SAME ceiling the dispatch site
    // (`dispatchFix`, run-task.ts) actually budgets against.
    reason: (pr, policy) => {
      const ceiling = fixCeilingInForce(pr, policy.strikeCap, policy.clarify);
      if (pr.unmetCriteria.length > 0) {
        return `${pr.unmetCriteria.length} unmet criteri${pr.unmetCriteria.length === 1 ? "on" : "a"} — strike ${pr.priorStrikes + 1}/${ceiling}`;
      }
      const n = pr.actionableGateFailures!.length;
      return `${n} actionable gate failure${n === 1 ? "" : "s"} (named remedy) — strike ${pr.priorStrikes + 1}/${ceiling}`;
    },
  },
  {
    // W1-T440: the SAME empty `unmetCriteria` has two distinct causes, and the reason used to
    // name the wrong one unconditionally. `criteriaRecoverable === false` is the OBSERVED signal
    // that no trailer resolved a task id, so the criteria were never RECOVERABLE, not
    // contradicted. Anything else means a trailer DID resolve and the ledger genuinely returned
    // nothing unmet — that arm keeps today's wording verbatim for every attributable PR.
    disposition: "blocked-ambiguous",
    when: (pr) => pr.reviewState === "failure",
    reason: (pr) =>
      pr.criteriaRecoverable === false
        ? // W1-T2541: name the DERIVED repair, not only the defect. `diagnoseBodyDefects` reads the
          // Names the trailer the same way `projectPlan` does, so it invents nothing. Diagnosis
          // only: nothing here edits a body (see lib/body-repair.ts).
          // Why: measured 2026-08-31 on #3363/#3400/#3403 — docs/forensics/sweep.md.
          `review failing — criteria unrecoverable (no Remudero-Task: trailer to resolve them from) — escalating` +
          (() => {
            const d = diagnoseBodyDefects("", [], { headRef: pr.headRefName });
            const repair = d.find((x) => x.kind === "no-trailer")?.repair;
            return repair === undefined ? "" : ` — derived repair: add \`${repair}\` to the PR body`;
          })()
        : "review failing with no actionable unmet criteria (contradictory) — escalating",
  },
  {
    // W1-T106 — CONFLICTED is a POSITIVE disposition, ABOVE mergeable: a dirty PR is NEVER armed
    // however green. None of rows 3-7 reference `mergeState`, so this placement changes no
    // precedence; it only guarantees row 8 never sees a dirty PR. Deterministically fixable (rule
    // 2, never an LLM judgment) ONLY when {@link isPureConcurrentAddition} or
    // {@link isRegenerableArtifactConflict} clears EVERY file; a conflict satisfying neither arm
    // falls to the next row. Why: the flag's history and the #170 incident — docs/forensics/sweep.md.
    disposition: "conflicted",
    when: (pr, policy) => {
      if (policy.mergeConflictAdmissionEnabled !== true || pr.mergeState !== "dirty") return false;
      const files = pr.mergeConflict?.files ?? [];
      // W1-T2548: a SECOND, independent admission arm — either clears this row alone, never both
      // required. The registry arm is checked first only because its reason is the more specific
      // of the two when both happen to hold.
      return isRegenerableArtifactConflict(files) || isPureConcurrentAddition(files);
    },
    reason: (pr) => {
      const files = pr.mergeConflict?.files ?? [];
      if (isRegenerableArtifactConflict(files)) {
        const named = files.map((f) => `${f.path} (generator: ${REGENERABLE_ARTIFACT_GENERATORS[f.path]})`).join(", ");
        return (
          `merge conflict (mergeState dirty) — every conflicting path has a declared generator: ${named} — ` +
          `dispatching the merge-conflict fix mode to RE-RUN the generator(s) on the merged tree — the ` +
          `resolution is that output, never either side's recorded value`
        );
      }
      return (
        `merge conflict (mergeState dirty) — pure concurrent addition on ` +
        `${files.map((f) => f.path).join(", ")} — dispatching the merge-conflict fix mode`
      );
    },
  },
  {
    // W1-T106 — the OTHER half of the same strand: a dirty PR whose conflict involves a DELETION
    // on either side, or whose evidence could not be captured, is NEVER auto-resolved. "A wrong
    // auto-resolution is worse than a strand" (design note iii, verbatim). REFUSE into escalate,
    // the SAME blocked-ambiguous rung every other ambiguous block routes through, naming the
    // conflicting files so an operator need not re-derive them.
    //
    // W1-T984: this escalation names the real paths AND each side's deletion count, so
    // `files: none captured` now means evidence genuinely could not be read.
    disposition: "blocked-ambiguous",
    when: (pr) => pr.mergeState === "dirty",
    reason: (pr, policy) => {
      const files = pr.mergeConflict?.files ?? [];
      const fileList = files.map((f) => `${f.path} (ours -${f.oursDeleted}, theirs -${f.theirsDeleted})`).join(", ");
      return (
        `merge conflict (mergeState dirty) — ${conflictRefusalCause(files, policy)} — never auto-resolved — ` +
        `files: ${files.length > 0 ? fileList : "none captured"} — escalating`
      );
    },
  },
  {
    // W1-T2860 — GitHub can carry an exact-head remudero-review SUCCESS without the completed
    // `review.posted` row W1-T230 requires before arming. The status alone cannot recreate the
    // structured proof evidence, so route the contradiction through the same authoritative
    // reviewer. Deliberately symmetric with the unowned FAILURE recovery above: both identity
    // signals must be present and the count STRICTLY zero, so legacy callers stay mergeable.
    disposition: "post-review",
    when: (pr) =>
      pr.checksState === "green" &&
      pr.requiredContextsUnreadable !== true &&
      pr.reviewState === "success" &&
      pr.reviewInputDigest !== undefined &&
      pr.priorReviewAttemptsForInput === 0 &&
      pr.reviewPostRefused !== true,
    reason: (pr) =>
      `checks green and GitHub reports remudero-review success, but the ledger has no matching completed ` +
      `review.posted evidence for this exact input — re-running the authoritative reviewer on ` +
      `#${pr.prNumber} before auto-merge; one exact-input post refusal stops retries`,
  },
  {
    // POSITIVE MATCH ONLY (W1-T93): mergeable is NEVER inferred from the mere absence of a
    // failure. It requires required-checks green AND review success, named explicitly — P22's own
    // words, "required contexts green, review success, unmerged".
    disposition: "mergeable",
    when: (pr) => pr.checksState === "green" && pr.reviewState === "success",
    reason: () => "review success, required checks green — arming auto-merge",
  },
  {
    // W1-T176 — a required check with ZERO observed runs is DETERMINISTIC-ACTION, not
    // blocked-ambiguous, but only ONCE. Ordered STRICTLY BEFORE the post-review row so a PR whose
    // post already came back REFUSED for this head never re-reaches that dispatch: the remedy has
    // run its course, and retrying would loop against a lane that already declined. Uses the SAME
    // escalate path as every other ambiguous block, so an operator sees a genuine question
    // instead of the PR sitting silently deduped forever.
    disposition: "blocked-ambiguous",
    when: (pr) =>
      pr.checksState === "green" &&
      pr.reviewState === "none" &&
      pr.reviewPostRefused === true &&
      pr.requiredContextsUnreadable !== true,
    reason: () =>
      "required check (remudero-review) has zero observed check runs and the one deterministic post " +
      "attempt for this exact review input was refused — escalating rather than retrying indefinitely",
  },
  {
    // W1-T225 — THE LOOP FALSIFIER: a PR whose review was orphaned by a push re-earns the review
    // lane below, but not unboundedly for the SAME head+body input. Ordered strictly before that
    // row so a status that repeatedly disappears after completed judgments eventually asks an
    // operator. A new push or body edit resets the exact-input counter immediately. A PR awaiting
    // its FIRST review never matches — only one demonstrably reviewed before can exhaust this cap.
    // W1-T1018: the cap is no longer a PERMANENT wall — {@link reviewInputBackoffElapsed} must
    // ALSO read false, so once the backoff elapses this row yields and dispatch resumes.
    disposition: "blocked-ambiguous",
    when: (pr, policy, _ageDays, now) =>
      pr.checksState === "green" &&
      pr.reviewState === "none" &&
      pr.reviewOrphanedByPush === true &&
      (pr.priorReviewAttemptsForInput ?? 0) >= policy.reviewOrphanCap &&
      pr.requiredContextsUnreadable !== true &&
      !reviewInputBackoffElapsed(pr, policy, now),
    reason: (pr, policy) =>
      `review orphaned by a push, again — the sweep has already judged this unchanged review input ${pr.priorReviewAttemptsForInput} ` +
      `time(s) (>= ${policy.reviewOrphanCap} cap) — escalating; re-reviewing again after ` +
      `${policy.reviewOrphanBackoffMinutes}m of backoff, never stopping outright`,
  },
  {
    // POST-REVIEW ROUTING (the #584 stall, narrowed by W1-T176): a checks-GREEN PR whose review was
    // never posted used to fall to the catch-all and ESCALATE, so a hand-opened PR could sit fully
    // green forever. An ABSENT required check is mechanically decidable on its FIRST sighting, so
    // route it to the SAME `reviewCommand` the operator verb runs. A PR with no criteria posts FAIL
    // fail-closed, a LEGIBLE gate state rather than an escalation.
    //
    // W1-T225 also routes a review ORPHANED BY A PUSH here — identical dispatch, different reason,
    // prior verdict never carried forward. W1-T913/W1-T2844: `"pending"` matches once the owner is
    // proven dead or the pending is stale; a FRESH pending is EXCLUDED, claimed as `wait` below.
    disposition: "post-review",
    when: (pr, policy, _ageDays, now) =>
      pr.checksState === "green" &&
      pr.requiredContextsUnreadable !== true &&
      (pr.reviewState === "none" ||
        (pr.reviewState === "pending" &&
          (pr.reviewPendingOwnerDead === true || reviewPendingIsStale(pr, policy, now)))),
    reason: (pr, policy, _ageDays, now) => {
      if (pr.reviewState === "pending") {
        if (pr.reviewPendingOwnerDead === true) {
          return `checks green, remudero-review owner proven dead — re-running the review lane on #${pr.prNumber}`;
        }
        const age = reviewPendingAgeMinutes(pr, now);
        return (
          `checks green, remudero-review pending ${age !== undefined ? `${Math.floor(age)}m` : "for an undated interval"} ` +
          `(>= ${policy.pendingCeilingMinutes}m ceiling, or unreadable) — treating the stuck pending as ` +
          `unattended and re-running the review lane on #${pr.prNumber}`
        );
      }
      return pr.reviewOrphanedByPush === true
        ? `checks green, review orphaned by a push (reviewed on an earlier head, silent on this one) — ` +
          `re-running the review lane on #${pr.prNumber}`
        : `checks green, review never posted — running the review lane on #${pr.prNumber}`;
    },
  },
  {
    // W1-T913: a FRESH, not-yet-stale pending is a review this system already dispatched and is
    // genuinely IN FLIGHT. Ordered STRICTLY AFTER the post-review row, so anything reaching here
    // has already failed that row's staleness check. Without this row a fresh pending would fall
    // to the catch-all and ESCALATE every tick for the duration of an ordinary review — trading
    // the silence this task fixes for an escalation storm, which is strictly worse.
    disposition: "wait",
    when: (pr) => pr.checksState === "green" && pr.reviewState === "pending",
    reason: (pr, policy, _ageDays, now) => {
      const age = reviewPendingAgeMinutes(pr, now);
      return (
        `checks green, remudero-review pending ${age !== undefined ? `${Math.floor(age)}m` : "0m"} ` +
        `(< ${policy.pendingCeilingMinutes}m ceiling) — a review is already in flight, waiting`
      );
    },
  },
  {
    // W1-T2340 — A HEAD PENDING ONLY BECAUSE A CONCLUDED RUN PINNED ONE OF ITS JOBS reads exactly
    // like ordinary in-flight CI to the rows below, and would wait out the ceiling even though the
    // run that pinned the job is DONE. Ordered STRICTLY BEFORE them so a stalled head is named the
    // moment it is detectable; this shape needs no threshold at all. GATED ON `"pending"`
    // EXPLICITLY, never `"none"`, so it cannot fire on the input the ABSENT arm owns. TAKES NO
    // ACTION — re-running a concluded run is left to the operator, GitHub having refused it 403.
    disposition: "blocked-ambiguous",
    when: (pr) => pr.checksState === "pending" && stalledRunReason(pr.workflowRuns) !== undefined,
    reason: (pr) =>
      `stalled, not pending — ${stalledRunReason(pr.workflowRuns)} — a required check that never truly ` +
      `finished still blocks the merge; escalating once rather than waiting on something that will not arrive`,
  },
  {
    // WAIT (W1-T114). Never reached with a FAILING review or red checks — rows 4-7 claimed those,
    // so only checks-pending survives here. Requires a DATABLE age; undated pending falls through
    // to the catch-all unchanged, the pre-W1-T114 behaviour for callers that never wired the
    // timestamp.
    // Why: ~24 of 30 open needs-human issues on 2026-07-19 were exactly this shape.
    disposition: "wait",
    when: (pr, policy, _ageDays, now) => {
      if (pr.checksState !== "pending") return false;
      const mins = pendingAgeMinutes(pr, now);
      return mins !== undefined && mins < policy.pendingCeilingMinutes;
    },
    reason: (pr, policy, _ageDays, now) =>
      `checks pending ${Math.floor(pendingAgeMinutes(pr, now) ?? 0)}m (< ${policy.pendingCeilingMinutes}m ceiling) — waiting, re-deriving next sweep`,
  },
  {
    // STALE-PENDING (W1-T114): the SAME datable-pending shape as the row above, but the ceiling is
    // met or exceeded — a check stuck this long IS ambiguity, not merely in-flight. Uses the SAME
    // escalate path as the catch-all, with the elapsed minutes and the ceiling both named.
    disposition: "blocked-ambiguous",
    when: (pr, policy, _ageDays, now) => {
      if (pr.checksState !== "pending") return false;
      const mins = pendingAgeMinutes(pr, now);
      return mins !== undefined && mins >= policy.pendingCeilingMinutes;
    },
    reason: (pr, policy, _ageDays, now) =>
      `stale-pending — checks pending ${Math.floor(pendingAgeMinutes(pr, now) ?? 0)}m (>= ${policy.pendingCeilingMinutes}m ceiling) — escalating`,
  },
  {
    // NOT-YET-SCHEDULED (W1-T1103) — the THIRD reading of `checksState === "none"`: a head seconds
    // old with zero runs and one hours old with zero runs are the SAME count and OPPOSITE
    // situations. THE DISCRIMINATOR IS THE CLOCK the re-push remedy ALREADY OWNS, never a second
    // guessed constant — a bound firing on a healthy condition is this repo's recurring defect.
    // UNDATED FAILS TOWARD ESCALATE: an unreadable age is not evidence of youth, and treating it as
    // young would let a broken suite wait forever behind a bad timestamp.
    disposition: "wait",
    when: (pr, policy, _ageDays, now) => {
      if (pr.checksState !== "none") return false;
      const ageMin = absentAgeMinutes(pr, now);
      return ageMin !== undefined && ageMin < policy.absentCeilingMinutes;
    },
    reason: (pr, policy, _ageDays, now) =>
      `zero check runs on head ${pr.headSha.slice(0, 7)} but only ${(absentAgeMinutes(pr, now) ?? 0).toFixed(1)}m ` +
      `since the last push (< ${policy.absentCeilingMinutes}m ceiling) — not yet scheduled, not genuinely absent — waiting`,
  },
  {
    // TERMINAL rule, matching unconditionally — the LEAST permissive disposition (W1-T93), not the
    // most. A checks-red PR is caught by row 5 and a DATABLE checks-pending PR by rows 9/10, so
    // neither lands here. Anything else not positively mergeable and not failure-shaped no longer
    // falls through to mergeable by default: it lands here and ESCALATES, naming the observed
    // state, so it is never silent and never armed.
    disposition: "blocked-ambiguous",
    when: () => true,
    reason: (pr) =>
      `not positively mergeable — checks ${pr.checksState}, review ${pr.reviewState} — escalating`,
  },
];

/**
 * Derive ONE open PR's disposition from observed state and policy — PURE, TOTAL, deterministic.
 * Holds NO disposition branches: it computes the one derived scalar the table needs and returns
 * the first matching {@link DISPOSITION_RULES} row.
 *
 * W1-T1201 — AGE IS CLAMPED TO THE PR'S OWN LIFETIME, HERE, ONCE, BEFORE ANY ROW READS IT, so
 * every row inherits the bound. An absent `createdAt` clamps to `+Infinity`, today's arithmetic.
 * THE CLAMP DOES NOT SILENTLY RESCUE: when it changes the outcome the `reason` says so, because a
 * rescue nobody can see is how a shifted clock stays invisible until it closes eleven PRs.
 */
export function deriveDisposition(
  pr: OpenPrView,
  policy: SweepPolicy = DEFAULT_SWEEP_POLICY,
  now: number = Date.now(),
): DispositionResult {
  const parsed = Date.parse(pr.lastActivityAt);
  const activityAgeDays = Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : (now - parsed) / MS_PER_DAY;
  const createdParsed = pr.createdAt === undefined ? Number.NaN : Date.parse(pr.createdAt);
  const lifetimeAgeDays = Number.isNaN(createdParsed) ? Number.POSITIVE_INFINITY : (now - createdParsed) / MS_PER_DAY;
  const ageDays = Math.min(activityAgeDays, lifetimeAgeDays);
  const rule = DISPOSITION_RULES.find((r) => r.when(pr, policy, ageDays, now));
  if (!rule) {
    // UNREACHABLE — the terminal row matches unconditionally. This guards the
    // no-disposition=none invariant against a future table edit that drops it.
    // The safe fallback is the LEAST permissive disposition — escalate, never arm.
    return { disposition: "blocked-ambiguous", reason: "default (no rule matched) — escalating" };
  }
  const reason = rule.reason(pr, policy, ageDays, now);
  // W1-T1201: the clamp can only ever SUPPRESS the bare stale row, the only row reading the
  // computed scalar. When the raw activity age would have crossed that threshold but the clamped
  // age does not, that suppression is a BROKEN-CLOCK SIGNAL, never a routine non-event, so it is
  // folded into whichever other row's reason actually fired.
  const clockSkewSuppressedStale =
    lifetimeAgeDays < activityAgeDays && activityAgeDays >= policy.staleDays && ageDays < policy.staleDays;
  if (!clockSkewSuppressedStale) return { disposition: rule.disposition, reason };
  return {
    disposition: rule.disposition,
    reason:
      `${reason} — AGE CLAMP (W1-T1201): raw activity age ${Math.floor(activityAgeDays)}d would cross the ` +
      `${policy.staleDays}d stale threshold, but this PR has existed only ${Math.floor(lifetimeAgeDays)}d ` +
      `(created ${pr.createdAt}) — a PR cannot be idle longer than it has existed, so stale was suppressed`,
  };
}

/**
 * W1-T983 — is this PR's disposition the CAPPED-GREEN-REVIEW-ORPHAN shape: the ONE
 * blocked-ambiguous disposition reclassified to a reaching escalation tier, while every other
 * keeps the class it has today. PURE, with no spawn and no GitHub call, and mirrored EXACTLY off
 * the conditions the cap row already reads, so the two cannot drift apart.
 *
 * W1-T1018: DELIBERATELY still four conditions, no fifth backoff check — a PR only reaches this
 * predicate when the cap row already matched at the same pass, so backoff read un-elapsed a moment
 * earlier. // Why: the cap fires rarely, which is what keeps this inside the measured ping rate.
 */
export function isCappedReviewOrphanEscalation(pr: OpenPrView, policy: SweepPolicy): boolean {
  return (
    pr.checksState === "green" &&
    pr.reviewState === "none" &&
    pr.reviewOrphanedByPush === true &&
    (pr.priorReviewAttemptsForInput ?? 0) >= policy.reviewOrphanCap &&
    pr.requiredContextsUnreadable !== true
  );
}

/**
 * ARMING PARITY WITH THE RUN FLOW — a PR the run flow refused stayed open and unarmed, but a later
 * sweep poll could still arm it through this separate path.
 *
 * NOT A SECOND IMPLEMENTATION, which is exactly how the two paths drifted apart: this delegates to
 * {@link decideAutoMergeArm}, the SAME predicate the run flow calls, so the W1-T205 carve-out
 * travels with it and a `planOnly` CAPPED verdict still arms. The one shape this takes away is the
 * one the run flow already refuses.
 *
 * FAIL-OPEN ON ABSENT EVIDENCE: refusal requires positively observing `capped: true,
 * plan_only: false` for THIS head. W1-T1028 keys recovery on the same synthetic id the review lane
 * ledgers under, so a hand-filed PR is judged on the verdict the run flow would find.
 * // Why: #800 armed at proof_exec 0/5 and merged 35 seconds later — docs/forensics/sweep.md.
 */
export function decideSweepArm(
  pr: OpenPrView,
  ledgerLines: ReadonlyArray<Record<string, unknown>>,
  // W1-T1028 — appended LAST, the SAME idiom {@link decideAutoMergeArm} already uses, so no
  // positional caller shifts and omitting it is byte-for-byte today's behaviour. `OpenPrView`
  // gains no field: the run flow's classification is worktree-bound and this pass has no worktree,
  // so the field would be permanently unproducible. A future caller with a head-bound
  // classification can supply it here without the signature changing again.
  irreversible?: boolean,
): ArmDecision {
  const armId = pr.taskId ?? `PR-${pr.prNumber}`;
  const facts = postedArmFactsFromLedger(ledgerLines, armId, pr.headSha);
  if (!facts) {
    return { arm: true, reason: "no ledgered verdict recoverable for this head — arming as before (no evidence to refuse on)" };
  }
  const override = facts.capped ? cappedOverrideFromLedger(ledgerLines, armId, pr.headSha) : undefined;
  return decideAutoMergeArm(
    { state: "success", capped: facts.capped, planOnly: facts.planOnly },
    false,
    override,
    irreversible,
  );
}

/** One armed-and-stalled PR: both facts that make it stalled, carried together. */
export interface ArmedStalledPr {
  prNumber: number;
  prUrl: string;
  /** The task this PR credits, when the gateway resolved one. */
  taskId?: string;
  /** The head the arm is pinned to — the sha a later verdict would be bound to. */
  headSha: string;
}

/**
 * W1-T528 — the terminal outcome of ONE `gh pr update-branch` request. Only these three are
 * established without a live call against a real PR.
 *  - `"updated"`: GitHub ACCEPTED the request; the update itself completes asynchronously.
 *  - `"conflict"`: GitHub refused — a real conflict, or a diverged-not-merely-behind head.
 *    Reported on the ledger and never retried by this same call.
 *  - `"error"`: any other failure. Informational; a later pass may re-select, this call does not.
 */
export type UpdateBranchOutcome = "updated" | "conflict" | "error";

/**
 * W1-T520 — ARMED AND BEHIND, THE TWO FACTS NOTHING JOINED. Separately unremarkable; together they
 * describe a PR that has done everything it can and stopped, indistinguishable from one still
 * waiting for CI.
 *
 * WHY THE DETECTOR AND NOT THE FIX: acting mints a NEW HEAD, and a verdict is input-pinned, so
 * every update discards the verdict it was waiting on. PURE AND FAIL-QUIET — an unread
 * `mergeState` yields nothing, because an unread fact is not a stall.
 */
export function armedButStalled(prs: readonly OpenPrView[]): ArmedStalledPr[] {
  const out: ArmedStalledPr[] = [];
  for (const pr of prs) {
    if (pr.autoMergeArmed !== true) continue;
    if (pr.mergeState !== "behind") continue;
    out.push({
      prNumber: pr.prNumber,
      prUrl: pr.prUrl,
      ...(pr.taskId === undefined ? {} : { taskId: pr.taskId }),
      headSha: pr.headSha,
    });
  }
  return out;
}

/**
 * W1-T528 — THE ACTION HALF OF W1-T520: selects AT MOST ONE PR from {@link armedButStalled}'s own
 * set, never a second predicate recomputing the same two facts.
 *
 * ONE PER PASS, OLDEST HEAD FIRST — updating mints a NEW head and a verdict is input-pinned, so
 * updating the whole stalled set each pass costs N+(N-1)+…+1 reviews. The comparator is shared with
 * the review admission, so a loser is strictly older next pass and cannot starve.
 *
 * TWO EXCLUSIONS on top of the detector's facts, since a red or already-current PR is already
 * excluded by `armedButStalled`: a DRAFT, the operator's hold, is never touched; and an IN-FLIGHT
 * HEAD, where a live worker is still pushing. A head that is not a run-branch can never match.
 */
export function selectUpdateBranchTarget(
  prs: readonly OpenPrView[],
  now: number,
  inFlightTaskIds: ReadonlySet<string> = new Set(),
  staleGateWorkflowsByPr: ReadonlyMap<number, readonly string[]> = new Map(),
  updatedForWorkflow: ReadonlySet<string> = new Set(),
): ArmedStalledPr | undefined {
  // W1-T1212: the UNION of two disjoint-by-construction predicates, never a widening of either.
  // A PR named by both contributes ONE candidate; the first writer wins, and which shape wins
  // carries no meaning the comparator below reads.
  const combined = new Map<number, ArmedStalledPr>();
  for (const c of [...armedButStalled(prs), ...redPrWithStaleGate(prs, staleGateWorkflowsByPr, updatedForWorkflow)]) {
    if (!combined.has(c.prNumber)) combined.set(c.prNumber, c);
  }
  const candidates = [...combined.values()];
  if (candidates.length === 0) return undefined;
  const byNumber = new Map<number, OpenPrView>(prs.map((pr) => [pr.prNumber, pr]));
  const eligible = candidates.filter((s) => {
    const view = byNumber.get(s.prNumber);
    if (!view) return false; // cannot happen — both predicates only derive from `prs` itself
    if (view.isDraft === true) return false;
    const runTaskId = taskIdFromRunBranch(view.headRefName);
    if (runTaskId !== undefined && inFlightTaskIds.has(runTaskId)) return false;
    return true;
  });
  if (eligible.length === 0) return undefined;
  const eligibleViews = eligible.map((s) => byNumber.get(s.prNumber)!);
  const winnerView = oldestActivityFirst(eligibleViews, now);
  return eligible.find((s) => s.prNumber === winnerView?.prNumber);
}

/**
 * One PR {@link redPrWithStaleGate} selected — sibling to {@link ArmedStalledPr}, carrying the ONE
 * extra fact the caller needs: which failing check's workflow moved on main, so the pair can be
 * remembered and never re-selected for the same workflow.
 */
export interface StaleGatePr extends ArmedStalledPr {
  /** The currently-failing check whose workflow blob differs between this PR's merge ref and main. */
  staleWorkflow: string;
}

/**
 * W1-T1212 — A RED PR RUNS A FROZEN COPY OF THE VERY GATE THAT BLOCKS IT: the merge ref's base
 * parent is pinned at the last `synchronize`, so a gate fixed on main never reaches an older merge
 * ref and the PR fails a check main would now pass. `armedButStalled` cannot reach this
 * population, since a red PR is never armed.
 *
 * SIBLING TO THAT PREDICATE, NEVER A WIDENING. THE DISCRIMINATOR IS EXACT, never "behind main"
 * alone, which would fire on essentially every open PR and pay a rebase storm for nothing.
 * REFUSED BY NAME: a CONFLICTED PR, and one whose stale names are ALL already spent. The draft and
 * in-flight vetoes are {@link selectUpdateBranchTarget}'s job, applied to the union exactly once.
 */
export function redPrWithStaleGate(
  prs: readonly OpenPrView[],
  staleGateWorkflowsByPr: ReadonlyMap<number, readonly string[]>,
  updatedForWorkflow: ReadonlySet<string> = new Set(),
): StaleGatePr[] {
  const out: StaleGatePr[] = [];
  for (const pr of prs) {
    if (pr.checksState !== "red") continue;
    if (pr.mergeState === "dirty" || pr.mergeable === false) continue;
    const staleNames = staleGateWorkflowsByPr.get(pr.prNumber) ?? [];
    const fresh = staleNames.find((name) => !updatedForWorkflow.has(`${pr.prNumber}:${name}`));
    if (fresh === undefined) continue;
    out.push({
      prNumber: pr.prNumber,
      prUrl: pr.prUrl,
      ...(pr.taskId === undefined ? {} : { taskId: pr.taskId }),
      headSha: pr.headSha,
      staleWorkflow: fresh,
    });
  }
  return out;
}

// ── W1-T78 — THE CLARIFICATION-QUESTION rung (ratifies P22's new rung) ───────────────────────
//
// An ambiguous block yields a SPECIFIC, decidable operator question, never silence.
// `renderClarificationQuestion` is PURE: it renders ONLY what the sweep and ledger observed and
// never invents a criterion or a resolution. Emitted per the §2 QUESTION contract's shape to the
// durable backlog, with `escalate()` as the notification transport — both wired in run-task.ts.

/**
 * One recorded fix-rung strike's outcome for a task — "what the fix worker tried", ledger ground
 * truth ONLY, never inferred. Derived from `fix.dispatch`/`fix.review` rows by
 * run-task.ts's `deriveStrikeHistory`.
 */
export interface StrikeAttempt {
  strike: number;
  round: "resume" | "fresh";
  /** Unmet criteria count going INTO this strike. */
  unmetCount: number;
  /**
   * W1-T1269 — the unmet criteria CLAIM SET going into this strike. This is the identity
   * {@link fixRungRepeatsIdenticalFailure} compares, telling a strike that failed IDENTICALLY from
   * one that fixed half or fixed one thing while breaking another — {@link unmetCount} cannot
   * separate those. SCOPE (honest): no producer populates it, and the predicate fails CLOSED, so
   * row 5.5 stays inert in production.
   */
  unmetClaims?: readonly string[];
  /** Whether CI reached green after this strike (a review only runs once it does). */
  ciGreen: boolean;
  /** The review verdict AFTER this strike, if one ran. */
  reviewState?: "success" | "failure";
}

/** One of exactly two candidate resolutions the operator can pick between. */
export interface ClarificationResolution {
  label: string;
  detail: string;
}

/**
 * The rendered output of the clarification rung for ONE blocked-ambiguous PR: the exact decision,
 * both candidate resolutions, and the run and PR context — never a generic needs-human.
 */
export interface ClarificationQuestion {
  taskId: string;
  prNumber: number;
  prUrl: string;
  /** The single, specific decision the operator must make. */
  question: string;
  /** The unmet criterion's claim text driving the block ("" for the contradictory/terminal rows — no single criterion to point at). */
  criterion: string;
  /** The reviewer's stated unmet reason, verbatim (or the disposition reason, when there is no single criterion). */
  reviewerRequirement: string;
  /** The acceptance criterion's own proof text — the spec the reviewer is judging against ("" when there is no single criterion). */
  specText: string;
  /** What each fix-rung strike tried and its outcome, ledger ground truth (§ StrikeAttempt). */
  strikeHistory: StrikeAttempt[];
  /** Exactly two candidate resolutions — never a silent guess, never more than two. */
  resolutions: readonly [ClarificationResolution, ClarificationResolution];
  /**
   * W1-T186: which named {@link ObservedBlockerState} this escalation observed, or `undefined`
   * for an ordinary review-failure block where the criterion fields already say everything.
   */
  observedState?: ObservedBlockerState;
}

/**
 * Render ONE blocked-ambiguous PR's clarification question deterministically, from ledger ground
 * truth ONLY: the task id, the unmet criterion (claim vs the reviewer's requirement vs the spec's
 * own proof text), and what the fix worker tried per strike. PURE, no guessing — with no single
 * criterion to point at, the question names the observed disposition `reason` instead of
 * inventing one, but it is NEVER silent either way.
 */
export function renderClarificationQuestion(
  pr: OpenPrView,
  reason: string,
  strikeHistory: StrikeAttempt[] = [],
): ClarificationQuestion {
  const primary = pr.unmetCriteria[0];
  const criterion = primary?.claim ?? "";
  const reviewerRequirement = primary?.reason ?? reason;
  const specText = primary?.proof ?? "";

  const tried = strikeHistory.length
    ? strikeHistory
        .map(
          (s) =>
            `strike ${s.strike} (${s.round}): ${s.unmetCount} unmet criteri${s.unmetCount === 1 ? "on" : "a"} going in, ` +
            // W1-T186: "checks", never "CI" — this same sentence renders inside a CONFLICTED
            // escalation too (strike history predates a later-discovered conflict), and that
            // escalation must never contain the literal word "CI" (it never ran one).
            `checks ${s.ciGreen ? "went green" : "did not go green"}` +
            (s.reviewState ? `, review came back ${s.reviewState}` : ""),
        )
        .join("; ")
    : "no fix-rung strike is recorded for this PR";

  const resolutions: readonly [ClarificationResolution, ClarificationResolution] = [
    {
      label: "re-dispatch-with-constraint",
      detail:
        "re-arm the W1-T76 fix rung on the same branch, carrying the operator's answer as an added " +
        "constraint on the next prompt (strike-counter reset is config policy).",
    },
    {
      label: "revise-spec",
      detail:
        "the acceptance criterion's own spec text is wrong or unattainable as written — file a task-edit " +
        "PROPOSAL (a plan-only PR); the rung itself never self-edits tasks.yaml (rule 15).",
    },
  ];

  // Shared by both branches below (single source of the "name both options"
  // suffix — editing the resolutions never requires editing this text twice).
  const decisionSuffix = `Which is right — (1) ${resolutions[0].label}: ${resolutions[0].detail}, or (2) ${resolutions[1].label}: ${resolutions[1].detail}`;

  const baseQuestion = criterion
    ? `Task ${pr.taskId}, PR #${pr.prNumber} (${pr.prUrl}): after ${strikeHistory.length} fix strike(s) — ${tried} — ` +
      `"${criterion}" is still unmet. The reviewer requires: "${reviewerRequirement}". The spec's own proof text says: ` +
      `"${specText}". ${decisionSuffix}`
    : `Task ${pr.taskId}, PR #${pr.prNumber} (${pr.prUrl}): ${reason} — ${tried}. There is no single actionable unmet ` +
      `criterion to point at. ${decisionSuffix}`;

  // W1-T186: prepend the named observed-blocker facts to EVERY escalation that has them, never
  // only the criterion-shaped ones. "" when none was found and no mergeable state was read, so an
  // ordinary review-failure question renders byte-identical to before this task.
  const observedState = observedBlockerState(pr);
  const observedFacts = renderObservedFacts(pr, observedState);
  const question = observedFacts ? `${observedFacts} ${baseQuestion}` : baseQuestion;

  return {
    taskId: pr.taskId ?? "UNKNOWN",
    prNumber: pr.prNumber,
    prUrl: pr.prUrl,
    question,
    criterion,
    reviewerRequirement,
    specText,
    strikeHistory,
    resolutions,
    observedState,
  };
}

/**
 * Render a {@link ClarificationQuestion} into the §2 QUESTION contract's shape for the durable
 * backlog. `current_assumption` names what stays true while the PR is unanswered: it never
 * proceeds on a guess, it stays blocked.
 */
export function toQuestionEntry(q: ClarificationQuestion, ts: string): QuestionEntry {
  return {
    ts,
    task: q.taskId,
    question: q.question,
    current_assumption: `PR #${q.prNumber} (${q.prUrl}) stays BLOCKED-AMBIGUOUS — unmerged, no further fix strikes dispatched — until the operator answers.`,
    impact_if_wrong: "med",
  };
}

// ── W1-T2345 — THE UNBOUNDED-IDENTICAL-DISPOSITION COUNTER ──────────────────────────────────
//
// A disposition that CANNOT change on an unchanged head is re-derived at full weight forever.
// This bounds the REPETITION, never the verdict: {@link deriveDisposition} is untouched,
// `sweep.disposed` still writes one row every pass, and nothing here paces or sleeps a call.
// Why: measured run lengths and the N=50 derivation are in docs/forensics/sweep.md.

/** One PR's identical-verdict run, as folded off `sweep.disposed` rows already on the ledger —
 *  see {@link repeatDispositionStreaksFromLedger}'s own doc for the fold rules. */
interface RepeatDispositionRun {
  headSha: string;
  disposition: string;
  /** Consecutive `sweep.disposed` rows ending at (and including) the last one read. */
  streak: number;
  /** Whether the repeat escalation already fired somewhere inside THIS run, as the SURVIVING rows
   *  report it. W1-T2382: "this run" is bounded by rotation as well as by the head — see
   *  {@link SweepPolicy.repeatDispositionBound}'s own doc. */
  escalated: boolean;
}

/**
 * Fold every `sweep.disposed` row into each PR's trailing identical-verdict run.
 *
 * KEYED ON `(disposition, head_sha)`, NEVER ON THE RENDERED `reason`, which carries a live counter
 * that renders differently every tick though the verdict has not moved. EVERY ROW COUNTS
 * REGARDLESS OF `acted` — gating on it would exempt exactly the shapes this bound exists for. A
 * differing row breaks the run, which is the head-move reset. `escalated` carries forward only for
 * as long as THE ROWS IT READS SURVIVE: rotation selects against the marker, so post-rotation this
 * legitimately reports a fresh run and the defect is not in this function (W1-T2382).
 */
function repeatDispositionStreaksFromLedger(lines: ReadonlyArray<Record<string, unknown>>): Map<number, RepeatDispositionRun> {
  const runs = new Map<number, RepeatDispositionRun>();
  for (const line of lines) {
    if (line.step !== "sweep.disposed") continue;
    const prNumber = typeof line.pr_number === "number" ? line.pr_number : undefined;
    const headSha = typeof line.head_sha === "string" ? line.head_sha : undefined;
    const disposition = typeof line.disposition === "string" ? line.disposition : undefined;
    if (prNumber === undefined || headSha === undefined || disposition === undefined) continue;
    const prev = runs.get(prNumber);
    const continuesRun = prev !== undefined && prev.headSha === headSha && prev.disposition === disposition;
    runs.set(prNumber, {
      headSha,
      disposition,
      streak: continuesRun && prev ? prev.streak + 1 : 1,
      escalated: (continuesRun && prev ? prev.escalated : false) || line.repeat_escalated === true,
    });
  }
  return runs;
}

/**
 * Render the repeat-bound trip as a {@link ClarificationQuestion}: with no single unmet criterion
 * to point at, the two resolutions name the honest outcomes of a verdict that is not disputed,
 * only stuck repeating. W1-T2381: NO PRODUCTION CALLER — the call it was written for is gone.
 * RETAINED because it is exported and pinned by a test, so deleting it would delete a passing test
 * for behaviour nobody has ruled on.
 */
export function renderRepeatEscalationQuestion(
  pr: OpenPrView,
  disposition: Disposition,
  reason: string,
  streak: number,
  bound: number,
): ClarificationQuestion {
  const resolutions: readonly [ClarificationResolution, ClarificationResolution] = [
    {
      label: "acknowledge-unchanged",
      detail:
        `no action needed from the sweep's own dispositioning — verdict "${disposition}" is correct and the sweep ` +
        `will keep re-deriving it every pass; this notice is visibility only, never a request to change the verdict.`,
    },
    {
      label: "intervene-manually",
      detail:
        `the automated remedy (if any) for "${disposition}" has had ${streak} unchanged passes on this head with ` +
        `nothing moving it forward — an operator looks at PR #${pr.prNumber} directly rather than waiting on another pass.`,
    },
  ];
  const question =
    `Task ${pr.taskId ?? "UNKNOWN"}, PR #${pr.prNumber} (${pr.prUrl}): the sweep has dispositioned this PR ` +
    `"${disposition}" ${streak} consecutive time(s) on the SAME head (>= ${bound} repeat bound) — ${reason}. The ` +
    `verdict itself is not in question, only its unchanging repetition is. Which is right — ` +
    `(1) ${resolutions[0].label}: ${resolutions[0].detail}, or (2) ${resolutions[1].label}: ${resolutions[1].detail}`;
  return {
    taskId: pr.taskId ?? "UNKNOWN",
    prNumber: pr.prNumber,
    prUrl: pr.prUrl,
    question,
    criterion: "",
    reviewerRequirement: reason,
    specText: "",
    strikeHistory: [],
    resolutions,
  };
}

/**
 * The ADDITIONAL strikes an operator's clarification answer grants — PURE and table-free (a second
 * lever is a field on {@link ClarifyPolicy}, never a branch here). Two uses, ONE number: it IS the
 * fresh `strikeCap` the re-dispatch passes to `runFixRung`, and the answered row adds it to
 * `policy.strikeCap` for the cumulative ceiling — never an unconditional bypass of the count.
 */
export function strikeCapForAnswer(originalCap: number, policy: ClarifyPolicy = DEFAULT_CLARIFY_POLICY): number {
  return policy.resetStrikeCounterOnAnswer ? originalCap : 1;
}

/**
 * W1-T2452 — THE CUMULATIVE STRIKE CEILING ACTUALLY IN FORCE: `strikeCap` ordinarily, or the
 * EXTENDED ceiling once an operator's answer is live — the SAME number the answered
 * {@link DISPOSITION_RULES} row checks, never a second computation that could diverge from the
 * routing decision. Every rendered strike ratio and the real dispatch budget read THIS function,
 * so neither can drift from the other; that drift was the defect this closes.
 */
export function fixCeilingInForce(
  pr: Pick<OpenPrView, "pendingAnswer">,
  strikeCap: number,
  clarifyPolicy: ClarifyPolicy = DEFAULT_CLARIFY_POLICY,
): number {
  if (!pr.pendingAnswer) return strikeCap;
  const clarify: ClarifyPolicy = {
    resetStrikeCounterOnAnswer: pr.pendingAnswer.resetStrikeCounter ?? clarifyPolicy.resetStrikeCounterOnAnswer,
  };
  return strikeCap + strikeCapForAnswer(strikeCap, clarify);
}

/**
 * W1-T2452 — THE STRIKE BUDGET TO DISPATCH: the REMAINDER against {@link fixCeilingInForce}, NEVER
 * a fresh full cap, because `runFixRung` counts each new call from 0 and a fresh cap let the
 * cumulative ledger count exceed the ceiling. Returns `null` when the remainder is non-positive,
 * and THIS IS THE LOAD-BEARING HALF: a silent zero-budget dispatch converts an overspend into a
 * no-op that strands an otherwise-fixable PR forever, so the caller must escalate instead.
 */
export function fixDispatchBudget(priorStrikes: number, ceiling: number): number | null {
  const remaining = ceiling - priorStrikes;
  return remaining > 0 ? remaining : null;
}

/** The last line in `lines` matching `pred` — append-only files read oldest-first, so the
 *  last match is the NEWEST record. Shared by both halves of {@link operatorVerdictEvidence}. */
function lastMatching<T extends Record<string, unknown>>(lines: ReadonlyArray<T>, pred: (l: T) => boolean): T | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (pred(lines[i])) return lines[i];
  }
  return undefined;
}

/**
 * W1-T435 — the fix rung's OPERATOR-STEERED re-arm, producing the SAME
 * {@link OpenPrView.pendingAnswer} shape W1-T78 wired but never had a producer for, routed through
 * the identical row and ceiling rather than a second mechanism. ONE pass over TWO local sources:
 * a one-tap verdict carrying a STEERING NOTE, quoted VERBATIM with attribution, and an ANSWERED
 * clarification. A `good` verdict NEVER contributes — re-arming on praise would spin the rung
 * forever on a PR nobody objected to. Both key on `taskId` alone, since the rung dispatches per TASK.
 */
export function operatorVerdictEvidence(
  taskId: string,
  ledgerLines: ReadonlyArray<Record<string, unknown>>,
  questionLines: ReadonlyArray<Record<string, unknown>>,
): { constraint: string; resetStrikeCounter?: boolean } | undefined {
  const parts: string[] = [];

  const feedback = lastMatching(ledgerLines, (l) => l.step === "operator_feedback" && l.task_id === taskId);
  const verdict = typeof feedback?.verdict === "string" ? feedback.verdict : undefined;
  const note = typeof feedback?.note === "string" ? feedback.note : undefined;
  if ((verdict === "wrong" || verdict === "needs-follow-up") && note && note.trim() !== "") {
    parts.push(`Operator marked this run "${verdict}": ${note}`);
  }

  const answer = lastMatching(questionLines, (l) => typeof l.answer === "string" && l.task === taskId);
  if (answer && typeof answer.answer === "string" && answer.answer.trim() !== "") {
    parts.push(answer.answer);
  }

  return parts.length > 0 ? { constraint: parts.join("\n\n") } : undefined;
}

/**
 * The block evidence `dispatchFix` carries, GENERALIZED (W1-T100) from a bare unmet array to the
 * mode-evidence shape, so a checks-red PR carries ci-log input instead of an always-empty list.
 * Exactly one field is meaningful per disposition. W1-T2236: `actionableGateFailures` rides
 * ALONGSIDE `unmetCriteria` on a review-mode dispatch — before it, that structured remedy was
 * computed, named in the reason, then discarded at exactly this boundary.
 */
export interface FixDispatchEvidence {
  unmetCriteria: CriterionVerdict[];
  ciFailures?: CiFailure[];
  /** W1-T106: the merge-conflict fix mode's input — populated for a `conflicted` dispatch only. */
  mergeConflict?: MergeConflictEvidence;
  /** W1-T2236: see this interface's own doc, above. Populated ONLY when `unmetCriteria` is empty. */
  actionableGateFailures?: ActionableGateFailure[];
}

/**
 * TERMINAL-STATE PREDICATE (W1-T177) — the ONE definition every spending site and the operator verb
 * share, so a merged or closed PR is refused IDENTICALLY everywhere rather than through hardcoded
 * copies that drift. Only `"OPEN"` carries a live block. Classifies a SUCCESSFULLY-READ state
 * ONLY: each call site owns its own fail-open direction, and an unreadable state must never be
 * treated as terminal.
 */
export function terminalStateReason(state: string | undefined): string | undefined {
  if (state === "OPEN") return undefined;
  return `state is ${state ?? "UNKNOWN"} (only an OPEN PR carries a live block)`;
}

/**
 * One fresh, live read of a PR's GitHub state (W1-T177). `ok:false` marks a genuinely FAILED or
 * INDETERMINATE read, which the caller must treat exactly as if no check ran, never as terminal.
 * `state` is present only when `ok`.
 */
export interface LiveStateResult {
  ok: boolean;
  state?: string;
  /** Current PR head from the same fresh read, when the caller needs input-pinned mutation. */
  headSha?: string;
}

/**
 * The outcome names `armAutoMerge` returns. Mirrored rather than imported to keep lib/sweep.ts
 * free of a run-task.ts dependency; {@link armOutcomeArmed} is the single place deciding which of
 * them count as having actually armed.
 */
export type ArmOutcomeName =
  | "no-task-id"
  | "head-unavailable"
  | "ledger-refused"
  | "armed"
  | "direct-merged"
  | "direct-merge-failed"
  | "direct-merge-updated"
  | "direct-merge-preflight-refused"
  | "direct-merge-update-failed"
  | "arm-error-ignored"
  // W1-T947: refused because the diff is classified IRREVERSIBLE — mirrored here for the same
  // reason every other member is, so {@link armOutcomeArmed} type-checks without the import.
  | "irreversible-refused"
  // W1-T1000002: refused because an operator hold stands over this PR. A deliberate refusal,
  // never armed here or later, until the hold is released and a fresh pass re-derives whole.
  | "hold-refused";

/**
 * W1-T1117: `armFailureAction`'s return, mirrored here for the same reason
 * {@link ArmOutcomeName} is. `"direct-merge"` is deliberately absent: that class never reaches an
 * `"arm-error-ignored"` outcome, so it can never be the `failureClass` a caller attaches below.
 */
export type ArmFailureClass = "transient" | "retryable" | "unknown";

/**
 * W1-T1117: the richer shape `SweepDeps.arm` may return instead of the bare
 * {@link ArmOutcomeName} — the same widening run-task.ts already established, reused rather than
 * reinvented. `failureClass` is populated ONLY alongside `"arm-error-ignored"`; every other
 * outcome either never attempted a merge or resolved to an already-distinct outcome.
 */
export interface ArmAttemptOutcome {
  outcome: ArmOutcomeName;
  failureClass?: ArmFailureClass;
}

/**
 * TRUE only for outcomes that genuinely armed or merged.
 *
 *   armed          — auto-merge is registered.
 *   direct-merged  — GitHub refused `--auto` on an already-clean PR and the fallback merged it.
 *                    A success though not an arm: the PR leaves `openPrs` next pass.
 *
 * Every other outcome armed NOTHING: no-task-id, head-unavailable and ledger-refused returned
 * before any attempt; direct-merge-failed and arm-error-ignored attempted and did not stick;
 * irreversible-refused is a deliberate refusal, never a failure. Whether a non-armed outcome is
 * RETRIED is a separate question the mergeable arm's dedup logic answers.
 */
export function armOutcomeArmed(outcome: ArmOutcomeName | void): boolean {
  // An `undefined` return is a fake/effect that predates this signature — treat it as armed,
  // which is exactly what the code assumed before, so no existing lane regresses.
  if (outcome === undefined) return true;
  return outcome === "armed" || outcome === "direct-merged";
}

/**
 * W1-T2231 — the SAME "undefined means the pre-existing assumption" idiom {@link armOutcomeArmed}
 * establishes for `deps.arm`, applied to `deps.dispatchFix`. A `false` return is the ONLY signal
 * that stands a dispatch's `spent` field down; `undefined` and `true` both read as spent, which
 * is why the count on every pre-existing ledger row is unchanged.
 */
export function dispatchFixSpent(outcome: boolean | void): boolean {
  if (outcome === undefined) return true;
  return outcome;
}

/** Injected effects — the real command wires arm/close/fix/escalate; tests fake them. */
export interface SweepDeps {
  /**
   * Arm GitHub auto-merge. Idempotent at the GitHub level.
   *
   * RETURNS ITS OUTCOME: `armAutoMerge` does not throw, and most outcomes mean it armed NOTHING.
   * The effect used to discard that value while the sweep recorded `acted: true` regardless, which
   * hid the refusal and made it PERMANENT, because that seeds the dedup. `void` stays valid and
   * reads as "armed", the pre-existing assumption. // Why: observed live on PR #960.
   */
  arm: (
    pr: OpenPrView,
  ) => ArmOutcomeName | ArmAttemptOutcome | void | Promise<ArmOutcomeName | ArmAttemptOutcome | void>;
  /**
   * W1-T1000002 — WITHDRAW AN ARM THIS LANE DID NOT PLACE, called only when an operator hold
   * stands over a PR already reporting armed. A disarm alone is undone by the next pass, whose
   * dedup reads GitHub's live armed bit, so this fires EVERY pass the hold stands and the PR reads
   * armed — as often as it takes, and zero times once that bit reads false. SAFE WHEN NOT ARMED,
   * so no extra probe is needed. Omitted, the PR is still never re-armed by this lane, but nothing
   * withdraws a STANDING arm — never a silent regression for an older fixture.
   */
  disarmAutoMerge?: (pr: OpenPrView, hold: AutomergeHold) => void | Promise<void>;
  /** Close a superseded/abandoned PR with a stated reason. */
  close: (pr: OpenPrView, reason: string) => void | Promise<void>;
  /**
   * Invoke the W1-T54 dep-review lane on a Dependabot PR and return its DECISION, so the disposed
   * line records the outcome and dedup can tell TERMINAL outcomes (never re-run for the same head,
   * or a major would open a fresh issue every poll) from "hold", which re-runs next sweep because
   * a red check can go green on the SAME sha. Omitted, the disposition is ledgered and nothing runs.
   */
  depReview?: (pr: OpenPrView) => string | void | Promise<string | void>;
  /**
   * Invoke the review lane on a checks-green PR whose review was never posted. Verdicts are
   * per-head, so dedup is unconditional per `pr@head` and a fresh push re-routes naturally.
   * W1-T473: MAY be invoked CONCURRENTLY with other PRs' calls, bounded by `policy.reviewLanes`,
   * with each review-input key claimed synchronously before scheduling — so this is never asked to
   * run twice for the same input at once.
   */
  postReview?: (pr: OpenPrView) => void | Promise<void>;
  /**
   * W1-T2853 — choose this pass's review width from one already-derived queue and ledger snapshot.
   * Omission preserves the committed `reviewLanes` behaviour for CLI and test callers.
   */
  selectAdaptiveReviewWidth?: (input: {
    queueDepth: number;
    nowMs: number;
    ledgerLines: ReadonlyArray<Record<string, unknown>>;
  }) => number;
  /**
   * W1-T2584 — MAY THE BOUNDED REVIEW POOL ADMIT ANOTHER HEAD from this pass's already-derived
   * pending set? Consulted synchronously before each worker pulls its next job; optional means
   * `true`. The daemon's callback turns false when the wall-clock bound abandons the pass or a
   * STOP/PAUSE gate becomes active. It never interrupts a running reviewer — only later
   * admissions, whose keys are released and whose heads re-derive next pass, so a timer expiry
   * never becomes cancellation at an arbitrary GitHub-write boundary.
   */
  continueReviewAdmissions?: () => boolean;
  /**
   * Dispatch the W1-T76 fix rung carrying the mode-appropriate evidence at once — the FULL unmet
   * set for a review dispatch, or ci-log evidence for a blocked_ci one.
   * W1-T2231: MAY return whether this call demonstrably SPENT a strike. `undefined` reads as spent,
   * the pre-existing assumption, so this widening regresses no lane and `acted` is never touched
   * by it — a second field, never a redefinition of the first.
   */
  dispatchFix: (
    pr: OpenPrView,
    evidence: FixDispatchEvidence,
  ) => boolean | void | Promise<boolean | void>;
  /**
   * Escalate a BLOCKED-AMBIGUOUS PR. `question` is the rung's rendered
   * {@link ClarificationQuestion}: the real wiring logs it to the §2 backlog AND uses
   * `escalate()` as the notification transport, carrying the same two resolutions as its options.
   */
  escalate: (pr: OpenPrView, reason: string, question: ClarificationQuestion) => void | Promise<void>;
  /**
   * W1-T1223 — re-queue ONE cancelled required check's JOB
   * (`POST .../actions/jobs/{job_id}/rerun`), NEVER the workflow run
   * (`.../runs/{run_id}/rerun-failed-jobs`): a whole-run re-run would re-spend an already-green
   * sibling sharing that run. Called AT MOST ONCE per `${headSha}@${checkName}` pair. Omitted, the
   * sweep still names the cancelled check on its disposed line but takes no action — never a
   * silent no-op, the stand-down is legible.
   * // Why: learnings/ci.yaml#rerun-the-job-not-the-run pins this endpoint literal.
   */
  requeueCheck?: (pr: OpenPrView, check: CancelledRequiredCheck) => void | Promise<void>;
  /**
   * W1-T1223 — a SECOND cancellation of the SAME check on the SAME head, after this lane already
   * spent its one re-queue. Distinct from `escalate`, which asks an operator to pick between two
   * candidate diffs: here there is no diff to choose, only a CI-side fault re-queueing cannot
   * reach. Omitted, the sweep still names the second cancellation on its disposed line.
   */
  escalateCancelledCheck?: (pr: OpenPrView, check: CancelledRequiredCheck, reason: string) => void | Promise<void>;
  /**
   * W1-T1275 — an OPTIONAL fresh read of ONE PR's live rollup, consulted immediately before a
   * blocked-fixable disposition acts. Never the snapshot this pass started from, for the same
   * reason {@link readLiveState} takes that shape: {@link staleCiGateTransition} must compare
   * against a sibling's CURRENT latest attempt. Deliberately NOT a field on `OpenPrView`, which
   * would need a producer literal merely to satisfy producer-completeness for a value only ever
   * correct freshly read. Omitted, the lane never fires — the pre-existing behaviour byte for byte.
   */
  readCiGateRollup?: (pr: OpenPrView) => (RollupCheckEntry[] | undefined) | Promise<RollupCheckEntry[] | undefined>;
  /**
   * W1-T1275 — re-drive `ci-gate`'s OWN job through the same per-job Actions route
   * {@link requeueCheck} uses, when {@link staleCiGateTransition} names a sibling that reached a
   * terminal success LATER than the gate's own verdict. Called AT MOST ONCE per (head,
   * sibling-transition). Omitted, the sweep still ledgers the transition and stands down.
   */
  reaggregateCiGate?: (pr: OpenPrView, transition: StaleCiGateTransition) => void | Promise<void>;
  /**
   * W1-T177 — an OPTIONAL fresh re-read of ONE PR's live state, consulted immediately before a
   * blocked-fixable disposition SPENDS a strike. Never the snapshot this pass started from, which
   * may already be stale by the time a later PR is reached (#388: merged mid-sweep, dispatched
   * anyway). Omitted, or a failed read, behaves exactly as before this check existed — standing
   * down fires ONLY on a positive, freshly observed terminal reading.
   */
  readLiveState?: (pr: OpenPrView) => LiveStateResult | Promise<LiveStateResult>;
  /**
   * W1-T2789 — fresh reversed-compare evidence for a checks-red PR that the strike table would
   * otherwise make terminal. Optional/unreadable means the ordinary disposition is preserved.
   * The decision itself is {@link decideRedBaseRefresh}, shared verbatim with the fix rung.
   */
  readRedBaseRefreshFacts?: (pr: OpenPrView) => RedBaseRefreshFacts | Promise<RedBaseRefreshFacts>;
  /**
   * W1-T254 — when supplied, gates which disposition may actually act THIS pass; one that fails
   * the predicate stands down, still ledgered, never silently skipped. The light-sweep ticker
   * admits only `post-review`, the deterministic sha-pinned re-post safe alongside a running task,
   * so every other lane waits for the next full sweep. Those calls now run concurrently with each
   * other, so this lane is no longer "serialized" — it is the one safe to run alongside `runOne`.
   */
  actionable?: (d: Disposition) => boolean;
  /**
   * W1-T2426 — WHY {@link SweepDeps.actionable} REFUSED, when the caller can say. That predicate is
   * bare, so every disposition it gates recorded one generic sentence — legible for a lane the
   * light pass never runs, NOT legible for a `post-review` that was eligible and merely lost this
   * pass's admission. Consulted ONLY after a refusal, so it can never admit anything.
   * // Why: 289 such rows across 18 PRs, none naming the mechanism.
   */
  standDownReasonFor?: (d: Disposition) => string | undefined;

  /**
   * W1-T2379 — DO NOT AWAIT THE FIX RUNG'S CI WAIT. Set ONLY by {@link runSweepLightPass}.
   * WHAT IT CHANGES, PRECISELY: the dispatch is still CALLED and still writes its `acted: true` row
   * before returning, so the dedup seed is untouched — only the `await` moves into
   * {@link drainDetachedSweepActions}. NOT AN ADMISSION CHANGE: this decides only how long the
   * caller blocks, never whether a fix may be dispatched.
   */
  detachFixWait?: boolean;
  /**
   * THE ABSENT-CHECK-SUITE REMEDY (W1-T186 follow-up). Pushes an EMPTY commit to the PR's own
   * branch, minting a fresh head sha, and returns it. Omitted, the lane stands down and the
   * ordinary escalation runs — never a silent no-op, the stand-down is named on the disposed line.
   */
  repushAbsent?: (pr: OpenPrView) => Promise<string | undefined>;
  /**
   * W1-T528 — press the update-branch button. Invoked AT MOST ONCE per pass, on the single PR
   * {@link selectUpdateBranchTarget} chose: never a loop, never a second attempt this pass.
   * Omitted, the pass reports the stalled set and requests nothing. A `"conflict"` outcome is
   * REPORTED and never retried by this call; a later pass makes its own fresh selection.
   */
  updateBranch?: (pr: ArmedStalledPr) => UpdateBranchOutcome | Promise<UpdateBranchOutcome>;
  /**
   * W1-T528: task ids with a LIVE in-flight run right now. Consulted by
   * {@link selectUpdateBranchTarget} to skip a head a live worker is still pushing to. Omitted
   * means an empty set, exactly as if every PR's worker had already finished.
   */
  inFlightTaskIds?: ReadonlySet<string>;
  /**
   * W1-T1212 — per red PR, the failing check names whose defining workflow blob differs between
   * this PR's OWN merge ref and main RIGHT NOW: the ONLY population {@link redPrWithStaleGate}
   * draws from. Cheap and exact, never re-derived from `checksState` alone, which is what let a
   * red PR spin forever behind a gate that had already moved on main. Omitted means an empty map.
   */
  staleGateWorkflowsByPr?: ReadonlyMap<number, readonly string[]>;
  /**
   * W1-T1212 — every `${prNumber}:${workflowName}` pair this lane has ALREADY requested an update
   * for. An update mints a new head and a second request for the same pair is a no-op that still
   * spends one, so a fired pair must be remembered and skipped. Read from prior ledger rows, the
   * SAME durable sink every other dedup here uses, never a second store. Omitted means empty.
   */
  updatedForWorkflow?: ReadonlySet<string>;
  /**
   * W1-T2620 — an OPTIONAL, per-PASS read of `origin/main`'s CURRENT tip, consulted ONCE before
   * the per-PR walk, never per PR. This module never calls gh or git, so the read is the caller's.
   * Feeds {@link selectBaseCausedRelease}'s "main has moved" condition — never the `behind`
   * GitHub reports, since a base-caused PR is red by construction and cannot read `"behind"`.
   * Omitted, the release lane never fires and the pass is BYTE-IDENTICAL to before this task.
   */
  readMainTip?: () => string | undefined | Promise<string | undefined>;
  /**
   * W1-T2620 — RELEASE the one base-caused stand-down chosen this pass: never a loop, the same
   * AT-MOST-ONCE shape the update-branch dep uses. THE LEAF IS THE ONE THAT EXISTS — the same
   * push leaf already wired elsewhere, never a second outward path. Omitted, the target still
   * stands down with the ordinary sentence; a THROW is caught and treated identically, FAIL QUIET,
   * never a false "released" ledger line.
   */
  releaseBaseCausedStandDown?: (pr: OpenPrView, mainTipSha: string) => void | Promise<void>;
  /** Absolute path to state/ledger.ndjson — dedup source + sweep.disposed sink. */
  ledgerPath: string;
  /** The sweep's run id (e.g. SWEEP-<epochMs> / DAEMON-<epochMs>). */
  runId: string;
  /** Ledger reader (dedup); defaults to readLedgerLines. Injectable for tests. */
  readLedger?: (path: string) => Array<Record<string, unknown>>;
  /** Ledger appender; defaults to appendLedger. Injectable for tests. */
  appendLine?: (path: string, line: Record<string, unknown> & { run_id: string; task_id: string; step: string }) => void;
  /** Injected clock for the stale window (default Date.now). */
  now?: () => number;
  /** One console/ledger-adjacent line per disposition (optional). */
  log?: (step: string, extra?: Record<string, unknown>) => void;
  /**
   * Preview only: derive dispositions, take NO effects, write NO ledger lines.
   * Returns the same summary shape so `rmd sweep --dry-run` can print the plan.
   */
  dryRun?: boolean;
  /**
   * W1-T905 — best-effort capture of a §7B entry for ONE surface found due this pass.
   * NEVER ALLOWED TO FAIL THE PASS that produced the repairs it reports on: every call is wrapped
   * in the SAME throw containment the action switch has. This pure module never touches the
   * filesystem — the fold recomputes fresh with no memory of what was filed, and the injected
   * dep's own idempotent write is the entire "no second store" guarantee.
   */
  captureRepairFeedback?: (filing: RepairFilingCapture) => void | Promise<void>;
  /**
   * W1-T931 COST-ANOMALY SENTINEL — the `plan/policy.yaml` policy this pass consults; see
   * `cost-anomaly.ts`'s header for the rationale. Omitted, `runSweep` resolves the default,
   * memoized for the process lifetime. A test wanting different thresholds without touching
   * `plan/policy.yaml` on disk passes its own policy here.
   */
  costAnomalyPolicy?: CostAnomalyPolicy;
}

/** What one PR's reconciliation did this sweep. */
export interface SweepAction {
  prNumber: number;
  prUrl: string;
  taskId?: string;
  disposition: Disposition;
  reason: string;
  /** True ⇒ the gated effect actually fired; false ⇒ deduped (already true). */
  acted: boolean;
  /** Set only for `blocked-ambiguous` (W1-T78) — the rendered clarification question. */
  question?: ClarificationQuestion;
  /**
   * W1-T254: set when this PR's gated action THREW. `acted` is false, but this is distinct from
   * dedup, dry-run and stand-down: the action was attempted and failed, and is named here rather
   * than propagating out of `runSweep` and aborting the rest of the pass.
   */
  actionError?: string;
  /**
   * W1-T2231 — set ONLY for the two dispatch-based repair surfaces whose dispatch returned a
   * concrete verdict. `undefined` everywhere else, including today's real wiring, and deliberately
   * NEVER read as "no repair" — only an EXPLICIT `false` is. THIS IS NEVER `acted`, AND NEVER
   * CHANGES IT: `acted` still means "the lane was invoked" and stays the dedup seed.
   */
  spent?: boolean;
}

/** The whole sweep's outcome — counts per disposition + the per-PR actions. */
export interface SweepSummary {
  /** Total open PRs reconciled. */
  total: number;
  /** How many PRs landed in each disposition (every PR is counted exactly once). */
  byDisposition: Record<Disposition, number>;
  /** How many gated effects actually fired (deduped ones are excluded). */
  actionsTaken: number;
  /**
   * W1-T99: how many gated effects were ATTEMPTED and THREW — distinct from `actionsTaken` and
   * from PRs that never attempted. Each also has its own `sweep.action_failed` ledger line; this
   * is the pass-level count a caller reads without re-deriving it from `actions`.
   */
  actionsFailed: number;
  /** Per-PR detail, in input order. */
  actions: SweepAction[];
  /** INVARIANT proof: PRs that derived no disposition — MUST be 0. */
  noneCount: number;
}

/** Prior actions this ledger already recorded (acted:true), for idempotence dedup. */
interface PriorActions {
  /** `<prNumber>@<headSha>` — sha-keyed like {@link PriorActions.fixed}, so a new head
   *  re-earns the arm attempt instead of being deduped forever on one prior success. */
  armed: Set<string>;
  /** `${prNumber}@${headSha}` — fix dispatch is head-keyed. */
  fixed: Set<string>;
  closed: Set<number>;
  /**
   * `pr@head` keys, exactly like the sibling sets (W1-T514). PR-number-only until then, which let
   * one `acted:true` line at head A dedup the SAME PR forever, including a genuinely NEW block at
   * head B — where `escalate()`'s own composite key already knows to open a fresh issue. That
   * transport-side fix was unreachable while this gate never let a second head through. A new head
   * re-earns the attempt; the SAME head still dedupes, so there is no per-push storm.
   */
  escalated: Set<string>;
  /** `pr@head` keys whose dep-review reached a TERMINAL outcome (arm/escalate/refuse). */
  depReviewed: Set<string>;
  /**
   * Exact-input keys with a DELIVERED verdict. NOT keyed off `sweep.disposed acted:true` like the
   * other sets: that proves only the LANE WAS INVOKED, never that it reached a verdict, and keying
   * on the attempt suppressed the same input forever after one no-op invocation. W1-T1213 split off
   * {@link reviewRefused} — a DELIVERED VERDICT and a REFUSED ATTEMPT are not the same fact.
   */
  reviewDelivered: Set<string>;
  /**
   * Exact-input keys with an explicit refusal that still suppresses this input — every refusal
   * EXCEPT the class {@link isReopenedClosedLifecycleRefusal} names as provably stale. A refusal
   * leaves GitHub's status untouched, so without a key the lane would re-invoke the same input
   * every pass. W1-T1213: the "already closed" refusal is never admitted, because its own condition
   * is FALSIFIED BY CONSTRUCTION. That re-arms the head WITHOUT deciding anything — the lifecycle
   * gate is re-tested fresh. Every OTHER refusal, "already merged" included, suppresses forever.
   */
  reviewRefused: Set<string>;
  /**
   * Exact-input keys whose sweep-owned review attempt THREW before it delivered a verdict.
   * The value is the latest parseable ledger timestamp in milliseconds, or `undefined` when
   * every matching row is undated. Unlike {@link reviewRefused}, this is a bounded retry clock,
   * not a semantic or lifecycle decision about the PR (W1-T2753).
   */
  reviewRetryableThrows: Map<string, number | undefined>;
  /**
   * W1-T970 — keys built off the risk judge's OWN step, never from `sweep.disposed`.
   * PR-NUMBER-KEYED, deliberately unlike the review sets: the sweep has the number in hand and the
   * producer emits it, so there is no `??` fallback anywhere on this path and the
   * matching-nothing collapse that shipped in #1931 has no equivalent here. A refusal expires on a
   * NEW head sha or an explicit override, never by time. A MAP since W1-T1116, so a refused hold
   * can name the SAME issue rather than making a reader find that row.
   */
  riskRefused: Map<string, string | undefined>;
  /**
   * ABSENT-check-suite re-push history, read from this module's OWN `sweep.absent_repush` step.
   * TWO keys because one is not enough: `shas` gives same-head idempotence, and `count` per PR is
   * the BOUND — a re-push mints a NEW sha, so a sha key alone would license an unbounded chain of
   * empty commits on a PR GitHub never schedules.
   */
  absentRepushes: Map<number, { count: number; shas: Set<string> }>;
}

/** One review outcome key. Attributed rows use the material input; legacy rows and unwired
 *  fixtures retain the historical task+head key, so migration changes no local semantics. A real
 *  current view always carries `reviewInputDigest`, so a legacy row cannot pin a changed body. */
function reviewOutcomeKey(
  taskId: string,
  prUrl: string | undefined,
  headSha: string,
  inputDigest: string | undefined,
): string {
  return prUrl !== undefined && inputDigest !== undefined
    ? `input:${JSON.stringify([taskId, prUrl, headSha, inputDigest])}`
    : `${taskId}@${headSha}`;
}

function reviewOutcomeKeyForPr(pr: OpenPrView): string {
  const taskId = pr.reviewInputDigest !== undefined ? (pr.taskId ?? `PR-${pr.prNumber}`) : (pr.taskId ?? "");
  return reviewOutcomeKey(taskId, pr.prUrl, pr.headSha, pr.reviewInputDigest);
}

/**
 * W1-T529 — WHAT EACH LANE'S STAND-DOWN COSTS, NAMED SO THE COST IS CHOSEN RATHER THAN DISCOVERED,
 * and carried verbatim into the PR's own reason so a declined pass reads as declined, not idle.
 * THIS TABLE NAMES A COST; IT DECIDES NOTHING — by the time it is read the guarded call has ALREADY
 * been refused. A disposition missing from it still stands down under the generic reason.
 */
const BUDGET_FLOOR_LANE_COST: Partial<Record<Disposition, string>> = {
  // Design (iv), verbatim: "A SKIPPED REVIEW leaves a GREEN PR UNMERGED — visible, recoverable
  // next pass." RECOVERABLE is load-bearing — see the refusal key this deliberately does NOT write.
  "post-review": "a green PR is left unmerged this pass and re-derives next tick",
  // Design (iv), verbatim: "A SKIPPED FIX STRIKE MUST NOT CONSUME THE STRIKE."
  "blocked-fixable": "a fix dispatch is skipped and NO strike is spent",
  // Same lane, same dedup set (`fixed`) — W1-T106 folded `conflicted` into it, so it inherits
  // that guarantee rather than getting a second one.
  conflicted: "a conflict fix dispatch is skipped and NO strike is spent",
  // Arming is idempotent at the GitHub level, so a deferred arm loses nothing but a tick.
  mergeable: "an auto-merge arm is deferred one pass; arming is idempotent so nothing is lost",
  // An escalation not raised is strictly better than one raised twice; the PR stays open and is
  // re-derived whole next pass.
  "blocked-ambiguous": "an escalation is deferred; the PR stays open and is re-derived next pass",
  // The hold/terminal outcome is re-read from live state next pass, so nothing is carried.
  "dep-review": "a dependency review is deferred one pass and re-read from live state",
  // Closing a stale PR is the least urgent action the sweep takes.
  stale: "a stale-PR close is deferred one pass",
};

/**
 * W1-T529 — IS THIS THROW THE BUDGET FLOOR, AND WHAT DOES DECLINING THIS LANE COST? Returns the
 * stand-down reason when it is, `undefined` for every other throw.
 *
 * WHY THE TWO CLASSES MUST NOT SHARE A PATH: a stand-down is not a failed action — the call never
 * ran. Routing it through `actionError` would write a `review.post_refused` row, and that row is
 * not a diagnostic but a VERDICT, so a PR merely unaffordable for one tick would be deduped
 * permanently and then escalated. AND NO SECOND NO-STRIKE MECHANISM: every caller sets
 * `acted = false`, which alone is the guarantee.
 */
function budgetFloorStandDown(e: unknown, disposition: Disposition): string | undefined {
  if (!(e instanceof GhPaceFloorStandDownError)) return undefined;
  const cost = BUDGET_FLOOR_LANE_COST[disposition] ?? "this lane's action is skipped and re-derives next tick";
  return `gh budget at or below the stand-down floor (${e.resource} at ${e.remaining}/${e.limit}) — ${cost}`;
}

/**
 * W1-T1213 — is `reason` the SPECIFIC "PR is already closed" half of `decideReviewStatusPost`'s
 * lifecycle refusal? Matched on that function's own literal, verbatim, so this is the intended
 * read rather than a guess at prose that could drift.
 *
 * DELIBERATELY NOT the "already merged" sibling: a merged PR has no transition back to
 * `state=open`, so that refusal has no falsifier and must keep suppressing forever.
 */
function isReopenedClosedLifecycleRefusal(reason: unknown): boolean {
  return typeof reason === "string" && reason.startsWith("PR is already closed — refusing to post remudero-review");
}

const RETRYABLE_REVIEW_THROW_PREFIX = "post-review attempt threw — standing down rather than retrying this head unbounded:";

function isRetryableReviewThrow(reason: unknown): boolean {
  return typeof reason === "string" && reason.startsWith(RETRYABLE_REVIEW_THROW_PREFIX);
}

function retryableReviewThrowBackoffReason(
  retryableThrows: ReadonlyMap<string, number | undefined>,
  reviewKey: string,
  policy: SweepPolicy,
  now: number,
): string | undefined {
  if (!retryableThrows.has(reviewKey)) return undefined;
  const attemptedAt = retryableThrows.get(reviewKey);
  // An undated throw cannot prove that the bound is still live. Admit once; if the condition
  // persists, the existing catch writes a fresh dated row and restores the bounded stand-down.
  if (attemptedAt === undefined) return undefined;
  const ageMinutes = Math.max(0, (now - attemptedAt) / 60_000);
  if (ageMinutes >= policy.pendingCeilingMinutes) return undefined;
  return (
    `the last post-review attempt for ${reviewKey} threw ${Math.floor(ageMinutes)}m ago — ` +
    `retry backoff remains inside the ${policy.pendingCeilingMinutes}m pending ceiling; ` +
    `this is a retryable transport/process outcome, not a durable review refusal`
  );
}

function priorActionsFromLedger(lines: Array<Record<string, unknown>>): PriorActions {
  const armed = new Set<string>();
  const fixed = new Set<string>();
  const closed = new Set<number>();
  const escalated = new Set<string>();
  const depReviewed = new Set<string>();
  const reviewDelivered = new Set<string>();
  const reviewRefused = new Set<string>();
  const reviewRetryableThrows = new Map<string, number | undefined>();
  const riskRefused = new Map<string, string | undefined>();
  const absentRepushes = new Map<number, { count: number; shas: Set<string> }>();
  for (const line of lines) {
    // W1-T254/W1-T1213: OUTCOME-KEYED, off the review lane's OWN ledger lines — never
    // `sweep.disposed`. See PriorActions.reviewDelivered/reviewRefused's docs.
    if (line.step === "review.posted" || line.step === "review.post_refused") {
      if (typeof line.task_id === "string" && typeof line.head_sha === "string") {
        const key = reviewOutcomeKey(
          line.task_id,
          typeof line.pr_url === "string" ? line.pr_url : undefined,
          line.head_sha,
          typeof line.review_input_digest === "string" ? line.review_input_digest : undefined,
        );
        if (line.step === "review.posted") {
          reviewDelivered.add(key);
        } else if (isRetryableReviewThrow(line.reason)) {
          const parsed = typeof line.ts === "string" ? Date.parse(line.ts) : Number.NaN;
          const existing = reviewRetryableThrows.get(key);
          if (!reviewRetryableThrows.has(key)) reviewRetryableThrows.set(key, undefined);
          if (!Number.isNaN(parsed) && (existing === undefined || parsed > existing)) {
            reviewRetryableThrows.set(key, parsed);
          }
        } else if (!isReopenedClosedLifecycleRefusal(line.reason)) {
          // W1-T1213: the "PR is already closed" refusal is excluded here, never added to
          // `reviewRefused` — see that field's own doc for why reaching this fold at all
          // already proves the refusal's named condition (the PR being closed) has ended.
          reviewRefused.add(key);
        }
      }
      continue;
    }
    // W1-T970: OUTCOME-KEYED off the risk judge's OWN step, never `sweep.disposed`. PR-number
    // keyed, and both fields are REQUIRED with no `??` fallback, so a pre-W1-T970 row written
    // before the producer emitted them is never matched.
    if (line.step === "risk_judge.escalated") {
      if (typeof line.pr_number === "number" && typeof line.head_sha === "string") {
        // W1-T1116: carry `issue_url` with the key. `undefined` rather than a `??` fallback when
        // an older row predates the field, so the `mergeable` arm can tell "no issue to name"
        // from "row missing" without a sentinel string.
        riskRefused.set(`${line.pr_number}@${line.head_sha}`, typeof line.issue_url === "string" ? line.issue_url : undefined);
      }
      continue;
    }
    // Our own step, not `sweep.disposed` — the re-push is an action inside the
    // blocked-ambiguous lane, so the disposed line's own dedup keys cannot carry it.
    if (line.step === "sweep.absent_repush") {
      const n = typeof line.pr_number === "number" ? line.pr_number : undefined;
      if (n !== undefined) {
        const e = absentRepushes.get(n) ?? { count: 0, shas: new Set<string>() };
        e.count += 1;
        if (typeof line.old_head === "string") e.shas.add(`${n}@${line.old_head}`);
        absentRepushes.set(n, e);
      }
      continue;
    }
    if (line.step !== "sweep.disposed" || line.acted !== true) continue;
    const pr = typeof line.pr_number === "number" ? line.pr_number : undefined;
    if (pr === undefined) continue;
    switch (line.disposition) {
      case "mergeable":
        // SHA-KEYED, exactly like `fixed` below. Keyed by PR number alone this set had no
        // expiry: one `acted:true` line — including one recorded for an arm that never
        // happened — deduped that PR forever. A new head must re-earn the attempt.
        armed.add(`${pr}@${typeof line.head_sha === "string" ? line.head_sha : ""}`);
        break;
      case "blocked-fixable":
      // W1-T106: a `conflicted` dispatch is the SAME "spend a fix-rung
      // strike, re-earned by a new head sha" shape as blocked-fixable —
      // dedup off the SAME set, never a second, independently-tracked one.
      case "conflicted":
        fixed.add(`${pr}@${typeof line.head_sha === "string" ? line.head_sha : ""}`);
        break;
      case "stale":
        closed.add(pr);
        break;
      case "blocked-ambiguous":
        // W1-T514: SHA-KEYED, exactly like `fixed`/`armed` above — a new head
        // must re-earn the attempt rather than being deduped by a stale one.
        escalated.add(`${pr}@${typeof line.head_sha === "string" ? line.head_sha : ""}`);
        break;
      case "dep-review":
        // Only a TERMINAL outcome dedups; a "hold" must re-run next sweep so a
        // same-sha red check going green is picked up (see SweepDeps.depReview).
        if (line.dep_review_outcome !== "hold") {
          depReviewed.add(`${pr}@${typeof line.head_sha === "string" ? line.head_sha : ""}`);
        }
        break;
      // "post-review" deliberately absent here (W1-T254): see the
      // `review.posted`/`review.post_refused` branch above.
    }
  }
  return {
    armed,
    fixed,
    closed,
    escalated,
    depReviewed,
    reviewDelivered,
    reviewRefused,
    reviewRetryableThrows,
    riskRefused,
    absentRepushes,
  };
}

/**
 * W1-T1110 — HAS THE MOST RECENT `fix.dispatch` FOR THIS TASK ALREADY CONCLUDED WITHOUT LANDING A
 * NEW HEAD? `prior.fixed` records only that a fix was DISPATCHED, never an outcome, and clears
 * only on a new head — so a dispatch that ran and ENDED without pushing leaves the key set and the
 * head unmoved, and every later pass stands down FOREVER.
 *
 * Reads the two steps that answer "concluded, and did NOT succeed". `fix.resolved` is read but
 * never counted as stalled, since re-arming on a landed push risks a redundant dispatch. TASK-ID
 * KEYED, safe because every caller already guards on the PR's CURRENT head being the dispatched
 * one, and scoped to the MOST RECENT dispatch so an earlier conclusion never re-arms a live strike.
 *
 * W1-T1210 — A TASKID WITH NO `fix.dispatch` ROW IS THE SAME SHAPE ONE STEP EARLIER: the caller
 * can throw before the rung starts while the seeding row is still written `acted: true`. Such a
 * seed owns no fix row, so nothing can mark it stalled and it reads as healthily in flight when
 * nothing started. The ABSENCE of the row is the falsifier. // Why: docs/forensics/sweep.md.
 */
function fixRungStalledWithoutNewHead(lines: Array<Record<string, unknown>>, taskId: string | undefined): boolean {
  if (!taskId) return false;
  let stalled = false;
  let dispatched = false;
  for (const line of lines) {
    if (line.task_id !== taskId) continue;
    if (line.step === "fix.dispatch") {
      dispatched = true;
      stalled = false;
    } else if (line.step === "fix.ci_not_green") {
      stalled = true;
    } else if (line.step === "fix.review") {
      stalled = line.state !== "success";
    } else if (line.step === "fix.resolved") {
      stalled = false;
    }
  }
  // W1-T1210: no owning `fix.dispatch` row at all ⇒ treated as stalled — see the doc above.
  return stalled || !dispatched;
}

// ── W1-T905 — "repair the instance, FILE THE CLASS" ──────────────────────────────────────────
//
// A `sweep.disposed` row already NAMES a classified surface every time the sweep repairs a PR, but
// nothing rolls that up across PRs, so a defect repaired fifteen times is rediscovered by hand
// fifteen times. THIS IS NOT A ROUTER, A LANE OR A RUNG: the ONE addition is the bridge from a
// recurring surface to a §7B entry — a pure fold over rows that already exist.

/** The dispositions {@link priorActionsFromLedger}'s switch treats as an actual REPAIR verb having
 *  fired. `mergeable` is the HEALTHY outcome, not a defect, and the routing states have no repair
 *  verb of their own. Scoped to exactly these four so a PR arming fifteen times — ordinary, healthy
 *  throughput — never floods the §7B inbox, the wrong-recurrence-key failure this task's risk note
 *  names explicitly. */
const REPAIR_SURFACE_DISPOSITIONS: ReadonlySet<Disposition> = new Set(["blocked-fixable", "blocked-ambiguous", "stale", "conflicted"]);

/** One PR's own repair, as read off its `sweep.disposed` row — never invented (design v). */
export interface RepairFilingInstance {
  prNumber: number;
  prUrl: string;
  /** The ledgered disposition `reason` verbatim — for a CI-failure surface this already embeds
   *  the failing check name(s) + sha(s) `describeCiFailures` names, when observed. */
  reason: string;
  headSha: string;
  /** The `sweep.disposed` row's own ledgered timestamp (ISO-8601, stamped by `appendLedger`). */
  ts: string;
}

/** One classified surface due for exactly ONE `repair#<surface>` feedback entry this pass —
 *  {@link dueRepairFilings}'s output, and {@link SweepDeps.captureRepairFeedback}'s input via
 *  {@link renderRepairFilingRaw}/the `repair#<surface>` origin string `runSweep` builds from it. */
export interface RepairFilingRecurrence {
  surface: Disposition;
  threshold: number;
  windowDays: number;
  windowStart: string;
  windowEnd: string;
  /** Distinct PRs (by `prNumber`) repaired for `surface` inside the window — length >= threshold. */
  instances: RepairFilingInstance[];
  /** Deterministic — `fb-repair-<surface>-<window-bucket>`. STABLE for the same surface across
   *  every pass inside the SAME window, so the caller-side dedup never re-files twice for one
   *  window, and a genuinely new window can file again once the pattern persists into it. */
  id: string;
}

/**
 * PURE fold over already-written `sweep.disposed` rows — no new ledger row, nothing new to read.
 * Counts the DISTINCT PRs repaired for each surface inside the current epoch-anchored window, so
 * the same window yields the same filing id. Fifteen PRs repaired for one surface must produce ONE
 * entry, never fifteen, and a single repair must produce NONE.
 *
 * DISTINCT PRs rather than raw rows is deliberate: one PR stuck across many passes must never
 * inflate the count alone. No I/O and no dedup memory — it recomputes fresh every call.
 * W1-T2231: `acted: true` proves only that the LANE WAS INVOKED, so a row whose `spent` reads
 * EXPLICITLY `false` is excluded. A NARROWING, never a rejoin against a different key.
 */
export function dueRepairFilings(
  lines: ReadonlyArray<Record<string, unknown>>,
  now: number,
  policy: Pick<SweepPolicy, "repairFilingThreshold" | "repairFilingWindowDays">,
): RepairFilingRecurrence[] {
  const windowMs = policy.repairFilingWindowDays * 24 * 60 * 60 * 1000;
  const bucket = Math.floor(now / windowMs);
  const windowStart = bucket * windowMs;
  const windowEnd = windowStart + windowMs;

  const bySurface = new Map<Disposition, Map<number, RepairFilingInstance>>();
  for (const line of lines) {
    if (line.step !== "sweep.disposed" || line.acted !== true) continue;
    const surface = line.disposition as Disposition;
    if (!REPAIR_SURFACE_DISPOSITIONS.has(surface)) continue;
    // W1-T2231: `acted: true` only proves the lane fired. A dispatch-based surface marks a
    // demonstrably-empty invocation `spent: false`, and THAT is what a repair count must exclude.
    // `undefined` is deliberately NOT treated as `false` — only an explicit no-spend excludes.
    if (line.spent === false) continue;
    const ts = typeof line.ts === "string" ? line.ts : undefined;
    if (!ts) continue;
    const tsMs = Date.parse(ts);
    if (!Number.isFinite(tsMs) || tsMs < windowStart || tsMs >= windowEnd) continue;
    const prNumber = typeof line.pr_number === "number" ? line.pr_number : undefined;
    if (prNumber === undefined) continue;
    const perPr = bySurface.get(surface) ?? new Map<number, RepairFilingInstance>();
    // Last-write-wins per PR — a PR re-dispatched several times this window is counted ONCE,
    // carrying its most recent SPENDING repair's evidence. A later `spent: false` row is excluded
    // above, so it can never overwrite an earlier genuine repair with a no-spend reason.
    perPr.set(prNumber, {
      prNumber,
      prUrl: typeof line.pr_url === "string" ? line.pr_url : "",
      reason: typeof line.reason === "string" ? line.reason : "(no reason captured)",
      headSha: typeof line.head_sha === "string" ? line.head_sha : "",
      ts,
    });
    bySurface.set(surface, perPr);
  }

  const due: RepairFilingRecurrence[] = [];
  for (const [surface, perPr] of bySurface) {
    const instances = [...perPr.values()].sort((a, b) => a.prNumber - b.prNumber);
    if (instances.length < policy.repairFilingThreshold) continue;
    due.push({
      surface,
      threshold: policy.repairFilingThreshold,
      windowDays: policy.repairFilingWindowDays,
      windowStart: new Date(windowStart).toISOString(),
      windowEnd: new Date(windowEnd).toISOString(),
      instances,
      id: `fb-repair-${surface}-${bucket}`,
    });
  }
  return due;
}

/** What {@link SweepDeps.captureRepairFeedback} is invoked with — the real wiring's exact
 *  `captureFeedback` arguments (id + origin + raw), decoupled from `src/lib/feedback.ts`'s own
 *  option shape so this module imports no effect from it (design ix). */
export interface RepairFilingCapture {
  id: string;
  /** `repair#<surface>` — built by `runSweep` from {@link RepairFilingRecurrence.surface}. */
  origin: string;
  raw: string;
}

/**
 * Render ONE due surface's evidence body: the classified surface, the window and threshold that
 * triggered filing, and per repaired PR the number, url, head sha and the disposition `reason`
 * already ledgered for it. NEVER invents a cause — root cause is explicitly stated as unobserved,
 * since this fold only ever reports RECURRENCE.
 */
export function renderRepairFilingRaw(filing: RepairFilingRecurrence): string {
  const lines = filing.instances.map(
    (i) => `- PR #${i.prNumber} (${i.prUrl || "url not captured"}) at ${i.headSha ? i.headSha.slice(0, 7) : "sha not captured"}, ${i.ts}: ${i.reason}`,
  );
  return [
    `SWEEP REPAIR RECURRENCE: the "${filing.surface}" surface was repaired for ${filing.instances.length} distinct PRs ` +
      `between ${filing.windowStart} and ${filing.windowEnd} (threshold ${filing.threshold}, window ${filing.windowDays}d).`,
    "",
    "Root cause is UNOBSERVED — this is a recurrence report, not a diagnosis: the sweep classifies " +
      "and repairs the INSTANCE (each PR below), it does not investigate why the CLASS keeps recurring.",
    "",
    "EVIDENCE (read verbatim off each PR's own sweep.disposed ledger row, never invented):",
    ...lines,
  ].join("\n");
}

const ZERO_COUNTS = (): Record<Disposition, number> => ({
  mergeable: 0,
  "blocked-fixable": 0,
  "dep-review": 0,
  "post-review": 0,
  stale: 0,
  "blocked-ambiguous": 0,
  conflicted: 0,
  wait: 0,
});

/**
 * W1-T513 — THE CROSS-CALL REVIEW-KEY MUTEX. The claim set used to be declared FRESH INSIDE every
 * `runSweep` call, so it arbitrated only between PRs in that ONE call and gave no protection at
 * all between two SEPARATE invocations racing. MODULE-SCOPED so every caller in the process shares
 * it without new wiring. NOT PROCESS-GLOBAL-FOREVER: a key is added when a worker is ready to
 * START, not while the walk discovers it, and removed the instant the attempt settles.
 */
const inFlightReviewKeys = new Set<string>();

/**
 * W1-T2520 — THE FIX-DISPATCH MUTEX, {@link inFlightReviewKeys}'s SIBLING for the other lane.
 * `priorStrikes` is derived by COUNTING dispatch rows at view-build time, with no exclusion
 * between that count and the dispatch it gates, so two calls in one process can both read the same
 * pre-dispatch state and both see strikes under the cap.
 *
 * A CLAIM ALONE IS NOT ENOUGH: a later, non-concurrent call would still carry the first call's
 * stale count, so {@link claimFixDispatch} RE-READS the ledger the instant the claim is taken.
 * KEYED IDENTICALLY to the review mutex so there is one spelling of "this PR is being worked", but
 * a SEPARATE Set — the two lanes are different budgets and must never block each other.
 * // Why: observed live as 13 dispatches across two PRs against a cap of 2.
 */
const inFlightFixKeys = new Set<string>();

/**
 * W1-T2788 — select the fix-rung ledger generation attributable to `currentHeadSha`. New rows name
 * the head they targeted and require exact equality; legacy rows carry no head and reset only at a
 * trustworthy observation for this task at the current head, so an incomplete history fails closed
 * rather than manufacturing strike budget. `fix.review` also carries no head, so associate it only
 * with the most recent selected dispatch sharing its strike number.
 */
export function fixLedgerRowsForHead(
  lines: Array<Record<string, unknown>>,
  taskId: string | undefined,
  currentHeadSha?: string,
): Array<Record<string, unknown>> {
  if (!taskId) return [];
  if (!currentHeadSha) {
    return lines.filter(
      (line) => line.task_id === taskId && (line.step === "fix.dispatch" || line.step === "fix.review"),
    );
  }

  let legacyBoundary = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.task_id === taskId && line.step === "sweep.disposed" && line.head_sha === currentHeadSha) {
      legacyBoundary = i;
    }
  }

  const selected: Array<Record<string, unknown>> = [];
  const selectedStrikes = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.task_id !== taskId) continue;
    const strike = typeof line.strike === "number" ? line.strike : undefined;
    if (line.step === "fix.dispatch") {
      const taggedHead = typeof line.head_sha === "string" ? line.head_sha : undefined;
      const belongsToHead = taggedHead !== undefined
        ? taggedHead === currentHeadSha
        : legacyBoundary < 0 || i > legacyBoundary;
      if (strike !== undefined) {
        if (belongsToHead) selectedStrikes.add(strike);
        else selectedStrikes.delete(strike);
      }
      if (belongsToHead) selected.push(line);
      continue;
    }
    if (line.step === "fix.review" && strike !== undefined && selectedStrikes.has(strike)) {
      const taggedHead = typeof line.head_sha === "string" ? line.head_sha : undefined;
      if (taggedHead === undefined || taggedHead === currentHeadSha) selected.push(line);
    }
  }
  return selected;
}

/**
 * W1-T2520 — the fresh under-claim counterpart to `priorStrikesFor`. What it adds is FRESHNESS: it
 * reads the ledger AFTER taking the claim, so two callers cannot act on the same stale count.
 * COUNTS DISTINCT `strike` NUMBERS, NOT RAW ROWS — two GENUINE strikes can never share a number, so
 * a duplicate value is always the SAME attempt re-described. Rows with no numeric `strike` are each
 * counted on their own, the ledger giving this fold nothing to dedupe them by.
 */
function freshFixDispatchCount(
  lines: Array<Record<string, unknown>>,
  taskId: string | undefined,
  currentHeadSha: string,
): number {
  if (!taskId) return 0;
  const strikeNumbers = new Set<number>();
  let unnumbered = 0;
  for (const line of fixLedgerRowsForHead(lines, taskId, currentHeadSha)) {
    if (line.step !== "fix.dispatch") continue;
    if (typeof line.strike === "number") {
      strikeNumbers.add(line.strike);
    } else {
      unnumbered++;
    }
  }
  return strikeNumbers.size + unnumbered;
}

/**
 * W1-T2379 — THE DETACHED-WAIT REGISTRY, module-scoped for the reason {@link inFlightReviewKeys}
 * is. WHY IT EXISTS: the ticker awaits the light pass, which awaits every open PR, and
 * `dispatchFix` waits on CI — so the tick's period was the interval plus the longest action, a
 * term bounded by GitHub Actions rather than anything this repo sets.
 *
 * NOT FIRE-AND-FORGET, WHICH IS THE WHOLE DIFFICULTY: the dispatch is STARTED and its `acted: true`
 * row WRITTEN synchronously inside the pass, because that row seeds the dedup and is what
 * {@link fixRungStalledWithoutNewHead} re-arms from. Only the CI wait moves out of the await. A
 * DETACHED REJECTION IS SWALLOWED ON PURPOSE — rethrowing would surface long after the pass
 * returned, attributable to nothing.
 */
const detachedSweepActions = new Set<Promise<void>>();

/**
 * W1-T2379: hand a started action to {@link detachedSweepActions} so the caller need not await it.
 * The stored promise is already settled-safe — its rejection is caught here — so a drain can never
 * itself reject. Returns nothing: a caller wanting the outcome must await the original.
 */
function detachSweepAction(work: Promise<unknown>): void {
  const held: Promise<void> = work.then(
    () => undefined,
    () => undefined,
  );
  detachedSweepActions.add(held);
  void held.finally(() => detachedSweepActions.delete(held));
}

/**
 * W1-T2379 — LET WORK ALREADY IN FLIGHT FINISH RATHER THAN ABORTING IT. Awaits every detached
 * action and settles once they all have. W1-T2744: an explicit daemon-lifetime seam, never part of
 * a phase-local ticker's stop. Safe to call when nothing is detached, and safe to call twice.
 */
export async function drainDetachedSweepActions(): Promise<void> {
  while (detachedSweepActions.size > 0) {
    await Promise.all([...detachedSweepActions]);
  }
}

/** W1-T2379/W1-T2744: how many detached actions are still in flight. The daemon heartbeat reports
 *  this bounded count for observability; no production reader branches on it. */
export function detachedSweepActionCount(): number {
  return detachedSweepActions.size;
}

/**
 * THE SHARED ENTRY POINT: BOTH `rmd sweep` and the daemon poll loop call this ONE function. It
 * re-derives every open PR's disposition fresh, takes the ONE gated action per PR, writes one
 * `sweep.disposed` line per PR, and returns a summary both callers log.
 *
 * W1-T473 — REVIEW CONCURRENCY: every disposition EXCEPT `post-review` runs as before, one PR at a
 * time in `openPrs` order. `post-review` PRs run in a SECOND, bounded phase, each against a
 * DISTINCT key claimed synchronously during the walk — the real mutual exclusion the
 * single-threaded walk used to supply for free. The lane count is a CEILING, never a target, and
 * `summary.actions` still returns in `openPrs` order whichever phase finalized each PR.
 */
/**
 * W1-T1218 — THE REVIEW LANE'S ORDER, AS A PURE FUNCTION: a NEW array ordered OLDEST-FIRST, so
 * bounded workers pull the entries that have waited longest.
 *
 * WHY: insertion order is enumeration order and GitHub answers the unsorted listing newest-first,
 * so cutting by position puts the OLDEST entries below the cut and re-deriving reproduces the same
 * order — a PR below the cut is deferred indefinitely. THE KEY IS `createdAt`, with `prNumber` as
 * both tiebreak and substitute, which keeps the comparator TOTAL.
 *
 * THE COST, NAMED RATHER THAN SOLD: creation time is not waiting time, so a long-lived PR pushed
 * moments ago can take a lane ahead of a younger one waiting hours. That is a fairness
 * imperfection, not a starvation one, and it is INERT when every entry gets a lane.
 */
export function orderPendingReviews<T extends { pr: Pick<OpenPrView, "createdAt" | "prNumber"> }>(
  jobs: readonly T[],
): T[] {
  const createdMs = (job: T): number | undefined => {
    const raw = job.pr.createdAt;
    if (raw === undefined) return undefined;
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? undefined : parsed;
  };
  return [...jobs].sort((a, b) => {
    const ta = createdMs(a);
    const tb = createdMs(b);
    if (ta !== undefined && tb !== undefined && ta !== tb) return ta - tb;
    return a.pr.prNumber - b.pr.prNumber;
  });
}

function effectiveReviewWidth(
  deps: SweepDeps,
  policy: SweepPolicy,
  queueDepth: number,
  nowMs: number,
  ledgerLines: ReadonlyArray<Record<string, unknown>>,
): number {
  const min = Math.max(1, Math.trunc(policy.reviewLaneMin));
  const max = Math.max(min, Math.trunc(policy.reviewLaneMax));
  const base = Math.min(max, Math.max(min, Math.trunc(policy.reviewLanes)));
  if (!deps.selectAdaptiveReviewWidth) return base;
  try {
    const selected = deps.selectAdaptiveReviewWidth({ queueDepth, nowMs, ledgerLines });
    if (!Number.isFinite(selected)) throw new Error(`non-finite width ${JSON.stringify(selected)}`);
    return Math.min(max, Math.max(min, Math.trunc(selected)));
  } catch (error) {
    (deps.log ?? (() => {}))("review.capacity.selector_failed", {
      queue_depth: queueDepth,
      base_width: base,
      error: String((error as Error)?.message ?? error),
    });
    return base;
  }
}

export async function runSweep(
  openPrs: OpenPrView[],
  deps: SweepDeps,
  policy: SweepPolicy = DEFAULT_SWEEP_POLICY,
): Promise<SweepSummary> {
  // Alias-bound call site (W1-T2393): the bare `readLedgerLines` regex can't match this because
  // it's bound to a name and invoked below, so this is documentary only — see that task's own
  // rationale for why the enforced corpus and the regex are both left alone here.
  // ledger-read-intent: live — this fold reads the live file only, never rotations.
  const readLedger = deps.readLedger ?? readLedgerLines;
  const appendLine = deps.appendLine ?? appendLedger;
  const now = deps.now ? deps.now() : Date.now();
  const log = deps.log ?? (() => {});

  // Dedup is keyed on the ledger, which persists across sweeps even when the input is
  // byte-identical — the level-triggered idempotence mechanism. The SAME read feeds
  // {@link decideSweepArm}'s head-bound recovery, so arming parity costs no extra read.
  const ledgerLines = readLedger(deps.ledgerPath);
  const prior = priorActionsFromLedger(ledgerLines);
  // W1-T1223 (design ii) — read fresh every pass, off the SAME ledger read above; never held in
  // memory across passes. See `requeuedCheckKeysFromLedger`'s own doc.
  const requeuedCheckKeys = requeuedCheckKeysFromLedger(ledgerLines);
  // W1-T1275 (design iv) — the SAME fresh-every-pass, ledger-only bound as `requeuedCheckKeys`
  // immediately above. See `reaggregatedCiGateKeysFromLedger`'s own doc.
  const reaggregatedCiGateKeys = reaggregatedCiGateKeysFromLedger(ledgerLines);
  // W1-T2345 — the SAME fresh-every-pass, ledger-only fold as `requeuedCheckKeys`/
  // `reaggregatedCiGateKeys` above. See `repeatDispositionStreaksFromLedger`'s own doc.
  const priorRepeatRuns = repeatDispositionStreaksFromLedger(ledgerLines);
  // W1-T2620 — ONE read per pass, never per PR; this module still never calls gh or git directly.
  // Omitted, the base-caused branch below is BYTE-IDENTICAL to before this task existed.
  const mainTipSha = deps.readMainTip ? await deps.readMainTip() : undefined;
  // W1-T2620 — AT MOST ONE base-caused PR selected for release THIS pass, oldest activity first,
  // computed ONCE before the walk — the same single-winner shape `selectUpdateBranchTarget` uses.
  const baseCausedReleaseTarget =
    mainTipSha === undefined
      ? undefined
      : selectBaseCausedRelease(openPrs, mainTipSha, lastBaseCausedTipFromLedger(ledgerLines), now);
  // W1-T2789 — unlike W1-T2620's cohort-wide release above, this is exact-path evidence for the
  // exhausted red population the disposition table would otherwise escalate before runFixRung
  // can reach its W1-T2671 pre-strike check. One oldest eligible target is selected up front;
  // the write still rechecks live state/head at action time below.
  const staleBaseReleaseTarget = await selectStaleBaseRelease(
    openPrs,
    policy,
    now,
    mainTipSha,
    staleBaseReleaseKeysFromLedger(ledgerLines),
    deps.updateBranch && deps.readLiveState && (deps.actionable?.("blocked-ambiguous") ?? true)
      ? deps.readRedBaseRefreshFacts
      : undefined,
    (pr, error) => log("sweep.red_base_refresh.read_error", {
      pr_number: pr.prNumber,
      head_sha: pr.headSha,
      error: String((error as Error)?.message ?? error),
    }),
  );
  // `prIndex` -> this PASS's own streak (+ whether the one-time repeat escalation fires this
  // pass), populated in the per-PR walk below and read back by `finalizeDisposition` — a Map
  // keyed by index rather than two new positional parameters threaded through every one of that
  // function's four call sites (three of them reached only from the deferred post-review batch,
  // well after the walk that computes this).
  const repeatMeta = new Map<number, { streak: number; escalated: boolean }>();

  // ── W1-T931 COST-ANOMALY SENTINEL ───────────────────────────────────────────────────────────
  // Hung off THIS pass rather than a new call site: `runSweep` already read the whole ledger and
  // already runs on the daemon's cadence — the cost-governance path the ceiling already lives on.
  // Independent of `openPrs` (a zero-PR pass still checks for a class median outlier), guarded by
  // `!deps.dryRun` like every other write here, and wrapped in the SAME throw containment: a
  // detector failure must never fail the reconciliation pass it shares a ledger read with.
  // `recordCostAnomalies` is idempotent per run id and performs no effect beyond one append.
  if (!deps.dryRun) {
    try {
      recordCostAnomalies(ledgerLines, deps.costAnomalyPolicy ?? loadDefaultCostAnomalyPolicy(), {
        ledgerPath: deps.ledgerPath,
        writeLedger: appendLine,
      });
    } catch (e) {
      log("sweep.cost_anomaly.error", { error: String((e as Error)?.message ?? e) });
    }
  }

  const byDisposition = ZERO_COUNTS();
  // Filled by INDEX, never pushed — post-review actions are finalized out of pass order, so
  // `actions[i]` is the only way to keep the "in input order" invariant {@link SweepSummary.actions}
  // promises while still letting reviews run concurrently with each other.
  const actions: SweepAction[] = new Array(openPrs.length);
  // W1-T905: this pass's OWN newly-appended rows, mirrored as they are written and never re-read
  // from disk, so the repair-filing fold can see a recurrence that crossed threshold WITHIN this
  // pass — `ledgerLines` was read before these writes and is never refreshed.
  const passDisposedRows: Array<Record<string, unknown>> = [];
  let actionsTaken = 0;
  // W1-T99: counted distinctly from actionsTaken/noneCount so a caller can tell
  // "nothing to do" from "something threw" at a glance — see renderSweepSummary.
  let actionsFailed = 0;
  let noneCount = 0;
  // W1-T2789: once this lane has attempted an update, the older armed/stale-gate update lane at
  // the end of the pass must not issue a second request against the same stale snapshot.
  let staleBaseAttemptedPrNumber: number | undefined;

  // ── W1-T473/W1-T513 — REVIEW CONCURRENCY BUDGET STATE ──────────────────────
  // `claimedReviewKeys` is the REAL mutual exclusion concurrency needs. A worker consults and
  // updates it synchronously immediately before its `postReview` attempt, so two workers sharing
  // a key can never run that effect concurrently. Discovery alone does not claim: the pass-level
  // snapshot may be stale by worker start, so `claimReview` re-reads the durable outcomes under
  // the claim. W1-T513 made it the module-level set, closing the gap a fresh per-call Set left
  // between two genuinely concurrent `runSweep` calls, with no change to the exclusion boundary.
  const claimedReviewKeys = inFlightReviewKeys;

  /**
   * W1-T2771 — CLAIM AT ACTION TIME, THEN RE-READ THE OUTCOME UNDER THE CLAIM. The old placement
   * claimed during the sequential walk, so a later fix action could hold a review candidate's key
   * for minutes with no review in flight while that candidate monopolised a scarce admission. The
   * fresh read is the other half: reading synchronously after `add` makes the mutex and the durable
   * outcome one atomic decision boundary.
   */
  function claimReview(
    reviewKey: string,
  ): { ok: true; release: () => void } | { ok: false; deduped: boolean; reason: string } {
    if (claimedReviewKeys.has(reviewKey)) {
      return {
        ok: false,
        deduped: true,
        reason: `duplicate review key (${reviewKey}) already claimed this pass — see PriorActions.reviewDelivered/reviewRefused's docs`,
      };
    }
    claimedReviewKeys.add(reviewKey);
    try {
      const fresh = priorActionsFromLedger(readLedger(deps.ledgerPath));
      const delivered = fresh.reviewDelivered.has(reviewKey);
      const durableRefusal = fresh.reviewRefused.has(reviewKey);
      const retryBackoff = retryableReviewThrowBackoffReason(fresh.reviewRetryableThrows, reviewKey, policy, now);
      if (delivered || durableRefusal || retryBackoff !== undefined) {
        claimedReviewKeys.delete(reviewKey);
        return {
          ok: false,
          deduped: true,
          reason: delivered
            ? `a verdict was already DELIVERED for ${reviewKey} — the action-time re-read deduped the re-post`
            : durableRefusal
              ? `a review post was already REFUSED for ${reviewKey} — the action-time re-read deduped the re-post`
              : retryBackoff!,
        };
      }
    } catch (e) {
      claimedReviewKeys.delete(reviewKey);
      return {
        ok: false,
        deduped: false,
        reason: `review action-time outcome read failed closed (${String((e as Error)?.message ?? e)}) — re-derived next pass`,
      };
    }
    return { ok: true, release: () => claimedReviewKeys.delete(reviewKey) };
  }

  /**
   * W1-T2520 — CLAIM THIS PR'S FIX-DISPATCH KEY, or refuse: the fix-rung twin of the review claim
   * above, for the OTHER lane that spends a worker. Refuses in exactly two shapes, both
   * SYNCHRONOUS — no `await` ever separates the check from the claim: a genuinely concurrent
   * second claim, or a strike count RE-READ off the ledger the instant the claim is taken (never
   * trusted off this pass's snapshot) that has already reached {@link fixCeilingInForce}.
   * Only a successful claim releases, in a `finally`, once the guarded call SETTLES either way.
   */
  function claimFixDispatch(
    pr: OpenPrView,
  ): { ok: true; run: <T>(fn: () => T | Promise<T>) => Promise<T> } | { ok: false; reason: string } {
    const fixKey = `${pr.taskId ?? ""}@${pr.headSha}`;
    if (inFlightFixKeys.has(fixKey)) {
      return {
        ok: false,
        reason: `duplicate fix-dispatch key (${fixKey}) already claimed this pass — a concurrent sweep is already dispatching this PR's fix rung`,
      };
    }
    inFlightFixKeys.add(fixKey);
    // READ UNDER THE CLAIM: taken only now the claim is held, so a `fix.dispatch` row a concurrent
    // caller wrote before this instant is counted here even though this pass's own `ledgerLines`,
    // read before any claim existed, predates it.
    const freshLines = readLedger(deps.ledgerPath);
    const ceiling = fixCeilingInForce(pr, policy.strikeCap, policy.clarify);
    const freshStrikes = freshFixDispatchCount(freshLines, pr.taskId, pr.headSha);
    if (freshStrikes >= ceiling) {
      inFlightFixKeys.delete(fixKey);
      return {
        ok: false,
        reason: `fix strikes exhausted under the claim (${freshStrikes}/${ceiling}) — refused before dispatch, never spending a strike a concurrent sweep already spent`,
      };
    }
    return {
      ok: true,
      run: async (fn) => {
        try {
          return await fn();
        } finally {
          inFlightFixKeys.delete(fixKey);
        }
      },
    };
  }

  // Reviews eligible this pass, deferred out of the main walk so they can run
  // CONCURRENTLY with each other (bounded below), rather than one at a time
  // inside it — see `reviewLanes` after the loop.
  const pendingReviews: Array<{
    index: number;
    pr: OpenPrView;
    reason: string;
    question: ClarificationQuestion | undefined;
    // W1-T513: carried alongside the job so both release sites release the SAME key they claimed.
    // Recomputing it from `pr` would work too, but carrying it removes any chance of the two
    // computations drifting apart.
    reviewKey: string;
  }> = [];

  /**
   * The tail every disposition shares once `acted`, `actionError` and `standDownReason` are known
   * — factored out so the synchronous walk and the concurrent review batch ledger and log
   * IDENTICALLY. Unconditional counting matches the original inline placement exactly: a deduped
   * PR reaches here with `acted:false` and no error, so neither counter moves.
   *
   * W1-T1061: `armOutcome` rides alongside `standDownReason` rather than only inside it, so a
   * caller counting outcomes need not split that sentence on a colon.
   */
  function finalizeDisposition(
    index: number,
    pr: OpenPrView,
    disposition: Disposition,
    reason: string,
    question: ClarificationQuestion | undefined,
    acted: boolean,
    deduped: boolean,
    actionError: string | undefined,
    standDownReason: string | undefined,
    depReviewOutcome: string | undefined,
    armOutcome: ArmOutcomeName | undefined,
    // W1-T2231: {@link SweepAction.spent}'s own doc — `undefined` for every call site except the
    // main per-PR walk's "blocked-fixable"/"conflicted" arms below.
    spent: boolean | undefined,
    // W1-T2620: the release marker riding the EXISTING `sweep.disposed` step. `undefined` for
    // every call site except the walk's "blocked-fixable" arm, and even there only when this pass
    // classified the PR base-caused AND a main tip was actually read.
    baseCausedMainTipSha: string | undefined = undefined,
  ): void {
    if (standDownReason) {
      // The site the TASK names ("a sweep disposition"), naming the state —
      // never silent: a caller diffing the ledger sees exactly why a
      // blocked-fixable disposition spent nothing this pass.
      log("sweep.dispose.not_open", { pr_number: pr.prNumber, reason: standDownReason });
    }

    actions[index] = {
      prNumber: pr.prNumber,
      prUrl: pr.prUrl,
      taskId: pr.taskId,
      disposition,
      reason,
      acted,
      question,
      ...(actionError ? { actionError } : {}),
      ...(spent !== undefined ? { spent } : {}),
    };

    log("sweep.dispose", {
      pr_number: pr.prNumber,
      disposition,
      acted,
      reason,
      deduped,
      ...(actionError ? { action_error: actionError } : {}),
      // W1-T254: THIS line fires unconditionally through the injected `log`, which the real wiring
      // persists to the SAME ledger regardless of `--dry-run`. Tagged so a preview pass is never
      // mistaken for a daemon action — the exact ambiguity that misread one during the #707
      // diagnosis.
      ...(deps.dryRun ? { dry_run: true } : {}),
    });

    // One ledger line per disposition (the INVARIANT). Skipped under --dry-run, because a preview
    // must leave no trace so a real run afterwards still acts. The rendered question rides along
    // whenever one exists: an UNANSWERED question stays ledgered on every subsequent sweep, even
    // once `acted` goes false.
    if (!deps.dryRun) {
      // W1-T2345 — this PASS's own repeat-streak figures, computed once per PR earlier in the walk
      // and read back by `index`, so all four `finalizeDisposition` call sites carry it with no
      // change to their own signatures.
      const repeat = repeatMeta.get(index);
      const disposedLine = {
        run_id: deps.runId,
        task_id: pr.taskId ?? "SWEEP",
        step: "sweep.disposed",
        pr_number: pr.prNumber,
        pr_url: pr.prUrl,
        disposition,
        acted,
        reason,
        head_sha: pr.headSha,
        ...(depReviewOutcome ? { dep_review_outcome: depReviewOutcome } : {}),
        ...(actionError ? { action_error: actionError } : {}),
        ...(standDownReason ? { stand_down_reason: standDownReason } : {}),
        // W1-T2345: `repeat_streak` rides every row — always in hand by this point — so the next
        // pass's fold never has to guess it back out of row order. `repeat_escalated` is present
        // ONLY on the pass that actually fired the one-time escalation, which is the field the
        // "stays quiet until the head moves" guarantee is built on.
        ...(repeat !== undefined ? { repeat_streak: repeat.streak } : {}),
        ...(repeat?.escalated ? { repeat_escalated: true } : {}),
        // W1-T1061: the FIELD sibling to `stand_down_reason`'s prose — present whenever `deps.arm`
        // returned a concrete outcome this pass, armed or not, and absent when no arm was
        // attempted. Same value the sentence names, so the two cannot drift: one write, read twice.
        ...(armOutcome ? { arm_outcome: armOutcome } : {}),
        // W1-T2231: present ONLY when the dispatch arms captured a concrete verdict for THIS call.
        // `dueRepairFilings` reads this field, never `acted`, to decide whether a dispatch-based
        // repair surface's row is an actual repair.
        ...(spent !== undefined ? { spent } : {}),
        ...(question ? { question: question.question } : {}),
        // W1-T2620 — rides this EXISTING step rather than minting a fourth ledger signal. Present
        // ONLY when this pass classified the PR base-caused AND a main tip was read; see
        // {@link lastBaseCausedTipFromLedger} for the fold that reads it back next pass.
        ...(baseCausedMainTipSha !== undefined ? { main_tip_sha: baseCausedMainTipSha } : {}),
      };
      appendLine(deps.ledgerPath, disposedLine);
      // W1-T905: mirrored in-memory with THIS PASS'S OWN `ts`, never re-read off disk. The real
      // append stamps its own write-time `ts`, which this never touches; the copy exists solely so
      // `dueRepairFilings` can see a same-pass recurrence without a second ledger read.
      passDisposedRows.push({ ...disposedLine, ts: new Date(now).toISOString() });
    }

    if (acted) actionsTaken++;
    else if (actionError) actionsFailed++;
  }

  // ── PER-PASS HEARTBEAT, WRITTEN BEFORE THE LOOP ────────────────────────────────────────────
  // A BLIND SWEEP AND A QUIET FLEET ARE INDISTINGUISHABLE without this. `sweep.disposed` writes a
  // decision per PR per tick, so its ABSENCE is the only other signal — and absence is exactly
  // what a healthy quiet period looks like, which is why no threshold over that step can work.
  //
  // `sweep.summary` is not already this: it sits AFTER the loop, so a pass that dies mid-way
  // writes nothing at all. POSITION IS THE WHOLE POINT — written here, a pass that throws mid-loop
  // still leaves this row, so "started but never summarised" becomes a legible state.
  //
  // `enumerated` is deliberately the ONLY count: how many were dispositioned cannot be known
  // before the loop runs. The pair — this row present, a summary absent — is the mid-pass-death
  // signal `judgeSweepLiveness` reads. Registered RENDER_RELEVANT, not DECISION_RELEVANT, so it
  // rotates on the recency window rather than being kept forever (W1-T1237).

  log("sweep.pass", { enumerated: openPrs.length, dry_run: deps.dryRun === true });

  for (let prIndex = 0; prIndex < openPrs.length; prIndex++) {
    const pr = openPrs[prIndex];
    const { disposition, reason } = deriveDisposition(pr, policy, now);
    byDisposition[disposition]++;

    // W1-T2345 — computed for EVERY disposition, never only blocked-ambiguous, and BEFORE the
    // per-disposition dedup below: this bounds the DERIVATION itself, orthogonal to whatever
    // per-head dedup a specific disposition's own gated action already has.
    const priorRepeatRun = priorRepeatRuns.get(pr.prNumber);
    const repeatRunContinues =
      priorRepeatRun !== undefined && priorRepeatRun.headSha === pr.headSha && priorRepeatRun.disposition === disposition;
    const repeatStreak = repeatRunContinues && priorRepeatRun ? priorRepeatRun.streak + 1 : 1;
    const repeatAlreadyEscalated = repeatRunContinues && priorRepeatRun ? priorRepeatRun.escalated : false;
    const repeatBoundTripped = repeatStreak >= policy.repeatDispositionBound;
    let repeatEscalatedNow = false;
    // Skipped entirely under --dry-run — a preview must leave no trace — and whenever a prior pass
    // already fired this run's escalation, which is the "stays quiet until the head moves" half of
    // the acceptance criteria.
    if (repeatBoundTripped && !repeatAlreadyEscalated && !deps.dryRun) {
      try {
        // W1-T2381: THE LEDGER ROW IS THE WHOLE OUTPUT — no `deps.escalate()` call. W1-T2345's own
        // rationale refused the issue surface in terms ("the escalation surface is THE DIGEST")
        // and its build routed the trip there anyway; the dedup key is task+head+cause and never
        // the repeat condition, so the comments landed on issues titled for a different cause.
        // THE SURFACE IS `digest.ts`, which reads this row directly and consumes exactly the three
        // fields written below. // Why: measured over eight trips — docs/forensics/sweep.md.
        log("sweep.repeat_escalated", { pr_number: pr.prNumber, disposition, streak: repeatStreak, head_sha: pr.headSha });
        repeatEscalatedNow = true;
      } catch (e) {
        // W1-T254 per-PR throw containment, KEPT after the escalate call was removed: the
        // remaining `log` is a real ledger append and can still throw on I/O, and one PR's failed
        // write must never take the whole pass. `repeatEscalatedNow` stays false, so the next pass
        // tries again rather than silently forgetting the notification forever.
        log("sweep.repeat_escalate_failed", { pr_number: pr.prNumber, error: String((e as Error)?.message ?? e) });
      }
    }
    repeatMeta.set(prIndex, { streak: repeatStreak, escalated: repeatEscalatedNow });

    // W1-T196: a blocked-ambiguous PR with no task id is a KNOWN, non-emergency state ONLY when it
    // is POSITIVELY a plan-filing PR — one carries no trailer BY DESIGN, so there is no task to ask
    // about and no operator-decidable question. An unattributed PR NOT flagged plan-filing still
    // escalates, unchanged: that is a genuine attribution defect, not a designed gap.
    const unattributableFiling = disposition === "blocked-ambiguous" && !pr.taskId && pr.isPlanFiling === true;

    // W1-T78: render the question up front for blocked-ambiguous PRs — it is ledgered EVERY sweep
    // so an unanswered question stays visible, even on a deduped pass where `escalate` never
    // fires. Skipped for an unattributable filing PR: there is only a stand-down to record.
    const question =
      disposition === "blocked-ambiguous" && !unattributableFiling
        ? renderClarificationQuestion(pr, reason, pr.strikeHistory ?? [])
        : undefined;

    // Is this action already true (deduped)? Keyed per disposition.
    let alreadyDone: boolean;
    // W1-T1000002: set ONLY when an operator hold stands over a PR GitHub ALREADY reports armed.
    // The withdrawal fires unconditionally, never gated on `acted` (which a held PR always has
    // false), so a standing arm this lane did not place is withdrawn on the pass that observes it.
    let holdToWithdraw: AutomergeHold | undefined;
    // W1-T1110: set ONLY when a PRIOR dispatch against this exact head is still deduping and its
    // rung has not stalled out. Named here rather than silently stood down: the light-pass arm one
    // branch below already set a reason and this arm did not, which is the defect two readers
    // independently misread as an unwired action path.
    let dedupStandDownReason: string | undefined;
    switch (disposition) {
      case "mergeable": {
        // PREFER OBSERVED STATE: GitHub's own `autoMergeArmed` is the authority for "already
        // armed"; the sweep's memory is a fallback, now sha-keyed so a new head re-earns the
        // attempt rather than being deduped on a stale success.
        //
        // W1-T970: a head the risk judge escalated is refused HERE, in `alreadyDone`, never in the
        // rule's `when` and never in the merge path. That gives it the SAME non-action shape every
        // other dedup has: no escalation, no strike, re-derived whole next pass. It clears on a NEW
        // head sha or an explicit operator override, reusing the existing verb — not a second
        // override vocabulary.
        const riskRefusedKey = `${pr.prNumber}@${pr.headSha}`;
        const refused =
          prior.riskRefused.has(riskRefusedKey) &&
          !(pr.taskId !== undefined && cappedOverrideFromLedger(ledgerLines, pr.taskId, pr.headSha) !== undefined);
        // W1-T1000002: A HOLD IS A LEDGERED REFUSAL, NOT A BARE DISARM. Deliberately NEVER
        // sha-keyed, unlike `refused` above: a hold binds the PR, not any one head, so a push
        // while held changes nothing. No dedup key is seeded, so the pass re-derives whole the
        // moment an operator releases it — no separate resume path.
        const hold = automergeHoldFromLedger(ledgerLines, pr.prNumber);
        if (hold && pr.autoMergeArmed === true) holdToWithdraw = hold;
        const armedByGitHub = pr.autoMergeArmed === true;
        const armedByPriorPass = !armedByGitHub && prior.armed.has(`${pr.prNumber}@${pr.headSha}`);
        alreadyDone = armedByGitHub || armedByPriorPass || refused || hold !== undefined;
        // W1-T1116: NAME WHICH DISJUNCT FIRED. This switch left all of them silent, the same gap
        // the fix arm above already closed for its own dedup, and the only reason two readers
        // misdiagnosed a correctly-held #2432 as a never-clearing dedup in one night. Order matches
        // the `||` above, so a reader learns the FIRST true disjunct — the one that actually
        // short-circuited `alreadyDone`.
        if (armedByGitHub) {
          dedupStandDownReason = "auto-merge already armed (observed on GitHub) — nothing to re-arm";
        } else if (armedByPriorPass) {
          dedupStandDownReason = `auto-merge already armed by a prior sweep pass at this head (${pr.headSha.slice(0, 7)})`;
        } else if (refused) {
          // Carry the SAME `issue_url` the sibling `risk_judge.escalated` row already holds: the
          // pointer exists one row away, and this only moves it to the row a reader reaches first.
          // Never widens the override — naming the escape is not taking it.
          const issueUrl = prior.riskRefused.get(riskRefusedKey);
          dedupStandDownReason = issueUrl
            ? `risk judge escalated this head, no operator override recorded — see ${issueUrl}`
            : "risk judge escalated this head, no operator override recorded";
        } else if (hold !== undefined) {
          dedupStandDownReason = "an operator merge hold stands over this PR — refusing to arm until it is released";
        }
        break;
      }
      case "blocked-fixable":
      case "conflicted": {
        // W1-T106: same dedup set as blocked-fixable — see priorActionsFromLedger.
        const dispatchedThisHead = prior.fixed.has(`${pr.prNumber}@${pr.headSha}`);
        // W1-T1110 — RE-ARM A STALLED DISPATCH: `dispatchedThisHead` records only that a fix was
        // DISPATCHED, never that it succeeded. If the ledger shows that rung already ENDED without
        // landing a new head, treating it as "already done" would dedup this PR against a head
        // nothing will ever move again — so it does NOT suppress this pass, and the strike cap
        // still bounds whatever follows. A dispatch that RESOLVED is never read as stalled, so it
        // keeps suppressing a second attempt on this same, now-stale head.
        alreadyDone = dispatchedThisHead && !fixRungStalledWithoutNewHead(ledgerLines, pr.taskId);
        if (alreadyDone) {
          dedupStandDownReason =
            `fix already dispatched for this head (${pr.headSha.slice(0, 7)}) — awaiting its outcome ` +
            `before spending another strike`;
        }
        break;
      }
      case "stale":
        alreadyDone = prior.closed.has(pr.prNumber);
        // W1-T2427: NAME THE DEDUP, the same shape the sibling arms use. The fact is already in
        // hand from this very membership test, so the sentence costs no read and no ledger line.
        // This arm has been QUIET since 2026-08-17, which is not the same as fixed: the code was
        // unchanged, so it went silent again the next time a closed PR was deduped.
        if (alreadyDone) {
          dedupStandDownReason =
            `this PR is already recorded CLOSED by a prior sweep pass (pr #${pr.prNumber} is in the ` +
            `closed set) — the close is deduped, not skipped, and no second close was attempted`;
        }
        break;
      case "blocked-ambiguous":
        // W1-T514: sha-keyed, exactly like every sibling arm above — a new
        // head re-earns its own escalation rather than being deduped by a
        // stale head's `acted:true` line forever.
        alreadyDone = prior.escalated.has(`${pr.prNumber}@${pr.headSha}`);
        // W1-T2427: the LARGEST silent population (7,888 rows). Without this sentence the row is
        // indistinguishable from `deps.escalate` being unwired or throwing.
        if (alreadyDone) {
          dedupStandDownReason =
            `an escalation was already filed for this head (${pr.headSha.slice(0, 7)}) — the ` +
            `escalation is deduped, not skipped, and a new head re-earns its own`;
        }
        break;
      case "dep-review":
        alreadyDone = prior.depReviewed.has(`${pr.prNumber}@${pr.headSha}`);
        // W1-T2427: names the TERMINAL-outcome dedup specifically, because a `hold` deliberately
        // does NOT dedup (see `priorActionsFromLedger`'s own dep-review arm) — so "deduped" here
        // is a positive statement about the prior outcome, never a silent skip.
        if (alreadyDone) {
          dedupStandDownReason =
            `dependency review already reached a TERMINAL outcome at this head ` +
            `(${pr.headSha.slice(0, 7)}) — a hold would have re-run instead of deduping`;
        }
        break;
      case "post-review": {
        // W1-T254: OUTCOME-keyed, by taskId rather than prNumber — the review rows carry no PR
        // number, only the taskId the lane resolved.
        //
        // W1-T1213: a DELIVERED verdict suppresses this head forever, as before. A REFUSED attempt
        // also suppresses UNLESS it was the stale "PR is already closed" refusal, in which case
        // reaching this check already proves the PR is open again. That clears the dedup; it does
        // not post a verdict or arm anything.
        const reviewKey = reviewOutcomeKeyForPr(pr);
        const reviewDelivered = prior.reviewDelivered.has(reviewKey);
        const reviewDurablyRefused = prior.reviewRefused.has(reviewKey);
        const retryBackoff = retryableReviewThrowBackoffReason(prior.reviewRetryableThrows, reviewKey, policy, now);
        alreadyDone = reviewDelivered || reviewDurablyRefused || retryBackoff !== undefined;
        // W1-T2427 — THE SENTENCE MUST SEPARATE FOUR STATES THAT OTHERWISE LOOK IDENTICAL: this
        // dedup firing, `deps.postReview` never being wired, the light-pass admission being lost
        // to another PR, or a dry run. Only the first is this arm, and only this arm can say so;
        // the other three name themselves elsewhere. Naming the KEY and WHICH set matched is what
        // was missing when an earlier task could confirm the mechanism but not the instance.
        if (alreadyDone) {
          dedupStandDownReason = reviewDelivered
            ? `a verdict was already DELIVERED for ${reviewKey} — the re-post is deduped by this ` +
              `arm, not lost to an admission and not unwired`
            : reviewDurablyRefused
              ? `a review post was already REFUSED for ${reviewKey} — the re-post is deduped by this ` +
                `arm, not lost to an admission and not unwired`
              : retryBackoff;
        }
        break;
      }
      case "wait":
        // W1-T114: WAIT never gates an effect — there is nothing to dispatch, only time to let
        // pass. Forcing `alreadyDone` true, rather than adding a no-op case to the action switch,
        // keeps `acted` false unconditionally, so a wait is re-derived and re-ledgered every pass
        // and never counted as an action taken.
        alreadyDone = true;
        // W1-T1116 — the fourth silent guard. Forcing `alreadyDone` true is BY DESIGN here, since
        // unlike the other disjuncts there is no refusal to distinguish, but the row still read
        // `acted:false` with nothing saying why. `reason` already narrates what is being waited
        // on, reused verbatim rather than inventing a second sentence that could drift from it.
        dedupStandDownReason = reason;
        break;
      default:
        alreadyDone = false;
    }

    // W1-T2789: a prior blocked-ambiguous escalation is not a successful base refresh. The
    // exact-path release has its own success key, so it must remain retryable after a read or write
    // failure even when the ordinary escalation was already recorded for this head.
    if (staleBaseReleaseTarget?.pr.prNumber === pr.prNumber) {
      alreadyDone = false;
      dedupStandDownReason = undefined;
    }

    let acted = !alreadyDone && !deps.dryRun;
    // The dep-review lane's decision for THIS pass (dep-review disposition only)
    // — ledgered so priorActionsFromLedger can tell terminal from hold.
    let depReviewOutcome: string | undefined;
    // W1-T177: set ONLY when the terminal-state check stood the dispatch down — distinct from
    // `alreadyDone` (dedup) and `deps.dryRun` (preview), so the disposed line can name WHY `acted`
    // is false without conflating the three. W1-T1110 seeds it from `dedupStandDownReason` so a
    // still-deduped fix dispatch NAMES ITSELF on this same field rather than standing down
    // silently — the light-pass arm's exact shape, one branch away.
    let standDownReason: string | undefined = dedupStandDownReason;
    // W1-T1061: the FIELD twin of `standDownReason`'s prose, set ONLY when the mergeable case
    // actually calls `deps.arm` and gets a concrete outcome back. Every other disposition, and a
    // mergeable PR standing down before reaching `deps.arm`, leaves this `undefined` so no
    // `arm_outcome` field is written at all.
    let armOutcome: ArmOutcomeName | undefined;
    // W1-T2231: set ONLY by the dispatch cases when `deps.dispatchFix` returns a concrete verdict.
    // Every other disposition, and a dispatch whose wiring returns nothing, leaves this
    // `undefined` so no `spent` field is written at all.
    let spent: boolean | undefined;
    // W1-T2620: set ONLY by the base-caused branch, when this pass classified the PR base-caused
    // AND a main tip was actually read. Every other disposition leaves this `undefined` so no
    // `main_tip_sha` field is written at all.
    let baseCausedMainTipSha: string | undefined;
    // W1-T254 — PER-PR THROW CONTAINMENT: a thrown action used to propagate straight out of
    // `runSweep` as one unattributed error, aborting the WHOLE pass so every later PR went
    // unreconciled. Named here and ledgered on THIS PR's own line instead, so the loop always
    // reaches the next PR.
    let actionError: string | undefined;
    // W1-T473: set true ONLY when a real `postReview` dep is wired and eligible, deferring this
    // PR's finalize call to the bounded concurrent batch after the loop rather than running inline.
    let deferredReview = false;

    if (acted) {
      // W1-T254 — LIGHT-SWEEP RESTRICTION. `actionable` defaults to everything, so `rmd sweep` and
      // the daemon's full sweep are unchanged. The light ticker passes `d => d === "post-review"`
      // so only that deterministic, sha-pinned re-post runs alongside a task; every other lane
      // stands down here and is re-derived and re-attempted, never dropped, on the next full sweep.
      if (deps.actionable && !deps.actionable(disposition)) {
        acted = false;
        // W1-T2426: the caller may name WHICH mechanism refused; absent, the generic sentence
        // every gated disposition has always recorded, unchanged.
        standDownReason =
          deps.standDownReasonFor?.(disposition) ?? "deferred to full sweep (light pass)";
      } else {
        try {
          switch (disposition) {
            case "mergeable": {
              // ARMING PARITY (see {@link decideSweepArm}): the run flow's capped refusal is
              // worthless while this independent path arms the same verdict seconds later. Stand
              // down instead — `acted:false` keeps this PR out of `prior.armed`, so the next pass
              // re-derives it and arms the moment executed proof or a ledgered override lands. No
              // escalation, no strike, no retry: the refusal is a NON-action, named on the line.
              const armDecision = decideSweepArm(pr, ledgerLines);
              if (!armDecision.arm) {
                acted = false;
                standDownReason = armDecision.reason;
                break;
              }
              // READ THE OUTCOME. `armAutoMerge` does not throw — it RETURNS which of its
              // seven branches it took, and five of them armed nothing. Discarding it is what
              // let `acted:true` be recorded for a PR that was never armed.
              const armResult = await deps.arm(pr);
              // W1-T1117: `deps.arm` may return the bare name it always could, or the richer
              // outcome-plus-failureClass object. Unwrap once, here, so every read below stays on
              // the plain string it already expected.
              const armOutcomeName = typeof armResult === "object" && armResult !== null ? armResult.outcome : armResult;
              // W1-T1061: capture the concrete outcome onto the outer `armOutcome` whenever one
              // came back. A `void` return is the legacy "treat as armed" shape and names no real
              // branch, so no field is written for it either.
              if (armOutcomeName !== undefined) armOutcome = armOutcomeName;
              if (!armOutcomeArmed(armOutcomeName)) {
                acted = false;
                // The refusal used to go only to `say` -> stdout -> daemon.out.log, leaving no
                // trace in the ledger where anyone looks. Name it on the disposed line.
                standDownReason = `arm outcome: ${String(armOutcomeName)}`;
                // W1-T1117: an `arm-error-ignored` outcome classified `"unknown"` is the ONE
                // non-armed outcome that must NOT retry — the classifier could not decode the
                // failure at all, so nothing says the SAME attempt will ever succeed. A
                // `"transient"` or `"retryable"` one stays on the `acted:false` line just set,
                // exactly as every arm-error-ignored outcome already behaved. This reinstates the
                // terminal, dedup-seeding shape intended for a genuinely non-retryable refusal.
                const failureClass = typeof armResult === "object" && armResult !== null ? armResult.failureClass : undefined;
                if (armOutcomeName === "arm-error-ignored" && failureClass === "unknown") {
                  acted = true;
                  standDownReason = undefined;
                }
              }
              break;
            }
            case "blocked-fixable": {
              // W1-T177 — TERMINAL-STATE CHECK AT THE SPENDING SITE: re-read this PR's state
              // FRESH, right before a strike is actually spent, never the snapshot this pass
              // started from. Omitted or indeterminate behaves exactly as before — dispatch
              // proceeds, failing OPEN rather than closed to a stand-down.
              const live = await deps.readLiveState?.(pr);
              let terminal: string | undefined;
              if (live) {
                if (live.ok) {
                  terminal = terminalStateReason(live.state);
                } else {
                  // FAIL OPEN, ledgered: an indeterminate read must never be treated as terminal,
                  // which would silently halt every blocked-fixable dispatch on a gh outage.
                  // Proceed exactly as before this check existed; the failed read stays legible
                  // on the ledger.
                  log("sweep.dispose.indeterminate", { pr_number: pr.prNumber });
                }
              }
              if (terminal) {
                acted = false;
                standDownReason = terminal;
                break;
              }
              // W1-T527 — CLASSIFY BEFORE SELECTING, because the strike is spent at dispatch and
              // cannot be refunded. `classifyRedCause` is a pure fold over evidence already in
              // hand, so it costs no GitHub call. Only base-caused and environment stand down;
              // `in-diff` and `gate-conflict` fall through exactly as before.
              const redCause = classifyRedCause(pr, openPrs);
              if (redCauseStandsDown(redCause)) {
                acted = false;
                standDownReason = describeRedCause(redCause, pr, openPrs);
                // W1-T2620 — THE BASE-CAUSED STAND-DOWN'S EXIT CONDITION. Nothing else about this
                // branch moves: the classifier, its text and the strike accounting are untouched.
                //
                // `main_tip_sha` rides THIS PR's own line whenever this pass classified it
                // base-caused and a tip was read — recorded on the ORDINARY stand-down path too,
                // not only a release, so the next pass's fold has a baseline to compare against.
                if (redCause === "base-caused" && mainTipSha !== undefined) {
                  baseCausedMainTipSha = mainTipSha;
                  // `selectBaseCausedRelease` already picked AT MOST ONE PR for this pass, oldest
                  // activity first (design iii) — this PR releases only if it IS that winner.
                  if (baseCausedReleaseTarget?.prNumber === pr.prNumber && deps.releaseBaseCausedStandDown) {
                    // The "released" sentence is set ONLY once the effect is about to be attempted.
                    // Omitted, this PR falls through to the ordinary stand-down sentence like every
                    // other stood-down PR: never a silent no-op, and never a "released" claim with
                    // no push behind it.
                    try {
                      await deps.releaseBaseCausedStandDown(pr, mainTipSha);
                      standDownReason =
                        `red cause: base-caused — released: main has advanced to ${mainTipSha} since ` +
                        `this head last stood down against an earlier tip; redriving through the ` +
                        `existing post-fix leaf (no strike spent)`;
                    } catch (e) {
                      // FAIL QUIET — NEVER LAUNDER A RED: a failed release leaves this PR standing
                      // down exactly like the ordinary sentence, never a false "released" line.
                      // Retried next pass like any other stood-down PR; no strike was at stake.
                      log("sweep.base_caused_release.error", {
                        pr_number: pr.prNumber,
                        main_tip_sha: mainTipSha,
                        error: String((e as Error)?.message ?? e),
                      });
                    }
                  }
                }
                break;
              }
              // W1-T1275 — CI-GATE'S OWN CONCLUDED VERDICT CAN GO STALE: a required sibling's
              // success can land AFTER the gate's run has concluded and posted a terminal FAILURE.
              // Fires BEFORE `dispatchFix` so a stale verdict never spends a strike on a diff that
              // carries no defect — gate reconciliation is the sweep's own lane, never the fix
              // rung's. Bounded to AT MOST ONCE per (head, sibling-transition) via the ledger.
              // This pass never marks the gate green itself; it only asks GitHub to re-evaluate.
              // The rollup is a FRESH read, never a field cached on `pr` — comparing against a
              // captured frame is exactly what this cannot do.
              const ciGateRollup =
                isBlockedCi(pr) && deps.readCiGateRollup ? await deps.readCiGateRollup(pr) : undefined;
              const staleTransition = staleCiGateTransition(ciGateRollup);
              if (staleTransition) {
                const key = ciGateReaggregateKey(pr.headSha, staleTransition);
                const decision = ciGateReaggregateDecision(reaggregatedCiGateKeys.has(key));
                if (decision.reaggregate) {
                  // LEDGERED BEFORE THE CALL, the same ordering the re-queue uses below for the
                  // identical reason: a crash between this write and the real GitHub call still
                  // bounds the NEXT pass toward standing down rather than re-driving twice.
                  appendLine(deps.ledgerPath, {
                    run_id: deps.runId,
                    task_id: pr.taskId ?? "SWEEP",
                    step: CI_GATE_REAGGREGATE_STEP,
                    pr_number: pr.prNumber,
                    pr_url: pr.prUrl,
                    head_sha: pr.headSha,
                    sibling_name: staleTransition.siblingName,
                    sibling_started_at: staleTransition.siblingStartedAt,
                  });
                  reaggregatedCiGateKeys.add(key);
                  if (deps.reaggregateCiGate) await deps.reaggregateCiGate(pr, staleTransition);
                }
                acted = false;
                standDownReason = decision.reaggregate
                  ? `stale ci-gate verdict — re-driving its job (required sibling "${staleTransition.siblingName}" ` +
                    `reached success at ${staleTransition.siblingStartedAt}, after the gate concluded)`
                  : `stale ci-gate verdict already re-driven for this transition — awaiting the fresh result`;
                break;
              }
              // W1-T1223 — A CANCELLED REQUIRED CHECK HAS NO DEFECT IN THE DIFF for a fix-rung
              // worker to read. Fires BEFORE `dispatchFix` so a PR whose ENTIRE red verdict is
              // cancellations never spends a strike on nothing. Gate reconciliation, the sweep's
              // own lane — never the fix rung's.
              const cancelledChecks = isBlockedCi(pr) ? pr.cancelledRequiredChecks ?? [] : [];
              if (cancelledChecks.length > 0) {
                let requeuedAny = false;
                const outcomes: string[] = [];
                for (const check of cancelledChecks) {
                  const key = `${pr.headSha}@${check.name}`;
                  // W1-T2431: OR the ledger-derived reading with the surface-derived one — a
                  // re-run this fleet ledgered, OR one GitHub's `run_attempt` shows already
                  // happened (an operator's own re-run, invisible to the ledger), both read
                  // "already requeued". This only widens the true case.
                  const decision = cancelledCheckRequeueDecision(
                    requeuedCheckKeys.has(key) || cancelledCheckAlreadyRequeuedFromSurface(check.runAttempt),
                  );
                  if (decision.requeue) {
                    // LEDGERED BEFORE THE CALL — the attempt is recorded before it can be
                    // repeated, so a crash between this write and the real GitHub call still
                    // bounds the NEXT pass toward escalating. Not dry-run-guarded: reaching this
                    // line already proves `acted` was true, which `deps.dryRun` forces false.
                    appendLine(deps.ledgerPath, {
                      run_id: deps.runId,
                      task_id: pr.taskId ?? "SWEEP",
                      step: CHECK_REQUEUE_STEP,
                      pr_number: pr.prNumber,
                      pr_url: pr.prUrl,
                      head_sha: pr.headSha,
                      check_name: check.name,
                    });
                    requeuedCheckKeys.add(key);
                    if (deps.requeueCheck) {
                      await deps.requeueCheck(pr, check);
                      requeuedAny = true;
                    }
                    outcomes.push(`re-queued "${check.name}"`);
                  } else {
                    if (deps.escalateCancelledCheck) await deps.escalateCancelledCheck(pr, check, decision.reason);
                    outcomes.push(`escalated "${check.name}" (${decision.reason})`);
                  }
                }
                // A cancelled check carries no diff defect — when EVERY red required check named
                // this pass is a cancellation, stand down here rather than falling through to
                // `dispatchFix` and burning a strike on nothing. `acted` stays FALSE regardless:
                // claiming true would seed `prior.fixed` for this head, dedupe the whole
                // blocked-fixable disposition away next pass, and stop this logic ever running
                // again to observe the second cancellation that must escalate.
                const genuineFailures = (pr.ciFailures ?? []).filter((f) => !cancelledChecks.some((c) => c.name === f.name));
                if (genuineFailures.length === 0) {
                  acted = false;
                  standDownReason = `cancelled required check(s): ${outcomes.join("; ")}`;
                  break;
                }
              }
              // W1-T100: the evidence shape follows the SAME `isBlockedCi` predicate the table
              // routed on, never a second hardcoded check — a failing review carries the unmet set,
              // a blocked_ci PR carries ci-log evidence, never a mix. W1-T2236: the review branch
              // also carries `actionableGateFailures`, the same structured remedy this row already
              // required to route the PR here at all, so the fix rung can select on it rather than
              // discarding it at this boundary.
              //
              // W1-T2231: capture whatever verdict `dispatchFix` returns. `acted` is untouched —
              // the dedup gate reads `acted`, never `spent`. A `void` return writes no `spent`
              // field at all, so no existing ledger row's shape changes.
              const fixEvidence = isBlockedCi(pr)
                ? { unmetCriteria: [], ciFailures: pr.ciFailures ?? [] }
                : { unmetCriteria: pr.unmetCriteria, actionableGateFailures: pr.actionableGateFailures };
              // W1-T2520 — THE FIX-DISPATCH CLAIM. See {@link claimFixDispatch} for why a claim
              // alone, without the fresh re-read it also performs, would not have stopped the
              // observed race. A refusal spends nothing and stands down like any declined lane.
              const fixClaim = claimFixDispatch(pr);
              if (!fixClaim.ok) {
                acted = false;
                standDownReason = fixClaim.reason;
                break;
              }
              // W1-T2379: started either way — only the `await` moves. See `SweepDeps.detachFixWait`.
              if (deps.detachFixWait) {
                detachSweepAction(fixClaim.run(() => deps.dispatchFix(pr, fixEvidence)));
                break;
              }
              const dispatchOutcome = await fixClaim.run(() => deps.dispatchFix(pr, fixEvidence));
              if (dispatchOutcome !== undefined) spent = dispatchFixSpent(dispatchOutcome);
              break;
            }
            case "conflicted": {
              // W1-T106: the SAME terminal-state pre-flight (W1-T177) as
              // blocked-fixable — never spend a merge-conflict fix strike on
              // a PR that went terminal since this sweep pass's snapshot.
              const live = await deps.readLiveState?.(pr);
              let terminal: string | undefined;
              if (live) {
                if (live.ok) {
                  terminal = terminalStateReason(live.state);
                } else {
                  log("sweep.dispose.indeterminate", { pr_number: pr.prNumber });
                }
              }
              if (terminal) {
                acted = false;
                standDownReason = terminal;
                break;
              }
              // The "conflicted" row already gated this on the admission predicates, so the
              // dispatch carries merge-conflict evidence and never a mix with the other shapes.
              //
              // W1-T2231: the "conflicted" analogue of the blocked-fixable capture above — both are
              // dispatch-based repair surfaces, so both must feed `spent` the same way.
              const conflictedEvidence = { unmetCriteria: [], mergeConflict: pr.mergeConflict };
              // W1-T2520: the conflicted twin of the blocked-fixable claim above, same reasoning
              // — see `claimFixDispatch`'s own doc.
              const conflictedFixClaim = claimFixDispatch(pr);
              if (!conflictedFixClaim.ok) {
                acted = false;
                standDownReason = conflictedFixClaim.reason;
                break;
              }
              // W1-T2379: the conflicted twin of the blocked-fixable arm above, same reasoning.
              if (deps.detachFixWait) {
                detachSweepAction(conflictedFixClaim.run(() => deps.dispatchFix(pr, conflictedEvidence)));
                break;
              }
              const conflictedDispatchOutcome = await conflictedFixClaim.run(() => deps.dispatchFix(pr, conflictedEvidence));
              if (conflictedDispatchOutcome !== undefined) spent = dispatchFixSpent(conflictedDispatchOutcome);
              break;
            }
            case "stale":
              await deps.close(pr, reason);
              break;
            case "blocked-ambiguous":
              // W1-T2789 — an exhausted checks-red PR cannot reach the fix rung's own pre-strike
              // base-gap check, because the table routes it here first. When the shared exact-path
              // decision selected THIS oldest candidate, perform the same update-branch write as
              // queue maintenance before escalating. The ordinary disposition stays recorded and
              // `acted` stays false, so this zero-strike release never seeds a dedup.
              if (staleBaseReleaseTarget?.pr.prNumber === pr.prNumber) {
                const live = await deps.readLiveState?.(pr);
                if (live?.ok !== true) {
                  log("sweep.red_base_refresh.live_indeterminate", {
                    pr_number: pr.prNumber,
                    head_sha: pr.headSha,
                  });
                } else {
                  const terminal = terminalStateReason(live.state);
                  if (terminal) {
                    acted = false;
                    standDownReason = `stale-base release refused: ${terminal}`;
                    break;
                  }
                  if (live.headSha !== pr.headSha) {
                    acted = false;
                    standDownReason = live.headSha
                      ? `stale-base release refused: head moved from ${pr.headSha} to ${live.headSha}`
                      : "stale-base release refused: fresh head sha was unreadable";
                    break;
                  }
                  const decision = staleBaseReleaseTarget.decision;
                  appendLine(deps.ledgerPath, {
                    run_id: deps.runId,
                    task_id: pr.taskId ?? "SWEEP",
                    step: "sweep.red_base_refresh.attempted",
                    pr_number: pr.prNumber,
                    pr_url: pr.prUrl,
                    head_sha: pr.headSha,
                    main_tip_sha: staleBaseReleaseTarget.mainTipSha,
                    behind_by: decision.behindBy,
                    matching_base_files: decision.matchingBaseFiles,
                  });
                  staleBaseAttemptedPrNumber = pr.prNumber;
                  try {
                    const outcome = await deps.updateBranch!(pr);
                    appendLine(deps.ledgerPath, {
                      run_id: deps.runId,
                      task_id: pr.taskId ?? "SWEEP",
                      step: outcome === "updated" ? "sweep.update_branch.updated" : `sweep.red_base_refresh.${outcome}`,
                      release_kind: "red-base",
                      pr_number: pr.prNumber,
                      pr_url: pr.prUrl,
                      head_sha: pr.headSha,
                      main_tip_sha: staleBaseReleaseTarget.mainTipSha,
                      behind_by: decision.behindBy,
                      matching_base_files: decision.matchingBaseFiles,
                    });
                    if (outcome === "updated") {
                      acted = false;
                      standDownReason =
                        `base refresh requested before strike-cap escalation: head was ${decision.behindBy} commit(s) behind ` +
                        `and newer main changed ${decision.matchingBaseFiles.join(", ")}; no strike spent`;
                      break;
                    }
                  } catch (error) {
                    appendLine(deps.ledgerPath, {
                      run_id: deps.runId,
                      task_id: pr.taskId ?? "SWEEP",
                      step: "sweep.red_base_refresh.error",
                      pr_number: pr.prNumber,
                      pr_url: pr.prUrl,
                      head_sha: pr.headSha,
                      main_tip_sha: staleBaseReleaseTarget.mainTipSha,
                      error: String((error as Error)?.message ?? error),
                    });
                  }
                }
                // A read/write failure remains visible above but never poisons this input: no
                // successful release row exists, so the next pass may retry under the existing
                // GitHub pacer. Preserve today's escalation for this pass below.
              }
              // W1-T196: stand down instead of escalating `task: UNKNOWN` — see
              // `unattributableFiling` above. No escalate call and no issue, but NEVER silent: the
              // stand-down reason names both the PR and the unresolved attribution on this pass's
              // own disposed line, the same trace discipline every other non-actionable
              // disposition gets.
              const absentDecision = absentChecksRepushDecision(
                pr,
                policy,
                now,
                prior.absentRepushes.get(pr.prNumber) ?? { count: 0, shas: new Set<string>() },
              );
              if (!unattributableFiling && absentDecision.repush && deps.repushAbsent) {
                // THE REMEDY, firing INSTEAD OF this pass's escalation. The escalation path itself
                // is unchanged and the next pass re-derives from the new head: if the fresh sha
                // gets its suites the PR proceeds, and if not, the cap routes it to escalate.
                const oldHead = pr.headSha;
                const newHead = await deps.repushAbsent(pr);
                // LEDGERED, because a fire-and-forget action nobody records becomes invisible
                // state: the PR, both shas, and the reason. `appendLine`, NOT `log()` — `log` is an
                // optional narration sink, but `priorActionsFromLedger` READS this step back to
                // enforce the bound, so it has to land in `deps.ledgerPath`. Skipped under
                // --dry-run for the same reason the disposed line is.
                if (!deps.dryRun) {
                  appendLine(deps.ledgerPath, {
                    run_id: deps.runId,
                    task_id: pr.taskId ?? "SWEEP",
                    step: "sweep.absent_repush",
                    pr_number: pr.prNumber,
                    pr_url: pr.prUrl,
                    old_head: oldHead,
                    new_head: newHead ?? null,
                    reason: absentDecision.reason,
                  });
                }
                log("sweep.absent_repush", {
                  pr_number: pr.prNumber,
                  old_head: oldHead,
                  new_head: newHead ?? null,
                });
                // `acted` stays FALSE, and this is load-bearing rather than cosmetic. `acted:true`
                // on a blocked-ambiguous line feeds `prior.escalated`, so claiming it would tell
                // every later pass this PR was already escalated — and it would then never escalate
                // at all, the very silent-forever failure this remedy exists to end. The re-push is
                // a DIFFERENT action with its own ledger line, the one the bound reads.
                acted = false;
                standDownReason = `ABSENT re-push fired instead of escalating this pass — ${absentDecision.reason}`;
              } else if (unattributableFiling) {
                acted = false;
                standDownReason =
                  `task id unresolved for PR #${pr.prNumber} (${pr.prUrl}) — a plan-filing PR carries no ` +
                  `Remudero-Task trailer by design (W1-T136 criterion 5); attribution failure on this class ` +
                  `is a known state, not an escalation`;
              } else {
                if (absentDecision.repush && !deps.repushAbsent) {
                  // The remedy WOULD have fired but no dep is wired — say so on the ledger line
                  // rather than escalating as if the ABSENT state were unrecognised.
                  standDownReason = `ABSENT re-push not wired — ${absentDecision.reason}`;
                }
                await deps.escalate(pr, reason, question!);
              }
              break;
            case "dep-review":
              if (deps.depReview) {
                depReviewOutcome = (await deps.depReview(pr)) ?? "unknown";
              } else {
                acted = false;
                standDownReason = "no depReview dep wired — dependabot PR left for the operator lane";
              }
              break;
            case "post-review":
              if (deps.postReview) {
                // W1-T473: NEVER await inline — that is exactly the one-at-a-time shape this
                // removes. The key is claimed and the PR queued immediately below, still inside
                // this synchronous switch before any `await` in this iteration; the call and
                // finalize happen in the bounded concurrent batch after the loop.
                deferredReview = true;
              } else {
                acted = false;
                standDownReason = "no postReview dep wired — ungated PR left for the operator lane";
              }
              break;
          }
        } catch (e) {
          acted = false;
          // W1-T529 — DEGRADE, DO NOT RETRY, AND DO NOT CALL IT A FAILURE. A budget floor
          // stand-down means the guarded call was refused BEFORE it ran, so this lane declined
          // rather than failed. Recorded as a stand-down on this PR's own line rather than an
          // `actionError`, so it neither counts in `actionsFailed` nor writes the failure row.
          // `acted` is false either way, which is the whole no-strike guarantee.
          const floorStandDown = budgetFloorStandDown(e, disposition);
          if (floorStandDown !== undefined) {
            standDownReason = floorStandDown;
          } else {
            actionError = String((e as Error)?.message ?? e);
            // W1-T99 — the canonical crash this fixes: the first live BLOCKED-class escalation's
            // `gh issue create` threw on a missing label and took the WHOLE reconciler down. This
            // PR's own disposed line already carries `action_error`; this is a SEPARATE, distinctly
            // named step so a failed action is grep-able on its own rather than buried in the
            // per-pass record. Reached only when not a dry run, so a preview leaves no trace.
            appendLine(deps.ledgerPath, {
              run_id: deps.runId,
              task_id: pr.taskId ?? "SWEEP",
              step: "sweep.action_failed",
              pr_number: pr.prNumber,
              pr_url: pr.prUrl,
              disposition,
              error: actionError,
            });
          }
        }
      }
    }

    // W1-T1000002 — CONVERGE: WITHDRAW WHAT THIS LANE DID NOT ARM. Runs regardless of `acted`,
    // since a held PR always has it false and the action switch never reaches `deps.arm`. A disarm
    // alone is undone by the next pass, whose arming dedup reads GitHub's OWN live armed bit, so
    // the withdrawal must be issued on every pass that still observes hold-stands-and-armed. Safe
    // when not armed and never throws, so it costs nothing on the common quiet pass.
    if (holdToWithdraw && deps.disarmAutoMerge) {
      try {
        await deps.disarmAutoMerge(pr, holdToWithdraw);
        const withdrawalLine = {
          run_id: deps.runId,
          task_id: pr.taskId ?? "SWEEP",
          step: "automerge.hold_withdrawal",
          pr_number: pr.prNumber,
          pr_url: pr.prUrl,
          head_sha: pr.headSha,
          hold_by: holdToWithdraw.by,
          hold_reason: holdToWithdraw.reason,
        };
        log("automerge.hold_withdrawal", withdrawalLine);
        // Skipped under --dry-run, exactly like `finalizeDisposition`'s own `sweep.disposed`
        // row below — a preview must leave no trace.
        if (!deps.dryRun) appendLine(deps.ledgerPath, withdrawalLine);
      } catch (e) {
        log("sweep.hold_withdrawal_failed", {
          pr_number: pr.prNumber,
          error: String((e as Error)?.message ?? e),
        });
      }
    }

    if (deferredReview) {
      // W1-T2771: discovery is not execution and therefore owns no mutex. Carry the stable key into
      // the pool, where `claimReview` atomically claims it immediately before the attempt — so a
      // concurrent light pass can review the head while this walk stalls on an unrelated effect.
      const reviewKey = reviewOutcomeKeyForPr(pr);
      pendingReviews.push({ index: prIndex, pr, reason, question, reviewKey });
      continue;
    }

    finalizeDisposition(
      prIndex,
      pr,
      disposition,
      reason,
      question,
      acted,
      alreadyDone,
      actionError,
      standDownReason,
      depReviewOutcome,
      armOutcome,
      spent,
      baseCausedMainTipSha,
    );
  }

  // ── W1-T1049 — REVIEW CONCURRENCY BUDGET, NOW ITS OWN ───────────────────────
  // Reviews get their OWN ceiling (`policy.reviewLanes`), no longer a SECOND consultation of
  // `policy.dispatchLanes`. That coupling pinned drainage's budget to a dispatch-only ruling and
  // let the two ceilings ADD with nothing naming their sum. `dispatchLanes` keeps its EXACT
  // meaning; this is a SIBLING row, never a retune of it. Floored at 1, so a misconfigured 0 can
  // never silently mean "review nothing".
  //
  // A CEILING, NOT A TARGET: it bounds only the calls live at once. Workers keep pulling from the
  // set THIS PASS already found eligible until it drains or an admission stop fires; it never goes
  // looking for work. W1-T1218/W1-T2584: ORDER BEFORE THE PULL — the pending set's order is
  // enumeration order and GitHub answers newest-first, so slicing by position gave lanes to the
  // NEWEST entries and deferred the same oldest tail every pass.
  const orderedReviews = orderPendingReviews(pendingReviews);
  const reviewLanes = effectiveReviewWidth(deps, policy, orderedReviews.length, now, ledgerLines);
  const postReview = deps.postReview;
  let nextReviewIndex = 0;
  let admissionStopReason: string | undefined;

  const closeAdmissions = (reason: string): void => {
    admissionStopReason ??= reason;
  };

  const takeNextReview = (): (typeof orderedReviews)[number] | undefined => {
    if (admissionStopReason !== undefined) return undefined;
    if (deps.continueReviewAdmissions) {
      try {
        if (!deps.continueReviewAdmissions()) {
          closeAdmissions("review admission continuation gate closed — re-derived next pass");
          return undefined;
        }
      } catch (e) {
        // NOT AN ERASING CATCH, and the reason is stated here because the ratchet cannot see it
        // otherwise: the failure text is carried INTO `closeAdmissions` inside a TEMPLATE STRING,
        // which `test/catch-erasure-ratchet.test.ts` has no route to recognise — its routes are a
        // rethrow, a logger call, a `reason:` key in the return shape, or a comment like this one.
        // The error is preserved verbatim in the stop reason an operator reads, and the gate FAILS
        // CLOSED: an unreadable continuation signal stops admitting rather than admitting on an
        // unknown, which is the whole reason it is consulted.
        closeAdmissions(
          `review admission continuation gate failed closed (${String((e as Error)?.message ?? e)}) — re-derived next pass`,
        );
        return undefined;
      }
    }
    const job = orderedReviews[nextReviewIndex];
    if (job === undefined) return undefined;
    nextReviewIndex += 1;
    return job;
  };

  const runReview = async (job: (typeof orderedReviews)[number]): Promise<void> => {
    const claim = claimReview(job.reviewKey);
    if (!claim.ok) {
      finalizeDisposition(
        job.index,
        job.pr,
        "post-review",
        job.reason,
        job.question,
        false,
        claim.deduped,
        undefined,
        claim.reason,
        undefined,
        undefined,
        undefined,
      );
      return;
    }
      let acted = true;
      let actionError: string | undefined;
      // W1-T529 (iv): set INSTEAD of `actionError` when the throw is a budget floor stand-down —
      // carried onto this PR's own `sweep.disposed` line as `stand_down_reason`, the same field
      // every other declined disposition already uses.
      let standDownReason: string | undefined;
      try {
        if (postReview) {
          try {
            await postReview(job.pr);
          } catch (e) {
            acted = false;
            // W1-T529 — THE ONE THROW THAT MUST NOT LEAVE A DEDUP KEY. Design (v), the
            // `review.post_refused` arm below, is right about every ORDINARY throw: without a key
            // the attempt repeats every pass, unbounded. It is exactly wrong about this one.
            //
            // A floor stand-down says nothing about this PR — the guarded call never ran — while
            // `review.post_refused` is read as a VERDICT that ESCALATES unchanged input rather than
            // retrying it. Writing it here converts "unaffordable for one tick" into "permanently
            // refused, then escalated", for a PR nothing ever looked at. The precedent is already
            // here: `review.post_failed` deliberately does not set that flag either.
            //
            // AND THE REPEAT IS STILL BOUNDED, just not by a key: the pacer CONSUMES its trip on the
            // call it refuses, so the next guarded call re-derives against a live reading. What
            // design (v) bounds is a throw that RECURS ON ITS OWN; this one cannot.
            const floorStandDown = budgetFloorStandDown(e, "post-review");
            if (floorStandDown !== undefined) {
              standDownReason = floorStandDown;
              // W1-T2584: capacity is provider/account-wide, not a verdict about this PR. Once
              // one worker observes the floor, no worker may pull a later head from this same
              // snapshot. Jobs already admitted may settle; every unstarted key is released below.
              closeAdmissions("review admissions stopped after provider capacity stand-down — re-derived next pass");
            } else {
              actionError = String((e as Error)?.message ?? e);
              appendLine(deps.ledgerPath, {
                run_id: deps.runId,
                task_id: job.pr.taskId ?? "SWEEP",
                step: "sweep.action_failed",
                pr_number: job.pr.prNumber,
                pr_url: job.pr.prUrl,
                disposition: "post-review",
                error: actionError,
              });
              // W1-T529/W1-T2753 — THE BOUNDED RETRY KEY. `sweep.action_failed` alone leaves no
              // exact-input outcome key and would retry this throw every pass. The row below keeps
              // the established material-input shape, but this prefix is classified into
              // `reviewRetryableThrows`, not the durable `reviewRefused` set: the latest dated
              // throw suppresses only through the pending ceiling, then re-admits the unchanged
              // input. `acted` stays false, so this never touches the fix lane's dedup.
              appendLine(deps.ledgerPath, {
                run_id: deps.runId,
                // This row is an outcome key, not only a diagnostic. Fully attributed views use
                // the same task/PR/head/body identity as delivered/refused posts; legacy callers
                // retain the historical empty-task fallback.
                task_id:
                  job.pr.reviewInputDigest !== undefined
                    ? (job.pr.taskId ?? `PR-${job.pr.prNumber}`)
                    : (job.pr.taskId ?? ""),
                step: "review.post_refused",
                head_sha: job.pr.headSha,
                ...(job.pr.reviewInputDigest !== undefined
                  ? { pr_url: job.pr.prUrl, review_input_digest: job.pr.reviewInputDigest }
                  : {}),
                reason: `post-review attempt threw — standing down rather than retrying this head unbounded: ${actionError}`,
              });
            }
          }
        }
      } finally {
        // W1-T513: release the key from the module-level mutex the instant this attempt SETTLES,
        // success or failure alike, and BEFORE `finalizeDisposition`, which only ledgers and never
        // gates a future pass. On success `postReview` has already durably written the reviewed
        // state a later pass will see; on failure the row just above establishes a bounded retry
        // clock. Releasing here is safe because that ledger guard blocks another attempt until the
        // clock expires, and holding it longer would only hide the timing evidence.
        claim.release();
      }
      finalizeDisposition(
        job.index,
        job.pr,
        "post-review",
        job.reason,
        job.question,
        acted,
        false,
        actionError,
        standDownReason,
        undefined,
        undefined,
        undefined,
      );
  };

  // W1-T2584 — FIXED-SIZE PULL POOL. At most `reviewLanes` worker promises and that many live
  // effects. Each pull increments the index synchronously before its first await, preserving
  // oldest-first START order even when reviewers settle out of order. The whole already-derived
  // set drains in one pass unless capacity or the injected continuation gate closes admissions.
  const workerCount = Math.min(reviewLanes, orderedReviews.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const job = takeNextReview();
        if (job === undefined) return;
        await runReview(job);
      }
    }),
  );

  // Only a named admission stop can leave an unstarted tail. W1-T2771: these jobs were discovered
  // but never pulled, so they own NO mutex key — do not `delete` theirs here, since a concurrent
  // pass may own it for a real active review. Ledger `acted:false` with no outcome key.
  const unstartedReviews = orderedReviews.slice(nextReviewIndex);
  for (const job of unstartedReviews) {
    finalizeDisposition(
      job.index,
      job.pr,
      "post-review",
      job.reason,
      job.question,
      false,
      false,
      undefined,
      admissionStopReason ?? "review admissions stopped — re-derived next pass",
      undefined,
      undefined,
      undefined,
    );
  }

  const summary: SweepSummary = {
    total: openPrs.length,
    byDisposition,
    actionsTaken,
    actionsFailed,
    actions,
    noneCount,
  };
  log("sweep.summary", {
    ...summary.byDisposition,
    total: summary.total,
    actions_taken: actionsTaken,
    actions_failed: actionsFailed,
  });
  // W1-T520 — the stall report. One line PER STALLED PR naming both facts, and NOTHING when the set
  // is empty: a quiet pass writes no row rather than a `stalled: 0` heartbeat nobody reads. Emitted
  // through `appendLine`, the durable sink, because `log` is an optional hook a caller may leave
  // unwired. This REPORTS the whole set; the lane below is what ACTS, and only on one of them.
  for (const stalled of armedButStalled(openPrs)) {
    appendLine(deps.ledgerPath, {
      run_id: deps.runId,
      task_id: stalled.taskId ?? "SWEEP",
      step: "sweep.armed_stalled",
      pr_number: stalled.prNumber,
      pr_url: stalled.prUrl,
      head_sha: stalled.headSha,
      auto_merge_armed: true,
      merge_state: "behind",
    });
  }
  // W1-T528 — PRESS THE BUTTON. {@link selectUpdateBranchTarget} picks AT MOST ONE PR from the set
  // just reported and, when the dep is wired, requests GitHub update it. Never a loop: one call
  // whatever the outcome, and a conflict is REPORTED and skipped rather than retried this pass.
  // `dryRun` leaves no trace, mirroring every other action here.
  if (!deps.dryRun && deps.updateBranch) {
    const target = selectUpdateBranchTarget(
      openPrs.filter((pr) => pr.prNumber !== staleBaseAttemptedPrNumber),
      now,
      deps.inFlightTaskIds ?? new Set(),
      deps.staleGateWorkflowsByPr ?? new Map(),
      deps.updatedForWorkflow ?? new Set(),
    );
    if (target) {
      // W1-T1212: a `StaleGatePr` (never `armedButStalled`'s own shape) carries the ONE extra
      // fact `deps.updatedForWorkflow`'s next read needs to remember this exact pair.
      const staleWorkflow = "staleWorkflow" in target ? (target as StaleGatePr).staleWorkflow : undefined;
      const staleWorkflowFields = staleWorkflow === undefined ? {} : { stale_workflow: staleWorkflow };
      appendLine(deps.ledgerPath, {
        run_id: deps.runId,
        task_id: target.taskId ?? "SWEEP",
        step: "sweep.update_branch.attempted",
        pr_number: target.prNumber,
        pr_url: target.prUrl,
        head_sha: target.headSha,
        ...staleWorkflowFields,
      });
      try {
        const outcome = await deps.updateBranch(target);
        appendLine(deps.ledgerPath, {
          run_id: deps.runId,
          task_id: target.taskId ?? "SWEEP",
          step: `sweep.update_branch.${outcome}`,
          pr_number: target.prNumber,
          pr_url: target.prUrl,
          head_sha: target.headSha,
          ...staleWorkflowFields,
        });
      } catch (e) {
        appendLine(deps.ledgerPath, {
          run_id: deps.runId,
          task_id: target.taskId ?? "SWEEP",
          step: "sweep.update_branch.error",
          pr_number: target.prNumber,
          pr_url: target.prUrl,
          head_sha: target.headSha,
          error: String((e as Error)?.message ?? e),
          ...staleWorkflowFields,
        });
      }
    }
  }
  // W1-T905 — "repair the instance, FILE THE CLASS": a PURE fold over this pass's own view of
  // `sweep.disposed` (prior rows plus this pass's, mirrored above), then AT MOST ONE best-effort
  // capture per due surface. Wrapped in the SAME throw containment the action switch has — a
  // capture failure must never fail the pass that produced the repairs it reports on, and the fold
  // recomputes fresh every call with no memory of its own.
  if (!deps.dryRun && deps.captureRepairFeedback) {
    const due = dueRepairFilings([...ledgerLines, ...passDisposedRows], now, policy);
    for (const filing of due) {
      try {
        await deps.captureRepairFeedback({
          id: filing.id,
          origin: `repair#${filing.surface}`,
          raw: renderRepairFilingRaw(filing),
        });
      } catch (e) {
        log("sweep.repair_filing.error", { surface: filing.surface, id: filing.id, error: String((e as Error)?.message ?? e) });
      }
    }
  }
  return summary;
}

/**
 * W1-T463 — THE DIAGNOSIS FOR "a light sweep ticks every 60s and a PR still sat green and
 * unreviewed for ~15 minutes". `runSweep`'s loop is SEQUENTIAL: every gated effect is awaited
 * before the next PR is dispositioned. The light sweep handed its WHOLE snapshot to `runSweep` as
 * ONE call, and `postReview` is not a cheap status flip — it materializes a worktree and executes
 * every whitelisted proof — so one slow PR blocked every eligible PR behind it.
 *
 * THE FIX IS SCOPED TO THIS ONE CALLER, never `runSweep` itself: every open PR gets its OWN call,
 * fired CONCURRENTLY. NOT a second review lane and no new per-PR mutex — each call goes through the
 * same dedup and ledger path, and no PR is handed to two of them. AN EMPTY PASS STILL GETS EXACTLY
 * ONE CALL, or the per-pass heartbeat would vanish on a quiet tick and a healthy quiet pass would
 * stop being distinguishable from a dead one. The cross-call case is
 * {@link inFlightReviewKeys}'s job.
 */
export async function runSweepLightPass(
  openPrs: OpenPrView[],
  deps: SweepDeps,
  policy: SweepPolicy = DEFAULT_SWEEP_POLICY,
): Promise<SweepSummary[]> {
  if (openPrs.length === 0) return [await runSweep([], deps, policy)];
  // W1-T526/W1-T2792 — THE QUEUE-ADMISSION RULE. The light pass admits at most the existing
  // `reviewLanes` semantic width, never the old hidden hard-coded one. Every other PR's own
  // `deps.actionable` is wrapped so its disposition is still reconciled and its loss attributable.
  const now = deps.now ? deps.now() : Date.now();
  // W1-T2439/W1-T2792: the light pass admits from BOTH lanes — the spawning one at the policy
  // review width, and the non-spawning plan-filing one at its own smaller derived bound. The
  // admitted SET is what each PR's scoped deps are decided against; nothing else moves.
  // W1-T2583: READ THE LEDGER ONCE FOR SELECTION, BEFORE RANKING. `runSweep` still performs its own
  // fresh read for every scoped action; this pass-level fold is only the liveness filter that keeps
  // a head the action-time guard will dedup from spending a scarce admission.
  // ledger-read-intent: live — this fold reads the live file only, never rotations.
  const readLedger = deps.readLedger ?? readLedgerLines;
  const selectionLedgerLines = readLedger(deps.ledgerPath);
  const selectionPrior = priorActionsFromLedger(selectionLedgerLines);
  const outcomes: ReviewAdmissionOutcomes = {
    delivered: selectionPrior.reviewDelivered,
    refused: selectionPrior.reviewRefused,
    retryableThrows: selectionPrior.reviewRetryableThrows,
  };
  const queueDepth = reviewAdmissionQueueDepth(openPrs, policy, now, outcomes);
  const semanticBound = effectiveReviewWidth(deps, policy, queueDepth, now, selectionLedgerLines);
  const { spawning, planFilings } = selectReviewAdmissions(openPrs, policy, now, outcomes, semanticBound);
  const selectedNumbers = new Set<number>([
    ...spawning.map((p) => p.prNumber),
    ...planFilings.map((p) => p.prNumber),
  ]);
  // Known outcome-deduped heads did not compete for either bound, but must still pass through
  // `runSweep`'s action-time guard so their own row says DELIVERED or REFUSED rather than falsely
  // claiming they lost an admission. This never dispatches a review.
  const outcomeDedupedNumbers = new Set(
    openPrs
      .filter((pr) =>
        deriveDisposition(pr, policy, now).disposition === "post-review" &&
        reviewAdmissionOutcomeKnown(pr, outcomes, policy, now))
      .map((pr) => pr.prNumber),
  );
  const admittedNumbers = spawning.map((p) => `#${p.prNumber}`).join(", ");
  return Promise.all(
    openPrs.map((pr) => {
      const baseActionable = deps.actionable;
      const baseStandDownReasonFor = deps.standDownReasonFor;
      // W1-T2379: `detachFixWait` is set on EVERY forwarded shape, admitted or not — the tick this
      // pass runs inside is awaited whichever PR won the post-review admission, so the fix rung's
      // CI wait must leave the await on both branches or the defect survives on one of them.
      const scopedDeps: SweepDeps =
        selectedNumbers.has(pr.prNumber) || outcomeDedupedNumbers.has(pr.prNumber)
          ? { ...deps, detachFixWait: true, selectAdaptiveReviewWidth: undefined }
          : {
              ...deps,
              detachFixWait: true,
              selectAdaptiveReviewWidth: undefined,
              actionable: (d) => (d === "post-review" ? false : baseActionable ? baseActionable(d) : true),
              // W1-T2426: name the mechanism, not just the fact. A `post-review` refused HERE was
              // eligible and lost this pass's bounded admission — a different event from a lane the
              // light pass never runs, and both used to write the same sentence.
              standDownReasonFor: (d) =>
                d === "post-review"
                  ? (pr.isPlanFiling === true
                      ? `not admitted this pass: at most ${policy.planFilingAdmissionBound} plan-filing ` +
                        "post-review admissions per light pass"
                      : `not admitted this pass: semantic post-review admission bound ${semanticBound}` +
                        (admittedNumbers ? `; admitted ${admittedNumbers} ahead` : ""))
                  : baseStandDownReasonFor?.(d),
            };
      return runSweep([pr], scopedDeps, policy);
    }),
  );
}

/** Outcome keys already known, before admission, to make the action-time review guard stand down. */
export interface ReviewAdmissionOutcomes {
  delivered: ReadonlySet<string>;
  refused: ReadonlySet<string>;
  /** W1-T2753: optional for compatibility with callers predating timed throw backoff. */
  retryableThrows?: ReadonlyMap<string, number | undefined>;
}

const EMPTY_RETRYABLE_REVIEW_THROWS = new Map<string, number | undefined>();

const EMPTY_REVIEW_ADMISSION_OUTCOMES: ReviewAdmissionOutcomes = {
  delivered: new Set<string>(),
  refused: new Set<string>(),
  retryableThrows: EMPTY_RETRYABLE_REVIEW_THROWS,
};

function reviewAdmissionOutcomeKnown(
  pr: OpenPrView,
  outcomes: ReviewAdmissionOutcomes,
  policy: SweepPolicy,
  now: number,
): boolean {
  const key = reviewOutcomeKeyForPr(pr);
  return (
    outcomes.delivered.has(key) ||
    outcomes.refused.has(key) ||
    retryableReviewThrowBackoffReason(outcomes.retryableThrows ?? EMPTY_RETRYABLE_REVIEW_THROWS, key, policy, now) !==
      undefined
  );
}

/**
 * W1-T526 — WHICH OPEN PRS the light pass admits into `post-review`. Branch protection's `strict`
 * setting means only ONE open PR can merge before every other reads `behind`, and that PR's next
 * push mints a NEW head, throwing away the sha-pinned verdict this lane just posted — so unbounded
 * fan-out cost N + (N-1) + … + 1 reviews to land N merges.
 *
 * PURE, over the whole snapshot, using the SAME classifier `runSweep` uses: a red, conflicted or
 * exhausted PR never derives `post-review`, so it can never hold the queue. OLDEST-HEAD-FIRST
 * BECAUSE IT CANNOT STARVE — head age is monotone, so a loser is strictly older next pass. An
 * unreadable age never outranks a readable one, and ties break on PR number for determinism.
 */
export function selectReviewAdmission(
  openPrs: readonly OpenPrView[],
  policy: SweepPolicy,
  now: number,
): OpenPrView | undefined {
  return selectReviewAdmissions(openPrs, policy, now).spawning[0];
}

/**
 * W1-T2439 — THE SPLIT ADMISSION, AND WHY THE PREDICATE IS `isPlanFiling` AND NOT THE REVIEW'S
 * OUTCOME: the outcome is written AFTER the review runs, so this function cannot see it.
 *
 * TWO LANES, AND ONLY ONE CAN SPAWN: the spawning lane is every PR not flagged a plan filing,
 * bounded at the configured review width; the non-spawning lane is plan filings, bounded by
 * {@link SweepPolicy.planFilingAdmissionBound}.
 *
 * FAIL-OPEN ON AN UNPOPULATED SIGNAL — `undefined` is treated as SPAWNING, so the split can only
 * ADD throughput on a positive signal. The few filings that DO reach the judge are charged to the
 * spawning side BY CONSTRUCTION, since detecting the outcome beforehand is unbuildable.
 */
export function selectReviewAdmissions(
  openPrs: readonly OpenPrView[],
  policy: SweepPolicy,
  now: number,
  outcomes: ReviewAdmissionOutcomes = EMPTY_REVIEW_ADMISSION_OUTCOMES,
  reviewWidth: number = Math.max(1, policy.reviewLanes),
): { spawning: OpenPrView[]; planFilings: OpenPrView[] } {
  // W1-T2583: selection and execution must agree on outcome-keyed eligibility, so the caller folds
  // both sets once from the same reader `runSweep` uses and filters here before either lane ranks.
  // The action-time lookup stays in `runSweep` as the boundary for a verdict racing this snapshot.
  const eligible = openPrs.filter((pr) =>
    deriveDisposition(pr, policy, now).disposition === "post-review" &&
    !reviewAdmissionOutcomeKnown(pr, outcomes, policy, now));
  const filings = eligible.filter((pr) => pr.isPlanFiling === true);
  const rest = eligible.filter((pr) => pr.isPlanFiling !== true);

  const oldestFirst = (a: OpenPrView, b: OpenPrView): number => {
    const ka = Date.parse(reviewAdmissionKey(a));
    const kb = Date.parse(reviewAdmissionKey(b));
    const aa = Number.isNaN(ka) ? -Infinity : now - ka;
    const ab = Number.isNaN(kb) ? -Infinity : now - kb;
    return ab !== aa ? ab - aa : a.prNumber - b.prNumber;
  };

  // The cheap lane, oldest-first on the SAME immutable key, truncated at its own bound. Sorting
  // by the key rather than repeatedly calling `oldestByKey` keeps one ordering definition.
  const bound = Math.max(0, policy.planFilingAdmissionBound);
  const planFilings = [...filings]
    .sort(oldestFirst)
    .slice(0, bound);

  const spawning = [...rest].sort(oldestFirst).slice(0, Math.max(1, reviewWidth));
  return { spawning, planFilings };
}

/** Number of spawning review candidates before the adaptive admission cut. */
function reviewAdmissionQueueDepth(
  openPrs: readonly OpenPrView[],
  policy: SweepPolicy,
  now: number,
  outcomes: ReviewAdmissionOutcomes,
): number {
  return openPrs.filter((pr) =>
    pr.isPlanFiling !== true &&
    deriveDisposition(pr, policy, now).disposition === "post-review" &&
    !reviewAdmissionOutcomeKnown(pr, outcomes, policy, now)
  ).length;
}

/**
 * W1-T2426 — THE ADMISSION KEY, AND WHY IT IS NOT {@link OpenPrView.lastActivityAt}.
 * {@link selectReviewAdmission} argues oldest-first cannot starve because nothing un-ages a head.
 * THAT PREMISE IS FALSE FOR THE WINNER: POSTING A VERDICT IS ITSELF AN UPDATE, so reviewing resets
 * the key of the PR it reviewed and a PR whose review FAILED is thrown behind PRs that waited less.
 *
 * THE ANSWER IS ALREADY IN THIS FILE — {@link orderPendingReviews} ranks on the IMMUTABLE
 * `createdAt`. THE FALLBACK CAN ONLY UNDER-RANK, NEVER OVER-RANK: since `updatedAt >= createdAt`,
 * a fallback candidate is scored YOUNGER than its true age and can only be passed over.
 * // Why: measured across seven PRs — docs/forensics/sweep.md.
 */
export function reviewAdmissionKey(pr: Pick<OpenPrView, "createdAt" | "lastActivityAt">): string {
  const created = pr.createdAt;
  if (created !== undefined && created !== "" && !Number.isNaN(Date.parse(created))) return created;
  return pr.lastActivityAt;
}

/**
 * THE OLDEST-HEAD-FIRST COMPARATOR ITSELF, lifted out of {@link selectReviewAdmission} so
 * W1-T528's disjoint `update-branch` selection CONSUMES it rather than shipping a second ordering
 * that could silently disagree. Byte-identical logic to what that function always ran — see its
 * doc for the starvation argument, which applies unchanged to any `{prNumber, lastActivityAt}`
 * population, not only the post-review one.
 */
export function oldestActivityFirst<T extends { prNumber: number; lastActivityAt: string }>(
  candidates: readonly T[],
  now: number,
): T | undefined {
  return oldestByKey(candidates, now, (c) => c.lastActivityAt);
}

/**
 * W1-T2426 — THE RANKING ITSELF, with the key supplied by the caller.
 *
 * ONE IMPLEMENTATION, TWO KEYS, DELIBERATELY NOT TWO COMPARATORS: extracting the key rather than
 * forking the comparator keeps the shared-ordering guarantee, so the tie-break, the `-Infinity`
 * treatment of an unparseable date, and the strict `>` that makes the FIRST maximal candidate win
 * are each defined exactly once and cannot drift.
 *
 * {@link oldestActivityFirst} is UNCHANGED and remains what `update-branch` consumes. That is not
 * an oversight: for `update-branch`, `updatedAt` advancing is the CORRECT ranking, because a
 * just-updated branch should not be re-selected ahead of one that has waited. For `post-review`
 * the same advance is pathological — reviewing is the work being attempted, not finishing.
 */
function oldestByKey<T extends { prNumber: number }>(
  candidates: readonly T[],
  now: number,
  keyOf: (candidate: T) => string,
): T | undefined {
  let winner: T | undefined;
  let winnerAgeMs = -Infinity;
  for (const candidate of candidates) {
    const pushedAt = Date.parse(keyOf(candidate));
    const ageMs = Number.isNaN(pushedAt) ? -Infinity : now - pushedAt;
    if (!winner || ageMs > winnerAgeMs || (ageMs === winnerAgeMs && candidate.prNumber < winner.prNumber)) {
      winner = candidate;
      winnerAgeMs = ageMs;
    }
  }
  return winner;
}

/** One-line human render of a sweep summary, for both callers' console output. */
export function renderSweepSummary(s: SweepSummary): string {
  const b = s.byDisposition;
  return (
    `sweep: ${s.total} open PR(s) · ${s.actionsTaken} action(s) taken · ` +
    `mergeable ${b.mergeable} · blocked-fixable ${b["blocked-fixable"]} · conflicted ${b.conflicted} · ` +
    `stale ${b.stale} · blocked-ambiguous ${b["blocked-ambiguous"]}` +
    (s.actionsFailed > 0 ? ` · ⚠️ ${s.actionsFailed} action(s) FAILED (see sweep.action_failed)` : "") +
    (s.noneCount > 0 ? ` · ⚠️ ${s.noneCount} UNDISPOSED (invariant violated)` : "")
  );
}

// ── W1-T121 — THE QUEUE GOVERNOR (the 23-open-PR incident) ───────────────────────────────────
//
// No backpressure existed anywhere in the pipeline, so authoring rate converted DIRECTLY into
// queue depth with nothing to arrest it. Little's law is the argument: throughput comes from
// BOUNDING WIP, not from pushing harder on intake.
//
// ASYMMETRY IS THE WHOLE DESIGN: {@link checkQueueGovernor} is a pure predicate consulted ONLY on
// the NEW-task dispatch path. It is NEVER consulted by `runSweep`, which arms, fixes, closes and
// escalates already-open PRs at ANY depth, ungated — a governor that also throttled drainage would
// deepen the very queue it exists to bound.
// Why: the drain-with-dispatch-down corroboration is in docs/forensics/sweep.md.

/** {@link checkQueueGovernor}'s verdict for one dispatch-path consultation. */
export interface QueueGovernorResult {
  /** true ⇒ the dispatch path MUST defer — do not open a new PR this pass. */
  deferred: boolean;
  /** The open-PR count the decision was made against. */
  observedOpenCount: number;
  /** The policy limit consulted (`policy.wipLimit`, carried for the ledger line). */
  wipLimit: number;
}

/**
 * The queue governor's pure predicate: at or above `policy.wipLimit` open PRs, NEW dispatch is
 * deferred; below it, dispatch proceeds. THRESHOLDS ARE POLICY DATA (rule 2) — that field is the
 * ONLY thing that moves this decision, and there is no second ad-hoc constant near a dispatch call
 * site. Never call this from `runSweep` or any of its deps; see the asymmetry note above.
 */
export function checkQueueGovernor(
  openPrCount: number,
  policy: SweepPolicy = DEFAULT_SWEEP_POLICY,
): QueueGovernorResult {
  return {
    deferred: openPrCount >= policy.wipLimit,
    observedOpenCount: openPrCount,
    wipLimit: policy.wipLimit,
  };
}

/**
 * A throttled pass is NOT silent: the dispatch path calls this exactly when
 * {@link checkQueueGovernor} defers, writing one ledger line carrying the observed open count — so
 * a quiet daemon with nothing runnable stays distinguishable from a THROTTLED one.
 */
export function logQueueGovernorDeferral(
  result: QueueGovernorResult,
  appendLine: (path: string, line: Record<string, unknown> & { run_id: string; task_id: string; step: string }) => void,
  ledgerPath: string,
  runId: string,
): void {
  appendLine(ledgerPath, {
    run_id: runId,
    task_id: "GOVERNOR",
    step: "dispatch_deferred_wip",
    observed_open_count: result.observedOpenCount,
    wip_limit: result.wipLimit,
  });
}

// ── W1-T148 — THE COST GOVERNOR (the $206/60-run spin-loop incident) ─────────────────────────
//
// A spin loop burned roughly $206 over 60 runs with no DAILY ceiling anywhere: every individual
// run stayed safely under its own per-run cap, so that backstop never fired and nothing was
// watching the CROSS-RUN total. The architectural TWIN of the queue governor above — a WIP limit
// bounds intake by COUNT, this bounds it by DOLLARS.
//
// Same asymmetry, same reason: {@link checkCostGovernor} is consulted ONLY on the dispatch path,
// NEVER by `runSweep`, which drains already-open PRs at any day-cost. Throttling drainage would
// strand in-flight work to save money — a worse failure than the spend itself.

/**
 * Sums ONE ledgered dollar figure per RUN, for every run with at least one line inside the window,
 * then totals them. {@link deriveDayCostUsd} and {@link deriveWeekCostUsd} are both this ONE
 * reduction over a different window, never a separately reimplemented scan.
 *
 * PER-RUN, NOT PER-LINE, WHICH AVOIDS DOUBLE-COUNTING: a run's `verdict` line — or, absent one,
 * its first cost-bearing line — already carries that run's RUNNING TOTAL. Summing every
 * cost-bearing line for a run would count its spend twice over.
 *
 * A line with no `ts`, an unparseable one, or one outside the window is excluded; a run whose only
 * in-window lines carry no cost contributes 0.
 */
export function deriveWindowCostUsd(
  lines: ReadonlyArray<Record<string, unknown>>,
  windowStartMs: number,
  windowEndMs: number,
): number {
  const byRun = new Map<string, Record<string, unknown>[]>();
  for (const line of lines) {
    const ts = typeof line.ts === "string" ? line.ts : undefined;
    const parsed = ts ? Date.parse(ts) : NaN;
    if (!Number.isFinite(parsed) || parsed < windowStartMs || parsed >= windowEndMs) continue;
    const runId = typeof line.run_id === "string" ? line.run_id : undefined;
    if (!runId) continue;
    const bucket = byRun.get(runId);
    if (bucket) bucket.push(line);
    else byRun.set(runId, [line]);
  }
  let total = 0;
  for (const runLines of byRun.values()) {
    const verdictLine = runLines.find((l) => l.step === "verdict");
    const costLine = verdictLine ?? runLines.find((l) => typeof l.cost_usd === "number");
    if (costLine && typeof costLine.cost_usd === "number") total += costLine.cost_usd;
  }
  return total;
}

/** `[start, end)` of `now`'s UTC calendar day, in epoch ms — the day-cost window boundary,
 *  factored out so {@link deriveDayCostUsd} and a "merged today" tally (lib/glance.ts, W1-T159)
 *  agree on exactly what "today" means, rather than each computing its own midnight. */
export function utcDayWindowMs(now: number): [start: number, end: number] {
  const day = new Date(now).toISOString().slice(0, 10); // "YYYY-MM-DD", UTC
  const start = Date.parse(`${day}T00:00:00.000Z`);
  return [start, start + 24 * 60 * 60 * 1000];
}

/** `[start, end)` of the CURRENT UTC ISO week (Monday 00:00 UTC through the following Monday
 *  00:00 UTC) containing `now`, in epoch ms — the week-to-date spend window (W1-T159). */
export function utcWeekWindowMs(now: number): [start: number, end: number] {
  const [dayStart] = utcDayWindowMs(now);
  const dayOfWeek = new Date(dayStart).getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (dayOfWeek + 6) % 7; // Mon=0, Tue=1, ..., Sun=6
  const weekStart = dayStart - daysSinceMonday * 24 * 60 * 60 * 1000;
  return [weekStart, weekStart + 7 * 24 * 60 * 60 * 1000];
}

/**
 * The day's ledgered cost — `now`'s UTC calendar day, per-run (see {@link deriveWindowCostUsd}).
 * BEHAVIOR UNCHANGED from this function's pre-W1-T159 form: same window, same verdict-preferred
 * per-run reduction, so {@link checkCostGovernor}'s call site sees byte-identical results.
 */
export function deriveDayCostUsd(lines: ReadonlyArray<Record<string, unknown>>, now: number): number {
  const [start, end] = utcDayWindowMs(now);
  return deriveWindowCostUsd(lines, start, end);
}

/**
 * The WEEK-TO-DATE ledgered cost (W1-T159): the current UTC ISO week, same per-run reduction as
 * {@link deriveDayCostUsd}. The GLANCE strip's own falsifier is why this exists beside the day
 * figure — a daily-only figure cannot answer whether today is normal, since a modest post-merge
 * burn looks unremarkable in isolation and is only legible against a weekly baseline.
 */
export function deriveWeekCostUsd(lines: ReadonlyArray<Record<string, unknown>>, now: number): number {
  const [start, end] = utcWeekWindowMs(now);
  return deriveWindowCostUsd(lines, start, end);
}

/** {@link checkCostGovernor}'s verdict for one dispatch-path consultation. */
export interface CostGovernorResult {
  /** true ⇒ the dispatch path MUST defer — do not open a new run this pass. */
  deferred: boolean;
  /** The day's ledgered cost (notional USD) the decision was made against. */
  observedDayCostUsd: number;
  /** The policy ceiling consulted (`policy.dailyCostCeilingUsd`, carried for the ledger line). */
  ceilingUsd: number;
}

/**
 * The cost governor's pure predicate: at or over `policy.dailyCostCeilingUsd` ledgered dollars
 * spent today, NEW dispatch is deferred. THRESHOLDS ARE POLICY DATA (rule 2) — that field is the
 * ONLY thing that moves this decision. Never call this from `runSweep` or any of its deps.
 *
 * W1-T331: THIS FUNCTION WAS NEVER THE FROZEN PART — `policy` is already a per-call argument, so
 * any caller building its own policy per consultation gets a live decision. The bug was that every
 * real caller omitted it and silently took the default parameter, which resolves to the const
 * captured once at import. The fix builds an explicit policy from a per-consultation ceiling.
 */
export function checkCostGovernor(
  dayCostUsd: number,
  policy: SweepPolicy = DEFAULT_SWEEP_POLICY,
): CostGovernorResult {
  return {
    deferred: dayCostUsd >= policy.dailyCostCeilingUsd,
    observedDayCostUsd: dayCostUsd,
    ceilingUsd: policy.dailyCostCeilingUsd,
  };
}

/**
 * A throttled pass is NOT silent: the dispatch path calls this exactly when
 * {@link checkCostGovernor} defers, writing one ledger line naming the day-cost and ceiling — so a
 * quiet daemon stays distinguishable from a BUDGET-THROTTLED one.
 */
export function logCostGovernorDeferral(
  result: CostGovernorResult,
  appendLine: (path: string, line: Record<string, unknown> & { run_id: string; task_id: string; step: string }) => void,
  ledgerPath: string,
  runId: string,
): void {
  appendLine(ledgerPath, {
    run_id: runId,
    task_id: "GOVERNOR",
    step: "dispatch_deferred_budget",
    observed_day_cost_usd: result.observedDayCostUsd,
    daily_cost_ceiling_usd: result.ceilingUsd,
  });
}

// ── W1-T1038 — THE MEMORY GOVERNOR (the 2026-08-19 host stall) ───────────────────────────────
//
// Dispatch has priced every draw in dollars and in turns since the ledger began, and never once in
// bytes. The host went unreachable with three workers live. NOTHING WAS KILLED — a measured
// absence of every OOM signature, not a lost log: with no swap the kernel could not page out
// anonymous memory, so it evicted and re-faulted executable pages under reclaim livelock, which
// never arms the OOM killer.
//
// THE ONE DELIBERATE ASYMMETRY WITH ITS TWO SIBLINGS: those are composed under a FAIL-CLOSED rule,
// where an unreadable reading counts as over ceiling. THIS GOVERNOR'S UNREADABLE CASE MUST NOT
// JOIN THAT ARM — a guard refusing dispatch on every `/proc/meminfo` hiccup would convert a
// once-in-six-days event into a total outage. FAIL OPEN, enforced one layer up at the composition
// point; this predicate never sees a probe failure at all.

/** {@link checkMemoryGovernor}'s verdict for one dispatch-path consultation. */
export interface MemoryGovernorResult {
  /** true ⇒ the dispatch path MUST defer — do not open a new run this pass. */
  deferred: boolean;
  /** The observed `MemAvailable` (MiB, read from `/proc/meminfo` — NEVER a cgroup limit; design
   *  note (6): this fleet's containers carry no memory limit, so a cgroup read reports
   *  "unbounded" and would authorise every dispatch silently) the decision was made against. */
  observedAvailableMib: number;
  /** The policy floor consulted (`policy.memoryFloorMib`, carried for the ledger line). */
  floorMib: number;
}

/**
 * The memory governor's pure predicate: STRICTLY BELOW `policy.memoryFloorMib` available, NEW
 * dispatch is deferred; at or above it, dispatch proceeds. Same shape and the SAME dispatch-only
 * asymmetry as its two siblings — never call it from `runSweep` or any of its deps.
 *
 * SHIPS INERT: the floor defaults to 0 and the observation can never be negative, so this never
 * defers until an operator raises the floor against a measured figure — one this task's rationale
 * says is NOT YET KNOWN and must not be guessed. Measuring it is {@link logMemoryObservation}'s job.
 *
 * DEFER, NEVER KILL: this only gates the NEXT dispatch. It takes a plain number and returns a
 * plain object, so there is no parameter through which it could reach a running process.
 */
export function checkMemoryGovernor(
  availableMib: number,
  policy: SweepPolicy = DEFAULT_SWEEP_POLICY,
): MemoryGovernorResult {
  return {
    deferred: availableMib < policy.memoryFloorMib,
    observedAvailableMib: availableMib,
    floorMib: policy.memoryFloorMib,
  };
}

/**
 * THE OBSERVATION IS LEDGERED ON EVERY CONSULTATION — unlike the two deferral loggers above, which
 * fire only when their governor defers, this ledgers unconditionally, admitted readings included.
 * A deferral-only row would sample exactly the population that never happens while the floor ships
 * disabled; the evidence this exists to gather is the ADMITTED reading.
 *
 * NOT registered in `ledger.ts`'s decision-relevant set: nothing reads this step back yet — THE
 * READER IS THE OPERATOR. Membership is required only once a future predicate reads it back, and
 * that predicate's own PR is the one that adds it. Written WITHOUT the literal comparison
 * expression on purpose: test/ledger-rotation.test.ts derives that set by scanning this file's
 * TEXT, comments included, so spelling it out here manufactures a consumer that does not exist.
 */
export function logMemoryObservation(
  result: MemoryGovernorResult,
  appendLine: (path: string, line: Record<string, unknown> & { run_id: string; task_id: string; step: string }) => void,
  ledgerPath: string,
  runId: string,
): void {
  appendLine(ledgerPath, {
    run_id: runId,
    task_id: "GOVERNOR",
    step: "dispatch_memory_observed",
    observed_available_mib: result.observedAvailableMib,
    memory_floor_mib: result.floorMib,
    deferred: result.deferred,
  });
}

/**
 * How many CONSECUTIVE `sweep.post_review.failed` lines — with no intervening `.done` — mean the
 * post-review path has STALLED rather than hiccupped.
 *
 * DERIVED FROM THE LEDGER, NOT PICKED. The observed transient maximum is 5 and the observed stall
 * is 77, with NO observation between, so 8 sits inside an empty gap with real margin over the
 * worst transient and far below the stall. Raise this only against new data.
 */
export const POST_REVIEW_STALL_THRESHOLD = 8;

/** {@link detectPostReviewStall}'s verdict. */
export interface PostReviewStallVerdict {
  /** true ⇒ the run of consecutive failures has reached {@link POST_REVIEW_STALL_THRESHOLD}. */
  stalled: boolean;
  /** Length of the CURRENT consecutive-failure run (0 when the newest outcome was a success). */
  consecutiveFailures: number;
  /** `ts` of the newest failure in the run — the EPISODE KEY the escalator dedups on. */
  newestFailureTs?: string;
  /** `ts` of the oldest failure in the run, so the escalation can state how long it has been going. */
  oldestFailureTs?: string;
  /**
   * The run's error text with digit runs replaced by `<N>`. NORMALISATION IS LOAD-BEARING: the
   * observed failures carried ten distinct raw strings and exactly ONE normalised string, because
   * the text embeds the PR number. Grouping on the RAW text would split one systematic stall into
   * ten unrelated-looking groups and defeat the whole point of noticing that a failure repeats.
   */
  normalisedError?: string;
  /**
   * true when every failure in the run is an API quota exhaustion. Carried so the escalation can
   * say so — a quota failure is fleet-stopping but self-clearing at a known reset, which asks
   * something different of an operator than a persistent bug. It deliberately does NOT gate
   * `stalled`: gating on a recognised error string would blind the detector to every other one.
   */
  rateLimited: boolean;
}

/** Digit runs → `<N>`, so a per-PR error text collapses to one group. See `normalisedError`. */
function normaliseErrorText(s: string): string {
  return s.replace(/\d+/g, "<N>");
}

/**
 * Is the sweep's post-review path stalled? Pure over ledger lines, oldest-first.
 *
 * THE DEFECT THIS EXISTS FOR: `sweep.post_review.failed` had fired dozens of times across a week
 * — every one a rate limit — and NOTHING SURFACED IT. Green PRs sat unreviewed while the sweep
 * retried each tick and logged another identical line, until an operator found it by hand. A
 * transport fix removes THIS cause; it does not remove the class.
 *
 * COUNTS THE CURRENT RUN ONLY, and any `.done` resets it — the question is "is it stalled NOW",
 * not "has it ever failed a lot". A lifetime count would latch permanently after the first bad day.
 */
export function detectPostReviewStall(
  lines: ReadonlyArray<Record<string, unknown>>,
  threshold: number = POST_REVIEW_STALL_THRESHOLD,
): PostReviewStallVerdict {
  const run: Record<string, unknown>[] = [];
  for (const l of lines) {
    if (l.step === "sweep.post_review.done") run.length = 0;
    else if (l.step === "sweep.post_review.failed") run.push(l);
  }
  if (run.length === 0) return { stalled: false, consecutiveFailures: 0, rateLimited: false };
  const errs = run.map((l) => (typeof l.error === "string" ? l.error : ""));
  const newest = run[run.length - 1];
  const oldest = run[0];
  return {
    stalled: run.length >= threshold,
    consecutiveFailures: run.length,
    newestFailureTs: typeof newest?.ts === "string" ? newest.ts : undefined,
    oldestFailureTs: typeof oldest?.ts === "string" ? oldest.ts : undefined,
    normalisedError: normaliseErrorText(errs[errs.length - 1] ?? ""),
    rateLimited: errs.length > 0 && errs.every((e) => /rate limit/i.test(e)),
  };
}

// ── W1-T150 — THE LEVEL-TRIGGERED CREDIT BACKFILL rung (ratifies P30) ────────────────────────
//
// The same P22 argument applied to the MERGE EVENT rather than open-PR pipeline state. A run's
// terminal `verdict` line is EDGE-TRIGGERED at run-end, so a run that ends before its OWNED PR
// merges never revisits the question and the ledger's per-task credit can sit wrong forever even
// though GitHub's state has moved on. Every consumer reading `verdict` directly rather than the
// GitHub-derived union inherits the stale answer. This rung closes that gap the SAME way
// `runSweep` closes the open-PR one: re-derive fresh every poll, act once, no-op on a repeat.

/**
 * One task's observed merge-credit candidacy. `merged` is the CALLER's ownership-asserted,
 * trailer-anchored verdict — this module never talks to GitHub directly, exactly like
 * {@link OpenPrView}: true only when a MERGED PR is owned by this task's own `run-<taskId>-*`
 * branch and carries its anchored trailer, for any run of the task (sibling credit). `false`
 * covers every other observed state, because the backfill must NEVER fire on anything short of an
 * observed merge — that is the falsifier.
 */
export interface CreditCandidate {
  taskId: string;
  prNumber: number;
  prUrl: string;
  merged: boolean;
}

/** One task's credit-backfill outcome this pass. */
export interface CreditBackfillResult {
  taskId: string;
  prNumber: number;
  prUrl: string;
  /** True ⇒ a NEW `verdict.merged` correction was appended this pass. */
  corrected: boolean;
  /** True ⇒ the ledger already carried merge credit for this task (dedup). */
  alreadyCredited: boolean;
}

/** The whole credit-backfill pass's outcome. */
export interface CreditBackfillSummary {
  total: number;
  corrected: number;
  results: CreditBackfillResult[];
}

/*
 * `hasMergeCredit` USED TO LIVE HERE and was removed 2026-08-13, not merely bypassed. It answered
 * "has this task's merge already been credited" over an array read with `readLedgerLines`, WHICH
 * OPENS EXACTLY ONE FILE — and that single-file read was the defect: rotation caps a step, so older
 * credit left the live file and the same tasks were re-credited forever.
 *
 * `readMergeCreditedTaskIds` (status.ts) now answers the same question across all three ledger
 * forms. Its semantics are preserved where they were right: still keyed on `task_id` ALONE and
 * never `run_id`, because sibling credit means ANY run of this task recording a merge counts. The
 * line-shape test is imported rather than restated — two hand-maintained copies of "what a merge
 * credit looks like" is what once let a back-credited task stay circuit-broken.
 */

/**
 * THE CREDIT-BACKFILL RUNG (W1-T150). For every candidate whose OWNED PR is `merged` but whose
 * ledger carries no credit yet, append EXACTLY ONE `verdict.merged` correction naming the PR. A
 * candidate whose PR is not merged is always a no-op. A repeat pass appends nothing further:
 * `alreadyCredited` is recomputed per candidate against the snapshot PLUS every correction this
 * same pass appended, so two candidates naming one task still credit exactly once.
 *
 * Mirrors {@link runSweep}'s shape deliberately — same injected reader and appender, same
 * leaves-no-trace `dryRun` contract — but is a SEPARATE entry point: its input domain is one
 * candidate per TASK, disjoint from `runSweep`'s one view per OPEN PR, since a merged PR is no
 * longer open and would never appear there.
 */
export async function runCreditBackfill(
  candidates: CreditCandidate[],
  deps: Pick<SweepDeps, "ledgerPath" | "runId" | "readLedger" | "appendLine" | "log" | "dryRun">,
): Promise<CreditBackfillSummary> {
  const appendLine = deps.appendLine ?? appendLedger;
  const log = deps.log ?? (() => {});

  // THE CREDIT QUESTION IS "EVER", AND ONE FILE CANNOT ANSWER IT. This used to read
  // `readLedgerLines`, which opens exactly ONE path, against a step whose rows rotation caps.
  // Credit older than the cap left the live file, this check said "not credited", the task was
  // re-credited, and the fresh row evicted another — self-sustaining.
  // Why: the measured arithmetic is in docs/forensics/sweep.md and {@link readMergeCreditedTaskIds}.
  const credited = readMergeCreditedTaskIds(deps.ledgerPath, {
    // Only the tasks this pass could ask about, so the walk stops as soon as they are all resolved
    // rather than reading to the cap. Measured: real plan ids resolve below depth 8.
    candidates: candidates.map((c) => c.taskId),
    readLive: deps.readLedger,
  }).credited;

  const results: CreditBackfillResult[] = [];
  let corrected = 0;

  for (const c of candidates) {
    const alreadyCredited = credited.has(c.taskId);
    const shouldCorrect = c.merged && !alreadyCredited;
    const acted = shouldCorrect && !deps.dryRun;

    if (acted) {
      appendLine(deps.ledgerPath, {
        run_id: deps.runId,
        task_id: c.taskId,
        step: "verdict.merged",
        verdict: "merged",
        pr_number: c.prNumber,
        pr_url: c.prUrl,
        source: "sweep.credit_backfill",
      });
      // Reflected into THIS pass's own view, not just re-read on the next sweep, so a duplicate
      // candidate naming the same task later in the same array credits exactly once.
      credited.add(c.taskId);
      corrected++;
    }

    // LOG ONLY WHAT WAS ACTED ON. This ran once per candidate per sweep, and the daemon sweeps
    // every poll, so a backfill correcting nothing still wrote a line per already-credited task
    // forever — thousands of no-op rows. The ledger is the provenance spine and its SIZE is a read
    // cost charged to every reader. The summary below still reports `total` on every pass, so
    // COVERAGE stays observable even when the per-candidate detail is silent.
    if (acted) {
      log("sweep.credit_backfill", {
        task_id: c.taskId,
        pr_number: c.prNumber,
        pr_url: c.prUrl,
        corrected: acted,
        already_credited: alreadyCredited,
      });
    }

    results.push({ taskId: c.taskId, prNumber: c.prNumber, prUrl: c.prUrl, corrected: acted, alreadyCredited });
  }

  const summary: CreditBackfillSummary = { total: candidates.length, corrected, results };
  log("sweep.credit_backfill.summary", { total: summary.total, corrected: summary.corrected });
  return summary;
}

// ── ESCALATION-LIFECYCLE RECONCILER (fb-1784756088300-6a481e) ────────────────────────────────
//
// The sweep RAISES needs-human issues but nothing ever CLOSED them when the blocker resolved, so
// the large majority of open ones were stale. This is the missing third leg of the lifecycle —
// creation, dedup-at-creation, CLOSURE here — and it rides the SAME sweep seam and level-triggered
// doctrine as the credit backfill above: the CALLER re-derives each open issue's referenced task
// and hands the derivation here.
//
// A referent is TERMINAL, and the escalation auto-closes naming the resolution, when it MERGED or
// when its PR CLOSED WITHOUT MERGING. A still-LIVE referent is left untouched, and so is an
// INDETERMINATE derivation — never closed on a read this pass could not trust. Bounded per cycle
// so a large backlog drains gradually, and every close is ledgered.

/** How many stale escalations one reconcile pass may close — bounds the write burst so a
 *  large backlog (the observed 94-open shape) drains across several sweeps, never one. */
export const MAX_ESCALATION_CLOSES_PER_CYCLE = 20;

/**
 * QUEUE LABELS this reconciler retires issues from (W1-T349): `needs-human` plus `fleet-notice`.
 * A residual-escalation-judge demotion leaves the NEEDS ME board, which keys on `needs-human`, but
 * the design's promise — "recovery is relabelling, nothing is deleted" — only holds if THIS
 * reconciler can still find and retire it once its referent resolves.
 * {@link EscalationReconcileCandidate} carries no label field, so a fleet-notice-sourced candidate
 * is already treated identically to a needs-human one by construction, not by an added branch.
 */
export const RETIRABLE_ESCALATION_LABELS: readonly string[] = [NEEDS_HUMAN_LABEL, FLEET_NOTICE_LABEL];

/**
 * List every OPEN issue across {@link RETIRABLE_ESCALATION_LABELS}, deduped by issue number. An
 * issue cannot carry both queue labels by construction, but the dedup costs nothing and protects
 * against a future producer that double-labels.
 *
 * Same fail-soft contract as a single listing: a read failure on ANY label aborts the WHOLE list,
 * never a partial result a caller could mistake for "nothing else is open".
 */
export function listRetirableEscalationIssues(issues: IssueGateway): OpenIssue[] {
  const seen = new Map<number, OpenIssue>();
  for (const label of RETIRABLE_ESCALATION_LABELS) {
    for (const issue of issues.listOpen?.(label) ?? []) {
      seen.set(issue.number, issue);
    }
  }
  return [...seen.values()];
}

/** One open needs-human issue paired with its referenced task's CURRENT derived state. */
export interface EscalationReconcileCandidate {
  issueUrl: string;
  issueNumber?: number;
  taskId: string;
  /**
   * W1-T347: the ask-type classification for this issue, when the caller can supply it from the
   * issue's own label. `"question"` routes a terminal-referent close through
   * {@link renderMootedCloseComment}. `"action"` OR omitted — the untyped legacy corpus — keeps
   * today's close path byte-identical, and MUST NOT change behaviour.
   */
  askType?: AskType;
  /** The referent's state, derived by the caller via the #737/#741-corrected deriveStatus. */
  derived: {
    merged: boolean;
    /** W1-T162: the referenced PR CLOSED WITHOUT MERGING (deriveStatus's `prState`, raw
     *  "CLOSED") — a terminal, resolved-negative disposition (superseded/abandoned), distinct
     *  from an open/blocked-pending-fix PR that is still live. Mutually exclusive with `merged`. */
    closed?: boolean;
    /** W1-T119: the read that produced this derivation FAILED — treat as neither resolved nor live. */
    indeterminate?: boolean;
    prUrl?: string;
    prNumber?: number;
    source?: string;
  };
}

/** One issue's reconcile outcome this pass. */
export interface EscalationReconcileResult {
  issueUrl: string;
  taskId: string;
  outcome: "closed" | "left-live" | "left-indeterminate" | "deferred-cap" | "close-failed";
}

/** The whole reconcile pass's outcome. */
export interface EscalationReconcileSummary {
  total: number;
  closed: number;
  results: EscalationReconcileResult[];
}

export interface EscalationReconcileDeps {
  /** Close one issue, posting the citation comment. Wraps `gh issue close --comment` in prod. */
  closeIssue: (url: string, comment: string) => void;
  ledgerPath: string;
  runId: string;
  appendLine?: typeof appendLedger;
  log?: (step: string, extra?: Record<string, unknown>) => void;
  /** dryRun leaves no trace (no `gh`, no ledger line) — mirrors runSweep/runCreditBackfill. */
  dryRun?: boolean;
  /** Bound on closes this cycle; defaults to {@link MAX_ESCALATION_CLOSES_PER_CYCLE}. */
  maxCloses?: number;
  /**
   * What the candidate BUILDER saw on intake, so the summary can distinguish "nothing was open"
   * from "everything open was dropped". Optional and defaulted: a caller that omits it gets
   * exactly the line it got before, never a crash and never a fabricated zero.
   */
  intake?: { issuesSeen: number; droppedNoTaskTrailer: number; droppedNoReferent: number };
}

/**
 * The closing citation posted on a reconciled issue — NAMES THE RESOLUTION, the merged PR or the
 * closed-without-merging one that superseded it, so the closure is legible rather than a silent
 * disappearance. Pure and exported for a direct assertion.
 */
export function renderReconcileCloseComment(c: EscalationReconcileCandidate): string {
  const pr = c.derived.prNumber !== undefined ? `#${c.derived.prNumber}` : (c.derived.prUrl ?? "its PR");
  const link = c.derived.prUrl ? ` (${c.derived.prUrl})` : "";
  const via = c.derived.source ? ` — derived via \`${c.derived.source}\`` : "";
  const resolution = c.derived.merged
    ? `is now **merged**, resolved by ${pr}${link}${via}`
    : `is now **closed without merging** (${pr}${link}${via}) — superseded or abandoned, no longer a live blocker`;
  return [
    "Auto-closed by the escalation-lifecycle reconciler (fb-1784756088300-6a481e).",
    "",
    `The referenced task **${c.taskId}** ${resolution}. This escalation's blocker is gone.`,
    "",
    "_Level-triggered closure from GitHub-derived state (the #737/#741 derivation). If the decision this issue raised is still open, reopen it._",
  ].join("\n");
}

/**
 * W1-T347 — the guard {@link renderReconcileCloseComment} does NOT apply to: a `needs-question`
 * issue whose referent went terminal is MOOTED, not resolved, and closing it in that function's
 * voice claims an answer nobody gave.
 *
 * This names the mooting event but states PLAINLY that the question was never answered, and says
 * where to re-raise it. Starts with a FIXED, DISTINCT prefix so a later census can tell a mooted
 * close from a resolved one by exact string match, never by parsing prose.
 * // Why: a third of reconciler auto-closes carried question-form titles — docs/forensics/sweep.md.
 */
export function renderMootedCloseComment(c: EscalationReconcileCandidate): string {
  const pr = c.derived.prNumber !== undefined ? `#${c.derived.prNumber}` : (c.derived.prUrl ?? "its PR");
  const link = c.derived.prUrl ? ` (${c.derived.prUrl})` : "";
  const via = c.derived.source ? ` — derived via \`${c.derived.source}\`` : "";
  const event = c.derived.merged
    ? `${pr}${link} merged${via}`
    : `${pr}${link} closed without merging${via}`;
  return [
    "MOOTED by the escalation-lifecycle reconciler (fb-1784756088300-6a481e).",
    "",
    `The referenced task **${c.taskId}**'s blocking PR ${event}, so this issue no longer blocks anything and is being closed.`,
    "",
    "**This did NOT answer the question this issue raised.** No human weighed in — the referent simply went " +
      "terminal on its own, mooting the question rather than resolving it.",
    "",
    "_If the question still stands, re-raise it: reopen this issue, or file a fresh one against the task above._",
  ].join("\n");
}

/**
 * Reconcile OPEN needs-human issues against their referent's CURRENT derived state. A separate
 * entry point mirroring {@link runCreditBackfill}: its input domain is one OPEN issue per
 * candidate, disjoint from `runSweep`'s open PRs. Best-effort and per-issue throw-contained, so
 * one failed close never strands the rest — the W1-T99 lesson.
 */
export async function runEscalationReconcile(
  candidates: EscalationReconcileCandidate[],
  deps: EscalationReconcileDeps,
): Promise<EscalationReconcileSummary> {
  const appendLine = deps.appendLine ?? appendLedger;
  const log = deps.log ?? (() => {});
  const maxCloses = deps.maxCloses ?? MAX_ESCALATION_CLOSES_PER_CYCLE;

  const results: EscalationReconcileResult[] = [];
  let closed = 0;

  for (const c of candidates) {
    // INDETERMINATE first (W1-T119): a derivation this pass could not trust is neither a close
    // NOR a confident "still live" — it simply waits for a readable pass.
    if (c.derived.indeterminate) {
      results.push({ issueUrl: c.issueUrl, taskId: c.taskId, outcome: "left-indeterminate" });
      continue;
    }
    // STILL LIVE: the referent is neither merged nor closed-without-merging — leave the
    // escalation untouched (an open PR, or a task with no PR yet, is a live decision).
    if (!c.derived.merged && !c.derived.closed) {
      results.push({ issueUrl: c.issueUrl, taskId: c.taskId, outcome: "left-live" });
      continue;
    }
    // RESOLVED (merged OR closed-without-merging). Bounded per cycle: once the cap is
    // reached, the rest drain on the next sweep.
    if (closed >= maxCloses) {
      results.push({ issueUrl: c.issueUrl, taskId: c.taskId, outcome: "deferred-cap" });
      continue;
    }
    // dryRun leaves no trace but still previews (and counts toward the cap so the preview
    // matches a live cycle's bound) — mirrors runCreditBackfill's `acted = ... && !dryRun`.
    if (deps.dryRun) {
      closed++;
      results.push({ issueUrl: c.issueUrl, taskId: c.taskId, outcome: "closed" });
      continue;
    }
    // W1-T347: a question-typed issue is MOOTED by a terminal referent, never resolved by
    // one — nobody answered it. Action-typed and untyped (`askType` omitted, the legacy
    // pre-W1-T346 corpus) issues keep today's resolved-close comment byte-identical.
    const comment = c.askType === "question" ? renderMootedCloseComment(c) : renderReconcileCloseComment(c);
    try {
      deps.closeIssue(c.issueUrl, comment);
    } catch (e) {
      // PER-ISSUE THROW CONTAINMENT (W1-T99): one failed close never strands the rest, and an
      // uncounted failure retries next cycle rather than consuming a cap slot forever.
      log("sweep.escalation_close_failed", {
        issue_url: c.issueUrl,
        task_id: c.taskId,
        error: String((e as Error)?.message ?? e),
      });
      results.push({ issueUrl: c.issueUrl, taskId: c.taskId, outcome: "close-failed" });
      continue;
    }
    // W1-T162: name the resolution kind in the ledger too, not just the GitHub comment —
    // "merged" (or a task credited via correction) vs. "closed" (closed without merging).
    const resolution = c.derived.merged ? "merged" : "closed";
    appendLine(deps.ledgerPath, {
      run_id: deps.runId,
      task_id: c.taskId,
      step: "sweep.escalation_closed",
      issue_url: c.issueUrl,
      resolution,
      pr_url: c.derived.prUrl,
      pr_number: c.derived.prNumber,
      source: c.derived.source,
    });
    log("sweep.escalation_closed", {
      issue_url: c.issueUrl,
      task_id: c.taskId,
      resolution,
      pr_url: c.derived.prUrl,
      pr_number: c.derived.prNumber,
    });
    closed++;
    results.push({ issueUrl: c.issueUrl, taskId: c.taskId, outcome: "closed" });
  }

  const summary: EscalationReconcileSummary = { total: candidates.length, closed, results };
  // `total: 0` USED TO BE AMBIGUOUS. `issues_seen` is always emitted — one integer, negligible on a
  // line that fires often — so the healthy case is positively identifiable rather than merely
  // un-alarming. The per-reason tally rides ONLY on the abnormal path: on a healthy pass the line
  // is one field wider than before, and the detail appears exactly when there is something to
  // explain, which is also when an operator is reading it.
  const intake = deps.intake;
  const dropped =
    intake && intake.issuesSeen > summary.total
      ? { no_task_trailer: intake.droppedNoTaskTrailer, no_referent: intake.droppedNoReferent }
      : undefined;
  log("sweep.escalation_reconcile.summary", {
    total: summary.total,
    closed: summary.closed,
    // `undefined` when the caller supplied no intake — the field is absent, never a misleading 0.
    ...(intake ? { issues_seen: intake.issuesSeen } : {}),
    ...(dropped ? { dropped } : {}),
  });
  return summary;
}

// ── POST-FIX RE-VERIFICATION RECONCILER (W1-T124) ────────────────────────────────────────────
//
// The DRAINAGE-side complement to the queue governor above: the governor stops the queue GROWING,
// this rung stops it ROTTING. A red caused by infrastructure whose cause is now merged should not
// need a human to notice it — but nothing re-examined the PRs an already-fixed cause had poisoned,
// and each needed a hand-pushed fresh head to clear.
//
// DESIGN (i): the failure-pattern-to-fix-PR mapping is held as DATA ({@link DEFAULT_FIX_CLASSES}),
// so covering a new systemic fix is a ROW, never a branch — exactly how {@link DISPOSITION_RULES}
// keeps disposition out of `deriveDisposition`'s control flow.
//
// DESIGN (iii): the re-drive must work against REAL ci-gate semantics, which is why W1-T123's
// dedupe-by-name is a hard dependency — before it, a re-run in place could never clear a stale red.
// This module never talks to GitHub directly, so HOW to re-drive is the caller's own wiring.
// Why: the measured incidents are in docs/forensics/sweep.md.

/**
 * One failure-pattern to fix-PR class mapping ROW: DATA, not code. `matchesFailure` is a PURE
 * predicate over the SAME {@link OpenPrView} shape every other rung reads, never an LLM
 * classification (rule 2) — so covering a new systemic fix appends a row here and never touches
 * {@link runPostFixReverification}'s control flow.
 */
export interface FixClass {
  /** Stable id for ledger lines, dedup keys, and test fixtures — never reused across rows. */
  id: string;
  /** The merged PR whose fix resolves this class — named in every reason/ledger line. */
  fixPrNumber: number;
  /** Human description, carried into ledger lines for an operator reading the trail. */
  description: string;
  /** Does this PR's OBSERVED, currently-recorded failure match this class? */
  matchesFailure: (pr: OpenPrView) => boolean;
}

/**
 * The 2026-07-19 regression fixture's own class: `ci-gate` times out waiting for a required check
 * that had, or shortly would have, succeeded on the SAME head. Matches on the failing check's
 * recorded name AND its log tail, never on `checksState` alone — a genuinely red mutation-ratchet
 * must never match this class.
 */
export const CI_GATE_TIMEOUT_FIX_CLASS: FixClass = {
  id: "ci-gate-required-check-timeout",
  fixPrNumber: 820, // W1-T123 — "fix(ci-gate): dedupe check-runs by name, evaluate only latest attempt"
  description:
    "ci-gate timed out waiting for a required check that had already (or was about to have) succeeded " +
    "on the same head — a stale check-run attempt read instead of the latest one, not a real defect",
  matchesFailure: (pr) =>
    (pr.ciFailures ?? []).some(
      (f) => f.name === "ci-gate" && /timed out waiting for required check\(s\)/i.test(f.logTail),
    ),
};

/**
 * W1-T474 row 1 — the coverage-tier fix. The ratchet reads its baseline from the PR's OWN checked
 * out tree, so a PR merged before the fix still fails against the file that fix already corrected,
 * though its diff never touched coverage. Matches on the check name AND the ratchet's own
 * "BLOCKED" wording, never on `checksState` alone: a PR that genuinely lowered coverage must not match.
 */
export const COVERAGE_TIER_FIX_CLASS: FixClass = {
  id: "coverage-ratchet-stale-floor",
  fixPrNumber: 1758,
  description:
    "coverage-ratchet blocked against a floor #1758 had already raised in scripts/coverage-baseline.json " +
    "— the checked-out tree read the pre-fix floor, not a real coverage regression in this PR's own diff",
  matchesFailure: (pr) =>
    (pr.ciFailures ?? []).some(
      (f) => f.name === "coverage-ratchet" && /BLOCKED -- coverage is below a floor/i.test(f.logTail),
    ),
};

/**
 * W1-T474 row 2 — the capability-snapshot regeneration. The check fails whenever the checked-out
 * `MASTER-PLAN.md` does not match a fresh regeneration, and the default checkout is the merge ref
 * against the OLD base, so every PR merged before the fix reads the stale block. Matches on the
 * check's own STALE wording, never on `checksState` alone.
 */
export const CAPABILITY_SNAPSHOT_FIX_CLASS: FixClass = {
  id: "capability-snapshot-stale",
  fixPrNumber: 1762,
  description:
    "the claims check's capability-snapshot assertion failed on a MASTER-PLAN.md block #1762 had " +
    "already regenerated — the checked-out tree carried the stale block, not this PR's own diff",
  matchesFailure: (pr) =>
    (pr.ciFailures ?? []).some(
      (f) => f.name === "claims" && /CAPABILITY SNAPSHOT block is STALE/i.test(f.logTail),
    ),
};

/** The live class table this reconciler consults by default — a new systemic fix is a row appended
 *  here, never a change to {@link runPostFixReverification}. */
/**
 * The DIFF-SCOPED coverage failure's own wording, NOT the aggregate ratchet's.
 * {@link COVERAGE_TIER_FIX_CLASS} keys on the floor sentence; the per-diff gate that actually
 * blocks most PRs prints a different one and therefore matched nothing at all.
 */
const DIFF_COVERAGE_BLOCK_RE = /diff-coverage: BLOCKED -- this diff adds source line\(s\) with zero covering tests/i;

/** `  - src/lib/foo.ts:123` — one uncovered line as the gate lists them. */
const UNCOVERED_LINE_RE = /^\s*-\s+(\S+:\d+)\s*$/;

/** What {@link diffCoverageReport} found: the check that blocked and the lines it named. */
export interface DiffCoverageReport {
  check: string;
  uncovered: string[];
}

/**
 * REPORTS a diff-scoped coverage block and the lines it names. A REPORTER, NEVER A REPAIRER, AND
 * THE DISTINCTION IS STRUCTURAL: {@link FixClass} requires a `fixPrNumber` meaning the merged PR
 * whose fix resolves the class, and every existing row is that shape. A diff-coverage block is
 * not — its remedy is a test for a specific line, different for every PR, and no merged PR
 * resolves it. A fourth row would invent a number that does not mean what the field says, and a
 * match would redrive the same gate to fail identically. So this names the check and the uncovered
 * lines on a surface someone already reads, and dispatches nothing.
 */
export function diffCoverageReport(failures: readonly CiFailure[]): DiffCoverageReport | undefined {
  for (const f of failures) {
    if (!DIFF_COVERAGE_BLOCK_RE.test(f.logTail)) continue;
    const uncovered: string[] = [];
    for (const line of f.logTail.split("\n")) {
      const m = line.match(UNCOVERED_LINE_RE);
      if (m?.[1]) uncovered.push(m[1]);
    }
    return { check: f.name, uncovered };
  }
  return undefined;
}

export const DEFAULT_FIX_CLASSES: readonly FixClass[] = [
  CI_GATE_TIMEOUT_FIX_CLASS,
  COVERAGE_TIER_FIX_CLASS,
  CAPABILITY_SNAPSHOT_FIX_CLASS,
];

/**
 * The injected redrive effect's outcome. `fresh`, when present, is a brand new {@link OpenPrView}
 * read AFTER the redrive settled — this reconciler never invents one and never re-uses the STALE
 * pre-redrive view, which would just re-observe the red it set out to clear. Absent `fresh` means
 * the redrive was dispatched with no settled read yet: this pass records it so it is never
 * repeated, and the NEXT ordinary sweep re-derives once GitHub's state has caught up.
 */
export interface RedriveResult {
  fresh?: OpenPrView;
}

/** Injected effects for {@link runPostFixReverification} — mirrors {@link runCreditBackfill}/
 *  {@link runEscalationReconcile}'s shape (same ledger reader/appender, same dry-run-leaves-no-
 *  trace contract) so all three reconciler rungs in this file behave identically to their callers. */
export interface PostFixReverificationDeps {
  /**
   * Re-drive the PR's matched required check for the given class. Whether that means re-requesting
   * the check-run in place or pushing a refresh commit is entirely the effect's own decision; this
   * module never calls gh or git directly.
   */
  redrive: (pr: OpenPrView, fixClass: FixClass) => RedriveResult | Promise<RedriveResult>;
  ledgerPath: string;
  runId: string;
  readLedger?: (path: string) => Array<Record<string, unknown>>;
  appendLine?: typeof appendLedger;
  log?: (step: string, extra?: Record<string, unknown>) => void;
  /** Preview only: derive matches, take no effects, write no ledger lines. */
  dryRun?: boolean;
  /**
   * OPTIONAL reader for a PR's currently-failing checks (W1-T977), consulted ONLY when this pass's
   * snapshot carries `ciFailures: undefined` AND `checksState === "pending"` — the one state
   * {@link CI_GATE_TIMEOUT_FIX_CLASS} exists to match and the one state the producer never
   * populates, because a gate timeout is BY DEFINITION observed while a sibling is still running.
   * The class was structurally unable to see its own trigger. Never consulted when green, none, or
   * already red, so this is narrowly scoped and never a blanket re-fetch. OMITTED, behaviour is
   * BYTE-IDENTICAL to before this dep existed.
   */
  readCiFailures?: (pr: OpenPrView) => CiFailure[] | undefined | Promise<CiFailure[] | undefined>;
}

/** One PR's outcome this pass. */
export interface PostFixReverificationResult {
  prNumber: number;
  taskId?: string;
  outcome: "redriven" | "unmatched" | "already-redriven" | "redrive-failed";
  fixClassId?: string;
  /** Present only when outcome === "redriven" AND the redrive returned a fresh, settled view
   *  (design note ii — "re-dispose on the fresh result"). */
  disposition?: Disposition;
  /** Present only when outcome === "redriven" — the strikes credited back this pass (design iv). */
  strikesCredited?: number;
}

/** The whole reconciliation pass's outcome. */
export interface PostFixReverificationSummary {
  total: number;
  redriven: number;
  results: PostFixReverificationResult[];
}

/**
 * THE POST-FIX RE-VERIFICATION RUNG (W1-T124). For every open PR whose CURRENTLY-recorded failure
 * matches a {@link FixClass} row whose `fixPrNumber` the caller reports merged — this module never
 * talks to GitHub — re-drive its matched check EXACTLY ONCE, deduped on the ledger by
 * `pr@headSha@class` so a NEW push legitimately re-earns one, mirroring fix-dispatch dedup. When
 * the redrive returns a settled fresh view, re-derive the disposition with strikes credited back.
 *
 * A PR matching no merged class is entirely untouched — no redrive, no ledger line — which is the
 * falsifier proving the mapping does real work rather than blanket-rerunning every open PR.
 */
export async function runPostFixReverification(
  openPrs: OpenPrView[],
  mergedFixPrNumbers: ReadonlySet<number>,
  deps: PostFixReverificationDeps,
  classes: readonly FixClass[] = DEFAULT_FIX_CLASSES,
): Promise<PostFixReverificationSummary> {
  // Alias-bound call site (W1-T2393): the bare `readLedgerLines` regex cannot match this because it
  // is bound to a name and invoked below, so this is documentary only.
  // ledger-read-intent: live — this fold reads the live file only, never rotations.
  const readLedger = deps.readLedger ?? readLedgerLines;
  const appendLine = deps.appendLine ?? appendLedger;
  const log = deps.log ?? (() => {});
  const lines = readLedger(deps.ledgerPath);

  const results: PostFixReverificationResult[] = [];
  let redriven = 0;

  for (const pr of openPrs) {
    // W1-T977: the shared snapshot's `ciFailures` is undefined for a PENDING PR by construction,
    // but a `ci-gate` timeout is observed EXACTLY while a sibling is still pending — so matching on
    // the snapshot field alone can never fire for the one class this loop exists to catch. Consult
    // the injected reader ONLY in that gap, never for a green PR and never overriding a red
    // snapshot, so every other rung's view of `pr` stays untouched.
    let extraCiFailures: CiFailure[] | undefined;
    if (pr.ciFailures === undefined && pr.checksState === "pending" && deps.readCiFailures) {
      try {
        extraCiFailures = await deps.readCiFailures(pr);
      } catch {
        // Best-effort, mirrors fetchCiFailures' own degrade-to-nothing contract: a failed read
        // just leaves this PR unmatched this pass rather than aborting the whole reconciliation.
      }
    }
    const matchPr: OpenPrView = extraCiFailures !== undefined ? { ...pr, ciFailures: extraCiFailures } : pr;
    const cls = classes.find((c) => mergedFixPrNumbers.has(c.fixPrNumber) && c.matchesFailure(matchPr));
    if (!cls) {
      results.push({ prNumber: pr.prNumber, taskId: pr.taskId, outcome: "unmatched" });
      continue;
    }

    // Head-keyed dedup, mirroring `runSweep`'s fix-dispatch dedup: a NEW push legitimately re-earns
    // a redrive even for the same class, but a repeat pass over the SAME unchanged head never
    // re-drives twice.
    const redriveKey = `${pr.prNumber}@${pr.headSha}@${cls.id}`;
    const already = lines.some((l) => l.step === "sweep.post_fix_redriven" && l.redrive_key === redriveKey);
    if (already) {
      results.push({ prNumber: pr.prNumber, taskId: pr.taskId, outcome: "already-redriven", fixClassId: cls.id });
      continue;
    }

    if (deps.dryRun) {
      results.push({ prNumber: pr.prNumber, taskId: pr.taskId, outcome: "redriven", fixClassId: cls.id });
      redriven++;
      continue;
    }

    let redrive: RedriveResult;
    try {
      redrive = await deps.redrive(pr, cls);
    } catch (e) {
      // PER-PR THROW CONTAINMENT (the W1-T99 lesson): one failed redrive never strands the rest of
      // this pass, and since nothing is ledgered on failure it retries on the very next sweep.
      log("sweep.post_fix_redrive_failed", {
        pr_number: pr.prNumber,
        fix_class: cls.id,
        error: String((e as Error)?.message ?? e),
      });
      results.push({ prNumber: pr.prNumber, taskId: pr.taskId, outcome: "redrive-failed", fixClassId: cls.id });
      continue;
    }

    // Design note iv: captured from the PRE-redrive view, never from
    // `redrive.fresh` (whose ledger read may already reflect THIS pass's own
    // no-strike redrive) — the full count this PR carried in is what gets
    // credited back.
    const creditedStrikes = pr.priorStrikes;

    appendLine(deps.ledgerPath, {
      run_id: deps.runId,
      task_id: pr.taskId ?? "SWEEP",
      step: "sweep.post_fix_redriven",
      pr_number: pr.prNumber,
      pr_url: pr.prUrl,
      redrive_key: redriveKey,
      fix_class: cls.id,
      fix_pr_number: cls.fixPrNumber,
      credited_strikes: creditedStrikes,
    });
    // Reflected into THIS pass's own snapshot (mirrors runCreditBackfill) so a
    // duplicate candidate for the same head within one pass redrives once.
    lines.push({ step: "sweep.post_fix_redriven", redrive_key: redriveKey });
    redriven++;

    let disposition: Disposition | undefined;
    if (redrive.fresh) {
      // Re-dispose on the fresh, settled result (design note ii) — with
      // strikes credited to zero (design note iv): the ONLY defect this rung
      // ever matches against is the now-fixed class (acceptance 2 proves an
      // unmatched PR is never touched at all), so every strike a MATCHED PR
      // carried in was spent chasing that same infrastructure artifact.
      const dispositionView: OpenPrView = { ...redrive.fresh, priorStrikes: 0 };
      disposition = deriveDisposition(dispositionView).disposition;
    }

    log("sweep.post_fix_redriven", {
      pr_number: pr.prNumber,
      fix_class: cls.id,
      fix_pr_number: cls.fixPrNumber,
      credited_strikes: creditedStrikes,
      disposition,
    });

    results.push({
      prNumber: pr.prNumber,
      taskId: pr.taskId,
      outcome: "redriven",
      fixClassId: cls.id,
      disposition,
      strikesCredited: creditedStrikes,
    });
  }

  const summary: PostFixReverificationSummary = { total: openPrs.length, redriven, results };
  log("sweep.post_fix_reverification.summary", { total: summary.total, redriven: summary.redriven });
  return summary;
}
