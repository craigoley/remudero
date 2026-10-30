- **Before building a filed task, check `git ls-remote origin 'refs/rmd-dispatch/<id>' 'refs/heads/run-<id>-*'`
  (claimed?), merged PRs for an exact `^Remudero-Task: <id>$` trailer, never commit subjects, and
  `git log origin/main --since=<filing> -- <its files:>`: a `PR-<n>` hand fix leaves the task uncredited.**
  A DISPATCH CLAIM PRECEDES THE BRANCH: the fleet takes `refs/rmd-dispatch/<id>` before any spend
  (`dispatchClaimRef`, `src/lib/dispatch-claim.ts`, W1-T1268 #2668), and that namespace is invisible
  to `git ls-remote --heads`, so a run that has claimed but not yet pushed reads as free to the
  heads-only check. A filed task is dispatched within minutes; hand-build it only when the fleet
  cannot (2026-09-22: a hand-built remudero-console #1634 duplicated the fleet's #1633 for CONSOLE-T38
  and was closed as a leftover). *(Claim ref folded into the headline 2026-10-11.)*

  **A FIX CAN SHIP WITHOUT CREDITING THE TASK.** A hand PR fixes the symptom under its own trailer,
  `Remudero-Task: PR-<n>`, so the task's trailer scan still reads zero and the task looks unbuilt. Read
  `git log origin/main --since=<the filing commit's date> -- <the shard's files:>` too. A commit there that
  fixes the task's subject means the work shipped. The task then needs a test-only credit PR (or a reconcile),
  not a second build. Evidence: W1-T10025 was filed by #12589 (b061f0985, 10:10 -04:00 on 2026-10-17). The
  operator's hand PR #12595 (4a53aea3d, 10:57, trailer `PR-12595`) fixed `src/lib/preopen-gate.ts`. A session
  build began afterwards from the trailer scan, which read 0. It became #12601 (ba71f9809, 13:52), which says
  "The fix landed first" and adds only the shard's two tests. Replayed 2026-10-27: the files check over
  10:10-13:50 returns 4a53aea3d, and the trailer check over the same window returns 0.
  *(Extended 2026-10-27: the files check was added to the headline. Bytes were folded from five other
  headlines, each of whose bodies records the fold.)*

  *(Index line retired 2026-10-11: the W1-T3323 bullet below named its two commands only in its body. It is kept verbatim; its id resolves here through `doctrine/merged-rules.json`.)*

- **THE TWO SCOPE-TIME CHECKS, AS COMMANDS — RUN BOTH BEFORE BUILDING A FILED TASK.** a minted id is not evidence the work is unclaimed; these answer different questions:
  `git ls-remote --heads origin 'run-<id>-*'`   # is someone working on it RIGHT NOW
  `node scripts/task-shipped.mjs <id>`   # primary shipped check: exact trailers on local origin/main
  The script reads the full local history without a network request. It reports the origin/main SHA
  and commit age, the newest trailer as a positive control through the same matcher, matching commits,
  and subject-only mentions as information. Exit 4 means shipped, 0 means not shipped by trailer,
  and 3 means unmeasured (including missing origin/main or no trailer to establish the control).
  Check the reported SHA and age against the window you need: this command does not fetch, and a
  positive control does not prove that your local origin/main is current.
  A merged `run-<id>-*` head with no trailer is invisible in git log. The script prints a paginated
  head-ref query for that credit path; run it when a trailer zero must settle whether work shipped.
  While a broker is live, route that GitHub query through `rmd gh --`.
  The old `gh api "repos/<owner>/<repo>/pulls?state=closed&per_page=100"` command reads ONE page,
  only the newest 100 closed PRs, so its zero cannot establish absence. GitHub search is not the
  primary check either: the W1-T9619 search missed #11977, failing its positive control (W1-T9742).
  Anchor the trailer test exactly (`^Remudero-Task:[ \t]*<id>[ \t]*$`, multiline) — GitHub's search is NOT
  exact-phrase, and unioning COMMIT SUBJECTS over-credits: `chore(plan): file W1-T411` names a
  task the filing never implemented. Subjects also UNDER-credit in the SAME sweep, so a subject
  scan is wrong in both directions at once: W1-T2776 shipped as `fix(ci-parity): register the
  whole bash-3.2 cluster …`, citing no id, so only its FILING matched (2026-09-04). Add the
  head-ref query when the trailer scan reads zero.
