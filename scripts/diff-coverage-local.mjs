#!/usr/bin/env node
// scripts/diff-coverage-local.mjs
//
// LOCAL DIFF-COVERAGE, MEASURED TO MATCH CI (W1-T4084). Before this script existed, running
// diff-coverage.mjs locally meant hand-rolling the instrumented `node --experimental-test-coverage`
// invocation and the diff it checks -- and both hand-rolled pieces were measured wrong in the same
// session on 2026-09-22: (a) omitting `--enable-source-maps` reports `diff-coverage: OK` for a PR
// CI then BLOCKED on a genuinely uncovered line, because without source maps `DA:` positions land
// on tsx-transpiled JS lines while `SF:` still names the `.ts` file (ci.yml's own comment on its
// "Test with coverage" step explains the same defect); and (b) diffing `A..B` (two dots) instead of
// `A...B` (three) against a moved `origin/main` added a false BLOCKED by including origin/main's
// own unrelated commits in the diff.
//
// THIS SCRIPT FIXES BOTH BY NEVER RE-DECIDING THEM: {@link extractCoverageFlags} READS the node
// invocation straight out of `.github/workflows/ci.yml`'s `coverage-ratchet` job's "Test with
// coverage" step -- not a copy of its flags, so a future edit to that step changes what this
// script runs with it, and the two cannot drift silently apart again. {@link mergeBaseDiff} always
// diffs `<base>...HEAD` (triple-dot, merge-base-relative), the same semantics CI's own
// `git diff HEAD^1...HEAD` has against the PR's base parent. The actual per-diff gate is then
// scripts/diff-coverage.mjs ITSELF, invoked as a subprocess exactly as ci.yml invokes it -- this
// script never reimplements lcov parsing or line matching, only reproduces the two inputs CI feeds
// it (the instrumented lcov and the merge-base diff).
//
// Usage: npm run diff-coverage:local -- <test files...>
//   --base <ref>   merge-base this against instead of origin/main (default origin/main)
//   --lcov <path>  where to write/read the lcov report (default coverage/lcov.info)
//   --dry-run      print the node invocation and diff base this WOULD use, run nothing
//
// The caller supplies the test files to run under coverage -- exactly the files whose lcov `SF:`
// records diff-coverage.mjs needs, so a run that never exercised a changed source file fails loudly
// with that file named (diff-coverage.mjs's own missing-SF-record check, `findMissingSourceCoverage`)
// rather than passing vacuously. This script's own message on that failure adds the one thing that
// check cannot know locally: which argument to fix.
//
// Falsifier: test/local-diff-coverage-matches-ci.test.ts.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { isMainModule } from "./lib/argv.mjs";
import { gitOrThrow } from "./lib/git.mjs";
import { REPO_ROOT } from "./lib/repo-root.mjs";

export const CI_YAML_RELATIVE_PATH = ".github/workflows/ci.yml";
export const COVERAGE_JOB_NAME = "coverage-ratchet";
export const COVERAGE_STEP_NAME_PREFIX = "Test with coverage";
const NODE_INVOCATION_MARKER = "node --enable-source-maps";
const TEST_FILES_PLACEHOLDER = '"${COVERAGE_TEST_FILES[@]}"';

/**
 * The `coverage-ratchet` job's "Test with coverage" step's `run:` script, straight out of a
 * parsed ci.yml -- never hand-copied, so a step rename or removal fails this loudly instead of
 * silently returning stale flags.
 * @param {string} ciYamlText
 */
export function coverageStepRunScript(ciYamlText) {
  const doc = parseYaml(ciYamlText);
  const job = doc?.jobs?.[COVERAGE_JOB_NAME];
  if (!job) {
    throw new Error(
      `diff-coverage-local: ${CI_YAML_RELATIVE_PATH} has no "${COVERAGE_JOB_NAME}" job -- cannot read its coverage flags`,
    );
  }
  const step = (job.steps ?? []).find(
    (s) => typeof s?.name === "string" && s.name.startsWith(COVERAGE_STEP_NAME_PREFIX),
  );
  if (!step || typeof step.run !== "string") {
    throw new Error(
      `diff-coverage-local: ${CI_YAML_RELATIVE_PATH}'s "${COVERAGE_JOB_NAME}" job has no ` +
        `"${COVERAGE_STEP_NAME_PREFIX}" step with a run: script -- its shape has changed; update this script`,
    );
  }
  return step.run;
}

