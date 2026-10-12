- **Before calling a git fixture flaky, rerun it with `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null`
  — CI has no git identity; set one IN THE FIXTURE, never skip it.**
  *(Index line retired 2026-10-11: the W1-T3323 bullet below stated the symptom, not the reproduction and the fix. It is kept verbatim; its id resolves here through `doctrine/merged-rules.json`.)*

- **A fixture shelling git PLUMBING fails on every CI runner and passes on every dev machine, so it
  reads as flaky when it is deterministic.** `commit-tree` refuses `Author identity unknown` unless
  an identity is set, and `actions/checkout` sets NEITHER repo nor global: the fault is ambient
  config the fixture inherited locally. Reproduce before believing "flaky" —
  `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null` plus unsetting the repo's
  `user.email`/`user.name` reproduces CI exactly. Fix the FIXTURE (pass the identity env vars git
  honours), never the workflow, never a skip. *(#1971, after #1964's retry failed the same way)*
