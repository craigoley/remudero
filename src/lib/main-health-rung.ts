import {
  NEEDS_HUMAN_LABEL,
  tryEscalate,
  type Escalation,
  type IssueGateway,
  type OpenIssue,
} from "./escalate.js";
import { rollupFor, type GhApiFetcher } from "./open-prs-rest.js";
import { appendLedger } from "./ledger.js";
import { readLedgerLines } from "./status.js";
import {
  CHECK_REQUEUE_STEP,
  classifyCiInfrastructureFailure,
  enrichMainHealthObservation,
  mainHealthEscalationDecision,
  mainHealthFromRollup,
  requeuedCheckKeysFromLedger,
  type CiFailure,
  type MainHealthObservation,
  type MainHealthRunHistoryEntry,
  type RollupCheckEntry,
} from "./sweep.js";

/** Stable referent for the one repo-wide default-branch health incident. */
export const MAIN_HEALTH_TASK_ID = "MAIN-HEALTH";

export interface MainHealthRungDeps {
  fetch: GhApiFetcher;
  issues: IssueGateway;
  ledgerPath: string;
  runId: string;
  log: (step: string, extra?: Record<string, unknown>) => void;
  /** Brief successful-observation cache shared by the event and ordinary full-sweep paths. */
  freshMs?: number;
  /** Injectable wall clock for the freshness boundary. */
  now?: () => number;
  readCiFailures?: (
    rollup: readonly RollupCheckEntry[] | undefined,
  ) => CiFailure[] | undefined | Promise<CiFailure[] | undefined>;
  readMainRunHistory?: (branch: string) => MainHealthRunHistoryEntry[] | undefined | Promise<MainHealthRunHistoryEntry[] | undefined>;
  requeueCheck?: (failure: CiFailure) => boolean | void | Promise<boolean | void>;
}

interface RepoMetadata {
  default_branch?: unknown;
}

interface CommitMetadata {
  sha?: unknown;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`GitHub response omitted ${field}`);
  }
  return value;
}

interface WorkflowRunHistoryResponse {
  workflow_runs?: ReadonlyArray<{
    head_sha?: unknown;
    conclusion?: unknown;
    html_url?: unknown;
    pull_requests?: ReadonlyArray<{ number?: unknown; html_url?: unknown; url?: unknown }>;
  }>;
}

export function mainPushRunHistoryRestArgs(owner: string, repo: string, branch: string): string[] {
  return [
    "api",
    `repos/${owner}/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&event=push&status=completed&per_page=100`,
  ];
}

export function fetchMainPushRunHistory(
  owner: string,
  repo: string,
  branch: string,
  fetch: GhApiFetcher,
): MainHealthRunHistoryEntry[] {
  const response = fetch(mainPushRunHistoryRestArgs(owner, repo, branch)) as WorkflowRunHistoryResponse;
  return (response.workflow_runs ?? [])
    .map((run): MainHealthRunHistoryEntry | undefined => {
      if (typeof run.head_sha !== "string" || run.head_sha.trim() === "") return undefined;
      const pullRequests = (run.pull_requests ?? [])
        .map((pr) => ({
          ...(typeof pr.number === "number" ? { number: pr.number } : {}),
          ...(typeof pr.html_url === "string" ? { url: pr.html_url } : typeof pr.url === "string" ? { url: pr.url } : {}),
        }))
        .filter((pr) => pr.number !== undefined || pr.url !== undefined);
      return {
        headSha: run.head_sha,
        ...(typeof run.conclusion === "string" ? { conclusion: run.conclusion } : {}),
        ...(typeof run.html_url === "string" ? { url: run.html_url } : {}),
        ...(pullRequests.length > 0 ? { pullRequests } : {}),
      };
    })
    .filter((run): run is MainHealthRunHistoryEntry => run !== undefined);
}

export function escalationFor(observation: MainHealthObservation, branch: string): Escalation {
  const decision = mainHealthEscalationDecision(observation);
  if (!decision.escalate || !decision.class) {
    throw new Error(`refusing to build a main-health escalation for ${observation.state}`);
  }
  return {
    class: decision.class,
    taskId: MAIN_HEALTH_TASK_ID,
    runId: undefined,
    headSha: observation.sha,
    summary: "main's own check suite is red",
    detail:
      `The default branch \`${branch}\` at \`${observation.sha}\` is red. ${observation.reason}. ` +
      "This observer never auto-reverts or pauses unrelated dispatch; an explicit operator ruling " +
      "is required to hold the queue. The automatic PR repair and update paths remain active.",
    options: [
      {
        label: "let automatic repair continue",
        detail: "Keep the queue moving while Remudero updates or repairs work that inherited the failing baseline.",
        kind: { type: "operator-only" },
      },
      {
        label: "place a queue hold",
        detail: "Record an operator hold if continuing dispatch would compound this specific trunk failure.",
        kind: { type: "operator-only" },
      },
    ],
    recommendation: "let automatic repair continue",
  };
}

