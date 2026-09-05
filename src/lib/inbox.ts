import { execFileSync } from "node:child_process";
import { slug as kebabSlug } from "./feedback-docket.js";
// The DEFAULT export — a mutable object — so a test's `t.mock.method` can intercept the `fs` calls below. Named
// bindings off `node:fs` are non-configurable, so mocking them throws.
import { createHash } from "node:crypto";
import fs from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import type { MergedResolver, Plan } from "./plan.js";
import { parseTasksFromYaml, PlanError, unmetDependencies } from "./plan.js";
import { lintPlan, lintTask } from "./task-linter.js";
import { DUPLICATE_SLUG_SHINGLE_K } from "./task-linter.js";
import { bestNearDuplicate, DEFAULT_DUPLICATE_CUTOFF, type DuplicateCorpusEntry } from "./knowledge-dedup.js";
import type { GhFailureReason } from "./status.js";
import { isGhRateLimitError } from "./status.js";

/** A draft-lint finding: the linter's own `LintViolation`s plus this rung's `draft-parse` finding. Structurally typed
 *  so both flow through one path without widening the linter's closed union. */
export type DraftLintViolation = RelintViolation;
import { MAX_RELINT_ATTEMPTS, relintGuidanceLines, type RelintViolation } from "./relint.js";
import { appendLedger } from "./ledger.js";
import { defaultIsPidAlive } from "./drain-lock.js";
import { isHolderStale, reclaimStaleLock } from "./fs-race-safe.js";
import { buildPlanPrCommitMessage } from "./plan-pr-emitter.js";
import { workerLedgerFields, type WorkerResult } from "./worker.js";
import type { InterpretReplyResult } from "./reply-interpreter.js";

/**
 * `rmd inbox` — the ratification inbox's deterministic core (MASTER-PLAN P25(i), W1-T110).
 *
 * Approval controls fail by fatigue, so only READY proposals surface and readiness is computed, never asserted
 * [research: hitl-approval-fatigue-2026]. Drafting is an LLM's job ({@link runDraftRung}); everything after is
 * deterministic, so {@link classifyProposal} is pure. READY = deps merged AND anchors still grep-true on main AND the
 * fragment passes `rmd lint-plan` AND no open conflicts; an unfired trigger yields DEFERRED_WITH_TRIGGER, checked
 * first (P19/WS-2). Why: P25's requirement verbatim — docs/forensics/inbox.md.
 */

// ── Evidence anchors + triggers (proposal-level facts, supplied by the registry) ──────────

/** One fact a proposal's readiness cites — "still true on main" is a grep, not a vibe. */
export interface EvidenceAnchor {
  /** Human-readable name of what this anchor asserts (rendered in a not-ready reason). */
  description: string;
  /** Literal/regex pattern `git grep` checks for on the target ref. */
  pattern: string;
  /** Repo-relative path to grep within; omitted greps the whole tree. */
  path?: string;
}

/** A named, not-yet-fired precondition (MASTER-PLAN's HELD/TRIGGER shape). `fired` is resolved by the CALLER. */
export interface ProposalTrigger {
  description: string;
  fired: boolean;
}

/** One round of `rmd reframe` feedback, captured verbatim (P25 iii, W1-T111). `retracted` (W1-T194) is set only by an
 *  explicit `--supersedes`, never inferred from recency, and never deletes. */
export interface ReframeRecord {
  feedback: string;
  retracted?: boolean;
}

/** One ACTIVE (not-yet-ratified) proposal the inbox tiers. */
export interface Proposal {
  /** e.g. "P25" */
  id: string;
  summary: string;
  evidenceAnchors: EvidenceAnchor[];
  /** Present only for a HELD/TRIGGER-shaped proposal (deferred-with-trigger). */
  trigger?: ProposalTrigger;
  /** Ids of OTHER proposals this one conflicts with, when they are also open. */
  conflictsWith?: string[];
  /** Every `rmd reframe` round this proposal has been through, oldest first — "the reframe history rides the proposal
   *  until resolution" (P25 iii design). Empty/absent for a proposal that has never been reframed. */
  reframeHistory?: ReframeRecord[];
  /** W1-T2451: the board item this proposal was minted from, absent for every other family. It is what makes "the PR
   *  this is ABOUT has resolved" expressible, since anchors here are always []. */
  originatingItemId?: string;
}

// ── The understood-request handoff (W1-T2500) ──────────────────────────────────────────────
//
// `interpretReply` (reply-interpreter.ts) reaches `status: "understood"` and stops there by design. This mints a
// {@link Proposal} for the same tiering and does nothing else: no task filed, nothing auto-approved, nothing paced.

/** The understood request a caller hands to {@link proposalFromUnderstoodRequest} — the thread it traces back to, and
 *  the request text that thread now understands in full (every clarification, if any were asked, answered). */
export interface UnderstoodRequest {
  /** The thread this traces back to. NEVER {@link Proposal.originatingItemId}, board-review's own referent
   *  vocabulary, which would wire this into retirement for an unresolvable referent. */
  threadId: string;
  /** The request text, quoted VERBATIM into the minted proposal's summary — never paraphrased, mirroring
   *  `synthesizeFeedbackDocketProposal`'s own "verbatim, cited" discipline (feedback-docket.ts). */
  requestText: string;
}

/** The proposal id minted for one thread — derived, never random, so re-classifying the same understood thread names
 *  the same proposal instead of opening a duplicate. */
export function understoodRequestProposalId(threadId: string): string {
  return `thread:${threadId}`;
}

/** Mint the {@link Proposal} an understood thread hands to the tiering, and nothing else. `undefined` for
 *  `"clarifying"` or `"exhausted"`, so such a thread emits nothing and runs nothing. */
export function proposalFromUnderstoodRequest(request: UnderstoodRequest, interpretation: InterpretReplyResult): Proposal | undefined {
  if (interpretation.status !== "understood") return undefined;
  return {
    id: understoodRequestProposalId(request.threadId),
    summary: `Understood request from thread ${request.threadId}:\n${request.requestText}`,
    evidenceAnchors: [],
  };
}

// ── Board-review referent retirement (W1-T2451) ────────────────────────────────────────────
//
// Such a proposal's `evidenceAnchors` is permanently `[]`, so evidence drift can never retire one. Its referent is
// checked against the board item's own state instead, read in ONE BATCH per pass — never per proposal, which would
// reintroduce the N-calls-per-tick shape.

/** A board item's live state, in board-review.ts's own `BoardItem` vocabulary. Duplicated rather than imported,
 *  because board-review.ts imports from this module and the cycle would close. */
export interface BoardReferentState {
  status: "open" | "merged" | "dead";
  unhandledEscalations: number;
}

/** The ONE batched read of every board-review referent's state this pass. A referent id absent from `states` is
 *  `"unreadable"` for that proposal alone: cannot-observe means WAIT (W1-T130), never a silent retirement.
 *  `"unreadable"` means the whole read failed, so each proposal keeps whatever classification it would otherwise have
 *  had, marked unverified. */
export type BoardReferentRead = { kind: "ok"; states: ReadonlyMap<string, BoardReferentState> } | { kind: "unreadable" };

/** True once a board-review finding's referent has left the state that produced it: no longer open, or escalations
 *  handled. Kind is read off the proposal's own id prefix. */
function boardReferentResolved(proposal: Proposal, state: BoardReferentState): boolean {
  if (state.status !== "open") return true;
  return proposal.id.startsWith("board-review:escalation:") && state.unhandledEscalations === 0;
}

type BoardReferentLookup = { kind: "live" } | { kind: "resolved"; referentId: string } | { kind: "unreadable" };

/** W1-T2460: parse the referent out of a legacy board-review id, which board-review.ts has always spelled
 *  `board-review:<kind>:<id>`. Parse-at-read, not a registry backfill: pure and reversible. FAILS SAFE — any other
 *  shape returns `undefined` and the proposal stays `"live"`. */
function deriveLegacyReferent(proposalId: string): string | undefined {
  return /^board-review:(?:stale|escalation):(.+)$/.exec(proposalId)?.[1];
}

/** Resolve ONE proposal's referent against the batch read, never issuing its own. A proposal neither source names a
 *  referent for is simply `"live"`: this mechanism does not apply to it. */
function resolveBoardReferent(proposal: Proposal, read: BoardReferentRead | undefined): BoardReferentLookup {
  const referentId = proposal.originatingItemId ?? deriveLegacyReferent(proposal.id);
  if (!referentId) return { kind: "live" };
  if (!read || read.kind === "unreadable") return { kind: "unreadable" };
  const state = read.states.get(referentId);
  if (!state) return { kind: "unreadable" };
  const referentResolved = boardReferentResolved(proposal, state);
  return referentResolved ? { kind: "resolved", referentId } : { kind: "live" };
}

// ── Drafted candidate (the LLM's output — a value from here on, never re-invoked) ─────────

/** The Architect's draft for one proposal: a `plan/tasks.yaml` fragment + the MASTER-PLAN.md ratification stamp line,
 *  cached STATE-SIDE (never committed — `<config.root>/state/inbox-drafts.json`, never a repo path). */
export interface DraftedCandidate {
  proposalId: string;
  /** YAML text of the new task(s), parseable by {@link "./plan.js".loadPlanFromYaml}. */
  fragmentYaml: string;
  /** The MASTER-PLAN.md proposal-list stamp line the approve rung (W1-T111) will use. */
  stampLine: string;
  /** {@link anchorFingerprint} of the proposal's evidence anchors AT DRAFT TIME — the cache key the next inbox pass
   *  compares against to decide whether the cached draft is still current or must be re-drafted. */
  anchorFingerprint: string;
}

/** Order-independent digest of an anchor set — the draft cache's invalidation key. Plain string composition, not
 *  crypto: it only needs to detect that the anchor SET changed. */
export function anchorFingerprint(anchors: EvidenceAnchor[]): string {
  return anchors
    .map((a) => `${a.pattern}::${a.path ?? ""}`)
    .sort()
    .join("|");
}

/** True when a cached draft was computed against a different anchor set than the proposal's current one. Orthogonal
 *  to whether each anchor is still grep-true; a fixture that moves an anchor usually flips both. */
export function isDraftStale(draft: DraftedCandidate, currentAnchors: EvidenceAnchor[]): boolean {
  return draft.anchorFingerprint !== anchorFingerprint(currentAnchors);
}

// ── The draft rung's "needs a draft" predicate (W1-T192) ──────────────────────────────────
//
// `rmd inbox` and the daemon poll rung share this ONE predicate rather than re-deriving it and disagreeing.

/** Every proposal needing a fresh draft. Takes no throttle input by design — this is the unthrottled predicate behind
 *  `rmd inbox`'s manual force, which {@link draftsDueOnDaemon} wraps. */
export function proposalsNeedingDraft(proposals: Proposal[], drafts: DraftCache): Proposal[] {
  return proposals.filter((p) => {
    if (p.trigger && !p.trigger.fired) return false; // never drafted for a dead-consumer proposal
    const cached = drafts[p.id];
    return !cached || isDraftStale(cached, p.evidenceAnchors);
  });
}

// ── Daemon-side idempotence (W1-T192) ──────────────────────────────────────────────────────
//
// One invalidation must produce ONE draft attempt, not one per unattended poll. {@link draftAttemptKey} is the stable
// cause fingerprint; {@link DraftAttemptCache} records the key last attempted, win or lose, so a failed attempt is
// not repeated either.

/** A proposal's current draft-cause fingerprint: its evidence-anchor set plus its reframe-round count. It changes
 *  exactly when a genuinely different draft becomes worth attempting, never on poll count alone. */
export function draftAttemptKey(proposal: Proposal): string {
  return `${anchorFingerprint(proposal.evidenceAnchors)}::${(proposal.reframeHistory ?? []).length}`;
}

/** `<config.root>/state/inbox-draft-attempts.json` — one {@link draftAttemptKey} per proposal id, recording the cause
 *  the daemon rung last attempted. Daemon-only: `rmd inbox`'s manual force never reads or writes it. */
export interface DraftAttemptCache {
  [proposalId: string]: string;
}

/** Parse a {@link DraftAttemptCache}; `{}` on missing or malformed input, since a daemon that has never attempted a
 *  draft is the normal pre-population state, not an error. */
export function parseDraftAttemptCache(text: string | undefined): DraftAttemptCache {
  if (!text) return {};
  try {
    const raw = JSON.parse(text) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    return raw as DraftAttemptCache;
  } catch {
    return {};
  }
}

/**
 * W1-T2561: the MOST proposals one daemon poll may spawn an Architect for.
 *
 * THE INVARIANT. {@link DraftAttemptCache} bounds REPETITION — one attempt per cause — and says nothing about how
 * many DISTINCT proposals may draft at once, which `routeFollowupsToRegistry` (lib/retro.ts) made unbounded. THE
 * TRAP: a headroom gate would have bounded nothing, because the rung is what DRIVES the account to exhaustion while
 * the governor still reads healthy. A CAP DELAYS WORK, NEVER DROPS IT: no key is written for a proposal that was not
 * attempted. PRIMARY CONTROL, not a fallback. DIRECTIVE: keep that upper-case tag here — `KIND_TAG_RE`
 * (test/bound-kind-declared.test.ts) reads this block. Why: docs/forensics/inbox.md.
 */
// W1-T2569 correction: a per-batch SIZE, never a concurrency limit; the "300s poll cadence" this file used to cite
// was wrong. Why: the measured batch duration and rung cadence — docs/forensics/inbox.md.
export const DAEMON_DRAFT_BATCH_CAP = 3;

/** Proposals the DAEMON-SIDE rung should attempt this poll — {@link proposalsNeedingDraft} throttled so the same
 *  cause is never re-spawned. `rmd inbox` skips this, which is what makes it a force. */
export function draftsDueOnDaemon(
  proposals: Proposal[],
  drafts: DraftCache,
  attempts: DraftAttemptCache,
  cap: number = DAEMON_DRAFT_BATCH_CAP,
): Proposal[] {
  const due = proposalsNeedingDraft(proposals, drafts).filter((p) => attempts[p.id] !== draftAttemptKey(p));
  return cap > 0 ? due.slice(0, cap) : due;
}

