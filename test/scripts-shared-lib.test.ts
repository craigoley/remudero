// test/scripts-shared-lib.test.ts — W1-T2907.
//
// Audit recon-2026-09-05 R-59: `scripts/` held 56 files and 14,765 lines with no shared module —
// `repoRoot` re-derived in 12 scripts, argv hand-parsed (or its main-guard hand-copied) in dozens
// more, git spawned ~14 different ways, and lcov parsed by two independent parsers. THE FIX is
// `scripts/lib/{repo-root,argv,git,lcov}.mjs` — one derivation, one argv/`--help` entry point, one
// git spawn, one lcov reader — with the callers the audit counted migrated onto them.
//
// TWO THINGS THIS FILE PROVES, TOGETHER: (1) each module's OWN behaviour, exercised directly
// (repoRoot() from a nested cwd, parseArgv's three flag shapes, the lcov parser round-tripping a
// two-`SF:`-block fixture); (2) that the migration actually HAPPENED — a census over `scripts/*.mjs`
// asserting each module is imported by more than a token caller, so this test cannot pass against
// four well-written modules nobody actually uses.
//
// WHY A CHILD PROCESS FOR repoRoot() (design note 1): the module derives `REPO_ROOT` once, at
// import time, from its own `import.meta.url` — a second call after `process.chdir()` in the SAME
// process would prove nothing (the binding is already resolved, cwd was never consulted). Only a
// FRESH process launched with a nested `cwd` can show the derivation truly ignores it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIB_DIR = join(REPO_ROOT, "scripts", "lib");

function importLib(name: string): Promise<Record<string, unknown>> {
  return import(pathToFileURL(join(LIB_DIR, name)).href) as Promise<Record<string, unknown>>;
}

// ── scripts/lib/repo-root.mjs ───────────────────────────────────────────────────────────────────

test("repo-root.mjs: repoRoot()/REPO_ROOT resolve to this checkout's real package root", async () => {
  const { repoRoot, REPO_ROOT: fromModule } = (await importLib("repo-root.mjs")) as {
    repoRoot: () => string;
    REPO_ROOT: string;
  };
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { name?: string };
  assert.equal(fromModule, REPO_ROOT, "REPO_ROOT must be this checkout's root, not scripts/lib/ itself");
  assert.equal(repoRoot(), fromModule, "repoRoot() and the REPO_ROOT constant must agree");
  assert.ok(
    existsSyncPackageJson(fromModule, pkg.name),
    "REPO_ROOT/package.json must be readable and name the same package this test file lives in",
  );
});

function existsSyncPackageJson(root: string, expectedName: string | undefined): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: string };
    return pkg.name === expectedName;
  } catch {
    return false;
  }
}

test("repo-root.mjs: resolves the SAME root from a process launched with a NESTED cwd — it is not reading process.cwd()", () => {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `import(${JSON.stringify(pathToFileURL(join(LIB_DIR, "repo-root.mjs")).href)}).then(m => process.stdout.write(m.REPO_ROOT))`],
    { cwd: join(REPO_ROOT, "test", "helpers"), encoding: "utf8" },
  );
  assert.equal(result.status, 0, `child process failed:\n${result.stderr}`);
  assert.equal(result.stdout, REPO_ROOT, "repoRoot() must ignore the nested cwd it was launched with");
});

// ── scripts/lib/argv.mjs ────────────────────────────────────────────────────────────────────────

test("argv.mjs: parseArgv handles a bare boolean flag", async () => {
  const { parseArgv } = (await importLib("argv.mjs")) as {
    parseArgv: (argv: string[], options: Record<string, unknown>) => { values: Record<string, unknown> };
  };
  const { values } = parseArgv(["--check"], { check: { type: "boolean" } });
  assert.equal(values.check, true);
});

test("argv.mjs: parseArgv handles a valued string flag with a default", async () => {
  const { parseArgv } = (await importLib("argv.mjs")) as {
    parseArgv: (argv: string[], options: Record<string, unknown>) => { values: Record<string, unknown> };
  };
  const withDefault = parseArgv([], { lcov: { type: "string", default: "coverage/lcov.info" } });
  assert.equal(withDefault.values.lcov, "coverage/lcov.info");
  const overridden = parseArgv(["--lcov", "/tmp/x.info"], { lcov: { type: "string", default: "coverage/lcov.info" } });
  assert.equal(overridden.values.lcov, "/tmp/x.info");
});

test("argv.mjs: parseArgv handles a repeatable string flag (multiple: true)", async () => {
  const { parseArgv } = (await importLib("argv.mjs")) as {
    parseArgv: (argv: string[], options: Record<string, unknown>) => { values: Record<string, unknown> };
  };
  const { values } = parseArgv(["--dir", "a", "--dir", "b"], { dir: { type: "string", multiple: true } });
  assert.deepEqual(values.dir, ["a", "b"]);
});

