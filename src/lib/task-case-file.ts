import { readdirSync } from "node:fs";
import { basename } from "node:path";
import { fixedClock } from "./clock.js";
import { ledgerLivePath, ledgerRotationEntries, openLedgerUnion } from "./ledger-union.js";
import type { Task } from "./plan.js";
import type { StatusProjection } from "./status.js";

/** A case file is an observation, never a replacement for plan, GitHub, or a release receipt. */
export type CaseEvidence<T> =
  | { state: "observed"; value: T; source: string; asOf: string }
  | { state: "stale" | "pending" | "unavailable"; reason: string; source: string; asOf: string | null };

export interface CasePrSnapshot {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  headSha: string;
  body: string;
  mergedAt: string | null;
  checks: Array<{ name: string; state: "success" | "failure" | "pending" }> | null;
  readAt: string;
}

export type CasePrRead =
  | { state: "observed"; value: CasePrSnapshot }
  | { state: "unavailable"; reason: string };

export interface CaseLedgerRead {
  rows: Record<string, unknown>[];
  state: "observed" | "unavailable";
  reason?: string;
  asOf: string;
  windowStart: string;
  forms: { gzip: number; plain: number; live: number };
  unread: string[];
  malformed: number;
  truncated: boolean;
}

export interface TaskCaseRun {
  runId: string;
  startedAt: string | null;
  assignmentId: string | null;
  selectedProvider: string | null;
  selectedModel: string | null;
  servedModel: string | null;
  billingMode: "api" | "subscription" | null;
  costUsd: number | null;
  verdict: string | null;
  prNumber: number | null;
}

export interface TaskCaseFile {
  version: "task-case-file-v1";
  taskId: string;
  asOf: string;
  plan: CaseEvidence<{ title: string; dependsOn: string[]; verify: Task["verify"]; risk: Task["risk"] }>;
  ledger: CaseEvidence<{ windowStart: string; forms: CaseLedgerRead["forms"]; matchingRows: number }>;
  runs: TaskCaseRun[];
  pr: CaseEvidence<{ number: number; url: string; headSha: string; state: CasePrSnapshot["state"]; taskCredit: boolean }>;
  review: CaseEvidence<{ headSha: string; status: "success" }>;
  ci: CaseEvidence<{ headSha: string; status: "success" }>;
  mergedSource: CaseEvidence<{ prNumber: number; mergedAt: string }>;
  deployment: CaseEvidence<{ revision: string }>;
  runtime: CaseEvidence<{ healthyAt: string }>;
  next: { owner: string; action: string; source: string } | null;
}

const ownedRun = (taskId: string, runId: unknown): runId is string =>
  typeof runId === "string" && (runId === taskId || runId.startsWith(`${taskId}-`));

