// GENERATED FILE -- DO NOT EDIT BY HAND.
// Source: openapi/daemon.yaml
// Regenerate: `npm run api-client:generate`. Verify (CI): `npm run api-client:check`.
// See scripts/generate-api-client.mjs and MASTER-PLAN §7A.

export interface components {
  schemas: {
    /** Bounded read-only answer-v1; missing evidence is explicit and citations are dated. */
    OperatorAgentAnswer: {
      version: "answer-v1";
      repository: string | null;
      instance: string;
      lens: "current-repository";
      coverage: "verified" | "partial" | "unavailable" | "unsupported";
      answer: string;
      generatedAt: string;
      citations: ({
        sourceId: string;
        observedAt: string;
        freshness: "verified" | "stale";
        label: string;
        value: string;
      })[];
      missingSources: ({
        sourceId: string;
        reason: string;
      })[];
    };
    InstanceUnavailable: {
      error: "instance_unavailable";
      status: "unavailable";
      instance: string;
      reason: string;
    };
    /** The JSON error envelope every non-2xx response on the surface returns (src/lib/service.ts's `sendJson` error paths). */
    Error: {
      /** `unauthorized` (401, no/unrecognized bearer token), `forbidden` (403, recognized token missing the required scope), `not_found` (404, no route registered for this method + path), `invalid_request` (400, a write route's JSON body failed validation -- W3-T5's panel-action routes fail loud BEFORE any side effect, src/lib/panel-actions.ts's `jsonAction`), or `internal_error` (500, the route handler threw). */
      error: "unauthorized" | "forbidden" | "not_found" | "invalid_request" | "internal_error";
      /** Present only on a 403 -- the scope the caller's token was missing. */
      required_scope?: "read" | "write";
      /** W1-T4609 -- a human-readable reason accompanying `invalid_request` (400) and a route-level `not_found` (404); the service-level 401/403/404/500 envelopes omit it. */
      detail?: string;
      /** W1-T404 -- present only on a 403 refused for an insufficient WRITE TIER by src/lib/service.ts's dispatch gate, which `enforceWriteTiers` turns on and `rmd serve`'s production wiring sets (W1-T500). `low` (bookkeeping), `middle` (reversible but disruptive, or a spend force multiplier) or `high` (spends money or moves code) -- the tier the caller's credential was missing, alongside `required_scope: write`. */
      required_tier?: "low" | "middle" | "high";
    };
    /** One task's projected merge-state, derived from GitHub (src/lib/status.ts's `StatusProjection` -- never written back to plan/tasks.yaml). This is the per-task "live state" the read-only board (W3-T2) renders. */
    StatusProjection: {
      /** The plan task id (plan/tasks.yaml's `id`). */
      taskId: string;
      /** Derived status label in the plan's vocabulary (src/lib/plan.ts's TaskStatus). */
      status: "queued" | "recon" | "prompted" | "running" | "review" | "fixing" | "diagnosing" | "blocked" | "merged" | "done";
      /** The single fact dependency-gating cares about -- has this task landed? */
      merged: boolean;
      /** Which precedence source resolved this projection (`none` if GitHub was read but had no evidence; `throttled` if GitHub could not be read at all). */
      source: "ledger" | "pr-field" | "trailer" | "correction" | "none" | "throttled";
      prNumber?: number;
      prUrl?: string;
      prState?: string;
      /** Trailer search hits rejected by the ownership/anchor asserts, each with a machine-readable reason. Present only when a candidate was actually rejected. */
      rejected_candidates?: ({
        pr: string;
        reason: string;
      })[];
      phase?: "recon" | "implement" | "review" | "fix-rung";
      startedAt?: string;
      elapsedMs?: number;
      workerState?: "working" | "tool-executing" | "quiet";
      workerStateSince?: string;
      /** Bounded worker observability. It names the active role/provider/model and the current or last tool, but never carries prompts, tool arguments, or tool output. */
      workerTelemetry?: {
        role?: "recon" | "implementer" | "reviewer" | "fixer" | "triage" | "retro" | "unknown";
        provider?: string;
        requestedModel?: string;
        servedModel?: string;
        currentTool?: string;
        currentToolReason?: string;
        currentToolStartedAt?: string;
        lastTool?: {
          name: string;
          durationMs: number;
          completedAt: string;
          outcome?: "success" | "error";
        };
        lastEventAt?: string;
        lastEventKind?: "working" | "tool-executing" | "message";
        firstSignalAt?: string;
        firstSignalLatencyMs?: number;
      };
    };
    /** GET /v1/status's body -- one StatusProjection per plan task, as of `generated_at`, plus (W1-T163, when the daemon's per-token last-seen marker store is wired) the calling token's own "since you last checked" recap. */
    StatusSnapshot: {
      generated_at: string;
      tasks: (StatusProjection)[];
      /** W1-T163: every recap-worthy event (src/lib/recap.ts) after this token's PRIOR marker -- absent entirely on a daemon with no last-seen store wired; `[]` on this token's first-ever view (nothing to recap FROM). */
      recap?: (RecapEvent)[];
      /** W1-T163: this token's marker value BEFORE this request advanced it -- the timestamp `recap` was computed as-of. Absent alongside `recap` for the same two reasons. */
      sinceCheckpoint?: string;
    };
    /** The health projection for one managed repository. The current daemon has no per-repo health source, so every measurement is explicitly unknown rather than rendered as zero or healthy. */
    RepoDashboardHealth: {
      status: "unknown";
      queuedtasks: number | null;
      errorrate: number | null;
      last_run: string | null;
      alerts: (string)[] | null;
    };
    /** Trailing seven-day per-repository worker telemetry from the ledger. Models are the distinct provider-reported served models, never requested or routed model assignments. A null modelsused means the ledger was unavailable or at least one worker row in the window did not report its served model; an empty array means no worker rows ran in the window. */
    RepoDashboardTelemetry: {
      tokens7d: number | null;
      modelsused: (string)[] | null;
      cost_7d: number | null;
    };
    /** Per-repository settings, unavailable until durable settings persistence exists. */
    RepoDashboardSettings: {
      proofpolicy: string | null;
      workerpoolsize: number | null;
      alertthreshold: number | null;
    };
    /** One repository from the validated `.remudero/managed-repos.json` set. Managed membership is not evidence of OAuth connection, activation, health, telemetry, or settings. */
    RepoDashboardEntry: {
      /** Canonical `owner/repo` identity from the managed-repo set. */
      id: string;
      /** Repository name from the canonical identity. */
      reponame: string;
      /** Deterministic GitHub URL for the canonical identity; no GitHub read is implied. */
      repourl: string;
      connected_at: string | null;
      active: boolean | null;
      managed: boolean;
      source: "managed-repos";
      health: RepoDashboardHealth;
      telemetry: RepoDashboardTelemetry;
      settings: RepoDashboardSettings;
    };
    /** GET /v1/repos's read-only managed-repo portfolio. An empty `repos` array is a measured empty managed set; it is not an unavailable response. */
    RepoDashboardResult: {
      generated_at: string;
      source: "managed-repos";
      repos: (RepoDashboardEntry)[];
    };
    /** GET /v1/registry's 503 body (src/lib/serve.ts's `buildRegistryRoute`): the repo registry could not be read, or src/lib/instance-registry.ts's `parseInstanceRegistry` refused it. Path-free on purpose -- an fs error embeds the absolute path, so only a code is echoed. A dedicated refusal rather than a member of the shared Error enum, which a consumer switches over exhaustively (packages/daemon-client-smoke). */
    RegistryUnavailable: {
      error: "registry_unavailable";
      /** `unreadable` when the file could not be read, else the parser's `InstanceRegistryErrorCode` (`no_instances_block`, `malformed_line`, `duplicate_instance`, ...). */
      reason: string;
    };
    /** W1-T4227 -- GET /v1/registry: the fleet as projects -> repos -> instances, read from the one registry (`.remudero/daemon-instances.yaml`, src/lib/instance-registry.ts). It carries names, repos and instance prefixes ONLY -- never a path, state dir, credential dir, image or token. `drift` is present only when the host's copy is readable and names a different instance set; `hostRegistry` says how that comparison went. */
    RegistryResult: {
      projects: (RegistryProject)[];
      source: "repo";
      generatedAt: string;
      hostRegistry: "in_sync" | "drifted" | "unreadable" | "malformed";
      drift?: RegistryDrift;
    };
    RegistryProject: {
      /** The project id; an instance that names none belongs to "default". */
      id: string;
      repos: (RegistryRepo)[];
    };
    RegistryRepo: {
      /** owner/name on GitHub. */
      repo: string;
      instances: (RegistryInstance)[];
    };
    RegistryInstance: {
      name: string;
      /** The `/v1/i/<name>` prefix the instance is reached under. */
      prefix: string;
    };
    RegistryDrift: {
      hostOnly: (string)[];
      repoOnly: (string)[];
    };
    /** W1-T163 -- one "since you last checked" row (src/lib/recap.ts): a single ledger event after the caller's per-token marker. */
    RecapEvent: {
      kind: "merged" | "blocked" | "escalated" | "question_answered" | "retro";
      /** The originating ledger line's `task_id` verbatim -- `RETRO` for a fleet-wide retro event. */
      taskId: string;
      ts: string;
      /** A short human-readable detail (verdict string, escalation class, answer text, retro stats). */
      detail?: string;
      /** The plan task's own title -- present only when `taskId` names a real plan task. */
      title?: string;
      /** A same-page `#task=<id>` hash link into the console's task card -- present ONLY when `taskId` names a real plan task (a fleet-wide event like `retro` has none). */
      taskCardLink?: string;
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
    /** A bounded operator request to run the established repair or review command against one pull request in this daemon instance. The request is recorded for the daemon's next poll; this HTTP route never starts a worker itself. The route is LOW tier (W1-T4077), so no confirmation nonce precedes this body. */
    PrActionRequest: {
      action: "fix" | "review";
      prNumber: number;
    };
    /** Durable receipt only. `armed: true` means the selected daemon instance recorded the request; it does not claim that a worker has started or that the pull request is fixed. */
    PrActionResult: {
      armed: boolean;
      action: "fix" | "review";
      prNumber: number;
      requestedAt: string;
    };
    /** POST /v1/pr-actions' 409 body (src/lib/panel-actions.ts's `buildPrActionRoute`): the operator switched this action off on this daemon -- the marker `state/CONSOLE_PR_ACTION_OFF-<action>` exists (src/lib/fleet-control.ts's `isPrActionSwitchedOff`). Nothing was recorded but the `console.pr_action_switched_off` ledger row. A dedicated refusal rather than a member of the shared Error enum, which a consumer switches over exhaustively (packages/daemon-client-smoke). */
    PrActionSwitchedOff: {
      error: "switched_off";
      /** Names the switched-off action and the marker file that switched it off. */
      detail: string;
    };
    /** POST /v1/escalation/mark-handled's body (W1-T182) -- the NEEDS ME affordance an ESCALATION row (any class: BLOCKED/MANUAL/HARD_STOP/GRILL) actually supports, distinct from ApproveManualRequest's MANUAL-queue check-off: "approve" has no defined verb for an escalation. Closes the named `needs-human`-labeled GitHub issue (src/lib/escalate.ts); the name is deliberately "mark handled", not "approve" or "resolve" -- closing the issue does not, by itself, imply the underlying block is fixed. */
    MarkEscalationHandledRequest: {
      taskId: string;
      issueUrl: string;
    };
    MarkEscalationHandledResult: {
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
      /** src/lib/feedback.ts's `FeedbackOrigin`: a human capture method, or one of the machine-origin shapes `isValidFeedbackOrigin` admits (`issue#<n>`, W1-T57; `alert#<source>-<id>`, W1-T56; `repair#<surface>`, W1-T905; `incident#<sha256>`, W1-T4385) naming the source that produced the entry. */
      origin: ("cli" | "ui" | "issue") | (string);
      /** The lifecycle (new -> grilling -> proposed -> accepted/rejected), plus `answered` (W1-T2278): the terminal arm a `grilling` entry reaches once a reply names it, the same write that sets `answered_by`. */
      status: "new" | "grilling" | "proposed" | "accepted" | "rejected" | "answered";
      /** W1-T2278 -- the `grilling` entry this entry answers, when captured through POST /v1/feedback's `replyTo`; null otherwise. */
      reply_to?: string | null;
      /** W1-T2278 -- the reverse edge of `reply_to`: the id of the entry that answered this one, set in the same write that moves it to `answered`; null or absent otherwise. */
      answered_by?: string | null;
      /** W1-T2496 -- the escalation thread this entry replies to, via POST /v1/escalation/reply; a different edge than `reply_to`. Null when none. */
      thread_id?: string | null;
      /** W1-T2302 -- the console-minted per-submission key a repeat of the same submit is recognised by. Null when none was supplied. */
      submission_key?: string | null;
      /** Set once `rmd triage` opens a proposal PR for this entry; null until then. */
      proposal_pr: string | null;
      /** W1-T313 -- src/lib/feedback.ts's `DecisionSummary`, the plain-language decision card generated once when the entry moves to `proposed`; null until then or on a summarizer failure. */
      summary?: {
        headline: string;
        what_happened: string;
        decision: string;
        options: ({
          label: string;
          consequence: string;
        })[];
      } | null;
      /** W1-T350 -- src/lib/feedback.ts's `FeedbackExpansion`, attached at capture from the console's preview; null when no preview ran. */
      expansion?: {
        claim: string;
        evidence: string;
        recon: (string)[];
        falsifying_check: string;
      } | null;
      /** W1-T397 -- present only when a home-repo pointer is configured and this checkout is not the home repo: whether the entry's upstream PR landed. */
      upstream?: {
        /** `owner/repo` of the configured home repo. */
        home: string;
        status: "landed" | "unreachable";
        pr_url?: string;
        error?: string;
      };
      /** GET /v1/feedback only (W1-T257): true when this `proposed` entry's proposal_pr merge state could not be read (GitHub outage) -- the row is kept, never dropped. Never written to plan/feedback/<id>.yaml; a read-time decoration only. */
      unverified?: boolean;
      /** GET /v1/feedback only (W1-T1257): true when every task this entry filed (`origin: feedback#<id>`) is credited MERGED -- the work the proposal produced has shipped, even though `status` still names a decision about the proposal itself. Derived fresh on every read, like `unverified` above; never written to plan/feedback/<id>.yaml and never auto-advances `status` -- whether a discharged entry should advance stays a human call. */
      discharged?: boolean;
      /** GET /v1/feedback only (W1-T1257): true when `discharged` could not be determined because the merged-set read failed or was truncated -- a partial read, never mistaken for "not discharged". Mutually exclusive with `discharged`; a read-time decoration only, exactly like `unverified`. */
      dischargeUndecidable?: boolean;
    };
    /** GET /v1/feedback's body -- every captured feedback entry, oldest first. Served through the console read cache (src/lib/serve.ts's `boundConsoleReadRoute`), so `rmd serve` also splices in `staleness`; a cold or stalled cache answers `{entries: [], staleness}`. */
    FeedbackInboxResult: {
      entries: (FeedbackEntry)[];
      staleness?: ConsoleResponseStaleness;
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
    /** One bounded activity, workstream, or authoritative artifact row. */
    OperatorActivityItem: {
      id: string;
      kind: "activity" | "workstream" | "artifact";
      summary: string;
      source: string;
      observedAt: string;
      freshness: "verified" | "stale" | "unavailable" | "unknown" | "not-collected";
      taskId?: string;
      repository?: string;
      state?: "active" | "blocked" | "queued" | "completed" | "unknown";
      reason?: string;
      href?: string;
    };
    /** GET /v1/operator-activity's bounded, source-labeled read projection. */
    OperatorActivityResult: {
      version: "operator-activity-v2";
      state: "verified" | "stale" | "unavailable" | "unknown" | "not-collected";
      source: string;
      observedAt: string;
      cursor?: string;
      items?: (OperatorActivityItem)[];
      truncated?: boolean;
      /** Present only when rows were cut; names each affected item kind. */
      truncatedKinds?: ("activity" | "workstream" | "artifact")[];
      reason?: string;
      detail?: string;
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
    /** A redacted external-effect reconciliation receipt; connector payloads never cross the daemon boundary. */
    ExternalActionResult: {
      version: "external-effect-v1";
      originatingActionId: string;
      originatingReceiptId: string;
      capabilityGrantId: string;
      connector: string;
      targetIdentity: string;
      requestedOperation: string;
      preconditionSnapshot: Record<string, never>;
      expectedPostconditions: ({
        path: string;
        /** JSON-compatible expected value; scalar values are preserved by the daemon even though the generated client represents this open object conservatively. */
        equals: Record<string, never>;
        description?: string;
      })[];
      observedState?: Record<string, never>;
      observation: {
        status: "fresh" | "stale" | "unavailable";
        observedAt?: string;
        ageMs?: number;
        maxAgeMs: number;
      };
      idempotencyKey: string;
      reconciliationState: "applied" | "refused" | "pending" | "partially-applied" | "drifted" | "stale" | "unobservable";
      partialSuccess?: {
        satisfied: (string)[];
        unsatisfied: (string)[];
      };
      retryPath: {
        kind: "none" | "retry" | "compensation";
        allowed: boolean;
        reason: string;
        attemptNumber?: number;
      };
      evidenceReference: string;
      safeToComplete: boolean;
      reason?: string;
    };
    /** Bounded read-only external-action-results-v1 projection. Unavailable source state is explicit and is never represented as a healthy empty list. */
    ExternalActionResultsEnvelope: {
      version: "external-action-results-v1";
      state: "verified" | "unavailable";
      source: string;
      generatedAt: string;
      cursor?: string;
      results?: (ExternalActionResult)[];
      truncated?: boolean;
      reason?: string;
      detail?: string;
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
    OperatorAgentEvidence: {
      label: string;
      value: string;
      source: string;
      observedAt: string;
      freshness: "verified" | "stale" | "unavailable";
    };
    OperatorAgentProposal: {
      proposalId: string;
      repo: string;
      proposalText: string;
      confidence: number;
      reasoning: string;
      category: "optimize" | "fix" | "scale";
      status: "pending" | "accepted" | "rejected" | "expired";
      createdAt: string;
      expiresAt?: string;
      evidence: (OperatorAgentEvidence)[];
    };
    OperatorAgentHistory: {
      proposalId: string;
      repo: string;
      proposalText: string;
      confidence: number;
      reasoning: string;
      category: "optimize" | "fix" | "scale";
      status: "pending" | "accepted" | "rejected" | "expired";
      createdAt: string;
      expiresAt?: string;
      evidence: (OperatorAgentEvidence)[];
      decisionHistory: ({
        decision: "accepted" | "rejected" | "more-info";
        at: string;
        note?: string;
      })[];
      outcome?: {
        summary: string;
        helped?: boolean;
        observedAt: string;
        evidence?: (string)[];
      };
    };
    OperatorAgentProposalList: {
      proposals: (OperatorAgentHistory)[];
      source: "ledger";
      presentation?: OperatorAgentProposalPresentation;
    };
    ContextRetention: {
      policy: string;
      expiresAt: string;
    };
    ContextRevocation: {
      state: "active" | "revoked";
      revokedAt?: string;
      reason?: string;
    };
    /** Bounded context-item-v1 memory. Content is accepted only for the assistant's internal reader and is never returned by the metadata inventory route. */
    ContextItem: {
      version: "context-item-v1";
      contextId: string;
      source: string;
      principal: string;
      purpose: string;
      sensitivity: "low" | "moderate" | "high" | "restricted";
      authorityRef: string;
      observedAt: string;
      freshness: "fresh" | "stale" | "unavailable";
      retention: ContextRetention;
      visibility: "private" | "operator" | "shared";
      derivationLinks: (string)[];
      revocation: ContextRevocation;
      content: string;
    };
    ContextInventoryItem: {
      version: "context-item-v1";
      contextId: string;
      source: string;
      principal: string;
      purpose: string;
      sensitivity: "low" | "moderate" | "high" | "restricted";
      authorityRef: string;
      observedAt: string;
      freshness: "fresh" | "stale" | "unavailable";
      retention: ContextRetention;
      visibility: "private" | "operator" | "shared";
      derivationLinks: (string)[];
      revocation: ContextRevocation;
      availability: "available" | "stale" | "unavailable" | "revoked" | "deleted";
      deletionReceipt?: ContextReceipt;
    };
    ContextReceipt: {
      receiptId: string;
      contextId: string;
      operation: "revoke" | "delete";
      at: string;
      authorityRef: string;
      affectedDerivations: number;
    };
    ContextReceiptResult: {
      ok: true;
      existing: boolean;
      receipt: ContextReceipt;
    };
    ContextList: {
      items: (ContextInventoryItem)[];
      stale: (string)[];
      absent: boolean;
      source: "ledger";
      asOf: string;
    };
    ContextRegistration: {
      context: ContextItem;
    };
    ContextActionRequest: {
      contextId: string;
      authorityRef: string;
      reason?: string;
    };
    /** W1-T3893 self-service inventory — the same metadata-only shape as ContextList, scoped to exactly one principal. */
    ContextControlsInventoryList: {
      items: (ContextInventoryItem)[];
      count: number;
      absent: boolean;
      asOf: string;
    };
    /** A bounded, redacted export projection. `redactedContent` is a truncated, secret-scrubbed preview — never the raw context-item-v1 `content` field. */
    ContextExportItem: {
      contextId: string;
      source: string;
      principal: string;
      purpose: string;
      sensitivity: "low" | "moderate" | "high" | "restricted";
      authorityRef: string;
      observedAt: string;
      freshness: "fresh" | "stale" | "unavailable";
      retention: ContextRetention;
      visibility: "private" | "operator" | "shared";
      derivationLinks: (string)[];
      redactedContent: string;
    };
    /** `status: completed` is returned ONLY when every selected item, and everything it derives from, is "available" — an incomplete derivation chain, an absent match, or a request past the bounded item limit is `status: refused` with a `reason`, never a partial "completed". */
    ContextExportResult: {
      status: "completed" | "refused";
      exportId?: string;
      asOf?: string;
      items?: (ContextExportItem)[];
      reason?: "absent" | "incomplete_coverage" | "bounded_exceeded";
      detail?: string;
      incompleteContextIds?: (string)[];
    };
    OperatorAgentProposalRegistration: {
      proposal: OperatorAgentProposal;
    };
    OperatorAgentDecisionRequest: {
      proposalId: string;
      decision: "accepted" | "rejected" | "more-info";
      note?: string;
    };
    OperatorAgentOutcomeRequest: {
      proposalId: string;
      outcome: {
        summary: string;
        helped?: boolean;
        observedAt: string;
        evidence?: (string)[];
      };
    };
    OperatorAgentSettings: {
      enabled: boolean;
      confidenceThreshold: number;
    };
    /** Settings are durable per repository; the console must select the repository explicitly. */
    OperatorAgentSettingsScope: {
      kind: "repository";
      repository: string;
    };
    OperatorAgentSettingsRequest: {
      settings: OperatorAgentSettings;
      scope?: OperatorAgentSettingsScope;
    };
    OperatorAgentSettingsResult: {
      settings: OperatorAgentSettings;
      source: "ledger" | "default";
      scope?: OperatorAgentSettingsScope;
      updatedAt?: string;
    };
    /** W1-T3895 -- a learned preference belongs to one principal in one repository, optionally one surface. */
    OperatorPreferenceScope: {
      principalId: string;
      repository: string;
      surface?: string;
    };
    /** The whole effect vocabulary. None of these can grant a capability, raise a budget, lower an approval level, or suppress a refusal. */
    OperatorPreferenceEffect: {
      kind: "ordering" | "notification-style" | "clarification-wording";
      value: string;
    };
    OperatorPreferenceLifecycle: "proposed" | "accepted" | "rejected" | "corrected" | "opted_out" | "deleted" | "expired" | "unmeasurable";
    OperatorPreferenceReceiptSummary: {
      receiptId: string;
      action: "accept" | "reject" | "correct" | "opt-out" | "delete";
      lifecycle: OperatorPreferenceLifecycle;
      at: string;
    };
    /** The `preference-hypothesis-v1` projection of one ledgered `operator-preference-v1` record (src/lib/preference-policy.ts's `projectOperatorPreference`). Evidence is bounded decision references only; a deleted preference withholds its anchors and explanation. */
    OperatorPreferenceProjection: {
      version: "preference-hypothesis-v1";
      preferenceId: string;
      scope: OperatorPreferenceScope;
      effect: OperatorPreferenceEffect;
      evidence: {
        summary: string;
        sampleFloor: number;
        sampleSize: number;
        source: string;
        observedAt: string;
        freshness: "verified" | "stale";
        anchors?: (string)[];
      };
      /** `value` is 0 with `source` `insufficient` or `unmeasurable` when the evidence cannot measure the preference. */
      confidence: {
        value: number;
        source: string;
        sampleFloor: number;
      };
      freshness: "verified" | "stale";
      expiresAt: string;
      explanation: string;
      application: {
        state: "applied" | "shadow" | "not_applied";
        effect: string;
        nonAuthorityGuarantee: "presentation_only";
        reason: string;
      };
      lifecycle: OperatorPreferenceLifecycle;
      source: string;
      observedAt: string;
      /** The earlier hypothesis for the same scope and effect this one replaced. */
      supersedes?: string;
      receipts: (OperatorPreferenceReceiptSummary)[];
    };
    OperatorPreferenceList: {
      source: "ledger";
      stale: boolean;
      scope: OperatorPreferenceScope;
      preferences: (OperatorPreferenceProjection)[];
    };
    /** Scope and effect only. Evidence, confidence, and authority are never accepted from the caller. */
    OperatorPreferenceProposalRequest: {
      scope: OperatorPreferenceScope;
      effect: OperatorPreferenceEffect;
    };
    OperatorPreferenceProposalResult: {
      ok: boolean;
      existing: boolean;
      preference: OperatorPreferenceProjection;
    };
    /** One operator action on one preference. `correction` is required to correct. A note is ledgered only as present and a correction only as a digest; neither raw text is stored. */
    OperatorPreferenceActionRequest: {
      action?: "accept" | "reject" | "correct" | "opt-out" | "delete";
      preferenceId: string;
      scope: OperatorPreferenceScope;
      note?: string;
      correction?: string;
      /** Idempotency key -- a repeated requestId for the same action returns the original receipt. */
      requestId?: string;
    };
    /** The durable, linked receipt of one preference action. */
    OperatorPreferenceReceipt: {
      ok: boolean;
      receiptId: string;
      preferenceId: string;
      linkedTo: string;
      action: "accept" | "reject" | "correct" | "opt-out" | "delete";
      lifecycle: OperatorPreferenceLifecycle;
      previousLifecycle: OperatorPreferenceLifecycle;
      at: string;
      scope: OperatorPreferenceScope;
      requestId?: string;
      previousReceiptId?: string;
      hasNote?: boolean;
      correctionDigest?: string;
    };
    /** A refused preference action or proposal; nothing was recorded. */
    OperatorPreferenceRefusal: {
      error: "conflict" | "not_found";
      /** `not_found`, `scope_mismatch`, `already_deleted`, `opted_out`, `stale_evidence`, or `invalid_transition`. */
      code: string;
      detail: string;
    };
    /** W1-T3895 -- present only when GET /v1/operator-agent/proposals names a principal scope. The proposals were checked for authority and refusal first; accepted preferences only reordered the actionable ones. */
    OperatorAgentProposalPresentation: {
      scope: OperatorPreferenceScope;
      applied: (string)[];
      skipped: ({
        preferenceId: string;
        reason: string;
      })[];
      refusals: ({
        proposalId: string;
        code: string;
      })[];
      notificationStyle?: string;
      clarificationWording?: string;
    };
    OperatorAgentExperimentScope: {
      repo: string;
      taskType?: string;
      lane?: string;
      provider?: string;
      modelPolicy?: string;
      evidenceAnchors?: (string)[];
    };
    OperatorAgentExperimentBaseline: {
      metricName: string;
      value: number;
      unit: string;
      denominator: number;
      comparisonPopulation: string;
      windowStart: string;
      windowEnd: string;
      source: string;
      freshness: "verified" | "stale" | "unavailable";
    };
    OperatorAgentExperimentIntervention: {
      summary: string;
      plan: string;
      taskId?: string;
      prUrl?: string;
    };
    OperatorAgentExperimentRollback: {
      plan: string;
      reason: string;
      receipt?: string;
    };
    OperatorAgentExperiment: {
      version: "experiment-v1";
      experimentId: string;
      proposalId?: string;
      hypothesis: string;
      intervention: OperatorAgentExperimentIntervention;
      scope: OperatorAgentExperimentScope;
      baseline: OperatorAgentExperimentBaseline;
      rollback: OperatorAgentExperimentRollback;
      createdAt: string;
      state: "proposed";
    };
    OperatorAgentExperimentOutcome: {
      state: "observing" | "succeeded" | "neutral" | "regressed" | "unmeasurable";
      summary: string;
      observedAt: string;
      source?: string;
      freshness?: "verified" | "stale" | "unavailable";
      attribution?: "complete" | "missing" | "mixed";
      denominator?: number;
      comparisonPopulation?: string;
      metricName?: string;
      value?: number;
      reason?: string;
    };
    OperatorAgentExperimentHistory: {
      version: "experiment-v1";
      experimentId: string;
      proposalId?: string;
      hypothesis: string;
      intervention: OperatorAgentExperimentIntervention;
      scope: OperatorAgentExperimentScope;
      baseline: OperatorAgentExperimentBaseline;
      rollback: OperatorAgentExperimentRollback;
      createdAt: string;
      state: "proposed" | "approved" | "observing" | "succeeded" | "neutral" | "regressed" | "rolled_back" | "expired" | "unmeasurable" | "rejected";
      events: ({
        kind: "decision" | "outcome" | "rollback";
        at: string;
        decision?: "approved" | "rejected";
        outcome?: OperatorAgentExperimentOutcome;
        rollback?: OperatorAgentExperimentRollback;
        note?: string;
      })[];
      outcome?: OperatorAgentExperimentOutcome;
    };
    OperatorAgentExperimentList: {
      experiments: (OperatorAgentExperimentHistory)[];
      source: "ledger";
    };
    OperatorAgentExperimentRegistration: {
      experiment: OperatorAgentExperiment;
    };
    OperatorAgentExperimentDecisionRequest: {
      experimentId: string;
      decision: "approved" | "rejected";
      note?: string;
    };
    OperatorAgentExperimentOutcomeRequest: {
      experimentId: string;
      outcome: OperatorAgentExperimentOutcome;
    };
    OperatorAgentExperimentRollbackRequest: {
      experimentId: string;
      rollback: OperatorAgentExperimentRollback;
    };
    /** Names a flowId or experimentId AND a repo or instance; a record missing either half is refused `missing-scope`. */
    AutomationActionScope: {
      flowId?: string;
      experimentId?: string;
      repo?: string;
      instance?: string;
    };
    AutomationActionPrecondition: {
      id: string;
      /** The authoritative source an observation must come from. */
      source: string;
      description: string;
    };
    /** A reversible action names its plan; an irreversible one names the refusal path a rollback request takes instead. */
    AutomationActionRollback: {
      mode: "reversible" | "irreversible";
      plan?: string;
      refusal?: string;
    };
    /** An immutable automation-action-v1 record (src/lib/automation-action.ts's `validateAutomationAction`). Fields the contract does not name are dropped; a raw prompt, transcript, credential, model prose, or browser-owned measurement field -- or a credential-shaped value -- refuses the whole record. */
    AutomationAction: {
      version: "automation-action-v1";
      actionId: string;
      capability: string;
      summary: string;
      scope: AutomationActionScope;
      risk: "low" | "medium" | "high" | "production" | "financial" | "credential" | "destructive";
      preconditions: (AutomationActionPrecondition)[];
      freshness: {
        maxAgeSeconds: number;
      };
      idempotencyKey: string;
      createdAt: string;
      expiresAt: string;
      dryRun: boolean;
      approval: {
        /** high, production, financial, credential and destructive risk must declare human. */
        policy: "none" | "human";
      };
      rollback: AutomationActionRollback;
      /** The authoritative system of record whose receipt proves what happened. */
      receiptRef: string;
    };
    AutomationPreconditionObservation: {
      preconditionId: string;
      state: "satisfied" | "unsatisfied" | "unavailable";
      source: string;
      observedAt: string;
      reason?: string;
    };
    AutomationPreflightFinding: {
      outcome: "refused" | "stale" | "unknown" | "expired" | "in-progress";
      code: string;
      detail: string;
      preconditionId?: string;
      receiptId?: string;
    };
    AutomationPreflightResult: {
      version: "automation-action-v1";
      actionId: string;
      outcome: "ready" | "refused" | "stale" | "unknown" | "expired" | "in-progress";
      evaluatedAt: string;
      approval: "not-required" | "pending" | "approved" | "rejected";
      findings: (AutomationPreflightFinding)[];
    };
    /** One bounded, append-only receipt; completion and rollback link to what they follow via linkedReceiptId. */
    AutomationActionReceipt: {
      version: "automation-action-v1";
      receiptId: string;
      actionId: string;
      idempotencyKey: string;
      kind: "execution" | "completion" | "rollback";
      outcome: "in-progress" | "dry-run" | "refused" | "succeeded" | "failed" | "rolled_back";
      at: string;
      receiptRef: string;
      linkedReceiptId?: string;
      preflight?: "ready" | "refused" | "stale" | "unknown" | "expired" | "in-progress";
      /** A refusal's reason; on a completion, W1-T4657's evidence label -- `executor` when the action-catalogue-v1 executor wrote it, `self-reported` when a caller posted it. */
      code?: string;
      reason: string;
      evidenceRef?: string;
    };
    OperatorAgentActionHistory: {
      action: AutomationAction;
      state: "registered" | "approved" | "rejected" | "in-progress" | "succeeded" | "failed" | "rolled_back" | "expired";
      approval: "not-required" | "pending" | "approved" | "rejected";
      decision?: {
        decision: "approved" | "rejected";
        decidedBy: string;
        decidedAt: string;
      };
      receipts: (AutomationActionReceipt)[];
    };
    OperatorAgentActionList: {
      version: "automation-action-v1";
      actions: (OperatorAgentActionHistory)[];
      source: "ledger";
    };
    OperatorAgentActionRegistration: {
      action: AutomationAction;
    };
    OperatorAgentActionDecisionRequest: {
      actionId: string;
      decision: "approved" | "rejected";
    };
    OperatorAgentActionObservationRequest: {
      actionId: string;
      observations?: (AutomationPreconditionObservation)[];
      /** Execute only; a dry run evaluates preflight and records a dry-run receipt without admitting anything. */
      dryRun?: boolean;
      /** W1-T3878 -- the delegation-profile-v1 this request acts under. Its eligibility (missing, revoked, stale, expired, unapproved, over budget, out of scope, unlinked, capability, risk ceiling, human gate) enters preflight as refused findings named `delegation-*`. */
      delegationId?: string;
      /** W1-T3878 -- the cost an admission under `delegationId` charges against that profile's cost budget. */
      estimatedCostUsd?: number;
    };
    OperatorAgentActionCompletionRequest: {
      actionId: string;
      admissionReceiptId: string;
      outcome: "succeeded" | "failed";
      /** Required for succeeded -- success is claimed only with the evidence that proves it. */
      evidenceRef?: string;
      reason?: string;
    };
    OperatorAgentActionRollbackRequest: {
      actionId: string;
      reason: string;
      evidenceRef: string;
    };
    OperatorAgentActionPreflightResponse: {
      preflight: AutomationPreflightResult;
    };
    /** An engine step's disposition and the receipt it decided. `reused` returns the EXISTING receipt for a duplicate idempotency key, completion, or rollback, and appends nothing. */
    OperatorAgentActionStepResult: {
      ok: boolean;
      disposition: "admitted" | "dry-run" | "refused" | "reused" | "completed" | "rolled_back";
      receipt: AutomationActionReceipt;
      preflight?: AutomationPreflightResult;
      admission?: AutomationActionReceipt;
      /** W1-T4657 -- the catalogue executor's own ledger row, which the completion's evidenceRef cites. */
      executor?: {
        step: string;
        ts: string;
        run_id: string;
      };
    };
    DelegationProfileScope: ({
      kind: "repository";
      repository: string;
    }) | ({
      kind: "instance";
      instanceId: string;
    });
    /** The action or flow this delegation governs; at least one is required. */
    DelegationProfileLink: {
      flowId?: string;
      actionId?: string;
    };
    DelegationProfileBudget: {
      costUsd: number;
      /** Counted from the operator's acceptance. */
      durationMinutes: number;
    };
    /** What an issuer supplies (src/lib/delegation-profile.ts's `buildDelegationProfile`). version, revision, createdAt (the server clock) and revocationRef are set by core. A raw prompt, transcript, credential, browser-owned measurement, or a model-confidence / prior-approval / UI-state field anywhere refuses the whole record by name. */
    DelegationProfileInput: {
      delegationId: string;
      principal: string;
      purpose: string;
      link: DelegationProfileLink;
      scope: DelegationProfileScope;
      dataClasses: (string)[];
      capabilities: (string)[];
      capabilitySummary: string;
      /** The highest risk an action under this profile may declare. */
      riskTier: "low" | "medium" | "high" | "production" | "financial" | "credential" | "destructive";
      budget: DelegationProfileBudget;
      notification: "silent" | "on-refusal" | "on-every-action";
      approvalLevel: "profile" | "each-action";
      humanDecision: string;
      fallbackOwner: string;
      /** After createdAt and within 90 days of it. */
      expiresAt: string;
    };
    DelegationProfileReceipt: {
      kind: "accept" | "revoke" | "replace";
      at: string;
      note?: string;
    };
    /** One profile with its derived state. `riskTier` is the console's four-tier vocabulary (every critical tier reads `critical`); `actionRiskCeiling` is core's own tier. `lifecycleState` answers "may it act at all" and is never folded with `freshness`; `revocation` is present whenever the ledger carries it, including a superseded profile naming its replacement. */
    DelegationProfileView: {
      version: "delegation-profile-v1";
      delegationId: string;
      revision: number;
      replaces?: string;
      principal: string;
      purpose: string;
      link: DelegationProfileLink;
      scope: DelegationProfileScope;
      dataClasses: (string)[];
      capabilities: (string)[];
      capabilitySummary: string;
      riskTier: "low" | "medium" | "high" | "critical";
      actionRiskCeiling: "low" | "medium" | "high" | "production" | "financial" | "credential" | "destructive";
      budget: DelegationProfileBudget;
      notification: "silent" | "on-refusal" | "on-every-action";
      approvalLevel: "profile" | "each-action";
      humanDecision: string;
      fallbackOwner: string;
      createdAt: string;
      expiresAt: string;
      revocationRef: string;
      approval: {
        state: "pending" | "approved" | "denied";
        decidedAt?: string;
      };
      lifecycleState: "active" | "expired" | "revoked";
      status: "pending" | "active" | "denied" | "revoked" | "superseded" | "expired";
      revocation?: {
        reason?: string;
        revokedAt?: string;
      };
      supersededBy?: string;
      pendingReplacement?: string;
      spentCostUsd: number;
      receipts: (DelegationProfileReceipt)[];
      observedAt: string;
      freshness: "verified";
    };
    DelegationProfileList: {
      version: "delegation-profile-v1";
      profiles: (DelegationProfileView)[];
      source: "ledger";
    };
    DelegationProfileIssueRequest: {
      profile: DelegationProfileInput;
    };
    DelegationProfileIssueResult: {
      ok: boolean;
      profile: DelegationProfileView;
    };
    DelegationDecisionRequest: {
      delegationId: string;
      decision: "accepted" | "revoked";
      note?: string;
    };
    DelegationDecisionResult: {
      ok: boolean;
      delegationId: string;
      decision: "accepted" | "revoked";
      decidedBy: string;
      at: string;
      lifecycleState: "active" | "expired" | "revoked";
      approval: "pending" | "approved" | "denied";
    };
    DelegationReplaceRequest: {
      delegationId: string;
      note?: string;
      /** Any DelegationProfileInput field except the identity fields (delegationId, principal, link, scope), which refuse `immutable-field`. Unnamed fields carry over; expiresAt defaults to the predecessor's lifetime from now. */
      changes?: Record<string, never>;
    };
    DelegationReplaceResult: {
      ok: boolean;
      /** The profile being replaced; unchanged, and authoritative until the replacement is accepted. */
      delegationId: string;
      replacementId: string;
      at: string;
      /** The REPLACED profile's lifecycle, which the replacement does not change. */
      lifecycleState: "active" | "expired" | "revoked";
      profile: DelegationProfileView;
    };
    IntentPlanStepInput: {
      capability: string;
      summary: string;
      risk: "low" | "medium" | "high" | "production" | "financial" | "credential" | "destructive";
      preconditions: (Record<string, never>)[];
      freshness: Record<string, never>;
      dryRun: boolean;
      rollback: Record<string, never>;
      receiptRef: string;
      estimatedCostUsd?: number;
    };
    IntentPlanProposeRequest: {
      goal: string;
      constraints?: (string)[];
      facts?: (Record<string, never>)[];
      questions?: (Record<string, never>)[];
      steps?: (IntentPlanStepInput)[];
      scope?: Record<string, never>;
      delegationId?: string;
      budget?: Record<string, never>;
      freshness?: Record<string, never>;
      expiresInMinutes?: number;
      idempotencyKey?: string;
    };
    IntentPlanUnknown: {
      id: string;
      question: string;
    };
    IntentPlanReceiptEntry: {
      kind: "propose" | "clarify" | "confirm" | "undo";
      at: string;
      issuer?: string;
      note?: string;
    };
    IntentPlanConsequence: {
      classes: ("financial" | "irreversible")[];
      summary: string;
      budgetUsd?: number;
      ceilingUsd?: number;
    };
    IntentPlanExecution: {
      state: "not-requested" | "awaiting-receipt" | "in-progress" | "succeeded" | "failed" | "refused" | "expired" | "rolled-back" | "partially-rolled-back" | "unknown";
      actions: (Record<string, never>)[];
    };
    IntentPlanView: {
      planId: string;
      goal: string;
      constraints: (string)[];
      unknowns: (IntentPlanUnknown)[];
      scope: {
        /** The resolved repository, `(instance scope)`, or `(unresolved)` while the scope question is open. */
        repository: string;
        instanceId?: string;
      };
      consequence: IntentPlanConsequence;
      freshness: "verified" | "stale" | "unavailable";
      nextDecision: "answer_clarification" | "confirm" | "undo" | "none";
      observedAt: string;
      receipts: (IntentPlanReceiptEntry)[];
      source: string;
      version: "intent-plan-v1";
      status: "draft" | "confirmed" | "withdrawn";
      /** The immutable intent-plan-v1 envelope -- outcome, constraints, facts and sources, questions, steps, scope, consequence, budget, approval, expiry, idempotency key, and undo paths. */
      plan: Record<string, never>;
      /** Non-operative (`operative` is always false); `state` is ready or the first blocking state by precedence, with every finding kept. */
      preview: Record<string, never>;
      confirmation: Record<string, never>;
      execution: IntentPlanExecution;
      events: (Record<string, never>)[];
    };
    IntentPlanList: {
      version: "intent-plan-v1";
      state: "verified";
      intentPlans: (IntentPlanView)[];
      source: "ledger";
    };
    /** IntentPlanView flattened (this generator's subset has no allOf) plus `ok` and `existing`. */
    IntentPlanProposeResult: {
      ok: boolean;
      existing: boolean;
      planId: string;
      goal: string;
      constraints: (string)[];
      unknowns: (IntentPlanUnknown)[];
      scope: Record<string, never>;
      consequence: IntentPlanConsequence;
      freshness: "verified" | "stale" | "unavailable";
      nextDecision: "answer_clarification" | "confirm" | "undo" | "none";
      observedAt: string;
      receipts: (IntentPlanReceiptEntry)[];
      source: string;
      status?: "draft" | "confirmed" | "withdrawn";
      plan?: Record<string, never>;
      preview?: Record<string, never>;
      execution?: IntentPlanExecution;
    };
    IntentPlanDecisionRequest: {
      planId: string;
      action: "clarify" | "confirm" | "undo";
      /** clarify only. */
      questionId?: string;
      /** clarify only. */
      answer?: string;
      /** confirm only; when present it must be true. */
      confirm?: boolean;
      /** confirm and undo only. */
      note?: string;
    };
    IntentPlanDecisionResult: {
      ok: boolean;
      planId: string;
      action: "clarify" | "confirm" | "undo";
      disposition: "recorded" | "confirmed" | "withdrawn" | "requested" | "reused";
      at: string;
      event: Record<string, never>;
      plan: IntentPlanView;
    };
    IntentPlanDecisionRefusal: {
      ok: boolean;
      error: "conflict";
      planId: string;
      action: string;
      code: string;
      detail: string;
      /** Present when the refusal itself was recorded (an undo refusal). */
      at?: string;
      event?: Record<string, never>;
    };
    PromotionScope: {
      repo: string;
      /** The unit canary exposure is serialized against; at most one active promotion may hold a given (repo, policyScope) pair. */
      policyScope: string;
      taskType?: string;
      lane?: string;
    };
    PromotionGuardMetric: {
      metricName: string;
      unit: string;
      direction: "max" | "min";
      abortThreshold: number;
    };
    PromotionRollback: {
      plan: string;
      reason: string;
      receipt?: string;
    };
    PromotionRecord: {
      version: "experiment-promotion-v1";
      promotionId: string;
      /** Links to the experiment-v1 record (W1-T3853) this promotion progresses. */
      experimentId?: string;
      candidate: string;
      baseline: string;
      scope: PromotionScope;
      comparisonPopulation: string;
      denominatorFloor: number;
      observationWindow: {
        start: string;
        end: string;
      };
      guardMetrics: (PromotionGuardMetric)[];
      /** The bounded maximum fraction of traffic the canary may take. */
      maxExposure: number;
      owner: string;
      expiresAt: string;
      rollback: PromotionRollback;
      createdAt: string;
      state: "proposed";
    };
    /** The bounded per-case receipt submitted and persisted: whether the candidate and baseline agreed. The raw candidate/baseline outputs replayPromotion() computes are not part of the durable wire contract -- they may be arbitrarily large or unbounded -- so only the comparison result is recorded. */
    PromotionReplayResult: {
      caseId: string;
      matched: boolean;
    };
    PromotionReplaySummary: {
      version: "experiment-promotion-v1";
      corpusSize: number;
      matched: number;
      mismatched: number;
      deterministic: boolean;
      sideEffectFree: true;
      results: (PromotionReplayResult)[];
    };
    PromotionGuardObservation: {
      metricName: string;
      value: number;
      denominator: number;
      freshness: "verified" | "stale" | "unavailable";
      comparisonPopulation: string;
      observedAt: string;
    };
    PromotionGuardEvaluation: {
      state: "ready" | "unmeasurable" | "regressed";
      reasons: (string)[];
      breachedMetrics: (string)[];
    };
    /** One control case (W1-T3882): a `positive` control proves the corpus is visible (a known-good case the candidate must pass); a `negative` control proves a restraint failure is detectable (a known-bad case the candidate must flag, never pass silently). */
    AssistantTrustControlResult: {
      caseId: string;
      metricName: "proactivity_precision" | "dropped_thread_recovery" | "clarification_burden" | "intervention_rate" | "unauthorized_side_effect_rate" | "stale_context_use" | "receipt_completeness" | "rollback_success" | "time_to_human_attention";
      controlType: "positive" | "negative";
      expectedOutcome: "pass" | "flagged";
      observedOutcome: "pass" | "flagged";
    };
    /** Restraint and recovery evidence (W1-T3882) that gates a promotion above the base guardrail evaluation: any unauthorized side effect, stale-context use, incomplete receipt, or failed rollback blocks promotion outright. */
    AssistantTrustEvidence: {
      unauthorizedSideEffects: number;
      staleContextUses: number;
      receiptsComplete: boolean;
      rollbackAttempted: boolean;
      rollbackSucceeded: boolean;
    };
    /** Raw material an evaluation MIGHT be handed — never persisted or trained on. Only bounded counts and a secret-scrubbed, length-capped note ever leave this boundary; see `AssistantTrustEvaluation.evidence`. */
    RawAssistantTrustContext: {
      prompts?: (string)[];
      transcripts?: (string)[];
      credentials?: (string)[];
      note?: string;
    };
    RedactedAssistantTrustEvidence: {
      promptCount: number;
      transcriptCount: number;
      credentialCount: number;
      note: string;
      redacted: true;
    };
    /** The evaluation layer above `PromotionGuardEvaluation` (W1-T3882): a candidate may reach `ready` only when replay was deterministic and side-effect-free, the corpus carried working positive and negative controls, and no unauthorized side effect, stale-context use, incomplete receipt, or failed rollback was observed. */
    AssistantTrustEvaluation: {
      state: "ready" | "unmeasurable" | "blocked";
      reasons: (string)[];
      evidence: RedactedAssistantTrustEvidence;
    };
    OperatorAgentPromotionHistory: {
      version: "experiment-promotion-v1";
      promotionId: string;
      experimentId?: string;
      candidate: string;
      baseline: string;
      scope: PromotionScope;
      comparisonPopulation: string;
      denominatorFloor: number;
      observationWindow: {
        start: string;
        end: string;
      };
      guardMetrics: (PromotionGuardMetric)[];
      maxExposure: number;
      owner: string;
      expiresAt: string;
      rollback: PromotionRollback;
      createdAt: string;
      state: "proposed" | "replayed" | "approved" | "shadow" | "canary" | "observing" | "promoted" | "neutral" | "regressed" | "rolled_back" | "expired" | "unmeasurable";
      events: ({
        kind: "replay" | "decision" | "advance" | "rollback";
        at: string;
        state: string;
        replay?: PromotionReplaySummary;
        decision?: "approved";
        advance?: {
          target: "shadow" | "canary" | "observing" | "promoted";
          guard: PromotionGuardEvaluation;
          exposure?: number;
          assistantTrust?: AssistantTrustEvaluation;
        };
        rollback?: PromotionRollback;
        note?: string;
      })[];
    };
    OperatorAgentPromotionList: {
      promotions: (OperatorAgentPromotionHistory)[];
      source: "ledger";
    };
    OperatorAgentPromotionRegistration: {
      promotion: PromotionRecord;
    };
    OperatorAgentPromotionReplayRequest: {
      promotionId: string;
      replay: PromotionReplaySummary;
    };
    OperatorAgentPromotionDecisionRequest: {
      promotionId: string;
      decision: "approved";
      note?: string;
    };
    OperatorAgentPromotionAdvanceRequest: {
      promotionId: string;
      target: "shadow" | "canary" | "observing" | "promoted";
      observations?: (PromotionGuardObservation)[];
      exposure?: number;
      /** Optional assistant-trust evidence (W1-T3882). Its absence preserves the pre-W1-T3882 base-guardrail-only advance behaviour exactly; when present, the response carries an `assistantTrust` evaluation and a `blocked`/`unmeasurable` result can demote an otherwise-ready advance to `regressed`/`unmeasurable`. */
      assistantTrust?: {
        controls: (AssistantTrustControlResult)[];
        evidence: AssistantTrustEvidence;
        rawContext?: RawAssistantTrustContext;
      };
    };
    OperatorAgentPromotionRollbackRequest: {
      promotionId: string;
      rollback: PromotionRollback;
    };
    OperatorAgentConsequenceAction: {
      id?: string;
      consequenceClass: "reversible" | "disruptive" | "irreversible" | "financial";
      target: {
        identity: string;
        source: "trusted" | "external";
        ambiguous?: boolean;
      };
      scope?: {
        repo?: string;
        instance?: string;
      };
      evidence?: ({
        label: string;
        observedAt: string;
        maxAgeSeconds: number;
      })[];
      financial?: {
        amount?: number;
        currency?: string;
        perActionCeiling?: number;
        aggregateCeiling?: number;
        aggregateSpentBefore?: number;
        quoteExpiresAt?: string;
        coolingOffSeconds?: number;
        coolingOffStartedAt?: string;
      };
      irreversible?: {
        affectedResource?: string;
        recoveryAvailable?: boolean;
        recoveryStatement?: string;
        rollbackUnavailableReason?: string;
        confirmationNonce?: string;
        confirmationExpiresAt?: string;
      };
      requiredApprovers: number;
      approvals?: ({
        approverId: string;
        approvedAt: string;
        source: "trusted" | "external";
      })[];
      capabilityGrant?: {
        grantId: string;
      };
    };
    OperatorAgentConsequencePreflightRequest: {
      action: OperatorAgentConsequenceAction;
    };
    /** One recorded decision on a pending consequence (src/lib/operator-agent.ts's `ConsequenceDecisionReceipt`). */
    OperatorAgentConsequenceReceipt: {
      kind: "approve" | "refuse";
      at: string;
      /** The deciding credential's actor id, when the ledger row recorded one. */
      issuer?: string;
      /** The decision's reason. A refusal with no operator reason carries "operator refused this consequence". */
      note?: string;
    };
    /** consequence-v1 as the console's `normalizedConsequenceRecord` validates it (src/lib/operator-agent.ts's `PendingConsequenceRecord`), projected from the approval the consequence preflight persisted on its ledger row. */
    OperatorAgentPendingConsequence: {
      /** The preflighted action's id. */
      consequenceId: string;
      classes: ("financial" | "irreversible")[];
      /** The action's target identity, never truncated -- a longer one is not listed at all. */
      target: string;
      amountUsd?: number;
      currency?: string;
      /** The per-action financial ceiling. */
      ceilingUsd?: number;
      coolingOffMs?: number;
      coolingOffUntil?: string;
      /** The earlier of the quote expiry and the irreversible confirmation expiry. */
      expiresAt: string;
      approverRequired: boolean;
      recoveryStatement: string;
      /** `stale` once the earliest evidence item's freshness window has passed. */
      freshness: "verified" | "stale";
      /** When the preflight row that made this consequence pending was written. */
      observedAt: string;
      /** Empty, or the one refusal recorded since that preflight row. */
      receipts: (OperatorAgentConsequenceReceipt)[];
      source: "rmd:core:/v1/operator-agent/consequences";
    };
    /** GET /v1/operator-agent/consequences's body (src/lib/operator-agent.ts's `PendingConsequenceRead`). */
    OperatorAgentPendingConsequenceRead: {
      state: "verified";
      /** Newest `observedAt` first, at most `max` records. */
      consequences: (OperatorAgentPendingConsequence)[];
      source: "ledger";
      generatedAt: string;
      /** The per-read cap (MAX_PENDING_CONSEQUENCES, 100). */
      max: number;
      /** Every pending consequence, before the cap. */
      total: number;
      truncated: boolean;
      /** Pending preflight rows written before W1-T4104 carried no approval projection -- counted, never listed. */
      unprojected: number;
    };
    /** A write verb on GET /v1/operator-agent/consequences, refused by name. */
    OperatorAgentConsequencesReadOnlyRefusal: {
      error: "read_only";
      method: "POST" | "PUT" | "PATCH" | "DELETE";
      path: "/v1/operator-agent/consequences";
      detail: string;
      allow: ("GET")[];
    };
    /** src/lib/operator-agent.ts's `validateConsequenceDecisionInput`. `note` is the console's earlier name for `reason` and is accepted as an alias; sending both is a 400. */
    OperatorAgentConsequenceDecisionRequest: {
      consequenceId: string;
      decision: "approve" | "refuse";
      reason?: string;
      note?: string;
    };
    OperatorAgentConsequenceDecisionResult: {
      ok: true;
      consequenceId: string;
      decision: "approve" | "refuse";
      at: string;
      receipt: OperatorAgentConsequenceReceipt;
    };
    /** A consequence decision refused because the consequence is not (or no longer) pending; nothing is recorded. */
    OperatorAgentConsequenceDecisionRefusal: {
      error: "not_found" | "expired_consequence" | "consequence_not_pending";
      consequenceId: string;
      detail: string;
    };
    /** A bound `emergency-stop-v1` stop (src/lib/emergency-control.ts's `EmergencyStop`). */
    EmergencyStop: {
      schema: "emergency-stop-v1";
      id: string;
      scope: "fleet" | "repository" | "instance" | "principal";
      /** Present for every scope but `fleet`, which is total by definition. */
      scopeTarget?: string;
      reason: string;
      issuedBy: string;
      issuedAt: string;
      clearPolicy: "expires" | "explicit-clear-required";
      /** Present only when `clearPolicy` is `expires`. */
      expiresAt?: string;
      /** The capabilities this stop blocks. The code's type is `string[] | "*"`: the literal string "*" (the default) blocks every capability. This document's OpenAPI subset (scripts/generate-api-client.mjs) has no union, so only the array arm is typed here -- a consumer must accept the string "*" as well. */
      affectedCapabilities: (string)[];
      /** The delegation classes this stop blocks. The code's type is `string[] | "*"`: the literal string "*" (the default) blocks every class; as for `affectedCapabilities`, only the array arm is typed here and a consumer must accept "*" as well. */
      affectedDelegationClasses: (string)[];
      /** The incident record this stop is accountable to; every receipt of its lifecycle links back to it. */
      incidentReceiptId: string;
    };
    /** One bounded, attributable receipt of an emergency stop's lifecycle (src/lib/emergency-control.ts's `EmergencyReceipt`). */
    EmergencyReceipt: {
      receiptId: string;
      stopId: string;
      /** Always the stop's own `incidentReceiptId`. */
      parentReceiptId: string;
      kind: "stop" | "refusal" | "cancellation" | "clear";
      /** `issued` for a stop, the refused action kind for a refusal, `cleared` or the clear refusal code for a clear. */
      outcome: string;
      decidedAt: string;
      /** Capped at 240 characters plus a trailing ellipsis. */
      reason: string;
    };
    /** src/lib/operator-agent.ts's `validateEmergencyStopIssue`, then `createEmergencyStop`'s issuance rules. `affectedCapabilities`/`affectedDelegationClasses` default to "*" when omitted and may be sent as the literal string "*" -- the OpenAPI subset types only their array arm. `issuedAt` is stamped by the daemon. */
    EmergencyStopIssueRequest: {
      /** Defaults to `estop-<uuid>`. */
      id?: string;
      scope: "fleet" | "repository" | "instance" | "principal";
      /** Required for every scope but `fleet`; refused on `fleet`. */
      scopeTarget?: string;
      reason: string;
      issuedBy: string;
      clearPolicy: "expires" | "explicit-clear-required";
      /** Required for `expires`; refused for `explicit-clear-required`. */
      expiresAt?: string;
      affectedCapabilities?: (string)[];
      affectedDelegationClasses?: (string)[];
      incidentReceiptId: string;
    };
    EmergencyStopIssueResult: {
      ok: true;
      stop: EmergencyStop;
      receipt: EmergencyReceipt;
    };
    /** src/lib/operator-agent.ts's `validateEmergencyStopClear`. Clearing succeeds only with a `healthy` health read whose `checkedAt` is no more than five minutes old and `complete` revocation coverage; anything else is a 409 refusal, not a 400. */
    EmergencyStopClearRequest: {
      stopId: string;
      /** An explicit human sign-off -- never inferred from a prior approval. */
      confirmation: {
        confirmedBy: string;
        confirmedAt: string;
      };
      /** A fresh, authoritative health/preflight read. */
      health: {
        source: string;
        status: "healthy" | "degraded" | "unavailable";
        checkedAt: string;
      };
      revocation: {
        coverage: "complete" | "partial" | "unavailable";
      };
    };
    EmergencyStopClearResult: {
      ok: true;
      receipt: EmergencyReceipt;
    };
    EmergencyStopClearRefusal: {
      ok: false;
      code: "already-cleared" | "confirmation-required" | "health-stale" | "health-not-healthy" | "revocation-source-partial" | "revocation-source-unavailable";
      receipt: EmergencyReceipt;
    };
    EmergencyStopStatusResult: {
      active: (EmergencyStop)[];
      source: "ledger";
    };
    /** An action refused because an active emergency stop covers it; the receipt's `stopId` names the stop. */
    EmergencyStopAdmissionRefusal: {
      ok: false;
      error: "emergency_stop_active";
      code: "emergency-stop-active";
      receipt: EmergencyReceipt;
    };
    /** src/lib/operator-agent.ts's `validateDelegationHandoff`, then src/lib/automation-action.ts's `createDelegationEnvelope` (which also refuses a `sender` equal to the `recipient`). The recipient's acceptance may only narrow the envelope's capabilities; `humanApproval` is required for high, production, financial, credential and destructive risk. */
    OperatorAgentDelegationHandoffRequest: {
      envelope: {
        /** Defaults to `dlg-<uuid>`. */
        id?: string;
        sender: string;
        recipient: string;
        principal: string;
        purpose: string;
        capabilities: (string)[];
        scope?: {
          repo?: string;
          instance?: string;
        };
        audience: string;
        expiresAt: string;
        /** Defaults to `n-<uuid>`. */
        nonce?: string;
      };
      acceptedCapabilities: (string)[];
      action: {
        capability: string;
        nonce: string;
        risk: "low" | "medium" | "high" | "production" | "financial" | "credential" | "destructive";
        humanApproval?: {
          approvedBy: string;
          approvedAt: string;
        };
      };
    };
    /** One bounded, attributable receipt for an executed or refused delegated use (src/lib/automation-action.ts's `DelegationReceipt`). Identity fields are capped at 200 characters and `reason` at 240, each plus a trailing ellipsis when cut. */
    DelegationReceipt: {
      receiptId: string;
      envelopeId: string;
      parentReceiptId?: string;
      capability: string;
      audience: string;
      actorIdentity: string;
      decidedAt: string;
      outcome: "executed" | "refused";
      code?: DelegationRefusalCode;
      reason: string;
    };
    /** Every reason a delegation step can be refused for (src/lib/automation-action.ts's `DelegationRefusalCode`). */
    DelegationRefusalCode: "unknown-envelope" | "expired" | "revoked" | "parent-revoked" | "identity-mismatch" | "already-accepted" | "empty-acceptance" | "capability-widened" | "expiry-widened" | "not-accepted" | "wrong-audience" | "capability-not-accepted" | "replayed-nonce" | "human-gate-required" | "audit-unavailable";
    OperatorAgentDelegationHandoffResult: {
      ok: true;
      receipt: DelegationReceipt;
    };
    /** A refused handoff, in one of two shapes: refused at the recipient's acceptance step (`stage: accept`, `code`, `detail`; no receipt), or refused at execution (`receipt`, whose `outcome` is `refused` and whose `code` names why). */
    OperatorAgentDelegationHandoffRefusal: {
      ok: false;
      stage?: "accept";
      code?: DelegationRefusalCode;
      detail?: string;
      receipt?: DelegationReceipt;
    };
    FollowUpQuietHours: {
      timezone: string;
      start: string;
      end: string;
    };
    FollowUpNotificationPolicy: {
      enabled: boolean;
      quietHours?: FollowUpQuietHours;
    };
    /** A bounded follow-up candidate. It must carry a deadline or dependency and exactly one next action or question. */
    FollowUpCandidate: {
      version: "follow-up-policy-v1";
      candidateId: string;
      sourceEvent: string;
      workstream: string;
      reason: string;
      freshness: "verified" | "stale" | "unavailable";
      deadline?: string;
      dependency?: string;
      quietHours?: FollowUpQuietHours;
      deduplicationKey: string;
      maxAttempts: number;
      owner: string;
      nextAction?: string;
      nextQuestion?: string;
      createdAt: string;
    };
    FollowUpReceipt: {
      delivered: boolean;
      answered?: boolean;
      systemActed: boolean;
      authority?: string;
      completed: false;
      permissionToAct: boolean;
      at: string;
    };
    FollowUpHistory: {
      version: "follow-up-policy-v1";
      candidateId: string;
      sourceEvent: string;
      workstream: string;
      reason: string;
      freshness: "verified" | "stale" | "unavailable";
      deadline?: string;
      dependency?: string;
      quietHours?: FollowUpQuietHours;
      deduplicationKey: string;
      maxAttempts: number;
      owner: string;
      nextAction?: string;
      nextQuestion?: string;
      createdAt: string;
      state: "scheduled" | "eligible" | "snoozed" | "suppressed" | "asked" | "accepted" | "rejected" | "expired" | "blocked";
      attempts: number;
      events: (Record<string, never>)[];
      receipt?: FollowUpReceipt;
      notificationPolicy?: FollowUpNotificationPolicy;
      snoozedUntil?: string;
    };
    FollowUpList: {
      followUps: (FollowUpHistory)[];
      source: "ledger";
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
    ExternalEffectPostcondition: {
      path: string;
      /** JSON value expected at the connector path. */
      equals: Record<string, never>;
      description?: string;
    };
    ExternalEffect: {
      version: "external-effect-v1";
      originatingActionId: string;
      originatingReceiptId: string;
      capabilityGrantId: string;
      connector: string;
      targetIdentity: string;
      requestedOperation: string;
      preconditionSnapshot: Record<string, never>;
      expectedPostconditions: (ExternalEffectPostcondition)[];
      observedState?: Record<string, never>;
      observation: {
        status: "fresh" | "stale" | "unavailable";
        observedAt?: string;
        ageMs?: number;
        maxAgeMs: number;
      };
      idempotencyKey: string;
      reconciliationState: "applied" | "refused" | "pending" | "partially-applied" | "drifted" | "stale" | "unobservable";
      partialSuccess?: {
        satisfied: (string)[];
        unsatisfied: (string)[];
      };
      retryPath: {
        kind: "none" | "retry" | "compensation";
        allowed: boolean;
        reason: string;
        attemptNumber?: number;
      };
      /** Opaque digest of redacted connector evidence; raw provider output is never stored. */
      evidenceReference: string;
      safeToComplete: boolean;
      reason?: string;
    };
    /** The bounded provider-auth-v1 browser projection. Provider credentials, credential homes, raw app-server payloads, and transcripts never cross this boundary. */
    ProviderAuthProjection: {
      version: "provider-auth-v1";
      sessionId: string;
      provider: "claude" | "codex";
      profileId: string | null;
      label: string | null;
      state: "unavailable" | "unsupported" | "awaiting_browser" | "complete" | "failed" | "expired" | "cancelled";
      authUrl: string | null;
      expiresAt: string;
      reason?: string;
    };
    ProviderAuthStartRequest: {
      provider: "claude" | "codex";
      /** Opaque server-configured provider profile id; never a credential or path. */
      profileId: string;
    };
    BenchmarkQualityCoverage: {
      denominator: number;
      observed: number;
      noTerminal: number;
      notRecorded: number;
    };
    /** Internal evidence coverage, not a causal model score or public release. Local assignment and run identifiers are join keys only and never appear in this response. API request estimates and subscription notional amounts are separate; neither is an invoice. */
    BenchmarkQualityProjection: {
      version: "benchmark-quality-v1";
      state: "observed" | "unavailable";
      reason?: string;
      asOf: string | null;
      latestSourceAt: string | null;
      sourceRows: {
        assignments: number;
        terminals: number;
        invalidAssignments: number;
        terminalsWithoutAssignmentId: number;
      };
      assignments: number;
      joinedTerminalOutcomes: number;
      assignmentsWithoutTerminal: number;
      terminalsWithoutAssignment: number;
      duplicates: {
        assignmentRows: number;
        terminalRows: number;
      };
      outcomes: {
        success: number;
        failure: number;
        unavailable: number;
      };
      modelEvidence: {
        requestedDifferentFromSelected: number;
        servedDifferentFromSelected: number;
      };
      experimentalCrossover: "unavailable-no-random-allocation-receipt";
      coverage: {
        taskClass: BenchmarkQualityCoverage;
        risk: BenchmarkQualityCoverage;
        requestedModel: BenchmarkQualityCoverage;
        selectedModel: BenchmarkQualityCoverage;
        provider: BenchmarkQualityCoverage;
        effort: BenchmarkQualityCoverage;
        outcome: BenchmarkQualityCoverage;
        servedModel: BenchmarkQualityCoverage;
        tokens: BenchmarkQualityCoverage;
        duration: BenchmarkQualityCoverage;
        billingMode: BenchmarkQualityCoverage;
        cost: BenchmarkQualityCoverage;
      };
      accounting: {
        source: "worker-result-estimate-not-invoice";
        apiRequestsWithCost: number;
        apiRequestCostUsd: number;
        subscriptionCallsWithNotionalCost: number;
        subscriptionNotionalCostUsd: number;
        unclassifiedCostRows: number;
      };
    };
    /** The data-status envelope the console read cache splices into every JSON object body a CACHED read route serves (src/lib/console-snapshot-cache.ts's `ConsoleResponseStaleness`, applied by src/lib/serve.ts's `boundConsoleReadRoute` to GET /v1/recent and GET /v1/daemon-health among others). The same facts ride the `x-rmd-cache-state`, `x-rmd-cache-age-ms` and `x-rmd-generated-at` response headers. */
    ConsoleResponseStaleness: {
      /** The body's own data-status. `unavailable` means no live computation has produced a snapshot yet and the body is the route's documented fallback. */
      status: "fresh" | "stale" | "unavailable";
      stale: boolean;
      /** Milliseconds since the served snapshot was computed; null when none exists. */
      ageMs: number | null;
      /** When the served snapshot was computed; null when none exists. */
      generatedAt: string | null;
      /** A background recomputation is in flight. */
      refreshing: boolean;
      /** The request-path budget the cache waited before answering from a fallback. */
      budgetMs: number;
      /** Why the snapshot is stale or unavailable, when a cause was observed. */
      reason?: string;
    };
    /** One Claude usage window (src/lib/account-usage.ts's `UsageWindowReading`). An absent `percentUsed` means UNKNOWN, never 0. */
    UsageWindowReading: {
      percentUsed?: number;
      resetsAt?: string;
    };
    /** GET /v1/account-usage's body (src/lib/account-usage.ts's `AccountUsageSnapshot`, built by `deriveAccountUsage`). Every value field is ABSENT, never zero, when its source could not be read. Identity fields come from `~/.claude.json`'s `oauthAccount` and never carry a credential. */
    AccountUsageSnapshot: {
      accountEmail?: string;
      accountUuid?: string;
      accountOrg?: string;
      fiveHour?: UsageWindowReading;
      sevenDay?: UsageWindowReading;
      /** The usage reading's own as-of. Absent iff `usageUnknownReason` is present. */
      usageAsOf?: string;
      usageAgeMs?: number;
      /** Why the usage windows are UNKNOWN; absent when the reading is good. */
      usageUnknownReason?: "unreadable" | "no-cache" | "account-mismatch" | "too-old";
      /** Exactly one of `creditState` / `creditUnknownReason` is present. */
      creditState?: "subscription" | "credits";
      creditUnknownReason?: "not-exposed" | "unrecognised-value";
      /** Which `~/.claude.json` field the credit state was read from, when one was found. */
      creditStateField?: string;
      /** The headroom governor's posture per the newest `daemon.headroom` ledger line. */
      governor: "armed" | "telemetry-only" | "unknown";
      governorAsOf?: string;
      governorAgeMs?: number;
      /** `deferred` only while a `daemon.cost_governor` line says dispatch is being held; absent evidence reads `unknown`, never healthy. */
      costGovernor: "deferred" | "unknown";
      costGovernorAsOf?: string;
      costGovernorAgeMs?: number;
      costGovernorObservedUsd?: number;
      costGovernorCeilingUsd?: number;
      queueGovernor: "deferred" | "unknown";
      queueGovernorAsOf?: string;
      queueGovernorAgeMs?: number;
      queueGovernorObservedOpenCount?: number;
      queueGovernorWipLimit?: number;
      dailyCostCeilingUsd?: number;
      dailyCostCeilingProvenance?: "overridden" | "default" | "instance-share";
      dailyCostCeilingDefaultUsd?: number;
      dailyCostCeilingFallbackReason?: string;
      dailyCostCeilingAuditAsOf?: string;
      dailyCostCeilingAuditWho?: string;
      dailyCostCeilingAuditFromUsd?: number;
      dailyCostCeilingAuditToUsd?: number;
      dailyCostCeilingAuditEffectiveUsd?: number;
      /** The scope note carried in the payload so a render can never drop it. */
      measures: string;
    };
    /** GET /v1/control/status's body (src/lib/panel-actions.ts's `FleetControlStatus`): the Pause/Resume/STOP/quiet-hours button states derived from the fleet-control flag files, plus heartbeat evidence of whether the daemon is actually running. */
    FleetControlStatus: {
      paused: boolean;
      /** Human-readable detail, present only while paused. */
      pauseDetail?: string;
      stopped: boolean;
      /** Human-readable detail, present only while stopped. */
      stopDetail?: string;
      quietHours: boolean;
      /** Whether a `daemon.*` heartbeat falls inside the liveness bound. OMITTED, never a fabricated false, when the ledger gives no evidence either way. */
      daemonLive?: boolean;
      /** The evidence behind `daemonLive`, always present. `fresh-poll` -> live; `last-poll-stale` and `no-daemon-activity` -> not live; `ledger-empty`, `ledger-absent` and `ledger-unreadable` -> `daemonLive` omitted. */
      daemonLiveReason: "fresh-poll" | "last-poll-stale" | "no-daemon-activity" | "ledger-empty" | "ledger-absent" | "ledger-unreadable";
    };
    /** The serve process's own event-loop delay over a rolling one-minute window (src/lib/daemon-health.ts's `EventLoopLag`). */
    EventLoopLag: {
      p50Ms: number;
      p99Ms: number;
      maxMs: number;
      windowMs: number;
    };
    /** One `/proc/pressure/<resource>` reading, percent of wall time (src/lib/daemon-health.ts's `PressureReading`). */
    PressureReading: {
      someAvg10: number;
      someAvg60: number;
      fullAvg10?: number;
    };
    /** The host's PSI pressure per resource (src/lib/daemon-health.ts's `HostPressure`). A resource whose pressure file is absent or unparsable reads the literal `"unknown"`, never 0. */
    HostPressure: {
      cpu: (PressureReading) | ("unknown");
      io: (PressureReading) | ("unknown");
      memory: (PressureReading) | ("unknown");
    };
    /** The serve checkout's own freshness, the SAME reading the stale-code restart decision acts on (src/lib/daemon-health.ts's `GatewayCheckoutState`). Each field reads the literal `"unknown"` until it has been checked. */
    GatewayCheckoutState: {
      /** The checkout's HEAD sha, or `unknown`. */
      head: string;
      behindBy: (number) | ("unknown");
      dirty: (boolean) | ("unknown");
      dirtyPaths?: (string)[];
      /** ISO-8601 time of the check, or `unknown`. */
      checkedAt: string;
      detail?: string;
    };
    /** GET /v1/daemon-health's body (src/lib/daemon-health.ts's `DaemonHealthSnapshot`). Every field whose own source could not be read is ABSENT, never a placeholder. `hostPressure` and `gatewayCheckout` are always sent by the live handler; they are optional here because the console read cache's fallback body (src/lib/serve.ts's `fallbackBodyForCachedRead`, served before any live snapshot exists) carries only `pollIntervalMs` and `staleness`. */
    DaemonHealthSnapshot: {
      lastPollTs?: string;
      lastPollAgeMs?: number;
      pollIntervalMs: number;
      /** `lastPollTs + pollIntervalMs`; absent with no `lastPollTs`. */
      nextPollAt?: string;
      diskFreeBytes?: number;
      rateLimitRemaining?: number;
      eventLoopLag?: EventLoopLag;
      hostPressure?: HostPressure;
      gatewayCheckout?: GatewayCheckoutState;
      staleness?: ConsoleResponseStaleness;
    };
    /** One fix-verification lifecycle record as GET /v1/incidents projects it (src/lib/incident-lifecycle.ts's `IncidentWire`). */
    IncidentRecord: {
      fingerprint: string;
      title: string;
      source: "console" | "gateway" | "daemon";
      kind: "exception" | "http_5xx" | "latency" | "invariant";
      status: "new" | "filed" | "building" | "deployed" | "verified" | "regressed";
      firstSeen: string;
      lastSeen: string;
      count24h: number;
      feedbackId: string | null;
      pr: number | null;
    };
    /** GET /v1/incidents's body -- the lifecycle store, newest `lastSeen` first. */
    IncidentsResult: {
      incidents: (IncidentRecord)[];
      generatedAt: string;
    };
    /** GET /v1/incidents's 503 -- the lifecycle store exists but could not be read, reported as an error rather than the `200 {incidents: []}` a quiet fleet returns. */
    IncidentsUnavailable: {
      error: "incidents_unavailable";
      /** `malformed` or `unreadable` from the production store reader. */
      reason: string;
    };
    /** One reported stack frame -- file and function only; a line number is never part of the wire shape. */
    IncidentEventFrame: {
      file: string;
      fn: string;
    };
    /** POST /v1/incidents/events's body (src/lib/incident-events.ts's `IncidentEventInput`, validated by `validateIncidentEventBody`). At most 16 KiB. The daemon scrubs `message` and `route` (query/fragment stripped; token, email and uuid shapes redacted) and caps `message` at 500 characters and `frames` at 20 before anything is fingerprinted or stored. */
    IncidentEventRequest: {
      source: "console" | "gateway" | "daemon";
      kind: "exception" | "http_5xx" | "latency" | "invariant";
      name: string;
      message: string;
      frames?: (IncidentEventFrame)[];
      route?: string;
      sha?: string;
      /** An ISO date string (any value `Date.parse` accepts). */
      at: string;
    };
    /** POST /v1/incidents/events's answer. `sampled` is true once the fingerprint has passed the per-minute cap; a sampled event writes at most one `incident.sampled` row per window. */
    IncidentEventResult: {
      fingerprint: string;
      accepted: true;
      sampled: boolean;
    };
    /** POST /v1/incidents/events's 413 -- the raw body exceeded 16 KiB and was not read further. */
    IncidentIngestBodyTooLarge: {
      error: "body_too_large";
    };
    /** One of the eight onboarding checks (src/lib/onboarding-readiness.ts's `OnboardingReadinessCheck`). */
    OnboardingReadinessCheck: {
      id: "app-access" | "default-branch" | "branch-protection" | "ci-workflows" | "agent-instructions" | "test-command" | "plan-layout" | "already-onboarded";
      /** `unknown` only when the read could not be completed, never for a definitive GitHub answer. */
      status: "pass" | "warn" | "fail" | "unknown";
      reason: string;
      evidence?: string;
    };
    /** GET /v1/onboarding/readiness's body (src/lib/onboarding-readiness.ts's `OnboardingReadinessReport`): each check independently pass/warn/fail/unknown, never one verdict hiding which check said what. */
    OnboardingReadinessReport: {
      /** `owner/name`. */
      repo: string;
      checks: (OnboardingReadinessCheck)[];
    };
    /** GET /v1/peek's body (src/lib/serve.ts's `buildPeekRoute`): the tail of one run's `state/runs/<runId>.tail`, at most 500 lines and 64 KiB. A missing or unreadable tail is `found: false` with a named `reason`, never a silent empty body. */
    PeekResult: {
      runId: string;
      /** Whether the run is in flight, per the daemon's own live-run reader. */
      live: boolean;
      found: boolean;
      lines: (string)[];
      /** Present only when `found` is false. */
      reason?: string;
    };
    /** Whole-plan task counts derived from GitHub, never the plan's decorative `status:` field (src/lib/panel-graph.ts's `PlanProgress`). Under `unknown` the last observed reading is carried forward with its `asOf`; the counts are absent only on a first reading taken during an outage. */
    PlanProgress: {
      done?: number;
      inFlight?: number;
      queued?: number;
      total?: number;
      unknown: boolean;
      asOf?: string;
      unavailableReason?: string;
    };
    /** One MASTER-PLAN section's filed/merged pair (src/lib/panel-graph.ts's `PlanSectionCount`). */
    PlanSectionCount: {
      heading: string;
      filed: number;
      merged: number;
    };
    /** One frontier row in the dispatcher's own order (src/lib/panel-graph.ts's `FrontierRow`). */
    FrontierRow: {
      id: string;
      title: string;
      runnable: boolean;
      /** The TypeScript union also names `verify-human`, but `buildPlanFrontier` excludes those tasks from the frontier, so no served row carries it. */
      reasonKind: "file-order" | "unmet-dependency" | "circuit-breaker" | "blocked";
      reason: string;
    };
    /** GET /v1/plan/view's body -- progress, per-section counts and the frontier off one plan projection. */
    PlanViewResult: {
      progress: PlanProgress;
      sections: (PlanSectionCount)[];
      frontier: (FrontierRow)[];
    };
    ProviderRoutingWindowStatus: {
      name: string;
      usedPercent: number;
      resetsAt?: string;
    };
    /** Manual reset readiness -- a count and the earliest expiry only, never a credit id. `earliestExpiresAt` is the provider's own numeric timestamp, passed through unconverted. */
    ProviderRoutingResetCreditsStatus: {
      availableCount: number;
      earliestExpiresAt?: number;
    };
    CodexModelDecisionOptionStatus: {
      id: string;
      displayName?: string;
      supportedEfforts: (string)[];
      accountDefault: boolean;
      mapped: boolean;
      eligible: boolean;
      selected: boolean;
      windows: (ProviderRoutingWindowStatus)[];
      reason?: "unmapped" | "unsupported-effort" | "quota-unreadable" | "below-reserve";
    };
    CodexModelDecisionStatus: {
      requestedCapability: "economy" | "balanced" | "frontier";
      requestedEffort: string;
      mappedCandidates: (string)[];
      options: (CodexModelDecisionOptionStatus)[];
      selectedModel?: string;
      selectedEffort?: string;
      preferredModel?: string;
      preferenceBypass?: "unmapped" | "unsupported-effort" | "quota-unreadable" | "below-reserve" | "not-visible";
    };
    ProviderRoutingProviderStatus: {
      provider: "claude" | "codex" | "cash" | "openweight";
      readable: boolean;
      windows: (ProviderRoutingWindowStatus)[];
      allocationWindows?: (ProviderRoutingWindowStatus)[];
      reason?: "capacity-unreadable" | "authentication-unavailable" | "capacity-unavailable";
      accountLabel?: string;
      model?: string;
      effort?: string;
      modelDecision?: CodexModelDecisionStatus;
      resetCredits?: ProviderRoutingResetCreditsStatus;
    };
    ProviderRoutingSelectedStatus: {
      provider: "claude" | "codex" | "cash" | "openweight";
      tightestRemainingPercent: number;
      allocationWeight?: number;
      allocationSharePercent?: number;
      accountLabel?: string;
      model?: string;
      effort?: string;
    };
    ProviderRoutingModelHealthStatus: {
      requestedModel?: string;
      routedModel?: string;
      state: "healthy" | "degraded" | "unknown";
      source: "fresh" | "stale" | "unknown";
      eligible: boolean;
    };
    ProviderPark: {
      provider: "claude" | "codex" | "cash" | "openweight";
      until: string;
    };
    CodexModelPreference: {
      capability: "economy" | "balanced" | "frontier";
      effort: string;
      model: string;
    };
    /** The committed host policy an override is measured against (src/lib/provider-routing-policy.ts's `CommittedProviderRoutingPolicy`). */
    ProviderRoutingCommittedPolicy: {
      enabledProviders: ("claude" | "codex" | "cash" | "openweight")[];
      preference: "automatic";
      reservePercent: number;
      /** Always empty -- the committed policy parks nothing. */
      parks: (ProviderPark)[];
      /** Always null -- the committed policy states no model preference. */
      codexModelPreference: null;
    };
    /** The effective provider-routing policy (src/lib/provider-routing-policy.ts's `EffectiveProviderRoutingPolicy`). GET /v1/provider-routing re-resolves it live on every request, so a console write, expiry or clear is visible before the next dispatch. */
    ProviderRoutingPolicyStatus: {
      provenance: "default" | "overridden";
      committed: ProviderRoutingCommittedPolicy;
      enabledProviders: ("claude" | "codex" | "cash" | "openweight")[];
      /** Enabled providers after active parks are applied. */
      routableProviders: ("claude" | "codex" | "cash" | "openweight")[];
      preference: "automatic" | "claude" | "codex" | "cash" | "openweight";
      reservePercent: number;
      parks: (ProviderPark)[];
      codexModelPreference?: CodexModelPreference;
      overrideExpiresAt?: string;
      writtenAt?: string;
      writerFingerprint?: string;
      /** Present only when a stored override was refused and the committed policy was used instead. */
      fallback?: {
        reason: "unreadable" | "malformed" | "unsupported-version" | "expired" | "incompatible-with-config";
      };
    };
    ProviderRoutingPreferenceBypass: {
      provider: "claude" | "codex" | "cash" | "openweight";
      reason: "unreadable" | "below-reserve";
    };
    /** GET /v1/provider-routing's body: the daemon's last provider-routing decision as the daemon wrote it to `state/provider-routing-status.json` (src/lib/provider-routing-status.ts's `ProviderRoutingStatus`, projected field by field by `readProviderRoutingStatus`), with `policy` overlaid by a live resolution. The console process never probes a provider. */
    ProviderRoutingStatus: {
      version: number;
      state: "unknown" | "not-probed" | "selected" | "blocked";
      freshness: "fresh" | "stale" | "not-probed" | "unknown";
      /** Why the status is `unknown`. */
      reason?: "absent" | "unreadable" | "malformed" | "unsupported-version";
      enabledProviders?: ("claude" | "codex" | "cash" | "openweight")[];
      reservePercent?: number;
      observedAt?: string;
      freshUntil?: string;
      providers?: (ProviderRoutingProviderStatus)[];
      selected?: ProviderRoutingSelectedStatus;
      blockedReason?: "no-provider-headroom";
      modelHealth?: ProviderRoutingModelHealthStatus;
      policy?: ProviderRoutingPolicyStatus;
      preferenceBypass?: ProviderRoutingPreferenceBypass;
    };
    /** One RECENT feed row minted from a ledger line (src/lib/board.ts's `RecentActivityEntry`). */
    RecentActivityEntry: {
      taskId: string;
      runId?: string;
      title: string;
      verb: "merged" | "verdict" | "fix" | "escalated" | "spend" | "run-refused" | "run-started" | "worker";
      /** The originating ledger line's own `ts`. */
      ts: string;
      detail?: string;
      costUsd?: number;
      numTurns?: number;
      prNumber?: number;
      prUrl?: string;
      eventKind?: "working" | "tool-executing" | "message";
      eventAt?: string;
      workerRole?: "recon" | "implementer" | "reviewer" | "fixer" | "triage" | "retro" | "unknown";
      provider?: string;
      requestedModel?: string;
      servedModel?: string;
      turnsSoFar?: number;
      toolName?: string;
      toolReason?: string;
      toolStartedAt?: string;
      toolCompletedAt?: string;
      toolDurationMs?: number;
      toolOutcome?: "success" | "error";
      /** GitHub decoration, present only when a read resolved it. */
      prTitle?: string;
      /** Present only when GitHub decoration was attempted and failed for this row. */
      githubUnavailable?: true;
    };
    /** GET /v1/recent's body -- at most 20 entries, newest first. */
    RecentActivityResult: {
      entries: (RecentActivityEntry)[];
      staleness?: ConsoleResponseStaleness;
    };
    /** One `measurement_cadence.ran` ledger row (src/lib/measurement-cadence.ts's `MeasurementCadenceRowEntry`). `result` is keyed by cadence verb (camelCased) and each value is that verb's SUMMARY (`summarizeMeasurementValue`): scalars, short strings and array counts. The verb set grows with the cadence, so the map is genuinely open. */
    SelfMeasurementRow: {
      ts: string;
      result: Record<string, unknown>;
    };
    /** The newest measurement rows, newest first. */
    SelfMeasurementRows: {
      status: "ok";
      rows: (SelfMeasurementRow)[];
    };
    /** The ledger union could not be read in full (no archive at all, or an unopenable rotation) -- never answered as an empty "never measured". */
    SelfMeasurementUnreadable: {
      status: "unreadable";
      reason: string;
    };
    /** `?detail=<verb>`: that verb's FULL report from the newest row carrying it. `value` is whatever that verb recorded, un-summarized, so its shape is the verb's own. */
    SelfMeasurementDetail: {
      verb: string;
      ts: string;
      value: unknown;
    };
    /** One plan acceptance criterion (src/lib/plan.ts's `AcceptanceCriterion`). */
    AcceptanceCriterion: {
      claim: string;
      proof: string;
      satisfied_by?: string;
      holdout?: boolean;
    };
    /** One owned run in a task card's history -- read from the ledger, no GitHub call. */
    TaskCardRun: {
      runId: string;
      verdict?: string;
      costUsd?: number;
      prUrl?: string;
    };
    /** The row-click task card (src/lib/task-card.ts's `TaskCard`). */
    TaskCard: {
      id: string;
      title: string;
      rationale?: string;
      acceptance: (AcceptanceCriterion)[];
      dependsOn: (string)[];
      /** The GitHub-derived projection's status, falling back to the plan's own only when no projection resolved. */
      status: "queued" | "recon" | "prompted" | "running" | "review" | "fixing" | "diagnosing" | "blocked" | "merged" | "done";
      merged: boolean;
      prNumber?: number;
      prUrl?: string;
      runs: (TaskCardRun)[];
    };
    TaskCardResult: {
      card: TaskCard;
    };
    /** GET /v1/version's body -- the console sha captured at server start, and nothing else. */
    VersionResult: {
      sha: string;
    };
    /** One option on an inbox item's plain message (src/lib/inbox-plain.ts's `PlainOption`). */
    PlainOption: {
      label: string;
      consequence: string;
    };
    /** W1-T4087: an inbox item's plain-language message (src/lib/inbox-plain.ts's `PlainInboxMessage`) -- the model writer's text when it passed the plain-message check, otherwise the item kind's template. The raw proposal summary is never promoted to it. */
    PlainInboxMessage: {
      /** 15 words or fewer. */
      headline: string;
      whatHappened: string;
      /** What the daemon needs from the operator, as an instruction. */
      whatWeNeed: string;
      /** What happens if nobody acts. */
      ifNothingHappens: string;
      /** Two or three options. */
      options: (PlainOption)[];
      /** Who wrote it -- the model writer or the per-kind template. */
      source: "writer" | "template";
    };
    /** One task a READY proposal's drafted fragment would file (src/lib/panel-graph.ts's `InboxDraftedTask`). */
    InboxDraftedTask: {
      id: string;
      title: string;
    };
    /** One failing readiness predicate `classifyProposal` named for a not-ready proposal (src/lib/inbox.ts's `PredicateFailure`) -- never a bare "not ready". */
    InboxPredicateFailure: {
      predicate: "drafted" | "deps_merged" | "deps_observable" | "evidence_anchors" | "lint_clean" | "no_conflict";
      detail: string;
    };
    /** One READY-to-ratify proposal (src/lib/panel-graph.ts's `InboxReadyItem`); the drafted tasks ride along so the operator sees exactly what APPROVE would file. */
    InboxReadyItem: {
      proposalId: string;
      /** The raw proposal summary (the console's Details). */
      summary: string;
      plain: PlainInboxMessage;
      /** The drafted fragment's stamp line, when the draft carries one. */
      stampLine?: string;
      draftedTasks: (InboxDraftedTask)[];
    };
    /** One proposal an Architect worker is drafting right now (src/lib/panel-graph.ts's `InboxDraftingItem`). */
    InboxDraftingItem: {
      proposalId: string;
      summary: string;
      plain: PlainInboxMessage;
      /** When the drafting worker was spawned; an empty string when unrecorded. */
      spawnedAt: string;
    };
    /** W1-T2604: one not-ready proposal with the exact predicate failures that hold it (src/lib/panel-graph.ts's `InboxNotReadyItem`). Carries no affordance. */
    InboxNotReadyItem: {
      proposalId: string;
      summary: string;
      plain: PlainInboxMessage;
      reasons: (InboxPredicateFailure)[];
    };
    /** W1-T3408: one DECLINED proposal (src/lib/panel-graph.ts's `InboxDeclinedItem`), so POST /v1/inbox/restore's argument is discoverable. Nothing here is actionable except restore. */
    InboxDeclinedItem: {
      proposalId: string;
      summary: string;
      plain: PlainInboxMessage;
      /** The latest `panel.proposal_declined` row's reason, verbatim. */
      reason: string;
    };
    /** W1-T4086: the operator-owned subset of each lane (`inboxOwner(...) === "operator"`), built by GET /v1/inbox's handler from the same four arrays. */
    InboxNeedsYou: {
      ready: (InboxReadyItem)[];
      drafting: (InboxDraftingItem)[];
      notReady: (InboxNotReadyItem)[];
      declined: (InboxDeclinedItem)[];
    };
    /** W1-T4086/W1-T4089: one fleet-owned proposal with the lane it sits in and the fleet lane's latest decision, when it has made one (src/lib/panel-graph.ts's `InboxFleetItem`). */
    InboxFleetItem: {
      proposalId: string;
      summary: string;
      plain: PlainInboxMessage;
      lane: "ready" | "drafting" | "notReady" | "declined";
      /** The fleet lane's latest decision (src/lib/fleet-lane.ts's `FleetLaneDecision`). */
      decision?: "file" | "merge";
      /** That decision's plain reason; present exactly when `decision` is. */
      reason?: string;
    };
    /** GET /v1/inbox's body (src/lib/panel-graph.ts's `buildInboxRoute`). Deferred, ratified and retired proposals are never returned. The four top-level lanes hold every owner's items; `needsYou` and `fleet` split them by who must act. `declined`, `needsYou` and `fleet` are optional ONLY because the console cache's cold fallback body (serve.ts's `fallbackBodyForCachedRead`) carries just `ready`, `drafting` and `notReady`; every handler-computed body carries all six. */
    InboxResult: {
      ready: (InboxReadyItem)[];
      drafting: (InboxDraftingItem)[];
      notReady: (InboxNotReadyItem)[];
      declined?: (InboxDeclinedItem)[];
      needsYou?: InboxNeedsYou;
      fleet?: (InboxFleetItem)[];
      staleness?: ConsoleResponseStaleness;
    };
    /** One stored daily digest (src/lib/serve.ts's `ConsoleInboxDigestEntry`). */
    InboxDigestEntry: {
      ts: string;
      text: string;
    };
    /** GET /v1/inbox/digests's body (src/lib/serve.ts's `ConsoleInboxDigests`) -- the newest digests, up to the render window (`CONSOLE_INBOX_DIGEST_LIMIT`, 10), oldest first. */
    InboxDigestsResult: {
      entries: (InboxDigestEntry)[];
      /** Valid entries older than the render window that were left out. */
      omitted: number;
      /** Present only when the digest store could not be read or parsed; `entries` is then empty. A missing store is not an error and carries no reason. */
      reason?: string;
    };
    /** An action an inbox thread offers or records (src/lib/inbox-thread.ts's `InboxThreadAction`). */
    InboxThreadAction: "approve" | "decline" | "edit" | "restore";
    /** What the daemon's responder did on a thread, and how to undo it. */
    InboxThreadActionTaken: {
      action: InboxThreadAction;
      undo?: string;
    };
    /** A stored thread message's structured extras (src/lib/inbox-thread.ts's `ThreadMessageExtra`). */
    InboxThreadMessageExtra: {
      did?: InboxThreadActionTaken;
      suggestedAction?: InboxThreadAction;
      /** The message is one of the responder's bounded clarifying questions. */
      question?: boolean;
      /** The operator display name a reply was sent under (audit only). */
      operator?: string;
      /** The idempotency id POST /v1/inbox/thread/reply stored the reply under. */
      replyId?: string;
    };
    /** One message on an inbox thread (src/lib/inbox-responder.ts's `ThreadMessageView`). Message `seq` 0 is the opening message, derived on read from the item's plain message and never stored; it alone carries `plain` and `actions`. */
    InboxThreadMessage: {
      seq: number;
      from: "daemon" | "operator";
      text: string;
      /** Epoch milliseconds; null on the derived opening message. */
      ts: number | null;
      plain?: PlainInboxMessage;
      /** On the opening message -- the actions the item's current state allows. */
      actions?: (InboxThreadAction)[];
      extra?: InboxThreadMessageExtra;
    };
    /** One operator thread in GET /v1/inbox/threads (src/lib/inbox-responder.ts's `ThreadSummaryView`). A declined item is listed only once someone has written on its thread. */
    InboxThreadSummary: {
      /** `thread:<proposalId>::inbox::-::-` (src/lib/inbox-thread.ts's `inboxThreadId`). */
      threadId: string;
      proposalId: string;
      /** The item's plain headline. */
      headline: string;
      /** The latest message's first sentence, at most 160 characters. */
      snippet: string;
      /** `daemon` when the operator wrote last, otherwise `operator`. */
      waitingOn: "operator" | "daemon";
      /** The latest message's epoch milliseconds; null when only the derived opening message exists. */
      lastActivity: number | null;
      /** Messages including the derived opening message. */
      messageCount: number;
      /** The daemon wrote last and the read mark is behind that message. */
      unread: boolean;
    };
    /** GET /v1/inbox/threads's body -- waiting-on-you first, then most recent activity. */
    InboxThreadsResult: {
      threads: (InboxThreadSummary)[];
    };
    /** GET /v1/inbox/thread's body (src/lib/inbox-responder.ts's `ThreadDetailView`, which extends `ThreadSummaryView`; flattened here because this generator's subset has no allOf). */
    InboxThreadDetail: {
      threadId: string;
      proposalId: string;
      headline: string;
      snippet: string;
      waitingOn: "operator" | "daemon";
      lastActivity: number | null;
      messageCount: number;
      unread: boolean;
      /** The raw proposal summary, for the console's Details. */
      details: string;
      /** Oldest first; `seq` 0 is the derived opening message. */
      messages: (InboxThreadMessage)[];
    };
    /** POST /v1/inbox/thread/reply's body (src/lib/panel-graph.ts's `validateThreadReply`). */
    InboxThreadReplyRequest: {
      /** An inbox thread id, `thread:<proposalId>::inbox::-::-`. */
      threadId: string;
      /** Must be non-blank; stored trimmed. */
      text: string;
      /** Client idempotency key. The same caller token, thread and intentId always derive the same `replyId`, so a retry is answered `duplicate: true` rather than appended twice. */
      intentId?: string;
    };
    /** POST /v1/inbox/thread/reply's 200 body. `delivery: delivered` means the reply is in the thread store; `audit` says separately whether its `inbox.thread_replied` ledger row was written (`recorded`), could not be written (`gap`), or could not be confirmed either way for a duplicate (`unverified`). */
    InboxThreadReplyResult: {
      ok: boolean;
      delivery: "delivered";
      audit: "recorded" | "gap" | "unverified";
      replyId: string;
      threadId: string;
      waitingOn: "daemon";
      /** True when this replyId was already stored with the same text. */
      duplicate: boolean;
    };
    /** A non-2xx body from POST /v1/inbox/thread/reply's handler. `delivery` says whether the reply is known not to be stored (`not_delivered`) or cannot be confirmed (`unverified`). */
    InboxThreadReplyRefusal: {
      error: "not_found" | "reply_store_unavailable" | "reply_intent_conflict" | "reply_in_progress";
      detail?: string;
      delivery?: "not_delivered" | "unverified";
      replyId?: string;
      /** On `reply_intent_conflict` -- the stored reply's id, whose text differs from this one. */
      priorReplyId?: string;
    };
    /** POST /v1/inbox/thread/read's body (src/lib/panel-graph.ts's `validateThreadRead`). */
    InboxThreadReadRequest: {
      threadId: string;
      /** Mark read up to and including this message; must not exceed the thread's last `seq`. */
      seq: number;
    };
    /** A bare acknowledgement: `{ ok: true }`. */
    InboxOkResult: {
      ok: boolean;
    };
    /** POST /v1/inbox/approve's body (src/lib/panel-graph.ts's `validateApproveProposal`). */
    InboxProposalRequest: {
      /** A proposal id from the active registry; must be non-blank. */
      proposalId: string;
    };
    /** POST /v1/inbox/reframe's body (src/lib/panel-graph.ts's `validateReframeProposal`). */
    InboxReframeRequest: {
      proposalId: string;
      /** The operator's feedback, captured verbatim; must be non-blank. */
      feedback: string;
    };
    /** POST /v1/inbox/decline's and POST /v1/inbox/restore's body (src/lib/panel-graph.ts's `validateDeclineProposal`, shared by both). `reason` is required on restore too. */
    InboxVerdictRequest: {
      proposalId: string;
      /** Recorded verbatim on the `panel.proposal_declined` / `panel.proposal_restored` row; must be non-blank. */
      reason: string;
    };
    /** POST /v1/inbox/approve's and POST /v1/inbox/reframe's 200 body. `started` confirms only the hand-off to a detached `rmd approve` / `rmd reframe`; the resulting PR surfaces through the console's own polling. */
    InboxProposalStartedResult: {
      ok: boolean;
      proposalId: string;
      started: boolean;
    };
    /** POST /v1/inbox/decline's 200 body. */
    InboxDeclineResult: {
      ok: boolean;
      proposalId: string;
      declined: boolean;
    };
    /** POST /v1/inbox/restore's 200 body. */
    InboxRestoreResult: {
      ok: boolean;
      proposalId: string;
      restored: boolean;
    };
    /** A handler-level refusal from an inbox route, always with a human-readable `detail`. `not_found` (no active proposal / no current operator thread), `not_ready` (approve of a proposal not currently READY -- detail is `refusalReason`), `already_ratified`, `already_declined`, `not_declined` (src/lib/inbox.ts's `applyProposalVerdict`), `seq_ahead` (a read mark past the last message), `thread_store_unreadable`. */
    InboxRefusal: {
      error: "not_found" | "not_ready" | "already_ratified" | "already_declined" | "not_declined" | "seq_ahead" | "thread_store_unreadable";
      detail: string;
    };
    /** POST /v1/escalation/reply's body (src/lib/panel-actions.ts's `validateEscalationReply`). `taskId`, `class`, `cause` and `prRef` derive the escalation's thread id (`thread:<taskId>::<class>::<cause|->::<prRef|->`, src/lib/inbox-thread.ts's `deriveThreadId`). */
    EscalationReplyRequest: {
      taskId: string;
      class: string;
      cause?: string;
      /** A bare PR number string, as escalate.ts's `extractPrRef` keys it. */
      prRef?: string;
      /** The prose reply; must be non-blank. */
      text: string;
    };
    /** One clarification the reply interpreter asks (src/lib/reply-interpreter.ts's `ClarifyingQuestion`). */
    ClarifyingQuestion: {
      id: string;
      question: string;
      /** What research already established before asking. */
      established: string;
    };
    /** src/lib/reply-interpreter.ts's `InterpretReplyResult`, a union discriminated by `status`, flattened because this generator's subset has no oneOf: `question` is present exactly when `status` is `clarifying`, `unresolved` exactly when it is `exhausted`, and neither when it is `understood`. */
    ReplyInterpretation: {
      status: "understood" | "clarifying" | "exhausted";
      question?: ClarifyingQuestion;
      unresolved?: (ClarifyingQuestion)[];
    };
    /** POST /v1/escalation/reply's 200 body. `feedback` is the entry `captureFeedback` wrote (origin `ui`, keyed to the thread); `interpretation` is what the reply interpreter decided, and a clarifying question or exhaustion report has already been appended to the thread when it is not `understood`. */
    EscalationReplyResult: {
      ok: boolean;
      taskId: string;
      threadId: string;
      feedback: FeedbackEntry;
      interpretation: ReplyInterpretation;
    };
    /** The closed set of routes a signed escalation answer link may name, each at the write tier serve.ts registers for it (src/lib/escalate.ts's `ESCALATION_OPTION_ROUTES`). */
    EscalationOptionRoute: "/v1/manual/approve" | "/v1/drain/kick" | "/v1/drain/run" | "/v1/inbox/approve" | "/v1/skills/run" | "/v1/control/pause" | "/v1/control/resume" | "/v1/control/stop" | "/v1/escalation/mark-handled" | "/v1/questions/answer" | "/v1/drain/feedback" | "/v1/auth/scope";
    /** POST /v1/escalation/answer's 200 body. The answer is recorded as a reply on the escalation's own thread (`answered by link: <route>`); the named route is NOT executed. */
    EscalationLinkAnswerResult: {
      ok: boolean;
      escalationId: string;
      route: EscalationOptionRoute;
    };
    /** A JSON refusal from the signed escalation-link routes (src/lib/escalate.ts's `OptionLinkRefusal` plus the handler's own): `forged` (403, the signature does not verify), `bad-request` / `expired` / `already-used` (410), `invalid_request` (400, no thread store or no existing escalation thread -- the link is NOT consumed), `unavailable` (503, the signing secret could not be resolved). */
    EscalationLinkRefusal: {
      error: "bad-request" | "forged" | "expired" | "already-used" | "invalid_request" | "unavailable";
      detail: string;
    };
    /** The 403 body a HIGH-tier write returns from src/lib/service.ts's dispatch gate, before its handler runs. `forbidden` -- the credential lacks write scope (`required_scope`) or its granted write tier is below HIGH (`required_tier: high`; the bearer write token is pinned at LOW, so only a stepped-up operator session reaches HIGH). `confirm_nonce_required` -- the tier was granted but no `X-Confirm-Nonce` was presented, or the nonce was unknown, expired (5 minutes), already spent, or bound to a different method, path or raw body. W1-T4642 folded W1-T4612's `HighTierForbidden` schema into this one: the two differed only by `consequenceId`. */
    HighTierRefusal: {
      error: "forbidden" | "confirm_nonce_required";
      required_scope?: "read" | "write";
      required_tier?: "low" | "middle" | "high";
      /** Present only on POST /v1/operator-agent/consequences/decision's own missing-nonce refusal, naming the pending consequence it refused. */
      consequenceId?: string;
    };
    /** POST /v1/confirm's body (src/lib/service.ts's `validateConfirmNonceRequest`) -- names the exact HIGH-tier call the returned nonce will authorize. The nonce is consumed only by a request whose method, path and RAW body bytes equal these fields exactly. */
    ConfirmNonceRequest: {
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      /** The target route's path; must start with `/`. */
      path: string;
      /** The exact raw request body the HIGH-tier call will send, byte for byte (an empty string for a call with no body). It is compared verbatim, never JSON-normalised. */
      payload: string;
    };
    /** POST /v1/confirm's 200 body. `nonce` is single-use (a wrong guess spends it too) and expires 5 minutes after issue (src/lib/service.ts's `CONFIRM_NONCE_TTL_MS`). */
    ConfirmNonceResult: {
      /** 48 hex characters; present it as the `X-Confirm-Nonce` header. */
      nonce: string;
    };
    /** POST /v1/drain/feedback's body (src/lib/panel-actions.ts's `validateDrainFeedback`) -- the post-drain rundown's one-tap verdict on one task (W1-T141). */
    DrainFeedbackRequest: {
      taskId: string;
      verdict: "good" | "wrong" | "needs-follow-up";
      drainRunId: string;
      /** W1-T435 steering note, at most 2000 characters (a longer one is a 400, never truncated). Quoted into the next fix-rung dispatch only for `wrong` or `needs-follow-up`. */
      note?: string;
    };
    DrainFeedbackResult: {
      ok: true;
      taskId: string;
      verdict: "good" | "wrong" | "needs-follow-up";
    };
    /** POST /v1/drain/kick's body (src/lib/panel-actions.ts's `validateTaskId`). `taskId` must be a non-empty id safe to embed in a marker filename: `^[A-Za-z0-9][A-Za-z0-9._-]{0,126}$` with no `..` (src/lib/fleet-control.ts's `isSafeTaskId`). */
    KickRequest: {
      taskId: string;
    };
    /** The kick marker was written. `armed` records intent only -- the daemon's own `assertRunnable`-gated dispatch (or refusal) happens at its next poll. */
    KickResult: {
      armed: true;
      taskId: string;
    };
    /** The `DRAIN_REQUESTED` marker was written; the daemon runs one dispatch cycle at its next poll. Records intent only. */
    DrainNowResult: {
      armed: true;
    };
    /** One dependency edge on a drain-preview card (src/lib/drain.ts's `DependencyEdge`). */
    DrainPreviewEdge: {
      id: string;
      /** The linked task's title, or its id when the plan does not carry it. */
      title: string;
    };
    /** One would-drain task card (src/lib/drain.ts's `DrainPreviewCard`, W1-T140). */
    DrainPreviewCard: {
      id: string;
      title: string;
      /** The task's plan `note`, or an empty string when it has none. */
      description: string;
      /** Incoming edges -- this task's own `depends_on`. */
      dependsOn: (DrainPreviewEdge)[];
      /** Outgoing edges -- tasks that DIRECTLY declare this task as a dependency (one hop). */
      dependents: (DrainPreviewEdge)[];
    };
    /** GET /v1/drain/preview's body -- the would-drain queue in dispatch order. */
    DrainPreviewResult: {
      cards: (DrainPreviewCard)[];
    };
    /** POST /v1/feedback/preview's body (src/lib/panel-graph.ts's `validatePreviewFeedback`). `replyTo`, when present, must name a feedback entry parked at `grilling`, the same rule POST /v1/feedback applies. */
    FeedbackPreviewRequest: {
      /** The draft; must be non-blank. */
      text: string;
      /** A feedback entry id; non-blank when present. */
      replyTo?: string;
    };
    /** POST /v1/feedback/preview's 200 body. `expansion` is null when no expander is wired, the expander threw, or its output failed src/lib/feedback.ts's `validateFeedbackExpansion` bounds -- fail-open, since the console files the draft plain. Nothing is filed either way. */
    FeedbackPreviewResult: {
      /** src/lib/feedback.ts's `FeedbackExpansion`. */
      expansion: {
        /** A falsifiable, plain-language headline; at most 300 characters. */
        claim: string;
        /** Only measured/verbatim specifics the operator stated; may be empty; at most 800 characters. */
        evidence: string;
        /** At most 10 directives, each at most 300 characters. */
        recon: (string)[];
        /** What observation would retire this claim; at most 300 characters. */
        falsifying_check: string;
      } | null;
    };
    /** A GitHub webhook delivery body. Its shape is GitHub's and genuinely open-ended per event; the handler reads only the two fields declared here. Anything else is carried through unread except for `check_run` classification (name, conclusion, head sha). */
    GithubWebhookPayload: {
      /** The event's action, when the event has one (`status` does not). */
      action?: string;
      repository?: {
        /** Must equal this daemon's own `owner/repo`, or the delivery is a 403. */
        full_name?: string;
      };
    };
    /** POST /v1/hooks/github's 202 body -- one of four shapes, all a 2xx so GitHub never retries: `{accepted: true}` (the sweep-wake marker was written or coalesced), `{accepted: false, reason: successful_leaf}` (semantic enforce mode: a successful leaf check run, recorded for dedup but no wake), `{duplicate: true}` (this delivery id was already seen; nothing re-written), or `{error: ignored}` (an event/action outside the allowlist; nothing written). */
    GithubWebhookReceipt: {
      accepted?: boolean;
      reason?: "successful_leaf";
      duplicate?: true;
      error?: "ignored";
    };
    /** POST /v1/hooks/github's refusal body (src/lib/github-event-wake.ts's `createGitHubEventWakeHandler`), checked in this order: `webhook_not_configured` (503, no secret configured -- the route ships dark), `body_too_large` (413, over 1 MiB), `invalid_signature` (401), `invalid_json` (400), `repository_mismatch` (403), `missing_delivery_id` (400). */
    GithubWebhookRefusal: {
      error: "webhook_not_configured" | "body_too_large" | "invalid_signature" | "invalid_json" | "repository_mismatch" | "missing_delivery_id";
    };
    /** POST /v1/merge-hold's body (src/lib/panel-actions.ts's `validateConsoleMergeHold`). Unknown fields are refused. There is deliberately no identity field: the recorded `by` is the authenticated caller, never the payload. */
    MergeHoldRequest: {
      action: "engage" | "release";
      /** Non-blank; stored trimmed. */
      reason: string;
      /** A positive integer. Omitted means the whole fleet. */
      prNumber?: number;
      /** A `W1-T<n>` id -- board enrichment only, valid only with `prNumber`. */
      taskId?: string;
    };
    /** The current durable merge hold for a scope (src/lib/review.ts's `AutomergeHold`). */
    AutomergeHold: {
      by: string;
      reason: string;
    };
    /** src/lib/operator-merge-hold.ts's `OperatorMergeHoldResult`. A release of an already-clear scope is an idempotent no-op: `written: false` and neither `prior` nor `current`. */
    MergeHoldResult: {
      action: "engage" | "release";
      /** `the whole fleet` or `PR #<n>`. */
      scope: string;
      written: boolean;
      prior?: AutomergeHold;
      current?: AutomergeHold;
    };
    /** POST /v1/merge-hold's 403 body: the dispatch gate's HIGH-tier refusals (see HighTierRefusal), plus `bearer_provenance_required` from the handler itself when the caller's identity resolves to `unknown`, so no hold is ever written anonymously. */
    MergeHoldRefusal: {
      error: "forbidden" | "confirm_nonce_required" | "bearer_provenance_required";
      required_scope?: "read" | "write";
      required_tier?: "low" | "middle" | "high";
    };
    /** One provenance-stamped operator guidance note (src/lib/operator-notes.ts's `OperatorNoteEntry`). */
    OperatorNote: {
      /** Stamped server-side at write time, never client-supplied. */
      ts: string;
      taskId: string;
      author: string;
      note: string;
    };
    /** GET /v1/operator-notes's body -- only the notes scoped to exactly `taskId`, oldest first; an empty list when none exist. */
    OperatorNotesResult: {
      taskId: string;
      notes: (OperatorNote)[];
    };
    /** POST /v1/operator-notes/add's body (src/lib/operator-notes.ts's `validateAddOperatorNote`). `taskId` must be a safe task id (src/lib/fleet-control.ts's `isSafeTaskId`); `author` and `note` must be non-blank and are stored trimmed. */
    AddOperatorNoteRequest: {
      taskId: string;
      author: string;
      note: string;
    };
    AddOperatorNoteResult: {
      ok: true;
      taskId: string;
      author: string;
      ts: string;
    };
    /** The note store could not be appended to; nothing was ledgered. */
    OperatorNoteWriteFailure: {
      error: "write_failed";
    };
    /** POST /v1/judge-labels's body (src/lib/judge-calibration.ts's `validateJudgeLabelBody`). `verdictRef` must match `JUDGE_VERDICT_REF_RE` (`jv-` and 16 lowercase hex digits, as judge-calibration-v1's `sample[].verdictRef` carries it); `labeller` must be non-blank and is stored trimmed. Any timestamp in the body is ignored. */
    RecordJudgeLabelRequest: {
      verdictRef: string;
      label: "pass" | "fail";
      labeller: string;
    };
    RecordJudgeLabelResult: {
      ok: true;
      verdictRef: string;
      label: "pass" | "fail";
      labeller: string;
      labelledAt: string;
      /** Whether `verdictRef` is in the labelling queue the last analytics refresh drew. `sample-unavailable` when no refresh has drawn one yet. */
      sampleMembership: "in-sample" | "out-of-sample" | "sample-unavailable";
    };
    /** The judge label store could not be read or written; nothing was ledgered. */
    JudgeLabelWriteFailure: {
      error: "write_failed";
    };
    /** POST /v1/policy/daily-cost-ceiling's body. The route adds no bounds check of its own: the store refuses a non-finite value or one outside plan/policy.yaml's `sweep.dailyCostCeilingUsd` bound with a 400, never clamping it. */
    SetDailyCostCeilingRequest: {
      usd: number;
    };
    /** The RESOLVED effective ceiling after the write (src/lib/policy.ts's `resolveDailyCostCeiling`), never the input echoed back. `provenance: default` after a set means the store could not honour it. */
    DailyCostCeilingResult: {
      ok: true;
      usd: number;
      provenance: "overridden" | "default";
      /** plan/policy.yaml's committed default, carried so an override shows what it replaced. */
      committedDefaultUsd: number;
    };
    /** POST /v1/policy/provider-routing's body (src/lib/provider-routing-policy.ts's `ProviderRoutingPolicyOverrideInput`; the store is the one schema authority, so every rule below is a 400 from it). Exactly these keys -- `codexModelPreference` may be omitted (legacy payload, automatic selection). `enabledProviders` is non-empty, duplicate-free and a subset of the committed host config; `preference` is `automatic` or an enabled, unparked provider; `reservePercent` is 0-50; `expiresAt` is a canonical ISO timestamp in the future and at most 24 hours away; each park names an enabled provider once with an `until` in the future and no later than `expiresAt`, and at least one provider stays unparked; a Codex model preference needs Codex enabled and unparked, and must match a fresh, mapped, eligible option in the daemon's Codex model inventory. */
    ProviderRoutingPolicyOverrideRequest: {
      enabledProviders: ("claude" | "codex" | "cash" | "openweight")[];
      preference: "automatic" | "claude" | "codex" | "cash" | "openweight";
      reservePercent: number;
      parks: (ProviderPark)[];
      codexModelPreference?: {
        capability: "economy" | "balanced" | "frontier";
        effort: string;
        model: string;
      } | null;
      expiresAt: string;
    };
    /** The committed host policy an override narrows (src/lib/provider-routing-policy.ts's `CommittedProviderRoutingPolicy`). */
    CommittedProviderRoutingPolicy: {
      enabledProviders: ("claude" | "codex" | "cash" | "openweight")[];
      preference: "automatic";
      reservePercent: number;
      /** Always empty -- the committed policy parks nothing. */
      parks: (ProviderPark)[];
      /** Always null -- the committed policy selects Codex models automatically. */
      codexModelPreference: Record<string, never> | null;
    };
    /** The policy the next dispatch will use (src/lib/provider-routing-policy.ts's `resolveProviderRoutingPolicy`). Every invalid stored state fails closed to the committed config with `provenance: default` and a `fallback.reason`. */
    EffectiveProviderRoutingPolicy: {
      provenance: "default" | "overridden";
      committed: CommittedProviderRoutingPolicy;
      enabledProviders: ("claude" | "codex" | "cash" | "openweight")[];
      /** Enabled providers after active parks are applied. */
      routableProviders: ("claude" | "codex" | "cash" | "openweight")[];
      preference: "automatic" | "claude" | "codex" | "cash" | "openweight";
      reservePercent: number;
      /** Only parks still active at resolution time. */
      parks: (ProviderPark)[];
      codexModelPreference?: CodexModelPreference;
      overrideExpiresAt?: string;
      writtenAt?: string;
      writerFingerprint?: string;
      fallback?: {
        reason: "unreadable" | "malformed" | "unsupported-version" | "expired" | "incompatible-with-config";
      };
    };
    /** The resolved policy after a set or clear; it takes effect on the next dispatch, not in flight. */
    ProviderRoutingPolicyWriteResult: {
      ok: true;
      effective: "next dispatch";
      policy: EffectiveProviderRoutingPolicy;
    };
    /** A provider-routing policy write refused before anything was written or cleared. `invalid_request` (400, the body failed the store's validation), `codex_model_not_eligible` (400, the requested Codex model is not a fresh, mapped, eligible option), `provider_policy_unavailable` (409, the daemon has not published a committed provider-policy projection yet), `codex_model_inventory_stale` (409, a Codex model preference needs a fresh daemon-written model inventory). */
    ProviderRoutingPolicyRefusal: {
      error: "invalid_request" | "codex_model_not_eligible" | "provider_policy_unavailable" | "codex_model_inventory_stale";
      detail?: string;
    };
    /** POST /v1/quiet-hours's body (src/lib/panel-actions.ts's `validateQuietHours`). */
    QuietHoursRequest: {
      enabled: boolean;
    };
    /** The quiet-hours flag as written. */
    QuietHoursResult: {
      quietHours: boolean;
    };
  };
  securitySchemes: {
    /** Read-scoped bearer token. Grants GET access to read-scoped routes and SSE streams. A write-scoped token also satisfies this scope (write is a superset of read). */
    bearerRead: { type: "http"; scheme: "bearer" };
    /** Write-scoped bearer token. Required for any route whose `scope` is `write` (src/lib/service.ts's `Scope`). */
    bearerWrite: { type: "http"; scheme: "bearer" };
    /** W1-T4383 ingest-only bearer token (src/lib/service.ts's `ingestTokenProvider`). Grants exactly POST /v1/incidents/events and falls through to 401 on every other route. */
    bearerIngest: { type: "http"; scheme: "bearer" };
  };
}

export interface paths {
  "/v1/analytics": {
    get: {
      responses: {
          "200": BenchmarkQualityProjection;
          "401": Error;
          "403": Error;
        };
    };
  };
  "/v1/provider-auth": {
    get: {
      responses: {
          "200": ProviderAuthProjection;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
        };
    };
    post: {
      responses: {
          "200": ProviderAuthProjection;
          "400": Error;
          "401": Error;
          "403": Error;
        };
    };
    delete: {
      responses: {
          "200": ProviderAuthProjection;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
        };
    };
  };
  "/v1/onboarding/repositories": {
    get: {
      responses: {
          "200": {
            state: "verified";
            source: "fleet-app-installation" | "daemon-user-token";
            observed_at: string;
            repositories: (string)[];
            total_count: number;
          };
          "401": Error;
          "403": Error;
          "503": {
            state: "unavailable";
            reason: "github_read_failed" | "incomplete_or_invalid_listing";
          };
        };
    };
  };
  "/v1/repos": {
    get: {
      responses: {
          "200": RepoDashboardResult;
          "401": Error;
          "403": Error;
          "404": Error;
        };
    };
  };
  "/v1/registry": {
    get: {
      responses: {
          "200": RegistryResult;
          "401": Error;
          "403": Error;
          "503": RegistryUnavailable;
        };
    };
  };
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
          "403": HighTierRefusal;
          "404": Error;
        };
    };
  };
  "/v1/pr-actions": {
    post: {
      responses: {
          "200": PrActionResult;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
          "409": PrActionSwitchedOff;
        };
    };
  };
  "/v1/escalation/mark-handled": {
    post: {
      responses: {
          "200": MarkEscalationHandledResult;
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
  "/v1/operator-activity": {
    get: {
      responses: {
          "200": OperatorActivityResult;
          "401": Error;
          "403": Error;
        };
    };
  };
  "/v1/action-results": {
    get: {
      responses: {
          "200": ExternalActionResultsEnvelope;
          "400": Error;
          "401": Error;
          "403": Error;
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
  "/v1/operator-agent/context": {
    get: {
      responses: {
          "200": ContextList;
          "401": Error;
          "403": Error;
        };
    };
    post: {
      responses: {
          "200": undefined;
          "201": undefined;
          "400": Error;
          "401": Error;
          "403": Error;
          "409": Error;
        };
    };
  };
  "/v1/operator-agent/context/revoke": {
    post: {
      responses: {
          "200": ContextReceiptResult;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
          "409": Error;
        };
    };
  };
  "/v1/operator-agent/context/delete": {
    post: {
      responses: {
          "200": ContextReceiptResult;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
        };
    };
  };
  "/v1/context-controls/inventory": {
    get: {
      responses: {
          "200": ContextControlsInventoryList;
          "400": Error;
          "401": Error;
          "403": Error;
        };
    };
  };
  "/v1/context-controls/forget": {
    post: {
      responses: {
          "200": ContextReceiptResult;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
        };
    };
  };
  "/v1/context-controls/revoke": {
    post: {
      responses: {
          "200": ContextReceiptResult;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
          "409": Error;
        };
    };
  };
  "/v1/context-controls/export": {
    get: {
      responses: {
          "200": ContextExportResult;
          "400": Error;
          "401": Error;
          "403": Error;
          "409": ContextExportResult;
        };
    };
  };
  "/v1/i/{instance}/operator-agent/ask": {
    post: {
      responses: {
          "200": OperatorAgentAnswer;
          "400": Error;
          "401": Error;
          "403": Error;
          "503": InstanceUnavailable;
        };
    };
  };
  "/v1/operator-agent/ask": {
    post: {
      responses: {
          "200": OperatorAgentAnswer;
          "400": Error;
          "401": Error;
          "403": Error;
        };
    };
  };
  "/v1/operator-agent/proposals": {
    get: {
      responses: {
          "200": OperatorAgentProposalList;
          "401": Error;
          "403": Error;
        };
    };
    post: {
      responses: {
          "200": undefined;
          "201": undefined;
          "400": Error;
          "401": Error;
          "403": Error;
          "409": Error;
        };
    };
  };
  "/v1/operator-agent/proposals/decision": {
    post: {
      responses: {
          "200": undefined;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
          "409": Error;
        };
    };
  };
  "/v1/operator-agent/proposals/outcome": {
    post: {
      responses: {
          "200": undefined;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
          "409": Error;
        };
    };
  };
  "/v1/operator-agent/settings": {
    get: {
      responses: {
          "200": OperatorAgentSettingsResult;
          "401": Error;
          "403": Error;
        };
    };
    post: {
      responses: {
          "200": undefined;
          "400": Error;
          "401": Error;
          "403": Error;
        };
    };
  };
  "/v1/operator-agent/preferences": {
    get: {
      responses: {
          "200": OperatorPreferenceList;
          "400": Error;
          "401": Error;
          "403": Error;
        };
    };
  };
  "/v1/operator-agent/preferences/propose": {
    post: {
      responses: {
          "200": OperatorPreferenceProposalResult;
          "201": OperatorPreferenceProposalResult;
          "400": Error;
          "401": Error;
          "403": Error;
          "409": OperatorPreferenceRefusal;
          "503": undefined;
        };
    };
  };
  "/v1/operator-agent/preferences/accept": {
    post: {
      responses: {
          "200": OperatorPreferenceReceipt;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": OperatorPreferenceRefusal;
          "409": OperatorPreferenceRefusal;
        };
    };
  };
  "/v1/operator-agent/preferences/reject": {
    post: {
      responses: {
          "200": OperatorPreferenceReceipt;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": OperatorPreferenceRefusal;
          "409": OperatorPreferenceRefusal;
        };
    };
  };
  "/v1/operator-agent/preferences/correct": {
    post: {
      responses: {
          "200": OperatorPreferenceReceipt;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": OperatorPreferenceRefusal;
          "409": OperatorPreferenceRefusal;
        };
    };
  };
  "/v1/operator-agent/preferences/opt-out": {
    post: {
      responses: {
          "200": OperatorPreferenceReceipt;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": OperatorPreferenceRefusal;
          "409": OperatorPreferenceRefusal;
        };
    };
  };
  "/v1/operator-agent/preferences/delete": {
    post: {
      responses: {
          "200": OperatorPreferenceReceipt;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": OperatorPreferenceRefusal;
          "409": OperatorPreferenceRefusal;
        };
    };
  };
  "/v1/operator-agent/experiments": {
    get: {
      responses: {
          "200": OperatorAgentExperimentList;
          "401": Error;
          "403": Error;
        };
    };
    post: {
      responses: {
          "200": undefined;
          "201": undefined;
          "400": Error;
          "401": Error;
          "403": Error;
          "409": Error;
        };
    };
  };
  "/v1/operator-agent/experiments/decision": {
    post: {
      responses: {
          "200": undefined;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
          "409": Error;
        };
    };
  };
  "/v1/operator-agent/experiments/outcome": {
    post: {
      responses: {
          "200": undefined;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
          "409": Error;
        };
    };
  };
  "/v1/operator-agent/experiments/rollback": {
    post: {
      responses: {
          "200": undefined;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
          "409": Error;
        };
    };
  };
  "/v1/operator-agent/promotions": {
    get: {
      responses: {
          "200": OperatorAgentPromotionList;
          "401": Error;
          "403": Error;
        };
    };
    post: {
      responses: {
          "200": undefined;
          "201": undefined;
          "400": Error;
          "401": Error;
          "403": Error;
          "409": Error;
        };
    };
  };
  "/v1/operator-agent/promotions/replay": {
    post: {
      responses: {
          "200": undefined;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
          "409": Error;
        };
    };
  };
  "/v1/operator-agent/promotions/decision": {
    post: {
      responses: {
          "200": undefined;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
          "409": Error;
        };
    };
  };
  "/v1/operator-agent/promotions/advance": {
    post: {
      responses: {
          "200": undefined;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
          "409": Error;
        };
    };
  };
  "/v1/operator-agent/promotions/rollback": {
    post: {
      responses: {
          "200": undefined;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
          "409": Error;
        };
    };
  };
  "/v1/operator-agent/consequence/preflight": {
    post: {
      responses: {
          "200": undefined;
          "400": Error;
          "401": Error;
          "403": Error;
          "409": undefined;
        };
    };
  };
  "/v1/operator-agent/consequences": {
    get: {
      responses: {
          "200": OperatorAgentPendingConsequenceRead;
          "401": Error;
          "403": Error;
        };
    };
    put: {
      responses: {
          "401": Error;
          "403": Error;
          "405": OperatorAgentConsequencesReadOnlyRefusal;
        };
    };
    post: {
      responses: {
          "401": Error;
          "403": Error;
          "405": OperatorAgentConsequencesReadOnlyRefusal;
        };
    };
    delete: {
      responses: {
          "401": Error;
          "403": Error;
          "405": OperatorAgentConsequencesReadOnlyRefusal;
        };
    };
    patch: {
      responses: {
          "401": Error;
          "403": Error;
          "405": OperatorAgentConsequencesReadOnlyRefusal;
        };
    };
  };
  "/v1/operator-agent/consequences/decision": {
    post: {
      responses: {
          "200": OperatorAgentConsequenceDecisionResult;
          "400": Error;
          "401": Error;
          "403": HighTierRefusal;
          "404": OperatorAgentConsequenceDecisionRefusal;
          "409": OperatorAgentConsequenceDecisionRefusal;
        };
    };
  };
  "/v1/operator-agent/delegation/handoff": {
    post: {
      responses: {
          "200": OperatorAgentDelegationHandoffResult;
          "400": Error;
          "401": Error;
          "403": HighTierRefusal;
          "409": OperatorAgentDelegationHandoffRefusal;
          "423": EmergencyStopAdmissionRefusal;
        };
    };
  };
  "/v1/operator-agent/actions": {
    get: {
      responses: {
          "200": OperatorAgentActionList;
          "401": Error;
          "403": Error;
        };
    };
    post: {
      responses: {
          "200": undefined;
          "201": undefined;
          "400": Error;
          "401": Error;
          "403": Error;
          "409": Error;
        };
    };
  };
  "/v1/operator-agent/actions/decision": {
    post: {
      responses: {
          "200": undefined;
          "400": Error;
          "401": Error;
          "403": HighTierRefusal;
          "404": Error;
          "409": Error;
        };
    };
  };
  "/v1/operator-agent/actions/preflight": {
    post: {
      responses: {
          "200": OperatorAgentActionPreflightResponse;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
        };
    };
  };
  "/v1/operator-agent/actions/execute": {
    post: {
      responses: {
          "200": OperatorAgentActionStepResult;
          "202": OperatorAgentActionStepResult;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
          "409": OperatorAgentActionStepResult;
          "423": EmergencyStopAdmissionRefusal;
        };
    };
  };
  "/v1/operator-agent/actions/execute-high": {
    post: {
      responses: {
          "200": OperatorAgentActionStepResult;
          "202": OperatorAgentActionStepResult;
          "400": Error;
          "401": Error;
          "403": HighTierRefusal;
          "404": Error;
          "409": OperatorAgentActionStepResult;
          "423": EmergencyStopAdmissionRefusal;
        };
    };
  };
  "/v1/operator-agent/actions/complete": {
    post: {
      responses: {
          "200": OperatorAgentActionStepResult;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
          "409": OperatorAgentActionStepResult;
        };
    };
  };
  "/v1/operator-agent/actions/rollback": {
    post: {
      responses: {
          "200": OperatorAgentActionStepResult;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
          "409": OperatorAgentActionStepResult;
        };
    };
  };
  "/v1/operator-agent/delegations": {
    get: {
      responses: {
          "200": DelegationProfileList;
          "401": Error;
          "403": Error;
        };
    };
    post: {
      responses: {
          "201": DelegationProfileIssueResult;
          "400": Error;
          "401": Error;
          "403": Error;
          "409": Error;
        };
    };
  };
  "/v1/operator-agent/delegations/decision": {
    post: {
      responses: {
          "200": DelegationDecisionResult;
          "400": Error;
          "401": Error;
          "403": HighTierRefusal;
          "404": Error;
          "409": Error;
        };
    };
  };
  "/v1/operator-agent/delegations/replace": {
    post: {
      responses: {
          "201": DelegationReplaceResult;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
          "409": Error;
        };
    };
  };
  "/v1/operator-agent/intent-plans": {
    get: {
      responses: {
          "200": IntentPlanList;
          "401": Error;
          "403": Error;
        };
    };
    post: {
      responses: {
          "200": IntentPlanProposeResult;
          "201": IntentPlanProposeResult;
          "400": Error;
          "401": Error;
          "403": Error;
          "409": Error;
        };
    };
  };
  "/v1/operator-agent/intent-plans/decision": {
    post: {
      responses: {
          "200": IntentPlanDecisionResult;
          "202": IntentPlanDecisionResult;
          "400": Error;
          "401": Error;
          "403": HighTierRefusal;
          "404": Error;
          "409": IntentPlanDecisionRefusal;
        };
    };
  };
  "/v1/operator-agent/emergency/clear": {
    post: {
      responses: {
          "200": EmergencyStopClearResult;
          "400": Error;
          "401": Error;
          "403": HighTierRefusal;
          "404": Error;
          "409": EmergencyStopClearRefusal;
        };
    };
  };
  "/v1/operator-agent/emergency/status": {
    get: {
      responses: {
          "200": EmergencyStopStatusResult;
          "401": Error;
          "403": Error;
        };
    };
  };
  "/v1/operator-agent/emergency/stop": {
    post: {
      responses: {
          "201": EmergencyStopIssueResult;
          "400": Error;
          "401": Error;
          "403": HighTierRefusal;
        };
    };
  };
  "/v1/operator-agent/follow-ups": {
    get: {
      responses: {
          "200": FollowUpList;
          "401": Error;
          "403": Error;
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
          "403": HighTierRefusal;
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
  "/v1/version": {
    get: {
      responses: {
          "200": VersionResult;
          "401": Error;
          "403": Error;
        };
    };
  };
  "/v1/recent": {
    get: {
      responses: {
          "200": RecentActivityResult;
          "304": undefined;
          "401": Error;
          "403": Error;
        };
    };
  };
  "/v1/daemon-health": {
    get: {
      responses: {
          "200": DaemonHealthSnapshot;
          "304": undefined;
          "401": Error;
          "403": Error;
        };
    };
  };
  "/v1/account-usage": {
    get: {
      responses: {
          "200": AccountUsageSnapshot;
          "401": Error;
          "403": Error;
        };
    };
  };
  "/v1/provider-routing": {
    get: {
      responses: {
          "200": ProviderRoutingStatus;
          "401": Error;
          "403": Error;
        };
    };
  };
  "/v1/control/status": {
    get: {
      responses: {
          "200": FleetControlStatus;
          "401": Error;
          "403": Error;
        };
    };
  };
  "/v1/task": {
    get: {
      responses: {
          "200": TaskCardResult;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
        };
    };
  };
  "/v1/plan/view": {
    get: {
      responses: {
          "200": PlanViewResult;
          "400": Error;
          "401": Error;
          "403": Error;
        };
    };
  };
  "/v1/onboarding/readiness": {
    get: {
      responses: {
          "200": OnboardingReadinessReport;
          "400": Error;
          "401": Error;
          "403": Error;
        };
    };
  };
  "/v1/peek": {
    get: {
      responses: {
          "200": PeekResult;
          "400": Error;
          "401": Error;
          "403": Error;
        };
    };
  };
  "/v1/replay": {
    get: {
      responses: {
          "200": undefined;
          "400": Error;
          "401": Error;
          "403": Error;
        };
    };
  };
  "/v1/self-measurement": {
    get: {
      responses: {
          "200": (SelfMeasurementRows) | (SelfMeasurementUnreadable) | (SelfMeasurementDetail);
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
        };
    };
  };
  "/v1/incidents": {
    get: {
      responses: {
          "200": IncidentsResult;
          "401": Error;
          "403": Error;
          "503": IncidentsUnavailable;
        };
    };
  };
  "/v1/incidents/events": {
    post: {
      responses: {
          "200": IncidentEventResult;
          "400": Error;
          "401": Error;
          "403": Error;
          "413": IncidentIngestBodyTooLarge;
        };
    };
  };
  "/v1/escalation/reply": {
    post: {
      responses: {
          "200": EscalationReplyResult;
          "400": Error;
          "401": Error;
          "403": Error;
        };
    };
  };
  "/v1/escalation/confirm": {
    get: {
      responses: {
          "200": undefined;
          "403": undefined;
          "410": undefined;
          "503": EscalationLinkRefusal;
        };
    };
  };
  "/v1/escalation/answer": {
    post: {
      responses: {
          "200": EscalationLinkAnswerResult;
          "400": EscalationLinkRefusal;
          "403": EscalationLinkRefusal;
          "410": EscalationLinkRefusal;
          "503": EscalationLinkRefusal;
        };
    };
  };
  "/v1/inbox": {
    get: {
      responses: {
          "200": InboxResult;
          "304": undefined;
          "401": Error;
          "403": Error;
        };
    };
  };
  "/v1/inbox/digests": {
    get: {
      responses: {
          "200": InboxDigestsResult;
          "401": Error;
          "403": Error;
        };
    };
  };
  "/v1/inbox/threads": {
    get: {
      responses: {
          "200": InboxThreadsResult;
          "401": Error;
          "403": Error;
          "500": InboxRefusal;
        };
    };
  };
  "/v1/inbox/thread": {
    get: {
      responses: {
          "200": InboxThreadDetail;
          "401": Error;
          "403": Error;
          "404": InboxRefusal;
          "500": InboxRefusal;
        };
    };
  };
  "/v1/inbox/thread/reply": {
    post: {
      responses: {
          "200": InboxThreadReplyResult;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": InboxThreadReplyRefusal;
          "409": InboxThreadReplyRefusal;
          "503": InboxThreadReplyRefusal;
        };
    };
  };
  "/v1/inbox/thread/read": {
    post: {
      responses: {
          "200": InboxOkResult;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": InboxRefusal;
          "409": InboxRefusal;
          "500": InboxRefusal;
        };
    };
  };
  "/v1/inbox/approve": {
    post: {
      responses: {
          "200": InboxProposalStartedResult;
          "400": Error;
          "401": Error;
          "403": HighTierRefusal;
          "404": InboxRefusal;
          "409": InboxRefusal;
        };
    };
  };
  "/v1/inbox/reframe": {
    post: {
      responses: {
          "200": InboxProposalStartedResult;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": InboxRefusal;
        };
    };
  };
  "/v1/inbox/decline": {
    post: {
      responses: {
          "200": InboxDeclineResult;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": InboxRefusal;
          "409": InboxRefusal;
        };
    };
  };
  "/v1/inbox/restore": {
    post: {
      responses: {
          "200": InboxRestoreResult;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": InboxRefusal;
          "409": InboxRefusal;
        };
    };
  };
  "/v1/confirm": {
    post: {
      responses: {
          "200": ConfirmNonceResult;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
        };
    };
  };
  "/v1/drain/feedback": {
    post: {
      responses: {
          "200": DrainFeedbackResult;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
        };
    };
  };
  "/v1/drain/kick": {
    post: {
      responses: {
          "200": KickResult;
          "400": Error;
          "401": Error;
          "403": HighTierRefusal;
          "404": Error;
        };
    };
  };
  "/v1/drain/preview": {
    get: {
      responses: {
          "200": DrainPreviewResult;
          "400": Error;
          "401": Error;
          "403": Error;
        };
    };
  };
  "/v1/drain/run": {
    post: {
      responses: {
          "200": DrainNowResult;
          "401": Error;
          "403": HighTierRefusal;
          "404": Error;
        };
    };
  };
  "/v1/feedback/preview": {
    post: {
      responses: {
          "200": FeedbackPreviewResult;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
        };
    };
  };
  "/v1/hooks/github": {
    post: {
      responses: {
          "202": GithubWebhookReceipt;
          "400": GithubWebhookRefusal;
          "401": GithubWebhookRefusal;
          "403": GithubWebhookRefusal;
          "413": GithubWebhookRefusal;
          "503": GithubWebhookRefusal;
        };
    };
  };
  "/v1/merge-hold": {
    post: {
      responses: {
          "200": MergeHoldResult;
          "400": Error;
          "401": Error;
          "403": MergeHoldRefusal;
          "404": Error;
        };
    };
  };
  "/v1/operator-notes": {
    get: {
      responses: {
          "200": OperatorNotesResult;
          "400": Error;
          "401": Error;
          "403": Error;
        };
    };
  };
  "/v1/operator-notes/add": {
    post: {
      responses: {
          "200": AddOperatorNoteResult;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
          "500": OperatorNoteWriteFailure;
        };
    };
  };
  "/v1/judge-labels": {
    post: {
      responses: {
          "200": RecordJudgeLabelResult;
          "400": Error;
          "401": Error;
          "403": Error;
          "500": JudgeLabelWriteFailure;
        };
    };
  };
  "/v1/policy/daily-cost-ceiling": {
    post: {
      responses: {
          "200": DailyCostCeilingResult;
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
        };
    };
  };
  "/v1/policy/daily-cost-ceiling/clear": {
    post: {
      responses: {
          "200": DailyCostCeilingResult;
          "401": Error;
          "403": Error;
          "404": Error;
        };
    };
  };
  "/v1/policy/provider-routing": {
    post: {
      responses: {
          "200": ProviderRoutingPolicyWriteResult;
          "400": ProviderRoutingPolicyRefusal;
          "401": Error;
          "403": HighTierRefusal;
          "404": Error;
          "409": ProviderRoutingPolicyRefusal;
        };
    };
  };
  "/v1/policy/provider-routing/clear": {
    post: {
      responses: {
          "200": ProviderRoutingPolicyWriteResult;
          "400": ProviderRoutingPolicyRefusal;
          "401": Error;
          "403": HighTierRefusal;
          "404": Error;
          "409": ProviderRoutingPolicyRefusal;
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
}

export interface operations {}
