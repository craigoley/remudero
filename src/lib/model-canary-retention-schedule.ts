/** One canonical native conversation per durable slot. This does not activate a schedule. */
import { createHash } from "node:crypto";
import { fixedClock } from "./clock.js";
import { canaryTrialBlockId, type CanaryRun, type CanaryTrialBlock } from "./model-canary-metrics.js";
import { retentionCanaryProtocol, executeRetentionCanary } from "./model-canary-retention.js";
import type { CanaryPin } from "./model-canary-runner.js";
import type { CanarySlot, CanarySchedulePorts } from "./model-canary-schedule.js";

export interface CanaryRetentionContract {
  version: "canary-retention-slot-v1";
  turns: 25 | 50;
  protocolDigest: string;
  day: string;
  seed: string;
  pins: CanaryPin[];
  aa: boolean;
  trial: CanaryTrialBlock;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** All arms use the same whole-conversation protocol. Arm order is deterministically interleaved. */
export function buildRetentionCanarySchedule(day: string, seed: string, turns: 25 | 50,
  pins: readonly CanaryPin[], aa = false) {
  const protocol = retentionCanaryProtocol(turns), date = Date.parse(`${day}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(date)
    || fixedClock(date).iso().slice(0, 10) !== day || typeof seed !== "string" || !seed || seed.length > 128
    || typeof aa !== "boolean") throw new Error("canary-retention-schedule-input-invalid");
  if (!Array.isArray(pins) || !pins.length || pins.length * (aa ? 2 : 1) > 128)
    throw new Error("canary-retention-schedule-population-invalid");
  const canonical = pins.map(p => {
    if (!p || typeof p.model !== "string" || !p.model || p.model.length > 128
      || typeof p.route !== "string" || !p.route || p.route.length > 128
      || typeof p.effort !== "string" || !p.effort || p.effort.length > 32
      || p.suiteHash !== protocol.suiteHash || !["api", "subscription"].includes(p.billing))
      throw new Error("canary-retention-schedule-pin-invalid");
    return { model: p.model, route: p.route, effort: p.effort, suiteHash: p.suiteHash, billing: p.billing };
  });
  if (new Set(canonical.map(p => JSON.stringify(p))).size !== canonical.length)
    throw new Error("canary-retention-schedule-pin-invalid");
  const version = "canary-retention-schedule-v1" as const, caseId = `retention-${turns}`;
  const core = canonical.flatMap(pin => (aa ? ["A", "B"] as const : [null]).map(aaLabel => ({
    id: digest([version, day, seed, turns, caseId, pin, aaLabel]), caseId, pin, aaLabel,
  }))).sort((a, b) => digest([seed, a.id]).localeCompare(digest([seed, b.id])));
  const scheduleDigest = digest(core), plannedSlotIds = core.map(s => s.id);
  const blockId = canaryTrialBlockId(day, protocol.suiteHash, caseId, scheduleDigest, plannedSlotIds);
  const slots: CanarySlot[] = core.map((slot, position) => ({ ...slot, retention: {
    version: "canary-retention-slot-v1", turns, protocolDigest: protocol.suiteHash, day, seed,
    pins: structuredClone(canonical), aa, trial: { version: "canary-trial-block-v1", day,
      scheduleDigest, blockId, slotId: slot.id, plannedSlotIds: [...plannedSlotIds], position, aaLabel: slot.aaLabel },
  } }));
  return { version, day, seed, turns, suiteHash: protocol.suiteHash, pins: canonical, aa,
    slots, digest: scheduleDigest, concurrency: 1 as const };
}

/** A family label or arbitrary hash cannot widen ordinary ownership authority. */
export function retentionSlotTurnBound(slot: CanarySlot): 8 | 25 | 50 {
  if (slot.retention === undefined) return 8;
  const c = slot.retention;
  if (!c || c.version !== "canary-retention-slot-v1") throw new Error("canary-retention-slot-invalid");
  const plan = buildRetentionCanarySchedule(c.day, c.seed, c.turns, c.pins, c.aa);
  const expected = plan.slots.find(s => s.id === slot.id);
  if (!expected || slot.caseId !== expected.caseId || slot.aaLabel !== expected.aaLabel
    || JSON.stringify(slot.pin) !== JSON.stringify(expected.pin)
    || JSON.stringify(c) !== JSON.stringify(expected.retention)) throw new Error("canary-retention-slot-invalid");
  return c.turns;
}

/** Partial conversations retain usage, but only all scored canonical turns may be called scored. */
export function retentionTerminalMatches(slot: CanarySlot, run: CanaryRun, state: "scored" | "unavailable") {
  const turns = retentionSlotTurnBound(slot);
  if (turns === 8) return true;
  const r = run.retention;
  if (run.family !== "retention" || !r || JSON.stringify(run.trial) !== JSON.stringify(slot.retention!.trial)
    || !Number.isInteger(r.turnsObserved) || r.turnsObserved < 0 || r.turnsObserved > turns
    || !Number.isInteger(r.violations) || r.violations < 0 || r.violations > r.turnsObserved
    || (r.violations === 0 ? r.firstViolationTurn !== null
      : !Number.isInteger(r.firstViolationTurn) || r.firstViolationTurn! < 1 || r.firstViolationTurn! > r.turnsObserved)
    || run.attempts.length < r.turnsObserved || run.attempts.length > Math.min(turns, r.turnsObserved + 1)
    || new Set(run.attempts.map(a => a.id)).size !== run.attempts.length) return false;
  if (state === "unavailable") return run.verified === null;
  return r.turnsObserved === turns && run.attempts.length === turns
    && run.attempts.every(a => a.terminal === "complete") && run.verified === (r.violations === 0);
}

export async function executeRetentionCanarySchedule(plan: ReturnType<typeof buildRetentionCanarySchedule>,
  ports: CanarySchedulePorts) {
  const expected = buildRetentionCanarySchedule(plan.day, plan.seed, plan.turns, plan.pins, plan.aa);
  if (JSON.stringify(plan) !== JSON.stringify(expected)) throw new Error("canary-retention-schedule-changed");
  const protocol = retentionCanaryProtocol(plan.turns);
  let completed = 0, skipped = 0;
  for (const slot of plan.slots) {
    const e = await ports.eligibility(slot);
    if (!e.sourceAdopted || !e.adapterQualified || e.productionBusy || e.squeeze
      || (slot.pin.billing === "subscription" ? !e.spareSubscription : !e.experimentalCashAllowed || e.premium))
      return { state: "deferred" as const, completed, skipped, nextSlot: slot.id };
    if (await ports.claim(slot) !== "claimed") { skipped++; continue; }
    // Save/transport failure after claim preserves uncertainty; it never permits a replay.
    const execution = ports.ports(slot);
    const result = await executeRetentionCanary(protocol, slot.pin, { ...execution, save: async (run, grade) => {
      run.trial = structuredClone(slot.retention!.trial);
      await execution.save(run, grade);
    } });
    const state = result.run.verified === null ? "unavailable" as const : "scored" as const;
    const outcome = { state, run: result.run, reason: result.run.outcomeReason!, trace: [],
      grade: state === "unavailable" ? null : { passed: result.run.verified === true,
        reason: "retention-scored", schemaValid: result.violations === 0 }, error: undefined };
    await ports.terminal(slot, outcome); completed++;
    if (state === "unavailable") return { state: "deferred" as const, completed, skipped, nextSlot: null };
  }
  return { state: "finished" as const, completed, skipped, nextSlot: null };
}
