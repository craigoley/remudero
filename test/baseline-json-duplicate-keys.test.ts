// test/baseline-json-duplicate-keys.test.ts — W1-T3023: a ratchet baseline may not name a key twice.
//
// WHY, MEASURED. Resolving a `scripts/comment-load-baseline.json` rebase conflict by taking the
// UNION of both sides — the obvious move for a flat sorted map, and what a merge tool suggests —
// produces a document with the key twice. `JSON.parse` does not error: it takes the LAST one,
// silently. On 2026-09-07 that put "src/run-task.ts" in the file twice, last-wins picked the stale
// 16253 over main's 16432, and the ratchet reported a +181 growth that had not happened against a
// ceiling 179 too low to record. That conflict arose FOUR times in one session, caught by eye each
// time. Recording the printed number would have banked a wrong ceiling into a gate every later PR
// is measured against, with nothing in the pipeline saying a word.
//
// WHY IN `readBaseline` AND NOT A SUITE THAT WALKS THE BASELINES. Two reasons. It is where the
// defect BITES — that function's own doc already refuses "a silently-disarmed ceiling", and a
// duplicate key is exactly one — so a worker running the two cheap ratchets before its first push
// (the W1-T2997 contract) is refused locally instead of by CI. And a test that ENUMERATED the
// baseline files would be census-shaped: the census recognizer detects a suite that walks a file
// population, and `censusPopulationDrift` then refuses it as an undisclosed census suite until
// CENSUS_POPULATION names it — which for an ADMITTED member means a fast-gate job of its own. A
// millisecond check does not earn a CI step.
//
// A TRAP WORTH THE LINE, since this file met it: that recognizer greps SOURCE TEXT, so a comment
// merely NAMING the enumeration idioms trips it exactly as a real caller would. An earlier draft of
// this very paragraph listed them and was refused as an undisclosed suite. Describe the shape;
// do not spell the tokens.
//
// Everything below drives inline text through the REAL exported functions.

import assert from "node:assert/strict";
import { test } from "node:test";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The repo's idiom for a plain-JS script under test: a dynamic import with an explicit cast, since
// the .mjs files carry no declarations (test/comment-load-ratchet.test.ts does the same).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = async (rel: string) => (await import(pathToFileURL(join(REPO_ROOT, rel)).href)) as Record<string, Function>;

const { duplicateKeys } = await load("scripts/lib/json-duplicate-keys.mjs");
const { readBaseline: readCommentLoadBaseline } = await load("scripts/comment-load-ratchet.mjs");
const { readBaseline: readSourceSizeBaseline } = await load("scripts/source-size-ratchet.mjs");

test("W1-T3023: the scanner finds a key repeated inside one object", () => {
  assert.deepEqual(duplicateKeys('{"a": 1, "b": 2}'), [], "distinct keys are clean");
  assert.deepEqual(duplicateKeys('{"a": 1, "a": 2}'), ["a"], "the same key twice in one object reports");
  assert.deepEqual(duplicateKeys('{"o": {"a": 1, "a": 2}}'), ["a"], "and one level down too");
});

test("W1-T3023: sibling objects sharing a field name are NOT duplicates", () => {
  // THE FALSE POSITIVE THIS MUST NOT HAVE. Counting key names file-wide — the naive version of this
  // check — flags four legitimate baselines in this repo (assertion-discrimination, state-citation,
  // task-id-existence, mutation) because every row in them carries `reason`.
  assert.deepEqual(duplicateKeys('[{"reason": "x"}, {"reason": "y"}]'), []);
  assert.deepEqual(duplicateKeys('{"o": {"a": 1}, "p": {"a": 2}}'), []);
});

test("W1-T3023: a brace, quote or colon inside a VALUE does not desynchronise the scan", () => {
  assert.deepEqual(duplicateKeys('{"a": "{\\"x\\": 1}", "b": "c:d"}'), [], "punctuation in strings is data");
  assert.deepEqual(duplicateKeys('{"a": "v", "a": "{"}'), ["a"], "and a real duplicate beside it is still found");
});

test("W1-T3023: comment-load's readBaseline refuses a duplicate key and names the remedy", () => {
  // The exact shape the bad union produced: the stale value appended after the current one.
  const unioned = '{\n  "src/lib/x.ts": 10,\n  "src/run-task.ts": 16432,\n  "src/run-task.ts": 16253\n}\n';
  assert.equal(JSON.parse(unioned)["src/run-task.ts"], 16253, "JSON.parse silently takes the LAST — the defect");

  assert.throws(
    () => readCommentLoadBaseline(unioned, "scripts/comment-load-baseline.json"),
    (e: unknown) => {
      const msg = (e as Error).message;
      assert.match(msg, /names a key twice/);
      assert.match(msg, /src\/run-task\.ts/, "the offending key must be named");
      assert.match(msg, /merge base/, "and the remedy stated");
      return true;
    },
  );
  // A clean baseline still reads, so the guard is not a blanket refusal.
  assert.deepEqual(readCommentLoadBaseline('{"src/a.ts": 3}', "p"), { "src/a.ts": 3 });
});

test("W1-T3023: source-size's readBaseline refuses one too — the sibling with the same union hazard", () => {
  assert.throws(
    () => readSourceSizeBaseline('{"src/a.ts": 500, "src/a.ts": 250}', "scripts/source-size-baseline.json"),
    /names a key twice/,
  );
  assert.deepEqual(readSourceSizeBaseline('{"src/a.ts": 500}', "p"), { "src/a.ts": 500 });
});
