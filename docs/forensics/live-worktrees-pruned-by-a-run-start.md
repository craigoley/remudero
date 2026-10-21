# Live worktrees removed by a run's startup prune

W1-T10299: pruning safeguards differ; the October 20 incident's cause and live-worktree loss frequency remain unmeasured.

This record separates source inspection on 2026-10-21 from incident excerpts supplied by
`plan/tasks.d/W1-T10299-a-run-start-prune-removes-live-worktrees.yaml`. The task cites source
at `c89ef695b`; the installed source-size signal resolved both this checkout and local
`origin/main` to `7ecc691aaa5d7f6461524d7e934eae1fd967777c`. Its remote refresh failed
because shared Git metadata is read-only, so this is not a fresh remote or deployed-version
check. Symbols below were read again in this checkout. The task names symbols rather than
file:line citations.

All three acceptance grep targets were absent before this edit because this document did
not exist. Creating their headings proves document presence; it does not prove the incident
census is complete. This investigation changes documentation only.

## Incidents

**Census status: blocked on an authorized ledger export.** The requested window starts at
2026-10-14T00:00:00Z and must end at the newest timestamp in the exported corpus. This
session's permission profile explicitly denies `/home/node/Remudero/state`, including the
live ledger and rotations. No ledger connector is available. Inspection of
`src/lib/ledger-grep.ts` and `src/lib/ledger-union.ts` shows that the installed ledger reader
reads filesystem inputs; invoking it against the denied state would not provide an
authorized alternative. A repository search for the exact retro run ID and prune timestamp
found the task record, not an independent incident export.

The task reports a corpus newest timestamp of **2026-10-20T22:00:59Z**, covering rotations
named October 19/20 plus the live file. That does not establish coverage back to October 14.
The corpus's actual oldest/newest timestamps, file counts by rotation form, and completeness
have not been verified here. **The required 18:07:18.666Z positive control has not been
independently found in ledger data.** Finding its text in the task is a document-search
control only. Neither a zero count nor an exhaustive incident list is claimed.

The following is the supplied incident sequence, retained as a lead rather than relabeled
as a measured census. All times are UTC on 2026-10-20:

| Time | Evidence reported in the task record |
|---|---|
| 17:29:45 | `skill.staged` for `RETRO-1792517376313` |
| 17:39:48 | `worktree.reaped`, actor `daemon`, PID 125, run `DAEMON-1792515203010`, keeps the retro, W1-T10265, W1-T9408 and W1-T9851 trees as `live-pid` |
| 17:46:32 | W1-T10265 opens its PR; a subsequent `verdict` is `pr_open_yield` (exact verdict timestamp not supplied) |
| 17:48:59 | `retro.synthesized` for `RETRO-1792517376313` |
| 17:49:03 | `orientation.regenerated`, the retro's last row according to the task |
| 17:49:59 | W1-T9851 opens its PR |
| 18:05:27 | Pruning run `W1-T10029-1792519418355` starts |
| 18:07:18.666 | Its `worktree.prune`, actor `run_child`, ledger PID 9055, lane `run-task`, reports three removed trees, five removed branches and `skipped: []` |

The reported reaper keep preceded the prune by approximately 27 minutes 31 seconds. A
keep at 17:39:48 establishes neither continued PID ownership nor unchanged lock contents
at 18:07:18.666. The pruning row's PID is the actor's ledger PID, not a measurement of the
three lock holders or of PID visibility inside their execution environments.

Per-tree join status for that one reported removing event:

| Removed tree under `/home/node/Remudero/worktrees/` | Own run ID | Last own row before prune | First own row after prune | Verdict | Later work established? |
|---|---|---|---|---|---|
| `run-RETRO-1792517376313` | `RETRO-1792517376313` | Task reports `orientation.regenerated` at 17:49:03 | Unavailable | Unavailable; task reports neither preflight result | No; missing preflight is circumstantial evidence of interruption |
| `run-W1-T10265-1792515408406` | `W1-T10265-1792515408406` | Unavailable; task gives PR opening at 17:46:32 and later `pr_open_yield`, without a complete tail | Unavailable | `pr_open_yield` reported, timestamp unavailable | Unknown; PR opening/yield may precede legitimate teardown |
| `run-W1-T9851-1792515407955` | `W1-T9851-1792515407955` | Unavailable; task gives PR opening at 17:49:59, without a complete tail | Unavailable | Unavailable | Unknown; PR opening alone does not show continued work |

