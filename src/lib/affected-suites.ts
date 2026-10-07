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
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";

import { RMD_TMP_PREFIX } from "./tmp.js";

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
  recentOnly: { floor: string[]; narrow?: string[] };
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
}

const CODE_FILE = /\.(?:ts|mts|mjs|js|cjs)$/;
const SUITE = /^test\/.*\.test\.ts$/;
/** Where a changed declaration can name a symbol other suites reach: never test/. */
const SYMBOL_SOURCE = /^(?:src|scripts|bin)\//;
/** Areas the selector models: code the graph walks, and prose the path readers cover. */
const MODELLED = /^(?:src|scripts|bin|test|docs|doctrine|plan)\/|^[^/]+\.md$/;

/** The file that forces a full run, or undefined when every change is modelled. */
export function fullRunTrigger(changed: readonly string[]): string | undefined {
  return changed.find((f) => !MODELLED.test(f) || (f.startsWith("test/") && !SUITE.test(f)));
}

/** Characters after which a `/` can only begin a regex literal. */
const REGEX_PRECEDERS = "(,=:[!&|?{};+-*%<>~^";

/** W1-T5701 — `content` with every comment blanked, STRING-AWARE: a `//` or `/*` inside a string,
 *  template or regex literal is kept, and so is every string's text (specifiers live in strings).
 *  Without this a JSDoc import link or a backticked test path in prose read as a graph edge, and the
 *  selector's 285-module strongly-connected component was made of comments. A regex literal is
 *  recognised by what precedes its `/`, so a quote inside one cannot open a string; a `'` or `"`
 *  string ends at its line's end, so one misread cannot swallow the rest of the file. */
export function stripComments(content: string): string {
  return scanSource(content, false);
}

/** W1-T6089 — `content` (already comment-free) with every string, template and regex BODY blanked to
 *  spaces, delimiters and offsets kept: brackets inside a literal can no longer unbalance a walk. */
function maskLiterals(content: string): string {
  return scanSource(content, true);
}

