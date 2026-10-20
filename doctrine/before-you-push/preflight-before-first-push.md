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

When the publication destination is known, add `--head-ref <destination branch>` (short name or
`refs/heads/...`) and optionally `--head-sha <full committed HEAD sha>`. Use the destination from
the intended push refspec, even when the local branch is named `codex/...` or `claude/...`.
For example, validation for `git push origin HEAD:run-unfiled-1792152000000` uses
`node --import tsx scripts/preflight-author.mjs --head-ref run-unfiled-1792152000000`.
This runs `head-identity-gate`'s predicate on the committed author message and fresh-base diff before
selection, dependency checks, census, slot admission, static checks or tests. A mismatched
`--head-sha` refuses: this run can certify only its committed HEAD. No trailer is invented and
no branch or commit is rewritten. Revalidate if the publication destination or head changes.

Before a destination is known, omit `--head-ref`: ordinary author validation continues, but
`publicationIdentity.state` is explicitly `unknown-target`, never an identity PASS. A successful
author receipt without a known target is not publication-identity assurance. The existing
`hooks/pre-push` identity advice and narrow identity-loss refusal are unchanged; its first-push
advice is not a substitute for supplying the actual destination here.

No automatic consumer currently supplies the target to this entry point. Treat this as fail-fast
plumbing with measurement scoped to explicitly supplied targets, not as a guarantee that publication
identity errors are impossible. Automatic target wiring and its qualification remain separate work.
The paired real-Git fixture in `test/author-publication-identity.test.ts` models the #12409 repair:
the same `codex/...` destination and code tree refuse without a trailer and admit after a new commit
carries the fixture-only `Remudero-Task: PR-12409` trailer.

Publication-identity falsifier handoff (execution belongs to the main agent's admitted Azure run):

- The default fixture subject is the real author module. Only the test suite reads
  `RMD_TEST_AUTHOR_PUBLICATION_MUTANT=remove-early-refusal`; it imports a disposable copy under
  `test/mutants-*/` using the existing mutation helper. Exactly one early refusal block is removed
  from `main`; the pure identity helper, its call, the identity receipt and every assertion stay.
  A changed mutation target or an unknown mode refuses the fixture setup. Production files and donors are not
  written, no slot is acquired by this helper, and its copies use the existing exit cleanup.
- Run control, mutant, then restored control with the SAME five named cases below. Expected:
  controls execute five cases with `# fail 0`; mutant fails the code-destination refusal and
  PR-number repair cases because a refused identity now reaches selection and returns success.
  The admitted run destination, unknown target and direct pure-helper merge case must still pass.
  A setup/import crash, missing TAP summary or unexpected failed title is not this falsifier.
- Save each leg's output separately in a new receipt directory. Keep the mutant JSON marker
  (`removedBlocks: 1`, source/mutant digests and `helperPreserved: true`), exact commit, physical
  suite path, TAP summaries/titles, before/after source/donor identity, and the main run's genuine
  admission/release evidence. Preserve earlier receipts. No stock author run or Mac execution.

```sh
publication_cases='^author publication identity (admits the actual run destination|refuses a code destination|admits the same codex destination|leaves an unknown target|reads only the exact head)'
publication_argv=(--test --test-reporter=tap --test-concurrency=1 --import tsx --import ./test/setup/tmp-hygiene.ts "--test-name-pattern=$publication_cases" test/author-publication-identity.test.ts)
env -u RMD_TEST_AUTHOR_PUBLICATION_MUTANT NODE_V8_COVERAGE= node "${publication_argv[@]}"
env RMD_TEST_AUTHOR_PUBLICATION_MUTANT=remove-early-refusal NODE_V8_COVERAGE= node "${publication_argv[@]}"
env -u RMD_TEST_AUTHOR_PUBLICATION_MUTANT NODE_V8_COVERAGE= node "${publication_argv[@]}"
```

Focused coverage selection: the full nine-case `test/author-publication-identity.test.ts`, in a
separate CONTROL-only instrumented run, with `scripts/preflight-author.mjs` and
`scripts/head-identity-gate.mjs` included and `test/**` excluded. Use Node's
`--experimental-test-coverage`, TAP plus LCOV reporters and a fresh output path. Prove both exact
`SF:` records are present before reading line hits; bind LCOV and diff to the same committed tree.
Never merge mutant coverage into that record. This selection measures this repair's branches,
not the whole author pipeline, hosted CI or an automatic production consumer.

Tracked-source call-site census at `97694b5e7055a4f99a7446ccd9cc5ddc43ff4e62`:
820 tracked entries under `.github/`, `hooks/`, `scripts/`, `src/`, `bin/`, `.claude/` and
`package.json` (9,721 tracked entries overall). Literal caller searches have positive controls:
`scripts/calibrate-author-runtime.mjs` imports only `authorEnvironment`/`completeTestResult`,
and `scripts/lib/author-workflow-contract.mjs` names the path as an input; the compaction/provider
mentions are commentary. There is no production caller of the new identity helper or author
entry point supplying `--head-ref` in this source census. `src/lib/git-push.ts`'s
`prePushGateSteps` supplies refspec-derived stdin to `hooks/pre-push` when hooks are configured.
That hook sends the target to `head-identity-gate.mjs` (advisory first-push check),
`worker-branch-shape.mjs` (also the selected
SHA), and `proof-resolve-precheck.mjs`; it does not call `preflight-author.mjs`. The narrow
identity-loss transition remains separately blocking. External wrappers/live execution were not
inspected, so this is a repository-source census, not a claim about all possible callers.

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

### Explicit low-footprint local checks

Operator-approved 2026-10-17: the Mac may run an explicitly scoped check below the ordinary
20-GiB reserve without pretending it completed ordinary author validation:

```sh
node --import tsx scripts/preflight-author.mjs --low-footprint --scratch-mib 256 --timeout-ms 120000 --head-ref run-unfiled-<epochMs> --test test/<literal-file>.test.ts
```

Choose the scratch/runtime budgets for the named work; the example is not a policy default.
This opt-in Mac path requires a committed tree, fresh base, physical tracked files, publication
identity, a test slot, normal native memory pressure and room for the bounded image plus retained
output. It runs serially with no discovery/full-suite fallback. A fixed-capacity disk image bounds
fixture growth, and an inherited native sandbox denies writes outside it, dependency payload
writes and networking. An incompatible test fails; it is not silently rerun unsandboxed.

The separate `coverage/author-low-footprint-*/receipt.json` records `scoped-pass`, never full-author
PASS. Default static/affected selection and full-author assurance remain NOT RUN; hosted full-suite,
coverage, review and security gates remain required, unchanged. Ordinary author validation retains
its 20-GiB guard. Capture is output/runtime bounded, source is rechecked afterwards, and failed
detach retains the scratch and refuses the run rather than deleting a possibly active volume.
This is local write/resource containment, not a security boundary for hostile test code or a
host-wide storage reservation; other sessions' writes and OS swap remain separate pressure.

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
