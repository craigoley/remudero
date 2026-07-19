#!/usr/bin/env node
// scripts/generate-plan-index.mjs
//
// Plan INDEX generator (W1-T37, MASTER-PLAN §8A Tier 2).
//
// MASTER-PLAN.md is ~1900 lines and growing; shipping it whole to every worker is a context tax
// paid every run. This script builds a compact INDEX instead: for every top-level (`## `) section
// heading, its line number and a one-line summary (the first non-blank line of body text under
// that heading). src/lib/plan-index.ts's `renderPlanIndex` turns that into a CONTEXT block workers
// can use to grep MASTER-PLAN.md for the ONE section they actually need — RETRIEVED, not INJECTED,
// same hybrid model as Claude Code's own CLAUDE.md-plus-grep (MASTER-PLAN §8A).
//
// The generated index is content-only (no timestamp) so it is byte-stable across runs when
// MASTER-PLAN.md hasn't changed -- that is what makes `--check` a meaningful staleness gate
// rather than a permanent false positive (same convention as scripts/generate-learnings-index.mjs,
// W1-T33).
//
// Usage:
//   node scripts/generate-plan-index.mjs [--source MASTER-PLAN.md] [--out plan/plan-index.json]
//   node scripts/generate-plan-index.mjs --check   # exit 1 if the committed index is stale

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

/** Max rendered length of a section's one-line summary (chars); longer text is ellipsized. */
const SUMMARY_MAX_CHARS = 160;

/** Strip light markdown emphasis markers so a summary line reads as plain text. */
function stripEmphasis(line) {
  return line.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1");
}

function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "…";
}

/**
 * Parse MASTER-PLAN.md text into one entry per top-level (`## `) section heading: its heading
 * text, 1-indexed line number, and a one-line summary derived from the first non-blank line of
 * body text under that heading (never the heading of a NESTED `### ` subsection, so a heading with
 * no prose before its first subsection still gets a real summary). A section with no body text at
 * all (immediately followed by EOF or another `## ` heading) gets an empty summary.
 */
export function parsePlanIndex(text) {
  const lines = text.split("\n");
  const headingLines = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^## /.test(lines[i])) headingLines.push(i);
  }
  return headingLines.map((idx, k) => {
    const heading = lines[idx].replace(/^##\s+/, "").trim();
    const nextHeadingIdx = k + 1 < headingLines.length ? headingLines[k + 1] : lines.length;
    let summary = "";
    for (let j = idx + 1; j < nextHeadingIdx; j++) {
      const candidate = lines[j].trim();
      if (candidate.length === 0) continue;
      if (/^#{1,6}\s/.test(candidate)) continue; // a nested subheading is not body prose
      summary = truncate(stripEmphasis(candidate), SUMMARY_MAX_CHARS);
      break;
    }
    return { heading, line: idx + 1, summary };
  });
}

/** Canonical JSON serialization -- what makes byte-equality checkable (`--check`). */
export function serializePlanIndex(entries, sourceLabel) {
  return JSON.stringify({ source: sourceLabel, entries }, null, 2) + "\n";
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      source: { type: "string", default: "MASTER-PLAN.md" },
      out: { type: "string" },
      check: { type: "boolean", default: false },
    },
  });
  const outPath = values.out ?? "plan/plan-index.json";

  let fresh;
  try {
    const text = readFileSync(values.source, "utf8");
    fresh = serializePlanIndex(parsePlanIndex(text), values.source);
  } catch (err) {
    console.error(`generate-plan-index: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (values.check) {
    let committed;
    try {
      committed = readFileSync(outPath, "utf8");
    } catch {
      console.error(`generate-plan-index: ${outPath} does not exist -- run 'npm run plan-index' to generate it.`);
      process.exitCode = 1;
      return;
    }
    if (committed !== fresh) {
      console.error(
        `generate-plan-index: ${outPath} is STALE -- it does not match a fresh regeneration from ${values.source}.\n` +
          `Run 'npm run plan-index' and commit the result.`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`generate-plan-index: OK -- ${outPath} matches the current ${values.source}.`);
    process.exitCode = 0;
    return;
  }

  writeFileSync(outPath, fresh);
  const entryCount = JSON.parse(fresh).entries.length;
  console.log(`generate-plan-index: wrote ${outPath} (${entryCount} section(s) from ${values.source}).`);
  process.exitCode = 0;
}

// Only run when executed directly (`node scripts/generate-plan-index.mjs ...`), never on import.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
