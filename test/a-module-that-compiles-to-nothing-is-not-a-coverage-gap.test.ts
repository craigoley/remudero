// W1-T2570: the sharded coverage gate hard-blocks any changed `src/**.ts` with no `SF:` record,
// but "no SF record" has TWO causes and it treated them as one:
//
//   1. no shard imported the file — the real vacuity hazard, and failing closed on it is right.
//      Sharding is what makes it material: a scoped run whose suites never import a changed file
//      emits no records for it, so "every added line lcov instruments is covered" is trivially
//      true over an EMPTY SET (#1399).
//   2. THE FILE COMPILES TO NOTHING EXECUTABLE, so there was no instrumentation to emit.
//
// A pure type module hits case 2 and received case 1's verdict, under a message — "coverage would
// otherwise pass vacuously" — that is exactly backwards for it. Nothing passed vacuously; there
// was nothing to measure. Four such files are on main, and they exist deliberately to cut
// dependency cycles (.dependency-cruiser.cjs `no-circular`), so this is a shape the repo's own
// architecture rules produce rather than a rarity that could be refactored away.
//
// ⚠ THE DISCRIMINATOR IS A TRANSPILE, NEVER A TEXT SCAN. A first pass at this census read source
// text for `function`/`class`/`=>` and wrongly called `src/lib/proof-grammar.ts` type-only — it is
// 1,423 bytes of real emitted code. That file is the control below precisely because it is the one
// a naive heuristic gets wrong.

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

// `scripts/**` sits OUTSIDE tsconfig's `include`, so a static import of a .mjs there is a TS7016 —
// the same reason test/acceptance-author-gate.test.ts and test/mutation-ratchet.test.ts reach their
// scripts through a runtime import rather than a typed one. A dynamic specifier is not statically
// resolved, so this loads the REAL module with no shadow copy to drift from it.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** What `isTypeOnlyModule` reports when it CANNOT decide — the verdict still fails closed. */
type Undecidable = { file: string; stage: string; message: string };

const mod = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "diff-coverage.mjs")).href)) as {
  isTypeOnlyModule: (file: string, readSource?: (f: string) => string) => boolean;
  findMissingSourceCoverage: (
    diffText: string,
    lcov: Set<string>,
    isTypeOnly?: (f: string, readSource?: unknown, onUndecidable?: (d: Undecidable) => void) => boolean,
    onUndecidable?: (d: Undecidable) => void,
  ) => string[];
};
const { findMissingSourceCoverage, isTypeOnlyModule } = mod;

