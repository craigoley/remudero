# DIAGNOSIS — W1-T6 died `error_max_turns` at 61 turns (run-W1-T6-1784070779114)

**Branch:** `diag/w1t6-max-turns` · **Mandate:** evidence, no fix.
**Verdict:** **H3 (looping) FALSIFIED. H2 (over-scoped) FALSIFIED as stated. H1 (ceiling too low) is the
proximate cause but MISDIAGNOSED.** The worker made **steady forward progress** on a genuinely large,
cross-cutting, exploration-heavy task and exhausted a **HARDCODED 60-turn budget**. Naively raising 60 is
wrong: **the `mounts.yaml` table W1-T5 shipped one run earlier to set exactly this knob is DEAD CODE — it
is imported nowhere in the spawn path — and it prescribes a LOWER implement budget (30–50), so wiring it
as-is would make W1-T6 fail SOONER.** Turn budgeting is *unowned*: hardcoded in one place, tabled-but-
unwired in another, and the table's implement budgets were guessed too low.

---

## Root cause (named)

**A cross-cutting telemetry task hit an unowned, hardcoded turn ceiling while progressing normally.** W1-T6
must add `{model, effort, tokens, total_cost_usd, billing_mode, verdict}` to *every* ledger log line — but
the worker (`worker.ts`) does not currently CAPTURE `model/effort/tokens` from the SDK result envelope at
all, so the "one criterion" forces a coordinated change across `ledger.ts` (schema) → `worker.ts`
(`WorkerResult` + `collectWorkerResult` capture, 7 edits) → `run-task.ts` (thread the fields into ~5
distinct `log()` call sites, 6 edits) → tests for each. Add ~33 turns of upfront SDK-usage discovery
(`ModelUsage`/`BetaUsage`/`ApiKeySource`/effort types) and 60 turns ran out mid-wiring. The ceiling it hit
is `maxTurns: 60`, **hardcoded at `src/run-task.ts:670`**, not read from the routing table built for this.

---

## The single falsifying observation per rejected hypothesis

- **H3 (looping) — FALSIFIED by:** the 19 file edits target **6 distinct files with 19/19 DISTINCT
  `old_string` anchors**, progressing monotonically test → schema → worker capture → run-task wiring. A
  revert-loop repeats the SAME anchor (edit X, revert X, re-edit X); none repeats. (Evidence 4.)
