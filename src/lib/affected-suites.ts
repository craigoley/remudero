/**
 * W1-T4404 — WHICH SUITES A CHANGE AFFECTS, decided by one function that CI and `rmd preflight` share.
 *
 * Nothing in CI mapped a change to the tests it affects: a SOURCE pull request ran the whole
 * instrumented suite whatever it touched. This is the selector a later task (W1-T4406) may let
 * narrow a run — but only after it has run in SHADOW beside every full run and its record shows it
 * would have selected each real failure. Until then it decides nothing: CI prints what it would have
 * run and whether each failed file was in it.
 *
 * THE FLOOR, each arm catching what the others are blind to:
 *   - a changed test file selects itself;
 *   - the import graph selects every suite that reaches a changed module, however many hops away
 *     (relative imports, plus `scripts/…` paths a suite spawns or loads by path);
 *   - the path-reading census selects suites that read a changed file as TEXT — a suite that greps a
 *     source file imports nothing, so the graph alone misses it (the falsifier);
 *   - suites that failed recently stay selected while they are unstable.
 * A change the graph cannot model — config, the lockfile, a workflow, a test helper or fixture —
 * selects the FULL suite and says which file forced it.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import {
  IMPACT_MAP_STALENESS_BOUND,
  impactArmSelection,
  impactDrift,
  maskLiterals,
  spawningSuites,
  stripComments,
  type ImpactArmInput,
} from "./test-impact-map.js";
import { RMD_TMP_PREFIX } from "./tmp.js";
import { hostWorktreeGit } from "./worktree-git.js";

export { stripComments };

export interface AffectedSelection {
  /** THE FLOOR: suites to run, sorted. Empty when `fullRun` — the full suite needs no list. */
  suites: string[];
  fullRun: boolean;
  /** One line per decision: why each suite was selected, or which file forced a full run. */
  reasons: string[];
  /** THE NARROW CANDIDATE, measured in shadow only: the floor's import-graph arm replaced by the
   *  suites naming a changed SYMBOL or one of its src/ callers. MEASURED 2026-09-24: 582 suites
   *  import src/run-task.ts, which imports ~195 modules, so a module-level graph reaches ~90% of
   *  suites from most src/ changes; symbol-level reach is where selectivity could come from, and
   *  the shadow record says whether it is safe. Suites naming a changed file by path stay in it.
   *  Absent when no symbol source was supplied. */
  narrow?: string[];
  /** W1-T4462 — suites counted in `suites`/`narrow` ONLY because they failed recently: no changed
   *  test, import-graph reach, symbol reach, or path-reading arm claims them — recentFailures is
   *  the sole reason. `shadowRecord` reads this to label a real failure caught only this way
   *  "flake" rather than "selected": a currently-unstable suite staying selected tells you nothing
   *  about whether the selector's MODEL would have reached it, which is the half W1-T4406 must be
   *  able to trust. `narrow` is present only when `narrow` above was computed. */
  recentOnly: { floor: string[]; narrow?: string[]; impact?: string[] };
  /** W1-T6083 — THE IMPACT ARM, measured in shadow only: the suites main's coverage run saw EXECUTE
   *  a changed function body, or LOAD a module whose module-scope code changed, plus the floor's
   *  suites the map cannot speak for (spawners, suites it never saw). Absent when no impact input
   *  was supplied; on a fallback it equals `narrow` (else the floor) and `impactFallback` says why. */
  impact?: string[];
  impactFallback?: string;
  /** W1-T6084 — set when a read map was asked for and cannot speak for this change (missing, stale,
   *  not an ancestor of the base): census membership and the non-code full-run triggers then follow
   *  today's rules, and this says why. */
  readMapFallback?: string;
}

/** Everything the selector decides from, as plain DATA — the selector itself reads nothing. */
export interface AffectedSuitesInput {
  /** Every tracked code file under src/, scripts/, bin/ and test/, with its content. */
  files: ReadonlyMap<string, string>;
  /** Suites that read a changed file by path (diff-class's census and plan-reading sets). */
  pathReaders: readonly string[];
  /** Suites that failed in recent runs. */
  recentFailures?: readonly string[];
  /** Suites naming a changed symbol or one of its src/ callers (ci-parity's callerReachableSuites). */
  symbolSuites?: readonly string[];
  /** W1-T6083: main's impact map and the change's place against it — enables `impact`. */
  impact?: ImpactArmInput;
  /** W1-T6084: main's read map — which suites READ or LISTED each non-code path — and its drift. */
  readMap?: ReadMapInput;
}

const CODE_FILE = /\.(?:ts|mts|mjs|js|cjs)$/;
const SUITE = /^test\/.*\.test\.ts$/;
/** Where a changed declaration can name a symbol other suites reach: never test/. */
const SYMBOL_SOURCE = /^(?:src|scripts|bin)\//;
/** Areas the selector models: code the graph walks, and prose the path readers cover. */
const MODELLED = /^(?:src|scripts|bin|test|docs|doctrine|plan)\/|^[^/]+\.md$/;
const CONTRACT_FILE = /^(?:openapi\/daemon\.yaml|packages\/api-client\/src\/schema\.d\.ts)$/;

