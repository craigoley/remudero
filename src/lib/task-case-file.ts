import { readdirSync } from "node:fs";
import { basename } from "node:path";
import { fixedClock } from "./clock.js";
import { fingerprintLedgerLine, ledgerLivePath, ledgerRotationEntries, openLedgerUnion, type LedgerMalformedRowFinding,
  type LedgerUnionStreamIO } from "./ledger-union.js";
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
  /** Present only when a damaged row was seen; each entry is a bounded fault, never raw text. */
  malformedSources?: CaseMalformedSource[];
  /** True only when the task's EVIDENCE rows (every step outside {@link CASE_TELEMETRY_STEPS}) exceed the bound. */
  truncated: boolean;
  /** Distinct heartbeat rows matched but not kept (see {@link CASE_TELEMETRY_STEPS}). The reader always sets
   * it; a hand-built read may omit it, which reads as 0. */
  telemetryRowsDropped?: number;
}

export interface TaskCaseRun {
  runId: string;
  startedAt: string | null;
  /** The run's LAST `worker.assignment` id, kept for compatibility; `assignmentIds` holds them all. */
  assignmentId: string | null;
  /** Every assignment id the run wrote, in ledger order (W1-T4646: recon, implement, diagnose and fix
   * rungs share one run). Absent on a case file written before this field existed. */
  assignmentIds?: string[];
  selectedProvider: string | null;
  selectedModel: string | null;
  servedModel: string | null;
  billingMode: "api" | "subscription" | null;
  costUsd: number | null;
  verdict: string | null;
  prNumber: number | null;
}

/** `malformed` appears only when damaged rows that could not be this task's were seen and bounded. */
export interface CaseLedgerValue {
  windowStart: string;
  forms: CaseLedgerRead["forms"];
  /** Every distinct task-owned row the window matched, kept or dropped: the task's size, never shrunk by
   * dropped heartbeats. */
  matchingRows: number;
  /** Present only when heartbeat rows were dropped: that many of `matchingRows` were not kept. */
  telemetryRowsDropped?: number;
  malformed?: { rows: number; sources: CaseMalformedSource[] };
}

export interface TaskCaseFile {
  version: "task-case-file-v1";
  taskId: string;
  asOf: string;
  plan: CaseEvidence<{ title: string; dependsOn: string[]; verify: Task["verify"]; risk: Task["risk"] }>;
  ledger: CaseEvidence<CaseLedgerValue>;
  runs: TaskCaseRun[];
  pr: CaseEvidence<{ number: number; url: string; headSha: string; state: CasePrSnapshot["state"]; taskCredit: boolean }>;
  review: CaseEvidence<{ headSha: string; status: "success" }>;
  acceptance: CaseEvidence<{ headSha: string; status: "success" }>;
  ci: CaseEvidence<{ headSha: string; status: "success" }>;
  mergedSource: CaseEvidence<{ prNumber: number; mergedAt: string }>;
  deployment: CaseEvidence<{ revision: string }>;
  runtime: CaseEvidence<{ healthyAt: string }>;
  next: { owner: string; action: string; source: string } | null;
}

const ownedRun = (taskId: string, runId: unknown): runId is string =>
  typeof runId === "string" && (runId === taskId || runId.startsWith(`${taskId}-`));

/** A damaged row's source, bounded the way the benchmark cohort bounds one: a basename, a count, and
 * a time bound that is null as soon as one damaged row's timestamp could not be read. */
export interface CaseMalformedSource {
  source: string;
  form: LedgerMalformedRowFinding["form"];
  count: number;
  minTimestamp: string | null;
  maxTimestamp: string | null;
}

/** A damaged row could be this task's only when it names the task or one of its runs, or when it
 * names no identity at all and its time cannot be read or falls inside the task's window. */
export function malformedRowCouldBelong(finding: LedgerMalformedRowFinding, taskId: string, windowStart: string): boolean {
  if (finding.taskId === taskId || ownedRun(taskId, finding.runId) || (finding.namedTaskIds ?? []).includes(taskId)) return true;
  if (finding.taskId !== undefined || finding.runId !== undefined) return false;
  const at = finding.timestamp === undefined ? Number.NaN : Date.parse(finding.timestamp);
  return Number.isNaN(at) || at >= Date.parse(windowStart);
}

/** Heartbeat steps. No case-file field reads them: `buildTaskCaseFile` joins run.start, worker.assignment,
 * worker.attempt, pr.opened and verdict, and `taskShapeCovariates` counts run.start and fix.dispatch. The
 * status projection `assembleCaseFile` derives reads only their RECENCY — `lastActivityTs` (newest own-run
 * row), the latest `worker.state` transition, and `worker.activity`'s latest event — so a newest-per-step
 * tail is enough. It also sets `firstSignalAt` from a run's first activity, which a dropped head loses;
 * that field is display-only and no case-file field reads it. A run evidenced ONLY by dropped heartbeats
 * (its run.start outside the window) leaves `runs` instead of appearing with every field null. */
