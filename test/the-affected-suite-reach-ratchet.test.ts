// @source-text-subject: this census measures the selector's graph over the tracked code tree.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import * as selector from "../src/lib/affected-suites.js";
// @ts-ignore executable census module has no declaration file.
import { censusSnapshotPaths, readCensusSnapshot } from "../scripts/census-precheck.mjs";

const SNAPSHOT = readCensusSnapshot();
const ROOT = SNAPSHOT?.root ?? fileURLToPath(new URL("../", import.meta.url));
const BASELINE = `${ROOT}/scripts/affected-reach-baseline.json`;
const SUITE = /^test\/.*\.test\.ts$/;
const CODE = /\.(?:ts|mts|mjs|js|cjs)$/;

interface Graph {
  dependencies: Map<string, Set<string>>;
  importers: Map<string, Set<string>>;
  directImports: Map<string, Set<string>>;
}

interface Reach {
  importerCount: number;
  largestScc: number;
  medianReachPercent: number;
}

interface Baseline extends Reach {
  importers: string[];
}

function graph(files: ReadonlyMap<string, string>): Graph {
  assert.ok("buildAffectedSuitesGraph" in selector, "the selector must export its graph builder");
  return (selector.buildAffectedSuitesGraph as (files: ReadonlyMap<string, string>) => Graph)(files);
}

function reachable(start: string, edges: ReadonlyMap<string, ReadonlySet<string>>): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  for (let i = 0; i < queue.length; i += 1) {
    const file = queue[i]!;
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...(edges.get(file) ?? []));
  }
  return seen;
}

export function measureReach(files: ReadonlyMap<string, string>): Baseline {
  const { dependencies, importers: reverse, directImports } = graph(files);
  const suites = [...dependencies.keys()].filter((f) => SUITE.test(f));
  const modules = [...dependencies.keys()].filter((f) => f.startsWith("src/"));
  assert.ok(suites.length > 0 && modules.length > 0, "the census needs source modules and suites");
  const importers = suites.filter((f) => directImports.get(f)?.has("src/run-task.ts")).sort();
  const reach = modules.map((f) => [...reachable(f, reverse)].filter((p) => SUITE.test(p)).length)
    .sort((a, b) => a - b);
  const middle = Math.floor(reach.length / 2);
  const median = reach.length % 2 === 0 ? (reach[middle - 1]! + reach[middle]!) / 2 : reach[middle]!;

  const seen = new Set<string>();
  const order: string[] = [];
  const visit = (file: string) => {
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
    const component = new Set<string>();
    const queue = [file];
    for (let i = 0; i < queue.length; i += 1) {
      const node = queue[i]!;
      if (seen.has(node)) continue;
      seen.add(node);
      component.add(node);
      queue.push(...(reverse.get(node) ?? []));
    }
    largestScc = Math.max(largestScc, component.size);
  }
  return { importerCount: importers.length, largestScc, medianReachPercent: median * 100 / suites.length, importers };
}

export function reachVerdict(actual: Baseline, baseline: Baseline): { refused: string[]; tighter: string[] } {
  const refused: string[] = [];
  const tighter: string[] = [];
  const newcomers = actual.importers.filter((f) => !baseline.importers.includes(f));
  for (const metric of ["importerCount", "largestScc", "medianReachPercent"] as const) {
    assert.ok(Number.isFinite(baseline[metric]) && baseline[metric] >= 0, `invalid baseline ${metric}`);
    if (actual[metric] > baseline[metric]) {
      refused.push(`${metric}: ${actual[metric]} > ${baseline[metric]}; new importers: ${newcomers.join(", ") || "none"}`);
    } else if (actual[metric] < baseline[metric]) {
      tighter.push(`${metric}: ${actual[metric]}`);
    }
  }
  return { refused, tighter };
}

