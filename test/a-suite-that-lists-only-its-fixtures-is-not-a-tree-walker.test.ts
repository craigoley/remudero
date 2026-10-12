import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * W1-T6092 — a census suite is one that walks the REPOSITORY tree, not one that lists some directory.
 * `enumeratesPopulation` matched any directory-read, glob or tracked-file listing call, so a suite
 * listing only its own mkdtemp fixture (run-task 120 s, live-write-guard-command-sites 230 s,
 * recycle-container 94 s) joined the census set of every src change. A call now counts only when its
 * root is the repository, or a root this scan cannot resolve (a helper's parameter) — the W1-T4787
 * walkers-through-a-helper case.
 *
 * The idioms below are ASSEMBLED, never spelled: the census recognizers grep test text for them, and
 * this file's subject is fixture strings, not a walk of the tree.
 */
const RD = ["readdir", "Sync"].join("");
const LS = ["ls", "files"].join("-");
const GL = ["glob", "Sync"].join("");
/** A directory-read call over `arg`. */
const rd = (arg: string): string => `${RD}(${arg})`;
/** A tracked-file listing, optionally with a `cwd` option. */
const lsFiles = (cwd?: string): string =>
  `execFileSync("git", ["${LS}", "a.ts"]${cwd ? `, { cwd: ${cwd} }` : ""})`;
const MKROOT = 'const root = mkdtempSync(join(tmpdir(), "r-"));\n';

const { censusSuiteFiles, enumeratesPopulation } = (await import(
  pathToFileURL(join(REPO_ROOT, "scripts", "diff-class.mjs")).href
)) as {
  censusSuiteFiles: (changed: readonly string[] | undefined, root?: string) => string[];
  enumeratesPopulation: (content: string) => boolean;
};

test("a suite that lists only a tmpdir fixture is not a census suite", () => {
  assert.equal(
    enumeratesPopulation(`${MKROOT}${rd('join(root, "src")')};`),
    false,
    "a mkdtemp root is a fixture even when it spells a repo area",
  );
  assert.equal(enumeratesPopulation(`const ownTmp = make();\n${rd("ownTmp")};`), false, "a tmp-named variable");
  assert.equal(
    enumeratesPopulation(
      `const inflight = join(state, "inflight");\nconst state = mkdtempSync(join(tmpdir(), "s-"));\n${rd("inflight")};`,
    ),
    false,
    "a root resolved through two declarations to a mkdtemp",
  );
  assert.equal(enumeratesPopulation(`${MKROOT}${lsFiles("root")};`), false, "a listing in a fixture repository");
  assert.equal(enumeratesPopulation(`import { ${RD} } from "node:fs";`), false, "an import is not a call");
});

test("a suite that lists REPO_ROOT/src directly or through a helper is a census suite", () => {
  assert.equal(enumeratesPopulation(rd('join(REPO_ROOT, "src")')), true);
  assert.equal(enumeratesPopulation(rd('fileURLToPath(new URL("..", import.meta.url))')), true);
  assert.equal(enumeratesPopulation(rd("process.cwd()")), true);
  assert.equal(enumeratesPopulation(rd('"src", { recursive: true }')), true, "a literal repo area");
  assert.equal(enumeratesPopulation(rd("testDir")), true, "an unresolved root stays counted");
  assert.equal(
    enumeratesPopulation(`function walk(dir) { return ${rd("dir")}; }\nwalk(ROOT);`),
    true,
    "a helper that walks whatever root it is handed",
  );
  assert.equal(enumeratesPopulation(lsFiles("REPO_ROOT")), true);
  assert.equal(enumeratesPopulation(lsFiles()), true, "no cwd option means the repository");
  assert.equal(enumeratesPopulation(`${GL}("src/**/*.ts")`), true);
  assert.equal(
    enumeratesPopulation(`${MKROOT}${rd("root")};\n${rd('join(REPO_ROOT, "test")')};`),
    true,
    "one repo walk is enough even beside a fixture listing",
  );
});

test("run-task, live-write-guard-command-sites and recycle-container leave a one-line src change's census set", () => {
  const set = censusSuiteFiles(["src/lib/policy.ts"], REPO_ROOT);
  for (const suite of [
    "test/run-task.test.ts",
    "test/live-write-guard-command-sites.test.ts",
    "test/recycle-container.test.ts",
  ]) {
    assert.ok(
      enumeratesPopulation(readFileSync(join(REPO_ROOT, suite), "utf8")) === false && !set.includes(suite),
      `${suite} lists only its own fixtures and must not be a census suite`,
    );
  }
});

test("the whole-tree suites stay in the census set of a one-line src change", () => {
  const set = censusSuiteFiles(["src/lib/policy.ts"], REPO_ROOT);
  for (const suite of [
    "test/config-reader-seams.test.ts",
    "test/source-text-assertion-census.test.ts",
    "test/negative-reachability-ratchet.test.ts",
    "test/catch-erasure-ratchet.test.ts",
    "test/a-census-suite-is-unreachable-from-the-symbols-a-diff-changes.test.ts",
  ]) {
    assert.ok(set.includes(suite), `${suite} walks the repository tree and must stay a census suite`);
  }
  assert.ok(set.length > 50, `control: the set is still a large population (${set.length})`);
});