/**
 * W1-T2564 MIGRATION: re-open every attempt key that never produced a draft. Not writing a key for a refusal fixes
 * the write path forward and repairs nothing on disk, because `draftsDueOnDaemon` compares against a routed
 * follow-up's key of literal `::0` and that is false forever.
 *
 * ⚠ THE PREDICATE IS "keyed, live, no cached draft" — not refusal-specific, because a refusal leaves its evidence in
 * the ledger, not in either cache, so genuine failures W1-T192 throttled get one more attempt each. ⚠ CALLED PER POLL
 * IT IS AN UNBOUNDED RETRY LOOP that evicts the key W1-T192 just wrote; once per daemon start it is one extra attempt
 * per boot. Falsifier: the per-poll form reddened test/run-task.test.ts's "an ORDINARY failure still writes its
 * attempt key". Why: the 353/267 measurement — docs/forensics/inbox.md.
 */
export function evictRefusalPoisonedKeys(
  attempts: DraftAttemptCache,
  drafts: DraftCache,
  liveProposalIds: ReadonlySet<string>,
  /** W1-T2566 — ids this host has ALREADY re-opened. An EXCLUSION, not a change to the predicate: it makes an id
   *  re-opened at most once ever rather than once per boot. Defaults to empty. */
  alreadyReopened: ReadonlySet<string> = new Set(),
): string[] {
  const freed: string[] = [];
  for (const id of Object.keys(attempts)) {
    if (!liveProposalIds.has(id)) continue;
    if (drafts[id]) continue;
    // W1-T2566: a repeatedly failing proposal never acquires a cached draft, so it satisfies the predicate every boot
    // and a closure flag cannot see across the restart that resets it.
    if (alreadyReopened.has(id)) continue;
    delete attempts[id];
    freed.push(id);
  }
  return freed;
}

/**
 * W1-T2569: merge this batch's results onto the caches AS THEY ARE ON DISK NOW, not onto the snapshot the batch read
 * when it started. THE INVARIANT is independent of the re-entrancy guard: `buildInboxDraftHook` writes `{...drafts,
 * ...mine}` at the bottom of a batch, so any overlap silently drops the earlier writer's work. Precedence is this
 * batch's own results, the fresher observation. Why: the frozen 62-entry cache this closed — docs/forensics/inbox.md.
 */
export function mergeDraftCaches(
  onDisk: { drafts: DraftCache; attempts: DraftAttemptCache },
  mine: { drafts: DraftCache; attempts: DraftAttemptCache },
): { drafts: DraftCache; attempts: DraftAttemptCache } {
  return {
    drafts: { ...onDisk.drafts, ...mine.drafts },
    attempts: { ...onDisk.attempts, ...mine.attempts },
  };
}

/**
 * W1-T2590: `state/inbox-draft-deferred-until.json` — the instant the account itself said its window reopens, after a
 * draft was refused for a usage or session limit. A refusal now writes no attempt key and retries next poll
 * (W1-T2564), which made {@link DAEMON_DRAFT_BATCH_CAP} the only limit on a retry storm during an outage.
 *
 * ⚠ AN ABSENT RESET IS NOT A LICENCE TO DEFER FOREVER, and it is common enough: `resetsAtMs` is present only when the
 * refusal stated a time with an explicit UTC marker, because guessing the operator's zone gives a confident wrong
 * resume time, so {@link decideDraftDeferral} must then decline to defer. Why: the 494 refusals in seven hours —
 * docs/forensics/inbox.md.
 */
export interface DraftDeferralCache {
  /** Epoch ms the provider said its window reopens. */
  deferredUntilMs: number;
  /** The refusal text that produced it — evidence, never re-derived. */
  matched: string;
}

/** Parse a {@link DraftDeferralCache}; `undefined` on missing or malformed input. A corrupt file must never wedge the
 *  rung shut, which is the failure direction that costs the most. */
export function parseDraftDeferralCache(text: string | undefined): DraftDeferralCache | undefined {
  if (!text) return undefined;
  try {
    const raw = JSON.parse(text) as Partial<DraftDeferralCache>;
    if (typeof raw?.deferredUntilMs !== "number" || !Number.isFinite(raw.deferredUntilMs)) return undefined;
    return { deferredUntilMs: raw.deferredUntilMs, matched: typeof raw.matched === "string" ? raw.matched : "" };
  } catch {
    // Fail-soft to nothing, by contract: absent and malformed are ONE answer to every caller, so the parse cause is
    // deliberately not carried out of here.
    return undefined;
  }
}

/** Should this poll's draft batch run, or is the account's stated window still shut? PURE, so the decision is a unit
 *  fixture rather than a clock race, and it returns the remaining wait so the caller can ledger a number.
 *  SELF-LIMITING BY CONSTRUCTION — an INSTANT, not a latch, so the W1-T1067 stranded-marker failure mode has nothing
 *  here to strand. */
export function decideDraftDeferral(
  cache: DraftDeferralCache | undefined,
  nowMs: number,
): { defer: false } | { defer: true; untilMs: number; remainingMs: number; matched: string } {
  if (!cache) return { defer: false };
  if (nowMs >= cache.deferredUntilMs) return { defer: false };
  return {
    defer: true,
    untilMs: cache.deferredUntilMs,
    remainingMs: cache.deferredUntilMs - nowMs,
    matched: cache.matched,
  };
}

/** The deferral a batch's outcomes justify. THE LATEST STATED RESET WINS: the earlier of two would resume into a shut
 *  door. ⚠ A refusal with no stated instant contributes nothing. */
export function deferralFromOutcomes(outcomes: DraftRungOutcome[]): DraftDeferralCache | undefined {
  let best: DraftDeferralCache | undefined;
  for (const o of outcomes) {
    if (o.ok || !o.refused) continue;
    const at = o.refused.resetsAtMs;
    if (typeof at !== "number" || !Number.isFinite(at)) continue;
    if (!best || at > best.deferredUntilMs) best = { deferredUntilMs: at, matched: o.refused.matched };
  }
  return best;
}

/** `state/inbox-draft-inflight.json` — spawn timestamps for drafts an Architect is running now (W1-T193). Cleared in
 *  a `finally`, so only a crash mid-draft leaves a stale entry. */
export interface DraftInFlightCache {
  [proposalId: string]: string;
}

/** Parse a {@link DraftInFlightCache} JSON blob; `{}` on missing/malformed input (mirrors {@link
 *  parseDraftAttemptCache}'s fail-soft-to-empty discipline). */
export function parseDraftInFlightCache(text: string | undefined): DraftInFlightCache {
  if (!text) return {};
  try {
    const raw = JSON.parse(text) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    return raw as DraftInFlightCache;
  } catch {
    return {};
  }
}

// ── The readiness predicate (rule 2, policy-as-data) ───────────────────────────────────────

export type FailingPredicate = "drafted" | "deps_merged" | "deps_observable" | "evidence_anchors" | "lint_clean" | "no_conflict";

export interface PredicateFailure {
  predicate: FailingPredicate;
  detail: string;
}

export type InboxState = "ready" | "not_ready" | "deferred_with_trigger" | "ratified" | "drafting" | "retired" | "declined";

export interface InboxClassification {
  proposalId: string;
  state: InboxState;
  /** Empty iff state === "ready". Every failing AND-clause, named — never a bare "not ready". */
  reasons: PredicateFailure[];
  /** Present iff state === "deferred_with_trigger". */
  trigger?: ProposalTrigger;
  /** Present iff a draft exists at all (whether or not it is the reason for not-ready). */
  draftStale?: boolean;
  /** Present iff state === "ready" — the reasoning rides with the recommendation. */
  draft?: DraftedCandidate;
  /** Present iff state === "drafting" — when the in-flight Architect worker for this proposal's draft was spawned
   *  (W1-T193's "never renders nothing during a legitimate multi-minute mid-draft window" bar). */
  draftSpawnedAt?: string;
  /** W1-T2451: present iff state === "retired" — why the referent resolved, so an operator sees the finding existed
   *  and why it went moot. Retirement is a state, never a deletion. */
  retiredReason?: string;
  /** W1-T2604: present iff state === "declined" — the operator's own reason, never inferred from the proposal's
   *  prose. Like retirement, a state and never a deletion. */
  declinedReason?: string;
  /** W1-T2451: true iff this proposal's referent could not be read this pass. `state` is otherwise computed as if
   *  referent tracking did not exist — cannot-observe means WAIT (W1-T130). */
  referentUnverified?: boolean;
}

export interface ReadinessContext {
  /** The CURRENT plan (plan/tasks.yaml on main) the drafted tasks would land into — resolves depends_on ids the
   *  fragment cites that already exist. */
  plan: Plan;
  /** Landed-ness resolver — GITHUB-DERIVED (deriveStatus) in the real runner, a plain yaml-status check in fixtures. */
  isMerged: MergedResolver;
  /** Whether one evidence anchor is still grep-true (on main, in the real runner). */
  grepAnchorTrue: (anchor: EvidenceAnchor) => boolean;
  /** Every OTHER proposal id currently open (not yet ratified) — the conflict source. */
  openProposalIds: Set<string>;
  /** True when the ledger already carries `ratify.approved` for this id — checked FIRST and overriding the registry's
   *  copy (W1-T190), which a crash between the two writes can leave stale. */
  isRatified: (proposalId: string) => boolean;
  /** W1-T2604: the reason a `panel.proposal_declined` ledger line records. ⚠ NEVER inferred from the proposal's own
   *  prose — a keyword rule would let a worker retire its own proposal by phrasing. */
  isDeclined?: (proposalId: string) => string | undefined;
  /** W1-T2451: the ONE batched read of every referent's state this pass. Optional; omitting it makes such a proposal
   *  unreadable rather than live, so a forgetful caller never false-retires one. */
  boardReferents?: BoardReferentRead;
  /** Present iff the daemon's rung currently has an Architect drafting this proposal (W1-T193) — the ISO spawn
   *  timestamp. Derived from {@link DraftInFlightCache}; optional. */
  draftSpawnedAt?: (proposalId: string) => string | undefined;
  /** W1-T510: the readiness predicate's THIRD value for a dependency's landed-ness, since `isMerged` cannot tell
   *  "read, and not merged" from "never actually read". THE INVARIANT: an unobservable id is never folded into
   *  `deps_merged` and surfaces as `deps_observable`. THE POLARITY DOES NOT FLIP — it still keeps the proposal out of
   *  READY (W1-T130). Only what is SAID changes. */
  depsUnobservable?: (taskId: string) => GhFailureReason | undefined;
}

/** The ledger's answer to "has this proposal already been ratified?". Re-derived on every read rather than trusted
 *  from a stored flag, so a drifted entry heals with no migration (W1-T190). */
export function isRatifiedInLedger(ledgerLines: { step?: unknown; task_id?: unknown }[], proposalId: string): boolean {
  return ledgerLines.some((l) => l.step === "ratify.approved" && l.task_id === proposalId);
}

/** W1-T2604: the ledger's answer to "has an operator declined this, and why?". `POST /v1/inbox/decline` appends one
 *  line carrying the reason verbatim; the latest wins. */
export function declinedReasonInLedger(
  ledgerLines: { step?: unknown; task_id?: unknown; reason?: unknown }[],
  proposalId: string,
): string | undefined {
  let reason: string | undefined;
  for (const l of ledgerLines) {
    if (l.step !== "panel.proposal_declined" || l.task_id !== proposalId) continue;
    reason = typeof l.reason === "string" ? l.reason : "declined by an operator";
  }
  return reason;
}

/**
 * THE ONE PLACE an approve run's `run_id` becomes a GIT REF NAME (and a worktree directory name). Sanitising happens
 * HERE and NEVER on the proposal id, which is a registry key and a `task_id` on every ledger row the proposal wrote,
 * so rewriting it would orphan both.
 *
 * THE TRAP IT CLOSES. A COLON IS ILLEGAL IN A GIT REF, and board-review.ts mints ids like
 * `board-review:escalation:#3039`, so the worktree add died and no proposal had ever been ratified. Three minted
 * shapes carry a colon while `FD-…` and `P<N>` are legal, so the transform below is TOTAL. INJECTIVITY rests entirely
 * on the 12-hex SHA-256 prefix of the ORIGINAL `runId`, appended UNCONDITIONALLY, because the readable half is lossy.
 * Why: the measured ledger evidence — docs/forensics/inbox.md.
 */
export function approveRunBranch(runId: string): string {
  const slug = runId
    // Whitelist. Every byte git forbids in a ref (space, control chars, and ~^:?*[\ ) plus "/" and "@" falls outside
    // it, so one rule covers them all rather than a list that can rot.
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/\.{2,}/g, "-") // git forbids ".." anywhere in a ref name
    .replace(/-{2,}/g, "-") // collapse runs, so the appended digest's own "-" stays a boundary
    .replace(/^[-.]+|[-.]+$/g, ""); // no leading "-"/"." and no trailing "." for git's own rules
  // The digest closes the ".lock" tail rule too: the ref can never END in ".lock" with 12 hex characters after it.
  const digest = createHash("sha256").update(runId).digest("hex").slice(0, 12);
  return `run-${slug || "approve"}-${digest}`;
}

/** W1-T903: the branch a PRIOR `rmd approve` run would have pushed, derived purely from ledger evidence — run ids are
 *  `APPROVE-<proposalId>-<ms>` and the gateway pushes `run-<run_id>`. EVIDENCE ONLY: confirming it was pushed is the
 *  caller's job. Taking the most recent match is safe, because this is reachable only when the ledger lacks
 *  `ratify.approved`. */
export function priorApproveRunBranch(ledgerLines: { run_id?: unknown; task_id?: unknown }[], proposalId: string): string | undefined {
  const prefix = `APPROVE-${proposalId}-`;
  let best: string | undefined;
  for (const line of ledgerLines) {
    const runId = line.run_id;
    if (typeof runId !== "string" || line.task_id !== proposalId) continue;
    if (!runId.startsWith(prefix)) continue;
    if (!/^\d+$/.test(runId.slice(prefix.length))) continue;
    if (best === undefined || runId > best) best = runId;
  }
  return best === undefined ? undefined : approveRunBranch(best);
}

/** Parse a fragment's tasks WITHOUT requiring every `depends_on` to resolve inside it — {@link unmetOutsideDeps}
 *  checks that separately. A schema problem is draft-unclean, not a crash. */
function safeParseFragment(fragmentYaml: string, proposalId: string): { plan: Plan } | { error: string } {
  try {
    const tasks = parseTasksFromYaml(fragmentYaml, `inbox draft ${proposalId}`);
    return { plan: { tasks, byId: new Map(tasks.map((t) => [t.id, t])) } };
  } catch (e) {
    return { error: e instanceof PlanError ? e.message : String(e) };
  }
}

