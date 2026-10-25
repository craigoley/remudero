# Deploy exit receipts and operator-approved recovery diagnosis

W1-T10188 design for human review. This document proposes behavior; it does not
install receipt delivery, diagnosis, a recovery executor, or deployment policy.
Human review must accept or revise this design before implementation is filed.

## Current-main evidence

Authenticated repository reads on 2026-10-24 resolved `main` to
`ec2f3136f2d894d1b91cac24795515e3609b2d47`. The task record was re-read at
that main, including its operator `proceed` ruling. Its citations use symbols,
not file:line references. All four named shell functions still exist. Local
blob hashes matched the authenticated files below; anchors identify the code
at this SHA rather than assuming historical line numbers remain current.

| File and symbol anchors | Verified behavior and consequence |
| --- | --- |
| `deploy/recycle-container.sh`: `commission_receipt`, `commission_on_exit` | Only `--commission-git-author` enables the receipt. `COMMISSION_RECEIPT_DONE` suppresses repeats. It prints target/container/operation/outcome/phase, an optional recovery line, and best-effort appends `recycle.git_author_commission` if the ledger directory exists. There is no durable receipt acknowledgement. `preflight`/`capture` map to refused; later phases map to failed. |
| Same file: initial `trap 'commission_on_exit' EXIT`, `recycle_cleanup_tmp` | The later EXIT trap replaces the initial trap, then explicitly calls commissioning after removing pull/probe files and releasing the host recycle lock. It captures the original status for PAUSE cleanup and returns zero. A receipt extension must compose these paths, including exits before this replacement, without removing cleanup or overwriting the script status. |
| Same file: argument scan, `validate_instance_name`, argument loop | Registry errors, invalid targets, unknown arguments, missing flag values and the in-container guard can exit before late cleanup. Help explicitly disables commissioning and exits zero. Ordinary exits have no commissioning receipt. Bootstrap must precede registry reads, sourced helpers and argument failures. |
| Same file: `recycle_on_signal`, `RECYCLE_SIGNAL_PHASE` | HUP/INT/TERM handlers are installed near PAUSE creation, after earlier preflight. They exit 129/130/143. While waiting they remove only the run's own PAUSE; after stop they retain PAUSE because a replacement is unconfirmed. The EXIT cleanup then runs. Earlier signal exits are not covered by these handlers. |
| Same file: `COMMISSION_PHASE="verified"`, `commission_receipt verified` | Effective-identity verification emits success before post-start actions and final image reclamation. A verified commissioning operation and a later failed overall invocation can coexist; the new receipt must distinguish them. |
| `deploy/host-update.sh`: sudo guard, argument loop, `PRINT_DAEMON_RUN`, state-root modes | The sudo refusal exits 2 before ordinary initialization. Help, print-daemon-run, check-state-roots and relocate-state-root can finish before the cleanup trap. Dry-run and reclaim-only have distinct work and must not imply an image replacement. |
| Same file: `host_update_cleanup_tmp`, final `exit "${PULL_RC}"` | The sole explicit EXIT trap removes Docker error, pull and off-host tar files and releases its recycle lock. It is installed before mktemp allocation, but after several early modes. There is no explicit HUP/INT/TERM handler. The final pull status and reclaim-only failure exits must survive added reporting. No shared exit-receipt contract exists here. |
| `src/lib/deploy-refusal-escalation.ts`: `refusalIdentity`, `persistingRefusalEscalation`, `refusalEscalationOrNone` | W1-T6062 already owns persistent refusal reporting. Instance/reason identifies the condition; count and lag are detail, not identity. Direct delivery is attempted where possible; missing credentials, errors or an empty delivery result use host spooling when configured. Successful recovery can close or withdraw that condition. |
| `src/lib/host-escalation-spool.ts`: `escalationSpoolKey`, `writeAtomic`, `drainEscalationSpool`, `withEscalationSpoolDrain` | Existing host-to-container shared-state transport writes then renames files, records delivered identities, and retains entries on delivery failure. Its closed union accepts escalation/close/comment, not deploy receipts. Its issue dedup is condition based; it is not a per-invocation journal. `readJson` and the directory-read catch collapse some unreadable states; a new receipt drain must return explicit unavailable/malformed states. |
| `src/lib/inbox.ts`: `Proposal`, `stageBundleProposals`, `updateProposalRegistry`, `classifyProposal`; `src/lib/inbox-owner.ts`: `inboxOwner` | The existing bundle producer demonstrates deterministic proposal ids and insertion through the sanctioned registry writer, which locks and re-reads `inbox-proposals.json`. Proposal state and owner determine whether a person must act. An unknown producer defaults to operator ownership, but that alone does not provide recovery-specific approval semantics. |
| `src/lib/ask-classification.ts`: `classifyAskRecordItem`, `projectProposalHumanGates`; `src/lib/panel-graph.ts`: `classifyAllProposalsMemo`, `operatorItems` in the inbox projection | The core inbox projects operator-owned ready/not-ready/deferred proposals into ASK and other observations into RECORD. Unresolved escalations are also ASK through the common classifier. Creating a second recovery issue and a proposal for the same refusal would double the request. |
| `src/lib/inbox-verdict-command.ts`: `INBOX_VERBS`, `proposalVerdictCommand` | Existing interfaces include approve, decline and reframe. They serve several proposal kinds; generic approval can lead to plan ratification. A recovery proposal needs an explicit discriminator and a decision-only branch, not an ordinary plan fragment. |
| `src/lib/feedback.ts`: `findFeedbackBySubmissionKey`, `stageFeedbackCapture`; `src/lib/feedback-landing.ts`: `sweepFeedbackLandingAsync` | Submission keys can join retries to already captured or queued feedback. Daemon capture stages into the normal landing lane. Diagnosis must use this lane, then normal triage and machine-filing review. |
| `src/lib/containment.ts`: `probeContainment`, `assessContainment`, `assessEgressContainment` | Existing worker containment probes are relevant evidence patterns. Its header explicitly says several arms are observational, not gating. A general worker's configuration or tool list is insufficient proof of the stricter boundary proposed here. |
| `DECISIONS.md`: 2026-09-09 change-and-risk ruling, ratifying W1-T3199 | Ordinary deployment remains change-and-risk gated. Deterministic safety checks and restart-rate limits remain binding. Approval of a recovery suggestion cannot become a prerequisite for normal deploys. |

