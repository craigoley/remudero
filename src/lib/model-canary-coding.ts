/** Bounded synthetic coding control and authority-bound executor result contract. */
import { createHash } from "node:crypto";
import { consumeCodingAttemptConsumption, type CodingAttemptConsumptionCapability,
  type CodingControlBindingV1 } from "./model-canary-coding-capabilities.js";
export type { CodingControlBindingV1 } from "./model-canary-coding-capabilities.js";

export const CODING_CONTROL_VERSION = "coding-control-v1" as const;
export const CODING_RUNTIME_PROTOCOL = "node-source-stdin-stdout-v1" as const;
export const CODING_RESPONSE_MAX_BYTES = 16_384; // PRIMARY CONTROL: bounds parsed worker output before JSON validation.
export const CODING_FIXTURE_MAX_BYTES = 4_096; // PRIMARY CONTROL: caps the synthetic fixture before worker dispatch.
export const CODING_STDOUT_MAX_BYTES = 4_096; // PRIMARY CONTROL: caps candidate stdout at the execution boundary.
export const CODING_STDERR_MAX_BYTES = 4_096; // PRIMARY CONTROL: caps candidate stderr at the execution boundary.
export const CODING_SOURCE_MAX_BYTES = 8_192; // PRIMARY CONTROL: caps candidate source before it reaches the host.

const hex64 = /^[a-f0-9]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const sha256 = (v: string | Uint8Array): string => createHash("sha256").update(v).digest("hex");

export type CodingResultBindingV1 = CodingControlBindingV1;

export interface CodingFixtureV1 {
  version: typeof CODING_CONTROL_VERSION;
  caseId: "coding-sum-four-v1";
  stdin: string;
  digest: string;
  prompt: string;
  /** Scorer-only, never copied into request, candidate root, backend argv, or ledger payload. */
  expectedStdout: string;
}
export type CodingFixture = CodingFixtureV1;

export interface CodingExecutionRequestV1 {
  binding: CodingControlBindingV1;
  source: string;
  stdin: string;
  signal: AbortSignal;
  limits: CodingConfiguredBounds;
}

/** Fixed synthetic arithmetic task. Seed affects only public fixture data; oracle stays local. */
export function syntheticCodingFixture(seed: string): CodingFixture {
  if (!seed || Buffer.byteLength(seed, "utf8") > 256) throw new Error("coding-seed-invalid");
  const bytes = createHash("sha256").update(`coding-fixture-v1\0${seed}`).digest();
  const values = Array.from({ length: 4 }, (_, i) => (bytes.readUInt16BE(i * 2) % 101) - 50);
  const stdin = `${values.join("\n")}\n`;
  if (Buffer.byteLength(stdin, "utf8") > CODING_FIXTURE_MAX_BYTES) throw new Error("coding-fixture-bound");
  const sum = values.reduce((a, b) => a + b, 0);
  const expectedStdout = `${sum}\n`;
  return Object.freeze({ version: CODING_CONTROL_VERSION, caseId: "coding-sum-four-v1", stdin, digest: sha256(stdin),
    prompt: `Write JavaScript source that reads four signed decimal integers from stdin and prints their sum followed by a newline. Input:\n${stdin}`,
    expectedStdout });
}

export function codingRequestFixture(fixture: CodingFixture) {
  assertFixture(fixture);
  return { version: fixture.version, prompt: fixture.prompt, fixtureDigest: fixture.digest,
    responseFormat: { type: "json", requiredKeys: ["source"] as const } };
}

export function parseCodingCandidate(text: string): { source: string; sourceDigest: string } {
  if (Buffer.byteLength(text, "utf8") > CODING_RESPONSE_MAX_BYTES) throw new Error("coding-response-bound");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("coding-response-invalid-json"); }
  if (!record(parsed) || Object.keys(parsed).length !== 1 || typeof parsed.source !== "string")
    throw new Error("coding-response-shape-invalid");
  const sourceBytes = Buffer.byteLength(parsed.source, "utf8");
  if (sourceBytes < 1 || sourceBytes > CODING_SOURCE_MAX_BYTES || parsed.source.includes("\0") ||
      Buffer.from(parsed.source, "utf8").toString("utf8") !== parsed.source)
    throw new Error("coding-source-bound");
  return { source: parsed.source, sourceDigest: sha256(parsed.source) };
}

