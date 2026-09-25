/**
 * lib/panel-graph.ts — the control panel's plan→task→PR graph and interactive plan adjustment
 * (MASTER-PLAN §7B). A thin Route layer over existing mechanism — lib/feedback.ts's inbox and
 * lib/trace.ts's chain builder — reached through the api-client (§7A); the daemon stays the sole
 * writer. `rmd serve` wiring is separate work.
 *
 * Six routes: GET/POST /v1/feedback (inbox; submit, or answer a grill via `replyTo`), POST
 * /v1/feedback/preview (expand a draft without filing), GET /v1/trace (provenance, mirrors `rmd
 * trace`), POST /v1/feedback/decision (accept/reject), GET /v1/drain/preview (the would-drain
 * queue, reusing `drain.ts`'s own builder).
 *
 * A grill answer is not a new primitive: `replyTo` files the reply as a fresh feedback entry and
 * re-enters the same pipeline every item does. Re-prioritize is a §7B design item with no
 * plan-schema support yet — out of scope here.
 * Why: the route-by-route rationale and the grill-answer design history —
 * docs/forensics/panel-graph.md
 */

import { adoptionFindingGone, adoptionLatestPath, readAdoptionLatest } from "./measurement-cadence.js";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  loadPlan,
  loadPlanAtRef,
  parseTasksFromYaml,
  PlanError,
  unmetDependencies,
  type MergedResolver,
  type Plan,
  type Task,
} from "./plan.js";
import { loadPlanIndex, type PlanIndex, type PlanIndexEntry } from "./plan-index.js";
import { resolveRepoLayout } from "./repo-layout.js";
import {
  buildLedgerIndex,
  projectPlan,
  readLedgerLines,
  isDispatchBreakerTripped,
  dispatchesWithoutNewOwnedPr,
  DEFAULT_MAX_TASK_DISPATCHES,
  readLedgerUnionBounded,
  readLedgerUnionMemoized,
  type GhFailureReason,
  type GitHub,
  type LedgerLines,
  type StatusProjection,
} from "./status.js";
import { buildDrainPreview, dispatchOrder, runnableCandidates, type DrainOpts, type DispatchFilterReason, type MergedSet } from "./drain.js";
import {
  captureFeedback,
  expandFeedbackDraft,
  FEEDBACK_STATUSES,
  findFeedbackBySubmissionKey,
  listFeedback,
  readFeedbackEntry,
  recentFeedbackFewShot,
  setFeedbackStatus,
  validateFeedbackExpansion,
  type FeedbackEntry,
  type FeedbackExpanderDeps,
  type FeedbackExpansion,
  type FeedbackStatus,
} from "./feedback.js";
import type { LandFeedbackOpts } from "./feedback-landing.js";
import {
  feedbackDischargeState,
  renderTraceChain,
  traceForward,
  traceReverse,
  type TraceChain,
  type TraceGithub,
} from "./trace.js";
import type { Route } from "./service.js";
import { appendPanelLedger, bearerTokenId, isRecord, jsonAction, sendJson } from "./panel-actions.js";
import { appendDailyCostCeilingOverrideAudit } from "./ledger.js";
import {
  clearDailyCostCeilingOverride,
  loadDefaultPolicy,
  PolicyError,
  resolveDailyCostCeiling,
  writeDailyCostCeilingOverride,
  type Policy,
} from "./policy.js";
import { buildActionResultsRoute } from "./action-results.js";
import { createLedgerRotationMemo } from "./ledger-union.js";
import { fleetLaneDecisions, readFleetLaneStore, writeClassificationSnapshot, type FleetLaneDecision } from "./fleet-lane.js";
import { inboxOwner } from "./inbox-owner.js";
import { plainInboxMessage, plainStorePath, readPlainStore, type PlainInboxMessage } from "./inbox-plain.js";
import {
  listThreadViews,
  markThreadRead,
  readMarksPath,
  readReadMarks,
  threadDetailView,
  type InboxThreadItem,
} from "./inbox-responder.js";
import { appendThreadMessage, inboxThreadIdentity, proposalIdOfThread, readAllThreads } from "./inbox-thread.js";
import {
  beginFragmentPass,
  cachedAnchorGrep,
  classifyProposal,
  createAnchorGrepCache,
  createFragmentMemo,
  gitGrepAnchorTrue,
  ledgerProposalVerdicts,
  readOriginMainSha,
  parseDraftCache,
  parseDraftInFlightCache,
  parseProposalRegistry,
  applyProposalVerdict,
  type ProposalVerdictKind,
  pruneRatifiedProposals,
  refusalReason,
  updateProposalRegistry,
  type AnchorGrepCache,
  type DraftCache,
  type EvidenceAnchor,
  type FragmentMemo,
  type InboxClassification,
  type PredicateFailure,
  type Proposal,
} from "./inbox.js";

export interface PanelGraphDeps {
  /** Repo root — where plan/feedback/ lives. */
  root: string;
  /** `plan/tasks.yaml`'s authoritative path. Write routes load it fresh or at-ref; narrow
   *  path-based rendering helpers may also consult it independently. */
  planPath: string;
  ledgerPath: string;
  /** GitHub PR lookups the trace chain needs (lib/trace.ts's `TraceGithub`), injected for tests. */
  github: TraceGithub;
  /** The status-derivation gateway (status.ts's `GitHub`) — a different shape from `github`
   *  above; backs the drain-preview and plan-view merged-set derivation. */
  statusGithub: GitHub;
  /** config.root, where inbox state (W1-T110) lives — distinct from `root` (the repo checkout)
   *  above, the same split lib/serve.ts's `fleetControlRoot` documents.
   *  Why: the config-vs-repo split this once confused — docs/forensics/panel-graph.md */
  inboxRoot: string;
  /** The detached-CLI gateway (W1-T193) POST /v1/inbox/approve and /reframe hand off to; see
   *  {@link RatifyCliGateway}. */
  ratify: RatifyCliGateway;
  /** Best-effort git-land after POST /v1/feedback/decision writes a status flip (W1-T191).
   *  Omitted in tests; production always passes `{}`.
   *  Why: what a missed land does to checkCliFreshness — docs/forensics/panel-graph.md */
  feedbackLand?: LandFeedbackOpts;
  /** The feedback-expansion rung POST /v1/feedback/preview calls (W1-T350). `undefined` makes
   *  the route resolve `{ expansion: null }` — the same fail-open degrade an outage produces. */
  expandFeedback?: FeedbackExpanderDeps["expand"];
  /** Injectable `Policy` for the daily-cost-ceiling routes (W1-T364), defaulting to
   *  `loadDefaultPolicy()` — the same seam `account-usage.ts` and run-task.ts already offer. */
  policy?: Policy;
  /** W1-T4261: the inbox classifier's I/O, injectable for a hermetic test; production passes none. A change
   *  stamp for one input file (size, mtime, inode), undefined when absent. */
  inboxStatFile?: (path: string) => string | undefined;
  /** W1-T4261: a directory's entry names (the plan's shard directory), undefined when absent. */
  inboxListDir?: (path: string) => string[] | undefined;
  /** W1-T4261: `origin/main`'s sha, undefined when unresolvable (which disables every reuse). */
  inboxMainSha?: (root: string) => string | undefined;
  /** W1-T4261: one evidence-anchor grep at `ref`; defaults to {@link gitGrepAnchorTrue}. */
  inboxGrepAnchor?: (root: string, ref: string, anchor: EvidenceAnchor) => boolean;
}

// ── GET /v1/feedback — the inbox list ───────────────────────────────────────

/**
 * A reconciled {@link FeedbackEntry} as GET /v1/feedback returns it. `unverified` and
 * `discharged`/`dischargeUndecidable` (W1-T1257) are read-time-only decorations, never written to
 * `plan/feedback/<id>.yaml` — present only when true, layered by {@link decorateFeedbackDischarge}
 * after this reconcile. Both can be true on the same entry at once; neither ever changes `status`.
 */
export type ReconciledFeedbackEntry = FeedbackEntry & {
  unverified?: true;
  discharged?: true;
  dischargeUndecidable?: true;
};

/**
 * Merging the proposal PR is the decision (W1-T257): a `proposed` entry whose `proposal_pr` has
 * merged reconciles to the terminal status `accepted`, rather than sitting in NEEDS ME forever.
 * Runs on every GET /v1/feedback read, self-healing entries already stuck on disk, through the
 * one batched `statusGithub` gateway GET /v1/drain/preview also uses.
 *
 * No `proposal_pr`, or one open/closed-unmerged, passes through untouched. A genuinely failed
 * read (`readFailed()`) also leaves `proposed` alone but decorates `unverified: true`.
 * Why: the reconcile-vs-sweep design and the fail-safe direction — docs/forensics/panel-graph.md
 */
export function reconcileFeedbackEntries(
  root: string,
  entries: FeedbackEntry[],
  statusGithub: GitHub,
  // Fires inside the long-lived `rmd serve` process whenever a proposal PR merges — omitting a
  // land here left a tracked modification in `root` that starved deploys (#966).
  // Why: the incident — docs/forensics/panel-graph.md
  land?: LandFeedbackOpts,
): ReconciledFeedbackEntry[] {
  return entries.map((entry) => {
    if (entry.status !== "proposed" || !entry.proposal_pr) return entry;
    const pr = statusGithub.prByRef(entry.proposal_pr);
    if (pr && pr.state === "MERGED") return setFeedbackStatus(root, entry.id, "accepted", land ? { land } : {});
    if (!pr && statusGithub.readFailed?.()) return { ...entry, unverified: true };
    return entry;
  });
}

/**
 * Layers `discharged`/`dischargeUndecidable` (W1-T1257) onto every already-{@link
 * reconcileFeedbackEntries}'d entry, off lib/trace.ts's `feedbackDischargeState` predicate.
 * Reloads no PRs of its own — `plan` and `statusGithub` are the same fresh snapshot and batched
 * gateway the caller already resolved. Never touches `status:` or calls `setFeedbackStatus`.
 */
export function decorateFeedbackDischarge(
  entries: ReconciledFeedbackEntry[],
  plan: Plan,
  statusGithub: GitHub,
): ReconciledFeedbackEntry[] {
  return entries.map((entry) => {
    const { state } = feedbackDischargeState(entry, plan, statusGithub);
    if (state === "discharged") return { ...entry, discharged: true };
    if (state === "undecidable") return { ...entry, dischargeUndecidable: true };
    return entry;
  });
}

/** GET /v1/feedback[?status=<status>] — the feedback inbox, read-scoped. */
export function buildFeedbackInboxRoute(deps: PanelGraphDeps): Route {
  return {
    method: "GET",
    path: "/v1/feedback",
    scope: "read",
    handler: (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const statusParam = url.searchParams.get("status");
      if (statusParam !== null && !(FEEDBACK_STATUSES as readonly string[]).includes(statusParam)) {
        sendJson(res, 400, { error: "invalid_request", detail: `status must be one of ${FEEDBACK_STATUSES.join(", ")}` });
        return;
      }
      const reconciled = reconcileFeedbackEntries(deps.root, listFeedback(deps.root, {}), deps.statusGithub, deps.feedbackLand);
      // Plan reloaded fresh, never cached (never-stale). Fail-soft: an unreadable plan degrades
      // to no discharge flags, never a 500 over a decoration.
      let decorated: ReconciledFeedbackEntry[] = reconciled;
      try {
        decorated = decorateFeedbackDischarge(reconciled, loadPlan(deps.planPath), deps.statusGithub);
      } catch {
        // plan unreadable this tick -- serve the reconciled list undecorated.
      }
      const entries = statusParam ? decorated.filter((e) => e.status === statusParam) : decorated;
      sendJson(res, 200, { entries });
    },
  };
}

// ── POST /v1/feedback — submit feedback (origin=ui), or answer a grill via `replyTo` ─────────

interface SubmitFeedbackInput {
  text: string;
  attachments: string[];
  replyTo?: string;
  expansion?: FeedbackExpansion | null;
  submissionKey?: string;
}

/**
 * `attachments`, if present, must be http(s) links only — a local path would resolve against the
 * daemon's own filesystem. `expansion`, if present, is the {@link FeedbackExpansion} the console
 * read back and the operator confirmed (W1-T350) — re-validated, not trusted verbatim.
 * `submissionKey` (W1-T2302) is an opaque per-submit dedup key checked only for non-emptiness.
 */
