import { readFileSync } from "node:fs";

/**
 * Promptsmith — the plan-index READ side (W1-T37, MASTER-PLAN §8A Tier 2).
 *
 * The plan (MASTER-PLAN.md, ~1900 lines and growing) is NOT shipped to workers — that would be a
 * context tax paid on every run, and it only grows. Instead this module renders a compact PLAN
 * INDEX: section headings + one-line summaries + a grep hint, generated from MASTER-PLAN.md's
 * `## ` headings by `scripts/generate-plan-index.mjs` (`npm run plan-index`) into the committed
 * `plan/plan-index.json`. Workers have grep/glob — this is Claude Code's OWN hybrid model
 * (CLAUDE.md up front + glob/grep for retrieval, which "bypasses the issues of stale indexing")
 * applied to the plan: RETRIEVED, not INJECTED. `npm run plan-index:check` fails when the
 * committed index doesn't match a fresh regeneration (a STALE index), same discipline as the
 * learnings index (W1-T33).
 */

/** One section heading from MASTER-PLAN.md: where it is and what it's about, in one line. */
export interface PlanIndexEntry {
  /** The heading text, verbatim (minus the leading `## `) — also the worker's grep target. */
  heading: string;
  /** 1-indexed line number in the source file, at generation time. */
  line: number;
  /** First line of body prose under the heading, truncated; "" if the section has none. */
  summary: string;
}

/** The generated plan index: which file it was built from, and its entries in document order. */
export interface PlanIndex {
  source: string;
  entries: PlanIndexEntry[];
}

/**
 * Parse a `plan/plan-index.json`. Returns `null` on any missing/malformed index (non-fatal — the
 * recon prompt just omits the index block rather than fail closed on a context-economy
 * optimization; correctness of the run never depends on the index being present).
 */
export function loadPlanIndex(path: string): PlanIndex | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const raw = JSON.parse(text) as unknown;
    const r = raw as { source?: unknown; entries?: unknown };
    if (typeof r !== "object" || r === null || typeof r.source !== "string" || !Array.isArray(r.entries)) {
      return null;
    }
    for (const e of r.entries) {
      if (
        typeof e !== "object" ||
        e === null ||
        typeof (e as PlanIndexEntry).heading !== "string" ||
        typeof (e as PlanIndexEntry).line !== "number" ||
        typeof (e as PlanIndexEntry).summary !== "string"
      ) {
        return null;
      }
    }
    return raw as PlanIndex;
  } catch {
    return null;
  }
}

/**
 * Render the plan index as a CONTEXT block: the source filename (the worker's grep target) and
 * one line per section — its heading and one-line summary. Empty entries render "" so a caller
 * can safely omit the whole block ({@link loadPlanIndex} returning `null` is the normal
 * fresh-checkout-before-first-generation case, not an error).
 */
export function renderPlanIndex(index: PlanIndex): string {
  if (index.entries.length === 0) return "";
  const lines = index.entries.map((e) => `- "${e.heading}" (line ${e.line})${e.summary ? `: ${e.summary}` : ""}`);
  return [
    `PLAN INDEX — ${index.source} is retrieved, not injected. Section headings below are grep`,
    `targets: \`grep -n '<heading text>' ${index.source}\` retrieves the full section if you need`,
    "it; most tasks won't.",
    ...lines,
  ].join("\n");
}