export const CASE_TELEMETRY_STEPS: ReadonlySet<string> = new Set(["worker.activity", "run.running_long", "worker.state"]);

/** BACKSTOP: heartbeat rows kept per step per task, newest by `ts`. Measured 2026-09-28: 1661-4609
 * heartbeats per long-running task beside 17-26 evidence rows. Overflow is counted, never refused. */
export const MAX_CASE_TELEMETRY_ROWS_PER_STEP = 500;

interface KeptRow { row: Record<string, unknown>; identity: string; at: number; seq: number }

/** Keep the newest `budget` rows by (ts, arrival); an evicted row's fingerprint stays so a replay of it in a
 * later rotation is neither re-kept nor counted twice. Rows are bounded; fingerprints of dropped ones are not. */
function keepNewest(kept: KeptRow[], budget: number, seen: Set<string>, dropped: Set<string>): void {
  if (kept.length <= budget) return;
  kept.sort((a, b) => a.at - b.at || a.seq - b.seq);
  for (const evicted of kept.splice(0, kept.length - budget)) {
    seen.delete(evicted.identity);
    dropped.add(fingerprintLedgerLine(evicted.identity));
  }
}

export interface TaskCaseLedgersInput {
  windowDays?: number;
  /** Bound on a task's EVIDENCE rows; exceeding it refuses the read as `task-row-bound-exceeded`. */
  maxRows?: number;
  /** Heartbeat rows kept per {@link CASE_TELEMETRY_STEPS} step; defaults to {@link MAX_CASE_TELEMETRY_ROWS_PER_STEP}. */
  maxTelemetryRowsPerStep?: number;
  /** Stream-opening I/O for the one union pass; tests count opens through it. */
  io?: LedgerUnionStreamIO;
}

/** Stream the three-form union ONCE for every requested task. Only exact task-owned rows are
 * retained, with a hard per-task memory bound; a damaged row refuses only a task it could belong to.
 * Heartbeat rows are bounded apart from evidence rows, so they never exhaust the evidence bound. */
export async function readTaskCaseLedgers(
  stateDir: string, taskIds: readonly string[], asOf: string, opts: TaskCaseLedgersInput = {},
): Promise<Map<string, CaseLedgerRead>> {
  const windowDays = opts.windowDays ?? 30;
  const maxRows = opts.maxRows ?? 2_000;
  const telemetryBudget = opts.maxTelemetryRowsPerStep ?? MAX_CASE_TELEMETRY_ROWS_PER_STEP;
  if (!Number.isInteger(windowDays) || windowDays < 1 || !Number.isInteger(maxRows) || maxRows < 1
    || !Number.isInteger(telemetryBudget) || telemetryBudget < 1)
    throw new TypeError("case-file windowDays, maxRows and maxTelemetryRowsPerStep must be positive integers");
  const windowStart = fixedClock(Date.parse(asOf) - windowDays * 86_400_000).iso();
  const forms = { gzip: 0, plain: 0, live: 0 };
  const perTask = new Map(taskIds.map((taskId) => [taskId, { evidence: [] as KeptRow[], telemetry: new Map<string, KeptRow[]>(),
    seen: new Set<string>(), dropped: new Set<string>(), blocking: 0, truncated: false }]));
  let seq = 0;
  const unread: string[] = [];
  const sources = new Map<string, CaseMalformedSource>();
  let malformed = 0;
  const settle = (reason?: string): Map<string, CaseLedgerRead> => new Map([...perTask].map(([taskId, task]) => {
    const refusal = reason ?? (unread.length ? "ledger-source-unreadable" : task.blocking ? "ledger-source-malformed"
      : task.truncated ? "task-row-bound-exceeded" : undefined);
    for (const kept of task.telemetry.values()) keepNewest(kept, telemetryBudget, task.seen, task.dropped);
    // Kept rows return in arrival order: the status projection's run-state scan is order-sensitive.
    const rows = refusal ? [] : [...task.evidence, ...[...task.telemetry.values()].flat()]
      .sort((a, b) => a.seq - b.seq).map((entry) => entry.row);
    return [taskId, { rows, state: refusal ? "unavailable" : "observed",
      ...(refusal ? { reason: refusal } : {}), asOf, windowStart, forms: { ...forms }, unread: [...unread], malformed,
      ...(malformed ? { malformedSources: [...sources.values()].map((entry) => ({ ...entry })) } : {}),
      truncated: task.truncated, telemetryRowsDropped: task.dropped.size }];
  }));
  try {
    const rotations = ledgerRotationEntries(readdirSync(stateDir), stateDir);
    for (const entry of rotations) forms[entry.form] += 1;
    // A live file is counted by the reader itself, not guessed from a directory listing.
    if (readdirSync(stateDir).includes(basename(ledgerLivePath(stateDir)))) forms.live = 1;
    if (rotations.length + forms.live === 0) return settle("ledger-corpus-missing");
    for await (const row of openLedgerUnion(stateDir, {
      sinceTs: windowStart, dedupe: false,
      onUnreadArchive: (path) => unread.push(path),
      onUnreadLive: (path) => unread.push(path),
      onMalformedRow: (finding) => {
        malformed += 1;
        const key = basename(finding.path);
        const entry = sources.get(key) ?? { source: key, form: finding.form, count: 0,
          minTimestamp: finding.timestamp ?? null, maxTimestamp: finding.timestamp ?? null };
        entry.count += 1;
        if (!finding.timestamp) entry.minTimestamp = entry.maxTimestamp = null;
        else if (entry.minTimestamp && entry.maxTimestamp) {
          if (finding.timestamp < entry.minTimestamp) entry.minTimestamp = finding.timestamp;
          if (finding.timestamp > entry.maxTimestamp) entry.maxTimestamp = finding.timestamp;
        }
        sources.set(key, entry);
        for (const [taskId, task] of perTask) if (malformedRowCouldBelong(finding, taskId, windowStart)) task.blocking += 1;
      },
    }, opts.io)) {
      const task = typeof row.task_id === "string" ? perTask.get(row.task_id) : undefined;
      if (!task || !ownedRun(row.task_id as string, row.run_id)) continue;
      // Rotations retain replayed lines; the identity set holds only kept rows.
      const identity = JSON.stringify(row);
      if (task.seen.has(identity)) continue;
      const step = typeof row.step === "string" && CASE_TELEMETRY_STEPS.has(row.step) ? row.step : undefined;
      if (step === undefined) {
        if (task.evidence.length >= maxRows) { task.truncated = true; continue; }
        task.seen.add(identity);
        task.evidence.push({ row, identity, at: 0, seq: seq++ });
        continue;
      }
      if (task.dropped.size && task.dropped.has(fingerprintLedgerLine(identity))) continue;
      const kept = task.telemetry.get(step) ?? [];
      task.telemetry.set(step, kept);
      task.seen.add(identity);
      const at = Date.parse(row.ts as string);
      kept.push({ row, identity, at: Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at, seq: seq++ });
      // Compacting at twice the budget keeps memory bounded while sorting only once per `budget` arrivals.
      if (kept.length >= 2 * telemetryBudget) keepNewest(kept, telemetryBudget, task.seen, task.dropped);
    }
  } catch (error) {
    return settle(`ledger-read-failed:${error instanceof Error ? error.name : "unknown"}`);
  }
  return settle();
}

