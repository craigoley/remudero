- **A new `.ts` file's `DA:<line>,0` on a doc comment or `interface` body is EXEMPT — never reorder
  a file to dodge it.** `--experimental-test-coverage` really does stamp those records across a new
  file's leading and trailing source lines (a source-map preamble/epilogue artifact), so a raw lcov
  read shows an interface's property lines as uncovered. **`diff-coverage` does not count them.**
  `isNonExecutableLine` carves out blank lines, `//` lines and block-comment furniture, saying why in
  its own doc — *"a new file's leading comment block gets `DA:<line>,0` records too, so the gate would
  false-block every file that opens with a doc comment"* — and `computeTypeOnlyRanges` (W1-T171)
  carves out every `interface`/object-`type` member line by brace context, because *"its body compiles
  to ZERO runtime JS, so every member line still gets a `DA:<line>,0` record no test can ever turn
  positive"*. MEASURED 2026-09-11 on `src/lib/ledger-compaction-rung.ts`, whose interfaces sit at the
  file HEAD: all five member lines read `DA:…,0` in the lcov AND return `typeOnly=true` from the live
  function, so the gate exempts every one. THIS RULE USED TO SAY THE OPPOSITE — sandwich type-only
  declarations between covered functions, citing #777 — which was true before W1-T171 and is now
  stale in the direction that costs work: obeying it means reordering a new file for a verdict the
  gate never renders, and it cost exactly one reverted reordering. WHAT STILL BITES: a real uncovered
  STATEMENT hides among these exempt records, so classify before concluding — slice the file's own
  `SF:`→`end_of_record` block, then separate comment and type-body lines from code.
  *(#777, W1-T171; corrected 2026-09-11)*
