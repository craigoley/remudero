/** Private, metadata-only receipts. The enclosing ledger row owns run/assignment IDs; this
 * envelope deliberately contains neither IDs nor content, and grants no publication rights. */
import { loadConfig } from "./config.js";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { appendLedger } from "./ledger.js";
import { ledgerPathFor } from "./ledger-path.js";
import { isTestRunner } from "./live-write-guard.js";
import { fixedClock } from "./clock.js";
import { readInflightLock, sweepStaleInflightLocks, type InflightLockInfo, type InflightSweepResult } from "./inflight-lock.js";
import { readLedgerUnionRecordsSync } from "./ledger-union.js";
import type { Config } from "./config.js";
import { spawnWorker, workerLedgerFields, type SpawnWorkerArgs, type WorkerResult } from "./worker.js";

export const BENCHMARK_RUN_VERSION = "benchmark-run-v1" as const;

type Evidence<T> = { state: "observed"; value: T } | { state: "unavailable"; reason: string };
type Outcome = { state: "observed"; value: true } | { state: "failed"; value: false } | { state: "unavailable"; reason: string };

const unavailable = (reason: string): { state: "unavailable"; reason: string } => ({ state: "unavailable", reason });

const REVISION_FIELDS = ["harnessRevision", "promptRevision", "toolRevision", "scorerRevision", "environmentRevision"] as const;
const PIN_UNAVAILABLE_REASONS = new Set([
  "executing-module-outside-repository", "executing-source-not-clean", "executing-commit-invalid",
  "executing-module-revision-unavailable", "git-command-unavailable",
  "manifest-not-pinned", "artifact-not-resolved",
]);
export type BenchmarkRevisionField = typeof REVISION_FIELDS[number];
export type BenchmarkRevisionPin = { source: "executing-module-git" | "image-build-stamp" | "resolved-artifact" | "trial-manifest"; revision: string };
export type BenchmarkStackEvidence = Partial<Record<BenchmarkRevisionField,
  BenchmarkRevisionPin | readonly BenchmarkRevisionPin[] | { state: "unavailable"; reason: string }>>;

function pinEvidence(field: BenchmarkRevisionField, input: BenchmarkStackEvidence[BenchmarkRevisionField]): Evidence<string> {
  if (input === undefined) return unavailable("not-pinned-by-harness");
  if (input === null || typeof input !== "object") return unavailable("pin-evidence-invalid");
  if ("state" in input) return unavailable(PIN_UNAVAILABLE_REASONS.has(input.reason) ? input.reason : "pin-unavailable");
  const pins = Array.isArray(input) ? input : [input];
  if (pins.length === 0) return unavailable("pin-evidence-empty");
  const revisions = new Set<string>();
  for (const pin of pins) {
    if (!pin || typeof pin !== "object" || !("source" in pin) || !("revision" in pin)) return unavailable("pin-evidence-invalid");
    if ((pin.source === "executing-module-git" || pin.source === "image-build-stamp") !== (field === "harnessRevision")
      && pin.source !== "trial-manifest") return unavailable("pin-source-invalid-for-field");
    if (!["executing-module-git", "image-build-stamp", "resolved-artifact", "trial-manifest"].includes(pin.source))
      return unavailable("pin-source-invalid");
    if (typeof pin.revision !== "string" || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(pin.revision))
      return unavailable("pin-revision-not-immutable-id");
    revisions.add(pin.revision.toLowerCase());
  }
  return revisions.size === 1 ? { state: "observed", value: [...revisions][0]! } : unavailable("conflicting-pins");
}

/** Attest the module the current process loaded, independent of cwd or an operator checkout.
 * Call once at module load: a later fast-forward cannot change the identity of code in memory.
 * A dirty source tree or an untracked module has no defensible commit identity. */
export function executingHarnessRevision(moduleFile: string,
  git: (cwd: string, args: string[]) => string = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }),
): BenchmarkStackEvidence["harnessRevision"] {
  try {
    const root = git(dirname(moduleFile), ["rev-parse", "--show-toplevel"]).trim();
    const path = relative(root, moduleFile);
    if (!path || path.startsWith("..") || isAbsolute(path)) return unavailable("executing-module-outside-repository");
    git(root, ["ls-files", "--error-unmatch", "--", path]);
    if (git(root, ["status", "--porcelain", "--", "src", "bin", "package.json", "package-lock.json"]).trim())
      return unavailable("executing-source-not-clean");
    const revision = git(root, ["rev-parse", "HEAD"]).trim();
    return /^[0-9a-f]{40}$/i.test(revision)
      ? { source: "executing-module-git", revision } : unavailable("executing-commit-invalid");
  } catch (error) {
    const reason = error instanceof Error && "code" in error && error.code === "ENOENT"
      ? "git-command-unavailable" : "executing-module-revision-unavailable";
    return { state: "unavailable", reason };
  }
}

const nonDispatchWorkerStack: BenchmarkStackEvidence = {
  harnessRevision: executingHarnessRevision(fileURLToPath(import.meta.url)),
};

