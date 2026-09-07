/**
 * lib/panel-actions.ts — the control panel's human-in-the-loop write actions (MASTER-PLAN §7,
 * "editing capability tiers": answer questions, approve MANUAL items, pause/resume/stop, the
 * quiet-hours toggle). A thin Route layer over existing mechanism — service.ts's Route,
 * fleet-control.ts's flag files, worker.ts's questions store — plus one primitive this file owns:
 * the `panel.*` ledger lines that make every write attributable. Routing is exact-match only
 * (service.ts v0, no path params), so every route takes its target in the POST body.
 * SECURITY INVARIANT — every write is scoped and attributed: each route declares its api-client
 * write tier (low/middle/high, MASTER-PLAN §7), and `origin` on every ledger line is
 * `bearerTokenId`, a SHA-256 hash of the bearer token, never the raw secret, since the ledger is
 * rendered to every panel viewer. Every handler validates its body before any write/spawn.
 * `rmd serve` CLI wiring is separate work.
 * Why: the design rationale for each choice above and route-by-route history —
 * docs/forensics/panel-actions.md
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  consumeOptionLink,
  escalationLinkUsedPath,
  verifyOptionLink,
  type OptionLinkClaims,
} from "./escalate.js";
import type { Route } from "./service.js";
import { appendLedger, RISK_OVERRIDE_RECORDED_STEP, RISK_OVERRIDE_REASON_CLASSES, RISK_OVERRIDE_DISPOSITIONS, type RiskOverrideReasonClass, type RiskOverrideDisposition } from "./ledger.js";
import type { RiskJudgeVerdictLabel } from "./risk-judge.js";
import { isPaused, isQuietHours, isStopped, isSafeTaskId, pauseDetail, requestDrainNow, requestKick, requestPause, requestStop, resumeFleet, setQuietHours, stopDetail } from "./fleet-control.js";
import { appendQuestionAnswer } from "./worker.js";
import { hashToken } from "./last-seen.js";
import { readLedgerLines, DEFAULT_LIVENESS_BOUND_MS, type LedgerReader } from "./status.js";
import { deriveLastPoll } from "./daemon-health.js";
import { deriveThreadId, readThread, appendThreadMessage, type ThreadIdentity } from "./inbox-thread.js";
import { captureFeedback } from "./feedback.js";
import { applyOperatorMergeHold, type OperatorMergeHoldAction } from "./operator-merge-hold.js";
import {
  interpretReply,
  formatClarifyingQuestion,
  formatExhaustionReport,
  type InterpretReplyDeps,
} from "./reply-interpreter.js";

/** Non-task-scoped panel actions (pause/resume/stop/quiet-hours) ledger under this sentinel — mirrors run-task.ts's drainCommand, which ledgers its own fleet-wide lines as `task_id: "DRAIN"`. */
export const PANEL_TASK_ID = "PANEL";

/** Close a MANUAL-queue GitHub issue — the "check-off" MASTER-PLAN §4 describes. Behind an interface, like escalate.ts's `IssueGateway`, so tests never touch the network. */
export interface IssueCloser {
  close(issueUrl: string): void;
}

export interface PanelActionDeps {
  root: string;
  ledgerPath: string;
  issues: IssueCloser;
  /** Path to the JSONL thread store {@link buildEscalationReplyRoute} reads/appends. Optional so
   *  every route predating this task keeps compiling; unset means that route refuses every reply
   *  loud rather than filing one unattached. Why: docs/forensics/panel-actions.md#panelactiondeps--threadstorepath-and-interpretreplydeps */
  threadStorePath?: string;
  /** Rules {@link buildEscalationReplyRoute} hands `interpretReply` to decide whether a reply is
   *  understood; unset runs its default, always "understood", so unconfigured behavior is unchanged. */
  interpretReplyDeps?: InterpretReplyDeps;
}

/** Shared with lib/panel-graph.ts (W3-T6, the plan->task->PR graph + feedback/decision routes) -- one JSON-envelope writer for every panel route, never a second copy. */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** A stable, non-reversible id for the bearer token that authenticated this request — SHA-256
 *  via `hashToken`, never the raw secret, since `origin` lines are rendered to every panel
 *  viewer. `"unknown"` only if service.ts routed here with no Authorization header, which a
 *  write-scoped route's own scope check already rules out. Why: docs/forensics/panel-actions.md#bearertokenid */
export function bearerTokenId(req: IncomingMessage): string {
  const header = req.headers.authorization;
  const token = header ? /^Bearer (.+)$/.exec(header)?.[1] : undefined;
  if (!token) return "unknown";
  return hashToken(token);
}

/** Read + JSON-parse a request body. Rejects (never throws synchronously) on a socket error or malformed JSON — callers turn a rejection into a 400. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  // W1-T500: a HIGH-tier nonce check may already have drained this stream (service.ts's
  // RAW_BODY_CACHE) — reading it again would hang forever, so a cached body is read from there.
  // Why: docs/forensics/panel-actions.md#readjsonbody
  const cached = (req as unknown as Record<symbol, unknown>)[Symbol.for("remudero.service.rawBody")];
  if (typeof cached === "string") {
    const trimmed = cached.trim();
    if (!trimmed) return Promise.resolve({});
    try {
      return Promise.resolve(JSON.parse(trimmed));
    } catch {
      return Promise.reject(new Error("body is not valid JSON"));
    }
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** Shared with lib/panel-graph.ts -- every panel route's body-validation entry point. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** An optional human-readable `reason` field — shared shape/validation between pause and stop (both are "an operator-provided reason, or none"). */
interface OptionalReasonInput {
  reason?: string;
}

function validateOptionalReason(body: unknown): { error: string } | OptionalReasonInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (body.reason !== undefined && typeof body.reason !== "string") return { error: "reason must be a string" };
  return { reason: body.reason as string | undefined };
}

