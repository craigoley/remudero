# Ratification note — W1-T9158 (scaffold, unratified)

Status: SCAFFOLD. This note mints no task id, and it carries no claim, proof, or `- id:` entry.
The index anchor it pairs with is the comment block above `- id: W1-T110` in `plan/tasks.yaml`.

## What the scaffold anchors

- MASTER-PLAN §7 (the control panel; heading at MASTER-PLAN.md ~L4908).
- P25 (the ratification inbox). MASTER-PLAN.md ~L3951 records P25 as closed, with shipped records
  W1-T110, W1-T111, and W1-T192 (~L1021 lists T192 as #457).

## Open question for the operator: the rationale does not match the title

The task's title is about §7/P25 follow-ups. Its rationale is a different item: a follow-up harvested
from W1-T3116 (run W1-T3116-1790492944985). That item concerns reading `src/lib/daemon.ts`'s existing
cadence and scheduling primitives, so a new daemon-lifetime controller reuses one scheduler. It is not
about P25 ratification.

The scaffold therefore does NOT assert that a P25 follow-up exists for this item. At ratification the
operator must choose one of:

1. Re-anchor to P25, and rewrite the rationale to name a P25 follow-up.
2. Keep the daemon-scheduling follow-up, and retitle the task to match it.

## Mapping to a real id on ratification

1. The operator reviews this note and chooses option 1 or 2 above.
2. Mint the next id from the max across BOTH sources, plus one:
   `grep -rhoE '^[[:space:]]*- id: W1-T[0-9]+' plan/tasks.yaml plan/tasks.d/ | grep -oE 'T[0-9]+' | sort -V | tail -1`
   (use `[[:space:]]`, not `\s`; a POSIX regex here can drop `\s` silently).
3. Land the real `- id:` entry in a plan-only PR. It carries its own claim and proof, which are
   Architect-only under Standing rule 15, so they must not ride a non-plan implementation PR.
4. In that same plan-only PR, remove the index anchor comment from `plan/tasks.yaml` and point this
   note's status at the minted id.
