// @source-text-subject: test/ — this census's subject is what every suite reads as text; its fixtures are read-call strings.
// @census-reads: test/ — the declaration replaces what the fixture strings below appear to read.
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  discoverSourceTextReaders,
  isUnplacedSourceReader,
  missingPopulationControls,
  readerJoins,
  sourceTextReaderOf,
  type SourceTextReader,
} from "#src/lib/source-text-readers.js";

/**
 * A census that reads source text joins every diff that edits that text, whatever its enumeration
 * idiom. MEASURED 2026-10-15: #12019 (W1-T9426) and #12104 (W1-T9667) each passed `rmd
 * census-membership` and went red in CI on a suite the verb never named, because the census
 * recognizer only admits a suite by the spelling of its directory walk.
 * test/a-wall-clock-bound-declares-itself.test.ts walks `test/*.test.ts` through `git grep`, and
 * test/a-generic-route-has-an-explicit-tool-bound.test.ts reads src/run-task.ts through one
 * `readFileSync`; neither was even listed as unmodelled.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = new Set(["src", "test", "scripts", "deploy", "README.md", ".github"]);

export function assertSourceReaderCensus(readers: readonly SourceTextReader[]): void {
  assert.deepEqual(missingPopulationControls(readers), [], "discovery must see both source and test readers");
  const unplaced = readers.filter(isUnplacedSourceReader).map((r) => r.testFile);
  assert.deepEqual(
    unplaced,
    [],
    "these suites declare source text as their subject but name no path rmd census-membership can join a diff to. " +
      "Add `// @census-reads: <path or glob> ...` naming what each reads (or `none` when the marker is about a fixture).",
  );
}

test("every source-reading suite is placed by what it reads or declares it", () => {
  assertSourceReaderCensus(discoverSourceTextReaders(REPO_ROOT));
});

test("the meta-census names a marked suite whose read cannot be derived", () => {
  const marked = "// @source-text-subject: every route\nconst text = readFileSync(pathFromSomewhere(), 'utf8');";
  assert.equal(isUnplacedSourceReader(sourceTextReaderOf("test/x.test.ts", marked, ROOTS)), true);
  const declared = `// @census-reads: src/lib/serve.ts — routes\n${marked}`;
  const placed = sourceTextReaderOf("test/x.test.ts", declared, ROOTS);
  assert.equal(isUnplacedSourceReader(placed), false);
  assert.deepEqual(placed.walks, ["src/lib/serve.ts"], "only the leading path tokens are the declaration");
  const none = sourceTextReaderOf("test/x.test.ts", `// @census-reads: none — a fixture ledger\n${marked}`, ROOTS);
  assert.equal(isUnplacedSourceReader(none), false);
  assert.deepEqual(none.walks, []);
});

test("a read is placed by the path it names, in every spelling", () => {
  const walksOf = (text: string) => sourceTextReaderOf("test/x.test.ts", text, ROOTS).walks;
  assert.deepEqual(walksOf('readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8")'), ["src/run-task.ts"]);
  assert.deepEqual(walksOf('readFileSync(join(REPO_ROOT, "src", "lib", "sweep.ts"), "utf8")'), ["src/lib/sweep.ts"]);
  assert.deepEqual(walksOf('readFileSync(join(REPO_ROOT, "src", file), "utf8")'), ["src/"], "a variable segment walks the directory");
  assert.deepEqual(walksOf("readFileSync(`${root}/scripts/x.mjs`, \"utf8\")"), ["scripts/x.mjs"]);
  assert.deepEqual(
    walksOf('const RUN_TASK = join(ROOT, "src/run-task.ts");\nconst src = readFileSync(RUN_TASK, "utf8");'),
    ["src/run-task.ts"],
    "one hop through a named path",
  );
  assert.deepEqual(walksOf('readFileSync(join(ROOT, "README.md"), "utf8")'), ["README.md"]);
  assert.deepEqual(walksOf('readFileSync(join(dir, "state.json"), "utf8")'), [], "a temp fixture is not the tree");
});

test("a git pathspec walk is placed by its pathspec, and an exclusion is not a walk", () => {
  const walksOf = (text: string) => sourceTextReaderOf("test/x.test.ts", text, ROOTS);
  const grep = walksOf('execFileSync("git", ["grep", "-nE", "assert.*<", "--", "test/*.test.ts"])');
  assert.deepEqual(grep.walks, ["test/"]);
  assert.equal(grep.censusShaped, true, "a pathspec walk is a census whatever its markers");
  assert.deepEqual(walksOf('git(["grep", "-l", "x", "--", "src/**/*.ts", ":!src/spike.ts"])').walks, ["src/"]);
  const plain = walksOf('const t = readFileSync(new URL("../src/x.ts", import.meta.url), "utf8");');
  assert.equal(plain.censusShaped, false, "an unmarked text read is a reader, not a census");
});

test("a reader joins the paths under its walks and nothing else", () => {
  const reader = { walks: ["src/run-task.ts", "test/"] };
  assert.equal(readerJoins(reader, "src/run-task.ts"), true);
  assert.equal(readerJoins(reader, "test/new.test.ts"), true);
  assert.equal(readerJoins(reader, "src/lib/worker.ts"), false);
});

test("discovery reads a git grep no-match as zero readers and any other failure as a failure", () => {
  const exit = (status: number) => {
    const e = new Error(`git exited ${status}`) as Error & { status: number };
    e.status = status;
    return e;
  };
  const git = (status: number) => (args: readonly string[]) => {
    if (args[0] !== "grep") return "src/a.ts\n";
    throw exit(status);
  };
  assert.deepEqual(discoverSourceTextReaders("/repo", git(1), () => ""), []);
  assert.throws(() => discoverSourceTextReaders("/repo", git(128), () => ""), /git exited 128/);
});