/** Merge a drafted fragment's tasks into the base plan — later (fragment) entries win, so a fragment task with the
 *  same id as an existing one shadows it for dep resolution. */
function mergedPlan(base: Plan, fragment: Plan): Plan {
  const byId = new Map(base.byId);
  for (const t of fragment.tasks) byId.set(t.id, t);
  return { tasks: [...byId.values()], byId };
}

/** One dependency `unmetOutsideDeps` found INDETERMINATE rather than genuinely unmerged — `pair` mirrors the plain
 *  `task->dep` shape the `deps_merged` predicate's own list uses. */
interface UnobservableDep {
  pair: string;
  depId: string;
  reason: GhFailureReason;
}

/** Dependency ids a fragment names OUTSIDE itself that are not yet merged; a SIBLING dep is exempt, since both land
 *  in one plan PR. W1-T510: an INDETERMINATE read reports the same `false` as a genuinely unmerged dep, so any dep
 *  `depsUnobservable` names is split into `unobservable`, NEVER `unmet` — never claim "not merged" about a dependency
 *  nobody read. */
function unmetOutsideDeps(
  basePlan: Plan,
  fragmentPlan: Plan,
  isMerged: MergedResolver,
  depsUnobservable?: (taskId: string) => GhFailureReason | undefined,
): { unmet: string[]; unobservable: UnobservableDep[] } {
  const fragmentIds = new Set(fragmentPlan.tasks.map((t) => t.id));
  const merged = mergedPlan(basePlan, fragmentPlan);
  const unmet: string[] = [];
  const unobservable: UnobservableDep[] = [];
  for (const task of fragmentPlan.tasks) {
    for (const dep of unmetDependencies(merged, task, isMerged)) {
      if (fragmentIds.has(dep)) continue;
      const pair = `${task.id}->${dep}`;
      const reason = depsUnobservable?.(dep);
      if (reason) unobservable.push({ pair, depId: dep, reason });
      else unmet.push(pair);
    }
  }
  return { unmet, unobservable };
}

function blockingLintMessages(basePlan: Plan, fragmentPlan: Plan): string[] {
  const merged = mergedPlan(basePlan, fragmentPlan);
  const results = lintPlan(merged, () => ({}));
  const out: string[] = [];
  for (const task of fragmentPlan.tasks) {
    const violations = results.get(task.id)?.violations ?? [];
    for (const v of violations.filter((x) => x.severity === "block")) out.push(`${task.id}: [${v.check}] ${v.message}`);
  }
  return out;
}

/** The PURE readiness predicate. Trigger-deferral is checked first and unconditionally: an unfired trigger means
 *  DEFERRED_WITH_TRIGGER whatever the other clauses say (the dead-consumer discipline). Every other branch collects
 *  EVERY failing predicate, never the first. */
export function classifyProposal(
  proposal: Proposal,
  draft: DraftedCandidate | undefined,
  ctx: ReadinessContext,
): InboxClassification {
  // W1-T190: the ledger's ratify.approved receipt is checked FIRST and overrides every predicate below. This heals an
  // existing drifted entry, because it never trusts a stored flag at all.
  if (ctx.isRatified(proposal.id)) {
    return { proposalId: proposal.id, state: "ratified", reasons: [] };
  }
  // W1-T2604: an operator's decline is checked next and overrides everything below. It is recorded ONCE by an
  // explicit operator act, never inferred here from prose a worker wrote.
  const declinedReason = ctx.isDeclined?.(proposal.id);
  if (declinedReason !== undefined) {
    return { proposalId: proposal.id, state: "declined", reasons: [], declinedReason };
  }
  // W1-T2451: RESOLVED is a terminal override — such a proposal has no live referent to be ABOUT. UNREADABLE never
  // short-circuits: it only sets a flag, so a failed read never blocks a READY.
  const referent = resolveBoardReferent(proposal, ctx.boardReferents);
  if (referent.kind === "resolved") {
    return {
      proposalId: proposal.id,
      state: "retired",
      reasons: [],
      retiredReason:
        `${proposal.id}'s referent (${referent.referentId}) has resolved — merged, dead, or its ` +
        `escalation handled — so this proposal can never render READY again; it stays in the registry ` +
        `as a record of the finding, never deleted`,
    };
  }
  const referentUnverified = referent.kind === "unreadable" ? { referentUnverified: true as const } : {};
  // W1-T193: an Architect currently drafting is checked before the ordinary predicates, since a proposal mid-draft
  // for minutes must never render "not ready" — indistinguishable from broken.
  const draftSpawnedAt = ctx.draftSpawnedAt?.(proposal.id);
  if (draftSpawnedAt) {
    return { proposalId: proposal.id, state: "drafting", reasons: [], draftSpawnedAt, ...referentUnverified };
  }
  if (proposal.trigger && !proposal.trigger.fired) {
    return {
      proposalId: proposal.id,
      state: "deferred_with_trigger",
      // No AND-clause reasons: the trigger gate is checked BEFORE those four and short-circuits. {@link
      // ProposalTrigger} names the unfired condition, which is the whole reason.
      reasons: [],
      trigger: proposal.trigger,
      ...referentUnverified,
    };
  }

  const reasons: PredicateFailure[] = [];

  if (!draft) {
    reasons.push({ predicate: "drafted", detail: "not-drafted: no drafted candidate available yet" });
    return { proposalId: proposal.id, state: "not_ready", reasons, ...referentUnverified };
  }

  const draftStale = isDraftStale(draft, proposal.evidenceAnchors);

  const fragment = safeParseFragment(draft.fragmentYaml, proposal.id);
  if ("error" in fragment) {
    reasons.push({ predicate: "lint_clean", detail: `draft-unclean: fragment failed to parse — ${fragment.error}` });
  } else {
    const { unmet, unobservable } = unmetOutsideDeps(ctx.plan, fragment.plan, ctx.isMerged, ctx.depsUnobservable);
    if (unmet.length > 0) {
      reasons.push({ predicate: "deps_merged", detail: `dep-unmet: ${unmet.join(", ")} not merged` });
    }
    // W1-T510: an unobservable dep is never folded into `dep-unmet` — it names the classified reason instead of
    // accusing an unread dependency. Still an AND-clause failure, just an honest one.
    if (unobservable.length > 0) {
      const detail = unobservable.map((u) => `${u.depId} (${u.reason})`).join(", ");
      reasons.push({
        predicate: "deps_observable",
        detail: `deps-unobservable: ${detail} — GitHub could not be read, this is not a claim that it is unmerged`,
      });
    }
    const blocking = blockingLintMessages(ctx.plan, fragment.plan);
    if (blocking.length > 0) {
      reasons.push({ predicate: "lint_clean", detail: `draft-unclean: lint-plan violation(s) — ${blocking.join("; ")}` });
    }
  }

  const driftedAnchors = proposal.evidenceAnchors.filter((a) => !ctx.grepAnchorTrue(a));
  if (driftedAnchors.length > 0 || draftStale) {
    const anchorNote = driftedAnchors.length > 0 ? driftedAnchors.map((a) => a.description).join(", ") : "cached draft's anchor set is stale";
    reasons.push({ predicate: "evidence_anchors", detail: `evidence-drifted: ${anchorNote}` });
  }

  const openConflicts = (proposal.conflictsWith ?? []).filter((id) => ctx.openProposalIds.has(id));
  if (openConflicts.length > 0) {
    reasons.push({ predicate: "no_conflict", detail: `conflict: open proposal(s) ${openConflicts.join(", ")} conflict with this one` });
  }

  if (reasons.length === 0) {
    return { proposalId: proposal.id, state: "ready", reasons: [], draftStale, draft, ...referentUnverified };
  }
  return { proposalId: proposal.id, state: "not_ready", reasons, draftStale, ...referentUnverified };
}

// ── The draft rung: pure prompt + parser (LLM call is harness-owned, run-task.ts) ─────────

/** The bounded Architect worker's prompt for ONE proposal — a fragment plus the stamp line, nothing else. The worker
 *  has Read/Grep/Glob only, enforced by {@link INBOX_DRAFT_DISALLOWED_TOOLS}. */
const SCOPE_HINT = "files: — the repo-relative paths this task will touch";

/**
 * W1-T2591 — the tools the draft prompt already claims this rung does not have, now enforced.
 *
 * THE TRAP. That prompt sentence was the only thing between a draft worker and the checkout, and after #3588
 * parallelised `runDraftRung` it stopped being enough: one worktree per batch is now shared by up to {@link
 * DAEMON_DRAFT_BATCH_CAP} lanes, and worker HOMES are isolated while the cwd is not. The rung needs none of these
 * tools, so enforcement is cheaper than per-lane worktrees, which would multiply checkout disk by the cap on a host
 * that hit 100% full (W1-T2585). Why: the measured settings/worker.json permissions — docs/forensics/inbox.md.
 */
export const INBOX_DRAFT_DISALLOWED_TOOLS: readonly string[] = ["Write", "Edit", "NotebookEdit", "Bash"];

export function inboxDraftPrompt(proposal: Proposal, currentPlanText: string, runId: string): string {
  // W1-T194: retraction is STRUCTURAL — a retracted round is omitted entirely, never summarised. Numbering stays
  // POSITIONAL against the FULL history, so "round N" always means the same round.
  const history = proposal.reframeHistory ?? [];
  const numbered = history.map((round, i) => ({ round, n: i + 1 }));
  const survivors = numbered.filter(({ round }) => !round.retracted);
  const retractedRounds = numbered.filter(({ round }) => round.retracted).map(({ n }) => n);
  const feedbackBlock: string[] =
    survivors.length === 0 && retractedRounds.length === 0
      ? []
      : [
          "=== OPERATOR FEEDBACK (rmd reframe, P25 iii — address EVERY round below in this redraft) ===",
          ...survivors.map(({ round, n }) => `${n}. ${round.feedback}`),
          ...(retractedRounds.length > 0
            ? [
                `(round${retractedRounds.length > 1 ? "s" : ""} ${retractedRounds.join(", ")} retracted by the ` +
                  "operator — omitted above; preserved in reframeHistory, never redrafted against)",
              ]
            : []),
          "",
        ];

  return [
    "You are the REMUDERO ARCHITECT drafting a RATIFICATION CANDIDATE for one open plan proposal",
    "(MASTER-PLAN §7/P25). You ride a HIGHER tier than implement workers (G-17). You have NO",
    "Write/Edit/Bash tools — you cannot touch a file or run git. Your job ends when you have",
    "printed the fragment + stamp below; the harness caches it and never commits it on your say-so.",
    "",
    "=== THE PROPOSAL ===",
    `id: ${proposal.id}`,
    proposal.summary,
    "",
    ...feedbackBlock,
    "=== GROUND ===",
    "Grep/Read MASTER-PLAN.md, LEARNINGS.md, and DECISIONS.md for what is already decided; the",
    "current plan/tasks.yaml is pasted below so you cite REAL existing task ids in depends_on.",
    "",
    "=== plan/tasks.yaml (current, for depends_on grounding) ===",
    currentPlanText,
    "",
    "=== TASK IDS — PLACEHOLDERS ONLY, never a real W1-Tnnn id (feedback#fb-1784766965325-c7b673) ===",
    "Every task you draft gets its `id:` from a PLACEHOLDER, not a guess: NEW-1, NEW-2, NEW-3, ...",
    "numbered in the order the tasks appear in your fragment. `rmd approve` mints and reserves the",
    "real ids for you when the operator approves — picking one yourself risks colliding with",
    "another proposal drafted in the same window. If a drafted task's depends_on points at ANOTHER",
    "task inside THIS SAME fragment, cite that task's placeholder (e.g. `depends_on: [NEW-1]`) —",
    "never a guessed real id. A depends_on on an EXISTING task already in plan/tasks.yaml above",
    "stays that task's real W1-T id, unchanged. Use the SAME NEW-<n> placeholders in the stamp",
    "line's task-id list below; `rmd approve` rewrites every placeholder to its real id together.",
    "",
    "=== OUTPUT (exactly this shape, nothing else) ===",
    "Print ONE or more new tasks.yaml entries (schema v1 — id/title/repo/depends_on/type/verify/",
    "risk/status/attempts/acceptance/origin/files at minimum) between the two FRAGMENT markers below,",
    // W1-T509-adjacent, W1-T512: an absent or empty `files:` is fail-closed at dispatch — `overlappingPaths` reports
    // it as overlapping every candidate, so it can never batch.
    "then ONE stamp line for MASTER-PLAN.md's proposal list between the two markers below that —",
    "the same shape as an existing RATIFIED stamp (`- P## (...) — RATIFIED <date> -> <task ids>.`),",
    "with the task-id list written as the placeholders (e.g. `-> NEW-1/NEW-2.`).",
    `Every task MUST declare ${SCOPE_HINT} — never omit it and never leave it empty.`,
    "RAW YAML ONLY between the FRAGMENT markers — do NOT wrap it in a markdown code fence",
    "(no ```yaml or ``` line before or after it); the harness parses the fragment as YAML",
    "verbatim, and a fence around it fails that parse.",
    "",
    "=== FRAGMENT START ===",
    "<the new tasks.yaml entries as YAML — a list of task mappings>",
    "=== FRAGMENT END ===",
    "STAMP: <the one-line ratification stamp>",
    "",
    `(run: ${runId})`,
  ].join("\n");
}

export interface ParsedDraft {
  fragmentYaml: string;
  stampLine: string;
}

