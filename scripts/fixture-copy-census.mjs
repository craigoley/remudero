/**
 * THE FIXTURE-COPY CENSUS'S COUNTER, moved out of test/fixture-copy-census.test.ts so a caller
 * that must not start a test runner can still ask the census's own question. `hooks/pre-push`
 * (through scripts/census-precheck.mjs) is that caller: importing a `node:test` file runs its
 * tests, and W1-T3225 removed the runner from that hook for damaging the repo it protected.
 *
 * The census suite imports the definitions from here and keeps every falsifier that pins what
 * each signature does and does not count.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createScanner, SyntaxKind as K } from "typescript/unstable/ast";

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

/** Tokens after which a `/` divides: each one can end an expression. After any other token, a `/`
 *  starts a regex literal, which the scanner then reads as one token. */
const ENDS_AN_EXPRESSION = new Set([
  K.Identifier, K.PrivateIdentifier, K.NumericLiteral, K.BigIntLiteral, K.StringLiteral, K.RegularExpressionLiteral,
  K.NoSubstitutionTemplateLiteral, K.TemplateTail, K.CloseParenToken, K.CloseBracketToken, K.CloseBraceToken,
  K.PlusPlusToken, K.MinusMinusToken, K.ThisKeyword, K.SuperKeyword, K.TrueKeyword, K.FalseKeyword, K.NullKeyword,
]);

/** Literal text inside each token kind, as [offset from the token start, offset from the token end]. */
const LITERAL_TEXT = new Map([
  [K.StringLiteral, [1, 1]],
  [K.NoSubstitutionTemplateLiteral, [1, 1]],
  [K.TemplateHead, [1, 2]],
  [K.TemplateMiddle, [1, 2]],
  [K.TemplateTail, [1, 1]],
]);

/**
 * `text` with every character inside a string literal, and inside the text part of a template
 * literal, replaced by a space (W1-T14303). Newlines stay, so offsets and line numbers stay the
 * same. Code inside a template's `${...}` stays code. The TypeScript scanner reads escapes, regex
 * literals and nested templates; this walk only tells it where a regex or a template part starts.
 */
export function codeOnlyText(text) {
  const out = text.split("");
  const scanner = createScanner(true, undefined, text);
  const braces = [];
  let previous = K.Unknown;
  for (let kind = scanner.scan(); kind !== K.EndOfFile; kind = scanner.scan()) {
    if ((kind === K.SlashToken || kind === K.SlashEqualsToken) && !ENDS_AN_EXPRESSION.has(previous)) kind = scanner.reScanSlashToken();
    else if (kind === K.CloseBraceToken && braces.at(-1) === "template") {
      braces.pop();
      kind = scanner.reScanTemplateToken(false);
    } else if (kind === K.OpenBraceToken) braces.push("brace");
    else if (kind === K.CloseBraceToken) braces.pop();
    if (kind === K.TemplateHead || kind === K.TemplateMiddle) braces.push("template");
    // The scanner returns a lone `#` as an empty token and stays on it; step past it.
    if (scanner.getTokenEnd() <= scanner.getTokenStart()) scanner.resetTokenState(scanner.getTokenStart() + 1);
    const literal = LITERAL_TEXT.get(kind);
    if (literal) {
      for (let i = scanner.getTokenStart() + literal[0]; i < scanner.getTokenEnd() - literal[1]; i++) {
        if (out[i] !== "\n" && out[i] !== "\r") out[i] = " ";
      }
    }
    previous = kind;
  }
  return out.join("");
}

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

/** A fixture-directory name: a quoted `"gh"` that is the second argument of `ownedFixtureDir(`,
 *  as in `ownedFixtureDir(t, "gh")`. It names a temp directory, not a shim (W1-T12322). */
