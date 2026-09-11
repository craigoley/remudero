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

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import type { IncomingMessage } from "node:http";
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
import {
  projectPlan,
  readLedgerLines,
  isDispatchBreakerTripped,
  dispatchesWithoutNewOwnedPr,
  DEFAULT_MAX_TASK_DISPATCHES,
  type GhFailureReason,
  type GitHub,
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
import {
  classifyProposal,
  declinedReasonInLedger,
  gitGrepAnchorTrue,
  isRatifiedInLedger,
  parseDraftCache,
  parseDraftInFlightCache,
  parseProposalRegistry,
  pruneRatifiedProposals,
  refusalReason,
  updateProposalRegistry,
  type DraftCache,
  type InboxClassification,
  type PredicateFailure,
  type Proposal,
} from "./inbox.js";

export interface PanelGraphDeps {
  /** Repo root — where plan/feedback/ lives. */
  root: string;
  /** `plan/tasks.yaml`'s path, reloaded fresh on every request — never cached, so a task a
   *  proposal PR just merged is visible on the next read (mirrors `rmd trace`'s own CLI path). */
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

/**
 * GET /v1/drain/preview[?max=<n>][&until=<id>] — read-scoped. The would-drain queue (W1-T140) as
 * ordered task cards: reloads the plan fresh, re-derives merged status via `projectPlan` (the
 * same projection `GET /v1/status` uses), and renders `drain.ts`'s own `buildDrainPreview`.
 */
export function buildDrainPreviewRoute(deps: PanelGraphDeps): Route {
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

      const plan = loadPlan(deps.planPath);
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
  const isCircuitTripped = (id: string) => isDispatchBreakerTripped(ledgerLines, id, maxDispatches);
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
      const dispatches = dispatchesWithoutNewOwnedPr(ledgerLines, task.id);
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
 *  for {@link resolveSectionHeading} to join against plan-index.json's headings. */
function classifyPlanRef(ref: string): { kind: PlanRefKind; token?: string } {
  if (ref.startsWith("§")) return { kind: "section", token: ref.slice(1) };
  if (ref.startsWith("MASTER-PLAN#")) return { kind: "section", token: ref.slice("MASTER-PLAN#".length) };
  if (/^W\d+-T\d+$/.test(ref)) return { kind: "task-id" };
  if (/^P\d+$/.test(ref)) return { kind: "retro-proposal" };
  if (/^WS-\d+$/.test(ref)) return { kind: "workstream" };
  return { kind: "unrecognized" };
}

/** Resolves a stripped section token ("5C", "7") to its plan-index.json heading, matching the
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
 * (W1-T376), and `frontier`, off one fresh plan load and one `projectPlan()` call, like {@link
 * buildDrainPreviewRoute}. The caches are created once per route closure, persisting for the
 * `rmd serve` process lifetime — never per-request, or every reading would look first-ever.
 */
export function buildPlanViewRoute(deps: PanelGraphDeps): Route {
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
      const plan = loadPlan(deps.planPath);
      const projection = projectPlan(plan, { ledgerPath: deps.ledgerPath, github: deps.statusGithub });
      const isMerged: MergedSet = (id) => projection.get(id)?.merged ?? false;
      const progress = computePlanProgress(plan, projection, deps.statusGithub, progressCache);
      const planRefs = readPlanRefs(deps.planPath);
      const planIndex = loadPlanIndex(join(dirname(deps.planPath), "plan-index.json"));
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
  stampLine?: string;
  draftedTasks: InboxDraftedTask[];
}

/** One proposal currently mid-draft (W1-T193): an Architect worker is running for it right now.
 *  `spawnedAt` lets a card render something during this legitimately multi-minute window,
 *  rather than looking broken (the liveness bar W1-T156 set). */
export interface InboxDraftingItem {
  proposalId: string;
  summary: string;
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
  reasons: PredicateFailure[];
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

/**
 * Shared read + classify step every /v1/inbox* route needs, assembled once so the write routes
 * can never drift from what GET /v1/inbox just rendered. `loadPlanFn` defaults to {@link
 * loadPlan}'s torn-read-guarded read (W1-T2220 remedy (a)); `POST /v1/inbox/approve` passes
 * {@link loadPlanAtRef} instead (remedy (c)) since only it gates an irreversible action here.
 */
function classifyAllProposals(
  deps: PanelGraphDeps,
  loadPlanFn: (planPath: string) => Plan = loadPlan,
): {
  registryPath: string;
  proposals: Proposal[];
  classifications: InboxClassification[];
} {
  const registryPath = join(deps.inboxRoot, "state", "inbox-proposals.json");
  const draftsPath = join(deps.inboxRoot, "state", "inbox-drafts.json");
  const inflightPath = join(deps.inboxRoot, "state", "inbox-draft-inflight.json");
  const proposals = parseProposalRegistry(readFileIfExists(registryPath));
  const drafts: DraftCache = parseDraftCache(readFileIfExists(draftsPath));
  const inflight = parseDraftInFlightCache(readFileIfExists(inflightPath));

  const plan = loadPlanFn(deps.planPath);
  const projection = projectPlan(plan, { ledgerPath: deps.ledgerPath, github: deps.statusGithub });
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
  // still looks READY (a drifted write) — re-derived from the ledger on every request,
  // never trusted from the registry's own state.
  const ledgerLines = readLedgerLines(deps.ledgerPath);

  const classifications = proposals.map((proposal) =>
    classifyProposal(proposal, drafts[proposal.id], {
      plan,
      isMerged,
      depsUnobservable,
      grepAnchorTrue: (anchor) => gitGrepAnchorTrue(deps.root, "origin/main", anchor),
      openProposalIds: new Set([...allIds].filter((id) => id !== proposal.id)),
      isRatified: (id) => isRatifiedInLedger(ledgerLines, id),
      isDeclined: (id) => declinedReasonInLedger(ledgerLines, id),
      draftSpawnedAt: (id) => inflight[id],
    }),
  );
  return { registryPath, proposals, classifications };
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
export function buildInboxRoute(deps: PanelGraphDeps): Route {
  return {
    method: "GET",
    path: "/v1/inbox",
    scope: "read",
    handler: (_req, res) => {
      const { registryPath, proposals, classifications } = classifyAllProposals(deps);

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
            stampLine: classification.draft?.stampLine,
            draftedTasks: classification.draft ? draftedTaskSummaries(classification.draft.fragmentYaml, proposal.id) : [],
          });
        } else if (classification.state === "drafting") {
          drafting.push({ proposalId: proposal.id, summary: proposal.summary, spawnedAt: classification.draftSpawnedAt ?? "" });
        } else if (classification.state === "declined") {
          declined.push({
            proposalId: proposal.id,
            summary: proposal.summary,
            reason: classification.declinedReason ?? "declined by an operator",
          });
        } else if (classification.state === "not_ready") {
          // W1-T2604 (finding (i)): the failing predicate(s) classifyProposal already named,
          // never a bare "not_ready" — see InboxNotReadyItem's own doc.
          notReady.push({ proposalId: proposal.id, summary: proposal.summary, reasons: classification.reasons });
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
      sendJson(res, 200, { ready, drafting, notReady, declined });
    },
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

/** Real {@link RatifyCliGateway}: shells out to the repo's own `bin/rmd`, matching a terminal
 *  invocation exactly. stdout/stderr are appended to a per-call log under `<logDir>`, since no
 *  operator terminal is watching this run — a failing spawn still leaves a trace. */
export function ratifyCliGateway(repoRoot: string, logDir: string): RatifyCliGateway {
  const rmdBin = join(repoRoot, "bin", "rmd");
  const spawnDetached = (args: string[], label: string) => {
    mkdirSync(logDir, { recursive: true });
    const logFd = openSync(join(logDir, `${label}-${Date.now()}.log`), "a");
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
    handler: jsonAction(validateDeclineProposal, (input, req, res) => {
      const { proposals, classifications } = classifyAllProposals(deps);
      if (!proposals.some((p) => p.id === input.proposalId)) {
        sendJson(res, 404, { error: "not_found", detail: `no active proposal "${input.proposalId}"` });
        return;
      }
      const classification = classifications.find((c) => c.proposalId === input.proposalId);
      if (classification?.state === "ratified") {
        sendJson(res, 409, {
          error: "already_ratified",
          detail: `${input.proposalId} is already RATIFIED — declining now cannot un-file the task it already produced`,
        });
        return;
      }
      if (classification?.state === "declined") {
        sendJson(res, 409, {
          error: "already_declined",
          detail: `${input.proposalId} was already declined (${classification.declinedReason ?? "no reason recorded"})`,
        });
        return;
      }
      const origin = bearerTokenId(req);
      appendPanelLedger(deps.ledgerPath, "panel.proposal_declined", input.proposalId, origin, { reason: input.reason });
      sendJson(res, 200, { ok: true, proposalId: input.proposalId, declined: true });
    }),
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
    handler: jsonAction(validateDeclineProposal, (input, req, res) => {
      const { proposals, classifications } = classifyAllProposals(deps);
      if (!proposals.some((p) => p.id === input.proposalId)) {
        sendJson(res, 404, { error: "not_found", detail: `no active proposal "${input.proposalId}"` });
        return;
      }
      const classification = classifications.find((c) => c.proposalId === input.proposalId);
      if (classification?.state === "ratified") {
        sendJson(res, 409, {
          error: "already_ratified",
          detail: `${input.proposalId} is already RATIFIED — restoring it cannot un-file the task it already produced`,
        });
        return;
      }
      if (classification?.state !== "declined") {
        sendJson(res, 409, {
          error: "not_declined",
          detail: `${input.proposalId} is not declined (state: ${classification?.state ?? "unknown"}) — there is nothing to restore`,
        });
        return;
      }
      const origin = bearerTokenId(req);
      appendPanelLedger(deps.ledgerPath, "panel.proposal_restored", input.proposalId, origin, { reason: input.reason });
      sendJson(res, 200, { ok: true, proposalId: input.proposalId, restored: true });
    }),
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

/** Every panel graph route, for a caller registering the full set at once (`rmd serve` wiring). */
export function buildPanelGraphRoutes(deps: PanelGraphDeps): Route[] {
  return [
    buildFeedbackInboxRoute(deps),
    buildSubmitFeedbackRoute(deps),
    buildPreviewFeedbackRoute(deps),
    buildTraceRoute(deps),
    buildProposalDecisionRoute(deps),
    buildDrainPreviewRoute(deps),
    buildPlanViewRoute(deps),
    buildInboxRoute(deps),
    buildApproveProposalRoute(deps),
    buildReframeProposalRoute(deps),
    buildDeclineProposalRoute(deps),
    buildRestoreProposalRoute(deps),
    buildSetDailyCostCeilingRoute(deps),
    buildClearDailyCostCeilingRoute(deps),
  ];
}
