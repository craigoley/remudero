#!/usr/bin/env node
// scripts/learnings-derive-symbols.mjs — Learnings SYMBOL DERIVATION (W1-T4093).
//
// A glob alone cannot tell a task that touches ONE function of a 44,000-line file apart from one
// that touches another -- every entry globbing that file matches equally, which is why 0 of the
// shipped corpus's entries carried a `selectLearnings`-ranked `symbols:` from a derivation. This
// closes that gap the way `scripts/learnings-assert-check.mjs` keeps an `assertion:` honest: it
// derives, from each entry's OWN fact text via src/lib/knowledge-symbols.ts's `deriveFactSymbols`,
// the code identifiers that fact actually names, checked against a fresh scan of the source tree
// (`collectSourceSymbols`), and merges them into that entry's `symbols:` list.
//
// The merge is ADDITIVE, never destructive of a human's own annotation: a declared symbol survives
// UNLESS it is itself shaped like a derivable one (`looksDerivable`) that the tree no longer
// recognizes (a renamed function) -- the same quarantine reasoning `assertion:` gets. A hand-added
// acronym or error phrase is never derivation-shaped, so never a removal candidate either.
//
// Usage: node --import tsx scripts/learnings-derive-symbols.mjs [--dir learnings] [--src src] [--check]
// --check exits 1 and prints which shard(s) are stale, writing nothing -- the CI-safe arm.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { isMainModule, parseArgv } from "./lib/argv.mjs";
import { collectSourceSymbols, deriveFactSymbols, extractIdentifierCandidates } from "../src/lib/knowledge-symbols.ts";

/** Parse one shard YAML file into the {id, fact, symbols} triples derivation needs -- deliberately
 *  not the full LearningEntry schema src/lib/learnings.ts enforces (same rationale as
 *  generate-learnings-index.mjs's own `loadShardEntries`: this script only needs enough to plan a
 *  `symbols:` update, never the runtime source of truth for shape). */
export function loadShardEntries(path) {
  const text = readFileSync(path, "utf8");
  const doc = parseYaml(text);
  if (doc === null || doc === undefined) return [];
  if (!Array.isArray(doc)) {
    throw new Error(`learnings-derive-symbols: ${path} must be a YAML list of entries`);
  }
  return doc.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`learnings-derive-symbols: ${path} entry ${i} must be a mapping`);
    }
    if (typeof entry.id !== "string" || entry.id.length === 0) {
      throw new Error(`learnings-derive-symbols: ${path} entry ${i} missing required non-empty 'id'`);
    }
    if (typeof entry.fact !== "string" || entry.fact.length === 0) {
      throw new Error(`learnings-derive-symbols: ${path} entry "${entry.id}" missing required non-empty 'fact'`);
    }
    if (entry.symbols !== undefined && (!Array.isArray(entry.symbols) || entry.symbols.some((s) => typeof s !== "string"))) {
      throw new Error(`learnings-derive-symbols: ${path} entry "${entry.id}": 'symbols' must be a list of strings`);
    }
    return { id: entry.id, fact: entry.fact, symbols: entry.symbols ?? [] };
  });
}

/** A declared symbol shaped like something `deriveFactSymbols` could itself have produced --
 *  camelCase, PascalCase, or snake_case (see knowledge-symbols.ts's `extractIdentifierCandidates`).
 *  An acronym or error phrase never has this shape, so it never qualifies for the staleness check
 *  below -- it was a human annotation this script had no part in, and stays one. */
function looksDerivable(symbol) {
  return extractIdentifierCandidates(symbol).includes(symbol);
}

/**
 * Plan one entry's next `symbols:` list: kept declared symbols (dropping a derivable-shaped one
 * the tree no longer recognizes -- "a symbol that no longer exists is dropped") unioned with
 * whatever `deriveFactSymbols` newly finds in its `fact` text, sorted for a stable diff. Returns
 * `undefined` when nothing would change.
 */
export function planEntrySymbols(entry, knownSymbols) {
  const kept = entry.symbols.filter((s) => !looksDerivable(s) || knownSymbols.has(s));
  const derived = deriveFactSymbols(entry.fact, knownSymbols);
  const next = [...new Set([...kept, ...derived])].sort();
  const before = [...entry.symbols].sort();
  if (next.length === before.length && next.every((s, i) => s === before[i])) return undefined;
  return next;
}

/** Find the `[start, end)` character range of one entry's block (`- id: <id>` line through the
 *  char before the next top-level `- id:` line, or EOF) -- identical convention to
 *  learnings-assert-check.mjs's `findEntryBlock`, kept independent so neither script has to import
 *  the other's internals for one helper. */
