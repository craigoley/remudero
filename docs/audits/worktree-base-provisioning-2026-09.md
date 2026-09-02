# Worktree base provisioning — a read-only forensic pass (2026-09-02)

**Scope:** W1-T2625. Read-only. No source changed. The trigger is the follow-up harvest from run
`W1-T2460-1788054755234` (PR #3286): that run's own recon report named its worktree base
(`e9454618`) as sitting **1553 commits behind** current `main`, while W1-T405's shipped
`assertWorktreeBaseCurrent` assert-and-refuse guard was live in production. The question this pass
answers: which of four named mechanisms let that happen, and — the systemic half — is this one
incident or every dispatch.

**Method:** read `worktreeAdd`/`assertWorktreeBaseCurrent`/`recordWorktreeBase` and every call site
of `worktreeAdd` (`src/lib/worker.ts`); the dispatch catch (`src/run-task.ts`); `deploy/entrypoint.sh`'s
ref-resolution and boot-fetch blocks; every retained ledger file on this host
(`state/ledger.ndjson`, `state/ledger.ndjson.bak`, and all 65 rotated `state/ledger.*.ndjson.gz`
archives — together the retained window runs 2026-08-08 → 2026-09-02, ~600 worktree creations); the
run-record tail for `W1-T2460-1788054755234` (`state/runs/W1-T2460-1788054755234.tail`); and the
live git state of the two canonical checkouts this host actually has (`~/Remudero/repos/remudero`,
the dispatch path's `repoDir`, and `~/Remudero/remudero`, the `deploy/entrypoint.sh`-managed deps
source). Nothing here executes a build, a test, or a live host probe beyond `git` reads already
described as read-only by the functions under review.

---

## HEADLINE FINDING: the "1553" figure is not a staleness measurement of the worktree base

The harvest's own number is reproducible, and it is not what it was taken to mean.

`e9454618` is **not** an independent measurement of how far `origin/main` had moved past the
worktree's base — it is the sha `git merge-base HEAD main` resolved to inside the run's recon,
where `main` is the **local branch** in the canonical checkout `repoDir`
(`~/Remudero/repos/remudero`). That local branch has never moved since the checkout was first
cloned:

```
$ cd ~/Remudero/repos/remudero
$ git reflog show main
e9454618 main@{0}: clone: from https://github.com/craigoley/remudero.git
$ git rev-parse main
e94546187fb8c20b5b3d9fa0cc4b38d9c327a1d5   # PR #1485, merged 2026-08-08 17:39:45
$ git rev-parse origin/main
d011c3a49c7b7bcf0a7ce82ec6e04a2a17be39fe   # today's true tip — correctly current
```

One reflog entry, ever: the clone. `git fetch`'s default refspec updates only
`refs/remotes/origin/*`; it never touches the local branch `main`, so `repoDir`'s local `main` is
frozen at whatever the checkout's first clone happened to see (PR #1485), while `origin/main` (the
tracking ref `worktreeAdd`'s own fetch correctly advances) is verified current today — matching
this very run's own base. This is **exactly** MASTER-PLAN's own standing operational note (1),
verified still true and unfixed: *"the primary checkout `~/Remudero/repos/remudero` drifts ~100
commits behind `origin/main` per cycle (85 → 155 → 278 → 371 …) — any tool reading that path
instead of a worktree sees a stale tree."* 1553 is the next point on that exact curve — it is not a
new phenomenon, it is the same standing, already-documented one, applied to a number MASTER-PLAN's
own note had not yet reached when it was written.

Reconstructing what the worktree's **actual** base was, from the run's own recon `git log` line
(`state/runs/W1-T2460-1788054755234.tail:15`): HEAD right after creation was `3fad586e`
(`chore(plan): file the referent that is in the id and nothing reads (#3277)`), merged
**2026-08-30T01:48:05Z** — seven minutes before `worktreeAdd` cut this worktree at 01:55:18. And:

```
$ git rev-list --count e9454618..3fad586e
1553
```

That is the whole mechanism: **1553 is the distance between the frozen local `main` in `repoDir`
and the worktree's true, near-current base — not the distance between the base and true
`origin/main` at creation time.** The recon that produced the harvest line measured drift with
`git merge-base HEAD main` / `main...HEAD`, against the wrong ref, and said so honestly in its own
COULDN'T-VERIFY section: *"Whether `origin/main` (remote) matches local `main` exactly — did not
fetch (read-only recon, no network calls made)."* The follow-up this task chases down inherited an
unverified assumption its own source run had already flagged as unverified.

PR #3286 (the run's eventual output) merged cleanly against `main` at 2026-08-30T03:11:15Z, no
scope-guard misfire recorded — consistent with a base that was, in fact, current or near-current
at cut time, not 1553 commits stale against the guard's actual comparison point (`origin/main`
via live `git ls-remote`).