- **H2 (over-scoped) — FALSIFIED by:** W1-T6 has **exactly ONE acceptance criterion**. It is *not* four
  unrelated subsystems like W1-T3. (Evidence 3.) *Caveat:* that one criterion is deceptively cross-cutting
  (it touches the whole spawn/ledger stack because the fields aren't captured today) — so "over-scoped
  relative to its turn budget" is partly true, but not in the "multiple concerns" sense H2 asserts.
- **H1 (ceiling too low) — the number 60 was indeed exceeded by honest work, but the framing is wrong,
  FALSIFIED by:** `mounts.yaml` prescribes implement `max_turns` of **30 / 40 / 50** (low/med/high) — all
  **below** the hardcoded 60. The just-shipped policy would LOWER the ceiling, not raise it. So "just raise
  the limit" contradicts the routing table that is supposed to own the limit.

---

## Evidence (command → raw output)

### E1 — the exact `max_turns` an implement worker receives, and its source

```
$ grep -n "maxTurns:" src/run-task.ts
276:  maxTurns: 12,          # (review reviewer)
621:  maxTurns: 8,           # recon
670:  maxTurns: 60,          # ← IMPLEMENT worker (the one that died)
708:  maxTurns: 60,          # implement resume
1012: maxTurns: 40,          # retro architect
```
`src/run-task.ts:670` — literal `maxTurns: 60`, comment: *"60 gives real work room; a run that hits it is
genuinely looping."* **HARDCODED. Not resolved from mounts.**

### E2 — is `mounts.ts` consumed in the spawn path? ★ THE LOUD FINDING

```
$ grep -rn "import.*mounts\|from.*mounts" src/ | grep -v mounts.test
ZERO imports of mounts.ts in src/
$ grep -rn "resolveMount\|loadMounts\|mountsPath" src/ | grep -v src/lib/mounts.ts
(no output — called ONLY by test/mounts.test.ts)
```
**`mounts.ts` is DEAD CODE in the runtime path.** W1-T5 shipped a `(task_type × risk) → {model, effort,
max_turns, context_budget}` table that **nothing consults** — the two "mounts" mentions in `run-task.ts`
(:1102) and `worker.ts` (:16) are *comment strings*, not imports.

**Second, independent wiring gap:** `resolveMount(m, taskType, risk)` REQUIRES a `risk`, but tasks don't
carry one — `W1-T6 risk fields: 0`, and only 2 tasks in the whole plan have a `risk:` field. Even if the
import existed, `resolveMount("implement", undefined)` would THROW. mounts is **doubly-unwired.**

### E3 — W1-T6's acceptance criteria and subsystem count

```
acceptance:
  - claim: "every worker + brain call logs {model, effort, tokens, total_cost_usd, billing_mode, verdict}"
    proof: "a run's ledger lines contain all fields; billing_mode reads 'subscription'"
```
**ONE criterion.** But delivering it touches `ledger.ts` (LedgerLine schema), `worker.ts` (capture
model/effort/tokens from the SDK envelope — *not captured today*), `run-task.ts` (every `log()` site), and
each of their tests. One *concern*, whole-stack *reach*.

### E4 — failed run ledger + transcript, characterized

Ledger (`~/Remudero/state/ledger.ndjson`, run `W1-T6-1784070779114`):
```
run.start        type=implement budget_usd=100
containment.probe contained=true
recon.done       session=0967b1fa… 4 turns $0.268 success
learnings.injected matched=7 budget_chars=1800
implement.done   session=1641900d… 61 turns $4.5546 subtype=error_max_turns
verdict          failed / implement / error_max_turns / 61 turns / $5.0597
```
Implement transcript `…/1641900d-….jsonl` (320 lines, 70 tool calls). Tool-call shape:
- **turns 1–33:** grounding — read `ledger.ts`, `worker.ts`, `run-task.ts`, and the SDK `.d.ts` for
  `ModelUsage`/`BetaUsage`/`ApiKeySource`/effort (learning where `{model, effort, tokens}` live).
- **turn 34:** first `Write` — a *failing test* (tdd:strict).
- **turns 35–70:** implement + wire: `Write ledger.ts` → 7×`Edit worker.ts` (WorkerResult +
  `collectWorkerResult` capture) → 6×`Edit run-task.ts` (thread fields into `recon.done`,
  `implement.done`, `implement.resumed`, `review.reviewer`, `retro.synthesized`) → typecheck/greps.

Edit-anchor analysis (the H3 falsifier):
```
total edits: 19 | distinct old_string anchors: 19
files: worker.ts×7, run-task.ts×6, ledger.test.ts×2, worker.test.ts×2, ledger.ts×1, run-task.test.ts×1
```
**19/19 distinct anchors across 6 files = steady forward progress, no repeated-revert loop.** It died
mid-wiring the last log sites, before a final green test run.

### E5 — cost/turn shape

```
recon:     4 turns  $0.268  → $0.067/turn
implement: 61 turns $4.555  → $0.075/turn   (~10 min wall ⇒ ~10 s/turn)
```
Essentially **linear** (implement $/turn ≈ recon $/turn); no acceleration/thrash signature. *Unverifiable:*
the ledger records only end totals, so per-turn deltas can't be plotted — "linear vs accelerating" is
inferred from tool cadence + the monotonic distinct-edit progression, not from per-turn spend.

---

## Exact minimal fix (described, NOT implemented) — a combination

1. **WIRE `mounts.yaml` into the spawn path** (the load-bearing fix). In `run-task.ts`, replace the
   hardcoded `maxTurns: 60/8/40` (and later `model`/`effort`) with values resolved from the table:
   `const mount = resolveMount(loadMounts(mountsPath(config.root)), task.type, task.risk ?? "medium")` and
   pass `mount.max_turns` / `mount.model` / `mount.effort` to `spawnWorker`. **Also give tasks a `risk:`
   field** (default `medium`) so `resolveMount` can key — today 0/N implement tasks carry one. Until this
   lands, **W1-T5 is inert: a table nothing reads.**
2. **RECALIBRATE the implement turn budgets in `mounts.yaml` from OBSERVED data.** W1-T6 needed **>61 turns
   of honest work**, but the table gives implement 30/40/50. Set implement (esp. high-risk / cross-cutting)
   to a realistic budget with headroom (~100–120). Note the chicken-and-egg: the telemetry W1-T6 itself
   ships + the retro calibration table are the very inputs that should set these numbers — so seed from
   observed runs, not the current guesses.
3. **Cut the exploration tax** (~33 of 61 turns were SDK-usage discovery). Pre-author task CONTEXT naming
   where `{model, effort, tokens}` live in the SDK result envelope (`ModelUsage`/`BetaUsage`), and/or
   DECOMPOSE W1-T6 into "capture telemetry in `worker.ts`" + "log it at every call site" so each half fits
   a turn budget. (This is an Architect plan-edit, not a worker action — Rule 16.)

Do **not** simply bump the literal `60`: it lets *this* run finish but leaves budgeting unowned and
contradicts the shipped routing policy. The fix is to make mounts authoritative AND correct its numbers.

---

## Could not verify

- **Per-turn spend curve** — only end totals are ledgered (E5); linearity is inferred, not measured.
- **Whether the worker would have finished at, say, ~80 turns** — it died mid-wiring with tests not yet
  green, so the true completion turn count is unknown (only a lower bound: >61).
- **Live re-run under a raised limit** — not attempted (read-only mandate; also would burn spend).

## One-line summary

Not a loop and not multi-concern: a whole-stack, exploration-heavy telemetry task ran out of a **hardcoded
60-turn budget** while progressing steadily — and the `mounts.yaml` routing table that exists to own that
budget is **dead code (imported nowhere) prescribing 30–50 anyway**. Fix = wire mounts into spawns + give
tasks a `risk:` + recalibrate implement budgets from observed data; never just bump the `60`.
