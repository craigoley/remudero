- **Read GitHub through `rmd gh -- <gh args>` while a broker is live (the hook says so), never poll;
  the 180 s floor applies only with no live broker; `gh pr create` may die, git push won't.**
  *(Index line retired 2026-10-11: the W1-T3323 bullet below ended on a colon, with the enforced window in its body. It is kept verbatim; its id resolves here through `doctrine/merged-rules.json`.)*
  *(Index line merged 2026-10-17: the LAST W1-T3323 bullet below is carried by this headline's `gh pr create` clause. It is kept verbatim; its id resolves here through `doctrine/merged-rules.json`.)*
  *(Headline rewritten 2026-10-20: the Mac read broker went live with W1-T10279 (#13204). `hooks/deny-floor.sh` rule 10 now refuses a raw read-shaped `gh` call with "Re-run the read as: rmd gh --class interactive -- <same gh args>", and `rmd gh` is not floored: the broker caches, coalesces and paces from GitHub's own signals (an AIMD gap, `retry-after`, a 60 s exponential hold after a secondary refusal). With no live broker, rule 10 falls back to the 180 s floor. Measured on this Mac account (user ID 4397075): every real limit hit read "API rate limit exceeded for user ID 4397075", 36 of them between 2026-09-04 and 2026-09-30 and none since, and at each one `rate_limit` read core and graphql 5000/5000 with used 0, so it was a per-user throttle that no quota reading predicts. The old headline was "Space `gh` reads 180 s apart, never poll — `deny-floor.sh` refuses a closer read; GitHub's SECONDARY limit 403s on RATE while `rate_limit` reads full"; its id resolves here through `doctrine/merged-rules.json`, and the bullets below keep its evidence verbatim.)*

- **CADENCE IS THE BUDGET, NOT INTENT — a sparse check-in is fine, a poll is not. NOW ENFORCED:**
  `hooks/deny-floor.sh` rule 9 refuses a read-shaped `gh` call inside 180s of the last; writes and
  `gh api rate_limit` are exempt, and a deliberate burst is `RMD_GH_COOLDOWN_S=0` INLINE IN THE
  COMMAND (a hook is spawned by the harness, so an env-only override reaches nothing). The limit
  that bites is the SECONDARY one, counting RATE NOT VOLUME — it 403s while rate_limit reads
  5000/5000, so a quota check cannot predict it. *(80-call lockout 2026-08-20; a later session
  tripped it twice with no loop at all; enforced by W1-T3275 2026-09-09)*

- **`gh pr create` may die on API quota; git push is unaffected.** Open PRs via REST:
  `gh api --method POST repos/<owner>/<repo>/pulls -f title=… -f head=… -f base=main -F body=@<file>`.
  Same unpredictability as the bullet above: one PR POST succeeded at remaining 0 and the next GET
  403'd. Attempt it and handle one refusal; never gate work on a budget reading. `rmd review` and
  `gh pr view --json` still need GraphQL. *(#766; corrected 2026-09-07)*