---

## THE SYSTEMIC QUESTION, MEASURED

Every retained ledger file on this host was searched for the three step names the worktree-base
guard can emit, deduplicated by `run_id` (the current `state/ledger.ndjson` overlaps
`state/ledger.ndjson.bak` and the oldest rotations by a handful of rows):

| step | occurrences (distinct `run_id`) | window |
|---|---:|---|
| `worktree.add` (successful add) | **596** | 2026-08-08T21:59 → 2026-09-02T14:52 (15 distinct hosts) |
| `worktree.stale_base` (guard refused) | **1** | `W1-T2508-1788189679275`, 2026-08-31T15:23:54Z |
| `worktree.add_failed` (other add failure) | **2** | both `DAEMON` lane, `core.hooksPath` config failures — unrelated to base currency |

Of the 596 successful creations, **the base each one actually carried is NOT DETERMINABLE from the
ledger for any of them** — `worktree.add`'s payload is `{branch, worktreePath}` only (verified: 0
of 600 raw `worktree.add` lines across every retained file carry a `base` field). So the honest
three-bucket count the design calls for is:

- **shown current:** 0 (the ledger never records the base a successful creation carried, so no
  success can be shown to equal the remote head it was checked against)
- **shown stale:** 1 (`worktree.stale_base` fired exactly once — `W1-T2508`, and it worked
  end-to-end: refused before recon spent anything, released the dispatch claim, and the worktree
  was reaped by the next prune pass, all ledgered — `worktree.reaped` /
  `worktree.prune` for that same run in `ledger.2026-08-31T19-14-32-099Z.ndjson.gz`)
- **NOT DETERMINABLE:** **595** of 596 — every successful creation except the one instance where the
  guard happened to fire. The third bucket dominates, as the design predicted it would.

**This answers "every dispatch, or one incident" directly: it is neither.** The guard is
demonstrably live and does fire correctly (one confirmed refusal, correctly ledgered and correctly
recovered) — so this is not "the guard never runs." But the ledger cannot show whether the other
595 successful creations passed the currency check because their remote-head read succeeded and
matched, or because the read failed and the unreadable branch's `console.error`-only warning
(never ledgered — confirmed: `deps.warn` defaults to `console.error`, and the production dispatch
site at `src/run-task.ts:11767` passes no `warn` override) silently let a stale base through. That
distinction is architecturally erased at the point of success. W1-T2460 is very likely (per the
reconstruction above) one of the passes, not one of the silent failures — but "very likely, from a
seven-minute timing window and a corroborating standing note" is exactly the archaeology this task
exists to replace with a number, and the number is: **595 of 596 successes are NOT DETERMINABLE.**

---

## CANDIDATE DISPOSITION

### (a) THE READ FAILED OPEN — UNDECIDED, for this run; RULED IN as a live, unmeasured systemic exposure

`assertWorktreeBaseCurrent` (`src/lib/worker.ts:2858`) is unconditionally best-effort on an
unreadable remote head by design (note (iii), `src/lib/worker.ts:2847-2853`): `readRemoteHead`
throwing warns via `deps.warn ?? console.error` and **returns** rather than refusing. Production
passes no `warn` override (`worktreeAdd(repoDir, worktreePath, branch, "origin/main",
opts.worktreeBaseDeps)` at `src/run-task.ts:11767` — `opts.worktreeBaseDeps` is not set on the
normal dispatch path), so that warning — the ONLY signal that the check could not run — lands on
`console.error` with no ledger line and no counter. This is independently verified structurally (every one of 600 `worktree.add` lines omits `base`;
the ledger is schema-less — `appendLedger`, `src/lib/ledger.ts:166`, appends whatever fields a
caller passes — and grepping every `log("worktree.` call site in `src/run-task.ts` and
`src/lib/worker.ts` finds `worktree.add`, `.add_failed`, `.stale_base`, `.prune`, `.remove`,
`.remove.error`, `.reap_boot`, `.reap_boot.undecidable`, `.reaped`, `.reap.undecidable` and
`.reap.error` — no step exists anywhere for "remote head was unreadable") and is the exact premise
W1-T2626 (filed alongside this task) was independently justified from.

