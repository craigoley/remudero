/**
 * W1-T9483 — the push coverage precheck's NARROW pass and its verdicts.
 *
 * The precheck used to select suites by reach alone, and a diff touching src/run-task.ts reaches thousands (2503
 * for #11677) — far past the 40-suite ceiling — so a real source diff read `unavailable` and a new module's
 * uncovered error arms were learned from CI's coverage-ratchet a fix round later. The suites most likely to cover
 * a diff are its OWN test files plus the DIRECT importers of its changed src files; those run first.
 *
 * W1-T5309 — ONE HUB FILE MUST NOT BLIND THE WHOLE DIFF. src/run-task.ts alone has ~930 direct-importer suites, so a
 * diff touching it put the union over the ceiling and the precheck read `unavailable` on 31 of 46 source diffs
 * (2026-10-20/21) — while 20 of 28 heads CI then blocked had every blocked line in a file with at most 40. The narrow
 * pass is therefore chosen PER FILE (judgeCoverage), and a gap counts only in a file whose suites all ran.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildAffectedSuitesGraph } from "./affected-suites.js";
import { hostWorktreeGitAsync } from "./worktree-git.js";

/** W1-T5309 — the source files CI's diff-coverage gate judges (scripts/diff-coverage.mjs `changedSourceFiles`):
 *  src/ TypeScript, and src/ or scripts/ ESM. The push precheck reads the same predicate, so an .mjs change is
 *  judged here exactly as CI judges it. */
export const COVERAGE_SOURCE_FILE = /^(?:src\/.*\.ts|(?:src|scripts)\/.*\.mjs)$/;
const SRC_FILE = COVERAGE_SOURCE_FILE;
const TEST_FILE = /^test\/.*\.test\.ts$/;

/** W1-T5309 — what a narrow listing is made of: the diff's own test files, and each changed source file's
 *  direct-importer suites. Kept beside the listing (never in it), so a caller that only reads the suites is unchanged. */
export interface NarrowGroups {
  own: readonly string[];
  importers: ReadonlyMap<string, readonly string[]>;
}

const NARROW_GROUPS = new WeakMap<readonly string[], NarrowGroups>();

/** The narrow listing {@link coverageNarrowSuites} returns: the union of `groups`, sorted, carrying its groups. */
export function narrowListing(groups: NarrowGroups): string[] {
  const suites = [...new Set([...groups.own, ...[...groups.importers.values()].flat()])].sort();
  NARROW_GROUPS.set(suites, groups);
  return suites;
}

/** What one scoped `diff-coverage-local.mjs` run came back with. */
export type CoverageRun = { status: number | null; output: string; timedOut: boolean; spawnError?: string };

/** The precheck's answers, never collapsed. `uncovered` (a refusal) is reachable ONLY from a wide-enough pass:
 *  `uncovered-narrow` is ADVISORY — the narrow suites leave lines uncovered and the reach is too wide to widen to. */
export type CoverageVerdict =
  | { outcome: "covered"; reason: string; suites: number }
  | { outcome: "uncovered"; text: string; suites: number }
  | { outcome: "uncovered-narrow"; reason: string; text: string; suites: number; head: string }
  | { outcome: "unavailable"; reason: string };

/**
 * The narrow pass's suites: the diff's own added or changed test files (still on disk) plus every tracked test
 * file whose import specifiers name a changed src file DIRECTLY. Built from the selector's own comment-free
 * import graph over the test tree only, so it costs one listing and the test files' reads.
 */
export async function coverageNarrowSuites(wt: string, changed: string[]): Promise<string[]> {
  const srcChanged = changed.filter((f) => SRC_FILE.test(f));
  const own = changed.filter((f) => TEST_FILE.test(f) && existsSync(join(wt, f)));
  if (srcChanged.length === 0 && own.length === 0) return [];
  const files = new Map<string, string>();
  for (const f of (await hostWorktreeGitAsync(wt, ["ls-files", "--", "test"], { maxBuffer: 1 << 26 })).split("\n").map((l) => l.trim())) {
    if (!TEST_FILE.test(f) || !existsSync(join(wt, f))) continue;
    files.set(f, readFileSync(join(wt, f), "utf8"));
  }
  // W1-T10820: the aliases come from the measured worktree's own package.json, never this module's checkout.
  const { directImports } = buildAffectedSuitesGraph(files, srcChanged, { root: wt });
  const importers = new Map(srcChanged.map((s) => [s, [...files.keys()].filter((f) => directImports.get(f)?.has(s)).sort()]));
  return narrowListing({ own, importers });
}