The five reported branch deletions are `run-DAEMON-1792515203010`,
`run-RETRO-1792517376313`, `run-W1-T10265-1792515408406`,
`run-W1-T9408-1792516351760` and `run-W1-T9851-1792515407955`. W1-T9408 and
the daemon appear only in the branch list for this event; they must not be counted as
additional removed worktrees.

The task's reported frequency is **182 prune rows, 51 removing at least one worktree**:
30 removing events on October 19 and 21 on October 20. Its removing-event breakdown is
30 `run_child/run-task`, 15 `daemon/daemon`, three `daemon/approve`, one `daemon/triage`,
one `daemon/run-task` and one `unknown/triage`. These figures are unverified here and count
events, not trees, runs, or live losses. The number of live trees lost and its denominator
are **unknown**, including whether the retro was still running at deletion.

To complete the census, an authorized reader must export the deduplicated union of
`ledger.*.ndjson.gz`, `ledger.*.ndjson` and `ledger.ndjson`, with a file-count manifest for
each form and timestamp coverage. Preserve all own-run rows for affected IDs, including
rows before October 14 and after the removing event, rather than exporting only prune rows.
Require the exact 18:07:18.666Z event and its three tree paths as a positive control before
interpreting any absence. For each removing event, emit one row per removed tree, joined
by the complete run ID, with its last own row before, first own row after, terminal verdict
and any subsequent working row. Sort by timestamp and retain ties rather than inventing
an order. Count removing events, removed trees, distinct affected runs, demonstrated live
losses and unresolved cases separately. A later activity row must be attributed to the same
attempt and checked against checkout recreation; a missing row is not proof of death.

## Liveness by pruner

### Current lock contract and premise corrections

In `src/lib/worker.ts`, `runLockPath(path)` returns the sibling `${path}.lock`.
`RunLockInfo` contains `pid`, `run_id` and `startedAt`, without host, boot or PID-namespace
identity. `readRunLock` returns `live` when JSON contains a numeric PID; the name means
parsed, not proven alive. It returns `corrupt` for unparseable content, and `absent` on a
filesystem read exception, including exceptions other than a missing file.

The task's statement that nothing locks a retro worktree is false for this checkout.
`addLaneWorktree` in `src/run-task.ts` calls `addLockedRunWorktreeAsync`, which creates the
directory, calls `claimRunLock`, then awaits `worktreeAddAsync`. `claimRunLock` publishes
complete lock bytes using an exclusive hard link and refuses a different live process's lock through
`RunWorktreeHeldError`; failed adds remove their claimed lock. The sync
`addLockedRunWorktree` follows the same ordering. `runTaskBody` separately calls
`writeRunLock` before its own awaited add. Counting only callers of `writeRunLock` misses
the lane's direct lock publication. This correction does not establish what code executed
during the incident or whether its lock survived until pruning.

The policy comment's count of six startup-prune sites has also drifted. A source search
finds ten production calls to `pruneStaleRuns`, all in `src/run-task.ts`, all passing
`DEFAULT_PRUNE_GRACE_MS` and none supplying `isPidAlive`:

| Site, identified by enclosing symbol | Trigger |
|---|---|
| `runTaskBody` | Implement run startup |
| `retroCommand` | Retro worktree setup |
| `triageCommandLocked` | Triage worktree setup |
| `planCommand` | Plan worktree setup |
| `createDaemonLaneWorktree` | Daemon lane worktree setup |
| `freshSkillApproveWorktree` | Skill approval worktree setup |
| Single-approve gateway `completeRatificationBranch` | Approval resume |
| Single-approve gateway `createRatificationBranch` | Fresh approval |
| Single-approve gateway `joinRatificationBranch` | Join an existing approval PR |
| Batch-approve gateway `createRatificationBranch` | Batch approval |

