// test/a-relocation-across-files-is-still-a-relocation.test.ts — W1-T3138.
//
// `diff-coverage`'s module header already states the rule: "An added line whose identical text was
// REMOVED elsewhere in the same diff is a RELOCATION, not a regression, and is exempt". Until this
// task `computeRelocatedLines` opened with `removed.get(file)` and `continue`d on a miss, so the
// match never left the DESTINATION file — and an EXTRACTION, the most common large refactor here,
// inherited the whole moved region's coverage debt as freshly added lines.
//
// MEASURED before the fix, by calling the exported function rather than reading it: an identical
// 8-line body moved WITHIN one file exempted 8 lines; the same body moved to a DIFFERENT file
// exempted 0. On #4522's real diff (the console shell's client lifted out of a template literal
// in serve.ts) `diff-coverage` blocked 1143 lines while 3346 of 3820 added non-blank lines had an
// identical trimmed counterpart among the 3651 removed from serve.ts.
//
// The predicate stays TEXTUAL and evidence-based: an added line is exempt only when the same text
// was removed in the same diff. A moved line that is also EDITED does not match and stays blocking,
// which is what makes widening the search as safe as the same-file case already shipped.

import assert from "node:assert/strict";
import { test } from "node:test";

import { fileURLToPath, pathToFileURL } from "node:url";

// `scripts/**` sits OUTSIDE tsconfig's `include`, so a STATIC import of this module is a TS7016
// ("could not find a declaration file"). A dynamic specifier is not statically resolved, so this
// loads the REAL module with no shadow copy and no ambient declaration — the same idiom
// test/comment-load-ratchet.test.ts uses for the same reason.
const SCRIPT = fileURLToPath(new URL("../scripts/diff-coverage.mjs", import.meta.url));
const { MIN_RELOCATION_RUN, computeRelocatedLines } = (await import(pathToFileURL(SCRIPT).href)) as {
  MIN_RELOCATION_RUN: number;
  computeRelocatedLines: (
    added: Map<string, Map<number, string>>,
    removed: Map<string, Map<number, string>>,
    opts?: { minRun?: number },
  ) => Map<string, Map<number, { counterpartLine: number; runLength: number; counterpartFile: string }>>;
};

/** A body long enough to clear MIN_RELOCATION_RUN, as `[line, text]` pairs from `start`. */
const body = (n: number, prefix = "const v"): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${i} = ${i};`);

const at = (file: string, start: number, lines: string[]): Map<string, Map<number, string>> =>
  new Map([[file, new Map(lines.map((t, i) => [start + i, t]))]]);

const merge = (...maps: Array<Map<string, Map<number, string>>>): Map<string, Map<number, string>> => {
  const out = new Map<string, Map<number, string>>();
  for (const m of maps) for (const [f, lines] of m) out.set(f, new Map([...(out.get(f) ?? new Map()), ...lines]));
  return out;
};

const exemptLines = (r: Map<string, Map<number, unknown>>, file: string): number[] => [...(r.get(file)?.keys() ?? [])];

// ── acceptance 1: a cross-file move is exempt, and the report names where it came from ───────────

test("W1-T3138: a run whose identical text was removed from a DIFFERENT file is exempt, naming that file", () => {
  const moved = body(8);
  const r = computeRelocatedLines(at("src/new-home.ts", 100, moved), at("src/old-home.ts", 10, moved));
  assert.equal(exemptLines(r, "src/new-home.ts").length, 8, "every line of the moved run is exempt");

  const first = r.get("src/new-home.ts")!.get(100)!;
  assert.equal(first.counterpartFile, "src/old-home.ts", "the exemption names the file the text came FROM");
  assert.equal(first.counterpartLine, 10, "and the exact line, so a reviewer can check the claim");
  assert.equal(first.runLength, 8);
});

// ── acceptance 2: an EDITED run is not a move ────────────────────────────────────────────────────

test("W1-T3138: a run that was EDITED rather than moved stays BLOCKING", () => {
  const original = body(8);
  const edited = [...original];
  edited[3] = "const v3 = 999; // changed while moving";
  // The edit splits the run into 3 + 4, both under the floor, so NOTHING is exempt — the exemption
  // turns on identical text, never on the author's intent.
  const r = computeRelocatedLines(at("src/new-home.ts", 100, edited), at("src/old-home.ts", 10, original));
  assert.deepEqual(exemptLines(r, "src/new-home.ts"), [], "an edited move is not a relocation");
});

// ── acceptance 3: the run floor holds across files, and a run may not span two sources ───────────

test("W1-T3138: a run shorter than MIN_RELOCATION_RUN is refused across files exactly as within one", () => {
  const short = body(MIN_RELOCATION_RUN - 1);
  const cross = computeRelocatedLines(at("src/new-home.ts", 100, short), at("src/old-home.ts", 10, short));
  assert.deepEqual(exemptLines(cross, "src/new-home.ts"), [], "below the floor, cross-file");

  // CONTROL: the identical short run within ONE file is refused too, so the floor is the reason and
  // not the file boundary.
  const same = computeRelocatedLines(at("src/one.ts", 100, short), at("src/one.ts", 10, short));
  assert.deepEqual(exemptLines(same, "src/one.ts"), [], "below the floor, same-file — same answer");
});

test("W1-T3138: a run may NOT be assembled from fragments of two different source files", () => {
  const whole = body(8);
  // Each source holds only half the run, so no single contiguous source run reaches the floor.
  // Stitching them would be the way a too-eager predicate manufactures an exemption.
  const r = computeRelocatedLines(
    at("src/new-home.ts", 100, whole),
    merge(at("src/left.ts", 10, whole.slice(0, 4)), at("src/right.ts", 50, whole.slice(4))),
  );
  assert.deepEqual(exemptLines(r, "src/new-home.ts"), [], "a relocation must map onto ONE source file");
});

// ── acceptance 4: one removed run cannot be spent twice ──────────────────────────────────────────

test("W1-T3138: duplicating a block into TWO destinations exempts only the first — a removed run is spent once", () => {
  const moved = body(8);
  const r = computeRelocatedLines(
    merge(at("src/copy-a.ts", 100, moved), at("src/copy-b.ts", 200, moved)),
    at("src/old-home.ts", 10, moved),
  );
  const a = exemptLines(r, "src/copy-a.ts").length;
  const b = exemptLines(r, "src/copy-b.ts").length;
  assert.equal(a + b, 8, "the single removed run covers exactly one destination, not both");
  assert.ok((a === 8 && b === 0) || (a === 0 && b === 8), `one destination takes it whole (got ${a}/${b})`);
});

// ── acceptance 5: the same-file case is unchanged, and is searched FIRST ─────────────────────────

test("W1-T3138: a same-file relocation still pairs against its OWN file, even when another file offers the same text", () => {
  const moved = body(8);
  // Both the destination's own removed lines AND a decoy file carry the identical text. The
  // destination's own must win: today's verdicts have to stay a strict subset of tomorrow's.
  const r = computeRelocatedLines(
    at("src/self.ts", 100, moved),
    merge(at("src/self.ts", 10, moved), at("src/decoy.ts", 500, moved)),
  );
  assert.equal(exemptLines(r, "src/self.ts").length, 8);
  const first = r.get("src/self.ts")!.get(100)!;
  assert.equal(first.counterpartFile, "src/self.ts", "the same-file pairing wins over an equally good stranger");
  assert.equal(first.counterpartLine, 10, "and against its own line, exactly as before this task");
});
