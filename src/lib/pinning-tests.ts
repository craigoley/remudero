/**
 * W1-T14230 — A FILING NAMES THE TESTS THAT MAY PIN WHAT IT CHANGES.
 *
 * On 2026-11-21 all four hand builds needed a plan-only scope amendment before their code could ship:
 * an existing test outside the task's files: asserted the old behaviour, and the acceptance-author gate
 * refuses a change to a path outside files: (canonical-task-scope-exceeded). This advisory lists, at
 * filing time, the existing tests that import a src module the task declares AND name a word its
 * title, design or rationale uses, so the filer can add them to files: before the build.
 *
 * W1-T14512: the advisory also reads the nightly test impact map and lists the tests that ran a function the
 * design names, and warns when no design symbol is in the declared files.
 *
 * INVARIANT pinning-tests-never-blocks: every violation here has severity warn.
 * INVARIANT token-arm-unchanged: without a usable map the listed tests and their order are as before.
 * INVARIANT pinning-tests-bounded: the check stops at its time budget and says so.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { buildAffectedSuitesGraph, stripComments } from "./affected-suites.js";
import type { Clock } from "./clock.js";
import type { Task } from "./plan.js";
import type { LintViolation } from "./task-linter.js";
import { IMPACT_MAP_STALENESS_BOUND, impactDrift, readImpactMap } from "./test-impact-map.js";
import { hostWorktreeGit } from "./worktree-git.js";

export const PINNING_TESTS_BUDGET_MS = 10_000;
/** The message names at most this many tests; the stderr event lists every one. */
export const PINNING_TESTS_NAMED = 10;
/** The message names at most this many tests when the impact map was read. */
export const PINNING_TESTS_NAMED_WITH_MAP = 25;
/** The impact map's path under the code root's git common dir. */
export const PINNING_IMPACT_MAP_FILE = "rmd/test-impact-map.json";
const EVENT_LISTED = 200;
const ELSEWHERE_NAMED = 5;

export interface PinningTestInput {
  /** path -> text of each test file the reader's prefilter found. */
  tests: ReadonlyMap<string, string>;
  srcText: (path: string) => string | undefined;
  aliasRoot: string;
  clock: Clock;
  /** When the clock started; the reader's time counts against the budget. Defaults to the first reading. */
  startedAt?: number;
  /** What the impact map arm found; absent, only the token arm runs. */
  impact?: PinningImpact;
}

export interface PinningTestListing { path: string; tokens: string[]; score: number; arms: Array<"token" | "impact">; ran: string[] }

/** One suite the map says ran a design symbol; each symbol that N suites ran adds 1/N. */
export interface PinningImpactListing { path: string; ran: string[]; score: number }

export type PinningImpact =
  | { outcome: "ran"; sha: string; distance: number; symbols: string[]; listed: PinningImpactListing[] }
  | { outcome: "no-map"; path: string }
  | { outcome: "unusable"; path: string; reason: string; sha?: string };

/** A design symbol declared only outside the task's declared src files. */
export interface PinningElsewhere { symbol: string; file: string }

export type PinningTestCandidates =
  | { outcome: "ran"; modules: string[]; listed: PinningTestListing[]; tokens: string[]; ms: number;
    impact?: PinningImpact; elsewhere?: PinningElsewhere[] }
  | { outcome: "over_budget"; budgetMs: number; ms: number }
  | { outcome: "unreadable"; reason: string };

type PinningTask = Pick<Task, "id" | "type" | "title" | "files" | "design" | "rationale" | "note">;
type OverBudget = Extract<PinningTestCandidates, { outcome: "over_budget" }>;

const WORD = /[A-Za-z_$][\w$]*/g;
const QUOTED = /"([^"\n]{8,80})"/g;
/** A quoted path names a module, not what changes in it: every importer names it, and the import edge covers it. */
const BARE_PATH = /^[\w.@-]+(?:\/[\w.@-]+)+$/;
const isCamel = (w: string): boolean => /^[A-Za-z][A-Za-z0-9]*$/.test(w) && /[a-z]/.test(w) && /^.+[A-Z]/.test(w);
const isUpperSnake = (w: string): boolean => /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(w);
const WORD_CHAR = /[\w$]/;