export function compareBenchmarkStacks(
  left: ReturnType<typeof benchmarkRunAssignmentReceipt>, right: ReturnType<typeof benchmarkRunAssignmentReceipt>,
) {
  const fields = ["provider", "selectedModel", "selectedEffort", ...REVISION_FIELDS] as const;
  const different: string[] = [];
  const missing: string[] = [];
  for (const field of fields) {
    const a = left.stack[field];
    const b = right.stack[field];
    if (a.state !== "observed" || b.state !== "observed") missing.push(field);
    else if (a.value !== b.value) different.push(field);
  }
  return different.length > 0 ? { state: "different-stack" as const, different, missing }
    : missing.length > 0 ? { state: "unavailable" as const, different, missing }
      : { state: "comparable" as const, different, missing };
}

function observedString(value: unknown, reason: string): Evidence<string> {
  return typeof value === "string" && value.trim().length > 0
    ? { state: "observed", value } : unavailable(reason);
}

function observedNonnegative(value: unknown, reason: string): Evidence<number> {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? { state: "observed", value } : unavailable(reason);
}

/** W1-T4618: THE TASK-SHAPE COVARIATE BLOCK. Difficulty is the dominant confounder of every per-model
 * comparison, and an assignment carried only taskClass and risk. This block is built at assignment from
 * data already in hand — counts and small enums, never free text, never a path below its top-level area.
 * A covariate that cannot be computed is `unavailable` with a reason: never 0, never omitted.
 * Buckets: declared files and acceptance criteria 0 / 1 / 2-3 / 4-7 / 8+; depends_on depth 0 / 1 / 2 / 3+;
 * attempt number 1 / 2 / 3+; prior strikes 0 / 1 / 2+. Attempt and strike counts read the LIVE ledger
 * only (`basis: "live-ledger"`), so rotation makes them lower bounds. No recon report carries a size
 * estimate, so `reconSizeEstimate` is a counted coverage gap whose reason says why. */
export const TASK_SHAPE_VERSION = "task-shape-v1" as const;

/** BACKSTOP (W1-T4618): the most top-level areas one block names; the tail folds into `other`, so a
 *  repo-wide task cannot mint an unbounded stratum. */
export const TASK_SHAPE_AREAS_MAX = 6;

/** BACKSTOP (W1-T4618): the longest depends_on chain walked before depth is recorded unavailable. */
export const TASK_SHAPE_DEPENDS_DEPTH_MAX = 64;

/** An area, lane or repo name the block may carry verbatim; anything else is not a bounded token. */
export const TASK_SHAPE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/** The executable proof dialects; a proof with none of these prefixes is prose. */
export const PROOF_DIALECT_PREFIX_RE = /^(unit test|grep|demonstration):/i;

function cappedBucket(n: number, cap: number): string {
  return n >= cap ? `${cap}+` : String(n);
}

export function taskShapeCountBucket(n: number): TaskShapeCountBucket {
  return n <= 0 ? "0" : n === 1 ? "1" : n <= 3 ? "2-3" : n <= 7 ? "4-7" : "8+";
}

export type TaskShapeCountBucket = "0" | "1" | "2-3" | "4-7" | "8+";
export type TaskShapeProofDialect = "unit-test" | "grep" | "demonstration" | "prose" | "absent";
export type TaskShapeRecon = "ran" | "reused" | "degraded" | "masked";
export interface TaskShapeTask {
  id?: string;
  repo?: string;
  files?: readonly string[];
  acceptance?: readonly { proof?: string }[];
  depends_on?: readonly string[];
}
export interface TaskShapeInput {
  task?: TaskShapeTask;
  /** The plan's records, for depends_on depth; absent ⇒ depth is unavailable. */
  tasks?: readonly { id: string; depends_on?: readonly string[] }[];
  ledgerRows?: ReadonlyArray<Record<string, unknown>>;
  ledgerUnavailableReason?: string;
  /** True when this run's own `run.start` is already in `ledgerRows` (the fix rung), false at dispatch. */
  runStartWritten?: boolean;
  lane?: string;
  reconUnavailableReason?: string;
}

