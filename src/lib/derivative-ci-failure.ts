import type { CiFailure } from "./sweep.js";

// W1-T5378: `ci` only collapses the shard matrix; drop it beside real failures, keep it when alone.
export function dropDerivativeAggregateCiFailure(failures: readonly CiFailure[]): CiFailure[] {
  const others = failures.filter((f) => f.name !== "ci");
  return others.length > 0 ? others : [...failures];
}
