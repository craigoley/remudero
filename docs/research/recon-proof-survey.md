# Recon: the proofs that may certify nothing — the name-filtered survey — 2026-08-06

Run at origin/main `deadef68c4727a2207319bd698bcc8265f136afd` (toplevel /home/user/remudero, branch
main; single `git -C` invocation). Report only; no code, no PRs, no plan edits; no proof was
rewritten. The ledger was NOT read for any figure here — every claim derives from the live plan,
the repo's own executors run in-process, and origin/main commit history; the brief's zgrep-union
idiom therefore had nothing to prove an archive against, and saying so beats faking a control.

## THE HEADLINE FINDING FIRST: the survey was overtaken by the fix, and the survey confirms the fix.

W1-T387 — the executor collapse this survey was meant to run AHEAD of — MERGED overnight
(`fix(review): collapse check-proof onto the reviewer's own executor (W1-T387)`, #1442). DERIVED,
live at this sha: `RMD_SELF_SYNC_DONE=1 ./bin/rmd check-proof 'unit test: fixHeadAcceptable'` now
prints `verdict: no-match` — the exact proof that read `exit 0 / hits 17` to its author yesterday
now tells the author what the reviewer will say. The false-green window is CLOSED in the shipped
tool. This survey is therefore W1-T387's design step (ii) run POST-hoc: the population census the
implementer was owed, delivered as verification instead of inheritance.

## The population, re-derived — it moved, in the right direction.

DERIVED via the repo's own parsers (`parseWhitelistedProof`, `resolveNameFilteredCandidates` from
src/lib/review.ts, over `loadPlan`'s 382 open tasks): 983 open-task proofs parse — 61 `grep:`,
605 pure-path `unit test:`, **317 name-filtered** (title-form) — plus 299 unparseable prose rows
(the dialect-debt class, coheres with the composition recon's ~300). Of the 317: **49 resolve to
files** (the divergence-risk class the brief calls "the 66") and **268 resolve to absent**, both
executors agreeing. The shard's 66/251 was measured at 946f281; between that sha and this one the
fleet's overnight sweep rewrote several relics' proofs to path-form (W1-T164's now name
test/operator-notes.test.ts explicitly) and withdrew others, so 17 proofs left the risk class
before anyone surveyed them. The population is SHRINKING without intervention.

## Q1 + Q2 — the three-way split, judged by the review executor itself.

Method: every one of the 49 resolved proofs run through `execWhitelistedProof` (the judge — its
`nameFilteredOutcome` reads the TAP stream, never the exit code), in-process, sequentially, at
this sha. Zero exec_errors; every run completed with its trailing summary.

- **exists-and-passes: 42 of 49.** The named test exists, matched as a real (non-wrapper) TAP
  result, and passed.
- **exists-but-fails-in-THIS-environment: 5 of 49** — every one in the Playwright suites
  (test/serve.density-ia.test.ts ×3 for W1-T183, test/serve.live-state.test.ts ×2 for W1-T200),
  each dying in ~1.3s after this container's proxy refused the pinned-Chromium download
  (cdn.playwright.dev 403 "host not permitted" — captured in the run log). The EXISTENCE half is
  proven (a real test title matched); the fail is the browser-launch environment, the known
  env-only class. ASSUMED on stated grounds, not proven from here: these pass where browsers
  install (CI, the daemon host).
- **does-not-exist: 2 of 49** — and both are the same previously-unnamed shape: QUOTATION
  ARTIFACTS. W1-T38's title-string occurs in test/proof-execution.test.ts only INSIDE A STRING
  LITERAL (a proof-parsing test quoting W1-T38's proof as fixture data); W1-T79's occurs in
  test/task-linter.test.ts only as example acceptance data in a linter fixture. The resolver
  greps SOURCE for the fixed string, so a proof quoted by another test resolves to that test's
  file while naming no registered test in it. This is `resolveNameFilteredCandidates`'s
  structural blind spot, distinct from the concatenation-seam trap already documented.

## Q3 — the two dead proofs sit on tasks that merged anyway, with the era stated honestly.

DERIVED: W1-T38 merged via "feat: cap the active learnings corpus with a CI ratchet (W1-T38)"
(#234); W1-T79 via "feat(run-task): auto ff-pull rmd's own checkout at CLI entry (W1-T79)"
(#662). Both are OPEN by yaml status yet carry implementing commits — gravestones. The sharp
phrasing the brief asked for, with its honest qualifier: **both merges were granted on evidence
that never ran as a test** — but ASSUMED-with-support, both predate the proof-execution era
(their PR numbers sit far before the W1-T183-lineage executor machinery), so the merges rode the
keyword floor lawfully under the rules of their day. Nobody was deceived by a green check-proof
at merge time; the deception window opened later, when CLAUDE.md began calling check-proof the
reviewer's own executor — and that window closed last night with #1442.

## The merged/open cut — the population that matters is EMPTY.

DERIVED, using the same classifier the new lint-plan headline prints (trailer or
implementing-subject citation on origin/main, filing-family subjects excluded): **all 22 distinct
tasks in the 49-proof resolved set are gravestones.** Zero belong to open-real work — no future
implementer will be judged against any of these. For completeness, the 268-absent set spans 123
distinct tasks: 112 gravestones, 11 open-real (W1-T2, T49, T68, T72, T113, T164, T165, T188,
T201, T234, T258) — and every one of those 11 passes today's linter (their short title-form
proofs parse cleanly, so `proof-resolvability`'s narrative heuristic never fires), which is why
lint's "6 with none" headline and this recon's 11 differ: five carry absent proofs without being
lint-failing at all. Under the collapsed check-proof those tasks' proofs now read `no-match`
locally, which is the honest state; before last night they read green.

The live headline at this sha, for the record (DERIVED):
`382 task(s) checked (open tasks only) — 170 open failing (164 with a merged implementation,
6 with none)` — down from 176/12 yesterday; the fleet acted on the split within hours of it
shipping.

## Is the class growing? — the age distribution.

DERIVED for the 22 resolved-set tasks: filed 2026-07-14 → 07-24 (20 strictly before the
dialect-convention package of 07-24/25; W1-T254 on the boundary day, W1-T264 on 07-31 as the lone
late entry). For the 11 open-real absent tasks: 07-14 → 07-25, nothing later. And the FULL
population, DERIVED over every task in the class: **135 distinct open tasks carry name-filtered
proofs; the latest filing date across all 135 is 2026-07-31, and exactly ONE task (W1-T264) was
filed after 2026-07-25.** The shape is settled: **this is a
bounded legacy pool. The intake is closed** — closed for authoring by the dialect package
(~07-24/25), and closed for false local verification by #1442 (last night). The one residual
intake gap worth naming: a SHORT title-form proof still passes the linter today (the narrative
heuristic keys on commas/length), so a new task CAN still file an absent name-filtered proof —
it will now be told `no-match` by its own check-proof, which is the correct failure mode, but it
is refusal-at-review rather than refusal-at-filing. That is W1-T384's territory (criteria repair
refused at filing), already filed; nothing new to file.

## Work this survey turns up — shape named, not filed, per the brief.

1. The QUOTATION-ARTIFACT blind spot: `resolveNameFilteredCandidates` counts a proof quoted as
   fixture data in another test as "resolved". Population today: exactly 2, both gravestones —
   cosmetic now, but the resolver's contract ("found the string" vs "found a registered test")
   is the same class of gap W1-T387 just closed one level up. Shape: a resolver-level exclusion
   for string-literal contexts, or a documented limitation; either is small.
2. Nothing else. The 42 passes need no action; the 5 browser fails are environment; the two dead
   proofs sit on pre-executor-era gravestones whose retirement is already governed by the
   W1-T370 attrition ruling.

## Plain language

Of the proofs that are supposed to show the work was done, almost all of the ones that point at
real test files actually check something: forty-two of forty-nine name a real test that runs and
passes today. Five more name real tests that only fail here because this machine cannot download
a browser. Exactly two name tests that do not exist — their words appear in the codebase only
because another test quotes them as an example, like a citation to a book that turns out to be a
review quoting the title. Both belong to work that shipped long ago under older, laxer rules, so
nothing currently depends on them. The tool that yesterday told authors "your proof looks fine"
when the referee would say "that test doesn't exist" was fixed last night, and this survey
confirms the fix catches exactly the case it was built for. Verdict: the scary-sounding class
mostly checks out, the two genuine duds are harmless relics, and the door they came through is
now closed twice over.