export function topLevelArea(path: string): string {
  const trimmed = path.trim().replace(/^\.\//, "");
  const slash = trimmed.indexOf("/");
  if (slash < 0) return "root";
  const head = trimmed.slice(0, slash);
  return TASK_SHAPE_TOKEN_RE.test(head) ? head : "other";
}

export function proofDialect(proof: unknown): TaskShapeProofDialect {
  const trimmed = typeof proof === "string" ? proof.trim() : "";
  if (!trimmed) return "absent";
  const prefix = PROOF_DIALECT_PREFIX_RE.exec(trimmed)?.[1]?.toLowerCase();
  return prefix === "unit test" ? "unit-test" : prefix === "grep" ? "grep"
    : prefix === "demonstration" ? "demonstration" : "prose";
}

function dependsOnDepth(task: TaskShapeTask, tasks: TaskShapeInput["tasks"]): Evidence<{ depth: number; bucket: string }> {
  if (!tasks) return unavailable("plan-not-in-hand");
  if (!Array.isArray(task.depends_on)) return unavailable("depends-on-not-declared");
  let byId: Map<string, readonly string[]>;
  const memo = new Map<string, number>();
  const visiting = new Set<string>([task.id ?? ""]);
  const walk = (deps: readonly string[], level: number): number => {
    if (level > TASK_SHAPE_DEPENDS_DEPTH_MAX) throw new RangeError("depends-on-depth-bound");
    let deepest = 0;
    for (const id of deps) {
      if (visiting.has(id)) throw new RangeError("depends-on-cycle");
      let depth = memo.get(id);
      if (depth === undefined) {
        visiting.add(id);
        depth = 1 + walk(byId.get(id) ?? [], level + 1);
        visiting.delete(id);
        memo.set(id, depth);
      }
      deepest = Math.max(deepest, depth);
    }
    return deepest;
  };
  try {
    byId = new Map(tasks.map((t) => [t.id, t.depends_on ?? []]));
    const depth = walk(task.depends_on, 1);
    return { state: "observed", value: { depth, bucket: cappedBucket(depth, 3) } };
  } catch (error) {
    const reason = error instanceof RangeError ? error.message : "depends-on-walk-failed";
    return unavailable(reason);
  }
}

function tokenEvidence(value: unknown, missing: string, invalid: string): Evidence<string> {
  if (typeof value !== "string" || value.length === 0) return unavailable(missing);
  return TASK_SHAPE_TOKEN_RE.test(value) ? { state: "observed", value } : unavailable(invalid);
}

/** The bounded covariate block (see {@link TASK_SHAPE_VERSION}). `missing` names why every covariate
 *  whose source was not supplied at all is unavailable — a lane with no task record says so here. */
export function taskShapeCovariates(input: TaskShapeInput, missing = "task-not-in-hand") {
  const task = input.task;
  const files = task?.files;
  const acceptance = task?.acceptance;
  const taskId = typeof task?.id === "string" && task.id.length > 0 ? task.id : undefined;
  let starts = 0;
  let strikes = 0;
  for (const row of input.ledgerRows ?? []) {
    if (taskId === undefined || row.task_id !== taskId) continue;
    if (row.step === "run.start") starts += 1;
    else if (row.step === "fix.dispatch") strikes += 1;
  }
  const ledgerMissing = taskId === undefined ? missing : input.ledgerUnavailableReason ?? "ledger-not-in-hand";
  const attempt = input.runStartWritten ? starts : starts + 1;
  const areas = [...new Set((files ?? []).map(topLevelArea))].sort();
  const boundedAreas = areas.length > TASK_SHAPE_AREAS_MAX
    ? [...new Set([...areas.slice(0, TASK_SHAPE_AREAS_MAX - 1), "other"])].sort() : areas;
  const reconReason = input.reconUnavailableReason ?? missing;
  const counted = (count: number) => ({ count, bucket: taskShapeCountBucket(count) });
  return {
    version: TASK_SHAPE_VERSION,
    declaredFiles: !task ? unavailable(missing) : !Array.isArray(files) ? unavailable("files-not-declared")
      : { state: "observed" as const, value: counted(files.length) },
    topLevelAreas: !task ? unavailable(missing) : !Array.isArray(files) ? unavailable("files-not-declared")
      : { state: "observed" as const, value: boundedAreas },
    acceptanceCriteria: !task ? unavailable(missing) : !Array.isArray(acceptance) ? unavailable("acceptance-not-declared")
      : { state: "observed" as const, value: counted(acceptance.length) },
    proofDialects: !task ? unavailable(missing) : !Array.isArray(acceptance) ? unavailable("acceptance-not-declared")
      : { state: "observed" as const, value: [...new Set(acceptance.map((c) => proofDialect(c?.proof)))].sort() },
    dependsOnDepth: !task ? unavailable(missing) : dependsOnDepth(task, input.tasks),
    attemptNumber: !input.ledgerRows || taskId === undefined ? unavailable(ledgerMissing)
      : attempt < 1 ? unavailable("run-start-not-in-live-ledger")
        : { state: "observed" as const, value: { count: attempt, bucket: cappedBucket(attempt, 3), basis: "live-ledger" as const } },
    priorStrikes: !input.ledgerRows || taskId === undefined ? unavailable(ledgerMissing)
      : { state: "observed" as const, value: { count: strikes, bucket: cappedBucket(strikes, 2), basis: "live-ledger" as const } },
    lane: tokenEvidence(input.lane, missing, "lane-not-a-token"),
    repo: !task ? unavailable(missing) : tokenEvidence(task.repo, "repo-not-declared", "repo-not-a-token"),
    recon: unavailable(reconReason) as Evidence<TaskShapeRecon>,
    reconSizeEstimate: unavailable(reconReason),
  };
}

export type TaskShapeCovariates = ReturnType<typeof taskShapeCovariates>;

function isTaskShape(value: unknown): value is TaskShapeCovariates {
  return value !== null && typeof value === "object" && (value as { version?: unknown }).version === TASK_SHAPE_VERSION;
}

/** The task's own rows from the live ledger, or the reason they cannot be counted. A torn line that names
 *  the task could be one of its run.starts, so it makes the counts unavailable rather than low. */
function taskLedgerRows(ledgerPath: string, taskId: string): { rows?: Record<string, unknown>[]; reason?: string } {
  if (!existsSync(ledgerPath)) return { rows: [] };
  const needle = JSON.stringify(taskId);
  const rows: Record<string, unknown>[] = [];
  for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
    if (!line.includes(needle)) continue;
    try {
      rows.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      const reason = "torn-ledger-line-names-task";
      return { reason };
    }
  }
  return { rows };
}

