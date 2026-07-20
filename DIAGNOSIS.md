# DIAGNOSIS — P6+P5 triage: the `failed`×4 and `incomplete` (×1 this cycle, ×2 prior) terminal causes

**Task:** W1-T52 · **Mandate:** read-only evidence (ledger + transcripts + prior diag branches +
git history), **no patch, no golden minted (P6a)**. **Verdict:** `failed` and `incomplete` are
**NOT one hole**. `failed` is a real, structured verdict class (worker returned a terminal ERROR
envelope); one of its four instances was a **classifier bug already fixed** (PR #59). `incomplete`
is not a verdict at all — it is the **absence** of one, produced by a single unguarded top-level
`catch` in `run-task.ts` that logs a free-text `run.error` and never a `verdict` line. Its three
instances have **three unrelated root causes** (a since-fixed missing-handler gap, a host-level
binary-swap race, and an unguarded `git push`) — the only thing they share is which catch block
caught them, not why they happened.

---

## Scope — which runs these are, and why exactly these seven

W1-T52 originates from retro `RETRO-1784133446353` (2026-07-15T16:37:26Z), which named `failed`×4
as the largest untriaged failure class **for the cycle it closed**, and folded in P5
(`RETRO-1784058021334`, 2026-07-14T19:40:21Z) which had already named `incomplete`×2 as "prior".
Scoping every run in `state/ledger.ndjson` by `run.start` timestamp against these two markers:

| verdict | window | run_id(s) |
|---|---|---|
| `failed` | ≤ 1784133446353 (this cycle) | W1-T6-1784070779114, W1-T9-1784079348848, W1-T12-1784083512132, W1-T12a-1784117152056 — **exactly 4** |
| `incomplete` | ≤ 1784058021334 (prior) | W1-T1C-1784033722811, W1-T1C-1784038021919 — **exactly 2** |
| `incomplete` | 1784058021334 – 1784133446353 (this cycle) | W1-T7-1784075267898 — **exactly 1** |

This matches the task's own count (`failed`×4, `incomplete` x1 this cycle + x2 prior = 3) exactly,
confirming the scope. (A fifth ledger `verdict:failed` line, W1-T54b-1784149952116, and the much
larger W1-T1 redispatch-storm `incomplete`×~111 block, both start **after** 1784133446353 — they
belong to later retro cycles (`RETRO-1784155126258`, `RETRO-1784512714705` / P29–P31) already
tracked elsewhere in MASTER-PLAN.md and are out of scope here.)

---

## `failed` × 4

### 1. W1-T6-1784070779114 — genuine `error_max_turns`, root cause: unowned turn budget

Ledger: `implement.done` subtype `error_max_turns`, 61 turns, $5.06; `verdict: failed`.

Already diagnosed in full on `diag/w1t6-max-turns` (commit `79c5653`), evidence-only:

> "The worker made **steady forward progress** on a genuinely large, cross-cutting,
> exploration-heavy task and exhausted a **HARDCODED 60-turn budget**... `mounts.yaml`
> ... is DEAD CODE — it is imported nowhere in the spawn path."

19 file edits across 6 files, 19/19 distinct anchors (H3 looping falsified), exactly one
acceptance criterion whose *delivery* is cross-cutting (H2 over-scoped-as-stated falsified). The
60-turn ceiling at `src/run-task.ts:670` was hardcoded and unwired from the routing table shipped
one run earlier to own it. **Verdict class: legitimate `failed`, not a classifier hole** — the
worker really did run out of turns; the defect is in turn-budget *ownership*, not verdict labeling.

### 2. W1-T9-1784079348848 — genuine `error_max_turns`, root cause: over-scoped task

Ledger: `implement.done` subtype `error_max_turns`, 81/80 mount turns, $5.05; `verdict: failed`.

Diagnosed on `diag/w1t9-max-turns` (commit `16f6d89`):

> "81/80 max_turns. NOT looping... NOT a dropped-learning tax... Genuinely over-scoped: 2 concerns
> (tier-detect wizard + config validation) + CLI wiring + 3 test files, and the interactive-confirm
> concern is ill-posed for a non-interactive worker."

**Verdict class: legitimate `failed`, not a classifier hole** — task sizing (Rule 19), not labeling.

### 3. W1-T12-1784083512132 — genuine `error_max_turns`, root cause: over-scoped + headless-unfit

Ledger: `implement.done` subtype `error_max_turns`, 81/80 mount turns, $10.27; `verdict: failed`.

Diagnosed on `diag/w1t12-max-turns` (commit `b366935`):

> "OVER-SCOPED (3 concerns) + 3 HEADLESS-UNFIT criteria... the FOURTH max_turns event."

**Verdict class: legitimate `failed`, not a classifier hole** — same class as #1/#2 (task sizing).

### 4. W1-T12a-1784117152056 — CONFIRMED classifier hole, already fixed (PR #59)

Ledger: `implement.done` **subtype `success`**, 10/120 turns, $0.89 — well inside budget — yet:

```
"step":"verdict","verdict":"failed","stage":"implement","subtype":"success",
"reason":"worker error at implement: success"
```

A self-contradicting label ("worker error ... : success"). Root cause, per commit `084f0cd`
("fix(run): honest no_pr verdict for a terminal-success worker that opens no PR (#59)", already on
this branch's `main`):

> "`collectWorkerResult` sets `isError=true` when the SDK iterator throws AFTER the result
> envelope; on a SUCCESS envelope that leaves `{isError:true, subtype:"success"}`, and
> `workerErrorVerdict` mislabeled it a worker error."

The fix (present today at `src/lib/retro.ts`'s sibling logic in `src/run-task.ts`'s
`workerErrorVerdict`/`noPrVerdict`) makes `subtype === "success"` never a worker error; a
terminal-success worker that commits nothing and opens no PR now gets its own honest `no_pr`
verdict instead. **Verdict class: a real classifier hole — but already closed.** Re-running this
exact scenario today would land `no_pr`, not `failed`. No golden is minted here per P6a; the fix
already shipped and is covered by its own 265-test suite (commit message, `#59`).

---

## `incomplete` × 3

None of these carries a `verdict` ledger line at all — `incomplete` is `gatherRuns`'s **default**
(`src/lib/retro.ts:112`, `String(verdictLine?.verdict ?? "incomplete")`) for any run whose lines
include no `step:"verdict"`. Tracing each to its actual terminal event:

### 1. W1-T1C-1784033722811 (prior) — CONFIRMED classifier hole, already fixed same-day

Ledger: `run.start` → `settings.validated` → `worktree.add` → `recon.done` → `prompt.linted` →
`"step":"run.error","error":"Claude Code returned an error result: Reached maximum number of
turns (18)"`. No `implement.done`, no `verdict` line.

The code deployed at this run's start (commit `736d74a`, timestamped 08:55:08 EDT vs. this run's
08:55:22 EDT start — 14 seconds later) hardcoded the implement worker's `maxTurns: 18` and, per
`git show 736d74a:src/run-task.ts`, contained **no `workerErrorVerdict`/error-envelope handling at
all** — a worker ERROR result was not distinguished from success anywhere in `runTask`. The very
next commit touching this file, `f2667d8` ("WS-1: budget backstop + honest ledger (no more free
failed runs)"), landed ~22 minutes later and added exactly this machinery (`workerErrorVerdict`,
`failOnWorkerError`, ledgering `num_turns`/`cost_usd` on an error) — its own commit message names
the class this run fell into: *"an implement run's ~6 minutes of spend was previously invisible
because the SDK threw before we read them."* This run predates that fix by minutes. **Verdict
class: a real classifier hole (an uncaught SDK max-turns throw with zero structured handling), but
already closed same-day by `f2667d8` — not currently reproducible.**

