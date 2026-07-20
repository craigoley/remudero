# ORIENTATION

_MAINTAINED BY `rmd retro` — regenerated 2026-07-20T02:06:20.637Z. Hand edits are overwritten on the next retro; change MASTER-PLAN.md or plan/tasks.yaml instead, never this file directly._

A fresh Architect session should be able to orient from THIS doc alone plus the plan index —
not by re-deriving state from the full plan and ledger.

## Current state

195 run(s) since the last retro marker. Verdicts: {"blocked":5,"blocked_ci":21,"blocked_containment":2,"blocked_isolation":2,"incomplete":111,"no_pr":42,"pr_attribution_failed":12}.

### Shipped since marker
- W1-T1 → https://github.com/craigoley/remudero/pull/255 (gate-side merge; run ended pr_attribution_failed)
- W1-T102 → https://github.com/craigoley/remudero/pull/194 (gate-side merge; run ended blocked)
- W1-T103 → https://github.com/craigoley/remudero/pull/196 (gate-side merge; run ended blocked_ci)
- W1-T108 → https://github.com/craigoley/remudero/pull/274 (gate-side merge; run ended blocked)
- W1-T115 → https://github.com/craigoley/remudero/pull/279 (gate-side merge; run ended blocked)
- W1-T132 → https://github.com/craigoley/remudero/pull/282 (gate-side merge; run ended incomplete)
- W1-T27 → https://github.com/craigoley/remudero/pull/204 (gate-side merge; run ended blocked_ci)
- W1-T29 → https://github.com/craigoley/remudero/pull/216 (gate-side merge; run ended blocked_ci)
- W1-T30 → https://github.com/craigoley/remudero/pull/218 (gate-side merge; run ended blocked_ci)
- W1-T31 → https://github.com/craigoley/remudero/pull/220 (gate-side merge; run ended blocked_ci)
- W1-T32 → https://github.com/craigoley/remudero/pull/222 (gate-side merge; run ended blocked_ci)
- W1-T33 → https://github.com/craigoley/remudero/pull/224 (gate-side merge; run ended blocked_ci)
- W1-T34 → https://github.com/craigoley/remudero/pull/228 (gate-side merge; run ended blocked_ci)
- W1-T35 → https://github.com/craigoley/remudero/pull/226 (gate-side merge; run ended blocked_ci)
- W1-T36 → https://github.com/craigoley/remudero/pull/230 (gate-side merge; run ended blocked_ci)
- W1-T37 → https://github.com/craigoley/remudero/pull/232 (gate-side merge; run ended blocked_ci)
- W1-T38 → https://github.com/craigoley/remudero/pull/234 (gate-side merge; run ended blocked_ci)
- W1-T39 → https://github.com/craigoley/remudero/pull/236 (gate-side merge; run ended blocked_ci)
- W1-T40 → https://github.com/craigoley/remudero/pull/238 (gate-side merge; run ended blocked_ci)
- W1-T44 → https://github.com/craigoley/remudero/pull/240 (gate-side merge; run ended blocked_ci)
- W1-T46 → https://github.com/craigoley/remudero/pull/245 (gate-side merge; run ended blocked_ci)
- W1-T47 → https://github.com/craigoley/remudero/pull/247 (gate-side merge; run ended blocked_ci)
- W1-T48 → https://github.com/craigoley/remudero/pull/251 (gate-side merge; run ended blocked_ci)
- W1-T50 → https://github.com/craigoley/remudero/pull/249 (gate-side merge; run ended blocked_ci)
- W1-T97 → https://github.com/craigoley/remudero/pull/197 (gate-side merge; run ended blocked_ci)
- W1-T98 → https://github.com/craigoley/remudero/pull/199 (gate-side merge; run ended blocked_ci)
- W2-T3 → https://github.com/craigoley/remudero/pull/242 (gate-side merge; run ended blocked)
- W3-T1a → https://github.com/craigoley/remudero/pull/212 (gate-side merge; run ended incomplete)

