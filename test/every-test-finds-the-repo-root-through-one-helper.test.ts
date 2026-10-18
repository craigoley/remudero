// @source-text-subject: the guarded property is a test's own-location path computation.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT, repoRoot } from "#test/helpers/repo-root.js";
import { assertInspected } from "#test/helpers/inspected-population.js";
// @ts-expect-error the codemod is an executable JavaScript module
import { analyzeSource, rewriteSource, testFiles } from "#scripts/test-repo-root-codemod.mjs";
// @ts-expect-error the census precheck is an executable JavaScript module
import { evaluateCensusPrecheck, PRECHECK_PARITY } from "#scripts/census-precheck.mjs";

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
}

function sourcesAtBase(): Map<string, string> {
  const base = git("merge-base", "HEAD", "origin/main").trim();
  const paths = git("ls-tree", "-r", "--name-only", base, "--", "test").split("\n")
    .filter((p) => /^test\/.*\.test\.ts$/.test(p) && !/^test\/(helpers|setup|lib|fixtures)\//.test(p));
  assert.ok(paths.length > 0, "the merge base contains test files");
  const objects = execFileSync("git", ["cat-file", "--batch"], {
    cwd: REPO_ROOT, input: paths.map((p) => `${base}:${p}\n`).join(""), maxBuffer: 128 << 20,
  });
  const sources = new Map<string, string>();
  let offset = 0;
  for (const path of paths) {
    const end = objects.indexOf(10, offset);
    const header = objects.subarray(offset, end).toString();
    assert.match(header, /^[a-f0-9]+ blob [0-9]+$/);
    const size = Number(header.split(" ")[2]);
    sources.set(path, objects.subarray(end + 1, end + 1 + size).toString());
    offset = end + size + 2;
  }
  return sources;
}

function currentSources(): Map<string, string> {
  const files: string[] = testFiles(REPO_ROOT);
  const tracked = git("ls-files", "--", "test").split("\n").filter((p) =>
    /^test\/.*\.test\.ts$/.test(p) && !/^test\/(helpers|setup|lib|fixtures)\//.test(p));
  const untracked = new Set(git("ls-files", "--others", "--", "test").split("\n"));
  assertInspected("root guard tracked tests", files.filter((p) => !untracked.has(p)).length, tracked.length);
  return new Map(files.map((file) => [file, readFileSync(join(REPO_ROOT, file), "utf8")]));
}

test("W1-T9863: census-precheck refuses new own-folder roots and net count growth", () => {
  const suite = "test/every-test-finds-the-repo-root-through-one-helper.test.ts";
  assert.equal(typeof PRECHECK_PARITY[suite]?.modeled, "function");
  const ownRoot = 'import { join } from "node:path"; const root = join(import.meta.dirname, "..");';
  const helper = 'import { REPO_ROOT } from "#test/helpers/repo-root.js";';
  const evaluate = (head: Record<string, string>, base: Record<string, string>) => {
    const changed = [...new Set([...Object.keys(head), ...Object.keys(base)])];
    return evaluateCensusPrecheck({
      changed, readHead: (p: string) => head[p] ?? null, readBase: (p: string) => base[p] ?? null,
      measuredFiles: [], testFiles: [], srcFiles: [],
    });
  };
  const path = "test/member.test.ts";
  assert.deepEqual(evaluate({ [path]: helper }, {}), []);
  assert.deepEqual(evaluate({ [path]: ownRoot }, { [path]: ownRoot }), []);
  assert.deepEqual(evaluate({ [path]: helper }, { [path]: ownRoot }), []);
  assert.deepEqual(evaluate({}, { [path]: ownRoot }), []);
  assert.match(evaluate({ [path]: ownRoot }, { [path]: helper }).join("\n"), /head=1, merge base=0/);
  const added = evaluate({ [path]: ownRoot }, {});
  assert.equal(added.length, 2);
  assert.match(added[0], /new test test\/member.test.ts derives its own root/);
  assert.match(added[1], /head=1, merge base=0/);
  // An addition still fails when deleting an old offender keeps the total count flat.
  assert.equal(evaluate({ [path]: ownRoot }, { "test/removed.test.ts": ownRoot }).length, 1);
  assert.deepEqual(evaluate({ [path]: `${helper}\n// ${ownRoot}` }, {}), []);
  for (const dir of ["helpers", "setup", "lib", "fixtures"]) {
    assert.deepEqual(evaluate({ [`test/${dir}/member.test.ts`]: ownRoot }, {}), []);
  }
  const nested = "test/nested/member.test.ts";
  const nestedRoot = ownRoot.replace('".."', '"..", ".."');
  assert.match(evaluate({ [nested]: nestedRoot }, {}).join("\n"), /new test test\/nested\/member.test.ts/);
  // Counts are files, so adding another expression to an existing offender is not growth.
  assert.deepEqual(evaluate({ [path]: `${ownRoot}\nconst other = join(import.meta.dirname, "..");` }, { [path]: ownRoot }), []);
  assert.throws(() => evaluate({ [path]: "const = import.meta.url;" }, {}));
});

test("W1-T9863: a census pointed at the wrong root fails its inspected count", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-inspected-population-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "test"));
    writeFileSync(join(root, "src", "member.ts"), "export const member = true;\n");
    const walk = (directory: string) => readdirSync(directory, { recursive: true })
      .filter((name) => String(name).endsWith(".ts")).length;
    assertInspected("fixture census", walk(root), 1);
    assert.throws(() => assertInspected("fixture census", walk(join(root, "test")), 1),
      /fixture census: inspected=0, independent=1/);
    assert.throws(() => assertInspected("partial census", 1, 2), /inspected=1, independent=2/);
    assert.throws(() => assertInspected("empty census", 0, 0), /inspected=0, independent=0/);
    for (const value of [-1, NaN, Infinity, 0.5]) {
      assert.throws(() => assertInspected("invalid census", value, value));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T9863: no new test derives the repo root from its own folder", () => {
  const base = sourcesAtBase();
  const offenders = [...currentSources()].filter(([file, text]) =>
    !base.has(file) && analyzeSource(text, file).computations.length > 0).map(([file]) => file);
  assert.deepEqual(offenders, [], `new tests must import helpers/repo-root.js: ${offenders.join(", ")}`);
});

