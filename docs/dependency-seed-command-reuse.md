# Immutable command reuse and owner cleanup

Commands that use an existing dependency generation can repeat `prime CHECKOUT`.
It verifies the checkout's exact lock, workspace manifests, Node/npm runtime and
install policy before returning `present`; it does not install or copy another
tree. A fresh consumer with identical inputs borrows the same seed. Linux command
consumers use read-only package links, Linux proof consumers use private writable
copies, and macOS consumers use private copy-on-write clones. Proof policy has its
own identity. Existing unregistered installs retain their existing package checks
without gaining a generation attestation.

Both occupied consumers and new borrowers now reject a seed with writable payload,
foreign ownership or a link escaping its generation. Refusal leaves the occupied
checkout and seed untouched. It does not repair a shared generation in place or
retry with a private install. Local caches stay private; priming does not allocate
per-command npm or browser caches. Generation GC retains its separate six-hour,
reference, locking and open-file requirements.

The standalone dependency CLI also offers explicit owner scratch allocation. It
creates a **new** private directory and a pinned `payload` child; it cannot adopt
an existing tree, seed store or checkout. Choose a private canonical parent
outside checkouts and stores, and list every consumer PID:

```sh
node scripts/dependency-seeds.mjs allocate /private-parent/job-123 \
  --owner job-123 --kind coverage --consumers 12345,12346
```

Kinds are `coverage`, `v8`, `dependency` and `browser`. Only use this for disposable
output, never dependencies lent from a seed or unpublished work. The allocation
returns the payload path and `scratchRoot`, which can be passed directly to
`sampleWorkspaceUsage` in its `scratchRoots` array. That existing observer measures
growth with its unchanged inspection bounds. Neither allocation nor observation
grants permission to retire a checkout or release a cash reservation.

After **all** consumers have exited, save required validation evidence outside the
scratch directory. The owner supplies a private, regular JSON receipt identifying
the scratch and explicitly attesting completion, publication, disposability and
exclusive ownership. An example receipt is:

```json
{"version":1,"owner":"job-123","scratch":"/private-parent/job-123","completed":true,"published":true,"disposable":true,"exclusive":true}
```

The receipt is the producer's attestation, not an independently verified claim
that its outputs were published. Do not attest any uncertain condition. Preview
then apply the bounded cleanup:

```sh
node scripts/dependency-seeds.mjs cleanup /private-parent/job-123 \
  --owner job-123 --receipt /durable/job-123.json
node scripts/dependency-seeds.mjs cleanup /private-parent/job-123 \
  --owner job-123 --receipt /durable/job-123.json --apply
```

Cleanup requires unchanged owner, namespace and directory identities, dead
registered consumers and an exhaustive negative open-file scan before applying.
It uses the existing scanner: accounts lacking a complete administrator scan or
an owner-only macOS home retain their payload with a reason. Preview does not run
the open-file scan and is not deletion authorization. Unknown scan results retain
the payload. Symlinks, hardlinks, other filesystems, special files, Git metadata,
seed markers, state, evidence, receipts, claims, locks and reservations are
protected. Inspection stops at 10,000 entries and never authorizes a partial walk.
The current working directory and its ancestors cannot be removed.

The receipt and its parent are flushed before deletion. A durable
`cleanup-intent.json` records its SHA-256 and observed payload path-block bytes;
identities and inventory are checked again before removal. Successful deletion
renames that intent to `cleanup.json`. A failed or interrupted deletion retains
its intent and must not be called confirmed cleanup. These byte counts describe
observed path blocks, not unique disk savings. The ownership record, both durable
receipts and scratch wrapper remain; only the payload is reclaimed. Existing
records are never overwritten to authorize another cleanup.

This is an explicit producer entry point. It adds no background janitor, automatic
producer migration, service restart, install, worker stop or worktree retirement.
