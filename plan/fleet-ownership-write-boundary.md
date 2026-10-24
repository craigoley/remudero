# Fleet ownership at a write boundary

Design for W1-T10204. This document recommends a repository contract; it installs no
guard, changes no claims or historical tasks, and makes no claim of executable coverage.
The boundary protects both an implementation PR's head and the task contract consumed
by that implementation, including an amendment published from a different branch.

## Grounding and existing callers

The task record was checked against current main before drafting. It contains no
file:line citations to revalidate. The following symbols were located and read in this
checkout; these are the integration points, rather than historical line numbers.

| Existing path and symbol | Relevant behavior and limit |
| --- | --- |
| `src/lib/status.ts`: `taskIdFromRunBranch` | Extracts a task-shaped capture from `run-<id>-<epochMs>`, rejecting stapled suffixes. A synthetic lane id or `unfiled` is not a filed target. |
| `src/lib/review.ts`: `extractTaskTrailerId`, `taskIdDeclarationsInDiff` | Trailer extraction is anchored and last-wins. Declaration extraction alone cannot discover an existing task whose proof changed. |
| `src/lib/tick-read-worker.ts`: `resolveReviewTaskId`, called by `resolveOpenPrTaskId` and `src/run-task.ts`'s review command | Trailer first; a positively identified filing has no branch fallback; otherwise use the run-branch extractor. These are PR identity rules, not amendment-target discovery. |
| `scripts/head-identity-gate.mjs`: `evaluateHeadIdentityGate` | Admits a head's identity form. It does not establish ownership of every task that head edits. |
| `src/lib/dispatch-claim.ts`: `dispatchClaimRef`, `claimListingFromLsRemote`, `parseClaimAnchorMessage`, `parseClaimRenewal` | Supplies the task claim namespace and anchor/renewal decoding. `holderFromLsRemote` and the reserver's `holder` collapse read failure into `undefined`; do not use that as absence. |
| `src/run-task.ts`: `prOwnerCommand`, `derivePrOwnerVerdict`, `readPrOwnerClaims` | Existing diagnostic reads ledger and local in-flight branch claims. An old `fix.dispatch` can still yield `OWNED`; its verdict alone is insufficient for the proposed terminal and generation rules. |
| `src/lib/sweep.ts`: `fixSeedRead`, `fixRoundClaimId`, `deriveDisposition`, `lastProgressJudgementFor` | Reads ordered fix seeds and continuation state, names round claims, chooses repair dispositions, and rejects stale red-class judgments. Reuse these semantics instead of interpreting every checkpoint as live. |
| `src/run-task.ts`: `runFixRung`, `buildProofAmendmentWritePorts` | Writes `fix.dispatch`, `fix.done`, and `fix.stood_down`; supplies the proof-amendment filesystem and publication ports. Round receipts include `round_id`, input `head_sha`, and where available `pushed_head_sha` and `branch_claim_run_id`. |
| `src/lib/proof-amendment.ts`: `requestProofAmendment` | Validates replacements, then calls `deps.writeFile`, commits and pushes a separate amendment branch. The same fleet repair must remain admissible. |
| `src/lib/refusal-amendment.ts`: `draftRefusalAmendment`; `src/lib/sweep.ts`: `buildSweepEffects` | The former computes the amendment and invokes `openAmendmentPr`; the latter's port creates the checkout, writes the shard and publishes it. Both can check before the local write. |
| `src/lib/plan-pr-emitter.ts`: `planPrPreflight`, `planPrPreflightAtCommitAsync` | Publication checks can examine an exact prospective commit, including a commit-tree producer whose checkout HEAD differs. They do not intercept editor writes. |
| `hooks/pre-push`; `src/lib/git-push.ts`: `createPrePushSandboxRunner` | The hook captures stdin into `push_lines`, runs harness-owned gates against checkout data, and warns on unreadable evidence. Worker code may run only through the existing sandbox boundary. |
| `src/lib/operator-interventions.ts`: `prCauseClass` | Existing intervention classification uses the disposition at the action's time. Intervention accounting is evidence of an action, not permission for one. |

