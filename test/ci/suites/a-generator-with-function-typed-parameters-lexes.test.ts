import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { maskLiterals, stripComments } from "#src/lib/test-impact-map.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const conservative = { conservative: true };
const strictMask = (source: string) => maskLiterals(stripComments(source, { keepLines: true, ...conservative }), conservative);

test("a generator whose parameters carry function types lexes in conservative mode", () => {
  for (const prefix of ["function* steps(", "async function* steps(", "const steps = function*("]) {
    const source = [`${prefix}`,
      "  log: (step: string, extra?: Record<string, unknown>) => void,",
      "  runGit: (args: string[]) => string | Promise<string>,",
      "): Steps<string | undefined> {",
      "  yield /\x60/.test(\"x\");", "}", "function after() {}", ""].join("\n");
    const masked = strictMask(source);
    assert.equal(masked.split("\n").length, source.split("\n").length, source);
    assert.ok(masked.includes("log: (step: string, extra?: Record<string, unknown>) => void"), source);
    assert.ok(masked.includes("yield / /.test("), source);
    assert.match(masked, /\nfunction after\(\) {}\n$/, source);
  }
});

test("the current src/run-task.ts lexes end to end in conservative mode", () => {
  const source = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  assert.ok(source.includes("function* writeFixCensusSnapshotSteps("), "positive control: the reported generator is in the corpus");
  assert.doesNotThrow(() => strictMask(source));
});

test("an ambiguous regex-versus-division context still throws after function-typed parameters", () => {
  for (const source of [
    "function* steps(log: (step: string) => void): Steps<string> { const arrow = () => yield /\x60/.test(value); }",
    "function* steps(log: (step: string) => void): Steps<string> { const obj = { if() { var yield = 8; return yield / liveCall() /g; } }; }",
    "await / liveCall() /g;",
  ]) {
    assert.throws(() => strictMask(source), /lexical context unknown/, source);
  }
});