/** Ledger one panel action, keyed by `ledgerPath` alone (not the full `PanelActionDeps`) so
 *  panel-graph.ts's routes, which have no `issues` gateway, can ledger through the same
 *  primitive rather than re-deriving the `run_id` shape a second time. */
export function appendPanelLedger(ledgerPath: string, step: string, taskId: string, origin: string, extra: Record<string, unknown> = {}): void {
  appendLedger(ledgerPath, { run_id: `PANEL-${Date.now()}`, task_id: taskId, step, origin, ...extra });
}

/** Ledger one panel action. Every route below funnels through this so the shape is uniform: step name, the caller's `origin`, plus whatever fields that action names. */
function ledgerPanelAction(deps: PanelActionDeps, step: string, taskId: string, origin: string, extra: Record<string, unknown>): void {
  appendPanelLedger(deps.ledgerPath, step, taskId, origin, extra);
}

/** Wrap a route body: parse JSON, run `validate` (an error string fails loud with a 400 before
 *  any side effect; otherwise the validated input), then run `act`. Every handler below shares
 *  this parse-validate-act-respond shape, including panel-graph.ts's routes, rather than each
 *  rebuilding its own copy. */
export function jsonAction<T extends object>(
  validate: (body: unknown) => { error: string } | T,
  act: (input: T, req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { error: "invalid_request", detail: (e as Error).message });
      return;
    }
    const validated = validate(body);
    if ("error" in validated) {
      sendJson(res, 400, { error: "invalid_request", detail: validated.error });
      return;
    }
    await act(validated, req, res);
  };
}

// ── GET /v1/control/status ──────────────────────────────────────────────────

/** GET /v1/control/status's body — the current fleet-control tri-state plus a daemon-liveness verdict. */
export interface FleetControlStatus {
  paused: boolean;
  pauseDetail?: string;
  stopped: boolean;
  stopDetail?: string;
  quietHours: boolean;
  /** CONTROL INVARIANT — whether a recent `daemon.*` heartbeat falls inside the liveness bound
   *  (status.ts's `DEFAULT_LIVENESS_BOUND_MS`). `paused`/`stopped`/`quietHours` above are a claim;
   *  this is evidence, so a crashed daemon reads distinct from a running one. Omitted, never a
   *  fabricated `false`, when not observed — `daemonLiveReason` always names why.
   *  Falsifier: test/daemon-liveness-taxonomy.test.ts.
   *  Why: docs/forensics/panel-actions.md#fleetcontrolstatusdaemonlive-and-daemonlivenessreason */
  daemonLive?: boolean;
  /** The evidence behind `daemonLive`, always present, so a reader never infers the branch. See {@link DaemonLivenessReason}. */
  daemonLiveReason: DaemonLivenessReason;
}

/**
 * {@link FleetControlStatus.daemonLive}'s evidence taxonomy — a stale poll is evidence the
 * daemon is down, while an absent or unreadable ledger is evidence of nothing, so each gets its
 * own reason rather than collapsing to one "not live" state.
 *  - `fresh-poll` → live TRUE: a `daemon.*` line inside the liveness bound.
 *  - `last-poll-stale` → live FALSE: a `daemon.*` line exists and aged past the bound.
 *  - `no-daemon-activity` → live FALSE: the ledger is non-empty but holds no `daemon.*` line —
 *    real evidence, since rotation retains recent lines per step (ledger.ts).
 *  - `ledger-empty` → live UNDEFINED: readable, no lines at all, a fresh install.
 *  - `ledger-absent` → live UNDEFINED: no file at `ledgerPath`.
 *  - `ledger-unreadable` → live UNDEFINED: the read threw (permissions, I/O).
 */
export type DaemonLivenessReason =
  | "fresh-poll"
  | "last-poll-stale"
  | "no-daemon-activity"
  | "ledger-empty"
  | "ledger-absent"
  | "ledger-unreadable";

/** {@link deriveDaemonLiveness}'s verdict: the answer AND the evidence, never one without the other. */
export interface DaemonLivenessVerdict {
  live?: boolean;
  reason: DaemonLivenessReason;
}

/** CONTROL INVARIANT — the liveness taxonomy as a pure function, falsifiable with no server.
 *  Presence is read defensively: only an explicit `present === false` reads as "absent", since
 *  the injectable `LedgerReader` seam returns `present: undefined`. `deriveLastPoll` is imported
 *  from daemon-health.ts, never reimplemented, so this route and GET /v1/daemon-health can never
 *  disagree about what counts as a heartbeat. Why: docs/forensics/panel-actions.md#derivedaemonliveness */
export function deriveDaemonLiveness(
  lines: ReadonlyArray<Record<string, unknown>>,
  nowMs: number,
  livenessBoundMs: number,
): DaemonLivenessVerdict {
  if ((lines as { present?: boolean }).present === false) return { reason: "ledger-absent" };
  const poll = deriveLastPoll(lines);
  if (poll.lastPollTs) {
    const ageMs = Math.max(0, nowMs - Date.parse(poll.lastPollTs));
    return ageMs <= livenessBoundMs ? { live: true, reason: "fresh-poll" } : { live: false, reason: "last-poll-stale" };
  }
  // No heartbeat: an empty ledger says nothing, a non-empty one with no daemon.* line is a real
  // negative (DaemonLivenessReason).
  return lines.length === 0 ? { reason: "ledger-empty" } : { live: false, reason: "no-daemon-activity" };
}

/** {@link buildControlStatusRoute}'s dependencies. */
export interface ControlStatusDeps extends Pick<PanelActionDeps, "root" | "ledgerPath"> {
  /** Ledger reader; defaults to reading + parsing NDJSON from disk. */
  readLedger?: LedgerReader;
  /** Clock; defaults to `Date.now`, injectable so a test can pin an exact liveness boundary. */
  now?: () => number;
  /** Defaults to {@link DEFAULT_LIVENESS_BOUND_MS}, reused so this surface and the task-row surface can never disagree. */
  livenessBoundMs?: number;
}

