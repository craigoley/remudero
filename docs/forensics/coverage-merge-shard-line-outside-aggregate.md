# Coverage merge: a shard hit outside the aggregate's line list

A shard whose only loads of the scanner are native-shaped child processes reports `DA:23`; the aggregate cannot list it.

Scope: W1-T13518. This report reads PR #19183 (W1-T13439), run
[44164276361](https://github.com/craigoley/remudero/actions/runs/44164276361), where coverage-ratchet
failed twice with `coverage-merge-ratchet: shard LCOV reports a positive hit outside aggregate source
src/lib/trust-root-text.ts:23`. Every claim is labelled OBSERVED (measured here) or INFERRED
(reasoned from what was measured).

OBSERVED: the measurements ran on pinned Node **24.22.2** at checkout `59b9a9105`. These files are
byte-identical between that checkout and the failing run's base `e746d8ffa`:
`src/lib/trust-root-text.ts`, `src/lib/rule-suites.ts`, `scripts/coverage-merge-ratchet.mjs` and
`test/a-precheck-child-loads-each-source-file-once.test.ts`. So are the import lines of
`scripts/census-precheck.mjs` (`git diff e746d8ffa 59b9a9105`). PR head `14174986b` changed only
`src/lib/task-linter.ts` and one new test.

OBSERVED: the run's shard artifacts (`coverage-shard-1..12`, for example `coverage-shard-5`, id
14367835776) are listed by `api.github.com` and still unexpired. Downloading one failed here. The API
redirects to `productionresultssa4.blob.core.windows.net`, and this host's egress proxy refused that
CONNECT tunnel with 403. A control CONNECT to `example.com` was refused the same way, so the refusal is
this sandbox's and says nothing about the artifact. No shard LCOV from the run was read. Each
attribution to the historical run below is therefore INFERRED from a local reproduction.

## Which shard and which process

OBSERVED: three test suites start a child Node process that loads `src/lib/trust-root-text.ts`
**natively** (plain Node type stripping, no source map). That child writes its V8 report into the
suite's own coverage directory, and the suite loads the scanner in no other shape. A census of the 66
test files that import, spawn or name `scripts/census-precheck.mjs` or the scanner was run one file at a
time with `NODE_V8_COVERAGE` set. Each raw report holding the scanner's URL was then classified by
whether its `source-map-cache` maps it. 507 tests passed and 0 failed. 32 of the 1,018 reports were
native and 88 were mapped. Every other file either had no native report or also produced a mapped
report of the scanner:

| Suite (alone) | Native reports | Mapped reports | Spawn that loads the scanner natively |
| --- | ---: | ---: | --- |
| `test/a-precheck-child-loads-each-source-file-once.test.ts` | 1 | 0 | test "W1-T6180: a plain node precheck still loads test-slot through tsImport": `child(..., [], PRECHECK_PROBE, "", true)` runs `node --enable-source-maps -e 'await import(".../scripts/census-precheck.mjs")'` with `NODE_V8_COVERAGE` set to the suite's own directory (`collectInSuiteCoverage = true`) |
| `test/ci/a-timed-out-fix-round-precheck-child-is-not-measured.test.ts` | 7 | 0 | `src/run-task.ts:11192` / `:11215` spawn `process.execPath scripts/census-precheck.mjs`, with an env copied from `process.env` that keeps `NODE_V8_COVERAGE` |
| `test/a-dispatched-build-runs-its-git-off-the-daemon-loop.test.ts` | 2 | 0 | the same `src/run-task.ts` census-child spawns (INFERRED from the report shape; each report's entry script is `scripts/census-precheck.mjs`) |

OBSERVED: each of those three suites, run ALONE under the coverage shard's exact command (the
`node --enable-source-maps --experimental-test-coverage --test-coverage-exclude="test/**" ...
--test-reporter=lcov ... --test --import tsx --import ./test/setup/tmp-hygiene.ts` line from
`.github/workflows/ci.yml`), writes this into its shard LCOV:

| Suite | `FNH` | `DA:20` | `DA:23` | `LH/LF` |
| --- | ---: | ---: | ---: | --- |
| the plain-probe test above, alone (`--test-name-pattern`) | 0 | 1 | **1** | 88/130 |
| `a-timed-out-fix-round-precheck-child-is-not-measured` | 0 | 7 | **7** | 88/130 |
| `a-dispatched-build-runs-its-git-off-the-daemon-loop` | 0 | 2 | **2** | 88/130 |
| control: `test/rules/trust-root-hidden-text-census.test.ts` (tsx import) | 11 | 0 | absent | 102/130 |
| control: plain-probe file + census test in ONE shard | 12 | 1 | absent | 125/130 |

