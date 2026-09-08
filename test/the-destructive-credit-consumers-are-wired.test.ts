// @source-text-subject — W1-T2905's declared carve-out, and this file exists BECAUSE of it.
//
// These two assertions read `src/` AS TEXT, which the source-text census refuses by default and for
// a good reason: such a test passes when the prose is right and the behaviour is wrong. The census
// offers exactly two remedies — assert on behaviour instead, or declare a file whose SUBJECT
// genuinely IS the source text. Neither assertion below can take the first: `buildCreditCandidates`
// and `buildEscalationReconcileCandidates` construct their `DeriveDeps` INLINE, with no seam to
// inject or observe, so whether the evidence reaches them is a fact about the source and nothing
// else. That is the second remedy's case precisely.
//
// SPLIT OUT rather than declared in place. The marker is FILE-LEVEL
// (`content.includes(SOURCE_TEXT_SUBJECT_MARKER)` returns 0 for the whole file), so putting it in
// a-plan-only-filing-cannot-earn-a-merge-credit.test.ts would have exempted that file's SEVEN
// behavioural tests too — declaring as "subject is source text" seven assertions that are nothing
// of the kind, and blinding the census to any real source-text read added there later.
//
// WHAT IS PINNED, and why losing it would matter: W1-T3067 exists because a refusal was wired into
// one destructive surface and left open in the other. This is the assertion that the pair stay
// wired together.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

function functionBody(src: string, name: string): string {
  const start = src.indexOf("function " + name + "(");
  assert.ok(start >= 0, name + " not found");
  const next = src.indexOf("\nfunction ", start + 1);
  const alt = src.indexOf("\nexport function ", start + 1);
  const end = Math.min(next === -1 ? src.length : next, alt === -1 ? src.length : alt);
  return src.slice(start, end);
}

test("W1-T3067: every DESTRUCTIVE credit consumer supplies mergedPathsByPr", () => {
  // buildCreditCandidates closes a PR; buildEscalationReconcileCandidates closes a needs-human
  // issue. BOTH read proj.merged, so a filing-earned credit in either destroys something. Wiring
  // one and not the other is the failure this pins: the refusal fixed in one surface, open in the
  // other. Structural because these builders construct DeriveDeps inline — nothing but the source
  // says whether the evidence reaches them.
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const src = readFileSync(join(root, "src", "run-task.ts"), "utf8");
  for (const fn of ["buildCreditCandidates", "buildEscalationReconcileCandidates"]) {
    const body = functionBody(src, fn);
    assert.match(body, /DeriveDeps = \{/, fn + " should construct DeriveDeps");
    assert.match(body, /mergedPathsByPr: readMergedPathsByPr\(/,
      fn + " drives a destructive act on proj.merged, so it MUST supply the local path evidence");
  }
});

test("W1-T3067: the DISPLAY consumers are deliberately NOT wired, and that is a recorded cost decision", () => {
  // The board, inboxCommand and the ratify loaders also derive status and supply no map. None of
  // them closes anything, and the board renders per request while readMergedPathsByPr scans
  // thousands of commits. Recorded as a test so the asymmetry is a decision on the record rather
  // than an oversight a later reader "fixes" into a per-render repo scan.
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const board = readFileSync(join(root, "src", "lib", "status-board.ts"), "utf8");
  assert.match(board, /DeriveDeps = \{/, "the board does derive status");
  assert.doesNotMatch(board, /mergedPathsByPr/,
    "display-only and per-request: wiring it would pay a repo-wide git log per render");
});
