/**
 * Where a test belongs (W1-T9874, test/ restructure letter E part 1): a test's folder is COMPUTED
 * from the src modules it imports, not chosen. Ports the seed classifier described in
 * plan/seeds/test-restructure-2026-10-16/taxonomy.md section 1 onto two committed data files under
 * scripts/test-placement/ (subsystem-map.json, test-folders.tsv). Nothing here reads plan/seeds.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { RULE_SUITE_NAME_RE } from "./rule-suites.js";

export type ReachKind = "direct" | "helper" | "type" | "string" | "artifact" | "artifact-plan" | "harness";
export type TestKind = "unit" | "integration" | "rule" | "contract";
export type PlacementConfidence = "high" | "medium" | "low" | "none";

/** One module a test reaches: `module` is a src/scripts basename, or `helper:<name>` for a fixture. */
export interface TestImport {
  readonly module: string;
  readonly reach: ReachKind;
  readonly symbols?: readonly string[];
}

export interface TestFeatures {
  readonly path: string;
  readonly name: string;
  readonly kind: TestKind;
  readonly imports: readonly TestImport[];
}

export interface PlacementData {
  readonly map: SubsystemMap;
  readonly folders: readonly PlacementRow[];
  /** The high-band agreement recorded in test-folders.tsv's header at commit. */
  readonly recordedHighAgreement: number | undefined;
}

export interface PlacementRow {
  readonly testPath: string;
  readonly folder: string;
  readonly kind: string;
  readonly confidence: string;
}

type NameVocabulary = Record<string, readonly [string, number, number]>;

export interface SubsystemMap {
  readonly folders: readonly string[];
  readonly second_level: Record<string, readonly string[]>;
  readonly folder_of_subsystem: Record<string, string>;
  readonly subsystem_seed_rules: readonly { subsystem: string; basename_regex: string }[];
  readonly infra_subsystems: readonly string[];
  readonly hub_modules: readonly string[];
  readonly generic_helpers: readonly string[];
  readonly module_subsystem: Record<string, string>;
  readonly helper_subsystems: Record<string, string>;
  readonly scoring: { reach_weight: Record<ReachKind, number> };
  readonly name_keywords: NameVocabulary;
  readonly module_name_tokens: NameVocabulary;
  readonly second_level_families: Record<string, readonly (readonly [string, string])[]>;
  readonly second_level_family_rename: Record<string, string>;
}

export interface TestPopulation {
  readonly n: number;
  readonly df: ReadonlyMap<string, number>;
}

export interface PlaceInput {
  readonly imports: readonly TestImport[];
  readonly name: string;
  readonly kind?: TestKind;
  /** IDF source. Absent: every module is weighted as if unique to one test in a population of one. */
  readonly population?: TestPopulation;
}

export interface Placement {
  readonly folder: string;
  readonly confidence: PlacementConfidence;
  readonly primary: string | undefined;
  readonly runnerUp: string | undefined;
  readonly reasons: readonly string[];
}

export const PLACEMENT_DIR = "scripts/test-placement";
const BONUS_NAME = 4.0;
const BONUS_PREFIX = 3.0;
const OTHER_MODULE_SHARE = 0.3;
const INFRA_DAMPING = 0.4;
const HARNESS = "harness";
const UNPLACED = "unplaced";

/** Repo paths a test names as strings that stand for a subsystem without being a src module. */
const ARTIFACT_PREFIXES: readonly (readonly [string, string, ReachKind])[] = [
  [".github/workflows/", "ci-parity", "artifact"],
  ["deploy/", "deploy-host", "artifact"],
  ["hooks/", "ci-parity", "artifact"],
  ["contracts/", "console-read-model", "artifact"],
  ["docs/", "learning", "artifact"],
  ["plan/", "plan", "artifact-plan"],
];

