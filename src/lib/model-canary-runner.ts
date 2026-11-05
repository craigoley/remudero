/** Serial, bounded task execution. The adapter retains the existing cash and subscription guards. */
import { randomUUID } from "node:crypto";
import { canaryTools, gradeCanary, type CanaryCase, type CanaryToolEvent } from "./model-canary-suite.js";
import { type CanaryAttempt, type CanaryRun } from "./model-canary-metrics.js";
import { isQualifiedCodingExecutionPort } from "./model-canary-coding-port-capability.js";
import { createCodingProviderRequestLifecycle, markCodingProviderRequestClosed,
  markCodingProviderRequestStarted, markCodingProviderRequestUncertain } from "./model-canary-coding-capabilities.js";
import { buildPrivateCanaryRequest, privateCorpusCaseMatches, privateCorpusCodingFixture, privateCorpusMetadata,
  type ValidatedPrivateCorpus } from "./model-canary-private-corpus.js";
import { capturedPrivateTraceReceipt, createApplicationTraceRecorder, gradePrivateTrace,
  type CapturedCanaryTrace, type PrivateTraceBindingV1, type PrivateTraceReceiptV1, type PrivateTraceGrade } from "./model-canary-trace-grader.js";
import { parseCodingCandidate, refuseCodingBeforeHost, scoreCodingControl,
  type CodingGrade, type CodingRunnerResult } from "./model-canary-coding.js";
import type { CodingExecutionObservationV1 } from "./model-canary-metrics.js";

export interface CanaryPin { model: string; route: string; effort: string; suiteHash: string; billing: "api" | "subscription" }
export interface CanaryResponse {
  text: string;
  toolCalls: { name: string; args: unknown }[];
  resources: Omit<CanaryAttempt, "id">;
}
export interface CanaryInternalAttemptContextV1 {
  version: "canary-internal-attempt-context-v1";
  runId: string;
  canaryAttemptId: string;
}
export interface CanaryRequest {
  prompt: string;
  /** The native suite hash is persisted locally and is never sent to a model provider. */
  pin: Omit<CanaryPin, "suiteHash">;
  history: readonly { response: string; toolResults: readonly CanaryToolEvent[] }[];
  signal: AbortSignal;
  maxOutputBytes: number;
  allowedTools?: readonly string[];
  /** Native message roles, for the weekly retention protocol; never concatenate this into tool authority. */
  conversation?: readonly { role: "system" | "user" | "assistant"; content: string }[];
}
export interface CanaryExecutionOutcome {
  state: "unavailable" | "scored";
  reason: string;
  run: CanaryRun;
  trace: CanaryToolEvent[];
  grade: { passed: boolean; reason: string; schemaValid: boolean } | null;
  privateGrade?: PrivateTraceGrade;
  privateTrace?: PrivateTraceReceiptV1;
  codingGrade?: CodingGrade;
  codingResult?: CodingRunnerResult;
  /** App-issued WeakMap capability; never derived from model output or persisted JSON. */
  codingProviderRequestLifecycle?: object;
  error: unknown;
}

/** Production admission must reserve the existing allowance BEFORE transport, on every call. */
export interface CanaryExecutionPorts {
  admit(pin: CanaryPin, signal: AbortSignal): Promise<{ state: "admitted" } | { state: "refused"; reason: string }>;
  /** Internal identity is a separate argument and must not be serialized into the provider prompt. */
  /** For coding, resolve only after the native worker attempt is closed; abort/rejection without closure proof remains held. */
  request(input: CanaryRequest, context?: CanaryInternalAttemptContextV1): Promise<CanaryResponse>;
  /** Must consume the existing owner slot before host execution; absence is an explicit refusal. */
  executeCoding?(input: { runId: string; slotId: string; suiteHash: string; caseId: string;
    canaryAttemptId: string; workerSpawnAttemptId: string; sourceDigest: string; responseText: string;
    fixture: NonNullable<ReturnType<typeof privateCorpusCodingFixture>>; signal: AbortSignal }): Promise<CodingRunnerResult>;
  save(run: CanaryRun, grade: { passed: boolean; reason: string; schemaValid: boolean } | null): Promise<void>;
  monotonicMs(): number;
}

