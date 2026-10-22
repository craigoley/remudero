/** Unregistered private coding bridge; no scheduling, runtime setup or provider activation. */
import type { CanarySlotOwner } from "./model-canary-owner.js";
import { codingSlotCase } from "./model-canary-coding-checkpoint.js";
import { canarySlotEligible, type CanarySlot, type CanarySchedulePorts } from "./model-canary-schedule.js";
import { executeCodingIsolated, type CodingExecutorPorts } from "./model-canary-coding-executor.js";

export interface OwnedCodingPorts {
  eligibility: CanarySchedulePorts["eligibility"];
  /** The owner is claimed before generation; production adapters still own request admission. */
  submission(slot: CanarySlot): Promise<unknown>;
  executor: CodingExecutorPorts;
  /** The canonical save must finish before releasing a positively cleaned owner. */
  beforeTerminal?(execution: Awaited<ReturnType<typeof executeCodingIsolated>>): Promise<void>;
}

export async function executeOwnedCoding(owner: CanarySlotOwner, slot: CanarySlot, image: string, ports: OwnedCodingPorts) {
  const id = codingSlotCase(slot);
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("coding-owner-image-invalid");
  const eligible = async () => canarySlotEligible(slot, await ports.eligibility(slot));
  if (!await eligible()) return { state: "deferred" as const, reason: "coding-production-or-qualification-admission", executorQualified: false as const };
  if ((await ports.executor.admission()).admitted !== true)
    return { state: "deferred" as const, reason: "coding-native-admission-unqualified", executorQualified: false as const };
  if (owner.claim(slot) !== "claimed") return { state: "already-owned-or-terminal" as const, executorQualified: false as const };
  // Any exception after this point retains the durable started row. No age-based recovery.
  if (!await eligible()) return { state: "held" as const, reason: "coding-production-changed-after-claim", executorQualified: false as const };
  const value = await ports.submission(slot);
  const result = await executeCodingIsolated(id, value, image, {
    command: (args, cwd, timeout) => ports.executor.command(args, cwd, timeout),
    checkpoint: async event => { owner.codingCheckpoint(slot, event); },
    admission: async () => {
      if (!await eligible()) return { admitted: false, reason: "coding-production-changed-before-execution" };
      return ports.executor.admission();
    },
  });
  if (result.cleanup !== "confirmed") return { state: "held" as const, reason: result.reason, executorQualified: false as const, execution: result };
  await ports.beforeTerminal?.(result);
  // Early scope/runtime refusal has no checkpoint and remains held for explicit reconciliation.
  owner.codingTerminal(slot, result);
  return { state: "terminal" as const, executorQualified: false as const, execution: result };
}