For reproducibility, main's recycler blob is
`cf6100d6ff8aa623377fe961ff4c55324540519e`; host-update is
`62198faee68b533f566894c31d8b89eee30dbb3c`; refusal escalation is
`9d9c12adff9e6c52a1579d99ed69db76a7fd6746`; host spool is
`0033a074dd705713928360b34e357f6491c57a04`. A source search for
`recycle.git_author_commission` found no `src/` consumer, with its shell producer
as the positive control. This establishes a code integration gap, not live
delivery loss. Supplied NanoClaw observations and historical outage narratives
are motivation, not independently verified runtime or platform facts. No live
deploy, log, credential, or ledger was accessed for this design.

Before editing, the design path was absent locally and returned authenticated
404 at main while the task record read succeeded. All five filed grep proofs
therefore lacked their target at base. A merged-PR API search for W1-T10188
returned five intake/gardening/ruling references; none carried an exact
`Remudero-Task: W1-T10188` body trailer. No completed implementation is inferred
from commit subjects or shard statuses. The dispatch ref exists for this run;
no remote `run-W1-T10188-*` branch existed at the check.

## Exit receipt contract

One terminal receipt represents one shell invocation, including ordinary and
commissioning recycle, argument refusal and every host-update mode. The shell
bootstrap assigns a 128-bit random invocation nonce before fallible preflight;
the id is the digest of version, provisioned opaque host id, script enum and
nonce. It is created once, retained through traps and outbox retries, and never
derived from PID, time, target head or mutable refusal text. A new invocation
after restart gets a new id; draining an old invocation retains its id. An
identity-generation failure is explicitly undelivered, never a PID fallback
that could collide. The installer must verify bootstrap dependencies; the host
scripts must continue to work without Node, rmd, Python or model credentials.

Proposed v1 fields, all validated again by core:

| Field | Allowed content |
| --- | --- |
| `id`, `invocation`, `host`, `script`, `version` | Fixed-format digest/nonce and configured opaque host id; script is `recycle-container` or `host-update`. No raw hostname, username, command line or path. |
| `instance`, `mode`, `snapshotSha` | Declared registry instance or explicit `unresolved`; mode from a closed per-script enum; full repository SHA only when actually known, otherwise null. Host-wide maintenance uses unresolved plus host scope, not a guessed target. Never persist a rejected raw instance argument. |
| `phase`, `exitStatus`, `signal`, `outcome` | Allowlisted reached phase, integer 0–255, null/HUP/INT/TERM, and `success`/`refused`/`failed`. Explicit refusal sites set a refusal code; unexpected nonzero status means failed. A signal means failed even during preflight. |
| `reasonCode`, `recoveryCode`, `recovery` | Closed operational codes and a locally rendered sentence, at most 512 UTF-8 bytes. Sentence templates mention safe instance aliases and next steps, never interpolate captured errors, author values, paths or rejected input. |
| `startedAt`, `finishedAt`, `commissionOutcome`, `tail`, `tailOmission` | UTC timestamps; commissioning is null/not-reached/verified/refused/failed. Tail is the safe event rendering below; omission is a closed reason code. A verified commission does not override an overall failed exit. |

