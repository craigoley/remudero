/** Unregistered SDK/owner/save binding. Native containment and adoption remain separate gates. */
import { randomUUID } from "node:crypto";
import { codingCaseRequests, prepareCodingSubmission } from "./model-canary-coding.js";
import { codingSlotCase } from "./model-canary-coding-checkpoint.js";
import { executeOwnedCoding, type OwnedCodingPorts } from "./model-canary-coding-owned.js";
import { nativeCanaryAdapter } from "./model-canary-native-adapter.js";
import type { NativeCanarySessionConfig, NativeCanarySessionPorts } from "./model-canary-native-session.js";
import type { CanaryExecutionPorts, CanaryRequest } from "./model-canary-runner.js";
import type { CanarySlot } from "./model-canary-schedule.js";
import type { CanarySlotOwner } from "./model-canary-owner.js";
import { projectCanaryRuns, type CanaryRun, type CanaryTrialBlock } from "./model-canary-metrics.js";
import { untilAbort } from "./model-canary-runner.js";
import { buildCodingCanarySchedule, codingScheduledTrial } from "./model-canary-coding-schedule.js";

type NativeResponse = Awaited<ReturnType<ReturnType<typeof nativeCanaryAdapter>["request"]>>;
export interface NativeCodingPorts {
  /** Existing schedule attribution only; this bridge does not create or register a schedule. */
  trial?: CanaryTrialBlock;
  eligibility: OwnedCodingPorts["eligibility"];
  executor: OwnedCodingPorts["executor"];
  generation: Pick<CanaryExecutionPorts, "admit" | "save" | "monotonicMs"> & {
    request(input: CanaryRequest): Promise<NativeResponse>;
  };
}

/** Existing native authority/resource capture plus caller-owned subscription admission and save. */
export function nativeCodingGeneration(config: NativeCanarySessionConfig,
  ports: Pick<CanaryExecutionPorts, "admit" | "save" | "monotonicMs">, native?: NativeCanarySessionPorts) {
  const adapter = nativeCanaryAdapter(config, native);
  return { ...ports, request: (input: CanaryRequest) => adapter.request(input) };
}

