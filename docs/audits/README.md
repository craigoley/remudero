# Audit fixtures

Golden inputs for the `rmd audit` rung (MASTER-PLAN §6 process proposals, P36).

## Why these files are byte-identical copies

Each `recon-YYYY-MM-DD.md` here is a verbatim copy of an audit pass, stored **unedited**. They are
fixtures, not documentation: the audit rung's own acceptance test is that a scoped re-run
*reproduces* the findings in one of these files from source. Editing a fixture — even to fix a typo
or correct a stale `file:line` — silently changes the target the rung is measured against, so
corrections belong in the task that acts on a finding, never in the fixture.

Read them as **a snapshot of what was true on their date**, not as current state. Several findings
in the 2026-07-21 pass were fixed within hours of it being written.

## `recon-2026-07-21.md` — fixture #1

An external fresh-eyes production-readiness review: 36 findings across 8 pillars, every one labelled
OBSERVED or INFERRED, with the backlog read only *after* findings were frozen so the tracked ratio
measures real blind spots rather than confirmation.

It is fixture #1 for two rungs:

- **the audit rung (T2 monthly)** — first acceptance test: reproduces >= 80% of these 36 findings
  from source
- **the intake rung** — the manual pass that turned this document into filed tasks, amendments,
  doctrine and a process proposal is the worked example the automated intake is measured against.
  Its required output contract is this document's own Top-10 schema: a finding table with
  severity/effort/tracked columns, and recommendations carrying falsifier-shaped acceptance criteria.

### Known corrections to this fixture

Recorded here rather than in the file, because the fixture stays byte-identical. Each was found by
spot-verifying evidence at `file:line` before filing the corresponding task — the distrust-the-report
discipline the intake rung inherits.

- **R-1** — the audit reports the escalation dedup as an "in-memory Set" that resets across restarts.
  It is in fact already ledger-derived and cross-boot (`dispatch.circuit_broken.escalated`). The real
  defect was ordering: the marker was written only *after* a successful `gh` call, so a throwing call
  recorded nothing and every boot retried. Fixed in #472.
- **R-1 liveness** — the loop had already stopped when intake began. Last boot 06:03:57, four hours
  before. It landed as a latent CRIT, not a live incident.
- **R-35** — the audit implies a stale lock blocks work. `acquireInflightLock` already steals a
  dead holder's lock, so it never blocked dispatch. The harm is operator legibility only: a
  circuit-broken task is never re-dispatched, so nothing ever clears its lock. Fixed in #477.
