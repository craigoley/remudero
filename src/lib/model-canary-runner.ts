/** Serial, bounded task execution. The adapter retains the existing cash and subscription guards. */
import { randomUUID } from "node:crypto";
import { canaryTools, gradeCanary, type CanaryCase, type CanaryToolEvent } from "./model-canary-suite.js";
import { type CanaryAttempt, type CanaryRun } from "./model-canary-metrics.js";

export interface CanaryPin { model: string; route: string; effort: string; suiteHash: string; billing: "api" | "subscription" }
export interface CanaryResponse {
  text: string;
  toolCalls: { name: string; args: unknown }[];
  resources: Omit<CanaryAttempt, "id">;
}
export interface CanaryRequest {
  prompt: string;
  pin: CanaryPin;
  history: readonly { response: string; toolResults: readonly CanaryToolEvent[] }[];
  signal: AbortSignal;
  maxOutputBytes: number;
  /** Native message roles, for the weekly retention protocol; never concatenate this into tool authority. */
  conversation?: readonly { role: "system" | "user" | "assistant"; content: string }[];
}
/** Production admission must reserve the existing allowance BEFORE transport, on every call. */
export interface CanaryExecutionPorts {
  admit(pin: CanaryPin, signal: AbortSignal): Promise<{ state: "admitted" } | { state: "refused"; reason: string }>;
  request(input: CanaryRequest): Promise<CanaryResponse>;
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
  limits = { maxCalls: 3, wallMs: 60_000, maxOutputBytes: 16_384 }) {
  if (!Number.isInteger(limits.maxCalls) || limits.maxCalls < 1 || limits.maxCalls > 8
    || !Number.isFinite(limits.wallMs) || limits.wallMs <= 0 || limits.wallMs > 180_000
    || !Number.isInteger(limits.maxOutputBytes) || limits.maxOutputBytes < 1 || limits.maxOutputBytes > 65_536)
    throw new Error("canary-execution-bound-invalid");
  const started = ports.monotonicMs(), abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), limits.wallMs);
  const run: CanaryRun = { id: randomUUID(), caseId: item.id, suiteHash: pin.suiteHash, model: pin.model,
    route: pin.route, effort: pin.effort, family: item.family, verified: null, totalDurationMs: null, attempts: [] };
  const trace: CanaryToolEvent[] = [], history: { response: string; toolResults: CanaryToolEvent[] }[] = [];
  const tool = canaryTools(item);
  let grade: ReturnType<typeof gradeCanary> | null = null, reason = "call-bound", transportError: unknown;
  try {
    for (let call = 0; call < limits.maxCalls; call++) {
      if (abort.signal.aborted || ports.monotonicMs() - started >= limits.wallMs) { reason = "wall-bound"; break; }
      const admission = await untilAbort(abort.signal, () => ports.admit(pin, abort.signal));
      if (admission.state === "refused") { reason = admission.reason; break; }
      if (abort.signal.aborted || ports.monotonicMs() - started >= limits.wallMs) { reason = "wall-bound"; break; }
      const requestStarted = ports.monotonicMs();
      const pending: CanaryAttempt = { id: randomUUID(), durationMs: null, firstTextMs: null, generationMs: null,
        inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null,
        usageRatedUsd: null, billing: pin.billing, servedModel: null, terminal: "error" };
      run.attempts.push(pending);
      const response = await untilAbort(abort.signal, () => ports.request({ prompt: item.prompt, pin, history,
        signal: abort.signal, maxOutputBytes: limits.maxOutputBytes }));
      Object.assign(pending, response.resources);
      if (pending.durationMs === null) {
        const observed = ports.monotonicMs() - requestStarted;
        pending.durationMs = Number.isFinite(observed) && observed >= 0 ? observed : null;
      }
      if (Buffer.byteLength(response.text, "utf8") > limits.maxOutputBytes || response.toolCalls.length > 2) { reason = "output-bound"; run.verified = false; break; }
      if (response.resources.terminal !== "complete") { reason = response.resources.terminal; break; }
      if (response.toolCalls.length === 0) {
        grade = gradeCanary(item, response.text, trace); run.verified = grade.passed; reason = grade.reason; break;
      }
      const results = response.toolCalls.map(call => tool(call.name, call.args)); trace.push(...results);
      history.push({ response: response.text, toolResults: results });
      if (results.some(t => t.denied)) { reason = "tool-or-authority-violation"; run.verified = false; break; }
    }
  } catch (error) {
    // The real adapter owns ambiguous charge reservations and any error usage evidence.
    reason = abort.signal.aborted ? "transport-timeout" : "transport-error";
    const pending = run.attempts.at(-1);
    if (pending && abort.signal.aborted) pending.terminal = "timeout";
    transportError = error;
  } finally { clearTimeout(timer); }
  const elapsed = ports.monotonicMs() - started;
  run.totalDurationMs = Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
  run.outcomeReason = reason;
  // Refusals are part of availability coverage too, with zero provider attempts.
  await ports.save(run, grade);
  return { state: run.verified === null ? "unavailable" as const : "scored" as const, reason, run, trace, grade,
    error: transportError };
}
