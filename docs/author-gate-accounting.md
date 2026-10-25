# Whole-gate cost and dependency provenance

The author gate checks installed dependency metadata and real tool bytes before
expensive validation, then checks the same donor again after static work and at
closure. A vanished or changed symlink donor invalidates the receipt. This is a
cheap precondition, not full package byte attestation or cached-test permission.

For an opt-in setup check before expensive work, run
`node scripts/check-author-checkout.mjs --head <committed-sha> --upstream https://github.com/craigoley/remudero.git`.
An optional `--bundle <path> --bundle-head <sha>` checks the actual advertised
refs (including a HEAD-only bundle) and Git's prerequisite verification. The
diagnostic does not fetch, import a bundle, change refs/config, install packages,
take capacity or execute tests. Ready (exit0), blocked (exit3) and unknown (exit2)
describe local metadata only, never fresh upstream, author assurance or execution
authority. Normal fresh fetch, genuine admission and current-head gates remain.

The shared subprocess envelope uses one process-local monotonic start, charges
elapsed time once, floors fractional milliseconds to a valid integer and refuses
an exhausted/zero timeout. It never converts exhaustion into Node's unbounded
timeout0 or silently starts a new deadline for a later subprocess.

Closed capture records include monotonic duration for census, static and test
phases, including failures. The final receipt separates native work from selection
and admission overhead. Partial/over-capacity runs are ineligible for whole-gate
training; Mac observations do not qualify Azure or a full model evaluation.

When the committed diff changes docs-index inputs (including removed Markdown),
the generator, its workflow or package scripts, the author gate first executes
the same hosted freshness and path commands. Each has a 30-second backstop and
closed diagnostics. A stale/unavailable result refuses before claiming a heavy
slot or starting static/tests; the gate never regenerates or commits output.
Unrelated source/image changes do not trigger these two extra checks. Their real
cost remains included in phase accounting, not hidden as zero-cost cache work.

No gate is removed, no cache result is trusted, no threshold or worker limit is
changed. Source-mapped coverage and population/census obligations remain. Cache
reuse and automated estimate promotion require a separate discriminating proof of
the complete source/toolchain/input closure and bounded drift policy.

Cleanup must protect dependency donors referenced by live views even when no file
is currently open. Six-hour age alone is insufficient. Source, history, dirty or
unpushed work, active readers/writers and unknown provenance remain protected.

## Read-only whole-author planning

`scripts/plan-author-runtime.mjs` estimates the full physical test corpus using
the existing native sample profile plus closed phase evidence from the current
clean source tree. It does not start tests, take a lease, narrow selection, change
worker policy or authorize a gate. It is an opt-in operator diagnostic; existing
author admission and daemon cutoffs are unchanged.

Native timing profiles use format `rmd-native-author-runtime-v2`. Their bindings
include inherited `NODE_OPTIONS` memory settings: only
`--max-old-space-size=<positive integer>` and
`--max-semi-space-size=<positive integer>` are modelled. Changing or removing a
setting invalidates timing reuse; ordering and whitespace alone do not. Duplicate,
malformed, unknown and instrumentation flags still refuse. Older v1 profiles lack
this binding and must be recalibrated under normal admission, not upgraded by
editing their metadata. This does not remove flags, alter memory policy, grant
capacity or turn a sample profile into author assurance.

```sh
node --import tsx scripts/plan-author-runtime.mjs \
  --runtime-profile coverage/rmd-native-runtime-EXAMPLE/profile.json \
  --author-receipt coverage/preflight-author.json \
  --workers 1 --deadline 2026-10-17T23:00:00Z
```

The example paths and deadline are placeholders, not a reusable profile, worker
reservation or grant. Supply the current owned profile, complete author capture
and a fixed future deadline. The tool rechecks source/runtime bindings, native
captures and final test summaries; partial, failed, over-capacity, skipped or
foreign evidence remains `not-measured`, never zero-cost work. In particular, an
otherwise successful Linux run with a platform skip is not whole-gate training
evidence under this conservative contract.

Census, static checks and selection/admission overhead are serial costs: they are
not divided by test workers. Tests are repriced once by the existing estimator;
prior test duration is not added twice. Elapsed time reduces the original fixed
deadline once. A fit exits 0, an estimated non-fit exits 3, and unavailable or
invalid evidence exits 2. None of those exits is an author PASS. Every estimate
keeps `dispatchAllowed`, `capacityGranted`, `authorPassReused` and
`resourceFitQualified` false; a sample-calibrated full-corpus estimate is not a
full-corpus measurement or a guarantee of runtime or resource availability.

The phase reader also checks the physical suite denominator: every named suite
must exist in the current corpus, and the complete judge's given/reported counts,
empty unreported list and absence of a premature exit must agree. A positive TAP
summary alone cannot certify a ghost or unfinished file list.
