# DIAGNOSIS — W1-T9 max_turns: OVER-SCOPED (multi-concern), not a loop, not a dropped-learning tax

**Branch:** `diag/w1t9-max-turns` · **Mode:** evidence-only (no fix, no PR) · **Date:** 2026-07-15

## Symptom

`rmd drain` ran **W1-T9** (`Config loader + rmd init wizard v0`). The implement worker
died `verdict=failed`, `subtype=error_max_turns` at **81 turns**, notional **$5.05**, no
PR. Run `W1-T9-1784079348848`, implement session `739c868a-fbdb-4630-b83e-d41f256253ca`.

## What T9 received (risk + mount)

```
$ plan/tasks.yaml → W1-T9:  risk: medium   (files: null)
$ .remudero/mounts.yaml → implement.medium: { max_turns: 80, model: sonnet, effort: high }
```

**T9 is `risk: medium` ⇒ an 80-turn budget, and it overran by exactly 1 (81).** Surface
signature matches W1-T6 (also died one over its budget). But the transcript shows T9 is a
*different* failure underneath.

---

## Root cause (NAMED): `over-scoped-multi-concern`

**T9 bundles two independent concerns plus a hard interactive sub-problem, and consumed
its 80-turn budget on genuine (non-looping) work: ~29 turns of legitimate discovery, then
real cross-cutting implementation, then ~15 terminal turns thrashing on `readline` inside
a non-interactive worker.** It is NOT a loop (H3) and NOT a dropped-learning exploration
tax (H2, strict). It is the H1 class — genuinely too big — but the sharper truth is that
it is **two concerns that should be split**, one of which (interactive confirmation) is
ill-posed for the automated worker and will overrun again at ANY budget.

### The two concerns (acceptance maps 1:1 to two subsystems)

```
$ plan/tasks.yaml → W1-T9.acceptance:
  1. "wizard detects tier via /usage + ~/.claude.json keys, then SHOWS it for confirmation"
  2. "config validation rejects overflow:api_key + daily_cap:none"
```

Criterion 1 = tier detection + interactive confirm (`tier.ts` + `init.ts`); criterion 2 =
config schema + validation (`config.ts`). The worker's own file set confirms the breadth:

```
Writes: src/lib/tier.ts, src/lib/init.ts, test/tier.test.ts, test/config.test.ts, test/init.test.ts
Edits : config.ts×4, init.ts×3, run-task.ts×7, bin/rmd×1, config.test.ts×2, init.test.ts×4, LEARNINGS.md×1
```

Five new files + two new lib modules + CLI wiring into `run-task.ts` (7 edits) + three
test files — for one "medium" task.

---

## Evidence per hypothesis

### H3 LOOPING — FALSIFIED