function validateSubmitFeedback(body: unknown): { error: string } | SubmitFeedbackInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (typeof body.text !== "string" || !body.text.trim()) return { error: "text is required" };
  let attachments: string[] = [];
  if (body.attachments !== undefined) {
    if (!Array.isArray(body.attachments) || !body.attachments.every((a) => typeof a === "string")) {
      return { error: "attachments must be an array of strings" };
    }
    attachments = body.attachments as string[];
    const nonLink = attachments.find((a) => !/^https?:\/\//i.test(a));
    if (nonLink !== undefined) {
      return {
        error: `attachments submitted from the panel must be http(s) links, not local paths (a path would resolve against the daemon's own filesystem) — got ${JSON.stringify(nonLink)}`,
      };
    }
  }
  if (body.replyTo !== undefined && (typeof body.replyTo !== "string" || !body.replyTo.trim())) {
    return { error: "replyTo must be a non-empty string when present" };
  }
  if (body.submissionKey !== undefined && (typeof body.submissionKey !== "string" || !body.submissionKey.trim())) {
    return { error: "submissionKey must be a non-empty string when present" };
  }
  let expansion: FeedbackExpansion | null | undefined;
  if (body.expansion !== undefined && body.expansion !== null) {
    expansion = validateFeedbackExpansion(body.expansion);
    if (expansion === null) return { error: "expansion, when present, must be a valid four-section FeedbackExpansion" };
  } else if (body.expansion === null) {
    expansion = null;
  }
  return {
    text: body.text,
    attachments,
    replyTo: body.replyTo as string | undefined,
    expansion,
    submissionKey: body.submissionKey as string | undefined,
  };
}

/**
 * POST /v1/feedback — write-scoped. Captures an entry with `origin: ui` always. Ledgers
 * `panel.feedback_submitted`. `replyTo` must name an entry parked `grilling` (404/400
 * otherwise); the edge is durable both ends (W1-T2278) — this handler advances the target to
 * `answered`, the only code path that ever writes that status. `submissionKey` (W1-T2302) is
 * checked first, so a repeat answers with the existing entry and skips every other effect.
 * Why: the durability and dedup incidents this closed — docs/forensics/panel-graph.md
 */
export function buildSubmitFeedbackRoute(deps: PanelGraphDeps): Route {
  return {
    method: "POST",
    path: "/v1/feedback",
    scope: "write",
    // W1-T404: LOW — bookkeeping, trivially reversible (capture-only).
    tier: "low",
    handler: jsonAction(validateSubmitFeedback, (input, req, res) => {
      if (input.submissionKey) {
        const existing = findFeedbackBySubmissionKey(deps.root, input.submissionKey);
        if (existing) {
          sendJson(res, 200, { ok: true, entry: existing });
          return;
        }
      }
      if (input.replyTo !== undefined) {
        let target: FeedbackEntry;
        try {
          target = readFeedbackEntry(deps.root, input.replyTo);
        } catch {
          sendJson(res, 400, { error: "invalid_request", detail: `replyTo names no known feedback entry "${input.replyTo}"` });
          return;
        }
        if (target.status !== "grilling") {
          sendJson(res, 400, {
            error: "invalid_request",
            detail: `feedback#${input.replyTo} is not parked at grilling (status: ${target.status}) — nothing to answer`,
          });
          return;
        }
      }
      const raw = input.replyTo !== undefined ? `[answer to feedback#${input.replyTo}] ${input.text}` : input.text;
      const entry = captureFeedback(deps.root, {
        raw,
        attachments: input.attachments,
        origin: "ui",
        expansion: input.expansion,
        replyTo: input.replyTo,
        submissionKey: input.submissionKey,
      });
      if (input.replyTo !== undefined) {
        setFeedbackStatus(deps.root, input.replyTo, "answered", {
          answeredBy: entry.id,
          ...(deps.feedbackLand ? { land: deps.feedbackLand } : {}),
        });
      }
      const origin = bearerTokenId(req);
      appendPanelLedger(deps.ledgerPath, "panel.feedback_submitted", entry.id, origin, {
        origin_field: entry.origin,
        reply_to: input.replyTo ?? null,
      });
      sendJson(res, 200, { ok: true, entry });
    }),
  };
}

// ── POST /v1/feedback/preview — expand a draft WITHOUT filing anything (W1-T350) ────────────

interface PreviewFeedbackInput {
  text: string;
  replyTo?: string;
}

/** Same `replyTo` shape POST /v1/feedback validates, so the console never arms a Confirm the
 *  write itself would then 400 on. No `attachments`/`expansion`: a preview stores nothing. */
function validatePreviewFeedback(body: unknown): { error: string } | PreviewFeedbackInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (typeof body.text !== "string" || !body.text.trim()) return { error: "text is required" };
  if (body.replyTo !== undefined && (typeof body.replyTo !== "string" || !body.replyTo.trim())) {
    return { error: "replyTo must be a non-empty string when present" };
  }
  return { text: body.text, replyTo: body.replyTo as string | undefined };
}

/**
 * POST /v1/feedback/preview — write-scoped (a real model call). Runs the feedback-expansion rung
 * over the draft and returns the {@link FeedbackExpansion}. Files nothing — the preview seam
 * shown before POST /v1/feedback runs. `replyTo`, when present, validates the same way the
 * submit route does. Fail-open — no `expandFeedback` wired, a throw, or a rejected response all
 * resolve `{ expansion: null }` with a 200, since the console's own fallback files it plain.
 */
export function buildPreviewFeedbackRoute(deps: PanelGraphDeps): Route {
  return {
    method: "POST",
    path: "/v1/feedback/preview",
    scope: "write",
    // W1-T404: LOW — bookkeeping, trivially reversible (files nothing, W1-T350).
    tier: "low",
    handler: jsonAction(validatePreviewFeedback, async (input, _req, res) => {
      if (input.replyTo !== undefined) {
        let target: FeedbackEntry;
        try {
          target = readFeedbackEntry(deps.root, input.replyTo);
        } catch {
          sendJson(res, 400, { error: "invalid_request", detail: `replyTo names no known feedback entry "${input.replyTo}"` });
          return;
        }
        if (target.status !== "grilling") {
          sendJson(res, 400, {
            error: "invalid_request",
            detail: `feedback#${input.replyTo} is not parked at grilling (status: ${target.status}) — nothing to answer`,
          });
          return;
        }
      }
      if (!deps.expandFeedback) {
        sendJson(res, 200, { expansion: null });
        return;
      }
      const fewShot = recentFeedbackFewShot(deps.root);
      const expansion = await expandFeedbackDraft(input.text, fewShot, { expand: deps.expandFeedback });
      sendJson(res, 200, { expansion });
    }),
  };
}

// ── GET /v1/trace — the plan→task→PR provenance graph ──────────────────────

/**
 * GET /v1/trace?id=<task-id-or-feedback-id> — read-scoped. Same two-entry-point resolution as
 * `rmd trace <id>`: a known task id traces reverse (back through its origin), anything else is
 * looked up as a feedback entry and traces forward (out to its proposal PR / tasks / runs).
 * Returns both the structured {@link TraceChain} and the pre-rendered `rmd trace` text tree.
 */
export function buildTraceRoute(deps: PanelGraphDeps): Route {
  return {
    method: "GET",
    path: "/v1/trace",
    scope: "read",
    handler: (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const id = url.searchParams.get("id");
      if (!id || !id.trim()) {
        sendJson(res, 400, { error: "invalid_request", detail: "?id=<task-id-or-feedback-id> is required" });
        return;
      }

      const plan = loadPlan(deps.planPath);
      const ledgerLines = readLedgerLines(deps.ledgerPath);
      const task = plan.byId.get(id);

      let chain: TraceChain;
      if (task) {
        let feedbackEntry: FeedbackEntry | undefined;
        if (task.origin?.startsWith("feedback#")) {
          const feedbackId = task.origin.slice("feedback#".length);
          try {
            feedbackEntry = readFeedbackEntry(deps.root, feedbackId);
          } catch {
            // origin names a feedback entry that no longer resolves -- render the chain without
            // it, same as traceCommand's own "note and continue" behavior.
          }
        }
        chain = traceReverse(task, { plan, ledgerLines, github: deps.github }, feedbackEntry);
      } else {
        let entry: FeedbackEntry;
        try {
          entry = readFeedbackEntry(deps.root, id);
        } catch {
          sendJson(res, 404, { error: "not_found", detail: `'${id}' is neither a known task id nor a feedback entry` });
          return;
        }
        chain = traceForward(entry, { plan, ledgerLines, github: deps.github });
      }
      sendJson(res, 200, { chain, rendered: renderTraceChain(chain) });
    },
  };
}

// ── POST /v1/feedback/decision — accept or reject a proposal ───────────────

interface ProposalDecisionInput {
  id: string;
  decision: "accept" | "reject";
}

function validateProposalDecision(body: unknown): { error: string } | ProposalDecisionInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (typeof body.id !== "string" || !body.id.trim()) return { error: "id is required" };
  if (body.decision !== "accept" && body.decision !== "reject") {
    return { error: 'decision must be "accept" or "reject"' };
  }
  return { id: body.id, decision: body.decision };
}

/**
 * POST /v1/feedback/decision — write-scoped. Accept or reject a `proposed` entry over a proposal
 * PR lib/triage.ts already opened. Only a `proposed` entry can be decided (400 otherwise — this
 * caller has a precondition `setFeedbackStatus` itself does not enforce). Ledgers
 * `panel.proposal_accepted`/`panel.proposal_rejected` with the panel's bearer as `origin`.
 */
export function buildProposalDecisionRoute(deps: PanelGraphDeps): Route {
  return {
    method: "POST",
    path: "/v1/feedback/decision",
    scope: "write",
    // W1-T404: LOW — bookkeeping, trivially reversible (accept/reject a proposal's status).
    tier: "low",
    handler: jsonAction(validateProposalDecision, (input, req, res) => {
      let entry: FeedbackEntry;
      try {
        entry = readFeedbackEntry(deps.root, input.id);
      } catch {
        sendJson(res, 404, { error: "not_found", detail: `no feedback entry "${input.id}"` });
        return;
      }
      if (entry.status !== "proposed") {
        sendJson(res, 400, {
          error: "invalid_request",
          detail: `feedback#${input.id} is not awaiting a decision (status: ${entry.status})`,
        });
        return;
      }
      const status = input.decision === "accept" ? "accepted" : "rejected";
      const updated = setFeedbackStatus(
        deps.root,
        input.id,
        status,
        deps.feedbackLand ? { land: deps.feedbackLand } : {},
      );
      const origin = bearerTokenId(req);
      appendPanelLedger(deps.ledgerPath, input.decision === "accept" ? "panel.proposal_accepted" : "panel.proposal_rejected", input.id, origin, {
        proposal_pr: updated.proposal_pr,
      });
      sendJson(res, 200, { ok: true, id: input.id, status: updated.status, proposalPr: updated.proposal_pr });
    }),
  };
}

// ── GET /v1/drain/preview — the would-drain queue as ordered task cards ────

/** Parse `?max=<n>` off a request URL — a positive integer, or an error string. `undefined` when the param is absent (the natural {@link DrainOpts.max} default applies downstream). */
function parseMaxParam(url: URL): { max?: number } | { error: string } {
  const raw = url.searchParams.get("max");
  if (raw === null) return {};
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return { error: "max must be a positive number" };
  return { max: n };
}

/** The one read-model boundary shared by the three console routes W1-T3415 owns. The snapshot
 * travels as a separate read-builder capability, never through the write-route dependency bag. */
function readPanelPlan(deps: PanelGraphDeps, readPlanSnapshot?: () => Plan): Plan {
  return readPlanSnapshot?.() ?? loadPlan(deps.planPath);
}

/** `Task` preserves `plan_refs`, so a process-owned plan needs no second shard traversal. */
function planRefsFromSnapshot(plan: Plan): Map<string, string[]> {
  const refs = new Map<string, string[]>();
  for (const task of plan.tasks) {
    if (task.plan_refs) refs.set(task.id, task.plan_refs);
  }
  return refs;
}

/**
 * GET /v1/drain/preview[?max=<n>][&until=<id>] — read-scoped. The would-drain queue (W1-T140) as
 * ordered task cards: reads the process snapshot, re-derives merged status via `projectPlan` (the
 * same projection `GET /v1/status` uses), and renders `drain.ts`'s own `buildDrainPreview`.
 */
export function buildDrainPreviewRoute(deps: PanelGraphDeps, readPlanSnapshot?: () => Plan): Route {
  return {
    method: "GET",
    path: "/v1/drain/preview",
    scope: "read",
    handler: (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parsedMax = parseMaxParam(url);
      if ("error" in parsedMax) {
        sendJson(res, 400, { error: "invalid_request", detail: parsedMax.error });
        return;
      }
      const opts: DrainOpts = { max: parsedMax.max, until: url.searchParams.get("until") ?? undefined };

      const plan = readPanelPlan(deps, readPlanSnapshot);
      const projection = projectPlan(plan, { ledgerPath: deps.ledgerPath, github: deps.statusGithub });
      const isMerged = (id: string) => projection.get(id)?.merged ?? false;
      const cards = buildDrainPreview(plan, isMerged, opts);
      sendJson(res, 200, { cards });
    },
  };
}

