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
 * SIX ROUTES:
 *   - GET  /v1/feedback           — the inbox list (read-scoped).
 *   - POST /v1/feedback           — submit feedback, ALWAYS origin=ui (write-scoped). See
 *     `buildSubmitFeedbackRoute`'s doc comment for how this doubles as "answer a grill". Accepts
 *     an optional, re-validated `expansion` (W1-T350) — the four-section CLAIM/EVIDENCE/RECON/
 *     FALSIFYING CHECK skeleton the console read back from the preview route below and the
 *     operator confirmed — stored alongside `raw`, never in place of it.
 *   - POST /v1/feedback/preview   — expand a draft into that same four-section skeleton WITHOUT
 *     filing anything (write-scoped: a real cheap-mount model call). See
 *     `buildPreviewFeedbackRoute`'s doc comment for the fail-open contract.
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
  type Proposal,
} from "./inbox.js";

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
  /**
   * config.root — where `state/inbox-proposals.json` + `state/inbox-drafts.json` live
   * (W1-T110's ACTIVE-proposal registry + draft cache, `rmd inbox`'s own paths, run-task.ts's
   * `inboxCommand`). This is `config.root`, NOT `root` above (`root` is the REPO checkout
   * plan/feedback/ lives under) — the SAME config-vs-repo split lib/serve.ts's own header
   * documents for `fleetControlRoot`/`questionsRoot`; `rmd serve` wires this to the SAME
   * `fleetControlRoot` it already resolves as config.root.
   */
  inboxRoot: string;
  /**
   * W1-T193: the gateway POST /v1/inbox/approve and POST /v1/inbox/reframe hand off to —
   * see {@link RatifyCliGateway}'s own doc for why this is a detached CLI spawn rather than a
   * synchronous re-implementation of `rmd approve`'s git/gh side effects.
   */
  ratify: RatifyCliGateway;
  /**
   * Best-effort git-land the status flip POST /v1/feedback/decision just wrote, right after
   * `setFeedbackStatus` writes it (W1-T191, write site 2) — WITHOUT this, an operator's
   * accept/reject click leaves a tracked modification in `root`, the SAME checkout the daemon
   * runs from, which is exactly what makes `checkCliFreshness` refuse every non-exempt `rmd`
   * verb once that checkout also falls behind origin/main. Omitted (undefined, the default) in
   * a test that isn't exercising this — no git ever runs, so existing coverage of this route
   * is unaffected. Real callers (`rmd serve`) always pass `{}` so the real `landFeedback`
   * bridge fires with real git/gh.
   */
  feedbackLand?: LandFeedbackOpts;
  /**
   * W1-T350: the feedback-expansion rung POST /v1/feedback/preview calls — {@link
   * FeedbackExpanderDeps.expand} injected directly (not the whole deps object, so a test wires
   * a bare function like every other injected judge in this codebase). `undefined` (no
   * production caller wires a real one yet — see feedback.ts's `realFeedbackExpander` doc for
   * why) makes the preview route resolve `{ expansion: null }` unconditionally — the SAME
   * fail-open degrade an expander throw/invalid-response produces, so "unconfigured" and
   * "outage" read identically to the console.
   */
  expandFeedback?: FeedbackExpanderDeps["expand"];
  /**
   * W1-T364: injectable `Policy` for POST /v1/policy/daily-cost-ceiling(/clear) — the SAME
   * `deps.policy ??` seam `account-usage.ts`'s `AccountUsageDeps.policy` and run-task.ts's
   * `dailyCostCeilingReloader` already offer (test/config-reader-seams.test.ts's structural
   * lock), so a test supplies a fixture `Policy` (e.g. a tightened `sweep.dailyCostCeilingUsd`
   * bound) without touching the installed `plan/policy.yaml`. Defaults to
   * {@link import("./policy.js").loadDefaultPolicy} when omitted — the SAME memoized load
   * `buildAccountUsageRoute` defaults to, so the console's read and write surfaces never disagree
   * about the committed bound within one `rmd serve` process.
   */
  policy?: Policy;
}

// ── GET /v1/feedback — the inbox list ───────────────────────────────────────

/**
 * A reconciled {@link FeedbackEntry} as GET /v1/feedback returns it — `unverified` is a READ-TIME
 * decoration only (never written to `plan/feedback/<id>.yaml`), so the on-disk schema stays exactly
 * the §7B shape. `discharged`/`dischargeUndecidable` (W1-T1257) are `unverified`'s twin: sparse,
 * read-time-only flags — present only when true, absent (never `false`) otherwise — layered by
 * {@link decorateFeedbackDischarge} AFTER this reconcile, never in place of it. Both `unverified`
 * and a discharge flag can be true on the SAME entry at once (an unreadable proposal-merge state
 * says nothing about whether its filed tasks separately merged); neither ever changes `status`.
 */
export type ReconciledFeedbackEntry = FeedbackEntry & {
  unverified?: true;
  discharged?: true;
  dischargeUndecidable?: true;
};

