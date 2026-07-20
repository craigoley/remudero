/**
 * lib/panel-actions.ts — the control panel's human-in-the-loop WRITE actions (W3-T5,
 * MASTER-PLAN §7 "editing capability tiers" — human-in-the-loop actions).
 *
 * §7: "answer questions (QUESTION contract), approve MANUAL queue items, Pause/Resume
 * (drain-and-hold)/STOP, quiet-hours toggle — writes go through the api-client's write
 * scope, ledgered with the panel's bearer." This module is that write-scope business
 * logic, built the SAME way lib/board.ts built the read side (W3-T2): a thin Route layer
 * over EXISTING mechanism (lib/service.ts's Route, lib/fleet-control.ts's flag files) plus
 * one new primitive this task actually owns — the `panel.*` ledger lines that make every
 * action attributable. Real `rmd serve` CLI wiring (registering these routes on a live
 * createService() instance) is later work, same split board.ts's header documents.
 *
 * ROUTING IS EXACT-MATCH ONLY (service.ts v0 — no path params), so every route below takes
 * its target (a task id, an issue URL) in the POST body rather than the URL path.
 *
 * WHO DID THIS (the origin field). §9/WS-9's acceptance bar is "ledger entries originating
 * from the client's bearer token." `ServiceTokens` (service.ts) is v0 — one shared write
 * token, not a per-panel-install identity — so there is no separate "user id" to log. The
 * bearer token itself IS the caller's proof of identity; what these handlers log as
 * `origin` is a SHA-256 id derived from it (`bearerTokenId` below), never the raw secret —
 * the ledger is an append-only, UI-rendered, tailed-by-SSE stream (lib/board.ts), so writing
 * a live credential into it would leak the credential to every reader. A hash is still a
 * stable per-token id: two calls with the same bearer produce the same `origin`, so a panel
 * (or a future second identified caller) is distinguishable across ledger lines without ever
 * being reversible back to the secret.
 *
 * FAIL LOUD ON BAD INPUT (Standing rule: validate before any write/spawn — the `rmd stop`
 * unknown-subcommand hazard in LEARNINGS.md). Every handler parses + validates the JSON body
 * BEFORE touching fleet-control's flag files, the GitHub issue gateway, or the ledger — a
 * malformed request performs NO side effect, ever, and gets a 400 with a specific reason.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { Route } from "./service.js";
import { appendLedger } from "./ledger.js";
import { requestPause, requestStop, resumeFleet, setQuietHours } from "./fleet-control.js";

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
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/**
 * A stable, non-reversible id for the bearer token that authenticated this request — see the
 * module header's "WHO DID THIS" note. Returns the literal `"unknown"` only if service.ts
 * somehow routed here with no Authorization header at all, which the scope check upstream
 * already rules out for a write-scoped route; kept as a fallback string rather than a throw so
 * a handler bug elsewhere never turns into a 500 on this line specifically.
 */
export function bearerTokenId(req: IncomingMessage): string {
  const header = req.headers.authorization;
  const token = header ? /^Bearer (.+)$/.exec(header)?.[1] : undefined;
  if (!token) return "unknown";
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

/** Read + JSON-parse a request body. Rejects (never throws synchronously) on a socket error or malformed JSON — callers turn a rejection into a 400. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
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

function isRecord(v: unknown): v is Record<string, unknown> {
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

/** Ledger one panel action. Every route below funnels through this so the shape is uniform: step name, the caller's `origin`, plus whatever fields that action names. */
function ledgerPanelAction(deps: PanelActionDeps, step: string, taskId: string, origin: string, extra: Record<string, unknown>): void {
  appendLedger(deps.ledgerPath, { run_id: `PANEL-${Date.now()}`, task_id: taskId, step, origin, ...extra });
}

/**
 * Wrap a route body: parse JSON, run `validate` (return an error string to FAIL LOUD with a
 * 400 before any side effect, or the validated input to proceed), then run `act`. Centralizes
 * the parse-validate-act-respond shape every handler below shares, so each route definition is
 * just its own validation + effect, not a rebuilt copy of this plumbing.
 */
function jsonAction<T extends object>(
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

// ── POST /v1/control/pause ──────────────────────────────────────────────────

/** POST /v1/control/pause — drain-and-hold, write-scoped. */
export function buildPauseRoute(deps: PanelActionDeps): Route {
  return {
    method: "POST",
    path: "/v1/control/pause",
    scope: "write",
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
    handler: async (req, res) => {
      const result = resumeFleet(deps.root);
      const origin = bearerTokenId(req);
      ledgerPanelAction(deps, "panel.resume_requested", PANEL_TASK_ID, origin, { ...result });
      sendJson(res, 200, result);
    },
  };
}

// ── POST /v1/control/stop ───────────────────────────────────────────────────

/**
 * POST /v1/control/stop — the hard kill, write-scoped. Ledgered BEFORE the acceptance bar
 * ("STOP from the panel halts the fleet within one tick") can even be checked by a caller —
 * `requestStop` writes the flag file synchronously, and the very next `drain.ts` tick (which
 * polls `stopDetail` first, before picking up any new task) observes it — see fleet-control.ts.
 */
export function buildStopRoute(deps: PanelActionDeps): Route {
  return {
    method: "POST",
    path: "/v1/control/stop",
    scope: "write",
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

/**
 * POST /v1/questions/answer — answer a QUESTION-contract entry (worker.ts's
 * `plan/questions.ndjson`), write-scoped. The ledger line IS the durable record a future
 * gateway consumes into sweep.ts's `pendingAnswer` (currently always undefined in the real
 * gateway — see sweep.ts's header note); this task ships the write action + its ledger
 * attribution, the same "mechanism now, consumer later" split every panel-facing route here
 * follows.
 */
export function buildAnswerQuestionRoute(deps: PanelActionDeps): Route {
  return {
    method: "POST",
    path: "/v1/questions/answer",
    scope: "write",
    handler: jsonAction(validateAnswerQuestion, (input, req, res) => {
      const origin = bearerTokenId(req);
      ledgerPanelAction(deps, "panel.question_answered", input.taskId, origin, { answer: input.answer });
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

/**
 * POST /v1/manual/approve — check off a MANUAL-queue item, write-scoped. §4: "the MANUAL queue
 * doubles as the human's to-do list — rendered in the control panel with check-off (= closing
 * the issue)"; closing the `escalation-manual`-labeled GitHub issue (escalate.ts) IS the
 * check-off. Closes the issue FIRST, then ledgers — a close that throws (bad URL, `gh`
 * failure) never produces a false "approved" ledger line.
 */
export function buildApproveManualRoute(deps: PanelActionDeps): Route {
  return {
    method: "POST",
    path: "/v1/manual/approve",
    scope: "write",
    handler: jsonAction(validateApproveManual, (input, req, res) => {
      deps.issues.close(input.issueUrl);
      const origin = bearerTokenId(req);
      ledgerPanelAction(deps, "panel.manual_approved", input.taskId, origin, { issue_url: input.issueUrl });
      sendJson(res, 200, { ok: true, taskId: input.taskId, issueUrl: input.issueUrl });
    }),
  };
}

/** Every panel write route, for a caller registering the full set at once (`rmd serve` wiring, later work). */
export function buildPanelActionRoutes(deps: PanelActionDeps): Route[] {
  return [
    buildPauseRoute(deps),
    buildResumeRoute(deps),
    buildStopRoute(deps),
    buildQuietHoursRoute(deps),
    buildAnswerQuestionRoute(deps),
    buildApproveManualRoute(deps),
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