function findEntryBlock(text, id) {
  const startRe = new RegExp(`^- id: ${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
  const startMatch = startRe.exec(text);
  if (!startMatch) return null;
  const start = startMatch.index;
  const rest = text.slice(start + startMatch[0].length);
  const nextMatch = /^- id: /m.exec(rest);
  const end = nextMatch ? start + startMatch[0].length + nextMatch.index : text.length;
  return { start, end };
}

/** Render a `symbols:` value the way the shipped corpus already writes short lists: a flow-style
 *  `[a, b, c]`, double-quoted only when a symbol itself needs it. */
function renderSymbolsLine(symbols) {
  const items = symbols.map((s) => (/^[\w$.-]+$/.test(s) ? s : JSON.stringify(s)));
  return `  symbols: [${items.join(", ")}]`;
}

/** Rewrite one entry's block to carry `next` as its `symbols:` list -- replacing an existing line,
 *  removing it when `next` is empty, or inserting one (right after `files:` when present, else
 *  right after the `- id:` line) when the entry never declared one. Pure text surgery: every other
 *  byte in the shard is untouched, mirroring `quarantineEntryInText`'s discipline. */
export function writeSymbolsInText(text, id, next) {
  const range = findEntryBlock(text, id);
  if (!range) throw new Error(`learnings-derive-symbols: entry '${id}' not found while updating symbols`);
  let block = text.slice(range.start, range.end);
  const hasLine = /^  symbols:.*$/m.test(block);
  if (next.length === 0) {
    if (hasLine) block = block.replace(/^  symbols:.*\n/m, "");
  } else if (hasLine) {
    block = block.replace(/^  symbols:.*$/m, renderSymbolsLine(next));
  } else if (/^  files:.*$/m.test(block)) {
    block = block.replace(/^  files:.*$/m, (m) => `${m}\n${renderSymbolsLine(next)}`);
  } else {
    block = block.replace(/^- id: .*$/m, (m) => `${m}\n${renderSymbolsLine(next)}`);
  }
  return text.slice(0, range.start) + block + text.slice(range.end);
}

/** Plan every shard's mutations under `dir`, against `knownSymbols`. Returns
 *  `{ mutations: [{filename, id, next}], staleFilenames: string[] }`. */
export function planMutations(dir, knownSymbols) {
  const filenames = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort();
  const mutations = [];
  const staleFilenames = new Set();
  for (const filename of filenames) {
    for (const entry of loadShardEntries(join(dir, filename))) {
      const next = planEntrySymbols(entry, knownSymbols);
      if (next === undefined) continue;
      mutations.push({ filename, id: entry.id, next });
      staleFilenames.add(filename);
    }
  }
  return { mutations, staleFilenames: [...staleFilenames].sort() };
}

/** Apply planned mutations to their shard files on disk (MUTATE mode). */
export function applyMutations(dir, mutations) {
  const byFile = new Map();
  for (const m of mutations) {
    if (!byFile.has(m.filename)) byFile.set(m.filename, readFileSync(join(dir, m.filename), "utf8"));
    byFile.set(m.filename, writeSymbolsInText(byFile.get(m.filename), m.id, m.next));
  }
  for (const [filename, text] of byFile) {
    writeFileSync(join(dir, filename), text);
  }
  return mutations;
}

function main(argv) {
  const { values } = parseArgv(
    argv,
    {
      dir: { type: "string", default: "learnings" },
      src: { type: "string", default: "src" },
      check: { type: "boolean", default: false },
    },
    { helpText: "Usage: learnings-derive-symbols [--dir learnings] [--src src] [--check]" },
  );

  const knownSymbols = collectSourceSymbols(values.src);
  const { mutations, staleFilenames } = planMutations(values.dir, knownSymbols);

  if (values.check) {
    if (staleFilenames.length > 0) {
      console.error(
        `learnings-derive-symbols: STALE -- ${staleFilenames.join(", ")} would gain/lose derived ` +
          `symbols against the current ${values.src}/ tree. Run 'node --import tsx ` +
          `scripts/learnings-derive-symbols.mjs' and commit the result.`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`learnings-derive-symbols: OK -- every entry's symbols: matches a fresh derivation.`);
    process.exitCode = 0;
    return;
  }

  applyMutations(values.dir, mutations);
  console.log(`learnings-derive-symbols: updated ${mutations.length} entry(ies) across ${staleFilenames.length} shard(s).`);
  process.exitCode = 0;
}

// Only run when executed directly (`node --import tsx scripts/learnings-derive-symbols.mjs ...`),
// never on import.
if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2));
}
