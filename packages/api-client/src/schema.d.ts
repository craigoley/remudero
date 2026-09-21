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
      /** W1-T404 -- present only on a 403 refused for an insufficient WRITE TIER (once src/lib/service.ts's `enforceWriteTiers` is turned on; not yet set by `rmd serve`'s own production wiring). `low` (bookkeeping), `middle` (reversible but disruptive, or a spend force multiplier) or `high` (spends money or moves code) -- the tier the caller's token was missing, alongside `required_scope: write`. */
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
    /** Per-repository telemetry, unavailable until a durable per-repo aggregation source exists. */
    RepoDashboardTelemetry: {
      tokens7d: number | null;
      modelsused: (string)[];
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
      origin: "cli" | "ui" | "issue";
      status: "new" | "grilling" | "proposed" | "accepted" | "rejected";
      /** Set once `rmd triage` opens a proposal PR for this entry; null until then. */
      proposal_pr: string | null;
      /** GET /v1/feedback only (W1-T257): true when this `proposed` entry's proposal_pr merge state could not be read (GitHub outage) -- the row is kept, never dropped. Never written to plan/feedback/<id>.yaml; a read-time decoration only. */
      unverified?: boolean;
      /** GET /v1/feedback only (W1-T1257): true when every task this entry filed (`origin: feedback#<id>`) is credited MERGED -- the work the proposal produced has shipped, even though `status` still names a decision about the proposal itself. Derived fresh on every read, like `unverified` above; never written to plan/feedback/<id>.yaml and never auto-advances `status` -- whether a discharged entry should advance stays a human call. */
      discharged?: boolean;
      /** GET /v1/feedback only (W1-T1257): true when `discharged` could not be determined because the merged-set read failed or was truncated -- a partial read, never mistaken for "not discharged". Mutually exclusive with `discharged`; a read-time decoration only, exactly like `unverified`. */
      dischargeUndecidable?: boolean;
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
      version: "operator-activity-v1";
      state: "verified" | "stale" | "unavailable" | "unknown" | "not-collected";
      source: string;
      observedAt: string;
      cursor?: string;
      items?: (OperatorActivityItem)[];
      truncated?: boolean;
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
    FollowUpEvaluation: {
      version: "follow-up-policy-v1";
      candidateId: string;
      deduplicationKey: string;
      state: "scheduled" | "eligible" | "snoozed" | "suppressed" | "asked" | "accepted" | "rejected" | "expired" | "blocked";
      reason: string;
      at: string;
      attempts: number;
      nextAction?: string;
      nextQuestion?: string;
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
    FollowUpEvaluationRequest: {
      candidate: FollowUpCandidate;
      sourceTerminal?: boolean;
      dependencyAvailable?: boolean;
      notificationPolicy?: FollowUpNotificationPolicy;
    };
    FollowUpControlRequest: {
      candidateId: string;
      control: "snooze" | "reject" | "revoke" | "policy";
      until?: string;
      notificationPolicy?: FollowUpNotificationPolicy;
    };
    FollowUpDeliveryRequest: {
      candidateId: string;
      answered?: boolean;
      systemActed?: boolean;
      authority?: string;
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
  };
  securitySchemes: {
    /** Read-scoped bearer token. Grants GET access to read-scoped routes and SSE streams. A write-scoped token also satisfies this scope (write is a superset of read). */
    bearerRead: { type: "http"; scheme: "bearer" };
    /** Write-scoped bearer token. Required for any route whose `scope` is `write` (src/lib/service.ts's `Scope`). */
    bearerWrite: { type: "http"; scheme: "bearer" };
  };
}

export interface paths {
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
          "403": Error;
          "404": Error;
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
  "/v1/operator-agent/follow-ups": {
    get: {
      responses: {
          "200": FollowUpList;
          "401": Error;
          "403": Error;
        };
    };
  };
  "/v1/operator-agent/follow-ups/evaluate": {
    post: {
      responses: {
          "200": FollowUpEvaluation;
          "400": Error;
          "401": Error;
          "403": Error;
        };
    };
  };
  "/v1/operator-agent/follow-ups/control": {
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
  "/v1/operator-agent/follow-ups/delivery": {
    post: {
      responses: {
          "200": {
            ok: boolean;
            state: "asked";
            receipt: FollowUpReceipt;
          };
          "400": Error;
          "401": Error;
          "403": Error;
          "404": Error;
          "409": Error;
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