/**
 * W1-T257: MERGING THE PROPOSAL PR IS THE DECISION. A `proposed` entry whose `proposal_pr` has
 * MERGED already got its operator decision the moment the gate landed it — a second manual
 * Accept adds nothing, so this reconciles it to the EXISTING terminal status `accepted` (never a
 * new enum member) rather than leaving it to render forever in NEEDS ME's Accept/Reject queue
 * (serve.ts's `renderNeedsMe`/`needsMeProposedHtml`, which key off `status === "proposed"` alone).
 *
 * Runs on every GET /v1/feedback read (the SAME read that feeds NEEDS ME), so it is idempotent
 * and self-healing for entries ALREADY stuck on disk — no separate sweep/backfill needed. Every
 * lookup goes through the injected, already-batched `statusGithub` (status.ts's `GitHub`, the SAME
 * gateway GET /v1/drain/preview's merged-set derivation uses) — one shared `gh pr list` fetch
 * backs every entry checked here, never a fetch per row.
 *
 * - No `proposal_pr` (null/unset) — never queried, entry passes through untouched (stays
 *   `proposed`, the acceptance falsifier: a live decision must never be swept off the board).
 * - `proposal_pr` resolves MERGED — persisted to `accepted` via `lib/feedback.ts`'s
 *   `setFeedbackStatus` (the sole writer), reflected in the returned copy.
 * - `proposal_pr` resolves OPEN or CLOSED (not merged) — stays `proposed` untouched; a
 *   CLOSED-unmerged proposal is a separate rejected/abandoned call, not this task's concern.
 * - `proposal_pr` resolves to nothing AND the read itself genuinely FAILED
 *   (`statusGithub.readFailed?.()`) — stays `proposed`, decorated `unverified: true` (fail-safe,
 *   inverse of W1-T182's merged-count direction: hiding a possibly-live decision is worse than
 *   showing a resolved one).
 */
export function reconcileFeedbackEntries(
  root: string,
  entries: FeedbackEntry[],
  statusGithub: GitHub,
  // W1-T191 SITE 3 (impl-EP). #966 wired the bridge at the DECISION route only; this reconcile path
  // was 208 lines above it in the same file and kept taking `setFeedbackStatus`'s raw-write branch
  // straight into the daemon's own checkout. It fires whenever a proposal PR merges, inside the
  // long-lived `rmd serve` process — which is how `plan/feedback/fb-…5ac4ca.yaml` came to sit
  // modified 63 seconds after PR #1058 merged, and how 107 deploys were aborted on a dirty tree.
  //
  // OPTIONAL, and absent means UNCHANGED. Every caller that passes a WORKTREE root
  // (`run-task.ts`'s triage lane, twice) legitimately wants the local write and must keep it, so the
  // option is passed at the site that needs it rather than flipped as a default.
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
 * W1-T1257: layer `discharged`/`dischargeUndecidable` onto every ALREADY-{@link
 * reconcileFeedbackEntries}'d entry — see lib/trace.ts's `feedbackDischargeState` for the
 * three-valued predicate this reads off (its own `not_discharged` arm needs no flag: absence
 * IS "not discharged", the same sparse-boolean shape `unverified` already uses). Reloads no PRs
 * of its own: `plan` is the SAME fresh-loaded snapshot this route already reads, and `statusGithub`
 * is the SAME batched gateway `reconcileFeedbackEntries`/`GET /v1/drain/preview` already share —
 * `findMergedByTrailer`/`findMergedByHeadBranch` resolve off that one fetch, never a second one.
 * A discharged entry's `status:` byte is untouched — this never calls `setFeedbackStatus`.
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
      // "never stale" (buildTraceRoute's own discipline): a task a proposal PR just filed must be
      // visible to the VERY NEXT read, so the plan is reloaded fresh on every request, never cached.
      // FAIL-SOFT, deliberately (buildShellRoute's own rule: "a read failure degrades to UNKNOWN,
      // never to zero"): an unreadable plan.tasks.yaml must not 500 the whole inbox read over a
      // decoration -- it just means no entry gets a discharge flag on this particular read.
      let decorated: ReconciledFeedbackEntry[] = reconciled;
      try {
        decorated = decorateFeedbackDischarge(reconciled, loadPlan(deps.planPath), deps.statusGithub);
      } catch {
        // plan unreadable this tick -- serve the reconciled list undecorated rather than fail the read.
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
}

/**
 * `attachments`, if present, must be http(s) LINKS only — never a local file path. A path typed
 * into a browser form field would resolve against the DAEMON's filesystem (lib/feedback.ts's
 * `resolveAttachments`), not the operator's own machine, which is confusing at best and a path-
 * disclosure/read hazard at worst for a network-facing route. FAIL LOUD before any capture.
 *
 * `expansion`, if present, is the four-section {@link FeedbackExpansion} the console read back
 * from POST /v1/feedback/preview and the operator CONFIRMED (W1-T350) — re-validated here
 * rather than trusted verbatim (the same "never trust a value read back off the wire" posture
 * every other body field on this route already gets), so a malformed/tampered expansion is
 * rejected loud rather than silently stored. Omitting it entirely is the file-raw escape (design
 * (iv)): the entry captures exactly as it did before this task.
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
  let expansion: FeedbackExpansion | null | undefined;
  if (body.expansion !== undefined && body.expansion !== null) {
    expansion = validateFeedbackExpansion(body.expansion);
    if (expansion === null) return { error: "expansion, when present, must be a valid four-section FeedbackExpansion" };
  } else if (body.expansion === null) {
    expansion = null;
  }
  return { text: body.text, attachments, replyTo: body.replyTo as string | undefined, expansion };
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
    // W1-T404: LOW — bookkeeping, trivially reversible (capture-only).
    tier: "low",
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
      const entry = captureFeedback(deps.root, { raw, attachments: input.attachments, origin: "ui", expansion: input.expansion });
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

/** Same `replyTo` shape POST /v1/feedback validates — a preview must be refused for exactly
 *  the same drafts a submission would refuse, so the console never arms a Confirm the write
 *  itself would then 400 on. No `attachments`/`expansion` here: a preview neither stores
 *  anything nor accepts one back. */
function validatePreviewFeedback(body: unknown): { error: string } | PreviewFeedbackInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (typeof body.text !== "string" || !body.text.trim()) return { error: "text is required" };
  if (body.replyTo !== undefined && (typeof body.replyTo !== "string" || !body.replyTo.trim())) {
    return { error: "replyTo must be a non-empty string when present" };
  }
  return { text: body.text, replyTo: body.replyTo as string | undefined };
}

