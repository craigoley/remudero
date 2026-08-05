// test/acceptance-block-diagnostics.test.ts
//
// THE DEFECT, reproduced at this sha before anything was written. `parseAcceptanceBlock` treats any
// indented line that is not `proof:` as the END of the block. A claim WRAPPED onto a second line —
// the most natural thing an author does to a long claim — therefore truncates silently:
//
//     written 3  ->  parsed 1, with an EMPTY proof        (wrapped)
//     written 3  ->  parsed 3, no empty proofs            (identical body, no wrap)
//
// The review then judges the PR against a criterion the author never meant to stand alone, and the
// criteria after the wrap are simply gone. That is the same overloaded-zero shape as the two `grep:`
// traps this repo has already paid for — a pattern wrapping across a YAML line matches nothing, and
// a case-mismatched pattern returns nothing. All three are LINE-ORIENTED PARSERS MEETING WRAPPED
// TEXT, and all three fail by returning FEWER things rather than raising.
//
// WHY A DIAGNOSTIC AND NOT A STRICTER PARSER. Making `parseAcceptanceBlock` reject would fail bodies
// that merge today, so the parser keeps its permissive contract and this reports the discrepancy
// instead. These tests therefore assert the parser is UNCHANGED as well as that the diagnostic sees
// the truncation.
//
// WHAT IS REAL HERE: `acceptanceBlockDiagnostics` and `parseAcceptanceBlock` are the production
// functions, called directly — there is no seam and nothing is injected. The CLI test drives
// `checkAcceptanceCommand`, the production command body, over a real temp file.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acceptanceBlockDiagnostics, parseAcceptanceBlock } from "../src/lib/review.js";
import { checkAcceptanceCommand } from "../src/run-task.js";

const WRAPPED = `## Acceptance

- claim: a claim long enough that an author wrapped it onto
  a second line for readability
  proof: unit test: test/foo.test.ts
- claim: the second criterion
  proof: unit test: test/bar.test.ts
- claim: the third criterion
  proof: unit test: test/baz.test.ts
`;

/** Byte-identical to WRAPPED except the first claim stays on one line. */
const UNWRAPPED = `## Acceptance

- claim: a claim long enough that an author wrapped it onto a second line for readability
  proof: unit test: test/foo.test.ts
- claim: the second criterion
  proof: unit test: test/bar.test.ts
- claim: the third criterion
  proof: unit test: test/baz.test.ts
`;

/** The #1342/#1344 shape: a Validation section written where an Acceptance block belonged. */
const NO_HEADER = `## Validation

- claim: something was proved
  proof: unit test: test/foo.test.ts
`;

function tmpFile(contents: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-accept-diag-"));
  const path = join(dir, "body.md");
  writeFileSync(path, contents);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a wrapped claim truncates the block, and the diagnostic reports exactly where", () => {
  // The parser's own (unchanged, permissive) behaviour first — this is the defect being surfaced.
  assert.equal(parseAcceptanceBlock(WRAPPED).length, 1, "the parser still resolves only the first criterion");
  assert.equal(parseAcceptanceBlock(WRAPPED)[0]?.proof, "", "and its proof is empty — nothing would execute");

  const d = acceptanceBlockDiagnostics(WRAPPED);
  assert.equal(d.headerFound, true);
  assert.equal(d.bulletsWritten, 3, "three bullets were written");
  assert.equal(d.criteriaParsed, 1, "only one survives the parse");
  assert.equal(d.emptyProofs, 1);
  assert.equal(d.truncatedAtBullet, 2, "the block ends before the second bullet");
  assert.equal(d.defective, true);
});

test("the identical body without the wrap is clean — the wrap is the whole difference", () => {
  const d = acceptanceBlockDiagnostics(UNWRAPPED);
  assert.equal(d.bulletsWritten, 3);
  assert.equal(d.criteriaParsed, 3, "all three survive when no claim wraps");
  assert.equal(d.emptyProofs, 0);
  assert.equal(d.truncatedAtBullet, undefined);
  assert.equal(d.defective, false);
  // Guards against a diagnostic that just always says "defective".
  assert.equal(parseAcceptanceBlock(UNWRAPPED).length, 3);
});

test("a Validation section where an Acceptance block belonged is reported as a missing header", () => {
  const d = acceptanceBlockDiagnostics(NO_HEADER);
  assert.equal(d.headerFound, false, "`## Validation` is not an Acceptance header");
  assert.equal(d.criteriaParsed, 0, "so the review would fail closed with nothing to judge");
  assert.equal(d.defective, true);
});

test("prose after the block is not miscounted as extra criteria", () => {
  // The real shape of every hand-authored body this week: an Acceptance block followed by a
  // `## Validation` section containing its own bullets. Those bullets are NOT criteria, and a
  // diagnostic that counted them would report a false truncation on a perfectly good body.
  const body = `${UNWRAPPED}
## Validation

- some validation note
- another validation note
`;
  const d = acceptanceBlockDiagnostics(body);
  assert.equal(d.bulletsWritten, 3, "counting stops at the end of the block, not at the end of the file");
  assert.equal(d.criteriaParsed, 3);
  assert.equal(d.defective, false);
});

test("the single-line pipe form the orchestrator emits round-trips clean", () => {
  // `renderAcceptanceBlock` (plan-pr-emitter.ts) emits exactly this shape; a diagnostic that called
  // the house format defective would be worse than the defect.
  const body = "Acceptance:\n- the claim | unit test: test/foo.test.ts\n- another claim | unit test: test/bar.test.ts\n";
  const d = acceptanceBlockDiagnostics(body);
  assert.equal(d.bulletsWritten, 2);
  assert.equal(d.criteriaParsed, 2);
  assert.equal(d.emptyProofs, 0);
  assert.equal(d.defective, false);
});

// ── the CLI verb: the production command body, over a real file ─────────────────────────────────

test("check-acceptance exits non-zero on a truncating body and zero on a clean one", () => {
  const bad = tmpFile(WRAPPED);
  const good = tmpFile(UNWRAPPED);
  try {
    assert.equal(checkAcceptanceCommand([bad.path]), 1, "a truncating body must refuse");
    assert.equal(checkAcceptanceCommand([good.path]), 0, "a clean body must pass");
  } finally {
    bad.cleanup();
    good.cleanup();
  }
});

test("check-acceptance refuses a missing argument and an unreadable file without throwing", () => {
  assert.equal(checkAcceptanceCommand([]), 2, "no file argument is a usage error, not a crash");
  assert.equal(checkAcceptanceCommand([join(tmpdir(), "rmd-no-such-body-xyzzy.md")]), 2, "unreadable file too");
});

test("check-acceptance reports a missing header through the CLI, not only through the diagnostic", () => {
  // Covers the command's own `!headerFound` branch — the #1342/#1344 shape reaching the verb an
  // author would actually run, rather than only the pure function beneath it.
  const f = tmpFile(NO_HEADER);
  try {
    assert.equal(checkAcceptanceCommand([f.path]), 1, "a body with no Acceptance header must refuse");
  } finally {
    f.cleanup();
  }
});
