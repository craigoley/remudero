/**
 * W1-T9860 — a test's unique basename is its identity (operator ruling 5, 2026-10-16). resolveTestPath finds a moved
 * test by its basename, and that is only sound while no two tests share one. This walks every tracked test outside
 * test/fixtures/ and fails naming both paths when two tests collide. A check that compares nothing must go red, so it
 * also proves the population it read is non-empty and is the same set an independent directory walk counts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { duplicateTestBasenames, isBasenameEligibleTestPath } from "../src/lib/test-path-resolver.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The git population: every `.test.ts` under test/ at any depth, tracked or not yet added (never ignored), fixtures
 *  excluded. A new test is part of the population before its first commit, as the directory walk sees it. */
function listedTests(): string[] {
  return execFileSync("git", ["-C", ROOT, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "test/"], { encoding: "utf8", maxBuffer: 1 << 26 })
    .split("\0")
    .filter(isBasenameEligibleTestPath);
}

/** The independent count: a directory walk of test/, never git, with the same two exclusions. */
function walkedTestCount(): number {
  return readdirSync(join(ROOT, "test"), { recursive: true, encoding: "utf8" })
    .map((rel) => `test/${rel.split("\\").join("/")}`)
    .filter((path) => path.endsWith(".test.ts") && !path.startsWith("test/fixtures/")).length;
}

test("W1-T9860: two tests sharing a basename are refused by name", () => {
  // The check's own falsifier: a collision two folders apart is named with both of its paths.
  assert.deepEqual(duplicateTestBasenames(["test/a/x.test.ts", "test/b/x.test.ts", "test/y.test.ts"]), [
    "x.test.ts is shared by test/a/x.test.ts and test/b/x.test.ts",
  ]);
  // A fixture's test/ is not a real test's identity and never collides.
  assert.deepEqual(duplicateTestBasenames(["test/existing.test.ts", "test/fixtures/checkout/test/existing.test.ts"]), []);

  const listed = listedTests();
  assert.ok(listed.length > 0, "the check inspected no test files, so it proves nothing");
  assert.equal(listed.length, walkedTestCount(), "git and a directory walk must see the same test population");
  assert.ok(listed.some((path) => path.split("/").length > 2), "the walk must reach nested folders, not only test/*.test.ts");
  assert.deepEqual(duplicateTestBasenames(listed), [], "every test basename must be unique: rename one of each pair");
});