/** Limits come from the owner-authorized profile; this module never chooses host resource caps. */
export interface CodingConfiguredBounds {
  profileId: string;
  profileDigest: string;
  binaryDigest: string;
  runtimeId: typeof CODING_RUNTIME_PROTOCOL;
  cpuQuotaMicros: number;
  memoryMaxBytes: number;
  swapMaxBytes: number;
  tasksMax: number;
  scratchMaxBytes: number;
  wallMaxMs: number;
  stdoutMaxBytes: number;
  stderrMaxBytes: number;
  heapMaxBytes: number;
}

/** Native observations only. Null is missing/unavailable; configured caps never fill these fields. */
export interface CodingObservedResources {
  cpuUsec: number | null;
  memoryPeakBytes: number | null;
  swapPeakBytes: number | null;
  pidsPeak: number | null;
  scratchPeakBytes: number | null;
  wallMs: number | null;
  stdoutBytes: number | null;
  stderrBytes: number | null;
  heapPeakBytes: number | null;
}

export type CodingExecutionReason = "native-backend-unavailable" | "owner-profile-unavailable"
  | "isolation-unavailable" | "resource-readback-incomplete" | "candidate-timeout"
  | "candidate-cancelled" | "descendant-closure-unproved" | "native-executor-error"
  | "worker-spawn-identity-unavailable" | "coding-response-invalid" | "owner-attempt-already-consumed"
  | "coding-tool-request-denied" | "coding-case-binding-mismatch";

export interface CodingRawNativeResult {
  binding: CodingControlBindingV1;
  /** Exact app-owned unit/cgroup identity. It is not accepted from model output or manifest data. */
  hostExecutionId: string;
  candidateDigest: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  configured: CodingConfiguredBounds;
  observed: CodingObservedResources;
  restrictions: {
    privateNonGitRoot: true;
    networkNamespaceIsolated: true;
    noHostDataMounts: true;
    noCredentialMounts: true;
    noPackageInstall: true;
    oracleNotMounted: true;
  };
  lifecycle: {
    cancelled: boolean;
    /** Candidate namespace is closed; trusted service wrapper remains for readback. */
    candidateClosedBeforeMetrics: true;
    metricsCapturedBeforeCollection: true;
    unitEmptyAfterStop: true;
  };
}
export interface CodingExecutionDispositionV1 {
  hostStarted: "no" | "yes" | "unknown";
  closure: "proven" | "unavailable";
  hostExecutionId: string | null;
}

export type CodingBackendResult =
  | { state: "refused"; reason: CodingExecutionReason; execution: CodingExecutionDispositionV1 }
  | { state: "unavailable"; reason: CodingExecutionReason; execution: CodingExecutionDispositionV1; configured?: CodingConfiguredBounds;
      /** Keep bounded output/observations for diagnosis, while withholding a qualified score. */
      partial?: { binding: CodingControlBindingV1; hostExecutionId: string; candidateDigest: string; exitCode: number;
        stdout: string; stderr: string; observed: CodingObservedResources; candidateClosedBeforeMetrics: true;
        metricsCapturedBeforeCollection: true; unitEmptyAfterStop: boolean } }
  | { state: "complete"; raw: CodingRawNativeResult };

/** In-process owner-issued capability. A JSON object cannot recreate membership in the private WeakMap. */
export interface CodingExecutionAuthority { readonly kind: "coding-execution-authority-v1" }
interface AuthorityState {
  binding: CodingControlBindingV1;
  configured: CodingConfiguredBounds;
  execute: (input: { binding: CodingControlBindingV1; source: string; stdin: string;
    signal: AbortSignal; limits: CodingConfiguredBounds }) => Promise<CodingBackendResult>;
}
const authorityState = new WeakMap<object, AuthorityState>();
const usedAuthorities = new WeakSet<object>();

