# Reservation-backed skill eval qualification

The operator selected this policy on 2026-10-13: a separately approved, bounded
held-out eval may use reserved **existing** capacity despite a nonempty backlog.
Only NEW implement admissions may be held. Active work, reviews and serving stay untouched.

`qualifyReservedSkillEval` is the default-off, read-only scheduler preflight. Every
result has `dispatchAllowed: false`. `qualified` means the supplied evidence fits;
it is not a grant, a verified receipt, an acquired lease, or permission to spend.
The existing `rmd skill-eval --confirm-spend` remains quiet-only. No runtime flag,
startup sidecar or live pilot is enabled by this change.

The v1 contract freezes the approved READY60,
12-attempt and per-attempt $15 backstop values, with an executor-conformance test;
changing the executor's bounds must not silently migrate an older grant. The pure
planner imports no worker, config or ledger implementation.
The preflight keeps immutable READY + 60 minutes separate from the grant's fixed
admission and finish deadlines. Retries retain that history, consumed/revoked grants
refuse, and terminal READY history never reopens. A capacity wait includes its original
deadline. A separate deadline service must escalate even if this function is never called.

Qualification prices the entire 12-attempt paired run, including setup, grading and
shutdown, on its exact source/Node/lock/host/command/draft/held-out-set/stack binding.
It never converts an author-test profile to an eval profile or scales timing linearly
by worker count. CPU, memory, disk and an already acquired owned runtime lease must fit;
a NEW-build hold alone is not reserved execution capacity. Unknown observations refuse
or wait, never become zero-cost capacity. The calibration and lease inputs are summaries
for offline replay; a live consumer must independently validate their closed receipts.

Before a live bridge can exist: prove whole-run termination of owned descendants (not
just a Promise timeout), independent READY escalation with durable acknowledgement,
atomic single-use grant consumption, consumer/backend identity and own-lease release.
Then obtain a fresh specific live grant and rehearse on the existing host. Earlier
author-gate grants are closed and cannot authorize model attempts. Core configuration
adoption remains next natural safe startup only; no restart/recycle/deployment is authorized.

This separation follows [Google SRE overload guidance](https://sre.google/sre-book/handling-overload/)
on resource-based admission and criticality, and [Anthropic's agent eval guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
on isolated trials, executable graders and verified outcomes rather than transcript claims.
