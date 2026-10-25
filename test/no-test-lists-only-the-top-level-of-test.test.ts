// @source-text-subject: this guard's subject IS the shape of a test file's directory walk — a call site is only visible as text.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { maskLiterals, stripComments } from "#src/lib/test-impact-map.js";

/**
 * W1-T9872 (test restructure, letter D, part 4). A census test that lists `test/` with a bare
 * `readdirSync(TEST_DIR)` sees only the top level. The day a suite moves into a subfolder it silently
 * leaves every such census's population, and nothing goes red. Enumerate tracked files instead:
 * `git ls-files -- ':(top,glob)test/**\/*.test.ts'`, which is independent of where the suite lives.
 *
 * This guard finds a `readdirSync` / `readdir` call whose directory is anchored to test/ (an identifier
 * built from `import.meta.url` / `__dirname`, or `join(<root>, "test")`) and that carries no
 * `recursive` option, and requires the list to be empty. A path from `mkdtemp` or a fixture is not
 * anchored to test/ and is not counted.
 */

const SELF = "no-test-lists-only-the-top-level-of-test.test.ts";
const HERE = fileURLToPath(new URL(".", import.meta.url));

/** The text of a call's arguments, from just after its `(` to the matching `)`. */
function callArgs(text: string, open: number): string {
  let depth = 1;
  let i = open;
  while (i < text.length && depth > 0) {
    const c = text[i++];
    if (c === "(") depth++;
    else if (c === ")") depth--;
  }
  return text.slice(open, i - 1);
}

