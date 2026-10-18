/**
 * W1-T9864: tests import src/, scripts/ and test/ helpers through the package.json subpath aliases
 * `#src/*`, `#scripts/*` and `#test/*`, so a test's CONTENT stops depending on its folder depth and a later
 * move is a pure rename (git pairs only exact renames once a move passes ~1,100 files).
 *
 * This file is itself location-free: it carries no relative specifier, and its fixtures build theirs from
 * variables so the file's own text never matches the pattern it counts.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
// @ts-ignore the executable .mjs module has no declaration file.
import { LOCATION_RELATIVE_ERE, aliasFor, codeMask, hasLocationRelativeSpecifier, main as codemodMain, rewriteRootReads, rewriteSource } from "#scripts/test-location-codemod.mjs";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** `git grep -l` exits 1 on no match — that is a count of 0, not a failure. */
function gitGrepFiles(flags: string[], rest: string[]): string[] {
  try {
    return git(["grep", "-l", "-E", ...flags, "-e", LOCATION_RELATIVE_ERE, ...rest]).split("\n").filter(Boolean);
  } catch (err) {
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
}

/** One import line whose specifier is a variable, so this file's text never carries a relative specifier. */
const imp = (spec: string, name = "x"): string => `import { ${name} } from ${JSON.stringify(spec)};`;
const dyn = (spec: string): string => `const m = await import(${JSON.stringify(spec)});`;

test("W1-T9864: package.json declares the three subpath aliases", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { imports?: Record<string, string> };
  assert.deepEqual(pkg.imports, { "#src/*": "./src/*", "#scripts/*": "./scripts/*", "#test/*": "./test/*" });
});

