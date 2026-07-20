// GENERATED FILE -- DO NOT EDIT BY HAND.
// Source: openapi/daemon.yaml
// Regenerate: `npm run api-client:generate`. Verify (CI): `npm run api-client:check`.
// See scripts/generate-api-client.mjs and MASTER-PLAN §7A.

export interface components {
  schemas: {
    /** The JSON error envelope every non-2xx response on the surface returns (src/lib/service.ts's `sendJson` error paths). */
    Error: {
      /** `unauthorized` (401, no/unrecognized bearer token), `forbidden` (403, recognized token missing the required scope), `not_found` (404, no route registered for this method + path), `invalid_request` (400, a write route's JSON body failed validation -- W3-T5's panel-action routes fail loud BEFORE any side effect, src/lib/panel-actions.ts's `jsonAction`), or `internal_error` (500, the route handler threw). */
      error: "unauthorized" | "forbidden" | "not_found" | "invalid_request" | "internal_error";
      /** Present only on a 403 -- the scope the caller's token was missing. */
      required_scope?: "read" | "write";
    };
    /** One task's projected merge-state, derived from GitHub (src/lib/status.ts's `StatusProjection` -- never written back to plan/tasks.yaml). This is the per-task "live state" the read-only board (W3-T2) renders. */
    StatusProjection: {
      /** The plan task id (plan/tasks.yaml's `id`). */
      taskId: string;
      /** Derived status label in the plan's vocabulary (src/lib/plan.ts's TaskStatus). */
      status: "queued" | "recon" | "prompted" | "running" | "review" | "fixing" | "diagnosing" | "blocked" | "merged" | "done";
      /** The single fact dependency-gating cares about -- has this task landed? */
      merged: boolean;
      /** Which precedence source resolved this projection (or `none`). */
      source: "ledger" | "pr-field" | "trailer" | "correction" | "none";
      prNumber?: number;
      prUrl?: string;
      prState?: string;
      /** Trailer search hits rejected by the ownership/anchor asserts, each with a machine-readable reason. Present only when a candidate was actually rejected. */
      rejected_candidates?: ({
        pr: string;
        reason: string;
      })[];
    };
    /** GET /v1/status's body -- one StatusProjection per plan task, as of `generated_at`. */
    StatusSnapshot: {
      generated_at: string;
      tasks: (StatusProjection)[];
    };
    /** POST /v1/control/pause's body -- drain-and-hold, an optional human-readable reason. */
    PauseRequest: {
      reason?: string;
    };
    PauseResult: {
      paused: boolean;
      reason?: string | null;
    };
    /** POST /v1/control/resume's body -- clears BOTH STOP and PAUSE; reports what it cleared. */
    ResumeResult: {
      clearedStop: boolean;
      clearedPause: boolean;
    };
    /** POST /v1/control/stop's body -- the hard kill, an optional human-readable reason. */
    StopRequest: {
      reason?: string;
    };
    StopResult: {
      stopped: boolean;
      reason?: string | null;
    };
    /** POST /v1/quiet-hours's body -- the toggle's target state. */
    QuietHoursRequest: {
      enabled: boolean;
    };
    QuietHoursResult: {
      quietHours: boolean;
    };
    /** POST /v1/questions/answer's body -- an operator's answer to a QUESTION-contract entry (worker.ts's plan/questions.ndjson), addressed by the task it was raised on (v0 routing has no path params, src/lib/service.ts). */
    AnswerQuestionRequest: {
      taskId: string;
      answer: string;
    };
    AnswerQuestionResult: {
      ok: boolean;
      taskId: string;
      answer: string;
    };
    /** POST /v1/manual/approve's body -- check off a MANUAL-queue item (MASTER-PLAN §4): closes the named `escalation-manual`-labeled GitHub issue (src/lib/escalate.ts). */
    ApproveManualRequest: {
      taskId: string;
      issueUrl: string;
    };
    ApproveManualResult: {
      ok: boolean;
      taskId: string;
      issueUrl: string;
    };
  };
  securitySchemes: {
    /** Read-scoped bearer token. Grants GET access to read-scoped routes and SSE streams. A write-scoped token also satisfies this scope (write is a superset of read). */
    bearerRead: { type: "http"; scheme: "bearer" };
    /** Write-scoped bearer token. Required for any route whose `scope` is `write` (src/lib/service.ts's `Scope`). */
    bearerWrite: { type: "http"; scheme: "bearer" };
  };
}

export interface paths {
  "/v1/status": {
    get: {
      responses: {
          "200": StatusSnapshot;
          "401": Error;
          "403": Error;
          "404": Error;
        };
    };
  };
  "/v1/control/pause": {
    post: {
      responses: {
          "200": PauseResult;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
        };
    };
  };
  "/v1/control/resume": {
    post: {
      responses: {
          "200": ResumeResult;
          "401": Error;
          "403": Error;
          "404": Error;
        };
    };
  };
  "/v1/control/stop": {
    post: {
      responses: {
          "200": StopResult;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
        };
    };
  };
  "/v1/quiet-hours": {
    post: {
      responses: {
          "200": QuietHoursResult;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
        };
    };
  };
  "/v1/questions/answer": {
    post: {
      responses: {
          "200": AnswerQuestionResult;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
        };
    };
  };
  "/v1/manual/approve": {
    post: {
      responses: {
          "200": ApproveManualResult;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
        };
    };
  };
  "/v1/status/stream": {
    get: {
      responses: {
          "200": undefined;
          "401": Error;
          "403": Error;
          "404": Error;
        };
    };
  };
}

export interface operations {}
