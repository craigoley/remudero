# Instance registry selection contract

W1-T9435 supplies an additive public read/binding contract and an explicitly opted-in
read-only registry route. It does not complete the remudero-ops split, activate a
private registry, change admission, deploy an image, or authorize publication.
The full Apache public core and owner/admin override remain intact.

## Selection and evidence

Explicit CLI path wins over the supplied RMD_INSTANCE_REGISTRY value, which wins
over an explicitly configured path. Only genuine absence returns legacy. Empty,
relative or invalid selected paths refuse; selected read failures never consult a
healthy legacy file or served-view cache. Paths are absolute host/container read
targets, not repository-relative writer targets or GitHub file-SHA permission.

The default async reader accepts regular nonsymlink files, reads at most the
configured byte bound plus one overflow probe, checks descriptor and pathname
identity before/after the read, and hashes/parses the same bytes. Allocation has
a hard 256 KiB ceiling; a file's stat does not authorize an unbounded read.
Unknown read, close, revision, digest, encoding and cancellation outcomes stay
unknown. The bounded caller deadline does not prove every underlying operating
system request was cancelled; late work still closes its own handle.

Bindings copy/freeze validated identities, mode/primary safety fields, source,
capabilities and digest. Neither caller mutation nor replacing the file silently
retargets an existing binding. Recheck observes changed/unknown evidence without
updating that binding. Equal bytes are not fresh owner authority: current holds,
revocation, origin/head and required checks still belong to later effect seams.
Private paths and raw operational values are absent from serialized bindings,
diagnostics and the existing public projection. Publication permission is always
not-granted. A digest is integrity evidence, not a private-source release decision.

## Bounded compatibility window

The public reader's out-of-band contract versions 1 and 2 support identity, mode
and primary capabilities with the same selected YAML grammar. A caller requiring
an unknown capability or another contract version is refused before reading.
No new YAML root version is emitted. The existing legacy version: 1 preamble is
accepted; selected unknown fields refuse rather than silently lose safety data.
Operational fields remain hashed but are not projected. Legacy parser/route
behavior is unchanged when explicit selection is absent.

This is a tested reader window, not compatibility with arbitrary future inputs.
Old shell installers/recyclers currently reject mode; they are not upgraded by
this task. Do not hand a new safety grammar to old binaries or replace their
shared legacy file under running work. Later lifecycle/daemon/effect integration
requires separately filed scope and normal merge. Untrusted workers/proofs must
not receive the private overlay merely because a mount is read-only: read-only
prevents writes, not reads.

## Migration order and rollback

1. Expand and qualify all trusted readers, writers and lifecycle adapters before
   moving active values. Preserve legacy public installs and required gates.
2. Stage immutable private data without production selection. Pin code/image,
   repository revision, content digest, capabilities, instance identity and the
   prior release tuple. Keep secrets and writable runtime state outside both repos.
3. Rehearse mixed versions, outages, resume, stale effects, recovery and rollback
   on disposable fixtures. All new admission remains opt-in SHADOW ONLY.
4. Obtain explicit human approval to migrate one non-primary instance first;
   retain old releases for old runs. Core is last, never an implicit fallback.
5. Observe retirement of every relevant old reader/writer before removing active
   public values. A source merge is neither deployment nor live qualification.

No dual authoritative live writes, shared in-place file swap, claim reclaim,
state-format change, gate waiver, automatic config promotion or new schedule is
authorized. Owner holds survive migration; owner override is not a gate waiver.
Live activation and explicit foreign-input adoption exceptions remain human decisions.

## Worker impact and exact stop decisions

| Class | When | Required boundary |
| --- | --- | --- |
| WORKERS CONTINUE | Isolated additive source work, admitted tests, private staging and disposable rehearsal | No worker stop. Inspect automatic self-update/deployment implications before publication; no live selection here. |
| DRAIN ONE INSTANCE | Approved compatible restart, overlay selection, container mount or launcher replacement | Human approves the exact instance. Hold new admission, let current work finish or reach its durable handoff, verify pending effects, then replace only that process. Other instances continue. |
| PAUSE FLEET NEW ADMISSION | Shared control-plane promotion with unproven mixed-version correctness but valid existing bindings | Human approves affected admission pause. A pause is not zero writers; review, merge, background and external CI require separate accounting. Do not kill workers to satisfy a timeout. |
| FULL AFFECTED WRITER STOP | Incompatible shared state/lock/claim namespace, state-root move or incompatible shared credential/config mount | Human approves the exact affected writers and maintenance packet, including lane-less/background/effect writers. Verify quiescence and recoverable receipts first. Stop all workers only if all are actually affected; no fleet-wide stop is inferred from a source merge. |

Each live packet must identify current holders, images/code/config digests,
affected paths/mounts/consumers, current owner holds, durable drain evidence,
bounded abort criteria and a tested rollback to the retained compatible tuple.
An unreadable writer census refuses promotion, not the writer's existence.
Never clear another owner's hold or reclaim a contested claim.
