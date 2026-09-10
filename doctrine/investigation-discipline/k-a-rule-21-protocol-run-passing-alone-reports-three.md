- **(k) A RULE 21 protocol run passing `{ baseTask }` ALONE reports THREE INDISTINGUISHABLE ZEROS.**
  `postMergeAmendmentViolations` (`src/lib/review.ts`) returns `[]` at `!ctx.statusResolvable`, at
  `!ctx.merged`, and when the rule truly does not apply: a dead call and a real zero have the same
  return value. Pass `statusResolvable: true`, `merged: true` and `baseAcceptance`; only a
  deliberately violating row in the same call shape separates a real zero from a dead call. *(#3211)*
