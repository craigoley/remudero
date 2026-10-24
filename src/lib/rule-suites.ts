/**
 * Which test files are CI rule suites (W1-T9877). A dependency-free leaf: `scripts/diff-class.mjs`
 * imports it before dependencies are installed, and `ci-parity.ts` re-exports every name here.
 */

/** Which predicate clause a candidate fails, for a member REFUSED on the predicate rather than on cost. */
export type CensusPredicateClause = "a" | "b" | "c";

export type CensusVerdict =
  | { readonly status: "ADMITTED"; readonly measuredMs: number }
  | {
      readonly status: "REFUSED";
      readonly reason: { readonly kind: "cost"; readonly measuredMs: number; readonly detail: string };
    }
  | {
      readonly status: "REFUSED";
      readonly reason: { readonly kind: "predicate"; readonly clause: CensusPredicateClause; readonly detail: string };
    };

/** One test file the recognizer found, carrying its verdict. `script` is meaningful only for an
 *  ADMITTED member — what the census step table is DERIVED from, never hand-duplicated onto.
 *  `walks` is broader: a cost-refused suite can still name the population a diff joins. */
export interface CensusPopulationMember {
  readonly testFile: string;
  readonly job: string;
  readonly script?: string;
  readonly walks?: readonly string[];
  readonly reason: string;
  readonly verdict: CensusVerdict;
}

/** Job-name slug for a REFUSED member; a nested path's "/" flattens to "-". An ADMITTED entry's `job` names its real step. */
export function censusJobSlug(testFile: string): string {
  return `${testFile.replace(/^test\//, "").replace(/\.test\.ts$/, "").replaceAll("/", "-")}-census`;
}

/** A member refused for failing the predicate, never for cost — `clause` names which of (a)/(b)/(c). */
function refusedForPredicate(testFile: string, clause: CensusPredicateClause, detail: string): CensusPopulationMember {
  return {
    testFile,
    job: censusJobSlug(testFile),
    reason: `fails predicate clause (${clause}): ${detail}`,
    verdict: { status: "REFUSED", reason: { kind: "predicate", clause, detail } },
  };
}

