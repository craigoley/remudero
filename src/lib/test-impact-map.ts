/**
 * W1-T6083 — WHICH SUITES EXECUTED THE CODE A CHANGE TOUCHES, read from one main coverage run, in
 * SHADOW beside the floor and the narrow arm.
 *
 * The import graph cannot narrow an ordinary src/ change: src/run-task.ts reaches 447 of 453 src
 * modules, so ~2,380 of ~2,700 suites reach almost anything (MEASURED 2026-10-06). V8 can: each
 * coverage shard already writes one report per test process. This module turns those reports into
 * an IMPACT MAP — for every src/, scripts/ and bin/ file, the suites that LOADED it and, per
 * function, the suites that EXECUTED it — and selects from it. Nothing here changes what runs.
 *
 * SOUNDNESS RULES, each with a test in test/each-test-files-executed-source-blocks-select-in-shadow:
 *   - a changed test selects itself, and the census (path-reading) suites stay selected by path;
 *   - an edit inside a function BODY selects the suites that executed that function; any other
 *     executable edit (module scope, a declaration line, an exported binding) selects every suite
 *     that LOADED the module, because V8 credits module-scope code to every loader;
 *   - comment, blank, import and type-only lines are inert: they select nothing;
 *   - a suite whose process spawns children is credited with none of their code (a child's report
 *     names no suite, and many children blank NODE_V8_COVERAGE), so it is selected whenever the
 *     floor reaches it, as is every suite the map never saw;
 *   - a missing or stale map, a map whose sha the base does not descend from, a changed non-code
 *     input (W1-T6084's read map does not exist yet), or a changed file the map's own sha predates
 *     falls back to the narrow selection and names why.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const IMPACT_MAP_FORMAT = "rmd-test-impact-map-v1";

/** Characters after which a `/` can only begin a regex literal. */
const REGEX_PRECEDERS = "(,=:[!&|?{};+-*%<>~^";

/** W1-T5701 — `content` with every comment blanked, STRING-AWARE: a `//` or `/*` inside a string,
 *  template or regex literal is kept, and so is every string's text (specifiers live in strings).
 *  Without this a JSDoc import link or a backticked test path in prose read as a graph edge, and the
 *  selector's 285-module strongly-connected component was made of comments. A regex literal is
 *  recognised by what precedes its `/`, so a quote inside one cannot open a string; a `'` or `"`
 *  string ends at its line's end, so one misread cannot swallow the rest of the file. With
 *  `keepLines`, a block comment keeps its newlines, so line N of the result is line N of `content`.
 *  (Moved here from affected-suites.ts by W1-T6083, which re-exports it: the impact arm reads it and
 *  the selector reads the arm, so one of them had to own it.) */
export function stripComments(content: string, opts: { keepLines?: boolean } = {}): string {
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
      const stop = end < 0 ? n : end + 2;
      out += opts.keepLines ? content.slice(i, stop).replace(/[^\n]/g, "") || " " : " ";
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n && content[j] !== c) {
        if (content[j] === "\\") j += 1;
        else if (c !== "`" && content[j] === "\n") break;
        j += 1;
      }
      out += content.slice(i, j + 1);
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
      out += content.slice(i, j + 1);
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


/** Commits the base may be past the map's sha before the arm stops trusting it. Main lands a few
 *  dozen merges a day and the shard artifacts live one day, so a map this far behind is no longer
 *  the newest one obtainable. PRIMARY CONTROL: it alone decides when the arm stops speaking. */
export const IMPACT_MAP_STALENESS_BOUND = 150;

/** One test file's coverage, keyed by the files it loaded. `functions` rows are
 *  `[startLine, endLine, ...suite indices that executed the function]`, 1-based original lines. */
export interface ImpactMapFile {
  loadedBy: number[];
  functions: number[][];
}

export interface ImpactMap {
  format: typeof IMPACT_MAP_FORMAT;
  /** The main sha whose coverage run built this map. */
  sha: string;
  /** Every suite the map saw, sorted; files index into it. */
  suites: string[];
  /** Process reports that named no suite — spawned children, credited to nobody. */
  orphanReports: number;
  files: Record<string, ImpactMapFile>;
}

