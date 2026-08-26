// test/negative-reachability-ratchet.test.ts — W1-T2317: an instrument must be able to fail for
// a reason it can name.
//
// THE DEFECT. Of eight measured instrument defects (2026-08-25/26), five fit one shape: a
// distinction dying at a seam whose type admits a legal value identical to the healthy case, and
// all five lacked the same artefact — a fixture driving the instrument's UNHEALTHY arm and
// asserting a distinguishable output. The 403 arm of a log fetch, the garbage arm of a trailer
// regex that accepts any non-whitespace token, a lying rate-limit reader, unreachable
// token-exchange reasons, a root-runner permission test chmod cannot deny. None of these arms had
// ever been exercised.
//
// THE RATCHET, in the shape this house has proven twice (no-raw-NUL, W1-T438; the catch-erasure
// ratchet, W1-T2295): walk the enumerable surfaces, PER-FILE COUNT OF FIXTURE-LESS SURFACES HELD
// AT THE BASELINE THE GATE MEASURES AT ITS OWN HEAD, a NEW or CHANGED surface pays immediately,
// NO ALLOWLIST FILE. Two surface kinds, per the task design: (a) every module-scope `_RE`
// validator regex in src/, (b) every `DEFAULT_FIX_CLASSES` row (src/lib/sweep.ts). A surface
// satisfies the gate only with a fixture that DRIVES ITS UNHEALTHY ARM AND ASSERTS AN OUTPUT
// DISTINGUISHABLE FROM THE HEALTHY ONE — merely importing or touching the symbol satisfies
// nothing (design note ii).
//
// THE CENSUS WAS RE-DERIVED HERE, NOT CARRIED FROM THE FILING SHARD. The shard's own rationale
// cites `git grep -hE 'export const [A-Z_]+_RE' -- src/` as reading "55 exported validators" —
// re-running that exact command at this task's own HEAD still returns 55 lines, but the pattern
// has no suffix boundary, so `[A-Z_]+_RE` matches "_RE" as a bare SUBSTRING anywhere in a longer
// name (`BOARD_REVIEW_...` matches on "_RE" inside "REVIEW"; `MAX_RETRY_...` the same inside
// "RETRY"). Inspecting the 55 lines it actually returns: 54 of them are ordinary constants
// (counters, file names, ledger steps) that are not regexes at all and have no "arm" to drive,
// and the one genuine regex validator among them (`LINT_FILING_SUBJECT_RE`) is also the only
// truly EXPORTED `_RE`-suffixed regex in the whole of src/ — every other regex validator in this
// codebase, including this shard's own named example (`TASK_TRAILER_RE` in src/lib/review.ts), is
// a module-private `const`, never `export`ed, because a validator regex is normally an
// implementation detail of the function that owns it. A gate that required literal `export` would
// cover a population of one and would miss the shard's own motivating defect. So the surface this
// file enumerates is corrected to: every module-scope (non-indented) `NAME_RE` regex declaration
// in a tracked src/**/*.ts file, `export`ed or not — re-measured at THIS run's HEAD via
// `^(?:export )?const [A-Z][A-Z0-9_]*_RE\b\s*=` (anchored at the suffix, so "_REVIEW" and
// "_RETRY" no longer false-match) at 95 declarations across 21 files. This is not a smaller ask
// than the shard's "55" — it is the corrected count of the same population the shard described,
// re-run against reality per the shard's own instruction never to trust an inherited number.
//
// WHAT SATISFIES A SURFACE, MADE MECHANICAL (still an approximation — see below). For a `_RE`
// validator, this file looks for a `SYMBOL.test(...)` or `SYMBOL.exec(...)` call in a tracked
// test/**/*.ts source whose surrounding statement asserts a falsy/rejecting outcome (the unhealthy
// arm) AND, separately, a call whose surrounding statement asserts a truthy/accepting outcome (the
// healthy arm) — both required, so the refusal is provably DISTINCT from acceptance rather than
// merely present. For a `DEFAULT_FIX_CLASSES` row, it looks for a `ROW.matchesFailure(...)` call
// asserted false (the row must NOT claim an unrelated failure) and, separately, either a `.id`
// named as the matched class in an assertion (`assert.equal(x.fixClassId, ROW.id)` — "the match
// names its class", design note ii's own phrase) or a direct `ROW.matchesFailure(...)` call
// asserted true.
//
// WHAT THIS RATCHET CANNOT SEE (residue, not a gap to close here — same posture as W1-T2295's own
// notes). This is a text-proximity heuristic over the test corpus, not a parser or a coverage
// tool: it cannot tell that an assertion's `false` genuinely originates from the surface's own
// call rather than an unrelated one on the same line, and it cannot see a fixture that drives the
// unhealthy arm through the symbol's OWNING FUNCTION without ever naming the regex/row by
// identifier (idiomatic in this codebase, since these are module-private) — such a fixture is real
// coverage this gate cannot credit, so today's baseline over-states the true debt rather than
// understating it, which is the safe direction for a ratchet to err in. A `false` assertion with a
// meaning unrelated to the surface's refusal (i.e., fixture theatre) is also invisible to it,
// exactly the fixture-theatre limit the filing shard concedes and prices as a mitigation, never a
// guarantee. And it enumerates only module-scope declarations (unindented) — a validator built
// fresh inside a function body each call is out of scope, same trade-off `no-raw-nul.test.ts` and
// the catch-erasure ratchet already make on this codebase's own diffs.
//
// THE BASELINE TABLES BELOW are today's measured population — this file's own two detectors, run
// over this repo's own tracked src/**/*.ts and test/**/*.ts at HEAD — not a hand-picked target.
// Every `_RE` surface currently reads fixture-less (0 of 95 exercised): none of them is named by
// identifier anywhere in test/, confirming the shard's own headline literally, for this corrected
// population, at this HEAD. A file entering the tree for the first time, or renamed, has no row
// and so starts at an allowance of zero. A file that gains a satisfying fixture needs no edit
// here: the violation functions below only fire when actual exceeds baseline.

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

