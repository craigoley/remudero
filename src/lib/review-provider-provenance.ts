import type { WorkerProviderId } from "./config.js";

export type HeadProviderSource = "implement" | "fix";

export type ReviewProviderProvenance =
  | {
      state: "known";
      provider: WorkerProviderId;
      model?: string;
      source?: HeadProviderSource;
      claimCount: number;
    }
  | { state: "unknown"; reason: "no-exact-claim" }
  | { state: "ambiguous"; providers: WorkerProviderId[]; claimCount: number };

export interface ReviewProviderProvenanceKey {
  taskId: string;
  prUrl: string;
  headSha: string;
}

function workerProvider(value: unknown): WorkerProviderId | undefined {
  return value === "claude" || value === "codex" ? value : undefined;
}

function headProviderSource(value: unknown): HeadProviderSource | undefined {
  return value === "implement" || value === "fix" ? value : undefined;
}

/**
 * Resolve authorship evidence for exactly the head a reviewer is about to judge.
 *
 * A task id is not provenance: one task can have multiple attempts, providers and
 * human-authored heads. This resolver therefore refuses every stale or partial join.
 * Conflicting exact-key claims are ambiguous rather than last-write-wins because the
 * result is intended to influence selection of an independent reviewer.
 */
export function resolveReviewProviderProvenance(
  lines: ReadonlyArray<Record<string, unknown>>,
  key: ReviewProviderProvenanceKey,
): ReviewProviderProvenance {
  const claims = lines.flatMap((line) => {
    if (
      line.step !== "pr.head_provider" ||
      line.task_id !== key.taskId ||
      line.pr_url !== key.prUrl ||
      line.head_sha !== key.headSha ||
      line.availability !== "known"
    ) {
      return [];
    }
    const provider = workerProvider(line.provider);
    return provider ? [{ line, provider }] : [];
  });

  if (claims.length === 0) return { state: "unknown", reason: "no-exact-claim" };

  const providers = [...new Set(claims.map((claim) => claim.provider))].sort();
  if (providers.length > 1) {
    return { state: "ambiguous", providers, claimCount: claims.length };
  }

  const models = [
    ...new Set(
      claims.map(({ line }) => line.model).filter((model): model is string => typeof model === "string" && model !== ""),
    ),
  ];
  const sources = [
    ...new Set(
      claims
        .map(({ line }) => headProviderSource(line.source))
        .filter((source): source is HeadProviderSource => source !== undefined),
    ),
  ];
  return {
    state: "known",
    provider: providers[0],
    ...(models.length === 1 ? { model: models[0] } : {}),
    ...(sources.length === 1 ? { source: sources[0] } : {}),
    claimCount: claims.length,
  };
}

export type HeadProviderRecordResult =
  | { state: "recorded"; headSha: string }
  | {
      state: "unavailable";
      reason:
        | "worker-provider-unavailable"
        | "produced-head-unreadable"
        | "live-head-unreadable"
        | "head-unchanged-after-push"
        | "live-head-mismatch";
    };

/**
 * Read the producer worktree and live PR heads after a push and append one
 * truthful claim only when they are identical.
 *
 * Unavailable evidence gets a named row with neither provider nor head_sha. That
 * makes an operational gap visible without manufacturing an attribution a later
 * reviewer could accidentally trust.
 */
export function recordHeadProviderAfterPush(
  input: {
    taskId: string;
    prUrl: string;
    source: HeadProviderSource;
    worker: { provider?: unknown; model?: unknown };
    priorHeadSha?: string;
  },
  deps: {
    readProducedHeadSha: () => string;
    readHeadSha: (prUrl: string) => string;
    log: (step: string, fields?: Record<string, unknown>) => void;
  },
): HeadProviderRecordResult {
  const provider = workerProvider(input.worker.provider);
  if (!provider) {
    const reason = "worker-provider-unavailable" as const;
    deps.log("pr.head_provider", {
      task_id: input.taskId,
      pr_url: input.prUrl,
      source: input.source,
      availability: "unavailable",
      reason,
    });
    return { state: "unavailable", reason };
  }

  let producedHeadSha: string;
  try {
    producedHeadSha = deps.readProducedHeadSha().trim();
    if (!producedHeadSha) throw new Error("empty produced head");
  } catch {
    const reason = "produced-head-unreadable" as const;
    deps.log("pr.head_provider", {
      task_id: input.taskId,
      pr_url: input.prUrl,
      source: input.source,
      availability: "unavailable",
      reason,
    });
    return { state: "unavailable", reason };
  }

  if (input.priorHeadSha === producedHeadSha) {
    const reason = "head-unchanged-after-push" as const;
    deps.log("pr.head_provider", {
      task_id: input.taskId,
      pr_url: input.prUrl,
      source: input.source,
      availability: "unavailable",
      reason,
    });
    return { state: "unavailable", reason };
  }

  let headSha: string;
  try {
    headSha = deps.readHeadSha(input.prUrl).trim();
    if (!headSha) throw new Error("empty live head");
  } catch {
    const reason = "live-head-unreadable" as const;
    deps.log("pr.head_provider", {
      task_id: input.taskId,
      pr_url: input.prUrl,
      source: input.source,
      availability: "unavailable",
      reason,
    });
    return { state: "unavailable", reason };
  }

  if (headSha !== producedHeadSha) {
    const reason = "live-head-mismatch" as const;
    deps.log("pr.head_provider", {
      task_id: input.taskId,
      pr_url: input.prUrl,
      source: input.source,
      availability: "unavailable",
      reason,
    });
    return { state: "unavailable", reason };
  }

  deps.log("pr.head_provider", {
    task_id: input.taskId,
    pr_url: input.prUrl,
    head_sha: headSha,
    provider,
    ...(typeof input.worker.model === "string" && input.worker.model !== "" ? { model: input.worker.model } : {}),
    source: input.source,
    availability: "known",
  });
  return { state: "recorded", headSha };
}

/** Stable ledger shape for the review-side observation; never part of a prompt. */
export function reviewProviderProvenanceLedgerFields(
  result: ReviewProviderProvenance,
  key: Pick<ReviewProviderProvenanceKey, "prUrl" | "headSha">,
): Record<string, unknown> {
  if (result.state === "known") {
    return {
      state: result.state,
      provider: result.provider,
      ...(result.model ? { model: result.model } : {}),
      ...(result.source ? { source: result.source } : {}),
      claim_count: result.claimCount,
      pr_url: key.prUrl,
      head_sha: key.headSha,
    };
  }
  if (result.state === "ambiguous") {
    return {
      state: result.state,
      providers: result.providers,
      claim_count: result.claimCount,
      pr_url: key.prUrl,
      head_sha: key.headSha,
    };
  }
  return {
    state: result.state,
    reason: result.reason,
    pr_url: key.prUrl,
    head_sha: key.headSha,
  };
}
