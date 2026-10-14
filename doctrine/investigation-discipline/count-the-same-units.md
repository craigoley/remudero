- **(f) THE TWO SIDES OF A COMPARISON MUST COUNT THE SAME UNITS — `ls` COUNTS A DIRECTORY AS ONE
  ENTRY.** A naive `git ls-tree` vs `ls` tally read 114 vs 111 on an equal tree, because the tree
  side listed files recursively while `ls` collapsed each directory to one row. And ls-tree
  pathspecs do not glob like the shell: `git ls-tree HEAD -- '*.md'` returns ZERO at a root that
  holds ten `.md` files — a query-shape zero the mismatch then "confirms". The check: filter BOTH
  sides to the same unit first — `diff <(git ls-tree --name-only HEAD | grep '\.md$' | sort)
  <(ls -1 *.md | sort)` — and demand a positive control on whichever side reads zero.
  AND WHEN TWO NUMBERS DISAGREE, SUSPECT THE CAPTURE BEFORE THE TOOL. A `lint-plan` violation count
  that disagreed with its own summary traced to workstream subtotals summing correctly (the control)
  and a retry reading 0 traced to `cmd 2>&1 > f`, which sends stderr to the TERMINAL while this verb
  puts violations on stderr and the summary on stdout. Use `> out 2> err`.
  *(2026-08-14, both directions; the capture half 2026-08-15)*
