# Mutation-runner predecessor for PR12776

The rule-checks job for head `aa9df30aae2508127d052dbb6207c027cd5c8e2f`
reported one failure among 38 mutation-ratchet cases: its classifier regression,
`test/ci-friction-remedy-8cfe5bc13ae74a09.test.ts`, was absent from Stryker's
command runner. The worker correctly refused to mix an instrument edit with its
`src/` change. This is an instrument-only predecessor, not a scope waiver.

Add that one prospective test path to the runner and its matching mutation-trigger
data. Preserve all eight prior paths, the exact-population positive control, the
mutated source scope, every score threshold and the runner's arguments. The
positive control now names the nine configured entries explicitly; it is not
relaxed into a subset check. No product or acceptance record is changed.

The existing mutation-ratchet contract deliberately permits a runner entry to lead
its test by one PR, so instrument and product changes remain separate. Until the
product test lands, this entry runs no new assertions. A successful run of the
existing suites is not evidence that the prospective test executed or that
PR #12776's other failures are repaired.

The held, attribution-ambiguous W1-T10129 is not activated or credited by this
predecessor. Normal hosted checks, native review and protected automatic merge
remain required for both changes independently.