/** True when `text` holds `token` with no word character joined to either word-character edge. */
function namesToken(text: string, token: string): boolean {
  const checkStart = WORD_CHAR.test(token[0]!);
  const checkEnd = WORD_CHAR.test(token[token.length - 1]!);
  for (let at = text.indexOf(token); at >= 0; at = text.indexOf(token, at + 1)) {
    if (checkStart && at > 0 && WORD_CHAR.test(text[at - 1]!)) continue;
    const after = at + token.length;
    if (checkEnd && after < text.length && WORD_CHAR.test(text[after]!)) continue;
    return true;
  }
  return false;
}

/** The task's files: under src/. The reader and the check both start from this list. */
export function declaredSrcPaths(task: Pick<Task, "files">): string[] {
  return [...new Set((task.files ?? []).filter((f) => f.startsWith("src/")))].sort();
}

/** The task's words a declared module also holds: camelCase / PascalCase / UPPER_SNAKE words of 6 or more
 *  characters from title, design and rationale, and the design's double-quoted strings of 8-80 characters that are
 *  not a bare path. */
function taskWords(task: PinningTask): string[] {
  const words = new Set<string>();
  for (const text of [task.title, task.design ?? "", task.rationale ?? ""]) {
    for (const m of text.matchAll(WORD)) if (m[0].length >= 6 && (isCamel(m[0]) || isUpperSnake(m[0]))) words.add(m[0]);
  }
  return [...words];
}

function keptTokens(task: PinningTask, moduleTexts: readonly string[]): string[] {
  const words = new Set(taskWords(task));
  for (const m of (task.design ?? "").matchAll(QUOTED)) if (!BARE_PATH.test(m[1]!)) words.add(m[1]!);
  return [...words].filter((w) => moduleTexts.some((t) => t.includes(w))).sort();
}

/** The tests that import a declared module directly and name a kept token, scored and sorted. Pure over `input`. */
export function pinningTestCandidates(task: PinningTask, input: PinningTestInput): PinningTestCandidates {
  const budgetMs = PINNING_TESTS_BUDGET_MS;
  const startedAt = input.startedAt ?? input.clock.now();
  const elapsed = (): number => input.clock.now() - startedAt;
  const over = (): PinningTestCandidates | undefined => {
    const ms = elapsed();
    return ms > budgetMs ? { outcome: "over_budget", budgetMs, ms } : undefined;
  };
  const early = over();
  if (early) return early;
  const modules: string[] = [];
  const moduleTexts: string[] = [];
  for (const path of declaredSrcPaths(task)) {
    const text = input.srcText(path);
    if (text === undefined) continue;
    modules.push(path);
    moduleTexts.push(stripComments(text));
  }
  const tokens = keptTokens(task, moduleTexts);
  const impact = input.impact;
  const done = (tokenListed: PinningTestListing[]): PinningTestCandidates => ({
    outcome: "ran", modules, listed: mergeArms(tokenListed, impact?.outcome === "ran" ? impact.listed : []), tokens,
    ms: elapsed(), ...(impact ? { impact } : {}),
  });
  if (modules.length === 0 || tokens.length === 0) return done([]);
  const declared = new Set(task.files ?? []);
  const named = `${task.design ?? ""}\n${task.note ?? ""}`;
  // Match the tokens first, on each test's comment-free text: only a test that names one needs a graph node.
  const hitsByPath = new Map<string, string[]>();
  for (const [path, text] of input.tests) {
    if (declared.has(path) || named.includes(path) || !tokens.some((t) => text.includes(t))) continue;
    const bare = stripComments(text);
    const hits = tokens.filter((t) => namesToken(bare, t));
    if (hits.length > 0) hitsByPath.set(path, hits);
  }
  const pool = new Map([...hitsByPath.keys()].map((path) => [path, input.tests.get(path)!]));
  const graph = buildAffectedSuitesGraph(pool, modules, { root: input.aliasRoot });
  const late = over();
  if (late) return late;
  const matched = new Map([...hitsByPath].filter(([path]) => {
    const deps = graph.dependencies.get(path);
    return deps !== undefined && modules.some((m) => deps.has(m));
  }));
  const namedBy = new Map<string, number>();
  for (const hits of matched.values()) for (const t of hits) namedBy.set(t, (namedBy.get(t) ?? 0) + 1);
  return done([...matched].map(([path, hits]) => ({
    path, tokens: hits, score: hits.reduce((sum, t) => sum + 1 / namedBy.get(t)!, 0), arms: ["token"], ran: [],
  })));
}

const byScore = (a: { score: number; path: string }, b: { score: number; path: string }): number =>
  b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

