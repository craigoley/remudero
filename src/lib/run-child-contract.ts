/**
 * W1-T9070 — the on-disk contract between the daemon and a run child (ADR 0007, decision A.2 and A.4).
 *
 * A pipe dies with the daemon, so a run that must outlive it talks through files in
 * `<state>/runs/<runId>/`: `spec.json` (written by the daemon before any spawn) and `status.json`
 * (rewritten atomically by the child). A child is identified by (pid, start ticks, container
 * generation), never by pid alone: `measurementCadenceChildAlive`'s `kill(pid, 0)` is defeated by a
 * reused pid, and this module is the precedent that replaces it for build runs.
 *
 * No spawn site uses this contract yet. Its only caller is the daemon's boot census, which reads all
 * zeros until run children exist and is the positive control the adoption task builds on.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { classifyFailure } from "./classify.js";
import { writeAtomic } from "./fs-race-safe.js";
import { GhJsonUnreadableResponseError } from "./github-transport.js";
import { defaultGeneration, defaultProbe, type ContainerGeneration, type ProbeResult } from "./host-memory-ledger.js";
import { TaskAdmissionError } from "./plan.js";
import { copySelectedRegistryIntent, type SelectedRegistryIntent } from "./selected-registry-consumers.js";
import type { RunResult } from "./run-result.js";

/** The contract's schema version. The schema only grows within a major: a reader refuses an unknown major and
 *  ignores unknown minor fields. */
export const RUN_CHILD_SCHEMA = { major: 1, minor: 2 } as const;

export interface RunChildSchema {
  major: number;
  minor: number;
}

/** The serializable `runTask` options the daemon passes today. */
export interface RunChildSpecOptions {
  planPath?: string;
  owner?: string;
  allowStale?: boolean;
  skipGitSync?: boolean;
  handOffAtPrOpen?: boolean;
  pairedTrialHost?: "daemon";
  /** Trusted orchestration input only; never worker options or public status. */
  selectedRegistryIntent?: SelectedRegistryIntent;
}

export interface RunChildSpec {
  schema: RunChildSchema;
  taskId: string;
  runId: string;
  instance: string;
  engine: { sourceHash: string; sha: string };
  planSnapshotPath: string;
  reservationId: string;
  options: RunChildSpecOptions;
}

export type RunChildState = "starting" | "running" | "done" | "failed" | "aborted";
export const RUN_CHILD_STATES: readonly RunChildState[] = ["starting", "running", "done", "failed", "aborted"];
const TERMINAL_STATES: ReadonlySet<RunChildState> = new Set<RunChildState>(["done", "failed", "aborted"]);

export type RunChildEntryKind = "bundle" | "tsx";

/** A child's identity: pid AND its kernel start time AND the container generation. `startTicks` is the
 *  host-memory ledger's `proc:<field 22 of /proc/<pid>/stat>` rendering, compared by equality only. */
export interface RunChildIdentity {
  pid: number;
  startTicks: string;
  containerGeneration: ContainerGeneration;
}

/** The closed set of failures the settle loop distinguishes, plus the contract's own. */
export type RunChildFailureClass =
  | "task_admission"
  | "transient_gh_dispatch"
  | "spawn_infra_blocked"
  | "gh_lane_read"
  | "lane_delivery"
  | "contract_mismatch"
  | "aborted"
  | "terminal_error"
  | "unknown";
export const RUN_CHILD_FAILURE_CLASSES: readonly RunChildFailureClass[] = [
  "task_admission", "transient_gh_dispatch", "spawn_infra_blocked", "gh_lane_read", "lane_delivery",
  "contract_mismatch", "aborted", "terminal_error", "unknown",
];

/** BACKSTOP: bound on the message and stderr a failure carries. Generous on purpose: the settle loop's gh predicates match
 *  text, so a bound tight enough to cut the matched phrase would change the class a reader assigns. */
export const RUN_CHILD_FAILURE_TEXT_BOUND = 16_384;

/** A failure carrying exactly the fields the settle loop's predicates read: `message`, `stderr`, `code`, the
 *  `reasonClass` tag, and the `name` / `refusalClass` pair of a PR-open refusal. */
export interface RunChildFailure {
  class: RunChildFailureClass;
  reasonClass: string;
  message: string;
  name?: string;
  stderr?: string;
  code?: string;
  refusalClass?: string;
  operation?: "api" | "command";
}

