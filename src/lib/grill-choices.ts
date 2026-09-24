// src/lib/grill-choices.ts — the ONE grammar for a headless grill's actionable choices.
//
// Triage's AMBIGUOUS verdict and the plan Architect's GRILL verdict both end in an async
// needs-human issue, so both need the same OPTION/RECOMMENDATION lines and the same refusal when
// they are missing. A leaf module (like plan-scope.ts, W1-T2895) keeps plan-architect.ts from
// importing triage.ts and, through it, review.ts.
import type { EscalationOption } from "./escalate.js";

/**
 * `OPTION: <label>|<detail>` lines anywhere in the worker's output — the grill's actionable
 * choices. Idempotent on the `(label, detail)` pair (W1-T2205), since a model can restate or quote
 * its own options back; first occurrence wins.
 */
export function parseGrillOptions(text: string): EscalationOption[] {
  const seen = new Set<string>();
  const options: EscalationOption[] = [];
  for (const m of text.matchAll(/^[ \t]*OPTION[ \t]*:[ \t]*(.+)$/gim)) {
    const raw = m[1].trim();
    const sep = raw.indexOf("|");
    const option = sep >= 0 ? { label: raw.slice(0, sep).trim(), detail: raw.slice(sep + 1).trim() } : { label: raw, detail: "" };
    const key = JSON.stringify([option.label, option.detail]);
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(option);
  }
  return options;
}

/** The LAST `RECOMMENDATION: <label>` line; `""` when none appears. */
export function parseGrillRecommendation(text: string): string {
  const hits = [...text.matchAll(/^[ \t]*RECOMMENDATION[ \t]*:[ \t]*(.+)$/gim)];
  return hits.length ? hits[hits.length - 1][1].trim() : "";
}

/** The LAST `FALSIFIER: <observation>` line — what would prove the recommendation wrong; `""` when none. */
export function parseGrillFalsifier(text: string): string {
  const hits = [...text.matchAll(/^[ \t]*FALSIFIER[ \t]*:[ \t]*(.+)$/gim)];
  return hits.length ? hits[hits.length - 1][1].trim() : "";
}

/**
 * Why a grill's choices are not actionable, or null when they are. A needs-human issue with fewer
 * than two options is a bare alert (MASTER-PLAN §4), and a recommendation naming no option cannot
 * be acted on. `inconsistent` marks the second case, which contradicts the worker's own lines.
 */
export function grillChoiceError(
  verdictName: string,
  options: EscalationOption[],
  recommendation: string,
): { reason: string; inconsistent: boolean } | null {
  if (options.length < 2) {
    return {
      reason: `${verdictName} verdict carries ${options.length} OPTION: line(s) — a grill needs at least 2 actionable choices`,
      inconsistent: false,
    };
  }
  if (!options.some((o) => o.label === recommendation)) {
    return {
      reason: `${verdictName} verdict's RECOMMENDATION (${JSON.stringify(recommendation)}) does not match any OPTION label (${options.map((o) => o.label).join(", ")})`,
      inconsistent: true,
    };
  }
  return null;
}
