- **(b) THE `grep` IN THIS HARNESS IS A ugrep WRAPPER WITH `-I` (ignore-binary) INJECTED, so a file
  holding ONE NUL byte is skipped entirely — no output, exit 1, indistinguishable from real
  absence.** **The tool is still blind**, so any UNTRACKED file reads as absent, and **BARE `rg` IS BLIND TOO**
  (`rg -l` empty, `rg -la` fine) — "use grep -a or rg" is NOT the rule. `/usr/bin/grep` is
  unaffected, which is why it hid for months. Use `grep -ar`, `rg -la` or `git grep` for ANY sweep
  deciding a `files:` list, a violation count or a scope audit. Never carry a count; run
  `git ls-files -z | xargs -0 perl -0777 -ne 'print "$ARGV\n" if /\0/'`. `git grep --cached -I -l ''`
  is NOT a substitute — git sniffs only the first 8000 bytes. *(2026-08-11; folded 2026-08-16)*