const FRAGMENT_RE = /=== FRAGMENT START ===\r?\n([\s\S]*?)\r?\n=== FRAGMENT END ===/g;
const STAMP_RE = /^[ \t]*STAMP:[ \t]*(.+)$/gim;
const FENCE_LINE_RE = /^```[A-Za-z0-9_+-]*[ \t]*$/;

/**
 * Strip a markdown code fence wrapping an Architect-drafted fragment, so a FENCED draft parses as plain YAML instead
 * of falsely failing the `lint_clean` predicate (W1-T173). A NO-OP when the fragment is not fenced. FAILS LOUD
 * ({@link PlanError}) on a malformed fence rather than guessing where the content ends, because a silent partial
 * strip could truncate real tasks unseen. Why: the P19 inaugural ratification this rejected —
 * docs/forensics/inbox.md.
 */
export function stripMarkdownFence(fragmentYaml: string): string {
  const lines = fragmentYaml.split(/\r?\n/);
  // An Architect's fragment may have incidental leading/trailing blank lines around the fence itself — only the
  // first/last NON-blank line counts as a candidate fence marker.
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") start++;
  let end = lines.length - 1;
  while (end >= 0 && lines[end].trim() === "") end--;
  if (start > end) return fragmentYaml; // all-blank: nothing to strip, nothing to parse either

  if (!FENCE_LINE_RE.test(lines[start].trim())) return fragmentYaml; // no opening fence at all

  const closeIsFence = start !== end && lines[end].trim() === "```";
  if (!closeIsFence) {
    throw new PlanError("draft fragment has an opening ``` fence with no matching closing ``` — refusing to guess where it ends");
  }
  // A stray standalone ``` line strictly BETWEEN open and close is a malformed/nested fence — fail loud rather than
  // silently picking the first/last markers and truncating content.
  for (let i = start + 1; i < end; i++) {
    if (FENCE_LINE_RE.test(lines[i].trim())) {
      throw new PlanError(`draft fragment has a stray \`\`\` fence marker mid-document at line ${i + 1} — refusing to guess where it ends`);
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

/** Extract the worker's FRAGMENT and STAMP off its concatenated output. LAST-marker-wins, like `parseTriageVerdict`.
 *  `null` when either marker is missing — a malformed draft is never silently treated as a candidate. The fragment
 *  runs through {@link stripMarkdownFence} first; a malformed fence throws, which {@link runDraftRung} isolates. */
export function parseDraftedCandidate(text: string): ParsedDraft | null {
  const fragments = [...text.matchAll(FRAGMENT_RE)];
  const stamps = [...text.matchAll(STAMP_RE)];
  if (fragments.length === 0 || stamps.length === 0) return null;
  return {
    fragmentYaml: stripMarkdownFence(fragments[fragments.length - 1][1].trim()),
    stampLine: stamps[stamps.length - 1][1].trim(),
  };
}

// ── The draft rung's INJECTABLE orchestration core (W1-T192) ─────────────────────────────
//
// One Architect spawn per proposal stays the harness's job. WHICH proposals get attempted, and whether one failure
// strands the batch, is the pure-core split this module's header describes. `deps.spawn` is the ONE injected side
// effect, so the CLI and the daemon ride the SAME loop.

/** One Architect worker call for one proposal's draft prompt; tests inject a fake. Returns the full {@link
 *  WorkerResult} so {@link runDraftRung} logs the same `workerLedgerFields` as every spawn. */
export type DraftSpawn = (proposal: Proposal, prompt: string) => Promise<WorkerResult>;

export interface DraftRungDeps {
  spawn: DraftSpawn;
  log: (step: string, extra?: Record<string, unknown>) => void;
}

/** One proposal's draft-rung outcome — `ok: true` carries the candidate to cache; `ok: false` names why, whether
 *  malformed output or a spawn-level exception, without ever throwing. */
export type DraftRungOutcome =
  | { proposalId: string; ok: true; candidate: DraftedCandidate }
  /** W1-T2564: `refused` marks a run the ACCOUNT turned away, as distinct from a run that happened and failed. That
   *  decides whether a {@link DraftAttemptCache} key is written, and keying a refusal retires work that never ran.
   *  Why: the 267-of-353 measurement — docs/forensics/inbox.md. */
  | { proposalId: string; ok: false; error: string; refused?: { matched: string; resetsAtMs?: number } };

/** cc71f2: the draft rung's own bounded self-lint — the first attempt is the ordinary draft, and
 *  each further attempt carries the prior fragment's violations, so the Architect never re-rolls
 *  blind and never loops unboundedly. */
// impl-FU: re-exported from lib/relint.ts so triage, plan and inbox share ONE bound.
export const MAX_DRAFT_LINT_ATTEMPTS = MAX_RELINT_ATTEMPTS;

/** Lint a drafted fragment exactly as `rmd lint-plan` would. A fragment that does not parse is itself one block
 *  violation, so it drives a redraft rather than being cached as NOT-READY. */
export function lintDraftedFragment(fragmentYaml: string, proposalId: string): DraftLintViolation[] {
  let tasks;
  try {
    tasks = parseTasksFromYaml(fragmentYaml, `inbox draft ${proposalId}`);
  } catch (e) {
    return [{ check: "draft-parse", severity: "block", message: `fragment failed to parse — fix before re-emitting: ${String((e as Error)?.message ?? e)}` }];
  }
  const violations: DraftLintViolation[] = [];
  for (const task of tasks) {
    for (const v of lintTask(task).violations) if (v.severity === "block") violations.push(v);
  }
  return violations;
}

/** The redraft prompt: the failed fragment + its violations + the Rule-19 resolution doctrine (the #588 merits test),
 *  so the Architect fixes the SPECIFIC failures rather than re-rolling. */
export function inboxDraftRelintPrompt(proposal: Proposal, fragmentYaml: string, violations: DraftLintViolation[]): string {
  return [
    `Your drafted plan fragment for ${proposal.id} FAILED the plan's own linter (rmd lint-plan) and CANNOT be cached as-is. Fix EVERY blocking violation below, then re-emit the COMPLETE corrected fragment + stamp in the same FRAGMENT/STAMP marker format.`,
    "",
    ...relintGuidanceLines(violations),
    "",
    "The fragment you must fix:",
    fragmentYaml,
  ].join("\n");
}

/** Draft EVERY proposal in `toDraft`. Independent proposals run concurrently up to {@link DAEMON_DRAFT_BATCH_CAP};
 *  one proposal's self-lint retries stay serial. NEVER THROWS — each spawn and parse is isolated in its OWN try/catch
 *  (W1-T192's fail-soft requirement), which is what makes this safe on an unattended poll. */
export async function runDraftRung(toDraft: Proposal[], currentPlanText: string, deps: DraftRungDeps, runId: string): Promise<DraftRungOutcome[]> {
  const draftOne = async (proposal: Proposal): Promise<DraftRungOutcome> => {
    try {
      let prompt = inboxDraftPrompt(proposal, currentPlanText, runId);
      let parsed: ReturnType<typeof parseDraftedCandidate> = null;
      let violations: DraftLintViolation[] = [];
      // cc71f2 SELF-LINT: draft, lint, and on a blocking violation redraft with the failures in hand, bounded, so a
      // fired proposal reaches READY without an operator cleanup pass.
      let lastWorker: Awaited<ReturnType<DraftRungDeps["spawn"]>> | undefined;
      for (let attempt = 1; attempt <= MAX_DRAFT_LINT_ATTEMPTS; attempt++) {
        const worker = await deps.spawn(proposal, prompt);
        lastWorker = worker;
        deps.log("inbox.draft_synthesized", {
          proposal_id: proposal.id,
          attempt,
          session_id: worker.sessionId,
          cost_usd: worker.costUsd,
          subtype: worker.subtype,
          ...workerLedgerFields(worker),
        });
        parsed = parseDraftedCandidate([worker.text, worker.blocks.join("\n")].join("\n"));
        if (!parsed) break; // no markers — nothing to lint or usefully retry (handled below)
        violations = lintDraftedFragment(parsed.fragmentYaml, proposal.id);
        if (violations.length === 0) break; // lint-clean — cache it
        if (attempt < MAX_DRAFT_LINT_ATTEMPTS) {
          deps.log("inbox.draft_relint", { proposal_id: proposal.id, attempt, violations: violations.map((v) => v.message) });
          prompt = inboxDraftRelintPrompt(proposal, parsed.fragmentYaml, violations);
        }
      }
      if (!parsed) {
        // W1-T2564: A REFUSED RUN PRODUCES NO OUTPUT, SO IT LANDS HERE LOOKING MALFORMED. The bare error sent every
        // reader toward the prompt; `lastWorker.usageRefusal` re-labels it.
        const refusal = lastWorker?.usageRefusal;
        const error = refusal
          ? `refused by the account before any output: ${refusal.matched}`
          : "no FRAGMENT/STAMP markers in worker output";
        deps.log("inbox.draft_error", {
          proposal_id: proposal.id,
          error,
          ...(refusal
            ? {
                usage_refused: true,
                ...(refusal.resetsAtMs === undefined ? {} : { usage_resets_at: new Date(refusal.resetsAtMs).toISOString() }),
              }
            : {}),
        });
        return {
          proposalId: proposal.id,
          ok: false,
          error,
          ...(refusal
            ? { refused: { matched: refusal.matched, ...(refusal.resetsAtMs === undefined ? {} : { resetsAtMs: refusal.resetsAtMs }) } }
            : {}),
        };
      }
      const candidate: DraftedCandidate = {
        proposalId: proposal.id,
        fragmentYaml: parsed.fragmentYaml,
        stampLine: parsed.stampLine,
        anchorFingerprint: anchorFingerprint(proposal.evidenceAnchors),
      };
      // A still-dirty draft after the bounded retries is cached anyway and surfaces NOT-READY, but the unresolved set
      // is named on the ledger so the retro sees what the rung could not fix.
      deps.log("inbox.drafted", { proposal_id: proposal.id, lint_clean: violations.length === 0, unresolved_violations: violations.map((v) => v.message) });
      return { proposalId: proposal.id, ok: true, candidate };
    } catch (e) {
      const error = String((e as Error)?.message ?? e);
      deps.log("inbox.draft_error", { proposal_id: proposal.id, error });
      return { proposalId: proposal.id, ok: false, error };
    }
  };

  // W1-T2664: the volume cap was also an accidental wall-clock multiplier. A tiny indexed pool makes elapsed time
  // approach the slowest proposal, not their sum. Why: docs/forensics/inbox.md.
  const outcomes = new Array<DraftRungOutcome>(toDraft.length);
  let nextIndex = 0;
  const runLane = async (): Promise<void> => {
    while (nextIndex < toDraft.length) {
      const index = nextIndex++;
      outcomes[index] = await draftOne(toDraft[index]);
    }
  };
  const concurrency = Math.min(DAEMON_DRAFT_BATCH_CAP, toDraft.length);
  await Promise.all(Array.from({ length: concurrency }, () => runLane()));
  return outcomes;
}

// ── Real-world evidence-anchor adapter (git grep, never a network call) ──────────────────

/** REAL {@link ReadinessContext.grepAnchorTrue}. Git grep's exit codes decide: 0 is true, EXACTLY 1 is false, and
 *  anything else is a genuine error and is thrown, never folded into "not true". */
export function gitGrepAnchorTrue(cwd: string, ref: string, anchor: EvidenceAnchor): boolean {
  const args = anchor.path ? ["grep", "-I", "-q", "-e", anchor.pattern, ref, "--", anchor.path] : ["grep", "-I", "-q", "-e", anchor.pattern, ref];
  try {
    execFileSync("git", args, { cwd, stdio: "ignore" });
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { status?: number | null };
    if (err.status === 1) return false;
    throw err;
  }
}

// ── Rendering (design (c): the reasoning rides with the recommendation) ──────────────────

/** Human-readable inbox listing — READY items carry their drafted tasks, every non-ready item names its failing
 *  predicates, and a deferred item is never presented as a recommendation. */
export function renderInbox(classifications: InboxClassification[]): string {
  if (classifications.length === 0) return "rmd inbox: no active proposals.";
  const lines: string[] = [];
  const ready = classifications.filter((c) => c.state === "ready");
  const deferred = classifications.filter((c) => c.state === "deferred_with_trigger");
  const notReady = classifications.filter((c) => c.state === "not_ready");
  const ratified = classifications.filter((c) => c.state === "ratified");
  const drafting = classifications.filter((c) => c.state === "drafting");
  const retired = classifications.filter((c) => c.state === "retired");
  const declined = classifications.filter((c) => c.state === "declined");

  lines.push(
    `rmd inbox: ${ready.length} READY, ${notReady.length} not ready, ${deferred.length} deferred-with-trigger, ` +
      `${drafting.length} drafting, ${ratified.length} already ratified, ${retired.length} retired, ` +
      `${declined.length} declined.`,
  );
  for (const c of ready) {
    lines.push("");
    lines.push(`READY — ${c.proposalId}`);
    // W1-T2461: a READY row with no cached draft used to print two blank fields, which read as a rendering failure.
    // Readiness is untouched — still computed, never read off the draft cache.
    if (c.draft) {
      lines.push(`  stamp: ${c.draft.stampLine}`);
      lines.push(`  drafted tasks:\n${c.draft.fragmentYaml.replace(/^/gm, "    ")}`);
    } else {
      lines.push(`  draft: not cached`);
    }
  }
  // W1-T193: a proposal currently mid-draft is named, with its spawn time — the same
  // never-render-nothing-during-a-legitimate-window bar the console's card carries.
  for (const c of drafting) {
    lines.push("");
    lines.push(`DRAFTING — ${c.proposalId} (spawned ${c.draftSpawnedAt ?? "unknown time"})`);
  }
  for (const c of notReady) {
    lines.push("");
    lines.push(`NOT READY — ${c.proposalId}`);
    for (const r of c.reasons) lines.push(`  [${r.predicate}] ${r.detail}`);
  }
  for (const c of deferred) {
    lines.push("");
    lines.push(`DEFERRED-WITH-TRIGGER — ${c.proposalId} (never recommended)`);
    lines.push(`  trigger: ${c.trigger?.description ?? ""} (fired=${String(c.trigger?.fired ?? false)})`);
  }
  // W1-T190: a ratified proposal is NEVER listed under READY, since offering an affordance `rmd approve` would refuse
  // is the wrong-affordance shape W1-T182 removes elsewhere.
  for (const c of ratified) {
    lines.push("");
    lines.push(`RATIFIED — ${c.proposalId} (already ratified via a prior \`rmd approve\`; no longer active)`);
  }
  // W1-T2451: a proposal whose referent resolved is named here, not silently dropped — retirement is a state, and
  // this is where an operator sees the finding existed and why it went moot.
  for (const c of retired) {
    lines.push("");
    lines.push(`RETIRED — ${c.proposalId} (${c.retiredReason ?? "referent resolved"})`);
  }
  // W1-T2604: a declined proposal is named here too, mirroring RETIRED above — the two "state, never delete"
  // families, each with its own reason field and its own trigger.
  for (const c of declined) {
    lines.push("");
    lines.push(`DECLINED — ${c.proposalId} (${c.declinedReason ?? "declined by an operator"})`);
  }
  return lines.join("\n");
}

// ── The digest's ready-count block (W1-T112: the morning pulse) ──────────────────────────
//
// Latest-wins snapshot discipline, like ops.ts's AlertsPollSummary: digest.ts reads the LATEST `inbox.polled` line in
// its window, a snapshot rather than an additive event count. Rendered SOFT, so this module can land or not without
// the digest depending on it.

export interface InboxPollSummary {
  /** How many active proposals classified READY this poll — the digest's "N ready" count. */
  ready: number;
}

/** Reduce a batch of classifications to the digest's ready count. Pure. */
export function summarizeInboxPoll(classifications: InboxClassification[]): InboxPollSummary {
  return { ready: classifications.filter((c) => c.state === "ready").length };
}

/** One-line render of an {@link InboxPollSummary} — what the digest prints ("inbox: <this>"). */
export function renderInboxPollSummary(s: InboxPollSummary): string {
  return `${s.ready} ready`;
}

// ── State-side registry shapes. W1-T240 also put the one write-side helper every writer must share
// here — see {@link updateProposalRegistry} below ────────────────────────────────────────────────

/** `<config.root>/state/inbox-proposals.json` — the ACTIVE-proposal registry. */
export interface ProposalRegistry {
  proposals: Proposal[];
}

/** `<config.root>/state/inbox-drafts.json` — the draft cache, keyed by proposal id. */
export interface DraftCache {
  [proposalId: string]: DraftedCandidate;
}

/** W1-T1270: the discriminated outcome {@link parseProposalRegistryResult} reports, keeping apart the classes {@link
 *  parseProposalRegistry} collapses to `[]`. `"absent"` is the normal pre-population state; `"fault"` is a parse
 *  throw or a bad `proposals` key; `"ok"` may legitimately carry `[]`, which is never a fault. */
export type ProposalRegistryParseResult =
  | { kind: "absent" }
  | { kind: "fault"; reason: "malformed" | "wrong-shape" }
  | { kind: "ok"; proposals: Proposal[] };

/** Discriminated parse of a {@link ProposalRegistry} blob — see {@link ProposalRegistryParseResult} for what each
 *  outcome means. Never throws. {@link parseProposalRegistry} is the fail-soft-to-`[]` projection of this. */
export function parseProposalRegistryResult(text: string | undefined): ProposalRegistryParseResult {
  if (!text) return { kind: "absent" };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "fault", reason: "malformed" };
  }
  const r = raw as { proposals?: unknown };
  if (typeof r !== "object" || r === null || !Array.isArray(r.proposals)) {
    return { kind: "fault", reason: "wrong-shape" };
  }
  return { kind: "ok", proposals: r.proposals as Proposal[] };
}

