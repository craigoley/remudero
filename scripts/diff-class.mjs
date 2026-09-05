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
//   node --import tsx scripts/diff-class.mjs --list-census-suites --changed-files <path>
//     (W1-T2680: prints every suite that WALKS a population the changed files belong to, or READS
//     one of them as text — the suites a `git grep -l <symbol>` caller sweep cannot reach BY
//     CONSTRUCTION, because a census names none of the symbols any particular diff touches)
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
 * quoted as a string literal. Also recognizes the common path-join spelling
 * `join(REPO_ROOT, "docs", ...)` / `join(REPO_ROOT, "plan", ...)`: the old literal-prefix
 * predicate missed that form because `"docs"` is its own quoted segment, not a string beginning
 * `docs/`. This is still deliberately over-inclusive relative to "reads it": running one extra
 * harmless suite is cheaper than silently dropping a suite that CAN fail.
 */
export function namesPlanOrDocsPath(content) {
  return (
    /["'`](?:\.\.\/)*(?:plan\/|docs\/)/.test(content) ||
    /\bjoin\(\s*REPO_ROOT\s*,\s*["'`](?:plan|docs)["'`]\s*(?:,|\))/.test(content) ||
    /MASTER-PLAN\.md/.test(content)
  );
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
    // W1-T2428 (the `ci` half): NAMING A PLAN/DOCS PATH IS THE WHOLE PREDICATE. The
    // `hasRepoRootConstant(content) &&` conjunct that stood here was MEASURED under-inclusive and
    // is removed rather than widened, because no source-shape spelling separates the set:
    //
    //   With a malformed plan staged (a shard duplicating an existing id) and the 106 suites this
    //   conjunct EXCLUDED run to completion — 2,425 tests, every chunk carrying its own `# tests`
    //   summary, against a baseline of 0 failures on a WELL-FORMED plan — SIX suite files failed:
    //   credited-proof-visibility-seam-defaults, learnings-injection-w1t6, merged-claim-audit,
    //   mounts-wiring, retro, task-linter. Every one of them can fail on a plan-only diff and
    //   every one was being skipped.
    //
    //   WIDENING THE CONJUNCT DOES NOT FIX IT. Four of the six reach the repo root through
    //   `new URL(..., import.meta.url)` rather than a `REPO_ROOT` constant, so adding that idiom
    //   recovers four — but `credited-proof-visibility-seam-defaults` carries NO root-reaching
    //   idiom at all and still fails, and `sweep.test.ts` carries the SAME `import.meta.url` idiom
    //   while genuinely not caring about the plan. The spelling and the property are independent.
    //
    // DROPPING THE CONJUNCT CAPTURES 6 OF 6 and costs 158 suites of 802 — the lane still skips
    // 80%. That trade is the direction this function's own doc already names: over-including runs
    // one extra harmless suite, under-including silently drops one that CAN fail, "which is the
    // failure mode this whole classifier exists to avoid".
    if (namesPlanOrDocsPath(content)) {
      out.push(relative(root, abs).split(sep).join("/"));
    }
  }
  out.sort();
  return out;
}

// ── W1-T2680: THE SUITES A `git grep <symbol>` SWEEP CANNOT REACH ─────────────────────────────

/**
 * The directory prefixes a changed file can belong to, as a suite would NAME them. A suite is
 * relevant to a diff only if it reaches the AREA the diff touched — without this, every census in
 * the repo answers every question, which is the same as no answer (this task's own falsifier).
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
 * Whether `content` ENUMERATES A POPULATION of repo files — the shape that makes a suite
 * unreachable from any symbol a diff changes, because it names none of them.
 *
 * `execFileSync("git", ...)` ALONE IS NOT THIS, and that distinction is the whole difficulty.
 * test/serve.test.ts shells git six times — `init`, `config`, `add`, `commit` — against a
 * per-test tmpdir fixture, and it is an ordinary suite this verb must NOT list. What separates a
 * census is enumeration OF THE TREE: `ls-files`, a directory read, or a real glob call.
 *
 * A BARE `src/**`-SHAPED STRING IS NOT ENUMERATION EITHER, and a clause matching one was tried and
 * REMOVED: MEASURED, it fired on `a-printed-remedy-is-never-applied.test.ts` for the string
 * a `node --test` command string carrying a recursive test glob — a COMMAND that suite asserts
 * about, not a population it walks. (Written as prose deliberately: a star-star-slash inside a
 * block comment CLOSES it, which is how this very comment first broke the file.) Every
 * genuine walker in this repo reaches the tree through one of the three calls above, so the glob
 * clause bought nothing and cost a false positive on every `src/` change.
 */
/**
 * `content` reduced to the text where NAMING AN AREA MEANS SOMETHING: relative path literals
 * (`"../src/lib/x.js"`) and comments both removed.
 *
 * THIS IS WHAT KEEPS ARM (a) FROM ANSWERING "THE WHOLE TEST DIRECTORY", and both halves were
 * MEASURED necessary against the real tree of 1,084 suites, for a `src/lib/` change:
 *
 *   raw `content.includes("src/")`            128 of 1,084 — every file imports from `../src/...`
 *   minus relative path literals               82
 *   minus comments as well                     54
 *
 * A census names its population as a BARE path in CODE — `join(REPO_ROOT, "src")`, `"src/*.ts"`
 * passed to `git ls-files`. The `../` spelling is an import, and a `src/lib/x.ts` inside a doc
 * comment is prose: `a-printed-remedy-is-never-applied.test.ts` and
 * `a-count-assertion-names-its-members.test.ts` were both listed for every `src/` change on the
 * strength of a comment alone, which is the "hands you the whole directory" failure this task's
 * own falsifier names.
 */
export function withoutRelativePathLiterals(content) {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, "$1")
    .replace(/["'`](?:\.\.\/)+[^"'`]*["'`]/g, '""');
}

export function enumeratesPopulation(content) {
  return (
    /\bls-files\b/.test(content) ||
    /\breaddirSync\b|\breaddir\b/.test(content) ||
    /\bglobSync\b|\bglob\(/.test(content)
  );
}

/**
 * Every repo-relative source path this test file READS AS TEXT — `readFileSync` over a path
 * spelled inside the file. This is the SECOND census shape and it is not optional: acceptance
 * criterion 2 names test/mounts-wiring.test.ts, which enumerates NOTHING. It reads
 * `../src/run-task.ts` as a string and asserts on its SHAPE, so a diff that changes that file's
 * shape breaks it while naming no symbol the suite mentions. Measured on this repo the same day
 * this verb was built: two suites of exactly this shape (console-stopped-counts, decision-summary)
 * went red in CI on a diff whose prescribed caller sweep had run green over 45 files.
 */
export function sourceTextPathsRead(content) {
  const paths = new Set();
  // ONLY paths spelled INSIDE a readFileSync call. Collecting every path-shaped literal in the
  // file and merely REQUIRING a readFileSync somewhere was tried and MEASURED wrong: it listed
  // test/sweep.test.ts — the negative control this task's criterion 3 names — because that suite
  // carries `"src/config.ts"` and `"src/lib/widget.ts"` as FIXTURE DATA, fake paths fed to a
  // conflict-resolution helper, and never reads either. A path in a fixture is an argument to the
  // code under test; a path in `readFileSync` is a dependency on the tree. Only the second is this.
  const CALL = /\breadFileSync\s*\(/g;
  for (let m = CALL.exec(content); m; m = CALL.exec(content)) {
    // The call's own argument text — bounded, so a later unrelated literal cannot be attributed to
    // it. 240 chars covers `readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8")`.
    const arg = content.slice(m.index, m.index + 240);
    for (const q of arg.matchAll(/["'`](?:\.\.\/)+((?:src|scripts|test|plan)\/[^"'`]*)["'`]/g)) paths.add(q[1]);
    for (const q of arg.matchAll(/["'`]((?:src|scripts|test|plan)\/[^"'`*]*\.[a-z]+)["'`]/g)) paths.add(q[1]);
  }
  return paths;
}

/**
 * THE ANSWER TO "WHICH SUITES DOES MY DIFF JOIN, THAT NAME NONE OF ITS SYMBOLS" — enumerated from
 * the tree at run time, never from a registry. A census added tomorrow is found tomorrow; a
 * hardcoded list rots the moment someone adds one, which is the failure mode W1-T2521 already
 * names for census gates.
 *
 * A suite is listed when it is relevant to the CHANGED AREAS by either arm:
 *   (a) it ENUMERATES a population and names an area the diff touched, or
 *   (b) it READS AS TEXT a specific file the diff changed.
 *
 * Arm (b) is exact (a path match), so it cannot over-include. Arm (a) is deliberately the looser
 * one, and it is bounded by the area check rather than by cleverness: over-listing runs one extra
 * suite, under-listing is the silent miss this verb exists to end — the same asymmetry
 * `planReadingSuiteFiles` above already resolved in the same direction, for the same reason.
 *
 * An EMPTY changed-file set yields an EMPTY list (criterion 5): with no areas, nothing is relevant.
 * That is NOT a fail-closed case like `classify()`'s — this verb ADDS suites to a run, so an empty
 * answer costs nothing, while "every suite" would be the whole directory and no answer at all.
 */
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

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main(process.argv.slice(2));