/** The non-code files whose readers the read map OBSERVES: the contract and deploy trees, and json. */
const READ_MAPPED = /^(?:openapi|deploy)\/|\.json$/;

/** The two modelled contracts use content readers; other contract-tree paths force a full run.
 *  Other {@link READ_MAPPED} paths force one only when `readMapUsable` is false. */
export function fullRunTrigger(changed: readonly string[], readMapUsable = false): string | undefined {
  return changed.find((f) => {
    if (CONTRACT_FILE.test(f)) return false;
    if (/^(?:openapi|packages)\//.test(f)) return true;
    return !(readMapUsable && READ_MAPPED.test(f)) &&
      (!MODELLED.test(f) || (f.startsWith("test/") && !SUITE.test(f)));
  });
}

export const READ_MAP_FORMAT = "rmd-read-map-v1";

/** One test file's record, as test/setup/read-map.ts writes it. */
export interface ReadMapRecord {
  suite: string;
  reads: readonly string[];
  listed: readonly string[];
}

/** Main's merged read map: for each non-code path, the suites that read it (indices into `suites`),
 *  and for each directory, the suites that listed it — `dir/**` when the listing was recursive. */
export interface ReadMap {
  format: typeof READ_MAP_FORMAT;
  /** The main sha whose full run recorded this map. */
  sha: string;
  suites: string[];
  reads: Record<string, number[]>;
  listed: Record<string, number[]>;
}

/** What the selector decides from beside the map: why it is absent, and its drift against the base. */
export interface ReadMapInput {
  map?: ReadMap;
  mapProblem?: string;
  drift: ImpactArmInput["drift"];
  stalenessBound?: number;
}

/** Merges per-suite records into one map keyed by `sha`. A suite named twice (a retry) is unioned. */
export function buildReadMap(records: readonly ReadMapRecord[], opts: { sha: string }): ReadMap {
  const merged = new Map<string, { reads: Set<string>; listed: Set<string> }>();
  for (const r of records) {
    const into = merged.get(r.suite) ?? { reads: new Set<string>(), listed: new Set<string>() };
    for (const p of r.reads) into.reads.add(p);
    for (const p of r.listed) into.listed.add(p);
    merged.set(r.suite, into);
  }
  const suites = [...merged.keys()].sort();
  const reads: Record<string, number[]> = {};
  const listed: Record<string, number[]> = {};
  suites.forEach((suite, i) => {
    const entry = merged.get(suite)!;
    for (const p of [...entry.reads].sort()) (reads[p] ??= []).push(i);
    for (const p of [...entry.listed].sort()) (listed[p] ??= []).push(i);
  });
  return { format: READ_MAP_FORMAT, sha: opts.sha, suites, reads, listed };
}

/** The records one full run left in `dir` (test/setup/read-map.ts's files). A file that is not a
 *  record is reported in `problems`, never silently read as an empty one. */
export function readReadRecords(dir: string): { records: ReadMapRecord[]; problems: string[] } {
  const records: ReadMapRecord[] = [];
  const problems: string[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const value = JSON.parse(readFileSync(join(dir, name), "utf8")) as Partial<ReadMapRecord> & { format?: string };
    if (value.format !== "rmd-read-record-v1" || typeof value.suite !== "string" || !Array.isArray(value.reads) || !Array.isArray(value.listed)) {
      problems.push(`${name} is not a read record`);
      continue;
    }
    records.push({ suite: value.suite, reads: value.reads, listed: value.listed });
  }
  return { records, problems };
}

/** Parses the merged map at `path`; a missing or malformed file is a NAMED problem, never an empty map. */
export function readReadMap(path: string, read: (p: string) => string = (p) => readFileSync(p, "utf8")): { map?: ReadMap; problem?: string } {
  let value: Partial<ReadMap> | undefined;
  try {
    value = JSON.parse(read(path)) as Partial<ReadMap>;
  } catch (err) {
    return { problem: `read map ${path} unreadable: ${(err as Error).message}` };
  }
  const object = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);
  if (value?.format !== READ_MAP_FORMAT || typeof value.sha !== "string" || !Array.isArray(value.suites) ||
      !object(value.reads) || !object(value.listed)) {
    return { problem: `read map ${path} is not a ${READ_MAP_FORMAT} file` };
  }
  return { map: value as ReadMap };
}

/** The read map for a checkout: the map at `mapPath` and its drift against `base`. */
export function readReadMapInput(
  root: string, mapPath: string, base: string, run?: Parameters<typeof impactDrift>[3],
): ReadMapInput {
  const { map, problem } = readReadMap(mapPath);
  return map ? { map, drift: impactDrift(root, map.sha, base, run) } : { mapProblem: problem, drift: { changedSinceMap: [] } };
}