## Next runnable task

**W1-T41** — rmd triage — the Architect intake worker (ground → research → grill-or-propose)

- risk: medium · depends_on: W1-T40

## Never-do invariants (MASTER-PLAN §12 Standing rules — extracted verbatim; §12 is authoritative)

- 1. PROVENANCE OR IT DOESN'T GO IN A PROMPT.
- 2. Trust, scheduling, strikes, budgets = deterministic predicates. Never LLM decisions.
- 3. One concern per PR. Branch from latest origin/main. Isolated worktrees.
- 3B. The merge gate is a GitHub-enforced CONTRACT (required status checks), never a runner-side decision that can be raced. `ci` (typecheck+tests) AND `remudero-review` (acceptance verdict by a fresh-context reviewer) must both be green; GitHub does the merging. The runner ARMS auto-merge and observes — its exit verdict is advisory telemetry, incapable of diverging from reality. Corollary: auto-merge is safe to leave armed, because the contract, not the runner, decides.
- 4. Acceptance criteria are proofs, not vibes. Green checks ≠ evidence (the full-shop-flow lesson).
- 5. Never a third blind patch: two strikes → diagnose → one evidence-armed retry → escalate.
- 6. Zero ask rules in worker settings. Hooks <1s. Workers carry scoped PATs only. No MCP in workers.
- 7. DISTRUST THE PROMPT OVER THE INSTALLED VERSION. Empirically the highest-value line in the template: WS-0 caught `allowedDomains` nesting; W1-T1 caught that the SDK's own schema is `$loose` and silently strips unknown keys — a guard built as specified would have PASSED the typo it exists to catch. Every Promptsmith-rendered prompt injects this rule. Read the installed schema; never trust a prompt's spelling, including this document's.
- 8. OpenClaw stays out. The mini's protected paths are inviolate (deny-floor).
- 8. The loop never waits on a human unless the plan says so. Idle = groom.
- 9. OSS defaults must be defensible on a stranger's machine; yolo is a documented opt-in.
- 10. This document is truth. Every session syncs it before acting and after shipping.
- 11. Isolation and containment are PROVEN PER RUN by probe, never assumed from configuration. A setting that "should" isolate (ZDOTDIR, a sandbox block, a stripped env) is a hypothesis until a preflight probe confirms it on THIS machine, THIS run — config that happens to work by accident of the host (PR #8: isolation held only because `~/.bashrc` was absent) must fail closed the moment the accident ends. See FIELD FINDING 11, W1-T17.
- 12. Supervision is deterministic; judgment is advisory. An LLM may RECOMMEND a halt; only code may ENFORCE one. The flight judge and specialist panels (§4B) return verdicts a deterministic controller acts on; no LLM sits in the merge decision, and none edits code. See §4B, W1-T20/21/22, W2-T1.
- 13. A doc that DESCRIBES a mechanism is never proof the mechanism EXISTS. Acceptance proofs must be OBSERVABLE SYSTEM STATE — `gh api` output, a status object, a grep of the call site, a passing test — never a file that talks about it. PR #12 shipped `docs/review-gate.md`, passed CI, reported `verdict=merged`, and did none of its job (protection unchanged, no status ever posted). [PR #12/#13]
- 14. Splitting a task can ORPHAN its call site — when you split, name the integration point explicitly as one side's deliverable. T1C built the reviewer and T1D was to enforce it, but NEITHER owned `run-task.ts` CALLING it; the reviewer was fully-tested dead code for two PRs. The wiring is a deliverable, not a seam. [PR #12/#13]
- 15. When a worker is blocked by an acceptance gate, it may ADD the missing work or ESCALATE. It may NEVER edit the acceptance criteria to match its diff. Workers have write access to `plan/tasks.yaml`, so this prohibition is stated in every rendered prompt, not assumed. The gate names the gap; the fix is to close the gap, not to move the goalposts. [session doctrine]
- 16. The Architect may correct a mis-specified task via a plan PR; a worker may never. The test of honesty is that NO criterion is dropped or weakened — only REDISTRIBUTED. A task whose criteria span multiple subsystems collides with one-concern-per-PR and is undeliverable; the Architect decomposes it by CONCERN (every criterion survives verbatim in some child task), and the `satisfied_by` field (Architect-only, plan-only PRs — rule 15) marks a criterion an earlier merge already satisfied. Splits observed: T1C, T1D, W1-T3. [PR #22, W1-T3]
- 17. PROVENANCE FOR THE PLAN, NOT JUST FOR PROMPTS. Every task must cite WHY it exists (`origin:` feedback#/retro#/architect/human + `plan_refs:` the sections it implements). A task with no origin is an ORPHAN and cannot be trusted to reflect anyone's intent. `origin:`/`plan_refs:` are Architect-only, plan-only fields (same rule as `satisfied_by`, rule 15): a worker adding an origin to justify its own diff is editing the plan to match the work. `rmd trace` (W1-T43) makes the chain feedback → task → run → PR renderable both ways. [§7B]
- 18. EVERY ACCEPTANCE CRITERION MUST BE SATISFIABLE BY A NON-INTERACTIVE WORKER. A criterion that requires live operator input ("operator confirms", "user selects", "prompt the human") is STRUCTURALLY UNFIT for the headless runner — there is no TTY and no operator, so the worker cannot satisfy or test it and will burn its whole budget trying (W1-T9 spent its last ~15 turns on readline-repro scripts conjuring an operator that isn't there, then died error_max_turns). Interactive behavior is designed for no-TTY and tested via INJECTED INPUT / FLAGS / TTY-ABSENT DEFAULTS, never a live human in the loop: a prompt is an interactive-only affordance layered on top of a fully non-interactive path. This is a new error CLASS, distinct from over-scoping (rule 19) and looping. [DIAGNOSIS.md diag/w1t9-max-turns, W1-T9]
- 19. SIZING IS A PLAN-LAYER CONCERN, NOT A BUDGET KNOB. A task spanning ≥2 independent acceptance concerns, or shipping ≥2 new subsystems, must be `risk: high` or DECOMPOSED at plan time — never left `risk: medium` and rescued with a bigger turn budget. Two cross-cutting tasks (W1-T6, W1-T9) overran the medium/80 mount; the medium budget is correctly calibrated for genuine single-concern work (observed mean now 45.2 turns — RETRO-1784133446353, 22 runs; honest single-concern merges ran 58–69 turns: #47, #48, #55, #56, #62 — still under the medium/80 ceiling; P7 ratified), so raising it would MASK over-scoping and reward it (and W1-T9 was the THIRD max_turns event — a third budget bump was refused). The retro fix lives in task SIZING (rule 16 decomposition), not in `.remudero/mounts.yaml`. [DIAGNOSIS.md diag/w1t9-max-turns, W1-T6, W1-T9; P7 RETRO-1784133446353]
- 20. A NEW SIZING/FITNESS RULE MUST RETROACTIVELY RE-GRADE THE OPEN QUEUE — RULES ARE NOT FORWARD-ONLY. When a rule like 18 or 19 is added, every ALREADY-AUTHORED open task must be re-checked against it, not only new authoring. W1-T12 pre-existed rules 18 and 19 and violated BOTH (three concerns at `risk:medium`; three live-context criteria — overnight drain, launchctl-load, live-kill) yet still reached a worker and burned 81 turns / $10.27 — the FOURTH max_turns event — because the rules were enforced forward-only. `rmd retro` re-grades every open task against every standing rule and files a corrective task for each violation (the executable duty is W1-T20d). A rule the queue is never swept against protects only the tasks written after it. [DIAGNOSIS.md diag/w1t12-max-turns, W1-T12]