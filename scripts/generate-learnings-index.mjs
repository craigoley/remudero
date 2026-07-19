#!/usr/bin/env node
// scripts/generate-learnings-index.mjs
//
// Learnings INDEX generator (W1-T33, MASTER-PLAN §8A Tier 1).
//
// The learnings corpus is split into subsystem shards (learnings/{platform,architecture,ci,
// testing,failures}.yaml, or any other *.yaml file dropped into learnings/) so a growing corpus
// never becomes a full SCAN. This script builds the LOOKUP index every shard is checked against:
// for each shard filename, the entry ids it carries and the union of `files:` globs those entries
// use, plus a `subsystem -> shard filename(s)` map. src/lib/learnings.ts's
// `loadLearningsForTaskFiles` reads the committed learnings/index.json to decide which shard(s) a
// task could possibly match WITHOUT parsing every shard.
//
// The generated index is content-only (no timestamp) so it is byte-stable across runs when the
// corpus hasn't changed -- that is what makes `--check` a meaningful staleness gate rather than a
// permanent false positive.
//
// Usage:
//   node scripts/generate-learnings-index.mjs [--dir learnings] [--out learnings/index.json]
//   node scripts/generate-learnings-index.mjs --check   # exit 1 if the committed index is stale

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

const REQUIRED_FIELDS = ["id", "fact", "src"];

/**
 * Parse one shard YAML file into a validated list of {id, subsystem, files, lifecycle} records
 * (only the fields the index needs -- this is intentionally NOT the full LearningEntry schema
 * enforced by src/lib/learnings.ts; that module is the runtime source of truth for shape, this
 * script only needs enough to build a lookup table).
 */
export function loadShardEntries(path) {
  const text = readFileSync(path, "utf8");
  const doc = parseYaml(text);
  if (doc === null || doc === undefined) return [];
  if (!Array.isArray(doc)) {
    throw new Error(`generate-learnings-index: ${path} must be a YAML list of entries`);
  }
  return doc.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`generate-learnings-index: ${path} entry ${i} must be a mapping`);
    }
    for (const field of REQUIRED_FIELDS) {
      if (typeof entry[field] !== "string" || entry[field].trim() === "") {
        throw new Error(`generate-learnings-index: ${path} entry ${i} missing required string field "${field}"`);
      }
    }
    if (!Array.isArray(entry.files) || entry.files.some((f) => typeof f !== "string")) {
      throw new Error(`generate-learnings-index: ${path} entry "${entry.id}": 'files' must be a list of globs`);
    }
    return {
      id: entry.id,
      subsystem: typeof entry.subsystem === "string" ? entry.subsystem : "",
      files: entry.files,
    };
  });
}

/**
 * Build the index from every `*.yaml` file directly inside `dir` (sorted for determinism). Throws
 * on a duplicate id across shards -- same discipline as loadLearningsCorpus in src/lib/learnings.ts.
 */
export function buildIndex(dir) {
  const filenames = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort();

  const files = {};
  const bySubsystem = {};
  const seen = new Set();

  for (const filename of filenames) {
    const entries = loadShardEntries(join(dir, filename));
    const globSet = new Set();
    const ids = [];
    for (const entry of entries) {
      if (seen.has(entry.id)) {
        throw new Error(`generate-learnings-index: duplicate learnings id '${entry.id}' (shard '${filename}')`);
      }
      seen.add(entry.id);
      ids.push(entry.id);
      for (const g of entry.files) globSet.add(g);
      if (entry.subsystem) {
        const list = bySubsystem[entry.subsystem] ?? [];
        if (!list.includes(filename)) list.push(filename);
        bySubsystem[entry.subsystem] = list;
      }
    }
    files[filename] = { entries: ids.sort(), globs: [...globSet].sort() };
  }

  for (const key of Object.keys(bySubsystem)) bySubsystem[key].sort();

  return { files, bySubsystem };
}

/** Canonical, stable-key JSON serialization -- what makes byte-equality checkable. */
export function serializeIndex(index) {
  const sortedFiles = {};
  for (const key of Object.keys(index.files).sort()) sortedFiles[key] = index.files[key];
  const sortedBySubsystem = {};
  for (const key of Object.keys(index.bySubsystem).sort()) sortedBySubsystem[key] = index.bySubsystem[key];
  return JSON.stringify({ files: sortedFiles, bySubsystem: sortedBySubsystem }, null, 2) + "\n";
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: "string", default: "learnings" },
      out: { type: "string" },
      check: { type: "boolean", default: false },
    },
  });
  const outPath = values.out ?? join(values.dir, "index.json");

  let fresh;
  try {
    fresh = serializeIndex(buildIndex(values.dir));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  if (values.check) {
    let committed;
    try {
      committed = readFileSync(outPath, "utf8");
    } catch {
      console.error(`generate-learnings-index: ${outPath} does not exist -- run 'npm run learnings-index' to generate it.`);
      process.exitCode = 1;
      return;
    }
    if (committed !== fresh) {
      console.error(
        `generate-learnings-index: ${outPath} is STALE -- it does not match a fresh regeneration from ${values.dir}/*.yaml.\n` +
          `Run 'npm run learnings-index' and commit the result.`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`generate-learnings-index: OK -- ${outPath} matches the current corpus.`);
    process.exitCode = 0;
    return;
  }

  writeFileSync(outPath, fresh);
  const shardCount = Object.keys(JSON.parse(fresh).files).length;
  const entryCount = Object.values(JSON.parse(fresh).files).reduce((n, f) => n + f.entries.length, 0);
  console.log(`generate-learnings-index: wrote ${outPath} (${shardCount} shard(s), ${entryCount} entry id(s)).`);
  process.exitCode = 0;
}

// Only run when executed directly (`node scripts/generate-learnings-index.mjs ...`), never on import.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
