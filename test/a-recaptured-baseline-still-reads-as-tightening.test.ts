// @source-text-subject — this suite's subject is the parser's handling of baseline source text.
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

test("MUTANT: the pre-fix rule, re-run over the same input, cannot classify the re-captured baseline", () => {
  // The falsifier is load-bearing only if the fix is what moves the verdict, so reproduce the
  // PRE-FIX rule here and show the two answers disagree on one input — no source-text read, which
  // would only assert that a line still exists rather than that the behaviour still holds.
  const preFixWouldBail = (addedLine: string): boolean =>
    !/"([^"]+)"\s*:\s*(-?\d+(?:\.\d+)?)/.test(addedLine); // "no numeric row" => return "undetermined"

  const provenance = '+  "capturedAt": "2026-09-08",';
  assert.equal(preFixWouldBail(provenance), true, "the pre-fix rule refuses to classify this line");
  assert.equal(
    classify('-  "capturedAt": "2026-08-26",\n-  "maxCycles": 13,\n+  "capturedAt": "2026-09-08",\n+  "maxCycles": 0,\n'),
    "tightening",
    "the shipped rule classifies the same input — the two cannot both hold, so the skip is load-bearing",
  );

  // And the skip stayed narrow: the same line shape with a non-provenance key still bails.
  assert.equal(preFixWouldBail('+  "path": "src/new.ts",'), true);
  assert.equal(classify('-  "maxCycles": 13,\n+  "maxCycles": 0,\n+  "path": "src/new.ts",\n'), "undetermined");
});
