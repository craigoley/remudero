REPORT
- Every active ci-learning entry in learnings/ci.yaml now carries its own check name as an error signature, so a fix
  round failing that check selects the lesson; existing signatures are kept and no fact text changed.
- unit test: test/learning/every-ci-lesson-is-selected-for-its-own-check.test.ts passes, one generated test per entry.
