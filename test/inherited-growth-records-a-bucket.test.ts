/**
 * W1-T3180. W1-T3022 bucketed `scripts/comment-load-baseline.json` to end an incident where four
 * of four CONFLICTING PRs conflicted on that one file, every one of them on the key
 * `src/run-task.ts`. The bucket reaches three of the four recording paths. The fourth — the
 * base-inherited write, applied after the judge's switch — recorded the raw measured count.
 *
 * That number is neither the branch's old value nor main's current one, so two branches inheriting
 * the SAME growth wrote two DIFFERENT numbers and conflicted. It fires only on an otherwise
 * PASSING run, so the gate is green while it happens and a worker that then runs `git add -A`
 * ships the line without deciding to. Measured four times in one session across three worktrees.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/comment-load-ratchet.mjs", import.meta.url));
const { ceilingForComments, recordInheritedGrowth } = (await import(pathToFileURL(SCRIPT).href)) as {
  ceilingForComments: (comments: number) => number;
  recordInheritedGrowth: (
    nextBaseline: Record<string, number>,
    inherited: Array<{ path: string; comments: number; atBase: number }>,
  ) => Record<string, number>;
};

const KEY = "src/run-task.ts";

/** One baseline line, as the JSON file actually holds it. */
function baselineLine(value: number): string {
  return `  "src/lib/x.ts": 5,\n  "${KEY}": ${value},\n  "src/spike.ts": 18\n`;
}

/** Three-way merge of one baseline line; true when git resolves it without a conflict. */
function mergesClean(base: number, ours: number, theirs: number): boolean {
  const dir = mkdtempSync(join(tmpdir(), "rmd-inherited-bucket-"));
  try {
    const files = { base: join(dir, "base"), ours: join(dir, "ours"), theirs: join(dir, "theirs") };
    writeFileSync(files.base, baselineLine(base));
    writeFileSync(files.ours, baselineLine(ours));
    writeFileSync(files.theirs, baselineLine(theirs));
    const r = execFileSync("git", ["merge-file", "-p", files.ours, files.base, files.theirs], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return !r.includes("<<<<<<<");
  } catch {
    return false; // git exits non-zero on a conflict
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("an inherited row is recorded at the MERGE BASE's count, not at what this branch measured", () => {
  const written = recordInheritedGrowth({}, [{ path: KEY, comments: 15594, atBase: 15603 }]);
  assert.equal(written[KEY], 15603, "the base is what both branches agree on");
  assert.notEqual(written[KEY], 15594, "the branch's own measurement is what conflicted");
});

test("two branches inheriting the SAME growth write the same number, whatever they each measured", () => {
  // The real shape: two branches behind main, measuring a few comment lines apart because each
  // carries its own edits. Under the raw write these produced different numbers on one line.
  const a = recordInheritedGrowth({}, [{ path: KEY, comments: 15594, atBase: 15603 }])[KEY];
  const b = recordInheritedGrowth({}, [{ path: KEY, comments: 15607, atBase: 15603 }])[KEY];
  assert.equal(a, b, "same base, so the two branches write an identical line");
  assert.ok(mergesClean(15565, a, b), "and that line merges clean three ways");
});

test("NO HEADROOM: the recorded ceiling is exactly the base's count, so later branch growth is charged", () => {
  // This is the property a BUCKET loses, and the reason `atBase` is recorded instead of
  // `ceilingForComments(v.comments)`: rounding up to the next 250 would hand this file up to 249
  // free lines, and growth the branch DOES cause afterwards would stop being refused.
  const atBase = 3;
  const recorded = recordInheritedGrowth({}, [{ path: KEY, comments: 3, atBase }])[KEY];
  assert.equal(recorded, atBase, "no slack is granted at all");
  assert.ok(
    ceilingForComments(atBase) > atBase + 200,
    "the bucket the filed remedy proposed would have granted hundreds of lines of slack here",
  );
  assert.ok(recorded < ceilingForComments(atBase), "so the recorded ceiling is strictly tighter than that bucket");
});

test("MUTANT: the raw-count write puts the two branches in conflict again", () => {
  // Reproduce the PRE-FIX rule over the same inputs rather than asserting the new one twice.
  const rawA = 15594;
  const rawB = 15607;
  assert.notEqual(rawA, rawB, "the pre-fix rule writes what each branch measured");
  assert.equal(mergesClean(15565, rawA, rawB), false, "two different numbers on one line conflict");

  const fixed = recordInheritedGrowth({}, [{ path: KEY, comments: rawA, atBase: 15603 }])[KEY];
  assert.ok(mergesClean(15565, fixed, fixed), "the fix is what moves the verdict");
});

test("rows other than the inherited ones are left exactly as the caller had them", () => {
  const existing = { "src/lib/other.ts": 42, [KEY]: 15565 };
  const written = recordInheritedGrowth(existing, [{ path: KEY, comments: 15594, atBase: 15603 }]);
  assert.equal(written["src/lib/other.ts"], 42, "an untouched row keeps its recorded value");
  assert.equal(written, existing, "the caller's object is mutated in place, as its verdict expects");
  // An empty inherited set writes nothing at all -- a clean run pays nothing.
  assert.deepEqual(recordInheritedGrowth({}, []), {});
});
