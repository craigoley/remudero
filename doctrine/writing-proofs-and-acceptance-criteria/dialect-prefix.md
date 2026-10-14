- **EVERY proof needs a dialect prefix — `unit test:` or `grep:`. A bare title is PROSE and never
  executes.** `rmd check-proof` refuses it in as many words: *"a proof with no dialect prefix at all
  is prose and never executes."* It does not fail loudly; it silently contributes nothing and the
  verdict lands CAPPED at `proof_exec: 0/N`, which will not arm auto-merge. #1194 posted 0/3 that
  way, and **#1189 MERGED at 2/4** — only its two `grep:` proofs ever ran, and nothing said so.
  Write `unit test: <exact-title substring>`: the prefix is required; `test/foo.test.ts::title`
  feeds the whole string to `--test-name-pattern`. In a **plan shard** use ONLY the pure-path form
  `unit test: test/foo.test.ts`: `judgeCriterion`'s `not_yet_built` carve-out has four conditions not two
  (`kind === "test"`, `!nameFiltered`, path in flow-style single-line `files: [...]`, and the file
  does NOT exist). The `existsSync` case is the silent bite: an existing test file runs, passes at
  head and base, then grades stale. On a plan-only head, only unit test reaches forward; `grep:` can
  prove only code already at that head or the shard text itself. `rmd check-proof '<proof>'` — the second of the two verbs the bullet
  above requires — is the reviewer's own parser AND executor (W1-T387: it judges the run through
  `execWhitelistedProof` itself, not a second hand-rolled exit-code check). Read its `verdict:`
  line, never the raw `exit:` — that same zero-match case exits 0 with `hits: 17` (MEASURED) while
  `verdict:` reads `no-match`; `--help` states the full mapping. *(#766, #773, #777, #1189, #1194)*