Phase enums must reflect actual transitions: bootstrap, arguments, preflight,
capture, pull, drain, smoke, stop, start, health, verify-identity, post-start,
cleanup and done for recycle; bootstrap, arguments, preflight, state-check,
relocate, registry-login, backup, reclaim, pull, report, cleanup and done for
host-update. Each script uses only its own subset. Preserve the last work
phase in the receipt; record cleanup faults separately rather than replacing
the causal phase with cleanup. Recovery describes confirmed state: before
stop, correct the named condition and retry; after stop, replacement is
unconfirmed and PAUSE may remain; after prune/pull failure, an image may need
re-fetching. Never infer “outgoing is running” solely from a phase label.

Outcome is about the requested mode. Help/print/dry-run success records that
mode and does not claim an update. A successful unchanged pull means success
with `reasonCode=unchanged`, not new bits deployed. Check/relocate/reclaim-only
report their own terminal result; a sub-operation refusal that the existing
script deliberately tolerates remains a safe event, not a rewritten exit code.
Malformed/missing arguments are refused, including failures before full target
resolution. First-boot follows the same envelope without requiring a checkout.

Install a single EXIT dispatcher before sudo guards, sourcing, registry reads
and argument parsing. Capture `$?` immediately, guard against recursion and
disable errexit within finalization. Later code registers cleanup state with
that dispatcher instead of replacing its EXIT trap. Preserve current removal
of temporary files, lock release, and exact-body PAUSE ownership checks. Copy
safe in-memory events before deleting the script's temporary logs; never retain
raw temporary logs as receipt artifacts. Cleanup failures cannot prevent the
receipt attempt. Finish with the original status; neither receipt success nor
receipt failure turns a script failure into zero or changes its numeric code.
Record cleanup failure as a separate code even if the original status was zero.

Compose commissioning's compatibility output and audit event with this path:
its operation receipt may still say verified when verification finishes, but
only the terminal envelope is ingested as this invocation's deploy receipt.
Do not diagnose both formats. Early HUP/INT/TERM handlers set signal/status
and exit through the dispatcher; the later handlers retain current PAUSE
behavior and use the same dispatcher. Subshells must not emit parent receipts.
SIGKILL, power loss, host loss, and a shell that cannot parse/start the script
cannot run EXIT. An optional durable start marker can report an interrupted
invocation as unknown after restart; it must never fabricate a terminal receipt
or call lack of an exit record success. Start markers do not trigger diagnosis.

Transport uses a typed sibling of the existing host escalation spool under
the configured core shared state directory: `deploy-receipt-spool/<id>.json`.
Reuse its flush/atomic-rename and drain-on-freshness pattern, with a separate
parser and acknowledgement namespace. Do not insert an unsupported kind into
the escalation union or send every exit to GitHub. Resolve the configured core
mount independently of the requested target so an unknown instance can still
report. Bootstrap reads only a provisioned, owner-checked transport location;
it never guesses an arbitrary root from sudo's HOME or creates a fleet state
tree. A missing/unreadable mapping means transport unavailable.

Write only sanitized bytes to a same-directory exclusive temporary file,
flush data, rename atomically and sync the containing directory where the host
supports it. Core validates and durably copies the immutable receipt before
acknowledging its id and payload digest. Host deletes its pending copy only
after that acknowledgement matches. Loss of an acknowledgement causes replay,
not a new id. This is at-least-once transfer with idempotent acceptance, not
an assertion of exactly-once model API execution. A receipt being spooled is
not delivered to core and an ASK being staged is not an operator response.

Unwritable/full spool, absent helper, bad permissions or failed rename emits a
fixed value-free stderr status `receipt_delivery=unavailable` and a safe receipt
when serialization is possible. Preserve the original script status; never
claim durability for stdout. The host heartbeat should report spool age/count
and transport unavailable through its existing alert path when that path works.
If all storage/alert paths fail, visibility cannot be guaranteed. An unreadable
core inbox or spool returns unavailable and retains pending work, not an empty
queue. Automatic transfer tries at most three times per drain pass with bounded
backoff, then waits for a later freshness pass; it never blocks deploy teardown
on core or a network. Pending entries are not evicted to make a quota look green.

“Value-free” means an allowlist of operational identifiers, enum statuses,
phases, timestamps, digests and template sentences. It does not mean arbitrary
output with a few secret regexes applied. Never persist author names/emails,
credential values or paths, environment dumps, argv, container inspect output,
URLs with credentials/query strings, raw stderr, raw model transcripts, or
arbitrary repository/log excerpts in the host receipt. The bounded log tail
is a rendering of the last 20 allowlisted script event codes, each at most
160 UTF-8 bytes, totaling at most 4 KiB; it is not `tail` of a raw log file.
Unknown lines are omitted, with `tailOmission=unsafe-source`, not copied.
Normalize UTF-8, remove ANSI/control/bidi sequences, forbid NUL and reject
oversized fields before any persistence. Bounds are bytes after encoding and
sanitization. The entire serialized receipt is at most 8 KiB. No sanitizer
failure falls back to the original text. Enforce the same policy for ledger
rows, quarantine notices, ASK prose and feedback derived from the receipt.

