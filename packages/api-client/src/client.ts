// packages/api-client/src/client.ts
//
// The FIRST runtime HTTP+SSE layer for @remudero/api-client (MASTER-PLAN §7A, W3-T2). Until
// now this package exported types only (schema.d.ts, GENERATED); this file is hand-written
// and never generated — see scripts/generate-api-client.mjs's header: "packages/api-client
// itself is EXCLUDED from the [no-hand-rolled-fetch] scan -- it is the ONE sanctioned place a
// future runtime HTTP layer for the generated client is allowed to live."
//
// W3-T2 v0 shipped the read-only board's ONE route pair: `getStatus()` (GET /v1/status) and
// `subscribeStatus()` (GET /v1/status/stream, SSE). W3-T5 (MASTER-PLAN §7, human-in-the-loop
// panel actions) adds the write side over the SAME client: `pauseFleet`/`resumeFleet`/
// `stopFleet`, `setQuietHours`, `answerQuestion`, `approveManualItem` — one typed method per
// write route src/lib/panel-actions.ts registers, calling `postJson` (this file's one write
// helper, mirroring `getStatus`'s GET). Every OTHER daemon route a later task adds gets its
// own typed method here, never a second ad-hoc fetch call in a consumer — this file is the
// ONLY place `fetch` may appear outside a test (enforced by scripts/no-hand-rolled-fetch-
// check.mjs, which excludes packages/api-client by name). A write method needs a WRITE-scoped
// `token` (service.ts's `Scope`) — passing a read-only token still compiles (the client has no
// scope type to check against) but the daemon answers 403, same as any other write caller.
//
// SSE via `fetch`, not `EventSource`: the browser's native EventSource cannot set an
// Authorization header, and this daemon's SSE routes are bearer-scoped exactly like its REST
// routes (src/lib/service.ts) — there is no unauthenticated query-param fallback. `fetch`
// with a streamed response body lets subscribeStatus send the SAME bearer header as
// getStatus and parse the `event:`/`data:` SSE framing (src/lib/service.ts's `openSse`) by
// hand over the byte stream.
//
// W3-T6 (MASTER-PLAN §7B) adds the plan→task→PR graph + interactive plan adjustment: the
// feedback inbox (`listFeedback`/`submitFeedback`), the provenance graph (`getTrace`, W1-T43),
// and the accept/reject bit (`decideProposal`) — one typed method per route
// src/lib/panel-graph.ts registers, over the SAME `getJson`/`postJson` helpers W3-T2/W3-T5
// already established.
import type { components } from "./schema.js";

export type StatusProjection = components["schemas"]["StatusProjection"];
export type StatusSnapshot = components["schemas"]["StatusSnapshot"];
export type PauseResult = components["schemas"]["PauseResult"];
export type ResumeResult = components["schemas"]["ResumeResult"];
export type StopResult = components["schemas"]["StopResult"];
export type QuietHoursResult = components["schemas"]["QuietHoursResult"];
export type AnswerQuestionResult = components["schemas"]["AnswerQuestionResult"];
export type ApproveManualResult = components["schemas"]["ApproveManualResult"];
export type FeedbackEntry = components["schemas"]["FeedbackEntry"];
export type FeedbackInboxResult = components["schemas"]["FeedbackInboxResult"];
export type SubmitFeedbackResult = components["schemas"]["SubmitFeedbackResult"];
export type TraceChain = components["schemas"]["TraceChain"];
export type TraceResult = components["schemas"]["TraceResult"];
export type ProposalDecisionResult = components["schemas"]["ProposalDecisionResult"];

