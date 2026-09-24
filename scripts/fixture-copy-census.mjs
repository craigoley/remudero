/**
 * THE FIXTURE-COPY CENSUS'S COUNTER, moved out of test/fixture-copy-census.test.ts so a caller
 * that must not start a test runner can still ask the census's own question. `hooks/pre-push`
 * (through scripts/census-precheck.mjs) is that caller: importing a `node:test` file runs its
 * tests, and W1-T3225 removed the runner from that hook for damaging the repo it protected.
 *
 * The definitions are unchanged, byte for byte in behaviour; the census suite imports them from
 * here and keeps every falsifier that pins what each signature does and does not count.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Every signature this census tracks, in the fixed order the baseline JSON's keys must match
 *  exactly (see the "no key drift" test in test/fixture-copy-census.test.ts). */
export const FIXTURE_COPY_SIGNATURES = [
  "gitInitSites",
  "gitInitFiles",
  "repoBuilderFunctionNames",
  "fakeGithubBuilderNames",
  "fakeGithubBuilderFiles",
  "ghPathShimFiles",
  "ledgerHelperNames",
];

/** The census suite's own basename — see the exclusion comment inside {@link countFixtureCopies}. */
export const FIXTURE_COPY_CENSUS_FILENAME = "fixture-copy-census.test.ts";

/** A raw `git init` call site — the first positional argument to a git-wrapper call is the
 *  literal `"init"`, e.g. `["init", "--quiet", ...]` or `g("init", "-q", ...)`. Deliberately NOT
 *  a bare `/"init"/` match: that also hits `subtype: "init"` (an unrelated event-type literal)
 *  and CLI help text listing `"init"` as a subcommand name — both false positives this pattern
 *  excludes by requiring `"init"` to sit immediately after `(` or `[`. */
