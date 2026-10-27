import assert from "node:assert/strict";
import { test } from "node:test";
import { maskLiterals, stripComments } from "#src/lib/test-impact-map.js";
import { changedSymbols } from "#src/lib/affected-suites.js";

const conservative = { conservative: true };
const strictMask = (source: string) => maskLiterals(stripComments(source, { keepLines: true, ...conservative }), conservative);

test("W1-T10250: a generator with a TypeScript return type lexes in conservative mode", () => {
  for (const prefix of ["function* steps", "const steps = function*", "async function* steps", "const steps = async function*"]) {
    for (const type of ["Steps<string>", "AsyncGenerator<string | undefined>",
      "{ [Symbol.iterator](): Iterator<{ value: string }> }",
      "Steps<{ nested: { value: string }; predicate: () => boolean }>",
      "T extends U ? { value: string } : { value: number }",
      "(() => { value: string }) | { value: number }", "{ yield: string; for: number }",
      '"literal"', "'literal'", "`literal`", "`prefix${T}`", "Steps<Steps<string>> & { value: string }",
      "Steps<{ callback: (value: string) => { value: string }; tuple: [string, { id: number }] }>",
      "Steps</* type comment */ string>", "Steps<// type comment\n string>"]) {
      const source = `${prefix}(value: string): ${type} {\n  yield /\x60/.test(value);\n}\nfunction after() {}\n`;
      const masked = strictMask(source);
      assert.equal(masked.length, stripComments(source, { keepLines: true, ...conservative }).length, source);
      assert.equal(masked.split("\n").length, source.split("\n").length, source);
      assert.ok(masked.includes("yield / /.test(value)"), source);
      assert.match(masked, /\nfunction after\(\) {}\n$/, source);
    }
  }
});

test("typed generator annotations refuse incomplete or non-type slash contexts", () => {
  for (const type of ["Steps<string", "Steps<string] {}", "/liveCall()/ {}"])
    assert.throws(() => strictMask(`function* steps(): ${type}`), /lexical context unknown/, type);
});

test("typed generator bodies preserve nested ordinary functions and following division", () => {
  const source = ["function* steps(): Steps<string> {",
    "  function ordinary() { var yield = 8; return yield / liveCall() /g; }",
    "  if (ready) { yield /\x60/; }",
    "  yield /\x60/;", "}",
    "function after() { var yield = 8; return yield / liveCall() /g; }", ""].join("\n");
  const masked = strictMask(source);
  assert.equal(masked.match(/yield \/ liveCall\(\) \/g/g)?.length, 2);
  assert.ok(!masked.includes("/\x60/"));
  assert.match(masked.split("\n")[5]!, /^function after\(\)/);
});

test("W1-T10250: a control keyword inside a generator body lexes in conservative mode", () => {
  for (const statement of ["if (ready)", "while (ready)", "for (; ready;)", "with (value)",
    "switch (value)", "catch (error)"]) {
    const body = statement.startsWith("catch") ? `try {} ${statement} { yield /\x60/; }`
      : statement.startsWith("switch") ? `${statement} { case 1: yield /\x60/; }`
      : `${statement} /\x60/.test(value);`;
    const source = `function* steps() {\n  ${body}\n  yield /\x60/;\n}\nfunction after() {}\n`;
    new Function(source);
    const masked = strictMask(source);
    assert.ok(masked.includes(statement), source);
    assert.ok(!masked.includes("/\x60/"), source);
    assert.match(masked.split("\n")[4]!, /^function after\(\)/, source);
  }
});

test("W1-T10250: a change inside a typed generator selects by symbol, not the full fallback", () => {
  const source = ['function* steps(value: string): Steps<{ value: string }> {',
    '  for (;;) {', '    yield { value };', '  }', '}', 'function after() {}', ''].join("\n");
  const diff = 'diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n' +
    '@@ -3 +3 @@\n-    yield { value: "old" };\n+    yield { value };\n';
  const reads: string[] = [];
  assert.deepEqual(changedSymbols(diff, path => { reads.push(path); return source; }), ["steps"]);
  assert.deepEqual(reads, ["src/example.ts"]);
});

test("W1-T10250: an ambiguous slash after yield is still refused", () => {
  for (const source of [
    'const obj = { *method() { yield /\x60/.test(value); } };',
    'const obj = { *method() { return `${yield /\x60/.test(value)}`; } };',
    'function* steps(): Steps<string> { const arrow = () => yield /\x60/.test(value); }',
    'function* steps(): Steps<string> { const obj = { if() { var yield = 8; return yield / liveCall() /g; } }; }',
    'function* steps() { yield { if() { var yield = 8; return yield / liveCall() /g; } }; }',
    'function* steps() { yield* { if() { var yield = 8; return yield / liveCall() /g; } }; }',
    'function* steps() { throw { if() { var yield = 8; return yield / liveCall() /g; } }; }',
    'function* steps() { const kind = typeof { if() { var yield = 8; return yield / liveCall() /g; } }; }',
    'function* steps() { switch (v) { case { if() { var yield = 8; return yield / liveCall() /g; } }: break; } }',
    'async function* steps() { await { if() { var yield = 8; return yield / liveCall() /g; } }; }',
    'await / liveCall() /g;', 'if (ready) {} /\x60/.test(value);',
  ]) {
    assert.throws(() => strictMask(source), /lexical context unknown/, source);
  }
});
