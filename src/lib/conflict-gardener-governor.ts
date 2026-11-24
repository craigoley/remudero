export const CONFLICT_GARDEN_ACT = "conflict_garden.act";
export const CONFLICT_GARDEN_VERIFIED = "conflict_garden.verified";
export const CONFLICT_GARDEN_TIERS = ["deterministic", "round", "wedge"] as const;

export type ConflictGardenTier = typeof CONFLICT_GARDEN_TIERS[number];
type Receipt = Record<string, unknown>;

/** A week is the fleet study's observation window and the ceiling on retained evidence. */
export const CONFLICT_GARDEN_WINDOW_MS = 7 * 24 * 3_600_000;

export function conflictGardenGovernorVerdict(
  action: ConflictGardenTier, receipts: readonly Receipt[], controls: { nowMs: number; prNumber?: number },
): { tier: "live" | "slow" | "shadow" | "stopped"; reason: string } {
  const within = (row: Receipt) => {
    const age = controls.nowMs - Date.parse(String(row.ts));
    return row.tier === action && age >= 0 && age <= CONFLICT_GARDEN_WINDOW_MS;
  };
  const acts = receipts.filter(row => row.step === CONFLICT_GARDEN_ACT && within(row));
  const writes = acts.filter(row => row.outcome === "pushed" || row.outcome === "round");
  const pushedIds = new Set(writes.filter(row => typeof row.new_head_sha === "string").map(row => row.act_id));
  const harm = new Set(receipts.filter(row => row.step === CONFLICT_GARDEN_VERIFIED && within(row) &&
    row.harmful === true && typeof row.act_id === "string" && pushedIds.has(row.act_id)).map(row => row.act_id));
  if (harm.size >= 2) return { tier: "stopped", reason: "two pushed heads caused harm within the evidence window" };
  const cleanShadow = acts.some(row => row.outcome === "shadow");
  if (!cleanShadow && writes.length === 0)
    return { tier: "shadow", reason: "this tier has no clean shadow or live receipt in the evidence window" };
  const times = writes.map(row => Date.parse(String(row.ts))).sort((a, b) => a - b);
  const gaps = times.slice(1).map((time, i) => time - times[i]!).filter(gap => gap > 0).sort((a, b) => a - b);
  const backoff = gaps[Math.floor(gaps.length / 2)];
  const last = controls.prNumber === undefined ? undefined : Math.max(...writes
    .filter(row => row.pr_number === controls.prNumber).map(row => Date.parse(String(row.ts))));
  if (backoff !== undefined && last !== undefined && controls.nowMs - last < backoff)
    return { tier: "slow", reason: "this PR is inside the tier's measured inter-act backoff" };
  return { tier: "live", reason: "a clean shadow or live receipt supports this tier" };
}