const SRC_TS_RE = /^src\/.*\.ts$/;
const TEST_SRC_RE = /^test\/.*\.(ts|mjs)$/;

function trackedFiles(root: string, filterRe: RegExp): string[] {
  const listing = execFileSync("git", ["-C", root, "ls-files"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
  });
  return listing
    .split("\n")
    .filter(Boolean)
    .filter((p) => filterRe.test(p));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** (iv)'s escape hatch, mechanical: a surface whose declaration carries the literal sentence
 *  "structurally total" in a same-line trailing comment or in the up-to-six lines immediately
 *  above it (a JSDoc block, typically) is exempt from the fixture-less count — the same one-line,
 *  in-place, reviewed-diff price W1-T2295 already charges a genuinely-total catch, never an
 *  allowlist entry elsewhere. */
const STRUCTURALLY_TOTAL_RE = /structurally total/i;

function structurallyTotalMarkerNear(source: string, symbol: string): boolean {
  const declLineRe = new RegExp(`^(?:export )?const ${escapeRegExp(symbol)}\\b`, "m");
  const m = declLineRe.exec(source);
  if (!m) return false;
  const lineStart = source.lastIndexOf("\n", m.index) + 1;
  const priorLines = source.slice(0, lineStart).split("\n").slice(-6).join("\n");
  const lineEnd = source.indexOf("\n", m.index);
  const declLine = source.slice(m.index, lineEnd === -1 ? source.length : lineEnd);
  return STRUCTURALLY_TOTAL_RE.test(`${priorLines}\n${declLine}`);
}

/** Every `.test(...)` / `.exec(...)` (or, for a FixClass row, `.matchesFailure(...)`) invocation
 *  of `symbol` in `testSource`, each paired with a window of text around it wide enough to hold
 *  the enclosing assertion. Not a parser -- same trade-off the two precedent ratchets make. */
function invocationWindows(symbol: string, method: string, testSource: string): string[] {
  const invokeRe = new RegExp(`\\b${escapeRegExp(symbol)}\\.${method}\\(`, "g");
  const windows: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = invokeRe.exec(testSource))) {
    let i = m.index + m[0].length;
    let depth = 1;
    for (; i < testSource.length && depth > 0; i++) {
      if (testSource[i] === "(") depth++;
      else if (testSource[i] === ")") depth--;
    }
    const windowStart = Math.max(0, m.index - 120);
    const windowEnd = Math.min(testSource.length, i + 200);
    windows.push(testSource.slice(windowStart, windowEnd));
  }
  return windows;
}