/**
 * POST /v1/feedback/preview — write-scoped (a real cheap-mount model call, operator-initiated,
 * never a passive read): runs the feedback-expansion rung (feedback.ts's `expandFeedbackDraft`)
 * over the operator's DRAFT and returns the four-section {@link FeedbackExpansion} it produced.
 * FILES NOTHING — no `plan/feedback/<id>.yaml`, no ledger line, no status transition; this is
 * the PREVIEW SEAM the console's arm-then-confirm read-back shows before POST /v1/feedback ever
 * runs (this task's design (i)/(ii)).
 *
 * `replyTo`, when present, is validated the SAME way POST /v1/feedback validates it (must name a
 * real `grilling` entry) so a preview can never arm a Confirm that the eventual submission would
 * then reject.
 *
 * FAIL-OPEN, every direction: `deps.expandFeedback` left unset (no production caller wires a
 * real one yet), a rung that throws or times out, or a response {@link validateFeedbackExpansion}
 * rejects, all resolve `{ expansion: null }` with a 200 — NEVER a 5xx. The console's own
 * fallback on `expansion: null` is to file the plain submission unchanged (this task's stated
 * failure mode), and it can only do that if this route never errors on an expander outage.
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

// ── GET /v1/plan/view — progress (done/in-flight/queued) + frontier (W1-T315) ─────────────────
//
// PROGRESS is derived from projectPlan's SAME GitHub-derived projection GET /v1/drain/preview
// (just above) and GET /v1/status already use — a task whose yaml `status:` still says
// `queued` while its PR is merged counts as DONE here, never off that decorative field
// (W1-T280's own harvest: W1-T279 read `queued`/`attempts: 0` while PR #1062 had already
// merged). A gateway that could not be read (`github.readFailed()`) never renders a zero: the
// LAST successfully-observed reading rides forward from an in-memory cache, stamped UNKNOWN
// with the age it was last true (W1-T262's "unknown, never zero" rule) — resolved through the
// ONE `projectPlan()` call the route below makes for the whole plan, never a second per-task
// read (see `computePlanProgress`'s own doc for why it cannot become one, however it's called).
//
// FRONTIER binds drain.ts's OWN `runnableCandidates` (the exact selector the dispatcher itself
// calls) rather than re-deriving file-order/eligibility here — a board that computed its own
// order could disagree with the daemon, and a frontier that disagrees with what runs next is
// worse than none. Every row states a reason DERIVED from the same predicate that classified
// it (file-order head / a NAMED unmet dependency / the streak breaker's own reset condition) —
// never a hand-written blurb that can drift. A held task renders AS held, with its reason,
// rather than being silently omitted (design: "NOT-RUNNABLE IS INFORMATION, NOT ABSENCE").
//
// OUT OF SCOPE, OWNED ELSEWHERE (this task's own design): live run rows / daemon / deploy state
// (the Now tab, status-board.ts) and any write action on a frontier row (W1-T260's Run button)
// — this view only ever RENDERS, never dispatches.

/** Aggregate task counts for the workstream, derived from GitHub — never from the plan's own
 *  decorative `status:` field (see this section's header). */