/** Parse a {@link ProposalRegistry} blob; `[]`, never a throw, on missing or malformed input. A caller needing to
 *  know WHY it came back empty calls {@link parseProposalRegistryResult}. */
export function parseProposalRegistry(text: string | undefined): Proposal[] {
  const result = parseProposalRegistryResult(text);
  return result.kind === "ok" ? result.proposals : [];
}

// ── W1-T2490: PROPOSAL SHARDING — one record per file, as `plan/tasks.d/` gave tasks ──────
//
// The registry was the last plan artifact still a single blob, so two minters filing in the same window contended on
// one file. {@link loadProposalRegistry} now merges the legacy blob with a sibling `inbox-proposals.d/` exactly as
// plan.ts's `loadPlan` merges `tasks.yaml` with `tasks.d/`, duplicate-id refusal included. Only a NEW or
// actively-rewritten proposal lands in a shard.

/** Sibling shard directory to `registryPath` — derived from the registry's own path, never hardcoded. */
export function proposalShardDir(registryPath: string): string {
  const stem = basename(registryPath, extname(registryPath));
  return join(dirname(registryPath), `${stem}.d`);
}

/** The shard file a proposal `id` is written to — DERIVED: a slug prefix plus a content hash, so two ids that slugify
 *  alike cannot collide. Reading keys on each shard's OWN `id`, never this name. */
function proposalShardFilename(id: string): string {
  const hash = createHash("sha256").update(id).digest("hex").slice(0, 12);
  const slug = id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "proposal"}-${hash}.json`;
}

function proposalShardPath(registryPath: string, id: string): string {
  return join(proposalShardDir(registryPath), proposalShardFilename(id));
}

/** List the shard files under `shardDir`. `[]` when it does not exist, the unmigrated case; any OTHER read failure is
 *  NOT forgiven, since an empty answer would hide every proposal it holds. */
function listProposalShardFiles(shardDir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(shardDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw new Error(`cannot read proposal shard directory (${shardDir}): ${String(err)}`);
  }
  return entries.filter((f) => f.endsWith(".json")).sort();
}

/** Parse every shard, keyed by each file's OWN declared `id`, never the filename. Two files declaring the SAME id is
 *  refused loud, mirroring plan.ts's duplicate-task-id guard. */
function readProposalShards(shardDir: string): Map<string, { proposal: Proposal; path: string }> {
  const out = new Map<string, { proposal: Proposal; path: string }>();
  for (const file of listProposalShardFiles(shardDir)) {
    const shardPath = join(shardDir, file);
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(shardPath, "utf8"));
    } catch (err) {
      throw new Error(`cannot read proposal shard (${shardPath}): ${String(err)}`);
    }
    const proposal = raw as Proposal;
    if (typeof proposal?.id !== "string" || proposal.id.length === 0) {
      throw new Error(`proposal shard (${shardPath}) has no valid 'id' field`);
    }
    const existing = out.get(proposal.id);
    if (existing) {
      throw new Error(`duplicate proposal id '${proposal.id}' (shard ${shardPath} collides with ${existing.path})`);
    }
    out.set(proposal.id, { proposal, path: shardPath });
  }
  return out;
}

/** Load `registryPath` merged with the sibling `inbox-proposals.d/` shards as ONE population, with the same signature
 *  every current reader's idiom already has. An id in BOTH resolves to the shard's copy, ONCE; an id claimed by TWO
 *  shard files is the collision {@link readProposalShards} refuses. */
export function loadProposalRegistry(registryPath: string): Proposal[] {
  const blobProposals = parseProposalRegistry(fs.existsSync(registryPath) ? fs.readFileSync(registryPath, "utf8") : undefined);
  const shards = readProposalShards(proposalShardDir(registryPath));
  const byId = new Map<string, Proposal>();
  for (const p of blobProposals) byId.set(p.id, p);
  for (const { proposal } of shards.values()) byId.set(proposal.id, proposal);
  return [...byId.values()];
}

// ── W1-T240: the ONE registry-write helper every writer of inbox-proposals.json goes through ──
//
// FOUR unsynchronised read-modify-write round trips used to exist, and the multi-writer path is genuine: `rmd serve`
// is a long-lived daemon, so any concurrent CLI invocation overlaps it. Two failure modes result — a TORN FILE, which
// {@link parseProposalRegistry}'s fail-soft "malformed -> []" turns into a SILENT empty registry rather than a
// visible error; and a LOST UPDATE, where whichever updater writes last wins.
//
// This is the ONLY sanctioned writer, so a fifth caller inherits the property. An O_EXCL lockfile serialises every
// call ACROSS PROCESSES, which an in-process single-writer function cannot do, and the write lands via a temp file
// plus `renameSync`. A live holder is POLLED, not refused as in drain-lock.ts, because every critical section takes
// microseconds. STALENESS IS NEVER PID-LIVENESS ALONE, so {@link reclaimStaleLock} (W1-T289/W1-T368) conditions its
// delete on the lock's on-disk identity and two reclaimers cannot both believe they hold it.

export interface UpdateProposalRegistryOpts {
  /** Throw if the lock cannot be acquired within this long (ms). Default 2000 — every critical section takes
   *  microseconds, so a lock held after 2s means a crashed holder, not contention. */
  maxWaitMs?: number;
  /** Poll interval while a live holder is waited out (ms). Default 20. */
  pollIntervalMs?: number;
  /** Injectable liveness probe (tests). Defaults to {@link defaultIsPidAlive}. */
  isPidAlive?: (pid: number) => boolean;
  /** Injectable blocking sleep (tests fake it to skip real delay). Default = a real, busy-wait-free sleep (mirrors
   *  lib/deployer.ts's own injected-sleep discipline). */
  sleep?: (ms: number) => void;
  /** Injectable process-start-time probe, forwarded to {@link isHolderStale} (tests). Defaults to {@link
   *  import("./fs-race-safe.js").defaultGetProcessStartTime}. */
  getProcessStartTime?: (pid: number) => number | null;
  /** Called whenever a reclaim attempt loses the race to another reclaimer (see {@link reclaimStaleLock}). Defaults
   *  to a `console.error` trace; tests override it to observe the event directly instead of scraping stderr. */
  onLostReclaim?: (detail: { lockPath: string; reason: string }) => void;
  /** TEST-ONLY seam forwarded to {@link reclaimStaleLock}'s `beforeDelete`, so a test can prove the delete-time
   *  identity check refuses to clear a lock that is no longer the one it judged stale. */
  __beforeReclaimDelete?: () => void;
}

interface RegistryLockInfo {
  pid: number;
  host?: string;
  startedAt?: string;
}

/** Parse raw lock contents into a holder record, or `null` for garbage — the `parseHolder` contract. Takes bytes, not
 *  a path: {@link reclaimStaleLock} reads the lock through ONE descriptor. */
function parseRegistryLockInfo(raw: string): RegistryLockInfo | null {
  try {
    const o = JSON.parse(raw);
    return typeof o?.pid === "number" ? (o as RegistryLockInfo) : null;
  } catch {
    return null; // missing, unreadable, or garbage → no valid holder
  }
}

function defaultRegistryLockSleep(ms: number): void {
  execFileSync("sleep", [String(ms / 1000)]);
}

/** Read-modify-write `registryPath`, guarded against the hazards this section's header describes. `update` sees the
 *  CURRENT proposals, re-read under the lock; returning `null` skips the write. */
export function updateProposalRegistry(
  registryPath: string,
  update: (current: Proposal[]) => Proposal[] | null,
  opts: UpdateProposalRegistryOpts = {},
): Proposal[] | null {
  const lockPath = `${registryPath}.lock`;
  const maxWaitMs = opts.maxWaitMs ?? 2000;
  const pollIntervalMs = opts.pollIntervalMs ?? 20;
  const isAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const sleep = opts.sleep ?? defaultRegistryLockSleep;
  fs.mkdirSync(dirname(lockPath), { recursive: true });

  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    try {
      // O_EXCL: create-or-fail, no TOCTOU gap — same discipline as acquireDrainLock / acquireInflightLock
      // (lib/drain-lock.ts, lib/inflight-lock.ts).
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }));
      fs.closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // R-4: staleness is judged by isHolderStale — host, pid liveness and start-time reuse — NEVER by pid liveness
      // alone, and the reclaim's delete is conditioned on the lock's on-disk identity.
      const result = reclaimStaleLock(lockPath, {
        parseHolder: parseRegistryLockInfo,
        isStale: (held) => isHolderStale(held, { isPidAlive: isAlive, getProcessStartTime: opts.getProcessStartTime }),
        onLostReclaim: opts.onLostReclaim,
        beforeDelete: opts.__beforeReclaimDelete,
      });
      if (result.outcome === "live") {
        if (Date.now() >= deadline) {
          throw new Error(`updateProposalRegistry: timed out after ${maxWaitMs}ms waiting for ${lockPath} (held by pid ${result.holder.pid})`);
        }
        sleep(pollIntervalMs);
        continue;
      }
      // "missing" | "reclaimed" | "lost" → loop back and retry the atomic create.
    }
  }

  try {
    // W1-T2490: `current` is the SHARD-MERGED population, read under this SAME lock. `shards` is kept so the write
    // half below knows, per id, whether it already lives in its own file.
    const shardDir = proposalShardDir(registryPath);
    const shards = readProposalShards(shardDir);
    const blobProposals = parseProposalRegistry(fs.existsSync(registryPath) ? fs.readFileSync(registryPath, "utf8") : undefined);
    const byId = new Map<string, Proposal>();
    for (const p of blobProposals) byId.set(p.id, p);
    for (const { proposal } of shards.values()) byId.set(proposal.id, proposal);
    const current = [...byId.values()];

    const next = update(current);
    if (next === null) return null;
    const currentIds = new Set(current.map((p) => p.id));
    const nextIds = new Set(next.map((p) => p.id));

    // A shard mirror ABSENT from `next` was just dispositioned, so its file goes: the directory must never claim a
    // dispositioned record, and no later read may resurrect it.
    for (const { proposal, path: shardPath } of shards.values()) {
      if (!nextIds.has(proposal.id)) {
        try {
          fs.unlinkSync(shardPath);
        } catch {
          // already gone — idempotent, mirrors the lock cleanup below
        }
      }
    }

    // A `next` proposal that is NEW, or already had a shard mirror, gets its OWN file atomically — MIRRORED alongside
    // the blob write below, never instead of it, so every existing reader keeps seeing the same population. Promoting
    // an UNTOUCHED legacy entry is a migration, not a side effect of an unrelated write.
    for (const proposal of next) {
      const isNew = !currentIds.has(proposal.id);
      const hadShard = shards.has(proposal.id);
      if (isNew || hadShard) {
        fs.mkdirSync(shardDir, { recursive: true });
        const shardPath = proposalShardPath(registryPath, proposal.id);
        const tmpShardPath = `${shardPath}.tmp-${process.pid}-${Date.now()}`;
        fs.writeFileSync(tmpShardPath, JSON.stringify(proposal, null, 2), "utf8");
        fs.renameSync(tmpShardPath, shardPath);
      }
    }

    // ATOMIC WRITE: temp file plus rename (see this section's header). Live `fs.` lookups so a test can intercept
    // them. The blob always carries the WHOLE of `next`.
    const tmpPath = `${registryPath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, JSON.stringify({ proposals: next }, null, 2), "utf8");
    fs.renameSync(tmpPath, registryPath);
    return next;
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // already gone — idempotent
    }
  }
}