/** @internal Native owner only, after normal eligibility, durable one-shot consumption and profile checks. */
export function bindCodingExecutionAuthority(input: AuthorityState & { consumption: CodingAttemptConsumptionCapability }): CodingExecutionAuthority {
  const consumedBinding = consumeCodingAttemptConsumption(input.consumption);
  if (!consumedBinding || !sameBinding(consumedBinding, input.binding))
    throw new Error("coding-owner-consumption-capability-required");
  const handle = Object.freeze(Object.create(null)) as CodingExecutionAuthority;
  authorityState.set(handle, { binding: input.binding, configured: input.configured, execute: input.execute });
  return handle;
}

export type CodingExecutionResultV1 = CodingRunnerResult;

export type CodingRunnerResult =
  | { state: "refused"; reason: CodingExecutionReason; binding: CodingResultBindingV1 | null;
      execution: CodingExecutionDispositionV1 }
  | { state: "unavailable"; reason: CodingExecutionReason; binding: CodingResultBindingV1 | null;
      execution: CodingExecutionDispositionV1;
      configured: CodingConfiguredBounds | null; observed: CodingObservedResources | null;
      candidateOutput?: { sourceDigest: string; exitCode: number; stdout: string; stderr: string;
        candidateClosedBeforeMetrics: true; metricsCapturedBeforeCollection: true; unitEmptyAfterStop: boolean } }
  | { state: "complete"; binding: CodingControlBindingV1; sourceDigest: string; hostExecutionId: string;
      exitCode: number; stdout: string; configured: CodingConfiguredBounds; observed: CodingObservedResources;
      execution: CodingExecutionDispositionV1;
      closure: { cancelled: boolean; candidateClosedBeforeMetrics: true; metricsCapturedBeforeCollection: true; unitEmptyAfterStop: true } };

const issuedResults = new WeakSet<object>();
const qualifiedResults = new WeakSet<object>();
const gradeResults = new WeakMap<object, object>();

