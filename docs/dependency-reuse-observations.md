# Dependency reuse observations

Enabling an account's existing dependency-seed configuration already routes new
worker provisioning, synchronous/asynchronous review priming and hand worktrees
through the maintained seed implementation. It does not rewire existing installs,
replace occupied links or restart a service. Git hand worktrees already share
their repository's common object store; do not create a standalone clone per PR.

Each new materialization now adds a small, versioned provisioning observation to
its existing private consumer registration: the copy method and whether that
call installed the seed generation. There is no extra receipt file or timer.
Repeated work in one unchanged generation can reuse it. Changed lock inputs,
runtime, platform or install policy can legitimately require a new generation;
an install observation alone is not a defect.

Inspect the current account's registered observations without changing them:

```sh
node scripts/dependency-seeds.mjs report
```

The report is bounded to 256 generations, 10,000 store entries and 5,000 consumer
registrations. It refuses linked/public/unbounded metadata and distinguishes
legacy observations and foreign mount namespaces from known provisioning. A
partial or empty cohort has a null reuse rate, not a fabricated perfect score.
Fresh installs are counted by generation, not once per workspace child.
Failure samples preserve their registration, generation or store scope and the
underlying reason. At most eight are retained in a report; `failuresTruncated`
explicitly marks additional failures, while unknown counts and null rates remain
unchanged. A bounded sample is not a claim that no other failures occurred.

This is a snapshot of registered provisioning metadata. It is not all-time job
history, a payload-byte attestation, a complete filesystem-reference census,
measured disk savings, permission to prune a seed or approval to narrow tests.
The `report` command rejects `--apply`; generation cleanup still needs its own
six-hour, ownership, reference and administrator open-file checks.

Keep account stores private. Qualify new-worker adoption separately from source
tests and hosted CI. Source publication does not change live workers, reviews,
serving, fleet settings or the gated runtime pilot.