/** The suites one narrow run spawns, and the changed source files whose every direct-importer suite is among them. */
interface NarrowRun {
  suites: string[];
  /** Undefined: the whole listing runs, so every changed file is measured (the pre-W1-T5309 pass). */
  measured?: ReadonlySet<string>;
}

/**
 * W1-T5309 — the narrow run within `ceiling`. A listing that fits runs whole, as before. One over it, with known
 * groups, runs the own tests plus the importer groups of as many changed files as fit, smallest first; each other
 * changed file adds ONE of its importers (when none is already in), so the report still carries its SF record. A
 * file whose group did not fit is not measured, and its lines are never a gap. Undefined: nothing can run.
 */
function narrowRun(narrow: readonly string[], ceiling: number): NarrowRun | undefined {
  if (narrow.length === 0) return undefined;
  if (narrow.length <= ceiling) return { suites: [...narrow] };
  const groups = NARROW_GROUPS.get(narrow);
  if (groups === undefined) return undefined;
  const files = [...groups.importers.keys()].sort((a, b) => groups.importers.get(a)!.length - groups.importers.get(b)!.length || a.localeCompare(b));
  for (let k = files.length; k > 0; k--) {
    const measured = new Set(files.slice(0, k));
    const suites = new Set([...groups.own, ...files.slice(0, k).flatMap((f) => groups.importers.get(f)!)]);
    for (const f of files.slice(k)) {
      const own = groups.importers.get(f)!;
      if (own.length > 0 && !own.some((s) => suites.has(s))) suites.add(own[0]!);
    }
    if (suites.size <= ceiling) return { suites: [...suites].sort(), measured };
  }
  return undefined;
}

/** The refusal text with only the listed lines of `measured` files kept; undefined when none is left. */
function measuredGap(text: string, measured: ReadonlySet<string> | undefined): string | undefined {
  if (measured === undefined) return text;
  const lines = text.split("\n");
  const kept = lines.filter((line) => {
    const listed = /^\s+[-!] (\S+?):\d+/.exec(line);
    return listed === null || measured.has(listed[1]!);
  });
  return kept.some((line) => /^\s+[-!] /.test(line)) ? kept.join("\n") : undefined;
}

/** Everything {@link judgeCoverage} reads or spawns, so a test drives each arm without an instrumented suite. */
export interface CoverageJudgement {
  /** {@link coverageNarrowSuites}, already listed; empty when there is no narrow pass. */
  narrow: string[];
  /** Why the narrow listing was unreadable, as a sentence suffix ("" when it was readable). */
  narrowUnreadable: string;
  selection: { suites: string[]; fullRun: boolean; reasons: string[] };
  /** The reach passes for the selected suites, narrowest first. */
  passes: string[][];
  ceiling: number;
  /** One bounded run of `suites`, the bound set by the tier manifest's measured durations. */
  bounded: (suites: string[]) => Promise<{ predictedMs: number; boundMs: number; r: CoverageRun }>;
  head: () => string | Promise<string>;
  /** CI's `diff-coverage:` refusal headline. */
  isUncovered: (output: string) => boolean;
  /** The refusal lines of a run's output, bounded. */
  refusalText: (output: string) => string;
  /** A changed src file with no `SF:` record in the report — widen to the slow-tier siblings. */
  isMissingSf: (output: string) => boolean;
}

const reasonOf = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);

/**
 * The narrow pass first, within the same scoped ceiling: covering every added src line is `covered`. A gap
 * runs the reach passes as before — only they can return `uncovered` — and when the reach is over the ceiling (or
 * a changed file forces the full suite) the gap is `uncovered-narrow`, advisory. A narrow pass that cannot look
 * (over ceiling, timeout, spawn failure, no `SF:` record) is no verdict; valid reach passes can still decide.
 */
