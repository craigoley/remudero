# Golden-verdict corpus (W1-T423)

MASTER-PLAN's Self-improvement section: "Golden-task eval suite … including planted violations
(TDD skip, scope creep, test theater, provenance-free prompt) … Regressions in the harness's
judgment become red CI, not vibes. This is mutation-testing discipline applied to the
orchestrator." This directory is that suite's fixture corpus, driven by
`test/golden-verdicts.test.ts`.

## What a golden is

A golden pins **what the judgment must conclude**, in the judge's own vocabulary — never a
snapshot of incidental output. Each case directory holds:

- `diff.patch` — a real unified diff, in exactly the shape `judgeReview` parses (`diff --git
  a/x b/y`, `+++ b/x`, `+`/`-` body lines).
- `report.md` — the implement worker's REPORT text (where proofs are pasted / claims are made).
- `criteria.yaml` — the task's acceptance criteria (`claim`/`proof` pairs) — the "task row" and
  proof set `judgeReview` is handed.
- `declared-files.yaml` (optional) — `ReviewEvidence.taskDeclaredFiles`, when a case exercises
  the scope advisories.
- `checkout/` (optional) — a real directory `execWhitelistedProof` executes a dialect proof
  against for real (grep / node --test), when a case needs OBSERVED repo state rather than the
  keyword floor.
- `golden.yaml` — the REQUIRED verdict facts: the violation this case plants, the rule/task that
  makes its verdict the intended one, and the subset of `ReviewVerdict` fields the driver must
  see exactly.

The suite drives the REAL judges (`judgeReview`, the whitelisted proof executor,
`bodyContradictsDiff`, `criterionFieldTampered` via `judgeReview`'s own `criteriaTampered`) over
each case's real inputs — it never reimplements their logic. A regression in the judgment shows
up as a red assertion against a golden's own recorded facts, never as a hand-maintained parallel
implementation drifting from the gate it exists to lock.

## The first tranche

One case per documented judgment class, plus the control every catch-only suite is missing:

| case                  | class                                                                 |
| ---------------------- | ---------------------------------------------------------------------- |
| `test-theater/`         | tests injecting a tautology around the changed seam (Standing rule 13/14) |
| `scope-creep/`          | diff touching an undeclared file (W1-T401 advisory path)               |
| `provenance-free/`      | a report whose claims contradict its own changeset (#974 class)        |
| `tampered-criterion/`   | a diff that appends/edits its own task's `claim:`/`proof:` (W1-T400)   |
| `dead-proof/`           | a name-filtered proof matching no real test (W1-T387 no-match class)   |
| `healthy-control/`      | **must arm** — no violation planted; proves the suite rewards correct acceptance, not blanket refusal |

## Growth rule

**Every future judgment-changing PR adds or updates a golden naming what changed.** A PR that
touches `judgeReview`, `judgeCriterion`, `judgeRubric`, `bodyContradictsDiff`,
`criterionFieldTampered`, `detectTestTheater`, the whitelisted proof executor, or the scope/
provenance advisories, and does not touch this corpus, is expected to explain in its own body
why the judgment it changed has no golden that could have pinned it — the same "state the gap,
don't silently widen it" posture every other floor in this codebase holds itself to. Enforced
socially for now; a lint hook that greps the diff for `src/lib/review.ts` against a corpus touch
is explicit follow-on, once this corpus exists for it to point at (not yet filed).

This is enforced socially first, on purpose (design (v), W1-T423): the corpus needs to exist
before a lint rule has anything to check it against.
