import { execFileSync } from "node:child_process";
// The DEFAULT export -- a plain, mutable object -- so a test's `t.mock.method` can
// actually intercept the calls `updateProposalRegistry` makes (named bindings off
// `node:fs` are non-configurable; mocking them throws "Cannot redefine property"
// instead of installing a spy). Same import-shape comment as src/lib/worker.ts's
// run.lock / src/lib/status.ts's projection cache, the two atomic-write precedents this
// module's own registry writer mirrors.
import fs from "node:fs";
import { dirname } from "node:path";
import type { MergedResolver, Plan } from "./plan.js";
import { parseTasksFromYaml, PlanError, unmetDependencies } from "./plan.js";
import { lintPlan } from "./task-linter.js";
import { appendLedger } from "./ledger.js";
import { defaultIsPidAlive } from "./drain-lock.js";
import { buildPlanPrCommitMessage } from "./plan-pr-emitter.js";
import { workerLedgerFields, type WorkerResult } from "./worker.js";

/**
 * `rmd inbox` — the ratification inbox's DETERMINISTIC CORE (MASTER-PLAN P25(i), W1-T110).
 *
 * P25's operator requirement, verbatim: "rmd should recommend what's ready to be ratified
 * and just request a thumbs up on each to agree, or a way to provide feedback to
 * reframe/replan the item." The 2026 field finding this task encodes is that approval
 * controls fail by FATIGUE — reflexive approval is a documented clickthrough
 * vulnerability, and the cure is risk-tiering plus surfacing only what is genuinely
 * actionable [research: hitl-approval-fatigue-2026]. This module is the TIERING: only
 * READY proposals ever surface, readiness is COMPUTED not asserted, and a proposal whose
 * trigger has not fired is DEFERRED-WITH-TRIGGER, never recommended (the P19/WS-2
 * dead-consumer discipline, now code).
 *
 * THE SPLIT (mirrors lib/plan-architect.ts and lib/dep-review.ts): drafting a candidate
 * ratification — a `plan/tasks.yaml` fragment + the MASTER-PLAN.md stamp line — is the
 * LLM's job (a bounded Architect worker, harness-spawned by run-task.ts, via
 * {@link runDraftRung} below). EVERYTHING AFTER drafting is deterministic:
 * {@link classifyProposal} is a PURE function (rule 2, policy-as-data) over an
 * already-drafted candidate + injected facts about the world (dependency merge-state,
 * evidence-anchor grep-truth, lint cleanliness, open conflicts) — no LLM call anywhere in
 * this module, so every branch is a unit fixture.
 *
 * DAEMON-SIDE, NOT CLI-PULL (W1-T192): the draft rung runs on the daemon's own poll cadence
 * (run-task.ts's `buildInboxDraftHook`, riding the SAME `deps.sweep()` seam the W1-T150
 * credit-backfill rung occupies) — a fired trigger or an invalidated (reframed) draft gets
 * redrafted there, with NO CLI invocation required. `rmd inbox` (`inboxCommand`) is a
 * viewer AND a manual force, never the only trigger — see {@link proposalsNeedingDraft}
 * (the shared, unthrottled predicate) vs {@link draftsDueOnDaemon} (the daemon's own
 * idempotence-throttled selection) below.
 *
 * READY = drafted tasks' deps all merged (deriveStatus, corrections-supreme, via the
 * caller's injected {@link MergedResolver}) AND the proposal's cited evidence anchors
 * still grep-true on main AND the drafted fragment passes `rmd lint-plan` AND no open
 * proposal conflicts. Otherwise the proposal is NOT_READY, each failing predicate named
 * (dep-unmet / evidence-drifted / draft-unclean / conflict) — or, when the proposal
 * names an unfired trigger (the P19/WS-2 "unbuilt consumer" case), DEFERRED_WITH_TRIGGER,
 * checked FIRST and unconditionally: a proposal whose consumer is not yet real is never
 * surfaced as a recommendation, no matter what the other four predicates say.
 *
 * `rmd approve` / `rmd reframe` (MASTER-PLAN P25 ii-iv, W1-T111) — the other half of the
 * inbox loop, appended below: APPROVE ({@link approveProposal}) is one bit that INITIATES
 * the plan PR for a READY classification's cached draft (never re-derived) through a
 * gate-injected {@link RatifyGateway}, refusing anything not READY with zero side effects;
 * REFRAME ({@link reframeProposal}) captures the operator's feedback verbatim, invalidates
 * the stale draft, and rides it into the NEXT {@link inboxDraftPrompt}. Both ledger exactly
 * one `ratify.*` line per call; {@link ratifyTelemetry} reduces those lines into the
 * approve/reframe rate the retro surfaces — the field's failure mode is a rubber-stamp
 * queue, so that rate is instrumentation, not decoration.
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

/** A named, not-yet-fired precondition (MASTER-PLAN's HELD/TRIGGER proposal shape, e.g.
 *  P28's "ratify after W1-T110/W1-T111 ship"). `fired` is resolved by the CALLER — this
 *  module never guesses whether a trigger condition holds. */
export interface ProposalTrigger {
  description: string;
  fired: boolean;
}

/** One round of `rmd reframe` feedback (P25 iii, W1-T111) — captured VERBATIM, never
 *  summarized, so the redraft prompt carries the operator's own words. */
export interface ReframeRecord {
  feedback: string;
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
  /** Every `rmd reframe` round this proposal has been through, oldest first — "the
   *  reframe history rides the proposal until resolution" (P25 iii design). Empty/absent
   *  for a proposal that has never been reframed. */
  reframeHistory?: ReframeRecord[];
}

// ── Drafted candidate (the LLM's output — a value from here on, never re-invoked) ─────────

/** The Architect's draft for one proposal: a `plan/tasks.yaml` fragment + the
 *  MASTER-PLAN.md ratification stamp line, cached STATE-SIDE (never committed —
 *  `<config.root>/state/inbox-drafts.json`, never a repo path). */