Spool directories require 0700 and files 0600 for the provisioned host/core
service identity, or an explicitly provisioned equivalent shared group with
no other readers; never solve a mismatch with world-readable permissions.
Reject symlinks, hard-link aliases, FIFOs/devices, unexpected owners, path
traversal, duplicate JSON keys, unknown fields/versions, invalid enums/digests,
oversized input and mismatched filename/id before reading unbounded content.
Open relative to the owned directory without following links; do not trust a
check-then-open realpath alone. Host metadata is untrusted evidence even when
ownership is correct. Invalid entries yield a bounded reason/hash notice and
no diagnosis, ASK or feedback; never echo the rejected payload into quarantine.

Acknowledged host copies expire after 24 hours; core sanitized payloads and
diagnosis text expire after seven days once terminal and acknowledged. Pending
and unavailable records remain until acknowledged or explicitly disposed of,
with age/capacity alarms rather than silent loss. Minimal id/digest/result
tombstones persist for the lifetime of the receipt namespace, including across
archive/restore; otherwise an old spool restored from backup could create a
second ASK. A separate future retention decision is required to retire that
namespace. No receipt retention operation deletes ledger/history or changes
host-update's prohibition on state cleaning.

## Contained diagnosis and ASK

Core schedules diagnosis only for validated terminal failed/refused receipts.
Successes, help, unchanged results and incomplete start markers are records.
For each eligible receipt it pins an available repository commit by SHA and
materializes an explicit snapshot of tracked source files plus the sanitized
receipt. No working tree modifications, git metadata, submodules, symlinks,
untracked files, `.env`, credential stores, state, sockets or special files
enter the snapshot. If the recorded SHA is absent or unknown, return
`snapshot_unavailable`; do not silently substitute current main. Snapshot
materialization belongs to the trusted coordinator, never to a model tool.

Use a trusted model API coordinator with only the credentials and egress needed
for the approved model endpoint. It exposes exactly Read, Grep and Glob through
a separate credential-free tool service. The tool process gets a read-only
snapshot, read-only sanitized receipt, no writable mount, no host HOME or state,
no shell/exec API, and an isolated network namespace with no external network
or DNS. An inherited narrow IPC channel carries structured requests/replies;
it must not be an HTTP proxy or accept arbitrary coordinator operations.
The coordinator does not forward model-supplied URLs or launch processes.
Trusted snapshot/outbox writes are outside the diagnosis tool capability.

Enforcement must be independent of prompt text: OS mount/network isolation and
a syscall/process policy deny file writes, subprocess execution and socket
creation, including commands attempted through a tool argument. Descriptor-
relative file resolution confines every access to the snapshot; reject `..`,
absolute paths, symlink/magic-link traversal and raced replacement. Grep uses a
bounded in-process matcher with literal/linear-time semantics, not a shell or
unbounded regex engine. Glob cannot traverse links. Only known tool names and
strict schemas dispatch; denied calls are structured errors. A positive in-root
read/search/glob control and negative write/network/credential/escape probes
must pass on the actual implementation before enabling diagnosis. Unavailable
or unproven isolation produces `sandbox_unavailable`, never a normal worker
fallback. Existing observational containment arms cannot authorize this path.

Treat repository text, event text and model output as untrusted data. They may
contain instructions to reveal credentials, change tools or run commands; these
have no authority. Bound each diagnosis to 60 seconds wall time, 12 tool calls,
32 KiB cumulative tool output, 12,000 input tokens and 1,000 output tokens.
Each read is capped at 8 KiB and each tool call at two seconds. These are
proposed resource budgets for review, not measured latency thresholds or
evidence that production is unhealthy. A single total budget spans retries.

Accept exactly one JSON object with uppercase fields `REASON` (an allowlisted
diagnosis code rendered through a reviewed sentence template of 1–512 UTF-8
bytes), `COMMAND` (one single-line suggestion up to 512 bytes or null, meaning
explicit none), `DEFECT` (boolean) and `EVIDENCE` (up to three snapshot path and
line-range references). Reject duplicate/unknown fields, prose/fences around
JSON, invalid references, secret/control sentinels and multiple commands.
COMMAND is display data, never evaluated; accept only a reviewed command
template with validated operational arguments such as the declared instance,
never author values, credentials or arbitrary source-derived literals. Reject
shell chaining/substitution, redirection and line breaks, and render with text
escaping. An unknown reason or command template is unavailable, not permission
to persist the model's raw prose. The safe fallback
is `COMMAND=null`, with a template reason saying why diagnosis is unavailable.
A completed no-command diagnosis is distinct from malformed, timeout, model
unavailable and sandbox unavailable. Persist only a sanitized validated result;
discard raw output and unsafe explanation text. References identify source
evidence without copying arbitrary source strings into feedback or the inbox.

