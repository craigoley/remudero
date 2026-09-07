// test/baseline-json-duplicate-keys.test.ts — W1-T3023: a ratchet baseline may not carry the same
// key twice inside one object.
//
// WHY THIS EXISTS, MEASURED. Resolving a `scripts/comment-load-baseline.json` rebase conflict by
// taking the UNION of both sides — the obvious move for a file that is one flat sorted map, and
// the one a merge tool suggests — produces a document with the key twice. `JSON.parse` does not
// error on that: it takes the LAST occurrence, silently. On 2026-09-07 that resolution put
// `"src/run-task.ts"` in the file twice, last-wins picked the STALE 16253 over main's 16432, and
// the ratchet then reported a +181 growth that had not happened and printed a ceiling 179 too low
// to record. Recording it would have banked a wrong number into a gate every later PR is measured
// against, and nothing in the pipeline would have said a word. It happened three times in one
// session and was caught by eye each time.
//
// WHY A TEST AND NOT A NOTE. CLAUDE.md's own header says a rule stated only in prose "can be
// violated silently and repeatedly, which is why several of these bullets exist at all", and that
// the fix is to make something REFUSE it. This is the refusal. It needs no allowlist: there is no
// legitimate reason for a ratchet baseline to name one key twice, and a file that does is either a
// bad merge or a generator bug.
//
// THE PARSE MUST BE ITS OWN. Every JSON reader in the standard library — `JSON.parse`, and so
// every `readFileSync(...)` wrapper over it — has already discarded the duplicate by the time it
// returns, so a checker built on one cannot see what it is looking for. The scanner below reads
// the TEXT.

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Every key that appears more than once within a single JSON object, as `<path>.<key>`.
 *
 * A minimal scanner rather than a parser: it tracks string state (with escapes) so a brace or
 * quote inside a value cannot desynchronise it, keeps a stack of containers so an ARRAY OF OBJECTS
 * is handled correctly — sibling objects repeating a field name is normal and must not report —
 * and treats a string as a KEY only when the next non-whitespace character is a colon and the
 * enclosing container is an object.
 */
export function duplicateKeys(text: string): string[] {
  const dups: string[] = [];
  const stack: { isObject: boolean; seen: Set<string> }[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      let raw = "";
      while (j < text.length) {
        if (text[j] === "\\") {
          raw += text[j + 1];
          j += 2;
          continue;
        }
        if (text[j] === '"') break;
        raw += text[j];
        j++;
      }
      let k = j + 1;
      while (k < text.length && /\s/.test(text[k])) k++;
      const top = stack[stack.length - 1];
      if (text[k] === ":" && top?.isObject) {
        if (top.seen.has(raw)) dups.push(raw);
        top.seen.add(raw);
      }
      i = j + 1;
      continue;
    }
    if (c === "{") stack.push({ isObject: true, seen: new Set() });
    else if (c === "[") stack.push({ isObject: false, seen: new Set() });
    else if (c === "}" || c === "]") stack.pop();
    i++;
  }
  return dups;
}

function trackedBaselines(): string[] {
  return execFileSync("git", ["ls-files", "scripts/*baseline*.json"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

test("W1-T3023: the scanner finds a duplicate key, and does not report sibling objects that share field names", () => {
  assert.deepEqual(duplicateKeys('{"a": 1, "b": 2}'), [], "distinct keys are clean");
  assert.deepEqual(duplicateKeys('{"a": 1, "a": 2}'), ["a"], "the same key twice in one object must report");

  // THE FALSE POSITIVE THIS MUST NOT HAVE. A first attempt at this check counted key names across
  // the whole file and flagged every array-of-objects baseline in the repo — assertion-discrimination,
  // state-citation, task-id-existence — because their rows all carry `reason`. Sibling objects are
  // not duplicates.
  assert.deepEqual(duplicateKeys('[{"reason": "x"}, {"reason": "y"}]'), [], "siblings sharing a field are clean");
  assert.deepEqual(duplicateKeys('{"o": {"a": 1}, "p": {"a": 2}}'), [], "nested objects each get their own scope");
  assert.deepEqual(duplicateKeys('{"o": {"a": 1, "a": 2}}'), ["a"], "a duplicate nested one level down still reports");

  // A brace, a quote and a colon inside VALUES must not desynchronise the scan.
  assert.deepEqual(duplicateKeys('{"a": "{\\"x\\": 1}", "b": "c:d"}'), [], "braces and colons inside strings are data");
  assert.deepEqual(duplicateKeys('{"a": "v", "a": "{"}'), ["a"], "and a real duplicate is still found beside them");
});

test("W1-T3023: no tracked ratchet baseline carries a duplicate key", () => {
  const files = trackedBaselines();
  // A POSITIVE CONTROL on the corpus, not a formality: an empty file list and a clean repo are the
  // same green, and this check exists precisely because a silent wrong answer is the failure mode.
  assert.ok(files.length >= 10, `expected the baseline corpus, saw ${files.length} file(s): ${files.join(", ")}`);

  const offenders: string[] = [];
  for (const rel of files) {
    const dups = duplicateKeys(readFileSync(join(ROOT, rel), "utf8"));
    if (dups.length > 0) offenders.push(`${rel}: ${[...new Set(dups)].sort().join(", ")}`);
  }
  assert.deepEqual(
    offenders,
    [],
    "a ratchet baseline names a key twice. JSON.parse takes the LAST one silently, so the gate that " +
      "reads this file is now measuring against a number nobody chose — the signature of a rebase " +
      "conflict resolved by unioning both sides. Resolve it by taking the file from the merge base " +
      "and re-running the ratchet, which prints the number to record.\n" +
      offenders.join("\n"),
  );
});
