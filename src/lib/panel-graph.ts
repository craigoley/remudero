/**
 * lib/panel-graph.ts — the control panel's plan→task→PR graph + INTERACTIVE plan adjustment
 * (W3-T6, MASTER-PLAN §7B).
 *
 * §7B: "the panel renders the traceability graph (W1-T43) and becomes the interactive front
 * door: submit feedback (origin=ui), answer grills, accept or reject proposals... — all through
 * the api-client (§7A), the daemon still the sole writer." Built the SAME way lib/panel-actions.ts
 * (W3-T5) built the fleet-control write side: a thin Route layer over EXISTING mechanism —
 * lib/feedback.ts's inbox (capture/list/setFeedbackStatus) and lib/trace.ts's pure chain
 * builder/renderer (W1-T43, `rmd trace`) — plus the SAME `panel.*` ledger-attribution primitive
 * W3-T5 introduced (`appendPanelLedger`, exported from lib/panel-actions.ts so this module never
 * re-derives it). Real `rmd serve` CLI wiring (registering these routes on a live
 * createService() instance) is later work, same split every prior W3-T* panel task's header
 * documents.
 *
 * FIVE ROUTES:
 *   - GET  /v1/feedback           — the inbox list (read-scoped).
 *   - POST /v1/feedback           — submit feedback, ALWAYS origin=ui (write-scoped). See
 *     `buildSubmitFeedbackRoute`'s doc comment for how this doubles as "answer a grill".
 *   - GET  /v1/trace              — the plan→task→PR provenance graph for one id, task or
 *     feedback (read-scoped). Mirrors `rmd trace <id>`'s own two-entry-point resolution
 *     (run-task.ts's `traceCommand`) exactly, over the SAME lib/trace.ts primitives.
 *   - POST /v1/feedback/decision  — accept or reject a `proposed` entry (write-scoped).
 *   - GET  /v1/drain/preview      — the would-drain queue as ordered task cards (W1-T140,
 *     read-scoped). Reloads the plan fresh (same "never stale" discipline as `/v1/trace`),
 *     re-derives merged status from GitHub via the SAME `projectPlan`/`DeriveDeps` board.ts's
 *     `GET /v1/status` route already uses (zero new derivation logic), and renders
 *     `drain.ts`'s `buildDrainPreview` — the SAME builder `rmd drain --dry-run` will grow to
 *     share, never a second preview implementation.
 *
 * ANSWERING A GRILL (v1 scope). The actual interactive grill DELIVERY mechanism (AskUserQuestion
 * / a needs-human issue, reusing §4's escalation machinery) is explicitly OUT of this task's
 * depends_on — lib/triage.ts's own header says so: "the actual grill mechanics... are W1-T42's
 * job, not this task's." W1-T42 is not built yet, and a `grilling` feedback entry today persists
 * no queryable "open question" field for a client to render (the triage worker's question only
 * ever lands in a commit message, lib/triage.ts's `triageCommitMessage`). Rather than invent a
 * second, parallel answer-delivery primitive ahead of W1-T42 (a widened blast radius this task's
 * acceptance bar does not ask for — it tests feedback→proposal→PR and accept/reject, not grill
 * delivery), this module treats a grill ANSWER as what it already is per §7B's own framing:
 * "FEEDBACK IS AN ARTIFACT" — `POST /v1/feedback`'s optional `replyTo` field captures the
 * operator's answer as a FRESH feedback entry (still origin=ui), prefixed so its provenance back
 * to the parked entry is legible to the next triage pass, and re-enters the SAME capture → triage
 * pipeline every other feedback item does. `replyTo` is validated against a REAL `grilling`
 * entry (404/400 otherwise) so it can only ever be used to answer something actually parked.
 *
 * RE-PRIORITIZE (design doc, not acceptance bar). MASTER-PLAN §7B's design prose also names
 * "re-prioritize" as a future panel action. plan/tasks.yaml carries NO priority/ordering field
 * anywhere in the codebase today (lib/plan.ts's `Task` has none) — adding one is a plan-schema
 * change with its own blast radius (the linter, the drain's dispatch order, the task doc), not a
 * one-route add-on to this module. Out of scope here, same as this task's other explicitly-
 * deferred siblings (lib/triage.ts's grill mechanics, lib/board.ts's un-rendered design panels).
 */

import { loadPlan } from "./plan.js";
import { projectPlan, readLedgerLines, type GitHub } from "./status.js";
import { buildDrainPreview, type DrainOpts } from "./drain.js";
import {
  captureFeedback,
  FEEDBACK_STATUSES,
  listFeedback,
  readFeedbackEntry,
  setFeedbackStatus,
  type FeedbackEntry,
  type FeedbackStatus,
} from "./feedback.js";
import { renderTraceChain, traceForward, traceReverse, type TraceChain, type TraceGithub } from "./trace.js";
import type { Route } from "./service.js";
import { appendPanelLedger, bearerTokenId, isRecord, jsonAction, sendJson } from "./panel-actions.js";