function isMainHealthIssue(issue: OpenIssue): boolean {
  return /^\*\*Task:\*\*\s+MAIN-HEALTH\s*$/m.test(issue.body ?? "");
}

/**
 * Build the default-branch observer once per daemon process, then invoke it from settled check
 * events and every FULL sweep. The branch name is stable enough to cache for that process; the
 * head SHA and its rollup are re-read after the brief event-settlement freshness window. All
 * errors are named and swallowed here so neither GitHub nor issue transport can stop the PR
 * reconciler that follows this rung.
 */
export function buildMainHealthRung(
  owner: string,
  repo: string,
  deps: MainHealthRungDeps,
): () => Promise<void> {
  let defaultBranch: string | undefined;
  let escalatedSignature: string | undefined;
  let resolvedSignature: string | undefined;
  let lastSuccessfulObservationAtMs: number | undefined;
  let inFlight: Promise<void> | undefined;
  const freshMs = Math.max(0, deps.freshMs ?? 0);
  const now = deps.now ?? Date.now;

  const observe = async (startedAtMs: number): Promise<void> => {
    try {
      if (!defaultBranch) {
        const metadata = deps.fetch(["api", `repos/${owner}/${repo}`]) as RepoMetadata;
        defaultBranch = requiredString(metadata?.default_branch, "default_branch");
      }
      const branch = defaultBranch;
      const commit = deps.fetch([
        "api",
        `repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`,
      ]) as CommitMetadata;
      const sha = requiredString(commit?.sha, "default branch head sha");
      const rollup = rollupFor(owner, repo, sha, deps.fetch);
      let observation = mainHealthFromRollup(sha, rollup, undefined);
      deps.log("main.health.observed", {
        branch,
        sha,
        state: observation.state,
        reason: observation.reason,
        failing_checks: observation.failingChecks,
        pending_checks: observation.pendingChecks,
        non_evidence_checks: observation.nonEvidenceChecks,
      });

      if (observation.state === "red") {
        resolvedSignature = undefined;
        const signature = `${sha}:${[...observation.failingChecks].sort().join(",")}`;
        if (signature === escalatedSignature) {
          lastSuccessfulObservationAtMs = startedAtMs;
          return;
        }
        let failures: CiFailure[] | undefined;
        let ciFailuresUnavailable: string | undefined;
        try {
          failures = deps.readCiFailures ? await deps.readCiFailures(rollup) : undefined;
          if (!deps.readCiFailures) ciFailuresUnavailable = "no CI failure reader configured";
          if (deps.readCiFailures && failures === undefined) ciFailuresUnavailable = "the CI failure reader returned no evidence";
        } catch (error) {
          ciFailuresUnavailable = String((error as Error)?.message ?? error);
          deps.log("main.health.ci_evidence_unreadable", {
            branch,
            sha,
            error: String((error as Error)?.message ?? error),
          });
        }
        let runHistory: MainHealthRunHistoryEntry[] | undefined;
        let runHistoryUnavailable: string | undefined;
        try {
          const readMainRunHistory =
            deps.readMainRunHistory ?? ((branchName: string) => fetchMainPushRunHistory(owner, repo, branchName, deps.fetch));
          runHistory = await readMainRunHistory(branch);
          if (runHistory === undefined) runHistoryUnavailable = "the main push run-history reader returned no evidence";
        } catch (error) {
          runHistoryUnavailable = String((error as Error)?.message ?? error);
          deps.log("main.health.run_history_unreadable", {
            branch,
            sha,
            error: String((error as Error)?.message ?? error),
          });
        }
        observation = enrichMainHealthObservation(observation, {
          ...(failures ? { ciFailures: failures } : {}),
          ...(ciFailuresUnavailable ? { ciFailuresUnavailable } : {}),
          ...(runHistory ? { runHistory } : {}),
          ...(runHistoryUnavailable ? { runHistoryUnavailable } : {}),
        });
        const failingNames = [...observation.failingChecks].sort();
        const evidenceNames = [...(failures ?? [])].map((failure) => failure.name).sort();
        const exactEvidenceSet =
          failingNames.length === evidenceNames.length &&
          failingNames.every((name, index) => name === evidenceNames[index]);
        const classified = (failures ?? []).map((failure) => ({
          failure,
          signature: classifyCiInfrastructureFailure({
            conclusion: failure.conclusion,
            logTail: failure.logTail,
          }),
        }));
        const allRetryable =
          deps.readCiFailures !== undefined &&
          deps.requeueCheck !== undefined &&
          exactEvidenceSet &&
          classified.length > 0 &&
          classified.every(({ failure, signature: failureSignature }) => failure.jobId && failureSignature);
        if (allRetryable) {
          const priorKeys = requeuedCheckKeysFromLedger(readLedgerLines(deps.ledgerPath));
          const repeated = classified.some(({ failure }) => priorKeys.has(`${sha}@${failure.name}`));
          if (!repeated) {
            let allDispatched = true;
            for (const { failure, signature: failureSignature } of classified) {
              const jobId = failure.jobId!;
              const namedSignature = failureSignature!;
              appendLedger(deps.ledgerPath, {
                run_id: deps.runId,
                task_id: MAIN_HEALTH_TASK_ID,
                step: CHECK_REQUEUE_STEP,
                surface: "main",
                head_sha: sha,
                check_name: failure.name,
                signature: namedSignature,
                job_id: jobId,
                outcome: "attempting",
                worker_strike_avoided: true,
              });
              let dispatched = false;
              try {
                dispatched = (await deps.requeueCheck!(failure)) !== false;
              } catch (error) {
                deps.log("main.health.ci_requeue.error", {
                  branch,
                  sha,
                  check_name: failure.name,
                  job_id: jobId,
                  error: String((error as Error)?.message ?? error),
                });
                dispatched = false;
              }
              appendLedger(deps.ledgerPath, {
                run_id: deps.runId,
                task_id: MAIN_HEALTH_TASK_ID,
                step: "main.health.ci_requeued",
                surface: "main",
                head_sha: sha,
                check_name: failure.name,
                signature: namedSignature,
                job_id: jobId,
                outcome: dispatched ? "dispatched" : "failed",
                worker_strike_avoided: true,
              });
              allDispatched = allDispatched && dispatched;
            }
            if (allDispatched) {
              lastSuccessfulObservationAtMs = startedAtMs;
              return;
            }
          }
        }
        const issueUrl = tryEscalate(escalationFor(observation, branch), {
          issues: deps.issues,
          ledgerPath: deps.ledgerPath,
          runId: deps.runId,
        });
        if (issueUrl) {
          escalatedSignature = signature;
          deps.log("main.health.escalated", {
            branch,
            sha,
            failing_checks: observation.failingChecks,
            issue_url: issueUrl,
          });
        }
        lastSuccessfulObservationAtMs = startedAtMs;
        return;
      }

      escalatedSignature = undefined;
      if (observation.state !== "green") {
        resolvedSignature = undefined;
        lastSuccessfulObservationAtMs = startedAtMs;
        return;
      }
      const signature = `${observation.state}:${sha}`;
      if (signature === resolvedSignature) {
        lastSuccessfulObservationAtMs = startedAtMs;
        return;
      }
      if (!deps.issues.listOpen || !deps.issues.closeWithComment) {
        throw new Error("main-health resolution requires issue list and close support");
      }
      const open = deps.issues.listOpen(NEEDS_HUMAN_LABEL).filter(isMainHealthIssue);
      for (const issue of open) {
        deps.issues.closeWithComment(
          issue.url,
          `Resolved automatically: default branch \`${branch}\` at \`${sha}\` now has genuine passing check evidence. ${observation.reason}`,
        );
        deps.log("main.health.resolved", { branch, sha, issue_url: issue.url });
      }
      resolvedSignature = signature;
      lastSuccessfulObservationAtMs = startedAtMs;
    } catch (error) {
      deps.log("main.health.error", { error: String((error as Error)?.message ?? error) });
    }
  };

  return () => {
    const startedAtMs = now();
    if (
      lastSuccessfulObservationAtMs !== undefined &&
      startedAtMs >= lastSuccessfulObservationAtMs &&
      startedAtMs - lastSuccessfulObservationAtMs < freshMs
    ) {
      return Promise.resolve();
    }
    if (inFlight) return inFlight;
    const started = observe(startedAtMs);
    inFlight = started;
    void started.finally(() => {
      if (inFlight === started) inFlight = undefined;
    });
    return started;
  };
}