/**
 * Split a shell-ish flag string into argv tokens: whitespace-separated, honouring ONE level of
 * double quotes so `--test-coverage-exclude="test/**"` becomes the single token
 * `--test-coverage-exclude=test/**`, the same way a shell would join it. Not a general shell
 * parser -- this repo's ci.yml never asks for more (no single quotes, no nested quoting in the
 * coverage step), and a falsifier over the real file catches a future step that would need one.
 * @param {string} text
 */
export function tokenizeShellWords(text) {
  const tokens = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n) break;
    let token = "";
    while (i < n && !/\s/.test(text[i])) {
      if (text[i] === '"') {
        i++;
        while (i < n && text[i] !== '"') {
          token += text[i];
          i++;
        }
        i++; // skip the closing quote
      } else {
        token += text[i];
        i++;
      }
    }
    tokens.push(token);
  }
  return tokens;
}

/**
 * The exact node coverage flags ci.yml's "Test with coverage" step passes -- everything between
 * `node` and the shard's own `${COVERAGE_TEST_FILES[@]}` placeholder, backslash-newline
 * continuations joined first so the flags spread across several `run:` lines read as one.
 * READ, NOT COPIED (W1-T4084 design (i)): change the step's flags in ci.yml and this changes with
 * them on the next run, so the local and CI invocations cannot silently drift apart.
 * @param {string} ciYamlText
 */
export function extractCoverageFlags(ciYamlText) {
  const runScript = coverageStepRunScript(ciYamlText);
  const start = runScript.indexOf(NODE_INVOCATION_MARKER);
  if (start === -1) {
    throw new Error(
      `diff-coverage-local: could not find "${NODE_INVOCATION_MARKER}" in ${CI_YAML_RELATIVE_PATH}'s ` +
        `"${COVERAGE_STEP_NAME_PREFIX}" step -- its shape has changed; update this script's extraction`,
    );
  }
  const end = runScript.indexOf(TEST_FILES_PLACEHOLDER, start);
  if (end === -1) {
    throw new Error(
      `diff-coverage-local: could not find ${TEST_FILES_PLACEHOLDER} after the node invocation in ` +
        `${CI_YAML_RELATIVE_PATH}'s "${COVERAGE_STEP_NAME_PREFIX}" step -- its shape has changed; update this script`,
    );
  }
  // Drop the leading "node" itself (this script supplies its own process.execPath); join
  // backslash-continued lines with a space so a multi-line `run:` block reads as one command.
  const segment = runScript.slice(start + "node".length, end).replace(/\\\s*\n/g, " ");
  return tokenizeShellWords(segment);
}

/** `git diff <base>...<head>` (triple-dot, merge-base-relative) -- the semantics CI's own
 *  `git diff HEAD^1...HEAD` has, and the fix for W1-T4084's measured false BLOCKED from a two-dot
 *  diff against a moved `origin/main`. A plain function so a falsifier can assert on the exact
 *  argv without spawning git.
 * @param {string} base
 * @param {string} head
 */
export function mergeBaseDiffArgs(base, head) {
  return ["diff", `${base}...${head}`];
}

/** Run {@link mergeBaseDiffArgs} for real, returning the diff text (never trimmed -- a trailing
 *  newline is part of a valid unified diff). */
export function mergeBaseDiff({ cwd = REPO_ROOT, base = "origin/main", head = "HEAD" } = {}) {
  const result = gitOrThrow(mergeBaseDiffArgs(base, head), { cwd });
  return result.length > 0 ? `${result}\n` : result;
}