// ── GET /v1/plan/view — progress (done/in-flight/queued) + frontier (W1-T315) ─────────────────
//
// Progress derives from the same GitHub-derived projection GET /v1/drain/preview and GET
// /v1/status use — done counts off that projection, never off the decorative `status:` field,
// which can say `queued` after the PR has merged. An unreadable gateway never renders a zero:
// the last observed reading rides forward, stamped unknown with its age.
//
// Frontier binds drain.ts's own `runnableCandidates`, the dispatcher's exact selector, rather
// than re-deriving order/eligibility here. A held task renders as held, with the reason the same
// predicate produced, never omitted. Out of scope: live run/daemon/deploy state (the Now tab)
// and any write action on a frontier row — this view only renders, never dispatches.
// Why: the merged-vs-status incident and the design notes — docs/forensics/panel-graph.md

/** Aggregate task counts for the workstream, derived from GitHub — never from the plan's own
 *  decorative `status:` field (see this section's header). */
export interface PlanProgress {
  /** Absent only on a first-ever reading taken during an outage — never a fabricated 0. */
  done?: number;
  inFlight?: number;
  queued?: number;
  total?: number;
  /** True when this reading is carried forward because GitHub could not be read this cycle. */
  unknown: boolean;
  /** When the counts were current — the fresh time, or the last successful one under `unknown`. */
  asOf?: string;
  unavailableReason?: string;
}

/**
 * The last {@link PlanProgress} reading successfully observed — an in-memory snapshot for one
 * `rmd serve` process lifetime, never persisted to disk (a restart starts with no last-known
 * reading, falling back to `unknown`).
 */
export interface PlanProgressCache {
  last?: { done: number; inFlight: number; queued: number; total: number; asOf: string };
}

export function createPlanProgressCache(): PlanProgressCache {
  return {};
}

/**
 * Computes {@link PlanProgress} from an already-derived projection (the caller's one
 * `projectPlan()` call). Makes no GitHub call of its own beyond `readFailed()`/
 * `readFailureReason()`, so it can never become a second per-task fetch path.
 */
export function computePlanProgress(
  plan: Plan,
  projection: Map<string, StatusProjection>,
  github: Pick<GitHub, "readFailed" | "readFailureReason">,
  cache: PlanProgressCache,
  now: () => number = Date.now,
): PlanProgress {
  if (github.readFailed?.()) {
    const unavailableReason = github.readFailureReason?.() ?? "unknown";
    if (!cache.last) return { unknown: true, unavailableReason }; // no last-known reading yet — UNKNOWN with no numbers, never a fabricated 0
    return { ...cache.last, unknown: true, unavailableReason };
  }
  let done = 0;
  let inFlight = 0;
  let queued = 0;
  for (const task of plan.tasks) {
    const p = projection.get(task.id);
    if (p?.merged) done++;
    else if (p?.status === "running") inFlight++;
    else queued++;
  }
  const total = plan.tasks.length;
  const asOf = new Date(now()).toISOString();
  cache.last = { done, inFlight, queued, total, asOf };
  return { done, inFlight, queued, total, unknown: false, asOf };
}

/** Why a frontier row is where it is — a fixed set of four rendered kinds. `"verify-human"`
 *  stays a member of this type ({@link frontierFilterReason} still classifies it) but never
 *  reaches a {@link FrontierRow}: those tasks are permanently parked, not temporarily held, so
 *  {@link buildPlanFrontier} excludes them from the frontier entirely. */
export type FrontierReasonKind = "file-order" | "unmet-dependency" | "circuit-breaker" | "blocked" | "verify-human";

export interface FrontierRow {
  id: string;
  title: string;
  runnable: boolean;
  reasonKind: FrontierReasonKind;
  /** Derived from the same fact that classified this row — never a hand-written blurb. */
  reason: string;
}

/**
 * Reason text for a task {@link runnableCandidates} declined via a {@link DispatchFilterReason}.
 * `"already-merged"` and `"verify-not-auto"` both return `undefined` — a done task is
 * `PlanProgress.done`, and a `verify:human` task is permanently parked, already rendered
 * elsewhere. `unmetDependencies` is re-consulted (a pure DAG walk) only to name which id(s).
 */
function frontierFilterReason(
  plan: Plan,
  task: Task,
  reason: DispatchFilterReason,
  isMerged: MergedSet,
): { kind: FrontierReasonKind; reason: string } | undefined {
  if (reason === "already-merged") return undefined;
  if (reason === "verify-not-auto") return undefined;
  // Skipped, not guessed at (W1-T2675) — the caller's own doc names this Now-tab territory.
  // Falling through to unmet-deps below would render a false "(none resolved)" sentence.
  if (reason === "credit-indeterminate") return undefined;
  if (reason === "blocked") {
    return { kind: "blocked", reason: task.note ? `blocked — ${task.note}` : `${task.id}'s own status is blocked` };
  }
  // "unmet-deps"
  const merged: MergedResolver = (t) => isMerged(t.id);
  const ids = unmetDependencies(plan, task, merged);
  return {
    kind: "unmet-dependency",
    reason: `blocked on unmet dependenc${ids.length === 1 ? "y" : "ies"}: ${ids.join(", ") || "(none resolved)"}`,
  };
}

/** How many frontier rows GET /v1/plan/view renders absent an explicit `?frontier=<n>`. */
export const DEFAULT_FRONTIER_LIMIT = 8;

/**
 * The next `limit` frontier rows in the same order the dispatcher would take them: binds
 * `runnableCandidates` for both ordering and eligibility, never re-deriving either. A runnable
 * row names its file-order rank; a row held for a temporary reason still renders, never omitted.
 * Done tasks and permanently-parked `verify:human` tasks are excluded from the row budget
 * entirely — see {@link frontierFilterReason}. A task named by no filter reason is skipped, never
 * guessed at.
 */
export function buildPlanFrontier(
  plan: Plan,
  isMerged: MergedSet,
  limit: number,
  ledgerLines: ReadonlyArray<Record<string, unknown>>,
  maxDispatches: number = DEFAULT_MAX_TASK_DISPATCHES,
  // Appended last so no positional caller shifts (W1-T2675). Lets this view tell "merge credit
  // unread" from "genuinely has none" instead of rendering the first as an ordinary candidate.
  isCreditIndeterminate?: (taskId: string) => boolean,
): FrontierRow[] {
  const heldReasons = new Map<string, { kind: FrontierReasonKind; reason: string }>();
  // W1-T3523's stale-orphan check needs the newest ledger timestamp. Reuse the existing index
  // while this frontier evaluates every candidate, instead of repeatedly scanning the same ledger.
  const index = buildLedgerIndex(ledgerLines);
  const isCircuitTripped = (id: string) => isDispatchBreakerTripped(ledgerLines, id, maxDispatches, index);
  // A large limit, never the caller's: this one call must classify every non-merged task so the
  // dispatchOrder walk below finds each verdict, however many held rows precede the runnable ones.
  const eligible = runnableCandidates(plan, isMerged, plan.tasks.length, {
    isCreditIndeterminate,
    onFiltered: (task, reason) => {
      const r = frontierFilterReason(plan, task, reason, isMerged);
      if (r) heldReasons.set(task.id, r);
    },
    isCircuitTripped,
    onCircuitBreak: (task) => {
      const dispatches = dispatchesWithoutNewOwnedPr(ledgerLines, task.id, index);
      heldReasons.set(task.id, {
        kind: "circuit-breaker",
        reason: `dispatch circuit tripped (${dispatches}/${maxDispatches} dispatches since the last owned PR) — resets only on a fresh owned PR for ${task.id}`,
      });
    },
  });
  const eligibleIds = new Set(eligible.map((t) => t.id));

  const rows: FrontierRow[] = [];
  let rank = 0;
  for (const task of dispatchOrder(plan.tasks)) {
    if (rows.length >= limit) break;
    if (isMerged(task.id)) continue; // done — not part of "what's next"
    if (eligibleIds.has(task.id)) {
      rank++;
      rows.push({
        id: task.id,
        title: task.title,
        runnable: true,
        reasonKind: "file-order",
        reason: rank === 1 ? "head of file order — the dispatcher's next pick" : `file order, ${rank - 1} runnable task${rank - 1 === 1 ? "" : "s"} ahead of it`,
      });
      continue;
    }
    const held = heldReasons.get(task.id);
    if (held) rows.push({ id: task.id, title: task.title, runnable: false, reasonKind: held.kind, reason: held.reason });
  }
  return rows;
}

// ── GET /v1/operator-activity — one bounded operator story (W1-T3852) ──────

export const OPERATOR_ACTIVITY_CONTRACT_VERSION = "operator-activity-v1" as const;
/** PRIMARY CONTROL: the projection's response item bound, enforced before serialization. */
export const OPERATOR_ACTIVITY_MAX_ITEMS = 200;

export type OperatorActivityState = "verified" | "stale" | "unavailable" | "unknown" | "not-collected";
export type OperatorActivityFreshness = "verified" | "stale" | "unavailable" | "unknown" | "not-collected";
export type OperatorActivityItemKind = "activity" | "workstream" | "artifact";

export type OperatorActivityItem = {
  id: string;
  kind: OperatorActivityItemKind;
  summary: string;
  source: string;
  observedAt: string;
  freshness: OperatorActivityFreshness;
  taskId?: string;
  repository?: string;
  state?: "active" | "blocked" | "queued" | "completed" | "unknown";
  reason?: string;
  href?: string;
};

export type OperatorActivityEnvelope =
  | {
      version: typeof OPERATOR_ACTIVITY_CONTRACT_VERSION;
      state: "verified" | "stale" | "unknown";
      source: string;
      observedAt: string;
      cursor: string;
      items: OperatorActivityItem[];
      truncated: boolean;
      reason?: string;
    }
  | {
      version: typeof OPERATOR_ACTIVITY_CONTRACT_VERSION;
      state: "unavailable" | "not-collected";
      source: string;
      observedAt: string;
      cursor?: string;
      reason: string;
      detail?: string;
    };

export interface OperatorActivityProjectionInput {
  plan: Plan;
  projection: ReadonlyMap<string, StatusProjection>;
  ledgerLines: ReadonlyArray<Record<string, unknown>> & { present?: boolean; torn?: number };
  githubReadFailed?: boolean;
  githubFailureReason?: string;
  now?: () => number;
  source?: string;
}

function boundedActivityText(value: unknown, max = 240): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim().slice(0, max);
}

function activityTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function activityTaskId(row: Record<string, unknown>): string | undefined {
  return boundedActivityText(row.task_id, 160) ?? boundedActivityText(row.task, 160);
}

function activityRepository(row: Record<string, unknown>): string | undefined {
  const repository = boundedActivityText(row.repository, 200) ?? boundedActivityText(row.repo, 200);
  return repository && /^[^\s/]+\/[^\s/]+$/.test(repository) ? repository : undefined;
}

function activityId(row: Record<string, unknown>, observedAt: string, duplicate: number): string {
  const explicit = boundedActivityText(row.id, 160) ?? boundedActivityText(row.event_id, 160);
  if (explicit) return explicit;
  const step = boundedActivityText(row.step, 120) ?? "ledger";
  const task = activityTaskId(row) ?? "fleet";
  const run = boundedActivityText(row.run_id, 120) ?? "";
  return `activity:${step}:${task}:${run}:${observedAt}:${duplicate}`;
}

function activitySummary(row: Record<string, unknown>, taskId?: string): string | undefined {
  const step = boundedActivityText(row.step, 120);
  if (!step) return undefined;
  return taskId ? `${step} (${taskId})` : step;
}

function activityRows(
  ledgerLines: ReadonlyArray<Record<string, unknown>>,
  observedAt: string,
): OperatorActivityItem[] {
  const duplicates = new Map<string, number>();
  return ledgerLines
    .map((row): OperatorActivityItem | undefined => {
      const occurredAt = activityTimestamp(row.ts);
      const taskId = activityTaskId(row);
      const summary = activitySummary(row, taskId);
      if (!occurredAt || !summary) return undefined;
      const key = `${boundedActivityText(row.step, 120) ?? "ledger"}:${taskId ?? "fleet"}:${occurredAt}`;
      const duplicate = duplicates.get(key) ?? 0;
      duplicates.set(key, duplicate + 1);
      return {
        id: activityId(row, occurredAt, duplicate),
        kind: "activity" as const,
        summary,
        source: `rmd:ledger:${boundedActivityText(row.step, 120) ?? "event"}`,
        observedAt: occurredAt,
        freshness: "verified" as const,
        ...(taskId ? { taskId } : {}),
        ...(activityRepository(row) ? { repository: activityRepository(row) } : {}),
      } satisfies OperatorActivityItem;
    })
    .filter((item): item is OperatorActivityItem => Boolean(item))
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))
    .slice(0, OPERATOR_ACTIVITY_MAX_ITEMS);
}

/** Whether `ledgerLines` hold at least {@link OPERATOR_ACTIVITY_MAX_ITEMS} rows {@link activityRows} would keep. */
function activitiesSaturate(ledgerLines: ReadonlyArray<Record<string, unknown>>): boolean {
  let count = 0;
  for (const row of ledgerLines) {
    if (activityTimestamp(row.ts) && boundedActivityText(row.step, 120)) count += 1;
    if (count >= OPERATOR_ACTIVITY_MAX_ITEMS) return true;
  }
  return false;
}