function concatTrackedSource(root: string, files: string[]): string {
  let out = "";
  for (const f of files) out += readFileSync(join(root, f), "utf8") + "\n";
  return out;
}

// ──────────────────────── detector (a): module-scope `_RE` validator surfaces ─────────────────

const RE_DECL_RE = /^(?:export )?const ([A-Z][A-Z0-9_]*_RE)\b\s*=/;

interface ReSurface {
  file: string;
  symbol: string;
  structurallyTotal: boolean;
}

/** Every module-scope (unindented) `NAME_RE = ...` declaration in `source`, `export`ed or not --
 *  see the file header for why "exported only" (the filing shard's own literal grep) is corrected
 *  here to cover this codebase's actual population of module-private validators. */
function reSurfacesInSource(file: string, source: string): ReSurface[] {
  const surfaces: ReSurface[] = [];
  for (const lineText of source.split("\n")) {
    const m = RE_DECL_RE.exec(lineText);
    if (!m) continue;
    surfaces.push({
      file,
      symbol: m[1],
      structurallyTotal: structurallyTotalMarkerNear(source, m[1]),
    });
  }
  return surfaces;
}

function allReSurfaces(root: string): ReSurface[] {
  const surfaces: ReSurface[] = [];
  for (const file of trackedFiles(root, SRC_TS_RE)) {
    surfaces.push(...reSurfacesInSource(file, readFileSync(join(root, file), "utf8")));
  }
  return surfaces;
}

/** A `_RE` surface is satisfied only by BOTH an invocation whose enclosing assertion rejects
 *  (drives the unhealthy arm) AND one whose enclosing assertion accepts (design note ii's "distinct
 *  from acceptance") -- either alone, or a bare invocation with no outcome-asserting window at all
 *  (a test that "merely touches the symbol", acceptance criterion 2), satisfies nothing. */
function reSurfaceExercised(symbol: string, testSource: string): boolean {
  let hasNegative = false;
  let hasPositive = false;
  for (const method of ["test", "exec"]) {
    for (const win of invocationWindows(symbol, method, testSource)) {
      if (/\bfalse\b|,\s*null\s*\)|===\s*null\b/.test(win)) hasNegative = true;
      // A `.test(...)` positive is `true`; a `.exec(...)` positive is either `!== null` or, more
      // idiomatically in this codebase, a captured-group read straight off the call (`)?.[1]` /
      // `)[1]`), which only makes sense against a successful match.
      if (/\btrue\b|!==\s*null\b|\)\??\.\[/.test(win)) hasPositive = true;
    }
  }
  return hasNegative && hasPositive;
}

interface FixturelessViolation {
  file: string;
  actual: number;
  baseline: number;
  symbols: string[];
}

/** A file with no row in `baseline` enters at an allowance of zero -- true for a brand-new file
 *  and, since lookup is purely by current path, for a renamed one too (mirrors
 *  catch-erasure-ratchet.test.ts's `bareCatchViolations`). */
function reFixturelessViolations(root: string, baseline: Record<string, number>): FixturelessViolation[] {
  const testSource = concatTrackedSource(root, trackedFiles(root, TEST_SRC_RE));
  const byFile = new Map<string, string[]>();
  for (const s of allReSurfaces(root)) {
    if (s.structurallyTotal) continue;
    if (reSurfaceExercised(s.symbol, testSource)) continue;
    const arr = byFile.get(s.file) ?? [];
    arr.push(s.symbol);
    byFile.set(s.file, arr);
  }
  const violations: FixturelessViolation[] = [];
  const allFiles = new Set([...byFile.keys(), ...Object.keys(baseline)]);
  for (const file of allFiles) {
    const symbols = byFile.get(file) ?? [];
    const allowed = baseline[file] ?? 0;
    if (symbols.length > allowed) violations.push({ file, actual: symbols.length, baseline: allowed, symbols });
  }
  return violations;
}

// ───────────────────────── detector (b): `DEFAULT_FIX_CLASSES` row surfaces ───────────────────

/** Every member identifier of the `DEFAULT_FIX_CLASSES` array literal, bracket-matched (not a
 *  parser) starting from the `=` that assigns it, wherever that array is declared in tracked
 *  src/**\/*.ts. */