function scanSource(content: string, mask: boolean): string {
  const literal = (text: string) => (mask && text.length > 1 ? text[0] + text.slice(1, -1).replace(/[^\n]/g, " ") + text.slice(-1) : text);
  let out = "";
  let last = ""; // the last significant (non-space, non-comment) character emitted
  let i = 0;
  const n = content.length;
  while (i < n) {
    const c = content[i]!;
    const next = content[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && content[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = content.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      out += " ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n && content[j] !== c) {
        if (content[j] === "\\") j += 1;
        else if (c !== "`" && content[j] === "\n") break;
        j += 1;
      }
      out += literal(content.slice(i, j + 1));
      i = j + 1;
      last = c;
      continue;
    }
    if (c === "/" && (last === "" || REGEX_PRECEDERS.includes(last))) {
      let j = i + 1;
      let inClass = false;
      while (j < n && content[j] !== "\n") {
        const d = content[j]!;
        if (d === "\\") j += 1;
        else if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        j += 1;
      }
      out += literal(content.slice(i, j + 1));
      i = j + 1;
      last = "/";
      continue;
    }
    out += c;
    if (!/\s/.test(c)) last = c;
    i += 1;
  }
  return out;
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
  const out = [...content.matchAll(/["'`]((?:src|scripts|bin|test)\/[\w./-]+\.(?:ts|mts|mjs|js|cjs))["'`]/g)]
    .map((m) => ({ path: m[1]!, at: m.index }));
  for (const m of content.matchAll(/["'](src|scripts|bin)["']\s*,\s*((?:["'][\w.-]+["']\s*,\s*)*)["']([\w.-]+\.(?:ts|mjs|js|cjs))["']/g)) {
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

/** The named-path edges `file` contributes to the graph. A src/ path written as a STRING inside a
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
    if (!fromSrc || !path.startsWith("src/")) return true;
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

/** THE SELECTOR — see the file header. Pure: it decides from `input` alone. */
export function selectAffectedSuites(changed: readonly string[], input: AffectedSuitesInput): AffectedSelection {
  const files = changed.filter((f) => f.length > 0);
  const trigger = fullRunTrigger(files);
  if (trigger !== undefined) {
    return { suites: [], fullRun: true, reasons: [`full run: ${trigger} is outside what the selector models`], recentOnly: { floor: [] } };
  }

  const reasons = new Map<string, string>();
  const pick = (suite: string, why: string) => {
    if (!reasons.has(suite)) reasons.set(suite, why);
  };
  for (const f of files) if (SUITE.test(f)) pick(f, "changed test");

  // The reverse import graph, walked breadth-first from every changed module.
  const all = [...input.files.keys()].filter((f) => CODE_FILE.test(f));
  const known = new Set([...all, ...files]);
  const importers = new Map<string, Set<string>>();
  const changedSet = new Set(files);
  // Suites that name a changed file by path (spawn it, read it): a one-hop read the narrow arm keeps.
  const pathNamers = new Set<string>();
  for (const file of all) {
    const content = stripComments(input.files.get(file)!);
    const named = namedEdges(file, content, known);
    if (SUITE.test(file) && named.some((p) => changedSet.has(p))) pathNamers.add(file);
    const deps_ = [...specifiers(content).map((s) => resolve(file, s, known)), ...named];
    for (const dep of deps_) {
      if (dep === undefined || dep === file) continue;
      if (!importers.has(dep)) importers.set(dep, new Set());
      importers.get(dep)!.add(file);
    }
  }
  const seen = new Set<string>();
  const queue = files.filter((f) => CODE_FILE.test(f)).map((f) => ({ file: f, root: f }));
  while (queue.length > 0) {
    const { file, root } = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (SUITE.test(file) && file !== root) pick(file, `reaches ${root}`);
    for (const next of importers.get(file) ?? []) queue.push({ file: next, root });
  }

  const pathReaders = input.pathReaders;
  const recent = input.recentFailures ?? [];
  for (const s of pathReaders) pick(s, "reads a changed file by path");
  for (const s of recent) pick(s, "failed recently");

  const suites = [...reasons.keys()].filter((s) => SUITE.test(s)).sort();
  // W1-T4462: a suite whose FIRST-registered reason is "failed recently" claimed no earlier arm —
  // pick() never overwrites, so this is exactly the suites recentFailures alone rescued.
  const recentOnlyFloor = suites.filter((s) => reasons.get(s) === "failed recently");
  const selection: AffectedSelection = {
    suites,
    fullRun: false,
    reasons: suites.map((s) => `${s}: ${reasons.get(s)}`),
    recentOnly: { floor: recentOnlyFloor },
  };
  if (input.symbolSuites) {
    const changedTests = files.filter((f) => SUITE.test(f));
    const narrowStructural = new Set([...changedTests, ...input.symbolSuites, ...pathReaders, ...pathNamers]);
    const narrow = new Set([...narrowStructural, ...recent]);
    selection.narrow = [...narrow].filter((s) => SUITE.test(s)).sort();
    selection.recentOnly.narrow = selection.narrow.filter((s) => !narrowStructural.has(s));
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

/** Reads the selector's input from `repoRoot`: git's tracked code files and their contents, and
 *  diff-class's own census and plan-reading listings (spawned, as src/ always reaches scripts/). A
 *  tracked file missing from disk (a concurrent delete) imports nothing and is left out; any other
 *  failure THROWS, and {@link affectedSelectionOrFull} turns that into a named full run. */
export function readAffectedSuitesInput(
  repoRoot: string,
  changed: readonly string[],
  extra: { recentFailures?: readonly string[]; symbolSuites?: readonly string[] } = {},
): AffectedSuitesInput {
  const run = (cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { cwd: repoRoot, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}: ${(r.stderr ?? "").trim().slice(0, 200)}`);
    return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  };
  const files = new Map<string, string>();
  for (const path of run("git", ["ls-files", "--", "src", "scripts", "bin", "test"])) {
    if (!CODE_FILE.test(path)) continue;
    try {
      files.set(path, readFileSync(join(repoRoot, path), "utf8"));
    } catch (err) {
      // Tracked but gone from disk imports nothing now; any other read failure is real.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  const list = join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}affected-`)), "changed.txt");
  writeFileSync(list, changed.join("\n") + "\n");
  const diffClass = join(repoRoot, "scripts", "diff-class.mjs");
  const census = run(process.execPath, ["--import", "tsx", diffClass, "--list-census-suites", "--changed-files", list]);
  const prose = changed.some((f) => !/^(?:src|scripts|bin|test)\//.test(f))
    ? run(process.execPath, ["--import", "tsx", diffClass, "--list-plan-reading-suites", "--changed-files", list])
    : [];
  return { files, pathReaders: [...census, ...prose], ...extra };
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
  /** The file's own W1-T4398 retry in this shard: "recovered" when pass two did not fail it again.
   *  Absent when no retry ran or its outcome could not be read. */
  retry?: "recovered" | "failed";
}

/** W1-T4404 (ii) — the SHADOW RECORD for one full run: for every file that really failed, whether
 *  each selection would have run it. A full-run selection runs everything, so it misses nothing.
 *  This is the evidence W1-T4406 needs before any selection may skip a suite. */
export function shadowRecord(
  selection: AffectedSelection, failedFiles: readonly string[], retried: Readonly<Record<string, "recovered" | "failed">> = {},
): { fullRun: boolean; floorSize: number; narrowSize?: number; failures: ShadowFailure[] } {
  const floor = new Set(selection.suites);
  const narrow = selection.narrow ? new Set(selection.narrow) : undefined;
  const recentOnlyFloor = new Set(selection.recentOnly.floor);
  const recentOnlyNarrow = new Set(selection.recentOnly.narrow ?? []);
  const verdict = (set: Set<string>, recentOnly: Set<string>, file: string): "selected" | "missed" | "flake" => {
    if (selection.fullRun) return "selected";
    if (!set.has(file)) return "missed";
    return recentOnly.has(file) ? "flake" : "selected";
  };
  return {
    fullRun: selection.fullRun,
    floorSize: selection.suites.length,
    ...(narrow ? { narrowSize: narrow.size } : {}),
    failures: [...new Set(failedFiles)].sort().map((file) => ({
      file,
      floor: verdict(floor, recentOnlyFloor, file),
      ...(narrow ? { narrow: verdict(narrow, recentOnlyNarrow, file) } : {}),
      ...(Object.hasOwn(retried, file) ? { retry: retried[file] } : {}),
    })),
  };
}
