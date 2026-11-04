/** Same-process bridge from the scheduled app runner to the existing owner and qualified host backend. */
import type { CanarySlotOwner } from "./model-canary-owner.js";
import type { CanarySlot } from "./model-canary-schedule.js";
import { codingAttemptConsumptionBinding, isRegisteredCanarySlotOwner } from "./model-canary-coding-capabilities.js";
import { registerQualifiedCodingExecutionPort } from "./model-canary-coding-port-capability.js";
import { bindCodingExecutionAuthority, executeCodingCandidate, parseCodingCandidate,
  refuseCodingBeforeHost, unavailableCodingAttempt, type CodingRunnerResult } from "./model-canary-coding.js";
import { createSystemdBwrapCodingExecutor, getQualifiedLinuxCodingBounds,
  isQualifiedLinuxCodingProfile, type QualifiedLinuxCodingProfile } from "./model-canary-systemd-bwrap-backend.js";
import type { CanaryExecutionPorts } from "./model-canary-runner.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import type { SpawnWorkerArgs, WorkerResult } from "./worker.js";
import { resolveInstallRoot } from "./install-root.js";

/** Provider transport stays outside the candidate namespace; no worker tools see the owner store. */
export type CodingWorker = (args: SpawnWorkerArgs) => Promise<Pick<WorkerResult,
  "exit" | "text" | "isError" | "apiError" | "workerDurationMs" | "workerFirstTextMs" | "tokens"
  | "tokenUsageState" | "sdkReportedUsageRatedUsd" | "notionalCostUsd" | "servedModel" | "executionEvidence">>;

export function codingWorkerRequestPorts(config: Config, ownerDirectory: string,
  worker: CodingWorker): CanaryExecutionPorts {
  return {
    // spawnWorker owns live capacity admission and the ordinary shared allowance before transport.
    admit: async pin => pin.billing === "subscription" && pin.route === "claude" && config.overflow !== "api_key"
      ? { state: "admitted" } : { state: "refused", reason: "coding-subscription-route-required" },
    monotonicMs: () => performance.now(),
    save: async () => {}, // The terminal callback persists the complete run in the existing owner.
    request: async (request, context) => {
      if (!context || request.history.length || request.allowedTools?.length)
        throw new Error("coding-worker-request-contract-invalid");
      const cwd = mkdtempSync(join(ownerDirectory, "coding-request-"));
      let workerStarted = false, closed = false;
      try {
        const { renderWorkerSettings } = await import("./worker.js");
        const installRoot = resolveInstallRoot(config);
        const settingsFile = renderWorkerSettings({ templatePath: join(installRoot, "settings", "worker.json"),
          hooksDir: join(installRoot, "hooks"), outPath: join(cwd, "worker-settings.json") });
        workerStarted = true;
        const result = await worker({ config, cwd, permissionMode: "dontAsk",
          settingsFile,
          prompt: `Return only a JSON object with one string property, source, containing the JavaScript program.\n${request.prompt}`,
          model: request.pin.model, effort: request.pin.effort,
          mountProvider: "claude", mcpIsolation: "repo-knowledge-only",
          tools: [], cashTools: [], maxTurns: 1, signal: request.signal,
          runId: context.runId, taskId: "MODEL-CANARY-CODING" });
        if (!result.exit || result.exit.kind === "unobserved") throw new Error("coding-worker-closure-unavailable");
        closed = true;
        const tokens = result.tokenUsageState === "observed" ? result.tokens : null;
        return { text: result.text, toolCalls: [], resources: {
          durationMs: result.workerDurationMs ?? null, firstTextMs: result.workerFirstTextMs ?? null,
          generationMs: null, inputTokens: tokens?.input ?? null, outputTokens: tokens?.output ?? null,
          cacheReadTokens: tokens?.cacheRead ?? null, cacheWriteTokens: tokens?.cacheCreation ?? null,
          reasoningTokens: null, usageRatedUsd: result.sdkReportedUsageRatedUsd ?? result.notionalCostUsd ?? null,
          billing: request.pin.billing, servedModel: result.servedModel ?? null,
          terminal: result.isError || result.apiError || result.exit.kind === "signal"
            || result.exit.kind === "exit" && result.exit.code !== 0 ? "error" as const : "complete" as const,
          executionEvidence: result.executionEvidence,
        } };
      } finally {
        // A rejected/ambiguous worker retains its scratch beside its held slot for native recovery.
        if (!workerStarted || closed) rmSync(cwd, { recursive: true, force: true });
      }
    },
  };
}

type ExecuteCodingInput = NonNullable<CanaryExecutionPorts["executeCoding"]> extends (input: infer I) => Promise<CodingRunnerResult> ? I : never;
/**
 * Requires the actual existing slot owner and native-issued Linux profile capability. This factory
 * never constructs a profile from config or launches a second owner; absent these native inputs it
 * returns null, allowing the schedule to defer before provider admission.
 */
export function createCodingCanaryExecutionPort(input: {
  slot: CanarySlot;
  owner: CanarySlotOwner;
  profile: QualifiedLinuxCodingProfile | null;
}): NonNullable<CanaryExecutionPorts["executeCoding"]> | null {
  if (!isRegisteredCanarySlotOwner(input.owner) || !isQualifiedLinuxCodingProfile(input.profile)) return null;
  const configured = getQualifiedLinuxCodingBounds(input.profile);
  if (!configured) return null;
  const execute = createSystemdBwrapCodingExecutor(input.profile);
  const port: NonNullable<CanaryExecutionPorts["executeCoding"]> = async (request: ExecuteCodingInput) => {
    if (request.slotId !== input.slot.id || request.caseId !== input.slot.caseId
      || request.suiteHash !== input.slot.pin.suiteHash || !request.runId || !request.canaryAttemptId
      || !request.workerSpawnAttemptId || !/^[a-f0-9]{64}$/.test(request.sourceDigest))
      return refuseCodingBeforeHost("coding-case-binding-mismatch");
    let candidate: ReturnType<typeof parseCodingCandidate>;
    try { candidate = parseCodingCandidate(request.responseText); }
    catch { // A malformed worker response is explicitly refused before host execution.
      return refuseCodingBeforeHost("coding-response-invalid"); }
    if (candidate.sourceDigest !== request.sourceDigest)
      return refuseCodingBeforeHost("coding-case-binding-mismatch");
    const consumed = input.owner.consumeCodingAttempt(input.slot, { runId: request.runId,
      canaryAttemptId: request.canaryAttemptId, workerSpawnAttemptId: request.workerSpawnAttemptId,
      sourceDigest: candidate.sourceDigest });
    if (consumed.state === "already-consumed") return unavailableCodingAttempt("owner-attempt-already-consumed");
    if (consumed.state !== "consumed") return refuseCodingBeforeHost("owner-profile-unavailable");
    const binding = codingAttemptConsumptionBinding(consumed.capability);
    if (!binding || binding.runId !== request.runId || binding.slotId !== request.slotId
      || binding.caseId !== request.caseId || binding.suiteHash !== request.suiteHash
      || binding.canaryAttemptId !== request.canaryAttemptId
      || binding.workerSpawnAttemptId !== request.workerSpawnAttemptId
      || binding.sourceDigest !== candidate.sourceDigest)
      return unavailableCodingAttempt("owner-attempt-already-consumed");
    const authority = bindCodingExecutionAuthority({ binding, configured,
      execute: nativeInput => execute(nativeInput), consumption: consumed.capability });
    return executeCodingCandidate({ binding, fixture: request.fixture, responseText: request.responseText,
      authority, signal: request.signal });
  };
  return registerQualifiedCodingExecutionPort(port);
}