export interface RunChildStatus {
  schema: RunChildSchema;
  runId: string;
  identity: RunChildIdentity;
  engineSha: string;
  entryKind: RunChildEntryKind;
  phase: string;
  heartbeatAt: number;
  state: RunChildState;
  result?: RunResult;
  failure?: RunChildFailure;
}

// ── paths ────────────────────────────────────────────────────────────────────────────────────

const RUN_ID_SHAPE = /^[A-Za-z0-9_-]+$/;

/** `<state>/runs/<runId>/`. A run id that could leave `runs/` is refused, never normalized. */
export function runDir(stateRoot: string, runId: string): string {
  if (!RUN_ID_SHAPE.test(runId)) throw new RangeError(`run-child-contract: run id ${JSON.stringify(runId)} is not a safe path segment`);
  return join(stateRoot, "runs", runId);
}

export const RUN_CHILD_SPEC_FILE = "spec.json";
export const RUN_CHILD_STATUS_FILE = "status.json";

// ── reading: a torn or unparseable file is `unreadable`, never a state ─────────────────────────

export type RunChildRead<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "unreadable" | "contract_mismatch"; detail: string };

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function bad<T>(detail: string): RunChildRead<T> {
  return { ok: false, reason: "unreadable", detail };
}

function parseSchema(v: unknown): RunChildRead<RunChildSchema> {
  if (!isRecord(v) || !Number.isSafeInteger(v.major) || !Number.isSafeInteger(v.minor)) return bad("schema missing or malformed");
  const major = v.major as number;
  const minor = v.minor as number;
  if (major !== RUN_CHILD_SCHEMA.major) {
    return { ok: false, reason: "contract_mismatch", detail: `schema major ${major}, this reader knows ${RUN_CHILD_SCHEMA.major}` };
  }
  return { ok: true, value: { major, minor } };
}

function readJson(path: string): RunChildRead<Json> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { ok: false, reason: "unreadable", detail: `${missing ? "missing" : "unreadable"}: ${(error as Error).message}` };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? { ok: true, value: parsed } : bad("not a JSON object");
  } catch (error) {
    return { ok: false, reason: "unreadable", detail: `torn or unparseable JSON: ${(error as Error).message}` };
  }
}

function parseOptions(v: unknown): RunChildSpecOptions | undefined {
  if (v === undefined) return {};
  if (!isRecord(v)) return undefined;
  const out: RunChildSpecOptions = {};
  for (const key of ["planPath", "owner"] as const) {
    if (v[key] !== undefined) {
      if (typeof v[key] !== "string") return undefined;
      out[key] = v[key];
    }
  }
  for (const key of ["allowStale", "skipGitSync", "handOffAtPrOpen"] as const) {
    if (v[key] !== undefined) {
      if (typeof v[key] !== "boolean") return undefined;
      out[key] = v[key];
    }
  }
  if (v.pairedTrialHost !== undefined) {
    if (v.pairedTrialHost !== "daemon") return undefined;
    out.pairedTrialHost = "daemon";
  }
  if (v.selectedRegistryIntent !== undefined) out.selectedRegistryIntent = copySelectedRegistryIntent(v.selectedRegistryIntent);
  return out;
}

/** Parses a spec, keeping only the fields this reader knows: an unknown minor field is ignored, an unknown
 *  major is refused as `contract_mismatch`. */
export function parseSpec(raw: unknown): RunChildRead<RunChildSpec> {
  if (!isRecord(raw)) return bad("spec is not an object");
  const schema = parseSchema(raw.schema);
  if (!schema.ok) return schema;
  const engine = raw.engine;
  const options = parseOptions(raw.options);
  const taskId = str(raw.taskId), runId = str(raw.runId), instance = str(raw.instance);
  const planSnapshotPath = str(raw.planSnapshotPath), reservationId = str(raw.reservationId);
  if (
    taskId === undefined || runId === undefined || instance === undefined || planSnapshotPath === undefined ||
    reservationId === undefined || options === undefined || !isRecord(engine) ||
    str(engine.sourceHash) === undefined || str(engine.sha) === undefined
  ) {
    return bad("spec field missing or mistyped");
  }
  return {
    ok: true,
    value: {
      schema: schema.value, taskId, runId, instance, planSnapshotPath, reservationId, options,
      engine: { sourceHash: engine.sourceHash as string, sha: engine.sha as string },
    },
  };
}

function parseGeneration(v: unknown): ContainerGeneration | undefined {
  return isRecord(v) && str(v.containerId) !== undefined && str(v.initStart) !== undefined
    ? { containerId: v.containerId as string, initStart: v.initStart as string }
    : undefined;
}