### 2. W1-T1C-1784038021919 (prior) — host-level race, not a code defect

Ledger: `recon.done` (success) → `implement.done` (success, 15 turns) → `decision.autochoose` →
`"step":"run.error","error":"Claude Code native binary not found at
/Users/craigoleyagent/.npm-global/bin/claude..."` → `worktree.remove`.

Already diagnosed in full on `diag/resume-spawn-enoent` (commit `001e9d3`):

> "A host-level race between Claude Code's background self-updater and a worker spawn... a
> detached `npm install --global @anthropic-ai/claude-code@2.1.209` began reifying the package
> tree... The resume worker spawned 11s later... while that symlink/target was momentarily
> absent." Falsifying evidence: the binary's birthtime (14:18:40 UTC) is **8m29s after** the
> failure (14:10:11 UTC) — the binary observed post-hoc is not the one in play at failure time.

**Verdict class: environmental/host-timing, unrelated to any Remudero code path and unrelated to
the other two `incomplete` instances or to the `failed` class.** Not a classifier hole — the ledger
correctly captured the true error text; it simply never reaches a structured `verdict` because
this throw, too, lands in the generic top-level catch (see next section).

### 3. W1-T7-1784075267898 (this cycle) — unguarded `git push` after a clean implement

Ledger: `implement.done` **subtype `success`**, 46 turns, $3.56 → `"step":"run.error","error":
"Command failed: git -C .../worktrees/run-W1-T7-1784075267898 push origin HEAD"` →
`"step":"worktree.remove.error","error":"Command failed: git -C .../repos/remudero worktree remove
--force .../worktrees/run-W1-T7-1784075267898"`.