W1-T5859 supplies voluntary hand-build claims, not write interception. W1-T8264
supplies intervention accounting, not authorization. W1-T3600 concerns dependency
eligibility; its historically proposed `scripts/run-branch-eligibility-check.mjs`
is absent here and is not an implementation dependency. W1-T7762 requires a new red
class to receive a fresh judgment. MASTER-PLAN §7B routes feedback into an Architect
proposal, rather than granting an implement worker task-edit authority.

The retained W1-T8921 correction says #11201's own round `277b273e4` made its proofs
discriminate before the amendment's impossibility assertion was corrected. The task
reports the race across #11225, #11201 and #11232; that history motivates this boundary,
but proves no present ownership. Preserve the correction and the historical records.
The standing `doctrine/plan-and-task-hygiene/leave-red-prs-to-the-fix-lane.md` permits
hand takeover after exhaustion or escalation, while reserving due/in-flight rounds.

## Touched-task identity contract

Derive a set of target records, each with `{repository, taskId, reason, remoteRef,
oldSha, newSha, oldPath?, newPath?, prNumber?, expectedPrHead?}`. Keep reasons and
before/after provenance; unioning ids must not discard the PR or update they came from.

1. Parse **every** pre-push stdin tuple `(localRef, localSha, remoteRef, remoteSha)`.
   Inspect the destination ref and its actual outgoing object, not the checked-out
   branch, first non-deletion line, or HEAD. Resolve repository identity from the
   destination remote and PR base repository; another repository's same task id is
   not evidence. Ambiguous remote mapping is UNKNOWN.
2. For each head update, locate open PRs by repository and exact destination head,
   then apply `resolveReviewTaskId` and `taskIdFromRunBranch`. Retain conflicting
   branch/trailer evidence and query both plausible filed targets; never silently
   choose the id that has no owner. Mark unresolved conflict UNKNOWN. A branch id
   identifies its direct head write; it does not replace semantic targets below.
3. Parse before/after task YAML with `parseTasksFromYaml` in `src/lib/plan.ts`,
   indexing records by declared id across `plan/tasks.yaml` and `plan/tasks.d/*.yaml`.
   Compare complete normalized record values, not changed-line id declarations.
   Include edits to acceptance, design, files, dependencies and other task fields,
   additions, deletions, and ids changed in place (both old and new ids). A move or
   rename retains its id as a target with both paths even if its values are equal.
   Duplicate ids, malformed YAML and missing old blobs are unavailable derivation,
   never an empty target set. Do not read the plan working tree instead of outgoing
   blobs. YAML reformatting alone is not a semantic amendment; refusal/handoff
   markers that callers consume from comments must also be compared explicitly.
4. For an existing destination use its advertised remote tip as the before tree,
   even for a force-push. For a new branch use its merge base with the pinned,
   advertised destination main tip. An all-zero old sha is not an empty plan that
   makes every existing task an addition. For a deletion retain the old head's PR
   and task targets and classify it as a destructive head update; there is no new
   task tree. A deleted task file within a non-deletion update uses the normal
   before/after comparison. Missing ancestry is UNKNOWN, not an exemption.
5. Consider task-changing blobs in other outgoing commit-bearing refs too; a
   missing/unpeelable object yields UNKNOWN if its contents cannot be classified.
   Known dispatch-reservation refs keep their existing dedicated CAS path and are
   not interpreted as task-plan amendments. This design grants no authority to
   mutate them. Deduplicate queries across the union, not updates themselves.

A TRIAGE/filing branch amending task A targets A even if its own correlation id is
B. A monolith or shard edit changing A and C must check both. Direct writes to A's
implementation branch target its PR even when no plan file changes. An unrelated
push with positively readable identity and task diff has no ownership target and
requires no remote ownership reads.

