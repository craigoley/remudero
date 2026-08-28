#!/usr/bin/env node
// scripts/diff-class.mjs — W1-T2428: the fast-lane classifier.
//
// A plan-only or docs-only diff cannot fail `ci`'s Typecheck/Test or `coverage-ratchet`'s
// coverage collection — no `src/**` or `test/**` file moved. Measured 2026-08-27: plan-only is
// 36 of 60 recent merges (60%) and 58.7% of CI spend, at a mean 1,873s each (`ci` 685s +
// `coverage-ratchet` 1,187s). This script answers ONE question — "what class is this diff?" —
// so a CI job can skip the suites that cannot fail on it, WITHOUT ever skipping the job itself
// (see plan/tasks.d/W1-T2428-*.yaml's Q4: a job that stops REGISTERING deadlocks merge forever;
// the fix is always a step-level bash guard inside a job that still runs).
//
// THE CLASS COMES FROM THE REAL PREDICATE, NEVER A FOURTH REIMPLEMENTATION. `isInPlanScope`
// (src/lib/plan-architect.ts) is already canonical — it is what the sweep computes `planOnly`
// from for the reviewer (W1-T205), and its own doc says it is the WIDEST correct definition of
// plan scope (it includes `docs/ORIENTATION.md`, regenerated FROM `MASTER-PLAN.md` by `rmd
// retro`). This script imports that function directly; a bash reimplementation of scope rules
// would be a fourth predicate, drifting from the three (`isInPlanScope`, `nonPlanFilesInDiff`,
// `TASKS_SHARD_PATH_RE`) that already disagree with each other today (see the task's rationale,
// Q1) — one more disagreeing definition is not the fix.
//
// THREE CLASSES:
//   PLAN_ONLY — every changed file is in plan scope (`isInPlanScope`).
//   DOCS_ONLY — every changed file is EITHER in plan scope OR under `docs/`.
//   SOURCE    — anything else, including an empty or undeterminable file list. A diff carrying
//               ONE path outside plan-or-docs scope is SOURCE, whatever else it also carries —
//               there is no "mostly plan" class.
//
// FAIL CLOSED. `classify()` never throws: an unreadable file list, an internal error, or an
// empty file list all resolve to SOURCE (never PLAN_ONLY — an empty list read as "nothing to
// check" would be catastrophically wrong on a truncated `git diff`/paginated file list). The CLI
// (`main`) mirrors this at the process boundary: it always exits 0 and always prints exactly one
// recognized class token on stdout, so a caller's bash guard never has to special-case a crash.
//
// USAGE (CI, via `node --import tsx scripts/diff-class.mjs`, the same tsx binding
// scripts/acceptance-author-gate.mjs uses for a `.mjs` file importing a `.ts` module):
//   node --import tsx scripts/diff-class.mjs --changed-files <path>   (path to a newline-
//     separated file list, e.g. `git diff --name-only <base>...HEAD > changed-files.txt`; `-`
//     reads the list from stdin)
//   node --import tsx scripts/diff-class.mjs --list-plan-reading-suites   (prints, one per line,
//     every test/**/*.test.ts file the PLAN-ONLY/DOCS-ONLY fast lane must still run — see
//     `planReadingSuiteFiles` below)
//
// OUTPUT (classify mode): stdout carries EXACTLY one line — the class token (`PLAN_ONLY`,
// `DOCS_ONLY`, or `SOURCE`). The human-readable reason goes to stderr, so a bash guard can do
// `CLASS="$(node --import tsx scripts/diff-class.mjs --changed-files f.txt)"` and get a clean
// value with nothing else to strip. Exit code is always 0 in this mode.
//
// OUTPUT (--list-plan-reading-suites mode): stdout carries one repo-relative test file path per
// line, sorted. On any enumeration error, prints NOTHING and exits 1 — a caller reading zero
// lines from a nonzero exit must fail closed (run the FULL suite), never trust an empty list as
// "no suites matter".

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { isInPlanScope, outOfPlanScopeFiles } from "../src/lib/plan-architect.ts";

