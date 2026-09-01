/**
 * THE ONE predicate for "does this source reference module M by ANY import form", shared by
 * every import-sweep assertion in test/ (W1-T2531).
 *
 * OBSERVED, NOT PREDICTED. On 2026-08-31, `test/mutation-ratchet.test.ts`'s importer sweep --
 * a bare `/from ["'].*classify(\.js)?["']/` regex over source TEXT -- refused a new static
 * `from "../src/lib/classify.js"` import. A lane cleared the refusal by rewriting the import as
 * `await import("../src/lib/classify.js")` plus a `type X = import("...").X` type query: neither
 * is a static `from` import, so the old grep no longer matched it, and the sweep went blind to a
 * module it exists to track. That commit was later reverted for unrelated reasons, but the
 * EVASION WORKED -- and it works identically against every sweep of this shape, whether it is a
 * POSITIVE census (an importer silently drops out, undercounting) or a NEGATIVE boundary
 * assertion (a forbidden edge is taken and the guard reports clean, which is worse: the guard's
 * entire value is that it fails).
 *
 * The fix is not a wider regex bolted onto each call site -- that is how six sweeps drifted into
 * six different blind spots in the first place. It is ONE predicate, "does this source reference
 * module M by any of the forms below", used at every site that already sweeps for an import:
 *
 *   - `from "..."`                    -- covers both `import ... from "..."` and
 *                                        `import type ... from "..."` (and `export ... from`)
 *   - `import "..."`                  -- a bare side-effect import
 *   - `import("...")`                 -- covers BOTH `await import("...")` and a
 *                                        `type X = import("...").X` type query (same syntax)
 *   - `require("...")`
 *
 * A source that merely NAMES the module in a comment or an unrelated string is deliberately NOT
 * counted -- widening the sweep must not turn it into a substring grep. `//` and `/* *\/` comments
 * are stripped before matching, and every pattern requires the module specifier to sit directly
 * where an import/require syntactically puts it (immediately after `from`/`import`/`require`,
 * inside the matching quotes), not merely present somewhere in the line.
 *
 * This is a text-level heuristic, same as the sweeps it replaces (dependency-cruiser is the real
 * parser-backed second opinion, and only two edges in this repo carry one -- see
 * .dependency-cruiser.cjs). It is not a substitute for that; it is the minimum fix that makes the
 * TEXT sweep see what it already claims to see.
 */

export type ImportForm = "from" | "bare" | "dynamic" | "require";

export interface ImportReference {
  /** Which syntactic form matched. */
  form: ImportForm;
  /** The raw module specifier text, exactly as written between the quotes. */
  specifier: string;
}

const FORM_PATTERNS: ReadonlyArray<{ form: ImportForm; pattern: RegExp }> = [
  // `import x from "y"`, `import type x from "y"`, `export { x } from "y"` -- the specifier
  // always sits immediately after the `from` keyword.
  { form: "from", pattern: /\bfrom\s*["']([^"']+)["']/g },
  // A bare side-effect import: `import "y"`. Distinct from the dynamic form below because no
  // `(` intervenes between `import` and the quote.
  { form: "bare", pattern: /\bimport\s+["']([^"']+)["']/g },
  // `import("y")` -- covers both `await import("y")` and a `type X = import("y").X` type query;
  // the two are the same syntax and neither is a static `from` import.
  { form: "dynamic", pattern: /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g },
  // `require("y")`.
  { form: "require", pattern: /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g },
];

/** Strips `//` and `/* *\/` comments so a MENTION of a module inside one is never counted. */
function stripComments(source: string): string {
  const noBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return noBlockComments.replace(/\/\/[^\n]*/g, "");
}

/**
 * Every import/require reference in `source`, across every recognized syntactic form. A mention
 * inside a comment, or a module name embedded in an unrelated string, produces no reference.
 */
export function findImportReferences(source: string): ImportReference[] {
  const clean = stripComments(source);
  const refs: ImportReference[] = [];
  for (const { form, pattern } of FORM_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    for (const match of clean.matchAll(re)) {
      refs.push({ form, specifier: match[1] });
    }
  }
  return refs;
}

/**
 * True if `source` references a module whose specifier matches `moduleMatcher`, by ANY import
 * form -- a static `from`, a bare side-effect import, a dynamic `import(...)` (including a type
 * query), or `require(...)`. This is the predicate every sweep below should resolve through
 * instead of restating its own `from`-only regex.
 */
export function importsModule(source: string, moduleMatcher: RegExp): boolean {
  return findImportReferences(source).some((ref) => moduleMatcher.test(ref.specifier));
}
