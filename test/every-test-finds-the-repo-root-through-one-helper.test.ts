// test/every-test-finds-the-repo-root-through-one-helper.test.ts — W1-T9863 (test restructure,
// letter B): about 989 tests computed the repo root as `..` from their own folder, so a suite moved
// down a level would read test/src and pass comparing nothing.
//
// THE GUARD. Counts the test files that still derive the root from their own location. The count at
// HEAD may not exceed the count at the merge base (`git merge-base HEAD origin/main`, derived here,
// never a constant), and a test file ADDED since the merge base contributes 0. It also fault-injects:
// a census-shaped walk pointed at the wrong root must fail its inspected-count assertion.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertInspected, gitTrackedCount } from "./helpers/inspected-population.js";
import { REPO_ROOT, repoRoot } from "./helpers/repo-root.js";
// @ts-expect-error — an .mjs script with no declaration file
import { derivesRootFromOwnLocation, findShapes, isCoveredTestPath, migrate } from "../scripts/test-repo-root-codemod.mjs";

function git(args: string[], cwd = REPO_ROOT): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** The merge base with origin/main, or null when this checkout cannot derive one (shallow clone, no remote). */
function mergeBase(): string | null {
  const result = spawnSync("git", ["merge-base", "HEAD", "origin/main"], { cwd: REPO_ROOT, encoding: "utf8" });
  const sha = result.stdout.trim();
  return result.status === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/** Covered test files at HEAD: tracked, plus untracked-but-not-ignored (a new test counts too). */
function headTestFiles(): string[] {
  return git(["ls-files", "--cached", "--others", "--exclude-standard", "--", "test"]).split("\n").filter(isCoveredTestPath);
}

/** The covered test files whose text derives the root from its own location, at `rev` (null = working tree). */
function ownLocationFiles(rev: string | null): string[] {
  if (rev === null) {
    return headTestFiles().filter((path) => derivesRootFromOwnLocation(readFileSync(join(REPO_ROOT, path), "utf8")));
  }
  const paths = git(["ls-tree", "-r", "--name-only", rev, "--", "test"]).split("\n").filter(isCoveredTestPath);
  // One `git cat-file --batch` process for the whole tree, not one spawn per file.
  const batch = execFileSync("git", ["cat-file", "--batch"], {
    cwd: REPO_ROOT,
    input: paths.map((p) => `${rev}:${p}\n`).join(""),
    maxBuffer: 512 * 1024 * 1024,
  });
  const hits: string[] = [];
  let at = 0;
  for (const path of paths) {
    const eol = batch.indexOf(10, at);
    const [, type, size] = batch.subarray(at, eol).toString("utf8").split(" ");
    assert.equal(type, "blob", `${rev}:${path} is not a blob`);
    const start = eol + 1;
    const body = batch.subarray(start, start + Number(size)).toString("utf8");
    at = start + Number(size) + 1;
    if (derivesRootFromOwnLocation(body)) hits.push(path);
  }
  return hits;
}

test("W1-T9863: the helper resolves the checkout holding this test", () => {
  assert.equal(repoRoot(), REPO_ROOT);
  assert.equal(JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).name, "remudero");
  assert.ok(headTestFiles().includes("test/every-test-finds-the-repo-root-through-one-helper.test.ts"), "the helper's root must hold this very test");
});

test("W1-T9863: the detector recognises each enumerated shape in code and ignores quoted text", () => {
  const shapes: Record<string, string> = {
    "dirname-url": 'const R = join(dirname(fileURLToPath(import.meta.url)), "..");',
    "dirname-global": 'const R = join(__dirname, "..");',
    "import-meta-dir": 'const R = join(import.meta.dirname, "..");',
    "url-dotdot": 'const R = fileURLToPath(new URL("..", import.meta.url));',
    "url-dot-then-dotdot": 'const R = join(fileURLToPath(new URL(".", import.meta.url)), "..");',
    "url-pathname": 'const R = join(new URL("..", import.meta.url).pathname);',
  };
  for (const [name, source] of Object.entries(shapes)) {
    assert.deepEqual(findShapes(source).map((h: { shape: string }) => h.shape), [name], source);
    const migrated = migrate(source);
    assert.match(migrated.text, /const R = findRepoRoot\(\);/, name);
    assert.match(migrated.text, /from "\.\/helpers\/repo-root\.js"/, name);
  }
  assert.equal(derivesRootFromOwnLocation("// " + shapes["dirname-global"]), false, "a comment is not a computation");
  assert.equal(derivesRootFromOwnLocation(JSON.stringify(shapes["dirname-global"])), false, "a string is not a computation");
  assert.equal(derivesRootFromOwnLocation("const t = `\n" + shapes["dirname-global"] + "\n`;"), false, "template text is not a computation");
  assert.equal(derivesRootFromOwnLocation("const t = `${" + shapes["dirname-global"].slice(10, -1) + "}`;"), true, "a template substitution is code");
});

