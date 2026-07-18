# Architecture Decision Records

MASTER-PLAN §5 TIER 3: **ADR discipline for IRREVERSIBLE calls.** A short
Architecture Decision Record accompanies a one-way-door change. Reversible,
PR-shaped changes stay where they already live —
[`DECISIONS.md`](../../DECISIONS.md) (auto-choose resolutions) or an ordinary
PR description — and do **not** need an ADR.

## Does this change need an ADR?

Ask: **if this turns out wrong, does reverting the PR fix it?**

- **Yes, a revert fixes it** → no ADR. This is the common case: a filename
  choice, a config value, a refactor, most `DECISION_REQUEST` resolutions.
  Record it in `DECISIONS.md` (if it went through the auto-choose flow) or
  just the PR description.
- **No — the cost of reverting is materially higher than the cost of the
  change itself** (a data migration, a dropped/renamed public contract, a
  security posture change, a dependency the whole codebase now assumes,
  anything the games' "purity gate" analogy would call irreversible) → write
  an ADR **in the same PR** as the change.

When unsure, write the ADR — it is cheap; a missing one for a real one-way
door is not.

## Filing one

1. Copy [`template.md`](template.md) to `NNNN-short-title.md`, where `NNNN` is
   the next zero-padded sequence number (check the highest existing file in
   this directory).
2. Fill in **Context**, **Decision**, and **Consequences**. Keep it short —
   an ADR records *why*, not a design doc.
3. Land it in the same PR as the change it documents. The PR review is the
   ADR review; there is no separate approval step.

## Status lifecycle

- **Proposed** — open for the PR's review, not yet merged.
- **Accepted** — merged; the default state once a PR lands.
- **Superseded by NNNN** — a later ADR replaced this decision; link forward
  to it. Never delete or silently rewrite an accepted ADR — supersede it, so
  the history of *why* stays intact.