export interface DraftedCandidate {
  proposalId: string;
  /** YAML text of the new task(s), parseable by {@link "./plan.js".loadPlanFromYaml}. */
  fragmentYaml: string;
  /** The MASTER-PLAN.md proposal-list stamp line the approve rung (W1-T111) will use. */
  stampLine: string;
  /** {@link anchorFingerprint} of the proposal's evidence anchors AT DRAFT TIME — the
   *  cache key the next inbox pass compares against to decide whether the cached draft
   *  is still current or must be re-drafted. */
  anchorFingerprint: string;
}

/**
 * Order-independent digest of an anchor set — the draft cache's invalidation key. Pure
 * string composition (no crypto — this only needs to detect "the anchor SET changed
 * since this draft was cached", not to be collision-proof against adversarial input).
 */
export function anchorFingerprint(anchors: EvidenceAnchor[]): string {
  return anchors
    .map((a) => `${a.pattern}::${a.path ?? ""}`)
    .sort()
    .join("|");
}

/** True when a cached draft was computed against a DIFFERENT anchor set than the
 *  proposal's CURRENT one — "invalidated when main moves past the proposal's evidence
 *  anchors" (design). Orthogonal to (and checked alongside) whether each anchor is
 *  currently grep-true: a fixture that "moves" an anchor typically flips both at once. */
export function isDraftStale(draft: DraftedCandidate, currentAnchors: EvidenceAnchor[]): boolean {
  return draft.anchorFingerprint !== anchorFingerprint(currentAnchors);
}

// ── The draft rung's "needs a draft" predicate (W1-T192) ──────────────────────────────────
//
// Both `rmd inbox` (CLI, on-demand) and the daemon's per-poll draft rung must select the
// SAME set of drafting candidates from the SAME facts — "REUSE it rather than re-deriving,
// so the daemon and the CLI can never disagree about what is draftable" (design). This is
// that ONE predicate; everything below layers on top of it.

/** Every proposal that currently needs a fresh draft: not deferred by an unfired trigger,
 *  and either never drafted or its cached draft is stale ({@link isDraftStale}). Deliberately
 *  takes NO attempt-throttle input — this is the UNTHROTTLED predicate `rmd inbox`'s manual
 *  force uses (design: "`rmd inbox` KEEPS ITS ROLE... able to force a draft on demand"). The
 *  daemon-side rung layers {@link draftsDueOnDaemon}'s idempotence throttle on TOP of this,
 *  never instead of it. */
export function proposalsNeedingDraft(proposals: Proposal[], drafts: DraftCache): Proposal[] {
  return proposals.filter((p) => {
    if (p.trigger && !p.trigger.fired) return false; // never drafted for a dead-consumer proposal
    const cached = drafts[p.id];
    return !cached || isDraftStale(cached, p.evidenceAnchors);
  });
}

// ── Daemon-side idempotence (W1-T192) ──────────────────────────────────────────────────────
//
// The draft rung now spawns from an UNATTENDED 300s daemon poll (buildSweepHook's cadence,
// run-task.ts), not only from a human typing `rmd inbox`. A single invalidation (a reframe
// round, an evidence anchor moving) must produce ONE draft attempt, never one per poll — the
// same "keyed to a stable cause, not to poll count" discipline the fix rung applies to a
// head sha. {@link draftAttemptKey} is that stable cause fingerprint; {@link DraftAttemptCache}
// records the key the daemon LAST ATTEMPTED (successfully or not) per proposal, distinct from
// {@link DraftCache} (which records only SUCCESSFUL drafts) precisely so a FAILED attempt does
// not get repeated every poll for the same cause either.

/** A proposal's current "draft cause" fingerprint: its evidence-anchor set plus how many
 *  `rmd reframe` rounds it has been through. This changes exactly when something that would
 *  make a genuinely DIFFERENT draft worth attempting changes — a new reframe round, or the
 *  anchor set moving — never on poll count alone. */
export function draftAttemptKey(proposal: Proposal): string {
  return `${anchorFingerprint(proposal.evidenceAnchors)}::${(proposal.reframeHistory ?? []).length}`;
}

/** `<config.root>/state/inbox-draft-attempts.json` — one {@link draftAttemptKey} per
 *  proposal id, recording the cause the DAEMON rung last attempted a draft for (win or
 *  lose). Daemon-only: `rmd inbox`'s manual force never reads or writes this cache — see
 *  {@link proposalsNeedingDraft}'s doc. */
export interface DraftAttemptCache {
  [proposalId: string]: string;
}

/** Parse a {@link DraftAttemptCache} JSON blob; `{}` on missing/malformed input (mirrors
 *  {@link parseDraftCache}'s fail-soft-to-empty discipline — a daemon that has never
 *  attempted a draft yet is the normal pre-population state, not an error). */
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

/** Proposals the DAEMON-SIDE draft rung should attempt THIS poll: {@link proposalsNeedingDraft}
 *  further throttled by {@link DraftAttemptCache} so a 300s poll cadence never re-spawns the
 *  Architect for the SAME cause — a proposal is due again only once its {@link draftAttemptKey}
 *  has actually changed since the daemon's last attempt (or it has never been attempted at
 *  all). `rmd inbox` never calls this — it calls {@link proposalsNeedingDraft} directly,
 *  unthrottled, which is what makes it a genuine manual force. */
export function draftsDueOnDaemon(proposals: Proposal[], drafts: DraftCache, attempts: DraftAttemptCache): Proposal[] {
  return proposalsNeedingDraft(proposals, drafts).filter((p) => attempts[p.id] !== draftAttemptKey(p));
}

/** `<config.root>/state/inbox-draft-inflight.json` — proposal id -> ISO spawn timestamp,
 *  for whichever proposals the daemon's draft rung (buildInboxDraftHook, run-task.ts)
 *  currently has an Architect worker running for (W1-T193). Written just before the batch's
 *  {@link runDraftRung} call and cleared in a `finally` once it resolves (win or lose), so a
 *  crash mid-draft is the only way an entry here can go stale — the same "never lies about
 *  its own state" bar W1-T156 set for liveness. Distinct from {@link DraftAttemptCache}
 *  (records the LAST-ATTEMPTED cause, kept indefinitely) — this cache only ever names what
 *  is happening RIGHT NOW. */