The worker finished cleanly and produced a report; there was no worker error to classify. The
orchestrator's own fallback push (`src/run-task.ts:1938`,
`execFileSync("git", [..., "push", "origin", "HEAD"], ...)`) is called with **no surrounding
try/catch** (unlike the `ls-remote` check immediately above it, which is wrapped), so any push
failure (non-fast-forward, transient network, auth) throws straight past every verdict-writing
path to the same generic top-level `catch (err)` at `src/run-task.ts:2097`, which only logs
`log("run.error", ...)` — never `log("verdict", ...)`. The subsequent best-effort worktree cleanup
then also failed (`worktree.remove.error`), consistent with the worktree/branch being left in a
state the orchestrator's own repo checkout could not force-remove. **Verdict class: a
git/worktree-operational failure with no relation to turn budgets, classifier mislabeling, or host
races** — a distinct, still-live gap (this exact `execFileSync` call is unguarded in the current
`src/run-task.ts`, unlike the neighboring calls).

---

## Verdict-class mapping (conclusion)

- **`failed` = a distinct, legitimate verdict class** for a worker's terminal ERROR envelope. 3 of
  its 4 named instances (W1-T6, W1-T9, W1-T12) are genuine `error_max_turns` over-scope events —
  correctly labeled, already independently diagnosed as a task-sizing pattern (not a labeling
  defect). The 4th (W1-T12a) was a confirmed classifier bug, **already fixed** upstream (`#59`) —
  it can no longer occur as described.
- **`incomplete` is NOT a distinct verdict class — it is the absence of one.** All 3 named
  instances share only that they threw past every structured verdict path into `run-task.ts`'s
  single generic top-level `catch`, which records a free-text `run.error` and no `verdict`. Their
  actual causes are three unrelated things: (a) an uncaught max-turns throw with zero
  error-handling machinery, from *before* the same-day fix that added it (`f2667d8`) — historical,
  already closed; (b) a host-level `npm` self-update race stealing the shared `claude` binary
  mid-spawn — environmental, unrelated to any code path; (c) an unguarded `git push origin HEAD`
  failing after a clean success — a live gap in `runTask`'s push call specifically, still present.
- **`failed` and `incomplete` are therefore two sides of *different* holes, not one.** The one
  point of real overlap — a max-turns exhaustion *can* surface as either, depending purely on
  whether the SDK's error surfaces as a structured result envelope (→ `workerErrorVerdict` →
  `failed`) or as a synchronous throw outside that machinery (→ generic catch → `incomplete`) — was
  itself already closed for the implement stage by `f2667d8` on 2026-07-14. No other overlap
  exists: the remaining `incomplete` causes (binary-swap race, unguarded push) have nothing to do
  with turn budgets or with `failed`'s subtype taxonomy at all.
- **No golden is minted (P6a).** Per acceptance, this is evidence-only. The one still-open,
  currently-reproducible gap this pass surfaces — `src/run-task.ts:1938`'s unguarded `git push` —
  is a candidate for a future plan-only ratified task, not a patch here.