async function untilAbort<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw new Error("canary-wall-bound");
  let onAbort: () => void = () => {};
  const expiry = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("canary-wall-bound")); signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([operation(), expiry]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

export async function executeCanary(item: CanaryCase, pin: CanaryPin, ports: CanaryExecutionPorts,
  limits = { maxCalls: 3, wallMs: 60_000, maxOutputBytes: 16_384 },
  privateContext?: { corpus: ValidatedPrivateCorpus; slotId: string }): Promise<CanaryExecutionOutcome> {
  if (!Number.isInteger(limits.maxCalls) || limits.maxCalls < 1 || limits.maxCalls > 8
    || !Number.isFinite(limits.wallMs) || limits.wallMs <= 0 || limits.wallMs > 180_000
    || !Number.isInteger(limits.maxOutputBytes) || limits.maxOutputBytes < 1 || limits.maxOutputBytes > 65_536)
    throw new Error("canary-execution-bound-invalid");
  if (item.family === "coding" && (!privateContext || !privateCorpusCaseMatches(privateContext.corpus, item)))
    throw new Error("coding-private-corpus-required");
  if (item.family === "coding" && !isQualifiedCodingExecutionPort(ports.executeCoding))
    throw new Error("coding-native-backend-unavailable");
  const started = ports.monotonicMs(), abort = new AbortController();
  const maxCalls = item.family === "coding" ? 1 : limits.maxCalls;
  const timer = setTimeout(() => abort.abort(), limits.wallMs);
  const run: CanaryRun = { id: randomUUID(), caseId: item.id, suiteHash: pin.suiteHash, model: pin.model,
    route: pin.route, effort: pin.effort, family: item.family, verified: null, totalDurationMs: null, attempts: [] };
  const trace: CanaryToolEvent[] = [], history: { response: string; toolResults: CanaryToolEvent[] }[] = [];
  let privateRecorder: ReturnType<typeof createApplicationTraceRecorder> | null = null;
  let privateToken: CapturedCanaryTrace | null = null;
  let privateGrade: ReturnType<typeof gradePrivateTrace> | null = null;
  let privateRequest: ReturnType<typeof buildPrivateCanaryRequest> | null = null;
  let privateBinding: PrivateTraceBindingV1 | null = null;
  let privateTrace: PrivateTraceReceiptV1 | null = null;
  if (privateContext) {
    try {
      if (typeof privateContext.slotId !== "string" || privateContext.slotId.length < 1
        || privateContext.slotId.length > 160 || typeof pin.suiteHash !== "string"
        || !/^[0-9a-f]{64}$/.test(pin.suiteHash)) throw new Error("private-canary-binding-invalid");
      if (!privateCorpusCaseMatches(privateContext.corpus, item)) throw new Error("private-canary-case-mismatch");
      const metadata = privateCorpusMetadata(privateContext.corpus);
      const scorerDigest = metadata?.cases.find(row => row.caseId === item.id)?.scorerDigest;
      if (!metadata || !scorerDigest) throw new Error("private-canary-corpus-case-unavailable");
      privateBinding = { version: "private-canary-trace-binding-v1", runId: run.id, slotId: privateContext.slotId,
        caseId: item.id, suiteHash: pin.suiteHash, corpusDigest: metadata.digest, scorerDigest };
      privateRequest = buildPrivateCanaryRequest(privateContext.corpus, item.id);
      if (privateRequest.state !== "available") throw new Error("private-canary-request-unavailable");
      if (item.family !== "coding") privateRecorder = createApplicationTraceRecorder(privateContext.corpus, item.id, privateBinding);
    } catch (error) {
      clearTimeout(timer);
      throw error;
    }
  }
  let grade: ReturnType<typeof gradeCanary> | null = null, reason = "call-bound", transportError: unknown;
  let codingResult: CodingRunnerResult | undefined, codingGrade: CodingGrade | undefined;
  const codingProviderRequestLifecycle = item.family === "coding" ? createCodingProviderRequestLifecycle() : undefined;
  let codingToolDenied = false;
  const tool = privateRecorder ? (name: string, args: unknown) => privateRecorder!.dispatch(name, args) : canaryTools(item);
  const finalizePrivate = (finalText: string | null, preserveExecutionReason = true) => {
    if (!privateContext || !privateRecorder || !privateBinding || privateToken) return;
    try {
      privateToken = privateRecorder.finish(finalText);
      privateGrade = gradePrivateTrace(privateContext.corpus, item.id, finalText, privateToken, privateBinding);
      privateTrace = capturedPrivateTraceReceipt(privateToken);
      if (privateGrade.state === "scored") {
        run.verified = privateGrade.passed;
        reason = privateGrade.reason;
        grade = { passed: privateGrade.passed, reason: privateGrade.reason, schemaValid: privateGrade.schemaValid };
      } else {
        run.verified = null;
        grade = null;
        if (!preserveExecutionReason) reason = privateGrade.reason;
      }
    } catch {
      // Scorer failure leaves verification unknown and retains any prior execution failure.
      run.verified = null;
      grade = null;
      if (!preserveExecutionReason) reason = "private-trace-grading-unavailable";
    }
  };
  try {
    for (let call = 0; call < maxCalls; call++) {
      if (abort.signal.aborted || ports.monotonicMs() - started >= limits.wallMs) { reason = "wall-bound"; break; }
      const admission = await untilAbort(abort.signal, () => ports.admit(pin, abort.signal));
      if (admission.state === "refused") { reason = admission.reason; break; }
      if (abort.signal.aborted || ports.monotonicMs() - started >= limits.wallMs) { reason = "wall-bound"; break; }
      const requestStarted = ports.monotonicMs();
      const pending: CanaryAttempt = { id: randomUUID(), durationMs: null, firstTextMs: null, generationMs: null,
        inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null,
        usageRatedUsd: null, billing: pin.billing, servedModel: null, terminal: "error" };
      run.attempts.push(pending);
      const requestInput = {
        prompt: privateRequest?.state === "available" ? privateRequest.request.prompt : item.prompt,
        pin: { model: pin.model, route: pin.route, effort: pin.effort, billing: pin.billing },
        history, signal: abort.signal, maxOutputBytes: limits.maxOutputBytes,
        ...(privateRequest?.state === "available" ? { allowedTools: privateRequest.request.allowedTools } : {}),
      };
      const requestContext = item.family === "coding" ? { version: "canary-internal-attempt-context-v1" as const,
        runId: run.id, canaryAttemptId: pending.id } : undefined;
      let response: CanaryResponse;
      if (codingProviderRequestLifecycle) {
        markCodingProviderRequestStarted(codingProviderRequestLifecycle);
        let actualRequest: Promise<CanaryResponse>;
        try { actualRequest = ports.request(requestInput, requestContext); }
        catch (error) {
          markCodingProviderRequestUncertain(codingProviderRequestLifecycle);
          throw error;
        }
        const settledRequest = actualRequest.then(value => {
          markCodingProviderRequestClosed(codingProviderRequestLifecycle);
          return value;
        }, error => {
          markCodingProviderRequestUncertain(codingProviderRequestLifecycle);
          throw error;
        });
        try { response = await untilAbort(abort.signal, () => settledRequest); }
        catch (error) {
          markCodingProviderRequestUncertain(codingProviderRequestLifecycle);
          throw error;
        }
      } else response = await untilAbort(abort.signal, () => ports.request(requestInput, requestContext));
      Object.assign(pending, response.resources);
      const workerAttemptId = response.resources.executionEvidence?.attemptId;
      if (typeof workerAttemptId === "string") pending.workerExecutionJoin = { version: "canary-worker-execution-join-v1",
        runId: run.id, canaryAttemptId: pending.id, workerSpawnAttemptId: workerAttemptId,
        unit: "worker-spawn", measurementScope: "returned-terminal-result" };
      if (pending.durationMs === null) {
        const observed = ports.monotonicMs() - requestStarted;
        pending.durationMs = Number.isFinite(observed) && observed >= 0 ? observed : null;
      }
      if (Buffer.byteLength(response.text, "utf8") > limits.maxOutputBytes || response.toolCalls.length > 2) { reason = "output-bound"; run.verified = false; break; }
      if (response.resources.terminal !== "complete") { reason = response.resources.terminal; break; }
      if (response.toolCalls.length === 0) {
        if (item.family === "coding") {
          const fixture = privateContext ? privateCorpusCodingFixture(privateContext.corpus, item.id) : null;
          if (!fixture) { reason = "coding-private-fixture-unavailable"; run.verified = null; break; }
          const workerSpawnAttemptId = typeof workerAttemptId === "string"
            && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workerAttemptId)
            ? workerAttemptId : null;
          let candidateDigest: string | null = null, candidateInvalid = false;
          try { candidateDigest = parseCodingCandidate(response.text).sourceDigest; }
          catch { // Keep parse failure distinct until the explicit invalid-response refusal below.
            candidateInvalid = true; }
          codingResult = candidateInvalid ? refuseCodingBeforeHost("coding-response-invalid")
            : candidateDigest === null ? refuseCodingBeforeHost("coding-response-invalid")
            : workerSpawnAttemptId === null ? refuseCodingBeforeHost("worker-spawn-identity-unavailable")
            : !ports.executeCoding ? refuseCodingBeforeHost("native-backend-unavailable")
            : await ports.executeCoding({ runId: run.id, slotId: privateContext!.slotId, suiteHash: pin.suiteHash,
              caseId: item.id, canaryAttemptId: pending.id, workerSpawnAttemptId,
              sourceDigest: candidateDigest, responseText: response.text, fixture, signal: abort.signal });
          codingGrade = scoreCodingControl(fixture, codingResult);
          pending.codingExecution = { version: "canary-coding-execution-observation-v1",
            canaryAttemptId: pending.id, workerSpawnAttemptId: workerAttemptId ?? null,
            codingExecutionAttemptId: codingResult.binding?.codingExecutionAttemptId ?? null,
            hostExecutionId: codingResult.execution.hostExecutionId,
            sourceDigest: codingResult.binding?.sourceDigest ?? candidateDigest, fixtureDigest: fixture.digest,
            state: codingGrade.state, reason: codingGrade.reason,
            configured: "configured" in codingResult ? codingResult.configured : null,
            observed: "observed" in codingResult ? codingResult.observed : null,
            closure: codingResult.execution.closure };
          codingGrade.state === "scored" ? (run.verified = codingGrade.passed) : (run.verified = null);
          reason = codingGrade.reason;
        } else if (privateContext) finalizePrivate(response.text, false);
        else { grade = gradeCanary(item, response.text, trace); run.verified = grade.passed; reason = grade.reason; }
        break;
      }
      let results: CanaryToolEvent[];
      try { results = response.toolCalls.map(call => tool(call.name, call.args)); }
      catch (error) {
        if (!privateRecorder) throw error;
        reason = error instanceof Error && /^private-trace-[a-z-]+$/.test(error.message)
          ? error.message : "private-trace-capture-unavailable";
        break;
      }
      trace.push(...results);
      history.push({ response: response.text, toolResults: results });
      if (results.some(t => t.denied)) {
        if (item.family === "coding") codingToolDenied = true;
        if (privateContext) finalizePrivate(response.text || null);
        else { reason = "tool-or-authority-violation"; run.verified = false; }
        break;
      }
    }
  } catch (error) {
    // The real adapter owns ambiguous charge reservations and any error usage evidence.
    reason = abort.signal.aborted ? "transport-timeout" : "transport-error";
    const pending = run.attempts.at(-1);
    if (pending && abort.signal.aborted) pending.terminal = "timeout";
    transportError = error;
  } finally { clearTimeout(timer); }
  if (item.family === "coding" && !codingResult) {
    const fixture = privateContext ? privateCorpusCodingFixture(privateContext.corpus, item.id) : null;
    if (!fixture) throw new Error("coding-private-fixture-unavailable");
    codingResult = refuseCodingBeforeHost(codingToolDenied ? "coding-tool-request-denied" : "native-backend-unavailable");
    codingGrade = scoreCodingControl(fixture, codingResult);
    run.verified = null;
    reason = codingToolDenied ? "coding-tool-request-denied" : reason === "call-bound" ? codingGrade.reason : reason;
    const last = run.attempts.at(-1);
    if (last) last.codingExecution = { version: "canary-coding-execution-observation-v1",
      canaryAttemptId: last.id, workerSpawnAttemptId: last.workerExecutionJoin?.workerSpawnAttemptId ?? null,
      codingExecutionAttemptId: null, hostExecutionId: null, sourceDigest: null, fixtureDigest: fixture.digest,
      state: "unavailable", reason: codingGrade.reason, configured: null, observed: null, closure: "proven" };
  }
  if (privateContext && !privateToken) finalizePrivate(null);
  const elapsed = ports.monotonicMs() - started;
  run.totalDurationMs = Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
  run.outcomeReason = reason;
  // Refusals are part of availability coverage too, with zero provider attempts.
  await ports.save(run, grade);
  return { state: run.verified === null ? "unavailable" as const : "scored" as const, reason, run, trace, grade,
    ...(codingResult ? { codingResult } : {}), ...(codingGrade ? { codingGrade } : {}),
    ...(codingProviderRequestLifecycle ? { codingProviderRequestLifecycle } : {}),
    ...(privateContext && privateTrace && privateGrade ? { privateGrade, privateTrace } : {}), error: transportError };
}