/** The V8 shapes the builder reads (a NODE_V8_COVERAGE report, raw or restored from a bundle). */
interface V8Range { startOffset: number; endOffset: number; count: number }
interface V8Function { functionName: string; ranges: V8Range[] }
interface V8Script { url: string; functions: V8Function[] }
export interface CoverageProcessReport {
  /** The suite this process ran, repo-relative — written by coverage-merge-ratchet's compaction. */
  test?: string;
  /** The file URL (trailing slash) the process ran under; defaults to the builder's root. */
  root?: string;
  result: V8Script[];
  "source-map-cache"?: Record<string, { lineLengths?: number[]; data?: { mappings?: string } } | null>;
}

const SUITE = /^test\/.*\.test\.ts$/;
const IMPACT_CODE = /^(?:src|scripts|bin)\/.*\.(?:ts|mts|mjs|js|cjs)$/;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** A source map's `mappings`, decoded: per generated line, `[generatedColumn, originalLine]` pairs
 *  (0-based). Only the two fields the builder reads are kept. */
export function decodeMappings(mappings: string): Array<Array<[number, number]>> {
  const lines: Array<Array<[number, number]>> = [[]];
  const state = [0, 0, 0, 0, 0];
  let field = 0;
  let col = 0;
  let value = 0;
  let shift = 0;
  let segment: number[] = [];
  const endSegment = () => {
    if (segment.length >= 4) lines[lines.length - 1]!.push([segment[0]!, segment[2]!]);
    segment = [];
    field = 0;
  };
  for (const ch of mappings) {
    if (ch === ";") {
      endSegment();
      lines.push([]);
      col = 0;
      state[0] = 0;
      continue;
    }
    if (ch === ",") {
      endSegment();
      continue;
    }
    const digit = B64.indexOf(ch);
    if (digit < 0) throw new Error(`source map: invalid base64 character ${JSON.stringify(ch)}`);
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    const decoded = value & 1 ? -(value >> 1) : value >> 1;
    value = 0;
    shift = 0;
    state[field] = state[field]! + decoded;
    if (field === 0) col = state[0]!;
    segment.push(field === 0 ? col : state[field]!);
    field += 1;
  }
  endSegment();
  return lines;
}

/** Start offset of every line of `lineLengths` (lengths exclude the newline). */
function lineStarts(lineLengths: readonly number[]): number[] {
  const starts: number[] = [];
  let at = 0;
  for (const len of lineLengths) {
    starts.push(at);
    at += len + 1;
  }
  return starts;
}

/** The 1-based original line span of the generated range `[start, end)`: the min and max original
 *  line of every mapping segment INSIDE it. A function with no segment of its own — a bundler
 *  helper, a synthesized export getter — maps to nothing and is left out, so it can never claim a
 *  module-scope line as its body. */
function mappedSpan(start: number, end: number, starts: readonly number[], decoded: Array<Array<[number, number]>>): [number, number] | undefined {
  let lo = Infinity;
  let hi = -Infinity;
  for (let line = 0; line < starts.length && line < decoded.length; line += 1) {
    const base = starts[line]!;
    if (base >= end) break;
    for (const [col, orig] of decoded[line]!) {
      const at = base + col;
      if (at < start || at >= end) continue;
      lo = Math.min(lo, orig);
      hi = Math.max(hi, orig);
    }
  }
  return lo === Infinity ? undefined : [lo + 1, hi + 1];
}

/** The 1-based line span of `[start, end)` in an unmapped script, from its own source text. */
function textSpan(start: number, end: number, starts: readonly number[]): [number, number] {
  const lineOf = (offset: number) => {
    let line = 0;
    while (line + 1 < starts.length && starts[line + 1]! <= offset) line += 1;
    return line + 1;
  };
  return [lineOf(start), lineOf(Math.max(start, end - 1))];
}

/** `url` relative to `rootUrl`, POSIX-separated, or undefined when it is not a file under it. */
function repoPath(url: string, rootUrl: string): string | undefined {
  if (!url.startsWith("file:")) return undefined;
  const rel = relative(fileURLToPath(rootUrl), fileURLToPath(url)).split(sep).join("/");
  return rel.startsWith("..") || rel.length === 0 ? undefined : rel;
}