OBSERVED: when a shard runs a native-only suite and **no** suite that loads the scanner through tsx,
its LCOV carries a positive `DA:23` and `FNH:0`. When one shard runs both, `DA:23` disappears from
that shard's LCOV.

INFERRED, the historical shard: **shard 8**. The run's shard logs (quoted in the task record) give
shard 8 alone `0%` functions for `trust-root-text.ts`. `FNH:0` is the measured signature of a shard
whose only scanner loads are the native children above. Shards 4, 5 and 7 report 100% lines.
Shards 2 and 6 report lines 1–20 uncovered, the tsx-only shape (the census control's `DA:1..20` are
all 0). This is consistent, not proven: a tsx-only shard that calls no scanner function would also
show `FNH:0`, and it would not carry `DA:23`. Only shard 8's `lcov.info` can settle it.

INFERRED, the historical process: a native-shaped child from one of the three suites above, most
likely the plain-probe test's `[eval1]` child or a `src/run-task.ts` census-precheck child.
`reportSuiteIdentity` cannot name it from the uploaded artifact. Its `raw/` directory is the
`--premap-output` translation, which drops `test/**` scripts and the original report names (see
`writePremappedCoverageDirectories`, `scripts/coverage-merge-ratchet.mjs:757`). Shard 8's LCOV
plus its `coverage-duration-shard-8` file list (which names the test files the shard ran) would settle
which of the three it was.

OBSERVED, a counterfactual that does not match the run: the shard split is weighed by
`coverage/ledger-snapshot.manifest`, which is a downloaded artifact. Weighing it by the committed
`scripts/test-tier-coverage-manifest.json` instead (`test-tier-manifest.mjs --select-all --shard N/12
--workers 3`) puts the three native-only suites in shards 9, 4 and 10 on the failing tree
(`git merge-tree e746d8ffa 14174986b`). Each of those shards also holds 2–5 suites that load the
scanner through tsx, so that split would not fail. The real split therefore differed from it.

INFERRED, why the re-run after merging main (`c874b33e0`) passed: the failure needs a native-only
suite in a shard with no tsx loader. That outcome turns on which files the duration packer puts
together. Merging main changed the test-file list (the committed-ledger split moves shard 9 from 322 to
334 files) and probably the ledger snapshot. So the native-only suites most plausibly landed beside a
tsx loader. Nothing in the gate changed. This also explains why the PR's own two files, which never
touch the scanner, could trip it.

## Why the aggregate has no line 23

OBSERVED, in pinned Node's `internal/test_runner/coverage` (read through
`process.binding('natives')`): `mapCoverageWithSourceMap` calls `markTypeScriptOnlyLines` for every
source a mapped report names. That function strips types from the file. Each non-blank line that
becomes blank (here line 23, `import type { RepoLayout } from "./repo-layout.js";`) gets
`ignore = true`. The flag lands on the line objects that `getLines` caches **per source URL**. The URL is
the same for the native and the tsx shape, so one mapped report marks the line for every report of that
file. `summary()` keeps only `!line.ignore` lines in `file.lines`, so line 23 gets no `DA` record,
although Node still counts it as covered in its totals.

OBSERVED, in `scripts/coverage-merge-ratchet.mjs`: `mergeRawCoverageDirectories` (line 885) folds every
shard's reports into ONE `TestCoverage` collector, so a single line cache spans all 12 shards. All 12
shards also hold suites that import the scanner through tsx. For premapped shards,
`premappedReports` replays the recorded line state, setting `lines[index].ignore = true` (line 859).
`raiseProcessLineHits` (line 574, W1-T9481) raises counts only on lines already in the summary; it never
adds one. `mergeShardLineHits` (line 177) then finds a positive shard `DA:23` with no aggregate line,
and throws at line 221.

OBSERVED, the order does not matter. The real CLI (`--output ... --shard-count 2 --line-lcov ...`) ran
over two premapped shards built with the CI commands. Shard A was the plain-probe test; shard B was the
tsx census suite:

| Inputs (raw dirs and `--line-lcov` in this order) | Result |
| --- | --- |
| A, B | exit 1, `shard LCOV reports a positive hit outside aggregate source src/lib/trust-root-text.ts:23` |
| B, A | exit 1, the same message |
| A alone (positive control: the line is listed when no mapped shape exists) | exit 0, `DA:23,1` |
| raw A + raw B, with B's LCOV given twice (A's process hits without A's LCOV) | exit 0, `processLineHitsRescued=23/1 mixedShapeFiles=1` |