/** Repo root, derived from this script's own location — never a cwd assumption (same convention
 *  as scripts/acceptance-author-gate.mjs's REPO_ROOT). */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The three recognized class tokens, exported so the test/CLI never hand-copy the literal set. */
export const CLASSES = Object.freeze({
  PLAN_ONLY: "PLAN_ONLY",
  DOCS_ONLY: "DOCS_ONLY",
  SOURCE: "SOURCE",
});

/**
 * Whether a repo-relative path is a "docs" path for the DOCS_ONLY class — deliberately narrow
 * (the `docs/` directory only), never a `.md` extension match: `README.md`/`MASTER-PLAN.md` at
 * repo root already have their own homes (plan scope covers `MASTER-PLAN.md`; a bare `.md` glob
 * would also swallow e.g. a `src/`-adjacent README a docs-only diff should NOT be classified
 * around).
 */
export function isDocsPath(path) {
  return path.startsWith("docs/");
}

/**
 * Parse a changed-file list out of raw text — one path per line, blank lines and surrounding
 * whitespace ignored. This is the shape `git diff --name-only <base>...HEAD` already produces
 * (the same convention every other diff-scoped job in ci.yml uses, e.g. mutation-ratchet's
 * `changed-files.txt`).
 */
export function parseChangedFiles(rawText) {
  if (typeof rawText !== "string") return [];
  return rawText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Classify a changed-file list. NEVER THROWS — see the module header's FAIL CLOSED section.
 * `files` should already be a parsed array (see `parseChangedFiles`); a non-array, `null`, or
 * `undefined` input is itself an "undeterminable" case and resolves to SOURCE.
 * @param {unknown} files
 * @returns {{ class: string, reason: string }}
 */
export function classify(files) {
  try {
    if (!Array.isArray(files)) {
      return { class: CLASSES.SOURCE, reason: "no changed-file list was provided — undeterminable, failing closed to SOURCE" };
    }
    if (files.length === 0) {
      return {
        class: CLASSES.SOURCE,
        reason: "the changed-file list is EMPTY — failing closed to SOURCE rather than reading an empty list as plan-only",
      };
    }
    const outOfPlan = outOfPlanScopeFiles(files);
    if (outOfPlan.length === 0) {
      return {
        class: CLASSES.PLAN_ONLY,
        reason: `all ${files.length} changed file(s) are in plan scope per isInPlanScope (src/lib/plan-architect.ts)`,
      };
    }
    const nonDocs = outOfPlan.filter((f) => !isDocsPath(f));
    if (nonDocs.length === 0) {
      return {
        class: CLASSES.DOCS_ONLY,
        reason: `every changed file is in plan scope or under docs/ (${outOfPlan.length} docs/ file(s), 0 source path(s))`,
      };
    }
    return {
      class: CLASSES.SOURCE,
      reason:
        `${nonDocs.length} changed file(s) are outside plan scope and outside docs/ (e.g. "${nonDocs[0]}") — ` +
        "a diff carrying one source path is SOURCE whatever else it carries",
    };
  } catch (err) {
    return {
      class: CLASSES.SOURCE,
      reason: `classification threw — undeterminable, failing closed to SOURCE: ${err && err.message ? err.message : String(err)}`,
    };
  }
}

/**
 * Whether `content` (a test file's raw source) carries a repo-root constant — the pattern every
 * suite reading a REPO file (as opposed to a per-test tmpdir fixture) declares, per this task's
 * rationale: `const REPO_ROOT = join(__dirname, "..")` (test/plan-proposals.test.ts's own shape)
 * or an inline `join(__dirname, "..", ...)` with no intermediate variable.
 */
export function hasRepoRootConstant(content) {
  return /\bREPO_ROOT\b/.test(content) || /join\(\s*__dirname\s*,/.test(content);
}

/**
 * Whether `content` names a plan-or-docs repo path — `plan/`, `docs/`, or `MASTER-PLAN.md`,
 * quoted as a string literal (never a bare substring match, which would also catch a comment
 * merely discussing "plan/tasks.yaml" in prose without the suite ever reading it — this still
 * over-includes relative to "reads it", by design: OVER-including here only means the fast lane
 * runs one extra harmless suite, while under-including would silently drop a suite that CAN
 * fail, which is the failure mode this whole classifier exists to avoid).
 */
export function namesPlanOrDocsPath(content) {
  return /["'`](?:\.\.\/)*(?:plan\/|docs\/)/.test(content) || /MASTER-PLAN\.md/.test(content);
}

/**
 * THE 94-FILE PLAN-READING SET, ENUMERATED FROM THE TREE — never a hand-copied list (acceptance
 * criterion 5). Walks `test/**\/*.test.ts` and returns every file (repo-relative, POSIX
 * separators, sorted) that BOTH reads a repo-root file (`hasRepoRootConstant`) AND names a plan
 * or docs path (`namesPlanOrDocsPath`) — the intersection the task's rationale (Q1) measures at
 * 94 files, with two controls proven in test/fast-lane-classifier.test.ts: `plan-proposals.test.ts`
 * (reads `MASTER-PLAN.md` off `REPO_ROOT`) is IN the intersection; `sweep.test.ts` (a pure-source
 * suite with no repo-root constant at all) is NOT.
 *
 * Directory-only, not recursive into `test/helpers`/`test/setup` — those are shared fixtures, not
 * suites `npm test`'s own `test/**\/*.test.ts` glob would select either way.
 */
export function planReadingSuiteFiles(root = REPO_ROOT) {
  const testDir = join(root, "test");
  const out = [];
  for (const entry of readdirSync(testDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".test.ts")) continue;
    const abs = join(testDir, entry.name);
    const content = readFileSync(abs, "utf8");
    if (hasRepoRootConstant(content) && namesPlanOrDocsPath(content)) {
      out.push(relative(root, abs).split(sep).join("/"));
    }
  }
  out.sort();
  return out;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────

function readChangedFilesArg(value) {
  const raw = value === "-" ? readFileSync(0, "utf8") : readFileSync(value, "utf8");
  return parseChangedFiles(raw);
}

export function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "changed-files": { type: "string" },
      "list-plan-reading-suites": { type: "boolean", default: false },
      // TEST-ONLY: overrides the enumeration root passed to planReadingSuiteFiles(). ci.yml never
      // passes this flag (it always enumerates the real repo tree); it exists so
      // test/fast-lane-classifier.test.ts can drive main()'s own --list-plan-reading-suites catch
      // block (below) as a REAL subprocess, by pointing it at a directory that does not exist, and
      // so genuinely throws — without chmod'ing a file under the real test/ dir, which
      // test/host-capability-fixtures.test.ts ratchets against a declared allowlist this task's
      // file scope (W1-T1227) does not include.
      "plan-reading-root": { type: "string" },
    },
  });

  if (values["list-plan-reading-suites"]) {
    try {
      const root = values["plan-reading-root"] ?? REPO_ROOT;
      for (const path of planReadingSuiteFiles(root)) console.log(path);
      process.exitCode = 0;
    } catch (err) {
      console.error(`diff-class: FAILED to enumerate the plan-reading suite set — ${err && err.message ? err.message : String(err)}`);
      console.error("diff-class: printing NOTHING — a caller reading zero lines here must fail closed and run the full suite.");
      process.exitCode = 1;
    }
    return;
  }

  let files;
  try {
    files = readChangedFilesArg(values["changed-files"]);
  } catch (err) {
    console.error(`diff-class: could not read --changed-files: ${err && err.message ? err.message : String(err)}`);
    files = undefined; // classify() below treats this as undeterminable — fails closed to SOURCE
  }

  const { class: cls, reason } = classify(files);
  console.error(`diff-class: ${cls} — ${reason}`);
  console.log(cls);
  process.exitCode = 0; // ALWAYS 0 in classify mode — the class token on stdout carries the verdict
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main(process.argv.slice(2));
