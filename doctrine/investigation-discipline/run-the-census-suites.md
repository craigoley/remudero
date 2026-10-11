- **Beside the `git grep -l <symbol>` caller sweep, run the census suites your diff joins
  (`rmd census-membership`) — they WALK a population and name none of your symbols.**
  *(Index line retired 2026-10-11: the W1-T3323 bullet below pointed at a caller sweep "above" that no longer sits above it, and gave its instruction only in its body. It is kept verbatim; its id resolves here through `doctrine/merged-rules.json`.)*

- **(j) A CENSUS TEST NAMES NONE OF YOUR SYMBOLS, SO THE CALLER SWEEP ABOVE CANNOT FIND IT** — `git grep
  -l <symbol>` is blind to a suite that WALKS a population (`src/**`) and asserts its size. #2639
  added one seamed policy read and reddened `test/config-reader-seams.test.ts`, a file outside its
  `files:` that references nothing it touched. Also run any suite that enumerates a population your
  file joins, found by what it walks rather than by name. *(#2639, #2605)*
