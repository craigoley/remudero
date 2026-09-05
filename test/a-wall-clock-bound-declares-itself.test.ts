import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { assertWallClockBound } from "./helpers/wall-clock-bound.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = "test/helpers/wall-clock-bound.js";

// ── W1-T2811 ────────────────────────────────────────────────────────────────────────────────
//
// The recognizer for "an assertion that bounds a REAL elapsed measurement from above" — the only
// assertion shape a loaded host can fail with no defect in the code under test.
//
// IT LOOKS FOR THE BARE FORM, NOT FOR MEMBERSHIP. A migrated member calls
// `assertWallClockBound(measured, bound, msg)`, which carries no `<` and therefore stops matching
// on its own; nothing has to remember to remove it from a list. That is the whole design: the
// declaration is the call site, so the recognizer is EXACT rather than approximate, unlike a
// roster of test names (this repo already carries three of those) or `censusPopulationDrift`'s
// self-described "approximate by construction" text match.
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

// ── the helper's own contract ─────────────────────────────────────────────────────────────────

test("assertWallClockBound asserts exactly the bound the call site asserted -- no tolerance, no slack", () => {
  // The whole risk of routing 22 real assertions through one function is that the function
  // quietly weakens them. It must be the SAME comparison: strictly less than, no epsilon.
  assert.doesNotThrow(() => assertWallClockBound(1999, 2000, "under"));
  assert.throws(() => assertWallClockBound(2000, 2000, "exactly at the bound is NOT under it"), /exactly at the bound/);
  assert.throws(() => assertWallClockBound(2001, 2000, "over"), /over/);
  // A bound in minutes works the same as one in milliseconds -- the helper names no unit.
  assert.doesNotThrow(() => assertWallClockBound(0.5, 1, "half a minute"));
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

// ── the positive control, first: a recognizer that cannot see its own subject proves nothing ──

test("the recognizer FIRES on a bare wall-clock bound and stays quiet on the migrated form", () => {
  const bare = ["const t0 = Date.now();", "const elapsedMs = Date.now() - t0;", '  assert.ok(elapsedMs < 2000, "too slow");'].join("\n");
  const migrated = [
    "const t0 = Date.now();",
    "const elapsedMs = Date.now() - t0;",
    '  assertWallClockBound(elapsedMs, 2000, "too slow");',
  ].join("\n");

  assert.equal(bareBoundLines(bare).length, 1, "the recognizer must see a bare bound -- otherwise the census below is vacuous");
  assert.equal(bareBoundLines(migrated).length, 0, "the migrated form carries no `<`, so it stops matching on its own");

  // A bound on an INJECTED clock is not a member: load cannot make it fail.
  const injected = ['const elapsedMs = fakeClock.now() - t0;', '  assert.ok(elapsedMs < 2000, "deterministic");'].join("\n");
  assert.equal(bareBoundLines(injected).length, 0, "no real clock in the file -- not a member");
});

// ── the census ────────────────────────────────────────────────────────────────────────────────

test("every wall-clock-bounded assertion in the suite declares itself through the helper", () => {
  const candidates = candidateLines();
  assert.ok(candidates.length > 20, `the prefilter must be reading a real corpus, got ${candidates.length} candidate line(s)`);

  // Only the files the prefilter actually named get read -- a handful, not the whole suite.
  const byFile = new Map<string, Array<{ line: number; text: string }>>();
  for (const c of candidates) {
    if (c.file === "test/a-wall-clock-bound-declares-itself.test.ts") continue; // its own fixtures are strings
    if (!BARE_BOUND_RE.test(c.text)) continue;
    const list = byFile.get(c.file) ?? [];
    list.push({ line: c.line, text: c.text.trim() });
    byFile.set(c.file, list);
  }

  const undeclared: string[] = [];
  for (const [rel, hits] of byFile) {
    // The bounded value must come from a REAL clock somewhere in that file; an injected one
    // cannot be made to fail by load.
    if (!REAL_CLOCK_RE.test(readFileSync(join(REPO_ROOT, rel), "utf8"))) continue;
    for (const h of hits) undeclared.push(`${rel}:${h.line}  ${h.text}`);
  }

  assert.deepEqual(
    undeclared,
    [],
    `these assertions bound a REAL elapsed measurement without declaring it, so a loaded host reds ` +
      `them with no defect in the code under test. Replace each with ` +
      `assertWallClockBound(measured, bound, message) from ${HELPER}:\n  ` +
      undeclared.join("\n  "),
  );
});

test("the declared members import the helper -- the seam has actual declarers, not zero", () => {
  // Guards the OTHER direction of vacuity: a census that reads zero because nobody declares is
  // indistinguishable from one that reads zero because everybody does.
  const importers = execFileSync("git", ["grep", "-l", "helpers/wall-clock-bound.js", "--", "test/*.test.ts"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  assert.ok(
    importers.length >= 10,
    `the seam should have the migrated members as declarers; found ${importers.length}: ${importers.join(", ")}`,
  );
});