function validBinding(b: CodingControlBindingV1): boolean {
  return !!b && typeof b.caseId === "string" && b.caseId.length > 0 && b.caseId.length <= 128
    && hex64.test(b.suiteHash) && uuid.test(b.runId) && uuid.test(b.canaryAttemptId)
    && uuid.test(b.workerSpawnAttemptId)
    && uuid.test(b.codingExecutionAttemptId)
    && new Set([b.runId, b.canaryAttemptId, b.workerSpawnAttemptId, b.codingExecutionAttemptId]).size === 4
    && hex64.test(b.slotId) && hex64.test(b.sourceDigest);
}
function validBounds(b: CodingConfiguredBounds): boolean {
  return !!b && typeof b.profileId === "string" && b.profileId.length > 0 && b.profileId.length <= 128
    && hex64.test(b.profileDigest) && hex64.test(b.binaryDigest) && b.runtimeId === CODING_RUNTIME_PROTOCOL
    && [b.cpuQuotaMicros, b.memoryMaxBytes, b.tasksMax, b.scratchMaxBytes, b.wallMaxMs,
      b.stdoutMaxBytes, b.stderrMaxBytes, b.heapMaxBytes].every(n => Number.isSafeInteger(n) && n > 0)
    && Number.isSafeInteger(b.swapMaxBytes) && b.swapMaxBytes >= 0
    && b.stdoutMaxBytes <= CODING_STDOUT_MAX_BYTES && b.stderrMaxBytes <= CODING_STDERR_MAX_BYTES;
}
function validObserved(o: CodingObservedResources, b: CodingConfiguredBounds): boolean {
  const values = [o.cpuUsec, o.memoryPeakBytes, o.swapPeakBytes, o.pidsPeak, o.scratchPeakBytes,
    o.wallMs, o.stdoutBytes, o.stderrBytes, o.heapPeakBytes];
  return values.every(n => n !== null && Number.isSafeInteger(n) && n >= 0)
    // cpuQuotaMicros is a configured rate control, not a cumulative CPU budget. Preserve the native
    // cpuUsec observation without inventing a total-CPU cap from a quota percentage/period guess.
    && o.memoryPeakBytes! <= b.memoryMaxBytes && o.swapPeakBytes! <= b.swapMaxBytes
    && o.pidsPeak! <= b.tasksMax && o.scratchPeakBytes! <= b.scratchMaxBytes
    && o.wallMs! <= b.wallMaxMs && o.stdoutBytes! <= b.stdoutMaxBytes
    && o.stderrBytes! <= b.stderrMaxBytes && o.heapPeakBytes! <= b.heapMaxBytes;
}
function sameBinding(a: CodingControlBindingV1, b: CodingControlBindingV1): boolean {
  return a.caseId === b.caseId && a.suiteHash === b.suiteHash && a.runId === b.runId
    && a.slotId === b.slotId && a.canaryAttemptId === b.canaryAttemptId
    && a.workerSpawnAttemptId === b.workerSpawnAttemptId
    && a.codingExecutionAttemptId === b.codingExecutionAttemptId && a.sourceDigest === b.sourceDigest;
}
function unavailable(binding: CodingControlBindingV1, reason: CodingExecutionReason,
  configured: CodingConfiguredBounds | null = null, partial?: Extract<CodingBackendResult, { state: "unavailable" }>["partial"],
  execution: CodingExecutionDispositionV1 = { hostStarted: "unknown", closure: "unavailable", hostExecutionId: null }): CodingRunnerResult {
  const candidateOutput = partial && sameBinding(partial.binding, binding) && hex64.test(partial.candidateDigest)
    && partial.hostExecutionId === execution.hostExecutionId
    && execution.hostStarted === "yes" && execution.closure === "proven"
    && partial.candidateClosedBeforeMetrics && partial.metricsCapturedBeforeCollection && partial.unitEmptyAfterStop
    && Number.isSafeInteger(partial.exitCode) && typeof partial.stdout === "string" && typeof partial.stderr === "string"
    && configured !== null && validBounds(configured)
    && Buffer.byteLength(partial.stdout, "utf8") <= Math.min(configured.stdoutMaxBytes, CODING_STDOUT_MAX_BYTES)
    && Buffer.byteLength(partial.stderr, "utf8") <= Math.min(configured.stderrMaxBytes, CODING_STDERR_MAX_BYTES)
    ? Object.freeze({ sourceDigest: partial.candidateDigest, exitCode: partial.exitCode, stdout: partial.stdout,
        stderr: partial.stderr, candidateClosedBeforeMetrics: true as const,
        metricsCapturedBeforeCollection: partial.metricsCapturedBeforeCollection,
        unitEmptyAfterStop: partial.unitEmptyAfterStop }) : undefined;
  const result: CodingRunnerResult = Object.freeze({ state: "unavailable", reason, binding, configured,
    execution, observed: partial?.observed ?? null, ...(candidateOutput ? { candidateOutput } : {}) });
  issuedResults.add(result); return result;
}
function refused(binding: CodingResultBindingV1 | null, reason: CodingExecutionReason,
  execution: CodingExecutionDispositionV1 = { hostStarted: "no", closure: "proven", hostExecutionId: null }): CodingRunnerResult {
  const result: CodingRunnerResult = Object.freeze({ state: "refused", reason, binding, execution });
  issuedResults.add(result); return result;
}

/** Refusal before durable host consumption. It cannot score and carries no claimed slot identity. */
export function refuseCodingBeforeHost(reason: CodingExecutionReason): CodingRunnerResult {
  return refused(null, reason, { hostStarted: "no", closure: "proven", hostExecutionId: null });
}

/** An owner reported prior/ambiguous consumption; retain the hold without claiming a binding. */
export function unavailableCodingAttempt(reason: CodingExecutionReason): CodingRunnerResult {
  const result: CodingRunnerResult = Object.freeze({ state: "unavailable", reason, binding: null,
    configured: null, observed: null,
    execution: { hostStarted: "unknown", closure: "unavailable", hostExecutionId: null } as const });
  issuedResults.add(result); return result;
}