/** One task's read: the batch reader over a single id, so both forms share one refusal rule. */
export async function readTaskCaseLedger(
  stateDir: string, taskId: string, asOf: string, opts: TaskCaseLedgersInput = {},
): Promise<CaseLedgerRead> {
  return (await readTaskCaseLedgers(stateDir, [taskId], asOf, opts)).get(taskId)!;
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
    ? observed<CaseLedgerValue>({ windowStart: ledger.windowStart, forms: ledger.forms,
      matchingRows: ledger.rows.length + (ledger.telemetryRowsDropped ?? 0),
      ...(ledger.telemetryRowsDropped ? { telemetryRowsDropped: ledger.telemetryRowsDropped } : {}),
      ...(ledger.malformed ? { malformed: { rows: ledger.malformed, sources: ledger.malformedSources ?? [] } } : {}) },
    "ledger-three-form-union", ledger.asOf)
    : unknown<CaseLedgerValue>("unavailable", ledger.reason ?? "ledger-unavailable", "ledger-three-form-union", ledger.asOf);
  const byRun = new Map<string, TaskCaseRun & { assignmentIds: string[] }>();
  const assignmentRun = new Map<string, string>();
  if (ledger.state === "observed") for (const row of ledger.rows) {
    const runId = row.run_id as string;
    const run = byRun.get(runId) ?? { runId, startedAt: null, assignmentId: null, assignmentIds: [],
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
      if (run.assignmentId && !run.assignmentIds.includes(run.assignmentId)) run.assignmentIds.push(run.assignmentId);
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
  const acceptance = check("acceptance-author-gate");
  const ci = check("ci-gate");
  const mergedSource = taskCredit && prSnapshot?.state === "MERGED" && prSnapshot.mergedAt
    ? observed({ prNumber: prSnapshot.number, mergedAt: prSnapshot.mergedAt }, "github-merge", prSnapshot.readAt)
    : unknown<{ prNumber: number; mergedAt: string }>(pr.state === "stale" ? "stale" : "pending",
      taskCredit ? "pr-not-merged" : "accepted-task-credit-unavailable", "github-merge", prSnapshot?.readAt ?? asOf);
  const next = projection?.needsHuman && projection.escalationIssueUrl
    ? { owner: "operator", action: projection.escalationIssueUrl, source: "status-escalation-receipt" }
    : projection?.verifyHumanPending ? { owner: "operator", action: `review verify: human task ${task.id}`, source: "plan-verify-gate" }
      : null;
  return { version: "task-case-file-v1", taskId: task.id, asOf, plan, ledger: ledgerEvidence, runs, pr, review, acceptance, ci,
    mergedSource, deployment: unknown("unavailable", "deployment-source-not-collected", "deployment", null),
    runtime: unknown("unavailable", "runtime-source-not-collected", "runtime", null), next };
}
