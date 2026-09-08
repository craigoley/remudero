#!/usr/bin/env node
// scripts/diff-class.mjs — W1-T2428: classifies a diff as PLAN_ONLY, DOCS_ONLY, or SOURCE, so
// `ci` and `coverage-ratchet` can skip suites that class cannot fail (no `src/**` or `test/**`
// file moved). The class comes from `isInPlanScope` (src/lib/plan-architect.ts), the same
// predicate the reviewer's sweep uses (W1-T205) — never a second scope-rule implementation.
//
// THREE CLASSES: PLAN_ONLY (every file in plan scope), DOCS_ONLY (every file in plan scope or
// under `docs/`), SOURCE (anything else, including an empty or unreadable list). `classify()`
// never throws and fails closed to SOURCE, never PLAN_ONLY, on anything undeterminable.
//
// USAGE: `--changed-files <path>` classifies a newline-separated file list (`-` reads stdin);
// `--list-plan-reading-suites` prints the suites `planReadingSuiteFiles` selects; W1-T2680's
// `--list-census-suites --changed-files <path>` prints the suites `censusSuiteFiles` selects —
// suites a `git grep -l <symbol>` caller sweep cannot reach, because a census names none of the
// symbols a diff touches.
//
// OUTPUT: classify mode prints one class token to stdout (reason on stderr) and always exits 0.
// Both --list-* modes print one test path per line and, on an enumeration error, print NOTHING and
// exit 1 — a caller reading zero lines from a nonzero exit must fail closed and run the full suite.
//
// Why: docs/forensics/diff-class.md#module-header (CI-spend measurement, scope-predicate rationale).

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseArgs } from "node:util";
import { isInPlanScope, outOfPlanScopeFiles } from "../src/lib/plan-architect.ts";
import { isMainModule } from "./lib/argv.mjs";
import { REPO_ROOT } from "./lib/repo-root.mjs";

export { REPO_ROOT };

/** The three recognized class tokens, exported so callers never hand-copy the literal set. */
export const CLASSES = Object.freeze({
  PLAN_ONLY: "PLAN_ONLY",
  DOCS_ONLY: "DOCS_ONLY",
  SOURCE: "SOURCE",
});

/**
 * Whether a repo-relative path counts as "docs" for DOCS_ONLY — the `docs/` prefix only, never a
 * bare `.md` match: `MASTER-PLAN.md` is already plan scope, and a bare extension match would also
 * swallow a `src/`-adjacent README a docs-only diff should not be classified around.
 */
export function isDocsPath(path) {
  return path.startsWith("docs/");
}

/**
 * Parses a changed-file list — one path per line, blanks ignored. Matches `git diff --name-only
 * <base>...HEAD`'s own output shape, the convention every diff-scoped ci.yml job uses.
 */