Stage the result using `updateProposalRegistry` and the existing core inbox
ASK projection, with an explicit typed `deploy-recovery` proposal whose id is
`deploy-recovery:<receipt-id>`. It contains receipt/snapshot/result digests,
phase, safe REASON, COMMAND or “none”, evidence references and links to the
existing refusal condition. A minimal unavailability ASK uses the same id and
offers manual inspection/reject; it cannot be mistaken for a completed model
diagnosis. Classification must explicitly recognize this producer as operator
owned and avoid sending it through plan drafting or auto-ratification.

The operator can approve the displayed suggestion, edit it, or reject it.
Approve records acknowledgement of that exact command/result revision. Edit
creates a sanitized revision and requires a fresh decision against that
revision's digest. Reject records a reason and resolves the ASK. Concurrent
or stale decisions return conflict; they cannot approve newer unseen text.
Use existing approve/reframe/decline inbox interfaces with a typed recovery
branch and appropriate scoped action contract. No shell, deploy, source write,
task filing, generic ratification or action-executor callback is reachable on
staging, approval, editing or rejection. The UI says “acknowledge suggestion”
and explains that execution is separate. Any future command execution requires
an independently authorized existing action path with its own validation.

Integrate with W1-T6062 rather than adding another needs-human issue. Before
publishing, reconcile the receipt to its instance/reason refusal condition and
the existing issue/spool identity. The first failure may create one recovery
ASK. Later receipts for the same unresolved condition attach their per-receipt
diagnoses to that ASK, with their ids recorded as linked, rather than create
new active cards. W1-T6062 still owns streak counts, lag, issue update/close
and backoff; its persisting escalation must link to the same operator decision
and project as RECORD when that decision is already an ASK. If its issue
predates the receipt, attach the diagnosis to that decision instead. The two
writers must share a condition-to-ASK index and lock; disabling either path
cannot drop the existing escalation. A verified recovery resolves the shared
condition, retaining past receipt decisions. Recovery approval does not clear
PAUSE, DEPLOY_FAILED, health failures or any ordinary deploy safety gate.

## Idempotency and defect feedback

Core owns a durable per-receipt state record with immutable payload digest,
snapshot SHA, attempt count, aggregate deadline/token/tool counters, lease,
result digest, ASK link, feedback link and publication acknowledgements.
Restart cannot reset the aggregate resource budget. Host owns receipt creation and transfer retries;
core owns validation, diagnosis and reconciliation; the inbox owns decisions;
the normal feedback pipeline owns capture, triage and filing; the operator owns
suggestion decisions and design acceptance. The model owns no transition.

| Transition | Durable rule and restart behavior |
| --- | --- |
| host pending → core accepted | Insert by receipt id and immutable digest before host ACK. Same id/same digest is replay; different digest is a collision and is refused without modifying the first record. |
| accepted → diagnosis running | Claim under a per-receipt lock/lease and durably increment attempt count before the API call. At most one lease owner runs; an unexpired lease survives a core restart. Expired ownership is recovered only after its process is confirmed gone. |
| running → completed or unavailable | Commit the validated result before proposing an ASK. At most two API attempts total and within the aggregate time/token budget. A crash after the API responds but before commit may repeat computation once; no exactly-once API claim is possible without provider support. A committed result is never regenerated on replay. Exhaustion/malformed output is terminal unavailable, not completed diagnosis. |
| result → ASK intent → published | Persist id, revision digest and condition association first. Registry upsert uses the deterministic proposal id under its own lock. On restart, look up that id/digest before publishing; a crash after registry write but before state ACK repairs the ACK, not a second card. The same rule applies to updating a pre-existing condition ASK. An unreadable registry leaves publication unknown and blocks blind creation. |
| published → operator decision | Inbox writes a durable decision keyed by ASK id and revision before ACK. Repeated identical decisions return the original result; conflicting revisions or decisions are rejected. The reconciler derives terminal state from the inbox record, never from a missing ACK alone. |
| diagnosed defect → feedback intent → captured → linked | Commit `deploy-recovery:<receipt-id>:defect:v1` as submission key first. Query both landed and queued feedback before capture; then use `stageFeedbackCapture` with that key. A crash after capture/landing but before receipt ACK looks up the same key and links the existing entry. |