function mergeArms(tokenListed: PinningTestListing[], impactListed: readonly PinningImpactListing[]): PinningTestListing[] {
  const byPath = new Map(tokenListed.map((l) => [l.path, l]));
  for (const l of impactListed) {
    const t = byPath.get(l.path);
    byPath.set(l.path, t ? { ...t, score: t.score + l.score, arms: ["token", "impact"], ran: l.ran }
      : { path: l.path, tokens: [], score: l.score, arms: ["impact"], ran: l.ran });
  }
  return [...byPath.values()].sort(byScore);
}

/** The design words a declaration can name: the token words, but a PascalCase word only at 8 or more characters. */
function designSymbols(task: PinningTask): string[] {
  return taskWords(task).filter((w) => isUpperSnake(w) || /^[a-z]/.test(w) || w.length >= 8).sort();
}

interface Declaration { symbol: string; path: string; line: number }

/** One git grep -o over src/ (at `rev`, or the working tree) for a function, class, const, let, var or method
 *  declaration of each symbol. */
function declarationsOf(codeRoot: string, symbols: readonly string[], rev?: string): Declaration[] {
  if (symbols.length === 0) return [];
  const alt = symbols.join("|");
  const patterns = [
    `(function[[:space:]]*\\*?|class|const|let|var)[[:space:]]+(${alt})([^[:alnum:]_$]|$)`,
    `^[[:space:]]*((public|private|protected|static|async|readonly|override|get|set)[[:space:]]+)*\\*?(${alt})` +
      "[[:space:]]*(<.*>)?\\(([^=]|=[^>])*\\{[[:space:]]*$",
  ];
  let out = "";
  try {
    out = hostWorktreeGit(codeRoot, ["grep", "-n", "-o", "-I", "-E", ...patterns.flatMap((p) => ["-e", p]),
      ...(rev ? [rev] : []), "--", "src/"], { maxBuffer: 1 << 26 });
  } catch (error) {
    if ((error as { status?: unknown }).status !== 1) throw error; // exit 1 is git grep's "no match"
  }
  const name = new RegExp(`(?<![\\w$])(${alt})(?![\\w$])`);
  const seen = new Set<string>();
  const found: Declaration[] = [];
  for (const raw of out.split("\n")) {
    const m = /^(.+?):(\d+):(.*)$/.exec(rev && raw.startsWith(`${rev}:`) ? raw.slice(rev.length + 1) : raw);
    const symbol = m ? name.exec(m[3]!)?.[1] : undefined;
    if (!m || !symbol || seen.has(`${symbol}:${m[1]}:${m[2]}`)) continue;
    seen.add(`${symbol}:${m[1]}:${m[2]}`);
    found.push({ symbol, path: m[1]!, line: Number(m[2]) });
  }
  return found;
}

/** The map arm: the suites that ran a function the design names, read from the map at `mapPath`. No file is
 *  no-map; a bad map, a HEAD that does not descend from its sha, or one past the staleness bound is unusable. */
export function impactArmPinningTests(
  task: PinningTask, input: { codeRoot: string; mapPath: string; over: () => OverBudget | undefined },
): PinningImpact | OverBudget {
  const { codeRoot, mapPath } = input;
  if (!existsSync(mapPath)) return { outcome: "no-map", path: mapPath };
  const { map, problem } = readImpactMap(mapPath);
  const afterRead = input.over();
  if (afterRead) return afterRead;
  if (!map) return { outcome: "unusable", path: mapPath, reason: problem ?? "the map could not be read" };
  const drift = impactDrift(codeRoot, map.sha, "HEAD");
  const reason = drift.problem ?? (drift.distance === undefined ? "no distance from HEAD"
    : drift.distance > IMPACT_MAP_STALENESS_BOUND
      ? `HEAD is ${drift.distance} commits past the map, over the bound of ${IMPACT_MAP_STALENESS_BOUND}` : undefined);
  if (reason !== undefined) return { outcome: "unusable", path: mapPath, reason, sha: map.sha };
  const decls = declarationsOf(codeRoot, designSymbols(task), map.sha);
  const afterSearch = input.over();
  if (afterSearch) return afterSearch;
  const ranBy = new Map<string, Set<number>>();
  for (const d of decls) {
    let inner: number[] | undefined;
    for (const row of map.files[d.path]?.functions ?? []) {
      if (row[0]! <= d.line && d.line <= row[1]! && (!inner || row[1]! - row[0]! < inner[1]! - inner[0]!)) inner = row;
    }
    if (!inner) continue;
    const ids = ranBy.get(d.symbol) ?? new Set<number>();
    for (const i of inner.slice(2)) ids.add(i);
    ranBy.set(d.symbol, ids);
  }
  const declared = new Set(task.files ?? []);
  const named = `${task.design ?? ""}\n${task.note ?? ""}`;
  const byPath = new Map<string, PinningImpactListing>();
  for (const [symbol, ids] of [...ranBy].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    for (const i of ids) {
      const path = map.suites[i];
      if (path === undefined || declared.has(path) || named.includes(path) || !existsSync(join(codeRoot, path))) continue;
      const l = byPath.get(path) ?? { path, ran: [], score: 0 };
      l.ran.push(symbol);
      l.score += 1 / ids.size;
      byPath.set(path, l);
    }
  }
  const symbols = [...new Set(decls.map((d) => d.symbol))].sort();
  return { outcome: "ran", sha: map.sha, distance: drift.distance!, symbols, listed: [...byPath.values()].sort(byScore) };
}

