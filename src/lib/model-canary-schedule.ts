/** A serial schedule and durable slot protocol; its ports reuse the existing budget and collector. */
import { createHash } from "node:crypto";
import { fixedClock } from "./clock.js";
import { canarySuiteDigest, type CanaryCase } from "./model-canary-suite.js";
import { executeCanary, type CanaryPin, type CanaryExecutionPorts } from "./model-canary-runner.js";
import { canaryTrialBlockId, type CanaryTrialBlock } from "./model-canary-metrics.js";
import type { CanaryRetentionContract } from "./model-canary-retention.js";

const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export interface CanarySlot { id: string; caseId: string; pin: CanaryPin; aaLabel: "A" | "B" | null;
  retention?: CanaryRetentionContract }

/** Same case for every arm; seed interleaves arm order instead of batching one model first. */
export function buildCanarySchedule(day: string, seed: string, cases: readonly CanaryCase[], pins: readonly CanaryPin[], aa = false) {
  const date = Date.parse(`${day}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(date) || fixedClock(date).iso().slice(0, 10) !== day || !seed)
    throw new Error("canary-schedule-day-or-seed-invalid");
  if (!cases.length || !pins.length || cases.length * pins.length * (aa ? 2 : 1) > 128
    || new Set(cases.map(c => c.id)).size !== cases.length) throw new Error("canary-schedule-population-invalid");
  const suiteHash = canarySuiteDigest(cases);
  const keys = pins.map(p => JSON.stringify(p));
  if (new Set(keys).size !== keys.length || pins.some(p => p.suiteHash !== suiteHash
    || !p.model || !p.route || !p.effort || !["api", "subscription"].includes(p.billing)))
    throw new Error("canary-schedule-pin-invalid");
  const slots: CanarySlot[] = [];
  for (const item of cases) {
    const group = pins.flatMap(pin => (aa ? ["A", "B"] as const : [null]).map(aaLabel => {
      const id = digest(JSON.stringify(["canary-schedule-v1", day, seed, item.id, pin, aaLabel]));
      return { id, caseId: item.id, pin, aaLabel };
    })).sort((a, b) => digest(seed + a.id).localeCompare(digest(seed + b.id)));
    slots.push(...group);
  }
  return { version: "canary-schedule-v1" as const, day, suiteHash, aa, slots,
    digest: digest(JSON.stringify(slots)), concurrency: 1 as const };
}

export interface CanarySchedulePorts {
  /** Claim is an atomic durable pending->started transition. Started/uncertain never means free. */
  claim(slot: CanarySlot): Promise<"claimed" | "already-owned-or-terminal">;
  eligibility(slot: CanarySlot): Promise<{ sourceAdopted: boolean; adapterQualified: boolean;
    productionBusy: boolean; squeeze: boolean; spareSubscription: boolean; experimentalCashAllowed: boolean; premium: boolean }>;
  ports(slot: CanarySlot): CanaryExecutionPorts;
  /** Final receipt and slot identity join are durable; the collector remains the sole ingestion path. */
  terminal(slot: CanarySlot, outcome: Awaited<ReturnType<typeof executeCanary>>): Promise<void>;
}

export async function executeCanarySchedule(plan: ReturnType<typeof buildCanarySchedule>, cases: readonly CanaryCase[], ports: CanarySchedulePorts) {
  if (plan.suiteHash !== canarySuiteDigest(cases) || plan.digest !== digest(JSON.stringify(plan.slots)))
    throw new Error("canary-schedule-changed");
  let completed = 0, skipped = 0;
  for (const slot of plan.slots) {
    const plannedSlotIds = plan.slots.filter(s => s.caseId === slot.caseId).map(s => s.id);
    const trial: CanaryTrialBlock = { version: "canary-trial-block-v1", day: plan.day,
      scheduleDigest: plan.digest, slotId: slot.id, plannedSlotIds, position: plannedSlotIds.indexOf(slot.id),
      aaLabel: slot.aaLabel,
      blockId: canaryTrialBlockId(plan.day, plan.suiteHash, slot.caseId, plan.digest, plannedSlotIds) };
    const e = await ports.eligibility(slot);
    if (!e.sourceAdopted || !e.adapterQualified || e.productionBusy || e.squeeze
      || (slot.pin.billing === "subscription" ? !e.spareSubscription : !e.experimentalCashAllowed || e.premium))
      return { state: "deferred" as const, completed, skipped, nextSlot: slot.id };
    const item = cases.find(c => c.id === slot.caseId);
    if (!item || slot.pin.suiteHash !== plan.suiteHash) throw new Error("canary-schedule-slot-invalid");
    if (await ports.claim(slot) !== "claimed") { skipped++; continue; }
    // An exception after claiming leaves ownership held. Never silently retry a possibly billed call.
    const execution = ports.ports(slot);
    const outcome = await executeCanary(item, slot.pin, { ...execution, save: async (run, grade) => {
      run.trial = structuredClone(trial);
      await execution.save(run, grade);
    } });
    await ports.terminal(slot, outcome); completed++;
    if (outcome.state === "unavailable") return { state: "deferred" as const, completed, skipped, nextSlot: null };
  }
  return { state: "finished" as const, completed, skipped, nextSlot: null };
}
