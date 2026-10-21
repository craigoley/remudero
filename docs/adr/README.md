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

## Index

| ADR | Decision |
| --- | --- |
| [0001](0001-typescript-7-native-compiler.md) | Use TypeScript 7's native compiler as the project compiler |
| [0002](0002-node-version-pin.md) | Pin Node to an exact version, everywhere, no floating tags |
| [0003](0003-acr-container-deployment.md) | Build and run the daemon as an ACR-built container image |
| [0004](0004-ci-gate-and-remudero-review-merge-gate.md) | `ci-gate` + `remudero-review` are the only required merge gate |
| [0005](0005-apache-2.0-never-relicense.md) | Apache-2.0, and the core is never relicensed |
| [0006](0006-precompiled-daemon-child-entries.md) | Run daemon children from a precompiled, source-keyed bundle, not tsx |
| [0007](0007-build-runs-outlive-the-daemon.md) | Run each build in a child process that outlives the daemon; restart the daemon only for its own code |
| [0008](0008-the-daemon-main-runs-from-the-bundle.md) | Start the daemon's own main from the precompiled bundle, keeping source maps on through a linked map |