export interface PlanProgress {
  /**
   * Present unless this is the FIRST-EVER reading and it happened to land during an outage
   * (nothing to fall back on yet) — sparse, the same "absent means unknown, never a fabricated
   * 0" convention every other darkness-fallback field in this codebase (status.ts's
   * `githubUnobservableSince`) already follows.
   */
  done?: number;
  inFlight?: number;
  queued?: number;
  total?: number;
  /**
   * True when THIS reading is a carried-forward last-known value because the GitHub gateway
   * could not be read this cycle — `unavailableReason` names why, `asOf` names when the
   * numbers were last actually true.
   */
  unknown: boolean;
  /**
   * ISO-8601 timestamp the counts are current as of — the fresh derivation time when `unknown`
   * is false, or the LAST successful derivation's own timestamp when `unknown` is true, so a
   * caller can render "last known Ns ago" rather than an age-less number.
   */
  asOf?: string;
  unavailableReason?: string;
}

/**
 * The single {@link PlanProgress} reading a caller last SUCCESSFULLY observed — a long-lived
 * server's in-memory snapshot, the aggregate-level counterpart to status.ts's
 * `DeriveDeps.previousProjection` (which carries the same "last known, under darkness" fact
 * per task). One instance per `rmd serve` process lifetime, created once by the route builder
 * and closed over by its handler — never persisted to disk: a process restart starting with no
 * last-known reading (falling back to `unknown` with no numbers at all) is the same fail-soft
 * direction every other in-memory-only cache in this codebase already takes (status.ts's
 * `DispatchBreakerCache`).
 */
export interface PlanProgressCache {
  last?: { done: number; inFlight: number; queued: number; total: number; asOf: string };
}

export function createPlanProgressCache(): PlanProgressCache {
  return {};
}

/**
 * Compute {@link PlanProgress} from an ALREADY-DERIVED projection (the caller's ONE
 * `projectPlan()` call — see this section's header) — this function itself makes NO GitHub
 * call beyond consulting `github.readFailed()`/`readFailureReason()`, so it cannot become a
 * second per-task fetch path however it is called, satisfying "the counts resolve through ONE
 * batched call rather than one per task" by construction rather than by convention.
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

/** Why a frontier row is where it is — the shapes acceptance names (file-order head / a named
 *  unmet dependency / a named blocker with breaker ETA) plus the one further NOT-RUNNABLE hold
 *  the design's own prose names (a `blocked` task) — never a hand-written catch-all beyond these
 *  four. `"verify-human"` remains a member of this type (nothing new to classify — {@link
 *  frontierFilterReason} already told them apart) but never reaches a {@link FrontierRow}:
 *  `verify:human` tasks are PERMANENTLY parked, not temporarily held, so they are excluded from
 *  the frontier entirely rather than rendered — see {@link buildPlanFrontier}'s own doc. */
export type FrontierReasonKind = "file-order" | "unmet-dependency" | "circuit-breaker" | "blocked" | "verify-human";

export interface FrontierRow {
  id: string;
  title: string;
  runnable: boolean;
  reasonKind: FrontierReasonKind;
  /** Machine-derived, built from the SAME fact that classified this row — never a hand-written
   *  blurb that can drift from it (see this section's header). */
  reason: string;
}

/**
 * Reason text for a task {@link runnableCandidates} declined via one of the four named {@link
 * DispatchFilterReason}s — `undefined` for `"already-merged"` AND for `"verify-not-auto"`, both
 * excluded from the frontier entirely by the caller. A DONE task is not part of "what's next" (it
 * is `PlanProgress.done`); a `verify:human` task is PERMANENTLY parked — it never becomes
 * runnable on its own, an operator must act on it directly, and it already renders under `need
 * you (verify != auto)` in the pinned header (idle-reasons-panel.ts) — so keeping it here too is
 * duplication with a worse label, and it is deliberately never routed through the needs-me/
 * escalation arc either (daemon.ts, auto-triage.ts exclude it from idle escalation for the same
 * reason: "permanently needs a human, waiting never helps"). `unmetDependencies` is re-consulted
 * here (a pure DAG walk, never a GitHub read) to NAME which id(s) — the same primitive
 * `isDispatchEligible` itself already called to produce this exact verdict, so this only
 * re-derives WHICH ids it would name, never the verdict itself.
 */