/** A diff touching one file, in the shape `changedSourceFiles` parses. */
const diffTouching = (...files: string[]) =>
  files.map((f) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1,2 @@\n code\n+more\n`).join("");

// ── The discriminator, against the repo's own real files ─────────────────────────────────────

test("every type-only module on main is recognised, and the files a text scan gets wrong are NOT", () => {
  // These four are the measured census in this task's own shard.
  for (const f of ["src/lib/workflow-run.ts", "src/lib/merge-state.ts", "src/lib/run-result.ts", "src/lib/supersession.ts"]) {
    assert.equal(isTypeOnlyModule(f), true, `${f} emits zero bytes and cannot ever carry a coverage hit`);
  }
  // ⚠ THE CONTROL THAT MAKES THE FOUR ABOVE MEAN SOMETHING. proof-grammar.ts LOOKS type-only to a
  // naive text scan and is not; sweep.ts is unambiguous. If either ever reads type-only, the
  // carve-out has widened onto files that genuinely need coverage.
  assert.equal(isTypeOnlyModule("src/lib/proof-grammar.ts"), false, "1,423 bytes of real emitted code — the naive-heuristic trap");
  assert.equal(isTypeOnlyModule("src/lib/sweep.ts"), false, "136,412 bytes");
});

test("the discriminator is a TRANSPILE, so type-only syntax with no emit is exempt and one statement is not", () => {
  const read = (src: string) => () => src;
  assert.equal(isTypeOnlyModule("x.ts", read("export interface A { a: string }\nexport type B = A | null;\n")), true);
  assert.equal(isTypeOnlyModule("x.ts", read("import type { X } from './x.js';\nexport type Y = X;\n")), true, "a type-only import erases");
  // A single runtime statement is enough to disqualify — the carve-out must be exactly "emits
  // nothing", never "emits little".
  assert.equal(isTypeOnlyModule("x.ts", read("export interface A { a: string }\nexport const z = 1;\n")), false);
  assert.equal(isTypeOnlyModule("x.ts", read("export enum E { A }\n")), false, "an enum emits a real runtime object");
});

test("FAILS CLOSED on any doubt — unreadable or unparseable keeps its coverage requirement", () => {
  const throwing = () => {
    throw new Error("ENOENT");
  };
  assert.equal(isTypeOnlyModule("gone.ts", throwing), false, "an unreadable file must not be exempted");
  assert.equal(
    isTypeOnlyModule("bad.ts", () => "export interface { !!! syntax"),
    false,
    "a file that cannot be transpiled must not be exempted — a carve-out that widens on an error is worse than the block it removes",
  );
});

// ── The gate itself ──────────────────────────────────────────────────────────────────────────

test("a changed type-only module with no SF record is NOT reported as a coverage gap", () => {
  const missing = findMissingSourceCoverage(diffTouching("src/lib/merge-state.ts"), new Set<string>());
  assert.deepEqual(missing, [], "there was nothing to measure — this is not the vacuity case the guard exists for");
});

test("⚠ case 1 STILL FAILS CLOSED — a real module no shard imported is still a coverage gap", () => {
  const missing = findMissingSourceCoverage(diffTouching("src/lib/sweep.ts"), new Set<string>());
  assert.deepEqual(
    missing,
    ["src/lib/sweep.ts"],
    "the vacuity hazard (#1399) is exactly what this gate is for — narrowing it away would be the worse defect",
  );
});

test("a mixed diff reports only the real gap, and a file WITH an SF record is never reported at all", () => {
  const diff = diffTouching("src/lib/merge-state.ts", "src/lib/sweep.ts", "src/lib/review.ts");
  assert.deepEqual(
    findMissingSourceCoverage(diff, new Set(["src/lib/review.ts"])),
    ["src/lib/sweep.ts"],
    "type-only exempt, instrumented file satisfied, and the genuinely-missing one still named",
  );
});

test("the type-only check is injectable, so the gate's own logic is provable without touching disk", () => {
  const diff = diffTouching("src/a.ts", "src/b.ts");
  assert.deepEqual(findMissingSourceCoverage(diff, new Set<string>(), (f) => f === "src/a.ts"), ["src/b.ts"]);
  assert.deepEqual(findMissingSourceCoverage(diff, new Set<string>(), () => true), [], "all exempt ⇒ nothing reported");
  assert.deepEqual(findMissingSourceCoverage(diff, new Set<string>(), () => false), ["src/a.ts", "src/b.ts"], "none exempt ⇒ both");
});

// ── CASE 3, ADDED 2026-09-09: the discriminator did not get to run at all ─────────────────────────
//
// A third cause of "no SF record" hid inside case 1's verdict for as long as the guard's only output
// was a boolean. `isTypeOnlyModule` fails CLOSED on a read or transpile error — correct, and the
// safe direction — but a type-only module then gets case 1's message anyway, and case 1's message
// implies a remedy ("write a test that exercises this file") that is IMPOSSIBLE for a module that
// compiles to nothing. There is nothing to instrument, so no test can ever produce its `SF:` record.
//
// MEASURED on #4872: `isTypeOnlyModule("src/lib/merge-state.ts")` returned TRUE locally while CI
// blocked on that exact file, on that exact head (`a16c794eb`), across two independent runs. Feeding
// the same diff a guard that always throws reproduces CI's output exactly — `["src/lib/merge-state.ts"]`
// — so the guard is failing in the runner. A bare `false` cannot say which of read/require/transpile
// failed, and a re-run reproduces it identically while teaching nothing.

test("a type-only check that could not be DECIDED is reported, not silently folded into the vacuity verdict", () => {
  const diff = diffTouching("src/lib/merge-state.ts");
  const seen: Undecidable[] = [];
  const throwingGuard = (file: string, _read?: unknown, onUndecidable?: (d: Undecidable) => void) => {
    onUndecidable?.({ file, stage: "transpile", message: "Cannot find module 'esbuild'" });
    return false; // the guard's own fail-closed verdict, unchanged
  };
  const missing = findMissingSourceCoverage(diff, new Set<string>(), throwingGuard, (d) => seen.push(d));

  assert.deepEqual(missing, ["src/lib/merge-state.ts"],
    "THE VERDICT MUST NOT MOVE — failing closed is still right, and an undecidable check must never become an exemption");
  assert.deepEqual(seen, [{ file: "src/lib/merge-state.ts", stage: "transpile", message: "Cannot find module 'esbuild'" }],
    "and the run must be able to SAY the exemption never got a chance to apply");
});

test("⚠ a check that DECIDES reports nothing — the diagnostic must not fire on the ordinary path", () => {
  const diff = diffTouching("src/lib/merge-state.ts", "src/lib/sweep.ts");
  const seen: Undecidable[] = [];
  const missing = findMissingSourceCoverage(diff, new Set<string>(), (f: string) => f === "src/lib/merge-state.ts", (d) => seen.push(d));
  assert.deepEqual(missing, ["src/lib/sweep.ts"], "exemption applied, real gap still named");
  assert.deepEqual(seen, [],
    "POSITIVE CONTROL: a guard that answers cleanly emits no diagnostic. Without this arm, a collector that fires on every file would pass the test above and flood every blocked report");
});
