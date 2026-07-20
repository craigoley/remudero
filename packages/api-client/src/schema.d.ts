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
    /** One `plan/feedback/<id>.yaml` entry (src/lib/feedback.ts's `FeedbackEntry` -- the §7B schema shape: capture -> triage -> gate). */
    FeedbackEntry: {
      id: string;
      ts: string;
      raw: string;
      attachments: (string)[];
      origin: "cli" | "ui" | "issue";
      status: "new" | "grilling" | "proposed" | "accepted" | "rejected";
      /** Set once `rmd triage` opens a proposal PR for this entry; null until then. */
      proposal_pr: string | null;
    };
    /** GET /v1/feedback's body -- every captured feedback entry, oldest first. */
    FeedbackInboxResult: {
      entries: (FeedbackEntry)[];
    };
    /** POST /v1/feedback's body -- submit feedback from the panel (ALWAYS captured with origin: ui, never taken from this body). `replyTo`, if given, must name an existing entry parked `grilling` -- this is "answer a grill" v1 (src/lib/panel-graph.ts's header explains why): the answer is captured as a fresh feedback entry that re-enters triage, rather than a second, parallel answer-delivery primitive ahead of the still-unbuilt W1-T42 grill mechanics. */
    SubmitFeedbackRequest: {
      text: string;
      /** http(s) links ONLY -- a local file path would resolve against the daemon's own filesystem, not the operator's. */
      attachments?: (string)[];
      /** The `grilling` feedback id this submission answers, if any. */
      replyTo?: string;
    };
    SubmitFeedbackResult: {
      ok: boolean;
      entry: FeedbackEntry;
    };
    /** One run named on a task's ledger lines (src/lib/trace.ts's `TraceRun`). */
    TraceRun: {
      runId: string;
      verdict?: string;
      prUrl?: string;
      prState?: string;
      mergeSha?: string;
    };
    TraceTaskNode: {
      id: string;
      title: string;
      origin?: string;
      runs: (TraceRun)[];
    };
    TraceFeedbackNode: {
      id: string;
      raw: string;
      ts: string;
      origin: string;
      status: string;
      proposalPr?: string;
      proposalPrState?: string;
      proposalMergeSha?: string;
    };
    /** The plan->task->PR provenance chain the panel renders as a graph (src/lib/trace.ts's `TraceChain`, W1-T43): a feedback -> proposal PR -> task(s) -> run(s) -> PR(s) -> sha, entered either FORWARD (from a feedback id) or REVERSE (from a task id). */
    TraceChain: {
      direction: "forward" | "reverse";
      feedback?: TraceFeedbackNode;
      tasks: (TraceTaskNode)[];
    };
    /** GET /v1/trace's body -- the structured chain (for the graph render) plus the pre-rendered plain-text tree (`rmd trace`'s own output). */
    TraceResult: {
      chain: TraceChain;
      rendered: string;
    };
    /** POST /v1/feedback/decision's body -- accept or reject a `proposed` entry. */
    ProposalDecisionRequest: {
      id: string;
      decision: "accept" | "reject";
    };
    ProposalDecisionResult: {
      ok: boolean;
      id: string;
      status: string;
      proposalPr: string | null;
    };
    /** One `.remudero/skills/<name>.yaml` entry (lib/skill.ts's `Skill`) -- the panel button IS this registry entry (MASTER-PLAN §5B). `name` is the file's basename, never a `name:` field inside the body, so it can never drift from what `rmd skill list` reports it under. */
    SkillEntry: {
      /** The skill's identity -- its filename minus `.yaml`. */
      name: string;
      tools: (string)[];
      permission_profile: string;
      output_contract: string;
      grounding_sources: (string)[];
      gate: string;
      tier: string;
    };
    /** GET /v1/skills's body -- one SkillEntry per `.remudero/skills/<name>.yaml`, resolved fresh on every request (src/lib/panel-skills.ts). */
    SkillsListResult: {
      skills: (SkillEntry)[];
    };
    /** POST /v1/skills/run's body -- which registry skill to invoke, an optional mode, and (for `plan`/`clarify`, i.e. Refine) the plan task id it targets. */
    RunSkillRequest: {
      /** A name present in the `.remudero/skills/<name>.yaml` registry (validated against GET /v1/skills's own source). */
      skill: string;
      /** The skill mode, e.g. "clarify" for Refine (§5B: plan is ONE skill, THREE MODES). */
      mode?: string;
      /** The plan/tasks.yaml task id this invocation targets. Required for `plan`/`clarify` (Refine). */
      taskId?: string;
    };
    /** POST /v1/skills/run's body -- the invoked skill echoed back plus the grill it parked. Today always carries a `grilling` `feedback` entry: Refine is the only wired skill/mode, and Refine always grills (grounds via the real §5C linter, never proposes outright). */
    RunSkillResult: {
      ok: boolean;
      skill: string;
      mode?: string;
      taskId: string;
      feedback: FeedbackEntry;
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
  "/v1/feedback": {
    get: {
      responses: {
          "200": FeedbackInboxResult;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
        };
    };
    post: {
      responses: {
          "200": SubmitFeedbackResult;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
        };
    };
  };
  "/v1/trace": {
    get: {
      responses: {
          "200": TraceResult;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
        };
    };
  };
  "/v1/feedback/decision": {
    post: {
      responses: {
          "200": ProposalDecisionResult;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
        };
    };
  };
  "/v1/skills": {
    get: {
      responses: {
          "200": SkillsListResult;
          "401": Error;
          "403": Error;
          "404": Error;
        };
    };
  };
  "/v1/skills/run": {
    post: {
      responses: {
          "200": RunSkillResult;
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
