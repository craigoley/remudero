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

### Dormant explicit runtime selection

W1-T10573 connects explicit selection to the actual daemon/direct-task default
readers and host launchers. This is different from the optional observations
below: selected invalid evidence refuses that invocation; genuine absence still
uses the original public-registry behavior. It does not install a configuration,
activate admission, grant publication permission, or approve a release.

A synthetic later-installation example is a regular, nonsymlink, owner-private
file outside the checkout, worker homes, shared dependency roots and broad
container mounts. These are example values, not this installation's settings:

```yaml
instances:
  example-shadow:
    repo: example-public-core
    github_repo: example/example-public-core
    mode: shadow
    state_dir: /srv/example/state
    container_name: example-shadow
    image: example.invalid/example:qualified-image
    claude_dir: /srv/example/auth/claude
    codex_dir: /srv/example/auth/codex
    container_config_dir: /srv/example/config
```

After separate rollout approval, the host launcher would receive an absolute
`RMD_INSTANCE_REGISTRY` path and explicit `--instance example-shadow`. It qualifies
the selected bytes, physical identity, Docker source namespace and image reader
before any replacement. The generated container arguments contain exactly one
`--mount type=bind,src=<qualified-host-file>,dst=/home/node/.config/remudero/selected-registry.yaml,readonly`;
only the trusted daemon/serve readers receive that container path, the original
digest and instance name. A host path is never substituted as a container path.
Unsupported images or source namespaces refuse; no directory is silently created
for a missing file. This example is not a command to install, start or recycle it.

Selected Claude and Codex invocations use public-only permission scopes and opaque
per-invocation policy artifacts. Neither prompts nor untrusted child arguments
carry the selected filename. Read-only/review work cannot write its public source;
writers retain their ordinary public workspace and admitted test-slot access.
Cash/Foundry tools also refuse a selected file inside their public worktree/home
scope and recheck binding before model requests and local tool effects. Unknown
scope or cleanup remains an explicit redacted refusal, never broader permission.
Unselected provider policies and supported owner/service flows stay unchanged.

Source publication remains independently held until the actual automatic image
build/recycle route is protected or an exact release is separately approved.
Isolated source and tests need no worker stop. Private installation, live selection,
replacement and any affected-instance drain still require the human rollout
decision below; no source merge implicitly approves them.

### Optional run and sweep mode observations

W1-T9572 adds `selectedRegistryMode` to the public configuration schema. Only an
explicit `mode: shadow` opts into these observations; an environment variable
alone does not enable them. The configured instance/path and supplied environment
values are captured before asynchronous work. Genuine absence still uses the
original legacy readers, default arm dependencies and effects without a selected
read or receipt. This source change does not write or activate configuration.

The run body retains its original binding through review and deferred arming.
Sweep construction forwards it to ordinary and armed-idle physical arm, direct
REST merge and queue dependencies. Asynchronous physical writes recheck after
their existing security reads; synchronous-only seams report unknown fresh
authority rather than installing a blocking adapter. Each redacted observation
names the actual repository/PR target. A mismatched or unreadable target cannot
borrow another repository's selected evidence. Changed, missing, malformed,
unsupported, cancelled or unavailable evidence stays would-refuse, not selected
live. The original digest is never silently replaced.

These are immutable SHADOW observations of the actual unchanged legacy outcome,
not effect permission. Existing genuine shadow-instance holds, owner/admin
override, human/service scopes and normal review/CI/security remain independent.
An observation sink failure cannot substitute its error for the operation's
result or original exception. Publication permission is always not-granted.

This does not qualify deployment, serve, pause/resume, heartbeat or every child
process; those consumers still need separate compatibility and recovery evidence
before private staging or selection. Isolated source/tests do not require a
worker stop. Live compatible replacement requires separately approved affected
instance draining; incompatible shared state, claims, credentials or config
requires an approved full affected-writer stop, all workers only if all are
affected. No scheduler, deployment or admission activation is included.

### Serve and discovery observations

W1-T9793 carries the same explicit `mode: shadow` intent through the maintained
serve, gateway, readiness, proposal, liveness, dashboard and repositories-view
composition. The observer uses the bounded asynchronous selected reader, retains
its original digest and rechecks before reporting. It does not change a legacy
response, cached portfolio, owner decision, error or effect, and does not wait
for selected IO before starting that effect. Failed or stale selected evidence
cannot borrow healthy legacy or cached authority. Publication permission remains
`not-granted`; private paths, state roots and bytes are not observation fields or
public response material.

Synchronous benchmark, inbox, lint and ratification reads remain synchronous and
report unknown fresh authority. Aggregate discovery has no invented single-instance
target. The CLI reuses its existing invocation configuration read; offline readers
do not load or create configuration to find opt-in. Daemon drafting and actual
single/batch filing use invocation-owned contexts. Nested no-config calls mask an
outer opt-in, concurrent calls stay isolated, and completion deactivates escaped
callbacks. Delayed draft evaluation snapshots intent before dispatch. The additive,
versioned intent travels only over trusted projector/view-worker data; unsupported
transport remains unknown and absent older data does not enable observations.

Observation shutdown is not an effect-drain or activation barrier. `settled()`
waits for observations already queued by completed operations, not arbitrary
in-flight effects. No live selection, worker restart, scanner, schedule, new
mandatory reviewer or private staging is included. Isolated source/tests need no
worker stop. The separate human-approved drain/full affected-writer-stop contract
below still governs any later live migration; owner/admin override and the complete
public Apache core remain intact.

