import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { maskLiterals, stripComments } from "#src/lib/test-impact-map.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const conservative = { conservative: true };
const strictMask = (source: string) => maskLiterals(stripComments(source, { keepLines: true, ...conservative }), conservative);

test("a generator whose parameters carry function types lexes in conservative mode", () => {
  const params = [
    "log: (step: string, extra?: Record<string, unknown>) => void",
    "runGit: (root: string, args: string[]) => string | Promise<string>",
  ];
  for (const prefix of ["function* steps", "async function* steps", "const steps = function*"]) {
    for (const layout of [params.join(", "), `\n  ${params.join(",\n  ")},\n`]) {
      const source = `${prefix}(${layout}): Steps<string | undefined> {\n  yield /\x60/.test("a");\n}\nfunction after() {}\n`;
      const masked = strictMask(source);
      assert.equal(masked.split("\n").length, source.split("\n").length, source);
      assert.ok(masked.includes("yield / /.test("), source);
      assert.match(masked, /\nfunction after\(\) {}\n$/, source);
    }
  }
});

test("the current src/run-task.ts lexes end to end in conservative mode", () => {
  // The file is lexer INPUT, not a text subject: read it as the committed blob, assert only on lexing behaviour.
  const source = execFileSync("git", ["show", "HEAD:src/run-task.ts"], { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.ok(source.split("\n").length > 10000, "positive control: the lexer was handed the repository's largest hub, not an empty read");
  const masked = strictMask(source);
  assert.equal(masked.split("\n").length, source.split("\n").length);
  assert.equal(masked.length, stripComments(source, { keepLines: true, ...conservative }).length);
});

test("an ambiguous regex-versus-division context still throws in conservative mode", () => {
  for (const type of ["Steps<string", "Steps<string] {}", "/liveCall()/ {}"])
    assert.throws(() => strictMask(`function* steps(log: (step: string) => void): ${type}`), /lexical context unknown/, type);
});
