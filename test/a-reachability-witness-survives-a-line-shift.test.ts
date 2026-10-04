import assert from "node:assert/strict";
import { test } from "node:test";

import { callSiteKey, enclosingTestTitle, numberCallSites } from "./helpers/test-call-site-key.js";

// ── W1-T5622: the operator-gated reachability census keys a witness by its enclosing TEST TITLE ──
//
// test/operator-gated-default-reachability.test.ts pinned its witnesses and exclusions as
// `name:file:line`. The two armIfVerdictPermits witnesses in test/run-task.test.ts were
// re-derived in 16 commits (#8970: 6165->6167, 6226->6228) by PRs that never touched arming —
// any line inserted above a call site reddened the census with no change in reachability. The
// key is now `name:file:<title>#<ordinal>`, which a line shift cannot move.
//
// These tests drive the SAME key function the census uses, fed a full row that still CARRIES its
// `line` (the census reports `file:line` to humans), so a key that read the line again would
// change under the shift below.

const FIXTURE = [
  'import { armIfVerdictPermits } from "../src/lib/arm-auto-merge.ts";',
  "",
  'test("a passing verdict arms the PR", () => {',
  "  const outcome = armIfVerdictPermits(verdict, ctx, { arm });",
  "  assert.equal(outcome, \"armed\");",
  "});",
  "",
  "test('a refused verdict never arms', () => {",
  "  armIfVerdictPermits(refused, ctx, { arm });",
  "  armIfVerdictPermits(refused, ctx, { arm, ledgerLines });",
  "});",
].join("\n");

interface Row {
  name: string;
  file: string;
  line: number;
  title: string | undefined;
}

/** Every `armIfVerdictPermits(` call in `text`, as the census's own rows: line AND title. */
function rowsOf(text: string): Array<Row & { ordinal: number }> {
  const rows: Row[] = [];
  const re = /\barmIfVerdictPermits\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    rows.push({
      name: "armIfVerdictPermits",
      file: "test/fixture.test.ts",
      line: text.slice(0, m.index).split("\n").length,
      title: enclosingTestTitle(text, m.index),
    });
  }
  return numberCallSites(rows);
}

test("a call site's key is unchanged when lines are inserted above it, though its line number moved", () => {
  const before = rowsOf(FIXTURE);
  const shifted = rowsOf(["// an unrelated import", "// and a second comment", "", FIXTURE].join("\n"));
  assert.equal(before.length, 3, "sanity: the fixture's three call sites were all found");
  assert.equal(shifted.length, 3);
  for (let i = 0; i < before.length; i++) {
    assert.equal(shifted[i].line, before[i].line + 3, "sanity: the shift really moved the call site");
    assert.equal(callSiteKey(shifted[i]), callSiteKey(before[i]), "the key must not move with the line");
  }
});

test("the key names the call's enclosing test title and its ordinal among same-name calls there", () => {
  const keys = rowsOf(FIXTURE).map((r) => callSiteKey(r));
  assert.deepEqual(keys, [
    "armIfVerdictPermits:test/fixture.test.ts:a passing verdict arms the PR#1",
    "armIfVerdictPermits:test/fixture.test.ts:a refused verdict never arms#1",
    "armIfVerdictPermits:test/fixture.test.ts:a refused verdict never arms#2",
  ]);
});

test("enclosingTestTitle reads the NEAREST preceding test title, in any quote style", () => {
  const text = 'test("first", () => {});\nit(`second`, () => {\n  call();\n});';
  assert.equal(enclosingTestTitle(text, text.indexOf("call")), "second");
  assert.equal(enclosingTestTitle(text, text.indexOf("it(")), "first");
  const escaped = "test(\"says \\\"hi\\\"\", () => { x(); });";
  assert.equal(enclosingTestTitle(escaped, escaped.indexOf("x(")), 'says \\"hi\\"', "the literal is read raw, escapes intact");
});

test("enclosingTestTitle ignores a method named test (`re.test(...)`) and a non-literal first argument", () => {
  const text = 'test("outer", () => {\n  /x/.test("not a title");\n  test(name, () => {});\n  call();\n});';
  assert.equal(enclosingTestTitle(text, text.indexOf("call")), "outer");
});

test("a call site above every test has no title and is keyed as module scope", () => {
  const text = "const run = () => armIfVerdictPermits(v, c, d);\ntest(\"later\", () => {});";
  assert.equal(enclosingTestTitle(text, text.indexOf("armIfVerdictPermits")), undefined);
  const rows = numberCallSites([{ name: "armIfVerdictPermits", file: "test/f.test.ts", line: 1, title: undefined }]);
  assert.equal(callSiteKey(rows[0]), "armIfVerdictPermits:test/f.test.ts:<module>#1");
});

test("numberCallSites counts ordinals per name, file and title — never across them", () => {
  const rows = numberCallSites([
    { name: "a", file: "f", title: "t" },
    { name: "b", file: "f", title: "t" },
    { name: "a", file: "g", title: "t" },
    { name: "a", file: "f", title: "u" },
    { name: "a", file: "f", title: "t" },
  ]);
  assert.deepEqual(rows.map((r) => r.ordinal), [1, 1, 1, 1, 2]);
});