export interface PanelGraphDeps {
  /** Repo root — where plan/feedback/ lives (lib/feedback.ts's `feedbackDir`). */
  root: string;
  /**
   * `plan/tasks.yaml`'s path. Unlike lib/board.ts's `BoardDeps` (a `Plan` snapshot the caller
   * refreshes on its own schedule), GET /v1/trace reloads this fresh on EVERY request — it must
   * see tasks a `rmd triage` proposal PR merges into plan/tasks.yaml after the daemon boots,
   * exactly like `rmd trace`'s own CLI path (run-task.ts's `traceCommand`) does with its own
   * `loadPlan` call.
   */
  planPath: string;
  ledgerPath: string;
  /** GitHub PR lookups the trace chain needs (lib/trace.ts's `TraceGithub`) — injected so tests never touch the network, same split every other `github`-shaped dep in this codebase follows. */
  github: TraceGithub;
  /**
   * The status-derivation GitHub gateway (status.ts's `GitHub`, DIFFERENT from
   * `github`/`TraceGithub` above — verified from source, not assumed: `projectPlan`'s
   * `DeriveDeps` needs `prByRef`/`findMergedByTrailer`/`headRefName`/`prBody`, a
   * distinct shape from `TraceGithub`'s single `prView`). Backs GET /v1/drain/preview's
   * merged-set derivation — the SAME projection board.ts's GET /v1/status already uses.
   */
  statusGithub: GitHub;
}

// ── GET /v1/feedback — the inbox list ───────────────────────────────────────

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
      const entries = listFeedback(deps.root, statusParam ? { status: statusParam as FeedbackStatus } : {});
      sendJson(res, 200, { entries });
    },
  };
}

// ── POST /v1/feedback — submit feedback (origin=ui), or answer a grill via `replyTo` ─────────

interface SubmitFeedbackInput {
  text: string;
  attachments: string[];
  replyTo?: string;
}

/**
 * `attachments`, if present, must be http(s) LINKS only — never a local file path. A path typed
 * into a browser form field would resolve against the DAEMON's filesystem (lib/feedback.ts's
 * `resolveAttachments`), not the operator's own machine, which is confusing at best and a path-
 * disclosure/read hazard at worst for a network-facing route. FAIL LOUD before any capture.
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
  return { text: body.text, attachments, replyTo: body.replyTo as string | undefined };
}

/**
 * POST /v1/feedback — write-scoped. Captures a new `plan/feedback/<id>.yaml` entry with
 * `origin: ui` ALWAYS (never taken from the request body — the panel is the one caller this
 * route serves, and the whole point of the acceptance bar is that a panel submission is
 * distinguishable from a `cli`/`issue` one). Ledgers `panel.feedback_submitted`.
 *
 * `replyTo`, when given, must name an existing entry parked `grilling` (404/400 otherwise) —
 * this is "answer a grill" v1 (see this module's header for why): the answer is captured as a
 * FRESH feedback entry, prefixed with a back-reference so the next triage pass can see what it's
 * answering, and re-enters the same capture → triage pipeline every other feedback item does.
 */
export function buildSubmitFeedbackRoute(deps: PanelGraphDeps): Route {
  return {
    method: "POST",
    path: "/v1/feedback",
    scope: "write",
    handler: jsonAction(validateSubmitFeedback, (input, req, res) => {
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
      const entry = captureFeedback(deps.root, { raw, attachments: input.attachments, origin: "ui" });
      const origin = bearerTokenId(req);
      appendPanelLedger(deps.ledgerPath, "panel.feedback_submitted", entry.id, origin, {
        origin_field: entry.origin,
        reply_to: input.replyTo ?? null,
      });
      sendJson(res, 200, { ok: true, entry });
    }),
  };
}

// ── GET /v1/trace — the plan→task→PR provenance graph ──────────────────────

/**
 * GET /v1/trace?id=<task-id-or-feedback-id> — read-scoped. Same two-entry-point resolution as
 * `rmd trace <id>` (run-task.ts's `traceCommand`, over the SAME lib/trace.ts primitives): a
 * known task id traces REVERSE (task back through its origin), anything else is looked up as a
 * feedback entry and traces FORWARD (feedback out to its proposal PR / tasks / runs / PRs);
 * neither resolving is a 404. Returns both the structured {@link TraceChain} (for the panel's
 * graph render) and the pre-rendered plain-text tree (`rendered`, the exact `rmd trace` output).
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
 * POST /v1/feedback/decision — write-scoped. Accept or reject a `proposed` entry
 * (`lib/feedback.ts`'s `setFeedbackStatus`) — the panel's ratify/reject bit over a proposal PR
 * lib/triage.ts already opened. Only a `proposed` entry can be decided (400 otherwise — FAIL
 * LOUD rather than silently allowing an arbitrary status jump the way the CLI-level
 * `setFeedbackStatus` primitive itself permits; THIS caller has a specific precondition).
 * Ledgers `panel.proposal_accepted`/`panel.proposal_rejected` with the panel's bearer as
 * `origin` — the acceptance bar's literal proof artifact ("paste the ledger line").
 */
export function buildProposalDecisionRoute(deps: PanelGraphDeps): Route {
  return {
    method: "POST",
    path: "/v1/feedback/decision",
    scope: "write",
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
      const updated = setFeedbackStatus(deps.root, input.id, status);
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
 * GET /v1/drain/preview[?max=<n>][&until=<id>] — read-scoped. The would-drain queue
 * (W1-T140 limb 1) as ordered task cards: reloads the plan fresh (same "never stale"
 * discipline {@link buildTraceRoute} follows), re-derives merged status from GitHub
 * via `projectPlan` (status.ts) — the SAME projection board.ts's `GET /v1/status`
 * already uses, no second derivation path — and renders `drain.ts`'s
 * `buildDrainPreview` in `plannedSequence` order.
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

/** Every panel graph route, for a caller registering the full set at once (`rmd serve` wiring). */
export function buildPanelGraphRoutes(deps: PanelGraphDeps): Route[] {
  return [
    buildFeedbackInboxRoute(deps),
    buildSubmitFeedbackRoute(deps),
    buildTraceRoute(deps),
    buildProposalDecisionRoute(deps),
    buildDrainPreviewRoute(deps),
  ];
}
