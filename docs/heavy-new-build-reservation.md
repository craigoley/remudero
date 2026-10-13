# Bounded heavy READY reservations, v2

This is an **opt-in, host-local, single-account** reader/producer foundation, not a
live fleet rollout. The explicitly supplied `dir` must name a pre-existing canonical private
directory owned by the consumer account (0700; regular single-link records 0600).
An absent `dir` disables the adapter. An explicitly configured missing, malformed,
unreadable, oversized or incomplete store is UNKNOWN, never an empty observation.
The adapter throws a named observation error for the caller to defer NEW admission.
It does not write PAUSE, QUIET_HOURS, STOP, restart containers, kill work, change
worker counts, acquire slots or produce a test verdict.

The shared world-writable test-slot directory is deliberately **not** the default.
A nonce and a content hash correlate records; neither authenticates a shared writer.
Cross-account/container readers and network filesystems are not an approved backend.
The earlier v1 flat files and experimental SQLite journal are not auto-migrated.

Records are complete directory envelopes named `heavy-build-<id>[-closed|-delivered|-escalation].json`,
each containing a single `record.json`. A private unique staging directory is fully
written/flushed before one directory rename publishes it. Every cooperative writer
publishes a nonempty final envelope, so POSIX rename refuses replacement; concurrent
writers read the first complete winner. There is no empty final-path claim that a
killed writer can strand. Existing corrupt/empty envelopes remain UNKNOWN, never
silently repaired or migrated. Abandoned unpublished `.heavy-ready-stage-*` directories
are retained bounded census entries; the reader never deletes them or another writer's
record. Normal publication removes only its own unique staging directory.

A failure after rename (parent-directory flush or staging cleanup) can report a
refusal even though a complete winner is already visible. Recovery reads that
unchanged winner; it never rolls back publication or renews READY. A producer retry
returns `owned: false`, not a newly releasable grant, so the original fixed expiry
remains the recovery bound when the minting call lost its handle. Native process
interruption and injected post-rename I/O failures are tested; power-loss persistence
is not claimed as a tested outcome.

## State and recovery

The logical identity publishes one immutable request. READY time and its expiry
(`READY + 60 minutes`, the approved escalation SLA) cannot be renewed by heartbeat,
repair or producer restart. Owner release requires the original nonce plus the actual
process PID, birth, host and PID namespace. Expiry ignores whether that owner is alive.
All requests and receipts remain on disk; no cleanup or archival runs in this API.

There is **one** immutable terminal record per request: released before expiry, or
escalated at expiry. A completion at/after expiry records escalation, never hides it
as release/success. A terminal record is consulted before wall-clock validation, so
clock rollback cannot revive a completed hold. A future unclosed READY time is UNKNOWN.

An escalated terminal record is also an outbox entry with stable event id
`<request-id>:escalated`. A void, false, promise or forged sink return cannot acknowledge
it. `heavyReadyEscalationSink` fsyncs an immutable `-escalation` inbox envelope and its
parent before returning an explicit event/hash-bound ACK. The reader independently
reads that envelope before recording `-delivered`. Old ACKs without a durable inbox
receipt are retained but retried, not trusted or deleted. Post-rename flush failures
are retried before acknowledgement. This certifies durable LOCAL inbox acceptance,
NOT human notification, remote delivery, a finished gate or available capacity.
A throw/crash before ACK retries the same event without reopening the expired hold.

The independent deadline worker requires a SEPARATE opt-in:
`RMD_HEAVY_READY_DEADLINE_SERVICE=1`, captured once at natural startup with an explicit
private READY directory. Unset remains OFF, including for an already-configured gate.
No configuration is activated by publication. Its own thread scans even when the
main loop blocks or no NEW admission occurs, recording the original READY60 expiry,
not a fresh retry deadline. A missing, crashed, stopped or stale worker is UNKNOWN
at the NEW-only gate. The discovery/retry cadence (1 s) and silence backstop (5 s)
are proposals, not replacement deadlines or measured capacity. The thread is unref'd;
process exit is recovered by the next opted-in startup from immutable records.
It never runs model attempts, acquires capacity, consumes grants, cancels active
fleet work, changes worker limits or notifies GitHub. `stop()` closes only its own
thread. Core adoption still requires consumer/backend and native qualification.

