/** Private component execution, separate from whole-fix adoption and causal efficacy. */
import { createHash, randomUUID } from "node:crypto";
import { systemClock } from "./clock.js";
import { importedModuleOf, type ImportedModuleEvidence } from "./prevention-source-evidence.js";
import type { RepairCostContext } from "./repair-cost-evidence.js";

const COMPONENT = "ci-log-named-source-paths";
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const time = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const token = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/.test(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const object = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const hashFunction = (fn: Function) => createHash("sha256").update(Function.prototype.toString.call(fn)).digest("hex");
const processInstanceId = randomUUID();

export interface CiRemedyComponent {
  caller: ImportedModuleEvidence;
  functionSha256: string;
  dependencies: { existsSyncSha256: string; joinSha256: string; nodeVersion: string };
}
/** Capture the exact lexical function and imported dependencies once with the caller's source pin.
 * These hashes identify JS function representations; nodeVersion is not a binary attestation. */
export function captureCiRemedyComponent(caller: ImportedModuleEvidence | undefined,
  guard: Function, exists: Function, join: Function): CiRemedyComponent {
  return { caller: importedModuleOf(caller), functionSha256: hashFunction(guard),
    dependencies: { existsSyncSha256: hashFunction(exists), joinSha256: hashFunction(join), nodeVersion: process.version } };
}

type Unavailable = { state: "unavailable"; reason: string };
export type CiRemedyExecution = { state: "observed"; version: "ci-remedy-execution-v1";
  component: typeof COMPONENT; lineageTask: "W1-T5801"; invocationId: string; at: string;
  processInstanceId: string; pid: number; callerRunId: string; identity: CiRemedyComponent;
  inputs: { failingChecks: number; matchedPaths: number; reachablePaths: number;
    ownership: "compared" | "no-base" | "unreadable" } } | Unavailable;

/** Call only after the real guard and main-ownership filter return, using their actual counts.
 * No log text, repository directory or named remedy path enters the evidence. */
export function recordCiRemedyExecution(identity: CiRemedyComponent, callerRunId: string,
  inputs: Extract<CiRemedyExecution, { state: "observed" }>["inputs"]): CiRemedyExecution {
  return ciRemedyExecutionOf({ state: "observed", version: "ci-remedy-execution-v1", component: COMPONENT,
    lineageTask: "W1-T5801", invocationId: randomUUID(), at: systemClock.iso(),
    processInstanceId, pid: process.pid, callerRunId, identity, inputs });
}

/** Strict projection: a name, a loaded function object or a missing field is not an execution. */
export function ciRemedyExecutionOf(value: unknown): CiRemedyExecution {
  const r = object(value), identity = object(r?.identity), dependencies = object(identity?.dependencies), inputs = object(r?.inputs);
  if (!r || !identity || !dependencies || !inputs) return { state: "unavailable", reason: "qualifying-component-execution-not-recorded" };
  const caller = importedModuleOf(identity.caller);
  if (r?.state !== "observed" || r.version !== "ci-remedy-execution-v1" || r.component !== COMPONENT
    || r.lineageTask !== "W1-T5801" || !UUID.test(String(r.invocationId)) || !UUID.test(String(r.processInstanceId))
    || !count(r.pid) || r.pid === 0 || !token(r.callerRunId) || !time(r.at)
    || caller.state !== "observed" || caller.path !== "src/run-task.ts" || Date.parse(caller.capturedAt) > Date.parse(r.at)
    || !SHA256.test(String(identity.functionSha256)) || !SHA256.test(String(dependencies.existsSyncSha256))
    || !SHA256.test(String(dependencies.joinSha256)) || typeof dependencies.nodeVersion !== "string"
    || !/^v\d+\.\d+\.\d+$/.test(dependencies.nodeVersion)
    || !count(inputs.failingChecks) || !count(inputs.matchedPaths) || !count(inputs.reachablePaths)
    || inputs.matchedPaths > 5 || inputs.reachablePaths > inputs.matchedPaths
    || (inputs.failingChecks === 0 && inputs.matchedPaths !== 0)
    || !["compared", "no-base", "unreadable"].includes(String(inputs.ownership))
    || (inputs.ownership === "unreadable" && inputs.reachablePaths !== 0))
    return { state: "unavailable", reason: "qualifying-component-execution-not-recorded" };
  return { state: "observed", version: "ci-remedy-execution-v1", component: COMPONENT, lineageTask: "W1-T5801",
    invocationId: String(r.invocationId), at: r.at, processInstanceId: String(r.processInstanceId), pid: r.pid,
    callerRunId: r.callerRunId, identity: { caller, functionSha256: String(identity!.functionSha256),
      dependencies: { existsSyncSha256: String(dependencies.existsSyncSha256), joinSha256: String(dependencies.joinSha256), nodeVersion: dependencies.nodeVersion } },
    inputs: { failingChecks: inputs.failingChecks, matchedPaths: inputs.matchedPaths, reachablePaths: inputs.reachablePaths,
      ownership: inputs.ownership as "compared" | "no-base" | "unreadable" } };
}

interface ExecutionRow { step: string; ts: string | null; host: string | null; runId?: string | null;
  assignmentId: string | null; success: boolean | null; repair?: RepairCostContext; remedyExecution?: CiRemedyExecution }
/** BACKSTOP: per-pass retained component invocations. Overflow is explicit, never a fleet denominator. */
export const CI_REMEDY_EXECUTIONS_MAX = 128;

/** Uses the existing bounded ledger corpus. The registration's older whole-file identity remains
 * untouched. lineageTask is a historical reference, not certification that all of W1-T5801 runs. */
export function ciRemedyExecutionReport(rows: readonly ExecutionRow[], asOf: string) {
  type Work = { at: string; workerRunId: string; assignmentId: string; roundId: string; success: boolean };
  type Item = { host: string; execution: Extract<CiRemedyExecution, { state: "observed" }>; conflict: boolean;
    laterWork: { state: "observed"; outcomes: Work[] } | Unavailable };
  const records = new Map<string, Item>(), omitted = new Set<string>();
  const assignments = new Map<string, ExecutionRow[]>(), terminals = new Map<string, ExecutionRow[]>();
  const key = (row: ExecutionRow) => JSON.stringify([row.host, row.repair?.workerRunId, row.assignmentId,
    row.repair?.roundId, row.repair?.repo, row.repair?.number]);
  const validJoin = (row: ExecutionRow) => row.host !== null && row.assignmentId !== null && token(row.assignmentId)
    && row.repair?.rung === "fix" && token(row.repair.workerRunId) && token(row.repair.roundId)
    && row.repair.repo !== null && row.repair.number !== null && row.repair.assignmentObserved !== false;
  for (const row of rows) {
    if (!time(asOf) || !time(row.ts) || Date.parse(row.ts) > Date.parse(asOf) || row.host === null) continue;
    const execution = ciRemedyExecutionOf(row.remedyExecution);
    if (["fix.remedy_path_execution", "worker.assignment"].includes(row.step) && execution.state === "observed"
      && row.runId === execution.callerRunId && Date.parse(execution.at) <= Date.parse(row.ts)) {
      const id = JSON.stringify([row.host, execution.processInstanceId, execution.invocationId]);
      const old = records.get(id);
      if (old) old.conflict ||= JSON.stringify(old.execution) !== JSON.stringify(execution);
      else if (records.size < CI_REMEDY_EXECUTIONS_MAX) records.set(id, { host: row.host, execution, conflict: false,
        laterWork: { state: "unavailable", reason: "no-later-joined-worker-attempt" } });
      else omitted.add(id);
    }
    if (!validJoin(row)) continue;
    const map = row.step === "worker.assignment" ? assignments : row.step === "worker.attempt" ? terminals : undefined;
    if (map) { const group = map.get(key(row)) ?? []; group.push(row); map.set(key(row), group); }
  }
  for (const group of assignments.values()) {
    const assignment = group[0]!, execution = ciRemedyExecutionOf(assignment.remedyExecution);
    if (execution.state !== "observed" || assignment.runId !== execution.callerRunId
      || Date.parse(execution.at) > Date.parse(assignment.ts!)) continue;
    const item = records.get(JSON.stringify([assignment.host, execution.processInstanceId, execution.invocationId]));
    if (!item || item.conflict || execution.inputs.reachablePaths === 0) continue;
    if (group.some(row => row.ts !== assignment.ts || row.runId !== assignment.runId
      || JSON.stringify(ciRemedyExecutionOf(row.remedyExecution)) !== JSON.stringify(execution))) continue;
    const ends = terminals.get(key(assignment)) ?? [];
    if (new Set(ends.map(row => JSON.stringify([row.success, ciRemedyExecutionOf(row.remedyExecution)]))).size !== 1) continue;
    const end = ends.find(row => row.runId === execution.callerRunId && typeof row.success === "boolean" && Date.parse(row.ts!) >= Date.parse(assignment.ts!)
      && JSON.stringify(ciRemedyExecutionOf(row.remedyExecution)) === JSON.stringify(execution));
    if (!end) continue;
    const outcome: Work = { at: end.ts!, workerRunId: end.repair!.workerRunId!, assignmentId: end.assignmentId!,
      roundId: end.repair!.roundId!, success: end.success! };
    if (item.laterWork.state !== "observed") item.laterWork = { state: "observed", outcomes: [] };
    item.laterWork.outcomes.push(outcome);
  }
  const items = [...records.values()].map(item => ({ host: item.host, execution: item.execution,
    eligible: item.execution.inputs.reachablePaths > 0, laterWork: item.conflict
      ? { state: "unavailable" as const, reason: "conflicting-component-execution-receipts" } : item.laterWork,
    basis: "named-component-invocation-and-joined-worker-attempt" as const, wholeFixAdoption: "not-certified" as const,
    efficacyClaim: "none" as const, history: "unavailable-retention-uncertified" as const }));
  return { state: items.length ? "observed-partial" : "unavailable", reason: !time(asOf) ? "invalid-observation-time"
    : items.length ? "component-execution-only-retention-uncertified" : "no-qualified-component-execution",
    omittedInvocations: omitted.size, records: items };
}