export const CENSUS_POPULATION: readonly CensusPopulationMember[] = [
  {
    testFile: "test/bound-kind-declared.test.ts",
    job: "bound-kind-census",
    script: "census:bound-kind",
    walks: ["src/"],
    reason:
      "same-class (W1-T2478) — a census suite: walks tracked src/*.ts, asserts every bound-shaped constant declares BACKSTOP or " +
      "PRIMARY CONTROL against the scripts/bound-kind-baseline.json grandfather list, structurally identical to claims/jscpd/depcruise; " +
      "measured well under the PRIMARY CONTROL bound below. Blocked #3304 on a single undeclared bound-shaped constant with a clean " +
      "fast run immediately before it — this is the required-core reason the class exists, restated for this one member (design iv)",
    verdict: { status: "ADMITTED", measuredMs: 470 },
  },
  {
    testFile: "test/ledger-literal-census.test.ts",
    job: "ledger-literal-census",
    script: "census:ledger-literal",
    walks: ["src/"],
    reason:
      "same-class (W1-T2478) — a census suite: walks tracked src/ via git ls-files, reads each file's text and asserts a " +
      "property EVERY enumerated file must hold (no ledger-filename literal outside its own declared ALLOWED exemptions table), which is " +
      "clause (a) SATISFIED rather than a search for call sites. Structurally identical to the catch-erasure and bound-kind " +
      "members beside it. MEASURED 2026-09-08, three runs alone: 338/452/456ms, median 452ms — well under " +
      "FAST_GATE_CENSUS_BOUND_MS, so neither the predicate nor the cost gave a reason to refuse it. ADMITTED rather than " +
      "refused because the fast lane exists to catch exactly this class before a full CI cycle",
    verdict: { status: "ADMITTED", measuredMs: 452 },
  },
  {
    testFile: "test/catch-erasure-ratchet.test.ts",
    job: "catch-erasure-census",
    script: "census:catch-erasure",
    walks: ["src/"],
    reason:
      "same-class (W1-T2478) — a census suite: walks tracked src/*.ts, asserts every bare-erasing catch site stays within its " +
      "per-file baseline count, structurally identical to claims/jscpd/depcruise; measured well under the bound below",
    verdict: { status: "ADMITTED", measuredMs: 803 },
  },
  {
    testFile: "test/negative-reachability-ratchet.test.ts",
    job: "negative-reachability-census",
    script: "census:negative-reachability",
    walks: ["src/", "test/"],
    reason:
      "same-class (W1-T2478) — a census suite: walks tracked src/**/*.ts and test/**/*.ts, asserts every _RE/DEFAULT_FIX_CLASSES " +
      "surface's unhealthy arm is exercised, against its own embedded baseline tables; measured well under the bound below",
    verdict: { status: "ADMITTED", measuredMs: 1201 },
  },
  {
    testFile: "test/authority-ratchet.test.ts",
    job: "authority-census",
    script: "census:authority",
    walks: ["src/"],
    reason:
      "same-class (W1-T2478) — a census suite: walks tracked src/**/*.ts, asserts every file with a detectable external write " +
      "(assertLiveWriteAllowed call, gh REST write-verb argv, gh pr/issue create-merge-comment-close argv, or raw git push argv) " +
      "against its own AUTHORITY_TABLE baseline (src/lib/authority.ts) by module; measured well under the bound below",
    verdict: { status: "ADMITTED", measuredMs: 520 },
  },
  {
    testFile: "test/no-shallowing-of-the-canonical-checkout.test.ts",
    job: "no-shallowing-census",
    script: "census:no-shallowing",
    walks: ["src/", "scripts/", "deploy/", ".github/workflows/"],
    reason:
      "same-class (W1-T2478) — a census suite: walks tracked src/, scripts/, deploy/ and .github/workflows/, asserts no unexempted " +
      "depth-limiting git flag against its own EXEMPTIONS table; measured well under the bound below",
    verdict: { status: "ADMITTED", measuredMs: 526 },
  },
  {
    testFile: "test/no-draft-pull-request-ever-sits-on-the-board.test.ts",
    job: "no-draft-pr-census",
    script: "census:no-draft-pr",
    walks: ["src/", "scripts/", "deploy/", ".github/"],
    reason:
      "same-class (W1-T4415) — a census suite: walks tracked src/, scripts/, deploy/ and .github/ (trackedFiles(), a git ls-files), " +
      "asserts every line against its own four draft-creating-call shapes (its own DRAFT_CREATOR_PATTERNS table, named in full " +
      "in that script's header rather than spelled out here so this very reason text cannot itself read as a hit) is either " +
      "absent or reasoned in its own EXEMPTIONS table (empty today) — structurally identical to no-shallowing beside it. " +
      "Operator ruling 2026-09-24: no process may open a draft PR, since a draft never reviews or merges and holds work " +
      "exactly like a stuck one; this suite ran only in CI's coverage shards until now, so a violation surfaced only after a " +
      "push. MEASURED 2026-09-25, three runs alone (after one cold npm-startup run discarded): 1276/1296/1296ms, median " +
      "1296ms — well under FAST_GATE_CENSUS_BOUND_MS, so neither the predicate nor the cost gave a reason to refuse it",
    verdict: { status: "ADMITTED", measuredMs: 1296 },
  },
  {
    testFile: "test/enforcement-data-carveout.test.ts",
    job: "enforcement-data-carveout-census",
    walks: ["src/", "scripts/"],
    reason:
      "satisfies (a)-(c): deriveEnforcementDataCandidates() walks the whole tracked tree via git ls-files, filters to src/ and " +
      "scripts/ readers to build a text corpus, and the suite's own completeness test asserts findUnexplainedGaps() is empty against " +
      "ENFORCEMENT_DATA/ENFORCEMENT_DATA_EXCLUSIONS, a real baseline/exemption table — the same suite W1-T2478's own shipped test " +
      "named as its fifth ('measured ~2.1s alone... deliberately NOT added'); refused by cost, never by mechanism",
    verdict: {
      status: "REFUSED",
      reason: {
        kind: "cost",
        measuredMs: 3755,
        detail:
          "node --test --import tsx --import ./test/setup/tmp-hygiene.ts test/enforcement-data-carveout.test.ts, alone, " +
          "measured 2026-09-04: 3686/3755/3769ms across three runs (median kept) — over FAST_GATE_CENSUS_BOUND_MS; re-run the " +
          "same command to re-derive or refute this number",
      },
    },
  },
  refusedForPredicate(
    "test/node-24-runtime-compatibility.test.ts",
    "c",
    "W1-T5882's Node 24 suite. It walks tracked src/, scripts/ and bin/ via git ls-files and asserts every nested `node --test` " +
      "argv names a reporter and no Worker is handed process.execArgv, but it carries no baseline or exemption table: an exempt " +
      "spawn says so inline at its own call site (`node-test-reporter: exempt`), so every violation bites, not only new ones",
  ),

  refusedForPredicate(
    "test/a-count-assertion-names-its-members.test.ts",
    "a",
    "walks git ls-files scoped to test/*.test.ts only — never src/ — so it is not a src-population walk; its own header states " +
      "it carries no baseline/grandfather table either",
  ),

  refusedForPredicate(
    "test/an-active-learning-is-reachable-by-some-file.test.ts",
    "a",
    "W1-T4240's reachability census. Its `git ls-files` enumerates every tracked path as the MATCH DOMAIN for the learnings " +
      "corpus's `files:` globs, and the property it asserts is about each ACTIVE LEARNING (some glob hits some path; no shard line " +
      "reads as a comment to the proof judge), never a property every enumerated src/ file must hold. The `src/` strings the " +
      "recognizer sees are fixture paths and imports",
  ),

  refusedForPredicate(
    "test/acceptance-block-diagnostics.test.ts",
    "b",
    "`git ls-files` (whole repo, includes src/) is used only to copy the tracked tree into a mutation-testing shadow checkout — " +
      "no per-file assertion is made anywhere in the suite",
  ),

  refusedForPredicate(
    "test/ledger-read-intent.test.ts",
    "a",
    "`git ls-files src/lib/status.ts` checks exactly one file is tracked, and a dedicated test pins the enforced corpus stays " +
      "exactly that one file — not a population walk",
  ),
  refusedForPredicate(
    "test/licence-boundary.test.ts",
    "a",
    "`git(['ls-files'])` output is filtered to root-only files (`!f.includes('/')`), which excludes src/ entirely by construction",
  ),

  refusedForPredicate(
    "test/no-raw-nul.test.ts",
    "c",
    "`git ls-files -z` (whole repo, includes src/) drives a real per-file loop asserting zero raw-NUL bytes, but the suite's own " +
      "header explicitly rejects an allowlist by design (\"WHY EXTENSION FILTERING, NOT AN ALLOWLIST\") — no baseline/exemption " +
      "table exists, so a single new violation anywhere reddens it rather than only a NEW one",
  ),

  refusedForPredicate(
    "test/rule-citation-gate-engine-portable.test.ts",
    "a",
    "W1-T2849's engine-portability suite. Its `git ls-files -- *.ts *.mjs *.sh` does enumerate a set that includes " +
      "src/, and its loop and assertion are in-file, so it satisfies (b). It fails (a) on WHAT IT ASSERTS OVER: the " +
      "property is a fact about `git grep` CALL SITES — one line in the whole tree at the time of writing — not a " +
      "property every enumerated file must hold, so the enumeration is a search for call sites rather than the " +
      "population under test. The `src/` strings the recognizer sees are this file's own pathspec default and its " +
      "assertion messages. NOTE FOR A LATER READER: admission is the defensible alternative and was NOT taken here — " +
      "it is a measured cost decision that changes FAST_GATE_STEPS composition, which a build pass should not make " +
      "unilaterally. If an operator judges (a) satisfied, this row becomes an ADMITTED entry with a measured ms.",
  ),
  refusedForPredicate(
    "test/the-affected-suite-reach-ratchet.test.ts",
    "a",
    "W1-T5702's reach ratchet. Its `git ls-files` over src/, scripts/, bin/ and test/ builds the selector's import graph " +
      "and asserts three AGGREGATES of it (run-task.ts importer count, largest SCC, median reach) against " +
      "scripts/affected-reach-baseline.json — a tree-wide fact, never a property each walked file must hold, the same shape " +
      "as test/env-var-registry.test.ts below",
  ),

  // W1-T2916's suite. The recognizer matches it on `src/` text that is its import of
  // src/lib/settings.js plus prose ("src runtime package uses are dependencies"), but the
  // population it actually enumerates is package.json's own dependency maps read against
  // .dependency-cruiser.cjs — two fixed config files. The tracked `src/` population it never reads.
  refusedForPredicate(
    "test/dependency-declarations-match-use.test.ts",
    "a",
    "enumerates package.json's dependency/override maps and .dependency-cruiser.cjs, two fixed config files, " +
      "never the tracked src/ population; the src/ text the recognizer matches is its settings.js import and its prose",
  ),

  refusedForPredicate(
    "test/env-var-registry.test.ts",
    "a",
    "W1-T2900's harness-env registry suite. Its `git ls-files src/**/*.ts` DOES enumerate the tracked src/ population and it " +
      "reads each file's text, so it satisfies (b) and (c). It fails (a) on WHAT IT ASSERTS OVER: the property is a SET " +
      "EQUALITY between the `RMD_`/`REMUDERO_` literals found anywhere in that text and ENV_REGISTRY's names — a fact about " +
      "the tree-wide literal set, not a property each enumerated file must hold. A src file containing no env literal " +
      "contributes nothing and is asserted over in no way, which is the same shape as " +
      "test/rule-citation-gate-engine-portable.test.ts above: the enumeration is a SEARCH for call sites rather than the " +
      "population under test. " +
      "NOTE FOR A LATER READER, and the numbers are supplied so the decision needs no re-measurement: this suite is CHEAP — " +
      "`node --test --import tsx --import ./test/setup/tmp-hygiene.ts test/env-var-registry.test.ts`, alone, measured " +
      "2026-09-07 at 243/215/213ms across three runs (median 215ms), far under FAST_GATE_CENSUS_BOUND_MS. So cost is NOT the " +
      "reason it sits here, and admission is the defensible alternative. It was NOT taken: admission changes FAST_GATE_STEPS " +
      "composition, which the entry above records as a decision a build pass must not make unilaterally. If an operator " +
      "judges (a) satisfied, this row becomes an ADMITTED entry with `script: \"census:env-var-registry\"` and that measured ms.",
  ),

];

