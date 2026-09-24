/**
 * src/lib/knowledge-symbols.ts — W1-T4093.
 *
 * Learnings were retrieved by `files:` glob ALONE: no shipped entry declared `symbols:` or
 * `error_signatures:`, even though {@link selectLearnings} in src/lib/learnings.ts already ranks
 * on them first. A file glob is a blunt instrument — 28 entries glob the 44,636-line
 * src/run-task.ts, so touching that one file matches roughly a third of the corpus regardless of
 * which function the task actually changed.
 *
 * This module derives, for a fact's own text, the CODE IDENTIFIERS it names that really exist in
 * the source tree — the same discipline `assertion:` already gets (learnings-assert-check.mjs
 * quarantines an entry whose `assertion` command no longer passes). A symbol that is renamed or
 * deleted stops being derivable the next time this runs: it silently drops out rather than going
 * on matching a file that no longer names it.
 *
 * Two halves:
 *  - {@link extractIdentifierCandidates} — pulls code-shaped tokens (camelCase, PascalCase,
 *    snake_case, SCREAMING_SNAKE_CASE) out of prose; plain English words never qualify because
 *    they carry none of those shapes.
 *  - {@link collectSourceSymbols} — walks a source tree and records every top-level identifier a
 *    declaration actually binds (function/class/interface/type/const/let/enum), the "tree" a
 *    candidate is checked against.
 *  - {@link deriveFactSymbols} composes the two: candidates from the fact, filtered to ones the
 *    tree still recognizes.
 */
import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";

/** Directories a source-symbol walk never descends into (build output, deps, VCS metadata). */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "coverage"]);

/** Source file extensions {@link collectSourceSymbols} reads declarations from. */
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

/**
 * Code-shaped tokens in `text`: camelCase, PascalCase, snake_case, or SCREAMING_SNAKE_CASE
 * identifiers of at least 3 characters. A plain prose word — all-lowercase with no separator, or
 * all-uppercase with no underscore — never matches, so emphasis like "FINITE" or "FILL BY
 * STRENGTH" is never mistaken for a symbol. Order-preserving, de-duplicated.
 */
export function extractIdentifierCandidates(text: string): string[] {
  const tokens = text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokens) {
    if (token.length < 3) continue;
    const isCamelOrPascal = /[a-z][A-Z]/.test(token) || (/^[A-Z]/.test(token) && /[a-z]/.test(token));
    const isSnakeIsh = token.includes("_") && /[A-Za-z]/.test(token);
    if (!isCamelOrPascal && !isSnakeIsh) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/** One declaration-shaped regex per binding form `collectSourceSymbols` recognizes; each must
 *  capture the bound identifier in group 1. */
const DECLARATION_PATTERNS: RegExp[] = [
  /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*[(<]/g,
  /\bclass\s+([A-Za-z_$][\w$]*)/g,
  /\binterface\s+([A-Za-z_$][\w$]*)/g,
  /\btype\s+([A-Za-z_$][\w$]*)\s*[=<]/g,
  /\benum\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*[:=]/g,
];

/** Every identifier one file's declarations bind, via {@link DECLARATION_PATTERNS}. */
function fileSymbols(text: string): string[] {
  const out: string[] = [];
  for (const pattern of DECLARATION_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text))) out.push(m[1]!);
  }
  return out;
}

/**
 * Recursively list source files under `root` this module reads declarations from. A MISSING
 * `root` (ENOENT) yields `[]` — the same non-fatal-absence discipline {@link loadLearningsCorpus}
 * uses for a missing learnings directory. Any other failure rethrows: an unreadable root is not an
 * empty one.
 */
function listSourceFiles(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root, { recursive: true }) as string[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return [];
  }
  return entries
    .filter((rel) => SOURCE_EXTENSIONS.has(extname(rel)))
    .filter((rel) => !rel.split(/[\\/]/).some((part) => SKIP_DIRS.has(part)))
    .map((rel) => join(root, rel));
}

/**
 * The known-symbol "tree" a derived candidate is checked against (design note (i): "checked
 * against the tree, like `assertion:` is"): every identifier declared anywhere under `root`
 * (default `src/`). A file that is GONE by read time (ENOENT, e.g. a dangling symlink) declares
 * nothing and is skipped; any other read failure rethrows, because a silently partial tree makes
 * scripts/learnings-derive-symbols.mjs strip symbols that still exist.
 */
export function collectSourceSymbols(root: string): Set<string> {
  const symbols = new Set<string>();
  for (const path of listSourceFiles(root)) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      continue;
    }
    for (const symbol of fileSymbols(text)) symbols.add(symbol);
  }
  return symbols;
}

/**
 * Derive the symbols one fact names: {@link extractIdentifierCandidates} over `fact`, kept only
 * when `knownSymbols` still recognizes them. Sorted for a deterministic, diff-friendly `symbols:`
 * list. A renamed/deleted identifier is silently absent from the result — the falsifier for "a
 * symbol that no longer exists is dropped".
 */
export function deriveFactSymbols(fact: string, knownSymbols: ReadonlySet<string> | Iterable<string>): string[] {
  const known = knownSymbols instanceof Set ? knownSymbols : new Set(knownSymbols);
  return extractIdentifierCandidates(fact)
    .filter((candidate) => known.has(candidate))
    .sort();
}