Feedback creation is conditional on a completed, validated defect diagnosis
with valid snapshot evidence. A model outage or malformed result cannot claim
a script defect. The one linked entry names the script, receipt id, snapshot,
phase, safe reason and evidence references; `COMMAND` is a suggestion, not
authorization. Duplicate receipt replay must not increase feedback count.
Different invocations may yield distinct linked evidence; normal triage merges
related defects rather than granting the diagnoser a new filing lane.
`findFeedbackBySubmissionKey` supplies reconciliation but its lookup alone is
not a concurrency guarantee: serialize this producer's keyed capture and use
the normal lane's never-clobber behavior. An unavailable lookup blocks capture.

Publication retries are three per pass, with persisted next-attempt state and
at most one pass per freshness cycle; repeated outages retain pending intent
and a visible safe status. They do not spend new diagnosis attempts. Malformed
immutable input is terminal rejected, not endlessly retried. Explicit operator
re-diagnosis after exhaustion would require a separately approved new revision
and budget; none is silently minted. Minimal tombstones and submission keys
survive payload retention and core restarts. No state transition grants direct
source edits, deploys, self-approved repair or implementation-task ids.

## Executable implementation acceptance

These are proposed whole-file executable proof paths, not tests shipped by
this document. Each future task must declare its paths and prove them at its
base and head. Test files import repository modules through `#src/*` and root
helpers through `#test/helpers/repo-root.js`; use `REPO_ROOT`/`repoRoot()`,
private fixture roots and stubbed dependencies, never live state or services.
Run one test runner at a time; verify every path with `ls` before invoking
`node --test --import tsx --import ./test/setup/tmp-hygiene.ts <whole-file>`.
Require the TAP `# tests` and `# fail` summaries and a nonzero assertion count.

The installed `loadPlacementData` → `extractTestFeatures` → `placeFeatures`
classifier was run on the explicit candidate imports below. It computed
`test/deploy/` for all five (high confidence for receipts/sandbox/lifecycle,
medium for inbox/feedback). This is provisional for the proposed modules:
before filing, materialize the complete test bodies in a disposable fixture
and run `rmd test-place` against the then-current population; use its computed
folder rather than preserving a stale location by exception. Include the root
helper import in each final file. Do not add tests directly under `test/`.

| Proposed proof | Explicit behavioral imports and required assertions |
| --- | --- |
| `unit test: test/deploy/deploy-exit-receipts.test.ts` | `parseDeployReceipt` from `#src/lib/deploy-exit-receipts.js`; `escalationSpoolDir` from `#src/lib/host-escalation-spool.js`. Exercise actual serialization/drain in fixture directories: accepted id/digest, duplicate replay, collision, atomic visibility, acknowledgement loss, absent versus unreadable directories, unwritable/full/rename failure, bad owner/mode, malformed/oversized/duplicate-key JSON, symlink/FIFO/traversal rejection. Assert no raw bytes or false delivery acknowledgement in any durable output. |
| `unit test: test/deploy/deploy-recovery-sandbox.test.ts` | `runRecoveryDiagnosis` from `#src/lib/deploy-recovery-sandbox.js`; `assessContainment` from `#src/lib/containment.js`. Use a local deterministic model-protocol stub and the real confined tool service. Assert allowed Read/Grep/Glob succeed and attempted write, shell, socket/DNS, credential read, absolute/parent/symlink/magic-link escape and raced path swap all fail, with zero external sentinel changes. Test log/repo prompt injection, budgets, forbidden tools, malformed/extra/duplicate fields, multiple commands, unsafe reason, missing SHA, missing isolation and unavailable model. Check distinct unavailable/completed-no-command outcomes. |
| `unit test: test/deploy/deploy-recovery-inbox.test.ts` | `reconcileDeployRecovery` from `#src/lib/deploy-recovery.js`; `updateProposalRegistry` from `#src/lib/inbox.js`. Persist real fixture registry/receipt state; assert exactly one operator ASK for one failed/refused receipt, successes yield none, replay yields the same id, approve/edit/reject affect only decision records, stale approval conflicts, and no source/plan/deploy/action-executor effects occur. Drive W1-T6062 first and recovery first, then recurrent same-condition receipts: one active ASK, preserved count/lag and verified-recovery closure. |
| `unit test: test/deploy/deploy-recovery-feedback.test.ts` | `reconcileDeployRecovery` from `#src/lib/deploy-recovery.js`; `stageFeedbackCapture` from `#src/lib/feedback.js`. Completed defect captures exactly one entry naming script/receipt/snapshot/evidence through the real fixture queue; replay and concurrent reconcilers retain the submission key. Assert non-defect/unavailable creates none, unreadable lookup does not capture, normal triage/machine-filing still decides subsequent work, and no source edits or direct filing occurs. |
| `unit test: test/deploy/deploy-recovery-lifecycle.test.ts` | `reconcileDeployRecovery` from `#src/lib/deploy-recovery.js`; `escalationSpoolDir` from `#src/lib/host-escalation-spool.js`; `spawnSync` from `node:child_process`. Copy the real scripts and required siblings into a fixture; run Bash in the foreground with PATH adapters for Docker, registry login, id and other host commands. Invoke the real receiver/diagnosis/inbox flow with a deterministic model response. Assert exit status, cleanup, receipt count, ASK count and zero recovery executions from effects on disk, not source-string matches. |

