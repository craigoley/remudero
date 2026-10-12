- **Before your FIRST push (not every commit), run `node --import tsx scripts/preflight-author.mjs` on the
  committed tree; required hosted checks still gate merge.**

The hand route previously paid for a full instrumented suite locally and again in GitHub. Its
20-GiB scratch admission requirement made a source change depend on Mac disk capacity, even when
the relevant tests needed no coverage collection. The frozen earlier rule (kept verbatim at the end of this file) is historical;
this post-migration rule supersedes its first-push **full-parity** obligation.

Commit first, then run `node --import tsx scripts/preflight-author.mjs` before the first push. The script refreshes and
pins `origin/main`, verifies the committed tree and each selected test path, checks the shipped
cheap census before expensive validation, runs default static preflight and the module-level affected floor, and refuses missing/zero test
summaries. Configuration, dependency, workflow, fixture/helper, unknown and empty-floor changes
fall back to every suite, without full-suite coverage instrumentation. A failing test is not
retried into a green verdict. An unsuccessful static gate stops before affected tests: the receipt cannot
pass, retains the selected floor and native static outcome, and explicitly records why tests were not run.
Use the full-parity commands below when deliberately collecting further diagnostic evidence.
Keep the receipt in `coverage/preflight-author.json`; it records
the exact head/base, suites, reasons, duration and outcomes on failure as well as success.

The selector's symbol-level narrow set remains shadow-only. A highly connected module may select
most of the repository; this is an honest result, not a reason to bypass its dependencies.
`--dry-run` records selection only and never claims verification. Dirty trees, a failed fetch,
an empty diff, a wrong pinned Node version or a tree changed during verification are refusals.
An unreadable census is a refusal; a census violation fails without starting static checks or tests.

**Author PASS is not CI PASS.** Hosted full-suite, source-mapped aggregate/diff coverage, review
and security gates remain unchanged and required before merging. `rmd preflight --ci-parity`
and `--coverage` remain available for full local reproduction; infrastructure, coverage-merger
and test-selector changes should use that full reproduction before their first push. The default
static preflight's small scoped coverage check is also retained, not silently removed.

Regression evidence: `test/author-preflight.test.ts` exercises real Git and Node subprocesses,
including a failing test; `test/merge-lcov.test.ts` compares every LCOV record against pinned Node.
The implementation PR is identified by branch `run-unfiled-1791130203363`.

*(Index line merged 2026-10-11: the superseded W1-T3323 bullet below no longer ships beside its successor; its id resolves here through `doctrine/merged-rules.json`.)*

- **Run the shipped local gate before your FIRST push, not every commit.**
  `rmd preflight --ci-parity` (W1-T294, `src/lib/ci-parity.ts`) shells CI's OWN commands, one
  entry per `.github/workflows/ci.yml` job -- its `ci` entry runs `npm run test:ci`, the SAME
  full-suite command the coverage-ratchet job runs, so a green run is the real signal, not a
  scoped approximation. Run the gate itself, never a proxy for what it does -- the next local
  check this repo adds inherits this rule too. *(W1-T294, W1-T338)*
