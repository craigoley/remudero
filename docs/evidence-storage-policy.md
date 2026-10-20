# Bounded storage proposals, not deletion authority

`node scripts/evidence-storage-policy.mjs --manifest /private/owned/storage-observation.json`
reads one account-private JSON manifest (at most 1 MiB and 1,000 rows). It never walks artifact
paths, removes a file, installs a schedule, starts work, changes an admission guard or enables a
pilot. Exit 2 means UNKNOWN. `--apply` is not implemented. An omitted `enabled` is default-off.

A version-1 manifest supplies `observedAtMs`, `enabled` and `rows`. Each row has an opaque `id`,
`kind`, `outcome`, `mtimeMs`, `ctimeMs`, `sizeBytes` and explicit `ownerVerified`, `closed`,
`unusedVerified`, `unreferencedVerified`, `regenerableVerified` booleans. Only a passed
`regenerable-cache` with BOTH timestamps six hours old and all safety observations true can be
proposed for a fresh executor recheck. Observations expire after 60 seconds; future times refuse.
Durable evidence and failed/refused/incomplete results are retained regardless of age. Dependency
generations require an administrator-wide recheck, never an ordinary account's absence claim.
This input is an operator-supplied observation, not cryptographic proof of liveness or permission.

Optional `producer` fields are nonnegative safe-integer bytes: `availableBytes`, `reservedBytes`,
`estimatedScratchBytes`, `estimatedOutputBytes`, `minimumReserveBytes`, `maxCaptureBytes`. The
proposal refuses if scratch, output, reservations and the caller's unchanged reserve do not fit,
or output exceeds its capture budget. Missing/overflowing numbers remain UNKNOWN. FIT_PROPOSAL
still requires native admission; it never reduces the maintained 20-GiB full-author reserve.

`measurement` requires `kind: observed`, a named `source`, `positiveControlPassed: true`, and
`beforeFreeBytes`/`afterFreeBytes` before reporting an observed delta, which may be negative.
Estimates stay estimates, missing data stays null, and automatic promotion remains false.
The exported bounded capture retains a prefix but irreversibly marks overflow incomplete.

Raw generated caches can have finite retention after source qualification and fresh executor
checks. Durable manifests, dispositions, failed receipts, source/history and unpublished work
do not inherit cache expiry. GitHub artifact retention is a separate reviewed workflow choice;
short-lived coverage-transfer artifacts must not be the only retained proof of a failed gate.

The design follows Node's [descriptor reads and directory APIs](https://nodejs.org/docs/latest-v24.x/api/fs.html)
and GitHub's [explicit per-artifact retention](https://docs.github.com/en/actions/tutorials/store-and-share-data).
Neither API supplies ownership, liveness or cleanup authority; those observations remain explicit.