test("W1-T9864: a nested test importing through the aliases runs and typechecks", () => {
  // state/ is gitignored and inside the package scope, so the nearest package.json (and its `imports`) applies.
  mkdirSync(join(ROOT, "state"), { recursive: true });
  const dir = mkdtempSync(join(ROOT, "state", "alias-probe-"));
  try {
    const nested = join(dir, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    const probe = join(nested, "probe.ts");
    writeFileSync(
      probe,
      [
        imp("#src/lib/ledger-path.js", "LEDGER_FILENAME"),
        `import type { Config } from "#src/lib/config.js";`,
        `export const typed: Config | null = null;`,
        imp("#test/helpers/git-repo.js", "GIT_REPO_FIXTURE_IDENTITY"),
        `// @ts-ignore the executable .mjs module has no declaration file.`,
        imp("#scripts/test-location-codemod.mjs", "aliasFor"),
        dyn("#src/lib/ledger-path.js"),
        `if (LEDGER_FILENAME !== "ledger.ndjson" || typeof aliasFor !== "function" || !GIT_REPO_FIXTURE_IDENTITY || m.LEDGER_FILENAME !== LEDGER_FILENAME) throw new Error("alias did not resolve");`,
        `process.stdout.write("alias-ok");`,
        "",
      ].join("\n"),
    );
    const ran = execFileSync(process.execPath, ["--import", "tsx", probe], { cwd: ROOT, encoding: "utf8" });
    assert.equal(ran, "alias-ok", "the aliases resolve to the .ts sources under tsx, from a nested folder");

    const tsconfig = join(dir, "tsconfig.json");
    writeFileSync(
      tsconfig,
      JSON.stringify({ extends: join(ROOT, "tsconfig.json"), compilerOptions: { noEmit: true, rootDir: ROOT }, include: [probe], exclude: [] }),
    );
    const tsc = join(ROOT, "node_modules", ".bin", "tsc");
    execFileSync(tsc, ["-p", tsconfig], { cwd: ROOT, encoding: "utf8" });

    // Control: an alias that names no module must fail the typecheck, or the pass above proves nothing.
    writeFileSync(probe, `${imp("#src/lib/this-module-does-not-exist.js")}\nexport {};\n`);
    assert.throws(
      () => execFileSync(tsc, ["-p", tsconfig], { cwd: ROOT, encoding: "utf8", stdio: "pipe" }),
      (error: { stdout?: string }) => /TS2307/.test(error.stdout ?? ""),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T9864: location-relative test files never rise above the merge base", (t) => {
  let base: string;
  try {
    base = git(["merge-base", "HEAD", "origin/main"]).trim();
  } catch {
    t.skip("no origin/main ref in this checkout, so there is no merge base to hold the count against");
    return;
  }
  const atBase = gitGrepFiles([], [base, "--", "test"]).length;
  const atHead = new Set([...gitGrepFiles(["--untracked"], ["--", "test"])]).size;
  assert.ok(
    atHead <= atBase,
    `${atHead} test files carry a location-relative specifier at HEAD, ${atBase} at merge base ${base.slice(0, 9)} — ` +
      `import through #src/*, #scripts/* and #test/* (scripts/test-location-codemod.mjs rewrites a file)`,
  );
});

test("W1-T9864: a new test file carries no location-relative specifier", (t) => {
  let base: string;
  try {
    base = git(["merge-base", "HEAD", "origin/main"]).trim();
  } catch {
    t.skip("no origin/main ref in this checkout, so there is no merge base to find new files against");
    return;
  }
  const added = [
    ...git(["diff", "--name-only", "--diff-filter=A", base, "--", "test"]).split("\n"),
    ...git(["status", "--porcelain", "--untracked-files=all", "--", "test"])
      .split("\n")
      .filter((line) => line.startsWith("?? "))
      .map((line) => line.slice(3)),
  ].filter((f) => f.endsWith(".test.ts"));
  const offenders = added.filter((f) => hasLocationRelativeSpecifier(readFileSync(join(ROOT, f), "utf8")));
  assert.deepEqual(offenders, [], "a new test imports through #src/*, #scripts/* and #test/*, never a relative path");
});

test("W1-T9864: the codemod rewrites relative specifiers to the aliases", () => {
  const file = "test/nested/deep/thing.test.ts";
  const input = [
    `// ${file}`,
    imp("../../../src/lib/ledger-path.js"),
    imp("../../../scripts/test-location-codemod.mjs"),
    imp("../../helpers/git-repo.js"),
    imp("./sibling.js"),
    imp("../../../package.json"),
    dyn("../../../src/lib/config.js"),
    "",
  ].join("\n");
  const out = rewriteSource(input, file);
  assert.equal(
    out.text,
    [
      imp("#src/lib/ledger-path.js"),
      imp("#scripts/test-location-codemod.mjs"),
      imp("#test/helpers/git-repo.js"),
      imp("#test/nested/deep/sibling.js"),
      imp("../../../package.json"),
      dyn("#src/lib/config.js"),
      "",
    ].join("\n"),
  );
  assert.equal(out.rewritten, 5);
  assert.equal(out.selfPathRemoved, true, "the first-line self-path comment is removed");
  assert.equal(out.unresolved.length, 1, "the package.json read is listed, never guessed");
  assert.match(out.unresolved[0], /package\.json/);
  assert.equal(hasLocationRelativeSpecifier(out.text), true, "the unrewritten package.json specifier is still relative");
  assert.equal(hasLocationRelativeSpecifier(rewriteSource(imp("../src/a.js"), "test/a.test.ts").text), false);

  // A self-path comment naming ANOTHER file is not this file's own line and stays.
  assert.equal(rewriteSource(`// test/other.test.ts\n`, file).selfPathRemoved, false);
  // Runtime reads are reported, not rewritten.
  const runtime = rewriteSource(`const p = join(import.meta.dirname, "fixtures/a.json");\n`, file);
  assert.equal(runtime.rewritten, 0);
  assert.ok(runtime.unresolved.length >= 1);
  assert.equal(aliasFor("package.json"), null);
});

test("W1-T9864: the codemod writes a file in place, and --folder degrades when the placement table is absent", () => {
  const root = mkdtempSync(join(ROOT, "state", "codemod-root-"));
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  let stderr = "";
  try {
    mkdirSync(join(root, "test", "nested"), { recursive: true });
    const target = join(root, "test", "nested", "a.test.ts");
    writeFileSync(target, `${imp("../../src/lib/x.js")}\n`);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => ((stderr += chunk), true)) as typeof process.stderr.write;
    assert.equal(codemodMain(["test/nested/a.test.ts"], root), 0);
    assert.equal(readFileSync(target, "utf8"), `${imp("../../src/lib/x.js")}\n`, "a dry run changes nothing");
    assert.equal(codemodMain(["--write", "--folder", "nowhere", "test/nested/a.test.ts"], root), 0);
    assert.equal(readFileSync(target, "utf8"), `${imp("#src/lib/x.js")}\n`);
    assert.match(stderr, /test-folders\.tsv does not exist yet/);
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T9864: --folder selects the tests the placement table maps to that folder", () => {
  const root = mkdtempSync(join(ROOT, "state", "codemod-root-"));
  const out = process.stdout.write.bind(process.stdout);
  let stdout = "";
  try {
    mkdirSync(join(root, "test", "nested"), { recursive: true });
    mkdirSync(join(root, "scripts", "test-placement"), { recursive: true });
    const mapped = join(root, "test", "nested", "a.test.ts");
    const other = join(root, "test", "nested", "b.test.ts");
    writeFileSync(mapped, `${imp("../../src/lib/x.js")}\n`);
    writeFileSync(other, `${imp("../../src/lib/y.js")}\n`);
    writeFileSync(join(root, "scripts", "test-placement", "test-folders.tsv"),
      "test/nested/a.test.ts\tunit\ntest/nested/b.test.ts\tintegration\n\n");
    process.stdout.write = ((chunk: string) => ((stdout += chunk), true)) as typeof process.stdout.write;
    assert.equal(codemodMain(["--write", "--folder", "unit"], root), 0);
    assert.equal(readFileSync(mapped, "utf8"), `${imp("#src/lib/x.js")}\n`, "the mapped test is rewritten");
    assert.equal(readFileSync(other, "utf8"), `${imp("../../src/lib/y.js")}\n`, "a test mapped to another folder is untouched");
    assert.match(stdout, /1 of 1 file\(s\) rewritten/);
  } finally {
    process.stdout.write = out;
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T9865: a specifier inside a fixture string or comment is never rewritten", () => {
  const file = "test/nested/thing.test.ts";
  const fixture = `const planted = ${JSON.stringify(imp("./b.js"))};`;
  const input = [
    fixture,
    "const multi = `",
    imp("./c.js"),
    "${1 + 1}",
    "`;",
    `// ${imp("./d.js")}`,
    "const pattern = /[\"']/g;",
    imp("../../src/lib/real.js"),
    "",
  ].join("\n");
  const out = rewriteSource(input, file);
  assert.equal(out.rewritten, 1, "only the real import is rewritten");
  assert.ok(out.text.includes(fixture), "a string fixture keeps its relative specifier");
  assert.ok(out.text.includes(imp("./c.js")), "a template literal keeps its relative specifier");
  assert.ok(out.text.includes(`// ${imp("./d.js")}`), "a comment keeps its relative specifier");
  assert.ok(out.text.includes(imp("#src/lib/real.js")));
  const mask = codeMask(`a "b" c`);
  assert.deepEqual([...mask], [1, 1, 0, 0, 0, 1, 1]);
});

test("W1-T9865: an own-location root read becomes a repoRoot() read, and a read that stays in the test's folder is only reported", () => {
  const file = "test/thing.test.ts";
  const root = rewriteRootReads(
    [
      `import { join, dirname } from "node:path";`,
      `import { fileURLToPath } from "node:url";`,
      `const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");`,
      `const SRC = join(import.meta.dirname, "..", "src", "run-task.ts");`,
      `const FX = join(import.meta.dirname, "fixtures", "a.yaml");`,
      `const SIBLING = join(import.meta.dirname, "other.test.ts");`,
      `const GEN = ${JSON.stringify("const p = join(import.meta.dirname, '..');")};`,
      "",
    ].join("\n"),
    file,
  );
  assert.equal(root.count, 3);
  assert.ok(root.text.startsWith(`import { repoRoot } from "#test/helpers/repo-root.js";\n`));
  assert.ok(root.text.includes("const ROOT = repoRoot();"));
  assert.ok(root.text.includes(`const SRC = join(repoRoot(), "src/run-task.ts");`));
  assert.ok(root.text.includes(`const FX = join(repoRoot(), "test/fixtures/a.yaml");`));
  assert.ok(root.text.includes(`join(import.meta.dirname, "other.test.ts")`), "a read of another test is left for the report");
  assert.ok(root.text.includes("join(import.meta.dirname, '..')"), "generated text inside a string is left alone");
  assert.equal(rewriteSource(root.text, file).unresolved.some((u) => /other\.test\.ts/.test(u)), true);

  // A file that already names `repoRoot` locally gets the helper under another name, so no call reads a shadow.
  const shadow = rewriteRootReads(`import { join } from "node:path";\nconst repoRoot = join(import.meta.dirname, "..");\n`, file);
  assert.ok(shadow.text.includes(`import { repoRoot as testRepoRoot } from "#test/helpers/repo-root.js";`));
  assert.ok(shadow.text.includes("const repoRoot = testRepoRoot();"));

  // new URL(...) forms: a file URL is rebuilt from the path.
  const url = rewriteRootReads(`import { fileURLToPath } from "node:url";\nconst u = new URL("../src/lib/x.ts", import.meta.url);\n`, file);
  assert.ok(url.text.includes(`import { fileURLToPath, pathToFileURL } from "node:url";`));
  assert.ok(url.text.includes("const u = pathToFileURL(`${repoRoot()}/src/lib/x.ts`);"));

  // No node:url import yet: one is added. A readFileSync(new URL(...)) becomes a plain path read.
  const bare = rewriteRootReads(`const u = new URL("../src/lib/x.ts", import.meta.url);\nconst t = readFileSync(new URL("../plan/tasks.yaml", import.meta.url), "utf8");\n`, file);
  assert.ok(bare.text.includes(`import { pathToFileURL } from "node:url";`));
  assert.ok(bare.text.includes("readFileSync(`${repoRoot()}/plan/tasks.yaml`, \"utf8\")"));

  // A `const __dirname` declaration goes once nothing else reads it; a `__dirname` read elsewhere keeps it.
  const dunder = `import { join, dirname } from "node:path";\nconst __dirname = dirname(fileURLToPath(import.meta.url));\nconst a = join(__dirname, "..", "src");\n`;
  const dropped = rewriteRootReads(dunder, file);
  assert.equal(dropped.text.includes("const __dirname"), false);
  assert.ok(dropped.text.includes(`const a = join(repoRoot(), "src");`));
  const kept = rewriteRootReads(`${dunder}const b = __dirname;\n`, file);
  assert.ok(kept.text.includes("const __dirname"), "a __dirname still read elsewhere keeps its declaration");
  assert.equal(rewriteRootReads(`const x = 1;\n`, file).count, 0);
});
