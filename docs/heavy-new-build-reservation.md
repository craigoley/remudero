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

Records are complete directory envelopes named `heavy-build-<id>[-closed|-delivered].json`,
each containing a single `record.json`. A private unique staging directory is fully
written/flushed before one directory rename publishes it. Every cooperative writer
publishes a nonempty final envelope, so POSIX rename refuses replacement; concurrent
writers read the first complete winner. There is no empty final-path claim that a
killed writer can strand. Existing corrupt/empty envelopes remain UNKNOWN, never
silently repaired or migrated. Abandoned unpublished `.heavy-ready-stage-*` directories
are retained bounded census entries; the reader never deletes them or another writer's
record. Normal publication removes only its own unique staging directory.

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

An escalated terminal record is also an outbox entry. Notification delivery uses the
stable event id `<request-id>:escalated`. A delivery acknowledgement is published only
after the sink returns successfully. A throw/crash before acknowledgement is retried
on a later read/restart, and **does not reopen the hold**. This is at-least-once delivery,
not exactly-once: sinks must deduplicate by event id, and a sink that returns before
durably accepting its event cannot claim durable external delivery. The receipt only
certifies this API's successful sink call, not a human notification or finished gate.
Thenable/async sink returns are not acknowledged: delivery requires synchronous durable
acceptance, or the escalation stays pending for a supported sink to retry.

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