function fixClassSurfaces(root: string): ReSurface[] {
  const declaringFiles = execFileSync(
    "git",
    ["-C", root, "grep", "-l", "export const DEFAULT_FIX_CLASSES", "--", "src/"],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);
  const rows: ReSurface[] = [];
  for (const file of declaringFiles) {
    const source = readFileSync(join(root, file), "utf8");
    const declRe = /DEFAULT_FIX_CLASSES\s*(?::[^=]+)?=\s*\[/;
    const m = declRe.exec(source);
    if (!m) continue;
    const bracketStart = m.index + m[0].length - 1; // position of the array literal's own `[`
    let depth = 1;
    let i = bracketStart + 1;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === "[") depth++;
      else if (source[i] === "]") depth--;
    }
    const body = source.slice(bracketStart + 1, i - 1);
    for (const raw of body.split(",")) {
      const symbol = raw.trim();
      if (!symbol) continue;
      rows.push({ file, symbol, structurallyTotal: structurallyTotalMarkerNear(source, symbol) });
    }
  }
  return rows;
}

/** A row is satisfied only by BOTH a fixture asserting it does NOT match an unrelated failure
 *  (`ROW.matchesFailure(x) === false`) AND a fixture naming it as the matched class -- either a
 *  direct `ROW.matchesFailure(x) === true` or (the idiomatic shape in this codebase, run through
 *  the reconciler rather than the predicate directly) an assertion of the shape
 *  `assert.equal(<something>.fixClassId, ROW.id)`, design note ii's own "asserts the match names
 *  its class". */
function fixClassSurfaceExercised(symbol: string, testSource: string): boolean {
  const idNamedRe = new RegExp(`,\\s*${escapeRegExp(symbol)}\\.id\\s*\\)`);
  let hasPositive = idNamedRe.test(testSource);
  let hasNegative = false;
  for (const win of invocationWindows(symbol, "matchesFailure", testSource)) {
    if (/\bfalse\b/.test(win)) hasNegative = true;
    if (/\btrue\b/.test(win)) hasPositive = true;
  }
  return hasPositive && hasNegative;
}

function fixClassFixturelessViolations(root: string, baseline: Record<string, number>): FixturelessViolation[] {
  const testSource = concatTrackedSource(root, trackedFiles(root, TEST_SRC_RE));
  const byFile = new Map<string, string[]>();
  for (const s of fixClassSurfaces(root)) {
    if (s.structurallyTotal) continue;
    if (fixClassSurfaceExercised(s.symbol, testSource)) continue;
    const arr = byFile.get(s.file) ?? [];
    arr.push(s.symbol);
    byFile.set(s.file, arr);
  }
  const violations: FixturelessViolation[] = [];
  const allFiles = new Set([...byFile.keys(), ...Object.keys(baseline)]);
  for (const file of allFiles) {
    const symbols = byFile.get(file) ?? [];
    const allowed = baseline[file] ?? 0;
    if (symbols.length > allowed) violations.push({ file, actual: symbols.length, baseline: allowed, symbols });
  }
  return violations;
}

// ──────────────────────────────────────── the baseline tables ─────────────────────────────────
// Both generated by running the two detectors above over `git ls-files`-tracked src/**/*.ts and
// test/**/*.ts at this task's HEAD -- today's measured population, not a hand-picked target.
// Reducing any number is a one-line reviewed diff -- the ratchet only ever tightens. Growing one,
// or adding a row for a file not already here, is what this gate exists to refuse.

const BASELINE_RE_FIXTURELESS: Record<string, number> = {
  "src/lib/autonomy.ts": 1,
  "src/lib/containment.ts": 7,
  "src/lib/dep-review.ts": 2,
  "src/lib/escalate.ts": 4,
  "src/lib/feedback-docket.ts": 1,
  "src/lib/fleet-control.ts": 1,
  "src/lib/image-drift.ts": 1,
  "src/lib/inbox.ts": 4,
  "src/lib/isolation.ts": 3,
  "src/lib/onboard/recon.ts": 2,
  "src/lib/plan-pr-emitter.ts": 2,
  "src/lib/retro.ts": 7,
  "src/lib/review.ts": 35,
  "src/lib/risk-score.ts": 2,
  "src/lib/specialist-panel.ts": 1,
  "src/lib/status.ts": 4,
  "src/lib/sweep.ts": 2,
  "src/lib/task-class.ts": 5,
  "src/lib/task-id.ts": 2,
  "src/lib/task-linter.ts": 4,
  "src/lib/verdict-calibration.ts": 1,
  "src/run-task.ts": 4,
};