/** Every top-level-only listing of test/ in `text`, each as `<callee>(<first argument>)`. */
export function topLevelTestWalks(text: string): string[] {
  text = stripComments(text);
  const code = maskLiterals(text);
  const anchored = new Set<string>();
  for (const m of code.matchAll(/(?:const|let)\s+(\w+)\s*(?::[^=\n]+)?=\s*([^;\n]*)/g)) {
    const expr = text.slice(m.index! + m[0].length - m[2].length, m.index! + m[0].length);
    const executable = maskLiterals(expr);
    const fromHere = /import\.meta\.url|__dirname/.test(executable) && !/\.\./.test(expr);
    const fromRoot = /["']test["']\s*\)/.test(expr) && /\b(?:join|resolve)\(/.test(expr);
    if (fromHere || fromRoot) anchored.add(m[1]);
  }
  const found: string[] = [];
  for (const m of code.matchAll(/\b(readdirSync|readdir)\(/g)) {
    const args = callArgs(text, m.index! + m[0].length);
    if (/recursive/.test(args)) continue;
    const first = args.split(/,(?![^()]*\))/)[0].trim();
    const direct = /import\.meta\.url|__dirname/.test(first) && !/\.\./.test(first);
    const rooted = /^(?:path\.)?(?:join|resolve)\(\s*[\w.]+\s*,\s*["']test["']\s*\)$/.test(first);
    if (anchored.has(first) || direct || rooted) found.push(`${m[1]}(${first})`);
  }
  return found;
}

/** Tracked test files at any depth, relative to the repo root, minus fixtures and this guard. */
function population(): string[] {
  const listed = execFileSync("git", ["ls-files", "--full-name", "--", ":(top,glob)test/**/*.test.ts"], {
    cwd: HERE,
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  return listed
    .split("\n")
    .filter((f) => f.startsWith("test/") && !f.startsWith("test/fixtures/") && f.split("/").at(-1) !== SELF);
}

/**
 * Suites outside W1-T9872's declared files that still list only the top level. Each is a real census
 * walk and is the next repair; the entry is keyed by file plus the observed call, never by line, and a
 * stale entry (the walk was fixed) fails the last test here so the list can only shrink.
 */
const KNOWN_DEBT: ReadonlyMap<string, readonly string[]> = new Map([
  ["a-plan-only-diff-runs-the-suites-that-read-its-paths.test.ts", ['readdirSync(join(REPO_ROOT, "test"))']],
  ["a-mint-test-reads-only-its-own-fixture.test.ts", ["readdirSync(TEST_DIR)"]],
  ["a-shard-that-produced-no-summary-is-not-a-failure-set.test.ts", ['readdirSync(join(REPO_ROOT, "test"))']],
  ["mutation-per-file-runner.test.ts", ["readdirSync(join(__dirname))"]],
  ["the-fast-lane-cannot-see-a-suite-that-joins-its-docs-path.test.ts", ["readdirSync(testDir)"]],
  ["the-gate-admission-population-is-checked-from-one-scan.test.ts", ['readdirSync(join(REPO_ROOT, "test"))']],
]);

function scanTree(): { offenders: string[]; debt: Map<string, string[]> } {
  const offenders: string[] = [];
  const debt = new Map<string, string[]>();
  for (const file of population()) {
    const hits = topLevelTestWalks(readFileSync(join(HERE, "..", file), "utf8"));
    const name = file.split("/").at(-1)!;
    const known = KNOWN_DEBT.get(name);
    const unknown = hits.filter((h) => !known?.includes(h));
    for (const h of unknown) offenders.push(`${file}: ${h}`);
    if (known && hits.length > unknown.length) debt.set(name, hits.filter((h) => known.includes(h)));
  }
  return { offenders, debt };
}

test("W1-T9872: a test listing only the top level of test/ is refused", () => {
  const { offenders } = scanTree();
  assert.deepEqual(
    offenders,
    [],
    `a census that lists test/ with a bare readdirSync leaves its population when a suite moves into a subfolder; ` +
      `enumerate git ls-files -- ':(top,glob)test/**/*.test.ts' instead:\n${offenders.join("\n")}`,
  );
});

test("W1-T9872: the guard goes red on a planted top-level-only walk and stays quiet on the safe shapes", () => {
  const dir = mkdtempSync(join(tmpdir(), "walk-guard-"));
  try {
    const plant = (name: string, body: string): string[] => {
      const path = join(dir, name);
      writeFileSync(path, body);
      return topLevelTestWalks(readFileSync(path, "utf8"));
    };
    const header = 'import { dirname } from "node:path";\nconst TEST_DIR = dirname(fileURLToPath(import.meta.url));\n';
    assert.deepEqual(plant("flat.test.ts", `${header}const f = readdirSync(TEST_DIR).filter((n) => n.endsWith(".test.ts"));\n`), ["readdirSync(TEST_DIR)"]);
    assert.deepEqual(plant("rooted.test.ts", 'const f = readdirSync(join(REPO_ROOT, "test"), { withFileTypes: true });\n'), ['readdirSync(join(REPO_ROOT, "test"))']);
    assert.deepEqual(plant("async.test.ts", `${header}const f = await readdir(TEST_DIR);\n`), ["readdir(TEST_DIR)"]);
    assert.deepEqual(plant("recursive.test.ts", `${header}const f = readdirSync(TEST_DIR, { recursive: true });\n`), []);
    assert.deepEqual(plant("tmp.test.ts", 'const d = mkdtempSync(join(tmpdir(), "x-"));\nconst f = readdirSync(d);\n'), []);
    assert.deepEqual(plant("fixture.test.ts", 'const f = readdirSync(join(ROOT, "plan", "tasks.d"));\n'), []);
    assert.deepEqual(plant("git.test.ts", "const f = execFileSync(\"git\", [\"ls-files\", \"--\", \"test/**/*.test.ts\"]);\n"), []);
    assert.deepEqual(plant("mention.test.ts", 'const f = \'readdirSync(join(REPO_ROOT, "test"))\';\n'), []);
    assert.deepEqual(plant("comment.test.ts", '// readdirSync(join(REPO_ROOT, "test"))\n'), []);
    assert.deepEqual(plant("template.test.ts", 'const f = `readdirSync(join(REPO_ROOT, "test"))`;\n'), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T9872: the walk guard inspects a non-empty population", () => {
  const files = population();
  assert.ok(files.length > 100, `the guard must see the real test corpus, saw ${files.length} file(s)`);
  assert.ok(files.includes("test/architecture-fitness.test.ts"), "the population includes a suite the guard exists to police");
  assert.ok(files.some((f) => f.split("/").length > 2), "the population reaches into subfolders of test/");
});

test("W1-T9872: every KNOWN_DEBT entry still walks only the top level", () => {
  const { debt } = scanTree();
  const stale = [...KNOWN_DEBT.keys()].filter((name) => !debt.has(name));
  assert.deepEqual(stale, [], `these walks were fixed — delete them from KNOWN_DEBT: ${stale.join(", ")}`);
});
