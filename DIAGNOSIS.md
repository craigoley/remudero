# DIAGNOSIS — W1-T12 max_turns: OVER-SCOPED (3 concerns) + 3 HEADLESS-UNFIT criteria

**Branch:** `diag/w1t12-max-turns` · **Mode:** evidence-only (no fix, no PR) · **Date:** 2026-07-15

## Symptom

`rmd drain` ran **W1-T12** (the daemon — scheduler loop + launchd unit + env-clean boot
assertion + crash recovery). Implement worker died `error_max_turns` at **81 turns**
(medium mount budget = 80), **$10.27**, no PR. Run `W1-T12-1784083512132`, implement
session `242c4b39-14fb-4c80-9e75-a5f231c715ee`. This is the **FOURTH** max_turns event.

## What T12 received + its shape

```
$ plan/tasks.yaml → W1-T12:  risk: medium  (⇒ 80-turn mount)   files: null
  acceptance:  THREE criteria —
   1. "the daemon drains a 3-task plan on remudero-sandbox end-to-end, unattended, OVERNIGHT"
      proof: ledger + merged PRs + daily digest received
   2. "launchd unit uses absolute paths + explicit PATH; the daemon asserts its own env is
       ANTHROPIC-clean at boot"                proof: startup ledger line env_clean=true
   3. "daemon killed mid-task recovers correct state from git + GitHub alone"
      proof: chaos-drill transcript
```

Three criteria, three separable concerns (scheduler/drain · launchd/boot-env ·
crash-recovery), still `risk: medium`.

---

## Root cause (NAMED): `over-scoped-multi-concern` (H2, dominant) + `headless-unfit-criteria` (H3, all three)

**T12 is the WORST-specified task in the file: three separable concerns (Rule 19
violation) whose three acceptance criteria each require a live context a non-interactive
worker cannot produce (Rule 18 violation ×3).** The worker did not loop (H4 falsified) and
was not a clean single concern needing more budget (H1 falsified). It died **mid-build**,
consumed by the sheer volume of a ≥3-subsystem implementation (plus a costly self-review
sub-agent fan-out), and had not even reached the three criteria — which were unverifiable
by it in any case. **Not the T6 pattern (H1); it is the T9 pattern doubled — multi-concern
AND multiple headless-unfit criteria.**

Meta-finding: **Rules 18 & 19 already existed when T12 ran, but were never applied to this
pre-authored task** — rules were enforced forward-only, so T12 slipped through.

---

## Evidence per hypothesis

### H4 LOOPING — FALSIFIED

**Edit-anchor distinctness** (repeated `old_string` = thrash):

```
daemon.ts:       7 edits, 7 distinct anchors
run-task.ts:     6 edits, 6 distinct
daemon.test.ts:  6 edits, 6 distinct
env.ts:1  plist.template:1  bin/rmd:1  (all distinct)
TOTAL:          22 edits, 22 distinct anchors  (zero reuse)
```

**Cost/turn shape** (accelerating = loop), 162 assistant msgs:

```
             avg output_tok   avg cache_read
first third      1796             70,537
middle           931            142,184
last third       1586            185,489
```

Output dips then rises — but the last-third rise is a **self-review sub-agent fan-out**
(below), not runaway generation; cache-read grows ~linearly (normal context accumulation).
Not a loop. → **H4 falsified.**

### H1 UNDER-BUDGETED-BUT-CLEAN — FALSIFIED

Not a single coherent concern. New files created span **multiple distinct subsystems**,
built across the run:

```
Writes:  t26 daemon.ts   t33 com.remudero.daemon.plist.template   t34 launchd.ts
         t53 daemon.test.ts   t58 launchd.test.ts
Edits :  run-task.ts×6, env.ts×1, bin/rmd×1   (CLI wiring + boot env assertion)
```

Scheduler/daemon + launchd/plist + env-clean-boot + CLI wiring = ≥3 concerns. A clean
single-concern task does not fan across `daemon.ts`, a launchd `.plist` template,
`launchd.ts`, `env.ts`, and `run-task.ts`. → **H1 falsified.**

### H2 OVER-SCOPED MULTI-CONCERN — CONFIRMED (dominant)

The acceptance has **3 concerns** and the diff touched **≥3 subsystems** (above). First
production Write (`daemon.ts`) not until **turn 26** (~25% discovery up front; first third
= 28 Bash, 3 Write, 3 Edit). The worker was still **building** at the ceiling, not
verifying — it never reached criteria 1/2/3. A secondary token sink accelerated the
exhaustion: at **t77–t84** the worker invoked a `code-review` Skill that fanned out **five
review sub-Agents** on its own diff —

```
t77 Skill: code-review
t80–t84 Agent ×5: "Diff review: line-by-line scan" / "removed-behavior audit" /
                  "cross-file call-site tracer" / "reuse/simplify/efficiency" / "altitude + conventions"
```

