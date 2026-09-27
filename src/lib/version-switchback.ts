/** A bounded, task-randomized overlap between two versions of one provider. */
import { createHash } from "node:crypto";
import { normalQuantile, twoProportionPower } from "./eval-card.js";

export const SWITCHBACK_ALLOCATION_VERSION = "version-switchback-v1" as const;

export interface VersionSwitchbackWindow {
  id: string;
  provider: string;
  startsAt: string;
  endsAt: string;
  oldModel: string;
  newModel: string;
}

export interface SwitchbackAssignment {
  version: typeof SWITCHBACK_ALLOCATION_VERSION;
  window: VersionSwitchbackWindow;
  taskId: string;
  assignedAt: string;
  arm: "old" | "new";
  model: string;
  propensity: 0.5;
}

export interface SwitchbackOutcome {
  assignment: SwitchbackAssignment;
  /** A provider receipt, never the requested model echoed back. */
  servedModel: string | null;
  success: boolean;
}

function bounds(window: VersionSwitchbackWindow): [number, number] {
  const start = Date.parse(window.startsAt);
  const end = Date.parse(window.endsAt);
  if (!window.id || !window.provider || !window.oldModel || !window.newModel ||
    window.oldModel === window.newModel || !Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new Error("invalid version switchback window");
  }
  return [start, end];
}

/** A retry of the same task keeps its arm. Outside [start, end), the trial is inert. */
export function switchbackArmFor(
  window: VersionSwitchbackWindow,
  taskId: string,
  at: string,
  eligibleModels: readonly string[],
): SwitchbackAssignment | null {
  const [start, end] = bounds(window);
  const now = Date.parse(at);
  if (!taskId || !Number.isFinite(now) || now < start || now >= end ||
    !eligibleModels.includes(window.oldModel) || !eligibleModels.includes(window.newModel)) return null;
  const digest = createHash("sha256")
    .update(`${SWITCHBACK_ALLOCATION_VERSION}\0${window.id}\0${window.provider}\0${taskId}`).digest();
  const arm = digest.readUInt32BE(0) % 2 === 0 ? "old" : "new";
  return {
    version: SWITCHBACK_ALLOCATION_VERSION, window: { ...window }, taskId, assignedAt: at,
    arm, model: arm === "old" ? window.oldModel : window.newModel, propensity: 0.5,
  };
}

function wilson(successes: number, total: number): [number, number] {
  const z = normalQuantile(0.975);
  const p = successes / total;
  const d = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / d;
  const radius = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / d;
  return [Math.max(0, center - radius), Math.min(1, center + radius)];
}

export interface SwitchbackAnalysis {
  window: VersionSwitchbackWindow;
  arms: { old: { tasks: number; successes: number; servedModel: string }; new: { tasks: number; successes: number; servedModel: string } };
  missingServedModel: number;
  misrouted: number;
  difference: number | null;
  interval95: [number, number] | null;
  power: number | null;
  conclusion: string;
}

/** Compare verified provider receipts from this window only; missing/misrouted receipts remain visible. */
export function analyzeSwitchback(
  window: VersionSwitchbackWindow,
  outcomes: readonly SwitchbackOutcome[],
  minimumDetectableEffect = 0.1,
): SwitchbackAnalysis {
  bounds(window);
  if (!(minimumDetectableEffect > 0 && minimumDetectableEffect < 1)) throw new Error("invalid detectable effect");
  const arms = {
    old: { tasks: 0, successes: 0, servedModel: window.oldModel },
    new: { tasks: 0, successes: 0, servedModel: window.newModel },
  };
  const seen = new Set<string>();
  let missingServedModel = 0;
  let misrouted = 0;
  for (const { assignment, servedModel, success } of outcomes) {
    const expected = switchbackArmFor(window, assignment.taskId, assignment.assignedAt,
      [window.oldModel, window.newModel]);
    if (assignment.version !== SWITCHBACK_ALLOCATION_VERSION ||
      assignment.window.id !== window.id || assignment.window.provider !== window.provider ||
      assignment.window.startsAt !== window.startsAt || assignment.window.endsAt !== window.endsAt ||
      assignment.window.oldModel !== window.oldModel || assignment.window.newModel !== window.newModel ||
      expected === null || assignment.arm !== expected.arm || assignment.model !== expected.model ||
      seen.has(assignment.taskId)) continue;
    seen.add(assignment.taskId);
    if (servedModel === null) { missingServedModel++; continue; }
    if (servedModel !== assignment.model) { misrouted++; continue; }
    arms[assignment.arm].tasks++;
    if (success) arms[assignment.arm].successes++;
  }
  const old = arms.old;
  const newer = arms.new;
  if (old.tasks === 0 || newer.tasks === 0) return {
    window, arms, missingServedModel, misrouted, difference: null, interval95: null,
    power: null, conclusion: "insufficient verified outcomes",
  };
  const oldRate = old.successes / old.tasks;
  const newRate = newer.successes / newer.tasks;
  const [oldLow, oldHigh] = wilson(old.successes, old.tasks);
  const [newLow, newHigh] = wilson(newer.successes, newer.tasks);
  const interval95: [number, number] = [newLow - oldHigh, newHigh - oldLow];
  const power = twoProportionPower(Math.min(old.tasks, newer.tasks), oldRate,
    Math.min(1 - 1e-9, Math.max(1e-9, oldRate + (oldRate + minimumDetectableEffect <= 1 ? 1 : -1) * minimumDetectableEffect)), 0.05);
  return {
    window, arms, missingServedModel, misrouted, difference: newRate - oldRate, interval95,
    power: Number.isFinite(power) ? power : null,
    conclusion: interval95[0] > 0 || interval95[1] < 0 ? "detected change" :
      `no detected change (power ${Number.isFinite(power) ? power.toFixed(2) : "unknown"})`,
  };
}