// ── W1-T241: the ONE atomic-write helper for the daemon draft rung's cache PAIR ───────────
//
// The two caches used to be written as independent, torn-write-prone calls, and the PAIR was not atomic. Each now
// lands via a temp file plus `renameSync`, and the renames commit in a FIXED order: drafts before attempts. THE
// INVARIANT THAT BUYS: the only one-sided state a crash can land is a fresh draft with no attempts entry, which
// {@link proposalsNeedingDraft} stops selecting. Never the reverse — an attempt with no draft would throttle that
// cause FOREVER.
export function writeDraftAttemptPair(draftsPath: string, attemptsPath: string, nextDrafts: DraftCache, nextAttempts: DraftAttemptCache): void {
  const draftsTmpPath = `${draftsPath}.tmp-${process.pid}-${Date.now()}`;
  const attemptsTmpPath = `${attemptsPath}.tmp-${process.pid}-${Date.now()}`;
  // Both temp files are fully staged BEFORE either commits (see this section's header). Live `fs.` property lookups,
  // never destructured imports, so a test's `t.mock.method(fs, ...)` intercepts.
  fs.writeFileSync(draftsTmpPath, JSON.stringify(nextDrafts, null, 2), "utf8");
  fs.writeFileSync(attemptsTmpPath, JSON.stringify(nextAttempts, null, 2), "utf8");
  fs.renameSync(draftsTmpPath, draftsPath);
  fs.renameSync(attemptsTmpPath, attemptsPath);
}

/** `state/inbox-reopened-keys.json` (W1-T2566) — one entry per proposal id this host has re-opened. ⚠ KEYED ON
 *  PROPOSAL ID, NEVER A GLOBAL "MIGRATION DONE" FLAG: W1-T2564 chose a closure flag because every boot runs it, so a
 *  fresh host recovers with no operator step, and a per-id marker preserves that where one global flag would not. */
export interface ReopenedKeysCache {
  [proposalId: string]: string;
}

/** Parse a {@link ReopenedKeysCache}; `{}` on missing or malformed input. An unreadable marker must mean "nothing
 *  re-opened yet", so the host still recovers, never a crash on the boot path. */
export function parseReopenedKeysCache(text: string | undefined): ReopenedKeysCache {
  if (!text) return {};
  try {
    const raw = JSON.parse(text) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    const out: ReopenedKeysCache = {};
    for (const [id, at] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof at === "string") out[id] = at;
    }
    return out;
  } catch {
    // Deliberate: a malformed marker file re-opens each id once more rather than failing the boot. Losing the marker
    // costs one extra attempt per id; failing the boot costs the fleet.
    return {};
  }
}

/** W1-T2566 — record the ids just re-opened, preserving any stamp already present so a re-read never moves an
 *  existing entry's time. Pure: returns the next cache, mutating nothing. */
export function markReopened(current: ReopenedKeysCache, ids: readonly string[], at: string): ReopenedKeysCache {
  const next: ReopenedKeysCache = { ...current };
  for (const id of ids) if (next[id] === undefined) next[id] = at;
  return next;
}

/** W1-T2566 — commit the marker with the same stage-then-rename discipline, so a torn write can never leave a
 *  half-written marker that parses as "everything already re-opened". */
export function writeReopenedKeys(path: string, next: ReopenedKeysCache): void {
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tmpPath, path);
}

/** Parse a {@link DraftCache} JSON blob; `{}` on missing/malformed input. */
export function parseDraftCache(text: string | undefined): DraftCache {
  if (!text) return {};
  try {
    const raw = JSON.parse(text) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    return raw as DraftCache;
  } catch {
    return {};
  }
}

/** Drop one proposal's cached draft — the invalidation `rmd reframe` applies so the next pass re-drafts rather than
 *  re-surfacing the candidate just objected to. A no-op when none is cached. */
export function invalidateDraft(drafts: DraftCache, proposalId: string): DraftCache {
  const next: DraftCache = { ...drafts };
  delete next[proposalId];
  return next;
}

/** W1-T190 (round 2): heal a drifted registry entry rather than merely work around it. The read-side override in
 *  {@link classifyProposal} stops a misclassification, but the drifted row would sit there forever, so pruning it
 *  lets any OTHER consumer see the corrected state. A no-op — same array reference, empty `prunedIds` — when nothing
 *  needs healing. */
export function pruneRatifiedProposals(
  proposals: Proposal[],
  classifications: InboxClassification[],
): { proposals: Proposal[]; prunedIds: string[] } {
  const ratifiedIds = new Set(classifications.filter((c) => c.state === "ratified").map((c) => c.proposalId));
  if (ratifiedIds.size === 0) return { proposals, prunedIds: [] };
  return {
    proposals: proposals.filter((p) => !ratifiedIds.has(p.id)),
    prunedIds: [...ratifiedIds],
  };
}

// ── W1-T2455: THE DUPLICATE CHECK AT THE RATIFICATION SEAM ──────────────────────────────────
//
// `duplicateTitleViolations` (task-linter.ts) has been wired since W1-T1076, but TWO things keep it off this path:
// its severity is `warn` while `lintPlanCommand` only fails a task inside `if (blocking.length)`; and it is scoped to
// the `--base` pass and returns `{}` for the whole-plan one. So `rmd approve` can file a task for a defect that
// already shipped. W1-T2486 corrected a false third reason this comment used to give — `lint-plan` IS required, but a
// `warn` never enters the `blocking` array. IT KEYS ON THE DRAFTED SHARD SLUG, NEVER ON THE PROPOSAL, because eleven
// board-review summaries read near-identically yet are legitimately distinct. HONEST RECALL: a LEXICAL check misses
// drafts in other words, and no cutoff is invented to reach them. Why: the measured 2026-08-29 scores — see
// docs/forensics/inbox.md.

/** The slug stem of each shard a drafted fragment would be filed as — the SAME stems {@link ratificationShardFiles}
 *  emits, so the check scores what would land on disk. PLACEHOLDER-TOLERANT BY NECESSITY: at approve time the
 *  fragment still carries `NEW-<n>` ids, so `shardSlugFromPath` scored 0 of 32. This reads the stem after the FIRST
 *  `-`. */
export function draftedShardSlugs(fragmentYaml: string): DuplicateCorpusEntry[] {
  const shards = ratificationShardFiles(fragmentYaml);
  if (!shards.ok) return []; // an unsplittable fragment is refused by the writer, not here
  const out: DuplicateCorpusEntry[] = [];
  for (const f of shards.files) {
    // The id is read from the shard's OWN contents, never guessed off the path: a lazy `<id>-` regex splits
    // `NEW-1-<slug>` after "NEW" and leaves "1-" glued to the stem, perturbing every score.
    const id = /^\s*-\s*id:\s*(\S+)/m.exec(f.contents)?.[1];
    const prefix = id ? `plan/tasks.d/${id}-` : undefined;
    if (!prefix || !f.relPath.startsWith(prefix)) continue;
    const stem = f.relPath.slice(prefix.length).replace(/\.ya?ml$/, "");
    if (stem) out.push({ id: f.relPath, text: stem });
  }
  return out;
}

/** One drafted shard that duplicates something already filed. */
export interface DraftedDuplicate {
  /** The shard path this fragment would have written. */
  draftedPath: string;
  /** The already-filed task id it duplicates. */
  duplicateOf: string;
  score: number;
}

/** The FIRST drafted shard at or above the cutoff, or `undefined`. Pure. AN EMPTY `corpus` YIELDS `undefined`, never
 *  a refusal — a corpus-build failure must not block a ratification. */
export function draftedDuplicate(
  fragmentYaml: string,
  corpus: readonly DuplicateCorpusEntry[],
  opts: { cutoff?: number; k?: number } = {},
): DraftedDuplicate | undefined {
  if (corpus.length === 0) return undefined;
  const cutoff = opts.cutoff ?? DEFAULT_DUPLICATE_CUTOFF;
  const k = opts.k ?? DUPLICATE_SLUG_SHINGLE_K;
  for (const candidate of draftedShardSlugs(fragmentYaml)) {
    const match = bestNearDuplicate(candidate, corpus, { k });
    if (match && match.score >= cutoff) {
      return { draftedPath: candidate.id, duplicateOf: match.id, score: match.score };
    }
  }
  return undefined;
}

/** The refusal text a {@link DraftedDuplicate} produces — the score, the cutoff, the filed id, and the TWO additive
 *  answers: cite the prior task, or say why this differs. Never "file less work". */
export function draftedDuplicateRefusal(proposalId: string, dup: DraftedDuplicate, cutoff = DEFAULT_DUPLICATE_CUTOFF): string {
  return (
    `${proposalId} would file ${dup.draftedPath}, which scores ${dup.score.toFixed(2)} ` +
    `(>= cutoff ${cutoff}) against ${dup.duplicateOf} — a task record already on origin/main. ` +
    `Ratifying it would mint a second task for work that is already filed. TWO ANSWERS BOTH ` +
    `CLEAR THIS, and both are additive: REFRAME the proposal so its draft cites ${dup.duplicateOf} ` +
    `and names what it does NOT already cover, or RETIRE the proposal if ${dup.duplicateOf} ` +
    `covers it. Never answer this by deleting a proof or narrowing files:.`
  );
}

// ── rmd approve — one bit ratifies through the gate (MASTER-PLAN P25 ii, W1-T111) ────────
//
// APPROVE = one bit: the thumbs-up INITIATES the plan PR carrying the pre-drafted, lint-clean tasks plus the RATIFIED
// stamp. {@link approveProposal} is the pure DECISION; the side effects are injected via {@link RatifyGateway},
// mirroring escalate.ts's `IssueGateway` split. W1-T2456 correction: this used to cite a §12 rule 15 the doctrine
// does not carry — rule 27 permits automatic filing outright. The approve bit initiates; the gate still reviews.

/** The exact fragment and stamp a READY classification carries, shipped VERBATIM and never re-derived at approve
 *  time: the operator approves the same draft `rmd inbox` showed them. */
export interface RatificationPayload {
  proposalId: string;
  fragmentYaml: string;
  stampLine: string;
}

/** Git and GitHub side effects `approveProposal` drives. Each is called AT MOST ONCE on a READY classification not
 *  resuming a prior push; a non-ready classification calls neither. */
export interface RatifyGateway {
  /** File the fragment as one `plan/tasks.d/` shard per task — NEVER an append to plan/tasks.yaml, which
   *  `monolith-filing` refuses for a new id — plus the stamp, in ONE branch and commit. */
  createRatificationBranch(payload: RatificationPayload): string;
  /** Open the plan PR for the pushed branch. Returns its URL. Skipped when `findExistingPr` already found one (ADOPT)
   *  — a found PR is never re-created. */
  openPlanPr(branch: string, proposalId: string): string;

  /** OPTIONAL (W1-T903 iii). The branch a PRIOR run of this proposal pushed, CONFIRMED still on the remote. Omitting
   *  it is exactly the pre-W1-T903 path: straight through to `createRatificationBranch`. */
  findPushedBranch?(proposalId: string): string | undefined;

  /** OPTIONAL (W1-T903 ii/iii). True when a PR already exists for `branch`, checked BEFORE anything is created, so a
   *  prior run's server-side success is ADOPTED rather than duplicated. */
  findExistingPr?(branch: string): { prUrl: string; prNumber: number } | undefined;

  /** OPTIONAL (W1-T903 iii/vi). COMPLETE an already-pushed branch carrying no PR, with NO new commit, re-push or
   *  re-mint. Called only when a branch was found and no PR was. */
  completeRatificationBranch?(branch: string, proposalId: string): string;
}

export type ApproveResult =
  | {
      ok: true;
      proposalId: string;
      branch: string;
      prUrl: string;
      /** W1-T903 design (v): from the REST response when freshly created/adopted, or parsed off `prUrl` for a legacy
       *  gateway that only ever returned a bare url — `undefined` only when neither source yields a usable integer. */
      prNumber?: number;
      payload: RatificationPayload;
      /** W1-T903: true when this PR was ADOPTED from a prior run rather than opened by this one —
       *  `createRatificationBranch`/`openPlanPr` were both skipped. */
      adopted?: boolean;
    }
  | {
      ok: false;
      proposalId: string;
      state: InboxState;
      refusal: string;
      /** W1-T2455: the already-filed task id this proposal's draft duplicates, when THAT is why it was refused.
       *  Absent on every other refusal, so a reader can tell the two apart without parsing `refusal` prose. */
      duplicateOf?: string;
    };

/** GitHub's PR url is always `.../pull/<number>`. `undefined` on anything else, never a thrown parse error: a legacy
 *  url degrades to "no number recorded" rather than blocking the ratification. */