/** GET /v1/control/status — read-scoped. Derives Pause/Resume/STOP/quiet-hours button states
 *  from the actual fleet-control flag files, never stateless buttons. Also carries `daemonLive`,
 *  read once per request from the same heartbeat GET /v1/daemon-health computes. */
export function buildControlStatusRoute(deps: ControlStatusDeps): Route {
  return {
    method: "GET",
    path: "/v1/control/status",
    scope: "read",
    handler: (_req, res) => {
      const now = deps.now ?? Date.now;
      const readLedger = deps.readLedger ?? readLedgerLines;
      const livenessBoundMs = deps.livenessBoundMs ?? DEFAULT_LIVENESS_BOUND_MS;
      // A read that throws (permissions, I/O) is caught HERE, not inside readLedgerLines (which
      // has ~50 other call sites, some load-bearing) — a rendering-only degrade to `unknown`
      // rather than a 500 that blanks the whole panel.
      let verdict: DaemonLivenessVerdict;
      try {
        verdict = deriveDaemonLiveness(readLedger(deps.ledgerPath), now(), livenessBoundMs);
      } catch {
        verdict = { reason: "ledger-unreadable" };
      }
      const status: FleetControlStatus = {
        paused: isPaused(deps.root),
        pauseDetail: pauseDetail(deps.root),
        stopped: isStopped(deps.root),
        stopDetail: stopDetail(deps.root),
        quietHours: isQuietHours(deps.root),
        daemonLive: verdict.live,
        daemonLiveReason: verdict.reason,
      };
      sendJson(res, 200, status);
    },
  };
}

// ── POST /v1/control/pause ──────────────────────────────────────────────────

/** POST /v1/control/pause — drain-and-hold, write-scoped. */
export function buildPauseRoute(deps: PanelActionDeps): Route {
  return {
    method: "POST",
    path: "/v1/control/pause",
    scope: "write",
    // W1-T404: MIDDLE — reversible (resume clears it) but disruptive.
    tier: "middle",
    handler: jsonAction(validateOptionalReason, (input, req, res) => {
      const info = requestPause(deps.root, input.reason);
      const origin = bearerTokenId(req);
      ledgerPanelAction(deps, "panel.pause_requested", PANEL_TASK_ID, origin, { reason: info.reason ?? null });
      sendJson(res, 200, { paused: true, reason: info.reason ?? null });
    }),
  };
}

// ── POST /v1/control/resume ─────────────────────────────────────────────────

/** POST /v1/control/resume — clears BOTH STOP and PAUSE, write-scoped. No body required. */
export function buildResumeRoute(deps: PanelActionDeps): Route {
  return {
    method: "POST",
    path: "/v1/control/resume",
    scope: "write",
    // W1-T404: MIDDLE — reversible but disruptive (clears STOP + PAUSE).
    tier: "middle",
    handler: async (req, res) => {
      const result = resumeFleet(deps.root);
      const origin = bearerTokenId(req);
      ledgerPanelAction(deps, "panel.resume_requested", PANEL_TASK_ID, origin, { ...result });
      sendJson(res, 200, result);
    },
  };
}

// ── POST /v1/control/stop ───────────────────────────────────────────────────

/** POST /v1/control/stop — the hard kill, write-scoped. `requestStop` writes the flag file
 *  synchronously, so the next `drain.ts` tick observes it before picking up any new task. */
export function buildStopRoute(deps: PanelActionDeps): Route {
  return {
    method: "POST",
    path: "/v1/control/stop",
    scope: "write",
    // W1-T404: MIDDLE — reversible (resume clears it) but disruptive; the hard kill.
    tier: "middle",
    handler: jsonAction(validateOptionalReason, (input, req, res) => {
      const info = requestStop(deps.root, input.reason);
      const origin = bearerTokenId(req);
      ledgerPanelAction(deps, "panel.stop_requested", PANEL_TASK_ID, origin, { reason: info.reason ?? null });
      sendJson(res, 200, { stopped: true, reason: info.reason ?? null });
    }),
  };
}

// ── POST /v1/quiet-hours ─────────────────────────────────────────────────────

interface QuietHoursInput {
  enabled: boolean;
}

function validateQuietHours(body: unknown): { error: string } | QuietHoursInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (typeof body.enabled !== "boolean") return { error: "enabled must be a boolean" };
  return { enabled: body.enabled };
}

/** POST /v1/quiet-hours — toggle the quiet-hours flag, write-scoped. */
export function buildQuietHoursRoute(deps: PanelActionDeps): Route {
  return {
    method: "POST",
    path: "/v1/quiet-hours",
    scope: "write",
    // W1-T404: MIDDLE — reversible (toggled again) but a dispatch-throttling preference.
    tier: "middle",
    handler: jsonAction(validateQuietHours, (input, req, res) => {
      const enabled = setQuietHours(deps.root, input.enabled);
      const origin = bearerTokenId(req);
      ledgerPanelAction(deps, "panel.quiet_hours_toggled", PANEL_TASK_ID, origin, { enabled });
      sendJson(res, 200, { quietHours: enabled });
    }),
  };
}

// ── POST /v1/questions/answer ───────────────────────────────────────────────

interface AnswerQuestionInput {
  taskId: string;
  answer: string;
}

function validateAnswerQuestion(body: unknown): { error: string } | AnswerQuestionInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (typeof body.taskId !== "string" || !body.taskId.trim()) return { error: "taskId is required" };
  if (typeof body.answer !== "string" || !body.answer.trim()) return { error: "answer is required" };
  return { taskId: body.taskId, answer: body.answer };
}

/** POST /v1/questions/answer — write-scoped. Writes the answer to two durable places before the
 *  200: `plan/questions.ndjson` (the same store the QUESTION lands in, MASTER-PLAN §7) and the
 *  `panel.question_answered` ledger line retro.ts's Architect reads. The questions-store write
 *  is best-effort; ledgering still records the answer, so a degraded filesystem never drops it. */