/** Why the read map cannot speak for a change, or undefined when it can. */
export function readMapProblem(input: ReadMapInput | undefined): string | undefined {
  if (!input) return "no read map supplied";
  const map = input.map;
  if (!map) return `no read map (${input.mapProblem ?? "none supplied"})`;
  if (input.drift.distance === undefined) {
    return `read map ${map.sha.slice(0, 12)} is not an ancestor of the base (${input.drift.problem ?? "unknown"})`;
  }
  const bound = input.stalenessBound ?? IMPACT_MAP_STALENESS_BOUND;
  if (input.drift.distance > bound) {
    return `read map ${map.sha.slice(0, 12)} is stale: ${input.drift.distance} commits behind the base, past its bound of ${bound}`;
  }
  return undefined;
}

/** `dir`'s ancestors, nearest first, ending at the repo root (""): `a/b` → `a/b`, `a`, `""`. */
function ancestors(dir: string): string[] {
  const out: string[] = [];
  for (let d = dir === "." ? "" : dir; ; d = d.slice(0, Math.max(d.lastIndexOf("/"), 0))) {
    out.push(d);
    if (d === "") return out;
  }
}

/** The suites the map says READ `file`, and those that LISTED a directory it sits in: exactly that
 *  directory, or an ancestor listed recursively — the census reader of the file's population. */
export function readMapReaders(map: ReadMap, file: string): { readers: string[]; listers: Array<{ suite: string; dir: string }> } {
  const name = (i: number) => map.suites[i]!;
  const readers = Object.hasOwn(map.reads, file) ? map.reads[file]!.map(name) : [];
  const listers: Array<{ suite: string; dir: string }> = [];
  const slash = file.lastIndexOf("/");
  const own = slash < 0 ? "." : file.slice(0, slash);
  const keys = [own, ...ancestors(own).map((a) => (a === "" ? "**" : `${a}/**`))];
  for (const key of keys) {
    if (!Object.hasOwn(map.listed, key)) continue;
    for (const i of map.listed[key]!) listers.push({ suite: name(i), dir: key });
  }
  return { readers, listers };
}