The lifecycle suite's load-bearing case runs ordinary recycle with an invalid
or unresolved declared instance at preflight, before PAUSE/pull/stop. It must
exit with the existing refusal status and emit exactly one terminal receipt;
after core ingestion it must stage exactly one ASK. The adapter command log
must contain zero Docker lifecycle mutations and the recovery execution spy
must remain zero, including after approve and edit. Run the same case in
commissioning mode without counting the compatibility receipt twice. A valid
sibling instance is a positive control: it proceeds beyond that preflight
under the same adapters, proving the refusal was actually reached and was not
caused by a broken fixture or globally denied PATH.

Also drive host-update successful changed/unchanged pulls and a nonzero pull
failure; sudo refusal; help/argument/missing-value exits; dry-run,
print-daemon-run, check/relocate/reclaim-only; early and late HUP/INT/TERM;
mktemp/cleanup/lock failures; failure after commissioning verification; and
ordinary successful recycle. Assert original status, exact-body PAUSE rules,
cleanup completion and receipt mode/phase/outcome. Stubbed success is evidence
of the script contract, not proof that a live image shipped. A SIGKILL fixture
must demonstrate the documented absence of a terminal receipt and retention
of an incomplete marker, never claim EXIT can handle it.

Inject distinctive author, token, private-key, environment and hostile log
sentinels. Scan receipt, pending/ack state, ledger additions, ASK and feedback
for absence of each value, paired with presence of a safe event/id sentinel so
an empty pipeline cannot pass. Inject NUL, ANSI, bidi and oversized multibyte
input; unsafe tails must be omitted before the first persistent write.
Prove real isolation with both an accessible fixture control and inaccessible
credential/network targets; a failed model call alone proves no containment.

At every boundary, terminate and restart the fixture core: before/after receipt
commit and host ACK; lease claim; model response and result commit; ASK intent,
registry publication and ACK; operator decision and ACK; feedback intent,
queue capture, landing and linkage ACK. Reload state from disk in a new
process. Replay the same receipt with concurrent drains and restore a stale
pending copy after payload expiry. Assert one result identity, one ASK link,
one defect submission key, bounded API attempts, no lost pending work and zero
executions. Test core down, transport unwritable/unreadable, registry unavailable
and model unavailable separately; failure in one is never reported as delivery
or completion of another.

Remove-the-fix falsifiers are required in the successor PR evidence. Disable
early dispatcher registration: the real recycle preflight case must fail its
one-receipt/one-ASK assertions. Disable receipt-keyed publication upsert:
publication-before-ACK restart must duplicate and fail. Disable the safe-tail
filter: a secret sentinel must leak and fail. Disable the recovery decision
branch: approval must attempt a forbidden normal ratification/action and fail.
For each mutation report actual `# fail N` with N greater than zero, then
`# fail 0` restored. Do not weaken gates to make the mutation pass. No live
deployment, credential access or external recovery command is acceptance proof.

## Bounded successor plan

The overlap sweep read all 4,372 local `plan/tasks.d/*.yaml` records, the 269
legacy records in `plan/tasks.yaml` (no receipt/diagnosis subject hit), and the
authenticated recursive main tree (11,020 entries, not truncated). Known
ownership is W1-T6160 commissioning, W1-T6062 repeated refusal and W1-T3199
deployment authority. W1-T9921 concerns `deploy-run` process exit/telemetry,
not terminal receipts from these two Bash scripts. W1-T10350 concerns the
machine-filing backstop's path classification, including this document; do not
use it to lower this design's risk or skip its human review.

The open-PR API returned 11 heads, all recursively read with non-truncated
trees and a recycler-path positive control in every tree. Compared to pinned
main, counts of added/changed blob paths were:

