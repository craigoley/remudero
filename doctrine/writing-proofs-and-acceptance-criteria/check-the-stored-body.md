- **THE BLOCK MUST PARSE BEFORE ANY PROOF IN IT CAN RUN — check GITHUB'S STORED BODY with
  `rmd check-acceptance`, never your local file.** `parseAcceptanceBlock` (`src/lib/review.ts`)
  resolves criteria ONLY from BULLETS — `ACCEPTANCE_BULLET_RE` accepts `-`, `*`, `1.`/`1)` — so a
  bare unbulleted `claim:` line matches NOTHING and the review lands *"FAIL — no acceptance criteria
  to judge (fail closed)"* on a PR whose checks are ALL GREEN. #1721 shipped 8 pairs and measured
  `criteria parsed: 0` against 22/22 green checks. Four more ways to reach zero: a header that is not
  a BARE line (`ACCEPTANCE_HEADER_RE` — `## Validation` is not one); PROSE between the heading and
  the first bullet (#1714's first draft); a blank line ANYWHERE after the bullets begin (tolerated
  only BEFORE the first one); and ANY indented line that is not a fresh `proof:`, which is why a
  claim WRAPPED onto a second line silently truncates everything below it.
  **ONLY TWO SHAPES PARSE:** `- <claim> | <proof>` and `- claim: …` / indented `  proof: …`. Since
  #4082, `renderAcceptanceBlock` emits the second whenever either side has a `|`, and
  `acceptanceSeparator` resolves it by EVIDENCE — the first bare `|` only if executable, else each
  ` | ` right-to-left — so a claim's own `|` no longer truncates it. An EM DASH is still no
  separator: it reads as part of the CLAIM, so the bullet parses with NO proof, SILENTLY —
  `acceptanceAuthorTimeCheck` refuses `empty-proofs`, reddening `acceptance-author-gate`;
  #2534/#2535/#2555 each shipped one. Convert every ` — proof: ` to ` | `. *(2026-08-23, #4082)*
  **AFTER A PIPE, WRITE THE BARE PROOF** — `| proof:` doubles the label, the proof becomes
  `proof: grep: …`, and `check-proof` refuses it (`parse: REFUSED`, exit 2); that capped #1598 at
  0/3. (The two-line `claim:`/`proof:` form is still BULLETED — its first line is a `-`.)
  **RUN BOTH VERBS — NEITHER CATCHES THE OTHER'S FAILURE:** that doubled-label body passes
  `check-acceptance` `OK`/exit 0; an unbulleted body fails it while every proof inside is valid.
  `gh api repos/<o>/<r>/pulls/<n> --jq .body > /tmp/b.md && RMD_SELF_SYNC_DONE=1 ./bin/rmd check-acceptance /tmp/b.md`
  **GUARD THE FETCH ON STRUCTURE, NEVER ON SIZE**: reject a non-200 or a missing/null `.body` before
  judging — a rate-limit payload reads as `DEFECTIVE: no Acceptance header`. A size floor cannot
  tell a short body from an error payload; the key can. *(2026-08-14)*
  **A BODY REPAIR IS A NEW REVIEW INPUT.** Review retries, refusals, pending posts and outcome
  dedup all key on the versioned digest of the PR head plus exact body. A body edit therefore
  re-earns review on the same commit; comments, labels and title churn do not. Unchanged input
  remains bounded by the configured cap/backoff. *(#1598, #1714, #1721; 2026-09-01 correction)*