function prNumberFromUrl(url: string): number | undefined {
  const n = Number(url.match(/\/pull\/(\d+)/)?.[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** W1-T903 (vii): a rate-limit-classified PR-create failure is described as THROTTLED — the branch survived, the pull
 *  request is missing, a plain re-run resumes it — never a bare failure that reads as "nothing happened". Any other
 *  failure keeps its message UNCHANGED, and the caller's `approve.error` line carries this text verbatim. */
export function describeApproveGatewayError(e: unknown, proposalId: string, branch: string): string {
  const message = String((e as Error)?.message ?? e);
  if (!isGhRateLimitError(e)) return message;
  return (
    `rmd approve: PR create throttled (GitHub rate limit) — branch ${branch} is pushed and its ` +
    `pull request is still missing; nothing was lost. Re-run 'rmd approve ${proposalId}' to ` +
    `resume it — no new branch will be pushed. Original error: ${message}`
  );
}

/** Human-readable reason a classification cannot be approved right now — every non-ready or deferred state names ITS
 *  failing predicate(s)/trigger, never a bare refusal. */
export function refusalReason(c: InboxClassification): string {
  if (c.state === "ready") return "";
  if (c.state === "ratified") {
    return `${c.proposalId} is already RATIFIED (the ledger carries ratify.approved for it) — no further approve action is possible`;
  }
  if (c.state === "retired") {
    return `${c.proposalId} is RETIRED (${c.retiredReason ?? "referent resolved"}) — never approvable`;
  }
  if (c.state === "declined") {
    return `${c.proposalId} is DECLINED (${c.declinedReason ?? "declined by an operator"}) — never approvable`;
  }
  if (c.state === "deferred_with_trigger") {
    return `${c.proposalId} is DEFERRED-WITH-TRIGGER (trigger not fired: ${c.trigger?.description ?? "unnamed trigger"}) — never approvable`;
  }
  if (c.state === "drafting") {
    return `${c.proposalId} is currently DRAFTING (spawned ${c.draftSpawnedAt ?? "unknown time"}) — not yet approvable`;
  }
  const reasons = c.reasons.map((r) => `[${r.predicate}] ${r.detail}`).join("; ");
  return `${c.proposalId} is NOT READY — ${reasons || "no drafted candidate available yet"}`;
}

export interface RatifyLedgerDeps {
  ledgerPath: string;
  runId: string;
  /** W1-T2455: already-filed task records to score this proposal's drafted slugs against, built by the caller.
   *  OMITTED or EMPTY means the check does not run — it never blocks on its own blindness. */
  duplicateCorpus?: readonly DuplicateCorpusEntry[];
}

/**
 * `rmd approve <P##>` — valid ONLY for a READY classification. Anything else is REFUSED, naming the state, with ZERO
 * gateway calls: a bit on a non-ready item initiates NOTHING. On a READY classification with no prior push,
 * `createRatificationBranch` then `openPlanPr` run exactly once each, carrying the cached draft verbatim. W1-T903
 * (iii): when `findPushedBranch` names a prior run's branch, an existing PR is checked for FIRST, so a found PR is
 * ADOPTED and a branch without one is COMPLETED. Exactly one `ratify.*` line per outcome, and `ratify.approved` only
 * after a pull request is confirmed to exist — never on a thrown gateway error.
 */
export function approveProposal(
  classification: InboxClassification,
  gateway: RatifyGateway,
  deps: RatifyLedgerDeps,
): ApproveResult {
  if (classification.state !== "ready" || !classification.draft) {
    const refusal = refusalReason(classification);
    appendLedger(deps.ledgerPath, {
      run_id: deps.runId,
      task_id: classification.proposalId,
      step: "ratify.approve_refused",
      state: classification.state,
      reason: refusal,
    });
    return { ok: false, proposalId: classification.proposalId, state: classification.state, refusal };
  }
  // W1-T2455: a READY proposal whose DRAFT would re-file work already on origin/main is refused HERE, with ZERO
  // gateway calls. BLOCKING ON THIS PATH ONLY: the same check stays `warn` for the whole-plan pass, where promoting
  // it would redden long-open siblings. Ratification MINTS, and a mint is not something a later reader can undo
  // cheaply.
  const dup = draftedDuplicate(classification.draft.fragmentYaml, deps.duplicateCorpus ?? []);
  if (dup) {
    const refusal = draftedDuplicateRefusal(classification.proposalId, dup);
    appendLedger(deps.ledgerPath, {
      run_id: deps.runId,
      task_id: classification.proposalId,
      step: "ratify.approve_refused",
      state: classification.state,
      reason: refusal,
      duplicate_of: dup.duplicateOf,
      drafted_path: dup.draftedPath,
      score: dup.score,
    });
    return { ok: false, proposalId: classification.proposalId, state: classification.state, refusal, duplicateOf: dup.duplicateOf };
  }
  const payload: RatificationPayload = {
    proposalId: classification.proposalId,
    fragmentYaml: classification.draft.fragmentYaml,
    stampLine: classification.draft.stampLine,
  };

  const resumeBranch = gateway.findPushedBranch?.(classification.proposalId);
  const adopted = resumeBranch !== undefined ? gateway.findExistingPr?.(resumeBranch) : undefined;

  let branch: string;
  if (adopted) {
    branch = resumeBranch as string;
  } else if (resumeBranch !== undefined && gateway.completeRatificationBranch) {
    branch = gateway.completeRatificationBranch(resumeBranch, classification.proposalId);
  } else {
    branch = gateway.createRatificationBranch(payload);
  }

  let prUrl: string;
  let prNumber: number | undefined;
  if (adopted) {
    prUrl = adopted.prUrl;
    prNumber = adopted.prNumber;
  } else {
    try {
      prUrl = gateway.openPlanPr(branch, classification.proposalId);
    } catch (e) {
      throw new Error(describeApproveGatewayError(e, classification.proposalId, branch), { cause: e as Error });
    }
    prNumber = prNumberFromUrl(prUrl);
  }

  appendLedger(deps.ledgerPath, {
    run_id: deps.runId,
    task_id: classification.proposalId,
    step: "ratify.approved",
    pr_url: prUrl,
    pr_number: prNumber,
    branch,
  });
  return {
    ok: true,
    proposalId: classification.proposalId,
    branch,
    prUrl,
    prNumber,
    payload,
    ...(adopted ? { adopted: true } : {}),
  };
}

/** The harness-authored commit message for a ratification branch — never the LLM. Carries NO `Remudero-Task:`
 *  trailer: this is a plan-FILING PR, and `findMergedByTrailer` (lib/status.ts) would mark a never-built task
 *  complete on merge. Uses `buildPlanPrCommitMessage` so the stamp is WRAPPED, never spliced raw (#387). */
export function approveCommitMessage(payload: RatificationPayload): string {
  return buildPlanPrCommitMessage({
    scope: "plan",
    subject: `ratify ${payload.proposalId} via rmd approve`,
    extraBody: [
      payload.stampLine,
      "",
      "The operator's one-bit approve initiated this PR (MASTER-PLAN P25 ii, W1-T111), carrying " +
        "the pre-drafted, lint-clean tasks + the RATIFIED stamp verbatim. The gate still reviews " +
        "(ci + remudero-review); nothing auto-merges without it.",
    ].join("\n"),
    // No taskId ⇒ no Remudero-Task trailer — see the doc comment above.
  });
}

// ── Real-world ratification writers (plain text composition, harness-owned) ──────────────

/** Append a drafted fragment's YAML entries to `plan/tasks.yaml`'s text. Pure string composition, never a YAML
 *  re-serialization that could reformat the rest of the file. The longest slug the shards on main carry, so a filed
 *  shard is never truncated shorter than the convention it joins. Measured over 696 shards: median 37, p95 57, max
 *  72. */
const SHARD_SLUG_MAX_LEN = 72;

/** One ratification shard: where it goes, and the exact YAML that goes there. */
export interface RatificationShardFile {
  /** Repo-relative, `plan/tasks.d/<id>-<kebab-slug>.yaml` — the shape `monolith-filing` names. */
  relPath: string;
  /** A SINGLE-ELEMENT YAML list holding this task's authored block, verbatim. */
  contents: string;
}

/**
 * Split a drafted fragment into ONE `plan/tasks.d/` shard per task. `applyFragmentToPlanYaml` appends to
 * `plan/tasks.yaml`, which `lint-plan`'s `monolith-filing` refuses for a NEW id; this was the last writer still
 * appending, and because no proposal had ever been ratified the write had never once met the gate. TEXT SPLITTING,
 * NEVER A YAML RE-SERIALIZATION: round-tripping authored, prose-heavy YAML would reformat what a human wrote, so
 * blocks are cut on a top-level `- ` at column zero. REFUSES RATHER THAN GUESSES — a block whose `- id:` cannot be
 * read yields no file, because a shard under a guessed name puts a task where `lint-plan` cannot match it.
 */
export function ratificationShardFiles(
  fragmentYaml: string,
): { ok: true; files: RatificationShardFile[] } | { ok: false; reason: string } {
  const text = (fragmentYaml ?? "").replace(/\s*$/, "");
  if (!text.trim()) return { ok: false, reason: "the drafted fragment is empty — nothing to file" };
  const blocks: string[] = [];
  for (const line of text.split("\n")) {
    if (/^- /.test(line)) blocks.push(line);
    else if (blocks.length > 0) blocks[blocks.length - 1] += `\n${line}`;
    else if (line.trim()) {
      return { ok: false, reason: `the fragment does not begin with a top-level "- " task entry (saw: ${line.slice(0, 60)})` };
    }
  }
  if (blocks.length === 0) return { ok: false, reason: "the fragment carries no top-level task entries" };

  const files: RatificationShardFile[] = [];
  for (const block of blocks) {
    const id = /^- id:\s*(\S+)/m.exec(block)?.[1];
    if (!id) return { ok: false, reason: `a drafted task block carries no readable "- id:" line (starts: ${block.slice(0, 60)})` };
    // The title is the slug's source. A block with none still files — under the id alone — since the id is what
    // `monolith-filing` matches on and the slug is readability.
    const title = /^\s+title:\s*(.*)$/m.exec(block)?.[1] ?? "";
    // The cap is the SHARD convention's, not the docket's; the trailing-hyphen trim is this writer's own, since
    // `slug` strips edges BEFORE slicing and a cut can land on a separator.
    const stem = kebabSlug(title.replace(/^["']|["']$/g, ""), SHARD_SLUG_MAX_LEN).replace(/-+$/, "");
    files.push({ relPath: `plan/tasks.d/${id}${stem ? `-${stem}` : ""}.yaml`, contents: `${block.replace(/\s*$/, "")}\n` });
  }
  return { ok: true, files };
}

/** The filesystem surface {@link writeRatificationShards} needs — injected so the write is testable without a real
 *  worktree, the same seam discipline the rest of this module uses. */
export interface ShardWriteFs {
  mkdirSync: (dir: string, opts: { recursive: true }) => unknown;
  writeFileSync: (path: string, data: string, enc: "utf8") => void;
}

/** Compose {@link ratificationShardFiles} and WRITE them under `worktreePath`. THROWS on a refusal rather than
 *  returning a partial result: a ratification that cannot name its own shard must write nothing and open no PR.
 *  EXTRACTED FROM THE GATEWAY so it is reachable by a test — an untestable write is what let the monolith append
 *  survive until the first ratification met the gate. */
export function writeRatificationShards(
  worktreePath: string,
  fragmentYaml: string,
  proposalId: string,
  fs: ShardWriteFs,
  joinPath: (...parts: string[]) => string,
): string[] {
  const shards = ratificationShardFiles(fragmentYaml);
  if (!shards.ok) throw new Error(`rmd approve: refusing to file ${proposalId} — ${shards.reason}`);
  fs.mkdirSync(joinPath(worktreePath, "plan", "tasks.d"), { recursive: true });
  for (const file of shards.files) fs.writeFileSync(joinPath(worktreePath, file.relPath), file.contents, "utf8");
  return shards.files.map((f) => f.relPath);
}

export function applyFragmentToPlanYaml(tasksYaml: string, fragmentYaml: string): string {
  const base = tasksYaml.replace(/\s*$/, "");
  return `${base}\n${fragmentYaml.trim()}\n`;
}

/** Splice a ratification stamp into MASTER-PLAN.md's proposal list: replace an existing `- <id> (…)` bullet in place
 *  when there is one, otherwise append the stamp at the end of the file. */
export function applyStampToMasterPlan(masterPlanMd: string, proposalId: string, stampLine: string): string {
  const bulletRe = new RegExp(`^- ${proposalId} \\(.*$`, "m");
  if (bulletRe.test(masterPlanMd)) {
    return masterPlanMd.replace(bulletRe, stampLine);
  }
  const base = masterPlanMd.replace(/\s*$/, "");
  return `${base}\n${stampLine}\n`;
}

// ── W1-T2471: RATIFY A BATCH — one branch, one commit, one MASTER-PLAN block, one PR ───────
//
// `approveProposal` ships ONE proposal per branch, commit, PR and review spawn, and PARALLEL single-approves cannot
// fix that: `applyStampToMasterPlan` appends at EOF, so N branches off one base conflict pairwise on merge
// (measured). Folding N stamps SEQUENTIALLY through ONE accumulator leaves only one branch to conflict on, over an
// EXPLICIT, ORDERED set the caller names.

/** One batch member that did NOT reach `accepted`, carrying its OWN reason — the ordinary {@link refusalReason}, or a
 *  duplicate refusal against an earlier-accepted member of this batch. */
export interface BatchSkip {
  proposalId: string;
  state: InboxState;
  reason: string;
  /** Present iff skipped for duplicating an already-filed task (the caller-supplied origin/main corpus) OR an
   *  earlier-accepted member of this same batch. */
  duplicateOf?: string;
  /** The drafted shard path that would have been written, present alongside `duplicateOf` — same {@link
   *  DraftedDuplicate} fields {@link approveProposal}'s own duplicate-refusal ledger line carries. */
  draftedPath?: string;
  score?: number;
}

/** The pure plan a batch of classifications reduces to — no fs/git/network. */
export type RatifyBatchPlan =
  | {
      ok: true;
      /** Ready, non-duplicate members, in the order they were classified — what the gateway files, one {@link
       *  RatificationPayload} per accepted proposal. */
      accepted: RatificationPayload[];
      /** Every member that did NOT make `accepted`, each naming its own reason (Q4: an unready member neither blocks
       *  nor drags in the rest of the batch). */
      skipped: BatchSkip[];
      /** Every accepted member's shard files in accepted order — exactly what {@link ratificationShardFiles} produces
       *  for each alone, since the writer holds no state. */
      shardFiles: RatificationShardFile[];
      /** `masterPlanMd` with every stamp folded in, IN ORDER, through ONE accumulator — the whole reason a batch
       *  cannot hit the EOF-append conflict that sinks N parallel branches. */
      masterPlanMd: string;
    }
  | {
      ok: false;
      /** A BATCH-LEVEL refusal — nothing is filed for ANY member, because two members' drafts collide on one shard
       *  path. Partial filing would silently clobber whichever wrote second. */
      refusal: string;
      skipped: BatchSkip[];
    };

/** Reduce already-computed {@link InboxClassification}s into a {@link RatifyBatchPlan} — PURE, over the EXPLICIT,
 *  ORDERED set the caller named, which this never expands or reorders. WITHIN-BATCH DUPLICATES:
 *  `opts.duplicateCorpus` GROWS by each accepted member's own drafted slugs before the next is checked; an empty
 *  corpus still fails open. */
export function planRatificationBatch(
  classifications: readonly InboxClassification[],
  masterPlanMd: string,
  opts: { duplicateCorpus?: readonly DuplicateCorpusEntry[] } = {},
): RatifyBatchPlan {
  const skipped: BatchSkip[] = [];
  const accepted: RatificationPayload[] = [];
  let corpus: readonly DuplicateCorpusEntry[] = opts.duplicateCorpus ?? [];

  for (const c of classifications) {
    if (c.state !== "ready" || !c.draft) {
      skipped.push({ proposalId: c.proposalId, state: c.state, reason: refusalReason(c) });
      continue;
    }
    const dup = draftedDuplicate(c.draft.fragmentYaml, corpus);
    if (dup) {
      skipped.push({
        proposalId: c.proposalId,
        state: c.state,
        reason: draftedDuplicateRefusal(c.proposalId, dup),
        duplicateOf: dup.duplicateOf,
        draftedPath: dup.draftedPath,
        score: dup.score,
      });
      continue;
    }
    accepted.push({ proposalId: c.proposalId, fragmentYaml: c.draft.fragmentYaml, stampLine: c.draft.stampLine });
    // Q5: fold this NOW-accepted member's own drafted shard slugs into the corpus BEFORE the next member is checked —
    // dedupping against main UNION accepted-so-far, additive only.
    corpus = [...corpus, ...draftedShardSlugs(c.draft.fragmentYaml)];
  }

  // Two accepted members declaring the SAME task id would write the SAME shard path. Checked over every accepted
  // payload BEFORE any shard is folded in, refusing the WHOLE batch, not half of it.
  const shardFiles: RatificationShardFile[] = [];
  const ownerOf = new Map<string, string>(); // relPath -> the FIRST proposalId to claim it
  for (const payload of accepted) {
    const shards = ratificationShardFiles(payload.fragmentYaml);
    if (!shards.ok) {
      return { ok: false, refusal: `ratify-batch: refusing to file ${payload.proposalId} — ${shards.reason}`, skipped };
    }
    for (const file of shards.files) {
      const owner = ownerOf.get(file.relPath);
      if (owner && owner !== payload.proposalId) {
        return {
          ok: false,
          refusal:
            `ratify-batch: refusing the WHOLE batch — ${owner} and ${payload.proposalId} both drafted a task ` +
            `that would file ${file.relPath}; NEITHER is written. Reframe one of them so its draft names a ` +
            `distinct task id, then re-run the batch.`,
          skipped,
        };
      }
      ownerOf.set(file.relPath, payload.proposalId);
    }
    shardFiles.push(...shards.files);
  }

  const foldedMasterPlanMd = accepted.reduce((md, p) => applyStampToMasterPlan(md, p.proposalId, p.stampLine), masterPlanMd);
  return { ok: true, accepted, skipped, shardFiles, masterPlanMd: foldedMasterPlanMd };
}

/** Git and GitHub side effects {@link approveBatch} drives — ONE branch, commit and PR for the WHOLE accepted set,
 *  called exactly once each however many members the batch accepts. */
export interface RatifyBatchGateway {
  /** File every accepted payload's shards plus the folded MASTER-PLAN.md text, in ONE branch, commit and push.
   *  Returns the branch name actually pushed. */
  createRatificationBranch(payloads: RatificationPayload[]): string;
  /** Open the plan PR for the pushed branch, naming every accepted proposal id. Returns its URL. */
  openPlanPr(branch: string, proposalIds: string[]): string;
}

export interface RatifyBatchLedgerDeps {
  ledgerPath: string;
  runId: string;
  /** Same contract as {@link RatifyLedgerDeps.duplicateCorpus} — omitted/empty fails open. */
  duplicateCorpus?: readonly DuplicateCorpusEntry[];
}

export type BatchApproveResult =
  | {
      ok: true;
      branch: string;
      prUrl: string;
      prNumber?: number;
      accepted: RatificationPayload[];
      skipped: BatchSkip[];
      shardFiles: RatificationShardFile[];
      masterPlanMd: string;
    }
  | { ok: false; refusal: string; skipped: BatchSkip[] };

/**
 * `rmd approve <P##> <P##> ...` — the N-proposal counterpart of {@link approveProposal}. Every member is classified
 * INDIVIDUALLY by the caller and an unready one is SKIPPED with its own reason, never aborting the batch — except the
 * one batch-level precondition: two accepted members colliding on one shard path, which refuses the WHOLE batch
 * before either gateway call. ONE gateway call each for the WHOLE set, and one ledger line per member, so a reader
 * sees the same one-line-per-proposal receipt either way. A batch of exactly ONE READY classification produces output
 * BYTE-IDENTICAL to {@link approveProposal}'s — test/ratify-batch.test.ts pins it.
 */
export function approveBatch(
  classifications: readonly InboxClassification[],
  masterPlanMd: string,
  gateway: RatifyBatchGateway,
  deps: RatifyBatchLedgerDeps,
): BatchApproveResult {
  const plan = planRatificationBatch(classifications, masterPlanMd, { duplicateCorpus: deps.duplicateCorpus });

  for (const s of plan.skipped) {
    appendLedger(deps.ledgerPath, {
      run_id: deps.runId,
      task_id: s.proposalId,
      step: "ratify.approve_refused",
      state: s.state,
      reason: s.reason,
      ...(s.duplicateOf ? { duplicate_of: s.duplicateOf, drafted_path: s.draftedPath, score: s.score } : {}),
    });
  }

  if (!plan.ok) return { ok: false, refusal: plan.refusal, skipped: plan.skipped };
  if (plan.accepted.length === 0) {
    return { ok: false, refusal: "ratify-batch: no member of this batch is READY — nothing to ratify", skipped: plan.skipped };
  }

  const branch = gateway.createRatificationBranch(plan.accepted);
  const prUrl = gateway.openPlanPr(branch, plan.accepted.map((p) => p.proposalId));
  const prNumber = prNumberFromUrl(prUrl);

  for (const p of plan.accepted) {
    appendLedger(deps.ledgerPath, {
      run_id: deps.runId,
      task_id: p.proposalId,
      step: "ratify.approved",
      pr_url: prUrl,
      pr_number: prNumber,
      branch,
    });
  }

  return { ok: true, branch, prUrl, prNumber, accepted: plan.accepted, skipped: plan.skipped, shardFiles: plan.shardFiles, masterPlanMd: plan.masterPlanMd };
}

/** The harness-authored commit message for a BATCH ratification branch — same discipline as {@link
 *  approveCommitMessage}. The subject omits the id list, which unbounded N would overflow. */
export function approveBatchCommitMessage(payloads: readonly RatificationPayload[]): string {
  return buildPlanPrCommitMessage({
    scope: "plan",
    subject: `ratify ${payloads.length} proposals via rmd approve`,
    extraBody: [
      ...payloads.map((p) => p.stampLine),
      "",
      `The operator's one-bit approve initiated this PR (MASTER-PLAN P25 ii, W1-T111) for a BATCH of ` +
        `${payloads.length} explicitly-named proposals (${payloads.map((p) => p.proposalId).join(", ")}), ` +
        "carrying each pre-drafted, lint-clean fragment + its RATIFIED stamp verbatim, folded into ONE " +
        "branch/commit/PR (W1-T2471). The gate still reviews (ci + remudero-review); nothing auto-merges " +
        "without it.",
    ].join("\n"),
  });
}

// ── Draft placeholder ids -> concrete ids AT APPROVE TIME (lib/task-id.ts is the derivation) ──
//
// {@link inboxDraftPrompt} hands the worker NO real id — it emits `NEW-<n>` placeholders, never W1-T shaped, so a
// cached draft can never pin a concrete id. {@link materializeDraftTaskIds} mints and RESERVES the real ids and
// rewrites every placeholder before anything is written.

/** The placeholder shape drafting workers emit: `NEW-1`, `NEW-2`, … in fragment order. Deliberately never
 *  `W1-T`-shaped, so it can never be mistaken for or collide with a real filed id. */
const DRAFT_PLACEHOLDER_DECL_RE = /^\s*(?:-\s*)?id:\s*["']?(NEW-\d+)/gm;

/** A fragment's placeholder ids in first-DECLARATION order (the `- id:` key, never a stray `depends_on`). Empty means
 *  nothing to materialize, never an error. */
export function draftPlaceholderIds(fragmentYaml: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of fragmentYaml.matchAll(DRAFT_PLACEHOLDER_DECL_RE)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

/** Replace every mapped placeholder — a declaration or a reference — with its real id. Word-boundary-safe, so `NEW-1`
 *  never eats into `NEW-10`: a digit run has no `\b` before it. */
export function substitutePlaceholderIds(text: string, mapping: ReadonlyMap<string, string>): string {
  let out = text;
  for (const [placeholder, real] of mapping) {
    out = out.replace(new RegExp(`\\b${placeholder}\\b`, "g"), real);
  }
  return out;
}

/** What {@link materializeDraftTaskIds} needs FROM its caller, I/O-injected so its decision logic stays pure — the
 *  same mint/reserve split `rmd triage` and `rmd plan` already wire in. */
export interface DraftTaskIdMintDeps {
  /** The shared mint (lib/task-id.ts's derivation, or run-task.ts's history-layered wrapper) — called ONCE, after the
   *  placeholder count is known, before anything is reserved. */
  mint(): { n: number; degraded: { source: string; reason: string }[] };
  /** Reserve `count` ids at or above `startId` as a block; THROWS on a non-contention failure, such as an unwritable
   *  state dir. */
  reserveBlock(startId: number, count: number): { ids: number[] };
}

export type DraftTaskIdMaterialization =
  | { ok: true; fragmentYaml: string; stampLine: string; ids: string[] }
  | { ok: false; reason: string };

/** Materialize `NEW-<n>` placeholders into concrete, RESERVED `W1-Tnnn` ids. DEGRADE HONESTLY, NEVER GUESS — a
 *  degraded mint, or a reservation failing for anything but contention, REFUSES rather than falling back to an
 *  unreserved id, and the caller must treat `{ ok: false }` as "write nothing, open no PR": a duplicate id on main
 *  breaks `loadPlan`. */
export function materializeDraftTaskIds(
  payload: { fragmentYaml: string; stampLine: string },
  deps: DraftTaskIdMintDeps,
): DraftTaskIdMaterialization {
  const placeholders = draftPlaceholderIds(payload.fragmentYaml);
  if (placeholders.length === 0) {
    return { ok: true, fragmentYaml: payload.fragmentYaml, stampLine: payload.stampLine, ids: [] };
  }

  const mint = deps.mint();
  if (mint.degraded.length > 0) {
    const sources = mint.degraded.map((d) => `${d.source} (${d.reason})`).join("; ");
    return { ok: false, reason: `task-id mint degraded — refusing rather than risk a collision: ${sources}` };
  }

  let block: { ids: number[] };
  try {
    block = deps.reserveBlock(mint.n, placeholders.length);
  } catch (e) {
    return { ok: false, reason: `task-id reservation failed: ${String((e as Error)?.message ?? e)}` };
  }

  const mapping = new Map<string, string>(placeholders.map((placeholder, i) => [placeholder, `W1-T${block.ids[i]}`]));
  return {
    ok: true,
    fragmentYaml: substitutePlaceholderIds(payload.fragmentYaml, mapping),
    stampLine: substitutePlaceholderIds(payload.stampLine, mapping),
    ids: [...mapping.values()],
  };
}

// ── rmd reframe — feedback redrafts through the ledger (MASTER-PLAN P25 iii, W1-T111) ────

export interface ReframeResult {
  /** The proposal with `feedback` appended (verbatim) to its reframe history. */
  proposal: Proposal;
  /** The draft cache with this proposal's cached draft INVALIDATED (removed). */
  drafts: DraftCache;
}

/** Parse an `rmd reframe --supersedes <expr>` expression (W1-T194) against the CURRENT `reframeHistory.length`, in
 *  the 1-indexed numbering {@link inboxDraftPrompt} renders. Accepts numbers, inclusive ranges and `"ALL"`; returns
 *  `null` for anything not definite and in range, because retraction must be EXPLICIT, never inferred from recency. */
export function parseSupersedesExpr(expr: string, historyLength: number): number[] | null {
  if (historyLength <= 0) return null;
  const trimmed = expr.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.toUpperCase() === "ALL") {
    return Array.from({ length: historyLength }, (_, i) => i + 1);
  }
  const rounds = new Set<number>();
  for (const part of trimmed.split(",")) {
    const token = part.trim();
    const rangeMatch = /^(\d+)-(\d+)$/.exec(token);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (start < 1 || end < start || end > historyLength) return null;
      for (let n = start; n <= end; n++) rounds.add(n);
      continue;
    }
    if (!/^\d+$/.test(token)) return null;
    const n = Number(token);
    if (n < 1 || n > historyLength) return null;
    rounds.add(n);
  }
  if (rounds.size === 0) return null;
  return [...rounds].sort((a, b) => a - b);
}

/** `rmd reframe <P##> --feedback "<text>" [--supersedes <rounds>]` — the objection is captured VERBATIM and ledgered
 *  as `ratify.reframed`, the cached draft is invalidated so the next pass re-drafts, and the feedback joins
 *  `reframeHistory`. Opens NO PR and is valid for ANY state — the "one bit OR feedback" choice P25 promises.
 *  `supersedes` marks EXISTING rounds `retracted` in place: their text and ledger lines survive, but the prompt stops
 *  emitting them. */
export function reframeProposal(
  proposal: Proposal,
  feedback: string,
  drafts: DraftCache,
  deps: RatifyLedgerDeps,
  supersedes?: number[],
): ReframeResult {
  const priorHistory = proposal.reframeHistory ?? [];
  const retractSet = new Set(supersedes ?? []);
  const updatedHistory: ReframeRecord[] =
    retractSet.size === 0 ? priorHistory : priorHistory.map((r, i) => (retractSet.has(i + 1) ? { ...r, retracted: true } : r));
  const reframedProposal: Proposal = {
    ...proposal,
    reframeHistory: [...updatedHistory, { feedback }],
  };
  appendLedger(deps.ledgerPath, {
    run_id: deps.runId,
    task_id: proposal.id,
    step: "ratify.reframed",
    feedback,
    ...(supersedes && supersedes.length > 0 ? { supersedes } : {}),
  });
  return { proposal: reframedProposal, drafts: invalidateDraft(drafts, proposal.id) };
}

// ── Approve/reframe telemetry — the retro's fatigue signal (MASTER-PLAN P25 iv, W1-T111) ─
//
// The failure mode is the rubber-stamp queue: a sustained approval rate near 100% means the bit has become ceremony
// [research: hitl-approval-fatigue-2026]. Reduced the way retro.ts's own gather is, and rendered as a section the
// harness appends.

export interface RatifyTelemetry {
  approved: number;
  reframed: number;
  /** approved / (approved + reframed); 0 when there is no ratify activity yet. */
  rate: number;
}

/** Reduce parsed ledger records into the approve/reframe counts + rate. */
export function ratifyTelemetry(records: { step?: unknown }[]): RatifyTelemetry {
  const approved = records.filter((r) => r.step === "ratify.approved").length;
  const reframed = records.filter((r) => r.step === "ratify.reframed").length;
  const total = approved + reframed;
  return { approved, reframed, rate: total === 0 ? 0 : approved / total };
}

/** Render {@link ratifyTelemetry}'s result as a retro-report section. */
export function renderRatifyTelemetry(t: RatifyTelemetry): string {
  const pct = Math.round(t.rate * 100);
  const activity = t.approved + t.reframed === 0 ? " (no ratify activity yet)" : "";
  return [
    "## Ratification telemetry (rmd approve/reframe — MASTER-PLAN P25 ii-iv, W1-T111)",
    `Approved: ${t.approved} · Reframed: ${t.reframed} · Approval rate: ${pct}%${activity}`,
  ].join("\n");
}