/** The block a dispatching lane records: reads the live ledger itself for attempt and strike counts,
 *  and never throws — a failure is a block of named gaps, not a blocked dispatch. */
export function dispatchTaskShape(input: Omit<TaskShapeInput, "ledgerRows" | "ledgerUnavailableReason"> & { ledgerPath?: string }): TaskShapeCovariates {
  let ledger: { rows?: Record<string, unknown>[]; reason?: string } = { reason: "ledger-not-in-hand" };
  try {
    if (input.ledgerPath !== undefined && input.task?.id) ledger = taskLedgerRows(input.ledgerPath, input.task.id);
  } catch {
    const reason = "ledger-unreadable";
    ledger = { reason };
  }
  try {
    return taskShapeCovariates({ ...input, ledgerRows: ledger.rows, ledgerUnavailableReason: ledger.reason });
  } catch {
    const reason = "task-shape-build-failed";
    return taskShapeCovariates({ lane: input.lane }, reason);
  }
}

/** The fix rung's block: its task record is in hand and its dispatch's run.start is already ledgered. */
export function fixLaneBenchmarkWork(task: TaskShapeTask, ledgerPath: string): BenchmarkWorkInput {
  return { shape: dispatchTaskShape({ task, ledgerPath, lane: "fix", runStartWritten: true,
    reconUnavailableReason: "fix-lane-does-not-observe-recon" }) };
}

const RECON_STEP_STATES: Readonly<Record<string, TaskShapeRecon>> = {
  "recon.done": "ran", "recon.reused": "reused", "recon.degraded": "degraded", "recon.masked": "masked",
};
const RECON_SIZE_GAPS: Readonly<Record<TaskShapeRecon, string>> = {
  ran: "recon-report-has-no-size-estimate", reused: "recon-report-has-no-size-estimate",
  degraded: "recon-degraded-no-report", masked: "recon-masked",
};

export interface BenchmarkWorkInput { taskClass?: string; risk?: string; shape?: TaskShapeCovariates }

/** What an assignment receipt knows about the work so far: `run.start` sets class, risk and shape, and
 *  each recon step marks the shape's recon state for the assignments that follow it. */
export function observeBenchmarkWork(work: BenchmarkWorkInput, step: string, extra: Record<string, unknown>): BenchmarkWorkInput {
  if (step === "run.start") {
    return {
      ...(typeof extra.task_class === "string" ? { taskClass: extra.task_class } : {}),
      ...(typeof extra.risk === "string" ? { risk: extra.risk } : {}),
      ...(isTaskShape(extra.task_shape) ? { shape: extra.task_shape } : {}),
    };
  }
  const recon = Object.hasOwn(RECON_STEP_STATES, step) ? RECON_STEP_STATES[step] : undefined;
  if (!recon || !work.shape) return work;
  return { ...work, shape: { ...work.shape, recon: { state: "observed", value: recon },
    reconSizeEstimate: unavailable(RECON_SIZE_GAPS[recon]) } };
}

/** A non-dispatch lane has a lane name and no task record: every other covariate is a named gap. */
export function nonDispatchBenchmarkWork(lane: string): BenchmarkWorkInput {
  return { shape: taskShapeCovariates({ lane }, "non-dispatch-lane-has-no-task-record") };
}

export interface BenchmarkRunAssignmentInput {
  id: string;
  requested: { model: string; effort: string };
  selected: { provider: string; model: string; effort: string };
}

