## 2026-08-23 — W1-T1261 CLOSED UNBUILT (OPERATOR-RULED)

*Operator-ruled closure, recorded at the operator's instruction. Not a machine auto-choose
resolution.*

**Ruling: crash-resume is not worth building. W1-T1261 is closed unbuilt.** It was filed
`status: blocked` on purpose, with a gate that asked for two figures from the ledger union on the
daemon host before anyone dispatched it. Both figures were taken on 2026-08-23 and both answer
against building.

### The measurement, and who took it

Taken by the operator on the daemon host via `rmd ledger-grep` over the union of 21 archives.
**These figures were NOT re-derived by the session that wrote this file**, and the reason is worth
recording rather than glossing: the cloud container has the live ledger and ZERO archives, so
`rmd ledger-grep` refuses outright — *"ZERO archive files matched … refusing to answer from the
live ledger alone. A count from the live file only is the exact silent undercount this verb exists
to kill, so it is an error, never a smaller result."* That refusal is the verb behaving correctly,
and it is why the gate named the daemon host in the first place.

**`worker.abandoned` returns 2 matches, and both belong to one run** — `W1-T1213-1787428099336`:
the verdict row and its `worktree.remove`. **One event in the whole union.**

**And it was not a crash.** The reason reads *"worker abandoned: no observed stream activity for
7209637ms, past the 7200000ms clock bound (W1-T1045)"*, `cost_usd` 0.686. An existing guard
detected a stalled worker and terminated it correctly. The single instance the whole task was
filed around is a guard working, not a failure mode going unhandled.

**`daemon.orphan_sweep` reads `killed: 0` on every sampled row** — it has never killed anything.
The daemon host's sampled rows read `left_alone: 6`. `left_alone` is host-specific and should not
be read as a constant; `killed: 0` is the load-bearing half, and it was independently corroborated
on a second host: the cloud container's own live ledger carries three `daemon.orphan_sweep` rows
dated 2026-08-21, reading `killed: 0` with `left_alone` 82, 83 and 90.

**The control, stated explicitly: `run.start` returns rows freely over the same 21 archives.** The
counts above are ABSENCE, not a dead query. The control matters more than usual here, because the
same control FAILS on the container — `run.start` reads 0 there — which is precisely how a session
would have manufactured a false zero had it answered from the live file.

### Why that closes it

The population is one, it was handled by an existing guard, and the work a resume would recover is
the implement phase minus the cost of re-materializing a worktree and re-establishing context —
on an event that has occurred once. Recon repeats by design and is capped cheap; verify repeats by
design, because the reviewer is deliberately fresh. A bound that fires on a healthy condition is
this repository's named recurring defect, and building a recovery path for a population of one
would be another instance of it.

### What survives the close, and why this is the valuable part

Three facts were established while the task was open. A successor starts from them rather than
from scratch:

1. **`InflightLockInfo` carries no `session_id`.** It is `{pid, run_id, host, startedAt}`, so at
   reclaim time the lock names which RUN died but not which CONVERSATION it was. That missing
   supplier — not the resume primitive, which already exists and is already wired — is the whole
   gap.
2. **The branch, not the worktree, is the durable artefact.** `reapStaleWorktrees` destroys the
   checkout and not the commits, so a reaped worktree is recoverable rather than terminal.
   `parseOrphanedBranch` already parses the orphan and `materializeReviewWorktree` already cuts a
   fresh worktree at a head sha, so three of the four parts exist today.
3. **Criterion 3's trigger does not fit the reframed design.** It refuses when the recorded
   worktree is absent, which under fact 2 is the case a resume should recover. Any successor must
   trigger the refusal on branch-head reachability instead.

Also recorded on the shard and not repeated at length here: none of the three external sources read
on 2026-08-23 preserves anything besides the conversation, so there is no outside design to copy.

### What would reopen this

Either of two measurements, both over the ledger union on the daemon host:

- **`worker.abandoned` rising above a handful.** One event is an anecdote; a recurring class is a
  population.
- **`daemon.orphan_sweep` killing anything at all.** Every sampled row reads `killed: 0` today, on
  two hosts. A non-zero kill means orphaned work is being destroyed rather than left alone, which
  is a different failure than the one this task was filed against and would need its own look.

Neither has been observed. Until one is, this stays closed.
