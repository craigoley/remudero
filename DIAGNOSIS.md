# DIAGNOSIS — `rmd drain` ran tasks concurrently (a live worktree was reaped)

**Branch:** `diag/drain-concurrency` · **Mode:** evidence-only (no fix, no PR) ·
**Date:** 2026-07-15

## Symptom

`rmd drain --until W1-T12` is specified to run tasks **strictly sequentially** — one
task to a terminal verdict, then the next. The ledger proves it did not:

- run `W1-T7-1784074904419` merged PR #48 at `00:37:35`.
- run `W1-T8-1784075901376` started at `00:38:21` — 46 s later.
- at `00:38:28` W1-T8's `pruneStaleRuns` **deleted the worktree + branches of run
  `W1-T7-1784075267898`**.
- that run's implement worker did not finish until `00:40:12`; its `git push` then
  failed because the worktree was gone.

So a **second** W1-T7 run *and* a W1-T8 run were alive at the same time, and prune
destroyed a live worktree.

---

## Root cause (NAMED)

**Primary: `two-drain-processes`.** Two independent `rmd drain` processes ran
concurrently. There is **no single-instance guard (lockfile) on `drain`**. Each drain
derives task readiness independently from GitHub, and when the second drain started,
the first drain's W1-T7 PR had not merged yet — so *both* drains independently selected
W1-T7 as "runnable" and each launched its own worker.

**Amplifier: `prune-has-no-liveness-guard`.** `pruneStaleRuns` force-removes **any**
`run-*` worktree it finds, with no check for a live worker/lock. This is only safe under
the single-drain invariant. Once that invariant was violated, one drain's routine
start-of-run prune reaped the *other* drain's in-flight worktree — turning a benign
overlap into destroyed work (a **successful** 65-turn implement was lost).

**Explicitly FALSIFIED: `drain-internal-loop-overlap`.** A single drain does **not**
start the next task before the current one settles (evidence §1). The duplicate W1-T7
did not come from one drain looping — it came from a *second drain process*.

The falsifying observation for the primary cause: the two drains have **distinct
`run_id`s, distinct start times 6 minutes apart, and overlapping lifetimes** (§2). If it
were a single drain's internal overlap there would be one `DRAIN-*` run_id, not two.

---

## Evidence

### §1 — drain's loop DOES await each run's terminal verdict (internal overlap ruled out)

`src/lib/drain.ts` `runDrain`:

```
141  while (attempted.length < max) {
        ...
166      try {
167        result = await deps.runOne(next.id);   // <-- awaits the FULL run to a terminal verdict
168      } catch (e) { return summary("error", ...); }
        ...
172      if (!result.merged) { ... return summary("blocked", ...); }  // stop-on-block
173      merged.push(next.id);
```

`runOne` is `runTask` (`src/run-task.ts:1240`), which runs recon→implement→PR→gate and
returns only at a terminal verdict. The `await` on line 167 means one drain selects the
next task **only after** the current run settles. Confirmed empirically for the live
drain `DRAIN-1784074857452`: it ran `W1-T7-...904419` (run.start `00:21:44`), waited
through its merge (`verdict merged 00:37:35`), and only then iterated to W1-T8
(`drain.iteration 00:38:00` → `W1-T8` run.start `00:38:21`). A single drain is sequential.
→ **`drain-internal-loop-overlap` is falsified.**

### §2 — TWO drain processes ran concurrently (the real trigger)

DRAIN run_ids and their lifetimes from `state/ledger.ndjson`:

```
DRAIN-1784074857452   start 00:20:57 · iter 00:21:22 · iter 00:38:00      (no summary → still alive)
DRAIN-1784075218292   start 00:26:58 · iter 00:27:23 · summary 00:40:12   (exited)
```

`DRAIN-1784075218292` **started at 00:26:58, while `DRAIN-1784074857452` was still
running** (that one did not log its next iteration until 00:38:00). Their lifetimes
overlap `00:26:58 → 00:40:12`.

Process identity — the live drain is `DRAIN-1784074857452`:

```
$ ps -o pid,lstart,command -p 71582
71582  Tue Jul 14 20:20:57 2026  ... run-task.ts drain --until W1-T12
```

`20:20:57` local = `00:20:57Z` = `DRAIN-1784074857452` (epoch-ms `1784074857452`).

Each drain independently derived "W1-T7 is runnable" and started its own worker:

```
00:21:44  W1-T7-1784074904419  run.start     (drain A / DRAIN-...857452)
00:27:47  W1-T7-1784075267898  run.start     (drain B / DRAIN-...218292)
00:35:21  W1-T7-1784074904419  implement.done success
00:37:35  W1-T7-1784074904419  pr.merged              → PR #48
00:38:21  W1-T8-1784075901376  run.start     (drain A advances after T7 merged)
00:40:12  W1-T7-1784075267898  implement.done success
00:40:12  W1-T7-1784075267898  run.error     (git push … HEAD failed — worktree gone)
```

Why both picked T7: readiness is re-derived from GitHub each iteration
(`drainCommand.refreshMerged`, `run-task.ts:1213`). When drain B iterated at `00:27:23`,
drain A's T7 PR had not merged yet (it merged at `00:37:35`), so T7 still read as
"not merged / runnable" for drain B. Two drains + GitHub-derived status = the same task
selected twice.

