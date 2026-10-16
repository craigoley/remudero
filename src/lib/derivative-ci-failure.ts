import type { CiFailure } from "./sweep.js";

// W1-T5378: `ci` only collapses the shard matrix; drop it beside real failures or when its log is empty.
export function dropDerivativeAggregateCiFailure(failures: readonly CiFailure[]): CiFailure[] {
  const others = failures.filter((f) => f.name !== "ci");
  if (others.length > 0) return others;
  return failures.filter((f) => (f.logTail ?? "").trim() !== "");
}
