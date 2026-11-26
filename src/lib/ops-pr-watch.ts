/**
 * lib/ops-pr-watch.ts — W1-T14865: a red required check on an open ops-catalog pull request reaches the operator.
 *
 * The fleet's sweep and fix lanes read only the product repositories, so an ops-catalog pull request whose required
 * check went red sat unseen until someone asked. Ops pull requests are plan-only filings, so a notice is enough: this
 * module lists the ops catalog's open pull requests through the daemon's GET-only ops catalog seam, reads the
 * workflow jobs that ran on each head, and escalates a pull request whose required check failed long enough ago, with
 * no push since, once per (pull request, head).
 */
import type { Escalation } from "./escalate.js";
import type { Clock } from "./clock.js";
import type { OpsCatalogApi } from "./ops-catalog-source.js";

export const OPS_PR_RED_STALLED_STEP = "ops_pr.red_stalled";
export const OPS_PR_WATCH_UNREADABLE_STEP = "ops_pr.watch_unreadable";

// PRIMARY CONTROL: how long a required check may stay red on an unchanged head before the operator hears of it; the
// operator asked for a notice within an hour (W1-T14865).
export const OPS_PR_RED_STALLED_AFTER_MS = 60 * 60_000;
// PRIMARY CONTROL: the daemon reads the ops pull requests at most this often (W1-T14865 design, step 2).
export const OPS_PR_WATCH_EVERY_MS = 15 * 60_000;

export interface OpsPrWatchInput {
  /** The ops catalog repository, `owner/name`: the same one the daemon reads the ops plan from. */
  repository: string;
  api: OpsCatalogApi;
  nowMs: number;
  /** The ledger's raw lines; a pull request already escalated at its head is not escalated again. */
  ledgerLines: readonly string[];
  log: (step: string, extra: Record<string, unknown>) => void;
  /** Writes the operator inbox escalation and returns its url; absent, the ledger row is still written. */
  escalate?: (escalation: Escalation) => unknown;
}

export interface RedStalledPull {
  prNumber: number;
  prUrl: string;
  headSha: string;
  check: string;
  failedAt: string;
  firstErrorLine?: string;
}

export interface OpsPrWatchResult { escalated: RedStalledPull[]; unreadable?: string }

type Json = Record<string, unknown>;

function rowsOf(lines: readonly string[], step: string): Json[] {
  const rows: Json[] = [];
  for (const line of lines) {
    if (!line.includes(step)) continue;
    try {
      const row = JSON.parse(line) as Json;
      if (row.step === step) rows.push(row);
    } catch (error) { void error; /* a torn line is skipped, as every ledger reader does */ }
  }
  return rows;
}

/** invariant:once-per-head — the (pull request, head) pairs that already wrote a red-stalled row. */
function escalatedHeads(lines: readonly string[]): Set<string> {
  return new Set(rowsOf(lines, OPS_PR_RED_STALLED_STEP).map((row) => `${row.pr_number}@${row.head_sha}`));
}

/** The first `##[error]` line of a job log, when the log was readable as text. */
export function firstErrorLine(log: unknown): string | undefined {
  if (typeof log !== "string") return undefined;
  for (const raw of log.split("\n")) {
    const line = raw.replace(/^\S+Z\s/, "");
    if (line.startsWith("##[error]")) return line.slice("##[error]".length).trim().slice(0, 300);
  }
  return undefined;
}

/** A required job that concluded failure at least {@link OPS_PR_RED_STALLED_AFTER_MS} before `nowMs`, if any. */
export function staleFailedRequiredJob(
  jobs: readonly Json[], required: ReadonlySet<string> | undefined, nowMs: number,
): { id: number; name: string; completedAt: string } | undefined {
  for (const job of jobs) {
    const name = String(job.name ?? "");
    if ((required !== undefined && !required.has(name)) || job.conclusion !== "failure" || typeof job.completed_at !== "string") continue;
    const completedMs = Date.parse(job.completed_at);
    if (Number.isFinite(completedMs) && nowMs - completedMs >= OPS_PR_RED_STALLED_AFTER_MS) {
      return { id: Number(job.id), name, completedAt: job.completed_at };
    }
  }
  return undefined;
}

function escalationFor(pull: RedStalledPull, repository: string): Escalation {
  return {
    class: "BLOCKED",
    taskId: `OPS-PR-${pull.prNumber}`,
    summary: `${repository} #${pull.prNumber}: required check ${pull.check} has been red since ${pull.failedAt}`,
    detail: [
      `The ops catalog pull request ${pull.prUrl} has its required check \`${pull.check}\` red at head ${pull.headSha.slice(0, 9)},`,
      `concluded ${pull.failedAt}, with no push since. Ops pull requests have no fix lane, so nothing will repair it.`,
      ``,
      `First error line: ${pull.firstErrorLine ?? "(the job log was not readable)"}`,
    ].join("\n"),
    options: [
      { label: "Fix the filing", detail: "Push a corrected record to the pull request's branch; the check re-runs on the new head." },
      { label: "Close the pull request", detail: "Close it if the filing is no longer wanted." },
    ],
    recommendation: "Fix the filing",
    headSha: pull.headSha,
    consequence: "The filing stays unmerged and its required check stays red.",
  };
}

/**
 * W1-T14865: list the ops catalog's open pull requests, and escalate each whose required check failed at least an hour
 * ago at its current head, once per (pull request, head). A read failure writes one unreadable row and never escalates.
 */
