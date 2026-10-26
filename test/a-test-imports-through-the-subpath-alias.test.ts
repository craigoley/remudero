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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";
// @ts-ignore the executable .mjs module has no declaration file.
import { LOCATION_RELATIVE_ERE, aliasFor, hasLocationRelativeSpecifier, isTransientTestPath, main as codemodMain, rewriteSource } from "#scripts/test-location-codemod.mjs";

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

function aliasFixtureRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-alias-fixture-"));
}

function populateAliasPackage(dir: string): void {
  const { type, imports } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type, imports }));
  for (const name of ["src", "scripts", "test"]) symlinkSync(join(ROOT, name), join(dir, name), "dir");
}

test("W1-T9864: package.json declares the three subpath aliases", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { imports?: Record<string, string> };
  assert.deepEqual(pkg.imports, { "#src/*": "./src/*", "#scripts/*": "./scripts/*", "#test/*": "./test/*" });
});

test("W1-T9864: a nested test importing through the aliases runs and typechecks", () => {
  // Scratch has a real package scope; its aliases read the actual, unchanged source donors.
  const dir = aliasFixtureRoot();
  try {
    populateAliasPackage(dir);
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
    const { rootDir: _rootDir, ...compilerOptions } = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf8")).compilerOptions;
    writeFileSync(
      tsconfig,
      JSON.stringify({ compilerOptions: { ...compilerOptions, noEmit: true, typeRoots: [join(ROOT, "node_modules", "@types")] }, include: [probe], exclude: [] }),
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
  const atHead = new Set(gitGrepFiles(["--untracked"], ["--", "test"]).filter((f) => !isTransientTestPath(f))).size;
  // W1-T9865: the batch-1 folders' representative tests were rewritten, so they must stay location-free —
  // a state only the codemod's output has, which the merge base does not.
  const rewrittenAtBatch1 = [
    "a-better-drafter-retries-the-proposals-a-worse-one-failed",
    "a-capped-pr-exhausts-repair-before-it-reaches-a-human",
    "a-cash-worker-reaches-the-web-only-through-an-attributed-search",
    "a-cancelled-run-is-not-a-failing-check",
    "a-base-probe-that-contradicts-mains-green-ci-parks-no-pr",
    "a-blocked-task-with-no-disposition-is-reported",
  ].map((name) => `test/${name}.test.ts`);
  const stillRelative = rewrittenAtBatch1.filter((f) => hasLocationRelativeSpecifier(readFileSync(join(ROOT, f), "utf8")));
  assert.deepEqual(stillRelative, [], "the batch-1 representative tests import through the aliases");
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
  ].filter((f) => f.endsWith(".test.ts") && !isTransientTestPath(f));
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
  const root = aliasFixtureRoot();
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
  const root = aliasFixtureRoot();
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

test("alias fixture package uses supplied scratch and real source bindings", () => {
  const donors = ["src/lib/ledger-path.ts", "test/helpers/git-repo.ts", "scripts/test-location-codemod.mjs"];
  const before = donors.map((file) => readFileSync(join(ROOT, file)));
  const dir = aliasFixtureRoot();
  try {
    assert.ok(dir.startsWith(realpathSync(tmpdir()) + sep), "the actual supplied temporary root owns every fixture write");
    populateAliasPackage(dir);
    const actual = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")), { type: actual.type, imports: actual.imports });
    for (const name of ["src", "scripts", "test"]) assert.equal(realpathSync(join(dir, name)), realpathSync(join(ROOT, name)));
    for (const [index, file] of donors.entries()) assert.deepEqual(readFileSync(join(dir, file)), before[index]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(existsSync(dir), false);
  for (const [index, file] of donors.entries()) assert.deepEqual(readFileSync(join(ROOT, file)), before[index]);
});

test("alias codemod fixtures use supplied scratch without mutating donors", () => {
  const donor = join(ROOT, "scripts", "test-location-codemod.mjs");
  const before = readFileSync(donor);
  const dir = aliasFixtureRoot();
  try {
    assert.ok(dir.startsWith(realpathSync(tmpdir()) + sep), "codemod output belongs to the supplied temporary root");
    mkdirSync(join(dir, "test", "nested"), { recursive: true });
    const target = join(dir, "test", "nested", "portable.test.ts");
    writeFileSync(target, `${imp("../../src/lib/x.js")}\n`);
    assert.equal(codemodMain(["--write", "test/nested/portable.test.ts"], dir), 0);
    assert.equal(readFileSync(target, "utf8"), `${imp("#src/lib/x.js")}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(existsSync(dir), false);
  assert.deepEqual(readFileSync(donor), before);
});