export function parseChangedFiles(rawText) {
  if (typeof rawText !== "string") return [];
  return rawText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Classifies a changed-file list. Never throws: a non-array, `null`/`undefined`, or empty input
 * is itself an "undeterminable" case and resolves to SOURCE — see the module header.
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
 * Whether `content` (a test file's source) reads a repo-root path — the `REPO_ROOT` constant, or
 * an inline `join(__dirname, "..")`. Exported for its own unit tests below; `planReadingSuiteFiles`
 * no longer gates on it (see that function's doc).
 */
export function hasRepoRootConstant(content) {
  return /\bREPO_ROOT\b/.test(content) || /join\(\s*__dirname\s*,/.test(content);
}

/**
 * Whether `content` names a plan or docs path — `plan/`, `docs/`, or `MASTER-PLAN.md` as a string
 * literal, including the `join(REPO_ROOT, "docs", ...)` spelling. Deliberately over-inclusive:
 * running one extra harmless suite is cheaper than silently dropping one that can fail.
 */
export function namesPlanOrDocsPath(content) {
  return (
    /["'`](?:\.\.\/)*(?:plan\/|docs\/)/.test(content) ||
    /\bjoin\(\s*REPO_ROOT\s*,\s*["'`](?:plan|docs)["'`]\s*(?:,|\))/.test(content) ||
    /MASTER-PLAN\.md/.test(content)
  );
}

/**
 * The plan-reading suite set, enumerated from the tree at run time — never a hand-copied list.
 * Directory-only: `test/helpers`/`test/setup` are shared fixtures, not suites `npm test`'s glob
 * selects either way. Qualifies by `namesPlanOrDocsPath(content)` alone — `hasRepoRootConstant`
 * used to gate this too but was dropped: MEASURED, it excluded six suites that can fail on a
 * plan-only diff, and no other source-shape spelling separated the set either.
 */
// Why: docs/forensics/diff-class.md#planreadingsuitefiles.
export function planReadingSuiteFiles(root = REPO_ROOT) {
  const testDir = join(root, "test");
  const out = [];
  for (const entry of readdirSync(testDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".test.ts")) continue;
    const abs = join(testDir, entry.name);
    const content = readFileSync(abs, "utf8");
    if (namesPlanOrDocsPath(content)) {
      out.push(relative(root, abs).split(sep).join("/"));
    }
  }
  out.sort();
  return out;
}

// ── W1-T2680: THE SUITES A `git grep <symbol>` SWEEP CANNOT REACH ─────────────────────────────

/**
 * The directory-prefix areas (`src/`, `test/`, `src/lib/`, ...) a changed file belongs to — the
 * unit `censusSuiteFiles` matches a candidate suite against.
 */
export function changedAreas(files) {
  const areas = new Set();
  for (const f of files ?? []) {
    const parts = f.split("/");
    if (parts.length < 2) continue;
    areas.add(parts[0] + "/"); // e.g. "src/", "test/", "scripts/"
    if (parts.length > 2) areas.add(parts[0] + "/" + parts[1] + "/"); // e.g. "src/lib/"
  }
  return areas;
}

/**
 * `content` reduced to text where naming an area means something: relative path literals
 * (`"../src/lib/x.js"`, which are imports) and comments (which are prose) both stripped. Both
 * subtractions were measured necessary — without them, a bare `content.includes("src/")` also
 * matches every file's own imports and any mention inside a doc comment.
 */
// Why: docs/forensics/diff-class.md#withoutrelativepathliterals.
export function withoutRelativePathLiterals(content) {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, "$1")
    .replace(/["'`](?:\.\.\/)+[^"'`]*["'`]/g, '""');
}

/**
 * Whether `content` enumerates a population of repo files — `ls-files`, a directory read, or a
 * real glob call; shelling `git` for something else (e.g. a tmpdir fixture's `init`/`add`/`commit`)
 * is not this. A bare `src/**`-shaped string was tried as a fourth signal and removed: it
 * false-positived on a suite asserting about a `node --test` command string, not a population walked.
 */
// Why: docs/forensics/diff-class.md#enumeratespopulation-the-removed-glob-clause.
export function enumeratesPopulation(content) {
  return (
    /\bls-files\b/.test(content) ||
    /\breaddirSync\b|\breaddir\b/.test(content) ||
    /\bglobSync\b|\bglob\(/.test(content)
  );
}

/**
 * Every repo-relative source path a test file reads AS TEXT — a path spelled inside a
 * `readFileSync` call. This is the second census shape: a suite can assert on a changed file's
 * shape (e.g. test/mounts-wiring.test.ts) while naming no symbol it mentions.
 */
// Why: docs/forensics/diff-class.md#sourcetextpathsread.
export function sourceTextPathsRead(content) {
  const paths = new Set();
  // Only paths spelled INSIDE a readFileSync call — a fixture string elsewhere doesn't count.
  const CALL = /\breadFileSync\s*\(/g;
  for (let m = CALL.exec(content); m; m = CALL.exec(content)) {
    // The call's own argument text, bounded to 240 chars (covers the longest real call in this tree).
    const arg = content.slice(m.index, m.index + 240);
    for (const q of arg.matchAll(/["'`](?:\.\.\/)+((?:src|scripts|test|plan)\/[^"'`]*)["'`]/g)) paths.add(q[1]);
    for (const q of arg.matchAll(/["'`]((?:src|scripts|test|plan)\/[^"'`*]*\.[a-z]+)["'`]/g)) paths.add(q[1]);
  }
  return paths;
}

/**
 * The suites a diff joins that name none of its symbols — enumerated from the tree at run time,
 * never a registry. Listed when relevant to the changed areas: enumerates a population and names
 * a touched area, or reads a specific changed file as text. The first arm is deliberately loose
 * (over-listing costs one suite; under-listing is the silent miss this verb exists to end); the
 * second is exact. An empty changed-file set yields an empty list, unlike `classify()`'s SOURCE.
 */
// Why: docs/forensics/diff-class.md#censussuitefiles.
export function censusSuiteFiles(changedFiles, root = REPO_ROOT) {
  const files = (changedFiles ?? []).filter((f) => typeof f === "string" && f.length > 0);
  if (files.length === 0) return [];
  const areas = changedAreas(files);
  const changed = new Set(files);
  const testDir = join(root, "test");
  const out = [];
  for (const entry of readdirSync(testDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".test.ts")) continue;
    const rel = relative(root, join(testDir, entry.name)).split(sep).join("/");
    if (changed.has(rel)) continue; // a suite the diff itself edits is already in hand
    const content = readFileSync(join(testDir, entry.name), "utf8");
    const bare = withoutRelativePathLiterals(content);
    const walksAnArea = enumeratesPopulation(content) && [...areas].some((a) => bare.includes(a));
    const readsAChangedFile = [...sourceTextPathsRead(content)].some((p) => changed.has(p));
    if (walksAnArea || readsAChangedFile) out.push(rel);
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
      // W1-T2680: given a changed-file list, print every suite that WALKS a population those files
      // belong to, or READS one of them as text — the suites `git grep -l <symbol>` cannot reach.
      "list-census-suites": { type: "boolean", default: false },
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

  if (values["list-census-suites"]) {
    try {
      const files = readChangedFilesArg(values["changed-files"]);
      const root = values["plan-reading-root"] ?? REPO_ROOT;
      for (const path of censusSuiteFiles(files, root)) console.log(path);
      process.exitCode = 0;
    } catch (err) {
      console.error(`diff-class: FAILED to enumerate the census suite set — ${err && err.message ? err.message : String(err)}`);
      console.error("diff-class: printing NOTHING — a caller reading zero lines here must fail closed and run the full suite.");
      process.exitCode = 1;
    }
    return;
  }

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

if (isMainModule(import.meta.url)) main(process.argv.slice(2));
