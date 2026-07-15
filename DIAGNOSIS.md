# DIAGNOSIS — a SINGLE `rmd drain` did NOT overlap; TWO drain invocations did

**Branch:** `diag/drain-sequential-await` · **Mode:** evidence-only (no fix, no PR) ·
**Date:** 2026-07-15

> **Read this first — the premise is corrected by the ledger.** The task briefs this as a
> single drain whose loop fails to `await`. The raw ledger falsifies that: the drain loop
> **does** await each run to a terminal verdict (§1, proven in code *and* in the timeline),
> and the overlap was produced by **two separate `rmd drain` invocations**, each of which
> logged its own `drain.start` (§2). The `ps` that showed one process (PID 71582) was taken
> after the second invocation had already exited (§2c). I re-ran the investigation the task
> asked for and this is where the evidence lands; naming a non-awaiting loop as the cause
> would send a fixer to a loop that is not broken. The *right* fix — a per-task in-flight
> lock + a prune liveness guard (§Fix) — is a candidate the task itself lists, and it holds
> regardless of how many drains run, so we do not need to settle the process count to fix it.

## Symptom

A `rmd drain --until W1-T12` produced overlapping task runs:
- `W1-T7-1784074904419` merged PR #48 at `00:37:35`.
- `W1-T8` iterated at `00:38:00`, `run.start` `00:38:21`.
- a **second** W1-T7 run, `W1-T7-1784075267898`, was still executing — `implement.done`
  at `00:40:12`, ~2 min after W1-T8 started. Its `git push` then failed because W1-T8's
  `pruneStaleRuns` (`00:38:28`) deleted its worktree.

Two questions: **(A)** where did the second W1-T7 come from, and **(B)** why did a run
start while another was alive.

---

## §1 — (B) The drain loop DOES await each run to a terminal verdict

`src/lib/drain.ts` `runDrain`, the entire iteration control:

```
141  while (attempted.length < max) {
142    const isMerged = deps.refreshMerged();
145    if (opts.until && isMerged(opts.until)) return summary("until_reached", opts.until);
        ... headroom check ...
162    const next = nextRunnable(plan, isMerged);
163    if (!next) return summary("no_runnable");
165    log("drain.iteration", { task: next.id, ... });
166    attempted.push(next.id);
167    result = await deps.runOne(next.id);      // ← AWAITED. blocks until terminal verdict
        ...
171    if (!result.merged) { ...; return summary("blocked", ...); }   // stop-on-block
173    merged.push(next.id);
```

- It is a plain `while` loop with a single `await deps.runOne(next.id)` (line 167). No
  `Promise.all`, no `.map`, no `setInterval`, no unawaited/fire-and-forget promise, no
  detached child. The next `nextRunnable` selection (line 162) cannot run until line 167
  resolves.
- `deps.runOne` is `runTask` (`run-task.ts:1240` → `489`), `async …: Promise<RunResult>`.
  **Every** return in `runTask` is a terminal verdict: `merged` (`:877`, reached only
  *after* `pr.merged` at `:875`), `blocked_ci` (`:834`), `blocked_review` (`:858`),
  `blocked_containment` (`:619`), `blocked_budget`/`failed` (`:583`), `failed` no-PR
  (`:809`). There is **no early return** before the run settles. So `await runOne` blocks
  through recon→implement→PR→CI→review→merge.

**Empirical confirmation from the very run in the symptom** — drain `DRAIN-1784074857452`
awaited its own T7 before starting T8:

```
00:37:35.977  W1-T7-1784074904419  verdict merged   ← runTask(T7) resolves here
00:38:00.239  DRAIN-1784074857452  drain.iteration W1-T8  ← next selection, 24s LATER
00:38:21.381  W1-T8-1784075901376  run.start
```

→ **The non-awaiting-loop hypothesis (B) is FALSIFIED.** A single drain is strictly
sequential. The overlap is not *within* one drain's loop.

---

## §2 — (A) The second W1-T7 was launched by a SECOND `rmd drain` invocation

### §2a — two `drain.start` lines = two invocations

Raw, from `state/ledger.ndjson` (unedited):

```
00:20:57.452  DRAIN-1784074857452  drain.start   until W1-T12  max 10
00:21:22.236  DRAIN-1784074857452  drain.iteration  W1-T7  attempted 1
00:26:58.292  DRAIN-1784075218292  drain.start   until W1-T12  max 10      ← SECOND drain
00:27:23.571  DRAIN-1784075218292  drain.iteration  W1-T7  attempted 1     ← its OWN T7
00:38:00.239  DRAIN-1784074857452  drain.iteration  W1-T8  attempted 2
00:40:12.434  DRAIN-1784075218292  drain.summary  attempted[W1-T7] merged[] stopReason=error
00:48:56.587  DRAIN-1784074857452  drain.summary  attempted[W1-T7,W1-T8] merged[W1-T7] blocked
```

