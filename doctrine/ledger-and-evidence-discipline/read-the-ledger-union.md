- **Grep the ledger with `rmd ledger-grep <pat>`; by hand, `zgrep` THREE globs —
  `state/ledger.*.ndjson.gz state/ledger.*.ndjson state/ledger.ndjson` — with a file count PER
  FORM as the control, and never delete an archive.**
  `rmd ledger-grep` (`resolveLedgerUnion`, `src/lib/ledger-union.ts`) reads both rotation forms
  (`ledgerRotationEntries`: `.ndjson.gz` and plain `.ndjson`) plus the live file, deduplicates, and
  exits non-zero when it read ZERO archives instead of answering from the live file alone.

  *(Headline folded 2026-10-27: its closing reason "each holds history no other file has" moved here; the instruction to never delete an archive is unchanged.)*

  *(Index lines merged 2026-10-11: the three W1-T3323 bullets below stated this instruction across three headlines, the first ending on a colon with its globs in the body. They are kept verbatim; their ids resolve here through `doctrine/merged-rules.json`.)*

- **The rotations come in TWO FORMS and every glob that names only one answers SILENTLY WRONG. The
  union is three patterns, never two:**
  `zgrep -h '<pat>' state/ledger.*.ndjson.gz state/ledger.*.ndjson state/ledger.ndjson | sort -u`.
  `zgrep` reads plain input transparently (MEASURED: 223 hits on an uncompressed rotation), so the
  fix is always THE GLOB, never the tool. Never assume either half is empty.
- **THE CONTROL MUST PROVE EACH FORM WAS READ, and a raw cross-archive count CANNOT** — rotations
  duplicate heavily, so `run.start` reads **257,438 raw lines across the `.gz` alone but only 779
  distinct over the full union**: a control like that stays six figures while a whole form is
  missed, which is exactly how this survived. Control by FILE COUNT PER FORM (`ls` each pattern,
  require every non-empty form to be non-zero), or by a per-form match count.
- **And the archives are NOT cumulative snapshots.** `rotateLedger` keeps only
  `MAX_RETAINED_LINES_PER_STEP = 200` newest per step and archives the rest, so most history exists
  ONLY in older archives — deleting any destroys unique data and the newest subsumes nothing.
  Claims of the form "N occurrences", and especially "zero in the entire history", are unsupportable
  without every form. *(recon-AE §0 — the `.gz`-only idiom returned a silent **0** for a pattern with 3
  real hits, its control passing at 257k throughout)*
