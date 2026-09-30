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

The lead moves to cash `gpt-6-luna` (operator ruling 2026-09-30, #7963), with nano and `gpt-oss-120b` behind it. The slim prompt removed the context ceiling that had put nano first. Re-measure Luna's clean rate over its first 20 terminal drafts with this same query before calling the lane settled.