/**
 * One rotation's rows reduced to those that could reach {@link activityRows}' bound: its newest
 * {@link OPERATOR_ACTIVITY_MAX_ITEMS} activities, ties to the earlier row, kept in file order. The union's
 * newest items are the newest of these, and every earlier row sharing an item's duplicate key ranks above
 * that item, so it is kept too and each id's duplicate count is unchanged.
 */
export function operatorActivityCandidates(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const ranked: Array<{ index: number; ms: number }> = [];
  rows.forEach((row, index) => {
    const at = activityTimestamp(row.ts);
    if (at && boundedActivityText(row.step, 120)) ranked.push({ index, ms: Date.parse(at) });
  });
  ranked.sort((a, b) => b.ms - a.ms || a.index - b.index);
  return ranked
    .slice(0, OPERATOR_ACTIVITY_MAX_ITEMS)
    .map((r) => r.index)
    .sort((a, b) => a - b)
    .map((index) => rows[index]);
}

function workstreamRows(
  plan: Plan,
  projection: ReadonlyMap<string, StatusProjection>,
  ledgerLines: ReadonlyArray<Record<string, unknown>>,
  observedAt: string,
  githubReadFailed: boolean,
  githubFailureReason: string | undefined,
): OperatorActivityItem[] {
  const source = "rmd:/v1/plan/view";
  if (githubReadFailed) {
    return [{
      id: "workstream:plan",
      kind: "workstream",
      summary: "Plan workstream state is unknown until the status source is readable.",
      source,
      observedAt,
      freshness: "unknown",
      state: "unknown",
      reason: githubFailureReason ?? "status-source-unavailable",
      href: "/v1/plan/view",
    }];
  }
  const isMerged: MergedSet = (id) => projection.get(id)?.merged === true;
  const frontier = buildPlanFrontier(plan, isMerged, OPERATOR_ACTIVITY_MAX_ITEMS, ledgerLines);
  const rows = frontier.map((row): OperatorActivityItem => {
    const task = plan.byId.get(row.id);
    const projected = projection.get(row.id);
    const state = row.runnable ? "queued" : projected?.merged ? "completed" : projected?.status === "running" ? "active" : "blocked";
    return {
      id: `workstream:${row.id}`,
      kind: "workstream",
      summary: `${row.id}: ${boundedActivityText(task?.title, 180) ?? row.id} — ${row.reason}`,
      source,
      observedAt,
      freshness: "verified",
      taskId: row.id,
      ...(task?.repo ? { repository: task.repo } : {}),
      state,
      ...(row.reason ? { reason: row.reason } : {}),
      href: `/v1/trace?id=${encodeURIComponent(row.id)}`,
    };
  });
  if (rows.length > 0) return rows;
  return [{
    id: "workstream:plan",
    kind: "workstream",
    summary: "The plan has no unfinished runnable or held frontier rows.",
    source,
    observedAt,
    freshness: "verified",
    state: "completed",
    href: "/v1/plan/view",
  }];
}

function artifactRows(
  plan: Plan,
  projection: ReadonlyMap<string, StatusProjection>,
  workstreams: ReadonlyArray<OperatorActivityItem>,
  observedAt: string,
  freshness: OperatorActivityFreshness,
): OperatorActivityItem[] {
  const artifacts: OperatorActivityItem[] = [{
    id: "artifact:plan",
    kind: "artifact",
    summary: "Authoritative plan frontier",
    source: "rmd:/v1/plan/view",
    observedAt,
    freshness,
    href: "/v1/plan/view",
  }];
  for (const item of workstreams) {
    if (!item.taskId || artifacts.length >= OPERATOR_ACTIVITY_MAX_ITEMS) continue;
    const task = plan.byId.get(item.taskId);
    const p = projection.get(item.taskId);
    artifacts.push({
      id: `artifact:task:${item.taskId}`,
      kind: "artifact",
      summary: `Authoritative trace for ${item.taskId}${task?.title ? ` — ${boundedActivityText(task.title, 150)}` : ""}`,
      source: "rmd:/v1/trace",
      observedAt,
      freshness,
      taskId: item.taskId,
      ...(task?.repo ? { repository: task.repo } : {}),
      href: `/v1/trace?id=${encodeURIComponent(item.taskId)}`,
    });
    if (p?.prUrl && artifacts.length < OPERATOR_ACTIVITY_MAX_ITEMS) {
      artifacts.push({
        id: `artifact:receipt:${item.taskId}`,
        kind: "artifact",
        summary: `Authoritative change receipt for ${item.taskId}`,
        source: "github:pull-request",
        observedAt,
        freshness,
        taskId: item.taskId,
        ...(task?.repo ? { repository: task.repo } : {}),
        href: p.prUrl,
      });
    }
  }
  return artifacts.slice(0, OPERATOR_ACTIVITY_MAX_ITEMS);
}

export function buildOperatorActivityProjection(input: OperatorActivityProjectionInput): OperatorActivityEnvelope {
  const now = input.now?.() ?? Date.now();
  const observedAt = new Date(now).toISOString();
  const source = input.source ?? "rmd:/v1/operator-activity";
  if (input.ledgerLines.present === false) {
    return { version: OPERATOR_ACTIVITY_CONTRACT_VERSION, state: "unavailable", source, observedAt, reason: "ledger-unavailable", detail: "The operator activity ledger was not present." };
  }
  const activities = activityRows(input.ledgerLines, observedAt);
  const freshness: OperatorActivityFreshness = input.githubReadFailed ? "unknown" : "verified";
  // Activities alone filling the bound leave `items` and `truncated` identical without the frontier.
  const workstreams = activities.length >= OPERATOR_ACTIVITY_MAX_ITEMS
    ? []
    : workstreamRows(input.plan, input.projection, input.ledgerLines, observedAt, input.githubReadFailed === true, input.githubFailureReason);
  const artifacts = artifactRows(input.plan, input.projection, workstreams, observedAt, freshness);
  const items = [...activities, ...workstreams, ...artifacts].slice(0, OPERATOR_ACTIVITY_MAX_ITEMS);
  const latest = activities[0]?.observedAt ?? observedAt;
  return {
    version: OPERATOR_ACTIVITY_CONTRACT_VERSION,
    state: input.githubReadFailed ? "unknown" : "verified",
    source,
    observedAt,
    cursor: latest,
    items,
    truncated: activities.length + workstreams.length + artifacts.length > OPERATOR_ACTIVITY_MAX_ITEMS,
    ...(input.githubReadFailed ? { reason: input.githubFailureReason ?? "status-source-unavailable" } : {}),
  };
}

/**
 * GET /v1/operator-activity — read-only, bounded, single-pass composition of the ledger, the
 * already-derived plan projection, the dispatcher-owned frontier, and authoritative evidence links.
 * No row triggers its own GitHub or filesystem read, and unavailable status never becomes a healthy
 * empty workstream.
 */
export function buildOperatorActivityRoute(deps: PanelGraphDeps, readPlanSnapshot?: () => Plan): Route {
  const rotations = createLedgerRotationMemo(operatorActivityCandidates);
  return {
    method: "GET",
    path: "/v1/operator-activity",
    scope: "read",
    handler: async (_req, res) => {
      const candidates = await readLedgerUnionMemoized(deps.ledgerPath, rotations);
      if (!candidates.present) {
        sendJson(res, 200, {
          version: OPERATOR_ACTIVITY_CONTRACT_VERSION,
          state: "unavailable",
          source: "rmd:/v1/operator-activity",
          observedAt: new Date().toISOString(),
          reason: "ledger-unavailable",
          detail: "The operator activity ledger was not present.",
        } satisfies OperatorActivityEnvelope);
        return;
      }
      try {
        const plan = readPanelPlan(deps, readPlanSnapshot);
        // Saturated, the projection skips the frontier, so neither the whole union nor projectPlan is read.
        const saturated = activitiesSaturate(candidates);
        const observedLedger = saturated ? candidates : readLedgerUnionBounded(deps.ledgerPath);
        const projection = saturated ? new Map<string, StatusProjection>() : projectPlan(plan, {
          ledgerPath: deps.ledgerPath,
          github: deps.statusGithub,
          readLedger: () => observedLedger,
        });
        sendJson(res, 200, buildOperatorActivityProjection({
          plan,
          projection,
          ledgerLines: observedLedger,
          githubReadFailed: deps.statusGithub.readFailed?.() === true,
          githubFailureReason: deps.statusGithub.readFailureReason?.(),
        }));
      } catch (error) {
        sendJson(res, 503, {
          version: OPERATOR_ACTIVITY_CONTRACT_VERSION,
          state: "unavailable",
          source: "rmd:/v1/operator-activity",
          observedAt: new Date().toISOString(),
          reason: "projection-unavailable",
          detail: error instanceof Error ? error.message.slice(0, 240) : "The operator activity projection was unavailable.",
        } satisfies OperatorActivityEnvelope);
      }
    },
  };
}

// ── Per-section filed/merged counts (W1-T376) ──────────────────────────────────────────────
//
// plan_refs is polymorphic — a ref is one of five kinds; only the section-shaped ones resolve
// to a heading, the rest contribute nothing, or a task-id ref would fabricate a section.
// `Task` now preserves `plan_refs` for the filing-risk identity boundary. `readPlanRefs` remains an
// independent, exported rendering helper over `planPath`; changing that API is not part of the pin
// repair. It re-parses the same local files {@link loadPlan} reads — never a new GitHub call.

/** `id -> plan_refs` for every task in `planPath`, a narrow second parse retained for this exported
 *  path-based API. A file that fails to read or parse is skipped, never thrown — a rendering aid
 *  over the load-bearing validation {@link loadPlan} already did. */
export function readPlanRefs(planPath: string): Map<string, string[]> {
  const refs = new Map<string, string[]>();
  const ingest = (text: string) => {
    let raw: unknown;
    try {
      raw = parseYaml(text);
    } catch {
      return;
    }
    if (!Array.isArray(raw)) return;
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.id !== "string" || !Array.isArray(e.plan_refs)) continue;
      refs.set(
        e.id,
        (e.plan_refs as unknown[]).filter((r): r is string => typeof r === "string"),
      );
    }
  };
  try {
    ingest(readFileSync(planPath, "utf8"));
  } catch {
    return refs;
  }
  const shardDir = join(dirname(planPath), "tasks.d");
  let shardFiles: string[];
  try {
    shardFiles = readdirSync(shardDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  } catch {
    shardFiles = [];
  }
  for (const file of shardFiles) {
    try {
      ingest(readFileSync(join(shardDir, file), "utf8"));
    } catch {
      // best-effort, per this function's own header -- loadPlan() already validated these files loudly.
    }
  }
  return refs;
}

type PlanRefKind = "section" | "task-id" | "retro-proposal" | "workstream" | "unrecognized";

/** Classify one `plan_refs` entry into the five kinds design note (i) documents. Only
 *  `"section"` carries a `token` -- the ref text with its `§`/`MASTER-PLAN#` prefix stripped --
 *  for {@link resolveSectionHeading} to join against the source document's derived headings. */
function classifyPlanRef(ref: string): { kind: PlanRefKind; token?: string } {
  if (ref.startsWith("§")) return { kind: "section", token: ref.slice(1) };
  if (ref.startsWith("MASTER-PLAN#")) return { kind: "section", token: ref.slice("MASTER-PLAN#".length) };
  if (/^W\d+-T\d+$/.test(ref)) return { kind: "task-id" };
  if (/^P\d+$/.test(ref)) return { kind: "retro-proposal" };
  if (/^WS-\d+$/.test(ref)) return { kind: "workstream" };
  return { kind: "unrecognized" };
}

/** Resolves a stripped section token ("5C", "7") to its derived plan-index heading, matching the
 *  heading's own leading token (everything before its first `.`) exactly — never a prefix match,
 *  which would let "5" wrongly match "5C. ...". A word-shaped ref (no leading digit) falls back
 *  to a case-insensitive heading-prefix match once the exact pass finds nothing. */
function resolveSectionHeading(token: string, entries: readonly PlanIndexEntry[]): string | undefined {
  for (const e of entries) {
    const m = /^(\S+?)\./.exec(e.heading);
    if (m && m[1] === token) return e.heading;
  }
  const lower = token.toLowerCase();
  for (const e of entries) {
    if (e.heading.toLowerCase().startsWith(lower)) return e.heading;
  }
  return undefined;
}

/** One MASTER-PLAN section's filed/merged breakdown, rendered as a pair, never a percentage — a
 *  percentage would rank a 1-task section above a 74-task one the moment its single task merges. */
export interface PlanSectionCount {
  heading: string;
  filed: number;
  merged: number;
}