export function buildAnswerQuestionRoute(deps: PanelActionDeps): Route {
  return {
    method: "POST",
    path: "/v1/questions/answer",
    scope: "write",
    // W1-T404: LOW — bookkeeping, trivially reversible (a recorded answer).
    tier: "low",
    handler: jsonAction(validateAnswerQuestion, (input, req, res) => {
      const origin = bearerTokenId(req);
      const ts = new Date().toISOString();
      const recordedToQuestionStore = appendQuestionAnswer(deps.root, { ts, task: input.taskId, answer: input.answer, origin });
      ledgerPanelAction(deps, "panel.question_answered", input.taskId, origin, {
        answer: input.answer,
        flows_to: "plan/questions.ndjson",
        recorded_to_question_store: recordedToQuestionStore,
      });
      sendJson(res, 200, { ok: true, taskId: input.taskId, answer: input.answer });
    }),
  };
}

// ── POST /v1/manual/approve ─────────────────────────────────────────────────

interface ApproveManualInput {
  taskId: string;
  issueUrl: string;
}

function validateApproveManual(body: unknown): { error: string } | ApproveManualInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (typeof body.taskId !== "string" || !body.taskId.trim()) return { error: "taskId is required" };
  if (typeof body.issueUrl !== "string" || !body.issueUrl.trim()) return { error: "issueUrl is required" };
  return { taskId: body.taskId, issueUrl: body.issueUrl };
}

/** POST /v1/manual/approve — check off a MANUAL-queue item, write-scoped. Closing the
 *  `escalation-manual`-labeled GitHub issue IS the check-off (MASTER-PLAN §4); the issue closes
 *  first, then ledgers, so a close that throws never produces a false "approved" line. */
export function buildApproveManualRoute(deps: PanelActionDeps): Route {
  return {
    method: "POST",
    path: "/v1/manual/approve",
    scope: "write",
    // W1-T404: HIGH — moves code (closes a MANUAL-queue issue, the check-off).
    tier: "high",
    handler: jsonAction(validateApproveManual, (input, req, res) => {
      deps.issues.close(input.issueUrl);
      const origin = bearerTokenId(req);
      ledgerPanelAction(deps, "panel.manual_approved", input.taskId, origin, { issue_url: input.issueUrl });
      sendJson(res, 200, { ok: true, taskId: input.taskId, issueUrl: input.issueUrl });
    }),
  };
}

// ── POST /v1/escalation/mark-handled ─────────────────────────────────────────

interface MarkEscalationHandledInput {
  taskId: string;
  issueUrl: string;
}

function validateMarkEscalationHandled(body: unknown): { error: string } | MarkEscalationHandledInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (typeof body.taskId !== "string" || !body.taskId.trim()) return { error: "taskId is required" };
  if (typeof body.issueUrl !== "string" || !body.issueUrl.trim()) return { error: "issueUrl is required" };
  return { taskId: body.taskId, issueUrl: body.issueUrl };
}

/** POST /v1/escalation/mark-handled (W1-T182) — the NEEDS ME affordance for an ESCALATION of any
 *  class, distinct from `/v1/manual/approve`'s check-off: closing the issue never resolves the
 *  underlying block, so this is named "mark handled", never "approve" or "resolve". A separate
 *  route, never a relabel, so `/v1/manual/approve`'s existing callers stay untouched. */
export function buildEscalationMarkHandledRoute(deps: PanelActionDeps): Route {
  return {
    method: "POST",
    path: "/v1/escalation/mark-handled",
    scope: "write",
    // W1-T404: LOW — bookkeeping, trivially reversible (closes an issue, resolves nothing itself).
    tier: "low",
    handler: jsonAction(validateMarkEscalationHandled, (input, req, res) => {
      deps.issues.close(input.issueUrl);
      const origin = bearerTokenId(req);
      ledgerPanelAction(deps, "panel.escalation_marked_handled", input.taskId, origin, { issue_url: input.issueUrl });
      sendJson(res, 200, { ok: true, taskId: input.taskId, issueUrl: input.issueUrl });
    }),
  };
}

// ── POST /v1/escalation/reply ────────────────────────────────────────────────

interface EscalationReplyInput {
  taskId: string;
  class: string;
  cause?: string;
  prRef?: string;
  text: string;
}

function validateEscalationReply(body: unknown): { error: string } | EscalationReplyInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (typeof body.taskId !== "string" || !body.taskId.trim()) return { error: "taskId is required" };
  if (typeof body.class !== "string" || !body.class.trim()) return { error: "class is required" };
  if (body.cause !== undefined && typeof body.cause !== "string") return { error: "cause must be a string" };
  if (body.prRef !== undefined && typeof body.prRef !== "string") return { error: "prRef must be a string" };
  if (typeof body.text !== "string" || !body.text.trim()) return { error: "text is required" };
  return {
    taskId: body.taskId,
    class: body.class,
    cause: body.cause as string | undefined,
    prRef: body.prRef as string | undefined,
    text: body.text,
  };
}

/** POST /v1/escalation/reply (W1-T2496) — a human answering an ESCALATION in prose. Derives the
 *  same {@link ThreadIdentity} escalate.ts keys this by; a thread with no prior message, or an
 *  unset `threadStorePath`, refuses (400) rather than filing unattached feedback.
 *  CONTROL INVARIANT — a reply is an input, never a command: only appends the thread, captures
 *  feedback and ledgers — never `deps.issues`, dispatch, or a ratify gateway.
 *  Falsifier: test/a-prose-reply-reaches-the-fleet-as-an-input.test.ts.
 *  Why: docs/forensics/panel-actions.md#buildescalationreplyroute */