**(a) Edit-anchor distinctness** (T6's method — repeated `old_string` anchors = thrash):

```
config.ts:      4 edits, 4 distinct anchors
init.ts:        3 edits, 3 distinct
run-task.ts:    7 edits, 6 distinct   (one anchor re-touched once)
init.test.ts:   4 edits, 4 distinct
config.test.ts: 2 edits, 2 distinct
TOTAL:         22 edits, 21 distinct anchors
```

Monotonic, near-zero anchor reuse → not looping.

**(b) Cost/turn shape** (accelerating = loop; linear = honest), 152 assistant msgs:

```
             avg output_tok   avg cache_read
first third      1047             54,782
middle            745            110,072
last third        781            142,636
```

Output tokens per turn DECLINE then flatten; cache-read grows ~linearly (normal context
accumulation, not an exponential blow-up). Not a runaway.

**(c) Monotonic file creation** — new files appear once, in order, mid-run:

```
turn 30: tier.ts   turn 37: init.ts   turn 58: tier.test.ts   turn 59: config.test.ts   turn 62: init.test.ts
```

→ **H3 falsified** on all three independent measures.

### H2 EXPLORATION TAX (re-discovering an injectable learning) — FALSIFIED (strict form)

The run injected `matched: 6` and DROPPED 19 learnings (files:null ⇒ repo-wide selection,
budget-capped). But **none of the dropped learnings concern tier detection** — they are
`sdk-result-envelope`, `lazy-config-in-ci`, `shell-isolation`, etc. The knowledge T9
actually needed was elsewhere:

```
$ grep -niE "cachedUsageUtilization|oauthAccount|\.claude\.json|/usage" plan/learnings.yaml
  → NOT in learnings.yaml (never injectable)
$ grep /usage src/lib/headroom.ts
  → headroom.ts:2  "parser for `claude -p \"/usage\"`" (W1-T4 — which W1-T9 depends_on)
```

So `/usage` parsing lived in `headroom.ts` (T9's own dependency), and the `~/.claude.json`
tier keys (`cachedUsageUtilization`, `oauthAccount`, `hasAvailableSubscription`) are
captured in **no learning and no obvious code** — the worker discovered them first-hand
(transcript t22: `grep -n "cachedUsageUtilization|oauthAccount|hasAvailableSubscription" …`
returned nothing → manual discovery). This is **first-time discovery, not re-discovery of a
dropped-but-injectable learning**, so H2-strict is falsified.

*Weak residue:* the up-front discovery (turns 1–29, ~36% of budget before the first
production Write at t30) was real. Sample:

```
t2  grep W1-T9 MASTER-PLAN.md       t10 Read config.ts        t14/16 Read run-task.ts
t11 Read headroom.ts                t17 Read mounts.ts        t18 grep daily_cap|overflow|metering
t19 grep "rmd init" LEARNINGS/FINDINGS/DECISIONS   t22 grep claude.json keys   t23 sed FINDINGS.md
```

Most of this is *necessary* cross-cutting context-building; a few turns (the claude.json
key shape) could be saved by a learning — but that alone never closes an 80→81 gap on a
task this broad. Not the primary cause.

### H1 BUDGET TOO LOW / genuinely big — CONFIRMED, and the terminal thrash is a HARD sub-problem

Turn phases:
- **turns 1–29 — discovery** (22 Bash + 7 Read before any Write).
- **turns 30–62 — implementation** (tier.ts, init.ts, config.ts edits, 3 test files).
- **turns 63–91 — test/debug, then STUCK.** The last ~20 tool-using turns are not
  progress toward a PR — they are a `readline` rabbit hole:

```
t73 which claude                 t77 rl-repro.mjs   (readline reproduction script)
t74–76 …config.json 2>&1  (×3)   t78 rl-repro2.mjs  (second readline repro)
t81 npm run build                t82–83 …config.json
t84 rl-repro2.mjs; npm test; npm run build          t88 Edit LEARNINGS.md
t89 git diff --stat              t91 npm run build … npm test    ← still not a PR at turn 91
```

The worker wrote **`rl-repro.mjs` / `rl-repro2.mjs`** — readline reproduction scripts — and
burned the budget's tail trying to make/prove **interactive stdin confirmation** work inside
a spawned, **non-interactive** SDK worker (no TTY, no operator). Acceptance criterion 1
("SHOWS it for confirmation, operator confirms") is **ill-posed for the automated worker**:
there is nobody to confirm and no TTY to read, so the worker cannot satisfy or test it as
written. This concern would overrun again at 120 turns just as it did at 80.

→ **H1 confirmed** (genuinely big), with the decisive nuance that one concern is not merely
big but *structurally unfit* for the worker environment.

---

## The minimal fix (DESCRIBED — not implemented)

**This is the THIRD max_turns event. Per the binding guardrail, the fix is NOT a budget
bump** — T9 is not a clean single-concern task that merely needs more turns; it is
over-scoped and one concern is ill-posed. **DECOMPOSE it (Architect plan edit):**

- **W1-T9a — config loader + schema + validation.** Criterion 2 (reject
  `overflow:api_key + daily_cap:none`). Pure, non-interactive, unit-testable. `risk: medium`,
  `files: [src/lib/config.ts]`.
- **W1-T9b — tier detection.** `/usage` (via `headroom.ts`) + `~/.claude.json` key parsing
  → `tier.ts`, returning the detected tier as data. Pure, unit-testable. `risk: medium`,
  `files: [src/lib/tier.ts, src/lib/headroom.ts]`.
- **W1-T9c — `rmd init` wizard.** Show detected tier → confirm → write config. **Redesign the
  confirm for a non-interactive worker**: a `--tier`/`--yes` non-interactive path and a
  confirm that defaults when `stdin` is not a TTY, so acceptance is testable WITHOUT a live
  operator. Without this redesign, T9c overruns at any budget (the readline thrash above).

Supporting (cheap, mitigates the weak-H2): give W1-T9b a `files:` field and ADD a
`learnings.yaml` entry capturing the `/usage` preamble shape + the `~/.claude.json` tier
keys (`cachedUsageUtilization`, `oauthAccount`, `hasAvailableSubscription`), tagged to
`tier.ts`/`headroom.ts`, so the detection discovery is paid once.

---

## Is this a PATTERN? (yes — and it is a SIZING problem, not a mount-budget problem)

**T6 and T9 are BOTH cross-cutting/multi-concern implement tasks that overran the medium
80-turn budget.** That is a real class-level signal — but the correct fix is NOT to raise
the medium mount budget:

- Raising `implement.medium` to 120 would **mask over-scoping and reward it**, and it is
  precisely the "third budget bump" the guardrail forbids.
- The medium/80 budget is well-calibrated for *genuine single-concern* implement work
  (W1-T1D 21, W1-T3* 21–42 turns — all comfortably under 80).

The class problem is **task SIZING**, not mount calibration: tasks that (a) carry ≥2
independent acceptance concerns, or (b) ship new lib modules **and** wire a new subsystem
into `run-task.ts` + tests, are being **mis-labeled `risk: medium`** when they are
effectively high/multi-concern. **Retro/Architect fix at the PLAN layer** (not mounts.yaml):
add a sizing heuristic — *decompose, or mark `risk: high`, any task spanning ≥2 acceptance
concerns or ≥2 new subsystems* — and leave `implement.medium: 80` as-is. (A secondary
class lesson: any acceptance criterion requiring interactive/operator input must specify a
non-interactive worker path, or it is unimplementable by the runner regardless of size.)

## One-line root cause

W1-T9 died at 81/80 not from looping (21/22 distinct edit anchors, non-accelerating
cost/turn) and not from a dropped-learning tax (the tier-detection knowledge was never an
injectable learning), but because it is an **over-scoped two-concern task** (tier-detection
wizard + config validation) whose interactive-confirm concern is **ill-posed for a
non-interactive worker** — so the fix is **decomposition** (W1-T9a/b/c, with T9c's confirm
redesigned for no-TTY), and the T6+T9 pattern is a **task-sizing** calibration for the
retro, NOT a third raise of the medium mount budget.
