- **THE TWO SCOPE-TIME CHECKS, AS COMMANDS — RUN BOTH BEFORE BUILDING A FILED TASK.** a minted id is not evidence the work is unclaimed; these answer different questions:
  `git ls-remote --heads origin 'run-<id>-*'`   # is someone working on it RIGHT NOW
  `gh api "repos/<owner>/<repo>/pulls?state=closed&per_page=100" --jq '[.[]|select(.merged_at!=null)|select(.body//""|test("(?m)^Remudero-Task:[ \t]*<id>[ \t]*$"))|.number]'`   # has it ALREADY SHIPPED
  Anchor the trailer test exactly (`^Remudero-Task:\s*<id>\s*$`, multiline) — GitHub's search is NOT
  exact-phrase, and unioning COMMIT SUBJECTS over-credits: `chore(plan): file W1-T411` names a
  task the filing never implemented. Subjects also UNDER-credit in the SAME sweep, so a subject
  scan is wrong in both directions at once: W1-T2776 shipped as `fix(ci-parity): register the
  whole bash-3.2 cluster …`, citing no id, so only its FILING matched (2026-09-04). Add the
  head-ref query when the trailer scan reads zero.