INFERRED: the ignore flag is only ever set to `true` (by Node's classifier and by the premapped replay),
and it is read once in `summary()`, after every report has been merged. So no report order can restore
line 23 once any report in the 12 shards maps the file. The refusal depends only on **which suites
share a shard**, not on read order.

OBSERVED, a latent sibling: `scripts/census-precheck.mjs:35` loads `src/lib/rule-suites.ts` the same
native way. In the plain-probe shard its type-only lines read `DA:7,1 DA:9,1 DA:23,1`, so the same refusal
can fire on `src/lib/rule-suites.ts` once its tsx loaders and a native-only suite are split apart.

## Recommendation

INFERRED: one fix task, **load the two `.ts` modules that `scripts/census-precheck.mjs` imports through
tsx even when the precheck itself runs under plain Node**, so that every process reports them in the
mapped shape.

- Files: `scripts/census-precheck.mjs`, and one test in the folder `rmd test-place` computes (extending
  `test/a-precheck-child-loads-each-source-file-once.test.ts` fits, since it already drives the plain,
  CLI, env and registered loader modes).
- Change: replace the static `import ... from "../src/lib/trust-root-text.ts"` (line 34) and
  `"../src/lib/rule-suites.ts"` (line 35) with a top-level `await` of the same `tsImport(url,
  import.meta.url)` route that `defaultImportTestSlot` (line 613) already uses for `test-slot.ts`.
  When tsx is already active, keep a plain import, so the module is not compiled twice (the W1-T6180
  property that file's first test asserts).
- Proof it needs: (1) a plain-Node precheck child's V8 report maps both files (a `source-map-cache`
  entry), and in all four loader modes each file appears once. (2) The real merger, given a
  plain-probe shard and a tsx shard, exits 0 in both orders, raw and premapped. (3) A negative
  control keeps the refusal: a hand-built shard LCOV with a positive `DA` on a line the aggregate
  lacks is still refused with the same message. (4) Removing the loader change turns test (2) red
  again.

INFERRED: what it changes in what the gate counts. It keeps the refusal, the thresholds, the
exclusions and the merge unchanged. It does change two files' aggregate **line** figures. Today the
native-shaped processes are the only reason the header comments of `trust-root-text.ts` read as hit:
`DA:1..20` are 1 in the mixed aggregate (`LH:125/130`) and 0 in the tsx shape alone (`LH:102/130`).
After the fix, these two files are counted on the same mapped basis as every other `src/**` file that only
tsx loads. The aggregate's line hits for them fall once by about their header length. The coverage
ratchet's floor is on **branch** coverage (its step: "blocks a PR whose branch coverage is below the
absolute floor"), and a comment line holds no branch, so the floor should not move. `diff-coverage`
reads only the fix PR's own added lines.

INFERRED, the rejected candidates. (b) Building the aggregate's line list as the union across shapes would
put type-only lines back into `DA` records. That changes every mixed-shape file's line inventory and needs
a rule for which shape's count wins. (c) Dropping shard hits on lines the aggregate classifies as type-only
changes no aggregate count, because no `DA` exists for them. But it loosens this refusal, so it needs the
operator's yes before it is built. Neither is recommended while (a) removes the producer of the conflict.

### Reproduction

OBSERVED: run from the checkout root, with every artifact written under a private `$TMPDIR` directory.
`shard.sh <dir> <test args...>` runs the coverage shard's instrumented command with `NODE_V8_COVERAGE=<dir>/raw`,
then `node --expose-internals scripts/coverage-merge-ratchet.mjs --premap-output <dir>/artifact/raw <dir>/raw`,
then copies the LCOV beside the premap, as the "Stage this coverage shard" step does. Then:

```bash
shard.sh "$S/A" --test-name-pattern="a plain node precheck still loads test-slot" \
  test/a-precheck-child-loads-each-source-file-once.test.ts
shard.sh "$S/B" test/rules/trust-root-hidden-text-census.test.ts
node --expose-internals scripts/coverage-merge-ratchet.mjs --output "$S/out.lcov" --shard-count 2 \
  --line-lcov "$S/A/artifact/lcov.info" --line-lcov "$S/B/artifact/lcov.info" \
  "$S/A/artifact/raw" "$S/B/artifact/raw"
# exit 1: shard LCOV reports a positive hit outside aggregate source src/lib/trust-root-text.ts:23
```

### What would settle the inferred parts

- Shard 8's `lcov.info` (`DA:23` positive) and `coverage-duration-shard-8` (its file list), read from a host
  whose egress reaches the Actions blob store. They name the supplying shard and the one native-only suite
  it ran.
- FALSIFIER for the recommendation: if a shard holding none of the three native-only suites still carries
  a positive `DA:23`, another native loader exists outside the 66-file census, and loading the
  precheck's imports through tsx would not be enough.
