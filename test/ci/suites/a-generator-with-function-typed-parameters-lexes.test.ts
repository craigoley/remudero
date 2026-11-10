import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { maskLiterals, stripComments } from "#src/lib/test-impact-map.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const conservative = { conservative: true };
const lex = (source: string) => maskLiterals(stripComments(source, { keepLines: true, ...conservative }), conservative);

// The W1-T10740 reproduction: the shape of `function* writeFixCensusSnapshotSteps(` in src/run-task.ts.
const GENERATOR = [
  "function* writeSteps(",
  "  log: (step: string, extra?: Record<string, unknown>) => void,",
  "  runGit: (args: string[], cwd: string) => string | Promise<string>,",
  "): Steps<string | undefined> {",
  "  log(\"a\", { b: 1 });",
  "  yield /`/.test(runGit([], \".\") as string);",
  "}",
  "function after() {}",
  "",
].join("\n");

test("a generator whose parameters carry function types lexes in conservative mode", () => {
  for (const head of ["function*", "async function*", "export function*"]) {
    const source = GENERATOR.replace("function*", head);
    const masked = lex(source);
    assert.equal(masked.split("\n").length, source.split("\n").length, head);
    assert.ok(masked.includes("yield / /.test("), head);
    assert.match(masked, /\nfunction after\(\) {}\n$/, head);
  }
});

test("the current src/run-task.ts lexes end to end in conservative mode", () => {
  const source = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  assert.ok(source.includes("function* writeFixCensusSnapshotSteps("), "positive control: the reported generator is in the corpus");
  const masked = lex(source);
  assert.equal(masked.split("\n").length, source.split("\n").length);
});

test("an ambiguous regex-versus-division context still throws lexical context unknown", () => {
  assert.throws(() => lex("function* steps(): Steps<string"), /lexical context unknown/);
  assert.throws(() => lex("function* steps(): /liveCall()/ {}"), /lexical context unknown/);
});