`drainCommand` mints `const runId = DRAIN-${Date.now()}` and logs `drain.start` **exactly
once per invocation** (`run-task.ts:1230-1234`). Two distinct `DRAIN-*` run_ids, each with
its own `drain.start`, its own `attempted:1` W1-T7 iteration, and its own `drain.summary`,
are two independent `runDrain` executions — i.e. two `rmd drain` invocations. There is no
code path in which one process emits two `drain.start` lines.

### §2b — the spawn correlation

The second W1-T7's first ledger line is immediately preceded by the second drain's
iteration — not by anything the first drain did:

```
00:26:58.292  DRAIN-1784075218292  drain.start
00:27:23.571  DRAIN-1784075218292  drain.iteration  W1-T7     ← 2nd drain selects T7
00:27:47.904  W1-T7-1784075267898  run.start                  ← 24s later, its worker starts
```

Meanwhile the first drain's T7 (`…904419`) had started at `00:21:44` and did not merge
until `00:37:35`. So when the second drain selected T7 at `00:27:23`, **T7 was genuinely
not merged yet** — `nextRunnable`/`deriveStatus` correctly returned it as runnable. This is
*not even* a GitHub eventual-consistency race (the operator's hypothesis 2): the merge was
still 10 minutes in the future. Both drains, each seeing an unmerged T7, correctly selected
it. The defect is that **two drains were allowed to select the same task at all** — there is
no per-task in-flight guard and no single-drain mutual exclusion.

### §2c — reconciling the `ps` observation (one process)

`ps` showing only PID 71582 is consistent with two invocations, because the second had
already exited:

- PID 71582 `lstart = Tue Jul 14 20:20:57 2026` = `00:20:57Z` = `DRAIN-1784074857452`
  (epoch-ms `1784074857452`). It lived until its `drain.summary` at `00:48:56`.
- `DRAIN-1784075218292` exited at its `drain.summary` `00:40:12`. Any `ps` after `00:40:12`
  sees only PID 71582 — exactly one `run-task.ts drain` tree — while the ledger still
  records that a second invocation ran and finished. "One process now" ≠ "one process ever."
- This session launched exactly one drain (only one drain log exists on disk:
  `/tmp/drain-w1t12.log`, which is PID 71582). The second invocation `…218292` was started
  externally at `00:26:58`, 6 min later, by a separate `rmd drain` (operator or automation);
  `~/.zsh_history` did not capture it, so the launcher is not nameable from the shell, but
  its `drain.start` in the ledger is dispositive that it ran.

---

## §3 — `pruneStaleRuns` deletes ANY `run-*` worktree with no live-worker guard

`src/lib/worker.ts:579`:

```
599  if (isRun && curPath.startsWith(worktreesRoot)) {
601    execFileSync("git", ["-C", repoDir, "worktree", "remove", "--force", curPath], ...);
630  for (const b of ... "refs/heads/run-*") execFileSync("git","branch","-D",b);
```

It force-removes **every** `run-*` worktree under the root — no pid, no lock, no age/heartbeat
check. It runs at the start of *every* run (`run-task.ts:633`, comment: "Reclaim debris from
crashed prior runs … BEFORE adding ours"), an assumption valid only when a single actor owns
all `run-*` worktrees. When the first drain's W1-T8 started, its prune reaped the second
drain's **in-flight** worktree:

```
00:38:28.722  W1-T8-1784075901376  worktree.prune
              worktrees: ["…/run-W1-T7-1784075267898"]              ← LIVE (worker still running)
              branches:  ["run-W1-T7-1784075267898", "run-W1-T7-manual-recovery"]
```

`git worktree remove --force` discards the checkout + `.git` irrecoverably; the pruned dir
survives but is empty (`git -C … log` → "not a git repository"). A **successful** 65-turn
implement (`W1-T7-1784075267898 implement.done success` at `00:40:12`) was destroyed the
moment it tried to push, and an unmerged `run-W1-T7-manual-recovery` branch was force-deleted.
This is a genuine second defect — independent of the drain count — and it is what turned a
benign duplicate run into data loss.

---

## §4 — Timeline (second-by-second interleaving)

`A` = `DRAIN-1784074857452` (PID 71582) · `B` = `DRAIN-1784075218292` (exited 00:40:12)

| time (Z)     | actor | event |
|--------------|-------|-------|
| 00:20:57.452 | A     | `drain.start` (until W1-T12) |
| 00:21:22.236 | A     | `drain.iteration` → **W1-T7** |
| 00:21:44.423 | A/T7  | `W1-T7-…904419` run.start |
| **00:26:58.292** | **B** | **`drain.start`** (second invocation begins — A still running T7) |
| 00:27:23.571 | B     | `drain.iteration` → **W1-T7** (T7 not merged yet ⇒ selected again) |
| 00:27:47.904 | B/T7  | `W1-T7-…267898` run.start  ← **two T7 workers now alive** |
| 00:35:21.856 | A/T7  | `…904419` implement.done (success) |
| 00:35:22.540 | A/T7  | `…904419` pr.opened → **PR #48** |
| 00:37:35.308 | A/T7  | `…904419` pr.merged |
| 00:37:35.977 | A/T7  | `…904419` verdict **merged**  ← A's runTask(T7) resolves |
| 00:38:00.239 | A     | `drain.iteration` → **W1-T8** (A awaited T7, then advanced) |
| 00:38:21.381 | A/T8  | `W1-T8-…901376` run.start |
| **00:38:28.722** | A/T8 | **`worktree.prune` removes B's live `run-W1-T7-…267898`** |
| 00:40:12.402 | B/T7  | `…267898` implement.done (success) — but worktree already gone |
| 00:40:12.428 | B/T7  | `…267898` run.error (`git push … HEAD` failed) |
| 00:40:12.434 | B     | `drain.summary` stopReason=error |
| 00:48:56.586 | A/T8  | `drain.blocked` W1-T8 → blocked_review (PR #49) |
| 00:48:56.587 | A     | `drain.summary` merged[W1-T7] |

The overlap window is `00:27:47 → 00:40:12`: two T7 workers (A's `…904419`, B's `…267898`)
alive simultaneously, then A's W1-T8 overlapping B's T7. **Every overlap edge crosses the
A/B boundary.** There is no edge where A starts a task before A's prior task settled, nor
where B does — each drain is internally sequential.

---

## Root cause (NAMED)

- **(A) duplicate W1-T7 & the overlap** — `duplicate-run: no mutual exclusion across drain
  invocations and no per-task in-flight lock.` Two `rmd drain` invocations ran concurrently
  (§2a). Task readiness is derived from GitHub per iteration; W1-T7 was legitimately unmerged
  when the second drain selected it (§2b), so both drains ran it. Not a re-selection within
  one drain, and not eventual-consistency — simply two actors with no lock.
- **(B) "loop doesn't await"** — **not a real defect.** The loop awaits each run to a
  terminal verdict, proven in code (§1) and in A's own timeline (T8 started 25s *after* T7
  merged). Do not "fix" the loop; it is correct.
- **amplifier** — `prune-has-no-liveness-guard` (§3): `pruneStaleRuns` force-removes any
  `run-*` worktree with no live-worker check, converting the overlap into destroyed work.

The falsifier that decides (A) vs the briefed single-drain framing: **two `drain.start`
lines with distinct run_ids and overlapping lifetimes** (§2a). One process cannot emit two.

---

## The minimal fix (DESCRIBED — not implemented)

The loop needs **no** change. Two guards, both from the task's own candidate list, and both
robust *regardless of how many drains run* (so they fix the problem even if one disputes the
process count):

1. **Per-task in-flight lock (fixes A directly).** Before selecting/starting a task, take an
   exclusive lock keyed by task id (e.g. `O_EXCL` create of
   `<config.root>/state/inflight/<task-id>.lock` holding `{run_id, pid, startedAt}`), released
   at terminal verdict. A second actor (another drain, or a stray `run-task`) finds the task
   locked and skips it. This is the smallest change that stops two runs of the *same* task,
   whatever launched them. (A coarser **single-instance drain lock** —
   `<config.root>/state/drain.lock` with a stale-pid check — also prevents two drains, but the
   per-task lock is strictly more general and also guards a manual `run-task` beside a drain.)

2. **Prune liveness guard (fixes the amplifier / prevents data loss).** `pruneStaleRuns` must
   never force-remove a worktree a live run owns. Cheapest: a per-worktree `run.lock` (worker
   pid + heartbeat); prune skips any worktree whose lock names a live pid. Fallback: an age/
   no-recent-ledger-activity threshold so an actively-writing worktree is never "stale."

With (1) the duplicate never starts; with (2) even a residual overlap (e.g. a hand-run
`run-task`) cannot destroy a live worktree. Leave `src/lib/drain.ts` unchanged.

## PR #48

Sound and race-independent (established last cycle and unchanged here): only one T7 reached a
PR; the duplicate `…267898` errored at push with no PR; separate worktrees; #48 merged before
the loser finished. Not touched by this diagnosis.

## One-line root cause

Two concurrent `rmd drain` invocations (no per-task in-flight lock, no single-instance guard)
both selected the still-unmerged W1-T7 and ran it; the drain loop itself correctly awaits each
run — the overlap is cross-invocation, not intra-loop — and `pruneStaleRuns`, which force-
removes any `run-*` worktree with no live-worker guard, then reaped the second run's live
worktree and destroyed a successful implement.
