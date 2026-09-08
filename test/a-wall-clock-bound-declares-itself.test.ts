import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { assertWallClockBound } from "./helpers/wall-clock-bound.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = "test/helpers/wall-clock-bound.js";
const THIS_FILE = "test/a-wall-clock-bound-declares-itself.test.ts";
const HELPER_IMPORT = "helpers/wall-clock-bound.js";
const RECORDED_DECLARED_WALL_CLOCK_BOUND_FILES = 16;
const RECORDED_DECLARED_WALL_CLOCK_BOUND_SITES = 24;
const WALL_CLOCK_BOUND_FILE_FLOOR = 3;
const WALL_CLOCK_BOUND_SITE_FLOOR = 4;

// ── W1-T2811 ────────────────────────────────────────────────────────────────────────────────
//
// The recognizer for a DECLARED wall-clock bound is the import query below: which test files
// import the helper. That is the maintained surface, not a grep over clock spellings.
//
// The bare-bound scan is only a falsifier. A migrated member calls
// `assertWallClockBound(measured, bound, msg)`, so reverting it to `assert.ok(elapsed < N, ...)`
// becomes an undeclared bare assertion and the census names the file. It is deliberately not the
// membership roster; the declaration is the call site, and the recognizer is exact rather than
// approximate, unlike a roster of test names or `censusPopulationDrift`'s self-described
// "approximate by construction" text match.
//
// THE PATTERN IS STILL A GREP AND STILL BLIND IN THE SAME WAY the shard's own census was — it
// keys on the spellings a bound is written in today. That is fine HERE and would not be fine as a
// roster: a spelling this misses is a member that never declares, which costs the reader one
// unexplained red; a roster that misses one silently asserts the population is complete.

/** Spellings of "a real clock was read". An INJECTED clock produces none of these. */
const REAL_CLOCK_RE = /\b(Date\.now\(\)|performance\.now\(\)|process\.hrtime(?:\.bigint)?\(\))/;

/**
 * A bare upper-bound assertion on an elapsed-looking value. Both halves are required: the
 * `assert` call, and a `< <number>` inside it against something that reads like a duration.
 * Underscored numeric separators (`2_000`) count.
 */
