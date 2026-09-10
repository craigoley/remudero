- **Before trusting `diff-coverage: OK`, prove the lcov INSTRUMENTS the changed files —
  `grep -c '^SF:<path>$' <lcov>` must be non-zero for every source file in the diff.** A scoped run
  whose suites never import a changed file emits no records for it, so "every added source line lcov
  instruments is covered" is trivially true over an EMPTY SET. This is the vacuous-pass family, not
  a coverage result. *(#1399 — an `OK` with zero `SF:` records for either changed file while CI's
  coverage-ratchet failed on 10 uncovered lines)*
