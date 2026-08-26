// test/entanglement-needs-the-patch.test.ts — Standing rule 25's isolation rule must see the
// PATCH, not just the path list.
//
// THE DEFECT. `detectInstrumentEntanglement` took `diffFiles: string[]` and never saw the diff,
// so it could not tell a one-line usage string from a behavioural change. Because
// `instrumentEntangled` hard-fails both `state` and `floorState`, verdict stability could not
// suppress it either. Three measured occurrences: #2884 was split by hand over a single sentence
// appended to `next-task-id`'s usage string (both halves then passed unchanged); a later lane
// DUPLICATED a helper across two `.mjs` files rather than register `scripts/lib/…` on
// INSTRUMENT_SURFACE, because doing so meant editing src/lib/review.ts and tripping this rule.
// The rule had started shaping the codebase to avoid itself.
//
// WHAT MUST NOT MOVE. The risk the rule exists for is an instrument edited to pass the code it
// judges. #2934 is that shape and its own split commit says so in as many words: "That is a true
// positive — the diff modified both the predicate and the gate that runs it." Every test below
// that asserts a BLOCK is guarding that, and the two controls prove the exemption is driven by
// CONTENT rather than by path: add one behavioural line to an otherwise-exempt diff and it blocks
// again.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  changedLineIsExecutable,
  detectInstrumentEntanglement,
  srcChangeIsExecutable,
} from "../src/lib/review.js";

const WORKFLOW = ".github/workflows/ci.yml";

/** The real shape of #2884's src/ half: one array entry that is entirely a usage sentence. */
const USAGE_ONLY_DIFF = `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -1,2 +1,2 @@ jobs:
-      run: npm test
+      run: npm test -- --reporter=tap
diff --git a/src/run-task.ts b/src/run-task.ts
--- a/src/run-task.ts
+++ b/src/run-task.ts
@@ -27552,7 +27552,7 @@ const COMMANDS: readonly CommandSpec[] = [
-      "rmd next-task-id   # print the next free id.",
+      "rmd next-task-id   # print the next free id. WRITING AN EXAMPLE ID IN PROSE: use the placeholder form, never a bare digit form.",
`;

/** The same diff with ONE behavioural line added to the same hunk — the falsifier. */
const USAGE_PLUS_BEHAVIOUR_DIFF = USAGE_ONLY_DIFF.replace(
  '+      "rmd next-task-id   # print the next free id. WRITING',
  '+      if (mintedId !== undefined) return refuseMint(mintedId);\n+      "rmd next-task-id   # print the next free id. WRITING',
);

// ── the line classifier ────────────────────────────────────────────────────────────────────────

test("prose shapes are not executable: blank lines, line comments, JSDoc bodies and usage strings", () => {
  for (const line of [
    "",
    "   ",
    "  // a line comment",
    "   * a JSDoc body line",
    "  /* an opening block comment",
    '      "rmd next-task-id   # print the next free id.",',
    "  `a template literal used as prose`,",
  ]) {
    assert.equal(changedLineIsExecutable(line), false, `must read as prose: ${JSON.stringify(line)}`);
  }
});

test("real code is executable, including a line that merely CONTAINS a string", () => {
  for (const line of [
    "  if (mintedId !== undefined) return refuseMint(mintedId);",
    "  const x = 1;",
    "  return { entangled: true };",
    '  log("step", { reason: "x" });',
    "  opts: { trailerResolves?: (taskId: string) => boolean } = {},",
  ]) {
    assert.equal(changedLineIsExecutable(line), true, `must read as code: ${JSON.stringify(line)}`);
  }
});

test("an escaped quote inside a literal cannot end it early and leak its tail as code", () => {
  assert.equal(changedLineIsExecutable('  "he said \\"run(); drop()\\" and stopped",'), false);
});

// ── the per-file patch reader ──────────────────────────────────────────────────────────────────

test("a src/ file whose only changed line is a usage string does not carry executable content", () => {
  assert.equal(srcChangeIsExecutable(USAGE_ONLY_DIFF, "src/run-task.ts"), false);
});

test("one behavioural line in the same hunk makes the whole file executable again", () => {
  assert.equal(srcChangeIsExecutable(USAGE_PLUS_BEHAVIOUR_DIFF, "src/run-task.ts"), true);
});

test("a bare string added to a grading-power table is executable, however prose-shaped it looks", () => {
  const registration = `diff --git a/src/lib/review.ts b/src/lib/review.ts
--- a/src/lib/review.ts
+++ b/src/lib/review.ts
@@ -6109,6 +6109,7 @@ export const INSTRUMENT_SURFACE: readonly string[] = [
+  "^scripts/lib/shared-helper\\\\.mjs$",
`;
  assert.equal(srcChangeIsExecutable(registration, "src/lib/review.ts"), true);
  // CONTROL: the identical line under an ordinary declaration is prose, so the carve-out is
  // doing real work rather than matching everything.
  assert.equal(
    srcChangeIsExecutable(registration.replace("export const INSTRUMENT_SURFACE: readonly string[] = [", "const USAGE: string[] = ["), "src/lib/review.ts"),
    false,
  );
});

test("a file the patch does not describe fails CLOSED, never silently exempt", () => {
  assert.equal(srcChangeIsExecutable(USAGE_ONLY_DIFF, "src/lib/never-mentioned.ts"), true);
  assert.equal(srcChangeIsExecutable("", "src/run-task.ts"), true);
});

// ── the rule itself ────────────────────────────────────────────────────────────────────────────

test("an instrument change beside a usage-string-only src/ hunk is no longer entangled", () => {
  const files = [WORKFLOW, "src/run-task.ts"];
  assert.equal(detectInstrumentEntanglement(files).entangled, true, "path-only reading still blocks");
  const r = detectInstrumentEntanglement(files, USAGE_ONLY_DIFF);
  assert.equal(r.entangled, false, "with the patch, the prose-only src/ half no longer counts");
  assert.deepEqual(r.srcPaths, []);
});

test("FALSIFIER: the same pair blocks again once the src/ hunk changes behaviour", () => {
  const r = detectInstrumentEntanglement([WORKFLOW, "src/run-task.ts"], USAGE_PLUS_BEHAVIOUR_DIFF);
  assert.equal(r.entangled, true, "a behavioural src/ change beside an instrument must still block");
  assert.deepEqual(r.srcPaths, ["src/run-task.ts"]);
});

test("omitting the patch preserves today's behaviour exactly, so a caller that forgets fails closed", () => {
  const files = [WORKFLOW, "src/run-task.ts"];
  assert.equal(detectInstrumentEntanglement(files).entangled, true);
  assert.equal(detectInstrumentEntanglement(files, undefined).entangled, true);
});

test("the instrument-only and src-only halves stay unentangled, as before", () => {
  assert.equal(detectInstrumentEntanglement([WORKFLOW], USAGE_ONLY_DIFF).entangled, false);
  assert.equal(detectInstrumentEntanglement(["src/run-task.ts"], USAGE_ONLY_DIFF).entangled, false);
});