export function benchmarkRunAssignmentReceipt(
  assignment: BenchmarkRunAssignmentInput,
  work: BenchmarkWorkInput,
  stackEvidence: BenchmarkStackEvidence = {},
) {
  // No inference from checkout HEAD, route, or site-level consent: none of those pins the
  // actual prompt/tools/scorer used by this worker call or grants this instance publication.
  return {
    version: BENCHMARK_RUN_VERSION,
    phase: "assignment" as const,
    work: {
      taskClass: observedString(work.taskClass, "not-recorded-at-assignment"),
      risk: observedString(work.risk, "not-recorded-at-assignment"),
      shape: isTaskShape(work.shape) ? work.shape
        : taskShapeCovariates({}, work.shape === undefined ? "task-shape-not-supplied-by-caller" : "task-shape-invalid"),
    },
    stack: {
      provider: observedString(assignment.selected.provider, "routing-provider-unavailable"),
      requestedModel: observedString(assignment.requested.model, "requested-model-unavailable"),
      selectedModel: observedString(assignment.selected.model, "selected-model-unavailable"),
      requestedEffort: observedString(assignment.requested.effort, "requested-effort-unavailable"),
      selectedEffort: observedString(assignment.selected.effort, "selected-effort-unavailable"),
      harnessRevision: pinEvidence("harnessRevision", stackEvidence.harnessRevision),
      promptRevision: pinEvidence("promptRevision", stackEvidence.promptRevision),
      toolRevision: pinEvidence("toolRevision", stackEvidence.toolRevision),
      scorerRevision: pinEvidence("scorerRevision", stackEvidence.scorerRevision),
      environmentRevision: pinEvidence("environmentRevision", stackEvidence.environmentRevision),
    },
    rights: { state: "private" as const, reason: "no-local-consent-receipt" },
    allocation: { method: "observational" as const, reason: "no-random-allocation-receipt" },
  };
}

function callEvidence(row: Record<string, unknown>) {
  const rawTokens = row.tokens && typeof row.tokens === "object" && !Array.isArray(row.tokens)
    ? row.tokens as Record<string, unknown> : undefined;
  const input = observedNonnegative(rawTokens?.input, "worker-tokens-not-reported");
  const output = observedNonnegative(rawTokens?.output, "worker-tokens-not-reported");
  const tokens: Evidence<{ input: number; output: number }> = input.state === "observed" && output.state === "observed"
    ? { state: "observed", value: { input: input.value, output: output.value } }
    : unavailable("worker-tokens-not-reported");
  const workerCall: Outcome = row.success === true ? { state: "observed", value: true }
    : row.success === false ? { state: "failed", value: false }
      : unavailable("worker-outcome-not-reported");
  const cost = observedNonnegative(row.total_cost_usd, "worker-cost-not-reported");
  const billingMode = row.billing_mode === "api" || row.billing_mode === "subscription"
    ? row.billing_mode : undefined;
  const otherMode = unavailable("different-billing-mode");
  return {
    workerCall,
    servedModel: observedString(row.served_model, "provider-did-not-report-served-model"),
    tokens,
    durationMs: observedNonnegative(row.worker_duration_ms, "worker-duration-not-reported"),
    accounting: {
      source: "worker-result-estimate-not-invoice" as const,
      billingMode: billingMode ? { state: "observed" as const, value: billingMode } : unavailable("billing-mode-not-reported"),
      apiCostUsd: billingMode === "api" ? cost : billingMode ? otherMode : unavailable("billing-mode-not-reported"),
      subscriptionNotionalUsd: billingMode === "subscription" ? cost : billingMode ? otherMode : unavailable("billing-mode-not-reported"),
    },
  };
}

/** Keep the billing derivation at the canonical worker boundary, including cash-provider calls.
 * An empty result envelope carries default usage zeros, not observations. Codex CLI currently
 * supplies zero placeholders when dollars or token usage are not reported. */
export function benchmarkWorkerAttemptResources(result: WorkerResult) {
  const fields = workerLedgerFields(result);
  const observedEnvelope = typeof result.subtype === "string" && result.subtype.length > 0;
  const codexPlaceholder = result.provider === "codex";
  const costObserved = observedEnvelope && !(codexPlaceholder && result.costUsd === 0);
  const tokensObserved = observedEnvelope && !(codexPlaceholder && result.tokens.input === 0
    && result.tokens.output === 0 && result.tokens.cacheRead === 0 && result.tokens.cacheCreation === 0);
  return {
    served_model: fields.served_model,
    worker_duration_ms: fields.worker_duration_ms,
    ...(observedEnvelope ? { billing_mode: fields.billing_mode } : {}),
    ...(tokensObserved ? { tokens: fields.tokens } : {}),
    ...(costObserved ? { total_cost_usd: fields.total_cost_usd } : {}),
  };
}

/** One worker call, including non-final recon/repair calls. This is not a verified task outcome. */
export function benchmarkRunAttemptReceipt(row: Record<string, unknown>) {
  if (row.step !== "worker.attempt") return undefined;
  return {
    version: BENCHMARK_RUN_VERSION,
    phase: "attempt" as const,
    assignmentJoin: row.assignment_observed === false
      ? unavailable("assignment-not-observed-in-run")
      : typeof row.selection_assignment_id === "string" && row.selection_assignment_id.length > 0
      ? { state: "observed" as const, value: true as const }
      : unavailable("assignment-id-not-reported"),
    ...callEvidence(row),
  };
}