/** The suite a process report ran: its compaction-recorded `test`, else the one suite its own
 *  scripts include. A report naming no suite is a spawned child's. */
export function reportSuite(report: CoverageProcessReport, rootUrl: string): string | undefined {
  if (typeof report.test === "string" && SUITE.test(report.test)) return report.test;
  const root = typeof report.root === "string" ? report.root : rootUrl;
  for (const script of report.result) {
    const rel = repoPath(script.url, root);
    if (rel !== undefined && SUITE.test(rel)) return rel;
  }
  return undefined;
}

/** THE BUILDER — see the file header. `readSource` supplies an UNMAPPED script's text (a native
 *  .mjs) so its functions can be placed; without it such a file records loaders only, and every
 *  edit to it selects them all. Throws when no report names a suite: a map of nothing is not one. */
export function buildImpactMap(
  reports: Iterable<CoverageProcessReport>,
  opts: { sha: string; root: string; readSource?: (path: string) => string | undefined },
): ImpactMap {
  const rootUrl = opts.root.startsWith("file:") ? (opts.root.endsWith("/") ? opts.root : `${opts.root}/`) : new URL(`file://${opts.root.replace(/\/?$/, "/")}`).href;
  const loaded = new Map<string, Set<string>>();
  const fns = new Map<string, Map<string, Set<string>>>();
  const suites = new Set<string>();
  let orphans = 0;
  const decodedCache = new Map<string, { starts: number[]; decoded: Array<Array<[number, number]>> }>();
  for (const report of reports) {
    const suite = reportSuite(report, rootUrl);
    if (suite === undefined) {
      orphans += 1;
      continue;
    }
    suites.add(suite);
    const root = typeof report.root === "string" ? report.root : rootUrl;
    for (const script of report.result) {
      const path = repoPath(script.url, root);
      if (path === undefined || !IMPACT_CODE.test(path)) continue;
      if (!loaded.has(path)) loaded.set(path, new Set());
      loaded.get(path)!.add(suite);
      const table = fns.get(path) ?? new Map<string, Set<string>>();
      fns.set(path, table);
      const cached = report["source-map-cache"]?.[script.url];
      let place: (start: number, end: number) => [number, number] | undefined;
      if (cached?.data?.mappings !== undefined && Array.isArray(cached.lineLengths)) {
        const key = `${cached.lineLengths.join(",")}|${cached.data.mappings}`;
        let entry = decodedCache.get(key);
        if (!entry) {
          entry = { starts: lineStarts(cached.lineLengths), decoded: decodeMappings(cached.data.mappings) };
          decodedCache.set(key, entry);
        }
        const { starts, decoded } = entry;
        place = (s, e) => mappedSpan(s, e, starts, decoded);
      } else {
        const text = opts.readSource?.(path);
        if (text === undefined) continue;
        const starts = lineStarts(text.split("\n").map((l) => l.length));
        place = (s, e) => textSpan(s, e, starts);
      }
      script.functions.forEach((fn, index) => {
        const own = fn.ranges[0];
        if (!own || (index === 0 && own.startOffset === 0 && fn.functionName === "")) return;
        const span = place(own.startOffset, own.endOffset);
        if (!span) return;
        const key = `${span[0]}:${span[1]}`;
        if (!table.has(key)) table.set(key, new Set());
        if (own.count > 0) table.get(key)!.add(suite);
      });
    }
  }
  if (suites.size === 0) throw new Error(`impact map: no process report names a suite (${orphans} orphan report(s)) — refusing an empty map`);
  const order = [...suites].sort();
  const index = new Map(order.map((s, i) => [s, i]));
  const ids = (set: Set<string>) => [...set].map((s) => index.get(s)!).sort((a, b) => a - b);
  const files: Record<string, ImpactMapFile> = {};
  for (const path of [...loaded.keys()].sort()) {
    const functions = [...fns.get(path)!.entries()]
      .map(([key, by]) => [...key.split(":").map(Number), ...ids(by)])
      .sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!);
    files[path] = { loadedBy: ids(loaded.get(path)!), functions };
  }
  return { format: IMPACT_MAP_FORMAT, sha: opts.sha, suites: order, orphanReports: orphans, files };
}

