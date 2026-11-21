REPORT
- Every active ci-learning entry in learnings/ci.yaml whose signatures lacked its own check name now carries it as an
  error signature, so a fix round failing that check selects the lesson. Existing signatures are kept and no fact text
  changed; test/learning/every-ci-lesson-is-selected-for-its-own-check.test.ts selects all of them.