### Carried lifecycle fields

W1-T9559 gives the selected reader and proposal writer one frozen field vocabulary
in the public registry module. It includes every current installer/recycler case
field, including `gh_app_private_key_host_path`, plus the existing selected `mode`
safety field. Tests derive the lifecycle field census from both actual shell case
blocks and exercise both consumers, rather than ratifying a guessed field count.
Unsupported sibling fields and unknown roots remain refused; this is not an
open-ended future-schema allowance. The supported versions/capabilities and
legacy no-selection behavior are unchanged.

The host key path is opaque carried metadata, not credential bytes or a container
path. Recognition never opens the named key, mounts it, validates every installer
value, selects an overlay or grants publication permission. Its bytes contribute
to integrity evidence: changing it invalidates an existing read binding or the
writer's final pre-effect comparison. Proposals preserve it and every other
non-target byte. Public projections, serialized bindings, diagnostics and
success/incomplete receipts expose none of those operational paths or values;
publication permission remains `not-granted`.

W1-T9559 did not upgrade shell `mode` handling or qualify all daemon, lifecycle
and effect consumers. W1-T9571 supplies the narrow shell compatibility below;
old shell binaries still reject `mode`. Do not give old binaries new safety
grammar or swap their authoritative file during active work.
WORKERS CONTINUE for isolated source validation. Actual selection/replacement,
credential mounts and incompatible shared state still need the separate human
drain/stop approvals below. Admission remains opt-in SHADOW ONLY, with owner/admin
override and the complete Apache public implementation preserved. No schedule,
live policy/configuration, deployment or private-value move is included.

### Lifecycle mode grammar

W1-T9571 extends the existing installer and recycler case blocks to validate one
optional `mode` field in the selected row. They accept exactly case-sensitive
`shadow` or `live`, bare or in balanced double quotes, with the existing inline
comment and trailing-whitespace handling. Empty values, single or broken quotes,
other words, extra value text and duplicate mode fields (even equal duplicates)
refuse before installer artifact writes or recycler Docker/Azure effects.
Unrelated unknown fields still refuse; this is not a general YAML/schema upgrade.

Mode is carried registry metadata, not authority. Recognition adds no runtime
environment override, overlay selection, credential permission, admission
activation or private-source publication permission. An absent mode preserves
legacy rendered output and recycle effects; owner-authored PAUSE/STOP holds,
instance identity and existing lifecycle guards remain independent and intact.

The behavioral suites execute the actual scripts with system Bash 3.2, temporary
rendering/state/lock roots and recording effect transports. They compare valid
mode against absent-mode output/effects, trap invalid values before effects and
remove/restore the real recognition and validation arms. Shell branches are
qualified by those effects and falsifiers, not by TypeScript LCOV instrumentation.
This does not qualify every selected-path, digest or daemon/effect consumer, and
does not install or recycle a live instance. Admission remains opt-in SHADOW ONLY.

### Explicit proposal writer target

W1-T9493 adds `onboardingGoLive.registryTarget: { repository, filePath }` to
the existing verified-operator, high-tier proposal route. `filePath` is a raw,
canonical repository-relative Git path, not an absolute host/container path or
pre-escaped REST URL. Only an absent target preserves the legacy repository and
request sequence. Invalid, unavailable or revised selection never falls back.

The writer snapshots intent before asynchronous work and copies its target at
route composition. It binds numeric repository identity, default-branch commit,
nonrecursive exact-path trees, regular blob mode, file SHA and the same decoded
bytes it hashes/parses/edits. Path depth is capped at 16; file bytes at 256 KiB;
truncated or excessive trees refuse. SHA-1 Git objects and the existing version-1
registry grammar are explicit supported inputs, not arbitrary future capability
adoption. The selected origin, branch and bytes are re-read immediately before
the first effect. A subsequent main advance does not retarget the proposal: it
remains pinned to its bound commit and still needs normal review and merge.

Proposal effects create only a fresh branch and update only its selected file
with the bound replaced-file SHA. Every unrelated byte survives. Successful
receipts remain `review_pending`, with digests/revisions rather than raw private
paths or content. Publication permission is always `not-granted`; neither an
actor nor a digest grants private-source release permission. No actual promotion,
private overlay selection or new admission policy is activated by this source.

Pre-effect refusals issue no writes. After an attempted effect, an incomplete
receipt distinguishes response-verified branch/file stages from the unknown
current stage. It does not claim nothing happened, retry effects, create a PR
after an unverified update, clean up, close anything or publish a success receipt.
An audit failure after a verified PR retains that real review-pending receipt.

This writer does not migrate every lifecycle consumer. WORKERS CONTINUE for the
isolated source stage; the separately approved drain/stop rules below still govern
later live changes. Legacy absence, owner override, required gates and public
Apache implementation remain intact. No schedules are created.

The public reader's out-of-band contract versions 1 and 2 support identity, mode
and primary capabilities with the same selected YAML grammar. A caller requiring
an unknown capability or another contract version is refused before reading.
No new YAML root version is emitted. The existing legacy version: 1 preamble is
accepted; selected unknown fields refuse rather than silently lose safety data.
Operational fields remain hashed but are not projected. Legacy parser/route
behavior is unchanged when explicit selection is absent.

This is a tested reader window, not compatibility with arbitrary future inputs.
Shell installers/recyclers predating W1-T9571 reject mode; the reader/writer
contract alone does not upgrade them. Do not hand new safety grammar to old binaries or replace their
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