function frontierFilterReason(
  plan: Plan,
  task: Task,
  reason: DispatchFilterReason,
  isMerged: MergedSet,
): { kind: FrontierReasonKind; reason: string } | undefined {
  if (reason === "already-merged") return undefined;
  if (reason === "verify-not-auto") return undefined;
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
 * The next `limit` frontier rows in the SAME order the dispatcher would actually take them:
 * binds `runnableCandidates` (drain.ts) for BOTH the ordering and the eligibility verdict —
 * this function never re-derives either. A row that IS the next runnable candidate carries
 * `runnable: true` with a `"file-order"` reason naming its rank; a row `runnableCandidates`
 * declined for a TEMPORARY reason (`unmet-dependency`, `circuit-breaker`, `blocked`) is rendered
 * too (`runnable: false`), never omitted, with the reason the SAME eligibility chain actually
 * stopped it for (design: "NOT-RUNNABLE IS INFORMATION, NOT ABSENCE"). Two kinds are excluded
 * from the frontier's row budget entirely, never merely de-prioritised within it: DONE tasks
 * (`"already-merged"` — the frontier answers "what's next", not "what already landed", that's
 * `PlanProgress.done`) and PERMANENTLY-parked `verify:human` tasks (`"verify-not-auto"` — they
 * never become runnable on their own, and already render, with a better label, under `need you
 * (verify != auto)` in the pinned header; see {@link frontierFilterReason}). A task neither
 * eligible nor named by one of the remaining filter reasons (e.g. in-flight under an open PR, or
 * an indeterminate GitHub read) is Now-tab territory — live run/deploy state is explicitly out of
 * THIS view's scope (this section's header) — and is skipped here, never guessed at.
 */