Closure's logical time is sampled at the API call; the publication winner is selected
at the atomic envelope rename. Pre-deadline release can race with expiry: the first
complete terminal wins, and the loser never overwrites it. `release` returning true
means an owned closure was recorded/observed, not that the run passed or that the
winning closure was `released`; expiry or late completion can win `escalated`.

Descriptor reads reject symlinks, FIFOs, unsafe permissions, hardlinks, concurrent
growth and records over 4096 bytes. The streaming census rejects malformed reserved
names and orphan receipts. It permits more than 256 closed historical requests;
only open requests count against the 256-active backstop. A 16,384-entry census
backstop produces UNKNOWN and requires separately governed archival. Neither limit
pretends to measure worker capacity. No active or closed record is automatically deleted.

## Publication and rollout sequence

1. Publish/validate this foundation, including real default-reader failure controls.
2. Register an explicit configuration setting and wire its callback at NEW implement admission boundaries only, with per-lane and
   post-async-refill rechecks. Tick-level retro, triage, review, SRE and serving gates
   must not consume it. Active workers settle without cancellation.
3. Verify all relevant consumers and the chosen trust/filesystem boundary in a fresh
   runtime session before allowing a producer to activate a hold. Missing consumers
   or cross-UID access are a refusal, not permission to use the shared cache instead.
4. Obtain separate live rollout authority. Retain all earlier READY/refusal histories;
   do not reuse expired 45/105/180-minute author grants or invent available workers.

The producer remains an explicit API, not automatic preflight wiring. Calibration,
test selection, author/hosted gates, PR merge, deployment and observed live benefit
are distinct evidence. Self-improvement should consume closed, identity-bound run
receipts; it must not derive new admission budgets from notification success.

Design references: [AWS transactional outbox guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)
explains the dual-write gap and idempotent consumers;
[SQLite network filesystem guidance](https://sqlite.org/useovernet.html) documents
why the private journal pilot is not silently made a shared fleet default.
The [POSIX rename contract](https://pubs.opengroup.org/onlinepubs/9799919799/functions/rename.html)
specifies refusal of nonempty target directories. The interruption/race regressions
verify this publication boundary with the actual native filesystem and fresh processes.

## Whole-run cancellation and capacity preparation (OFF)

The optional `SkillEvalControlInput` captures one fixed finish/shutdown boundary for
the whole attempt loop, propagates cancellation to the sealed dispatcher's SDK call,
and stops further attempts. Cancellation during grading/cleanup never becomes a
judged proposal. Its result explicitly says `capacityReleaseAllowed: false`:
cooperative SDK settlement cannot certify synchronous setup, graders, or escaped
descendants gone. No production configuration supplies this control today; the
existing CLI retains its quiet/spend gates.

`createOwnedRunCgroup` is separately OFF by default. An enabled caller must be inside
its OWN `rmd-heavy-run-<UUID>.service` with an explicitly delegated existing cgroup
parent, never the daemon, serving, SSH or another service's group. It creates only a
private unique leaf. A child bootstrap joins ITSELF before dependencies, SDK calls,
probes, grading and cleanup. The supervisor never migrates a foreign PID or itself.
`cancel()` writes only that identity-checked leaf's `cgroup.kill`; the kernel includes
detached process groups and nested cgroups. An unobserved empty group is unqualified,
not a positive termination measurement.

Capacity binds one ORIGINAL fresh published canonical memory-ledger handle to that
bootstrap child. Already-active, foreign, missing/reset or unreadable reservations
cannot be borrowed. Release requires a positive populated-to-empty observation plus
verified removal by the canonical ledger. UNKNOWN retains capacity and its history.
This is cooperative single-account containment, not authentication or a migration
sandbox against another writer of the same account.

The cheap real-kernel rehearsal on existing Azure user-manager capacity killed a
detached descendant and released only its original private lease. It is NOT a closed
full-EVAL calibration or permission to run models. Automated admission remains OFF
pending fixed service-deadline validation/survival, atomic one-use grant consumption,
full-EVAL native cost/resource receipts, migration containment, consumer/backend
qualification and a fresh pilot grant. No user-manager unit is created by this library.
The original READY60 and all earlier failed/closed gates remain intact.

Kernel reference: [cgroup v2 control files](https://docs.kernel.org/admin-guide/cgroup-v2.html)
define whole-tree kill and the `populated` witness. Hosted tests, review, source merge,
natural safe startup adoption and live benefit remain separate claims.