export interface DraftInFlightCache {
  [proposalId: string]: string;
}

/** Parse a {@link DraftInFlightCache} JSON blob; `{}` on missing/malformed input (mirrors
 *  {@link parseDraftAttemptCache}'s fail-soft-to-empty discipline). */
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

export type FailingPredicate = "drafted" | "deps_merged" | "evidence_anchors" | "lint_clean" | "no_conflict";

export interface PredicateFailure {
  predicate: FailingPredicate;
  detail: string;
}

export type InboxState = "ready" | "not_ready" | "deferred_with_trigger" | "ratified" | "drafting";

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
  /** Present iff state === "drafting" — when the in-flight Architect worker for this
   *  proposal's draft was spawned (W1-T193's "never renders nothing during a legitimate
   *  multi-minute mid-draft window" bar). */
  draftSpawnedAt?: string;
}

export interface ReadinessContext {
  /** The CURRENT plan (plan/tasks.yaml on main) the drafted tasks would land into —
   *  resolves depends_on ids the fragment cites that already exist. */
  plan: Plan;
  /** Landed-ness resolver — GITHUB-DERIVED (deriveStatus) in the real runner, a plain
   *  yaml-status check in fixtures. */
  isMerged: MergedResolver;
  /** Whether one evidence anchor is still grep-true (on main, in the real runner). */
  grepAnchorTrue: (anchor: EvidenceAnchor) => boolean;
  /** Every OTHER proposal id currently open (not yet ratified) — the conflict source. */
  openProposalIds: Set<string>;
  /**
   * True when the LEDGER already carries a `ratify.approved` line for this proposal id —
   * checked FIRST, unconditionally, and OVERRIDING whatever the registry's own copy of this
   * proposal claims (W1-T190). `rmd approve`'s ledger append and its registry rewrite are two
   * independent writes; one can succeed while the other does not (a crash, an interrupted
   * run), and a registry entry left stale by that drift must never be trusted at face value —
   * the ledger is the one authoritative receipt. Real implementations derive this from
   * {@link isRatifiedInLedger} over `readLedgerLines(ledgerPath)`; the P19 incident this task
   * fixes is exactly a registry entry that drifted from an already-ledgered `ratify.approved`.
   */
  isRatified: (proposalId: string) => boolean;
  /**
   * Present iff the daemon's draft rung currently has an Architect worker running for this
   * proposal id (W1-T193) — returns the ISO spawn timestamp, or `undefined` when no draft
   * attempt is in flight for it. Real implementations derive this from
   * {@link DraftInFlightCache} (`state/inbox-draft-inflight.json`); optional so every existing
   * fixture/caller that never had a reason to think about drafting-in-flight is unaffected.
   */
  draftSpawnedAt?: (proposalId: string) => string | undefined;
}

/**
 * The ledger's own answer to "has this proposal already been ratified?" — the predicate
 * {@link ReadinessContext.isRatified} wraps in the real runner. Re-derived from the ledger on
 * EVERY read rather than trusted from any stored registry flag, so an EXISTING drifted
 * registry entry (the P19 case: `ratify.approved` landed in the ledger while the registry
 * entry sat untouched for three more hours) is healed the next time anything classifies it —
 * no migration step required, because nothing here ever trusted the stale copy in the first
 * place.
 */
export function isRatifiedInLedger(ledgerLines: { step?: unknown; task_id?: unknown }[], proposalId: string): boolean {
  return ledgerLines.some((l) => l.step === "ratify.approved" && l.task_id === proposalId);
}

/**
 * Parse a drafted fragment's tasks — WITHOUT requiring every `depends_on` id to resolve
 * within the fragment itself (a fragment legitimately depends on tasks elsewhere in the
 * real plan, which {@link unmetOutsideDeps} checks against the merged plan separately,
 * a STRONGER check: an id that resolves nowhere is also necessarily unmerged, so it
 * surfaces as dep-unmet rather than a redundant parse failure). A genuine schema/YAML
 * problem (bad field types, duplicate ids, invalid risk/status, unparseable YAML) IS a
 * draft-unclean (lint) violation, not a crash — a fragment the linter can't even load
 * can never be READY. */
function safeParseFragment(fragmentYaml: string, proposalId: string): { plan: Plan } | { error: string } {
  try {
    const tasks = parseTasksFromYaml(fragmentYaml, `inbox draft ${proposalId}`);
    return { plan: { tasks, byId: new Map(tasks.map((t) => [t.id, t])) } };
  } catch (e) {
    return { error: e instanceof PlanError ? e.message : String(e) };
  }
}

/** Merge a drafted fragment's tasks into the base plan — later (fragment) entries win,
 *  so a fragment task with the same id as an existing one shadows it for dep resolution. */
function mergedPlan(base: Plan, fragment: Plan): Plan {
  const byId = new Map(base.byId);
  for (const t of fragment.tasks) byId.set(t.id, t);
  return { tasks: [...byId.values()], byId };
}

/**
 * Dependency ids a drafted fragment's tasks name OUTSIDE the fragment itself (already
 * merged) that are not (yet) merged. A drafted task depending on a SIBLING task in the
 * SAME fragment is exempt — both land in the same plan PR together, so that is an
 * intra-fragment ordering concern, not an unmet-dependency one.
 */
