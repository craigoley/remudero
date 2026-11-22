/**
 * W1-T14230 — A FILING NAMES THE TESTS THAT MAY PIN WHAT IT CHANGES.
 *
 * On 2026-11-21 all four hand builds needed a plan-only scope amendment before their code could ship:
 * an existing test outside the task's files: asserted the old behaviour, and the acceptance-author gate
 * refuses a change to a path outside files: (canonical-task-scope-exceeded). This advisory lists, at
 * filing time, the existing tests that import a src module the task declares AND name a word its
 * title, design or rationale uses, so the filer can add them to files: before the build.
 *
 * INVARIANT pinning-tests-never-blocks: every violation here has severity warn.
 * INVARIANT pinning-tests-bounded: the check stops at its time budget and says so.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { buildAffectedSuitesGraph, stripComments } from "./affected-suites.js";
import type { Clock } from "./clock.js";
import type { Task } from "./plan.js";
import type { LintViolation } from "./task-linter.js";
import { hostWorktreeGit } from "./worktree-git.js";

export const PINNING_TESTS_BUDGET_MS = 10_000;
/** The message names at most this many tests; the stderr event lists every one. */
export const PINNING_TESTS_NAMED = 10;

export interface PinningTestInput {
  /** path -> text of each test file the reader's prefilter found. */
  tests: ReadonlyMap<string, string>;
  srcText: (path: string) => string | undefined;
  aliasRoot: string;
  clock: Clock;
  /** When the clock started; the reader's time counts against the budget. Defaults to the first reading. */
  startedAt?: number;
}

export interface PinningTestListing { path: string; tokens: string[]; score: number }

export type PinningTestCandidates =
  | { outcome: "ran"; modules: string[]; listed: PinningTestListing[]; tokens: string[]; ms: number }
  | { outcome: "over_budget"; budgetMs: number; ms: number }
  | { outcome: "unreadable"; reason: string };

type PinningTask = Pick<Task, "id" | "type" | "title" | "files" | "design" | "rationale" | "note">;

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
function keptTokens(task: PinningTask, moduleTexts: readonly string[]): string[] {
  const words = new Set<string>();
  for (const text of [task.title, task.design ?? "", task.rationale ?? ""]) {
    for (const m of text.matchAll(WORD)) if (m[0].length >= 6 && (isCamel(m[0]) || isUpperSnake(m[0]))) words.add(m[0]);
  }
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
  if (modules.length === 0 || tokens.length === 0) return { outcome: "ran", modules, listed: [], tokens, ms: elapsed() };
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
  const listed = [...matched].map(([path, hits]) => ({
    path, tokens: hits, score: hits.reduce((sum, t) => sum + 1 / namedBy.get(t)!, 0),
  })).sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { outcome: "ran", modules, listed, tokens, ms: elapsed() };
}

/** The advisory: one warn naming at most 10 listed tests, or one warn that the check ran out of time. */
export function pinningTestViolations(task: Pick<Task, "id">, candidates: PinningTestCandidates): LintViolation[] {
  if (candidates.outcome === "over_budget") {
    return [{ check: "pinning-tests", severity: "warn",
      message: `pinning-tests did not run: over its ${candidates.budgetMs} ms budget after ${candidates.ms} ms` }];
  }
  if (candidates.outcome !== "ran" || candidates.listed.length === 0) return [];
  const shown = candidates.listed.slice(0, PINNING_TESTS_NAMED).map((l) => `${l.path} (${l.tokens.join(", ")})`);
  const more = candidates.listed.length - shown.length;
  return [{
    check: "pinning-tests",
    severity: "warn",
    message: `task ${task.id} declares ${candidates.modules.join(", ")}. These existing tests import it and name what ` +
      `its design changes: ${shown.join("; ")}${more > 0 ? ` and ${more} more` : ""}. They may pin the old behaviour. ` +
      "A build that changes a test outside files: is refused by the acceptance-author gate " +
      "(canonical-task-scope-exceeded) until a scope amendment merges. This is ADVISORY, never blocking, because a " +
      "test can name a symbol without pinning the changed behaviour. TO CLEAR IT: add each test that pins the old " +
      "behaviour to files:, or name its path in design or note and say why it does not change. " +
      "Copy this list into the filing PR body.",
  }];
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
  let result: PinningTestCandidates;
  try {
    const read = readPinningTestInput(codeRoot, declaredSrcPaths(task));
    result = pinningTestCandidates(task, { ...read, clock, startedAt });
  } catch (error) {
    result = { outcome: "unreadable", reason: String((error as Error)?.message ?? error) };
  }
  const event = result.outcome === "ran"
    ? { listed: result.listed.map((l) => l.path), tokens: result.tokens, ms: result.ms }
    : result.outcome === "over_budget" ? { ms: result.ms } : { reason: result.reason };
  console.error(JSON.stringify({ event: "lint_plan.pinning_tests", task: task.id, outcome: result.outcome, ...event }));
  return result;
}