function parseIdentity(v: unknown): RunChildIdentity | undefined {
  if (!isRecord(v) || !Number.isSafeInteger(v.pid) || (v.pid as number) <= 0 || str(v.startTicks) === undefined) return undefined;
  const containerGeneration = parseGeneration(v.containerGeneration);
  return containerGeneration ? { pid: v.pid as number, startTicks: v.startTicks as string, containerGeneration } : undefined;
}

/** A failure class this reader does not know (a newer minor's) reads as `unknown`, never as an error. */
function parseFailure(v: unknown): RunChildFailure | undefined {
  if (!isRecord(v) || str(v.message) === undefined) return undefined;
  const known = RUN_CHILD_FAILURE_CLASSES.find((c) => c === v.class);
  const failure: RunChildFailure = {
    class: known ?? "unknown",
    reasonClass: str(v.reasonClass) ?? (known ?? "unknown"),
    message: v.message as string,
  };
  for (const key of ["name", "stderr", "code", "refusalClass"] as const) {
    const value = str(v[key]);
    if (value !== undefined) failure[key] = value;
  }
  if (v.operation === "api" || v.operation === "command") failure.operation = v.operation;
  return failure;
}

function parseResult(v: unknown): RunResult | undefined {
  if (!isRecord(v)) return undefined;
  const ok = str(v.taskId) !== undefined && str(v.runId) !== undefined && str(v.verdict) !== undefined &&
    typeof v.merged === "boolean" && typeof v.costUsd === "number";
  return ok ? (v as unknown as RunResult) : undefined;
}

export function parseStatus(raw: unknown): RunChildRead<RunChildStatus> {
  if (!isRecord(raw)) return bad("status is not an object");
  const schema = parseSchema(raw.schema);
  if (!schema.ok) return schema;
  const identity = parseIdentity(raw.identity);
  const state = RUN_CHILD_STATES.find((s) => s === raw.state);
  const runId = str(raw.runId), engineSha = str(raw.engineSha), phase = str(raw.phase);
  const entryKind = raw.entryKind === "bundle" || raw.entryKind === "tsx" ? raw.entryKind : undefined;
  if (
    identity === undefined || state === undefined || runId === undefined || engineSha === undefined ||
    phase === undefined || entryKind === undefined || typeof raw.heartbeatAt !== "number" || !Number.isFinite(raw.heartbeatAt)
  ) {
    return bad("status field missing or mistyped");
  }
  const status: RunChildStatus = { schema: schema.value, runId, identity, engineSha, entryKind, phase, heartbeatAt: raw.heartbeatAt, state };
  if (raw.result !== undefined) {
    const result = parseResult(raw.result);
    if (result === undefined) return bad("status result malformed");
    status.result = result;
  }
  if (raw.failure !== undefined) {
    const failure = parseFailure(raw.failure);
    if (failure === undefined) return bad("status failure malformed");
    status.failure = failure;
  }
  return { ok: true, value: status };
}

export function readSpec(dir: string): RunChildRead<RunChildSpec> {
  const raw = readJson(join(dir, RUN_CHILD_SPEC_FILE));
  return raw.ok ? parseSpec(raw.value) : raw;
}

export function readStatus(dir: string): RunChildRead<RunChildStatus> {
  const raw = readJson(join(dir, RUN_CHILD_STATUS_FILE));
  return raw.ok ? parseStatus(raw.value) : raw;
}

// ── writing: atomic, so a reader sees the old file or the new one, never half of either ────────

export function writeSpec(dir: string, spec: RunChildSpec): void {
  writeAtomic(join(dir, RUN_CHILD_SPEC_FILE), `${JSON.stringify(spec)}\n`);
}

export function writeStatus(dir: string, status: RunChildStatus): void {
  writeAtomic(join(dir, RUN_CHILD_STATUS_FILE), `${JSON.stringify(status)}\n`);
}

// ── identity ─────────────────────────────────────────────────────────────────────────────────

/** The seams a classification reads the host through. */
export interface RunChildProbe {
  process(pid: number): ProbeResult;
  generation(): ContainerGeneration;
}

export const realRunChildProbe: RunChildProbe = {
  process: (pid) => defaultProbe(pid),
  generation: () => defaultGeneration(),
};

/** A live process's identity, or `undefined` when it is gone or its start time cannot be read — an identity that
 *  cannot be proven is not one to record. */
export function childIdentity(pid: number, probe: RunChildProbe = realRunChildProbe): RunChildIdentity | undefined {
  const seen = probe.process(pid);
  if (seen.state !== "alive") return undefined;
  return { pid, startTicks: seen.start, containerGeneration: probe.generation() };
}