export function buildEscalationReplyRoute(deps: PanelActionDeps): Route {
  return {
    method: "POST",
    path: "/v1/escalation/reply",
    scope: "write",
    // W1-T404: LOW — bookkeeping (files a feedback entry + a thread message); reversible, and
    // grants no new authority — see this route's own doc for the "input, never a command" line.
    tier: "low",
    handler: jsonAction(validateEscalationReply, (input, req, res) => {
      const identity: ThreadIdentity = { taskId: input.taskId, class: input.class, cause: input.cause, prRef: input.prRef };
      const threadId = deriveThreadId(identity);
      if (!deps.threadStorePath) {
        sendJson(res, 400, {
          error: "invalid_request",
          detail: `no thread store configured — thread "${threadId}" cannot be confirmed to exist`,
        });
        return;
      }
      const existing = readThread(threadId, { threadStorePath: deps.threadStorePath });
      if (existing.status === "unresolved") {
        sendJson(res, 400, {
          error: "invalid_request",
          detail: `thread "${threadId}" cannot be read (${existing.reason}) — refusing to file an unattached reply`,
        });
        return;
      }
      if (existing.messages.length === 0) {
        sendJson(res, 400, {
          error: "invalid_request",
          detail: `thread "${threadId}" names no existing escalation — refusing to file an unattached reply`,
        });
        return;
      }
      appendThreadMessage(identity, "reply", input.text, { threadStorePath: deps.threadStorePath });

      // Is this reply understood, or does it leave an ambiguity worth asking about?
      // `interpretReply` is pure — it never dispatches, ratifies, or arms a merge.
      const interpretation = interpretReply(
        { identity, threadId, replyText: input.text, priorMessages: existing.messages },
        deps.interpretReplyDeps,
      );
      const followUp =
        interpretation.status === "clarifying"
          ? formatClarifyingQuestion(interpretation.question)
          : interpretation.status === "exhausted"
            ? formatExhaustionReport(interpretation.unresolved)
            : undefined;
      if (followUp) {
        appendThreadMessage(identity, "escalation", followUp, { threadStorePath: deps.threadStorePath });
      }

      const entry = captureFeedback(deps.root, { raw: input.text, origin: "ui", threadId });
      const origin = bearerTokenId(req);
      ledgerPanelAction(deps, "panel.escalation_replied", input.taskId, origin, {
        thread_id: threadId,
        feedback_id: entry.id,
        interpretation: interpretation.status,
      });
      sendJson(res, 200, { ok: true, taskId: input.taskId, threadId, feedback: entry, interpretation });
    }),
  };
}

// ── recordRiskOverride — an operator's record of a risk-judge escalation override (W1-T2244) ──
// Before this existed, an operator's only trace was `panel.escalation_marked_handled` — no
// verdict, confidence, disposition or reason. This is the missing producer.
// CONTROL INVARIANT — records, never grants. Not a mounted `Route`, only the record primitive
// (writer, head-bound reader `riskOverrideFromLedger` in ledger.ts); nothing in this codebase may
// read the row to decide whether to dispatch or merge — the escalation still blocks regardless.
// Why: docs/forensics/panel-actions.md#recordriskoverride--section-header-riskoverriderecordinput-validateriskoverriderecord-and-the-function-doc

/** The operator-supplied half of a risk-override record: the escalation it answers, the judge's
 *  own verdict and confidence (copied verbatim off the `risk_judge.*` line, never re-derived),
 *  the operator's disposition, and a closed-set reason class plus optional free text. */
export interface RiskOverrideRecordInput {
  taskId: string;
  issueUrl: string;
  headSha: string;
  verdict: RiskJudgeVerdictLabel;
  confidence: number;
  disposition: RiskOverrideDisposition;
  reasonClass: RiskOverrideReasonClass;
  reason?: string;
}

function validateRiskOverrideRecord(body: unknown): { error: string } | RiskOverrideRecordInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (typeof body.taskId !== "string" || !body.taskId.trim()) return { error: "taskId is required" };
  if (typeof body.issueUrl !== "string" || !body.issueUrl.trim()) return { error: "issueUrl is required" };
  if (typeof body.headSha !== "string" || !body.headSha.trim()) return { error: "headSha is required" };
  if (body.verdict !== "low" && body.verdict !== "high") return { error: 'verdict must be one of "low", "high"' };
  if (typeof body.confidence !== "number" || !Number.isFinite(body.confidence) || body.confidence < 0 || body.confidence > 1) {
    return { error: "confidence must be a number between 0 and 1" };
  }
  if (typeof body.disposition !== "string" || !(RISK_OVERRIDE_DISPOSITIONS as readonly string[]).includes(body.disposition)) {
    return { error: `disposition must be one of ${RISK_OVERRIDE_DISPOSITIONS.join(", ")}` };
  }
  // Closed-set gate: an unrecognised reasonClass is refused here, before any write, never
  // coerced or accepted as free text alongside a guessed class.
  if (typeof body.reasonClass !== "string" || !(RISK_OVERRIDE_REASON_CLASSES as readonly string[]).includes(body.reasonClass)) {
    return { error: `reasonClass must be one of ${RISK_OVERRIDE_REASON_CLASSES.join(", ")}` };
  }
  if (body.reason !== undefined && typeof body.reason !== "string") return { error: "reason must be a string" };
  return {
    taskId: body.taskId,
    issueUrl: body.issueUrl,
    headSha: body.headSha,
    verdict: body.verdict as RiskJudgeVerdictLabel,
    confidence: body.confidence,
    disposition: body.disposition as RiskOverrideDisposition,
    reasonClass: body.reasonClass as RiskOverrideReasonClass,
    reason: body.reason as string | undefined,
  };
}

export type RiskOverrideRecordResult = { ok: true } | { ok: false; error: string };

/** Record how an operator handled a risk-judge escalation. Fails loud: a malformed input is
 *  refused and writes nothing, so a caller can tell "refused" from "recorded" without
 *  inspecting the ledger. */