const GH_FIXTURE_DIR_NAME_RE = /ownedFixtureDir\(\s*[^,()]+,\s*["']gh["']/g;

/** A `gh` PATH shim: a file that has three things. It has a quoted `"gh"`, it calls `chmod` or
 *  `writeFileSync`, and it names `PATH`. Every hand-built shim in this suite has all three: it
 *  writes the script, then puts its directory on `PATH`. One part alone is not enough. A
 *  fixture-directory name is removed before the rule looks for the quoted `"gh"`, so a file
 *  whose only `"gh"` is `ownedFixtureDir(t, "gh")` is not counted. */
function isGhPathShimFile(text) {
  const withoutFixtureDirNames = text.replace(GH_FIXTURE_DIR_NAME_RE, "ownedFixtureDir(scope, name");
  return /["']gh["']/.test(withoutFixtureDirNames) && /(chmod|writeFileSync)/.test(text) && /PATH/.test(text);
}

/** The one top-level directory under `test/` whose `*.test.ts` files are DATA, never suites: a
 *  fixture checkout's own tests (`test/fixtures/**`) are inputs to other tests, not tests. */
export const FIXTURE_COPY_EXCLUDED_DIR = "fixtures";

/**
 * The `test/`-relative POSIX path of every `*.test.ts` file under `<root>/test`, at any depth
 * (`top.test.ts`, `helpers/git-repo.test.ts`), minus `test/fixtures/**` and the census suite's own
 * file. A moved test (test restructure, letter D) stays counted: the walk never assumes the flat
 * `test/*.test.ts` layout. Sorted, so two calls over one tree agree.
 *
 * THAT FILE'S OWN NAME is always excluded. Its falsifier tests necessarily embed literal example
 * text for every signature this census tracks (a fake `["init"` call site, a `function
 * fakeGithubOne(` declaration, a `writeFileSync(..., "gh", ...)` shim write) — real duplication
 * those examples are NOT. Scanning them in would bake permanent, untouchable weight into every
 * signature that no migration could ever shrink. A synthetic fixture tree is a DIFFERENT `root`
 * entirely, so this exclusion never hides one of ITS files — only ever the real suite.
 */
export function listFixtureCopyFiles(root) {
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(root, "test", rel), { withFileTypes: true })) {
      const path = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (rel === "" && e.name === FIXTURE_COPY_EXCLUDED_DIR) continue;
        walk(path);
      } else if (e.isFile() && e.name.endsWith(".test.ts") && e.name !== FIXTURE_COPY_CENSUS_FILENAME) out.push(path);
    }
  };
  try {
    walk("");
  } catch {
    return []; // no test/ dir at all (a minimal falsifier fixture) — every count is zero
  }
  return out.sort();
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

    // A builder name counts only where it is declared in code, never inside literal text (W1-T14303).
    const code = codeOnlyText(text);
    let m;
    // `Repo(?!rt)`: MEASURED across 1411 test files, the bare `Repo` alternative counted five
    // REPORT builders — parseReport, runFixtureReport, runReport, shardLintReport and
    // workerResultWithReport — none of which builds a repository, and two of which blocked a PR
    // apiece (#5069, #5071) on an overage they did not cause. The negative lookahead drops exactly
    // those five and keeps all 42 genuine `Repo`-bearing builders, `Repository` spellings included.
    const repoRe = builderDeclarationRe("Repo(?!rt)|Checkout|Clone|Worktree|Bare");
    while ((m = repoRe.exec(code))) repoBuilderNames.add(m[1] ?? m[2]);

    const ghRe = builderDeclarationRe("[Gg]it[Hh]ub");
    let sawGh = false;
    while ((m = ghRe.exec(code))) {
      fakeGithubBuilderNames.add(m[1] ?? m[2]);
      sawGh = true;
    }
    if (sawGh) fakeGithubBuilderFiles.add(name);

    const ledgerRe = builderDeclarationRe("[Ll]edger");
    while ((m = ledgerRe.exec(code))) ledgerHelperNames.add(m[1] ?? m[2]);

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

/** Scan `<root>/test` and return the seven signature counts. In a git checkout, require the
 *  complete tracked suite population; synthetic directory-only fixtures need no git index. */
export function countFixtureCopies(root) {
  const testDir = join(root, "test");
  const inspected = listFixtureCopyFiles(root);
  if (existsSync(join(root, ".git"))) {
    const tracked = execFileSync("git", ["ls-files", "-z", "--", ":(glob)test/**/*.test.ts"], { cwd: root, encoding: "utf8" })
      .split("\0")
      .filter((p) => p && !p.startsWith("test/fixtures/") && !p.endsWith(`/${FIXTURE_COPY_CENSUS_FILENAME}`))
      .map((p) => p.slice("test/".length))
      .sort();
    assert.ok(inspected.length > 0, "the fixture-copy census must inspect at least one test suite");
    assert.deepEqual(inspected, tracked, "the fixture-copy census must inspect the complete tracked test suite population");
  }
  return countFixtureCopiesInTexts(inspected.map((name) => [name, readFileSync(join(testDir, name), "utf8")]));
}

/** Every signature whose live count exceeds its baseline, rendered `"<signature>: N > baseline
 *  M (+D over)"` — empty when the census is clean. */
export function fixtureCopyViolations(live, baseline) {
  return FIXTURE_COPY_SIGNATURES.filter((sig) => live[sig] > (baseline[sig] ?? 0)).map(
    (sig) => `${sig}: ${live[sig]} > baseline ${baseline[sig] ?? 0} (+${live[sig] - (baseline[sig] ?? 0)} over)`,
  );
}