/** The last-computed {@link PlanSectionCount}s, the per-section counterpart of {@link
 *  PlanProgressCache}: a caller passes in {@link computePlanProgress}'s own `unknown` flag rather
 *  than re-deriving it, so sections never attempt a read the whole-plan progress already failed. */
export interface PlanSectionCache {
  last?: PlanSectionCount[];
}

export function createPlanSectionCache(): PlanSectionCache {
  return {};
}

/**
 * Per-section filed/merged counts (W1-T376), off the same `projection` the caller already
 * resolved and gated by `progressUnknown` — a GitHub outage renders the last-known breakdown
 * (or none, on a first-ever outage), never a fabricated zero. Falsifier: a task-id/`Pnn`/`WS-n`
 * ref contributes to no section, and a task resolving to two sections increments both.
 */
export function computePlanSectionCounts(
  plan: Plan,
  projection: Map<string, StatusProjection>,
  planRefs: ReadonlyMap<string, readonly string[]>,
  index: PlanIndex | null,
  progressUnknown: boolean,
  cache: PlanSectionCache,
): PlanSectionCount[] {
  if (progressUnknown) return cache.last ?? [];
  const entries = index?.entries ?? [];
  const counts = new Map<string, { filed: number; merged: number }>();
  for (const task of plan.tasks) {
    const refs = planRefs.get(task.id);
    if (!refs || refs.length === 0) continue;
    const headings = new Set<string>();
    for (const ref of refs) {
      const cls = classifyPlanRef(ref);
      if (cls.kind !== "section") continue;
      const heading = resolveSectionHeading(cls.token!, entries);
      if (heading) headings.add(heading);
    }
    if (headings.size === 0) continue;
    const merged = projection.get(task.id)?.merged ?? false;
    for (const heading of headings) {
      const c = counts.get(heading) ?? { filed: 0, merged: 0 };
      c.filed += 1;
      if (merged) c.merged += 1;
      counts.set(heading, c);
    }
  }
  const sections: PlanSectionCount[] = [];
  for (const e of entries) {
    const c = counts.get(e.heading);
    if (c) sections.push({ heading: e.heading, filed: c.filed, merged: c.merged });
  }
  cache.last = sections;
  return sections;
}

/**
 * GET /v1/plan/view[?frontier=<n>] — read-scoped. The Plan tab's one fetch: `progress`, `sections`
 * (W1-T376), and `frontier`, off one process snapshot and one `projectPlan()` call, like {@link
 * buildDrainPreviewRoute}. The caches are created once per route closure, persisting for the
 * `rmd serve` process lifetime — never per-request, or every reading would look first-ever.
 */
export function buildPlanViewRoute(deps: PanelGraphDeps, readPlanSnapshot?: () => Plan): Route {
  const progressCache = createPlanProgressCache();
  const sectionCache = createPlanSectionCache();
  return {
    method: "GET",
    path: "/v1/plan/view",
    scope: "read",
    handler: (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const rawLimit = url.searchParams.get("frontier");
      const limit = rawLimit !== null ? Number(rawLimit) : DEFAULT_FRONTIER_LIMIT;
      if (!Number.isFinite(limit) || limit <= 0) {
        sendJson(res, 400, { error: "invalid_request", detail: "frontier must be a positive number" });
        return;
      }
      const plan = readPanelPlan(deps, readPlanSnapshot);
      const projection = projectPlan(plan, { ledgerPath: deps.ledgerPath, github: deps.statusGithub });
      const isMerged: MergedSet = (id) => projection.get(id)?.merged ?? false;
      const progress = computePlanProgress(plan, projection, deps.statusGithub, progressCache);
      const planRefs = planRefsFromSnapshot(plan);
      const planIndex = loadPlanIndex(resolveRepoLayout(deps.root).masterPlan);
      const sections = computePlanSectionCounts(plan, projection, planRefs, planIndex, progress.unknown, sectionCache);
      const ledgerLines = readLedgerLines(deps.ledgerPath);
      const frontier = buildPlanFrontier(plan, isMerged, limit, ledgerLines, undefined, (id) =>
        projection.get(id)?.indeterminate === true);
      sendJson(res, 200, { progress, sections, frontier });
    },
  };
}

// ── GET /v1/inbox — W1-T110's READY ratification proposals (NEEDS ME section) ──────────────