export function benchmarkRunTerminalReceipt(row: Record<string, unknown>, assignmentObserved: boolean) {
  // The task verdict is distinct from each worker-attempt receipt. Legacy consumers retain
  // this phase until the cohort builder can join end-to-end verification separately.
  if (row.step !== "verdict" || !assignmentObserved || typeof row.selection_assignment_id !== "string"
    || row.selection_assignment_id.length === 0) return undefined;
  return { version: BENCHMARK_RUN_VERSION, phase: "terminal" as const, ...callEvidence(row) };
}

/** W1-T4613: set on a spawn's args by a caller that writes that worker's assignment + attempt
 * receipts itself (the fix rung), so a receipt-writing wrapper beneath it stands aside instead of
 * receipting one worker call twice. A symbol survives every wrapper's args spread and never
 * reaches a serialized ledger row. */
export const CALLER_OWNS_BENCHMARK_RECEIPT: unique symbol = Symbol("rmd.callerOwnsBenchmarkReceipt");

export function withCallerOwnedReceipt(args: SpawnWorkerArgs): SpawnWorkerArgs {
  return { ...args, [CALLER_OWNS_BENCHMARK_RECEIPT]: true } as SpawnWorkerArgs;
}

export function callerOwnsBenchmarkReceipt(args: SpawnWorkerArgs): boolean {
  return (args as { [CALLER_OWNS_BENCHMARK_RECEIPT]?: boolean })[CALLER_OWNS_BENCHMARK_RECEIPT] === true;
}

/** W1-T4645: the task and run a judge lane's receipts name. Symbol-keyed like the marker above, so
 *  it rides every args spread to the receipt wrapper and never reaches the router, which seeds its
 *  auction draw on `taskId`/`runId` (`auctionDrawSeed`): naming the run cannot move the provider,
 *  model or effort that serves it. */
export const BENCHMARK_RECEIPT_IDENTITY: unique symbol = Symbol("rmd.benchmarkReceiptIdentity");

export function withReceiptIdentity(args: SpawnWorkerArgs, identity: { taskId: string; runId: string }): SpawnWorkerArgs {
  return { ...args, [BENCHMARK_RECEIPT_IDENTITY]: { ...identity } } as SpawnWorkerArgs;
}

export function receiptIdentity(args: SpawnWorkerArgs): { taskId?: string; runId?: string } {
  return (args as { [BENCHMARK_RECEIPT_IDENTITY]?: { taskId: string; runId: string } })[BENCHMARK_RECEIPT_IDENTITY] ?? {};
}

/** W1-T4616: where a worker-call receipt may be written. MEASURED 2026-09-27: most of the ~105/h
 *  `spawn-threw-before-result` rows came from TEST processes — a suite under `node --test` that
 *  reached a real judge spawn with no explicit config resolved the default config's root, which is
 *  the operator's or daemon's LIVE ledger, and wrote fake failed attempts into production evidence.
 *  Under the test runner, only an explicitly supplied config names an evidence ledger. */
export function benchmarkEvidenceLedgerPath(
  config: Config | undefined, load: () => Config = loadConfig,
): string | undefined {
  if (config) return ledgerPathFor(config);
  return isTestRunner() ? undefined : ledgerPathFor(load());
}

/** PRIMARY CONTROL (W1-T4616): the longest redacted error message a failed-spawn receipt keeps. */
export const SPAWN_FAILURE_MESSAGE_MAX_CHARS = 240;

/** W1-T4616: the cause of a spawn that threw before returning — its class, code and a bounded message
 *  with paths, credentials and long tokens redacted — and whether it failed before any model was
 *  selected, so the attempt is a counted coverage gap rather than a model's failure. */
