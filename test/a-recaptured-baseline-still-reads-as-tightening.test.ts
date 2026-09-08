/**
 * W1-T3182. W1-T3133's Rule 25 carve-out says an instrument change that only TIGHTENS is not
 * entanglement, so a PR may cut something and lower the ceiling that measured it in one diff.
 * `classifyInstrumentChange` bailed to `undetermined` on any added line carrying no
 * `"key": <number>` pair — and a refreshed `"capturedAt": "…"` is exactly such a line, which made
 * the carve-out unreachable for the 8 of 19 `scripts/*-baseline.json` that record one.
 *
 * The fix skips PROVENANCE rows only. The hole it must not open is the second test below: a diff
 * that lowers a ceiling while adding a `path`/`reason` exemption beside it must NOT read as a
 * tightening, because that entry IS an allowance.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { classifyInstrumentChange } from "../src/lib/review.js";

const FILE = "scripts/x-baseline.json";

/** A minimal unified diff over one baseline file; `body` is the +/- lines verbatim. */
function diffOf(body: string): string {
  return [
    `diff --git a/${FILE} b/${FILE}`,
    `--- a/${FILE}`,
    `+++ b/${FILE}`,
    "@@ -1,8 +1,8 @@",
    body,
  ].join("\n");
}

function classify(body: string): string {
  return classifyInstrumentChange(diffOf(body), [FILE], FILE);
}

test("a refreshed capturedAt beside a lowered ceiling still reads as tightening", () => {
  // The control first: the numeric hunk ALONE was always classifiable, so this test is only
  // meaningful if the provenance line is the single difference between the two.
  assert.equal(classify('-  "maxCycles": 13,\n+  "maxCycles": 0,\n'), "tightening");
  assert.equal(
    classify('-  "capturedAt": "2026-08-26",\n-  "maxCycles": 13,\n+  "capturedAt": "2026-09-08",\n+  "maxCycles": 0,\n'),
    "tightening",
    "an honest re-capture must not cost the author the carve-out",
  );
});

test("every provenance key this repo actually uses is skipped, and nothing else is", () => {
  for (const key of ["_comment", "_history", "_methodology", "capturedAt", "capturedAtSha", "capturedAgainst", "captureCommand", "bumpRationale", "priorBumpRationale"]) {
    assert.equal(
      classify(`-  "maxCycles": 13,\n+  "maxCycles": 0,\n+  "${key}": "refreshed",\n`),
      "tightening",
      `${key} is provenance and must not defeat the carve-out`,
    );
  }
  // These name an exempted ENTRY or repoint the measured scope. Adding one is a LOOSENING, so it
  // must stay unaccountable even when a real tightening rides in the same hunk.
  for (const key of ["path", "reason", "id", "testFile", "target", "literal", "scopeConfig"]) {
    assert.equal(
      classify(`-  "maxCycles": 13,\n+  "maxCycles": 0,\n+  "${key}": "src/new.ts",\n`),
      "undetermined",
      `${key} names an allowance; a tightening beside it must not launder it through`,
    );
  }
});

test("the conservative defaults survive: a loosening still loosens, an unparseable hunk still refuses", () => {
  assert.equal(classify('-  "maxCycles": 0,\n+  "maxCycles": 13,\n'), "loosening");
  assert.equal(
    classify('-  "maxCycles": 13,\n+  "maxCycles": 0,\n+  ],\n'),
    "undetermined",
    "a line with NO parseable row at all is a structural rewrite, not provenance",
  );
});

test("the live instance: PR #4620's real cycle-baseline.json hunk classifies as tightening", () => {
  // The shape W1-T2895 actually pushed — maxCycles 13 -> 0 with _comment, capturedAt,
  // capturedAtSha, _methodology and _history all honestly re-derived at the new sha.
  const body = [
    '-  "_comment": "CANONICAL CYCLE-COUNT CEILING. Never raise this to make a PR pass.",',
    '-  "capturedAt": "2026-08-26",',
    '-  "capturedAtSha": "63889e5b021ee5ed92a1b158a75141aff62b7e15",',
    '-  "maxCycles": 13,',
    '-  "_methodology": "Re-derived at the sha above from the repo own config.",',
    '-  "_history": "#2798 cut the count from 24 to 13.",',
    '+  "_comment": "CANONICAL CYCLE-COUNT CEILING. Never raise this to make a PR pass.",',
    '+  "capturedAt": "2026-09-08",',
    '+  "capturedAtSha": "41231c67069b0978d48cdae987ff45e40484e16e",',
    '+  "maxCycles": 0,',
    '+  "_methodology": "Re-derived at the sha above from the repo own config.",',
    '+  "_history": "W1-T2895 cut the remaining 13.",',
    "",
  ].join("\n");
  assert.equal(classify(body), "tightening");
});

test("MUTANT: restoring the unconditional bail makes the re-captured baseline unclassifiable again", () => {
  // The falsifier is load-bearing only if the fix is what moves the verdict, so re-run the
  // pre-fix predicate over the same input rather than asserting the new one twice. This is the
  // exact line the fix replaced: bail whenever the added line carries no numeric row.
  const source = readFileSync(join(import.meta.dirname, "..", "src", "lib", "review.ts"), "utf8");
  assert.match(
    source,
    /keys\.every\(isInstrumentProvenanceKey\)\) continue;/,
    "the provenance skip is what this suite proves; if it is gone the tests below are vacuous",
  );

  const added = '+  "capturedAt": "2026-09-08",';
  const numericRow = /"([^"]+)"\s*:\s*(-?\d+(?:\.\d+)?)/.test(added);
  assert.equal(numericRow, false, "the provenance line carries no numeric row");
  // Pre-fix, that false was an immediate `return "undetermined"` — which is what the first test
  // measures as `tightening` now. The two cannot both hold, so the skip is load-bearing.
});