export function recordRiskOverride(deps: PanelActionDeps, body: unknown, origin: string): RiskOverrideRecordResult {
  const validated = validateRiskOverrideRecord(body);
  if ("error" in validated) return { ok: false, error: validated.error };
  ledgerPanelAction(deps, RISK_OVERRIDE_RECORDED_STEP, validated.taskId, origin, {
    issue_url: validated.issueUrl,
    head_sha: validated.headSha,
    verdict: validated.verdict,
    confidence: validated.confidence,
    disposition: validated.disposition,
    reason_class: validated.reasonClass,
    ...(validated.reason !== undefined ? { reason: validated.reason } : {}),
  });
  return { ok: true };
}

// ── POST /v1/drain/feedback ─────────────────────────────────────────────────

/** The one-tap verdict a post-drain rundown line (W1-T141, drain.ts's `buildRundown`) takes — the label the learning limb (W1-T87 success-mining, W1-T88 contradiction-detection) reads. */
export const DRAIN_FEEDBACK_VERDICTS = ["good", "wrong", "needs-follow-up"] as const;
export type DrainFeedbackVerdict = (typeof DRAIN_FEEDBACK_VERDICTS)[number];

/** The steering note's ceiling — generous enough for real operator commentary (a sentence or
 *  three) while stopping one tap from swallowing the fix rung's whole prompt budget the way
 *  `boundedReason` (lib/board.ts) already bounds an escalation's refusal reason. */
const MAX_STEERING_NOTE_CHARS = 2000;

interface DrainFeedbackInput {
  taskId: string;
  verdict: DrainFeedbackVerdict;
  drainRunId: string;
  /** W1-T435: the steering note, quoted verbatim into the next fix-rung dispatch by
   *  `operatorVerdictEvidence` (sweep.ts) when `verdict` is `wrong`/`needs-follow-up`. A `good`
   *  verdict's note, if any, is still recorded but never quoted — praise never re-arms. */
  note?: string;
}

function validateDrainFeedback(body: unknown): { error: string } | DrainFeedbackInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (typeof body.taskId !== "string" || !body.taskId.trim()) return { error: "taskId is required" };
  if (typeof body.drainRunId !== "string" || !body.drainRunId.trim()) return { error: "drainRunId is required" };
  if (typeof body.verdict !== "string" || !(DRAIN_FEEDBACK_VERDICTS as readonly string[]).includes(body.verdict)) {
    return { error: `verdict must be one of ${DRAIN_FEEDBACK_VERDICTS.join(", ")}` };
  }
  if (body.note !== undefined && typeof body.note !== "string") return { error: "note must be a string" };
  if (typeof body.note === "string" && body.note.length > MAX_STEERING_NOTE_CHARS) {
    return { error: `note must be at most ${MAX_STEERING_NOTE_CHARS} characters` };
  }
  return {
    taskId: body.taskId,
    verdict: body.verdict as DrainFeedbackVerdict,
    drainRunId: body.drainRunId,
    note: body.note as string | undefined,
  };
}

/**
 * POST /v1/drain/feedback — the post-drain rundown's one-tap operator verdict (W1-T141),
 * write-scoped. Writes an `operator_feedback` ledger record via `appendPanelLedger`, the same
 * write path every panel action uses. `note` is ledgered verbatim, never truncated —
 * `MAX_STEERING_NOTE_CHARS` is a request-size refusal, not an in-flight edit. This is the
 * labeled human signal the learning limb (success-mining, contradiction-detection) consumes.
 */
export function buildDrainFeedbackRoute(deps: PanelActionDeps): Route {
  return {
    method: "POST",
    path: "/v1/drain/feedback",
    scope: "write",
    // W1-T404: LOW — bookkeeping, trivially reversible (a one-tap verdict + note).
    tier: "low",
    handler: jsonAction(validateDrainFeedback, (input, req, res) => {
      const origin = bearerTokenId(req);
      ledgerPanelAction(deps, "operator_feedback", input.taskId, origin, {
        verdict: input.verdict,
        drain_run_id: input.drainRunId,
        ...(input.note !== undefined ? { note: input.note } : {}),
      });
      sendJson(res, 200, { ok: true, taskId: input.taskId, verdict: input.verdict });
    }),
  };
}

// ── POST /v1/drain/kick + /v1/drain/run (console UP NEXT write-actions) ──────
// Both write a marker the daemon consumes at its next poll (never process management here).
// `assertRunnable` still gates on the daemon side — this endpoint only records intent.
// Why: docs/forensics/panel-actions.md#post-v1drainkick--v1drainrun--section-header

interface TaskIdInput {
  taskId: string;
}

function validateTaskId(body: unknown): { error: string } | TaskIdInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  if (typeof body.taskId !== "string" || body.taskId.trim() === "") return { error: "taskId must be a non-empty string" };
  // Fail loud on an id that could never be a safe marker filename — BEFORE any write.
  if (!isSafeTaskId(body.taskId)) return { error: "taskId is not a valid task id" };
  return { taskId: body.taskId };
}

/** POST /v1/drain/kick — the per-row "Run" button. Writes `KICK_REQUESTED-<taskId>`; the daemon
 *  dispatches that task by id through its normal `assertRunnable`-gated path at the next poll.
 *  Ledgers `console.kick_requested`; the dispatch/refusal outcome is the daemon's own line. */
export function buildKickRoute(deps: Pick<PanelActionDeps, "root" | "ledgerPath">): Route {
  return {
    method: "POST",
    path: "/v1/drain/kick",
    scope: "write",
    // W1-T404: HIGH — dispatches a task: real spend.
    tier: "high",
    handler: jsonAction(validateTaskId, (input, req, res) => {
      const origin = bearerTokenId(req);
      requestKick(deps.root, input.taskId, origin);
      appendPanelLedger(deps.ledgerPath, "console.kick_requested", input.taskId, origin, { armed: true });
      sendJson(res, 200, { armed: true, taskId: input.taskId });
    }),
  };
}

/** POST /v1/drain/run — the "Drain now" button. Writes `DRAIN_REQUESTED`; the daemon runs one
 *  dispatch cycle at its next poll. Ledgers `console.drain_requested`. No body required. */