Controlled amendment producers have before/after bytes and a target before writing:
check there first, and repeat against the eventual outgoing commit at publication.
For arbitrary shell/editor writes the first dependable common observation is
pre-push. A hook cannot stop an editor from changing a local shard. PR-body edits
and GitHub update-branch API calls bypass pre-push; a future authorized integration
must check their caller before invoking that API. This is not a server-side lock.

## Ownership evidence contract

Each read returns one of `present(value)`, `absent(control)`, or
`unavailable(failure)`, with `{source, repository, observedAt, generation,
corpusNewestTs?, query, failure?: {kind, status?, message}}`. Preserve stderr,
partial results and parse failures. An unavailable source stays visible even when
another source provides enough positive evidence to refuse a write.

| Source | Required binding and control |
| --- | --- |
| Remote `refs/rmd-dispatch/<taskId>` listing | Preserve exact ref and holder object id, listing status and time. Prefer `claimListingFromLsRemote`'s tagged result over `holderFromLsRemote`. Read the requested namespace with an independent known repository ref such as main in the same remote session; verify that expected ref resolves. Successful empty claim output without that positive control is unavailable. |
| Holder anchor and renewal | Read the exact listed holder object; decode host, pid, mint time and optional renewal. The anchor is a generation identifier, not authenticated user identity. Record raw message/parse failure. Do not replace a missing anchor with the caller's git author identity. Existing claim lease/release semantics remain in `dispatch-claim.ts`; age alone does not authorize this guard to clear or ignore a contested claim. |
| PR identity, state and head | Read repository, number, URL, base/head repositories, head ref, full head sha, body identity and API merge/closed state. A successful repository metadata/main read controls an empty exact-head PR search. Preserve pagination/completeness. Existing task identity rules govern identity; API state governs merge state. |
| Fix checkpoint and disposition history | Read the ledger union through `src/lib/ledger-union.ts`, covering live `.ndjson`, rotated `.ndjson` and `.ndjson.gz` forms. Carry files opened, per-form file counts, unread paths, newest timestamp, producer generation/watermark and source row references. A real unrelated known row is the corpus control, not an empty successful parse. Verify the window covers the PR's latest head/round; a stale mirror is unavailable for a present-tense negative. |
| Fix activity and caller authority | Join `sweep.disposed` fields (`pr_number`, `head_sha`, `task_id`, `disposition`, `blocker`, `blocker_owner`, `acted`) with `fix.dispatch`, `fix.done`, `fix.stood_down`, `fix.progress_judged`, and the branch claim/process evidence consumed by `fixSeedRead`. Retain `run_id`, `round_id`, claim id, strike, red class and ordered row references where present. Task-only legacy rows cannot authorize a head/round-specific write. |

The proposed normalized snapshot binds `{repository, taskId, prNumber?, headSha?,
claimHolder?, ownerRunId?, roundId?, branchClaimId?, redClass?, contractDigest,
ledgerWatermark, observedAt}`. It distinguishes current live ownership, proven
absence/relinquishment, and unknown ownership. A task claim can exist before a PR;
do not require a PR number to protect that build. A task ref can be absent during
fixing; current due/in-flight fix evidence can establish ownership independently.
The local shard's `status`, git author/email, an elapsed TTL, `run.done`'s generic
`handed_off`, or a lone recent checkpoint cannot establish release.

Evidence of a due round means the latest applicable repair disposition still
assigns the blocker to the fix lane, without a superseding stop or terminal state.
In-flight means a matching dispatch/continuation and branch-claim liveness read,
using `fixSeedRead` ordering. `fix.done` ends that round, not necessarily the lane:
the next due disposition can still reserve repair. `fix.stood_down` with
`site: rung.ci_handoff`, `outcome: handed_off`, `owner: sweep` is an internal lane
handoff, not permission for a hand push. Worker-boundary checkpoints similarly
preserve continuation rather than grant it to an operator.