export async function judgeCoverage(j: CoverageJudgement): Promise<CoverageVerdict> {
  let narrowGap: string | undefined;
  const run = narrowRun(j.narrow, j.ceiling);
  const ran = run?.suites ?? [];
  const unmeasured = run?.measured === undefined ? 0 : [...NARROW_GROUPS.get(j.narrow)!.importers.keys()].filter((f) => !run.measured!.has(f)).length;
  const skippedNarrow = run === undefined && j.narrow.length > j.ceiling
    ? `; ${j.narrow.length} own and direct-importer suite(s) were not measured (over preflight's scoped ceiling of ${j.ceiling})`
    : unmeasured > 0 ? `; ${unmeasured} changed source file(s) had too many direct-importer suites to measure (over preflight's scoped ceiling of ${j.ceiling})` : "";
  const unavailable = (reason: string): Extract<CoverageVerdict, { outcome: "unavailable" }> => ({ outcome: "unavailable", reason: `${reason}${skippedNarrow}` });
  if (run !== undefined) {
    const { r } = await j.bounded(ran);
    if (!r.timedOut && r.spawnError === undefined) {
      if (r.status === 0) return { outcome: "covered", reason: `${ran.length} own and direct-importer suite(s) cover every added src line`, suites: ran.length };
      if (j.isUncovered(r.output)) narrowGap = measuredGap(j.refusalText(r.output), run.measured);
    }
  }
  const advisory = async (why: string): Promise<CoverageVerdict | undefined> => {
    if (narrowGap === undefined) return undefined;
    let head: string;
    try {
      head = await j.head();
    } catch (e) {
      head = `unreadable: ${reasonOf(e)}`;
    }
    return { outcome: "uncovered-narrow", reason: `${ran.length} own and direct-importer suite(s) leave added src lines uncovered; ${why}`, text: narrowGap, suites: ran.length, head };
  };
  const { selection } = j;
  if (selection.fullRun) {
    const why = selection.reasons[0] ?? "a changed file forces the full suite";
    return (await advisory(why)) ?? unavailable(why);
  }
  if (selection.suites.length === 0) return unavailable("no suite reaches the changed src files");
  for (const suites of j.passes) {
    // A pass the narrow run already contained would repeat a run that left a gap: the verdict stands.
    if (narrowGap !== undefined && run?.measured === undefined && suites.every((f) => ran.includes(f))) return { outcome: "uncovered", text: narrowGap, suites: ran.length };
    if (suites.length > j.ceiling) {
      const tooWide = `${suites.length} suite(s) are too wide to precheck quickly (over preflight's scoped ceiling of ${j.ceiling})`;
      return (await advisory(tooWide)) ?? unavailable(`${tooWide}${j.narrowUnreadable}`);
    }
    const { predictedMs, boundMs, r } = await j.bounded(suites);
    if (r.timedOut) return unavailable(`timed out over its ${boundMs}ms bound (manifest-measured ${predictedMs}ms for ${suites.length} suite(s))`);
    if (r.spawnError !== undefined) return unavailable(`spawn failed: ${r.spawnError.slice(0, 300)}`);
    if (r.status === 0) return { outcome: "covered", reason: `${suites.length} scoped suite(s) cover every added src line`, suites: suites.length };
    if (j.isUncovered(r.output)) return { outcome: "uncovered", text: j.refusalText(r.output), suites: suites.length };
    if (!j.isMissingSf(r.output)) {
      const why = /^diff-coverage-local: .*$/m.exec(r.output)?.[0] ?? `exited ${r.status}`;
      return unavailable(why.slice(0, 300));
    }
  }
  return unavailable("a changed src file has no SF record even after widening to the slow-tier siblings");
}

/** The `push.coverage_precheck` row fields an `uncovered-narrow` adds: the lines to cover and the head they were
 *  judged on (so CI's later verdict can be joined to it) — never a refusal. */
export function coverageNarrowRowFields(result: { outcome: string; text?: string; head?: string }): Record<string, unknown> {
  return result.outcome === "uncovered-narrow" ? { lines: result.text, head: result.head } : {};
}
