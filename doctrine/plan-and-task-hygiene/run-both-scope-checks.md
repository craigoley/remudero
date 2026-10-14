- **Before building a filed task, check `git ls-remote origin 'refs/rmd-dispatch/<id>' 'refs/heads/run-<id>-*'`
  (claimed or in flight?) and merged PRs for an exact `^Remudero-Task: <id>$` trailer (shipped?), never commit subjects.**
  A DISPATCH CLAIM PRECEDES THE BRANCH: the fleet takes `refs/rmd-dispatch/<id>` before any spend
  (`dispatchClaimRef`, `src/lib/dispatch-claim.ts`, W1-T1268 #2668), and that namespace is invisible
  to `git ls-remote --heads`, so a run that has claimed but not yet pushed reads as free to the
  heads-only check. A filed task is dispatched within minutes; hand-build it only when the fleet
  cannot (2026-09-22: a hand-built remudero-console #1634 duplicated the fleet's #1633 for CONSOLE-T38
  and was closed as a leftover). *(Claim ref folded into the headline 2026-10-11.)*

  *(Index line retired 2026-10-11: the W1-T3323 bullet below named its two commands only in its body. It is kept verbatim; its id resolves here through `doctrine/merged-rules.json`.)*

- **THE TWO SCOPE-TIME CHECKS, AS COMMANDS — RUN BOTH BEFORE BUILDING A FILED TASK.** a minted id is not evidence the work is unclaimed; these answer different questions:
  `git ls-remote --heads origin 'run-<id>-*'`   # is someone working on it RIGHT NOW
  `gh api "repos/<owner>/<repo>/pulls?state=closed&per_page=100" --jq '[.[]|select(.merged_at!=null)|select(.body//""|test("(?m)^Remudero-Task:[ \t]*<id>[ \t]*$"))|.number]'`   # has it ALREADY SHIPPED
  Anchor the trailer test exactly (`^Remudero-Task:\s*<id>\s*$`, multiline) — GitHub's search is NOT
  exact-phrase, and unioning COMMIT SUBJECTS over-credits: `chore(plan): file W1-T411` names a
  task the filing never implemented. Subjects also UNDER-credit in the SAME sweep, so a subject
  scan is wrong in both directions at once: W1-T2776 shipped as `fix(ci-parity): register the
  whole bash-3.2 cluster …`, citing no id, so only its FILING matched (2026-09-04). Add the
  head-ref query when the trailer scan reads zero.