/** Best-effort read; a missing/unreadable file is `undefined` — an inbox with no registry yet is the normal pre-population state (mirrors inbox.ts's own `parseProposalRegistry(undefined) -> []`). */
function readFileIfExists(path: string): string | undefined {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

/** One task the drafted fragment would file — id + title, so a ready card shows what would
 *  actually be filed rather than an opaque proposal id (W1-T193): a known change, never a token. */
export interface InboxDraftedTask {
  id: string;
  title: string;
}

/** One READY-to-ratify proposal, as the panel renders it — the drafted task ids/titles ride
 *  along (never just the proposal id), so the operator sees exactly what APPROVE would file. */
export interface InboxReadyItem {
  proposalId: string;
  summary: string;
  /** W1-T4087: the item's plain-language message; `summary` stays as the raw Details. */
  plain: PlainInboxMessage;
  stampLine?: string;
  draftedTasks: InboxDraftedTask[];
}

/** One proposal currently mid-draft (W1-T193): an Architect worker is running for it right now.
 *  `spawnedAt` lets a card render something during this legitimately multi-minute window,
 *  rather than looking broken (the liveness bar W1-T156 set). */
export interface InboxDraftingItem {
  proposalId: string;
  summary: string;
  /** W1-T4087: the item's plain-language message; `summary` stays as the raw Details. */
  plain: PlainInboxMessage;
  spawnedAt: string;
}

/**
 * One DECLINED proposal, as GET /v1/inbox renders it (W1-T3408). Carries the decline's own reason
 * verbatim, so the list says WHY each was refused and a reader can tell a deliberate refusal from
 * one entered on reasoning that has since been shown wrong.
 *
 * IT IS A SEPARATE ARRAY, not folded into `notReady`: a declined proposal is not awaiting anything
 * and must never read as work in progress. Nothing here is actionable except restore.
 */
export interface InboxDeclinedItem {
  proposalId: string;
  summary: string;
  /** W1-T4087: the item's plain-language message; `summary` stays as the raw Details. */
  plain: PlainInboxMessage;
  /** The reason the latest `panel.proposal_declined` row recorded, verbatim. */
  reason: string;
}

/** One not-ready proposal, as GET /v1/inbox renders it (W1-T2604). `reasons` is the exact {@link
 *  PredicateFailure}[] `classifyProposal` computed, never a bare string, so an operator sees why
 *  without attempting an approve. A separate array from `ready`/`drafting`: presence here implies
 *  no affordance, so it never reintroduces the approval fatigue the ready-only list cured. */
export interface InboxNotReadyItem {
  proposalId: string;
  summary: string;
  /** W1-T4087: the item's plain-language message; `summary` stays as the raw Details. */
  plain: PlainInboxMessage;
  reasons: PredicateFailure[];
}

/** W1-T4086: one fleet-owned proposal in `GET /v1/inbox`'s `fleet` list, with the lane it sits in. */
export interface InboxFleetItem {
  proposalId: string;
  summary: string;
  /** W1-T4087: the item's plain-language message; `summary` stays as the raw Details. */
  plain: PlainInboxMessage;
  lane: "ready" | "drafting" | "notReady" | "declined";
  /** W1-T4089: the fleet lane's latest decision, when it has made one. */
  decision?: FleetLaneDecision;
  reason?: string;
}

/** The drafted fragment's task ids + titles. A ready fragment already passed classifyProposal's
 *  own parse+lint checks, so this re-parse is expected to always succeed — the catch is
 *  defense-in-depth, exported so that branch stays directly unit-testable. */
export function draftedTaskSummaries(fragmentYaml: string, proposalId: string): InboxDraftedTask[] {
  try {
    return parseTasksFromYaml(fragmentYaml, `inbox draft ${proposalId}`).map((t) => ({ id: t.id, title: t.title }));
  } catch (e) {
    if (!(e instanceof PlanError)) throw e;
    return [];
  }
}

/** What every /v1/inbox* route reads off one classification pass. Shared, never copied, by the memo below:
 *  callers treat every array and object in it as READ-ONLY. */
export interface ClassifiedInbox {
  registryPath: string;
  proposals: Proposal[];
  classifications: InboxClassification[];
  ledgerLines: LedgerLines;
}

function statStamp(path: string): string | undefined {
  try {
    const s = statSync(path, { throwIfNoEntry: false });
    return s === undefined ? undefined : `${s.size}:${s.mtimeMs}:${s.ino}`;
  } catch (e) {
    // An unstattable input is read by readFileIfExists as absent too, so a stable stamp naming the failure is exact:
    // two passes that both fail to read it both classify it as absent.
    return `unreadable:${(e as NodeJS.ErrnoException).code ?? "unknown"}`;
  }
}

function listDirOrUndefined(path: string): string[] | undefined {
  try {
    return readdirSync(path).sort();
  } catch (_err) {
    // No shard directory is a plan made of tasks.yaml alone; loadPlan tolerates it the same way.
    return undefined;
  }
}

/** Where the four inbox state files live, derived once so the reader and the memo's stamps never disagree. */
function inboxInputPaths(deps: PanelGraphDeps): { registryPath: string; draftsPath: string; inflightPath: string; adoptionPath: string } {
  const stateDir = join(deps.inboxRoot, "state");
  return {
    registryPath: join(stateDir, "inbox-proposals.json"),
    draftsPath: join(stateDir, "inbox-drafts.json"),
    inflightPath: join(stateDir, "inbox-draft-inflight.json"),
    adoptionPath: adoptionLatestPath(stateDir),
  };
}

/** Per-deps classifier state. A WeakMap keyed by the deps object holds ONE memo entry per deps (the gateway builds
 *  one), so it cannot grow with requests and goes when its routes go. */
interface InboxClassifyState {
  grep: AnchorGrepCache;
  fragments: FragmentMemo;
  /** The last ledger read, reused while the ledger's stamp is unchanged. */
  ledger?: { stamp: string | null; lines: LedgerLines; verdictDigest: string };
  last?: { key: string; plan: Plan; planKey?: string; result: ClassifiedInbox };
  /** A sliced refresh in progress, so a second caller with the same inputs awaits it instead of starting another. */
  pending?: { key: string; plan: Plan; promise: Promise<ClassifiedInbox> };
}
const inboxClassifyStates = new WeakMap<PanelGraphDeps, InboxClassifyState>();

function inboxClassifyState(deps: PanelGraphDeps): InboxClassifyState {
  let state = inboxClassifyStates.get(deps);
  if (state === undefined) {
    state = { grep: createAnchorGrepCache(), fragments: createFragmentMemo() };
    inboxClassifyStates.set(deps, state);
  }
  return state;
}

/** The anchor-grep predicate one pass hands every proposal: answered per main commit from the deps' cache. */
function anchorGrepFor(deps: PanelGraphDeps, sha: string | undefined): (anchor: EvidenceAnchor) => boolean {
  const grep = deps.inboxGrepAnchor ?? gitGrepAnchorTrue;
  const cache = inboxClassifyState(deps).grep;
  return (anchor) => cachedAnchorGrep(cache, sha, anchor, (ref, a) => grep(deps.root, ref, a));
}

/** One pass's inputs, read, with the per-proposal step still to run — so the same pass can run whole or in slices. */
interface InboxPass {
  registryPath: string;
  proposals: Proposal[];
  ledgerLines: LedgerLines;
  classifyOne: (proposal: Proposal) => InboxClassification;
}

/**
 * Read one pass's inputs over an already-loaded plan, projection and ledger. The registry-wide open-id set and the
 * ledger's ratify/decline verdicts are built ONCE per pass here (W1-T4261) — both were rebuilt per proposal, the
 * first by copying the whole id set for each one.
 */
function prepareInboxPass(
  deps: PanelGraphDeps,
  plan: Plan,
  projection: Map<string, StatusProjection>,
  ledgerLines: LedgerLines,
  grepAnchorTrue: (anchor: EvidenceAnchor) => boolean,
): InboxPass {
  const { registryPath, draftsPath, inflightPath, adoptionPath } = inboxInputPaths(deps);
  const proposals = parseProposalRegistry(readFileIfExists(registryPath));
  const drafts: DraftCache = parseDraftCache(readFileIfExists(draftsPath));
  const inflight = parseDraftInFlightCache(readFileIfExists(inflightPath));
  // `?? false` is dead code on a present entry, not an absent-as-unmerged conflation (W1-T510):
  // `projection` derives one entry per `plan.tasks`, the same `plan` this projection comes from.
  const isMerged: MergedResolver = (t) => projection.get(t.id)?.merged ?? false;
  const depsUnobservable = (taskId: string): GhFailureReason | undefined => {
    const p = projection.get(taskId);
    return p?.indeterminate ? (p.unavailableReason ?? "unknown") : undefined;
  };
  const allIds = new Set(proposals.map((p) => p.id));
  // W1-T190: the console must never offer the ratify affordance on a proposal the
  // ledger already carries `ratify.approved` for, even when the registry entry itself
  // still looks READY (a drifted write) — re-derived from the ledger on every pass,
  // never trusted from the registry's own state.
  const verdicts = ledgerProposalVerdicts(ledgerLines);
  // W1-T3518: the last adoption scan's own output. Same posture as the ledger read — read
  // ONCE per pass here, re-derived every pass that recomputes.
  const adoptionLatest = readAdoptionLatest(adoptionPath);
  const fragmentMemo = inboxClassifyState(deps).fragments;
  beginFragmentPass(fragmentMemo);

  const classifyOne = (proposal: Proposal): InboxClassification =>
    classifyProposal(proposal, drafts[proposal.id], {
      plan,
      isMerged,
      depsUnobservable,
      grepAnchorTrue,
      // Every OTHER registry id: one shared set behind a view that excludes this proposal.
      openProposalIds: { has: (id) => id !== proposal.id && allIds.has(id) },
      isRatified: verdicts.isRatified,
      isDeclined: verdicts.isDeclined,
      // W1-T3518: the record is read ONCE per pass above and this predicate closes over it.
      // An absent or unparseable record reads as undefined, so NO proposal retires — the
      // direction a missing measurement must always fail.
      adoptionFindingGone: (id) => adoptionFindingGone(id, adoptionLatest),
      draftSpawnedAt: (id) => inflight[id],
      fragmentMemo,
    });
  return { registryPath, proposals, ledgerLines, classifyOne };
}

/**
 * Shared read + classify step every /v1/inbox* WRITE route needs, recomputed on every call. `loadPlanFn` defaults to
 * {@link loadPlan}'s torn-read-guarded read (W1-T2220 remedy (a)); `POST /v1/inbox/approve` passes {@link
 * loadPlanAtRef} instead (remedy (c)) since only it gates an irreversible action here. The read routes go through
 * {@link classifyAllProposalsMemo}; this path shares only the per-commit anchor grep and the per-plan-object fragment
 * verdicts, both of which answer exactly what a recompute would.
 */
function classifyAllProposals(deps: PanelGraphDeps, loadPlanFn: (planPath: string) => Plan = loadPlan): ClassifiedInbox {
  const plan = loadPlanFn(deps.planPath);
  const projection = projectPlan(plan, { ledgerPath: deps.ledgerPath, github: deps.statusGithub });
  const ledgerLines = readLedgerLines(deps.ledgerPath);
  const sha = (deps.inboxMainSha ?? readOriginMainSha)(deps.root);
  const pass = prepareInboxPass(deps, plan, projection, ledgerLines, anchorGrepFor(deps, sha));
  return { registryPath: pass.registryPath, proposals: pass.proposals, classifications: pass.proposals.map(pass.classifyOne), ledgerLines };
}

/** The plan's change stamp when it is read off disk: tasks.yaml plus every entry of its shard directory. */
function planFilesStamp(planPath: string, stat: (path: string) => string | undefined, listDir: (path: string) => string[] | undefined): string {
  const shardDir = join(dirname(planPath), "tasks.d");
  const shards = listDir(shardDir) ?? [];
  return JSON.stringify([stat(planPath), shards.map((name) => [name, stat(join(shardDir, name))])]);
}

/** Only what classifyProposal reads off a projection: merged, and an indeterminate read's reason. */
function projectionDigest(projection: Map<string, StatusProjection>): string {
  const parts: string[] = [];
  for (const [id, p] of projection) parts.push(`${id}:${p.merged ? 1 : 0}:${p.indeterminate ? (p.unavailableReason ?? "unknown") : ""}`);
  return parts.join("|");
}

/** Only what classifyProposal reads off the ledger: which ids are ratified, and which declined with what reason. */
function ledgerVerdictDigest(lines: LedgerLines): string {
  const { ratified, declined } = ledgerProposalVerdicts(lines);
  return JSON.stringify([[...ratified].sort(), [...declined].sort((x, y) => (x[0] < y[0] ? -1 : 1))]);
}

/** One pass's fingerprint and the inputs it was taken over. */
interface InboxFingerprint {
  key: string;
  sha?: string;
  plan: Plan;
  planKey?: string;
  projection: Map<string, StatusProjection>;
  ledgerLines: LedgerLines;
}

/**
 * Stamp everything a classification reads — BEFORE reading it, so a write racing the pass invalidates the next one.
 * The ledger enters through what classification reads off it (its ratify/decline verdicts, and the projection's
 * merged facts), never its raw stamp: the daemon appends to it continuously, and a stamp would recompute on every
 * unrelated row.
 */
function inboxFingerprint(deps: PanelGraphDeps, state: InboxClassifyState, readPlanSnapshot?: () => Plan): InboxFingerprint {
  const stat = deps.inboxStatFile ?? statStamp;
  const { registryPath, draftsPath, inflightPath, adoptionPath } = inboxInputPaths(deps);
  const stamps = [registryPath, draftsPath, inflightPath, adoptionPath].map((p) => stat(p) ?? null);
  const sha = (deps.inboxMainSha ?? readOriginMainSha)(deps.root);

  const ledgerStamp = stat(deps.ledgerPath) ?? null;
  if (state.ledger === undefined || state.ledger.stamp !== ledgerStamp) {
    const lines = readLedgerLines(deps.ledgerPath);
    state.ledger = { stamp: ledgerStamp, lines, verdictDigest: ledgerVerdictDigest(lines) };
  }
  const { lines: ledgerLines, verdictDigest } = state.ledger;

  const snapshot = readPlanSnapshot?.();
  let plan: Plan;
  let planKey: string | undefined;
  if (snapshot !== undefined) {
    plan = snapshot;
  } else {
    planKey = planFilesStamp(deps.planPath, stat, deps.inboxListDir ?? listDirOrUndefined);
    const last = state.last;
    plan = last?.planKey !== undefined && last.planKey === planKey ? last.plan : loadPlan(deps.planPath);
  }
  const projection = projectPlan(plan, { ledgerPath: deps.ledgerPath, github: deps.statusGithub, readLedger: () => ledgerLines });
  const key = JSON.stringify([stamps, sha ?? null, verdictDigest, projectionDigest(projection)]);
  return { key, sha, plan, planKey, projection, ledgerLines };
}

/** The previous result, when `fp` names exactly its inputs and the commit is known. Its ledger rows are this pass's. */
function reusableResult(state: InboxClassifyState, fp: InboxFingerprint): ClassifiedInbox | undefined {
  const last = state.last;
  if (fp.sha === undefined || last === undefined || last.plan !== fp.plan || last.key !== fp.key) return undefined;
  return last.result.ledgerLines === fp.ledgerLines ? last.result : { ...last.result, ledgerLines: fp.ledgerLines };
}

/**
 * W1-T4261 — THE READ ROUTES' CLASSIFIER. MEASURED 2026-09-23 on the fleet gateway: every GET /v1/inbox pass
 * reclassified 693 proposals synchronously (81% of the serve process's CPU; /v1/status timed out at 15 s on an idle
 * host). This returns the previous pass's result whenever nothing it reads has changed: the four inbox state files
 * (size, mtime, inode), the plan (the process snapshot's identity, or tasks.yaml and its shards' stamps), the
 * ledger's ratify/decline verdicts, the GitHub-derived projection's merged facts, and origin/main's sha. An
 * unresolvable sha never reuses. {@link classifyAllProposalsSliced} is the same memo with a recompute that yields.
 */
export function classifyAllProposalsMemo(deps: PanelGraphDeps, readPlanSnapshot?: () => Plan): ClassifiedInbox {
  const state = inboxClassifyState(deps);
  const fp = inboxFingerprint(deps, state, readPlanSnapshot);
  const reused = reusableResult(state, fp);
  if (reused !== undefined) return reused;
  const pass = prepareInboxPass(deps, fp.plan, fp.projection, fp.ledgerLines, anchorGrepFor(deps, fp.sha));
  const result = { registryPath: pass.registryPath, proposals: pass.proposals, classifications: pass.proposals.map(pass.classifyOne), ledgerLines: fp.ledgerLines };
  state.last = { key: fp.key, plan: fp.plan, planKey: fp.planKey, result };
  return result;
}

/** PRIMARY CONTROL on how long one inbox recompute holds the event loop: proposals classified between yields. Each can
 *  cost a `git grep` spawn (~8 ms) per uncached anchor, so ten is well under 200 ms even on a cold commit. */
export const INBOX_CLASSIFY_SLICE = 10;

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * {@link classifyAllProposalsMemo} for the CACHED GET /v1/inbox refresh: a recompute classifies
 * {@link INBOX_CLASSIFY_SLICE} proposals at a time and yields between slices, so every other route keeps answering
 * while it runs and the console's cached-read wrapper serves the previous body. MEASURED on a 700-proposal fixture
 * with every anchor distinct: a cold commit was a single ~5 s block. A second caller over the same inputs awaits the
 * running refresh rather than starting its own.
 */
export async function classifyAllProposalsSliced(
  deps: PanelGraphDeps,
  readPlanSnapshot?: () => Plan,
  yieldNow: () => Promise<void> = yieldToEventLoop,
): Promise<ClassifiedInbox> {
  const state = inboxClassifyState(deps);
  const fp = inboxFingerprint(deps, state, readPlanSnapshot);
  const reused = reusableResult(state, fp);
  if (reused !== undefined) return reused;
  if (state.pending !== undefined && state.pending.key === fp.key && state.pending.plan === fp.plan) return state.pending.promise;
  const pass = prepareInboxPass(deps, fp.plan, fp.projection, fp.ledgerLines, anchorGrepFor(deps, fp.sha));
  const run = async (): Promise<ClassifiedInbox> => {
    const classifications: InboxClassification[] = [];
    for (let i = 0; i < pass.proposals.length; i += INBOX_CLASSIFY_SLICE) {
      if (i > 0) await yieldNow();
      for (const proposal of pass.proposals.slice(i, i + INBOX_CLASSIFY_SLICE)) classifications.push(pass.classifyOne(proposal));
    }
    const result = { registryPath: pass.registryPath, proposals: pass.proposals, classifications, ledgerLines: fp.ledgerLines };
    state.last = { key: fp.key, plan: fp.plan, planKey: fp.planKey, result };
    return result;
  };
  const promise = run().finally(() => {
    if (state.pending?.promise === promise) state.pending = undefined;
  });
  state.pending = { key: fp.key, plan: fp.plan, promise };
  return promise;
}

/**
 * GET /v1/inbox — read-scoped. The ratification inbox's (W1-T110) ready and drafting tiers,
 * computed the way `rmd inbox` prints them, for the shell's NEEDS ME section. Deferred-with-
 * trigger proposals are never returned — only what is actionable or in-progress is surfaced.
 * Not-ready proposals (W1-T2604) ride along in `notReady` (see {@link InboxNotReadyItem});
 * Ratified/retired proposals stay excluded from every array. DECLINED ones are returned in their
 * own `declined` array (W1-T3408): `POST /v1/inbox/restore` shipped with no way to learn its own
 * argument, because a declined proposal was invisible here — a write route whose parameter cannot
 * be discovered is a mechanism nobody can reach. `rmd approve`/`reframe`/`decline` are wired from
 * the card below, over the same write-token scope every write uses.
 */
export function buildInboxRoute(deps: PanelGraphDeps, readPlanSnapshot?: () => Plan): Route {
  return {
    method: "GET",
    path: "/v1/inbox",
    scope: "read",
    // W1-T4261: async so a recompute yields between slices; the console's cached-read wrapper serves the previous
    // body meanwhile. An unchanged input set answers from the memo with no recompute at all.
    handler: async (_req, res) => {
      const { registryPath, proposals, classifications, ledgerLines } = await classifyAllProposalsSliced(deps, readPlanSnapshot);
      // W1-T4087: every item carries its plain message — the stored one, or its kind's template.
      const plainStore = readPlainStore(plainStorePath(join(deps.inboxRoot, "state")));

      const ready: InboxReadyItem[] = [];
      const drafting: InboxDraftingItem[] = [];
      const notReady: InboxNotReadyItem[] = [];
      const declined: InboxDeclinedItem[] = [];
      for (const classification of classifications) {
        const proposal = proposals.find((p) => p.id === classification.proposalId);
        if (!proposal) continue; // unreachable — classifications are 1:1 with proposals
        if (classification.state === "ready") {
          ready.push({
            proposalId: proposal.id,
            summary: proposal.summary,
            plain: plainInboxMessage(proposal, plainStore),
            stampLine: classification.draft?.stampLine,
            draftedTasks: classification.draft ? draftedTaskSummaries(classification.draft.fragmentYaml, proposal.id) : [],
          });
        } else if (classification.state === "drafting") {
          drafting.push({ proposalId: proposal.id, summary: proposal.summary, plain: plainInboxMessage(proposal, plainStore), spawnedAt: classification.draftSpawnedAt ?? "" });
        } else if (classification.state === "declined") {
          declined.push({
            proposalId: proposal.id,
            summary: proposal.summary,
            plain: plainInboxMessage(proposal, plainStore),
            reason: classification.declinedReason ?? "declined by an operator",
          });
        } else if (classification.state === "not_ready") {
          // W1-T2604 (finding (i)): the failing predicate(s) classifyProposal already named,
          // never a bare "not_ready" — see InboxNotReadyItem's own doc.
          notReady.push({ proposalId: proposal.id, summary: proposal.summary, plain: plainInboxMessage(proposal, plainStore), reasons: classification.reasons });
        }
      }
      // A "ratified" classification is detected off the ledger (W1-T190); detection alone leaves
      // the drifted row on disk, so heal it here (a no-op write when nothing needs healing).
      // Races three other writers of this file (W1-T240): reapply prunedIds against a fresh
      // read under lock, never blind-write the array this handler read at request start.
      const { prunedIds } = pruneRatifiedProposals(proposals, classifications);
      if (prunedIds.length > 0) {
        const prunedIdSet = new Set(prunedIds);
        updateProposalRegistry(registryPath, (current) => {
          const fresh = current.filter((p) => !prunedIdSet.has(p.id));
          return fresh.length === current.length ? null : fresh;
        });
      }
      // W1-T4089: the daemon's fleet lane files only what this classification calls ready, so it
      // acts on the same readiness truth the operator sees rather than a second, cheaper guess.
      writeClassificationSnapshot(join(deps.inboxRoot, "state"), classifications);
      // W1-T4086: split every lane by who must act. `needsYou` holds only the operator's items;
      // `fleet` holds the fleet's own findings with the lane each sits in. The four top-level
      // lanes stay unchanged for one release so the console can move over without a break.
      const isOperator = (item: { proposalId: string }) => inboxOwner({ id: item.proposalId }) === "operator";
      const fleetDecisions = fleetLaneDecisions(ledgerLines as never, fleetLaneStoreForDisplay(join(deps.inboxRoot, "state")));
      const needsYou = {
        ready: ready.filter(isOperator),
        drafting: drafting.filter(isOperator),
        notReady: notReady.filter(isOperator),
        declined: declined.filter(isOperator),
      };
      const fleet: InboxFleetItem[] = [
        ...ready.map((i) => ({ proposalId: i.proposalId, summary: i.summary, plain: i.plain, lane: "ready" as const })),
        ...drafting.map((i) => ({ proposalId: i.proposalId, summary: i.summary, plain: i.plain, lane: "drafting" as const })),
        ...notReady.map((i) => ({ proposalId: i.proposalId, summary: i.summary, plain: i.plain, lane: "notReady" as const })),
        ...declined.map((i) => ({ proposalId: i.proposalId, summary: i.summary, plain: i.plain, lane: "declined" as const })),
      ]
        .filter((i) => !isOperator(i))
        // W1-T4089: each fleet finding's latest fleet-lane decision and its plain reason.
        .map((i) => ({ ...i, ...fleetDecisions.get(i.proposalId) }));
      sendJson(res, 200, { ready, drafting, notReady, declined, needsYou, fleet });
    },
  };
}

// ── W1-T4088: the inbox as threads ─────────────────────────────────────────────────────────────

const CLASSIFICATION_TO_THREAD_STATE: Partial<Record<string, InboxThreadItem["state"]>> = {
  ready: "ready",
  drafting: "drafting",
  not_ready: "notReady",
  declined: "declined",
};

/** Every operator-owned item with its plain message and state, off the SAME classification
 *  `GET /v1/inbox` renders. */
function operatorThreadItems(deps: PanelGraphDeps, readPlanSnapshot?: () => Plan): InboxThreadItem[] {
  const { proposals, classifications } = classifyAllProposalsMemo(deps, readPlanSnapshot);
  const plainStore = readPlainStore(plainStorePath(join(deps.inboxRoot, "state")));
  const items: InboxThreadItem[] = [];
  for (const c of classifications) {
    const state = CLASSIFICATION_TO_THREAD_STATE[c.state];
    const proposal = proposals.find((p) => p.id === c.proposalId);
    if (!state || !proposal || inboxOwner(proposal) !== "operator") continue;
    items.push({ proposalId: proposal.id, summary: proposal.summary, plain: plainInboxMessage(proposal, plainStore), state });
  }
  return items;
}

/** The thread store every inbox thread route and the daemon's responder share. */
export function inboxThreadStorePath(inboxRoot: string): string {
  return join(inboxRoot, "state", "inbox-threads.jsonl");
}

function readThreadsOr500(deps: PanelGraphDeps, res: ServerResponse) {
  const all = readAllThreads({ threadStorePath: inboxThreadStorePath(deps.inboxRoot) });
  if (all.status === "unresolved") {
    sendJson(res, 500, { error: "thread_store_unreadable", detail: all.reason });
    return undefined;
  }
  return all.threads;
}

/** GET /v1/inbox/threads — the operator's threads: headline, first line of the latest message, who
 *  it is waiting on, last activity, message count and unread. Waiting-on-you first. */
export function buildInboxThreadsRoute(deps: PanelGraphDeps, readPlanSnapshot?: () => Plan): Route {
  return {
    method: "GET",
    path: "/v1/inbox/threads",
    scope: "read",
    handler: (_req, res) => {
      const threads = readThreadsOr500(deps, res);
      if (!threads) return;
      const marks = readReadMarks(readMarksPath(join(deps.inboxRoot, "state")));
      sendJson(res, 200, { threads: listThreadViews(operatorThreadItems(deps, readPlanSnapshot), threads, marks) });
    },
  };
}

/** GET /v1/inbox/thread?id=<threadId> — one thread's messages, oldest first, with the raw summary
 *  as `details`. */
export function buildInboxThreadRoute(deps: PanelGraphDeps, readPlanSnapshot?: () => Plan): Route {
  return {
    method: "GET",
    path: "/v1/inbox/thread",
    scope: "read",
    handler: (req, res) => {
      const threadId = new URL(req.url ?? "/", "http://localhost").searchParams.get("id") ?? "";
      const proposalId = proposalIdOfThread(threadId);
      const item = proposalId ? operatorThreadItems(deps, readPlanSnapshot).find((i) => i.proposalId === proposalId) : undefined;
      if (!item) {
        sendJson(res, 404, { error: "not_found", detail: `no inbox thread "${threadId}"` });
        return;
      }
      const threads = readThreadsOr500(deps, res);
      if (!threads) return;
      const marks = readReadMarks(readMarksPath(join(deps.inboxRoot, "state")));
      sendJson(res, 200, threadDetailView(item, threads, marks));
    },
  };
}

interface ThreadReplyInput {
  threadId: string;
  text: string;
}

function validateThreadReply(body: unknown): { error: string } | ThreadReplyInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (typeof body.threadId !== "string" || !proposalIdOfThread(body.threadId)) return { error: "threadId must name an inbox thread" };
  if (typeof body.text !== "string" || !body.text.trim()) return { error: "text is required" };
  if (body.text.length > 4000) return { error: "text must be 4000 characters or fewer" };
  return { threadId: body.threadId, text: body.text.trim() };
}