test("W1-T9863: the own-folder root count never rises above the merge base", () => {
  const count = (sources: Map<string, string>) => [...sources].filter(([file, text]) =>
    analyzeSource(text, file).computations.length > 0).length;
  const baseline = count(sourcesAtBase());
  const current = count(currentSources());
  assert.ok(current <= baseline, `own-folder root files: head=${current}, merge base=${baseline}`);
});

test("the root helper identifies this package independently of the caller", () => {
  assert.equal(repoRoot(), REPO_ROOT);
  assert.equal(JSON.parse(readFileSync(join(repoRoot(), "package.json"), "utf8")).name, "remudero");
});

test("the codemod rewrites supported root shapes without changing quoted examples or fixture paths", () => {
  const header = 'import { join, dirname } from "node:path";\nimport { fileURLToPath } from "node:url";\n';
  const shapes = [
    'join(dirname(fileURLToPath(import.meta.url)), "..")',
    'join(__dirname, "..")',
    'join(import.meta.dirname, "..")',
    'fileURLToPath(new URL("..", import.meta.url))',
  ];
  for (const expression of shapes) {
    const text = `${header}const __dirname = dirname(fileURLToPath(import.meta.url));\nconst root = ${expression};\n`;
    const result = rewriteSource(text, "test/example.test.ts");
    assert.equal(result.computations.length, 1, expression);
    assert.equal(result.unsupported.length, 0, expression);
    assert.match(result.source, /import \{ REPO_ROOT as __testRepoRoot \}/);
    assert.equal(analyzeSource(result.source, "test/example.test.ts").computations.length, 0);
    assert.equal(rewriteSource(result.source, "test/example.test.ts").source, result.source);
  }
  const untouched = `${header}// join(import.meta.dirname, "..")\nconst example = 'join(import.meta.dirname, "..")';\nconst fixture = join(import.meta.dirname, "fixtures");\n`;
  assert.equal(rewriteSource(untouched, "test/example.test.ts").source, untouched);
  const nested = rewriteSource(`${header}const root = join(import.meta.dirname, "..", "..");`, "test/nested/example.test.ts");
  assert.match(nested.source, /from "#test\/helpers\/repo-root.js"/);
  const wrapped = `${header}const source = readFileSync(join(import.meta.dirname, "..", "src", "member.ts"), "utf8");`;
  const wrappedResult = rewriteSource(wrapped, "test/example.test.ts");
  assert.equal(wrappedResult.computations.length, 1);
  assert.equal(wrappedResult.unsupported.length, 0);
  assert.match(wrappedResult.source, /readFileSync\(join\(__testRepoRoot, "src", "member.ts"\), "utf8"\)/);
  assert.equal(analyzeSource(wrappedResult.source, "test/example.test.ts").computations.length, 0);
  const unknown = `${header}const root = mystery(import.meta.url, "..");`;
  assert.equal(rewriteSource(unknown, "test/example.test.ts").source, unknown);
  assert.equal(analyzeSource(unknown, "test/example.test.ts").unsupported.length, 1);
});