/** Stream the three-form union. Only exact task-owned rows are retained, with a hard memory bound. */
export async function readTaskCaseLedger(
  stateDir: string, taskId: string, asOf: string, opts: { windowDays?: number; maxRows?: number } = {},
): Promise<CaseLedgerRead> {
  const windowDays = opts.windowDays ?? 30;
  const maxRows = opts.maxRows ?? 2_000;
  if (!Number.isInteger(windowDays) || windowDays < 1 || !Number.isInteger(maxRows) || maxRows < 1)
    throw new TypeError("case-file windowDays and maxRows must be positive integers");
  const windowStart = fixedClock(Date.parse(asOf) - windowDays * 86_400_000).iso();
  const forms = { gzip: 0, plain: 0, live: 0 };
  const rows: Record<string, unknown>[] = [];
  const seenTaskRows = new Set<string>();
  const unread: string[] = [];
  let malformed = 0;
  let truncated = false;
  try {
    const rotations = ledgerRotationEntries(readdirSync(stateDir), stateDir);
    for (const entry of rotations) forms[entry.form] += 1;
    // A live file is counted by the reader itself, not guessed from a directory listing.
    if (readdirSync(stateDir).includes(basename(ledgerLivePath(stateDir)))) forms.live = 1;
    if (rotations.length + forms.live === 0) return {
      rows, state: "unavailable", reason: "ledger-corpus-missing", asOf, windowStart, forms, unread, malformed, truncated,
    };
    for await (const row of openLedgerUnion(stateDir, {
      sinceTs: windowStart, dedupe: false,
      onUnreadArchive: (path) => unread.push(path),
      onUnreadLive: (path) => unread.push(path),
      onMalformedRow: () => { malformed += 1; },
    })) {
      if (row.task_id !== taskId || !ownedRun(taskId, row.run_id)) continue;
      // Rotations retain replayed lines; a task-scoped set stays bounded by maxRows.
      const identity = JSON.stringify(row);
      if (seenTaskRows.has(identity)) continue;
      if (rows.length >= maxRows) { truncated = true; continue; }
      seenTaskRows.add(identity);
      rows.push(row);
    }
  } catch (error) {
    return { rows: [], state: "unavailable", reason: `ledger-read-failed:${error instanceof Error ? error.name : "unknown"}`,
      asOf, windowStart, forms, unread, malformed, truncated };
  }
  return { rows: unread.length || malformed || truncated ? [] : rows,
    state: unread.length || malformed || truncated ? "unavailable" : "observed",
    ...(unread.length || malformed || truncated ? { reason: unread.length ? "ledger-source-unreadable"
      : malformed ? "ledger-source-malformed" : "task-row-bound-exceeded" } : {}),
    asOf, windowStart, forms, unread, malformed, truncated };
}

function observed<T>(value: T, source: string, asOf: string): CaseEvidence<T> {
  return { state: "observed", value, source, asOf };
}

