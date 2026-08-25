import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── W1-T2276: a merged lcov's duplicate function-declaration records are reconciled ─────────
//
// `--experimental-test-coverage`'s own multi-process merge can emit a SECOND, MALFORMED record
// for `src/lib/ledger.ts` in which every function is declared exactly 3 lines above its true
// position (measured: 16 function names, all 16 deltas exactly 3; the uncorrupted control
// `appendLedger` carries exactly one `FN:` record). The merged lcov then splits each affected
// function's hits across two `FN:` entries, and 99 lines a single clean process proves executed
// report `DA:<line>,0` in the corrupted merge -- over an IDENTICAL 1,510-line `DA:` line-number
// set, so nothing phantom was added to the denominator; real hits were overwritten by a later,
// zero-valued duplicate.
//
// This file drives `scripts/diff-coverage.mjs`'s pure parsing/reconciliation functions directly
// against synthetic lcov fixtures that reproduce that exact corruption shape, one test per
// acceptance criterion.
//
// `scripts/**` sits OUTSIDE tsconfig's `include` (see tsconfig.json), so a static
// `import … from "../scripts/diff-coverage.mjs"` is a TS7016 -- the same reason
// test/clock-sweep.test.ts reaches its script through a runtime import rather than a typed one.
// A dynamic specifier is not statically resolved, so this loads the REAL module with no shadow
// copy to drift from it.
const SCRIPT_URL = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "diff-coverage.mjs"),
).href;

const mod = (await import(SCRIPT_URL)) as {
  parseLcovHitsByFile: (lcovText: string) => {
    hits: Map<string, Map<number, number>>;
    fnLines: Map<string, Map<number, string[]>>;
    fnHits: Map<string, Map<string, boolean>>;
  };
  reconcileDuplicateFunctionDeclarations: (fnLines: Map<string, Map<number, string[]>>) => void;
  findUncoveredAddedLines: (
    added: Map<string, Map<number, string>>,
    lcov: { hits: Map<string, Map<number, number>>; fnLines: Map<string, Map<number, string[]>>; fnHits: Map<string, Map<string, boolean>> },
  ) => string[];
};
const { parseLcovHitsByFile, reconcileDuplicateFunctionDeclarations, findUncoveredAddedLines } = mod;

const FILE = "src/lib/ledger.ts";

/** A CLEAN, single-process lcov block for `rotateLedger` -- its true declaration at line 1098,
 * one body line (1099) with real hits, entered 5 times. Everything below is built from this. */
const CLEAN_BLOCK = [
  `SF:${FILE}`,
  "FN:1098,rotateLedger",
  "FNDA:5,rotateLedger",
  "DA:1098,5",
  "DA:1099,5",
  "end_of_record",
].join("\n");

/** The MALFORMED second record: `rotateLedger` re-declared 3 lines above its true position
 * (1095 vs 1098), contributed by a worker that also writes a phantom `DA:1099,0` for the real
 * function's own body line -- the exact shape the rationale measured (a function whose FNDA
 * proves it was entered, sitting beside a DA map that reads zero for its body). */
const CORRUPT_BLOCK = [
  `SF:${FILE}`,
  "FN:1095,rotateLedger",
  "FNDA:0,rotateLedger",
  "DA:1099,0",
  "end_of_record",
].join("\n");

test("lcov-function-record-attribution: a function name declared at two different lines reconciles to ONE function, not two", () => {
  const { fnLines } = parseLcovHitsByFile(CLEAN_BLOCK + "\n" + CORRUPT_BLOCK);
  const namesByLine = fnLines.get(FILE)!;
  const allNames = [...namesByLine.values()].flat();
  assert.deepEqual(
    allNames,
    ["rotateLedger"],
    "the same function must be counted once across the whole file, whatever the duplicate " +
      "record's own line number claims",
  );
  // The TRUE declaration line is the LARGER one (this task's own title: the malformed record is
  // declared exactly three lines ABOVE where it is) -- the phantom, smaller line is dropped.
  assert.equal(namesByLine.has(1098), true, "the true (larger) declaration line must survive");
  assert.equal(namesByLine.has(1095), false, "the phantom (smaller) declaration line must be gone");
});

test("lcov-function-record-attribution: a function whose FNDA proves it was entered is not reported as having an uncovered body", () => {
  // CORRUPT_BLOCK is appended AFTER CLEAN_BLOCK, so a last-wins DA parser would let its
  // DA:1099,0 overwrite CLEAN_BLOCK's real DA:1099,5 -- exactly the mechanism that erased 99
  // genuinely-covered lines in the measured corruption.
  const lcov = parseLcovHitsByFile(CLEAN_BLOCK + "\n" + CORRUPT_BLOCK);
  assert.equal(lcov.hits.get(FILE)!.get(1099), 5, "a real hit must survive a later phantom zero");

  const added = new Map([[FILE, new Map([[1099, "  writeSyncRange(ledgerPath, cursor);"]])]]);
  const violations = findUncoveredAddedLines(added, lcov);
  assert.deepEqual(violations, [], "the gate must not block a line proven executed elsewhere in the merge");
});