const BASELINE_FIX_CLASS_FIXTURELESS: Record<string, number> = {
  "src/lib/sweep.ts": 1, // CI_GATE_TIMEOUT_FIX_CLASS -- matched only through the reconciler's
  // dispatch (naming its class via `.cls.id`/`.fixClassId`), never a direct
  // `.matchesFailure(x) === false` on an unrelated red; see post-fix-reverification.test.ts.
};

// ──────────────────────────────────────── fixture helpers ─────────────────────────────────────

function initFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "negative-reachability-ratchet-fixture-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", dir], { encoding: "utf8", env: GIT_ENV });
  return dir;
}

function commitFixture(dir: string): void {
  execFileSync("git", ["-C", dir, "add", "-A"], { encoding: "utf8", env: GIT_ENV });
  execFileSync("git", ["-C", dir, "commit", "--quiet", "-m", "fixture"], {
    encoding: "utf8",
    env: GIT_ENV,
  });
}

// ─────────────────────────────────────────────── tests ────────────────────────────────────────

// ── pure classification: what satisfies a `_RE` surface, and what does not

test("negative-reachability-ratchet: a fixture merely touching the symbol (no invocation) satisfies nothing (acceptance criterion 2)", () => {
  const testSource = `
    import { WIDGET_ID_RE } from "../src/lib/widget.js";
    test("widget id regex exists", () => {
      assert.ok(WIDGET_ID_RE);
    });
  `;
  assert.equal(reSurfaceExercised("WIDGET_ID_RE", testSource), false);
});

test("negative-reachability-ratchet: a fixture exercising only the healthy arm satisfies nothing (acceptance criterion 2)", () => {
  const testSource = `
    test("widget id regex accepts a real id", () => {
      assert.equal(WIDGET_ID_RE.test("W-123"), true);
    });
  `;
  assert.equal(reSurfaceExercised("WIDGET_ID_RE", testSource), false);
});

test("negative-reachability-ratchet: a fixture driving the unhealthy arm AND asserting a distinct healthy-arm output satisfies the surface (acceptance criterion 3)", () => {
  const testSource = `
    test("widget id regex", () => {
      assert.equal(WIDGET_ID_RE.test("W-123"), true);
      assert.equal(WIDGET_ID_RE.test("garbage"), false);
    });
  `;
  assert.equal(reSurfaceExercised("WIDGET_ID_RE", testSource), true);
});

test("negative-reachability-ratchet: exec-shaped surfaces are recognised the same way, via null vs. a captured match", () => {
  const bothArms = `
    test("trailer regex", () => {
      assert.equal(TRAILER_RE.exec("garbage"), null);
      assert.equal(TRAILER_RE.exec("Remudero-Task: W1-T1")?.[1], "W1-T1");
    });
  `;
  assert.equal(reSurfaceExercised("TRAILER_RE", bothArms), true);

  const negativeOnly = `
    test("trailer regex rejects garbage", () => {
      assert.equal(TRAILER_RE.exec("garbage"), null);
    });
  `;
  assert.equal(reSurfaceExercised("TRAILER_RE", negativeOnly), false);
});

test("negative-reachability-ratchet: a structurally-total validator passes via its in-place sentence, with no fixture at all (acceptance criterion 4)", () => {
  const source = [
    "/** Matches any non-empty token -- structurally total, cannot fail: every accept path already",
    " *  requires a non-empty string upstream. */",
    "export const ANY_TOKEN_RE = /\\S+/;",
    "",
  ].join("\n");
  const surfaces = reSurfacesInSource("src/lib/whatever.ts", source);
  assert.deepEqual(surfaces, [
    { file: "src/lib/whatever.ts", symbol: "ANY_TOKEN_RE", structurallyTotal: true },
  ]);
});

test("negative-reachability-ratchet: the same declaration with no marker sentence is NOT exempt", () => {
  const source = ["export const ANY_TOKEN_RE = /\\S+/;", ""].join("\n");
  const surfaces = reSurfacesInSource("src/lib/whatever.ts", source);
  assert.equal(surfaces[0].structurallyTotal, false);
});