/** No default executor exists. Without trusted process-local owner authority this is a refusal. */
export async function executeCodingCandidate(input: { binding: CodingControlBindingV1; fixture: CodingFixture;
  responseText: string; authority?: CodingExecutionAuthority | null; signal: AbortSignal }): Promise<CodingRunnerResult> {
  if (!validBinding(input.binding)) throw new Error("coding-binding-invalid");
  assertFixture(input.fixture);
  const candidate = parseCodingCandidate(input.responseText);
  const binding: CodingControlBindingV1 = input.binding;
  if (candidate.sourceDigest !== binding.sourceDigest) throw new Error("coding-source-digest-binding-mismatch");
  if (!input.authority || !authorityState.has(input.authority as object))
    return refused(binding, "native-backend-unavailable");
  const state = authorityState.get(input.authority as object)!;
  if (!sameBinding(state.binding, binding)) throw new Error("coding-authority-binding-mismatch");
  if (usedAuthorities.has(input.authority as object))
    return unavailable(binding, "owner-attempt-already-consumed", state.configured, undefined,
      { hostStarted: "unknown", closure: "unavailable", hostExecutionId: null });
  usedAuthorities.add(input.authority as object);
  if (input.signal.aborted) return refused(binding, "candidate-cancelled");
  if (!validBounds(state.configured)) return unavailable(binding, "owner-profile-unavailable", null, undefined,
    { hostStarted: "no", closure: "proven", hostExecutionId: null });
  let backend: CodingBackendResult;
  try { backend = await state.execute({ binding, source: candidate.source,
    stdin: input.fixture.stdin, signal: input.signal, limits: state.configured }); }
  catch { // Executor errors have unknown host/closure state; preserve that uncertainty in the unavailable result.
    return unavailable(binding, "native-executor-error", state.configured, undefined,
    { hostStarted: "unknown", closure: "unavailable", hostExecutionId: null }); }
  if (backend.state === "refused") return refused(binding, backend.reason, backend.execution);
  if (backend.state === "unavailable") return unavailable(binding, backend.reason,
    backend.configured ?? state.configured, backend.partial, backend.execution);
  const raw = backend.raw;
  if (!sameBinding(raw.binding, binding) || raw.candidateDigest !== candidate.sourceDigest
    || !raw.hostExecutionId || raw.hostExecutionId.length > 256 || !validBounds(raw.configured)
    || raw.configured.profileDigest !== state.configured.profileDigest
    || raw.configured.binaryDigest !== state.configured.binaryDigest
    || !validObserved(raw.observed, raw.configured)
    || !raw.restrictions.privateNonGitRoot || !raw.restrictions.networkNamespaceIsolated
    || !raw.restrictions.noHostDataMounts || !raw.restrictions.noCredentialMounts
    || !raw.restrictions.noPackageInstall || !raw.restrictions.oracleNotMounted
    || !raw.lifecycle.candidateClosedBeforeMetrics || !raw.lifecycle.metricsCapturedBeforeCollection
    || !raw.lifecycle.unitEmptyAfterStop
    || Buffer.byteLength(raw.stdout, "utf8") > raw.configured.stdoutMaxBytes
    || Buffer.byteLength(raw.stderr, "utf8") > raw.configured.stderrMaxBytes)
    return unavailable(binding, "resource-readback-incomplete", raw.configured ?? state.configured, undefined,
      { hostStarted: "yes", closure: raw.lifecycle.unitEmptyAfterStop ? "proven" : "unavailable", hostExecutionId: raw.hostExecutionId });
  const complete: CodingRunnerResult = Object.freeze({ state: "complete", binding,
    sourceDigest: candidate.sourceDigest, hostExecutionId: raw.hostExecutionId, exitCode: raw.exitCode, stdout: raw.stdout,
    configured: raw.configured, observed: raw.observed,
    execution: { hostStarted: "yes", closure: "proven", hostExecutionId: raw.hostExecutionId } as const,
    closure: { cancelled: raw.lifecycle.cancelled, candidateClosedBeforeMetrics: true as const,
      metricsCapturedBeforeCollection: true as const, unitEmptyAfterStop: true as const } });
  issuedResults.add(complete); qualifiedResults.add(complete);
  return complete;
}

export interface CodingGrade { state: "scored" | "unavailable"; passed: boolean | null;
  /** Diagnostic comparison only; never promotes an incomplete native run to scored. */
  observedCorrectness: boolean | null; reason: string;
  fixtureDigest: string; sourceDigest: string | null }

