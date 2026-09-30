# The openweight inbox-draft trial, measured (W1-T3570)

Measured 2026-09-30 from the fleet ledger union (`rmd ledger-grep inbox.dr`, deduplicated on
`ts + step + proposal_id`), grouped per proposal and per synthesizing model. The "bounded" trial had
by then been the whole inbox-draft lane for two weeks.

## terminal inbox-draft outcomes, cash `gpt-5-nano` (2026-09-16 .. 2026-09-30)

| measure | value |
|---|---|
| synthesis attempts | 3,311 |
| relints | 1,392 |
| draft errors | 1,719 |
| terminal drafts (`inbox.drafted`) | 200 |
| lint-clean terminal drafts (accepted) | 49 (25%) |
| lint-dirty terminal drafts | 151, of which 46 were YAML that failed to parse |
| proposals ever drafted clean | 48 of 199 (24%); the other 151 proposals were abandoned dirty |
| Azure cash receipts, total | $7.09 (about $0.0021 per synthesis) |
| typical request | about 8k input tokens, 4.3k output tokens (mostly reasoning) |

## Claude baseline and positive control

- **Claude baseline:** `claude/sonnet`, 2026-09-08 .. 09-15, 291 of 291 terminal drafts lint-clean (100%) over 409 syntheses. `claude/claude-opus-5`, 2026-09-01 .. 09-08, 298 of 298 clean. These were agentic subscription runs at about 38k output tokens and about $6 notional per synthesis. They were cash-free but not capacity-free.
- **Positive control:** the same `gpt-5-nano`, 2026-09-15 .. 09-16, while the prompt still embedded the whole plan (~100k input tokens), drafted 12 of 12 clean. The lint accepts nano output given that context, so the 25% is not a broken measurement. It is nano's structured-output reliability on the slim prompt W1-T3621 introduced.
- **Accepted drafts per dollar:** nano made about 6.9 clean drafts per cash dollar (49 / $7.09). It did so by spending 16.6 syntheses per terminal draft and abandoning three proposals in four.

## Recommendation: STOP

`gpt-5-nano` is not admitted as the inbox-draft lead. This shard's own stop condition fired: a model that keeps using up its relint attempts is a stop even when it is cheaper, and 76% of proposals never drafted clean.

The lead moved to cash `gpt-6-luna` (operator ruling 2026-09-30, #7963), and that move failed.
Measured 2026-09-30 03:18Z..10:03Z: 39 Luna syntheses gave 38 draft errors ("output carrying NEITHER marker — it
answered in prose instead of the fragment contract", ~269-character replies) and 1 clean draft. The
adapter forces tool-enabled Luna to `reasoning_effort: none`, which plausibly drops the fragment contract.
#8017 reverts the lead to nano as an interim, and a measured bake-off of nano, gpt-oss-120b, Luna without
tools and Sonnet 5.5 on real inbox prompts decides the next lead.

## Bake-off, 2026-09-30

The same 8 real proposals (adoption, followup, proof-debt, verify-human, ruling, feedback, skill-draft,
codeql-quality) went through the production `draftProposalBatch`: the real prompt, fragment parser, plan lint and
bounded relint loop. Only the answering model changed.

| candidate | drafted | lint-clean | contract errors | syntheses | cost | wall |
|---|---|---|---|---|---|---|
| subscription claude-sonnet-5-5 | 8/8 | **7/8** | 0 | 21 | $2.83 notional | 2.5 min |
| subscription claude-haiku-4-5 | 8/8 | 5/8 | 0 | 20 | $2.90 notional | 9.9 min |
| cash gpt-oss-120b | 8/8 | 3/8 | 0 | 24 | **$0.045** | 0.8 min |
| cash gpt-5-nano | 5/8 | 1/8 | 3 | 20 | $0.051 | 4.0 min |
| cash gpt-6-luna (tools) | 0/8 | 0/8 | 8 | 8 | $0.012 | 0.2 min |
| cash gpt-6-luna (no tools) | 0/8 | 0/8 | 8 | 9 | $0.002 | 0.2 min |

Luna fails the fragment contract with or without tools, so the reasoning_effort theory does not explain it.
Haiku costs more than Sonnet here (a longer agentic run) and cleans fewer drafts. Among cash lanes, gpt-oss-120b wins
on every axis: three times nano's clean drafts at lower cost, five times faster, and no contract errors. It now leads
the lane. Sonnet 5.5 is the quality ceiling at about 60 times the cost. Routing only the drafts
gpt-oss-120b leaves dirty to Sonnet 5.5 is the value play, filed as its own task.
