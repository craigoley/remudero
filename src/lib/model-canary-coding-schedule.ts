/** Canonical private coding plans. No provider, timer, installation or execution activation. */
import { createHash } from "node:crypto";
import { fixedClock } from "./clock.js";
import { codingCaseRequests, type CodingCaseId } from "./model-canary-coding.js";
import { canaryTrialBlockId, type CanaryTrialBlock } from "./model-canary-metrics.js";
import type { CanaryPin } from "./model-canary-runner.js";
import type { CanarySlot } from "./model-canary-schedule.js";


const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** One fixed case across subscription arms; interleaved A/A positions stay in one block. */
export function buildCodingCanarySchedule(day: string, seed: string, caseId: CodingCaseId,
  pins: readonly CanaryPin[], aa = false) {
  const item = codingCaseRequests().find(c => c.id === caseId), date = Date.parse(`${day}T00:00:00Z`);
  if (!item || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(date)
    || fixedClock(date).iso().slice(0, 10) !== day || typeof seed !== "string" || !seed || seed.length > 128
    || typeof aa !== "boolean") throw new Error("canary-coding-schedule-input-invalid");
  if (!Array.isArray(pins) || !pins.length || pins.length * (aa ? 2 : 1) > 128)
    throw new Error("canary-coding-schedule-population-invalid");
  const canonical = pins.map(p => {
    if (!p || typeof p.model !== "string" || !p.model || p.model.length > 128
      || typeof p.route !== "string" || !p.route || p.route.length > 128
      || typeof p.effort !== "string" || !p.effort || p.effort.length > 32
      || p.suiteHash !== item.suiteHash || p.billing !== "subscription") throw new Error("canary-coding-schedule-pin-invalid");
    return { model: p.model, route: p.route, effort: p.effort, suiteHash: p.suiteHash, billing: p.billing };
  });
  if (new Set(canonical.map(p => JSON.stringify(p))).size !== canonical.length)
    throw new Error("canary-coding-schedule-pin-invalid");
  const version = "canary-coding-schedule-v1" as const;
  const core = canonical.flatMap(pin => (aa ? ["A", "B"] as const : [null]).map(aaLabel => ({
    id: digest([version, day, seed, caseId, pin, aaLabel]), caseId, pin, aaLabel,
  }))).sort((a, b) => digest([seed, a.id]).localeCompare(digest([seed, b.id])));
  const scheduleDigest = digest(core), plannedSlotIds = core.map(s => s.id);
  const blockId = canaryTrialBlockId(day, item.suiteHash, caseId, scheduleDigest, plannedSlotIds);
  const slots: CanarySlot[] = core.map((slot, position) => ({ ...slot, coding: {
    version: "canary-coding-slot-v1", day, seed, caseId, pins: structuredClone(canonical), aa,
    trial: { version: "canary-trial-block-v1", day, scheduleDigest, blockId, slotId: slot.id,
      plannedSlotIds: [...plannedSlotIds], position, aaLabel: slot.aaLabel },
  } }));
  return { version, day, seed, caseId, suiteHash: item.suiteHash, pins: canonical, aa,
    slots, digest: scheduleDigest, concurrency: 1 as const };
}

/** Rebuild the actual plan: a plausible hash alone cannot establish schedule membership. */
export function codingScheduledTrial(slot: CanarySlot): CanaryTrialBlock | undefined {
  if (slot.coding === undefined) return undefined;
  const c = slot.coding;
  if (!c || c.version !== "canary-coding-slot-v1" || slot.context !== undefined || slot.retention !== undefined)
    throw new Error("canary-coding-slot-invalid");
  const expected = buildCodingCanarySchedule(c.day, c.seed, c.caseId, c.pins, c.aa).slots.find(s => s.id === slot.id);
  if (!expected || JSON.stringify(slot) !== JSON.stringify(expected)) throw new Error("canary-coding-slot-invalid");
  return structuredClone(c.trial);
}
