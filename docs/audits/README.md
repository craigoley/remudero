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

## Invocation — `rmd audit` (W1-T2924)

`rmd audit --fixture <path> [--repo <target>]` is the rung's one consumer, and this document's
own bar below is what it grades against. It runs a fixed, deterministic set of GATHERERS
(`src/lib/audit.ts`'s `AUDIT_GATHERERS` — file sizes vs `scripts/source-size-baseline.json`,
`execFileSync` sites with no nearby `timeout`, direct `gh` spawns, `Date.now()` sites,
`process.env` reads, `readFileSync(src)` in tests, the `stryker.conf.json` mutation ratchet's
module scope, `continue-on-error` security-scanner workflows absent from `ci-gate.yml`, tsconfig
`noUncheckedIndexedAccess`, dangling doc-to-source citations, and existing baseline/ratchet script
pairs) over `--repo`'s source (default: this checkout, never the fixture's own commit) — **no LLM
call**, so the rate below is a measurement, not a judgement.

**The grading rule.** `--fixture` names one of the `recon-YYYY-MM-DD.md` files below. Its own
`| R-n | … | Evidence |` table is parsed, and each row's Evidence cell is split on `;` into
citations. A fixture finding is **REPRODUCED** when ANY one of its citations names a file some
gatherer also flagged — and, when that citation carries a backtick-quoted symbol
(`` `daemon.boot` ``), only when a flagging on that same file also carries that symbol. One
matching citation is enough: a finding with several evidence citations does not need all of them
to still land, which is why a citation into a still-oversized "god file" keeps a finding
reproducing long after its own narrower defect was fixed elsewhere.

`rmd audit` prints `reproduced: N/M` plus the unreproduced ids, and — same posture as
`proof-queue-audit`/`plan-reconcile` — **is a report, never a gate**: a well-formed invocation
always exits 0, no matter how low the reproduction rate; only a malformed one (bad flag,
unreadable `--fixture`) exits non-zero.

**What it cannot see yet.** `depcruise`'s cycle count and `jscpd`'s clone count are named in this
rung's design but not yet gathered — both need a subprocess this deterministic, offline gather
deliberately avoids for now — so a fixture finding whose only evidence is a bare cycle/clone count
with no cited file will not reproduce through this path. Extending `AUDIT_GATHERERS` with either
is additive: no change to the grading rule above.

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

## `recon-2026-09-05.md` — fixture #2

A second fresh-eyes pass, this time with the codebase at ~170k source lines and ~1,080 task
shards: 59 findings across nine pillars (the ninth, "Generality & console-first", grades the tree
against the harness's own stated goal — any repository, every operator interaction through the
console). Eight parallel sweeps; every top finding re-verified at `file:line` or by re-running the
sweep's reproduction script. Backlog read only after the findings were frozen: 14 of 59 at least
partially tracked, 45 novel, clustering in the assurance plane's own executor, per-tick cost,
structure and test-suite economics.

Unlike fixture #1 it landed with its own doc-class corrections in the same PR (its §9 lists them),
so the doc drift it reports (R-46, R-47, R-52, R-53, R-56) was already repaired at the fixture's
own commit. Everything else it reports was still open at that commit.

### Known corrections to this fixture

None yet. Record them here, never in the file.