/** Parse the `# high-band agreement ...: 0.xxxx` header comment and the tab-separated rows. */
export function parseTestFoldersTsv(text: string): { rows: PlacementRow[]; recordedHighAgreement: number | undefined } {
  const rows: PlacementRow[] = [];
  let recorded: number | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("#")) {
      const m = /high-band agreement[^0-9]*([0-9]*\.?[0-9]+)/i.exec(line);
      if (m) recorded = Number(m[1]);
      continue;
    }
    if (line.trim() === "" || line.startsWith("test_path\t")) continue;
    const [testPath, folder, kind, confidence] = line.split("\t");
    if (testPath && folder) rows.push({ testPath, folder, kind: kind ?? "", confidence: confidence ?? "" });
  }
  return { rows, recordedHighAgreement: recorded };
}

export function loadPlacementData(repoRoot: string): PlacementData {
  const map = JSON.parse(readFileSync(join(repoRoot, PLACEMENT_DIR, "subsystem-map.json"), "utf8")) as SubsystemMap;
  const { rows, recordedHighAgreement } = parseTestFoldersTsv(readFileSync(join(repoRoot, PLACEMENT_DIR, "test-folders.tsv"), "utf8"));
  return { map, folders: rows, recordedHighAgreement };
}

// ---------------------------------------------------------------------------------------------
// extraction

/**
 * Blank every comment with spaces, keeping strings, template literals and regex literals intact. A
 * scanner and not a regex: taxonomy.md section 1.1 records a regex stripper opening a fake block
 * comment at a `//` line that mentioned `src/**\/*.ts`, and so eating real code.
 */
export function stripComments(src: string): string {
  const out: string[] = [];
  const braceStack: number[] = []; // template ${ } nesting: depth of braces open at each `${`
  let braces = 0;
  let lastSignificant = "";
  const n = src.length;
  let i = 0;
  const regexAllowedAfter = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
  const scanTemplate = (): void => {
    // enters just after an opening backtick or after the `}` closing a ${ }
    while (i < n) {
      const c = src[i] as string;
      if (c === "\\") {
        out.push(c, src[i + 1] ?? "");
        i += 2;
      } else if (c === "`") {
        out.push(c);
        i++;
        return;
      } else if (c === "$" && src[i + 1] === "{") {
        out.push("${");
        i += 2;
        braceStack.push(braces);
        braces = 0;
        return;
      } else {
        out.push(c);
        i++;
      }
    }
  };
  while (i < n) {
    const c = src[i] as string;
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") {
        out.push(" ");
        i++;
      }
    } else if (c === "/" && next === "*") {
      out.push("  ");
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out.push(src[i] === "\n" ? "\n" : " ");
        i++;
      }
      out.push("  ");
      i += 2;
    } else if (c === '"' || c === "'") {
      out.push(c);
      i++;
      while (i < n && src[i] !== c && src[i] !== "\n") {
        if (src[i] === "\\") {
          out.push(src[i] as string);
          i++;
        }
        out.push(src[i] ?? "");
        i++;
      }
      out.push(src[i] ?? "");
      i++;
      lastSignificant = c;
    } else if (c === "`") {
      out.push(c);
      i++;
      scanTemplate();
      lastSignificant = "`";
    } else if (c === "/" && regexAllowedAfter.has(lastSignificant)) {
      out.push(c);
      i++;
      let inClass = false;
      while (i < n && src[i] !== "\n" && (inClass || src[i] !== "/")) {
        if (src[i] === "\\") {
          out.push(src[i] as string);
          i++;
        } else if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        out.push(src[i] ?? "");
        i++;
      }
      out.push(src[i] ?? "");
      i++;
      lastSignificant = "/";
    } else {
      if (c === "{") braces++;
      else if (c === "}") {
        if (braces === 0 && braceStack.length > 0) {
          braces = braceStack.pop() as number;
          out.push(c);
          i++;
          scanTemplate();
          lastSignificant = "`";
          continue;
        }
        braces--;
      }
      out.push(c);
      i++;
      if (!/\s/.test(c)) lastSignificant = c;
    }
  }
  return out.join("");
}

interface RawImport {
  readonly spec: string;
  readonly typeOnly: boolean;
  readonly symbols: readonly string[];
}

