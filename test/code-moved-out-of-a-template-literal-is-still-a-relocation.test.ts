/**
 * W1-T3189. The console's DOM client lives inside a raw string in `renderShellHtml`'s template
 * literal, where every backtick and `${` carries a backslash. Lifting it into a real module strips
 * those escapes, so `diff-coverage` compared a rewritten line against its own original and saw a
 * rewrite where there was a move.
 *
 * The direct miss is the escaped lines. The EXPENSIVE miss is second-order: an unmatched line
 * splits the run around it, and either piece shorter than MIN_RELOCATION_RUN is discarded whole —
 * so a few escaped lines disqualify the unescaped lines beside them. The fragmentation test below
 * is the one that measures that, and it is why this is worth more than the escaped lines alone.
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

const DEST = "src/lib/console-shell-client.ts";
const SRC = "src/lib/serve.ts";

/** Lines as they sit INSIDE the template literal: backticks and `${` are backslash-escaped. */
const ESCAPED = [
  "  const params = new URLSearchParams(window.location.search);",
  "  const token = params.get(\"token\") ?? \"\";",
  "  const authHeaders = { authorization: \\`Bearer \\${token}\\` };",
  "  const WRITE_TOKEN_STORAGE_KEY = \"rmd-console-write-token\";",
  "  function readStoredWriteToken() {",
  "    return window.localStorage.getItem(WRITE_TOKEN_STORAGE_KEY);",
  "  }",
];
/** The same lines after the move, which is what the new module actually contains. */
const UNESCAPED = ESCAPED.map((l) => l.replace(/\\`/g, "`").replace(/\\\$\{/g, "${"));

function mapOf(lines: string[], start = 1): Map<number, string> {
  return new Map(lines.map((text, k) => [start + k, text]));
}

function relocate(added: Map<string, Map<number, string>>, removed: Map<string, Map<number, string>>) {
  return computeRelocatedLines(added, removed);
}

test("the escaped line and its unescaped counterpart share one comparison key", () => {
  assert.equal(
    relocationKey("  const authHeaders = { authorization: \\`Bearer \\${token}\\` };"),
    relocationKey("  const authHeaders = { authorization: `Bearer ${token}` };"),
  );
  // Only the escaping is normalised: genuinely different text stays different.
  assert.notEqual(relocationKey("const a = 1;"), relocationKey("const a = 2;"));
  // And a line with no escapes is untouched beyond the trim it always got.
  assert.equal(relocationKey("  const a = `plain`;  "), "const a = `plain`;");
});

test("a block lifted out of a template literal is exempt as a relocation", () => {
  const got = relocate(new Map([[DEST, mapOf(UNESCAPED)]]), new Map([[SRC, mapOf(ESCAPED, 500)]]));
  assert.equal(got.get(DEST)?.size, UNESCAPED.length, "every moved line is accounted for");
  assert.equal(got.get(DEST)?.get(1)?.counterpartFile, SRC, "and credited to the file it came from");
});

test("FRAGMENTATION: escaped lines mid-block no longer disqualify the unescaped lines around them", () => {
  // Two escaped lines sit in the middle. Under raw matching they split a 7-line run into runs of
  // 2 and 3 — both under MIN_RELOCATION_RUN — so the WHOLE block was discarded, not just the two.
  assert.ok(MIN_RELOCATION_RUN > 3, "this fixture only bites while the floor exceeds 3");
  const escapedInMiddle = ESCAPED.indexOf(ESCAPED[2]);
  assert.equal(escapedInMiddle, 2, "the fixture's escaped line is interior, not at an edge");

  const got = relocate(new Map([[DEST, mapOf(UNESCAPED)]]), new Map([[SRC, mapOf(ESCAPED, 500)]]));
  assert.equal(got.get(DEST)?.size, 7);
  // The run is recognised as ONE run, which is exactly what the raw comparison could not do.
  assert.equal(got.get(DEST)?.get(1)?.runLength, 7);
});

test("the reverse move — code pushed INTO a literal, which ADDS escapes — normalises identically", () => {
  const got = relocate(new Map([[SRC, mapOf(ESCAPED)]]), new Map([[DEST, mapOf(UNESCAPED, 900)]]));
  assert.equal(got.get(SRC)?.size, ESCAPED.length);
});

test("nothing is admitted that was not already admissible: new code and short runs stay flagged", () => {
  const brandNew = [
    "  function neverExistedBefore() {",
    "    return computeSomethingNobodyRemoved();",
    "  }",
    "  const alsoNew = 42;",
    "  const stillNew = 43;",
    "  const yetMoreNew = 44;",
  ];
  const none = relocate(new Map([[DEST, mapOf(brandNew)]]), new Map([[SRC, mapOf(ESCAPED, 500)]]));
  assert.equal(none.get(DEST)?.size ?? 0, 0, "unescaping must not manufacture a match");

  // A move SHORTER than the floor is still not a relocation — the bound is untouched.
  const short = UNESCAPED.slice(0, MIN_RELOCATION_RUN - 1);
  const tooShort = relocate(
    new Map([[DEST, mapOf(short)]]),
    new Map([[SRC, mapOf(ESCAPED.slice(0, MIN_RELOCATION_RUN - 1), 500)]]),
  );
  assert.equal(tooShort.get(DEST)?.size ?? 0, 0, `a run under ${MIN_RELOCATION_RUN} is not a relocation`);
});

test("MUTANT: comparing raw text again collapses the block below the run floor", () => {
  // The falsifier reproduces the PRE-FIX comparison over the same fixture rather than asserting
  // the new behaviour twice: feed the removed side WITHOUT normalisation and the escaped line in
  // the middle splits the run into 2 and 3, both under the floor, so nothing is exempt.
  const rawRemoved = new Map([[SRC, mapOf(ESCAPED, 500)]]);
  const rawAdded = new Map([[DEST, mapOf(UNESCAPED)]]);
  const withFix = relocate(rawAdded, rawRemoved).get(DEST)?.size ?? 0;
  assert.equal(withFix, 7);

  // Same inputs, but with the escapes left in place on BOTH sides at the interior line only —
  // i.e. the destination still carrying one line the source never matched. That is precisely the
  // shape raw comparison produced, and it must exempt nothing.
  const stillEscaped = [...UNESCAPED];
  stillEscaped[2] = "  const authHeaders = { authorization: SOMETHING_ELSE_ENTIRELY };";
  const fragmented = relocate(new Map([[DEST, mapOf(stillEscaped)]]), rawRemoved).get(DEST)?.size ?? 0;
  assert.equal(fragmented, 0, "runs of 2 and 3 are both under the floor, so the whole block is discarded");
  assert.ok(withFix > fragmented, "the fix is what moves the verdict");
});
