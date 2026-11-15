/**
 * THE AFFECTED-REACH CENSUS'S COUNTER, moved out of test/the-affected-suite-reach-ratchet.test.ts (W1-T12526) so a
 * caller that must not start a test runner can count with it: src/lib/merged-ratchet-verdict.ts counts the merged
 * tree at merge time. Importing a `node:test` file runs its tests. The suite imports {@link measureReach} from here
 * and keeps its assertions.
 */
import assert from "node:assert/strict";

import * as selector from "../src/lib/affected-suites.ts";

const SUITE = /^test\/.*\.test\.ts$/;
/** The code files the census reads: the tracked src, scripts, bin and test trees. */
export const REACH_CODE_RE = /^(?:src|scripts|bin|test)\/.+\.(?:ts|mts|mjs|js|cjs)$/;
/** The baseline the census records its three counts in. */
export const REACH_BASELINE = "scripts/affected-reach-baseline.json";
/** The three counts the baseline records, each a ceiling. */
export const REACH_FIELDS = ["importerCount", "largestScc", "medianReachPercent"];
// Built from two parts: the graph reads a whole quoted source path in a script as an edge.
const RUN_TASK = "src/run-task" + ".ts";

/**
 * @typedef {{ dependencies: Map<string, Set<string>>, importers: Map<string, Set<string>>, directImports: Map<string, Set<string>> }} Graph
 * @typedef {{ importerCount: number, largestScc: number, medianReachPercent: number }} Reach
 * @typedef {Reach & { importers: string[], resolution?: string }} Baseline
 */

/** @param {ReadonlyMap<string, string>} files @param {import("../src/lib/affected-suites.ts").AliasSource} aliases @returns {Graph} */
function graph(files, aliases) {
  assert.ok("buildAffectedSuitesGraph" in selector, "the selector must export its graph builder");
  // The alias map is the tree's own package.json, the same tree the census reads.
  return selector.buildAffectedSuitesGraph(files, [], aliases);
}

function reachable(start, edges) {
  const seen = new Set();
  const queue = [start];
  for (let i = 0; i < queue.length; i += 1) {
    const file = queue[i];
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...(edges.get(file) ?? []));
  }
  return seen;
}

/** @param {ReadonlyMap<string, string>} files @param {import("../src/lib/affected-suites.ts").AliasSource} aliases @returns {Baseline} */
export function measureReach(files, aliases) {
  const { dependencies, importers: reverse, directImports } = graph(files, aliases);
  const suites = [...dependencies.keys()].filter((f) => SUITE.test(f));
  const modules = [...dependencies.keys()].filter((f) => f.startsWith("src/"));
  assert.ok(suites.length > 0 && modules.length > 0, "the census needs source modules and suites");
  const importers = suites.filter((f) => directImports.get(f)?.has(RUN_TASK)).sort();
  const reach = modules.map((f) => [...reachable(f, reverse)].filter((p) => SUITE.test(p)).length)
    .sort((a, b) => a - b);
  const middle = Math.floor(reach.length / 2);
  const median = reach.length % 2 === 0 ? (reach[middle - 1] + reach[middle]) / 2 : reach[middle];

  const seen = new Set();
  const order = [];
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const dep of dependencies.get(file) ?? []) visit(dep);
    order.push(file);
  };
  for (const file of dependencies.keys()) visit(file);
  seen.clear();
  let largestScc = 0;
  for (const file of order.reverse()) {
    if (seen.has(file)) continue;
    const component = new Set();
    const queue = [file];
    for (let i = 0; i < queue.length; i += 1) {
      const node = queue[i];
      if (seen.has(node)) continue;
      seen.add(node);
      component.add(node);
      queue.push(...(reverse.get(node) ?? []));
    }
    largestScc = Math.max(largestScc, component.size);
  }
  return { importerCount: importers.length, largestScc, medianReachPercent: median * 100 / suites.length, importers };
}

/** A line that can carry a graph edge: an import, export-from or require, or a quoted repo path. */
const EDGE_LINE_RE = /\bimport\b|\brequire\s*\(|\bfrom\s*["'`]|["'`](?:src|scripts|bin|test|openapi|packages)["'`/]/;

/** The module specifiers buildAffectedSuitesGraph reads, including a specifier on a later line of a
 *  multiline import. Keep these patterns in step with `specifiers` in src/lib/affected-suites.ts. */
const MODULE_SPECIFIER_PATTERNS = [
  /\b(?:import|export)\s[^'"`;]*?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s+["']([^"']+)["']/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function edgeLines(text) {
  const lines = text.split("\n").filter((line) => EDGE_LINE_RE.test(line)).map((line) => line.trim());
  const specifiers = [];
  for (const pattern of MODULE_SPECIFIER_PATTERNS) {
    for (const match of text.matchAll(pattern)) specifiers.push(`specifier:${match[1]}`);
  }
  return [...lines, ...specifiers].sort().join("\n");
}

function packageImports(text) {
  if (text === null) return "null";
  try {
    return JSON.stringify(JSON.parse(text).imports ?? null);
  } catch (e) {
    return JSON.stringify({ unreadable: String(e) });
  }
}

/** Whether one path's change can move the census's counts: a code file added or removed, a code file whose
 *  edge lines differ, or a package.json whose `imports` map differs. Any other change leaves the graph as it was. */
export function changesReach(path, before, after) {
  if (path === "package.json") return packageImports(before) !== packageImports(after);
  if (!REACH_CODE_RE.test(path)) return false;
  if (before === null || after === null) return before !== after;
  return edgeLines(before) !== edgeLines(after);
}