export async function watchOpsPullRequests(input: OpsPrWatchInput): Promise<OpsPrWatchResult> {
  const repo = input.repository;
  let pulls: Json[];
  try {
    pulls = (await input.api(`repos/${repo}/pulls?state=open&per_page=50`)) as Json[];
    if (!Array.isArray(pulls)) throw new Error("open pull request list was not an array");
  } catch (error) {
    const reason = String((error as Error)?.message ?? error).slice(0, 300);
    // One row per reason: an unchanged failure is not re-written every 15 minutes.
    const last = rowsOf(input.ledgerLines, OPS_PR_WATCH_UNREADABLE_STEP).at(-1);
    if (last?.reason !== reason) input.log(OPS_PR_WATCH_UNREADABLE_STEP, { repository: repo, reason });
    return { escalated: [], unreadable: reason };
  }
  // The branch protection names the required checks. An identity that may not read protection counts every job as
  // required: a notice about a red job on a plan-only filing costs the operator little, a missed one costs a day.
  let required: ReadonlySet<string> | undefined;
  try {
    const checks = (await input.api(`repos/${repo}/branches/main/protection/required_status_checks`)) as Json;
    required = Array.isArray(checks.contexts) ? new Set(checks.contexts.map(String)) : undefined;
  } catch (error) { void error; required = undefined; /* no protection read: every job counts (above) */ }
  const done = escalatedHeads(input.ledgerLines);
  const escalated: RedStalledPull[] = [];
  for (const pull of pulls) {
    const prNumber = Number(pull.number);
    const headSha = String((pull.head as Json | undefined)?.sha ?? "");
    if (!Number.isSafeInteger(prNumber) || headSha === "" || done.has(`${prNumber}@${headSha}`)) continue;
    try {
      const runs = (await input.api(`repos/${repo}/actions/runs?head_sha=${headSha}&per_page=50`)) as Json;
      const failedRuns = (Array.isArray(runs.workflow_runs) ? runs.workflow_runs : []).filter((run: Json) => run.conclusion === "failure");
      for (const run of failedRuns) {
        const jobs = (await input.api(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`)) as Json;
        const job = staleFailedRequiredJob(Array.isArray(jobs.jobs) ? jobs.jobs : [], required, input.nowMs);
        if (job === undefined) continue;
        let errorLine: string | undefined;
        try { errorLine = firstErrorLine(await input.api(`repos/${repo}/actions/jobs/${job.id}/logs`)); }
        catch (error) { void error; errorLine = undefined; /* an unreadable log leaves the line out */ }
        const red: RedStalledPull = { prNumber, prUrl: String(pull.html_url ?? `https://github.com/${repo}/pull/${prNumber}`), headSha,
          check: job.name, failedAt: job.completedAt, ...(errorLine === undefined ? {} : { firstErrorLine: errorLine }) };
        const url = input.escalate?.(escalationFor(red, repo));
        input.log(OPS_PR_RED_STALLED_STEP, { repository: repo, pr_number: prNumber, head_sha: headSha, check: red.check,
          failed_at: red.failedAt, required_source: required === undefined ? "every_job" : "branch_protection", first_error_line: errorLine ?? null, escalation_url: typeof url === "string" ? url : null });
        done.add(`${prNumber}@${headSha}`);
        escalated.push(red);
        break;
      }
    } catch (error) {
      input.log(OPS_PR_WATCH_UNREADABLE_STEP, { repository: repo, pr_number: prNumber, reason: String((error as Error)?.message ?? error).slice(0, 300) });
    }
  }
  return { escalated };
}

/** W1-T14865: what the daemon wires. Absent, nothing is watched. */
export interface OpsPullRequestWatch {
  /** The ops catalog repository, `owner/name`; undefined until the daemon knows which one it reads. */
  repository: () => string | undefined;
  api: OpsCatalogApi;
  escalate?: (escalation: Escalation) => unknown;
}

/**
 * W1-T14865: the daemon tick's entry. The returned function starts {@link watchOpsPullRequests} detached at most once
 * per {@link OPS_PR_WATCH_EVERY_MS} and never while a previous read is still in flight; a thrown read writes one
 * unreadable row. Returns the started read, or undefined when nothing started.
 */
export function opsPullRequestWatchTick(
  watch: OpsPullRequestWatch | undefined,
  ports: {
    clock: Pick<Clock, "now">; ledgerLines: () => readonly string[]; log: (step: string, extra: Record<string, unknown>) => void;
    /** The read itself: {@link watchOpsPullRequests}, passed in so the daemon's tick names what it runs. */
    run: (input: OpsPrWatchInput) => Promise<OpsPrWatchResult>;
  },
): () => Promise<void> | undefined {
  let lastAtMs: number | undefined;
  let inFlight = false;
  return () => {
    if (watch === undefined || inFlight) return undefined;
    const nowMs = ports.clock.now();
    if (lastAtMs !== undefined && nowMs - lastAtMs < OPS_PR_WATCH_EVERY_MS) return undefined;
    const repository = watch.repository();
    if (repository === undefined) return undefined;
    lastAtMs = nowMs;
    inFlight = true;
    return ports.run({ repository, api: watch.api, nowMs, ledgerLines: ports.ledgerLines(), log: ports.log,
      ...(watch.escalate ? { escalate: watch.escalate } : {}) })
      .then(() => undefined, (error: unknown) => {
        try { ports.log(OPS_PR_WATCH_UNREADABLE_STEP, { repository, reason: String((error as Error)?.message ?? error).slice(0, 300) }); }
        catch (logError) { void logError; /* the watch is advisory; a lost row never stops the daemon */ }
      })
      .finally(() => { inFlight = false; });
  };
}
