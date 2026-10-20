/**
 * W1-T9483 — the push coverage precheck's NARROW pass and its verdicts.
 *
 * The precheck used to select suites by reach alone, and a diff touching src/run-task.ts reaches thousands (2503
 * for #11677) — far past the 40-suite ceiling — so a real source diff read `unavailable` and a new module's
 * uncovered error arms were learned from CI's coverage-ratchet a fix round later. The suites most likely to cover
 * a diff are its OWN test files plus the DIRECT importers of its changed src files; those run first.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildAffectedSuitesGraph } from "./affected-suites.js";
import { hostWorktreeGitAsync } from "./worktree-git.js";

const SRC_FILE = /^src\/.*\.ts$/;
const TEST_FILE = /^test\/.*\.test\.ts$/;

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
  const { directImports } = buildAffectedSuitesGraph(files, srcChanged);
  const importers = [...files.keys()].filter((f) => srcChanged.some((s) => directImports.get(f)?.has(s)));
  return [...new Set([...own, ...importers])].sort();
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
  const skippedNarrow = j.narrow.length > j.ceiling ? `; ${j.narrow.length} own and direct-importer suite(s) were not measured (over preflight's scoped ceiling of ${j.ceiling})` : "";
  const unavailable = (reason: string): Extract<CoverageVerdict, { outcome: "unavailable" }> => ({ outcome: "unavailable", reason: `${reason}${skippedNarrow}` });
  if (j.narrow.length > 0 && j.narrow.length <= j.ceiling) {
    const { r } = await j.bounded(j.narrow);
    if (!r.timedOut && r.spawnError === undefined) {
      if (r.status === 0) return { outcome: "covered", reason: `${j.narrow.length} own and direct-importer suite(s) cover every added src line`, suites: j.narrow.length };
      if (j.isUncovered(r.output)) narrowGap = j.refusalText(r.output);
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
    return { outcome: "uncovered-narrow", reason: `${j.narrow.length} own and direct-importer suite(s) leave added src lines uncovered; ${why}`, text: narrowGap, suites: j.narrow.length, head };
  };
  const { selection } = j;
  if (selection.fullRun) {
    const why = selection.reasons[0] ?? "a changed file forces the full suite";
    return (await advisory(why)) ?? unavailable(why);
  }
  if (selection.suites.length === 0) return unavailable("no suite reaches the changed src files");
  for (const suites of j.passes) {
    // A pass the narrow run already contained would repeat a run that left a gap: the verdict stands.
    if (narrowGap !== undefined && suites.every((f) => j.narrow.includes(f))) return { outcome: "uncovered", text: narrowGap, suites: j.narrow.length };
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