function rawImports(code: string): RawImport[] {
  const found: RawImport[] = [];
  const stmt = /\b(import|export)\s+(type\s+)?([^;'"`]*?)\s*from\s*(["'])([^"'\n]+)\4/g;
  for (let m = stmt.exec(code); m; m = stmt.exec(code)) {
    const clause = m[3] ?? "";
    const named = /\{([^}]*)\}/.exec(clause)?.[1] ?? "";
    const items = named.split(",").map((s) => s.trim()).filter((s) => s !== "");
    const values = items.filter((s) => !/^type\s/.test(s));
    const hasOther = clause.replace(/\{[^}]*\}/, "").replace(/[\s,]/g, "") !== "";
    const typeOnly = m[2] !== undefined || (values.length === 0 && !hasOther && items.length > 0);
    const symbols = values.map((s) => (s.split(/\s+as\s+/)[0] as string).trim());
    found.push({ spec: m[5] as string, typeOnly, symbols });
  }
  const bare = /\bimport\s*(["'])([^"'\n]+)\1/g;
  for (let m = bare.exec(code); m; m = bare.exec(code)) found.push({ spec: m[2] as string, typeOnly: false, symbols: [] });
  const dynamic = /\b(?:import|require)\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g;
  for (let m = dynamic.exec(code); m; m = dynamic.exec(code)) found.push({ spec: m[2] as string, typeOnly: false, symbols: [] });
  return found;
}

/** Repo-relative path a specifier points at, or undefined for a package / node: builtin. */
function resolveSpec(fromPath: string, spec: string): string | undefined {
  if (spec.startsWith("#src/")) return `src/${spec.slice(5)}`;
  if (spec.startsWith("#test/")) return `test/${spec.slice(6)}`;
  if (spec.startsWith("#scripts/")) return `scripts/${spec.slice(9)}`;
  if (spec.startsWith("./") || spec.startsWith("../")) return posix.normalize(posix.join(posix.dirname(fromPath), spec));
  return undefined;
}

function moduleName(repoPath: string): string {
  return basename(repoPath).replace(/\.(d\.ts|[cm]?[jt]s)$/, "");
}

const HELPER_DIR = /^test\/(helpers|setup|lib)\//;

function camelTokens(symbol: string): string[] {
  return symbol.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t !== "");
}

export function nameTokens(name: string): string[] {
  return name.replace(/\.test$/, "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t !== "");
}

function readHelper(repoPath: string, readFile: (p: string) => string | undefined): { path: string; text: string } | undefined {
  const stem = repoPath.replace(/\.(js|mjs|cjs)$/, "");
  for (const cand of [repoPath, `${stem}.ts`, `${stem}.mjs`, `${stem}.js`, `${stem}.cjs`, `${stem}.tsx`]) {
    const text = readFile(cand);
    if (text !== undefined) return { path: cand, text };
  }
  return undefined;
}

/**
 * The placement signal of one test file. `readFile` maps a repo-relative path to its text (or
 * undefined) and is what lets helper imports be followed through test/helpers|setup|lib; without it
 * a helper counts only as itself.
 */
export function extractTestFeatures(
  path: string,
  text: string,
  readFile: (repoPath: string) => string | undefined = () => undefined,
  map?: SubsystemMap,
): TestFeatures {
  const genericHelpers = new Set(map?.generic_helpers ?? []);
  const code = stripComments(text);
  const best = new Map<string, TestImport>();
  const weight: Record<ReachKind, number> = { direct: 7, helper: 6, harness: 5, type: 4, string: 3, artifact: 2, "artifact-plan": 1 };
  const add = (imp: TestImport): void => {
    const prior = best.get(imp.module);
    const symbols = [...new Set([...(prior?.symbols ?? []), ...(imp.symbols ?? [])])];
    const reach = prior && weight[prior.reach] >= weight[imp.reach] ? prior.reach : imp.reach;
    best.set(imp.module, { module: imp.module, reach, symbols });
  };
  const followed = new Set<string>();
  const follow = (fromPath: string, source: string, depth: number): void => {
    for (const r of rawImports(stripComments(source))) {
      const target = resolveSpec(fromPath, r.spec);
      if (target === undefined) continue;
      if (/^(src|scripts)\//.test(target)) {
        add({ module: moduleName(target), reach: depth === 0 ? (r.typeOnly ? "type" : "direct") : "helper", symbols: r.symbols });
      } else if (HELPER_DIR.test(target)) {
        const helper = moduleName(target);
        if (depth === 0) add({ module: `helper:${helper}`, reach: genericHelpers.has(helper) ? "harness" : "helper" });
        if (genericHelpers.has(helper) || followed.has(target) || depth > 3) continue;
        followed.add(target);
        const file = readHelper(target, readFile);
        if (file) follow(file.path, file.text, depth + 1);
      }
    }
  };
  follow(path, text, 0);
  for (const m of code.matchAll(/["'`]((?:scripts|src)\/[\w./-]+\.(?:mjs|cjs|js|ts|sh))["'`]/g)) add({ module: moduleName(m[1] as string), reach: "string" });
  for (const [prefix, subsystem, reach] of ARTIFACT_PREFIXES) {
    if (code.includes(prefix)) add({ module: `artifact:${subsystem}`, reach });
  }
  const name = basename(path).replace(/\.test\.[cm]?[jt]sx?$/, "");
  return { path, name, kind: detectKind(name, code, [...best.values()], (m) => map !== undefined && subsystemOfModule(map, m) !== undefined && (map.infra_subsystems.includes(subsystemOfModule(map, m) as string) || subsystemOfModule(map, m) === HARNESS)), imports: [...best.values()] };
}

const ANCHOR = /(REPO_ROOT|repoRoot|import\.meta\.(?:dirname|url)|__dirname|process\.cwd\(\)|TEST_DIR|testDir)/;

/** Identifiers `const X = ...` bound to an expression anchored at the repo (followed through aliases). */
function anchoredNames(code: string): Set<string> {
  const names = new Set<string>();
  const decls = [...code.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*([^;]*?);/g)];
  for (let pass = 0; pass < 3; pass++) {
    for (const d of decls) {
      const rhs = d[2] as string;
      if (/(mkdtemp|tmpdir|TMPDIR)/.test(rhs)) continue;
      if (ANCHOR.test(rhs) || [...names].some((n) => new RegExp(`\\b${n}\\b`).test(rhs))) names.add(d[1] as string);
    }
  }
  return names;
}

/** Rule = reads the real repo as text with no behavioural src import (taxonomy.md section 4). */
function detectKind(name: string, code: string, imports: readonly TestImport[], isInfra: (module: string) => boolean): TestKind {
  const behavioural = imports.filter((i) => i.reach === "direct" && !i.module.startsWith("helper:") && !isInfra(i.module)).length;
  const anchored = anchoredNames(code);
  const anchoredUse = (arg: string): boolean => !/(mkdtemp|tmpdir)/.test(arg) && (ANCHOR.test(arg) || [...anchored].some((n) => new RegExp(`\\b${n}\\b`).test(arg)));
  const reads = [...code.matchAll(/\b(?:readFileSync|readdirSync|readFile|readdir)\(([^\n]{0,160})/g)].some((m) => anchoredUse(m[1] as string));
  const walks = /ls-files/.test(code) && (ANCHOR.test(code) || /cwd/.test(code));
  const spawns = /(spawnSync|execFileSync|spawn\(|execSync|execFile\()/.test(code.replace(/execFileSync\("git"/g, ""));
  if (walks || (reads && behavioural <= 0 && !spawns) || (reads && RULE_SUITE_NAME_RE.test(name))) return "rule";
  if (/(openapi|contracts\/)/i.test(code) && behavioural === 0) return "contract";
  if (/(spawnSync|execFileSync|child_process)/.test(code)) return "integration";
  return "unit";
}

// ---------------------------------------------------------------------------------------------
// population (IDF)

export function buildPopulation(all: readonly TestFeatures[]): TestPopulation {
  const df = new Map<string, number>();
  for (const f of all) for (const i of f.imports) df.set(i.module, (df.get(i.module) ?? 0) + 1);
  return { n: all.length, df };
}

const populationBySha = new Map<string, TestPopulation>();

/** Every test file under test/ (not fixtures, helpers, setup or lib), as repo-relative paths. */
export function listTestFiles(repoRoot: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(repoRoot, rel), { withFileTypes: true })) {
      const p = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!/^(fixtures|helpers|setup|lib|node_modules)$/.test(e.name)) walk(p);
      } else if (/\.test\.[cm]?[jt]sx?$/.test(e.name)) out.push(p);
    }
  };
  walk("test");
  return out.sort();
}

export function readerFor(repoRoot: string): (repoPath: string) => string | undefined {
  return (p) => (existsSync(join(repoRoot, p)) ? readFileSync(join(repoRoot, p), "utf8") : undefined);
}

/**
 * Features for every test at the tree, and the IDF population over them. Computed ONCE per
 * `treeSha` (a caller passes `git rev-parse HEAD^{tree}`), never per placed file.
 */
export function populationFor(repoRoot: string, data: PlacementData, treeSha: string): { population: TestPopulation; features: ReadonlyMap<string, TestFeatures> } {
  const read = readerFor(repoRoot);
  const features = new Map<string, TestFeatures>();
  for (const p of listTestFiles(repoRoot)) features.set(p, extractTestFeatures(p, read(p) ?? "", read, data.map));
  const cached = populationBySha.get(treeSha);
  if (cached) return { population: cached, features };
  const population = buildPopulation([...features.values()]);
  populationBySha.set(treeSha, population);
  return { population, features };
}

// ---------------------------------------------------------------------------------------------
// placement

function subsystemOfModule(map: SubsystemMap, module: string): string | undefined {
  if (module.startsWith("artifact:")) return module.slice("artifact:".length);
  if (module.startsWith("helper:")) {
    const h = module.slice("helper:".length);
    return map.helper_subsystems[h] ?? (map.generic_helpers.includes(h) ? HARNESS : undefined);
  }
  const known = map.module_subsystem[module];
  if (known) return known;
  for (const rule of map.subsystem_seed_rules) if (new RegExp(rule.basename_regex).test(module)) return rule.subsystem;
  return undefined;
}

interface Scored {
  readonly module: string;
  readonly subsystem: string;
  score: number;
}

function confidenceOf(top: number, second: number): PlacementConfidence {
  if (top <= 0) return "none";
  const ratio = second <= 0 ? Number.POSITIVE_INFINITY : top / second;
  if (ratio >= 2) return "high";
  if (ratio >= 1.3) return "medium";
  return "low";
}

export function placeTest(input: PlaceInput, map: SubsystemMap): Placement {
  const tokens = new Set(nameTokens(input.name));
  const nameKey = nameTokens(input.name).join("-");
  const reasons: string[] = [];
  if (input.kind === "rule") {
    return { folder: "rules", confidence: "high", primary: undefined, runnerUp: undefined, reasons: ["kind rule: reads the repo as text, so it lives in rules/"] };
  }
  const pop = input.population ?? { n: 1, df: new Map<string, number>() };
  const scored: Scored[] = [];
  for (const imp of input.imports) {
    const subsystem = subsystemOfModule(map, imp.module);
    if (subsystem === undefined) continue;
    const bare = imp.module.replace(/^(helper|artifact):/, "");
    const df = pop.df.get(imp.module) ?? 0;
    const idf = Math.log((pop.n + 1) / (df + 1)) + 0.1;
    const symbolFactor = 1 + 0.25 * Math.sqrt(imp.symbols?.length ?? 0);
    const parts = bare.split("-").filter((t) => t !== "");
    const named = !imp.module.startsWith("artifact:") && parts.length > 0 && parts.every((t) => tokens.has(t));
    const prefixed = !imp.module.startsWith("artifact:") && (nameKey === bare || nameKey.startsWith(`${bare}-`));
    let score = map.scoring.reach_weight[imp.reach] * idf * symbolFactor + (named ? BONUS_NAME : 0) + (prefixed ? BONUS_PREFIX : 0);
    if (map.infra_subsystems.includes(subsystem) && !named) score *= INFRA_DAMPING;
    scored.push({ module: imp.module, subsystem, score });
  }
  const bySub = new Map<string, { total: number; best: Scored }>();
  for (const s of scored.sort((a, b) => b.score - a.score)) {
    const cur = bySub.get(s.subsystem);
    if (!cur) bySub.set(s.subsystem, { total: s.score, best: s });
    else cur.total += OTHER_MODULE_SHARE * s.score;
  }
  const ranked = [...bySub.entries()].sort((a, b) => b[1].total - a[1].total);
  let subsystem: string | undefined = ranked[0]?.[0];
  let primaryModule: string | undefined = ranked[0]?.[1].best.module;
  const topScore = ranked[0]?.[1].total ?? 0;
  const secondScore = ranked[1]?.[1].total ?? 0;
  let runnerUp = ranked[1]?.[0];
  if (subsystem !== undefined) reasons.push(`${subsystem} scores ${topScore.toFixed(2)} via ${primaryModule}`);

  // Infra-only signal: a non-infra candidate or a name keyword outranks it.
  const infraish = (s: string | undefined): boolean => s === undefined || s === HARNESS || s === UNPLACED || map.infra_subsystems.includes(s);
  const keyword = [...tokens].map((t) => map.name_keywords[t]).filter((k): k is readonly [string, number, number] => k !== undefined).sort((a, b) => b[1] * Math.log(1 + b[2]) - a[1] * Math.log(1 + a[2]))[0];
  if (infraish(subsystem)) {
    const other = ranked.find(([s]) => !infraish(s));
    if (other) {
      subsystem = other[0];
      primaryModule = other[1].best.module;
      reasons.push(`infra-only signal yields to ${other[0]}`);
    } else if (keyword && !infraish(keyword[0])) {
      subsystem = keyword[0];
      primaryModule = undefined;
      reasons.push(`name keyword votes ${keyword[0]}`);
    }
  }

  // The run-task hub: it houses the whole CLI, so imported symbol names and name tokens vote.
  const hub = input.imports.find((i) => map.hub_modules.some((h) => moduleName(h) === i.module));
  const hubIsPrimary = hub !== undefined && (primaryModule === hub.module || (primaryModule?.startsWith("helper:") === true && ranked[0]?.[1].best.module === primaryModule));
  if (hub && hubIsPrimary) {
    const votes = new Map<string, number>();
    const vote = (v: readonly [string, number, number] | undefined, w: number): void => {
      if (v) votes.set(v[0], (votes.get(v[0]) ?? 0) + w * v[1] * Math.log(1 + v[2]));
    };
    const symbols = input.imports.find((i) => i.module === hub.module)?.symbols ?? [];
    for (const t of new Set(symbols.flatMap(camelTokens))) vote(map.module_name_tokens[t], 1);
    for (const t of tokens) vote(map.name_keywords[t], 1.5);
    const voted = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    if (voted && voted[0] !== subsystem) {
      reasons.push(`run-task hub defers to its imported symbol names and the test name: ${voted[0]}`);
      runnerUp = subsystem;
      subsystem = voted[0];
      primaryModule = undefined;
    }
  }

  if (subsystem === undefined) {
    return { folder: "infra", confidence: "none", primary: undefined, runnerUp: undefined, reasons: ["no import or name signal places this test"] };
  }
  const folder = map.folder_of_subsystem[subsystem] ?? "infra";
  let placed = folder;
  const levels = map.second_level[folder];
  if (levels && primaryModule !== undefined) {
    const sub = (map.second_level_families[subsystem] ?? []).find(([, re]) => new RegExp(re).test(primaryModule as string))?.[0];
    const level = sub === undefined ? undefined : (map.second_level_family_rename[sub] ?? sub);
    if (level !== undefined && levels.includes(level)) placed = `${folder}/${level}`;
  }
  return { folder: placed, confidence: confidenceOf(topScore, secondScore), primary: subsystem, runnerUp, reasons };
}

export function placeFeatures(f: TestFeatures, map: SubsystemMap, population?: TestPopulation): Placement {
  return placeTest({ imports: f.imports, name: f.name, kind: f.kind, ...(population ? { population } : {}) }, map);
}

/** Folder agreement with the reviewed map, by the reviewed confidence band. */
export function measureAgreement(
  data: PlacementData,
  featuresOf: (testPath: string) => TestFeatures | undefined,
  population: TestPopulation,
): Record<string, { agree: number; total: number }> {
  const bands: Record<string, { agree: number; total: number }> = {};
  for (const row of data.folders) {
    const f = featuresOf(row.testPath);
    if (!f) continue;
    const band = (bands[row.confidence] ??= { agree: 0, total: 0 });
    band.total++;
    if (placeFeatures(f, data.map, population).folder === row.folder) band.agree++;
  }
  return bands;
}

/** Every folder and second-level name the map can place a test in. */
export function allFolderNames(map: SubsystemMap): string[] {
  const names = new Set<string>(map.folders);
  for (const [folder, levels] of Object.entries(map.second_level)) {
    for (const l of levels) names.add(l);
    names.add(folder);
  }
  for (const f of Object.values(map.folder_of_subsystem)) names.add(f);
  return [...names];
}


export interface PlacedFile {
  readonly path: string;
  readonly kind: TestKind;
  readonly placement: Placement;
}

/** Place each file against the population of the current tree. A missing file is refused by name. */
export function placePaths(repoRoot: string, paths: readonly string[], treeSha: string): PlacedFile[] {
  const data = loadPlacementData(repoRoot);
  const { population } = populationFor(repoRoot, data, treeSha);
  const read = readerFor(repoRoot);
  return paths.map((given) => {
    const path = given.startsWith(`${repoRoot}/`) ? given.slice(repoRoot.length + 1) : given;
    const text = read(path);
    if (text === undefined) throw new Error(`test-place: ${path} does not exist under ${repoRoot}`);
    const features = extractTestFeatures(path, text, read, data.map);
    return { path, kind: features.kind, placement: placeFeatures(features, data.map, population) };
  });
}

export function renderPlacement(f: PlacedFile): string {
  const p = f.placement;
  const via = p.primary === undefined ? "" : ` (${p.primary}${p.runnerUp ? `, runner-up ${p.runnerUp}` : ""})`;
  return [`${f.path} -> test/${p.folder}/  [${p.confidence}${via}]`, ...p.reasons.map((r) => `  - ${r}`)].join("\n");
}

export interface TestPlaceOutcome {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/**
 * The whole of `rmd test-place` below argument parsing, so the verb in src/run-task.ts stays a
 * three-line shell and a test reaches it without importing the 55k-line hub. Exit 2: no path or an
 * unknown flag. Exit 1: a path that does not exist.
 */
export function testPlaceOutcome(rest: readonly string[], repoRoot: string, treeSha: () => string): TestPlaceOutcome {
  const paths = rest.filter((a) => !a.startsWith("-"));
  const flags = rest.filter((a) => a.startsWith("-"));
  if (paths.length === 0) return { code: 2, out: "", err: "rmd test-place: at least one test path is required" };
  const unknown = flags.filter((f) => f !== "--json");
  if (unknown.length > 0) return { code: 2, out: "", err: `rmd test-place: unknown flag ${unknown.join(" ")}` };
  try {
    const placed = placePaths(repoRoot, paths, treeSha());
    return { code: 0, out: flags.includes("--json") ? JSON.stringify(placed) : placed.map(renderPlacement).join("\n"), err: "" };
  } catch (err) {
    return { code: 1, out: "", err: err instanceof Error ? err.message : String(err) };
  }
}