An authorized owner must match trusted caller context to the exact claim/run/round
and intended target/action. Trusted harness ports can supply and corroborate that
context; a self-reported environment flag or copied anchor sha cannot. A hand-build
claim must be correlated to its holder's actual invocation. Where that correlation
is unavailable, report UNKNOWN rather than calling the same git author the owner.
The later implementation must expose verifiable context to the harness-owned hook
without executing untrusted checkout code as the daemon.

Batch one bounded remote-ref read per repository, one PR corpus read (plus bounded
pagination) and one ledger snapshot per invocation; anchor decoding costs at most
one fetch/read per distinct holder. Deduplicate task lookups. Reuse immutable
object bodies by sha; do not reuse an earlier invocation's mutable head, ref,
disposition or handoff authorization as current. Capture durations and timeout
failures. Remote/mirror evidence lacking a current producer watermark cannot prove
absence. Immediately before publication re-read mutable PR heads and claim tips,
and verify the ledger generation/authorization still applies. A changed generation
requires a fresh decision; bounded unsuccessful refresh becomes UNKNOWN.

There remains a check-to-write race after the last read: a new round can start
before the push arrives. Existing expected-head/lease checks narrow head races but
do not atomically lock the independent dispatch ref, task plan and PR. Atomic
cross-resource exclusion or mandatory fail-closed transport policy would require
a separately approved stronger design, not a claim that this hook eliminates races.

## Write-boundary decision table

Outcomes are `ADMIT`, `REFUSE_CONFLICT`, and `UNKNOWN_WARN`. UNKNOWN emits a distinct
warning with missing sources and proceeds under the existing hand-route precheck
degradation policy; it is neither FREE nor a passed ownership check. Proposed hook
exit codes are 0 for admission, 1 for a proven conflict, and 2 for UNKNOWN; the
hook follows its existing status-2 warning path. Changing UNKNOWN into a refusal
needs separate operator approval. This does not loosen the existing fail-closed
dispatch-claim acquisition policy.

Evaluate each target independently, then refuse the whole push if any target has
a proven conflict; otherwise warn if any is unknown; otherwise admit. An unavailable
ledger cannot cancel positive, sufficient foreign-owner evidence from other sources.
Nor can a positive claim be called a *live repair round* without the requisite
round evidence. Reasons must state which ownership surface established the conflict.

| Current evidence and caller | Decision | Boundary and explanation |
| --- | --- | --- |
| Foreign live owner; current repair is due or in flight | REFUSE_CONFLICT | Before a controlled amendment's local write and again before publication, including an amendment on another branch. Name task, owner, PR/head and round. |
| Foreign active task-build claim before any PR; no release | REFUSE_CONFLICT | Protect the same target contract; do not require a repair checkpoint to protect a claimed build. |
| Same evidenced owner, target and current generation | ADMIT | Permit its direct fix push and its authorized proof/scope amendment. Keep all existing proposal validation, Rule 15 and preflight checks. |
| Exhausted/escalated owner with valid recipient-specific takeover record and no newer activity | ADMIT | The recipient may repair/amend without deleting a contested claim; this is the handoff contract below. |
| Controlled readable corpus proves no current owner | ADMIT | No ownership conflict; other admission checks still apply. |
| Complete terminal evidence supersedes historical checkpoint; no new target generation | ADMIT | Finished work is not locked by a recent checkpoint or obsolete claim observation. |
| Required ref/anchor, PR, ledger, target derivation or caller-authority evidence unavailable; no independently proven conflict | UNKNOWN_WARN | Print exact failed read and provenance before proceeding. Never manufacture absence or an owner exemption. |
| Positively unrelated update | ADMIT | Skip ownership queries; still run the existing applicable push gates. |

