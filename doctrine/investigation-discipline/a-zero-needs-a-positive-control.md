- **A ZERO IS NOT A MEASUREMENT until a positive control proves the query saw its corpus — run one on
  every sweep you act on. It proves only that: name the question the query really
  answers, check the corpus's newest ts covers the window, and re-run a surprise in another ENVIRONMENT.**
  The four W1-T3323 bullets below are the measurements behind each clause, in order: the control
  itself, (d) the wrong question, (e) the wrong corpus or environment, (i) the uncovered window.
  The lettered items still in the index — (a), (b), (f)-(h) — are further traps of the same family;
  (c) and (j) now carry their instruction as headlines of their own.
  *(Headline folded 2026-10-27: "you will act on. A control proves only that" became "you act on. It proves only that"; the clauses are unchanged.)*

  *(Index line retired 2026-10-11: (k), the last bullet below, is this rule applied to a function
  call — `[]` from a dead call and from a real zero look alike, and its control is a deliberately
  violating row in the same call shape. Kept verbatim; its id resolves here.)*

  *(Index lines merged 2026-10-11: four headlines restated "a control proves visibility, not the right answer". They are kept verbatim; their ids resolve here through `doctrine/merged-rules.json`.)*

- **A ZERO IS NOT A MEASUREMENT UNTIL A POSITIVE CONTROL PROVES THE QUERY COULD SEE ITS CORPUS.
  RUN ONE ON EVERY SWEEP WHOSE ANSWER YOU INTEND TO ACT ON.**
  FOUR distinct instruments here answer WRONG rather than erroring; expect more — three were found by
  ACCIDENT in one week, by a falsifier that reddened nothing or a target visible in the file, never
  by reading the query. Enumerating hazards has lost that race twice; the control generalises — it
  tests the QUERY, not your memory of which tool is broken. A control costs one command: match something
  you can SEE, in the same corpus, with the same tool and flags. AND QUALIFY IT FOR THE SURFACE:
  an open PR's id reads zero on main, a merged id's deleted branch reads zero on heads, an unwritten
  id reads zero on `git log --grep`.
  **Two directions a control can be too weak: (c) — A CONTROL THAT PROVES THE CORPUS IS READABLE
  DOES NOT PROVE THE QUERY COVERS IT — and (a), where the control passes because you unwittingly ran
  a DIFFERENT engine than the sweep did.**
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
- **(e) A CONTROL PROVES THE QUERY CAN SEE ITS CORPUS; IT DOES NOT PROVE THE CORPUS IS THE RIGHT ONE
  — AND RE-RUNNING THE SAME WAY IS NOT A SECOND OPINION.** (a)-(d) are all ZEROS; THIS ONE IS A
  CONFIDENT NON-ZERO, which is why the section's own framing does not catch it. MEASURED 2026-08-13:
  `tsc` reported four `api-client` errors in a container; re-running on a CLEAN TREE got the IDENTICAL
  FOUR, read as pre-existing. **THAT CONTROLLED FOR THE TREE AND NOT FOR THE ENVIRONMENT** — a RELATIVE
  `node_modules` symlink resolved outside that container's mount set, and CI was green throughout.
  AN ENVIRONMENTAL DEFECT REPRODUCES EXACTLY, so agreement between two readings
  taken the same way is one measurement performed twice, and the confidence it buys is counterfeit.
  THE CHECK: when a result surprises you, RE-RUN IT SOMEWHERE ELSE before believing it — a second
  host, CI's own logs, or a differently-provisioned container. Vary the ENVIRONMENT, not just the
  input. CHEAPEST INSTANCE: `readlink -f <workspace-symlink>` prints EMPTY when the target sits
  outside the mount set, which would have settled it in seconds. *(2026-08-13)*
- **(i) A POSITIVE CONTROL PROVES THE QUERY CAN SEE ITS CORPUS; IT DOES NOT PROVE THE CORPUS COVERS THE
  WINDOW.** The (a)-(f) family above all catch a query that cannot read. This one reads perfectly and
  still answers about the wrong period: `"step":"risk_judge.decision"` read 87 rows across the union
  (gz 64 / plain 23 / live 0) — control fires — while `rate_limited_rest_merge` read 0 because the
  corpus's newest row is 2026-08-12 and the feature merged 2026-08-23. Before acting on a ledger
  zero, print the corpus's NEWEST ts beside the event's own date; a control says nothing about that
  gap. *(W1-T1280/#2651)*
- **(k) A RULE 21 protocol run passing `{ baseTask }` ALONE reports THREE INDISTINGUISHABLE ZEROS.**
  `postMergeAmendmentViolations` (`src/lib/review.ts`) returns `[]` at `!ctx.statusResolvable`, at
  `!ctx.merged`, and when the rule truly does not apply: a dead call and a real zero have the same
  return value. Pass `statusResolvable: true`, `merged: true` and `baseAcceptance`; only a
  deliberately violating row in the same call shape separates a real zero from a dead call. *(#3211)*