function unmetOutsideDeps(basePlan: Plan, fragmentPlan: Plan, isMerged: MergedResolver): string[] {
  const fragmentIds = new Set(fragmentPlan.tasks.map((t) => t.id));
  const merged = mergedPlan(basePlan, fragmentPlan);
  const out: string[] = [];
  for (const task of fragmentPlan.tasks) {
    for (const dep of unmetDependencies(merged, task, isMerged)) {
      if (fragmentIds.has(dep)) continue;
      out.push(`${task.id}->${dep}`);
    }
  }
  return out;
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

/**
 * The PURE readiness predicate. Trigger-deferral is checked FIRST and unconditionally —
 * a proposal naming an unfired trigger is DEFERRED_WITH_TRIGGER no matter what the other
 * four AND-clauses would otherwise say (the dead-consumer discipline: never recommend a
 * ratification whose consumer does not yet exist). Every other branch collects EVERY
 * failing predicate, not just the first — "each non-ready names its failing predicate"
 * means the whole set, not a first-match short-circuit.
 */
export function classifyProposal(
  proposal: Proposal,
  draft: DraftedCandidate | undefined,
  ctx: ReadinessContext,
): InboxClassification {
  // W1-T190: the ledger's ratify.approved receipt is checked FIRST, unconditionally, and
  // OVERRIDES every other predicate below (including the trigger check) — a proposal the
  // ledger already says is ratified is NEVER re-offered as READY (or as anything else that
  // implies more approve action is possible), no matter what the registry's own copy of it
  // still claims. This is the read-side half of the fix: the write-side half (the registry
  // rewrite in run-task.ts's approveCommand) keeps the common case clean, but this check is
  // what heals an EXISTING drifted entry, since it never trusts a stored flag at all.
  if (ctx.isRatified(proposal.id)) {
    return { proposalId: proposal.id, state: "ratified", reasons: [] };
  }
  // W1-T193: an Architect worker currently drafting this proposal is checked next, before the
  // ordinary not-ready/deferred predicates below — a proposal legitimately mid-draft for
  // minutes (W1-T192's daemon-side rung) must never render as "not ready" (indistinguishable
  // from broken) or fall through to a NOT_READY "no drafted candidate yet" that will be stale
  // the moment the draft lands. In practice this never collides with the trigger check below —
  // `proposalsNeedingDraft` already excludes an unfired-trigger proposal from ever being
  // selected for drafting — but the order here is defensive, not load-bearing on that fact.
  const draftSpawnedAt = ctx.draftSpawnedAt?.(proposal.id);
  if (draftSpawnedAt) {
    return { proposalId: proposal.id, state: "drafting", reasons: [], draftSpawnedAt };
  }
  if (proposal.trigger && !proposal.trigger.fired) {
    return {
      proposalId: proposal.id,
      state: "deferred_with_trigger",
      // No AND-clause reasons here — the trigger gate is checked BEFORE those four and
      // short-circuits regardless of what they'd say; {@link ProposalTrigger} names the
      // unfired condition, which is the whole reason this proposal is never recommended.
      reasons: [],
      trigger: proposal.trigger,
    };
  }

  const reasons: PredicateFailure[] = [];

  if (!draft) {
    reasons.push({ predicate: "drafted", detail: "not-drafted: no drafted candidate available yet" });
    return { proposalId: proposal.id, state: "not_ready", reasons };
  }

  const draftStale = isDraftStale(draft, proposal.evidenceAnchors);

  const fragment = safeParseFragment(draft.fragmentYaml, proposal.id);
  if ("error" in fragment) {
    reasons.push({ predicate: "lint_clean", detail: `draft-unclean: fragment failed to parse — ${fragment.error}` });
  } else {
    const unmet = unmetOutsideDeps(ctx.plan, fragment.plan, ctx.isMerged);
    if (unmet.length > 0) {
      reasons.push({ predicate: "deps_merged", detail: `dep-unmet: ${unmet.join(", ")} not merged` });
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
    return { proposalId: proposal.id, state: "ready", reasons: [], draftStale, draft };
  }
  return { proposalId: proposal.id, state: "not_ready", reasons, draftStale };
}

// ── The draft rung: pure prompt + parser (LLM call is harness-owned, run-task.ts) ─────────

/**
 * The bounded Architect worker's prompt for ONE proposal — asks for ONLY a `plan/tasks.yaml`
 * fragment + the MASTER-PLAN.md stamp line, nothing else. The worker has Read/Grep/Glob only
 * (no Write/Edit/Bash — see run-task.ts's `INBOX_DRAFT_WORKER_TOOLS`): it never touches a
 * file, it only produces text the harness parses with {@link parseDraftedCandidate} and
 * caches state-side. Mirrors lib/plan-architect.ts's single-prompt-definition discipline.
 */
export function inboxDraftPrompt(proposal: Proposal, currentPlanText: string, runId: string): string {
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
    ...(proposal.reframeHistory && proposal.reframeHistory.length > 0
      ? [
          "=== OPERATOR FEEDBACK (rmd reframe, P25 iii — address EVERY round below in this redraft) ===",
          ...proposal.reframeHistory.map((r, i) => `${i + 1}. ${r.feedback}`),
          "",
        ]
      : []),
    "=== GROUND ===",
    "Grep/Read MASTER-PLAN.md, LEARNINGS.md, and DECISIONS.md for what is already decided; the",
    "current plan/tasks.yaml is pasted below so you cite REAL existing task ids in depends_on.",
    "",
    "=== plan/tasks.yaml (current, for depends_on grounding) ===",
    currentPlanText,
    "",
    "=== OUTPUT (exactly this shape, nothing else) ===",
    "Print ONE or more new tasks.yaml entries (schema v1 — id/title/repo/depends_on/type/verify/",
    "risk/status/attempts/acceptance/origin at minimum) between the two FRAGMENT markers below,",
    "then ONE stamp line for MASTER-PLAN.md's proposal list between the two markers below that —",
    "the same shape as an existing RATIFIED stamp (`- P## (...) — RATIFIED <date> -> <task ids>.`).",
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

/**
 * Extract the worker's FRAGMENT + STAMP off its concatenated output text. LAST-marker-wins
 * (mirrors lib/triage.ts's `parseTriageVerdict` / lib/plan-architect.ts's `parsePlanVerdict`
 * discipline — a worker's final answer, after any scratch reasoning, is the one that counts).
 * Returns `null` when either marker is missing — a malformed draft is never silently treated
 * as a candidate.
 */
export function parseDraftedCandidate(text: string): ParsedDraft | null {
  const fragments = [...text.matchAll(FRAGMENT_RE)];
  const stamps = [...text.matchAll(STAMP_RE)];
  if (fragments.length === 0 || stamps.length === 0) return null;
  return {
    fragmentYaml: fragments[fragments.length - 1][1].trim(),
    stampLine: stamps[stamps.length - 1][1].trim(),
  };
}

// ── The draft rung's INJECTABLE orchestration core (W1-T192) ─────────────────────────────
//
// One Architect spawn per proposal is still the harness's job (run-task.ts materializes a
// worktree and calls worker.ts's real `spawnWorker`) — but WHICH proposals get attempted,
// how each spawn's output is parsed/logged, and whether one proposal's failure can strand
// the rest of the batch, is exactly the "pure core / harness-owned I/O" split this module's
// header describes for lib/plan-architect.ts/lib/dep-review.ts. `deps.spawn` is the ONE
// injected side effect (mirrors lib/sweep.ts's `SweepDeps.dispatchFix`/lib/review.ts's
// `runFixRung` `deps.spawn`), so both `rmd inbox` and the daemon rung ride this SAME loop
// and it is provable from a unit fixture with no real worktree/gh/LLM call anywhere.

/** One Architect worker call for one proposal's draft prompt — real wiring (run-task.ts)
 *  calls worker.ts's `spawnWorker` inside an already-materialized worktree; tests inject a
 *  fake. Returns the full {@link WorkerResult} so {@link runDraftRung} can log the SAME
 *  `workerLedgerFields` every other spawn site ledgers (cost/tokens/compaction/etc). */
export type DraftSpawn = (proposal: Proposal, prompt: string) => Promise<WorkerResult>;

export interface DraftRungDeps {
  spawn: DraftSpawn;
  log: (step: string, extra?: Record<string, unknown>) => void;
}

/** One proposal's draft-rung outcome — `ok: true` carries the {@link DraftedCandidate} to
 *  cache; `ok: false` names why (a malformed worker output, OR a genuine spawn-level
 *  exception) without ever throwing out of {@link runDraftRung}. */
export type DraftRungOutcome =
  | { proposalId: string; ok: true; candidate: DraftedCandidate }
  | { proposalId: string; ok: false; error: string };

/**
 * Draft EVERY proposal in `toDraft` against `currentPlanText`, via {@link inboxDraftPrompt} +
 * {@link parseDraftedCandidate}. Each proposal's spawn+parse is isolated in its OWN try/catch
 * — W1-T192's fail-soft requirement: a genuine spawn-level exception for one proposal (a
 * network hiccup, an API error — distinct from the "no FRAGMENT/STAMP markers" malformed-
 * output case, which was already tolerated pre-W1-T192) never prevents the REST of the batch
 * from being attempted. This is what makes the SAME loop safe to call from an unattended
 * daemon poll, not only from a human watching `rmd inbox`'s output. Never throws.
 */
export async function runDraftRung(toDraft: Proposal[], currentPlanText: string, deps: DraftRungDeps, runId: string): Promise<DraftRungOutcome[]> {
  const outcomes: DraftRungOutcome[] = [];
  for (const proposal of toDraft) {
    try {
      const worker = await deps.spawn(proposal, inboxDraftPrompt(proposal, currentPlanText, runId));
      deps.log("inbox.draft_synthesized", {
        proposal_id: proposal.id,
        session_id: worker.sessionId,
        cost_usd: worker.costUsd,
        subtype: worker.subtype,
        ...workerLedgerFields(worker),
      });
      const parsed = parseDraftedCandidate([worker.text, worker.blocks.join("\n")].join("\n"));
      if (!parsed) {
        const error = "no FRAGMENT/STAMP markers in worker output";
        deps.log("inbox.draft_error", { proposal_id: proposal.id, error });
        outcomes.push({ proposalId: proposal.id, ok: false, error });
        continue;
      }
      const candidate: DraftedCandidate = {
        proposalId: proposal.id,
        fragmentYaml: parsed.fragmentYaml,
        stampLine: parsed.stampLine,
        anchorFingerprint: anchorFingerprint(proposal.evidenceAnchors),
      };
      deps.log("inbox.drafted", { proposal_id: proposal.id });
      outcomes.push({ proposalId: proposal.id, ok: true, candidate });
    } catch (e) {
      const error = String((e as Error)?.message ?? e);
      deps.log("inbox.draft_error", { proposal_id: proposal.id, error });
      outcomes.push({ proposalId: proposal.id, ok: false, error });
    }
  }
  return outcomes;
}

// ── Real-world evidence-anchor adapter (git grep, never a network call) ──────────────────

/**
 * REAL {@link ReadinessContext.grepAnchorTrue} implementation: `git grep` for the anchor's
 * pattern on `ref` (typically `origin/main`), scoped to `path` when given. `git grep`'s own
 * exit codes distinguish the two cases precisely: 0 (a match) ⇒ true; EXACTLY 1 (no match,
 * clean search) ⇒ false; anything else — 128 (bad ref/pathspec), a signal, git not found,
 * … — is a genuine error and is thrown, never silently folded into "not grep-true" (the same
 * status-vs-signal split lib/review.ts's `runWhitelistedProof` uses, refined to git grep's
 * specific 0/1/128 vocabulary rather than "any status is a clean fail").
 */
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

/** Human-readable inbox listing — READY items carry their drafted tasks; every non-ready
 *  item names its failing predicate(s); a deferred item names its trigger and is never
 *  presented as a recommendation. This is the ONLY rendering `rmd inbox` prints from. */
export function renderInbox(classifications: InboxClassification[]): string {
  if (classifications.length === 0) return "rmd inbox: no active proposals.";
  const lines: string[] = [];
  const ready = classifications.filter((c) => c.state === "ready");
  const deferred = classifications.filter((c) => c.state === "deferred_with_trigger");
  const notReady = classifications.filter((c) => c.state === "not_ready");
  const ratified = classifications.filter((c) => c.state === "ratified");
  const drafting = classifications.filter((c) => c.state === "drafting");

  lines.push(
    `rmd inbox: ${ready.length} READY, ${notReady.length} not ready, ${deferred.length} deferred-with-trigger, ` +
      `${drafting.length} drafting, ${ratified.length} already ratified.`,
  );
  for (const c of ready) {
    lines.push("");
    lines.push(`READY — ${c.proposalId}`);
    lines.push(`  stamp: ${c.draft?.stampLine ?? ""}`);
    lines.push(`  drafted tasks:\n${(c.draft?.fragmentYaml ?? "").replace(/^/gm, "    ")}`);
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
  // W1-T190: a ratified proposal is NEVER listed under READY, no matter what its own
  // predicates would otherwise say — offering the ratify affordance again on something the
  // backend (`rmd approve`) would refuse is the exact wrong-affordance shape W1-T182 removes
  // elsewhere. Named here so it is visible, never silently dropped from the summary count.
  for (const c of ratified) {
    lines.push("");
    lines.push(`RATIFIED — ${c.proposalId} (already ratified via a prior \`rmd approve\`; no longer active)`);
  }
  return lines.join("\n");
}

// ── The digest's ready-count block (W1-T112: the morning pulse) ──────────────────────────
//
// Same "latest wins" snapshot discipline as lib/ops.ts's AlertsPollSummary / lib/issues-
// intake.ts's IssuesPollSummary: `rmd inbox` ledgers ONE `inbox.polled` line per invocation
// carrying this summary, and digest.ts reads the LATEST such line inside its window — a
// snapshot of the CURRENT ready count, not an additive event count, exactly like a
// re-poll of unchanged alerts/issues never double-counts. Unlike alerts/issues, digest.ts
// renders this SOFT: no line at all when `rmd inbox` never polled inside the window,
// rather than an always-present "(no poll this window)" fallback — the inbox module can
// land or not without the digest's rendered shape ever depending on it.

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

// ── State-side registry shapes (harness reads/writes these; this module types them AND,
// as of W1-T240, owns the one real write-side helper every writer must share — see
// updateProposalRegistry below) ─────────────────────────────────────────────────────────

/** `<config.root>/state/inbox-proposals.json` — the ACTIVE-proposal registry. */
export interface ProposalRegistry {
  proposals: Proposal[];
}

/** `<config.root>/state/inbox-drafts.json` — the draft cache, keyed by proposal id. */
export interface DraftCache {
  [proposalId: string]: DraftedCandidate;
}

/** Parse a {@link ProposalRegistry} JSON blob; `[]` (never a throw) on missing/malformed
 *  input — an inbox with no registry yet is the normal pre-population state, not an error
 *  (mirrors lib/plan-index.ts's `loadPlanIndex` fail-soft-to-empty discipline). */
export function parseProposalRegistry(text: string | undefined): Proposal[] {
  if (!text) return [];
  try {
    const raw = JSON.parse(text) as unknown;
    const r = raw as { proposals?: unknown };
    if (typeof r !== "object" || r === null || !Array.isArray(r.proposals)) return [];
    return r.proposals as Proposal[];
  } catch {
    return [];
  }
}

// ── W1-T240: the ONE registry-write helper every writer of state/inbox-proposals.json
// goes through ─────────────────────────────────────────────────────────────────────────
//
// FOUR independent read-modify-write round trips on this file used to exist, each a
// plain `readFileSync` + `JSON.parse` + `writeFileSync` with no mutual exclusion and no
// atomicity: `rmd inbox`'s ratified-registry heal, `rmd approve`'s remove-on-ratify,
// `rmd reframe`'s feedback write (all three run-task.ts), and the serve daemon's OWN
// `GET /v1/inbox` heal (lib/panel-graph.ts) — the multi-writer path is genuine, not
// theoretical, because `rmd serve` is a LONG-LIVED daemon, so any concurrent CLI
// invocation overlaps it by construction. Two DIFFERENT failure modes result:
//   - TORN FILE — a reader's `readFileSync` lands mid another writer's `writeFileSync`
//     and observes a truncated/partial blob, which {@link parseProposalRegistry}'s
//     deliberate fail-soft "malformed → []" discipline turns into a SILENT empty
//     registry (every active proposal vanishes from `rmd inbox`), not a visible error.
//   - LOST UPDATE — two updaters both read the same old content, both compute a new
//     version from it, and whichever writes last wins outright, discarding the other's
//     change (a pruned/consumed proposal resurrected, or a heal silently undone).
//
// {@link updateProposalRegistry} fixes both, and is the ONLY sanctioned way to write
// this file (a fifth caller inherits the property by construction, never re-deriving
// it): an O_EXCL lockfile (`${registryPath}.lock`) serializes every call against this
// SAME path across every process that can write it — CLI invocations are independent OS
// processes, so an in-process "single writer function" alone cannot prevent a lost
// update between two of them; only a real inter-process lock can — and the write itself
// lands via a sibling temp file + `renameSync` (POSIX rename is atomic on the same
// filesystem, the SAME idiom already proven in this codebase at lib/status.ts's
// projection cache, lib/worker.ts's run.lock, and lib/ledger.ts's rotation writer), so a
// reader never observes a partial file. Unlike lib/drain-lock.ts / lib/inflight-lock.ts
// (both "refuse immediately, a whole SECOND long-running process is the bug" guards),
// a live holder of THIS lock is polled/retried up to `maxWaitMs` rather than refused —
// every real critical section here is a synchronous JSON read-transform-write done in
// microseconds, so a live holder means "wait a beat, it is about to release," not "a
// second command must not run." A holder whose pid is already dead (a crash mid-update)
// is reclaimed immediately via the same {@link defaultIsPidAlive} probe those two
// modules use, so a crash never wedges the lock for the next caller.
//
// `update` receives a FRESH parse of whatever is on disk RIGHT NOW (read under the
// lock), never a value some earlier, unlocked read produced — so a caller whose
// intended change was computed against a possibly-stale snapshot (e.g. "drop this one
// proposal id", or a ledger-derived set of ids to prune) still applies correctly
// against the latest state. Returning `null` skips the write entirely (the common,
// already-consistent case never touches disk).

export interface UpdateProposalRegistryOpts {
  /** Give up and throw if the lock can't be acquired within this long (ms). Default
   *  2000 — every real critical section here is a synchronous JSON read-transform-
   *  write, done in microseconds; a lock still held after 2s means a crashed holder
   *  {@link defaultIsPidAlive} somehow missed, not real contention. */
  maxWaitMs?: number;
  /** Poll interval while a live holder is waited out (ms). Default 20. */
  pollIntervalMs?: number;
  /** Injectable liveness probe (tests). Defaults to {@link defaultIsPidAlive}. */
  isPidAlive?: (pid: number) => boolean;
  /** Injectable blocking sleep (tests fake it to skip real delay). Default = a real,
   *  busy-wait-free sleep (mirrors lib/deployer.ts's own injected-sleep discipline). */
  sleep?: (ms: number) => void;
}

interface RegistryLockInfo {
  pid: number;
  startedAt: string;
}

function readRegistryLockInfo(lockPath: string): RegistryLockInfo | null {
  try {
    const o = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (typeof o?.pid === "number") return o as RegistryLockInfo;
    return null;
  } catch {
    return null; // missing, unreadable, or garbage → no valid holder
  }
}

function defaultRegistryLockSleep(ms: number): void {
  execFileSync("sleep", [String(ms / 1000)]);
}

/**
 * Read-modify-write `registryPath` (`state/inbox-proposals.json`), guarded end to end
 * against the lost-update/torn-file hazard this section's header doc describes. `update`
 * receives the CURRENT proposals (freshly re-read under the lock); returning the same
 * reference or a shallow-equal-in-spirit `null` skips the write. Returns the array
 * actually written, or `null` if nothing was.
 */
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
      // O_EXCL: create-or-fail, no TOCTOU gap — same discipline as acquireDrainLock /
      // acquireInflightLock (lib/drain-lock.ts, lib/inflight-lock.ts).
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      fs.closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const held = readRegistryLockInfo(lockPath);
      if (held && isAlive(held.pid)) {
        if (Date.now() >= deadline) {
          throw new Error(`updateProposalRegistry: timed out after ${maxWaitMs}ms waiting for ${lockPath} (held by pid ${held.pid})`);
        }
        sleep(pollIntervalMs);
        continue;
      }
      try {
        fs.unlinkSync(lockPath); // stale (dead pid / unreadable) — reclaim and retry
      } catch {
        // raced with another reclaimer between the read and the unlink; retry the create
      }
    }
  }

  try {
    const current = parseProposalRegistry(fs.existsSync(registryPath) ? fs.readFileSync(registryPath, "utf8") : undefined);
    const next = update(current);
    if (next === null) return null;
    // ATOMIC WRITE: sibling temp file + rename (see this section's header doc for the
    // in-tree precedent this mirrors). Every call is a live `fs.` property lookup (never
    // a destructured named import) so a test's `t.mock.method(fs, ...)` can intercept it —
    // see this file's `import fs from "node:fs"` comment.
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

/** Drop one proposal's cached draft — the invalidation `rmd reframe` applies so the next
 *  `rmd inbox` pass re-drafts rather than re-surfacing the stale candidate the operator
 *  just objected to. A no-op (returns an equivalent cache) when nothing is cached for
 *  `proposalId`. */
export function invalidateDraft(drafts: DraftCache, proposalId: string): DraftCache {
  const next: DraftCache = { ...drafts };
  delete next[proposalId];
  return next;
}

/**
 * W1-T190 (round 2): the read-side override in {@link classifyProposal} stops a drifted
 * registry entry from ever being MISCLASSIFIED again, but the drifted entry itself — the
 * P19-shaped row `rmd approve`'s registry write never reached — otherwise sits in
 * `state/inbox-proposals.json` forever, unless something actually writes the correction
 * back. "The ledger receipt is authoritative — a registry disagreeing with it is DETECTED
 * and corrected, not trusted" means BOTH halves: classification never trusts the stale
 * flag (already true), AND the stale flag itself gets healed, not merely worked around, the
 * next time anything classifies these proposals against the ledger. This is that healing
 * step: given the SAME proposals + classifications one inbox pass already computed, prune
 * every proposal the ledger now says is ratified, so any OTHER consumer of the registry
 * file that does not itself call {@link classifyProposal} — a future feature, a support
 * script, a human `cat`ing the JSON — sees the corrected state too, not just this pass's
 * in-memory override. A no-op (same array reference, empty `prunedIds`) when nothing needs
 * healing, so callers can skip the write entirely on the common (already-clean) path.
 */
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

// ── rmd approve — one bit ratifies through the gate (MASTER-PLAN P25 ii, W1-T111) ────────
//
// APPROVE = one bit: the operator's thumbs-up INITIATES the plan PR carrying the
// pre-drafted, lint-clean tasks + the RATIFIED stamp (rule 15 preserved — the human's
// approval initiates every plan edit; the gate still reviews; nothing auto-files without
// the bit). {@link approveProposal} is the pure DECISION (valid only for READY, one
// gateway call each, one ledger line); the git/gh SIDE EFFECTS are injected via
// {@link RatifyGateway} (mirrors lib/escalate.ts's `IssueGateway` split) so this is
// unit-testable without touching a real repo.

/** The exact fragment + stamp a READY classification carries — what `rmd approve` ships
 *  into the plan PR VERBATIM, never re-derived from the proposal at approve time (the
 *  draft the operator is approving is the SAME draft `rmd inbox` showed them). */
export interface RatificationPayload {
  proposalId: string;
  fragmentYaml: string;
  stampLine: string;
}

/** Git/GitHub side effects `approveProposal` drives. Each method is called AT MOST ONCE,
 *  and only when the classification is READY — a non-ready classification never reaches
 *  either. */
export interface RatifyGateway {
  /** Apply the fragment to plan/tasks.yaml + the stamp to MASTER-PLAN.md in ONE branch,
   *  commit, and push it. Returns the branch name actually pushed. */
  createRatificationBranch(payload: RatificationPayload): string;
  /** Open the plan PR for the pushed branch. Returns its URL. */
  openPlanPr(branch: string, proposalId: string): string;
}

export type ApproveResult =
  | { ok: true; proposalId: string; branch: string; prUrl: string; payload: RatificationPayload }
  | { ok: false; proposalId: string; state: InboxState; refusal: string };

/** Human-readable reason a classification cannot be approved right now — every non-ready
 *  or deferred state names ITS failing predicate(s)/trigger, never a bare refusal. */
export function refusalReason(c: InboxClassification): string {
  if (c.state === "ready") return "";
  if (c.state === "ratified") {
    return `${c.proposalId} is already RATIFIED (the ledger carries ratify.approved for it) — no further approve action is possible`;
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
}

/**
 * `rmd approve <P##>` — valid ONLY for a READY classification. Approving anything else is
 * REFUSED, naming the state, with ZERO gateway calls (a bit on a non-ready item initiates
 * NOTHING — rule 15). On a READY classification, calls {@link RatifyGateway.createRatificationBranch}
 * then {@link RatifyGateway.openPlanPr} EXACTLY once each, with the payload carrying the
 * cached draft's fragment + stamp verbatim. Every outcome — approved or refused — ledgers
 * exactly one `ratify.*` line (`ratify.approved` / `ratify.approve_refused`).
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
  const payload: RatificationPayload = {
    proposalId: classification.proposalId,
    fragmentYaml: classification.draft.fragmentYaml,
    stampLine: classification.draft.stampLine,
  };
  const branch = gateway.createRatificationBranch(payload);
  const prUrl = gateway.openPlanPr(branch, classification.proposalId);
  appendLedger(deps.ledgerPath, {
    run_id: deps.runId,
    task_id: classification.proposalId,
    step: "ratify.approved",
    pr_url: prUrl,
    branch,
  });
  return { ok: true, proposalId: classification.proposalId, branch, prUrl, payload };
}

/** The harness-authored commit message for a `rmd approve` ratification branch — never
 *  the LLM (mirrors lib/plan-architect.ts's `planCommitMessage` discipline in spirit: the
 *  fragment and stamp are the Architect's drafted TEXT, but the commit framing around
 *  them is the harness's, deterministically). Unlike `planCommitMessage`, this carries NO
 *  `Remudero-Task:` trailer: a ratification branch is a plan-FILING PR (it introduces the
 *  ratified task(s) into plan/tasks.yaml, it does not implement them), and
 *  `findMergedByTrailer` (lib/status.ts) would credit a trailer here as that task being
 *  DONE — permanently marking a brand-new, never-built task complete on merge. Uses
 *  {@link "./plan-pr-emitter.js".buildPlanPrCommitMessage} so the stamp line (#387: a real
 *  673-char single-paragraph stamp blew commitlint's body-max-line-length when spliced in
 *  raw) is WRAPPED, never spliced verbatim. */
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

/** Append a drafted fragment's YAML task entries to the end of `plan/tasks.yaml`'s text.
 *  The fragment is already a valid top-level sequence (schema v1) sharing the same list,
 *  so this is pure string composition — never a YAML re-serialization that could reformat
 *  the rest of the file. */
export function applyFragmentToPlanYaml(tasksYaml: string, fragmentYaml: string): string {
  const base = tasksYaml.replace(/\s*$/, "");
  return `${base}\n${fragmentYaml.trim()}\n`;
}

/** Splice a proposal's ratification stamp into MASTER-PLAN.md's proposal list: replaces
 *  an existing `- <id> (...)` bullet in place when the proposal was already captured
 *  there, otherwise appends the stamp as a new bullet at the end of the file. */
export function applyStampToMasterPlan(masterPlanMd: string, proposalId: string, stampLine: string): string {
  const bulletRe = new RegExp(`^- ${proposalId} \\(.*$`, "m");
  if (bulletRe.test(masterPlanMd)) {
    return masterPlanMd.replace(bulletRe, stampLine);
  }
  const base = masterPlanMd.replace(/\s*$/, "");
  return `${base}\n${stampLine}\n`;
}

// ── rmd reframe — feedback redrafts through the ledger (MASTER-PLAN P25 iii, W1-T111) ────

export interface ReframeResult {
  /** The proposal with `feedback` appended (verbatim) to its reframe history. */
  proposal: Proposal;
  /** The draft cache with this proposal's cached draft INVALIDATED (removed). */
  drafts: DraftCache;
}

/**
 * `rmd reframe <P##> --feedback "<text>"` — the operator's objection is captured VERBATIM
 * (never summarized) and ledgered as `ratify.reframed`; the cached draft is invalidated so
 * the next `rmd inbox` pass re-drafts rather than re-surfacing the candidate the operator
 * just objected to; the feedback joins the proposal's `reframeHistory` so
 * {@link inboxDraftPrompt}'s NEXT invocation carries it into the redraft — "the reframe
 * history rides the proposal until resolution" (design). Opens NO PR: reframe is feedback,
 * not a ratification, and is valid for ANY classification state (a READY item the operator
 * still wants to object to is exactly the "one bit OR feedback" choice P25 promises).
 */
export function reframeProposal(proposal: Proposal, feedback: string, drafts: DraftCache, deps: RatifyLedgerDeps): ReframeResult {
  const reframedProposal: Proposal = {
    ...proposal,
    reframeHistory: [...(proposal.reframeHistory ?? []), { feedback }],
  };
  appendLedger(deps.ledgerPath, {
    run_id: deps.runId,
    task_id: proposal.id,
    step: "ratify.reframed",
    feedback,
  });
  return { proposal: reframedProposal, drafts: invalidateDraft(drafts, proposal.id) };
}

// ── Approve/reframe telemetry — the retro's fatigue signal (MASTER-PLAN P25 iv, W1-T111) ─
//
// The field's failure mode is the rubber-stamp queue: a sustained approval rate near 100%
// means the bit has become ceremony for that class [research: hitl-approval-fatigue-2026].
// This is reduced the SAME way lib/retro.ts's own gather is (pure, over parsed ledger
// records) and rendered as a standalone section the harness concatenates onto
// `renderGather`'s output — lib/retro.ts itself stays untouched.

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
