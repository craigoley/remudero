- **A new test goes in the `test/<folder>/` that `rmd test-place` computes from its imports — never directly
  under `test/`.** A test's folder is COMPUTED, not chosen: `placeTest` (`src/lib/test-placement.ts`,
  W1-T9874) scores the src modules a test reaches against `scripts/test-placement/subsystem-map.json` and returns
  one of its folders (`ci/gates`-style second levels included). W1-T9875 made every NEW-test minter use it, because
  a minter that keeps writing flat `test/<slug>.test.ts` drags the layout straight back: the inbox drafting rule
  and `draftMissingPathViolations` (`src/lib/inbox.ts`), the hot-file, ci-friction, flow, flow-remedy, scout and
  selector-shadow gardeners (each through `newTestPath` in `src/lib/plan.ts`), and `plan.ts`'s scout and
  selector-shadow shape recognisers. A draft whose new test sits directly under `test/`, or in a folder the map
  does not name, is refused `draft-test-unplaced` (block); a minter whose placement has no signal falls back to the
  folder of the module its finding is about, never to flat `test/`. An existing test keeps its path, and a proof
  cites a moved test by its unique basename (`sameTestFile`, W1-T9862), so moving one strands no proof.
  To place a test you are writing, run `rmd test-place test/<your-test>.test.ts` and create it in the folder it
  prints. *(W1-T9875, plan letter E part 2; the operator's test/ restructure rulings of 2026-10-16)*

- **New test code imports repository modules through `#src/*`, `#scripts/*` and `#test/*`, never a
  location-relative specifier.** The existing W1-T9864 census in
  `test/a-test-imports-through-the-subpath-alias.test.ts` rejects a new test file containing a
  relative repository import and any increase in the number of such files. Test placement moves
  files across folders; the package's aliases preserve their imports across those moves. Use
  `#src/lib/clock.js`, `#scripts/lib/argv.mjs` and `#test/helpers/git-repo.js` for repository code;
  Node builtins and external packages keep their ordinary specifiers. PR #13559 reached hosted
  CI with a new nested test's relative imports and failed both census assertions. This records
  the existing gate in the worker's compact brief; it adds no allowance or migration scope.

- **New tests compute the repository root with `REPO_ROOT` or `repoRoot()` from
  `#test/helpers/repo-root.js`, never from their own location.** The existing W1-T9863 census in
  `test/every-test-finds-the-repo-root-through-one-helper.test.ts` rejects a new own-folder root
  and net growth of that population. A correctly placed nested test has a different depth;
  `new URL("..", import.meta.url)` does not identify the repository independently of its caller.
  The helper does. PR #13555's new nested rehearsal test hit this gate before its native repair.
  Caller-relative fixture assets remain fixture assets; this rule concerns the repository root.

Run these two physical census suites alongside a new test before its first push. Their
population checks see path conventions that a passing scoped behavioral test does not measure.
Keep existing tests within the task's declared scope; these instructions add no task companions.
