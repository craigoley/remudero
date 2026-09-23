/**
 * test/an-operator-memory-stays-loadable.test.ts — W1-T4098.
 *
 * On 2026-09-22 the operator's Claude Code memory index for this repo was at 83% of its load limit
 * with 39 of its 67 links pointing at files that no longer existed. `rmd memory-lint` reports that,
 * and fixes only what is safe to fix.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  fixMemoryDir,
  INDEX_ARCHIVE,
  lintMemoryDir,
  mergeMemoryDirs,
  renderMemoryLint,
  textContainment,
} from "../src/lib/memory-lint.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { memoryLintCommand, memoryLintCorpus } from "../src/run-task.js";

const memory = (name: string, body: string) => `---\nname: ${name}\ndescription: about ${name}\nmetadata:\n  type: feedback\n---\n\n${body}\n`;

function store(files: Record<string, string>, index: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4098-`));
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
  writeFileSync(join(dir, "MEMORY.md"), index.join("\n") + "\n");
  return dir;
}

test("W1-T4098: a dangling index link is reported and removed by fix", () => {
  const dir = store({ "kept.md": memory("kept", "a fact") }, [
    "- [Kept](kept.md) — still here",
    "- [Gone](gone.md) — the only remaining summary of a deleted memory",
  ]);
  const report = lintMemoryDir(dir);
  assert.deepEqual(report.dangling, [{ line: 2, target: "gone.md" }]);
  assert.match(renderMemoryLint(report), /dangling: line 2 links gone\.md/);
  const fixed = fixMemoryDir(dir);
  assert.equal(fixed.removed.length, 1);
  assert.deepEqual(lintMemoryDir(dir).dangling, [], "the index no longer links a missing file");
  assert.match(readFileSync(join(dir, INDEX_ARCHIVE), "utf8"), /the only remaining summary/, "the line is archived, not lost");
  // A file the index does not list is added to it.
  writeFileSync(join(dir, "new.md"), memory("new-one", "another fact"));
  assert.deepEqual(lintMemoryDir(dir).unlisted, ["new.md"]);
  assert.deepEqual(fixMemoryDir(dir).added, ["- [new-one](new.md) — about new-one"]);
  assert.deepEqual(lintMemoryDir(dir).unlisted, []);
  assert.deepEqual(fixMemoryDir(dir), { removed: [], added: [] }, "a clean store is left untouched");
});

test("W1-T4098: an index near the load limit is reported", () => {
  const small = lintMemoryDir(store({}, ["- [a](a.md)"]));
  assert.equal(small.index.load, "ok");
  const near = lintMemoryDir(store({}, Array.from({ length: 160 }, (_, i) => `- line ${i}`)));
  assert.equal(near.index.load, "near", "160 of 200 lines");
  const over = lintMemoryDir(store({}, ["x".repeat(30_000)]));
  assert.equal(over.index.load, "over", "over the byte limit");
  assert.match(renderMemoryLint(near), /of the load limit \(near\)/);
});

test("W1-T4098: a memory that repeats a doctrine rule is reported with the rule", () => {
  const rule = "A zero is not a measurement until a positive control proves the query could see its corpus.";
  const dir = store(
    {
      "repeat.md": memory("repeat", "Remember: a zero is not a measurement until a positive control proves the query could see its corpus."),
      "own.md": memory("own", "The operator prefers tiered responses to fixed caps."),
      "raw.md": "no frontmatter at all",
    },
    ["- [r](repeat.md)", "- [o](own.md)", "- [w](raw.md)"],
  );
  const report = lintMemoryDir(dir, [{ id: "doctrine/investigation-discipline/zero.md", text: rule }]);
  assert.deepEqual(report.duplicates.map((d) => [d.file, d.of]), [["repeat.md", "doctrine/investigation-discipline/zero.md"]]);
  assert.deepEqual(report.missingFrontmatter, ["raw.md"]);
  assert.ok(textContainment("one two three four", "zero one two three four") === 1);
  assert.equal(textContainment("", "anything"), 0);
  // The real corpus holds this repo's doctrine bodies and learnings.
  const corpus = memoryLintCorpus(process.cwd());
  assert.ok(corpus.some((k) => k.id.startsWith("doctrine/")), "doctrine bodies are in the corpus");
  assert.ok(corpus.some((k) => k.id.startsWith("learnings#")), "learnings are in the corpus");
  assert.deepEqual(memoryLintCorpus(join(tmpdir(), "no-such-repo-w1t4098")), []);
});

test("W1-T4098: fix never deletes a memory file", () => {
  const dir = store({ "a.md": memory("a", "x"), "b.md": memory("b", "y") }, ["- [gone](gone.md)"]);
  const before = readdirSync(dir).filter((f) => f !== "MEMORY.md").sort();
  fixMemoryDir(dir);
  const after = readdirSync(dir).filter((f) => f !== "MEMORY.md" && f !== INDEX_ARCHIVE).sort();
  assert.deepEqual(after, before);
  // Merge moves every file, keeps both on a name clash, and leaves both indexes consistent.
  const from = store({ "a.md": memory("a", "from"), "c.md": memory("c", "z") }, ["- [a](a.md)", "- [c](c.md)"]);
  const { moved } = mergeMemoryDirs(from, dir);
  assert.deepEqual(moved, [{ from: "a.md", to: "a-2.md" }, { from: "c.md", to: "c.md" }]);
  assert.ok(existsSync(join(dir, "a-2.md")) && existsSync(join(dir, "a.md")));
  assert.deepEqual(lintMemoryDir(dir).unlisted, []);
  assert.deepEqual(lintMemoryDir(from).dangling, []);
});

test("W1-T4098: the command reports, fixes and merges", (t) => {
  const lines: string[] = [];
  t.mock.method(console, "log", (s: string) => lines.push(s));
  const dir = store({ "a.md": memory("a", "x") }, ["- [a](a.md)", "- [gone](gone.md)"]);
  assert.equal(memoryLintCommand([]), 2, "no directory is a usage error");
  assert.equal(memoryLintCommand(["--merge"]), 2);
  assert.equal(memoryLintCommand([dir]), 1, "findings without --fix exit non-zero");
  assert.equal(memoryLintCommand(["--fix", dir]), 0);
  assert.ok(lines.some((l) => /fixed .*removed 1 dangling/.test(l)));
  const from = store({ "m.md": memory("m", "moved") }, ["- [m](m.md)"]);
  assert.equal(memoryLintCommand(["--merge", from, dir]), 0);
  assert.ok(lines.some((l) => /merged 1 memories/.test(l)));
  mkdirSync(join(dir, "sub"));
  assert.equal(memoryLintCommand([dir]), 0, "a subdirectory is not a memory");
});