/** The design symbols declared in src/ at the code root, when none is declared in a declared src file. */
function movedCode(task: PinningTask, codeRoot: string): PinningElsewhere[] {
  const src = declaredSrcPaths(task);
  if (src.length === 0) return [];
  const decls = declarationsOf(codeRoot, designSymbols(task));
  if (decls.length === 0 || decls.some((d) => src.includes(d.path))) return [];
  const first = new Map<string, string>();
  for (const d of [...decls].sort((a, b) => (a.symbol + a.path < b.symbol + b.path ? -1 : 1))) {
    if (!first.has(d.symbol)) first.set(d.symbol, d.path);
  }
  return [...first].slice(0, ELSEWHERE_NAMED).map(([symbol, file]) => ({ symbol, file }));
}

/** The advisory: one warn naming at most 10 listed tests (25 with the map), one warn when the code may have moved,
 *  or one warn that the check ran out of time. */
export function pinningTestViolations(task: Pick<Task, "id">, candidates: PinningTestCandidates): LintViolation[] {
  if (candidates.outcome === "over_budget") {
    return [{ check: "pinning-tests", severity: "warn",
      message: `pinning-tests did not run: over its ${candidates.budgetMs} ms budget after ${candidates.ms} ms` }];
  }
  if (candidates.outcome !== "ran") return [];
  const out: LintViolation[] = [];
  const withMap = candidates.impact?.outcome === "ran";
  const why = (l: PinningTestListing): string =>
    [l.tokens.join(", "), l.ran.length > 0 ? `ran ${l.ran.join(", ")}` : ""].filter(Boolean).join("; ");
  const shown = candidates.listed.slice(0, withMap ? PINNING_TESTS_NAMED_WITH_MAP : PINNING_TESTS_NAMED)
    .map((l) => `${l.path} (${why(l)})`);
  const more = candidates.listed.length - shown.length;
  const noMap = candidates.impact?.outcome === "no-map" ? ` No impact map was read; put the test-impact-map artifact ` +
    `of a coverage-nightly run at ${candidates.impact.path} to also list the tests that run the changed code.` : "";
  if (shown.length > 0) out.push({
    check: "pinning-tests",
    severity: "warn",
    message: `task ${task.id}${candidates.modules.length > 0 ? ` declares ${candidates.modules.join(", ")}` : ""}. ` +
      `These existing tests import it and name what its design changes${withMap ? ", or ran a function its design names" : ""}: ` +
      `${shown.join("; ")}${more > 0 ? ` and ${more} more` : ""}. They may pin the old behaviour. ` +
      "A build that changes a test outside files: is refused by the acceptance-author gate " +
      "(canonical-task-scope-exceeded) until a scope amendment merges. This is ADVISORY, never blocking, because a " +
      "test can name a symbol without pinning the changed behaviour. TO CLEAR IT: add each test that pins the old " +
      "behaviour to files:, or name its path in design or note and say why it does not change. " +
      `Copy this list into the filing PR body.${noMap}`,
  });
  if (candidates.elsewhere && candidates.elsewhere.length > 0) out.push({
    check: "pinning-tests",
    severity: "warn",
    message: `task ${task.id} names ${candidates.elsewhere.map((e) => `${e.symbol} (declared in ${e.file})`).join(", ")}, ` +
      "but none of its declared src files declares a symbol its design names. The code may have moved: check files:.",
  });
  return out;
}

