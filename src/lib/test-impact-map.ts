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
 *   - a spawned child's report is credited to the suite that spawned it (W1-T6108: the test setup
 *     records the suite beside each child report). A suite whose children run repo code is still
 *     selected whenever the floor reaches it when the map credits it no child report, and so is one
 *     that blanks or redirects NODE_V8_COVERAGE for its children; a suite that only spawns git is
 *     not. So is every suite the map never saw;
 *   - a missing or stale map, a map whose sha the base does not descend from, a changed non-code
 *     input (W1-T6084's read map does not exist yet), or a changed file the map's own sha predates
 *     falls back to the narrow selection and names why.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const IMPACT_MAP_FORMAT = "rmd-test-impact-map-v1";

/** Legacy character-based goal; conservative callers use tokens and refuse ambiguous closes. */
const REGEX_PRECEDERS = "(,=:[!&|?{};+-*%<>~^";
const CONSERVATIVE_REGEX_PRECEDERS = "(,=:[!&|?{;+-*%<>~^/";
const CONTROL_KEYWORDS = /^(?:if|while|for|with|switch|catch)$/;
const REGEX_KEYWORDS = new Set(["return", "throw", "case", "delete", "void", "typeof", "instanceof", "in", "else", "do", "new", "extends", "default", "break", "continue", "debugger"]);

/** W1-T5701 — `content` with every comment blanked, STRING-AWARE: a `//` or `/*` inside a string,
 *  template or regex literal is kept, and so is every string's text (specifiers live in strings).
 *  Without this a JSDoc import link or a backticked test path in prose read as a graph edge, and the
 *  selector's 285-module strongly-connected component was made of comments. A regex literal is
 *  recognised by what precedes its `/`, so a quote inside one cannot open a string; a `'` or `"`
 *  string ends at its line's end, so one misread cannot swallow the rest of the file. With
 *  `keepLines`, a block comment keeps its newlines, so line N of the result is line N of `content`.
 *  (Moved here from affected-suites.ts by W1-T6083, which re-exports it: the impact arm reads it and
 *  the selector reads the arm, so one of them had to own it.) */
export function stripComments(content: string, opts: { keepLines?: boolean; conservative?: boolean } = {}): string {
  return scanSource(content, false, opts.keepLines === true, opts.conservative === true);
}

/** W1-T6089 — `content` (already comment-free) with every string, template and regex BODY blanked to
 *  spaces, delimiters and offsets kept: brackets inside a literal can no longer unbalance a walk. */
export function maskLiterals(content: string, opts: { conservative?: boolean } = {}): string {
  return scanSource(content, true, false, opts.conservative === true);
}

/** `scanSource` walks CODE; a template literal's text is a literal, but each `${...}` substitution inside
 *  it is code again (W1-T6158) — nested strings, templates, comments, regexes and braces are scanned until
 *  the matching `}`, so a backtick inside a substitution cannot close the outer template.
 *  Conservative mode is opt-in: unknown lexical contexts throw into the selector's existing full fallback.
 *  Default output retains the legacy heuristic, including its known regex-context limitations. */
function scanSource(content: string, mask: boolean, keepLines: boolean, conservative: boolean): string {
  const literal = (text: string) => (mask && text.length > 1 ? text[0] + text.slice(1, -1).replace(/[^\n]/g, " ") + text.slice(-1) : text);
  const blank = (text: string) => (mask ? text.replace(/[^\n]/g, " ") : text);
  let out = "";
  let last = "";
  const n = content.length;

  /** Scan a template literal whose opening backtick is at `start`; returns the index after its close. */
  const scanTemplate = (start: number, generator: boolean | undefined): number => {
    out += "`";
    let i = start + 1;
    let text = "";
    const flush = () => {
      out += blank(text);
      text = "";
    };
    while (i < n) {
      const d = content[i]!;
      if (d === "\\") {
        text += content.slice(i, i + 2);
        i += 2;
      } else if (d === "`") {
        flush();
        out += "`";
        return i + 1;
      } else if (d === "$" && content[i + 1] === "{") {
        flush();
        out += "${";
        last = "{";
        i = scanCode(i + 2, true, generator);
        if (i < n) out += "}";
        i += 1;
      } else {
        text += d;
        i += 1;
      }
    }
    flush();
    return n;
  };

  /** Scan code from `from`; with `untilBrace`, stop at the `}` that closes the substitution (not consumed). */
  const scanCode = (from: number, untilBrace: boolean, inheritedGenerator: boolean | undefined): number => {
    let i = from;
    let depth = 0;
    let generator = inheritedGenerator;
    let pendingFunction: boolean | undefined;
    let functionBody: boolean | undefined;
    let returnType: { nesting: string[]; operand: boolean } | undefined;
    let arrowPending = false;
    let lineBreak = false;
    let expressionArrow: number | undefined;
    const parens: { control: boolean | undefined; fn?: boolean }[] = [];
    const scopes: { fn: boolean; generator?: boolean; arrow?: number; object: boolean }[] = [];
    const unknown = () => new Error(`lexical context unknown at line ${content.slice(0, i).split("\n").length} after ${last}`);
    while (i < n) {
      const c = content[i]!;
      const next = content[i + 1];
      if (c === "/" && next === "/") {
        while (i < n && (conservative ? !/[\r\n\u2028\u2029]/.test(content[i]!) : content[i] !== "\n")) i += 1;
        continue;
      }
      if (c === "/" && next === "*") {
        const end = content.indexOf("*/", i + 2);
        const stop = end < 0 ? n : end + 2;
        if (conservative && /[\r\n\u2028\u2029]/.test(content.slice(i, stop))) lineBreak = true;
        out += keepLines ? content.slice(i, stop).replace(/[^\n]/g, "") || " " : " ";
        i = stop;
        continue;
      }
      const afterLineBreak = lineBreak;
      if (conservative) {
        if (c.charCodeAt(0) > 127 || (c === "\r" && next !== "\n")) throw unknown();
        if (content.startsWith("<!--", i) || content.startsWith("-->", i)) throw unknown();
        if (/[\r\n]/.test(c)) lineBreak = true;
        else if (!/\s/.test(c)) lineBreak = false;
      }
      if (conservative && functionBody === true && c === ":" && returnType === undefined) {
        returnType = { nesting: [], operand: true };
        out += c;
        last = c;
        i++;
        continue;
      }
      // A generator's return annotation is type text until a completed type meets the body brace.
      if (returnType && c !== '"' && c !== "'" && c !== "`") {
        if (c === "{" && returnType.nesting.length === 0 && !returnType.operand) {
          returnType = undefined;
        } else {
          if (c === "/") throw unknown();
          if (/[A-Za-z_$]/.test(c)) {
            let end = i + 1;
            while (end < n && /[\w$]/.test(content[end]!)) end++;
            const word = content.slice(i, end);
            returnType.operand = /^(?:extends|keyof|typeof|infer|readonly|new|is|asserts)$/.test(word);
            out += word;
            last = word;
            i = end;
            continue;
          }
          if (c === "=" && next === ">") {
            returnType.operand = true;
            out += "=>";
            last = "=>";
            i += 2;
            continue;
          }
          if ("(<[{".includes(c)) {
            returnType.nesting.push(c);
            returnType.operand = true;
          } else if (")>]}".includes(c)) {
            if (returnType.nesting.pop() !== { ")": "(", ">": "<", "]": "[", "}": "{" }[c]) throw unknown();
            returnType.operand = false;
          } else if (!/\s/.test(c)) {
            returnType.operand = "|&?:,.".includes(c);
          }
          out += c;
          if (!/\s/.test(c)) last = c;
          i++;
          continue;
        }
      }
      if (conservative && arrowPending && !/\s/.test(c) && c !== "{") {
        expressionArrow = parens.length;
        arrowPending = false;
      }
      if (conservative && /[A-Za-z_$]/.test(c)) {
        let end = i + 1;
        while (end < n && /[\w$]/.test(content[end]!)) end++;
        const word = content.slice(i, end), property = last === "." || last === "#";
        if (!property && ((last === "*" && (word === "function" || CONTROL_KEYWORDS.test(word))) ||
            (generator === true && scopes.at(-1)?.object && CONTROL_KEYWORDS.test(word)))) throw unknown();
        if (!property && word === "function") pendingFunction = false;
        out += word;
        last = property ? `.${word}` : word;
        i = end;
        continue;
      }
      if (c === "`") {
        i = scanTemplate(i, generator);
        if (returnType) returnType.operand = false;
        last = "`";
        continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < n && content[j] !== c) {
          if (content[j] === "\\") j += 1;
          else if (content[j] === "\n") break;
          j += 1;
        }
        out += literal(content.slice(i, j + 1));
        if (returnType) returnType.operand = false;
        i = j + 1;
        last = c;
        continue;
      }
      if (conservative && c === "/" && (last === "}" || last === "await" || last === "of" || last === "unknown)" ||
          (last === "yield" && (generator === undefined || expressionArrow !== undefined)))) throw unknown();
      if (c === "/" && (last === "" || (conservative ? CONSERVATIVE_REGEX_PRECEDERS : REGEX_PRECEDERS).includes(last) ||
          (conservative && (REGEX_KEYWORDS.has(last) || last === "control)" || last === "=>" || (last === "yield" && generator === true))))) {
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
        if (conservative && (j >= n || content[j] !== "/" || inClass)) throw unknown();
        out += literal(content.slice(i, j + 1));
        i = j + 1;
        last = conservative ? "literal" : "/";
        continue;
      }
      if (conservative && c === "!" && next !== "=" && !REGEX_KEYWORDS.has(last) && last !== "await" &&
          !(last === "yield" && generator !== false) && (last === ")" || last === "]" || /^[\w$."'`]/.test(last))) {
        if (afterLineBreak) throw unknown();
        out += c;
        last = "postfix!";
        i++;
        continue;
      }
      if (conservative && (c === "+" || c === "-") && next === c) {
        out += c + c;
        last = c + c;
        i += 2;
        continue;
      }
      if (conservative && c === "*" && pendingFunction !== undefined) pendingFunction = true;
      if (conservative && c === "(") {
        parens.push({ control: last === "await" ? undefined : CONTROL_KEYWORDS.test(last), fn: pendingFunction });
        pendingFunction = undefined;
      } else if (conservative && c === ")") {
        const frame = parens.pop();
        if (frame?.fn !== undefined) functionBody = frame.fn;
        if (expressionArrow !== undefined && parens.length < expressionArrow) expressionArrow = undefined;
        out += c;
        last = frame?.control === undefined ? "unknown)" : frame.control ? "control)" : ")";
        i++;
        continue;
      } else if (conservative && c === "{") {
        const body = arrowPending ? false : functionBody !== undefined && !/^(?::|<|\||&|\?|=)$/.test(last)
          ? functionBody : last === ")" ? undefined : null;
        const fn = body !== null;
        scopes.push({ fn, generator, arrow: expressionArrow,
          object: body === null && (/^(?:return|yield)$/.test(last) || (CONSERVATIVE_REGEX_PRECEDERS.includes(last) && last !== "{" && last !== ";")) });
        if (body !== null) {
          generator = body;
          expressionArrow = undefined;
          functionBody = undefined;
        }
        arrowPending = false;
      } else if (conservative && c === "}") {
        if (untilBrace && scopes.length === 0) return i;
        const frame = scopes.pop();
        if (frame?.fn) {
          generator = frame.generator;
          expressionArrow = frame.arrow;
        }
      } else if (conservative && c === "=" && next === ">") {
        out += "=>";
        last = "=>";
        arrowPending = true;
        i += 2;
        continue;
      }
      if (conservative && (c === ";" || c === ",") && expressionArrow !== undefined && parens.length <= expressionArrow) expressionArrow = undefined;
      if (!conservative && untilBrace) {
        if (c === "{") depth += 1;
        else if (c === "}") {
          if (depth === 0) return i;
          depth -= 1;
        }
      }
      out += c;
      if (!/\s/.test(c)) last = c;
      i += 1;
    }
    if (returnType) throw unknown();
    return n;
  };

  scanCode(0, false, false);
  return out;
}


/** Commits the base may be past the map's sha before the arm stops trusting it. MEASURED 2026-09-30..
 *  10-13: main lands 149–272 first-parent commits a day, so 150 silenced the arm for the last hours of
 *  11 of 13 days and for every day after a missed nightly. 500 covers two days at the busiest rate.
 *  A changed file that moved since the map still falls back on its own; the shadow record carries
 *  the distance so the miss rate by distance can set this. PRIMARY CONTROL: it alone decides when the
 *  arm stops speaking. */
export const IMPACT_MAP_STALENESS_BOUND = 500;

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
  /** Process reports that named no suite — credited to nobody. */
  orphanReports: number;
  /** W1-T6108: suite indices credited with at least one spawned child's report. Absent from a map
   *  built before children were attributed, which then credits no suite's children. */
  spawnCredited?: number[];
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
  /** W1-T6108: the report is a child's that `test` spawned, not `test`'s own process. */
  child?: boolean;
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

/** One source map, placed: its segments as generated offsets in ascending order beside their
 *  original lines, and every span already asked of it. Placed ONCE per map, not per report: on the
 *  2026-10-14 nightly the per-report rescan cost ~0.7s a report over ~3,400 reports and timed the
 *  merge job out before the floor ratchet ran (run 38514060349). */
interface PlacedMap {
  at: Int32Array;
  orig: Int32Array;
  spans: Map<string, [number, number] | undefined>;
}

function placeMap(lineLengths: readonly number[], mappings: string): PlacedMap {
  const starts = lineStarts(lineLengths);
  const decoded = decodeMappings(mappings);
  const pairs: Array<[number, number]> = [];
  for (let line = 0; line < starts.length && line < decoded.length; line += 1) {
    for (const [col, orig] of decoded[line]!) pairs.push([starts[line]! + col, orig]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  return { at: Int32Array.from(pairs, (p) => p[0]), orig: Int32Array.from(pairs, (p) => p[1]), spans: new Map() };
}

/** The 1-based original line span of the generated range `[start, end)`: the min and max original
 *  line of every mapping segment INSIDE it. A function with no segment of its own — a bundler
 *  helper, a synthesized export getter — maps to nothing and is left out, so it can never claim a
 *  module-scope line as its body. */
function mappedSpan(start: number, end: number, map: PlacedMap, counts?: ImpactMapCounts): [number, number] | undefined {
  const key = `${start}:${end}`;
  if (map.spans.has(key)) return map.spans.get(key);
  if (counts) counts.placed += 1;
  let i = 0;
  let j = map.at.length;
  while (i < j) {
    const mid = (i + j) >> 1;
    if (map.at[mid]! < start) i = mid + 1;
    else j = mid;
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (; i < map.at.length && map.at[i]! < end; i += 1) {
    lo = Math.min(lo, map.orig[i]!);
    hi = Math.max(hi, map.orig[i]!);
  }
  const span: [number, number] | undefined = lo === Infinity ? undefined : [lo + 1, hi + 1];
  map.spans.set(key, span);
  return span;
}

/** What the builder did: `placed` counts spans computed, `maps` source maps placed. */
export interface ImpactMapCounts {
  placed: number;
  maps: number;
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
  opts: { sha: string; root: string; readSource?: (path: string) => string | undefined; counts?: ImpactMapCounts },
): ImpactMap {
  const rootUrl = opts.root.startsWith("file:") ? (opts.root.endsWith("/") ? opts.root : `${opts.root}/`) : new URL(`file://${opts.root.replace(/\/?$/, "/")}`).href;
  const loaded = new Map<string, Set<string>>();
  const fns = new Map<string, Map<string, Set<string>>>();
  const suites = new Set<string>();
  const credited = new Set<string>();
  let orphans = 0;
  // A compact shard hands every report the SAME source-map object; a raw report its own copy, so
  // a miss on the object falls back to the url's maps compared by content.
  const placedByObject = new WeakMap<object, PlacedMap>();
  const placedByUrl = new Map<string, Array<{ lineLengths: readonly number[]; mappings: string; placed: PlacedMap }>>();
  const placedFor = (url: string, cached: { lineLengths: number[]; data: { mappings: string } }): PlacedMap => {
    const known = placedByObject.get(cached);
    if (known) return known;
    const { lineLengths, data: { mappings } } = cached;
    const seen = placedByUrl.get(url) ?? [];
    let placed = seen.find((m) => m.mappings === mappings && m.lineLengths.length === lineLengths.length &&
      m.lineLengths.every((len, i) => len === lineLengths[i]))?.placed;
    if (!placed) {
      placed = placeMap(lineLengths, mappings);
      if (opts.counts) opts.counts.maps += 1;
      seen.push({ lineLengths, mappings, placed });
      placedByUrl.set(url, seen);
    }
    placedByObject.set(cached, placed);
    return placed;
  };
  for (const report of reports) {
    const suite = reportSuite(report, rootUrl);
    if (suite === undefined) {
      orphans += 1;
      continue;
    }
    suites.add(suite);
    if (report.child === true) credited.add(suite);
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
        const map = placedFor(script.url, cached as { lineLengths: number[]; data: { mappings: string } });
        place = (s, e) => mappedSpan(s, e, map, opts.counts);
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
  return { format: IMPACT_MAP_FORMAT, sha: opts.sha, suites: order, orphanReports: orphans, spawnCredited: ids(credited), files };
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
/** A spawn of repo code rather than only `git`: node, tsx, a shell, a repo path, a worker. */
const CODE_SPAWN = /process\.execPath|["'`](?:node|tsx|bash|sh|npx|npm)["'`]|\bfork\s*\(|\bnew\s+Worker\s*\(|["'`](?:src|scripts|bin)\/[\w./-]+["'`]/;
/** A child env that sets NODE_V8_COVERAGE — blanked (the coverage-session-blanking census) or pointed
 *  elsewhere — so the child's report never reaches the map under the suite that spawned it. */
const COVERAGE_ENV = /\bNODE_V8_COVERAGE\s*[:=](?!=)/;

/** The suites `test` reaches whose own text, or a test/ helper they import, matches `matches`. */
function suitesReaching(files: ReadonlyMap<string, string>, matches: (text: string) => boolean): Set<string> {
  const stripped = new Map<string, string>();
  const text = (f: string) => {
    if (!stripped.has(f)) stripped.set(f, stripComments(files.get(f) ?? ""));
    return stripped.get(f)!;
  };
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
    const seen = new Set<string>();
    const queue = [suite];
    while (queue.length > 0) {
      const f = queue.shift()!;
      if (seen.has(f)) continue;
      seen.add(f);
      if (matches(text(f))) {
        out.add(suite);
        break;
      }
      queue.push(...deps(f));
    }
  }
  return out;
}

/** Suites whose children run repo code: the suite, or a test/ helper it imports, imports
 *  child_process or worker_threads AND spawns node, tsx, a shell, a repo path or a worker. A suite
 *  that only shells `git` is not one (W1-T6108). */
export function spawningSuites(files: ReadonlyMap<string, string>): Set<string> {
  return suitesReaching(files, (t) => SPAWN_IMPORT.test(t) && CODE_SPAWN.test(t));
}

/** Suites whose children's coverage the map cannot credit whatever it was built from: the suite or
 *  a helper it imports sets NODE_V8_COVERAGE in a child env (blanked for a nested runner, or a raw
 *  directory of its own). */
export function uncreditableSpawners(files: ReadonlyMap<string, string>): Set<string> {
  return suitesReaching(files, (t) => SPAWN_IMPORT.test(t) && COVERAGE_ENV.test(t));
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
  const spawners = spawningSuites(ctx.files);
  const unloaded: string[] = [];
  for (const t of touches) {
    const file = map.files[t.path];
    if (!file) {
      unloaded.push(t.path); // loaded by no process on the map's sha; the floor's spawners cover it below
      continue;
    }
    if (t.moduleScope) for (const i of file.loadedBy) pick(map.suites[i]!, `loads ${t.path} (module-scope edit)`);
    for (const row of file.functions) {
      if (!t.functions.includes(`${row[0]}:${row[1]}`)) continue;
      for (const i of row.slice(2)) pick(map.suites[i]!, `executed ${t.path}:${row[0]}-${row[1]}`);
    }
  }
  const known = new Set(map.suites);
  const uncreditable = uncreditableSpawners(ctx.files);
  const credited = map.spawnCredited === undefined ? undefined : new Set(map.spawnCredited.map((i) => map.suites[i]));
  const since = new Set(input.drift.changedSinceMap);
  for (const s of ctx.floor) {
    if (uncreditable.has(s)) pick(s, "sets NODE_V8_COVERAGE for its children, so the map cannot credit them; the floor reaches it");
    else if (spawners.has(s) && credited === undefined) pick(s, "spawns children the map cannot credit (it predates child attribution); the floor reaches it");
    else if (spawners.has(s) && !credited!.has(s)) pick(s, "spawns repo code but the map credits it no child report; the floor reaches it");
    else if (spawners.has(s) && unloaded.length > 0) pick(s, `spawns repo code and ${unloaded[0]} is loaded by no process on the map's sha; the floor reaches it`);
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