const GIT_INIT_SITE_RE = /[([]\s*["']init["']/g;

/** A builder function/const declaration whose name contains one of `word`'s alternatives — either
 *  `function name(` or `const name = (...) =>` (an arrow function; a plain `const x = "foo"` or
 *  `const x = otherFn()` is NOT a builder and does not match). Shared by the repo/GitHub/ledger
 *  signatures below, which differ only in `word`. */
function builderDeclarationRe(word) {
  return new RegExp(
    `function\\s+([a-zA-Z]*(?:${word})[A-Za-z]*)\\s*\\(` + `|const\\s+([a-zA-Z]*(?:${word})[A-Za-z]*)\\s*(?::[^=\\n]+)?=\\s*\\([^)]*\\)\\s*(?::[^=\\n]+)?=>`,
    "g",
  );
}

/** A `gh` PATH shim: a file that writes something literally named `"gh"` (via `writeFileSync`
 *  or `chmod`), and separately mentions `PATH` — the two-part signature every hand-rolled shim
 *  in this suite shares (write the executable, then prepend its dir onto `PATH`). Neither half
 *  alone is enough: `writeFileSync` alone is any fixture writer, and `PATH` alone is any file
 *  that happens to mention an env var by that name. */
function isGhPathShimFile(text) {
  return /["']gh["']/.test(text) && /(chmod|writeFileSync)/.test(text) && /PATH/.test(text);
}

/**
 * The names of every direct `*.test.ts` file under `<root>/test` (NEVER a subdirectory — matching
 * the audit's own `test/*.test.ts` glob, so `test/helpers/*.ts` — this census's own fixtures
 * included — and `test/setup/*.ts` are never counted), minus the census suite's own file.
 *
 * THAT FILE'S OWN NAME is always excluded. Its falsifier tests necessarily embed literal example
 * text for every signature this census tracks (a fake `["init"` call site, a `function
 * fakeGithubOne(` declaration, a `writeFileSync(..., "gh", ...)` shim write) — real duplication
 * those examples are NOT. Scanning them in would bake permanent, untouchable weight into every
 * signature that no migration could ever shrink. A synthetic fixture tree is a DIFFERENT `root`
 * entirely, so this exclusion never hides one of ITS files — only ever the real suite.
 */
export function listFixtureCopyFiles(root) {
  try {
    return readdirSync(join(root, "test"), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".test.ts"))
      .filter((e) => e.name !== FIXTURE_COPY_CENSUS_FILENAME)
      .map((e) => e.name);
  } catch {
    return []; // no test/ dir at all (a minimal falsifier fixture) — every count is zero
  }
}

/**
 * The seven signature counts over `texts`, one `[fileName, text]` pair per scanned file. Pure,
 * so a caller can count a population that exists only in part on disk — the pre-push precheck
 * counts the merge base as "this tree, with the changed files read at the base".
 *
 * @param {Iterable<[string, string]>} texts
 */
export function countFixtureCopiesInTexts(texts) {
  let gitInitSites = 0;
  let gitInitFiles = 0;
  const repoBuilderNames = new Set();
  const fakeGithubBuilderNames = new Set();
  const fakeGithubBuilderFiles = new Set();
  const ledgerHelperNames = new Set();
  let ghPathShimFiles = 0;

  for (const [name, text] of texts) {
    const initMatches = text.match(GIT_INIT_SITE_RE);
    if (initMatches && initMatches.length > 0) {
      gitInitSites += initMatches.length;
      gitInitFiles += 1;
    }

    let m;
    // `Repo(?!rt)`: MEASURED across 1411 test files, the bare `Repo` alternative counted five
    // REPORT builders — parseReport, runFixtureReport, runReport, shardLintReport and
    // workerResultWithReport — none of which builds a repository, and two of which blocked a PR
    // apiece (#5069, #5071) on an overage they did not cause. The negative lookahead drops exactly
    // those five and keeps all 42 genuine `Repo`-bearing builders, `Repository` spellings included.
    const repoRe = builderDeclarationRe("Repo(?!rt)|Checkout|Clone|Worktree|Bare");
    while ((m = repoRe.exec(text))) repoBuilderNames.add(m[1] ?? m[2]);

    const ghRe = builderDeclarationRe("[Gg]it[Hh]ub");
    let sawGh = false;
    while ((m = ghRe.exec(text))) {
      fakeGithubBuilderNames.add(m[1] ?? m[2]);
      sawGh = true;
    }
    if (sawGh) fakeGithubBuilderFiles.add(name);

    const ledgerRe = builderDeclarationRe("[Ll]edger");
    while ((m = ledgerRe.exec(text))) ledgerHelperNames.add(m[1] ?? m[2]);

    if (isGhPathShimFile(text)) ghPathShimFiles += 1;
  }

  return {
    gitInitSites,
    gitInitFiles,
    repoBuilderFunctionNames: repoBuilderNames.size,
    fakeGithubBuilderNames: fakeGithubBuilderNames.size,
    fakeGithubBuilderFiles: fakeGithubBuilderFiles.size,
    ghPathShimFiles,
    ledgerHelperNames: ledgerHelperNames.size,
  };
}

/** Scan `<root>/test` (see {@link listFixtureCopyFiles}) and return the seven signature counts.
 *  Reads files, computes, returns — no writes, no baseline comparison. */
export function countFixtureCopies(root) {
  const testDir = join(root, "test");
  return countFixtureCopiesInTexts(listFixtureCopyFiles(root).map((name) => [name, readFileSync(join(testDir, name), "utf8")]));
}

/** Every signature whose live count exceeds its baseline, rendered `"<signature>: N > baseline
 *  M (+D over)"` — empty when the census is clean. */
export function fixtureCopyViolations(live, baseline) {
  return FIXTURE_COPY_SIGNATURES.filter((sig) => live[sig] > (baseline[sig] ?? 0)).map(
    (sig) => `${sig}: ${live[sig]} > baseline ${baseline[sig] ?? 0} (+${live[sig] - (baseline[sig] ?? 0)} over)`,
  );
}