### Predicate comparison

| Pruner | Inputs and keep conditions | Removal path and limits |
|---|---|---|
| Run-start `pruneStaleRuns` (`src/lib/worker.ts`) | Git's registered worktrees for the supplied repo, path prefix under the supplied root and `run-*` branch. A parsed lock keeps only if `defaultIsPidAlive(pid)` accepts. An absent/corrupt lock keeps while the root directory mtime is within the passed grace. | Force-removes eligible trees, removes their sibling lock/base records, prunes Git admin records, then attempts local branch deletion. No recursive activity, upstream-branch or review-lease keep. Parsed locks whose PID is rejected bypass the grace entirely. |
| Daemon/sweep `runWorktreeReapRung` → `reapStaleWorktrees` → `worktreeReapPass` (`src/lib/worker.ts`) | Enumerates directories, protects `reviewWorktreeIsHeld`, then a parsed lock accepted by `defaultIsPidAlive`. Keeps undecidable registration and branches accepted by `defaultBranchIsLiveUpstream`. Keeps an incomplete `newestActivityMs` probe; recent recursive activity rescues absent/corrupt locks. | Complete activity plus other terminal signals permits removal via `planWorktreeRemoval`/`executeWorktreeRemoval`. A parsed dead-PID lock defeats recent-activity rescue, but does not bypass the preceding review, registration, upstream or incomplete-probe guards. Explicit Git worktree locks also keep except `initializing`. |
| Boot `logWorktreeReapBootSurvey` (`src/run-task.ts`) | Uses the same reaper with `worktreeLockIsPidAlive`, which calls `isHolderStale` with PID and lock start time. Unlike the other defaults, it checks container boot/process start against the recorded time. | Survey-only unless both policy and ratification arm it; inherits the reaper's other keep conditions. A survey's candidates are not actual deletions. |

The daemon's `buildSweepHook` and `sweepCommand` call `runWorktreeReapRung` without a PID
override. The cadence reaper and startup prune therefore use the **same default PID
primitive**, not two intrinsically different PID algorithms. In `src/lib/drain-lock.ts`,
`defaultIsPidAlive` calls `process.kill(pid, 0)` and accepts success or `EPERM`; other
errors return false. This observes the caller's process namespace. Neither default verifies
that the PID still belongs to the recorded run. The boot wrapper's start-time comparison
helps reject reused PIDs; it does not make a foreign namespace's process visible.

`plan/policy.yaml` sets `pruneGraceMs` to 120,000 ms and `worktreeReapGraceMs` to
1,800,000 ms. `pruneStaleRuns` itself defaults an omitted `graceMs` to zero, while the ten
production sites explicitly pass the policy-derived constant. Root mtime is not the newest
write anywhere below the root; the cadence reaper uses a bounded recursive activity probe
excluding dependency/Git churn. These age measures are not interchangeable.

### Hypothesis disposition

| Hypothesis | What current source establishes | What the supplied incident does and does not establish |
|---|---|---|
| H1: retro is lockless and survives only 120 seconds | An old absent/corrupt lock can allow removal, but lane creation currently claims a lock before adding. A permanently lockless retro is not the current creation contract. | The reported earlier `live-pid` keep implies a parsed, accepted lock at that earlier time if current reaper semantics applied. It contradicts an always-lockless account. It does not rule out later lock removal/corruption, different deployed code or a read failure. No contemporaneous lock row rules those out. |
| H2: caller cannot see the lock holder's PID | Both default PID probes are local to their callers. Different namespaces can disagree even with identical lock bytes. A rejected parsed PID receives no startup grace. | Daemon keep followed by run-child deletion is consistent with a namespace mismatch, but also with the holder ending or the lock changing in the intervening 27 minutes. Actor labels/PIDs do not prove namespace separation. H2 remains plausible and unconfirmed; no supplied row excludes those alternatives. |
| H3: branch deletion overrides the worktree keep | `pruneStaleRuns` runs worktree removal before `git branch -D`. It attempts deletion for every local `run-*` branch, even skipped ones, and catches Git's rejection for a checked-out branch. | H3 cannot explain the three earlier force-removals under current control flow. Five branch deletions versus three removed trees is consistent with additional already-unattached branches. There is no independently read incident row proving how those two extra branches became unattached. |

