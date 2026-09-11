/**
 * W1-T3230. A catch-erasure-safe extraction may need to add a comment to a moved catch arm. That
 * comment is not executable code, so it must not turn the moved statement into a diff-coverage
 * rewrite or split the relocation run around it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/diff-coverage.mjs", import.meta.url));
const { MIN_RELOCATION_RUN, computeRelocatedLines, relocationKey } = (await import(
  pathToFileURL(SCRIPT).href
)) as {
  MIN_RELOCATION_RUN: number;
  relocationKey: (text: string) => string;
  computeRelocatedLines: (
    added: Map<string, Map<number, string>>,
    removed: Map<string, Map<number, string>>,
    opts?: { minRun?: number },
  ) => Map<string, Map<number, { counterpartLine: number; counterpartFile?: string; runLength: number }>>;
};

const DEST = "src/lib/extracted.ts";
const SRC = "src/lib/old-home.ts";

function mapOf(lines: string[], start = 1): Map<number, string> {
  return new Map(lines.map((text, k) => [start + k, text]));
}

function relocatedLines(added: string[], removed: string[]): Map<number, { runLength: number }> {
  return computeRelocatedLines(new Map([[DEST, mapOf(added)]]), new Map([[SRC, mapOf(removed, 500)]]))
    .get(DEST) ?? new Map();
}

function numbered(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `const ${prefix}${i} = ${i};`);
}

test("W1-T3230: a required trailing catch comment does not split a moved relocation run", () => {
  assert.ok(MIN_RELOCATION_RUN > 4, "the fixture relies on both raw fragments falling under the floor");

  const removed = [
    "const before0 = 0;",
    "const before1 = 1;",
    "return fallback;",
    "const after0 = 0;",
    "const after1 = 1;",
    "const after2 = 2;",
    "const after3 = 3;",
  ];
  const added = [...removed];
  added[2] = "return fallback; // required: degrade rather than throw";

  const relocated = relocatedLines(added, removed);
  assert.equal(relocated.size, removed.length, "every moved statement remains one relocation");
  assert.equal(relocated.get(1)?.runLength, removed.length, "the comment-bearing line stays inside the run");
});

test("W1-T3230: comment markers inside string, template literal, and regex values are not stripped", () => {
  const protectedLines = [
    'const url = "http://example.test";',
    'const quoted = "say \\"// still data\\"";',
    "const tpl = `http://example.test`;",
    "const rx = /https?:\\/\\/example\\.test/;",
    "const rxClass = /[/*]+/;",
    'const marker = "/* still data */";',
  ];

  for (const line of protectedLines) {
    assert.equal(relocationKey(line), line);
  }
});

test("W1-T3230: trailing block comments are ignored without stripping embedded block comments", () => {
  assert.equal(relocationKey("return fallback; /* required: degrade rather than throw */"), "return fallback;");
  assert.equal(relocationKey("return fallback; /* required: degrade rather than throw"), "return fallback;");

  const embedded = "const value = choose(/* prefer cached */ fallback);";
  assert.equal(relocationKey(embedded), embedded);
});

test("W1-T3230: a comment-only line cannot join two short fragments into a relocation", () => {
  const before = numbered("before", MIN_RELOCATION_RUN - 1);
  const after = numbered("after", MIN_RELOCATION_RUN - 1);
  const movedWithComment = [...before, "// required: catch erasure reason", ...after];

  const relocated = relocatedLines(movedWithComment, movedWithComment);
  assert.equal(relocated.size, 0, "the comment-only line is not executable relocation evidence");
});

test("W1-T3230: a genuinely rewritten line is still not exempt as a relocation", () => {
  const removed = [
    "const before0 = 0;",
    "const before1 = 1;",
    "return fallback;",
    "const after0 = 0;",
    "const after1 = 1;",
    "const after2 = 2;",
    "const after3 = 3;",
  ];
  const rewritten = [...removed];
  rewritten[2] = "return changedFallback; // required: degrade rather than throw";

  const relocated = relocatedLines(rewritten, removed);
  assert.equal(relocated.size, 0, "comments are ignored, but changed executable text still blocks");
});