/** Every module specifier a file names: static and dynamic imports, re-exports and requires. */
function specifiers(content: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\b(?:import|export)\s[^'"`;]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) for (const m of content.matchAll(re)) out.push(m[1]!);
  return out;
}

/** Repo paths a file names outright — `"scripts/x.mjs"`, or `join(ROOT, "scripts", "x.mjs")`: how
 *  a suite reaches a script it spawns or loads by URL rather than imports. `at` is the offset of the
 *  path's first quote. */
function namedPaths(content: string): Array<{ path: string; at: number }> {
  const out = [...content.matchAll(/["'`]((?:src|scripts|bin|test)\/[\w./-]+\.(?:ts|mts|mjs|js|cjs)|openapi\/daemon\.yaml|packages\/api-client\/src\/schema\.d\.ts)["'`]/g)]
    .map((m) => ({ path: m[1]!, at: m.index }));
  for (const m of content.matchAll(/["'](src|scripts|bin|openapi|packages)["']\s*,\s*((?:["'][\w.-]+["']\s*,\s*)*)["']([\w.-]+\.(?:ts|mjs|js|cjs|yaml))["']/g)) {
    const middle = [...m[2]!.matchAll(/["']([\w.-]+)["']/g)].map((p) => p[1]);
    out.push({ path: [m[1], ...middle, m[3]].join("/"), at: m.index });
  }
  // A suite is selected by its own imports, never by being NAMED: a test path in a string is prose.
  return out.filter(({ path }) => !/\.test\.ts$/.test(path));
}

/** Calls that spawn, fork or read the path in their arguments — through an argv array. */
const PATH_SINKS = new Set(["spawn", "spawnSync", "execFile", "execFileSync", "fork", "runBoundedSuite", "readFileSync", "readFile", "URL"]);
/** Calls that resolve a repo-relative path against a directory. */
const PATH_JOINS = new Set(["join", "resolve"]);

/** W1-T6089 — whether the path named at `at` is USED at runtime: it sits in the arguments of a
 *  PATH_SINKS call (through any argv `[…]`), or is joined onto a RUNTIME directory —
 *  `join(deps.repoRoot, "src", "run-task.ts")` — which a module does only to touch the file (spawn
 *  it, hand it to cluster as `exec:`, read it). A rootless `join("src", "x.ts")` is transparent: the
 *  call around it decides. An enclosing `{` (object literal, block) or the file's top level ends the
 *  walk: a path held as data in a table, array or constant is never used in place. */
function usedAtRuntime(masked: string, at: number): boolean {
  let depth = 0;
  for (let i = at - 1; i >= 0; i -= 1) {
    const c = masked[i]!;
    if (c === ")" || c === "]" || c === "}") depth += 1;
    else if (c === "(" || c === "[" || c === "{") {
      if (depth > 0) depth -= 1;
      else if (c === "{") return false;
      else if (c === "(") {
        const callee = /([\w$]+)\s*$/.exec(masked.slice(Math.max(0, i - 64), i))?.[1] ?? "";
        if (PATH_SINKS.has(callee)) return true;
        if (PATH_JOINS.has(callee) && !/^\s*["'`]/.test(masked.slice(i + 1, at + 1))) return true;
      }
    }
  }
  return false;
}

/** The named-path edges `file` contributes to the graph. A repo path written as a STRING inside a
 *  src/ module is usually data — authority.ts, config-schema.ts, worktree-sites.ts and
 *  baked-runtime-inputs.ts list src paths in tables — never an import: MEASURED 2026-10-06 those 114
 *  string edges made almost every module reach src/run-task.ts. It stays an edge only when the module
 *  USES it ({@link usedAtRuntime}): serve-supervisor, operator-mcp and gate-gardener spawn
 *  src/run-task.ts, measurement-cadence reads it. A test or script naming a path keeps its edge. */
function namedEdges(file: string, content: string, known: ReadonlySet<string>): string[] {
  const fromSrc = file.startsWith("src/");
  let masked: string | undefined;
  return namedPaths(content).filter(({ path, at }) => {
    if (!known.has(path)) return false;
    if (!fromSrc) return true;
    masked ??= maskLiterals(content);
    return usedAtRuntime(masked, at);
  }).map(({ path }) => path);
}

/** Resolves a relative specifier from `from` against the known files, TS's `.js` → `.ts` included. */
function resolve(from: string, spec: string, known: ReadonlySet<string>): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const base = normalize(join(dirname(from), spec)).split("\\").join("/");
  const stem = base.replace(/\.(?:js|mjs|cjs)$/, "");
  const candidates = [base, `${stem}.ts`, `${stem}.mts`, `${base}.ts`, `${base}.mjs`, `${base}.js`, `${base}/index.ts`];
  return candidates.find((c) => known.has(c));
}

export interface AffectedSuitesGraph {
  dependencies: Map<string, Set<string>>;
  importers: Map<string, Set<string>>;
  directImports: Map<string, Set<string>>;
  namedDependencies: Map<string, Set<string>>;
}

/** The selector's comment-free graph, shared with the reach census. Extra targets cover deletions. */
export function buildAffectedSuitesGraph(
  files: ReadonlyMap<string, string>, extraTargets: readonly string[] = [],
): AffectedSuitesGraph {
  const all = [...files.keys()].filter((f) => CODE_FILE.test(f));
  const known = new Set([...all, ...extraTargets]);
  const dependencies = new Map<string, Set<string>>();
  const importers = new Map<string, Set<string>>();
  const directImports = new Map<string, Set<string>>();
  const namedDependencies = new Map<string, Set<string>>();
  for (const file of all) {
    const content = stripComments(files.get(file)!);
    const imported = new Set(specifiers(content).map((s) => resolve(file, s, known))
      .filter((dep): dep is string => dep !== undefined && dep !== file));
    const named = new Set(namedEdges(file, content, known).filter((dep) => dep !== file));
    directImports.set(file, imported);
    namedDependencies.set(file, named);
    const deps = new Set([...imported, ...named]);
    dependencies.set(file, deps);
    for (const dep of deps) {
      if (!importers.has(dep)) importers.set(dep, new Set());
      importers.get(dep)!.add(file);
    }
  }
  return { dependencies, importers, directImports, namedDependencies };
}

/** THE SELECTOR — see the file header. Pure: it decides from `input` alone. */
export function selectAffectedSuites(changed: readonly string[], input: AffectedSuitesInput): AffectedSelection {
  const files = changed.filter((f) => f.length > 0);
  const mapProblem = readMapProblem(input.readMap);
  const trigger = fullRunTrigger(files, mapProblem === undefined);
  if (trigger !== undefined) {
    const why = READ_MAPPED.test(trigger) && mapProblem !== undefined ? ` (the read map cannot speak for it: ${mapProblem})` : "";
    return {
      suites: [], fullRun: true, reasons: [`full run: ${trigger} is outside what the selector models${why}`], recentOnly: { floor: [] },
      ...(why === "" ? {} : { readMapFallback: mapProblem! }),
    };
  }

  const reasons = new Map<string, string>();
  const pick = (suite: string, why: string) => {
    if (!reasons.has(suite)) reasons.set(suite, why);
  };
  for (const f of files) if (SUITE.test(f)) pick(f, "changed test");

  // The reverse import graph, walked breadth-first from every changed module or contract.
  const { importers, namedDependencies } = buildAffectedSuitesGraph(input.files, files);
  const changedSet = new Set(files);
  // Suites that name a changed file by path (spawn it, read it): a one-hop read the narrow arm keeps.
  const pathNamers = new Set<string>();
  for (const [file, named] of namedDependencies) {
    if (SUITE.test(file) && [...named].some((p) => changedSet.has(p))) pathNamers.add(file);
  }
  const seen = new Set<string>();
  const contractSeen = new Set<string>();
  const queue = files.filter((f) => CODE_FILE.test(f) || CONTRACT_FILE.test(f)).map((f) => ({ file: f, root: f }));
  while (queue.length > 0) {
    const { file, root } = queue.shift()!;
    const visited = CONTRACT_FILE.test(root) ? contractSeen : seen;
    if (visited.has(file)) continue;
    visited.add(file);
    if (SUITE.test(file) && file !== root) {
      pick(file, `reaches ${root}`);
      if (CONTRACT_FILE.test(root)) pathNamers.add(file);
    }
    for (const next of importers.get(file) ?? []) queue.push({ file: next, root });
  }

  const pathReaders = [...input.pathReaders];
  // The mkdtemp census scans tracked src/, scripts/ and test/ .ts/.mjs files outside the maps.
  const mkdtempCensus = "test/mkdtemp-allowlist-rekey.test.ts";
  if (input.files.has(mkdtempCensus) && files.some((f) => /^(?:src|scripts|test)\/.*\.(?:ts|mjs)$/.test(f))) {
    pathReaders.push(mkdtempCensus);
  }
  const changedSrcTypeScript = files.some((f) => f.startsWith("src/") && f.endsWith(".ts"));
  // This census greps tracked src/**/*.ts in a child process, outside the import and read maps.
  const errorCensus = "test/error-subclass-census.test.ts";
  if (input.files.has(errorCensus) && changedSrcTypeScript) {
    pathReaders.push(errorCensus);
  }
  // This census reads tracked src TypeScript through git ls-files, outside the import/read maps.
  const dependencyCensus = "test/dependency-declarations-match-use.test.ts";
  if (input.files.has(dependencyCensus) && changedSrcTypeScript) {
    pathReaders.push(dependencyCensus);
  }
  const gitLeafCensus = "test/the-git-leaf-check-sees-a-cwd-option-spawn.test.ts";
  if (input.files.has(gitLeafCensus) && changedSrcTypeScript) {
    pathReaders.push(gitLeafCensus);
  }
  // W1-T5557: this suite scans tracked src/**/*.ts for env literals through git ls-files, outside the maps.
  const envRegistry = "test/env-var-registry.test.ts";
  if (input.files.has(envRegistry) && changedSrcTypeScript) {
    pathReaders.push(envRegistry);
  }
  // W1-T4994: a coverage shard failed on this suite at 39737b73 and the narrow selector missed it. The suite
  // drives runSweep and buildSweepEffects, so a change to the sweep, status or run-task seams must select it.
  const verdictReuse = "test/a-verdict-is-reused-when-nothing-it-judged-changed.test.ts";
  const verdictReuseSeams = ["src/lib/sweep.ts", "src/lib/status.ts", "src/run-task.ts"];
  if (input.files.has(verdictReuse) && files.some((f) => verdictReuseSeams.includes(f))) {
    pathReaders.push(verdictReuse);
  }
  const claimsCheck = "test/claims-check.test.ts";
  const claimsCheckEdges = ["src/lib/plan.ts", "src/run-task.ts", "test/one-bad-plan-shard-never-takes-the-daemon-down.test.ts"];
  if (input.files.has(claimsCheck) && files.some((f) => claimsCheckEdges.includes(f))) {
    pathReaders.push(claimsCheck);
  }
  const precheckParity = "test/every-ci-census-is-asked-before-the-push.test.ts";
  const precheckParityEdges = ["scripts/affected-reach-baseline.json", "src/lib/affected-suites.ts", "test/the-affected-suite-reach-ratchet.test.ts"];
  if (input.files.has(precheckParity) && files.some((f) => precheckParityEdges.includes(f))) {
    pathReaders.push(precheckParity);
  }
  // W1-T6338: preserve the recorded dashboard/settings miss beyond the narrow arm's symbol reach.
  const viewSchemas = "test/every-view-body-matches-its-schema.test.ts";
  const viewSchemaEdges = ["src/lib/repo-dashboard-route.ts", "test/repo-settings-report-their-effective-values.test.ts"];
  if (input.files.has(viewSchemas) && files.some((f) => viewSchemaEdges.includes(f))) {
    pathReaders.push(viewSchemas);
  }
  const viewEtags = "test/view-etags-are-deterministic.test.ts";
  const viewEtagsEdges = ["src/lib/repo-dashboard-route.ts", "test/repo-settings-report-their-effective-values.test.ts"];
  if (input.files.has(viewEtags) && files.some((f) => viewEtagsEdges.includes(f))) {
    pathReaders.push(viewEtags);
  }
  const proofExecTmpHygiene = "test/proof-exec-tmp-hygiene.test.ts";
  const proofExecTmpHygieneEdges = [
    "src/lib/ci-parity.ts",
    "test/the-coverage-entry-shards-the-way-ci-does.test.ts",
    "test/the-local-coverage-shard-count-equals-cis.test.ts",
  ];
  if (input.files.has(proofExecTmpHygiene) && files.some((f) => proofExecTmpHygieneEdges.includes(f))) {
    pathReaders.push(proofExecTmpHygiene);
  }
  // W1-T6783: a coverage shard failed on this suite (run 37877770799) and the narrow selector missed it.
  const coverageMode = "test/preflight-coverage-mode.test.ts";
  const coverageModeEdges = [
    "src/lib/ci-parity.ts",
    "test/the-coverage-entry-shards-the-way-ci-does.test.ts",
    "test/the-local-coverage-shard-count-equals-cis.test.ts",
  ];
  if (input.files.has(coverageMode) && files.some((f) => coverageModeEdges.includes(f))) {
    pathReaders.push(coverageMode);
  }
  const nowViewRederives = "test/now-view-rederives-only-dirtied-tasks.test.ts";
  const nowViewRederivesEdges = [
    "src/lib/read-model-db.ts",
    "test/read-model-readers-never-contend-with-the-writer.test.ts",
  ];
  if (input.files.has(nowViewRederives) && files.some((f) => nowViewRederivesEdges.includes(f))) {
    pathReaders.push(nowViewRederives);
  }
  const promptRender = "test/prompt-render.test.ts";
  const promptRenderEdges = [
    "src/lib/prompt-render.ts",
    "src/run-task.ts",
    "test/the-prerequisite-split-contract-has-no-optional-seam.test.ts",
  ];
  if (input.files.has(promptRender) && files.some((f) => promptRenderEdges.includes(f))) {
    pathReaders.push(promptRender);
  }
  const recent = input.recentFailures ?? [];
  for (const s of pathReaders) pick(s, "reads a changed file by path");
  // W1-T6084: the OBSERVED readers and census readers, beside the source-text rules above (which still
  // run: a suite whose reads happen in a spawned child, or through `git ls-files`, leaves no record).
  const observed = new Set<string>();
  const notes: string[] = [];
  if (mapProblem === undefined) {
    const map = input.readMap!.map!;
    const spawners = files.some((f) => READ_MAPPED.test(f)) ? spawningSuites(input.files) : new Set<string>();
    const since = new Set(input.readMap!.drift.changedSinceMap);
    const known = new Set(map.suites);
    for (const f of files) {
      if (SUITE.test(f)) continue;
      const { readers, listers } = readMapReaders(map, f);
      for (const s of readers) {
        observed.add(s);
        pick(s, `read ${f} (read map)`);
      }
      for (const { suite, dir } of listers) {
        observed.add(suite);
        pick(suite, `listed ${dir} (read map: a census reader of ${f})`);
      }
      if (!READ_MAPPED.test(f)) continue;
      // What the record cannot see: a suite spawning children that read the file, and suites newer than
      // the map or edited since it was taken. Each is selected when it names the file, or is unseen.
      const slash = f.lastIndexOf("/");
      const names = slash < 0 ? [f] : [f, `${f.slice(0, slash)}/`];
      for (const s of spawners) {
        const text = input.files.get(s) ?? "";
        if (names.some((n) => text.includes(n))) {
          observed.add(s);
          pick(s, `spawns children and names ${f}; the read map cannot credit their reads`);
        }
      }
      for (const s of input.files.keys()) {
        if (!SUITE.test(s)) continue;
        if (!known.has(s)) pick(s, "absent from the read map");
        else if (since.has(s)) pick(s, "changed after the read map's sha");
        else continue;
        observed.add(s);
      }
      if (readers.length === 0 && listers.length === 0) notes.push(`${f}: read by no suite on the read map`);
    }
  }
  for (const s of recent) pick(s, "failed recently");

  const suites = [...reasons.keys()].filter((s) => SUITE.test(s)).sort();
  // W1-T4462: a suite whose FIRST-registered reason is "failed recently" claimed no earlier arm —
  // pick() never overwrites, so this is exactly the suites recentFailures alone rescued.
  const recentOnlyFloor = suites.filter((s) => reasons.get(s) === "failed recently");
  const selection: AffectedSelection = {
    suites,
    fullRun: false,
    reasons: [...suites.map((s) => `${s}: ${reasons.get(s)}`), ...notes],
    recentOnly: { floor: recentOnlyFloor },
    ...(input.readMap !== undefined && mapProblem !== undefined ? { readMapFallback: mapProblem } : {}),
  };
  if (input.symbolSuites) {
    const changedTests = files.filter((f) => SUITE.test(f));
    const narrowStructural = new Set([...changedTests, ...input.symbolSuites, ...pathReaders, ...pathNamers, ...observed]);
    const narrow = new Set([...narrowStructural, ...recent]);
    selection.narrow = [...narrow].filter((s) => SUITE.test(s)).sort();
    selection.recentOnly.narrow = selection.narrow.filter((s) => !narrowStructural.has(s));
  }
  if (input.impact) {
    const arm = impactArmSelection(input.impact, {
      changed: files, files: input.files, floor: suites, pathReaders: [...pathReaders, ...observed], pathNamers: [...pathNamers], recent,
      fallback: selection.narrow ?? suites,
    });
    selection.impact = arm.suites;
    selection.recentOnly.impact = arm.recentOnly;
    if (arm.fallback !== undefined) selection.impactFallback = arm.fallback;
  }
  return selection;
}

/** Top-level declaration names whose lines a unified diff (`git diff -U0`) touches, per SOURCE file
 *  (src/, scripts/, bin/). A removed-only hunk names the declaration at its position in the new file.
 *  A changed TEST file's declarations are never symbols: the suite selects itself, and its locals
 *  (`const one`, `base`) are namesakes of nothing — MEASURED 2026-10-06, `one` alone named 2,210
 *  suites. */
export function changedSymbols(diffText: string, readFile: (path: string) => string): string[] {
  const DECL = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/;
  const symbols = new Set<string>();
  let file: string | undefined;
  let lines: string[] = [];
  for (const line of diffText.split("\n")) {
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header) {
      file = CODE_FILE.test(header[1]!) && SYMBOL_SOURCE.test(header[1]!) ? header[1] : undefined;
      try {
        lines = file ? readFile(file).split("\n") : [];
      } catch (err) {
        // Deleted in the new tree: it declares nothing now, and its importers are the graph's business.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        lines = [];
      }
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || !file || lines.length === 0) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    for (let n = Math.max(start, 1); n <= Math.max(start, start + count - 1); n += 1) {
      for (let i = Math.min(n, lines.length) - 1; i >= 0; i -= 1) {
        const m = DECL.exec(lines[i]!);
        if (m) {
          symbols.add(m[1]!);
          break;
        }
      }
    }
  }
  return [...symbols].sort();
}

/** The changed src/, scripts/ and bin/ CODE files whose hunks in `diffText` name no declaration —
 *  an import-only edit, a deleted module. The narrow arm reaches a module only through the symbols
 *  it changed, so for one of these it reaches nothing, and a caller must run the floor instead. */
export function symbollessSourceFiles(changed: readonly string[], diffText: string, readFile: (path: string) => string): string[] {
  const sections = new Map<string, string>();
  for (const section of diffText.split(/^(?=diff --git )/m)) {
    const header = /^\+\+\+ b\/(.+)$/m.exec(section);
    const removed = /^--- a\/(.+)$/m.exec(section);
    const path = header?.[1] ?? removed?.[1];
    if (path !== undefined) sections.set(path, (sections.get(path) ?? "") + section);
  }
  return changed.filter((f) => CODE_FILE.test(f) && SYMBOL_SOURCE.test(f) &&
    changedSymbols(sections.get(f) ?? "", readFile).length === 0);
}

/** This module's own checkout. The census and plan-reading listings run ITS diff-class.mjs, tsx and
 *  tsconfig, pointed at the target tree as DATA: a worker worktree's own scripts/ are worker-written
 *  code, and the host must not execute them (the W1-T6091 shape, worker-provider.ts). */
const HARNESS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** BACKSTOP on one listing child: it fires only when a listing hangs, and the overrun throws. */
export const AFFECTED_LISTING_TIMEOUT_MS = 2 * 60_000;

/** The listing child's whole environment: an allowlist, never the parent's, so no GH_, GITHUB_,
 *  token, key or provider variable reaches it, under a throwaway HOME and TMPDIR. */
export function affectedListingEnv(home: string, parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const tmp = join(home, "tmp");
  mkdirSync(tmp, { recursive: true });
  const env: Record<string, string> = { HOME: home, TMPDIR: tmp, PATH: parent.PATH ?? "/usr/local/bin:/usr/bin:/bin" };
  for (const key of ["LANG", "LC_ALL"] as const) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function listingLines(r: SpawnSyncReturns<string>, what: string): string[] {
  if (r.status !== 0) throw new Error(`${what} exited ${r.status}: ${(r.error?.message ?? r.stderr ?? "").trim().slice(0, 200)}`);
  return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Reads the selector's input from `repoRoot`: git's tracked code files and their contents, and
 *  diff-class's own census and plan-reading listings (spawned from {@link HARNESS_ROOT} with
 *  `--plan-reading-root <repoRoot>`, as src/ always reaches scripts/). A tracked file missing from
 *  disk (a concurrent delete) imports nothing and is left out; any other failure THROWS, and
 *  {@link affectedSelectionOrFull} turns that into a named full run. */
export function readAffectedSuitesInput(
  repoRoot: string,
  changed: readonly string[],
  extra: { recentFailures?: readonly string[]; symbolSuites?: readonly string[] } = {},
): AffectedSuitesInput {
  const run = (cmd: string, args: string[]) =>
    listingLines(spawnSync(cmd, args, { cwd: repoRoot, encoding: "utf8" }), `${cmd} ${args.join(" ")}`);
  const files = new Map<string, string>();
  // W1-T6136: coveragePrecheck (run-task.ts) passes a WORKER worktree, so the listing goes through the leaf.
  const tracked = hostWorktreeGit(repoRoot, ["ls-files", "--", "src", "scripts", "bin", "test"], { maxBuffer: 1 << 26 });
  for (const path of tracked.split("\n").map((l) => l.trim()).filter(Boolean)) {
    if (!CODE_FILE.test(path)) continue;
    try {
      files.set(path, readFileSync(join(repoRoot, path), "utf8"));
    } catch (err) {
      // Tracked but gone from disk imports nothing now; any other read failure is real.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return { files, pathReaders: readAffectedListings(repoRoot, changed), ...extra };
}

/** diff-class's census and plan-reading listings for `repoRoot`, from {@link HARNESS_ROOT}'s copy
 *  with the tree passed as data. Reads no git; a listing that fails or overruns THROWS. */
export function readAffectedListings(repoRoot: string, changed: readonly string[]): string[] {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}affected-`));
  try {
    const list = join(dir, "changed.txt");
    writeFileSync(list, changed.join("\n") + "\n");
    const env = affectedListingEnv(join(dir, "home"));
    const diffClass = join(HARNESS_ROOT, "scripts", "diff-class.mjs");
    const listing = (flag: string) => listingLines(spawnSync(
      process.execPath,
      ["--import", "tsx", diffClass, flag, "--changed-files", list, "--plan-reading-root", realpathSync(repoRoot)],
      { cwd: HARNESS_ROOT, env, encoding: "utf8", timeout: AFFECTED_LISTING_TIMEOUT_MS },
    ), `diff-class ${flag}`);
    const census = listing("--list-census-suites");
    const prose = changed.some((f) => !/^(?:src|scripts|bin|test)\//.test(f)) ? listing("--list-plan-reading-suites") : [];
    return [...census, ...prose];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The selection, or a FULL run naming why its input could not be read — never a narrower guess. */
export function affectedSelectionOrFull(changed: readonly string[], readInput: () => AffectedSuitesInput): AffectedSelection {
  try {
    return selectAffectedSuites(changed, readInput());
  } catch (err) {
    // A failed read is a FULL run that names its cause — never an empty selection.
    return {
      suites: [],
      fullRun: true,
      reasons: [`full run: the selector could not read its input — ${(err as Error).message}`],
      recentOnly: { floor: [] },
    };
  }
}

/** One real failure's verdict against each selection: would that selection have run it? "flake"
 *  (W1-T4462) is neither: the failure WAS caught, but only because recentFailures rescued a
 *  suite no structural arm reached — the informative half (does the MODEL reach it) still reads
 *  as unproven, so a flake is never mistaken for a real hit. */
export interface ShadowFailure {
  file: string;
  floor: "selected" | "missed" | "flake";
  narrow?: "selected" | "missed" | "flake";
  impact?: "selected" | "missed" | "flake";
  /** The file's own W1-T4398 retry in this shard: "recovered" when pass two did not fail it again.
   *  Absent when no retry ran or its outcome could not be read. */
  retry?: "recovered" | "failed";
}

/** W1-T4404 (ii) — the SHADOW RECORD for one full run: for every file that really failed, whether
 *  each selection would have run it. A full-run selection runs everything, so it misses nothing.
 *  This is the evidence W1-T4406 needs before any selection may skip a suite. */
export function shadowRecord(
  selection: AffectedSelection, failedFiles: readonly string[], retried: Readonly<Record<string, "recovered" | "failed">> = {},
): { fullRun: boolean; floorSize: number; narrowSize?: number; impactSize?: number; impactFallback?: string; failures: ShadowFailure[] } {
  const floor = new Set(selection.suites);
  const narrow = selection.narrow ? new Set(selection.narrow) : undefined;
  const recentOnlyFloor = new Set(selection.recentOnly.floor);
  const recentOnlyNarrow = new Set(selection.recentOnly.narrow ?? []);
  const impact = selection.impact ? new Set(selection.impact) : undefined;
  const recentOnlyImpact = new Set(selection.recentOnly.impact ?? []);
  const verdict = (set: Set<string>, recentOnly: Set<string>, file: string): "selected" | "missed" | "flake" => {
    if (selection.fullRun) return "selected";
    if (!set.has(file)) return "missed";
    return recentOnly.has(file) ? "flake" : "selected";
  };
  return {
    fullRun: selection.fullRun,
    floorSize: selection.suites.length,
    ...(narrow ? { narrowSize: narrow.size } : {}),
    ...(impact ? { impactSize: impact.size } : {}),
    ...(selection.impactFallback === undefined ? {} : { impactFallback: selection.impactFallback }),
    failures: [...new Set(failedFiles)].sort().map((file) => ({
      file,
      floor: verdict(floor, recentOnlyFloor, file),
      ...(narrow ? { narrow: verdict(narrow, recentOnlyNarrow, file) } : {}),
      ...(impact ? { impact: verdict(impact, recentOnlyImpact, file) } : {}),
      ...(Object.hasOwn(retried, file) ? { retry: retried[file] } : {}),
    })),
  };
}