export type RunDirKind = "live" | "terminal" | "lost" | "dead" | "unreadable";
export const RUN_DIR_KINDS: readonly RunDirKind[] = ["live", "terminal", "lost", "dead", "unreadable"];

export interface RunDirClassification {
  kind: RunDirKind;
  /** The reason, for every kind but a plain `live` or `terminal`. `unreadable` always carries one. */
  detail?: string;
  status?: RunChildStatus;
}

export function isTerminalState(state: RunChildState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * live: identity matches and the state is not terminal. terminal: done, failed or aborted. lost: the identity
 * no longer matches (gone, or a reused pid) and the state is not terminal. dead: the status names another
 * container generation. unreadable: never live and never a success — the caller decides, and the reason rides.
 */
export function classifyRunDir(dir: string, probe: RunChildProbe = realRunChildProbe): RunDirClassification {
  const read = readStatus(dir);
  if (!read.ok) return { kind: "unreadable", detail: `${read.reason}: ${read.detail}` };
  const status = read.value;
  if (isTerminalState(status.state)) return { kind: "terminal", status };
  const generation = probe.generation();
  const named = status.identity.containerGeneration;
  if (named.containerId !== generation.containerId || named.initStart !== generation.initStart) {
    return { kind: "dead", status, detail: `status names container ${named.containerId}@${named.initStart}, this is ${generation.containerId}@${generation.initStart}` };
  }
  const seen = probe.process(status.identity.pid);
  if (seen.state === "gone") return { kind: "lost", status, detail: `pid ${status.identity.pid} is gone` };
  if (seen.state === "unknown") return { kind: "unreadable", status, detail: `pid ${status.identity.pid} start time unreadable: ${seen.reason}` };
  if (status.identity.startTicks === "unknown") return { kind: "unreadable", status, detail: "recorded start ticks are unknown" };
  return seen.start === status.identity.startTicks
    ? { kind: "live", status }
    : { kind: "lost", status, detail: `pid ${status.identity.pid} was reused: started ${seen.start}, recorded ${status.identity.startTicks}` };
}

export type RunDirCensus = Record<RunDirKind, number>;

/** Counts every run DIRECTORY under `<state>/runs/` by kind. The `.tail` files that share the directory are not
 *  runs. A missing `runs/` is a census of zero; any other read failure propagates to the caller. */
export function censusRunDirs(stateRoot: string, probe: RunChildProbe = realRunChildProbe): RunDirCensus {
  const census: RunDirCensus = { live: 0, terminal: 0, lost: 0, dead: 0, unreadable: 0 };
  const root = join(stateRoot, "runs");
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return census;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) census[classifyRunDir(join(root, entry.name), probe).kind] += 1;
  }
  return census;
}

// ── failures: the settle loop's classes, serialized without losing what its predicates read ────

const GH_WORD = /(?:^|\s)gh(?:\s|$)/i;
const GH_READ_ENDPOINT = /commits\/[^/\s]+\/(?:check-runs|status)\b/i;
const COMMAND_FAILED = /^Command failed: /;
const CREDENTIAL_REFUSAL = /Bad credentials|HTTP 401|Authentication failed|could not read Username|Permission denied \(publickey\)/i;

interface ErrorFields {
  message: string;
  stderr: string | undefined;
  code: string | undefined;
}

function fieldsOf(error: unknown): ErrorFields {
  const e = (typeof error === "object" && error !== null ? error : {}) as { message?: unknown; stderr?: unknown; code?: unknown };
  return {
    message: typeof error === "object" && error !== null ? String(e.message ?? "") : String(error),
    stderr: e.stderr == null ? undefined : String(e.stderr),
    code: e.code == null ? undefined : String(e.code),
  };
}

function joinedDetail(f: ErrorFields): string {
  return [f.message, f.stderr ?? "", f.code ?? ""].filter((part) => part.length > 0).join("\n");
}

/**
 * The settle loop's classification of one rejection, in the daemon's own order (src/lib/daemon.ts
 * `classifyRejection`): admission, then a transient gh transport failure, then spawn-infra, then a failed GitHub
 * read, then a lane delivery failure. The gh predicates are copies of the daemon's private ones; a failure that
 * matches none is `unknown`.
 */