— a legitimate but very expensive self-review (~8 turns + a large share of the $9.75
implement cost) spent when the task was already over budget-horizon. → **H2 confirmed.**

### H3 HEADLESS-UNFIT CRITERIA — CONFIRMED (all three), but LATENT (worker never reached them)

Unlike T9 (which visibly thrashed on `readline`-repro in its final turns), T12's **last 15
turns show steady build progress, not stuck-on-unfit**:

```
t88 Edit env.ts   t89 Read daemon.ts   t90–92 Edit daemon.ts   t93 grep contrib/launchd
t94 Edit daemon.ts   t96–97 Edit daemon.test.ts   t98 npm test   t100 Read run-task.ts   t101–102 Edit run-task.ts
```

And a whole-transcript scan for live operations returns **nothing**:

```
$ grep (launchctl | "launchd load" | "kill -9" | pkill | chaos | overnight | daemon-kill)  → 0 matches
```

So the worker correctly never attempted a live `launchctl`/kill — but that means **all
three criteria were structurally unsatisfiable by it**, independent of budget:

- **Criterion 1** ("drains a 3-task plan … unattended, OVERNIGHT", proof = merged PRs +
  digest) is a **task-inside-a-task on a wall-clock horizon** — a single implement worker
  cannot run the whole system overnight and produce real merged PRs. Rule 18.
- **Criterion 2** ("launchd unit … asserts ANTHROPIC-clean at boot", proof = startup ledger
  line) needs a **`launchctl` load into a live user session** to verify boot. Rule 18.
- **Criterion 3** ("daemon killed mid-task recovers", proof = chaos-drill transcript) needs
  **killing a live daemon** and observing recovery. Rule 18.

→ **H3 confirmed for all three** — latent (never reached), but they would block a completed
build too. T12 = T9's failure mode doubled: multi-concern **and** multi-headless-unfit.

---

## The minimal fix (DESCRIBED — not implemented)

**Fourth max_turns event. Per the binding guardrail, a budget bump is wrong** — T12 is
neither clean-single-concern nor free of headless-unfit criteria. **DECOMPOSE along the
machine/human boundary** (Rule 19 split + Rule 18 headless-rewrite; no criterion dropped,
Rule 16):

- **W1-T12a — scheduler loop (daemon core)**, `risk: high` (120). The pure loop: select
  next-runnable via the DAG, invoke the existing run path, honor Pause/Resume/STOP (W1-T11),
  consult HeadroomTracker, take the drain+inflight locks. **Headless criterion:** with an
  injected clock + injected runner, the loop dispatches in dependency order and stops on
  STOP/Pause/headroom — unit-tested over a fake plan + fake runner (no real overnight run,
  no real spawns).
- **W1-T12b — launchd unit generation**, `risk: medium`. Generate the `.plist` (absolute
  paths, explicit PATH) + the boot env-clean assertion in startup code. **Headless
  criterion:** assert the generated plist contents + unit-test the startup routine logs
  `env_clean=true`/`billing_mode=subscription` in-process (NOT a real `launchctl` load).
- **W1-T12c — crash-recovery logic**, `risk: medium`. On start, derive correct state from
  git + GitHub + ledger; resume/clean orphaned worktrees. **Headless criterion:** given a
  seeded interrupted state (orphaned worktree + unmerged branch + partial ledger), the
  recovery routine reconstructs correct state — unit test (NOT a live kill).
- **W1-T12d — daemon live commissioning**, `verify: human`, `type: manual`, depends
  [T12a,b,c]. The three things a worker structurally cannot do, moved to the operator:
  (i) `launchctl`-load the plist on a real session; (ii) run a real unattended overnight
  drain on remudero-sandbox; (iii) kill the live daemon mid-task and confirm recovery.
  Proof: operator-confirmed with pasted evidence. (The games' draft→playtest→ready pattern:
  the machine builds and unit-proves the logic; the human commissions it live.)

Rewire the WS-1-complete milestone from `W1-T12` → `[W1-T12a, W1-T12b, W1-T12c, W1-T12d]`.

**Process fix (the meta-gap):** Rules 18/19 pre-existed T12 but were applied forward-only.
A new sizing/fitness rule must **retroactively re-grade the open queue** — `rmd retro`
should re-check every queued task against every standing rule and flag violations.

## One-line root cause

W1-T12 died at 81/80 not from looping (22/22 distinct anchors, non-accelerating cost) and
not as clean-under-budget work, but because it is the **worst-specified task in the file**:
three separable concerns (Rule 19) whose three criteria each demand a **live context a
headless worker cannot produce** — overnight drill, `launchctl`-load, live daemon-kill
(Rule 18 ×3) — so the fix is **decomposition along the machine/human boundary** (T12a/b/c
headless + T12d verify:human), not a fourth budget bump; and the fact that T12 pre-existed
Rules 18/19 yet slipped through is itself a finding: **standing rules must sweep the
existing queue, not only govern new authoring.**