test("negative-reachability-ratchet: an indented (function-local) `_RE` declaration is not enumerated as a module-scope surface", () => {
  const source = ["function f() {", "  const LOCAL_RE = /x/;", "  return LOCAL_RE;", "}", ""].join("\n");
  assert.deepEqual(reSurfacesInSource("src/lib/whatever.ts", source), []);
});

// ── pure classification: the FixClass row detector

test("negative-reachability-ratchet: a FixClass row fixture that only proves the negative arm satisfies nothing", () => {
  const testSource = `assert.equal(SOME_FIX_CLASS.matchesFailure(unrelated), false);`;
  assert.equal(fixClassSurfaceExercised("SOME_FIX_CLASS", testSource), false);
});

test("negative-reachability-ratchet: a FixClass row fixture proving both arms -- match names its class, and an unrelated red is refused -- satisfies the surface", () => {
  const testSource = `
    assert.equal(SOME_FIX_CLASS.matchesFailure(unrelated), false);
    assert.equal(summary.results[0].fixClassId, SOME_FIX_CLASS.id);
  `;
  assert.equal(fixClassSurfaceExercised("SOME_FIX_CLASS", testSource), true);
});

test("negative-reachability-ratchet: fixClassSurfaces enumerates DEFAULT_FIX_CLASSES's members by bracket-matching the array literal, never the type annotation's own brackets", () => {
  const dir = initFixtureRepo();
  try {
    mkdirSync(join(dir, "src", "lib"), { recursive: true });
    writeFileSync(
      join(dir, "src", "lib", "sweep.ts"),
      [
        "export interface FixClass { id: string; matchesFailure: (x: unknown) => boolean; }",
        'export const ROW_A: FixClass = { id: "a", matchesFailure: () => false };',
        'export const ROW_B: FixClass = { id: "b", matchesFailure: () => false };',
        "export const DEFAULT_FIX_CLASSES: readonly FixClass[] = [",
        "  ROW_A,",
        "  ROW_B,",
        "];",
        "",
      ].join("\n"),
    );
    commitFixture(dir);
    const surfaces = fixClassSurfaces(dir);
    assert.deepEqual(
      surfaces.map((s) => s.symbol),
      ["ROW_A", "ROW_B"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── wiring: the git-ls-files-driven violation functions, on isolated fixture repos

test("negative-reachability-ratchet: a fixture-less surface past its file's baseline fails naming file and surface (acceptance criterion 1)", () => {
  const dir = initFixtureRepo();
  try {
    mkdirSync(join(dir, "src", "lib"), { recursive: true });
    mkdirSync(join(dir, "test"), { recursive: true });
    writeFileSync(
      join(dir, "src", "lib", "widget.ts"),
      ["export const WIDGET_ID_RE = /^W-\\d+$/;", "export const OTHER_RE = /^X$/;", ""].join("\n"),
    );
    // OTHER_RE is fully exercised; WIDGET_ID_RE has no fixture at all.
    writeFileSync(
      join(dir, "test", "widget.test.ts"),
      [
        'test("other", () => {',
        '  assert.equal(OTHER_RE.test("X"), true);',
        '  assert.equal(OTHER_RE.test("y"), false);',
        "});",
        "",
      ].join("\n"),
    );
    commitFixture(dir);

    const violations = reFixturelessViolations(dir, { "src/lib/widget.ts": 0 });
    assert.deepEqual(violations, [
      { file: "src/lib/widget.ts", actual: 1, baseline: 0, symbols: ["WIDGET_ID_RE"] },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("negative-reachability-ratchet: a brand-new file with any fixture-less surface enters at zero baseline and fails immediately -- no allowlist to add it to", () => {
  const dir = initFixtureRepo();
  try {
    mkdirSync(join(dir, "src", "lib"), { recursive: true });
    writeFileSync(join(dir, "src", "lib", "brand-new.ts"), "export const NEW_THING_RE = /^n$/;\n");
    commitFixture(dir);

    const violations = reFixturelessViolations(dir, {});
    assert.deepEqual(violations, [
      { file: "src/lib/brand-new.ts", actual: 1, baseline: 0, symbols: ["NEW_THING_RE"] },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("negative-reachability-ratchet: a file dropping below its baseline passes with no edit to the gate (acceptance criterion 5)", () => {
  const dir = initFixtureRepo();
  try {
    mkdirSync(join(dir, "src", "lib"), { recursive: true });
    writeFileSync(join(dir, "src", "lib", "improved.ts"), "export const ONLY_ONE_RE = /^x$/;\n");
    commitFixture(dir);

    // Baseline still says 3 -- as if this file used to carry three fixture-less surfaces -- the
    // SAME table, unedited, accepts the improvement; the ratchet never demands the table be
    // lowered to pass.
    const violations = reFixturelessViolations(dir, { "src/lib/improved.ts": 3 });
    assert.deepEqual(violations, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("negative-reachability-ratchet: a new surface added to an already-baselined file pays immediately rather than entering the baseline (acceptance criterion 6)", () => {
  const dir = initFixtureRepo();
  try {
    mkdirSync(join(dir, "src", "lib"), { recursive: true });
    // First commit: one fixture-less surface, exactly matching its baseline allowance of 1.
    writeFileSync(join(dir, "src", "lib", "growing.ts"), "export const FIRST_RE = /^a$/;\n");
    commitFixture(dir);
    assert.deepEqual(reFixturelessViolations(dir, { "src/lib/growing.ts": 1 }), []);

    // The file changes: a second fixture-less surface is added. The baseline table is NOT
    // touched -- the new surface must pay immediately, not be silently absorbed.
    writeFileSync(
      join(dir, "src", "lib", "growing.ts"),
      ["export const FIRST_RE = /^a$/;", "export const SECOND_RE = /^b$/;", ""].join("\n"),
    );
    commitFixture(dir);
    const violations = reFixturelessViolations(dir, { "src/lib/growing.ts": 1 });
    assert.deepEqual(violations, [
      { file: "src/lib/growing.ts", actual: 2, baseline: 1, symbols: ["FIRST_RE", "SECOND_RE"] },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("negative-reachability-ratchet: a structurally-total surface never counts against its file's baseline, fixture or none", () => {
  const dir = initFixtureRepo();
  try {
    mkdirSync(join(dir, "src", "lib"), { recursive: true });
    writeFileSync(
      join(dir, "src", "lib", "total.ts"),
      [
        "/** structurally total -- \\S+ accepts every non-empty string reachable here. */",
        "export const ANY_RE = /\\S+/;",
        "",
      ].join("\n"),
    );
    commitFixture(dir);

    assert.deepEqual(reFixturelessViolations(dir, {}), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the real gates, as they run against this repo's own tracked sources

test("PROPERTY no tracked src/**/*.ts file's fixture-less `_RE` validator count exceeds its baseline", () => {
  const violations = reFixturelessViolations(REPO_ROOT, BASELINE_RE_FIXTURELESS);
  assert.deepEqual(
    violations,
    [],
    violations
      .map((v) => `${v.file}: ${v.actual} fixture-less surface(s) > baseline ${v.baseline} (${v.symbols.join(", ")})`)
      .join("\n"),
  );
});

test("PROPERTY no DEFAULT_FIX_CLASSES row's fixture-less count exceeds its baseline", () => {
  const violations = fixClassFixturelessViolations(REPO_ROOT, BASELINE_FIX_CLASS_FIXTURELESS);
  assert.deepEqual(
    violations,
    [],
    violations
      .map((v) => `${v.file}: ${v.actual} fixture-less row(s) > baseline ${v.baseline} (${v.symbols.join(", ")})`)
      .join("\n"),
  );
});

test("negative-reachability-ratchet: every row in both baseline tables names a currently-tracked src/**/*.ts file (no stale allowance left behind by a rename)", () => {
  const tracked = new Set(trackedFiles(REPO_ROOT, SRC_TS_RE));
  for (const file of Object.keys(BASELINE_RE_FIXTURELESS)) {
    assert.equal(tracked.has(file), true, `${file} in the _RE baseline is no longer tracked`);
  }
  for (const file of Object.keys(BASELINE_FIX_CLASS_FIXTURELESS)) {
    assert.equal(tracked.has(file), true, `${file} in the FixClass baseline is no longer tracked`);
  }
});