/** A map read from disk, or why there is none. A wrong format is a problem, never a guess. */
export function readImpactMap(path: string, read: (p: string) => string = (p) => readFileSync(p, "utf8")): { map?: ImpactMap; problem?: string } {
  let text: string;
  try {
    text = read(path);
  } catch (err) {
    // Absent and unreadable are two named problems; the arm prints whichever it got and falls back.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { problem: `no impact map at ${path}` };
    return { problem: `impact map ${path} unreadable: ${(err as Error).message}` };
  }
  let value: Partial<ImpactMap>;
  try {
    value = JSON.parse(text) as Partial<ImpactMap>;
  } catch (err) {
    // A corrupt map is its own named problem, never an empty map that would select nothing.
    return { problem: `impact map ${path} is not JSON: ${(err as Error).message}` };
  }
  if (value?.format !== IMPACT_MAP_FORMAT || typeof value.sha !== "string" || !Array.isArray(value.suites) ||
      value.suites.length === 0 || typeof value.files !== "object" || value.files === null) {
    return { problem: `impact map ${path} is not a non-empty ${IMPACT_MAP_FORMAT} map` };
  }
  return { map: value as ImpactMap };
}

/** Blank lines, comment lines, import/re-export-from statements and top-level type-only
 *  declarations of `content`, 1-based: code V8 never runs, or credits to every loader alike. */
export function inertLines(content: string): Set<number> {
  const stripped = stripComments(content, { keepLines: true });
  const lines = stripped.split("\n");
  const inert = new Set<number>();
  lines.forEach((line, i) => {
    if (line.trim() === "") inert.add(i + 1);
  });
  const lineAt = (offset: number) => stripped.slice(0, offset).split("\n").length;
  const markSpan = (from: number, to: number) => {
    for (let l = lineAt(from); l <= lineAt(to); l += 1) inert.add(l);
  };
  const IMPORT = /^[ \t]*(?:import(?![ \t]*[(.])\b[^;]*?["'][^"'\n]+["'][ \t]*;?|export[ \t]+(?:type[ \t]+)?(?:\*(?:[ \t]+as[ \t]+[\w$]+)?|\{[^}]*\})[ \t]*from[ \t]*["'][^"'\n]+["'][ \t]*;?|export[ \t]+type[ \t]*\{[^}]*\}[ \t]*;?)/gm;
  for (const m of stripped.matchAll(IMPORT)) markSpan(m.index!, m.index! + m[0].length - 1);
  const TYPE_DECL = /^(?:export[ \t]+)?(?:declare[ \t]+)?(?:interface|type)[ \t]+[A-Za-z_$][\w$]*/gm;
  for (const m of stripped.matchAll(TYPE_DECL)) {
    const isInterface = /\binterface\b/.test(m[0]);
    let depth = 0;
    let opened = false;
    let i = m.index! + m[0].length;
    for (; i < stripped.length; i += 1) {
      const c = stripped[i]!;
      if (c === "{" || c === "(" || c === "[") {
        depth += 1;
        opened = true;
      } else if (c === "}" || c === ")" || c === "]") depth -= 1;
      if (depth === 0 && isInterface && opened) break;
      if (depth === 0 && !isInterface && c === ";") break;
      if (depth === 0 && !isInterface && c === "\n" && /^\S/.test(stripped.slice(i + 1, i + 2)) && !/^[|&=]/.test(stripped.slice(i + 1, i + 2))) break;
    }
    markSpan(m.index!, Math.min(i, stripped.length - 1));
  }
  return inert;
}

/** One file section of a `git diff -U0`. */
interface DiffFile {
  oldPath?: string;
  newPath?: string;
  hunks: Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number }>;
}

function parseDiff(diffText: string): DiffFile[] {
  const out: DiffFile[] = [];
  let cur: DiffFile | undefined;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = { hunks: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const old = /^--- (?:a\/(.+)|\/dev\/null)$/.exec(line);
    if (old) {
      cur.oldPath = old[1];
      continue;
    }
    const neu = /^\+\+\+ (?:b\/(.+)|\/dev\/null)$/.exec(line);
    if (neu) {
      cur.newPath = neu[1];
      continue;
    }
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) {
      cur.hunks.push({
        oldStart: Number(h[1]),
        oldCount: h[2] === undefined ? 1 : Number(h[2]),
        newStart: Number(h[3]),
        newCount: h[4] === undefined ? 1 : Number(h[4]),
      });
    }
  }
  return out;
}

