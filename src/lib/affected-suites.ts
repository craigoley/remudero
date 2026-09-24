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
   *  the shadow record says whether it is safe. Absent when no symbol source was supplied. */
  narrow?: string[];
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
/** Areas the selector models: code the graph walks, and prose the path readers cover. */
const MODELLED = /^(?:src|scripts|bin|test|docs|doctrine|plan)\/|^[^/]+\.md$/;

/** The file that forces a full run, or undefined when every change is modelled. */
export function fullRunTrigger(changed: readonly string[]): string | undefined {
  return changed.find((f) => !MODELLED.test(f) || (f.startsWith("test/") && !SUITE.test(f)));
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
 *  a suite reaches a script it spawns or loads by URL rather than imports. */
function namedPaths(content: string): string[] {
  const out = [...content.matchAll(/["'`]((?:src|scripts|bin|test)\/[\w./-]+\.(?:ts|mts|mjs|js|cjs))["'`]/g)].map((m) => m[1]!);
  for (const m of content.matchAll(/["'](src|scripts|bin)["']\s*,\s*((?:["'][\w.-]+["']\s*,\s*)*)["']([\w.-]+\.(?:ts|mjs|js|cjs))["']/g)) {
    const middle = [...m[2]!.matchAll(/["']([\w.-]+)["']/g)].map((p) => p[1]);
    out.push([m[1], ...middle, m[3]].join("/"));
  }
  return out;
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
    return { suites: [], fullRun: true, reasons: [`full run: ${trigger} is outside what the selector models`] };
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
  for (const file of all) {
    const content = input.files.get(file)!;
    const deps_ = [
      ...specifiers(content).map((s) => resolve(file, s, known)),
      ...namedPaths(content).filter((p) => known.has(p)),
    ];
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
  const selection: AffectedSelection = { suites, fullRun: false, reasons: suites.map((s) => `${s}: ${reasons.get(s)}`) };
  if (input.symbolSuites) {
    const changedTests = files.filter((f) => SUITE.test(f));
    const narrow = new Set([...changedTests, ...input.symbolSuites, ...pathReaders, ...recent]);
    selection.narrow = [...narrow].filter((s) => SUITE.test(s)).sort();
  }
  return selection;
}

/** Top-level declaration names whose lines a unified diff (`git diff -U0`) touches, per file. A
 *  removed-only hunk names the declaration at its position in the new file. */
export function changedSymbols(diffText: string, readFile: (path: string) => string): string[] {
  const DECL = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/;
  const symbols = new Set<string>();
  let file: string | undefined;
  let lines: string[] = [];
  for (const line of diffText.split("\n")) {
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header) {
      file = CODE_FILE.test(header[1]!) ? header[1] : undefined;
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
    return { suites: [], fullRun: true, reasons: [`full run: the selector could not read its input — ${(err as Error).message}`] };
  }
}

/** One real failure's verdict against each selection: would that selection have run it? */
export interface ShadowFailure {
  file: string;
  floor: "selected" | "missed";
  narrow?: "selected" | "missed";
}

/** W1-T4404 (ii) — the SHADOW RECORD for one full run: for every file that really failed, whether
 *  each selection would have run it. A full-run selection runs everything, so it misses nothing.
 *  This is the evidence W1-T4406 needs before any selection may skip a suite. */
export function shadowRecord(selection: AffectedSelection, failedFiles: readonly string[]): { fullRun: boolean; floorSize: number; narrowSize?: number; failures: ShadowFailure[] } {
  const floor = new Set(selection.suites);
  const narrow = selection.narrow ? new Set(selection.narrow) : undefined;
  const verdict = (set: Set<string>, file: string) => (selection.fullRun || set.has(file) ? "selected" : "missed");
  return {
    fullRun: selection.fullRun,
    floorSize: selection.suites.length,
    ...(narrow ? { narrowSize: narrow.size } : {}),
    failures: [...new Set(failedFiles)].sort().map((file) => ({
      file,
      floor: verdict(floor, file),
      ...(narrow ? { narrow: verdict(narrow, file) } : {}),
    })),
  };
}