export interface DaemonClientOptions {
  /** The daemon's base URL, e.g. `https://<tailnet-host>`. No trailing slash required. */
  baseUrl: string;
  /** Bearer token. A read-scoped token suffices for the read methods; the write methods (W3-T5) need a write-scoped token. */
  token: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface DaemonClient {
  /** GET /v1/status — the current board snapshot. */
  getStatus(): Promise<StatusSnapshot>;
  /**
   * GET /v1/status/stream — subscribe to live `status` events (one per task whose derived
   * StatusProjection changed). Returns an unsubscribe function that aborts the underlying
   * stream; safe to call more than once.
   */
  subscribeStatus(onEvent: (projection: StatusProjection) => void): () => void;
  /** POST /v1/control/pause — drain-and-hold (write-scoped, W3-T5). */
  pauseFleet(reason?: string): Promise<PauseResult>;
  /** POST /v1/control/resume — clears BOTH STOP and PAUSE (write-scoped, W3-T5). */
  resumeFleet(): Promise<ResumeResult>;
  /** POST /v1/control/stop — the hard kill (write-scoped, W3-T5). */
  stopFleet(reason?: string): Promise<StopResult>;
  /** POST /v1/quiet-hours — toggle the scheduler's quiet-hours preference (write-scoped, W3-T5). */
  setQuietHours(enabled: boolean): Promise<QuietHoursResult>;
  /** POST /v1/questions/answer — answer a QUESTION-contract entry (write-scoped, W3-T5). */
  answerQuestion(taskId: string, answer: string): Promise<AnswerQuestionResult>;
  /** POST /v1/manual/approve — check off a MANUAL-queue item (write-scoped, W3-T5). */
  approveManualItem(taskId: string, issueUrl: string): Promise<ApproveManualResult>;
  /** GET /v1/feedback[?status=] — the feedback inbox (read-scoped, W3-T6). */
  listFeedback(status?: FeedbackEntry["status"]): Promise<FeedbackInboxResult>;
  /**
   * POST /v1/feedback — submit feedback from the panel, ALWAYS captured with origin=ui
   * (write-scoped, W3-T6). `replyTo`, if given, must name an existing entry parked
   * `grilling` — this is "answer a grill" (see src/lib/panel-graph.ts's header for why).
   */
  submitFeedback(text: string, opts?: { attachments?: string[]; replyTo?: string }): Promise<SubmitFeedbackResult>;
  /** GET /v1/trace?id= — the plan→task→PR provenance graph for a task or feedback id (read-scoped, W3-T6, W1-T43). */
  getTrace(id: string): Promise<TraceResult>;
  /** POST /v1/feedback/decision — accept or reject a `proposed` feedback entry (write-scoped, W3-T6). */
  decideProposal(id: string, decision: "accept" | "reject"): Promise<ProposalDecisionResult>;
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** Parse one `event:`/`data:` SSE frame block (src/lib/service.ts's `openSse` framing). */
function parseSseFrame(frame: string): { event: string; data: string } | undefined {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
  }
  if (!event || dataLines.length === 0) return undefined;
  return { event, data: dataLines.join("\n") };
}

export function createDaemonClient(opts: DaemonClientOptions): DaemonClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");

  /**
   * The one write helper every W3-T5 method funnels through — POST `body` as JSON with the
   * SAME bearer header `getStatus` sends, and throw on a non-2xx (mirroring `getStatus`'s own
   * `!res.ok` check) rather than returning a daemon error envelope as if it were a result.
   * Best-effort surfaces the daemon's `error`/`detail` fields in the thrown message when the
   * body parses as JSON — never throws a SECOND time trying to build the first error.
   */
  async function postJson<T>(path: string, body: unknown): Promise<T> {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: { ...authHeaders(opts.token), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res
        .clone()
        .json()
        .then((b: unknown) => (b && typeof b === "object" ? JSON.stringify(b) : undefined))
        .catch(() => undefined);
      throw new Error(`${path}: daemon returned ${res.status}${detail ? ` — ${detail}` : ""}`);
    }
    return (await res.json()) as T;
  }

  /**
   * The GET-side counterpart to `postJson` — used by every W3-T6 read route (`listFeedback`,
   * `getTrace`) that isn't `getStatus`'s own hand-rolled fetch. Same non-2xx handling: throw
   * with the daemon's best-effort error detail rather than returning an error envelope as if
   * it were a result.
   */
  async function getJson<T>(path: string, query?: Record<string, string | undefined>): Promise<T> {
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const res = await fetchImpl(url.toString(), { headers: authHeaders(opts.token) });
    if (!res.ok) {
      const detail = await res
        .clone()
        .json()
        .then((b: unknown) => (b && typeof b === "object" ? JSON.stringify(b) : undefined))
        .catch(() => undefined);
      throw new Error(`${path}: daemon returned ${res.status}${detail ? ` — ${detail}` : ""}`);
    }
    return (await res.json()) as T;
  }

  return {
    async getStatus() {
      const res = await fetchImpl(`${baseUrl}/v1/status`, { headers: authHeaders(opts.token) });
      if (!res.ok) throw new Error(`getStatus: daemon returned ${res.status}`);
      return (await res.json()) as StatusSnapshot;
    },

    pauseFleet(reason) {
      return postJson<PauseResult>("/v1/control/pause", reason === undefined ? {} : { reason });
    },

    resumeFleet() {
      return postJson<ResumeResult>("/v1/control/resume", {});
    },

    stopFleet(reason) {
      return postJson<StopResult>("/v1/control/stop", reason === undefined ? {} : { reason });
    },

    setQuietHours(enabled) {
      return postJson<QuietHoursResult>("/v1/quiet-hours", { enabled });
    },

    answerQuestion(taskId, answer) {
      return postJson<AnswerQuestionResult>("/v1/questions/answer", { taskId, answer });
    },

    approveManualItem(taskId, issueUrl) {
      return postJson<ApproveManualResult>("/v1/manual/approve", { taskId, issueUrl });
    },

    listFeedback(status) {
      return getJson<FeedbackInboxResult>("/v1/feedback", { status });
    },

    submitFeedback(text, subOpts) {
      return postJson<SubmitFeedbackResult>("/v1/feedback", {
        text,
        ...(subOpts?.attachments !== undefined ? { attachments: subOpts.attachments } : {}),
        ...(subOpts?.replyTo !== undefined ? { replyTo: subOpts.replyTo } : {}),
      });
    },

    getTrace(id) {
      return getJson<TraceResult>("/v1/trace", { id });
    },

    decideProposal(id, decision) {
      return postJson<ProposalDecisionResult>("/v1/feedback/decision", { id, decision });
    },

    subscribeStatus(onEvent) {
      const controller = new AbortController();

      void (async () => {
        let res: Response;
        try {
          res = await fetchImpl(`${baseUrl}/v1/status/stream`, {
            headers: authHeaders(opts.token),
            signal: controller.signal,
          });
        } catch {
          return; // aborted before the connection opened -- nothing to read.
        }
        if (!res.ok || !res.body) return;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            buffer += decoder.decode(value, { stream: true });
            let sep: number;
            // SSE frames are separated by a blank line ("\n\n" -- src/lib/service.ts's `send`).
            while ((sep = buffer.indexOf("\n\n")) !== -1) {
              const frame = buffer.slice(0, sep);
              buffer = buffer.slice(sep + 2);
              const parsed = parseSseFrame(frame);
              if (parsed && parsed.event === "status") {
                onEvent(JSON.parse(parsed.data) as StatusProjection);
              }
            }
          }
        } catch {
          // Aborted (unsubscribe) or the connection dropped -- either way, stop reading.
        }
      })();

      return () => controller.abort();
    },
  };
}