test("argv.mjs: parseArgv reports --help uniformly and (with helpText) prints it and sets helpRequested", async () => {
  const { parseArgv } = (await importLib("argv.mjs")) as {
    parseArgv: (
      argv: string[],
      options: Record<string, unknown>,
      opts?: { helpText?: string },
    ) => { helpRequested: boolean };
  };
  assert.equal(parseArgv(["--help"], {}).helpRequested, true);
  assert.equal(parseArgv([], {}).helpRequested, false);
  assert.equal(parseArgv(["-h"], {}).helpRequested, true, "the short form is the same question");

  // The printing half the title promises. Without this the `console.log(helpText)` line never
  // runs, which is what diff-coverage flagged: the two calls above pass no `helpText` at all, so
  // the guard short-circuits and a caller relying on parseArgv to print `--help` is unproven.
  const printed: unknown[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => void printed.push(args.join(" "));
  try {
    assert.equal(parseArgv(["--help"], {}, { helpText: "usage: rmd thing [--flag]" }).helpRequested, true);
    assert.deepEqual(printed, ["usage: rmd thing [--flag]"], "helpText is printed verbatim, once");

    printed.length = 0;
    assert.equal(parseArgv([], {}, { helpText: "usage: rmd thing [--flag]" }).helpRequested, false);
    assert.deepEqual(printed, [], "no --help means nothing is printed");

    // Omitting helpText is the documented opt-out: still reported, never printed.
    assert.equal(parseArgv(["--help"], {}).helpRequested, true);
    assert.deepEqual(printed, [], "opting out of helpText must not print an empty line either");
  } finally {
    console.log = realLog;
  }
});

test("argv.mjs: isMainModule is true for this file's own URL against its own argv[1], false against an unrelated argv[1]", async () => {
  const { isMainModule } = (await importLib("argv.mjs")) as {
    isMainModule: (moduleUrl: string, argv1?: string) => boolean;
  };
  const selfUrl = pathToFileURL(join(LIB_DIR, "argv.mjs")).href;
  assert.equal(isMainModule(selfUrl, join(LIB_DIR, "argv.mjs")), true);
  assert.equal(isMainModule(selfUrl, join(LIB_DIR, "git.mjs")), false);
  assert.equal(isMainModule(selfUrl, undefined), false);
});

// ── scripts/lib/git.mjs ─────────────────────────────────────────────────────────────────────────

test("git.mjs: git() spawns real git against `cwd` and carries the fixed script identity in env", async () => {
  const { git, GIT_SCRIPT_IDENTITY } = (await importLib("git.mjs")) as {
    git: (args: string[], opts?: { cwd?: string }) => { status: number | null; stdout: string };
    GIT_SCRIPT_IDENTITY: { name: string; email: string };
  };
  const result = git(["rev-parse", "--is-inside-work-tree"], { cwd: REPO_ROOT });
  assert.equal(result.status, 0, "git() must reach the real git binary against the given cwd");
  assert.equal(result.stdout.trim(), "true");
  assert.ok(GIT_SCRIPT_IDENTITY.name.length > 0 && GIT_SCRIPT_IDENTITY.email.includes("@"));
});

test("git.mjs: gitOrThrow returns TRIMMED stdout on success and throws, naming the command, on failure", async () => {
  const { gitOrThrow } = (await importLib("git.mjs")) as {
    gitOrThrow: (args: string[], opts?: { cwd?: string }) => string;
  };
  const branch = gitOrThrow(["rev-parse", "--is-inside-work-tree"], { cwd: REPO_ROOT });
  assert.equal(branch, "true", "gitOrThrow must trim trailing whitespace/newline");
  assert.throws(
    () => gitOrThrow(["not-a-real-git-subcommand"], { cwd: REPO_ROOT }),
    /git not-a-real-git-subcommand failed/,
  );
});

// ── scripts/lib/lcov.mjs ────────────────────────────────────────────────────────────────────────

const TWO_BLOCK_LCOV = [
  "SF:src/lib/a.ts",
  "FN:1,fnA",
  "FNDA:1,fnA",
  "DA:1,1",
  "DA:2,0",
  "LF:2",
  "LH:1",
  "BRF:0",
  "BRH:0",
  "end_of_record",
  "SF:src/lib/b.ts",
  "FN:1,fnB",
  "FNDA:0,fnB",
  "DA:1,3",
  "LF:1",
  "LH:1",
  "BRF:2",
  "BRH:1",
  "end_of_record",
  "",
].join("\n");

test("lcov.mjs: parseLcovRecords round-trips a fixture with two SF: blocks", async () => {
  const { parseLcovRecords } = (await importLib("lcov.mjs")) as {
    parseLcovRecords: (text: string) => Array<{
      sourceFile: string;
      da: Array<{ line: number; hits: number }>;
      fn: Array<{ line: number; names: string[] }>;
      fnda: Array<{ name: string; hits: number }>;
      lf: number;
      lh: number;
      brf: number;
      brh: number;
    }>;
  };
  const records = parseLcovRecords(TWO_BLOCK_LCOV);
  assert.equal(records.length, 2, "one record per SF:/end_of_record block");

  const [a, b] = records;
  assert.equal(a.sourceFile, "src/lib/a.ts");
  assert.deepEqual(a.da, [
    { line: 1, hits: 1 },
    { line: 2, hits: 0 },
  ]);
  assert.deepEqual(a.fn, [{ line: 1, names: ["fnA"] }]);
  assert.deepEqual(a.fnda, [{ name: "fnA", hits: 1 }]);
  assert.deepEqual({ lf: a.lf, lh: a.lh, brf: a.brf, brh: a.brh }, { lf: 2, lh: 1, brf: 0, brh: 0 });

  assert.equal(b.sourceFile, "src/lib/b.ts");
  assert.deepEqual(b.da, [{ line: 1, hits: 3 }]);
  assert.deepEqual({ lf: b.lf, lh: b.lh, brf: b.brf, brh: b.brh }, { lf: 1, lh: 1, brf: 2, brh: 1 });
});

test("lcov.mjs: a block missing its own end_of_record still yields a record (a truncated/concatenated report)", async () => {
  const { parseLcovRecords } = (await importLib("lcov.mjs")) as {
    parseLcovRecords: (text: string) => Array<{ sourceFile: string; da: Array<{ line: number; hits: number }> }>;
  };
  const records = parseLcovRecords("SF:src/lib/c.ts\nDA:1,5\n");
  assert.equal(records.length, 1);
  assert.equal(records[0].sourceFile, "src/lib/c.ts");
  assert.deepEqual(records[0].da, [{ line: 1, hits: 5 }]);
});

// ── the migration itself: one shared library, actually imported ────────────────────────────────
//
// Each module existing, unused, would satisfy every test above. This walks every top-level
// `scripts/*.mjs` file (never `scripts/lib/**` itself) and counts real `from "./lib/<module>"`
// imports, floored well under today's measured count so ordinary future drift cannot flake it,
// but far enough above zero (or "one token caller") that a regression back to no real migration
// fails loudly.

function scriptsImportCounts(): Record<"repo-root" | "argv" | "git" | "lcov", number> {
  const scriptsDir = join(REPO_ROOT, "scripts");
  const files = readdirSync(scriptsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".mjs"))
    .map((e) => join(scriptsDir, e.name));
  const counts = { "repo-root": 0, argv: 0, git: 0, lcov: 0 };
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const key of Object.keys(counts) as (keyof typeof counts)[]) {
      if (new RegExp(`from\\s+["']\\./lib/${key}\\.mjs["']`).test(source)) counts[key] += 1;
    }
  }
  return counts;
}