export function spawnFailureDetail(error: unknown, assignmentObserved: boolean): Record<string, unknown> {
  const errorClass = error instanceof Error ? error.constructor.name || "Error" : typeof error;
  const code = error !== null && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code : undefined;
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw
    .replace(/\b(?:sk|ghp|gho|ghs|ghu|xox[abp])[-_][A-Za-z0-9_-]{6,}/g, "<secret>")
    .replace(/(?:~|\.{1,2})?(?:\/[^\s/:'"`]+){2,}\/?/g, "<path>")
    .replace(/[A-Za-z0-9+_=-]{32,}/g, "<token>")
    .replace(/\s+/g, " ").trim().slice(0, SPAWN_FAILURE_MESSAGE_MAX_CHARS);
  return { pre_selection: !assignmentObserved, error_class: errorClass, ...(code ? { error_code: code } : {}), error_message: message };
}

/** W1-T4639: the join half of a `worker.attempt` receipt — the assignment id it answers, or a named
 *  reason the row can carry none: the spawn threw before any assignment was written, or a result came
 *  back with no assignment observed. An attempt row is never silently unjoined. */
export function attemptAssignmentJoin(assignmentId: string | undefined, threw: boolean): Record<string, string> {
  if (assignmentId) return { selection_assignment_id: assignmentId };
  return { selection_assignment_unavailable_reason: threw ? "spawn-threw-before-assignment" : "assignment-not-observed" };
}

/** Capture an auxiliary worker call without turning telemetry into a worker or PR gate. The
 * caller's existing assignment sink remains authoritative when one is supplied. */
export function benchmarkNonDispatchSpawn(
  lane: string, raw: typeof spawnWorker = spawnWorker,
): typeof spawnWorker {
  return async (args) => {
    // W1-T4613: the caller already receipts this worker; a second pair would count it twice.
    if (callerOwnsBenchmarkReceipt(args)) return raw(args);
    let observedAssignmentId: string | undefined;
    const named = receiptIdentity(args);
    const write = (step: string, fields: Record<string, unknown>): void => {
      const path = benchmarkEvidenceLedgerPath(args.config);
      if (path === undefined) return;
      appendLedger(path, {
        run_id: args.runId ?? named.runId ?? `${lane}-${observedAssignmentId ?? "unassigned"}`,
        task_id: args.taskId ?? named.taskId ?? lane.toUpperCase(), step, lane, ...fields,
      });
    };
    const recordAttempt = (fields: Record<string, unknown>): void => {
      try {
        const row = { step: "worker.attempt", ...fields,
          assignment_observed: fields.selection_assignment_id === observedAssignmentId && observedAssignmentId !== undefined };
        write("worker.attempt", { ...fields, benchmark_run: benchmarkRunAttemptReceipt(row) });
      } catch {
        // A missing sink is coverage debt, never a reason to retry or change the worker result.
        console.error(JSON.stringify({ event: "benchmark.non_dispatch_attempt_unavailable", lane, reason: "ledger-write-failed" }));
      }
    };
    let result: WorkerResult;
    try {
      result = await raw({ ...args, onSelectionAssignment: (assignment) => {
        const priorId = observedAssignmentId;
        observedAssignmentId = assignment.id;
        try {
          write("worker.assignment", { worker_assignment: assignment,
            benchmark_run: benchmarkRunAssignmentReceipt(assignment, nonDispatchBenchmarkWork(lane), nonDispatchWorkerStack) });
        } catch {
          observedAssignmentId = priorId;
          console.error(JSON.stringify({ event: "benchmark.non_dispatch_assignment_unavailable", lane, reason: "ledger-write-failed" }));
        }
        // A failed benchmark sink must not skip the caller's existing assignment callback.
        args.onSelectionAssignment?.(assignment);
      }, onModelFallbackAttempt: (attempt) => {
        let resources: Record<string, unknown> = {};
        try { if (attempt.result) resources = benchmarkWorkerAttemptResources(attempt.result); }
        catch (error) {
          resources = { benchmark_run_unavailable_reason: "worker-result-fields-unavailable" };
          console.error(JSON.stringify({ event: "benchmark.non_dispatch_resource_unavailable", lane,
            reason: "worker-result-fields-unavailable",
            error_class: error instanceof TypeError ? "TypeError" : error instanceof Error ? "Error" : "non-error" }));
        }
        recordAttempt({ ...attemptAssignmentJoin(attempt.selectionAssignmentId, false),
          attempted_model: attempt.model, success: false, worker_failure: attempt.reason, ...resources });
        try { args.onModelFallbackAttempt?.(attempt); }
        catch { console.error(JSON.stringify({ event: "benchmark.non_dispatch_fallback_hook_unavailable", lane })); }
      } });
    } catch (error) {
      recordAttempt({ ...attemptAssignmentJoin(observedAssignmentId, true),
        success: false, worker_failure: "spawn-threw-before-result",
        ...spawnFailureDetail(error, observedAssignmentId !== undefined) });
      throw error;
    }
    const assignmentId = result.selectionAssignmentId ?? observedAssignmentId;
    const observedEnvelope = typeof result.subtype === "string" && result.subtype.length > 0;
    let resources: Record<string, unknown>;
    try { resources = benchmarkWorkerAttemptResources(result); }
    catch (error) {
      resources = { benchmark_run_unavailable_reason: "worker-result-fields-unavailable" };
      console.error(JSON.stringify({ event: "benchmark.non_dispatch_resource_unavailable", lane,
        reason: "worker-result-fields-unavailable",
        error_class: error instanceof TypeError ? "TypeError" : error instanceof Error ? "Error" : "non-error" }));
    }
    recordAttempt({ ...attemptAssignmentJoin(assignmentId, false),
      ...(result.isError || result.apiError || result.usageRefusal ? { success: false }
        : observedEnvelope ? { success: true } : {}), ...resources });
    return result;
  };
}

/** W1-T4644: the failure an orphaned assignment's receipt names — its worker died with its process. */
export const ORPHANED_BY_PROCESS_EXIT = "orphaned-by-process-exit";
const ORPHAN_EVIDENCE_REASON = "worker-process-exited-before-result";

/** The trailing epoch-ms stamp every minted run id carries (`<task>-<ms>`, `review-PR<n>-<ms>`). */
export const RUN_ID_EPOCH_RE = /-(\d{13})$/;

export interface OrphanedRun { runId: string; taskId: string; startedAt?: string; detectedBy: string }

/** The earliest instant the run can have written a row: its run id's stamp or its lock's start. */
export function orphanedRunWindowStart(run: Pick<OrphanedRun, "runId" | "startedAt">): string | undefined {
  const starts: number[] = [];
  const stamp = RUN_ID_EPOCH_RE.exec(run.runId)?.[1];
  if (stamp !== undefined) starts.push(Number(stamp));
  const locked = run.startedAt === undefined ? Number.NaN : Date.parse(run.startedAt);
  if (Number.isFinite(locked)) starts.push(locked);
  return starts.length === 0 ? undefined : fixedClock(Math.min(...starts)).iso();
}

/** The run's `worker.assignment` rows that no `worker.attempt` answers, one per assignment id. */
export function unreceiptedAssignments(rows: ReadonlyArray<Record<string, unknown>>, runId: string): Record<string, unknown>[] {
  const receipted = new Set<string>();
  const assignments = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (row.run_id !== runId) continue;
    if (row.step === "worker.attempt" && typeof row.selection_assignment_id === "string") receipted.add(row.selection_assignment_id);
    const assignment = row.step === "worker.assignment" ? row.worker_assignment as { id?: unknown } | undefined : undefined;
    const id = assignment && typeof assignment === "object" ? assignment.id : undefined;
    if (typeof id === "string" && id.length > 0 && !assignments.has(id)) assignments.set(id, row);
  }
  return [...assignments].filter(([id]) => !receipted.has(id)).map(([, row]) => row);
}

/** The receipt an orphaned assignment gets: a failed call whose resources are named gaps, not zeros. */
export function orphanedAttemptFields(assignmentId: string, detectedBy: string): Record<string, unknown> {
  const gap = unavailable(ORPHAN_EVIDENCE_REASON);
  const fields = { ...attemptAssignmentJoin(assignmentId, false), success: false, worker_failure: ORPHANED_BY_PROCESS_EXIT,
    orphan_detected_by: detectedBy, served_model_unavailable_reason: ORPHAN_EVIDENCE_REASON,
    billing_mode_unavailable_reason: ORPHAN_EVIDENCE_REASON, cost_unavailable_reason: ORPHAN_EVIDENCE_REASON };
  const receipt = benchmarkRunAttemptReceipt({ step: "worker.attempt", ...fields })!;
  return { ...fields, benchmark_run: { ...receipt, servedModel: gap, tokens: gap, durationMs: gap,
    accounting: { source: receipt.accounting.source, billingMode: gap, apiCostUsd: gap, subscriptionNotionalUsd: gap } } };
}

/** W1-T4644: write one receipt per unreceipted assignment of a run found orphaned. Reads only the
 *  run's own window of the ledger union, and writes nothing when that read is partial or torn,
 *  so a receipt it cannot see is never duplicated. Never throws: a receipt is evidence, not reclaim. */
export function receiptOrphanedAssignments(run: OrphanedRun, ledgerPath: string): { written: number; reason?: string } {
  let written = 0;
  try {
    const sinceTs = orphanedRunWindowStart(run);
    if (sinceTs === undefined) return { written, reason: "run-window-unknown" };
    const needle = JSON.stringify(run.runId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const read = readLedgerUnionRecordsSync(dirname(ledgerPath), { sinceTs, pattern: new RegExp(needle),
      step: ["worker.assignment", "worker.attempt"], refuseIncomplete: true });
    if (!read.ok || read.torn > 0) return { written, reason: "run-ledger-window-incomplete" };
    for (const row of unreceiptedAssignments(read.rows, run.runId)) {
      const id = (row.worker_assignment as { id: string }).id;
      appendLedger(ledgerPath, { run_id: run.runId, task_id: typeof row.task_id === "string" ? row.task_id : run.taskId,
        step: "worker.attempt", ...(typeof row.lane === "string" ? { lane: row.lane } : {}), ...orphanedAttemptFields(id, run.detectedBy) });
      written += 1;
    }
    return { written };
  } catch {
    const reason = "orphan-receipt-failed";
    return { written, reason };
  }
}

/** The in-flight lock sweep, receipting each reaped lock's run: its holder died without releasing it. */
export function sweepInflightLocksWithReceipts(inflightDir: string, ledgerPath: string): InflightSweepResult {
  const holders = new Map<string, InflightLockInfo>();
  const entries = existsSync(inflightDir) ? readdirSync(inflightDir) : [];
  for (const entry of entries.filter((name) => name.endsWith(".lock"))) {
    const holder = readInflightLock(inflightDir, entry.slice(0, -".lock".length));
    if (holder) holders.set(entry.slice(0, -".lock".length), holder);
  }
  const swept = sweepStaleInflightLocks(inflightDir);
  for (const taskId of swept.reaped) {
    const holder = holders.get(taskId);
    if (holder) receiptOrphanedAssignments({ runId: holder.run_id, taskId, startedAt: holder.startedAt,
      detectedBy: "inflight-lock-sweep" }, ledgerPath);
  }
  return swept;
}