test("W1-T9863: the codemod keeps a join's remaining segments when only the root is replaced", () => {
  const result = migrate('const f = readFileSync(join(new URL("..", import.meta.url).pathname, "DECISIONS.md"), "utf8");\n');
  assert.match(result.text, /readFileSync\(join\(findRepoRoot\(\), "DECISIONS\.md"\), "utf8"\)/);
});

test("W1-T9863: the codemod leaves a trailing-slash root that the file concatenates as a string", () => {
  const source = 'const ROOT = fileURLToPath(new URL("..", import.meta.url));\nconst p = `${ROOT}src/x.ts`;\n';
  const result = migrate(source);
  assert.equal(result.text, source);
  assert.equal(result.left.length, 1);
});

test("W1-T9863: a census pointed at the wrong root fails its inspected count", () => {
  const fixture = mkdtempSync(join(tmpdir(), "rmd-repo-root-"));
  try {
    mkdirSync(join(fixture, "src"));
    mkdirSync(join(fixture, "test", "src"), { recursive: true });
    for (const name of ["a.ts", "b.ts", "c.ts"]) writeFileSync(join(fixture, "src", name), "export {};\n");
    execFileSync("git", ["init", "-q"], { cwd: fixture });
    execFileSync("git", ["add", "-A"], { cwd: fixture });
    // A census-shaped walk: lists the files under `<root>/src` and compares them with git's own count.
    const walk = (root: string): number => {
      const spec = "src";
      const inspected = spawnSync("find", [join(root, spec), "-name", "*.ts"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).length;
      assertInspected("fixture census", inspected, gitTrackedCount(fixture, spec, ".ts"));
      return inspected;
    };
    assert.equal(walk(fixture), 3, "the right root inspects the three tracked files");
    // The wrong root — one level down, where test/src holds nothing — inspects zero and must fail.
    assert.throws(() => walk(join(fixture, "test")), /inspected 0 .*compared nothing/);
    // A wrong root that finds SOME files but not all fails the equality half.
    writeFileSync(join(fixture, "test", "src", "only.ts"), "export {};\n");
    assert.throws(() => walk(join(fixture, "test")), /inspected 1 but an independent count found 3/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("W1-T9863: assertInspected names both counts", () => {
  assert.throws(() => assertInspected("some suite", 2, 5), /some suite: inspected 2 but an independent count found 5/);
  assert.throws(() => assertInspected("some suite", 0, 0), /inspected 0 \(independent count 0\)/);
  assertInspected("some suite", 4, 4);
});

test("W1-T9863: the own-folder root count never rises above the merge base", (t) => {
  const base = mergeBase();
  if (base === null) {
    t.skip("no merge base with origin/main in this checkout (shallow clone or no remote)");
    return;
  }
  const baseCount = ownLocationFiles(base).length;
  const headFiles = ownLocationFiles(null);
  assert.ok(headFiles.length <= baseCount, `${headFiles.length} test files derive the root from their own folder at HEAD, ${baseCount} at merge base ${base.slice(0, 9)}:\n${headFiles.join("\n")}`);
});

test("W1-T9863: no new test derives the repo root from its own folder", (t) => {
  const base = mergeBase();
  if (base === null) {
    t.skip("no merge base with origin/main in this checkout (shallow clone or no remote)");
    return;
  }
  const known = new Set(git(["ls-tree", "-r", "--name-only", base, "--", "test"]).split("\n"));
  const added = headTestFiles().filter((path) => !known.has(path));
  const offenders = added.filter((path) => derivesRootFromOwnLocation(readFileSync(join(REPO_ROOT, path), "utf8")));
  assert.deepEqual(offenders, [], "a new test imports the root from test/helpers/repo-root.ts instead");
});