export function buildDrainNowRoute(deps: Pick<PanelActionDeps, "root" | "ledgerPath">): Route {
  return {
    method: "POST",
    path: "/v1/drain/run",
    scope: "write",
    // W1-T404: HIGH — dispatches paid work, fleet-wide.
    tier: "high",
    handler: async (req, res) => {
      const origin = bearerTokenId(req);
      requestDrainNow(deps.root, origin);
      appendPanelLedger(deps.ledgerPath, "console.drain_requested", PANEL_TASK_ID, origin, { armed: true });
      sendJson(res, 200, { armed: true });
    },
  };
}

// ── POST /v1/merge-hold ─────────────────────────────────────────────────────

interface ConsoleMergeHoldInput {
  action: OperatorMergeHoldAction;
  reason: string;
  prNumber?: number;
  taskId?: string;
}

/** Strict route-body parser. Identity is deliberately absent: the authenticated bearer is the
 *  only source of `by`, so a payload can never spoof the operator recorded by the writer. */
function validateConsoleMergeHold(body: unknown): { error: string } | ConsoleMergeHoldInput {
  if (!isRecord(body)) return { error: "body must be a JSON object" };
  const allowed = new Set(["action", "reason", "prNumber", "taskId"]);
  const unknown = Object.keys(body).find((key) => !allowed.has(key));
  if (unknown) return { error: `unknown field ${JSON.stringify(unknown)}` };
  if (body.action !== "engage" && body.action !== "release") {
    return { error: "action must be `engage` or `release`" };
  }
  if (typeof body.reason !== "string" || !body.reason.trim()) {
    return { error: "reason must be a non-empty string" };
  }
  if (
    body.prNumber !== undefined &&
    (typeof body.prNumber !== "number" || !Number.isSafeInteger(body.prNumber) || body.prNumber <= 0)
  ) {
    return { error: "prNumber must be a positive integer" };
  }
  if (body.taskId !== undefined && (typeof body.taskId !== "string" || !/^W1-T\d+$/.test(body.taskId))) {
    return { error: "taskId must be a W1-T<n> id" };
  }
  if (body.taskId !== undefined && body.prNumber === undefined) {
    return { error: "taskId is valid only for a PR-scoped hold" };
  }
  return {
    action: body.action,
    reason: body.reason.trim(),
    ...(body.prNumber !== undefined ? { prNumber: body.prNumber } : {}),
    ...(body.taskId !== undefined ? { taskId: body.taskId } : {}),
  };
}

/** Apply or release the existing durable operator merge hold. HIGH tier means service.ts
 *  consumes a fresh exact-payload confirmation nonce before this handler can parse or write
 *  anything. Releasing only removes the refusal; this route never arms or performs a merge. */
export function buildMergeHoldRoute(deps: Pick<PanelActionDeps, "ledgerPath">): Route {
  return {
    method: "POST",
    path: "/v1/merge-hold",
    scope: "write",
    tier: "high",
    handler: jsonAction(validateConsoleMergeHold, (input, req, res) => {
      const by = bearerTokenId(req);
      if (by === "unknown") {
        sendJson(res, 403, { error: "bearer_provenance_required" });
        return;
      }
      const result = applyOperatorMergeHold(deps.ledgerPath, {
        ...input,
        by,
      });
      sendJson(res, 200, result);
    }),
  };
}

/** Every panel write route, for a caller registering the full set at once — a DECLARATION, never
 *  the production wiring: `rmd serve` mounts the singular builders one at a time since they don't
 *  all share deps, and mounting this list wholesale would silently re-root a route.
 *  Falsifier: test/route-registration.test.ts requires every declared route to answer on the
 *  real assembled server. Why: docs/forensics/panel-actions.md#buildpanelactionroutes */
export function buildPanelActionRoutes(deps: PanelActionDeps): Route[] {
  return [
    buildControlStatusRoute(deps),
    buildPauseRoute(deps),
    buildResumeRoute(deps),
    buildStopRoute(deps),
    buildQuietHoursRoute(deps),
    buildAnswerQuestionRoute(deps),
    buildApproveManualRoute(deps),
    buildEscalationMarkHandledRoute(deps),
    buildEscalationReplyRoute(deps),
    buildDrainFeedbackRoute(deps),
    buildKickRoute(deps),
    buildDrainNowRoute(deps),
    buildMergeHoldRoute(deps),
  ];
}

/** Real gateway: `gh issue close`, scoped by URL — mirrors escalate.ts's `ghIssueGateway`. Runs outside the sandbox (gh fails TLS verification under Seatbelt, §4A) but still inside bypass + the deny-hook floor. */
export function ghIssueCloser(): IssueCloser {
  return {
    close(issueUrl: string) {
      execFileSync("gh", ["issue", "close", issueUrl], { encoding: "utf8" });
    },
  };
}

// ── W1-T2696: answering an escalation from the ping ──────────────────────────
// Two routes, both selfAuthenticated: the phone carries no bearer token, so the link's signature
// IS the authority. The GET never consumes (an iMessage preview fetches it first) — only the
// POST claims the single-use marker.
// SECURITY INVARIANT: nothing executes before signature, expiry and single-use all pass, and
// each refusal is ledgered with which check failed. Falsifier: test/escalation-answer-links.test.ts.

/** What the answer routes need beyond {@link PanelActionDeps}: the state root the single-use
 *  markers live under, the signing secret, and the clock. */
export interface EscalationLinkDeps {
  readonly root: string;
  /** SECURITY INVARIANT — resolved lazily, on the first request, never at route assembly:
   *  resolving it eagerly would make standing up a server write a file. A throw here is a
   *  refusal, not a crash — the handler catches it and answers 503.
   *  Why: docs/forensics/panel-actions.md#escalationlinkdepssecret-and-consume */
  readonly secret: () => string;
  readonly now: () => number;
  /** How the single-use marker is claimed. Injectable, appended last so no positional caller
   *  shifts, so a test can drive the check-then-act window deterministically — the losing arm
   *  is otherwise reachable only by a real race between two taps. */
  readonly consume?: (root: string, signature: string) => boolean;
}

