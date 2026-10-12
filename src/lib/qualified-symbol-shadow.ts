import { buildAffectedSuitesGraph, selectAffectedSuites, type AffectedSuitesInput } from "./affected-suites.js";

export interface QualifiedSymbolShadow {
  mode: "shadow";
  skipsNothing: true;
  fullRun: boolean;
  floor: string[];
  proposed: string[];
  qualified: string[];
  excludedNamesakes: string[];
  fallback?: string;
}

/** Constrain name-based expansion by its module's reach. The unchanged floor, census,
 * path readers and recent failures remain mandatory. This proposal changes no execution. */
export function qualifiedSymbolShadow(
  changed: readonly string[], input: AffectedSuitesInput, rawSymbolSuites: readonly string[],
): QualifiedSymbolShadow {
  const baseline = selectAffectedSuites(changed, { ...input, symbolSuites: rawSymbolSuites });
  const floor = [...baseline.suites];
  const fallback = (reason: string): QualifiedSymbolShadow => ({
    mode: "shadow", skipsNothing: true, fullRun: baseline.fullRun, floor,
    proposed: [...(baseline.narrow ?? baseline.suites)], qualified: [], excludedNamesakes: [], fallback: reason,
  });
  if (baseline.fullRun) return fallback(baseline.reasons.join("; "));
  const roots = changed.filter((path) => /^(?:src|scripts|bin)\/.*\.(?:ts|mts|js|mjs|cjs)$/.test(path));
  if (roots.length === 0) return fallback("no changed source module to qualify the symbols");
  if (roots.some((path) => !input.files.has(path))) return fallback("a changed source module is absent from the current corpus");
  if (rawSymbolSuites.some((path) => !/^test\/.*\.test\.ts$/.test(path) || !input.files.has(path))) {
    return fallback("the symbol result names a missing or unverified test file");
  }
  const { importers } = buildAffectedSuitesGraph(input.files, roots);
  const reachable = new Set<string>(), queue = [...roots];
  for (let at = 0; at < queue.length; at++) {
    const path = queue[at]!;
    if (reachable.has(path)) continue;
    reachable.add(path);
    for (const caller of importers.get(path) ?? []) queue.push(caller);
  }
  const raw = [...new Set(rawSymbolSuites)].sort();
  const qualified = raw.filter((path) => reachable.has(path));
  // Anything the existing floor protects remains, even if its only name hit is unrelated.
  const protectedSuites = new Set(floor);
  return {
    mode: "shadow", skipsNothing: true, fullRun: false, floor, qualified,
    proposed: [...new Set([...floor, ...qualified])].sort(),
    excludedNamesakes: raw.filter((path) => !reachable.has(path) && !protectedSuites.has(path)),
  };
}

/** Full-suite failures are the oracle, not a smaller proposal or a successful scoped run. */
export function qualifiedShadowFailures(record: QualifiedSymbolShadow, failed: readonly string[]): Array<{
  file: string; floor: "selected" | "missed"; proposed: "selected" | "missed" | "unknown";
}> {
  const floor = new Set(record.floor), proposed = new Set(record.proposed);
  return [...new Set(failed)].sort().map((file) => ({
    file, floor: record.fullRun || floor.has(file) ? "selected" : "missed",
    proposed: record.fallback ? "unknown" : proposed.has(file) ? "selected" : "missed",
  }));
}