For **W1-T2460 specifically**: UNDECIDED. The base reconstructed above (`3fad586e`, merged 7
minutes before creation) is far more consistent with a currency check that ran and PASSED — remote
head and base agreeing — than with either staleness or a failed-open bypass, but the ledger holds
no record either way, and the `.tail`'s own captured worker output does not include the entrypoint
process's `console.error` stream. **The specific observation that would decide it:** a ledgered
counter or line for `assertWorktreeBaseCurrent`'s unreadable branch (W1-T2626's own proposed
remedy) would let a later audit read this off directly instead of reconstructing it from commit
timing.

For the **systemic** question: RULED IN as a real, currently-unmeasured exposure — not because it
is shown to have fired on any specific run in this window, but because the mechanism that would
hide it if it did fire is confirmed live and unchanged, and W1-T197 already measured the
neighbouring headroom read failing open on 197 of 253 checks under the identical
"unreadable-degrades-to-silent-proceed" contract. Whether it has ever actually fired in this
window is, itself, in the NOT DETERMINABLE bucket above.

### (b) THE BASE WAS NEVER THE SUBJECT OF THE CHECK — RULED OUT, for this run

`state/runs/W1-T2460-1788054755234.tail:20` records `.git` as a worktree pointer file —
`gitdir: /home/node/Remudero/repos/remudero/.git/worktrees/run-W1-T2460-1788054755234` — and the
ledger's `worktree.prune`/`worktree.add` lines for this run both carry `"lane":"run-task"`
(`ledger.2026-08-30T05-36-13-108Z.ndjson.gz`), the dispatch path's own lane tag. This run went
through the standard `worktreeAdd` (`src/lib/worker.ts:3044`) on the `runTask` call site
(`src/run-task.ts:11767`), which calls `assertWorktreeBaseCurrent` unconditionally
(`src/lib/worker.ts:3081-3084`) — not a reused/reclaimed worktree, and not a container tree cut by
`deploy/entrypoint.sh` (that script manages a **different** checkout, `~/Remudero/remudero`, used
only as the `node_modules` symlink source — confirmed distinct from `repoDir`
(`~/Remudero/repos/remudero`) by their derivations: `TREE="$CONFIG_ROOT/remudero"` in
`deploy/entrypoint.sh` vs. `const repoDir = join(config.root, "repos", task.repo)` at
`src/run-task.ts:11668`). So for W1-T2460, RULED OUT: the base genuinely was the subject of a real
`assertWorktreeBaseCurrent` call.

**A related, distinct gap surfaced while ruling this out, named as its own finding rather than
folded into (b):** `worktreeAdd` has more than the "six call sites" its own doc comment
(`src/lib/worker.ts:2836`) claims. By verb: `runTask` (direct, `src/run-task.ts:11767`); `retro`,
`triage`, `plan` (all three share `addLaneWorktree`, `src/run-task.ts:19379-19391`); `draftProposalBatch`
(via `createDaemonLaneWorktree`, `src/run-task.ts:31250`); `approveCommand` (direct, two calls —
`src/run-task.ts:31910` and `:31940`) — that is the "six." Undocumented beyond it:
`approveBatchCommand` (`src/run-task.ts:32254`), `dispatchAlertFixRun`
(`src/run-task.ts:32813`, via an injected `deps.worktreeAdd`), and `src/spike.ts:80`. More
materially: `addLaneWorktree` — the function `retro`/`triage`/`plan` share — catches **every**
`worktreeAdd` failure identically (`src/run-task.ts:19386-19389`):

```ts
} catch (e) {
  log("worktree.add_failed", { branch, error: String((e as Error)?.message ?? e) });
  throw e;
}
```

There is no `instanceof WorktreeBaseStaleError` branch here, unlike `runTask`'s own dispatch catch
(`src/run-task.ts:11769`). A stale base on the `retro`/`triage`/`plan` path is folded into the
same generic `worktree.add_failed` bucket as a `core.hooksPath` config error (the two real
`worktree.add_failed` rows measured this window are exactly that — a `core.hooksPath` failure, not
a staleness one) and then **rethrown uncaught** into whatever handles that command, rather than
returning the graceful `verdict: "failed"` `runTask`'s own catch produces. So even on the one path
`worktree.stale_base` exists to name, three of the six verbs cannot produce that ledger line at
all — a staleness refusal on `retro`/`triage`/`plan` is indistinguishable, from the ledger alone,
from any other add failure.

