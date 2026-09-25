import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
// @ts-expect-error The canonical parser is a plain .mjs script and intentionally has no TS declaration file.
import { parsePlanIndex as parsePlanIndexFromGenerator } from "../../scripts/generate-plan-index.mjs";

/**
 * Promptsmith — the plan-index READ side (W1-T37, MASTER-PLAN §8A Tier 2).
 *
 * The plan (MASTER-PLAN.md, ~1900 lines and growing) is NOT shipped to workers — that would be a
 * context tax paid on every run, and it only grows. Instead this module renders a compact PLAN
 * INDEX: section headings + one-line summaries + a grep hint, generated from MASTER-PLAN.md's
 * `## ` headings in MASTER-PLAN.md at read time. Workers have grep/glob to retrieve the full
 * section when needed. The cached value is keyed by the source content hash, so edits made
 * before a plan PR is committed are visible immediately.
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

/** The plan index: which file it was built from, and its entries in document order. */
export interface PlanIndex {
  source: string;
  entries: PlanIndexEntry[];
}

const parsePlanIndex = parsePlanIndexFromGenerator as (text: string) => PlanIndexEntry[];

const MAX_CACHE_ENTRIES = 16;
const cache = new Map<string, PlanIndex>();

/** Build from MASTER-PLAN.md and reuse the canonical generator parser for unchanged contents. */
export function loadPlanIndex(sourcePath: string): PlanIndex | null {
  let text: string;
  try {
    text = readFileSync(sourcePath, "utf8");
  } catch {
    return null;
  }
  const hash = createHash("sha256").update(text).digest("hex");
  const cached = cache.get(hash);
  if (cached) return cached;
  const entries = parsePlanIndex(text);
  const index = { source: "MASTER-PLAN.md", entries };
  cache.set(hash, index);
  if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
  return index;
}

/**
 * Render the plan index as a CONTEXT block: the source filename (the worker's grep target) and
 * one line per section — its heading and one-line summary. Empty entries render "" so a caller
 * can safely omit the whole block ({@link loadPlanIndex} returns `null` if the source is missing).
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