export async function executeNativeOwnedCoding(owner: CanarySlotOwner, slot: CanarySlot,
  image: string, ports: NativeCodingPorts, wallMs = 60_000) {
  if (!Number.isSafeInteger(wallMs) || wallMs < 1 || wallMs > 60_000) throw new Error("coding-native-wall-bound-invalid");
  const id = codingSlotCase(slot), item = codingCaseRequests().find(c => c.id === id)!;
  const scheduled = codingScheduledTrial(slot);
  if (scheduled !== undefined && ports.trial !== undefined && JSON.stringify(scheduled) !== JSON.stringify(ports.trial))
    throw new Error("coding-native-trial-slot-conflict");
  const trial = scheduled ?? (ports.trial === undefined ? undefined : structuredClone(ports.trial));
  if (trial !== undefined) {
    if (!trial || trial.slotId !== slot.id || trial.aaLabel !== slot.aaLabel) throw new Error("coding-native-trial-slot-conflict");
    // The canonical projection validates day, digest, membership, order and block
    // identity before claiming ownership or starting a possibly billed request.
    projectCanaryRuns([{ id: slot.id, caseId: id, suiteHash: item.suiteHash, model: slot.pin.model,
      route: slot.pin.route, effort: slot.pin.effort, family: "coding", verified: null,
      totalDurationMs: null, attempts: [], trial }]);
  }
  let run: CanaryRun | undefined, started = 0, saveAttempted = false;
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reason = "coding-native-generation-unavailable";
  const save = async (outcome: string) => {
    if (!run || saveAttempted) return;
    // Set before the write: an ambiguous save is never silently retried.
    saveAttempted = true;
    const elapsed = ports.generation.monotonicMs() - started;
    run.totalDurationMs = Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
    run.outcomeReason = outcome;
    await ports.generation.save(structuredClone(run), null);
  };
  try {
    const result = await executeOwnedCoding(owner, slot, image, {
      eligibility: ports.eligibility, executor: ports.executor,
      submission: async () => {
        started = ports.generation.monotonicMs();
        run = { id: randomUUID(), caseId: id, suiteHash: item.suiteHash, model: slot.pin.model,
          route: slot.pin.route, effort: slot.pin.effort, family: "coding", verified: null,
          totalDurationMs: null, attempts: [], ...(trial === undefined ? {} : { trial }) };
        timer = setTimeout(() => abort.abort(), wallMs);
        const signal = abort.signal;
        const admitted = await untilAbort(signal, () => ports.generation.admit(slot.pin, signal));
        if (admitted.state !== "admitted") {
          reason = "coding-native-subscription-admission-refused"; throw new Error(reason);
        }
        const pending = { id: randomUUID(), durationMs: null, firstTextMs: null, generationMs: null,
          inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null,
          servedModel: null, billing: "subscription" as const, usageRatedUsd: null, terminal: "error" as "error" | "timeout" | "complete" };
        run.attempts.push(pending);
        const response = await untilAbort(signal, () => ports.generation.request({
          prompt: [item.instruction, item.outputContract, "Baseline src/solution.mjs:", item.baseline].join("\n\n"),
          pin: slot.pin, history: [], signal, maxOutputBytes: 65_536, toolPolicy: "none",
        }));
        clearTimeout(timer); timer = undefined;
        // A positive no-prompt fact removes the provisional SDK invocation. A transport
        // exception keeps its usage unknown; it cannot certify zero provider work.
        if (response.native.promptSent) Object.assign(pending, response.resources, { billing: "subscription", usageRatedUsd: null });
        else run.attempts.pop();
        if (response.native.state !== "complete" || response.resources.terminal !== "complete") {
          reason = "coding-native-transport-or-resource-unavailable"; throw new Error(reason);
        }
        if (!response.native.promptSent || response.toolCalls.length !== 0
          || Buffer.byteLength(response.text, "utf8") > 65_536) {
          reason = "coding-native-output-contract-unavailable"; throw new Error(reason);
        }
        let value: unknown;
        try { value = JSON.parse(response.text); }
        catch { reason = "coding-native-output-json-invalid"; throw new Error(reason); }
        if (prepareCodingSubmission(id, value).state !== "prepared") {
          reason = "coding-native-output-scope-invalid"; throw new Error(reason);
        }
        reason = "coding-native-generation-complete-executor-unqualified";
        return value;
      },
      beforeTerminal: async () => save("coding-native-cleaned-executor-unqualified"),
    });
    await save(result.state === "held" ? "coding-native-held-executor-unqualified" : reason);
    return result;
  } catch (error) {
    if (abort.signal.aborted && run?.attempts.at(-1)) run.attempts.at(-1)!.terminal = "timeout";
    await save(reason);
    throw error;
  } finally {
    clearTimeout(timer); abort.abort();
  }
}

/** Manual, serial preparation bridge. Native qualification and activation remain separate. */
export async function executeNativeCodingSchedule(owner: CanarySlotOwner,
  plan: ReturnType<typeof buildCodingCanarySchedule>, image: string,
  ports: (slot: CanarySlot) => NativeCodingPorts) {
  const expected = buildCodingCanarySchedule(plan.day, plan.seed, plan.caseId, plan.pins, plan.aa);
  if (JSON.stringify(plan) !== JSON.stringify(expected)) throw new Error("canary-coding-schedule-changed");
  let terminalSlots = 0, alreadyTerminal = 0;
  const receipt = { executorQualified: false as const, scope: "unregistered-mechanics-only" as const };
  for (const input of expected.slots) {
    const slot = structuredClone(input), phase = owner.phase(slot);
    if (phase === "terminal") { alreadyTerminal++; continue; }
    if (phase === "started") return { ...receipt, state: "held" as const, terminalSlots, alreadyTerminal, nextSlot: slot.id };
    const result = await executeNativeOwnedCoding(owner, slot, image, ports(structuredClone(slot)));
    if (result.state === "terminal") { terminalSlots++; continue; }
    if (result.state === "already-owned-or-terminal" && owner.phase(slot) === "terminal") { alreadyTerminal++; continue; }
    return { ...receipt, state: result.state === "deferred" ? "deferred" as const : "held" as const,
      terminalSlots, alreadyTerminal, nextSlot: slot.id };
  }
  return { ...receipt, state: "finished" as const, terminalSlots, alreadyTerminal, nextSlot: null };
}