| PR | Head SHA | Added/changed blobs | Design path present |
| --- | --- | ---: | --- |
| #13982 | `f4d912b8cd6128f3396659cd2b08c328e7d0e7ac` | 8 | no |
| #13980 | `ebc92b950e1822c5045330bfaa80fc6cebc1a71e` | 8 | no |
| #13979 | `e62b8b9b23b0d38c2b0da9974f3908c9518bc8b5` | 12 | no |
| #13969 | `b54667e85211e543f13aaec5e4220c3e332ac127` | 26 | no |
| #13959 | `2eec5cf90e5a436a965d03eea40b30d9957c2e34` | 94 | no |
| #13958 | `7da7a274bfab07ef31152185b70c8e167ef7a4bd` | 33 | no |
| #13952 | `b798493b0a40fe8fc7ae23b12018d3ce9b504bcc` | 6 | no |
| #13946 | `f061f94c8e9795ec37d6b9af09fdecd748e81c3c` | 21 | no |
| #13895 | `6b50ce7fba830860c17073bf73b8a9bd320d0690` | 101 | no |
| #13868 | `5ae6573769571b14db6004b8314f443d7cc7be5f` | 38 | no |
| #13851 | `266931201899196e8635cf52a07a8ac9599bdafc` | 17 | no |

This comparison counts blobs, not directories or commit subjects, and includes
base lag rather than assuming every difference is newly authored. All 39 unique
changed blobs covering plan task records, the two scripts and existing receipt/
spool/inbox/feedback integration files were fetched and searched for the
receipt/diagnosis subject. The older recycler blob on several heads retains
commissioning-only receipt functions; no new general receipt or recovery
diagnosis implementation was found in that bounded subject sweep. Other deploy
tree differences and unrelated PRs are not a proof about live fleet behavior.
Refresh this overlap/owner evidence before filing any successor.

The following are recommendations for human review, not minted tasks or
authorization to implement. Module names denote proposed interfaces used by
the proof sketches; each filing must recheck installed schemas and placement.

| Slice and dependency | Concrete proposed files | Proofs and filing rationale |
| --- | --- | --- |
| Receipt schema and durable ingress; after design acceptance | New `src/lib/deploy-exit-receipts.ts`; narrowly extract/reuse atomic spool support from `src/lib/host-escalation-spool.ts`; new receipts suite above. | Whole-file receipts proof. High risk: untrusted host data and persistent state. Require operator review and explicit hostile-input/delivery evidence; existing escalation union/keys remain compatible. |
| Shell terminal lifecycle; after receipt schema/ingress | New `deploy/exit-receipt.sh`; `deploy/recycle-container.sh`; `deploy/host-update.sh`; lifecycle suite. Declare any installation/copy manifests and host dependency checks found by the caller sweep before filing. | Whole-file lifecycle proof, including early-refusal falsifier and both script status/cleanup paths. High risk deploy surface; preserve W1-T6160 contract and portability, no Node dependency. Coordinate with current deploy owners and W1-T9921 without widening into deploy-run teardown. |
| Enforced diagnosis boundary; after schema, independently reviewable from shell integration | New `src/lib/deploy-recovery-sandbox.ts`; sandbox suite; reuse only verified containment primitives from `src/lib/containment.ts`, declaring that file if modified. | Whole-file sandbox proof with real OS confinement and model transport stub. High risk security boundary; machine filing must escalate absent operator-approved isolation evidence. Fail closed when enforcement is unavailable. |
| Durable coordinator and decision-only inbox; after ingress and sandbox | New `src/lib/deploy-recovery.ts`; `src/lib/inbox.ts`; `src/lib/inbox-owner.ts`; `src/lib/inbox-verdict-command.ts`; `src/lib/panel-graph.ts`; scoped action/schema declarations reached by those interfaces; `src/lib/deploy-refusal-escalation.ts`; core freshness wiring in `src/run-task.ts`; inbox and lifecycle suites. | Whole-file inbox/lifecycle proofs with restart injection and W1-T6062 ordering. High risk: ASK dedup, approvals and lifecycle wiring. Filing must enumerate actual action/contract consumers, preserve existing refusal closure and prove zero execution on every decision. |
| Linked defect feedback; after durable coordinator | `src/lib/deploy-recovery.ts`; `src/lib/feedback.ts` only if a producer adapter is required; feedback suite. Reuse `stageFeedbackCapture`, queue landing, triage and machine-filing rather than another writer. | Whole-file feedback proof through real fixture capture/queue and acknowledgement failures. High risk inherited from untrusted diagnosis-to-work boundary; no direct shard/source writer. A completed defect is evidence to triage, not automatic authority to repair. |

Each slice needs its own bounded files, dependencies, executable whole-file
proof and remove-the-fix evidence at filing. Risk/verification is judged through
the normal machine-filing lane; a high-risk slice is not pre-cleared by the
design's operator release. Human review must accept the transport mapping,
resource budgets, retention/tombstone policy, isolation implementation and
shared refusal-ASK behavior, or revise them before implementation records are
filed. These reviews do not introduce a human approval gate for ordinary
change-and-risk deployment. This task mints no ids and files no successor shards.
