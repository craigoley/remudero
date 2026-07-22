CI green-merge gate verified via proto-runner — CI-GREEN-PROBE-1784029382823

## Coverage measurement re-based under `--enable-source-maps` (2026-07-22, W1-T210 round 2)

The coverage run (`ci.yml`, coverage-ratchet job) now passes `--enable-source-maps`, so V8
coverage positions translate to real `.ts` source lines instead of tsx-compiled output
positions. Two consequences, both deliberate:

- **`scripts/coverage-baseline.json` was re-captured** under the new instrument (lines 89.64 →
  82.75, branches 87.61 → 88.55 — set just under the CI/local measurement pair, 83.31/82.83 and
  88.65/88.61, so a cross-environment delta never reads as a regression). This is a re-basing, not a regression: the same suite on the
  same tree, measured against correctly-mapped lines — the old lines figure was over-counted by
  mis-attribution. The never-lower-to-pass rule still stands against the NEW numbers.
- **`scripts/diff-coverage.mjs` recognises non-executable added lines from the diff text**
  (blank / `//` / block-comment furniture) rather than from DA-record absence: under the flag,
  the compiled module preamble maps `DA:<line>,0` records onto a new file's leading doc
  comment, which used to false-block any new file that opens with one. A genuinely uncovered
  added *code* line still blocks (fixture-proven in `test/diff-coverage.test.ts`).
