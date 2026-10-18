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