const BARE_BOUND_RE =
  /^\s*assert(?:\.ok|\.equal)?\s*\([^\n]*\b(elapsed[A-Za-z]*|ms|Ms|shellMs|realElapsedMs|duration[A-Za-z]*|Date\.now\(\)\s*-|performance\.now\(\)\s*-)[^\n]*<\s*[0-9][0-9_]*/;

/**
 * Candidate lines from ONE `git grep`, not a read of every test file.
 *
 * The first draft read all ~1030 tracked suites with `readFileSync`, and that load was enough to
 * make a TIMER-ORDERING test in a concurrently-running suite fail — measured: the prewarm-timer
 * test in serve.test.ts reds when this file is in the run and passes when it is not. A census
 * that changes the outcome of the suite it censuses is not a census. One subprocess plus a read
 * of the few files that actually match costs almost nothing.
 *
 * The pattern here is DELIBERATELY LOOSER than {@link BARE_BOUND_RE} — it only prefilters, and
 * the precise decision stays in JS where `\b` and `\s` mean what they say. It also uses POSIX
 * classes and NO `[^\n]`: inside an ERE bracket expression `[^\n]` means "not a backslash and
 * not the letter n", which is exactly how the hand-census that preceded this task went blind to
 * `assert.ok(run.elapsedMs < 5000, …)` — the `n` in `run.` excluded it.
 */
function candidateLines(): Array<{ file: string; line: number; text: string }> {
  let out = "";
  try {
    out = execFileSync("git", ["grep", "-nE", "assert.*<[[:space:]]*[0-9]", "--", "test/*.test.ts"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    // git grep exits 1 on NO MATCH, which for this pattern would itself be the defect the
    // positive control below catches -- so an empty result is returned, never swallowed as OK.
    const err = e as { status?: number; stdout?: string };
    if (err.status !== 1) throw e;
    out = err.stdout ?? "";
  }
  const rows: Array<{ file: string; line: number; text: string }> = [];
  for (const raw of out.split("\n")) {
    if (!raw) continue;
    const m = /^([^:]+):(\d+):(.*)$/.exec(raw);
    if (!m) continue;
    rows.push({ file: m[1]!, line: Number(m[2]), text: m[3]! });
  }
  return rows;
}

function gitGrepLines(args: readonly string[]): string[] {
  let out = "";
  try {
    out = execFileSync("git", [...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    if (err.status !== 1) throw e;
    out = err.stdout ?? "";
  }
  return out.split("\n").filter(Boolean);
}

function declaredMemberFiles(): string[] {
  return gitGrepLines(["grep", "-lF", HELPER_IMPORT, "--", "test/*.test.ts"])
    .filter((file) => file !== THIS_FILE)
    .sort();
}

function declaredAssertionSites(): Array<{ file: string; line: number; text: string }> {
  return gitGrepLines(["grep", "-nE", "^[[:space:]]*assertWallClockBound[[:space:]]*\\(", "--", "test/*.test.ts"])
    .map((raw) => {
      const m = /^([^:]+):(\d+):(.*)$/.exec(raw);
      assert.ok(m, `git grep emitted an unparsable declaration row: ${raw}`);
      return { file: m[1]!, line: Number(m[2]), text: m[3]!.trim() };
    })
    .filter((site) => site.file !== THIS_FILE);
}

function declarationPopulation(): { files: string[]; sites: Array<{ file: string; line: number; text: string }> } {
  return { files: declaredMemberFiles(), sites: declaredAssertionSites() };
}

function assertPopulationClearsFloor(population: { files: readonly string[]; sites: readonly { file: string }[] }): void {
  assert.ok(
    population.files.length >= WALL_CLOCK_BOUND_FILE_FLOOR,
    `W1-T2811 build-time census measured ${population.files.length} declaring file(s), below the ` +
      `${WALL_CLOCK_BOUND_FILE_FLOOR}-file abandonment floor; close the task unbuilt with this ` +
      `measurement recorded. Declaring files: ${population.files.join(", ") || "(none)"}`,
  );
  assert.ok(
    population.sites.length >= WALL_CLOCK_BOUND_SITE_FLOOR,
    `W1-T2811 build-time census measured ${population.sites.length} assertion site(s), below the ` +
      `${WALL_CLOCK_BOUND_SITE_FLOOR}-site abandonment floor; close the task unbuilt with this ` +
      `measurement recorded.`,
  );
}


/** Every line in `text` that reads as a bare wall-clock upper bound, as `{line, text}`. */
function bareBoundLines(text: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (!BARE_BOUND_RE.test(l)) continue;
    // The bounded value must actually come from a real clock, either on this line or wherever it
    // was computed. Scanning the whole file is deliberately generous: a false positive here costs
    // one migration, a false negative costs the class a silent member.
    if (!REAL_CLOCK_RE.test(text)) continue;
    out.push({ line: i + 1, text: l.trim() });
  }
  return out;
}

function undeclaredWallClockBounds(
  candidates: readonly { file: string; line: number; text: string }[],
  sourceForFile: (file: string) => string,
): string[] {
  const byFile = new Map<string, Array<{ line: number; text: string }>>();
  for (const c of candidates) {
    if (c.file === THIS_FILE) continue;
    if (!BARE_BOUND_RE.test(c.text)) continue;
    const list = byFile.get(c.file) ?? [];
    list.push({ line: c.line, text: c.text.trim() });
    byFile.set(c.file, list);
  }

  const undeclared: string[] = [];
  for (const [rel, hits] of byFile) {
    if (!REAL_CLOCK_RE.test(sourceForFile(rel))) continue;
    for (const h of hits) undeclared.push(`${rel}:${h.line}  ${h.text}`);
  }
  return undeclared;
}

function assertNoUndeclaredWallClockBounds(undeclared: readonly string[]): void {
  assert.deepEqual(
    undeclared,
    [],
    `these assertions bound a REAL elapsed measurement without declaring it, so a loaded host reds ` +
      `them with no defect in the code under test. Replace each with ` +
      `assertWallClockBound(measured, bound, message) from ${HELPER}:\n  ` +
      undeclared.join("\n  "),
  );
}

// ── the helper's own contract ─────────────────────────────────────────────────────────────────

test("assertWallClockBound asserts exactly the bound the call site asserted -- no tolerance, no slack", () => {
  // The whole risk of routing 22 real assertions through one function is that the function
  // quietly weakens them. It must be the SAME comparison: strictly less than, no epsilon.
  assert.equal(assertWallClockBound(1999, 2000, "under"), undefined);
  assert.throws(() => assertWallClockBound(2000, 2000, "exactly at the bound is NOT under it"), /exactly at the bound/);
  assert.throws(() => assertWallClockBound(2001, 2000, "over"), /over/);
  // A bound in minutes works the same as one in milliseconds -- the helper names no unit.
  assert.doesNotThrow(() => assertWallClockBound(0.5, 1, "half a minute"));
  const helperSource = readFileSync(join(REPO_ROOT, "test/helpers/wall-clock-bound.ts"), "utf8");
  assert.doesNotMatch(helperSource, /\b(?:setTimeout|setImmediate|retry|skip)\s*\(/, "the helper adds no wait, retry, or skip call");
});

test("assertWallClockBound's failure NAMES the wall-clock dependence, so the red is self-explaining", () => {
  // Without this, a red here is indistinguishable from a real regression and the reader has to
  // already know this class exists to interpret it -- which is the defect the task exists to fix.
  let caught: Error | undefined;
  try {
    assertWallClockBound(9999, 100, "the poll returned late");
  } catch (e) {
    caught = e as Error;
  }
  assert.ok(caught, "it must throw");
  assert.match(caught!.message, /the poll returned late/, "the call site's own message survives, first");
  assert.match(caught!.message, /WALL-CLOCK DEPENDENT/, "and the class is named");
  assert.match(caught!.message, /idle host/, "with the action a reader should take");
  assert.equal((caught as { actual?: unknown }).actual, 9999);
});

// ── the positive control, first: a bare-bound falsifier that cannot see its subject proves nothing ──

test("the bare-bound falsifier fires on a reverted member and stays quiet on the migrated form", () => {
  const bare = ["const t0 = Date.now();", "const elapsedMs = Date.now() - t0;", '  assert.ok(elapsedMs < 2000, "too slow");'].join("\n");
  const migrated = [
    "const t0 = Date.now();",
    "const elapsedMs = Date.now() - t0;",
    '  assertWallClockBound(elapsedMs, 2000, "too slow");',
  ].join("\n");

  assert.equal(bareBoundLines(bare).length, 1, "the falsifier must see a bare bound -- otherwise the census below is vacuous");
  assert.equal(bareBoundLines(migrated).length, 0, "the migrated form carries no `<`, so it stops matching on its own");

  // A bound on an INJECTED clock is not a member: load cannot make it fail.
  const injected = ['const elapsedMs = fakeClock.now() - t0;', '  assert.ok(elapsedMs < 2000, "deterministic");'].join("\n");
  assert.equal(bareBoundLines(injected).length, 0, "no real clock in the file -- not a member");
});

// ── the census ────────────────────────────────────────────────────────────────────────────────

test("the build-time declaration census records the measured population and enforces its abandonment floor", () => {
  const population = declarationPopulation();
  assertPopulationClearsFloor(population);
  assert.equal(
    population.files.length,
    RECORDED_DECLARED_WALL_CLOCK_BOUND_FILES,
    `build-time declaration census measured ${population.files.length} declaring file(s), but the ` +
      `recorded W1-T2811 population is ${RECORDED_DECLARED_WALL_CLOCK_BOUND_FILES}: ${population.files.join(", ")}`,
  );
  assert.equal(
    population.sites.length,
    RECORDED_DECLARED_WALL_CLOCK_BOUND_SITES,
    `build-time declaration census measured ${population.sites.length} assertion site(s), but the ` +
      `recorded W1-T2811 population is ${RECORDED_DECLARED_WALL_CLOCK_BOUND_SITES}`,
  );

  assert.throws(
    () => assertPopulationClearsFloor({ files: ["test/one.test.ts", "test/two.test.ts"], sites: [{ file: "test/one.test.ts" }] }),
    /below the 3-file abandonment floor; close the task unbuilt with this measurement recorded/,
  );
  assert.throws(
    () =>
      assertPopulationClearsFloor({
        files: ["test/one.test.ts", "test/two.test.ts", "test/three.test.ts"],
        sites: [{ file: "test/one.test.ts" }, { file: "test/two.test.ts" }, { file: "test/three.test.ts" }],
      }),
    /below the 4-site abandonment floor; close the task unbuilt with this measurement recorded/,
  );
});

test("the declaration recognizer is the helper import query, not a clock-idiom text match", () => {
  const importers = declaredMemberFiles();
  const siteFiles = [...new Set(declaredAssertionSites().map((site) => site.file))].sort();
  assert.deepEqual(siteFiles, importers, "every helper call sits in, and only in, a file declaring the helper import");
  assert.ok(
    importers.length >= RECORDED_DECLARED_WALL_CLOCK_BOUND_FILES,
    `the seam should have the migrated members as declarers; found ${importers.length}: ${importers.join(", ")}`,
  );

  const helperDeclarations = gitGrepLines(["grep", "-nE", "^export function assertWallClockBound\\(", "--", "test/helpers/*.ts"]);
  assert.equal(helperDeclarations.length, 1, `the helper function must be declared in exactly one place: ${helperDeclarations.join(", ")}`);
  assert.match(
    helperDeclarations[0]!,
    /^test\/helpers\/wall-clock-bound\.ts:\d+:export function assertWallClockBound\(measured: number, bound: number, message: string\): void \{$/,
  );

  const realClockFiles = gitGrepLines(["grep", "-lE", "Date\\.now\\(\\)|performance\\.now\\(\\)|process\\.hrtime", "--", "test/*.test.ts"]);
  assert.ok(
    realClockFiles.length > importers.length,
    `a clock-idiom text match would count ${realClockFiles.length} files, while the declaration ` +
      `recognizer is the ${importers.length}-file helper import query`,
  );
});

test("every bare wall-clock upper bound is migrated, and reverting a member fails by file name", () => {
  const candidates = candidateLines();
  assert.ok(candidates.length > 20, `the prefilter must be reading a real corpus, got ${candidates.length} candidate line(s)`);

  assertNoUndeclaredWallClockBounds(undeclaredWallClockBounds(candidates, (rel) => readFileSync(join(REPO_ROOT, rel), "utf8")));

  const reverted = [
    "const started = process.hrtime.bigint();",
    "const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;",
    '  assert.ok(elapsedMs < 50, "three attempts must not pace");',
  ].join("\n");
  assert.throws(
    () =>
      assertNoUndeclaredWallClockBounds(
        undeclaredWallClockBounds(
          [{ file: "test/run-task.test.ts", line: 8500, text: '  assert.ok(elapsedMs < 50, "three attempts must not pace");' }],
          () => reverted,
        ),
      ),
    /test\/run-task\.test\.ts:8500/,
  );
});

// ── the census is invocable AT BUILD TIME, the way its four siblings are ───────────────────────
//
// Criterion 1 asks that the predicate be "re-run at build time". Running inside the full suite is
// not that: it proves the census executes, not that a builder can deliberately invoke it. Every
// other census in this repo is reachable as its own `census:*` npm script -- bound-kind,
// catch-erasure, negative-reachability, no-shallowing -- and this one was reachable only by typing
// the file path. That is the same shape W1-T2735 named for `scripts/`: an instrument that reads
// like a gate and that nothing invokes. Asserted here rather than left to convention, because a
// convention no check enforces is exactly what this repo keeps re-learning.

test("the census is registered as its own census:* script, like every sibling census", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const censuses = Object.entries(pkg.scripts).filter(([name]) => name.startsWith("census:"));

  // Vacuity guard: if the prefix ever changes, an empty list would make every assertion below
  // pass over nothing.
  assert.ok(censuses.length >= 5, `expected the sibling censuses plus this one, found ${censuses.length}: ${censuses.map(([n]) => n).join(", ")}`);

  const mine = pkg.scripts["census:wall-clock-bound"];
  assert.ok(mine, `no census:wall-clock-bound script; registered censuses are ${censuses.map(([n]) => n).join(", ")}`);
  assert.match(mine!, /test\/a-wall-clock-bound-declares-itself\.test\.ts$/, "the script must point at THIS census, not another file");

  // It must invoke the census the same way the siblings do -- a divergent runner (no tsx, no
  // tmp-hygiene) would run a different thing under the same name.
  const sibling = pkg.scripts["census:bound-kind"]!;
  const runnerOf = (cmd: string) => cmd.replace(/\S+\.test\.ts$/, "").trim();
  assert.equal(runnerOf(mine!), runnerOf(sibling), "this census must be invoked exactly the way its siblings are");
});
