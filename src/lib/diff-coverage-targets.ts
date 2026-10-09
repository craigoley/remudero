/**
 * A diff-coverage red names EXACT uncovered lines (`  - src/lib/foo.ts:277`, sometimes followed by
 * ` -- <remedy>`). A ci-log fix round used to receive them only as raw log text beside every other
 * check's tail. On #10339 (W1-T7092) two rounds read that and committed nothing, and a hand fix
 * added one test per catch arm in minutes. This parses the gate's own list into per-file targets
 * so the fix prompt can name them as the round's work.
 */

export interface DiffCoverageTarget {
  file: string;
  lines: number[];
}

export interface DiffCoverageTargets {
  targets: DiffCoverageTarget[];
  /** Lines the gate counted but did not list (its own `... N more not listed` cap line). */
  unlisted: number;
}

/** The targets named by every diff-coverage BLOCKED report in `logTails`; undefined when none blocks. */
export function diffCoverageTargets(logTails: readonly string[]): DiffCoverageTargets | undefined {
  const byFile = new Map<string, Set<number>>();
  let unlisted = 0;
  let blocked = false;
  for (const tail of logTails) {
    if (!/diff-coverage: BLOCKED -- this diff adds source line\(s\) with zero covering tests/i.test(tail)) continue;
    blocked = true;
    for (const raw of tail.split("\n")) {
      const listed = /^\s*-\s+((?:src|scripts|bin|deploy|packages|apps)\/[\w./@-]+\.[cm]?[jt]sx?):(\d+)(?:\s|$)/.exec(raw);
      if (listed) {
        const lines = byFile.get(listed[1]!) ?? new Set<number>();
        lines.add(Number(listed[2]));
        byFile.set(listed[1]!, lines);
        continue;
      }
      const more = /^\s*\.\.\.\s+(\d+)\s+more not listed/.exec(raw);
      if (more) unlisted += Number(more[1]);
    }
  }
  if (!blocked) return undefined;
  const targets = [...byFile.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, lines]) => ({ file, lines: [...lines].sort((x, y) => x - y) }));
  return { targets, unlisted };
}

/** The prompt block for {@link diffCoverageTargets}; empty when nothing was blocked. */
export function renderDiffCoverageTargets(parsed: DiffCoverageTargets | undefined, opts: { harnessCommits?: boolean } = {}): string[] {
  if (!parsed) return [];
  const listing = parsed.targets.length > 0
    ? parsed.targets.map((t) => `  - ${t.file}: line${t.lines.length === 1 ? "" : "s"} ${t.lines.join(", ")}`)
    : ["  (the gate blocked but its line list was not in the captured log; read the coverage-ratchet log for the `  - <file>:<line>` entries)"];
  const verify = opts.harnessCommits
    ? "You cannot run git this round, so run each test file you add with `node --test --import tsx " +
      "--import ./test/setup/tmp-hygiene.ts <file>` and make each listed line observably execute (assert on the " +
      "result that line produces)."
    : "Verify before saving with `npm run diff-coverage:local -- <the test files you added or changed>`; it " +
      "reproduces CI's coverage flags and diff base, and must print `diff-coverage: OK`.";
  return [
    "",
    "DIFF-COVERAGE TARGETS: the coverage gate above names these ADDED lines as having NO covering test.",
    "Covering them IS this round's work:",
    ...listing,
    ...(parsed.unlisted > 0 ? [`  (and ${parsed.unlisted} more the gate counted but did not list)`] : []),
    "Add a test that EXECUTES each listed line. A line in a `catch`/error arm needs a test that makes that",
    "call fail (inject the failing dependency). A seam's DEFAULT implementation needs one test that runs the",
    "real default rather than a fake. Do not reorder code, move lines, or add ignore comments to dodge the gate.",
    verify,
    "This gate is deterministic: FLAKE and BASE_RED are the wrong outcomes for it; it fails the same way on rerun.",
  ];
}
