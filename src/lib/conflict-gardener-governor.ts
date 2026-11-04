export const CONFLICT_GARDEN_TIERS = ["deterministic", "round", "wedge"] as const;
export type ConflictGardenTier = typeof CONFLICT_GARDEN_TIERS[number];
export type ConflictGardenRow = Record<string, unknown>;
export interface ConflictGardenAct { outcome: string; newHeadSha?: string; reason?: string }
export interface ConflictGardenControls { pause?: string; emergencyStop?: string; quietHours?: string }
export interface ConflictGardenVerdict { tier: "live" | "slow" | "shadow" | "stopped"; reason: string }

// OBSERVATION WINDOW: bootstrap memory spans the same trailing week as conflict episodes.
export const CONFLICT_GARDEN_WINDOW_MS = 7 * 24 * 3_600_000;
export const conflictRowTime = (row: ConflictGardenRow): number => Date.parse(String(row.ts));
export function conflictP90(values: readonly number[]): number | undefined {
  const sorted = values.filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(sorted.length * 0.9) - 1] : undefined;
}

/** Pure, independently enforced by the pass and the core daemon. */
export function conflictGardenGovernorVerdict(
  tier: ConflictGardenTier, receipts: readonly ConflictGardenRow[], controls: ConflictGardenControls, nowMs: number,
): ConflictGardenVerdict {
  const hold = controls.emergencyStop ?? controls.pause ?? controls.quietHours;
  if (hold !== undefined) return { tier: "stopped", reason: `fleet hold: ${hold}` };
  const all = receipts.filter(r => (r.step === "conflict_garden.act" || r.step === "conflict_garden.verified") &&
    r.tier === tier && conflictRowTime(r) <= nowMs).sort((a, b) => conflictRowTime(a) - conflictRowTime(b));
  const live = all.filter(r => r.step === "conflict_garden.act" && r.mode === "live");
  const gaps = live.slice(1).map((r, i) => conflictRowTime(r) - conflictRowTime(live[i]!));
  const backoff = conflictP90(gaps) ?? 0;
  const memory = Math.max(CONFLICT_GARDEN_WINDOW_MS, backoff * 2);
  const recent = all.filter(r => nowMs - conflictRowTime(r) <= memory);
  const actKey = (r: ConflictGardenRow) => r.act_id ?? `${r.pr_number}@${r.new_head_sha}`;
  const pushed = new Map(live.filter(r => typeof r.new_head_sha === "string").map(r => [actKey(r), r]));
  const harms = recent.filter(r => r.step === "conflict_garden.verified" && pushed.has(actKey(r)) &&
    (r.reverted === true || r.outcome === "ci-red" && pushed.get(actKey(r))!.parent_green === true));
  const distinctHarms = new Map(harms.map(r => [r.act_id ?? `${r.pr_number}@${r.new_head_sha}`, r]));
  if (distinctHarms.size >= 2) return { tier: "stopped", reason: "harm seen twice: regressed CI or reverted push" };
  const latestHarm = Math.max(-Infinity, ...harms.map(conflictRowTime));
  const clean = recent.some(r => r.step === "conflict_garden.act" && r.mode === "shadow" &&
    r.outcome === "clean" && conflictRowTime(r) > latestHarm);
  if (!clean) return { tier: "shadow", reason: harms.length ? "harm needs a clean shadow record" : "no clean shadow record" };
  const acts = recent.filter(r => r.step === "conflict_garden.act" && r.mode === "live");
  const last = acts.at(-1);
  const previous = last && acts.slice(0, -1).findLast(r => r.pr_number === last.pr_number);
  if (last && previous && conflictRowTime(last) - conflictRowTime(previous) <= backoff && nowMs - conflictRowTime(last) < backoff)
    return { tier: "slow", reason: "PR re-acted inside receipt-derived backoff" };
  return { tier: "live", reason: "clean shadow record; no active harm or backoff" };
}