| Caller | Earliest observable check and repeated boundary |
| --- | --- |
| Operator/editor, direct PR-head push, multi-ref push | `hooks/pre-push` receives all outgoing tuples. Prevent publication only; local writes already happened. Its existing first-head selection is insufficient for this check. |
| `requestProofAmendment` through `buildProofAmendmentWritePorts` | Check validated proposed bytes before `deps.writeFile`; carry the originating repair's authority onto the separate amendment branch, then recheck before `deps.gitPush`. A fleet identity label alone is insufficient. |
| `draftRefusalAmendment` through `buildSweepEffects`'s `openAmendmentPr` | Check computed target/bytes before the port writes the shard, then recheck the exact committed tree before publication. Preserve refusal provenance. |
| Other machine plan producers using `planPrPreflightAtCommitAsync` | Check at the producer before its write where available; the common committed-tree preflight can only prevent publication. Include outgoing commit sha rather than assuming checkout HEAD. |
| Existing fleet `runFixRung` and resumed rounds | Match live round/branch-claim context at the same publication boundary. Do not exempt all fleet processes; a different fleet round is a foreign owner too. |
| GitHub API update-branch or body amendment | Check in its controlled caller immediately before the API write; pre-push cannot observe the API action. Body identity changes target both old/new identities. |

The design adds no blanket bypass, advisory-ignore, claim deletion, gate exclusion,
or fleet auto-merge disablement. Existing controls remain independent of ownership.

## Handoff and expiry contract

Existing exhaustion/escalation evidence must be identified by structured fields,
not the word "exhausted" in prose:

- In `src/lib/sweep.ts`, `isFixStrikeJudgedExhausted` requires exhausted progress
  **and** `progressEscalation`, or the repeated-refusal stop without a continue
  judgment. `deriveDisposition` emits `blocked-ambiguous` / `strikes-exhausted`.
  Reaching a former strike cap alone makes a judgment due, not a takeover grant.
- In `runFixRung`, a current `fix.progress_judged` verdict `escalate` leads to a
  BLOCKED escalation; verdict `unavailable` returns `handed_off` and is not one.
  Use the delivered escalation/disposition, current head, red class, contract
  revision and input key, not an older judge label. `lastProgressJudgementFor`
  explicitly withholds a verdict when the red class changed.
- `fix.needs_design` paired with `fix.stood_down`, `site: rung.needs_design`, and
  a delivered `issue_url` is explicit design escalation for that head. Other
  `blocked-ambiguous` states must carry their actual delivered escalation cause;
  a transport failure delivering an escalation is not delivered handoff evidence.

Exhaustion or escalation makes takeover eligible. It does not identify who took
it. The proposed explicit handoff record (new contract, not an existing ledger
step) contains `{repository, taskId, prNumber?, targetHead, allowedActions,
fromOwnerRunId, recipientIdentity, claimHolder?, branchClaimId?, roundId?,
redClass?, contractDigest, evidenceGeneration, stopRowRefs, escalationUrl?,
issuedAt, expiresAt, issuerIdentity, reason}`. Store it through a trusted existing
control/ledger writer in a later implementation, with an acknowledgement by the
named recipient. The relinquishing owner can issue it, or an authorized operator
can issue it after verifying the structured stop; a dead/exhausted lane need not
respond to permit takeover. A plain text record asserted by the proposed recipient
without verified issuer authority is not authorization. Intervention accounting
may record the resulting action but cannot retroactively authorize it.

Validate the record against the current snapshot and action. `expiresAt` is an
upper validity bound, not evidence that someone else's ownership expired. It is
single-use for the named publication or bounded amendment operation, invalid once
consumed, expired, revoked, or mismatched. Do not clear the old claim to enable
takeover. Keep its holder in the receipt as superseded for this authorized action.

Read supersession in this order:

1. Verify current PR state using the API. A merged PR, or an explicitly terminal
   closed PR with its matching terminal disposition, ends that PR generation.
   Historical dispatch/checkpoint rows do not override it because they are recent.
   An unrelated or newly claimed build/PR generation for the task is checked
   separately, so merging an old PR cannot release someone else's new build.
