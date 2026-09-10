- **In a NEW `.ts` file, sandwich type-only `interface`/`type` declarations BETWEEN covered
  functions — never at the file's head or tail.** `--experimental-test-coverage` stamps `DA:<line>,0`
  across a new file's leading AND trailing source-line records (a source-map preamble/epilogue
  artifact), and diff-coverage flags an interface's property lines sitting there as uncovered code.
  Middle types, bracketed by executed statements, get no `DA:0`. *(#777 — head and tail both failed)*