/** The operator's display name the console passes (audit only, never an authorisation input). */
function operatorName(req: IncomingMessage): string | undefined {
  const raw = req.headers["x-remudero-operator"];
  const name = typeof raw === "string" ? raw.trim() : "";
  return name && name.length <= 80 && /^[\x20-\x7e]+$/.test(name) ? name : undefined;
}

/** POST /v1/inbox/thread/reply — the operator writes on a thread. LOW: it only adds a message; the
 *  daemon's responder decides what the reply means and may itself take only reversible actions. */
export function buildInboxThreadReplyRoute(deps: PanelGraphDeps): Route {
  return {
    method: "POST",
    path: "/v1/inbox/thread/reply",
    scope: "write",
    // W1-T404: LOW — appends a message; a reply is an input, never a command (see inbox-responder.ts).
    tier: "low",
    handler: jsonAction(validateThreadReply, (input, req, res) => {
      const proposalId = proposalIdOfThread(input.threadId)!;
      const operator = operatorName(req);
      appendThreadMessage(
        inboxThreadIdentity(proposalId),
        "reply",
        input.text,
        { threadStorePath: inboxThreadStorePath(deps.inboxRoot) },
        operator ? { operator } : undefined,
      );
      appendPanelLedger(deps.ledgerPath, "inbox.thread_replied", proposalId, bearerTokenId(req), { thread_id: input.threadId });
      sendJson(res, 200, { ok: true, threadId: input.threadId, waitingOn: "daemon" });
    }),
  };
}

interface ThreadReadInput {
  threadId: string;
  seq: number;
}

function validateThreadRead(body: unknown): { error: string } | ThreadReadInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (typeof body.threadId !== "string" || !proposalIdOfThread(body.threadId)) return { error: "threadId must name an inbox thread" };
  if (typeof body.seq !== "number" || !Number.isInteger(body.seq) || body.seq < 0) return { error: "seq must be a whole number" };
  return { threadId: body.threadId, seq: body.seq };
}

/** POST /v1/inbox/thread/read — mark a thread read up to `seq`. LOW: bookkeeping only. */
export function buildInboxThreadReadRoute(deps: PanelGraphDeps): Route {
  return {
    method: "POST",
    path: "/v1/inbox/thread/read",
    scope: "write",
    // W1-T404: LOW — a read mark; changes nothing but the unread flag.
    tier: "low",
    handler: jsonAction(validateThreadRead, (input, _req, res) => {
      markThreadRead(readMarksPath(join(deps.inboxRoot, "state")), input.threadId, input.seq);
      sendJson(res, 200, { ok: true });
    }),
  };
}

// ── POST /v1/inbox/approve, POST /v1/inbox/reframe — the operator's ratification bit, wired
// through the write-token API from the card (W1-T193, MASTER-PLAN P25 ii-iii) ───────────────

/**
 * `rmd approve`/`rmd reframe` drive a multi-minute pipeline (push, `gh pr create`, CI, review,
 * auto-merge). Blocking an HTTP response on that risks a request that never returns, so this
 * gateway spawns the real CLI as a detached, unref'd child — reusing the already-tested flow.
 * The response confirms only a hand-off; the resulting PR surfaces via the console's own polling.
 */
export interface RatifyCliGateway {
  approve(proposalId: string): void;
  reframe(proposalId: string, feedback: string): void;
}

/** The fleet lane's decision store for display. A store that cannot be read shows the ledger's rows
 *  alone rather than failing the whole inbox; the lane itself refuses to act on such a store. */
export function fleetLaneStoreForDisplay(stateDir: string): ReturnType<typeof readFleetLaneStore> {
  try {
    return readFleetLaneStore(stateDir);
  } catch {
    // deliberate: this is a read-only view; an unreadable store falls back to the live ledger's rows.
    return {};
  }
}

/** Real {@link RatifyCliGateway}: shells out to the repo's own `bin/rmd`, matching a terminal
 *  invocation exactly. stdout/stderr are appended to a per-call log under `<logDir>`, since no
 *  operator terminal is watching this run — a failing spawn still leaves a trace. */
export function ratifyCliGateway(repoRoot: string, logDir: string): RatifyCliGateway {
  const rmdBin = join(repoRoot, "bin", "rmd");
  const spawnDetached = (args: string[], label: string) => {
    mkdirSync(logDir, { recursive: true });
    // A proposal id can hold a path (`symbol-no-caller:src/lib/retro.ts:x`); the log name must stay one file.
    const logFd = openSync(join(logDir, `${label.replace(/[^\w.-]+/g, "_")}-${Date.now()}.log`), "a");
    try {
      const child = spawn(rmdBin, args, { cwd: repoRoot, detached: true, stdio: ["ignore", logFd, logFd] });
      child.unref();
    } finally {
      closeSync(logFd);
    }
  };
  return {
    approve(proposalId) {
      spawnDetached(["approve", proposalId], `approve-${proposalId}`);
    },
    reframe(proposalId, feedback) {
      spawnDetached(["reframe", proposalId, "--feedback", feedback], `reframe-${proposalId}`);
    },
  };
}

interface ApproveProposalInput {
  proposalId: string;
}

function validateApproveProposal(body: unknown): { error: string } | ApproveProposalInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (typeof body.proposalId !== "string" || !body.proposalId.trim()) return { error: "proposalId is required" };
  return { proposalId: body.proposalId };
}

/**
 * POST /v1/inbox/approve — write-scoped. Re-classifies the proposal live and refuses with 409
 * anything not currently ready, naming why ({@link refusalReason}) — server-side, since a race
 * between the last poll and the click is otherwise possible. A ready proposal hands off to
 * {@link RatifyCliGateway.approve}. Ledgers `panel.proposal_approve_requested` immediately.
 */