### (c) THE UPSTREAM WAS ALREADY STALE — RULED OUT, for this run

`repoDir`'s `origin/main` tracking ref is independently verified current: `git reflog show
origin/main` in `~/Remudero/repos/remudero` shows continuous fast-forwards (856+ entries) landing
at `d011c3a4` today, matching this very run's own worktree base exactly. There is no evidence the
true GitHub remote itself was behind at W1-T2460's dispatch time; `3fad586e` (the run's real base)
merged only seven minutes before the worktree was cut. RULED OUT for this run. (The failure mode
this candidate names is real elsewhere and already tracked separately — W1-T2501's boot-fetch
fail-open, W1-T496's 124-commits-behind measurement — but both are about the **other** checkout,
`~/Remudero/remudero` / `deploy/entrypoint.sh`'s `TREE`, not about `repoDir` or worktree bases.)

### (d) IT IS THE KNOWN CHECKOUT DRIFT AND NOT A WORKTREE AT ALL — RULED IN

This is the actual mechanism, established under HEADLINE FINDING above and re-stated here for the
disposition table: the "1553" the harvest reported is `repoDir`'s frozen local `main` branch's
distance from the run's real base, i.e. exactly the checkout-drift MASTER-PLAN's standing note (1)
already named, applied to the *comparison basis a downstream recon used*, not applied to the
worktree the guard actually protects. RULED IN, with the correction that the drifting object is
being read **as if it were the worktree's base** by a tool outside the guard (a recon's own
`git merge-base HEAD main`), not that the guard itself consulted it — `worktreeAdd`'s cut and
`assertWorktreeBaseCurrent`'s check both correctly use `origin/main`, never local `main`.

---

## SUCCESSOR FILINGS

Everything below needs a source change and is out of scope for this read-only pass by construction
(design: *"Smuggling a src/ change into a forensic pass is the scope violation this repo already
refuses at the guard"*). Named here, not built here:

- **W1-T2626** (already filed, sequenced alongside this task, not depended on): ledger the base and
  the currency-check outcome — current / unreadable / stale — on every `worktreeAdd`, closing
  exactly the NOT DETERMINABLE bucket this audit measured at 595 of 596. This pass independently
  re-derives the same need from the ledger's actual shape rather than assuming W1-T2626's premise.
- **NEW — give `addLaneWorktree` (`src/run-task.ts:19379`) the same `WorktreeBaseStaleError`
  handling `runTask`'s dispatch catch already has**, so `retro`/`triage`/`plan` can distinguish a
  staleness refusal from any other add failure instead of folding both into
  `worktree.add_failed`, and so those three verbs get the same "refuse before spend" behaviour
  `runTask` already ships rather than an uncaught rethrow.
- **NEW — fix or retire `worktreeAdd`'s "six call sites" doc comment** (`src/lib/worker.ts:2836`):
  it undercounts by at least three (`approveBatchCommand`, `dispatchAlertFixRun`, `spike.ts`) as of
  this pass.
- **NEW — a recon-facing note or lint that flags `git merge-base HEAD main` / `main...HEAD` against
  a canonical checkout's local branch as unreliable for staleness measurement**, since the exact
  mistake this task traces back to (comparing against a branch `git fetch` never advances) is one a
  future recon can make again on the same host, with the same misleading result, unless the
  standing note is made harder to miss than a MASTER-PLAN paragraph.

---

## HONEST LIMITS

This pass reads records and the current live git state of the checkouts on this one host; it does
not have, and did not seek, the actual `console.error` output of `run-W1-T2460-1788054755234`'s
dispatch process — that stream is not retained anywhere this pass could read (the `.tail` file
captures the worker's own tool-use/report stream, not the harness process's stderr). So candidate
(a)'s disposition for **this specific run** stays UNDECIDED rather than RULED OUT, even though the
weight of the reconstructed evidence (a base merged seven minutes before cut, an upstream tracking
ref independently verified current today, a clean downstream merge with no scope-guard incident)
points at the check having run and passed. If the deciding evidence — a ledgered outcome for the
unreadable branch — was never written down for this run, which is precisely W1-T2626's premise,
this audit says so and stops here rather than inferring the mechanism from that absence.
