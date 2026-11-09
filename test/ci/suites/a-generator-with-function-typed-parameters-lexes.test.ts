// @source-text-subject: the conservative lexer must scan the real src/run-task.ts end to end; its text is the lexer's input, asserted on only by whether lexing throws.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { maskLiterals, stripComments } from "#src/lib/test-impact-map.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const GENERATOR = [
  "function* writeSteps(",
  "  root: string,",
  "  log: (step: string, extra?: Record<string, unknown>) => void,",
  "  runGit: (root: string, args: string[]) => string | Promise<string>,",
  "): Steps<string | undefined> {",
  "  // a comment",
  '  const s = "text"; yield* step(() => runGit(root, ["rev-parse", "HEAD"]));',
  "  return undefined;",
  "}",
  "",
].join("\n");

test("a generator whose parameters carry function types lexes in conservative mode", () => {
  const stripped = stripComments(GENERATOR, { conservative: true });
  assert.ok(!stripped.includes("a comment"), "the line comment is removed");
  assert.ok(stripped.includes("): Steps<string | undefined> {"), "the return type survives untouched");
  const masked = maskLiterals(GENERATOR, { conservative: true });
  assert.ok(!masked.includes("rev-parse"), "string literals are masked");
  assert.ok(masked.includes("log: (step: string, extra?: Record<string, unknown>) => void"), "parameter types survive");
});

test("the current src/run-task.ts lexes end to end in conservative mode", () => {
  const source = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  assert.ok(source.includes("function* writeFixCensusSnapshotSteps("), "positive control: the reported generator is in the corpus");
  assert.doesNotThrow(() => stripComments(source, { conservative: true }));
  assert.doesNotThrow(() => maskLiterals(source, { conservative: true }));
});

test("an ambiguous regex-versus-division context still throws in conservative mode", () => {
  const ambiguous = "const a = {}\n/x/g.test(y);\n";
  assert.throws(() => stripComments(ambiguous, { conservative: true }), /lexical context unknown at line 2 after \}/);
  assert.throws(() => maskLiterals(ambiguous, { conservative: true }), /lexical context unknown/);
});