export function buildApproveProposalRoute(deps: PanelGraphDeps): Route {
  return {
    method: "POST",
    path: "/v1/inbox/approve",
    scope: "write",
    // W1-T404: HIGH — moves code (hands off to a detached rmd spawn: ratify/merge).
    tier: "high",
    handler: jsonAction(validateApproveProposal, (input, req, res) => {
      // The one call site among classifyAllProposals's consumers that hands off to an
      // irreversible spawn, so it alone reads via loadPlanAtRef, "cannot be partial" (W1-T2220).
      const { proposals, classifications } = classifyAllProposals(deps, (planPath) =>
        loadPlanAtRef(deps.root, relative(deps.root, planPath)),
      );
      if (!proposals.some((p) => p.id === input.proposalId)) {
        sendJson(res, 404, { error: "not_found", detail: `no active proposal "${input.proposalId}"` });
        return;
      }
      const classification = classifications.find((c) => c.proposalId === input.proposalId);
      if (!classification || classification.state !== "ready") {
        sendJson(res, 409, {
          error: "not_ready",
          detail: classification ? refusalReason(classification) : `${input.proposalId}: classification unavailable`,
        });
        return;
      }
      const origin = bearerTokenId(req);
      appendPanelLedger(deps.ledgerPath, "panel.proposal_approve_requested", input.proposalId, origin, {});
      deps.ratify.approve(input.proposalId);
      sendJson(res, 200, { ok: true, proposalId: input.proposalId, started: true });
    }),
  };
}

interface ReframeProposalInput {
  proposalId: string;
  feedback: string;
}

function validateReframeProposal(body: unknown): { error: string } | ReframeProposalInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (typeof body.proposalId !== "string" || !body.proposalId.trim()) return { error: "proposalId is required" };
  if (typeof body.feedback !== "string" || !body.feedback.trim()) return { error: "feedback is required" };
  return { proposalId: body.proposalId, feedback: body.feedback };
}

/**
 * POST /v1/inbox/reframe — write-scoped. Captures the operator's feedback verbatim and hands off
 * to {@link RatifyCliGateway.reframe}. Valid for any proposal in the active registry regardless
 * of classification — reframe is feedback, never a ratification, and carries no readiness
 * precondition. Ledgers `panel.proposal_reframe_requested` (with the feedback text) immediately.
 */
export function buildReframeProposalRoute(deps: PanelGraphDeps): Route {
  return {
    method: "POST",
    path: "/v1/inbox/reframe",
    scope: "write",
    // W1-T404: LOW — bookkeeping, trivially reversible (feedback, no ratification).
    tier: "low",
    handler: jsonAction(validateReframeProposal, (input, req, res) => {
      const { proposals } = classifyAllProposals(deps);
      if (!proposals.some((p) => p.id === input.proposalId)) {
        sendJson(res, 404, { error: "not_found", detail: `no active proposal "${input.proposalId}"` });
        return;
      }
      const origin = bearerTokenId(req);
      appendPanelLedger(deps.ledgerPath, "panel.proposal_reframe_requested", input.proposalId, origin, { feedback: input.feedback });
      deps.ratify.reframe(input.proposalId, input.feedback);
      sendJson(res, 200, { ok: true, proposalId: input.proposalId, started: true });
    }),
  };
}

interface DeclineProposalInput {
  proposalId: string;
  reason: string;
}

function validateDeclineProposal(body: unknown): { error: string } | DeclineProposalInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (typeof body.proposalId !== "string" || !body.proposalId.trim()) return { error: "proposalId is required" };
  if (typeof body.reason !== "string" || !body.reason.trim()) return { error: "reason is required" };
  return { proposalId: body.proposalId, reason: body.reason };
}

/** Both inbox verdict routes: classify live, let {@link applyProposalVerdict} decide and record, answer in HTTP. */
function proposalVerdictResponse(
  kind: ProposalVerdictKind,
  deps: PanelGraphDeps,
  input: DeclineProposalInput,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const { proposals, classifications } = classifyAllProposals(deps);
  const found = {
    exists: proposals.some((p) => p.id === input.proposalId),
    classification: classifications.find((c) => c.proposalId === input.proposalId),
  };
  const origin = bearerTokenId(req);
  const outcome = applyProposalVerdict(kind, input, found, (step, id, reason) => appendPanelLedger(deps.ledgerPath, step, id, origin, { reason }));
  if (!outcome.ok) {
    sendJson(res, outcome.status, { error: outcome.error, detail: outcome.detail });
    return;
  }
  sendJson(res, 200, { ok: true, proposalId: input.proposalId, ...(kind === "decline" ? { declined: true } : { restored: true }) });
}

/**
 * POST /v1/inbox/decline — write-scoped. The inbox's third verb (W1-T2604): the only prior way a
 * proposal left the registry was `rmd approve`, so a self-withdrawn or duplicate one had no path
 * out except being approved into a task nobody wants. An operator act, never an inference —
 * `classifyProposal` never reads a proposal's own prose to decide this. A decline is not a delete:
 * the proposal stays in the registry (like `retired`, W1-T2451), and the receipt is checked before
 * every other predicate. W1-T3407: it is no longer PERMANENT either — {@link
 * buildRestoreProposalRoute} clears it, latest wins, so a decline entered on reasoning that later
 * proves wrong can be taken back. No plan task, no branch: this never calls {@link
 * RatifyCliGateway}. Valid for any active-registry proposal not already ratified or declined.
 * Why: the P19-shaped silent-drop history this route closes — docs/forensics/panel-graph.md
 */
export function buildDeclineProposalRoute(deps: PanelGraphDeps): Route {
  return {
    method: "POST",
    path: "/v1/inbox/decline",
    scope: "write",
    // W1-T404: LOW — bookkeeping, trivially reversible in effect (a ledger annotation; no
    // plan/branch/PR is ever created for this route to have to undo).
    tier: "low",
    handler: jsonAction(validateDeclineProposal, (input, req, res) => proposalVerdictResponse("decline", deps, input, req, res)),
  };
}

/** POST /v1/inbox/restore — W1-T3407, the reversal decline never had. Symmetric with it: same
 *  scope, LOW tier, 404. Refuses only a RATIFIED proposal (its task is already filed) and 409s one
 *  that is not declined. FALSIFIER: test/a-decline-can-be-taken-back.test.ts. */
export function buildRestoreProposalRoute(deps: PanelGraphDeps): Route {
  return {
    method: "POST",
    path: "/v1/inbox/restore",
    scope: "write",
    tier: "low",
    handler: jsonAction(validateDeclineProposal, (input, req, res) => proposalVerdictResponse("restore", deps, input, req, res)),
  };
}

// ── POST /v1/policy/daily-cost-ceiling, POST /v1/policy/daily-cost-ceiling/clear ────────────
// The operator's own write control over the daily-cost-ceiling override (W1-T364), gated on
// the effective ceiling resolving fresh every tick (W1-T363) — a write here takes effect on the
// daemon's next tick, no restart required. Neither handler duplicates the store's bounds check:
// a `PolicyError` maps straight to a 400. `deps.root` (never `inboxRoot`) is the same root every
// other route in this module already uses.
// Why: the operator-ruling and pre-W1-T363 history — docs/forensics/panel-graph.md

interface SetDailyCostCeilingInput {
  usd: number;
}

function validateSetDailyCostCeiling(body: unknown): { error: string } | SetDailyCostCeilingInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (typeof body.usd !== "number") return { error: "usd must be a number" };
  return { usd: body.usd };
}

/**
 * Ledgers the who/from/to/effective audit trail for one console write to the ceiling override
 * (W1-T333), shared by the set and clear handlers so the two routes can never record it two
 * different ways. `fromUsd` is the effective value immediately before this write, never the raw
 * override-file content, so a fallback-from-malformed read still records an accurate "from".
 */
function ledgerCeilingAudit(deps: Pick<PanelGraphDeps, "ledgerPath">, req: IncomingMessage, fromUsd: number, toUsd: number, effectiveUsd: number): void {
  appendDailyCostCeilingOverrideAudit(deps.ledgerPath, {
    runId: `CEILING-${Date.now()}`,
    taskId: "_console",
    who: bearerTokenId(req),
    fromUsd,
    toUsd,
    effectiveUsd,
  });
}

/** Shared by both handlers below so the `deps.policy ??` seam (test/config-reader-seams.test.ts's
 *  structural lock) appears exactly ONCE in this file's source, never duplicated per route. */
function ceilingPolicy(deps: Pick<PanelGraphDeps, "policy">): Policy {
  return deps.policy ?? loadDefaultPolicy();
}

/**
 * POST /v1/policy/daily-cost-ceiling — write-scoped. Sets the override to `{usd}` via the
 * store's own writer, which validates bounds and refuses out-of-range at write time (this route
 * adds no bounds check of its own). Responds with the resolved effective ceiling, never the raw
 * input echoed back, so a write the store could not honor is never misreported as taken hold.
 */
export function buildSetDailyCostCeilingRoute(deps: PanelGraphDeps): Route {
  return {
    method: "POST",
    path: "/v1/policy/daily-cost-ceiling",
    scope: "write",
    // W1-T404: MIDDLE — reversible (lowered again / cleared) but a spend force multiplier:
    // raising it spends nothing, it removes the thing that would have stopped the spending.
    tier: "middle",
    handler: jsonAction(validateSetDailyCostCeiling, (input, req, res) => {
      const policy = ceilingPolicy(deps);
      const before = resolveDailyCostCeiling(deps.root, policy);
      try {
        writeDailyCostCeilingOverride(deps.root, input.usd, policy);
      } catch (err) {
        if (err instanceof PolicyError) {
          sendJson(res, 400, { error: "invalid_request", detail: err.message });
          return;
        }
        throw err;
      }
      const after = resolveDailyCostCeiling(deps.root, policy);
      ledgerCeilingAudit(deps, req, before.usd, input.usd, after.usd);
      sendJson(res, 200, { ok: true, usd: after.usd, provenance: after.provenance, committedDefaultUsd: after.committedDefaultUsd });
    }),
  };
}

/**
 * POST /v1/policy/daily-cost-ceiling/clear — write-scoped, no body required. Clears
 * `state/DAILY_COST_CEILING_OVERRIDE` via the store's own `clearDailyCostCeilingOverride`
 * (idempotent — clearing an already-absent override is not an error), reverting the effective
 * ceiling to the committed `plan/policy.yaml` default.
 */
export function buildClearDailyCostCeilingRoute(deps: PanelGraphDeps): Route {
  return {
    method: "POST",
    path: "/v1/policy/daily-cost-ceiling/clear",
    scope: "write",
    // W1-T404: MIDDLE — reversible (re-set again) but a spend force multiplier, same reasoning
    // as the set route above.
    tier: "middle",
    handler: async (req, res) => {
      const policy = ceilingPolicy(deps);
      const before = resolveDailyCostCeiling(deps.root, policy);
      clearDailyCostCeilingOverride(deps.root);
      const after = resolveDailyCostCeiling(deps.root, policy);
      ledgerCeilingAudit(deps, req, before.usd, after.committedDefaultUsd, after.usd);
      sendJson(res, 200, { ok: true, usd: after.usd, provenance: after.provenance, committedDefaultUsd: after.committedDefaultUsd });
    },
  };
}

/** Routes that can only read the process-owned plan snapshot. No write route accepts that capability. */
export function buildPanelReadRoutes(deps: PanelGraphDeps, readPlanSnapshot?: () => Plan): Route[] {
  return [
    buildActionResultsRoute(deps.ledgerPath),
    buildOperatorActivityRoute(deps, readPlanSnapshot),
    buildFeedbackInboxRoute(deps),
    buildTraceRoute(deps),
    buildDrainPreviewRoute(deps, readPlanSnapshot),
    buildPlanViewRoute(deps, readPlanSnapshot),
    buildInboxRoute(deps, readPlanSnapshot),
    buildInboxThreadsRoute(deps, readPlanSnapshot),
    buildInboxThreadRoute(deps, readPlanSnapshot),
  ];
}

/** Write factories take only durable dependencies, so a process read snapshot cannot reach a mutation. */
export function buildPanelWriteRoutes(deps: PanelGraphDeps): Route[] {
  return [
    buildSubmitFeedbackRoute(deps),
    buildPreviewFeedbackRoute(deps),
    buildProposalDecisionRoute(deps),
    buildApproveProposalRoute(deps),
    buildReframeProposalRoute(deps),
    buildDeclineProposalRoute(deps),
    buildRestoreProposalRoute(deps),
    buildInboxThreadReplyRoute(deps),
    buildInboxThreadReadRoute(deps),
    buildSetDailyCostCeilingRoute(deps),
    buildClearDailyCostCeilingRoute(deps),
  ];
}

/** Every panel graph route, for a caller registering the full set at once (`rmd serve` wiring). */
export function buildPanelGraphRoutes(deps: PanelGraphDeps, readPlanSnapshot?: () => Plan): Route[] {
  return [...buildPanelReadRoutes(deps, readPlanSnapshot), ...buildPanelWriteRoutes(deps)];
}
