- **The rotations come in TWO FORMS and every glob that names only one answers SILENTLY WRONG. The
  union is three patterns, never two:**
  `zgrep -h '<pat>' state/ledger.*.ndjson.gz state/ledger.*.ndjson state/ledger.ndjson | sort -u`.
  `zgrep` reads plain input transparently (MEASURED: 223 hits on an uncompressed rotation), so the
  fix is always THE GLOB, never the tool. Never assume either half is empty.
