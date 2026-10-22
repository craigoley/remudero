- **New test code imports repository modules through `#src/*`, `#scripts/*` and `#test/*`, never a
  location-relative specifier.** The existing W1-T9864 census in
  `test/a-test-imports-through-the-subpath-alias.test.ts` rejects a new test file containing a
  relative repository import and any increase in the number of such files. Test placement moves
  files across folders; the package's aliases preserve their imports across those moves. Use
  `#src/lib/clock.js`, `#scripts/lib/argv.mjs` and `#test/helpers/git-repo.js` for repository code;
  Node builtins and external packages keep their ordinary specifiers. PR #13559 reached hosted
  CI with a new nested test's relative imports and failed both census assertions. This records
  the existing gate in the worker's compact brief; it adds no allowance or migration scope.

Run `test/a-test-imports-through-the-subpath-alias.test.ts` alongside the new test before its first push. Its population checks measure the import convention independently of the scoped behavioral result.