export function readCodeTree(): Map<string, string> {
  const paths: string[] = (SNAPSHOT ? censusSnapshotPaths(SNAPSHOT) :
    execFileSync("git", ["ls-files", "--", "src", "scripts", "bin", "test"], { cwd: ROOT, encoding: "utf8" })
      .trim().split("\n")).filter((p: string) => /^(?:src|scripts|bin|test)\//.test(p) && CODE.test(p));
  // Include this new suite before the harness stages it; git lists it after the commit too.
  const own = "test/the-affected-suite-reach-ratchet.test.ts";
  return new Map([...new Set([...paths, own])].map((p) => [p, readFileSync(`${ROOT}/${p}`, "utf8")]));
}

const FIXTURE = new Map([
  ["src/run-task.ts", 'export { a } from "./a.js";'],
  ["src/a.ts", "export const a = 1;"],
  ["src/isolated.ts", "export {};"],
  ["test/old.test.ts", 'import "../src/run-task.js";'],
  ["test/isolated.test.ts", 'import "../src/isolated.js";'],
]);

test("unit test: test/the-affected-suite-reach-ratchet.test.ts", () => {
  const baseline = measureReach(FIXTURE);
  assert.deepEqual(baseline, { importerCount: 1, largestScc: 1, medianReachPercent: 50, importers: ["test/old.test.ts"] });
  const grown = new Map(FIXTURE).set("test/new.test.ts", 'import "../src/run-task.js";');
  const verdict = reachVerdict(measureReach(grown), baseline);
  assert.ok(verdict.refused.some((r) => r.startsWith("importerCount:") && r.includes("test/new.test.ts")), verdict.refused.join("\n"));
  const recorded = JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline;
  const recordedFixture = new Map(recorded.importers.map((f) => [f,
    `import "${"../".repeat(f.split("/").length - 1)}src/run-task.js";`]));
  recordedFixture.set("src/run-task.ts", "export {};");
  recordedFixture.set("test/new.test.ts", 'import "../src/run-task.js";');
  const recordedRefusal = reachVerdict(measureReach(recordedFixture), recorded);
  assert.ok(recordedRefusal.refused.some((r) => r.startsWith("importerCount:") && r.includes("test/new.test.ts")),
    "the recorded ceiling must refuse the next importer and name it");
  const tree = readCodeTree();
  assert.ok(tree.has("src/lib/affected-suites.ts") && tree.has("test/the-affected-suite-reach-ratchet.test.ts"),
    "control: the selector and its census suite must be read");
  const actual = measureReach(tree);
  const live = reachVerdict(actual, recorded);
  assert.deepEqual(live.refused, [], live.refused.join("\n"));
  if (live.tighter.length > 0) console.log(`affected reach tighter — record in scripts/affected-reach-baseline.json: ${live.tighter.join("; ")}`);
});

test("the recorded reach baseline may only shrink against origin/main", () => {
  const path = "scripts/affected-reach-baseline.json";
  const exists = SNAPSHOT ? (SNAPSHOT.mainBlobs[path] === undefined ? "" : path) :
    execFileSync("git", ["ls-tree", "--name-only", "origin/main", "--", path], { cwd: ROOT, encoding: "utf8" }).trim();
  if (exists === "") return; // Initial capture has no previous ceiling.
  const previous = JSON.parse(SNAPSHOT ? SNAPSHOT.mainBlobs[path] :
    execFileSync("git", ["show", `origin/main:${path}`], { cwd: ROOT, encoding: "utf8" })) as Baseline;
  const recorded = JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline;
  assert.deepEqual(reachVerdict(recorded, previous).refused, [], "a recorded reach ceiling may only shrink");
});

test("reach ratchet refuses SCC and median growth and prints shrink-only measurements", () => {
  const baseline = measureReach(FIXTURE);
  const cycle = new Map(FIXTURE).set("src/a.ts", 'import "./run-task.js";');
  assert.ok(reachVerdict(measureReach(cycle), baseline).refused.some((r) => r.startsWith("largestScc: 2 > 1")));
  const wider = new Map(FIXTURE).set("test/isolated.test.ts", 'import "../src/run-task.js"; import "../src/isolated.js";');
  assert.ok(reachVerdict(measureReach(wider), baseline).refused.some((r) => r.startsWith("medianReachPercent: 100 > 50")));
  const shrunk = new Map(FIXTURE).set("test/old.test.ts", "export {};");
  assert.deepEqual(reachVerdict(measureReach(shrunk), baseline), { refused: [], tighter: ["importerCount: 0", "medianReachPercent: 0"] });
  assert.deepEqual(reachVerdict(baseline, baseline), { refused: [], tighter: [] });
  assert.throws(() => reachVerdict(baseline, { ...baseline, largestScc: NaN }), /invalid baseline largestScc/);
  assert.throws(() => measureReach(new Map()), /needs source modules and suites/);
  assert.deepEqual(reachVerdict(baseline, { ...baseline, largestScc: 2 }).tighter, ["largestScc: 1"]);
  const even = new Map(FIXTURE).set("src/other.ts", "export {};");
  assert.equal(measureReach(even).medianReachPercent, 50);
});

test("exported graph preserves selector edges, deleted targets, and literal path readers", () => {
  const files = new Map(FIXTURE).set("src/a.ts", '/* import "./run-task.js"; */ export const a = 1;')
    .set("test/path.test.ts", 'readFileSync("src/run-task.ts");')
    .set("test/deleted.test.ts", 'import "../src/deleted.js";')
    .set("test/self.test.ts", 'import "./self.test.js";');
  const built = graph(files);
  assert.deepEqual([...built.importers.get("src/run-task.ts")!].sort(), ["test/old.test.ts", "test/path.test.ts"]);
  assert.deepEqual([...built.directImports.get("test/path.test.ts")!], []);
  assert.deepEqual([...built.dependencies.get("src/a.ts")!], []);
  assert.deepEqual([...built.dependencies.get("test/self.test.ts")!], []);
  assert.deepEqual(selector.selectAffectedSuites(["src/a.ts"], { files, pathReaders: [] }).suites, ["test/old.test.ts", "test/path.test.ts"]);
  assert.deepEqual(selector.selectAffectedSuites(["src/deleted.ts"], { files, pathReaders: [] }).suites, ["test/deleted.test.ts"]);
});