function readCiYaml() {
  return readFileSync(join(REPO_ROOT, CI_YAML_RELATIVE_PATH), "utf8");
}

const HELP_TEXT = `Usage: npm run diff-coverage:local -- <test files...>

Runs exactly the coverage flags ci.yml's "${COVERAGE_STEP_NAME_PREFIX}" step uses (read from
.github/workflows/ci.yml, never copied) over the given test files, then checks the result with
scripts/diff-coverage.mjs against a merge-base (<base>...HEAD) diff -- the same per-diff gate CI
runs, on the same inputs CI would produce.

  --base <ref>   diff base (default origin/main)
  --lcov <path>  lcov report path (default coverage/lcov.info)
  --dry-run      print the node invocation and diff base this would use; run nothing
`;

export function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      base: { type: "string", default: "origin/main" },
      lcov: { type: "string", default: "coverage/lcov.info" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(HELP_TEXT);
    return 0;
  }

  const testFiles = positionals;
  if (testFiles.length === 0) {
    console.error("diff-coverage-local: no test files given.\n\n" + HELP_TEXT);
    return 1;
  }

  let flags;
  try {
    flags = extractCoverageFlags(readCiYaml());
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const nodeArgs = [...flags, ...testFiles];

  if (values["dry-run"]) {
    console.log(`diff-coverage-local: would run: NODE_V8_COVERAGE=coverage/raw node ${nodeArgs.join(" ")}`);
    console.log(`diff-coverage-local: would then check: git diff ${mergeBaseDiffArgs(values.base, "HEAD")[1]}`);
    return 0;
  }

  mkdirSync(join(REPO_ROOT, "coverage", "raw"), { recursive: true });
  console.log(
    `diff-coverage-local: running the instrumented suite exactly as ci.yml's "${COVERAGE_STEP_NAME_PREFIX}" ` +
      `step does, over ${testFiles.length} file(s)...`,
  );
  const testResult = spawnSync(process.execPath, nodeArgs, {
    stdio: "inherit",
    cwd: REPO_ROOT,
    env: { ...process.env, NODE_V8_COVERAGE: "coverage/raw" },
  });

  // THE ONE THING CHECKED BEFORE THE TEST EXIT CODE, mirroring ci.yml's own step: no lcov means
  // the gate below has nothing to read, which is the vacuous pass this whole script exists to
  // prevent.
  const lcovAbsolutePath = join(REPO_ROOT, values.lcov);
  let lcovStat;
  try {
    lcovStat = statSync(lcovAbsolutePath);
  } catch {
    console.error("diff-coverage-local: no lcov produced -- the coverage gate below would have nothing to read. FAILING.");
    return 1;
  }
  if (lcovStat.size === 0) {
    console.error("diff-coverage-local: lcov produced but empty -- FAILING.");
    return 1;
  }
  if (testResult.status !== 0) {
    console.error(
      `diff-coverage-local: the instrumented suite exited ${testResult.status} -- lcov was still checked ` +
        "above; this is a real test failure, not necessarily a coverage gap.",
    );
    return testResult.status ?? 1;
  }

  let diffText;
  try {
    diffText = mergeBaseDiff({ cwd: REPO_ROOT, base: values.base, head: "HEAD" });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  if (diffText.trim() === "") {
    console.log(`diff-coverage-local: OK -- ${values.base}...HEAD is empty, nothing to check.`);
    return 0;
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "rmd-diff-coverage-local-"));
  const diffPath = join(tmpDir, "pr.diff");
  try {
    writeFileSync(diffPath, diffText);
    const gateResult = spawnSync(
      process.execPath,
      [join(REPO_ROOT, "scripts", "diff-coverage.mjs"), "--lcov", values.lcov, "--diff", diffPath],
      { stdio: "inherit", cwd: REPO_ROOT },
    );
    if (gateResult.status !== 0) {
      console.error(
        "diff-coverage-local: see the gate output above -- for a missing SF record, add a test file " +
          "that exercises the named source file(s) to your <test files...> argument and re-run.",
      );
    }
    return gateResult.status ?? 1;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
