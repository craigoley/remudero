The knowledge gardener (W1-T4095) tended the knowledge base. Every change is reversible: nothing is deleted, and a superseded learning keeps its text and stops being injected.

- **retire** `claims-gate-lane`: Workers offered it have rarely used it, compared with other learnings.
- **retire** `criteria-go-stale-on-relocation`: Workers offered it have rarely used it, compared with other learnings.

## Acceptance
- claim: this pass is recorded in the garden log
  proof: grep: ^## Pass 2026-10-16T20:50:36.321Z$ in docs/knowledge-garden-log.md
- claim: the gardener's retire of claims-gate-lane is marked in its entry
  proof: grep: knowledge gardener: retire claims-gate-lane$ in learnings/ci.yaml
- claim: the gardener's retire of criteria-go-stale-on-relocation is marked in its entry
  proof: grep: knowledge gardener: retire criteria-go-stale-on-relocation$ in learnings/failures.yaml
