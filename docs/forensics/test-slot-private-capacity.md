# Staged private ownership / peer capacity protocol

Source-only redesign for #11906. No live path, permission, flag, daemon, review,
serving or infrastructure change is authorized by this document.

The private writer is explicitly opt-in with `ownershipProtocol: "private-capacity-v1"`
at the library call, not an enabled fleet setting. The default writer stays legacy
until reader-first adoption is independently qualified. A default reader that sees
private coordination returns `executionAllowed: false`; all heavy launch boundaries
honor it as NOT_RUN, even without a runtime deadline. Legacy-only fallback behavior
is unchanged. A source merge therefore does not claim live ownership privacy.

With the private writer opted in, ownership JSON and every hard link to it are `0600`. The original exclusive
descriptor remains the heartbeat target. The nonce, label, descendant authority,
process-start string and source-file inventory are never peer-readable.

The owner publishes a bounded, versioned directory-entry name inside a `0755`
per-uid directory. The entry is a hard link to the same private inode, not a new
public JSON file. Its name contains only protocol version, slot number, concurrency
and reserved bytes. PID, host, boot, namespace and process-start identity stay private.
Heartbeat time comes from that inode's mtime. Peers use directory entries and
lstat only, never open/read the ownership file or a symlink target. The directory
is not peer-writable; existing unsafe directories are rejected, not chmodded.
The empty per-uid index directory is intentionally retained; release removes its
own projection and reservation, not a directory another same-account run may use.

The inode binding prevents an old projection from describing a replacement
reservation. Missing, incomplete, unreadable, conflicting and over-limit
observations stay distinct: UNKNOWN means occupied, never free or zero bytes.
Public metadata is not a deletion credential and cannot borrow a parent's slot.
Only the existing owner lane may recover a private foreign-owner reservation;
cross-account stale recovery is deliberately not inferred from a public heartbeat.

Before memory sizing, a same-uid owner lane may privately inspect a bounded original
descriptor, prove its holder stale under the existing namespace/boot/pid predicate,
and reclaim only that unchanged private record. It retires the matching projection
BEFORE deleting the canonical anchor, so a metadata cleanup error leaves occupied,
recoverable ownership rather than an orphaned public projection. Corrupt, replaced and foreign records
remain occupied; metadata alone grants no recovery authority. Old lease release
must preserve the replacement's projection. Recovery logs omit private raw bytes.
Every private reclaimer reopen is nonblocking, no-follow, bounded and checked
against that original inode/uid, including release and failed-publication cleanup.
The collision path uses the same recovery rule when a holder becomes stale after
the initial sweep. Unknown namespace identity never justifies a local pid probe.
Real replacement children (identical JSON/new inode, symlink, FIFO, oversized file)
have an external hard deadline and positively count the actual reopen flags.

A short exclusive private mutation guard serializes cooperating create, recover,
refresh, release and rollback operations. It is not held for the test run. An unknown
or abandoned guard is occupied; no timeout steals it. After audit callbacks, recovery
rechecks the original private inode and exact bytes before unlink. POSIX pathname
checks followed by unlink are still not atomic compare-and-delete against arbitrary
same-uid or privileged actors bypassing the protocol; this is not an adversarial
same-account isolation boundary.

Exclusive creation retains rollback authority over its own unpublished empty or
partial record, never over a replacement. Publication arms matching-inode rollback
before linking. Failed cleanup retains the canonical anchor. Release retries three
times, then records a private terminal release request when safely possible; a
same-account owner may recover that record even while the parent PID stays alive.
Uninspectable state and failed mutation cleanup require owner-lane recovery and
remain NOT_RUN, not a success or an automatic public-heartbeat takeover. On Linux,
two missing namespace measurements do not authorize PID or expired-lease recovery.

## Qualification / adoption boundary

This candidate is NOT live-qualified or merge/adoption-ready merely because a
local suite passes. Source merge requires exact-head source tests, load-bearing
negative controls, author preflight, mapped coverage, hosted checks and review.
Separate adoption follow-ups remain: native two-account read/denial,
mixed old/new reader refusal and safe migration, namespace/boot/PID-reuse cases,
owner-lane stale recovery plus durable bounded escalation (no infinite silent
queue), crash-before-publication, replacement/fd controls, real mapped coverage,
exact-head CodeQL, hosted checks/review and safe repair-lane ownership handoff.
Legacy readable JSON is read-only compatibility, not proof that an older reader
understands private reservations. Do not deploy this protocol into a mixed reader
fleet. No `0600`-then-public-chmod workaround, query suppression, security dismissal
or merge-policy weakening is part of this redesign.

Research: CodeQL's insecure-temporary-file guidance requires private temporary
contents; POSIX hard links name the same inode (and therefore the same permissions).
This separates explicitly public capacity from authority without a new service.
https://codeql.github.com/codeql-query-help/javascript/js-insecure-temporary-file/
https://man7.org/linux/man-pages/man2/link.2.html
https://nodejs.org/docs/latest-v24.x/api/fs.html
https://codeql.github.com/codeql-query-help/javascript/js-file-system-race/
https://man7.org/linux/man-pages/man2/unlink.2.html
