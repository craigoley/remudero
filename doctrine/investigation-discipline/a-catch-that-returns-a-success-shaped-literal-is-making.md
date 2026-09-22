- **A `catch` that returns a success-shaped literal is making a CLAIM: name the outcomes it collapses, and
  where two remedies differ, the answer is a third value the caller can see — never a comment asserting the
  collapse is fine. Reasoning vocabulary (fail-soft, degrade, treat as, unknown) does NOT track correctness;
  `loadLearningsCorpus` returns `[]` with comment `// no corpus directory yet`, reasoning-vocabulary-perfect
  and defective alike. diff-coverage is the gate for NEW conflations, forcing tests per arm and thus naming
  outcomes; it catches none of the 145 already on main, which is filed as W1-T1074.**
  
  648 `catch` clauses measured in `src/` under `@babel/parser` AST walk, Sep 2026: 145 return
  success-shaped literals and 371 do not inspect the error. Hand-classified sample of 10 of the 145
  found five correct cases naming their outcomes (safeReadFailed, sameAsIncoming, defaultGetProcessStartTime,
  parseDraftAttemptCache, readDiskFreeBytes), two collapsing different remedies (dirSizeBytes, commitsAhead),
  and three undocumented (clearFlag, issues-intake list, ensureLabel). The cheap static discriminator
  — whether prose carries reasoning vocabulary — lands all five correct and only one of three defective;
  the two defective cases with reasoning comments read as reasoning-vocabulary-perfect (loadLearningsCorpus,
  clearFlag) and still wrong. Coverage is the gate that finds these: #2346 was blocked twice on added
  lines until promotionLedgerSink was extracted, turning an inline ternary into tested per-arm functions
  that forced naming the outcomes and exposed the collapse. That is the finding that decides this rule:
  testing and naming are coupled, and a comment cannot replace either. (W1-T1081, W1-T1074, #2346)
