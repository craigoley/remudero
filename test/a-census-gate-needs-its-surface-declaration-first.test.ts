/**
 * test/a-census-gate-needs-its-surface-declaration-first.test.ts — the sequencing hole Rule 25's
 * carve-outs leave open, and the one line that closes it for W1-T3272.
 *
 * W1-T2521 carved out a new census gate shipped with its own `CI_PARITY_TABLE` registration, and
 * W1-T2738 extended that to a new ci.yml JOB. Both key on `isIntroducingCensusGate`, and both read
 * `INSTRUMENT_SURFACE` AS COMPILED INTO THE REVIEWER — never the declaration the diff is adding. A
 * gate script whose path matches no existing surface pattern is therefore not an instrument to the
 * predicate at all, so neither arm can subtract it, while `test/instrument-surface-completeness.ts`
 * refuses the script unless the SAME diff declares it. The declaration is a `src/lib/review.ts`
 * hunk, `src/lib/review.ts` is a product path, and nothing subtracts it: the mixture is refused.
 *
 * MEASURED on #4851's real diff, `detectInstrumentEntanglement` against the shipped predicate:
 *   AS FILED    ci.yml step + new scripts/expiring-fixture-census.mjs + ci-parity disclosure
 *               + this declaration, judged with a reviewer that does NOT carry it -> TRUE
 *   DECLARED    the same diff minus the src/lib/review.ts hunk, judged with a reviewer
 *               that DOES carry it                                                -> FALSE
 *   UNDECLARED  the same diff minus the hunk, reviewer without it                 -> TRUE
 * The middle row is the admissible ordering, and the third is why the declaration cannot simply be
 * dropped: it has to be ON MAIN before the gate that needs it, not merely out of the gate's diff.
 *
 * So this suite is the falsifier for exactly one line of `INSTRUMENT_SURFACE`. Delete
 * `^scripts/expiring-fixture-census\.mjs$` and the DECLARED case flips back to entangled.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { INSTRUMENT_SURFACE, detectInstrumentEntanglement } from "../src/lib/review.js";

const CENSUS_SCRIPT = "scripts/expiring-fixture-census.mjs";

/** A real `git diff` block for a brand-new file — the `new file mode` and `/dev/null` markers
 *  `fileIsNewInDiff` actually reads, never a hand-waved approximation of them. */
function newFile(path: string, line: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    `+++ b/${path}`,
    "@@ -0,0 +1,1 @@",
    `+${line}`,
    "",
  ].join("\n");
}

/** A real `git diff` block for an EDIT to a file that already existed — no new-file marker. The
 *  `@@` trailing text is git's own function context, which `changeIsConfinedToRegistry` reads. */
function edit(path: string, added: string, context: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -10,3 +10,4 @@ ${context}`,
    " keep",
    `+${added}`,
    " keep",
    "",
  ].join("\n");
}

function verdict(diff: string): { entangled: boolean; instrumentPaths: string[]; srcPaths: string[] } {
  const files = [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]!);
  return detectInstrumentEntanglement(files, diff);
}

/** #4851's shape: the census script, its ci.yml STEP (no new job key), and the `CENSUS_POPULATION`
 *  disclosure line in `src/lib/ci-parity.ts` that names its stem. */
const GATE_HALF = [
  newFile(CENSUS_SCRIPT, "export const MARGIN_DAYS = 7;"),
  edit(".github/workflows/ci.yml", `        run: node ${CENSUS_SCRIPT}`, "comment-load-ratchet:"),
  edit(
    "src/lib/ci-parity.ts",
    '    refusedForPredicate("test/expiring-fixture-census.test.ts", "a", "not a src-population walk"),',
    "export const CENSUS_POPULATION: readonly CensusPopulationMember[] = [",
  ),
].join("");

/** The `src/lib/review.ts` hunk that declares the script — the half with no carve-out. */
const DECLARATION_HALF = edit(
  "src/lib/review.ts",
  `  "^scripts/expiring-fixture-census\\\\.mjs$",`,
  "export const INSTRUMENT_SURFACE: readonly string[] = [",
);

test("the declaration this file falsifies is the only thing that puts the census script on the instrument surface", () => {
  const declared = INSTRUMENT_SURFACE.filter((p) => new RegExp(p).test(CENSUS_SCRIPT));
  assert.deepEqual(
    declared,
    ["^scripts/expiring-fixture-census\\.mjs$"],
    "exactly one INSTRUMENT_SURFACE entry may cover the census script — a second would make this suite pass without it",
  );
});

test("DECLARED: with the surface entry already on main, the gate's own diff is not entangled", () => {
  const r = verdict(GATE_HALF);
  assert.ok(
    r.instrumentPaths.includes(CENSUS_SCRIPT),
    `the declaration is what makes ${CENSUS_SCRIPT} an instrument; without it isIntroducingCensusGate cannot see the gate at all`,
  );
  assert.equal(
    r.entangled,
    false,
    "a new census gate plus its ci-parity disclosure is W1-T2521's sanctioned shape once the script is on the surface",
  );
  assert.deepEqual(r.srcPaths, ["src/lib/ci-parity.ts"], "the only src/ path is the registration the carve-out subtracts");
});

test("AS FILED: the same gate carrying its own surface declaration IS entangled — the hole this ordering works around", () => {
  const r = verdict(GATE_HALF + DECLARATION_HALF);
  assert.equal(
    r.entangled,
    true,
    "src/lib/review.ts is a product path with no carve-out arm, so shipping the declaration beside the gate is refused",
  );
  assert.ok(
    r.srcPaths.includes("src/lib/review.ts"),
    "and review.ts is the src/ half that survives every subtraction — the evidence names it",
  );
});

test("a ci.yml step, unlike a job, reaches no introducing-commit carve-out of its own", () => {
  // The control for the DECLARED case above: strip the script and its disclosure and the SAME
  // ci.yml step entangles against an ordinary product edit. Nothing about a step is exempt.
  const r = verdict(
    edit(".github/workflows/ci.yml", `        run: node ${CENSUS_SCRIPT}`, "comment-load-ratchet:") +
      edit("src/lib/drain.ts", "  const extra = 1;", "function drain() {"),
  );
  assert.equal(r.entangled, true, "ci.yml beside an ordinary src/ statement is the rule's own base case");
});