test("lcov-function-record-attribution: the file that cannot report its own coverage no longer contributes a shifted function table for another module", () => {
  // CORRUPT_BLOCK stands in for the crashing test file's contribution -- it never proves its OWN
  // coverage (FNDA:0 for its own copy of rotateLedger) yet still lands a second SF: record for
  // `src/lib/ledger.ts`, a module it does not itself declare. After reconciliation, ledger.ts's
  // own table must read exactly as the clean, single-process run reports it.
  const merged = parseLcovHitsByFile(CLEAN_BLOCK + "\n" + CORRUPT_BLOCK);
  const clean = parseLcovHitsByFile(CLEAN_BLOCK);
  assert.deepEqual(
    [...merged.hits.get(FILE)!.entries()].sort(),
    [...clean.hits.get(FILE)!.entries()].sort(),
    "a shifted phantom contribution from a file that cannot report its own coverage must not " +
      "change what ledger.ts's own DA map reads",
  );
  assert.deepEqual(
    [...merged.fnLines.get(FILE)!.values()].flat(),
    [...clean.fnLines.get(FILE)!.values()].flat(),
    "the phantom's shifted function table must not add a second, unreconciled function entry",
  );
});

test("lcov-function-record-attribution: a single-process run and a multi-process run over the same tree agree on which lines are covered", () => {
  const singleProcess = parseLcovHitsByFile(CLEAN_BLOCK);
  const multiProcess = parseLcovHitsByFile(CLEAN_BLOCK + "\n" + CORRUPT_BLOCK);
  const singleHits = singleProcess.hits.get(FILE)!;
  const multiHits = multiProcess.hits.get(FILE)!;
  for (const [line, hits] of singleHits) {
    assert.equal(
      multiHits.get(line)! > 0,
      hits > 0,
      `line ${line}: single-process covered=${hits > 0} but multi-process disagreed`,
    );
  }
});

test("lcov-function-record-attribution: an lcov with no duplicate records is passed through unchanged, so the reconciliation cannot mask a real gap", () => {
  const plain = [
    "SF:src/lib/example.ts",
    "FN:10,helper",
    "FNDA:3,helper",
    "DA:10,3",
    "DA:11,3",
    "DA:12,0",
    "end_of_record",
  ].join("\n");
  const { hits, fnLines } = parseLcovHitsByFile(plain);
  assert.deepEqual(
    [...hits.get("src/lib/example.ts")!.entries()].sort(),
    [
      [10, 3],
      [11, 3],
      [12, 0],
    ],
    "no duplicate record exists here, so hit counts must be exactly what the lcov declared",
  );
  assert.deepEqual(
    [...fnLines.get("src/lib/example.ts")!.entries()],
    [[10, ["helper"]]],
    "no duplicate name exists here, so the single declaration must be untouched",
  );
});

test("lcov-function-record-attribution: diff-coverage still blocks a genuinely uncovered added line after the reconciliation", () => {
  // Line 1200 is a NEW, genuinely uncovered line: DA:1200,0 in every record that mentions it, no
  // process anywhere in the merge ever hit it. The presence of an UNRELATED reconciled duplicate
  // (rotateLedger, above) must not make the reconciliation over-eager and rescue this one too.
  const withGenuineGap = [
    CLEAN_BLOCK,
    CORRUPT_BLOCK,
    `SF:${FILE}`,
    "FN:1200,neverCalled",
    "FNDA:0,neverCalled",
    "DA:1200,0",
    "end_of_record",
  ].join("\n");
  const lcov = parseLcovHitsByFile(withGenuineGap);
  const added = new Map([[FILE, new Map([[1200, "  neverCalled();"]])]]);
  const violations = findUncoveredAddedLines(added, lcov);
  assert.deepEqual(violations, [`${FILE}:1200`], "a line with zero hits everywhere must still block");
});

test("lcov-function-record-attribution: reconcileDuplicateFunctionDeclarations leaves a line's OTHER function names untouched (W1-T481 stays intact)", () => {
  // A single line legitimately declaring two DIFFERENT functions (an exported function sharing
  // its line with an anonymous callback, W1-T481) must not be mistaken for the W1-T2276 shape --
  // reconciliation only collapses the SAME name recurring at different lines.
  const fnLines = new Map([
    [
      FILE,
      new Map([
        [50, ["buildAccountUsageRoute", "anonymous_14"]],
        [1095, ["rotateLedger"]],
        [1098, ["rotateLedger"]],
      ]),
    ],
  ]);
  reconcileDuplicateFunctionDeclarations(fnLines);
  const namesByLine = fnLines.get(FILE)!;
  assert.deepEqual(
    namesByLine.get(50),
    ["buildAccountUsageRoute", "anonymous_14"],
    "two DIFFERENT names sharing one line is a separate, legitimate shape and must be untouched",
  );
  assert.equal(namesByLine.has(1095), false, "the duplicate NAME's phantom (smaller) line is removed");
  assert.deepEqual(namesByLine.get(1098), ["rotateLedger"], "the duplicate NAME's true (larger) line survives");
});