/** Where one changed file's executable edits land in the map's (base) coordinates. */
export interface ImpactTouch {
  path: string;
  /** An edit outside every function body: every loader is affected. */
  moduleScope: boolean;
  /** `start:end` keys of the innermost function bodies edited. */
  functions: string[];
}

/** The innermost function whose BODY (strictly between its first and last line) holds `line`; for
 *  an insertion after old line `line`, the innermost function that holds the gap. */
function innermost(rows: readonly number[][], line: number, insertion: boolean): string | undefined {
  let best: number[] | undefined;
  for (const row of rows) {
    const [s, e] = row as [number, number];
    const inside = insertion ? s <= line && line < e : s < line && line < e;
    if (inside && (!best || e - s < best[1]! - best[0]!)) best = row;
  }
  return best ? `${best[0]}:${best[1]}` : undefined;
}

/** Each changed CODE file's touches. Old-side lines are read in the base's coordinates (the map's),
 *  inertness from the base and head texts; an unreadable text makes none of its lines inert. */
export function impactTouches(
  diffText: string,
  map: ImpactMap,
  text: { base: (path: string) => string | undefined; head: (path: string) => string | undefined },
): ImpactTouch[] {
  const touches: ImpactTouch[] = [];
  for (const f of parseDiff(diffText)) {
    const path = f.oldPath;
    if (path === undefined || !IMPACT_CODE.test(path)) continue; // a new file: its importers' edits reach it
    const rows = map.files[path]?.functions ?? [];
    const touch: ImpactTouch = { path, moduleScope: false, functions: [] };
    touches.push(touch);
    if (f.newPath !== path) {
      touch.moduleScope = true; // deleted or renamed: every loader loses the module
      continue;
    }
    const baseText = text.base(path);
    const headText = text.head(path);
    const oldInert = baseText === undefined ? new Set<number>() : inertLines(baseText);
    const newInert = headText === undefined ? new Set<number>() : inertLines(headText);
    const fnKeys = new Set<string>();
    for (const h of f.hunks) {
      const oldLines = Array.from({ length: h.oldCount }, (_, i) => h.oldStart + i);
      const newLines = Array.from({ length: h.newCount }, (_, i) => h.newStart + i);
      const liveOld = oldLines.filter((l) => !oldInert.has(l));
      const liveNew = newLines.filter((l) => !newInert.has(l));
      if (liveOld.length === 0 && liveNew.length === 0) continue;
      const anchors: Array<[number, boolean]> = liveOld.length > 0
        ? liveOld.map((l) => [l, false])
        : h.oldCount > 0 ? oldLines.map((l) => [l, false]) : [[h.oldStart, true]];
      for (const [line, insertion] of anchors) {
        const key = innermost(rows, line, insertion);
        if (key === undefined) touch.moduleScope = true;
        else fnKeys.add(key);
      }
    }
    touch.functions = [...fnKeys].sort();
  }
  return touches;
}

