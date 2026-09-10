- **(d) A QUERY CAN ANSWER THE WRONG QUESTION WITH A PERFECTLY GOOD ZERO, AND NO POSITIVE CONTROL
  SAVES YOU.** `git ls-remote --heads origin 'run-<id>-*'` reports live worker branches. GitHub
  DELETES the head on merge, so it returns 0 for every COMPLETED task — MEASURED:
  `run-W1-T444-1786560477` existed 19:01:20Z–19:25:15Z and the query reads 0 today, identical to a
  task nobody ever started. A session read that zero as "not done", rebuilt W1-T444, and discarded a
  full build when it found the work already merged as #1657. THIS IS THE CLAUSE THAT BREAKS THE
  PATTERN: (a) is the wrong engine and (c) is incomplete coverage, both of which a control catches —
  here the tool works, the corpus is right, and a control PASSES (an in-flight task really does
  return 1). The defect is that "is anyone working on this" was read as "has this been done". When a
  zero decides something, name the question the query actually answers, and find the OTHER query for
  the other question — both are under "Plan and task hygiene" above. *(2026-08-12)*