function unknown<T>(state: "stale" | "pending" | "unavailable", reason: string, source: string, asOf: string | null): CaseEvidence<T> {
  return { state, reason, source, asOf };
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function prNumber(url: unknown): number | null {
  const match = typeof url === "string" ? /\/pull\/(\d+)$/.exec(url) : null;
  return match ? Number(match[1]) : null;
}

/** All joins use task-owned run IDs, assignment IDs, and the PR's current head. */
export function buildTaskCaseFile(input: {
  task: Task;
  projection?: StatusProjection;
  ledger: CaseLedgerRead;
  prRead: CasePrRead;
  asOf: string;
}): TaskCaseFile {
  const { task, projection, ledger, prRead, asOf } = input;
  const plan = observed({ title: task.title, dependsOn: task.depends_on, verify: task.verify, risk: task.risk }, "plan", asOf);
  const ledgerEvidence = ledger.state === "observed"
    ? observed({ windowStart: ledger.windowStart, forms: ledger.forms, matchingRows: ledger.rows.length }, "ledger-three-form-union", ledger.asOf)
    : unknown<{ windowStart: string; forms: CaseLedgerRead["forms"]; matchingRows: number }>("unavailable", ledger.reason ?? "ledger-unavailable", "ledger-three-form-union", ledger.asOf);
  const byRun = new Map<string, TaskCaseRun>();
  const assignmentRun = new Map<string, string>();
  if (ledger.state === "observed") for (const row of ledger.rows) {
    const runId = row.run_id as string;
    const run = byRun.get(runId) ?? { runId, startedAt: null, assignmentId: null,
      selectedProvider: null, selectedModel: null, servedModel: null, billingMode: null,
      costUsd: null, verdict: null, prNumber: null };
    if (row.step === "run.start") run.startedAt = string(row.ts);
    if (row.step === "worker.assignment") {
      const assignment = row.worker_assignment as Record<string, unknown> | undefined;
      const selected = assignment?.selected as Record<string, unknown> | undefined;
      run.assignmentId = string(assignment?.id);
      run.selectedProvider = string(selected?.provider);
      run.selectedModel = string(selected?.model);
      if (run.assignmentId) assignmentRun.set(run.assignmentId, runId);
    }
    if (row.step === "pr.opened") run.prNumber = prNumber(row.pr_url);
    if (row.step === "verdict") run.verdict = string(row.verdict);
    byRun.set(runId, run);
  }
  if (ledger.state === "observed") for (const row of ledger.rows) {
    if (row.step !== "worker.attempt" && row.step !== "verdict") continue;
    const id = string(row.selection_assignment_id);
    if (!id || assignmentRun.get(id) !== row.run_id) continue;
    const run = byRun.get(row.run_id as string)!;
    run.servedModel = string(row.served_model) ?? run.servedModel;
    if (row.billing_mode === "api" || row.billing_mode === "subscription") run.billingMode = row.billing_mode;
    if (typeof row.total_cost_usd === "number" && Number.isFinite(row.total_cost_usd) && row.total_cost_usd >= 0)
      run.costUsd = row.total_cost_usd;
  }
  const runs = [...byRun.values()];
  const expectedPr = projection?.prNumber;
  const prSnapshot = prRead.state === "observed" ? prRead.value : null;
  const exactPr = !!prSnapshot && expectedPr === prSnapshot.number && /^[a-f0-9]{40}$/i.test(prSnapshot.headSha);
  const taskCredit = !!(exactPr && projection?.merged && projection.prNumber === prSnapshot.number
    && projection.source !== "none" && projection.source !== "throttled");
  const pr: TaskCaseFile["pr"] = exactPr
    ? observed({ number: prSnapshot.number, url: prSnapshot.url, headSha: prSnapshot.headSha,
      state: prSnapshot.state, taskCredit }, "github-current-pr-head", prSnapshot.readAt)
    : prRead.state === "unavailable" ? unknown("unavailable", prRead.reason, "github-pr-read", asOf)
      : prSnapshot ? unknown("stale", "pr-number-or-head-mismatch", "github-pr-read", prSnapshot.readAt)
        : unknown("pending", "no-credited-pr-in-current-projection", "status-projection", asOf);
  const check = (name: string): CaseEvidence<{ headSha: string; status: "success" }> => {
    if (!exactPr) return unknown("unavailable", "current-pr-head-unavailable", "github-status-rollup", asOf);
    if (!prSnapshot.checks) return unknown("unavailable", "checks-unreadable", "github-status-rollup", prSnapshot.readAt);
    const matches = prSnapshot.checks.filter((entry) => entry.name === name);
    if (matches.length !== 1) return unknown("pending", matches.length ? "duplicate-check-context" : "check-not-observed", "github-status-rollup", prSnapshot.readAt);
    return matches[0].state === "success" ? observed({ headSha: prSnapshot.headSha, status: "success" }, "github-status-rollup", prSnapshot.readAt)
      : unknown(matches[0].state === "pending" ? "pending" : "unavailable", `check-${matches[0].state}`, "github-status-rollup", prSnapshot.readAt);
  };
  const review = check("remudero-review");
  const ci = check("ci-gate");
  const mergedSource = taskCredit && prSnapshot?.state === "MERGED" && prSnapshot.mergedAt
    ? observed({ prNumber: prSnapshot.number, mergedAt: prSnapshot.mergedAt }, "github-merge", prSnapshot.readAt)
    : unknown<{ prNumber: number; mergedAt: string }>(pr.state === "stale" ? "stale" : "pending",
      taskCredit ? "pr-not-merged" : "accepted-task-credit-unavailable", "github-merge", prSnapshot?.readAt ?? asOf);
  const next = projection?.needsHuman && projection.escalationIssueUrl
    ? { owner: "operator", action: projection.escalationIssueUrl, source: "status-escalation-receipt" }
    : projection?.verifyHumanPending ? { owner: "operator", action: `review verify: human task ${task.id}`, source: "plan-verify-gate" }
      : null;
  return { version: "task-case-file-v1", taskId: task.id, asOf, plan, ledger: ledgerEvidence, runs, pr, review, ci,
    mergedSource, deployment: unknown("unavailable", "deployment-source-not-collected", "deployment", null),
    runtime: unknown("unavailable", "runtime-source-not-collected", "runtime", null), next };
}