/** Whether the --base pass checks this task: an implement task that is new, or whose files:, design or
 *  rationale changed since the base. */
export function pinningTestsApply(task: PinningTask, baseTask: PinningTask | undefined): boolean {
  if (task.type !== "implement") return false;
  if (baseTask === undefined) return true;
  return JSON.stringify(task.files ?? []) !== JSON.stringify(baseTask.files ?? []) ||
    (task.design ?? "") !== (baseTask.design ?? "") || (task.rationale ?? "") !== (baseTask.rationale ?? "");
}

/** The prefilter: one `git grep -l -F` for "<parent dir>/<stem>" of each declared module that exists, over the
 *  test files only, then a read of the files it names. It never reads every test file. */
export function readPinningTestInput(codeRoot: string, declaredModules: readonly string[]): Pick<PinningTestInput, "tests" | "srcText" | "aliasRoot"> {
  const srcText = (path: string): string | undefined => {
    const abs = join(codeRoot, path);
    return existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
  };
  const patterns = declaredModules.filter((m) => existsSync(join(codeRoot, m)))
    .map((m) => `${basename(dirname(m))}/${basename(m).replace(/\.[^.]+$/, "")}`);
  const tests = new Map<string, string>();
  if (patterns.length === 0) return { tests, srcText, aliasRoot: codeRoot };
  let listing = "";
  try {
    listing = hostWorktreeGit(codeRoot, ["grep", "-l", "-F", ...patterns.flatMap((p) => ["-e", p]), "--",
      ":(glob)test/**/*.test.ts"], { maxBuffer: 1 << 26 });
  } catch (error) {
    if ((error as { status?: unknown }).status !== 1) throw error; // exit 1 is git grep's "no match"
  }
  for (const path of listing.split("\n").filter(Boolean)) tests.set(path, readFileSync(join(codeRoot, path), "utf8"));
  return { tests, srcText, aliasRoot: codeRoot };
}

/** The --base pass's one call: read, list, and write one lint_plan.pinning_tests line on stderr (also when nothing
 *  is listed, so the event counts every checked task). A read failure is outcome unreadable and lists nothing. */
export function runPinningTests(task: PinningTask, codeRoot: string, clock: Clock): PinningTestCandidates {
  const startedAt = clock.now();
  const over = (): OverBudget | undefined => {
    const ms = clock.now() - startedAt;
    return ms > PINNING_TESTS_BUDGET_MS ? { outcome: "over_budget", budgetMs: PINNING_TESTS_BUDGET_MS, ms } : undefined;
  };
  let result: PinningTestCandidates;
  try {
    const commonDir = resolve(codeRoot, hostWorktreeGit(codeRoot, ["rev-parse", "--git-common-dir"]).trim());
    const impact = impactArmPinningTests(task, { codeRoot, mapPath: join(commonDir, PINNING_IMPACT_MAP_FILE), over });
    if (impact.outcome === "over_budget") result = impact;
    else {
      const elsewhere = movedCode(task, codeRoot);
      const read = over() ?? readPinningTestInput(codeRoot, declaredSrcPaths(task));
      result = "outcome" in read ? read : pinningTestCandidates(task, { ...read, clock, startedAt, impact });
      if (result.outcome === "ran" && elsewhere.length > 0) result = { ...result, elsewhere };
    }
  } catch (error) {
    result = { outcome: "unreadable", reason: String((error as Error)?.message ?? error) };
  }
  const impactEvent = (i: PinningImpact | undefined) => i === undefined ? {} : {
    impact: i.outcome === "ran" ? { outcome: i.outcome, sha: i.sha, distance: i.distance, symbols: i.symbols }
      : i.outcome === "no-map" ? { outcome: i.outcome, path: i.path } : { outcome: i.outcome, sha: i.sha, reason: i.reason },
  };
  const event = result.outcome === "ran"
    ? { listed: result.listed.slice(0, EVENT_LISTED).map((l) => l.path), listedCount: result.listed.length,
      tokens: result.tokens, ms: result.ms, ...impactEvent(result.impact),
      ...(result.elsewhere ? { elsewhere: result.elsewhere } : {}) }
    : result.outcome === "over_budget" ? { ms: result.ms } : { reason: result.reason };
  console.error(JSON.stringify({ event: "lint_plan.pinning_tests", task: task.id, outcome: result.outcome, ...event }));
  return result;
}
