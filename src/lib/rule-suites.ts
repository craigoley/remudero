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
    "test/a-census-suite-is-unreachable-from-the-symbols-a-diff-changes.test.ts",
    "a",
    "W1-T2680's own suite. Its single ls-files call is `git ls-files test/*.test.ts`, used as a CONTROL to size the test " +
      "directory (so the verb under test can be shown not to return the whole of it) — it walks test/, never src/, and asserts " +
      "nothing about every file it counts. The `src/` strings the recognizer also sees are FIXTURE changed-file lists fed to the " +
      "verb, not a population it reads. Carries no baseline table either",
  ),
  refusedForPredicate(
    "test/a-count-assertion-names-its-members.test.ts",
    "a",
    "walks git ls-files scoped to test/*.test.ts only — never src/ — so it is not a src-population walk; its own header states " +
      "it carries no baseline/grandfather table either",
  ),
  refusedForPredicate(
    "test/every-test-finds-the-repo-root-through-one-helper.test.ts",
    "a",
    "W1-T9863's root guard. Its git ls-files and filesystem walk enumerate only test/ to compare own-folder root " +
      "computations against the merge base; src/ appears only inside synthetic fixture bodies, never as the repository " +
      "population it inspects",
  ),
  refusedForPredicate(
    "test/a-landed-feedback-file-remains-in-the-boot-checkout.test.ts",
    "a",
    "its sole ls-files call is `--error-unmatch <one file>` against a synthetic fixture repo — a single tracked-path check, not a " +
      "population walk",
  ),
  refusedForPredicate(
    "test/a-stale-dirty-fix-owner-is-preserved-and-reclaimed.test.ts",
    "a",
    "its `git ls-files --unmerged` call inspects one synthetic fix-owner fixture repo, not the tracked src/ population; " +
      "the `src/` text is import paths, and the suite asserts owner-recovery behavior rather than a property of every src file",
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
    "test/a-suite-is-not-a-second-concern.test.ts",
    "b",
    "walks `git ls-files src/*.ts src/lib/*.ts` for real, but asserts an aggregate percentage threshold (pct > 60) rather than a " +
      "property of every file walked, and carries no baseline/exemption table",
  ),
  refusedForPredicate(
    "test/acceptance-block-diagnostics.test.ts",
    "b",
    "`git ls-files` (whole repo, includes src/) is used only to copy the tracked tree into a mutation-testing shadow checkout — " +
      "no per-file assertion is made anywhere in the suite",
  ),
  refusedForPredicate(
    "test/checkout-writers.test.ts",
    "a",
    "`git ls-files -- ee-open.json` checks exactly one named path is untracked; not a population walk",
  ),
  refusedForPredicate(
    "test/comment-load-ratchet.test.ts",
    "a",
    "the comment-load ratchet's own falsifier suite. The recognizer's text heuristic matches it on an `ls-files` mention in its " +
      "header prose plus the `src/` fixture paths in its bodies, but the suite makes no such call over the tracked tree: its own " +
      "git calls build a throwaway fixture repo under mkdtemp, and its baseline-coverage assertion reads the population from the " +
      "script's exported listMeasuredFiles rather than walking src/ itself",
  ),
  refusedForPredicate(
    "test/config-fixture-path-parity.test.ts",
    "a",
    "`git ls-files test` is scoped to test/ only, never src/",
  ),
  refusedForPredicate(
    "test/deploy-scripts-use-mktemp.test.ts",
    "a",
    "W1-T2915's deploy-script census. Its `git ls-files deploy/*.sh` walks the DEPLOY population — shell scripts, never src/*.ts — " +
      "and the `src/` string the recognizer sees is one comment citing src/lib/tmp.ts's sweepStaleTempDirs as the reason the " +
      "`rmd-` prefix is load-bearing",
  ),
  refusedForPredicate(
    "test/coverage-session-blanking.test.ts",
    "a",
    "listTrackedTestFiles shells `git ls-files -- test` — test/ only, never src/",
  ),
  refusedForPredicate(
    "test/host-parity-azure-pole.test.ts",
    "a",
    "trackedFiles is only ever called with deploy/*.sh and test/*.test.ts patterns — never src/",
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
    "test/mkdtemp-callsite-check.test.ts",
    "b",
    "the underlying scripts/mkdtemp-callsite-check.mjs genuinely walks src/scripts/test via git ls-files with its own baseline " +
      "(hooks/mkdtemp-allowlist.txt), but the .test.ts file's OWN body never loops+asserts over that real population itself — most " +
      "of its tests exercise the pure classifier against synthetic fixtures, and its one real-repo check asserts a single " +
      "aggregate subprocess 'clean' match, the same same-class shape claims/jscpd already have, never the census's own in-file " +
      "per-item loop",
  ),
  refusedForPredicate(
    "test/moving-base-changed-files.test.ts",
    "a",
    "\"ls-files\" appears only in a comment; the suite tests git-diff-based changed-file derivation against synthetic fixture " +
      "repos and never shells ls-files itself",
  ),
  refusedForPredicate(
    "test/no-raw-nul.test.ts",
    "c",
    "`git ls-files -z` (whole repo, includes src/) drives a real per-file loop asserting zero raw-NUL bytes, but the suite's own " +
      "header explicitly rejects an allowlist by design (\"WHY EXTENSION FILTERING, NOT AN ALLOWLIST\") — no baseline/exemption " +
      "table exists, so a single new violation anywhere reddens it rather than only a NEW one",
  ),
  refusedForPredicate(
    "test/nothing-tells-you-which-census-suites-your-change-joins.test.ts",
    "a",
    "a meta-test of censusSuiteMembership(For) itself — its one 'git grep -l ls-files' shape is answered entirely by an injected " +
      "mock PreflightSpawn in every test; the real command is never shelled from this file",
  ),
  refusedForPredicate(
    "test/operator-gated-default-reachability.test.ts",
    "a",
    "`execFileSync('git', ['ls-files', 'test'])` is scoped to test/ only, never src/",
  ),
  // W1-T9872: these five suites enumerate the TEST corpus with `git ls-files` (so they keep seeing every file when a
  // suite moves into a subfolder of test/). The enumeration walks test/, never src/; the `src/` text the recognizer
  // also sees is the source those suites read or spawn against, not a population they walk.
  refusedForPredicate(
    "test/architecture-fitness.test.ts",
    "a",
    "W1-T9872: its `git ls-files` lists tracked test/**/*.test.ts (test/, never src/) as the corpus for three text sweeps; " +
      "its depcruise and layering checks assert one aggregate result over src/, not a per-file property with a baseline table",
  ),
  refusedForPredicate(
    "test/host-capability-fixtures.test.ts",
    "a",
    "W1-T9872: its `git ls-files` lists tracked test/ files (never src/) as the corpus the host-capability audit reads; the " +
      "`src/` strings the recognizer sees are fixture lines fed to the audit",
  ),
  refusedForPredicate(
    "test/mutation-ratchet.test.ts",
    "a",
    "W1-T9872: its `git ls-files` lists tracked test/ files (never src/) to find classify.ts importers; the `src/` strings " +
      "are the stryker scope paths and fixture reports it drives",
  ),
  refusedForPredicate(
    "test/orphan-sweep-names-the-third-party.test.ts",
    "a",
    "W1-T9872: its `git ls-files` lists tracked test/ files (never src/) to compute which fixtures hold the sweep lock; " +
      "the `src/` strings are the one worker-containment.ts read and fixture paths",
  ),
  refusedForPredicate(
    "test/the-mutant-loader-resolves-every-relative-import.test.ts",
    "a",
    "W1-T9872: its `git ls-files` lists tracked test/ files (never src/) to refuse a hand-rolled import rewrite; the `src/` " +
      "strings are the mutant-module fixtures it exercises",
  ),
  // W1-T2809's own suite. Same self-reference shape as its siblings: it is ABOUT the recognizer,
  // so it necessarily carries both idiom tokens and `src/` in its own text.
  refusedForPredicate(
    "test/census-discovery-is-blind-to-a-second-idiom.test.ts",
    "a",
    "W1-T2809's own control. Its `git ls-files test/*.test.ts` walks the TEST population as the corpus it re-derives the " +
      "two idiom sets from — never src/ — and it asserts about DISCOVERY, not a property of every src/ file. The `src/` " +
      "strings the recognizer sees are its own fixture bodies and the paths of the PR (#2639) the positive control is " +
      "anchored to",
  ),
  refusedForPredicate(
    "test/an-unmodelled-census-is-named-with-what-it-walks.test.ts",
    "a",
    "W1-T3238's own proof file. It fabricates census-shaped fixture text containing both `ls-files` and dir-walk idioms " +
      "so the membership reporter can prove candidates stay visible, but its real assertions are about that reporter and " +
      "mocked discovery inputs — it never walks the tracked src/ population and asserts no per-src-file property",
  ),
  // W1-T2905's own suite. SCOPE NOTE: the shard's `files:` names only the census test and its
  // baseline; this entry is here because `censusPopulationDrift` REFUSES an undisclosed
  // census-shaped file, and that gate cannot be satisfied from inside the two declared paths. The
  // widening is one refusal row, no behaviour.
  // W1-T2849: same shape as the entry below — this file's SUBJECT is the rule-citation gate's
  // engine portability, and its criterion-3 assertion happens to walk the tree. It is here because
  // `censusPopulationDrift` REFUSES an undisclosed census-shaped file and that gate cannot be
  // satisfied from inside the task's declared paths. One refusal row, no behaviour.
  // W1-T3021: this task's own falsifier. It is here for the reason the two entries below it are —
  // `censusPopulationDrift` refuses an undisclosed census-shaped file — and it was caught by the
  // very widening it ships, LOCALLY and while still untracked, which is the whole point.
  refusedForPredicate(
    "test/census-discovery-sees-the-file-you-are-adding.test.ts",
    "a",
    "W1-T3021's discovery falsifier. It walks NOTHING: every git call it makes runs inside a throwaway fixture " +
      "repository it created, and the `ls-files` the recognizer sees is a FIXTURE BODY string (the census-shaped " +
      "suite text it writes into that fixture), not an enumeration this file performs over the real tree. The " +
      "`src/` strings are its own import paths. Same self-match shape as the two entries below.",
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
    "test/source-text-assertion-census.test.ts",
    "a",
    "W1-T2905's source-text ratchet. Its `git ls-files test/*.test.ts` walks the TEST population and asserts a per-file " +
      "readFileSync-of-src count against scripts/source-text-assertion-baseline.json — so it satisfies (b) and (c) but " +
      "inverts (a): src/ is what its predicate LOOKS FOR inside test files, never the population it enumerates. The `src/` " +
      "strings the recognizer sees are that predicate's own regexes and its fixture bodies, the same self-match shape as " +
      "test/a-census-suite-is-unreachable-from-the-symbols-a-diff-changes.test.ts above",
  ),
  refusedForPredicate(
    "test/state-citation-check.test.ts",
    "b",
    "the underlying scripts/state-citation-check.mjs walks git ls-files from the repo root (includes src/) with a real baseline " +
      "(scripts/state-citation-baseline.json), but the .test.ts file's only real-repo assertion is an aggregate subprocess " +
      "exit-status-0 check, never a per-file loop/assert inside the test file itself",
  ),
  refusedForPredicate(
    "test/the-affected-suite-selector-runs-in-shadow.test.ts",
    "b",
    "W1-T4404's selector suite. It runs the selector's production deps once against the real tree (`git ls-files` over src/, " +
      "scripts/, bin/ and test/, read as an import graph) and asserts properties of the SELECTION — one suite reached, many " +
      "selected — never a property every walked file must hold, and it carries no baseline table",
  ),
  refusedForPredicate(
    "test/the-affected-suite-reach-ratchet.test.ts",
    "a",
    "W1-T5702's reach ratchet. Its `git ls-files` over src/, scripts/, bin/ and test/ builds the selector's import graph " +
      "and asserts three AGGREGATES of it (run-task.ts importer count, largest SCC, median reach) against " +
      "scripts/affected-reach-baseline.json — a tree-wide fact, never a property each walked file must hold, the same shape " +
      "as test/env-var-registry.test.ts below",
  ),
  refusedForPredicate(
    "test/tracked-source-write-guard.test.ts",
    "a",
    "listTrackedTestFiles shells `git ls-files -- test` — test/ only; src/ is the PROTECTED target this suite guards, not the " +
      "population it walks and asserts over",
  ),
  // W1-T2647's OWN proof file — self-reference shape as its siblings above; only real git call
  // is `git grep`, never `git ls-files`, so it fails clause (a).
  refusedForPredicate("test/census-population-is-derived-not-counted.test.ts", "a", "this file — W1-T2647's falsifier; its one real git call is `git grep`, never `git ls-files`"),
  // W1-T3272's own census. It DOES shell a real `git ls-files` (unlike the three entries above,
  // which fail clause (a) for making no such call at all) — but the population it walks is
  // `test/*.test.ts`, the TEST corpus, not `src/`. Clause (a) asks whether a candidate is a
  // SRC-population walk, and every ADMITTED member above carries `walks: ["src/"]` for exactly
  // that reason. So this is refused on the same clause by a different route, and the distinction
  // is recorded here because the next reader will see a genuine `git ls-files` and expect ADMITTED.
  // It is also why this suite is NOT projected into FAST_GATE_STEPS: the census it covers runs as
  // a step on `comment-load-ratchet`, and an ADMITTED member with no npm script of its own cannot
  // be projected (CENSUS_ADMITTED_MEMBERS narrows on `script`).
  // The nested-preflight census (#9724). Its one real `git ls-files` is scoped to `test/*.ts`, the
  // TEST corpus; the `src/` text the recognizer sees is its fixture import line. Same route as above.
  // W1-T9860's basename-uniqueness check. SCOPE NOTE: the task's `files:` does not name this file;
  // the row is here because `censusPopulationDrift` refuses an undisclosed census-shaped file, and
  // that gate cannot be satisfied from inside the declared paths. One refusal row, no behaviour.
  refusedForPredicate(
    "test/every-test-basename-is-unique.test.ts",
    "a",
    "W1-T9860's basename-uniqueness check. Its `git ls-files -- test/` and its directory walk both read the TEST " +
      "corpus, never src/; its `src/` text is the import of src/lib/test-path-resolver.js, the rule it applies",
  ),
  refusedForPredicate(
    "test/no-test-drives-a-real-preflight-against-the-repository-root.test.ts",
    "a",
    "the nested-preflight census. Its `git ls-files` is scoped to `test/*.ts`, the test corpus; its `src/` " +
      "text is a fixture import line, so it is not a src-population walk",
  ),
  refusedForPredicate(
    "test/every-shard-on-main-is-lintable.test.ts",
    "a",
    "W1-T3086's shard-lint ratchet. Its `git ls-files` is scoped to the plan's shard *.yaml and " +
      "*.yml files — the PLAN shard population, never src/*.ts — so it is not a " +
      "src-population walk. The `src/` strings the recognizer sees are its imports of " +
      "src/lib/plan.js and src/lib/task-linter.js, the code it drives, not a population it reads",
  ),
  refusedForPredicate(
    "test/expiring-fixture-census.test.ts",
    "a",
    "this file — W1-T3272's expiring-fixture census; it shells a real `git ls-files` but over " +
      "`test/*.test.ts`, the TEST corpus, so it is not a src-population walk. Its gate rides the " +
      "`comment-load-ratchet` job as a step rather than a projected fast-gate census entry",
  ),
  refusedForPredicate(
    "test/a-near-fixture-crossing-blocks-only-once-a-shifted-run-proves-it-red.test.ts",
    "a",
    "W1-T7812's shifted-run regression. Its `ls-files` responses are injected single-file fixture listings; " +
      "the real runner executes named tests in private fixture roots, never walks the tracked src/ population. " +
      "The src/ text the recognizer sees is its imports of gate-gardener.js and tmp.js",
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
  // Recon 2026-09-05 R-18's proof file. It shells a REAL `git ls-files` — unlike the four
  // self-referential entries directly above, whose only real git call is `git grep` — but against
  // a THROWAWAY fixture repo it builds in a temp dir, naming ONE path, purely to prove that
  // fixture's `escape` entry is a genuinely COMMITTED symlink (mode 120000) rather than a local
  // filesystem accident. The tracked `src/` population it never reads; the `src/` text the
  // recognizer matches on is its import of src/lib/review.js and its prose. Clause (a).
  refusedForPredicate(
    "test/proof-grep-target-stays-inside-checkout.test.ts",
    "a",
    "`git ls-files -s escape` runs inside a throwaway fixture repo and reads ONE fixture path (asserting mode 120000, i.e. a " +
      "committed symlink) — it is not a walk of the tracked src/ population and asserts nothing over any tree-wide set",
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
  // W1-T7853: both rows are here because `censusPopulationDrift` refuses an undisclosed census-shaped file. One
  // refusal row each, no behaviour.
  refusedForPredicate(
    "test/ci-filed-fold-debt-reaches-the-daemon.test.ts",
    "a",
    "W1-T7853's own suite. Its `git ls-files --others` is the ci.yml collect step's body, which it executes inside " +
      "throwaway fixture repositories, and its readdirSync lists those fixtures' plan/feedback and a runner temp dir. " +
      "It walks no tracked src/, test/ or scripts/ population and asserts no per-file property; the `src/` strings are " +
      "its own import paths.",
  ),
  refusedForPredicate(
    "test/the-merge-queue-runs-the-recorded-literal-gates.test.ts",
    "a",
    "W1-T5522's light-gates fixture. The `ls-files` the recognizer sees is the pinned argv of the fold-debt collect " +
      "step (W1-T7853), which it runs against stub tools in a temp dir; it walks no tracked population and asserts no " +
      "per-file property. The `src/` strings are its own import paths.",
  ),
  refusedForPredicate(
    "test/a-near-crossing-check-loads-the-gate-gardener-as-esm.test.ts",
    "a",
    "W1-T9565's own suite. The `ls-files` the recognizer sees is a stubbed execFile answer inside a temp-dir census " +
      "runner, and its readdirSync walks scripts/ (no module loads tsx/cjs/api) and a child's coverage dir, never the " +
      "tracked src/ population. The `src/` strings are its import path and the gardener path it expects mapped.",
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