export function buildPlanFrontier(
  plan: Plan,
  isMerged: MergedSet,
  limit: number,
  ledgerLines: ReadonlyArray<Record<string, unknown>>,
  maxDispatches: number = DEFAULT_MAX_TASK_DISPATCHES,
): FrontierRow[] {
  const heldReasons = new Map<string, { kind: FrontierReasonKind; reason: string }>();
  const isCircuitTripped = (id: string) => isDispatchBreakerTripped(ledgerLines, id, maxDispatches);
  // A LARGE limit (never the caller's `limit`): this ONE `runnableCandidates` call must
  // classify EVERY non-merged task so the dispatchOrder walk below can find each one's verdict,
  // however many held rows sit ahead of the runnable ones the caller asked to see — ordering
  // and eligibility are never re-derived a second time for the truncated view.
  const eligible = runnableCandidates(plan, isMerged, plan.tasks.length, {
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
// plan_refs IS POLYMORPHIC (design (i)): a task's plan_refs entries are one of FIVE kinds --
// section refs (`§5C`), a second section spelling (`MASTER-PLAN#5C`), task-id refs pointing at
// ANOTHER task (`W1-T325`), retro proposals (`P22`), and workstreams (`WS-7`). Only the two
// section-shaped kinds carry a heading to resolve; the other three must contribute NOTHING to a
// section's counts, or a task-id ref would fabricate a section that does not exist.
//
// plan.ts's `Task` type does NOT carry `plan_refs` (it is declarative, architect-only provenance
// metadata -- see plan.ts's own header on `origin`/`rationale`), and this task's own `files:`
// scope does not include plan.ts, so `readPlanRefs` below re-parses the SAME already-local
// tasks.yaml + tasks.d/*.yaml files {@link loadPlan} just read, pulling ONLY `id` and
// `plan_refs` -- never a new GitHub call, never a plan.ts schema change.

/** `id -> plan_refs` for every task in `planPath` (tasks.yaml + its `tasks.d/*.yaml` shards, the
 *  SAME files {@link loadPlan} reads) -- a narrow, best-effort SECOND parse of local files just
 *  for this one declarative field (see this section's header for why it cannot come from {@link
 *  Task} itself). A file that fails to read or parse is skipped, never thrown -- this is a
 *  rendering aid layered on top of the load-bearing validation {@link loadPlan} already did. */
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

/** Resolve a stripped section token ("5C", "7", "Self-improvement") to its plan-index.json
 *  heading (design (ii)). plan-index.json's headings carry the number as a TEXT PREFIX ("5C.
 *  Task pre-flight: the plan gate") with no `§` anywhere in the file, so the primary join
 *  matches the heading's own leading token -- everything before its FIRST `.` -- against the
 *  (already-stripped) ref token, EXACTLY, never a prefix match (a prefix match here would let
 *  token "5" wrongly match heading "5C. ..."). One ref is word-shaped ("§Self-improvement", no
 *  leading digit, so it has no leading-token-before-a-dot to match at all) -- the fallback is a
 *  case-insensitive heading-PREFIX match, tried only once the exact-token pass finds nothing. */
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

/** One MASTER-PLAN section's filed/merged breakdown -- rendered as a PAIR, never a percentage
 *  (design (iii): a percentage ranks a 1-task section above a 74-task one the moment its single
 *  task merges, inverting the truth). */
export interface PlanSectionCount {
  heading: string;
  filed: number;
  merged: number;
}

/** The last-computed {@link PlanSectionCount}s -- the per-section counterpart of {@link
 *  PlanProgressCache}, carried forward under the SAME darkness reading (design (v)): a caller
 *  passes {@link computePlanProgress}'s own `unknown` flag in rather than re-deriving it, so the
 *  sections never attempt a fresh read the whole-plan progress itself could not make. */
export interface PlanSectionCache {
  last?: PlanSectionCount[];
}

export function createPlanSectionCache(): PlanSectionCache {
  return {};
}

/**
 * Per-section filed/merged counts (W1-T376), derived from the SAME `projection` the caller
 * already resolved (never a second GitHub read) and gated by `progressUnknown` -- the SAME
 * darkness flag {@link computePlanProgress} just computed off the SAME projection, so a GitHub
 * outage renders the LAST-known section breakdown (or none, on a first-ever outage), never a
 * fabricated zero (design (v)). A task's "done" comes from `projection`, never from its own
 * decorative `status:` field (design (iv), the SAME rule {@link computePlanProgress} follows).
 * Falsifier (design (vi)): a task-id/`Pnn`/`WS-n` ref contributes to no section, and a task
 * resolving to two distinct sections increments BOTH.
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
 * GET /v1/plan/view[?frontier=<n>] — read-scoped. The Plan tab's one fetch: `progress`
 * (done/in-flight/queued, {@link computePlanProgress}), `sections` (per-section filed/merged
 * counts, {@link computePlanSectionCounts}, W1-T376), and `frontier` (the next candidates,
 * {@link buildPlanFrontier}) — off ONE fresh plan load and ONE `projectPlan()` call, exactly
 * like {@link buildDrainPreviewRoute} just above. `progressCache`/`sectionCache` are created
 * ONCE per route (this function's own closure), so they persist for the life of the `rmd serve`
 * process — never per-request, or every reading would look like a first-ever one.
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
      const frontier = buildPlanFrontier(plan, isMerged, limit, ledgerLines);
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

/** One task the drafted fragment would file — id + title, so a READY card shows what would
 *  ACTUALLY be filed rather than an opaque proposal id (W1-T193 design: "RENDER THE DRAFT'S
 *  SUBSTANCE, not just its existence" — the operator approves a KNOWN change, never a token). */
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

/** One proposal currently mid-draft (W1-T193): the daemon's draft rung (W1-T192,
 *  buildInboxDraftHook) has an Architect worker running for it RIGHT NOW. `spawnedAt` is the
 *  ISO timestamp it was spawned at — a card must never render nothing during this legitimately
 *  multi-minute window (indistinguishable from broken otherwise), the same bar W1-T156 set for
 *  liveness. */
export interface InboxDraftingItem {
  proposalId: string;
  summary: string;
  spawnedAt: string;
}

/** The drafted fragment's task ids + titles. A READY classification's fragment has ALREADY
 *  passed classifyProposal's own parse+lint checks (a fragment that failed either would have
 *  classified not_ready instead, never ready), so this re-parse is expected to always succeed
 *  — the catch is defense-in-depth (never assume two derivations of the same text agree
 *  forever), not an expected-failure path. Exported so that defense-in-depth branch is directly
 *  unit-testable — the READY path it guards against never exercises it in practice by design. */
export function draftedTaskSummaries(fragmentYaml: string, proposalId: string): InboxDraftedTask[] {
  try {
    return parseTasksFromYaml(fragmentYaml, `inbox draft ${proposalId}`).map((t) => ({ id: t.id, title: t.title }));
  } catch (e) {
    if (!(e instanceof PlanError)) throw e;
    return [];
  }
}

/**
 * Shared read + classify step every /v1/inbox* route needs (GET /v1/inbox classifies every
 * proposal to render the list; POST /v1/inbox/approve and /v1/inbox/reframe classify just the
 * one they're asked about, but need the SAME registry/draft-cache/ledger/in-flight facts to do
 * it correctly — e.g. the conflict predicate needs every OTHER open proposal id). Assembled in
 * ONE place so the write routes can never drift from what GET /v1/inbox just rendered.
 *
 * `loadPlanFn` defaults to {@link loadPlan} (the working-tree read, torn-read-guarded per
 * W1-T2220 remedy (a) — "usually not partial", the right cost for a render). The write-scoped,
 * tier-HIGH `POST /v1/inbox/approve` gate below passes {@link loadPlanAtRef} instead — remedy
 * (c), "cannot be partial" — since GET /v1/inbox and POST /v1/inbox/reframe never gate an
 * irreversible action on `classifications` the way approve does (design note (iv): splitting
 * the remedy by call site is the point, not a single mechanism for all three).
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
  // W1-T510: absence from `projection` cannot happen for any id `classifyProposal`'s own
  // `unmetOutsideDeps` can name here — `projectPlan` derives one entry per `plan.tasks` (see
  // its own loop, lib/status.ts), the EXACT SAME `plan` this `projection` and `ctx.plan` both
  // come from, so an id genuinely absent from the plan already fails via `unmetDependencies`'s
  // `!d` branch and never reaches `isMerged`/`depsUnobservable` at all. `?? false` here is
  // therefore never an absent-as-unmerged conflation — it is dead code on a present entry.
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
      draftSpawnedAt: (id) => inflight[id],
    }),
  );
  return { registryPath, proposals, classifications };
}

/**
 * GET /v1/inbox — read-scoped. The ratification inbox's (W1-T110, lib/inbox.ts) READY and
 * DRAFTING tiers — the same tiering `rmd inbox` prints, computed the SAME way
 * (classifyProposal, a pure function, over the ACTIVE-proposal registry + draft cache + a real
 * ReadinessContext), but over HTTP for the shell's NEEDS ME section. NOT-READY / DEFERRED-
 * WITH-TRIGGER proposals are deliberately never returned here (inbox.ts's whole point: only
 * what is genuinely actionable — or, since W1-T193, genuinely IN PROGRESS — is ever surfaced,
 * "the cure for approval fatigue").
 *
 * `rmd approve <id>` / `rmd reframe <id>` (W1-T111) are wired from the card as of W1-T193 — see
 * `buildApproveProposalRoute`/`buildReframeProposalRoute` below — over the SAME write-token
 * scope every other panel write action uses, never a second auth story.
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
        }
      }
      // W1-T190 (round 2): a proposal classified "ratified" here is DETECTED off the
      // ledger, never trusted from the registry's own (possibly drifted) copy — but
      // detection alone leaves the drifted row sitting in state/inbox-proposals.json
      // forever. Heal it on this read: prune every ledger-ratified proposal from the
      // registry file so any OTHER consumer of it (one that does not itself call
      // classifyProposal) sees the corrected state too, not just this request's in-memory
      // override. A no-op write when nothing needs healing (the common, already-clean
      // path never touches disk).
      //
      // W1-T240: this route runs inside the long-lived serve daemon, so its heal write is
      // one of FOUR independent read-modify-writers of this same file (the other three are
      // `rmd inbox`/`rmd approve`/`rmd reframe`, run-task.ts) racing it with no mutual
      // exclusion. Reapply the (already-derived, ledger-sourced) prunedIds set against a
      // FRESH read under lock — never blind-write the `proposals` array this handler read
      // at the top of the request, which a concurrent CLI writer could have changed by now
      // — see lib/inbox.ts's `updateProposalRegistry` doc for the lost-update/torn-file
      // hazard this guards against.
      const { prunedIds } = pruneRatifiedProposals(proposals, classifications);
      if (prunedIds.length > 0) {
        const prunedIdSet = new Set(prunedIds);
        updateProposalRegistry(registryPath, (current) => {
          const fresh = current.filter((p) => !prunedIdSet.has(p.id));
          return fresh.length === current.length ? null : fresh;
        });
      }
      sendJson(res, 200, { ready, drafting });
    },
  };
}

// ── POST /v1/inbox/approve, POST /v1/inbox/reframe — the operator's ratification bit, wired
// through the write-token API from the card (W1-T193, MASTER-PLAN P25 ii-iii) ───────────────

/**
 * The real side effects `rmd approve`/`rmd reframe` (run-task.ts's `approveCommand`/
 * `reframeCommand`) drive: git clone/worktree/branch/push, `gh pr create`, a poll for CI green,
 * the remudero-review judge, and arming auto-merge — a multi-minute pipeline. Blocking an HTTP
 * response on all of that risks a request that never returns, and this codebase has no
 * existing "detached background op" pattern to build a native re-implementation on. So this
 * gateway does exactly what an operator's own terminal would do: spawns the REAL `bin/rmd
 * approve <id>` / `bin/rmd reframe <id> --feedback <text>` CLI as a detached, unref'd child
 * process — never awaited — reusing 100% of the already-tested, gate-safe CLI flow with zero
 * duplicated logic. The HTTP response below confirms only that the run was HANDED OFF, not
 * that it completed; the resulting PR (once one exists) surfaces through the console's own
 * NOW/RECENT sections via their existing ledger-driven polling, same as any other in-flight
 * run — see this module's PR body for the fuller reversibility note.
 */
export interface RatifyCliGateway {
  approve(proposalId: string): void;
  reframe(proposalId: string, feedback: string): void;
}

/** Real {@link RatifyCliGateway}: shells out to the repo's OWN `bin/rmd`, matching exactly what
 *  `rmd approve <id>` / `rmd reframe <id> --feedback "<text>"` do from a terminal. stdout/
 *  stderr are appended to a per-call log file under `<logDir>` (there is no operator terminal
 *  watching this run) rather than discarded, so a spawn that fails loud still leaves a trace. */
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
 * POST /v1/inbox/approve — write-scoped. The console's APPROVE affordance: re-classifies the
 * named proposal LIVE (the SAME `classifyProposal` call GET /v1/inbox just rendered from —
 * never a cached/stale verdict) and REFUSES with 409 anything not currently READY, naming why
 * ({@link refusalReason}) — "no action is offered that the backend would refuse" (acceptance
 * 6) enforced server-side, not merely by the card only rendering the button for a READY item
 * (a race between the last poll and the operator's confirm click is otherwise possible). A
 * READY proposal hands off to {@link RatifyCliGateway.approve} — see that interface's doc for
 * why this is a detached CLI spawn, never a synchronous git/gh pipeline inside this handler.
 * Ledgers `panel.proposal_approve_requested` immediately (before the spawn even resolves), so
 * the operator's action is attributed the instant it is accepted, distinct from the spawned
 * run's OWN later `ratify.approved` ledger line.
 */
export function buildApproveProposalRoute(deps: PanelGraphDeps): Route {
  return {
    method: "POST",
    path: "/v1/inbox/approve",
    scope: "write",
    // W1-T404: HIGH — moves code (hands off to a detached rmd spawn: ratify/merge).
    tier: "high",
    handler: jsonAction(validateApproveProposal, (input, req, res) => {
      // W1-T2220: this gate is the ONE call site among classifyAllProposals's three consumers
      // that hands off to an irreversible detached spawn on `classifications`, so it alone reads
      // the plan via loadPlanAtRef (remedy (c), "cannot be partial") rather than loadPlan's
      // default stat/read/stat retry (remedy (a), "usually not partial") — see that function's
      // own doc and classifyAllProposals's.
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
 * POST /v1/inbox/reframe — write-scoped. The console's REFRAME affordance: captures the
 * operator's feedback VERBATIM (never summarized/trimmed beyond the empty-body check) and
 * hands off to {@link RatifyCliGateway.reframe}. Valid for ANY proposal currently in the
 * ACTIVE registry, WHATEVER its current classification — reframe is feedback, never a
 * ratification, and `rmd reframe` itself places no readiness precondition on it (inbox.ts's
 * own doc: "Valid for ANY proposal already in the registry, whatever its current
 * classification"). Ledgers `panel.proposal_reframe_requested` (carrying the feedback text)
 * immediately.
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

// ── POST /v1/policy/daily-cost-ceiling, POST /v1/policy/daily-cost-ceiling/clear ────────────
// W1-T364: THE OPERATOR'S OWN WRITE CONTROL over the daily-cost-ceiling override (W1-T332's
// store) — before this route existed, the ONLY writer of `state/DAILY_COST_CEILING_OVERRIDE`
// was the store's own unit test, so the value the operator most plausibly wants to move under
// pressure (it fired for the first time ever this week and stopped dispatch for ~40 minutes)
// still required a PR and a deploy, the exact thing OPERATOR RULING 2026-08-04 (policy.ts's own
// header) exists to end.
//
// GATED ON W1-T363 (now shipped, #1410, verified from source): `dailyCostCeilingReloader`
// (run-task.ts) resolves the EFFECTIVE ceiling through `resolveDailyCostCeiling` freshly on
// EVERY tick, never a cached/boot-time value, so a write through this route takes effect on the
// daemon's very next tick — no restart required. Landing this route before W1-T363 would have
// been a write surface over a value nothing enforced, the display-vs-enforcement lie this task's
// own design note names.
//
// ONE ROUTE, ONE CONTROL, THE STORE'S OWN VALIDATION (design note i): neither handler below
// duplicates `writeDailyCostCeilingOverride`'s bounds check — a `PolicyError` it throws maps
// straight to a 400 carrying its own message, never a second hand-rolled range check that could
// drift from the committed `policy.bounds["sweep.dailyCostCeilingUsd"]` row.
//
// `deps.root` (never `inboxRoot`) is the SAME `repoRoot` `dailyCostCeilingReloader` resolves
// `state/` against — the same root every other route in this module already reads/writes
// against, never a second, independently-resolved root for this one store.

interface SetDailyCostCeilingInput {
  usd: number;
}

function validateSetDailyCostCeiling(body: unknown): { error: string } | SetDailyCostCeilingInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (typeof body.usd !== "number") return { error: "usd must be a number" };
  return { usd: body.usd };
}

/**
 * Ledgers the who/from/to/effective audit trail for one console write to the daily-cost-ceiling
 * override (ledger.ts's `appendDailyCostCeilingOverrideAudit`, W1-T333's `console.
 * ceiling_override_written` step, the primitive that function's own doc names THIS route as the
 * intended caller of) — shared by the set and clear handlers below so the two routes can never
 * record it two different ways. `fromUsd` is the EFFECTIVE value immediately before this write
 * (never the raw override-file content), so a write that follows a fallback-from-malformed read
 * still records an accurate "from". `taskId: "_console"` matches the sentinel
 * test/ledger-render-retention.test.ts's own coverage of this primitive already uses; `who` is
 * the SAME `bearerTokenId` hash every other panel write route ledgers as `origin`.
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
 * POST /v1/policy/daily-cost-ceiling — write-scoped. Sets `state/DAILY_COST_CEILING_OVERRIDE` to
 * `{usd}` via the store's own writer (policy.ts's `writeDailyCostCeilingOverride`), which
 * validates against the committed row's bounds and refuses out-of-range at write time — this
 * route adds NO bounds check of its own (design note i above). Responds with the RESOLVED
 * effective ceiling (never the raw input echoed back), so a write the store could not honor is
 * never misreported as having taken hold.
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
    buildSetDailyCostCeilingRoute(deps),
    buildClearDailyCostCeilingRoute(deps),
  ];
}