Thus current source rejects H3 as the initiator of these worktree removals and rejects
H1's unconditional lockless-creation premise. It does **not** establish H2 as the incident's
root cause. To discriminate, recover the deployed code SHA, sibling lock bytes/read result
at both decisions, holder exit times, and the caller/holder boot and PID-namespace identities
plus PID probe errors. Current `worktree.prune` summaries do not record per-tree removal
reasons, lock snapshots or those identities. Their `skipped: []` cannot distinguish an
absent/corrupt lock from a parsed lock whose PID was rejected.

Existing behavioral checks cover the source-level distinctions:
`test/prune-liveness.test.ts` exercises real fixture worktrees for live/dead/absent locks,
grace and upstream-branch preservation; `test/worktree-reap-liveness.test.ts` covers nested
activity, dead-PID precedence and incomplete probes; `test/worktree-reap-pid-reuse.test.ts`
covers start-time-aware identity; and `test/every-lane-locks-its-worktree-before-adding-it.test.ts`
fires a real prune from a second process during lane creation. A second process in the
same namespace does not test H2, and none of these fixtures measures historical frequency.

On 2026-10-21 those four existing suites ran together, with TAP reporting `# tests 56`,
`# pass 56`, `# fail 0` and runner exit 0. No source change was made: this characterizes
the inspected source at `7ecc691aaa5d7f6461524d7e934eae1fd967777c`, not incident-time code.

## Remedy proposal

Use one worktree-owner decision for every pruner: **keep when ownership is live or
undetermined; allow removal only after the same evaluator establishes terminal ownership
and applies the existing review, branch, registration and activity safeguards.** Represent
the result as `live`, `terminal` or `unknown`, carrying a reason and the evidence used.
An invisible PID without matching namespace identity must be `unknown`, not terminal.

The bounded implementation proposal is to make startup pruning and cadence/boot reaping
consume that evaluator, retaining their enumeration and removal mechanisms. Preserve
lock-first creation; adding another retro lock writer would duplicate an existing contract.
Use `worktreeLockIsPidAlive`'s start-time checks where identities are comparable, but do
not simply substitute it for the bare PID probe: both can reject a holder outside the
caller's namespace. Establish a shared ownership authority or comparable host/boot/namespace
identity; treat legacy locks without sufficient identity conservatively. Include enough
decision evidence to explain a removal later. Apply the same owner decision before deleting
the associated branch rather than relying solely on Git's checked-out-branch rejection.

The implementation's required falsifier should replay the reported sequence in a disposable
fixture: a retro plus two implement trees; the daemon accepts their owners at 17:39:48;
the retro synthesizes and writes orientation around 17:49; a new run prunes at 18:07:18.666
while the retro's owner is still working. Keep root mtimes older than 120 seconds, keep
the retro branch local, and make the pruning caller unable to identify the live owner while
the ownership authority still can. Assert that all pruners preserve every live/unknown tree,
its lock, branch and unpublished commit, and that the retro can finish and record preflight.
Also drive a genuinely terminal owner with no protective branch/lease/activity signal and
assert reclamation, so a blanket keep does not pass. Include a corrupt/missing legacy lock
and PID-reuse cases. Remove the implementation and rerun to demonstrate that the failing
case depends on the fix; do not label a same-namespace second-process test as namespace proof.

This is a proposal, **not a filed implement task or an approved behavior change**. Filing
requires the operator checkout's reservation and a separate plan-only change; this task's
declared file is this investigation document. The operator must complete the evidence join
and file the bounded implementation separately before treating either the census or the
remedy as delivered. No plan criteria, pruning code, lock format or policy is changed here.