const SPAWN_IMPORT = /["'](?:node:)?(?:child_process|worker_threads)["']/;
/** A helper spawning repo code rather than only `git`: node, tsx, a shell, a repo path, a worker. */
const CODE_SPAWN = /process\.execPath|["'`](?:node|tsx|bash|sh|npx|npm)["'`]|\bfork\s*\(|\bnew\s+Worker\s*\(|["'`](?:src|scripts|bin)\/[\w./-]+["'`]/;

/** Suites whose own process spawns children: the suite imports child_process or worker_threads,
 *  or reaches (through test/ helpers it imports) a helper that spawns repo code. Their children's
 *  coverage is credited to nobody, so the map cannot speak for them. */
export function spawningSuites(files: ReadonlyMap<string, string>): Set<string> {
  const stripped = new Map<string, string>();
  const text = (f: string) => {
    if (!stripped.has(f)) stripped.set(f, stripComments(files.get(f) ?? ""));
    return stripped.get(f)!;
  };
  const helperSpawns = (f: string) => SPAWN_IMPORT.test(text(f)) && CODE_SPAWN.test(text(f));
  const deps = (f: string) => {
    const out: string[] = [];
    for (const m of text(f).matchAll(/\b(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) {
      const base = new URL(m[1]!, `file:///${f}`).pathname.slice(1);
      const stem = base.replace(/\.(?:js|mjs|cjs)$/, "");
      const hit = [base, `${stem}.ts`, `${stem}.mts`, `${base}.ts`].find((c) => files.has(c));
      if (hit?.startsWith("test/") && !SUITE.test(hit)) out.push(hit);
    }
    return out;
  };
  const out = new Set<string>();
  for (const suite of files.keys()) {
    if (!SUITE.test(suite)) continue;
    if (SPAWN_IMPORT.test(text(suite))) {
      out.add(suite);
      continue;
    }
    const seen = new Set<string>();
    const queue = deps(suite);
    while (queue.length > 0) {
      const f = queue.shift()!;
      if (seen.has(f)) continue;
      seen.add(f);
      if (helperSpawns(f)) {
        out.add(suite);
        break;
      }
      queue.push(...deps(f));
    }
  }
  return out;
}

/** What the arm decides from, beside the selector's own input. */
export interface ImpactArmInput {
  map?: ImpactMap;
  /** Why `map` is absent, when it is. */
  mapProblem?: string;
  /** The `git diff -U0` of the change. */
  diffText: string;
  /** The map's sha against the change's base: commits between them (undefined when the base does
   *  not descend from the map, with `problem` saying so) and the paths changed in between. */
  drift: { distance?: number; changedSinceMap: readonly string[]; problem?: string };
  /** A file's text at the change's base, for inert-line detection. */
  baseText?: (path: string) => string | undefined;
  stalenessBound?: number;
}

/** What the selector already knows when it asks for the arm. */
export interface ImpactArmContext {
  changed: readonly string[];
  files: ReadonlyMap<string, string>;
  /** The floor's suites, the selection every non-map reason below is clipped to. */
  floor: readonly string[];
  pathReaders: readonly string[];
  pathNamers: readonly string[];
  recent: readonly string[];
  /** What the arm becomes on a fallback: the narrow selection when computed, else the floor. */
  fallback: readonly string[];
}

export interface ImpactArm {
  suites: string[];
  /** Set when the arm fell back, naming why. */
  fallback?: string;
  /** Suites selected only because they failed recently. */
  recentOnly: string[];
  reasons: string[];
}

const CODE_PATH = /^(?:src|scripts|bin)\/.*\.(?:ts|mts|mjs|js|cjs)$/;

/** Why the arm cannot speak for this change, or undefined when it can. */
function fallbackReason(input: ImpactArmInput, changed: readonly string[], bound: number): string | undefined {
  const map = input.map;
  if (!map) return `no impact map (${input.mapProblem ?? "none supplied"})`;
  if (input.drift.distance === undefined) {
    return `impact map ${map.sha.slice(0, 12)} is not an ancestor of the base (${input.drift.problem ?? "unknown"})`;
  }
  if (input.drift.distance > bound) {
    return `impact map ${map.sha.slice(0, 12)} is stale: ${input.drift.distance} commits behind the base, past its bound of ${bound}`;
  }
  const nonCode = changed.find((f) => !SUITE.test(f) && !CODE_PATH.test(f));
  if (nonCode !== undefined) return `non-code input ${nonCode} — the read map (W1-T6084) does not exist yet`;
  const since = new Set(input.drift.changedSinceMap);
  const drifted = changed.find((f) => CODE_PATH.test(f) && since.has(f));
  if (drifted !== undefined) return `${drifted} changed after the impact map's sha, so its line positions are not the map's`;
  if (input.diffText.trim() === "" && changed.some((f) => CODE_PATH.test(f))) return "no diff to place the change in the map";
  return undefined;
}

/** THE IMPACT ARM — see the file header. Pure: it decides from its arguments alone. */
export function impactArmSelection(input: ImpactArmInput, ctx: ImpactArmContext): ImpactArm {
  const bound = input.stalenessBound ?? IMPACT_MAP_STALENESS_BOUND;
  const fallback = fallbackReason(input, ctx.changed, bound);
  if (fallback !== undefined) {
    return { suites: [...ctx.fallback].sort(), fallback, recentOnly: [], reasons: [`impact arm fell back: ${fallback}`] };
  }
  const map = input.map!;
  const reasons = new Map<string, string>();
  const pick = (s: string, why: string) => {
    if (SUITE.test(s) && !reasons.has(s)) reasons.set(s, why);
  };
  for (const f of ctx.changed) if (SUITE.test(f)) pick(f, "changed test");
  for (const s of ctx.pathReaders) pick(s, "reads a changed file by path");
  for (const s of ctx.pathNamers) pick(s, "names a changed file by path");
  const touches = impactTouches(input.diffText, map, {
    base: input.baseText ?? (() => undefined),
    head: (p) => ctx.files.get(p),
  });
  for (const t of touches) {
    const file = map.files[t.path];
    if (!file) continue; // loaded by no in-process suite on the map's sha; spawners cover it below
    if (t.moduleScope) for (const i of file.loadedBy) pick(map.suites[i]!, `loads ${t.path} (module-scope edit)`);
    for (const row of file.functions) {
      if (!t.functions.includes(`${row[0]}:${row[1]}`)) continue;
      for (const i of row.slice(2)) pick(map.suites[i]!, `executed ${t.path}:${row[0]}-${row[1]}`);
    }
  }
  const known = new Set(map.suites);
  const spawners = spawningSuites(ctx.files);
  const since = new Set(input.drift.changedSinceMap);
  for (const s of ctx.floor) {
    if (spawners.has(s)) pick(s, "spawns children the map cannot credit; the floor reaches it");
    else if (!known.has(s)) pick(s, "absent from the impact map; the floor reaches it");
    else if (since.has(s)) pick(s, "changed after the impact map's sha; the floor reaches it");
  }
  for (const s of ctx.recent) pick(s, "failed recently");
  const suites = [...reasons.keys()].sort();
  return {
    suites,
    recentOnly: suites.filter((s) => reasons.get(s) === "failed recently"),
    reasons: suites.map((s) => `${s}: ${reasons.get(s)}`),
  };
}

type Run = (cmd: string, args: string[], opts: { cwd: string; encoding: "utf8" }) => { status: number | null; stdout: string; stderr: string };
const defaultRun: Run = (cmd, args, opts) => spawnSync(cmd, args, opts);

/** The map's drift against `base` in `root`: whether the base descends from the map's sha, how
 *  many commits apart, and what changed between. A git failure is a named problem, never a zero. */
export function impactDrift(root: string, mapSha: string, base: string, run: Run = defaultRun): ImpactArmInput["drift"] {
  const git = (args: string[]) => run("git", args, { cwd: root, encoding: "utf8" });
  const anc = git(["merge-base", "--is-ancestor", mapSha, base]);
  if (anc.status === 1) return { changedSinceMap: [], problem: `${base} does not descend from ${mapSha}` };
  if (anc.status !== 0) return { changedSinceMap: [], problem: `git merge-base failed: ${(anc.stderr ?? "").trim().slice(0, 200)}` };
  const count = git(["rev-list", "--count", `${mapSha}..${base}`]);
  const names = git(["diff", "--name-only", mapSha, base]);
  if (count.status !== 0 || names.status !== 0) {
    return { changedSinceMap: [], problem: `git could not measure the drift: ${(count.stderr || names.stderr || "").trim().slice(0, 200)}` };
  }
  return { distance: Number(count.stdout.trim()), changedSinceMap: names.stdout.split("\n").map((l) => l.trim()).filter(Boolean) };
}

/** Everything the arm needs for a checkout: the map at `mapPath`, its drift against `base`, and the
 *  base's texts read through git. */
export function readImpactArmInput(root: string, mapPath: string, base: string, diffText: string, run: Run = defaultRun): ImpactArmInput {
  const { map, problem } = readImpactMap(mapPath);
  const drift = map ? impactDrift(root, map.sha, base, run) : { changedSinceMap: [] };
  const baseText = (path: string) => {
    const r = run("git", ["show", `${base}:${path}`], { cwd: root, encoding: "utf8" });
    return r.status === 0 ? r.stdout : undefined;
  };
  return { ...(map ? { map } : { mapProblem: problem }), diffText, drift, baseText };
}