test("the shared library is actually imported by the migrated scripts, not merely present", () => {
  const counts = scriptsImportCounts();
  // Measured at authoring time: repo-root 10, argv 37, git 13, lcov 2 callers. Floors below that,
  // never at it, so an unrelated future edit shrinking one caller (a script deleted, a further
  // consolidation) does not flake this census the way an exact-count pin would.
  assert.ok(counts["repo-root"] >= 6, `expected >=6 scripts/*.mjs callers of lib/repo-root.mjs, got ${counts["repo-root"]}`);
  assert.ok(counts.argv >= 20, `expected >=20 scripts/*.mjs callers of lib/argv.mjs, got ${counts.argv}`);
  assert.ok(counts.git >= 8, `expected >=8 scripts/*.mjs callers of lib/git.mjs, got ${counts.git}`);
  assert.ok(counts.lcov >= 2, `expected >=2 scripts/*.mjs callers of lib/lcov.mjs, got ${counts.lcov}`);
});

test("control: a scripts/*.mjs file NOT importing a given lib module is not silently counted (sanity on the regex above)", () => {
  // scripts/lib/inherited-violation.mjs is a real, pre-existing sibling module under scripts/lib/
  // that no script reaches via `./lib/repo-root.mjs` etc. — proves the regex is anchored to the
  // exact specifier, not a loose substring match that would count anything.
  const source = readFileSync(join(REPO_ROOT, "scripts", "diff-class.mjs"), "utf8");
  assert.doesNotMatch(source, /from\s+["']\.\/lib\/lcov\.mjs["']/, "diff-class.mjs never imports lib/lcov.mjs");
});