export const RULE_SUITE_NAME_RE = /(?:census|ratchet|baseline)/i;

const RULE_SUITE_DIR = "test/rules/";

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

const ROSTER_BASENAMES = new Set(CENSUS_POPULATION.map((member) => basename(member.testFile)));

/**
 * Is `path` a rule suite? Anything under test/rules/ and any roster member (matched by basename, so
 * a moved member stays enrolled) is, and cannot opt out. Otherwise the BASENAME must match
 * RULE_SUITE_NAME_RE and `text`'s leading comments must carry no `@not-a-rule-suite: <reason>`.
 */
export function isRuleSuitePath(path: string, text = ""): boolean {
  if (!path.startsWith("test/") || !path.endsWith(".test.ts")) return false;
  const name = basename(path);
  if (path.startsWith(RULE_SUITE_DIR) || ROSTER_BASENAMES.has(name)) return true;
  if (!RULE_SUITE_NAME_RE.test(name)) return false;
  const header = text.match(/^\s*(?:(?:\/\/[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)\s*)*/)![0];
  const markers = [...header.matchAll(/@not-a-rule-suite\b([^\r\n]*)/g)];
  for (const marker of markers) {
    if (!/^[ \t]*:[ \t]*\S/.test(marker[1]!.replace(/\*\/.*$/, "").trimEnd())) {
      throw new Error(`${path}: @not-a-rule-suite requires a reason`);
    }
  }
  return markers.length === 0;
}
