import { readdirSync } from "node:fs";
import { basename } from "node:path";
import { fixedClock } from "./clock.js";
import { fingerprintLedgerLine, ledgerLivePath, ledgerRotationEntries, openLedgerUnion, malformedRowCouldBelong, ledgerRunBelongsToTask as ownedRun, type LedgerMalformedRowFinding,
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
  /** W1-T14630: always false. No count refuses or cuts a case file; the field stays for hand-built reads. */
  truncated: boolean;
  /** Distinct heartbeat rows matched but not kept, because the status projection reads none of their values
   * (see {@link reduceHeartbeats}). The reader always sets it; a hand-built read may omit it, which reads as 0. */
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

/** A damaged row's source, bounded the way the benchmark cohort bounds one: a basename, a count, and
 * a time bound that is null as soon as one damaged row's timestamp could not be read. */
export interface CaseMalformedSource {
  source: string;
  form: LedgerMalformedRowFinding["form"];
  count: number;
  minTimestamp: string | null;
  maxTimestamp: string | null;
}

export { malformedRowCouldBelong };

/** Heartbeat steps. No case-file field reads them: `buildTaskCaseFile` joins run.start, worker.assignment,
 * worker.attempt, pr.opened and verdict, and `taskShapeCovariates` counts run.start and fix.dispatch. The status
 * projection `assembleCaseFile` derives (status.ts `deriveRunState`) folds them in ledger order; see
 * {@link reduceHeartbeats} for the rows that fold reads. */
export const CASE_TELEMETRY_STEPS: ReadonlySet<string> = new Set(["worker.activity", "run.running_long", "worker.state"]);

interface KeptRow { row: Record<string, unknown>; seq: number }

const json = (value: unknown): string => JSON.stringify(value) ?? "undefined";

/** W1-T14630: the slots a heartbeat row can fill. Between two of a task's evidence rows (a segment), the
 * `deriveRunState` fold of one run's heartbeats depends only on: the last row with a string `ts` (lastActivityTs);
 * the last `worker.state` row of each `state` value (the last valid one sets workerState and workerStateSince);
 * and, per `worker.activity` class (raw `event_kind`, and whether its event time is truthy), the first and last
 * row (firstSignalAt, lastEventAt/Kind, currentTool, and the last valid non-executing event that clears the tool
 * fields), and the last row per value of each field a later event carries forward (worker_role, provider,
 * requested_model, served_model, a tool completion, tool_reason, tool_started_at). Slots key on raw values, not on
 * status.ts's validity checks, so the last VALID row of each kind is always the last row of its own slot: the
 * kept set grows with the distinct values seen, never with the heartbeat count, and the fold over it equals the
 * fold over every row. */
function heartbeatSlots(row: Record<string, unknown>, step: string): { first: string[]; last: string[] } {
  const run = json(row.run_id);
  const last = [`${run}|ts|${typeof row.ts === "string"}`];
  const first: string[] = [];
  if (step === "worker.state") last.push(`${run}|state|${json(row.state)}`);
  if (step === "worker.activity") {
    const eventAt = typeof row.event_at === "string" ? row.event_at : typeof row.ts === "string" ? row.ts : undefined;
    const cls = `${run}|activity|${json(row.event_kind)}|${Boolean(eventAt)}`;
    first.push(cls);
    last.push(cls, `${cls}|role|${json(row.worker_role)}`,
      ...(["provider", "requested_model", "served_model", "tool_reason", "tool_started_at"] as const)
        .map((field) => `${cls}|${field}|${typeof row[field] === "string"}`),
      `${cls}|done|${typeof row.tool_completed_at === "string"}|${typeof row.tool_duration_ms === "number"}`);
  }
  return { first, last };
}

/** The rows one segment keeps, in arrival order. */
function reduceHeartbeats(segment: Map<string, KeptRow>): KeptRow[] {
  return [...new Set(segment.values())].sort((a, b) => a.seq - b.seq);
}

interface TaskRead {
  kept: KeptRow[];
  /** The open heartbeat segment's slots, each holding the row that fills it. */
  segment: Map<string, KeptRow>;
  segmentRows: number;
  seen: Set<string>;
  dropped: number;
  blocking: number;
}

export interface TaskCaseLedgersInput {
  windowDays?: number;
  /** Stream-opening I/O for the one union pass; tests count opens through it. */
  io?: LedgerUnionStreamIO;
}

/** Stream the three-form union ONCE for every requested task. Every exact task-owned evidence row is retained, and
 * heartbeats only as the rows the status projection reads (W1-T14630); a damaged row refuses only a task it could
 * belong to. No row count refuses or cuts a read. */
export async function readTaskCaseLedgers(
  stateDir: string, taskIds: readonly string[], asOf: string, opts: TaskCaseLedgersInput = {},
): Promise<Map<string, CaseLedgerRead>> {
  const windowDays = opts.windowDays ?? 30;
  if (!Number.isInteger(windowDays) || windowDays < 1) throw new TypeError("case-file windowDays must be a positive integer");
  const windowStart = fixedClock(Date.parse(asOf) - windowDays * 86_400_000).iso();
  const forms = { gzip: 0, plain: 0, live: 0 };
  // `seen` holds every kept or reduced row's fingerprint, so a row a later rotation replays is skipped either way.
  const perTask = new Map(taskIds.map((taskId): [string, TaskRead] => [taskId, { kept: [], segment: new Map(),
    segmentRows: 0, seen: new Set(), dropped: 0, blocking: 0 }]));
  const closeSegment = (task: TaskRead): void => {
    if (task.segmentRows === 0) return;
    const reduced = reduceHeartbeats(task.segment);
    task.dropped += task.segmentRows - reduced.length;
    task.kept.push(...reduced);
    task.segment = new Map();
    task.segmentRows = 0;
  };
  let seq = 0;
  const unread: string[] = [];
  const sources = new Map<string, CaseMalformedSource>();
  let malformed = 0;
  const settle = (reason?: string): Map<string, CaseLedgerRead> => new Map([...perTask].map(([taskId, task]) => {
    const refusal = reason ?? (unread.length ? "ledger-source-unreadable" : task.blocking ? "ledger-source-malformed" : undefined);
    closeSegment(task);
    // Kept rows return in arrival order: the status projection's run-state scan is order-sensitive.
    const rows = refusal ? [] : task.kept.map((entry) => entry.row);
    return [taskId, { rows, state: refusal ? "unavailable" : "observed",
      ...(refusal ? { reason: refusal } : {}), asOf, windowStart, forms: { ...forms }, unread: [...unread], malformed,
      ...(malformed ? { malformedSources: [...sources.values()].map((entry) => ({ ...entry })) } : {}),
      truncated: false, telemetryRowsDropped: task.dropped }];
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
      // Rotations retain replayed lines: a row seen once is neither kept nor counted again.
      const identity = fingerprintLedgerLine(JSON.stringify(row));
      if (task.seen.has(identity)) continue;
      task.seen.add(identity);
      const step = typeof row.step === "string" && CASE_TELEMETRY_STEPS.has(row.step) ? row.step : undefined;
      if (step === undefined) {
        // An evidence row ends the heartbeat segment before it: the fold reads them in that order.
        closeSegment(task);
        task.kept.push({ row, seq: seq++ });
        continue;
      }
      const entry = { row, seq: seq++ };
      const slots = heartbeatSlots(row, step);
      for (const slot of slots.first) if (!task.segment.has(`first|${slot}`)) task.segment.set(`first|${slot}`, entry);
      for (const slot of slots.last) task.segment.set(`last|${slot}`, entry);
      task.segmentRows += 1;
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
