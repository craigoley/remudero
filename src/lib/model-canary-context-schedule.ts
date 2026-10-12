/** Durable whole-profile slots. Repetition requests are never a cache-hit guarantee. */
import { createHash } from "node:crypto";
import { fixedClock } from "./clock.js";
import { contextCanaryProtocol, executeContextCanary } from "./model-canary-context.js";
import { canaryTrialBlockId, type CanaryRun, type CanaryTrialBlock } from "./model-canary-metrics.js";
import type { CanaryPin } from "./model-canary-runner.js";
import type { CanarySlot, CanarySchedulePorts } from "./model-canary-schedule.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface CanaryContextContract {
  version: "canary-context-slot-v1";
  bytes: 2048 | 16384 | 65536;
  treatment: "first-use" | "repeat";
  namespace: string;
  protocolDigest: string;
  day: string;
  seed: string;
  pins: CanaryPin[];
  aa: boolean;
  trial: CanaryTrialBlock;
}

/** Pin every arm to one byte protocol, and deterministically interleave model/effort arms. */
export function buildContextCanarySchedule(day: string, seed: string, bytes: 2048 | 16384 | 65536,
  treatment: "first-use" | "repeat", namespace: string, pins: readonly CanaryPin[], aa = false) {
  const protocol = contextCanaryProtocol(bytes, treatment, namespace), date = Date.parse(`${day}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(date)
    || fixedClock(date).iso().slice(0, 10) !== day || typeof seed !== "string" || !seed || seed.length > 128
    || typeof aa !== "boolean") throw new Error("canary-context-schedule-input-invalid");
  if (!Array.isArray(pins) || !pins.length || pins.length * (aa ? 2 : 1) > 128)
    throw new Error("canary-context-schedule-population-invalid");
  const canonical = pins.map(p => {
    if (!p || typeof p.model !== "string" || !p.model || p.model.length > 128
      || typeof p.route !== "string" || !p.route || p.route.length > 128
      || typeof p.effort !== "string" || !p.effort || p.effort.length > 32
      || p.suiteHash !== protocol.suiteHash || !["api", "subscription"].includes(p.billing))
      throw new Error("canary-context-schedule-pin-invalid");
    return { model: p.model, route: p.route, effort: p.effort, suiteHash: p.suiteHash, billing: p.billing };
  });
  if (new Set(canonical.map(p => JSON.stringify(p))).size !== canonical.length)
    throw new Error("canary-context-schedule-pin-invalid");
  const version = "canary-context-schedule-v1" as const, caseId = `context-${bytes}-${treatment}`;
  const core = canonical.flatMap(pin => (aa ? ["A", "B"] as const : [null]).map(aaLabel => ({
    id: digest([version, day, seed, bytes, treatment, namespace, pin, aaLabel]), caseId, pin, aaLabel,
  }))).sort((a, b) => digest([seed, a.id]).localeCompare(digest([seed, b.id])));
  const scheduleDigest = digest(core), plannedSlotIds = core.map(s => s.id);
  const blockId = canaryTrialBlockId(day, protocol.suiteHash, caseId, scheduleDigest, plannedSlotIds);
  const slots: CanarySlot[] = core.map((slot, position) => ({ ...slot, context: {
    version: "canary-context-slot-v1", bytes, treatment, namespace, protocolDigest: protocol.suiteHash,
    day, seed, pins: structuredClone(canonical), aa, trial: { version: "canary-trial-block-v1", day,
      scheduleDigest, blockId, slotId: slot.id, plannedSlotIds: [...plannedSlotIds], position, aaLabel: slot.aaLabel },
  } }));
  return { version, day, seed, bytes, treatment, namespace, suiteHash: protocol.suiteHash,
    pins: canonical, aa, slots, digest: scheduleDigest, concurrency: 1 as const };
}

/** Canonical identity is checked by the owner before a claim, not just by the runner. */
export function contextSlotCallBound(slot: CanarySlot): 1 | 2 | 8 {
  if (slot.context === undefined) return 8;
  const c = slot.context;
  if (!c || c.version !== "canary-context-slot-v1" || slot.retention !== undefined)
    throw new Error("canary-context-slot-invalid");
  const plan = buildContextCanarySchedule(c.day, c.seed, c.bytes, c.treatment, c.namespace, c.pins, c.aa);
  const expected = plan.slots.find(s => s.id === slot.id);
  if (!expected || slot.caseId !== expected.caseId || slot.aaLabel !== expected.aaLabel
    || JSON.stringify(slot.pin) !== JSON.stringify(expected.pin)
    || JSON.stringify(c) !== JSON.stringify(expected.context)) throw new Error("canary-context-slot-invalid");
  return c.treatment === "repeat" ? 2 : 1;
}

/** Only complete canonical phases may be scored; all uncertain usage still belongs to this slot. */
export function contextTerminalMatches(slot: CanarySlot, run: CanaryRun, state: "scored" | "unavailable") {
  const calls = contextSlotCallBound(slot);
  if (calls === 8) return true;
  const c = slot.context!, r = run.contextProfile;
  const expected = c.treatment === "repeat" ? ["primer", "probe"] : ["probe"];
  if (run.family !== "evidence" || !r || r.version !== "canary-context-v1" || r.bytes !== c.bytes
    || r.treatment !== c.treatment || r.byteUnit !== "utf8-bytes" || r.cacheGuarantee !== "none"
    || JSON.stringify(run.trial) !== JSON.stringify(c.trial) || !Array.isArray(r.phases)
    || r.phases.length > calls || run.attempts.length > calls
    || !["unavailable", "observed-zero", "observed-read"].includes(r.probeCache)) return false;
  const ids: string[] = [];
  for (const [index, phase] of r.phases.entries()) {
    if (!phase || phase.phase !== expected[index] || ![true, false, null].includes(phase.verified)
      || !Array.isArray(phase.attemptIds) || phase.attemptIds.length > 1
      || (phase.verified !== null && phase.attemptIds.length !== 1)
      || (phase.verified === null && index !== r.phases.length - 1)) return false;
    ids.push(...phase.attemptIds);
  }
  if (new Set(ids).size !== ids.length || JSON.stringify(ids) !== JSON.stringify(run.attempts.map(a => a.id))) return false;
  const probe = r.phases.find(p => p.phase === "probe"), attempt = probe?.attemptIds.length === 1
    ? run.attempts.find(a => a.id === probe.attemptIds[0]) : undefined;
  const cache = attempt?.cacheReadTokens;
  const observed = cache === undefined || cache === null || !Number.isSafeInteger(cache) || cache < 0
    ? "unavailable" : cache > 0 ? "observed-read" : "observed-zero";
  if (r.probeCache !== observed) return false;
  if (state === "unavailable") return run.verified === null
    && (r.phases.length < calls || r.phases.some(p => p.verified === null));
  return r.phases.length === calls && run.attempts.length === calls
    && r.phases.every(p => typeof p.verified === "boolean") && run.attempts.every(a => a.terminal === "complete")
    && run.verified === r.phases.every(p => p.verified === true);
}

export async function executeContextCanarySchedule(plan: ReturnType<typeof buildContextCanarySchedule>,
  ports: CanarySchedulePorts) {
  const expected = buildContextCanarySchedule(plan.day, plan.seed, plan.bytes, plan.treatment,
    plan.namespace, plan.pins, plan.aa);
  if (JSON.stringify(plan) !== JSON.stringify(expected)) throw new Error("canary-context-schedule-changed");
  const protocol = contextCanaryProtocol(plan.bytes, plan.treatment, plan.namespace);
  let completed = 0, skipped = 0;
  for (const slot of plan.slots) {
    const e = await ports.eligibility(slot);
    if (!e.sourceAdopted || !e.adapterQualified || e.productionBusy || e.squeeze
      || (slot.pin.billing === "subscription" ? !e.spareSubscription : !e.experimentalCashAllowed || e.premium))
      return { state: "deferred" as const, completed, skipped, nextSlot: slot.id };
    if (await ports.claim(slot) !== "claimed") { skipped++; continue; }
    // A save or transport exception leaves durable ownership held, including a possibly billed primer.
    const execution = ports.ports(slot);
    const result = await executeContextCanary(protocol, slot.pin, { ...execution, save: async (run, grade) => {
      run.trial = structuredClone(slot.context!.trial);
      await execution.save(run, grade);
    } });
    const state = result.run.verified === null ? "unavailable" as const : "scored" as const;
    const outcome = { state, run: result.run, reason: result.run.outcomeReason!, trace: [], grade: null, error: undefined };
    await ports.terminal(slot, outcome); completed++;
    if (state === "unavailable") return { state: "deferred" as const, completed, skipped, nextSlot: null };
  }
  return { state: "finished" as const, completed, skipped, nextSlot: null };
}
