import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// A NAMESPACE import: `testTreeId` does not exist at the merge base, and a named import would fail the whole file at
// load, which the reviewer reads as "never ran" rather than as a red.
import * as gardener from "../src/lib/knowledge-gardener.js";
import { gitRepo } from "./helpers/git-repo.js";

/**
 * W1-T6276 — THE GARDENER READS TEST-PINNED LEARNINGS ONCE PER TEST TREE. testPinnedLearnings walked and read every
 * file under test/ on every garden pass, on the daemon thread: a 39.9 s loop block in a live CPU profile
 * (2026-10-07). Its answer moves only when the test tree does, so the scan is keyed on that tree's identity.
 *
 * FIXTURES ONLY: every tree here is a throwaway directory.
 */

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-t6276-"));
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "test", "a.test.ts"), 'const pinned = "rarely-used";\n');
  writeFileSync(join(root, "test", "b.test.ts"), "const nothing = 1;\n");
  return root;
}

function countingRead(): { read: (path: string) => string; count: () => number } {
  let n = 0;
  return { read: (path) => { n++; return readFileSync(path, "utf8"); }, count: () => n };
}

test("W1-T6276: an unchanged test tree is scanned once across garden passes", () => {
  const root = tree();
  const reads = countingRead();
  const opts = { treeId: () => "tree-1", readFile: reads.read };
  const first = gardener.testPinnedLearnings(root, ["rarely-used"], opts);
  const scanned = reads.count();
  assert.ok(scanned >= 2, "control: the first pass reads the test files");
  assert.deepEqual(gardener.testPinnedLearnings(root, ["rarely-used"], opts), first, "the second pass gives the same pins");
  assert.equal(reads.count(), scanned, "the second pass over an unchanged tree reads no test file");
});

test("W1-T6276: a changed test tree is rescanned", () => {
  const root = tree();
  const reads = countingRead();
  assert.deepEqual(gardener.testPinnedLearnings(root, ["rarely-used", "new-pin"], { treeId: () => "tree-a", readFile: reads.read }),
    { "rarely-used": "test/a.test.ts" });
  writeFileSync(join(root, "test", "c.test.ts"), 'const added = "new-pin";\n');
  const before = reads.count();
  assert.deepEqual(gardener.testPinnedLearnings(root, ["rarely-used", "new-pin"], { treeId: () => "tree-b", readFile: reads.read }),
    { "rarely-used": "test/a.test.ts", "new-pin": "test/c.test.ts" }, "the new tree's pin is found");
  assert.ok(reads.count() > before, "a new tree id rescans");
});

test("an unreadable test-tree id scans in full every time, never serving a cached answer", () => {
  // The real default seam: this directory is not a git checkout, so `git rev-parse HEAD:test` fails.
  const root = tree();
  const reads = countingRead();
  gardener.testPinnedLearnings(root, ["rarely-used"], { readFile: reads.read });
  const once = reads.count();
  gardener.testPinnedLearnings(root, ["rarely-used"], { readFile: reads.read });
  assert.equal(reads.count(), once * 2, "no tree id, no reuse");
  assert.ok("unreadable" in gardener.testTreeId(root), "the unreadable id names why");
});

test("the default tree id is read from git and moves with a commit to test/", () => {
  const repo = gitRepo({ kind: "t6276-tree" });
  try {
    mkdirSync(join(repo.dir, "test"), { recursive: true });
    writeFileSync(join(repo.dir, "test", "a.test.ts"), 'const pinned = "rarely-used";\n');
    repo.git("add", "test/a.test.ts");
    repo.git("commit", "-q", "-m", "fixture: a test");
    const first = gardener.testTreeId(repo.dir);
    assert.ok("id" in first, "a committed test/ has a tree id");
    const reads = countingRead();
    gardener.testPinnedLearnings(repo.dir, ["rarely-used"], { readFile: reads.read });
    const scanned = reads.count();
    gardener.testPinnedLearnings(repo.dir, ["rarely-used"], { readFile: reads.read });
    assert.equal(reads.count(), scanned, "the default seam reuses an unchanged tree");
    writeFileSync(join(repo.dir, "test", "b.test.ts"), "const more = 1;\n");
    repo.git("add", "test/b.test.ts");
    repo.git("commit", "-q", "-m", "fixture: another test");
    assert.notDeepEqual(gardener.testTreeId(repo.dir), first, "a commit to test/ moves the tree id");
  } finally {
    repo.cleanup();
  }
});
