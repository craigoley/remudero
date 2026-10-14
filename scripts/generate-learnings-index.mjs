#!/usr/bin/env node
// scripts/generate-learnings-index.mjs
//
// Build an optional local lookup from legacy shards and per-entry files (W1-T7954).
// --check validates the corpus without reading or writing a generated index.
// Usage: node scripts/generate-learnings-index.mjs [--dir learnings] [--out <path>] [--check]

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { learningsSourceFiles } from "./lib/learnings-files.mjs";
import { parseArgs } from "node:util";
import { isMainModule } from "./lib/argv.mjs";
import { parse as parseYaml } from "yaml";

const REQUIRED_FIELDS = ["id", "fact", "src"];

/**
 * Parse one shard YAML file into the records needed for the lookup index.
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
    if (entry.symbols !== undefined && (!Array.isArray(entry.symbols) || entry.symbols.some((s) => typeof s !== "string"))) {
      throw new Error(`generate-learnings-index: ${path} entry "${entry.id}": 'symbols' must be a list of strings`);
    }
    if (
      entry.error_signatures !== undefined &&
      (!Array.isArray(entry.error_signatures) || entry.error_signatures.some((s) => typeof s !== "string"))
    ) {
      throw new Error(`generate-learnings-index: ${path} entry "${entry.id}": 'error_signatures' must be a list of strings`);
    }
    return {
      id: entry.id,
      subsystem: typeof entry.subsystem === "string" ? entry.subsystem : "",
      files: entry.files,
      symbols: entry.symbols ?? [],
      error_signatures: entry.error_signatures ?? [],
    };
  });
}

/**
 * Build the index from every shard and per-entry file (sorted for determinism). Throws
 * on a duplicate id across shards -- same discipline as loadLearningsCorpus in src/lib/learnings.ts.
 */
export function buildIndex(dir) {
  const sources = learningsSourceFiles(dir);

  const files = {};
  const bySubsystem = {};
  const seen = new Set();

  for (const { filename } of sources) {
    const entries = loadShardEntries(join(dir, filename));
    const globSet = new Set();
    const symbolSet = new Set();
    const errorSignatureSet = new Set();
    const ids = [];
    for (const entry of entries) {
      if (seen.has(entry.id)) {
        throw new Error(`generate-learnings-index: duplicate learnings id '${entry.id}' (shard '${filename}')`);
      }
      seen.add(entry.id);
      ids.push(entry.id);
      for (const g of entry.files) globSet.add(g);
      for (const s of entry.symbols) symbolSet.add(s);
      for (const s of entry.error_signatures) errorSignatureSet.add(s);
      if (entry.subsystem) {
        const list = bySubsystem[entry.subsystem] ?? [];
        if (!list.includes(filename)) list.push(filename);
        bySubsystem[entry.subsystem] = list;
      }
    }
    files[filename] = {
      entries: ids.sort(),
      globs: [...globSet].sort(),
      symbols: [...symbolSet].sort(),
      error_signatures: [...errorSignatureSet].sort(),
    };
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
    // W1-T7954: the default <dir>/index.json is an optional local artifact, so --check alone proves only that the
    // corpus builds. An index NAMED with --out is one the caller asked to verify, and a stale one fails.
    if (values.out === undefined) {
      console.log(`generate-learnings-index: OK -- ${values.dir} corpus builds an index.`);
      process.exitCode = 0;
      return;
    }
    let existing;
    try {
      existing = readFileSync(outPath, "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    if (existing !== fresh) {
      console.error(`generate-learnings-index: ${outPath} is STALE or missing -- run \`npm run learnings-index\`.`);
      process.exitCode = 1;
      return;
    }
    console.log(`generate-learnings-index: OK -- ${outPath} is fresh.`);
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
if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2));
}