export function classifyRunChildError(error: unknown): RunChildFailureClass {
  if (error instanceof TaskAdmissionError) return "task_admission";
  if (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError") return "aborted";
  const f = fieldsOf(error);
  if (error instanceof GhJsonUnreadableResponseError) return "transient_gh_dispatch";
  const isObject = typeof error === "object" && error !== null;
  if (isObject && GH_WORD.test(f.message) && classifyFailure({ text: joinedDetail(f) }) === "transient") return "transient_gh_dispatch";
  if (isObject && (error as { reasonClass?: unknown }).reasonClass === "blocked_toolchain") return "spawn_infra_blocked";
  if (isObject && GH_WORD.test(f.message) && GH_READ_ENDPOINT.test(f.message)) return "gh_lane_read";
  if (error instanceof Error && error.name === "PrOpenRefusedError" && typeof (error as { refusalClass?: unknown }).refusalClass === "string") return "lane_delivery";
  if (error instanceof Error && COMMAND_FAILED.test(error.message) && !CREDENTIAL_REFUSAL.test(`${error.message}\n${f.stderr ?? ""}`)) return "lane_delivery";
  return "unknown";
}

function bounded(text: string): string {
  return text.length <= RUN_CHILD_FAILURE_TEXT_BOUND ? text : text.slice(0, RUN_CHILD_FAILURE_TEXT_BOUND);
}

export function toRunChildFailure(error: unknown): RunChildFailure {
  const cls = classifyRunChildError(error);
  const f = fieldsOf(error);
  const tagged = (typeof error === "object" && error !== null ? error : {}) as { reasonClass?: unknown; name?: unknown; refusalClass?: unknown; operation?: unknown };
  const failure: RunChildFailure = {
    // Representation is not policy: an actual Error remains an Error for the daemon's
    // existing predicates. Non-Error throws and unknown wire classes remain unknown.
    class: cls === "unknown" && error instanceof Error ? "terminal_error" : cls,
    reasonClass: typeof tagged.reasonClass === "string" ? tagged.reasonClass : cls,
    message: bounded(f.message),
  };
  if (typeof tagged.name === "string") failure.name = tagged.name;
  if (f.stderr !== undefined) failure.stderr = bounded(f.stderr);
  if (f.code !== undefined) failure.code = f.code;
  if (typeof tagged.refusalClass === "string") failure.refusalClass = tagged.refusalClass;
  if (error instanceof GhJsonUnreadableResponseError) failure.operation = error.operation;
  return failure;
}

/** The failure a child writes when it reads a spec major it does not know. */
export function contractMismatchFailure(detail: string): RunChildFailure {
  return { class: "contract_mismatch", reasonClass: "contract_mismatch", message: bounded(detail) };
}

/** What a reader settles a failure as: a rebuilt error the daemon's predicates classify as the original, or a
 *  lost run. A known terminal_error represents an Error, not a lane-delivery ruling.
 *  Old readers treat this new minor's class as unknown/lost; old unknown records are
 *  never guessed to be Errors by new readers. */
export type RunChildSettlement =
  | { kind: "error"; error: Error }
  | { kind: "lost"; detail: string };

export function fromRunChildFailure(failure: RunChildFailure): RunChildSettlement {
  switch (failure.class) {
    case "task_admission":
      return { kind: "error", error: new TaskAdmissionError(failure.message) };
    case "transient_gh_dispatch":
      if (failure.reasonClass === "gh_json_unreadable_response") {
        return { kind: "error", error: new GhJsonUnreadableResponseError(failure.operation ?? "command", undefined) };
      }
      return { kind: "error", error: withFields(new Error(failure.message), failure) };
    case "spawn_infra_blocked":
      return { kind: "error", error: Object.assign(withFields(new Error(failure.message), failure), { reasonClass: "blocked_toolchain" }) };
    case "gh_lane_read":
    case "lane_delivery":
    case "contract_mismatch":
    case "aborted":
    case "terminal_error":
      return { kind: "error", error: withFields(new Error(failure.message), failure) };
    default:
      return { kind: "lost", detail: `unclassified failure: ${failure.message}` };
  }
}

function withFields(error: Error, failure: RunChildFailure): Error {
  if (failure.name !== undefined) error.name = failure.name;
  if (failure.class === "aborted") error.name = "AbortError";
  const extra = error as Error & { stderr?: string; code?: string; refusalClass?: string; reasonClass?: string };
  if (failure.stderr !== undefined) extra.stderr = failure.stderr;
  if (failure.code !== undefined) extra.code = failure.code;
  if (failure.refusalClass !== undefined) extra.refusalClass = failure.refusalClass;
  if (failure.class === "terminal_error" && failure.reasonClass !== "unknown") extra.reasonClass = failure.reasonClass;
  return error;
}