2. Apply ordered round completion and structured exhaustion/escalation for the
   current PR/head/contract. A completed round that awaits another due round still
   belongs to the lane. Do not confuse internal sweep handoff with operator handoff.
3. Validate the explicit recipient record against that generation. A later dispatch,
   resumed continuation, changed head, changed claim holder/round, new red class,
   changed task contract, or explicit rearm invalidates it immediately, even before
   its wall-clock expiry. Require new authorization against the new snapshot.

If ordering/completeness is unknown, report UNKNOWN rather than borrowing a prior
generation's grant. Age never permanently reserves finished work and never on its
own transfers unfinished work.

## Falsifier matrix

These are future executable fixtures, not tests added by this design. Use a local
disposable Git remote, fake PR snapshots, ordered ledger rows with explicit corpus
controls and a recording filesystem/push/API port. Each fixture asserts the outcome,
diagnostic provenance and write count. No live fleet state is needed.

| Fixture inputs | Expected observable result |
| --- | --- |
| Task A claim H owned by run F; current PR P@h has due `blocked-fixable` / `fix-lane` disposition; caller X | REFUSE_CONFLICT naming A/P/h/F; zero publication calls. Repeat with matching in-flight dispatch and round R. |
| Same facts, caller verified as F/R/H | ADMIT and exactly one intended publication. Same git email without verified context does not satisfy this fixture. |
| Caller X on `run-TRIAGE-…`; only A's proof changes; A owned by F/R | Target A from semantic diff; refuse before controlled local write (zero writes) or before editor publication (zero pushes). |
| One outgoing update changes A and B in one shard/monolith; another updates C's PR head; only B is foreign-owned | All A/B/C queried; entire push refused. Put B in the second stdin tuple to catch first-ref-only guards. |
| Rename A's shard, delete B's record, change C's declared id to D | Targets A/B/C/D retained with old/new paths; each foreign-owner variant refuses. Pure YAML reformat has no semantic target. |
| New unrelated branch with a complete unchanged plan; explicit `HEAD:refs/heads/run-A-…` update; separate branch deletion | New branch does not target the whole plan; explicit destination targets A independent of checkout; deletion checks old PR ownership. |
| Ref listing fails, anchor cannot be decoded, ledger rotation unreadable, or PR query fails (one failure per case) | UNKNOWN_WARN with that source/failure preserved; publication follows warning policy; no FREE verdict. A second independently proven conflict still refuses. |
| Successful empty namespace/search with known main/repository controls and complete fresh ledger containing an unrelated control row | Proven absence, ADMIT. Remove each positive control or newest watermark in turn: UNKNOWN_WARN, not absence. |
| F stopped with current judged exhaustion and delivered escalation; trusted record grants X this action at generation G | ADMIT for X without any claim deletion, zero claim mutation calls. Wrong recipient/action remains conflict or UNKNOWN if identity cannot be verified. |
| Same exhaustion count but no stop judgment; judge unavailable; or internal `rung.ci_handoff` to sweep | No takeover grant; current foreign ownership refuses, missing stop evidence remains UNKNOWN. |
| Valid X grant at G followed by resumed/new F round R2, new claim tip H2, or changed head/red class/contract | Old grant rejected in each variant; foreign live round refuses. |
| Recent dispatch/checkpoint followed by API merged/terminal evidence for that generation, no newer build | ADMIT; no indefinite ownership from checkpoint recency. Add a new active task generation: check it separately and refuse its foreign writer. |
| Readable unrelated push with no direct PR target and no task changes | ADMIT with zero ownership transport calls. |
| Authorized F proof amendment calls `requestProofAmendment` on another branch | Before-write and pre-publication checks both admit; proposal validation still runs; exactly one shard write and push. Substitute another round's authority: zero writes. |
| Claim/head/ledger generation changes between initial check and final publication read | Recompute; refuse a now-proven foreign owner, or warn UNKNOWN on unavailable refresh. No reuse of stale ADMIT. |

