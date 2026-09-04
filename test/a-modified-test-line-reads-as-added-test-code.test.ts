// test/a-modified-test-line-reads-as-added-test-code.test.ts — W1-T2815: `detectTestTheater` read the `+` half of a
// MODIFIED test line as ADDED test code, so an in-place rewrite that adds no test case at all was
// refused as `test theater: added tests assert nothing` — a blocking, exemption-free failure.
//
// MEASURED on #3922 (W1-T2775 tranche 1): 52 added test lines, every one a one-token `mkdtempSync`
// prefix rewrite, zero test-case declarations, `testTheater = true` while all 36 check runs were
// green and every acceptance criterion was met. Every fixture below is a hand-authored unified
// diff, never a live `git diff`, so this suite cannot go red because the repository changed.
import assert from "node:assert/strict";
import { test } from "node:test";

import { detectTestTheater } from "../src/lib/review.js";

/** A unified-diff hunk for one test file. `lines` carry their own `+`/`-`/` ` prefix. */
function diffFor(path: string, lines: string[]): string {
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1,4 +1,4 @@", ...lines].join("\n");
}

// ── ACCEPTANCE 1 ─────────────────────────────────────────────────────────────────────────────
// "a diff that only REWRITES existing test lines, declaring no new test case, is no longer test
// theater — the exact shape #3922 was refused for"

test("W1-T2815: an in-place rewrite of existing test lines, declaring no new test case, is NOT test theater", () => {
  // Byte-for-byte the shape of #3922: a `-`/`+` pair per migrated callsite, no assertion, no
  // test-case declaration anywhere in the added set.
  const diff = diffFor("test/a-permanently-uncreditable-head-is-re-dispatched-forever.test.ts", [
    '-  const root = mkdtempSync(join(tmpdir(), "terminal-head-root-"));',
    '+  const root = mkdtempSync(join(tmpdir(), "rmd-terminal-head-root-"));',
    '-  const bin = mkdtempSync(join(tmpdir(), "terminal-head-gh-"));',
    '+  const bin = mkdtempSync(join(tmpdir(), "rmd-terminal-head-gh-"));',
  ]);
  assert.equal(detectTestTheater(diff), false, "a pure in-place rewrite adds no test to judge");
});

test("W1-T2815: a template-literal prefix rewrite — the other migration form — is NOT test theater either", () => {
  const diff = diffFor("test/a-starvation-episode-closes-its-own-escalation.test.ts", [
    "-  const dir = mkdtempSync(join(tmpdir(), `starvation-cleared-${tag}-`));",
    "+  const dir = mkdtempSync(join(tmpdir(), `rmd-starvation-cleared-${tag}-`));",
  ]);
  assert.equal(detectTestTheater(diff), false);
});

// ── ACCEPTANCE 2 ─────────────────────────────────────────────────────────────────────────────
// "a diff that ADDS a new test case with no assertion in it is STILL test theater, so the gate is
// narrowed and not disabled"

test("W1-T2815: an ADDED test case carrying no assertion is STILL test theater — the gate is narrowed, never disabled", () => {
  const diff = diffFor("test/some-feature.test.ts", [
    '+test("the feature works", () => {',
    "+  const result = doTheThing();",
    "+  console.log(result);",
    "+});",
  ]);
  assert.equal(detectTestTheater(diff), true, "a declared test case with no assertion is the shape this gate exists for");
});

test("W1-T2815: an ADDED test case that DOES assert is not theater — the unchanged happy path", () => {
  const diff = diffFor("test/some-feature.test.ts", [
    '+test("the feature works", () => {',
    "+  assert.equal(doTheThing(), 42);",
    "+});",
  ]);
  assert.equal(detectTestTheater(diff), false);
});

// ── ACCEPTANCE 3 ─────────────────────────────────────────────────────────────────────────────
// "a planted tautology is still refused even when no test case is declared among the added lines —
// the NOOP arm stays unconditional"
//
// THIS IS THE FALSIFIER FOR THE GUARD'S PLACEMENT. Moving the declaration guard ABOVE the
// NOOP_ASSERTION_RE check would let a tautology smuggled into an EXISTING test case walk straight
// through, because such a diff declares no new case either.

test("W1-T2815: a planted `assert(true)` inside an EXISTING test case is still refused, though the diff declares no new case", () => {
  const diff = diffFor("test/some-feature.test.ts", [
    "   const result = doTheThing();",
    "+  assert(true);",
  ]);
  assert.equal(detectTestTheater(diff), true, "the NOOP arm must sit ABOVE the declaration guard");
});

test("W1-T2815: `expect(true)` and `assert.equal(true, true)` are refused on the same unconditional arm", () => {
  for (const planted of ["+  expect(true);", "+  assert.equal(true, true);"]) {
    assert.equal(detectTestTheater(diffFor("test/some-feature.test.ts", [planted])), true, planted);
  }
});

// ── ACCEPTANCE 4 ─────────────────────────────────────────────────────────────────────────────
// "the declaration gate reads test/it/describe including their .only/.skip/.each forms, so a
// modifier does not smuggle an assertion-free case past it"

test("W1-T2815: test.only / it.skip / describe.each declare a case, so an assertion-free one is still refused", () => {
  for (const decl of ['+test.only("x", () => {', '+it.skip("x", () => {', '+describe.each([1])("x", () => {', '+it("x", () => {', '+describe("x", () => {']) {
    const diff = diffFor("test/some-feature.test.ts", [decl, "+  doTheThing();", "+});"]);
    assert.equal(detectTestTheater(diff), true, `${decl} must count as a declared test case`);
  }
});

test("W1-T2815: a bare `test` TOKEN that is not a call does not count as a declaration", () => {
  // A variable named `test`, or prose mentioning one, must not make an assertion-free refactor
  // read as an added test case — the guard matches the CALL, never the bare word.
  const diff = diffFor("test/some-feature.test.ts", [
    "-  const testRoot = mkdtempSync(join(tmpdir(), \"old-\"));",
    "+  const testRoot = mkdtempSync(join(tmpdir(), \"rmd-old-\"));",
  ]);
  assert.equal(detectTestTheater(diff), false, "`testRoot` is not a test-case declaration");
});

// ── unchanged behaviour the narrowing must not have touched ──────────────────────────────────

test("W1-T2815: a diff touching no test file at all is still not theater", () => {
  const diff = ["diff --git a/src/lib/x.ts b/src/lib/x.ts", "--- a/src/lib/x.ts", "+++ b/src/lib/x.ts", "@@ -1 +1 @@", "+export const x = 1;"].join("\n");
  assert.equal(detectTestTheater(diff), false);
});

test("W1-T2815: fixture DATA under test/fixtures/ is still excluded from the scan", () => {
  // W1-T2242's surface, deliberately untouched by this task: a planted corpus necessarily CONTAINS
  // the patterns this detector hunts, which is why the exclusion exists.
  const diff = diffFor("test/fixtures/planted/corpus.ts", ['+test("no assertions here", () => {});']);
  assert.equal(detectTestTheater(diff), false);
});
