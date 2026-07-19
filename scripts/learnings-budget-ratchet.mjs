#!/usr/bin/env node
// scripts/learnings-budget-ratchet.mjs
//
// KNOWLEDGE BUDGET AS A CI RATCHET (W1-T38, MASTER-PLAN §8A).
//
// "Compression is a deliverable" stays aspirational unless CI enforces it -- the same shape as
// the coverage ratchet (scripts/coverage-ratchet.mjs), except this one is a CEILING, not a floor:
// the total INJECTABLE WEIGHT of the active learnings corpus (every `learnings/*.yaml` shard,
// lifecycle: active entries only, rendered exactly as src/lib/learnings.ts's `selectLearnings`
// would inject them -- `- <fact> [src: learnings#<id>]`) is compared against a recorded cap in
// scripts/learnings-budget-baseline.json. A PR that pushes the active corpus past the cap goes RED
// and names the overage; a healthy PR (at or under cap) exits clean. Raising the cap is a
// deliberate, reviewed change (like the coverage floor) -- never lower it to make a red PR pass.
//
// SUPERSEDED / QUARANTINED entries do NOT count: `lifecycle` != "active" means
// src/lib/learnings.ts's `selectLearnings` never injects it (W1-T33 supersession / W1-T34
// quarantine), so it carries zero context-tax weight and this ratchet excludes it from the sum --
// only INJECTABLE weight is capped, not the corpus's raw byte size (a superseded entry is kept for
// provenance, not context; see learnings/platform.yaml's header for the full lifecycle contract).
//
// This script is deliberately self-contained (no import from src/lib/learnings.ts, which is
// TypeScript and outside plain `node scripts/*.mjs` execution -- same convention as
// scripts/generate-learnings-index.mjs and scripts/learnings-assert-check.mjs): it re-parses just
// the fields it needs (id, lifecycle, fact) and re-renders the injectable line locally. That
// render format must stay byte-identical to src/lib/learnings.ts's `renderLearningLine` /
// `citation()` -- test/learnings-budget-ratchet.test.ts pins the exact string shape.
//
// Usage:
//   node scripts/learnings-budget-ratchet.mjs [--dir learnings] [--baseline <path>]
//
// Defaults: --dir learnings, --baseline scripts/learnings-budget-baseline.json
//
// The pure functions below (loadShardEntries, renderInjectableLine, computeActiveChars,
// evaluateRatchet) are exported so the falsifier fixture test can exercise the CLI process
// directly (spawn + exit code) as well as the parsing/measurement/comparison logic in isolation.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

const VALID_LIFECYCLES = new Set(["active", "superseded", "quarantined"]);

/**
 * Parse one shard YAML file into the fields this gate needs (id, lifecycle, fact) -- intentionally
 * NOT the full LearningEntry schema src/lib/learnings.ts enforces; that module is the runtime
 * source of truth for shape, this script only needs enough to measure injectable weight. A missing
 * `lifecycle` defaults to "active" (same default as src/lib/learnings.ts).
 */
export function loadShardEntries(path) {
  const text = readFileSync(path, "utf8");
  const doc = parseYaml(text);
  if (doc === null || doc === undefined) return [];
  if (!Array.isArray(doc)) {
    throw new Error(`learnings-budget-ratchet: ${path} must be a YAML list of entries`);
  }
  return doc.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`learnings-budget-ratchet: ${path} entry ${i} must be a mapping`);
    }
    if (typeof entry.id !== "string" || entry.id.length === 0) {
      throw new Error(`learnings-budget-ratchet: ${path} entry ${i} missing string 'id'`);
    }
    if (typeof entry.fact !== "string" || entry.fact.length === 0) {
      throw new Error(`learnings-budget-ratchet: ${path} entry '${entry.id}' (${path}): missing string 'fact'`);
    }
    const lifecycle = entry.lifecycle ?? "active";
    if (!VALID_LIFECYCLES.has(lifecycle)) {
      throw new Error(
        `learnings-budget-ratchet: ${path} entry '${entry.id}': 'lifecycle' must be 'active', 'superseded', or 'quarantined', got ${JSON.stringify(entry.lifecycle)}`,
      );
    }
    return { id: entry.id, fact: entry.fact, lifecycle };
  });
}

/**
 * Load every `*.yaml` shard directly inside `dir` (sorted for determinism), same discovery rule as
 * scripts/generate-learnings-index.mjs. A missing directory is not an error -- returns `[]` (no
 * corpus yet, same convention as src/lib/learnings.ts).
 */
export function loadCorpus(dir) {
  let filenames;
  try {
    filenames = readdirSync(dir)
      .filter((f) => f.endsWith(".yaml"))
      .sort();
  } catch {
    return [];
  }
  const entries = [];
  for (const filename of filenames) {
    entries.push(...loadShardEntries(join(dir, filename)));
  }
  return entries;
}

/**
 * Render an entry exactly as src/lib/learnings.ts's `renderLearningLine` would inject it --
 * `- <fact> [src: learnings#<id>]` -- the INJECTABLE weight this gate measures, not raw YAML bytes.
 */
export function renderInjectableLine(entry) {
  return `- ${entry.fact} [src: learnings#${entry.id}]`;
}

/**
 * Sum the injectable-line weight (+1 per entry for the joining "\n", same cost formula
 * src/lib/learnings.ts's `selectLearnings` uses) across ACTIVE entries only. `superseded` and
 * `quarantined` entries are excluded entirely -- they carry zero injectable weight because
 * `selectLearnings` filters them out before ranking, so they can never reach a rendered prompt.
 */
export function computeActiveChars(entries) {
  let chars = 0;
  let activeCount = 0;
  for (const entry of entries) {
    if (entry.lifecycle !== "active") continue;
    activeCount += 1;
    chars += renderInjectableLine(entry).length + 1;
  }
  return { chars, activeCount, totalCount: entries.length };
}

/**
 * Compare the measured active-corpus size against a recorded cap.
 * @returns {string[]} human-readable violations; empty means the ratchet is satisfied.
 */
export function evaluateRatchet(actualChars, baseline) {
  const violations = [];
  if (typeof baseline.capChars === "number" && actualChars > baseline.capChars) {
    violations.push(`active learnings corpus ${actualChars} chars > cap ${baseline.capChars} chars`);
  }
  return violations;
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: "string", default: "learnings" },
      baseline: { type: "string", default: "scripts/learnings-budget-baseline.json" },
    },
  });

  let entries;
  try {
    entries = loadCorpus(values.dir);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }
  const baseline = JSON.parse(readFileSync(values.baseline, "utf8"));
  const { chars, activeCount, totalCount } = computeActiveChars(entries);
  const violations = evaluateRatchet(chars, baseline);

  console.log(
    `learnings-budget-ratchet: active corpus ${chars} chars (cap ${baseline.capChars ?? "unset"} chars) -- ` +
      `${activeCount} active / ${totalCount} total entries across ${values.dir}/*.yaml`,
  );

  if (violations.length > 0) {
    console.error("learnings-budget-ratchet: BLOCKED -- active learnings corpus is over the recorded knowledge budget:");
    for (const v of violations) console.error(`  - ${v}`);
    console.error(
      "  Compress or supersede entries to bring the active corpus back under the cap, or -- if the growth is " +
        "deliberate and reviewed -- raise scripts/learnings-budget-baseline.json's capChars.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("learnings-budget-ratchet: OK -- active corpus is at or under the knowledge budget cap.");
  process.exitCode = 0;
}

// Only run when executed directly (`node scripts/learnings-budget-ratchet.mjs ...`), never on import.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