Mutation requirements for the later tests: remove the check from each controlled
write/publication port and the foreign-owner fixtures must show unexpected writes
or pushes and fail. Replace unavailable evidence with absent and the failure/control
fixtures must fail on outcome and diagnostic even though warning policy permits
publication. Restore the guard and require zero failing cases. Also remove terminal
supersession to make the recent-checkpoint/finished fixture fail, and remove owner
or takeover admission to make the corresponding permitted-write fixtures fail.
This distinguishes a protective guard from an unconditional refusal.

## Implementation slices

These are bounded proposals, not filed tasks or changes authorized by this PR.
Reserve/file them later through the operator workflow; no task ids are allocated
here. All production paths below exist in this checkout; test paths are proposed
new suites. Each proof is a whole-file future unit proof, not currently executable.

| Slice and dependency | Nonempty `files` list | Intended imports, placement and future proof |
| --- | --- | --- |
| Evidence and generation decision; first | `[src/lib/dispatch-claim.ts, test/dispatch/fleet-ownership-evidence.test.ts]` | Import `#src/lib/dispatch-claim.js`. Preserve tagged read results and normalize injected PR/ledger facts; cover controls, generation/handoff/terminal ordering and caller authority. `unit test: test/dispatch/fleet-ownership-evidence.test.ts` |
| Outgoing semantic target derivation; independent of transport | `[src/lib/review.ts, test/review/fleet-ownership-targets.test.ts]` | Import `#src/lib/review.js` and `#src/lib/plan.js`; reuse existing identity helpers, parse before/after records. Cover all tuples, renames, deletions and multi-task edits. `unit test: test/review/fleet-ownership-targets.test.ts` |
| Publication adapter; after both preceding slices | `[hooks/pre-push, src/lib/git-push.ts, src/lib/plan-pr-emitter.ts, test/github/fleet-ownership-publication.test.ts]` | Import `#src/lib/git-push.js` to exercise the adapter; use a real disposable Git hook/remote for the default path. Add exact-commit machine-plan checks, trusted context, status-2 warning routing, all-ref stdin and last-read refresh. `unit test: test/github/fleet-ownership-publication.test.ts` |
| Controlled local amendment writers; after evidence/targets/publication | `[src/lib/proof-amendment.ts, src/lib/refusal-amendment.ts, src/lib/sweep.ts, src/run-task.ts, test/fix-lane/fleet-ownership-amendments.test.ts]` | Import `#src/lib/proof-amendment.js` and `#src/lib/refusal-amendment.js`; test ports before writing and carry verified originating-round context across branches. Add trusted handoff receipt plumbing and bounded ledger/PR reads at composition, preserving existing validators. `unit test: test/fix-lane/fleet-ownership-amendments.test.ts` |

The proposed import sets were run through `extractTestFeatures` / `placeFeatures`
from `src/lib/test-placement.ts` using the installed subsystem map: dispatch,
review (low confidence against plan), github, and fix-lane respectively. At filing,
compute final placement with `rmd test-place` using the complete test imports and
the current population; move paths and proofs together if the result changes.
Use `#src/*`, `#scripts/*`, `#test/*` imports and `REPO_ROOT` / `repoRoot()` from
`#test/helpers/repo-root.js` for fixtures. Do not add new suites directly under test/.

Each slice must run its whole-file proof, the caller sweep and its joined census
suites, with one test run at a time. Evidence adapters require real-default local
Git enumeration plus fixtures for each read/catch failure. Wiring fixtures must
assert denied writes and authorized repair writes, not just helper return values.
The later implementation owns deletion/mutation evidence; this design supplies
the cases and boundaries without claiming that enforcement has shipped.
