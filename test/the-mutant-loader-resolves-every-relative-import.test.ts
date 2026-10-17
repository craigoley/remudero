import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { rewriteRelativeSpecifiers, writeMutantModule } from "./helpers/mutant-module.js";

/**
 * W1-T5028. #8161 added `import ... from "../scripts/satisfied-task-census.mjs"` to src/run-task.ts;
 * a mutant copy of that file resolved the import against test/mutants-XXXXXX/ and failed to load on
 * CI. The loader rewrote only `from "./x.js"`. These tests pin the generic helper and refuse a
 * hand-rolled rewrite anywhere else.
 */

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIR, "..");

/**
 * W1-T9872: every tracked test file under test/ at ANY depth (relative to test/, minus test/fixtures/)
 * plus the absolute test/ directory, both resolved from the REPO ROOT that git reports for this file's
 * own folder. A readdirSync of the folder holding the suite would silently drop every file that moved
 * into a subfolder. Two independent pathspecs must agree on the count.
 */
function testCorpus(): { dir: string; files: string[] } {
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: TEST_DIR, encoding: "utf8", maxBuffer: 64 << 20 });
  const root = git("rev-parse", "--show-toplevel").trim();
  const list = (spec: string): string[] =>
    git("ls-files", "--full-name", "--", spec).split("\n").filter((f) => f.startsWith("test/") && !f.startsWith("test/fixtures/"));
  const walked = list(":(top,glob)test/**/*.test.ts");
  assert.ok(walked.length > 0, "the recursive test/ listing must find the test corpus");
  assert.equal(walked.length, list(":(top)test/*.test.ts").length, "both pathspecs must see the same population");
  return { dir: join(root, "test"), files: walked.map((f) => f.slice("test/".length)) };
}

/** True when `source` rewrites import specifiers with its own `.replace(/.../)` regex literal. */
function hasAdHocImportRewrite(source: string): boolean {
  return /\.replace\(\s*\/(?:[^/\n\\]|\\.)*from\s*\\?["']/.test(source);
}

test("W1-T5028: a parent-relative import of a copied module resolves against the original directory", () => {
  const out = rewriteRelativeSpecifiers(
    'import { a } from "../scripts/x.mjs";\nimport { b } from "./lib/y.js";\nimport c from \'../data.json\';\n',
    "/repo/src",
  );
  assert.equal(
    out,
    'import { a } from "/repo/scripts/x.mjs";\nimport { b } from "/repo/src/lib/y.js";\nimport c from \'/repo/data.json\';\n',
  );
});

test("W1-T5028: a dynamic import and an export-from specifier are rewritten too", () => {
  const out = rewriteRelativeSpecifiers(
    'const m = await import("./lib/review.js");\nexport * from "./lib/a.js";\nexport { z } from \'../z.js\';\nimport "./side.js";\nawait import(\n  "./lib/b.js"\n);\n',
    "/repo/src",
  );
  assert.equal(
    out,
    'const m = await import("/repo/src/lib/review.js");\nexport * from "/repo/src/lib/a.js";\nexport { z } from \'/repo/z.js\';\nimport "/repo/src/side.js";\nawait import(\n  "/repo/src/lib/b.js"\n);\n',
  );
});

test("W1-T5028: a package name and a node builtin are not rewritten", () => {
  const src =
    'import { parse } from "yaml";\nimport { readFileSync } from "node:fs";\nconst m = await import("node:path");\nconst n = await import("some-pkg/sub.js");\n';
  assert.equal(rewriteRelativeSpecifiers(src, "/repo/src"), src);
});

test("W1-T5028: a copy importing a scripts mjs module loads", async () => {
  const src = readFileSync(join(REPO_ROOT, "scripts", "satisfied-task-census.mjs"), "utf8");
  assert.ok(src.includes("export function censusSatisfiedTasks"));
  const copy = [
    'import { censusSatisfiedTasks } from "../scripts/satisfied-task-census.mjs";',
    "export const exposed = censusSatisfiedTasks;",
    "",
  ].join("\n");
  const path = writeMutantModule("census-consumer.ts", copy, join(REPO_ROOT, "src"));
  const mod = (await import(path)) as { exposed: unknown };
  assert.equal(typeof mod.exposed, "function");
});

test("W1-T5028: the census detector flags an ad hoc import rewrite", () => {
  const adHoc = [
    "const x = mutatedSrc.replace(",
    '  /from "\\.\\/([^\\"]+)\\.js"/g,',
    '  (_m, name: string) => `from "${join(process.cwd(), "src", name)}.js"`,',
    ').replace(/from "\\.\\.\\/([^\\"]+\\.mjs)"/g, (_m, name: string) => name);',
  ].join("\n");
  assert.equal(hasAdHocImportRewrite(adHoc), true);
  assert.equal(hasAdHocImportRewrite('const y = s.replace(/from "x"/g, "z");\n'), true);
  assert.equal(hasAdHocImportRewrite("const y = s.replace(\n  /from \\\"x\\\"/g, z);\n"), true);
  // negative controls: an unrelated replace, and `from "` outside a replace regex
  assert.equal(hasAdHocImportRewrite('const y = s.replace(/foo/g, "bar");\n'), false);
  assert.equal(hasAdHocImportRewrite('import { a } from "./a.js";\n'), false);
});

test("W1-T5028: no test rewrites import specifiers by hand", () => {
  const skip = new Set(["the-mutant-loader-resolves-every-relative-import.test.ts", "architecture-fitness.test.ts"]);
  const { dir, files: corpus } = testCorpus();
  const files = corpus.filter((f) => !skip.has(f.split("/").at(-1)!));
  assert.ok(files.length > 100, `the census must see the test corpus, saw ${files.length}`);
  const offenders = files.filter((f) => hasAdHocImportRewrite(readFileSync(join(dir, f), "utf8")));
  assert.deepEqual(
    offenders,
    [],
    "rewrite a copied module's imports with rewriteRelativeSpecifiers / writeMutantModule(name, src, originDir) " +
      "(test/helpers/mutant-module.ts), never an ad hoc .replace over `from \"`",
  );
});
