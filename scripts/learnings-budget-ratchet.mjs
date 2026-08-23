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
// SUPERSEDED / QUARANTINED / CONTESTED entries do NOT count: `lifecycle` != "active" means
// src/lib/learnings.ts's `selectLearnings` never injects it (W1-T33 supersession / W1-T34
// quarantine / W1-T88 contradiction-detected contest), so it carries zero context-tax weight and
// this ratchet excludes it from the sum -- only INJECTABLE weight is capped, not the corpus's raw
// byte size (a superseded/contested entry is kept for provenance, not context; see
// learnings/platform.yaml's header for the full lifecycle contract).
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

// W1-T88/P14: "contested" is a fourth valid lifecycle (a consolidation-detected
// contradiction, excluded from injection exactly like superseded/quarantined until an
// Architect resolves it) -- accepted here so a real corpus carrying one never crashes
// this gate; computeActiveChars below already excludes anything != "active" from the sum.
const VALID_LIFECYCLES = new Set(["active", "superseded", "quarantined", "contested"]);

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
        `learnings-budget-ratchet: ${path} entry '${entry.id}': 'lifecycle' must be 'active', 'superseded', 'quarantined', or 'contested', got ${JSON.stringify(entry.lifecycle)}`,
      );
    }
    // W1-T419: `cited`/`cited_count` are OPTIONAL extra fields this gate now reads (not
    // validated -- src/lib/learnings.ts's parseLearningsDoc owns shape enforcement) so
    // evaluateRatchet's over-cap message can name compression candidates by measured evidence
    // instead of staying mute. An entry with neither field (all history before the W1-T419
    // miner ran) carries `cited: undefined, citedCount: undefined` and renders `never-cited`.
    const citedCount = typeof entry.cited_count === "number" ? entry.cited_count : undefined;
    const cited = typeof entry.cited === "string" ? entry.cited : undefined;
    return { id: entry.id, fact: entry.fact, lifecycle, cited, citedCount };
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
 *
 * `capChars` ABSENT (undefined/null) is a legitimate, honest "no cap yet" contract and is left
 * alone -- the caller reports it as "cap unset" and exits 0. `capChars` PRESENT but not a number
 * (e.g. a hand-edit that quotes the value, `"1000"` instead of `1000`) is a DIFFERENT thing: a
 * declared cap that cannot be compared against. That must REFUSE, not silently no-op -- same
 * distinction scripts/claude-md-budget-ratchet.mjs's `evaluateRatchet` draws for `capBytes`. This
 * throws rather than returning a violation because it is a config defect, not a size-budget
 * breach; the caller is expected to catch it and fail the run before it prints anything claiming
 * to enforce a cap.
 *
 * @returns {string[]} human-readable violations; empty means the ratchet is satisfied.
 * @throws {Error} if `capChars` is present and not a number.
 */
export function evaluateRatchet(actualChars, baseline) {
  const violations = [];
  if (baseline.capChars !== undefined && baseline.capChars !== null && typeof baseline.capChars !== "number") {
    throw new Error(`'capChars' must be a number, got ${JSON.stringify(baseline.capChars)}`);
  }
  if (typeof baseline.capChars === "number" && actualChars > baseline.capChars) {
    violations.push(`active learnings corpus ${actualChars} chars > cap ${baseline.capChars} chars`);
  }
  return violations;
}

// ── Naming the compression candidates (W1-T419 design iii) ─────────────────
//
// A CEILING with no candidates leaves compression to whoever's judgment is nearest -- the
// ratchet going red said "over budget" and nothing else. With mined citation evidence (`cited` /
// `cited_count`, stamped by retro.ts's `stampCitations`) available on active entries, the overage
// message can instead say WHICH entries were injected least and never mattered: fold those first.
// The ceiling and red/green semantics are UNCHANGED -- only the message stops being mute.

/** How many least-evidenced active entries {@link main} names per over-cap run. */
export const CANDIDATE_COUNT = 5;

/**
 * Order active entries LEAST-EVIDENCED FIRST: lowest `citedCount` (absent sorts as less than any
 * measured count, including zero -- no evidence is weaker than "measured and zero"), then oldest
 * `cited` (absent sorts before any dated entry, for the same reason), then `id` for determinism
 * when two entries tie on both. An entry with cited_count 9 and an entry with no evidence at all
 * are never mistaken for each other: the never-cited one always sorts first.
 */
export function leastEvidencedFirst(entries) {
  return entries
    .filter((e) => e.lifecycle === "active")
    .slice()
    .sort((a, b) => {
      const ac = typeof a.citedCount === "number" ? a.citedCount : -1;
      const bc = typeof b.citedCount === "number" ? b.citedCount : -1;
      if (ac !== bc) return ac - bc;
      const ad = a.cited ?? "";
      const bd = b.cited ?? "";
      if (ad !== bd) return ad < bd ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

/**
 * Render ONE compression-candidate line. An entry carrying neither `citedCount` nor `cited`
 * (no evidence has ever been mined for it) renders as `never-cited` -- EXPLICITLY, never omitted
 * from the list just because there is nothing to show. An entry with at least one evidence field
 * renders its measured count and last-cited date instead.
 */
export function renderCandidateLine(entry) {
  const hasEvidence = typeof entry.citedCount === "number" || typeof entry.cited === "string";
  if (!hasEvidence) return `${entry.id}: never-cited`;
  const count = typeof entry.citedCount === "number" ? entry.citedCount : 0;
  const cited = entry.cited ?? "unknown date";
  return `${entry.id}: cited ${count}x, last ${cited}`;
}

/**
 * The K least-evidenced active entries, rendered as compression-candidate lines -- what {@link
 * main} appends to an over-cap violation message. Pure over `entries`; the caller decides whether
 * the ratchet is actually over cap before calling this (an at-or-under-cap run names no
 * candidates, same as today).
 */
export function compressionCandidates(entries, count = CANDIDATE_COUNT) {
  return leastEvidencedFirst(entries)
    .slice(0, count)
    .map(renderCandidateLine);
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

  let violations;
  try {
    violations = evaluateRatchet(chars, baseline);
  } catch (err) {
    // Refuse before printing anything about a cap -- a run that cannot determine its threshold
    // must never print "cap <n> chars" as if it were enforcing one.
    console.error(`learnings-budget-ratchet: ${values.baseline}: ${err.message}`);
    process.exitCode = 1;
    return;
  }

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
    // W1-T419: name the least-evidenced entries so compression rides measured use instead of
    // whoever's judgment is nearest -- an entry with no citation evidence (`never-cited`) sorts
    // first; entries with evidence are still listed, oldest/least-cited first, never omitted.
    const candidates = compressionCandidates(entries);
    if (candidates.length > 0) {
      console.error(`  Least-evidenced active entries (fold these first):`);
      for (const c of candidates) console.error(`    - ${c}`);
    }
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
