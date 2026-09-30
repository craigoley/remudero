/**
 * THE DEPS-INTERFACE CENSUS'S COUNTERS, moved out of test/deps-interface-census.test.ts so a caller
 * that must not start a test runner can ask the census's own question: scripts/census-precheck.mjs,
 * run by hooks/pre-push. Importing a `node:test` file runs its tests, and W1-T3225 removed the runner
 * from that hook. The suite imports these; the three ceilings live in scripts/deps-interface-baseline.json.
 */
export const DEPS_INTERFACE_BASELINE = "scripts/deps-interface-baseline.json";

export const DEPS_DECLARATION = /^(?:export\s+)?(?:interface|type)\s+([A-Za-z0-9_]+Deps)\b/gm;
export const SEAM_DECLARATION = /^(?:export\s+)?(?:interface|type)\s+([A-Za-z0-9_]+(?:Deps|Seams))\b/gm;
export const INLINE_SEAM = /\bdeps\??\s*:\s*\{/g;

/** Distinct `*Deps` declaration names over already-read file contents, sorted. */
export function depsInterfaceNames(contents) {
  const names = new Set();
  for (const text of contents) for (const match of text.matchAll(DEPS_DECLARATION)) names.add(match[1]);
  return [...names].sort();
}

/** Inline `deps: {` sites, and the distinct `*Seams` alias names, over already-read file contents. */
export function inlineAndAliasedSeams(contents) {
  let inline = 0;
  const aliased = new Set();
  for (const text of contents) {
    inline += [...text.matchAll(INLINE_SEAM)].length;
    for (const match of text.matchAll(SEAM_DECLARATION)) if (match[1].endsWith("Seams")) aliased.add(match[1]);
  }
  return { inline, aliased: [...aliased].sort() };
}

/** The three counts the baseline freezes, keyed by the row the precheck reports. */
export function depsInterfaceCounts(contents) {
  const texts = [...contents];
  const seams = inlineAndAliasedSeams(texts);
  return { declarations: depsInterfaceNames(texts).length, inline: seams.inline, aliased: seams.aliased.length };
}

export const DEPS_INTERFACE_CEILING_KEYS = {
  declarations: "depsInterfaceCount",
  inline: "inlineSeamCount",
  aliased: "aliasedSeamCount",
};
