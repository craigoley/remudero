/**
 * W1-T5701 — the affected-suite graph reads no comment.
 *
 * `specifiers` and `namedPaths` once matched raw source, so a JSDoc `{@link import("./b.js")}` or a
 * backticked test path became a graph edge: a change to `b` selected the suites of `a`, which only
 * CITES `b` in prose. Comments are stripped (string-aware) first, and a named path never targets a
 * `*.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { selectAffectedSuites, stripComments } from "../src/lib/affected-suites.js";

function select(tree: Record<string, string>, changed: string[]): string[] {
  return selectAffectedSuites(changed, { files: new Map(Object.entries(tree)), pathReaders: [] }).suites;
}

const BASE: Record<string, string> = {
  "src/b.ts": "export const b = 1;\n",
  "src/a.ts": 'import { b } from "./b.js";\nexport const a = b;\n',
  "test/a.test.ts": 'import { a } from "../src/a.js";\n',
  "test/b.test.ts": 'import { b } from "../src/b.js";\n',
};

test("unit test: test/the-affected-suite-graph-reads-no-comment.test.ts", () => {
  // b imports a: a change to a reaches b, never the reverse.
  const real: Record<string, string> = { ...BASE, "src/b.ts": 'import { a } from "./a.js";\nexport const b = a;\n', "src/a.ts": "export const a = 1;\n" };
  const withDoc = {
    ...real,
    "src/a.ts": [
      "/**",
      ' * See {@link import("./b.js").b} and `test/b.test.ts` and `src/b.ts`.',
      " */",
      "// import { b } from './b.js';",
      "export const a = 1;",
      "",
    ].join("\n"),
  };
  // A change to b: only its own suite. The comment in a adds no edge b -> a, so a.test.ts is not reached.
  assert.deepEqual(select(withDoc, ["src/b.ts"]), ["test/b.test.ts"]);
  // A test path named in a comment adds no edge to that suite either.
  assert.deepEqual(select({ ...withDoc, "test/b.test.ts": '/* `test/a.test.ts` */ import { b } from "../src/b.js";\n' }, ["test/a.test.ts"]), ["test/a.test.ts"]);

  // The same text as CODE still adds its edge: a real dynamic import in a makes b's change reach a's suite.
  const live = { ...real, "src/a.ts": 'export const a = async () => (await import("./b.js")).b;\n' };
  assert.deepEqual(select(live, ["src/b.ts"]), ["test/a.test.ts", "test/b.test.ts"]);
  // ...and a real static import, with a `//` inside the string literal before it, is kept.
  const urlish = { ...real, "src/a.ts": 'export const u = "http://x/*";\nimport { b } from "./b.js";\n' };
  assert.deepEqual(select(urlish, ["src/b.ts"]), ["test/a.test.ts", "test/b.test.ts"]);
});

test("unit test: a named path never selects a suite by being named", () => {
  const tree = {
    "test/x.test.ts": 'export const t = "test/c.test.ts";\n',
    "test/c.test.ts": "export {};\n",
    "scripts/tool.mjs": "export {};\n",
    "test/tool.test.ts": 'spawn("scripts/tool.mjs");\n',
  };
  // x names c in a string: changing c does not select x.
  assert.deepEqual(select(tree, ["test/c.test.ts"]), ["test/c.test.ts"]);
  // a script named by a suite in a string is still an edge.
  assert.deepEqual(select(tree, ["scripts/tool.mjs"]), ["test/tool.test.ts"]);
});

test("unit test: stripComments keeps strings, templates and regex literals", () => {
  assert.equal(stripComments('const u = "a//b"; // gone\n').trim(), 'const u = "a//b";');
  assert.equal(stripComments("const t = `/* kept */`; /* gone */ x").replace(/\s+/g, " "), "const t = `/* kept */`; x");
  assert.equal(stripComments("const r = /[\"'`]x\\//g; // gone\nimport(\"./k.js\")").replace(/\s+/g, " "), "const r = /[\"'`]x\\//g; import(\"./k.js\")");
  assert.equal(stripComments("a / b // c\n").trim(), "a / b");
});