/** A correctness pass requires a same-process runner result that crossed all native checks above. */
export function scoreCodingControl(fixture: CodingFixture, result: CodingRunnerResult): CodingGrade {
  assertFixture(fixture);
  let grade: CodingGrade;
  const caseMatches = !result.binding || result.binding.caseId === fixture.caseId;
  if (!caseMatches) {
    grade = Object.freeze({ state: "unavailable", passed: null, observedCorrectness: null,
      reason: "coding-case-binding-mismatch", fixtureDigest: fixture.digest,
      sourceDigest: result.state === "complete" ? result.sourceDigest
        : result.state === "unavailable" ? result.candidateOutput?.sourceDigest ?? null : null });
  } else if (result.state !== "complete" || !qualifiedResults.has(result as object)) {
    grade = Object.freeze({ state: "unavailable", passed: null,
      observedCorrectness: result.state === "unavailable" && result.candidateOutput
        ? result.candidateOutput.exitCode === 0 && result.candidateOutput.stdout === fixture.expectedStdout : null,
      reason: result.state === "refused" ? result.reason : result.state === "unavailable" ? result.reason : "native-result-not-trusted",
      fixtureDigest: fixture.digest, sourceDigest: result.state === "complete" ? result.sourceDigest
        : result.state === "unavailable" ? result.candidateOutput?.sourceDigest ?? null : null });
  } else {
    const passed = result.exitCode === 0 && result.stdout === fixture.expectedStdout;
    grade = Object.freeze({ state: "scored", passed, observedCorrectness: passed,
      reason: result.exitCode !== 0 ? "candidate-exit-nonzero"
      : passed ? "verified" : "incorrect-output", fixtureDigest: fixture.digest, sourceDigest: result.sourceDigest });
  }
  if (issuedResults.has(result as object)) gradeResults.set(grade as object, result as object);
  return grade;
}

/** Process-local provenance join used by the existing shared-ledger adapter. Never restored from JSON. */
export function isQualifiedCodingPair(result: CodingRunnerResult, grade: CodingGrade): boolean {
  return issuedResults.has(result as object) && gradeResults.get(grade as object) === result;
}

function assertFixture(fixture: CodingFixture): void {
  if (!fixture || fixture.version !== CODING_CONTROL_VERSION || fixture.caseId !== "coding-sum-four-v1" || typeof fixture.stdin !== "string"
    || Buffer.byteLength(fixture.stdin, "utf8") > CODING_FIXTURE_MAX_BYTES || !hex64.test(fixture.digest)
    || sha256(fixture.stdin) !== fixture.digest || typeof fixture.expectedStdout !== "string"
    || Buffer.byteLength(fixture.expectedStdout, "utf8") > CODING_STDOUT_MAX_BYTES
    || typeof fixture.prompt !== "string" || Buffer.byteLength(fixture.prompt, "utf8") > CODING_FIXTURE_MAX_BYTES * 2)
    throw new Error("coding-fixture-invalid");
  const values = fixture.stdin.split("\n");
  if (values.length !== 5 || values[4] !== "" || values.slice(0, 4).some(row => !/^-?(?:0|[1-9][0-9]*)$/.test(row)))
    throw new Error("coding-fixture-invalid");
  const numbers = values.slice(0, 4).map(Number);
  if (numbers.some(value => !Number.isSafeInteger(value) || value < -50 || value > 50)
    || numbers.some((value, index) => String(value) !== values[index])
    || fixture.expectedStdout !== `${numbers.reduce((sum, value) => sum + value, 0)}\n`
    || fixture.prompt !== `Write JavaScript source that reads four signed decimal integers from stdin and prints their sum followed by a newline. Input:\n${fixture.stdin}`)
    throw new Error("coding-fixture-invalid");
}

/** This is intentionally not a host implementation. Requires the admitted native systemd/bwrap backend. */
export const codingNativeBackendStatus = () => ({ state: "unavailable" as const,
  reason: "native-unit-profile-and-readback-adapter-not-wired" as const });
