- **Verify a `grep:` proof with the executor's REAL invocation — `grep -arn -- '<pattern>' <path>` —
  never with `grep -F`.** The executor passes no `-F`, so the pattern is a BASIC REGEX and a
  glob-looking one is silently wrong: `learnings/*.yaml` matches nothing. That is not a soft cap —
  `executed_fail` OVERRIDES keyword coverage and FAILS the PR. Also require the pattern to MISS the
  merge-base: one matching both sides degrades to `executed_stale` (W1-T273), discriminating
  nothing — **and W1-T362 extended that to `unit test:` proofs, so DISCRIMINATION, not execution,
  is the bar for every dialect.** `classifyBaseProofOutcome` (`src/lib/review.ts`)
  decides it by RE-RUNNING the proof against the merge-base: passing there IS stale. So a pure-path
  `unit test:` proof discriminates ONLY where its file is ABSENT or FAILING at base — the
  forward-referencing TDD case. **A task REPAIRING an existing test can never prove itself that
  way**: its file passes at base by construction, so every criterion silently degrades to the
  keyword floor. Prove a repair with a `grep:` on the changed line. Run a control pattern that must
  NOT match: `grep -r` with no file operand searches the cwd, not stdin, and fakes a match for
  anything. *(#1120; #3943 — four repair criteria went stale)*
