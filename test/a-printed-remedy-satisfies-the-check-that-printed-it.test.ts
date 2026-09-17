import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── W1-T3648: A GATE PRINTS A REMEDY ITS OWN MATCHER WOULD REJECT ────────────────────────────────
//
// MEASURED ON PR #5703: task-id-existence-check refused eight ids and printed, for each,
//
//     remedy: note: "reservation hand-off: unknown -> ci-learning-landing"
//
// Applied the obvious way -- prepended to the note each shard already had -- it did not work. The
// matcher, `shardNoteRecordsReservationHandoff`, is
//
//     /reservation hand-?off:\s*(.*?)\s*->\s*(.*?)\s*$/i
//
// anchored at `$`, so the second capture swallows everything to END OF LINE. Merged onto the same
// physical line as existing note text, it captured the trailing text too and compared unequal.
// The remedy only worked when the hand-off was ALONE on its line -- a requirement the old message
// never stated, so a filer following it literally could still fail and learn that only from a
// second red run.
//
// THE TEST IS THE DELIVERABLE: feed the gate's own printed remedy line back through
// `shardNoteRecordsReservationHandoff` and assert it matches, in exactly the shapes the incident
// and its rationale describe -- alone, appended after an existing note as its own line, and (as a
// negative control that the FIX is to print a working form rather than to relax the matcher) with
// other text trailing it on the same line.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const gate = await import(pathToFileURL(join(REPO_ROOT, "scripts", "task-id-existence-check.mjs")).href);

const HOLDER_BRANCH = "unknown";
const FILER_BRANCH = "run-W1-T3648-filer";

test("the printed hand-off remedy satisfies the matcher that demanded it", () => {
  // `reservationHandoffNoteLine` is the exact function the gate calls to build the pasteable line
  // it prints (scripts/task-id-existence-check.mjs, the HELD-by-a-different-holder branch of
  // `main`). Feeding its return value straight back through the matcher it must satisfy is the
  // literal round trip the task's design calls for.
  const printedLine = gate.reservationHandoffNoteLine(HOLDER_BRANCH, FILER_BRANCH);
  assert.equal(
    gate.shardNoteRecordsReservationHandoff(printedLine, HOLDER_BRANCH, FILER_BRANCH),
    true,
    "following the printed remedy literally must clear the refusal it names",
  );
});

test("the printed remedy puts the hand-off alone on its line, so appending it to an existing note still matches", () => {
  // This is the ACTUAL failure shape from #5703: a shard whose note already carries other text.
  // Recorded here as a genuine block scalar -- hand-off on its own physical line, existing note
  // content on another -- which is the shape the fixed message now prints (`note: |`, an indented
  // line for each fact). Recon verified this exact pairing against the gate's own matcher:
  // "block scalar, hand-off on its own line -> true".
  const existingNote = "Filed by the ci-learning rung from the nightly sweep.";
  const printedLine = gate.reservationHandoffNoteLine(HOLDER_BRANCH, FILER_BRANCH);
  const noteAsWritten = `${existingNote}\n${printedLine}`;
  assert.equal(
    gate.shardNoteRecordsReservationHandoff(noteAsWritten, HOLDER_BRANCH, FILER_BRANCH),
    true,
    "the hand-off on its own line must still match even alongside other note content",
  );
});

test("a hand-off with trailing text on its line is still rejected", () => {
  // The negative control: the fix is to print a form that WORKS, not to widen what the matcher
  // accepts. This is PR #5703's actual failure, reproduced directly -- the hand-off fragment
  // merged onto the SAME line as the note it was prepended to, with text trailing the target
  // branch before end of line. Recon verified this shape too: "inline, appended to an existing
  // note -> false". If the `$` anchor were relaxed to make this pass, this test must fail.
  const printedLine = gate.reservationHandoffNoteLine(HOLDER_BRANCH, FILER_BRANCH);
  const mergedOntoExistingNote = `${printedLine}. Filed by the ci-learning rung from the nightly sweep.`;
  assert.equal(
    gate.shardNoteRecordsReservationHandoff(mergedOntoExistingNote, HOLDER_BRANCH, FILER_BRANCH),
    false,
    "trailing text on the same line as the hand-off must still defeat the end-of-line-anchored matcher",
  );
});