**Distinguishing operator-relaunch vs internal overlap (as requested):** this is
`two-drain-processes`, not internal overlap. This session launched exactly **one** drain
(only one drain log exists: `/tmp/drain-w1t12.log`, which is PID 71582 =
`DRAIN-...857452`). The second drain `DRAIN-...218292` was launched externally 6 minutes
later while the first was alive — consistent with an operator (or automation) re-running
`rmd drain`. `~/.zsh_history` did not capture the command, so the launcher cannot be
named from the shell; the ledger nonetheless proves a distinct second process existed.
Either way the fix is the same: **`drain` needs a lockfile**, not a loop change.

### §3 — `pruneStaleRuns` has NO liveness guard (it reaped a live worktree)

`src/lib/worker.ts:579` `pruneStaleRuns` force-removes **every** worktree under the
worktrees root whose branch matches `run-*`:

```
599  if (isRun && curPath.startsWith(worktreesRoot)) {
601    execFileSync("git", ["-C", repoDir, "worktree", "remove", "--force", curPath], ...);
...
630  for (const b of ... "refs/heads/run-*") { execFileSync("git","branch","-D",b) }  // deletes run-* branches too
```

There is **no** check for an active worker, held lock, PID, or even worktree age — the
name "stale" is an *assumption*, valid only when a single drain owns all `run-*`
worktrees. It runs at the **start of every run** (`run-task.ts:633`), comment: "Reclaim
debris from crashed prior runs … BEFORE adding ours." When drain A started W1-T8 it
force-pruned drain B's **in-flight** worktree:

```
00:38:28  W1-T8-1784075901376  worktree.prune
          worktrees: ["…/run-W1-T7-1784075267898"]
          branches:  ["run-W1-T7-1784075267898", "run-W1-T7-manual-recovery"]
```

Aftermath — the pruned worktree dir survives but is emptied (`git worktree remove
--force` deleted its checkout and `.git`), destroying a **successful** implement:

```
$ ls ~/Remudero/worktrees/run-W1-T7-1784075267898/   → empty
$ git -C …/run-W1-T7-1784075267898 log             → fatal: not a git repository
```

`git worktree remove --force` discards uncommitted/unpushed work irrecoverably. `-D`
also force-deleted an unmerged `run-W1-T7-manual-recovery` branch.

### §4 — Is PR #48's merged work sound? YES — and it is race-independent

Only **one** T7 run ever reached a PR. The duplicate (`…267898`) finished implement
(`success`) but died at `git push` and **never opened a PR**:

```
W1-T7-1784074904419  pr.opened  https://github.com/craigoley/remudero/pull/48
W1-T7-1784074904419  pr.merged  → verdict merged
W1-T7-1784075267898  run.error  Command failed: git … push origin HEAD   (no PR)
```

PR #48 merged at `00:37:34` with `ci: SUCCESS`; `remudero-review` was also green (main's
branch protection requires **both** `ci` and `remudero-review`, so the merge itself is
proof the acceptance judge passed). The two workers were isolated in **separate
worktrees/branches**, and #48 opened and merged *before* the loser even finished — so the
race did **not** corrupt #48. It is exactly the result a single drain would have
produced. **Verdict: PR #48 is sound and race-independent.**

One honest caveat (an acceptance question, *not* a race artifact): #48's diff is only
`src/lib/classify.ts` + `test/classify.test.ts`. That squarely satisfies acceptance
claim 1 (the transient-vs-strike classifier + unit tests). Claim 2 ("two strikes
dispatches a DIAGNOSE worker before any third patch") requires a ledger-observable
dispatch wired into the retry path (`run-task.ts`), which is not in #48's file set. This
passed the gate and is orthogonal to the concurrency bug — flagging it only so it is not
assumed complete.

---

## The minimal fix (DESCRIBED — not implemented)

Two independent defects; fix both (defense in depth). The internal loop needs **no**
change.

1. **Drain lockfile (fixes the primary cause `two-drain-processes`).**
   `drainCommand` acquires an exclusive lock (e.g. `O_EXCL` create of
   `<config.root>/state/drain.lock` holding `{pid, hostname, startedAt}`) before the loop
   and releases it on exit. A second `rmd drain` finds the lock and refuses with a clear
   message (and the holder's pid/age). Guard against a stale lock from a crashed drain by
   checking whether the recorded pid is alive (and/or a TTL) before honoring it. This is
   the smallest change that restores the "one task at a time" contract, because the loop
   is *already* sequential per-process (§1) — the only breach is multiple processes.

2. **Give `pruneStaleRuns` a liveness guard (defense in depth for the amplifier).**
   Never force-remove a worktree that a live run owns. Options, cheapest first:
   - a per-run lock/heartbeat file in each worktree (`run.lock` with the worker pid);
     prune skips a worktree whose lock names a live pid.
   - failing that, an **age threshold** (only reap worktrees older than N minutes / with
     no ledger activity for N minutes) so an actively-writing worktree is never "stale."
   With the lockfile in (1), concurrent drains cannot happen and prune would not see a
   foreign live worktree — but this guard prevents data loss under *any* residual overlap
   (e.g. a manual `run-task` beside a drain).

Note: the drain loop control (`src/lib/drain.ts`) is **correct as-is** and must not be
changed — `await deps.runOne(...)` already enforces per-process sequentiality (§1).

## One-line root cause

`rmd drain` has no single-instance lock, so two drains co-ran and (because task readiness
is derived live from GitHub) both launched W1-T7; `pruneStaleRuns` — which force-removes
any `run-*` worktree with no liveness check — then reaped the second, still-running
worktree at the next run's start, destroying a successful implement. **PR #48 is sound
and unaffected.**