/** Resolve the signing secret, or answer 503 and report why. */
function resolveSecret(linkDeps: EscalationLinkDeps, res: ServerResponse): string | undefined {
  try {
    return linkDeps.secret();
  } catch (err) {
    sendJson(res, 503, { error: "unavailable", detail: `answer links are unavailable — ${String(err)}` });
    return undefined;
  }
}

function ledgerLinkOutcome(
  deps: PanelActionDeps,
  linkDeps: EscalationLinkDeps,
  step: string,
  escalationId: string,
  extra: Record<string, unknown>,
): void {
  appendLedger(deps.ledgerPath, { run_id: `LINK-${linkDeps.now()}`, task_id: escalationId, step, ...extra });
}

function queryOf(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? "/", "http://local").searchParams;
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

/** Escape for HTML text/attribute context — the confirm page renders operator-supplied ids. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** GET /v1/escalation/confirm — verify and show, never act. A refusal renders its reason so the
 *  operator learns whether the ping went stale, was already answered, or did not verify. */
export function buildEscalationLinkConfirmRoute(deps: PanelActionDeps, linkDeps: EscalationLinkDeps): Route {
  return {
    method: "GET",
    path: "/v1/escalation/confirm",
    scope: "read",
    selfAuthenticated: true,
    handler: (req, res) => {
      const query = queryOf(req);
      const secret = resolveSecret(linkDeps, res);
      if (secret === undefined) return;
      const check = verifyOptionLink(query, secret, linkDeps.now(), (sig) =>
        existsSync(escalationLinkUsedPath(linkDeps.root, sig)),
      );
      if (!check.ok) {
        // `bad-request` is NOT ledgered: these routes are unauthenticated, so recording every
        // malformed query would let anyone append to the ledger at will. The other three
        // refusals imply a real link existed, which is worth a row.
        if (check.reason !== "bad-request") {
          ledgerLinkOutcome(deps, linkDeps, "escalation.link_refused", query.get("e") ?? "unknown", {
            reason: check.reason,
            detail: check.detail,
            phase: "confirm",
          });
        }
        sendHtml(res, check.reason === "forged" ? 403 : 410, `<p>This link cannot be used: ${esc(check.detail)}</p>`);
        return;
      }
      sendHtml(
        res,
        200,
        `<form method="POST" action="/v1/escalation/answer?${esc(query.toString())}">` +
          `<p>Answer <b>${esc(check.claims.escalationId)}</b> with <b>${esc(check.claims.route)}</b>?</p>` +
          `<button type="submit">Confirm</button></form>`,
      );
    },
  };
}

/** POST /v1/escalation/answer — verify, claim the single-use marker, then execute.
 *  SECURITY INVARIANT — the marker is claimed before the option runs, so two taps racing cannot
 *  both execute: the loser's exclusive-create fails, refused `already-used`. An option that
 *  throws has still burned its link — better than a second automatic execution on retry. */
export function buildEscalationLinkAnswerRoute(deps: PanelActionDeps, linkDeps: EscalationLinkDeps): Route {
  return {
    method: "POST",
    path: "/v1/escalation/answer",
    scope: "write",
    tier: "low",
    selfAuthenticated: true,
    handler: (req, res) => {
      const query = queryOf(req);
      const secret = resolveSecret(linkDeps, res);
      if (secret === undefined) return;
      const check = verifyOptionLink(query, secret, linkDeps.now(), (sig) =>
        existsSync(escalationLinkUsedPath(linkDeps.root, sig)),
      );
      if (!check.ok) {
        // See the confirm route: a malformed query is an unauthenticated probe, never a row.
        if (check.reason !== "bad-request") {
          ledgerLinkOutcome(deps, linkDeps, "escalation.link_refused", query.get("e") ?? "unknown", {
            reason: check.reason,
            detail: check.detail,
          });
        }
        sendJson(res, check.reason === "forged" ? 403 : 410, { error: check.reason, detail: check.detail });
        return;
      }
      // Recorded as a REPLY on the escalation's own thread, never a direct call to the option's
      // route: a link captures a decision, it never itself runs a skill or halts the fleet.
      const identity: ThreadIdentity = { taskId: check.claims.escalationId, class: check.claims.cls };
      const threadId = deriveThreadId(identity);
      // Checked BEFORE the link is consumed: a refusal here is a wiring/store fault, not the
      // operator's doing, so burning their single-use link over it would cost their only answer.
      if (!deps.threadStorePath) {
        sendJson(res, 400, { error: "invalid_request", detail: `no thread store configured — thread "${threadId}" cannot be confirmed` });
        return;
      }
      const existing = readThread(threadId, { threadStorePath: deps.threadStorePath });
      if (existing.status === "unresolved" || existing.messages.length === 0) {
        const why = existing.status === "unresolved" ? existing.reason : "names no existing escalation";
        sendJson(res, 400, { error: "invalid_request", detail: `thread "${threadId}" ${why} — refusing to file an unattached answer` });
        return;
      }
      // Claimed BEFORE the append: two taps racing cannot both record — the loser's
      // exclusive-create fails and is refused.
      if (!(linkDeps.consume ?? consumeOptionLink)(linkDeps.root, check.signature)) {
        ledgerLinkOutcome(deps, linkDeps, "escalation.link_refused", check.claims.escalationId, {
          reason: "already-used",
          detail: "lost the race to claim the single-use marker",
        });
        sendJson(res, 410, { error: "already-used", detail: "this link has already answered its escalation" });
        return;
      }
      appendThreadMessage(identity, "reply", `answered by link: ${check.claims.route}`, {
        threadStorePath: deps.threadStorePath,
      });
      ledgerLinkOutcome(deps, linkDeps, "escalation.answered_by_link", check.claims.escalationId, {
        route: check.claims.route,
      });
      sendJson(res, 200, { ok: true, escalationId: check.claims.escalationId, route: check.claims.route });
    },
  };
}
