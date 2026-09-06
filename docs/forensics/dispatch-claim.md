# dispatch-claim.ts forensics

The measured forensics, incident narratives and design arguments removed from
`src/lib/dispatch-claim.ts` when its comments were compacted to the plain-language standard.
Every block below is the removed text verbatim, marker characters stripped and nothing else
changed. Headings name the symbol the text explained; the code keeps a one-line `Why:` pointer
where the history mattered. Base revision: origin/main at
4500257d7225d5e77874e3d7405c31c4c9ab1e9d; the line numbers below are that revision's.

## Module header

### Base lines 5-39 — lib/dispatch-claim.ts — the SAME

lib/dispatch-claim.ts — the SAME cross-host git-ref-CAS family (W1-T509's `refs/rmd-id/`,
W1-T1132's `refs/rmd-triage/`) pointed at a second rung (W1-T1268).

THE GAP. `isDispatchEligible` (src/lib/drain.ts) decides in-flight from ten probes; the two
concurrency-bearing ones (`isOpenPr`, `hasPushedRunBranch`) both read a PUBLISHED artifact — an
open PR or a pushed `run-<id>-<epoch>` branch. Neither exists at the moment a lane, OR AN
OPERATOR dispatching beside the fleet, decides to start a task. Two starts inside that window
both read nothing published and both spend a run — MEASURED 2026-08-23:
TWO LANES — #2625 and #2626 — branched 53.776 SECONDS apart, both having correctly found no
open PR, no pushed branch, and no inflight lock (the same-host guard, `inflight-lock.ts`,
cannot see a foreign host's pid — that is the strictly cross-host, strictly pre-artifact gap
this closes).

WHAT THIS ADDS, AND WHAT IT DOES NOT. A claim is taken BEFORE any spend — see `run-task.ts`'s
dispatch-claim seam — the same position `decideTriageClaim` occupies ahead of the Architect
call, and for the identical reason: a probe that reads PUBLISHED work cannot see work (or an
operator's own dispatch) that has published nothing yet. It REPLACES none of the ten probes
(`isMerged` is terminality; `isOpenPr`/`hasPushedRunBranch` keep their own stale-credit and
closed-unmerged duties, unchanged) and it does NOT widen `inflight-lock.ts`, which is
same-host by design (`isHolderStale` puts host first, W1-T396) and stays that way — a second
host cannot ask whether a pid on the first is alive, which is exactly why that lock could
never have been widened into this.

MIRRORS `auto-triage.ts`'s triage claim STRUCTURALLY, not by import: same substrate (an orphan
`commit-tree` over the empty tree, pushed with a PLAIN refspec so a second writer is
structurally a non-fast-forward), same `classifyPushFailure` (imported, not re-derived — two
copies of "is this contention or an unreachable remote" is two places for it to drift), same
three-outcome attempt / three-arm release shape, and NO TIME-BASED EXPIRY of any kind. A
SEPARATE ref namespace (`refs/rmd-dispatch/`, not `refs/rmd-triage/`) because the obvious noun
is already taken twice over: "claim" belongs to `plan/claims.yaml`'s falsifiable assertions
(a red claim means the plan is lying), and "reconcile" belongs to the escalation-issue
lifecycle. The rung-qualified compound — `dispatchClaimRef`, never a bare "claim" — is the
repo's own existing disambiguator, the same one `triageClaimRef` already uses.

## ClaimAnchorIdentity

### Base lines 113-119 — The anchor's timestamp VERBATIM, carried

The anchor's timestamp VERBATIM, carried alongside the parsed ms so the decision below can
render it without constructing a `Date`. Two reasons, and the second is the load-bearing
one: (1) `decideDispatchClaimRelease` stays provably clock-free — W1-T2446's guard forbids
`Date.now`/`new Date(`/timers inside it, and that guard is protecting a real property, not
a style; (2) a forensic line should quote what the anchor ACTUALLY says, not a value
round-tripped through a parser that could normalise it.

## ClaimantLivenessProbe

### Base lines 137-151 — This process's own PID-namespace identity

This process's own PID-namespace identity, as `decideDispatchClaimRelease`'s
`dead-claimant` arm needs it. Every field is supplied by the caller's seam so the decision
stays pure and both negative cases below are testable without a second container.

⚠ `namespaceBootMs` IS THE PID NAMESPACE'S OWN INIT START, NOT `/proc/uptime` — MEASURED
2026-09-03 and this is the trap the design note warned about: `/proc/uptime` is NOT
namespaced. Read inside the daemon container it returned 27884.08s against the host's
27884.02s — the HOST's boot (10:52:57Z), not the container's start (11:37:56Z). A predicate
built on it would compare a claim against the wrong epoch entirely. `stat -c %y /proc/1` is
wrong too (it read 17:27:50Z for a container started at 11:37:56Z — proc-entry access time,
not process start). The correct reading is `/proc/stat`'s `btime` plus `/proc/1/stat` field
22 (starttime, in CLK_TCK ticks), which reconstructs docker's own `StartedAt` to within the
one-second rounding of integer ticks — see `readNamespaceBootMs`.

## decideDispatchClaimRelease

### Base lines 170-219 — PURE. The three-arm release, in order

PURE. The three-arm release, in order, with NO TIME-BASED EXPIRY — mirrors
`decideTriageClaimRelease` exactly; see that function's own doc for why a timer is refused
("a claim that outlives its lane is a visible ref an operator can drop; a claim that expires
under a running lane re-opens the exact race this exists to close").

 1. HOLDER — the run that took the claim drops it when done, in a `finally`, success or not.
 2. EVIDENCE — `evidenceObserved` is the CALLER's own predicate, exactly what `isMerged`,
    `readLiveState`/`isLiveMergeCredited` and `closedUnmergedRunBranches` already read at the
    dispatch rung (`isDispatchEligible`, src/lib/drain.ts) — this module supplies no new
    probe, it re-uses theirs. A claim whose task is demonstrably done is demonstrably stale,
    so any host may drop it; no liveness question is asked because none can be answered.
 3. DEAD-CLAIMANT (W1-T2784) — the ONE cross-host-shaped case that IS decidable, and the case
    that was producing permanent claims. See below.
 4. OPERATOR — anything else. Cross-host liveness is NOT decidable in general (the reason
    `isHolderStale` refuses to widen into a cross-host question at all, W1-T396), so the
    honest answer is a person, not a guess.

── WHY ARM 3 EXISTS, AND WHY IT IS NOT A WEAKENING OF ARM 4 ────────────────────────────────
MEASURED 2026-09-03: `refs/rmd-dispatch/W1-T2631` was minted `490780@5670f73af4f4` at
03:52:05.691Z. Its run reached recon, built a prompt, spawned an implement worker (worker.state
rows to 04:02:47Z) and then stopped — no verdict row, no release. The container it named was
still running under the SAME id, so every later lane read the ref as held by a live peer and
refused. Four refusals cost $2.3421 in preflight alone (the probes run BEFORE this check), and
W1-T2631/W1-T2636 together burned $37.6891 across 122 blocked verdicts and zero completions.
The operator had to clear four refs by hand.

ARM 4'S REASONING IS CORRECT AND UNCHANGED FOR EVERY OTHER SHAPE. "Cross-host liveness is not
decidable" is true when the anchor names a host this process is not. What arm 3 adds is the
narrow case where the question is not cross-host at all: the anchor names THIS host, and the
claim predates THIS PID namespace's own init. A process cannot outlive the namespace that
contains it, so a claimant minted before pid 1 started is provably gone — no liveness guess,
no timer, no elapsed-time threshold.

WHY BOOT TIME IS PRIMARY AND PID ABSENCE ONLY CONFIRMS. Pid liveness alone has a reuse hazard:
a recycled pid reads ALIVE and errs safe, but reading a pid as ABSENT is only sound if it could
not have been reused, which is exactly what a namespace restart guarantees and nothing else
does. So the boot comparison carries the proof and `pidPresent` is required to AGREE — both
must hold. A pid that reappeared under a recycled number after the restart therefore blocks the
release, leaving the operator arm to handle it: a false negative (the stuck claim persists,
today's behaviour) is the safe direction, a false positive is the duplicate dispatch W1-T1265
measured at 53.776 seconds apart.

THE HOST EQUALITY IS THE LOAD-BEARING GUARD. Without it, a claim minted on the Mac mini would be
compared against the Azure container's boot clock — two unrelated epochs — and a mini claim older
than the container's last restart would be released out from under a live lane. `localHost` is
the same `hostname()` value `mintAnchor` writes, so the comparison is like-for-like or it does
not happen at all. It also keeps the pid comparison meaningful: same host ⇒ same PID namespace
⇒ `/proc/<pid>` is answering about the pid the anchor actually named.

## lastAttemptStderr

### Base lines 279-290 — W1-T2552: git's OWN stderr from the most recent

W1-T2552: git's OWN stderr from the most recent `attempt`, or `undefined` when the last
attempt succeeded or none has run. OPTIONAL so every existing fake still satisfies this
interface unchanged — a reserver that does not implement it simply yields a refusal worded
exactly as it is today.

WHY THIS EXISTS. `classifyPushFailure` collapses every non-contention failure to the
single word "unreachable", and the refusal below then said "cannot reach origin" and threw the
message away. MEASURED 2026-08-30: the real stderr was `fatal: could not read Username for
'https://github.com': No such device or address` — a MISSING CREDENTIAL HELPER, not an
unreachable remote — and recovering that one line took an hour of bisection precisely because
the gate had already discarded it. A refusal that names its own cause is the whole fix.
